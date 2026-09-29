/* Rooms use real meter dimensions; AP coordinates remain relative to their room. */
(function(){
  'use strict';
  const L=window.ITLedger,{$,esc}=L;let floorId=null,roomId=null,selectedId=null,intent=null,busy=false,contextRestored=false;
  const floor=()=>L.state.floors.find(f=>f.id===floorId);
  const aps=()=>L.state.assets.filter(a=>a.category==='ap'&&a.status!=='retired');
  function render(){
    if(!contextRestored){const c=L.viewContext('aps');floorId=c.floorId||floorId;roomId=c.roomId||roomId;selectedId=c.selectedId||selectedId;contextRestored=true;}

    if(!L.state.floors.some(f=>f.id===floorId))floorId=L.state.floors[0]?.id||null;const f=floor(),list=aps(),selected=list.find(a=>a.id===selectedId);
    const rooms=f?.rooms||[];if(!rooms.some(r=>r.id===roomId))roomId=rooms[0]?.id||null;L.rememberView('aps',{floorId,roomId,selectedId});const buttons=L.canWrite()&&selected?`${selected.status==='in_service'?`<button type="button" class="u-btn-secondary" data-action="ap_relocate" data-id="${selected.id}">移到别的位置</button><button type="button" class="u-btn-secondary" data-action="return" data-id="${selected.id}">拆下</button>`:''}<button type="button" class="u-btn-secondary" data-action="edit" data-id="${selected.id}">编辑</button>`:'';
    $('#itlContent').innerHTML=`<div class="itl-toolbar"><div class="itl-floor-tabs">${L.state.floors.map(f=>`<button type="button" class="u-btn-secondary" data-floor="${esc(f.id)}"${f.id===floorId?' aria-current="page"':''}>${esc(f.name)} · ${list.filter(a=>a.floor_id===f.id).length} AP</button>`).join('')}</div>${L.isAdmin()?`<button type="button" class="u-btn-secondary" data-floor-admin="new">＋ 新建楼层</button>${f?'<button type="button" class="u-btn-secondary" data-floor-admin="edit">维护楼层与房间</button>':''}`:''}</div>${intent?`<div class="itl-notice">正在放置 ${esc(intent.asset.name)}：<span class="itl-location-preview">${esc(L.location(intent.asset))} → ${esc(f?.name||'未选择楼层')} · ${esc(rooms.find(r=>r.id===roomId)?.name||'未选择房间')}</span>点房间内任意位置保存，可先切楼层。<button type="button" class="u-btn-secondary" id="itlCancelAP"${busy?' disabled':''}>取消（Esc）</button></div>`:''}<div class="itl-ap-layout"><section class="itl-ap-main"><div class="itl-room-overview" aria-label="房间概览">${rooms.map(r=>`<button type="button" class="itl-room-overview-card" data-room-select="${esc(r.id)}"${r.id===roomId?' aria-current="true"':''}><strong>${esc(r.name)}</strong><span>${esc(r.w)}m × ${esc(r.h)}m</span><small>${list.filter(a=>a.floor_id===f.id&&a.room_id===r.id&&a.status==='in_service').length} AP${r.corridor?' · 走廊':''}</small></button>`).join('')}</div><div class="itl-ap-plan${intent?' itl-ap-placing':''}" id="itlAPPlan" aria-label="选中房间位置示意">${f?rooms.filter(r=>r.id===roomId).map(r=>{
      const roomAPs=list.filter(a=>a.floor_id===f.id&&a.room_id===r.id&&a.status==='in_service');
      return `<section class="itl-ap-room${r.corridor?' itl-corridor':''}"><header><strong>${esc(r.name)}</strong> <small>${esc(r.w)}m × ${esc(r.h)}m · ${roomAPs.length} AP</small></header><div class="itl-ap-room-content" style="aspect-ratio:${r.w}/${r.h}"><button type="button" class="itl-ap-room-target" data-room="${esc(r.id)}" aria-label="${esc(r.name)}内选择位置">${roomAPs.length?'':'<span>暂无 AP</span>'}</button>${roomAPs.map(a=>{
        if(!a.pos||!Number.isFinite(a.pos.x)||!Number.isFinite(a.pos.y))return '';
        return `<button type="button" class="itl-ap-point${selectedId===a.id?' itl-selected':''}" data-ap="${a.id}" style="left:${a.pos.x*100}%;top:${a.pos.y*100}%" title="${esc(a.name)}"><i></i><span>${esc(a.name)}</span></button>`;
      }).join('')}</div></section>`;
    }).join('')||'<div class="itl-empty">此楼层暂无房间，请管理员维护楼层。</div>':'<div class="itl-empty">请管理员先建立楼层与房间。</div>'}</div><p class="itl-canvas-note">位置为房间内示意；真实长宽以尺寸文字为准。</p></section><aside class="itl-ap-panel">${selected?`<h3>${esc(selected.name)}</h3>${L.badge(selected.status)}<dl class="itl-kv">${[['管理IP',selected.attrs?.mgmt_ip],['型号',selected.model],['SSID组',selected.attrs?.ssid_group],['SN',selected.sn],['位置',L.location(selected)]].map(([k,v])=>`<dt>${k}</dt><dd>${esc(v||'—')}</dd>`).join('')}</dl><div class="itl-actions">${buttons}</div>`:'<p class="itl-muted">点 AP 查看档案；放置模式也可用键盘选房间中心。</p>'}<section class="itl-ap-depot"><h3>库房里的 AP</h3>${list.filter(a=>['in_depot','faulty','to_retire'].includes(a.status)).map(a=>`<article><button type="button" class="itl-link" data-ap="${a.id}">${esc(a.name)}</button>${L.badge(a.status)}${a.status==='in_depot'&&L.canWrite()?`<button type="button" class="itl-link" data-action="ap_place" data-id="${a.id}">上架</button>`:''}</article>`).join('')||'<p class="itl-muted">暂无库房 AP</p>'}</section></aside></div>`;
    document.querySelectorAll('[data-floor]').forEach(b=>b.addEventListener('click',()=>{floorId=b.dataset.floor;roomId=null;selectedId=null;render();}));
    document.querySelectorAll('[data-room-select]').forEach(b=>b.addEventListener('click',()=>{roomId=b.dataset.roomSelect;if(!intent)selectedId=list.find(a=>a.floor_id===floorId&&a.room_id===roomId&&a.status==='in_service')?.id||null;render();}));
    document.querySelectorAll('[data-floor-admin]').forEach(b=>b.addEventListener('click',()=>editFloor(b.dataset.floorAdmin==='new'?null:floorId).catch(error=>L.notice(error.message))));
    $('#itlCancelAP')?.addEventListener('click',()=>{if(!busy){intent=null;render();}});
    if(intent&&L.resolutionChoice)$('#itlCancelAP').parentElement.insertAdjacentHTML('beforeend',L.resolutionChoice(intent.asset.id,'ap'));
    document.querySelectorAll('.itl-ap-room-content').forEach(card=>card.addEventListener('click',e=>{
      if(intent){
        if(busy)return;
        const roomId=card.querySelector('[data-room]').dataset.room,bounds=card.getBoundingClientRect();
        const x=e.detail===0?.5:(e.clientX-bounds.left)/bounds.width;
        const y=e.detail===0?.5:(e.clientY-bounds.top)/bounds.height;
        placeAt(roomId,x,y).catch(error=>L.notice(error.message));
      }else{const id=Number(e.target.closest('[data-ap]')?.dataset.ap);if(id){selectedId=id;render();}}
    }));
    $('.itl-ap-depot')?.addEventListener('click',e=>{const b=e.target.closest('[data-ap]');if(b){selectedId=Number(b.dataset.ap);render();}});
  }
  async function placeAt(roomId,x,y){
    if(!intent||busy||!L.canWrite())return;const f=floor();if(!f)return;
    const room=f.rooms.find(r=>r.id===roomId);if(!room)return;
    const a=intent.asset,action=a.status==='in_service'?'ap_relocate':'ap_place',binding=L.resolutionProtocol?.(a.id,$('#itlContent'))||{};busy=true;
    try{await L.action(a,action,{floor_id:f.id,room_id:room.id,pos:{x:Math.min(1,Math.max(0,x)),y:Math.min(1,Math.max(0,y))},...binding});selectedId=a.id;L.toast(`AP位置已保存：${a.name} → ${f.name} · ${room.name}`);}
    catch(error){L.notice(error.message);}
    finally{intent=null;busy=false;await L.refresh();}
  }
  async function editFloor(id){
    if(!L.isAdmin())return;const fresh=(await L.api('/floors')).items,current=id?fresh.find(f=>f.id===id):null;if(id&&!current)throw new Error('楼层已不存在。');
    let rooms=(current?.rooms||[]).map(r=>({...r,_existing:true}));
    L.openModal(id?'维护楼层与房间':'新建楼层',`<div class="itl-form-grid">${L.formField('floor_id','楼层 ID',current?.id||'',{required:true,disabled:!!id})}${L.formField('floor_name','楼层名称',current?.name||'',{required:true})}${L.formField('sort_order','排序',current?.sort_order||0,{type:'number'})}${L.formField('note','备注',current?.note||'')}</div><p class="u-hint">长宽填真实米数（可带小数）。房间在页面上按录入顺序排列，不需要填位置。已建房间 ID 不可修改。</p><div class="itl-room-table-wrap"><table class="itl-room-table"><thead><tr><th>ID</th><th>名称</th><th>长(米)</th><th>宽(米)</th><th>走廊</th><th>顺序 / 移除</th></tr></thead><tbody id="itlRoomRows"></tbody></table></div><button type="button" class="u-btn-secondary" id="itlAddRoom">＋ 添加房间</button>${id?`<p><button type="button" class="u-btn-danger" id="itlDeleteFloor"${current.rooms.length?' disabled':''}>删除空楼层</button>${current.rooms.length?'<small>需先保存为空房间列表，且不能有 AP 引用。</small>':''}</p>`:''}`,async form=>{
      const target=id||form.elements.floor_id.value.trim();if(!/^[A-Za-z0-9_-]{1,32}$/.test(target))throw new Error('楼层ID限1–32位字母、数字、下划线或短横线。');
      const name=form.elements.floor_name.value.trim(),sort=Number(form.elements.sort_order.value);if(!name||!Number.isInteger(sort))throw new Error('请填写楼层名称和整数排序。');
      if(rooms.some(r=>['w','h'].some(k=>r[k]==='')))throw new Error('房间长宽必须填写数值。');
      const data=rooms.map(r=>({id:r.id.trim(),name:r.name.trim(),w:Number(r.w),h:Number(r.h),corridor:!!r.corridor}));
      const ids=new Set();for(const r of data){if(!r.id||!r.name||ids.has(r.id))throw new Error('每个房间必须填写不重复的ID及名称。');ids.add(r.id);if(![r.w,r.h].every(Number.isFinite)||r.w<=0||r.h<=0||r.w>500||r.h>500)throw new Error('房间长宽须为不超过500米的有限正数。');}
      await L.api('/floors/'+encodeURIComponent(target),{method:'PUT',body:JSON.stringify({name,sort_order:sort,rooms:data,note:form.elements.note.value||null})});L.closeModal(true);floorId=target;await L.refresh();L.toast('楼层已保存');
    });
    function paintRooms(){
      $('#itlRoomRows').innerHTML=rooms.map((r,i)=>`<tr data-room-row="${i}">${['id','name','w','h'].map(k=>`<td><input aria-label="房间${i+1}${k}" data-room-field="${k}" value="${esc(r[k])}"${['w','h'].includes(k)?' type="number" step="0.1" min="0.1" max="500"':''}${k==='id'&&r._existing?' disabled':''}></td>`).join('')}<td><input type="checkbox" aria-label="房间${i+1}走廊" data-room-field="corridor"${r.corridor?' checked':''}></td><td><button type="button" data-room-edit="up"${i===0?' disabled':''}>上移</button><button type="button" data-room-edit="down"${i===rooms.length-1?' disabled':''}>下移</button><button type="button" data-room-edit="remove">移除</button></td></tr>`).join('');
    }
    $('#itlRoomRows').addEventListener('input',e=>{const input=e.target.closest('[data-room-field]');if(!input)return;const r=rooms[Number(input.closest('[data-room-row]').dataset.roomRow)],key=input.dataset.roomField;r[key]=key==='corridor'?input.checked:input.value;});
    $('#itlRoomRows').addEventListener('click',e=>{const b=e.target.closest('[data-room-edit]');if(!b)return;const i=Number(b.closest('[data-room-row]').dataset.roomRow);if(b.dataset.roomEdit==='remove')rooms.splice(i,1);else{const other=i+(b.dataset.roomEdit==='up'?-1:1);[rooms[i],rooms[other]]=[rooms[other],rooms[i]];}paintRooms();});
    $('#itlAddRoom').addEventListener('click',()=>{rooms.push({id:'',name:'',w:20,h:20,corridor:false,_existing:false});paintRooms();});paintRooms();
    $('#itlDeleteFloor')?.addEventListener('click',()=>L.openModal('删除空楼层',`<p>确认删除 ${esc(current.name)}？</p>`,async()=>{await L.api('/floors/'+encodeURIComponent(id),{method:'DELETE'});L.closeModal(true);floorId=null;await L.refresh();},'确认删除'));
  }
  L.locateAPAsset=async a=>{
    if(!L.state.level||busy)return;await L.refresh();
    const current=L.state.assets.find(x=>x.id===a.id),f=L.state.floors.find(x=>x.id===current?.floor_id);
    if(!current||!f||!f.rooms.some(r=>r.id===current.room_id)){L.notice('AP位置已变化或已拆下，已更新为最新数据，请重新定位。');return;}
    intent=null;contextRestored=true;floorId=f.id;roomId=current.room_id;selectedId=current.id;L.setTab('aps');
    requestAnimationFrame(()=>{const point=document.querySelector('.itl-ap-point[data-ap="'+current.id+'"]');if(point)point.focus({preventScroll:true});});
    L.toast(`已定位 ${current.name} · ${L.location(current)}`);
  };
  L.registerView('aps',{render,onRefresh(){if(!L.canWrite()&&intent){intent=null;if(L.state.tab==='aps')render();}},onAccessLost(){intent=null;selectedId=null;floorId=null;roomId=null;busy=false;contextRestored=false;},actions:a=>a.category!=='ap'?[]:a.status==='in_depot'?[{key:'ap_place',label:'上架'}]:a.status==='in_service'?[{key:'ap_relocate',label:'移AP位置'},{key:'return',label:'拆下AP'}]:[],async action(key,a){if(!['ap_place','ap_relocate'].includes(key))return false;if(!L.canWrite())return true;L.closeDrawer();contextRestored=true;intent={asset:a};floorId=a.floor_id||floorId||L.state.floors[0]?.id||null;roomId=a.room_id||roomId;selectedId=a.id;L.setTab('aps');return true;}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&intent&&!busy&&!$('#itlModal').classList.contains('open')){intent=null;e.preventDefault();if(L.state.tab==='aps')render();}});
})();
