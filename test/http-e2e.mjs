import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const MOCK_FETCH = new URL('./mock-github-fetch.mjs', import.meta.url);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); }
}

const child = spawn('node', ['--import', MOCK_FETCH, 'src/http-server.js'], {
  env: { ...process.env, MINDSPARK_GH_TOKEN: 'fake-token', PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
child.stdout.on('data', d => serverLog += d);
child.stderr.on('data', d => serverLog += d);

await new Promise(res => setTimeout(res, 800));   // let the server bind

try {
  console.log('=== Auxiliary routes (health check, CORS, 404s) ===');
  let r = await fetch(BASE + '/');
  check('GET / returns 200 (health check)', r.status === 200, r.status);

  r = await fetch(BASE + '/mcp', { method: 'OPTIONS' });
  check('OPTIONS /mcp returns CORS preflight (204)', r.status === 204, r.status);
  check('CORS headers present', r.headers.get('access-control-allow-origin') === '*');

  r = await fetch(BASE + '/.well-known/oauth-authorization-server');
  check('OAuth discovery route returns 404 (no auth in this mode)', r.status === 404, r.status);

  // A connector configured with just the bare tunnel URL (no /mcp suffix) is an easy,
  // common mistake — confirm POST to root works as an MCP endpoint instead of 404ing,
  // while GET / still serves the plain health check.
  r = await fetch(BASE, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'root-post-test', version: '1.0.0' } } })
  });
  check('POST to bare root is handled as MCP traffic, not 404', r.status === 200, r.status);

  console.log('\n=== Real MCP protocol over real HTTP ===');
  const transport = new StreamableHTTPClientTransport(new URL(BASE + '/mcp'));
  const client = new Client({ name: 'http-test-client', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map(t => t.name);
  check('all 7 tools registered', ['list_maps', 'get_map', 'create_map', 'add_node', 'update_node', 'delete_node', 'delete_map'].every(n => names.includes(n)));

  console.log('\n=== Tool annotations present (required by OpenAI Apps SDK) ===');
  const byName = Object.fromEntries(tools.tools.map(t => [t.name, t]));
  check('list_maps has readOnlyHint: true', byName.list_maps.annotations?.readOnlyHint === true);
  check('create_map has readOnlyHint: false, destructiveHint: false', byName.create_map.annotations?.readOnlyHint === false && byName.create_map.annotations?.destructiveHint === false);
  check('delete_map has destructiveHint: true', byName.delete_map.annotations?.destructiveHint === true);
  check('every tool declares openWorldHint', tools.tools.every(t => typeof t.annotations?.openWorldHint === 'boolean'));

  console.log('\n=== create_map + get_map round trip over real HTTP ===');
  let res = await client.callTool({ name: 'create_map', arguments: { outline: '# Launch Plan\n## Marketing\n- Landing page\n- Press release' } });
  check('create_map succeeded', !res.isError, res.content[0].text);
  const idMatch = res.content[0].text.match(/\[id: (\w+)\]/);
  check('got a map id back', !!idMatch);
  const mapId = idMatch && idMatch[1];

  res = await client.callTool({ name: 'get_map', arguments: { id: mapId } });
  check('get_map returns the created content', res.content[0].text.includes('Landing page') && res.content[0].text.includes('Press release'), res.content[0].text);

  console.log('\n=== Widget resource and render_map over real HTTP ===');
  const resources = await client.listResources();
  check('widget resource discoverable over HTTP', resources.resources.some(r => r.uri === 'ui://widget/mindmap.html'));
  const widgetRead = await client.readResource({ uri: 'ui://widget/mindmap.html' });
  check('widget HTML reads back complete over HTTP', widgetRead.contents[0].text.includes('</script>') && widgetRead.contents[0].text.includes('widget-root'));

  res = await client.callTool({ name: 'render_map', arguments: { id: mapId } });
  check('render_map succeeds over HTTP', !res.isError, res.content?.[0]?.text);
  check('render_map structuredContent present over HTTP', !!res.structuredContent?.nodes);
  check('render_map result carries widget _meta over HTTP', res._meta?.['openai/outputTemplate'] === 'ui://widget/mindmap.html');

  await client.close();
} catch (e) {
  fail++;
  console.log('\n!!! UNCAUGHT ERROR:', e.stack || e.message);
} finally {
  child.kill();
  console.log(`\n${pass} passed, ${fail} failed`);
  console.log('\n--- server log ---\n' + serverLog);
  process.exit(fail ? 1 : 0);
}
