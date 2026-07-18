import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildShareableMap } from './map-builder.js';
import { buildShareToken, buildShareUrl } from '../../src/share-link.js';

const WIDGET_URI = 'ui://widget/mindmap.html';

function text(s) { return { content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 2) }] }; }
function errorResult(e) { return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }; }

/**
 * @param {{appUrl: string, widgetHTML: string}} opts - appUrl is REQUIRED here
 *   (unlike the other two servers, where it only enables an optional "open in
 *   MindSpark" link) — the share link this server produces IS <appUrl>/#view=...,
 *   so there is nothing useful this tool can return without it.
 */
export function createServer(opts) {
  if (!opts || !opts.appUrl) throw new Error('createServer requires opts.appUrl — the share links this server produces are built from it');
  if (!opts.widgetHTML) throw new Error('createServer requires opts.widgetHTML');
  const appUrl = opts.appUrl.replace(/\/+$/, '');

  const server = new McpServer({ name: 'mindspark-mcp-no-login', version: '1.0.0' });

  // Same CSP shape as the other two servers' widget resource: this widget makes
  // no external network calls at all, except navigating to the MindSpark app
  // itself for the "Open in MindSpark" link, so redirectDomains is scoped to
  // exactly that one origin and nothing else is allowed.
  let redirectOrigin = null;
  try { redirectOrigin = new URL(appUrl).origin; } catch (e) { /* validated non-empty above; a malformed URL just means no redirect allowlist */ }
  const widgetCSP = { connectDomains: [], resourceDomains: [] };
  if (redirectOrigin) widgetCSP.redirectDomains = [redirectOrigin];
  const legacyWidgetCSP = { connect_domains: [], resource_domains: [] };
  if (redirectOrigin) legacyWidgetCSP.redirect_domains = [redirectOrigin];

  server.registerResource(
    'mindmap_widget',
    WIDGET_URI,
    { title: 'Mind map view', description: 'Interactive visual rendering of a MindSpark map', mimeType: 'text/html;profile=mcp-app' },
    async () => ({
      contents: [{
        uri: WIDGET_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: opts.widgetHTML,
        _meta: {
          ui: { csp: widgetCSP },
          'openai/widgetCSP': legacyWidgetCSP,
          'openai/widgetDomain': 'https://chatgpt.com',
          'openai/widgetPrefersBorder': true
        }
      }]
    })
  );

  server.registerTool('create_map', {
    title: 'Create and show a mind map — no sign-in required',
    description:
      'Create a mind map from a Markdown outline (headings and/or nested bullets, like create_map ' +
      'in the full MindSpark connector) and immediately render it. Works without any GitHub account ' +
      'or sign-in: nothing is stored on any server — the whole map is encoded directly into a ' +
      'read-only link, which anyone can open in MindSpark to view. There\'s no id to edit it further ' +
      'later; to change something, call this again with an updated outline, which produces a new link.',
    inputSchema: {
      outline: z.string().describe('Markdown outline: headings (#, ##, ###) and/or nested bullets (-, *), indented 2 spaces per level'),
      title: z.string().optional().describe('Override the map title (defaults to the outline\'s first line)'),
      color: z.string().optional().describe('Hex color for the root/accent, e.g. "#3a6ea5". Defaults to MindSpark\'s own default accent.')
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: {
      'openai/outputTemplate': WIDGET_URI,
      'openai/toolInvocation/invoking': 'Building your mind map…',
      'openai/toolInvocation/invoked': 'Map ready',
      'openai/widgetAccessible': true,
      'openai/resultCanProduceWidget': true,
      ui: { resourceUri: WIDGET_URI }
    }
  }, async ({ outline, title, color }) => {
    try {
      const map = buildShareableMap(outline, { title, color });
      const token = await buildShareToken(map);
      const shareUrl = buildShareUrl(appUrl, token);

      const nodes = {};
      for (const id in map.nodes) {
        const n = map.nodes[id];
        nodes[id] = { text: n.text, parent: n.parent, color: n.color };
      }
      const nodeCount = Object.keys(nodes).length;
      const lengthNote = shareUrl.length > 12000
        ? ' (this is a fairly long link — very long share links may not open in every browser/client)'
        : '';

      return {
        content: [{ type: 'text', text: `Created "${map.title}" (${nodeCount} nodes). Read-only link: ${shareUrl}${lengthNote}` }],
        structuredContent: { id: map.id, title: map.title, rootId: map.rootId, color: map.color, nodes, shareUrl },
        _meta: {
          'openai/outputTemplate': WIDGET_URI,
          'openai/widgetAccessible': true,
          'openai/resultCanProduceWidget': true,
          ui: { resourceUri: WIDGET_URI }
        }
      };
    } catch (e) { return errorResult(e); }
  });

  return server;
}
