'use strict';
// C4：巡检台账（it-ledger-inspection-sheets.js）列表侧浏览器实测——字段、摘要行限制、actions驱动
// 按钮可见性、概览与页签、筛选、批量归档成功/409、已删除+恢复。填单/编辑/详情是C5范围，本文件只走
// 已有接口(POST /inspections/sheets 等)直接建单据，不经由浏览器表单。
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;const check=(n,v,d)=>{if(!v&&d!==undefined)console.error('DETAIL',n,JSON.stringify(d));assert.ok(v,n);pass++;console.log('[OK] '+n);};
const NUMBER_DEFAULT={temperature:22,humidity:45};
const MIN_JPEG_BYTES=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0xff,0xd9]);
async function main(){
 const f=await createFixture();console.log('ISOLATED_ARTIFACTS='+f.dir);let browser;
 async function makeRoom(roomName){const r=(await f.api('POST','/racks',{name:roomName+'-柜1',room:roomName,u_total:20})).body;await f.api('POST','',{category:'server',name:roomName+'-设备1',u_height:1,placement:{kind:'rack',rack_id:r.id,u_start:1}});return r;}
 const createSheet=(uid,roomName)=>f.api('POST','/inspections/sheets',{room_name:roomName},uid);
 const getSheet=(sheetId,uid)=>f.api('GET','/inspections/sheets/'+sheetId,undefined,uid);
 async function buildDraftSheet(roomName,ownerUid=2){await makeRoom(roomName);const created=await createSheet(ownerUid,roomName);assert.equal(created.status,201,'buildDraftSheet '+roomName+' '+JSON.stringify(created.body));return created.body;}
 function fillPayloadAllOk(items){return items.map(it=>(it.value_kind==='number'?{id:it.id,result:null,number_value:NUMBER_DEFAULT[it.item_key]??25,note:null}:{id:it.id,result:'ok',number_value:null,note:null}));}
 async function uploadPhoto(sheetId,slot,targetId,uid){const fd=new FormData();fd.append('slot',slot);fd.append('target_id',String(targetId));fd.append('file',new Blob([MIN_JPEG_BYTES],{type:'image/jpeg'}),'p.jpg');const resp=await fetch(f.base+'/api/it-assets/inspections/sheets/'+sheetId+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-'+uid},body:fd});return {status:resp.status,body:await resp.json()};}
 async function uploadAllRackFrontPhotos(sheetId,scope,uid){for(const r of scope.racks){const res=await uploadPhoto(sheetId,'rack_front',r.id,uid);assert.equal(res.status,201,'uploadAllRackFrontPhotos '+JSON.stringify(res.body));}}
 async function buildSubmittedSheet(roomName,ownerUid,markBadFirst){
  const created=await buildDraftSheet(roomName,ownerUid);
  const detail=await getSheet(created.id,ownerUid);
  const items=fillPayloadAllOk(detail.body.items);
  let badItemId=null;
  if(markBadFirst){const checkItem=detail.body.items.find(it=>it.value_kind!=='number');const target=items.find(x=>x.id===checkItem.id);target.result='bad';target.note='巡检发现异常，已记录待处理。';badItemId=checkItem.id;}
  const put=await f.api('PUT','/inspections/sheets/'+created.id,{expected_version:created.version,items},ownerUid);
  assert.equal(put.status,200,'buildSubmittedSheet put '+roomName+' '+JSON.stringify(put.body));
  await uploadAllRackFrontPhotos(created.id,created.scope,ownerUid);
  if(badItemId!==null)await uploadPhoto(created.id,'item',badItemId,ownerUid);
  const submit=await f.api('POST','/inspections/sheets/'+created.id+'/submit',{expected_version:put.body.version},ownerUid);
  assert.equal(submit.status,200,'buildSubmittedSheet submit '+roomName+' '+JSON.stringify(submit.body));
  return submit.body;
 }
 try{
  const draftMine=await buildDraftSheet('S-Room1',2);
  // L6（C4b顺手修）：给这张草稿真实填一项 + 传一张照片，让"summary行不泄露"断言有判别力——不是"因为
  // 什么都没填所以自然什么都不泄露"这种没有判别力的假阳性。
  {
    const detail0=await getSheet(draftMine.id,2);
    const oneItem=detail0.body.items.find(it=>it.value_kind!=='number');
    const fillResp=await f.api('PUT','/inspections/sheets/'+draftMine.id,{expected_version:draftMine.version,items:[{id:oneItem.id,result:'ok',number_value:null,note:null}]},2);
    assert.equal(fillResp.status,200,'draftMine部分填写 '+JSON.stringify(fillResp.body));
    await uploadPhoto(draftMine.id,'rack_front',detail0.body.scope.racks[0].id,2);
  }
  const submittedBad=await buildSubmittedSheet('S-Room2',2,true);
  const submittedOk=await buildSubmittedSheet('S-Room3',2,false);
  const staleTarget=await buildSubmittedSheet('S-Room4',2,false);
  const toDelete=await buildSubmittedSheet('S-Room5',2,false);
  // M4（C4b必修）：混批用的合格单——与staleTarget一起提交409，证明all-or-nothing真的没落任何一张
  // （不是只测"唯一那张不合格的没落"，还要测"混在同一批里的合格单也没被误落"）。
  const mixValid=await buildSubmittedSheet('S-Room6',2,false);
  // M5（C4b必修）：写权限非管理员视角用——writeOwn是该写权限用户自己的已提交单（应看到删除、看不到
  // 归档批量勾选）；draftOther是管理员的草稿，对写权限用户而言是"他人草稿"（应只见摘要无按钮）。
  const writeOwn=await buildSubmittedSheet('S-Room7',2,false);
  const draftOther=await buildDraftSheet('S-Room8',1);
  const delResp=await f.api('DELETE','/inspections/sheets/'+toDelete.id,{expected_version:toDelete.version,reason:'测试删除'},1);
  assert.equal(delResp.status,200,'delete toDelete '+JSON.stringify(delResp.body));
  const statsApi=(await f.api('GET','/inspections/sheets/stats',undefined,1)).body;
  check('接口统计四项均为非负整数且待归档≥3(bad/ok/stale三张已提交未归档)',Number.isInteger(statsApi.submitted_month)&&Number.isInteger(statsApi.abnormal_month)&&Number.isInteger(statsApi.drafts)&&statsApi.pending_archive>=3,statsApi);

  browser=await chromium.launch({headless:true});
  // A) 管理员视角：字段、概览与页签、筛选、批量归档成功、409、已删除+恢复、actions驱动按钮可见性。
  const ca=await browser.newContext();await ca.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pa=await ca.newPage();const errorsA=[];pa.on('pageerror',e=>errorsA.push(e.message));
  await pa.goto(f.base+'/IT_Ledger.html#inspections');await pa.locator('#itlInspRows tr').first().waitFor();
  const rowText=id=>pa.locator('[data-insp-row="'+id+'"]').innerText();
  check('异常单行显示异常徽章与数量',(await rowText(submittedBad.id)).includes('异常 1 项'));
  check('无异常单行显示无异常',(await rowText(submittedOk.id)).includes('无异常'));
  const filledCell=await pa.locator('[data-insp-row="'+submittedBad.id+'"] td').nth(6).innerText();
  check('full行已填/照片列同时含已填总数与照片已传应传',/\d+\/\d+/.test(filledCell)&&filledCell.includes('照片'),filledCell);
  check('管理员视角看到批量归档与已删除入口',await pa.locator('#itlInspBatchArchive').count()===1&&await pa.locator('#itlInspOpenDeleted').count()===1);
  await pa.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
  const overviewApi=(await f.api('GET','/inspections/sheets/overview',undefined,1)).body;
  check('概览机房数量与接口全等',await pa.locator('[data-insp-room]').count()===overviewApi.rooms.length);
  check('页签数量与接口全等',JSON.stringify(await pa.locator('#itlInspStatusTabs b').allInnerTexts())===JSON.stringify(['7','2','5','1','0']));
  // 房间筛选
  await pa.locator('#itlInspRoomFilter').selectOption('S-Room2');await pa.waitForFunction(()=>document.querySelectorAll('#itlInspRows [data-insp-row]').length===1);
  check('房间筛选只剩本机房单据',await pa.locator('#itlInspRows [data-insp-row]').count()===1&&await pa.locator('[data-insp-row="'+submittedBad.id+'"]').count()===1);
  await pa.locator('#itlInspRoomFilter').selectOption('');await pa.locator('[data-insp-row="'+draftMine.id+'"]').waitFor();
  // 状态筛选：草稿——M5夹具新增了draftOther(管理员自己的草稿)，此刻管理员视角下草稿应为2张
  // （draftMine + draftOther，管理员看自己的draftOther是full可见度，不是summary）。
  await pa.locator('[data-insp-status="draft"]').click();await pa.waitForFunction(()=>document.querySelectorAll('#itlInspRows [data-insp-row]').length===2);
  check('状态筛选=草稿只剩草稿单据(draftMine+管理员自己的draftOther)',await pa.locator('[data-insp-row="'+draftMine.id+'"]').count()===1&&await pa.locator('[data-insp-row="'+draftOther.id+'"]').count()===1);
  await pa.locator('[data-insp-status=""]').click();await pa.locator('[data-insp-row="'+submittedBad.id+'"]').waitFor();
  // 批量归档成功：勾选 bad + ok 两张已提交单
  await pa.locator('[data-insp-check="'+submittedBad.id+'"]').check();await pa.locator('[data-insp-check="'+submittedOk.id+'"]').check();
  check('批量归档按钮显示已勾选数',await pa.locator('#itlInspBatchArchive').innerText()==='批量归档（2）');
  await pa.locator('#itlInspBatchArchive').click();await pa.locator('#itlModal.open').waitFor();
  const archivePosted=pa.waitForResponse(r=>r.url().endsWith('/inspections/sheets/archive')&&r.request().method()==='POST');
  await pa.locator('#itlSubmit').click();const archiveResp=await archivePosted;
  check('批量归档200',archiveResp.status()===200);
  await pa.waitForFunction(id=>{const row=document.querySelector('[data-insp-row="'+id+'"]');return row&&row.innerText.includes('已归档');},submittedBad.id);
  check('归档成功后两行状态变已归档',(await rowText(submittedBad.id)).includes('已归档')&&(await rowText(submittedOk.id)).includes('已归档'));
  // L5（C4b顺手修）：成功路径读库——批量归档成功后读回库内状态确实为archived，且概览与页签"待归档"随之
  // 减少（减少数=本批归档张数）。
  const dbAfterArchiveOk=await f.all('SELECT id,status FROM it_inspection_sheets WHERE id IN (?,?)',[submittedBad.id,submittedOk.id]);
  check('批量归档成功后库内状态确实是archived',dbAfterArchiveOk.every(r=>r.status==='archived'),dbAfterArchiveOk);
  const statsApiAfterArchive=(await f.api('GET','/inspections/sheets/stats',undefined,1)).body;
  check('批量归档成功后概览与页签待归档随之减少2(接口重取)',statsApiAfterArchive.pending_archive===statsApi.pending_archive-2,{before:statsApi.pending_archive,after:statsApiAfterArchive.pending_archive});
  // 状态筛选：已归档（覆盖刚归档的两张）
  await pa.locator('[data-insp-status="archived"]').click();await pa.waitForFunction(()=>document.querySelectorAll('#itlInspRows [data-insp-row]').length>=2);
  check('状态筛选=已归档能看到刚归档的单据',await pa.locator('[data-insp-row="'+submittedBad.id+'"]').count()===1&&await pa.locator('[data-insp-row="'+submittedOk.id+'"]').count()===1);
  // L5：断言列表行全部为已归档，没有别的状态混进来（不是只挑两条已知行看有没有出现，是看筛选结果
  // 整体纯不纯）。
  const archivedFilterRowTexts=await pa.evaluate(()=>[...document.querySelectorAll('#itlInspRows [data-insp-row]')].map(r=>r.innerText));
  check('已归档筛选下列表行全部为已归档状态(无其它状态混入)',archivedFilterRowTexts.length>0&&archivedFilterRowTexts.every(t=>t.includes('已归档')),archivedFilterRowTexts);
  await pa.locator('[data-insp-status=""]').click();await pa.locator('[data-insp-row="'+staleTarget.id+'"]').waitFor();
  // M4（C4b必修）：批量归档409全有或全无——混一张合格单(mixValid)+一张版本过期单(staleTarget)一起
  // 提交，409后从库里读回确认两张都未被归档（合格单的version也未变），界面逐条提示problems。
  await f.run('UPDATE it_inspection_sheets SET version=version+1 WHERE id=?',[staleTarget.id]);
  await pa.locator('[data-insp-check="'+staleTarget.id+'"]').check();
  await pa.locator('[data-insp-check="'+mixValid.id+'"]').check();
  await pa.locator('#itlInspBatchArchive').click();await pa.locator('#itlModal.open').waitFor();
  const conflictPosted=pa.waitForResponse(r=>r.url().endsWith('/inspections/sheets/archive')&&r.request().method()==='POST');
  await pa.locator('#itlSubmit').click();const conflictResp=await conflictPosted;
  check('批量归档409',conflictResp.status()===409);
  await pa.locator('#itlNotice').waitFor();
  check('409提示带单据编号与不合格理由',(await pa.locator('#itlNotice').innerText()).includes('#'+staleTarget.id)&&(await pa.locator('#itlNotice').innerText()).includes('版本不符'));
  check('409之后单据仍是提交状态未被归档',(await rowText(staleTarget.id)).includes('已提交'));
  check('409之后混批的合格单也仍是提交状态未被归档(全有或全无)',(await rowText(mixValid.id)).includes('已提交'));
  const dbAfterConflictMix=(await f.all('SELECT status,version FROM it_inspection_sheets WHERE id=?',[mixValid.id]))[0];
  check('409之后混批合格单库内status未变submitted且version未变(全有或全无)',dbAfterConflictMix.status==='submitted'&&dbAfterConflictMix.version===mixValid.version,dbAfterConflictMix);
  const dbAfterConflict=(await f.all('SELECT status FROM it_inspection_sheets WHERE id=?',[staleTarget.id]))[0];
  check('409之后库内状态确实仍是submitted(all-or-nothing)',dbAfterConflict.status==='submitted',dbAfterConflict);
  // M1（C4c采纳）子例①：409后不保留原勾选——上面staleTarget/mixValid两张此刻应已被清空勾选，批量
  // 按钮随之隐藏；提示文案里带上"部分单据已变化，请重新勾选核对"（附加在原有409详情之后）。
  check('M1:409后勾选已清空,批量归档按钮隐藏',await pa.locator('#itlInspBatchArchive').isHidden());
  check('M1:409后提示追加"部分单据已变化，请重新勾选核对"',(await pa.locator('#itlNotice').innerText()).includes('部分单据已变化，请重新勾选核对'));
  // M1（C4c采纳）子例②：普通刷新（本视图唯一的刷新方式——切页签再切回，见文件头注释）时，若已勾选单
  // 据的version与勾选时记录的不同（后台已改动），取消该单勾选并提示；不是409这条路径触发的清空。
  await pa.locator('[data-insp-check="'+writeOwn.id+'"]').check();
  check('M1子例②:漂移测试前先勾选成功',await pa.locator('#itlInspBatchArchive').innerText()==='批量归档（1）');
  await f.run('UPDATE it_inspection_sheets SET version=version+1 WHERE id=?',[writeOwn.id]);
  await pa.evaluate(()=>{location.hash='racks';});await pa.locator('.itl-rack-workspace').waitFor();
  await pa.evaluate(()=>{location.hash='inspections';});await pa.locator('[data-insp-row="'+writeOwn.id+'"]').waitFor();
  check('M1子例②:version漂移后该单据的勾选框已被自动取消',await pa.locator('[data-insp-check="'+writeOwn.id+'"]').isChecked()===false);
  check('M1子例②:漂移取消勾选后提示"已取消勾选，请重新核对"',(await pa.locator('#itlNotice').innerText()).includes('已取消勾选，请重新核对'));
  // 已删除 + 恢复
  await pa.locator('#itlInspOpenDeleted').click();await pa.locator('#itlInspBackToList').waitFor();
  check('已删除列表出现被删单据',await pa.locator('tbody tr').filter({hasText:'S-Room5'}).count()===1);
  const restorePosted=pa.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+toDelete.id+'/restore')&&r.request().method()==='POST');
  await pa.locator('[data-insp-restore="'+toDelete.id+'"]').click();await pa.locator('#itlModal.open').waitFor();await pa.locator('#itlSubmit').click();
  const restoreResp=await restorePosted;check('恢复200',restoreResp.status()===200);
  await pa.waitForFunction(()=>!document.body.innerText.includes('S-Room5'));
  check('恢复后已删除列表不再出现该单据',await pa.locator('tbody tr').filter({hasText:'S-Room5'}).count()===0);
  await pa.locator('#itlInspBackToList').click();await pa.locator('[data-insp-row="'+toDelete.id+'"]').waitFor();
  check('恢复后回到台账列表且状态是已提交',(await rowText(toDelete.id)).includes('已提交'));
  const dbAfterRestore=(await f.all('SELECT status,deleted_at FROM it_inspection_sheets WHERE id=?',[toDelete.id]))[0];
  check('恢复后库内deleted_at清空且status回submitted',dbAfterRestore.status==='submitted'&&dbAfterRestore.deleted_at===null,dbAfterRestore);
  // C5a 段3落地后订正：新增巡检打开真实的机房选择弹窗（不再是占位toast，见
  // verify-it-ledger-inspection-sheet-form-browser.js 块 V/W 的完整覆盖，这里只做"入口没退化成占位"
  // 的最小烟雾断言）。
  await pa.locator('#itlInspNew').click();await pa.locator('#itlModal.open').waitFor();
  check('新增巡检按钮打开真实的机房选择弹窗',(await pa.locator('#itlModalTitle').innerText())==='新增巡检');
  await pa.locator('#itlModalCancel').click();
  check('取消后弹窗关闭,不残留',await pa.locator('#itlModal.open').count()===0);
  // M5（C4b必修）：管理员视角额外两条——草稿行的批量勾选框disabled（草稿没有archive这个action）；
  // 已归档行的操作列只有"撤回归档"一个按钮（没有查看/编辑/删除等其它按钮）。
  const draftCheckboxA=pa.locator('[data-insp-check="'+draftMine.id+'"]');
  check('M5管理员视角:草稿行批量勾选框disabled',await draftCheckboxA.isDisabled());
  // 已归档行常驻一个"查看"链接（非草稿状态都有，方案既有约定，不是本批范围）+ actions驱动的
  // "撤回归档"——按钮集合应恰好是这两个，不多不少（没有删除/编辑/继续填写等本不该出现在已归档行的
  // 按钮）。
  const archivedRowButtonTexts=(await pa.locator('[data-insp-row="'+submittedBad.id+'"] .itl-actions button').allInnerTexts()).sort();
  check('M5管理员视角:已归档行按钮集合恰为{查看,撤回归档}(全等,不多不少)',JSON.stringify(archivedRowButtonTexts)===JSON.stringify(['撤回归档','查看']),archivedRowButtonTexts);
  check('浏览器无未捕获异常(管理员视角)',errorsA.length===0);
  await ca.close();

  // B) 只读用户（fixture-3，read级别，非owner非admin）视角：actions驱动令sheetActions()恒返回[]，
  // 看不到批量归档与已删除入口；查看他人草稿只拿到summary可见度，字段受限。
  const cb=await browser.newContext();await cb.addInitScript(()=>localStorage.setItem('token','fixture-3'));const pb=await cb.newPage();const errorsB=[];pb.on('pageerror',e=>errorsB.push(e.message));
  await pb.goto(f.base+'/IT_Ledger.html#inspections');await pb.locator('[data-insp-row="'+staleTarget.id+'"]').waitFor();
  check('只读用户看不到批量归档与已删除入口',await pb.locator('#itlInspBatchArchive').count()===0&&await pb.locator('#itlInspOpenDeleted').count()===0);
  check('只读用户没有勾选框列',await pb.locator('[data-insp-check]').count()===0);
  // L1（C4b顺手修）：新增巡检按钮按L.canWrite()决定是否渲染——只读用户不该看到它。
  check('L1只读用户看不到新增巡检按钮',await pb.locator('#itlInspNew').count()===0);
  // draftMine 对只读用户是 summary：状态显示"填写中"而非真实status文案，结果列显示—，操作列显示"他人草稿"
  const draftRowB=await pb.locator('[data-insp-row="'+draftMine.id+'"]').innerText();
  check('摘要行状态固定显示填写中',draftRowB.includes('填写中'));
  check('摘要行结果列不泄露真实结果',draftRowB.includes('—'));
  check('摘要行操作列只显示他人草稿且无任何按钮',draftRowB.includes('他人草稿')&&await pb.locator('[data-insp-row="'+draftMine.id+'"] button').count()===0);
  // L6（C4b顺手修）：summary行不泄露照片数/已修改/异常数——draftMine此刻真的填了一项、传了一张照片
  // （见夹具准备），断言才有判别力：不是"因为什么都没填所以自然什么都不泄露"。
  check('摘要行不泄露照片已传/应传计数',!draftRowB.includes('照片'),draftRowB);
  check('摘要行不泄露"已修改"编辑次数标记',!draftRowB.includes('已修改'),draftRowB);
  check('摘要行不泄露异常项数字样',!draftRowB.includes('异常'),draftRowB);
  // L6（API 层）：不只测前端渲染有没有把字段画出来——直接核对 GET /inspections/sheets 的原始 JSON，
  // summary 行对象本身就不含这些键（不是"含了但前端没画"这种更脆弱的保证）。
  const listAsReadonly=(await f.api('GET','/inspections/sheets',undefined,3)).body.items;
  const draftMineRowApi=listAsReadonly.find(r=>r.id===draftMine.id);
  check('summary行API响应本身不含photos_uploaded/photos_expected/edit_count/status/version/abnormal键',
    draftMineRowApi&&draftMineRowApi.visibility==='summary'
    &&!Object.hasOwn(draftMineRowApi,'photos_uploaded')&&!Object.hasOwn(draftMineRowApi,'photos_expected')
    &&!Object.hasOwn(draftMineRowApi,'edit_count')&&!Object.hasOwn(draftMineRowApi,'status')
    &&!Object.hasOwn(draftMineRowApi,'version')&&!Object.hasOwn(draftMineRowApi,'abnormal'),
    draftMineRowApi);
  check('浏览器无未捕获异常(只读视角)',errorsB.length===0);
  await cb.close();

  // C) 写权限非管理员视角（fixture-2，与前面草稿/单据的owner同一个人，write级别非admin）——M5必修。
  // 对自己已提交的单(writeOwn)：能看到删除，看不到批量归档相关UI(整列勾选框只对admin渲染)；
  // 对他人(admin)的草稿(draftOther)：只见摘要、无任何按钮。
  const cc=await browser.newContext();await cc.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pc=await cc.newPage();const errorsC=[];pc.on('pageerror',e=>errorsC.push(e.message));
  await pc.goto(f.base+'/IT_Ledger.html#inspections');await pc.locator('[data-insp-row="'+writeOwn.id+'"]').waitFor();
  check('M5写权限视角:看不到批量归档与已删除入口(非管理员)',await pc.locator('#itlInspBatchArchive').count()===0&&await pc.locator('#itlInspOpenDeleted').count()===0);
  check('M5写权限视角:没有勾选框列(整列只对admin渲染)',await pc.locator('[data-insp-check]').count()===0);
  // L1（C4b顺手修）：写权限（非只读）用户能看到新增巡检按钮。
  check('L1写权限视角看到新增巡检按钮',await pc.locator('#itlInspNew').count()===1);
  const writeOwnRowText=await pc.locator('[data-insp-row="'+writeOwn.id+'"]').innerText();
  check('M5写权限视角:自己已提交的单能看到删除按钮',await pc.locator('[data-insp-row="'+writeOwn.id+'"] button').filter({hasText:'删除'}).count()===1,writeOwnRowText);
  // 注意：状态徽章文案本身含"已提交（待归档）"，不能直接断言整行文本不含"归档"二字——精确到按钮
  // 文案层面：归档是纯admin批量动作，这一行不该出现任何名字带"归档"的按钮（撤回归档同样只对admin）。
  const writeOwnButtonTexts=await pc.locator('[data-insp-row="'+writeOwn.id+'"] button').allInnerTexts();
  check('M5写权限视角:自己已提交的单没有任何"归档"相关按钮(归档/撤回归档都是admin专属)',writeOwnButtonTexts.every(t=>!t.includes('归档')),writeOwnButtonTexts);
  const draftOtherRowText=await pc.locator('[data-insp-row="'+draftOther.id+'"]').innerText();
  check('M5写权限视角:他人(管理员)的草稿只见摘要,状态显示填写中',draftOtherRowText.includes('填写中'));
  check('M5写权限视角:他人草稿操作列只显示"他人草稿"且无任何按钮',draftOtherRowText.includes('他人草稿')&&await pc.locator('[data-insp-row="'+draftOther.id+'"] button').count()===0,draftOtherRowText);
  check('浏览器无未捕获异常(写权限非管理员视角)',errorsC.length===0);
  await cc.close();

  // C4c批次夹具准备（放在这里而不是文件顶部：block A 前面有两处对statsApi做精确相等断言，这里新建的
  // 单据都会计入pending_archive，早建会把那两条断言算错）。
  const h1ArchiveTarget=await buildSubmittedSheet('S-Room9',2,false);
  const h1RestoreTargetSubmit=await buildSubmittedSheet('S-Room10',2,false);
  const delH1Restore=await f.api('DELETE','/inspections/sheets/'+h1RestoreTargetSubmit.id,{expected_version:h1RestoreTargetSubmit.version,reason:'H1案例②预备删除'},1);
  assert.equal(delH1Restore.status,200,'delete h1RestoreTargetSubmit '+JSON.stringify(delH1Restore.body));
  const h1RestoreTarget=h1RestoreTargetSubmit;
  const m2RestoreTarget=await buildSubmittedSheet('S-Room14',2,false);
  const delM2=await f.api('DELETE','/inspections/sheets/'+m2RestoreTarget.id,{expected_version:m2RestoreTarget.version,reason:'M2测试预备删除'},1);
  assert.equal(delM2.status,200,'delete m2RestoreTarget '+JSON.stringify(delM2.body));
  const m2VersionAtDelete=delM2.body.version;
  // L1夹具：各建一个机柜+一张草稿单，再把机柜删掉（此时机柜空,可删）——留下"只在巡检单room_name里
  // 还留着、L.state.racks里已查不到"的历史机房。
  const l1Rack1=(await f.api('POST','/racks',{name:'S-Room11-柜1',room:'S-Room11',u_total:20})).body;
  await createSheet(2,'S-Room11');
  const delL1Rack1=await f.api('DELETE','/racks/'+l1Rack1.id,undefined,1);
  assert.equal(delL1Rack1.status,200,'delete l1Rack1 '+JSON.stringify(delL1Rack1.body));
  const l1Rack2=(await f.api('POST','/racks',{name:'S-Room12-柜1',room:'S-Room12',u_total:20})).body;
  await createSheet(2,'S-Room12');
  const delL1Rack2=await f.api('DELETE','/racks/'+l1Rack2.id,undefined,1);
  assert.equal(delL1Rack2.status,200,'delete l1Rack2 '+JSON.stringify(delL1Rack2.body));

  // C4d 夹具：子视图漂移测试（块 J/K）各用一张独立单据，不与①②案例的 h1ArchiveTarget/h1RestoreTarget
  // 混用（那两张单据的批量归档/恢复已经在①②里被消费掉，状态已变）。
  const subviewArchiveTarget=await buildSubmittedSheet('S-Room15',2,false);
  const subviewRestoreSubmit=await buildSubmittedSheet('S-Room16',2,false);
  const delSubviewRestore=await f.api('DELETE','/inspections/sheets/'+subviewRestoreSubmit.id,{expected_version:subviewRestoreSubmit.version,reason:'C4d子视图测试预备删除'},1);
  assert.equal(delSubviewRestore.status,200,'delete subviewRestoreSubmit '+JSON.stringify(delSubviewRestore.body));
  const subviewRestoreTarget=subviewRestoreSubmit;
  // 注意：S-Room17（块 M 的夹具）不在这里建——块 M 要验证的场景是"该机房在页面首次未筛选加载
  // 之后才出现"，如果提前建在这里，块 M 那个 context 的 goto() 触发的首次无筛选 load() 会把它顺手并进
  // knownRooms（旧的 L1 逻辑就够用），变异测试会证明这条断言没有判别力（本段已实测踩过一次这个坑）。
  // 建在块 M 内部、goto() 之后。

  // D) M1（C4b必修）/ H2（C4c必修，加固等待信号）：迟到加载不覆盖已切走的页签——拦住 GET
  // /inspections/sheets（列表请求），进入巡检页签后切到"机房"，放行响应后断言内容区仍是机房视图（有
  // 机房视图标志元素、无台账元素）。H2：旧版只等一个不相关的sentinel请求到达来推断"响应大概处理完
  // 了"，不能证明页面确实已经处理完这条被拦截的响应。改为两步：先await这条被拦截请求自己的
  // waitForResponse（确认浏览器确实收到了它），再等页面侧__inspLoadSettled计数增加（确认load()的
  // 丢弃/渲染判定已经跑完），不再靠旁路请求猜顺序。
  const cd=await browser.newContext();await cd.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pd=await cd.newPage();const errorsD=[];pd.on('pageerror',e=>errorsD.push(e.message));
  let releaseSheetsList,enteredSheetsList;
  const enteredSheetsListP=new Promise(r=>enteredSheetsList=r),heldSheetsListP=new Promise(r=>releaseSheetsList=r);
  await pd.route('**/api/it-assets/inspections/sheets',async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    const response=await route.fetch();enteredSheetsList();await heldSheetsListP;await route.fulfill({response});
  });
  await pd.goto(f.base+'/IT_Ledger.html#inspections');
  await enteredSheetsListP;
  const settledBaselineD=await pd.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pd.evaluate(()=>{location.hash='racks';});
  await pd.locator('.itl-rack-workspace').waitFor();
  const sheetsListRespondedD=pd.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets')&&r.request().method()==='GET');
  releaseSheetsList();
  await sheetsListRespondedD;
  await pd.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineD);
  check('M1:迟到的巡检台账响应不覆盖已切到的机房视图(有机房标志元素)',await pd.locator('.itl-rack-workspace').count()===1);
  check('M1:迟到的巡检台账响应不覆盖已切到的机房视图(无台账元素)',await pd.locator('#itlInspRows').count()===0&&await pd.locator('#itlInspOverview').count()===0);
  check('M1:迟到的巡检台账响应不覆盖已切到的机房视图(无"正在读取巡检台账"文字)',!(await pd.locator('body').innerText()).includes('正在读取巡检台账'));
  check('浏览器无未捕获异常(M1视角)',errorsD.length===0);
  await cd.close();

  // E) H1案例①（C4c必修；注释按 codex 40-R recommendations#2 订正——C4d）：批量归档请求挂起期间用户
  // 切到"机房"页签——放行归档响应后，内容区仍是机房视图，不被写请求完成后的重载覆盖。等待信号同D：
  // 先await归档请求自己的响应，再等__inspLoadSettled增加。**订正**：这条用例只证明"最终页面没被覆盖"
  // 这个端到端结果，不能证明是 confirmBatchArchive 里哪一层挡住的——切到"机房"已经让 L.state.tab
  // 不等于'inspections'，此时哪怕只删掉 confirmBatchArchive 自己的判断（让它总是调 load()），
  // load()入口那道"tab!=='inspections'即return"的内层闸依然会挡住覆盖，这条用例照样绿（真正单独
  // 证明内层闸存在的是块 I 的"H1直测"、块 L 的"已删除视图直测"）。这条用例真正独有的判别力是块 J
  // （子视图漂移：仍在巡检页签，只是从列表切到已删除）覆盖不到的"切到了别的页签"这个更基础的分支，
  // 与块 J 互补而非重复（本例tab已变，confirmBatchArchive现在走stillSameSubview()判假的"跳过
  // load()"分支，那个分支也会自增同一个计数，见it-ledger-inspection-sheets.js confirmBatchArchive
  // 内的注释）。
  const ce=await browser.newContext();await ce.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pe=await ce.newPage();const errorsE=[];pe.on('pageerror',e=>errorsE.push(e.message));
  await pe.goto(f.base+'/IT_Ledger.html#inspections');
  await pe.locator('[data-insp-row="'+h1ArchiveTarget.id+'"]').waitFor();
  await pe.locator('[data-insp-check="'+h1ArchiveTarget.id+'"]').check();
  await pe.locator('#itlInspBatchArchive').click();await pe.locator('#itlModal.open').waitFor();
  let releaseArchive,enteredArchive;
  const enteredArchiveP=new Promise(r=>enteredArchive=r),heldArchiveP=new Promise(r=>releaseArchive=r);
  await pe.route('**/api/it-assets/inspections/sheets/archive',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredArchive();await heldArchiveP;await route.fulfill({response});
  });
  await pe.locator('#itlSubmit').click();
  await enteredArchiveP;
  await pe.evaluate(()=>{location.hash='racks';});
  await pe.locator('.itl-rack-workspace').waitFor();
  const settledBaselineE=await pe.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const archiveRespondedE=pe.waitForResponse(r=>r.url().endsWith('/inspections/sheets/archive')&&r.request().method()==='POST');
  releaseArchive();
  await archiveRespondedE;
  await pe.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineE);
  check('H1案例①:批量归档完成后不覆盖已切到的机房视图(有机房标志元素)',await pe.locator('.itl-rack-workspace').count()===1);
  check('H1案例①:批量归档完成后不覆盖已切到的机房视图(无台账元素)',await pe.locator('#itlInspRows').count()===0&&await pe.locator('#itlInspOverview').count()===0);
  check('H1案例①:批量归档完成后不覆盖已切到的机房视图(无"正在读取巡检台账"文字)',!(await pe.locator('body').innerText()).includes('正在读取巡检台账'));
  check('浏览器无未捕获异常(H1案例①)',errorsE.length===0);
  await ce.close();

  // F) H1案例②（C4c必修）：恢复请求挂起期间用户切到"机房"页签——同案例①，释放后内容区仍是机房视图。
  // 同案例①的订正同样适用：这条只证明端到端结果，不单独证明是哪层闸挡住的（块 I/L 才是）。
  const cf=await browser.newContext();await cf.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pf=await cf.newPage();const errorsF=[];pf.on('pageerror',e=>errorsF.push(e.message));
  await pf.goto(f.base+'/IT_Ledger.html#inspections');
  await pf.locator('#itlInspOpenDeleted').click();await pf.locator('#itlInspBackToList').waitFor();
  await pf.locator('[data-insp-restore="'+h1RestoreTarget.id+'"]').waitFor();
  await pf.locator('[data-insp-restore="'+h1RestoreTarget.id+'"]').click();await pf.locator('#itlModal.open').waitFor();
  let releaseRestore,enteredRestore;
  const enteredRestoreP=new Promise(r=>enteredRestore=r),heldRestoreP=new Promise(r=>releaseRestore=r);
  await pf.route('**/api/it-assets/inspections/sheets/'+h1RestoreTarget.id+'/restore',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredRestore();await heldRestoreP;await route.fulfill({response});
  });
  await pf.locator('#itlSubmit').click();
  await enteredRestoreP;
  await pf.evaluate(()=>{location.hash='racks';});
  await pf.locator('.itl-rack-workspace').waitFor();
  const settledBaselineF=await pf.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const restoreRespondedF=pf.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+h1RestoreTarget.id+'/restore')&&r.request().method()==='POST');
  releaseRestore();
  await restoreRespondedF;
  await pf.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineF);
  check('H1案例②:恢复完成后不覆盖已切到的机房视图(有机房标志元素)',await pf.locator('.itl-rack-workspace').count()===1);
  check('H1案例②:恢复完成后不覆盖已切到的机房视图(无已删除台账元素)',await pf.locator('#itlInspBackToList').count()===0);
  check('H1案例②:恢复完成后不覆盖已切到的机房视图(无"正在读取已删除的巡检记录"文字)',!(await pf.locator('body').innerText()).includes('正在读取已删除的巡检记录'));
  check('浏览器无未捕获异常(H1案例②)',errorsF.length===0);
  await cf.close();

  // G) M2（C4c采纳）：恢复撞409（SHEET_VERSION_CONFLICT）——关闭弹窗、提示冲突、重载已删除列表；用
  // 重载后拿到的新version重试应当成功（与C4b的404分支同一处理路径）。
  const cg=await browser.newContext();await cg.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pg=await cg.newPage();const errorsG=[];pg.on('pageerror',e=>errorsG.push(e.message));
  await pg.goto(f.base+'/IT_Ledger.html#inspections');
  await pg.locator('#itlInspOpenDeleted').click();await pg.locator('#itlInspBackToList').waitFor();
  await pg.locator('[data-insp-restore="'+m2RestoreTarget.id+'"]').waitFor();
  // 页面已经把这一行连同此刻的version渲染进DOM之后，后台再把version改掉，制造"点击恢复时version已
  // 过期"的冲突（不是删除本身导致的冲突）。
  await f.run('UPDATE it_inspection_sheets SET version=version+1 WHERE id=?',[m2RestoreTarget.id]);
  await pg.locator('[data-insp-restore="'+m2RestoreTarget.id+'"]').click();await pg.locator('#itlModal.open').waitFor();
  const restoreConflictPostedG=pg.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+m2RestoreTarget.id+'/restore')&&r.request().method()==='POST');
  await pg.locator('#itlSubmit').click();const restoreConflictRespG=await restoreConflictPostedG;
  check('M2:恢复version冲突返回409',restoreConflictRespG.status()===409);
  await pg.waitForFunction(()=>!document.querySelector('#itlModal').classList.contains('open'));
  check('M2:409后弹窗已关闭',await pg.locator('#itlModal.open').count()===0);
  check('M2:409后提示冲突信息含"已变化"',(await pg.locator('#itlNotice').innerText()).includes('已变化'));
  await pg.locator('[data-insp-restore="'+m2RestoreTarget.id+'"]').waitFor();
  const restoreBtnVersionAfterReloadG=await pg.locator('[data-insp-restore="'+m2RestoreTarget.id+'"]').getAttribute('data-version');
  check('M2:409后已删除列表确实重载(data-version已刷新为最新DB值,不是旧DOM残留)',Number(restoreBtnVersionAfterReloadG)===m2VersionAtDelete+1,{restoreBtnVersionAfterReloadG,expected:m2VersionAtDelete+1});
  const restoreRetryPostedG=pg.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+m2RestoreTarget.id+'/restore')&&r.request().method()==='POST');
  await pg.locator('[data-insp-restore="'+m2RestoreTarget.id+'"]').click();await pg.locator('#itlModal.open').waitFor();await pg.locator('#itlSubmit').click();
  const restoreRetryRespG=await restoreRetryPostedG;
  check('M2:用重载后拿到的新version重试恢复成功(200)',restoreRetryRespG.status()===200);
  await pg.locator('#itlInspBackToList').click();await pg.locator('[data-insp-row="'+m2RestoreTarget.id+'"]').waitFor();
  check('M2:重试恢复成功后台账列表能看到该单且状态已提交',(await pg.locator('[data-insp-row="'+m2RestoreTarget.id+'"]').innerText()).includes('已提交'));
  check('浏览器无未捕获异常(M2视角)',errorsG.length===0);
  await cg.close();

  // H) L1（C4c采纳）：两个"无机柜的历史机房"（机柜建好后已被删掉，只有巡检单room_name里还留着）——
  // 未筛选加载时两者都应出现在机房下拉里；选中其一之后，lastItems只剩该机房自己的行，但未选中的另一
  // 个历史机房仍应留在下拉选项里（只能来自跨次累积的knownRooms，不是当次lastItems派生）。
  const ch=await browser.newContext();await ch.addInitScript(()=>localStorage.setItem('token','fixture-1'));const ph=await ch.newPage();const errorsH=[];ph.on('pageerror',e=>errorsH.push(e.message));
  await ph.goto(f.base+'/IT_Ledger.html#inspections');await ph.locator('#itlInspRoomFilter').waitFor();
  const roomOptionsInitialH=await ph.locator('#itlInspRoomFilter option').allInnerTexts();
  check('L1:未筛选加载后两个无机柜历史机房都出现在机房下拉里',roomOptionsInitialH.includes('S-Room11')&&roomOptionsInitialH.includes('S-Room12'),roomOptionsInitialH);
  await ph.locator('#itlInspRoomFilter').selectOption('S-Room11');await ph.waitForFunction(()=>document.querySelectorAll('#itlInspRows [data-insp-row]').length>=1);
  const roomOptionsAfterFilterH=await ph.locator('#itlInspRoomFilter option').allInnerTexts();
  check('L1:选中S-Room11筛选后,未选中的S-Room12仍留在下拉选项里(跨次累积,不是当次lastItems派生)',roomOptionsAfterFilterH.includes('S-Room12'),roomOptionsAfterFilterH);
  check('浏览器无未捕获异常(L1视角)',errorsH.length===0);
  await ch.close();

  // I) H1直测（C4c必修，补强①②覆盖不到的那一层）：①②验证的是confirmBatchArchive/confirmRestore
  // 外层的显式核对——那层挡住之后，load()/loadDeleted()自己入口那道闸根本不会被触发到，删掉它①②也
  // 测不出来（已用变异验证过，见交付报告）。这里绕开外层，在tab已经不是inspections时直接调
  // render()（mode仍是list时就是load()），单独验证入口这道闸本身确实存在。load()是async函数：守卫
  // 在，函数在第一个await之前就同步return，不碰DOM；守卫被删，函数会同步跑到
  // container.replaceChildren(marker)才挂起——不用等待/猜时间，evaluate()里的同步包装函数一返回，
  // 这段同步前缀就已经跑完，直接断言DOM状态即可。
  const ci=await browser.newContext();await ci.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pi=await ci.newPage();const errorsI=[];pi.on('pageerror',e=>errorsI.push(e.message));
  await pi.goto(f.base+'/IT_Ledger.html#inspections');await pi.locator('[data-insp-row]').first().waitFor();
  await pi.evaluate(()=>{location.hash='racks';});await pi.locator('.itl-rack-workspace').waitFor();
  const settledBaselineI=await pi.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pi.evaluate(()=>{window.ITLedger.state.views.inspections.render();});
  check('H1直测:tab已不是inspections时render()不覆盖机房视图(有机房标志元素)',await pi.locator('.itl-rack-workspace').count()===1);
  check('H1直测:tab已不是inspections时render()不覆盖机房视图(无台账元素)',await pi.locator('#itlInspRows').count()===0&&await pi.locator('#itlInspOverview').count()===0);
  check('H1直测:tab已不是inspections时render()不覆盖机房视图(无"正在读取巡检台账"文字)',!(await pi.locator('body').innerText()).includes('正在读取巡检台账'));
  check('H1直测:同步早退未进入await,__inspLoadSettled计数不变',await pi.evaluate(base=>window.ITLedger.__inspLoadSettled===base,settledBaselineI));
  check('浏览器无未捕获异常(H1直测)',errorsI.length===0);
  await ci.close();

  // J) M（C4d采纳，codex 40-R）：子视图漂移——批量归档挂起期间，用户仍在巡检页签，但从列表切到"已
  // 删除"视图；放行后断言停在已删除视图（不是被写回调拉回列表）。这是块 E 证明不到的分支：块 E 切的是
  // "别的页签"（L.state.tab 变了），这里切的是"同页签内的另一个子视图"（tab 不变，mode 变了），
  // confirmBatchArchive 的 stillSameSubview() 要同时核 mode 与 viewGen 才能分辨这种情况。
  const cj=await browser.newContext();await cj.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pj=await cj.newPage();const errorsJ=[];pj.on('pageerror',e=>errorsJ.push(e.message));
  await pj.goto(f.base+'/IT_Ledger.html#inspections');
  await pj.locator('[data-insp-row="'+subviewArchiveTarget.id+'"]').waitFor();
  await pj.locator('[data-insp-check="'+subviewArchiveTarget.id+'"]').check();
  await pj.locator('#itlInspBatchArchive').click();await pj.locator('#itlModal.open').waitFor();
  let releaseArchiveJ,enteredArchiveJ;
  const enteredArchiveJP=new Promise(r=>enteredArchiveJ=r),heldArchiveJP=new Promise(r=>releaseArchiveJ=r);
  await pj.route('**/api/it-assets/inspections/sheets/archive',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredArchiveJ();await heldArchiveJP;await route.fulfill({response});
  });
  await pj.locator('#itlSubmit').click();
  await enteredArchiveJP;
  // 归档确认弹窗仍开着且modalBusy（等待被挂起的响应），backdrop挡住一切真实指针点击（Playwright的
  // .click()会因"元素被#itlModal拦截"而超时）——用DOM原生.click()绕开可见性/可点击性判定，直接触发
  // 冒泡到document的委托监听器，等效于"某种方式在弹窗仍打开时切到了已删除视图"这个我们要验证的场景
  // 本身（判别力落在"回调是否尊重这个已经发生的子视图切换"，不落在"切换本身怎么触发的"）。
  await pj.evaluate(()=>document.querySelector('#itlInspOpenDeleted').click());
  await pj.locator('#itlInspBackToList').waitFor();
  const settledBaselineJ=await pj.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const archiveRespondedJ=pj.waitForResponse(r=>r.url().endsWith('/inspections/sheets/archive')&&r.request().method()==='POST');
  releaseArchiveJ();
  await archiveRespondedJ;
  await pj.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineJ);
  check('J:批量归档挂起期间切到已删除视图,放行后仍停在已删除视图(返回巡检台账按钮仍在)',await pj.locator('#itlInspBackToList').count()===1);
  check('J:未被拉回列表(无批量归档工具栏按钮)',await pj.locator('#itlInspBatchArchive').count()===0);
  const dbAfterArchiveJ=(await f.all('SELECT status FROM it_inspection_sheets WHERE id=?',[subviewArchiveTarget.id]))[0];
  check('J:归档写请求本身不受视图漂移影响,库内确实已生效(只是不强制把用户拉回列表)',dbAfterArchiveJ.status==='archived',dbAfterArchiveJ);
  check('浏览器无未捕获异常(J)',errorsJ.length===0);
  await cj.close();

  // K) M（C4d采纳）：子视图漂移——恢复挂起期间，用户仍在巡检页签，从已删除视图切回列表；放行后断言
  // 停在列表视图（不是被写回调拉回已删除）。
  const ck=await browser.newContext();await ck.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pk=await ck.newPage();const errorsK=[];pk.on('pageerror',e=>errorsK.push(e.message));
  await pk.goto(f.base+'/IT_Ledger.html#inspections');
  await pk.locator('#itlInspOpenDeleted').click();await pk.locator('#itlInspBackToList').waitFor();
  await pk.locator('[data-insp-restore="'+subviewRestoreTarget.id+'"]').waitFor();
  await pk.locator('[data-insp-restore="'+subviewRestoreTarget.id+'"]').click();await pk.locator('#itlModal.open').waitFor();
  let releaseRestoreK,enteredRestoreK;
  const enteredRestoreKP=new Promise(r=>enteredRestoreK=r),heldRestoreKP=new Promise(r=>releaseRestoreK=r);
  await pk.route('**/api/it-assets/inspections/sheets/'+subviewRestoreTarget.id+'/restore',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredRestoreK();await heldRestoreKP;await route.fulfill({response});
  });
  await pk.locator('#itlSubmit').click();
  await enteredRestoreKP;
  // 同块J：弹窗backdrop挡住真实指针点击，用DOM原生.click()绕开触发子视图切换本身。
  await pk.evaluate(()=>document.querySelector('#itlInspBackToList').click());
  await pk.locator('[data-insp-row]').first().waitFor();
  const settledBaselineK=await pk.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const restoreRespondedK=pk.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+subviewRestoreTarget.id+'/restore')&&r.request().method()==='POST');
  releaseRestoreK();
  await restoreRespondedK;
  await pk.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineK);
  check('K:恢复挂起期间切回列表视图,放行后仍停在列表视图(新增巡检按钮在,证明是列表非已删除)',await pk.locator('#itlInspNew').count()===1);
  check('K:未被拉回已删除视图(无返回巡检台账按钮)',await pk.locator('#itlInspBackToList').count()===0);
  const dbAfterRestoreK=(await f.all('SELECT status FROM it_inspection_sheets WHERE id=?',[subviewRestoreTarget.id]))[0];
  check('K:恢复写请求本身不受视图漂移影响,库内确实已生效',dbAfterRestoreK.status==='submitted',dbAfterRestoreK);
  check('浏览器无未捕获异常(K)',errorsK.length===0);
  await ck.close();

  // L) H（C4d必修，codex 40-R）：已删除视图入口闸独立直测——块 I 的"H1直测"只在 mode==='list' 时调
  // render()，验证的是 load() 自己的闸；如果 loadDeleted() 自己的闸被删掉，块 E/F/J/K 的外层核对仍然
  // 挡得住（恢复用例走的是 confirmRestore 的 stillSameSubview()，那道闸独立于 loadDeleted() 自己的
  // tab 检查），这条直测测不出来，除非像这里一样专门绕开外层。进入已删除视图 → 切到"机房" → 直接调用
  // 已注册视图的 render()（mode 仍是 deleted，会走 loadDeleted() 分支）→ 断言机房视图完整、无"正在
  // 读取已删除的巡检记录"字样、计数不变。
  const cl=await browser.newContext();await cl.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pl=await cl.newPage();const errorsL=[];pl.on('pageerror',e=>errorsL.push(e.message));
  await pl.goto(f.base+'/IT_Ledger.html#inspections');
  await pl.locator('#itlInspOpenDeleted').click();await pl.locator('#itlInspBackToList').waitFor();
  await pl.evaluate(()=>{location.hash='racks';});await pl.locator('.itl-rack-workspace').waitFor();
  const settledBaselineL=await pl.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pl.evaluate(()=>{window.ITLedger.state.views.inspections.render();});
  check('L:已删除视图直测:tab已不是inspections时render()不覆盖机房视图(有机房标志元素)',await pl.locator('.itl-rack-workspace').count()===1);
  check('L:已删除视图直测:不覆盖机房视图(无已删除台账元素,无返回巡检台账按钮)',await pl.locator('#itlInspBackToList').count()===0);
  check('L:已删除视图直测:不覆盖机房视图(无"正在读取已删除的巡检记录"文字)',!(await pl.locator('body').innerText()).includes('正在读取已删除的巡检记录'));
  check('L:已删除视图直测:同步早退未进入await,__inspLoadSettled计数不变',await pl.evaluate(base=>window.ITLedger.__inspLoadSettled===base,settledBaselineL));
  check('浏览器无未捕获异常(L)',errorsL.length===0);
  await cl.close();

  // M: a refreshed complete list retains historical rooms under local status filtering.
  const errorsMP=[];
  const cm=await browser.newContext(); await cm.addInitScript(()=>localStorage.setItem('token','fixture-1'));
  const pm=await cm.newPage();pm.on('pageerror',e=>errorsMP.push(e.message)); await pm.goto(f.base+'/IT_Ledger.html#inspections'); await pm.locator('#itlInspRoomFilter').waitFor();
  const settledInitialM=await pm.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const l3Rack1=(await f.api('POST','/racks',{name:'S-Room17-柜1',room:'S-Room17',u_total:20})).body;
  await createSheet(2,'S-Room17'); assert.equal((await f.api('DELETE','/racks/'+l3Rack1.id,undefined,1)).status,200);
  check('M夹具在首次加载后建立',await pm.evaluate(()=>window.ITLedger.__inspLoadSettled)===settledInitialM);
  await pm.evaluate(()=>window.ITLedger.state.views.inspections.render());
  await pm.waitForFunction(base=>window.ITLedger.__inspLoadSettled===base+1,settledInitialM);
  let filterRequestsM=0; pm.on('request',r=>{if(r.url().includes('/inspections/sheets')&&r.method()==='GET')filterRequestsM++;});
  await pm.locator('[data-insp-status="archived"]').click();
  check('M状态筛选仍保留历史机房', (await pm.locator('#itlInspRoomFilter option').allInnerTexts()).includes('S-Room17'));
  check('M状态筛选排除历史草稿',await pm.locator('[data-insp-row]').filter({hasText:'S-Room17'}).count()===0);
  check('M筛选不再发请求',filterRequestsM===0);
  check('M无浏览器异常',errorsMP.length===0);
  await cm.close();

  // N: a delayed overview cannot delay rows or replace the table/selection when it arrives.
  const nCheckTarget=await buildSubmittedSheet('S-Room19',2,false);
  const cn=await browser.newContext();await cn.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pn=await cn.newPage();
  pn.on('pageerror',e=>errorsMP.push(e.message));
  let releaseN; const heldN=new Promise(resolve=>releaseN=resolve);
  await pn.route('**/api/it-assets/inspections/sheets/overview',async route=>{const response=await route.fetch();await heldN;await route.fulfill({response});});
  try {
    await pn.goto(f.base+'/IT_Ledger.html#inspections');await pn.locator('[data-insp-row="'+nCheckTarget.id+'"]').waitFor();
    check('N概览挂起时列表已完成',await pn.evaluate(()=>window.ITLedger.__inspLoadSettled)===1);
    check('N概览挂起不伪造机房状态',await pn.locator('[data-insp-room]').count()===0);
    check('N概览挂起有明确加载提示',await pn.locator('#itlInspOverview').innerText()==='正在读取机房概览…');
    await pn.evaluate(()=>document.querySelector('#itlInspRows').dataset.notRedrawn='1');
    await pn.locator('[data-insp-check="'+nCheckTarget.id+'"]').check();
    releaseN();await pn.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
    check('N概览放行后机房卡片出现',await pn.locator('[data-insp-room="S-Room19"]').count()===1);
    check('N概览不替换列表节点',await pn.evaluate(()=>document.querySelector('#itlInspRows').dataset.notRedrawn)==='1');
    check('N概览不清除勾选',await pn.locator('[data-insp-check="'+nCheckTarget.id+'"]').isChecked());
    check('N概览成功标题正确',!(await pn.locator('#itlInspMonth').innerText()).includes('读取'));
    check('N概览成功没有失败提示',!(await pn.locator('#itlInspOverview').innerText()).includes('失败'));
    check('N无浏览器异常',errorsMP.length===0);
  } finally { releaseN();await cn.close(); }

  // O: overview failure is unknown, never a fabricated "not inspected" result.
  const co=await browser.newContext();await co.addInitScript(()=>localStorage.setItem('token','fixture-1'));const po=await co.newPage();
  po.on('pageerror',e=>errorsMP.push(e.message));
  await po.route('**/api/it-assets/inspections/sheets/overview',route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({code:'LEDGER_INTERNAL',message:'模拟概览失败'})}));
  await po.goto(f.base+'/IT_Ledger.html#inspections');await po.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
  check('O概览500列表仍显示目标单',await po.locator('[data-insp-row="'+nCheckTarget.id+'"]').count()===1);
  check('O概览500无toast打扰',await po.locator('#itlToast').isHidden());
  check('O概览500明确失败文字',await po.locator('#itlInspOverview').innerText()==='机房概览读取失败，请重新进入巡检台账重试。');
  check('O概览500不伪造未巡检卡片',await po.locator('[data-insp-room]').count()===0);
  check('O概览500标题标明失败',await po.locator('#itlInspMonth').innerText()==='机房概览读取失败');
  check('O无浏览器异常',errorsMP.length===0);
  await co.close();

  // P: a late overview cannot overwrite the deleted subview.
  const cp=await browser.newContext();await cp.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pp=await cp.newPage();
  pp.on('pageerror',e=>errorsMP.push(e.message));
  let releaseP;const heldP=new Promise(resolve=>releaseP=resolve);
  await pp.route('**/api/it-assets/inspections/sheets/overview',async route=>{const response=await route.fetch();await heldP;await route.fulfill({response});});
  try {
    await pp.goto(f.base+'/IT_Ledger.html#inspections');await pp.locator('#itlInspOpenDeleted').click();await pp.locator('#itlInspBackToList').waitFor();
    releaseP();await pp.waitForFunction(()=>window.ITLedger.__inspOverviewSettled===1);
    check('P概览迟到仍在已删除视图',await pp.locator('#itlInspBackToList').count()===1);
    check('P概览迟到不恢复机房筛选',await pp.locator('#itlInspRoomFilter').count()===0);
    check('P概览迟到不恢复概览卡片',await pp.locator('#itlInspOverview').count()===0);
    check('P无浏览器异常',errorsMP.length===0);
  } finally { releaseP();await cp.close(); }

  // Q) M2（C4e必修，codex 40-R2）：viewGen往返分支——块J/K只覆盖"切到另一子视图后放行"，若删掉
  // confirmBatchArchive的viewGen比较、只留mode比较，块J/K仍全绿（因为它们停在"另一子视图"没有切回来，
  // mode本身就不等）。这里覆盖"切到已删除视图又切回列表"（mode相同、viewGen已变两次）：批量归档挂起→
  // 切已删除→切回列表（mode又变回'list'，但viewGen已经往返递增过）→放行→断言没有额外的列表重载请求
  // （计数精确为0，等__inspLoadSettled自增到达）且toast出现；写请求本身不受影响，库内确实已归档。
  const qArchiveTarget=await buildSubmittedSheet('S-Room22',2,false);
  const cq=await browser.newContext();await cq.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pq=await cq.newPage();const errorsQ=[];pq.on('pageerror',e=>errorsQ.push(e.message));
  await pq.goto(f.base+'/IT_Ledger.html#inspections');
  await pq.locator('[data-insp-row="'+qArchiveTarget.id+'"]').waitFor();
  await pq.locator('[data-insp-check="'+qArchiveTarget.id+'"]').check();
  await pq.locator('#itlInspBatchArchive').click();await pq.locator('#itlModal.open').waitFor();
  let releaseArchiveQ,enteredArchiveQ;
  const enteredArchiveQP=new Promise(r=>enteredArchiveQ=r),heldArchiveQP=new Promise(r=>releaseArchiveQ=r);
  await pq.route('**/api/it-assets/inspections/sheets/archive',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredArchiveQ();await heldArchiveQP;await route.fulfill({response});
  });
  await pq.locator('#itlSubmit').click();
  await enteredArchiveQP;
  // 同块J：弹窗backdrop挡住真实指针点击，用DOM原生.click()绕开触发子视图切换本身。
  await pq.evaluate(()=>document.querySelector('#itlInspOpenDeleted').click());
  await pq.locator('#itlInspBackToList').waitFor();
  await pq.evaluate(()=>document.querySelector('#itlInspBackToList').click());
  // 切回列表这一步本身会真的发一次列表重载请求（预期内、与归档回调无关）——先等它完全落定，再从这一刻
  // 开始计数，才能干净地证明"归档回调放行后没有再额外发一次"。
  await pq.locator('[data-insp-row]').first().waitFor();
  let listReqCountQ=0;
  pq.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/sheets')&&r.method()==='GET')listReqCountQ++;});
  const settledBaselineQ=await pq.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const archiveRespondedQ=pq.waitForResponse(r=>r.url().endsWith('/inspections/sheets/archive')&&r.request().method()==='POST');
  releaseArchiveQ();
  await archiveRespondedQ;
  await pq.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineQ);
  check('Q:批量归档挂起期间切已删除又切回列表(viewGen已往返),放行后没有额外的列表重载请求(计数精确为0)',listReqCountQ===0,listReqCountQ);
  check('Q:归档成功toast仍出现(与是否重载列表无关)',(await pq.locator('#itlToast').innerText()).includes('已归档'));
  const dbAfterArchiveQ=(await f.all('SELECT status FROM it_inspection_sheets WHERE id=?',[qArchiveTarget.id]))[0];
  check('Q:归档写请求本身不受viewGen往返影响,库内确实已生效',dbAfterArchiveQ.status==='archived',dbAfterArchiveQ);
  check('浏览器无未捕获异常(Q)',errorsQ.length===0);
  await cq.close();

  // R) M2（C4e必修，codex 40-R2）：同Q，换成已删除视图发起恢复——挂起→切列表→切回已删除（mode又变回
  // 'deleted'，viewGen已往返递增过）→放行→断言没有额外的loadDeleted请求，写请求本身不受影响。
  const rSubmit=await buildSubmittedSheet('S-Room23',2,false);
  const delR=await f.api('DELETE','/inspections/sheets/'+rSubmit.id,{expected_version:rSubmit.version,reason:'Q2 viewGen往返恢复测试预备删除'},1);
  assert.equal(delR.status,200,'delete rSubmit '+JSON.stringify(delR.body));
  const cr2=await browser.newContext();await cr2.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pr=await cr2.newPage();const errorsR=[];pr.on('pageerror',e=>errorsR.push(e.message));
  await pr.goto(f.base+'/IT_Ledger.html#inspections');
  await pr.locator('#itlInspOpenDeleted').click();await pr.locator('#itlInspBackToList').waitFor();
  await pr.locator('[data-insp-restore="'+rSubmit.id+'"]').waitFor();
  await pr.locator('[data-insp-restore="'+rSubmit.id+'"]').click();await pr.locator('#itlModal.open').waitFor();
  let releaseRestoreR,enteredRestoreR;
  const enteredRestoreRP=new Promise(r=>enteredRestoreR=r),heldRestoreRP=new Promise(r=>releaseRestoreR=r);
  await pr.route('**/api/it-assets/inspections/sheets/'+rSubmit.id+'/restore',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    const response=await route.fetch();enteredRestoreR();await heldRestoreRP;await route.fulfill({response});
  });
  await pr.locator('#itlSubmit').click();
  await enteredRestoreRP;
  // 同块K：弹窗backdrop挡住真实指针点击，用DOM原生.click()绕开触发子视图切换本身。
  await pr.evaluate(()=>document.querySelector('#itlInspBackToList').click());
  await pr.locator('[data-insp-row]').first().waitFor();
  await pr.evaluate(()=>document.querySelector('#itlInspOpenDeleted').click());
  await pr.locator('#itlInspBackToList').waitFor();
  let deletedReqCountR=0;
  pr.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/sheets/deleted')&&r.method()==='GET')deletedReqCountR++;});
  const settledBaselineR=await pr.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const restoreRespondedR=pr.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+rSubmit.id+'/restore')&&r.request().method()==='POST');
  releaseRestoreR();
  await restoreRespondedR;
  await pr.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineR);
  check('R:恢复挂起期间切列表又切回已删除(viewGen已往返),放行后没有额外的已删除重载请求(计数精确为0)',deletedReqCountR===0,deletedReqCountR);
  check('R:恢复成功toast仍出现(与是否重载已删除视图无关)',(await pr.locator('#itlToast').innerText()).includes('已恢复'));
  const dbAfterRestoreR=(await f.all('SELECT status FROM it_inspection_sheets WHERE id=?',[rSubmit.id]))[0];
  check('R:恢复写请求本身不受viewGen往返影响,库内确实已生效',dbAfterRestoreR.status==='submitted',dbAfterRestoreR);
  check('浏览器无未捕获异常(R)',errorsR.length===0);
  await cr2.close();

  // S) 44S H1（codex 44 审查修复）：openInspectionSheet 失败分支（catch）此前无条件调用
  // openDetail(id)——用户若在这次GET挂起期间又点开了另一张单（sequence前进），迟到的失败响应仍会
  // 调用openDetail(id)，其内部enterMode('detail')/detailId=id/container.replaceChildren(marker)这段
  // 同步前缀不依赖任何守卫，会立刻把用户正在看的另一张单整块替换成"正在读取巡检详情…"的占位。"切到
  // 别的页签且不再切回"这一支已经被openDetail自己入口的tab检查兜底（已用变异验证：单独去掉本函数的
  // 守卫、只做"切走页签不切回"这个构造，既有断言与新增断言都不转红，无判别力）；能让"去掉整段守卫"
  // 这个变异首红的构造是"跳转期间又点开另一张单"——sequence因第二次调用前进，tab全程仍是
  // 'inspections'，专测seq检查这一半。sSubmitted(提交单)用来发起会失败的第一次跳转，永远不会真的
  // 渲染成功；sDraft(草稿)是"用户随后又点开的另一张单"，落到填写页(#itlFormBack)。
  const sSubmitted=await buildSubmittedSheet('S-Room24',2,false);
  const sDraft=await buildDraftSheet('S-Room25',2);
  const cs=await browser.newContext();await cs.addInitScript(()=>localStorage.setItem('token','fixture-1'));const ps=await cs.newPage();const errorsS=[];ps.on('pageerror',e=>errorsS.push(e.message));
  await ps.goto(f.base+'/IT_Ledger.html#inspections');
  await ps.locator('[data-insp-row]').first().waitFor();
  let releaseS,enteredS;
  const enteredSP=new Promise(r=>enteredS=r),heldSP=new Promise(r=>releaseS=r);
  await ps.route('**/api/it-assets/inspections/sheets/'+sSubmitted.id,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   enteredS();await heldSP;await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'LEDGER_NOT_FOUND',message:'巡检单不存在'})});
  });
  await ps.evaluate(id=>{window.ITLedger.openInspectionSheet(id);},sSubmitted.id);
  await enteredSP;
  await ps.evaluate(id=>{window.ITLedger.openInspectionSheet(id);},sDraft.id);
  await ps.locator('#itlFormBack').waitFor();
  check('S:跳转另一张单(草稿)期间,先落到该草稿的填写页(标题为S-Room25,前提成立)',(await ps.locator('.itl-sheet-title h2').innerText()).includes('S-Room25'));
  const failedSResponse=ps.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+sSubmitted.id)&&r.request().method()==='GET');
  // LOW-3（C5a-g 追加 C）：改用确定性信号，不再猜测300ms够不够——openInspectionSheet的catch分支(不管
  // discard还是真的走到openDetail)都会自增__inspLoadSettled，等它+1就等到了这次迟到失败响应的处理
  // 已经跑完。
  const settledBeforeReleaseS=await ps.evaluate(()=>window.ITLedger.__inspLoadSettled);
  releaseS();
  await failedSResponse;
  await ps.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeReleaseS,{timeout:5000});
  check('S:先跳转的单请求失败释放后,仍停在后跳转的草稿填写页(标题仍是S-Room25,未被替换)',(await ps.locator('.itl-sheet-title h2').innerText()).includes('S-Room25'));
  check('S:先跳转的单请求失败释放后,表单未被替换成加载占位或错误卡片',await ps.locator('#itlContent .itl-form-error').count()===0&&!(await ps.locator('body').innerText()).includes('正在读取巡检详情'));
  check('S:先跳转的单请求失败释放后,未被拉回台账列表(无巡检行元素)',await ps.locator('[data-insp-row]').count()===0);
  check('S:先跳转的单请求失败释放后,未出现"已不存在"误导提示',await ps.locator('#itlToast:not([hidden])').count()===0);
  check('浏览器无未捕获异常(S)',errorsS.length===0);
  await cs.close();

  // S2) MED-1（C5a-g 追加 C）：块 S 测的是 openInspectionSheet 的 catch 分支（A 的 GET 以失败告终）；这里
  // 补 try 分支——A 的 GET 挂起期间点开另一张单 B，B 走真实 200 先落地渲染，放行 A 的 GET（这次也是真实
  // 200，不是失败）——A 的迟到成功响应不应该把画面从 B 改判回 A。变异目标：删掉 try 分支的 stillValid()
  // 检查会让这里首红。
  const s2A=await buildDraftSheet('S2-RoomA',2);
  const s2B=await buildDraftSheet('S2-RoomB',2);
  const cs2=await browser.newContext();await cs2.addInitScript(()=>localStorage.setItem('token','fixture-1'));const ps2=await cs2.newPage();const errorsS2=[];ps2.on('pageerror',e=>errorsS2.push(e.message));
  await ps2.goto(f.base+'/IT_Ledger.html#inspections');
  await ps2.locator('[data-insp-row]').first().waitFor();
  let releaseS2,enteredS2;
  const enteredS2P=new Promise(r=>enteredS2=r),heldS2P=new Promise(r=>releaseS2=r);
  await ps2.route('**/api/it-assets/inspections/sheets/'+s2A.id,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   enteredS2();await heldS2P;await route.fallback();
  });
  await ps2.evaluate(id=>{window.ITLedger.openInspectionSheet(id);},s2A.id);
  await enteredS2P;
  await ps2.evaluate(id=>{window.ITLedger.openInspectionSheet(id);},s2B.id);
  await ps2.locator('[data-sheet-id="'+s2B.id+'"]').waitFor({timeout:10000});
  check('S2准备:B先真实落地(标题S2-RoomB,前提成立)',(await ps2.locator('.itl-sheet-title h2').innerText()).includes('S2-RoomB'));
  const settledBeforeReleaseS2=await ps2.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const okS2Response=ps2.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+s2A.id)&&r.request().method()==='GET');
  releaseS2();
  await okS2Response;
  await ps2.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeReleaseS2,{timeout:5000});
  const rootIdS2=await ps2.locator('.itl-sheet-toolbar').getAttribute('data-sheet-id');
  check('S2(MED-1必修)：A迟到的真实200释放后,data-sheet-id仍等于B(没有被改判回A)',rootIdS2===String(s2B.id),rootIdS2);
  check('S2(MED-1必修)：标题仍是S2-RoomB',(await ps2.locator('.itl-sheet-title h2').innerText()).includes('S2-RoomB'));
  check('浏览器无未捕获异常(S2)',errorsS2.length===0);
  await cs2.close();

  // T) C6-e 改写（依据 C6-d 预筛裁定：原构造无判别力）：旧版块T做"跳转另一张单(跨页GET挂起) → 页签
  // 往返恢复列表 → 直接点列表另一张单"，本意是测openDraftById自己的sequence推进；但预筛发现"页签
  // 往返"这一步本身会经load()把sequence推进一次（load()每次都`++sequence`），block T的判据因此在
  // "去掉openDraftById自己的++sequence"这个变异下也全绿（B1/B2两个变异，最后一条OK判据都误判成
  // "命中"——旧写法的自查坑段落里提到的"绕开重载"手法反而制造了这层掩盖，HIGH-1）。改用可达的真实
  // 竞态构造（PU）：不做任何页签往返，纯粹靠openDraftById这个入口自己连续触发两次——点草稿A"继续
  // 填写"、GET挂起（不放行）；不等它，直接点草稿B"继续填写"，等B的填写页出现（data-sheet-id===B）；
  // 这时才放行A的GET（200，真实成功响应，不是404）；断言页面仍停在B，A的内容完全没有出现过。两张单
  // 都归fixture-2所有，用本人视角看自己的两张草稿，"继续填写"按钮都真实可点。
  // 变异：去掉openDraftById的`++sequence`（改成`openDraftByIdFresh(id, sequence)`）——A迟到的GET
  // 响应落地时，`seq===sequence`会因为两次openDraftById共享同一个从未真正递增过的sequence而恒为真，
  // A会把B的填写页重新覆盖成A的内容，首红必须落在下面"仍停在B"这条断言。块S保留不变（它验证的是
  // openInspectionSheet自己的seq检查，与openDraftById是不同的函数/不同的判据，两者不能互相替代）。
  const tA=await buildDraftSheet('T-RoomA',2);
  const tB=await buildDraftSheet('T-RoomB',2);
  const ct=await browser.newContext();await ct.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pt=await ct.newPage();const errorsT=[];pt.on('pageerror',e=>errorsT.push(e.message));
  await pt.goto(f.base+'/IT_Ledger.html#inspections');
  await pt.locator('[data-insp-row="'+tB.id+'"]').waitFor();
  let releaseTFn,enteredTResolve;
  const enteredTPromise=new Promise(r=>enteredTResolve=r),heldTPromise=new Promise(r=>releaseTFn=r);
  await pt.route('**/api/it-assets/inspections/sheets/'+tA.id,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   enteredTResolve();await heldTPromise;await route.fallback(); // 放行后走真实请求，拿到真实200（不是canned错误响应）
  });
  await pt.locator('[data-insp-continue="'+tA.id+'"]').click(); // 点A"继续填写"——openDraftById(A)，GET被挂住
  await enteredTPromise;
  await pt.locator('[data-insp-continue="'+tB.id+'"]').click(); // 不等A，直接点B"继续填写"——openDraftById(B)
  await pt.locator('[data-sheet-id="'+tB.id+'"]').waitFor();
  const tBSheetId=await pt.locator('[data-sheet-id]').getAttribute('data-sheet-id');
  check('T准备:B的填写页已显示(data-sheet-id与tB一致,前提成立)',tBSheetId===String(tB.id),tBSheetId);
  const settledBeforeReleaseT=await pt.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const respondedT=pt.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+tA.id)&&r.request().method()==='GET');
  releaseTFn(); // 放行A的GET——200成功响应迟到
  await respondedT;
  // openDraftByIdFresh的每条分支(丢弃/无save/openForm成功/catch)都会自增__inspLoadSettled——这是
  // 确定性信号(不依赖sleep猜时机)，等它+1就等到了"A这次迟到GET的discard判断已经跑完"。
  await pt.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeReleaseT,{timeout:5000});
  check('T(必修·改写为PU构造):A迟到的200放行后仍停在B(data-sheet-id仍是tB,tA未出现)',await pt.locator('[data-sheet-id="'+tB.id+'"]').count()===1&&await pt.locator('[data-sheet-id="'+tA.id+'"]').count()===0);
  check('浏览器无未捕获异常(T)',errorsT.length===0);
  await ct.close();

  console.log(`SHEETS_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
