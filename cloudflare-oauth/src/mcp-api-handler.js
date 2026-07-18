import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from '../../src/server.js';
import { GitHubStore } from '../../src/github-store.js';
import { WIDGET_HTML } from './widget-html.generated.js';

// One {server, transport} pair per MCP session, exactly like
// mcp-server/src/http-server.js — a single shared transport can only complete
// one initialize handshake for its entire lifetime (confirmed directly against
// the SDK's source during that server's development), so each new session
// needs its own. Module-level state persists for the lifetime of this Worker
// isolate, which is the same lifetime OAuthProvider's own per-request routing
// assumes.
const sessions = new Map();   // sessionId -> { transport, lastUsed, login }
const SESSION_IDLE_MS = 30 * 60 * 1000;

function reapIdleSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.lastUsed > SESSION_IDLE_MS) sessions.delete(id);
}

function isInitializeRequest(body) {
  return body && typeof body === 'object' && !Array.isArray(body) && body.method === 'initialize';
}

async function newSession(props, env) {
  const store = new GitHubStore({ token: props.accessToken, repo: env.MINDSPARK_GH_REPO || 'mindspark-maps' });
  const mcpServer = await createServer(store, { appUrl: env.MINDSPARK_APP_URL, widgetHTML: WIDGET_HTML });
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sessionId) => { sessions.set(sessionId, { transport, lastUsed: Date.now(), login: props.login }); },
    onsessionclosed: (sessionId) => { sessions.delete(sessionId); }
  });
  await mcpServer.connect(transport);
  return transport;
}

export const McpApiHandler = {
  async fetch(request, env, ctx) {
    reapIdleSessions();
    const props = ctx.props;   // set during completeAuthorization() in github-handler.js
    if (!props || !props.accessToken) {
      return new Response(JSON.stringify({ error: 'not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const existingId = request.headers.get('mcp-session-id');
    if (existingId && sessions.has(existingId)) {
      const s = sessions.get(existingId);
      // A session belongs to whichever GitHub identity created it — if a
      // different grant's token somehow presented this session id, refuse
      // rather than silently letting one user's session serve another's calls.
      if (s.login !== props.login) return new Response('Session does not belong to this identity', { status: 403 });
      s.lastUsed = Date.now();
      return s.transport.handleRequest(request);
    }

    let body;
    if (request.method === 'POST') {
      try { body = await request.clone().json(); } catch (e) { /* not JSON, or empty — let the transport's own parsing handle/reject it */ }
    }
    if (!existingId && isInitializeRequest(body)) {
      const transport = await newSession(props, env);
      return transport.handleRequest(request);
    }
    if (existingId) return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'No session — send an initialize request first' }, id: body?.id ?? null }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }
};
