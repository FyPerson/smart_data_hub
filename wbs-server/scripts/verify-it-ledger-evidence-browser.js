'use strict';
const assert=require('assert/strict'),crypto=require('crypto');
const {createFixture,ensureDeviceInspectionsTable}=require('./it-ledger-browser-fixture');
let pass=0;const check=(name,v,detail)=>{if(!v&&detail!==undefined)console.error('DETAIL',name,JSON.stringify(detail));assert.ok(v,name);pass++;console.log('[OK] '+name);};
// C7（长任务 E · 巡检台账改版，方案 v0.6 §7「v0.6 追加退役」段，用户 2026-09-25 16:5x 裁定 A）：
// 单独设备巡检整体退役——抽屉一键采集（POST /）、单条人工判断（POST /:id/review）、抽屉采集目标
// 查询（GET /targets）、设备巡检附件四条路由（GET/POST /:kind/:recordId/evidence、
// GET .../evidence/:attachmentId/content、DELETE .../evidence/:attachmentId）全部删除，与 C6
// 机房路由退役同一手法：落 Express 默认404（HTML响应，不是JSON）。
//
// 本文件此前承载的整套"设备附件上传/下载/格式与大小校验/并发/20件上限/阶段竞态/撤权竞态"管线断言
// （连同一键采集/判断表单/证据组件的浏览器 UI 段）随这些路由一起失去对象，全部删除——不是精简，是
// 这条写路径已经不存在。UI 侧"设备巡检"页签改为摘要表后的断言（列取值/跳转/受限行/退役控件消失）
// 全部搬到 verify-it-ledger-inspections-browser.js（spec-C7 §3 指定的"重点"文件）。本文件收窄为
// 纯接口层：证明七条已退役路由 404（含合法/真实存在的 id，不是巧合的"记录不存在"），证明保留的两条
// 只读路由（GET /、GET /:id(\d+)）与旧库兼容（it_inspection_evidence 表结构与历史数据不删不迁）
// 不受影响。原→新逐条对照见交付报告。
async function main(){
 const f=await createFixture({});
 console.log('ISOLATED_ARTIFACTS='+f.dir);
 try{
  // MED-1（C7-c，Opus预筛）：保留路由 GET /inspections 的契约断言被C7重写时误删——独立干净夹具
  // （不能复用下面的f，那边很快就会为退役探针建表插数据，测不出"只读列表本身不懒建表"这件事）：
  // 只读列表200空数组、不懒建两张表；合法asset_id过滤200空数组；asset_id=bad与未声明查询字段各400。
  {
   const f0=await createFixture({});
   try{
    const empty=await f0.api('GET','/inspections');
    check('MED-1:干净库GET /inspections列表200空数组',empty.status===200&&Array.isArray(empty.body.items)&&empty.body.items.length===0,empty.body);
    const tables=await f0.all("SELECT name FROM sqlite_master WHERE name IN ('it_device_inspections','it_inspection_evidence')");
    check('MED-1:只读列表不懒建it_device_inspections/it_inspection_evidence两张表',tables.length===0,tables);
    const assetForFilter=(await f0.api('POST','',{category:'laptop',name:'MED-1过滤用资产',placement:{kind:'depot'}})).body;
    const filtered=await f0.api('GET','/inspections?asset_id='+assetForFilter.id);
    check('MED-1:合法asset_id过滤200空数组',filtered.status===200&&Array.isArray(filtered.body.items)&&filtered.body.items.length===0,filtered.body);
    // M（codex 46T1）：上面"不懒建表"只在无筛选GET之后查过一次sqlite_master——若只有带合法asset_id
    // 的读路径意外建表（比如filter分支的实现绕开了exists()短路），后续"200空数组"这条断言本身测不出
    // 建表这件事，得再查一次sqlite_master才补得上这个缺口。
    const tablesAfterFilter=await f0.all("SELECT name FROM sqlite_master WHERE name IN ('it_device_inspections','it_inspection_evidence')");
    check('M(codex46T1):带合法asset_id的请求之后,两张表仍不存在(不是只有无筛选GET才不懒建)',tablesAfterFilter.length===0,tablesAfterFilter);
    const badFilter=await f0.api('GET','/inspections?asset_id=bad');
    check('MED-1:asset_id=bad返回400',badFilter.status===400,badFilter.body);
    const badKey=await f0.api('GET','/inspections?x=1');
    check('MED-1:未声明查询字段x=1返回400',badKey.status===400,badKey.body);
   }finally{await f0.close();}
  }

  // 裸fetch而不是f.api()——f.api()对响应体无条件.json()解析，Express默认404页面是HTML不是JSON，
  // 会直接抛SyntaxError而不是给出一条干净的失败断言（C6时代已踩过这个坑，见下面沿用的判据：
  // status===404 且 content-type 为 text/html 且正文含"Cannot"——把"确实是Express默认404页面"这件
  // 事也测严实，不只看状态码数字）。
  const routeGone=async(method,url,body)=>{
   const r=await fetch(f.base+'/api/it-assets'+url,{method,headers:{Authorization:'Bearer fixture-1','Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:(method==='POST'?{body:'{}'}:{}))});
   const text=await r.text();
   return {status:r.status,contentType:r.headers.get('content-type')||'',body:text};
  };

  // 准备：一条真实存在的it_device_inspections记录（直接SQL插入,不经采集——退役后的路由不管id是否
  // 合法都会404,直接SQL造数比搭一整套采集器夹具更直接、也更贴近方案v0.6 §6"不属于任何巡检单的历史
  // 记录,生产不存在,只有本地测试数据"这句对"单独巡检记录"的定性），以及一条挂在它上面的真实附件行
  // （供"含带合法id的请求"探针使用）。
  const rack=(await f.api('POST','/racks',{name:'C7退役探针机柜',u_total:4})).body;
  const asset=(await f.api('POST','',{category:'server',name:'C7退役探针设备',sn:'C7-EVID-SN',attrs:{ip:'192.0.2.9'},u_height:1,placement:{kind:'rack',rack_id:rack.id,u_start:1}})).body;
  const now=new Date().toISOString();
  const snapshot=JSON.stringify({schema_version:1,source_host:'192.0.2.9',server:{serial_number:'C7-EVID-SN'},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:now,completed_at:now});
  // it_device_inspections是懒建表（不在initSchema()里）——L5（C7-c，Opus预筛）：建表DDL不再本文件
  // 手写一份，直接调用生产代码inspection-collect.js的ensure()（见it-ledger-browser-fixture.js头部
  // 注释），与records-browser.js共用同一处实现，不会再出现两份DDL各自维护、悄悄漂移的问题。
  await ensureDeviceInspectionsTable(f);
  const insRecord=await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)',[asset.id,asset.name,'192.0.2.9',now,now,'success',snapshot,1]);
  const recordId=insRecord.lastID;
  await f.run("CREATE TABLE IF NOT EXISTS it_inspection_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL CHECK(kind IN ('device','room')),record_id INTEGER NOT NULL,original_name TEXT NOT NULL,stored_name TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,phase TEXT NOT NULL CHECK(phase IN ('initial','supplement')),description TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_by INTEGER,deleted_at TEXT,cleanup_pending INTEGER NOT NULL DEFAULT 0)");
  const insEvidence=await f.run("INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES('device',?,?,?,?,1,'x','initial','x',1,?)",[recordId,'probe.png',crypto.randomUUID()+'.bin','image/png',now]);
  const attachmentId=insEvidence.lastID;

  // 机房巡检四条历史路由（C6退役，本文件历来就测这几条，原样保留）。
  for(const [method,url] of [['GET','/inspections/room-targets'],['GET','/inspections/rooms'],['POST','/inspections/rooms'],['GET','/inspections/rooms/1'],['POST','/inspections/rooms/1/review']]){
   const rg=await routeGone(method,url);
   check(`机房路由404: ${method} ${url}`,rg.status===404&&/text\/html/.test(rg.contentType)&&/Cannot/.test(rg.body),rg);
  }

  // C7新增七条：抽屉一键采集入口、单条人工判断、采集目标查询、四条设备巡检附件路由。每条都带一个
  // "看起来合法"的请求（真实存在的asset/记录/附件id，格式正确的请求体），证明退役是路由层面的，
  // 不是被id校验、业务闸或请求体校验挡住（派单要求"每个退役接口404，含带合法id的请求"）。
  const c7Routes=[
   ['GET','/inspections/targets'],
   ['POST','/inspections',{asset_id:asset.id}],
   ['POST',`/inspections/${recordId}/review`,{judgement:'normal',note:''}],
   ['GET',`/inspections/device/${recordId}/evidence`],
   ['POST',`/inspections/device/${recordId}/evidence`,{phase:'initial',description:'x'}],
   ['GET',`/inspections/device/${recordId}/evidence/${attachmentId}/content`],
   ['DELETE',`/inspections/device/${recordId}/evidence/${attachmentId}`],
  ];
  for(const [method,url,body] of c7Routes){
   const rg=await routeGone(method,url,body);
   check(`C7退役路由404(含合法id): ${method} ${url}`,rg.status===404&&/text\/html/.test(rg.contentType)&&/Cannot/.test(rg.body),rg);
  }

  // kind=room的附件路由——C6时代单独判400（kind校验在已删除的record()里，先于"路由是否存在"判断）；
  // C7把record()连同它的kind校验一起删除，四条附件路由现在对任何kind值（含历史上专属于机房巡检的
  // 'room'）都统一404，不再有"kind不合法400 vs kind合法但业务拒绝"的区分。
  for(const [method,url] of [['GET',`/inspections/room/${recordId}/evidence`],['POST',`/inspections/room/${recordId}/evidence`],['GET',`/inspections/room/${recordId}/evidence/1/content`],['DELETE',`/inspections/room/${recordId}/evidence/1`]]){
   const rg=await routeGone(method,url,method==='POST'?{phase:'initial',description:'x'}:undefined);
   check(`C7:kind=room同样404(不再是400,record()的kind校验已随路由删除): ${method} ${url}`,rg.status===404,rg);
  }

  // 保留路由不受影响：GET /、GET /:id(\d+) 仍正常工作，且能看到上面直接SQL插入的记录；附件表本身
  // 不删不迁，只是没有路由再读写它——直接SQL插入的行原样可读，证明"表不删不迁"不是空话。
  const list=await f.api('GET','/inspections?asset_id='+asset.id);
  check('保留路由:GET /列表200且能看到直接SQL插入的记录',list.status===200&&list.body.items.some(r=>r.id===recordId),list.body);
  const single=await f.api('GET','/inspections/'+recordId);
  check('保留路由:GET /:id(\\d+)详情200',single.status===200&&single.body.id===recordId,single.body);
  // L4（C7-c，Opus预筛）：原"旧库兼容:it_inspection_evidence表不删不迁,直接SQL插入的行原样可读"这条
  // 断言删除——它验证的只是"我自己刚用SQL插入的行,自己再用SQL读回来"，没有经过任何产品代码路径，是
  // 恒真断言（不管表结构、退役与否，这两行SQL永远配对成立）。
  // M（codex 46T1，改正C7-c时的错误推论）：上面c7Routes/kind=room两组404探针只能证明"路由确实已经
  // 退役"——这些路由落的是Express默认404（路由层面无匹配，请求根本不会进任何业务处理器），不管
  // it_inspection_evidence表在不在、结构对不对，响应永远是同一种404，与该表毫无关系；不能反过来说
  // "这些请求如果表被删了会500所以间接证明表还在"，这个推论不成立（表被删也不会让这些已退役路由
  // 变成500）。表不删不迁这件事真正的证据是下面MED-2：遗留的it_inspection_evidence行经真实产品代码
  // 路径（record-management.js的references()/delete/purge）读到、且不影响这些接口的行为。

  // MED-2（C7-c，Opus预筛）：record-management的引用计数/删除/彻底删除不受遗留it_inspection_evidence
  // 行（room行、与真实资产/记录编号撞号）影响——这条回归守卫在C7重写本文件时被整体删掉了，
  // record-management.js/inspection-sheets.js本身都没有退役，这条覆盖没有失去意义。原样取自
  // `git show e3630d59^:wbs-server/scripts/verify-it-ledger-evidence-browser.js` :215-269（44T H3
  // 两条 + H1 步骤2/4/5/6 共七条），只把局部变量api(...)改写成f.api(...)（原文件有一层api=
  // (m,u,b,uid)=>f.api(m,u,b,uid)的薄包装，本文件直接用f.api，语义完全相同）。44T H2那组"填满20件"
  // 属于已退役的设备附件上传路由，不移回。
  const h3Asset=(await f.api('POST','',{category:'laptop',name:'撞号引用对照资产',placement:{kind:'depot'}})).body;
  const h3Now=new Date().toISOString();
  const h3Snapshot=JSON.stringify({schema_version:1,source_host:'192.0.2.9',server:{serial_number:'H3-SN'},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:h3Now,completed_at:h3Now});
  const h3Ins=await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)',[h3Asset.id,h3Asset.name,'192.0.2.9',h3Now,h3Now,'success',h3Snapshot,1]);
  const h3RecordId=h3Ins.lastID;
  const rmH3Before=await f.api('GET','/'+h3Asset.id+'/record-management',undefined,1);
  check('44T H3准备:撞号对照资产此刻仅因自己的设备巡检记录被引用(inspections=1,其余6项为0,前提成立)',rmH3Before.body.references.inspections===1&&rmH3Before.body.references.children===0&&rmH3Before.body.references.stocktakes===0&&rmH3Before.body.references.reconciles===0&&rmH3Before.body.references.inspection_sheets===0&&rmH3Before.body.references.used===0&&rmH3Before.body.references.managed===0,rmH3Before.body);
  const delBeforeH3=await f.api('POST','/'+h3Asset.id+'/record-management',{action:'delete',reason:'H3撞号验证前测',expected_version:h3Asset.version},1);
  check('44T H3准备:撞号前删除已被自己的巡检记录拒绝(409,前提成立)',delBeforeH3.status===409,delBeforeH3.body);
  await f.run('INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['room',h3RecordId,'撞号旧机房材料.png',crypto.randomUUID()+'.bin','image/png',10,'1'.repeat(64),'initial','撞号材料',1,'2020-01-01T00:00:00.000Z']);
  const rmH3After=await f.api('GET','/'+h3Asset.id+'/record-management',undefined,1);
  check('44T H3:遗留room行record_id与该资产自己的巡检记录编号撞号后,引用计数逐字段与撞号前完全一致',JSON.stringify(rmH3After.body.references)===JSON.stringify(rmH3Before.body.references),{before:rmH3Before.body.references,after:rmH3After.body.references});
  const delAfterH3=await f.api('POST','/'+h3Asset.id+'/record-management',{action:'delete',reason:'H3撞号验证后测',expected_version:h3Asset.version},1);
  check('44T H3:撞号后删除结果与撞号前完全一致(仍409,响应体逐字节相同)',delAfterH3.status===409&&JSON.stringify(delAfterH3.body)===JSON.stringify(delBeforeH3.body),{before:delBeforeH3.body,after:delAfterH3.body});
  // H1（codex 44R复检，spec-C6-d.md）：h3Asset天生带着自己的设备巡检记录(inspections=1)，删除在插入
  // 遗留room行之前就已经409——即使删除判定错误地混入room行，插入后的409仍可能是同一个原因，测不出
  // "遗留room行被误计入"这类回归。另建一个真正零阻碍的资产h3Free，撞号行插入前后分别断言，删除与
  // 彻底删除都要求真的成功(200)——不是永远409，才有判别力。
  const h3Free=(await f.api('POST','',{category:'laptop',name:'无阻碍撞号对照资产',placement:{kind:'depot'}})).body;
  const rmH3FreeBefore=await f.api('GET','/'+h3Free.id+'/record-management',undefined,1);
  check('H1步骤2(前提断言):h3Free此刻references七项全部为0,delete_reason为空(无任何删除阻碍)',
    rmH3FreeBefore.body.references.children===0&&rmH3FreeBefore.body.references.stocktakes===0&&rmH3FreeBefore.body.references.reconciles===0&&rmH3FreeBefore.body.references.inspections===0&&rmH3FreeBefore.body.references.inspection_sheets===0&&rmH3FreeBefore.body.references.used===0&&rmH3FreeBefore.body.references.managed===0&&!rmH3FreeBefore.body.delete_reason,
    rmH3FreeBefore.body);
  await f.run('INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['room',h3Free.id,'撞资产编号旧机房材料.png',crypto.randomUUID()+'.bin','image/png',10,'2'.repeat(64),'initial','撞资产编号材料',1,'2020-01-01T00:00:00.000Z']);
  await f.run('INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['room',1,'撞真实room行编号材料.png',crypto.randomUUID()+'.bin','image/png',10,'3'.repeat(64),'initial','撞真实room行编号材料',1,'2020-01-01T00:00:00.000Z']);
  const rmH3FreeAfter=await f.api('GET','/'+h3Free.id+'/record-management',undefined,1);
  check('H1步骤4:两条撞号room行插入后,references与插入前逐字段全等(仍全0,未被误计入)',JSON.stringify(rmH3FreeAfter.body.references)===JSON.stringify(rmH3FreeBefore.body.references),{before:rmH3FreeBefore.body.references,after:rmH3FreeAfter.body.references});
  check('H1步骤4:delete_reason同样与插入前一致(为空)',rmH3FreeAfter.body.delete_reason===rmH3FreeBefore.body.delete_reason,rmH3FreeAfter.body.delete_reason);
  const h3FreeDelete=await f.api('POST','/'+h3Free.id+'/record-management',{action:'delete',reason:'H1零阻碍撞号验证',expected_version:h3Free.version},1);
  check('H1步骤5:零阻碍资产在撞号room行存在的情况下删除仍真的成功(200,不是被误挡409)',h3FreeDelete.status===200,h3FreeDelete.body);
  const h3FreeControl=await f.all("SELECT * FROM it_asset_record_controls WHERE asset_id=? AND state='deleted'",[h3Free.id]);
  check('H1步骤5(读库核):资产行确实被标记为已删除(it_asset_record_controls存在state=deleted的行)',h3FreeControl.length===1,h3FreeControl);
  const h3Free2=(await f.api('POST','',{category:'laptop',name:'无阻碍撞号对照资产2(彻底删除)',placement:{kind:'depot'}})).body;
  await f.run('INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',['room',h3Free2.id,'撞资产编号旧机房材料2.png',crypto.randomUUID()+'.bin','image/png',10,'4'.repeat(64),'initial','撞资产编号材料2',1,'2020-01-01T00:00:00.000Z']);
  const h3Free2Purge=await f.api('DELETE','/'+h3Free2.id+'/purge',{reason:'H1零阻碍撞号彻底删除验证',confirm_name:h3Free2.name,expected_version:h3Free2.version},1);
  check('H1步骤6:零阻碍资产在撞号room行存在的情况下彻底删除仍真的成功(200)',h3Free2Purge.status===200,h3Free2Purge.body);
  const h3Free2Row=await f.all('SELECT * FROM it_assets WHERE id=?',[h3Free2.id]);
  check('H1步骤6(读库核):资产行确实从it_assets物理消失',h3Free2Row.length===0,h3Free2Row);

  console.log(`EVIDENCE_BROWSER PASS=${pass} FAIL=0`);
 }finally{await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
