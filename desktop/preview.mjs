import { Marked } from 'marked';
import { parser, GFM } from '@lezer/markdown';
import DOMPurify from 'dompurify';

const taskParser = parser.configure(GFM);
const alerts = {
  NOTE: 'Note', TIP: 'Tip', IMPORTANT: 'Important',
  WARNING: 'Warning', CAUTION: 'Caution',
};

export function markdownPreview(source) {
  // CodeMirror positions use one character per line break, including CRLF files.
  const text = source.replace(/\r\n?/g, '\n');
  // Only a closed block at the start of the document is frontmatter.
  const frontmatter = /^(?:\uFEFF)?---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(text);
  const bodyOffset = frontmatter?.[0].length || 0;
  const body = text.slice(bodyOffset);
  const taskAttribute = `data-task-${crypto.randomUUID()}`;
  let taskCount = 0;
  const markdown = new Marked({ gfm: true, breaks: false, renderer: {
    checkbox({ checked }) {
      return `<input type="checkbox" disabled ${checked ? 'checked' : ''} ${taskAttribute}="${taskCount++}">`;
    },
    blockquote(token) {
      if (!token.alertType) return false;
      const label = alerts[token.alertType];
      return `<div class="markdown-alert markdown-alert-${token.alertType.toLowerCase()}"><p class="markdown-alert-title"><span class="markdown-alert-icon" aria-hidden="true"></span>${label}</p>${this.parser.parse(token.tokens)}</div>`;
    },
  }});
  const tokens = markdown.lexer(body);
  // GitHub alerts are top-level quotes. Code fences, ordinary/nested quotes stay literal.
  for (const token of tokens) {
    if (token.type !== 'blockquote') continue;
    const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+|\n|$)/i.exec(token.text);
    if (!match) continue;
    token.alertType = match[1].toUpperCase();
    token.tokens = markdown.lexer(token.text.slice(match[0].length));
  }
  const fragment = DOMPurify.sanitize(markdown.parser(tokens), {
    RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'iframe', 'object', 'embed', 'form', 'video', 'audio', 'svg', 'math'],
    FORBID_ATTR: ['style', 'srcset', 'data-preview-task'],
  });
  if (frontmatter) {
    const table = window.document.createElement('table');
    table.className = 'yaml-frontmatter';
    table.setAttribute('aria-label', 'YAML frontmatter');
    const rows = window.document.createElement('tbody');
    table.append(rows);
    for (const line of frontmatter[1].split('\n')) {
      if (!line.trim()) continue;
      const row = window.document.createElement('tr');
      const field = /^([^\s#][^:]*):(?:[ \t]+|$)(.*)$/.exec(line);
      if (field) {
        const key = window.document.createElement('th');
        key.scope = 'row';
        key.textContent = field[1];
        const value = window.document.createElement('td');
        value.textContent = field[2];
        row.append(key, value);
      } else {
        const value = window.document.createElement('td');
        value.colSpan = 2;
        value.textContent = line;
        row.append(value);
      }
      rows.append(row);
    }
    fragment.prepend(table);
  }
  // Never enable a checkbox supplied as raw HTML. Only generated Markdown tasks
  // get a source binding, using an unpredictable per-render attribute.
  for (const input of fragment.querySelectorAll('input')) input.disabled = true;
  const positions = [];
  if (taskCount) taskParser.parse(body).iterate({ enter(node) {
    if (node.name === 'TaskMarker') positions.push(bodyOffset + node.from + 1);
  }});
  const tasks = [];
  for (const input of fragment.querySelectorAll(`[${taskAttribute}]`)) {
    const index = Number(input.getAttribute(taskAttribute));
    input.removeAttribute(taskAttribute);
    // Fail closed if the parsers disagree rather than modify the wrong source.
    if (positions.length !== taskCount || !Number.isInteger(index) || positions[index] === undefined) continue;
    const from = positions[index];
    if (input.checked !== /[xX]/.test(text[from])) continue;
    input.dataset.previewTask = '';
    input.closest('li')?.classList.add('preview-task-item');
    input.setAttribute('aria-label', `Toggle task: ${input.closest('li')?.textContent.trim().slice(0, 120) || index + 1}`);
    tasks.push({ input, from });
  }
  return { fragment, tasks, text };
}
