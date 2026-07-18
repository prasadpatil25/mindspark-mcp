import {
  generateCSRFProtection, validateCSRFToken,
  isClientApproved, addApprovedClient,
  createOAuthState, bindStateToSession, validateOAuthState,
  renderApprovalDialog, OAuthError
} from '../src/oauth-utils.js';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

function reqWithCookies(cookies) {
  return new Request('https://mcp.example.com/authorize', { headers: { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ') } });
}

// Minimal in-memory KV mock matching the subset of the KVNamespace interface used.
function mockKV() {
  const store = new Map();
  return {
    async put(key, value) { store.set(key, value); },
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async delete(key) { store.delete(key); },
    _store: store
  };
}

console.log('=== CSRF: valid token round-trips correctly ===');
{
  const { token, setCookie } = generateCSRFProtection();
  check('setCookie has __Host- prefix (requires Secure+Path=/+no Domain)', setCookie.includes('__Host-mcp_csrf='));
  check('setCookie is HttpOnly and Secure', setCookie.includes('HttpOnly') && setCookie.includes('Secure'));
  const cookieVal = setCookie.match(/__Host-mcp_csrf=([^;]+)/)[1];
  const req = reqWithCookies({ '__Host-mcp_csrf': cookieVal });
  check('does not throw when form token matches cookie', (() => { try { validateCSRFToken(token, req); return true; } catch { return false; } })());
}

console.log('\n=== CSRF: rejects missing or mismatched tokens ===');
{
  const req = reqWithCookies({ '__Host-mcp_csrf': 'abc123' });
  check('throws OAuthError when form token does not match cookie', (() => { try { validateCSRFToken('wrong-token', req); return false; } catch (e) { return e instanceof OAuthError; } })());
  const reqNoCookie = new Request('https://mcp.example.com/authorize');
  check('throws when there is no CSRF cookie at all', (() => { try { validateCSRFToken('any-token', reqNoCookie); return false; } catch (e) { return e instanceof OAuthError; } })());
  check('throws when form token is empty', (() => { try { validateCSRFToken('', req); return false; } catch (e) { return e instanceof OAuthError; } })());
}

console.log('\n=== Approved clients cookie: sign, verify, detect tampering ===');
{
  const secret = 'test-secret-key';
  const noApprovalReq = new Request('https://mcp.example.com/');
  check('client not approved with no cookie at all', !(await isClientApproved(noApprovalReq, 'client-a', secret)));

  const setCookie = await addApprovedClient(noApprovalReq, 'client-a', secret);
  const cookieVal = setCookie.split(';')[0].split('=').slice(1).join('=');
  const req1 = reqWithCookies({ mcp_approved_clients: cookieVal });
  check('client IS approved after being added, with a correctly signed cookie', await isClientApproved(req1, 'client-a', secret));
  check('a DIFFERENT client id is NOT approved by the same cookie', !(await isClientApproved(req1, 'client-b', secret)));

  console.log('\n=== Approved clients: adding a second client preserves the first ===');
  const setCookie2 = await addApprovedClient(req1, 'client-b', secret);
  const cookieVal2 = setCookie2.split(';')[0].split('=').slice(1).join('=');
  const req2 = reqWithCookies({ mcp_approved_clients: cookieVal2 });
  check('client-a still approved after adding client-b', await isClientApproved(req2, 'client-a', secret));
  check('client-b now also approved', await isClientApproved(req2, 'client-b', secret));

  console.log('\n=== Approved clients: tampering is detected, not trusted ===');
  const [payload] = cookieVal.split('.');
  const forgedPayload = btoa(JSON.stringify(['client-c']));   // attacker tries to swap in their own client id
  const forgedCookie = `${forgedPayload}.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;   // fake signature
  const reqForged = reqWithCookies({ mcp_approved_clients: forgedCookie });
  check('forged cookie (wrong signature) is rejected, not trusted', !(await isClientApproved(reqForged, 'client-c', secret)));

  check('wrong secret cannot verify a legitimately-signed cookie either (secret actually matters)', !(await isClientApproved(req1, 'client-a', 'wrong-secret')));
}

console.log('\n=== OAuth state: the core CSRF-on-upstream-flow protection ===');
{
  const kv = mockKV();
  const oauthReqInfo = { clientId: 'test-client', redirectUri: 'https://chatgpt.com/callback', scope: ['mcp'], state: 'client-state-xyz', responseType: 'code' };
  const { stateToken } = await createOAuthState(oauthReqInfo, kv);
  check('state token was stored in KV', kv._store.has(`oauth_state:${stateToken}`));
  const { setCookie } = bindStateToSession(stateToken);
  check('session-binding cookie uses __Host- prefix', setCookie.includes('__Host-mcp_oauth_state='));

  console.log('\n=== Legitimate callback: cookie matches query param, KV has the entry ===');
  {
    const callbackReq = new Request(`https://mcp.example.com/callback?code=abc&state=${stateToken}`, {
      headers: { Cookie: `__Host-mcp_oauth_state=${stateToken}` }
    });
    const result = await validateOAuthState(callbackReq, kv);
    check('returns the original oauthReqInfo', result.oauthReqInfo.clientId === 'test-client');
    check('returns a cookie-clearing header (single-use)', result.clearCookie.includes('Max-Age=0'));
    check('state was deleted from KV after use (cannot be replayed)', !kv._store.has(`oauth_state:${stateToken}`));
  }

  console.log('\n=== Replay attempt: using the same state token twice fails the second time ===');
  {
    const replayReq = new Request(`https://mcp.example.com/callback?code=abc&state=${stateToken}`, {
      headers: { Cookie: `__Host-mcp_oauth_state=${stateToken}` }
    });
    check('second use of the same (now-deleted) state token is rejected', (() => { return validateOAuthState(replayReq, kv).then(() => false, e => e instanceof OAuthError); })());
  }
}

console.log('\n=== OAuth state: the actual attack this defends against — attacker-supplied state without the victim\'s cookie ===');
{
  const kv = mockKV();
  const oauthReqInfo = { clientId: 'attacker-client', redirectUri: 'https://evil.example.com/callback', scope: [], state: 's', responseType: 'code' };
  const { stateToken: attackerState } = await createOAuthState(oauthReqInfo, kv);
  // Attacker tricks victim into visiting a callback URL carrying the ATTACKER's
  // state token, but the victim's browser has no matching session cookie for it
  // (only the attacker's own browser, during their own flow, would have that).
  const victimReq = new Request(`https://mcp.example.com/callback?code=xyz&state=${attackerState}`);   // no Cookie header at all
  const rejected = await validateOAuthState(victimReq, kv).then(() => false, e => e instanceof OAuthError);
  check('callback with attacker\'s state but no matching session cookie is rejected — this IS the CSRF protection', rejected);
}
{
  const kv = mockKV();
  const oauthReqInfo = { clientId: 'attacker-client', redirectUri: 'https://evil.example.com/callback', scope: [], state: 's', responseType: 'code' };
  const { stateToken: attackerState } = await createOAuthState(oauthReqInfo, kv);
  // Victim's browser has a DIFFERENT, unrelated state cookie from their own prior activity.
  const victimReq = new Request(`https://mcp.example.com/callback?code=xyz&state=${attackerState}`, {
    headers: { Cookie: `__Host-mcp_oauth_state=some-other-unrelated-token` }
  });
  const rejected = await validateOAuthState(victimReq, kv).then(() => false, e => e instanceof OAuthError);
  check('callback with attacker\'s state and a MISMATCHED session cookie is also rejected', rejected);
}

console.log('\n=== Approval dialog: well-formed HTML, user-controlled client name is escaped ===');
{
  const { token: csrfToken, setCookie } = generateCSRFProtection();
  const req = new Request('https://mcp.example.com/authorize');
  const res = renderApprovalDialog(req, {
    client: { clientId: 'c1', clientName: '<script>alert(1)</script>' },
    server: { name: 'MindSpark MCP', description: 'test' },
    state: { oauthReqInfo: { clientId: 'c1' } },
    csrfToken,
    setCookie
  });
  check('returns a 200 HTML response', res.status === 200 && res.headers.get('Content-Type').includes('text/html'));
  const html = await res.text();
  check('malicious client name is escaped, not injected raw', !html.includes('<script>alert(1)</script>'));
  check('escaped version IS present (proves the name is shown, just safely)', html.includes('&lt;script&gt;'));
  check('CSRF token is embedded as a hidden form field', html.includes(`value="${csrfToken}"`));
  check('sets the CSRF cookie on the response', res.headers.get('Set-Cookie')?.includes('mcp_csrf'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
