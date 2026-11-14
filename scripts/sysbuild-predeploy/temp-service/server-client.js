// Same business workflow as the offline page, with revision-checked server persistence.
let remoteAttachmentData=new Map(),serverStoragePath='',remoteLoading=false;
async function remoteCall(method,body,endpoint='/api/workspace'){
 if(READONLY&&!['GET','HEAD','OPTIONS'].includes(method))throw Error('已切换到平台，只读；不能保存、上传、替换或删除。');
 const response=await fetch(endpoint,{method,cache:'no-store',headers:body?{'Content-Type':'application/json','X-Sysbuild-Request':'1'}:{},body:body?JSON.stringify(body,(key,value)=>key==='attachments'&&Array.isArray(value)?value.map(a=>{if(remoteAttachmentData.get(a.id)===a.data){const{data,...meta}=a;return meta;}return a;}):value):undefined});
 let result;try{result=await response.json();}catch(_){throw Error('服务器响应不完整，请重新读取记录后核对保存结果。');}
 if(!response.ok)throw Error(result.message||'服务器暂不可用');return result;
}
function rememberRemoteAttachments(data){
 const entries=data.projects.flatMap(p=>p.milestones.flatMap(s=>s.checks.flatMap(r=>r.attachments.map(a=>[a.id,a.data]))));
 remoteAttachmentData=new Map(entries);
}
async function cacheRecovery(){/* The server is authoritative; no automatic merge of another browser's cached state. */}
async function saveWorkspace(snapshot){
 if(READONLY)throw Error('已切换到平台，只读；不能保存记录或附件。');
 if(!folderReady)throw Error('尚未连接服务器');
 let result;try{result=await remoteCall('POST',{expectedRevision:workspaceManifest?.revision||null,requestId:id(),data:snapshot});}catch(error){if(error instanceof TypeError)throw Error('网络中断，保存结果未确认。请保留填写内容，重新读取服务器记录核对后再继续。');throw error;}
 workspaceManifest=result.manifest;folderWarning=result.warning||'';rememberRemoteAttachments(snapshot);return workspaceManifest;
}
function updateAttachmentLocation(){
 const row=$('#attachmentLocation'),value=$('#attachmentLocationValue');if(!row||!value)return;
 const ref=workspaceManifest?.projects.find(r=>r.id===selected);
 value.textContent=ref&&folderReady?serverStoragePath.replace(/[\\/]$/,'')+'/'+ref.folder+'/附件':folderReady?'当前没有项目，新建后显示附件位置。':'正在连接服务器项目目录…';
 row.classList.toggle('not-connected',!folderReady);row.title='附件保存在服务器；换电脑访问同一地址可继续使用。';
}
function updateSaveState(){
 const create=$('#newProject');if(create&&READONLY){create.hidden=true;create.disabled=true;}
 updateAttachmentLocation();const n=$('#saveState');n.classList.toggle('negative',!!folderError);
 n.textContent=remoteLoading?'正在读取服务器记录…':folderError?'保存／连接异常：'+folderError:READONLY?'已切换到平台，只读；可查看记录与下载附件。':actionSaving||cacheBusy?'正在保存到服务器，请稍候…':folderWarning||(folderReady?'已保存到服务器：'+serverStoragePath:'服务器尚未连接');
 n.title='正式记录和附件保存在服务器项目目录。';const choose=$('#chooseFolderButton');if(choose){choose.textContent='重新读取服务器记录';choose.disabled=remoteLoading||actionSaving;}
 const retry=$('#retrySaveButton');if(retry)retry.hidden=READONLY||!(folderError||folderWarning)||!folderReady;
}
async function loadRemoteWorkspace(){
 if(actionSaving||remoteLoading)return;remoteLoading=true;clearTimeout(draftTimer);updateSaveState();
 try{
  await diskQueue;const loaded=await remoteCall('GET'),normalized=normalizeData(loaded.data);if(normalized.repaired.length)throw Error('服务器阶段证据需要核验，请联系管理员。');
  const previous=selected;state=normalized.data;workspaceManifest=loaded.manifest;serverStoragePath=loaded.storagePath;folderHandle={name:serverStoragePath};folderReady=true;folderError='';folderWarning='';draftPending=false;cacheBusy=false;rememberRemoteAttachments(state);
  selected=state.projects.some(p=>p.id===previous)?previous:(state.projects[0]?.id||'');activeStage=project()?Math.min(frontier(project()),project().milestones.length-1):0;activeTab='flow';
 }catch(error){folderError=error.message;if(!workspaceManifest)folderReady=false;}
 finally{remoteLoading=false;render();$('#helpButton').disabled=false;$('#retrySaveButton').disabled=false;}
}
async function chooseWorkspace(){
 if(actionSaving||remoteLoading)return;
 if(folderReady){modalKey=null;openModal('重新读取服务器记录',el('p',{},'将读取服务器的最新记录。尚未保存成功的本窗口内容可能被替换；如刚遇到网络中断，请先记下未提交内容，重读后核对是否已保存。'),loadRemoteWorkspace,{saveText:'读取服务器最新记录'});}
 else await loadRemoteWorkspace();
}
async function bootstrap(){
 if(typeof ResizeObserver==='function')new ResizeObserver(entries=>document.documentElement.style.setProperty('--topbar-height',entries[0].target.getBoundingClientRect().height+'px')).observe($('.topbar'));
 state=normalizeData(clone(embedded)).data;selected=state.projects[0].id;folderReady=false;activeStage=Math.min(frontier(project()),project().milestones.length-1);render();await loadRemoteWorkspace();
}
function showProjectLocation(){
 modalKey=null;const ref=workspaceManifest?.projects.find(r=>r.id===selected);
 openModal('服务器项目文件位置',el('div',{},el('p',{},ref?serverStoragePath+'/'+ref.folder:'尚未连接服务器'),el('pre',{},'project.json\n项目概览.md\n附件/\n阶段资料/（含过程记录与收口）\n版本记录/'),el('p',{class:'modal-note'},'服务器统一保存。备份或未来接入平台时，由管理员复制完整工作目录或项目文件夹。')),null);
}
function renderEmptyWorkspace(){
 selected='';activeStage=0;$('#projectList').replaceChildren();$('#newProject').hidden=READONLY;$('#newProject').disabled=!folderReady||actionSaving;
 $('#main').replaceChildren(section('暂无项目','可以建立新的项目；已删除项目不会自动重新出现。',el('div',{},el('p',{class:'muted'},'项目删除备份由管理员保管，页面不自动恢复。'),button('建立第一个项目',newProjectForm,'primary',READONLY||!folderReady||actionSaving))));updateSaveState();
}
function deleteCurrentProject(){
 const p=project();if(!p||READONLY||!folderReady||actionSaving)return;const projectId=p.id,projectName=p.systemName;
 modalKey=null;const body=el('div',{},el('div',{class:'inline-banner'},'将整体删除当前项目的记录、附件、过程调整和历史版本，并从项目列表移除。服务器会保留完整删除备份，恢复需联系管理员。'),el('p',{},'请输入完整项目名称：'),el('pre',{},projectName),field('确认项目名称','confirmedName','','text','必须与上方名称完全一致，空格也需一致。',{required:true,max:50}));
 openModal('整体删除项目',body,async fd=>{
  const confirmedName=fd.get('confirmedName');if(confirmedName!==projectName)throw Error('项目名称不一致，尚未删除');
  setActionBusy(true);clearTimeout(draftTimer);
  try{await queueDisk(async()=>{
   if(draftPending){await saveWorkspace(clone(state));draftPending=false;cacheBusy=false;}
   const result=await remoteCall('POST',{projectId,confirmedName,expectedRevision:workspaceManifest.revision,requestId:id()},'/api/projects/delete');
   const normalized=normalizeData(result.data);if(normalized.repaired.length)throw Error('服务器已处理删除，请重新读取后核对阶段记录。');
   state=normalized.data;workspaceManifest=result.manifest;folderWarning=result.warning||'';folderError='';draftPending=false;cacheBusy=false;rememberRemoteAttachments(state);
   selected=state.projects[0]?.id||'';activeStage=project()?Math.min(frontier(project()),project().milestones.length-1):0;activeTab='flow';render();
   toast('项目已整体删除；完整备份保存在：'+result.backupPath);
  });}catch(error){folderError=error instanceof TypeError?'网络中断，删除结果尚未确认，请重新读取服务器记录核对。':error.message;updateSaveState();throw Error(folderError);}finally{setActionBusy(false);}
 },{saveText:'确认整体删除',cancelText:'取消'});
 const input=$('#modalForm [name=confirmedName]'),save=$('#modalSave');input.setAttribute('autocomplete','off');input.setAttribute('spellcheck','false');save.className='danger';save.disabled=true;
 input.addEventListener('input',()=>{save.disabled=input.value!==projectName;});input.focus();
}
function showHelp(){
 modalKey=null;openModal('项目经理临时网页使用说明',el('div',{},[
  ['打开即用',READONLY?'已切换到平台，只读。此页用于核对原记录与下载原附件，不再接受登记与维护。':'内网临时试用，无需登录；请由指定项目经理维护。能访问此地址的人可查看和修改同一工作区。'],
  ['服务器保存','项目记录和原始附件统一保存到 '+serverStoragePath+'。无需选择本机文件夹；换电脑访问同一地址即可继续。原先离线页面中的个人项目不会自动上传。'],
  ['过程先记、阶段再定稿','各阶段直接添加过程记录，明确处理结果，采纳项关联正式材料。需求阶段有采纳项时，在需求确认包上传最终文档，核对收口后再完成阶段门。'],
  ['阶段开始日期','阶段日期区域的节点计划可填写计划开始和完成日期，未来阶段也可预排。当前阶段由 PM 登记实际开始，不自动填入上一阶段完成日期。历史已完成阶段缺失开始日期时可补录，须说明依据；已有日期要修订则先重新打开阶段。'],
  ['保存与附件','单个附件 20 MB，每份材料 10 个，全部项目当前附件合计 100 MB。选中文件后须点击保存记录，看到已保存到服务器再离开。'],
  ['多窗口与网络异常','其他窗口已更新时会拒绝覆盖。先记下本窗口未提交内容，再点击重新读取服务器记录核对最新状态；不要同时由多人维护。网络中断时先核对服务器是否已经保存，避免重复登记。'],
  ['项目文件夹','每个项目自动形成记录、原件、阶段资料和历史快照，顶部显示当前项目附件的服务器位置。管理员可直接备份目录，供后续平台接入。'],
  ['整体删除项目','项目标题右侧的删除项目入口要求完整输入当前项目名称。服务器复核名称及最新版本后，将整份项目目录移入删除备份并移出列表；最后一个项目也可删除，旧窗口不能把已删除项目重新写回。恢复需管理员核对备份。'],
  ['冻结与变更','后续阶段仍按顺序解锁，未确认事项阻止过门。已完成阶段只读；涉及冻结内容的调整登记正式变更，重新核验相关阶段。']
 ].map(([title,body])=>el('div',{class:'quick-help'},el('h3',{},title),el('p',{},body)))),null);
}
