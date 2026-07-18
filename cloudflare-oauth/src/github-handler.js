import {
  generateCSRFProtection, validateCSRFToken,
  isClientApproved, addApprovedClient,
  createOAuthState, bindStateToSession, validateOAuthState,
  renderApprovalDialog, OAuthError
} from './oauth-utils.js';
import { getUpstreamAuthorizeUrl, fetchUpstreamAuthToken, fetchGitHubUser } from './github-oauth.js';

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

async function redirectToGithub(request, env, stateToken, extraHeaders = []) {
  const location = getUpstreamAuthorizeUrl({
    upstreamUrl: env.GITHUB_UPSTREAM_AUTHORIZE_URL || GITHUB_AUTHORIZE_URL,   // overridable for tests
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri: new URL('/callback', request.url).href,
    scope: 'read:user',
    state: stateToken
  });
  const headers = new Headers();
  // Accept a Headers object, a plain array of [key, value] pairs, or a plain
  // object — iterating with .entries()/Object.entries() rather than spreading
  // into a plain object, since a plain object can't hold two Set-Cookie keys
  // at once (an earlier version of this code lost the approved-clients cookie
  // exactly this way whenever it needed to be set alongside the session cookie).
  const pairs = extraHeaders instanceof Headers ? [...extraHeaders.entries()]
    : Array.isArray(extraHeaders) ? extraHeaders
    : Object.entries(extraHeaders);
  for (const [key, value] of pairs) headers.append(key, value);
  headers.set('Location', location);
  return new Response(null, { status: 302, headers });
}

async function handleAuthorizeGet(request, env) {
  let oauthReqInfo;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    console.error('parseAuthRequest error:', e);
    return new Response('Invalid authorization request: ' + e.message, { status: 400 });
  }
  if (!oauthReqInfo.clientId) return new Response('Invalid request: missing client_id', { status: 400 });

  if (await isClientApproved(request, oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY)) {
    // Already consented from this browser before — skip the dialog, but still
    // mint a fresh, session-bound state token for this specific flow.
    const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
    const { setCookie } = bindStateToSession(stateToken);
    return redirectToGithub(request, env, stateToken, { 'Set-Cookie': setCookie });
  }

  const { token: csrfToken, setCookie: csrfCookie } = generateCSRFProtection();
  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  return renderApprovalDialog(request, {
    client,
    server: { name: 'MindSpark', description: 'Read and edit your MindSpark mind maps via your GitHub account.' },
    state: { oauthReqInfo },
    csrfToken,
    setCookie: csrfCookie
  });
}

async function handleAuthorizePost(request, env) {
  try {
    const formData = await request.formData();
    validateCSRFToken(formData.get('csrf_token'), request);

    const encodedState = formData.get('state');
    if (!encodedState || typeof encodedState !== 'string') return new Response('Missing state in form data', { status: 400 });
    let state;
    try { state = JSON.parse(atob(encodedState)); }
    catch (e) { return new Response('Invalid state data', { status: 400 }); }
    if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) return new Response('Invalid request', { status: 400 });

    const approvedCookie = await addApprovedClient(request, state.oauthReqInfo.clientId, env.COOKIE_ENCRYPTION_KEY);
    const { stateToken } = await createOAuthState(state.oauthReqInfo, env.OAUTH_KV);
    const { setCookie: sessionCookie } = bindStateToSession(stateToken);

    const headers = new Headers();
    headers.append('Set-Cookie', approvedCookie);
    headers.append('Set-Cookie', sessionCookie);
    return redirectToGithub(request, env, stateToken, headers);
  } catch (e) {
    if (e instanceof OAuthError) return e.toResponse();
    console.error('POST /authorize error:', e);
    return new Response('Internal server error', { status: 500 });
  }
}

async function handleCallback(request, env) {
  let oauthReqInfo, clearSessionCookie;
  try {
    const result = await validateOAuthState(request, env.OAUTH_KV);
    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (e) {
    if (e instanceof OAuthError) return e.toResponse();
    console.error('GET /callback state validation error:', e);
    return new Response('Internal server error', { status: 500 });
  }
  if (!oauthReqInfo.clientId) return new Response('Invalid OAuth request data', { status: 400 });

  const url = new URL(request.url);
  const [accessToken, errResponse] = await fetchUpstreamAuthToken({
    upstreamUrl: env.GITHUB_UPSTREAM_TOKEN_URL || GITHUB_TOKEN_URL,   // overridable for tests
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code: url.searchParams.get('code'),
    redirectUri: new URL('/callback', request.url).href
  });
  if (errResponse) return errResponse;

  let user;
  try {
    user = await fetchGitHubUser(accessToken, env.GITHUB_USER_API_URL);   // overridable for tests
  } catch (e) {
    return new Response('Could not verify GitHub identity: ' + e.message, { status: 502 });
  }

  // This is the crux of the whole flow: the GitHub token becomes part of
  // `props`, which OAuthProvider stores server-side and makes available as
  // `ctx.props` inside the MCP API handler — the token itself never travels
  // back to the MCP client (ChatGPT). ChatGPT only ever sees the opaque MCP
  // access token OAuthProvider issues next.
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.login,
    metadata: { label: user.name || user.login },
    scope: oauthReqInfo.scope,
    props: { accessToken, login: user.login, name: user.name || user.login }
  });

  const headers = new Headers({ Location: redirectTo });
  if (clearSessionCookie) headers.set('Set-Cookie', clearSessionCookie);
  return new Response(null, { status: 302, headers });
}

export const GitHubHandler = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize' && request.method === 'GET') return handleAuthorizeGet(request, env);
    if (url.pathname === '/authorize' && request.method === 'POST') return handleAuthorizePost(request, env);
    if (url.pathname === '/callback' && request.method === 'GET') return handleCallback(request, env);
    if (url.pathname === '/' || url.pathname === '') {
      return new Response('mindspark-mcp OAuth server is running. MCP clients connect at /mcp.', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Not found', { status: 404 });
  }
};
