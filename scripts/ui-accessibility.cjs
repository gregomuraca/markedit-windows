const {chromium}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const rgba=s=>s.match(/[\d.]+/g).map(Number);
const over=(fg,bg)=>{const a=fg[3]??1;return fg.slice(0,3).map((v,i)=>v*a+bg[i]*(1-a));};
const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(fg,bg)=>{const a=luminance(fg),b=luminance(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
(async()=>{
 const work=path.resolve(process.env.MARKEDIT_REVIEW_DIR||path.join('work',`emil-${Date.now()}`));await fs.mkdir(work,{recursive:true});
 const file=path.join(work,'Review.md');await fs.writeFile(path.join(work,'broken.png'),'not an image');
 const sample='---\ntitle: Review\n---\n# Clear thoughts\n\nA writing interface should keep everyday editing predictable. Read mode should keep paragraphs within a comfortable reading column instead of stretching across the entire desktop window.\n\n'+['NOTE','TIP','IMPORTANT','WARNING','CAUTION'].map(t=>`> [!${t}]\n> Readable content in both themes.`).join('\n\n')+'\n\n![Broken image](broken.png)';
 await fs.writeFile(file,sample);
 const port=Number(process.env.MARKEDIT_DEBUG_PORT||9353);
 const child=spawn(path.resolve(process.env.MARKEDIT_EXE||'src-tauri/target/release/markedit-rust.exe'),[file],{windowsHide:true,env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port}`,WEBVIEW2_USER_DATA_FOLDER:path.join(work,'profile')}});
 let browser;const results={contrast:{},checks:[],errors:[],screenshots:[]};
 try {
  for(let i=0;i<50;i++){try{browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);break}catch{await new Promise(r=>setTimeout(r,400))}}
  assert.ok(browser);const page=browser.contexts()[0].pages()[0];page.setDefaultTimeout(12000);page.on('pageerror',e=>results.errors.push(e.message));
  await page.waitForFunction(()=>window.editor?.state.doc.toString().includes('Clear thoughts')&&!window.config.readOnlyMode);
  const edit=async source=>{await page.evaluate(source=>window.editor.dispatch({changes:{from:0,to:window.editor.state.doc.length,insert:source},selection:{anchor:0}}),source);await page.waitForTimeout(180)};
  const screenshot=async name=>{await page.screenshot({path:path.join(work,name+'.png')});results.screenshots.push(name+'.png')};
  await page.setViewportSize({width:1200,height:800});
  await page.locator('.image-note').waitFor();assert.match(await page.locator('.image-note').innerText(),/Check or replace/);
  results.checks.push('Existing corrupt images show recovery text');
  for(const theme of ['light','dark']) {
   if(theme==='dark')await page.locator('#theme').click();
   const values=await page.evaluate(()=>({paper:getComputedStyle(document.querySelector('section')).backgroundColor,status:getComputedStyle(document.querySelector('#save-state')).color,footerColor:getComputedStyle(document.querySelector('footer')).color,footerBackground:getComputedStyle(document.querySelector('footer')).backgroundColor,alerts:[...document.querySelectorAll('.markdown-alert')].map(el=>({name:el.className,background:getComputedStyle(el).backgroundColor,body:getComputedStyle(el).color,title:getComputedStyle(el.querySelector('.markdown-alert-title')).color}))}));
   const paper=rgba(values.paper);const ratios={status:contrast(rgba(values.status),paper),footer:contrast(rgba(values.footerColor),rgba(values.footerBackground)),alerts:values.alerts.map(a=>{const bg=over(rgba(a.background),paper);return {name:a.name,title:contrast(rgba(a.title),bg),body:contrast(rgba(a.body),bg)}})};
   assert.ok(ratios.status>=4.5);assert.ok(ratios.footer>=4.5);
   for(const alert of ratios.alerts){assert.ok(alert.title>=4.5,`${theme} ${alert.name} title ${alert.title}`);assert.ok(alert.body>=4.5,`${theme} ${alert.name} body ${alert.body}`)}
   results.contrast[theme]=ratios;await screenshot(theme+'-split');
  }
  results.checks.push('All alert titles/bodies, saved state and footer exceed 4.5:1 in both themes');
  assert.equal(await page.locator('.yaml-frontmatter').evaluate(el=>getComputedStyle(el).fontSize),'9px');
  await page.getByRole('button',{name:'Read',exact:true}).click();await page.setViewportSize({width:1600,height:900});
  const width=await page.locator('#preview > p').first().evaluate(el=>el.getBoundingClientRect().width);assert.ok(width<800,`Read width ${width}`);results.readWidth=width;await screenshot('dark-read');
  await page.getByRole('button',{name:'Split',exact:true}).click();await page.locator('#theme').click();await page.setViewportSize({width:1200,height:800});
  for(const selector of ['[data-command="image"]','[data-command="toggleBold"]','#heading','#divider'])assert.ok((await page.locator(selector).boundingBox()).width>=39.5);
  results.checks.push('Read prose width limited; desktop hit targets at least 40px; 9px frontmatter preserved');
  await edit('Title\n=====\n\nBody');assert.equal(await page.locator('#heading').inputValue(),'1');await page.locator('#heading').selectOption('0');
  assert.equal(await page.evaluate(()=>window.editor.state.doc.toString()),'Title\n\nBody');await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>window.editor.state.doc.toString()),'Title\n=====\n\nBody');
  await edit('**bold** and *italic*');await page.evaluate(()=>window.editor.dispatch({selection:{anchor:4}}));assert.equal(await page.locator('[data-command="toggleBold"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>window.editor.dispatch({selection:{anchor:16}}));assert.equal(await page.locator('[data-command="toggleItalic"]').getAttribute('aria-pressed'),'true');
  await edit('# Heading\n\nPlain');await page.evaluate(()=>window.editor.dispatch({selection:{anchor:0,head:window.editor.state.doc.length}}));assert.equal(await page.locator('#heading').inputValue(),'mixed');
  results.checks.push('Setext Plain text and Undo work; heading/bold/italic/mixed states reflect the selection');
  await page.locator('#more-formatting summary').focus();await page.keyboard.press('Enter');for(let i=0;i<9;i++)await page.keyboard.press('Tab');assert.equal(await page.locator('#more-formatting').getAttribute('open'),null);
  await page.locator('#more-formatting summary').focus();await page.keyboard.press('Enter');await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement===document.querySelector('#more-formatting summary')),true);
  results.checks.push('More closes on keyboard focus departure and Escape restores trigger focus');
  await page.evaluate(()=>window.windowsEditor.setBusy(true,'Saving…'));assert.equal(await page.locator('[data-action="save"]').isDisabled(),true);assert.equal(await page.locator('[data-action="open"]').isDisabled(),true);assert.equal(await page.locator('#workspace').getAttribute('aria-busy'),'true');assert.equal(await page.locator('#save-state').innerText(),'Saving…');await page.evaluate(()=>window.windowsEditor.setBusy(false));
  results.checks.push('Busy file actions visibly disabled with accessible status');
  await page.setViewportSize({width:720,height:480});
  const before=await page.evaluate(()=>window.editor.state.doc.toString());
  for(const buffer of [Buffer.alloc(0),Buffer.from('invalid image')]){
   await page.locator('#image-file').setInputFiles({name:'invalid.png',mimeType:'image/png',buffer});await page.locator('#action-notice').waitFor();assert.equal(await page.locator('#action-error').isVisible(),true);assert.equal(await page.evaluate(()=>window.editor.state.doc.toString()),before);await screenshot(buffer.length?'narrow-invalid':'narrow-error');await page.locator('#dismiss-error').click();
  }
  results.checks.push('Empty/corrupt attachments rejected before source change; visible dismissible errors at 720px');
  const png=Buffer.from(await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=24;canvas.height=24;const ctx=canvas.getContext('2d');ctx.fillStyle='#34785d';ctx.fillRect(0,0,24,24);return [...Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0))]}));
  await page.locator('#image-file').setInputFiles({name:'valid.png',mimeType:'image/png',buffer:png});await page.waitForFunction(()=>document.querySelector('#preview img')?.naturalWidth===24);
  for(const type of ['paste','drop']) {
   await page.evaluate(({type,bytes})=>{
    const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],`${type}.png`,{type:'image/png'}));
    const target=document.querySelector('#editor .cm-content'),rect=target.getBoundingClientRect();
    target.dispatchEvent(type==='paste'?new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}):new DragEvent('drop',{dataTransfer:data,bubbles:true,cancelable:true,clientX:rect.x+20,clientY:rect.y+20}));
   },{type,bytes:[...png]});
   await page.waitForFunction(count=>document.querySelectorAll('#preview img').length===count&&[...document.querySelectorAll('#preview img')].every(img=>img.naturalWidth===24),type==='paste'?2:3);
  }
  await page.evaluate(()=>window.desktop.action('save'));assert.match(await fs.readFile(file,'utf8'),/assets\/image-/);const assets=await fs.readdir(path.join(work,'assets'));assert.equal(assets.length,3);for(const asset of assets)assert.deepEqual(await fs.readFile(path.join(work,'assets',asset)),png);
  results.checks.push('Valid image selection, paste and drop save exact image bytes after validation');
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#theme').click();await page.getByRole('button',{name:'Read',exact:true}).click();await page.getByRole('button',{name:'Split',exact:true}).click();
  assert.deepEqual(results.errors,[]);results.verdict='Ship it for reviewed desktop scope';await fs.writeFile(path.join(work,'review-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify({verdict:results.verdict,checks:results.checks,contrast:results.contrast,readWidth:results.readWidth,evidence:work},null,2));
 }finally{await browser?.close();child.kill()}
})().catch(e=>{console.error(e);process.exitCode=1});
