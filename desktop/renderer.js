import './bridge.js';
import '../CoreEditor/index.css';
import { resetEditor, getEditorText } from '../CoreEditor/src/core';
import { initMarkEditModules, initThemeExtractors } from '../CoreEditor/src/api/modules';
import { startObserving } from '../CoreEditor/src/modules/events';
import * as settings from '../CoreEditor/src/modules/config';
import * as commands from '../CoreEditor/src/modules/commands';
import { insertHyperLink, insertTable } from '../CoreEditor/src/modules/snippets';
import { undo, redo } from '../CoreEditor/src/modules/history';
import { SearchQuery, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from '@codemirror/search';
import { EditorState, Prec } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { cursorLineBoundaryBackward, cursorLineBoundaryForward, selectLineBoundaryBackward, selectLineBoundaryForward } from '@codemirror/commands';
import { isolateHistory } from '../CoreEditor/src/@vendor/commands/history';
import { markdownPreview } from './preview.mjs';
import { renderDiagram } from './diagrams.js';
import { plainTextChanges, formattingState } from './formatting.mjs';
import { exportDocument, mountPrintDocument } from './export.mjs';

const $ = id => document.getElementById(id);
let savedText = '', isBusy = false, loading = false, timer, renderGeneration = 0, scrollPending = false;
let mermaidFile = false;
let prefs = {};
try { prefs = JSON.parse(localStorage.getItem('preferences') || '{}'); } catch {}
const persist = () => localStorage.setItem('preferences', JSON.stringify(prefs));
window.config = { host:'mainApp', theme:prefs.dark ? 'github-dark':'github-light', text:'', fontFace:{family:'Consolas, monospace'}, fontSize:15, showLineNumbers:true, showActiveLineIndicator:true, invisiblesBehavior:'never', readOnlyMode:false, typewriterMode:false, focusMode:false, lineWrapping:true, lineHeight:1.65, suggestWhileTyping:false, smartQuotesEnabled:false, autoCharacterPairs:true, indentBehavior:'paragraph', standardDirectories:{}, localizable:{previewButtonTitle:'Preview',closeButtonTitle:'Close',cmdClickToFollow:'Ctrl-click to follow',cmdClickToToggleTodo:'Ctrl-click to toggle todo'} };
window.MarkEdit = { editorConfig:window.config,userSettings:{} };
const noOp = new Proxy({}, {get:() => async () => undefined});
window.nativeModules = { core:new Proxy({}, {get:(_t,key) => args => {
  if(key === 'notifyViewDidUpdate' && !loading) update(args?.contentEdited);
  if(key === 'notifyLinkClicked') window.desktop.openLink(args.link);
  return Promise.resolve();
}}), completion:noOp, tokenizer:noOp, api:noOp, foundationModels:noOp, translation:noOp };
initMarkEditModules(); initThemeExtractors(); startObserving();
MarkEdit.addExtension(Prec.highest(keymap.of([
  {key:'Home',run:cursorLineBoundaryBackward,shift:selectLineBoundaryBackward},
  {key:'End',run:cursorLineBoundaryForward,shift:selectLineBoundaryForward},
])));
// Prevent any transaction from editing while a native file operation is pending.
MarkEdit.addExtension(EditorState.transactionFilter.of(tr => isBusy && tr.docChanged ? [] : tr));
MarkEdit.addExtension(EditorView.updateListener.of(update => {
  if (update.selectionSet || update.docChanged) updateToolbar(update.state);
}));

function updateToolbar(state = window.editor?.state) {
  if (!state) return;
  const format = formattingState(state);
  $('heading').value = format.heading;
  for (const [command, key] of [['toggleBold', 'bold'], ['toggleItalic', 'italic']]) {
    document.querySelector(`[data-command="${command}"]`).setAttribute('aria-pressed', format[key]);
  }
}

function update(contentEdited = true) {
  if(!window.editor?.state) return;
  const state = window.editor.state, sel = state.selection.main, line = state.doc.lineAt(sel.head);
  $('position').textContent = `Ln ${line.number}, Col ${sel.head-line.from+1}`;
  if(contentEdited) { clearTimeout(timer); timer = setTimeout(refresh, 120); }
}
function refresh() {
  const text = getEditorText(), dirty = text !== savedText;
  window.desktop.changed(dirty);
  if(!isBusy)$('save-state').textContent = dirty ? 'Unsaved changes' : 'All changes saved';
  $('counts').textContent = `${(text.match(/\S+/gu)||[]).length.toLocaleString()} words · ${window.editor.state.doc.lines.toLocaleString()} lines`;
  $('line-ending').textContent = window.editor.state.lineBreak === '\r\n' ? 'CRLF':'LF';
  renderPreview(text);
}
async function renderPreview(text, diagramDark = !!prefs.dark) {
  const generation = ++renderGeneration, preview = $('preview'), oldScroll = preview.scrollTop;
  if(text.length > 1000000) { preview.textContent='Live preview is paused for documents over 1 million characters. You can still edit and save the complete file.'; return; }
  if(!text.trim()) { preview.innerHTML = '<div class="empty"><strong>A little room to write.</strong><p>Your Markdown will appear here as you type.</p></div>'; return generation; }
  const { fragment, tasks, text: previewText } = markdownPreview(mermaidFile ? '' : text);
  for (const {input, from} of tasks) {
    input.disabled = isBusy;
    input.addEventListener('change', () => {
      // A user may click the old preview during the debounce after typing.
      if (isBusy || window.editor.state.doc.toString() !== previewText) { refresh(); return; }
      window.editor.dispatch({changes: {from, to: from + 1, insert: input.checked ? 'x' : ' '}, annotations: isolateHistory.of('full')});
      clearTimeout(timer); refresh();
    });
  }
  const diagrams = [];
  const addDiagram = (source, original) => {
    const figure = document.createElement('figure'); figure.className = 'mermaid-diagram';
    figure.dataset.state = 'loading'; figure.textContent = 'Rendering diagram…';
    if (original) original.replaceWith(figure); else fragment.append(figure);
    diagrams.push({source, figure});
  };
  if (mermaidFile) addDiagram(text);
  else for (const code of fragment.querySelectorAll('pre > code.language-mermaid')) addDiagram(code.textContent, code.parentElement);
  const images = [...fragment.querySelectorAll('img')].map(img => { const source = img.getAttribute('src'); img.removeAttribute('src'); return {img,source}; });
  for(const link of fragment.querySelectorAll('a')) { link.removeAttribute('target'); link.rel='noreferrer noopener'; }
  const slugs=new Map();
  for(const heading of fragment.querySelectorAll('h1,h2,h3,h4,h5,h6')) { const base=heading.textContent.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu,'').replace(/\s/g,'-'); const count=slugs.get(base)||0;slugs.set(base,count+1);const slug=base+(count?`-${count}`:'');heading.dataset.anchor=slug;heading.id=`preview-heading-${slug}`; }
  preview.replaceChildren(fragment); preview.scrollTop = oldScroll;
  const renderedDiagrams = diagrams.map(({source, figure}) => renderDiagram(source, figure, diagramDark, () => generation === renderGeneration && figure.isConnected));
  for(const {img,source} of images) {
    const data = source ? await window.desktop.image(source).catch(()=>null) : null;
    if(generation !== renderGeneration) return;
    const unavailable = () => {
      if(generation !== renderGeneration || !img.isConnected)return;
      const note=document.createElement('span'); note.className='image-note'; note.setAttribute('role','status');
      note.textContent=`Could not display image: ${img.alt || source || 'unavailable'}. Check or replace its image link in the editor.`;
      img.replaceWith(note);
    };
    img.onerror=unavailable;
    if(data) { img.src=data; try { await img.decode(); } catch { unavailable(); } } else unavailable();
  }
  await Promise.all(renderedDiagrams);
  await Promise.all([...preview.querySelectorAll('.mermaid-diagram img')].map(img=>img.decode().catch(()=>{})));
  return generation;
}
async function prepareExport() {
  const text=getEditorText();
  if(text.length>1000000)throw new Error('Export supports documents up to one million characters. Reduce the document size and try again.');
  clearTimeout(timer);
  try {
    const generation=await renderPreview(text,false);
    if(generation!==renderGeneration)throw new Error('The preview changed while preparing export. Please try again.');
    const result=exportDocument($('preview'));
    const unmount=mountPrintDocument(document,result.article);
    return {...result,cleanup:()=>{unmount();void renderPreview(getEditorText());}};
  } catch(error) { void renderPreview(getEditorText()); throw error; }
}
async function load(text, standaloneMermaid = false) {
  mermaidFile = standaloneMermaid;
  loading=true; clearTimeout(timer);
  await resetEditor(text);
  window.editor.contentDOM.setAttribute('aria-label','Markdown source');
  savedText=getEditorText(); loading=false; setBusy(isBusy); updateToolbar(); update(false); refresh();
  window.editor.scrollDOM.addEventListener('scroll',syncScroll,{passive:true});
}
function setBusy(value, label = 'Working…') {
  isBusy=value; settings.setReadOnlyMode(value);
  $('workspace').setAttribute('aria-busy',String(value));
  document.querySelectorAll('[data-action],#export-format,.formatbar button,.formatbar select,#replace-next,#replace-all,#preview input[data-preview-task]').forEach(b=>b.disabled=value);
  $('more-formatting').querySelector('summary').setAttribute('aria-disabled',String(value));
  $('save-state').textContent=value?label:getEditorText()!==savedText?'Unsaved changes':'All changes saved';
  if(value)$('more-formatting').open=false;
}
function layout(value) { if(!['edit','read','split'].includes(value)) return; $('workspace').dataset.layout=value; document.querySelectorAll('[data-layout]').forEach(b=>{if(b.tagName==='BUTTON')b.setAttribute('aria-pressed',b.dataset.layout===value)}); prefs.layout=value; persist(); window.editor?.requestMeasure(); }
function setting({key,value}) {
  if(key==='dark') { document.body.classList.toggle('dark',value); settings.setTheme(value?'github-dark':'github-light'); $('theme').setAttribute('aria-label',`Switch to ${value?'light':'dark'} theme`); prefs.dark=value; persist(); window.desktop.theme(value); if(window.editor?.state)renderPreview(getEditorText()); }
  if(key==='lines') settings.setShowLineNumbers(value);
  if(key==='wrap') settings.setLineWrapping(value);
  if(key==='focus') settings.setFocusMode(value);
  if(key==='typewriter') settings.setTypewriterMode(value);
}
function searchQuery() { window.editor.dispatch({effects:setSearchQuery.of(new SearchQuery({search:$('query').value,replace:$('replacement').value,literal:true}))}); $('search-status').textContent=''; }
function showSearch() { if(prefs.layout==='read')layout('split'); $('search').hidden=false; $('query').focus(); $('query').select(); }
function command(name,value) {
  if(name.startsWith('layout:'))return layout(name.slice(7));
  if(name==='theme')return setting({key:'dark',value:!document.body.classList.contains('dark')});
  if(name==='load')return load(value);
  if(name==='busy')return setBusy(value);
  if(name==='saved') { savedText=value; refresh(); return; }
  if(name==='setting')return setting(value);
  if(name==='find')return showSearch();
  if(name==='findNext')return findNext(window.editor);
  if(isBusy)return;
  if(prefs.layout==='read')layout('split');
  window.editor.focus();
  if(name==='image')return $('image-file').click();
  if(name==='heading' && value==='0') {
    const changes=plainTextChanges(window.editor.state);
    if(changes.length)window.editor.dispatch({changes,annotations:isolateHistory.of('full')});
  }
  else if(name==='heading')commands.toggleHeading(Number(value));
  else if(name==='link')insertHyperLink('link text','https://');
  else if(name==='table')insertTable('Column','Item');
  else if(name==='undo')undo();
  else if(name==='redo')redo();
  else if(typeof commands[name]==='function')commands[name]();
}
function syncScroll() {
  if(!$('sync').checked||scrollPending)return;
  scrollPending=true;
  requestAnimationFrame(()=>{ const s=window.editor.scrollDOM,p=$('preview'); p.scrollTop=s.scrollTop/Math.max(1,s.scrollHeight-s.clientHeight)*(p.scrollHeight-p.clientHeight); scrollPending=false; });
}
window.windowsEditor={ snapshot:()=>{
  const text=getEditorText();
  const heading=mermaidFile?null:markdownPreview(text).fragment.querySelector('h1')?.textContent.trim()||null;
  return {text,dirty:text!==savedText,heading};
},setBusy,load,prepareExport,setMermaid:value=>{mermaidFile=value;} };
window.desktop.onCommand(command);
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>window.desktop.action(b.dataset.action));
document.querySelectorAll('[data-command]').forEach(b=>{b.onmousedown=e=>e.preventDefault();b.onclick=()=>{command(b.dataset.command,b.dataset.value);$('more-formatting').open=false;}});
$('heading').onchange=()=>{command('heading',$('heading').value);updateToolbar();};
let attachingImages=false;
async function insertImages(files, position) {
  if(isBusy || attachingImages)return;
  attachingImages=true;
  try {
    if(position!=null)window.editor.dispatch({selection:{anchor:position}});
    for(const file of files) {
      const source=await window.desktop.attachImage(file);
      if(!source)break;
      const {from,to}=window.editor.state.selection.main;
      const alt=file.name.replace(/\.[^.]+$/,'').replace(/[\[\]\\\r\n]/g,' ');
      const before=window.editor.state.doc.sliceString(0,from);
      const prefix=from===0 || before.endsWith('\n\n')?'':before.endsWith('\n')?'\n':'\n\n';
      const insert=`${prefix}![${alt}](<${source}>)\n\n`;
      window.editor.dispatch({changes:{from,to,insert},selection:{anchor:from+insert.length},annotations:isolateHistory.of('full')});
    }
    window.editor.focus();
  } finally { attachingImages=false; }
}
$('image-file').onchange=()=>{
  const files=[...$('image-file').files]; $('image-file').value='';
  void insertImages(files);
};
const imageFiles=data=>[...(data?.files||[])].filter(file=>/\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name));
$('editor').addEventListener('paste',event=>{
  const files=imageFiles(event.clipboardData);
  if(!files.length)return;
  event.preventDefault(); event.stopPropagation();
  void insertImages(files);
},true);
$('editor').addEventListener('dragover',event=>{
  if(event.dataTransfer?.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect=isBusy?'none':'copy'; }
},true);
$('editor').addEventListener('drop',event=>{
  const files=imageFiles(event.dataTransfer);
  if(!files.length)return;
  event.preventDefault(); event.stopPropagation();
  const position=window.editor.posAtCoords({x:event.clientX,y:event.clientY});
  void insertImages(files,position);
},true);
$('more-formatting').ontoggle=()=>{
  if(!$('more-formatting').open)return;
  if(isBusy){$('more-formatting').open=false;return;}
  const menu=$('more-formatting').querySelector('.format-menu'), rect=$('more-formatting').getBoundingClientRect();
  menu.style.left=`${Math.max(8,Math.min(rect.right-172,window.innerWidth-180))}px`;
  const below=window.innerHeight-rect.bottom-15, above=rect.top-15;
  const upwards=below<Math.min(240,menu.scrollHeight)&&above>below;
  const available=Math.max(40,upwards?above:below);
  menu.style.maxHeight=`${available}px`;
  menu.style.top=`${upwards?Math.max(8,rect.top-7-Math.min(menu.scrollHeight,available)):rect.bottom+7}px`;
};
window.addEventListener('resize',()=>{$('more-formatting').open=false;});
document.addEventListener('click',e=>{if(!$('more-formatting').contains(e.target))$('more-formatting').open=false;});
$('more-formatting').addEventListener('focusout',()=>{
  queueMicrotask(()=>{if(!$('more-formatting').contains(document.activeElement))$('more-formatting').open=false;});
});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('more-formatting').open){$('more-formatting').open=false;$('more-formatting').querySelector('summary').focus();e.preventDefault();}});
document.querySelectorAll('button[data-layout]').forEach(b=>b.onclick=()=>layout(b.dataset.layout));
$('theme').onclick=()=>setting({key:'dark',value:!document.body.classList.contains('dark')});
$('export-format').onchange=()=>{const format=$('export-format').value;$('export-format').value='';void window.desktop.exportDocument(format);};
$('dismiss-error').onclick=()=>{$('action-notice').hidden=true;window.editor.focus();};
$('query').oninput=searchQuery; $('replacement').oninput=searchQuery;
$('query').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();(e.shiftKey?findPrevious:findNext)(window.editor)}};
$('find-next').onclick=()=>{if(!findNext(window.editor))$('search-status').textContent='No matches'};
$('find-prev').onclick=()=>findPrevious(window.editor);
$('replace-next').onclick=()=>replaceNext(window.editor);
$('replace-all').onclick=()=>replaceAll(window.editor);
$('close-search').onclick=()=>{$('search').hidden=true;window.editor.focus()};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('search').hidden){$('close-search').click();e.preventDefault()}});
document.addEventListener('keydown',e=>{
  if(!e.ctrlKey||e.altKey)return;
  const key=e.key.toLowerCase();
  const file={n:'new',o:'open',s:e.shiftKey?'saveAs':'save'}[key];
  if(file){e.preventDefault();e.stopPropagation();window.desktop.action(file);return;}
  const action={f:'find',b:'toggleBold',i:'toggleItalic',e:'toggleInlineCode'}[key];
  if(action){e.preventDefault();e.stopPropagation();command(action);return;}
  if(['1','2','3','4','5','6'].includes(key)){e.preventDefault();e.stopPropagation();command('heading',Number(key));}
},true);
$('preview').addEventListener('click',e=>{const a=e.target.closest('a');if(!a)return;e.preventDefault();const href=a.getAttribute('href')||'';if(href.startsWith('#')){try{const id=decodeURIComponent(href.slice(1));[...$('preview').querySelectorAll('[id]')].find(n=>n.dataset.anchor===id||n.id===id)?.scrollIntoView({block:'start'});}catch{}return;}window.desktop.openLink(href)});
const divider=$('divider');
function setSplit(value){value=Math.min(75,Math.max(25,value));document.documentElement.style.setProperty('--split',`${value}%`);divider.setAttribute('aria-valuenow',Math.round(value));prefs.split=value;window.editor?.requestMeasure()}
divider.onpointerdown=e=>{divider.setPointerCapture(e.pointerId)};
divider.onpointermove=e=>{if(divider.hasPointerCapture(e.pointerId)){const r=$('workspace').getBoundingClientRect();setSplit((e.clientX-r.left)/r.width*100)}};
divider.onpointerup=e=>{divider.releasePointerCapture(e.pointerId);persist()};
divider.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();setSplit(Number(divider.getAttribute('aria-valuenow'))+(e.key==='ArrowLeft'?-2:2));persist()}};
async function boot() { await load(''); setting({key:'dark',value:!!prefs.dark}); layout(prefs.layout||'split'); setSplit(prefs.split||50); await window.desktop.ready(); }
boot().catch(error=>{ $('message').textContent='Could not start editor'; console.error(error); });
