const {chromium}=require('playwright');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');

async function run(){
  const work=path.resolve(process.env.MARKEDIT_WORK_DIR||'work',`images-${Date.now()}`);
  const original=path.join(work,'original'),copy=path.join(work,'copy'),conflict=path.join(work,'conflict');
  for(const dir of [original,copy,conflict])await fs.mkdir(path.join(dir,'assets/nested'),{recursive:true});
  const photo=await fs.readFile('desktop/icon.png');
  await fs.writeFile(path.join(original,'assets/nested/a b.png'),photo);
  await fs.writeFile(path.join(original,'assets/unused.png'),photo);
  const filename=path.join(original,'source.md'),saved='# Saved original\r\n\r\n![Logo](assets/nested/a%20b.png)\r\n';
  await fs.writeFile(filename,'\uFEFF'+saved);
  const draft='# Portable draft\r\n\r\n![Inline](assets/nested/a%20b.png)\r\n\r\n![Reference][photo]\r\n\r\n[photo]: assets/nested/a%20b.png\r\n\r\n<img src="assets/nested/a%20b.png" alt="HTML">\r\n\r\n```md\r\n![Not an attachment](assets/unused.png)\r\n```\r\n';
  const port=Number(process.env.MARKEDIT_DEBUG_PORT||9362);
  const child=spawn(path.resolve(process.env.MARKEDIT_EXE||'src-tauri/target/release/markedit-rust.exe'),[filename],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:path.join(work,'profile')}});
  let browser;
  try{
    for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await new Promise(r=>setTimeout(r,400));}}
    assert.ok(browser,'app started');
    const page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(25000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>document.querySelector('#preview img')?.naturalWidth>0&&!window.config.readOnlyMode);
    await page.evaluate(text=>{const e=window.editor;e.dispatch({changes:{from:0,to:e.state.doc.length,insert:text}});},draft);
    await page.waitForFunction(()=>document.querySelectorAll('#preview img').length===3&&[...document.querySelectorAll('#preview img')].every(i=>i.naturalWidth>0));
    const before=await page.evaluate(()=>window.windowsEditor.snapshot());
    assert.deepEqual(before.imageSources,['assets/nested/a%20b.png']);
    const saveAs=async(destination,cancel=false)=>{
      const helper=promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/export-dialog.ps1'),'-AppProcessId',String(child.pid),'-DialogTitle','Save As','-ExpectedName','Portable draft.md',...(cancel?['-Cancel']:['-Destination',destination])],{windowsHide:true,timeout:35000});
      await Promise.all([helper,page.evaluate(()=>window.desktop.action('saveAs'))]);
    };
    await saveAs('',true);
    assert.deepEqual(await page.evaluate(()=>window.windowsEditor.snapshot()),before);
    const destination=path.join(copy,'Portable draft.md');
    await saveAs(destination);
    assert.equal(await page.locator('#action-notice').isVisible(),false);
    await page.waitForFunction(()=>document.querySelectorAll('#preview img').length===3&&[...document.querySelectorAll('#preview img')].every(i=>i.naturalWidth>0));
    assert.equal(await page.locator('.image-note').count(),0);
    assert.equal(await fs.readFile(filename,'utf8'),'\uFEFF'+saved);
    assert.equal(await fs.readFile(destination,'utf8'),'\uFEFF'+draft);
    assert.deepEqual(await fs.readFile(path.join(copy,'assets/nested/a b.png')),photo);
    assert.equal(await fs.stat(path.join(copy,'assets/unused.png')).then(()=>true,()=>false),false);
    assert.equal(await page.evaluate(()=>window.windowsEditor.snapshot().dirty),false);
    await saveAs(path.join(copy,'another.md'));
    assert.equal((await fs.readdir(path.join(copy,'assets/nested'))).length,1);
    await fs.writeFile(path.join(conflict,'assets/nested/a b.png'),'keep this image');
    await page.evaluate(()=>{const e=window.editor;e.dispatch({changes:{from:e.state.doc.length,insert:'\r\nUnsaved edit'}});});
    const dirty=await page.evaluate(()=>window.windowsEditor.snapshot());
    await saveAs(path.join(conflict,'Portable draft.md'));
    assert.ok((await page.locator('#action-error').textContent()).includes('different contents'));
    assert.deepEqual(await page.evaluate(()=>window.windowsEditor.snapshot()),dirty);
    assert.equal(await fs.readFile(path.join(conflict,'assets/nested/a b.png'),'utf8'),'keep this image');
    assert.equal(await fs.stat(path.join(conflict,'Portable draft.md')).then(()=>true,()=>false),false);
    await page.locator('#dismiss-error').click();await page.evaluate(()=>window.desktop.action('save'));
    assert.equal(await fs.readFile(path.join(copy,'another.md'),'utf8'),'\uFEFF'+dirty.text);
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(work,'result.json'),JSON.stringify({checks:['Cross-folder Save As keeps inline/reference/HTML images','Only referenced images copied','Source Markdown and assets unchanged','BOM/CRLF preserved','Cancel retains draft','Same-folder Save As reuses assets','Collision keeps original path, dirty draft and existing image'],errors},null,2));
    console.log(`PASS: image portability and collision recovery; ${work}`);
  }finally{await browser?.close();child.kill();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
