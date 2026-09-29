'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fetchTestHttp = require('./lib/test-http-fetch');
const fs = require('fs'); const path = require('path'); const os = require('os');
const express = require('express'); const assert = require('assert/strict');

module.exports = async function verifyC6(t) {
  const { check, rawAllAt, rawGetAt, rawRunAt, withTimeout, seedUsers, fakeAuthenticateToken, fakeRequireAdmin, logger, observedCodes, assertEventSetFrom } = t;
  const sourceDir = path.resolve(__dirname, '../routes/it-ledger');
  const admin = { uid: 1, role: 'admin' }; let seq = 0;
  const unique = prefix => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
  const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (_) { return false; } };
  const keys = ['status','rack_id','u_start','parent_asset_id','slot_no','custodian_name','location_text','floor_id','room_id','pos','version'].sort();
  async function world(label, mutate, scenario) {
    const parent = path.join(__dirname, '.mutant-scratch'); fs.mkdirSync(parent, { recursive: true });
    const folder = fs.mkdtempSync(path.join(parent, 'c6-')); const entry = path.join(folder, 'index.js'); const stockFile = path.join(folder, 'stocktakes.js');
    const db = path.join(os.tmpdir(), unique('c6-db') + '.db'); let mod; let server;
    try {
      const originals = { index: fs.readFileSync(path.join(sourceDir, 'index.js'), 'utf8'), stock: fs.readFileSync(path.join(sourceDir, 'stocktakes.js'), 'utf8') };
      const sources = mutate ? mutate(originals) : originals;
      let index = sources.index;
      for (const [name, file] of [['invariants', path.join(sourceDir,'invariants.js')], ['single-asset-actions',path.join(sourceDir,'single-asset-actions.js')], ['stocktakes',stockFile], ['reconciles',path.join(sourceDir,'reconciles.js')],['inspections',path.join(sourceDir,'inspections.js')],['inspection-collector',path.join(sourceDir,'inspection-collector.js')],['inspection-collect',path.join(sourceDir,'inspection-collect.js')],['record-management',path.join(sourceDir,'record-management.js')],['inspection-sheets',path.join(sourceDir,'inspection-sheets.js')],['inspection-photo-files',path.join(sourceDir,'inspection-photo-files.js')]]) {
        const needle = `require('./${name}')`; assert.equal(index.split(needle).length, 2, 'C6 dependency exact occurrence'); index = index.replace(needle, `require(${JSON.stringify(file)})`);
      }
      assert.equal((index.match(/require\((['"])\.\.?\//g) || []).length, 0);
      fs.writeFileSync(entry, index, 'utf8'); fs.writeFileSync(stockFile, sources.stock, 'utf8');
      await seedUsers(db);
      mod = require(entry)({ logger, DB_FILE: db, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin, enableTestHooks: true });
      await withTimeout(mod.initSchema(), 15000, label + ' init');
      const app=express(); app.use(express.json()); app.use('/api',mod.router); server=await listenOnSafePort(app, null);
      const base=`http://localhost:${server.address().port}`;
      const api=async(method,url,body,user=admin)=>{
        const response=await withTimeout(fetchTestHttp(base+url,{method,headers:{'Content-Type':'application/json','x-test-user-id':String(user.uid),'x-test-user-role':user.role},body:body===undefined?undefined:JSON.stringify(body)}),5000,label+' request');
        const result={status:response.status,body:await response.json()};if(result.body&&result.body.code)observedCodes.add(result.body.code);return result;
      };
      await scenario({db,mod,api});
    } finally {
      if(server)try{await withTimeout(new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())),5000,'C6 server close');}catch(e){check(label+' cleanup server',false,e.message);}
      if(mod)try{await withTimeout(mod.shutdown(),10000,'C6 shutdown');}catch(e){check(label+' cleanup module',false,e.message);}
      for(const file of [entry,stockFile,db]){delete require.cache[file];try{if(fs.existsSync(file))fs.unlinkSync(file);}catch(e){check(label+' cleanup file',false,e.message);}}
      try{fs.rmdirSync(folder);}catch(e){check(label+' cleanup folder',false,e.message);}
    }
  }
  async function snapshot(db) {
    const result={};for(const table of ['it_assets','it_asset_events','it_stocktakes','it_stocktake_items'])result[table]=await rawAllAt(db,`SELECT * FROM ${table} ORDER BY id`);return result;
  }
  async function reject(w,label,method,url,body,status,code,user=admin) {
    const before=await snapshot(w.db);const r=await w.api(method,url,body,user);
    check(label+':精确状态/码',r.status===status&&r.body.code===code,JSON.stringify(r));
    check(label+':四表完整行无副作用',same(before,await snapshot(w.db)));return r;
  }
  async function success(w,label,method,url,body,status=200,user=admin,noAssets=true) {
    const before=await snapshot(w.db);const r=await w.api(method,url,body,user);
    check(label+':HTTP成功',r.status===status,JSON.stringify(r));if(r.status!==status)throw Error(label);
    if(noAssets){const after=await snapshot(w.db);check(label+':台账资产及事件两表全等',same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));}
    return r.body;
  }
  async function asset(w,category='laptop',placement={kind:'depot',status:'in_depot'},extra={}) {
    const body={category,name:unique('S-asset'),fin_amount:81,fin_vendor:'S-vendor',...extra};if(placement)body.placement=placement;
    return success(w,'S夹具登记','POST','/api/it-assets',body,201,admin,false);
  }
  async function batch(w,scope={}) {return success(w,'S发起盘点','POST','/api/it-assets/stocktakes',{title:unique('S-batch'),scope},201);}
  async function detail(w,id,user=admin){return success(w,'S读详情','GET',`/api/it-assets/stocktakes/${id}`,undefined,200,user);}
  async function resolution(w,id,result='missing',close=true) {
    const b=await batch(w);const d=await detail(w,b.id);const item=d.items.find(x=>x.asset_id===id);check('S差异夹具:明细非空',!!item);if(!item)throw Error('missing item');
    await success(w,'S标记差异','PUT',`/api/it-assets/stocktakes/${b.id}/items/${item.id}`,{result,...(result==='mismatch'?{actual:{location_text:'observed'}}:{})});
    if(close)await success(w,'S关闭差异批','POST',`/api/it-assets/stocktakes/${b.id}/close`,{force:true});
    return {batch:b.id,item:item.id};
  }
  await world('C6主守卫',null,async w=>{
    await success(w,'S授权write','PUT','/api/it-assets/acl/2',{level:'write'},200,admin,false);
    await success(w,'S授权read','PUT','/api/it-assets/acl/3',{level:'read'},200,admin,false);
    const laptop=await asset(w);const other=await asset(w,'other',{kind:'depot',status:'faulty'});
    const rack=await success(w,'S机柜','POST','/api/it-assets/racks',{name:unique('rack'),u_total:10},201,admin,false);
    const host=await asset(w,'server',{kind:'rack',rack_id:rack.id,u_start:1},{u_height:1,slot_count:4});
    const disk=await asset(w,'disk',{kind:'host',parent_asset_id:host.id,slot_no:1},{peer_versions:{[host.id]:1}});
    const floorId=unique('S-floor');await success(w,'S楼层','PUT',`/api/it-assets/floors/${floorId}`,{name:floorId,rooms:[{id:'r',name:'r',w:1,h:1}]},200,admin,false);
    const ap=await asset(w,'ap',{kind:'room',floor_id:floorId,room_id:'r',pos:{x:0.2,y:0.3}});
    const software=await asset(w,'software',null,{expires_at:'2027-01-01'});
    // S1/S2：协议、范围及快照原值。
    for(const body of [{},{title:''},{title:3},{title:'x',scope:null},{title:'x',scope:[]},{title:'x',scope:{bad:1}},{title:'x',scope:{categories:['bad']}},{title:'x',scope:{rack_ids:[99999]}},{title:'x',scope:{depot_only:'true'}},{title:'x',resolved_op_id:'fake'}])await reject(w,'S1非法创建','POST','/api/it-assets/stocktakes',body,400,'LEDGER_BAD_REQUEST');
    for(const uid of [3,99])await reject(w,'S1无写权','POST','/api/it-assets/stocktakes',{title:'x'},403,'LEDGER_FORBIDDEN',{uid,role:'user'});
    await reject(w,'S1财务键','POST','/api/it-assets/stocktakes',{title:'x',fin_amount:1},400,'FINANCE_FIELD_FORBIDDEN',{uid:2,role:'user'});
    const scopes=[ [{},[laptop.id,other.id,host.id,disk.id,ap.id,software.id]], [{categories:['laptop']},[laptop.id]], [{rack_ids:[rack.id]},[host.id,disk.id]], [{rack_ids:[rack.id],categories:['disk']},[disk.id]], [{depot_only:true},[laptop.id,other.id]], [{categories:[]},[]] ];
    for(const [scope,expectedIds]of scopes){
      const b=await batch(w,scope);const d=await detail(w,b.id);
      check('S2范围id集合全等',same(d.items.map(x=>x.asset_id).sort((a,b)=>a-b),expectedIds.sort((a,b)=>a-b)));
      for(const it of d.items){const raw=await rawGetAt(w.db,'SELECT * FROM it_assets WHERE id=?',[it.asset_id]);const parsed=w.mod._internals.parseAssetRow(raw);check('S2快照11键全等',same(Object.keys(it.expected).sort(),keys));check('S2快照逐值全等',same(it.expected,Object.fromEntries(keys.map(k=>[k,parsed[k]]))));check('S2初态pending/checked空',it.result==='pending'&&it.checked_by===null&&it.checked_at===null&&it.resolved_op_id===null);}
    }
    const b=await batch(w,{categories:['laptop','ap']});let d=await detail(w,b.id);const li=d.items.find(i=>i.asset_id===laptop.id);const ai=d.items.find(i=>i.asset_id===ap.id);
    const rawExpected=li.expected;await asset(w);check('S2发起后新资产不入范围',(await detail(w,b.id)).items.length===2);
    await success(w,'S3仅备注改变version','PUT',`/api/it-assets/${laptop.id}`,{expected_version:1,note:'changed'},200,admin,false);
    d=await detail(w,b.id);check('S3版本变化但业务快照不变',d.items.find(i=>i.id===li.id).version_changed&&same(d.items.find(i=>i.id===li.id).changed_fields,[])&&same(d.items.find(i=>i.id===li.id).expected,rawExpected));
    await success(w,'S3同房间移AP','POST',`/api/it-assets/${ap.id}/actions/ap_relocate`,{expected_version:1,floor_id:floorId,room_id:'r',pos:{x:0.7,y:0.8}},200,admin,false);
    d=await detail(w,b.id);check('S3位置变化仅pos高亮',same(d.items.find(i=>i.id===ai.id).changed_fields,['pos'])&&same(d.items.find(i=>i.id===ai.id).expected.pos,{x:0.2,y:0.3}));
    const nonadmin=await detail(w,b.id,{uid:3,role:'user'});check('S1财务剔除且明细非空',nonadmin.items.length===2&&nonadmin.items.every(i=>!Object.hasOwn(i.current,'fin_amount')&&!Object.hasOwn(i.current,'fin_vendor')));check('S1admin财务对照',d.items.every(i=>i.current.fin_amount===81));
    for(const body of [{result:'bad'},{result:'mismatch'},{result:'mismatch',actual:[]},{result:'found',actual:{unknown:1}},{result:'found',actual:{pos:{x:2,y:0}}},{result:'found',actual:{version:0}},{result:'found',checked_by:1},{result:'found',resolved_op_id:'x'},{result:'found',expected:{}}])await reject(w,'S3非法核对','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}`,body,400,'LEDGER_BAD_REQUEST');
    const mismatch=await success(w,'S3自检允许空actual对象','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}`,{result:'mismatch',actual:{}},200,{uid:2,role:'user'});check('S3非pending已记录核对人时间',mismatch.checked_by===2&&typeof mismatch.checked_at==='string'&&same(mismatch.actual,{}));
    const pending=await success(w,'S3重置pending','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}`,{result:'pending'});check('S3pending清核对字段和actual',pending.checked_by===null&&pending.checked_at===null&&pending.actual===null);
    await reject(w,'S4仍pending不能关闭','POST',`/api/it-assets/stocktakes/${b.id}/close`,{},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    await reject(w,'S4write不能关闭','POST',`/api/it-assets/stocktakes/${b.id}/close`,{force:true},403,'LEDGER_FORBIDDEN',{uid:2,role:'user'});
    await reject(w,'S4坏force','POST',`/api/it-assets/stocktakes/${b.id}/close`,{force:'true'},400,'LEDGER_BAD_REQUEST');
    const closed=await success(w,'S4force关闭','POST',`/api/it-assets/stocktakes/${b.id}/close`,{force:true});check('S4冻结四计数及关闭人时间',same(closed.summary,{pending:2,found:0,missing:0,mismatch:0})&&closed.closed_by===1&&typeof closed.closed_at==='string');
    await reject(w,'S4重复关闭','POST',`/api/it-assets/stocktakes/${b.id}/close`,{},409,'NO_OP_TRANSITION');
    await reject(w,'S4关闭后核对冻结','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}`,{result:'found'},400,'LEDGER_BAD_REQUEST');
    const beforeBatch=await rawGetAt(w.db,'SELECT * FROM it_stocktakes WHERE id=?',[b.id]);const beforeItem=await rawGetAt(w.db,'SELECT * FROM it_stocktake_items WHERE id=?',[li.id]);
    await success(w,'S4关闭后明细备注','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}/note`,{note:'item note'});
    await success(w,'S4关闭后批次备注','PUT',`/api/it-assets/stocktakes/${b.id}/note`,{note:'batch note'});
    check('S4备注只改note完整行',same(await rawGetAt(w.db,'SELECT * FROM it_stocktakes WHERE id=?',[b.id]),{...beforeBatch,note:'batch note'})&&same(await rawGetAt(w.db,'SELECT * FROM it_stocktake_items WHERE id=?',[li.id]),{...beforeItem,note:'item note'}));
    await reject(w,'S4备注禁止resolved','PUT',`/api/it-assets/stocktakes/${b.id}/items/${li.id}/note`,{note:'x',resolved_op_id:'x'},400,'LEDGER_BAD_REQUEST');
    await reject(w,'S1不存在批次','GET','/api/it-assets/stocktakes/99999',undefined,404,'LEDGER_NOT_FOUND');
    await reject(w,'S1坏批次id','GET','/api/it-assets/stocktakes/x',undefined,400,'LEDGER_INVALID_ID');
    const empty=await batch(w,{categories:[]});const emptyClosed=await success(w,'S4空范围可正常关闭','POST',`/api/it-assets/stocktakes/${empty.id}/close`,{});check('S4空批次四计数0',same(emptyClosed.summary,{pending:0,found:0,missing:0,mismatch:0}));
    // S5绑定拒绝：每次都对四张完整表核回滚。
    const subject=await asset(w);const valid=await resolution(w,subject.id);
    const open=await resolution(w,subject.id,'missing',false);const found=await resolution(w,subject.id,'found');const foreign=await resolution(w,other.id);
    for(const [sid,status,code]of [[99999,400,'LEDGER_BAD_REQUEST'],[open.item,409,'ACTION_NOT_ALLOWED_IN_STATUS'],[found.item,409,'ACTION_NOT_ALLOWED_IN_STATUS'],[foreign.item,409,'ACTION_NOT_ALLOWED_IN_STATUS']])await reject(w,'S5非法绑定','POST',`/api/it-assets/${subject.id}/actions/mark_status`,{expected_version:1,status:'faulty',stocktake_item_id:sid},status,code);
    await reject(w,'S5零变化PUT不可绑定','PUT',`/api/it-assets/${subject.id}`,{expected_version:1,name:subject.name,stocktake_item_id:valid.item},409,'NO_OP_TRANSITION');
    const itemBefore=await rawGetAt(w.db,'SELECT * FROM it_stocktake_items WHERE id=?',[valid.item]);
    const edit=await success(w,'S5实际PUT绑定','PUT',`/api/it-assets/${subject.id}`,{expected_version:1,name:'renamed',stocktake_item_id:valid.item},200,admin,false);
    const updated=await rawGetAt(w.db,'SELECT * FROM it_stocktake_items WHERE id=?',[valid.item]);check('S5绑定只改resolved完整行',same(updated,{...itemBefore,resolved_op_id:updated.resolved_op_id})&&typeof updated.resolved_op_id==='string');
    await assertEventSetFrom(w.db,'S5PUT事件',updated.resolved_op_id,{action:'update',operator_id:1,primary:{assetId:subject.id,from:{name:subject.name},to:{name:'renamed'}},affected:[]});check('S5PUT版本+1',edit.version===2);
    await reject(w,'S5禁止重绑','POST',`/api/it-assets/${subject.id}/actions/mark_status`,{expected_version:2,status:'faulty',stocktake_item_id:valid.item},409,'NO_OP_TRANSITION');
    const fault=await resolution(w,subject.id);
    await rawRunAt(w.db,`CREATE TRIGGER fail_binding BEFORE UPDATE OF resolved_op_id ON it_stocktake_items WHEN NEW.id=${fault.item} BEGIN SELECT RAISE(ABORT,'binding failed'); END`);
    try{await reject(w,'S6绑定SQL失败整笔回滚','POST',`/api/it-assets/${subject.id}/actions/mark_status`,{expected_version:2,status:'faulty',stocktake_item_id:fault.item},500,'LEDGER_INTERNAL');}finally{await rawRunAt(w.db,'DROP TRIGGER fail_binding');}
    // S5动作族：逐个真实primary事件绑定，不仅证明通用路由存在。
    const row=await rawGetAt(w.db,'SELECT * FROM it_assets WHERE id=?',[subject.id]);
    const bound=await success(w,'S5动作绑定','POST',`/api/it-assets/${subject.id}/actions/mark_status`,{expected_version:row.version,status:'faulty',stocktake_item_id:fault.item},200,admin,false);
    check('S5动作op_id绑定', (await rawGetAt(w.db,'SELECT resolved_op_id FROM it_stocktake_items WHERE id=?',[fault.item])).resolved_op_id===bound.op_id);
    {
      const p=await asset(w);const r=await resolution(w,p.id);
      await rawRunAt(w.db,`CREATE TRIGGER extra_primary AFTER INSERT ON it_asset_events WHEN NEW.action='mark_status' AND NEW.role='primary' AND NEW.asset_id=${p.id} BEGIN INSERT INTO it_asset_events(op_id,asset_id,action,role,related_asset_id,from_state,to_state,operator_id) VALUES(NEW.op_id,${other.id},NEW.action,'primary',NULL,NEW.from_state,NEW.to_state,NEW.operator_id); END`);
      try{await reject(w,'S5同op多primary禁止绑定','POST',`/api/it-assets/${p.id}/actions/mark_status`,{expected_version:1,status:'faulty',stocktake_item_id:r.item},409,'NO_OP_TRANSITION');}finally{await rawRunAt(w.db,'DROP TRIGGER extra_primary');}
    }
    {
      const p=await asset(w);const r=await resolution(w,p.id);
      await success(w,'S5快照后基础资料变化','PUT',`/api/it-assets/${p.id}`,{expected_version:1,note:'after snapshot'},200,admin,false);
      await reject(w,'S5不能用快照旧版本处置','POST',`/api/it-assets/${p.id}/actions/mark_status`,{expected_version:1,status:'faulty',stocktake_item_id:r.item},409,'VERSION_CONFLICT');
      const response=await success(w,'S5使用当前版本处置','POST',`/api/it-assets/${p.id}/actions/mark_status`,{expected_version:2,status:'faulty',stocktake_item_id:r.item},200,admin,false);
      const item=await rawGetAt(w.db,'SELECT * FROM it_stocktake_items WHERE id=?',[r.item]);check('S5当前版本绑定且expected版本保持1',JSON.parse(item.expected).version===1&&item.resolved_op_id===response.op_id);
    }
    {
      const p=await asset(w,'disk');const r=await resolution(w,host.id);const current=await rawGetAt(w.db,'SELECT version FROM it_assets WHERE id=?',[host.id]);
      await reject(w,'S5不能把affected宿主当primary绑定','POST',`/api/it-assets/${p.id}/actions/disk_mount`,{expected_version:1,parent_asset_id:host.id,slot_no:2,peer_versions:{[host.id]:current.version},stocktake_item_id:r.item},409,'ACTION_NOT_ALLOWED_IN_STATUS');
    }
    async function hostFixture(inService=true) {
      const r=await success(w,'S5隔离柜','POST','/api/it-assets/racks',{name:unique('binding-rack'),u_total:10},201,admin,false);
      const h=await asset(w,'server',inService?{kind:'rack',rack_id:r.id,u_start:1}:{kind:'depot',status:'in_depot'},{u_height:1,slot_count:4});return {host:h,rack:r};
    }
    for(const action of ['rack_in','rack_out','rack_move','rack_relocate','mark_status','retire','disk_mount','disk_unmount','disk_swap','disk_move','assign','reassign','return','place','relocate','ap_place','ap_relocate','renew','cancel']) {
      let primary;let params={};
      if(action.startsWith('rack_')) {
        const h=await hostFixture(action!=='rack_in');primary=h.host;
        if(action==='rack_in')params={rack_id:h.rack.id,u_start:1};
        if(action==='rack_relocate')params={u_start:3};
        if(action==='rack_move'){const target=await hostFixture();params={rack_id:target.rack.id,u_start:3};}
      } else if(action.startsWith('disk_')) {
        const source=await hostFixture();
        if(action==='disk_mount') {primary=await asset(w,'disk');params={parent_asset_id:source.host.id,slot_no:1,peer_versions:{[source.host.id]:1}};}
        else {
          primary=await asset(w,'disk',{kind:'host',parent_asset_id:source.host.id,slot_no:1},{peer_versions:{[source.host.id]:1}});
          params={peer_versions:{[source.host.id]:2}};
          if(action==='disk_unmount')params.to='faulty';
          if(action==='disk_swap'){const replacement=await asset(w,'disk');params={to:'faulty',new_disk_id:replacement.id,peer_versions:{[source.host.id]:2,[replacement.id]:1}};}
          if(action==='disk_move'){const target=await hostFixture();params={parent_asset_id:target.host.id,slot_no:2,peer_versions:{[source.host.id]:2,[target.host.id]:1}};}
        }
      } else if(action==='mark_status'){primary=await asset(w);params={status:'faulty'};}
      else if(action==='retire')primary=await asset(w,'laptop',{kind:'depot',status:'to_retire'});
      else if(action==='assign'){primary=await asset(w);params={custodian_name:'Assigned'};}
      else if(['reassign','return','relocate'].includes(action)){primary=await asset(w,'laptop',{kind:'custodian',custodian_name:'Old',location_text:'Old'});params=action==='reassign'?{custodian_name:'New'}:action==='relocate'?{location_text:'New'}:{to:'faulty'};}
      else if(action==='place'){primary=await asset(w,'other');params={location_text:'New'};}
      else if(action.startsWith('ap_')){primary=await asset(w,'ap',action==='ap_place'?{kind:'depot',status:'in_depot'}:{kind:'room',floor_id:floorId,room_id:'r',pos:{x:0.2,y:0.3}});params={floor_id:floorId,room_id:'r',pos:{x:0.6,y:0.7}};}
      else {primary=await asset(w,'software',null,{expires_at:'2027-01-01'});if(action==='renew')params={expires_at:'2028-01-01'};}
      const r=await resolution(w,primary.id,seq%2?'missing':'mismatch');
      const prior=await rawAllAt(w.db,'SELECT * FROM it_stocktake_items ORDER BY id');
      const response=await success(w,`S5-${action}绑定`,'POST',`/api/it-assets/${primary.id}/actions/${action}`,{...params,expected_version:1,stocktake_item_id:r.item},200,admin,false);
      check(`S5-${action}:所有明细只有目标resolved改变`,same(await rawAllAt(w.db,'SELECT * FROM it_stocktake_items ORDER BY id'),prior.map(it=>it.id===r.item?{...it,resolved_op_id:response.op_id}:it)));
      const events=await rawAllAt(w.db,'SELECT * FROM it_asset_events WHERE op_id=? ORDER BY id',[response.op_id]);
      const primaries=events.filter(e=>e.role==='primary');
      check(`S5-${action}:绑定primary资产/action正确`,primaries.length===1&&primaries[0].asset_id===primary.id&&primaries[0].action===action&&primaries[0].related_asset_id===null);
      check(`S5-${action}:资产version确实递增`,(await rawGetAt(w.db,'SELECT version FROM it_assets WHERE id=?',[primary.id])).version===2);
    }
    // S6：勾选/关闭、同一差异两请求及锁内撤权，信号固定顺序。
    async function ordered(label,first,second) {
      let release;const gate=new Promise(r=>{release=r;});const arrived=w.mod._internals.setTxnMidGate(gate);let a;let b;
      try{a=first();await t.awaitArrived(arrived,label,a);b=second();await t.waitForCondition(()=>w.mod._internals.itTxnMutex._internals.waiterCount()>=1,label+' queue');check(label+':次请求已排队',w.mod._internals.itTxnMutex._internals.waiterCount()>=1);w.mod._internals.setTxnMidGate(null);release();return await Promise.all([a,b]);}
      finally{w.mod._internals.setTxnMidGate(null);release();await Promise.allSettled([a,b].filter(Boolean));}
    }
    for(const closeFirst of [false,true]) {
      const p=await asset(w,'desktop');const b=await batch(w,{categories:['desktop']});let d=await detail(w,b.id);
      // 已有desktop也明确勾选，确保非force关闭条件可满足。
      for(const it of d.items.filter(i=>i.asset_id!==p.id))await success(w,'S6预勾选','PUT',`/api/it-assets/stocktakes/${b.id}/items/${it.id}`,{result:'found'});
      d=await detail(w,b.id);const it=d.items.find(i=>i.asset_id===p.id);const before=await snapshot(w.db);
      const mark=()=>w.api('PUT',`/api/it-assets/stocktakes/${b.id}/items/${it.id}`,{result:'found'});
      const close=()=>w.api('POST',`/api/it-assets/stocktakes/${b.id}/close`,closeFirst?{force:true}:{});
      const [a,z]=await ordered('S6关闭与勾选',closeFirst?close:mark,closeFirst?mark:close);
      check('S6首请求200',a.status===200,JSON.stringify(a));
      check('S6后请求按顺序正确',closeFirst?z.status===400&&z.body.code==='LEDGER_BAD_REQUEST':z.status===200,JSON.stringify(z));
      const after=await snapshot(w.db);check('S6盘点并发不写资产两表',same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));
      if(closeFirst)check('S6关闭先行则全部明细完整行不变',same(before.it_stocktake_items,after.it_stocktake_items));
      else check('S6勾选先行则关闭summary无pending',JSON.parse(after.it_stocktakes.find(x=>x.id===b.id).summary).pending===0);
    }
    {
      const p=await asset(w);const r=await resolution(w,p.id);const before=await snapshot(w.db);
      const call=()=>w.api('POST',`/api/it-assets/${p.id}/actions/mark_status`,{expected_version:1,status:'faulty',stocktake_item_id:r.item});
      const [a,z]=await ordered('S6同差异并发绑定',call,call);
      check('S6同差异恰一成功一版本冲突',a.status===200&&z.status===409&&z.body.code==='VERSION_CONFLICT',JSON.stringify({a,z}));
      const after=await snapshot(w.db);const expected=before.it_stocktake_items.map(i=>i.id===r.item?{...i,resolved_op_id:a.body.op_id}:i);
      check('S6绑定只生效一次且旧事件不变',same(after.it_stocktake_items,expected)&&after.it_asset_events.length===before.it_asset_events.length+1&&same(after.it_asset_events.slice(0,-1),before.it_asset_events));
    }
    {
      const before=await snapshot(w.db);
      const [,r]=await ordered('S6排队撤权',()=>w.mod._internals.withWrite(q=>q.run('DELETE FROM it_asset_acl WHERE user_id=2')),()=>w.api('POST','/api/it-assets/stocktakes',{title:'denied'},{uid:2,role:'user'}));
      check('S6锁内重新检查权限403',r.status===403&&r.body.code==='LEDGER_FORBIDDEN',JSON.stringify(r));check('S6撤权拒绝四表全等',same(before,await snapshot(w.db)));
    }
  });
  // S7：用同一业务断言做双向反证，变异体只在独立目录/临时库运行。
  function replaceOnce(src,needle,replacement){assert.equal(src.split(needle).length,2,'C6 mutation must match once');return src.replace(needle,replacement);}
  function frozen(before,after){assert.deepStrictEqual(after,before,'C6_CLOSED_FROZEN');}
  function linked(actual,expected){assert.equal(actual,expected,'C6_RESOLUTION_LINK');}
  for(const kind of ['open','bind','edit'])for(const mutated of [false,true]) {
    const transform=!mutated?null:src=>{
      if(kind==='open'){const line=src.stock.split(/\r?\n/).find(l=>l.includes('// C6_OPEN_GATE'));assert(line);return {...src,stock:replaceOnce(src.stock,line,'    // removed C6 open gate')};}
      if(kind==='bind')return {...src,index:replaceOnce(src.index,'await stocktakes.bind(q, id, body.stocktake_item_id, opId); return value;','return value;')};
      return {...src,index:replaceOnce(src.index,'        await stocktakes.validateWrittenAsset(q, id);','        // removed C6 edit reread check')};
    };
    await world(`S7-${kind}-${mutated}`,transform,async w=>{
      const p=await asset(w);let target;
      if(kind!=='edit')target=await resolution(w,p.id);
      const before=await snapshot(w.db);
      if(kind==='edit')await rawRunAt(w.db,`CREATE TRIGGER dirty_edit AFTER UPDATE OF name ON it_assets WHEN NEW.id=${p.id} BEGIN UPDATE it_assets SET custodian_name='dirty' WHERE id=${p.id}; END`);
      const method=kind==='bind'?'POST':'PUT';
      const url=kind==='open'?`/api/it-assets/stocktakes/${target.batch}/items/${target.item}`:kind==='bind'?`/api/it-assets/${p.id}/actions/mark_status`:`/api/it-assets/${p.id}`;
      const body=kind==='open'?{result:'found'}:kind==='bind'?{expected_version:1,status:'faulty',stocktake_item_id:target.item}:{expected_version:1,name:'edited'};
      const r=await w.api(method,url,body);
      if(!mutated&&kind!=='bind') {
        check(`S7-${kind}:干净世界精确拒绝`,r.status===(kind==='open'?400:409)&&r.body.code===(kind==='open'?'LEDGER_BAD_REQUEST':'CUSTODIAN_REQUIRED'),JSON.stringify(r));
        check(`S7-${kind}:干净拒绝四表全等`,same(before,await snapshot(w.db)));return;
      }
      check(`S7-${kind}-${mutated}:200`,r.status===200,JSON.stringify(r));if(r.status!==200)throw Error('C6 mutation unexpected error');
      const after=await snapshot(w.db);
      if(kind==='open') {
        let failure;try{frozen(before.it_stocktake_items,after.it_stocktake_items);}catch(e){failure=e;}
        check('S7-open:冻结断言命中且无他错',failure&&failure.code==='ERR_ASSERTION'&&failure.message.includes('C6_CLOSED_FROZEN'));
        check('S7-open:核对确已落库且资产事件不变',after.it_stocktake_items.find(i=>i.id===target.item).result==='found'&&same(before.it_assets,after.it_assets)&&same(before.it_asset_events,after.it_asset_events));
      } else if(kind==='bind') {
        const item=after.it_stocktake_items.find(i=>i.id===target.item);
        if(!mutated){linked(item.resolved_op_id,r.body.op_id);check('S7-bind:干净世界绑定断言通过',true);}
        else {let failure;try{linked(item.resolved_op_id,r.body.op_id);}catch(e){failure=e;}check('S7-bind:漏绑定使目标断言变红且无他错',failure&&failure.code==='ERR_ASSERTION'&&failure.actual===null&&failure.message.includes('C6_RESOLUTION_LINK'));}
        await assertEventSetFrom(w.db,'S7-bind事件',r.body.op_id,{action:'mark_status',operator_id:1,primary:{assetId:p.id,from:{status:'in_depot'},to:{status:'faulty'}},affected:[]});
        const stored=after.it_assets.find(a=>a.id===p.id);check('S7-bind:资产真实状态/版本',stored.status==='faulty'&&stored.version===2);
      } else {
        const row=after.it_assets.find(a=>a.id===p.id);check('S7-edit:脏字段及编辑确已错误落库',row.name==='edited'&&row.custodian_name==='dirty'&&row.version===2);
        const primary=after.it_asset_events.find(e=>e.asset_id===p.id&&e.action==='update');check('S7-edit:update事件非空',!!primary);
        await assertEventSetFrom(w.db,'S7-edit事件',primary.op_id,{action:'update',operator_id:1,primary:{assetId:p.id,from:{name:p.name},to:{name:'edited'}},affected:[]});
      }
    });
  }
};
