// Confirms MINDSPARK_MCP_TOKEN actually gates the HTTP transport: requests without
// (or with the wrong) bearer token are rejected before ever reaching a tool, and the
// right token still works — plus the default (unset) behavior is unchanged from
// before this option existed, so existing single-user deployments aren't broken by
// upgrading.
import { spawn } from 'node:child_process';

const PORT = 3398;
const BASE = `http://localhost:${PORT}`;
const MOCK_FETCH = new URL('./mock-github-fetch.mjs', import.meta.url);
const REAL_TOKEN = 'test-mcp-shared-secret';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); }
}

function initializeBody(id = 1) {
  return JSON.stringify({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'auth-test', version: '1.0.0' } } });
}

const child = spawn('node', ['--import', MOCK_FETCH, 'src/http-server.js'], {
  env: { ...process.env, MINDSPARK_GH_TOKEN: 'fake-token', MINDSPARK_MCP_TOKEN: REAL_TOKEN, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', d => serverLog += d);
child.stderr.on('data', d => serverLog += d);

await new Promise(res => setTimeout(res, 800));

try {
  console.log('=== MINDSPARK_MCP_TOKEN set ===');

  let r = await fetch(BASE + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: initializeBody()
  });
  check('no Authorization header -> 401', r.status === 401, r.status);

  r = await fetch(BASE + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: 'Bearer wrong-token' },
    body: initializeBody(2)
  });
  check('wrong bearer token -> 401', r.status === 401, r.status);

  r = await fetch(BASE + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', Authorization: `Bearer ${REAL_TOKEN}` },
    body: initializeBody(3)
  });
  check('correct bearer token -> 200', r.status === 200, r.status);

  r = await fetch(BASE + '/');
  check('unauthenticated GET / (health check) still works — not gated', r.status === 200, r.status);
} catch (e) {
  fail++;
  console.log('\n!!! UNCAUGHT ERROR:', e.stack || e.message);
} finally {
  child.kill();
}

// --- Second server: MINDSPARK_MCP_TOKEN unset — default behavior unchanged ---
const PORT2 = 3397;
const BASE2 = `http://localhost:${PORT2}`;
const child2 = spawn('node', ['--import', MOCK_FETCH, 'src/http-server.js'], {
  env: { ...process.env, MINDSPARK_GH_TOKEN: 'fake-token', PORT: String(PORT2) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog2 = '';
child2.stdout.on('data', d => serverLog2 += d);
child2.stderr.on('data', d => serverLog2 += d);
await new Promise(res => setTimeout(res, 800));

try {
  console.log('\n=== MINDSPARK_MCP_TOKEN unset (default) ===');
  const r = await fetch(BASE2 + '/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: initializeBody(4)
  });
  check('no Authorization header still works when MCP_TOKEN unset', r.status === 200, r.status);
} catch (e) {
  fail++;
  console.log('\n!!! UNCAUGHT ERROR:', e.stack || e.message);
} finally {
  child2.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('\n--- server log ---\n' + serverLog + '\n' + serverLog2);
  process.exit(fail ? 1 : 0);
}
