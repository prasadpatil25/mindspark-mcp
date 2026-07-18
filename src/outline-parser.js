// Converts a Markdown outline into a MindSpark node tree. Supports the two outline
// styles MindSpark itself recognizes: '#'/'##'/'###' headings, and '-'/'*' bullets
// nested by 2-space indentation. Both styles can be mixed (a heading followed by
// bulleted children), matching what the app's own Markdown mode round-trips.

const uid = () => Math.random().toString(36).slice(2, 9);

// Minimal, deliberately non-exhaustive inline-markdown -> HTML conversion, covering
// the formatting Claude naturally reaches for in an outline. Order matters: bold
// before italic, so **x** isn't first partially consumed by the italic pattern.
function inlineMdToHtml(text) {
  let s = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
  return s;
}

function headingDepth(line) {
  const m = /^(#{1,6})\s+(.*)$/.exec(line);
  return m ? { depth: m[1].length, text: m[2].trim() } : null;
}
function bulletDepth(line, baseDepth) {
  const m = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1].replace(/\t/g, '  ').length;
  return { depth: baseDepth + 1 + Math.floor(indent / 2), text: m[2].trim() };
}

/**
 * @param {string} outline - Markdown outline text.
 * @param {string} [title] - Map title; defaults to the first heading or first line.
 * @returns {{id:string, title:string, rootId:string, nodes:object}} a ready-to-save map
 */
export function outlineToMap(outline, title) {
  const lines = outline.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim() !== '');
  if (lines.length === 0) throw new Error('Outline is empty');

  const rootId = uid();
  // The outline's first line supplies the map title (its own heading level, if any,
  // becomes the baseline everything else nests under) — and is then excluded from
  // the tree-building loop below, so it doesn't ALSO show up as a duplicate child.
  const firstHeading = headingDepth(lines[0]);
  const rootTitle = title || firstHeading?.text || lines[0].replace(/^[-*+]\s*/, '').trim() || 'Untitled map';
  const nodes = { [rootId]: { id: rootId, text: rootTitle, parent: null, x: 0, y: 0, side: 'root', color: '#fff' } };

  // Stack of {depth, id} — depth 0 is reserved for the root itself, so a top-level
  // '#' heading or an unindented bullet both land as direct children of the root.
  const stack = [{ depth: 0, id: rootId }];
  let lastHeadingDepth = firstHeading ? firstHeading.depth : 0;

  for (const raw of lines.slice(1)) {
    const h = headingDepth(raw);
    const b = h ? null : bulletDepth(raw, lastHeadingDepth);
    if (!h && !b) continue;   // skip anything that's neither a heading nor a bullet
    const { depth, text } = h || b;
    if (h) lastHeadingDepth = depth;
    if (!text) continue;

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];

    const id = uid();
    nodes[id] = { id, text: inlineMdToHtml(text), parent: parent.id };
    stack.push({ depth, id });
  }

  return { id: uid(), title: rootTitle, rootId, nodes };
}
