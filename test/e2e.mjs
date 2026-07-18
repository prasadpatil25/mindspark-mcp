import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { GitHubStore } from '../src/github-store.js';

// --- Mock GitHub API: an in-memory filesystem shaped like the real Contents API ---
const fakeRepo = { files: new Map(), shaCounter: 0 };
function nextSha() { return 'sha' + (++fakeRepo.shaCounter); }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const method = opts.method || 'GET';

  if (u.pathname === '/user') {
    return jsonResponse(200, { login: 'testuser' });
  }
  if (/\/repos\/testuser\/mindspark-maps$/.test(u.pathname)) {
    return jsonResponse(200, { name: 'mindspark-maps' });   // repo already "exists"
  }
  const m = u.pathname.match(/\/repos\/testuser\/mindspark-maps\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const f = fakeRepo.files.get(path);
      if (!f) return jsonResponse(404, { message: 'Not Found' });
      return jsonResponse(200, { content: b64(f.content), sha: f.sha, encoding: 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const existing = fakeRepo.files.get(path);
      if (existing && body.sha && body.sha !== existing.sha) return jsonResponse(409, { message: 'sha mismatch' });
      if (existing && !body.sha) return jsonResponse(409, { message: 'sha required' });
      const sha = nextSha();
      fakeRepo.files.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return jsonResponse(200, { content: { sha } });
    }
    if (method === 'DELETE') {
      const existing = fakeRepo.files.get(path);
      if (!existing) return jsonResponse(404, { message: 'Not Found' });
      fakeRepo.files.delete(path);
      return jsonResponse(200, {});
    }
  }
  throw new Error('Unhandled mock fetch: ' + method + ' ' + url);
};
function jsonResponse(status, obj) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

// --- Wire up server <-> client over the real MCP protocol, in-memory ---
const store = new GitHubStore({ token: 'fake-token', repo: 'mindspark-maps' });
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
  const res = await client.callTool({ name, arguments: args });
  return res;
}

console.log('=== tools/list ===');
const toolList = await client.listTools();
const names = toolList.tools.map(t => t.name);
check('all 7 tools registered', ['list_maps', 'get_map', 'create_map', 'add_node', 'update_node', 'delete_node', 'delete_map'].every(n => names.includes(n)), names.join(','));

console.log('\n=== list_maps (empty repo) ===');
let r = await callTool('list_maps', {});
check('reports no maps found', r.content[0].text.includes('No maps found'), r.content[0].text);

console.log('\n=== create_map ===');
r = await callTool('create_map', { outline: '# Roadmap\n## Q1\n- Ship auth\n- Ship billing\n## Q2\n- Scale infra' });
check('did not error', !r.isError, r.content[0].text);
const idMatch = r.content[0].text.match(/\[id: (\w+)\]/);
check('returned a map id', !!idMatch, r.content[0].text);
const mapId = idMatch && idMatch[1];
check('outline echoed back with correct nesting', r.content[0].text.includes('Ship auth') && r.content[0].text.includes('Ship billing'));

console.log('\n=== list_maps (after create) ===');
r = await callTool('list_maps', {});
check('shows the created map', r.content[0].text.includes('Roadmap'), r.content[0].text);

console.log('\n=== get_map ===');
r = await callTool('get_map', { id: mapId });
check('renders the outline with node ids', r.content[0].text.includes('Ship auth') && r.content[0].text.includes('[id:'), r.content[0].text);
const q1Match = r.content[0].text.match(/- Q1\s+\[id: (\w+)\]/);
const q1Id = q1Match && q1Match[1];
check('found Q1 node id for the next step', !!q1Id, r.content[0].text);

console.log('\n=== add_node ===');
r = await callTool('add_node', { mapId, parentId: q1Id, text: 'Ship <b>mobile app</b>' });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('get_map', { id: mapId });
check('new node appears under Q1', r.content[0].text.includes('mobile app'), r.content[0].text);

console.log('\n=== update_node ===');
const newNodeMatch = r.content[0].text.match(/mobile app\s+\[id: (\w+)\]/);
const newNodeId = newNodeMatch[1];
r = await callTool('update_node', { mapId, nodeId: newNodeId, text: 'Ship mobile app v2' });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('get_map', { id: mapId });
check('text updated', r.content[0].text.includes('mobile app v2'), r.content[0].text);

console.log('\n=== delete_node (cascade) ===');
r = await callTool('delete_node', { mapId, nodeId: q1Id });
check('did not error', !r.isError, r.content[0].text);
check('reports descendants removed', /and \d+ descendant/.test(r.content[0].text), r.content[0].text);
r = await callTool('get_map', { id: mapId });
check('Q1 and its children gone', !r.content[0].text.includes('Ship auth') && !r.content[0].text.includes('mobile app v2'), r.content[0].text);
check('Q2 untouched', r.content[0].text.includes('Scale infra'), r.content[0].text);

console.log('\n=== error handling: unknown map id ===');
r = await callTool('get_map', { id: 'doesnotexist' });
check('reports isError', r.isError === true);
check('has a clear message', r.content[0].text.includes('No map with id'), r.content[0].text);

console.log('\n=== delete_map ===');
r = await callTool('delete_map', { id: mapId });
check('did not error', !r.isError, r.content[0].text);
r = await callTool('list_maps', {});
check('map no longer listed', r.content[0].text.includes('No maps found'), r.content[0].text);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
