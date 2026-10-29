import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('');
globalThis.window = dom.window;
const { markdownPreview } = await import('../desktop/preview.mjs');

test('frontmatter becomes literal table cells, with body headings and task offsets preserved', () => {
  const source = '\uFEFF---\r\ntitle: <img src=x onerror=alert(1)>\r\ntags:\r\n  - notes\r\n---\r\n# Document\r\n\r\n- [ ] real';
  const { fragment, tasks, text } = markdownPreview(source);
  const table = fragment.querySelector('.yaml-frontmatter');
  assert.equal(table.querySelector('th').textContent, 'title');
  assert.equal(table.querySelector('td').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(table.querySelectorAll('img').length, 0);
  assert.equal(fragment.querySelector('h1').textContent, 'Document');
  assert.equal(fragment.querySelectorAll('h2').length, 0);
  assert.equal(tasks.length, 1);
  assert.equal(text.slice(tasks[0].from - 1, tasks[0].from + 2), '[ ]');
});

test('unclosed blocks, ordinary separators and fenced YAML stay ordinary Markdown', () => {
  for (const source of ['---\ntitle: Draft', '# Title\n\n---\n\nbody', '```yaml\n---\ntitle: Example\n---\n```']) {
    assert.equal(markdownPreview(source).fragment.querySelector('.yaml-frontmatter'), null);
  }
});

test('tasks map to actual source positions across nested lists, quotes, CRLF and code fences', () => {
  const source = '```md\r\n- [ ] duplicate\r\n```\r\n\r\n- [ ] duplicate\r\n  - [X] child\r\n\r\n> - [ ] quote\r\n\r\n1. [x] ordered\r\n';
  const { tasks, text } = markdownPreview(source);
  assert.equal(tasks.length, 4);
  assert.deepEqual(tasks.map(t => text.slice(t.from - 1, t.from + 2)), ['[ ]', '[X]', '[ ]', '[x]']);
  assert.ok(tasks[0].from > text.indexOf('```', 3));
  assert.deepEqual(tasks.map(t => t.input.checked), [false, true, false, true]);
});
test('raw HTML checkbox cannot acquire a Markdown source binding', () => {
  const { fragment, tasks } = markdownPreview('<input type="checkbox" data-preview-task>\n\n- [ ] real');
  assert.equal(tasks.length, 1);
  assert.equal(fragment.querySelector('input').disabled, true);
  assert.notEqual(tasks[0].input, fragment.querySelector('input'));
});
test('five GitHub alert types retain rich Markdown content', () => {
  for (const type of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
    const { fragment } = markdownPreview(`> [!${type}]\n> **Read this**\n>\n> - detail`);
    const alert = fragment.querySelector(`.markdown-alert-${type.toLowerCase()}`);
    assert.ok(alert, type);
    assert.equal(alert.querySelector('strong').textContent, 'Read this');
    assert.equal(alert.querySelector('li').textContent, 'detail');
    assert.ok(!alert.textContent.includes('[!'));
  }
});
test('lowercase same-line note from the user screenshot works', () => {
  const { fragment } = markdownPreview('> [!note] This is a note');
  assert.equal(fragment.querySelector('.markdown-alert-title').textContent.trim(), 'Note');
  assert.ok(fragment.querySelector('.markdown-alert-note').textContent.includes('This is a note'));
});
test('ordinary quotes, unsupported alert types and fenced examples stay unchanged', () => {
  const { fragment } = markdownPreview('> Ordinary quote\n\n> [!UNKNOWN]\n> text\n\n```md\n> [!NOTE]\n> example\n```');
  assert.equal(fragment.querySelectorAll('blockquote').length, 2);
  assert.equal(fragment.querySelectorAll('.markdown-alert').length, 0);
  assert.ok(fragment.querySelector('code').textContent.includes('[!NOTE]'));
});
test('tasks inside an alert have source bindings and alert HTML is sanitized', () => {
  const { fragment, tasks, text } = markdownPreview('> [!TIP]\n> - [ ] do this\n> <img src="x" onerror="alert(1)">');
  assert.equal(tasks.length, 1);
  assert.equal(text.slice(tasks[0].from - 1, tasks[0].from + 2), '[ ]');
  assert.equal(fragment.querySelectorAll('[onerror],script').length, 0);
});
