// The forge's HTTP server: one process serving git smart HTTP, REST v3, GraphQL
// and MCP from a single store. main.ts owns the entry <-> env lifecycle (register,
// poll /done, exit); this file is the surface the suite drives.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { routeRest, sendJson, notFound, JSON_TYPE } from './rest.ts';
import { routeMcp } from './mcp.ts';
import { routeGit } from './gitserver.ts';
import { routeGraphql } from './graphql.ts';

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** True when the request carries the trial's bearer token (or none was configured). */
function authorized(req: IncomingMessage, token: string): boolean {
  if (token === '') return true;
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(store, token, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': JSON_TYPE });
        res.end(`${JSON.stringify({ message: 'Internal Server Error' })}\n`);
      } else {
        res.end();
      }
    });
  });
  // Git clients make several small sequential requests per clone on one
  // connection: keep the socket alive across them and send replies at once
  // rather than letting Nagle's algorithm batch them into delayed segments.
  server.keepAliveTimeout = 30_000;
  server.on('connection', (socket) => socket.setNoDelay(true));
  return server;
}

async function handle(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://entry');

  // The env's boot check calls this twice, with no token: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Everything else speaks for the token's owner only.
  if (!authorized(req, token)) {
    sendJson(res, 401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    return;
  }

  // The GitHub API root: a 200 with the token's scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    sendJson(
      res,
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_search_url: '/api/v3/search/issues',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org', 'x-accepted-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  if (method === 'GET' && path === '/api/v3/meta') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0-forge',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
    });
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const parts = path.slice('/api/v3'.length).split('/').filter((p) => p !== '');
    if (await routeRest(store, req, res, url, parts)) return;
    notFound(res);
    return;
  }

  // The MCP endpoint: JSON-RPC over streamable HTTP.
  if (method === 'POST' && path === '/mcp') {
    await routeMcp(store, req, res);
    return;
  }

  // Git smart HTTP at /{owner}/{repo}.git/...
  if (await routeGit(store, req, res, url)) return;

  // GraphQL at /api/graphql (POST only).
  if (url.pathname === '/api/graphql' && (req.method ?? 'GET') === 'POST') {
    await routeGraphql(store, req, res);
    return;
  }

  notFound(res);
}
