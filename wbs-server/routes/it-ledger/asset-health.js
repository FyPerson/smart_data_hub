'use strict';
// Read-only projection of the existing inspection workflow; never collects, judges, or creates tables.
const parse=v=>{try{return JSON.parse(v);}catch(_){return null;}};
const serial=v=>String(v||'').trim().toUpperCase();
const labels={normal:'正常',warning:'告警',damaged:'损坏'};
function classify(snapshot,disk,item){
 const status=snapshot.collection_status;
 if(status==='failed')return null;
 const alerts=Array.isArray(snapshot.alerts)?snapshot.alerts:null;
 const errors=Array.isArray(snapshot.component_errors)?snapshot.component_errors:null;
 const cleanup=Array.isArray(snapshot.cleanup_warnings)?snapshot.cleanup_warnings:null;
 if(!alerts||!errors||!cleanup)return null;
 const confirmed=item?.result==='ok'||(item?.result==='bad'&&!!String(item.note||'').trim());
 let kind=null;
 if(disk){
  const state=String(disk.state||'').trim(),health=String(disk.status||'').trim();
  const warning=disk.failure_predicted===true||!['Online','Ready'].includes(state)||health!=='Ok';
  if(warning)kind=state.toLowerCase()==='failed'&&item?.result==='bad'&&String(item.note||'').trim()?'damaged':'warning';
  else if(status==='success'&&!errors.length&&!cleanup.length&&['Online','Ready'].includes(state)&&health==='Ok')kind='normal';
 }else{
  if(alerts.length||errors.length||cleanup.length||item?.result==='bad')kind='warning';
  else if(status==='success'&&snapshot.server)kind='normal';
 }
 if(!kind)return null;
 // An abnormal source remains orange even if the operator overrides a whole-server check to normal.
 return {kind,label:labels[kind],confirmed,reason:String(item?.note||'').trim(),evidence:disk?[disk.state,disk.status,disk.failure_predicted?'预测故障':''].filter(Boolean).join(' · '):alerts.map(a=>String(a.message||'')).filter(Boolean).join('；'),collection_status:status};
}
module.exports=function createAssetHealth({sheetVisibility}){
 async function list(q,assets,user){
  const has=async name=>!!await q.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]);
  if(!await has('it_device_inspections'))return {};
  const columns=new Set((await q.all('PRAGMA table_info(it_device_inspections)')).map(c=>c.name));
  if(!columns.has('snapshot_json'))return {};
  const sourceIds=assets.filter(a=>a.category==='server').map(a=>a.id);if(!sourceIds.length)return {};
  // Match the existing device-history horizon: at most 100 snapshots per current source server.
  const rows=await q.all('SELECT * FROM it_device_inspections d WHERE d.asset_id IN ('+sourceIds.map(()=>'?').join(',')+') AND d.id IN (SELECT r.id FROM it_device_inspections r WHERE r.asset_id=d.asset_id ORDER BY r.id DESC LIMIT 100) ORDER BY d.id DESC',sourceIds);
  const sheetsExist=await has('it_inspection_sheets'),itemsExist=await has('it_inspection_sheet_items');
  const sheets=sheetsExist?await q.all('SELECT id,status,created_by,deleted_at FROM it_inspection_sheets'):[];
  const bySheet=new Map(sheets.map(s=>[s.id,s]));
  const items=itemsExist?await q.all("SELECT sheet_id,target_id,device_inspection_id,result,note FROM it_inspection_sheet_items WHERE section='device' AND device_inspection_id IS NOT NULL"):[];
  const byInspection=new Map(items.map(i=>[i.device_inspection_id,i]));
  const sources=new Map();
  for(const row of rows){
   const sheet=row.sheet_id?bySheet.get(row.sheet_id):null;
   if(row.sheet_id&&(!sheet||sheet.deleted_at||sheetVisibility(user,sheet)!=='full'))continue;
   const snap=parse(row.snapshot_json);if(!snap||snap.source_host!==row.source_host)continue;
   const item=byInspection.get(row.id);
   const judgement=item&&item.sheet_id===row.sheet_id&&item.target_id===row.asset_id?item:!row.sheet_id&&row.judgement?{result:row.judgement==='normal'?'ok':'bad',note:row.judgement_note}:null;
   const entry={row,snap,item:judgement};if(!sources.has(row.asset_id))sources.set(row.asset_id,[]);sources.get(row.asset_id).push(entry);
  }
  const assetsById=new Map(assets.map(a=>[a.id,a]));const result={};
  for(const asset of assets){
   const host=asset.category==='disk'?assetsById.get(asset.parent_asset_id):asset;
   if(!host||host.category!=='server'||!serial(asset.sn)||!serial(host.sn))continue;
   const history=(sources.get(host.id)||[]).filter(e=>e.row.source_host===host.attrs?.ip&&(e.snap.server?serial(e.snap.server.serial_number)===serial(host.sn):e.snap.collection_status==='failed'));
   let latest=null;
   for(const e of history){
    if(!latest)latest={status:e.snap.collection_status,at:e.row.completed_at||e.row.started_at,id:e.row.id};
    let disk=null;
    if(asset.category==='disk'){
     const matches=(Array.isArray(e.snap.physical_disks)?e.snap.physical_disks:[]).filter(d=>serial(d.serial_number)===serial(asset.sn));
     if(matches.length!==1)continue;disk=matches[0];
    }
    const health=classify(e.snap,disk,e.item);if(!health)continue;
    result[asset.id]={...health,observed_at:e.row.completed_at||e.row.started_at,source_asset_id:host.id,source_inspection_id:e.row.id,sheet_id:e.row.sheet_id||null,latest_attempt:latest};break;
   }
   if(!result[asset.id]&&latest)result[asset.id]={kind:null,label:null,observed_at:latest.at,collection_status:latest.status,confirmed:false,reason:'',latest_attempt:latest};
  }
  return result;
 }
 return {list};
};
module.exports.classify=classify;
