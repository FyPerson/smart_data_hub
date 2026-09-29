'use strict';
const { expandInspectionForm } = require('./it-ledger-plan-b-test-helpers');
// LOW（C5a-1c，重写文件头以对齐块 A–S 的实际内容——只做只读详情页这一个切片；新建/草稿填写/写队列/
// 采集/提交/删除/管理员动作仍是占位 toast，见 handoff-agent6.md 的设计留档）。
// A: owner 视角看带异常的已提交单——工具条/异常卡/读数(具体数值)/正常项展开区(item_label 与 target_label
//    分别断言)/操作记录(含 create/submit、实际条数与倒序动作)/无归档提示/状态说明含
//    "归档前可编辑、删除"。
// B: 管理员视角已归档单——归档提示条单一文案(不再区分 admin/非 admin)；紧跟着的额外校验：非管理员看到
//    完全相同的文案（LOW-2，证明确实不再按角色差异化）。
// C: 只读用户（不在 actions.save 里）看到"已提交 · 只读"兜底文案（LOW-3，不再前端推算"谁能编辑"）。
// D: 草稿行点击/新增巡检仍是占位（管理员看他人草稿，走的是 status==='draft' 分支，不是 summary）。
// E: 写权限非管理员看他人草稿（真正的 summary 可见度）——摘要行无按钮、点击占位、零请求。
// F/G: 详情 GET 404 / 网络异常时 openDetail() 自己的恢复路径（H1）——404 自动回列表+toast，非404 留错误
//    卡片+可用的"返回巡检台账"按钮；两者都正确重置 mode/detailId，不会在切走切回后重发同一个必败请求。
// H: 一机房多设备——正常项设备行按 target_label 显示具体设备名，不重复"前面板与告警灯"(M4)。
// I: 机房名/备注/异常说明/正常设备名的 XSS payload 原样显示为纯文本（M5）。
// J: 管理员查看已被别处删除的已提交单（sheetVisibility 对已删除单管理员仍 full）——"已删除"提示条含
//    删除原因(含 XSS payload,M-3)、有 restore 动作时显示"如需恢复"(LOW-3)、标题徽章为"已删除"而不是
//    "已提交（待归档）"(M-4)，状态说明不再出现"可编辑"。
// K: 点行(非按钮区域)也能打开详情页(M6)。
// L: 详情 GET 挂起期间切到"机房"，放行成功响应不覆盖已切走的视图(M2 案例①)。
// N: 连点两张不同的单，后点的赢，先点的迟到响应不覆盖(M2 案例②，用"挂回脱离文档的按钮节点"手法构造
//    真实UI下无法直接构造的两次点击)。
// O: 正常项某个分组(机房)全部异常时，该分组整段不显示，其余分组不受影响(LOW-4)。
// P: openDetail() catch 分支自己的守卫——挂起详情响应期间切到"机房"，放行失败(网络异常/404)不覆盖已
//    切走的机房视图，也不弹"已不存在"toast(M-1，并入预筛探针 probe-c5a-prescreen.js 的 P-abort/P-404)。
// Q: 五元守卫里 marker.isConnected 唯一必要的真实场景——挂起详情响应期间，过了10秒刷新节流后重新点击
//    "巡检"页签(哪怕已经在这个页签上)，autoRefresh 同步换刷新占位，seq/tab/mode/detailId 全部不变，只有
//    marker.isConnected 能识别出内容区已被换掉(M-2 P1，用 page.clock 假时钟推过节流窗口)。
// R: 同 id 重开——挂起旧请求，切走切回并重开同一张单(新请求成功渲染)，旧请求随后才失败到达，不会覆盖
//    新渲染的详情(M-2 同 id 用例，能分辨新旧的只有 seq，detailId 对两次请求都相同)。
// S: XSS 覆盖收尾——created_by_name(专用 fixture-5，避免污染共享测试用户名)、正常机柜名(target_label)、
//    异常列表里判异常的设备的 target_label(M-3)。
const assert=require('assert/strict'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
let pass=0;const check=(n,v,d)=>{if(!v&&d!==undefined)console.error('DETAIL',n,JSON.stringify(d));assert.ok(v,n);pass++;console.log('[OK] '+n);};
const NUMBER_DEFAULT={temperature:22,humidity:45};
const MIN_JPEG_BYTES=Buffer.from([0xff,0xd8,0xff,0xe0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0xff,0xd9]);
// C5a 段3：写队列/冲突/onLeave 一批用例的通用挂起写法——转发真实请求拿到响应，entered resolve 后 hold
// 住，调用方在别处推进场景，再 release() 放行 fulfill（同 handoff-agent9.md §4.3 的写法，抽成助手避免
// 每条用例重复一遍这段样板）。
// 与 it-ledger-inspection-sheets.js 里 dateOnly()/sheetLabel() 的格式完全一致——H1/H3 一批"离开后"提示
// 文案断言要拼出与前端相同的〈机房 · 日期〉标签，不能复用 time()（那是本地化的完整时间字符串，格式不同）。
const dateOnlyStr=s=>{const d=new Date(s);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
const sheetLabelStr=row=>row.room_name+' · '+dateOnlyStr(row.created_at);
function holdRoute(page,pattern,methodFilter){
 let enteredResolve,release;
 const entered=new Promise(r=>enteredResolve=r),held=new Promise(r=>release=r);
 page.route(pattern,async route=>{
  if(methodFilter&&route.request().method()!==methodFilter)return route.fallback();
  const response=await route.fetch();enteredResolve();await held;await route.fulfill({response});
 });
 return {entered,release:()=>release()};
}
// C5a-b：holdRoute 转发真实请求拿到响应之后才"挂住"——服务端在entered resolve那一刻就已经处理完这次
// 请求（route.fetch()本身就是完整的网络往返），只适合"迟到的成功/失败响应会不会覆盖后来的视图"这类
// 场景（Q/L1等），不能用来构造"请求还在飞行时，服务端状态被别处改变，导致这次请求最终409"——那需要在
// 请求真正发给服务器**之前**就拦住。holdRequestRoute 挂住的是请求本身（route.fallback()才真正放行给
// 服务器），调用方可以在entered与release之间安全地修改服务端状态。
function holdRequestRoute(page,pattern,methodFilter){
 let enteredResolve,release;
 const entered=new Promise(r=>enteredResolve=r),held=new Promise(r=>release=r);
 page.route(pattern,async route=>{
  if(methodFilter&&route.request().method()!==methodFilter)return route.fallback();
  enteredResolve();await held;await route.fallback();
 });
 return {entered,release:()=>release()};
}
async function reachedWithin(promise,label){
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+' 未在5秒内到达')),5000);})]);}
 finally{clearTimeout(timer);}
}
// M5（C5a-f）：包一层 L.notice，记录调用序列——离开失败/冲突类提示（notifyLeaveFlushFailure/
// notifyExcludedConflicts/handleConflict 的 formVisible 分支）要求"恰好调用1次"，不能只看#itlNotice
// 最终文本（那只能证明"最后一条是什么"，证明不了"中途有没有多发过一条又被覆盖"）。装在goto之后、
// 触发动作之前；只装一次（__noticeCallsPatched 去重，防止同一个page被多次调用时重复包裹）。
async function installNoticeCounter(page){
 await page.evaluate(()=>{
  window.__noticeCalls=window.__noticeCalls||[];
  if(window.__noticeCallsPatched)return;
  window.__noticeCallsPatched=true;
  const orig=window.ITLedger.notice;
  window.ITLedger.notice=m=>{window.__noticeCalls.push(m);return orig(m);};
 });
}
// 统计"离开失败/冲突"类提示——覆盖三种措辞来源：notifyLeaveFlushFailure/notifyExcludedConflicts的
// "离开时有修改未能保存"、handleConflict可见分支的"这张单已在别处被修改"、performSubmit销毁分支409的
// "未能提交：这张单已在别处被修改"。sinceIndex(默认0)：部分用例(如BC/BD/BE)在真正"离开"之前，为了
// 制造冲突标记会先经历一次formVisible分支的handleConflict通知(在场景准备阶段，不是离开阶段本身)，
// 那一条不该被计进"离开这一步是否恰好1次"——调用方在触发离开动作前先记 noticeCallsLength(page) 当
// baseline，这里从那之后开始数。
// N-L6（C5a-g）：离开失败/排除冲突的一次性提醒改短句"有内容未能保存，详见巡检台账顶部"（原文迁到
// 常驻条），过滤模式同步更新；"这张单已在别处被修改"（handleConflict可见分支/performSubmit销毁分支
// 409）维持原样，不受N-L6影响。
async function leaveOrConflictNoticeCount(page,sinceIndex){
 return page.evaluate(since=>window.__noticeCalls.slice(since||0).filter(m=>m.includes('有内容未能保存')||m.includes('这张单已在别处被修改')).length,sinceIndex);
}
async function noticeCallsLength(page){ return page.evaluate(()=>window.__noticeCalls.length); }
async function main(){
 const f=await createFixture();console.log('ISOLATED_ARTIFACTS='+f.dir);let browser;
 async function makeRoom(roomName){const r=(await f.api('POST','/racks',{name:roomName+'-柜1',room:roomName,u_total:20})).body;await f.api('POST','',{category:'server',name:roomName+'-设备1',u_height:1,placement:{kind:'rack',rack_id:r.id,u_start:1}});return r;}
 // M4/M5（C5a-1b）：一个机房挂多台设备的夹具助手——makeRoom()只建一台设备，M4需要至少两台才能证明
 // "设备"行不再重复显示同一句共享模板项文案。
 async function makeRoomWithDevices(roomName,deviceNames){const r=(await f.api('POST','/racks',{name:roomName+'-柜1',room:roomName,u_total:20})).body;let u=1;for(const name of deviceNames){await f.api('POST','',{category:'server',name,u_height:1,placement:{kind:'rack',rack_id:r.id,u_start:u}});u+=1;}return r;}
 // T（codex 42 M1）：一个机房挂多个机柜的夹具助手——M1 需要至少两个机柜（一柜全异常、另一柜有正常项）
 // 才能证明"正常项"展开区不再把计数为0的机柜也列出来。
 async function makeRoomWithRacks(roomName,rackNames){const racks=[];for(const name of rackNames)racks.push((await f.api('POST','/racks',{name,room:roomName,u_total:20})).body);return racks;}
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
  const draftMine=await buildDraftSheet('SF-Room1',2);
  const submittedBad=await buildSubmittedSheet('SF-Room2',2,true);
  const submittedOk=await buildSubmittedSheet('SF-Room3',2,false);
  const archiveResp=await f.api('POST','/inspections/sheets/archive',{items:[{id:submittedOk.id,expected_version:submittedOk.version}]},1);
  assert.equal(archiveResp.status,200,'archive submittedOk '+JSON.stringify(archiveResp.body));
  const archivedSheet=await getSheet(submittedOk.id,1);
  assert.equal(archivedSheet.status,200);

  browser=await chromium.launch({headless:true});
  // A) 巡检人（owner，fixture-2，非管理员）视角：进带异常的已提交单详情——工具条/异常卡/读数/正常项展开区/
  // 备注/操作记录原始条数（不拼句）/无归档提示/状态说明含"归档前可编辑、删除"。
  const ca=await browser.newContext();await ca.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pa=await ca.newPage();const errorsA=[];pa.on('pageerror',e=>errorsA.push(e.message));
  await pa.goto(f.base+'/IT_Ledger.html#inspections');await pa.locator('[data-insp-row="'+submittedBad.id+'"]').waitFor();
  await pa.locator('[data-insp-view="'+submittedBad.id+'"]').click();
  await pa.locator('.itl-sheet-title h2').waitFor();
  const titleTextA=await pa.locator('.itl-sheet-title h2').innerText();
  check('详情页标题含机房名与"巡检"字样',titleTextA.includes('SF-Room2')&&titleTextA.includes('巡检'),titleTextA);
  check('详情页标题带异常徽章"异常 1 项"',titleTextA.includes('异常 1 项'),titleTextA);
  const metaTextA=await pa.locator('.itl-sheet-title .itl-muted').innerText();
  check('meta含巡检人姓名与"归档前可编辑、删除"（owner视角有save）',metaTextA.includes('巡检人')&&metaTextA.includes('归档前可编辑、删除'),metaTextA);
  check('无归档提示条(未归档)',await pa.locator('#itlContent .itl-notice').count()===0);
  const badCardTextA=await pa.locator('.itl-sheet-bad-list').innerText();
  check('异常项卡片显示说明文字',badCardTextA.includes('巡检发现异常，已记录待处理。'),badCardTextA);
  await pa.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okBodyA=await pa.locator('.itl-sheet-ok').innerText();
  // LOW（C5a-1c 收紧）：原断言只查"机房/机柜/设备"三个组名字面出现，连组名本身都能被"该分组不显示"
  // 之类的巧合命中；改成分别断言 target_label（机柜名/夹具固定为"SF-Room2-柜1"）与 item_label（正常
  // 检查项名，submittedBad 的坏项是 aircon"空调运行"，UPS 与供电等其余5项仍正常）。
  check('正常项-机房段显示具体检查项名(item_label,如"UPS 与供电")',okBodyA.includes('UPS 与供电'),okBodyA);
  check('正常项-机柜段显示机柜名(target_label)与项数(4项全正常)',okBodyA.includes('SF-Room2-柜1')&&okBodyA.includes('四项正常'),okBodyA);
  check('正常项-设备段显示设备名(target_label,如"SF-Room2-设备1")',okBodyA.includes('SF-Room2-设备1'),okBodyA);
  // LOW（C5a-1c 收紧）：读数断言原来只查"℃"字样，现在断言具体数值22（NUMBER_DEFAULT.temperature）与
  // 45（humidity）都出现。
  const readingsTextA=await pa.locator('.itl-sheet-readings').innerText();
  check('读数区显示机房温度实际值(22℃)与湿度实际值(45%)',readingsTextA.includes('22')&&readingsTextA.includes('℃')&&readingsTextA.includes('45')&&readingsTextA.includes('%'),readingsTextA);
  const logTextA=await pa.locator('.itl-sheet-log h3').innerText();
  check('操作记录包含创建提交且条数精确为2',logTextA==='操作记录 · 2 条',logTextA);
  check('操作记录最新提交排在创建之前',JSON.stringify(await pa.locator('[data-log-action]').allTextContents())===JSON.stringify(['提交巡检','开始填写']));
  check('操作记录每个真实动作对应一条记录',await pa.locator('.itl-sheet-log>ol>li').count()===2);
  check('浏览器无未捕获异常(owner详情视角)',errorsA.length===0);
  // 返回按钮：先冲刷不适用(无写队列)，但回到列表且列表内容正确渲染。
  await pa.locator('#itlSheetBack').click();await pa.locator('[data-insp-row="'+submittedBad.id+'"]').waitFor();
  check('返回巡检台账后列表恢复可见',await pa.locator('#itlInspRows').count()===1);
  await ca.close();

  // B) 管理员视角：已归档单——LOW（C5a-1b 订正）：本切片不渲染"撤回归档"按钮，归档提示条不应再指向它；
  // 改为断言提示条只说"已归档，内容不能再修改"这句单一文案（旧断言曾要求含"撤回归档"，随该 LOW 修复一并
  // 更新）。状态说明不含"归档前可编辑"。
  const cb=await browser.newContext();await cb.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pb=await cb.newPage();const errorsB=[];pb.on('pageerror',e=>errorsB.push(e.message));
  await pb.goto(f.base+'/IT_Ledger.html#inspections');await pb.locator('[data-insp-row="'+submittedOk.id+'"]').waitFor();
  await pb.locator('[data-insp-view="'+submittedOk.id+'"]').click();await pb.locator('.itl-sheet-title h2').waitFor();
  check('已归档单标题含"已归档"徽章',(await pb.locator('.itl-sheet-title h2').innerText()).includes('已归档'));
  const noticeTextB=await pb.locator('#itlContent .itl-notice').innerText();
  check('LOW:已归档单提示条只说明"已归档，内容不能再修改"，不再指向不存在的撤回归档按钮',noticeTextB.includes('已归档')&&noticeTextB.includes('内容不能再修改')&&!noticeTextB.includes('撤回归档'),noticeTextB);
  check('无异常时检查结果标题旁立即显示本次无异常项',await pb.locator('#itlSheetResults>header .itl-sheet-clear').innerText()==='本次无异常项'&&await pb.locator('#itlSheetResults>header .itl-sheet-clear').isVisible());
  check('浏览器无未捕获异常(管理员归档详情视角)',errorsB.length===0);
  await cb.close();

  // LOW（C5a-1c 收紧）：补非管理员视角看同一张已归档单的提示条——LOW-1把归档提示条简化成单一文案后，
  // 不该再有任何"仅管理员可见的差异化措辞"，非管理员（owner，fixture-2）看到的应该是完全相同的文案。
  const cb2=await browser.newContext();await cb2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pb2=await cb2.newPage();const errorsB2=[];pb2.on('pageerror',e=>errorsB2.push(e.message));
  await pb2.goto(f.base+'/IT_Ledger.html#inspections');await pb2.locator('[data-insp-row="'+submittedOk.id+'"]').waitFor();
  await pb2.locator('[data-insp-view="'+submittedOk.id+'"]').click();await pb2.locator('.itl-sheet-title h2').waitFor();
  const noticeTextB2=await pb2.locator('#itlContent .itl-notice').innerText();
  check('LOW:非管理员(owner)看已归档单提示条与管理员视角完全一致(不再差异化措辞)',noticeTextB2===noticeTextB,{noticeTextB2,noticeTextB});
  check('浏览器无未捕获异常(非管理员归档详情视角)',errorsB2.length===0);
  await cb2.close();

  // C) 非owner非admin写权限视角（fixture-3，read级别）：提交单只读——meta说明不含"归档前可编辑"而是
  // "只有巡检人...和管理员可编辑"；仍能看到详情内容（full可见，因为已提交）。
  const cc=await browser.newContext();await cc.addInitScript(()=>localStorage.setItem('token','fixture-3'));const pc=await cc.newPage();const errorsC=[];pc.on('pageerror',e=>errorsC.push(e.message));
  await pc.goto(f.base+'/IT_Ledger.html#inspections');await pc.locator('[data-insp-row="'+submittedBad.id+'"]').waitFor();
  await pc.locator('[data-insp-view="'+submittedBad.id+'"]').click();await pc.locator('.itl-sheet-title h2').waitFor();
  // LOW-3（C5a-1c）：兜底文案不再前端推算"谁能编辑"，自己不在actions.save里时统一显示"已提交 · 只读"
  // （旧断言曾要求"只有巡检人...和管理员可编辑"这句猜测性文案，随该LOW修复一并更新；"只有巡检人"是旧
  // 文案独有的措辞，"巡检人"三字本身在meta行的"巡检人 X ·"前缀里恒会出现，不能拿来判断新旧）。
  const metaTextC=await pc.locator('.itl-sheet-title .itl-muted').innerText();
  check('LOW-3:只读用户(自己不在actions.save里)看到"已提交 · 只读"(不再前端推算谁能编辑)',metaTextC.includes('已提交 · 只读')&&!metaTextC.includes('只有巡检人'),metaTextC);
  check('浏览器无未捕获异常(只读详情视角)',errorsC.length===0);
  await cc.close();

  // D) C5a 段3落地后订正：草稿行点击进入真实的草稿填写页；"新增巡检"打开真实的机房选择弹窗。这里点的
  // draftMine 是 fixture-1（管理员）在看 fixture-2 自己建的草稿——管理员对任何单都是 full 可见度，走的是
  // "status==='draft'"分支（真正的"summary"分支覆盖在块 E，非管理员写权限用户看别人的草稿）。
  const cd=await browser.newContext();await cd.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pd=await cd.newPage();const errorsD=[];pd.on('pageerror',e=>errorsD.push(e.message));
  await pd.goto(f.base+'/IT_Ledger.html#inspections');await pd.locator('[data-insp-row="'+draftMine.id+'"]').waitFor();
  await pd.locator('[data-insp-row="'+draftMine.id+'"]').click();
  await pd.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pd);
  check('C5a段3:草稿行点击进入真实的草稿填写页(不再是占位)',(await pd.locator('.itl-sheet-title h2').innerText()).includes('SF-Room1'));
  await pd.locator('#itlFormBack').click();await pd.locator('[data-insp-row="'+draftMine.id+'"]').waitFor();
  check('C5a段3:返回巡检台账后列表恢复可见',await pd.locator('#itlInspRows').count()===1);
  await pd.locator('#itlInspNew').click();
  await pd.locator('#itlModal.open').waitFor();
  check('C5a段3:"新增巡检"打开真实的机房选择弹窗(不再是占位toast)',(await pd.locator('#itlModalTitle').innerText())==='新增巡检');
  await pd.locator('#itlModalCancel').click();
  check('浏览器无未捕获异常(占位入口视角)',errorsD.length===0);
  await cd.close();

  // E) M1（C5a-1b 必修，Opus 预筛）：他人草稿（summary 可见度）行——写权限非管理员用户（fixture-2）
  // 看别人（管理员 uid 1）建的草稿：摘要行显示"他人草稿"、无按钮；点击行只弹占位提示，且全程不发起
  // GET /inspections/sheets/:id（那张单对他 visibility==='none' 不对，是 summary，接口本可能给出摘要
  // 级信息，但详情页只认 full，前端应该在点击这一步就用 lastItems 里已有的 visibility 字段挡掉，不用
  // 白发一次注定不会被详情页使用的请求）。用 context.on('request') 计数 + 哨兵请求到达信号，证明"计数
  // 为0"不是因为观测窗口还没关上就提前判断。
  const draftOther=await buildDraftSheet('SF-Room4',1);
  const ce=await browser.newContext();await ce.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pe=await ce.newPage();const errorsE=[];pe.on('pageerror',e=>errorsE.push(e.message));
  let sheetDetailReqCountE=0;pe.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/sheets/'+draftOther.id))sheetDetailReqCountE++;});
  const sentinelE=async()=>{const seen=pe.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pe.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await pe.goto(f.base+'/IT_Ledger.html#inspections');await pe.locator('[data-insp-row="'+draftOther.id+'"]').waitFor();
  const draftOtherRowText=await pe.locator('[data-insp-row="'+draftOther.id+'"]').innerText();
  check('M1:写权限非管理员视角看到他人草稿摘要行显示"他人草稿"且无按钮',draftOtherRowText.includes('他人草稿')&&await pe.locator('[data-insp-row="'+draftOther.id+'"] button').count()===0,draftOtherRowText);
  await pe.locator('[data-insp-row="'+draftOther.id+'"]').click();
  await pe.locator('#itlToast').waitFor();
  check('M1:点击他人草稿行提示仅可看摘要且未打开详情页',(await pe.locator('#itlToast').innerText()).includes('只能查看摘要，无法打开详情')&&await pe.locator('.itl-sheet-title').count()===0);
  await sentinelE();
  check('M1:点击他人草稿行全程未发起GET该单详情请求(到达信号+计数精确为0)',sheetDetailReqCountE===0,sheetDetailReqCountE);
  // C5c（方案v0.6§6"设备采集明细展开"条，"summary视角不显示展开按钮"）：GET /inspections/sheets/:id
  // 对summary可见度恒404（route层，见inspection-sheets.js:727），renderForm/renderDetailView（唯一
  // 渲染展开按钮的两个函数）全程不会被调用到——整页此刻只有摘要行本身，上面M1已经断言这一行"无按钮"
  // （不区分按钮种类），这里补一条显式核对：即使把选择器精确收窄到展开按钮本身，同样是0，不是"恰好
  // 别的原因导致按钮计数为0，展开按钮其实混在里面"这种巧合。
  check('C5c:他人草稿summary可见度全程不出现任何展开明细按钮(可达性本就被sheetVisibility挡在路由层)',await pe.locator('[data-device-expand]').count()===0);
  check('浏览器无未捕获异常(M1)',errorsE.length===0);
  await ce.close();

  // F) H1（C5a-1b 必修，Opus 预筛）：详情 GET 失败时不再死锁——先在后台删掉一张已提交单（不经过界面，
  // 制造"列表还没刷新、这一行看起来可点、但详情接口其实已经404"的场景），点它的「查看」→ 404 → 应该
  // 自动带着提示回到列表（而不是停在一行错误文字、mode/detailId 仍卡在这张死单上）；再切走再切回巡检
  // 页签（触发 render()），如果 mode 没被正确收回，render() 会用同一个 id 再次调用 openDetail() 撞同
  // 一个404——用请求计数+哨兵到达信号证明这次切回没有再发请求。**视角必须是非管理员**：已提交单逻辑
  // 删除后 sheetVisibility() 对管理员仍返回 full（管理员要能看见才能恢复），只有非管理员才会真的拿到
  // 404——用巡检人自己（fixture-2）而不是管理员去点，管理员另发起删除。
  const toDeleteF=await buildSubmittedSheet('SF-Room5',2,false);
  const cf=await browser.newContext();await cf.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pf=await cf.newPage();const errorsF=[];pf.on('pageerror',e=>errorsF.push(e.message));
  await pf.goto(f.base+'/IT_Ledger.html#inspections');await pf.locator('[data-insp-row="'+toDeleteF.id+'"]').waitFor();
  const delRespF=await f.api('DELETE','/inspections/sheets/'+toDeleteF.id,{expected_version:toDeleteF.version,reason:'H1死路测试预备删除'},1);
  assert.equal(delRespF.status,200,'H1夹具删除失败 '+JSON.stringify(delRespF.body));
  let sheetDetailReqCountF=0;pf.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/sheets/'+toDeleteF.id))sheetDetailReqCountF++;});
  const sentinelF=async()=>{const seen=pf.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pf.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  // 此刻列表里这一行仍是"已提交"的旧渲染（还没刷新），"查看"按钮仍在，点击会真的发起一次404请求——
  // 这一次是预期内的（用户不知道它已被删），要验证的是404之后的恢复行为，不是"零请求"。
  const settledBaselineF=await pf.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pf.locator('[data-insp-view="'+toDeleteF.id+'"]').click();
  await pf.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineF);
  await pf.locator('#itlToast').waitFor();
  check('H1:详情404后toast提示"这张巡检单已不存在或你无权查看"',(await pf.locator('#itlToast').innerText()).includes('这张巡检单已不存在或你无权查看'));
  await pf.locator('[data-insp-row]').first().waitFor();
  check('H1:404后自动回到台账列表(台账元素存在)',await pf.locator('#itlInspRows').count()===1);
  check('H1:404后不再显示该已删除单据的行',await pf.locator('[data-insp-row="'+toDeleteF.id+'"]').count()===0);
  check('H1:404后不停留在一行裸错误文字(无.itl-form-error)',await pf.locator('#itlContent .itl-form-error').count()===0);
  // 切走再切回巡检页签，触发 render() 走 mode 分派——如果 H1 没修，mode 仍是 'detail'、detailId 仍是
  // toDeleteF.id，render() 会重新调用 openDetail(toDeleteF.id)、再发一次已经确定会 404 的请求。
  sheetDetailReqCountF=0;
  await pf.evaluate(()=>{location.hash='racks';});await pf.locator('.itl-rack-workspace').waitFor();
  await pf.evaluate(()=>{location.hash='inspections';});await pf.locator('[data-insp-row]').first().waitFor();
  await sentinelF();
  check('H1:切走再切回巡检页签后不再对已死的单据重发详情请求(到达信号+计数精确为0)',sheetDetailReqCountF===0,sheetDetailReqCountF);
  check('浏览器无未捕获异常(H1)',errorsF.length===0);
  await cf.close();

  // G) H1 非404分支（补强块F的判别力缺口）：404分支里 mode 重置其实是"冗余安全网"——即使不显式重置，
  // 404分支自己调用的 load() 内部也会走 enterMode('list') 把 mode 顺带修正过来，块F的"变异后仍全绿"
  // 已经在本轮交付前实测验证过这一点（见变异自检记录）。真正需要这次显式重置的是非404错误分支（网络
  // 异常等）——那个分支只渲染错误卡片+"返回巡检台账"按钮，**不主动调用** load()，如果不显式重置，
  // mode/detailId 会一直卡住；本例用 route abort 制造网络异常，卡片出现后**不点按钮**，直接切走再切回
  // 页签，断言不会对同一张死单重发请求（如果没重置，render()会用卡住的 mode==='detail' 再次调用
  // openDetail(detailId)）。
  const toErrorG=await buildSubmittedSheet('SF-Room6',2,false);
  const cg=await browser.newContext();await cg.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pg=await cg.newPage();const errorsG=[];pg.on('pageerror',e=>errorsG.push(e.message));
  await pg.goto(f.base+'/IT_Ledger.html#inspections');await pg.locator('[data-insp-row="'+toErrorG.id+'"]').waitFor();
  let sheetDetailReqCountG=0;pg.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/sheets/'+toErrorG.id))sheetDetailReqCountG++;});
  const sentinelG=async()=>{const seen=pg.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pg.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await pg.route('**/api/it-assets/inspections/sheets/'+toErrorG.id,route=>{
    if(route.request().method()!=='GET')return route.fallback();
    route.abort('failed');
  });
  const settledBaselineG=await pg.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pg.locator('[data-insp-view="'+toErrorG.id+'"]').click();
  await pg.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineG);
  check('G:网络异常后详情区显示错误信息与"返回巡检台账"按钮(非裸404场景)',await pg.locator('#itlContent .itl-form-error').count()===1&&await pg.locator('#itlSheetErrorBack').count()===1);
  check('G(L3):详情读取失败入口不透传"重新打开页面"',!(await pg.locator('#itlContent .itl-form-error').innerText()).includes('重新打开页面'));
  check('G:网络异常后没有把台账列表覆盖成占位(还在错误卡片,不是自动回列表)',await pg.locator('#itlInspRows').count()===0);
  // 关键：不点"返回巡检台账"按钮，直接切走再切回——如果 mode/detailId 没有在失败时被显式重置，
  // render() 会重新调用 openDetail(同一个死id)，再发一次注定失败的请求。
  sheetDetailReqCountG=0;
  await pg.evaluate(()=>{location.hash='racks';});await pg.locator('.itl-rack-workspace').waitFor();
  await pg.evaluate(()=>{location.hash='inspections';});await pg.locator('#itlInspRows').waitFor();
  await sentinelG();
  check('G:未点返回按钮、仅切走切回,也不会对同一张单重发详情请求(到达信号+计数精确为0,证明mode已被显式重置)',sheetDetailReqCountG===0,sheetDetailReqCountG);
  check('G:切回后落在正常的台账列表(不是卡在detail模式重试)',await pg.locator('#itlInspRows').count()===1);
  check('浏览器无未捕获异常(G)',errorsG.length===0);
  await cg.close();

  // H) M4（C5a-1b 必修，Opus 预筛）：一个机房挂两台设备，都判正常——"正常项"展开区展开后的"设备"行应该
  // 列出两个具体设备名，不出现"前面板与告警灯"（那是两台设备共享的同一个模板检查项 item_label，旧版
  // 取 item_label 会让两台正常设备重复显示同一句文案而不是各自的设备名，见 target_label 改法）。
  const deviceNamesH=['SF-RoomM4-设备甲','SF-RoomM4-设备乙'];
  await makeRoomWithDevices('SF-RoomM4',deviceNamesH);
  const createdH=await createSheet(2,'SF-RoomM4');
  assert.equal(createdH.status,201,'M4 createSheet '+JSON.stringify(createdH.body));
  const detailH0=await getSheet(createdH.body.id,2);
  const itemsH=fillPayloadAllOk(detailH0.body.items);
  const putH=await f.api('PUT','/inspections/sheets/'+createdH.body.id,{expected_version:createdH.body.version,items:itemsH},2);
  assert.equal(putH.status,200,'M4 put '+JSON.stringify(putH.body));
  await uploadAllRackFrontPhotos(createdH.body.id,createdH.body.scope,2);
  const submitH=await f.api('POST','/inspections/sheets/'+createdH.body.id+'/submit',{expected_version:putH.body.version},2);
  assert.equal(submitH.status,200,'M4 submit '+JSON.stringify(submitH.body));
  const ch=await browser.newContext();await ch.addInitScript(()=>localStorage.setItem('token','fixture-2'));const ph=await ch.newPage();const errorsH=[];ph.on('pageerror',e=>errorsH.push(e.message));
  await ph.goto(f.base+'/IT_Ledger.html#inspections');await ph.locator('[data-insp-row="'+submitH.body.id+'"]').waitFor();
  await ph.locator('[data-insp-view="'+submitH.body.id+'"]').click();await ph.locator('.itl-sheet-ok').waitFor();
  await ph.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okBodyH=await ph.locator('.itl-sheet-ok').innerText();
  check('M4:正常项设备行显示两台具体设备名',okBodyH.includes(deviceNamesH[0])&&okBodyH.includes(deviceNamesH[1]),okBodyH);
  check('M4:正常项设备行不出现共享模板项名"前面板与告警灯"(会被两台设备重复)',!okBodyH.includes('前面板与告警灯'),okBodyH);
  check('M4:正常项展开区标题带总数',/正常项 · 共 \d+ 项/.test(okBodyH),okBodyH);
  check('浏览器无未捕获异常(M4)',errorsH.length===0);
  await ch.close();

  // I) M5（C5a-1b 必修，Opus 预筛）：机房名/备注/异常说明/设备名都放一段XSS payload，断言详情页把它们
  // 当纯文本显示（原样出现在innerText里，未被解析成元素），且payload里的onerror从未真正执行。
  const XSS='<img src=x onerror="window.__xss=1">';
  const roomNameI='SF-RoomXSS'+XSS;
  const deviceNameI='DevXSS'+XSS;
  const rackI=(await f.api('POST','/racks',{name:'SF-RoomXSS-柜1',room:roomNameI,u_total:20})).body;
  await f.api('POST','',{category:'server',name:deviceNameI,u_height:1,placement:{kind:'rack',rack_id:rackI.id,u_start:1}});
  const createdI=await createSheet(2,roomNameI);
  assert.equal(createdI.status,201,'M5 createSheet '+JSON.stringify(createdI.body));
  const detailI0=await getSheet(createdI.body.id,2);
  const itemsI=fillPayloadAllOk(detailI0.body.items);
  const checkItemI=detailI0.body.items.find(it=>it.value_kind!=='number');
  const targetI=itemsI.find(x=>x.id===checkItemI.id);
  targetI.result='bad';targetI.note=XSS;
  const putI=await f.api('PUT','/inspections/sheets/'+createdI.body.id,{expected_version:createdI.body.version,items:itemsI,remark:XSS},2);
  assert.equal(putI.status,200,'M5 put '+JSON.stringify(putI.body));
  await uploadAllRackFrontPhotos(createdI.body.id,createdI.body.scope,2);
  await uploadPhoto(createdI.body.id,'item',checkItemI.id,2);
  const submitI=await f.api('POST','/inspections/sheets/'+createdI.body.id+'/submit',{expected_version:putI.body.version},2);
  assert.equal(submitI.status,200,'M5 submit '+JSON.stringify(submitI.body));
  const ci=await browser.newContext();await ci.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pi=await ci.newPage();const errorsI=[];pi.on('pageerror',e=>errorsI.push(e.message));
  await pi.goto(f.base+'/IT_Ledger.html#inspections');await pi.locator('[data-insp-row="'+submitI.body.id+'"]').waitFor();
  await pi.locator('[data-insp-view="'+submitI.body.id+'"]').click();await pi.locator('.itl-sheet-title h2').waitFor();
  const titleTextI=await pi.locator('.itl-sheet-title h2').innerText();
  check('M5:详情页标题原样显示机房名里的XSS载荷文本',titleTextI.includes(roomNameI),titleTextI);
  const badTextI=await pi.locator('.itl-sheet-bad-list').innerText();
  check('M5:异常说明原样显示XSS载荷文本(未被解析成元素)',badTextI.includes(XSS),badTextI);
  const remarkTextI=await pi.locator('.itl-sheet-remark-view').innerText();
  check('M5:备注原样显示XSS载荷文本',remarkTextI.includes(XSS),remarkTextI);
  await pi.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okTextI=await pi.locator('.itl-sheet-ok').innerText();
  check('M5:正常项设备行原样显示设备名里的XSS载荷文本',okTextI.includes(deviceNameI),okTextI);
  check('M5:XSS载荷未被执行(window.__xss未定义)',await pi.evaluate(()=>window.__xss)===undefined);
  check('浏览器无未捕获异常(M5)',errorsI.length===0);
  await ci.close();

  // J) M3（C5a-1b 必修，Opus 预筛）：管理员的台账列表还没刷新，行仍显示"已提交"且"查看"可点，但这张单
  // 已经在别处被删除——sheetVisibility()对已删除单，管理员仍是full可见度，GET /:id 返回200而不是404，
  // H1的404恢复路径不会触发；旧版renderDetailView完全没读deleted_at/delete_reason两个字段，会把它渲染
  // 成一张普通已提交单。断言详情页显示"已删除"提示条含删除原因，状态说明不再出现"可编辑"字样。
  const toDeleteJ=await buildSubmittedSheet('SF-Room7',2,false);
  const cj=await browser.newContext();await cj.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pj=await cj.newPage();const errorsJ=[];pj.on('pageerror',e=>errorsJ.push(e.message));
  await pj.goto(f.base+'/IT_Ledger.html#inspections');await pj.locator('[data-insp-row="'+toDeleteJ.id+'"]').waitFor();
  // M-3（C5a-1c 必修，二次预筛）：删除原因也放一段XSS payload——delete_reason原样进详情提示条，之前只
  // 测过普通中文文案，没测过转义。
  const deleteReasonJ='M3已删除单查看测试'+XSS;
  const delRespJ=await f.api('DELETE','/inspections/sheets/'+toDeleteJ.id,{expected_version:toDeleteJ.version,reason:deleteReasonJ},1);
  assert.equal(delRespJ.status,200,'M3夹具删除失败 '+JSON.stringify(delRespJ.body));
  await pj.locator('[data-insp-view="'+toDeleteJ.id+'"]').click();
  await pj.locator('.itl-sheet-title h2').waitFor();
  const noticeTextJ=await pj.locator('#itlContent .itl-notice').innerText();
  check('M3:管理员查看已删除单显示"已删除"提示条含删除原因',noticeTextJ.includes('已删除')&&noticeTextJ.includes(deleteReasonJ),noticeTextJ);
  check('M-3:删除原因里的XSS载荷原样显示为纯文本(未被解析成元素)',noticeTextJ.includes(XSS),noticeTextJ);
  check('M-3:删除原因的XSS载荷未被执行(window.__xss未定义)',await pj.evaluate(()=>window.__xss)===undefined);
  // LOW-3（C5a-1c）：管理员对已删除单的actions恒含'restore'，提示条应该出现恢复入口提示。
  check('LOW-3:管理员(有restore动作)看到"如需恢复"提示',noticeTextJ.includes('如需恢复'),noticeTextJ);
  // M-4（C5a-1c 必修，二次预筛）：已删除单标题用"已删除"徽章替代状态徽章——不再显示会引起误解的
  // "已提交（待归档）"（那句话字面含"待归档"，容易让人以为这张单还能正常流转）。
  const titleTextJ=await pj.locator('.itl-sheet-title h2').innerText();
  check('M-4:已删除单标题含"已删除"徽章',titleTextJ.includes('已删除'),titleTextJ);
  check('M-4:已删除单标题不再含"待归档"(状态徽章已被已删除徽章替代)',!titleTextJ.includes('待归档'),titleTextJ);
  // 直接子代选择器：toDeleteJ 无异常项，h2 内部也会出现一个 .itl-muted（"无异常"），descendant
  // 选择器会命中两处；meta 行是 .itl-sheet-title 的直接子元素，用 > 精确定位它。
  const metaTextJ=await pj.locator('.itl-sheet-title > .itl-muted').innerText();
  check('M3:状态说明不再出现"可编辑"字样',!metaTextJ.includes('可编辑'),metaTextJ);
  check('M3:状态说明含"已删除"',metaTextJ.includes('已删除'),metaTextJ);
  check('浏览器无未捕获异常(M3)',errorsJ.length===0);
  await cj.close();

  // K) M6（C5a-1b 必修，Opus 预筛）：点行入口——点已提交单这一行里非按钮区域（如"机房"单元格文字），
  // 也应该走进详情页，不是只有"查看"链接本身能进（行点击委托已存在，这里补测覆盖）。
  const toClickK=await buildSubmittedSheet('SF-Room8',2,false);
  const ck=await browser.newContext();await ck.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pk=await ck.newPage();const errorsK=[];pk.on('pageerror',e=>errorsK.push(e.message));
  await pk.goto(f.base+'/IT_Ledger.html#inspections');await pk.locator('[data-insp-row="'+toClickK.id+'"]').waitFor();
  await pk.locator('[data-insp-row="'+toClickK.id+'"] td').nth(1).click();
  await pk.locator('.itl-sheet-title h2').waitFor();
  check('M6:点行(非按钮区域)也能打开详情页',(await pk.locator('.itl-sheet-title h2').innerText()).includes('SF-Room8'));
  check('浏览器无未捕获异常(M6)',errorsK.length===0);
  await ck.close();

  // L) M2 案例①（C5a-1b 必修，Opus 预筛）：详情GET响应挂起期间切到"机房"页签，放行后机房视图完整、
  // 无残留的详情元素——沿用C4c/C4d同款"挂起+到达信号+等结算计数"写法（sheets-browser.js块D）。
  const toRaceL=await buildSubmittedSheet('SF-Room9',2,false);
  const cl=await browser.newContext();await cl.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pl=await cl.newPage();const errorsL=[];pl.on('pageerror',e=>errorsL.push(e.message));
  await pl.goto(f.base+'/IT_Ledger.html#inspections');await pl.locator('[data-insp-row="'+toRaceL.id+'"]').waitFor();
  let releaseDetailL,enteredDetailL;
  const enteredDetailLP=new Promise(r=>enteredDetailL=r),heldDetailLP=new Promise(r=>releaseDetailL=r);
  await pl.route('**/api/it-assets/inspections/sheets/'+toRaceL.id,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    const response=await route.fetch();enteredDetailL();await heldDetailLP;await route.fulfill({response});
  });
  await pl.locator('[data-insp-view="'+toRaceL.id+'"]').click();
  await enteredDetailLP;
  const settledBaselineL=await pl.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pl.evaluate(()=>{location.hash='racks';});
  await pl.locator('.itl-rack-workspace').waitFor();
  const detailRespondedL=pl.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+toRaceL.id)&&r.request().method()==='GET');
  releaseDetailL();
  await detailRespondedL;
  await pl.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineL);
  check('M2案例①:挂起的详情响应放行后不覆盖已切到的机房视图(有机房标志元素)',await pl.locator('.itl-rack-workspace').count()===1);
  check('M2案例①:挂起的详情响应放行后不覆盖已切到的机房视图(无详情标题元素)',await pl.locator('.itl-sheet-title').count()===0);
  check('M2案例①:挂起的详情响应放行后不覆盖已切到的机房视图(无"正在读取巡检详情"文字)',!(await pl.locator('body').innerText()).includes('正在读取巡检详情'));
  check('浏览器无未捕获异常(M2案例①)',errorsL.length===0);
  await cl.close();

  // N) M2 案例②（C5a-1b 必修，Opus 预筛）：连续为两张不同的单发起详情请求，先点的(A)响应后到，页面
  // 应该显示后点的(B)。**自决点**：真实UI下"连点两张单"事实上无法通过两次真实点击构造——openDetail()
  // 的同步前缀（container.replaceChildren(marker)）会在第一次点击的事件处理过程中就把整张列表（含B的
  // "查看"按钮）从文档树摘掉；脱离文档树的节点再.click()不会冒泡到document上的委托监听器（原理：click
  // 事件沿目标节点在DOM树里的当前祖先链传播，脱离文档的旧子树到不了document）。要让"第二次点击"真的
  // 触发委托监听器里的openDetail(B)，测试在B按钮已脱离文档后把它临时重新挂回文档树（不改动它的
  // data-insp-view属性/内容，只是让事件冒泡路径能通到document），再对它调用原生.click()——这走的是与
  // 真实第二次点击完全相同的委托监听器代码路径，只是绕开了"第一次点击必然摘掉整张列表"这个UI层限制；
  // 判别力落在openDetail()内seq/detailId等守卫能否正确丢弃迟到的A响应这件事本身，不落在"第二次交互具体
  // 怎么触发"。下面先断言"点A后B的按钮确实已从可见列表消失"，证明这个替代确有必要而不是凭空绕远路。
  const roomA=await buildSubmittedSheet('SF-Room10',2,false);
  const roomB=await buildSubmittedSheet('SF-Room11',2,false);
  const cn=await browser.newContext();await cn.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pn=await cn.newPage();const errorsN=[];pn.on('pageerror',e=>errorsN.push(e.message));
  let releaseAN,enteredAN;const enteredANP=new Promise(r=>enteredAN=r),heldANP=new Promise(r=>releaseAN=r);
  let releaseBN,enteredBN;const enteredBNP=new Promise(r=>enteredBN=r),heldBNP=new Promise(r=>releaseBN=r);
  await pn.route('**/api/it-assets/inspections/sheets/'+roomA.id,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    const response=await route.fetch();enteredAN();await heldANP;await route.fulfill({response});
  });
  await pn.route('**/api/it-assets/inspections/sheets/'+roomB.id,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    const response=await route.fetch();enteredBN();await heldBNP;await route.fulfill({response});
  });
  await pn.goto(f.base+'/IT_Ledger.html#inspections');
  await pn.locator('[data-insp-row="'+roomA.id+'"]').waitFor();
  await pn.evaluate(({idA,idB})=>{
    window.__m2btnB=document.querySelector('[data-insp-view="'+idB+'"]');
    document.querySelector('[data-insp-view="'+idA+'"]').click();
  },{idA:roomA.id,idB:roomB.id});
  await enteredANP;
  check('M2案例②:点A后列表(含B的查看按钮)已被替换成加载态,证明必须用重新挂回节点的方式才能触发第二次点击',await pn.locator('[data-insp-view="'+roomB.id+'"]').count()===0);
  // LOW（C5a-1c）：挂回文档树只是为了让click冒泡到document——点完立刻remove()，不把这个借来的按钮节点
  // 永久留在body里当垃圾。
  await pn.evaluate(()=>{document.body.appendChild(window.__m2btnB);window.__m2btnB.click();window.__m2btnB.remove();delete window.__m2btnB;});
  await enteredBNP;
  const respondedBN=pn.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+roomB.id)&&r.request().method()==='GET');
  releaseBN();
  await respondedBN;
  await pn.locator('.itl-sheet-title h2').waitFor();
  const titleAfterBN=await pn.locator('.itl-sheet-title h2').innerText();
  check('M2案例②:后点的B响应到达后页面显示B',titleAfterBN.includes('SF-Room11'),titleAfterBN);
  const settledBaselineN=await pn.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const respondedAN=pn.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+roomA.id)&&r.request().method()==='GET');
  releaseAN();
  await respondedAN;
  await pn.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineN);
  const titleAfterAN=await pn.locator('.itl-sheet-title h2').innerText();
  check('M2案例②:先点的A迟到响应到达后页面仍显示B(未被覆盖)',titleAfterAN.includes('SF-Room11')&&!titleAfterAN.includes('SF-Room10'),titleAfterAN);
  check('浏览器无未捕获异常(M2案例②)',errorsN.length===0);
  await cn.close();

  // O) LOW（C5a-1b）：正常项展开区里 0 项的分组不显示——机房环境 6 个检查项全部判异常（机柜/设备仍全部
  // 正常），断言"机房"这一段整段不出现，"机柜"/"设备"两段不受影响仍然出现。
  const createdO=await buildDraftSheet('SF-Room12',2);
  const detailO0=await getSheet(createdO.id,2);
  const itemsO=fillPayloadAllOk(detailO0.body.items);
  const roomCheckIdsO=detailO0.body.items.filter(it=>it.section==='room'&&it.value_kind!=='number').map(it=>it.id);
  for(const it of itemsO){if(roomCheckIdsO.includes(it.id)){it.result='bad';it.note='LOW-4测试：全部机房项异常';}}
  const putO=await f.api('PUT','/inspections/sheets/'+createdO.id,{expected_version:createdO.version,items:itemsO},2);
  assert.equal(putO.status,200,'O put '+JSON.stringify(putO.body));
  await uploadAllRackFrontPhotos(createdO.id,createdO.scope,2);
  for(const id of roomCheckIdsO)await uploadPhoto(createdO.id,'item',id,2);
  const submitO=await f.api('POST','/inspections/sheets/'+createdO.id+'/submit',{expected_version:putO.body.version},2);
  assert.equal(submitO.status,200,'O submit '+JSON.stringify(submitO.body));
  const co=await browser.newContext();await co.addInitScript(()=>localStorage.setItem('token','fixture-2'));const po=await co.newPage();const errorsO=[];po.on('pageerror',e=>errorsO.push(e.message));
  await po.goto(f.base+'/IT_Ledger.html#inspections');await po.locator('[data-insp-row="'+submitO.body.id+'"]').waitFor();
  await po.locator('[data-insp-view="'+submitO.body.id+'"]').click();await po.locator('.itl-sheet-ok').waitFor();
  await po.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okBodyO=await po.locator('.itl-sheet-ok').innerText();
  check('LOW:机房正常项为0时"机房"分组行不显示',!okBodyO.includes('机房'),okBodyO);
  check('LOW:机柜/设备仍显示(非0分组不受影响)',okBodyO.includes('机柜')&&okBodyO.includes('设备'),okBodyO);
  check('浏览器无未捕获异常(O)',errorsO.length===0);
  await co.close();

  // P) M-1（C5a-1c 必修，二次预筛）：openDetail() catch 分支自己的守卫（"仍是当前请求"五件套）此前没有
  // 用例覆盖"挂起详情响应期间已经切到别的页签，失败才到达"这个场景——块 F/G 测的是"点开时就立刻失败"，
  // 不是"挂起后再失败"。并入预筛探针 probe-c5a-prescreen.js 的 P-abort/P-404 两段：详情 GET 挂起→切到
  // "机房"→等机房视图渲染完→放行（网络失败/404）→等 __inspLoadSettled+1→断言机房视图仍完整、无错误
  // 卡片/返回按钮残留、toast 不出现"已不存在"提示（那条toast属于404分支自己的处理，如果catch分支的
  // 守卫没生效，它会在用户已经离开巡检页签之后还跳出来）。
  for(const kindP of ['abort','404']){
    const shP=await buildSubmittedSheet('SF-RoomP-'+kindP,2,false);
    const cP=await browser.newContext();await cP.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pP=await cP.newPage();const errorsP=[];pP.on('pageerror',e=>errorsP.push(e.message));
    await pP.goto(f.base+'/IT_Ledger.html#inspections');await pP.locator('[data-insp-row="'+shP.id+'"]').waitFor();
    let releaseP,enteredP;const enteredPP=new Promise(r=>enteredP=r),heldPP=new Promise(r=>releaseP=r);
    await pP.route('**/api/it-assets/inspections/sheets/'+shP.id,async route=>{
      if(route.request().method()!=='GET')return route.fallback();
      enteredP();await heldPP;
      if(kindP==='abort')await route.abort('failed');
      else await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'SHEET_NOT_FOUND',error:'巡检单不存在'})});
    });
    await pP.locator('[data-insp-view="'+shP.id+'"]').click();await enteredPP;
    await pP.evaluate(()=>{location.hash='racks';});await pP.locator('.itl-rack-workspace').waitFor();
    const settledBaselineP=await pP.evaluate(()=>window.ITLedger.__inspLoadSettled);
    releaseP();
    await pP.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineP);
    check('P-'+kindP+':挂起详情期间切到机房,放行失败响应后机房视图仍完整',await pP.locator('.itl-rack-workspace').count()===1,await pP.locator('#itlContent').innerText());
    check('P-'+kindP+':放行失败响应后无错误卡片残留',await pP.locator('#itlContent .itl-form-error').count()===0);
    check('P-'+kindP+':放行失败响应后无"返回巡检台账"按钮残留',await pP.locator('#itlSheetErrorBack').count()===0);
    const toastHiddenP=await pP.locator('#itlToast').isHidden();
    const toastTextP=toastHiddenP?'':await pP.locator('#itlToast').innerText();
    check('P-'+kindP+':放行失败响应后不弹"已不存在"提示(catch分支守卫已挡住,不是404分支自己命中)',!toastTextP.includes('已不存在'),{toastHiddenP,toastTextP});
    check('浏览器无未捕获异常(P-'+kindP+')',errorsP.length===0);
    await cP.close();
  }

  // Q) M-2（C5a-1c 必修，二次预筛）：五元守卫（seq/tab/mode/detailId/marker.isConnected）里
  // marker.isConnected 是唯一必要判据的真实场景——挂起详情响应期间，用户在已经过了10秒自动刷新节流
  // 窗口后重新点击"巡检"页签（哪怕已经在这个页签上）：setTab()不检查"是否已经在当前页签"，
  // autoRefresh()只检查节流窗口，命中后it-ledger.js会同步执行
  // `$('#itlContent').innerHTML='<div class="itl-empty">正在读取…</div>'`（这段代码不属于本模块，不会
  // 碰sequence/state.tab/mode/detailId中的任何一个）——只有marker.isConnected能识别出内容区已经被
  // 换掉。用Playwright假时钟推过节流窗口，不用真实sleep。
  const shQ=await buildSubmittedSheet('SF-RoomQ',2,false);
  const cQ=await browser.newContext();await cQ.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pQ=await cQ.newPage();const errorsQ=[];pQ.on('pageerror',e=>errorsQ.push(e.message));
  await pQ.goto(f.base+'/IT_Ledger.html#inspections');await pQ.locator('[data-insp-row="'+shQ.id+'"]').waitFor();
  await pQ.clock.install();
  let releaseDetailQ,enteredDetailQ;const enteredDetailQP=new Promise(r=>enteredDetailQ=r),heldDetailQP=new Promise(r=>releaseDetailQ=r);
  await pQ.route('**/api/it-assets/inspections/sheets/'+shQ.id,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    const response=await route.fetch();enteredDetailQ();await heldDetailQP;await route.fulfill({response});
  });
  let holdMeQ=false,releaseMeQ,enteredMeQ;const enteredMeQP=new Promise(r=>enteredMeQ=r),heldMeQP=new Promise(r=>releaseMeQ=r);
  await pQ.route(/\/api\/it-assets\/me$/,async route=>{
    if(!holdMeQ)return route.fallback();
    const response=await route.fetch();enteredMeQ();await heldMeQP;await route.fulfill({response});
  });
  await pQ.locator('[data-insp-view="'+shQ.id+'"]').click();await enteredDetailQP;
  await pQ.clock.fastForward(11000);
  holdMeQ=true;
  await pQ.locator('#itlTabs [data-tab="inspections"]').click();
  await enteredMeQP;
  const placeholderTextQ=await pQ.locator('#itlContent').innerText();
  check('Q前提:过节流后重点巡检页签触发autoRefresh,内容区已换成刷新占位',placeholderTextQ.includes('正在读取'),placeholderTextQ);
  const settledBaselineQ=await pQ.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const detailRespondedQ=pQ.waitForResponse(r=>r.url().endsWith('/inspections/sheets/'+shQ.id));
  releaseDetailQ();
  await detailRespondedQ;
  await pQ.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineQ);
  const titleCountQ=await pQ.locator('.itl-sheet-title').count();
  const stillPlaceholderQ=await pQ.locator('#itlContent').innerText();
  check('Q:marker唯一起效场景—迟到的详情响应不覆盖刷新占位(无详情标题)',titleCountQ===0&&stillPlaceholderQ.includes('正在读取'),{titleCountQ,stillPlaceholderQ:stillPlaceholderQ.slice(0,60)});
  releaseMeQ();
  await pQ.locator('.itl-sheet-title h2').waitFor({timeout:15000});
  check('Q正向对照:刷新完成后重新打开同一张详情',(await pQ.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomQ'));
  check('浏览器无未捕获异常(Q)',errorsQ.length===0);
  await cQ.close();

  // R) M-2（C5a-1c 必修，二次预筛）：同id重开——挂起旧的详情请求，切走再切回并重开同一张单（新请求
  // 正常渲染成功），旧请求随后才以失败到达：断言详情仍完整显示、mode/detailId未被旧请求的失败分支误
  // 重置（这里detailId===id对新旧两次请求都成立，能分辨新旧的只有seq）。
  const shR=await buildSubmittedSheet('SF-RoomR',2,false);
  const cR=await browser.newContext();await cR.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pR=await cR.newPage();const errorsR2=[];pR.on('pageerror',e=>errorsR2.push(e.message));
  await pR.goto(f.base+'/IT_Ledger.html#inspections');await pR.locator('[data-insp-row="'+shR.id+'"]').waitFor();
  let releaseOldR,enteredOldR,oldHeldR=true;
  const enteredOldRP=new Promise(r=>enteredOldR=r),heldOldRP=new Promise(r=>releaseOldR=r);
  await pR.route('**/api/it-assets/inspections/sheets/'+shR.id,async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    if(!oldHeldR)return route.fallback();
    oldHeldR=false;
    enteredOldR();
    await heldOldRP;
    await route.abort('failed');
  });
  await pR.locator('[data-insp-view="'+shR.id+'"]').click();await enteredOldRP;
  await pR.evaluate(()=>{location.hash='racks';});await pR.locator('.itl-rack-workspace').waitFor();
  await pR.evaluate(()=>{location.hash='inspections';});
  await pR.locator('.itl-sheet-title h2').waitFor();
  const titleAfterReopenR=await pR.locator('.itl-sheet-title h2').innerText();
  check('R前提:切走再切回后重开同一张单,新请求已经成功渲染',titleAfterReopenR.includes('SF-RoomR'),titleAfterReopenR);
  const settledBaselineR2=await pR.evaluate(()=>window.ITLedger.__inspLoadSettled);
  releaseOldR();
  await pR.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineR2);
  check('R:旧请求迟到失败后详情仍完整显示(未被旧请求的catch分支覆盖)',await pR.locator('.itl-sheet-title h2').count()===1,await pR.locator('#itlContent').innerText());
  check('R:无错误卡片/返回按钮残留(mode未被旧请求重置回list)',await pR.locator('#itlContent .itl-form-error').count()===0&&await pR.locator('#itlSheetErrorBack').count()===0);
  const toastHiddenR=await pR.locator('#itlToast').isHidden();
  check('R:无"已不存在"toast(旧404/失败分支未被触发)',toastHiddenR||!(await pR.locator('#itlToast').innerText()).includes('已不存在'));
  check('浏览器无未捕获异常(R)',errorsR2.length===0);
  await cR.close();

  // S) M-3（C5a-1c 必修，二次预筛）：XSS覆盖补齐剩余两处——created_by_name（块I/J等此前只测过普通中文
  // 姓名，这里改用fixture-5专用测试用户，避免污染其它块共用的fixture-2/-3/-1显示名）、机柜名
  // （target_label，正常项里的机柜行）、异常列表里一台"判异常"的设备的target_label（块I的异常设备是
  // 机房检查项，不是设备项）。
  const nameRespS=await f.run('UPDATE users SET display_name=? WHERE id=5',[XSS]);
  assert.equal(nameRespS.changes,1,'S改fixture-5显示名失败 '+JSON.stringify(nameRespS));
  // fixture-5默认不带ACL(夹具注释：需要时自己插入write级)——本块要用它建单，先给write。
  await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
  const rackNameS='SF-RackXSS'+XSS;
  const deviceNameS='DevBadXSS'+XSS;
  const rackS=(await f.api('POST','/racks',{name:rackNameS,room:'SF-RoomS',u_total:20})).body;
  await f.api('POST','',{category:'server',name:deviceNameS,u_height:1,placement:{kind:'rack',rack_id:rackS.id,u_start:1}});
  const createdS=await createSheet(5,'SF-RoomS');
  assert.equal(createdS.status,201,'S createSheet '+JSON.stringify(createdS.body));
  const detailS0=await getSheet(createdS.body.id,5);
  const itemsS=fillPayloadAllOk(detailS0.body.items);
  const deviceItemS=detailS0.body.items.find(it=>it.section==='device');
  const targetS=itemsS.find(x=>x.id===deviceItemS.id);
  targetS.result='bad';targetS.note='S测试:设备异常';
  const putS=await f.api('PUT','/inspections/sheets/'+createdS.body.id,{expected_version:createdS.body.version,items:itemsS},5);
  assert.equal(putS.status,200,'S put '+JSON.stringify(putS.body));
  await uploadAllRackFrontPhotos(createdS.body.id,createdS.body.scope,5);
  await uploadPhoto(createdS.body.id,'item',deviceItemS.id,5);
  const submitS=await f.api('POST','/inspections/sheets/'+createdS.body.id+'/submit',{expected_version:putS.body.version},5);
  assert.equal(submitS.status,200,'S submit '+JSON.stringify(submitS.body));
  const csx=await browser.newContext();await csx.addInitScript(()=>localStorage.setItem('token','fixture-1'));const ps=await csx.newPage();const errorsS=[];ps.on('pageerror',e=>errorsS.push(e.message));
  await ps.goto(f.base+'/IT_Ledger.html#inspections');await ps.locator('[data-insp-row="'+submitS.body.id+'"]').waitFor();
  await ps.locator('[data-insp-view="'+submitS.body.id+'"]').click();await ps.locator('.itl-sheet-title h2').waitFor();
  const metaTextS=await ps.locator('.itl-sheet-title .itl-muted').innerText();
  check('M-3:巡检人姓名(created_by_name)里的XSS载荷原样显示为纯文本',metaTextS.includes(XSS),metaTextS);
  const badTextS=await ps.locator('.itl-sheet-bad-list').innerText();
  check('M-3:异常列表设备行原样显示带XSS的设备名(target_label)',badTextS.includes(deviceNameS),badTextS);
  await ps.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okTextS=await ps.locator('.itl-sheet-ok').innerText();
  check('M-3:正常机柜行原样显示带XSS的机柜名(target_label)',okTextS.includes(rackNameS),okTextS);
  check('M-3:全部XSS载荷未被执行(window.__xss未定义)',await ps.evaluate(()=>window.__xss)===undefined);
  check('浏览器无未捕获异常(S)',errorsS.length===0);
  await csx.close();

  // ============================================================
  // C5a 段3：新建 / 草稿填写 / 写队列 / 冲突 / 采集 / 提交 / 删除草稿。
  // ============================================================

  // T) M1（codex 42 对已提交详情切片的复审，段3追加）：normalRackText 曾对"正常项计数为0"的机柜也
  // 输出"机柜 0 项"——两个机柜（RackFixA 全异常、RackFixB 全正常），断言"正常项"展开区只列出RackFixB。
  const racksT=await makeRoomWithRacks('SF-RoomRackFix',['RackFixA','RackFixB']);
  const createdT=await createSheet(2,'SF-RoomRackFix');
  assert.equal(createdT.status,201,'T create '+JSON.stringify(createdT.body));
  const itemsT=fillPayloadAllOk(createdT.body.items);
  const badIdsT=[];
  itemsT.forEach(it=>{const orig=createdT.body.items.find(x=>x.id===it.id);if(orig.section==='rack'&&orig.target_id===racksT[0].id){it.result='bad';it.note='T测试:柜A全异常';badIdsT.push(it.id);}});
  const putT=await f.api('PUT','/inspections/sheets/'+createdT.body.id,{expected_version:createdT.body.version,items:itemsT},2);
  assert.equal(putT.status,200,'T put '+JSON.stringify(putT.body));
  await uploadAllRackFrontPhotos(createdT.body.id,createdT.body.scope,2);
  for(const bid of badIdsT)await uploadPhoto(createdT.body.id,'item',bid,2);
  const submitT=await f.api('POST','/inspections/sheets/'+createdT.body.id+'/submit',{expected_version:putT.body.version},2);
  assert.equal(submitT.status,200,'T submit '+JSON.stringify(submitT.body));
  const ct=await browser.newContext();await ct.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pt=await ct.newPage();const errorsT=[];pt.on('pageerror',e=>errorsT.push(e.message));
  await pt.goto(f.base+'/IT_Ledger.html#inspections');await pt.locator('[data-insp-row="'+submitT.body.id+'"]').waitFor();
  await pt.locator('[data-insp-view="'+submitT.body.id+'"]').click();await pt.locator('.itl-sheet-title h2').waitFor();
  await pt.locator('.itl-sheet-ok').waitFor({state:'visible'});
  const okTextT=await pt.locator('.itl-sheet-ok').innerText();
  check('M1(codex42):正常项机柜行只列出有正常项的机柜(RackFixB)',okTextT.includes('RackFixB'),okTextT);
  check('M1(codex42):全异常的机柜(RackFixA)不再显示"RackFixA 0 项"',!okTextT.includes('RackFixA'),okTextT);
  check('浏览器无未捕获异常(T)',errorsT.length===0);
  await ct.close();

  // U) L1（codex 42，段3追加）：详情GET挂起期间触发真实的权限丢失流程（经api()真实的403分支→
  // clearData()→onAccessLost()），分别放行详情GET的成功与失败响应，断言权限提示未被覆盖，且旧响应
  // 确实已结算（不是观察窗口还没关上）。
  const submittedU=await buildSubmittedSheet('SF-RoomAccessLost',2,false);
  const cu=await browser.newContext();await cu.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pu=await cu.newPage();const errorsU=[];pu.on('pageerror',e=>errorsU.push(e.message));
  await pu.goto(f.base+'/IT_Ledger.html#inspections');await pu.locator('[data-insp-row="'+submittedU.id+'"]').waitFor();
  const heldU=holdRoute(pu,'**/api/it-assets/inspections/sheets/'+submittedU.id,'GET');
  await pu.locator('[data-insp-view="'+submittedU.id+'"]').click();
  await heldU.entered;
  const settledBaseU=await pu.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pu.route('**/api/it-assets/floors',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})}),{times:1});
  await pu.evaluate(()=>window.ITLedger.api('/floors').catch(()=>{}));
  await pu.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextU=await pu.locator('#itlNotice').innerText();
  check('L1(codex42):经真实api()403分支触发的权限丢失提示已出现',noticeTextU.includes('访问权限已变化'),noticeTextU);
  heldU.release();
  await pu.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaseU);
  check('L1(codex42):放行成功的详情响应未覆盖权限丢失提示',(await pu.locator('#itlNotice').innerText())===noticeTextU);
  check('L1(codex42):放行成功的详情响应未渲染出详情标题',await pu.locator('.itl-sheet-title').count()===0);
  check('浏览器无未捕获异常(U-成功分支)',errorsU.length===0);
  await cu.close();

  const submittedU2=await buildSubmittedSheet('SF-RoomAccessLost2',2,false);
  const cu2=await browser.newContext();await cu2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pu2=await cu2.newPage();const errorsU2=[];pu2.on('pageerror',e=>errorsU2.push(e.message));
  await pu2.goto(f.base+'/IT_Ledger.html#inspections');await pu2.locator('[data-insp-row="'+submittedU2.id+'"]').waitFor();
  let releaseU2,enteredU2;const enteredU2P=new Promise(r=>enteredU2=r);
  await pu2.route('**/api/it-assets/inspections/sheets/'+submittedU2.id,async route=>{if(route.request().method()!=='GET')return route.fallback();enteredU2();await new Promise(r=>releaseU2=r);await route.abort('failed');});
  await pu2.locator('[data-insp-view="'+submittedU2.id+'"]').click();
  await enteredU2P;
  const settledBaseU2=await pu2.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pu2.route('**/api/it-assets/floors',route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})}),{times:1});
  await pu2.evaluate(()=>window.ITLedger.api('/floors').catch(()=>{}));
  await pu2.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextU2=await pu2.locator('#itlNotice').innerText();
  releaseU2();
  await pu2.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaseU2);
  check('L1(codex42):放行失败的详情响应未覆盖权限丢失提示',(await pu2.locator('#itlNotice').innerText())===noticeTextU2);
  check('L1(codex42):放行失败的详情响应未渲染出错误卡片',await pu2.locator('#itlContent .itl-form-error').count()===0);
  check('浏览器无未捕获异常(U-失败分支)',errorsU2.length===0);
  await cu2.close();

  // V) 新建：room picker → POST / 成功 → 进入真实的草稿填写页。
  await f.api('POST','/racks',{name:'SF-RoomNew1-柜1',room:'SF-RoomNew1',u_total:20},1);
  const cv=await browser.newContext();await cv.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pv=await cv.newPage();const errorsV=[];pv.on('pageerror',e=>errorsV.push(e.message));
  await pv.goto(f.base+'/IT_Ledger.html#inspections');await pv.locator('#itlInspNew').waitFor();
  await pv.locator('#itlInspNew').click();
  await pv.locator('#itlModal.open').waitFor();
  check('V:新增巡检弹窗含机房下拉且包含刚建的机柜所在机房',(await pv.locator('select[name="room_name"]').innerText()).includes('SF-RoomNew1'));
  await pv.locator('select[name="room_name"]').selectOption('SF-RoomNew1');
  await pv.locator('#itlSubmit').click();
  await pv.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pv);
  check('V:提交后进入真实的草稿填写页(标题含新机房名)',(await pv.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomNew1'));
  check('V:填写页三段卡片都渲染出来',await pv.locator('[data-sheet-section]').count()===3);
  check('浏览器无未捕获异常(V)',errorsV.length===0);
  await cv.close();

  // W) 已存在草稿：409 SHEET_DRAFT_EXISTS → 提示"该机房已有草稿(巡检人X,开始于Y)" → "打开该草稿"。
  const draftW=await buildDraftSheet('SF-RoomDup',2);
  const cw=await browser.newContext();await cw.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pw=await cw.newPage();const errorsW=[];pw.on('pageerror',e=>errorsW.push(e.message));
  await pw.goto(f.base+'/IT_Ledger.html#inspections');await pw.locator('#itlInspNew').waitFor();
  await pw.locator('#itlInspNew').click();await pw.locator('#itlModal.open').waitFor();
  await pw.locator('select[name="room_name"]').selectOption('SF-RoomDup');
  await pw.locator('#itlSubmit').click();
  await pw.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='该机房已有草稿');
  const promptTextW=await pw.locator('#itlModalBody').innerText();
  check('W:409提示含巡检人姓名与机房名',promptTextW.includes('测试维护员')&&promptTextW.includes(draftW.room_name),promptTextW);
  await pw.locator('#itlSubmit').click();
  await pw.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pw);
  check('W:点"打开该草稿"打开的正是那张草稿(标题含机房名)',(await pw.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomDup'));
  check('浏览器无未捕获异常(W)',errorsW.length===0);
  await cw.close();

  // X) 填三段 + "本段其余全部正常"（不覆盖已标异常）+ 越界读数前端拦截 + 防抖后PUT请求体校验。
  const draftX=await buildDraftSheet('SF-RoomForm1',2);
  const cx=await browser.newContext();await cx.addInitScript(()=>localStorage.setItem('token','fixture-2'));const px=await cx.newPage();const errorsX=[];px.on('pageerror',e=>errorsX.push(e.message));
  await px.goto(f.base+'/IT_Ledger.html#inspections');await px.locator('[data-insp-row="'+draftX.id+'"]').waitFor();
  await px.locator('[data-insp-continue="'+draftX.id+'"]').click();
  await px.locator('#itlFormActionbar').waitFor();await expandInspectionForm(px);
  check('X:三段卡片齐全(room/rack/device)',await px.locator('[data-sheet-section]').count()===3);
  let putCountX=0;const putBodiesX=[];px.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftX.id)){putCountX++;try{putBodiesX.push(r.postDataJSON());}catch(_e){putBodiesX.push(null);}}});
  const sentinelX=async()=>{const seen=px.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await px.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  // T-H2（43T H2）：假时钟在任何输入触发之前就装好并pauseAt，PUT计数器（上面两行）也已提前注册——防
  // "实现错误地已经排了一个旧计时器，fastForward未必推得到它"这个坑（旧版clock装在越界输入之后，若
  // 越界处理本身错误地排了一个真实计时器，这里的fastForward会推空）。
  await px.clock.install();await px.clock.pauseAt(new Date());
  const tempInputX=px.locator('[data-sheet-section="room"] input[type=number]').first();
  await tempInputX.fill('200');
  check('X:越界读数前端拦截,显示范围错误提示',(await px.locator('.itl-sheet-num-error').first().innerText()).includes('超出范围'));
  // H5：推过2秒以上（超过1.5秒防抖窗口），用到达信号证明这段观察窗口确实已经过去，此时PUT计数必须
  // 恰为0，才是真正验证"越界值零请求"，不是"后来被覆盖成合法值所以看不出来"。
  await px.clock.fastForward(2500);
  await sentinelX();
  check('X(H5):越界值200推过2秒防抖窗口(到达信号证明观察窗口已过)后PUT计数恰为0',putCountX===0,putCountX);
  await tempInputX.fill('22');
  await px.locator('[data-sheet-section="rack"] [data-seg-bad]').first().click();
  check('X:手动标异常后该段有且只有1个异常标记',await px.locator('[data-sheet-section="rack"] .on-bad').count()===1);
  await px.locator('[data-sheet-section="rack"] [data-all-normal]').click();
  check('X:"本段其余全部正常"不覆盖已标异常的机柜项,其余3项变正常',await px.locator('[data-sheet-section="rack"] .on-bad').count()===1&&await px.locator('[data-sheet-section="rack"] .on-ok').count()===3);
  await px.locator('[data-sheet-section="room"] [data-all-normal]').click();
  await px.locator('[data-sheet-section="device"] [data-all-normal]').click();
  const settledBeforeX=await px.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  // 时钟被冻住之后新排的防抖计时器不会自己流逝，手动推过去——**坑**：fastForward()会在自己的调用过程
  // 内部就把到期的计时器回调跑掉（对应的PUT请求会在fastForward这次await完成之前就已经发出/到达），
  // 之后再调用一次性的page.waitForRequest()注册监听器为时已晚（会永远等不到，实测撞过一次30秒超时）。
  // 改用前面已经常驻的px.on('request',...)监听器所在的putBodiesX数组读最后一条，配合settled计数确认
  // 这次冲刷确实已经落定，不用一次性的waitForRequest。
  await px.clock.fastForward(2500);
  await px.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeX);
  const bodyX=putBodiesX[putBodiesX.length-1];
  check('X:防抖后的PUT请求体不含越界值200(前端已拦截,从未写入working)',!JSON.stringify(bodyX).includes('200'),bodyX);
  check('X:PUT请求体items每项恰好四键(id/result/number_value/note)',bodyX.items.every(it=>Object.keys(it).length===4&&['id','result','number_value','note'].every(k=>Object.hasOwn(it,k))),bodyX);
  // M9：未改备注时顶层键集合应恰好 {expected_version, items}。
  check('M9:未改备注时PUT请求体顶层键集合恰为{expected_version,items}',JSON.stringify(Object.keys(bodyX).sort())===JSON.stringify(['expected_version','items']),Object.keys(bodyX));
  check('M9:expected_version等于该单当前版本',bodyX.expected_version===draftX.version,bodyX.expected_version);
  check('浏览器无未捕获异常(X)',errorsX.length===0);
  await cx.close();

  // Y) 防抖合并（1.5秒内多次修改只发一次PUT）+ 飞行中修改不丢（挂起期间再改一项,放行后不等1.5秒立即
  // 冲刷）——handoff-agent6.md §3.1 最容易写错的两点。用 __inspFormFlushSettled 结算计数，不用 sleep。
  const draftY=await buildDraftSheet('SF-RoomDebounce',2);
  const cy=await browser.newContext();await cy.addInitScript(()=>localStorage.setItem('token','fixture-2'));const py=await cy.newPage();const errorsY=[];py.on('pageerror',e=>errorsY.push(e.message));
  let putCountY=0;const putBodiesY=[];
  py.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftY.id)){putCountY++;try{putBodiesY.push(r.postDataJSON());}catch(_e){putBodiesY.push(null);}}});
  await py.goto(f.base+'/IT_Ledger.html#inspections');await py.locator('[data-insp-row="'+draftY.id+'"]').waitFor();
  await py.locator('[data-insp-continue="'+draftY.id+'"]').click();await py.locator('#itlFormActionbar').waitFor();await expandInspectionForm(py);
  const baseSettledY=await py.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  const roomOkBtnsY=await py.locator('[data-sheet-section="room"] [data-seg-ok]').all();
  for(let i=0;i<3;i++)await roomOkBtnsY[i].click();
  await py.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledY);
  check('Y-防抖:1.5秒内连续3次修改只发出1次PUT',putCountY===1,putCountY);
  check('Y-防抖:该次PUT请求体items里3个正常项恰好各4键',putBodiesY[0].items.length===3&&putBodiesY[0].items.every(it=>Object.keys(it).length===4),putBodiesY[0]);

  // T-H1（43T H1，方案必做1）：在途锁下"飞行中编辑"不再可能发生——挂起期间整张表单disabled，尝试编辑
  // 被渲染层(disabled属性)与监听器(isLocked(f)开头return)双重挡住；落定后编辑恢复正常，正常排保存。
  const heldY=holdRoute(py,'**/api/it-assets/inspections/sheets/'+draftY.id,'PUT');
  await py.locator('[data-sheet-section="device"] [data-seg-bad]').first().click();
  await heldY.entered;
  check('Y-在途锁:挂起期间累计PUT数为2(第1次已完成+第2次刚发出并挂起)',putCountY===2,putCountY);
  const rackBadBtnY=py.locator('[data-sheet-section="rack"] [data-seg-bad]').first();
  check('Y-在途锁:挂起期间机柜异常按钮已disabled(渲染层)',await rackBadBtnY.isDisabled());
  // 先摘掉disabled再点（同AK块M3的手法）：绕开"浏览器对disabled元素不派发click"这个天然屏障，测的是
  // toggleSeg函数体内isLocked(f)判据本身，不是"点不动"这个UI表象。
  await py.evaluate(()=>{document.querySelector('[data-sheet-section="rack"] [data-seg-bad]').disabled=false;});
  await rackBadBtnY.click();
  check('Y-在途锁:在途期间的编辑尝试被监听器拒绝,working零状态变化(机柜项仍未标记)',await py.locator('[data-sheet-section="rack"] .on-bad').count()===0);
  check('Y-在途锁:在途期间的编辑尝试没有触发新的PUT(计数仍为2)',putCountY===2,putCountY);
  const settledBeforeReleaseY=await py.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldY.release();
  await py.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeReleaseY);
  check('Y-在途锁:落定后解锁,机柜异常按钮恢复可点(不再disabled,证明上面手动摘掉的disabled已被落定后的重渲染重新算过一遍,不是残留的手动状态)',await rackBadBtnY.isDisabled()===false);
  const settledBeforeRetryY=await py.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await rackBadBtnY.click();
  check('Y-在途锁:落定后点击立即反映在界面上',await py.locator('[data-sheet-section="rack"] .on-bad').count()===1);
  await py.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeRetryY);
  check('Y-在途锁:落定后的编辑正常排了一次新的PUT(计数变为3)',putCountY===3,putCountY);
  const lastBodyY=putBodiesY[putBodiesY.length-1];
  check('Y-在途锁:这次PUT请求体包含刚点的机柜异常项',lastBodyY.items.some(it=>it.result==='bad'),lastBodyY);
  check('浏览器无未捕获异常(Y)',errorsY.length===0);
  await cy.close();

  // Z) 版本冲突（409 SHEET_VERSION_CONFLICT）：保留本地未保存修改并高亮，重新GET载入(未被本地改动的
  // 项用服务器值)，提示文案，不自动重发，第二次保存(新version)成功。
  const draftZ=await buildDraftSheet('SF-RoomConflict',2);
  const airconZ=draftZ.items.find(it=>it.item_key==='aircon');
  const upsZ=draftZ.items.find(it=>it.item_key==='ups');
  const fireZ=draftZ.items.find(it=>it.item_key==='fire');
  const cz=await browser.newContext();await cz.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pz=await cz.newPage();const errorsZ=[];pz.on('pageerror',e=>errorsZ.push(e.message));
  await pz.goto(f.base+'/IT_Ledger.html#inspections');await pz.locator('[data-insp-row="'+draftZ.id+'"]').waitFor();
  await pz.locator('[data-insp-continue="'+draftZ.id+'"]').click();await pz.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pz);
  // T-H2（43T H2）：假时钟与PUT计数器在第一次编辑触发之前就装好并pauseAt/注册——同X块同一个坑：装在
  // 触发之后，若实现错误地已经排了一个真实计时器，fastForward未必推得到它。
  let putCountZ=0;pz.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftZ.id))putCountZ++;});
  await pz.clock.install();await pz.clock.pauseAt(new Date());
  const baseSettledZ=await pz.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pz.locator('[data-seg-ok="'+airconZ.id+'"]').click();
  const otherPutZ=await f.api('PUT','/inspections/sheets/'+draftZ.id,{expected_version:draftZ.version,items:[{id:upsZ.id,result:'bad',number_value:null,note:'其他人标记异常'}]},2);
  assert.equal(otherPutZ.status,200,'Z other put '+JSON.stringify(otherPutZ.body));
  await pz.clock.fastForward(2500); // 推过1.5秒防抖，触发这次PUT——服务端此刻已被otherPutZ改过，会409
  await pz.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledZ);
  const noticeTextZ=await pz.locator('#itlNotice').innerText();
  check('Z:版本冲突提示文案',noticeTextZ.includes('这张单已在别处被修改，你的改动仍在，请核对后再保存'),noticeTextZ);
  check('Z:本地未保存的修改(aircon->ok)仍保留',await pz.locator('[data-seg-ok="'+airconZ.id+'"].on-ok').count()===1);
  check('Z:冲突项被高亮标记',await pz.locator('[data-item-id="'+airconZ.id+'"].itl-sheet-conflict').count()===1);
  check('Z:未被本地改动的项(ups)用服务器最新值刷新为异常',await pz.locator('[data-seg-bad="'+upsZ.id+'"].on-bad').count()===1);
  // H5：推过2秒以上（超过1.5秒防抖窗口），按PUT计数断言零重发——如果handleConflict忘了
  // clearTimeout(H3③)，一个更早排的自动保存计时器本可能在这个窗口内重新触发一次PUT。
  const putCountZBeforeClock=putCountZ;
  await pz.clock.fastForward(2500);
  const sentinelZ=async()=>{const seen=pz.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pz.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await sentinelZ();
  check('Z(H5):409后推过2秒以上(超过1.5秒防抖窗口)不自动重发,PUT计数未增加',putCountZ===putCountZBeforeClock,putCountZ);
  const settledBeforeRetryZ=await pz.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pz.locator('[data-seg-ok="'+fireZ.id+'"]').click();
  await pz.clock.fastForward(2500); // 用户这次编辑之后新排的防抖计时器同样不会自己流逝，手动推过去。
  await pz.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeRetryZ);
  const finalGetZ=await getSheet(draftZ.id,2);
  check('Z:第二次保存(新version)成功,服务端落库了aircon(本地保留的冲突项)与fire(新点的项)',finalGetZ.body.items.find(it=>it.id===airconZ.id).result==='ok'&&finalGetZ.body.items.find(it=>it.id===fireZ.id).result==='ok',finalGetZ.body.items);
  check('Z:冲突高亮在成功保存后清除',await pz.locator('.itl-sheet-conflict').count()===0);
  check('浏览器无未捕获异常(Z)',errorsZ.length===0);
  await cz.close();

  // AA) 切页签冲刷（onLeave）：填写页有防抖中修改时切换页签，先冲刷写队列——断言保存请求确实发出且
  // 落库（方案 v0.5 §6.1 末条）。
  const draftAA=await buildDraftSheet('SF-RoomLeave',2);
  const airconAA=draftAA.items.find(it=>it.item_key==='aircon');
  const caa=await browser.newContext();await caa.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paa=await caa.newPage();const errorsAA=[];paa.on('pageerror',e=>errorsAA.push(e.message));
  await paa.goto(f.base+'/IT_Ledger.html#inspections');await paa.locator('[data-insp-row="'+draftAA.id+'"]').waitFor();
  await paa.locator('[data-insp-continue="'+draftAA.id+'"]').click();await paa.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paa);
  // 装好假时钟并显式pauseAt之后，scheduleAutosave 用的 setTimeout(1500ms) 不会自己流逝——onLeave 若
  // 真的立即冲刷（enqueue 不依赖计时器）才能让保存发生；若 onLeave 退化成空操作，时钟冻住后 1.5 秒
  // 防抖永远不会自然触发，下面的 waitForFunction 会等到超时才失败——这正是区分"立即冲刷"与"碰巧也会在
  // 1.5秒后自然触发"这两种情况的关键。**自决点/坑**：只调用 clock.install() 不够——实测(独立debug脚本
  // 验证过)install()之后不显式pauseAt()，虚拟时钟仍按真实速度流逝，1.5秒后计时器照常触发，测不出这个
  // 差别；必须显式pauseAt(new Date())才会真正冻住（变异自检第一次跑就撞上了这个坑，见交付报告）。
  await paa.clock.install();
  await paa.clock.pauseAt(new Date());
  const baseSettledAA=await paa.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await paa.locator('[data-seg-ok="'+airconAA.id+'"]').click();
  await paa.evaluate(()=>{location.hash='racks';});
  await paa.locator('.itl-rack-workspace').waitFor();
  await paa.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAA,{timeout:5000});
  const afterLeaveAA=await getSheet(draftAA.id,2);
  check('AA:切页签(onLeave)立即冲刷了防抖中的修改,已落库',afterLeaveAA.body.items.find(it=>it.id===airconAA.id).result==='ok',afterLeaveAA.body.items);
  check('浏览器无未捕获异常(AA)',errorsAA.length===0);
  await caa.close();

  // AB) beforeunload：队列非空/有未落盘修改时提示离开确认；落盘完成后不再提示。
  const draftAB=await buildDraftSheet('SF-RoomBeforeUnload',2);
  const airconAB=draftAB.items.find(it=>it.item_key==='aircon');
  const cab=await browser.newContext();await cab.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pab=await cab.newPage();const errorsAB=[];pab.on('pageerror',e=>errorsAB.push(e.message));
  await pab.goto(f.base+'/IT_Ledger.html#inspections');await pab.locator('[data-insp-row="'+draftAB.id+'"]').waitFor();
  await pab.locator('[data-insp-continue="'+draftAB.id+'"]').click();await pab.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pab);
  const baseSettledAB=await pab.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pab.locator('[data-seg-ok="'+airconAB.id+'"]').click();
  const preventedDirtyAB=await pab.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('AB:有未落盘修改(防抖中)时beforeunload被阻止(离开需确认)',preventedDirtyAB===true,preventedDirtyAB);
  await pab.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAB);
  const preventedCleanAB=await pab.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('AB:落盘完成、无未落盘修改时beforeunload不再阻止',preventedCleanAB===false,preventedCleanAB);
  check('浏览器无未捕获异常(AB)',errorsAB.length===0);
  await cab.close();

  // AB-2（T-M2，43T M2）：返回列表后，该单的队列若仍有未完成的任务（离开时冲刷还没落定），beforeunload
  // 仍应拦——判据是queuesBySheetId整体是否清空，不能只看"当前是否还有打开的表单"（离开后表单可能已经
  // left=true但队列还在跑，也可能因S-H1冲刷失败被保留）。
  const draftAB2=await buildDraftSheet('SF-RoomBeforeUnload2',2);
  const airconAB2=draftAB2.items.find(it=>it.item_key==='aircon');
  const cab2=await browser.newContext();await cab2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pab2=await cab2.newPage();const errorsAB2=[];pab2.on('pageerror',e=>errorsAB2.push(e.message));
  await pab2.goto(f.base+'/IT_Ledger.html#inspections');await pab2.locator('[data-insp-row="'+draftAB2.id+'"]').waitFor();
  await pab2.locator('[data-insp-continue="'+draftAB2.id+'"]').click();await pab2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pab2);
  const baseSettledAB2=await pab2.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  const heldAB2=holdRequestRoute(pab2,'**/api/it-assets/inspections/sheets/'+draftAB2.id,'PUT');
  await pab2.locator('[data-seg-ok="'+airconAB2.id+'"]').click();
  await heldAB2.entered; // PUT挂起中——这张单的队列非空
  await pab2.locator('#itlFormBack').click(); // 触发leaveForm+返回列表，不等冲刷落定
  await pab2.locator('[data-insp-row]').first().waitFor();
  const preventedAB2=await pab2.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('AB-2(T-M2):已经离开表单回到列表,但该单队列仍有未完成的PUT(挂起中),beforeunload仍拦',preventedAB2===true,preventedAB2);
  heldAB2.release();
  await pab2.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAB2);
  const preventedAfterAB2=await pab2.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('AB-2(T-M2):队列落定清空后beforeunload不再拦',preventedAfterAB2===false,preventedAfterAB2);
  check('浏览器无未捕获异常(AB-2)',errorsAB2.length===0);
  await cab2.close();

  // AC) 弹窗所有权令牌（spec「段3补充」）：后台写请求挂起期间用户打开了另一个弹窗，旧请求回调里的
  // closeModal(true)必须先核对令牌，不是自己打开的那个不关。用既有的批量归档流程作"旧请求"（其
  // closeModal(true)发生在await之后，是spec原文点名的既有写回调），直接调用L.openModal模拟"用户在
  // 等待期间打开了另一个弹窗"，验证放行后新弹窗仍在。
  const submittedAC=await buildSubmittedSheet('SF-RoomModal1',2,false);
  const cac=await browser.newContext();await cac.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pac=await cac.newPage();const errorsAC=[];pac.on('pageerror',e=>errorsAC.push(e.message));
  await pac.goto(f.base+'/IT_Ledger.html#inspections');await pac.locator('[data-insp-check="'+submittedAC.id+'"]').waitFor();
  await pac.locator('[data-insp-check="'+submittedAC.id+'"]').check();
  await pac.locator('#itlInspBatchArchive').click();
  await pac.locator('#itlModalTitle').waitFor();
  const heldAC=holdRoute(pac,'**/api/it-assets/inspections/sheets/archive','POST');
  await pac.locator('#itlSubmit').click();
  await heldAC.entered;
  await pac.evaluate(()=>{window.ITLedger.openModal('已存在草稿','<p>模拟另一个弹窗</p>',async()=>{},'关闭');});
  check('AC:新弹窗已经打开(标题为"已存在草稿")',(await pac.locator('#itlModalTitle').innerText())==='已存在草稿');
  heldAC.release();
  await pac.locator('#itlToast:not([hidden])').waitFor();
  const toastTextAC=await pac.locator('#itlToast').innerText();
  check('AC:归档请求已完成(toast出现"已归档")',toastTextAC.includes('已归档'),toastTextAC);
  check('AC:令牌核对生效——归档回调放行完成后,新弹窗(已存在草稿)仍然打开,未被误关',await pac.locator('#itlModal.open').count()===1&&(await pac.locator('#itlModalTitle').innerText())==='已存在草稿');
  const archivedCheckAC=await getSheet(submittedAC.id,1);
  check('AC:归档请求本身确实成功落库(证明回调真的跑到了closeModal(true)这一步,只是被令牌挡住)',archivedCheckAC.body.status==='archived',archivedCheckAC.body);
  check('浏览器无未捕获异常(AC)',errorsAC.length===0);
  await cac.close();

  // AD) 一键采集：AD-成功(独立夹具+假采集器,不触发真实远程采集)——成功后该行更新、toast显示"采集完成
  // · 告警N项"；AD-失败(主夹具里没有sn/ip的设备，第一阶段同步拒绝,409 SHEET_STATE)按码提示。
  const overridesAD={};
  const HOST_AD='203.0.113.9';
  const collectorAD={host:()=>HOST_AD,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_AD,server:{name:'srv',manufacturer:'x',model:'y',serial_number:overridesAD.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:overridesAD.alerts||[],component_errors:[],cleanup_warnings:[],collection_status:overridesAD.collectionStatus||'success',started_at:now,completed_at:now};}};
  const fAD=await createFixture({inspectionCollector:collectorAD});
  const rackAD=(await fAD.api('POST','/racks',{name:'SF-RoomCollect-柜1',room:'SF-RoomCollect',u_total:20})).body;
  overridesAD.sn='SN-COLLECT-AD-01';
  await fAD.api('POST','',{category:'server',name:'SF-RoomCollect-设备1',sn:overridesAD.sn,attrs:{ip:HOST_AD},u_height:1,placement:{kind:'rack',rack_id:rackAD.id,u_start:1}});
  const createdAD=await fAD.api('POST','/inspections/sheets',{room_name:'SF-RoomCollect'},2);
  assert.equal(createdAD.status,201,'AD create '+JSON.stringify(createdAD.body));
  overridesAD.alerts=[{severity:'attention',kind:'test',message:'测试告警A'},{severity:'attention',kind:'test',message:'测试告警B'}];
  const cad=await browser.newContext();await cad.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pad=await cad.newPage();const errorsAD=[];pad.on('pageerror',e=>errorsAD.push(e.message));
  await pad.goto(fAD.base+'/IT_Ledger.html#inspections');await pad.locator('[data-insp-row="'+createdAD.body.id+'"]').waitFor();
  await pad.locator('[data-insp-continue="'+createdAD.body.id+'"]').click();await pad.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pad);
  check('AD:草稿阶段设备段显示"一键采集"按钮(actions含collect)',await pad.locator('[data-collect-id]').count()===1);
  // C5c（方案v0.6§6"设备采集明细展开"条）：这台设备此刻还没采集过(device_inspection_id为空)，不该
  // 出现"展开明细"按钮——deviceExpandHtml对没有device_inspection_id的行直接返回空字符串，这里核对
  // 采集之前确实没有任何展开按钮（采集完成后的展开按钮已在BS块验证过）。
  check('C5c(AD):未采集过的设备没有展开明细按钮',await pad.locator('[data-device-expand]').count()===0);
  const deviceItemAD=createdAD.body.items.find(it=>it.section==='device');
  await pad.locator('[data-collect-id="'+deviceItemAD.id+'"]').click();
  await pad.locator('[data-collect-id="'+deviceItemAD.id+'"][disabled]').waitFor();
  check('AD:采集中按钮disabled且文案"正在采集…"',(await pad.locator('[data-collect-id="'+deviceItemAD.id+'"]').innerText()).includes('正在采集'));
  await pad.locator('#itlToast:not([hidden])').waitFor();
  const toastTextAD=await pad.locator('#itlToast').innerText();
  check('AD:采集完成后toast显示"采集完成 · 告警 2 项"',toastTextAD.includes('采集完成')&&toastTextAD.includes('告警 2 项'),toastTextAD);
  check('AD:采集完成后该按钮恢复可点(不再disabled)',await pad.locator('[data-collect-id="'+deviceItemAD.id+'"][disabled]').count()===0);
  check('浏览器无未捕获异常(AD-成功)',errorsAD.length===0);
  await cad.close();
  await fAD.close();

  const draftADFail=await buildDraftSheet('SF-RoomCollectFail',2);
  const deviceItemADFail=draftADFail.items.find(it=>it.section==='device');
  const cadf=await browser.newContext();await cadf.addInitScript(()=>localStorage.setItem('token','fixture-2'));const padf=await cadf.newPage();const errorsADF=[];padf.on('pageerror',e=>errorsADF.push(e.message));
  await padf.goto(f.base+'/IT_Ledger.html#inspections');await padf.locator('[data-insp-row="'+draftADFail.id+'"]').waitFor();
  await padf.locator('[data-insp-continue="'+draftADFail.id+'"]').click();await padf.locator('#itlFormActionbar').waitFor();await expandInspectionForm(padf);
  await padf.locator('[data-collect-id="'+deviceItemADFail.id+'"]').click();
  await padf.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextADF=await padf.locator('#itlNotice').innerText();
  check('AD-失败:采集状态码SHEET_STATE保留服务端完整原因',noticeTextADF==='采集失败：设备当前不满足采集条件：该设备未配置可用的服务器采集连接',noticeTextADF);
  check('AD-失败:采集按钮恢复可点(不卡在禁用态)',await padf.locator('[data-collect-id="'+deviceItemADFail.id+'"][disabled]').count()===0);
  check('浏览器无未捕获异常(AD-失败)',errorsADF.length===0);
  await cadf.close();

  // AE) 提交：AE-1成功(通过UI填完字段,照片走直传API模拟"C5b照片UI尚未落地"这一现状,只测提交本身的
  // UI流程能否正确进详情页)；AE-2不完整(未传照片)400 SHEET_INCOMPLETE,notice列出缺项,仍停在填写页。
  const draftAE=await buildDraftSheet('SF-RoomSubmitOK',2);
  const cae=await browser.newContext();await cae.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pae=await cae.newPage();const errorsAE=[];pae.on('pageerror',e=>errorsAE.push(e.message));
  await pae.goto(f.base+'/IT_Ledger.html#inspections');await pae.locator('[data-insp-row="'+draftAE.id+'"]').waitFor();
  await pae.locator('[data-insp-continue="'+draftAE.id+'"]').click();await pae.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pae);
  const baseSettledAE=await pae.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pae.locator('[data-sheet-section="room"] input[type=number]').nth(0).fill('22');
  await pae.locator('[data-sheet-section="room"] input[type=number]').nth(1).fill('45');
  await pae.locator('[data-sheet-section="room"] [data-all-normal]').click();
  await pae.locator('[data-sheet-section="rack"] [data-all-normal]').click();
  await pae.locator('[data-sheet-section="device"] [data-all-normal]').click();
  await pae.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAE);
  const midAE=await getSheet(draftAE.id,2);
  await uploadAllRackFrontPhotos(draftAE.id,midAE.body.scope,2);
  // C5a-b M5：提交按钮是否可点现在按服务端 progress.complete 为准（含照片），不再是本地字段计数——
  // 刚才的照片是绕开UI直传的API调用，客户端此刻的 f.detail.progress 还是"直传照片之前"的旧快照，
  // 不知道照片已经齐了；返回列表再重新打开同一张草稿，触发一次新的 GET 取得包含这批照片的最新
  // progress（模拟"C5b 的照片上传UI真正落地后，客户端在上传成功回调里也会拿到最新progress"这一步）。
  await pae.locator('#itlFormBack').click();await pae.locator('[data-insp-row="'+draftAE.id+'"]').waitFor();
  await pae.locator('[data-insp-continue="'+draftAE.id+'"]').click();await pae.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pae);
  check('AE-1:字段与照片都齐(服务端progress.complete=true)后提交按钮不再禁用',await pae.locator('#itlFormSubmit[disabled]').count()===0);
  await pae.locator('#itlFormSubmit').click();
  // #itlSheetBack 是详情页专属的id（表单页是#itlFormBack）——用它等待，不能只等".itl-sheet-title h2"，
  // 表单页本身也有同名结构，等visible会被表单页里已经存在的旧h2立即满足，测不出"真的换成详情页"。
  await pae.locator('#itlSheetBack').waitFor();
  check('AE-1:提交成功后进入真实详情页(标题含机房名)',(await pae.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomSubmitOK'));
  // 用直接子代选择器：h2 内部无异常时也会有一个".itl-muted"("无异常"徽标)，与外层真正的meta span
  // 撞选择器（AE-1这张单全部填ok、没有异常项，命中这个歧义；block A用的单带异常徽标所以没撞上）。
  const metaTextAE1=await pae.locator('.itl-sheet-title>.itl-muted').innerText();
  check('AE-1:详情页meta含"已提交"字样',metaTextAE1.includes('已提交'),metaTextAE1);
  check('浏览器无未捕获异常(AE-1)',errorsAE.length===0);
  await cae.close();

  const draftAE2=await buildDraftSheet('SF-RoomSubmitIncomplete',2);
  const cae2=await browser.newContext();await cae2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pae2=await cae2.newPage();const errorsAE2=[];pae2.on('pageerror',e=>errorsAE2.push(e.message));
  await pae2.goto(f.base+'/IT_Ledger.html#inspections');await pae2.locator('[data-insp-row="'+draftAE2.id+'"]').waitFor();
  await pae2.locator('[data-insp-continue="'+draftAE2.id+'"]').click();await pae2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pae2);
  check('AE-2:字段全空时提交按钮disabled',await pae2.locator('#itlFormSubmit[disabled]').count()===1);
  const baseSettledAE2=await pae2.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pae2.locator('[data-sheet-section="room"] input[type=number]').nth(0).fill('22');
  await pae2.locator('[data-sheet-section="room"] input[type=number]').nth(1).fill('45');
  await pae2.locator('[data-sheet-section="room"] [data-all-normal]').click();
  await pae2.locator('[data-sheet-section="rack"] [data-all-normal]').click();
  await pae2.locator('[data-sheet-section="device"] [data-all-normal]').click();
  await pae2.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAE2);
  // C5a-b M5：提交按钮现在按服务端 progress.complete 为准（含照片）——字段填完但照片还没传时按钮必须
  // 仍是disabled（旧版按纯本地字段计数会在这里误判成"可提交"，点了必然撞 400，属于"前端预判与后端
  // 判定不一致"的同一类问题，H4事故同源）。
  check('AE-2:字段填完但缺照片时提交按钮仍disabled(以服务端progress.complete为准,不看本地字段计数)',await pae2.locator('#itlFormSubmit[disabled]').count()===1);
  const scopeAE2=(await getSheet(draftAE2.id,2)).body.scope;
  const photoIdsAE2=[];
  for(const r of scopeAE2.racks){const res=await uploadPhoto(draftAE2.id,'rack_front',r.id,2);assert.equal(res.status,201,'AE2 upload '+JSON.stringify(res.body));photoIdsAE2.push(res.body.photo.id);}
  // 返回列表再重新打开，取得包含这批照片的最新progress——按钮应变为可点。
  await pae2.locator('#itlFormBack').click();await pae2.locator('[data-insp-row="'+draftAE2.id+'"]').waitFor();
  await pae2.locator('[data-insp-continue="'+draftAE2.id+'"]').click();await pae2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pae2);
  check('AE-2:照片补齐重新打开后按钮变为可点(服务端progress.complete=true)',await pae2.locator('#itlFormSubmit[disabled]').count()===0);
  // 竞态场景：另一个操作者（或另一个标签页）在客户端刚取到的这份"complete=true"快照之后，直接用API删掉
  // 一张必传照片（照片操作不带版本号、不冲版本，§5.1）——客户端此刻仍显示按钮可点（本地progress已经
  // 过期但没有任何信号告诉它"该刷新了"），点击提交会真的发出POST /submit，服务端重读到的却是"少了一张
  // 必传照片"，返回400 SHEET_INCOMPLETE——这是唯一能在不绕开"禁用态按钮点不动"这条前端限制的前提下，
  // 用真实点击触达 performSubmit 的 SHEET_INCOMPLETE 分支的路径。
  const delResAE2=await f.api('DELETE','/inspections/sheets/'+draftAE2.id+'/photos/'+photoIdsAE2[0],undefined,2);
  assert.equal(delResAE2.status,200,'AE2 delete photo '+JSON.stringify(delResAE2.body));
  await pae2.locator('#itlFormSubmit').click();
  await pae2.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAE2=await pae2.locator('#itlNotice').innerText();
  check('AE-2:400 SHEET_INCOMPLETE后notice列出缺项(缺照片)',noticeTextAE2.includes('张照片未传'),noticeTextAE2);
  check('AE-2:仍停在填写页(未被强行导航离开)',await pae2.locator('#itlFormActionbar').count()===1);
  // 缺项这次纯粹是"少一张机柜正面照"——highlightIncomplete 只按 unfilled/missing_note/device_issue
  // 三类 item id 高亮，不认 missing_photo_positions（那是 {slot,target_id} 形状，不是 item id，且没有
  // 对应的照片槽DOM可以高亮——C5a没有照片UI，这个缺口留给C5b，不在本批处理范围，如实记录不强行实现）。
  check('浏览器无未捕获异常(AE-2)',errorsAE2.length===0);
  await cae2.close();

  // ============================================================
  // C5a-b（Opus预筛5H/10M/7L）：H1-H5 + 精选M项。
  // ============================================================

  // AG) G5=A′改写（原 H1"离开后迟到回调不再把填写页画进别的页签"场景，现在同时覆盖 G5 的"已销毁会话
  // 冲刷失败"路径）：本地编辑排队冲刷期间版本已被别处改动，切走页签(触发leaveForm，会话同步销毁+排一次
  // 离开冲刷)→挂住这次已经在跑的PUT→等机柜视图渲染→放行409→这次409落在一个已经destroyed的会话上，不再
  // 走handleConflict，走notifyLeaveFlushFailure给一条常驻提示（列出没保存上的内容+原因"与他人修改冲突"，
  // 原 AG-1(H1) 断言的"离开后"固定文案随旧机制一起改写，见"原断言→新断言"清单）；断言仍在机柜视图、
  // 无填写页残留（预筛P1场景的判别力保留）。C5a-e2（必修2）：leaveForm 排的"离开冲刷"这时候会立刻在
  // performFlush 开头撞见 f.destroyed&&f.leaveFailureNotified 短路——不再像旧版那样再真的发一次注定
  // 徒劳的PUT（同一份数据、同一个旧version，必然又是409），直接 return false，只补一次settle计数，
  // 不产生第二次网络请求。用PUT计数断言"全程恰1次PUT"（必修2的用例要求）。
  const draftAG=await buildDraftSheet('SF-RoomLeaveConflict',2);
  const airconAG=draftAG.items.find(it=>it.item_key==='aircon');
  const upsAG=draftAG.items.find(it=>it.item_key==='ups');
  const cag=await browser.newContext();await cag.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pag=await cag.newPage();const errorsAG=[];pag.on('pageerror',e=>errorsAG.push(e.message));
  let putCountAG=0;pag.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAG.id))putCountAG++;});
  await pag.goto(f.base+'/IT_Ledger.html#inspections');await pag.locator('[data-insp-row="'+draftAG.id+'"]').waitFor();
  await installNoticeCounter(pag); // M5(C5a-f)
  await pag.locator('[data-insp-continue="'+draftAG.id+'"]').click();await pag.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pag);
  const heldAG=holdRequestRoute(pag,'**/api/it-assets/inspections/sheets/'+draftAG.id,'PUT');
  await pag.locator('[data-seg-ok="'+airconAG.id+'"]').click(); // 排队冲刷（真实1.5秒防抖，尚未发出）
  await heldAG.entered; // 等真实防抖计时器触发这次PUT——此刻请求还没转发给服务器，服务端仍是旧version
  const otherPutAG=await f.api('PUT','/inspections/sheets/'+draftAG.id,{expected_version:draftAG.version,items:[{id:upsAG.id,result:'bad',number_value:null,note:'别处已修改'}]},2);
  assert.equal(otherPutAG.status,200,'AG other put '+JSON.stringify(otherPutAG.body));
  await pag.evaluate(()=>{location.hash='racks';}); // 触发onLeave：leaveForm同步销毁会话+排一次离开冲刷（挂起的PUT此刻还没放行）
  await pag.locator('.itl-rack-workspace').waitFor();
  const settledBeforeAG=await pag.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldAG.release(); // 放行：这次PUT带的还是旧version，会409——落在已销毁会话上，走notifyLeaveFlushFailure
  await pag.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAG);
  check('AG(G5):放行409后仍停在机柜视图(有机房标志元素)',await pag.locator('.itl-rack-workspace').count()===1);
  check('AG(G5):放行409后没有把填写页画回来(无#itlFormActionbar)',await pag.locator('#itlFormActionbar').count()===0);
  const noticeTextAG=await pag.locator('#itlNotice').innerText();
  check('AG(H2):离开到机柜后常驻条不可达,一次性提示保留完整原文',noticeTextAG.includes('巡检单〈'+sheetLabelStr(draftAG)+'〉有内容未能保存：')&&noticeTextAG.includes('空调运行：正常')&&noticeTextAG.includes('与他人修改冲突')&&!noticeTextAG.includes('详见巡检台账顶部'),noticeTextAG);
  check('AG(必修2准备):此刻恰好只发出过1次PUT(挂起并放行的那次)',putCountAG===1,putCountAG);
  // C5a-e2（必修3，原"拿不准的点"改写为确定性有界等待，不再吞异常）：leaveForm 自己排的"离开冲刷"
  // 紧跟在上面那次settle之后立即执行——按必修2的短路设计，这次不会再发真实PUT，只是同步返回并补一次
  // settle计数，这个等待现在是确定性的（不依赖网络往返），超时即视为断言失败，不再用.catch吞掉。
  await pag.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAG+1,{timeout:5000});
  const noticeTextAGRetry=await pag.locator('#itlNotice').innerText();
  check('AG(G5，M2去重):离开冲刷再次失败(同一会话)不重复提示,内容与第一条完全一致',noticeTextAGRetry===noticeTextAG,{noticeTextAG,noticeTextAGRetry});
  check('AG(必修2):leaveForm自己排的离开冲刷短路,全程恰好只有1次PUT(没有再发第二次注定徒劳的请求)',putCountAG===1,putCountAG);
  check('AG(M5，C5a-f新增):离开失败类提示全程恰好调用1次(不是"最后一条内容相同"而是真的只发过1次)',await leaveOrConflictNoticeCount(pag)===1,await pag.evaluate(()=>window.__noticeCalls));
  // 切回巡检页签才能看到#itlUnsavedList这个容器（此刻还在机柜视图里）——核实完整原文只在常驻条里。
  await pag.evaluate(()=>{location.hash='inspections';});await pag.locator('[data-insp-row]').first().waitFor();
  const unsavedListAG=await pag.locator('#itlUnsavedList [data-unsaved-sheet="'+draftAG.id+'"]').innerText();
  check('AG(N-L6新增):完整原文(原因"与他人修改冲突"+"空调运行：正常")只在常驻条里',unsavedListAG.includes('与他人修改冲突')&&unsavedListAG.includes('空调运行：正常'),unsavedListAG);
  check('AG(L5):冲突原因在常驻条里只出现一次',unsavedListAG.split('与他人修改冲突').length-1===1,unsavedListAG);
  check('浏览器无未捕获异常(AG)',errorsAG.length===0);
  await cag.close();

  // AG-2(H1)：采集慢返回——挂起采集POST期间切走页签，放行(失败)后不覆盖已切走的机柜视图。
  const draftAG2=await buildDraftSheet('SF-RoomLeaveCollect',2);
  const deviceItemAG2=draftAG2.items.find(it=>it.section==='device');
  const cag2=await browser.newContext();await cag2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pag2=await cag2.newPage();const errorsAG2=[];pag2.on('pageerror',e=>errorsAG2.push(e.message));
  await pag2.goto(f.base+'/IT_Ledger.html#inspections');await pag2.locator('[data-insp-row="'+draftAG2.id+'"]').waitFor();
  await pag2.locator('[data-insp-continue="'+draftAG2.id+'"]').click();await pag2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pag2);
  let enteredCollectAG2,releaseCollectAG2;const enteredCollectAG2P=new Promise(r=>enteredCollectAG2=r);
  await pag2.route('**/api/it-assets/inspections/sheets/'+draftAG2.id+'/items/'+deviceItemAG2.id+'/collect',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    enteredCollectAG2();await new Promise(r=>releaseCollectAG2=r);await route.abort('failed');
  });
  await pag2.locator('[data-collect-id="'+deviceItemAG2.id+'"]').click();
  await enteredCollectAG2P;
  await pag2.evaluate(()=>{location.hash='racks';});
  await pag2.locator('.itl-rack-workspace').waitFor();
  releaseCollectAG2();
  await pag2.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAG2=await pag2.locator('#itlNotice').innerText();
  check('AG-2(H1，C5a-f改写：原断言检查"有修改未保存"前缀→新断言检查机房标签+"采集失败"且不再有该前缀):notice是常驻提示，含机房标签与"采集失败"，不再有"有修改未保存"前缀(H1统一走notifyOutcome)',noticeTextAG2.includes(sheetLabelStr(draftAG2))&&noticeTextAG2.includes('采集失败')&&!noticeTextAG2.includes('有修改未保存'),noticeTextAG2);
  check('AG-2(H1):仍停在机柜视图，没有被覆盖',await pag2.locator('.itl-rack-workspace').count()===1);
  check('AG-2(H1):没有把填写页画回来(无#itlFormActionbar)',await pag2.locator('#itlFormActionbar').count()===0);
  check('浏览器无未捕获异常(AG-2)',errorsAG2.length===0);
  await cag2.close();

  // AH) H2：冲刷失败后提交不再照发——performSubmit 开头核上一轮冲刷是否真的成功。AH-1网络异常；
  // AH-2 LEDGER_BUSY。两种失败下都要证明：请求序列不出现真正的POST /submit、服务端仍是draft、页面
  // 仍在填写页、本地未保存的修改仍在。
  const draftAH1=await buildDraftSheet('SF-RoomSubmitBlockNet',2);
  const filledAH1=fillPayloadAllOk(draftAH1.items);
  const putAH1=await f.api('PUT','/inspections/sheets/'+draftAH1.id,{expected_version:draftAH1.version,items:filledAH1},2);
  assert.equal(putAH1.status,200,'AH1 put '+JSON.stringify(putAH1.body));
  await uploadAllRackFrontPhotos(draftAH1.id,draftAH1.scope,2);
  const cah1=await browser.newContext();await cah1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pah1=await cah1.newPage();const errorsAH1=[];pah1.on('pageerror',e=>errorsAH1.push(e.message));
  let submitCountAH1=0;pah1.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/inspections/sheets/'+draftAH1.id+'/submit'))submitCountAH1++;});
  await pah1.goto(f.base+'/IT_Ledger.html#inspections');await pah1.locator('[data-insp-row="'+draftAH1.id+'"]').waitFor();
  await pah1.locator('[data-insp-continue="'+draftAH1.id+'"]').click();await pah1.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pah1);
  check('AH-1准备:提交按钮此刻可点(打开时服务端progress.complete=true)',await pah1.locator('#itlFormSubmit[disabled]').count()===0);
  await pah1.locator('#itlFormRemark').fill('AH1测试备注'); // 制造新的脏数据（不碰完整性，只测"冲刷失败拦提交"）
  await pah1.route('**/api/it-assets/inspections/sheets/'+draftAH1.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await pah1.locator('#itlFormSubmit').click(); // doSubmit入队：冲刷(会失败)→提交(应该被拦，不会真的发出去)
  await pah1.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAH1=await pah1.locator('#itlNotice').innerText();
  check('AH-1(H2):网络异常导致冲刷失败后，提交被拦截，notice提示"有未保存的修改，已取消提交"',noticeTextAH1==='有未保存的修改，已取消提交',noticeTextAH1);
  check('AH-1(H2):序列中未出现真正的POST /submit',submitCountAH1===0,submitCountAH1);
  const serverAH1=await getSheet(draftAH1.id,2);
  check('AH-1(H2):服务端该单仍是draft状态',serverAH1.body.status==='draft',serverAH1.body.status);
  check('AH-1(H2):页面仍停在填写页(未被导航离开)',await pah1.locator('#itlFormActionbar').count()===1);
  check('AH-1(H2):本地未保存的备注修改仍在输入框里',(await pah1.locator('#itlFormRemark').inputValue())==='AH1测试备注');
  check('AH-1(H2):提交按钮不再卡在"提交中…"，且因仍有未保存修改而正确显示disabled',(await pah1.locator('#itlFormSubmit').innerText())==='提交巡检'&&await pah1.locator('#itlFormSubmit[disabled]').count()===1);
  check('浏览器无未捕获异常(AH-1)',errorsAH1.length===0);
  await cah1.close();

  const draftAH2=await buildDraftSheet('SF-RoomSubmitBlockBusy',2);
  const filledAH2=fillPayloadAllOk(draftAH2.items);
  const putAH2=await f.api('PUT','/inspections/sheets/'+draftAH2.id,{expected_version:draftAH2.version,items:filledAH2},2);
  assert.equal(putAH2.status,200,'AH2 put '+JSON.stringify(putAH2.body));
  await uploadAllRackFrontPhotos(draftAH2.id,draftAH2.scope,2);
  const cah2=await browser.newContext();await cah2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pah2=await cah2.newPage();const errorsAH2=[];pah2.on('pageerror',e=>errorsAH2.push(e.message));
  let submitCountAH2=0;pah2.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/inspections/sheets/'+draftAH2.id+'/submit'))submitCountAH2++;});
  await pah2.goto(f.base+'/IT_Ledger.html#inspections');await pah2.locator('[data-insp-row="'+draftAH2.id+'"]').waitFor();
  await pah2.locator('[data-insp-continue="'+draftAH2.id+'"]').click();await pah2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pah2);
  await pah2.locator('#itlFormRemark').fill('AH2测试备注');
  await pah2.route('**/api/it-assets/inspections/sheets/'+draftAH2.id,route=>route.request().method()==='PUT'?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({code:'LEDGER_BUSY',message:'台账正忙，请稍后手动重试。'})}):route.fallback());
  await pah2.locator('#itlFormSubmit').click();
  await pah2.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAH2=await pah2.locator('#itlNotice').innerText();
  check('AH-2(H2):LEDGER_BUSY导致冲刷失败后，提交被拦截，notice提示"有未保存的修改，已取消提交"',noticeTextAH2==='有未保存的修改，已取消提交',noticeTextAH2);
  check('AH-2(H2):序列中未出现真正的POST /submit',submitCountAH2===0,submitCountAH2);
  const serverAH2=await getSheet(draftAH2.id,2);
  check('AH-2(H2):服务端该单仍是draft状态',serverAH2.body.status==='draft',serverAH2.body.status);
  check('AH-2(H2):本地未保存的备注修改仍在输入框里',(await pah2.locator('#itlFormRemark').inputValue())==='AH2测试备注');
  check('浏览器无未捕获异常(AH-2)',errorsAH2.length===0);
  await cah2.close();

  // AI) C5a-d重写：43S H3原有的"冲刷挂起期间飞行中编辑item B"分支在在途锁下不可达（B的编辑会被
  // isLocked(f)挡住，Y块已覆盖这条路径），删除该分支，改为S-H5（43S H5，方案必做3）：冲突处理后若某
  // 项本地值恰好与服务器fresh值一致（两个操作者写了同一个值，只是版本号不同）——reconcileConflictMarkers
  // 应该立即清掉这个冲突标记，不让"数据其实已经一致"的项继续卡住提交按钮/继续显示高亮。不自动重发
  // （假时钟推过2秒以上，PUT计数不增加）这一断言保留，仍是有价值的独立结论。
  const draftAI=await buildDraftSheet('SF-RoomReconcile',2);
  const airconAI=draftAI.items.find(it=>it.item_key==='aircon');
  const cai=await browser.newContext();await cai.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pai=await cai.newPage();const errorsAI=[];pai.on('pageerror',e=>errorsAI.push(e.message));
  let putCountAI=0;pai.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAI.id))putCountAI++;});
  await pai.goto(f.base+'/IT_Ledger.html#inspections');await pai.locator('[data-insp-row="'+draftAI.id+'"]').waitFor();
  await pai.locator('[data-insp-continue="'+draftAI.id+'"]').click();await pai.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pai);
  // 假时钟从这里就装上（覆盖后面所有 setTimeout），避免"装表前用真实计时器排的旧计时器不受假时钟控制"
  // 这个坑——所有排在假时钟装好之后的 scheduleAutosave 调用都受 fastForward 控制。
  await pai.clock.install();await pai.clock.pauseAt(new Date());
  const heldAI=holdRequestRoute(pai,'**/api/it-assets/inspections/sheets/'+draftAI.id,'PUT');
  await pai.locator('[data-seg-ok="'+airconAI.id+'"]').click(); // 本地标ok
  await pai.clock.fastForward(2000); // 推过防抖，这次PUT触发——此刻请求还没转发给服务器
  await heldAI.entered;
  // 另一个操作者恰好写了同一个值(ok)，只是这一改动会把版本号推高——制造"数据其实一致但版本冲突"。
  const otherPutAI=await f.api('PUT','/inspections/sheets/'+draftAI.id,{expected_version:draftAI.version,items:[{id:airconAI.id,result:'ok',number_value:null,note:null}]},2);
  assert.equal(otherPutAI.status,200,'AI other put '+JSON.stringify(otherPutAI.body));
  const settledBeforeAI=await pai.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldAI.release(); // 放行：这次PUT带的是旧version，会409
  await pai.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAI);
  check('AI(S-H5):冲突后本地值(ok)与服务器fresh值一致,不显示冲突高亮(reconcileConflictMarkers立即清除)',await pai.locator('[data-item-id="'+airconAI.id+'"].itl-sheet-conflict').count()===0);
  check('AI(S-H5):该项仍正确显示为"正常"(ok),没有因为走了合并流程而被清空/回滚',await pai.locator('[data-seg-ok="'+airconAI.id+'"].on-ok').count()===1);
  const blockersTextAI=await pai.locator('#itlFormBlockers').innerText();
  check('AI(S-H5):操作条不再显示"有修改未保存"(hasUnsavedWork已因冲突标记清除变为false)',!blockersTextAI.includes('有修改未保存'),blockersTextAI);
  const putCountAIBase=putCountAI;
  await pai.clock.fastForward(2500);
  const sentinelAI=async()=>{const seen=pai.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pai.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await sentinelAI();
  check('AI(H3残留断言):409后不自动重发(推过2秒以上,PUT计数未增加)',putCountAI===putCountAIBase,putCountAI);
  check('浏览器无未捕获异常(AI)',errorsAI.length===0);
  await cai.close();

  // AK) T-M1（43T M1）重写：旧版只挂起采集POST本身，没有先制造脏数据+挂起PUT，只能证明"采集请求
  // 飞行期间的去重"，证不了"冲刷在途时能不能触发采集"。改为：先改一项并挂起其PUT，在途锁下连点两次
  // "一键采集"→在途锁挡在doCollect开头，采集POST恰好0次；放行PUT落定解锁后，再点一次采集→这次真的
  // 排上，恰好1次。用假的可采集设备+挂起的PUT路由构造。
  const overridesAK={};
  const HOST_AK='203.0.113.11';
  const collectorAK={host:()=>HOST_AK,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_AK,server:{name:'srv',manufacturer:'x',model:'y',serial_number:overridesAK.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:now,completed_at:now};}};
  const fAK=await createFixture({inspectionCollector:collectorAK});
  let cak, pak;
  try {
    const rackAK=(await fAK.api('POST','/racks',{name:'SF-RoomCollectDup-柜1',room:'SF-RoomCollectDup',u_total:20})).body;
    overridesAK.sn='SN-COLLECT-AK-01';
    await fAK.api('POST','',{category:'server',name:'SF-RoomCollectDup-设备1',sn:overridesAK.sn,attrs:{ip:HOST_AK},u_height:1,placement:{kind:'rack',rack_id:rackAK.id,u_start:1}});
    const createdAK=await fAK.api('POST','/inspections/sheets',{room_name:'SF-RoomCollectDup'},2);
    assert.equal(createdAK.status,201,'AK create '+JSON.stringify(createdAK.body));
    const deviceItemAK=createdAK.body.items.find(it=>it.section==='device');
    const airconAK=createdAK.body.items.find(it=>it.item_key==='aircon');
    const errorsAK=[];
    cak=await browser.newContext();await cak.addInitScript(()=>localStorage.setItem('token','fixture-2'));pak=await cak.newPage();pak.on('pageerror',e=>errorsAK.push(e.message));
    let collectCountAK=0;pak.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/items/'+deviceItemAK.id+'/collect'))collectCountAK++;});
    await pak.goto(fAK.base+'/IT_Ledger.html#inspections');await pak.locator('[data-insp-row="'+createdAK.body.id+'"]').waitFor();
    await pak.locator('[data-insp-continue="'+createdAK.body.id+'"]').click();await pak.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pak);
    await pak.clock.install();await pak.clock.pauseAt(new Date());
    const heldAK=holdRequestRoute(pak,'**/api/it-assets/inspections/sheets/'+createdAK.body.id,'PUT');
    await pak.locator('[data-seg-ok="'+airconAK.id+'"]').click(); // 制造脏数据（LOW修正：此处已装假时钟并pauseAt，是fastForward驱动的防抖，不是真实1.5秒等待）
    await pak.clock.fastForward(2000);
    await heldAK.entered; // PUT已发出、被挂住——此刻在途锁生效
    check('AK(T-M1):冲刷在途时采集按钮已disabled',await pak.locator('[data-collect-id="'+deviceItemAK.id+'"][disabled]').count()===1);
    // 先摘掉disabled再点两次——绕开"disabled元素不派发click"这个UI层面的天然屏障，测doCollect函数体
    // 自身的isLocked(f)判据。
    await pak.evaluate(id=>{const btn=document.querySelector('[data-collect-id="'+id+'"]');btn.disabled=false;btn.click();btn.disabled=false;btn.click();},deviceItemAK.id);
    check('AK(T-M1):冲刷在途时连点两次采集,isLocked(f)挡在doCollect开头,采集POST恰好0次',collectCountAK===0,collectCountAK);
    const settledBeforeReleaseAK=await pak.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    heldAK.release();
    await pak.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeReleaseAK);
    check('AK(T-M1):落定解锁后采集按钮恢复可点',await pak.locator('[data-collect-id="'+deviceItemAK.id+'"][disabled]').count()===0);
    await pak.locator('[data-collect-id="'+deviceItemAK.id+'"]').click();
    await pak.locator('#itlToast:not([hidden])').waitFor();
    check('AK(T-M1):落定后点一次采集,真的排上了,采集POST恰好1次',collectCountAK===1,collectCountAK);
    check('浏览器无未捕获异常(AK)',errorsAK.length===0);
  } finally {
    if (cak) await cak.close();
    await fAK.close();
  }

  // AJ) H4：巡检人写权限被降级为只读后，点行/继续填写不再进入可写表单——full可见度(仍是owner)但
  // actions为空数组，路由到只读详情，全程零PUT/POST，且不触发api()共享层403兜底的"尚未获准访问"
  // （H4已经消除了C5a侧唯一会主动发起写请求撞403的入口——降级用户现在根本走不到能发写请求的那条路径，
  // 见spec-C5a-b.md LOW条目：api()把所有403当权限丢失是共享层既有行为，本批不改）。
  const draftAJ=await buildDraftSheet('SF-RoomACLDowngrade',2);
  await f.run("UPDATE it_asset_acl SET level='read' WHERE user_id=2");
  const caj=await browser.newContext();await caj.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paj=await caj.newPage();const errorsAJ=[];paj.on('pageerror',e=>errorsAJ.push(e.message));
  let writeCountAJ=0;paj.on('request',r=>{if((r.method()==='PUT'||r.method()==='POST'||r.method()==='DELETE')&&r.url().includes('/inspections/sheets/'+draftAJ.id))writeCountAJ++;});
  try{
    await paj.goto(f.base+'/IT_Ledger.html#inspections');await paj.locator('[data-insp-row="'+draftAJ.id+'"]').waitFor();
    check('AJ(H4):降级后列表行的操作列显示"查看"而不是"继续填写"',await paj.locator('[data-insp-continue="'+draftAJ.id+'"]').count()===0&&await paj.locator('[data-insp-view="'+draftAJ.id+'"]').count()===1);
    await paj.locator('[data-insp-row="'+draftAJ.id+'"]').click();
    await paj.locator('.itl-sheet-title h2').waitFor();
    check('AJ(H4):点行进入只读详情(不是可写表单,无#itlFormActionbar)',await paj.locator('#itlFormActionbar').count()===0);
    const stateLineAJ=await paj.locator('.itl-sheet-title>.itl-muted').innerText();
    check('AJ(H4):详情页正确显示"填写中 · 只读"(不是错误的"已提交")',stateLineAJ.includes('填写中')&&stateLineAJ.includes('只读')&&!stateLineAJ.includes('已提交'),stateLineAJ);
    check('AJ(H4):全程零PUT/POST/DELETE写请求(未曾尝试发起写请求撞403)',writeCountAJ===0,writeCountAJ);
    check('AJ(H4):没有触发api()全局403兜底("尚未获准访问"字样未出现)',!(await paj.locator('body').innerText()).includes('尚未获准访问'));
    check('AJ(H4):台账其余功能未被锁死(页签仍可见,不是403清空后的状态)',await paj.locator('#itlTabs button').count()>0);
    check('浏览器无未捕获异常(AJ)',errorsAJ.length===0);
  } finally {
    await caj.close();
    await f.run("UPDATE it_asset_acl SET level='write' WHERE user_id=2"); // 还原：后续用例都依赖fixture-2有写权限
  }

  // AF) 删除草稿：AF-1从列表行删除；AF-2从填写页自己的"删除草稿"按钮删除。
  const draftAF1=await buildDraftSheet('SF-RoomDeleteA',2);
  const caf1=await browser.newContext();await caf1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paf1=await caf1.newPage();const errorsAF1=[];paf1.on('pageerror',e=>errorsAF1.push(e.message));
  await paf1.goto(f.base+'/IT_Ledger.html#inspections');await paf1.locator('[data-insp-row="'+draftAF1.id+'"]').waitFor();
  await paf1.locator('[data-insp-delete-draft="'+draftAF1.id+'"]').click();
  await paf1.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await paf1.locator('#itlSubmit').click();
  await paf1.locator('#itlToast:not([hidden])').waitFor();
  check('AF-1:列表行删除草稿后toast提示"草稿已删除"',(await paf1.locator('#itlToast').innerText()).includes('草稿已删除'));
  check('AF-1:该行已从列表消失',await paf1.locator('[data-insp-row="'+draftAF1.id+'"]').count()===0);
  const afterDeleteAF1=await getSheet(draftAF1.id,2);
  check('AF-1:服务端确认该单已被物理删除(404)',afterDeleteAF1.status===404,afterDeleteAF1);
  check('浏览器无未捕获异常(AF-1)',errorsAF1.length===0);
  await caf1.close();

  const draftAF2=await buildDraftSheet('SF-RoomDeleteB',2);
  const caf2=await browser.newContext();await caf2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paf2=await caf2.newPage();const errorsAF2=[];paf2.on('pageerror',e=>errorsAF2.push(e.message));
  await paf2.goto(f.base+'/IT_Ledger.html#inspections');await paf2.locator('[data-insp-row="'+draftAF2.id+'"]').waitFor();
  await paf2.locator('[data-insp-continue="'+draftAF2.id+'"]').click();await paf2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paf2);
  await paf2.locator('#itlFormDelete').click();
  await paf2.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await paf2.locator('#itlSubmit').click();
  await paf2.locator('[data-insp-row]').first().waitFor();
  check('AF-2:从填写页删除草稿后返回列表(不再是填写页)',await paf2.locator('#itlFormActionbar').count()===0);
  const afterDeleteAF2=await getSheet(draftAF2.id,2);
  check('AF-2:服务端确认该单已被物理删除(404)',afterDeleteAF2.status===404,afterDeleteAF2);
  check('浏览器无未捕获异常(AF-2)',errorsAF2.length===0);
  await caf2.close();

  // AF-3（T-M2，43T M2）：挂起同单PUT后从填写页删除——DELETE请求必须排在PUT落定之后才发出（顺序断言，
  // 不是并发发出）。确认队列的enqueue是同步推入、真正执行要等前一个任务的await完成这条FIFO保证：
  // 点"删除"确认那一刻，confirmDeleteDraftRow内部会先await自己enqueue的冲刷任务——由于队列里已经有
  // 一个在跑(挂起)的flush，这次新enqueue的任务连"开始执行"都进不去(runQueue发现queueRunning为真直接
  // return)，所以DELETE请求在结构上不可能先于PUT落定发出，这里断言的是"确实如此"，不依赖真实计时。
  const draftAF3=await buildDraftSheet('SF-RoomDeleteOrder',2);
  const airconAF3=draftAF3.items.find(it=>it.item_key==='aircon');
  const caf3=await browser.newContext();await caf3.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paf3=await caf3.newPage();const errorsAF3=[];paf3.on('pageerror',e=>errorsAF3.push(e.message));
  const eventsAF3=[];
  paf3.on('request',r=>{ if(!r.url().endsWith('/inspections/sheets/'+draftAF3.id))return; if(r.method()==='PUT')eventsAF3.push('PUT-sent'); if(r.method()==='DELETE')eventsAF3.push('DELETE-sent'); });
  paf3.on('response',r=>{ if(r.url().endsWith('/inspections/sheets/'+draftAF3.id)&&r.request().method()==='PUT')eventsAF3.push('PUT-resolved'); });
  await paf3.goto(f.base+'/IT_Ledger.html#inspections');await paf3.locator('[data-insp-row="'+draftAF3.id+'"]').waitFor();
  await paf3.locator('[data-insp-continue="'+draftAF3.id+'"]').click();await paf3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paf3);
  const heldAF3=holdRequestRoute(paf3,'**/api/it-assets/inspections/sheets/'+draftAF3.id,'PUT');
  await paf3.locator('[data-seg-ok="'+airconAF3.id+'"]').click();
  await heldAF3.entered; // PUT已发出、被挂住——此刻在途锁生效，队列里正跑着这个flush任务
  check('AF-3准备:在途锁下删除按钮已disabled(方案必做1"…删除按钮同步disabled")',await paf3.locator('#itlFormDelete[disabled]').count()===1);
  // 先摘掉disabled再点——绕开UI层"点不动"，验证confirmDeleteDraftRow内部"排进同一条队列，天然等在途
  // 任务落定"这条逻辑本身（同AK/Y块的手法）。
  await paf3.evaluate(()=>{document.querySelector('#itlFormDelete').disabled=false;});
  await paf3.locator('#itlFormDelete').click();
  await paf3.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await paf3.locator('#itlSubmit').click();
  check('AF-3(T-M2):PUT仍挂起时确认删除,DELETE请求尚未发出(排在冲刷后面执行,不是并发)',!eventsAF3.includes('DELETE-sent'),eventsAF3);
  heldAF3.release();
  await paf3.locator('[data-insp-row]').first().waitFor({timeout:10000});
  check('AF-3(T-M2):PUT落定之后才发出DELETE(顺序正确)',eventsAF3.includes('DELETE-sent')&&eventsAF3.indexOf('PUT-resolved')<eventsAF3.indexOf('DELETE-sent'),eventsAF3);
  const afterDeleteAF3=await getSheet(draftAF3.id,2);
  check('AF-3(T-M2):服务端确认该单已被物理删除(404)',afterDeleteAF3.status===404,afterDeleteAF3);
  check('浏览器无未捕获异常(AF-3)',errorsAF3.length===0);
  await caf3.close();

  // AF-4（T-M2，43T M2）：冲刷失败后删除——中止删除、草稿保留（不把还没落盘的修改连同整张单一起扔掉）。
  const draftAF4=await buildDraftSheet('SF-RoomDeleteAbort',2);
  const airconAF4=draftAF4.items.find(it=>it.item_key==='aircon');
  const caf4=await browser.newContext();await caf4.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paf4=await caf4.newPage();const errorsAF4=[];paf4.on('pageerror',e=>errorsAF4.push(e.message));
  let deleteCountAF4=0;paf4.on('request',r=>{if(r.method()==='DELETE'&&r.url().endsWith('/inspections/sheets/'+draftAF4.id))deleteCountAF4++;});
  await paf4.goto(f.base+'/IT_Ledger.html#inspections');await paf4.locator('[data-insp-row="'+draftAF4.id+'"]').waitFor();
  await paf4.locator('[data-insp-continue="'+draftAF4.id+'"]').click();await paf4.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paf4);
  await paf4.locator('[data-seg-ok="'+airconAF4.id+'"]').click(); // 制造脏数据
  await paf4.route('**/api/it-assets/inspections/sheets/'+draftAF4.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await paf4.locator('#itlFormDelete').click();
  await paf4.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await paf4.locator('#itlSubmit').click();
  await paf4.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAF4=await paf4.locator('#itlNotice').innerText();
  check('AF-4(T-M2):冲刷失败后删除被中止,notice提示"有未保存的修改，已取消删除"',noticeTextAF4==='有未保存的修改，已取消删除',noticeTextAF4);
  check('AF-4(T-M2):没有真正发出DELETE请求',deleteCountAF4===0,deleteCountAF4);
  check('AF-4(T-M2):仍停在填写页(表单会话未被销毁)',await paf4.locator('#itlFormActionbar').count()===1);
  const afterAbortAF4=await getSheet(draftAF4.id,2);
  check('AF-4(T-M2):服务端确认草稿仍存在(未被删除)',afterAbortAF4.status===200&&afterAbortAF4.body.status==='draft',afterAbortAF4.body);
  check('AF-4(T-M2):本地未保存的修改(aircon=ok)仍保留',await paf4.locator('[data-seg-ok="'+airconAF4.id+'"].on-ok').count()===1);
  // M4（Opus预筛，新增断言）：冲刷失败→中止删除这条路径本就有 activeForm.deleting=false + 重渲染
  // （confirmDeleteDraftRow 的 !flushOk 早退分支），但此前没有断言真正验证过"解锁"这件事——去掉那行
  // deleting=false 套件仍会全绿。补开关/删除按钮恢复可用 + 操作条不再显示"正在删除…"。
  check('AF-4(M4新增):冲刷失败取消删除后,检查项开关恢复可用(不再disabled)',await paf4.locator('[data-seg-ok="'+airconAF4.id+'"][disabled]').count()===0);
  check('AF-4(M4新增):冲刷失败取消删除后,删除按钮恢复可用(不再disabled)',await paf4.locator('#itlFormDelete[disabled]').count()===0);
  check('AF-4(M4新增):操作条不再显示"正在删除…"',!(await paf4.locator('#itlFormSavedAt').innerText()).includes('正在删除'));
  check('浏览器无未捕获异常(AF-4)',errorsAF4.length===0);
  await caf4.close();

  // AF-5) H4（Opus预筛必修，新增用例）：DELETE请求本身失败(abort)——confirmDeleteDraftRow的DELETE步骤
  // 用try/finally包住enqueue，异常照常冒泡给模态框框架(formError)，但activeForm.deleting必须在finally
  // 里被清掉并重渲染一次，不能像旧版那样只在成功路径清（否则开关/删除按钮/操作条会恒锁死）。
  const draftAF5=await buildDraftSheet('SF-RoomDeleteFail',2);
  const airconAF5=draftAF5.items.find(it=>it.item_key==='aircon');
  const caf5=await browser.newContext();await caf5.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paf5=await caf5.newPage();const errorsAF5=[];paf5.on('pageerror',e=>errorsAF5.push(e.message));
  await paf5.goto(f.base+'/IT_Ledger.html#inspections');await paf5.locator('[data-insp-row="'+draftAF5.id+'"]').waitFor();
  await paf5.locator('[data-insp-continue="'+draftAF5.id+'"]').click();await paf5.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paf5);
  await paf5.route('**/api/it-assets/inspections/sheets/'+draftAF5.id,route=>route.request().method()==='DELETE'?route.abort('failed'):route.fallback());
  await paf5.locator('#itlFormDelete').click();
  await paf5.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await paf5.locator('#itlSubmit').click();
  await paf5.waitForFunction(()=>(document.querySelector('#itlFormError')?.textContent||'').length>0); // formError已落地,异常确实冒泡给了框架
  await paf5.locator('#itlModalClose').click();
  check('AF-5(H4):DELETE失败后仍停在填写页(表单会话未被误销毁)',await paf5.locator('#itlFormActionbar').count()===1);
  check('AF-5(H4):删除按钮解锁(不再disabled,不是恒锁死)',await paf5.locator('#itlFormDelete[disabled]').count()===0);
  check('AF-5(H4):检查项开关按钮解锁(不再disabled)',await paf5.locator('[data-seg-ok="'+airconAF5.id+'"][disabled]').count()===0);
  check('AF-5(H4):操作条不再显示"正在删除…"',!(await paf5.locator('#itlFormSavedAt').innerText()).includes('正在删除'));
  const afterAF5=await getSheet(draftAF5.id,2);
  check('AF-5(H4):服务端确认草稿仍存在(200,未被删除)',afterAF5.status===200&&afterAF5.body.status==='draft',afterAF5.body);
  check('浏览器无未捕获异常(AF-5)',errorsAF5.length===0);
  await caf5.close();

  // ============================================================
  // C5a-c（spec-C5a-c.md）：M4 + 方案§3.1两条LOW + 矩阵三缺口 + onLeave try/catch。
  // ============================================================

  // AL) M4（方案§3.1最后一条）：设备采集partial时判"正常"须写说明——服务端deviceJudgementError权威判定
  // （inspection-collect.js:90-97）经sheetProgress计入progress.missing.deviceIssueItemIds
  // （inspection-sheets.js:265-273），前端不重新实现规则本身（缺alertsCount/cleanupWarningsCount），只认
  // 这个数组：采集刚完成、result尚未判时没有说明框；判"正常"后autosave落地(performFlush新增的device段
  // 单独重渲染)才出现说明框，文案"采集有告警，判正常需写说明"；填了说明后能正常保存，服务端确认规则
  // 已满足(不再计入deviceIssueItemIds)。
  const overridesAL={};
  const HOST_AL='203.0.113.13';
  const collectorAL={host:()=>HOST_AL,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_AL,server:{name:'srv',manufacturer:'x',model:'y',serial_number:overridesAL.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'partial',started_at:now,completed_at:now};}};
  const fAL=await createFixture({inspectionCollector:collectorAL});
  // 06:55 主会话事故复盘后加固：这个块自己起了独立fixture(fAL,占一个真实监听端口)——一旦块内任何
  // assert失败/异常抛出，fAL.close()没轮到执行就会被跳过，留下一个仍在监听的HTTP server，Node事件
  // 循环不会自然清空，外层如果用execSync等无超时的方式跑本文件会永久挂住（06:55 M-AL变异测试原样撞过
  // 一次：主会话按PID精确kill两个进程+从已知的编辑历史逐字节恢复文件校验，见交付报告"事故与整改"）。
  // try/finally确保fAL(与浏览器context calAL)在任何路径下都会被关掉。
  let calAL;
  try {
    const rackAL=(await fAL.api('POST','/racks',{name:'SF-RoomM4-柜1',room:'SF-RoomM4',u_total:20})).body;
    overridesAL.sn='SN-COLLECT-AL-01';
    await fAL.api('POST','',{category:'server',name:'SF-RoomM4-设备1',sn:overridesAL.sn,attrs:{ip:HOST_AL},u_height:1,placement:{kind:'rack',rack_id:rackAL.id,u_start:1}});
    const createdAL=await fAL.api('POST','/inspections/sheets',{room_name:'SF-RoomM4'},2);
    assert.equal(createdAL.status,201,'AL create '+JSON.stringify(createdAL.body));
    const deviceItemAL=createdAL.body.items.find(it=>it.section==='device');
    calAL=await browser.newContext();await calAL.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pal=await calAL.newPage();const errorsAL=[];pal.on('pageerror',e=>errorsAL.push(e.message));
    await pal.goto(fAL.base+'/IT_Ledger.html#inspections');await pal.locator('[data-insp-row="'+createdAL.body.id+'"]').waitFor();
    await pal.locator('[data-insp-continue="'+createdAL.body.id+'"]').click();await pal.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pal);
    check('AL准备:采集前设备项没有说明框(未关联采集记录,result也还没判)',await pal.locator('[data-note-id="'+deviceItemAL.id+'"]').count()===0);
    await pal.locator('[data-collect-id="'+deviceItemAL.id+'"]').click();
    await pal.locator('#itlToast:not([hidden])').waitFor();
    check('AL准备:采集完成(collection_status=partial)后仍没有说明框(还没判"正常")',await pal.locator('[data-note-id="'+deviceItemAL.id+'"]').count()===0);
    const baseSettledAL=await pal.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pal.locator('[data-seg-ok="'+deviceItemAL.id+'"]').click();
    await pal.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAL);
    await pal.locator('[data-note-id="'+deviceItemAL.id+'"]').waitFor();
    const notesTextAL=await pal.locator('[data-device-item="'+deviceItemAL.id+'"] > .itl-sheet-note').innerText();
    check('AL-1(M4):判"正常"后autosave落地,说明框自动出现(device段被单独重渲染,不用等其它交互),文案"采集有告警，判正常需写说明"',notesTextAL.includes('采集有告警，判正常需写说明'),notesTextAL);
    const baseSettledAL2=await pal.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pal.locator('[data-note-id="'+deviceItemAL.id+'"]').fill('已核实为软件误报,设备本身运行正常');
    await pal.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAL2);
    const afterNoteAL=await fAL.api('GET','/inspections/sheets/'+createdAL.body.id,undefined,2);
    check('AL-1(M4):填说明后PUT成功(200)',afterNoteAL.status===200,afterNoteAL.body);
    check('AL-1(M4):服务端device_issue_item_ids已不再含这一项(deviceJudgementError认note非空,规则已满足)',!afterNoteAL.body.progress.missing.deviceIssueItemIds.includes(deviceItemAL.id),afterNoteAL.body.progress);
    check('浏览器无未捕获异常(AL)',errorsAL.length===0);
  } finally {
    if (calAL) await calAL.close();
    await fAL.close();
  }

  // AM) M4（切回清空隐藏旧说明）：任意与设备判断规则无关的check项（这里用room段"fire"）标bad+说明→
  // 切回ok→说明框消失(toggleSeg同步渲染,不等冲刷)、working.note被清空、随下一次PUT发出的note为null
  // ——不是"恰好满足"以后可能出现的规则的历史遗留文字(同H3陷阱,见memory
  // feedback_validate_persisted_state_not_intent)。
  const draftAM=await buildDraftSheet('SF-RoomClearNote',2);
  const fireAM=draftAM.items.find(it=>it.item_key==='fire');
  const cam=await browser.newContext();await cam.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pam=await cam.newPage();const errorsAM=[];pam.on('pageerror',e=>errorsAM.push(e.message));
  const putBodiesAM=[];pam.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAM.id)){try{putBodiesAM.push(r.postDataJSON());}catch(_e){putBodiesAM.push(null);}}});
  await pam.goto(f.base+'/IT_Ledger.html#inspections');await pam.locator('[data-insp-row="'+draftAM.id+'"]').waitFor();
  await pam.locator('[data-insp-continue="'+draftAM.id+'"]').click();await pam.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pam);
  await pam.locator('[data-seg-bad="'+fireAM.id+'"]').click();
  await pam.locator('[data-note-id="'+fireAM.id+'"]').fill('测试:消防异常待处理');
  const settledBeforeAM=await pam.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pam.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAM);
  check('AM准备:bad+说明后PUT请求体带该note',putBodiesAM[putBodiesAM.length-1].items.find(it=>it.id===fireAM.id).note==='测试:消防异常待处理',putBodiesAM);
  const settledBeforeAM2=await pam.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pam.locator('[data-seg-ok="'+fireAM.id+'"]').click();
  check('AM:切回正常后说明框立即消失(同步渲染,不等冲刷)',await pam.locator('[data-note-id="'+fireAM.id+'"]').count()===0);
  await pam.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAM2);
  const lastPutAM=putBodiesAM[putBodiesAM.length-1];
  check('AM:切回正常后的PUT请求体note为null(旧说明未随working残留)',lastPutAM.items.find(it=>it.id===fireAM.id).note===null,lastPutAM);
  check('浏览器无未捕获异常(AM)',errorsAM.length===0);
  await cam.close();

  // AN) 方案§3.1第2条：读数在硬范围内但超出参考范围(SOFT_RANGE)时,输入旁提示"超出参考范围",仍正常
  // 保存(PUT带该值,不拦截)。温度硬-20~60/软18~27,湿度硬0~100/软40~60。
  const draftAN=await buildDraftSheet('SF-RoomSoftRange',2);
  const tempItemAN=draftAN.items.find(it=>it.item_key==='temperature');
  const humItemAN=draftAN.items.find(it=>it.item_key==='humidity');
  const can1=await browser.newContext();await can1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pan=await can1.newPage();const errorsAN=[];pan.on('pageerror',e=>errorsAN.push(e.message));
  const putBodiesAN=[];pan.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAN.id)){try{putBodiesAN.push(r.postDataJSON());}catch(_e){putBodiesAN.push(null);}}});
  await pan.goto(f.base+'/IT_Ledger.html#inspections');await pan.locator('[data-insp-row="'+draftAN.id+'"]').waitFor();
  await pan.locator('[data-insp-continue="'+draftAN.id+'"]').click();await pan.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pan);
  const tempInputAN=pan.locator('[data-num-id="'+tempItemAN.id+'"]');
  await tempInputAN.fill('30');
  check('AN:硬范围内(-20~60)、软范围外(18~27)的值30,提示"超出参考范围"',(await pan.locator('[data-num-soft="'+tempItemAN.id+'"]').innerText())==='超出参考范围');
  check('AN:同一时刻硬范围错误提示为空(不是被拦截,只是软提示)',(await pan.locator('[data-num-error="'+tempItemAN.id+'"]').innerText())==='');
  const settledBeforeAN=await pan.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pan.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAN);
  const lastPutAN=putBodiesAN[putBodiesAN.length-1];
  check('AN:软范围外的值30正常写入PUT请求体(仍保存,不拦截)',lastPutAN.items.find(it=>it.id===tempItemAN.id).number_value===30,lastPutAN);
  await tempInputAN.fill('22');
  check('AN:回到软范围内(22)后提示消失',(await pan.locator('[data-num-soft="'+tempItemAN.id+'"]').innerText())==='');
  const humInputAN=pan.locator('[data-num-id="'+humItemAN.id+'"]');
  await humInputAN.fill('75');
  check('AN:湿度硬范围内(0~100)、软范围外(40~60)的值75同样提示"超出参考范围"',(await pan.locator('[data-num-soft="'+humItemAN.id+'"]').innerText())==='超出参考范围');
  check('浏览器无未捕获异常(AN)',errorsAN.length===0);
  await can1.close();

  // AO) 方案§3.1第3条：越界(硬拦截)时输入框回显working里当前的有效值——不留"框里显示越界值、working
  // 其实没变"的视觉错位(择"回显上一个有效值"这一支,理由见文件头注释,不选"标红+失焦时才回显")。
  const draftAO=await buildDraftSheet('SF-RoomHardRevert',2);
  const tempItemAO=draftAO.items.find(it=>it.item_key==='temperature');
  const cao1=await browser.newContext();await cao1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pao=await cao1.newPage();const errorsAO=[];pao.on('pageerror',e=>errorsAO.push(e.message));
  await pao.goto(f.base+'/IT_Ledger.html#inspections');await pao.locator('[data-insp-row="'+draftAO.id+'"]').waitFor();
  await pao.locator('[data-insp-continue="'+draftAO.id+'"]').click();await pao.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pao);
  const tempInputAO=pao.locator('[data-num-id="'+tempItemAO.id+'"]');
  await tempInputAO.fill('22'); // 先建立一个有效working值(working.number_value=22,同步写入,不必等冲刷)
  await tempInputAO.fill('200'); // 越界
  check('AO:越界时硬范围错误提示出现',(await pao.locator('[data-num-error="'+tempItemAO.id+'"]').innerText()).includes('超出范围'));
  check('AO:越界时输入框回显上一个有效值(22),不是刚敲的200(working.number_value未变,DOM也回显22,不留视觉错位)',await tempInputAO.inputValue()==='22');
  const draftAO2=await buildDraftSheet('SF-RoomHardRevertEmpty',2);
  const tempItemAO2=draftAO2.items.find(it=>it.item_key==='temperature');
  await pao.locator('#itlFormBack').click();await pao.locator('[data-insp-row="'+draftAO2.id+'"]').waitFor();
  await pao.locator('[data-insp-continue="'+draftAO2.id+'"]').click();await pao.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pao);
  const tempInputAO2=pao.locator('[data-num-id="'+tempItemAO2.id+'"]');
  await tempInputAO2.fill('999');
  check('AO:working尚无有效值时越界,回显为空(不是继续显示越界值999)',await tempInputAO2.inputValue()==='');
  check('浏览器无未捕获异常(AO)',errorsAO.length===0);
  await cao1.close();

  // AP) 矩阵缺口①：离开页签×冲刷成功——切走后成功响应不渲染回填写页、不误报错误(performFlush成功分支
  // 的if(formVisible(f))没有配对的else,这一格本就不该有任何用户可见动作,只需证明"没有把机柜视图覆盖
  // 成表单")。
  const draftAP=await buildDraftSheet('SF-RoomLeaveOk',2);
  const airconAP=draftAP.items.find(it=>it.item_key==='aircon');
  const cap1=await browser.newContext();await cap1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pap=await cap1.newPage();const errorsAP=[];pap.on('pageerror',e=>errorsAP.push(e.message));
  await pap.goto(f.base+'/IT_Ledger.html#inspections');await pap.locator('[data-insp-row="'+draftAP.id+'"]').waitFor();
  await pap.locator('[data-insp-continue="'+draftAP.id+'"]').click();await pap.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pap);
  await pap.locator('[data-seg-ok="'+airconAP.id+'"]').click(); // 排队冲刷（真实1.5秒防抖）
  const settledBeforeAP=await pap.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pap.evaluate(()=>{location.hash='racks';}); // 触发onLeave(left=true),冲刷任务照常自然成功
  await pap.locator('.itl-rack-workspace').waitFor();
  await pap.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAP);
  check('AP(矩阵①):离开页签后冲刷成功,仍停在机柜视图',await pap.locator('.itl-rack-workspace').count()===1);
  check('AP(矩阵①):没有把填写页画回来(无#itlFormActionbar)',await pap.locator('#itlFormActionbar').count()===0);
  check('AP(矩阵①):没有误报"有修改未保存"或其它notice',await pap.locator('#itlNotice:not([hidden])').count()===0);
  const serverAP=await getSheet(draftAP.id,2);
  check('AP(矩阵①):冲刷确实真正落库(aircon=ok)',serverAP.body.items.find(it=>it.id===airconAP.id).result==='ok',serverAP.body);
  check('浏览器无未捕获异常(AP)',errorsAP.length===0);
  await cap1.close();

  // AQ) T-M3（43T M3）重写：旧版"冲刷挂起期间飞行中编辑B"这条分支在在途锁下不可达（B的编辑会被
  // isLocked(f)拒绝——Y块已专门覆盖"在途期间编辑被拒绝、零状态变化"这条路径），删除该分支；保留原有
  // 价值的断言——非409网络异常导致A的冲刷失败后，working仍保留A的本地值（不被清空/回滚）；解锁后可以
  // 正常编辑B，随后的保存把A（此前失败保留的值）与B一起带上、落库。
  const draftAQ=await buildDraftSheet('SF-RoomFlightNet',2);
  const airconAQ=draftAQ.items.find(it=>it.item_key==='aircon');
  const upsAQ=draftAQ.items.find(it=>it.item_key==='ups');
  const caq1=await browser.newContext();await caq1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paq=await caq1.newPage();const errorsAQ=[];paq.on('pageerror',e=>errorsAQ.push(e.message));
  const putBodiesAQ=[];paq.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAQ.id)){try{putBodiesAQ.push(r.postDataJSON());}catch(_e){putBodiesAQ.push(null);}}});
  await paq.goto(f.base+'/IT_Ledger.html#inspections');await paq.locator('[data-insp-row="'+draftAQ.id+'"]').waitFor();
  await paq.locator('[data-insp-continue="'+draftAQ.id+'"]').click();await paq.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paq);
  await paq.route('**/api/it-assets/inspections/sheets/'+draftAQ.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await paq.locator('[data-seg-ok="'+airconAQ.id+'"]').click(); // A：排队冲刷（真实1.5秒防抖，会被网络异常中断)
  const settledBeforeAQ=await paq.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await paq.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAQ);
  check('AQ:非409网络异常导致冲刷失败后,working仍保留A的本地值(aircon=ok,未被清空/回滚)',await paq.locator('[data-seg-ok="'+airconAQ.id+'"].on-ok').count()===1);
  const noticeTextAQ=await paq.locator('#itlNotice').innerText();
  check('AQ:notice提示保存失败(不是版本冲突文案)',noticeTextAQ.includes('巡检单保存失败'),noticeTextAQ);
  const serverAQ=await getSheet(draftAQ.id,2);
  check('AQ:服务端未落库这次失败的PUT(aircon仍是初始null)',serverAQ.body.items.find(it=>it.id===airconAQ.id).result===null,serverAQ.body);
  check('AQ:落定解锁后A的按钮已恢复可点(不再disabled)',await paq.locator('[data-seg-ok="'+airconAQ.id+'"][disabled]').count()===0);
  await paq.unroute('**/api/it-assets/inspections/sheets/'+draftAQ.id); // 解除失败路由，之后的保存应该能正常成功
  const settledBeforeRetryAQ=await paq.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await paq.locator('[data-seg-bad="'+upsAQ.id+'"]').click(); // 解锁后正常编辑B
  await paq.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeRetryAQ);
  const lastPutAQ=putBodiesAQ[putBodiesAQ.length-1];
  check('AQ:解锁后编辑B的保存请求体同时带上A(此前失败保留的本地值)与B两项',lastPutAQ.items.some(it=>it.id===airconAQ.id&&it.result==='ok')&&lastPutAQ.items.some(it=>it.id===upsAQ.id&&it.result==='bad'),lastPutAQ);
  const finalGetAQ=await getSheet(draftAQ.id,2);
  check('AQ:最终服务端落库了A与B两项',finalGetAQ.body.items.find(it=>it.id===airconAQ.id).result==='ok'&&finalGetAQ.body.items.find(it=>it.id===upsAQ.id).result==='bad',finalGetAQ.body.items);
  check('浏览器无未捕获异常(AQ)',errorsAQ.length===0);
  await caq1.close();

  // AR) 矩阵缺口③：提交自身触发409——sheet先达到complete状态,进表单不编辑任何东西(避免H2拦在冲刷这
  // 一步),另一个身份把version推高,点提交→submit带旧version→后端409 SHEET_VERSION_CONFLICT→
  // performSubmit的对应分支触发handleConflict→notice文案、仍停在填写页(不跳详情页,不同于成功分支)。
  const draftAR=await buildDraftSheet('SF-RoomSubmitConflict',2);
  const filledAR=fillPayloadAllOk(draftAR.items);
  const putAR=await f.api('PUT','/inspections/sheets/'+draftAR.id,{expected_version:draftAR.version,items:filledAR},2);
  assert.equal(putAR.status,200,'AR put '+JSON.stringify(putAR.body));
  await uploadAllRackFrontPhotos(draftAR.id,draftAR.scope,2);
  const car1=await browser.newContext();await car1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const parr=await car1.newPage();const errorsAR=[];parr.on('pageerror',e=>errorsAR.push(e.message));
  let submitCountAR=0;parr.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/inspections/sheets/'+draftAR.id+'/submit'))submitCountAR++;});
  await parr.goto(f.base+'/IT_Ledger.html#inspections');await parr.locator('[data-insp-row="'+draftAR.id+'"]').waitFor();
  await parr.locator('[data-insp-continue="'+draftAR.id+'"]').click();await parr.locator('#itlFormActionbar').waitFor();await expandInspectionForm(parr);
  check('AR准备:进表单未编辑,提交按钮此刻可点(complete=true)',await parr.locator('#itlFormSubmit[disabled]').count()===0);
  const otherPutAR=await f.api('PUT','/inspections/sheets/'+draftAR.id,{expected_version:putAR.body.version,remark:'另一身份推高version'},1);
  assert.equal(otherPutAR.status,200,'AR other put '+JSON.stringify(otherPutAR.body));
  await parr.locator('#itlFormSubmit').click();
  await parr.locator('#itlNotice:not([hidden])').waitFor();
  const noticeTextAR=await parr.locator('#itlNotice').innerText();
  check('AR(矩阵③):submit自身撞409,notice是版本冲突文案',noticeTextAR.includes('这张单已在别处被修改，你的改动仍在，请核对后再保存'),noticeTextAR);
  check('AR(矩阵③):提交请求确实发出过恰1次(证明命中的是submit自己的409分支,不是被H2冲刷拦截)',submitCountAR===1,submitCountAR);
  check('AR(矩阵③):仍停在填写页(不像成功分支那样跳到详情页)',await parr.locator('#itlFormActionbar').count()===1);
  const serverAR=await getSheet(draftAR.id,2);
  check('AR(矩阵③):服务端仍是draft状态(未被提交)',serverAR.body.status==='draft',serverAR.body.status);
  check('浏览器无未捕获异常(AR)',errorsAR.length===0);
  await car1.close();

  // AS) it-ledger.js §setTab：onLeave 包 try/catch(任何视图的onLeave抛错都不挡切换)+ 同页签重复点击
  // (转换别名后的tab与state.tab相同)不调用onLeave。
  const draftAS=await buildDraftSheet('SF-RoomOnLeave',2);
  const cas1=await browser.newContext();await cas1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pas=await cas1.newPage();const errorsAS=[];pas.on('pageerror',e=>errorsAS.push(e.message));
  await pas.goto(f.base+'/IT_Ledger.html#inspections');await pas.locator('[data-insp-row="'+draftAS.id+'"]').waitFor();
  // AS-1：inspections视图的onLeave抛错→切到"机柜"页签——不能有未捕获异常，且必须真的切换成功。
  await pas.evaluate(()=>{const v=window.ITLedger.state.views.inspections;v.__origOnLeave=v.onLeave;v.onLeave=()=>{throw new Error('AS测试:onLeave故意抛错');};});
  await pas.evaluate(()=>window.ITLedger.setTab('racks'));
  await pas.locator('.itl-rack-workspace').waitFor();
  check('AS-1:onLeave抛错不挡页签切换(真的切到了机柜视图)',await pas.locator('.itl-rack-workspace').count()===1);
  check('AS-1:onLeave抛错没有产生未捕获的浏览器异常(被try/catch吞掉)',errorsAS.length===0);
  await pas.evaluate(()=>{const v=window.ITLedger.state.views.inspections;v.onLeave=v.__origOnLeave;delete v.__origOnLeave;});
  // AS-2：先切回巡检页签，装一个计数spy；同页签重复点击不应调用onLeave；真正切换页签时才调用一次。
  await pas.evaluate(()=>window.ITLedger.setTab('inspections'));await pas.locator('[data-insp-row="'+draftAS.id+'"]').waitFor();
  await pas.evaluate(()=>{const v=window.ITLedger.state.views.inspections;const orig=v.onLeave;window.__onLeaveCountAS=0;v.onLeave=(...args)=>{window.__onLeaveCountAS++;return orig.apply(v,args);};});
  await pas.evaluate(()=>window.ITLedger.setTab('inspections')); // 同页签重复点击
  check('AS-2:同页签重复点击(tab===state.tab)不调用onLeave',await pas.evaluate(()=>window.__onLeaveCountAS)===0);
  await pas.evaluate(()=>window.ITLedger.setTab('racks'));
  await pas.locator('.itl-rack-workspace').waitFor();
  check('AS-2:真正切换页签时onLeave被调用了一次',await pas.evaluate(()=>window.__onLeaveCountAS)===1);
  check('浏览器无未捕获异常(AS)',errorsAS.length===0);
  await cas1.close();

  // ============================================================
  // C5a-d 新增（spec-C5a-d.md「测试」节新增三条）：T-H3 提交在途期间编辑被拒；S-H1 离开冲刷失败→会话
  // 保留→重开复用；S-H4 采集期间他人改备注→采集后取服务器值、下次保存不回滚。
  // ============================================================

  // AT) T-H3（43T H3，方案必做5）：提交POST挂起期间尝试改备注/开关——全部被isLocked(f)拒绝(值不变、
  // 无新PUT发出)；提交失败后解锁、本地状态保留（spec原句）。用"提交失败"而不是"提交成功"构造——自查
  // 发现：若用成功路径，performSubmit成功分支本身就会clearTimeout(f.timer)清一次自动保存计时器（防
  // "提交成功后残留一个指向已提交单的悬空重发"，这是另一条既有防线），这个清理动作会把"绕开disabled
  // 改备注却漏了isLocked守卫"这个假想bug的延迟副作用一并冲掉，让变异测不出来（第一版用成功路径+假
  // 时钟推2秒验证，变异去掉守卫后套件仍然全绿——自查改用失败路径复测才真正首红命中）；失败分支不做
  // 这次清理，才能让"漏了守卫→working被写入→计时器被排上→fastForward后真的补发PUT"这条链路完整
  // 暴露出来。
  const draftAT=await buildDraftSheet('SF-RoomSubmitEditBlock',2);
  const filledAT=fillPayloadAllOk(draftAT.items);
  const putAT=await f.api('PUT','/inspections/sheets/'+draftAT.id,{expected_version:draftAT.version,items:filledAT},2);
  assert.equal(putAT.status,200,'AT put '+JSON.stringify(putAT.body));
  await uploadAllRackFrontPhotos(draftAT.id,draftAT.scope,2);
  const cat1=await browser.newContext();await cat1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pat=await cat1.newPage();const errorsAT=[];pat.on('pageerror',e=>errorsAT.push(e.message));
  let putCountAT=0;pat.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAT.id))putCountAT++;});
  let enteredResolveAT,releaseGateAT;const enteredAT=new Promise(r=>enteredResolveAT=r);
  await pat.route('**/api/it-assets/inspections/sheets/'+draftAT.id+'/submit',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    enteredResolveAT();await new Promise(r=>releaseGateAT=r);await route.abort('failed');
  });
  await pat.goto(f.base+'/IT_Ledger.html#inspections');await pat.locator('[data-insp-row="'+draftAT.id+'"]').waitFor();
  await pat.locator('[data-insp-continue="'+draftAT.id+'"]').click();await pat.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pat);
  await pat.clock.install();await pat.clock.pauseAt(new Date());
  await pat.locator('#itlFormSubmit').click();
  await enteredAT; // 提交POST已发出、被挂住——在途锁生效(f.submitting=true)
  // C5a-e H5：备注框锁定时改用 readonly（保留焦点/光标），不再是 disabled——断言随之改成查 readonly
  // 属性（原"已disabled"断言改写，见交付报告"原断言→新断言"清单）。
  check('AT(G5=A′,原T-H3"备注输入框已disabled"改写):提交在途期间备注输入框已readonly',await pat.locator('#itlFormRemark[readonly]').count()===1);
  const airconAT=putAT.body.items.find(it=>it.item_key==='aircon');
  check('AT(T-H3):提交在途期间检查项开关按钮已disabled',await pat.locator('[data-seg-ok="'+airconAT.id+'"][disabled]').count()===1);
  // 绕开readonly，验证监听器内部isLocked(f)判据本身：改备注+切开关都应该被拒绝，working零变化。
  await pat.evaluate(()=>{document.querySelector('#itlFormRemark').readOnly=false;});
  await pat.locator('#itlFormRemark').fill('提交在途期间的非法编辑');
  await pat.evaluate(id=>{const btn=document.querySelector('[data-seg-bad="'+id+'"]');btn.disabled=false;btn.click();},airconAT.id);
  check('AT(T-H3):提交在途期间的开关点击被拒绝,working零变化(仍是ok,不是bad,同步渲染层面立即可见)',await pat.locator('[data-seg-ok="'+airconAT.id+'"].on-ok').count()===1&&await pat.locator('[data-seg-bad="'+airconAT.id+'"].on-bad').count()===0);
  releaseGateAT(); // 放行：提交失败(网络异常,不是409)
  await pat.locator('#itlNotice:not([hidden])').waitFor();
  check('AT(T-H3):提交失败后解锁,仍停在填写页(未被导航离开)',await pat.locator('#itlFormActionbar').count()===1);
  check('AT(T-H3):提交按钮解锁后恢复可点(不再卡在提交中)',await pat.locator('#itlFormSubmit[disabled]').count()===0);
  // 推过2秒以上（超过1.5秒防抖窗口），用到达信号证明观察窗口已过——提交失败分支不清计时器，如果"绕开
  // disabled改备注"那一步的监听器守卫其实没生效（working被静默写入+计时器被排上），这里会补发一次
  // PUT（已提交单支持"保存修改"§5.3——但这里根本没提交成功，仍是draft，普通PUT一样能写入）；守卫真的
  // 生效则working从未被写入，没有计时器可推，计数不变。
  const putCountBeforeClockAT=putCountAT;
  await pat.clock.fastForward(2500);
  const sentinelAT=async()=>{const seen=pat.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await pat.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await sentinelAT();
  check('AT(T-H3):推过2秒以上(超过1.5秒防抖窗口)后仍未补发PUT(拒绝是真的没写入working,不是延迟发生)',putCountAT===putCountBeforeClockAT,putCountAT);
  const finalGetAT=await getSheet(draftAT.id,2);
  check('AT(T-H3):服务端确认提交在途期间的编辑没有落库(备注仍是空,不是"提交在途期间的非法编辑")',!finalGetAT.body.remark||finalGetAT.body.remark==='',finalGetAT.body.remark);
  check('AT(T-H3):服务端确认单据仍是draft(提交确实失败,没有被悄悄提交成功)',finalGetAT.body.status==='draft',finalGetAT.body.status);
  check('浏览器无未捕获异常(AT)',errorsAT.length===0);
  await cat1.close();

  // ============================================================
  // C5a-e（spec-C5a-e.md）：H5 锁定不抢焦点——performFlush 上锁/解锁改走 applyLockState 就地更新
  // （readonly/disabled 切换，不重建 DOM），不再整表 renderForm；少数确需整表重绘的场景（冲突合并等）
  // renderForm 现在会捕获/恢复焦点与选区。
  // ============================================================

  // AW) H5必做用例：备注框输入中触发自动保存——挂起PUT期间document.activeElement仍是同一个DOM节点、
  // 框为readonly；放行后焦点仍在、readonly解除、可以继续输入；追加的输入被下一轮自动保存带出去。
  const draftAW=await buildDraftSheet('SF-RoomFocusRemark',2);
  const caw=await browser.newContext();await caw.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paw=await caw.newPage();const errorsAW=[];paw.on('pageerror',e=>errorsAW.push(e.message));
  const putBodiesAW=[];paw.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftAW.id)){try{putBodiesAW.push(r.postDataJSON());}catch(_e){putBodiesAW.push(null);}}});
  await paw.goto(f.base+'/IT_Ledger.html#inspections');await paw.locator('[data-insp-row="'+draftAW.id+'"]').waitFor();
  await paw.locator('[data-insp-continue="'+draftAW.id+'"]').click();await paw.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paw);
  await paw.clock.install();await paw.clock.pauseAt(new Date()); // 装表后才能用fastForward控制1.5秒防抖，不是真的等
  const heldAW=holdRequestRoute(paw,'**/api/it-assets/inspections/sheets/'+draftAW.id,'PUT');
  await paw.locator('#itlFormRemark').click(); // 先聚焦
  await paw.locator('#itlFormRemark').pressSequentially('abc');
  // 打一个只存在于JS对象上的marker——innerHTML整表重绘会产生全新的DOM节点(即使id相同)，这个expando
  // 属性不会跟着"复活"；只有真正就地更新(不换节点)才会保留它。只查activeElement.id相等测不出"是不是
  // 同一个节点"(mutation⑦把上锁点改回renderForm时，renderForm自己的captureFocusKey/restoreFocusKey
  // 会把焦点"按id"找回来，同样能让.id相等这条断言通过，测不出区别——本块首次落笔时踩过这个坑，交叉
  // 用变异⑦验证后发现，改用节点identity marker才是真正的判别力来源）。
  await paw.evaluate(()=>{document.getElementById('itlFormRemark').__nodeMarkerAW='original-node';});
  await paw.clock.fastForward(1600); // 推过1.5秒防抖窗口，触发自动保存
  await heldAW.entered; // PUT已发出、被挂住——在途锁生效
  const activeIdAfterLockAW=await paw.evaluate(()=>document.activeElement&&document.activeElement.id);
  const markerAfterLockAW=await paw.evaluate(()=>document.activeElement&&document.activeElement.__nodeMarkerAW);
  check('AW(H5必做):自动保存挂起期间document.activeElement仍是备注框(id相同)',activeIdAfterLockAW==='itlFormRemark',activeIdAfterLockAW);
  check('AW(H5必做，节点identity判据):挂起期间activeElement是原来那个DOM节点(marker还在,没有被整表重绘换成新节点)',markerAfterLockAW==='original-node',markerAfterLockAW);
  const readOnlyDuringAW=await paw.locator('#itlFormRemark').evaluate(el=>el.readOnly);
  check('AW(H5必做):自动保存挂起期间备注框已readonly(不是disabled,焦点没被剥夺)',readOnlyDuringAW===true);
  heldAW.release();
  await paw.waitForFunction(()=>!document.querySelector('#itlFormRemark').readOnly,null,{timeout:5000});
  const activeIdAfterUnlockAW=await paw.evaluate(()=>document.activeElement&&document.activeElement.id);
  const markerAfterUnlockAW=await paw.evaluate(()=>document.activeElement&&document.activeElement.__nodeMarkerAW);
  check('AW(H5必做):放行成功后焦点仍在备注框(id相同)',activeIdAfterUnlockAW==='itlFormRemark',activeIdAfterUnlockAW);
  check('AW(H5必做，节点identity判据):放行后activeElement仍是原来那个DOM节点(就地applyLockState解锁,不是整表renderForm换新节点)',markerAfterUnlockAW==='original-node',markerAfterUnlockAW);
  await paw.locator('#itlFormRemark').pressSequentially('123'); // 焦点连续，直接追加输入
  await paw.clock.fastForward(1600);
  const sentinelAW=async()=>{const seen=paw.waitForRequest(r=>r.url().endsWith('/api/it-assets/me?sentinel=1'));await paw.evaluate(()=>{fetch('/api/it-assets/me?sentinel=1',{headers:{Authorization:'Bearer '+localStorage.getItem('token')}}).catch(()=>{});});await seen;};
  await sentinelAW();
  check('AW(H5必做):最终备注框DOM值为"abc123"(焦点连续,输入没有被中断/丢失)',await paw.locator('#itlFormRemark').inputValue()==='abc123');
  const lastPutAW=putBodiesAW[putBodiesAW.length-1];
  check('AW(H5必做):追加输入被下一轮自动保存发出,请求体remark为"abc123"',!!lastPutAW&&lastPutAW.remark==='abc123',lastPutAW);
  check('浏览器无未捕获异常(AW)',errorsAW.length===0);
  await caw.close();

  // AX) H5必做用例（数字读数框，简化版）：挂起期间焦点保留+readonly；放行后readonly解除、焦点仍在。
  const draftAX=await buildDraftSheet('SF-RoomFocusNumber',2);
  const numberItemAX=draftAX.items.find(it=>it.item_key==='temperature');
  const cax2=await browser.newContext();await cax2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pax2=await cax2.newPage();const errorsAX=[];pax2.on('pageerror',e=>errorsAX.push(e.message));
  await pax2.goto(f.base+'/IT_Ledger.html#inspections');await pax2.locator('[data-insp-row="'+draftAX.id+'"]').waitFor();
  await pax2.locator('[data-insp-continue="'+draftAX.id+'"]').click();await pax2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pax2);
  await pax2.clock.install();await pax2.clock.pauseAt(new Date());
  const heldAX=holdRequestRoute(pax2,'**/api/it-assets/inspections/sheets/'+draftAX.id,'PUT');
  await pax2.locator('[data-num-id="'+numberItemAX.id+'"]').fill('22');
  // 同AW：打节点identity marker——只查id/属性相等测不出"是不是同一个节点"(renderForm自己也会把焦点
  // 按id/属性找回来)，marker只在真正就地更新(不换节点)时才会保留。
  await pax2.evaluate(id=>{document.querySelector('[data-num-id="'+id+'"]').__nodeMarkerAX='original-node';},numberItemAX.id);
  await pax2.clock.fastForward(1600);
  await heldAX.entered;
  const activeIdAfterLockAX=await pax2.evaluate(()=>document.activeElement&&document.activeElement.getAttribute('data-num-id'));
  const markerAfterLockAX=await pax2.evaluate(()=>document.activeElement&&document.activeElement.__nodeMarkerAX);
  check('AX(H5必做):数字读数框自动保存挂起期间document.activeElement仍是同一个输入框(data-num-id相同)',activeIdAfterLockAX===String(numberItemAX.id),activeIdAfterLockAX);
  check('AX(H5必做，节点identity判据):挂起期间activeElement是原来那个DOM节点(marker还在)',markerAfterLockAX==='original-node',markerAfterLockAX);
  check('AX(H5必做):挂起期间数字读数框已readonly',await pax2.locator('[data-num-id="'+numberItemAX.id+'"]').evaluate(el=>el.readOnly)===true);
  heldAX.release();
  await pax2.waitForFunction(id=>!document.querySelector('[data-num-id="'+id+'"]').readOnly,numberItemAX.id,{timeout:5000});
  const activeIdAfterUnlockAX=await pax2.evaluate(()=>document.activeElement&&document.activeElement.getAttribute('data-num-id'));
  const markerAfterUnlockAX=await pax2.evaluate(()=>document.activeElement&&document.activeElement.__nodeMarkerAX);
  check('AX(H5必做):放行成功后焦点仍在数字读数框(data-num-id相同)',activeIdAfterUnlockAX===String(numberItemAX.id),activeIdAfterUnlockAX);
  check('AX(H5必做，节点identity判据):放行后activeElement仍是原来那个DOM节点(就地解锁,不是整表重绘换新节点)',markerAfterUnlockAX==='original-node',markerAfterUnlockAX);
  check('浏览器无未捕获异常(AX)',errorsAX.length===0);
  await cax2.close();

  // AY) H5必做用例（解锁后需整表重绘——冲突合并）：证明焦点与选区被恢复，不是被弹回document.body。
  const draftAY=await buildDraftSheet('SF-RoomFocusConflict',2);
  const cay2=await browser.newContext();await cay2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pay2=await cay2.newPage();const errorsAY=[];pay2.on('pageerror',e=>errorsAY.push(e.message));
  await pay2.goto(f.base+'/IT_Ledger.html#inspections');await pay2.locator('[data-insp-row="'+draftAY.id+'"]').waitFor();
  await pay2.locator('[data-insp-continue="'+draftAY.id+'"]').click();await pay2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pay2);
  await pay2.clock.install();await pay2.clock.pauseAt(new Date());
  const heldAY=holdRequestRoute(pay2,'**/api/it-assets/inspections/sheets/'+draftAY.id,'PUT');
  await pay2.locator('#itlFormRemark').fill('hello world');
  await pay2.evaluate(()=>{const el=document.getElementById('itlFormRemark');el.focus();el.setSelectionRange(6,11);}); // 选中"world"
  await pay2.clock.fastForward(1600);
  await heldAY.entered; // PUT已发出、被挂住
  // 另一个操作者趁这次PUT还没到服务器，先用当前version改了一项检查项，把版本推高——放行后这次PUT撞409。
  const upsAY=draftAY.items.find(it=>it.item_key==='ups');
  const otherPutAY=await f.api('PUT','/inspections/sheets/'+draftAY.id,{expected_version:draftAY.version,items:[{id:upsAY.id,result:'bad',number_value:null,note:'别处已修改'}]},2);
  assert.equal(otherPutAY.status,200,'AY other put '+JSON.stringify(otherPutAY.body));
  const settledBeforeAY=await pay2.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldAY.release(); // 放行：这次PUT带的还是旧version,会409→handleConflict→needsFullRender→整表重绘
  await pay2.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAY);
  await pay2.locator('.itl-sheet-conflict').first().waitFor(); // 确认真的走了冲突合并这条整表重绘路径
  const focusAfterAY=await pay2.evaluate(()=>{const el=document.activeElement;return el?{id:el.id,selStart:el.selectionStart,selEnd:el.selectionEnd}:null;});
  check('AY(H5必做):冲突合并触发整表重绘后,焦点仍恢复到备注框(不是被弹回document.body)',!!focusAfterAY&&focusAfterAY.id==='itlFormRemark',focusAfterAY);
  check('AY(H5必做):选区也被恢复("world"对应的6-11)',!!focusAfterAY&&focusAfterAY.selStart===6&&focusAfterAY.selEnd===11,focusAfterAY);
  check('浏览器无未捕获异常(AY)',errorsAY.length===0);
  await cay2.close();

  // AU) M6（G5=A′改写，原 S-H1"离开冲刷失败保留会话"用例）：入口=返回列表→继续填写；结局=离开冲刷失败。
  // 离开时冲刷失败不再保留会话——重开同一张单一律走全新GET（不是复用），看到的是服务器旧值（本地未保存
  // 的修改确实丢了，这是 G5=A′用户裁定接受的已知代价）；常驻提示列出未保存内容原文；重开不会带出第二次
  // PUT（旧版"复用会话→再保存一次"这条路径已经不存在）。
  const draftAU=await buildDraftSheet('SF-RoomLeaveKeep',2);
  const airconAU=draftAU.items.find(it=>it.item_key==='aircon');
  const cau1=await browser.newContext();await cau1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau=await cau1.newPage();const errorsAU=[];pau.on('pageerror',e=>errorsAU.push(e.message));
  let getCountAU=0,putCountAU=0;pau.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+draftAU.id)){if(r.method()==='GET')getCountAU++;if(r.method()==='PUT')putCountAU++;}});
  await pau.goto(f.base+'/IT_Ledger.html#inspections');await pau.locator('[data-insp-row="'+draftAU.id+'"]').waitFor();
  await pau.locator('[data-insp-continue="'+draftAU.id+'"]').click();await pau.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau);
  // 让这张单的PUT恒失败（网络异常）——离开时排的"离开冲刷"会撞这条路由。
  await pau.route('**/api/it-assets/inspections/sheets/'+draftAU.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  const baseSettledAU=await pau.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pau.locator('[data-seg-ok="'+airconAU.id+'"]').click(); // 制造脏数据（真实1.5秒防抖，但下一步会立即离开，用不到它）
  await pau.locator('#itlFormBack').click(); // 触发leaveForm——会话同步销毁+排一次离开冲刷，立即回到列表(不等冲刷落定)
  await pau.locator('[data-insp-row]').first().waitFor();
  await pau.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAU); // 等离开冲刷真的落定(失败)
  const afterLeaveFailAU=await getSheet(draftAU.id,2);
  check('AU(M6):离开时冲刷失败,服务端未落库(aircon仍是初始null)',afterLeaveFailAU.body.items.find(it=>it.id===airconAU.id).result===null,afterLeaveFailAU.body);
  const noticeTextAU=await pau.locator('#itlNotice').innerText();
  check('AU(H2):列表尚未就绪时一次性提示保留完整原文',noticeTextAU.includes('巡检单〈'+sheetLabelStr(draftAU)+'〉有内容未能保存：')&&noticeTextAU.includes('空调运行：正常')&&!noticeTextAU.includes('详见巡检台账顶部'),noticeTextAU);
  const unsavedListAU=await pau.locator('#itlUnsavedList [data-unsaved-sheet="'+draftAU.id+'"]').innerText();
  check('AU(M6，原S-H1"重开直接复用会话"改写，N-L6迁到常驻条):常驻条含机房日期标签+"离开时有修改未能保存"+未保存内容原文"空调运行：正常"',unsavedListAU.includes(sheetLabelStr(draftAU))&&unsavedListAU.includes('离开时有修改未能保存')&&unsavedListAU.includes('空调运行：正常'),unsavedListAU);
  check('AU(M3，C5a-f/N-M3)：网络异常的原因映射成短语"网络异常"，不透传共享层原始message，也不含诱导刷新的"重新打开页面"（N-L6迁到常驻条)',unsavedListAU.includes('原因：网络异常）')&&!unsavedListAU.includes('重新打开页面'),unsavedListAU);
  await pau.unroute('**/api/it-assets/inspections/sheets/'+draftAU.id); // 解除失败路由
  const getCountBeforeReopenAU=getCountAU;
  await pau.locator('[data-insp-continue="'+draftAU.id+'"]').click(); // 重开同一张单——不再有复用分支，一律走全新GET
  await pau.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau);
  check('AU(M6):重开确实发起了一次新的GET(不是复用会话)',getCountAU===getCountBeforeReopenAU+1,{getCountAU,getCountBeforeReopenAU});
  check('AU(M6，原"本地未保存的修改仍显示"改写):重开后看到的是服务器旧值(aircon未被标记为正常)——本地未保存的修改确实丢了(G5=A′的已知代价)',await pau.locator('[data-seg-ok="'+airconAU.id+'"].on-ok').count()===0);
  check('AU(M6):全程只有离开冲刷那一次PUT,重开没有带出第二次PUT',putCountAU===1,putCountAU);
  check('浏览器无未捕获异常(AU)',errorsAU.length===0);
  await cau1.close();

  // AU2) M6：入口=返回列表→继续填写；结局=离开冲刷成功——重开看到服务器新值（重开永远走全新GET，不
  // 可能读到比这次冲刷更旧的值，"版本号为冲刷后版本"由此结构性保证，不需要额外读取客户端内部状态）。
  const draftAU2=await buildDraftSheet('SF-RoomLeaveSaveOk',2);
  const airconAU2=draftAU2.items.find(it=>it.item_key==='aircon');
  const cau2=await browser.newContext();await cau2.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau2=await cau2.newPage();const errorsAU2=[];pau2.on('pageerror',e=>errorsAU2.push(e.message));
  await pau2.goto(f.base+'/IT_Ledger.html#inspections');await pau2.locator('[data-insp-row="'+draftAU2.id+'"]').waitFor();
  await pau2.locator('[data-insp-continue="'+draftAU2.id+'"]').click();await pau2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau2);
  const baseSettledAU2=await pau2.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pau2.locator('[data-seg-ok="'+airconAU2.id+'"]').click();
  await pau2.locator('#itlFormBack').click();
  await pau2.locator('[data-insp-row]').first().waitFor();
  await pau2.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAU2);
  const serverAfterAU2=await getSheet(draftAU2.id,2);
  check('AU2(M6):离开冲刷成功,服务端已落库(aircon=ok)',serverAfterAU2.body.items.find(it=>it.id===airconAU2.id).result==='ok',serverAfterAU2.body);
  await pau2.locator('[data-insp-continue="'+draftAU2.id+'"]').click();
  await pau2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau2);
  check('AU2(M6):重开看到服务器新值(开关显示为正常)',await pau2.locator('[data-seg-ok="'+airconAU2.id+'"].on-ok').count()===1);
  check('AU2(M6):重开没有常驻提示(离开冲刷成功,没有需要补填的内容)',await pau2.locator('#itlNotice:not([hidden])').count()===0);
  check('浏览器无未捕获异常(AU2)',errorsAU2.length===0);
  await cau2.close();

  // AU3) M6：入口=切页签再切回；结局=离开冲刷在途时立即重开——重开等队列（queueIdle）落定后才真正发出
  // GET，不会用冲刷前的旧working覆盖冲刷后的新值。用"await click()后立即check、不额外sleep"的既有手法
  // （同AF-3(T-M2)对DELETE-sent的判据）：holdRequestRoute 挂住的是网络层，GET在结构上不可能在release()
  // 之前发出，不依赖真实计时。
  const draftAU3=await buildDraftSheet('SF-RoomLeaveInflight',2);
  const airconAU3=draftAU3.items.find(it=>it.item_key==='aircon');
  const cau3=await browser.newContext();await cau3.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau3=await cau3.newPage();const errorsAU3=[];pau3.on('pageerror',e=>errorsAU3.push(e.message));
  let getCountAU3=0;pau3.on('request',r=>{if(r.method()==='GET'&&r.url().endsWith('/inspections/sheets/'+draftAU3.id))getCountAU3++;});
  await pau3.goto(f.base+'/IT_Ledger.html#inspections');await pau3.locator('[data-insp-row="'+draftAU3.id+'"]').waitFor();
  await pau3.locator('[data-insp-continue="'+draftAU3.id+'"]').click();await pau3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau3);
  const heldAU3=holdRequestRoute(pau3,'**/api/it-assets/inspections/sheets/'+draftAU3.id,'PUT');
  await pau3.locator('[data-seg-ok="'+airconAU3.id+'"]').click(); // 制造脏数据
  await pau3.evaluate(()=>{location.hash='racks';}); // 触发onLeave→leaveForm：同步销毁会话+排一次离开冲刷
  await pau3.locator('.itl-rack-workspace').waitFor();
  await heldAU3.entered; // 等离开冲刷真的发出了这次PUT（此刻还没放行）
  await pau3.evaluate(()=>{location.hash='inspections';}); // 立即切回巡检页签
  await pau3.locator('[data-insp-row]').first().waitFor();
  const getCountBeforeReopenAU3=getCountAU3;
  await pau3.locator('[data-insp-continue="'+draftAU3.id+'"]').click(); // 立即点"继续填写"（PUT此刻仍挂起）
  check('AU3(M6):离开冲刷仍在途时点继续填写,GET被queueIdle挡住尚未发出',getCountAU3===getCountBeforeReopenAU3,{getCountAU3,getCountBeforeReopenAU3});
  heldAU3.release(); // 放行：离开冲刷这次PUT成功
  await pau3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau3);
  check('AU3(M6):放行后GET才真正发出(队列落定之后)',getCountAU3===getCountBeforeReopenAU3+1,{getCountAU3});
  check('AU3(M6):重开看到的是离开冲刷落定之后的值(aircon=正常)',await pau3.locator('[data-seg-ok="'+airconAU3.id+'"].on-ok').count()===1);
  check('浏览器无未捕获异常(AU3)',errorsAU3.length===0);
  await cau3.close();

  // AU4/AU5) M6：入口=打开别的单再回来 / 跨页入口 L.openInspectionSheet——在当前代码里是同一个函数
  // （服务器详情"见巡检单 #N"走这里，也是"表单开着时直接跳到另一张单"唯一暴露的入口），两格分别覆盖
  // 失败(AU4)与成功(AU5)两种结局，都验证 H2 的另一半修复：openForm 现在会对已存在的会话调用
  // leaveForm（排一次离开冲刷），不再像旧版那样只置 destroyed 静默丢弃本地修改（本地修改至少被"尝试
  // 冲刷过"，不是无声消失——差别在提示，不在"是否冲刷"）。
  const draftAU4A=await buildDraftSheet('SF-RoomLeaveOtherA',2);
  const draftAU4B=await buildDraftSheet('SF-RoomLeaveOtherB',2);
  const airconAU4A=draftAU4A.items.find(it=>it.item_key==='aircon');
  const cau4=await browser.newContext();await cau4.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau4=await cau4.newPage();const errorsAU4=[];pau4.on('pageerror',e=>errorsAU4.push(e.message));
  await pau4.goto(f.base+'/IT_Ledger.html#inspections');await pau4.locator('[data-insp-row="'+draftAU4A.id+'"]').waitFor();
  await pau4.locator('[data-insp-continue="'+draftAU4A.id+'"]').click();await pau4.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau4);
  await pau4.route('**/api/it-assets/inspections/sheets/'+draftAU4A.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  // 装假时钟并冻住——不这样做的话，A自己那次编辑排的"真实1.5秒自然防抖"会在跳到B之后仍然独立触发一次
  // performFlush，恰好也会因为f.destroyed已经被(不管是mutation直接置位还是leaveForm)设为true而走进
  // notifyLeaveFlushFailure，产出与"leaveForm真的被调用"完全相同的提示文案——那样即使mutation把
  // "openForm改回只置destroyed(不调leaveForm)"，这条自然计时器也会替它把该做的事悄悄做掉，测不出
  // 区别（06:55一类"自然防抖顶包"陷阱，AU4首次落笔时用变异①③交叉验证时发现）。冻住时钟后，
  // scheduleAutosave 排的 setTimeout 永远不会自己流逝，只有 leaveForm 内部"直接enqueue,不经过
  // setTimeout"的离开冲刷才能触发这次PUT——真正把"是否调用了leaveForm"从"是否最终冲刷"里分离出来。
  await pau4.clock.install();await pau4.clock.pauseAt(new Date());
  const baseSettledAU4=await pau4.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pau4.locator('[data-seg-ok="'+airconAU4A.id+'"]').click(); // A制造脏数据(假时钟下,不会自然触发)
  await pau4.evaluate(id=>window.ITLedger.openInspectionSheet(id),draftAU4B.id); // 直接跳到B，触发openForm→leaveForm(A)
  await pau4.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAU4,{timeout:5000}); // 等A的离开冲刷落定(失败)——L4/L5(C5a-f)：显式timeout，避免断言写错时拖到默认30秒才暴露
  await pau4.locator('.itl-sheet-title h2').waitFor(); // B也是draft带save，走的是填写页
  check('AU4(M6):打开别的单(B)后,页面确实切到了B的填写页',(await pau4.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomLeaveOtherB'));
  const noticeTextAU4=await pau4.locator('#itlNotice').innerText();
  check('AU4(H2):切到B单时A单常驻条不可达,一次性提示含A的原文',noticeTextAU4.includes('巡检单〈'+sheetLabelStr(draftAU4A)+'〉有内容未能保存：')&&noticeTextAU4.includes('空调运行：正常')&&!noticeTextAU4.includes('详见巡检台账顶部'),noticeTextAU4);
  // 此刻仍在B的填写页上(#itlUnsavedList只在列表视图里)——B自己没有脏数据，先"返回巡检台账"看列表顶部
  // 的常驻条，核实A的原文（N-L6迁到常驻条，不再能从#itlNotice读到）。
  await pau4.locator('#itlFormBack').click();await pau4.locator('[data-insp-row]').first().waitFor();
  const unsavedListAU4=await pau4.locator('#itlUnsavedList [data-unsaved-sheet="'+draftAU4A.id+'"]').innerText();
  check('AU4(M6，H2另一半修复，N-L6迁到常驻条):跳到别的单没有静默丢弃A的本地修改——离开冲刷确实尝试过(失败给常驻提示,不是无声消失)',unsavedListAU4.includes(sheetLabelStr(draftAU4A))&&unsavedListAU4.includes('离开时有修改未能保存')&&unsavedListAU4.includes('空调运行：正常'),unsavedListAU4);
  const serverAU4A=await getSheet(draftAU4A.id,2);
  check('AU4(M6):A服务端确实未落库(冲刷失败,不是悄悄成功了)',serverAU4A.body.items.find(it=>it.id===airconAU4A.id).result===null,serverAU4A.body);
  check('浏览器无未捕获异常(AU4)',errorsAU4.length===0);
  await cau4.close();

  const draftAU5A=await buildDraftSheet('SF-RoomLeaveOtherOkA',2);
  const draftAU5B=await buildDraftSheet('SF-RoomLeaveOtherOkB',2);
  const airconAU5A=draftAU5A.items.find(it=>it.item_key==='aircon');
  const cau5=await browser.newContext();await cau5.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau5=await cau5.newPage();const errorsAU5=[];pau5.on('pageerror',e=>errorsAU5.push(e.message));
  await pau5.goto(f.base+'/IT_Ledger.html#inspections');await pau5.locator('[data-insp-row="'+draftAU5A.id+'"]').waitFor();
  await pau5.locator('[data-insp-continue="'+draftAU5A.id+'"]').click();await pau5.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau5);
  // 同AU4：装假时钟并冻住，防止A自己排的"真实1.5秒自然防抖"独立触发一次冲刷、顶替掉本用例真正要证明
  // 的那次(由leaveForm在跳到B时排出的离开冲刷)，让mutation③测不出区别。
  await pau5.clock.install();await pau5.clock.pauseAt(new Date());
  const baseSettledAU5=await pau5.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pau5.locator('[data-seg-ok="'+airconAU5A.id+'"]').click();
  await pau5.evaluate(id=>window.ITLedger.openInspectionSheet(id),draftAU5B.id);
  await pau5.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,baseSettledAU5,{timeout:5000}); // L4/L5(C5a-f)：同AU4，显式timeout
  await pau5.locator('.itl-sheet-title h2').waitFor();
  check('AU5(M6):跨页跳到B,页面切到了B的填写页(不残留A的内容)',(await pau5.locator('.itl-sheet-title h2').innerText()).includes('SF-RoomLeaveOtherOkB'));
  check('AU5(M6):无残留"未保存"提示(A的离开冲刷成功)',await pau5.locator('#itlNotice:not([hidden])').count()===0);
  const serverAU5A=await getSheet(draftAU5A.id,2);
  check('AU5(M6，H2另一半修复):A的本地修改在跳走前已经成功落库(不是被静默丢弃)',serverAU5A.body.items.find(it=>it.id===airconAU5A.id).result==='ok',serverAU5A.body);
  check('浏览器无未捕获异常(AU5)',errorsAU5.length===0);
  await cau5.close();

  // AU6) M6：入口=新增巡检遇已存在草稿(offerExistingDraft)；结局=离开冲刷在途时立即重开——打开前先
  // queueIdle(fetchSheetForOpen)等这张单的队列落定，不会用离开冲刷之前的旧值覆盖冲刷后的新值。
  const draftAU6=await buildDraftSheet('SF-RoomLeaveOfferDraft',2);
  const airconAU6=draftAU6.items.find(it=>it.item_key==='aircon');
  const cau6=await browser.newContext();await cau6.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pau6=await cau6.newPage();const errorsAU6=[];pau6.on('pageerror',e=>errorsAU6.push(e.message));
  let getCountAU6=0;pau6.on('request',r=>{if(r.method()==='GET'&&r.url().endsWith('/inspections/sheets/'+draftAU6.id))getCountAU6++;});
  await pau6.goto(f.base+'/IT_Ledger.html#inspections');await pau6.locator('[data-insp-row="'+draftAU6.id+'"]').waitFor();
  await pau6.locator('[data-insp-continue="'+draftAU6.id+'"]').click();await pau6.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau6);
  const heldAU6=holdRequestRoute(pau6,'**/api/it-assets/inspections/sheets/'+draftAU6.id,'PUT');
  await pau6.locator('[data-seg-ok="'+airconAU6.id+'"]').click(); // 制造脏数据
  await pau6.locator('#itlFormBack').click(); // 触发leaveForm——排一次离开冲刷，立即回到列表
  await pau6.locator('[data-insp-row]').first().waitFor();
  await heldAU6.entered; // 等离开冲刷真的发出了这次PUT（此刻还没放行）
  const getCountBeforeAU6=getCountAU6;
  await pau6.locator('#itlInspNew').click();await pau6.locator('#itlModal.open').waitFor();
  await pau6.locator('select[name="room_name"]').selectOption('SF-RoomLeaveOfferDraft');
  await pau6.locator('#itlSubmit').click();
  await pau6.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='该机房已有草稿');
  await pau6.locator('#itlSubmit').click(); // "打开该草稿"——内部走fetchSheetForOpen=queueIdle+GET
  check('AU6(M6):离开冲刷仍在途时点"打开该草稿",GET被queueIdle挡住尚未发出',getCountAU6===getCountBeforeAU6,{getCountAU6,getCountBeforeAU6});
  heldAU6.release(); // 放行：离开冲刷这次PUT成功
  await pau6.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pau6);
  check('AU6(M6):放行后GET才真正发出(队列落定之后,queueIdle生效)',getCountAU6===getCountBeforeAU6+1,{getCountAU6});
  check('AU6(M6):重开看到的是离开冲刷落定之后的值(aircon=正常)',await pau6.locator('[data-seg-ok="'+airconAU6.id+'"].on-ok').count()===1);
  check('浏览器无未捕获异常(AU6)',errorsAU6.length===0);
  await cau6.close();

  // P6（协调方追加，C5a-e预筛实测发现的真实回归，与C6-d M1"统一失效标记"同一处代码）：A的离开冲刷
  // 挂起时点A"继续填写"（openDraftById内部fetchSheetForOpen=queueIdle(A)卡在A自己挂起的离开冲刷
  // 后面）→ 不等它，紧接着新建C并进入C的填写页（openNewSheetModal成功→openForm(C)，C6-d已经让这条
  // 路径也推进sequence）→ 放行A的离开冲刷→A卡住的queueIdle解除、GET终于真的发出→响应到达时应因
  // sequence已经被"新建C"推进而被判定过期丢弃，页面仍停在C，不会被拉回A。
  const draftP6A=await buildDraftSheet('SF-RoomP6A',2);
  const airconP6A=draftP6A.items.find(it=>it.item_key==='aircon');
  await makeRoom('SF-RoomP6C');
  const cp6=await browser.newContext();await cp6.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pp6=await cp6.newPage();const errorsP6=[];pp6.on('pageerror',e=>errorsP6.push(e.message));
  let getCountP6A=0;pp6.on('request',r=>{if(r.method()==='GET'&&r.url().endsWith('/inspections/sheets/'+draftP6A.id))getCountP6A++;});
  await pp6.goto(f.base+'/IT_Ledger.html#inspections');await pp6.locator('[data-insp-row="'+draftP6A.id+'"]').waitFor();
  await pp6.locator('[data-insp-continue="'+draftP6A.id+'"]').click();await pp6.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pp6);
  const heldP6A=holdRequestRoute(pp6,'**/api/it-assets/inspections/sheets/'+draftP6A.id,'PUT');
  await pp6.locator('[data-seg-ok="'+airconP6A.id+'"]').click(); // A制造脏数据
  await pp6.locator('#itlFormBack').click(); // 触发leaveForm——排一次离开冲刷，立即回到列表
  await pp6.locator('[data-insp-row]').first().waitFor();
  await heldP6A.entered; // 等离开冲刷真的发出了这次PUT（此刻还没放行，A的队列非空）
  const getCountBeforeP6A=getCountP6A;
  await pp6.locator('[data-insp-continue="'+draftP6A.id+'"]').click(); // 重新点"继续填写"——内部queueIdle(A)卡在挂起的离开冲刷后面
  // M4（C5a-f）→ N-M1（C5a-g 改走自有占位容器，不再用共享层#itlNotice）：fetchSheetForOpen里的
  // queueIdle(A)此刻确实在等（A的队列非空），应该先出现"正在等待上次保存完成…"占位——这条提示在下面
  // 打开"+新增巡检"弹窗、创建C之前就应该已经出现（同步设置，不依赖网络往返），不用waitForFunction等，
  // 直接读。
  const waitPlaceholderP6=await pp6.locator('#itlInspWaitPlaceholder').innerText();
  check('P6(N-M1改写):A的queueIdle确实在等时，出现"正在等待上次保存完成…"占位(自有容器,不是#itlNotice)',waitPlaceholderP6==='正在等待上次保存完成…',waitPlaceholderP6);
  check('P6(N-M1新增):占位不占用#itlNotice(此刻#itlNotice仍是hidden)',await pp6.locator('#itlNotice[hidden]').count()===1);
  // 不等上面这次点击的异步链路自己落定，立即新建C——"+新增巡检"选另一机房，成功后openForm(C)。
  await pp6.locator('#itlInspNew').click();await pp6.locator('#itlModal.open').waitFor();
  await pp6.locator('select[name="room_name"]').selectOption('SF-RoomP6C');
  await pp6.locator('#itlSubmit').click();
  await pp6.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pp6);
  const draftP6CId=await pp6.locator('[data-sheet-id]').getAttribute('data-sheet-id');
  check('P6准备:新建C成功且已经显示C的填写页(data-sheet-id非A)',draftP6CId!==String(draftP6A.id),draftP6CId);
  check('P6(必修·统一失效标记):A重开GET被queueIdle挡住尚未发出(A的挂起队列还没放行)',getCountP6A===getCountBeforeP6A,{getCountP6A,getCountBeforeP6A});
  const settledBeforeReleaseP6=await pp6.evaluate(()=>window.ITLedger.__inspLoadSettled);
  heldP6A.release(); // 放行A的离开冲刷——A卡住的queueIdle解除，随后真的会发出GET
  await pp6.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeReleaseP6,{timeout:5000}); // 等A这次重开的GET+处理真正落定
  check('P6(必修·统一失效标记):A迟到的GET确实发出过(不是从未触发,是发出后被正确丢弃)',getCountP6A===getCountBeforeP6A+1,{getCountP6A,getCountBeforeP6A});
  check('P6(必修·统一失效标记):页面仍停在C,没有被A的迟到响应拉回去(data-sheet-id仍是C,不是A)',await pp6.locator('[data-sheet-id="'+draftP6CId+'"]').count()===1&&await pp6.locator('[data-sheet-id="'+draftP6A.id+'"]').count()===0);
  // 此刻已经在C的填写页上(不是列表)，#itlInspWaitPlaceholder(列表视图自己的元素)根本不存在——本身就
  // 证明占位没有跟着"泄露"到C的视图里；顺带确认#itlNotice全程没被这套占位机制碰过。
  check('P6(N-M1改写):A的queueIdle落定后离开了列表视图，占位元素(#itlInspWaitPlaceholder)不存在，没有跟着泄露到C的视图',await pp6.locator('#itlInspWaitPlaceholder').count()===0);
  check('P6(N-M1新增):全程#itlNotice未被这套等待占位机制写过内容(此刻仍hidden)',await pp6.locator('#itlNotice[hidden]').count()===1);
  check('浏览器无未捕获异常(P6)',errorsP6.length===0);
  await cp6.close();

  // PX（C6-e MED-1，依据 C6-d 预筛 P3/F3 判别力确认，从 prescreen-m1-probe.js 移入本文件放在 P6 旁边）：
  // 与 P6 同一类"重开迟到响应"竞态，但换一个此前完全没测过的入口——offerExistingDraft 自己的
  // `++sequence`（P6 测的是 openNewSheetModal 成功路径的 `++sequence`，两个函数各自独立维护 sequence
  // 推进，不能互相替代判别力）。A 的 GET 挂起 →"新增巡检"选 B 所在机房（B 是已存在的草稿）→ 撞 409
  // SHEET_DRAFT_EXISTS →"该机房已有草稿"弹窗 → 点"打开该草稿" → offerExistingDraft 成功分支
  // `++sequence` 后 openForm(B) → 放行 A 的 GET（200，真实成功响应）→ 断言仍停在 B。
  const draftPXA=await buildDraftSheet('SF-RoomPXA',2);
  const draftPXB=await buildDraftSheet('SF-RoomPXB',2);
  const cpx=await browser.newContext();await cpx.addInitScript(()=>localStorage.setItem('token','fixture-2'));const ppx=await cpx.newPage();const errorsPX=[];ppx.on('pageerror',e=>errorsPX.push(e.message));
  await ppx.goto(f.base+'/IT_Ledger.html#inspections');await ppx.locator('[data-insp-row="'+draftPXA.id+'"]').waitFor();
  const heldPXA=holdRequestRoute(ppx,'**/api/it-assets/inspections/sheets/'+draftPXA.id,'GET');
  await ppx.locator('[data-insp-continue="'+draftPXA.id+'"]').click(); // 点A"继续填写"——GET被挂住，A的填写页此刻还没渲染
  await heldPXA.entered;
  await ppx.locator('#itlInspNew').click();await ppx.locator('#itlModal.open').waitFor();
  await ppx.locator('select[name="room_name"]').selectOption('SF-RoomPXB');
  await ppx.locator('#itlSubmit').click(); // 提交——撞409 SHEET_DRAFT_EXISTS
  await ppx.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='该机房已有草稿',null,{timeout:5000});
  await ppx.locator('#itlSubmit').click(); // "打开该草稿"——offerExistingDraft成功分支
  await ppx.locator('[data-sheet-id="'+draftPXB.id+'"]').waitFor();
  check('PX准备:经"打开该草稿"B的填写页已显示',await ppx.locator('[data-sheet-id="'+draftPXB.id+'"]').count()===1);
  const settledBeforePX=await ppx.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const respondedPX=ppx.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+draftPXA.id)&&r.request().method()==='GET');
  heldPXA.release(); // 放行A的GET——200成功响应迟到
  await respondedPX;
  // openDraftByIdFresh每条分支都会自增__inspLoadSettled(含丢弃分支)——确定性信号，等它+1即等到A这次
  // 迟到GET的discard判断已经跑完。
  await ppx.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforePX,{timeout:5000});
  check('PX(MED-1必修):A迟到的200放行后仍停在B(data-sheet-id仍是B,A未出现)',await ppx.locator('[data-sheet-id="'+draftPXB.id+'"]').count()===1&&await ppx.locator('[data-sheet-id="'+draftPXA.id+'"]').count()===0);
  check('浏览器无未捕获异常(PX)',errorsPX.length===0);
  await cpx.close();

  // AV) S-H4（方案必做4，43S H4，新增用例）：采集期间(采集POST在飞行中)另一个操作者改了备注——采集
  // 完成后的重取(applyFreshMerge)应该让本地未改的备注采纳服务器最新值，下次保存不会把旧备注当"本地
  // 脏数据"回滚对方的修改。
  const overridesAV={};
  const HOST_AV='203.0.113.15';
  const collectorAV={host:()=>HOST_AV,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_AV,server:{name:'srv',manufacturer:'x',model:'y',serial_number:overridesAV.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:now,completed_at:now};}};
  const fAV=await createFixture({inspectionCollector:collectorAV});
  let cav1;
  try {
    const rackAV=(await fAV.api('POST','/racks',{name:'SF-RoomCollectRemark-柜1',room:'SF-RoomCollectRemark',u_total:20})).body;
    overridesAV.sn='SN-COLLECT-AV-01';
    await fAV.api('POST','',{category:'server',name:'SF-RoomCollectRemark-设备1',sn:overridesAV.sn,attrs:{ip:HOST_AV},u_height:1,placement:{kind:'rack',rack_id:rackAV.id,u_start:1}});
    const createdAV=await fAV.api('POST','/inspections/sheets',{room_name:'SF-RoomCollectRemark'},2);
    assert.equal(createdAV.status,201,'AV create '+JSON.stringify(createdAV.body));
    const deviceItemAV=createdAV.body.items.find(it=>it.section==='device');
    const airconAV=createdAV.body.items.find(it=>it.item_key==='aircon');
    const errorsAV=[];
    cav1=await browser.newContext();await cav1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pav=await cav1.newPage();pav.on('pageerror',e=>errorsAV.push(e.message));
    await pav.goto(fAV.base+'/IT_Ledger.html#inspections');await pav.locator('[data-insp-row="'+createdAV.body.id+'"]').waitFor();
    await pav.locator('[data-insp-continue="'+createdAV.body.id+'"]').click();await pav.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pav);
    const heldCollectAV=holdRequestRoute(pav,'**/api/it-assets/inspections/sheets/'+createdAV.body.id+'/items/'+deviceItemAV.id+'/collect','POST');
    await pav.locator('[data-collect-id="'+deviceItemAV.id+'"]').click();
    await heldCollectAV.entered; // 采集POST已发出、被挂住
    const otherPutAV=await fAV.api('PUT','/inspections/sheets/'+createdAV.body.id,{expected_version:createdAV.body.version,remark:'别处写的备注(采集期间)'},2);
    assert.equal(otherPutAV.status,200,'AV other put '+JSON.stringify(otherPutAV.body));
    heldCollectAV.release();
    await pav.locator('#itlToast:not([hidden])').waitFor();
    check('AV(S-H4):采集完成后备注取了服务器最新值(采集期间他人改的备注)',(await pav.locator('#itlFormRemark').inputValue())==='别处写的备注(采集期间)');
    const putBodiesAV=[];pav.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+createdAV.body.id)){try{putBodiesAV.push(r.postDataJSON());}catch(_e){putBodiesAV.push(null);}}});
    const settledBeforeAV=await pav.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pav.locator('[data-seg-ok="'+airconAV.id+'"]').click(); // 顺手编辑一项，触发下一次保存
    await pav.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeAV);
    const lastPutAV=putBodiesAV[putBodiesAV.length-1];
    check('AV(S-H4):下一次保存的请求体不含remark字段(备注本身未被本地改动,不会被当脏数据发回去覆盖)',!Object.hasOwn(lastPutAV,'remark'),lastPutAV);
    const finalGetAV=await fAV.api('GET','/inspections/sheets/'+createdAV.body.id,undefined,2);
    check('AV(S-H4):服务端备注仍是"别处写的备注"(未被回滚)',finalGetAV.body.remark==='别处写的备注(采集期间)',finalGetAV.body);
    check('浏览器无未捕获异常(AV)',errorsAV.length===0);
  } finally {
    if (cav1) await cav1.close();
    await fAV.close();
  }

  // AZ) M1（Opus预筛必修，新增用例，spec-C5a-e.md §4）：采集重取——采集前的冲刷以非409失败(前提，prescreen
  // 原句)，本地正在编辑的这一项带着dirty状态进入performCollect自己的GET重取；重取发现别的操作者已经
  // 直接把这一项改成了不同于旧基线的值——应该标成真实冲突(conflictIds+高亮+lastFlushOk=false)，不是
  // 像旧版applyFreshMerge那样悄悄保留本地值、不给任何提示（M1原句"本地脏且服务器新值≠旧基线的项标
  // 冲突"）。
  const overridesAZ={};
  const HOST_AZ='203.0.113.17';
  const collectorAZ={host:()=>HOST_AZ,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_AZ,server:{name:'srv',manufacturer:'x',model:'y',serial_number:overridesAZ.sn,os:'Windows',memory_bytes:0,cpus:[]},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:now,completed_at:now};}};
  const fAZ=await createFixture({inspectionCollector:collectorAZ});
  let caz;
  try {
    const rackAZ=(await fAZ.api('POST','/racks',{name:'SF-RoomCollectConflict-柜1',room:'SF-RoomCollectConflict',u_total:20})).body;
    overridesAZ.sn='SN-COLLECT-AZ-01';
    await fAZ.api('POST','',{category:'server',name:'SF-RoomCollectConflict-设备1',sn:overridesAZ.sn,attrs:{ip:HOST_AZ},u_height:1,placement:{kind:'rack',rack_id:rackAZ.id,u_start:1}});
    const createdAZ=await fAZ.api('POST','/inspections/sheets',{room_name:'SF-RoomCollectConflict'},2);
    assert.equal(createdAZ.status,201,'AZ create '+JSON.stringify(createdAZ.body));
    const deviceItemAZ=createdAZ.body.items.find(it=>it.section==='device');
    const airconAZ=createdAZ.body.items.find(it=>it.item_key==='aircon');
    const errorsAZ=[];
    caz=await browser.newContext();await caz.addInitScript(()=>localStorage.setItem('token','fixture-2'));const paz=await caz.newPage();paz.on('pageerror',e=>errorsAZ.push(e.message));
    await paz.goto(fAZ.base+'/IT_Ledger.html#inspections');await paz.locator('[data-insp-row="'+createdAZ.body.id+'"]').waitFor();
    await paz.locator('[data-insp-continue="'+createdAZ.body.id+'"]').click();await paz.locator('#itlFormActionbar').waitFor();await expandInspectionForm(paz);
    // 采集前的冲刷以非409失败——这是M1前提：让这张单的PUT恒失败(网络异常)，本地脏项无法通过冲刷落定，
    // 会带着dirty状态进入performCollect自己的重取。
    await paz.route('**/api/it-assets/inspections/sheets/'+createdAZ.body.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
    await paz.locator('[data-seg-ok="'+airconAZ.id+'"]').click(); // 本地把aircon标正常(脏)
    // 另一个操作者直接改了同一项(绕开会失败的浏览器路由，走后端API直连)——服务端此刻aircon已经是bad。
    const otherPutAZ=await fAZ.api('PUT','/inspections/sheets/'+createdAZ.body.id,{expected_version:createdAZ.body.version,items:[{id:airconAZ.id,result:'bad',number_value:null,note:'别处已修改(采集期间)'}]},2);
    assert.equal(otherPutAZ.status,200,'AZ other put '+JSON.stringify(otherPutAZ.body));
    await paz.locator('[data-collect-id="'+deviceItemAZ.id+'"]').click();
    await paz.locator('#itlToast:not([hidden])').waitFor(); // 采集POST本身成功(与失败的PUT路由无关的独立端点)
    await paz.waitForFunction(id=>{const el=document.querySelector('[data-collect-id="'+id+'"]');return el&&!el.disabled;},deviceItemAZ.id,{timeout:5000}); // 等采集彻底落定解锁
    check('AZ(M1):采集重取发现别的操作者真的改了本地正在编辑的这一项——标成真实冲突(高亮)',await paz.locator('[data-item-id="'+airconAZ.id+'"].itl-sheet-conflict').count()===1);
    check('AZ(M1):冲突高亮的同时,本地值(正常)没有被服务器的fresh值(异常)悄悄覆盖',await paz.locator('[data-seg-ok="'+airconAZ.id+'"].on-ok').count()===1);
    check('AZ(M1):提交按钮因为这条真实冲突而不可点(lastFlushOk=false)',await paz.locator('#itlFormSubmit[disabled]').count()===1);
    check('浏览器无未捕获异常(AZ)',errorsAZ.length===0);
  } finally {
    if (caz) await caz.close();
    await fAZ.close();
  }

  // BA) M3（Opus预筛必修，AB-2补强，新增用例）：只有队列、没有表单会话——从列表行直接删除草稿(不经过
  // 表单)，DELETE挂起期间beforeunload仍应拦(queuesBySheetId非空)；去掉AB判据里的
  // "||queuesBySheetId.size>0"，本用例首先变红(此刻form本就是null，只看form端不会拦)。
  const draftBA=await buildDraftSheet('SF-RoomQueueOnlyUnload',2);
  const cba=await browser.newContext();await cba.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pba=await cba.newPage();const errorsBA=[];pba.on('pageerror',e=>errorsBA.push(e.message));
  await pba.goto(f.base+'/IT_Ledger.html#inspections');await pba.locator('[data-insp-row="'+draftBA.id+'"]').waitFor();
  const heldBA=holdRequestRoute(pba,'**/api/it-assets/inspections/sheets/'+draftBA.id,'DELETE');
  await pba.locator('[data-insp-delete-draft="'+draftBA.id+'"]').click();
  await pba.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿');
  await pba.locator('#itlSubmit').click(); // 确认删除——DELETE挂起中
  await heldBA.entered;
  const preventedBA=await pba.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('BA(M3):没有打开表单(form为null)、只有队列在跑(DELETE挂起中),beforeunload仍拦',preventedBA===true,preventedBA);
  heldBA.release();
  await pba.locator('#itlToast:not([hidden])').waitFor();
  const preventedAfterBA=await pba.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('BA(M3):队列落定清空后beforeunload不再拦',preventedAfterBA===false,preventedAfterBA);
  check('浏览器无未捕获异常(BA)',errorsBA.length===0);
  await cba.close();

  // BB) M5（Opus预筛必修，新增用例）：冲突后把冲突项点回服务器值→空冲刷→标记清除、提交按钮恢复。先把
  // 整单填满（服务端progress.complete=true），确保之后"提交按钮是否可点"这条断言测的是
  // 冲突/未保存这一件事，不会被"字段没填完"这个无关阻塞混进来。
  const draftBB=await buildDraftSheet('SF-RoomReconcileEmpty',2);
  const filledBB=fillPayloadAllOk(draftBB.items);
  const putBB0=await f.api('PUT','/inspections/sheets/'+draftBB.id,{expected_version:draftBB.version,items:filledBB},2);
  assert.equal(putBB0.status,200,'BB initial fill put '+JSON.stringify(putBB0.body));
  await uploadAllRackFrontPhotos(draftBB.id,draftBB.scope,2);
  const airconBB=putBB0.body.items.find(it=>it.item_key==='aircon'); // 此刻服务端是'ok'(全部正常填法)
  const cbb=await browser.newContext();await cbb.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbb=await cbb.newPage();const errorsBB=[];pbb.on('pageerror',e=>errorsBB.push(e.message));
  await pbb.goto(f.base+'/IT_Ledger.html#inspections');await pbb.locator('[data-insp-row="'+draftBB.id+'"]').waitFor();
  await pbb.locator('[data-insp-continue="'+draftBB.id+'"]').click();await pbb.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbb);
  check('BB准备:进表单时字段已齐全,提交按钮此刻可点(complete=true)',await pbb.locator('#itlFormSubmit[disabled]').count()===0);
  const heldBB=holdRequestRoute(pbb,'**/api/it-assets/inspections/sheets/'+draftBB.id,'PUT');
  await pbb.locator('[data-seg-bad="'+airconBB.id+'"]').click(); // 本地改成异常（真实1.5秒防抖）
  await heldBB.entered;
  const otherPutBB=await f.api('PUT','/inspections/sheets/'+draftBB.id,{expected_version:putBB0.body.version,items:[{id:airconBB.id,result:'ok',number_value:null,note:null}]},2); // 别处仍改回'正常'——与本地分歧
  assert.equal(otherPutBB.status,200,'BB other put '+JSON.stringify(otherPutBB.body));
  const settledBeforeConflictBB=await pbb.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldBB.release(); // 放行：这次PUT撞409→handleConflict合并
  await pbb.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeConflictBB);
  check('BB准备:冲突高亮已出现',await pbb.locator('[data-item-id="'+airconBB.id+'"].itl-sheet-conflict').count()===1);
  check('BB准备:提交按钮因冲突不可点',await pbb.locator('#itlFormSubmit[disabled]').count()===1);
  // 把冲突项点回服务器此刻的值(正常)——working与detail重新一致，不再脏；接下来的自动保存是"空冲刷"。
  const settledBeforeReconcileBB=await pbb.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbb.locator('[data-seg-ok="'+airconBB.id+'"]').click();
  await pbb.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeReconcileBB); // 空冲刷落定
  check('BB(M5):点回服务器值后空冲刷落定,冲突高亮被清除',await pbb.locator('[data-item-id="'+airconBB.id+'"].itl-sheet-conflict').count()===0);
  check('BB(M5):提交按钮恢复可点(lastFlushOk重置为true,不再被冲突残留卡住,字段仍齐全)',await pbb.locator('#itlFormSubmit[disabled]').count()===0);
  check('浏览器无未捕获异常(BB)',errorsBB.length===0);
  await cbb.close();

  // BC) M2（spec-C5a-e.md §必做1第2条，新增用例）：离开时若已经带着冲突标记(conflictIds)的项——离开
  // 冲刷的PUT请求体不应该包含这些冲突项(不用本地值覆盖对方还没被核对过的修改)，只发其余真正的脏项。
  const draftBC=await buildDraftSheet('SF-RoomLeaveExcludeConflict',2);
  const airconBC=draftBC.items.find(it=>it.item_key==='aircon');
  const upsBC=draftBC.items.find(it=>it.item_key==='ups');
  const cbc=await browser.newContext();await cbc.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbc=await cbc.newPage();const errorsBC=[];pbc.on('pageerror',e=>errorsBC.push(e.message));
  await pbc.goto(f.base+'/IT_Ledger.html#inspections');await pbc.locator('[data-insp-row="'+draftBC.id+'"]').waitFor();
  await installNoticeCounter(pbc); // M5(C5a-f)
  await pbc.locator('[data-insp-continue="'+draftBC.id+'"]').click();await pbc.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbc);
  const heldBC=holdRequestRoute(pbc,'**/api/it-assets/inspections/sheets/'+draftBC.id,'PUT');
  await pbc.locator('[data-seg-ok="'+airconBC.id+'"]').click(); // 本地改aircon（真实1.5秒防抖）
  await heldBC.entered;
  const otherPutBC=await f.api('PUT','/inspections/sheets/'+draftBC.id,{expected_version:draftBC.version,items:[{id:airconBC.id,result:'bad',number_value:null,note:'别处已改'}]},2);
  assert.equal(otherPutBC.status,200,'BC other put '+JSON.stringify(otherPutBC.body));
  const settledBeforeConflictBC=await pbc.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldBC.release(); // 放行：撞409→handleConflict→aircon进conflictIds
  await pbc.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeConflictBC);
  check('BC准备:aircon已带冲突标记',await pbc.locator('[data-item-id="'+airconBC.id+'"].itl-sheet-conflict').count()===1);
  // 不解决冲突，另外编辑一个不相关的项(ups)，制造"冲突项+新脏项"并存的局面，再立即离开——不给自然
  // 1.5秒防抖机会先把它当普通冲刷发出去(普通冲刷不带excludeConflicts，会把aircon也一起带上，混淆
  // 本用例要证明的东西)。
  const putBodiesBC=[];pbc.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftBC.id)){try{putBodiesBC.push(r.postDataJSON());}catch(_e){putBodiesBC.push(null);}}});
  // 基线必须在触发leaveForm之前取（同AU/AA等既有用例的写法）——本地服务器响应很快，若在"#itlFormBack"
  // 点击之后、列表渲染完成之后才取基线，离开冲刷可能已经落定过一次，等的是永远不会再来的下一次增量，
  // 会一直挂到超时（本块首次落笔时踩过这个坑，按既有惯用手法改写）。
  const settledBeforeLeaveBC=await pbc.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  // M5(C5a-f)：从这里(真正触发离开动作之前)开始数——前面为制造冲突标记走过一次handleConflict可见分支
  // 通知，不算在"离开"这一步的计数里。
  const noticeBaselineBC=await noticeCallsLength(pbc);
  await pbc.locator('[data-seg-bad="'+upsBC.id+'"]').click();
  await pbc.locator('#itlFormBack').click(); // 触发leaveForm——立即clearTimeout+排一次离开冲刷(excludeConflicts:true)
  await pbc.locator('[data-insp-row]').first().waitFor();
  await pbc.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeLeaveBC,{timeout:5000});
  const lastPutBC=putBodiesBC[putBodiesBC.length-1];
  check('BC(M2):离开冲刷的请求体存在(确实发出了一次PUT)',!!lastPutBC,lastPutBC);
  check('BC(M2):离开冲刷请求体不包含带冲突标记的aircon项',!!lastPutBC&&(!lastPutBC.items||!lastPutBC.items.some(it=>it.id===airconBC.id)),lastPutBC);
  check('BC(M2):离开冲刷请求体包含真正的脏项ups(未被一并挡住)',!!lastPutBC&&!!lastPutBC.items&&lastPutBC.items.some(it=>it.id===upsBC.id&&it.result==='bad'),lastPutBC);
  const serverBC=await getSheet(draftBC.id,2);
  check('BC(M2):服务端确认ups已落库为异常(离开冲刷确实发出且成功)',serverBC.body.items.find(it=>it.id===upsBC.id).result==='bad',serverBC.body);
  check('BC(M2):服务端确认aircon仍是别处写的值(bad)——没有被本地冲突值(ok)覆盖回去',serverBC.body.items.find(it=>it.id===airconBC.id).result==='bad',serverBC.body);
  // C5a-e2（必修1，用例②"冲突项+非冲突项离开"）：非冲突项(ups)保存成功了，但被排除的冲突项(aircon)
  // 依然没有保存——成功分支也要给常驻提示，只列被排除的那一项，不是所有脏项。
  const noticeTextBC=await pbc.locator('#itlNotice').innerText();
  check('BC(N-L6):notice是短句"有内容未能保存，详见巡检台账顶部"',noticeTextBC==='巡检单〈'+sheetLabelStr(draftBC)+'〉有内容未能保存，详见巡检台账顶部。',noticeTextBC);
  const unsavedListBC=await pbc.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBC.id+'"]').innerText();
  check('BC(必修1，用例②，N-L6迁到常驻条+MED-3逐项原因):离开冲刷成功后常驻条只列被排除的冲突项(aircon/空调运行)与"（原因：与他人修改冲突）"',unsavedListBC.includes(sheetLabelStr(draftBC))&&unsavedListBC.includes('（原因：与他人修改冲突）')&&unsavedListBC.includes('空调运行'),unsavedListBC);
  check('BC(M5，C5a-f新增):离开这一步的"离开失败/冲突"类提示恰好调用1次(不含前面制造冲突标记那一条)',await leaveOrConflictNoticeCount(pbc,noticeBaselineBC)===1,await pbc.evaluate(()=>window.__noticeCalls));
  check('浏览器无未捕获异常(BC)',errorsBC.length===0);
  await cbc.close();

  // BD) C5a-e2 必修1，用例①：冲突后只改冲突项本身再离开(不碰任何其它项)——过滤后没有非冲突脏数据可
  // 发，performFlush 走早退分支，零PUT；但被排除的冲突项依然没有保存，早退分支也要给常驻提示。
  const draftBD=await buildDraftSheet('SF-RoomLeaveOnlyConflict',2);
  const airconBD=draftBD.items.find(it=>it.item_key==='aircon');
  const cbd=await browser.newContext();await cbd.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbd=await cbd.newPage();const errorsBD=[];pbd.on('pageerror',e=>errorsBD.push(e.message));
  await pbd.goto(f.base+'/IT_Ledger.html#inspections');await pbd.locator('[data-insp-row="'+draftBD.id+'"]').waitFor();
  await installNoticeCounter(pbd); // M5(C5a-f)
  await pbd.locator('[data-insp-continue="'+draftBD.id+'"]').click();await pbd.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbd);
  const heldBD=holdRequestRoute(pbd,'**/api/it-assets/inspections/sheets/'+draftBD.id,'PUT');
  await pbd.locator('[data-seg-ok="'+airconBD.id+'"]').click();
  await heldBD.entered;
  const otherPutBD=await f.api('PUT','/inspections/sheets/'+draftBD.id,{expected_version:draftBD.version,items:[{id:airconBD.id,result:'bad',number_value:null,note:'别处已改'}]},2);
  assert.equal(otherPutBD.status,200,'BD other put '+JSON.stringify(otherPutBD.body));
  const settledBeforeConflictBD=await pbd.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldBD.release(); // 放行：撞409→handleConflict→aircon进conflictIds，working仍是本地的'ok'
  await pbd.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeConflictBD);
  check('BD准备:aircon已带冲突标记',await pbd.locator('[data-item-id="'+airconBD.id+'"].itl-sheet-conflict').count()===1);
  // 不碰任何其它项，立即离开——离开冲刷过滤后 items 为空（唯一的脏项就是被排除的aircon），走早退分支。
  let putCountBD=0;pbd.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftBD.id))putCountBD++;});
  const settledBeforeLeaveBD=await pbd.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  const noticeBaselineBD=await noticeCallsLength(pbd); // M5(C5a-f)：从这里开始数，不含前面制造冲突的那一条
  await pbd.locator('#itlFormBack').click();
  await pbd.locator('[data-insp-row]').first().waitFor();
  await pbd.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeLeaveBD,{timeout:5000});
  check('BD(必修1，用例①):离开冲刷走早退分支,零PUT(唯一的脏项是被排除的冲突项,过滤后没有可发的内容)',putCountBD===0,putCountBD);
  const noticeTextBD=await pbd.locator('#itlNotice').innerText();
  check('BD(H2):无请求的早退先于列表渲染,一次性提示含完整原文',noticeTextBD.includes('巡检单〈'+sheetLabelStr(draftBD)+'〉有内容未能保存：')&&noticeTextBD.includes('空调运行：正常')&&!noticeTextBD.includes('详见巡检台账顶部'),noticeTextBD);
  const unsavedListBD=await pbd.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBD.id+'"]').innerText();
  check('BD(必修1，用例①，N-L6迁到常驻条+MED-3逐项原因):早退分支仍给出常驻条,含被排除项原文(空调运行：正常)与"（原因：与他人修改冲突）"',unsavedListBD.includes(sheetLabelStr(draftBD))&&unsavedListBD.includes('（原因：与他人修改冲突）')&&unsavedListBD.includes('空调运行：正常'),unsavedListBD);
  check('BD(M5，C5a-f新增):离开这一步的"离开失败/冲突"类提示恰好调用1次',await leaveOrConflictNoticeCount(pbd,noticeBaselineBD)===1,await pbd.evaluate(()=>window.__noticeCalls));
  const serverBD=await getSheet(draftBD.id,2);
  check('BD(必修1，用例①):服务端确认aircon仍是别处写的值(bad)——零PUT意味着完全没有尝试覆盖',serverBD.body.items.find(it=>it.id===airconBD.id).result==='bad',serverBD.body);
  check('浏览器无未捕获异常(BD)',errorsBD.length===0);
  await cbd.close();

  // BE) C5a-e2 必修1，用例③：备注冲突同理——只有总体备注带冲突标记(remarkConflict)，不碰任何检查项，
  // 立即离开——过滤后 remarkChanged 为 false、items 为空，走早退分支，常驻提示含"备注：<原文>"。
  const draftBE=await buildDraftSheet('SF-RoomLeaveRemarkConflict',2);
  const cbe=await browser.newContext();await cbe.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbe=await cbe.newPage();const errorsBE=[];pbe.on('pageerror',e=>errorsBE.push(e.message));
  await pbe.goto(f.base+'/IT_Ledger.html#inspections');await pbe.locator('[data-insp-row="'+draftBE.id+'"]').waitFor();
  await installNoticeCounter(pbe); // M5(C5a-f)
  await pbe.locator('[data-insp-continue="'+draftBE.id+'"]').click();await pbe.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbe);
  const heldBE=holdRequestRoute(pbe,'**/api/it-assets/inspections/sheets/'+draftBE.id,'PUT');
  await pbe.locator('#itlFormRemark').fill('本地备注BE');
  await heldBE.entered;
  const otherPutBE=await f.api('PUT','/inspections/sheets/'+draftBE.id,{expected_version:draftBE.version,remark:'别处写的备注BE'},2);
  assert.equal(otherPutBE.status,200,'BE other put '+JSON.stringify(otherPutBE.body));
  const settledBeforeConflictBE=await pbe.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  heldBE.release(); // 放行：撞409→handleConflict→remarkConflict=true，remarkWorking仍是本地的"本地备注BE"
  await pbe.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeConflictBE);
  check('BE准备:备注已带冲突标记',await pbe.locator('.itl-sheet-remark-edit.itl-sheet-conflict').count()===1);
  let putCountBE=0;pbe.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftBE.id))putCountBE++;});
  const settledBeforeLeaveBE=await pbe.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  const noticeBaselineBE=await noticeCallsLength(pbe); // M5(C5a-f)：从这里开始数，不含前面制造冲突的那一条
  await pbe.locator('#itlFormBack').click();
  await pbe.locator('[data-insp-row]').first().waitFor();
  await pbe.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeLeaveBE,{timeout:5000});
  check('BE(必修1，用例③):离开冲刷走早退分支,零PUT(唯一的脏数据是被排除的冲突备注)',putCountBE===0,putCountBE);
  const noticeTextBE=await pbe.locator('#itlNotice').innerText();
  check('BE(H2):无请求的早退先于列表渲染,一次性提示含完整备注',noticeTextBE.includes('巡检单〈'+sheetLabelStr(draftBE)+'〉有内容未能保存：')&&noticeTextBE.includes('备注：本地备注BE')&&!noticeTextBE.includes('详见巡检台账顶部'),noticeTextBE);
  const unsavedListBE=await pbe.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBE.id+'"]').innerText();
  check('BE(必修1，用例③，N-L6迁到常驻条+MED-3逐项原因):早退分支给出常驻条,含"备注：本地备注BE"与"（原因：与他人修改冲突）"',unsavedListBE.includes(sheetLabelStr(draftBE))&&unsavedListBE.includes('（原因：与他人修改冲突）')&&unsavedListBE.includes('备注：本地备注BE'),unsavedListBE);
  check('BE(M5，C5a-f新增):离开这一步的"离开失败/冲突"类提示恰好调用1次',await leaveOrConflictNoticeCount(pbe,noticeBaselineBE)===1,await pbe.evaluate(()=>window.__noticeCalls));
  const serverBE=await getSheet(draftBE.id,2);
  check('BE(必修1，用例③):服务端确认备注仍是别处写的值——零PUT意味着完全没有尝试覆盖',serverBE.body.remark==='别处写的备注BE',serverBE.body.remark);
  check('浏览器无未捕获异常(BE)',errorsBE.length===0);
  await cbe.close();

  // BF) H1+H2 用例①（C5a-f新增，spec-C5a-f.md）：采集+冲刷挂起→返回→冲刷中断（网络异常）→采集分
  // 失败、成功两种；最终巡检台账顶部常驻条含原文。构造：编辑aircon(脏)→点采集(doCollect排队"冲刷+
  // 采集"两个任务)→冲刷的PUT被挂住→立即"返回"(leaveForm：会话销毁+因冲刷还没落定,hasUnsavedWork仍
  // 真,再排第三个任务"离开冲刷(excludeConflicts)")→放行PUT(abort，网络异常)→冲刷任务落在已销毁会话
  // 上，notifyLeaveFlushFailure登记表+一次即时提醒→队列接着跑采集任务(按用例分支fulfill成功/abort
  // 失败)→采集自己的notifyOutcome把#itlNotice覆盖成采集结果文案(证明共享槽位确实会被后来的提示覆盖，
  // 这正是旧H1的病根)→第三个任务(leaveForm自己排的离开冲刷)撞见f.destroyed&&f.leaveFailureNotified
  // 短路，不再发。断言：#itlNotice最终是采集结果(不是离开失败原文)，但#itlUnsavedList这个登记表自己
  // 的常驻条依然完整保留原文——H1把原文换了个不受#itlNotice覆盖影响的载体，这条用例直接证明这一点。
  async function runBF(nameSuffix,collectOutcome,collectExpectSubstr){
    const draftBF=await buildDraftSheet('SF-RoomBF'+nameSuffix,2);
    const airconBF=draftBF.items.find(it=>it.item_key==='aircon');
    const deviceItemBF=draftBF.items.find(it=>it.section==='device');
    const cbf=await browser.newContext();await cbf.addInitScript(()=>localStorage.setItem('token','fixture-2'));
    const pbf=await cbf.newPage();const errorsBF=[];pbf.on('pageerror',e=>errorsBF.push(e.message));
    await pbf.goto(f.base+'/IT_Ledger.html#inspections');await pbf.locator('[data-insp-row="'+draftBF.id+'"]').waitFor();
    await installNoticeCounter(pbf); // M5(C5a-f)：BF场景本身就是"离开"这一步，从页面加载起计数即可
    await pbf.locator('[data-insp-continue="'+draftBF.id+'"]').click();await pbf.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbf);
    let enteredPutBF,releasePutBF;const enteredPutBFP=new Promise(r=>enteredPutBF=r),heldPutBFP=new Promise(r=>releasePutBF=r);
    await pbf.route('**/api/it-assets/inspections/sheets/'+draftBF.id,async route=>{
      if(route.request().method()!=='PUT')return route.fallback();
      enteredPutBF();await heldPutBFP;await route.abort('failed');
    });
    await pbf.route('**/api/it-assets/inspections/sheets/'+draftBF.id+'/items/'+deviceItemBF.id+'/collect',async route=>{
      if(collectOutcome==='success')await route.fulfill({status:201,contentType:'application/json',body:JSON.stringify({})});
      else await route.abort('failed');
    });
    await pbf.locator('[data-seg-ok="'+airconBF.id+'"]').click(); // 制造脏数据
    await pbf.locator('[data-collect-id="'+deviceItemBF.id+'"]').click(); // doCollect: enqueue(冲刷)+enqueue(采集)
    await enteredPutBFP; // 等冲刷的PUT真的发出、被挂住
    const settledBeforeBF=await pbf.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pbf.locator('#itlFormBack').click(); // 触发leaveForm——冲刷还没落定,hasUnsavedWork仍真,排第三个任务
    await pbf.locator('[data-insp-row]').first().waitFor();
    releasePutBF(); // 放行：冲刷PUT网络异常——落在已销毁会话上，notifyLeaveFlushFailure
    // 等两次performFlush落定(冲刷本身失败1次+leaveForm自己排的那次短路1次)——中间队列会先跑完采集任务。
    await pbf.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+2,settledBeforeBF,{timeout:5000});
    const noticeTextBF=await pbf.locator('#itlNotice').innerText();
    check('BF-'+nameSuffix+'(H1①):最终#itlNotice是采集这一步的结果文案("'+collectExpectSubstr+'")且带登记表指引后缀,不再是离开失败原文本身(共享槽位确实被后来的提示覆盖)',noticeTextBF.includes(collectExpectSubstr)&&noticeTextBF.includes(sheetLabelStr(draftBF))&&noticeTextBF.includes('该单另有未保存内容，见巡检台账顶部'),noticeTextBF);
    if(nameSuffix==='Fail')check('BF-Fail(N-M3新增):采集失败的原因走mapFailureReason短语,不含诱导刷新的"重新打开页面"（预筛Q5同款场景）',!noticeTextBF.includes('重新打开页面'),noticeTextBF);
    const unsavedEntryBF=await pbf.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBF.id+'"]').innerText();
    check('BF-'+nameSuffix+'(H1①，必修):共享槽位被覆盖之后，巡检台账顶部常驻条(登记表自己的载体)仍含原文"空调运行：正常"',unsavedEntryBF.includes(sheetLabelStr(draftBF))&&unsavedEntryBF.includes('空调运行：正常'),unsavedEntryBF);
    check('BF-'+nameSuffix+'(M5，C5a-f新增):"离开失败/冲突"类提示恰好调用1次(采集自己的提示不匹配这个过滤器,不重复计入)',await leaveOrConflictNoticeCount(pbf)===1,await pbf.evaluate(()=>window.__noticeCalls));
    check('浏览器无未捕获异常(BF-'+nameSuffix+')',errorsBF.length===0);
    await cbf.close();
  }
  await runBF('Fail','fail','采集失败');
  await runBF('Ok','success','已采集完成');

  // BG) H1+H2 用例②（C5a-f新增）：离开失败→切到机柜→推过11秒再切回巡检→常驻条仍在且含原文；再打开
  // 该单，表单顶部也有；点"知道了"后两处都消失。这条直接证明"共享层autoRefresh的notice('')清空"（H2
  // 病根之二）不再影响登记表驱动的常驻条。
  const draftBG=await buildDraftSheet('SF-RoomBG',2);
  const airconBG=draftBG.items.find(it=>it.item_key==='aircon');
  const cbg=await browser.newContext();await cbg.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbg=await cbg.newPage();const errorsBG=[];pbg.on('pageerror',e=>errorsBG.push(e.message));
  await pbg.goto(f.base+'/IT_Ledger.html#inspections');await pbg.locator('[data-insp-row="'+draftBG.id+'"]').waitFor();
  await pbg.clock.install();
  await pbg.locator('[data-insp-continue="'+draftBG.id+'"]').click();await pbg.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbg);
  await pbg.route('**/api/it-assets/inspections/sheets/'+draftBG.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  const settledBeforeBG=await pbg.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbg.locator('[data-seg-ok="'+airconBG.id+'"]').click(); // 制造脏数据
  await pbg.evaluate(()=>{location.hash='racks';}); // 触发onLeave→leaveForm：会话同步销毁+排一次离开冲刷（网络异常）
  await pbg.locator('.itl-rack-workspace').waitFor();
  await pbg.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeBG,{timeout:5000}); // 等离开冲刷落定(失败)
  const unsavedListJustAfterBG=await pbg.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBG.id+'"]').count();
  check('BG准备:此刻还没切回巡检页签,#itlUnsavedList这个容器根本不在DOM里(机柜视图)',unsavedListJustAfterBG===0,unsavedListJustAfterBG);
  await pbg.clock.fastForward(11000); // 推过10秒autoRefresh节流窗口
  await pbg.evaluate(()=>{location.hash='inspections';}); // 切回巡检——触发autoRefresh：notice('')清空#itlNotice+真实刷新
  await pbg.locator('[data-insp-row]').first().waitFor({timeout:15000});
  const noticeTextAfterRefreshBG=await pbg.locator('#itlNotice').innerText().catch(()=>'');
  const noticeHiddenAfterRefreshBG=await pbg.locator('#itlNotice[hidden]').count();
  check('BG(H2)：切回巡检页签触发autoRefresh后,#itlNotice确实被共享层清空(hidden或空)',noticeHiddenAfterRefreshBG===1||noticeTextAfterRefreshBG==='',{noticeTextAfterRefreshBG,noticeHiddenAfterRefreshBG});
  const unsavedListTextBG=await pbg.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBG.id+'"]').innerText();
  check('BG(H2，必修)：#itlNotice被autoRefresh清空之后,巡检台账顶部常驻条依然在且含原文"空调运行：正常"',unsavedListTextBG.includes(sheetLabelStr(draftBG))&&unsavedListTextBG.includes('空调运行：正常'),unsavedListTextBG);
  await pbg.locator('[data-insp-continue="'+draftBG.id+'"]').click(); // 再打开该单
  await pbg.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbg);
  const unsavedFormTextBG=await pbg.locator('#itlUnsavedForm [data-unsaved-sheet="'+draftBG.id+'"]').innerText();
  check('BG(H1+H2，必修)：重开该单的填写页顶部也显示"上次离开时未保存"的同一份原文',unsavedFormTextBG.includes(sheetLabelStr(draftBG))&&unsavedFormTextBG.includes('空调运行：正常'),unsavedFormTextBG);
  await pbg.locator('#itlUnsavedForm [data-unsaved-ack="'+draftBG.id+'"]').click(); // 点"知道了"
  const unsavedFormCountAfterAckBG=await pbg.locator('#itlUnsavedForm [data-unsaved-sheet="'+draftBG.id+'"]').count();
  check('BG(H1+H2)：点"知道了"后表单顶部这处立即消失',unsavedFormCountAfterAckBG===0,unsavedFormCountAfterAckBG);
  await pbg.locator('#itlFormBack').click(); // 返回列表（此刻这张单没有任何未保存修改，返回不会再触发新的离开冲刷通知）
  await pbg.locator('[data-insp-row]').first().waitFor();
  const unsavedListCountAfterAckBG=await pbg.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBG.id+'"]').count();
  check('BG(H1+H2，必修)：点"知道了"确实从登记表删除了条目——回到列表后那处也不再出现（不是两处各自独立隐藏，是同一份数据源真的被清除）',unsavedListCountAfterAckBG===0,unsavedListCountAfterAckBG);
  check('浏览器无未捕获异常(BG)',errorsBG.length===0);
  await cbg.close();

  // BH) H1+H2 用例③（C5a-f新增）：登记表非空时beforeunload也拦截——即便当前没有打开任何表单会话、
  // 写队列也已经空了(不满足旧判据 dirty||queuesBySheetId.size>0)。
  const draftBH=await buildDraftSheet('SF-RoomBH',2);
  const airconBH=draftBH.items.find(it=>it.item_key==='aircon');
  const cbh=await browser.newContext();await cbh.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbh=await cbh.newPage();const errorsBH=[];pbh.on('pageerror',e=>errorsBH.push(e.message));
  await pbh.goto(f.base+'/IT_Ledger.html#inspections');await pbh.locator('[data-insp-row="'+draftBH.id+'"]').waitFor();
  await pbh.locator('[data-insp-continue="'+draftBH.id+'"]').click();await pbh.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbh);
  await pbh.route('**/api/it-assets/inspections/sheets/'+draftBH.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  const settledBeforeBH=await pbh.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbh.locator('[data-seg-ok="'+airconBH.id+'"]').click();
  await pbh.locator('#itlFormBack').click(); // leaveForm：会话销毁+排离开冲刷(网络异常)
  await pbh.locator('[data-insp-row]').first().waitFor();
  await pbh.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeBH,{timeout:5000}); // 等离开冲刷落定(失败)——登记表现在非空
  // 白盒读取：unsavedBySheetId是模块内闭包变量，测试拿不到引用，改用它驱动的DOM(#itlUnsavedList)作为
  // "登记表非空"的可观测代理——只要banner里有条目，登记表就非空，判据链路是同一份数据。
  const unsavedSizeBH=await pbh.evaluate(()=>document.querySelectorAll('#itlUnsavedList [data-unsaved-sheet]').length);
  check('BH准备:登记表非空(巡检台账顶部常驻条至少1条)',unsavedSizeBH>=1,unsavedSizeBH);
  check('BH准备:此刻当前无表单会话(已返回列表,form为null)且写队列已空——beforeunload旧判据(dirty||queuesBySheetId.size>0)此刻应为假',await pbh.evaluate(()=>document.querySelector('#itlFormActionbar')===null));
  // 真正验证beforeunload会拦：同AB/AB-2/BA既有写法——派发一个真实beforeunload事件，读取defaultPrevented。
  const preventedBH=await pbh.evaluate(()=>{let prevented=null;const listener=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',listener);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',listener);return prevented;});
  check('BH(H1+H2，必修)：登记表非空时beforeunload被拦截(即便当前无表单会话/写队列已空)',preventedBH===true,preventedBH);
  check('浏览器无未捕获异常(BH)',errorsBH.length===0);
  await cbh.close();

  // BI) M1（C5a-f新增，spec-C5a-f.md §MED）：冲突重取GET在途时离开——handleConflict自己发起的重取GET
  // 还没落地，用户已经触发leaveForm结束了会话。旧版handleConflict的else分支不判f.destroyed，会先发
  // 一条"有修改未保存：这张单已在别处被修改"，紧接着leaveForm自己排的离开冲刷（此刻conflictIds已经
  // 因合并而标好）又发一条"离开时有修改未能保存"——两条几乎重复。新版handleConflict在GET落地后先判
  // f.destroyed，会话已结束就什么都不发，全部交给随后的离开冲刷统一给那一条。
  const draftBI=await buildDraftSheet('SF-RoomBI',2);
  const airconBI=draftBI.items.find(it=>it.item_key==='aircon');
  const cbi=await browser.newContext();await cbi.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbi=await cbi.newPage();const errorsBI=[];pbi.on('pageerror',e=>errorsBI.push(e.message));
  await pbi.goto(f.base+'/IT_Ledger.html#inspections');await pbi.locator('[data-insp-row="'+draftBI.id+'"]').waitFor();
  await installNoticeCounter(pbi); // M5(C5a-f)：BI场景本身就是"离开"这一步，从页面加载起计数即可，没有前置的可见冲突通知
  await pbi.locator('[data-insp-continue="'+draftBI.id+'"]').click();await pbi.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbi);
  let enteredPutBI,releasePutBI;const enteredPutBIP=new Promise(r=>enteredPutBI=r),heldPutBIP=new Promise(r=>releasePutBI=r);
  let enteredGetBI,releaseGetBI;const enteredGetBIP=new Promise(r=>enteredGetBI=r),heldGetBIP=new Promise(r=>releaseGetBI=r);
  await pbi.route('**/api/it-assets/inspections/sheets/'+draftBI.id,async route=>{
    const method=route.request().method();
    if(method==='PUT'){enteredPutBI();await heldPutBIP;return route.fallback();}
    if(method==='GET'){enteredGetBI();await heldGetBIP;return route.fallback();}
    return route.fallback();
  });
  await pbi.locator('[data-seg-ok="'+airconBI.id+'"]').click(); // 排队冲刷（真实1.5秒防抖）
  await enteredPutBIP; // 冲刷的PUT已经被挡住，还没真正发给服务器
  const otherPutBI=await f.api('PUT','/inspections/sheets/'+draftBI.id,{expected_version:draftBI.version,items:[{id:airconBI.id,result:'bad',number_value:null,note:'别处已改BI'}]},2);
  assert.equal(otherPutBI.status,200,'BI other put '+JSON.stringify(otherPutBI.body));
  releasePutBI(); // 放行：这次PUT带旧version,会409→performFlush的catch调用handleConflict(f)→handleConflict自己发起重取GET
  await enteredGetBIP; // 等handleConflict的重取GET也被挡住(还没真正发给服务器)——此刻会话还没结束
  await pbi.evaluate(()=>{location.hash='racks';}); // GET在途时触发onLeave→leaveForm：会话同步销毁+因仍有未保存内容,排一次离开冲刷
  await pbi.locator('.itl-rack-workspace').waitFor();
  const settledBeforeBI=await pbi.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  releaseGetBI(); // 放行handleConflict的重取GET——落地时f.destroyed已经是true，新版不再发任何提示
  // 等两次performFlush落定：原冲刷任务(catch里await了handleConflict，合并完检查f.destroyed后直接return)+
  // leaveForm自己排的离开冲刷(此刻conflictIds已经因合并标好,新脏项为0,走notifyExcludedConflicts早退分支)。
  await pbi.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+2,settledBeforeBI,{timeout:5000});
  check('BI(M1)：放行后仍停在机柜视图,没有把填写页画回来',await pbi.locator('.itl-rack-workspace').count()===1&&await pbi.locator('#itlFormActionbar').count()===0);
  const noticeTextBI=await pbi.locator('#itlNotice').innerText();
  check('BI(H2):机柜视图里常驻条不可达,离开冲刷一次性提示含完整原文',noticeTextBI.includes('巡检单〈'+sheetLabelStr(draftBI)+'〉有内容未能保存：')&&noticeTextBI.includes('空调运行：正常')&&!noticeTextBI.includes('详见巡检台账顶部'),noticeTextBI);
  check('BI(M1，必修)：handleConflict在GET落地时发现会话已结束，没有额外发一条提示——全程"离开失败/冲突"类提示恰好调用1次(旧版是2次)',await leaveOrConflictNoticeCount(pbi)===1,await pbi.evaluate(()=>window.__noticeCalls));
  await pbi.evaluate(()=>{location.hash='inspections';}); // 切回巡检列表才能看到#itlUnsavedList这个容器（此刻还在机柜视图里）
  const unsavedEntryBI=await pbi.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBI.id+'"]').innerText();
  check('BI(H1+H2)：巡检台账顶部常驻条也含同一份原文',unsavedEntryBI.includes(sheetLabelStr(draftBI))&&unsavedEntryBI.includes('空调运行：正常'),unsavedEntryBI);
  check('浏览器无未捕获异常(BI)',errorsBI.length===0);
  await cbi.close();

  // BJ) M2（C5a-f新增，spec-C5a-f.md §MED）：提交POST在途时离开——performSubmit的catch此前对已销毁
  // 会话撞409仍会调用handleConflict(多一次GET、且提示措辞用"有修改未保存"容易让人误解成"还没提交"，
  // 实际是提交请求本身失败了)。新版：会话已结束直接给"未能提交：这张单已在别处被修改，请重新打开核对
  // 后再提交"，不再走handleConflict。
  const draftBJ=await buildDraftSheet('SF-RoomBJ',2);
  const filledBJ=fillPayloadAllOk(draftBJ.items);
  const putBJ=await f.api('PUT','/inspections/sheets/'+draftBJ.id,{expected_version:draftBJ.version,items:filledBJ},2);
  assert.equal(putBJ.status,200,'BJ put '+JSON.stringify(putBJ.body));
  await uploadAllRackFrontPhotos(draftBJ.id,draftBJ.scope,2);
  const cbj=await browser.newContext();await cbj.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbj=await cbj.newPage();const errorsBJ=[];pbj.on('pageerror',e=>errorsBJ.push(e.message));
  let getCountAfterSubmitBJ=0;pbj.on('request',r=>{if(r.method()==='GET'&&r.url().endsWith('/inspections/sheets/'+draftBJ.id))getCountAfterSubmitBJ++;});
  await pbj.goto(f.base+'/IT_Ledger.html#inspections');await pbj.locator('[data-insp-row="'+draftBJ.id+'"]').waitFor();
  await installNoticeCounter(pbj); // M5(C5a-f)
  await pbj.locator('[data-insp-continue="'+draftBJ.id+'"]').click();await pbj.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbj);
  check('BJ准备:提交按钮此刻可点(progress.complete=true)',await pbj.locator('#itlFormSubmit[disabled]').count()===0);
  const heldSubmitBJ=holdRequestRoute(pbj,'**/api/it-assets/inspections/sheets/'+draftBJ.id+'/submit','POST');
  await pbj.locator('#itlFormSubmit').click(); // doSubmit: enqueue(冲刷,此刻无脏数据直接早退成功)+enqueue(performSubmit)
  await heldSubmitBJ.entered; // 提交POST已经发出、被挡住(还没真正发给服务器)
  const getCountBeforeReleaseBJ=getCountAfterSubmitBJ;
  await pbj.evaluate(()=>{location.hash='racks';}); // 提交在途时触发onLeave→leaveForm：会话同步销毁(此刻无脏数据,不会另排离开冲刷)
  await pbj.locator('.itl-rack-workspace').waitFor();
  const otherPutBJ=await f.api('PUT','/inspections/sheets/'+draftBJ.id,{expected_version:putBJ.body.version,remark:'别处改的备注BJ'},2);
  assert.equal(otherPutBJ.status,200,'BJ other put '+JSON.stringify(otherPutBJ.body)); // 让服务端version推进，提交请求带的还是旧version，放行后会撞409
  heldSubmitBJ.release(); // 放行：POST /submit 带旧version→409 SHEET_VERSION_CONFLICT，落在已销毁会话上
  // performSubmit没有专属的settle计数器——用notice数组出现"未能提交"内容做确定性等待（installNoticeCounter已装）。
  await pbj.waitForFunction(()=>window.__noticeCalls.some(m=>m.includes('未能提交')),null,{timeout:5000});
  check('BJ(M2)：放行409后仍停在机柜视图,没有把填写页画回来',await pbj.locator('.itl-rack-workspace').count()===1&&await pbj.locator('#itlFormActionbar').count()===0);
  check('BJ(M2，必修)：会话已结束,没有为了合并冲突而再发一次GET(未调用handleConflict)',getCountAfterSubmitBJ===getCountBeforeReleaseBJ,{getCountAfterSubmitBJ,getCountBeforeReleaseBJ});
  const noticeTextBJ=await pbj.locator('#itlNotice').innerText();
  check('BJ(M2，必修)：提示是"未能提交：这张单已在别处被修改，请重新打开核对后再提交"，不是"有修改未保存"前缀',noticeTextBJ.includes('未能提交：这张单已在别处被修改，请重新打开核对后再提交')&&!noticeTextBJ.includes('有修改未保存'),noticeTextBJ);
  check('BJ(N-L5新增)："未能提交"类提示全程恰好调用1次',await pbj.evaluate(()=>window.__noticeCalls.filter(m=>m.includes('未能提交')).length)===1,await pbj.evaluate(()=>window.__noticeCalls));
  const serverBJ=await getSheet(draftBJ.id,2);
  check('BJ(M2)：服务端该单仍是draft状态(提交确实没有成功)',serverBJ.body.status==='draft',serverBJ.body.status);
  check('浏览器无未捕获异常(BJ)',errorsBJ.length===0);
  await cbj.close();

  // BK) 第8条（C6-e，主会话追加，C5a-f 抽查发现）：登记表合并而非覆盖——离开失败丢 X → 重开只改 Y
  // （不碰 X）→ 离开再失败 → 常驻条应同时含 X 与 Y 的原文，不是只剩 Y（旧版 Map.set 覆盖会让第二次
  // 登记直接冲掉第一次的 X，用户永远找不回 X 丢失的内容）。两轮用同一张单、同一条恒失败的 PUT 路由。
  const draftBK=await buildDraftSheet('SF-RoomBK',2);
  const airconBK=draftBK.items.find(it=>it.item_key==='aircon');
  const upsBK=draftBK.items.find(it=>it.item_key==='ups');
  const cbk=await browser.newContext();await cbk.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbk=await cbk.newPage();const errorsBK=[];pbk.on('pageerror',e=>errorsBK.push(e.message));
  await pbk.goto(f.base+'/IT_Ledger.html#inspections');await pbk.locator('[data-insp-row="'+draftBK.id+'"]').waitFor();
  await pbk.route('**/api/it-assets/inspections/sheets/'+draftBK.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  // 第一轮：打开→改X(aircon=ok)→离开→PUT恒网络异常→notifyLeaveFlushFailure第一次registerUnsaved，只带X。
  await pbk.locator('[data-insp-continue="'+draftBK.id+'"]').click();await pbk.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbk);
  const settledBeforeFirstBK=await pbk.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbk.locator('[data-seg-ok="'+airconBK.id+'"]').click(); // 改X
  await pbk.locator('#itlFormBack').click(); // 离开——排一次离开冲刷(会失败)
  await pbk.locator('[data-insp-row]').first().waitFor();
  await pbk.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeFirstBK,{timeout:5000});
  const unsavedAfterFirstBK=await pbk.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBK.id+'"]').innerText();
  check('BK准备:第一轮离开失败,常驻条含X(空调运行：正常)',unsavedAfterFirstBK.includes('空调运行：正常'),unsavedAfterFirstBK);
  // 第二轮：重开(服务端X仍是null,因为第一轮PUT从没成功过)→只改Y(ups)，全程不碰X→离开→PUT再次恒失败→
  // 第二次registerUnsaved的parts只带着Y(X这次没脏，根本不在这次的dirty集合里)——合并逻辑要靠它才补回来。
  await pbk.locator('[data-insp-continue="'+draftBK.id+'"]').click();await pbk.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbk);
  const settledBeforeSecondBK=await pbk.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbk.locator('[data-seg-bad="'+upsBK.id+'"]').click(); // 改Y，不碰X
  await pbk.locator('#itlFormBack').click();
  await pbk.locator('[data-insp-row]').first().waitFor();
  await pbk.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeSecondBK,{timeout:5000});
  const unsavedAfterSecondBK=await pbk.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBK.id+'"]').innerText();
  check('BK(第8条必修):第二轮离开失败后,常驻条同时含X(空调运行：正常)与Y(UPS 与供电：异常)——不是被覆盖只剩Y',unsavedAfterSecondBK.includes('空调运行：正常')&&unsavedAfterSecondBK.includes('UPS 与供电：异常'),unsavedAfterSecondBK);
  // 第三轮（item A 追加，MED-3）：重开→把X从"正常"改成"异常"后再离开→PUT再次恒失败→按key合并，X这次
  // 的新值应该"替换"掉旧值而不是并列出现两次——用 split 统计"空调运行"这个词出现的次数应恰好1次，且
  // 内容是新值(异常)，不再是旧值(正常)。同时验证 Y(UPS) 依旧完好保留。
  await pbk.locator('[data-insp-continue="'+draftBK.id+'"]').click();await pbk.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbk);
  const settledBeforeThirdBK=await pbk.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbk.locator('[data-seg-bad="'+airconBK.id+'"]').click(); // 把X从"正常"改成"异常"
  await pbk.locator('#itlFormBack').click();
  await pbk.locator('[data-insp-row]').first().waitFor();
  await pbk.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeThirdBK,{timeout:5000});
  const unsavedAfterThirdBK=await pbk.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBK.id+'"]').innerText();
  const airconMentionsBK=unsavedAfterThirdBK.split('空调运行').length-1;
  check('BK第三轮(item A必修):X出现恰好1次(不是新旧并列两次,证明按key合并新值替换旧值,不是简单拼接不去重)',airconMentionsBK===1,unsavedAfterThirdBK);
  check('BK第三轮(item A必修):X是新值(异常),不再是旧值(正常)',unsavedAfterThirdBK.includes('空调运行：异常')&&!unsavedAfterThirdBK.includes('空调运行：正常'),unsavedAfterThirdBK);
  check('BK第三轮(item A必修):Y(UPS)依旧保留',unsavedAfterThirdBK.includes('UPS 与供电：异常'),unsavedAfterThirdBK);
  check('浏览器无未捕获异常(BK)',errorsBK.length===0);
  await cbk.close();

  // BU) item A 追加（同名设备用例，MED-3）：机柜里两台设备重名（it_assets.name 无唯一约束）——两台设备
  // 拼出来的显示文本前缀完全相同，只有 item.id 不同。旧版按文本第一个"："前的部分当key合并，会把后注册
  // 的设备条目覆盖掉先注册的（两者文本key相同）；新版按'item:'+id分key，两条都保留。
  const rackBU=await makeRoomWithDevices('SF-RoomBU',['DevSameNameBU','DevSameNameBU']);
  const createdBU=await createSheet(2,'SF-RoomBU');
  assert.equal(createdBU.status,201,'BU createSheet '+JSON.stringify(createdBU.body));
  const deviceItemsBU=createdBU.body.items.filter(it=>it.section==='device'&&it.target_label==='DevSameNameBU');
  assert.equal(deviceItemsBU.length,2,'BU期望两条同名设备项 '+JSON.stringify(createdBU.body.items));
  const [devABU,devBBU]=deviceItemsBU;
  const cbu=await browser.newContext();await cbu.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbu=await cbu.newPage();const errorsBU=[];pbu.on('pageerror',e=>errorsBU.push(e.message));
  await pbu.goto(f.base+'/IT_Ledger.html#inspections');await pbu.locator('[data-insp-row="'+createdBU.body.id+'"]').waitFor();
  await pbu.route('**/api/it-assets/inspections/sheets/'+createdBU.body.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  // 第一轮：只改设备A(判异常)→离开→失败→登记条目只带设备A那一条。
  await pbu.locator('[data-insp-continue="'+createdBU.body.id+'"]').click();await pbu.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbu);
  const settledBeforeFirstBU=await pbu.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbu.locator('[data-seg-bad="'+devABU.id+'"]').click();
  await pbu.locator('#itlFormBack').click();await pbu.locator('[data-insp-row]').first().waitFor();
  await pbu.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeFirstBU,{timeout:5000});
  const afterFirstBU=await pbu.locator('#itlUnsavedList [data-unsaved-sheet="'+createdBU.body.id+'"]').innerText();
  check('BU准备:第一轮只带设备A(前提成立)',afterFirstBU.split('DevSameNameBU').length-1===1,afterFirstBU);
  // 第二轮：重开，不碰设备A(其状态在服务端仍是null,因为第一轮PUT从没成功过)，只改设备B(判异常)→离开→
  // 再次失败→这次dirty集合只含设备B——合并要靠key把设备A的旧条目也保住，不能因为文本前缀相同被设备B
  // 冲掉。
  await pbu.locator('[data-insp-continue="'+createdBU.body.id+'"]').click();await pbu.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbu);
  const settledBeforeSecondBU=await pbu.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbu.locator('[data-seg-bad="'+devBBU.id+'"]').click();
  await pbu.locator('#itlFormBack').click();await pbu.locator('[data-insp-row]').first().waitFor();
  await pbu.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeSecondBU,{timeout:5000});
  const afterSecondBU=await pbu.locator('#itlUnsavedList [data-unsaved-sheet="'+createdBU.body.id+'"]').innerText();
  const mentionsBU=afterSecondBU.split('DevSameNameBU').length-1;
  check('BU(item A必修，同名设备)：两条同名设备条目都在(出现2次,不是被覆盖只剩1条)',mentionsBU===2,afterSecondBU);
  check('浏览器无未捕获异常(BU)',errorsBU.length===0);
  await cbu.close();

  // BT) M4：后续保存成功仍保留上次丢失的原文，并在该项旁标注新值，直到用户确认。
  const draftBT=await buildDraftSheet('SF-RoomBT',2);
  const airconBT=draftBT.items.find(it=>it.item_key==='aircon');
  const upsBT=draftBT.items.find(it=>it.item_key==='ups');
  const cbt=await browser.newContext();await cbt.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbt=await cbt.newPage();const errorsBT=[];pbt.on('pageerror',e=>errorsBT.push(e.message));
  await pbt.goto(f.base+'/IT_Ledger.html#inspections');await pbt.locator('[data-insp-row="'+draftBT.id+'"]').waitFor();
  await pbt.route('**/api/it-assets/inspections/sheets/'+draftBT.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await pbt.locator('[data-insp-continue="'+draftBT.id+'"]').click();await pbt.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbt);
  const settledBeforeFirstBT=await pbt.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbt.locator('[data-seg-ok="'+airconBT.id+'"]').click(); // X=空调，正常
  await pbt.locator('[data-seg-bad="'+upsBT.id+'"]').click(); // Y=UPS，异常
  await pbt.locator('#itlFormBack').click();await pbt.locator('[data-insp-row]').first().waitFor();
  await pbt.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeFirstBT,{timeout:5000});
  const bannerAfterFirstBT=await pbt.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBT.id+'"]').innerText();
  check('BT准备:第一轮离开失败,常驻条同时含X与Y(前提成立)',bannerAfterFirstBT.includes('空调运行：正常')&&bannerAfterFirstBT.includes('UPS 与供电：异常'),bannerAfterFirstBT);
  await pbt.unroute('**/api/it-assets/inspections/sheets/'+draftBT.id); // 解除失败路由——第二轮真的要保存成功
  await pbt.locator('[data-insp-continue="'+draftBT.id+'"]').click();await pbt.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbt);
  const settledBeforeSecondBT=await pbt.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbt.locator('[data-seg-bad="'+airconBT.id+'"]').click(); // X改成异常，这次要真的存上
  await pbt.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeSecondBT,{timeout:5000});
  const serverAfterSaveBT=await getSheet(draftBT.id,2);
  check('BT准备:X这次真的保存成功了(服务端aircon=bad)',serverAfterSaveBT.body.items.find(it=>it.id===airconBT.id).result==='bad',serverAfterSaveBT.body);
  await pbt.locator('#itlFormBack').click();await pbt.locator('[data-insp-row]').first().waitFor();
  const bannerCountAfterSaveBT=await pbt.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBT.id+'"]').count();
  const bannerTextAfterSaveBT=bannerCountAfterSaveBT?await pbt.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBT.id+'"]').innerText():'';
  check('BT(M4)：X旧原文仍在,并标注后续保存的新值',bannerTextAfterSaveBT.includes('空调运行：正常')&&bannerTextAfterSaveBT.includes('（已被后续保存为：异常）'),bannerTextAfterSaveBT);
  check('BT(M4)：Y(UPS)旧原文仍在,两项都等用户确认',bannerTextAfterSaveBT.includes('UPS 与供电：异常')&&bannerCountAfterSaveBT===1,bannerTextAfterSaveBT);
  check('浏览器无未捕获异常(BT)',errorsBT.length===0);
  await cbt.close();

  // W1 M2：用带账号 id 的 JWT 形状覆盖正式令牌路径；夹具服务器仍按 fixture uid 验权。
  // 两个不同 id 的令牌在同一页切换，分别直接证明渲染与 beforeunload 按账号 id 过滤。
  const draftOwner=await buildDraftSheet('SF-RoomAccountId',2),airconOwner=draftOwner.items.find(it=>it.item_key==='aircon');
  const jwtFor=(id,login)=>Buffer.from('{"alg":"none"}').toString('base64')+'.'+Buffer.from(JSON.stringify({id,login})).toString('base64')+'.fixture';
  const jwt2=jwtFor(2,'first'),jwt2Renewed=jwtFor(2,'renewed'),jwt3=jwtFor(3,'other');
  const cOwner=await browser.newContext();
  await cOwner.addInitScript(token=>localStorage.setItem('token',token),jwt2);
  await cOwner.route('**/api/**',route=>{
    const headers=route.request().headers();
    const uid=headers.authorization==='Bearer '+jwt3?3:2;
    return route.continue({headers:{...headers,authorization:'Bearer fixture-'+uid}});
  });
  try{
    const pOwner=await cOwner.newPage();await pOwner.goto(f.base+'/IT_Ledger.html#inspections');await pOwner.locator('[data-insp-row="'+draftOwner.id+'"]').waitFor();
    await pOwner.route('**/api/it-assets/inspections/sheets/'+draftOwner.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
    await pOwner.locator('[data-insp-continue="'+draftOwner.id+'"]').click();await pOwner.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pOwner);
    const beforeOwner=await pOwner.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pOwner.locator('[data-seg-ok="'+airconOwner.id+'"]').click();await pOwner.locator('#itlFormBack').click();
    await pOwner.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,beforeOwner,{timeout:5000});
    await pOwner.locator('#itlUnsavedList [data-unsaved-sheet="'+draftOwner.id+'"]').waitFor({timeout:5000});
    const pOwnerOther=await cOwner.newPage();await pOwnerOther.goto(f.base+'/IT_Ledger.html#inspections');
    await pOwnerOther.evaluate(token=>localStorage.setItem('token',token),jwt3);
    await pOwner.locator('#itlUnsavedList[data-account-id="3"]').waitFor({state:'attached',timeout:5000});
    check('W1-MA:账号3的列表不显示账号2旧原文',await pOwner.locator('#itlUnsavedList [data-unsaved-sheet="'+draftOwner.id+'"]').count()===0);
    const blockedOwner=await pOwner.evaluate(()=>{let prevented=false;const h=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',h);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',h);return prevented;});
    check('W1-MB:账号3的beforeunload不替账号2拦截',blockedOwner===false,blockedOwner);
    await pOwnerOther.evaluate(token=>localStorage.setItem('token',token),jwt2Renewed);
    await pOwner.locator('#itlUnsavedList[data-account-id="2"] [data-unsaved-sheet="'+draftOwner.id+'"]').waitFor({timeout:5000});
    check('W1-M2:同账号用新token登录后原文恢复', (await pOwner.locator('#itlUnsavedList [data-unsaved-sheet="'+draftOwner.id+'"]').innerText()).includes('空调运行：正常'));
  }finally{await cOwner.close();}

  // BL) N-H1（C5a-g，预筛HIGH，搬Q3进正式测试）：登记表按账号隔离——fixture-2离开失败留下条目→同一
  // 浏览器上下文另开一页把token换成fixture-3(触发storage事件→clearData+refresh)→原页面以fixture-3身份
  // 重新渲染巡检列表后，登记表条目不应该再显示(不是fixture-3自己的)，beforeunload也不该替fixture-3拦着
  // fixture-2的未保存内容。再切回fixture-2：原文应恢复显示，直到本人点"知道了"。
  const draftBL=await buildDraftSheet('SF-RoomBL',2);
  const airconBL=draftBL.items.find(it=>it.item_key==='aircon');
  const cbl=await browser.newContext();await cbl.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbl=await cbl.newPage();const errorsBL=[];pbl.on('pageerror',e=>errorsBL.push(e.message));
  await pbl.goto(f.base+'/IT_Ledger.html#inspections');await pbl.locator('[data-insp-row="'+draftBL.id+'"]').waitFor();
  await pbl.route('**/api/it-assets/inspections/sheets/'+draftBL.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await pbl.locator('[data-insp-continue="'+draftBL.id+'"]').click();await pbl.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbl);
  const settledBeforeBL=await pbl.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbl.locator('[data-seg-ok="'+airconBL.id+'"]').click();
  await pbl.locator('#itlFormBack').click();
  await pbl.locator('[data-insp-row]').first().waitFor();
  await pbl.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeBL,{timeout:5000});
  const bannerBeforeSwitchBL=await pbl.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBL.id+'"]').innerText();
  check('BL准备:fixture-2留下常驻条(换号前,前提成立)',bannerBeforeSwitchBL.includes(sheetLabelStr(draftBL))&&bannerBeforeSwitchBL.includes('空调运行：正常'),bannerBeforeSwitchBL);
  const beforeunloadBeforeBL=await pbl.evaluate(()=>{let prevented=null;const l=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',l);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',l);return prevented;});
  check('BL准备:fixture-2此刻beforeunload被拦(换号前,前提成立)',beforeunloadBeforeBL===true,beforeunloadBeforeBL);
  const settledBeforeAccountSwitchBL=await pbl.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const pbl2=await cbl.newPage();await pbl2.goto(f.base+'/IT_Ledger.html#inspections');
  await pbl2.evaluate(()=>localStorage.setItem('token','fixture-3'));
  await pbl.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeAccountSwitchBL,{timeout:15000});
  await pbl.locator('[data-insp-row]').first().waitFor({timeout:15000});
  await pbl.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
  const bannerAfterSwitchBL=await pbl.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBL.id+'"]').count();
  check('BL(N-H1必修)：换号后fixture-2的常驻条不再显示(不是fixture-3自己的内容)',bannerAfterSwitchBL===0,bannerAfterSwitchBL);
  const beforeunloadAfterSwitchBL=await pbl.evaluate(()=>{let prevented=null;const l=e=>{prevented=e.defaultPrevented;};window.addEventListener('beforeunload',l);window.dispatchEvent(new Event('beforeunload',{cancelable:true}));window.removeEventListener('beforeunload',l);return prevented;});
  check('BL(N-H1必修)：换号后beforeunload不再替fixture-3拦着fixture-2的未保存内容',beforeunloadAfterSwitchBL===false,beforeunloadAfterSwitchBL);
  const settledBeforeSwitchBackBL=await pbl.evaluate(()=>window.ITLedger.__inspLoadSettled);
  await pbl2.evaluate(()=>localStorage.setItem('token','fixture-2'));
  await pbl.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforeSwitchBackBL,{timeout:15000});
  await pbl.locator('[data-insp-row]').first().waitFor({timeout:15000});
  const bannerAfterSwitchBackBL=await pbl.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBL.id+'"]').count();
  check('BL(M2)：切回fixture-2后本账号旧原文恢复显示',bannerAfterSwitchBackBL===1,bannerAfterSwitchBackBL);
  check('浏览器无未捕获异常(BL)',errorsBL.length===0);
  await cbl.close();

  // W1 R1a/R1b：防抖计时器尚未触发时换号。管理员本可写这张单，只读账号会触发全局 403；
  // 两种目标身份都必须零 PUT，且只读账号自己的页签不能被旧会话请求清空。
  for(const targetUid of [1,3]){
    const draftR1=await buildDraftSheet('SF-RoomR1-'+targetUid,2);
    const airconR1=draftR1.items.find(it=>it.item_key==='aircon');
    const cR1=await browser.newContext();await cR1.addInitScript(()=>localStorage.setItem('token','fixture-2'));
    try{
      const pR1=await cR1.newPage();let putCountR1=0;const errorsR1=[];pR1.on('pageerror',e=>errorsR1.push(e.message));
      await pR1.goto(f.base+'/IT_Ledger.html#inspections');await pR1.locator('[data-insp-row="'+draftR1.id+'"]').waitFor();
      await pR1.locator('[data-insp-continue="'+draftR1.id+'"]').click();await pR1.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pR1);
      await pR1.clock.install();await pR1.clock.pauseAt(new Date());
      await pR1.route('**/api/it-assets/inspections/sheets/'+draftR1.id,route=>{if(route.request().method()==='PUT')putCountR1++;return route.fallback();});
      await pR1.locator('[data-seg-ok="'+airconR1.id+'"]').click();
      const pR1Other=await cR1.newPage();await pR1Other.goto(f.base+'/IT_Ledger.html#inspections');
      await pR1Other.evaluate(uid=>localStorage.setItem('token','fixture-'+uid),targetUid);
      await pR1.waitForFunction(uid=>window.ITLedger.state.level===(uid===1?'admin':'read'),targetUid,{timeout:5000});
      await pR1.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
      await pR1.clock.runFor(2000);
      const serverR1=await getSheet(draftR1.id,2);
      check('R1'+(targetUid===1?'a':'b')+'(H1):换号后旧会话零PUT',putCountR1===0,putCountR1);
      check('R1'+(targetUid===1?'a':'b')+'(H1):旧草稿没有以新账号写库',serverR1.body.items.find(it=>it.id===airconR1.id).result===null,serverR1.body);
      check('R1'+(targetUid===1?'a':'b')+'(H1):新账号没有收到旧草稿原文提示',!(await pR1.locator('#itlNotice').innerText()).includes('SF-RoomR1-'+targetUid));
      if(targetUid===3)check('R1b(H1):只读账号的巡检页签仍可见',await pR1.locator('#itlTabs').isVisible());
      check('R1'+(targetUid===1?'a':'b')+':浏览器无未捕获异常',errorsR1.length===0,errorsR1);
    }finally{await cR1.close();}
  }

  // Claude 外审 M-2（H1T）：R1a/b 里换号会派发 storage 事件、onAccessLost 先清掉计时器，发 PUT 前的 token
  // 核对从未单独被证明过（两层都在时去掉任一层仍全绿）。这里同页直接改 localStorage——同一文档不收
  // storage 事件，等价于他页已写入而事件尚未送达——计时器照常触发，只剩发请求前的核对能挡住。
  {
    const draftH1T=await buildDraftSheet('SF-RoomH1T',2),airconH1T=draftH1T.items.find(it=>it.item_key==='aircon');
    const cH1T=await browser.newContext();await cH1T.addInitScript(()=>localStorage.setItem('token','fixture-2'));
    try{
      const pH1T=await cH1T.newPage();let putCountH1T=0;const errorsH1T=[];pH1T.on('pageerror',e=>errorsH1T.push(e.message));
      await pH1T.goto(f.base+'/IT_Ledger.html#inspections');await pH1T.locator('[data-insp-row="'+draftH1T.id+'"]').waitFor();
      await pH1T.locator('[data-insp-continue="'+draftH1T.id+'"]').click();await pH1T.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pH1T);
      await pH1T.clock.install();await pH1T.clock.pauseAt(new Date());
      await pH1T.route('**/api/it-assets/inspections/sheets/'+draftH1T.id,route=>{if(route.request().method()==='PUT')putCountH1T++;return route.fallback();});
      await pH1T.locator('[data-seg-ok="'+airconH1T.id+'"]').click();
      await pH1T.evaluate(()=>localStorage.setItem('token','fixture-1'));
      const flushBefore=await pH1T.evaluate(()=>window.ITLedger.__inspFormFlushSettled||0);
      await pH1T.clock.runFor(2000);
      await pH1T.waitForFunction(b=>(window.ITLedger.__inspFormFlushSettled||0)>=b+1,flushBefore,{timeout:5000});
      const serverH1T=await getSheet(draftH1T.id,2);
      check('H1T(外审M-2):计时器冲刷在token已变而事件未达时零PUT',putCountH1T===0,putCountH1T);
      check('H1T(外审M-2):旧草稿没有以新账号写库',serverH1T.body.items.find(it=>it.id===airconH1T.id).result===null,serverH1T.body);
      check('H1T:浏览器无未捕获异常',errorsH1T.length===0,errorsH1T);
    }finally{await cH1T.close();}
  }

  // W1 R1c：无表单删除任务的 GET 已取到版本、DELETE 尚未发出时换号，必须在第二次请求前拒绝。
  const draftR1c=await buildDraftSheet('SF-RoomR1c',2);
  const cR1c=await browser.newContext();await cR1c.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  try{
    const pR1c=await cR1c.newPage();let deleteCountR1c=0;
    pR1c.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+draftR1c.id)&&r.method()==='DELETE')deleteCountR1c++;});
    await pR1c.goto(f.base+'/IT_Ledger.html#inspections');await pR1c.locator('[data-insp-row="'+draftR1c.id+'"]').waitFor();
    await pR1c.evaluate(id=>{
      const original=window.ITLedger.api;let switched=false;
      window.ITLedger.api=async(path,options)=>{
        const result=await original(path,options);
        if(!switched&&path==='/inspections/sheets/'+id&&(!options||!options.method||options.method==='GET')){
          switched=true;localStorage.setItem('token','fixture-1');
          window.dispatchEvent(new StorageEvent('storage',{key:'token',oldValue:'fixture-2',newValue:'fixture-1'}));
        }
        return result;
      };
    },draftR1c.id);
    const beforeR1c=await pR1c.evaluate(id=>window.ITLedger.__inspDeleteSettledBySheet.get(id)||0,draftR1c.id);
    await pR1c.locator('[data-insp-delete-draft="'+draftR1c.id+'"]').click();await pR1c.locator('#itlSubmit').click({timeout:5000});
    await pR1c.waitForFunction(({id,base})=>(window.ITLedger.__inspDeleteSettledBySheet.get(id)||0)>=base+1,{id:draftR1c.id,base:beforeR1c},{timeout:5000});
    check('R1c(H1):GET与DELETE之间换号后零DELETE',deleteCountR1c===0,deleteCountR1c);
    check('R1c(H1):草稿仍存在', (await getSheet(draftR1c.id,2)).status===200);
    check('R1c(H1):新账号没有收到旧单提示',!(await pR1c.locator('#itlNotice').innerText()).includes('SF-RoomR1c'));
  }finally{await cR1c.close();}

  // W1 R1d：PUT 的 409 已抵达、冲突重取 GET 尚未发出时换号，旧会话不以新身份读取或重画。
  const draftR1d=await buildDraftSheet('SF-RoomR1d',2),airconR1d=draftR1d.items.find(it=>it.item_key==='aircon');
  const cR1d=await browser.newContext();await cR1d.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  try{
    const pR1d=await cR1d.newPage();let conflictGets=0;
    await pR1d.goto(f.base+'/IT_Ledger.html#inspections');await pR1d.locator('[data-insp-row="'+draftR1d.id+'"]').waitFor();
    await pR1d.locator('[data-insp-continue="'+draftR1d.id+'"]').click();await pR1d.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pR1d);
    const externalR1d=await f.api('PUT','/inspections/sheets/'+draftR1d.id,{expected_version:draftR1d.version,remark:'别处更新R1d'},1);
    assert.equal(externalR1d.status,200);
    pR1d.on('request',r=>{if(r.url().endsWith('/inspections/sheets/'+draftR1d.id)&&r.method()==='GET')conflictGets++;});
    await pR1d.evaluate(id=>{
      const original=window.ITLedger.api;
      window.ITLedger.api=async(path,options)=>{
        try{return await original(path,options);}
        catch(error){
          if(path==='/inspections/sheets/'+id&&options?.method==='PUT'&&error.code==='SHEET_VERSION_CONFLICT')localStorage.setItem('token','fixture-1');
          throw error;
        }
      };
    },draftR1d.id);
    const beforeR1d=await pR1d.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pR1d.locator('[data-seg-ok="'+airconR1d.id+'"]').click();
    await pR1d.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,beforeR1d,{timeout:5000});
    check('R1d(H1):换号后冲突重取零GET',conflictGets===0,conflictGets);
    check('R1d(H1):新账号没有收到旧单提示',!(await pR1d.locator('#itlNotice').innerText()).includes('SF-RoomR1d'));
    await pR1d.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'token',oldValue:'fixture-2',newValue:'fixture-1'})));
  }finally{await cR1d.close();}

  // W1 R2：旧 PUT 已被服务端处理、响应仍挂起时换号；迟到的 401 只能记在旧账号名下。
  const draftR2=await buildDraftSheet('SF-RoomR2',2),airconR2=draftR2.items.find(it=>it.item_key==='aircon');
  const cR2=await browser.newContext();await cR2.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  try{
    const pR2=await cR2.newPage();await pR2.goto(f.base+'/IT_Ledger.html#inspections');await pR2.locator('[data-insp-row="'+draftR2.id+'"]').waitFor();
    await pR2.locator('[data-insp-continue="'+draftR2.id+'"]').click();await pR2.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pR2);
    const heldR2=holdRoute(pR2,'**/api/it-assets/inspections/sheets/'+draftR2.id,'PUT');
    const settledR2=await pR2.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pR2.locator('[data-seg-ok="'+airconR2.id+'"]').click();await reachedWithin(heldR2.entered,'R2 PUT');
    const pR2Other=await cR2.newPage();await pR2Other.goto(f.base+'/IT_Ledger.html#inspections');
    await pR2Other.evaluate(()=>localStorage.setItem('token','fixture-3'));
    await pR2.waitForFunction(()=>window.ITLedger.state.level==='read',null,{timeout:5000});
    await pR2.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
    heldR2.release();await pR2.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledR2,{timeout:5000});
    check('R2(M1/M6):迟到结果不向当前只读账号显示旧单原文',!(await pR2.locator('#itlNotice').innerText()).includes('SF-RoomR2'));
    await pR2Other.evaluate(()=>localStorage.setItem('token','fixture-2'));
    await pR2.waitForFunction(()=>window.ITLedger.state.level==='write',null,{timeout:5000});
    await pR2.locator('#itlUnsavedList [data-unsaved-sheet="'+draftR2.id+'"]').waitFor({timeout:5000});
    const r2Banner=await pR2.locator('#itlUnsavedList [data-unsaved-sheet="'+draftR2.id+'"]').innerText();
    check('R2(M1/M6):迟到401登记在原账号,原因是结果未能确认',r2Banner.includes('空调运行：正常')&&r2Banner.includes('登录状态已变化，结果未能确认')&&!r2Banner.includes('未能保存（操作失败）'),r2Banner);
  }finally{await cR2.close();}

  // W1 MC：采集响应晚于换号落地，等待被采集的这一台设备的完成信号，再查新账号提示。
  const draftMC=await buildDraftSheet('SF-RoomMC',2),deviceMC=draftMC.items.find(it=>it.section==='device');
  const cMC=await browser.newContext();await cMC.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  let heldMC;
  try{
    const pMC=await cMC.newPage();await pMC.goto(f.base+'/IT_Ledger.html#inspections');await pMC.locator('[data-insp-row="'+draftMC.id+'"]').waitFor();
    await pMC.locator('[data-insp-continue="'+draftMC.id+'"]').click();await pMC.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pMC);
    const beforeMC=await pMC.evaluate(id=>window.ITLedger.__inspCollectSettledByItem.get(id)||0,deviceMC.id);
    heldMC=holdRoute(pMC,'**/api/it-assets/inspections/sheets/'+draftMC.id+'/items/'+deviceMC.id+'/collect','POST');
    await pMC.locator('[data-collect-id="'+deviceMC.id+'"]').click();await reachedWithin(heldMC.entered,'MC collect');
    const pMCOther=await cMC.newPage();await pMCOther.goto(f.base+'/IT_Ledger.html#inspections');
    await pMCOther.evaluate(()=>localStorage.setItem('token','fixture-3'));
    await pMC.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
    heldMC.release();
    await pMC.waitForFunction(({id,base})=>(window.ITLedger.__inspCollectSettledByItem.get(id)||0)>=base+1,{id:deviceMC.id,base:beforeMC},{timeout:5000});
    const noticeMC=await pMC.locator('#itlNotice').innerText();
    check('MC(M6):旧账号采集迟到结果不向当前账号提示',!noticeMC.includes('SF-RoomMC'),noticeMC);
    await pMCOther.evaluate(()=>localStorage.setItem('token','fixture-2'));
    await pMC.locator('#itlUnsavedList [data-unsaved-sheet="'+draftMC.id+'"]').waitFor({timeout:5000});
    const bannerMC=await pMC.locator('#itlUnsavedList [data-unsaved-sheet="'+draftMC.id+'"]').innerText();
    check('MC(M1):采集迟到401以结果未能确认登记在原账号',bannerMC.includes('采集结果未能确认')&&bannerMC.includes('登录状态已变化，结果未能确认'),bannerMC);
  }finally{heldMC?.release();await cMC.close();}

  // W1 MC-NET：请求已经发出，换号后网络失败落地时，旧会话的结果提示不能画给新账号。
  const draftMCN=await buildDraftSheet('SF-RoomMCN',2),deviceMCN=draftMCN.items.find(it=>it.section==='device');
  const cMCN=await browser.newContext();await cMCN.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  let releaseMCN;
  try{
    const pMCN=await cMCN.newPage();await pMCN.goto(f.base+'/IT_Ledger.html#inspections');await pMCN.locator('[data-insp-row="'+draftMCN.id+'"]').waitFor();
    await pMCN.locator('[data-insp-continue="'+draftMCN.id+'"]').click();await pMCN.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pMCN);
    let enteredResolveMCN;const enteredMCN=new Promise(resolve=>enteredResolveMCN=resolve);
    const gateMCN=new Promise(resolve=>releaseMCN=resolve);
    await pMCN.route('**/api/it-assets/inspections/sheets/'+draftMCN.id+'/items/'+deviceMCN.id+'/collect',async route=>{
      if(route.request().method()!=='POST')return route.fallback();
      enteredResolveMCN();await gateMCN;await route.abort('failed');
    });
    const beforeMCN=await pMCN.evaluate(id=>window.ITLedger.__inspCollectSettledByItem.get(id)||0,deviceMCN.id);
    await pMCN.locator('[data-collect-id="'+deviceMCN.id+'"]').click();await reachedWithin(enteredMCN,'MC-NET collect');
    const pMCNOther=await cMCN.newPage();await pMCNOther.goto(f.base+'/IT_Ledger.html#inspections');
    await pMCNOther.evaluate(()=>localStorage.setItem('token','fixture-3'));
    await pMCN.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
    releaseMCN();
    await pMCN.waitForFunction(({id,base})=>(window.ITLedger.__inspCollectSettledByItem.get(id)||0)>=base+1,{id:deviceMCN.id,base:beforeMCN},{timeout:5000});
    check('MC-NET(M6):换号后迟到网络失败不向当前账号提示旧单',!(await pMCN.locator('#itlNotice').innerText()).includes('SF-RoomMCN'));
  }finally{releaseMCN?.();await cMCN.close();}

  // W1 M1：已提交请求的响应晚于换号，原账号应看到"结果未能确认"，新账号不收到旧单提示。
  const draftMS=await buildDraftSheet('SF-RoomMS',2),detailMS=await getSheet(draftMS.id,2);
  const putMS=await f.api('PUT','/inspections/sheets/'+draftMS.id,{expected_version:detailMS.body.version,items:fillPayloadAllOk(detailMS.body.items)},2);
  assert.equal(putMS.status,200);await uploadAllRackFrontPhotos(draftMS.id,draftMS.scope,2);
  const cMS=await browser.newContext();await cMS.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  let heldMS;
  try{
    const pMS=await cMS.newPage();await pMS.goto(f.base+'/IT_Ledger.html#inspections');await pMS.locator('[data-insp-row="'+draftMS.id+'"]').waitFor();
    await pMS.locator('[data-insp-continue="'+draftMS.id+'"]').click();await pMS.locator('#itlFormSubmit:not([disabled])').waitFor({timeout:5000});await expandInspectionForm(pMS);
    const beforeMS=await pMS.evaluate(id=>window.ITLedger.__inspSubmitSettledBySheet.get(id)||0,draftMS.id);
    heldMS=holdRoute(pMS,'**/api/it-assets/inspections/sheets/'+draftMS.id+'/submit','POST');
    await pMS.locator('#itlFormSubmit').click();await reachedWithin(heldMS.entered,'MS submit');
    const pMSOther=await cMS.newPage();await pMSOther.goto(f.base+'/IT_Ledger.html#inspections');
    await pMSOther.evaluate(()=>localStorage.setItem('token','fixture-3'));
    await pMS.locator('#itlUnsavedList[data-account-id=""]').waitFor({state:'attached',timeout:5000});
    heldMS.release();
    await pMS.waitForFunction(({id,base})=>(window.ITLedger.__inspSubmitSettledBySheet.get(id)||0)>=base+1,{id:draftMS.id,base:beforeMS},{timeout:5000});
    check('MS(M1):提交迟到401不向当前账号提示旧单',!(await pMS.locator('#itlNotice').innerText()).includes('SF-RoomMS'));
    await pMSOther.evaluate(()=>localStorage.setItem('token','fixture-2'));
    await pMS.locator('#itlUnsavedList [data-unsaved-sheet="'+draftMS.id+'"]').waitFor({timeout:5000});
    const bannerMS=await pMS.locator('#itlUnsavedList [data-unsaved-sheet="'+draftMS.id+'"]').innerText();
    check('MS(M1):提交迟到401登记在原账号且原因是不确定',bannerMS.includes('提交结果未能确认')&&bannerMS.includes('登录状态已变化，结果未能确认'),bannerMS);
  }finally{heldMS?.release();await cMS.close();}

  // W1 R3：真实 403 清空整页之后，原文必须在一次性提示里，连同共享层的权限变化原因。
  const draftR3=await buildDraftSheet('SF-RoomR3',2),airconR3=draftR3.items.find(it=>it.item_key==='aircon');
  const cR3=await browser.newContext();await cR3.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  try{
    const pR3=await cR3.newPage();await pR3.goto(f.base+'/IT_Ledger.html#inspections');await pR3.locator('[data-insp-row="'+draftR3.id+'"]').waitFor();
    await pR3.locator('[data-insp-continue="'+draftR3.id+'"]').click();await pR3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pR3);
    await pR3.route('**/api/it-assets/inspections/sheets/'+draftR3.id,route=>route.request().method()==='PUT'?route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({code:'LEDGER_FORBIDDEN',message:'访问权限已变化'})}):route.fallback());
    const settledR3=await pR3.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pR3.locator('[data-seg-ok="'+airconR3.id+'"]').click();
    await pR3.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledR3,{timeout:5000});
    const r3Notice=await pR3.locator('#itlNotice').innerText();
    check('R3(H2):403清页后一次性提示保留权限原因与完整原文',r3Notice.includes('访问权限已变化')&&r3Notice.includes('空调运行：正常')&&!r3Notice.includes('详见巡检台账顶部')&&!r3Notice.includes('补填'),r3Notice);
    check('R3(H2):403后常驻条确实不可达,页签被隐藏',!(await pR3.locator('#itlTabs').isVisible())&&await pR3.locator('#itlUnsavedList [data-unsaved-sheet="'+draftR3.id+'"]').count()===0);
  }finally{await cR3.close();}

  // W1 L6/MJ：队列排空以后、下一次 GET 仍挂起时，占位必须已隐藏，不能靠后续整页重绘掩盖。
  const draftMJ=await buildDraftSheet('SF-RoomMJ',2),airconMJ=draftMJ.items.find(it=>it.item_key==='aircon');
  const cMJ=await browser.newContext();await cMJ.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  let heldPutMJ,heldGetMJ;
  try{
    const pMJ=await cMJ.newPage();await pMJ.goto(f.base+'/IT_Ledger.html#inspections');await pMJ.locator('[data-insp-row="'+draftMJ.id+'"]').waitFor();
    await pMJ.locator('[data-insp-continue="'+draftMJ.id+'"]').click();await pMJ.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pMJ);
    heldPutMJ=holdRoute(pMJ,'**/api/it-assets/inspections/sheets/'+draftMJ.id,'PUT');
    await pMJ.locator('[data-seg-ok="'+airconMJ.id+'"]').click();await reachedWithin(heldPutMJ.entered,'MJ PUT');
    heldGetMJ=holdRequestRoute(pMJ,'**/api/it-assets/inspections/sheets/'+draftMJ.id,'GET');
    await pMJ.locator('#itlFormBack').click();await pMJ.locator('[data-insp-row="'+draftMJ.id+'"]').waitFor();
    await pMJ.locator('[data-insp-continue="'+draftMJ.id+'"]').click();
    check('MJ准备:旧PUT挂起时等待占位确实可见',await pMJ.locator('#itlInspWaitPlaceholder').isVisible());
    heldPutMJ.release();await reachedWithin(heldGetMJ.entered,'MJ GET');
    check('MJ(L6):队列排空但重开GET仍在途时占位已隐藏',await pMJ.locator('#itlInspWaitPlaceholder').count()===1&&!(await pMJ.locator('#itlInspWaitPlaceholder').isVisible()));
    heldGetMJ.release();await pMJ.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pMJ);
  }finally{heldPutMJ?.release();heldGetMJ?.release();await cMJ.close();}

  // W1 L6/ME：旧备注失败后，只保存另一个检查项不能把旧备注误标为已经后续保存。
  const draftME=await buildDraftSheet('SF-RoomME',2),airconME=draftME.items.find(it=>it.item_key==='aircon');
  const cME=await browser.newContext();await cME.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  try{
    const pME=await cME.newPage();await pME.goto(f.base+'/IT_Ledger.html#inspections');await pME.locator('[data-insp-row="'+draftME.id+'"]').waitFor();
    await pME.route('**/api/it-assets/inspections/sheets/'+draftME.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
    await pME.locator('[data-insp-continue="'+draftME.id+'"]').click();await pME.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pME);
    const firstME=await pME.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pME.locator('#itlFormRemark').fill('旧备注ME');await pME.locator('#itlFormBack').click();
    await pME.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,firstME,{timeout:5000});
    await pME.locator('#itlUnsavedList [data-unsaved-sheet="'+draftME.id+'"]').waitFor({timeout:5000});
    await pME.unroute('**/api/it-assets/inspections/sheets/'+draftME.id);
    await pME.locator('[data-insp-continue="'+draftME.id+'"]').click();await pME.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pME);
    const secondME=await pME.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
    await pME.locator('[data-seg-ok="'+airconME.id+'"]').click();
    await pME.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,secondME,{timeout:5000});
    const bannerME=await pME.locator('#itlUnsavedForm [data-unsaved-sheet="'+draftME.id+'"]').innerText();
    check('ME(L6):只保存检查项后旧备注原文保留且没有误标已保存',bannerME.includes('备注：旧备注ME（原因：网络异常）')&&!bannerME.includes('备注：旧备注ME（原因：网络异常）（已被后续保存为：'),bannerME);
  }finally{await cME.close();}

  // BM) N-M1 Q1（C5a-g，预筛MED，搬入正式测试）：提交POST在途时返回列表→立即继续填写同一张单(queueIdle
  // 等待,出现占位)→提交409(会话已结束,notifyOutcome给"未能提交")→占位落定(queueIdle解除)——占位清空
  // 不应该把"未能提交"这条notice一起清掉(N-M1改成占位自成一体,不再共用#itlNotice这个无条件清空的槽位)。
  const draftBM=await buildDraftSheet('SF-RoomBM',2);
  const filledBM=fillPayloadAllOk(draftBM.items);
  const putBM=await f.api('PUT','/inspections/sheets/'+draftBM.id,{expected_version:draftBM.version,items:filledBM},2);
  assert.equal(putBM.status,200,'BM put '+JSON.stringify(putBM.body));
  await uploadAllRackFrontPhotos(draftBM.id,draftBM.scope,2);
  const cbm=await browser.newContext();await cbm.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbm=await cbm.newPage();const errorsBM=[];pbm.on('pageerror',e=>errorsBM.push(e.message));
  await pbm.goto(f.base+'/IT_Ledger.html#inspections');await pbm.locator('[data-insp-row="'+draftBM.id+'"]').waitFor();
  await installNoticeCounter(pbm);
  await pbm.locator('[data-insp-continue="'+draftBM.id+'"]').click();await pbm.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbm);
  const heldSubmitBM=holdRequestRoute(pbm,'**/api/it-assets/inspections/sheets/'+draftBM.id+'/submit','POST');
  await pbm.locator('#itlFormSubmit').click();
  await heldSubmitBM.entered;
  await pbm.locator('#itlFormBack').click(); // 返回列表——leaveForm同步销毁会话(此刻无脏数据,不会另排离开冲刷)
  await pbm.locator('[data-insp-row]').first().waitFor();
  await pbm.locator('[data-insp-continue="'+draftBM.id+'"]').click(); // 立即继续填写同一张单——queueIdle(A)卡在挂起的submit后面
  const waitTextBM=await pbm.locator('#itlInspWaitPlaceholder').innerText();
  check('BM准备:queueIdle确实在等,占位出现',waitTextBM==='正在等待上次保存完成…',waitTextBM);
  const otherPutBM=await f.api('PUT','/inspections/sheets/'+draftBM.id,{expected_version:putBM.body.version,remark:'别处改的备注BM'},2);
  assert.equal(otherPutBM.status,200,'BM other put '+JSON.stringify(otherPutBM.body));
  heldSubmitBM.release(); // 放行：提交POST带旧version→409,落在已销毁会话上→notifyOutcome"未能提交"
  await pbm.waitForFunction(()=>window.__noticeCalls.some(m=>m.includes('未能提交')),null,{timeout:5000});
  const noticeTextBM=await pbm.locator('#itlNotice').innerText();
  check('BM(N-M1必修，Q1):提交409落地后notice是"未能提交..."',noticeTextBM.includes('未能提交'),noticeTextBM);
  await pbm.locator('#itlFormActionbar').waitFor({timeout:10000});await expandInspectionForm(pbm);
  const noticeTextAfterBM=await pbm.locator('#itlNotice').innerText();
  check('BM(N-M1必修，Q1)：占位落定(queueIdle解除,重开GET完成)之后,"未能提交"这条notice仍在(没有被占位清空逻辑连坐清掉)',noticeTextAfterBM.includes('未能提交'),noticeTextAfterBM);
  const serverBM=await getSheet(draftBM.id,2);
  check('BM(Q1):服务端该单仍是draft状态(提交确实没有成功)',serverBM.body.status==='draft',serverBM.body.status);
  check('浏览器无未捕获异常(BM)',errorsBM.length===0);
  await cbm.close();

  // BN) N-M1 Q4（C5a-g，搬入正式测试）：离开冲刷挂起→点"继续填写"(queueIdle等待,占位出现)→立即切到
  // 机柜页签——占位不应该残留在机柜视图上(放到列表视图自己的容器里，切页签后列表视图的DOM整体被替换，
  // 占位自然消失，不用专门清理)。
  const draftBN=await buildDraftSheet('SF-RoomBN',2);
  const airconBN=draftBN.items.find(it=>it.item_key==='aircon');
  const cbn=await browser.newContext();await cbn.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbn=await cbn.newPage();const errorsBN=[];pbn.on('pageerror',e=>errorsBN.push(e.message));
  await pbn.goto(f.base+'/IT_Ledger.html#inspections');await pbn.locator('[data-insp-row="'+draftBN.id+'"]').waitFor();
  await pbn.locator('[data-insp-continue="'+draftBN.id+'"]').click();await pbn.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbn);
  const heldBN=holdRequestRoute(pbn,'**/api/it-assets/inspections/sheets/'+draftBN.id,'PUT');
  await pbn.locator('[data-seg-ok="'+airconBN.id+'"]').click();
  await pbn.locator('#itlFormBack').click();await pbn.locator('[data-insp-row]').first().waitFor();
  await heldBN.entered;
  await pbn.locator('[data-insp-continue="'+draftBN.id+'"]').click(); // 继续填写——queueIdle等待,占位出现
  const waitTextBN=await pbn.locator('#itlInspWaitPlaceholder').innerText();
  check('BN准备:占位已出现(前提成立)',waitTextBN==='正在等待上次保存完成…',waitTextBN);
  await pbn.evaluate(()=>{location.hash='racks';});await pbn.locator('.itl-rack-workspace').waitFor();
  check('BN(N-M1必修，Q4)：切到机柜页签后,占位元素不存在(列表视图的DOM已经被机柜视图整体替换,不需要专门清理)',await pbn.locator('#itlInspWaitPlaceholder').count()===0);
  check('BN(N-M1必修，Q4)：#itlNotice全程未被这套占位机制写过内容',await pbn.locator('#itlNotice[hidden]').count()===1);
  heldBN.release();
  check('浏览器无未捕获异常(BN)',errorsBN.length===0);
  await cbn.close();

  // BO) N-M2（C5a-g，预筛MED，搬Q2进正式测试）：提交在可见会话里撞409→performSubmit自己调用
  // handleConflict→handleConflict内部的重取GET在途时用户离开→GET落地时会话已经销毁→handleConflict自己
  // 不发任何提示(它的判断是为performFlush场景设计的)→performSubmit在await handleConflict(f)之后补判一次
  // f.destroyed，发"未能提交"(这是N-M2要补的判断，与已有的BJ/BI都是不同代码路径：BJ测的是performSubmit
  // 外层catch的f.destroyed早判分支，BI测的是performFlush自己调handleConflict；BO专测performSubmit调
  // handleConflict这条链路)。
  const draftBO=await buildDraftSheet('SF-RoomBO',2);
  const filledBO=fillPayloadAllOk(draftBO.items);
  const putBO=await f.api('PUT','/inspections/sheets/'+draftBO.id,{expected_version:draftBO.version,items:filledBO},2);
  assert.equal(putBO.status,200,'BO put '+JSON.stringify(putBO.body));
  await uploadAllRackFrontPhotos(draftBO.id,draftBO.scope,2);
  const cbo=await browser.newContext();await cbo.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbo=await cbo.newPage();const errorsBO=[];pbo.on('pageerror',e=>errorsBO.push(e.message));
  await pbo.goto(f.base+'/IT_Ledger.html#inspections');await pbo.locator('[data-insp-row="'+draftBO.id+'"]').waitFor();
  await installNoticeCounter(pbo);
  await pbo.locator('[data-insp-continue="'+draftBO.id+'"]').click();await pbo.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbo);
  const heldSubmitBO=holdRequestRoute(pbo,'**/api/it-assets/inspections/sheets/'+draftBO.id+'/submit','POST');
  await pbo.locator('#itlFormSubmit').click();
  await heldSubmitBO.entered;
  const otherPutBO=await f.api('PUT','/inspections/sheets/'+draftBO.id,{expected_version:putBO.body.version,remark:'别处改的备注BO'},2);
  assert.equal(otherPutBO.status,200,'BO other put '+JSON.stringify(otherPutBO.body));
  const heldGetBO=holdRequestRoute(pbo,'**/api/it-assets/inspections/sheets/'+draftBO.id,'GET');
  heldSubmitBO.release(); // 放行：提交带旧version→409→performSubmit调handleConflict(f)→handleConflict发起重取GET
  await heldGetBO.entered; // handleConflict的重取GET也被挡住——此刻会话还没结束(仍可见)
  await pbo.evaluate(()=>{location.hash='racks';}); // GET在途时离开——触发onLeave→leaveForm：会话同步销毁
  await pbo.locator('.itl-rack-workspace').waitFor();
  heldGetBO.release(); // 放行handleConflict的重取GET——落地时f.destroyed已经是true
  await pbo.waitForFunction(()=>window.__noticeCalls.some(m=>m.includes('未能提交')),null,{timeout:5000});
  check('BO(N-M2必修)：放行后仍停在机柜视图,没有把填写页画回来',await pbo.locator('.itl-rack-workspace').count()===1&&await pbo.locator('#itlFormActionbar').count()===0);
  const noticeTextBO=await pbo.locator('#itlNotice').innerText();
  check('BO(N-M2必修)：提示是"未能提交：这张单已在别处被修改，请重新打开核对后再提交"(performSubmit在await handleConflict之后补判f.destroyed发出的)',noticeTextBO.includes('未能提交：这张单已在别处被修改，请重新打开核对后再提交'),noticeTextBO);
  check('BO(N-M2必修)："未能提交"类提示全程恰好调用1次',await pbo.evaluate(()=>window.__noticeCalls.filter(m=>m.includes('未能提交')).length)===1,await pbo.evaluate(()=>window.__noticeCalls));
  const serverBO=await getSheet(draftBO.id,2);
  check('BO(N-M2)：服务端该单仍是draft状态(提交确实没有成功)',serverBO.body.status==='draft',serverBO.body.status);
  check('浏览器无未捕获异常(BO)',errorsBO.length===0);
  await cbo.close();

  // BP) N-L1（C5a-g，预筛LOW，搬Q6进正式测试）：openInspectionSheet同页签触发leaveForm(A)之后，A的
  // 填写页DOM应该被同步换成加载占位——不再是原样留着、可点、点了真的发PUT。
  const draftBP_A=await buildDraftSheet('SF-RoomBPA',2);
  const draftBP_B=await buildDraftSheet('SF-RoomBPB',2);
  const upsBP=draftBP_A.items.find(it=>it.item_key==='ups');
  const cbp=await browser.newContext();await cbp.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbp=await cbp.newPage();const errorsBP=[];pbp.on('pageerror',e=>errorsBP.push(e.message));
  await pbp.goto(f.base+'/IT_Ledger.html#inspections');await pbp.locator('[data-insp-row="'+draftBP_A.id+'"]').waitFor();
  await pbp.locator('[data-insp-continue="'+draftBP_A.id+'"]').click();await pbp.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbp);
  const putsBP=[];pbp.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/inspections/sheets/'+draftBP_A.id))putsBP.push(r.postData());});
  const heldGetBP=holdRequestRoute(pbp,'**/api/it-assets/inspections/sheets/'+draftBP_B.id,'GET');
  await pbp.evaluate(id=>{window.ITLedger.openInspectionSheet(id);},draftBP_B.id); // 同页签跳转——leaveForm(A)同步销毁,DOM应换成加载占位
  await heldGetBP.entered;
  const stillAVisibleBP=await pbp.locator('[data-sheet-id="'+draftBP_A.id+'"]').count();
  check('BP(N-L1必修)：leaveForm(A)后A的填写页根节点已经不在DOM里(被同步换成加载占位)',stillAVisibleBP===0,stillAVisibleBP);
  check('BP(N-L1必修)：内容区显示加载占位文案"正在读取…"',(await pbp.locator('#itlContent').innerText()).includes('正在读取'));
  const upsSelectorCountBP=await pbp.locator('[data-seg-ok="'+upsBP.id+'"]').count();
  check('BP(N-L1必修)：原来的开关按钮选择器在当前DOM里也查不到(不只是视觉盖住，是真的被替换掉了)',upsSelectorCountBP===0,upsSelectorCountBP);
  heldGetBP.release();
  await pbp.locator('[data-sheet-id="'+draftBP_B.id+'"]').waitFor({timeout:10000});
  check('BP(N-L1必修)：全程对A没有发出过任何PUT(没有发生Q6原本那种"点了真的写库"的误操作)',putsBP.length===0,putsBP);
  check('浏览器无未捕获异常(BP)',errorsBP.length===0);
  await cbp.close();

  // PD) item D（C5a-g追加D，MED-2的另一半）：A"继续填写"的GET挂起期间，直接点B的行进入只读详情（B已
  // 提交，走的是查看入口，不经过openInspectionSheet，走openDetail自己的++sequence）——放行A的迟到200后
  // 应该仍停在B。变异目标：把openDetail自己的++sequence去掉会让这里首红(A的stillValid()判据因为
  // sequence没被B推进而误判"仍然有效"，把画面改判回A)。
  const draftPD=await buildDraftSheet('PD-RoomA',2);
  const submittedPD=await buildSubmittedSheet('PD-RoomB',2,false);
  const cpd=await browser.newContext();await cpd.addInitScript(()=>localStorage.setItem('token','fixture-2'));const ppd=await cpd.newPage();const errorsPD=[];ppd.on('pageerror',e=>errorsPD.push(e.message));
  await ppd.goto(f.base+'/IT_Ledger.html#inspections');await ppd.locator('[data-insp-row="'+draftPD.id+'"]').waitFor();
  let releasePD,enteredPD;
  const enteredPDP=new Promise(r=>enteredPD=r),heldPDP=new Promise(r=>releasePD=r);
  await ppd.route('**/api/it-assets/inspections/sheets/'+draftPD.id,async route=>{
   if(route.request().method()!=='GET')return route.fallback();
   enteredPD();await heldPDP;await route.fallback();
  });
  await ppd.locator('[data-insp-continue="'+draftPD.id+'"]').click();
  await enteredPDP;
  await ppd.locator('[data-insp-view="'+submittedPD.id+'"]').click();
  await ppd.locator('[data-sheet-id="'+submittedPD.id+'"]').waitFor({timeout:10000});
  check('PD准备:B(只读详情)先落地(标题PD-RoomB,前提成立)',(await ppd.locator('.itl-sheet-title h2').innerText()).includes('PD-RoomB'));
  const settledBeforePD=await ppd.evaluate(()=>window.ITLedger.__inspLoadSettled);
  const okPDResponse=ppd.waitForResponse(r=>r.url().endsWith('/api/it-assets/inspections/sheets/'+draftPD.id)&&r.request().method()==='GET');
  releasePD();
  await okPDResponse;
  await ppd.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBeforePD,{timeout:5000});
  const rootIdPD=await ppd.locator('.itl-sheet-toolbar').getAttribute('data-sheet-id');
  check('PD(item D必修)：A迟到的真实200释放后,data-sheet-id仍等于B(openDetail自己的++sequence让A的stillValid()判据失效)',rootIdPD===String(submittedPD.id),rootIdPD);
  check('PD(item D必修)：标题仍是PD-RoomB(未被改判回填写页A)',(await ppd.locator('.itl-sheet-title h2').innerText()).includes('PD-RoomB'));
  check('浏览器无未捕获异常(PD)',errorsPD.length===0);
  await cpd.close();

  // BQ) N-L2（C5a-g）：只读详情页也挂常驻条。构造改动说明（本批实测发现的平台既有约束，如实记录）：
  // 原计划用ACL降级触发真实403来构造reason="编辑权限已变化"，实测会命中it-ledger.js:87的全局403兜底
  // （state.level=null+clearData()把#itlContent整体replaceChildren()清空+隐藏#itlTabs+"请重新打开
  // 页面"提示）——这是平台既有的、本批不改的行为，命中后同一页面会话内无法再继续导航到详情页验证渲染
  // （#itlContent被清空且tabs隐藏，不会再重新渲染）。改用不触发全局兜底的构造：浏览器里正常留下一条
  // 通用原因的常驻条（网络异常路径，同BK/BR），随后绕开浏览器直接用API把这张单填完并提交（服务端状态
  // 变为submitted，与浏览器那次失败的PUT无关——那次从未真正落库），让"重开时GET的actions不再含save"
  // 这个条件成立而不依赖真实403。这样验证的是N-L2的结构性要求——renderDetailView确实调用了
  // renderUnsavedFormBanner，只读详情页顶部也显示常驻条；"编辑权限已变化"这一专属措辞由mapFailureReason
  // (error.status===403时返回该文案)与unsavedEntryHtml的allPermission分支代码本身核对，不在此处用
  // 无法达成的真实403构造去验证（见上述平台约束）。
  const draftBQ=await buildDraftSheet('SF-RoomBQ',2);
  const airconBQ=draftBQ.items.find(it=>it.item_key==='aircon');
  const cbq=await browser.newContext();await cbq.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbq=await cbq.newPage();const errorsBQ=[];pbq.on('pageerror',e=>errorsBQ.push(e.message));
  await pbq.goto(f.base+'/IT_Ledger.html#inspections');await pbq.locator('[data-insp-row="'+draftBQ.id+'"]').waitFor();
  await pbq.route('**/api/it-assets/inspections/sheets/'+draftBQ.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await pbq.locator('[data-insp-continue="'+draftBQ.id+'"]').click();await pbq.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbq);
  const settledBeforeBQ=await pbq.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbq.locator('[data-seg-ok="'+airconBQ.id+'"]').click();
  await pbq.locator('#itlFormBack').click();await pbq.locator('[data-insp-row]').first().waitFor();
  await pbq.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeBQ,{timeout:5000});
  check('BQ准备:离开失败,常驻条已生成(前提成立)',await pbq.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBQ.id+'"]').count()===1);
  const detailBQ=await getSheet(draftBQ.id,2);
  const filledBQ=fillPayloadAllOk(detailBQ.body.items);
  const putBQ=await f.api('PUT','/inspections/sheets/'+draftBQ.id,{expected_version:detailBQ.body.version,items:filledBQ},2);
  assert.equal(putBQ.status,200,'BQ put '+JSON.stringify(putBQ.body));
  await uploadAllRackFrontPhotos(draftBQ.id,draftBQ.scope,2);
  const submitBQ=await f.api('POST','/inspections/sheets/'+draftBQ.id+'/submit',{expected_version:putBQ.body.version},2);
  assert.equal(submitBQ.status,200,'BQ submit '+JSON.stringify(submitBQ.body));
  // 提交是绕开浏览器直接用API做的，列表里那一行还是刚才留下的旧DOM(仍是"继续填写")——用页签往返强制
  // 列表重新load()一次(不是整页reload，不会清掉本页JS内存里的unsavedBySheetId登记表)，行才会刷新成
  // "查看"。
  await pbq.evaluate(()=>{location.hash='racks';});await pbq.locator('.itl-rack-workspace').waitFor();
  await pbq.evaluate(()=>{location.hash='inspections';});await pbq.locator('[data-insp-row]').first().waitFor();
  await pbq.locator('[data-insp-view="'+draftBQ.id+'"]').click();
  await pbq.locator('.itl-sheet-title h2').waitFor();
  check('BQ准备:重开确实落到只读详情(无#itlFormActionbar,前提成立)',await pbq.locator('#itlFormActionbar').count()===0);
  const bannerBQ=await pbq.locator('#itlUnsavedForm [data-unsaved-sheet="'+draftBQ.id+'"]').innerText();
  check('BQ(N-L2必修，结构性)：只读详情页顶部也显示常驻条(renderDetailView确实调用了renderUnsavedFormBanner)，含原文"空调运行：正常"',bannerBQ.includes('空调运行：正常'),bannerBQ);
  check('BQ(L2)：只读详情常驻条不指示用户在本页补填',!bannerBQ.includes('补填'),bannerBQ);
  await pbq.locator('#itlUnsavedForm [data-unsaved-ack="'+draftBQ.id+'"]').click();
  check('BQ(M3)：只读详情点知道了后常驻条立即消失',await pbq.locator('#itlUnsavedForm [data-unsaved-sheet="'+draftBQ.id+'"]').count()===0);
  check('浏览器无未捕获异常(BQ)',errorsBQ.length===0);
  await cbq.close();

  // BR) N-L3（C5a-g）：单据已删除时常驻条加"（该单已删除）"且不说"重新打开该单补填"。
  const draftBR=await buildDraftSheet('SF-RoomBR',2);
  const airconBR=draftBR.items.find(it=>it.item_key==='aircon');
  const cbr=await browser.newContext();await cbr.addInitScript(()=>localStorage.setItem('token','fixture-2'));
  const pbr=await cbr.newPage();const errorsBR=[];pbr.on('pageerror',e=>errorsBR.push(e.message));
  await pbr.goto(f.base+'/IT_Ledger.html#inspections');await pbr.locator('[data-insp-row="'+draftBR.id+'"]').waitFor();
  await pbr.route('**/api/it-assets/inspections/sheets/'+draftBR.id,route=>route.request().method()==='PUT'?route.abort('failed'):route.fallback());
  await pbr.locator('[data-insp-continue="'+draftBR.id+'"]').click();await pbr.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbr);
  const settledBeforeBR=await pbr.evaluate(()=>window.ITLedger.__inspFormFlushSettled);
  await pbr.locator('[data-seg-ok="'+airconBR.id+'"]').click();
  await pbr.locator('#itlFormBack').click();await pbr.locator('[data-insp-row]').first().waitFor();
  await pbr.waitForFunction(base=>window.ITLedger.__inspFormFlushSettled>=base+1,settledBeforeBR,{timeout:5000});
  const bannerBeforeDeleteBR=await pbr.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBR.id+'"]').innerText();
  check('BR准备:删除前常驻条存在(前提成立)',bannerBeforeDeleteBR.includes(sheetLabelStr(draftBR)),bannerBeforeDeleteBR);
  await pbr.locator('[data-insp-delete-draft="'+draftBR.id+'"]').click();
  await pbr.waitForFunction(()=>document.querySelector('#itlModalTitle')?.textContent==='删除草稿',null,{timeout:5000});
  await pbr.locator('#itlSubmit').click();
  await pbr.locator('#itlToast:not([hidden])').waitFor();
  const bannerAfterDeleteBR=await pbr.locator('#itlUnsavedList [data-unsaved-sheet="'+draftBR.id+'"]').innerText();
  check('BR(N-L3必修)：单删除后常驻条仍在(用户还没点"知道了")，含"（该单已删除）"，不说"重新打开该单补填"',bannerAfterDeleteBR.includes('（该单已删除）')&&!bannerAfterDeleteBR.includes('重新打开该单补填'),bannerAfterDeleteBR);
  check('浏览器无未捕获异常(BR)',errorsBR.length===0);
  await cbr.close();

  // BS) C5c（方案v0.6§6"设备采集明细展开"条，spec-C5c.md）+ C5c-b（Opus预筛1H/2M/6L收口，spec-
  // C5c-b.md）：设备段展开/收起——默认收起、有告警默认展开、展开区三块内容(整机/物理硬盘/Windows卷
  // 空间)取值与标红/标橙阈值（H1：计算样式而不只查class；M1(b)：物理硬盘标红/标橙判据与采集器
  // inspection-collector.js:23-25 同构）、顶部渲染alerts与component_errors（M1(a)）、收起再展开命中
  // 缓存不重新请求、非404失败点击展开时删缓存重试（L3）、整表重绘(recollect触发)不丢展开状态也不
  // 影响其它设备段以外的输入框、该行重新采集后显示新快照、GET失败(网络异常走mapFailureReason/404走
  // 固定文案)、只读详情页同样有效(smoke)、以及离开重开产生新会话后旧请求的迟到回调不污染新会话DOM
  // (M2会话守卫，用独立的一张单+独立浏览器上下文，见T块，不与下面四台设备共用同一张单——那张单会走到
  // 提交，不能留一台"未处理告警"的设备卡住提交)。四台设备共用一个夹具：device1(有告警+
  // component_errors+标红标橙全量场景,承担阈值/收起展开/recollect/L4/L5断言)、device2(无告警,默认
  // 收起,承担"另一台设备展开不影响输入框"与"重绘不丢状态"断言)、device3(预取即网络异常,承担L3非404
  // 重试)、device4(预取即404,承担L3保留缓存不重试)。
  const overridesBS={};
  const HOST_BS='203.0.113.19';
  const collectorBS={host:()=>HOST_BS,collect:async()=>{const now=new Date().toISOString();return {schema_version:1,source_host:HOST_BS,collection_status:overridesBS.collectionStatus||'success',started_at:now,completed_at:now,server:overridesBS.server,physical_disks:overridesBS.disks||[],volumes:overridesBS.vols||[],virtual_disks:[],enclosures:[],alerts:overridesBS.alerts||[],component_errors:overridesBS.errors||[],cleanup_warnings:[]};}};
  const fBS=await createFixture({inspectionCollector:collectorBS});
  let cbs1,cbs2,cbs3;
  try{
    const rackBS=(await fBS.api('POST','/racks',{name:'SF-RoomBS-柜1',room:'SF-RoomBS',u_total:20})).body;
    const mkDevBS=async(idx,sn)=>(await fBS.api('POST','',{category:'server',name:'SF-RoomBS-设备'+idx,sn,attrs:{ip:HOST_BS},u_height:1,placement:{kind:'rack',rack_id:rackBS.id,u_start:idx}})).body;
    const dev1BS=await mkDevBS(1,'SN-BS-1'),dev2BS=await mkDevBS(2,'SN-BS-2'),dev3BS=await mkDevBS(3,'SN-BS-3'),dev4BS=await mkDevBS(4,'SN-BS-4');
    const createdBS=await fBS.api('POST','/inspections/sheets',{room_name:'SF-RoomBS'},2);
    assert.equal(createdBS.status,201,'BS create '+JSON.stringify(createdBS.body));
    const deviceItemsBS=createdBS.body.items.filter(it=>it.section==='device');
    const item1BS=deviceItemsBS.find(it=>it.target_id===dev1BS.id),item2BS=deviceItemsBS.find(it=>it.target_id===dev2BS.id),item3BS=deviceItemsBS.find(it=>it.target_id===dev3BS.id),item4BS=deviceItemsBS.find(it=>it.target_id===dev4BS.id);
    const tempItemIdBS=createdBS.body.items.find(it=>it.item_key==='temperature').id;
    const collectAsBS=async(item,sn,opts)=>{
      // L4：cpus 默认仍是普通数字；device1 专门传 XSS payload 进 cores，验证前端 esc() 自己转义（假
      // 采集器是测试替身，不经真实 collector 的 Number(...)||0 强制转换，不能靠"上游一定是数字"这个
      // 隐式假设）。
      overridesBS.server={name:'srv',manufacturer:'x',model:opts.model,serial_number:sn,os:'Windows Server 2022',memory_bytes:34359738368,cpus:opts.cpus||[{name:'Xeon测试',cores:8,threads:16}]};
      overridesBS.disks=opts.disks||[];overridesBS.vols=opts.vols||[];overridesBS.alerts=opts.alerts||[];overridesBS.errors=opts.errors||[];overridesBS.collectionStatus=opts.collectionStatus||'success';
      const r=await fBS.api('POST','/inspections/sheets/'+createdBS.body.id+'/items/'+item.id+'/collect',undefined,2);
      assert.equal(r.status,201,'BS collect '+sn+' '+JSON.stringify(r.body));
      return r.body;
    };
    const disksAlertBS=[
      {controller_id:'0',source_id:'0:0:0',model:'DiskModelA',serial_number:'DISK-BS-1',capacity_bytes:2000398934016,protocol:'SAS',state:'Online',status:'Ok',failure_predicted:false},
      {controller_id:'0',source_id:'0:0:1',model:'DiskModelB',serial_number:'DISK-BS-2',capacity_bytes:2000398934016,protocol:'SAS',state:'Failed',status:'Critical',failure_predicted:true},
      // M1(b) 边界：Offline 且未预测故障——标红判据是 state 不在 {Online,Ready}，不是只认 Failed。
      {controller_id:'0',source_id:'0:0:2',model:'DiskModelD',serial_number:'DISK-BS-4',capacity_bytes:2000398934016,protocol:'SAS',state:'Offline',status:'Ok',failure_predicted:false},
      // M1(b) 边界：在线（Online）但 status≠Ok——标橙（与采集器 disk_warning 同构），不是标红。
      {controller_id:'0',source_id:'0:0:3',model:'DiskModelE',serial_number:'DISK-BS-5',capacity_bytes:2000398934016,protocol:'SAS',state:'Online',status:'Degraded',failure_predicted:false},
      // C7-d（C5c-b拿不准⑤第3条，逐档对齐采集器）：在线但status==='Critical'——标红，不是并入橙色
      // （采集器disk_warning分支对status==='Critical'自己也判critical，见inspection-collector.js:25）。
      {controller_id:'0',source_id:'0:0:4',model:'DiskModelG',serial_number:'DISK-BS-7',capacity_bytes:2000398934016,protocol:'SAS',state:'Online',status:'Critical',failure_predicted:false},
    ];
    const volsAlertBS=[
      {name:'C:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:50000000000,free_percent:50},
      {name:'D:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:5000000000,free_percent:5},
      // M2 阈值边界：恰好10不标橙，9.99标橙（判据是<10，不是<=10）。
      {name:'E:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:10000000000,free_percent:10},
      {name:'F:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:9990000000,free_percent:9.99},
      // L5：free_percent 非有限数——显示"—"且不标色，不是"NaN%"。
      {name:'G:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:NaN,free_percent:NaN},
    ];
    const collect1BS=await collectAsBS(item1BS,'SN-BS-1',{model:'DeviceModelBS1',disks:disksAlertBS,vols:volsAlertBS,collectionStatus:'partial',cpus:[{name:'Xeon测试',cores:XSS,threads:16}],alerts:[{severity:'critical',kind:'physical_disk',message:'控制器0 / 0:0:1（DISK-BS-2）：Failed'},{severity:'attention',kind:'volume_space',message:'卷 D: 可用空间不足'}],errors:['控制器0未取得虚拟盘清单']});
    const collect2BS=await collectAsBS(item2BS,'SN-BS-2',{model:'DeviceModelBS2',disks:[{controller_id:'0',source_id:'0:0:0',model:'DiskModelC',serial_number:'DISK-BS-3',capacity_bytes:2000398934016,protocol:'SAS',state:'Online',status:'Ok',failure_predicted:false}],vols:[{name:'C:',filesystem:'NTFS',size_bytes:100000000000,free_bytes:60000000000,free_percent:60}],alerts:[]});
    const collect3BS=await collectAsBS(item3BS,'SN-BS-3',{model:'DeviceModelBS3',disks:[],vols:[],alerts:[]});
    const collect4BS=await collectAsBS(item4BS,'SN-BS-4',{model:'DeviceModelBS4',disks:[],vols:[],alerts:[]});

    const errorsBS=[];
    cbs1=await browser.newContext();await cbs1.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbs=await cbs1.newPage();pbs.on('pageerror',e=>errorsBS.push(e.message));
    // M（codex 46-R→46-R2）：__inspLoadSettled 是全局计数器，"涨够4"这个信号本身分不清这4次增量是不是
    // 恰好来自这四台设备的详情预取——如果被其它无关请求污染（或者同一台设备被请求了两次、另一台漏了），
    // 单纯看计数字面值也可能凑巧等于4。精确记录id集合、逐个比对（不只看数量）。
    // C7-f H3（codex 46-R2）：46-R版本监听的是'request'事件——只证明请求已发出，不证明已完成；也没按
    // method过滤；waitForFunction用">=base+4"，多算一次也会放行。这次改成：①只认GET；②"完成"以真实
    // 落定为准——route.fulfill()产生的响应(device1/2/4)走'response'事件，route.abort()造成的网络异常
    // (device3)永远不会有'response'，走'requestfailed'事件；③点continue之前先挂好这四条各自的
    // waitForResponse/等待requestfailed的Promise，点击后Promise.all等四条全部真正落定，再读id集合；
    // ④__inspLoadSettled最终核对改"恰为"base+4，不是"至少"——多算一次(比如被其它操作误触发自增)必须
    // 被拦下，不能被">="放过。
    // 网络异常/404 两个探针路由必须在打开表单前注册——展开按钮渲染那一刻(section首次画出来)就会后台
    // 预取详情，不是等用户点击才发请求（见deviceExpandHtml头部"默认展开"取舍）。
    await pbs.route('**/api/it-assets/inspections/'+collect3BS.inspection.id,route=>route.abort('failed'));
    await pbs.route('**/api/it-assets/inspections/'+collect4BS.inspection.id,route=>route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'LEDGER_NOT_FOUND',message:'巡检记录不存在'})}));
    await pbs.goto(fBS.base+'/IT_Ledger.html#inspections');await pbs.locator('[data-insp-row="'+createdBS.body.id+'"]').waitFor();
    // H（codex 47，C5c-b 预筛复审）：四台设备的展开区都在渲染那一刻后台预取（deviceExpandHtml 头部
    // "默认展开"取舍），点continue之前记下__inspLoadSettled基线，之后等它恰为base+4（device1-4各自的
    // ensureDeviceDetail .then()/.catch()都恰好增1次，含被abort/404拦下的device3/4），才能确认"这
    // 四条预取全部已经落地"，不能只等device1的h4出现就去断言device2——device2没有告警，它自己的
    // 预取回调如果被"默认展开"的判据搞错了(比如无告警也误展开)，只等device1不会等到device2那次回调
    // 真正落地，断言可能在device2的回调还没跑完时就提前读到"仍是初始收起态"这个巧合结果，不是"确实
    // 判定过不该展开"。
    const settledBaselineBS=await pbs.evaluate(()=>window.ITLedger.__inspLoadSettled);
    // 只记录基线之后的GET详情响应/失败事件——监听器在读完__inspLoadSettled基线之后才挂，不早挂（虽然
    // goto的列表页/路由拦截阶段本来就不会命中这条'/inspections/<数字>$'正则，但"只认基线之后"这句话在
    // 代码结构上也要对应得上，不靠巧合）。
    const inspDetailSettledIds=[];
    const onRespBS=resp=>{if(resp.request().method()!=='GET')return;const m=resp.url().match(/\/api\/it-assets\/inspections\/(\d+)$/);if(m)inspDetailSettledIds.push(Number(m[1]));};
    const onFailBS=req=>{if(req.method()!=='GET')return;const m=req.url().match(/\/api\/it-assets\/inspections\/(\d+)$/);if(m)inspDetailSettledIds.push(Number(m[1]));};
    pbs.on('response',onRespBS);pbs.on('requestfailed',onFailBS);
    const expectedDetailIdsBS=[collect1BS.inspection.id,collect2BS.inspection.id,collect3BS.inspection.id,collect4BS.inspection.id].slice().sort((a,b)=>a-b);
    const waitDetailBS=rid=>pbs.waitForResponse(r=>r.request().method()==='GET'&&new RegExp('/api/it-assets/inspections/'+rid+'$').test(r.url()),{timeout:5000});
    const waitFailBS=rid=>pbs.waitForEvent('requestfailed',{predicate:r=>r.method()==='GET'&&new RegExp('/api/it-assets/inspections/'+rid+'$').test(r.url()),timeout:5000});
    // device1/2/4走真实响应(含404)，device3被abort走requestfailed；四个Promise在click之前就挂好，
    // Promise.all等它们全部落定——只要有一个还没完成(比如某台响应被挂起)，下面的await就不会返回，原
    // 断言(id集合/收起态)不会被提前判定。
    const settleWaitsBS=[waitDetailBS(collect1BS.inspection.id),waitDetailBS(collect2BS.inspection.id),waitFailBS(collect3BS.inspection.id),waitDetailBS(collect4BS.inspection.id)];
    await pbs.locator('[data-insp-continue="'+createdBS.body.id+'"]').click();await pbs.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbs);
    await Promise.all(settleWaitsBS);
    pbs.off('response',onRespBS);pbs.off('requestfailed',onFailBS);
    const gotDetailIdsBS=inspDetailSettledIds.slice().sort((a,b)=>a-b);
    check('M(codex46-R2):基线之后完成(GET响应落地或requestfailed网络异常落地)的详情请求id集合恰好是这四台设备各一次(不是被其它请求污染,也不是漏了/重了某一台)',JSON.stringify(gotDetailIdsBS)===JSON.stringify(expectedDetailIdsBS),{got:inspDetailSettledIds,expected:expectedDetailIdsBS});
    // C7-f(H3) 复核：实测(隔离树跑通)__inspLoadSettled 在点continue之后不是只涨4次——点击触发的是
    // openDraftById→openDraftByIdFresh，它自己的整单GET（fetchSheetForOpen）落地时也调用一次
    // L.__inspLoadSettled++（it-ledger-inspection-sheets.js:2009，openForm(detail)渲染完表单/触发四台
    // 设备的预取fetch之后，同步紧跟着执行，早于四条设备预取各自的网络往返落地），所以"整单打开"这一次
    // 与"四台设备预取"那四次一共是5次，不是4次；baseline是在点击前读的，必须把这次"整单打开"的自增也
    // 算进去。核实过this fixture这条路径（owner uid2打开自己的draft，detail.actions必含save）恒定
    // 触发这条支线，不受随机性影响——直接把codex 46-R2文字里的"+4"改成实测验证过的"+5"，不盲从字面，
    // 语义仍是"恰好"（不是"至少”）：四台设备预取的id集合已经在上面单独逐一验证过，这里只再核一次总数
    // 没有被除此之外的任何操作污染。
    await pbs.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+5,settledBaselineBS,{timeout:5000});
    const finalSettledBS=await pbs.evaluate(()=>window.ITLedger.__inspLoadSettled);
    check('C7-f(H3,codex46-R2):__inspLoadSettled最终恰为基线+5(整单打开1次+四台设备预取4次),不是"至少"(拦下被其它操作多算一次)',finalSettledBS===settledBaselineBS+5,{settledBaselineBS,finalSettledBS});

    // 默认展开：device1有告警→展开；device2无告警→收起。四条预取都已确认落地(上面的等待)。
    check('BS:有告警的设备默认展开',await pbs.locator('[data-device-detail="'+item1BS.id+'"]').isVisible());
    check('BS:展开按钮文案为"收起"',(await pbs.locator('[data-device-expand="'+item1BS.id+'"]').innerText())==='收起');
    // H（codex 47）：这条断言现在backed by上面对__inspLoadSettled+4的等待——device2自己的预取回调
    // 确实已经落地，不是"还没跑到就巧合读到初始收起态"。
    check('BS:无告警的设备默认收起',await pbs.locator('[data-device-detail="'+item2BS.id+'"]').isHidden());
    check('BS:无告警设备的展开按钮文案为"展开明细"',(await pbs.locator('[data-device-expand="'+item2BS.id+'"]').innerText())==='展开明细');

    // H1（C5c-b，Opus预筛）：计算样式断言——不能只查class名，要核对浏览器最终算出的颜色真的是红/橙
    // （components.css 的`.u-corr-table td{color:#374151}`特异度比单class的
    // itl-inspection-critical/warning更高，旧写法class加上了但算出来仍是灰色，只查class的断言看不
    // 出这个坑；it-ledger.css 里新加了两条`.itl-sheet-device-detail td.xxx`选择器补特异度）。
    const cssVarColorBS=v=>pbs.evaluate(name=>{const el=document.createElement('span');el.style.color='var('+name+')';document.body.appendChild(el);const c=getComputedStyle(el).color;el.remove();return c;},v);
    const dangerColorBS=await cssVarColorBS('--color-danger'),warningColorBS=await cssVarColorBS('--color-warning');
    const colorOfBS=loc=>loc.evaluate(el=>getComputedStyle(el).color);

    // 三块内容：M1(a) 顶部告警+采集不完整提示；整机/物理硬盘/Windows卷空间。
    const detail1TextBS=await pbs.locator('[data-device-detail="'+item1BS.id+'"]').innerText();
    check('BS:整机块含型号/SN/系统/CPU/内存',detail1TextBS.includes('DeviceModelBS1')&&detail1TextBS.includes('SN-BS-1')&&detail1TextBS.includes('Windows Server 2022')&&detail1TextBS.includes('Xeon测试')&&detail1TextBS.includes('32GB'),detail1TextBS);
    check('BS:物理硬盘块含5块盘各自的型号/SN',detail1TextBS.includes('DiskModelA')&&detail1TextBS.includes('DISK-BS-1')&&detail1TextBS.includes('DiskModelB')&&detail1TextBS.includes('DISK-BS-2')&&detail1TextBS.includes('DiskModelD')&&detail1TextBS.includes('DISK-BS-4')&&detail1TextBS.includes('DiskModelE')&&detail1TextBS.includes('DISK-BS-5')&&detail1TextBS.includes('DiskModelG')&&detail1TextBS.includes('DISK-BS-7'),detail1TextBS);
    // L4：cores传的是XSS payload——window.__xss未定义证明没有真的执行；HTML源码里应该是转义实体
    // （&lt;img），不能出现真的<img标签（那样才叫“只是esc()把它当纯文本显示”）。
    const detail1HtmlBS=await pbs.locator('[data-device-detail="'+item1BS.id+'"]').innerHTML();
    check('L4:CPU核数字段的XSS payload未被执行(window.__xss未定义)',await pbs.evaluate(()=>window.__xss)===undefined);
    check('L4:CPU核数字段XSS payload在HTML源码里是转义实体,不是真标签',detail1HtmlBS.includes('&lt;img')&&!/<img[\s>]/.test(detail1HtmlBS),detail1HtmlBS.slice(detail1HtmlBS.indexOf('CPU')-40,detail1HtmlBS.indexOf('CPU')+200));
    // M1(a)：采集不完整提示下逐条列出component_errors；alerts顶部渲染，critical标红、attention不标红。
    check('M1(a):采集不完整提示且逐条列出component_errors',detail1TextBS.includes('采集不完整')&&detail1TextBS.includes('控制器0未取得虚拟盘清单'),detail1TextBS);
    check('M1(a):告警标题带条数',detail1TextBS.includes('告警 · 2 条'),detail1TextBS);
    const alertParasBS=await pbs.locator('[data-device-detail="'+item1BS.id+'"] p').evaluateAll(ps=>ps.map(p=>({text:p.textContent,color:getComputedStyle(p).color})));
    const criticalAlertParaBS=alertParasBS.find(p=>p.text.includes('Failed')&&p.text.includes('控制器0'));
    const attentionAlertParaBS=alertParasBS.find(p=>p.text.includes('可用空间不足'));
    check('M1(a):critical级告警计算颜色等于--color-danger',!!criticalAlertParaBS&&criticalAlertParaBS.color===dangerColorBS,{criticalAlertParaBS,dangerColorBS});
    check('M1(a):attention级告警不标红(计算颜色不等于--color-danger)',!!attentionAlertParaBS&&attentionAlertParaBS.color!==dangerColorBS,{attentionAlertParaBS,dangerColorBS});

    const diskTableBS=pbs.locator('[data-device-detail="'+item1BS.id+'"] table').nth(0);
    const okDiskStateCellBS=diskTableBS.locator('tr').nth(1).locator('td').nth(3);
    const badDiskStateCellBS=diskTableBS.locator('tr').nth(2).locator('td').nth(3);
    const badDiskPredictCellBS=diskTableBS.locator('tr').nth(2).locator('td').nth(4);
    const offlineDiskCellBS=diskTableBS.locator('tr').nth(3).locator('td').nth(3);
    const degradedDiskCellBS=diskTableBS.locator('tr').nth(4).locator('td').nth(3);
    const criticalStatusDiskCellBS=diskTableBS.locator('tr').nth(5).locator('td').nth(3);
    check('BS:正常盘状态列不标红(class)',!(await okDiskStateCellBS.getAttribute('class')||'').includes('itl-inspection-critical'));
    check('H1:正常盘状态列计算颜色不等于--color-danger',(await colorOfBS(okDiskStateCellBS))!==dangerColorBS);
    check('BS:Failed盘状态列标红(class)',(await badDiskStateCellBS.getAttribute('class')||'').includes('itl-inspection-critical'));
    check('H1:Failed盘状态列计算颜色等于--color-danger',(await colorOfBS(badDiskStateCellBS))===dangerColorBS);
    check('BS:预测故障为是的盘该列也标红且文案为"是"(class)',(await badDiskPredictCellBS.getAttribute('class')||'').includes('itl-inspection-critical')&&(await badDiskPredictCellBS.innerText())==='是');
    check('H1:预测故障列计算颜色等于--color-danger',(await colorOfBS(badDiskPredictCellBS))===dangerColorBS);
    // M1(b) 边界：Offline未预测故障——标红（state不在{Online,Ready}），不是只认Failed。
    check('M1(b):Offline盘(未预测故障)状态列标红(class)',(await offlineDiskCellBS.getAttribute('class')||'').includes('itl-inspection-critical'));
    check('M1(b)+H1:Offline盘状态列计算颜色等于--color-danger',(await colorOfBS(offlineDiskCellBS))===dangerColorBS);
    // M1(b) 边界：在线但status=Degraded——标橙（disk_warning同构），不是标红。
    check('M1(b):在线但status=Degraded的盘状态列标橙(class)不标红',(await degradedDiskCellBS.getAttribute('class')||'').includes('itl-inspection-warning')&&!(await degradedDiskCellBS.getAttribute('class')||'').includes('itl-inspection-critical'));
    check('M1(b)+H1:在线但status=Degraded的盘状态列计算颜色等于--color-warning',(await colorOfBS(degradedDiskCellBS))===warningColorBS);
    // C7-d 第5条：在线但status==='Critical'——逐档对齐采集器，标红，不是并入橙色。
    check('C7-d:在线但status=Critical的盘状态列标红(class)不标橙',(await criticalStatusDiskCellBS.getAttribute('class')||'').includes('itl-inspection-critical')&&!(await criticalStatusDiskCellBS.getAttribute('class')||'').includes('itl-inspection-warning'));
    check('C7-d+H1:在线但status=Critical的盘状态列计算颜色等于--color-danger',(await colorOfBS(criticalStatusDiskCellBS))===dangerColorBS);

    const volTableBS=pbs.locator('[data-device-detail="'+item1BS.id+'"] table').nth(1);
    const okVolCellBS=volTableBS.locator('tr').nth(1).locator('td').nth(3);
    const badVolCellBS=volTableBS.locator('tr').nth(2).locator('td').nth(3);
    const boundary10CellBS=volTableBS.locator('tr').nth(3).locator('td').nth(3);
    const boundary999CellBS=volTableBS.locator('tr').nth(4).locator('td').nth(3);
    const naCellBS=volTableBS.locator('tr').nth(5).locator('td').nth(3);
    check('BS:可用比例50%不标橙(class)',!(await okVolCellBS.getAttribute('class')||'').includes('itl-inspection-warning'));
    check('H1:可用比例50%计算颜色不等于--color-warning',(await colorOfBS(okVolCellBS))!==warningColorBS);
    check('BS:可用比例5%标橙且数值正确(class)',(await badVolCellBS.getAttribute('class')||'').includes('itl-inspection-warning')&&(await badVolCellBS.innerText())==='可用 5%');
    check('H1:可用比例5%计算颜色等于--color-warning',(await colorOfBS(badVolCellBS))===warningColorBS);
    // M2 阈值边界：恰好10不标橙（判据是<10，不是<=10）。
    check('M2:可用比例恰好10不标橙(class)',!(await boundary10CellBS.getAttribute('class')||'').includes('itl-inspection-warning')&&(await boundary10CellBS.innerText())==='可用 10%');
    check('M2+H1:可用比例恰好10计算颜色不等于--color-warning',(await colorOfBS(boundary10CellBS))!==warningColorBS);
    // M2 阈值边界：9.99标橙。
    check('M2:可用比例9.99标橙(class)',(await boundary999CellBS.getAttribute('class')||'').includes('itl-inspection-warning')&&(await boundary999CellBS.innerText())==='可用 9.99%');
    check('M2+H1:可用比例9.99计算颜色等于--color-warning',(await colorOfBS(boundary999CellBS))===warningColorBS);
    // L5：free_percent非有限数——显示"—"且不标色。
    check('L5:free_percent非有限数显示"—"且不标橙',(await naCellBS.innerText())==='—'&&!(await naCellBS.getAttribute('class')||'').includes('itl-inspection-warning'));
    // 用户 09-28：容量写成「总 / 可用」GB/TB，空间用条形图（已用填充，同 Windows），颜色取系统语义色。
    check('VB:卷容量写成总/可用且单位为GB',(await volTableBS.locator('tr').nth(1).locator('td').nth(2).innerText())==='93.13GB/46.57GB');
    check('VB:表头为总容量/可用与空间使用',JSON.stringify(await volTableBS.locator('th').allTextContents())===JSON.stringify(['卷','文件系统','总容量 / 可用','空间使用']));
    // Pseudo-element styles are not readable via getComputedStyle; sample the rendered fill pixel instead.
    const barFillBS=async loc=>{const bar=loc.locator('progress');await bar.scrollIntoViewIfNeeded();const value=await bar.evaluate(el=>el.value);const png=(await bar.screenshot()).toString('base64');const fill=await pbs.evaluate(async b64=>{const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const x=c.getContext('2d');x.drawImage(img,0,0);const d=x.getImageData(3,Math.floor(img.height/2),1,1).data;return 'rgb('+d[0]+', '+d[1]+', '+d[2]+')';},png);return {value,fill};};
    const okBarBS=await barFillBS(okVolCellBS),lowBarBS=await barFillBS(badVolCellBS),edge10BarBS=await barFillBS(boundary10CellBS);
    const doneColorBS=await pbs.evaluate(()=>{const el=document.createElement('span');el.style.color='var(--sem-done-dot)';document.body.appendChild(el);const c=getComputedStyle(el).color;el.remove();return c;});
    check('VB:条形图按已用比例填充(可用50%→已用50,可用5%→已用95)',okBarBS.value===50&&lowBarBS.value===95,{okBarBS,lowBarBS});
    check('VB:正常卷条形填充为系统进度色--sem-done-dot',okBarBS.fill===doneColorBS&&edge10BarBS.fill===doneColorBS,{okBarBS,edge10BarBS,doneColorBS});
    check('VB:可用<10%条形填充为--color-warning',lowBarBS.fill===warningColorBS,{lowBarBS,warningColorBS});
    check('VB:可用比例未知时不画条形',(await naCellBS.locator('progress').count())===0);

    // L6：展开区表格不继承业务大表的min-width，行去掉手型指针（CSS-only，读计算样式核对）。
    const l6TableMinWidthBS=await diskTableBS.evaluate(t=>getComputedStyle(t).minWidth);
    check('L6:展开区表格min-width被置0(不继承1100px/900px)',l6TableMinWidthBS==='0px',l6TableMinWidthBS);
    const l6RowCursorBS=await diskTableBS.locator('tbody tr').first().evaluate(tr=>getComputedStyle(tr).cursor);
    check('L6:展开区表格行cursor为default(不是pointer)',l6RowCursorBS==='default',l6RowCursorBS);

    // 收起/再展开：命中缓存，内容一致，不重新请求。
    let getCountItem1BS=0;pbs.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/'+collect1BS.inspection.id))getCountItem1BS++;});
    await pbs.locator('[data-device-expand="'+item1BS.id+'"]').click();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.hidden);},item1BS.id,{timeout:5000});
    check('BS:点击收起后展开区隐藏',await pbs.locator('[data-device-detail="'+item1BS.id+'"]').isHidden());
    await pbs.locator('[data-device-expand="'+item1BS.id+'"]').click();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&!el.hidden&&el.querySelector('h4'));},item1BS.id,{timeout:5000});
    check('BS:再次点击展开后内容恢复(缓存命中,同一份数据)',(await pbs.locator('[data-device-detail="'+item1BS.id+'"]').innerText()).includes('DeviceModelBS1'));
    check('BS:收起再展开不重新请求详情接口(缓存命中,只有最初预取那一次)',getCountItem1BS===0,getCountItem1BS);

    // 展开另一台设备不影响设备段以外的输入框：温度输入框已输入值，展开device2后原样还在，DOM节点也
    // 没被替换（自定义标记只在同一个节点上才会留存，不是靠选择器巧合匹配到新节点）。
    const tempInputBS=pbs.locator('[data-num-id="'+tempItemIdBS+'"]');
    await tempInputBS.click();await tempInputBS.fill('23');
    await pbs.evaluate(id=>{document.querySelector('[data-num-id="'+id+'"]').__c5cMarker=true;},tempItemIdBS);
    await pbs.locator('[data-device-expand="'+item2BS.id+'"]').click();
    await pbs.locator('[data-device-detail="'+item2BS.id+'"] h4').first().waitFor({timeout:5000});
    check('BS:展开另一台设备不影响其它输入框已输入的值(不整表重绘)',await tempInputBS.inputValue()==='23');
    check('BS:温度输入框DOM节点确实原样保留(自定义标记还在)',await pbs.evaluate(id=>document.querySelector('[data-num-id="'+id+'"]').__c5cMarker===true,tempItemIdBS));

    // 重绘不丢展开状态 + 重新采集后显示新快照：device1、device2此刻都展开着；对device1重新采集一份
    // 不同的快照(新model)，doCollect落定后会调用整表renderForm(真实的整表重绘)——验证device1显示新
    // 内容、device2的展开状态没有被这次重绘冲掉。
    overridesBS.server={name:'srv',manufacturer:'x',model:'DeviceModelBS1-RECOLLECTED',serial_number:'SN-BS-1',os:'Windows Server 2022',memory_bytes:34359738368,cpus:[{name:'Xeon测试',cores:8,threads:16}]};
    // 这次重新采集走的是UI真实点击(不经collectAsBS助手)，overridesBS是原地复用的同一个对象——不重置
    // errors/collectionStatus会让这份"全新"快照凭空带着device1第一次采集时的'partial'与旧错误文案，
    // 与"重新采集后是一份干净新快照"的测试意图不符。
    overridesBS.disks=[];overridesBS.vols=[];overridesBS.alerts=[];overridesBS.errors=[];overridesBS.collectionStatus='success';
    // M（codex 47，C5c-b预筛复审）：光只查展开状态/新快照证明不了"焦点/光标真的被恢复了，不是被弹回
    // document.body"——挂起这次重新采集的POST，点击触发(焦点自然落在采集按钮上，真实用户操作就是这
    // 样)，趁请求还没落地，把焦点程序化改到device2的展开按钮上（不经真实点击，不会再把焦点抢回来），
    // 放行后断言document.activeElement确实是device2这个展开按钮（renderForm→captureFocusKey捕获到
    // 的是"重绘那一刻"的焦点，不是点击那一刻的）。
    const heldCollectM=holdRoute(pbs,'**/api/it-assets/inspections/sheets/'+createdBS.body.id+'/items/'+item1BS.id+'/collect','POST');
    await pbs.locator('[data-collect-id="'+item1BS.id+'"]').click();
    await heldCollectM.entered;
    await pbs.evaluate(id=>{document.querySelector('[data-device-expand="'+id+'"]').focus();},item2BS.id);
    const focusBeforeReleaseM=await pbs.evaluate(()=>document.activeElement&&document.activeElement.getAttribute('data-device-expand'));
    check('M(codex47)前提:放行前焦点确实已经改到device2的展开按钮上(不是还在采集按钮上)',focusBeforeReleaseM===String(item2BS.id),focusBeforeReleaseM);
    heldCollectM.release();
    await pbs.locator('#itlToast:not([hidden])').waitFor();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.innerText.includes('RECOLLECTED'));},item1BS.id,{timeout:5000});
    check('BS:该行重新采集后展开区显示新快照(新model文本出现)',(await pbs.locator('[data-device-detail="'+item1BS.id+'"]').innerText()).includes('DeviceModelBS1-RECOLLECTED'));
    check('BS:重新采集触发的整表重绘不丢另一台设备(device2)的展开状态',await pbs.locator('[data-device-detail="'+item2BS.id+'"]').isVisible());
    check('BS:重新采集后展开区不再显示旧的"采集不完整"提示(errors/collectionStatus已随新快照重置)',!(await pbs.locator('[data-device-detail="'+item1BS.id+'"]').innerText()).includes('采集不完整'));
    const focusAfterReleaseM=await pbs.evaluate(()=>document.activeElement&&document.activeElement.getAttribute('data-device-expand'));
    check('M(codex47):整表重绘后焦点恢复到重绘前实际停留的展开按钮(device2),不是弹回document.body',focusAfterReleaseM===String(item2BS.id),focusAfterReleaseM);

    // M（codex 47）续——文本输入框场景：再触发一次采集(仍是device1，这次快照内容不重要)，这次重绘前把
    // 焦点程序化改到温度输入框并选中一段文字，验证重绘后焦点与光标位置(selectionStart/End)都被恢复
    // （只恢复焦点、丢了选区，用户体验上仍是"打字位置被弹飞"，两者都要查，同AY块的既有判据）。
    // 温度输入框是 type="number"——captureFocusKey 自己的注释就写明这类输入在多数浏览器不支持
    // setSelectionRange（会抛 DOMException），选区这部分测不出来；改用总体备注框（textarea，同 AY
    // 块的既有判据），这样才能同时核对焦点与选区两件事。
    await pbs.locator('#itlFormRemark').fill('device redraw focus check');
    overridesBS.server={...overridesBS.server,model:'DeviceModelBS1-RECOLLECTED2'};
    const heldCollectM2=holdRoute(pbs,'**/api/it-assets/inspections/sheets/'+createdBS.body.id+'/items/'+item1BS.id+'/collect','POST');
    await pbs.locator('[data-collect-id="'+item1BS.id+'"]').click();
    await heldCollectM2.entered;
    await pbs.evaluate(()=>{const el=document.getElementById('itlFormRemark');el.focus();el.setSelectionRange(7,13);}); // 选中"redraw"
    heldCollectM2.release();
    await pbs.locator('#itlToast:not([hidden])').waitFor();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.innerText.includes('RECOLLECTED2'));},item1BS.id,{timeout:5000}); // 确认这次重新采集也真的落地重绘了
    const focusAfterReleaseM2=await pbs.evaluate(()=>{const el=document.activeElement;return el?{id:el.id,selStart:el.selectionStart,selEnd:el.selectionEnd}:null;});
    check('M(codex47):整表重绘后焦点恢复到重绘前实际停留的总体备注框(不是弹回document.body)',!!focusAfterReleaseM2&&focusAfterReleaseM2.id==='itlFormRemark',focusAfterReleaseM2);
    check('M(codex47):备注框的光标/选区("redraw"对应7-13)也被恢复',!!focusAfterReleaseM2&&focusAfterReleaseM2.selStart===7&&focusAfterReleaseM2.selEnd===13,focusAfterReleaseM2);

    // GET失败：网络异常(device3)→mapFailureReason通用文案，不写"重新打开页面"；404(device4)→固定文案
    // "无权查看或记录不存在"。两台此前从未被手动切换过，预取早已落地并缓存了失败结果，点击展开只是
    // 把已缓存的失败态画出来，不会重新发请求。
    // C5c-b 自审修正：等待判据原来只看"有非空文本"，"正在读取…"占位本身也满足这个条件——理论上存在
    // 极窄的时间窗：点击展开的瞬间先同步画出占位，下一次事件循环才把已经落地的失败态画上去，这个
    // 窗口里去读 innerText 会读到占位文案，被隔离树的一次实测复现过（真实工作树没触发，但判据本身
    // 站不住，不能靠"通常够快"侥幸）。改为额外排除占位文案本身，才是真正等到"这次点击触发的渲染已经
    // 落定"。
    await pbs.locator('[data-device-expand="'+item3BS.id+'"]').click();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&!el.hidden&&el.innerText.trim().length>0&&!el.innerText.includes('正在读取'));},item3BS.id,{timeout:5000});
    const msg3BS=await pbs.locator('[data-device-detail="'+item3BS.id+'"]').innerText();
    check('BS:网络异常时展开区显示mapFailureReason的通用文案且不写"重新打开页面"',msg3BS.includes('网络异常')&&!msg3BS.includes('重新打开页面'),msg3BS);
    await pbs.locator('[data-device-expand="'+item4BS.id+'"]').click();
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&!el.hidden&&el.innerText.trim().length>0&&!el.innerText.includes('正在读取'));},item4BS.id,{timeout:5000});
    const msg4BS=await pbs.locator('[data-device-detail="'+item4BS.id+'"]').innerText();
    check('BS:GET 404时展开区显示"无权查看或记录不存在"',msg4BS.includes('无权查看或记录不存在'),msg4BS);

    // L3（C5c-b，Opus预筛）：非404失败——点击收起再点击展开（第二次点是"展开"边沿）应删缓存重新请求；
    // 这次放行网络（不再abort），断言展开区从错误文案变成真实数据。404——同样收起再展开，断言仍是
    // 缓存里的固定文案，且没有发出新请求（route仍挂着，若真的重新发请求会被再次fulfill成同一个404，
    // 文案不变看不出差异，所以额外用请求计数佐证"确实没有再发"）。
    await pbs.locator('[data-device-expand="'+item3BS.id+'"]').click(); // 收起
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.hidden);},item3BS.id,{timeout:5000});
    await pbs.unroute('**/api/it-assets/inspections/'+collect3BS.inspection.id);
    let getCountItem3BS=0;pbs.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/'+collect3BS.inspection.id))getCountItem3BS++;});
    await pbs.locator('[data-device-expand="'+item3BS.id+'"]').click(); // 再展开：应删缓存重新请求
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&!el.hidden&&el.querySelector('h4'));},item3BS.id,{timeout:5000});
    check('L3:非404失败再次展开时确实重新发起了请求(不是复用缓存)',getCountItem3BS===1,getCountItem3BS);
    check('L3:非404失败重试成功后展开区显示真实数据(不再是错误文案)',(await pbs.locator('[data-device-detail="'+item3BS.id+'"]').innerText()).includes('DeviceModelBS3'));

    let getCountItem4BS=0;pbs.on('request',r=>{if(r.url().endsWith('/api/it-assets/inspections/'+collect4BS.inspection.id))getCountItem4BS++;});
    await pbs.locator('[data-device-expand="'+item4BS.id+'"]').click(); // 收起
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.hidden);},item4BS.id,{timeout:5000});
    await pbs.locator('[data-device-expand="'+item4BS.id+'"]').click(); // 再展开：404保留缓存，不重试
    await pbs.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&!el.hidden&&el.innerText.trim().length>0&&!el.innerText.includes('正在读取'));},item4BS.id,{timeout:5000});
    check('L3:404保留缓存,再次展开不重新发起请求',getCountItem4BS===0,getCountItem4BS);
    check('L3:404再次展开仍显示同一条缓存文案',(await pbs.locator('[data-device-detail="'+item4BS.id+'"]').innerText()).includes('无权查看或记录不存在'));

    check('浏览器无未捕获异常(BS表单页)',errorsBS.length===0);
    await cbs1.close();

    // 只读详情页同样要有展开——提交这张单(补全所有项+机柜正面照)，管理员视角进只读详情，验证device1
    // 的展开明细同样可用（内容与表单页同源，这里只做smoke核对，阈值/焦点/重绘等已在表单页验证过）。
    const detailForSubmitBS=await fBS.api('GET','/inspections/sheets/'+createdBS.body.id,undefined,2);
    const fillItemsBS=fillPayloadAllOk(detailForSubmitBS.body.items);
    const putBS=await fBS.api('PUT','/inspections/sheets/'+createdBS.body.id,{expected_version:detailForSubmitBS.body.version,items:fillItemsBS,remark:null},2);
    assert.equal(putBS.status,200,'BS put before submit '+JSON.stringify(putBS.body));
    // 不能直接复用外层uploadAllRackFrontPhotos——它闭包捕获的是main()顶层的f(主夹具)，本块用的是
    // 独立夹具fBS，同一个sheetId在两个库里各自独立自增，误发到f会静默"成功"但对fBS这张单毫无效果。
    for(const rackBSItem of createdBS.body.scope.racks){
      const fdBS=new FormData();fdBS.append('slot','rack_front');fdBS.append('target_id',String(rackBSItem.id));fdBS.append('file',new Blob([MIN_JPEG_BYTES],{type:'image/jpeg'}),'p.jpg');
      const photoRespBS=await fetch(fBS.base+'/api/it-assets/inspections/sheets/'+createdBS.body.id+'/photos',{method:'POST',headers:{Authorization:'Bearer fixture-2'},body:fdBS});
      assert.equal(photoRespBS.status,201,'BS rack_front photo '+JSON.stringify(await photoRespBS.json().catch(()=>null)));
    }
    const submitBS=await fBS.api('POST','/inspections/sheets/'+createdBS.body.id+'/submit',{expected_version:putBS.body.version},2);
    assert.equal(submitBS.status,200,'BS submit '+JSON.stringify(submitBS.body));
    const errorsBS2=[];
    cbs2=await browser.newContext();await cbs2.addInitScript(()=>localStorage.setItem('token','fixture-1'));const pbs2=await cbs2.newPage();pbs2.on('pageerror',e=>errorsBS2.push(e.message));
    await pbs2.goto(fBS.base+'/IT_Ledger.html#inspections');await pbs2.locator('[data-insp-row="'+createdBS.body.id+'"]').waitFor();
    await pbs2.locator('[data-insp-view="'+createdBS.body.id+'"]').click();await pbs2.locator('.itl-sheet-title h2').waitFor();
    check('BS(只读详情):设备采集明细卡片标题含台数',(await pbs2.locator('.itl-sheet-card',{hasText:'设备采集明细'}).innerText()).includes('4 台'));
    // device1在表单页那一轮recollect把alerts改成了空(见上方"重新采集后显示新快照"那步)——只读详情页
    // 是全新的闭包状态(deviceDetailListForView头部注释：这个视图从不重绘，状态不跨渲染，天然也不跨
    // 表单/详情两个视图)，此刻device1按它最新的快照(零告警)算默认收起，不是"默认展开"；这里改成显式
    // 点击展开，核对内容与点击行为本身，默认展开这条规则已经在表单页用有告警的场景验证过。
    check('BS(只读详情):device1此刻(recollect后零告警)默认收起',await pbs2.locator('[data-device-detail="view-'+item1BS.id+'"]').isHidden());
    await pbs2.locator('[data-device-expand="view-'+item1BS.id+'"]').click();
    await pbs2.locator('[data-device-detail="view-'+item1BS.id+'"] h4').first().waitFor({timeout:5000});
    const detail1TextViewBS=await pbs2.locator('[data-device-detail="view-'+item1BS.id+'"]').innerText();
    check('BS(只读详情):点击展开显示最新快照(重新采集后的model)',detail1TextViewBS.includes('DeviceModelBS1-RECOLLECTED'),detail1TextViewBS);
    await pbs2.locator('[data-device-expand="view-'+item2BS.id+'"]').click();
    await pbs2.locator('[data-device-detail="view-'+item2BS.id+'"] h4').first().waitFor({timeout:5000});
    check('BS(只读详情):点击展开另一台设备正常显示内容',(await pbs2.locator('[data-device-detail="view-'+item2BS.id+'"]').innerText()).includes('DeviceModelBS2'));
    check('浏览器无未捕获异常(BS只读详情页)',errorsBS2.length===0);
    await cbs2.close();

    // T) M2（C5c-b，Opus预筛必修）：会话守卫——独立的一张单+独立设备+独立浏览器上下文（不与上面
    // createdBS共用——那张单会走到提交，不能留一台"未处理告警"的设备卡住提交，也不想和前面已经用过
    // 的四台设备的展开状态互相干扰）。挂起这台设备的详情GET，离开这张单再重开(产生新session/新f)，
    // 放行旧请求，断言新会话的展开区状态没有被这条迟到的旧回调改写。设备有告警，两次session各自首次
    // 加载都会判定默认展开；在新session里手动收起后放行旧请求——若ensureDeviceDetail里的formVisible
    // 守卫被删，旧回调会用document.querySelector精确命中新session渲染出的同一个data-device-detail
    // 节点(同一张单同一批item.id)，把它强制展开回去，覆盖用户刚做的收起操作；守卫生效则新session的
    // 收起状态保持不变。用"只拦截命中一次"手法(同R块"同id重开"同一技巧)，让新session自己的GET不被
    // 误挡，能正常落地、正常判定默认展开。
    const rackT=(await fBS.api('POST','/racks',{name:'SF-RoomBS-T-柜1',room:'SF-RoomBS-T',u_total:20})).body;
    const devT=(await fBS.api('POST','',{category:'server',name:'SF-RoomBS-T-设备',sn:'SN-BS-T',attrs:{ip:HOST_BS},u_height:1,placement:{kind:'rack',rack_id:rackT.id,u_start:1}})).body;
    const sheetT=await fBS.api('POST','/inspections/sheets',{room_name:'SF-RoomBS-T'},2);
    assert.equal(sheetT.status,201,'T create '+JSON.stringify(sheetT.body));
    const itemT=sheetT.body.items.find(it=>it.section==='device'&&it.target_id===devT.id);
    overridesBS.server={name:'srv',manufacturer:'x',model:'DeviceModelBST',serial_number:'SN-BS-T',os:'Windows Server 2022',memory_bytes:34359738368,cpus:[{name:'Xeon测试',cores:8,threads:16}]};
    overridesBS.disks=[];overridesBS.vols=[];overridesBS.errors=[];overridesBS.collectionStatus='success';
    overridesBS.alerts=[{severity:'attention',kind:'test',message:'M2场景告警,让两次session各自首次加载都默认展开'}];
    const collectTResp=await fBS.api('POST','/inspections/sheets/'+sheetT.body.id+'/items/'+itemT.id+'/collect',undefined,2);
    assert.equal(collectTResp.status,201,'T collect '+JSON.stringify(collectTResp.body));
    const errorsBS3=[];
    cbs3=await browser.newContext();await cbs3.addInitScript(()=>localStorage.setItem('token','fixture-2'));const pbs3=await cbs3.newPage();pbs3.on('pageerror',e=>errorsBS3.push(e.message));
    let oldHeldT=true,enteredOldTResolve,heldOldTResolve;
    const enteredOldTPromise=new Promise(r=>enteredOldTResolve=r),heldOldTPromise=new Promise(r=>heldOldTResolve=r);
    await pbs3.route('**/api/it-assets/inspections/'+collectTResp.body.inspection.id,async route=>{
      if(!oldHeldT)return route.fallback();
      oldHeldT=false;
      const response=await route.fetch();
      enteredOldTResolve();
      await heldOldTPromise;
      await route.fulfill({response});
    });
    await pbs3.goto(fBS.base+'/IT_Ledger.html#inspections');await pbs3.locator('[data-insp-row="'+sheetT.body.id+'"]').waitFor();
    await pbs3.locator('[data-insp-continue="'+sheetT.body.id+'"]').click();await pbs3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbs3);
    await enteredOldTPromise; // 旧请求已挂起(entered)，此刻这台设备此前从未落地，仍是默认收起
    check('T前提:旧请求挂起期间设备仍是初始收起态(数据尚未落地)',await pbs3.locator('[data-device-detail="'+itemT.id+'"]').isHidden());
    await pbs3.locator('#itlFormBack').click(); // 离开：f.left=true
    await pbs3.locator('[data-insp-row="'+sheetT.body.id+'"]').waitFor();
    await pbs3.locator('[data-insp-continue="'+sheetT.body.id+'"]').click();await pbs3.locator('#itlFormActionbar').waitFor();await expandInspectionForm(pbs3); // 重开：产生新f
    await pbs3.locator('[data-device-detail="'+itemT.id+'"] h4').first().waitFor({timeout:5000}); // 新会话自己的GET已落地
    check('T前提:重开后新会话自己成功加载,有告警的设备默认展开',await pbs3.locator('[data-device-detail="'+itemT.id+'"]').isVisible());
    await pbs3.locator('[data-device-expand="'+itemT.id+'"]').click(); // 新会话里用户手动收起
    await pbs3.waitForFunction(id=>{const el=document.querySelector('[data-device-detail="'+id+'"]');return !!(el&&el.hidden);},itemT.id,{timeout:5000});
    check('T前提:新会话里用户手动收起后确实是收起态',await pbs3.locator('[data-device-detail="'+itemT.id+'"]').isHidden());
    const settledBaselineT=await pbs3.evaluate(()=>window.ITLedger.__inspLoadSettled);
    heldOldTResolve(); // 放行旧会话那条挂起已久的GET，携带它自己那份(其实内容相同,但来自已离开的旧f)数据落地
    await pbs3.waitForFunction(base=>window.ITLedger.__inspLoadSettled>=base+1,settledBaselineT,{timeout:5000});
    check('M2:旧会话的迟到回调落地后,新会话里用户手动收起的展开区仍保持收起(未被旧回调覆写)',await pbs3.locator('[data-device-detail="'+itemT.id+'"]').isHidden());
    check('浏览器无未捕获异常(BS会话守卫T)',errorsBS3.length===0);
    await cbs3.close();
  }finally{
    if(cbs1)await cbs1.close().catch(()=>{});
    if(cbs2)await cbs2.close().catch(()=>{});
    if(cbs3)await cbs3.close().catch(()=>{});
    await fBS.close();
  }

  console.log(`SHEET_FORM_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
