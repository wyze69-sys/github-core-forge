// GitHub REST v3 surface: repositories first (this file grows issues, labels, pulls
// and contents as their checks come into focus). Every reply is JSON and carries an
// X-GitHub-Request-Id header; errors are JSON with a string message, never HTML.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, nodeId, type RepoRec } from './store.ts';
import {
  blobAtPath, branchRef, buildTreeFromFiles, commitTree, emptyTreeSha, listFiles, mergeBase,
  parseCommit, parseTree, readObject, reachableCommits, removeAtPath, resolveCommit,
  setBlobAtPath, threeWayMerge, tipTree, writeObject,
} from './git.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** The deterministic, non-empty request id every API reply carries. */
export function nextRequestId(): string {
  requestSeq += 1;
  return requestSeq.toString(16).padStart(24, '0').toUpperCase();
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': nextRequestId() });
  res.end();
}

export function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' });
}

export function badRequest(res: ServerResponse, message: string): void {
  sendJson(res, 400, { message });
}

export function validationFailed(res: ServerResponse, resource: string, field: string, code: string, errorMessage?: string): void {
  sendJson(res, 422, {
    message: 'Validation Failed',
    errors: [{ resource, field, code, ...(errorMessage !== undefined ? { message: errorMessage } : {}) }],
    documentation_url: 'https://docs.github.com/rest',
  });
}

/** Read a whole request body (packfiles and contents can be sizeable) with a hard cap. */
export function readBody(req: IncomingMessage, cap = 256 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > cap) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; returns undefined after answering 400 when the body is malformed. */
export async function jsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badRequest(res, 'Invalid JSON body');
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    badRequest(res, 'Problems parsing JSON');
    return undefined;
  }
}

export function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}`;
}

/** The GitHub-shaped repository object the REST checks read. */
export function repoJson(store: Store, repo: RepoRec, origin: string): Record<string, unknown> {
  const login = store.login();
  const fullName = `${login}/${repo.name}`;
  const stamp = store.peekIso();
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    owner: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    html_url: `${origin}/${fullName}`,
    clone_url: `${origin}/${fullName}.git`,
    git_url: `git://${origin.split('://')[1]}/${fullName}.git`,
    ssh_url: `git@${origin.split('://')[1]}:${fullName}.git`,
    default_branch: repo.defaultBranch,
    created_at: stamp,
    updated_at: stamp,
    pushed_at: stamp,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function pageParams(url: URL): { perPage: number; page: number } {
  const perRaw = Number(url.searchParams.get('per_page') ?? '30');
  const pageRaw = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number.isFinite(perRaw) && perRaw > 0 ? Math.min(100, Math.floor(perRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/** Slice a list by the page params and answer with GitHub's Link header chain. */
export function sendPage<T>(
  res: ServerResponse,
  req: IncomingMessage,
  url: URL,
  items: T[],
  map: (item: T) => unknown,
): void {
  const { perPage, page } = pageParams(url);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage).map(map);
  const origin = originOf(req);
  const base = `${origin}${url.pathname}`;
  const links: string[] = [];
  const linkUrl = (p: number): string => `<${base}?per_page=${perPage}&page=${p}>`;
  if (page < totalPages) {
    links.push(`${linkUrl(page + 1)}; rel="next"`, `${linkUrl(totalPages)}; rel="last"`);
  }
  if (page > 1) {
    links.push(`${linkUrl(1)}; rel="first"`, `${linkUrl(page - 1)}; rel="prev"`);
  }
  sendJson(res, 200, slice, links.length > 0 ? { link: links.join(', ') } : {});
}


/** Route one /api/v3 request. Returns true when a reply was sent. */
export async function routeRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);

  // GET /api/v3/user — the token's owner.
  if (method === 'GET' && parts.length === 1 && parts[0] === 'user') {
    sendJson(res, 200, {
      login: store.login(),
      id: 1000,
      node_id: nodeId('User', 1000),
      type: 'User',
      site_admin: false,
      url: `${origin}/api/v3/users/${store.login()}`,
      html_url: `${origin}/${store.login()}`,
    });
    return true;
  }

  // /api/v3/user/repos — list and create the viewer's repositories.
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      sendPage(res, req, url, store.listRepos(), (repo) => repoJson(store, repo, origin));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') {
        validationFailed(res, 'Repository', 'name', 'missing_field');
        return true;
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      if (repo === null) {
        validationFailed(res, 'Repository', 'name', 'already_exists', 'name already exists on this account');
        return true;
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        repo.defaultBranch = body.default_branch;
      }
      sendJson(res, 201, repoJson(store, repo, origin));
      return true;
    }
    return false;
  }

  // /api/v3/repos/{owner}/{repo}/... — everything under one repository.
  if (parts.length >= 4 && parts[0] === 'repos') {
    return routeRepoSub(store, req, res, url, parts);
  }

  // /api/v3/repos/{owner}/{repo} — read, update, delete one repository.
  if (parts.length === 3 && parts[0] === 'repos') {
    const owner = decodeURIComponent(parts[1] ?? '');
    const name = decodeURIComponent(parts[2] ?? '');
    if (method === 'GET') {
      const repo = store.getRepo(owner, name);
      if (repo === null) {
        notFound(res);
        return true;
      }
      sendJson(res, 200, repoJson(store, repo, origin));
      return true;
    }
    if (method === 'PATCH') {
      const repo = store.getRepo(owner, name);
      if (repo === null) {
        notFound(res);
        return true;
      }
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
        if (store.repos.has(body.name)) {
          validationFailed(res, 'Repository', 'name', 'already_exists');
          return true;
        }
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        repo.defaultBranch = body.default_branch;
      }
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      sendJson(res, 200, repoJson(store, repo, origin));
      return true;
    }
    if (method === 'DELETE') {
      if (!store.deleteRepo(owner, name)) {
        notFound(res);
        return true;
      }
      sendEmpty(res, 204);
      return true;
    }
    return false;
  }

  return false;
}


/** The forge's own commit identity: the adopted login, on the logical clock. */
function forgeAuthor(store: Store): { name: string; email: string; tsSeconds: number } {
  const login = store.login();
  return { name: login, email: `${login}@example.invalid`, tsSeconds: store.tickSeconds() };
}

function commitJson(store: Store, repo: RepoRec, sha: string, origin: string): Record<string, unknown> {
  const obj = readObject(repo, sha);
  const rec = obj !== null && obj.type === 'commit' ? parseCommit(obj.data) : null;
  const login = store.login();
  const stamp = store.peekIso();
  const identParts = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+)/.exec(line);
    return {
      name: match?.[1] ?? login,
      email: match?.[2] ?? `${login}@example.invalid`,
      date: match?.[3] !== undefined ? new Date(Number(match[3]) * 1000).toISOString().replace('.000Z', 'Z') : stamp,
    };
  };
  return {
    sha,
    node_id: nodeId('Commit', repo.id * 100000 + (parseInt(sha.slice(0, 6), 16) % 100000)),
    commit: {
      author: rec !== null ? identParts(rec.author) : { name: login, email: `${login}@example.invalid`, date: stamp },
      committer: rec !== null ? identParts(rec.committer) : { name: login, email: `${login}@example.invalid`, date: stamp },
      message: rec?.message ?? '',
      tree: { sha: rec?.tree ?? '' },
      comment_count: 0,
    },
    author: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    committer: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    parents: (rec?.parents ?? []).map((p) => ({ sha: p })),
    url: `${origin}/api/v3/repos/${login}/${repo.name}/commits/${sha}`,
    html_url: `${origin}/${login}/${repo.name}/commit/${sha}`,
  };
}

/** Dispatch for /api/v3/repos/{owner}/{repo}/... — git refs, branches, commits, contents, issues, pulls. */
async function routeRepoSub(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);
  const owner = decodeURIComponent(parts[1] ?? '');
  const name = decodeURIComponent(parts[2] ?? '');
  const repo = store.getRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return true;
  }
  const sub = parts[3] ?? '';

  // POST /git/refs — create a ref (the branches check creates one this way).
  if (sub === 'git' && parts[4] === 'refs' && method === 'POST') {
    const body = await jsonBody(req, res);
    if (body === undefined) return true;
    const ref = typeof body.ref === 'string' ? body.ref : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!ref.startsWith('refs/') || resolveCommit(repo, sha) === null) {
      validationFailed(res, 'Reference', 'sha', 'invalid');
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(res, 201, { ref, node_id: nodeId('Ref', repo.id), url: `${origin}/api/v3/repos/${store.login()}/${repo.name}/git/refs/${ref}`, object: { sha, type: 'commit' } });
    return true;
  }

  // GET /branches — every head ref as a branch object.
  if (sub === 'branches' && parts.length === 4 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `${origin}/api/v3/repos/${store.login()}/${repo.name}/commits/${sha}` },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
    return true;
  }

  // GET /commits — commits reachable from ?sha (a branch name or sha; default branch).
  if (sub === 'commits' && parts.length === 4 && method === 'GET') {
    const shaParam = url.searchParams.get('sha');
    const startRef = shaParam === null || shaParam === ''
      ? branchRef(repo.defaultBranch)
      : (repo.refs.has(branchRef(shaParam)) ? branchRef(shaParam) : shaParam);
    const tip = resolveCommit(repo, startRef);
    if (tip === null) {
      sendJson(res, 200, []);
      return true;
    }
    const commits = reachableCommits(repo, tip).map((sha) => commitJson(store, repo, sha, origin));
    sendJson(res, 200, commits);
    return true;
  }

  // /contents/{path...} — read, write and delete files through the git store.
  if (sub === 'contents') {
    const filePath = parts.slice(4).map((p) => decodeURIComponent(p)).join('/');
    return routeContents(store, req, res, url, repo, filePath);
  }

  // /labels — the repository's label set; an issue may only carry labels created here.
  if (sub === 'labels' && parts.length === 4) {
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map((label, i) => labelJson(store, repo, label, i + 1, origin)));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        validationFailed(res, 'Label', 'name', 'missing_field');
        return true;
      }
      if (repo.labels.has(labelName)) {
        validationFailed(res, 'Label', 'name', 'already_exists');
        return true;
      }
      const label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(store, repo, label, repo.labels.size, origin));
      return true;
    }
    return false;
  }

  // /issues and /issues/{n}[/comments] — the issue tracker on the shared number sequence.
  if (sub === 'issues') {
    return routeIssues(store, req, res, url, repo, parts);
  }

  // /pulls, /pulls/{n}, /pulls/{n}/files, /pulls/{n}/merge — pull requests over the git store.
  if (sub === 'pulls') {
    return routePulls(store, req, res, url, repo, parts);
  }

  return false;
}

function labelJson(store: Store, repo: RepoRec, label: { name: string; color: string; description: string }, id: number, origin: string): Record<string, unknown> {
  return {
    id: repo.id * 1000 + id,
    node_id: nodeId('Label', repo.id * 1000 + id),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
    url: `${origin}/api/v3/repos/${store.login()}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

export function issueJson(store: Store, repo: RepoRec, issue: { number: number; title: string; body: string; state: string; labels: string[]; comments: { id: number }[] }, origin: string, isPull = false): Record<string, unknown> {
  const login = store.login();
  const stamp = store.peekIso();
  const base: Record<string, unknown> = {
    id: repo.id * 100000 + issue.number,
    node_id: nodeId('Issue', repo.id * 100000 + issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((labelName) => {
      const label = repo.labels.get(labelName);
      return {
        id: repo.id * 1000 + [...repo.labels.keys()].indexOf(labelName) + 1,
        node_id: nodeId('Label', repo.id * 1000),
        name: labelName,
        color: label?.color ?? 'ededed',
        description: label?.description ?? '',
        default: false,
      };
    }),
    user: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: stamp,
    updated_at: stamp,
    closed_at: issue.state === 'closed' ? stamp : null,
    url: `${origin}/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
    html_url: `${origin}/${login}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${login}/${repo.name}`,
  };
  if (isPull) {
    base.pull_request = {
      url: `${origin}/api/v3/repos/${login}/${repo.name}/pulls/${issue.number}`,
      html_url: `${origin}/${login}/${repo.name}/pull/${issue.number}`,
    };
  }
  return base;
}

async function routeIssues(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);

  // /issues — list and create.
  if (parts.length === 4) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let items = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendPage(res, req, url, items, (issue) => issueJson(store, repo, issue, origin));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      const labelNames = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const labelName of labelNames) {
        if (!repo.labels.has(labelName)) {
          validationFailed(res, 'Issue', 'labels', 'invalid');
          return true;
        }
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open' as const,
        labels: labelNames,
        seq: number,
        isPull: false,
        comments: [] as { id: number; body: string; seq: number }[],
      };
      repo.issues.set(number, issue);
      sendJson(res, 201, issueJson(store, repo, issue, origin));
      return true;
    }
    return false;
  }

  const number = Number(parts[4]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  // /issues/{n}/comments — list and create.
  if (parts.length === 6 && parts[5] === 'comments') {
    if (issue === undefined || issue.isPull) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((c) => commentJson(store, repo, issue.number, c, origin)));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      const comment = {
        id: repo.id * 1000000 + issue.number * 1000 + issue.comments.length + 1,
        body: typeof body.body === 'string' ? body.body : '',
        seq: issue.comments.length + 1,
      };
      issue.comments.push(comment);
      sendJson(res, 201, commentJson(store, repo, issue.number, comment, origin));
      return true;
    }
    return false;
  }

  // /issues/{n} — read and update one issue.
  if (parts.length === 5) {
    if (issue === undefined || issue.isPull) {
      notFound(res);
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(store, repo, issue, origin));
      return true;
    }
    if (method === 'PATCH') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (Array.isArray(body.labels)) {
        const labelNames = body.labels.filter((l): l is string => typeof l === 'string');
        for (const labelName of labelNames) {
          if (!repo.labels.has(labelName)) {
            validationFailed(res, 'Issue', 'labels', 'invalid');
            return true;
          }
        }
        issue.labels = labelNames;
      }
      sendJson(res, 200, issueJson(store, repo, issue, origin));
      return true;
    }
    return false;
  }

  return false;
}

function commentJson(store: Store, repo: RepoRec, issueNumber: number, comment: { id: number; body: string }, origin: string): Record<string, unknown> {
  const login = store.login();
  const stamp = store.peekIso();
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    body: comment.body,
    user: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    created_at: stamp,
    updated_at: stamp,
    url: `${origin}/api/v3/repos/${login}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${origin}/${login}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${origin}/api/v3/repos/${login}/${repo.name}/issues/${issueNumber}`,
  };
}

/** The contents API: files are blobs in the branch's tree; writes are commits. */
async function routeContents(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  filePath: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);
  const login = store.login();

  if (method === 'GET') {
    const refParam = url.searchParams.get('ref') ?? repo.defaultBranch;
    const treeSha = tipTree(repo, branchRef(refParam)) ?? tipTree(repo, refParam);
    if (treeSha === null) {
      notFound(res);
      return true;
    }
    if (filePath === '') {
      return sendContentsDir(store, res, repo, treeSha, '', origin);
    }
    const blobSha = blobAtPath(repo, treeSha, filePath);
    if (blobSha !== null) {
      const obj = readObject(repo, blobSha);
      const data = obj?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        content: data.toString('base64'),
        sha: blobSha,
        url: `${origin}/api/v3/repos/${login}/${repo.name}/contents/${filePath}`,
        html_url: `${origin}/${login}/${repo.name}/blob/${refParam}/${filePath}`,
        download_url: `${origin}/${login}/${repo.name}/raw/${refParam}/${filePath}`,
      });
      return true;
    }
    // A directory path lists its entries.
    const dirTree = dirTreeAtPath(repo, treeSha, filePath);
    if (dirTree !== null) return sendContentsDir(store, res, repo, dirTree, filePath, origin);
    notFound(res);
    return true;
  }

  if (method === 'PUT') {
    const body = await jsonBody(req, res);
    if (body === undefined) return true;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' ? body.message : `Update ${filePath}`;
    const contentB64 = typeof body.content === 'string' ? body.content : '';
    const givenSha = typeof body.sha === 'string' ? body.sha : null;
    ensureBranch(store, repo, branch);
    const treeSha = tipTree(repo, branchRef(branch)) ?? emptyTreeSha(repo);
    const existing = blobAtPath(repo, treeSha, filePath);
    if (existing !== null && givenSha !== existing) {
      sendJson(res, 409, { message: `Conflict: the file's sha does not match`, documentation_url: 'https://docs.github.com/rest' });
      return true;
    }
    const blobSha = writeObject(repo, 'blob', Buffer.from(contentB64, 'base64'));
    const newTree = setBlobAtPath(repo, treeSha, filePath, blobSha);
    const commitSha = commitTree(repo, branch, newTree, message, forgeAuthor(store));
    const stamp = store.peekIso();
    sendJson(res, existing !== null ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: Buffer.from(contentB64, 'base64').length,
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: blobSha,
        url: `${origin}/api/v3/repos/${login}/${repo.name}/contents/${filePath}`,
        html_url: `${origin}/${login}/${repo.name}/blob/${branch}/${filePath}`,
        git_url: `${origin}/api/v3/repos/${login}/${repo.name}/git/blobs/${blobSha}`,
        download_url: `${origin}/${login}/${repo.name}/raw/${branch}/${filePath}`,
        _links: {
          self: `${origin}/api/v3/repos/${login}/${repo.name}/contents/${filePath}`,
          git: `${origin}/api/v3/repos/${login}/${repo.name}/git/blobs/${blobSha}`,
          html: `${origin}/${login}/${repo.name}/blob/${branch}/${filePath}`,
        },
      },
      commit: {
        sha: commitSha,
        node_id: nodeId('Commit', repo.id),
        author: { name: login, email: `${login}@example.invalid`, date: stamp },
        committer: { name: login, email: `${login}@example.invalid`, date: stamp },
        message,
        tree: { sha: newTree },
        url: `${origin}/api/v3/repos/${login}/${repo.name}/git/commits/${commitSha}`,
        html_url: `${origin}/${login}/${repo.name}/commit/${commitSha}`,
        parents: [],
      },
    });
    return true;
  }

  if (method === 'DELETE') {
    const body = await jsonBody(req, res);
    if (body === undefined) return true;
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const message = typeof body.message === 'string' ? body.message : `Delete ${filePath}`;
    const treeSha = tipTree(repo, branchRef(branch));
    if (treeSha === null || blobAtPath(repo, treeSha, filePath) === null) {
      notFound(res);
      return true;
    }
    const newTree = removeAtPath(repo, treeSha, filePath);
    if (newTree === null) {
      notFound(res);
      return true;
    }
    const commitSha = commitTree(repo, branch, newTree, message, forgeAuthor(store));
    const stamp = store.peekIso();
    sendJson(res, 200, {
      content: null,
      commit: {
        sha: commitSha,
        node_id: nodeId('Commit', repo.id),
        author: { name: login, email: `${login}@example.invalid`, date: stamp },
        committer: { name: login, email: `${login}@example.invalid`, date: stamp },
        message,
        tree: { sha: newTree },
        url: `${origin}/api/v3/repos/${login}/${repo.name}/git/commits/${commitSha}`,
        html_url: `${origin}/${login}/${repo.name}/commit/${commitSha}`,
        parents: [],
      },
    });
    return true;
  }

  return false;
}

/** The tree sha of a directory inside a tree, or null. */
function dirTreeAtPath(repo: RepoRec, treeSha: string, path: string): string | null {
  let current = treeSha;
  for (const part of path.split('/')) {
    const obj = readObject(repo, current);
    if (obj === null || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part && e.mode === '40000');
    if (entry === undefined) return null;
    current = entry.sha;
  }
  return current;
}

function sendContentsDir(store: Store, res: ServerResponse, repo: RepoRec, treeSha: string, prefix: string, origin: string): boolean {
  const obj = readObject(repo, treeSha);
  if (obj === null || obj.type !== 'tree') {
    notFound(res);
    return true;
  }
  const login = store.login();
  const entries = parseTree(obj.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? null : readObject(repo, entry.sha);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      sha: entry.sha,
      url: `${origin}/api/v3/repos/${login}/${repo.name}/contents/${prefix === '' ? entry.name : `${prefix}/${entry.name}`}`,
    };
  });
  sendJson(res, 200, entries);
  return true;
}

/** Make sure a branch exists: an unborn default branch stays unborn until a commit lands;
 *  any other missing branch starts at the default branch's tip when there is one. */
function ensureBranch(store: Store, repo: RepoRec, branch: string): void {
  const ref = branchRef(branch);
  if (repo.refs.has(ref)) return;
  if (branch === repo.defaultBranch) return;
  const baseTip = repo.refs.get(branchRef(repo.defaultBranch));
  if (baseTip !== undefined) repo.refs.set(ref, baseTip);
}


interface PullShape {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeSha: string | null;
  headRef: string;
  baseRef: string;
}

export function pullJson(store: Store, repo: RepoRec, pull: PullShape, origin: string): Record<string, unknown> {
  const login = store.login();
  const stamp = store.peekIso();
  const headSha = repo.refs.get(branchRef(pull.headRef)) ?? '';
  const baseSha = repo.refs.get(branchRef(pull.baseRef)) ?? '';
  const side = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${login}:${ref}`,
    ref,
    sha,
    user: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    repo: repoJson(store, repo, origin),
  });
  return {
    id: repo.id * 100000 + pull.number,
    node_id: nodeId('PullRequest', repo.id * 100000 + pull.number),
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: { login, id: 1000, node_id: nodeId('User', 1000), type: 'User' },
    labels: [],
    created_at: stamp,
    updated_at: stamp,
    closed_at: pull.state === 'closed' ? stamp : null,
    merged_at: pull.merged ? stamp : null,
    merge_commit_sha: pull.mergeSha,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    url: `${origin}/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
    html_url: `${origin}/${login}/${repo.name}/pull/${pull.number}`,
    diff_url: `${origin}/${login}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${login}/${repo.name}/pull/${pull.number}.patch`,
    commits_url: `${origin}/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}/commits`,
    comments_url: `${origin}/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}/comments`,
    statuses_url: `${origin}/api/v3/repos/${login}/${repo.name}/statuses/${headSha}`,
    draft: false,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

/** Count added/deleted lines between two texts with a small LCS diff (check files are small). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  if (a.length > 4000 || b.length > 4000) {
    return { additions: b.length, deletions: a.length };
  }
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j]
        ? (dp[(i + 1) * (n + 1) + j + 1] ?? 0) + 1
        : Math.max(dp[(i + 1) * (n + 1) + j] ?? 0, dp[i * (n + 1) + j + 1] ?? 0);
    }
  }
  const lcs = dp[0] ?? 0;
  return { additions: n - lcs, deletions: m - lcs };
}

async function routePulls(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoRec,
  parts: string[],
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const origin = originOf(req);

  // /pulls — list and create.
  if (parts.length === 4) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((p) => p.state === 'open');
      else if (state === 'closed') items = items.filter((p) => p.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      sendPage(res, req, url, items, (pull) => pullJson(store, repo, pull, origin));
      return true;
    }
    if (method === 'POST') {
      const body = await jsonBody(req, res);
      if (body === undefined) return true;
      const headRaw = typeof body.head === 'string' ? body.head : '';
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const baseRef = typeof body.base === 'string' && body.base !== '' ? body.base : repo.defaultBranch;
      const headSha = repo.refs.get(branchRef(headRef));
      const baseSha = repo.refs.get(branchRef(baseRef));
      if (headSha === undefined || baseSha === undefined || headRef === baseRef) {
        validationFailed(res, 'PullRequest', 'head', 'invalid');
        return true;
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open' as const,
        merged: false,
        mergeSha: null as string | null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        seq: number,
      };
      repo.pulls.set(number, pull);
      repo.issues.set(number, {
        number,
        title: pull.title,
        body: pull.body,
        state: 'open',
        labels: [],
        seq: number,
        isPull: true,
        comments: [],
      });
      sendJson(res, 201, pullJson(store, repo, pull, origin));
      return true;
    }
    return false;
  }

  const number = Number(parts[4]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) {
    notFound(res);
    return true;
  }

  // /pulls/{n} — read one.
  if (parts.length === 5 && method === 'GET') {
    sendJson(res, 200, pullJson(store, repo, pull, origin));
    return true;
  }

  // /pulls/{n}/files — the file-level diff between the base and head trees.
  if (parts.length === 6 && parts[5] === 'files' && method === 'GET') {
    const login = store.login();
    const baseTree = tipTree(repo, branchRef(pull.baseRef));
    const headTree = tipTree(repo, branchRef(pull.headRef));
    const baseFiles = baseTree === null ? new Map() : listFiles(repo, baseTree);
    const headFiles = headTree === null ? new Map() : listFiles(repo, headTree);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const files: Record<string, unknown>[] = [];
    for (const path of [...paths].sort()) {
      const b = baseFiles.get(path);
      const h = headFiles.get(path);
      if (b?.sha === h?.sha) continue;
      const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
      const oldText = b === undefined ? '' : (readObject(repo, b.sha)?.data.toString('utf8') ?? '');
      const newText = h === undefined ? '' : (readObject(repo, h.sha)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(oldText, newText);
      files.push({
        sha: h?.sha ?? b?.sha ?? '',
        filename: path,
        status,
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
        blob_url: `${origin}/api/v3/repos/${login}/${repo.name}/git/blobs/${h?.sha ?? b?.sha ?? ''}`,
        raw_url: `${origin}/${login}/${repo.name}/raw/${pull.headRef}/${path}`,
        contents_url: `${origin}/api/v3/repos/${login}/${repo.name}/contents/${path}?ref=${pull.headRef}`,
      });
    }
    sendJson(res, 200, files);
    return true;
  }

  // /pulls/{n}/merge — squash the head branch onto the base branch as one commit.
  if (parts.length === 6 && parts[5] === 'merge' && method === 'PUT') {
    const body = await jsonBody(req, res);
    if (body === undefined) return true;
    const outcome = performSquashMerge(store, repo, pull);
    if (outcome.status === 'merged') {
      sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    if (outcome.status === 'not-open') {
      sendJson(res, 405, { message: 'Pull Request is not open', documentation_url: 'https://docs.github.com/rest' });
      return true;
    }
    sendJson(res, 405, { message: 'Pull Request is not mergeable: merge conflict', documentation_url: 'https://docs.github.com/rest' });
    return true;
  }

  return false;
}

export type MergeOutcome =
  | { status: 'merged'; sha: string }
  | { status: 'not-open' }
  | { status: 'conflict' };

/** Squash-merge a pull request onto its base branch; shared by REST and MCP. */
export function performSquashMerge(store: Store, repo: RepoRec, pull: PullShape & { state: 'open' | 'closed'; merged: boolean; mergeSha: string | null }): MergeOutcome {
  if (pull.state !== 'open') return { status: 'not-open' };
  const headTip = repo.refs.get(branchRef(pull.headRef));
  const baseTip = repo.refs.get(branchRef(pull.baseRef));
  if (headTip === undefined || baseTip === undefined) return { status: 'conflict' };
  const base = mergeBase(repo, baseTip, headTip);
  const baseFiles = base === null ? new Map() : listFiles(repo, tipTree(repo, base) ?? '');
  const headFiles = listFiles(repo, tipTree(repo, headTip) ?? '');
  const targetFiles = listFiles(repo, tipTree(repo, baseTip) ?? '');
  const merged = threeWayMerge(baseFiles, headFiles, targetFiles);
  if (merged.conflicts.length > 0) return { status: 'conflict' };
  const mergedTree = buildTreeFromFiles(repo, merged.files);
  const message = `${pull.title} (#${pull.number})${pull.body !== '' ? `\n\n${pull.body}` : ''}`;
  const mergeSha = commitTree(repo, pull.baseRef, mergedTree, message, forgeAuthor(store));
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeSha = mergeSha;
  const shadow = repo.issues.get(pull.number);
  if (shadow !== undefined) shadow.state = 'closed';
  return { status: 'merged', sha: mergeSha };
}
