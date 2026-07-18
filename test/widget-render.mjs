import { JSDOM } from 'jsdom';
import { XMLValidator } from 'fast-xml-parser';
import { renderMindMapSVG, NODE_H as NODE_H_FOR_TEST } from '../web/render-svg.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

// Matches render-svg.mjs's own DEFAULT_ROOT_COLOR constant (not exported, so
// duplicated here as a known value to check against).
const DEFAULT_ROOT_COLOR_FOR_TEST = '#e0613a';

function parseXML(svg) {
  const dom = new JSDOM('<!DOCTYPE html><body></body>');
  const container = dom.window.document.createElement('div');
  container.innerHTML = svg;
  return { doc: dom.window.document, container };
}

// JSDOM parses SVG embedded via innerHTML using lenient HTML rules, and will
// silently "recover" from things that are not actually valid XML/SVG — a real
// browser's SVG parser (and ChatGPT's sandboxed renderer) may not. Caught two real
// bugs this way during development (an unescaped quote inside an attribute value
// that silently truncated everything after it, and a duplicate class attribute on
// one element) that JSDOM-based checks alone did not catch. Every generated SVG
// gets this check in addition to the JSDOM structural checks below.
function checkStrictlyWellFormed(svg, label) {
  const result = XMLValidator.validate(svg);
  check(label, result === true, result === true ? undefined : result.err);
}

console.log('\n=== Text geometry: labels actually render at their OWN node\'s position, not bunched together ===');
{
  // This is a direct regression test for a real bug that shipped: the <text>
  // element had no y attribute at all, so every tspan's dy (a relative offset)
  // had nothing real to offset from, and every node's label rendered near the
  // document's default position instead of at that node's own location —
  // invisible to textContent-only checks (which don't care about geometry),
  // caught only by an actual screenshot from live use.
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'Top', parent: 'r' },
    b: { text: 'Middle', parent: 'r' },
    c: { text: 'Bottom', parent: 'r' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  const { container } = parseXML(svg);
  for (const id of ['r', 'a', 'b', 'c']) {
    const rect = container.querySelector(`[data-id="${id}"] rect`);
    const textEl = container.querySelector(`[data-id="${id}"] > text`);
    check(`${id}: <text> element has an explicit y attribute (not relying on an undefined default)`, textEl.hasAttribute('y'), textEl.outerHTML);
    const rectCenterY = parseFloat(rect.getAttribute('y')) + parseFloat(rect.getAttribute('height')) / 2;
    const textY = parseFloat(textEl.getAttribute('y'));
    check(`${id}: text y position is close to its own node's actual vertical center`, Math.abs(textY - rectCenterY) < 15, { textY, rectCenterY });
  }
  const textYs = ['a', 'b', 'c'].map(id => parseFloat(container.querySelector(`[data-id="${id}"] > text`).getAttribute('y')));
  check('siblings at different vertical positions get DIFFERENT text y values (not all bunched at the same spot)', new Set(textYs).size === 3, textYs);
}

console.log('\n=== Text geometry: multi-line wrapped text also positions correctly, not just single-line ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'This label is long enough that it needs to wrap across multiple lines to fit', parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  const { container } = parseXML(svg);
  const rect = container.querySelector('[data-id="a"] rect');
  const textEl = container.querySelector('[data-id="a"] > text');
  const rectTop = parseFloat(rect.getAttribute('y'));
  const rectBottom = rectTop + parseFloat(rect.getAttribute('height'));
  const textY = parseFloat(textEl.getAttribute('y'));
  check('wrapped text\'s anchor y falls within its own (taller) node box, not outside it', textY >= rectTop && textY <= rectBottom, { textY, rectTop, rectBottom });
  const tspanXs = [...textEl.querySelectorAll('tspan')].map(t => parseFloat(t.getAttribute('x')));
  check('every tspan shares the same x (centered consistently, not drifting line to line)', new Set(tspanXs).size === 1, tspanXs);
}

console.log('\n=== Basic structure ===');
{
  const nodes = { r: { text: 'Root Topic', parent: null }, a: { text: 'Child A', parent: 'r' }, b: { text: 'Child B', parent: 'r' } };
  const { svg, nodeCount } = renderMindMapSVG(nodes, 'r');
  check('nodeCount is 3', nodeCount === 3);
  check('output starts with <svg', svg.trim().startsWith('<svg'));
  checkStrictlyWellFormed(svg, 'strictly well-formed XML (not just JSDOM-lenient)');
  const { container } = parseXML(svg);
  check('parses as valid markup with no parser errors', !container.querySelector('parsererror'));
  check('exactly 3 .node groups', container.querySelectorAll('.node').length === 3);
  check('exactly 2 edges (root has 2 children)', container.querySelectorAll('.edge').length === 2);
  check('root group has the "root" class', container.querySelector('[data-id="r"]').classList.contains('root'));
}

console.log('\n=== Security: text is escaped, not injected ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    evil: { text: '<script>alert(1)</script> & "quotes" <img src=x onerror=alert(2)>', parent: 'r' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML even with hostile input');
  check('no literal <script> tag made it into the output', !svg.includes('<script>'));
  check('no literal onerror= handler made it into the output', !svg.includes('onerror='));
  check('ampersand is escaped', svg.includes('&amp;'));
  const { container } = parseXML(svg);
  check('parses cleanly even with hostile input', !container.querySelector('parsererror'));
  check('exactly 2 nodes still rendered (structure intact)', container.querySelectorAll('.node').length === 2);
}

console.log('\n=== HTML formatting tags in node text are stripped to plain text ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'This is <b>bold</b> and <i>italic</i>', parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML');
  check('no literal <b> tag in output', !svg.includes('<b>'));
  const { container } = parseXML(svg);
  const text = container.querySelector('[data-id="a"] text').textContent;
  check('tags stripped, plain text shown', text.includes('bold') && text.includes('italic') && !text.includes('<'));
}

console.log('\n=== Long text is truncated, not left to blow out the layout ===');
{
  const longText = 'This is a very long node label that goes on and on and on and would otherwise make the box enormous';
  const nodes = { r: { text: 'Root', parent: null }, a: { text: longText, parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  const { container } = parseXML(svg);
  const text = container.querySelector('[data-id="a"] text').textContent;
  check('label is truncated with an ellipsis', text.endsWith('\u2026') && text.length < longText.length);
}

console.log('\n=== Custom node colors: MindSpark always pairs them with the same dark text ===');
{
  // This is the actual app.js behavior (public/app.js line ~574-577), not a
  // contrast computation — a custom color always gets #23201b text, even on a
  // dark background. Matching that exactly, not "improving" on it, since the
  // point here is visual fidelity to the real app.
  const nodes = {
    r: { text: 'Root', parent: null },
    dark: { text: 'Dark node', parent: 'r', color: '#1a1a2e' },
    light: { text: 'Light node', parent: 'r', color: '#fdf6e3' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML (this exact test caught the font-family quote-escaping bug)');
  const { container } = parseXML(svg);
  const darkRect = container.querySelector('[data-id="dark"] rect');
  const lightRect = container.querySelector('[data-id="light"] rect');
  check('dark node keeps its custom fill color', darkRect.getAttribute('fill') === '#1a1a2e');
  check('light node keeps its custom fill color', lightRect.getAttribute('fill') === '#fdf6e3');
  const darkText = container.querySelector('[data-id="dark"] text').getAttribute('fill');
  const lightText = container.querySelector('[data-id="light"] text').getAttribute('fill');
  check('dark node text is #23201b (app.js\'s fixed ink color, not white)', darkText === '#23201b', darkText);
  check('light node text is also #23201b (same fixed color, no per-node contrast logic)', lightText === '#23201b', lightText);
  check('custom-colored nodes get a visible border (app.js: 1.5px solid var(--line))', darkRect.getAttribute('stroke-width') === '1.5' && !!darkRect.getAttribute('stroke'));
}

console.log('\n=== Root node: map accent color (or the same default app.js uses), white text, no border, serif font ===');
{
  const nodes = { r: { text: 'My Map', parent: null }, a: { text: 'Child', parent: 'r' } };
  let out = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(out.svg, 'strictly well-formed XML (default root color)');
  let container = parseXML(out.svg).container;
  let rootRect = container.querySelector('[data-id="r"] rect');
  let rootText = container.querySelector('[data-id="r"] text');
  check('defaults to app.js\'s own default root color (#e0613a, PALETTE[0]) when no map color given', rootRect.getAttribute('fill') === '#e0613a', rootRect.getAttribute('fill'));
  check('root text is white', rootText.getAttribute('fill') === '#fff');
  check('root has no border (app.js: border-width:0)', rootRect.getAttribute('stroke') === 'none');
  check('root uses a serif font (matches app.js\'s "Fraunces" root styling)', rootText.getAttribute('font-family').toLowerCase().includes('serif') || rootText.getAttribute('font-family').includes('Georgia'));
  check('root font is bolder than regular nodes', parseInt(rootText.getAttribute('font-weight')) >= 700);

  out = renderMindMapSVG(nodes, 'r', { mapColor: '#3a5fc4' });
  checkStrictlyWellFormed(out.svg, 'strictly well-formed XML (custom map color)');
  container = parseXML(out.svg).container;
  rootRect = container.querySelector('[data-id="r"] rect');
  check('honors an explicit map accent color when one is provided', rootRect.getAttribute('fill') === '#3a5fc4');
}

console.log('\n=== Uncolored nodes: theme-based default styling (light/dark handled via CSS, not inline) ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'Plain child', parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML (this exact test caught the duplicate class-attribute bug)');
  const { container } = parseXML(svg);
  const aRect = container.querySelector('[data-id="a"] rect');
  check('uncolored node has no inline fill (theme handles it via CSS class, so dark mode works)', !aRect.getAttribute('fill'), aRect.getAttribute('fill'));
  check('uncolored node has the default-fill CSS class', aRect.getAttribute('class').split(' ').includes('rect-default-fill'), aRect.getAttribute('class'));
  check('uncolored node has the default-stroke CSS class too, combined in one class attribute (not a duplicate attribute)', aRect.getAttribute('class').split(' ').includes('rect-default-stroke'), aRect.getAttribute('class'));
  check('svg embeds a dark-mode media query so uncolored nodes adapt without new data', svg.includes('prefers-color-scheme: dark'));
}

console.log('\n=== Collapse/expand toggle: presence, symbol, and styling ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    a: { text: 'A (has children)', parent: 'r' },
    a1: { text: 'A1', parent: 'a' },
    b: { text: 'B (leaf)', parent: 'r' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML with toggles present');
  const { container } = parseXML(svg);
  check('root has a toggle (has children)', !!container.querySelector('[data-toggle-id="r"]'));
  check('a has a toggle (has children)', !!container.querySelector('[data-toggle-id="a"]'));
  check('b has NO toggle (leaf node)', !container.querySelector('[data-toggle-id="b"]'));
  check('a1 has NO toggle (leaf node)', !container.querySelector('[data-toggle-id="a1"]'));
  const aToggleText = container.querySelector('[data-toggle-id="a"] text').textContent;
  check('expanded node shows a minus symbol', aToggleText === '\u2212', aToggleText);
}

console.log('\n=== Collapse/expand toggle: collapsed state styling and symbol ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'A', parent: 'r' }, a1: { text: 'A1', parent: 'a' } };
  const { svg } = renderMindMapSVG(nodes, 'r', { collapsedIds: new Set(['a']) });
  checkStrictlyWellFormed(svg, 'strictly well-formed XML when a node is collapsed');
  const { container } = parseXML(svg);
  check('collapsed node STILL has a toggle (so it can be expanded again)', !!container.querySelector('[data-toggle-id="a"]'));
  check('a1 (child of collapsed node) is not rendered at all', !container.querySelector('[data-id="a1"]'));
  const aToggleText = container.querySelector('[data-toggle-id="a"] text').textContent;
  check('collapsed node shows a plus symbol', aToggleText === '+', aToggleText);
  const aToggleCircle = container.querySelector('[data-toggle-id="a"] circle');
  check('collapsed toggle is filled with the accent color, not the default theme fill', aToggleCircle.getAttribute('fill') === DEFAULT_ROOT_COLOR_FOR_TEST, aToggleCircle.getAttribute('fill'));
}

console.log('\n=== Collapse/expand toggle: positioned on the correct side ===');
{
  const nodes = { r: { text: 'Root', parent: null } };
  for (let i = 0; i < 4; i++) nodes['c'+i] = { text: 'C'+i, parent: 'r' };
  nodes['c0a'] = { text: 'C0a', parent: 'c0' };
  const { svg } = renderMindMapSVG(nodes, 'r');
  const { container } = parseXML(svg);
  const rootRect = container.querySelector('[data-id="r"] rect');
  const rootX = parseFloat(rootRect.getAttribute('x')) + parseFloat(rootRect.getAttribute('width')) / 2;
  const toggleCircle = container.querySelector('[data-toggle-id="c0"] circle');
  const c0Rect = container.querySelector('[data-id="c0"] rect');
  const c0X = parseFloat(c0Rect.getAttribute('x')) + parseFloat(c0Rect.getAttribute('width')) / 2;
  const toggleCx = parseFloat(toggleCircle.getAttribute('cx'));
  // On whichever side c0 landed, its toggle should be on the OUTER edge (further
  // from root), not the inner edge — matching app.js's left/right-aware placement.
  const onRightSide = c0X > rootX;
  const outerEdge = onRightSide ? c0X + parseFloat(c0Rect.getAttribute('width')) / 2 : c0X - parseFloat(c0Rect.getAttribute('width')) / 2;
  check('toggle sits on the node\'s outer edge relative to root, not the inner edge', Math.abs(toggleCx - outerEdge) < 0.01, { toggleCx, outerEdge, onRightSide });
}

console.log('\n=== Word wrap: long text produces multiple tspans and a taller node ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'This is a longer node label that will need to wrap across several lines', parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML with wrapped multi-line text');
  const { container } = parseXML(svg);
  const tspans = container.querySelectorAll('[data-id="a"] text tspan');
  check('long text produces more than one tspan (actually wrapped)', tspans.length > 1, tspans.length);
  const aRect = container.querySelector('[data-id="a"] rect');
  check('node grew taller than the single-line default to fit the wrapped lines', parseFloat(aRect.getAttribute('height')) > NODE_H_FOR_TEST, aRect.getAttribute('height'));
  check('reassembling the tspans recovers all the words (nothing silently dropped)',
    [...tspans].map(t => t.textContent).join(' ').split(/\s+/).length >= 10);
}

console.log('\n=== Word wrap: short text stays a single line at the normal height ===');
{
  const nodes = { r: { text: 'Root', parent: null }, a: { text: 'Short', parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  const { container } = parseXML(svg);
  const tspans = container.querySelectorAll('[data-id="a"] text tspan');
  check('short text stays on exactly one tspan', tspans.length === 1);
  const aRect = container.querySelector('[data-id="a"] rect');
  check('node keeps the normal single-line height', parseFloat(aRect.getAttribute('height')) === NODE_H_FOR_TEST, aRect.getAttribute('height'));
}

console.log('\n=== Bulleted and numbered lists render with the correct prefix ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    bullets: { text: 'First\nSecond', parent: 'r', listType: 'ul' },
    numbers: { text: 'Alpha\nBeta', parent: 'r', listType: 'ol' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML with lists present');
  const { container } = parseXML(svg);
  const bulletTspans = [...container.querySelectorAll('[data-id="bullets"] text tspan')].map(t => t.textContent);
  const numberTspans = [...container.querySelectorAll('[data-id="numbers"] text tspan')].map(t => t.textContent);
  check('bulleted items show a bullet character', bulletTspans.some(t => t.includes('\u2022')), bulletTspans);
  check('numbered items show sequential numbers', numberTspans[0].startsWith('1.') && numberTspans[1].startsWith('2.'), numberTspans);
}

console.log('\n=== Task checkboxes: all three states render with correct styling ===');
{
  const nodes = {
    r: { text: 'Root', parent: null },
    t1: { text: 'Todo item', parent: 'r', task: 'todo' },
    t2: { text: 'Doing item', parent: 'r', task: 'doing' },
    t3: { text: 'Done item', parent: 'r', task: 'done' }
  };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML with task checkboxes present');
  const { container } = parseXML(svg);
  check('a checkbox rect exists for each task node', ['t1', 't2', 't3'].every(id => container.querySelectorAll(`[data-id="${id}"] rect`).length === 2));
  const doneRect = container.querySelectorAll('[data-id="t3"] rect')[1];   // second rect = checkbox
  check('done checkbox is filled with the done color', doneRect.getAttribute('fill') === '#4a9d5b', doneRect.getAttribute('fill'));
  check('done checkbox shows a checkmark', container.querySelector('[data-id="t3"] text').textContent.includes('\u2713'));
  const doneText = [...container.querySelectorAll('[data-id="t3"] > text')].find(t => t.querySelector('tspan'));
  check('done task text has strikethrough', doneText.getAttribute('text-decoration') === 'line-through');
  check('done task text is faded', doneText.getAttribute('opacity') === '0.62');
  const doingRect = container.querySelectorAll('[data-id="t2"] rect')[1];
  check('doing checkbox uses the doing/amber border color', doingRect.getAttribute('stroke') === '#c98a1a', doingRect.getAttribute('stroke'));
  const todoText = [...container.querySelectorAll('[data-id="t1"] > text')].find(t => t.querySelector('tspan'));
  check('todo task text has no strikethrough (not done)', !todoText.getAttribute('text-decoration'));
}

console.log('\n=== Empty node text does not crash or produce malformed markup ===');
{
  const nodes = { r: { text: '', parent: null }, a: { text: null, parent: 'r' } };
  const { svg } = renderMindMapSVG(nodes, 'r');
  checkStrictlyWellFormed(svg, 'strictly well-formed XML (empty/null text)');
  const { container } = parseXML(svg);
  check('parses cleanly with empty/null text', !container.querySelector('parsererror'));
  check('still renders both nodes', container.querySelectorAll('.node').length === 2);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
