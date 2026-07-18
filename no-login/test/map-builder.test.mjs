import { buildShareableMap } from '../src/map-builder.js';
import { buildShareToken, decodeShareToken } from '../../src/share-link.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

console.log('=== buildShareableMap: basic shape ===');
{
  const map = buildShareableMap('# Weekend Trip\n## Packing\n- Tent\n- Boots');
  check('has an id', typeof map.id === 'string' && map.id.length > 0);
  check('has the correct title from the outline', map.title === 'Weekend Trip');
  check('has a rootId matching a real node', !!map.nodes[map.rootId]);
  check('has all 4 nodes (root, Packing, Tent, Boots)', Object.keys(map.nodes).length === 4);
  check('defaults to the standard map color', map.color === '#e0613a');
  check('layout is "balanced" (matches what a fresh app-created map would have)', map.layout === 'balanced');
  check('links defaults to empty array', Array.isArray(map.links) && map.links.length === 0);
  check('vars defaults to empty object', typeof map.vars === 'object' && Object.keys(map.vars).length === 0);
  check('non-root nodes have no x/y/side set (left for the app\'s own autoLayout to compute)', (() => {
    const nonRoot = Object.values(map.nodes).find(n => n.id !== map.rootId);
    return nonRoot.x === undefined && nonRoot.side === undefined;
  })());
}

console.log('\n=== buildShareableMap: custom color and title override ===');
{
  const map = buildShareableMap('# Ignored\n- item', { title: 'Custom Title', color: '#3a6ea5' });
  check('title override applied', map.title === 'Custom Title');
  check('custom color applied instead of the default', map.color === '#3a6ea5');
}

console.log('\n=== Full pipeline: outline -> map -> share token -> decode -> matches original ===');
{
  const outline = '# Product Launch\n## Marketing\n- Landing page\n- Email campaign\n## Engineering\n- API work\n- Load testing';
  const map = buildShareableMap(outline);
  const token = await buildShareToken(map);
  const decoded = await decodeShareToken(token);

  check('title survives the full pipeline', decoded.title === 'Product Launch');
  check('rootId survives', decoded.rootId === map.rootId);
  check('all 7 nodes survive', Object.keys(decoded.nodes).length === 7, Object.keys(decoded.nodes).length);
  check('parent/child relationships survive intact', (() => {
    const marketing = Object.values(decoded.nodes).find(n => n.text === 'Marketing');
    const landingPage = Object.values(decoded.nodes).find(n => n.text === 'Landing page');
    return marketing && landingPage && landingPage.parent === marketing.id;
  })());
  check('color survives', decoded.color === '#e0613a');
  check('layout field survives', decoded.layout === 'balanced');
}

console.log('\n=== Full pipeline: deep nesting and many nodes ===');
{
  let outline = '# Big Map\n';
  for (let i = 0; i < 5; i++) {
    outline += `## Section ${i}\n`;
    for (let j = 0; j < 4; j++) outline += `- Item ${i}.${j}\n`;
  }
  const map = buildShareableMap(outline);
  const token = await buildShareToken(map);
  const decoded = await decodeShareToken(token);
  check('all 26 nodes survive a larger map (1 root + 5 sections + 20 items)', Object.keys(decoded.nodes).length === 26, Object.keys(decoded.nodes).length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
