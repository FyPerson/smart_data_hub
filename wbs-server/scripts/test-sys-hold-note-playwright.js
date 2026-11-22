// #208 C3：test-env 真服务与临时实例库，实际表单上传/下载/历史/生命周期。
// 浏览器路径仅接受环境变量 PLAYWRIGHT_CHROMIUM_EXECUTABLE；不内置本机绝对路径，不装依赖。
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),sqlite3=require('sqlite3');
const {chromium}=require('playwright');
const testEnv=require('./lib/test-env');
const {deleteTreeNoFollow}=require('../../scripts/lines/line-common');
let db,browser,page,passed=0,env,token,artifacts,png;
const run=(sql,p=[])=>new Promise((resolve,reject)=>db.run(sql,p,function(e){e?reject(e):resolve(this);}));
async function api(method,url,body){
 const res=await fetch(env.baseUrl+'/api'+url,{method,headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const raw=await res.text();let json;try{json=JSON.parse(raw);}catch(_){}
 assert.ok(res.ok,'fixture API '+res.status+' '+raw);return json;
}
async function check(label,fn){try{await fn();passed++;console.log('PASS '+label);}catch(e){throw new Error('FAIL '+label+': '+e.message,{cause:e});}}
function within(p,label){let timer;return Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' timeout')),15000);})]).finally(()=>clearTimeout(timer));}
async function issue(){
 const id=(await run(`INSERT INTO sys_issues(type,status,title,system_name,created_by,created_by_name,assigned_to,assigned_to_name,assigned_at,intake_required,intake_liaison_id)
  VALUES ('feature','开发中','C3 暂缓备注浏览器夹具','BMS',1,'C3 测试管理员',5,'C3 测试开发',datetime('now','localtime'),1,13)`)).lastID;
 await run("INSERT INTO sys_issue_dev_assignees(issue_id,user_id,user_name,is_primary) VALUES (?,5,'C3 测试开发',1)",[id]);
 await api('POST','/sys-issues/'+id+'/hold',{reason:'C3 fixture'});return id;
}
async function open(id){await page.evaluate(x=>siOpenDrawer(x),id);await page.waitForFunction(x=>siDetail&&Number(siDetail.issue.id)===x,id);}
async function closed(){await page.locator('#siModalOverlay').waitFor({state:'hidden'});}
async function settledToasts(){await page.waitForFunction(()=>!document.getElementById('toast-container')||document.getElementById('toast-container').children.length===0);}
async function waitEdits(noteId,count){await page.waitForFunction(({noteId,count})=>siCurTimeline.filter(e=>e.action_code==='hold_note_edit'&&Number(e.ref_id)===noteId).length===count,{noteId,count});}
const upload=(name,buffer=Buffer.from('C3 file bytes'),mimeType='application/pdf')=>({name,mimeType,buffer});
async function cancel(){await page.locator('#siModalOverlay').getByRole('button',{name:'取消',exact:true}).click();await closed();}
async function draftImage(id){
 await open(id);await page.evaluate(()=>siHoldNoteAdd());
 const before=await page.evaluate(()=>__hnUrls.length);
 await page.locator('#siPickerInput_hold-note').setInputFiles(upload('draft.png',png,'image/png'));
 await page.waitForFunction(n=>__hnUrls.length>n,before);
 return page.evaluate(n=>__hnUrls.slice(n),before);
}
async function runBrowser(){
 env=testEnv.env();assert.strictEqual(env.live,false);
 png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mvkAAAAASUVORK5CYII=','base64');
 artifacts=fs.mkdtempSync(path.join(process.env.C3_EVIDENCE_DIR||os.tmpdir(),'sys-note-browser-'));
 db=new sqlite3.Database(env.dbPath);
 // 先验证隔离身份、再清理本次临时实例；从不把写入指向源库。
 const identity=await new Promise((resolve,reject)=>db.get('SELECT instance_id FROM _sdh_instance',(e,r)=>e?reject(e):resolve(r)));
 assert.strictEqual(identity.instance_id,env.instance);
 for(const table of ['sys_issue_dev_commits','sys_issue_dev_events','sys_issue_release_commit_snapshots','sys_issue_dev_assignees',
  'sys_issue_hold_note_attachments','sys_issue_attachments','sys_issue_timeline','sys_fast_release_executors','sys_issues','sys_release_executors','sys_releases','sys_issue_delete_audit'])await run('DELETE FROM '+table);
 await run('DELETE FROM users');
 for(const [id,name,role]of [[1,'admin','admin'],[5,'c3dev','user'],[7,'c3other','user'],[13,'c3liaison','user']]){
  await run('INSERT INTO users(id,username,password,display_name,role,status) VALUES (?,?,?,?,?,?)',[id,name,'unused-test-password-hash',id===1?'C3 测试管理员':'C3 测试用户 '+id,role,'active']);
 }
 token=await testEnv.signToken(1);const id=await issue();
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
 // [#217·2026-11-22] 登录页不注入凭据：真实登出后到 login.html 时没有 token。若这里照写，login.html 的 checkAuth
 //   会用它调 /auth/me 成功并跳到 /Task_Pool.html，末组「退出登录清理」读 localStorage 时撞上这次跳转
 //   （实测导航序列 /login.html → /Task_Pool.html），报「Execution context was destroyed」。
 await context.addInitScript(({token})=>{if(location.pathname==='/login.html')return;localStorage.setItem('token',token);localStorage.setItem('user',JSON.stringify({id:1,username:'admin',role:'admin'}));},{token});
 page=await context.newPage();const pageErrors=[],httpErrors=[],expectedHttpErrors=[];
 page.on('pageerror',e=>pageErrors.push(e.message));
 page.on('response',r=>{if(r.status()>=400)httpErrors.push([r.url(),r.status()]);});
 await page.route('**/favicon.ico',r=>r.fulfill({status:204}));
 if(process.env.C3_HTML_SOURCE)await page.route('**/Sys_Iteration.html',r=>r.fulfill({status:200,contentType:'text/html',body:fs.readFileSync(process.env.C3_HTML_SOURCE,'utf8')}));
 await page.goto(env.baseUrl+'/Sys_Iteration.html');
 await page.waitForFunction(()=>currentUser&&Number(currentUser.id)===1&&META_OK);
 await page.evaluate(()=>{
  window.__hnXss=0;window.__hnToasts=[];window.__hnUrls=[];window.__hnRevoked=[];window.__hnDownloadSettle=0;
  const toast=showToast;showToast=(m,t)=>{__hnToasts.push(String(m));return toast(m,t);};
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=b=>{const u=create(b);__hnUrls.push(u);return u;};URL.revokeObjectURL=u=>{__hnRevoked.push(u);return revoke(u);};
  const download=siDownloadHoldNoteAtt;siDownloadHoldNoteAtt=async(...args)=>{try{return await download(...args);}finally{__hnDownloadSettle++;}};
 });
 const badName='<img src=x onerror=window.__hnXss=1>.pdf';let noteId;
 await check('C3 browser add multipart',async()=>{
  await open(id);await page.getByRole('button',{name:'添加暂缓备注',exact:true}).click();
  await page.locator('#f_content').fill('<img src=x onerror=window.__hnXss=1> 原始备注');
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload(badName));
  assert.ok(await page.locator('#siMBody').innerText().then(t=>t.includes(badName)));
  await page.screenshot({path:path.join(artifacts,'01-add-form.png')});
  await page.locator('#siMConfirm').click();await closed();
  await page.waitForFunction(()=>siDetail&&siDetail.hold_note_attachments.length===1);
  noteId=await page.evaluate(()=>Number(siCurTimeline.find(e=>e.action_code==='hold_note').id));
  assert.strictEqual(await page.evaluate(()=>__hnXss),0);
  assert.strictEqual(await page.locator('#siDBody .si-hn-attachments').first().locator('button').count(),1);
 });
 await check('C3 browser cancel and revoke',async()=>{
  await page.evaluate(n=>siHoldNoteEdit(n),noteId);await page.locator('#siHoldNoteExisting button').click();
  await page.getByRole('button',{name:'撤销移除',exact:true}).click();
  assert.strictEqual(await page.getByRole('button',{name:'撤销移除',exact:true}).count(),0);
  const before=await page.evaluate(()=>__hnUrls.length);
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('cancel.png',png,'image/png'));
  const urls=await page.evaluate(n=>__hnUrls.slice(n),before);assert.ok(urls.length>0);
  await cancel();assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),0);
  assert.ok(await page.evaluate(urls=>urls.every(u=>__hnRevoked.includes(u)),urls));
  const dto=await api('GET','/sys-issues/'+id);assert.strictEqual(dto.hold_note_attachments[0].status,'active');
 });
 await check('C3 browser append zip and retry',async()=>{
  await page.evaluate(n=>siHoldNoteEdit(n),noteId);
  assert.ok((await page.locator('#siPickerInput_hold-note').getAttribute('accept')).includes('.zip'));
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('资料.zip',Buffer.from('zip attachment'),'application/zip'));
  const endpoint=env.baseUrl+'/api/sys-issues/'+id+'/hold-notes/'+noteId+'/edit';
  expectedHttpErrors.push([endpoint,500]);
  await page.route(endpoint,async r=>{await page.unroute(endpoint);await r.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'C3 测试拒绝'})});});
  await page.locator('#siMConfirm').click();await page.waitForFunction(()=>!document.getElementById('siMConfirm').disabled);
  assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),1);
  assert.ok(await page.locator('#siModalOverlay').isVisible());
  await page.locator('#siMConfirm').click();await closed();await waitEdits(noteId,1);
  assert.strictEqual(await page.locator('#siDBody .si-hn-attachments').first().locator('button').count(),2);
 });
 await check('C3 browser remove history and downloads',async()=>{
  await page.evaluate(n=>siHoldNoteEdit(n),noteId);
  await page.locator('#siHoldNoteExisting .si-hn-existing-row').filter({hasText:badName}).getByRole('button',{name:'移除',exact:true}).click();
  await settledToasts();await page.screenshot({path:path.join(artifacts,'04-edit-remove.png')});
  await page.locator('#siMConfirm').click();await closed();await waitEdits(noteId,2);
  const current=page.locator('#siDBody .si-hn-attachments').first();assert.strictEqual(await current.locator('button').count(),1);
  assert.ok((await page.locator('#siDBody').innerText()).includes('移除了 '+badName));
  await page.locator('#siDBody .si-hn-hist summary').click();
  const historical=page.locator('#siDBody .si-hn-hist li').filter({hasText:'原始：'}).first().locator('.si-hn-download').first();
  assert.strictEqual(await historical.count(),1,'removed attachment must remain downloadable in original history');
  const event=page.waitForEvent('download');await historical.click();const download=await event;
  assert.strictEqual(fs.readFileSync(await download.path(),'utf8'),'C3 file bytes');
  assert.strictEqual(await page.evaluate(()=>__hnXss),0);
  await settledToasts();await page.locator('#siDBody').evaluate(el=>{el.scrollTop=el.scrollHeight;});
  await page.screenshot({path:path.join(artifacts,'02-history.png')});
 });
 await check('L-605-1 browser busy download',async()=>{
  const dto=await api('GET','/sys-issues/'+id),att=dto.hold_note_attachments.find(a=>a.status==='active');
  const endpoint=env.baseUrl+'/api/sys-issues/'+id+'/hold-note-attachments/'+att.id+'/download';
  expectedHttpErrors.push([endpoint,503]);
  await page.route(endpoint,async r=>{await page.unroute(endpoint);await r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'SYS_BUSY'})});});
  const settled=await page.evaluate(()=>__hnDownloadSettle);
  await page.locator('#siDBody .si-hn-attachments').first().locator('button').click();
  await page.waitForFunction(n=>__hnDownloadSettle>n,settled);
  assert.ok(await page.evaluate(()=>__hnToasts.includes('系统繁忙，请稍后重试')),'503 must show the friendly busy message');
  const event=page.waitForEvent('download');await page.locator('#siDBody .si-hn-attachments').first().locator('button').click();
  const download=await event;assert.strictEqual(download.suggestedFilename(),'资料.zip');
 });
 await check('C3 browser cumulative six',async()=>{
  await page.evaluate(n=>siHoldNoteEdit(n),noteId);assert.strictEqual(await page.locator('#siHoldNoteExisting .si-hn-existing-row').count(),1);
  await page.locator('#siPickerInput_hold-note').setInputFiles(Array.from({length:5},(_,i)=>upload('batch'+i+'.txt',Buffer.from('text'),'text/plain')));
  assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),5);
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('sixth.txt'));assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),5);
  await page.locator('#siMConfirm').click();await closed();await waitEdits(noteId,3);
  assert.strictEqual(await page.locator('#siDBody .si-hn-attachments').first().locator('button').count(),6);
 });
 const scratch=await issue();
 await check('C3 browser busy and late instance',async()=>{
  await open(scratch);await page.evaluate(()=>siHoldNoteAdd());await page.locator('#f_content').fill('late response');
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('pending.pdf'));
  let arrived,release;const reached=new Promise(r=>{arrived=r;}),gate=new Promise(r=>{release=r;});
  const endpoint=env.baseUrl+'/api/sys-issues/'+scratch+'/hold-notes';
  const oldInstance=await page.evaluate(()=>siModalInstanceSeq);let response,finished,started=false;
  const interception=new Promise(r=>{finished=r;});
  const toastStart=await page.evaluate(()=>__hnToasts.length);
  await page.route(endpoint,async route=>{started=true;try{response=await route.fetch();arrived();await gate;await route.fulfill({response});}finally{finished();}});
  try{
   await page.locator('#siMConfirm').click();await within(reached,'delayed response reached');
   assert.strictEqual(await page.locator('#f_content').isDisabled(),true);assert.strictEqual(await page.locator('#siPickerInput_hold-note').isDisabled(),true);
   assert.strictEqual(await page.evaluate(()=>siPickerCollect('hold-note',[new File(['x'],'late.txt')])),0);
   await cancel();await page.evaluate(()=>siHoldNoteAdd());await page.locator('#f_content').fill('new instance untouched');
   await page.locator('#siPickerInput_hold-note').setInputFiles(upload('new.png',png,'image/png'));
   const next=await page.evaluate(()=>siModalInstanceSeq);release();
   await page.waitForFunction(n=>__siTestHooks.lastSettledInstance===n,oldInstance);
   assert.strictEqual(await page.evaluate(()=>siModalInstanceSeq),next);assert.strictEqual(await page.locator('#f_content').inputValue(),'new instance untouched');
   assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),1);
   assert.ok(await page.evaluate(n=>!__hnToasts.slice(n).includes('暂缓备注已添加'),toastStart),'late response must not announce success in a new modal');await cancel();
  }finally{release();if(started)await within(interception,'delayed response released');await page.unroute(endpoint);}
 });
 await check('C3 browser drawer and auth cleanup',async()=>{
  let urls=await draftImage(scratch);await open(id);assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),0);
  assert.ok(await page.evaluate(urls=>urls.every(u=>__hnRevoked.includes(u)),urls));await closed();
  urls=await draftImage(scratch);await page.evaluate(()=>siCloseDrawer());assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),0);
  assert.ok(await page.evaluate(urls=>urls.every(u=>__hnRevoked.includes(u)),urls));await closed();
  urls=await draftImage(scratch);await page.evaluate(()=>siModal('替换弹层',[note('生命周期验证')],()=>false));
  assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),0);assert.ok(await page.evaluate(urls=>urls.every(u=>__hnRevoked.includes(u)),urls));await cancel();
  urls=await draftImage(scratch);
  await page.evaluate(()=>{const t=localStorage.getItem('token');localStorage.removeItem('token');dispatchEvent(new StorageEvent('storage',{key:'token'}));localStorage.setItem('token',t);});
  assert.strictEqual(await page.evaluate(()=>siPickerFiles('hold-note').length),0);assert.ok(await page.evaluate(urls=>urls.every(u=>__hnRevoked.includes(u)),urls));
  await closed();
 });
 await check('C3 browser void and resume lock',async()=>{
  await open(id);await page.evaluate(n=>siHoldNoteVoid(n),noteId);await page.locator('#f_reason').fill('<img src=x onerror=window.__hnXss=1> 作废留痕');
  await page.locator('#siMConfirm').click();await closed();await page.waitForFunction(()=>siCurTimeline.some(e=>e.action_code==='hold_note_void'));
  const links=page.locator('#siDBody .si-hn-attachments').first().locator('button');
  assert.strictEqual(await links.count(),6);for(const link of await links.all())assert.strictEqual(await link.isEnabled(),true);
  assert.strictEqual(await page.locator('#siDBody .si-hn-attachments').first().locator('button').first().evaluate(el=>getComputedStyle(el).textDecorationLine),'none');
  const event=page.waitForEvent('download');await page.locator('#siDBody .si-hn-attachments').first().locator('button').first().click();await event;
  await api('POST','/sys-issues/'+scratch+'/resume',{reason:'browser resume'});await open(scratch);
  assert.strictEqual(await page.locator('#siDBody .si-hn-btn').count(),0);
  assert.strictEqual(await page.evaluate(()=>__hnXss),0);
 });
 // [时间线缩略图·2026-11-22] 暂缓备注里的图片附件：打开详情即显示小图（走暂缓备注附件端点）。
 //   [codex 610 L2] 图片先在、再追加 pdf、再移除图片：当前版本没有这张图，两个历史版本各有一张，每次渲染只取一次、共用同一地址；
 //   展开历史点小图弹放大层且显示的就是该地址。[codex 610 M2] 第一张显示后账号判定变为不一致（代际不变），后一张不得复用地址。
 await check('C3 browser hold-note image thumbnails',async()=>{
  const tid=await issue();await open(tid);
  await page.getByRole('button',{name:'添加暂缓备注',exact:true}).click();
  await page.locator('#f_content').fill('缩略图备注');
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('凭证图.png',png,'image/png'));
  await page.locator('#siMConfirm').click();await closed();
  await page.waitForFunction(()=>siDetail&&siDetail.hold_note_attachments.length===1);
  const tnote=await page.evaluate(()=>Number(siCurTimeline.find(e=>e.action_code==='hold_note').id));
  const tatt=await page.evaluate(()=>Number(siDetail.hold_note_attachments[0].id));
  await page.evaluate(n=>siHoldNoteEdit(n),tnote);
  await page.locator('#siPickerInput_hold-note').setInputFiles(upload('补充.pdf'));
  await page.locator('#siMConfirm').click();await closed();await waitEdits(tnote,1);
  await page.evaluate(n=>siHoldNoteEdit(n),tnote);
  await page.locator('#siHoldNoteExisting .si-hn-existing-row').filter({hasText:'凭证图.png'}).getByRole('button',{name:'移除',exact:true}).click();
  await page.locator('#siMConfirm').click();await closed();await waitEdits(tnote,2);
  const endpoint=env.baseUrl+'/api/sys-issues/'+tid+'/hold-note-attachments/'+tatt+'/download';
  const sel='#siDBody img.si-tl-thumb[data-att-kind="hold"][data-att-id="'+tatt+'"]';
  const hits=[],onReq=r=>{if(r.url()===endpoint)hits.push(r.method());};page.on('request',onReq);
  try{
   await open(tid);
   const ready=await page.waitForFunction(s=>{const t=[...document.querySelectorAll(s)];return t.length>=2&&t.every(i=>/^blob:/.test(i.getAttribute('src')||'')&&i.complete&&i.naturalWidth>0);},sel,{timeout:8000}).then(()=>true).catch(()=>false);
   const state=await page.evaluate(s=>[...document.querySelectorAll(s)].map(i=>({src:i.getAttribute('src'),w:i.naturalWidth,hist:!!i.closest('.si-hn-hist')})),sel);
   assert.ok(ready,'hold-note image thumbnails in history versions must show the image: '+JSON.stringify(state)+' placeholders='+await page.locator('#siDBody .si-hn-attachments .si-pdf-icon').count());
   assert.strictEqual(await page.locator('#siDBody .si-hn-attachments').first().locator('img.si-tl-thumb[data-att-id="'+tatt+'"]').count(),0,'the removed image must not appear in the current version');
   assert.ok(state.length===2&&state.every(x=>x.hist),'the removed image appears once in each of the two history versions: '+JSON.stringify(state));
   assert.strictEqual(new Set(state.map(x=>x.src)).size,1,'the same attachment shares one address: '+JSON.stringify(state));
   assert.deepStrictEqual(hits,['GET'],'the hold-note attachment is fetched once per render');
   await page.locator('#siDBody .si-hn-hist summary').first().click();
   await page.locator(sel).first().click();await page.locator('#siImgLightbox.show').waitFor({timeout:5000});
   assert.strictEqual(await page.locator('#siImgLightboxImg').getAttribute('src'),state[0].src);
   await page.evaluate(()=>siCloseLightbox(null));
  }finally{page.off('request',onReq);}
  // 替身只看目标附件（单号 + 附件编号）：它的一张小图拿到地址后账号判定即不一致（返回 0），代际不变。
  await page.evaluate(s=>{window.__realOwner=siHoldNoteOwnerId;siHoldNoteOwnerId=()=>document.querySelector(s+'[src^="blob:"]')?0:window.__realOwner();},'#siDBody img.si-tl-thumb[data-att-kind="hold"][data-att-issue="'+tid+'"][data-att-id="'+tatt+'"]');
  try{
   await open(tid);
   const settled=await page.waitForFunction(s=>{const t=[...document.querySelectorAll(s)];return t.length>0&&t.every(i=>i.getAttribute('src'));},sel,{timeout:8000}).then(()=>true).catch(()=>false);
   const after=await page.evaluate(s=>({blob:document.querySelectorAll(s+'[src^="blob:"]').length,img:document.querySelectorAll(s).length,ph:document.querySelectorAll('#siDBody .si-hn-attachments .si-pdf-icon').length}),sel);
   assert.ok(settled,'thumbnail loading must settle: '+JSON.stringify(after));
   assert.deepStrictEqual(after,{blob:1,img:1,ph:1},'after the account check flips, the duplicate must not reuse the address');
  }finally{await page.evaluate(()=>{siHoldNoteOwnerId=window.__realOwner;delete window.__realOwner;});await open(tid);}
 });
 await check('C3 browser audit snapshot',async()=>{
  await api('DELETE','/sys-issues/'+id,{reason:'C3 audit fixture'});
  const audits=await api('GET','/sys-issue-delete-audit');const entry=audits.items.find(x=>x.issue_id===id);assert.ok(entry);
  await page.evaluate(()=>siOpenDeleteAudit());await page.evaluate(x=>siOpenDeleteAuditDetail(x),entry.id);
  const target=page.locator('#siAuditJson-hold_note_attachments_json');await target.waitFor();
  assert.ok((await target.innerText()).includes(badName));assert.strictEqual(await target.locator('img').count(),0);
  assert.strictEqual(await page.evaluate(()=>__hnXss),0);await settledToasts();await target.scrollIntoViewIfNeeded();
  await page.screenshot({path:path.join(artifacts,'03-audit.png')});
 });
 await check('C3 browser logout cleanup',async()=>{
  const logoutIssue=await issue(),urls=await draftImage(logoutIssue);
  // 先登记 pagehide 证据，再用测试按钮触发真实 logout；不在 evaluate 内导航，避免执行上下文随导航销毁的竞态。
  await page.evaluate(urls=>{
   addEventListener('pagehide',()=>localStorage.setItem('__hnLogoutProof',JSON.stringify({count:siPickerFiles('hold-note').length,revoked:urls.every(u=>__hnRevoked.includes(u))})));
   const trigger=document.createElement('button');trigger.type='button';trigger.id='c3LogoutTrigger';trigger.textContent='C3 logout';
   trigger.addEventListener('click',()=>logout(),{once:true});document.getElementById('siMBody').appendChild(trigger);
  },urls);
  const navs=[],onNav=f=>{if(f===page.mainFrame())navs.push(new URL(f.url()).pathname);};page.on('framenavigated',onNav);
  try{
   await Promise.all([page.waitForURL('**/login.html'),page.locator('#c3LogoutTrigger').click()]);
   // 等登录页的请求都落定，若它还要跳走（如 checkAuth 认为仍登录），跳转会在此之前发生并被 navs 记下。
   await page.waitForLoadState('networkidle');
   assert.deepStrictEqual(navs,['/login.html'],'logout must land on login.html and stay there');
   const after=await page.evaluate(()=>({proof:JSON.parse(localStorage.getItem('__hnLogoutProof')),token:localStorage.getItem('token'),user:localStorage.getItem('user')}));
   assert.deepStrictEqual(after,{proof:{count:0,revoked:true},token:null,user:null});
  }catch(e){e.message+=' | main-frame navigations after logout: '+JSON.stringify(navs);throw e;}
  finally{page.off('framenavigated',onNav);}
 });
 await check('C3 browser clean runtime',async()=>{
  assert.deepStrictEqual(pageErrors,[]);
  const errors=httpErrors.filter(([url])=>!url.endsWith('/favicon.ico'));
  assert.strictEqual(errors.length,2,JSON.stringify(errors));
  assert.deepStrictEqual(errors.slice().sort((a,b)=>a[0].localeCompare(b[0])),expectedHttpErrors.slice().sort((a,b)=>a[0].localeCompare(b[0])),'only the two deliberately intercepted URLs may fail');
 });
 console.log('C3 browser: '+passed+' groups passed; instance='+env.instance+'; artifacts='+artifacts);
}
async function main(){
 await testEnv.ready({readyTimeoutMs:180000});
 let failure=null;
 try{await runBrowser();}catch(e){failure=e;}
 try{if(browser)await browser.close();}catch(e){failure=failure||e;}
 try{if(db)await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));}catch(e){failure=failure||e;}
 try{await testEnv.teardown();}catch(e){failure=failure||e;}
 if(failure)throw failure;
 if(!process.env.C3_EVIDENCE_DIR&&artifacts){deleteTreeNoFollow(artifacts,[]);fs.rmdirSync(artifacts);}
 testEnv.finish(0);
}
main().catch(e=>{console.error(e.stack);if(artifacts)console.error('browser evidence retained: '+artifacts);process.exitCode=1;});
