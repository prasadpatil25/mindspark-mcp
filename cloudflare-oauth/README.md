# mindspark-mcp-oauth

The multi-user version of `mindspark-mcp`: instead of one shared `MINDSPARK_GH_TOKEN` baked into a single server process, each person who connects signs in with their **own** GitHub account. Deployed once, on your own Cloudflare account, this lets anyone add it as a ChatGPT connector without ever seeing — or needing — anyone else's credentials.

This is the "real thing" version. If you just want to try this yourself without deploying anything, the single-user version in the parent `mcp-server/` directory (a tunnel + one shared token) is simpler and has no setup cost. Reach for this one when you actually want other people to be able to connect.

## How it works

```
ChatGPT  →  this Worker (OAuth server)  →  GitHub (OAuth provider)
         ←  MCP access token              ←  GitHub access token
```

Your MCP server acts as *both* an OAuth server (to ChatGPT) and an OAuth client (to GitHub) — the standard shape for this kind of proxy, and the reason it needs more moving parts than the single-user version:

1. ChatGPT discovers this server needs auth, and where to send the user (`/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` — both served automatically by the OAuth library, RFC 9728 / RFC 8414).
2. It registers itself as a client (`/register`, RFC 7591 Dynamic Client Registration) and sends the user to `/authorize`.
3. First time for a given browser: a consent screen ("Authorize with GitHub"). Already approved before: skipped straight to GitHub.
4. GitHub redirects back to `/callback` with a code; this Worker exchanges it for a real GitHub token, fetches the user's identity, and **never sends that GitHub token to ChatGPT** — it mints its own opaque MCP token instead, storing the mapping server-side. This is the specific property the MCP spec requires ("no token passthrough") and it's what makes this different from just forwarding a PAT.
5. Every later tool call carries ChatGPT's MCP token; this Worker looks up the matching GitHub token and uses that for the actual GitHub API calls — same tools, same `mindspark-maps` repo layout, as the single-user version.

Each user's session is fully isolated — one identity's session id cannot be used to access another's data, even if guessed (tested directly, not just assumed).

## Setup

### 1. Create a GitHub OAuth App

[github.com/settings/developers](https://github.com/settings/developers) → New OAuth App:
- Homepage URL: anything (e.g. your MindSpark URL)
- Authorization callback URL: `https://<your-worker-name>.<your-subdomain>.workers.dev/callback`

Note the Client ID, generate a Client secret.

### 2. Create a KV namespace

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints into `wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

### 3. Set secrets

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # any random string, e.g. `openssl rand -hex 32`
```

Optional (also via `wrangler secret put`):
- `MINDSPARK_GH_REPO` — defaults to `mindspark-maps` if not set
- `MINDSPARK_APP_URL` — enables the widget's "Open in MindSpark" link, same as the single-user version

### 4. Deploy

```bash
npm install
npm run deploy
```

This runs `npm run build:widget` first automatically (bundles the tested widget from `../web/` into a static import — Workers have no filesystem at runtime, so this has to happen before deploy, not inside the request handler).

### 5. Connect from ChatGPT

Settings → Apps → Advanced Settings → Developer mode → Settings → Apps → Create, pointing at `https://<your-worker>.<your-subdomain>.workers.dev/mcp`. ChatGPT handles the rest of the OAuth dance itself from there — registration, redirecting the user to `/authorize`, storing its token.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real or dummy values
npm run dev
```

For a real end-to-end local test (not just dummy values), you'll want a second GitHub OAuth App with a `localhost` callback URL, per [Cloudflare's own guide](https://developers.cloudflare.com/agents/guides/remote-mcp-server/) for this same pattern.

## Testing

```bash
npm test
```

Runs everything below in sequence — all offline, no real GitHub or Cloudflare account needed:

```bash
node test/oauth-utils.test.mjs       # CSRF protection, signed-cookie tamper detection, and — the
                                      # important one — a direct simulation of the actual CSRF attack
                                      # this design defends against (attacker-supplied state token
                                      # without the victim's session cookie)
node test/github-oauth.test.mjs      # GitHub token exchange and user-fetch calls, with fetch mocked
                                      # to simulate success, failure, network errors, malformed responses
node test/github-handler.test.mjs    # the full /authorize -> GitHub -> /callback flow, simulated as a
                                      # real browser would experience it (cookies carried between
                                      # requests), plus the security-rejection paths
node test/mcp-api-handler.test.mjs   # session creation/reuse/isolation, and confirms the real GitHub
                                      # token from a session's props actually drives the underlying
                                      # tool calls (not a stub) — checked by creating a real map and
                                      # verifying it landed under the correct GitHub identity
```

**Beyond the automated tests**, this was also verified as an actual running Worker (not just mocked unit tests) using Wrangler's programmatic `unstable_dev` API — bundled and started for real, then exercised with genuine dynamic client registration and a full `/authorize` request carrying real PKCE parameters, confirming the whole chain (bundling, KV binding, the OAuth library's own discovery endpoints, and this project's custom consent/callback flow) actually works together, not just in isolation. That verification directly caught and fixed a real bug during development: a module transitively imported by `createServer()` ran filesystem-path code at module-load time that doesn't exist in the Workers runtime, breaking silently under bundling in a way no unit test would have caught. Fixed by making that import lazy (a dynamic `import()`, only reached when actually needed) rather than static.

**What's still genuinely unverified**: real GitHub OAuth App credentials, a real deployed KV namespace, and a real ChatGPT client going through the full flow live. Nothing in this sandbox can exercise those — that part needs a live test on your end once deployed, the same honest caveat as the single-user version's widget bridge.

## Security notes

- This follows the same CSRF/session-binding pattern as Cloudflare's own official `remote-mcp-github-oauth` reference template, cross-checked against several independent implementations of it rather than invented from scratch — the two real protections are a short-lived CSRF token on the consent form, and a session-bound state token (stored in both KV and an `HttpOnly` cookie) that must match on GitHub's callback, which is what stops an attacker's own OAuth flow from being bound to a victim's session.
- The real GitHub token is never sent to ChatGPT or any MCP client — it's stored server-side (via the OAuth library's own storage) and only used internally to make GitHub API calls on the authenticated user's behalf.
- Like the official template this is based on: this implements the core security controls, but you should still review [Cloudflare's MCP security guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/securing-mcp-server/) before treating this as hardened for a large, untrusted user base — the same caveat Cloudflare's own reference carries.
