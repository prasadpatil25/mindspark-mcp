# mindspark-mcp-no-login

The zero-friction version of `mindspark-mcp`: no GitHub account, no personal access token, no OAuth sign-in — anyone with the connector URL can create a mind map and get a link to it immediately. Deploy this once, and every ChatGPT user who adds it can use it straight away, with nothing to configure on their end.

This exists alongside, not instead of, the other two servers in this repo:

| | Auth | Persistence | Best for |
|---|---|---|---|
| `mcp-server/` | One shared token | Full read/write to one GitHub account | Personal use |
| `mcp-server/cloudflare-oauth/` | Each user's own GitHub sign-in | Full read/write, per user | Multiple people, each keeping their own maps |
| `mcp-server/no-login/` (this one) | None at all | None — the link *is* the data | Anyone, zero setup, quick sharing |

## How it works

This doesn't invent a new storage mechanism — it uses one that already exists in MindSpark itself. The app has a "Copy share link" feature (`public/app.js`'s `buildShareLink()`) that gzip-compresses a map and embeds it directly in a URL fragment (`#view=...`), so the link *is* the map — no server, no database, nothing to look up. `worker/import-core.js` already does exactly this server-side for a different feature (GPT map import). This server calls the same encoding, byte-for-byte — verified directly (not just assumed) by decompressing its own output with three independent gzip implementations and confirming they all agree, and by checking the token format matches exactly what `app.js`'s own decoder expects.

```
outline → node tree → gzip+base64url → https://<your-mindspark>/#view=<token>
```

When someone opens that link, MindSpark decodes it client-side and shows the map read-only — no server round trip, no auth check, nothing to fail. If they want to keep editing it, there's already a "Make an editable copy" button in that view, which prompts *them* to sign in with *their own* GitHub account, entirely inside the app — this server has no involvement in that step and needs none.

There's exactly one tool, `create_map`, and it always renders the widget immediately (per the request that creating a map should always show it, not require a separate render step). There's no `add_node`/`get_map`/`list_maps` — with nothing stored server-side, there's nothing to look up later. To change a map, ask for it again with an updated outline; that produces a new link, and the old one keeps working exactly as it was.

The encoding itself now lives in `../src/share-link.js` (shared with the main `mcp-server/` project) rather than being local to this one — the other two servers' `render_map` also produces these same universally-viewable links for their own "Open in MindSpark" button now, instead of a login-gated `?map=<id>` deep link that only resolved for whoever's GitHub account the map happened to live in.

## Setup

There's exactly one thing to configure: where your MindSpark app is hosted (needed to build `<that-url>/#view=...` links).

```bash
npm install
```

Edit `wrangler.toml`, replacing the placeholder:
```toml
[vars]
MINDSPARK_APP_URL = "https://your-actual-mindspark-url.com"
```

Then deploy:
```bash
npm run deploy
```

That's the entire setup. No GitHub OAuth App, no KV namespace, no secrets.

### Connect from ChatGPT

Settings → Apps → Advanced Settings → Developer mode → Settings → Apps → Create, pointing at `https://<your-worker>.<your-subdomain>.workers.dev/mcp`. No sign-in step for the person connecting it — it works immediately.

## Local development

```bash
npm run dev
```

## Testing

```bash
npm test
```

All offline, no real MindSpark deployment or network access needed:

The gzip+base64url encoding itself (`../src/share-link.js`) is shared with — and tested alongside — the main `mcp-server/` project now, since `render_map` in the single-user and OAuth servers also produces these same universally-viewable links for their "Open in MindSpark" button (see `../test/share-link.test.mjs` for that verification: cross-validated against Node's independent zlib implementation, not just round-tripped through its own decoder, confirming the output is genuinely standard gzip a real browser would decode correctly). This project's own tests below cover what's specific to it:

```bash
node test/map-builder.test.mjs  # wrapping the existing, already-tested outline parser into the
                                 # share-payload shape, plus a full outline -> map -> token -> decode
                                 # pipeline test confirming structure (parent/child relationships)
                                 # survives completely intact
node test/server.test.mjs       # the real MCP protocol: tool registration, widget metadata, and a
                                 # full create_map call whose returned link is independently decoded
                                 # and checked against the structuredContent the widget receives —
                                 # confirming they're the same data, not just similarly-shaped
```

Beyond the automated tests, this was also verified as an actual running Worker (Wrangler's `unstable_dev`, not just mocked unit tests): bundled for real, then driven through a genuine `initialize` handshake and a real `create_map` tool call with no authentication header of any kind, confirming the whole chain — bundling, session handling, the widget resource, and the share-link encoding — works together end to end, not just in isolation.

**What's still unverified from here**: an actual ChatGPT client completing a live tool call, and — most importantly — that a real browser opening one of these generated links actually renders the map correctly in MindSpark itself. The encoding is verified as genuinely standard gzip+base64url and matches the app's own token format exactly, but the very last step (a real browser, a real page load) needs a live check on your end, the same honest caveat as the other two servers' unverified pieces.

## A note on abuse

This server has no rate limiting or gating of any kind — deliberately, since the entire point is zero friction. If you're deploying this somewhere it might see meaningful traffic, worth knowing: `worker/import-core.js` (the existing endpoint this reuses the encoding from) has an optional shared-secret gate (`IMPORT_TOKEN`) for exactly this reason. This server doesn't currently have an equivalent — worth adding if abuse becomes a real concern, but deliberately left out for now in favor of the simplest possible "just works for anyone" setup.
