// GraphQL at /api/graphql: a small purpose-built engine for the GitHub v4
// shapes the forge serves — a lexer and recursive-descent parser for operation
// documents (fields, aliases, arguments, variables, inline fragments), an
// executor over the same store REST and MCP use, introspection for the types
// clients feature-detect, Relay node(id:) reads, and operation batching.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nodeId, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';
import { listFiles, mergeBase, tipTree } from './git.ts';
import { performSquashMerge, readBody, sendJson } from './rest.ts';

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end < 0 ? source.length : end) });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(source.slice(i));
      const text = match?.[0] ?? '0';
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = match?.[0] ?? '';
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  readonly fragments = new Map<string, SelectionNode[]>();
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (!this.atPunct(value)) return false;
    this.pos += 1;
    return true;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (this.atPunct('{')) {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        if (this.atPunct('(')) this.skipVariableDefinitions();
        // Directives on the operation are skipped if present.
        while (this.atPunct('@')) {
          this.next();
          this.expectName();
          if (this.atPunct('(')) this.skipArguments();
        }
        operations.push({ type: token.value, name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        if (this.expectName() !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName();
        this.fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error('unexpected token in GraphQL document');
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      this.expectName();
      this.expectPunct(':');
      this.parseType();
      if (this.eatPunct('=')) this.parseValue();
      while (this.atPunct('@')) {
        this.next();
        this.expectName();
        if (this.atPunct('(')) this.skipArguments();
      }
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.eatPunct('!');
  }

  private skipArguments(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      this.expectName();
      this.expectPunct(':');
      this.parseValue();
    }
    this.expectPunct(')');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) selections.push(this.parseSelection());
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (token.kind === 'name') return { kind: 'fragmentSpread', name: this.expectName() };
      return { kind: 'inlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    let name = this.expectName();
    let alias: string | null = null;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName();
    }
    const args: FieldNode['args'] = [];
    if (this.atPunct('(')) {
      this.expectPunct('(');
      while (!this.atPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.skipArguments();
    }
    const selectionSet = this.atPunct('{') ? this.parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.atPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}


// ---------------------------------------------------------------- values

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return vars[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => evalValue(v, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, vars);
      return out;
    }
  }
}

/** A resolved GraphQL object: its schema type plus the record it wraps. */
class GObj {
  type: string;
  data: Record<string, unknown>;

  constructor(type: string, data: Record<string, unknown>) {
    this.type = type;
    this.data = data;
  }
}

class FieldError extends Error {}

const UNKNOWN_FIELD = Symbol('unknown-field');

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string; path: (string | number)[] }[];
}

/** Decode a global id built by nodeId() back into its kind and numeric payload. */
function decodeGlobalId(id: string): { kind: string; payload: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    const payload = Number(text.slice(colon + 1));
    if (!Number.isFinite(payload)) return null;
    return { kind: text.slice(0, colon), payload };
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): RepoRec | null {
  return store.listRepos().find((repo) => repo.id === id) ?? null;
}

function findIssueByGlobalId(store: Store, globalId: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const repo = findRepoById(store, Math.floor(decoded.payload / 100000));
  if (repo === null) return null;
  const issue = repo.issues.get(decoded.payload % 100000);
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, globalId: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(globalId);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const repo = findRepoById(store, Math.floor(decoded.payload / 100000));
  if (repo === null) return null;
  const pull = repo.pulls.get(decoded.payload % 100000);
  return pull === undefined ? null : { repo, pull };
}

/** The next per-repo sequence number, one past every issue and pull request. */
function nextSeq(repo: RepoRec): number {
  let max = 0;
  for (const issue of repo.issues.values()) max = Math.max(max, issue.seq);
  for (const pull of repo.pulls.values()) max = Math.max(max, pull.seq);
  return max + 1;
}

function issueGObj(repo: RepoRec, issue: IssueRec): GObj {
  return new GObj('Issue', { repo, issue });
}

function pullGObj(repo: RepoRec, pull: PullRec): GObj {
  return new GObj('PullRequest', { repo, pull });
}

/** A commit's files as a flat path -> blob sha map. */
function filesAt(repo: RepoRec, commitSha: string): Map<string, string> {
  const out = new Map<string, string>();
  const tree = tipTree(repo, commitSha);
  if (tree === null) return out;
  for (const [path, entry] of listFiles(repo, tree)) out.set(path, entry.sha);
  return out;
}

/** MERGEABLE / CONFLICTING for an open pull request, from a file-level three-way compare. */
function mergeableOf(repo: RepoRec, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headSha === undefined || baseSha === undefined) return 'UNKNOWN';
  const base = mergeBase(repo, baseSha, headSha);
  if (base === null) return 'CONFLICTING';
  const atBase = filesAt(repo, base);
  const atHead = filesAt(repo, headSha);
  const atBaseTip = filesAt(repo, baseSha);
  const paths = new Set([...atBase.keys(), ...atHead.keys(), ...atBaseTip.keys()]);
  for (const path of paths) {
    const was = atBase.get(path);
    const head = atHead.get(path);
    const tip = atBaseTip.get(path);
    if (head !== was && tip !== was && head !== tip) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/** The paths a pull request changes, merge-base tree against head tree. */
function pullPaths(repo: RepoRec, pull: PullRec): string[] {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo, baseSha, headSha) ?? baseSha;
  const atBase = filesAt(repo, base);
  const atHead = filesAt(repo, headSha);
  const paths = new Set([...atBase.keys(), ...atHead.keys()]);
  return [...paths].filter((path) => atBase.get(path) !== atHead.get(path)).sort();
}

interface Connection {
  items: GObj[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

function cursorOf(seq: number): string {
  return Buffer.from(`cursor:${seq}`, 'utf8').toString('base64');
}

/** Slice a seq-ordered list by the first/after connection arguments. */
function paginate(items: GObj[], seqOf: (item: GObj) => number, args: Record<string, unknown>): Connection {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    try {
      const text = Buffer.from(after, 'base64').toString('utf8');
      const seq = Number(text.replace('cursor:', ''));
      const index = items.findIndex((item) => seqOf(item) === seq);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const hasNextPage = start + slice.length < items.length;
  const last = slice[slice.length - 1];
  return { items: slice, pageInfo: { hasNextPage, endCursor: last === undefined ? null : cursorOf(seqOf(last)) } };
}

function connectionGObj(type: string, connection: Connection): GObj {
  return new GObj(type, {
    nodes: connection.items,
    pageInfo: new GObj('PageInfo', { ...connection.pageInfo }),
    totalCount: connection.items.length,
  });
}


// ---------------------------------------------------------------- schema

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'updatePullRequest'],
  User: ['login', 'id', 'name', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate',
    'viewerPermission', 'hasIssuesEnabled', 'defaultBranchRef', 'issue', 'issues',
    'pullRequest', 'pullRequests', 'url', 'createdAt', 'updatedAt', 'labels', 'refs', 'ref',
  ],
  Issue: [
    'id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt',
    'author', 'labels', 'comments', 'repository', 'closed',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt',
    'author', 'additions', 'deletions', 'changedFiles', 'repository', 'mergedAt',
  ],
  Ref: ['name', 'prefix', 'target', 'repository'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'createdAt', 'updatedAt', 'author', 'url'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  LabelConnection: ['nodes', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'];

// ---------------------------------------------------------------- resolvers

function resolveField(ctx: Ctx, typeName: string, source: GObj | null, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return new GObj('User', { login: store.login() });
      case 'repository': {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : new GObj('Repository', { repo });
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = findRepoById(store, decoded.payload);
          return repo === null ? null : new GObj('Repository', { repo });
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGlobalId(store, String(args.id ?? ''));
          return found === null ? null : issueGObj(found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGlobalId(store, String(args.id ?? ''));
          return found === null ? null : pullGObj(found.repo, found.pull);
        }
        return null;
      }
      case '__type': {
        const name = String(args.name ?? '');
        if (!(name in SCHEMA_FIELDS) && name !== 'SearchType' && name !== '__Type' && name !== '__Field' && name !== '__EnumValue') return null;
        return new GObj('__Type', { name });
      }
      default:
        return UNKNOWN_FIELD;
    }
  }
  if (typeName === 'Mutation') return resolveMutation(ctx, field, args);
  if (source === null) return UNKNOWN_FIELD;
  return resolveObjectField(ctx, typeName, source, field, args);
}

function resolveMutation(ctx: Ctx, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.payload) : null;
      if (repo === null) throw new FieldError('repository not found for createIssue');
      const issue: IssueRec = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        seq: nextSeq(repo),
        isPull: false,
        comments: [],
      };
      repo.issues.set(issue.number, issue);
      return new GObj('CreateIssuePayload', { issue: issueGObj(repo, issue) });
    }
    case 'closeIssue': {
      const found = findIssueByGlobalId(store, String(input.issueId ?? ''));
      if (found === null) throw new FieldError('issue not found for closeIssue');
      found.issue.state = 'closed';
      return new GObj('CloseIssuePayload', { issue: issueGObj(found.repo, found.issue) });
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(store, decoded.payload) : null;
      if (repo === null) throw new FieldError('repository not found for createPullRequest');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined || baseSha === undefined || headRef === baseRef) {
        throw new FieldError('head and base branches must exist and differ');
      }
      const pull: PullRec = {
        number: repo.nextNumber++,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergeSha: null,
        headRef,
        baseRef,
        headSha,
        baseSha,
        seq: nextSeq(repo),
      };
      repo.pulls.set(pull.number, pull);
      repo.issues.set(pull.number, {
        number: pull.number, title: pull.title, body: pull.body, state: 'open',
        labels: [], seq: pull.seq, isPull: true, comments: [],
      });
      return new GObj('CreatePullRequestPayload', { pullRequest: pullGObj(repo, pull) });
    }
    case 'mergePullRequest': {
      const found = findPullByGlobalId(store, String(input.pullRequestId ?? ''));
      if (found === null) throw new FieldError('pull request not found for mergePullRequest');
      const result = performSquashMerge(store, found.repo, found.pull);
      if (result.status !== 'merged') throw new FieldError(`pull request could not be merged: ${result.status}`);
      return new GObj('MergePullRequestPayload', { pullRequest: pullGObj(found.repo, found.pull) });
    }
    case 'addComment': {
      const found = findIssueByGlobalId(store, String(input.subjectId ?? ''));
      if (found === null) throw new FieldError('subject not found for addComment');
      const comment = {
        id: found.repo.id * 1000000 + found.issue.number * 1000 + found.issue.comments.length + 1,
        body: String(input.body ?? ''),
        seq: nextSeq(found.repo),
      };
      found.issue.comments.push(comment);
      const node = new GObj('IssueComment', { repo: found.repo, issue: found.issue, comment });
      return new GObj('AddCommentPayload', {
        commentEdge: new GObj('CommentEdge', { node, cursor: cursorOf(comment.seq) }),
      });
    }
    default:
      return UNKNOWN_FIELD;
  }
}


function resolveObjectField(ctx: Ctx, typeName: string, source: GObj, field: string, args: Record<string, unknown>): unknown {
  const { store } = ctx;
  const data = source.data;
  switch (typeName) {
    case 'User':
      if (field === 'login') return data.login as string;
      if (field === 'id') return nodeId('User', 1000);
      if (field === 'name') return data.login as string;
      break;
    case 'Repository': {
      const repo = data.repo as RepoRec;
      switch (field) {
        case 'id': return nodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.login()}/${repo.name}`;
        case 'owner': return new GObj('User', { login: store.login() });
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'defaultBranchRef': return new GObj('Ref', { name: repo.defaultBranch, repo });
        case 'url': return `https://forge.local/${store.login()}/${repo.name}`;
        case 'createdAt':
        case 'updatedAt': return store.peekIso();
        case 'issue': {
          const rec = repo.issues.get(Number(args.number ?? 0));
          return rec === undefined || rec.isPull ? null : issueGObj(repo, rec);
        }
        case 'issues': {
          let items = [...repo.issues.values()].filter((issue) => !issue.isPull);
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toLowerCase());
            items = items.filter((issue) => wanted.includes(issue.state));
          }
          const orderBy = args.orderBy as { field?: string; direction?: string } | null;
          const descending = orderBy?.direction === 'DESC';
          items.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
          const connection = paginate(items.map((issue) => issueGObj(repo, issue)), (item) => (item.data.issue as IssueRec).seq, args);
          return connectionGObj('IssueConnection', connection);
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number ?? 0));
          return pull === undefined ? null : pullGObj(repo, pull);
        }
        case 'pullRequests': {
          let items = [...repo.pulls.values()];
          const states = args.states;
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toLowerCase());
            items = items.filter((pull) => wanted.includes(pull.merged ? 'merged' : pull.state));
          }
          items.sort((a, b) => a.seq - b.seq || a.number - b.number);
          const connection = paginate(items.map((pull) => pullGObj(repo, pull)), (item) => (item.data.pull as PullRec).seq, args);
          return connectionGObj('PullRequestConnection', connection);
        }
      }
      break;
    }
    case 'Issue': {
      const repo = data.repo as RepoRec;
      const issue = data.issue as IssueRec;
      switch (field) {
        case 'id': return nodeId('Issue', repo.id * 100000 + issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'url': return `https://forge.local/${store.login()}/${repo.name}/issues/${issue.number}`;
        case 'createdAt':
        case 'updatedAt': return store.peekIso();
        case 'author': return new GObj('User', { login: store.login() });
        case 'repository': return new GObj('Repository', { repo });
        case 'labels': return connectionGObj('LabelConnection', { items: [], pageInfo: { hasNextPage: false, endCursor: null } });
        case 'comments': return connectionGObj('IssueConnection', { items: [], pageInfo: { hasNextPage: false, endCursor: null } });
      }
      break;
    }
    case 'PullRequest': {
      const repo = data.repo as RepoRec;
      const pull = data.pull as PullRec;
      switch (field) {
        case 'id': return nodeId('PullRequest', repo.id * 100000 + pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergeable': return mergeableOf(repo, pull);
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'url': return `https://forge.local/${store.login()}/${repo.name}/pull/${pull.number}`;
        case 'createdAt':
        case 'updatedAt': return store.peekIso();
        case 'mergedAt': return pull.merged ? store.peekIso() : null;
        case 'author': return new GObj('User', { login: store.login() });
        case 'repository': return new GObj('Repository', { repo });
        case 'additions':
        case 'deletions':
        case 'changedFiles': return pullPaths(repo, pull).length;
        case 'files': {
          const paths = pullPaths(repo, pull).map(
            (path, index) => new GObj('PullRequestChangedFile', { path, additions: 0, deletions: 0, changeType: 'MODIFIED', seq: index }),
          );
          const connection = paginate(paths, (item) => item.data.seq as number, args);
          return connectionGObj('PullRequestChangedFileConnection', connection);
        }
      }
      break;
    }
    case 'Ref':
      if (field === 'name') return data.name as string;
      if (field === 'prefix') return 'refs/heads/';
      break;
    case 'PageInfo':
      if (field === 'hasNextPage') return data.hasNextPage as boolean;
      if (field === 'hasPreviousPage') return false;
      if (field === 'endCursor') return data.endCursor as string | null;
      if (field === 'startCursor') return data.endCursor as string | null;
      break;
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection':
    case 'LabelConnection':
      if (field === 'nodes') return data.nodes as GObj[];
      if (field === 'pageInfo') return data.pageInfo as GObj;
      if (field === 'totalCount') return data.totalCount as number;
      break;
    case 'PullRequestChangedFile':
      if (field === 'path') return data.path as string;
      if (field === 'additions') return data.additions as number;
      if (field === 'deletions') return data.deletions as number;
      if (field === 'changeType') return data.changeType as string;
      break;
    case 'IssueComment': {
      const comment = data.comment as { id: number; body: string };
      if (field === 'id') return nodeId('IssueComment', comment.id);
      if (field === 'body') return comment.body;
      if (field === 'createdAt' || field === 'updatedAt') return store.peekIso();
      if (field === 'author') return new GObj('User', { login: store.login() });
      break;
    }
    case 'CreateIssuePayload':
      if (field === 'issue') return data.issue as GObj;
      if (field === 'clientMutationId') return null;
      break;
    case 'CloseIssuePayload':
      if (field === 'issue') return data.issue as GObj;
      if (field === 'clientMutationId') return null;
      break;
    case 'CreatePullRequestPayload':
      if (field === 'pullRequest') return data.pullRequest as GObj;
      if (field === 'clientMutationId') return null;
      break;
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return data.pullRequest as GObj;
      if (field === 'clientMutationId') return null;
      break;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return data.commentEdge as GObj;
      if (field === 'clientMutationId') return null;
      break;
    case 'CommentEdge':
      if (field === 'node') return data.node as GObj;
      if (field === 'cursor') return data.cursor as string;
      break;
    case '__Type': {
      const name = data.name as string;
      if (field === 'name') return name;
      if (field === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        return (SCHEMA_FIELDS[name] ?? []).map((fieldName) => new GObj('__Field', { name: fieldName }));
      }
      if (field === 'enumValues') {
        return name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => new GObj('__EnumValue', { name: value })) : [];
      }
      break;
    }
    case '__Field':
      if (field === 'name') return data.name as string;
      if (field === 'description') return null;
      break;
    case '__EnumValue':
      if (field === 'name') return data.name as string;
      if (field === 'description') return null;
      break;
  }
  return UNKNOWN_FIELD;
}


// ---------------------------------------------------------------- executor

function completeValue(ctx: Ctx, value: unknown, selectionSet: SelectionNode[] | null, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) => completeValue(ctx, item, selectionSet, [...path, index]));
  }
  if (value instanceof GObj) {
    if (selectionSet === null) return null;
    return executeSelectionSet(ctx, value.type, value, selectionSet, path);
  }
  return value;
}

function executeSelectionSet(
  ctx: Ctx,
  typeName: string,
  source: GObj | null,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelectionSet(ctx, typeName, source, selection.selectionSet, path));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(ctx, typeName, source, fragment, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = evalValue(arg.value, ctx.vars);
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, source, selection.name, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : 'field error', path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (value === UNKNOWN_FIELD) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection.selectionSet, [...path, key]);
  }
  return out;
}

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: { message: string; path?: (string | number)[] }[];
}

function executeOperation(store: Store, operation: unknown): OperationResult {
  if (operation === null || typeof operation !== 'object') {
    return { data: null, errors: [{ message: 'operation must be an object' }] };
  }
  const body = operation as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string') {
    return { data: null, errors: [{ message: 'query must be a string' }] };
  }
  const vars = (body.variables ?? {}) as Record<string, unknown>;
  let operations: OperationNode[];
  let fragments: Map<string, SelectionNode[]>;
  try {
    const parser = new Parser(lex(body.query));
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const chosen = typeof body.operationName === 'string'
    ? (operations.find((op) => op.name === body.operationName) ?? operations[0])
    : operations[0];
  if (chosen === undefined) return { data: null, errors: [{ message: 'no operation in document' }] };
  const ctx: Ctx = { store, vars, fragments, errors: [] };
  const rootType = chosen.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(ctx, rootType, null, chosen.selectionSet, []);
  const result: OperationResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** POST /api/graphql — one operation, or an array of them answered in order. */
export async function routeGraphql(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'request body is not JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((operation) => executeOperation(store, operation)));
    return;
  }
  sendJson(res, 200, executeOperation(store, parsed));
}
