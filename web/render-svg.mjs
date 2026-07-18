import { layoutTree, NODE_W, NODE_H, ROOT_W, ROOT_H } from './layout.mjs';
import { buildDisplayLines, heightForLines } from './text-layout.mjs';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Pulled directly from public/app.js — same default palette (const PALETTE) and
// the same root-node default accent ('#e0613a', PALETTE[0]) used when a map has
// no explicit map.color set.
const DEFAULT_ROOT_COLOR = '#e0613a';
const INK = '#23201b';        // --ink (light theme) — MindSpark always pairs custom
                               // node colors with this exact dark text, no contrast
                               // computation, matching app.js's coloring logic exactly.
const LINE = '#d8cfbf';       // --line (light theme), the default node border color
const NODE_BG_LIGHT = '#ffffff', NODE_INK_LIGHT = '#23201b';   // --node-bg/--node-ink light
const NODE_BG_DARK = '#2d2d2d', NODE_INK_DARK = '#d4d4d4';     // --node-bg/--node-ink dark
const LINE_DARK = '#3c3c3c';

const SANS = 'ui-sans-serif,system-ui,-apple-system,sans-serif';   // "Bricolage Grotesque" fallback stack
const SERIF = "Georgia,'Times New Roman',serif";                    // "Fraunces" fallback stack
const LINE2 = '#c8bda8', LINE2_DARK = '#4a4a4a';   // --line-2, used for the collapse toggle's border

// Task checkbox — pulled directly from public/styles.css's .task-check rules.
const TASK_SIZE = 14;              // scaled down from app.js's 18px (that's tuned for a full-size
                                    // canvas node; this widget's nodes are smaller)
const TASK_DOING_COLOR = '#c98a1a';
const TASK_DONE_COLOR = '#4a9d5b';

const LINE_HEIGHT_REGULAR = 15;
const LINE_HEIGHT_ROOT = 18;

// Approximate characters-per-line for word-wrap, tuned per font/size — no real
// font metrics are available outside a browser, so these are estimates based on
// each font's typical average character width at its rendered size, not a
// measured value. Good enough for a quick-glance widget, not typographically exact.
const MAX_CHARS_REGULAR = 20;
const MAX_CHARS_ROOT = 17;
const MAX_LINES = 4;

/**
 * @param {object} nodes - {id: {text, parent, color, listType, task}}
 * @param {string} rootId
 * @param {{padding?: number, mapColor?: string, collapsedIds?: Set<string>|string[]}} [opts]
 * @returns {{svg: string, width: number, height: number, nodeCount: number}}
 */
export function renderMindMapSVG(nodes, rootId, opts = {}) {
  const pad = opts.padding ?? 20;
  const collapsedIds = opts.collapsedIds instanceof Set ? opts.collapsedIds : new Set(opts.collapsedIds || []);

  // First pass: figure out how many lines each node's content actually needs
  // (word-wrap + list-item splitting), and the height that requires, BEFORE
  // layout runs — so the layout can reserve the right amount of vertical space
  // and nothing overlaps.
  const displayLines = {};
  const nodeHeights = {};
  for (const id in nodes) {
    const n = nodes[id];
    const isRoot = id === rootId;
    const hasTask = !!n.task;
    const maxChars = (isRoot ? MAX_CHARS_ROOT : MAX_CHARS_REGULAR) - (hasTask ? 4 : 0);
    const { lines } = buildDisplayLines(n.text, n.listType, Math.max(6, maxChars), MAX_LINES);
    displayLines[id] = lines;
    const baseH = isRoot ? ROOT_H : NODE_H;
    const lineH = isRoot ? LINE_HEIGHT_ROOT : LINE_HEIGHT_REGULAR;
    nodeHeights[id] = heightForLines(lines.length, baseH, lineH);
  }

  const { positions, width, height, side, hasChildren } = layoutTree(nodes, rootId, collapsedIds, nodeHeights);
  const ids = Object.keys(positions);
  const rootColor = opts.mapColor || DEFAULT_ROOT_COLOR;

  let edges = '';
  let boxes = '';
  let toggles = '';
  for (const id of ids) {
    const n = nodes[id];
    const p = positions[id];
    const isRoot = id === rootId;

    if (!isRoot && n.parent != null && positions[n.parent]) {
      const pp = positions[n.parent];
      const leftSide = side[id] === 'left';
      const x1 = leftSide ? pp.x - pp.w / 2 : pp.x + pp.w / 2;
      const y1 = pp.y;
      const x2 = leftSide ? p.x + p.w / 2 : p.x - p.w / 2;
      const y2 = p.y;
      // Identical control-point formula to public/app.js's edgePath() 'modern' case.
      const dx = Math.abs(x2 - x1) * 0.5;
      edges += `<path d="M${x1},${y1} C${x1 + (leftSide ? -dx : dx)},${y1} ${x2 + (leftSide ? dx : -dx)},${y2} ${x2},${y2}" class="edge"/>`;
    }

    let fill, textColor, extraClass = '', strokeAttr;
    if (isRoot) {
      fill = rootColor; textColor = '#fff'; extraClass = ' root'; strokeAttr = 'none';
    } else if (n.color && n.color !== '#fff' && n.color !== '#ffffff') {
      fill = n.color; textColor = INK; strokeAttr = LINE;
    } else {
      fill = null; textColor = null; extraClass = ' default-bg'; strokeAttr = null;
    }

    const rectClasses = [];
    let rectFillAttr = '', rectStrokeAttr = '';
    if (fill) { rectFillAttr = ` fill="${esc(fill)}"`; } else { rectClasses.push('rect-default-fill'); }
    if (strokeAttr === 'none') { rectStrokeAttr = ' stroke="none"'; }
    else if (strokeAttr) { rectStrokeAttr = ` stroke="${strokeAttr}" stroke-width="1.5"`; }
    else if (!isRoot) { rectClasses.push('rect-default-stroke'); rectStrokeAttr = ' stroke-width="1.5"'; }
    const rectClassAttr = rectClasses.length ? ` class="${rectClasses.join(' ')}"` : '';
    const textFillAttr = textColor ? ` fill="${textColor}"` : ' class="text-default-fill"';
    const font = isRoot ? SERIF : SANS;
    const fontWeight = isRoot ? 700 : 500;
    const fontSize = isRoot ? 15 : 12.5;
    const lineH = isRoot ? LINE_HEIGHT_ROOT : LINE_HEIGHT_REGULAR;

    const lines = displayLines[id] || [''];
    const hasTask = !!n.task;
    // Task nodes shift text right to make room for the checkbox, and get a
    // strikethrough + faded appearance when done — matching
    // .node.task-done .node-text{text-decoration:line-through;opacity:.62} exactly.
    const textShift = hasTask ? (TASK_SIZE / 2 + 5) : 0;
    const isDone = n.task === 'done';
    const textOpacityAttr = isDone ? ' opacity="0.62"' : '';
    const textDecorationAttr = isDone ? ' text-decoration="line-through"' : '';

    // Vertically center the whole line block within the node's (possibly grown)
    // height: first line's baseline sits lineH above the node's own vertical
    // center for a 1-line node, shifting up further per extra line.
    const blockCenterOffset = ((lines.length - 1) * lineH) / 2;
    let tspans = '';
    lines.forEach((lineText, i) => {
      const dy = i === 0 ? (fontSize / 3 - blockCenterOffset) : lineH;
      tspans += `<tspan x="${p.x + textShift}" dy="${dy}">${esc(lineText)}</tspan>`;
    });

    boxes += `<g class="node${extraClass}" data-id="${esc(id)}">` +
      `<rect x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="12"${rectClassAttr}${rectFillAttr}${rectStrokeAttr}/>`;

    if (hasTask) {
      const cbX = p.x - p.w / 2 + 10, cbY = p.y;
      let cbFillAttr = '', cbStrokeAttr = '', cbTextAttr = '', cbClasses = [];
      if (n.task === 'done') { cbFillAttr = ` fill="${TASK_DONE_COLOR}"`; cbStrokeAttr = ` stroke="${TASK_DONE_COLOR}"`; cbTextAttr = ' fill="#fff"'; }
      else if (n.task === 'doing') { cbClasses.push('task-bg-default'); cbStrokeAttr = ` stroke="${TASK_DOING_COLOR}"`; cbTextAttr = ` fill="${TASK_DOING_COLOR}"`; }
      else { cbClasses.push('task-bg-default', 'task-border-default'); }
      const cbClassAttr = cbClasses.length ? ` class="${cbClasses.join(' ')}"` : '';
      const cbIcon = n.task === 'done' ? '\u2713' : (n.task === 'doing' ? '\u25D1' : '');
      boxes += `<rect x="${cbX - TASK_SIZE / 2}" y="${cbY - TASK_SIZE / 2}" width="${TASK_SIZE}" height="${TASK_SIZE}" rx="4"${cbClassAttr}${cbFillAttr}${cbStrokeAttr} stroke-width="1.5"/>`;
      if (cbIcon) boxes += `<text x="${cbX}" y="${cbY + 3.5}" text-anchor="middle" font-size="10" font-weight="700"${cbTextAttr}>${cbIcon}</text>`;
    }

    boxes += `<text x="${p.x + textShift}" y="${p.y}" text-anchor="middle" font-family="${esc(font)}" font-weight="${fontWeight}" font-size="${fontSize}"${textFillAttr}${textOpacityAttr}${textDecorationAttr}>${tspans}</text>` +
      `</g>`;

    // Collapse/expand toggle — matches app.js's .h-collapse exactly: 18px circle
    // straddling the node's outer edge (right for root/right-side branches, left
    // for left-side branches), accent-filled with a '+' when collapsed, neutral
    // with a '−' when expanded. Drawn for any node that HAS children, even while
    // collapsed (hasChildren reflects the original structure, not the current
    // layout — a collapsed node's children aren't in `positions` at all).
    if (hasChildren[id]) {
      const leftSide = !isRoot && side[id] === 'left';
      const tx = leftSide ? p.x - p.w / 2 : p.x + p.w / 2;
      const ty = p.y;
      const isCollapsed = collapsedIds.has(id);
      const toggleFill = isCollapsed ? rootColor : null;
      const toggleClasses = [];
      let toggleFillAttr = '', toggleStrokeAttr = '', toggleTextAttr = '';
      if (toggleFill) { toggleFillAttr = ` fill="${esc(toggleFill)}"`; toggleStrokeAttr = ` stroke="${esc(toggleFill)}"`; toggleTextAttr = ' fill="#fff"'; }
      else { toggleClasses.push('toggle-default-fill', 'toggle-default-stroke'); toggleStrokeAttr = ' stroke-width="1.5"'; }
      const toggleClassAttr = toggleClasses.length ? ` class="${toggleClasses.join(' ')}"` : '';
      const toggleTextClassAttr = toggleTextAttr ? '' : ' class="toggle-default-text"';
      toggles += `<g class="toggle" data-toggle-id="${esc(id)}">` +
        `<circle cx="${tx}" cy="${ty}" r="9"${toggleClassAttr}${toggleFillAttr}${toggleStrokeAttr}/>` +
        `<text x="${tx}" y="${ty + 4.5}" text-anchor="middle" font-size="13" font-weight="700"${toggleTextAttr}${toggleTextClassAttr}>${isCollapsed ? '+' : '\u2212'}</text>` +
        `</g>`;
    }
  }

  const totalW = width + pad * 2, totalH = height + pad * 2;
  const svg =
    `<svg viewBox="${-pad} ${-pad} ${totalW} ${totalH}" width="${totalW}" height="${totalH}" ` +
    `xmlns="http://www.w3.org/2000/svg">` +
    `<style>` +
    `.rect-default-fill{fill:${NODE_BG_LIGHT}} .rect-default-stroke{stroke:${LINE}} .text-default-fill{fill:${NODE_INK_LIGHT}}` +
    `.edge{fill:none;stroke:${LINE};stroke-width:2.2;stroke-linecap:round}` +
    `.toggle{cursor:pointer} .toggle-default-fill{fill:${NODE_BG_LIGHT}} .toggle-default-stroke{stroke:${LINE2}} .toggle-default-text{fill:${INK}}` +
    `.toggle text{pointer-events:none}` +
    `.task-bg-default{fill:${NODE_BG_LIGHT}} .task-border-default{stroke:${LINE2}}` +
    `@media (prefers-color-scheme: dark) {` +
    `.rect-default-fill{fill:${NODE_BG_DARK}} .rect-default-stroke{stroke:${LINE_DARK}} .text-default-fill{fill:${NODE_INK_DARK}}` +
    `.edge{stroke:${LINE_DARK}}` +
    `.toggle-default-fill{fill:${NODE_BG_DARK}} .toggle-default-stroke{stroke:${LINE2_DARK}} .toggle-default-text{fill:${NODE_INK_DARK}}` +
    `.task-bg-default{fill:${NODE_BG_DARK}} .task-border-default{stroke:${LINE2_DARK}}` +
    `}` +
    `</style>` +
    `<g class="edges">${edges}</g><g class="boxes">${boxes}</g><g class="toggles">${toggles}</g></svg>`;

  return { svg, width: totalW, height: totalH, nodeCount: ids.length };
}

export { NODE_W, NODE_H, ROOT_W, ROOT_H };
