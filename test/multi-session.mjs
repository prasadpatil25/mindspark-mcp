import { spawn } from 'node:child_process';

const PORT = 3395;
const MOCK_FETCH = new URL('./mock-github-fetch.mjs', import.meta.url);
const child = spawn('node', ['--import', MOCK_FETCH, 'src/http-server.js'], {
  env: { ...process.env, MINDSPARK_GH_TOKEN: 'fake-token', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
child.stdout.on('data', d => log += d);
child.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 800));

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail||''}`); } }

async function initSession() {
  const r = await fetch(`http://localhost:${PORT}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'session-test', version: '1.0.0' } } })
  });
  const sessionId = r.headers.get('mcp-session-id');
  await r.text();
  return { status: r.status, sessionId };
}

console.log('Multi-session verification — a real bug caught during development: a single');
console.log('shared transport instance can only complete one initialize handshake for its');
console.log('entire lifetime (the SDK tracks it as a per-transport flag), so every session');
console.log('after the first would be silently, permanently rejected. This confirms the fix.\n');

console.log('=== Three fully independent client sessions, one after another ===');
const s1 = await initSession();
check('session 1 initializes successfully', s1.status === 200 && !!s1.sessionId, JSON.stringify(s1));
const s2 = await initSession();
check('session 2 initializes successfully (this is what broke before the fix)', s2.status === 200 && !!s2.sessionId, JSON.stringify(s2));
const s3 = await initSession();
check('session 3 initializes successfully', s3.status === 200 && !!s3.sessionId, JSON.stringify(s3));
check('all three got DIFFERENT session ids', new Set([s1.sessionId, s2.sessionId, s3.sessionId]).size === 3, [s1.sessionId, s2.sessionId, s3.sessionId].join(','));

console.log('\n=== A session id from one session is rejected on requests without matching state mixed in ===');
// list_tools using session 1's id should work against session 1
let r = await fetch(`http://localhost:${PORT}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': s1.sessionId },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
});
check('reusing session 1\'s own id for a follow-up request works', r.status === 200, r.status);
await r.text();

console.log('\n=== Unknown session id is rejected cleanly, not a crash ===');
r = await fetch(`http://localhost:${PORT}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'Mcp-Session-Id': 'not-a-real-session-id' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
});
check('unknown session id gets a clean 404, not a 500', r.status === 404, r.status);

child.kill();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n--- server log ---\n' + log);
process.exit(fail ? 1 : 0);
