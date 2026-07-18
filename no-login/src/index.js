import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createServer } from './server.js';
import { WIDGET_HTML } from './widget-html.generated.js';

// Stateless by design, not just by omission: create_map has no dependency on
// any state between calls (every call is fully self-contained), so there is
// nothing that needs to persist across requests in the first place. This
// matters specifically on Cloudflare Workers — a real, deployed Worker does
// NOT guarantee the same isolate handles two consecutive requests, even
// seconds apart, so a session tracked in a module-level Map (the previous
// version of this file) could be created on one isolate and be invisible to
// the very next request if it lands on a different one. That's a real,
// confirmed-plausible cause of connector setup failing right after a
// successful-looking initialize. Stateless mode (sessionIdGenerator: undefined)
// sidesteps this entirely rather than working around it: every request,
// including the initialize handshake itself, is handled independently by its
// own fresh transport, so there's no cross-request state to lose.
async function handleMcp(request, env) {
  if (!env.MINDSPARK_APP_URL) {
    return new Response(JSON.stringify({ error: 'Server misconfigured: MINDSPARK_APP_URL is not set' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  const mcpServer = await createServer({ appUrl: env.MINDSPARK_APP_URL, widgetHTML: WIDGET_HTML });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  return transport.handleRequest(request);
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
