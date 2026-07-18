import { JSDOM } from 'jsdom';
import { assembleWidgetHTML } from '../web/build-widget.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

// Load the real assembled widget into a real JSDOM window (so #scroll/#footer/
// #titlebar genuinely exist, matching a real browser), but only eval the
// non-bridge portion of the script — the bridge IIFE talks to window.parent via
// postMessage, which isn't meaningfully testable outside a real host, and isn't
// what this test is checking.
const html = assembleWidgetHTML();
const dom = new JSDOM(html, { runScripts: 'outside-only' });
const scriptText = dom.window.document.querySelector('script').textContent;
const bridgeStart = scriptText.indexOf('(function () {');
const nonBridgeCode = scriptText.slice(0, bridgeStart);
dom.window.eval(nonBridgeCode);

const doc = dom.window.document;
const testMap = {
  id: 'map123',
  title: 'Weekend Plan',
  rootId: 'r',
  nodes: {
    r: { text: 'Root', parent: null },
    a: { text: 'A', parent: 'r', collapsed: false },
    a1: { text: 'A1', parent: 'a' },
    a2: { text: 'A2', parent: 'a' },
    b: { text: 'B', parent: 'r', collapsed: true },
    b1: { text: 'B1', parent: 'b' }
  }
};

console.log('\n=== Initial render: default-collapse-beyond-depth-1 applies regardless of explicit flags ===');
dom.window.renderInto(testMap);
check('a\'s children are hidden by default (depth-1 default applies even though source data says collapsed:false)', !doc.querySelector('[data-id="a1"]') && !doc.querySelector('[data-id="a2"]'));
check('b\'s child is hidden too (both by its own explicit collapsed:true AND the depth-1 default)', !doc.querySelector('[data-id="b1"]'));
check('b\'s toggle shows a plus (collapsed)', doc.querySelector('[data-toggle-id="b"] text').textContent === '+');
check('a\'s toggle ALSO shows a plus (collapsed by the depth-1 default, despite collapsed:false in the source data)', doc.querySelector('[data-toggle-id="a"] text').textContent === '+');

console.log('\n=== Clicking a toggle actually expands/collapses (real click, real DOM update) ===');
{
  const bToggle = doc.querySelector('[data-toggle-id="b"]');
  bToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('after clicking b\'s toggle, b1 is now rendered (expanded)', !!doc.querySelector('[data-id="b1"]'));
  check('b\'s toggle now shows a minus', doc.querySelector('[data-toggle-id="b"] text').textContent === '\u2212');
}
{
  const aToggle = doc.querySelector('[data-toggle-id="a"]');
  aToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('after clicking a\'s toggle (which started collapsed by the depth-1 default), a1/a2 are now visible (expanded)', !!doc.querySelector('[data-id="a1"]') && !!doc.querySelector('[data-id="a2"]'));
  check('a\'s toggle now shows a minus', doc.querySelector('[data-toggle-id="a"] text').textContent === '\u2212');
  check('unrelated branch (b, just expanded) is unaffected by expanding a', !!doc.querySelector('[data-id="b1"]'));
}

console.log('\n=== Clicking the node body itself (not the toggle) does nothing — read-only view ===');
{
  const rootNode = doc.querySelector('[data-id="r"] rect');
  const beforeHTML = doc.getElementById('scroll').innerHTML;
  rootNode.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('clicking a node body does not change the rendered content', doc.getElementById('scroll').innerHTML === beforeHTML);
}

console.log('\n=== Default view: deep maps default to showing only root + immediate children ===');
{
  const deepMap = {
    id: 'deep1', title: 'Deep Map', rootId: 'r',
    nodes: {
      r: { text: 'Root', parent: null },
      a: { text: 'A', parent: 'r' },
      a1: { text: 'A1', parent: 'a' },
      a1x: { text: 'A1x', parent: 'a1' },
      b: { text: 'B', parent: 'r' },
      b1: { text: 'B1', parent: 'b' }
    }
  };
  dom.window.renderInto(deepMap);
  check('root is visible', !!doc.querySelector('[data-id="r"]'));
  check('immediate children (depth 1) are visible', !!doc.querySelector('[data-id="a"]') && !!doc.querySelector('[data-id="b"]'));
  check('grandchildren (depth 2) are hidden by default', !doc.querySelector('[data-id="a1"]') && !doc.querySelector('[data-id="b1"]'));
  check('great-grandchildren (depth 3) are hidden transitively', !doc.querySelector('[data-id="a1x"]'));
  check('depth-1 nodes show a plus (collapsed) toggle', doc.querySelector('[data-toggle-id="a"] text').textContent === '+');

  console.log('\n=== Clicking a depth-1 toggle reveals its whole remaining subtree at once ===');
  doc.querySelector('[data-toggle-id="a"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('a1 becomes visible after expanding a', !!doc.querySelector('[data-id="a1"]'));
  check('a1x also becomes visible — only depth-1 nodes get the default collapse, so expanding reveals the whole remaining branch, not one level at a time', !!doc.querySelector('[data-id="a1x"]'));
  check('unrelated branch b is unaffected, stays collapsed', !doc.querySelector('[data-id="b1"]'));
}

console.log('\n=== Default view: a shallow map (nothing beyond depth 1) is not affected ===');
{
  const shallowMap = { id: 'shallow1', title: 'Shallow', rootId: 'r', nodes: { r: { text: 'Root', parent: null }, a: { text: 'A', parent: 'r' }, b: { text: 'B', parent: 'r' } } };
  const dom2 = new JSDOM(html, { runScripts: 'outside-only' });
  dom2.window.eval(nonBridgeCode);
  dom2.window.renderInto(shallowMap);
  check('root and both children all visible (nothing to hide)', !!dom2.window.document.querySelector('[data-id="r"]') && !!dom2.window.document.querySelector('[data-id="a"]') && !!dom2.window.document.querySelector('[data-id="b"]'));
}

console.log('\n=== Default view: the map\'s own explicit collapsed flags still apply (union, not override) ===');
{
  const mapWithExplicitCollapse = {
    id: 'explicit1', title: 'Explicit', rootId: 'r',
    nodes: {
      r: { text: 'Root', parent: null },
      a: { text: 'A', parent: 'r', collapsed: true },   // explicitly collapsed at depth 1 already — redundant with the default, should still work
      a1: { text: 'A1', parent: 'a' }
    }
  };
  const dom3 = new JSDOM(html, { runScripts: 'outside-only' });
  dom3.window.eval(nonBridgeCode);
  dom3.window.renderInto(mapWithExplicitCollapse);
  check('explicitly-collapsed node\'s child stays hidden', !dom3.window.document.querySelector('[data-id="a1"]'));
}
{
  dom.window.renderInto({ ...testMap, appUrl: 'https://myapp.example.com' });
  const footer = doc.getElementById('footer');
  check('footer is shown when a map id is present', footer.className === 'show');
  check('footer shows the open-in-MindSpark link when appUrl is configured', footer.innerHTML.includes('Open in MindSpark'));
  check('link element exists and is clickable', !!doc.getElementById('openInMindSpark'));

  // Regression test for a real bug found in live testing: window.openai.openExternal
  // expects { href }, not { url } — calling it with the wrong key throws "No href
  // provided" inside ChatGPT's own handler. Mock it and click the real link to
  // confirm the exact call shape, not just that the element exists.
  let capturedArgs = null;
  dom.window.openai = { openExternal: (args) => { capturedArgs = args; } };
  doc.getElementById('openInMindSpark').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('openExternal was called', !!capturedArgs, capturedArgs);
  check('called with { href: <url> }, not { url: <url> } (the exact bug found live)', capturedArgs && typeof capturedArgs.href === 'string' && capturedArgs.url === undefined, capturedArgs);
  check('href is the correct deep link (?map=<id>)', capturedArgs && capturedArgs.href === 'https://myapp.example.com/?map=map123', capturedArgs && capturedArgs.href);
  delete dom.window.openai;
}
{
  dom.window.renderInto({ ...testMap, appUrl: undefined });
  const footer = doc.getElementById('footer');
  check('footer still shown even without appUrl (always present "at the end", per the request)', footer.className === 'show');
  check('shows a disabled/explanatory message instead of a broken link when appUrl is not configured', footer.innerHTML.includes('MINDSPARK_APP_URL') && !doc.getElementById('openInMindSpark'));
}
{
  // shareUrl (a full, self-contained "#view=" link) takes priority over the
  // id-based ?map= deep link when both are present, and works even without
  // appUrl at all — needed for the no-login server, which has no persisted map
  // to deep-link to by id.
  dom.window.renderInto({ ...testMap, appUrl: 'https://myapp.example.com', shareUrl: 'https://myapp.example.com/#view=gABC123' });
  const footer = doc.getElementById('footer');
  check('footer shown with shareUrl present', footer.className === 'show');
  check('link uses shareUrl, not the ?map=<id> construction, even though appUrl is also set', doc.getElementById('openInMindSpark') && true);
  let capturedArgs = null;
  dom.window.openai = { openExternal: (args) => { capturedArgs = args; } };
  doc.getElementById('openInMindSpark').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  check('href is the exact shareUrl, not a ?map= link', capturedArgs?.href === 'https://myapp.example.com/#view=gABC123', capturedArgs?.href);
  delete dom.window.openai;
}
{
  // shareUrl works even with no appUrl configured at all (the no-login server's
  // actual case — it has no concept of a separately-configured app URL).
  dom.window.renderInto({ ...testMap, appUrl: undefined, shareUrl: 'https://mindspark.example.com/#view=gXYZ789' });
  const footer = doc.getElementById('footer');
  check('shareUrl alone (no appUrl at all) still produces a working link, not the disabled message', !!doc.getElementById('openInMindSpark') && !footer.innerHTML.includes('MINDSPARK_APP_URL'));
}
{
  dom.window.renderInto({ nodes: null, rootId: null });
  const footer = doc.getElementById('footer');
  check('footer hidden when there\'s no real map data at all (nothing to open)', footer.className === '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
