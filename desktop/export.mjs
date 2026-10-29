export const exportStyles = `
#export-document{font:15px/1.65 "Segoe UI",Arial,sans-serif;color:#26313d;background:#fff;overflow-wrap:anywhere;color-scheme:light}
#export-document h1,#export-document h2,#export-document h3{line-height:1.25;break-after:avoid;letter-spacing:-.02em}
#export-document h1{font-size:2em;margin:0 0 1em}#export-document h2{font-size:1.5em;margin-top:1.5em}
#export-document p{margin:1em 0;orphans:3;widows:3}#export-document a{color:#245e9c;text-decoration:underline}
#export-document img{max-width:100%;height:auto;break-inside:avoid}#export-document figure{margin:1.25em 0;text-align:center}
#export-document pre{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;padding:12px;border:1px solid #d8dfe5;background:#f5f7f9;border-radius:4px}
#export-document code{font:13px/1.6 Consolas,monospace;background:#f5f7f9}#export-document pre code{background:transparent}
#export-document table{border-collapse:collapse;width:100%;margin:1.2em 0;font-size:14px;table-layout:auto}
#export-document th,#export-document td{border:1px solid #cbd3db;padding:6px 9px;text-align:left;vertical-align:top}
#export-document th{background:#f0f3f6}#export-document [align=center]{text-align:center}#export-document [align=right]{text-align:right}
#export-document thead{display:table-header-group}#export-document tr{break-inside:avoid}
#export-document blockquote{margin:1.2em 0;padding:0 16px;border-left:3px solid #788796}
#export-document .yaml-frontmatter{font-size:9px;line-height:1.5;margin:0 0 20px;table-layout:fixed}
#export-document .yaml-frontmatter th{width:30%}#export-document .yaml-frontmatter th,#export-document .yaml-frontmatter td{padding:3px 6px;white-space:pre-wrap}
#export-document .markdown-alert{margin:1.2em 0;padding:12px 16px;border:1px solid #cbd3db;border-left:3px solid #547692;background:#f3f6f9;border-radius:5px;color:#26313d;break-inside:avoid}
#export-document .markdown-alert-warning{border-left-color:#8a5a12;background:#fff4d9}#export-document .markdown-alert-caution{border-left-color:#a33b4b;background:#fff1f2}
#export-document .markdown-alert-title{font-weight:650;color:inherit;margin:0 0 6px}#export-document .markdown-alert-icon{display:none}
#export-document .markdown-alert>:last-child{margin-bottom:0}#export-document .image-note,#export-document .diagram-error{display:block;border:1px dashed #8996a3;padding:8px;font-size:12px;color:#394856}
#export-document .preview-task-item{list-style:none}#export-document input[type=checkbox]{margin:0 .45em 0 -1.35em;accent-color:#34785d}
#export-document hr{border:0;border-top:1px solid #cbd3db;margin:1.5em 0}
@media print{html,body{margin:0!important;padding:0!important;height:auto!important;overflow:visible!important;display:block!important;background:white!important;color:#26313d!important}
body>#export-output{display:block!important}body:has(>#export-output)>:not(#export-output){display:none!important}
#export-document{max-width:none!important;margin:0!important;padding:0!important;print-color-adjust:exact;-webkit-print-color-adjust:exact}}
`;

export function exportDocument(preview) {
  if (preview.querySelector('.mermaid-diagram[data-state="loading"]')) throw new Error('Wait for diagrams to finish rendering before exporting.');
  const article = preview.cloneNode(true);
  article.id = 'export-document';
  article.removeAttribute('style');
  article.querySelector('.empty')?.remove();
  const anchors = new Map();
  for (const [index, heading] of [...article.querySelectorAll('h1,h2,h3,h4,h5,h6')].entries()) {
    const id = heading.dataset.anchor || heading.id || `section-${index + 1}`;
    if (heading.id) anchors.set(heading.id, id);
    if (heading.dataset.anchor) anchors.set(heading.dataset.anchor, id);
    heading.id = id;
  }
  for (const link of article.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) {
      try { const slug = decodeURIComponent(href.slice(1)); if (anchors.has(slug)) link.setAttribute('href', `#${anchors.get(slug)}`); } catch {}
    }
    link.removeAttribute('target'); link.rel = 'noopener noreferrer';
  }
  for (const element of article.querySelectorAll('*')) {
    for (const attr of [...element.attributes]) if (attr.name.startsWith('data-') || attr.name.startsWith('on')) element.removeAttribute(attr.name);
  }
  for (const input of article.querySelectorAll('input')) {
    input.disabled = true; input.setAttribute('disabled', '');
    input.toggleAttribute('checked', input.checked);
    input.setAttribute('aria-label', input.checked ? 'Completed task' : 'Incomplete task');
  }
  for (const image of article.querySelectorAll('img')) {
    if (!/^data:image\/(?:png|jpeg|gif|webp|bmp|svg\+xml)[;,]/i.test(image.getAttribute('src') || '')) {
      throw new Error('An image is not ready for offline export. Wait for the preview and try again.');
    }
  }
  const title = article.querySelector('h1')?.textContent.trim() || 'Untitled';
  const titleElement = preview.ownerDocument.createElement('div'); titleElement.textContent = title;
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${titleElement.innerHTML}</title><style>body{margin:0;background:#fff}#export-document{max-width:760px;margin:40px auto;padding:0 24px}${exportStyles}</style></head><body>${article.outerHTML}</body></html>`;
  if (new TextEncoder().encode(html).length > 64 * 1024 * 1024) throw new Error('The exported document exceeds 64 MB. Reduce its image sizes and try again.');
  return {html, title, article, warnings: article.querySelectorAll('.image-note,.diagram-error').length};
}

export function mountPrintDocument(document, article) {
  document.getElementById('export-output')?.remove();
  const previousTitle = document.title;
  document.title = article.querySelector('h1')?.textContent.trim() || previousTitle;
  const output = document.createElement('div'); output.id = 'export-output'; output.style.display = 'none';
  const style = document.createElement('style'); style.textContent = exportStyles;
  output.append(style, article); document.body.append(output);
  return () => { output.remove(); document.title = previousTitle; };
}
