#!/usr/bin/env node
// HTTP entry point — same tools as src/server.js, reachable over the network instead
// of spawned as a local process. This is the "single user, run it yourself and expose
// it via a tunnel" path: the GitHub token still comes from one environment variable,
// same as the stdio version. It is NOT a multi-tenant server — anyone who can reach
// this port can call every tool as you, using your token. Put it behind a tunnel
// (ngrok) for testing, and treat the URL as a secret while it's running.
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { GitHubStore } from './github-store.js';
import { createServer } from './server.js';

const token = process.env.MINDSPARK_GH_TOKEN;
if (!token) {
  console.error('MINDSPARK_GH_TOKEN is not set. See README.md.');
  process.exit(1);
}
const repo = process.env.MINDSPARK_GH_REPO || 'mindspark-maps';
const port = parseInt(process.env.PORT || '3300', 10);

const store = new GitHubStore({ token, repo });

// Stateful mode (the SDK's stateless mode 500s on the notifications/initialized
// message every client sends right after connecting — confirmed directly against a
// raw HTTP request, not assumed) requires one transport PER SESSION, not one shared
// for the whole process: the SDK tracks "initialized" as a flag on the transport
// instance itself, so a single shared transport can only ever complete one
// initialize handshake for its entire lifetime — every session after the first would
// be permanently rejected with "Server already initialized". This map holds one
// {server, transport} pair per active Mcp-Session-Id, created fresh on each new
// initialize and reused for that session's subsequent requests, with idle ones
// cleaned up so it doesn't grow without bound.
const sessions = new Map();   // sessionId -> { transport, lastUsed }
const SESSION_IDLE_MS = 30 * 60 * 1000;   // 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) { s.transport.close(); sessions.delete(id); }
}, 5 * 60 * 1000).unref();

function isInitializeRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
}

async function newSession() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, lastUsed: Date.now() }); },
    onsessionclosed: (sessionId) => { sessions.delete(sessionId); }
  });
  transport.onerror = (err) => console.error('Transport error:', err && err.stack || err);
  const mcpServer = await createServer(store, { appUrl: process.env.MINDSPARK_APP_URL });
  await mcpServer.connect(transport);
  return transport;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
}

async function handleMcp(req, res) {
  try {
    const existingId = req.headers['mcp-session-id'];
    let transport;
    if (existingId && sessions.has(existingId)) {
      const s = sessions.get(existingId);
      s.lastUsed = Date.now();
      transport = s.transport;
      await transport.handleRequest(req, res);
      return;
    }
    if (!existingId) {
      // No session yet — read the body ourselves (need to inspect it to confirm this
      // is really an initialize call before committing to a new session/transport),
      // then hand it to the transport as a pre-parsed body.
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      if (isInitializeRequest(body)) {
        transport = await newSession();
        await transport.handleRequest(req, res, body);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'No session — send an initialize request first' }, id: body?.id ?? null }));
      return;
    }
    // Session id given but unknown (expired/cleaned up, or never existed).
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }));
  } catch (e) {
    console.error('Request error:', e);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
}

const httpServer = http.createServer(async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('mindspark-mcp is running. MCP endpoint: POST /mcp');
    return;
  }

  // No OAuth here (single-user, token-via-env-var model) — respond immediately
  // rather than letting a ChatGPT connector wizard hang or 502 waiting for a
  // well-known discovery document that doesn't exist.
  if (req.url.startsWith('/.well-known/')) { res.writeHead(404); res.end(); return; }

  // Accept MCP traffic at the bare root too, not just /mcp — a connector configured
  // with just the tunnel's base URL (no /mcp suffix) is an easy, common mistake to
  // make, and previously failed with a silent 404 instead of connecting.
  if (req.url === '/mcp' || req.url.startsWith('/mcp/') || (req.url === '/' && req.method !== 'GET')) {
    await handleMcp(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

httpServer.listen(port, () => {
  console.error(`mindspark-mcp (HTTP) listening on http://localhost:${port}/mcp`);
  console.error('Expose this with a tunnel (e.g. "ngrok http ' + port + '") to connect it from ChatGPT.');
});
