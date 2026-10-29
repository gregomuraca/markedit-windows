import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EditorState, EditorSelection} from '@codemirror/state';
import {markdown} from '@codemirror/lang-markdown';
import {plainTextChanges, formattingState} from '../desktop/formatting.mjs';

const state = (doc, from = 0, to = from) => EditorState.create({doc, selection: EditorSelection.range(from, to), extensions: [markdown()]});
const plain = value => value.update({changes: plainTextChanges(value)}).state.doc.toString();

test('Plain text removes ATX markers and optional closing hashes', () => {
  assert.equal(plain(state('# Title #')), 'Title');
  assert.equal(plain(state('### Title')), 'Title');
});
test('Plain text removes Setext underlines from title or underline selection', () => {
  assert.equal(plain(state('Title\n=====')), 'Title');
  assert.equal(plain(state('Title\n=====\n\nBody', 8)), 'Title\n\nBody');
  assert.equal(plain(state('Subtitle\n--------\nBody')), 'Subtitle\nBody');
});
test('Plain text changes all selected headings without changing paragraphs or fenced examples', () => {
  const doc='# First\n\nSecond\n======\n\nPlain\n\n```md\n# Example\n```';
  assert.equal(plain(state(doc,0,doc.length)), 'First\n\nSecond\n\nPlain\n\n```md\n# Example\n```');
});
test('Formatting state distinguishes heading levels, Setext, plain and mixed selections', () => {
  assert.equal(formattingState(state('# Title',3)).heading,'1');
  assert.equal(formattingState(state('Title\n=====',2)).heading,'1');
  assert.equal(formattingState(state('Plain',2)).heading,'0');
  assert.equal(formattingState(state('# First\n\nPlain',0,14)).heading,'mixed');
});
test('Formatting state follows bold and italic syntax rather than literal marks in code', () => {
  assert.equal(formattingState(state('**bold** text',4)).bold,'true');
  assert.equal(formattingState(state('*italic* text',4)).italic,'true');
  assert.equal(formattingState(state('`**literal**`',5)).bold,'false');
  assert.equal(formattingState(state('**bold** text',4,13)).bold,'false');
});
