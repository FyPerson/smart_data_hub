/* C8: rack overview and real placement actions. Frontend fit is a preview only. */
(function () {
  'use strict';
  const L=window.ITLedger, {$,esc}=L;
  const U_PX=28;
  const palette={server:'#b07a4c',storage:'#6d8f7c',switch:'#6f7d98',ups:'#8c8478',other:'#a0907b'};
  let overlay, rackId=null, selectedId=null, intent=null, pending=false, message='', windowTop=null, previousFocus, previousScroll=0;
  const rack=()=>L.state.racks.find(r=>r.id===rackId);
  const placed=id=>L.state.assets.filter(a=>a.rack_id===id&&a.status==='in_service');
  const eligible=a=>['server','other'].includes(a.category)&&a.u_height>0;
  const kind=a=>a.category==='server'?'server':Object.hasOwn(palette,a.attrs?.subtype)?a.attrs.subtype:'other';
  const end=a=>a.u_start+(a.u_height-1);
  function fits(r,a,start) {
    return Number.isSafeInteger(start)&&start>=1&&start<=r.u_total&&a.u_height<=r.u_total-start+1&&
      !placed(r.id).some(other=>other.id!==a.id&&start<=end(other)&&other.u_start<=start+(a.u_height-1));
  }
  function freeRuns(r) {
    const intervals=placed(r.id).map(a=>[a.u_start,end(a)]).sort((a,b)=>a[0]-b[0]);
    const runs=[];let cursor=1;
    for(const [lo,hi] of intervals){if(cursor<lo)runs.push([cursor,lo-1]);if(hi>=r.u_total)return runs;cursor=Math.max(cursor,hi+1);}
    if(cursor<=r.u_total)runs.push([cursor,r.u_total]);return runs;
  }
  const used=r=>placed(r.id).reduce((sum,a)=>sum+a.u_height,0);
  function render() {
    L.syncHeaderEmphasis();
    $('#itlContent').innerHTML=`<div class="itl-toolbar"><span class="itl-muted">按真实 U 位展示 · 点击机柜查看与操作</span>${L.isAdmin()?'<button class="u-btn-secondary" type="button" data-rack-command="create">＋ 新建机柜</button>':''}</div><div class="itl-rack-workspace"><section><div class="itl-section-heading"><div><h2>机柜总览</h2><p class="itl-muted">点击机柜名称或示意图，进入正视图操作。</p></div><span class="itl-muted">${L.state.racks.length} 个机柜</span></div><div class="itl-rack-array">${L.state.racks.map(r=>{
      const ticks=new Set([1,r.u_total]);const step=Math.max(5,Math.ceil(r.u_total/150)*5);for(let i=1;i<=30;i++){const u=i*step;if(u<r.u_total)ticks.add(u);}
      return `<article class="itl-rack-summary"><button type="button" class="itl-rack-title" data-open-rack="${r.id}"><strong>${esc(r.name)}</strong><span>${esc(r.room)} · ${r.u_total}U</span></button><div class="itl-rack-overview"><div class="itl-rack-scale">${[...ticks].map(u=>`<span style="bottom:${((u-1)/r.u_total)*100}%">${u}</span>`).join('')}</div><button type="button" class="itl-rack-frame" data-open-rack="${r.id}" aria-label="查看${esc(r.name)}正视图">${placed(r.id).length?placed(r.id).map(a=>`<span class="itl-rack-device" style="bottom:${((a.u_start-1)/r.u_total)*100}%;height:${a.u_height/r.u_total*100}%;--itl-type:${palette[kind(a)]}" title="${esc(a.name)} · U${a.u_start}–${end(a)}">${esc(a.name)}</span>`).join(''):'<span class="itl-rack-empty">暂无设备</span>'}</button></div><div class="itl-rack-util"><span style="width:${used(r)/r.u_total*100}%"></span></div><p class="itl-muted">已用 ${used(r)}U / ${r.u_total}U · 空余 ${r.u_total-used(r)}U</p>${L.isAdmin()?`<button type="button" class="u-btn-secondary itl-btn-sm" data-manage-rack="${r.id}">维护机柜</button>`:''}</article>`;
    }).join('')||'<div class="itl-empty">尚无机柜，请管理员先新建机柜。</div>'}</div></section></div>`;
  }
  function ensureOverlay() {
    if(overlay)return;
    overlay=document.createElement('div');overlay.id='itlRackOverlay';overlay.className='itl-rack-overlay';overlay.hidden=true;
    overlay.innerHTML='<section class="itl-rack-dialog" role="dialog" aria-modal="true" aria-labelledby="itlRackTitle"><header><div><h2 id="itlRackTitle"></h2><div id="itlRackSub" class="itl-muted"></div></div><button type="button" class="u-btn-secondary" data-rack-command="close">关闭</button></header><nav id="itlRackTabs" class="itl-rack-tabs" aria-label="切换机柜"></nav><div id="itlRackMessage" role="status" class="itl-notice" hidden></div><div class="itl-rack-body"><div class="itl-rack-left"><div id="itlRackWindow"></div><div class="itl-rack-scroll"><div id="itlRackFace" class="itl-rack-face"></div></div></div><div id="itlRackPanel" class="itl-rack-panel"></div></div></section>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
    overlay.addEventListener('mouseover',preview);overlay.addEventListener('focusin',preview);
    overlay.addEventListener('mouseleave',()=>overlay.querySelectorAll('.itl-preview').forEach(el=>el.classList.remove('itl-preview')));
  }
  async function open(id,asset=null) {
    ensureOverlay(); previousFocus=document.activeElement; previousScroll=window.scrollY; L.closeDrawer(); rackId=id;selectedId=asset?.id||null;intent=asset?{asset}:null;message='';windowTop=null;
    await L.refresh();if(!L.state.level)return;
    if(!rack()){L.notice('机柜已不存在，已更新为最新数据，请重新选择。');return;}
    overlay.hidden=false;paint();overlay.querySelector('[data-rack-command="close"]').focus();
  }
  function close(){if(pending)return;if(overlay)overlay.hidden=true;intent=null;selectedId=null;message='';if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});window.scrollTo(0,previousScroll);}
  function paint() {
    if(!overlay||overlay.hidden)return;
    const r=rack();if(!r){close();return;}
    $('#itlRackTitle').textContent=`${r.name} · ${r.u_total}U 正视图`;
    // Largest free run replaces the old free-run button list (placing still starts from an empty U cell).
    const best=freeRuns(r).reduce((m,x)=>!m||x[1]-x[0]>m[1]-m[0]?x:m,null);
    $('#itlRackSub').textContent=`${placed(r.id).length} 台设备 · 已用 ${used(r)}U / ${r.u_total}U · ${best?`最大连续空段 ${best[1]-best[0]+1}U（U${best[0]}–${best[1]}）`:'没有空余 U 位'}`;
    $('#itlRackTabs').innerHTML=L.state.racks.map(r=>`<button type="button" data-switch-rack="${r.id}"${r.id===rackId?' aria-current="page"':''}${pending?' disabled':''}>${esc(r.name)}</button>`).join('');
    $('#itlRackMessage').textContent=message;$('#itlRackMessage').hidden=!message;
    const top=Math.min(windowTop||r.u_total,r.u_total),bottom=Math.max(1,top-119);
    $('#itlRackWindow').innerHTML=r.u_total>120?`<div class="itl-rack-window"><button type="button" data-window="up"${top===r.u_total?' disabled':''}>更高 U</button><label>跳至 U <input id="itlRackJump" type="number" min="1" max="${r.u_total}" value="${top}"></label><button type="button" data-rack-command="jump">查看</button><button type="button" data-window="down"${bottom===1?' disabled':''}>更低 U</button></div>`:'';
    let rows='';for(let u=top;u>=bottom;u--){
      const hit=placed(r.id).find(a=>u>=a.u_start&&u<=end(a));
      const allowed=intent&&fits(r,intent.asset,u)&&!(intent.asset.rack_id===r.id&&intent.asset.u_start===u);
      rows+=`<div class="itl-u-row"><span>U${u}</span><button type="button" class="itl-u-cell${intent?(allowed?' itl-can-place':' itl-cannot-place'):hit?' itl-occupied':''}" data-u="${u}" aria-label="U${u}${intent?(allowed?'，可放置':'，不可放置'):hit?'，'+esc(hit.name):'，空位'}"${pending?' disabled':''}></button></div>`;
    }
    $('#itlRackFace').innerHTML=rows+placed(r.id).filter(a=>a.u_start<=top&&end(a)>=bottom).map(a=>{
      const high=Math.min(end(a),top),low=Math.max(a.u_start,bottom),disks=L.children(a);
      const dots=Array.from({length:Math.min(a.slot_count,24)},(_,i)=>`<i${disks.some(d=>d.slot_no===i+1)?' class="occupied"':''}></i>`).join('');
      return `<button type="button" class="itl-face-device${high===low?' itl-one-u':''}${selectedId===a.id?' itl-selected':''}${intent?' itl-reference':''}" data-select-rack-asset="${a.id}" style="top:${(top-high)*U_PX}px;height:${(high-low+1)*U_PX-2}px;--itl-type:${palette[kind(a)]}" title="${esc(a.name)} · U${a.u_start}–${end(a)}"><strong>${esc(a.name)}</strong><span>${esc(a.attrs?.ip||a.model||'')} · U${a.u_start}–${end(a)}</span>${a.slot_count?`<small class="itl-disk-dots" aria-label="盘位 ${disks.length}/${a.slot_count}">${dots} ${disks.length}/${a.slot_count}</small>`:''}</button>`;
    }).join('');
    paintPanel();
  }
  const panelGroup=(label,buttons)=>buttons?`<div class="itl-panel-group"><p class="itl-panel-group-label">${label}</p><div class="itl-actions">${buttons}</div></div>`:'';
  function paintPanel() {
    const r=rack(),asset=L.state.assets.find(a=>a.id===selectedId&&a.rack_id===rackId);
    let html='';
    if(intent)html=`<h3>${intent.asset.status==='in_depot'?'上架':'移位 / 迁柜'} · ${esc(intent.asset.name)}</h3><p>占用 ${intent.asset.u_height}U。点击左侧可放置位置；也可先切换机柜。</p><p class="itl-muted">原位置：${esc(L.location(intent.asset))}</p><p id="itlRackTargetPreview" class="itl-location-preview" aria-live="polite">目标机柜：${esc(r.name)} · 请悬停或聚焦 U 位查看目标范围</p><button type="button" class="u-btn-secondary" data-rack-command="cancel"${pending?' disabled':''}>取消选位（Esc）</button>`;
    // Actions ordered by frequency: everyday ones first, location-changing ones after, 下架 last in red; no accent button inside the overlay.
    else if(asset)html=`<div class="itl-panel-head"><h3>${esc(asset.name)}</h3>${L.badge(asset.status)}<button type="button" class="itl-link itl-panel-link" data-rack-command="detail">完整档案 ›</button></div><dl class="itl-kv">${[['管理 IP',asset.attrs?.ip],['型号',asset.model],['用途',asset.attrs?.purpose],['SN',asset.sn],['占位',`U${asset.u_start}–${end(asset)} · ${asset.u_height}U`],['盘位',`${L.children(asset).length}/${asset.slot_count}`]].map(([k,v])=>`<dt>${k}</dt><dd>${esc(v||'—')}</dd>`).join('')}</dl>${panelGroup('常用',(asset.slot_count&&L.openDisks?'<button type="button" class="u-btn-secondary" data-rack-command="disks">打开盘位</button>':'')+(L.canWrite()?'<button type="button" class="u-btn-secondary" data-rack-command="edit">编辑资料</button>':''))}${L.canWrite()?panelGroup('位置变更','<button type="button" class="u-btn-secondary" data-rack-command="move">移位 / 迁柜</button>'+(L.openReplacement?'<button type="button" class="u-btn-secondary" data-rack-command="replace">换机向导</button>':'')+'<button type="button" class="u-btn-secondary itl-btn-danger-text" data-rack-command="out">下架</button>'):''}`;
    else html='<div class="itl-empty">点设备查看档案；点空 U 位可选择库房设备上架。</div>';
    if(intent)html+=L.resolutionChoice?.(intent.asset.id,'rack')||'';
    if(L.canWrite()&&L.hasReplacementSelection?.())html+='<p><button type="button" class="itl-link" data-rack-command="resume_replace">返回换机向导查看下一步</button></p>';
    $('#itlRackPanel').innerHTML=html;
  }
  function preview(e){if(!intent||pending)return;const cell=e.target.closest('[data-u]');if(!cell)return;const start=Number(cell.dataset.u);const r=rack();if(!r)return;const target=$('#itlRackTargetPreview');if(target)target.textContent=`${L.location(intent.asset)} → ${r.name} · U${start}–${start+intent.asset.u_height-1}（提交时服务器校验）`;overlay.querySelectorAll('.itl-preview').forEach(el=>el.classList.remove('itl-preview'));if(!fits(rack(),intent.asset,start))return;overlay.querySelectorAll('[data-u]').forEach(el=>{const u=Number(el.dataset.u);if(u>=start&&u-start<intent.asset.u_height)el.classList.add('itl-preview');});}
  async function place(start){
    if(!intent||pending||!L.canWrite())return;const asset=intent.asset,r=rack();
    if(!r){close();L.refresh();L.notice('机柜已不存在，已更新为最新数据。');return;}
    const fitHint= !fits(r,asset,start)?'当前快照显示这个位置放不下整段设备；提交时服务器再次校验。':'';
    if(asset.rack_id===r.id&&asset.u_start===start){message='设备已经在这个位置。';paint();return;}
    const action=asset.status==='in_depot'?'rack_in':asset.rack_id===r.id?'rack_relocate':'rack_move';
    const binding=L.resolutionProtocol?.(asset.id,$('#itlRackPanel'))||{};
    pending=true;message=fitHint||'正在保存位置…';paint();
    try{await L.action(asset,action,{u_start:start,...(action==='rack_relocate'?{}:{rack_id:r.id}),...binding});intent=null;selectedId=asset.id;message=`位置已保存。${asset.name} → ${r.name} · U${start}–${start+asset.u_height-1}`;}
    catch(error){message=error.message;intent=null;}
    finally{pending=false;await L.refresh();paint();}
  }
  function chooseDepot(start){
    if(!L.canWrite()||pending)return;
    const r=rack();if(!r){close();L.refresh();return;}
    const candidates=L.state.assets.filter(a=>eligible(a)&&a.status==='in_depot');
    if(!candidates.length){message='库房没有可上架设备。故障或待报废设备须先转回可用。';paint();return;}
    L.openModal(`上架到 ${r.name} · U${start}`,L.formField('asset_id','库房设备','',{choices:[['','请选择设备'],...candidates.map(a=>[a.id,`${a.name} · ${a.u_height}U`])]})+'<p class="u-hint">选择设备后进入同一选位模式，可再次核对或调整起点。</p>',async form=>{
      const asset=candidates.find(a=>a.id===Number(form.elements.asset_id.value));if(!asset)throw new Error('请选择设备。');
      const r=rack();if(!r){L.closeModal(true);close();L.refresh();return;}
      message=!fits(r,asset,start)?'当前快照显示这个位置放不下整段设备；提交时服务器再次校验。':'';
      intent={asset};selectedId=asset.id;windowTop=Math.min(r.u_total,start+Math.min(119,r.u_total-start));L.closeModal(true);paint();
    },'进入选位');
  }
  async function manage(id){
    if(!L.isAdmin())return;const fresh=await L.api('/racks');L.state.racks=fresh.items;
    const r=id?L.state.racks.find(r=>r.id===id):{name:'',room:'机房',u_total:42,sort_order:0,note:''};
    if(!r){L.refresh();throw new Error('机柜已不存在，已更新为最新数据，请重新选择。');}
    L.openModal(id?'维护机柜':'新建机柜',`<div class="itl-form-grid">${L.formField('name','名称',r.name,{required:true})}${L.formField('room','机房',r.room,{required:true})}${L.formField('u_total','总 U 数',r.u_total,{type:'number',min:1,required:true})}${L.formField('sort_order','排序',r.sort_order,{type:'number'})}${L.formField('note','备注',r.note,{textarea:true,wide:true})}</div>${id?'<p><button type="button" class="u-btn-danger" id="itlDeleteRack">删除空机柜</button></p>':''}`,async form=>{
      const body={name:form.elements.name.value.trim(),room:form.elements.room.value.trim(),u_total:Number(form.elements.u_total.value),sort_order:Number(form.elements.sort_order.value),note:form.elements.note.value||null};
      if(!body.name||!body.room)throw new Error('名称与机房必填。');if(!Number.isSafeInteger(body.u_total)||body.u_total<1)throw new Error('总 U 数须为安全正整数。');if(!Number.isInteger(body.sort_order))throw new Error('排序须为整数。');
      await L.api('/racks'+(id?'/'+id:''),{method:id?'PUT':'POST',body:JSON.stringify(body)});L.closeModal(true);await L.refresh();L.toast('机柜已保存');
    });
    if(id)$('#itlDeleteRack').addEventListener('click',()=>L.openModal('删除空机柜',`<p>确认删除 ${esc(r.name)}？有资产引用时服务端将拒绝删除。</p>`,async()=>{await L.api('/racks/'+id,{method:'DELETE'});L.closeModal(true);await L.refresh();L.toast('机柜已删除');},'确认删除'));
  }
  async function command(name){
    if(name==='close'){close();return;}if(name==='cancel'){if(!pending){intent=null;message='';paint();}return;}
    if(name==='create')return manage();if(pending)return;
    if(name==='resume_replace'&&L.canWrite()&&L.openReplacement)return L.openReplacement();
    if(name==='jump'){const u=Number($('#itlRackJump').value),r=rack();if(!r){close();L.refresh();L.notice('机柜已不存在，已更新为最新数据。');return;}if(Number.isSafeInteger(u)&&u>=1&&u<=r.u_total){windowTop=u;paint();}return;}
    const asset=L.state.assets.find(a=>a.id===selectedId);if(!asset)return;
    if(name==='detail'){close();await L.detail(asset.id);return;}
    if(name==='disks'&&L.openDisks){L.openDisks(asset.id,'rack');return;}
    if(name==='replace'&&L.canWrite()&&L.openReplacement){L.openReplacement(asset.id);return;}
    if(!L.canWrite())return;
    if(name==='move'){const data=await L.api('/'+asset.id);intent={asset:data.asset};message='';paint();}
    if(name==='edit')await L.openAssetForm(asset.id);
    if(name==='out'){
      const current=(await L.api('/'+asset.id)).asset;
      L.openModal('下架 '+current.name,L.formField('to','下架后去向','in_depot',{choices:['in_depot','faulty','to_retire'].map(s=>[s,L.statuses[s]])})+`<p>随装 ${L.children(current).length} 盘将跟随设备进入同一库房栏。</p>`,async form=>{await L.action(current,'rack_out',{to:form.elements.to.value});L.closeModal(true);selectedId=null;await L.refresh();paint();L.toast('设备已下架');},'确认下架',{assetId:current.id});
    }
  }
  L.registerView('racks',{render,onRefresh(){if(!L.canWrite())intent=null;paint();},onAccessLost(){pending=false;close();if(overlay){overlay.remove();overlay=null;}},actions:a=>!eligible(a)?[]:a.status==='in_depot'?[{key:'rack_in',label:'上架'}]:a.status==='in_service'?[{key:'rack_view',label:'打开机柜处理'}]:[],async action(key,asset){if(key==='rack_view'){await open(asset.rack_id);return true;}if(key!=='rack_in')return false;if(!L.state.racks.length){L.notice('请管理员先新建机柜。');return true;}await open(L.state.racks[0].id,asset);return true;}});
  L.locateRackAsset=async asset=>{
    if(!L.state.level)return;
    L.setTab('racks');await open(asset.rack_id);
    const current=L.state.assets.find(a=>a.id===asset.id),r=rack();
    if(!current||!r||current.rack_id!==r.id){close();L.notice('设备位置已变化，已更新为最新数据，请重新定位。');return;}
    selectedId=current.id;windowTop=Math.min(r.u_total,end(current)+Math.min(10,r.u_total-end(current)));message=`已定位 ${current.name} · ${L.location(current)}`;paint();
    const button=overlay.querySelector('[data-select-rack-asset="'+current.id+'"]');if(button){button.focus({preventScroll:true});$('.itl-rack-scroll',overlay).scrollTop=Math.max(0,button.offsetTop-80);}
  };
  L.openRack=open;L.rackGeometry={fits,freeRuns};
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-open-rack],[data-switch-rack],[data-manage-rack],[data-rack-command],[data-select-rack-asset],[data-u],[data-window]');if(!b)return;
    const task=async()=>{
      if(b.dataset.openRack)return open(Number(b.dataset.openRack));if(b.dataset.manageRack)return manage(Number(b.dataset.manageRack));if(b.dataset.rackCommand)return command(b.dataset.rackCommand);
      if(pending)return;
      if(b.dataset.switchRack){rackId=Number(b.dataset.switchRack);windowTop=null;if(!intent)selectedId=null;paint();}
      if(b.dataset.selectRackAsset){selectedId=Number(b.dataset.selectRackAsset);paint();}
      if(b.dataset.u){const u=Number(b.dataset.u);if(intent)return place(u);const hit=placed(rackId).find(a=>u>=a.u_start&&u<=end(a));if(hit){selectedId=hit.id;paint();}else chooseDepot(u);}
      if(b.dataset.window){const r=rack();if(!r){close();L.refresh();return;}const top=Math.min(windowTop||r.u_total,r.u_total);windowTop=b.dataset.window==='up'?top+Math.min(120,r.u_total-top):Math.max(1,top-120);paint();}
    };task().catch(error=>{message=error.message;L.notice(error.message);paint();});
  });
  document.addEventListener('keydown',e=>{
    if(!overlay||overlay.hidden||$('#itlModal').classList.contains('open')||L.hardwareOverlayOpen?.())return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();if(intent&&!pending){intent=null;message='';paint();}else close();}
    if(e.key==='Tab'){const items=[...overlay.querySelectorAll('button:not([disabled]),input:not([disabled])')].filter(el=>el.getClientRects().length),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}e.stopImmediatePropagation();}
  },true);
})();
