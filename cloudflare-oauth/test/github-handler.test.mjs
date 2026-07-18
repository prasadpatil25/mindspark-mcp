import { GitHubHandler } from '../src/github-handler.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

function mockKV() {
  const store = new Map();
  return { async put(k, v, opts) { store.set(k, v); }, async get(k) { return store.has(k) ? store.get(k) : null; }, async delete(k) { store.delete(k); }, _store: store };
}

// Tracks cookies across requests like a real browser's cookie jar would.
class CookieJar {
  constructor() { this.cookies = {}; }
  header() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  absorb(response) {
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : (response.headers.get('Set-Cookie') ? [response.headers.get('Set-Cookie')] : []);
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
      if (sc.includes('Max-Age=0')) delete this.cookies[name];
      else this.cookies[name] = value;
    }
  }
}

function makeEnv({ approvedGrants = new Map() } = {}) {
  const kv = mockKV();
  const clients = new Map([['test-client-id', { clientId: 'test-client-id', clientName: 'Test MCP Client', redirectUris: ['https://chatgpt.com/callback'] }]]);
  let completedAuth = null;
  return {
    env: {
      OAUTH_KV: kv,
      GITHUB_CLIENT_ID: 'fake-gh-client-id',
      GITHUB_CLIENT_SECRET: 'fake-gh-client-secret',
      COOKIE_ENCRYPTION_KEY: 'test-cookie-secret',
      GITHUB_UPSTREAM_AUTHORIZE_URL: 'https://github.test/login/oauth/authorize',
      GITHUB_UPSTREAM_TOKEN_URL: 'https://github.test/login/oauth/access_token',
      GITHUB_USER_API_URL: 'https://api.github.test/user',
      OAUTH_PROVIDER: {
        async parseAuthRequest(request) {
          const url = new URL(request.url);
          return {
            responseType: 'code', clientId: url.searchParams.get('client_id') || 'test-client-id',
            redirectUri: 'https://chatgpt.com/callback', scope: ['mcp'], state: 'client-provided-state'
          };
        },
        async lookupClient(clientId) { return clients.get(clientId) || null; },
        async completeAuthorization(opts) {
          completedAuth = opts;
          return { redirectTo: 'https://chatgpt.com/callback?code=mcp-issued-code&state=client-provided-state' };
        }
      }
    },
    getCompletedAuth: () => completedAuth
  };
}

console.log('=== Full flow: not-yet-approved client goes through consent, GitHub, and completes ===');
{
  const { env, getCompletedAuth } = makeEnv();
  const jar = new CookieJar();

  globalThis.fetch = async (url, opts) => {
    if (url === env.GITHUB_UPSTREAM_TOKEN_URL) {
      const body = JSON.parse(opts.body);
      check('token exchange uses the configured client id/secret', body.client_id === 'fake-gh-client-id' && body.client_secret === 'fake-gh-client-secret');
      return { ok: true, json: async () => ({ access_token: 'gho_faketoken' }) };
    }
    if (url === env.GITHUB_USER_API_URL) return { ok: true, json: async () => ({ login: 'octocat', name: 'The Octocat' }) };
    throw new Error('unexpected fetch: ' + url);
  };

  // Step 1: GET /authorize — not approved yet, expect the consent dialog.
  let req = new Request('https://mcp.example.com/authorize?client_id=test-client-id', { headers: { Cookie: jar.header() } });
  let res = await GitHubHandler.fetch(req, env, {});
  check('GET /authorize (unapproved) returns the consent dialog, not a redirect', res.status === 200);
  jar.absorb(res);
  const html = await res.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const stateMatch = html.match(/name="state" value="([^"]+)"/);
  check('consent page contains a CSRF token', !!csrfMatch);
  check('consent page contains the encoded state', !!stateMatch);
  check('consent page shows the client name', html.includes('Test MCP Client'));

  // Step 2: POST /authorize — submit the consent form, as the browser would.
  const formBody = new URLSearchParams({ csrf_token: csrfMatch[1], state: stateMatch[1] });
  req = new Request('https://mcp.example.com/authorize', {
    method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody.toString()
  });
  res = await GitHubHandler.fetch(req, env, {});
  check('POST /authorize redirects to GitHub', res.status === 302);
  jar.absorb(res);
  const githubLocation = res.headers.get('Location');
  check('redirects to the configured (test) GitHub authorize URL', githubLocation.startsWith(env.GITHUB_UPSTREAM_AUTHORIZE_URL), githubLocation);
  const githubStateParam = new URL(githubLocation).searchParams.get('state');
  check('carries a state parameter to GitHub', !!githubStateParam);

  // Step 3: GET /callback — GitHub redirecting back with a code, same browser (cookie jar).
  req = new Request(`https://mcp.example.com/callback?code=real-github-code&state=${githubStateParam}`, { headers: { Cookie: jar.header() } });
  res = await GitHubHandler.fetch(req, env, {});
  check('callback redirects back to the MCP client\'s own redirect_uri', res.status === 302 && res.headers.get('Location')?.startsWith('https://chatgpt.com/callback'), res.headers.get('Location'));

  const completed = getCompletedAuth();
  check('completeAuthorization was called', !!completed);
  check('props includes the real GitHub access token', completed.props.accessToken === 'gho_faketoken');
  check('props includes the GitHub login', completed.props.login === 'octocat');
  check('userId is set to the GitHub login', completed.userId === 'octocat');
  check('the ORIGINAL client auth request is what gets completed (not something forged mid-flow)', completed.request.clientId === 'test-client-id');
}

console.log('\n=== Already-approved client skips the consent dialog ===');
{
  const { env } = makeEnv();
  globalThis.fetch = async (url) => {
    if (url === env.GITHUB_USER_API_URL) return { ok: true, json: async () => ({ login: 'octocat' }) };
    return { ok: true, json: async () => ({ access_token: 't' }) };
  };
  const jar = new CookieJar();

  // First: go through the full approval flow once to get the approved-clients cookie.
  let req = new Request('https://mcp.example.com/authorize?client_id=test-client-id', { headers: { Cookie: jar.header() } });
  let res = await GitHubHandler.fetch(req, env, {});
  jar.absorb(res);
  const html = await res.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const stateMatch = html.match(/name="state" value="([^"]+)"/);
  const formBody = new URLSearchParams({ csrf_token: csrfMatch[1], state: stateMatch[1] });
  req = new Request('https://mcp.example.com/authorize', { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody.toString() });
  res = await GitHubHandler.fetch(req, env, {});
  jar.absorb(res);

  // Second: a NEW authorize request from the same browser (same cookie jar) should skip straight to GitHub.
  req = new Request('https://mcp.example.com/authorize?client_id=test-client-id', { headers: { Cookie: jar.header() } });
  res = await GitHubHandler.fetch(req, env, {});
  check('second authorize request skips the consent dialog and redirects straight to GitHub', res.status === 302, res.status);
}

console.log('\n=== Security: tampered CSRF token on the consent form is rejected ===');
{
  const { env } = makeEnv();
  const jar = new CookieJar();
  let req = new Request('https://mcp.example.com/authorize?client_id=test-client-id', { headers: { Cookie: jar.header() } });
  let res = await GitHubHandler.fetch(req, env, {});
  jar.absorb(res);
  const html = await res.text();
  const stateMatch = html.match(/name="state" value="([^"]+)"/);
  const formBody = new URLSearchParams({ csrf_token: 'forged-token-not-matching-cookie', state: stateMatch[1] });
  req = new Request('https://mcp.example.com/authorize', { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody.toString() });
  res = await GitHubHandler.fetch(req, env, {});
  check('forged CSRF token is rejected with 403, not silently accepted', res.status === 403, res.status);
}

console.log('\n=== Security: callback with no matching session cookie (the CSRF-on-upstream-flow attack) is rejected ===');
{
  const { env } = makeEnv();
  {
  const req = new Request('https://mcp.example.com/callback?code=x&state=some-random-state-attacker-picked', {});   // no cookies at all
  const res = await GitHubHandler.fetch(req, env, {});
  check('callback with an unbound state is rejected, not processed', res.status === 403 || res.status === 400, res.status);
}
}

console.log('\n=== Regression: POST /authorize response actually carries BOTH cookies, not just one ===');
{
  const { env } = makeEnv();
  const jar = new CookieJar();
  let req = new Request('https://mcp.example.com/authorize?client_id=test-client-id', { headers: { Cookie: jar.header() } });
  let res = await GitHubHandler.fetch(req, env, {});
  jar.absorb(res);
  const html = await res.text();
  const csrfMatch = html.match(/name="csrf_token" value="([^"]+)"/);
  const stateMatch = html.match(/name="state" value="([^"]+)"/);
  const formBody = new URLSearchParams({ csrf_token: csrfMatch[1], state: stateMatch[1] });
  req = new Request('https://mcp.example.com/authorize', { method: 'POST', headers: { Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: formBody.toString() });
  res = await GitHubHandler.fetch(req, env, {});
  const setCookies = res.headers.getSetCookie();
  check('exactly two Set-Cookie headers present (not collapsed to one)', setCookies.length === 2, setCookies);
  check('the approved-clients cookie is one of them', setCookies.some(c => c.startsWith('mcp_approved_clients=')), setCookies);
  check('the session-binding state cookie is the other', setCookies.some(c => c.includes('mcp_oauth_state=')), setCookies);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
