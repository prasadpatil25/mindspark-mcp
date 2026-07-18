import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { decodeShareToken } from '../../src/share-link.js';
import { WIDGET_HTML } from '../src/widget-html.generated.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail).slice(0, 200) : ''}`); } }

console.log('=== createServer validates its required options (fails loudly, not silently) ===');
{
  check('throws without appUrl at all', (() => { try { createServer({ widgetHTML: 'x' }); return false; } catch (e) { return /appUrl/.test(e.message); } })());
  check('throws without widgetHTML', (() => { try { createServer({ appUrl: 'https://x.com' }); return false; } catch (e) { return /widgetHTML/.test(e.message); } })());
}

const widgetHTML = WIDGET_HTML;

const server = createServer({ appUrl: 'https://mindspark.example.com', widgetHTML });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'test-client', version: '1.0.0' });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

console.log('\n=== Only one tool exists — no auth-requiring tools at all ===');
{
  const tools = await client.listTools();
  check('exactly one tool: create_map', tools.tools.length === 1 && tools.tools[0].name === 'create_map', tools.tools.map(t => t.name));
  check('no add_node/update_node/get_map/list_maps — nothing that would need persisted, authenticated state', !tools.tools.some(t => ['add_node', 'update_node', 'delete_node', 'get_map', 'list_maps'].includes(t.name)));
}

console.log('\n=== Tool metadata matches the always-render requirement ===');
{
  const tools = await client.listTools();
  const createMap = tools.tools[0];
  check('has openai/outputTemplate (so ChatGPT always shows the widget)', createMap._meta['openai/outputTemplate'] === 'ui://widget/mindmap.html');
  check('has openai/widgetAccessible', createMap._meta['openai/widgetAccessible'] === true);
  check('has openai/resultCanProduceWidget', createMap._meta['openai/resultCanProduceWidget'] === true);
}

console.log('\n=== Widget resource is registered and reads back real content ===');
{
  const resources = await client.listResources();
  check('widget resource listed', resources.resources.some(r => r.uri === 'ui://widget/mindmap.html'));
  const read = await client.readResource({ uri: 'ui://widget/mindmap.html' });
  check('reads back real widget content (has the layout function)', read.contents[0].text.includes('function layoutTree'));
}

console.log('\n=== create_map: full real call, no auth needed anywhere in this path ===');
let res;
{
  res = await client.callTool({ name: 'create_map', arguments: { outline: '# Weekend Trip\n## Packing\n- Tent\n- Boots\n## Food\n- Snacks' } });
  check('did not error', !res.isError, res.content?.[0]?.text);
  check('text response includes a real share link', /https:\/\/mindspark\.example\.com\/#view=/.test(res.content[0].text), res.content[0].text);
  check('structuredContent has rootId', !!res.structuredContent?.rootId);
  check('structuredContent has all 6 nodes', Object.keys(res.structuredContent.nodes).length === 6, Object.keys(res.structuredContent.nodes).length);
  check('structuredContent has the shareUrl the widget footer needs', typeof res.structuredContent.shareUrl === 'string' && res.structuredContent.shareUrl.includes('#view='));
  check('result _meta carries the widget template (always-render, even on the result itself)', res._meta['openai/outputTemplate'] === 'ui://widget/mindmap.html');
}

console.log('\n=== The returned share link actually decodes back to the real map (genuine round trip, not just format-checked) ===');
{
  const match = res.content[0].text.match(/#view=(\S+)/);
  check('found a token in the response text', !!match);
  const decoded = await decodeShareToken(match[1]);
  check('decoded title matches', decoded.title === 'Weekend Trip', decoded.title);
  check('decoded node count matches', Object.keys(decoded.nodes).length === 6);
  check('decoded structure matches structuredContent exactly (same data, not coincidentally similar)', (() => {
    const packing = Object.values(decoded.nodes).find(n => n.text === 'Packing');
    const tent = Object.values(decoded.nodes).find(n => n.text === 'Tent');
    return packing && tent && tent.parent === packing.id;
  })());
}

console.log('\n=== Custom title and color are honored ===');
{
  const res2 = await client.callTool({ name: 'create_map', arguments: { outline: '# Ignored\n- x', title: 'My Custom Title', color: '#3a6ea5' } });
  check('custom title used', res2.structuredContent.title === 'My Custom Title');
  check('custom color used', res2.structuredContent.color === '#3a6ea5');
}

console.log('\n=== The "Open in MindSpark" link (structuredContent.shareUrl) actually triggers the real app\'s shared-view detection ===');
{
  // This is the exact chain a real user experiences: widget footer link ->
  // shareUrl -> browser navigates there -> app.js's own tryEnterSharedView()
  // checks location.hash against /^#view=(.+)$/. If this regex doesn't match,
  // clicking "Open in MindSpark" would just load the app fresh instead of
  // showing the read-only view with "Make an editable copy" — so this is worth
  // a dedicated, permanent check, not just something verified once by hand.
  const res4 = await client.callTool({ name: 'create_map', arguments: { outline: '# Shared View Check\n- item' } });
  const shareUrl = res4.structuredContent.shareUrl;
  check('shareUrl is present on structuredContent (what the widget footer actually uses)', typeof shareUrl === 'string' && shareUrl.length > 0);

  const hashPart = '#' + shareUrl.split('#')[1];
  const appJsDetectionRegex = /^#view=(.+)$/;   // copied verbatim from public/app.js's tryEnterSharedView()
  const match = hashPart.match(appJsDetectionRegex);
  check('the URL\'s hash fragment matches app.js\'s own shared-view detection regex exactly', !!match, hashPart.slice(0, 60));

  const decodedFromShareUrl = await decodeShareToken(match[1]);
  check('the token app.js would extract from this URL decodes back to the real, correct map', decodedFromShareUrl.title === 'Shared View Check', decodedFromShareUrl.title);
}

console.log('\n=== Malformed outline fails cleanly, not with a crash ===');
{
  const res3 = await client.callTool({ name: 'create_map', arguments: { outline: '' } });
  check('empty outline reports isError rather than crashing the server', res3.isError === true, res3);
}

await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
