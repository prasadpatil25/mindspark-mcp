# mindspark-mcp

An MCP (Model Context Protocol) server for [MindSpark](https://github.com/prasadpatil25/mindspark). Lets Claude or ChatGPT read, create, and edit your mind maps directly — the same `mindspark-maps` GitHub repo the web app itself reads and writes.

Two ways to run it: as a **local process** (Claude Desktop, Claude Code, any stdio-based MCP client), or over **HTTP** (ChatGPT, or any client that needs a network-reachable server). Same tools, same data, same GitHub repo either way — just a different transport.

## What it can do

- **`list_maps`** — list your maps (title, id, last updated)
- **`get_map`** — read a map as an indented outline
- **`render_map`** — show a map as an actual visual diagram, inline in the conversation (see below) — ask to "see" or "visualize" a map rather than just read it
- **`create_map`** — create a new map from a Markdown outline. This is the main way to use it: just write an outline the way you normally would (headings and/or nested bullets, **bold**, *italic*, `code`), and it becomes a fully structured mind map. No need to describe nodes one at a time.
- **`add_node`** / **`update_node`** — add or edit nodes, including MindSpark's bulleted/numbered list style (`listType: 'ul'|'ol'`) and task checkboxes (`task: 'todo'|'doing'|'done'`), and pick from MindSpark's own light node-color palette (peach, cream, mint, teal, lavender, pink, beige) or any custom hex color
- **`delete_node`** — delete a node and its subtree
- **`delete_map`** — delete a map entirely

Every write goes through the same GitHub Contents API calls, the same `_index.json` / `_deleted.json` bookkeeping, and the same optimistic-concurrency (sha-based) handling as the web app's own storage layer — a map created here opens normally in MindSpark, and edits made in the app while this server is also active can't be clobbered by it (writes merge rather than overwrite).

A map created via `create_map` also sets a one-shot `_import` flag matching what MindSpark's own import flow sets — this is a real bug fix, not a nicety: a freshly created map has no `x`/`y` on its nodes, and `app.js`'s `loadMap()` only runs `autoLayout()` (computing real, non-overlapping positions) automatically when this flag is present. Without it, opening a freshly created map in the app would show every node stacked on top of each other. Confirmed by reading `app.js`'s actual load path, not assumed.

## The visual widget (`render_map`)

`render_map` returns an actual rendered diagram — matching MindSpark's own look, not a generic tree: root centered with branches balanced left and right (the same radial layout `app.js`'s own `balanceRootSides()` produces for a fresh view, including the exact same contiguous-half-split rule), the same default color palette and root-accent-color behavior, the same rule that custom node colors always pair with dark text, the same curved connector shape, the root's distinct bolder serif styling versus regular nodes' sans-serif, and the same 18px circular +/− fold toggle on any node with children, styled to match `app.js`'s `.h-collapse` exactly. Confirmed working live in ChatGPT (both browser and mobile), after two rounds of fixes based on that live testing.

**Word wrap, bullets, and task checkboxes** all match the app's own conventions, checked directly against `app.js`/`styles.css` rather than approximated: long node text wraps across multiple lines (the node grows taller to fit, and the layout re-flows so nothing overlaps) instead of just truncating with an ellipsis; `listType: 'ul'`/`'ol'` nodes show a bulleted or numbered line per item, matching `app.js`'s `renderNodeText()`; `task` nodes show the same three-state checkbox `app.js` uses (`todo` empty, `doing` amber half-circle, `done` green checkmark with the node text struck through and faded), matching `.task-check` and `.task-done .node-text` exactly. No real font metrics are available outside a browser, so wrapping uses an approximate character count per line rather than a measured pixel width — close, not pixel-perfect.

**Large maps default to showing just the center node and its immediate children**, with everything deeper collapsed until you click to expand a branch — so opening a big map doesn't dump an overwhelming wall of nodes on you. This is additive with the map's own saved fold state (anything the real app already has collapsed stays collapsed), not a replacement for it.

**Fold/unfold, not editing.** Clicking a node's toggle expands or collapses that branch — collapsing genuinely removes its descendants from the layout (not just visually hiding them), matching how collapsing works in the app itself. This state is local to the widget session and never written back to GitHub; the widget opens matching whatever fold state the real map currently has (respecting each node's own `collapsed` flag) plus the depth default above, and diverges from there as you click around, but MindSpark's own copy is never touched. This is deliberately a read-only view — for edits, use `add_node`/`update_node`/`delete_node`, or the link below to open the real app.

**"Open in MindSpark"** appears at the bottom of every rendered map, linking to that map in your actual MindSpark app when `MINDSPARK_APP_URL` is configured (see the environment variable table above) — the natural handoff point from "look at this" to "now edit it directly." This is a universally-viewable read-only link (the same `#view=` encoding MindSpark's own "Copy share link" feature uses — the whole map travels in the URL itself, nothing server-side to look up), not a link that only resolves for whoever's GitHub account the map happens to live in — so it works for anyone it gets shared with, not just its owner. Opening it shows MindSpark's own read-only shared view, with a "Make an editable copy" button already built into the app for saving it into *their* account if they want to.

Worth knowing: the layout and rendering logic (turning a node tree into SVG, word-wrap, the fold/collapse math, escaping text safely, matching MindSpark's exact styling) is thoroughly tested — `test/widget-layout.mjs`, `test/widget-text-layout.mjs`, `test/widget-render.mjs`, `test/widget-interactivity.mjs` (real simulated clicks against a real DOM, not just structural checks) — including strict XML well-formedness validation, which has caught several real bugs (an unescaped attribute quote, two separate instances of a duplicate `class` attribute, and a missing module in the widget's own build step) that more lenient HTML-style parsing missed entirely. The host-facing bridge (the handshake that gets map data into the iframe) is the one part that's only verifiable by actually using it in ChatGPT or Claude Desktop, which is exactly what surfaced and fixed the two earlier issues.

If the widget doesn't render, it shows its own diagnostics directly in the chat as an ongoing "still waiting" status rather than sitting silently forever: after about 5 seconds with nothing received, it displays what it actually tried (whether `window.openai` was present, how many messages arrived from the host, whether the handshake timed out). A screenshot of that panel is far more useful for tracking down a new issue than "it's not rendering."

**A note on the "Widget CSP / domain not set" warning ChatGPT's connector screen shows in Developer Mode:** this widget makes zero external network calls (everything — layout, rendering, styling — is inlined in one self-contained HTML resource) other than optionally allowing navigation to your own configured `MINDSPARK_APP_URL` for the "Open in MindSpark" link, so its CSP is otherwise the most restrictive one possible. That's set directly on the widget resource. This warning specifically gates *public app submission*, not Developer Mode testing — you can use the widget as-is; it only becomes relevant if you ever submit this for listing in ChatGPT's app directory.

## Requirements

- Node.js 18 or later
- A GitHub account with (or willing to have) a `mindspark-maps` repo — the same one the MindSpark web app uses when you sign in with GitHub. If you've never signed into MindSpark's cloud mode, the server creates this repo (private) on first use.

## 1. Get a GitHub token

First, check whether you already have a `mindspark-maps` repository under your GitHub account (you would if you've ever signed into MindSpark's cloud mode). This determines which setup is simpler.

### If `mindspark-maps` already exists

Create a **fine-grained personal access token**:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token
2. Repository access: "Only select repositories" → `mindspark-maps`
3. Permissions → Repository permissions → **Contents: Read and write**
4. Generate, copy the token (starts with `github_pat_`)

That's it — no other permissions needed.

### If it doesn't exist yet (recommended path)

The simplest and most secure option is to create the repository yourself first, then scope a token to just that one repo:

1. Go to [github.com/new](https://github.com/new), create a repository named exactly `mindspark-maps` — private, otherwise empty (don't add a README)
2. Follow the steps above ("if it already exists") now that it does

### If it doesn't exist yet, and you want the server to create it for you

This is where it's easy to get a confusing permissions error, so it's worth calling out specifically: creating a *new* repository requires a **separate** permission from the one that reads and writes files inside it. "Contents: Read and write" is not enough on its own.

1. Fine-grained tokens → Generate new token
2. Repository access: **"All repositories"** (a repo that doesn't exist yet can't be individually selected)
3. Permissions → Repository permissions → **Contents: Read and write** *and* **Administration: Read and write** (this second one is specifically "repository creation, deletion, settings, teams, and collaborators" — easy to miss, since nothing about creating a repo obviously sounds like "administration")
4. Generate, copy the token

Once the repo exists, you can generate a narrower, single-repo token to replace this one if you'd rather not keep a broadly-scoped token around.

### Classic tokens

A classic token with the `repo` scope also works for either case, if you prefer — it doesn't have this Contents/Administration split, at the cost of being broader (access to every repo you can access, not just this one).

## 2. Install

```bash
cd mcp-server
npm install
```

## 3. Connect it

### Option A — Claude Desktop / Claude Code (local, stdio)

Add to your MCP config (`claude_desktop_config.json`, or via `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "mindspark": {
      "command": "node",
      "args": ["/absolute/path/to/mindspark/mcp-server/src/server.js"],
      "env": {
        "MINDSPARK_GH_TOKEN": "github_pat_..."
      }
    }
  }
}
```

Restart Claude Desktop (or reload MCP servers in Claude Code) after saving.

### Option B — ChatGPT (HTTP, via a tunnel)

This runs the same server over HTTP instead of as a local subprocess, since ChatGPT can't spawn a process on your machine — it needs a URL it can reach.

This is a **single-user setup**: the token still comes from one environment variable, same as Option A. Anyone who has the tunnel URL while it's running can call every tool as you. Fine for trying it out yourself; don't share the URL, and stop the tunnel when you're done.

1. Start the server:
   ```bash
   MINDSPARK_GH_TOKEN=github_pat_... npm run start:http
   ```
   By default it listens on `http://localhost:3300/mcp` (override with `PORT`).

2. Expose it publicly with a tunnel, e.g. [ngrok](https://ngrok.com/):
   ```bash
   ngrok http 3300
   ```
   Note the `https://....ngrok.app` URL it gives you.

3. In ChatGPT: Settings → Apps → Advanced Settings → turn on **Developer mode** (requires Plus, Pro, Business, Enterprise, or Edu). Then Settings → Apps → **Create**, and point it at `https://<your-ngrok-url>/mcp`.

4. Start a new chat, add the connector from the **+** menu, and try:
   > Create a MindSpark map planning a birthday party, with sections for guest list, food, and decorations.

Every tool call re-authenticates against GitHub with the same token as the local version — nothing about the data path changes, only how ChatGPT reaches the server. Each client connection gets its own session (a fresh handshake creates a new one); idle sessions are cleaned up automatically after 30 minutes.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MINDSPARK_GH_TOKEN` | Yes | — | GitHub token, see step 1 |
| `MINDSPARK_GH_REPO` | No | `mindspark-maps` | Repo name, if you use something other than the default |
| `MINDSPARK_APP_URL` | No | — | The URL where your MindSpark app is hosted (e.g. `https://you.github.io/mindspark` or your Cloudflare Worker URL). When set, `render_map`'s widget shows an "Open in MindSpark" link at the bottom — a read-only, universally-viewable share link (`<url>/#view=<encoded-map>`, the same format MindSpark's own "Copy share link" feature produces), so it works for anyone the link is shared with, not just whoever's GitHub account the map lives in. Without it, the widget still shows the link slot but explains it needs this variable set, rather than a broken link. |
| `PORT` | No (HTTP only) | `3300` | Port for the HTTP server |

## Example

Once connected, in Claude:

> Create a MindSpark map planning a birthday party, with sections for guest list, food, and decorations.

Claude writes the outline and calls `create_map` — the map appears in your MindSpark sidebar the next time you open the app (or refresh "Your maps" if it's already open).

## Testing

```bash
npm install   # if you haven't already
npm test      # runs everything below in sequence
```

Or individually:

```bash
node test/widget-layout.mjs      # tree layout algorithm: sibling spacing, deep chains, wide fan-outs,
                                  # malformed input (dangling/cyclic references), variable per-node
                                  # heights (word-wrapped content) with no overlap
node test/widget-text-layout.mjs # word-wrap, bullet/numbered list formatting, truncation with ellipsis,
                                  # HTML/<br> normalization — all as pure, isolated functions
node test/widget-render.mjs      # SVG generation: well-formed output (strict XML validation, not just
                                  # lenient HTML-style parsing), text escaping (including hostile input),
                                  # MindSpark's exact coloring/font/border/task-checkbox conventions
node test/widget-assembly.mjs    # the tested layout/render/text-layout code actually ends up in the
                                  # shipped widget HTML, unmodified and functional
node test/widget-interactivity.mjs # real simulated clicks against a real DOM: fold/unfold toggles,
                                  # default collapse-beyond-depth-1 view, initial state seeded from the
                                  # map's own collapsed flags, the "open in MindSpark" footer link
node test/share-link.test.mjs    # the "#view=" share-link encoding shared with mcp-server/no-login/ —
                                  # cross-validated against Node's independent zlib implementation, not
                                  # just round-tripped through its own decoder, to confirm the output is
                                  # genuinely standard gzip a real browser would decode correctly
node test/widget-integration.mjs # full round trip through the real MCP protocol: create a map, confirm
                                  # the _import flag is set (fixes a real overlap-on-open bug), add
                                  # listType/task nodes and confirm they survive the round trip, and
                                  # confirm render_map's "Open in MindSpark" link is a universally-
                                  # viewable share link (checked against app.js's own detection regex)
                                  # rather than a login-gated deep link
node test/e2e.mjs                # full protocol test (stdio-style, in-memory transport) against a mocked GitHub API
node test/edge-cases.mjs         # sha-conflict retry, first-run repo creation, concurrent-write safety
node test/http-e2e.mjs           # same protocol + widget tests but over real HTTP — starts the actual
                                  # server process, connects with a real HTTP client
node test/multi-session.mjs      # confirms multiple independent client sessions can each connect and
                                  # operate without interfering with each other
```

All of these run entirely offline — no real GitHub account, token, or MCP client (ChatGPT/Claude) needed. What they can't cover is noted in "The visual widget" section above — that part needs a live check.

## Security notes

- Your token is read from an environment variable, never logged, never sent anywhere except `api.github.com`.
- Use a fine-grained token scoped to just the `mindspark-maps` repo where possible, not a broad classic token.
- This server can create, edit, and delete maps and nodes on your behalf whenever an MCP client decides to call it — the same trust model as giving any MCP server file access. Only run it with clients and configurations you trust.
- **HTTP mode specifically:** the tunnel URL is not authenticated — anyone who has it can call every tool as you for as long as the tunnel is up. Treat it like a bearer token: don't post it publicly, and stop `ngrok`/kill the server when you're done testing. This mode is meant for one person trying this out, not for sharing with others — see the earlier note about what a real multi-user deployment would need instead (per-user OAuth, hosted rather than tunneled).
