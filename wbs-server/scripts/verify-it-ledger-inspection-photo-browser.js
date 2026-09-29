'use strict';
const { expandInspectionForm } = require('./it-ledger-plan-b-test-helpers');
const assert = require('assert/strict');
const { chromium } = require('playwright');
const { createFixture } = require('./it-ledger-browser-fixture');
const JPEG = Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0xff,0xd9]);
const JPEG2 = Buffer.concat([JPEG,Buffer.from('second-photo')]);
const JPEG3 = Buffer.concat([JPEG,Buffer.from('restricted-photo')]);
let pass=0;
function check(name,value,detail){if(!value&&detail!==undefined)console.error('DETAIL',name,JSON.stringify(detail));assert.ok(value,name);pass++;console.log('[OK] '+name);}
async function main(){
  const f=await createFixture();console.log('ISOLATED_ARTIFACTS='+f.dir);let browser;
  const createDraft=async(room,uid=2)=>{
    const rack=(await f.api('POST','/racks',{name:room+'-柜1',room,u_total:20})).body;
    await f.api('POST','',{category:'server',name:room+'-设备1',u_height:1,placement:{kind:'rack',rack_id:rack.id,u_start:1}});
    const created=await f.api('POST','/inspections/sheets',{room_name:room},uid);
    assert.equal(created.status,201,JSON.stringify(created.body));return {sheet:created.body,rack};
  };
  const getSheet=(id,uid=2)=>f.api('GET','/inspections/sheets/'+id,undefined,uid);
  const uploadApi=async(id,slot,targetId,bytes=JPEG,uid=2)=>{
    const body=new FormData();body.append('slot',slot);body.append('target_id',String(targetId));body.append('file',new Blob([bytes],{type:'image/jpeg'}),'photo.jpg');
    const response=await fetch(f.base+'/api/it-assets/inspections/sheets/'+id+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-'+uid},body});
    return {status:response.status,body:await response.json()};
  };
  const createSubmitted=async room=>{
    const draft=await createDraft(room),detail=(await getSheet(draft.sheet.id)).body;
    const items=detail.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
    const saved=await f.api('PUT','/inspections/sheets/'+draft.sheet.id,{expected_version:detail.version,items},2);assert.equal(saved.status,200);
    assert.equal((await uploadApi(draft.sheet.id,'rack_front',draft.rack.id,JPEG)).status,201);
    const submitted=await f.api('POST','/inspections/sheets/'+draft.sheet.id+'/submit',{expected_version:saved.body.version},2);assert.equal(submitted.status,200);
    return draft;
  };
  const openPage=async uid=>{const ctx=await browser.newContext();await ctx.addInitScript(id=>localStorage.setItem('token','fixture-'+id),uid);const page=await ctx.newPage();await page.goto(f.base+'/IT_Ledger.html#inspections');return {ctx,page};};
  const waitCount=(page,map,key,before)=>page.waitForFunction(({map,key,before})=>(window.ITLedger[map].get(key)||0)>=before+1,{map,key,before},{timeout:5000});
  const holdOperation=async(page,pattern,method,finish)=>{
    let enteredResolve,releaseResolve,settledResolve,settledReject,count=0;
    const entered=new Promise(resolve=>enteredResolve=resolve),gate=new Promise(resolve=>releaseResolve=resolve),settled=new Promise((resolve,reject)=>{settledResolve=resolve;settledReject=reject;});
    await page.route(pattern,async route=>{if(route.request().method()!==method)return route.fallback();count++;enteredResolve();try{await gate;await finish(route);settledResolve();}catch(error){settledReject(error);throw error;}});
    return {entered,settled,count:()=>count,release:()=>releaseResolve()};
  };
  const reachedWithin=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' 未在5秒内到达')),5000);})]);}finally{clearTimeout(timer);}};
  const finishHeld=async held=>{if(!held)return;let timer;held.release();try{await Promise.race([held.settled.catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);}finally{clearTimeout(timer);}};
  try{
    browser=await chromium.launch({headless:true});
    const draft=await createDraft('PhotoDraft');
    const aircon=draft.sheet.items.find(it=>it.item_key==='aircon');
    const {ctx,page}=await openPage(2);
    try{
      await page.locator('[data-insp-continue="'+draft.sheet.id+'"]').click();await page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(page);
      const rackDetails=page.locator('[data-rack-photo="'+draft.rack.id+'"]');
      check('P1:每柜正面照在机柜行内可见且显示还缺1张',await rackDetails.count()===1&&(await rackDetails.evaluate(el=>el.closest('tr')?.dataset.sheetRack))===String(draft.rack.id)&&(await rackDetails.locator('[data-rack-photo-status]').innerText()).includes('还缺至少 1 张'));
      const missingColor=await rackDetails.locator('[data-rack-photo-status]').evaluate(el=>{const sample=document.createElement('span');sample.style.color='var(--sem-hold-fg)';document.body.append(sample);const expected=getComputedStyle(sample).color;sample.remove();return {actual:getComputedStyle(el).color,expected};});
      check('P1:缺照片提示的计算颜色为橙色语义色',missingColor.actual===missingColor.expected,missingColor);
      await rackDetails.locator('[data-rack-photo-status]').waitFor({state:'visible'});
      let before=await page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,draft.sheet.id+':rack_front:'+draft.rack.id);
      await page.locator('[data-photo-upload="rack_front:'+draft.rack.id+'"]').setInputFiles({name:'rack.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await waitCount(page,'__inspPhotoUploadSettledByPosition',draft.sheet.id+':rack_front:'+draft.rack.id,before);
      let server=(await getSheet(draft.sheet.id)).body;
      check('P2:草稿上传后服务端正面照active且进度加一',server.photos.length===1&&server.photos[0].state==='active'&&server.progress.photosUploaded===1,server.progress);
      const firstId=server.photos[0].id;
      await page.locator('[data-photo-thumb-id="'+firstId+'"][data-photo-thumb-status="loaded"]').waitFor({timeout:5000});
      check('P2:缩略图按照片id完成鉴权加载',await page.locator('[data-photo-thumb-id="'+firstId+'"] img').count()===0&&await page.locator('[data-photo-thumb-id="'+firstId+'"]').evaluate(el=>!!el.src));
      await page.locator('[data-photo-id="'+firstId+'"] [data-photo-view]').click();
      check('P2:照片可放大并由Escape关闭',await page.getByRole('dialog',{name:'rack.jpg'}).isVisible());
      await page.keyboard.press('Escape');check('P2:放大层已关闭',await page.getByRole('dialog',{name:'rack.jpg'}).count()===0);
      before=await page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,draft.sheet.id+':rack_front:'+draft.rack.id);
      await page.locator('[data-photo-upload="rack_front:'+draft.rack.id+'"]').setInputFiles({name:'rack-new.jpg',mimeType:'image/jpeg',buffer:JPEG2});
      await waitCount(page,'__inspPhotoUploadSettledByPosition',draft.sheet.id+':rack_front:'+draft.rack.id,before);
      server=(await getSheet(draft.sheet.id)).body;
      check('P3:追加后保留原图和新增active照片',server.photos.length===2&&server.photos.some(p=>p.id===firstId),server.photos);
      const secondId=server.photos.find(p=>p.id!==firstId).id;
      before=await page.evaluate(id=>window.ITLedger.__inspPhotoDeleteSettledByPosition.get(id)||0,draft.sheet.id+':rack_front:'+draft.rack.id);
      await page.locator('[data-photo-delete="'+secondId+'"]').click();
      await waitCount(page,'__inspPhotoDeleteSettledByPosition',draft.sheet.id+':rack_front:'+draft.rack.id,before);
      server=(await getSheet(draft.sheet.id)).body;
      check('P4:草稿逐张删除不影响同位置剩余照片',server.photos.length===1&&server.photos[0].id===firstId&&server.progress.photosUploaded===1,server.progress);
      await page.locator('[data-seg-bad="'+aircon.id+'"]').click();await page.locator('[data-note-id="'+aircon.id+'"]').fill('现场异常');
      const itemInput=page.locator('[data-photo-upload="item:'+aircon.id+'"]');check('P5:标异常后说明下出现照片位',await itemInput.count()===1);
      before=await page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,draft.sheet.id+':item:'+aircon.id);
      await itemInput.setInputFiles({name:'bad.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await waitCount(page,'__inspPhotoUploadSettledByPosition',draft.sheet.id+':item:'+aircon.id,before);
      server=(await getSheet(draft.sheet.id)).body;
      check('P5:异常照片active且服务端应传数增加',server.photos.some(p=>p.slot==='item'&&p.target_id===aircon.id)&&server.progress.photosExpected===2,server.progress);
      const beforeNormal=await page.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
      await page.locator('[data-seg-ok="'+aircon.id+'"]').click();
      check('P5:改回正常后异常照片位隐藏',await page.locator('[data-photo-upload="item:'+aircon.id+'"]').count()===0);
      await page.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,beforeNormal,{timeout:5000});
      const normalFromServer=(await getSheet(draft.sheet.id)).body;
      check('P5:改回正常后照片是否仍active以服务端响应为准',normalFromServer.photos.some(p=>p.slot==='item'&&p.target_id===aircon.id)&&normalFromServer.progress.photosExpected===1,normalFromServer.progress);
      let invalidPosts=0;page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+draft.sheet.id+'/photos')&&r.method()==='POST')invalidPosts++;});
      await page.locator('[data-photo-upload="rack_front:'+draft.rack.id+'"]').setInputFiles({name:'wrong.txt',mimeType:'text/plain',buffer:Buffer.from('x')});
      check('P8:非图片扩展名被前端拒绝且零POST',invalidPosts===0&&(await page.locator('[data-photo-message="rack_front:'+draft.rack.id+'"]').innerText()).includes('只收 JPG'));
      await page.locator('[data-photo-upload="rack_front:'+draft.rack.id+'"]').setInputFiles({name:'large.jpg',mimeType:'image/jpeg',buffer:Buffer.alloc(20*1024*1024+1)});
      check('P8:超过20MiB的文件被前端拒绝且零POST',invalidPosts===0&&(await page.locator('[data-photo-message="rack_front:'+draft.rack.id+'"]').innerText()).includes('20 MiB'));
      const evilName='evil\"><img src=x onerror=window.__photoXss=1>.jpg';
      const beforeXss=await page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,draft.sheet.id+':rack_front:'+draft.rack.id);
      await page.locator('[data-photo-upload="rack_front:'+draft.rack.id+'"]').setInputFiles({name:evilName,mimeType:'image/jpeg',buffer:JPEG2});
      await waitCount(page,'__inspPhotoUploadSettledByPosition',draft.sheet.id+':rack_front:'+draft.rack.id,beforeXss);
      const xssPhoto=(await getSheet(draft.sheet.id)).body.photos.find(p=>p.slot==='rack_front'&&p.original_name.includes('<img'));
      const photoText=await page.locator('[data-photo-id="'+xssPhoto.id+'"]').innerText(),xssRan=await page.evaluate(()=>window.__photoXss);
      check('P9:照片文件名的HTML载荷只作为文字和属性值渲染',xssPhoto.original_name.includes('<img')&&photoText.includes(xssPhoto.original_name)&&xssRan===undefined,{stored:xssPhoto.original_name,photoText,xssRan});
    }finally{await ctx.close();}

    const dupFull=await createDraft('PhotoDupFull');
    const fullPage=await openPage(2);
    try{
      await fullPage.page.locator('[data-insp-continue="'+dupFull.sheet.id+'"]').click();await fullPage.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(fullPage.page);
      await fullPage.page.locator('[data-rack-photo="'+dupFull.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const before=await fullPage.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,dupFull.sheet.id+':rack_front:'+dupFull.rack.id);
      await fullPage.page.locator('[data-photo-upload="rack_front:'+dupFull.rack.id+'"]').setInputFiles({name:'dup.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await waitCount(fullPage.page,'__inspPhotoUploadSettledByPosition',dupFull.sheet.id+':rack_front:'+dupFull.rack.id,before);
      await fullPage.page.locator('#itlPhotoMessage').waitFor({timeout:5000});
      const fullWarning=await fullPage.page.locator('#itlPhotoMessage').innerText();
      check('P6:可见历史照片重复只提示且带单号与照片状态',fullWarning.includes('#'+draft.sheet.id)&&fullWarning.includes('有效')&&(await getSheet(dupFull.sheet.id)).body.photos.length===1,fullWarning);
    }finally{await fullPage.ctx.close();}
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    const foreign=await createDraft('PhotoDupPrivate',5);
    assert.equal((await uploadApi(foreign.sheet.id,'rack_front',foreign.rack.id,JPEG3,5)).status,201);
    const dupRestricted=await createDraft('PhotoDupRestricted');
    const restrictedPage=await openPage(2);
    try{
      await restrictedPage.page.locator('[data-insp-continue="'+dupRestricted.sheet.id+'"]').click();await restrictedPage.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(restrictedPage.page);
      await restrictedPage.page.locator('[data-rack-photo="'+dupRestricted.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const before=await restrictedPage.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,dupRestricted.sheet.id+':rack_front:'+dupRestricted.rack.id);
      await restrictedPage.page.locator('[data-photo-upload="rack_front:'+dupRestricted.rack.id+'"]').setInputFiles({name:'restricted.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(restrictedPage.page,'__inspPhotoUploadSettledByPosition',dupRestricted.sheet.id+':rack_front:'+dupRestricted.rack.id,before);
      await restrictedPage.page.locator('#itlPhotoMessage').waitFor({timeout:5000});
      const warning=await restrictedPage.page.locator('#itlPhotoMessage').innerText();
      check('P7:不可见历史重复只提示、不泄露对方单号',warning.includes('与一张你无权查看的巡检单中的照片相同')&&!warning.includes('#'+foreign.sheet.id),warning);
    }finally{await restrictedPage.ctx.close();}

    const submitted=await createDraft('PhotoSubmitted');
    const beforeSubmit=await getSheet(submitted.sheet.id);
    const items=beforeSubmit.body.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
    const put=await f.api('PUT','/inspections/sheets/'+submitted.sheet.id,{expected_version:beforeSubmit.body.version,items},2);assert.equal(put.status,200,JSON.stringify(put.body));
    assert.equal((await uploadApi(submitted.sheet.id,'rack_front',submitted.rack.id,JPEG)).status,201);
    const submit=await f.api('POST','/inspections/sheets/'+submitted.sheet.id+'/submit',{expected_version:put.body.version},2);assert.equal(submit.status,200,JSON.stringify(submit.body));
    const owner=await openPage(2);
    try{
      await owner.page.locator('[data-insp-row="'+submitted.sheet.id+'"]').waitFor({timeout:5000});
      check('E1:已提交列表行有编辑与逻辑删除入口',await owner.page.locator('[data-insp-edit="'+submitted.sheet.id+'"]').count()===1&&await owner.page.locator('[data-insp-delete-submitted="'+submitted.sheet.id+'"]').count()===1);
      await owner.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await owner.page.locator('#itlSheetEdit').waitFor({timeout:5000});
      check('E1:已提交单按actions提供编辑入口',await owner.page.locator('#itlSheetEdit').count()===1);
      await owner.page.locator('#itlSheetEdit').click();await owner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(owner.page);await owner.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(owner.page);
      check('E1:编辑态无提交巡检按钮且有保存修改和放弃修改',await owner.page.locator('#itlFormSubmit').count()===0&&await owner.page.locator('#itlEditDiscard').count()===1);
      await owner.page.locator('[data-rack-photo="'+submitted.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      let before=await owner.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,submitted.sheet.id+':rack_front:'+submitted.rack.id);
      await owner.page.locator('[data-photo-upload="rack_front:'+submitted.rack.id+'"]').setInputFiles({name:'pending.jpg',mimeType:'image/jpeg',buffer:JPEG2});
      await waitCount(owner.page,'__inspPhotoUploadSettledByPosition',submitted.sheet.id+':rack_front:'+submitted.rack.id,before);
      let server=(await getSheet(submitted.sheet.id)).body;
      check('E2:已提交编辑上传为待保存且active不变',server.my_pending_photos.length===1&&server.photos[0].id!==server.my_pending_photos[0].id,server);
      check('E2:编辑页显示待保存标记', (await owner.page.locator('[data-photo-id="'+server.my_pending_photos[0].id+'"]').innerText()).includes('待保存'));
      await owner.page.locator('#itlFormBack').click();await owner.page.locator('[data-insp-row="'+submitted.sheet.id+'"]').waitFor({timeout:5000});
      check('E2:只上传pending照片离开不进入未保存登记表',await owner.page.locator('#itlUnsavedList [data-unsaved-sheet="'+submitted.sheet.id+'"]').count()===0);
      await owner.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await owner.page.locator('#itlSheetEdit').click();await owner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(owner.page);
      await owner.page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(owner.page);
      check('E3:重进编辑提示残留pending数量和两个选项',(await owner.page.locator('#itlPendingDecision').innerText()).includes('1 项照片变更')&&await owner.page.locator('[data-pending-decision]').count()===2);
      await expandInspectionForm(owner.page);
      await owner.page.locator('[data-pending-decision="keep"]').click();check('E3:继续使用后pending仍在', (await getSheet(submitted.sheet.id)).body.my_pending_photos.length===1);
      await owner.page.locator('#itlFormRemark').fill('编辑后备注');
      before=await owner.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,submitted.sheet.id);
      await owner.page.locator('#itlEditSave').click();await waitCount(owner.page,'__inspEditSaveSettledBySheet',submitted.sheet.id,before);
      server=(await getSheet(submitted.sheet.id)).body;
      check('E4:保存修改激活pending、清空待生效并写edit日志',server.my_pending_photos.length===0&&server.photos.some(p=>p.original_name==='pending.jpg')&&server.log.some(l=>l.action==='edit'&&l.diff.some(d=>d.kind==='photo')),server);
      await owner.page.locator('.itl-sheet-log').waitFor({state:'visible'});
      check('E4:追加照片日志不误记为替换旧照', (await owner.page.locator('.itl-sheet-log').innerText()).includes('新照片')&&server.photos.length===2);
      const activeAfterSave=server.photos[0].id;
      await owner.page.locator('#itlSheetEdit').click();await owner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(owner.page);await owner.page.locator('#itlEditDiscard').waitFor({timeout:5000});await expandInspectionForm(owner.page);
      await owner.page.locator('[data-rack-photo="'+submitted.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,submitted.sheet.id+':rack_front:'+submitted.rack.id);
      await owner.page.locator('[data-photo-upload="rack_front:'+submitted.rack.id+'"]').setInputFiles({name:'discard.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(owner.page,'__inspPhotoUploadSettledByPosition',submitted.sheet.id+':rack_front:'+submitted.rack.id,before);
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,submitted.sheet.id);
      await owner.page.locator('#itlEditDiscard').click();await waitCount(owner.page,'__inspPendingDiscardSettledBySheet',submitted.sheet.id,before);
      server=(await getSheet(submitted.sheet.id)).body;
      check('E6:放弃修改清pending并保留原active',server.my_pending_photos.length===0&&server.photos[0].id===activeAfterSave,server);
      check('E6:放弃后返回详情',await owner.page.locator('#itlSheetEdit').count()===1);
      await owner.page.locator('#itlSheetEdit').click();await owner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(owner.page);await owner.page.locator('#itlEditDiscard').waitFor({timeout:5000});await expandInspectionForm(owner.page);
      await owner.page.locator('[data-rack-photo="'+submitted.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,submitted.sheet.id+':rack_front:'+submitted.rack.id);
      await owner.page.locator('[data-photo-upload="rack_front:'+submitted.rack.id+'"]').setInputFiles({name:'later.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(owner.page,'__inspPhotoUploadSettledByPosition',submitted.sheet.id+':rack_front:'+submitted.rack.id,before);
      await owner.page.locator('#itlFormBack').click();await owner.page.locator('[data-insp-row="'+submitted.sheet.id+'"]').waitFor({timeout:5000});
      await owner.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await owner.page.locator('#itlSheetEdit').click();await owner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(owner.page);
      await owner.page.locator('[data-pending-decision="discard"]').waitFor({timeout:5000});
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,submitted.sheet.id);
      await owner.page.locator('[data-pending-decision="discard"]').click();await waitCount(owner.page,'__inspPendingDiscardSettledBySheet',submitted.sheet.id,before);
      check('E7:残留照片选丢弃后仍在编辑态且pending已清',await owner.page.locator('#itlEditSave').count()===1&&(await getSheet(submitted.sheet.id)).body.my_pending_photos.length===0);
      await owner.page.locator('[data-rack-photo="'+submitted.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,submitted.sheet.id+':rack_front:'+submitted.rack.id);
      await owner.page.locator('[data-photo-upload="rack_front:'+submitted.rack.id+'"]').setInputFiles({name:'delete-pending.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(owner.page,'__inspPhotoUploadSettledByPosition',submitted.sheet.id+':rack_front:'+submitted.rack.id,before);
      const pendingId=(await getSheet(submitted.sheet.id)).body.my_pending_photos[0].id;
      before=await owner.page.evaluate(id=>window.ITLedger.__inspPhotoDeleteSettledByPosition.get(id)||0,submitted.sheet.id+':rack_front:'+submitted.rack.id);
      await owner.page.locator('[data-photo-delete="'+pendingId+'"]').click();await waitCount(owner.page,'__inspPhotoDeleteSettledByPosition',submitted.sheet.id+':rack_front:'+submitted.rack.id,before);
      check('E7:编辑态单张待保存照片可删除且active不变',(await getSheet(submitted.sheet.id)).body.my_pending_photos.length===0&&(await getSheet(submitted.sheet.id)).body.photos[0].id===activeAfterSave);
    }finally{await owner.ctx.close();}
    const pendingReadFail=await createSubmitted('PhotoPendingReadFail');
    const pendingPage=await openPage(2);
    try{
      await pendingPage.page.locator('[data-insp-view="'+pendingReadFail.sheet.id+'"]').click();await pendingPage.page.locator('#itlSheetEdit').click();await pendingPage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(pendingPage.page);await pendingPage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(pendingPage.page);
      await pendingPage.page.locator('[data-rack-photo="'+pendingReadFail.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      await pendingPage.page.route('**/api/it-assets/inspections/sheets/'+pendingReadFail.sheet.id,route=>route.request().method()==='GET'?route.abort('failed'):route.fallback());
      const pos=pendingReadFail.sheet.id+':rack_front:'+pendingReadFail.rack.id;
      const before=await pendingPage.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await pendingPage.page.locator('[data-photo-upload="rack_front:'+pendingReadFail.rack.id+'"]').setInputFiles({name:'server-pending.jpg',mimeType:'image/jpeg',buffer:JPEG2});
      await waitCount(pendingPage.page,'__inspPhotoUploadSettledByPosition',pos,before);
      check('E2b:上传已成功而重取失败时明确提示界面未更新',(await pendingPage.page.locator('[data-photo-message="rack_front:'+pendingReadFail.rack.id+'"]').innerText()).includes('照片已上传，但界面未能更新'));
      check('E2b:服务端pending确已存在',(await getSheet(pendingReadFail.sheet.id)).body.my_pending_photos.length===1);
      await pendingPage.page.unroute('**/api/it-assets/inspections/sheets/'+pendingReadFail.sheet.id);
      await pendingPage.page.locator('#itlFormBack').click();await pendingPage.page.locator('[data-insp-row="'+pendingReadFail.sheet.id+'"]').waitFor({timeout:5000});
      check('E2b:已上传的pending不进未保存登记表',await pendingPage.page.locator('#itlUnsavedList [data-unsaved-sheet="'+pendingReadFail.sheet.id+'"]').count()===0);
      await pendingPage.page.locator('[data-insp-view="'+pendingReadFail.sheet.id+'"]').click();await pendingPage.page.locator('#itlSheetEdit').click();await pendingPage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(pendingPage.page);
      await pendingPage.page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(pendingPage.page);
      check('E2b:重进仍提示继续使用或丢弃',await pendingPage.page.locator('#itlPendingDecision [data-pending-decision]').count()===2);
    }finally{await pendingPage.ctx.close();}
    const pendingLate=await createSubmitted('PhotoPendingLate');
    const pendingLatePage=await openPage(2);let heldPendingLate;
    try{
      await pendingLatePage.page.locator('[data-insp-view="'+pendingLate.sheet.id+'"]').click();await pendingLatePage.page.locator('#itlSheetEdit').click();await pendingLatePage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(pendingLatePage.page);await pendingLatePage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(pendingLatePage.page);
      await pendingLatePage.page.locator('[data-rack-photo="'+pendingLate.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      heldPendingLate=await holdOperation(pendingLatePage.page,'**/api/it-assets/inspections/sheets/'+pendingLate.sheet.id,'GET',route=>route.abort('failed'));
      const pos=pendingLate.sheet.id+':rack_front:'+pendingLate.rack.id;
      const before=await pendingLatePage.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await pendingLatePage.page.locator('[data-photo-upload="rack_front:'+pendingLate.rack.id+'"]').setInputFiles({name:'late-pending.jpg',mimeType:'image/jpeg',buffer:JPEG2});
      await reachedWithin(heldPendingLate.entered,'pending photo refresh');
      await pendingLatePage.page.locator('#itlFormBack').click();await pendingLatePage.page.locator('[data-insp-row="'+pendingLate.sheet.id+'"]').waitFor({timeout:5000});
      heldPendingLate.release();await reachedWithin(heldPendingLate.settled,'pending photo refresh failure');
      await waitCount(pendingLatePage.page,'__inspPhotoUploadSettledByPosition',pos,before);
      check('E2c:上传pending成功后离开且重取失败仍不进未保存登记表',await pendingLatePage.page.locator('#itlUnsavedList [data-unsaved-sheet="'+pendingLate.sheet.id+'"]').count()===0&&(await getSheet(pendingLate.sheet.id)).body.my_pending_photos.length===1);
    }finally{await finishHeld(heldPendingLate);await pendingLatePage.ctx.close();}
    const read=await openPage(3);
    try{await read.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await read.page.locator('.itl-sheet-title h2').waitFor({timeout:5000});check('E5:只读账号无编辑入口',await read.page.locator('#itlSheetEdit').count()===0);}finally{await read.ctx.close();}
    const nonOwner=await openPage(5);
    try{await nonOwner.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await nonOwner.page.locator('.itl-sheet-title h2').waitFor({timeout:5000});check('E5:有写权限但不是巡检人也无编辑入口',await nonOwner.page.locator('#itlSheetEdit').count()===0);}finally{await nonOwner.ctx.close();}
    const invalid=await createDraft('PhotoInvalidated');
    const initialInvalid=(await getSheet(invalid.sheet.id)).body;
    const bad=initialInvalid.items.find(it=>it.item_key==='aircon');
    const invalidItems=initialInvalid.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:it.id===bad.id?'bad':'ok',number_value:null,note:it.id===bad.id?'异常照片待核对':null});
    const invalidPut=await f.api('PUT','/inspections/sheets/'+invalid.sheet.id,{expected_version:initialInvalid.version,items:invalidItems},2);assert.equal(invalidPut.status,200);
    assert.equal((await uploadApi(invalid.sheet.id,'rack_front',invalid.rack.id,JPEG2)).status,201);
    const oldItemPhoto=await uploadApi(invalid.sheet.id,'item',bad.id,JPEG3);assert.equal(oldItemPhoto.status,201);
    const invalidSubmit=await f.api('POST','/inspections/sheets/'+invalid.sheet.id+'/submit',{expected_version:invalidPut.body.version},2);assert.equal(invalidSubmit.status,200,JSON.stringify(invalidSubmit.body));
    const invalidPage=await openPage(2);
    try{
      await invalidPage.page.locator('[data-insp-view="'+invalid.sheet.id+'"]').click();await invalidPage.page.locator('#itlSheetEdit').click();await invalidPage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(invalidPage.page);await invalidPage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(invalidPage.page);
      await invalidPage.page.locator('[data-seg-ok="'+bad.id+'"]').click();
      const before=await invalidPage.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,invalid.sheet.id);
      await invalidPage.page.locator('#itlEditSave').click();await waitCount(invalidPage.page,'__inspEditSaveSettledBySheet',invalid.sheet.id,before);
      const after=(await getSheet(invalid.sheet.id)).body;
      const invalidated=after.log.find(l=>l.action==='edit'&&l.diff.some(d=>d.kind==='photo_invalidated'));
      check('E8:异常改正常后旧照片失效且diff记photo_invalidated',!after.photos.some(p=>p.slot==='item'&&p.target_id===bad.id)&&!!invalidated,after.log);
      await invalidPage.page.locator('.itl-sheet-log').waitFor({state:'visible'});
      check('E8:旧照片仍可从操作记录鉴权查看',await invalidPage.page.locator('[data-log-photo-view="'+oldItemPhoto.body.photo.id+'"]').count()===1);
      await invalidPage.page.locator('[data-log-photo-view="'+oldItemPhoto.body.photo.id+'"]').click();
      await invalidPage.page.getByRole('dialog').waitFor({timeout:5000});
      check('E8:历史照片放大层打开',await invalidPage.page.getByRole('dialog').isVisible());
    }finally{await invalidPage.ctx.close();}
    const pendingNormal=await createSubmitted('PhotoPendingNormal');
    const normalItem=pendingNormal.sheet.items.find(it=>it.item_key==='aircon');
    const normalPage=await openPage(2);
    try{
      await normalPage.page.locator('[data-insp-view="'+pendingNormal.sheet.id+'"]').click();await normalPage.page.locator('#itlSheetEdit').click();await normalPage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(normalPage.page);await normalPage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(normalPage.page);
      await normalPage.page.locator('[data-seg-bad="'+normalItem.id+'"]').click();
      const beforeUpload=await normalPage.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pendingNormal.sheet.id+':item:'+normalItem.id);
      await normalPage.page.locator('[data-photo-upload="item:'+normalItem.id+'"]').setInputFiles({name:'normal-pending.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(normalPage.page,'__inspPhotoUploadSettledByPosition',pendingNormal.sheet.id+':item:'+normalItem.id,beforeUpload);
      check('E8b:已提交编辑的异常项照片先成为pending',(await getSheet(pendingNormal.sheet.id)).body.my_pending_photos.some(p=>p.slot==='item'&&p.target_id===normalItem.id));
      await normalPage.page.locator('[data-seg-ok="'+normalItem.id+'"]').click();
      const beforeSave=await normalPage.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,pendingNormal.sheet.id);
      await normalPage.page.locator('#itlEditSave').click();await waitCount(normalPage.page,'__inspEditSaveSettledBySheet',pendingNormal.sheet.id,beforeSave);
      const after=(await getSheet(pendingNormal.sheet.id)).body;
      check('E8b:保存时结果正常则pending异常照由服务端丢弃',after.my_pending_photos.length===0&&!after.photos.some(p=>p.slot==='item'&&p.target_id===normalItem.id),after);
    }finally{await normalPage.ctx.close();}
    const concurrent=await createDraft('PhotoConcurrent');
    const concurrentInitial=(await getSheet(concurrent.sheet.id)).body;
    const concurrentItems=concurrentInitial.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
    const concurrentPut=await f.api('PUT','/inspections/sheets/'+concurrent.sheet.id,{expected_version:concurrentInitial.version,items:concurrentItems},2);assert.equal(concurrentPut.status,200);
    assert.equal((await uploadApi(concurrent.sheet.id,'rack_front',concurrent.rack.id,JPEG)).status,201);
    assert.equal((await f.api('POST','/inspections/sheets/'+concurrent.sheet.id+'/submit',{expected_version:concurrentPut.body.version},2)).status,200);
    const ownerConcurrent=await openPage(2),adminConcurrent=await openPage(1);
    try{
      await ownerConcurrent.page.locator('[data-insp-view="'+concurrent.sheet.id+'"]').click();await ownerConcurrent.page.locator('#itlSheetEdit').click();await ownerConcurrent.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(ownerConcurrent.page);await ownerConcurrent.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(ownerConcurrent.page);
      await adminConcurrent.page.locator('[data-insp-view="'+concurrent.sheet.id+'"]').click();await adminConcurrent.page.locator('#itlSheetEdit').click();await adminConcurrent.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(adminConcurrent.page);await adminConcurrent.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(adminConcurrent.page);
      await ownerConcurrent.page.locator('#itlFormRemark').fill('本地并发修改');
      await ownerConcurrent.page.locator('[data-rack-photo="'+concurrent.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      let before=await ownerConcurrent.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,concurrent.sheet.id+':rack_front:'+concurrent.rack.id);
      await ownerConcurrent.page.locator('[data-photo-upload="rack_front:'+concurrent.rack.id+'"]').setInputFiles({name:'owner-pending.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(ownerConcurrent.page,'__inspPhotoUploadSettledByPosition',concurrent.sheet.id+':rack_front:'+concurrent.rack.id,before);
      await adminConcurrent.page.locator('#itlFormRemark').fill('管理员先保存');
      before=await adminConcurrent.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,concurrent.sheet.id);
      await adminConcurrent.page.locator('#itlEditSave').click();await waitCount(adminConcurrent.page,'__inspEditSaveSettledBySheet',concurrent.sheet.id,before);
      before=await ownerConcurrent.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,concurrent.sheet.id);
      await ownerConcurrent.page.locator('#itlEditSave').click();await waitCount(ownerConcurrent.page,'__inspEditSaveSettledBySheet',concurrent.sheet.id,before);
      const conflictText=await ownerConcurrent.page.locator('#itlNotice').innerText();
      const outline=await ownerConcurrent.page.locator('.itl-sheet-remark-edit').evaluate(el=>getComputedStyle(el).outlineStyle);
      check('E10:两人并发后存者409且本地备注保留高亮',conflictText.includes('已在别处被修改')&&(await ownerConcurrent.page.locator('#itlFormRemark').inputValue())==='本地并发修改'&&outline!=='none',{conflictText,outline});
      check('E10:409后自己的pending仍在服务端',(await getSheet(concurrent.sheet.id)).body.my_pending_photos.length===1);
      before=await ownerConcurrent.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,concurrent.sheet.id);
      await ownerConcurrent.page.locator('#itlEditSave').click();await waitCount(ownerConcurrent.page,'__inspEditSaveSettledBySheet',concurrent.sheet.id,before);
      const resolved=(await getSheet(concurrent.sheet.id)).body;
      check('E10:核对后重试保存本地备注并激活自己的pending',resolved.remark==='本地并发修改'&&resolved.my_pending_photos.length===0&&resolved.photos.some(p=>p.original_name==='owner-pending.jpg'),resolved);
    }finally{await ownerConcurrent.ctx.close();await adminConcurrent.ctx.close();}
    const photoRace=await createSubmitted('PhotoRefreshConflict');
    const photoRaceOwner=await openPage(2),photoRaceAdmin=await openPage(1);
    try{
      await photoRaceOwner.page.locator('[data-insp-view="'+photoRace.sheet.id+'"]').click();await photoRaceOwner.page.locator('#itlSheetEdit').click();await photoRaceOwner.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(photoRaceOwner.page);await photoRaceOwner.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(photoRaceOwner.page);
      await photoRaceAdmin.page.locator('[data-insp-view="'+photoRace.sheet.id+'"]').click();await photoRaceAdmin.page.locator('#itlSheetEdit').click();await photoRaceAdmin.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(photoRaceAdmin.page);await photoRaceAdmin.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(photoRaceAdmin.page);
      await photoRaceOwner.page.locator('#itlFormRemark').fill('照片上传前的本地备注');
      await photoRaceAdmin.page.locator('#itlFormRemark').fill('对方先保存的备注');
      let before=await photoRaceAdmin.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,photoRace.sheet.id);
      await photoRaceAdmin.page.locator('#itlEditSave').click();await waitCount(photoRaceAdmin.page,'__inspEditSaveSettledBySheet',photoRace.sheet.id,before);
      await photoRaceOwner.page.locator('[data-rack-photo="'+photoRace.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      before=await photoRaceOwner.page.evaluate(id=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(id)||0,photoRace.sheet.id+':rack_front:'+photoRace.rack.id);
      await photoRaceOwner.page.locator('[data-photo-upload="rack_front:'+photoRace.rack.id+'"]').setInputFiles({name:'race-pending.jpg',mimeType:'image/jpeg',buffer:JPEG3});
      await waitCount(photoRaceOwner.page,'__inspPhotoUploadSettledByPosition',photoRace.sheet.id+':rack_front:'+photoRace.rack.id,before);
      const outline=await photoRaceOwner.page.locator('.itl-sheet-remark-edit').evaluate(el=>getComputedStyle(el).outlineStyle);
      const server=(await getSheet(photoRace.sheet.id)).body;
      check('E10b:照片上传后的刷新识别并高亮对方同字段修改',outline!=='none'&&(await photoRaceOwner.page.locator('#itlFormRemark').inputValue())==='照片上传前的本地备注'&&server.remark==='对方先保存的备注'&&server.my_pending_photos.length===1,{outline,serverRemark:server.remark});
    }finally{await photoRaceOwner.ctx.close();await photoRaceAdmin.ctx.close();}
    const incomplete=await createSubmitted('PhotoIncomplete');
    const missingItem=incomplete.sheet.items.find(it=>it.item_key==='aircon');
    const incompletePage=await openPage(2);
    try{
      await incompletePage.page.locator('[data-insp-view="'+incomplete.sheet.id+'"]').click();await incompletePage.page.locator('#itlSheetEdit').click();await incompletePage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(incompletePage.page);await incompletePage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(incompletePage.page);
      await incompletePage.page.locator('[data-seg-bad="'+missingItem.id+'"]').click();
      const before=await incompletePage.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,incomplete.sheet.id);
      await incompletePage.page.locator('#itlEditSave').click();await waitCount(incompletePage.page,'__inspEditSaveSettledBySheet',incomplete.sheet.id,before);
      const notice=await incompletePage.page.locator('#itlNotice').innerText();
      const marks=await incompletePage.page.evaluate(id=>({item:getComputedStyle(document.querySelector('[data-item-id="'+id+'"]').closest('.itl-sheet-row')).outlineStyle,photo:getComputedStyle(document.querySelector('[data-photo-position="item:'+id+'"]')).outlineStyle}),missingItem.id);
      check('E11:已提交保存缺说明和照片时400逐字段标出且保留编辑态',notice.includes('缺异常说明')&&notice.includes('照片未传')&&marks.item!=='none'&&marks.photo!=='none'&&await incompletePage.page.locator('#itlEditSave').count()===1,{notice,marks});
      check('E11:400事务回滚且原已提交值不变',(await getSheet(incomplete.sheet.id)).body.items.find(it=>it.id===missingItem.id).result==='ok');
    }finally{await incompletePage.ctx.close();}
    const deletePage=await openPage(2);
    try{
      await deletePage.page.locator('[data-insp-view="'+submitted.sheet.id+'"]').click();await deletePage.page.locator('#itlSheetDelete').click();
      await deletePage.page.locator('#itlSheetDeleteReason').fill('照片拍摄位置需重做');await deletePage.page.locator('#itlSubmit').click();
      await deletePage.page.locator('#itlInspRows').waitFor({timeout:5000});
      const deleted=(await getSheet(submitted.sheet.id,1)).body;
      check('E9:已提交单删除为逻辑删除、列表去行且保留理由日志',!!deleted.deleted_at&&deleted.log.some(l=>l.action==='delete'&&l.reason==='照片拍摄位置需重做')&&await deletePage.page.locator('[data-insp-row="'+submitted.sheet.id+'"]').count()===0,deleted);
    }finally{await deletePage.ctx.close();}
    const rowEdit=await createSubmitted('PhotoRowActions');
    const rowPage=await openPage(2);
    try{
      await rowPage.page.locator('[data-insp-edit="'+rowEdit.sheet.id+'"]').click();await rowPage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(rowPage.page);
      check('E12:列表编辑入口精确打开该已提交单',await rowPage.page.locator('[data-sheet-id="'+rowEdit.sheet.id+'"]').count()===1);
      await rowPage.page.locator('#itlFormBack').click();await rowPage.page.locator('[data-insp-row="'+rowEdit.sheet.id+'"]').waitFor({timeout:5000});
      await rowPage.page.locator('[data-insp-delete-submitted="'+rowEdit.sheet.id+'"]').click();
      await rowPage.page.locator('#itlSheetDeleteReason').fill('列表入口删除原因');
      const deletedResponse=rowPage.page.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+rowEdit.sheet.id)&&r.request().method()==='DELETE',{timeout:5000});
      await rowPage.page.locator('#itlSubmit').click();await deletedResponse;
      await rowPage.page.locator('[data-insp-row="'+rowEdit.sheet.id+'"]').waitFor({state:'detached',timeout:5000});
      check('E12:列表删除入口按原因逻辑删除且移除行',(await getSheet(rowEdit.sheet.id,1)).body.delete_reason==='列表入口删除原因'&&await rowPage.page.locator('[data-insp-row="'+rowEdit.sheet.id+'"]').count()===0);
    }finally{await rowPage.ctx.close();}
    const unarchive=await createSubmitted('PhotoUnarchive');
    let archived=await getSheet(unarchive.sheet.id,1);
    assert.equal((await f.api('POST','/inspections/sheets/archive',{items:[{id:unarchive.sheet.id,expected_version:archived.body.version}]},1)).status,200);
    const unarchivePage=await openPage(1);
    try{
      await unarchivePage.page.locator('[data-insp-unarchive="'+unarchive.sheet.id+'"]').click();await unarchivePage.page.locator('#itlUnarchiveReason').fill('归档照片需复查');
      const undoResponse=unarchivePage.page.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+unarchive.sheet.id+'/unarchive')&&r.request().method()==='POST',{timeout:5000});
      await unarchivePage.page.locator('#itlSubmit').click();await undoResponse;
      await unarchivePage.page.waitForFunction(id=>document.querySelector('[data-insp-row="'+id+'"]')?.textContent.includes('已提交'),unarchive.sheet.id,{timeout:5000});
      const restored=(await getSheet(unarchive.sheet.id,1)).body;
      check('E13:列表撤回归档入口刷新状态且保留必填原因与日志',restored.status==='submitted'&&restored.log.some(l=>l.action==='unarchive'&&l.reason==='归档照片需复查'),restored);
    }finally{await unarchivePage.ctx.close();}
    archived=await getSheet(unarchive.sheet.id,1);
    assert.equal((await f.api('POST','/inspections/sheets/archive',{items:[{id:unarchive.sheet.id,expected_version:archived.body.version}]},1)).status,200);
    const unarchiveDetail=await openPage(1);
    try{
      await unarchiveDetail.page.locator('[data-insp-view="'+unarchive.sheet.id+'"]').click();await unarchiveDetail.page.locator('#itlSheetUnarchive').waitFor({timeout:5000});
      await unarchiveDetail.page.locator('#itlSheetUnarchive').click();await unarchiveDetail.page.locator('#itlUnarchiveReason').fill('详情入口撤回');
      const undoResponse=unarchiveDetail.page.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+unarchive.sheet.id+'/unarchive')&&r.request().method()==='POST',{timeout:5000});
      await unarchiveDetail.page.locator('#itlSubmit').click();await undoResponse;
      await unarchiveDetail.page.locator('#itlSheetEdit').waitFor({timeout:5000});
      check('E13:详情撤回归档入口更新为可编辑状态',(await getSheet(unarchive.sheet.id,1)).body.status==='submitted'&&await unarchiveDetail.page.locator('#itlSheetUnarchive').count()===0);
    }finally{await unarchiveDetail.ctx.close();}

    // R：按照片id等待迟到缩略图完成；旧会话释放后不得把A的照片画到B的表单。
    const staleA=await createDraft('PhotoStaleA'),staleB=await createDraft('PhotoStaleB');
    const aUpload=await uploadApi(staleA.sheet.id,'rack_front',staleA.rack.id,JPEG),bUpload=await uploadApi(staleB.sheet.id,'rack_front',staleB.rack.id,JPEG2);
    assert.equal(aUpload.status,201);assert.equal(bUpload.status,201);
    const stalePage=await openPage(2);let heldStale;
    try{
      const aPhoto=aUpload.body.photo.id,bPhoto=bUpload.body.photo.id;
      heldStale=await holdOperation(stalePage.page,'**/api/it-assets/inspections/sheets/'+staleA.sheet.id+'/photos/'+aPhoto+'/content','GET',async route=>{const response=await route.fetch();await route.fulfill({response});});
      const before=await stalePage.page.evaluate(key=>window.ITLedger.__inspPhotoReadSettledById.get(key)||0,staleA.sheet.id+':'+aPhoto);
      await stalePage.page.locator('[data-insp-continue="'+staleA.sheet.id+'"]').click();await reachedWithin(heldStale.entered,'stale photo A');
      await stalePage.page.locator('#itlFormBack').click();await stalePage.page.locator('[data-insp-continue="'+staleB.sheet.id+'"]').click();
      await stalePage.page.locator('[data-photo-thumb-id="'+bPhoto+'"][data-photo-thumb-status="loaded"]').waitFor({state:'attached',timeout:5000});
      heldStale.release();await reachedWithin(heldStale.settled,'stale photo response');await waitCount(stalePage.page,'__inspPhotoReadSettledById',staleA.sheet.id+':'+aPhoto,before);
      check('R:旧照片迟到回调不覆盖新单的缩略图或视图',await stalePage.page.locator('[data-sheet-id="'+staleB.sheet.id+'"]').count()===1&&await stalePage.page.locator('[data-photo-id="'+aPhoto+'"]').count()===0&&await stalePage.page.locator('[data-photo-thumb-id="'+bPhoto+'"][data-photo-thumb-status="loaded"]').count()===1);
    }finally{await finishHeld(heldStale);await stalePage.ctx.close();}
    const accountPhoto=await createSubmitted('PhotoAccountSwap');
    const accountPhotoId=(await getSheet(accountPhoto.sheet.id)).body.photos[0].id;
    const accountPage=await openPage(2);
    try{
      await accountPage.page.locator('[data-insp-view="'+accountPhoto.sheet.id+'"]').click();
      await accountPage.page.locator('[data-photo-thumb-id="'+accountPhotoId+'"][data-photo-thumb-status="loaded"]').waitFor({timeout:5000});
      const before=await accountPage.page.evaluate(key=>window.ITLedger.__inspPhotoViewerSettledById.get(key)||0,accountPhoto.sheet.id+':'+accountPhotoId);
      await accountPage.page.evaluate(()=>localStorage.setItem('token','fixture-3'));
      await accountPage.page.locator('[data-detail-photo-view="'+accountPhotoId+'"]').click();
      await waitCount(accountPage.page,'__inspPhotoViewerSettledById',accountPhoto.sheet.id+':'+accountPhotoId,before);
      check('R-account:换号后旧账号缓存照片不能放大给新账号',await accountPage.page.getByRole('dialog').count()===0);
      await accountPage.page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'token',oldValue:'fixture-2',newValue:'fixture-3'})));
    }finally{await accountPage.ctx.close();}

    // Q：草稿修改尚在防抖期时上传，队列必须先完成表单PUT，再发照片POST。
    const queueSheet=await createDraft('PhotoQueue');
    const queueItem=queueSheet.sheet.items.find(it=>it.item_key==='aircon');
    const queuePage=await openPage(2);let heldQueue;
    try{
      await queuePage.page.locator('[data-insp-continue="'+queueSheet.sheet.id+'"]').click();await queuePage.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(queuePage.page);
      await queuePage.page.clock.install();await queuePage.page.clock.pauseAt(new Date());
      let photoPostCount=0;queuePage.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+queueSheet.sheet.id+'/photos')&&r.method()==='POST')photoPostCount++;});
      heldQueue=await holdOperation(queuePage.page,'**/api/it-assets/inspections/sheets/'+queueSheet.sheet.id,'PUT',async route=>{const response=await route.fetch();await route.fulfill({response});});
      await queuePage.page.locator('[data-seg-bad="'+queueItem.id+'"]').click();await queuePage.page.locator('[data-note-id="'+queueItem.id+'"]').fill('先保存再上传');
      await queuePage.page.locator('[data-rack-photo="'+queueSheet.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=queueSheet.sheet.id+':rack_front:'+queueSheet.rack.id;
      const before=await queuePage.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await queuePage.page.locator('[data-photo-upload="rack_front:'+queueSheet.rack.id+'"]').setInputFiles({name:'ordered.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await reachedWithin(heldQueue.entered,'pre-upload flush');
      check('Q:冲刷PUT挂起时照片POST仍为零',photoPostCount===0,photoPostCount);
      heldQueue.release();await waitCount(queuePage.page,'__inspPhotoUploadSettledByPosition',pos,before);
      const server=(await getSheet(queueSheet.sheet.id)).body;
      check('Q:PUT先保存异常说明后照片才入库',photoPostCount===1&&server.items.find(it=>it.id===queueItem.id).note==='先保存再上传'&&server.photos.length===1,{photoPostCount,server});
    }finally{await finishHeld(heldQueue);await queuePage.ctx.close();}

    // M-U：上传在途，编辑与再次上传均被拒；离开后网络失败只留归属账号的照片未上传原文。
    const uploadFlight=await createDraft('PhotoFlightUpload');
    const airconFlight=uploadFlight.sheet.items.find(it=>it.item_key==='aircon');
    const flightU=await openPage(2);let heldU;
    try{
      await flightU.page.locator('[data-insp-continue="'+uploadFlight.sheet.id+'"]').click();await flightU.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(flightU.page);
      await flightU.page.locator('[data-rack-photo="'+uploadFlight.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=uploadFlight.sheet.id+':rack_front:'+uploadFlight.rack.id;
      const before=await flightU.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      heldU=await holdOperation(flightU.page,'**/api/it-assets/inspections/sheets/'+uploadFlight.sheet.id+'/photos','POST',route=>route.abort('failed'));
      await flightU.page.locator('[data-photo-upload="rack_front:'+uploadFlight.rack.id+'"]').setInputFiles({name:'flight.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await reachedWithin(heldU.entered,'upload flight');
      check('M-U:上传在途整表输入只读且照片输入禁用',await flightU.page.locator('#itlFormRemark').evaluate(el=>el.readOnly)&&await flightU.page.locator('[data-photo-upload="rack_front:'+uploadFlight.rack.id+'"]').isDisabled());
      await flightU.page.locator('[data-seg-ok="'+airconFlight.id+'"]').evaluate(el=>el.disabled=false);
      await flightU.page.locator('[data-seg-ok="'+airconFlight.id+'"]').click();
      check('M-U:上传在途编辑被监听器拒绝',!(await flightU.page.locator('[data-seg-ok="'+airconFlight.id+'"]').getAttribute('class')).includes('on-ok'));
      await flightU.page.locator('[data-photo-upload="rack_front:'+uploadFlight.rack.id+'"]').evaluate(el=>{const d=new DataTransfer();d.items.add(new File(['x'],'again.jpg',{type:'image/jpeg'}));el.files=d.files;el.dispatchEvent(new Event('change',{bubbles:true}));});
      check('M-U:上传在途再次选择文件不排第二次请求',heldU.count()===1,heldU.count());
      await flightU.page.evaluate(()=>location.hash='racks');await flightU.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldU.release();await waitCount(flightU.page,'__inspPhotoUploadSettledByPosition',pos,before);
      await flightU.page.evaluate(()=>location.hash='inspections');
      const banner=await flightU.page.locator('#itlUnsavedList [data-unsaved-sheet="'+uploadFlight.sheet.id+'"]').innerText({timeout:5000});
      // codex 49 M-2（用户 09-29 按推荐）：请求已发出后网络失败，客户端无法判断服务端是否收下——登记为「结果未能确认」，
      // 不再断言「未上传」（本用例在发出前中断，服务端确实无照片，但客户端看到的是同一种网络异常）。
      check('M-U:离开后上传网络失败登记位置且说明结果未能确认',banner.includes('照片上传结果未能确认：')&&banner.includes(uploadFlight.rack.name)&&banner.includes('请重新打开核对')&&banner.includes('网络异常')&&!banner.includes('照片未上传'),banner);
      check('M-U:网络失败服务端无照片',(await getSheet(uploadFlight.sheet.id)).body.photos.length===0);
    }finally{await finishHeld(heldU);await flightU.ctx.close();}

    // M-D：删除在途锁住编辑，离开后409仍保留服务端照片并提示实际冲突原因。
    const deleteFlight=await createDraft('PhotoFlightDelete');
    assert.equal((await uploadApi(deleteFlight.sheet.id,'rack_front',deleteFlight.rack.id,JPEG)).status,201);
    const photoToDelete=(await getSheet(deleteFlight.sheet.id)).body.photos[0];
    const flightD=await openPage(2);let heldD;
    try{
      await flightD.page.locator('[data-insp-continue="'+deleteFlight.sheet.id+'"]').click();await flightD.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(flightD.page);
      await flightD.page.locator('[data-rack-photo="'+deleteFlight.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=deleteFlight.sheet.id+':rack_front:'+deleteFlight.rack.id;
      const before=await flightD.page.evaluate(key=>window.ITLedger.__inspPhotoDeleteSettledByPosition.get(key)||0,pos);
      heldD=await holdOperation(flightD.page,'**/api/it-assets/inspections/sheets/'+deleteFlight.sheet.id+'/photos/'+photoToDelete.id,'DELETE',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'SHEET_VERSION_CONFLICT',message:'版本冲突'})}));
      await flightD.page.locator('[data-photo-delete="'+photoToDelete.id+'"]').click();await reachedWithin(heldD.entered,'delete flight');
      check('M-D:删除在途文本只读且照片输入禁用',await flightD.page.locator('#itlFormRemark').evaluate(el=>el.readOnly)&&await flightD.page.locator('[data-photo-upload="rack_front:'+deleteFlight.rack.id+'"]').isDisabled());
      const airconD=deleteFlight.sheet.items.find(it=>it.item_key==='aircon');
      await flightD.page.locator('[data-seg-bad="'+airconD.id+'"]').evaluate(el=>el.disabled=false);
      await flightD.page.locator('[data-seg-bad="'+airconD.id+'"]').click();
      check('M-D:删除在途编辑被监听器拒绝',!(await flightD.page.locator('[data-seg-bad="'+airconD.id+'"]').getAttribute('class')).includes('on-bad'));
      await flightD.page.evaluate(()=>location.hash='racks');await flightD.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldD.release();await waitCount(flightD.page,'__inspPhotoDeleteSettledByPosition',pos,before);
      check('M-D:离开后409仍留旧照且提示与他人修改冲突',(await getSheet(deleteFlight.sheet.id)).body.photos[0].id===photoToDelete.id&&(await flightD.page.locator('#itlNotice').innerText()).includes('与他人修改冲突'));
    }finally{await finishHeld(heldD);await flightD.ctx.close();}

    // M-S：显式保存在途拒绝编辑；离开后网络失败把本地原文留在原账号登记表。
    const saveFlight=await createSubmitted('PhotoFlightSave');
    const flightS=await openPage(2);let heldS;
    try{
      await flightS.page.locator('[data-insp-view="'+saveFlight.sheet.id+'"]').click();await flightS.page.locator('#itlSheetEdit').click();await flightS.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(flightS.page);await flightS.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(flightS.page);
      await flightS.page.locator('#itlFormRemark').fill('保存中不应丢的备注');
      const before=await flightS.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,saveFlight.sheet.id);
      heldS=await holdOperation(flightS.page,'**/api/it-assets/inspections/sheets/'+saveFlight.sheet.id,'PUT',route=>route.abort('failed'));
      await flightS.page.locator('#itlEditSave').click();await reachedWithin(heldS.entered,'save edit flight');
      check('M-S:保存修改在途备注只读且照片输入禁用',await flightS.page.locator('#itlFormRemark').evaluate(el=>el.readOnly)&&await flightS.page.locator('[data-photo-upload]').first().isDisabled());
      const airconS=saveFlight.sheet.items.find(it=>it.item_key==='aircon');
      await flightS.page.locator('[data-seg-bad="'+airconS.id+'"]').evaluate(el=>el.disabled=false);
      await flightS.page.locator('[data-seg-bad="'+airconS.id+'"]').click();
      check('M-S:保存修改在途异常开关被监听器拒绝',!(await flightS.page.locator('[data-seg-bad="'+airconS.id+'"]').getAttribute('class')).includes('on-bad'));
      await flightS.page.evaluate(()=>location.hash='racks');await flightS.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldS.release();await waitCount(flightS.page,'__inspEditSaveSettledBySheet',saveFlight.sheet.id,before);
      check('M-S:网络失败服务端备注未改变',(await getSheet(saveFlight.sheet.id)).body.remark===null);
      await flightS.page.evaluate(()=>location.hash='inspections');
      const banner=await flightS.page.locator('#itlUnsavedList [data-unsaved-sheet="'+saveFlight.sheet.id+'"]').innerText({timeout:5000});
      check('M-S:离开后本地备注登记为已提交单修改未保存',banner.includes('保存中不应丢的备注')&&banner.includes('已提交单的修改未保存'),banner);
    }finally{await finishHeld(heldS);await flightS.ctx.close();}

    const lateSave=await createSubmitted('PhotoLateSave');
    const latePage=await openPage(2);let heldLate;
    try{
      await latePage.page.locator('[data-insp-view="'+lateSave.sheet.id+'"]').click();await latePage.page.locator('#itlSheetEdit').click();await latePage.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(latePage.page);await latePage.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(latePage.page);
      await latePage.page.locator('#itlFormRemark').fill('离开后才保存成功');
      const before=await latePage.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,lateSave.sheet.id);
      heldLate=await holdOperation(latePage.page,'**/api/it-assets/inspections/sheets/'+lateSave.sheet.id,'PUT',async route=>{const response=await route.fetch();await route.fulfill({response});});
      await latePage.page.locator('#itlEditSave').click();await reachedWithin(heldLate.entered,'late save');
      await latePage.page.evaluate(()=>location.hash='racks');await latePage.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldLate.release();await waitCount(latePage.page,'__inspEditSaveSettledBySheet',lateSave.sheet.id,before);
      check('M-Ssuccess:迟到成功已落库且未把编辑页画回机柜视图',(await getSheet(lateSave.sheet.id)).body.remark==='离开后才保存成功'&&await latePage.page.locator('#itlFormActionbar').count()===0);
      await latePage.page.evaluate(()=>location.hash='inspections');
      const banner=await latePage.page.locator('#itlUnsavedList [data-unsaved-sheet="'+lateSave.sheet.id+'"]').innerText({timeout:5000});
      check('M-Ssuccess:旧原文仍在并标注后续保存值',banner.includes('备注：离开后才保存成功')&&banner.includes('已被后续保存为：离开后才保存成功'),banner);
    }finally{await finishHeld(heldLate);await latePage.ctx.close();}

    // M-P：放弃修改在途拒绝编辑；真实403清页后服务端pending仍在，下次可继续决定。
    const discardFlight=await createSubmitted('PhotoFlightDiscard');
    assert.equal((await uploadApi(discardFlight.sheet.id,'rack_front',discardFlight.rack.id,JPEG2)).status,201);
    const flightP=await openPage(2);let heldP;
    try{
      await flightP.page.locator('[data-insp-view="'+discardFlight.sheet.id+'"]').click();await flightP.page.locator('#itlSheetEdit').click();await flightP.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(flightP.page);await flightP.page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(flightP.page);
      await flightP.page.locator('[data-pending-decision="keep"]').click();await flightP.page.locator('#itlFormRemark').fill('放弃在途编辑');
      const before=await flightP.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,discardFlight.sheet.id);
      heldP=await holdOperation(flightP.page,'**/api/it-assets/inspections/sheets/'+discardFlight.sheet.id+'/pending-photos','DELETE',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})}));
      await flightP.page.locator('#itlEditDiscard').click();await reachedWithin(heldP.entered,'discard flight');
      check('M-P:放弃修改在途备注只读且照片输入禁用',await flightP.page.locator('#itlFormRemark').evaluate(el=>el.readOnly)&&await flightP.page.locator('[data-photo-upload]').first().isDisabled());
      const airconP=discardFlight.sheet.items.find(it=>it.item_key==='aircon');
      await flightP.page.locator('[data-seg-bad="'+airconP.id+'"]').evaluate(el=>el.disabled=false);
      await flightP.page.locator('[data-seg-bad="'+airconP.id+'"]').click();
      check('M-P:放弃修改在途编辑被监听器拒绝',!(await flightP.page.locator('[data-seg-bad="'+airconP.id+'"]').getAttribute('class')).includes('on-bad'));
      await flightP.page.evaluate(()=>location.hash='racks');await flightP.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldP.release();await waitCount(flightP.page,'__inspPendingDiscardSettledBySheet',discardFlight.sheet.id,before);
      check('M-P:403后pending仍在且全局权限兜底隐藏页签',(await getSheet(discardFlight.sheet.id)).body.my_pending_photos.length===1&&!(await flightP.page.locator('#itlTabs').isVisible()));
    }finally{await finishHeld(heldP);await flightP.ctx.close();}

    // M-U403：上传权限被收回，真实403不能把新写入口留在页面。
    const forbiddenUpload=await createDraft('PhotoFlight403');
    const flight403=await openPage(2);let held403;
    try{
      await flight403.page.locator('[data-insp-continue="'+forbiddenUpload.sheet.id+'"]').click();await flight403.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(flight403.page);
      await flight403.page.locator('[data-rack-photo="'+forbiddenUpload.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=forbiddenUpload.sheet.id+':rack_front:'+forbiddenUpload.rack.id;
      const before=await flight403.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      held403=await holdOperation(flight403.page,'**/api/it-assets/inspections/sheets/'+forbiddenUpload.sheet.id+'/photos','POST',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})}));
      await flight403.page.locator('[data-photo-upload="rack_front:'+forbiddenUpload.rack.id+'"]').setInputFiles({name:'forbidden.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await reachedWithin(held403.entered,'upload 403');held403.release();await waitCount(flight403.page,'__inspPhotoUploadSettledByPosition',pos,before);
      check('M-U403:真实403清空写界面且照片未落库',!(await flight403.page.locator('#itlTabs').isVisible())&&(await getSheet(forbiddenUpload.sheet.id)).body.photos.length===0);
    }finally{await finishHeld(held403);await flight403.ctx.close();}

    // ===== Claude 外审（2026-09-26）补测：失权结束会话后的原文提示、排队任务静默、残留照片丢弃范围 =====
    const forbid403=route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})});
    // 记录 #itlNotice 的每一次取值：「最终是全文」不够，中途被别的提示覆盖过也要能判出来。
    const recordNotices=page=>page.evaluate(()=>{window.__noticeHistory=[];const L=window.ITLedger,orig=L.notice;L.notice=function(m){window.__noticeHistory.push(String(m));return orig.apply(this,arguments);};const el=document.querySelector('#itlNotice');new MutationObserver(records=>{for(const r of records){if(r.type==='characterData')window.__noticeHistory.push(r.target.textContent);for(const n of r.addedNodes)window.__noticeHistory.push(n.textContent);}}).observe(el,{childList:true,characterData:true,subtree:true});});
    const waitNotice=(page,parts)=>page.waitForFunction(parts=>{const t=document.querySelector('#itlNotice')?.textContent||'';return parts.every(p=>t.includes(p));},parts,{timeout:5000});
    const createCompleteDraft=async room=>{
      const draft=await createDraft(room),detail=(await getSheet(draft.sheet.id)).body;
      const items=detail.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
      assert.equal((await f.api('PUT','/inspections/sheets/'+draft.sheet.id,{expected_version:detail.version,items},2)).status,200);
      assert.equal((await uploadApi(draft.sheet.id,'rack_front',draft.rack.id,JPEG)).status,201);
      return draft;
    };

    // X1（外审 H-1）：已提交单编辑时保存遇 403——原文不能只静默进内存登记表，要一次性全文提示，原因是权限而非登录。
    const x1=await createSubmitted('AuditX1Edit');const px1=await openPage(2);let heldX1;
    try{
      await px1.page.locator('[data-insp-view="'+x1.sheet.id+'"]').click();await px1.page.locator('#itlSheetEdit').click();await px1.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(px1.page);await px1.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(px1.page);
      await px1.page.locator('#itlFormRemark').fill('X1外审备注');
      const before=await px1.page.evaluate(id=>window.ITLedger.__inspEditSaveSettledBySheet.get(id)||0,x1.sheet.id);
      heldX1=await holdOperation(px1.page,'**/api/it-assets/inspections/sheets/'+x1.sheet.id,'PUT',forbid403);
      await px1.page.locator('#itlEditSave').click();await reachedWithin(heldX1.entered,'X1 save');heldX1.release();
      await waitCount(px1.page,'__inspEditSaveSettledBySheet',x1.sheet.id,before);
      await waitNotice(px1.page,['访问权限已变化。巡检单〈AuditX1Edit','备注：X1外审备注（原因：编辑权限已变化）']);
      const noticeX1=await px1.page.locator('#itlNotice').textContent();
      check('X1(H-1):已提交单保存403后一次性提示含全文且原因为权限',noticeX1.startsWith('访问权限已变化。巡检单〈AuditX1Edit')&&noticeX1.includes('备注：X1外审备注（原因：编辑权限已变化）')&&!noticeX1.includes('登录状态已变化'),noticeX1);
      check('X1(H-1):服务端备注未被改写',(await getSheet(x1.sheet.id)).body.remark!=='X1外审备注');
    }finally{await finishHeld(heldX1);await px1.ctx.close();}

    // X2（外审 M-3）：已提交单编辑时上传照片遇 403——照片未上传要出现在一次性提示里。
    const x2=await createSubmitted('AuditX2Upload');const px2=await openPage(2);let heldX2;
    try{
      await px2.page.locator('[data-insp-view="'+x2.sheet.id+'"]').click();await px2.page.locator('#itlSheetEdit').click();await px2.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(px2.page);await px2.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(px2.page);
      await px2.page.locator('[data-rack-photo="'+x2.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=x2.sheet.id+':rack_front:'+x2.rack.id;
      const before=await px2.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      heldX2=await holdOperation(px2.page,'**/api/it-assets/inspections/sheets/'+x2.sheet.id+'/photos','POST',forbid403);
      await px2.page.locator('[data-photo-upload="rack_front:'+x2.rack.id+'"]').setInputFiles({name:'x2.jpg',mimeType:'image/jpeg',buffer:JPEG2});
      await reachedWithin(heldX2.entered,'X2 upload');heldX2.release();await waitCount(px2.page,'__inspPhotoUploadSettledByPosition',pos,before);
      await waitNotice(px2.page,['访问权限已变化。巡检单〈AuditX2Upload','照片未上传：']);
      const noticeX2=await px2.page.locator('#itlNotice').textContent();
      check('X2(M-3):照片上传403后一次性提示列出照片未上传且原因为权限',/照片未上传：[^；]*（文件内容未保留）（原因：编辑权限已变化）/.test(noticeX2),noticeX2);
    }finally{await finishHeld(heldX2);await px2.ctx.close();}

    // X3（外审 H-2）：草稿改了备注立即提交，冲刷 PUT 遇 403——排在后面的提交任务不能发 POST，也不能用
    // 「未能提交」覆盖全文提示（记录每次提示取值，中途覆盖过也判红）。
    const x3=await createCompleteDraft('AuditX3Submit');const px3=await openPage(2);let heldX3;
    try{
      let submitPosts=0;px3.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+x3.sheet.id+'/submit')&&r.method()==='POST')submitPosts++;});
      await px3.page.locator('[data-insp-continue="'+x3.sheet.id+'"]').click();await px3.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(px3.page);
      await px3.page.locator('#itlFormSubmit:not([disabled])').waitFor({timeout:5000});await expandInspectionForm(px3.page);
      await recordNotices(px3.page);
      await px3.page.locator('#itlFormRemark').fill('X3外审备注');
      const before=await px3.page.evaluate(id=>window.ITLedger.__inspSubmitSettledBySheet.get(id)||0,x3.sheet.id);
      heldX3=await holdOperation(px3.page,'**/api/it-assets/inspections/sheets/'+x3.sheet.id,'PUT',forbid403);
      await px3.page.locator('#itlFormSubmit').click();await reachedWithin(heldX3.entered,'X3 flush');heldX3.release();
      await waitCount(px3.page,'__inspSubmitSettledBySheet',x3.sheet.id,before);
      await waitNotice(px3.page,['访问权限已变化。巡检单〈AuditX3Submit','备注：X3外审备注（原因：编辑权限已变化）']);
      const history=await px3.page.evaluate(()=>window.__noticeHistory);
      check('X3(H-2):冲刷403后提交任务零POST',submitPosts===0,submitPosts);
      check('X3(H-2):全过程没有出现「未能提交」类提示覆盖原文',!history.some(t=>t.includes('未能提交')||t.includes('已取消提交')),history);
    }finally{await finishHeld(heldX3);await px3.ctx.close();}

    // X4（外审 H-2）：草稿改了备注立即删除，冲刷遇 403——不能再提示「已取消删除」覆盖原文，也不发 DELETE。
    const x4=await createDraft('AuditX4Delete');const px4=await openPage(2);let heldX4;
    try{
      let deletes=0;px4.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+x4.sheet.id)&&r.method()==='DELETE')deletes++;});
      await px4.page.locator('[data-insp-continue="'+x4.sheet.id+'"]').click();await px4.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(px4.page);
      await recordNotices(px4.page);
      await px4.page.locator('#itlFormRemark').fill('X4外审备注');
      heldX4=await holdOperation(px4.page,'**/api/it-assets/inspections/sheets/'+x4.sheet.id,'PUT',forbid403);
      await px4.page.locator('#itlFormDelete').click();await px4.page.locator('#itlSubmit').click({timeout:5000});
      const beforeX4=await px4.page.evaluate(id=>window.ITLedger.__inspDeleteSettledBySheet.get(id)||0,x4.sheet.id);
      await reachedWithin(heldX4.entered,'X4 flush');heldX4.release();
      await waitCount(px4.page,'__inspDeleteSettledBySheet',x4.sheet.id,beforeX4);
      await waitNotice(px4.page,['访问权限已变化。巡检单〈AuditX4Delete','备注：X4外审备注（原因：编辑权限已变化）']);
      const history=await px4.page.evaluate(()=>window.__noticeHistory);
      check('X4(H-2):冲刷403后零DELETE且草稿仍在',deletes===0&&(await getSheet(x4.sheet.id)).status===200,deletes);
      check('X4(H-2):全过程没有出现「已取消删除」提示覆盖原文',!history.some(t=>t.includes('已取消删除')),history);
    }finally{await finishHeld(heldX4);await px4.ctx.close();}

    // X5（外审 M-1，用户裁 A）：残留提示的「丢弃」只删进入编辑时已有的残留照片；本次新传的保留，计数也只算残留。
    const x5Room='AuditX5Leftover';
    const x5Rack1=(await f.api('POST','/racks',{name:x5Room+'-柜1',room:x5Room,u_total:20})).body,x5Rack2=(await f.api('POST','/racks',{name:x5Room+'-柜2',room:x5Room,u_total:20})).body;
    await f.api('POST','',{category:'server',name:x5Room+'-设备1',u_height:1,placement:{kind:'rack',rack_id:x5Rack1.id,u_start:1}});
    const x5Sheet=(await f.api('POST','/inspections/sheets',{room_name:x5Room},2)).body,x5Detail=(await getSheet(x5Sheet.id)).body;
    const x5Items=x5Detail.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
    const x5Put=await f.api('PUT','/inspections/sheets/'+x5Sheet.id,{expected_version:x5Detail.version,items:x5Items},2);assert.equal(x5Put.status,200);
    assert.equal((await uploadApi(x5Sheet.id,'rack_front',x5Rack1.id,JPEG)).status,201);assert.equal((await uploadApi(x5Sheet.id,'rack_front',x5Rack2.id,JPEG2)).status,201);
    assert.equal((await f.api('POST','/inspections/sheets/'+x5Sheet.id+'/submit',{expected_version:x5Put.body.version},2)).status,200);
    const leftoverResp=(await uploadApi(x5Sheet.id,'rack_front',x5Rack1.id,JPEG3)).body;const leftover=leftoverResp&&leftoverResp.photo;assert.ok(leftover&&leftover.id,JSON.stringify(leftoverResp));
    const px5=await openPage(2);
    try{
      await px5.page.locator('[data-insp-view="'+x5Sheet.id+'"]').click();await px5.page.locator('#itlSheetEdit').click();await px5.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(px5.page);await px5.page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(px5.page);
      await px5.page.locator('[data-rack-photo="'+x5Rack2.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      const pos=x5Sheet.id+':rack_front:'+x5Rack2.id;
      let before=await px5.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await px5.page.locator('[data-photo-upload="rack_front:'+x5Rack2.id+'"]').setInputFiles({name:'x5-new.jpg',mimeType:'image/jpeg',buffer:Buffer.concat([JPEG,Buffer.from('x5-new')])});
      await waitCount(px5.page,'__inspPhotoUploadSettledByPosition',pos,before);
      const pendingBefore=(await getSheet(x5Sheet.id)).body.my_pending_photos;
      check('X5(M-1):前置——服务端此刻有残留与新传两张pending',pendingBefore.length===2&&pendingBefore.some(p=>p.id===leftover.id),pendingBefore);
      check('X5(M-1):新传照片后残留提示仍只计1张',(await px5.page.locator('#itlPendingDecision').innerText()).includes('有上次未保存的 1 项照片变更'));
      before=await px5.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,x5Sheet.id);
      await px5.page.locator('[data-pending-decision="discard"]').click();await waitCount(px5.page,'__inspPendingDiscardSettledBySheet',x5Sheet.id,before);
      const pendingAfter=(await getSheet(x5Sheet.id)).body.my_pending_photos;
      check('X5(M-1):丢弃只删残留照片，本次新传的仍在',pendingAfter.length===1&&pendingAfter[0].id!==leftover.id&&pendingAfter[0].target_id===x5Rack2.id,pendingAfter);
      check('X5(M-1):丢弃后残留提示消失且仍在编辑态',await px5.page.locator('#itlPendingDecision').count()===0&&await px5.page.locator('#itlEditSave').count()===1);
    }finally{await px5.ctx.close();}

    // X6（外审 M-2 / W2UP）：草稿上传照片——前置冲刷 PUT 成功返回后、照片 POST 发出前换号（同页直接改
    // localStorage，不派发 storage 事件，等价于他页已写入而事件尚未送达），不得以新账号发 POST。
    const x6=await createDraft('AuditX6Swap');const px6=await openPage(2);
    try{
      let photoPosts=0;px6.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+x6.sheet.id+'/photos')&&r.method()==='POST')photoPosts++;});
      await px6.page.locator('[data-insp-continue="'+x6.sheet.id+'"]').click();await px6.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(px6.page);
      await px6.page.locator('[data-rack-photo="'+x6.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      await px6.page.locator('#itlFormRemark').fill('X6外审备注');
      await px6.page.evaluate(id=>{
        const original=window.ITLedger.api;
        window.ITLedger.api=async(path,options)=>{const result=await original(path,options);if(path==='/inspections/sheets/'+id&&options&&options.method==='PUT'){localStorage.setItem('token','fixture-1');window.ITLedger.api=original;}return result;};
      },x6.sheet.id);
      const pos=x6.sheet.id+':rack_front:'+x6.rack.id;
      const before=await px6.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await px6.page.locator('[data-photo-upload="rack_front:'+x6.rack.id+'"]').setInputFiles({name:'x6.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await waitCount(px6.page,'__inspPhotoUploadSettledByPosition',pos,before);
      const server=(await getSheet(x6.sheet.id)).body;
      check('X6(W2UP):前置——冲刷PUT已以原账号落库',server.remark==='X6外审备注',server.remark);
      check('X6(W2UP):换号后照片POST零发出且服务端无照片',photoPosts===0&&server.photos.length===0,{photoPosts,photos:server.photos});
    }finally{await px6.ctx.close();}

    // ===== codex 48 确认补测（2026-09-27）=====
    // 一条独立的在途请求，由测试控制何时以 403 返回：走真实共享层 L.api（与设备明细预取同一入口）。
    const statsPattern='**/api/it-assets/inspections/sheets/stats';
    const startSideRequest=page=>page.evaluate(()=>{window.__side=window.ITLedger.api('/inspections/sheets/stats').then(()=>'ok',e=>'status:'+e.status);});

    // Y1（48 H-1）：全文提示出现后，另一条在途请求才返回 403——共享层不得再用短提示覆盖全文。
    const y1=await createSubmitted('AuditY1Second403');const py1=await openPage(2);let heldY1Put,heldY1Side;
    try{
      await py1.page.locator('[data-insp-view="'+y1.sheet.id+'"]').click();await py1.page.locator('#itlSheetEdit').click();await py1.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(py1.page);await py1.page.locator('#itlEditSave').waitFor({timeout:5000});await expandInspectionForm(py1.page);
      await py1.page.locator('#itlFormRemark').fill('Y1外审备注');
      heldY1Side=await holdOperation(py1.page,statsPattern,'GET',forbid403);
      await startSideRequest(py1.page);await reachedWithin(heldY1Side.entered,'Y1 side request');
      heldY1Put=await holdOperation(py1.page,'**/api/it-assets/inspections/sheets/'+y1.sheet.id,'PUT',forbid403);
      await recordNotices(py1.page);
      await py1.page.locator('#itlEditSave').click();await reachedWithin(heldY1Put.entered,'Y1 save');heldY1Put.release();
      await waitNotice(py1.page,['访问权限已变化。巡检单〈AuditY1Second403','备注：Y1外审备注（原因：编辑权限已变化）']);
      heldY1Side.release();
      const side=await py1.page.evaluate(()=>window.__side);
      const noticeY1=await py1.page.locator('#itlNotice').textContent();
      check('Y1(48 H-1):前置——第二条请求确以403结束',side==='status:403',side);
      check('Y1(48 H-1):第二个403之后全文提示仍在',noticeY1.includes('备注：Y1外审备注（原因：编辑权限已变化）'),noticeY1);
    }finally{await finishHeld(heldY1Put);await finishHeld(heldY1Side);await py1.ctx.close();}

    // Y2（48 H-2）：草稿上传照片——前置冲刷 PUT 在途时，另一条请求 403 结束会话；PUT 随后成功返回，不得再发照片 POST。
    const y2=await createDraft('AuditY2Flush');const py2=await openPage(2);let heldY2;
    try{
      let photoPosts=0;py2.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+y2.sheet.id+'/photos')&&r.method()==='POST')photoPosts++;});
      await py2.page.locator('[data-insp-continue="'+y2.sheet.id+'"]').click();await py2.page.locator('#itlFormActionbar').waitFor({timeout:5000});await expandInspectionForm(py2.page);
      await py2.page.locator('[data-rack-photo="'+y2.rack.id+'"] [data-rack-photo-status]').waitFor({state:'visible'});
      await py2.page.locator('#itlFormRemark').fill('Y2外审备注');
      heldY2=await holdOperation(py2.page,'**/api/it-assets/inspections/sheets/'+y2.sheet.id,'PUT',async route=>{const response=await route.fetch();await route.fulfill({response});});
      await py2.page.route(statsPattern,route=>route.request().method()==='GET'?forbid403(route):route.fallback());
      const pos=y2.sheet.id+':rack_front:'+y2.rack.id;
      const before=await py2.page.evaluate(key=>window.ITLedger.__inspPhotoUploadSettledByPosition.get(key)||0,pos);
      await py2.page.locator('[data-photo-upload="rack_front:'+y2.rack.id+'"]').setInputFiles({name:'y2.jpg',mimeType:'image/jpeg',buffer:JPEG});
      await reachedWithin(heldY2.entered,'Y2 flush');
      await startSideRequest(py2.page);await py2.page.waitForFunction(()=>window.ITLedger.state.level===null,undefined,{timeout:5000});
      heldY2.release();await waitCount(py2.page,'__inspPhotoUploadSettledByPosition',pos,before);
      const server=(await getSheet(y2.sheet.id)).body;
      check('Y2(48 H-2):前置——冲刷PUT确已成功落库',server.remark==='Y2外审备注',server.remark);
      check('Y2(48 H-2):冲刷等待期间失权后照片POST零发出',photoPosts===0&&server.photos.length===0,{photoPosts,photos:server.photos.length});
    }finally{await finishHeld(heldY2);await py2.ctx.close();}

    // Y3（48 H-3）：已离开的旧会话——提交排在冲刷之后，冲刷在途时离开表单，再由另一条请求 403 结束访问；
    // 冲刷随后成功返回，排队的提交不得再发 POST，也不得出「未能提交」提示。
    const y3=await createCompleteDraft('AuditY3Left');const py3=await openPage(2);let heldY3;
    try{
      let submitPosts=0;py3.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+y3.sheet.id+'/submit')&&r.method()==='POST')submitPosts++;});
      await py3.page.locator('[data-insp-continue="'+y3.sheet.id+'"]').click();await py3.page.locator('#itlFormSubmit:not([disabled])').waitFor({timeout:5000});await expandInspectionForm(py3.page);
      await py3.page.locator('#itlFormRemark').fill('Y3外审备注');
      heldY3=await holdOperation(py3.page,'**/api/it-assets/inspections/sheets/'+y3.sheet.id,'PUT',async route=>{const response=await route.fetch();await route.fulfill({response});});
      await py3.page.route(statsPattern,route=>route.request().method()==='GET'?forbid403(route):route.fallback());
      await recordNotices(py3.page);
      const before=await py3.page.evaluate(id=>window.ITLedger.__inspSubmitSettledBySheet.get(id)||0,y3.sheet.id);
      await py3.page.locator('#itlFormSubmit').click();await reachedWithin(heldY3.entered,'Y3 flush');
      await py3.page.evaluate(()=>location.hash='racks');await py3.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      await startSideRequest(py3.page);await py3.page.waitForFunction(()=>window.ITLedger.state.level===null,undefined,{timeout:5000});
      heldY3.release();await waitCount(py3.page,'__inspSubmitSettledBySheet',y3.sheet.id,before);
      const history=await py3.page.evaluate(()=>window.__noticeHistory);
      check('Y3(48 H-3):前置——冲刷PUT确已成功落库',(await getSheet(y3.sheet.id)).body.remark==='Y3外审备注');
      check('Y3(48 H-3):离开后的旧会话失权后提交零POST且仍是草稿',submitPosts===0&&(await getSheet(y3.sheet.id)).body.status==='draft',submitPosts);
      check('Y3(48 H-3):没有出现「未能提交」类提示',!history.some(t=>t.includes('未能提交')||t.includes('已取消提交')),history);
    }finally{await finishHeld(heldY3);await py3.ctx.close();}

    // Y4（48 H-4）：响应头已到、响应体读取期间换号——旧账号的 403 不得清空新账号界面，按「登录状态已变化」拒绝。
    const py4=await openPage(2);
    try{
      await py4.page.locator('#itlTabs').waitFor({timeout:5000});
      const result=await py4.page.evaluate(async()=>{
        const original=window.authFetch;
        window.authFetch=async(url,options)=>{window.authFetch=original;return {ok:false,status:403,headers:new Headers(),json:async()=>{localStorage.setItem('token','fixture-1');return {code:'LEDGER_FORBIDDEN',message:'访问权限已变化'};}};};
        try{await window.ITLedger.api('/inspections/sheets/stats');return {thrown:null};}catch(e){return {thrown:e.status,level:window.ITLedger.state.level,tabsHidden:document.querySelector('#itlTabs').hidden,notice:document.querySelector('#itlNotice').textContent};}
      });
      check('Y4(48 H-4):响应体读取期间换号按401拒绝且不清空界面',result.thrown===401&&result.level!==null&&!result.tabsHidden&&!result.notice.includes('访问权限已变化'),result);
    }finally{await py4.ctx.close();}

    // Y5（48 M-1）：两张残留逐张丢弃，第一张成功、第二张失败——界面按服务端校准（残留只剩 1 张），提示写明进度。
    const y5Room='AuditY5Partial';
    const y5Rack1=(await f.api('POST','/racks',{name:y5Room+'-柜1',room:y5Room,u_total:20})).body,y5Rack2=(await f.api('POST','/racks',{name:y5Room+'-柜2',room:y5Room,u_total:20})).body;
    await f.api('POST','',{category:'server',name:y5Room+'-设备1',u_height:1,placement:{kind:'rack',rack_id:y5Rack1.id,u_start:1}});
    const y5Sheet=(await f.api('POST','/inspections/sheets',{room_name:y5Room},2)).body,y5Detail=(await getSheet(y5Sheet.id)).body;
    const y5Items=y5Detail.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
    const y5Put=await f.api('PUT','/inspections/sheets/'+y5Sheet.id,{expected_version:y5Detail.version,items:y5Items},2);assert.equal(y5Put.status,200);
    assert.equal((await uploadApi(y5Sheet.id,'rack_front',y5Rack1.id,JPEG)).status,201);assert.equal((await uploadApi(y5Sheet.id,'rack_front',y5Rack2.id,JPEG2)).status,201);
    assert.equal((await f.api('POST','/inspections/sheets/'+y5Sheet.id+'/submit',{expected_version:y5Put.body.version},2)).status,200);
    const y5L1=(await uploadApi(y5Sheet.id,'rack_front',y5Rack1.id,JPEG3)).body.photo,y5L2=(await uploadApi(y5Sheet.id,'rack_front',y5Rack2.id,Buffer.concat([JPEG,Buffer.from('y5-l2')]))).body.photo;
    const py5=await openPage(2);
    try{
      await py5.page.locator('[data-insp-view="'+y5Sheet.id+'"]').click();await py5.page.locator('#itlSheetEdit').click();await py5.page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(py5.page);await py5.page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(py5.page);
      check('Y5(48 M-1):前置——残留提示计2张',(await py5.page.locator('#itlPendingDecision').innerText()).includes('有上次未保存的 2 项照片变更'));
      const ids=[y5L1.id,y5L2.id].sort((a,b)=>a-b);
      await py5.page.route('**/api/it-assets/inspections/sheets/'+y5Sheet.id+'/photos/'+ids[1],route=>route.request().method()==='DELETE'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'LEDGER_INTERNAL',message:'boom'})}):route.fallback());
      const before=await py5.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y5Sheet.id);
      await py5.page.locator('[data-pending-decision="discard"]').click();await waitCount(py5.page,'__inspPendingDiscardSettledBySheet',y5Sheet.id,before);
      const serverPending=(await getSheet(y5Sheet.id)).body.my_pending_photos.map(p=>p.id);
      const banner=await py5.page.locator('#itlPendingDecision').innerText();
      const notice=await py5.page.locator('#itlNotice').textContent();
      check('Y5(48 M-1):前置——服务端只剩第二张残留',serverPending.length===1&&serverPending[0]===ids[1],serverPending);
      check('Y5(48 M-1):部分失败后界面按服务端校准残留计1张',banner.includes('有上次未保存的 1 项照片变更'),banner);
      check('Y5(48 M-1):提示写明已丢弃1张余1张',notice.includes('已丢弃 1 张，余 1 张'),notice);
    }finally{await py5.ctx.close();}

    // ===== codex 48-R 确认补测（2026-09-27）=====
    // S-SESSION（48-R H1；48-R2 L1 收窄）：针对当前源码写法的回归检查，不是语法级证明——按「行首两空格的
    // function 声明」切分函数、先剥行注释再计数。会话函数一律经 sessionApi，不直接调 L.api；直接调 L.api 的
    // 函数集合恰为白名单（列表 / 详情 / 弹窗 / 设备明细预取等非会话读写）；不带括号的 L.api 引用（别名）只许
    // 出现在删除草稿的 reqApi 那一行。箭头函数、跨行调用等其他写法不在本检查的判定能力内。
    {
      const src=require('fs').readFileSync(require('path').join(__dirname,'../public/assets/js/it-ledger-inspection-sheets.js'),'utf8').split(/\r?\n/).map(l=>l.replace(/(^|\s)\/\/.*$/,'$1'));
      const byFn=new Map();let fn='(top)';
      src.forEach(line=>{const m=line.match(/^\s{2}(?:async )?function ([A-Za-z0-9_]+)\(/);if(m)fn=m[1];const e=byFn.get(fn)||{api:0,session:0};e.api+=(line.match(/L\.api\(/g)||[]).length;e.session+=(line.match(/sessionApi\(f, /g)||[]).length;byFn.set(fn,e);});
      const SESSION_FNS=['performFlush','handleConflict','performSubmit','performCollect','doUploadPhoto','doDeletePhoto','doSaveEdit','doDiscardPending'];
      const DIRECT_ALLOW=['load','confirmBatchArchive','loadDeleted','confirmRestore','openDetail','ensureDeviceDetail','deviceDetailListForView','openSubmittedEdit','openSubmittedEditById','confirmUnarchive','confirmDeleteSubmitted','fetchSheetForOpen','openNewSheetModal','sessionApi'];
      const bad=SESSION_FNS.filter(n=>!byFn.get(n)||byFn.get(n).api!==0||byFn.get(n).session<1);
      check('S-SESSION(48-R H1):会话函数零直接L.api且至少一处sessionApi',bad.length===0,bad.map(n=>[n,byFn.get(n)]));
      const direct=[...byFn].filter(([,e])=>e.api>0).map(([n])=>n).sort();
      check('S-SESSION(48-R H1):直接调L.api的函数恰为白名单',JSON.stringify(direct)===JSON.stringify([...DIRECT_ALLOW].sort()),direct);
      const aliasRefs=src.filter(l=>/L\.api(?!\s*\()/.test(l));
      check('S-SESSION(48-R2 L1):不带括号的L.api引用只在reqApi一行',aliasRefs.length===1&&aliasRefs[0].includes('const reqApi = activeForm ?'),aliasRefs);
      check('S-SESSION(48-R H1):删除草稿在有会话时经会话包装',src.some(l=>l.includes('const reqApi = activeForm ? (path, options) => sessionApi(activeForm, path, options) : L.api;'))&&(byFn.get('confirmDeleteDraftRow')||{}).api===0);
    }

    const buildSubmittedWithLeftovers=async(room,n)=>{
      const racks=[];for(let i=1;i<=n;i++)racks.push((await f.api('POST','/racks',{name:room+'-柜'+i,room,u_total:20})).body);
      await f.api('POST','',{category:'server',name:room+'-设备1',u_height:1,placement:{kind:'rack',rack_id:racks[0].id,u_start:1}});
      const sheet=(await f.api('POST','/inspections/sheets',{room_name:room},2)).body,detail=(await getSheet(sheet.id)).body;
      const items=detail.items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:it.item_key==='temperature'?22:45,note:null}:{id:it.id,result:'ok',number_value:null,note:null});
      const put=await f.api('PUT','/inspections/sheets/'+sheet.id,{expected_version:detail.version,items},2);assert.equal(put.status,200);
      for(const r of racks)assert.equal((await uploadApi(sheet.id,'rack_front',r.id,Buffer.concat([JPEG,Buffer.from('a'+r.id)]))).status,201);
      assert.equal((await f.api('POST','/inspections/sheets/'+sheet.id+'/submit',{expected_version:put.body.version},2)).status,200);
      const leftovers=[];for(const r of racks)leftovers.push((await uploadApi(sheet.id,'rack_front',r.id,Buffer.concat([JPEG,Buffer.from('l'+r.id)]))).body.photo);
      return {sheet,racks,leftovers:leftovers.sort((a,b)=>a.id-b.id)};
    };
    const openEditWithDecision=async(page,sheetId)=>{await page.locator('[data-insp-view="'+sheetId+'"]').click();await page.locator('#itlSheetEdit').click();await page.locator('#itlSheetExpandAll').waitFor();await expandInspectionForm(page);await page.locator('#itlPendingDecision').waitFor({timeout:5000});await expandInspectionForm(page);};

    // Y6（48-R H1）：丢弃（逐张 / 整批放弃修改）最后一个删除请求在途时，另一条请求 403 结束会话；删除随后成功返回，不得再发详情 GET。
    for(const mode of ['discard','abandon']){
      const y6=await buildSubmittedWithLeftovers('AuditY6'+mode,1);const py6=await openPage(2);let heldY6;
      try{
        await openEditWithDecision(py6.page,y6.sheet.id);
        const delPattern=mode==='discard'?'**/api/it-assets/inspections/sheets/'+y6.sheet.id+'/photos/'+y6.leftovers[0].id:'**/api/it-assets/inspections/sheets/'+y6.sheet.id+'/pending-photos';
        heldY6=await holdOperation(py6.page,delPattern,'DELETE',async route=>{const response=await route.fetch();await route.fulfill({response});});
        await py6.page.route(statsPattern,route=>route.request().method()==='GET'?forbid403(route):route.fallback());
        let getsAfter=0,released=false;py6.page.on('request',r=>{if(released&&r.url().endsWith('/inspections/sheets/'+y6.sheet.id)&&r.method()==='GET')getsAfter++;});
        const before=await py6.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y6.sheet.id);
        if(mode==='discard')await py6.page.locator('[data-pending-decision="discard"]').click();else await py6.page.locator('#itlEditDiscard').click();
        await reachedWithin(heldY6.entered,'Y6 '+mode+' delete');
        await startSideRequest(py6.page);await py6.page.waitForFunction(()=>window.ITLedger.state.level===null,undefined,{timeout:5000});
        released=true;heldY6.release();await waitCount(py6.page,'__inspPendingDiscardSettledBySheet',y6.sheet.id,before);
        check('Y6(48-R H1):'+mode+'前置——删除确已落库',(await getSheet(y6.sheet.id)).body.my_pending_photos.length===0);
        check('Y6(48-R H1):'+mode+'删除等待期间失权后零详情GET',getsAfter===0,getsAfter);
      }finally{await finishHeld(heldY6);await py6.ctx.close();}
    }

    // Y7（48-R M1）：两张残留，第一张删除成功、第二张失败，且校准重取也失败——界面仍按已确认的删除同步（残留计1张）。
    const y7=await buildSubmittedWithLeftovers('AuditY7NoCalibrate',2);const py7=await openPage(2);
    try{
      await openEditWithDecision(py7.page,y7.sheet.id);
      await py7.page.route('**/api/it-assets/inspections/sheets/'+y7.sheet.id+'/photos/'+y7.leftovers[1].id,route=>route.request().method()==='DELETE'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'LEDGER_INTERNAL',message:'boom'})}):route.fallback());
      await py7.page.route('**/api/it-assets/inspections/sheets/'+y7.sheet.id,route=>route.request().method()==='GET'?route.abort('failed'):route.fallback());
      const before=await py7.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y7.sheet.id);
      await py7.page.locator('[data-pending-decision="discard"]').click();await waitCount(py7.page,'__inspPendingDiscardSettledBySheet',y7.sheet.id,before);
      const serverPending=(await getSheet(y7.sheet.id)).body.my_pending_photos.map(p=>p.id);
      check('Y7(48-R M1):前置——服务端只剩第二张残留',serverPending.length===1&&serverPending[0]===y7.leftovers[1].id,serverPending);
      check('Y7(48-R M1):校准重取失败时界面仍按已确认删除计1张',(await py7.page.locator('#itlPendingDecision').innerText()).includes('有上次未保存的 1 项照片变更'));
      check('Y7(48-R M1):已删照片不再出现在编辑页',await py7.page.locator('[data-photo-id="'+y7.leftovers[0].id+'"]').count()===0);
    }finally{await py7.ctx.close();}

    // Y8（48-R M2）：两张残留，第二张删除在途时换号（同页改 localStorage、事件未达）——删除随后返回，共享层按 401 抛出；
    // 登记到原账号并分三段：已丢弃 1 张、1 张结果未能确认、余 0 张未发出。
    const y8=await buildSubmittedWithLeftovers('AuditY8Swap',2);const py8=await openPage(2);let heldY8;
    try{
      await openEditWithDecision(py8.page,y8.sheet.id);
      heldY8=await holdOperation(py8.page,'**/api/it-assets/inspections/sheets/'+y8.sheet.id+'/photos/'+y8.leftovers[1].id,'DELETE',async route=>{const response=await route.fetch();await route.fulfill({response});});
      const before=await py8.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y8.sheet.id);
      await py8.page.locator('[data-pending-decision="discard"]').click();await reachedWithin(heldY8.entered,'Y8 second delete');
      await py8.page.evaluate(()=>localStorage.setItem('token','fixture-1'));
      heldY8.release();await waitCount(py8.page,'__inspPendingDiscardSettledBySheet',y8.sheet.id,before);
      await py8.page.evaluate(()=>localStorage.setItem('token','fixture-2'));
      await py8.page.evaluate(()=>location.hash='racks');await py8.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      await py8.page.evaluate(()=>location.hash='inspections');
      const banner=await py8.page.locator('#itlUnsavedList [data-unsaved-sheet="'+y8.sheet.id+'"]').innerText({timeout:5000});
      check('Y8(48-R M2):等待中换号登记三段进度到原账号',banner.includes('已丢弃 1 张，1 张结果未能确认，余 0 张未丢弃'),banner);
    }finally{await finishHeld(heldY8);await py8.ctx.close();}

    // Y9（48-R2 M1）：两张残留，第一张删除成功、第二张失败；校准重取在途时换号——已确认进度仍登记到原账号。
    const y9=await buildSubmittedWithLeftovers('AuditY9Calib',2);const py9=await openPage(2);let heldY9;
    try{
      await openEditWithDecision(py9.page,y9.sheet.id);
      await py9.page.route('**/api/it-assets/inspections/sheets/'+y9.sheet.id+'/photos/'+y9.leftovers[1].id,route=>route.request().method()==='DELETE'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'LEDGER_INTERNAL',message:'boom'})}):route.fallback());
      heldY9=await holdOperation(py9.page,'**/api/it-assets/inspections/sheets/'+y9.sheet.id,'GET',async route=>{const response=await route.fetch();await route.fulfill({response});});
      const before=await py9.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y9.sheet.id);
      await py9.page.locator('[data-pending-decision="discard"]').click();await reachedWithin(heldY9.entered,'Y9 calibrate');
      await py9.page.evaluate(()=>localStorage.setItem('token','fixture-1'));
      heldY9.release();await waitCount(py9.page,'__inspPendingDiscardSettledBySheet',y9.sheet.id,before);
      await py9.page.unroute('**/api/it-assets/inspections/sheets/'+y9.sheet.id);
      await py9.page.evaluate(()=>localStorage.setItem('token','fixture-2'));
      await py9.page.evaluate(()=>location.hash='racks');await py9.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      await py9.page.evaluate(()=>location.hash='inspections');
      const banner=await py9.page.locator('#itlUnsavedList [data-unsaved-sheet="'+y9.sheet.id+'"]').innerText({timeout:5000});
      check('Y9(48-R2 M1):校准等待中换号仍登记已确认进度',banner.includes('已丢弃 1 张，余 1 张未丢弃'),banner);
    }finally{await finishHeld(heldY9);await py9.ctx.close();}

    // Y10（48-R2 M2）：删除已全部成功、仅详情重取在途时换号——没有未保存内容，不登记（逐张与整批两路径）。
    for(const mode of ['discard','abandon']){
      const y10=await buildSubmittedWithLeftovers('AuditY10'+mode,1);const py10=await openPage(2);let heldY10;
      try{
        await openEditWithDecision(py10.page,y10.sheet.id);
        heldY10=await holdOperation(py10.page,'**/api/it-assets/inspections/sheets/'+y10.sheet.id,'GET',async route=>{const response=await route.fetch();await route.fulfill({response});});
        const before=await py10.page.evaluate(id=>window.ITLedger.__inspPendingDiscardSettledBySheet.get(id)||0,y10.sheet.id);
        if(mode==='discard')await py10.page.locator('[data-pending-decision="discard"]').click();else await py10.page.locator('#itlEditDiscard').click();
        await reachedWithin(heldY10.entered,'Y10 '+mode+' refetch');
        await py10.page.evaluate(()=>localStorage.setItem('token','fixture-1'));
        heldY10.release();await waitCount(py10.page,'__inspPendingDiscardSettledBySheet',y10.sheet.id,before);
        await py10.page.unroute('**/api/it-assets/inspections/sheets/'+y10.sheet.id);
        await py10.page.evaluate(()=>localStorage.setItem('token','fixture-2'));
        await py10.page.evaluate(()=>location.hash='racks');await py10.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
        await py10.page.evaluate(()=>location.hash='inspections');await py10.page.locator('[data-insp-row="'+y10.sheet.id+'"]').waitFor({timeout:5000});
        check('Y10(48-R2 M2):'+mode+'前置——删除确已落库',(await getSheet(y10.sheet.id)).body.my_pending_photos.length===0);
        check('Y10(48-R2 M2):'+mode+'删除已完成时换号不登记',await py10.page.locator('#itlUnsavedList [data-unsaved-sheet="'+y10.sheet.id+'"]').count()===0);
      }finally{await finishHeld(heldY10);await py10.ctx.close();}
    }

    // Y3b（48-R rec）：Y3 的失败版本——离开后旧会话的冲刷本身遇 403，全文提示仍在，排队提交零 POST。
    const y3b=await createCompleteDraft('AuditY3bLeftFail');const py3b=await openPage(2);let heldY3b;
    try{
      let submitPosts=0;py3b.page.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+y3b.sheet.id+'/submit')&&r.method()==='POST')submitPosts++;});
      await py3b.page.locator('[data-insp-continue="'+y3b.sheet.id+'"]').click();await py3b.page.locator('#itlFormSubmit:not([disabled])').waitFor({timeout:5000});await expandInspectionForm(py3b.page);
      await py3b.page.locator('#itlFormRemark').fill('Y3b外审备注');
      heldY3b=await holdOperation(py3b.page,'**/api/it-assets/inspections/sheets/'+y3b.sheet.id,'PUT',forbid403);
      await recordNotices(py3b.page);
      const before=await py3b.page.evaluate(id=>window.ITLedger.__inspSubmitSettledBySheet.get(id)||0,y3b.sheet.id);
      await py3b.page.locator('#itlFormSubmit').click();await reachedWithin(heldY3b.entered,'Y3b flush');
      await py3b.page.evaluate(()=>location.hash='racks');await py3b.page.locator('.itl-rack-workspace').waitFor({timeout:5000});
      heldY3b.release();await waitCount(py3b.page,'__inspSubmitSettledBySheet',y3b.sheet.id,before);
      await waitNotice(py3b.page,['访问权限已变化。巡检单〈AuditY3bLeftFail','备注：Y3b外审备注（原因：编辑权限已变化）']);
      const history=await py3b.page.evaluate(()=>window.__noticeHistory);
      check('Y3b(48-R):离开后旧会话冲刷403全文仍在且提交零POST',submitPosts===0&&!history.some(t=>t.includes('未能提交')),{submitPosts,history});
    }finally{await finishHeld(heldY3b);await py3b.ctx.close();}
  }finally{if(browser)await browser.close();await f.close();}
  console.log('INSPECTION_PHOTO_BROWSER PASS='+pass+' FAIL=0');
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
