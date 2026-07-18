// Radial layout matching MindSpark's own canvas layout convention (public/app.js
// autoLayout/drawEdges/balanceRootSides): root centered, direct children balanced
// across left and right branches in a contiguous first-half/second-half split
// (matching balanceRootSides — the app's own "fresh/imported map" arrangement,
// which is the right comparison here since this layout is always computed fresh,
// with no persisted per-node side to preserve the way an edited map has), and
// every descendant inheriting its branch's side. Each side is laid out as its own
// tidy-tree stack (parent vertically centered over its own children) using each
// node's ACTUAL height, so multi-line wrapped text or list/task content doesn't
// overlap its neighbors.
//
// Pure function: no DOM, no globals — takes a plain node map and returns plain
// coordinates, so it's usable both in the widget and in isolation under a test.

export const NODE_W = 150;
export const NODE_H = 40;
export const ROOT_W = 170;
export const ROOT_H = 48;
export const H_GAP = 50;   // horizontal gap between depth tiers
export const V_GAP = 12;   // vertical gap between sibling rows

/**
 * @param {object} nodes
 * @param {string} rootId
 * @param {Set<string>|string[]} [collapsedIds] - node ids whose children should be
 *   excluded from the layout entirely (not just visually hidden) — collapsing a
 *   large branch actually frees up the space it would have occupied, matching
 *   app.js's own autoLayout behavior for a collapsed node.
 * @param {object} [nodeHeights] - {id: height} for nodes whose content needs more
 *   than one line (wrapped text, list items, etc.) — falls back to NODE_H/ROOT_H
 *   for any node not present here, so this is entirely optional.
 */
export function layoutTree(nodes, rootId, collapsedIds, nodeHeights) {
  if (!nodes || !rootId || !nodes[rootId]) return { positions: {}, width: 0, height: 0, hasChildren: {} };
  const collapsed = collapsedIds instanceof Set ? collapsedIds : new Set(collapsedIds || []);
  const heights = nodeHeights || {};
  const heightOf = id => heights[id] ?? (id === rootId ? ROOT_H : NODE_H);

  const childrenOf = {};
  for (const id in nodes) {
    const p = nodes[id].parent;
    if (p != null) (childrenOf[p] ||= []).push(id);
  }
  // Tracked separately from the collapse-aware traversal below — a collapsed
  // node's children are excluded from layout/positioning, but the toggle button
  // still needs to know the node HAD children in the first place.
  const hasChildren = {};
  for (const id in childrenOf) hasChildren[id] = childrenOf[id].length > 0;

  const visited = new Set();
  const depth = {};
  const side = {};
  (function assignDepthAndSide(id, d) {
    if (visited.has(id)) return;
    visited.add(id);
    depth[id] = d;
    const kids = collapsed.has(id) ? [] : (childrenOf[id] || []);
    if (id === rootId) {
      // Contiguous first-half/second-half split, matching app.js's
      // balanceRootSides() exactly — the "fresh view" arrangement, not
      // autoLayout()'s separate incremental-balance rule used for ongoing edits
      // (that one only makes sense with persisted per-node side state to keep
      // stable across edits, which this layout — always computed fresh — has
      // no equivalent of).
      const half = Math.ceil(kids.length / 2);
      kids.forEach((c, i) => { side[c] = i < half ? 'right' : 'left'; assignDepthAndSide(c, d + 1); });
    } else {
      for (const c of kids) { side[c] = side[id]; assignDepthAndSide(c, d + 1); }
    }
  })(rootId, 0);

  const positions = {};
  positions[rootId] = { x: 0, y: 0, w: ROOT_W, h: heightOf(rootId) };

  // Lay out one side (the root's direct children on that side, and everything
  // beneath them) as an independent tidy-tree stack, returning the y-range it
  // occupied so both sides can be centered against each other afterward. Each
  // node's OWN height drives how far the cursor advances, so taller (wrapped)
  // nodes correctly push their neighbors down rather than overlapping them.
  function layoutSide(topLevelIds, sign) {
    let cursor = 0;
    function place(id, d) {
      const kids = collapsed.has(id) ? [] : (childrenOf[id] || []).filter(c => depth[c] === depth[id] + 1);
      const x = sign * (ROOT_W / 2 + H_GAP + (d - 1) * (NODE_W + H_GAP) + NODE_W / 2);
      const h = heightOf(id);
      if (kids.length === 0) {
        const y = cursor + h / 2;
        positions[id] = { x, y, w: NODE_W, h };
        cursor += h + V_GAP;
        return y;
      }
      const childYs = kids.map(c => place(c, d + 1));
      const y = (childYs[0] + childYs[childYs.length - 1]) / 2;
      positions[id] = { x, y, w: NODE_W, h };
      return y;
    }
    for (const id of topLevelIds) place(id, 1);
    return cursor > 0 ? cursor - V_GAP : 0;   // total height this side occupied (no trailing gap)
  }

  const rightTop = (childrenOf[rootId] || []).filter(c => side[c] === 'right');
  const leftTop = (childrenOf[rootId] || []).filter(c => side[c] === 'left');
  const rightHeight = layoutSide(rightTop, 1);
  const leftHeight = layoutSide(leftTop, -1);

  // Center each side's stack around y=0 independently (a side with more content
  // shouldn't drag the root or the other side off-center), matching the visual
  // balance a real radial mind map has.
  function recenter(ids, totalHeight) {
    const offset = totalHeight / 2;
    for (const id of ids) if (positions[id]) positions[id].y -= offset;
  }
  const rightIds = Object.keys(depth).filter(id => side[id] === 'right');
  const leftIds = Object.keys(depth).filter(id => side[id] === 'left');
  recenter(rightIds, rightHeight);
  recenter(leftIds, leftHeight);

  const maxDepth = Math.max(0, ...Object.values(depth));
  const halfWidth = ROOT_W / 2 + H_GAP + maxDepth * (NODE_W + H_GAP);
  const width = halfWidth * 2;
  const allTops = Object.values(positions).map(p => p.y - p.h / 2);
  const allBottoms = Object.values(positions).map(p => p.y + p.h / 2);
  const height = allTops.length ? Math.max(...allBottoms) - Math.min(...allTops) : heightOf(rootId);

  // Shift everything into positive coordinate space (0,0 at top-left) — the
  // renderer works in a plain, non-negative viewBox rather than one centered on
  // the root, so the caller doesn't need to know about the radial origin.
  const minX = Math.min(...Object.values(positions).map(p => p.x - p.w / 2));
  const minY = Math.min(...Object.values(positions).map(p => p.y - p.h / 2));
  for (const id in positions) { positions[id].x -= minX; positions[id].y -= minY; }

  return { positions, width, height, depth, side, childrenOf, hasChildren };
}
