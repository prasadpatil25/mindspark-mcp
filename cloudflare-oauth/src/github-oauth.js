// Talks to GitHub's OAuth endpoints. Upstream URLs are parameters (not hardcoded)
// specifically so tests can point this at a local mock server instead of the real
// github.com — there's no way to get real GitHub OAuth App credentials into an
// automated test.

export function getUpstreamAuthorizeUrl({ upstreamUrl, clientId, redirectUri, scope, state }) {
  const url = new URL(upstreamUrl);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', state);
  return url.href;
}

/**
 * @returns {Promise<[string, null] | [null, Response]>} either [accessToken, null]
 *   on success, or [null, errorResponse] to return directly to the caller's browser.
 */
export async function fetchUpstreamAuthToken({ upstreamUrl, clientId, clientSecret, code, redirectUri }) {
  if (!code) return [null, new Response('Missing authorization code from GitHub', { status: 400 })];
  let resp;
  try {
    resp = await fetch(upstreamUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri })
    });
  } catch (e) {
    return [null, new Response('Could not reach GitHub to exchange the authorization code', { status: 502 })];
  }
  let data;
  try { data = await resp.json(); } catch (e) { return [null, new Response('GitHub returned an unreadable response', { status: 502 })]; }
  if (!resp.ok || !data.access_token) {
    return [null, new Response('GitHub token exchange failed: ' + (data.error_description || data.error || 'unknown error'), { status: 401 })];
  }
  return [data.access_token, null];
}

export async function fetchGitHubUser(accessToken, apiUrl = 'https://api.github.com/user') {
  const resp = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'mindspark-mcp-oauth', Accept: 'application/vnd.github+json' }
  });
  if (!resp.ok) throw new Error(`Could not fetch GitHub user (HTTP ${resp.status})`);
  const user = await resp.json();
  if (!user || !user.login) throw new Error('GitHub user response had no login');
  return user;
}
