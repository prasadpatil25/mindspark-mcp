import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { GitHubStore } from '../src/github-store.js';
import { decodeShareToken } from '../src/share-link.js';

const fakeRepo = { files: new Map(), shaCounter: 0 };
function nextSha() { return 'sha' + (++fakeRepo.shaCounter); }
function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url); const method = opts.method || 'GET';
  const j = (status, body) => ({ ok: status>=200&&status<300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.pathname === '/user') return j(200, { login: 'testuser' });
  if (/\/repos\/testuser\/mindspark-maps$/.test(u.pathname)) return j(200, {});
  const m = u.pathname.match(/\/repos\/testuser\/mindspark-maps\/contents\/(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    if (method === 'GET') {
      const f = fakeRepo.files.get(path);
      if (!f) return j(404, {});
      return j(200, { content: b64(f.content), sha: f.sha, encoding: 'base64' });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const sha = nextSha();
      fakeRepo.files.set(path, { content: Buffer.from(body.content, 'base64').toString('utf8'), sha });
      return j(200, { content: { sha } });
    }
  }
  throw new Error('unhandled mock fetch: ' + method + ' ' + url);
};

const store = new GitHubStore({ token: 'fake-token', repo: 'mindspark-maps' });
const server = await createServer(store, { appUrl: 'https://mymindspark.example.com/' });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'widget-test-client', version: '1.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail).slice(0,200) : ''}`); } }

console.log('=== Widget resource is discoverable ===');
const resources = await client.listResources();
const widgetResource = resources.resources.find(r => r.uri === 'ui://widget/mindmap.html');
check('widget resource is listed', !!widgetResource, resources.resources.map(r=>r.uri));
check('has the MCP Apps mime type', widgetResource?.mimeType === 'text/html;profile=mcp-app');

console.log('\n=== Widget resource reads back real, complete HTML ===');
const read = await client.readResource({ uri: 'ui://widget/mindmap.html' });
const html = read.contents[0].text;
check('got HTML content back (as a fragment, not a full document)', html.includes('<div id="widget-root">') && html.includes('</script>'));
check('contains the layout function (not just a stub)', html.includes('function layoutTree'));
check('contains the render function (not just a stub)', html.includes('function renderMindMapSVG'));
check('contains the MCP Apps bridge wiring', html.includes('ui/notifications/tool-result') || html.includes('ui/initialize'));

console.log('\n=== Resource carries CSP/domain metadata (fixes ChatGPT dev-mode warning) ===');
const contentMeta = read.contents[0]._meta;
check('resource _meta is present at all', !!contentMeta, read.contents[0]);
check('standard ui.csp key present with empty (fully self-contained widget) domain lists', Array.isArray(contentMeta?.ui?.csp?.connectDomains) && Array.isArray(contentMeta?.ui?.csp?.resourceDomains));
check('legacy openai/widgetCSP compat key also present', !!contentMeta?.['openai/widgetCSP']);
check('openai/widgetDomain is set', typeof contentMeta?.['openai/widgetDomain'] === 'string' && contentMeta['openai/widgetDomain'].length > 0);
check('CSP redirectDomains includes the configured app URL\'s origin (needed for the "open in MindSpark" link to be allowed to navigate there)', contentMeta?.ui?.csp?.redirectDomains?.includes('https://mymindspark.example.com'), contentMeta?.ui?.csp);
check('legacy redirect_domains compat field also includes it', contentMeta?.['openai/widgetCSP']?.redirect_domains?.includes('https://mymindspark.example.com'));
const renderMapTool = (await client.listTools()).tools.find(t => t.name === 'render_map');
check('CSP/domain metadata is NOT also duplicated onto the tool (correctly scoped to the resource only)', !renderMapTool?._meta?.ui?.csp && !renderMapTool?._meta?.['openai/widgetCSP']);

console.log('\n=== render_map tool is registered with the correct widget metadata ===');
const tools = await client.listTools();
const renderMap = tools.tools.find(t => t.name === 'render_map');
check('render_map tool exists', !!renderMap);
check('has openai/outputTemplate pointing at the widget', renderMap?._meta?.['openai/outputTemplate'] === 'ui://widget/mindmap.html', renderMap?._meta);
check('has ui.resourceUri for portable MCP Apps hosts', renderMap?._meta?.ui?.resourceUri === 'ui://widget/mindmap.html');
check('has openai/widgetAccessible: true (confirmed required by multiple independent working examples)', renderMap?._meta?.['openai/widgetAccessible'] === true, renderMap?._meta);
check('has openai/resultCanProduceWidget: true', renderMap?._meta?.['openai/resultCanProduceWidget'] === true, renderMap?._meta);
check('get_map does NOT carry widget metadata (stays a plain data tool)', !tools.tools.find(t => t.name === 'get_map')?._meta?.['openai/outputTemplate']);

console.log('\n=== Calling render_map returns structuredContent the widget can actually consume ===');
let res = await client.callTool({ name: 'create_map', arguments: { outline: '# Quarterly Plan\n## Marketing\n- Campaign launch\n- Budget review\n## Engineering\n- Migration\n- Bug bash' } });
const mapId = res.content[0].text.match(/\[id: (\w+)\]/)[1];

console.log('\n=== create_map sets _import so the real app auto-layouts on first open (fixes real overlap bug) ===');
{
  const storedRaw = fakeRepo.files.get(`maps/${mapId}.json`);
  const storedMap = JSON.parse(storedRaw.content);
  check('created map has no x/y on its nodes (confirms the bug this fixes is real)', storedMap.nodes[Object.keys(storedMap.nodes)[1]].x === undefined);
  check('created map sets _import:true so app.js runs autoLayout() on first open', storedMap._import === true, storedMap._import);
}

res = await client.callTool({ name: 'render_map', arguments: { id: mapId } });
check('did not error', !res.isError, res.content?.[0]?.text);
check('has a short text summary for the model to narrate', res.content[0].text.includes('Quarterly Plan'));
check('structuredContent has rootId', !!res.structuredContent?.rootId);
check('structuredContent has nodes', !!res.structuredContent?.nodes);
check('structuredContent nodes have the shape web/render-svg.mjs expects (text, parent)', (() => {
  const nodes = res.structuredContent.nodes;
  const rootId = res.structuredContent.rootId;
  return Object.values(nodes).every(n => 'text' in n && 'parent' in n) && nodes[rootId];
})());
check('result carries the same widget _meta as the tool registration', res._meta?.['openai/outputTemplate'] === 'ui://widget/mindmap.html');
check('structuredContent carries the configured appUrl through, for the widget\'s "open in MindSpark" link', res.structuredContent?.appUrl === 'https://mymindspark.example.com', res.structuredContent?.appUrl);
check('structuredContent carries the map id (needed to build the deep link)', res.structuredContent?.id === mapId, res.structuredContent?.id);
check('structuredContent nodes carry a collapsed flag (so the widget can seed its initial fold state)', Object.values(res.structuredContent.nodes).every(n => typeof n.collapsed === 'boolean'));

console.log('\n=== render_map now produces a universally-viewable share link, not just a login-gated deep link ===');
{
  // "Open in MindSpark" should work for anyone the link is shared with, not just
  // the same GitHub identity that owns the map — that means the same "#view="
  // encoding the no-login server uses, not a "?map=<id>" link that only resolves
  // for someone already signed in as this exact user.
  check('structuredContent carries a shareUrl', typeof res.structuredContent?.shareUrl === 'string' && res.structuredContent.shareUrl.length > 0, res.structuredContent?.shareUrl);
  check('shareUrl uses the "#view=" format, not "?map="', res.structuredContent.shareUrl.includes('#view=') && !res.structuredContent.shareUrl.includes('?map='), res.structuredContent.shareUrl);

  const hashPart = '#' + res.structuredContent.shareUrl.split('#')[1];
  const appJsDetectionRegex = /^#view=(.+)$/;   // copied verbatim from public/app.js's tryEnterSharedView()
  const match = hashPart.match(appJsDetectionRegex);
  check('the share link\'s hash fragment matches app.js\'s own shared-view detection regex exactly', !!match, hashPart.slice(0, 60));

  const decoded = await decodeShareToken(match[1]);
  check('the token decodes back to the real map (same title)', decoded.title === 'Quarterly Plan', decoded.title);
  check('the token decodes back to the real map (same node count)', Object.keys(decoded.nodes).length === Object.keys(res.structuredContent.nodes).length);
}

console.log('\n=== add_node with listType and task threads through to the widget correctly ===');
{
  const rootId = res.structuredContent.rootId;
  let addRes = await client.callTool({ name: 'add_node', arguments: { mapId, parentId: rootId, text: 'Ship v2\nFix bugs', listType: 'ul' } });
  check('add_node with listType did not error', !addRes.isError, addRes.content?.[0]?.text);
  const bulletId = addRes.content[0].text.match(/\[id: (\w+)\]/)[1];

  addRes = await client.callTool({ name: 'add_node', arguments: { mapId, parentId: rootId, text: 'Finish the report', task: 'doing' } });
  check('add_node with task did not error', !addRes.isError, addRes.content?.[0]?.text);
  const taskId = addRes.content[0].text.match(/\[id: (\w+)\]/)[1];

  const rendered = await client.callTool({ name: 'render_map', arguments: { id: mapId } });
  check('listType survived the round trip to the widget payload', rendered.structuredContent.nodes[bulletId]?.listType === 'ul', rendered.structuredContent.nodes[bulletId]);
  check('task survived the round trip to the widget payload', rendered.structuredContent.nodes[taskId]?.task === 'doing', rendered.structuredContent.nodes[taskId]);

  const updateRes = await client.callTool({ name: 'update_node', arguments: { mapId, nodeId: taskId, task: 'done' } });
  check('update_node can change task status', !updateRes.isError);
  const rendered2 = await client.callTool({ name: 'render_map', arguments: { id: mapId } });
  check('updated task status survived the round trip', rendered2.structuredContent.nodes[taskId]?.task === 'done', rendered2.structuredContent.nodes[taskId]);
}

console.log('\n=== The actual structuredContent returned renders to real SVG (full round trip) ===');
{
  const { renderMindMapSVG } = await import('../web/render-svg.mjs');
  const { svg, nodeCount } = renderMindMapSVG(res.structuredContent.nodes, res.structuredContent.rootId);
  check('produces SVG with all nodes from the real tool call', svg.includes('<svg') && nodeCount === Object.keys(res.structuredContent.nodes).length, nodeCount);
}

console.log('\n=== render_map on an unknown map id fails cleanly ===');
res = await client.callTool({ name: 'render_map', arguments: { id: 'does-not-exist' } });
check('reports isError', res.isError === true);

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
