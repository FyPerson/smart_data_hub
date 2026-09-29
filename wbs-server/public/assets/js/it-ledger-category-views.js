/* C10 terminals/places/software: all position and lifecycle changes use C5 actions. */
(function(){
  'use strict';
  const L=window.ITLedger,{$,esc}=L;
  const isTerminal=a=>['laptop','desktop'].includes(a.category),isPlace=a=>a.category==='other'&&a.u_height===0;
  const isSoftware=a=>['software','subscription'].includes(a.category);
  let expiryOnly=new URLSearchParams(window.location.search).get('expiry')==='90';
  const expiryClasses={expired:'sem-failed',soon30:'sem-failed',soon60:'sem-prerelease',soon90:'sem-hold',normal:'sem-done',unset:'sem-intake',cancelled:'sem-voided'};
  function serverToday(){
    if(!Number.isFinite(L.state.serverTime))return null;
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(L.state.serverTime));
    const values=Object.fromEntries(parts.map(p=>[p.type,p.value]));return `${values.year}-${values.month}-${values.day}`;
  }
  function expiry(a){
    if(a.status==='cancelled')return {tier:'cancelled',label:'已停用',days:null};
    if(!a.expires_at)return {tier:'unset',label:'未设置到期',days:null};
    const today=serverToday();if(!today)return {tier:'unset',label:'等待服务器日期',days:null};
    const days=(Date.parse(a.expires_at+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000;
    const tier=days<0?'expired':days<=30?'soon30':days<=60?'soon60':days<=90?'soon90':'normal';
    return {tier,days,label:days<0?`已过期 ${-days} 天`:days===0?'今天到期':`${days} 天后到期`};
  }
  function actionButton(key,label,a){if(isSoftware(a)&&a.status==='cancelled')return '<span class="itl-muted">已停用</span>';return `<button type="button" class="u-btn-secondary itl-btn-sm" data-action="${key}" data-id="${a.id}">${label}</button>`;}
  function allowedActions(a){
    const list=[];
    if(isTerminal(a)){
      if(a.status==='in_depot')list.push({key:'assign',label:'领用'});
      if(a.status==='in_service')list.push({key:'reassign',label:'换保管人'},{key:'relocate',label:'移位置'},{key:'return',label:'归还'});
    }
    if(isPlace(a)){
      if(a.status==='in_depot')list.push({key:'place',label:'投入使用'});
      if(a.status==='in_service')list.push({key:'relocate',label:'移位置'},{key:'return',label:'归还'});
    }
    if(isSoftware(a)&&a.status==='active')list.push({key:'renew',label:'续费'},{key:'cancel',label:'停用'});
    return list;
  }
  function terminals(){
    const items=L.state.assets.filter(a=>(isTerminal(a)||isPlace(a))&&a.status!=='retired');const groups=new Map();
    for(const a of items){const key=isTerminal(a)?`保管人 · ${a.status==='in_service'?(a.custodian_name||'用户 #'+a.custodian_user_id):L.statuses[a.status]}`:`位置 · ${a.status==='in_service'?a.location_text:L.statuses[a.status]}`;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);}
    $('#itlContent').innerHTML=`<p class="itl-muted">终端按保管人分组；非机柜设备按位置分组。报废记录可在“全部”查阅。</p><div class="itl-terminal-groups">${[...groups].map(([name,assets])=>`<section class="itl-terminal-group"><h2>${esc(name)} <small>${assets.length}</small></h2><div class="itl-card-grid">${assets.map(a=>L.assetCard(a,{rows:[['型号',[a.brand,a.model].filter(Boolean).join(' ')],['SN',a.sn],[isTerminal(a)&&a.status==='in_service'?'保管人':'位置',L.location(a)]]})).join('')}</div></section>`).join('')||'<div class="itl-empty">暂无终端或非机柜设备，可使用“登记设备”新增。</div>'}</div>`;
  }
  function software(){
    const all=L.state.assets.filter(isSoftware),states=all.map(a=>({a,...expiry(a)}));
    const counts=[states.filter(x=>['expired','soon30'].includes(x.tier)).length,states.filter(x=>x.tier==='soon60').length,states.filter(x=>x.tier==='soon90').length,all.filter(a=>a.status==='active').length];
    const labels=['已过期 / 30 天内','31–60 天','61–90 天',`在用条目 · ${states.filter(x=>x.tier==='unset').length} 条未设到期`];
    const list=all.filter(a=>!expiryOnly||(a.status==='active'&&expiry(a).days!==null&&expiry(a).days<=90)).sort((a,b)=>a.expires_at===b.expires_at?a.id-b.id:a.expires_at===null?1:b.expires_at===null?-1:a.expires_at.localeCompare(b.expires_at));
    $('#itlContent').innerHTML=`<div class="u-stats-row itl-expiry-cards">${counts.map((n,i)=>`<div class="u-stat-card static"><div class="u-stat-num">${n}</div><div class="u-stat-label"><i class="itl-expiry-dot itl-expiry-${['red','orange','yellow','neutral'][i]}"></i>${labels[i]}</div></div>`).join('')}</div><div class="itl-toolbar"><label><input id="itlExpiryOnly" type="checkbox"${expiryOnly?' checked':''}> 只看 90 天内到期（含已过期）</label><span class="itl-muted">服务器基准日 ${esc(serverToday()||'未取得')} · 当天到期仍有效</span><button type="button" class="u-btn-secondary" id="itlAddSoftware"${L.canWrite()?'':' hidden'}>＋ 登记软件 / 订阅</button></div><div class="u-corr-table-wrap"><table class="u-corr-table" id="itlSoftwareTable"><thead><tr><th>名称</th><th>类别</th><th>账号 / 版本 / 许可</th><th>到期日</th><th>显示状态</th>${L.isAdmin()?'<th>供应商</th>':''}<th>操作</th></tr></thead><tbody>${list.map(a=>{const s=expiry(a);const info=a.category==='subscription'?[a.attrs?.account_name,a.attrs?.cycle]:[a.attrs?.version,a.attrs?.license_count,a.attrs?.installed_on];return `<tr data-software-id="${a.id}"><td>${L.assetButton(a)}</td><td>${L.type(a.category)}</td><td>${esc(info.filter(v=>v!==null&&v!==undefined&&v!=='').map(v=>typeof v==='object'?JSON.stringify(v):String(v)).join(' · ')||'—')}</td><td>${esc(a.expires_at||'未设置')}</td><td>${UnifyHelpers.statusBadgeByMap(s.tier,expiryClasses,s.label)}</td>${L.isAdmin()?`<td>${esc(a.fin_vendor||'—')}</td>`:''}<td><div class="itl-software-actions">${L.canWrite()?`${a.status==='active'?actionButton('renew','续费',a):''}${actionButton('edit','编辑',a)}${a.status==='active'?actionButton('cancel','停用',a):''}`:'只读'}</div></td></tr>`;}).join('')||`<tr><td colspan="${L.isAdmin()?7:6}" class="itl-empty">暂无符合条件的软件或订阅</td></tr>`}</tbody></table></div>`;
    $('#itlExpiryOnly').addEventListener('change',e=>{expiryOnly=e.target.checked;software();});$('#itlAddSoftware').addEventListener('click',()=>L.openAssetForm(null,{category:'subscription',u_height:0}));
  }
  async function singleAction(key,a){
    if(!['assign','reassign','return','place','relocate','renew','cancel'].includes(key))return false;if(!L.canWrite())return true;
    const names={assign:'领用',reassign:'更换保管人',return:a.category==='ap'?'拆下 AP':'归还',place:'投入使用',relocate:'移位置',renew:'续费',cancel:'停用'};let html=`<p>${esc(a.name)}</p>`;
    if(key==='assign'||key==='reassign')html+=L.formField('custodian_name','保管人姓名',key==='reassign'?a.custodian_name:'',{required:true});
    if(['assign','place','relocate'].includes(key))html+=L.formField('location_text',key==='assign'?'位置（可选）':'位置',a.location_text,{required:key!=='assign'});
    if(key==='return')html+=L.formField('to','去向','in_depot',{choices:['in_depot','faulty','to_retire'].map(s=>[s,L.statuses[s]])});
    if(key==='renew')html+=`<p>当前到期：${esc(a.expires_at||'未设置')}。${a.expires_at?'新日期须严格晚于当前日期。':'可填写任意合法日期。'}</p>`+L.formField('expires_at','新到期日期','',{type:'date',required:true});
    if(key==='cancel')html+='<p>停用后不再计入到期提醒，资料和历史仍可查阅。</p>';
    L.openModal(names[key],html,async form=>{
      const body={};for(const name of ['custodian_name','location_text','to','expires_at'])if(form.elements.namedItem(name))body[name]=form.elements.namedItem(name).value.trim()||null;
      if(['assign','reassign'].includes(key)&&!body.custodian_name)throw Object.assign(new Error('请填写保管人姓名。'),{field:'custodian_name'});
      if(['place','relocate'].includes(key)&&!body.location_text)throw Object.assign(new Error('请填写位置。'),{field:'location_text'});
      await L.action(a,key,body);L.closeModal(true);L.closeDrawer();await L.refresh();L.toast(names[key]+'已保存');
    },'确认'+names[key],{assetId:a.id});return true;
  }
  L.serverToday=serverToday;L.softwareExpiry=expiry;
  L.registerView('terminals',{render:terminals,actions:a=>isTerminal(a)||isPlace(a)?allowedActions(a):[],action:singleAction});
  L.registerView('software',{render:software,actions:a=>isSoftware(a)?allowedActions(a):[]});
})();
