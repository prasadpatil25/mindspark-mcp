import { outlineToMap } from '../../src/outline-parser.js';

const DEFAULT_MAP_COLOR = '#e0613a';   // same default app.js itself uses (PALETTE[0])

/**
 * Builds a full, share-link-ready map from a Markdown outline. Node x/y/side are
 * deliberately left unset — MindSpark's own shared-view loader (tryEnterSharedView
 * in app.js) runs autoLayout() itself right after decoding, exactly as it would
 * for a freshly created map made in the app directly, so there's no need to
 * replicate that positioning logic here.
 *
 * @param {string} outline
 * @param {{title?: string, color?: string}} [opts]
 */
export function buildShareableMap(outline, opts = {}) {
  const { id, title, rootId, nodes } = outlineToMap(outline, opts.title);
  return {
    id, title, rootId, nodes,
    color: opts.color || DEFAULT_MAP_COLOR,
    style: undefined,
    layout: 'balanced',
    links: [],
    vars: {}
  };
}
