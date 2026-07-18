import { McpApiHandler } from '../src/mcp-api-handler.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

const fakeRepo = { files: new Map(), shaCounter: 0 };
function nextSha() { return 'sha' + (++fakeRepo.shaCounter); }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  const j = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.pathname === '/user') {
    // Distinguish identities by which token is used, matching GitHubStore's own whoami() call.
    const auth = opts.headers?.Authorization || '';
    return j(200, { login: auth.includes('alice-token') ? 'alice' : 'bob' });
  }
  if (/\/repos\/(alice|bob)\/mindspark-maps$/.test(u.pathname)) return j(200, {});
  const m = u.pathname.match(/\/repos\/(alice|bob)\/mindspark-maps\/contents\/(.+)$/);
  if (m) {
    const key = m[1] + ':' + decodeURIComponent(m[2]);
    if (method === 'GET') { const f = fakeRepo.files.get(key); if (!f) return j(404, {}); return j(200, { content: b64(f.content), sha: f.sha, encoding: 'base64' }); }
    if (method === 'PUT') { const body = JSON.parse(opts.body); const sha = nextSha(); fakeRepo.files.set(key, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha }); return j(200, { content: { sha } }); }
  }
  throw new Error('unhandled mock fetch: ' + method + ' ' + url);
};

const env = { MINDSPARK_GH_REPO: 'mindspark-maps' };

async function initRequest(props) {
  const req = new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
  });
  return McpApiHandler.fetch(req, env, { props });
}

console.log('=== Unauthenticated request (no props at all) is rejected ===');
{
  const req = new Request('https://mcp.example.com/mcp', { method: 'POST' });
  const res = await McpApiHandler.fetch(req, env, {});
  check('returns 401', res.status === 401);
}

console.log('\n=== A valid initialize request creates a real, working session ===');
let aliceSessionId;
{
  const res = await initRequest({ accessToken: 'alice-token', login: 'alice' });
  check('initialize succeeds', res.status === 200, res.status);
  aliceSessionId = res.headers.get('mcp-session-id');
  check('a session id was issued', !!aliceSessionId);
}

console.log('\n=== Follow-up request with the session id reuses the session and can call real tools ===');
{
  const req = new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': aliceSessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  });
  const res = await McpApiHandler.fetch(req, env, { props: { accessToken: 'alice-token', login: 'alice' } });
  check('tools/list succeeds using the reused session', res.status === 200, res.status);
  const text = await res.text();
  check('the real tool set is present (proves this is genuinely running createServer(), not a stub)', text.includes('create_map') && text.includes('render_map'), text.slice(0, 300));
}

console.log('\n=== A DIFFERENT identity presenting alice\'s session id is rejected, not served ===');
{
  const req = new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': aliceSessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  });
  const res = await McpApiHandler.fetch(req, env, { props: { accessToken: 'bob-token', login: 'bob' } });
  check('bob presenting alice\'s session id gets 403, not alice\'s data', res.status === 403, res.status);
}

console.log('\n=== Two different identities get fully independent sessions ===');
{
  const res = await initRequest({ accessToken: 'bob-token', login: 'bob' });
  check('bob can independently initialize his own session', res.status === 200, res.status);
  const bobSessionId = res.headers.get('mcp-session-id');
  check('bob got a DIFFERENT session id than alice', bobSessionId !== aliceSessionId);
}

console.log('\n=== The real GitHub token from props actually gets used for the underlying API calls ===');
{
  // create_map via alice's session, then confirm it landed under alice's repo path (not bob's).
  const req = new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': aliceSessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_map', arguments: { outline: '# Alice\'s Map\n- item' } } })
  });
  const createRes = await McpApiHandler.fetch(req, env, { props: { accessToken: 'alice-token', login: 'alice' } });
  // The transport returns the Response immediately with a streaming body — the
  // tool call's own async work (including the GitHub calls this test checks
  // for) completes as that stream is written, not before. A real MCP client
  // always reads the body to get its result, so consuming it here matches
  // real usage rather than being a test-only workaround.
  await createRes.text();
  const aliceFiles = [...fakeRepo.files.keys()].filter(k => k.startsWith('alice:'));
  check('the map was actually created under alice\'s GitHub identity, proving props.accessToken drove the real call', aliceFiles.some(k => k.includes('maps/')), aliceFiles);
}

console.log('\n=== Unknown session id is rejected cleanly ===');
{
  const req = new Request('https://mcp.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': 'totally-made-up-session-id' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} })
  });
  const res = await McpApiHandler.fetch(req, env, { props: { accessToken: 'alice-token', login: 'alice' } });
  check('unknown session id gets a clean 404, not a crash', res.status === 404, res.status);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
