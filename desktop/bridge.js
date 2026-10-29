import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

let handler, busy = false;
function report(error) {
  const notice=document.getElementById('action-notice');
  document.getElementById('action-error').textContent = `Could not complete action: ${String(error)} Check the file or choose another location, then try again.`;
  notice.hidden=false;
  console.error(error);
}
async function action(action) {
  if (busy) return;
  busy = true;
  window.windowsEditor.setBusy(true, ['save','saveAs'].includes(action)?'Saving…':action==='open'?'Opening…':'Working…');
  try {
    const result = await invoke('perform', { action, ...window.windowsEditor.snapshot() });
    if (result.kind === 'load') await window.windowsEditor.load(result.text, result.mermaid);
    if (result.kind === 'saved') { window.windowsEditor.setMermaid(result.mermaid); handler('saved', result.text); }
    if(result.kind!=='none')document.getElementById('action-notice').hidden=true;
  } catch (error) { report(error); }
  finally { busy = false; window.windowsEditor.setBusy(false); }
}
const listening = listen('desktop-command', ({ payload }) => {
  if (['new', 'open', 'save', 'saveAs', 'close'].includes(payload)) action(payload);
  else if(payload.startsWith('export:'))window.desktop.exportDocument(payload.slice(7));
  else handler?.(payload);
});
window.desktop = {
  action,
  onCommand(callback) { handler = callback; },
  async ready() { await listening; await action('startup'); },
  changed(dirty) { invoke('changed', { dirty }).catch(report); },
  image(source) { return invoke('image', { source }); },
  async exportDocument(format) {
    if(busy)return;
    busy=true;window.windowsEditor.setBusy(true,`Exporting ${format.toUpperCase()}…`);
    let prepared;
    try {
      prepared=await window.windowsEditor.prepareExport();
      const path=await invoke('export_document',{format,html:prepared.html,heading:prepared.title==='Untitled'?null:prepared.title});
      if(path){document.getElementById('action-notice').hidden=true;document.getElementById('message').textContent=`Exported ${format.toUpperCase()}${prepared.warnings?' with unavailable content labeled':''}.`;}
    }catch(error){report(error);}
    finally{prepared?.cleanup();busy=false;window.windowsEditor.setBusy(false);}
  },
  async attachImage(file) {
    if(busy)return null;
    busy=true; window.windowsEditor.setBusy(true,'Adding image…');
    try {
      if(file.size>20*1024*1024)throw new Error('Images must be 20 MB or smaller.');
      if(!file.size)throw new Error('This image is empty. Choose another image.');
      try { const image=await createImageBitmap(file); image.close(); }
      catch { throw new Error('This image cannot be decoded. Choose a valid PNG, JPEG, GIF, WebP or BMP image.'); }
      const snapshot=window.windowsEditor.snapshot();
      const result=await invoke('attach_image',{name:file.name,bytes:Array.from(new Uint8Array(await file.arrayBuffer())),...snapshot});
      if(result.saved)handler('saved',snapshot.text);
      if(result.source)document.getElementById('action-notice').hidden=true;
      return result.source;
    } catch(error) { report(error); return null; }
    finally { busy=false; window.windowsEditor.setBusy(false); }
  },
  openLink(href) { invoke('open_link', { href }).catch(report); },
  theme() {},
};
