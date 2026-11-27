'use strict';
const {expandInspectionForm}=require('./it-ledger-plan-b-test-helpers');
const assert=require('assert/strict'),fs=require('fs');
const {chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;const equal=(name,actual,expected)=>{assert.deepEqual(actual,expected,name);pass++;console.log('[OK] '+name);};
async function main(){
 const f=await createFixture({cleanup:true});let browser;
 const api=async(method,url,body,uid=2,status=200)=>{const r=await f.api(method,url,body,uid);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;};
 try{
  const racks=[];
  for(let i=1;i<=2;i++)racks.push(await api('POST','/racks',{room:'填写测试',name:'柜'+i,u_total:24},1,201));
  for(let i=1;i<=8;i++)await api('POST','',{category:'server',name:'设备'+i,u_height:1,placement:{kind:'rack',rack_id:racks[0].id,u_start:i}},1,201);
  let sheet=await api('POST','/inspections/sheets',{room_name:'填写测试'},2,201);
  const water=sheet.items.find(it=>it.item_key==='water');
  sheet=await api('PUT','/inspections/sheets/'+sheet.id,{expected_version:sheet.version,items:[{id:water.id,result:'bad',number_value:null,note:null}]});
  const detail=await api('GET','/inspections/sheets/'+sheet.id);
  equal('RF夹具缺失种类全等',detail.progress.missing,{unfilledItemIds:detail.items.filter(it=>it.id!==water.id).map(it=>it.id),missingNoteItemIds:[water.id],missingPhotoPositions:[{slot:'rack_front',target_id:racks[0].id},{slot:'rack_front',target_id:racks[1].id},{slot:'item',target_id:water.id}],deviceIssueItemIds:[]});
  browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(f.base+'/IT_Ledger.html#inspections');await page.locator('[data-insp-continue="'+sheet.id+'"]').click();await page.locator('#itlFormActionbar').waitFor();await expandInspectionForm(page);
  const expected=[...detail.progress.missing.unfilledItemIds.map(id=>'unfilled:'+id),...detail.progress.missing.missingNoteItemIds.map(id=>'note:'+id),...detail.progress.missing.missingPhotoPositions.map(p=>'photo:'+p.slot+':'+p.target_id),...detail.progress.missing.deviceIssueItemIds.map(id=>'device:'+id)];
  equal('RF缺失清单含全部照片阻塞',await page.locator('#itlFormMissing button').evaluateAll(nodes=>nodes.map(n=>n.dataset.missingKey)),expected);
  equal('RF三段与其余正常文案',await page.locator('[data-sheet-section] [data-all-normal]').allTextContents(),['本段其余全部正常','本段其余全部正常','本段其余全部正常']);
  // C0b：新单（v2）机房段只有「漏水与地面」「卫生与杂物」两个勾选项，没有温湿度输入框；温湿度的标签与单位改由文末的旧单（v1）块断言。
  equal('RF新单机房段无数字输入且两个勾选项标签',{numbers:await page.locator('[data-sheet-section="room"] input[type="number"]').count(),labels:await page.locator('[data-sheet-section="room"] .itl-sheet-room-item .itl-sheet-label').allTextContents()},{numbers:0,labels:['漏水与地面','卫生与杂物']});
  equal('RF机房两列',await page.locator('[data-sheet-section="room"] .itl-sheet-body').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),2);
  equal('RF设备单列人工登记',await page.locator('[data-sheet-section="device"] .itl-sheet-body').evaluate(el=>getComputedStyle(el).gridTemplateColumns.split(' ').length),1);
  equal('RF未采集状态逐台显示',await page.locator('[data-collection-state]').allTextContents(),Array(8).fill('现场观察登记 · 未采集'));
  equal('RF异常说明原位展开',await page.locator('[data-note-id="'+water.id+'"]').evaluate(el=>el.closest('.itl-sheet-room-item').querySelector('[data-item-id]').dataset.itemId),String(water.id));
  equal('RF机柜照片在对应行内',await page.locator('[data-photo-upload^="rack_front:"]').evaluateAll(nodes=>nodes.map(n=>({key:n.dataset.photoUpload,rack:Number(n.closest('tr').dataset.sheetRack)}))),racks.map(r=>({key:'rack_front:'+r.id,rack:r.id})));
  for(const key of expected){
    await page.locator('[data-missing-key="'+key+'"]').click();
    const [kind,part,last]=key.split(':');
    const expectedFocus=kind==='photo'?'photo:'+part+':'+last:kind==='note'?'note:'+part:detail.items.find(it=>it.id===Number(part)).value_kind==='number'?'num:'+part:'ok:'+part;
    const focus=await page.evaluate(()=>{const d=document.activeElement.dataset;return d.photoUpload?'photo:'+d.photoUpload:d.noteId?'note:'+d.noteId:d.numId?'num:'+d.numId:d.segOk?'ok:'+d.segOk:null;});
    equal('RF缺失项聚焦 '+key,focus,expectedFocus);
  }
  await page.locator('#itlFormRemark').scrollIntoViewIfNeeded();
  equal('RF左侧登记目录sticky计算样式',await page.locator('.itl-sheet-navigation').evaluate(el=>getComputedStyle(el).position),'sticky');
  const workflowGeometry=await page.locator('.itl-sheet-navigation').evaluate(el=>{const r=el.getBoundingClientRect(),main=document.querySelector('.itl-sheet-form-main').getBoundingClientRect(),footer=document.querySelector('#itlFormFooter').getBoundingClientRect();return {top:r.top,right:r.right,mainLeft:main.left,footerTop:footer.top,footerBottom:footer.bottom,height:innerHeight};});
  console.log('WORKFLOW_GEOMETRY='+JSON.stringify(workflowGeometry));
  equal('RF长表单滚动后左目录及底栏可见',workflowGeometry.top>=64&&workflowGeometry.right<=workflowGeometry.mainLeft&&workflowGeometry.footerBottom<=workflowGeometry.height&&workflowGeometry.footerTop>=0,true);
  equal('RF提交仍受权威完整性限制',await page.locator('#itlFormSubmit').isDisabled(),true);
  equal('RF删除草稿在底部操作栏',await page.locator('#itlFormFooter #itlFormDelete').count(),1);
  await page.evaluate(()=>{window.scrollTo(0,0);document.querySelector('#itlFormMissing').scrollTop=0;});
  fs.mkdirSync(require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign'),{recursive:true});await page.screenshot({path:require('path').resolve(__dirname,'../../_temp/plan-b-verification/redesign/form.png'),fullPage:true});
  equal('RF无浏览器异常',errors,[]);
  await context.close();
  // User 09-28: a device's abnormal note and photo follow that device, not the bottom of the section.
  const fresh=await api('GET','/inspections/sheets/'+sheet.id),dev=fresh.items.filter(it=>it.section==='device')[2];
  await api('PUT','/inspections/sheets/'+sheet.id,{expected_version:fresh.version,items:[{id:dev.id,result:'bad',number_value:null,note:null}]});
  const devContext=await browser.newContext({viewport:{width:1440,height:1000}});await devContext.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const dp=await devContext.newPage(),devErrors=[];dp.on('pageerror',e=>devErrors.push(e.message));
  await dp.goto(f.base+'/IT_Ledger.html#inspections');await dp.locator('[data-insp-continue="'+sheet.id+'"]').click();await dp.locator('#itlFormActionbar').waitFor();await expandInspectionForm(dp);
  equal('RF设备异常说明与照片紧跟该设备',await dp.locator('[data-device-item="'+dev.id+'"]').evaluate((el,id)=>{const row=el.firstElementChild,note=row.nextElementSibling;return {row:row.dataset.itemId,note:!!note&&note.classList.contains('itl-sheet-note')&&!!note.querySelector('[data-note-id="'+id+'"]'),photo:!!note&&!!note.querySelector('[data-photo-upload="item:'+id+'"]')};},dev.id),{row:String(dev.id),note:true,photo:true});
  equal('RF设备说明只出现在异常设备下',await dp.locator('[data-sheet-section="device"] .itl-sheet-note').count(),1);
  equal('RF设备段底部不再汇总说明',await dp.locator('[data-sheet-section="device"] .itl-sheet-notes').count(),0);
  equal('RF设备异常无浏览器异常',devErrors,[]);
  await devContext.close();
  // C0b：旧单（v1）兼容——温湿度两个输入框的顺序、标签与单位。新单没有这两项，所以另建一张草稿，用夹具直写库补插 v1 的温度、湿度两行
  // （label 照 v1 原文）并把主表模板版本改回 v1。变异驱动 number-unit 靠这里的「RF温湿度单位」判红。
  await api('POST','/racks',{room:'旧单填写',name:'旧柜1',u_total:24},1,201);
  const legacy=await api('POST','/inspections/sheets',{room_name:'旧单填写'},2,201);
  for(const [key,label] of [['temperature','温度（℃，参考 18–27）'],['humidity','湿度（%，参考 40–60）']])await f.run('INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind) VALUES(?,?,?,?,?,?,?)',[legacy.id,'room',0,'机房环境',key,label,'number']);
  await f.run("UPDATE it_inspection_sheets SET template_version='v1' WHERE id=?",[legacy.id]);
  const legacyContext=await browser.newContext({viewport:{width:1440,height:1000}});await legacyContext.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const lp=await legacyContext.newPage(),legacyErrors=[];lp.on('pageerror',e=>legacyErrors.push(e.message));
  await lp.goto(f.base+'/IT_Ledger.html#inspections');await lp.locator('[data-insp-continue="'+legacy.id+'"]').click();await lp.locator('#itlFormActionbar').waitFor();await expandInspectionForm(lp);
  equal('RF温湿度顺序及标签',await lp.locator('[data-sheet-section="room"] input[type="number"]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label'))),['温度（℃，参考 18–27）','湿度（%，参考 40–60）']);
  equal('RF温湿度单位',await lp.locator('[data-sheet-section="room"] input[type="number"]').evaluateAll(nodes=>nodes.map(n=>n.nextSibling.textContent)),['℃','%']);
  // C0b 修复批 1（LOW-2）：点缺失清单里旧单的温、湿度两个未填项，焦点必须落在对应数值输入框（专打前端 [data-num-id] 选择器的分支）。
  const legacyNums=await f.all("SELECT id,item_key FROM it_inspection_sheet_items WHERE sheet_id=? AND value_kind='number' ORDER BY id",[legacy.id]);
  for(const n of legacyNums){
   await lp.locator('[data-missing-key="unfilled:'+n.id+'"]').click();
   equal('RF旧单缺失项聚焦数值输入框 '+n.item_key,await lp.evaluate(()=>{const d=document.activeElement.dataset;return d.numId?'num:'+d.numId:d.segOk?'ok:'+d.segOk:null;}),'num:'+n.id);
  }
  equal('RF旧单无浏览器异常',legacyErrors,[]);
  await legacyContext.close();console.log('REDESIGN_FORM_BROWSER PASS='+pass+' FAIL=0');
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);console.log('REDESIGN_FORM_BROWSER PASS='+pass+' FAIL=1');process.exitCode=1;});
