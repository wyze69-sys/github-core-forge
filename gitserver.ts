// Git smart HTTP: the /{owner}/{repo}.git surface. Advertisements (v2 for
// upload-pack when the client asks, v0 otherwise and always for receive-pack),
// the v2 ls-refs and fetch commands, the v0 fetch fallback, and receive-pack
// pushes with per-ref report-status. Objects move as whole-object packfiles.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, RepoRec } from './store.ts';
import { isAncestor, readObject, resolveCommit } from './git.ts';
import {
  PKT_DELIM, PKT_FLUSH, ZERO_OID, collectClosure, parsePacketStream, parsePackets,
  pktLine, readPack, writePack,
} from './pack.ts';
import { readBody } from './rest.ts';

const AGENT = 'forge/1.0.0';

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
  });
  res.end(body);
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** The commit a tag object peels to, or null for a lightweight tag target. */
function peeledCommit(repo: RepoRec, sha: string): string | null {
  const obj = readObject(repo, sha);
  if (obj === null || obj.type !== 'tag') return null;
  return resolveCommit(repo, sha);
}

/** The v0 ref advertisement shared by upload-pack (v0) and receive-pack. */
function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k ofs-delta shallow symref=HEAD:${headTarget(repo)} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headSha = repo.refs.get(headTarget(repo));
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    lines.push(`${headSha ?? ZERO_OID} HEAD`);
    for (const [name, sha] of refs) {
      lines.push(`${sha} ${name}`);
      const peeled = peeledCommit(repo, sha);
      if (peeled !== null && name.startsWith('refs/tags/')) lines.push(`${peeled} ${name}^{}`);
    }
  }
  lines.forEach((line, index) => {
    parts.push(pktLine(index === 0 ? `${line}\0${caps}\n` : `${line}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack: identical for every repo and every state, so it is built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=filter shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function infoRefs(store: Store, req: IncomingMessage, res: ServerResponse, repo: RepoRec, url: URL): void {
  const service = url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', wantsV2 ? V2_ADVERTISEMENT : v0Advertisement(repo, 'git-upload-pack'));
    return;
  }
  if (service === 'git-receive-pack') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'git-receive-pack'));
    return;
  }
  sendBuffer(res, 403, 'text/plain', Buffer.from('unsupported service\n'));
}

/** One ls-refs answer: HEAD (born or unborn) plus the refs, honouring prefixes. */
function lsRefs(repo: RepoRec, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headSha = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headSha !== undefined) {
      parts.push(pktLine(`${headSha} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, sha] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${sha} ${name}`;
    if (peel) {
      const peeled = peeledCommit(repo, sha);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}


interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  commonAcks: string[];
}

/** Decide which objects a fetch sends: the wants' closure (depth-limited) minus the haves'. */
function planFetch(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchPlan {
  const wantClosure = collectClosure(repo, wants, depth);
  const held = haves.length === 0
    ? { objects: new Set<string>(), commits: new Set<string>() }
    : collectClosure(repo, haves, null, clientShallow.length > 0 ? new Set(clientShallow) : undefined);
  const sendShas = [...wantClosure.objects].filter((sha) => !held.objects.has(sha)).sort();
  const objects = sendShas
    .map((sha) => readObject(repo, sha))
    .filter((obj): obj is NonNullable<typeof obj> => obj !== null);
  const shallow = [...wantClosure.boundary].sort();
  const unshallow = clientShallow.filter((sha) => wantClosure.commits.has(sha) && !wantClosure.boundary.has(sha)).sort();
  const commonAcks = haves.filter((sha) => readObject(repo, sha)?.type === 'commit');
  return { pack: writePack(objects), shallow, unshallow, commonAcks };
}

/** Frame pack bytes as sideband-64k band-1 pkt-lines. */
function sidebandPackets(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  // Largest legal band payload: a pkt-line is at most 65520 bytes including
  // its 4-byte length prefix and the 1-byte band marker.
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(i, i + CHUNK)])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
    else if (line === 'done') args.done = true;
  }
  return args;
}

/**
 * Whole fetch-response cache. A fetch reply is a pure function of the
 * request lines and the objects they name: git objects are immutable and
 * content-addressed, so the same wants/haves/shallows always produce the
 * same bytes. A hit is served only when every named object is present in
 * this repo, which keeps the reply identical to a fresh build even if the
 * repo was deleted and recreated in between. The cache lives outside the
 * store, so it never leaks into the exported state.
 */
const fetchResponseCache = new Map<string, Buffer>();
let fetchResponseCacheBytes = 0;
const FETCH_CACHE_MAX_BYTES = 64 * 1024 * 1024;

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchResponseCache.get(key);
}

function fetchCachePut(key: string, body: Buffer): void {
  if (body.length > FETCH_CACHE_MAX_BYTES) return;
  if (fetchResponseCacheBytes + body.length > FETCH_CACHE_MAX_BYTES) {
    fetchResponseCache.clear();
    fetchResponseCacheBytes = 0;
  }
  const previous = fetchResponseCache.get(key);
  if (previous !== undefined) fetchResponseCacheBytes -= previous.length;
  fetchResponseCache.set(key, body);
  fetchResponseCacheBytes += body.length;
}

/** The v2 upload-pack POST: ls-refs and fetch commands. */
function uploadPackV2(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const packets = parsePacketStream(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const command = lines.find((l) => l.startsWith('command='))?.slice('command='.length) ?? '';
  if (command === 'ls-refs') {
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefs(repo, lines));
    return;
  }
  if (command === 'fetch') {
    const args = parseFetchArgs(lines);
    const named = [...args.wants, ...args.haves];
    const allPresent = named.every((sha) => readObject(repo, sha) !== null);
    const cacheKey = `${repo.name}\n${lines.join('\n')}`;
    if (allPresent) {
      const hit = fetchCacheGet(cacheKey);
      if (hit !== undefined) {
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', hit);
        return;
      }
    }
    const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    if (plan.commonAcks.length > 0) {
      for (const ack of plan.commonAcks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPackets(plan.pack));
    parts.push(PKT_FLUSH);
    const body = Buffer.concat(parts);
    if (allPresent) fetchCachePut(cacheKey, body);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', body);
    return;
  }
  sendBuffer(res, 400, 'text/plain', Buffer.from('unknown command\n'));
}

/** The v0 upload-pack POST: two pkt sections (wants, then haves) and a sideband reply. */
function uploadPackV0(res: ServerResponse, repo: RepoRec, body: Buffer): void {
  const first = parsePackets(body);
  const wantLines = first.packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const second = parsePackets(first.rest);
  const haveLines = second.packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  const args = parseFetchArgs([...wantLines.map((l) => l.replace(/^(want [0-9a-f]{40}) .*/, '$1')), ...haveLines]);
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const sha of plan.shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of plan.unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  if (plan.commonAcks.length > 0) parts.push(pktLine(`ACK ${plan.commonAcks[plan.commonAcks.length - 1]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

async function uploadPack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const isV2 = body.subarray(0, 64).toString('latin1').includes('command=');
  if (isV2) uploadPackV2(res, repo, body);
  else uploadPackV0(res, repo, body);
}

/** The receive-pack POST: ref-update commands, a pack, and a report-status reply. */
async function receivePack(req: IncomingMessage, res: ServerResponse, repo: RepoRec): Promise<void> {
  const body = await readBody(req);
  const { packets, rest } = parsePackets(body);
  const commandLines = packets
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  let capabilities = '';
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  commandLines.forEach((raw, index) => {
    let line = raw;
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid !== undefined && newOid !== undefined && ref !== undefined) {
      commands.push({ oldOid, newOid, ref });
    }
  });

  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const [sha, obj] of objects) {
        if (!repo.objects.has(sha)) repo.objects.set(sha, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const report: string[] = [`unpack ${unpackError === null ? 'ok' : `index-pack failed: ${unpackError}`}`];
  for (const command of commands) {
    if (unpackError !== null) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      report.push(`ng ${command.ref} reference mismatch`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
      continue;
    }
    const target = readObject(repo, command.newOid);
    if (target === null || (target.type !== 'commit' && target.type !== 'tag')) {
      report.push(`ng ${command.ref} bad object`);
      continue;
    }
    if (current !== ZERO_OID) {
      const newCommit = resolveCommit(repo, command.newOid);
      if (newCommit === null || !isAncestor(repo, current, newCommit)) {
        report.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }

  const inner = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const out = useSideband
    ? Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH])
    : inner;
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
}

/** Route one git smart-HTTP request; the path is /{owner}/{repo}.git/<sub>. */
export async function routeGit(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const match = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(url.pathname);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] ?? '');
  const name = decodeURIComponent(match[2] ?? '');
  const sub = match[3] ?? '';
  const repo = store.getRepo(owner, name);
  if (repo === null) {
    sendBuffer(res, 404, 'text/plain', Buffer.from('repository not found\n'));
    return true;
  }
  try {
    if (sub === 'info/refs' && (req.method ?? 'GET') === 'GET') {
      infoRefs(store, req, res, repo, url);
      return true;
    }
    if (sub === 'git-upload-pack' && (req.method ?? 'GET') === 'POST') {
      await uploadPack(req, res, repo);
      return true;
    }
    if (sub === 'git-receive-pack' && (req.method ?? 'GET') === 'POST') {
      await receivePack(req, res, repo);
      return true;
    }
  } catch {
    if (!res.headersSent) sendBuffer(res, 400, 'text/plain', Buffer.from('bad request\n'));
    return true;
  }
  sendBuffer(res, 404, 'text/plain', Buffer.from('not found\n'));
  return true;
}
