// The git object model: content-addressed blobs, trees and commits over node:crypto,
// plus the tree surgery the contents API and merges need. Objects live in the repo's
// Map in store.ts; this file is the pure machinery over them.

import { createHash } from 'node:crypto';
import type { GitObject, RepoRec } from './store.ts';

export type ObjectType = GitObject['type'];

/** The git object id: sha1 of "<type> <len>\0" followed by the payload. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  // Two updates hash the same byte stream as header||data without copying it.
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function writeObject(repo: RepoRec, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) repo.objects.set(sha, { type, data });
  return sha;
}

export function readObject(repo: RepoRec, sha: string): GitObject | null {
  return repo.objects.get(sha) ?? null;
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Parse a tree payload: repeated "<mode> <name>\0<20-byte sha>". */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(i, space).toString('utf8');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's canonical order (names sorted, dirs as "name/"). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export function writeTree(repo: RepoRec, entries: TreeEntry[]): string {
  return writeObject(repo, 'tree', buildTree(entries));
}

/** The empty tree every git implementation knows. */
export function emptyTreeSha(repo: RepoRec): string {
  return writeObject(repo, 'tree', Buffer.alloc(0));
}

export interface CommitRec {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(rec: CommitRec): Buffer {
  const lines = [`tree ${rec.tree}`];
  for (const parent of rec.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${rec.author}`, `committer ${rec.committer}`, '', rec.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function writeCommit(repo: RepoRec, rec: CommitRec): string {
  return writeObject(repo, 'commit', buildCommit(rec));
}

/** One "Name <email> ts +0000" ident line from a logical-clock second count. */
export function ident(name: string, email: string, tsSeconds: number): string {
  return `${name} <${email}> ${tsSeconds} +0000`;
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export function tagRef(tag: string): string {
  return `refs/tags/${tag}`;
}

/** Resolve a ref name or sha to a commit sha, peeling tags; null when unknown. */
export function resolveCommit(repo: RepoRec, refOrSha: string): string | null {
  let sha = repo.refs.get(refOrSha) ?? refOrSha;
  for (let depth = 0; depth < 8; depth += 1) {
    const obj = readObject(repo, sha);
    if (obj === null) return null;
    if (obj.type === 'commit') return sha;
    if (obj.type === 'tag') {
      const match = /object ([0-9a-f]{40})/.exec(obj.data.toString('utf8'));
      if (match === null || match[1] === undefined) return null;
      sha = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** The tree sha at the tip of a branch (or of any commit-ish), null when unborn. */
export function tipTree(repo: RepoRec, refOrSha: string): string | null {
  const commitSha = resolveCommit(repo, refOrSha);
  if (commitSha === null) return null;
  const obj = readObject(repo, commitSha);
  if (obj === null || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Walk a tree recursively into "path -> {sha, mode}" for files (blobs) only. */
export function listFiles(repo: RepoRec, treeSha: string, prefix = '', out = new Map<string, { sha: string; mode: string }>()): Map<string, { sha: string; mode: string }> {
  const obj = readObject(repo, treeSha);
  if (obj === null || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') listFiles(repo, entry.sha, path, out);
    else out.set(path, { sha: entry.sha, mode: entry.mode });
  }
  return out;
}

/** The blob sha at a path inside a tree, or null. */
export function blobAtPath(repo: RepoRec, treeSha: string, path: string): string | null {
  const parts = path.split('/');
  let current = treeSha;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = readObject(repo, current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) return entry.mode === '40000' ? null : entry.sha;
    if (entry.mode !== '40000') return null;
    current = entry.sha;
  }
  return null;
}


/**
 * Return a new tree sha with `path` pointing at blob `blobSha` (mode 100644),
 * creating intermediate trees as needed. The input tree is never mutated.
 */
export function setBlobAtPath(repo: RepoRec, treeSha: string | null, path: string, blobSha: string): string {
  const parts = path.split('/');
  const entries: TreeEntry[] = treeSha === null ? [] : parseTree(readObject(repo, treeSha)?.data ?? Buffer.alloc(0));
  const head = parts[0] as string;
  const rest = parts.slice(1);
  const existing = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    const entry: TreeEntry = { mode: '100644', name: head, sha: blobSha };
    if (existing === -1) entries.push(entry);
    else entries[existing] = entry;
    return writeTree(repo, entries);
  }
  let childTree: string | null = null;
  if (existing !== -1 && entries[existing]?.mode === '40000') childTree = entries[existing]?.sha ?? null;
  const newChild = setBlobAtPath(repo, childTree, rest.join('/'), blobSha);
  const entry: TreeEntry = { mode: '40000', name: head, sha: newChild };
  if (existing === -1) entries.push(entry);
  else entries[existing] = entry;
  return writeTree(repo, entries);
}

/** Return a new tree sha with `path` removed; null when the path did not exist. */
export function removeAtPath(repo: RepoRec, treeSha: string, path: string): string | null {
  const parts = path.split('/');
  const obj = readObject(repo, treeSha);
  if (obj === null || obj.type !== 'tree') return null;
  const entries = parseTree(obj.data);
  const head = parts[0] as string;
  const idx = entries.findIndex((e) => e.name === head);
  if (idx === -1) return null;
  if (parts.length === 1) {
    entries.splice(idx, 1);
    return writeTree(repo, entries);
  }
  const child = entries[idx];
  if (child === undefined || child.mode !== '40000') return null;
  const newChild = removeAtPath(repo, child.sha, parts.slice(1).join('/'));
  if (newChild === null) return null;
  const childObj = readObject(repo, newChild);
  if (childObj !== null && parseTree(childObj.data).length === 0) entries.splice(idx, 1);
  else entries[idx] = { mode: '40000', name: head, sha: newChild };
  return writeTree(repo, entries);
}

/**
 * Commit a prepared tree on a branch: parents are the branch's current tip (if any),
 * the ref advances, and the new commit sha is returned.
 */
export function commitTree(
  repo: RepoRec,
  branch: string,
  treeSha: string,
  message: string,
  who: { name: string; email: string; tsSeconds: number },
  extraParents: string[] = [],
): string {
  const ref = branchRef(branch);
  const tip = repo.refs.get(ref);
  const parents = [...(tip === undefined ? [] : [tip]), ...extraParents];
  const id = ident(who.name, who.email, who.tsSeconds);
  const sha = writeCommit(repo, { tree: treeSha, parents, author: id, committer: id, message });
  repo.refs.set(ref, sha);
  return sha;
}

/** All commits reachable from a tip, newest first (topological by walk order). */
export function reachableCommits(repo: RepoRec, tipSha: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [tipSha];
  while (stack.length > 0) {
    const sha = stack.pop() as string;
    if (seen.has(sha)) continue;
    const obj = readObject(repo, sha);
    if (obj === null || obj.type !== 'commit') continue;
    seen.add(sha);
    order.push(sha);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return order;
}

/** True when `ancestor` is reachable from `descendant` (fast-forward test). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  return reachableCommits(repo, descendant).includes(ancestor);
}


/** Build a tree (recursively) from a flat "path -> blob sha" map; returns its sha. */
export function buildTreeFromFiles(repo: RepoRec, files: Map<string, { sha: string; mode: string }>): string {
  interface Node {
    files: { name: string; sha: string; mode: string }[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, info] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: [], dirs: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.push({ name: parts[parts.length - 1] as string, sha: info.sha, mode: info.mode });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = node.files.map((f) => ({ mode: f.mode, name: f.name, sha: f.sha }));
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: emit(child) });
    return writeTree(repo, entries);
  };
  return emit(root);
}

/** Generation number (longest path to a root) of every commit reachable from a tip. */
function generations(repo: RepoRec, tipSha: string): Map<string, number> {
  const gens = new Map<string, number>();
  const order = reachableCommits(repo, tipSha);
  // reachableCommits is a DFS walk; process in reverse so children settle before parents
  // is wrong for longest-path, so iterate to a fixpoint over the (small) commit sets here.
  for (const sha of order) gens.set(sha, 0);
  let changed = true;
  while (changed) {
    changed = false;
    for (const sha of order) {
      const obj = readObject(repo, sha);
      if (obj === null || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        const want = (gens.get(sha) ?? 0) + 1;
        if ((gens.get(parent) ?? 0) < want) {
          gens.set(parent, want);
          changed = true;
        }
      }
    }
  }
  return gens;
}

/** The best common ancestor of two tips (the one with the highest generation), or null. */
export function mergeBase(repo: RepoRec, aSha: string, bSha: string): string | null {
  const gensA = generations(repo, aSha);
  const gensB = generations(repo, bSha);
  let best: string | null = null;
  let bestGen = -1;
  for (const [sha, gen] of gensA) {
    if (gensB.has(sha) && gen > bestGen) {
      best = sha;
      bestGen = gen;
    }
  }
  return best;
}

export interface ThreeWayResult {
  files: Map<string, { sha: string; mode: string }>;
  conflicts: string[];
}

/**
 * File-level three-way merge: for each path, if only one side moved away from the
 * base version, take that side; if both moved to the same place, take it; if both
 * moved differently, the path conflicts.
 */
export function threeWayMerge(
  baseFiles: Map<string, { sha: string; mode: string }>,
  headFiles: Map<string, { sha: string; mode: string }>,
  targetFiles: Map<string, { sha: string; mode: string }>,
): ThreeWayResult {
  const files = new Map<string, { sha: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...targetFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const t = targetFiles.get(path);
    const same = (x?: { sha: string }, y?: { sha: string }): boolean => x?.sha === y?.sha;
    if (same(h, t)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, h)) {
      if (t !== undefined) files.set(path, t);
    } else if (same(b, t)) {
      if (h !== undefined) files.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  return { files, conflicts };
}
