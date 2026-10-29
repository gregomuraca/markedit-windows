import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { exportDocument, mountPrintDocument } from '../desktop/export.mjs';
const preview = html => new JSDOM(`<body><header>App</header><article id="preview">${html}</article></body>`).window.document.querySelector('article');

test('standalone export keeps draft content, anchors, alignment and embedded resources', () => {
  const p = preview('<h1 id="preview-heading-title" data-anchor="title">A &amp; B</h1><a href="#preview-heading-title">jump</a><table><tr><td align="right">42</td></tr></table><img alt="local" src="data:image/png;base64,aA=="><figure class="mermaid-diagram" data-state="ready"><img alt="diagram" src="data:image/svg+xml;base64,aA=="></figure>');
  const result = exportDocument(p), d = new JSDOM(result.html).window.document;
  assert.equal(d.title, 'A & B');
  assert.equal(d.querySelector('h1').id, 'title');
  assert.equal(d.querySelector('a').getAttribute('href'), '#title');
  assert.equal(d.querySelector('td').getAttribute('align'), 'right');
  assert.equal(d.querySelectorAll('img').length, 2);
  assert.equal(d.querySelector('[data-anchor],[data-state],script,header'), null);
  assert.equal(p.querySelector('h1').id, 'preview-heading-title');
  assert.equal(result.warnings, 0);
  assert.ok(d.querySelector('meta[http-equiv]').content.includes("default-src 'none'"));
});
test('export snapshots current checkbox state and removes interactive bindings', () => {
  const p = preview('<input type="checkbox" data-preview-task="1" checked><input type="checkbox">');
  p.querySelector('input').checked = false;
  p.querySelectorAll('input')[1].checked = true;
  const d = new JSDOM(exportDocument(p).html).window.document;
  assert.deepEqual([...d.querySelectorAll('input')].map(i => [i.checked,i.disabled]), [[false,true],[true,true]]);
  assert.equal(d.querySelector('[data-preview-task]'), null);
});
test('export refuses unfinished and external images, counts missing content', () => {
  assert.throws(() => exportDocument(preview('<figure class="mermaid-diagram" data-state="loading"></figure>')), /finish rendering/);
  for (const src of ['https://example.com/image.png','asset.png','data:text/html;base64,aA==']) assert.throws(() => exportDocument(preview(`<img src="${src}">`)), /offline export/);
  assert.equal(exportDocument(preview('<span class="image-note">missing</span><pre class="diagram-error">invalid</pre>')).warnings, 2);
});
test('blank export omits editor empty state and print mount cleans up', () => {
  const p = preview('<div class="empty">App hint</div>'), result = exportDocument(p);
  assert.equal(result.title, 'Untitled');
  assert.equal(result.article.textContent, '');
  const cleanup = mountPrintDocument(p.ownerDocument,result.article);
  assert.ok(p.ownerDocument.getElementById('export-output'));
  cleanup();
  assert.equal(p.ownerDocument.getElementById('export-output'), null);
});
test('PDF preparation uses document heading as metadata title and restores app title', () => {
  const p = preview('<h1>Export title</h1>');
  p.ownerDocument.title = 'MarkEdit';
  const cleanup = mountPrintDocument(p.ownerDocument, exportDocument(p).article);
  assert.equal(p.ownerDocument.title, 'Export title');
  cleanup();
  assert.equal(p.ownerDocument.title, 'MarkEdit');
});
