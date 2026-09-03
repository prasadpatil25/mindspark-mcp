// Same coverage as test/e2e.mjs (the real MCP protocol, in-memory transport, all 7
// tools), but backed by SelfHostedStore against a mock of MindSpark's *own* REST API
// instead of GitHub's Contents API — proves the self-hosted storage mode works
// end-to-end through the real tool surface, not just in isolation.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { SelfHostedStore } from '../src/self-hosted-store.js';

// --- Mock of MindSpark's self-hosted REST API (GET/POST/PUT/DELETE /api/maps[/:id]) ---
const fakeServer = { maps: new Map() };
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  if (u.pathname === '/api/maps' && method === 'GET') {
    const list = [...fakeServer.maps.values()].map(m => ({ id: m.id, title: m.title, color: m.color, updated: m.updated }));
    return json(200, list);
  }
  const m = u.pathname.match(/^\/api\/maps\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') {
      const map = fakeServer.maps.get(id);
      return map ? json(200, map) : json(404, { error: 'not found' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      body.id = id;
      fakeServer.maps.set(id, body);
      return json(200, { ok: true, id });
    }
    if (method === 'DELETE') {
      fakeServer.maps.delete(id);
      return { ok: true, status: 204, json: async () => ({}), text: async () => '' };
    }
  }
  throw new Error('Unhandled mock fetch: ' + method + ' ' + url);
};

// --- Wire up server <-> client over the real MCP protocol, in-memory ---
const store = new SelfHostedStore({ baseUrl: 'http://mock-self-hosted' });
const server = await createServer(store);
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '1.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); }
}
async function callTool(name, args) {
  return client.callTool({ name, arguments: args });
}

console.log('=== list_maps (empty server) ===');
let r = await callTool('list_maps', {});
check('reports no maps found', r.content[0].text.includes('No maps found'), r.content[0].text);

console.log('\n=== create_map ===');
r = await callTool('create_map', { outline: '# Roadmap\n## Q1\n- Ship auth\n- Ship billing\n## Q2\n- Scale infra' });
check('did not error', !r.isError, r.content[0].text);
const idMatch = r.content[0].text.match(/\[id: (\w+)\]/);
const mapId = idMatch && idMatch[1];
check('returned a map id', !!mapId, r.content[0].text);

console.log('\n=== list_maps (after create) ===');
r = await callTool('list_maps', {});
check('shows the created map', r.content[0].text.includes('Roadmap'), r.content[0].text);

console.log('\n=== get_map ===');
r = await callTool('get_map', { id: mapId });
check('renders the outline with node ids', r.content[0].text.includes('Ship auth') && r.content[0].text.includes('[id:'), r.content[0].text);
const q1Match = r.content[0].text.match(/- Q1\s+\[id: (\w+)\]/);
const q1Id = q1Match && q1Match[1];

console.log('\n=== add_node + update_node ===');
r = await callTool('add_node', { mapId, parentId: q1Id, text: 'Ship <b>mobile app</b>' });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('get_map', { id: mapId });
const newNodeMatch = r.content[0].text.match(/mobile app\s+\[id: (\w+)\]/);
const newNodeId = newNodeMatch && newNodeMatch[1];
check('new node appears under Q1', !!newNodeId, r.content[0].text);
r = await callTool('update_node', { mapId, nodeId: newNodeId, text: 'Ship mobile app v2' });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('get_map', { id: mapId });
check('text updated', r.content[0].text.includes('mobile app v2'), r.content[0].text);

console.log('\n=== delete_node (cascade) ===');
r = await callTool('delete_node', { mapId, nodeId: q1Id });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('get_map', { id: mapId });
check('Q1 and its children gone', !r.content[0].text.includes('Ship auth') && !r.content[0].text.includes('mobile app v2'), r.content[0].text);
check('Q2 untouched', r.content[0].text.includes('Scale infra'), r.content[0].text);

console.log('\n=== error handling: unknown map id ===');
r = await callTool('get_map', { id: 'doesnotexist' });
check('reports isError', r.isError === true);

console.log('\n=== delete_map ===');
r = await callTool('delete_map', { id: mapId });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('list_maps', {});
check('map no longer listed', r.content[0].text.includes('No maps found'), r.content[0].text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
