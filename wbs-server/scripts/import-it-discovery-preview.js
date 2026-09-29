/* Explicit local maintenance import: real ledger routes, existing administrator audit identity.
 * Never connects to a production API and never manufactures a platform JWT.
 */
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process'),express=require('express'),sqlite3=require('sqlite3');
async function main(){
 // MED-4（C7-c，Opus预筛，方案v0.6§7"v0.6追加退役"段）：--capture此前在脚本快结束时（登记完两台
 // 主机与15块硬盘、写完备份之后）才检测，调用的POST /inspections是单独设备巡检标准采集入口——那条
 // 路由随巡检台账改版整体退役，现在会直接404，脚本半途崩溃在"资产已经登记完，报告文件还没写出"这个
 // 尴尬状态。改成脚本最开头、任何资产登记发生之前就检测到--capture直接报错退出，不给这种半成功状态
 // 任何出现的机会。采集现在只能在巡检台账的巡检单内进行（建一张单、把这台服务器纳入范围、在检查项行
 // 点"一键采集"），本脚本不再提供快捷方式。
 if(process.argv.includes('--capture'))throw Error('采集已改在巡检台账的巡检单内进行，本脚本不再支持 --capture');
 // This script ships with deploys (git reset --hard on the production host), so the target database is never implied.
 const dbAt=process.argv.indexOf('--db'),dbArg=dbAt>0?process.argv[dbAt+1]:'';
 if(!dbArg||dbArg.startsWith('--'))throw Error('Specify the local database explicitly: --db <path-to-local-task_pool.db>');
 const root=path.resolve(__dirname,'../..'),dbFile=path.resolve(dbArg),source=path.join(root,'tmp/it-server-discovery');
 // Resolve junctions/symlinks (and mapped drives, which resolve to UNC) before judging; remote (UNC) targets are never local.
 let real=dbFile;try{const exists=fs.existsSync(dbFile);real=fs.realpathSync.native(exists?dbFile:path.dirname(dbFile));if(!exists)real=path.join(real,path.basename(dbFile));}catch(_){if(process.argv.includes('--apply-local-demo'))throw Error('Cannot resolve the real path of '+dbFile+'; refusing to write');}
 const productionLike=p=>/^[a-z]:[\\/]task_pool([\\/]|$)/i.test(p),remote=p=>/^[\\/]{2}/.test(p);
 if(process.env.NODE_ENV==='production'||remote(dbArg)||remote(real)||productionLike(dbFile)||productionLike(real))throw Error('Refusing database '+dbFile+(real!==dbFile?' (resolves to '+real+')':'')+': this tool only registers demonstration positions in a local development database');
 const inventory=JSON.parse(fs.readFileSync(path.join(source,'physical-inventory.json'),'utf8').replace(/^\uFEFF/,'')),hardware=JSON.parse(fs.readFileSync(path.join(source,'192.168.1.5-hardware.json'),'utf8').replace(/^\uFEFF/,''));
 if(inventory.physical_disks.length!==15||new Set(inventory.physical_disks.map(d=>d.serial_number)).size!==15)throw Error('Expected 15 unique discovered physical disks');
 if(!process.argv.includes('--apply-local-demo')){console.log('DRY RUN: local database '+dbFile+'; 2 hosts + 15 disks, simulated positions. Use --apply-local-demo to register.');return;}
 const db=new sqlite3.Database(dbFile,sqlite3.OPEN_READONLY);const all=(sql,args=[])=>new Promise((resolve,reject)=>db.all(sql,args,(e,r)=>e?reject(e):resolve(r)));
 const admins=await all("SELECT id,username,display_name,role FROM users WHERE role='admin' AND status='active'");if(admins.length!==1)throw Error('Local audit administrator must be unambiguous');const actor=admins[0];
 await new Promise((resolve,reject)=>db.close(e=>e?reject(e):resolve()));
 const backup=path.join(source,'local-before-discovery-'+Date.now()+'.db');
 const b=spawnSync('python',['-c',"import sqlite3,sys,pathlib; s=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True); d=sqlite3.connect(sys.argv[2]); s.backup(d); d.close(); s.close()",dbFile,backup],{encoding:'utf8',windowsHide:true});if(b.status!==0)throw Error('Local database backup failed');
 const token=crypto.randomBytes(32).toString('hex'),app=express();app.use(express.json());
 const auth=(req,res,next)=>{if(req.headers.authorization!=='Bearer '+token)return res.sendStatus(401);req.user=actor;next();};
 const ledger=require('../routes/it-ledger')({DB_FILE:dbFile,logger:{info(){},warn(){},error(){console.error('Local ledger reported an error');}},authenticateToken:auth,requireAdmin:(req,res,next)=>req.user.role==='admin'?next():res.sendStatus(403)});
 await ledger.initSchema();app.use('/api',ledger.router);let server;
 try{
  server=await listenOnSafePort(app);const base='http://127.0.0.1:'+server.address().port+'/api/it-assets';
  async function api(method,endpoint,body){const r=await fetch(base+endpoint,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();if(!r.ok)throw Error(method+' '+endpoint+' '+r.status+' '+JSON.stringify(value));return value;}
  const before=(await api('GET','')).items,created=[],reused=[];const rackName='演示机柜 · 位置未核实';let rack=(await api('GET','/racks')).items.find(r=>r.name===rackName);
  if(!rack)rack=await api('POST','/racks',{name:rackName,room:'演示机房（非实测位置）',u_total:42,note:'用户授权随机设置，仅用于观察界面。不得作为真实机柜位置依据。'});
  const start=crypto.randomInt(2,9),stamp=inventory.collected_at;
  async function register(body){const existing=before.find(a=>a.sn===body.sn);if(existing){if(existing.category!==body.category)throw Error('Existing serial has a different category; refusing overwrite');reused.push({id:existing.id,sn:existing.sn});return existing;}const a=await api('POST','',body);created.push({id:a.id,sn:a.sn,name:body.name});return a;}
  const r710=await register({category:'server',name:hardware.system.Name,brand:hardware.system.Manufacturer,model:hardware.system.Model,sn:hardware.bios.SerialNumber,u_height:2,slot_count:6,attrs:{ip:inventory.target,os:hardware.os.Caption.trim(),purpose:'采集登记 · 实际用途待确认'},note:`真实硬件采集于${stamp}。CPU：2×Xeon E5645（12核24线程）；内存条合计96GiB。机柜/U位/U高度为用户授权的演示值，未现场核实。源槽0起，台账盘位=源槽+1。`,placement:{kind:'rack',rack_id:rack.id,u_start:start}});
  const md=await register({category:'other',name:'MD1200 外置磁盘柜',brand:'Dell',model:'PowerVault MD1200',sn:'HKB6C3X',u_height:2,slot_count:12,attrs:{subtype:'storage'},note:`真实磁盘柜采集于${stamp}，通过${inventory.target}的PERC H800连接。机柜/U位/U高度为演示值，未现场核实。源槽0起，台账盘位=源槽+1。存在阵列降级，详情见设备巡检。`,placement:{kind:'rack',rack_id:rack.id,u_start:start+5}});
  for(const disk of inventory.physical_disks){
   const owner=disk.controller_id===0?r710:md,current=(await api('GET','/'+owner.id)).asset;
   const attention=disk.reported_state==='Failed'||disk.failure_predicted;
   await register({category:'disk',name:`${attention?'【采集告警】':''}${disk.controller_id===0?'R710':'MD1200'} 硬盘 · 源槽${disk.source_slot_zero_based}`,brand:disk.model.startsWith('ST')?'Seagate':disk.model.startsWith('HUS')?'HGST':'待核实',model:disk.model,sn:disk.serial_number,attrs:{capacity:(disk.capacity_bytes/1e12).toFixed(3)+' TB（'+disk.capacity_bytes+'字节）',interface:disk.protocol},note:`采集时间${stamp}；控制器${disk.controller_id}，源ID ${disk.source_disk_id}，源槽${disk.source_slot_zero_based}→台账盘位${disk.source_slot_zero_based+1}。健康${disk.reported_state}/${disk.reported_status}，预测故障${disk.failure_predicted?'是':'否'}。在用仅表示仍装载，不代表健康；最新健康以巡检快照为准。`,placement:{kind:'host',parent_asset_id:owner.id,slot_no:disk.source_slot_zero_based+1},peer_versions:{[owner.id]:current.version}});
  }
  const report={database:dbFile,backup,audit_operator:{id:actor.id,username:actor.username},rack_id:rack.id,demonstration_positions:true,created,reused,server_id:r710.id,enclosure_id:md.id};
  fs.writeFileSync(path.join(source,'local-registration.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
 }finally{if(server)await new Promise(resolve=>server.close(resolve));await ledger.shutdown();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
