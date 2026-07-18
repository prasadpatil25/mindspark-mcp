import { getUpstreamAuthorizeUrl, fetchUpstreamAuthToken, fetchGitHubUser } from '../src/github-oauth.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

console.log('=== getUpstreamAuthorizeUrl builds a correct GitHub authorize URL ===');
{
  const url = getUpstreamAuthorizeUrl({
    upstreamUrl: 'https://github.com/login/oauth/authorize',
    clientId: 'abc123', redirectUri: 'https://mcp.example.com/callback', scope: 'read:user', state: 'xyz789'
  });
  const parsed = new URL(url);
  check('correct base URL', parsed.origin + parsed.pathname === 'https://github.com/login/oauth/authorize');
  check('client_id present', parsed.searchParams.get('client_id') === 'abc123');
  check('redirect_uri present and correctly encoded', parsed.searchParams.get('redirect_uri') === 'https://mcp.example.com/callback');
  check('scope present', parsed.searchParams.get('scope') === 'read:user');
  check('state present', parsed.searchParams.get('state') === 'xyz789');
}

console.log('\n=== fetchUpstreamAuthToken: successful exchange ===');
{
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.code === 'valid-code') return { ok: true, json: async () => ({ access_token: 'gho_realtoken123' }) };
    return { ok: false, json: async () => ({ error: 'bad_verification_code' }) };
  };
  const [token, err] = await fetchUpstreamAuthToken({ upstreamUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 's', code: 'valid-code', redirectUri: 'r' });
  check('returns the access token', token === 'gho_realtoken123', token);
  check('no error response', err === null);
}

console.log('\n=== fetchUpstreamAuthToken: GitHub rejects the code ===');
{
  const [token, err] = await fetchUpstreamAuthToken({ upstreamUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 's', code: 'bad-code', redirectUri: 'r' });
  check('no token returned', token === null);
  check('returns an error Response', err instanceof Response && err.status === 401, err?.status);
}

console.log('\n=== fetchUpstreamAuthToken: missing code entirely ===');
{
  const [token, err] = await fetchUpstreamAuthToken({ upstreamUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 's', code: undefined, redirectUri: 'r' });
  check('no token', token === null);
  check('clean 400 error, does not even attempt the network call', err.status === 400);
}

console.log('\n=== fetchUpstreamAuthToken: network failure ===');
{
  globalThis.fetch = async () => { throw new Error('network down'); };
  const [token, err] = await fetchUpstreamAuthToken({ upstreamUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' });
  check('no token', token === null);
  check('returns a 502, not an unhandled throw', err.status === 502);
}

console.log('\n=== fetchUpstreamAuthToken: GitHub returns unparseable response ===');
{
  globalThis.fetch = async () => ({ ok: true, json: async () => { throw new SyntaxError('not json'); } });
  const [token, err] = await fetchUpstreamAuthToken({ upstreamUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r' });
  check('no token', token === null);
  check('returns a clean error response, does not throw', err instanceof Response);
}

console.log('\n=== fetchGitHubUser: successful fetch ===');
{
  globalThis.fetch = async (url, opts) => {
    check('sends the access token as a Bearer header', opts.headers.Authorization === 'Bearer gho_realtoken123');
    return { ok: true, json: async () => ({ login: 'octocat', id: 1, name: 'The Octocat' }) };
  };
  const user = await fetchGitHubUser('gho_realtoken123');
  check('returns the user object', user.login === 'octocat');
}

console.log('\n=== fetchGitHubUser: invalid token ===');
{
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  let threw = false;
  try { await fetchGitHubUser('bad-token'); } catch (e) { threw = true; }
  check('throws on a failed request rather than returning a broken user object', threw);
}

console.log('\n=== fetchGitHubUser: malformed response with no login ===');
{
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ message: 'something odd' }) });
  let threw = false;
  try { await fetchGitHubUser('token'); } catch (e) { threw = true; }
  check('throws rather than silently proceeding with an unusable identity', threw);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
