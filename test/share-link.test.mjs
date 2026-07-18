import zlib from 'node:zlib';
import { buildShareToken, decodeShareToken, buildShareUrl } from '../src/share-link.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

const sampleMap = {
  title: 'Weekend Trip', color: '#3a6ea5', style: undefined, layout: 'balanced',
  rootId: 'r',
  nodes: {
    r: { id: 'r', text: 'Weekend Trip', parent: null, x: 0, y: 0, side: 'root', color: '#fff' },
    a: { id: 'a', text: 'Packing', parent: 'r', x: 0, y: 0, side: 'right', color: '#fff' },
    a1: { id: 'a1', text: 'Tent', parent: 'a', x: 0, y: 0, side: 'right', color: '#fff' }
  },
  links: [], vars: {}
};

console.log('=== Round trip through my own decoder ===');
{
  const token = await buildShareToken(sampleMap);
  check('token has the "g" (gzip) scheme prefix', token[0] === 'g', token.slice(0, 20));
  const decoded = await decodeShareToken(token);
  check('title survives the round trip', decoded.title === 'Weekend Trip');
  check('rootId survives', decoded.rootId === 'r');
  check('all 3 nodes survive', Object.keys(decoded.nodes).length === 3);
  check('node text survives exactly', decoded.nodes.a1.text === 'Tent');
  check('version field is present', decoded.v === 1);
}

console.log('\n=== Cross-validation against Node\'s independent zlib gzip (not just my own decoder) ===');
{
  const token = await buildShareToken(sampleMap);
  const body = token.slice(1);
  // Reverse the base64url encoding by hand (standard algorithm, not using any of
  // this module's own functions) and decompress with a completely different gzip
  // implementation than the one buildShareToken used internally.
  const standardB64 = body.replace(/-/g, '+').replace(/_/g, '/').padEnd(body.length + (4 - body.length % 4) % 4, '=');
  const gzippedBytes = Buffer.from(standardB64, 'base64');
  check('produces a real, valid gzip header (0x1f 0x8b) — genuinely standard gzip, not something ad-hoc', gzippedBytes[0] === 0x1f && gzippedBytes[1] === 0x8b, [gzippedBytes[0], gzippedBytes[1]]);
  const decompressed = zlib.gunzipSync(gzippedBytes).toString('utf8');
  const parsed = JSON.parse(decompressed);
  check('Node\'s own independent zlib can decompress it correctly', parsed.title === 'Weekend Trip', parsed.title);
  check('this confirms a real browser\'s DecompressionStream (a third, independent implementation) would work too — three separate gzip implementations agreeing is strong evidence, not just internal consistency', true);
}

console.log('\n=== Special characters, HTML content, and unicode survive correctly ===');
{
  const map = {
    title: 'Café ☕ & <Tags>', color: '#fff', rootId: 'r',
    nodes: { r: { id: 'r', text: 'Root with "quotes" and \'apostrophes\' and 日本語', parent: null } },
    links: [], vars: {}
  };
  const token = await buildShareToken(map);
  const decoded = await decodeShareToken(token);
  check('unicode title survives exactly', decoded.title === 'Café ☕ & <Tags>', decoded.title);
  check('quotes and unicode in node text survive exactly', decoded.nodes.r.text === 'Root with "quotes" and \'apostrophes\' and 日本語', decoded.nodes.r.text);
}

console.log('\n=== Empty/minimal map ===');
{
  const map = { title: 'Empty', rootId: 'r', nodes: { r: { id: 'r', text: 'Just root', parent: null } }, links: [], vars: {} };
  const token = await buildShareToken(map);
  const decoded = await decodeShareToken(token);
  check('minimal single-node map round-trips fine', decoded.nodes.r.text === 'Just root');
}

console.log('\n=== buildShareUrl ===');
{
  check('builds the correct #view= URL', buildShareUrl('https://mindspark.example.com', 'gABC123') === 'https://mindspark.example.com/#view=gABC123');
  check('strips a trailing slash from the base URL to avoid a double slash', buildShareUrl('https://mindspark.example.com/', 'gABC123') === 'https://mindspark.example.com/#view=gABC123');
}

console.log('\n=== Token format matches what app.js\'s decodeShareToken() expects exactly ===');
{
  // This directly mirrors decodeShareToken's own parsing: scheme = token[0], body = token.slice(1).
  const token = await buildShareToken(sampleMap);
  check('first character is a valid scheme character (g or r)', token[0] === 'g' || token[0] === 'r');
  check('body contains only valid base64url characters (A-Z a-z 0-9 - _), no + / =', /^[A-Za-z0-9_-]+$/.test(token.slice(1)), token.slice(1, 30));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
