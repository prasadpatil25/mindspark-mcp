import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Strips only the exact ES module syntax these two specific files use (written by
// hand, known shape) so the code runs as a plain inline <script>, not a module —
// avoids the cross-origin module-loading complications that come with type="module"
// inside a sandboxed iframe served from a data/blob-ish resource URI.
function stripModuleSyntax(source) {
  return source
    .replace(/^import\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export\s+(const|function|class)\s+/gm, '$1 ');
}

export function assembleWidgetHTML() {
  const layoutSrc = readFileSync(join(__dirname, 'layout.mjs'), 'utf8');
  const textLayoutSrc = readFileSync(join(__dirname, 'text-layout.mjs'), 'utf8');
  const renderSrc = readFileSync(join(__dirname, 'render-svg.mjs'), 'utf8');
  const template = readFileSync(join(__dirname, 'widget-template.html'), 'utf8');

  const inlined = [layoutSrc, textLayoutSrc, renderSrc].map(stripModuleSyntax).join('\n');
  const html = template.replace('/*__LAYOUT_AND_RENDER_CODE__*/', inlined);

  if (html.includes('__LAYOUT_AND_RENDER_CODE__')) {
    throw new Error('Widget assembly failed: template placeholder was not replaced');
  }
  if (/\bimport\s/.test(inlined) || /\bexport\s/.test(inlined)) {
    throw new Error('Widget assembly failed: module syntax remained after stripping');
  }
  return html;
}
