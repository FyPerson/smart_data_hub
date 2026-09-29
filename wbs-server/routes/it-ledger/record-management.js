'use strict';
const express = require('express');

module.exports = function createRecordManagement({withRead,withWrite,requireLedgerWrite,handleErr,stripFinance,invariants,parseAssetRow}) {
  const router=express.Router();
  const fail=(status,message,code='RECORD_CONFLICT')=>Object.assign(new Error(message),{status,code});
  const tableExists=(q,name)=>q.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]);
  async function control(q,id){return await tableExists(q,'it_asset_record_controls')?q.get('SELECT * FROM it_asset_record_controls WHERE asset_id=?',[id]):null;}
  async function assertActive(q,id){if(await control(q,id))throw fail(409,'该记录已作废或删除，只能查阅历史','ASSET_RECORD_INACTIVE');}
  async function activeClause(q,alias='it_assets') {
    if(!['it_assets','a'].includes(alias))throw Error('Invalid internal asset alias');
    return await tableExists(q,'it_asset_record_controls')?`NOT EXISTS (SELECT 1 FROM it_asset_record_controls rc WHERE rc.asset_id=${alias}.id)`:'1=1';
  }
  async function history(q,id){
    if(!await tableExists(q,'it_asset_record_audit'))return [];
    return (await q.all('SELECT * FROM it_asset_record_audit WHERE asset_id=? ORDER BY id',[id])).map(r=>{
      const {before_json,after_json,...rest}=r;return {...rest,before:JSON.parse(before_json),after:JSON.parse(after_json)};
    });
  }
  async function ensure(q){
    await q.run(`CREATE TABLE IF NOT EXISTS it_asset_record_controls(asset_id INTEGER PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('voided','deleted')),reason TEXT NOT NULL,operator_id INTEGER NOT NULL,created_at TEXT NOT NULL)`);
    await q.run(`CREATE TABLE IF NOT EXISTS it_asset_record_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN ('reclassify','void','delete')),reason TEXT NOT NULL,operator_id INTEGER NOT NULL,created_at TEXT NOT NULL,before_json TEXT NOT NULL,after_json TEXT NOT NULL)`);
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_asset_record_audit_asset ON it_asset_record_audit(asset_id,id)');
    await q.run(`CREATE TRIGGER IF NOT EXISTS it_record_block_update BEFORE UPDATE ON it_assets WHEN EXISTS(SELECT 1 FROM it_asset_record_controls WHERE asset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'ASSET_RECORD_INACTIVE'); END`);
    for(const verb of ['INSERT','UPDATE'])await q.run(`CREATE TRIGGER IF NOT EXISTS it_record_block_parent_${verb.toLowerCase()} BEFORE ${verb} ON it_assets WHEN EXISTS(SELECT 1 FROM it_asset_record_controls WHERE asset_id=NEW.parent_asset_id) BEGIN SELECT RAISE(ABORT,'ASSET_RECORD_INACTIVE'); END`);
  }
  async function canRead(q,user){if(user.role!=='admin'&&!await q.get('SELECT level FROM it_asset_acl WHERE user_id=?',[user.id]))throw fail(403,'访问权限已变化','LEDGER_FORBIDDEN');}
  async function references(q,r){
    const children=(await q.get('SELECT COUNT(*) n FROM it_assets WHERE parent_asset_id=?',[r.id])).n;
    const stock=await q.get("SELECT COUNT(*) n,SUM(CASE WHEN b.status='open' THEN 1 ELSE 0 END) opened FROM it_stocktake_items i JOIN it_stocktakes b ON b.id=i.stocktake_id WHERE i.asset_id=?",[r.id]);
    let reconcile={n:0,opened:0};
    if(await tableExists(q,'it_reconcile_items')){
      const rows=await q.all('SELECT i.asset_id,i.ambiguous_candidates,b.status FROM it_reconcile_items i JOIN it_reconciles b ON b.id=i.reconcile_id WHERE i.asset_id=? OR i.ambiguous_candidates IS NOT NULL',[r.id]);
      for(const x of rows){const candidates=x.ambiguous_candidates?JSON.parse(x.ambiguous_candidates):[];if(x.asset_id===r.id||candidates.some(c=>c.id===r.id||c.asset_id===r.id)){reconcile.n++;if(x.status==='open')reconcile.opened++;}}
    }
    const inspections=await tableExists(q,'it_device_inspections')?(await q.get('SELECT COUNT(*) n FROM it_device_inspections WHERE asset_id=?',[r.id])).n:0;
    // C3（长任务 E · 巡检台账采集，方案 §7.1）：资产出现在任何未物理删除的巡检单 device 段检查项
    // 中的次数（含已逻辑删除——逻辑删除不删行，item 行还在；只有草稿物理删除才会真的删掉 item 行，
    // 此时这里自然计不到，天然满足"未物理删除"这个限定）。独立字段，不并入上面的 inspections——
    // inspections 在下面 categoryCandidate() 里用于禁止改成非服务器类别，而巡检单柜内设备范围包含
    // 非服务器设备（other 等），并进去会让这些设备无法更正类别；本字段只并入 detached()/inspect()
    // 里的删除判断（与彻底删除同一口径——彻底删除的 purgeReason 由 deletion 派生，见 inspect()）。
    // 巡检单表不存在时该字段为 0。
    const inspectionSheets=await tableExists(q,'it_inspection_sheet_items')?(await q.get("SELECT COUNT(*) n FROM it_inspection_sheet_items WHERE section='device' AND target_id=?",[r.id])).n:0;
    const used=(await q.get("SELECT COUNT(*) n FROM it_asset_events WHERE (asset_id=? OR related_asset_id=?) AND action!='register'",[r.id,r.id])).n;
    const managed=(await history(q,r.id)).length;
    return {children,stocktakes:stock.n,reconciles:reconcile.n,open_batches:(stock.opened||0)+reconcile.opened,inspections,inspection_sheets:inspectionSheets,used,managed};
  }
  function detached(r,refs){
    if(refs.children)return '存在随装硬盘，请先逐盘拆出';
    if(r.parent_asset_id!==null)return '设备仍挂载在宿主中，请先拆出';
    if(r.rack_id!==null||r.floor_id!==null||r.custodian_name!==null||r.custodian_user_id!==null||r.location_text!==null||r.status==='in_service')return '设备仍在用或有位置、领用关系，请先下架、归还或拆下';
    return null;
  }
  function categoryCandidate(r,target,refs){
    if(!invariants.CATEGORY_VALUES.includes(target)||target===r.category)throw fail(400,'请选择不同的有效类别');
    if(refs.open_batches)throw fail(409,'存在未关闭的盘点或对账，请先完成核对');
    if(['software','subscription'].includes(r.category)||['software','subscription'].includes(target))throw fail(409,'软件、订阅与其他类别暂不互转，请保留原记录并核实登记方式');
    if(r.status==='retired')throw fail(409,'已报废设备只保留历史，不再更正类别');
    if(refs.inspections&&target!=='server')throw fail(409,'存在服务器巡检历史，不能更正为非服务器类别');
    const terminals=['laptop','desktop'].includes(r.category)&&['laptop','desktop'].includes(target);
    const hosts=invariants.isHostEligible(r)&&['server','other'].includes(target);
    if(!terminals&&!hosts){const reason=detached(r,refs);if(reason)throw fail(409,reason);}
    const oldAttrs=JSON.parse(r.attrs),attrs=Object.fromEntries(Object.entries(oldAttrs).filter(([k])=>invariants.ATTRS_ALLOWED_KEYS[target].includes(k)));
    return {...r,category:target,attrs:JSON.stringify(attrs),u_height:target==='server'?(r.u_height||1):target==='other'?r.u_height:0,slot_count:['server','other'].includes(target)?r.slot_count:0};
  }
  async function validate(q,row){
    const r=parseAssetRow(row),ctx={};
    if(r.rack_id!==null){ctx.rack=await q.get('SELECT u_total FROM it_racks WHERE id=?',[r.rack_id]);ctx.occupiedIntervals=(await q.all("SELECT id,u_start,u_height FROM it_assets WHERE rack_id=? AND status='in_service'",[r.rack_id])).map(x=>[x.u_start,x.u_start+x.u_height-1,x.id]);}
    if(r.floor_id!==null){const f=await q.get('SELECT rooms FROM it_floors WHERE id=?',[r.floor_id]);ctx.floor=f?{rooms:JSON.parse(f.rooms)}:null;}
    if(r.parent_asset_id!==null)ctx.parent=await q.get('SELECT slot_count,status,category FROM it_assets WHERE id=?',[r.parent_asset_id]);
    if(invariants.isHostEligible(r))ctx.childDisks=await q.all('SELECT slot_no,status FROM it_assets WHERE parent_asset_id=?',[r.id]);
    const violation=invariants.validateAssetInvariants(r,ctx);if(violation)throw Object.assign(new Error(violation.message),violation);
  }
  async function inspect(q,r,user){
    const c=await control(q,r.id),refs=await references(q,r),why=c?'该记录已归档，只能查阅历史':null;
    const common=why||detached(r,refs)||(refs.open_batches?'存在未关闭的盘点或对账，请先完成核对':null);
    const deletion=common||(!['in_depot','active','cancelled'].includes(r.status)?'删除只适用于未投入使用的误建记录':null)||(refs.stocktakes||refs.reconciles||refs.inspections||refs.inspection_sheets||refs.used||refs.managed?'已有业务或管理历史，请使用作废保留记录':null);
    // Purge is the hard-delete form of "misregistered record" and must never be wider than deletion:
    // a used asset keeps its history and identifiers (void it instead).
    const events=await q.all('SELECT id,op_id,asset_id,related_asset_id FROM it_asset_events WHERE asset_id=? OR related_asset_id=?',[r.id,r.id]);
    let sharedEvents=false;
    for(const opId of new Set(events.map(e=>e.op_id))){
      // Another asset's own row (e.g. the host's affected row pointing at this disk) belongs to that asset's history.
      const peers=await q.all('SELECT asset_id FROM it_asset_events WHERE op_id=?',[opId]);
      if(peers.some(e=>e.asset_id!==r.id)){sharedEvents=true;break;}
    }
    const purgeReason=user.role!=='admin'?'仅管理员可彻底删除':
      (deletion?`彻底删除只适用于从未使用的误建记录：${deletion}`:null)||
      (sharedEvents?'登记操作同时记录在其他资产的历史中，不能单独彻底删除，请使用作废':null);
    const targets=[];
    for(const category of invariants.CATEGORY_VALUES.filter(x=>x!==r.category)){
      try{if(why)throw fail(409,why);const candidate=categoryCandidate(r,category,refs);await validate(q,candidate);targets.push({category,allowed:true,attrs:JSON.parse(candidate.attrs),u_height:candidate.u_height,slot_count:candidate.slot_count,archived_keys:Object.keys(JSON.parse(r.attrs)).filter(k=>!invariants.ATTRS_ALLOWED_KEYS[category].includes(k))});}
      catch(e){if(e.status>=500||!e.status)throw e;targets.push({category,allowed:false,reason:e.message});}
    }
    return {asset:parseAssetRow(r),control:c,references:refs,targets,void_reason:user.role!=='admin'?'仅管理员可作废记录':common,delete_reason:user.role!=='admin'?'仅管理员可删除误建记录':deletion,purge_reason:purgeReason,purge_events:events.length};
  }
  function recordId(value){const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw fail(400,'资产编号无效');return n;}
  router.get('/:id/record-management',async(req,res)=>{try{const result=await withRead(async q=>{await canRead(q,req.user);const r=await q.get('SELECT * FROM it_assets WHERE id=?',[recordId(req.params.id)]);if(!r)throw fail(404,'资产不存在');return inspect(q,r,req.user);});res.json(stripFinance(result,req.user.role==='admin'));}catch(e){handleErr(res,e);}});
  router.post('/:id/record-management',requireLedgerWrite,async(req,res)=>{try{
    const b=req.body||{};if(Object.keys(b).some(k=>!['action','reason','expected_version','category'].includes(k))||!['reclassify','void','delete'].includes(b.action)||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>2000||!Number.isSafeInteger(b.expected_version)||b.expected_version<1)throw fail(400,'请选择操作、填写原因（最多2000字）并携带当前版本');
    if(b.action!=='reclassify'&&Object.hasOwn(b,'category'))throw fail(400,'此操作不接受类别字段');
    const result=await withWrite(async q=>{
      await q.assertWrite(req.user);if(b.action!=='reclassify'&&req.user.role!=='admin')throw fail(403,'仅管理员可作废或删除记录','LEDGER_FORBIDDEN');
      const id=recordId(req.params.id),r=await q.get('SELECT * FROM it_assets WHERE id=?',[id]);if(!r)throw fail(404,'资产不存在');await assertActive(q,id);if(r.version!==b.expected_version)throw fail(409,'资料已变化，请重新打开核对','VERSION_CONFLICT');if(r.version>=Number.MAX_SAFE_INTEGER)throw fail(409,'记录版本已达上限，请管理员核查','RECORD_VERSION_LIMIT');
      const info=await inspect(q,r,req.user);let candidate=r;
      if(b.action==='reclassify'){candidate=categoryCandidate(r,b.category,info.references);await validate(q,candidate);}
      else {const reason=b.action==='void'?info.void_reason:info.delete_reason;if(reason)throw fail(409,reason);}
      await ensure(q);const now=new Date().toISOString();
      await q.run('UPDATE it_assets SET category=?,attrs=?,u_height=?,slot_count=?,version=version+1,updated_at=? WHERE id=?',[candidate.category,candidate.attrs,candidate.u_height,candidate.slot_count,now,id]);
      const after=await q.get('SELECT * FROM it_assets WHERE id=?',[id]);
      const expected={...candidate,version:r.version+1,updated_at:now};if(!after||Object.keys(after).length!==Object.keys(expected).length||Object.keys(expected).some(k=>after[k]!==expected[k]))throw fail(500,'写后资产与预期变更不符','RECORD_INTERNAL');
      await validate(q,after);
      if(b.action!=='reclassify')await q.run('INSERT INTO it_asset_record_controls(asset_id,state,reason,operator_id,created_at) VALUES(?,?,?,?,?)',[id,b.action==='void'?'voided':'deleted',b.reason.trim(),req.user.id,now]);
      await q.run('INSERT INTO it_asset_record_audit(asset_id,action,reason,operator_id,created_at,before_json,after_json) VALUES(?,?,?,?,?,?,?)',[id,b.action,b.reason.trim(),req.user.id,now,JSON.stringify(parseAssetRow(r)),JSON.stringify(parseAssetRow(after))]);
      return {asset:parseAssetRow(after),control:await control(q,id)};
    });res.json(stripFinance(result,req.user.role==='admin'));
  }catch(e){handleErr(res,e);}});
  router.delete('/:id/purge',requireLedgerWrite,async(req,res)=>{try{
    const b=req.body||{};
    if(Object.keys(b).some(k=>!['reason','expected_version','confirm_name'].includes(k))||typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>2000||!Number.isSafeInteger(b.expected_version)||b.expected_version<1||typeof b.confirm_name!=='string')throw fail(400,'请填写删除原因、确认资产名称并携带当前版本');
    const result=await withWrite(async q=>{
      await q.assertWrite(req.user);
      if(req.user.role!=='admin')throw fail(403,'仅管理员可彻底删除','LEDGER_FORBIDDEN');
      const id=recordId(req.params.id),r=await q.get('SELECT * FROM it_assets WHERE id=?',[id]);
      if(!r)throw fail(404,'资产不存在');
      if(r.version!==b.expected_version)throw fail(409,'资料已变化，请重新打开核对','VERSION_CONFLICT');
      if(b.confirm_name!==r.name)throw fail(400,'输入的资产名称不一致');
      const info=await inspect(q,r,req.user);
      if(info.purge_reason)throw fail(409,info.purge_reason);
      // The audit row is the only trace left once identifiers are released, so it keeps a full snapshot.
      const ownEvents=await q.all('SELECT * FROM it_asset_events WHERE asset_id=? ORDER BY id',[id]);
      const deleted=await q.run('DELETE FROM it_asset_events WHERE asset_id=?',[id]);
      const removed=await q.run('DELETE FROM it_assets WHERE id=?',[id]);
      const dangling=(await q.get('SELECT COUNT(*) n FROM it_asset_events WHERE related_asset_id=?',[id])).n;
      if(deleted.changes!==ownEvents.length||removed.changes!==1||dangling)throw fail(500,'彻底删除结果与预期不符，已回滚','RECORD_INTERNAL');
      await q.run('CREATE TABLE IF NOT EXISTS it_asset_purge_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,asset_id INTEGER NOT NULL,category TEXT NOT NULL,name TEXT NOT NULL,sn TEXT,asset_no TEXT,reason TEXT NOT NULL,operator_id INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_events INTEGER NOT NULL,before_json TEXT NOT NULL,events_json TEXT NOT NULL)');
      await q.run('INSERT INTO it_asset_purge_audit(asset_id,category,name,sn,asset_no,reason,operator_id,created_at,deleted_events,before_json,events_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[id,r.category,r.name,r.sn,r.asset_no,b.reason.trim(),req.user.id,new Date().toISOString(),deleted.changes,JSON.stringify(parseAssetRow(r)),JSON.stringify(ownEvents)]);
      return {id,deleted_events:deleted.changes};
    });
    res.json(result);
  }catch(e){handleErr(res,e);}});
  return {router,control,history,assertActive,activeClause};
};
