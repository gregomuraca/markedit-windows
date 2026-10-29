import DOMPurify from 'dompurify';

let library, queue = Promise.resolve(), nextId = 0;
const cache = new Map();
const LIMIT = 25000;

// Mermaid uses shared configuration and temporary DOM nodes: render serially.
export function renderDiagram(source, container, dark, isCurrent) {
  queue = queue.catch(() => {}).then(async () => {
    if (!isCurrent()) return;
    try {
      if (source.length > LIMIT) throw new Error('Diagram exceeds the 25,000-character preview limit.');
      const key = `${dark}\0${source}`;
      let data = cache.get(key);
      if (!data) {
        library ||= import('mermaid').then(module => module.default);
        const mermaid = await library;
        if (!isCurrent()) return;
        mermaid.initialize({
          startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
          theme: dark ? 'dark' : 'default', htmlLabels: false,
          flowchart: { htmlLabels: false }, maxTextSize: LIMIT, maxEdges: 500,
          secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges',
            'suppressErrorRendering', 'themeCSS', 'theme', 'htmlLabels', 'flowchart', 'fontFamily'],
        });
        const id = `markedit-diagram-${++nextId}`;
        let svg;
        try { ({ svg } = await mermaid.render(id, source)); }
        finally { document.getElementById(`d${id}`)?.remove(); }
        const clean = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          FORBID_TAGS: ['foreignObject', 'script', 'image', 'a'],
        });
        // SVG image context isolates diagram styles and disables scripts and links.
        data = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clean)}`;
        cache.set(key, data);
        if (cache.size > 20) cache.delete(cache.keys().next().value);
      }
      if (!isCurrent()) return;
      const img = document.createElement('img');
      img.alt = 'Mermaid diagram'; img.src = data;
      container.replaceChildren(img);
      container.dataset.state = 'ready';
    } catch (error) {
      if (!isCurrent()) return;
      const message = document.createElement('div');
      message.className = 'diagram-error'; message.setAttribute('role', 'status');
      message.textContent = `Could not render Mermaid diagram: ${String(error?.message || error).slice(0, 500)}`;
      const pre = document.createElement('pre'); pre.textContent = source;
      container.replaceChildren(message, pre);
      container.dataset.state = 'error';
    }
  });
  return queue;
}
