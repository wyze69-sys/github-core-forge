// Packfile and pkt-line machinery for git smart HTTP: the framing every git
// message travels in, pack writing (whole objects only — deltas are optional for
// a sender), pack reading (with ofs/ref delta resolution, since a client may push
// delta-compressed objects), and the object-closure walks fetch answers from.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, RepoRec } from './store.ts';
import { hashObject, parseCommit, readObject } from './git.ts';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of a buffer; `rest` is whatever follows the last full packet. */
export function parsePackets(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
      continue;
    }
    if (length < 4 || i + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + length) });
    i += length;
    // A flush ends the caller's section; callers that need more use parsePackets again on rest.
    if (packets.length > 0 && packets[packets.length - 1]?.kind === 'flush') break;
  }
  return { packets, rest: buf.subarray(i) };
}

/** Parse a whole pkt-line stream (no trailing binary) into packets. */
export function parsePacketStream(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line header');
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      i += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      i += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      i += 4;
    } else {
      if (length < 4 || i + length > buf.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + length) });
      i += length;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- pack write

function packObjectHeader(type: GitObject['type'], size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Deflated bytes per store object, cached by object identity: store objects
 * are immutable once written, so the same instance always deflates to the
 * same bytes. Repeated fetches of the same objects (the clone workload)
 * skip the zlib work entirely after the first build.
 */
const deflateCache = new WeakMap<GitObject, Buffer>();

function deflateObject(obj: GitObject): Buffer {
  let out = deflateCache.get(obj);
  if (out === undefined) {
    // Level 1 (fastest) deflate: on the loopback links this forge serves,
    // CPU time costs far more than the slightly larger output.
    out = deflateSync(obj.data, { level: 1 });
    deflateCache.set(obj, out);
  }
  return out;
}

/** Serialize objects into a packfile: header, deflated whole objects, sha1 trailer. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateObject(obj));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pack read

function readVarintSize(buf: Buffer, start: number): { size: number; typeCode: number; next: number } {
  let byte = buf[start] as number;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buf[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode, next: offset };
}

function readOfsDeltaBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Parse a packfile into the objects it carries, resolving deltas against the pack
 * itself and (for thin packs) an external resolver. Returns sha -> object.
 */
export function readPack(pack: Buffer, resolveExternal?: (sha: string) => GitObject | null): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, string>();
  const pending: { offset: number; kind: 'ofs' | 'ref'; baseOffset?: number; baseSha?: string; delta: Buffer }[] = [];
  const objects = new Map<string, GitObject>();
  let offset = 12;
  const store = (objOffset: number, type: GitObject['type'], data: Buffer): void => {
    const sha = hashObject(type, data);
    objects.set(sha, { type, data });
    byOffset.set(objOffset, sha);
  };
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    if (header.typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryOffset, kind: 'ofs', baseOffset: entryOffset - base.baseOffset, delta: inflated.data });
    } else if (header.typeCode === 7) {
      const baseSha = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ offset: entryOffset, kind: 'ref', baseSha, delta: inflated.data });
    } else {
      const type = CODE_TYPE[header.typeCode];
      if (type === undefined) throw new Error(`bad pack type ${header.typeCode}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      store(entryOffset, type, inflated.data);
    }
  }
  // Resolve deltas, possibly in chains.
  let guard = pending.length * 2 + 4;
  while (pending.length > 0 && guard > 0) {
    guard -= 1;
    const item = pending[0] as (typeof pending)[0];
    const baseSha = item.kind === 'ofs' ? byOffset.get(item.baseOffset as number) : item.baseSha;
    const baseObj = baseSha !== undefined ? (objects.get(baseSha) ?? resolveExternal?.(baseSha) ?? null) : null;
    if (baseObj === null || baseSha === undefined) {
      pending.push(pending.shift() as (typeof pending)[0]);
      continue;
    }
    pending.shift();
    const data = applyDelta(baseObj.data, item.delta);
    store(item.offset, baseObj.type, data);
  }
  if (pending.length > 0) throw new Error('unresolved pack deltas');
  return objects;
}


// ---------------------------------------------------------------- closures

/** Add a tree and everything under it (subtrees and blobs) to the set. */
export function addTreeClosure(repo: RepoRec, treeSha: string, into: Set<string>): void {
  if (into.has(treeSha)) return;
  const obj = readObject(repo, treeSha);
  if (obj === null || obj.type !== 'tree') return;
  into.add(treeSha);
  let i = 0;
  const data = obj.data;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(i, space).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    if (mode === '40000') addTreeClosure(repo, sha, into);
    else into.add(sha);
    i = nul + 21;
  }
}

export interface Closure {
  objects: Set<string>;
  commits: Set<string>;
  /** Included commits with at least one parent left outside the walk. */
  boundary: Set<string>;
}

/**
 * Walk from root objects (commits, or tags pointing at commits) collecting every
 * reachable object. `maxDepth` bounds commit generations (1 = the tips alone);
 * `stopAt` commits are included with their trees but their parents are not walked
 * (what a shallow client already holds at its boundary).
 */
export function collectClosure(
  repo: RepoRec,
  roots: string[],
  maxDepth: number | null,
  stopAt?: Set<string>,
): Closure {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const bestGen = new Map<string, number>();
  const queue: { sha: string; gen: number }[] = [];

  const enqueueCommit = (sha: string, gen: number): void => {
    const known = bestGen.get(sha);
    if (known !== undefined && known <= gen) return;
    bestGen.set(sha, gen);
    queue.push({ sha, gen });
  };

  for (const root of roots) {
    let sha = root;
    // Peel tags at the root without spending a generation.
    for (let depth = 0; depth < 8; depth += 1) {
      const obj = readObject(repo, sha);
      if (obj === null) break;
      if (obj.type === 'tag') {
        objects.add(sha);
        const match = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
        if (match === null || match[1] === undefined) break;
        sha = match[1];
        continue;
      }
      if (obj.type === 'commit') enqueueCommit(sha, 0);
      else objects.add(sha);
      break;
    }
  }

  while (queue.length > 0) {
    const { sha, gen } = queue.shift() as { sha: string; gen: number };
    if (bestGen.get(sha) !== gen && commits.has(sha)) continue;
    const obj = readObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    const firstVisit = !commits.has(sha);
    commits.add(sha);
    objects.add(sha);
    const commit = parseCommit(obj.data);
    addTreeClosure(repo, commit.tree, objects);
    const stopped = stopAt?.has(sha) ?? false;
    for (const parent of commit.parents) {
      if (stopped) {
        boundary.add(sha);
        continue;
      }
      if (maxDepth !== null && gen + 1 >= maxDepth) {
        boundary.add(sha);
        continue;
      }
      if (firstVisit || (bestGen.get(parent) ?? Infinity) > gen + 1) enqueueCommit(parent, gen + 1);
    }
  }
  return { objects, commits, boundary };
}
