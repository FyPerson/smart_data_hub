'use strict';
const express=require('express');
// C7（长任务 E · 巡检台账改版，方案 v0.6 §6「it-ledger-inspections.js」条 / §7「v0.6 追加退役」段，
// 用户 2026-09-25 16:5x 裁定 A）：单独设备巡检整体退役——抽屉一键采集（原 POST /）、单条人工判断
// （原 POST /:id/review）、抽屉采集目标查询（原 GET /targets）、设备巡检附件四条路由（原
// GET/POST /:kind/:recordId/evidence、GET .../evidence/:attachmentId/content、
// DELETE .../evidence/:attachmentId）全部删除，同落 Express 默认404（与 C6 机房巡检退役同一手法：
// 直接去掉路由注册，不写显式404处理器）。围绕这些路由的助手（record()/ensureEvidence()/
// evidenceView()/types/matches()/upload/receive()/attachment()/filePath()/removeFile()/
// assertNotInSheet()/assertVisibleIfAttached()/attrs()/input()）随之一并删除——全部只被这七条已删
// 路由调用，没有第二个消费者（删除前逐个确认过调用方，见交付报告反向清单）。
// 数据表（it_device_inspections、it_inspection_evidence）不删不迁；巡检的采集、判断、说明、照片
// 只在巡检单内完成（inspection-sheets.js / inspection-collect.js，本文件不再涉及）。
//
// 保留两条只读路由：GET /（按 asset_id 查某设备的巡检记录列表——服务器详情「设备巡检」页签改为的
// 摘要表用它，本次新增 item_result 只读字段，见 buildItemResults）、GET /:id(\d+)（单条只读详情——
// 巡检单设备段展开明细复用它，方案 v0.6 §6「设备采集明细展开」条）。两者可见性规则不变：归属巡检
// 单的记录按巡检单可见性判定，受限行只给白名单字段（不含新增的 item_result）。
//
// MED-5（C7-c，Opus预筛）：工厂签名收窄为实际用到的五个依赖——collector/withWrite/
// requireLedgerWrite/storageDir/recordManagement 随七条路由一并删除后已经没有任何调用方，继续留在
// 签名里只是徒增一份"能拿到哪些能力"的假象（对刚退役的写路径失去拦截意义：如果这五个键还在，
// R10 静态守卫的"依赖键集合全等"判据永远看不出"这个文件本不该再需要写权限/存储目录/采集器"这件
// 事）。verify-it-ledger-inspection-sheets.js 的 INSPECTIONS_EXPECTED_DEPS/
// INSPECTIONS_REQUIRE_WHITELIST 同批收窄，index.js:3438 的调用点同步删掉多余参数。
//
// C6（长任务 E · 巡检台账改版，方案 §7/§2.5）历史：机房巡检整体退役——room-targets/rooms/
// rooms/:id/rooms/:id/review 四条路由、ensureRooms、roomView 已删除；record() 的 kind==='device'
// 校验、GET '/:id' 收紧为 GET '/:id(\d+)'（C6-c 44S M1/44T H1，避免 '/room-targets'/'/rooms' 落进
// 这条路由被当成"记录编号无效"按400而不是与其它机房路径一致的404）都随 C7 一并整理：kind 参数已不
// 再被任何存活路由使用（record() 本身也已删除），'/:id(\d+)' 的数字专用正则挪到下方 GET /:id(\d+)
// 路由旁继续生效。it_room_inspections、it_inspection_evidence 两表结构与历史数据同样不删不迁。
module.exports=function createInspections({withRead,handleErr,collect,sheetVisibility,stripFinance}){
 const router=express.Router();
 const error=(status,code,message)=>Object.assign(new Error(message),{status,code});
 const bad=message=>error(400,'LEDGER_BAD_REQUEST',message);
 const id=v=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw bad('记录编号无效');return n;};
 async function canRead(q,user){if(user.role==='admin')return;const row=await q.get('SELECT level FROM it_asset_acl WHERE user_id=?',[user.id]);if(!row)throw error(403,'LEDGER_FORBIDDEN','访问权限已变化');}
 const respond=(req,res,row,status=200)=>res.status(status).json(req.user.role==='admin'?collect.view(row):stripFinance(collect.view(row)));
 const hasTable=(q,name)=>q.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]);
 // C3（方案 §2.5 行为段）：有 sheet_id 的采集记录归属巡检单，判断与附件都改在巡检单里做——旧列表
 // 里的 sheet_id 在没有两列的旧表上恒为 undefined（缺列，SELECT * 就是没有这个 key），falsy，天然
 // 等价于"不归属"，不需要另外判空处理（方案 §2.5「缺列时两字段按 NULL 返回」的读路径要求，这里靠
 // 不显式选列的 SELECT * 免费满足）。detached_from_sheet_id 非空的记录 sheet_id 必为空（表级
 // CHECK），视同单独采集。
 // C3b L8：批量版——原来逐行各查一次 it_inspection_sheets（列表最多100行=最多100次单行查询），
 // 改成先收集这一批行里出现过的全部 sheet_id，一次 IN(...) 查完，逐行只做内存里的 Map 查找。
 async function buildSheetRefs(q,rows,user,sheetsExists){
  const sheetIds=[...new Set(rows.filter(r=>r.sheet_id).map(r=>r.sheet_id))];
  const sheetsById=new Map();
  if(sheetsExists&&sheetIds.length){
   const sheets=await q.all(`SELECT id,status,created_by,deleted_at FROM it_inspection_sheets WHERE id IN (${sheetIds.map(()=>'?').join(',')})`,sheetIds);
   for(const s of sheets)sheetsById.set(s.id,s);
  }
  // C3c H3（codex 37S/37T）：每行的可见性也要返回给调用方——非full可见的归属记录，列表要去掉
  // 采集内容派生字段（alert_count 等快照派生值），只保留这里算好的归属文本；detached/无归属的行
  // 视同单独采集，恒为full（不受限）。
  // C6-b H1（Opus预筛）：sheet_ref 补两个字段，不改任何既有 text/linkable 取值（保持
  // verify-it-ledger-inspection-collect.js 归属四例既有断言原样成立）——kind:'attached'|'detached'
  // 区分"仍归属"与"已解除"，供前端判断要不要渲染判断表单/附件上传口子（方案 §2.5：只有 attached
  // 才挂"判断与附件在巡检单内完成"这句提示，detached 视同单独采集正常出表单）；linkable 行（full
  // 可见）补单据 status（已删除记 'deleted'，否则原样 sheet.status）——sheetVisibility 对 admin 在
  // 单据已删除时仍给 full，与"正常可见、未删除"产出完全相同的 {linkable:true}，前端此前拿不到任何
  // 信号区分两者；现在管理员能看到的 sheet_ref.status==='deleted' 时可自行决定要不要额外提示，不必
  // 靠猜测或再发一次请求。sheetVisibility(user,null)（单据缺失）对任何角色（含管理员）都返回
  // 'none'——核实：正常业务下 sheet_id 非空时对应单据行只会被逻辑删除、从不物理删除（草稿的物理
  // 删除在§5.5里同时会把sheet_id置空/改写detached_from_sheet_id，不会留下"sheet_id指向不存在的
  // 单据"这种状态），这条走else分支（visibility!=='full'）产出"巡检单 #N（已删除）"文案且
  // linkable:false，是安全的保守默认（不崩溃、不误导管理员），不需要额外处理。
  // C7（v0.6 §6）：前端「服务器详情」页签退化为摘要表后，仍读这里给出的 text/linkable/kind/status
  // 四个字段渲染「所属巡检单」列（linkable 行渲染可点按钮跳 L.openInspectionSheet；detached 行与
  // ref 为 null 的行都渲染纯文本，区别见 it-ledger-inspections.js 的 attributionCell）。
  return rows.map(row=>{
   if(row.detached_from_sheet_id)return {ref:{id:row.detached_from_sheet_id,text:`来自巡检单 #${row.detached_from_sheet_id} 的采集（已解除）`,linkable:false,kind:'detached'},visibility:'full'};
   if(!row.sheet_id)return {ref:null,visibility:'full'};
   const sheet=sheetsById.get(row.sheet_id)||null;
   const visibility=sheetVisibility(user,sheet);
   if(visibility==='full')return {ref:{id:row.sheet_id,text:`见巡检单 #${row.sheet_id}`,linkable:true,kind:'attached',status:sheet&&sheet.deleted_at?'deleted':sheet.status},visibility};
   if(visibility==='summary')return {ref:{id:row.sheet_id,text:`巡检单 #${row.sheet_id}（填写中）`,linkable:false,kind:'attached'},visibility};
   // C7-d（codex 46S H）：走到这里 visibility 必为'none'（sheetVisibility 只返回 full/summary/none 三
   // 档，前两档已各自 return）。buildSheetRefs 唯一调用方 GET / 现在对 visibility==='none' 的行整行
   // 跳过（不进响应），这里构造的 ref 内容（哪怕文案已经隐去具体状态只写"已删除"）实际上永远不会被
   // 调用方读取——不再造一个"看似有内容、实际不可达"的对象，直接给 null，视觉上也更诚实。
   return {ref:null,visibility};
  });
 }
 // C7（v0.6 §6「it-ledger-inspections.js」条）：摘要表新增「判断结果」列——取该设备在巡检单里对应
 // 检查项（it_inspection_sheet_items，section='device'）的 result（'ok'/'bad'/null）。一台设备的
 // device_inspection_id 在任意时刻至多被一行检查项引用（重新采集会把旧记录 sheet_id 清空、
 // detached_from_sheet_id 置位，同时把检查项的 device_inspection_id 改指向新记录，见
 // inspection-sheets.js:1267-1270），已解除归属、或从未归属过任何巡检单的记录查不到匹配行，
 // 落 null（前端显示"未判断"）——不区分"确实没判断"与"这条记录已经没有检查项在指它"，两者对
 // 用户呈现的意义相同（都是"这行数据当前没有巡检单给出的判断结果"）。只给可见行加这个字段，受限行
 // （sheet_id 非空且可见性非 full）维持既有五键白名单不变（不新增 item_result 键）。
 // MED-3 L1（C7-c，Opus预筛纵深防御）：多取检查项自己的sheet_id，只有它与这条采集记录自己的sheet_id
 // （row.sheet_id，list查询已经选出）一致时才采信这条result——正常业务下二者恒相等（recollect在同一
 // 事务内把旧记录sheet_id清空/detach，同时把item.device_inspection_id改指向新记录，device_inspection_id
 // 在任意时刻至多被一行检查项引用，不会出现"记录自认为属于A单,却是B单的检查项在指它"这种交叉态），
 // 这里只是防止未来某条写路径半途失败或被绕过约定直接改库时，列表接口把不相关单据的判断结果错认成
 // 这条记录的judgement_result。
 async function buildItemResults(q,rows){
  if(!rows.length||!await hasTable(q,'it_inspection_sheet_items'))return new Map();
  const ids=rows.map(r=>r.id);
  const rowById=new Map(rows.map(r=>[r.id,r]));
  const found=await q.all(`SELECT device_inspection_id,result,sheet_id FROM it_inspection_sheet_items WHERE device_inspection_id IN (${ids.map(()=>'?').join(',')})`,ids);
  const map=new Map();
  for(const item of found){
   const row=rowById.get(item.device_inspection_id);
   if(row&&row.sheet_id&&item.sheet_id===row.sheet_id)map.set(item.device_inspection_id,item.result);
  }
  return map;
 }
 router.get('/',async(req,res)=>{try{const rows=await withRead(async q=>{await canRead(q,req.user);if(Object.keys(req.query).some(k=>k!=='asset_id'))throw bad('未声明的筛选字段');const filter=req.query.asset_id===undefined?null:id(req.query.asset_id);if(!await collect.exists(q))return [];
  // C3：sheet_id/detached_from_sheet_id 可能不存在于旧表（未升级），读路径按实际列拼查询、缺列按
  // NULL——不能直接写死列名，旧结构会报"no such column"。
  const cols=await collect.deviceInspectionColumns(q);
  const sheetIdExpr=cols.hasSheetId?'sheet_id':'NULL AS sheet_id';
  const detachedExpr=cols.hasDetached?'detached_from_sheet_id':'NULL AS detached_from_sheet_id';
  const sheetsExists=!!await hasTable(q,'it_inspection_sheets');
  const list=await q.all(`SELECT id,asset_id,asset_name,source_host,started_at,completed_at,collection_status,requested_by,judgement,judgement_note,reviewed_by,reviewed_at,snapshot_json,${sheetIdExpr},${detachedExpr} FROM it_device_inspections`+(filter===null?'':' WHERE asset_id=?')+' ORDER BY id DESC LIMIT 100',filter===null?[]:[filter]);
  // The list carries only the alert count for overviews; the snapshot itself is served by GET /:id.
  const out=[];
  const refs=await buildSheetRefs(q,list,req.user,sheetsExists);
  const itemResults=await buildItemResults(q,list);
  // C3e（codex 37-RS，改正C3c H3只摘alert_count的半成品修复）：受限行（sheet_id非空且可见性非
  // full）改用响应白名单，不再"先展开整行、再删个别字段"——先前的写法虽然摘掉了alert_count，
  // 但judgement_note/collection_status/asset_name/source_host/requested_by等其余字段原样透出，
  // 同样绕过了草稿summary可见性该有的有限展示口径。白名单留{id,asset_id,started_at,sheet_ref,
  // restricted}五个键（C6-b H1 加 restricted:true，供前端识别"这行是受限的、不能点查看、不该被
  // 默认选中"，不必再靠"有没有 alert_count/judgement 等字段"这类隐式推断——五键与方案§4.2
  // "summary只含...有限字段"同一收紧方向）。C7：本次新增的 item_result 字段不进这份白名单
  // （方案 v0.6 §6 明文"受限行不加"）。已解除归属（detached_from_sheet_id非空）与不归属任何单
  // （sheet_id为空）的行视同单独采集，不受此限，原样返回整行（不带 restricted 键）并带
  // item_result。
  for(let idx=0;idx<list.length;idx++){const row=list[idx];
   // C7-d（codex 46S H，主会话已核实属实）：visibility==='none'——sheet_id非空但sheetVisibility判
   // none（非管理员看已删除单，方案§4.2"none的单不出现在列表""full以外不暴露是否存在"）——整行跳过，
   // 不进out。此前即使none也会走下面的restricted分支返回受限五键（含sheet_ref里的编号与"已删除"
   // 字样），等于告诉调用方"这条受限记录/它归属的单确实存在"，与方案矛盾；summary（草稿他人可见）
   // 仍按原样走受限五键，未受影响。
   if(row.sheet_id&&refs[idx].visibility==='none')continue;
   const restricted=row.sheet_id&&refs[idx].visibility!=='full';
   if(restricted){out.push({id:row.id,asset_id:row.asset_id,started_at:row.started_at,sheet_ref:refs[idx].ref,restricted:true});continue;}
   const {snapshot_json,...rest}=row;let alerts=null;try{const a=JSON.parse(snapshot_json).alerts;alerts=Array.isArray(a)?a.length:null;}catch(_){}out.push({...rest,alert_count:alerts,sheet_ref:refs[idx].ref,item_result:itemResults.get(row.id)??null});}
  return out;});res.json({items:rows});}catch(e){handleErr(res,e);}});
 // C6-c 44S M1/44T H1（codex 44 审查修复）：GET /room-targets、GET /rooms 是单段路径，路由收缩后
 // 曾落进下面 GET '/:id'（设备巡检详情路由）当成"记录编号无效"按 400 拒绝，与另外三条真正无路由
 // 匹配、落 Express 默认 404 的机房路径（POST /rooms、GET /rooms/:id、POST /rooms/:id/review）不
 // 一致。下面把 '/:id' 收紧成 '/:id(\\d+)'——Express 4 的 path-to-regexp 支持 :name(regexp) 自定义
 // 匹配组，只在参数段全为数字时命中；'/room-targets'/'/rooms' 不含纯数字段，不再匹配这条路由，会
 // 继续往后找（本文件其余路由都不匹配这两个路径），最终落到与另外三条相同的 Express 默认 404。
 // C7 之后本文件不再有其它 GET '/xxx' 单段路由与它抢注册顺序（/targets 已删除），这条数字专用正则
 // 继续保留是纵深防御：任何将来新增的单段 GET 路径名都不会被这条路由误吃成"记录编号无效"。
 // id() helper（本文件:13）对非法数字（超出安全整数范围等）仍抛 400，两层是配合关系（正则先挡住
 // 非数字路径，id() 再挡住数字但不合法的编号），不是替代关系。
 router.get('/:id(\\d+)',async(req,res)=>{try{const n=id(req.params.id);const row=await withRead(async q=>{await canRead(q,req.user);
  if(!await collect.exists(q))return null;
  const r=await q.get('SELECT * FROM it_device_inspections WHERE id=?',[n]);
  if(!r)return null;
  // C3c H3：归属巡检单（sheet_id非空、未解除）的记录，独立采集详情接口也要按单据可见性收窄——
  // 非full一律404，与"记录不存在"同码，不额外泄露"看不见的单里有这么一行"。已解除
  // （detached_from_sheet_id非空，二者表级CHECK互斥）的记录视同单独采集，不受此限。
  if(r.sheet_id){
   const sheetsExists=!!await hasTable(q,'it_inspection_sheets');
   const sheet=sheetsExists?await q.get('SELECT id,status,created_by,deleted_at FROM it_inspection_sheets WHERE id=?',[r.sheet_id]):null;
   if(sheetVisibility(req.user,sheet)!=='full')return null;
  }
  return r;
 });if(!row)throw error(404,'LEDGER_NOT_FOUND','巡检记录不存在');respond(req,res,row);}catch(e){handleErr(res,e);}});
 return {router};
};
