// The MCP endpoint: JSON-RPC 2.0 over streamable HTTP at /mcp. Both protocol eras
// are served: the modern server/discover (2026-07-28) and the legacy initialize
// handshake (2025-11-25 and earlier). The six tools act on the same store as REST,
// so an object created here reads back over /api/v3 unchanged.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, type RepoRec } from './store.ts';
import { issueJson, performSquashMerge, pullJson, readBody, repoJson } from './rest.ts';
import { branchRef } from './git.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: true, required } };
}

const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository owned by the authenticated user.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository, optionally filtered by state.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'open, closed or all (default open).' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Open a pull request from a head branch onto a base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request into its base branch.', {
    owner: { type: 'string', description: 'The repository owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'number', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

/** The tools/list answer is a constant: two calls must be byte for byte identical. */
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

interface RpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function sendRpc(res: ServerResponse, status: number, payload: unknown): void {
  const text = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** A tool outcome as a CallToolResult: the object in text JSON and in structuredContent. */
function toolOk(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function toolErr(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function strArg(args: Record<string, unknown>, ...names: string[]): string {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

function repoArg(store: Store, args: Record<string, unknown>): RepoRec | null {
  const fullName = strArg(args, 'full_name', 'fullName');
  let owner = strArg(args, 'owner');
  let repoName = strArg(args, 'repo', 'repository', 'name');
  if (fullName.includes('/')) {
    const [o, r] = fullName.split('/', 2);
    if (owner === '') owner = o ?? '';
    if (repoName === '' || args.repo === undefined) repoName = r ?? repoName;
  }
  if (repoName === '') return null;
  return store.getRepo(owner === '' ? store.login() : owner, repoName);
}


function callTool(store: Store, origin: string, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const key = name.toLowerCase();
  const bare = key.includes('__') ? (key.split('__').pop() as string) : key;
  switch (bare) {
    case 'create_repo': {
      const repoName = strArg(args, 'name', 'repo', 'repository');
      if (repoName === '') return null;
      const repo = store.createRepo(repoName, strArg(args, 'description'), args.private === true);
      if (repo === null) return toolErr(`Repository ${repoName} already exists`);
      return toolOk(repoJson(store, repo, origin));
    }
    case 'get_repo': {
      const repo = repoArg(store, args);
      if (repo === null) return toolErr('Repository not found');
      return toolOk(repoJson(store, repo, origin));
    }
    case 'create_issue': {
      const repo = repoArg(store, args);
      const title = strArg(args, 'title');
      if (repo === null) return toolErr('Repository not found');
      if (title === '') return null;
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        number,
        title,
        body: strArg(args, 'body'),
        state: 'open' as const,
        labels: [] as string[],
        seq: number,
        isPull: false,
        comments: [] as { id: number; body: string; seq: number }[],
      };
      repo.issues.set(number, issue);
      return toolOk(issueJson(store, repo, issue, origin));
    }
    case 'list_issues': {
      const repo = repoArg(store, args);
      if (repo === null) return toolErr('Repository not found');
      const state = strArg(args, 'state') || 'open';
      let items = [...repo.issues.values()].filter((i) => !i.isPull);
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      return toolOk(items.map((issue) => issueJson(store, repo, issue, origin)));
    }
    case 'create_pull_request': {
      const repo = repoArg(store, args);
      const title = strArg(args, 'title');
      const headRaw = strArg(args, 'head');
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const baseRef = strArg(args, 'base') || repo?.defaultBranch || 'main';
      if (repo === null) return toolErr('Repository not found');
      if (title === '' || headRef === '') return null;
      const headSha = repo.refs.get(branchRef(headRef));
      const baseSha = repo.refs.get(branchRef(baseRef));
      if (headSha === undefined || baseSha === undefined || headRef === baseRef) {
        return toolErr('Invalid head or base branch');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull = {
        number,
        title,
        body: strArg(args, 'body'),
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
        number, title, body: pull.body, state: 'open', labels: [], seq: number, isPull: true, comments: [],
      });
      return toolOk(pullJson(store, repo, pull, origin));
    }
    case 'merge_pull_request': {
      const repo = repoArg(store, args);
      if (repo === null) return toolErr('Repository not found');
      const rawNumber = args.pull_number ?? args.pullNumber ?? args.number;
      const number = typeof rawNumber === 'number' ? rawNumber : Number(rawNumber);
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolErr('Pull request not found');
      const outcome = performSquashMerge(store, repo, pull);
      if (outcome.status !== 'merged') return toolErr(`Pull request is not mergeable (${outcome.status})`);
      return toolOk({ sha: outcome.sha, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(store, repo, pull, origin) });
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC request object; returns the response object, or null for a notification. */
function handleRpc(store: Store, origin: string, rpc: RpcRequest): Record<string, unknown> | null {
  const method = typeof rpc.method === 'string' ? rpc.method : '';
  const isNotification = rpc.id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(rpc.id, {
        protocolVersion: '2026-07-28',
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      });
    case 'initialize': {
      const requested = typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '2025-11-25';
      return rpcResult(rpc.id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
      });
    }
    case 'ping':
      return rpcResult(rpc.id, {});
    case 'tools/list':
      return rpcResult(rpc.id, JSON.parse(TOOLS_LIST_JSON) as unknown);
    case 'tools/call': {
      const params = rpc.params ?? {};
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const known = TOOLS.some((t) => t.name.toLowerCase() === (name.toLowerCase().split('__').pop() ?? ''));
      if (!known) return rpcError(rpc.id, -32602, `Unknown tool: ${name}`);
      const outcome = callTool(store, origin, name, args);
      if (outcome === null) return rpcError(rpc.id, -32602, `Missing required arguments for tool: ${name}`);
      return rpcResult(rpc.id, outcome);
    }
    default:
      if (isNotification) return null;
      return rpcError(rpc.id, -32601, `Method not found: ${method}`);
  }
}

/** Route POST /mcp. Auth has already been enforced by app.ts (a missing token is 401 there). */
export async function routeMcp(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const origin = `http://${req.headers.host ?? 'localhost'}`;
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendRpc(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      const reply = handleRpc(store, origin, item as RpcRequest);
      if (reply !== null) replies.push(reply);
    }
    if (replies.length === 0) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendRpc(res, 200, replies);
    return;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendRpc(res, 400, rpcError(null, -32600, 'Invalid request'));
    return;
  }
  const rpc = parsed as RpcRequest;
  const reply = handleRpc(store, origin, rpc);
  if (reply === null) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendRpc(res, 200, reply);
}
