'use strict';
const assert=require('assert/strict'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture'),{normalize}=require('../routes/it-ledger/inspection-collector');
let pass=0;const check=(name,value,detail)=>{if(!value&&detail!==undefined)console.error('DETAIL',name,JSON.stringify(detail));assert.ok(value,name);pass++;console.log('[OK] '+name);};
// C7（长任务 E · 巡检台账改版，方案 v0.6 §6「it-ledger-inspections.js」条 / §7「v0.6 追加退役」段，
// 用户 2026-09-25 16:5x 裁定 A）：服务器详情「设备巡检」页签从一键采集+判断表单+附件区+快照详情
// 展开，改为纯只读摘要表（采集时间/所属巡检单/采集状态/告警数/判断结果，点归属列跳所属巡检单）；
// 单独设备巡检（一键采集、单条判断、设备附件）整体退役。本文件原本承载的"一键采集/人工判断/附件
// 上传/切换服务器不串场/迟到历史不渲染到后机"等整套围绕收集与判断表单的浏览器断言，随这些控件一并
// 从页面消失而失去对象，改为围绕新摘要表重写：各列取值（可见行/受限行/不属于巡检单的行）、点击跳转
// （含干扰单核 data-sheet-id、管理员打开已删除单同样核 data-sheet-id）、页签上不存在已退役控件、
// 空状态文案。normalize() 的纯函数告警逻辑测试（本文件历来就有，与路由无关）原样保留。原→新逐条
// 对照见交付报告。
// L2（C7-c，Opus预筛）：it-ledger-inspections.js 的 current(seq) 守卫挡的是"切走/切到另一台服务器后
// 迟到的历史响应落地"这类竞态——prescreen 变异实测（去掉守卫重跑全套）证明去掉它不会产生任何可观察
// 差异：render() 闭包捕获的 host 元素是每次 mountAssetInspection 新建的（从不复用旧节点），迟到响应
// 写的是已经不在文档树里（或从未挂载过）的旧节点，屏幕上什么都不会变。这层守卫因此是纵深防御，不是
// 当前结构下能被单独证明必要的行为——本文件不为它专门构造竞态用例。
const raw=()=>({source_host:'192.0.2.5',started_at:new Date().toISOString(),completed_at:new Date().toISOString(),server:{name:'巡检服务器',manufacturer:'Dell',model:'测试机',serial_number:'INSPECT-SN',os:'Windows测试',memory_bytes:8589934592,cpus:[{name:'测试CPU',cores:4,threads:8}],password:'must-not-leak'},volumes:[{name:'C:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:5000000000}],controllers:[{id:'1',pdisk:'ID : 0:0:5\nState : Failed\nStatus : Critical\nProduct ID : DiskModel\nSerial No. : DISK-SN\nCapacity : 3,725 GB (4000225165312 bytes)\nBus Protocol : SAS\nMedia : HDD\nFailure Predicted : No',vdisk:'ID : 1\nName : vd2\nState : Degraded\nStatus : Non-Critical\nLayout : RAID-5\nSize : 7451 GB (8000450330624 bytes)\nDevice Name : Windows Disk 2',enclosure:'ID : 0:0\nName : MD1200\nService Tag : ENC-SN\nState : Degraded\nStatus : Non-Critical'}],component_errors:[],cleanup_warnings:[]});
const HOST='192.0.2.5';
const MIN_PNG=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),Buffer.alloc(16,1)]);
const NUMBER_DEFAULT={temperature:22,humidity:45};
function fillPayloadAllOk(items){return items.map(it=>it.value_kind==='number'?{id:it.id,result:null,number_value:NUMBER_DEFAULT[it.item_key]??25,note:null}:{id:it.id,result:'ok',number_value:null,note:null});}
function deviceItemOf(detailBody,deviceId){return detailBody.items.find(it=>it.section==='device'&&it.target_id===deviceId);}
async function uploadAllRackFrontPhotos(f,sheetId,scope,uid){
 for(const r of scope.racks){
  const fd=new FormData();fd.append('slot','rack_front');fd.append('target_id',String(r.id));fd.append('file',new Blob([MIN_PNG],{type:'image/png'}),'p.png');
  const resp=await fetch(f.base+'/api/it-assets/inspections/sheets/'+sheetId+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-'+uid},body:fd});
  assert.equal(resp.status,201,'uploadAllRackFrontPhotos '+JSON.stringify(await resp.json().catch(()=>null)));
 }
}
async function main(){
 // C7：假采集器不再需要throw/wait/identity等模式切换（那套单飞/竞态/异常路径已在
 // verify-it-ledger-inspection-collect.js 通过巡检单入口覆盖，见交付报告）——本文件只需要能定制
 // sn（匹配目标资产身份）与alerts（供告警数列取值）的最小采集器，返回值直接就是要落库的快照形状
 // （inspection-collect.js:collectSnapshot 直接使用collector.collect()的返回值，不再包一层
 // normalize()——与该文件里makeFakeCollector同一手法）。
 let calls=0;const collectorState={sn:'',alerts:[]};
 const collector={host:()=>HOST,collect:async()=>{calls++;const now=new Date().toISOString();return {schema_version:1,source_host:HOST,started_at:now,completed_at:now,server:{name:'srv',manufacturer:'x',model:'y',serial_number:collectorState.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:collectorState.alerts,component_errors:[],cleanup_warnings:[],collection_status:'success'};}};
 const f=await createFixture({inspectionCollector:collector});let browser;console.log('ISOLATED_ARTIFACTS='+f.dir);
 try{
  // ============================================================
  // 一、normalize() 纯函数告警逻辑（与路由无关，原样保留）。
  // ============================================================
  const healthy=()=>{const r=raw();r.volumes[0].free_bytes=50000000000;r.controllers[0].pdisk='ID : 0:0:1\nState : Online\nStatus : Ok\nFailure Predicted : No';r.controllers[0].vdisk='ID : 0\nName : VD1\nState : Ready\nStatus : Ok\nLayout : RAID-1';r.controllers[0].enclosure='ID : 0:0\nName : Backplane\nState : Ready\nStatus : Ok';return r;};
  const kinds=r=>normalize(r).alerts.map(x=>x.kind+':'+x.severity).join(',');
  check('全部正常时零告警',kinds(healthy())===''&&normalize(healthy()).collection_status==='success');
  let n=healthy();n.controllers[0].enclosure='ID : 0:0\nName : MD1200\nState : Degraded\nStatus : Non-Critical';check('仅磁盘柜降级即告警',kinds(n)==='enclosure:attention');
  n=healthy();n.controllers[0].enclosure='ID : 0:0\nName : MD1200\nState : Ready\nStatus : Critical';check('磁盘柜严重状态为严重告警',kinds(n)==='enclosure:critical');
  n=healthy();n.controllers[0].vdisk='ID : 0\nName : VD1\nState : Ready\nStatus : Non-Critical\nLayout : RAID-1';check('虚拟盘Ready但状态异常告警',kinds(n)==='raid_warning:attention');
  n=healthy();n.controllers[0].pdisk='ID : 0:0:7\nState : Ready\nStatus : Non-Critical\nFailure Predicted : No';check('热备盘状态异常告警',kinds(n)==='disk_warning:attention');
  n=healthy();n.controllers[0].pdisk='ID : 0:0:7\nState : Ready\nStatus : Critical\nFailure Predicted : No';check('热备盘Critical为严重告警',kinds(n)==='disk_warning:critical');
  n=healthy();n.controllers[0].vdisk='ID : 0\nName : VD1\nState : Ready\nStatus : Critical\nLayout : RAID-1';check('虚拟盘Ready但Critical为严重告警',kinds(n)==='raid_warning:critical');
  n=healthy();n.controllers[0].enclosure='ID : 0:0\nName : MD1200\nState : Ready';const noStatus=normalize(n);check('磁盘柜缺状态字段记为采集不完整而非告警',kinds(n)===''&&noStatus.collection_status==='partial'&&noStatus.component_errors.some(x=>x.includes('状态字段未取得')));
  n=healthy();n.controllers[0].enclosure='ID : 0:0\nName : MD1200\nStatus : Critical';const noState=normalize(n);check('缺State但已知Critical仍为严重告警',kinds(n)==='enclosure:critical'&&noState.collection_status==='partial');
  n=healthy();n.controllers[0].enclosure='ID : 0:0\nName : MD1200\nState : Degraded';check('缺Status但已知降级仍告警',kinds(n)==='enclosure:attention'&&normalize(n).collection_status==='partial');
  n=healthy();n.volumes=[{name:'E:',filesystem:'RAW',size_bytes:null,free_bytes:null}];const noVol=normalize(n);check('卷全部无效不重复报未取得卷',noVol.volumes.length===0&&noVol.component_errors.filter(x=>x.includes('卷')).length===1);
  n=healthy();n.volumes.push({name:'E:',filesystem:'RAW',size_bytes:null,free_bytes:null});n.controllers[0].vdisk='ID : 0\nName : VD1\nState : Degraded\nStatus : Non-Critical\nLayout : RAID-5';const bad=normalize(n);
  check('单卷无效只跳过该卷且保留阵列告警',bad.collection_status==='partial'&&bad.volumes.length===1&&bad.component_errors.some(x=>x.includes('E:'))&&kinds(n)==='raid:critical');
  // C7新增：不泄露采集器未声明字段——原来这条断言经POST /inspections真实请求走一圈，路由退役后
  // 改为直接验证normalize()本身的行为（normalize()对server做的是"挑7个命名字段重建对象"，不是
  // 原样透传raw.server，password这类未声明字段在这一步就已经被丢弃，与请求管线无关）。
  check('C7:normalize()不透传server未声明字段(password类)',!JSON.stringify(normalize(raw())).includes('must-not-leak'));

  // ============================================================
  // 二、摘要表数据准备——三台设备：a(草稿单,带告警,未判断)、b(已提交后被管理员逻辑删除,已判断)、
  //    c(从无巡检记录,测空状态)。a 上再直接SQL插一条从未归属任何巡检单的历史行(生产不存在,仅本地
  //    测试数据,方案v0.6 §6原文)。
  // ============================================================
  const rkA=(await f.api('POST','/racks',{name:'巡检柜A',room:'巡检机房A',u_total:12})).body;
  const a=(await f.api('POST','',{category:'server',name:'巡检服务器A',sn:'INSPECT-SN',attrs:{ip:HOST},u_height:2,placement:{kind:'rack',rack_id:rkA.id,u_start:1}})).body;
  const rkB=(await f.api('POST','/racks',{name:'巡检柜B',room:'巡检机房B',u_total:12})).body;
  const b=(await f.api('POST','',{category:'server',name:'巡检服务器B',sn:'INSPECT-SN-B',attrs:{ip:HOST},u_height:2,placement:{kind:'rack',rack_id:rkB.id,u_start:1}})).body;
  const c=(await f.api('POST','',{category:'server',name:'巡检服务器C(无记录)',sn:'INSPECT-SN-C',attrs:{ip:HOST},u_height:2,placement:{kind:'depot'}})).body;
  const laptop=(await f.api('POST','',{category:'laptop',name:'非服务器设备',placement:{kind:'depot'}})).body;
  // 干扰单——只用来证明点击跳转没有走错单据，不参与采集。
  await f.api('POST','/racks',{name:'干扰柜',room:'干扰机房',u_total:4});
  const distractor=(await f.api('POST','/inspections/sheets',{room_name:'干扰机房'})).body;

  const sheetA=(await f.api('POST','/inspections/sheets',{room_name:'巡检机房A'},2)).body;
  const detailA1=(await f.api('GET','/inspections/sheets/'+sheetA.id,undefined,2)).body;
  const itemA=deviceItemOf(detailA1,a.id);
  collectorState.sn='INSPECT-SN';collectorState.alerts=[{severity:'attention',kind:'volume_space',message:'卷 C: 可用空间不足'}];
  const collectA=await f.api('POST','/inspections/sheets/'+sheetA.id+'/items/'+itemA.id+'/collect',undefined,2);
  check('准备:A草稿采集201且带1条告警',collectA.status===201&&collectA.body.inspection.snapshot.alerts.length===1,collectA.body);
  const recordA=collectA.body.inspection.id;
  // A留在draft、不判断——摘要表要展示"未判断"这个取值,同时是可见行(巡检人本人uid2/管理员)与受限行
  // (他人uid3)两种视角的载体。

  // 从未归属任何巡检单的历史行——直接SQL插入（方案v0.6 §6：生产不存在,只有本地测试数据）。
  const legacyNow=new Date().toISOString();
  const legacySnapshot=JSON.stringify({schema_version:1,source_host:HOST,server:{serial_number:'INSPECT-SN'},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:legacyNow,completed_at:legacyNow});
  const insLegacy=await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)',[a.id,a.name,HOST,legacyNow,legacyNow,'success',legacySnapshot,1]);
  const recordLegacy=insLegacy.lastID;

  const sheetB=(await f.api('POST','/inspections/sheets',{room_name:'巡检机房B'},2)).body;
  const detailB1=(await f.api('GET','/inspections/sheets/'+sheetB.id,undefined,2)).body;
  const itemB=deviceItemOf(detailB1,b.id);
  collectorState.sn='INSPECT-SN-B';collectorState.alerts=[];
  const collectB=await f.api('POST','/inspections/sheets/'+sheetB.id+'/items/'+itemB.id+'/collect',undefined,2);
  check('准备:B草稿采集201且零告警',collectB.status===201&&collectB.body.inspection.snapshot.alerts.length===0,collectB.body);
  const recordB=collectB.body.inspection.id;
  const detailB2=(await f.api('GET','/inspections/sheets/'+sheetB.id,undefined,2)).body;
  const putB=await f.api('PUT','/inspections/sheets/'+sheetB.id,{expected_version:detailB2.version,items:fillPayloadAllOk(detailB2.items),remark:null},2);
  check('准备:B补全200(检查项含目标行result=ok)',putB.status===200,putB.body);
  await uploadAllRackFrontPhotos(f,sheetB.id,sheetB.scope,2);
  const submitB=await f.api('POST','/inspections/sheets/'+sheetB.id+'/submit',{expected_version:putB.body.version},2);
  check('准备:B提交200',submitB.status===200,submitB.body);
  const deleteB=await f.api('DELETE','/inspections/sheets/'+sheetB.id,{expected_version:submitB.body.version,reason:'C7摘要表测试:管理员逻辑删除'},1);
  check('准备:管理员逻辑删除B所在单200',deleteB.status===200,deleteB.body);

  // MED-3（C7-c，Opus预筛）：B此前只覆盖了"正常"渲染，"异常"这一支从未有断言证明过（P2类"bad也渲染
  // 成正常"这种回归测不出来）——设备D，检查项PUT成bad，断言摘要表判断结果列显示"异常"。
  const rkD=(await f.api('POST','/racks',{name:'巡检柜D',room:'巡检机房D',u_total:12})).body;
  const d=(await f.api('POST','',{category:'server',name:'巡检服务器D',sn:'INSPECT-SN-D',attrs:{ip:HOST},u_height:2,placement:{kind:'rack',rack_id:rkD.id,u_start:1}})).body;
  const sheetD=(await f.api('POST','/inspections/sheets',{room_name:'巡检机房D'},2)).body;
  const detailD1=(await f.api('GET','/inspections/sheets/'+sheetD.id,undefined,2)).body;
  const itemD=deviceItemOf(detailD1,d.id);
  collectorState.sn='INSPECT-SN-D';collectorState.alerts=[];
  const collectD=await f.api('POST','/inspections/sheets/'+sheetD.id+'/items/'+itemD.id+'/collect',undefined,2);
  check('准备:D草稿采集201',collectD.status===201,collectD.body);
  const recordD=collectD.body.inspection.id;
  const detailD2=(await f.api('GET','/inspections/sheets/'+sheetD.id,undefined,2)).body;
  const fillItemsD=fillPayloadAllOk(detailD2.items).map(it=>it.id===itemD.id?{...it,result:'bad',note:'C7-c测试:检查项结果异常'}:it);
  const putD=await f.api('PUT','/inspections/sheets/'+sheetD.id,{expected_version:detailD2.version,items:fillItemsD,remark:null},2);
  check('准备:D补全200(检查项含目标行result=bad)',putD.status===200,putD.body);
  // L3（C7-c，Opus预筛）：假采集器固定给started_at/completed_at同一个now值，没法用它区分摘要表
  // "采集时间"列到底取的是哪个字段——直接SQL把D这条记录的started_at改成一个与completed_at明显不同
  // 的固定时间，下面浏览器断言据此核对渲染出来的确实是started_at而不是completed_at。
  const distinctStartedAtD='2020-06-15T08:00:00.000Z';
  await f.run('UPDATE it_device_inspections SET started_at=? WHERE id=?',[distinctStartedAtD,recordD]);

  // ============================================================
  // 三、接口层数据核对（摘要表数据来源）：可见行/受限行/不归属行三种，item_result 取值。
  // ============================================================
  const listAOwner=(await f.api('GET','/inspections?asset_id='+a.id,undefined,2)).body.items;
  const rowAFull=listAOwner.find(r=>r.id===recordA);
  check('接口:A(巡检人本人)full可见,alert_count=1,item_result为null(未判断)',rowAFull&&rowAFull.alert_count===1&&rowAFull.item_result===null&&rowAFull.sheet_ref.linkable===true,rowAFull);
  const rowLegacyOwner=listAOwner.find(r=>r.id===recordLegacy);
  check('接口:未归属历史行sheet_ref为null(前端据此显示"单独巡检(已停用)")',rowLegacyOwner&&rowLegacyOwner.sheet_ref===null,rowLegacyOwner);
  // 46T1 H1（codex审）：受限行此前只查restricted标记及两个字段缺失，额外泄露其它字段(比如
  // judgement_note/collection_status等)仍会通过；改成键集合与五键白名单全等比较，且显式核
  // sheet_ref.linkable===false（不可点）。
  const keySet=(obj)=>Object.keys(obj).sort().join(',');
  const RESTRICTED_KEYS=keySet({id:0,asset_id:0,started_at:0,sheet_ref:0,restricted:0});
  const listAOther=(await f.api('GET','/inspections?asset_id='+a.id,undefined,3)).body.items;
  const rowARestricted=listAOther.find(r=>r.id===recordA);
  check('接口:A(他人uid3)受限行键集合与五键白名单完全相等',!!rowARestricted&&keySet(rowARestricted)===RESTRICTED_KEYS,rowARestricted);
  check('接口:A(他人uid3)受限行restricted===true且sheet_ref.linkable===false',!!rowARestricted&&rowARestricted.restricted===true&&rowARestricted.sheet_ref&&rowARestricted.sheet_ref.linkable===false,rowARestricted);
  const listBAdmin=(await f.api('GET','/inspections?asset_id='+b.id,undefined,1)).body.items;
  const rowBAdmin=listBAdmin.find(r=>r.id===recordB);
  check('接口:B(管理员,单已删除仍full)item_result为ok',rowBAdmin&&rowBAdmin.item_result==='ok'&&rowBAdmin.sheet_ref.status==='deleted'&&rowBAdmin.sheet_ref.linkable===true,rowBAdmin);
  // C7-d（codex 46S H，与源码fix第1条一致）：sheetB已被管理员逻辑删除——对非管理员（哪怕是这张单
  // 原本的巡检人uid2）sheetVisibility恰恰判none（deleted_at分支：非admin恒none，不看是不是owner）。
  // 原断言"受限行restricted===true"本身就与方案§4.2矛盾——旧实现确实会返回一行受限摘要，泄露"存在
  // 这条记录、归属一张已删除的单"；改为断言这一行整行不出现。
  const listBOwner=(await f.api('GET','/inspections?asset_id='+b.id,undefined,2)).body.items;
  const rowBOwner=listBOwner.find(r=>r.id===recordB);
  check('C7-d:B(巡检人本人uid2,单已删除对非管理员是none)该记录不在列表中(方案§4.2不暴露是否存在)',rowBOwner===undefined,rowBOwner);
  const listDOwner=(await f.api('GET','/inspections?asset_id='+d.id,undefined,2)).body.items;
  const rowDOwner=listDOwner.find(r=>r.id===recordD);
  check('接口:D(巡检人本人)item_result为bad(MED-3,此前只测过ok这一支)',rowDOwner&&rowDOwner.item_result==='bad',rowDOwner);

  // ============================================================
  // 四、浏览器：摘要表渲染、点击跳转、无退役控件、空状态。
  // ============================================================
  browser=await chromium.launch({headless:true});const c1=await browser.newContext({viewport:{width:1440,height:960}});await c1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const p=await c1.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(f.base+'/IT_Ledger.html#all');await p.locator('[data-tab="all"][aria-current="page"]').waitFor();
  await p.locator('[data-detail="'+a.id+'"]').click();await p.locator('[data-server-detail-tab="inspection"]').click();
  await p.locator('#itlInspectionRoot table tbody tr').first().waitFor();
  check('页签上不存在已退役控件(一键采集/判断表单/附件上传/快照详情)',
    await p.locator('#itlCollectInspection').count()===0&&await p.locator('#itlInspectionReview').count()===0&&await p.locator('[data-evidence-file]').count()===0&&await p.locator('#itlInspectionDetail').count()===0);
  const rows=p.locator('#itlInspectionRoot table tbody tr');
  check('摘要表两行(A可见行+未归属历史行)',await rows.count()===2);
  const fullRow=rows.filter({hasText:'见巡检单'});await fullRow.first().waitFor();
  const fullCells=await fullRow.first().locator('td').allInnerTexts();
  check('可见行(A):采集状态=采集完成,告警数=1 项,判断结果=未判断',fullCells[2]==='采集完成'&&fullCells[3]==='1 项'&&fullCells[4]==='未判断',fullCells);
  const legacyRow=rows.filter({hasText:'单独巡检（已停用）'});await legacyRow.first().waitFor();
  check('不属于任何巡检单的历史行:文字为"单独巡检（已停用）"且不可点',await legacyRow.locator('button').count()===0);

  // 点击可见行的归属按钮——落到sheetA的填写页（巡检人本人对自己的草稿有编辑动作），核对data-sheet-id
  // 不是干扰单。
  await fullRow.locator('[data-open-sheet]').click();
  await p.locator('#itlFormBack').waitFor();
  check('点击跳转:落到sheetA填写页(data-sheet-id精确匹配,非干扰单)',await p.locator('[data-sheet-id="'+sheetA.id+'"]').count()===1&&await p.locator('[data-sheet-id="'+distractor.id+'"]').count()===0);
  check('浏览器无未捕获异常(本人视角)',errors.length===0);
  await c1.close();

  // MED-3（C7-c，Opus预筛）：设备D的检查项被PUT成bad——摘要表判断结果列应显示"异常"，不是"正常"
  // （P2类"results映射表把bad也写成'正常'"这种回归，此前全程只用过result='ok'的设备测，测不出来）。
  const cd=await browser.newContext({viewport:{width:1440,height:960}});await cd.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pd=await cd.newPage();const errorsD=[];pd.on('pageerror',e=>errorsD.push(e.message));
  await pd.goto(f.base+'/IT_Ledger.html#all');await pd.locator('[data-tab="all"][aria-current="page"]').waitFor();
  await pd.locator('[data-detail="'+d.id+'"]').click();await pd.locator('[data-server-detail-tab="inspection"]').click();
  await pd.locator('#itlInspectionRoot table tbody tr').first().waitFor();
  const rowD=pd.locator('#itlInspectionRoot table tbody tr',{hasText:'见巡检单'});await rowD.waitFor();
  const cellsD=await rowD.locator('td').allInnerTexts();
  check('MED-3:检查项result=bad的设备,摘要表判断结果列显示"异常"',cellsD[4]==='异常',cellsD);
  check('L3:可见行采集时间列取started_at(不是completed_at)',cellsD[0]===new Date(distinctStartedAtD).toLocaleString('zh-CN'),cellsD);
  check('浏览器无未捕获异常(D异常渲染视角)',errorsD.length===0);
  await cd.close();

  // 他人(uid3)视角——A受限行：归属列文案不可点，其余三列"—"。
  const c3=await browser.newContext({viewport:{width:1440,height:960}});await c3.addInitScript(()=>localStorage.setItem('token','fixture-3'));const p3=await c3.newPage();const errors3=[];p3.on('pageerror',e=>errors3.push(e.message));
  await p3.goto(f.base+'/IT_Ledger.html#all');await p3.locator('[data-tab="all"][aria-current="page"]').waitFor();
  await p3.locator('[data-detail="'+a.id+'"]').click();await p3.locator('[data-server-detail-tab="inspection"]').click();
  await p3.locator('#itlInspectionRoot table tbody tr').first().waitFor();
  const restrictedRow=p3.locator('#itlInspectionRoot table tbody tr',{hasText:'填写中'});await restrictedRow.waitFor();
  check('受限行(他人uid3):归属列文案含"填写中"且不可点',await restrictedRow.locator('[data-open-sheet]').count()===0);
  const restrictedCells=await restrictedRow.locator('td').allInnerTexts();
  check('受限行(他人uid3):采集状态/告警数/判断结果三列均为—',restrictedCells[2]==='—'&&restrictedCells[3]==='—'&&restrictedCells[4]==='—',restrictedCells);
  check('浏览器无未捕获异常(他人视角)',errors3.length===0);
  await c3.close();

  // 管理员视角——B已删除单：摘要行归属可点，点击落到只读详情页（非填写页），核对data-sheet-id。
  const c4=await browser.newContext({viewport:{width:1440,height:960}});await c4.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p4=await c4.newPage();const errors4=[];p4.on('pageerror',e=>errors4.push(e.message));
  await p4.goto(f.base+'/IT_Ledger.html#all');await p4.locator('[data-tab="all"][aria-current="page"]').waitFor();
  await p4.locator('[data-detail="'+b.id+'"]').click();await p4.locator('[data-server-detail-tab="inspection"]').click();
  await p4.locator('#itlInspectionRoot table tbody tr').first().waitFor();
  const adminRow=p4.locator('#itlInspectionRoot table tbody tr',{hasText:'见巡检单'});await adminRow.waitFor();
  const adminCells=await adminRow.locator('td').allInnerTexts();
  check('可见行(管理员看已删除单B):判断结果=正常',adminCells[4]==='正常',adminCells);
  // L10（C7-c，Opus预筛）：管理员看到的这一行归属的巡检单其实已经被删除了（sheet_ref.status===
  // 'deleted'，只是full可见仍linkable），摘要表按钮文字应该带"（已删除）"后缀提前示警，不能点开才
  // 发现是空欢喜一场。
  check('L10:管理员看已删除单,归属按钮文字带"（已删除）"后缀',adminCells[1]===`见巡检单 #${sheetB.id}（已删除）`,adminCells);
  await adminRow.locator('[data-open-sheet]').click();
  await p4.locator('#itlSheetBack').waitFor();
  check('管理员点击已删除单:落到只读详情页(#itlSheetBack,非#itlFormBack),data-sheet-id精确匹配非干扰单',
    await p4.locator('#itlSheetBack').count()===1&&await p4.locator('#itlFormBack').count()===0&&await p4.locator('[data-sheet-id="'+sheetB.id+'"]').count()===1&&await p4.locator('[data-sheet-id="'+distractor.id+'"]').count()===0);
  // H2（codex 46T1→46-R两轮）：落页只核data-sheet-id/#itlSheetBack不够——若正确跳到了该单，却错误
  // 显示成可编辑页面或漏了"已删除"提示，只核编号的断言测不出来。46-R指出"只查#itlFormActionbar/
  // [data-collect-id]/[data-all-normal]"这三个特定选择器本身就是漏洞——编辑/保存/删除按钮若出现在
  // 这三个选择器之外（比如未来加了个不挂在这些容器里的按钮），断言测不出来。改为在#itlContent范围内
  // 全扫：①不存在任何文本恰好是"编辑/提交/保存/删除/提交巡检/保存修改"的按钮（不依赖特定选择器，
  // 依赖文案本身，覆盖任何写法的按钮）；②不存在任何未disabled的input/textarea；③不存在任何未
  // disabled的开关按钮（aria-pressed语义、或本仓检查项二态开关用的data-seg-ok/data-seg-bad标记）。
  const deletedTitleText=await p4.locator('.itl-sheet-title h2').innerText();
  check('H2(codex46T1):管理员点击已删除单,详情页标题含"已删除"标识',deletedTitleText.includes('已删除'),deletedTitleText);
  const deletedPageScanB=await p4.evaluate(()=>{
   const root=document.getElementById('itlContent');
   if(!root)return null;
   const FORBIDDEN_TEXTS=['编辑','提交','保存','删除','提交巡检','保存修改'];
   // H2（codex 46-R2，C7-f）：只查textContent漏掉"图标按钮，可访问名称只靠aria-label/title表达"这种
   // 写法——accessible name三选一(textContent/aria-label/title)任一命中即判违规；扫描范围从<button>
   // 扩到<button>/[role="button"]/<a>（链接态的"编辑"入口、role=button的自定义控件同样违规）。
   const controls=[...root.querySelectorAll('button,[role="button"],a')];
   // 46-R3 H1：三个字段分别检查（不是取第一个非空值）——图标文字 + aria-label="编辑" 同时存在时也要命中。
   const nameFields=el=>[(el.textContent||'').trim(),(el.getAttribute('aria-label')||'').trim(),(el.getAttribute('title')||'').trim()];
   const badButtons=controls.filter(el=>nameFields(el).some(v=>FORBIDDEN_TEXTS.includes(v))).map(el=>el.outerHTML.slice(0,160));
   const enabledInputs=[...root.querySelectorAll('input,textarea')].filter(el=>!el.disabled).map(el=>el.outerHTML.slice(0,120));
   const enabledToggles=[...root.querySelectorAll('button[aria-pressed],[data-seg-ok],[data-seg-bad]')].filter(b=>!b.disabled).map(b=>b.outerHTML.slice(0,120));
   // H2（codex 46-R2）第2条：操作类数据属性——前端实际用到的写操作标记前缀（grep自
   // it-ledger-inspection-sheets.js的<button>模板）：data-collect-id(一键采集)/data-all-normal(本段
   // 全部正常)/data-insp-delete-draft(删除草稿)/data-insp-delete-submitted(逻辑删除)/
   // data-insp-edit(编辑入口)/data-insp-unarchive(撤回)/data-insp-restore(恢复)/data-photo-upload(上传)/
   // data-photo-delete(删除照片)/data-pending-decision(丢弃待生效照片)；data-seg-ok/data-seg-bad已被
   // 上面enabledToggles覆盖，这里不重复列。这几个属性只在可写的填写页(renderForm)与台账列表行里出现，
   // 只读详情页(renderDetailView，本次落地页)从不渲染它们——不论disabled与否，只要#itlContent范围内
   // 出现任何一个，就说明写路径的DOM结构被错误地复用/泄露到了这张已删除单的只读详情页。
   const ACTION_DATA_ATTRS=['data-collect-id','data-all-normal','data-insp-delete-draft','data-insp-delete-submitted','data-insp-edit','data-insp-unarchive','data-insp-restore','data-photo-upload','data-photo-delete','data-pending-decision'];
   const actionAttrNodes=[...root.querySelectorAll(ACTION_DATA_ATTRS.map(a=>'['+a+']').join(','))].map(el=>el.outerHTML.slice(0,160));
   return {badButtons,enabledInputs,enabledToggles,actionAttrNodes};
  });
  check('H2(codex46-R2):管理员点击已删除单,详情页(#itlContent范围内,button/[role=button]/a按可访问名称textContent/aria-label/title三选一)不存在名称为"编辑/提交/保存/删除/提交巡检/保存修改"的控件',!!deletedPageScanB&&deletedPageScanB.badButtons.length===0,deletedPageScanB);
  check('H2(codex46-R):管理员点击已删除单,详情页不存在任何未disabled的input/textarea',!!deletedPageScanB&&deletedPageScanB.enabledInputs.length===0,deletedPageScanB);
  check('H2(codex46-R):管理员点击已删除单,详情页不存在任何未disabled的开关按钮',!!deletedPageScanB&&deletedPageScanB.enabledToggles.length===0,deletedPageScanB);
  check('H2(codex46-R2):管理员点击已删除单,详情页不存在任何写操作数据属性标记(含照片上传/删除与pending决策)',!!deletedPageScanB&&deletedPageScanB.actionAttrNodes.length===0,deletedPageScanB);
  check('浏览器无未捕获异常(管理员视角)',errors4.length===0);
  await c4.close();

  // 空状态 + 非服务器无入口——复用同一个上下文。
  const c5=await browser.newContext({viewport:{width:1440,height:960}});await c5.addInitScript(()=>localStorage.setItem('token','fixture-2'));const p5=await c5.newPage();const errors5=[];p5.on('pageerror',e=>errors5.push(e.message));
  await p5.goto(f.base+'/IT_Ledger.html#all');await p5.locator('[data-tab="all"][aria-current="page"]').waitFor();
  await p5.locator('[data-detail="'+c.id+'"]').click();await p5.locator('[data-server-detail-tab="inspection"]').click();
  await p5.locator('.itl-empty',{hasText:'暂无巡检记录'}).waitFor();
  check('空状态文案:"暂无巡检记录，巡检在「巡检台账」中进行。"',(await p5.locator('#itlAssetInspections').innerText()).includes('暂无巡检记录，巡检在「巡检台账」中进行。'));
  await p5.locator('#itlDrawerClose').click();await p5.locator('[data-detail="'+laptop.id+'"]').click();await p5.locator('#itlAssetProfile').waitFor();
  check('非服务器无巡检入口',await p5.locator('[data-server-detail-tab="inspection"]').count()===0);
  check('浏览器无未捕获异常(空状态/非服务器视角)',errors5.length===0);
  await c5.close();

  check('假采集器共调用3次(A、B、D各一次采集,legacy行是直接SQL插入不经采集器)',calls===3);
  console.log(`INSPECTIONS_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
