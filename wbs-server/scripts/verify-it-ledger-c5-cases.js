'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fetchTestHttp = require('./lib/test-http-fetch');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const express = require('express');

// 只依赖 C3 verify 的公共入口，不调用任何 C4 d* 助手。
module.exports = async function verifyC5(t) {
  const { api, check, itLedgerModule: mod, TEST_DB, rawAll, rawGet, rawRun, rawAllAt, rawGetAt, rawRunAt,
    assertNoSideEffect, assertEventSet, assertEventSetFrom, snapshotAssets, withTimeout, awaitArrived,
    waitForCondition, seedUsers, fakeAuthenticateToken, fakeRequireAdmin, logger } = t;
  let seq = 0;
  const unique = prefix => `${prefix}-${process.pid}-${Date.now()}-${++seq}`;
  const admin = { uid: 1, role: 'admin' };
  const same = (a,b) => { try { assert.deepStrictEqual(a,b); return true; } catch (_) { return false; } };
  const actions = ['assign','reassign','return','place','relocate','ap_place','ap_relocate','renew','cancel'];
  const KEYS = {
    assign:['custodian_name','custodian_user_id','location_text','status'], reassign:['custodian_name','custodian_user_id'],
    return:['custodian_name','custodian_user_id','floor_id','location_text','pos','room_id','status'],
    place:['location_text','status'], relocate:['location_text'], ap_place:['floor_id','pos','room_id','status'],
    ap_relocate:['floor_id','pos','room_id'], renew:['expires_at'], cancel:['status'],
  };
  const PARAMETERS = {
    assign:['custodian_name','custodian_user_id','location_text'],reassign:['custodian_name','custodian_user_id'],return:['to'],
    place:['location_text'],relocate:['location_text'],ap_place:['floor_id','pos','room_id'],ap_relocate:['floor_id','pos','room_id'],renew:['expires_at'],cancel:[],
  };
  const read = async id => {
    const row = await rawGet('SELECT * FROM it_assets WHERE id=?',[id]);
    check(`T夹具:资产${id}非空`,!!row);if(!row)throw Error('C5 fixture missing');return row;
  };
  const call = (id,action,body,user=admin) => api('POST',`/api/it-assets/${id}/actions/${action}`,{...user,body});
  async function floor() {
    const id=unique('C5F');
    const r=await api('PUT',`/api/it-assets/floors/${id}`,{...admin,body:{name:id,rooms:[{id:'r',name:'房间',w:1,h:1}]}});
    check('T夹具:楼层200',r.status===200,JSON.stringify(r));if(r.status!==200)throw Error('C5 floor failed');return id;
  }
  const floorA=await floor();const floorB=await floor();
  const rackResult=await api('POST','/api/it-assets/racks',{...admin,body:{name:unique('C5R'),u_total:1000}});
  check('T夹具:机柜201',rackResult.status===201,JSON.stringify(rackResult));if(rackResult.status!==201)throw Error('C5 rack failed');
  let uStart=1;
  async function asset(kind,status,overrides={}) {
    const category=kind==='otherRack'?'other':kind;
    const body={category,name:unique('C5'),fin_amount:88,fin_vendor:'C5-vendor',...overrides};
    if(kind==='server'||kind==='otherRack')body.u_height=1;
    if(category==='software'||category==='subscription')body.expires_at='2026-10-01';
    else if(status!=='in_service')body.placement={kind:'depot',status:'in_depot'};
    else if(kind==='server'||kind==='otherRack')body.placement={kind:'rack',rack_id:rackResult.body.id,u_start:uStart++};
    else if(category==='ap')body.placement={kind:'room',floor_id:floorA,room_id:'r',pos:{x:0.2,y:0.3}};
    else if(category==='laptop'||category==='desktop')body.placement={kind:'custodian',custodian_name:'Old',location_text:'Old room'};
    else if(category==='other')body.placement={kind:'place',location_text:'Old room'};
    else body.placement={kind:'depot',status:'in_depot'};
    const r=await api('POST','/api/it-assets',{...admin,body});
    check('T夹具:登记201',r.status===201,JSON.stringify(r));if(r.status!==201)throw Error('C5 asset failed');
    if(r.body.status!==status)await rawRun('UPDATE it_assets SET status=? WHERE id=?',[status,r.body.id]);
    return r.body.id;
  }
  const INITIAL = {assign:['laptop','in_depot'],reassign:['laptop','in_service'],return:['laptop','in_service'],place:['other','in_depot'],relocate:['laptop','in_service'],ap_place:['ap','in_depot'],ap_relocate:['ap','in_service'],renew:['software','active'],cancel:['software','active']};
  const PARAMS = {assign:{custodian_name:'New',location_text:'New room'},reassign:{custodian_name:'New'},return:{to:'faulty'},place:{location_text:'New room'},relocate:{location_text:'New room'},ap_place:{floor_id:floorB,room_id:'r',pos:{x:0,y:1}},ap_relocate:{floor_id:floorB,room_id:'r',pos:{x:0,y:1}},renew:{expires_at:'2027-01-01'},cancel:{}};
  const TARGET = {assign:{status:'in_service',custodian_user_id:null,custodian_name:'New',location_text:'New room'},reassign:{custodian_user_id:null,custodian_name:'New'},return:{status:'faulty',custodian_user_id:null,custodian_name:null,location_text:null,floor_id:null,room_id:null,pos:null},place:{status:'in_service',location_text:'New room'},relocate:{location_text:'New room'},ap_place:{status:'in_service',floor_id:floorB,room_id:'r',pos:{x:0,y:1}},ap_relocate:{floor_id:floorB,room_id:'r',pos:{x:0,y:1}},renew:{expires_at:'2027-01-01'},cancel:{status:'cancelled'}};
  const project=(row,keys)=>Object.fromEntries(keys.map(k=>[k,k==='pos'&&typeof row[k]==='string'?JSON.parse(row[k]):row[k]]));
  function oneEvent(rows) { assert.equal(rows.length,1,'C5_EVENT_COUNT'); }
  async function reject(label,id,action,body,status,code,user=admin) {
    const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    const r=await assertNoSideEffect(label,[id],()=>call(id,action,body,user));
    check(`${label}:全事件表不变`,same(events,await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
    check(`${label}:${status}/${code}`,r.status===status&&r.body.code===code,JSON.stringify(r));return r;
  }
  async function success(label,id,action,body,target,user=admin) {
    const before=await read(id);const r=await call(id,action,body,user);
    check(`${label}:200`,r.status===200,JSON.stringify(r));if(r.status!==200)throw Error(label);
    const row=await read(id);const wanted={...before,...target,version:before.version+1,updated_at:row.updated_at};
    if(target.pos&&typeof target.pos==='object')wanted.pos=JSON.stringify(target.pos);
    check(`${label}:完整行及version+1`,same(row,wanted),JSON.stringify({row,wanted}));
    const rows=await rawAll('SELECT * FROM it_asset_events WHERE op_id=?',[r.body.op_id]);oneEvent(rows);
    await assertEventSet(label,r.body.op_id,{action,operator_id:user.uid,primary:{assetId:id,from:project(before,KEYS[action]),to:project({...before,...target},KEYS[action])},affected:[]});
    check(`${label}:affected_ids空且note正确`,same(r.body.affected_ids,[])&&rows[0].note===(body.note||null));
    if(user.role==='admin')check(`${label}:admin财务保留`,r.body.fin_amount===88);
    else for(const key of ['fin_amount','fin_vendor','fin_contract_no','external_amount'])check(`${label}:响应无${key}`,!Object.hasOwn(r.body,key));
    return r;
  }

  // T1/T6：手写字段集、协议、权限与九个正向动作。
  for(const action of actions) {
    check(`T6-${action}:primary键全等`,same([...mod._internals.PAYLOAD_KEYS[action].primary].sort(),KEYS[action]));
    check(`T6-${action}:affected为空`,mod._internals.PAYLOAD_KEYS[action].affected.size===0);
    check(`T1-${action}:参数表全等`,same([...mod._internals.ACTION_HANDLERS[action].paramKeys].sort(),PARAMETERS[action]));
    const id=await asset(...INITIAL[action]);const body={...PARAMS[action],expected_version:1};
    for(const [label,patch]of [['缺version',{expected_version:undefined}],['坏version',{expected_version:0}],['字符串version',{expected_version:'1'}],['非空peer',{peer_versions:{123:1}}],['nullpeer',{peer_versions:null}],['未知键',{unexpected:true}]])await reject(`T1-${action}-${label}`,id,action,{...body,...patch},400,'LEDGER_BAD_REQUEST');
    await reject(`T1-${action}-陈旧`,id,action,{...body,expected_version:2},409,'VERSION_CONFLICT');
    for(const uid of [3,999])await reject(`T1-${action}-权限${uid}`,id,action,body,403,'LEDGER_FORBIDDEN',{uid,role:'user'});
    for(const key of ['fin_amount','fin_vendor','fin_contract_no','external_amount'])await reject(`T1-${action}-财务${key}`,id,action,{...body,[key]:1},400,'FINANCE_FIELD_FORBIDDEN',{uid:2,role:'user'});
    await reject(`T1-${action}-不存在`,99999999,action,body,404,'LEDGER_NOT_FOUND');
    await success(`T6-${action}`,id,action,{...body,note:'C5'},TARGET[action]);
    const userId=await asset(...INITIAL[action]);await success(`T1-${action}-write`,userId,action,body,TARGET[action],{uid:2,role:'user'});
  }

  // T2：允许状态/类别为手写契约，不从生产动作表反推。
  const ALLOWED={assign:{laptop:['in_depot'],desktop:['in_depot']},reassign:{laptop:['in_service'],desktop:['in_service']},return:{laptop:['in_service'],desktop:['in_service'],ap:['in_service'],other:['in_service']},place:{other:['in_depot']},relocate:{laptop:['in_service'],desktop:['in_service'],other:['in_service']},ap_place:{ap:['in_depot']},ap_relocate:{ap:['in_service']},renew:{software:['active'],subscription:['active']},cancel:{software:['active'],subscription:['active']}};
  for(const action of actions)for(const kind of ['server','disk','laptop','desktop','ap','other','otherRack','software','subscription']) {
    const states=['software','subscription'].includes(kind)?['active','cancelled']:['in_service','in_depot','faulty','to_retire','retired'];
    for(const status of states) {
      const id=await asset(kind,status);const body={...PARAMS[action],expected_version:1};
      const allowed=ALLOWED[action][kind];const label=`T2-${action}-${kind}-${status}`;
      if(!allowed)await reject(label,id,action,body,400,'ACTION_NOT_APPLICABLE');
      else if(!allowed.includes(status))await reject(label,id,action,body,409,'ACTION_NOT_ALLOWED_IN_STATUS');
      else await success(label,id,action,body,TARGET[action]);
    }
  }

  // T3：保管人和文本边界。
  for(const action of ['assign','reassign']) {
    const id=await asset(...INITIAL[action]);
    for(const body of [{},{custodian_name:'   '},{custodian_name:null},{custodian_user_id:null}])await reject(`T3-${action}-缺保管人`,id,action,{expected_version:1,...body},409,'CUSTODIAN_REQUIRED');
    for(const value of [0,-1,1.5,'2',Number.MAX_SAFE_INTEGER+1,99999])await reject(`T3-${action}-坏user:${value}`,id,action,{expected_version:1,custodian_user_id:value},400,'LEDGER_BAD_REQUEST');
    await reject(`T3-${action}-坏name`,id,action,{expected_version:1,custodian_name:3},400,'LEDGER_BAD_REQUEST');
    for(const body of [{custodian_user_id:2},{custodian_user_id:2,custodian_name:'spoof'},{custodian_name:'  Trimmed  '}]) {
      const current=await asset(...INITIAL[action]);
      const fields={custodian_user_id:body.custodian_user_id||null,custodian_name:body.custodian_user_id?'Alice':'Trimmed'};
      const target=action==='assign'?{status:'in_service',...fields,location_text:null}:fields;
      await success(`T3-${action}-保管人正向`,current,action,{expected_version:1,...body},target);
    }
  }
  for(const action of ['place','relocate']) {
    const id=await asset(...INITIAL[action]);
    for(const location_text of [undefined,null,'  ',3])await reject(`T3-${action}-位置缺失`,id,action,{expected_version:1,location_text},400,'LEDGER_BAD_REQUEST');
  }
  for(const action of ['reassign','relocate','ap_relocate']) {
    const id=await asset(...INITIAL[action]);
    const params=action==='reassign'?{custodian_name:'Old'}:action==='relocate'?{location_text:' Old room '}:{floor_id:floorA,room_id:'r',pos:{y:0.3,x:0.2}};
    await reject(`T6-${action}-同值`,id,action,{expected_version:1,...params},409,'NO_OP_TRANSITION');
  }
  {
    const id=await asset('laptop','in_service');
    await rawRun("UPDATE it_assets SET custodian_user_id=2,custodian_name='old snapshot' WHERE id=?",[id]);
    await success('T3-同user新名称快照',id,'reassign',{expected_version:1,custodian_user_id:2},{custodian_user_id:2,custodian_name:'Alice'});
  }

  // T4：AP动作要求完整坐标，不能借登记时的pos默认值。
  for(const action of ['ap_place','ap_relocate']) {
    const id=await asset(...INITIAL[action]);const body={expected_version:1,...PARAMS[action]};
    for(const patch of [{floor_id:undefined},{floor_id:'missing'},{room_id:undefined},{room_id:'missing'},{pos:undefined},{pos:null},{pos:[]},{pos:{x:0}},{pos:{x:0,y:0,z:1}},{pos:{x:-0.1,y:0}},{pos:{x:0,y:1.1}},{pos:{x:'0',y:0}}])await reject(`T4-${action}-非法位置`,id,action,{...body,...patch},400,'LEDGER_BAD_REQUEST');
  }
  for(const kind of ['laptop','desktop','ap','other'])for(const to of ['in_depot','faulty','to_retire']) {
    const id=await asset(kind,'in_service');await success(`T4-return-${kind}-${to}`,id,'return',{expected_version:1,to},{...TARGET.return,status:to});
  }
  {
    const id=await asset('ap','in_service');
    for(const to of [null,'retired','in_service',1])await reject('T4-return坏去向',id,'return',{expected_version:1,to},400,'LEDGER_BAD_REQUEST');
    await success('T4-return默认in_depot',id,'return',{expected_version:1},{...TARGET.return,status:'in_depot'});
  }

  // T5：空值续费、真实日历校验、旧脏日期和停用。
  {
    const id=await asset('software','active');
    for(const expires_at of [undefined,null,'','2026-02-29','2027-13-01','2027-04-31','2026-10-01','2026-09-30'])await reject('T5-renew非法或不递增',id,'renew',{expected_version:1,expires_at},400,'LEDGER_BAD_REQUEST');
    await rawRun('UPDATE it_assets SET expires_at=NULL WHERE id=?',[id]);
    await success('T5-旧NULL接受历史合法闰日',id,'renew',{expected_version:1,expires_at:'2024-02-29'},{expires_at:'2024-02-29'});
    const dirty=await asset('software','active');await rawRun("UPDATE it_assets SET expires_at='broken' WHERE id=?",[dirty]);
    await reject('T5-旧坏日期500',dirty,'renew',{expected_version:1,expires_at:'2027-01-01'},500,'LEDGER_INTERNAL');
  }

  // T7：固定两个请求的先后顺序，不用sleep猜调度。
  async function ordered(label, first, second) {
    let release;const gate=new Promise(r=>{release=r;});let a;let b;
    const arrived=mod._internals.setTxnMidGate(gate);
    try {
      a=first();await awaitArrived(arrived,`${label}-到达`,a);b=second();
      await waitForCondition(()=>mod._internals.itTxnMutex._internals.waiterCount()>=1,`${label}-排队`);
      check(`${label}:第二请求真实排队`,mod._internals.itTxnMutex._internals.waiterCount()>=1);
      mod._internals.setTxnMidGate(null);release();return await Promise.all([a,b]);
    } finally {mod._internals.setTxnMidGate(null);release();await Promise.allSettled([a,b].filter(Boolean));}
  }
  for(const action of actions) {
    const id=await asset(...INITIAL[action]);const before=await read(id);const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    const body={expected_version:1,...PARAMS[action]};
    const [a,b]=await ordered(`T7-${action}`,()=>call(id,action,body),()=>call(id,action,body));
    check(`T7-${action}:恰一200一409`,a.status===200&&b.status===409&&b.body.code==='VERSION_CONFLICT',JSON.stringify({a,b}));
    const row=await read(id);const expected={...before,...TARGET[action],version:2,updated_at:row.updated_at};
    if(TARGET[action].pos)expected.pos=JSON.stringify(TARGET[action].pos);
    check(`T7-${action}:完整行只有一次变化`,same(row,expected));
    await assertEventSet(`T7-${action}`,a.body.op_id,{action,operator_id:1,primary:{assetId:id,from:project(before,KEYS[action]),to:project({...before,...TARGET[action]},KEYS[action])},affected:[]});
    const after=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    check(`T7-${action}:失败方未增加或篡改任何事件`,after.length===events.length+1&&same(after.slice(0,events.length),events)&&after[events.length].op_id===a.body.op_id);
  }
  for(const placeFirst of [true,false]) {
    const f=await floor();const id=await asset('ap','in_depot');const before=await read(id);
    const beforeFloor=await rawGet('SELECT * FROM it_floors WHERE id=?',[f]);
    check('T7-AP与楼层:楼层完整快照非空',!!beforeFloor);
    const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    const place=()=>call(id,'ap_place',{expected_version:1,floor_id:f,room_id:'r',pos:{x:0,y:1}});
    const remove=()=>api('PUT',`/api/it-assets/floors/${f}`,{...admin,body:{name:f,rooms:[]}});
    const [a,b]=await ordered(`T7-AP与楼层-${placeFirst}`,placeFirst?place:remove,placeFirst?remove:place);
    check(`T7-AP与楼层-${placeFirst}:首请求200`,a.status===200,JSON.stringify(a));
    check(`T7-AP与楼层-${placeFirst}:后请求精确拒绝`,placeFirst?b.status===409&&b.body.code==='ROOM_IN_USE':b.status===400&&b.body.code==='LEDGER_BAD_REQUEST',JSON.stringify(b));
    const row=await read(id);const floorRow=await rawGet('SELECT * FROM it_floors WHERE id=?',[f]);
    check(`T7-AP与楼层-${placeFirst}:楼层完整行正确`,same(floorRow,placeFirst?beforeFloor:{...beforeFloor,rooms:'[]'}));
    if(placeFirst) {
      const target={status:'in_service',floor_id:f,room_id:'r',pos:{x:0,y:1}};
      check('T7-AP先:完整行与版本',same(row,{...before,...target,pos:JSON.stringify(target.pos),version:2,updated_at:row.updated_at}));
      await assertEventSet('T7-AP先',a.body.op_id,{action:'ap_place',operator_id:1,primary:{assetId:id,from:project(before,KEYS.ap_place),to:project({...before,...target},KEYS.ap_place)},affected:[]});
    } else check('T7-楼层先:AP失败完整行不变',same(row,before));
    const after=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    check('T7-AP与楼层:既有事件原文不变且仅一新事件',same(events,after.slice(0,events.length))&&after.length===events.length+1);
    if(!placeFirst) {
      const event=after[events.length];
      await assertEventSet('T7-楼层先:完整floor_update',event.op_id,{action:'floor_update',operator_id:1,primary:{assetId:null,from:{floor_id:f,name:beforeFloor.name,sort_order:beforeFloor.sort_order,rooms:JSON.parse(beforeFloor.rooms)},to:{floor_id:f,name:f,sort_order:beforeFloor.sort_order,rooms:[]}},affected:[]});
    }
  }
  {
    const id=await asset('laptop','in_depot');
    const events=await rawAll('SELECT * FROM it_asset_events ORDER BY id');
    const r=await assertNoSideEffect('T1-排队撤权',[id],async()=>{
      const [,request]=await ordered('T1-撤权',()=>mod._internals.withWrite(q=>q.run('DELETE FROM it_asset_acl WHERE user_id=2')),()=>call(id,'assign',{expected_version:1,custodian_name:'New'},{uid:2,role:'user'}));return request;
    });
    check('T1-排队撤权:403',r.status===403&&r.body.code==='LEDGER_FORBIDDEN',JSON.stringify(r));
    check('T1-排队撤权:全事件表不变',same(events,await rawAll('SELECT * FROM it_asset_events ORDER BY id')));
    const restored=await api('PUT','/api/it-assets/acl/2',{...admin,body:{level:'write'}});check('T1-恢复授权200',restored.status===200,JSON.stringify(restored));
  }

  // T8：只变异C5模块，运行器不依赖C4。所有临时句柄、文件显式关闭/清理。
  const sourceDir=path.resolve(__dirname,'../routes/it-ledger');
  async function world(label, transform, scenario) {
    const parent=path.join(__dirname,'.mutant-scratch');fs.mkdirSync(parent,{recursive:true});
    const dir=fs.mkdtempSync(path.join(parent,'c5-'));
    const indexPath=path.join(dir,'index.js');const modulePath=path.join(dir,'single-asset-actions.js');
    const dbPath=path.join(os.tmpdir(),unique('c5-world')+'.db');let server;let instance;
    try {
      let index=fs.readFileSync(path.join(sourceDir,'index.js'),'utf8');
      for(const [name,target]of [['invariants',path.join(sourceDir,'invariants.js')],['single-asset-actions',modulePath],['stocktakes',path.join(sourceDir,'stocktakes.js')],['reconciles',path.join(sourceDir,'reconciles.js')],['inspections',path.join(sourceDir,'inspections.js')],['inspection-collector',path.join(sourceDir,'inspection-collector.js')],['inspection-collect',path.join(sourceDir,'inspection-collect.js')],['record-management',path.join(sourceDir,'record-management.js')],['inspection-sheets',path.join(sourceDir,'inspection-sheets.js')],['inspection-photo-files',path.join(sourceDir,'inspection-photo-files.js')]]) {
        const literal=`require('./${name}')`;assert.equal(index.split(literal).length,2,'C5 world dependency count');
        index=index.replace(literal,`require(${JSON.stringify(target)})`);
      }
      assert.equal((index.match(/require\((['"])\.\.?\//g)||[]).length,0,'C5 world unresolved relative require');
      const original=fs.readFileSync(path.join(sourceDir,'single-asset-actions.js'),'utf8');
      fs.writeFileSync(modulePath,transform?transform(original):original,'utf8');fs.writeFileSync(indexPath,index,'utf8');
      await seedUsers(dbPath);
      instance=require(indexPath)({logger,DB_FILE:dbPath,authenticateToken:fakeAuthenticateToken,requireAdmin:fakeRequireAdmin,enableTestHooks:true});
      await withTimeout(instance.initSchema(),15000,label+' init');
      const app=express();app.use(express.json());app.use('/api',instance.router);server=await listenOnSafePort(app, null);
      const base=`http://localhost:${server.address().port}`;
      const request=async(method,url,body)=>{
        const r=await withTimeout(fetchTestHttp(base+url,{method,headers:{'Content-Type':'application/json','x-test-user-id':'1','x-test-user-role':'admin'},body:body===undefined?undefined:JSON.stringify(body)}),5000,label+' HTTP');
        return {status:r.status,body:await r.json()};
      };
      await scenario(request,dbPath);
    } finally {
      if(server)try{await withTimeout(new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve())),5000,'C5 server close');}catch(e){check(label+' server close',false,e.message);}
      if(instance)try{await withTimeout(instance.shutdown(),10000,'C5 shutdown');}catch(e){check(label+' shutdown',false,e.message);}
      for(const file of [indexPath,modulePath,dbPath]) {
        delete require.cache[file];
        try{if(fs.existsSync(file))fs.unlinkSync(file);}catch(e){check(label+' file cleanup',false,e.message);}
      }
      try{fs.rmdirSync(dir);}catch(e){check(label+' directory cleanup',false,e.message);}
    }
  }
  function replaceOnce(src,pattern,replacement) {assert.equal((src.match(pattern)||[]).length,1,'C5 mutation target count');return src.replace(pattern,replacement);}
  for(const mutation of ['version','validate','event'])for(const mutated of [false,true]) {
    const label=`T8-${mutation}-${mutated?'变异':'干净'}`;
    const transform=!mutated?null:src=>mutation==='version'?replaceOnce(src,/version = version \+ 1/g,'version = version'):
      mutation==='validate'?replaceOnce(src,/const violation = invariants\.validateAssetInvariants\(row, ctx\); \/\/ C5_REREAD_VALIDATE/g,'const violation = null; // removed C5 validation'):
      replaceOnce(src,/    await writeEvent\(q, \{ \/\/ C5_EVENT_BEGIN[\s\S]*?    \}\); \/\/ C5_EVENT_END/g,'    // C5 event removed');
    await world(label,transform,async(request,dbPath)=>{
      const software=mutation==='version';const action=software?'renew':'return';
      const body=software?{category:'software',name:label,expires_at:'2026-10-01'}:{category:'laptop',name:label,placement:{kind:'custodian',custodian_name:'Old',location_text:'Old room'}};
      const created=await request('POST','/api/it-assets',body);check(label+':夹具201',created.status===201,JSON.stringify(created));if(created.status!==201)throw Error(label+' fixture');
      const id=created.body.id;const before=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id]);check(label+':完整行非空',!!before);
      const params=software?{expected_version:1,expires_at:'2027-01-01'}:{expected_version:1,to:'faulty'};
      if(mutation==='validate')await rawRunAt(dbPath,`CREATE TRIGGER dirty_return AFTER UPDATE OF status ON it_assets WHEN NEW.id=${id} BEGIN UPDATE it_assets SET custodian_name='dirty' WHERE id=${id}; END`);
      const eventsBefore=await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id');
      const r=await request('POST',`/api/it-assets/${id}/actions/${action}`,params);
      if(mutation==='validate'&&!mutated) {
        check(label+':409 CUSTODIAN_REQUIRED',r.status===409&&r.body.code==='CUSTODIAN_REQUIRED',JSON.stringify(r));
        check(label+':完整行无副作用',same(before,await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id])));
        check(label+':全事件无副作用',same(eventsBefore,await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id')));return;
      }
      check(label+':200',r.status===200,JSON.stringify(r));if(r.status!==200)throw Error(label+' request');
      const target=software?{expires_at:'2027-01-01'}:{...TARGET.return,...(mutation==='validate'&&mutated?{custodian_name:'dirty'}:{})};
      const after=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id]);
      check(label+':真实完整落库',same(after,{...before,...target,version:mutation==='version'&&mutated?1:2,updated_at:after.updated_at}));
      const eventRows=await rawAllAt(dbPath,'SELECT * FROM it_asset_events WHERE op_id=?',[r.body.op_id]);
      if(mutation==='event'&&mutated) {
        let failure;try{oneEvent(eventRows);}catch(e){failure=e;}
        const verdict={ok:!!failure,hitTarget:failure&&failure.code==='ERR_ASSERTION'&&failure.message.includes('C5_EVENT_COUNT')&&failure.actual===0&&failure.expected===1,otherErr:failure&&failure.code!=='ERR_ASSERTION'?failure.message:null};
        check(label+':事件助手目标断言变红且无他错',verdict.ok&&verdict.hitTarget&&!verdict.otherErr,JSON.stringify(verdict));
      } else {
        oneEvent(eventRows);
        await assertEventSetFrom(dbPath,label,r.body.op_id,{action,operator_id:1,primary:{assetId:id,from:project(before,KEYS[action]),to:project({...before,...target},KEYS[action])},affected:[]});
      }
      if(mutation==='version') {
        const prior=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id]);const priorEvents=await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id');
        const second=await request('POST',`/api/it-assets/${id}/actions/renew`,{expected_version:1,expires_at:'2028-01-01'});
        if(!mutated) {
          check(label+':陈旧第二请求409',second.status===409&&second.body.code==='VERSION_CONFLICT',JSON.stringify(second));
          check(label+':第二请求完整行回滚',same(prior,await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id])));
          check(label+':第二请求全事件回滚',same(priorEvents,await rawAllAt(dbPath,'SELECT * FROM it_asset_events ORDER BY id')));
        } else {
          check(label+':陈旧第二请求错误放行200',second.status===200,JSON.stringify(second));
          const last=await rawGetAt(dbPath,'SELECT * FROM it_assets WHERE id=?',[id]);check(label+':第二次确实落库且version仍1',last.expires_at==='2028-01-01'&&last.version===1);
          await assertEventSetFrom(dbPath,label+' second',second.body.op_id,{action:'renew',operator_id:1,primary:{assetId:id,from:{expires_at:'2027-01-01'},to:{expires_at:'2028-01-01'}},affected:[]});
        }
      }
    });
  }
};
