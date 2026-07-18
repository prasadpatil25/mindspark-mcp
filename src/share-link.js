// Builds MindSpark's own "#view=" share-link tokens — byte-for-byte the same
// algorithm as app.js's buildShareLink()/decodeShareToken() (public/app.js, search
// for _gzip/_b64urlFromBytes/_shareePayload), not a reimplementation from
// description. The app's own decoder is what has to open these links, so matching
// its exact behavior — not just "a" working compression scheme — is what matters
// here. Pure Web Standard APIs (CompressionStream, btoa/atob), so this works
// unchanged in Node 18+, Cloudflare Workers, and any other modern JS runtime.

function b64urlFromBytes(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gzip(str) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('gzip');
  const w = cs.writable.getWriter();
  w.write(new TextEncoder().encode(str));
  w.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function gunzip(bytes) {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(bytes);
  w.close();
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

/**
 * @param {{title, color, style, layout, rootId, nodes, links, vars}} map
 * @returns {Promise<string>} the token (WITHOUT the "#view=" prefix or base URL)
 */
export async function buildShareToken(map) {
  const payload = {
    v: 1,
    title: map.title, color: map.color, style: map.style, layout: map.layout,
    rootId: map.rootId, nodes: map.nodes, links: map.links || [], vars: map.vars || {}
  };
  const json = JSON.stringify(payload);
  const gz = await gzip(json);
  return gz ? ('g' + b64urlFromBytes(gz)) : ('r' + b64urlFromBytes(new TextEncoder().encode(json)));
}

/**
 * Test/verification helper — mirrors app.js's decodeShareToken() exactly. Not
 * used by the server at runtime (the real MindSpark app is the one decoding these
 * links), but essential for actually proving round-trip fidelity rather than
 * assuming the encoder is correct because it "looks right."
 */
export async function decodeShareToken(token) {
  const scheme = token[0], body = token.slice(1);
  const bytes = bytesFromB64url(body);
  const json = scheme === 'g' ? await gunzip(bytes) : new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

export function buildShareUrl(baseUrl, token) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return `${base}/#view=${token}`;
}
