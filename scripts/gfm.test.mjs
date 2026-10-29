import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
globalThis.window = new JSDOM('').window;
const { markdownPreview } = await import('../desktop/preview.mjs');
const parse = source => markdownPreview(source).fragment;

test('GFM tables preserve alignment, escaped pipes, inline formatting and empty cells', () => {
  const f = parse('| Left | Center | Right |\n| :--- | :---: | ---: |\n| **bold** | a\\|b | `code` |\n| short | | |');
  assert.deepEqual([...f.querySelectorAll('th')].map(c => c.getAttribute('align')), ['left','center','right']);
  assert.deepEqual([...f.querySelectorAll('tbody tr:first-child td')].map(c => c.textContent), ['bold','a|b','code']);
  assert.equal(f.querySelector('td strong').textContent, 'bold');
  assert.equal(f.querySelector('td code').textContent, 'code');
  assert.equal(f.querySelectorAll('tbody tr:last-child td').length, 3);
});
test('GFM tables require a matching delimiter row and end at a blank line', () => {
  assert.equal(parse('| a | b |\n| --- |').querySelector('table'), null);
  const f = parse('| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n\nafter');
  assert.equal(f.querySelectorAll('td').length, 2);
  assert.equal(f.querySelector('p').textContent, 'after');
});
test('GFM task lists retain nested and ordered checked states but exclude code', () => {
  const {fragment, tasks} = markdownPreview('- [ ] open\n  - [X] done\n\n1. [x] ordered\n\n```md\n- [ ] literal\n```');
  assert.deepEqual(tasks.map(t => t.input.checked), [false,true,true]);
  assert.equal(fragment.querySelectorAll('input').length, 3);
  assert.ok(fragment.querySelector('code').textContent.includes('- [ ] literal'));
});
test('GFM strikethrough supports inline content and leaves fenced text literal', () => {
  const f = parse('~~removed **bold**~~\n\n```\n~~literal~~\n```');
  assert.equal(f.querySelector('del strong').textContent, 'bold');
  assert.equal(f.querySelector('code').textContent.trim(), '~~literal~~');
});
test('GFM extended autolinks handle URLs, punctuation and email addresses', () => {
  const f = parse('Visit www.example.com, https://example.com/a_(b). Email writer@example.com.');
  assert.deepEqual([...f.querySelectorAll('a')].map(a => a.getAttribute('href')), ['http://www.example.com','https://example.com/a_(b)','mailto:writer@example.com']);
});
test('GFM fenced code preserves language, literal HTML and hard/soft line breaks', () => {
  const f = parse('one\ntwo  \nthree\n\n```html\n<script>literal</script>\n```');
  assert.equal(f.querySelectorAll('br').length, 1);
  assert.equal(f.querySelector('code.language-html').textContent.trim(), '<script>literal</script>');
  assert.equal(f.querySelector('script'), null);
});
test('GFM tag filter displays restricted tags literally and sanitizes active HTML', () => {
  for (const tag of ['title','textarea','style','xmp','iframe','noembed','noframes','script','plaintext']) {
    const f = parse(`<${tag}>literal</${tag}>`);
    assert.ok(f.textContent.includes(`<${tag}>literal</${tag}>`), tag);
    assert.equal(f.querySelector(tag), null);
  }
  const f = parse('<a href="javascript:alert(1)" onclick="alert(1)">link</a><img src="x" onerror="alert(1)">');
  assert.equal(f.querySelector('[onclick],[onerror],[href^="javascript:"]'), null);
});
