// Security core for the GitHub-backed OAuth flow. Two distinct protections here,
// both necessary and serving different purposes:
//
// 1. CSRF token on the consent form — a short-lived, single-use token proving the
//    approval POST came from a form this server actually rendered, not a
//    cross-site forged request.
// 2. Session-bound OAuth state — proves the browser completing the GitHub
//    callback is the SAME browser that started the flow. Without this, an
//    attacker could start their own OAuth flow, capture the resulting `state`
//    value, then trick a victim into visiting a callback URL carrying the
//    attacker's state — binding the victim's GitHub-authenticated session to
//    the attacker's MCP client registration (the "confused deputy" problem).
//    The state token is stored both in KV (server-side truth) and in an
//    HttpOnly cookie set on the initiating browser; the callback is only
//    accepted if BOTH agree.
//
// Pure-ish functions (only dependency is the Web Crypto API, available in both
// Node 18+ and the Workers runtime) — testable without a real Worker.

const APPROVED_CLIENTS_COOKIE = 'mcp_approved_clients';
const CSRF_COOKIE = 'mcp_csrf';
const STATE_COOKIE = 'mcp_oauth_state';
const CSRF_TTL_SECONDS = 600;       // 10 minutes — just long enough to submit the consent form
const STATE_TTL_SECONDS = 600;
const APPROVED_TTL_SECONDS = 60 * 60 * 24 * 365;   // 1 year — "don't ask again" for this client

export class OAuthError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OAuthError';
    this.statusCode = statusCode;
  }
  toResponse() {
    return new Response(this.message, { status: this.statusCode });
  }
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function cookieAttrs(maxAge) {
  // __Host- prefix (used below) requires Secure, Path=/, and no Domain — the
  // browser refuses to set the cookie otherwise, which is exactly the extra
  // enforcement wanted here. SameSite=Lax rather than Strict: the state cookie
  // must still be sent on the top-level GET redirect back from GitHub, which
  // Strict would block.
  return `Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function hmac(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// --- CSRF protection for the consent form ---

export function generateCSRFProtection() {
  const token = crypto.randomUUID();
  return { token, setCookie: `__Host-${CSRF_COOKIE}=${token}; ${cookieAttrs(CSRF_TTL_SECONDS)}` };
}

export function validateCSRFToken(formToken, request) {
  const cookies = parseCookies(request);
  const cookieToken = cookies[`__Host-${CSRF_COOKIE}`];
  if (!formToken || !cookieToken || formToken !== cookieToken) {
    throw new OAuthError('Invalid or missing CSRF token — please retry from the authorization link', 403);
  }
}

// --- "Already approved this client" — signed, long-lived cookie ---

export async function isClientApproved(request, clientId, secret) {
  const cookies = parseCookies(request);
  const raw = cookies[APPROVED_CLIENTS_COOKIE];
  if (!raw) return false;
  try {
    const [payload, sig] = raw.split('.');
    if (!payload || !sig) return false;
    const expected = await hmac(secret, payload);
    if (!(await timingSafeEqual(sig, expected))) return false;
    const ids = JSON.parse(atob(payload));
    return Array.isArray(ids) && ids.includes(clientId);
  } catch (e) { return false; }
}

export async function addApprovedClient(request, clientId, secret) {
  const cookies = parseCookies(request);
  const raw = cookies[APPROVED_CLIENTS_COOKIE];
  let ids = [];
  if (raw) {
    try {
      const [payload, sig] = raw.split('.');
      if (payload && sig && (await timingSafeEqual(sig, await hmac(secret, payload)))) {
        const parsed = JSON.parse(atob(payload));
        if (Array.isArray(parsed)) ids = parsed;
      }
    } catch (e) { /* corrupt/tampered cookie — start fresh rather than fail closed here */ }
  }
  if (!ids.includes(clientId)) ids.push(clientId);
  const payload = btoa(JSON.stringify(ids));
  const sig = await hmac(secret, payload);
  return `${APPROVED_CLIENTS_COOKIE}=${payload}.${sig}; ${cookieAttrs(APPROVED_TTL_SECONDS)}`;
}

// --- Session-bound OAuth state (the core CSRF-on-the-upstream-flow protection) ---

export async function createOAuthState(oauthReqInfo, kv) {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth_state:${stateToken}`, JSON.stringify({ oauthReqInfo, createdAt: Date.now() }), { expirationTtl: STATE_TTL_SECONDS });
  return { stateToken };
}

export function bindStateToSession(stateToken) {
  return { setCookie: `__Host-${STATE_COOKIE}=${stateToken}; ${cookieAttrs(STATE_TTL_SECONDS)}` };
}

export async function validateOAuthState(request, kv) {
  const url = new URL(request.url);
  const stateToken = url.searchParams.get('state');
  if (!stateToken) throw new OAuthError('Missing state parameter');

  const cookies = parseCookies(request);
  const sessionState = cookies[`__Host-${STATE_COOKIE}`];
  if (!sessionState || sessionState !== stateToken) {
    throw new OAuthError('State mismatch — this looks like it did not originate from your own browser session (possible CSRF attempt)', 403);
  }

  const stored = await kv.get(`oauth_state:${stateToken}`);
  if (!stored) throw new OAuthError('State expired or already used — please restart the authorization flow', 400);
  await kv.delete(`oauth_state:${stateToken}`);   // single-use

  const { oauthReqInfo } = JSON.parse(stored);
  const clearCookie = `__Host-${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  return { oauthReqInfo, clearCookie };
}

// --- Consent screen ---

const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderApprovalDialog(request, { client, server, state, csrfToken, setCookie }) {
  const encodedState = btoa(JSON.stringify(state));
  const clientName = escapeHtml(client?.clientName || client?.clientId || 'This application');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Authorize ${clientName}</title>
<style>
  body{font-family:ui-sans-serif,system-ui,sans-serif;max-width:440px;margin:60px auto;padding:0 20px;color:#20242e}
  .card{border:1px solid #e2e5eb;border-radius:12px;padding:28px}
  h1{font-size:18px;margin:0 0 4px}
  .sub{color:#6b7280;font-size:14px;margin:0 0 20px}
  .server{display:flex;align-items:center;gap:10px;margin-bottom:20px;padding:12px;background:#f7f8fa;border-radius:8px}
  .server img{width:32px;height:32px;border-radius:6px}
  button{width:100%;padding:11px;border-radius:8px;border:none;background:#e0613a;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#c8502d}
  .fine{font-size:12px;color:#9aa0ab;margin-top:14px;text-align:center}
</style></head><body>
<div class="card">
  <h1>Authorize ${clientName}</h1>
  <p class="sub">This will let it read and edit your MindSpark mind maps via your GitHub account.</p>
  ${server?.name ? `<div class="server">${server.logo ? `<img src="${escapeHtml(server.logo)}" alt="">` : ''}<div><strong>${escapeHtml(server.name)}</strong>${server.description ? `<div style="font-size:13px;color:#6b7280">${escapeHtml(server.description)}</div>` : ''}</div></div>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
    <input type="hidden" name="state" value="${escapeHtml(encodedState)}">
    <button type="submit">Authorize with GitHub</button>
  </form>
  <p class="fine">You'll be redirected to GitHub to sign in, then back here.</p>
</div>
</body></html>`;
  const headers = { 'Content-Type': 'text/html; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  return new Response(html, { status: 200, headers });
}
