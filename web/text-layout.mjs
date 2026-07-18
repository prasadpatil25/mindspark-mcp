// Text content layout: turns a node's raw text (which may contain MindSpark's
// basic HTML formatting tags and/or represent a bullet/numbered list) into a
// fixed set of display lines with word-wrap applied, plus the node height that
// content needs. Pure functions — no DOM — so the wrapping math is testable in
// isolation the same way web/layout.mjs's positioning math is.

// Matches app.js's own renderNodeText(): normalize <br> to real newlines BEFORE
// stripping tags, so line breaks in the source survive into the plain-text lines
// this produces — otherwise multi-line node text would collapse into one run-on
// line before word-wrap ever sees it.
function toPlainLines(text) {
  const withBreaks = String(text || '').replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return stripped.split('\n').map(l => l.replace(/\s+/g, ' ').trim());
}

/**
 * Word-wraps a single line of text to a maximum character width, breaking on
 * word boundaries where possible and hard-breaking any single word longer than
 * the line itself. No real font metrics are available outside a browser, so
 * this works in approximate character counts rather than measured pixel widths
 * — adequate for a quick-glance widget, not meant to be typographically exact.
 */
export function wrapLine(text, maxChars) {
  if (!text) return [''];
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) { lines.push(cur); cur = ''; }
      let rest = w;
      while (rest.length > maxChars) { lines.push(rest.slice(0, maxChars)); rest = rest.slice(maxChars); }
      cur = rest;
      continue;
    }
    const candidate = cur ? cur + ' ' + w : w;
    if (candidate.length > maxChars) { lines.push(cur); cur = w; }
    else cur = candidate;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/**
 * Builds the final set of display lines for a node: strips HTML, splits on
 * list items when listType is set (each item gets its own bullet/number prefix
 * on its first wrapped line, matching app.js's renderNodeText), word-wraps
 * everything to maxChars, and caps the total at maxLines with an ellipsis on
 * the last line if there's more content than that.
 *
 * @param {string} text
 * @param {'ul'|'ol'|null} [listType]
 * @param {number} [maxChars]
 * @param {number} [maxLines]
 * @returns {{lines: string[], truncated: boolean}}
 */
export function buildDisplayLines(text, listType, maxChars = 20, maxLines = 4) {
  const rawLines = toPlainLines(text).filter((l, i, arr) => l !== '' || arr.length === 1);
  const out = [];

  if (listType) {
    let itemNum = 0;
    for (const item of rawLines) {
      if (!item) continue;
      itemNum++;
      const prefix = listType === 'ol' ? `${itemNum}. ` : '\u2022 ';
      const wrapped = wrapLine(item, Math.max(4, maxChars - prefix.length));
      wrapped.forEach((w, i) => out.push(i === 0 ? prefix + w : '  ' + w));
    }
  } else {
    for (const line of rawLines) {
      if (line === '') { out.push(''); continue; }
      out.push(...wrapLine(line, maxChars));
    }
  }

  const finalLines = out.length ? out : [''];
  const truncated = finalLines.length > maxLines;
  const shown = truncated ? finalLines.slice(0, maxLines) : finalLines;
  if (truncated) {
    const last = shown[shown.length - 1];
    shown[shown.length - 1] = last.length > 1 ? last.slice(0, -1) + '\u2026' : last + '\u2026';
  }
  return { lines: shown, truncated };
}

/**
 * Node height needed to fit a given number of display lines, growing from the
 * single-line default rather than replacing it — so simple one-line nodes keep
 * their existing, already-tuned height.
 */
export function heightForLines(lineCount, baseHeight, lineHeightPx) {
  if (lineCount <= 1) return baseHeight;
  return baseHeight + (lineCount - 1) * lineHeightPx;
}
