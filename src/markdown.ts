import MarkdownIt from 'markdown-it';
import katex from 'katex';

export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });
markdown.validateLink = url => /^(?:https?:|mailto:)/i.test(url) || !url.includes(':');
const math = (source: string, displayMode: boolean) => katex.renderToString(source, { displayMode, throwOnError: false, trust: false, maxExpand: 1000, maxSize: 20, strict: 'ignore' });
markdown.inline.ruler.before('escape', 'hoj_connecter_math', (state, silent) => {
  const start = state.pos;
  if (state.src[start] !== '$' || state.src[start + 1] === '$' || /\s/.test(state.src[start + 1] ?? '')) { return false; }
  let end = start + 1;
  while ((end = state.src.indexOf('$', end)) >= 0) {
    if (state.src[end - 1] !== '\\' && !/\s/.test(state.src[end - 1])) { break; } end++;
  }
  if (end < 0 || state.src.slice(start + 1, end).includes('\n')) { return false; }
  if (!silent) { const token = state.push('hoj_connecter_math', '', 0); token.content = state.src.slice(start + 1, end); }
  state.pos = end + 1; return true;
});
markdown.renderer.rules.hoj_connecter_math = (tokens, idx) => math(tokens[idx].content, false);
markdown.block.ruler.before('fence', 'hoj_connecter_math_block', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  if (!state.src.startsWith('$$', start)) { return false; }
  const close = state.src.indexOf('$$', start + 2);
  if (close < 0) { return false; }
  let line = startLine;
  while (line < endLine && state.eMarks[line] < close + 2) { line++; }
  if (line >= endLine || state.src.slice(close + 2, state.eMarks[line]).trim()) { return false; }
  if (!silent) { const token = state.push('hoj_connecter_math_block', 'div', 0); token.block = true; token.content = state.src.slice(start + 2, close); token.map = [startLine, line + 1]; }
  state.line = line + 1; return true;
});
markdown.renderer.rules.hoj_connecter_math_block = (tokens, idx) => `<div class="math-block">${math(tokens[idx].content, true)}</div>`;
export function renderMarkdown(source: string): string { return markdown.render(source.slice(0, 2 * 1024 * 1024)); }
