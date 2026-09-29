'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const express=require('express'),XLSX=require('xlsx');

module.exports=async function verifyR3({check,withTimeout,rawAllOn,rawRunOn,logger}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'it-reconcile-r3-')),db=path.join(root,'fixture.db'),store=path.join(root,'originals');
  let mod,server;const errors=[];
  const all=(sql,args=[])=>withTimeout(rawAllOn(db,sql,args),5000,'R3 raw read');
  const run=(sql,args=[])=>withTimeout(rawRunOn(db,sql,args),5000,'R3 raw write');
  const same=(a,b)=>{try{assert.deepStrictEqual(a,b);return true;}catch(_){return false;}};
  const results=['pending','found','missing','mismatch','not_in_ledger','ledger_added','not_in_sheet','confirmed_off_book','ambiguous','ledger_fixed'];
  const tables=['it_assets','it_asset_events','it_stocktakes','it_stocktake_items','it_reconciles','it_reconcile_items'];
  const snapshot=async()=>{const state={};for(const table of tables)state[table]=await all(`SELECT * FROM ${table} ORDER BY id`);return state;};
  const files=()=>fs.existsSync(store)?fs.readdirSync(store).sort().map(name=>({name,sha:fs.statSync(path.join(store,name)).isDirectory()?'directory':crypto.createHash('sha256').update(fs.readFileSync(path.join(store,name))).digest('hex')})):[];
  try{
    await run('CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,role TEXT)');
    for(const id of [1,2,3])await run('INSERT INTO users VALUES(?,?,?,?)',[id,'user'+id,'User '+id,id===1?'admin':'user']);
    mod=require('../routes/it-ledger')({logger:{...logger,error:(...args)=>{errors.push(args.join(' '));logger.error(...args);}},DB_FILE:db,reconcileStorageDir:store,enableTestHooks:true,
      authenticateToken:(req,res,next)=>{if(!req.headers['x-test-id'])return res.status(401).json({code:'TEST_UNAUTHORIZED'});req.user={id:Number(req.headers['x-test-id']),role:req.headers['x-test-role']||'user'};next();},
      requireAdmin:(req,res,next)=>req.user.role==='admin'?next():res.status(403).json({code:'LEDGER_FORBIDDEN'})});
    await withTimeout(mod.initSchema(),15000,'R3 init');check('R3临时模块ready',mod._internals.state.ready===true);
    const app=express();app.use(express.json());app.use('/api',mod.router);server=await withTimeout(listenOnSafePort(app, null), 5000, 'R3 listen');
    const base=`http://127.0.0.1:${server.address().port}/api/it-assets`;
    const headers=(id=1)=>id===null?{}:{'x-test-id':String(id),'x-test-role':id===1?'admin':'user'};
    async function api(method,url,body,id=1){return withTimeout((async()=>{const response=await fetch(base+url,{method,headers:{...headers(id),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,body:await response.json()};})(),15000,'R3 HTTP');}
    async function ok(label,method,url,body,id=1,status=200){const before=await snapshot();const r=await api(method,url,body,id);check(label+':status',r.status===status,JSON.stringify(r));if(r.status!==status)throw Error(label+' expected success');const after=await snapshot();check(label+':台账及事件逐行全等',same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));return r.body;}
    async function reject(label,method,url,body,status=400,code='LEDGER_BAD_REQUEST',id=1){const before=await snapshot(),oldFiles=files();const r=await api(method,url,body,id);check(label+':精确状态/码',r.status===status&&r.body.code===code,JSON.stringify(r));check(label+':六表全部行不变',same(before,await snapshot()));check(label+':原件全集字节不变',same(oldFiles,files()));return r.body;}
    const bookRows=[['A','Book A',101],['S','Book S',102],['SUB','Book Sub',103],['AMB','Book Amb',104],['NEW','Book New',105]];
    async function batch(rows=bookRows){const before=await snapshot();const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['编号','资产名称','金额'],...rows]),'固定资产');const form=new FormData();form.append('file',new Blob([XLSX.write(book,{type:'buffer',bookType:'xlsx'})]),'r3.xlsx');const r=await withTimeout(fetch(base+'/reconciles',{method:'POST',headers:headers(),body:form}),10000,'R3 upload');const data=await r.json();check('R3上传夹具201',r.status===201,JSON.stringify(data));if(r.status!==201)throw Error('R3 upload fixture');const after=await snapshot();check('R3上传资产事件全等',same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));return data;}
    const detail=(id,user=1)=>ok('R3详情','GET',`/reconciles/${id}`,undefined,user);
    const rawBatch=async id=>(await all('SELECT * FROM it_reconciles WHERE id=?',[id]))[0];
    const rawItems=id=>all('SELECT * FROM it_reconcile_items WHERE reconcile_id=? ORDER BY id',[id]);
    for(const [id,level]of [[2,'write'],[3,'read']]){const r=await api('PUT',`/acl/${id}`,{level});check('R3ACL夹具',r.status===200,JSON.stringify(r));}
    const defs=[['other','A'],['disk','amb'],['laptop','AMB'],['other','B'],['software','S'],['subscription','SUB'],['other',null]],ids=[];
    for(const [category,number]of defs){const body={category,name:'R3 '+category+ids.length,owner_name:'Owner',owner_dept:'Dept',asset_class:'fixed',fin_amount:777,fin_vendor:'Private'};if(['software','subscription'].includes(category))body.expires_at='2027-01-01';else body.placement={kind:'depot',status:'in_depot'};const r=await api('POST','',body);check('R3资产夹具',r.status===201,JSON.stringify(r));if(r.status!==201)throw Error('R3 asset fixture');ids.push(r.body.id);await run('UPDATE it_assets SET asset_no=? WHERE id=?',[number,r.body.id]);}
    const b=await batch();let d=await detail(b.id);const byKey=key=>d.items.find(row=>row.external_key===key);
    check('R3全部七明细不丢弃任何分类',d.items.length===7&&same(d.counts,{pending:3,found:0,missing:0,mismatch:0,not_in_ledger:1,ledger_added:0,not_in_sheet:2,confirmed_off_book:0,ambiguous:1,ledger_fixed:0}));
    const reader=await detail(b.id,3),writer=await detail(b.id,2),list=await ok('R3列表','GET','/reconciles',undefined,3);
    check('R3列表计数与详情全等',list.items.length===1&&same(list.items[0].counts,d.counts));
    const sensitive=value=>value&&typeof value==='object'&&Object.entries(value).some(([key,v])=>/^fin_/.test(key)||key==='external_amount'||key==='stored_name'||sensitive(v));
    check('R3读者/写者非空明细且嵌套无财务',reader.items.length===7&&writer.items.length===7&&!sensitive(reader)&&!sensitive(writer)&&!sensitive(list));
    check('R3admin非空金额对照及原件名隐藏',d.items.filter(row=>row.external_key).every(row=>row.external_amount>0)&&d.items.filter(row=>row.current).every(row=>row.current.fin_amount===777)&&!Object.hasOwn(d.source_meta,'stored_name'));
    check('R3owner三字段不会误剥离',reader.items.filter(row=>row.current).every(row=>row.current.owner_name==='Owner'&&row.current.owner_dept==='Dept'&&row.current.asset_class==='fixed'));
    check('R3候选快照与current同时非空',byKey('AMB').ambiguous_candidates.length===2&&byKey('AMB').candidate_current.length===2&&byKey('AMB').candidate_current.every(row=>row.current.fin_amount===777));
    const originalAmb=byKey('AMB').ambiguous_candidates;await run("UPDATE it_assets SET name='Candidate now',version=version+1 WHERE id=?",[ids[1]]);await run("UPDATE it_assets SET asset_no='NOW-VALID' WHERE id=?",[ids[6]]);
    d=await detail(b.id);check('R3候选当前变化不覆盖快照',same(byKey('AMB').ambiguous_candidates,originalAmb)&&byKey('AMB').candidate_current.find(row=>row.id===ids[1]).current.name==='Candidate now');
    check('R3ledger_note以快照空编号派生',d.items.find(row=>row.asset_id===ids[6]).ledger_note==='未填编号'&&d.items.find(row=>row.asset_id===ids[6]).current.asset_no==='NOW-VALID');
    await reject('R3无ACL详情','GET',`/reconciles/${b.id}`,undefined,403,'LEDGER_FORBIDDEN',99);
    await reject('R3非法批次id','GET','/reconciles/not-an-id',undefined,400,'LEDGER_INVALID_ID');
    await reject('R3不存在批次','GET','/reconciles/999999',undefined,404,'LEDGER_NOT_FOUND');
    for(const [method,url,body]of [['PUT',`/reconciles/${b.id}/items/${byKey('A').id}/check`,{result:'found'}],['PUT',`/reconciles/${b.id}/note`,{note:'denied'}],['POST',`/reconciles/${b.id}/close`,{force:true}],['DELETE',`/reconciles/${b.id}`,undefined]])await reject('R3read无写权',method,url,body,403,'LEDGER_FORBIDDEN',3);
    for(const method of ['POST','DELETE'])await reject('R3write不是admin',method,`/reconciles/${b.id}${method==='POST'?'/close':''}`,method==='POST'?{force:true}:undefined,403,'LEDGER_FORBIDDEN',2);
    const checkPath=`/reconciles/${b.id}/items/${byKey('A').id}/check`;
    for(const actual of [undefined,null,{},'{}',[],{unknown:1},{version:1},{name:{}},{name:1},{owner_name:false}])await reject('R3非法actual','PUT',checkPath,actual===undefined?{result:'mismatch'}:{result:'mismatch',actual});
    for(const actual of [null,{}, {name:'observed'}])await reject('R3found禁止actual出现','PUT',checkPath,{result:'found',actual});
    for(const body of [{result:'found',stocktake_item_id:1},{result:'found',resolved_op_id:'x'},{result:'found',checked_by:2},{result:'found',ledger_snapshot:{}},{result:'found',note:'use note endpoint'},{}])await reject('R3禁止协议字段','PUT',checkPath,body);
    await reject('R3嵌套财务拒绝','PUT',checkPath,{result:'mismatch',actual:{fin_amount:1}},400,'FINANCE_FIELD_FORBIDDEN',2);
    await reject('R3pending错误链','PUT',checkPath,{result:'confirmed_off_book'},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3not_in_sheet不能found','PUT',`/reconciles/${b.id}/items/${d.items.find(row=>row.result==='not_in_sheet').id}/check`,{result:'found'},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3ambiguous不能ledger_added','PUT',`/reconciles/${b.id}/items/${byKey('AMB').id}/check`,{result:'ledger_added'},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3未处置不能普通关闭','POST',`/reconciles/${b.id}/close`,{},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3force只接受boolean','POST',`/reconciles/${b.id}/close`,{force:'true'});
    // A real UPDATE trigger proves that validation reads stored data, not the intended row.
    await run("CREATE TRIGGER r3_dirty AFTER UPDATE OF result ON it_reconcile_items BEGIN UPDATE it_reconcile_items SET note='dirty' WHERE id=NEW.id; END");
    await reject('R3check脏写实际回滚','PUT',checkPath,{result:'found'},500,'LEDGER_INTERNAL');await run('DROP TRIGGER r3_dirty');
    const aclBefore=await all('SELECT * FROM it_asset_acl ORDER BY user_id');
    await run('CREATE TRIGGER r3_revoke AFTER UPDATE OF result ON it_reconcile_items BEGIN DELETE FROM it_asset_acl WHERE user_id=2; END');
    await reject('R3终判撤权回滚','PUT',checkPath,{result:'found'},403,'LEDGER_FORBIDDEN',2);await run('DROP TRIGGER r3_revoke');check('R3ACL本身也回滚',same(aclBefore,await all('SELECT * FROM it_asset_acl ORDER BY user_id')));
    const migration=[['A','found'],['S','missing'],['SUB','mismatch'],['NEW','ledger_added'],['AMB','ledger_fixed']];
    const terminal=[];const originals=await rawItems(b.id);
    for(const [key,result]of migration){const before=byKey(key),body={result};if(result==='mismatch')body.actual={name:'Observed',owner_dept:null,location_desc:'Actual place'};const updated=await ok('R3合法迁移 '+result,'PUT',`/reconciles/${b.id}/items/${before.id}/check`,body,2);terminal.push(updated);check('R3核对人时间+快照形态全等',updated.checked_by===2&&typeof updated.checked_at==='string'&&same(updated.external_row,before.external_row)&&same(updated.ledger_snapshot,before.ledger_snapshot)&&same(updated.ambiguous_candidates,before.ambiguous_candidates));if(['ledger_added','ledger_fixed'].includes(result))check('R3弱声明明确标注',updated.result_note==='人工声明，待新批次验证');}
    const off=d.items.filter(row=>row.result==='not_in_sheet');terminal.push(await ok('R3第六合法迁移','PUT',`/reconciles/${b.id}/items/${off[0].id}/check`,{result:'confirmed_off_book'},2));
    for(const row of terminal)for(const result of results)await reject('R3终态禁止再迁移 '+row.result+'>'+result,'PUT',`/reconciles/${b.id}/items/${row.id}/check`,{result,...(result==='mismatch'?{actual:{name:'x'}}:{})},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    const confirmed=await ok('R3bulk合法确认册外','PUT',`/reconciles/${b.id}/items/bulk-confirm-off-book`,{item_ids:[off[1].id,off[1].id]},2);check('R3bulk去重仅返回一个',confirmed.items.length===1&&confirmed.items[0].checked_by===2);
    const preCloseItems=await rawItems(b.id);const closed=await ok('R3全终态普通关闭','POST',`/reconciles/${b.id}/close`,{});
    check('R3summary十计数+三字段精确',same(closed.summary,{pending:0,found:1,missing:1,mismatch:1,not_in_ledger:0,ledger_added:1,not_in_sheet:0,confirmed_off_book:2,ambiguous:0,ledger_fixed:1,closed_at:closed.closed_at,closed_by:1,force:false}));
    check('R3关闭不改任何明细',same(preCloseItems,await rawItems(b.id)));
    await reject('R3重复关闭不重算','POST',`/reconciles/${b.id}/close`,{force:true},409,'NO_OP_TRANSITION');
    await reject('R3关闭后check冻结','PUT',checkPath,{result:'found'},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3关闭后bulk冻结','PUT',`/reconciles/${b.id}/items/bulk-confirm-off-book`,{item_ids:[off[1].id]},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject('R3关闭后不能删除','DELETE',`/reconciles/${b.id}`,undefined,409,'ACTION_NOT_ALLOWED_IN_STATUS');
    const oldBatch=await rawBatch(b.id),oldItem=(await rawItems(b.id))[0];
    await ok('R3closed批次note','PUT',`/reconciles/${b.id}/note`,{note:'closed note'},2);await ok('R3closed明细note','PUT',`/reconciles/${b.id}/items/${oldItem.id}/note`,{note:'item note'},2);
    check('R3两类note只改变note整行',same(await rawBatch(b.id),{...oldBatch,note:'closed note'})&&same((await rawItems(b.id))[0],{...oldItem,note:'item note'}));
    for(const suffix of ['/note',`/items/${oldItem.id}/note`])await reject('R3note不能改核对字段','PUT',`/reconciles/${b.id}${suffix}`,{note:'x',result:'found'});
    const fresh=await batch();const freshD=await detail(fresh.id),pending=freshD.items.find(row=>row.result==='pending'),offs=freshD.items.filter(row=>row.result==='not_in_sheet');const bulkPath=`/reconciles/${fresh.id}/items/bulk-confirm-off-book`;
    await reject('R3单条跨批次拒绝','PUT',`/reconciles/${fresh.id}/items/${oldItem.id}/check`,{result:'found'},404,'LEDGER_NOT_FOUND');
    for(const item_ids of [[],[0],[1.5],['1'],[null],[true]])await reject('R3bulk非法id','PUT',bulkPath,{item_ids});
    let error=await reject('R3bulk混pending全或无','PUT',bulkPath,{item_ids:[offs[0].id,pending.id]});check('R3bulk指出首个不合格id和原因',same(error.detail,{item_id:pending.id,reason:'not_off_book'}));
    error=await reject('R3bulk跨批次全或无','PUT',bulkPath,{item_ids:[offs[0].id,off[0].id]});check('R3bulk跨批次定位',same(error.detail,{item_id:off[0].id,reason:'not_in_batch'}));
    await run("CREATE TRIGGER r3_bulk_dirty AFTER UPDATE OF result ON it_reconcile_items BEGIN UPDATE it_reconcile_items SET note='dirty bulk' WHERE id=NEW.id; END");await reject('R3bulk真实脏写回滚','PUT',bulkPath,{item_ids:offs.map(row=>row.id)},500,'LEDGER_INTERNAL');await run('DROP TRIGGER r3_bulk_dirty');
    const healthyPending=(await rawItems(fresh.id)).find(row=>row.id===pending.id);
    await run("UPDATE it_reconcile_items SET external_row='null' WHERE id=?",[pending.id]);
    await reject('R3JSON文本null不能冒充SQL空列','GET',`/reconciles/${fresh.id}`,undefined,500,'LEDGER_INTERNAL');
    await reject('R3坏快照核对也整笔回滚','PUT',`/reconciles/${fresh.id}/items/${pending.id}/check`,{result:'found'},500,'LEDGER_INTERNAL');
    await run('UPDATE it_reconcile_items SET external_row=? WHERE id=?',[healthyPending.external_row,pending.id]);
    const forced=await ok('R3force冻结未处置计数','POST',`/reconciles/${fresh.id}/close`,{force:true});check('R3force摘要含未处置分类',forced.summary.force===true&&forced.summary.pending===3&&forced.summary.ambiguous===1&&forced.summary.not_in_ledger===1&&forced.summary.not_in_sheet===2);
    const forward={pending:'found',not_in_ledger:'ledger_added',not_in_sheet:'confirmed_off_book',ambiguous:'ledger_fixed'};
    for(const remaining of Object.keys(forward)){
      const isolated=await batch(),state=await detail(isolated.id);
      for(const row of state.items.filter(row=>row.result!==remaining))await ok('R3隔离中间态夹具','PUT',`/reconciles/${isolated.id}/items/${row.id}/check`,{result:forward[row.result]});
      const current=await detail(isolated.id);check('R3只剩一种中间态 '+remaining,current.counts[remaining]>0&&Object.keys(forward).filter(key=>key!==remaining).every(key=>current.counts[key]===0));
      await reject('R3中间态独立阻塞 '+remaining,'POST',`/reconciles/${isolated.id}/close`,{},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    }
    // bulk/force-close both execution orders: signal, queue observation, bounded wait, finally release.
    async function ordered(first,second){let release,stop=false;const gate=new Promise(resolve=>{release=resolve;});const arrived=mod._internals.setTxnMidGate(gate);let a,z;try{a=first();await withTimeout(arrived,5000,'R3 arrived');z=second();await withTimeout(new Promise(resolve=>{const tick=()=>{if(stop)return;if(mod._internals.itTxnMutex._internals.waiterCount()>0)resolve();else setImmediate(tick);};tick();}),5000,'R3 queued');check('R3次请求真实排队',mod._internals.itTxnMutex._internals.waiterCount()>0);mod._internals.setTxnMidGate(null);release();return await withTimeout(Promise.all([a,z]),15000,'R3 ordered result');}finally{stop=true;mod._internals.setTxnMidGate(null);release();await withTimeout(Promise.allSettled([a,z].filter(Boolean)),15000,'R3 ordered cleanup');}}
    for(const closeFirst of [false,true]){const batchRow=await batch(),dt=await detail(batchRow.id),target=dt.items.find(row=>row.result==='not_in_sheet'),before=await snapshot();const bulk=()=>api('PUT',`/reconciles/${batchRow.id}/items/bulk-confirm-off-book`,{item_ids:[target.id]},2),close=()=>api('POST',`/reconciles/${batchRow.id}/close`,{force:true});const [first,second]=await ordered(closeFirst?close:bulk,closeFirst?bulk:close);check('R3并发先请求200',first.status===200,JSON.stringify(first));check('R3并发后请求按锁顺序',closeFirst?second.status===409&&second.body.code==='ACTION_NOT_ALLOWED_IN_STATUS':second.status===200,JSON.stringify(second));const after=await snapshot(),summary=JSON.parse((await rawBatch(batchRow.id)).summary);check('R3并发台账事件全等',same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));check('R3并发summary冻结时机精确',summary.confirmed_off_book===(closeFirst?0:1)&&summary.not_in_sheet===(closeFirst?2:1));if(closeFirst)check('R3close先行明细全部不变',same(before.it_reconcile_items,after.it_reconcile_items));}
    // Delete: DB rollback retains the original; cleanup error after commit cannot restore DB rows.
    const toDelete=await batch(),rawDelete=await rawBatch(toDelete.id),stored=JSON.parse(rawDelete.source_meta).stored_name;
    await run("CREATE TRIGGER r3_delete_abort BEFORE DELETE ON it_reconciles BEGIN SELECT RAISE(ABORT,'R3 delete fault'); END");await reject('R3删除中途失败全部回滚','DELETE',`/reconciles/${toDelete.id}`,undefined,500,'LEDGER_INTERNAL');await run('DROP TRIGGER r3_delete_abort');
    await ok('R3open删除成功','DELETE',`/reconciles/${toDelete.id}`);check('R3删除后行与文件均不存在',!(await rawBatch(toDelete.id))&&(await rawItems(toDelete.id)).length===0&&!fs.existsSync(path.join(store,stored)));await reject('R3删除后详情404','GET',`/reconciles/${toDelete.id}`,undefined,404,'LEDGER_NOT_FOUND');
    const cleanup=await batch(),cleanupStored=JSON.parse((await rawBatch(cleanup.id)).source_meta).stored_name,file=path.join(store,cleanupStored),backup=file+'.backup';fs.renameSync(file,backup);fs.mkdirSync(file);const errorCount=errors.length;
    await ok('R3文件清理失败仍提交删除','DELETE',`/reconciles/${cleanup.id}`);check('R3清理失败日志可定位且DB不回滚',!(await rawBatch(cleanup.id))&&(await rawItems(cleanup.id)).length===0&&errors.slice(errorCount).some(value=>value.includes('原件清理失败')&&value.includes(cleanupStored)));fs.rmdirSync(file);fs.unlinkSync(backup);
    // 501 distinct valid off-book fixtures; quantity limits apply to deduplicated item IDs.
    const registered=await api('POST','',{category:'other',name:'Added after batch',asset_no:'NEW',placement:{kind:'depot',status:'in_depot'}});check('R3事后补登记夹具',registered.status===201,JSON.stringify(registered));
    const oldDetail=await detail(b.id),unlinked=oldDetail.items.find(row=>row.external_key==='NEW');check('R3人工声明不动态关联新台账',unlinked.result==='ledger_added'&&unlinked.asset_id===null&&unlinked.current===null&&unlinked.ledger_snapshot===null);
    const bigIds=[];await mod._internals.withWrite(async q=>{for(let i=0;i<501;i++){const category=['other','software','subscription'][i%3];const r=await q.run('INSERT INTO it_assets(category,name,status,expires_at,created_by) VALUES(?,?,?,?,?)',[category,'R3 bulk '+i,category==='other'?'in_depot':'active',category==='other'?null:'2027-01-01',1]);bigIds.push(r.lastID);}});
    const big=await batch([['BOUNDARY-BOOK','Boundary',1]]),bigD=await detail(big.id),targets=bigD.items.filter(row=>bigIds.includes(row.asset_id)),bigPath=`/reconciles/${big.id}/items/bulk-confirm-off-book`;check('R3大批量夹具501明细非空',targets.length===501);
    await reject('R3去重后501唯一超限','PUT',bigPath,{item_ids:targets.map(row=>row.id)});
    const repeated=await ok('R3重复501次先去重可过','PUT',bigPath,{item_ids:Array(501).fill(targets[0].id)},2);check('R3去重实际仅一更新',repeated.items.length===1);
    const fiveHundred=await ok('R3实际500唯一确认','PUT',bigPath,{item_ids:targets.slice(1).map(row=>row.id)},2);check('R3五百行共享核对人时间且不限类别',fiveHundred.items.length===500&&new Set(fiveHundred.items.map(row=>row.checked_at)).size===1&&fiveHundred.items.every(row=>row.checked_by===2&&row.result==='confirmed_off_book')&&new Set(fiveHundred.items.map(row=>row.current.category)).size===3);
    const finalOriginals=await rawItems(b.id);check('R3最初旧快照逐字段保留',finalOriginals.length===originals.length&&originals.every(old=>{const item=finalOriginals.find(row=>row.id===old.id);return item&&['asset_id','external_key','external_row','external_amount','ledger_snapshot','ambiguous_candidates'].every(key=>item[key]===old[key]);}));
  }finally{
    if(server)await withTimeout(new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())),5000,'R3 server close');
    if(mod)await withTimeout(mod.shutdown(),10000,'R3 shutdown');
    if(fs.existsSync(store)){for(const file of fs.readdirSync(store)){const p=path.join(store,file);if(fs.statSync(p).isDirectory())fs.rmdirSync(p);else fs.unlinkSync(p);}fs.rmdirSync(store);}
    for(const file of fs.readdirSync(root))fs.unlinkSync(path.join(root,file));fs.rmdirSync(root);
  }
};
