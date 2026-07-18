import { wrapLine, buildDisplayLines, heightForLines } from '../web/text-layout.mjs';

let pass = 0, fail = 0;
function check(label, cond, detail) { if (cond) { pass++; console.log(`  OK   ${label}`); } else { fail++; console.log(`  FAIL ${label}  -- ${detail !== undefined ? JSON.stringify(detail) : ''}`); } }

console.log('=== wrapLine: basic wrapping ===');
check('short text stays on one line', wrapLine('Short', 20).length === 1);
check('long text wraps to multiple lines', wrapLine('This is a longer sentence that needs wrapping', 20).length > 1);
check('no line exceeds maxChars (except unbreakable single words)', wrapLine('This is a longer sentence that needs wrapping across lines', 20).every(l => l.length <= 20));
check('wrapping preserves all the words (nothing dropped)', wrapLine('one two three four five', 8).join(' ').replace(/\s+/g, ' ') === 'one two three four five');

console.log('\n=== wrapLine: a single word longer than the line itself ===');
{
  const lines = wrapLine('Supercalifragilisticexpialidocious', 10);
  check('hard-breaks the long word rather than overflowing', lines.every(l => l.length <= 10), lines);
  check('reassembling the hard-broken pieces recovers the original word', lines.join('') === 'Supercalifragilisticexpialidocious');
}

console.log('\n=== buildDisplayLines: plain text, no list ===');
{
  const { lines, truncated } = buildDisplayLines('A short plain label', null, 20, 4);
  check('short text produces one line', lines.length === 1);
  check('not truncated', !truncated);
}

console.log('\n=== buildDisplayLines: bulleted list ===');
{
  const { lines } = buildDisplayLines('First item\nSecond item\nThird item', 'ul', 20, 4);
  check('each item gets a bullet prefix', lines[0].startsWith('\u2022 ') );
  check('produces one line per short item', lines.length === 3, lines);
  check('items appear in order', lines[0].includes('First') && lines[1].includes('Second') && lines[2].includes('Third'));
}

console.log('\n=== buildDisplayLines: numbered list ===');
{
  const { lines } = buildDisplayLines('Alpha\nBeta\nGamma', 'ol', 20, 4);
  check('numbers increment correctly starting at 1', lines[0].startsWith('1. ') && lines[1].startsWith('2. ') && lines[2].startsWith('3. '), lines);
}

console.log('\n=== buildDisplayLines: a long list item wraps and continues without a new bullet ===');
{
  const { lines } = buildDisplayLines('This is a very long single bullet item that needs wrapping', 'ul', 20, 4);
  check('first wrapped line has the bullet', lines[0].startsWith('\u2022 '));
  check('continuation lines do NOT get a second bullet', !lines[1].includes('\u2022'), lines);
}

console.log('\n=== buildDisplayLines: HTML tags and <br> are handled like app.js does ===');
{
  const { lines } = buildDisplayLines('Line one<br>Line two', null, 20, 4);
  check('<br> becomes a real line break', lines.length === 2 && lines[0] === 'Line one' && lines[1] === 'Line two', lines);
}
{
  const { lines } = buildDisplayLines('This is <b>bold</b> and <i>italic</i>', null, 40, 4);
  check('other HTML tags are stripped to plain text', lines[0] === 'This is bold and italic', lines);
}

console.log('\n=== buildDisplayLines: truncation at maxLines with ellipsis ===');
{
  const longText = Array.from({length: 10}, (_, i) => 'Item ' + i).join('\n');
  const { lines, truncated } = buildDisplayLines(longText, 'ul', 20, 4);
  check('capped at maxLines', lines.length === 4, lines.length);
  check('reports truncated:true', truncated === true);
  check('last shown line ends with an ellipsis', lines[3].endsWith('\u2026'), lines[3]);
}

console.log('\n=== buildDisplayLines: empty/null text does not crash ===');
{
  check('empty string produces something renderable, not a crash', (() => { try { return buildDisplayLines('', null, 20, 4).lines.length >= 1; } catch { return false; } })());
  check('null text does not crash', (() => { try { return buildDisplayLines(null, null, 20, 4).lines.length >= 1; } catch { return false; } })());
  check('null text with a list type does not crash', (() => { try { return buildDisplayLines(null, 'ul', 20, 4).lines.length >= 1; } catch { return false; } })());
}

console.log('\n=== heightForLines ===');
{
  check('one line returns the base height unchanged', heightForLines(1, 40, 16) === 40);
  check('zero lines also returns the base height (treated as at-least-one-line)', heightForLines(0, 40, 16) === 40);
  check('two lines grows by exactly one line-height', heightForLines(2, 40, 16) === 56);
  check('four lines grows by three line-heights', heightForLines(4, 40, 16) === 88);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
