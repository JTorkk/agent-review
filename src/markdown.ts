import MarkdownIt from 'markdown-it';
import type { LineDiff } from './diff';

/*
 * Renders Markdown so every commentable block carries its source lines:
 *   data-ls / data-le  first and last source line, 1-based, inclusive
 *   data-diff          "added" | "modified" when the block's lines changed
 * Code fences are split into one element per line so comments can target
 * single lines of code.
 */

/** Token types that become a single commentable block. */
const LEAF_TYPES = new Set(['paragraph_open', 'heading_open', 'tr_open', 'hr']);

export interface RenderOptions {
  diff: LineDiff;
  /** Maps a relative image src to a URL the webview can load. */
  resolveImage: (src: string) => string | undefined;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lineAttrs(ls: number, le: number, diff: LineDiff, lines: string[]): string {
  let attrs = ` data-ls="${ls}" data-le="${le}"`;
  const status = blockStatus(ls, le, diff, lines);
  if (status) attrs += ` data-diff="${status}"`;
  return attrs;
}

function blockStatus(ls: number, le: number, diff: LineDiff, lines: string[]): string | undefined {
  let content = 0;
  let changed = 0;
  let changedBlank = 0;
  for (let n = ls; n <= le; n++) {
    const blank = (lines[n - 1] ?? '').trim() === '';
    if (!blank) content++;
    if (diff.added.has(n)) {
      if (blank) changedBlank++;
      else changed++;
    }
  }
  if (changed === 0) return changedBlank > 0 && content === 0 ? 'added' : undefined;
  return changed === content ? 'added' : 'modified';
}

export function renderMarkdown(source: string, options: RenderOptions): string {
  const { diff, resolveImage } = options;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const md = new MarkdownIt({ html: true, linkify: true });

  md.core.ruler.push('agent_review_lines', (state) => {
    for (const token of state.tokens) {
      if (!token.map || !LEAF_TYPES.has(token.type)) continue;
      const ls = token.map[0] + 1;
      const le = Math.max(ls, token.map[1]);
      token.attrSet('data-ls', String(ls));
      token.attrSet('data-le', String(le));
      const status = blockStatus(ls, le, diff, lines);
      if (status) token.attrSet('data-diff', status);
    }
  });

  // Tight list items hide their <p>; keep a span so the text stays commentable.
  md.renderer.rules.paragraph_open = (tokens, idx, opts, _env, self) =>
    tokens[idx].hidden ? `<span class="ar-tight"${self.renderAttrs(tokens[idx])}>` : self.renderToken(tokens, idx, opts);
  md.renderer.rules.paragraph_close = (tokens, idx, opts, _env, self) =>
    tokens[idx].hidden ? '</span>' : self.renderToken(tokens, idx, opts);

  const renderCodeLines = (content: string, firstLine: number, lang: string): string => {
    const codeLines = content.replace(/\n$/, '').split('\n');
    const body = codeLines
      .map((text, i) => {
        const n = firstLine + i;
        return `<span class="ar-line"${lineAttrs(n, n, diff, lines)}>${escapeHtml(text)}</span>`;
      })
      .join('');
    const langAttr = lang ? ` data-lang="${escapeHtml(lang)}"` : '';
    return `<pre class="ar-code"${langAttr}><code>${body}</code></pre>\n`;
  };

  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    // Content starts on the line after the opening fence.
    const first = token.map ? token.map[0] + 2 : 1;
    return renderCodeLines(token.content, first, token.info.trim().split(/\s+/)[0]);
  };

  md.renderer.rules.code_block = (tokens, idx) => {
    const token = tokens[idx];
    const first = token.map ? token.map[0] + 1 : 1;
    return renderCodeLines(token.content, first, '');
  };

  md.renderer.rules.html_block = (tokens, idx) => {
    const token = tokens[idx];
    if (!token.map) return token.content;
    return `<div class="ar-html"${lineAttrs(token.map[0] + 1, Math.max(token.map[0] + 1, token.map[1]), diff, lines)}>${token.content}</div>\n`;
  };

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = token.attrGet('src');
    if (src) {
      const resolved = resolveImage(src);
      if (resolved) token.attrSet('src', resolved);
    }
    return defaultImage(tokens, idx, opts, env, self);
  };

  return md.render(source);
}
