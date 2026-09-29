'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright'),xlsx=require('xlsx');
const {createFixture,ensureDeviceInspectionsTable}=require('./it-ledger-browser-fixture');
let pass=0;const check=(n,v)=>{assert.ok(v,n);pass++;console.log('[OK] '+n);};
async function main(){
 // C7-b（长任务E·巡检台账改版，用户2026-09-25 22:xx裁定）：单独设备巡检整体退役（POST
 // /inspections标准采集、POST /inspections/:id/review判断、四条设备巡检附件路由）——本文件原本
 // 靠一个假采集器（下方已删除的collector变量）驱动POST /inspections构造巡检记录，路由退役后不再
 // 需要任何采集器：GET /（下方仍在用，看仍存在的it_device_inspections行）与GET /:id(\d+)是纯读
 // 路由，不触发采集；本文件也不再需要注入inspectionCollector（省略后createFixture()按生产装配
 // 回落到真实collector，host()读不到配置文件时返回null，但从不会被调用到，不影响任何断言）。
 let browser;
 const f=await createFixture({});console.log('ISOLATED_ARTIFACTS='+f.dir);
 const create=async body=>{const r=await f.api('POST','',body);assert.equal(r.status,201,JSON.stringify(r));return r.body;};
 const get=async id=>(await f.api('GET','/'+id)).body;
 const manage=(a,action,extra={},uid=1)=>f.api('POST','/'+a.id+'/record-management',{action,reason:'核实登记错误',expected_version:a.version,...extra},uid);
 const report=async rows=>{const wb=xlsx.utils.book_new();xlsx.utils.book_append_sheet(wb,xlsx.utils.aoa_to_sheet([['编号','资产名称','部门','设备名称','品牌','型号','购置日期','购置金额','数量','责任人','备注'],...rows]),'固定资产');const form=new FormData();form.append('file',new Blob([xlsx.write(wb,{type:'buffer',bookType:'xlsx'})]),'records.xlsx');const r=await fetch(f.base+'/api/it-assets/reconciles',{method:'POST',headers:{Authorization:'Bearer fixture-1'},body:form});return {status:r.status,body:await r.json()};};
 // C7-b：标准单独采集入口已退役，本文件里"需要一条真实存在的it_device_inspections记录"的地方（原来
 // 经POST /inspections真实请求产生）改成直接SQL插入——语义对应方案v0.6§6"不属于任何巡检单的历史
 // 记录,生产不存在,只有本地测试数据"，与verify-it-ledger-inspection-collect.js的
 // seedStandaloneInspection()、verify-it-ledger-evidence-browser.js的直接插入手法同一约定。
 async function seedInspection(asset,opts={}){
  // L5（C7-c，Opus预筛）：建表DDL不再本文件手写一份，直接调用生产代码inspection-collect.js的
  // ensure()（经it-ledger-browser-fixture.js的ensureDeviceInspectionsTable转接），与
  // evidence-browser.js共用同一处实现。
  await ensureDeviceInspectionsTable(f);
  const now=new Date().toISOString();
  const snapshot=JSON.stringify({schema_version:1,source_host:opts.host||'192.0.2.90',server:{serial_number:opts.sn||asset.sn||'RECORD-SERVER'},volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[],collection_status:'success',started_at:now,completed_at:now});
  const ins=await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)',[asset.id,asset.name,opts.host||'192.0.2.90',now,now,'success',snapshot,1]);
  return {id:ins.lastID};
 }
 try{
  const laptop=await create({category:'laptop',name:'错分笔记本',sn:'REC-LAP',attrs:{cpu:'CPU',ram:'16G',os:'OS'},fin_amount:54321,placement:{kind:'custodian',custodian_name:'甲',location_text:'办公区'}});
  let r=await f.api('GET','/'+laptop.id+'/record-management',undefined,3);check('只读可看约束且无财务',r.status===200&&!JSON.stringify(r.body).includes('54321'));check('管理GET不建表',(await f.all("SELECT name FROM sqlite_master WHERE name='it_asset_record_controls'")).length===0);
  check('无ACL无法读管理信息',(await f.api('GET','/'+laptop.id+'/record-management',undefined,4)).status===403);
  check('只读不能更正',(await manage(laptop,'reclassify',{category:'desktop'},3)).status===403);
  check('更正原因必填',(await manage(laptop,'reclassify',{category:'desktop',reason:' '})).status===400);
  check('普通编辑仍拒绝直接改类别',(await f.api('PUT','/'+laptop.id,{expected_version:laptop.version,category:'desktop'})).status===400);
  r=await manage(laptop,'reclassify',{category:'desktop'},2);check('维护员终端互转保留领用',r.status===200&&r.body.asset.category==='desktop'&&r.body.asset.custodian_name==='甲'&&r.body.asset.location_text==='办公区'&&r.body.asset.version===laptop.version+1&&r.body.asset.attrs.cpu==='CPU');
  check('陈旧版本拒绝',(await manage(laptop,'reclassify',{category:'laptop'})).status===409);
  const h=await get(laptop.id);check('前后完整审计',h.record_history.length===1&&h.record_history[0].before.category==='laptop'&&h.record_history[0].after.category==='desktop'&&h.record_history[0].operator_id===2&&h.record_history[0].before.fin_amount===54321);
  check('审计递归财务脱敏',!JSON.stringify((await f.api('GET','/'+laptop.id,undefined,3)).body).includes('54321'));
  check('在用设备不能作废',(await manage(h.asset,'void')).status===409);
  const hardware=await create({category:'other',name:'设备更正',attrs:{subtype:'旧类型',ip:'192.0.2.1'},placement:{kind:'depot'}});
  r=await manage(hardware,'reclassify',{category:'server'});check('库房其他设备更正为服务器',r.status===200&&r.body.asset.u_height===1&&r.body.asset.attrs.ip==='192.0.2.1'&&!('subtype'in r.body.asset.attrs));
  check('旧专属字段仍在审计',(await get(hardware.id)).record_history[0].before.attrs.subtype==='旧类型');
  check('不跨硬件软件',(await manage(r.body.asset,'reclassify',{category:'software'})).status===409);
  const rack=(await f.api('POST','/racks',{name:'类别机柜',u_total:42})).body;
  let server=await create({category:'server',name:'宿主',sn:'RECORD-SERVER',u_height:2,slot_count:4,attrs:{ip:'192.0.2.90'},placement:{kind:'rack',rack_id:rack.id,u_start:1}});
  const disk=await create({category:'disk',name:'挂载盘',placement:{kind:'host',parent_asset_id:server.id,slot_no:1},peer_versions:{[server.id]:server.version}});server=(await get(server.id)).asset;
  check('有随装盘不能作废',(await manage(server,'void')).status===409);check('挂载盘不能删除',(await manage(disk,'delete')).status===409);
  r=await manage(server,'reclassify',{category:'other'});check('服务器与机柜other互转保留占位和盘位',r.status===200&&r.body.asset.rack_id===rack.id&&r.body.asset.u_height===2&&r.body.asset.slot_count===4&&(await get(disk.id)).asset.parent_asset_id===server.id);
  server=(await manage(r.body.asset,'reclassify',{category:'server'})).body.asset;
  // C7-b：标准单独采集入口已退役——references().inspections只是COUNT(*) FROM it_device_inspections
  // WHERE asset_id=?（record-management.js:36），与sheet_id/巡检单无关，直接SQL插入一条等价构造
  // "存在巡检"这个引用条件，业务规则本身不变。
  const inspection=await seedInspection(server);check('存在巡检不能转非服务器',(await manage(server,'reclassify',{category:'other'})).status===409);
  // C6-b M1（Opus预筛，按C3 H1模式改写——verify-it-ledger-inspection-collect.js:1122-1150 同款
  // 判别力）：C6原实现用rack_out这个真实动作把设备移出机柜排"占位置"理由——但rack_out自己会写一行
  // it_asset_events(非register)，使refs.used立即变非零，与refs.inspection_sheets同时满足"已有业务
  // 或管理历史"这条拒绝理由，测不出这条409到底是不是inspection_sheets本身单独起效（无判别力；探针
  // prescreen/probe-c6-records.log第4/5行已实测验证：NO SHEET情形inspection_sheets===0但
  // refs.used===1，delete仍409同样文案）。改用直接SQL把设备挪出机柜（不经过任何写动作，不产生
  // it_asset_events/it_asset_record_audit行，同C3 H1手法），前提断言inspection_sheets是唯一非零
  // 字段；再配一台完全独立、从未出现在任何巡检单里的对照设备，证明它能正常删除、delete_reason为
  // null——排除"这个库/这个用户此刻恰好被别的什么全局状态挡住"的可能性。
  const scopeRack=(await f.api('POST','/racks',{name:'巡检范围机柜',room:'巡检范围机房',u_total:4})).body;
  const scopeAsset=await create({category:'other',name:'巡检范围内设备',u_height:1,placement:{kind:'rack',rack_id:scopeRack.id,u_start:1}});
  const scopeSheet=(await f.api('POST','/inspections/sheets',{room_name:'巡检范围机房'})).body;
  check('闸准备:巡检单已把该设备纳入device段(前提成立)',(await f.all("SELECT COUNT(*) n FROM it_inspection_sheet_items WHERE sheet_id=? AND section='device' AND target_id=?",[scopeSheet.id,scopeAsset.id]))[0].n===1);
  // 直接SQL挪出机柜+置in_depot——不经过rack_out这个action；一并清空u_start（C3已知坑：只清rack_id
  // 会留下u_start非空，'非在位机柜设备须rack_id/u_start为空'这条资产不变量在真调用写动作时会拦下来）。
  await f.run("UPDATE it_assets SET rack_id=NULL, u_start=NULL, status='in_depot' WHERE id=?",[scopeAsset.id]);
  const rmScoped=await f.api('GET','/'+scopeAsset.id+'/record-management',undefined,1);
  const refsScoped=rmScoped.body.references;
  // C6-d M2（codex 44R复检"前提断言不完整"）：references()共8个字段(children/stocktakes/reconciles/
  // open_batches/inspections/inspection_sheets/used/managed)——原前提断言漏了children。虽然scopeAsset
  // 是category='other'的叶子设备天然不会有子资产，children理论上恒为0，但"理论上恒为0"不等于"断言里
  // 写了它恒为0"，显式补上，让"其余六项(children/stocktakes/reconciles/inspections/used/managed)全
  // 为0、仅inspection_sheets非零"这条前提断言字段覆盖完整（open_batches是stocktakes/reconciles各自
  // opened子计数派生的聚合字段，不算独立的第七个引用来源，随stocktakes/reconciles为0而恒为0，不单独
  // 列但也一并核对不影响判别力）。
  check('闸准备:除inspection_sheets外其余六项(children/stocktakes/reconciles/inspections/used/managed)全为0(排除别的理由抢先命中,前提成立)',refsScoped.children===0&&refsScoped.used===0&&refsScoped.managed===0&&refsScoped.stocktakes===0&&refsScoped.reconciles===0&&refsScoped.inspections===0&&refsScoped.open_batches===0,refsScoped);
  check('闸准备:inspection_sheets非零(仅有的非零字段,前提成立)',refsScoped.inspection_sheets===1,refsScoped);
  const deleteAttemptScoped=await manage(rmScoped.body.asset,'delete');
  check('出现在巡检单范围内的资产不能删除',deleteAttemptScoped.status===409);
  // LOW-4（C5a-g 追加 E）：先证明delete_reason本身是个有内容的字符串，不是空串/undefined/null这类"恰好
  // 两边都是假值"的退化情况——不然下面的全等断言可能只是在证明"两边都没写"，而不是"两边真的写了同一句
  // 有意义的话"。
  check('LOW-4(C5a-g新增):delete_reason是非空字符串(不是空串/undefined等退化值)',typeof rmScoped.body.delete_reason==='string'&&rmScoped.body.delete_reason.length>0,rmScoped.body.delete_reason);
  // LOW-5（C6-e）：只断言409状态码证明不了这次409确实是同一条"已有业务或管理历史"理由触发的——服务端
  // 完全可能因为别的原因(比如版本冲突)也返回409。核对实际拒绝响应体里的message与record-management
  // 预览接口给出的delete_reason全等，把"这条409就是巡检单范围引用挡住的"这件事坐实，不只是巧合同码。
  check('LOW-5(C6-e新增):409响应体的删除理由与record-management预览的delete_reason全等',deleteAttemptScoped.body.message===rmScoped.body.delete_reason,deleteAttemptScoped.body);
  // 44T L1（codex 44 审查修复）+ C6-d用户裁定（G6=A：删除理由保持通用文案，验收改为"全等+前提断言证明
  // 仅巡检单引用触发"）：原断言只匹配"已有业务或管理历史"这句子串——通读record-management.js确认这句
  // 文案是stocktakes/reconciles/inspections/inspection_sheets/used/managed六种引用类型共用的同一段OR
  // 链拼出的通用文案（第78行附近），本身没有巡检单专属的错误码或子文案可用。主会话裁定不新增专属码、
  // 保持通用文案，验收标准改为"全等断言(锁死文案不能悄悄变宽/变窄) + 前提断言(证明这条测试构造下确实
  // 只有inspection_sheets这一条引用在起效，不是被别的理由顺带命中)"两件套——上面的前提断言已证明除
  // inspection_sheets外其余六项全为0，因此在*这条已验证的测试构造下*，这段通用文案确实由
  // inspection_sheets单独触发；全等断言把"接受任意包含这几个字的文案"收紧成"这句话必须逐字一致"。
  check('record-management给出巡检单范围理由(全等完整文案,非子串匹配)',rmScoped.body.delete_reason==='已有业务或管理历史，请使用作废保留记录',rmScoped.body.delete_reason);
  // 对照组：全新设备，从未出现在任何巡检单里——能正常删除，delete_reason为null，证明上面的409确实
  // 是inspection_sheets这一条单独起效，不是这个库/这个用户此刻被别的什么全局状态挡住。
  const controlAsset=await create({category:'laptop',name:'不在巡检单内的对照设备',placement:{kind:'depot'}});
  const rmControl=await f.api('GET','/'+controlAsset.id+'/record-management',undefined,1);
  check('对照组:不在巡检单范围内的设备delete_reason为null(判别力对照)',rmControl.body.delete_reason===null,rmControl.body);
  check('对照组:不在巡检单范围内的设备可正常删除(判别力对照)',(await manage(controlAsset,'delete')).status===200);
  const fresh=await create({category:'laptop',name:'可删除误建',sn:'DELETE-SN',asset_no:'DELETE-NO',placement:{kind:'depot'}});
  check('维护员不能删除',(await manage(fresh,'delete',{},2)).status===403);
  r=await manage(fresh,'delete');check('逻辑删除成功',r.status===200&&r.body.control.state==='deleted');check('原行及登记历史保留',(await get(fresh.id)).events.length===1&&(await get(fresh.id)).asset.sn==='DELETE-SN');
  check('有效列表排除删除',(await f.api('GET','')).body.items.every(x=>x.id!==fresh.id));check('归档筛选可查',(await f.api('GET','?record_state=deleted')).body.items.some(x=>x.id===fresh.id));
  check('删除后编辑拒绝',(await f.api('PUT','/'+fresh.id,{expected_version:r.body.asset.version,name:'绕过'})).status===409);
  check('删除后动作拒绝',(await f.api('POST','/'+fresh.id+'/actions/mark_status',{expected_version:r.body.asset.version,status:'faulty'})).status===409);
  check('删除后重复管理拒绝',(await manage(r.body.asset,'void')).status===409);
  const duplicate=await f.api('POST','',{category:'laptop',name:'重复SN',sn:'DELETE-SN',placement:{kind:'depot'}});check('归档不释放SN',duplicate.status===409);
  const software=await create({category:'subscription',name:'无效订阅',expires_at:'2020-01-01'});const expiry=(await f.api('GET','/me')).body.expiring_count;r=await manage(software,'void');check('作废订阅不改变业务状态且移出到期计数',r.status===200&&r.body.asset.status==='active'&&(await f.api('GET','/me')).body.expiring_count===expiry-1);
  const scoped=await create({category:'laptop',name:'盘点关联',placement:{kind:'depot'}});const batch=(await f.api('POST','/stocktakes',{title:'验证引用',scope:{categories:['laptop']}})).body;
  check('新盘点不包含删除记录',(await f.api('GET','/stocktakes/'+batch.id)).body.items.every(x=>x.asset_id!==fresh.id));check('开放盘点阻断类别更正',(await manage(scoped,'reclassify',{category:'desktop'})).status===409);check('开放盘点阻断作废',(await manage(scoped,'void')).status===409);
  await f.api('POST','/stocktakes/'+batch.id+'/close',{force:true});check('有盘点历史不能删除',(await manage(scoped,'delete')).status===409);check('盘点历史阻止彻底删除',(await f.api('DELETE','/'+scoped.id+'/purge',{reason:'测试',confirm_name:scoped.name,expected_version:scoped.version})).status===409);check('关闭盘点后可作废',(await manage(scoped,'void')).status===200);
  check('历史盘点快照保留',(await f.api('GET','/stocktakes/'+batch.id)).body.items.some(x=>x.asset_id===scoped.id));
  const rec=await create({category:'other',name:'对账引用',asset_no:'REC-100',placement:{kind:'depot'}});r=await report([['REC-100','对账引用'],['DELETE-NO','已删除资产']]);assert.equal(r.status,201,JSON.stringify(r));const recBatch=(await f.api('GET','/reconciles/'+r.body.id)).body;
  check('对账新快照不包含已删除资产',!recBatch.items.some(x=>x.asset_id===fresh.id));check('开放对账阻断作废',(await manage(rec,'void')).status===409);assert.equal((await f.api('POST','/reconciles/'+recBatch.id+'/close',{force:true})).status,200);check('已关闭对账仍阻止删除误建',(await manage(rec,'delete')).status===409);check('对账历史阻止彻底删除',(await f.api('DELETE','/'+rec.id+'/purge',{reason:'测试',confirm_name:rec.name,expected_version:rec.version})).status===409);
  // Archiving must not turn a historical reconcile row into a "broken reference".
  check('关闭对账后可作废对账资产',(await manage((await get(rec.id)).asset,'void')).status===200);
  const recItem=(await f.api('GET','/reconciles/'+recBatch.id)).body.items.find(x=>x.asset_id===rec.id),recRow=(await f.api('GET','/reconciles/'+recBatch.id+'/export')).body.rows.find(x=>x.external_asset_no==='REC-100');
  check('历史对账实时列标注已作废而非引用异常',recItem.current?.record_state==='voided'&&recItem.current.id===rec.id&&recRow.link_state==='台账记录已作废');
  const host=await create({category:'server',name:'删除空宿主',u_height:1,slot_count:2,placement:{kind:'depot'}});r=await manage(host,'delete');const reg=await f.api('POST','',{category:'disk',name:'非法挂载',placement:{kind:'host',parent_asset_id:host.id,slot_no:1},peer_versions:{[host.id]:r.body.asset.version}});check('数据库闸阻止挂到已删除宿主',reg.status===409&&reg.body.code==='ASSET_RECORD_INACTIVE');
  const race=await create({category:'laptop',name:'并发更正',placement:{kind:'depot'}});const parallel=await Promise.all([manage(race,'reclassify',{category:'desktop'}),manage(race,'reclassify',{category:'ap'})]);check('并发更正只有一条审计',parallel.filter(x=>x.status===200).length===1&&parallel.filter(x=>x.status===409).length===1&&(await get(race.id)).record_history.length===1);
  // C7-b（用户2026-09-25 22:xx裁定）：本段原文一次性验证三件事——①采集期间撤权/资产下架/作废都
  // 不让在途采集落库（靠一个假采集器wait+released构造锁外窗口）②作废后巡检历史仍可读③作废后判断/
  // 附件被拒。标准单独采集入口（POST /inspections）整体退役后：
  //   ①锁外窗口"撤权/下架/作废三者各自不落库"这条性质，已在
  //     verify-it-ledger-inspection-collect.js 的 testRaceWindowReverify（巡检单采集入口，同一段
  //     "第一阶段判资格→锁外调用collector→第二阶段重新判资格"机制）等价覆盖，三种触发条件各自独立
  //     成一个scenario：
  //       撤写权限   → testRaceWindowReverify「调用者写权限被收回」:312-314（403 LEDGER_FORBIDDEN）
  //       资产下架/离柜（非在用）→ testRaceWindowReverify「资产改为非在用」:308-310（409 SHEET_STATE）
  //       作废/删除  → testRaceWindowReverify「资产在锁外窗口被作废」「...被删除」（C7-b新增，紧跟
  //                    在原host()内部故障场景之后）：直接SQL插it_asset_record_controls控制行触发
  //                    target()内部assertActive()，同样映射409 SHEET_STATE（与"资产改为非在用"
  //                    观测到的HTTP契约一致，但底层代码路径是assertActive()判定分支，不是status列
  //                    判定分支，仍有独立判别力，理由见该文件C7-b注释原文）
  //     本文件不再需要一个真实的wait模式采集器+entered/release时序同步来重建这条性质，故整段删除，
  //     不新建等价浏览器用例（用户明确要求"不要在浏览器测试里重建"）。
  //   ②"作废后巡检历史仍可读"改用GET /inspections?asset_id=（列表接口，仍是保留路由，可见性不变），
  //     见下面新写法；disk_unmount+rack_out+void三个动作序列本身不是retired路由，保留——它们是让
  //     server真正进入"作废"状态所必须的业务前置（有随装盘不能作废/需先下架），本文件151行之后的
  //     浏览器段还要用这个"已作废的server"验证抽屉巡检页签UI，不能删。
  //   ③"作废后判断拒绝"/"作废后附件拒绝"测的是已退役的POST /inspections/:id/review与
  //     POST .../evidence 两条路由——它们现在对任何id、任何资产状态都404（与资产是否作废无关，
  //     404是路由层面的），这条"因为作废才被拒"的判别力已经不存在。该退役事实本身（含合法id探针）
  //     已在verify-it-ledger-evidence-browser.js的"C7退役路由404(含合法id)"系列断言里覆盖（该文件
  //     用直接SQL种的记录id做探针，判别力比这里用真实业务流程凑出的id更聚焦），本文件不重复。
  server=(await get(server.id)).asset;
  const diskNow=(await get(disk.id)).asset;const detached=await f.api('POST','/'+disk.id+'/actions/disk_unmount',{expected_version:diskNow.version,to:'in_depot',peer_versions:{[server.id]:server.version}});assert.equal(detached.status,200,JSON.stringify(detached));
  server=(await get(server.id)).asset;const out=await f.api('POST','/'+server.id+'/actions/rack_out',{expected_version:server.version,to:'in_depot'});assert.equal(out.status,200);server=out.body;
  r=await manage(server,'void');assert.equal(r.status,200,JSON.stringify(r));
  check('作废后巡检历史仍可读(列表接口,保留路由可见性不变)',(await f.api('GET','/inspections?asset_id='+server.id)).body.items.some(x=>x.id===inspection.id));
  // L6（C7-c，Opus预筛）：单条只读详情接口同样不受资产作废影响——GET /inspections/:id(\d+)的可见性
  // 只按记录自己是否归属巡检单判定(inspections.js:141起)，与资产本身是否作废(record-management的
  // it_asset_record_controls)完全是两套独立机制，之前只测过列表接口，单条详情这一支没有断言过。
  check('L6:资产作废后GET /inspections/<id>单条详情仍200',(await f.api('GET','/inspections/'+inspection.id)).status===200);
  const rollback=await create({category:'laptop',name:'事务回滚验证',placement:{kind:'depot'}});await f.run(`CREATE TRIGGER record_test_rollback BEFORE INSERT ON it_asset_record_audit WHEN NEW.asset_id=${rollback.id} BEGIN SELECT RAISE(ABORT,'fixture rejection'); END`);const failed=await manage(rollback,'void');check('审计失败回滚资产和归档状态',failed.status===500&&(await get(rollback.id)).asset.version===rollback.version&&!(await get(rollback.id)).record_control);await f.run('DROP TRIGGER record_test_rollback');
  check('维护员不能作废',(await manage(rollback,'void',{},2)).status===403);
  const ambiguous1=await create({category:'other',name:'歧义候选一',asset_no:'dup-check',placement:{kind:'depot'}});await create({category:'other',name:'歧义候选二',asset_no:'DUP-CHECK',placement:{kind:'depot'}});const ambiguous=await report([['DUP-CHECK','册面歧义']]);assert.equal(ambiguous.status,201);check('歧义候选引用也阻断作废',(await manage(ambiguous1,'void')).status===409);await f.api('POST','/reconciles/'+ambiguous.body.id+'/close',{force:true});
  const changed=await create({category:'other',name:'曾编辑记录',placement:{kind:'depot'}});const edited=(await f.api('PUT','/'+changed.id,{expected_version:changed.version,name:'已编辑记录'})).body;check('有编辑历史禁止删除',(await manage(edited,'delete')).status===409);
  const invalid=await manage(edited,'reclassify',{category:'server',status:'retired'});check('管理载荷拒绝夹带状态',invalid.status===400);
  const maxVersion=await create({category:'laptop',name:'版本边界',placement:{kind:'depot'}});await f.run('UPDATE it_assets SET version=? WHERE id=?',[Number.MAX_SAFE_INTEGER,maxVersion.id]);check('管理动作拒绝版本溢出',(await manage({...maxVersion,version:Number.MAX_SAFE_INTEGER},'void')).status===409);
  const purgeHost=await create({category:'server',name:'彻底删除测试宿主',u_height:1,slot_count:1,placement:{kind:'depot'}});
  const purgeDisk=await create({category:'disk',name:'彻底删除测试硬盘',sn:'PURGE-USED-1',placement:{kind:'host',parent_asset_id:purgeHost.id,slot_no:1},peer_versions:{[purgeHost.id]:purgeHost.version}});
  const unmounted=await f.api('POST','/'+purgeDisk.id+'/actions/disk_unmount',{expected_version:purgeDisk.version,to:'in_depot',peer_versions:{[purgeHost.id]:(await get(purgeHost.id)).asset.version}});check('彻底删除测试盘先拆下',unmounted.status===200);
  const usedAsset=(await get(purgeDisk.id)).asset,usedInfo=(await f.api('GET','/'+purgeDisk.id+'/record-management')).body,hostEvents=(await get(purgeHost.id)).events.length;
  // Purge must never be wider than logical deletion: an asset with install/remove history keeps it.
  check('有装拆历史的散盘不能彻底删除',!!usedInfo.purge_reason&&!!usedInfo.delete_reason&&(await f.api('DELETE','/'+purgeDisk.id+'/purge',{reason:'测试',confirm_name:usedAsset.name,expected_version:usedAsset.version})).status===409);
  check('拒绝彻底删除后宿主历史完整',(await get(purgeHost.id)).events.length===hostEvents&&hostEvents===3&&(await get(purgeDisk.id)).asset.id===purgeDisk.id);
  check('曾编辑记录不能彻底删除',(await f.api('DELETE','/'+edited.id+'/purge',{reason:'测试',confirm_name:edited.name,expected_version:edited.version})).status===409);
  check('宿主登记的盘即使拆下也不能单独彻底删除',(await f.api('GET','/'+purgeDisk.id+'/record-management')).body.purge_reason.length>0);
  // Isolate the shared-operation layer: register-only, detached, no refs, but its register op also holds another asset's row.
  const sharedDisk=await create({category:'disk',name:'共享登记盘',placement:{kind:'depot'}}),sharedOp=(await f.all('SELECT op_id FROM it_asset_events WHERE asset_id=?',[sharedDisk.id]))[0].op_id;
  await f.run("INSERT INTO it_asset_events(op_id,asset_id,action,role,related_asset_id,from_state,to_state,operator_id) VALUES(?,?,'register','affected',?,'in_depot','in_depot',1)",[sharedOp,purgeHost.id,sharedDisk.id]);
  const sharedInfo=(await f.api('GET','/'+sharedDisk.id+'/record-management')).body,sharedPurge=await f.api('DELETE','/'+sharedDisk.id+'/purge',{reason:'测试',confirm_name:sharedDisk.name,expected_version:sharedDisk.version});
  check('登记操作含他资产行时仅共享层拒绝彻底删除',!sharedInfo.delete_reason&&(sharedInfo.purge_reason||'').includes('其他资产')&&sharedPurge.status===409&&(await get(sharedDisk.id)).asset.id===sharedDisk.id&&(await f.all('SELECT id FROM it_asset_events WHERE op_id=? AND asset_id=?',[sharedOp,purgeHost.id])).length===1);
  const mis=await create({category:'disk',name:'误建硬盘',sn:'PURGE-DISK-1',asset_no:'PURGE-NO-1',placement:{kind:'depot'}}),misInfo=(await f.api('GET','/'+mis.id+'/record-management')).body;
  check('只有登记动作的误建记录可彻底删除',!misInfo.purge_reason&&!misInfo.delete_reason&&misInfo.purge_events===1);
  const purgeBody={reason:'测试误导入清理',confirm_name:mis.name,expected_version:mis.version};
  check('维护员不能彻底删除',(await f.api('DELETE','/'+mis.id+'/purge',purgeBody,2)).status===403);
  check('名称确认不匹配时拒绝',(await f.api('DELETE','/'+mis.id+'/purge',{...purgeBody,confirm_name:'错误名称'})).status===400);
  const purged=await f.api('DELETE','/'+mis.id+'/purge',purgeBody);check('彻底删除误建记录和登记事件',purged.status===200&&purged.body.deleted_events===1&&(await f.api('GET','/'+mis.id)).status===404&&(await f.all('SELECT id FROM it_asset_events WHERE asset_id=? OR related_asset_id=?',[mis.id,mis.id])).length===0);
  const audit=(await f.all('SELECT * FROM it_asset_purge_audit WHERE asset_id=?',[mis.id]))[0];
  check('删除审计留存资产快照与事件',audit.sn==='PURGE-DISK-1'&&audit.asset_no==='PURGE-NO-1'&&audit.category==='disk'&&JSON.parse(audit.before_json).name==='误建硬盘'&&JSON.parse(audit.events_json).length===1&&JSON.parse(audit.events_json)[0].action==='register'&&!Number.isNaN(Date.parse(audit.created_at)));
  check('彻底删除后SN可复用',(await f.api('POST','',{category:'disk',name:'重新登记硬盘',sn:'PURGE-DISK-1',placement:{kind:'depot'}})).status===201);
  const ui=await create({category:'laptop',name:'UI类别更正',attrs:{cpu:'演示CPU'},placement:{kind:'depot'}});const del=await create({category:'other',name:'UI误建记录',placement:{kind:'depot'}});const purgeUi=await create({category:'disk',name:'UI彻底删除测试',placement:{kind:'depot'}});
  browser=await chromium.launch({headless:true});const c=await browser.newContext({viewport:{width:1440,height:960}});await c.addInitScript(()=>localStorage.setItem('token','fixture-1'));const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(f.base+'/IT_Ledger.html#all');await p.locator(`[data-detail="${ui.id}"]`).click();await p.locator('#itlDetailActions [data-action="edit"]').click();await p.locator('[data-record-action="delete"]').waitFor();await p.locator('.itl-record-controls').scrollIntoViewIfNeeded();await p.screenshot({path:path.join(f.dir,'record-management-controls.png'),fullPage:true});
  await p.locator('#itlForm [name="category"]').selectOption('desktop');await p.locator('#itlForm [name="name"]').fill('未保存修改');await p.locator('#itlSubmit').click();check('同时修改资料不会丢失',await p.locator('#itlForm [name="name"]').inputValue()==='未保存修改'&&(await p.locator('#itlForm').innerText()).includes('同时修改'));
  await p.locator('#itlForm [name="name"]').fill(ui.name);await p.locator('#itlSubmit').click();await p.locator('#itlRecordPreview').waitFor();check('类别确认显示变更预览',(await p.locator('#itlRecordPreview').innerText()).includes('台式机'));
  await p.locator('#itlForm [name="reason"]').fill('登记时误选笔记本，实物为台式机');await p.locator('#itlForm [name="confirmed"]').check();await p.locator('#itlSubmit').click();await p.locator('.itl-record-history').waitFor();check('浏览器更正落库并显示历史',(await get(ui.id)).asset.category==='desktop');await p.screenshot({path:path.join(f.dir,'record-category-history.png'),fullPage:true});
  await p.locator('#itlDetailActions [data-action="edit"]').click();await p.locator('.itl-record-controls').getByText('撤销误建登记不适用',{exact:false}).waitFor();check('有历史时不显示误建撤销按钮',await p.locator('[data-record-action="delete"]').count()===0);await p.locator('#itlModalClose').click();
  await p.locator('#itlDrawerClose').click();await p.locator(`[data-detail="${purgeUi.id}"]`).click();await p.locator('#itlDetailActions [data-action="edit"]').click();await p.locator('.itl-purge-entry summary').waitFor();await p.locator('.itl-purge-entry summary').click();await p.locator('[data-purge-asset]').click();await p.locator('#itlForm [name="reason"]').fill('UI测试彻底删除');await p.locator('#itlForm [name="confirm_name"]').fill(purgeUi.name);await p.locator('#itlForm [name="confirmed"]').check();await p.locator('#itlSubmit').click();check('编辑页高级入口彻底删除',(await f.api('GET','/'+purgeUi.id)).status===404);
  await p.locator(`[data-detail="${del.id}"]`).click();await p.locator('#itlDetailActions [data-action="edit"]').click();await p.locator('[data-record-action="delete"]').click();await p.locator('#itlForm [name="reason"]').fill('误建演示记录');await p.locator('#itlForm [name="confirmed"]').check();await p.locator('#itlSubmit').click();await p.locator('#itlAssetProfile .itl-notice').waitFor();check('删除后只读且归档可查',await p.locator('#itlDetailActions [data-action="edit"]').count()===0&&await p.locator('#itlRecordArchive').count()===1);
  // C7-b：服务器详情「设备巡检」页签已改为纯只读摘要表（#itlInspectionDetail 这个旧的快照详情容器
  // 已随一键采集/判断表单/附件区一起删除，见 it-ledger-inspections.js）——server此刻有一条
  // seedInspection()种的记录，摘要表会渲染出#itlInspectionRoot；等它出现，而不是等一个已经不存在的
  // 旧容器。断言范围从"没有写入口"扩到"没有任何已退役控件"（含#itlInspectionDetail本身），与
  // verify-it-ledger-inspections-browser.js的"页签上不存在已退役控件"同一断言口径。
  await p.locator('#itlDrawerClose').click();await p.locator('[data-record-scope]').selectOption('voided');await p.locator(`[data-detail="${server.id}"]`).click();await p.locator('[data-server-detail-tab="inspection"]').click();await p.locator('#itlInspectionRoot').waitFor();check('作废服务器巡检界面没有已退役控件(一键采集/判断表单/附件上传/旧快照详情容器)',await p.locator('#itlCollectInspection,#itlInspectionReview,[data-evidence-file],#itlInspectionDetail').count()===0);check('浏览器无异常',errors.length===0);
  const reopened=await createFixture({dbCopyPath:f.dbFile});try{check('含管理表的库可重新初始化',(await reopened.api('GET','/'+fresh.id)).body.record_control.state==='deleted');check('重新初始化后仍禁止修改归档',(await reopened.api('PUT','/'+fresh.id,{expected_version:(await get(fresh.id)).asset.version,name:'重启后绕过'})).status===409);}finally{await reopened.close();}
  console.log(`RECORDS_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
