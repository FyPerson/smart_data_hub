'use strict';
const fs=require('fs'),path=require('path'),net=require('net'),{execFile}=require('child_process');
const defaultConfig=path.resolve(__dirname,'../../../docs/local/servers.env');
function configuredHost(configPath=defaultConfig){
 try{const text=fs.readFileSync(configPath,'utf8');const match=text.match(/^\s*(?:IP地址|IP|HOST)\s*[:：=]\s*(\S+)\s*$/im);return match&&net.isIP(match[1])===4?match[1]:null;}catch(_){return null;}
}
function reportRows(text){
 const rows=[];let current;
 for(const line of String(text||'').split(/\r?\n/)){const m=line.match(/^([^:]+?)\s*:\s*(.*)$/);if(!m)continue;const key=m[1].trim();if(key==='ID'){current={};rows.push(current);}if(current)current[key]=m[2].trim();}
 return rows;
}
const bytes=value=>{const m=String(value||'').match(/\(([\d,]+) bytes\)/);return m?Number(m[1].replace(/,/g,'')):null;};
function normalize(raw){
 const s={schema_version:1,started_at:raw.started_at,completed_at:raw.completed_at,source_host:raw.source_host,server:raw.server||null,volumes:[],physical_disks:[],virtual_disks:[],enclosures:[],alerts:[],component_errors:[],cleanup_warnings:[]};
 s.server=s.server?{name:String(s.server.name||''),manufacturer:String(s.server.manufacturer||''),model:String(s.server.model||''),serial_number:String(s.server.serial_number||'').trim(),os:String(s.server.os||''),memory_bytes:Number(s.server.memory_bytes)||0,cpus:(s.server.cpus||[]).map(c=>({name:String(c.name||''),cores:Number(c.cores)||0,threads:Number(c.threads)||0}))}:null;
 // A RAW/unformatted volume must not void the snapshot and hide RAID or disk alerts: skip it and mark partial.
 for(const v of (raw.volumes||[]).map(v=>({name:String(v.name||''),filesystem:String(v.filesystem||''),size_bytes:v.size_bytes==null?NaN:Number(v.size_bytes),free_bytes:v.free_bytes==null?NaN:Number(v.free_bytes)}))){if(!Number.isSafeInteger(v.size_bytes)||v.size_bytes<=0||!Number.isSafeInteger(v.free_bytes)||v.free_bytes<0||v.free_bytes>v.size_bytes){s.component_errors.push(`卷 ${v.name.slice(0,40)} 容量数据无效，已跳过`);continue;}s.volumes.push(v);v.free_percent=Math.round(v.free_bytes/v.size_bytes*10000)/100;if(v.free_percent<10)s.alerts.push({severity:'attention',kind:'volume_space',message:`卷 ${v.name} 可用空间 ${v.free_percent}%（提醒阈值10%）`});}
 for(const c of raw.controllers||[]){
  if(!reportRows(c.pdisk).length)s.component_errors.push('控制器'+String(c.id)+'未取得物理盘清单');
  if(!reportRows(c.vdisk).length)s.component_errors.push('控制器'+String(c.id)+'未取得虚拟盘清单');
  for(const d of reportRows(c.pdisk)){
   const row={controller_id:String(c.id),source_id:d.ID,model:d['Product ID']||d['Model Number']||'',serial_number:d['Serial No.']||'',capacity_bytes:bytes(d.Capacity),protocol:d['Bus Protocol']||'',state:d.State||'Unknown',status:d.Status||'Unknown',failure_predicted:d['Failure Predicted']==='Yes',certified:d.Certified||''};s.physical_disks.push(row);
   if(row.state!=='Online'&&row.state!=='Ready')s.alerts.push({severity:'critical',kind:'physical_disk',message:`控制器${row.controller_id} / ${row.source_id}（${row.serial_number}）：${row.state}`});
   if(row.failure_predicted)s.alerts.push({severity:'critical',kind:'predicted_failure',message:`控制器${row.controller_id} / ${row.source_id}（${row.serial_number}）：预测故障`});
   if(row.status!=='Ok'&&(row.state==='Online'||row.state==='Ready')&&!row.failure_predicted)s.alerts.push({severity:row.status==='Critical'?'critical':'attention',kind:'disk_warning',message:`控制器${row.controller_id} / ${row.source_id}：${row.status}${row.certified==='No'?'，非认证盘':''}`});
  }
  for(const d of reportRows(c.vdisk)){const row={controller_id:String(c.id),source_id:d.ID,name:d.Name||'',state:d.State||'Unknown',status:d.Status||'Unknown',raid:d.Layout||'',size_bytes:bytes(d.Size),os_device:d['Device Name']||''};s.virtual_disks.push(row);if(row.state!=='Ready')s.alerts.push({severity:'critical',kind:'raid',message:`控制器${row.controller_id} / ${row.name}：${row.raid} ${row.state}`});else if(row.status!=='Ok')s.alerts.push({severity:row.status==='Critical'?'critical':'attention',kind:'raid_warning',message:`控制器${row.controller_id} / ${row.name}：${row.raid} ${row.status}`});}
  for(const e of reportRows(c.enclosure)){const row={controller_id:String(c.id),source_id:e.ID,name:e.Name||'',serial_number:(e['Service Tag']||'').trim(),state:e.State||'',status:e.Status||''};s.enclosures.push(row);if(!row.state||!row.status)s.component_errors.push(`控制器${row.controller_id} / ${String(row.name).slice(0,40)}：状态字段未取得`);if((row.state&&row.state!=='Ready')||(row.status&&row.status!=='Ok'))s.alerts.push({severity:row.status==='Critical'||/fail/i.test(row.state)?'critical':'attention',kind:'enclosure',message:`控制器${row.controller_id} / ${row.name}：${row.state} ${row.status}`});}
 }
 s.component_errors=s.component_errors.concat((raw.component_errors||[]).map(x=>String(x).slice(0,180)));s.cleanup_warnings=(raw.cleanup_warnings||[]).map(x=>String(x).slice(0,180));
 if(!s.server?.serial_number)s.component_errors.push('未取得服务器序列号');
 if(!(raw.volumes||[]).length)s.component_errors.push('未取得Windows卷信息');
 if(!s.physical_disks.length)s.component_errors.push('未取得物理硬盘信息');
 if(!s.virtual_disks.length)s.component_errors.push('未取得RAID虚拟盘信息');
 s.collection_status=!s.server?'failed':s.component_errors.length?'partial':'success';return s;
}
function createCollector(configPath=defaultConfig){return {
 host:()=>configuredHost(configPath),
 collect:()=>new Promise((resolve,reject)=>{
  if(process.platform!=='win32')return reject(Error('COLLECTOR_REQUIRES_WINDOWS'));
  execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',path.resolve(__dirname,'../../scripts/collect-it-device.ps1'),'-ConfigPath',configPath],{windowsHide:true,timeout:180000,maxBuffer:2*1024*1024,encoding:'utf8'},(error,stdout)=>{
   if(error)return reject(Error(error.killed?'COLLECTOR_TIMEOUT':'COLLECTOR_EXEC_FAILED'));
   try{resolve(normalize(JSON.parse(stdout.replace(/^\uFEFF/,''))));}catch(_){reject(Error('COLLECTOR_OUTPUT_INVALID'));}
  });
 })
};}
module.exports={createCollector,configuredHost,normalize,reportRows};
