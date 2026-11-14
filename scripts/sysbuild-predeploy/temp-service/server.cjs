'use strict';
const http=require('http'),fs=require('fs'),fsp=fs.promises,path=require('path'),crypto=require('crypto'),vm=require('vm');
const VERSION='0.8.0-readonly.2',MAX_FILE=20*1024*1024,MAX_BODY=160*1024*1024;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
function createEngine(html){
 const seed=html.match(/<script id="embedded-data" type="application\/json">([^]*?)<\/script>/)?.[1];
 let code=html.match(/<script id="app-code">([^]*?)<\/script>/)?.[1];
 if(!seed||!code)throw Error('Missing application source');
 const end=code.lastIndexOf('bootstrap();');if(end<0)throw Error('Missing bootstrap marker');code=code.slice(0,end);
 const context=vm.createContext({console,structuredClone,atob,btoa,crypto:crypto.webcrypto,location:{pathname:'/server-engine'},document:{body:{dataset:{}},querySelector:s=>({textContent:s==='#embedded-data'?seed:'',addEventListener(){}}),addEventListener(){}}});
 vm.runInContext(code,context,{timeout:10000});
 return vm.runInContext('({normalizeData,safeName,projectOverview,processStageMarkdown,stageScheduleText,validateScheduleTransition,embedded})',context);
}
function createStore(root,engine,options={}){
 const readOnly=options.readOnly===true;
 root=path.resolve(root);const INDEX='工作区索引.json';let chain=Promise.resolve(),cached=null;
 const serial=fn=>{const job=chain.then(fn);chain=job.catch(()=>{});return job;};
 async function safe(relative){
  if(typeof relative!=='string'||!relative||relative.includes('\\'))throw fail('资料路径无效');
  const parts=relative.split('/');if(parts.some(x=>!x||x==='.'||x==='..'||/[<>:"|?*\x00-\x1f]/.test(x)))throw fail('资料路径无效');
  const target=path.resolve(root,...parts);if(!target.startsWith(root+path.sep))throw fail('资料路径越界');
  let cursor=root;for(const component of [null,...parts]){if(component!==null)cursor=path.join(cursor,component);try{if((await fsp.lstat(cursor)).isSymbolicLink())throw fail('资料目录不能包含链接');}catch(e){if(e.code!=='ENOENT')throw e;}}
  return target;
 }
 async function readJSON(relative,optional=false){try{const file=await safe(relative);if((await fsp.stat(file)).size>50*1024*1024)throw fail('记录文件过大');return JSON.parse(await fsp.readFile(file,'utf8'));}catch(e){if(optional&&e.code==='ENOENT')return null;throw e;}}
 async function write(relative,value){const file=await safe(relative);await fsp.mkdir(path.dirname(file),{recursive:true});const temp=file+'.pending-'+crypto.randomUUID();let handle;try{handle=await fsp.open(temp,'wx');await handle.writeFile(value);await handle.sync();await handle.close();handle=null;await fsp.rename(temp,file);}catch(e){if(handle)await handle.close().catch(()=>{});await fsp.unlink(temp).catch(()=>{});throw e;}}
 async function immutable(relative,bytes){const file=await safe(relative);try{const previous=await fsp.readFile(file);if(!previous.equals(bytes))throw fail('已归档文件被外部修改，请核对后重试',409);return;}catch(e){if(e.code!=='ENOENT')throw e;}await write(relative,bytes);}
 const normalize=data=>{let n;try{n=engine.normalizeData(data);}catch(error){throw fail(error.message);}if(n.repaired.length)throw fail('阶段证据不一致，请重新读取并核验：'+n.repaired.join('；'),409);return n.data;};
 function validateManifest(m){if(!m||m.format!=='sysbuild-workspace'||![2,3,4].includes(m.schemaVersion)||typeof m.revision!=='string'||typeof m.workspaceId!=='string'||!Array.isArray(m.projects)||m.projects.length>100)throw fail('服务器工作区索引无效',500);const ids=new Set(),folders=new Set();for(const r of m.projects){if(typeof r.id!=='string'||ids.has(r.id)||folders.has(r.folder)||typeof r.folder!=='string'||!r.folder.startsWith('项目/')||r.folder.split('/').length!==2||typeof r.snapshot!=='string'||!r.snapshot.startsWith('版本记录/'))throw fail('服务器项目引用无效',500);ids.add(r.id);folders.add(r.folder);}if(m.deletedProjects!==undefined&&(!Array.isArray(m.deletedProjects)||m.deletedProjects.some(r=>!r||typeof r.projectId!=='string'||typeof r.deletionId!=='string'||typeof r.backupFolder!=='string')))throw fail('删除记录索引无效',500);}
 async function exists(relative){try{return await fsp.lstat(await safe(relative));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async function moveProject(source,destination){
  // Both paths are resolved and checked before moving a complete directory on Windows.
  const src=await safe(source),dst=await safe(destination),stat=await fsp.lstat(src);
  if(!stat.isDirectory()||stat.isSymbolicLink()||await exists(destination))throw fail('项目备份目录状态异常',409);
  await fsp.mkdir(path.dirname(dst),{recursive:true});await fsp.rename(src,dst);
 }
 async function recoverDeletes(){
  const disk=await readJSON(INDEX,true);if(!disk)return;validateManifest(disk);
  const base=await safe('删除备份');let dirs;try{dirs=await fsp.readdir(base,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const dir of dirs){
   if(!dir.isDirectory()||! /^[a-f0-9-]{36}$/.test(dir.name))continue;
   const receiptPath='删除备份/'+dir.name+'/删除记录.json',r=await readJSON(receiptPath,true);if(!r||r.status!=='prepared')continue;
   if(r.workspaceId!==disk.workspaceId||r.deletionId!==dir.name||r.backupFolder!=='删除备份/'+dir.name+'/项目文件'||typeof r.sourceFolder!=='string'||!r.sourceFolder.startsWith('项目/')||r.sourceFolder.split('/').length!==2)throw fail('未完成删除的恢复记录无效',500);
   const ref=disk.projects.find(p=>p.id===r.projectId),src=await exists(r.sourceFolder),backup=await exists(r.backupFolder);
   if(ref){
    if(ref.folder!==r.sourceFolder||src&&backup||!src&&!backup)throw fail('未完成删除存在目录冲突，需要管理员核对备份',500);
    if(!src&&backup)await moveProject(r.backupFolder,r.sourceFolder);
    r.status='aborted';r.recoveredAt=new Date().toISOString();
   }else{
    if(!backup||!disk.deletedProjects?.some(d=>d.deletionId===r.deletionId&&d.projectId===r.projectId))throw fail('删除备份与有效索引不一致',500);
    r.status='committed';r.recoveredAt=new Date().toISOString();
   }
   await write(receiptPath,JSON.stringify(r,null,2));cached=null;
  }
 }
 async function load(){
  const manifest=await readJSON(INDEX,true);if(!manifest)return null;validateManifest(manifest);const projects=[];let bytes=0;
  for(const ref of manifest.projects){
   const pkg=await readJSON(ref.folder+'/'+ref.snapshot);if(pkg.format!=='sysbuild-project'||![2,3,4].includes(pkg.schemaVersion)||pkg.projectId!==ref.id||pkg.project?.id!==ref.id)throw fail('项目快照与索引不一致',500);
   const p=pkg.project;
   for(const s of p.milestones)for(const r of s.checks)for(const a of r.attachments){
    if(typeof a.filePath!=='string'||!a.filePath.startsWith('附件/')||!Number.isInteger(a.size)||a.size<0||a.size>MAX_FILE||! /^[a-f0-9]{64}$/.test(a.sha256))throw fail('附件描述无效',500);
    bytes+=a.size;if(bytes>100*1024*1024)throw fail('当前附件合计超过 100 MB',500);
    const file=await safe(ref.folder+'/'+a.filePath);if((await fsp.stat(file)).size!==a.size)throw fail('附件原件大小校验失败',500);const buffer=await fsp.readFile(file);if(hash(buffer)!==a.sha256)throw fail('附件原件摘要校验失败',500);a.data='data:application/octet-stream;base64,'+buffer.toString('base64');
   }
   projects.push(p);
  }
  const data=normalize({schemaVersion:1,app:'sysbuild-local',revision:manifest.dataRevision||1,updatedAt:manifest.savedAt,projects,drafts:manifest.drafts||{}});
  return cached={manifest,data};
 }
 async function views(ref,p,pkg){
  await write(ref.folder+'/project.json',JSON.stringify(pkg,null,2));await write(ref.folder+'/项目概览.md',engine.projectOverview(p));
  for(let i=0;i<pkg.project.milestones.length;i++){
   const s=pkg.project.milestones[i],dir=ref.folder+'/阶段资料/'+engine.safeName(s.key+'_'+s.name,65);
   await write(dir+'/材料清单.md','# '+s.name+'\n\n'+engine.stageScheduleText(s)+'\n\n'+s.checks.map((r,j)=>(j+1)+'. '+r.name+'：'+(r.reviewed?'已核验':r.content?'草稿':'待补')).join('\n')+'\n');
   await write(dir+'/过程记录与收口.md',engine.processStageMarkdown(p.milestones[i]));
   for(let j=0;j<s.checks.length;j++){const r=s.checks[j];if(!r.content&&!r.attachments.length)continue;await write(dir+'/'+String(j+1).padStart(2,'0')+'_'+engine.safeName(r.name,50)+'.md','# '+r.name+'\n\n负责人：'+r.owner+'\n\n日期：'+r.date+'\n\n版本：'+r.version+'\n\n核验：'+(r.reviewed?'已核验':'草稿')+'\n\n原文位置：'+(r.location||'项目记录正文')+'\n\n'+r.content+'\n\n## 附件\n\n'+r.attachments.map(a=>a.originalName+'：'+a.filePath+'；SHA-256 '+a.sha256).join('\n'));}
   await write(dir+'/阶段确认.md','# 阶段确认\n\n状态：'+(s.completed?'已通过':'尚未通过')+'\n\n'+engine.stageScheduleText(s)+'\n\n结论：'+s.conclusion+'\n\n'+s.signatures.map(z=>z.role+'：'+z.name+'\n日期：'+z.date+'\n依据：'+z.evidence+'\n核验：'+(z.verified?'有效':'未核验')).join('\n\n'));
  }
 }
 async function persist(raw,expectedRevision,requestId){
  await recoverDeletes();
  const disk=await readJSON(INDEX,true);if(disk)validateManifest(disk);
  if((disk?.revision||null)!==expectedRevision)throw fail('服务器记录已被其他窗口更新，请重新读取后继续；本次未覆盖服务器数据。',409);
  const previous=disk?(cached?.manifest.revision===disk.revision?cached:await load()):null;
  const oldAttachments=new Map();for(const p of previous?.data.projects||[])for(const s of p.milestones)for(const r of s.checks)for(const a of r.attachments)oldAttachments.set(p.id+':'+a.id,a);
  if(!raw||!Array.isArray(raw.projects))throw fail('项目记录格式无效');
  if(previous?.data.projects.some(p=>!raw.projects.some(item=>item?.id===p.id)))throw fail('不能通过保存删除既有项目，请保留完整工作区记录');
  if(raw.projects.some(p=>disk?.deletedProjects?.some(d=>d.projectId===p?.id)))throw fail('此项目已整体删除，不能通过旧窗口重新写入，请重新读取服务器记录',409);
  for(const p of raw.projects)for(const s of p.milestones||[])for(const r of s.checks||[])for(const a of r.attachments||[]){if(a.data===undefined){const old=oldAttachments.get(p.id+':'+a.id);if(!old||old.size!==a.size||old.originalName!==a.originalName)throw fail('附件引用已失效，请重新读取服务器记录',409);a.data=old.data;}}
  const data=normalize(raw),revision=crypto.randomUUID(),savedAt=new Date().toISOString(),refs=[],mirrors=[],folders=new Set();
  try{engine.validateScheduleTransition(data,previous?.data);}catch(error){throw fail(error.message);}
  for(const p of data.projects){
   const old=disk?.projects.find(r=>r.id===p.id),folder=old?.folder||'项目/'+engine.safeName(p.systemName,38)+'__'+engine.safeName(p.id,40);
   if(folders.has(folder))throw fail('项目文件夹名称冲突');folders.add(folder);await safe(folder);
   if(!old&&await readJSON(folder+'/project.json',true))throw fail('目录中已有未登记项目，请管理员核对工作区索引',409);
   const stored={...p,milestones:[]};
   for(const s of p.milestones){const stage={...s,checks:[]};for(const r of s.checks){const record={...r,attachments:[]};for(const a of r.attachments){const bytes=Buffer.from(a.data.split(',')[1],'base64');if(bytes.length!==a.size||bytes.length>MAX_FILE)throw fail('附件大小无效');const sha256=hash(bytes),dot=a.originalName.lastIndexOf('.'),ext=dot>0?engine.safeName(a.originalName.slice(dot),12):'',base=engine.safeName(dot>0?a.originalName.slice(0,dot):a.originalName,45),filePath='附件/'+base+'__'+sha256.slice(0,20)+ext;await immutable(folder+'/'+filePath,bytes);const {data:ignored,...meta}=a;record.attachments.push({...meta,filePath,sha256});}stage.checks.push(record);}stored.milestones.push(stage);}
   const pkg={format:'sysbuild-project',schemaVersion:4,projectId:p.id,revision,savedAt,project:stored},ref={id:p.id,systemName:p.systemName,folder,snapshot:'版本记录/'+revision+'.json'};
   await immutable(folder+'/'+ref.snapshot,Buffer.from(JSON.stringify(pkg,null,2)));refs.push(ref);mirrors.push({ref,p,pkg});
  }
  const manifest={format:'sysbuild-workspace',schemaVersion:4,workspaceId:disk?.workspaceId||crypto.randomUUID(),revision,savedAt,dataRevision:data.revision,projects:refs,drafts:data.drafts||{},deletedProjects:disk?.deletedProjects||[],requestId};
  if(disk)await immutable('工作区历史/'+engine.safeName(disk.revision,80)+'.json',Buffer.from(JSON.stringify(disk,null,2)));
  // The manifest is the single commit point; readers and writers are serialized in this process.
  await write(INDEX,JSON.stringify(manifest,null,2));cached={manifest,data};let warning='';
  try{for(const row of mirrors)await views(row.ref,row.p,row.pkg);await write('工作目录说明.txt','此目录由项目经理临时服务维护。正式索引：工作区索引.json。\n项目记录、原始附件、阶段资料与版本快照均在项目子目录内。\n请完整备份工作目录；不要直接改写页面生成的文件。\n免登录内网试用，请由指定项目经理单独维护。\n');}catch(e){console.error('Project view write failed:',e.message);warning='有效版本已保存，但项目可阅读文件尚未整理完整，请重试保存后再交接。';}
  return {manifest,warning};
 }
 async function deleteProject(body){
  await recoverDeletes();const current=await load();if(!current)throw fail('工作区不存在',404);const disk=current.manifest;
  if(body.expectedRevision!==disk.revision)throw fail('服务器记录已被其他窗口更新，请重新读取后再删除。',409);
  const p=current.data.projects.find(p=>p.id===body.projectId),ref=disk.projects.find(p=>p.id===body.projectId);if(!p||!ref)throw fail('项目已不存在，请重新读取服务器记录',404);
  if(typeof body.confirmedName!=='string'||body.confirmedName!==p.systemName)throw fail('项目名称不一致，必须完整输入当前项目名称才能删除');
  const deletionId=crypto.randomUUID(),deletedAt=new Date().toISOString(),backupFolder='删除备份/'+deletionId+'/项目文件',receiptPath='删除备份/'+deletionId+'/删除记录.json';
  const identifiers=new Set([p.id,...p.milestones.flatMap(s=>[s.id,...s.checks.map(r=>r.id),...(s.processEntries||[]).map(e=>e.id)])]);
  const drafts=Object.fromEntries(Object.entries(disk.drafts||{}).filter(([key])=>!key.split(':').some(part=>identifiers.has(part))));
  const entry={deletionId,projectId:p.id,systemName:p.systemName,sourceFolder:ref.folder,backupFolder,deletedAt};
  const manifest={...disk,schemaVersion:4,revision:crypto.randomUUID(),savedAt:deletedAt,dataRevision:(disk.dataRevision||1)+1,projects:disk.projects.filter(r=>r.id!==p.id),drafts,deletedProjects:[...(disk.deletedProjects||[]),entry],requestId:body.requestId};
  const receipt={...entry,workspaceId:disk.workspaceId,sourceRevision:disk.revision,targetRevision:manifest.revision,confirmedName:body.confirmedName,pmName:p.pmName,deletedDrafts:Object.fromEntries(Object.entries(disk.drafts||{}).filter(([key])=>key.split(':').some(part=>identifiers.has(part)))),status:'prepared'};
  await immutable('工作区历史/'+engine.safeName(disk.revision,80)+'.json',Buffer.from(JSON.stringify(disk,null,2)));
  await write(receiptPath,JSON.stringify(receipt,null,2));
  await moveProject(ref.folder,backupFolder);cached=null;
  try{await write(INDEX,JSON.stringify(manifest,null,2));}
  catch(error){try{await moveProject(backupFolder,ref.folder);receipt.status='aborted';await write(receiptPath,JSON.stringify(receipt,null,2));}catch(recoveryError){console.error('Deletion rollback pending:',recoveryError.message);}throw error;}
  const data={...current.data,revision:manifest.dataRevision,updatedAt:deletedAt,projects:current.data.projects.filter(q=>q.id!==p.id),drafts};cached={manifest,data};
  let warning='';try{receipt.status='committed';await write(receiptPath,JSON.stringify(receipt,null,2));}catch(error){console.error('Deletion receipt pending:',error.message);warning='项目已删除且完整备份已保留，删除记录将在下次读取时补齐。';}
  return {manifest,data,storagePath:root,deleted:entry,backupPath:path.join(root,...backupFolder.split('/')),warning};
 }
 const assertWritable=()=>{if(readOnly)throw fail('已切换到平台，只读；不能保存、上传、替换或删除。',403);};
 return {root,serial,async init(){
  if(readOnly)return serial(async()=>{await safe(INDEX);if(!await load())throw Error('Readonly mode requires an existing indexed workspace');});
  await fsp.mkdir(root,{recursive:true});await safe(INDEX);return serial(async()=>{await recoverDeletes();const loaded=await load();if(loaded)return;const entries=await fsp.readdir(root);if(entries.length)throw Error('Unindexed data directory is not empty; initialization refused');await persist(structuredClone(engine.embedded),null,crypto.randomUUID());});
 },read:()=>serial(async()=>{if(!readOnly)await recoverDeletes();return load();}),save:body=>serial(()=>{assertWritable();return persist(body.data,body.expectedRevision,body.requestId);}),deleteProject:body=>serial(()=>{assertWritable();return deleteProject(body);})};
}
function serverHTML(source,bridge,readOnly=false){
 let html=source.replace("connect-src 'none'","connect-src 'self'").replaceAll('本地离线版','服务器保存版').replaceAll('本地免登录版','内网免登录版').replace('正式记录与附件直接保存到项目文件夹。首次使用请连接工作目录。','记录和附件保存在服务器项目目录。打开页面自动连接。');
 const marker='bootstrap();\n</script>';if(!html.includes(marker))throw Error('Bootstrap insertion marker missing');
 if(readOnly)html=html.replace('<body>','<body data-readonly="true"><div id="serverReadOnlyBanner" role="status" style="padding:12px 20px;background:#fff3dd;color:#704300;font-weight:bold">已切换到平台，只读。此页保留查看与下载，登记和附件维护请进入平台。</div>');
 return html.replace(marker,'// SERVER STORAGE ADAPTER\n'+bridge+'\nbootstrap();\n</script>');
}
async function createService(options={}){
 const envReadOnly=process.env.SYSBUILD_READ_ONLY;
 if(options.readOnly!==undefined&&typeof options.readOnly!=='boolean'||options.readOnly===undefined&&envReadOnly!==undefined&&!['0','1'].includes(envReadOnly))throw Error('SYSBUILD_READ_ONLY must be 0 or 1');
 const readOnly=options.readOnly===undefined?envReadOnly!=='0':options.readOnly;
 const appDir=options.appDir||__dirname,root=options.dataDir||process.env.SYSBUILD_DATA_DIR||'E:/sysbuild-pm-data';
 const source=await fsp.readFile(path.join(appDir,'offline.html'),'utf8'),engine=createEngine(source),store=createStore(root,engine,{readOnly});await store.init();
 const html=serverHTML(source,await fsp.readFile(path.join(appDir,'server-client.js'),'utf8'),readOnly);
 const originConfigured=options.publicOrigin||process.env.SYSBUILD_PUBLIC_ORIGIN;const server=http.createServer(async(req,res)=>{
  const port=server.address()?.port,allowedHosts=new Set(['127.0.0.1:'+port,'localhost:'+port,...(originConfigured?[new URL(originConfigured).hostname+':'+port]:[])]);
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
  try{
   if(!allowedHosts.has(req.headers.host))throw fail('访问地址未配置',403);
   const url=new URL(req.url,'http://'+req.headers.host);
   if(readOnly&&!['GET','HEAD','OPTIONS'].includes(req.method)){req.resume();throw fail('已切换到平台，只读；不能保存、上传、替换或删除。',403);}
   if(req.method==='GET'&&url.pathname==='/health')return send(200,{status:'ok',version:VERSION,storage:'server',readOnly});
   if(req.method==='GET'&&(url.pathname==='/'||url.pathname==='/index.html')){res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
   if(req.method==='GET'&&url.pathname==='/api/workspace'){const value=await store.read();return send(200,{...value,storagePath:store.root,version:VERSION,readOnly});}
   if(req.method==='GET'&&url.pathname==='/api/archive-proof'){
    if(!readOnly)throw fail('尚未开启只读，不能生成最终存档核对记录',409);
    const value=await store.read();return send(200,{readOnly:true,workspaceId:value.manifest.workspaceId,revision:value.manifest.revision,capturedAt:new Date().toISOString(),dataDir:await fsp.realpath(store.root),port:server.address().port,serviceVersion:VERSION});
   }
   if(req.method==='POST'&&['/api/workspace','/api/projects/delete'].includes(url.pathname)){
    if(req.headers.origin!=='http://'+req.headers.host||req.headers['x-sysbuild-request']!=='1'||req.headers['sec-fetch-site']==='cross-site')throw fail('保存请求来源无效',403);
    if(!String(req.headers['content-type']||'').startsWith('application/json'))throw fail('请求格式必须为 JSON',415);
    const maxBody=url.pathname==='/api/projects/delete'?4096:MAX_BODY;
    if(Number(req.headers['content-length'])>maxBody)throw fail('保存内容过大',413);
    const chunks=[];let count=0;for await(const chunk of req){count+=chunk.length;if(count>maxBody)throw fail('保存内容过大',413);chunks.push(chunk);}
    let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(_){throw fail('保存内容不是有效 JSON');}
    if(!body||typeof body.requestId!=='string'||! /^[a-zA-Z0-9_-]{8,100}$/.test(body.requestId)||!(body.expectedRevision===null||typeof body.expectedRevision==='string'))throw fail('保存版本信息无效');
    if(url.pathname==='/api/projects/delete'){if(typeof body.projectId!=='string'||body.projectId.length>100||typeof body.confirmedName!=='string'||body.confirmedName.length>50)throw fail('删除确认信息无效');return send(200,await store.deleteProject(body));}
    return send(200,await store.save(body));
   }
   throw fail('未找到页面',404);
  }catch(error){if(error.status!==409)console.error('Request failed:',error.message);if(!res.headersSent)send(error.status||500,{message:error.status?error.message:'服务器保存或读取失败，请联系管理员核对目录和磁盘。'});else res.end();}
 });
 server.requestTimeout=240000;server.headersTimeout=30000;
 return {server,store,engine,async listen(port=Number(process.env.PORT||3002),host=process.env.HOST||'0.0.0.0'){await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});return server.address();},async close(){await new Promise(r=>server.close(r));}};
}
if(require.main===module)createService().then(async service=>{const address=await service.listen();console.log(JSON.stringify({service:'sysbuild-pm-temp',version:VERSION,port:address.port,dataDir:service.store.root}));for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>service.close().then(()=>process.exit(0)));}).catch(error=>{console.error(error);process.exit(1);});
module.exports={createService,createEngine,createStore,serverHTML,VERSION};
