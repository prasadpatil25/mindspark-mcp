import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.js';
import { WIDGET_HTML } from './widget-html.generated.js';

// One transport per MCP session — same reasoning as cloudflare-oauth's API
// handler: a single shared transport can only complete one initialize handshake
// for its entire lifetime (confirmed directly against the SDK's source during
// that server's development), so each new connecting client needs its own.
// Unlike the OAuth server, there is no per-user identity here at all — every
// session is equally anonymous, so there's nothing to isolate sessions BY beyond
// the session id itself.
const sessions = new Map();
const SESSION_IDLE_MS = 30 * 60 * 1000;

function reapIdleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
}
function isInitializeRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
}

async function newSession(env) {
  const mcpServer = createServer({ appUrl: env.MINDSPARK_APP_URL, widgetHTML: WIDGET_HTML });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, lastUsed: Date.now() }); },
    onsessionclosed: (sessionId) => { sessions.delete(sessionId); }
  });
  await mcpServer.connect(transport);
  return transport;
}

async function handleMcp(request, env) {
  reapIdleSessions();
  if (!env.MINDSPARK_APP_URL) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: MINDSPARK_APP_URL is not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const existingId = request.headers.get('mcp-session-id');
  if (existingId && sessions.has(existingId)) {
    const s = sessions.get(existingId);
    s.lastUsed = Date.now();
    return s.transport.handleRequest(request);
  }

  let body;
  if (request.method === 'POST') {
    try { body = await request.clone().json(); } catch (e) { /* not JSON — let the transport reject it */ }
  }
  if (!existingId && isInitializeRequest(body)) {
    const transport = await newSession(env);
    return transport.handleRequest(request);
  }
  if (existingId) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'No session — send an initialize request first' }, id: body?.id ?? null }), { status: 400, headers: { 'Content-Type': 'application/json' } });
}

function corsHeaders(res) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return corsHeaders(new Response(null, { status: 204 }));

    if ((url.pathname === '/' && request.method === 'GET')) {
      return corsHeaders(new Response(
        'mindspark-mcp (no-login) is running. MCP endpoint: POST /mcp. No sign-in required — every map becomes a read-only MindSpark share link.',
        { status: 200, headers: { 'Content-Type': 'text/plain' } }
      ));
    }

    if (url.pathname.startsWith('/.well-known/')) return corsHeaders(new Response(null, { status: 404 }));

    if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/') || (url.pathname === '/' && request.method !== 'GET')) {
      return corsHeaders(await handleMcp(request, env));
    }

    return corsHeaders(new Response('Not found', { status: 404 }));
  }
};
