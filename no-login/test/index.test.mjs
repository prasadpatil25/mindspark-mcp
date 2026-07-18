import worker from '../src/index.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail).slice(0, 300) : ''}`); } }

const env = { MINDSPARK_APP_URL: 'https://mindspark.example.com' };

console.log('=== GET / health check ===');
{
  const res = await worker.fetch(new Request('https://worker.example.com/'), env, {});
  check('returns 200', res.status === 200);
  check('mentions the /mcp endpoint', (await res.text()).includes('/mcp'));
}

console.log('\n=== Misconfigured server (no MINDSPARK_APP_URL) fails clearly, not silently ===');
{
  const res = await worker.fetch(new Request('https://worker.example.com/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } })
  }), {}, {});
  check('returns 500 with a clear message', res.status === 500);
  check('message mentions the missing var', (await res.text()).includes('MINDSPARK_APP_URL'));
}

console.log('\n=== initialize works with NO prior state (stateless mode) ===');
{
  const res = await worker.fetch(new Request('https://worker.example.com/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chatgpt-simulated', version: '1' } } })
  }), env, {});
  check('initialize succeeds', res.status === 200, res.status);
  check('stateless mode: NO session id header issued', !res.headers.get('mcp-session-id'));
}

console.log('\n=== THE ACTUAL BUG THIS FIXES: a completely fresh, independent call (simulating a different Worker isolate with zero shared JS state) still works for tools/call, with no session id at all ===');
{
  // Critically: this does NOT reuse anything from the initialize call above —
  // no session id, no shared variable, nothing. This is deliberately simulating
  // the real, confirmed-plausible failure mode: Cloudflare routing consecutive
  // requests to different isolates, each with its own fresh module state. If
  // this worked only because of in-memory session tracking, this call would
  // fail exactly the way the live connector setup did.
  const res = await worker.fetch(new Request('https://worker.example.com/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_map', arguments: { outline: '# Independent Call Test\n- item' } } })
  }), env, {});
  check('tools/call succeeds with zero shared state from any prior request', res.status === 200, res.status);
  const text = await res.text();
  check('produces a real share link', /#view=g[A-Za-z0-9_-]+/.test(text), text.slice(0, 200));
}

console.log('\n=== Two fully independent create_map calls, neither aware the other happened ===');
{
  const call = async (outline) => {
    const res = await worker.fetch(new Request('https://worker.example.com/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_map', arguments: { outline } } })
    }), env, {});
    return res.text();
  };
  const [a, b] = await Promise.all([call('# Map A\n- x'), call('# Map B\n- y')]);
  check('both concurrent, independent calls succeed', /#view=/.test(a) && /#view=/.test(b));
  check('each got its own distinct result (no cross-talk between "isolates")', a.includes('Map A') && b.includes('Map B'), { a: a.slice(0, 100), b: b.slice(0, 100) });
}

console.log('\n=== .well-known paths return a clean 404 (no OAuth discovery to advertise) ===');
{
  const res = await worker.fetch(new Request('https://worker.example.com/.well-known/oauth-protected-resource'), env, {});
  check('returns 404', res.status === 404);
}

console.log('\n=== CORS headers present on responses ===');
{
  const res = await worker.fetch(new Request('https://worker.example.com/'), env, {});
  check('Access-Control-Allow-Origin present', res.headers.get('Access-Control-Allow-Origin') === '*');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
