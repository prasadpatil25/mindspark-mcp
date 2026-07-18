import { JSDOM } from 'jsdom';
import vm from 'node:vm';
import { assembleWidgetHTML } from '../web/build-widget.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

const html = assembleWidgetHTML();

console.log('=== Assembled HTML structural checks ===');
check('placeholder was replaced (no leftover marker)', !html.includes('__LAYOUT_AND_RENDER_CODE__'));
check('no leftover import statements', !/\bimport\s*\{/.test(html));
check('no leftover export statements', !/\bexport\s+(const|function|class|\{)/.test(html));
check('is a fragment (root div + style + script), not a full document — matches every confirmed-working example, since the host wraps it in its own shell', html.trim().startsWith('<div id="widget-root">') && !html.includes('<!DOCTYPE') && !html.includes('<html'));

console.log('\n=== Assembled HTML parses cleanly ===');
const dom = new JSDOM(html);
check('parses without throwing', !!dom.window.document);
check('has the expected #scroll container', !!dom.window.document.getElementById('scroll'));
check('has exactly one <script> block (the inlined logic + bridge)', dom.window.document.querySelectorAll('script').length === 1);

console.log('\n=== The inlined layout/render code is syntactically valid AND functional ===');
{
  // Extract just the non-bridge portion (everything before the bridge IIFE) and
  // execute it in isolation, to prove the assembly step produced working code --
  // not just code that happens to parse.
  const scriptText = dom.window.document.querySelector('script').textContent;
  const bridgeStart = scriptText.indexOf('(function () {');
  const layoutAndRenderCode = scriptText.slice(0, bridgeStart);

  check('no import/export leaked into the extracted portion', !/\bimport\s*\{/.test(layoutAndRenderCode) && !/\bexport\s+(const|function|class|\{)/.test(layoutAndRenderCode));

  const sandbox = {
    document: {
      getElementById: () => ({ addEventListener: () => {}, className: '', innerHTML: '' })
    }
  };
  vm.createContext(sandbox);
  try {
    vm.runInContext(layoutAndRenderCode + '\nglobalThis.__layoutTree = layoutTree; globalThis.__renderMindMapSVG = renderMindMapSVG;', sandbox);
    check('executes without throwing', true);
  } catch (e) {
    check('executes without throwing', false, e.message);
  }
  check('layoutTree is defined and callable after assembly', typeof sandbox.__layoutTree === 'function');
  check('renderMindMapSVG is defined and callable after assembly', typeof sandbox.__renderMindMapSVG === 'function');

  if (typeof sandbox.__renderMindMapSVG === 'function') {
    const result = sandbox.__renderMindMapSVG(
      { r: { text: 'Root', parent: null }, a: { text: 'Child', parent: 'r' } }, 'r'
    );
    check('produces real SVG output when actually called', result.svg.includes('<svg') && result.nodeCount === 2, result);
    // Regression test: text-layout.mjs (buildDisplayLines/heightForLines) must
    // actually be inlined too, not just layout.mjs and render-svg.mjs — missing
    // it produced a real "buildDisplayLines is not defined" crash the moment any
    // node's content needed word-wrap, which single-word test cases like the one
    // above don't happen to exercise.
    const wrapResult = sandbox.__renderMindMapSVG(
      { r: { text: 'Root', parent: null }, a: { text: 'This label is long enough that it will actually need to wrap onto more than one line', parent: 'r' } }, 'r'
    );
    check('word-wrap actually works end-to-end in the assembled widget (not just short single-word cases)', (wrapResult.svg.match(/<tspan/g) || []).length > 2, wrapResult.svg.match(/<tspan/g)?.length);
  }
}

console.log('\n=== Bridge handshake ordering (guards against a real deadlock bug found during live testing) ===');
{
  const scriptText = dom.window.document.querySelector('script').textContent;
  // The bug: awaiting a response to ui/initialize before ever sending
  // ui/notifications/initialized meant that if the host never replied to that
  // specific request the way this code expected, the await would hang forever and
  // the host would never learn the widget was ready. A notification needs no
  // response and can't hang, so it must be sent unconditionally and early —
  // check it appears in the source before the ui/initialize request is awaited,
  // not nested inside that request's continuation.
  const notifyIdx = scriptText.indexOf("notify('ui/notifications/initialized'");
  const requestIdx = scriptText.indexOf("request('ui/initialize'");
  check('ui/notifications/initialized is sent, and appears before the ui/initialize request in source order', notifyIdx > -1 && requestIdx > -1 && notifyIdx < requestIdx, { notifyIdx, requestIdx });
  check('the ui/initialize request has an explicit timeout (cannot hang forever)', /request\('ui\/initialize'[^)]*,\s*\d+\)/.test(scriptText));
  check('polls window.openai.toolOutput repeatedly rather than checking only once', /function tick\(\)/.test(scriptText) && scriptText.includes('setTimeout(tick'));
  check('polling continues indefinitely rather than giving up after a fixed number of tries (the actual refresh bug)', !/tries > \d+.*return/.test(scriptText.replace(/\s+/g, ' ')));
  check('shows in-widget diagnostics if nothing arrives, instead of failing silently', scriptText.includes('showDiagnostics'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
