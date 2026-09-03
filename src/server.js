#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { resolveStoreFromEnv } from './store-factory.js';
import { outlineToMap } from './outline-parser.js';
import { buildShareToken, buildShareUrl } from './share-link.js';
// No static import of build-widget.mjs here on purpose — its top-level code runs
// fileURLToPath(import.meta.url) at module-load time (to locate sibling files on
// disk), which breaks in Cloudflare Workers' bundled runtime even though the
// function itself is never called there. A dynamic import, reached only when
// opts.widgetHTML isn't already supplied, means Workers callers (which always
// supply it, having no filesystem to read from at runtime) never load this
// module at all.

const WIDGET_URI = 'ui://widget/mindmap.html';

const text = s => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] });
const errorResult = e => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

// Renders a map's node tree as an indented outline, for compact reading — a full map
// JSON dump is a poor fit for a model's context window on anything but tiny maps.
function renderOutline(map) {
  const childrenOf = id => Object.values(map.nodes).filter(n => n.parent === id);
  const lines = [];
  const walk = (id, depth) => {
    const n = map.nodes[id];
    const plain = (n.text || '').replace(/<[^>]+>/g, '');
    lines.push('  '.repeat(depth) + '- ' + plain + `  [id: ${id}]`);
    for (const c of childrenOf(id)) walk(c.id, depth + 1);
  };
  walk(map.rootId, 0);
  return lines.join('\n');
}

// Minimal, widget-facing view of a map — just what web/render-svg.mjs needs
// (text, parent, color), not the internal x/y/collapsed/etc fields a full map
// object carries.
function widgetPayload(map) {
  const nodes = {};
  for (const id in map.nodes) {
    const n = map.nodes[id];
    nodes[id] = { text: n.text, parent: n.parent, color: n.color, collapsed: !!n.collapsed, listType: n.listType || null, task: n.task || null };
  }
  return { id: map.id, title: map.title, rootId: map.rootId, color: map.color, nodes };
}

export async function createServer(store, opts = {}) {
  const appUrl = opts.appUrl ? opts.appUrl.replace(/\/+$/, '') : null;
  const server = new McpServer({ name: 'mindspark-mcp', version: '1.0.0' });

  // Built once here rather than on every resource read — the widget's source
  // files don't change while the server is running, and assembling it is pure
  // file I/O + string work, no reason to repeat it per request.
  // assembleWidgetHTML() reads from disk (node:fs), which doesn't exist on
  // Cloudflare Workers — a Workers-based caller supplies the already-assembled
  // string instead (built at deploy time), via opts.widgetHTML. Existing Node
  // callers that don't pass it get the exact same behavior as before.
  const widgetHTML = opts.widgetHTML || (await import('../web/build-widget.mjs')).assembleWidgetHTML();
  // This widget makes no external network calls at all — no images, fonts, or API
  // calls, everything needed is inlined in the assembled HTML — so the correct CSP
  // is the most restrictive one possible: nothing external allowed, EXCEPT the
  // configured MindSpark app URL as a redirect target (needed for the "open in
  // MindSpark" link's window.openai.openExternal() call to be permitted at all).
  // Set on the resource's own _meta (not the tool's) — ChatGPT's dev-mode warning
  // about a missing CSP/domain traces to exactly this placement mistake, confirmed
  // by several independent reports of the identical warning.
  let redirectOrigin = null;
  if (appUrl) { try { redirectOrigin = new URL(appUrl).origin; } catch (e) { /* leave unset if malformed */ } }
  const widgetCSP = { connectDomains: [], resourceDomains: [] };
  if (redirectOrigin) widgetCSP.redirectDomains = [redirectOrigin];
  const legacyWidgetCSP = { connect_domains: [], resource_domains: [] };
  if (redirectOrigin) legacyWidgetCSP.redirect_domains = [redirectOrigin];
  server.registerResource(
    'mindmap_widget',
    WIDGET_URI,
    {
      title: 'Mind map view',
      description: 'Interactive visual rendering of a MindSpark map',
      mimeType: 'text/html;profile=mcp-app'
    },
    async () => ({
      contents: [{
        uri: WIDGET_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: widgetHTML,
        _meta: {
          ui: { csp: widgetCSP },
          // Legacy ChatGPT-specific compatibility keys (snake_case), kept alongside
          // the standard ui.csp key above for broader host/version compatibility.
          'openai/widgetCSP': legacyWidgetCSP,
          'openai/widgetDomain': 'https://chatgpt.com',
          'openai/widgetPrefersBorder': true
        }
      }]
    })
  );

  server.registerTool('list_maps', {
    title: 'List MindSpark maps',
    description: 'List all of the user\'s mind maps, with id, title, and last-updated time.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => {
    try {
      const index = await store.listMaps();
      if (index.length === 0) return text('No maps found.');
      const lines = index
        .sort((a, b) => (b.updated || 0) - (a.updated || 0))
        .map(m => `${m.title || '(untitled)'}  [id: ${m.id}]  updated ${new Date(m.updated || 0).toISOString()}`);
      return text(lines.join('\n'));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('get_map', {
    title: 'Get a MindSpark map',
    description: 'Fetch a mind map by id and render it as an indented outline, so its structure and content are readable at a glance.',
    inputSchema: { id: z.string().describe('The map id, from list_maps') },
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ id }) => {
    try {
      const map = await store.getMap(id);
      if (!map) return errorResult(new Error(`No map with id ${id}`));
      return text(renderOutline(map));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('render_map', {
    title: 'Show a visual mind map',
    description:
      'Render a mind map as an interactive visual diagram inline in the conversation, instead of ' +
      'plain text. Use this when the user asks to see, view, or visualize a map — get_map is ' +
      'better when you just need to read or reason about its contents.',
    inputSchema: { id: z.string().describe('The map id, from list_maps') },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: {
      'openai/outputTemplate': WIDGET_URI,
      'openai/toolInvocation/invoking': 'Rendering map…',
      'openai/toolInvocation/invoked': 'Map rendered',
      'openai/widgetAccessible': true,
      'openai/resultCanProduceWidget': true,
      ui: { resourceUri: WIDGET_URI }
    }
  }, async ({ id }) => {
    try {
      const map = await store.getMap(id);
      if (!map) return errorResult(new Error(`No map with id ${id}`));
      // A universally-viewable share link (same "#view=" encoding the no-login
      // server uses) rather than a "?map=<id>" deep link, which only opens
      // correctly for the same GitHub identity that owns the map — anyone this
      // gets shared with would otherwise hit a sign-in wall instead of the map.
      const shareUrl = appUrl ? buildShareUrl(appUrl, await buildShareToken(map)) : undefined;
      const structuredContent = { ...widgetPayload(map), appUrl, shareUrl };
      return {
        content: [{ type: 'text', text: `Showing "${map.title}" (${Object.keys(map.nodes).length} nodes).` }],
        structuredContent,
        _meta: {
          'openai/outputTemplate': WIDGET_URI,
          'openai/widgetAccessible': true,
          'openai/resultCanProduceWidget': true,
          ui: { resourceUri: WIDGET_URI }
        }
      };
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('create_map', {
    title: 'Create a MindSpark map from an outline',
    description:
      'Create a new mind map from a Markdown outline (headings and/or nested bullets). ' +
      'This is the preferred way to build a map from scratch — write normal Markdown ' +
      '(the way you already would) rather than constructing nodes one at a time. ' +
      'The first line becomes the map\'s central topic. Supports **bold**, *italic*, and `code`.',
    inputSchema: {
      outline: z.string().describe('Markdown outline: headings (#, ##, ###) and/or nested bullets (-, *), indented 2 spaces per level'),
      title: z.string().optional().describe('Override the map title (defaults to the outline\'s first line)')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ outline, title }) => {
    try {
      const map = outlineToMap(outline, title);
      // Nodes here have no x/y at all — app.js's loadMap() only auto-runs
      // autoLayout() (which computes real, non-overlapping positions) when this
      // flag is set; without it the map would open with every node stacked at
      // an undefined position. This is a one-shot flag app.js itself deletes
      // right after using it, so it only affects this map's very first open.
      map._import = true;
      await store.saveMap(map);
      return text(`Created "${map.title}"  [id: ${map.id}], ${Object.keys(map.nodes).length} nodes.\n\n${renderOutline(map)}`);
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('add_node', {
    title: 'Add a node to a MindSpark map',
    description: 'Add a single new node under an existing node in a map. Use get_map first to find the parent node\'s id.',
    inputSchema: {
      mapId: z.string(),
      parentId: z.string().describe('id of the node this new node should nest under'),
      text: z.string().describe('Node text. Supports basic HTML tags: <b>, <i>, <u>, <s>. For multi-line content (used with listType), separate lines with <br> or \\n.'),
      color: z.string().optional().describe('Optional hex color for the node. For a look that matches MindSpark\'s own palette, use one of its built-in light node colors: #ffe2d6 (peach), #ffedc2 (cream), #dcefce (mint), #cfe9e6 (teal), #d8e0fb (lavender), #efd9f2 (pink), #e9e2d6 (beige) — or any other hex value for a custom color.'),
      listType: z.enum(['ul', 'ol']).optional().describe('Render the node\'s text as a bulleted (ul) or numbered (ol) list — each line becomes one list item.'),
      task: z.enum(['todo', 'doing', 'done']).optional().describe('Show a task checkbox on the node. "done" also renders the text struck through.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ mapId, parentId, text: nodeText, color, listType, task }) => {
    try {
      const map = await store.getMap(mapId);
      if (!map) return errorResult(new Error(`No map with id ${mapId}`));
      const parent = map.nodes[parentId];
      if (!parent) return errorResult(new Error(`No node with id ${parentId} in this map`));
      const id = Math.random().toString(36).slice(2, 9);
      map.nodes[id] = { id, text: nodeText, parent: parentId };
      if (color) map.nodes[id].color = color;
      if (listType) map.nodes[id].listType = listType;
      if (task) map.nodes[id].task = task;
      // Give the new node a real position near its parent rather than leaving
      // x/y unset — app.js only auto-runs a full relayout on a map's very first
      // open (see create_map's _import flag above), and forcing that here on
      // every add_node call would discard any manual positioning already done
      // on the rest of the map. This is an approximation, not a real layout —
      // offset below the parent, staggered by existing sibling count so
      // repeated additions don't all stack on the same spot.
      if (typeof parent.x === 'number' && typeof parent.y === 'number') {
        const siblingCount = Object.values(map.nodes).filter(n => n.parent === parentId).length - 1;
        map.nodes[id].x = parent.x + 220;
        map.nodes[id].y = parent.y + siblingCount * 50;
      }
      await store.saveMap(map);
      return text(`Added node [id: ${id}] under [id: ${parentId}].`);
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('update_node', {
    title: 'Update a MindSpark node',
    description: 'Change the text, color, list style, or task status of an existing node.',
    inputSchema: {
      mapId: z.string(),
      nodeId: z.string(),
      text: z.string().optional().describe('New node text. For multi-line content (used with listType), separate lines with <br> or \\n.'),
      color: z.string().optional().describe('Hex color for the node. For a look that matches MindSpark\'s own palette, use one of its built-in light node colors: #ffe2d6 (peach), #ffedc2 (cream), #dcefce (mint), #cfe9e6 (teal), #d8e0fb (lavender), #efd9f2 (pink), #e9e2d6 (beige) — or any other hex value for a custom color. Pass "#ffffff" to clear back to the default.'),
      listType: z.enum(['ul', 'ol', 'none']).optional().describe('Render the node\'s text as a bulleted (ul) or numbered (ol) list — each line becomes one item. Pass "none" to remove list formatting.'),
      task: z.enum(['todo', 'doing', 'done', 'none']).optional().describe('Show a task checkbox on the node. "done" also renders the text struck through. Pass "none" to remove the checkbox.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ mapId, nodeId, text: nodeText, color, listType, task }) => {
    try {
      const map = await store.getMap(mapId);
      if (!map) return errorResult(new Error(`No map with id ${mapId}`));
      const node = map.nodes[nodeId];
      if (!node) return errorResult(new Error(`No node with id ${nodeId} in this map`));
      if (nodeText !== undefined) node.text = nodeText;
      if (color !== undefined) node.color = color;
      if (listType !== undefined) node.listType = listType === 'none' ? null : listType;
      if (task !== undefined) node.task = task === 'none' ? null : task;
      await store.saveMap(map);
      return text(`Updated node [id: ${nodeId}].`);
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('delete_node', {
    title: 'Delete a MindSpark node',
    description: 'Delete a node and its entire subtree. Cannot delete the root node — delete the whole map instead.',
    inputSchema: { mapId: z.string(), nodeId: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ mapId, nodeId }) => {
    try {
      const map = await store.getMap(mapId);
      if (!map) return errorResult(new Error(`No map with id ${mapId}`));
      if (nodeId === map.rootId) return errorResult(new Error('Cannot delete the root node — use delete_map instead'));
      if (!map.nodes[nodeId]) return errorResult(new Error(`No node with id ${nodeId} in this map`));
      // Cascade: collect the node and every descendant before removing any of them,
      // matching the app's own delete semantics (deleting a branch removes the branch).
      const toRemove = new Set([nodeId]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const n of Object.values(map.nodes)) {
          if (n.parent && toRemove.has(n.parent) && !toRemove.has(n.id)) { toRemove.add(n.id); grew = true; }
        }
      }
      for (const id of toRemove) delete map.nodes[id];
      await store.saveMap(map);
      return text(`Deleted node [id: ${nodeId}] and ${toRemove.size - 1} descendant(s).`);
    } catch (e) { return errorResult(e); }
  });

  server.registerTool('delete_map', {
    title: 'Delete a MindSpark map',
    description: 'Permanently delete an entire map. This cannot be undone through this tool (the file history remains in git, recoverable manually).',
    inputSchema: { id: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ id }) => {
    try {
      await store.deleteMap(id);
      return text(`Deleted map [id: ${id}].`);
    } catch (e) { return errorResult(e); }
  });

  return server;
}

async function main() {
  let store;
  try { store = resolveStoreFromEnv(); }
  catch (e) { console.error(e.message); process.exit(1); }
  const server = await createServer(store, { appUrl: process.env.MINDSPARK_APP_URL });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mindspark-mcp running on stdio');
}

// Only auto-start when run directly (`node server.js` / the bin entry) — not when
// imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}
