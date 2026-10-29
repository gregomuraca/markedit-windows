const {chromium}=require('playwright');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');

async function run(){
  const work=path.resolve(process.env.MARKEDIT_WORK_DIR||'work',`export-${Date.now()}`);
  await fs.mkdir(work,{recursive:true});
  const source=path.join(work,'original.md'),original='# Original saved document\n';
  await fs.writeFile(source,original);
  await fs.writeFile(path.join(work,'image.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0XcAAAAASUVORK5CYII=','base64'));
  const draft='---\ntitle: Export check\ntags: [Windows, GFM]\n---\n# Export Review\n\nUnsaved **draft** with ~~removed~~ text and writer@example.com.\n\n[Jump to details](#details)\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| one | two | 42 |\n\n- [x] Completed task\n- [ ] Pending task\n\n![Local image](image.png)\n\n```mermaid\nflowchart LR\n A[Draft] --> B[Export]\n```\n\n> [!WARNING]\n> Keep the source draft.\n\n## Details\n\n```html\n<script>literal code</script>\n```\n\n'+Array.from({length:65},(_,i)=>`Paragraph ${i+1}: Markdown exports preserve readable text, links and page margins.\n\n`).join('')+'END OF EXPORT\n';
  const port=Number(process.env.MARKEDIT_DEBUG_PORT||9348);
  const child=spawn(path.resolve(process.env.MARKEDIT_EXE||'src-tauri/target/release/markedit-rust.exe'),[source],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:path.join(work,'profile')},stdio:'pipe'});
  let browser,offline;
  try{
    for(let i=0;i<60;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break;}catch{await new Promise(r=>setTimeout(r,500));}}
    assert.ok(browser,'app started');
    const page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(30000);
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.waitForFunction(()=>window.editor?.state && !window.config.readOnlyMode);
    const edit=text=>page.evaluate(text=>{const e=window.editor;e.dispatch({changes:{from:0,to:e.state.doc.length,insert:text}});},text);
    await edit(draft);
    const before=await page.evaluate(()=>window.windowsEditor.snapshot());
    const exportFile=async(format,{cancel=false,name='Export Review',filename=`review.${format}`}={})=>{
      const destination=path.join(work,filename);
      const helper=promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/export-dialog.ps1'),'-AppProcessId',String(child.pid),'-DialogTitle',`Export ${format.toUpperCase()}`,'-ExpectedName',`${name}.${format}`,...(cancel?['-Cancel']:['-Destination',destination])],{windowsHide:true,timeout:35000});
      const action=page.evaluate(format=>window.desktop.exportDocument(format),format);
      let result;
      try { [result]=await Promise.all([helper,action]); }
      catch(error){ console.error('App status:',await page.locator('#action-error').textContent()); await page.screenshot({path:path.join(work,'failure.png')});throw error; }
      console.log(result.stdout.trim());
      assert.equal(await page.locator('#action-notice').isVisible(),false,await page.locator('#action-error').textContent());
      assert.equal(await page.locator('#export-output').count(),0);
      return destination;
    };
    await exportFile('html',{cancel:true});
    assert.deepEqual(await page.evaluate(()=>window.windowsEditor.snapshot()),before);
    const html=await exportFile('html');
    await page.locator('#theme').click();
    const pdf=await exportFile('pdf');
    assert.deepEqual(await page.evaluate(()=>window.windowsEditor.snapshot()),before);
    assert.equal(await fs.readFile(source,'utf8'),original);
    assert.equal((await fs.readFile(pdf)).subarray(0,5).toString(),'%PDF-');
    await page.setViewportSize({width:720,height:480});
    const bounds=await page.locator('#export-format').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=720);
    await page.screenshot({path:path.join(work,'app-dark-narrow.png')});
    offline=await chromium.launch({channel:'msedge',headless:true});
    const out=await offline.newPage({viewport:{width:1000,height:1100}});await out.context().setOffline(true);
    await out.goto(require('node:url').pathToFileURL(html).href);
    await out.waitForFunction(()=>[...document.images].every(i=>i.complete&&i.naturalWidth>0));
    assert.equal(await out.locator('h1').textContent(),'Export Review');
    assert.equal(await out.locator('script,header,nav').count(),0);
    assert.equal(await out.locator('img').count(),2);
    assert.equal(await out.locator('td[align=right]').evaluate(e=>getComputedStyle(e).textAlign),'right');
    assert.equal(await out.locator('input:checked').count(),1);
    assert.equal(await out.locator('a[href="#details"]').count(),1);
    assert.equal(await out.locator('#details').count(),1);
    await out.screenshot({path:path.join(work,'export-html.png'),fullPage:true});
    await edit('');await exportFile('html',{name:'original',filename:'blank.html'});
    assert.ok(!(await fs.readFile(path.join(work,'blank.html'),'utf8')).includes('A little room to write'));
    await edit('# Missing\n\n![missing](not-found.png)\n\n```mermaid\nnot a valid diagram\n```');await exportFile('html',{name:'Missing',filename:'missing.html'});
    assert.ok((await fs.readFile(path.join(work,'missing.html'),'utf8')).includes('Could not display image'));
    assert.ok((await fs.readFile(path.join(work,'missing.html'),'utf8')).includes('diagram-error'));
    assert.ok((await page.locator('#message').textContent()).includes('unavailable content'));
    assert.deepEqual(errors,[]);
    await fs.writeFile(path.join(work,'result.json'),JSON.stringify({html,pdf,checks:'Native HTML/PDF export, unsaved draft, source preservation, cancel, blank, missing image, offline resources, GFM, dark/narrow toolbar',errors},null,2));
    console.log(`PASS: export checks; artifacts: ${work}`);
  }finally{await offline?.close();await browser?.close();child.kill();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
