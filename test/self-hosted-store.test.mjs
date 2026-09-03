// Direct unit coverage of SelfHostedStore against a mocked self-hosted REST API —
// separate from test/self-hosted-e2e.mjs (which exercises it through the full MCP
// tool surface) so a failure here points straight at the HTTP client, not the tools.
import { SelfHostedStore } from '../src/self-hosted-store.js';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  -- ' + detail : ''}`); }
}

const calls = [];
const maps = new Map();
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url: String(url), method: opts.method || 'GET' });
  const u = new URL(url);
  const method = opts.method || 'GET';
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

  if (u.pathname === '/api/maps' && method === 'GET') {
    return json(200, [...maps.values()].map(m => ({ id: m.id, title: m.title, color: m.color, updated: m.updated })));
  }
  const m = u.pathname.match(/^\/api\/maps\/([\w-]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'GET') { const map = maps.get(id); return map ? json(200, map) : json(404, { error: 'not found' }); }
    if (method === 'PUT') { const body = JSON.parse(opts.body); body.id = id; maps.set(id, body); return json(200, { ok: true, id }); }
    if (method === 'DELETE') { maps.delete(id); return { ok: true, status: 204, json: async () => ({}), text: async () => '' }; }
  }
  throw new Error('unhandled: ' + method + ' ' + url);
};

console.log('=== constructor ===');
let threw = false;
try { new SelfHostedStore({}); } catch (e) { threw = true; }
check('throws without baseUrl', threw);

const store = new SelfHostedStore({ baseUrl: 'http://example.test:3000/' });
check('trims trailing slash from baseUrl', store.baseUrl === 'http://example.test:3000');

console.log('\n=== listMaps (empty) ===');
let list = await store.listMaps();
check('returns empty array', Array.isArray(list) && list.length === 0, JSON.stringify(list));

console.log('\n=== getMap (missing) ===');
let map = await store.getMap('nope');
check('returns null for 404', map === null);

console.log('\n=== saveMap (create via PUT) ===');
const saved = await store.saveMap({ id: 'm1', title: 'Test Map', rootId: 'r1', nodes: { r1: { id: 'r1', text: 'Root', parent: null } } });
check('sets updated timestamp', typeof saved.updated === 'number' && saved.updated > 0);
check('used PUT, not POST', calls.some(c => c.method === 'PUT' && c.url.endsWith('/api/maps/m1')), JSON.stringify(calls));

console.log('\n=== getMap (after save) ===');
map = await store.getMap('m1');
check('round-trips the saved map', map && map.title === 'Test Map', JSON.stringify(map));

console.log('\n=== listMaps (after save) ===');
list = await store.listMaps();
check('index reflects the saved map', list.length === 1 && list[0].id === 'm1', JSON.stringify(list));

console.log('\n=== saveMap (update via PUT, same call shape as create) ===');
saved.title = 'Renamed';
await store.saveMap(saved);
map = await store.getMap('m1');
check('update applied', map.title === 'Renamed', JSON.stringify(map));

console.log('\n=== deleteMap ===');
await store.deleteMap('m1');
map = await store.getMap('m1');
check('map gone after delete', map === null);
list = await store.listMaps();
check('index no longer lists it', list.length === 0, JSON.stringify(list));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
