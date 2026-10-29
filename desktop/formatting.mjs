import { syntaxTree } from '@codemirror/language';

function selectedLines(state) {
  const lines = new Set();
  for (const range of state.selection.ranges) {
    const last = state.doc.lineAt(range.to > range.from ? range.to - 1 : range.to).number;
    for (let n = state.doc.lineAt(range.from).number; n <= last; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b).map(n => state.doc.line(n));
}

function headingAt(state, line) {
  let node = syntaxTree(state).resolveInner(Math.min(line.from + 1, line.to), 1);
  for (; node; node = node.parent) if (/^(ATX|Setext)Heading[1-6]$/.test(node.name)) return node;
  return null;
}

export function plainTextChanges(state) {
  const changes = [], seen = new Set();
  for (const line of selectedLines(state)) {
    const node = headingAt(state, line);
    if (!node || seen.has(node.from)) continue;
    seen.add(node.from);
    if (node.name.startsWith('Setext')) {
      const underline = state.doc.lineAt(node.getChild('HeaderMark').from);
      if (underline.number < state.doc.lines) changes.push({from: underline.from, to: state.doc.line(underline.number + 1).from, insert: ''});
      else changes.push({from: state.doc.line(underline.number - 1).to, to: underline.to, insert: ''});
    } else {
      const source = state.doc.sliceString(node.from, node.to);
      const prefix = /^#{1,6}(?:[ \t]+|$)/.exec(source);
      if (prefix) changes.push({from: node.from, to: node.from + prefix[0].length, insert: ''});
      const marks = node.getChildren('HeaderMark');
      if (marks.length > 1) {
        let from = marks[marks.length - 1].from;
        while (from > node.from + (prefix?.[0].length || 0) && /[ \t]/.test(state.doc.sliceString(from - 1, from))) from--;
        changes.push({from, to: node.to, insert: ''});
      }
    }
  }
  return changes.sort((a, b) => a.from - b.from);
}

export function formattingState(state) {
  const levels = new Set(selectedLines(state).map(line => headingAt(state, line)?.name.match(/\d$/)[0] || '0'));
  const inline = name => {
    const states = state.selection.ranges.map(range => {
      let node = syntaxTree(state).resolveInner(range.from, 1);
      for (; node; node = node.parent) if (node.name === name && range.to <= node.to) return true;
      return false;
    });
    return states.every(Boolean) ? 'true' : states.some(Boolean) ? 'mixed' : 'false';
  };
  return {heading: levels.size === 1 ? [...levels][0] : 'mixed', bold: inline('StrongEmphasis'), italic: inline('Emphasis')};
}
