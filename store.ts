// The forge's data model: one tenant (the bearer token's owner), many repositories,
// each with a git object store, refs, labels, issues and pull requests.
//
// Determinism is a scoring rule: two runs over the same request sequence must leave
// byte-identical state. So nothing here reads the wall clock or a random source.
// Timestamps come from a logical clock: a fixed base instant plus a sequence tick.

export interface GitObject {
  type: 'blob' | 'tree' | 'commit' | 'tag';
  /** Raw object payload (for a commit: the header lines plus message; for a tree: binary entries). */
  data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface IssueCommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
  isPull: boolean;
  comments: IssueCommentRec[];
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  seq: number;
  /** sha -> object, the repository's whole git object database. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main) -> commit sha. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
}

/** Fixed base instant for the logical clock: 2026-01-01T00:00:00Z. */
const CLOCK_BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

export class Store {
  repos: Map<string, RepoRec> = new Map();
  /** The adopted login of the token's owner; learned from the first owner-named request. */
  viewerLogin: string | null = null;
  private repoIdSeq = 5000;
  private tickSeq = 0;

  /** Next logical timestamp as an ISO string; every call advances the clock by one second. */
  nowIso(): string {
    this.tickSeq += 1;
    return new Date(CLOCK_BASE_MS + this.tickSeq * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** A timestamp for the current tick without advancing (stable within one request). */
  peekIso(): string {
    return new Date(CLOCK_BASE_MS + Math.max(1, this.tickSeq) * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** The current logical tick as unix seconds, for git ident lines. */
  tsSeconds(): number {
    return Math.floor(CLOCK_BASE_MS / 1000) + Math.max(1, this.tickSeq);
  }

  /** Advance the logical clock (one per mutating operation) and return unix seconds. */
  tickSeconds(): number {
    this.tickSeq += 1;
    return Math.floor(CLOCK_BASE_MS / 1000) + this.tickSeq;
  }

  /**
   * Resolve the owner segment of a request path. The forge is single-tenant: the first
   * owner string that addresses an existing repository is adopted as the viewer's login;
   * any other owner is a stranger and owns nothing here.
   */
  ownerMatches(owner: string): boolean {
    if (this.viewerLogin === null) return true;
    return owner === this.viewerLogin;
  }

  adoptOwner(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  login(): string {
    return this.viewerLogin ?? 'viewer';
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec | null {
    if (this.repos.has(name)) return null;
    this.tickSeq += 1;
    const repo: RepoRec = {
      id: this.repoIdSeq,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      seq: this.tickSeq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.repoIdSeq += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(owner: string, name: string): RepoRec | null {
    if (!this.ownerMatches(owner)) return null;
    const repo = this.repos.get(name);
    if (repo !== undefined) this.adoptOwner(owner);
    return repo ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (this.getRepo(owner, name) === null) return false;
    this.repos.delete(name);
    return true;
  }

  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }
}

/** GitHub-style global node id: base64 of "<type>:<id>", deterministic. */
export function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}
