/* C9 disk actions and restartable replacement guidance. No stored wizard progress. */
(function(){
  'use strict';
  const L=window.ITLedger,{$,esc}=L;
  let overlay,mode='disks',hostId=null,selectedSlot=null,source='depot',pageStart=1,opening=0,previousFocus;
  // Selection only. Never written to storage or interpreted as completed workflow steps.
  let oldId=null,newId=null;
  const hostEligible=a=>['server','other'].includes(a.category)&&a.u_height>0&&a.slot_count>0;
  const machine=a=>['server','other'].includes(a.category)&&a.u_height>0;
  const loose=a=>a.category==='disk'&&a.parent_asset_id===null&&a.status==='in_depot';
  const asset=id=>L.state.assets.find(a=>a.id===id);
  const peer=(...rows)=>Object.fromEntries(rows.filter(Boolean).map(a=>[a.id,a.version]));
  function ensure(){
    if(overlay)return;
    overlay=document.createElement('div');overlay.id='itlHardwareOverlay';overlay.className='itl-hardware-overlay';overlay.hidden=true;
    overlay.innerHTML='<section class="itl-hardware-dialog" role="dialog" aria-modal="true" aria-labelledby="itlHardwareTitle"><header><div><h2 id="itlHardwareTitle"></h2><p class="itl-muted" id="itlHardwareSub"></p></div><button type="button" class="u-btn-secondary" data-hardware-command="close" id="itlHardwareClose">关闭</button></header><div id="itlHardwareBody"></div></section>';
    document.body.appendChild(overlay);overlay.addEventListener('click',e=>{if(e.target===overlay)close();});
  }
  async function show(nextMode){
    ensure();const seq=++opening;previousFocus=document.activeElement;mode=nextMode;overlay.hidden=false;
    $('#itlHardwareBody').textContent='正在读取资产状态…';await L.refresh();
    if(seq!==opening||!L.state.level)return;paint();$('#itlHardwareClose').focus();
  }
  // C0b: no longer flushes a pending auto-refresh (that mechanism is gone) — every mutation in this file already
  // calls `await L.refresh()` itself right where it happens (see diskForm's submit handler and the wizard-out
  // command below), so the workspace's asset list is already current by the time this overlay closes; close()
  // never has fresher data waiting on it, it only ever dismisses the panel.
  function close(){opening++;if(overlay)overlay.hidden=true;if(previousFocus?.isConnected)previousFocus.focus({preventScroll:true});}
  async function openDisks(id,from='depot'){hostId=id;source=from;selectedSlot=null;pageStart=1;await show('disks');}
  async function openReplacement(id){if(!L.canWrite())return;if(id)oldId=id;source='rack';await show('replacement');}
  function paint(){if(!overlay||overlay.hidden)return;if(mode==='replacement')paintReplacement();else paintDisks();}
  function paintDisks(){
    const host=asset(hostId);if(!host||!hostEligible(host)){close();L.notice('宿主已不存在或已无盘位。');return;}
    const disks=L.children(host);const canOperate=L.canWrite()&&['in_service','in_depot','faulty','to_retire'].includes(host.status);
    $('#itlHardwareTitle').textContent=host.name+' · 盘位';$('#itlHardwareSub').textContent=`${L.statuses[host.status]} · 已用 ${disks.length}/${host.slot_count} · ${L.location(host)}`;
    $('#itlHardwareClose').textContent=source==='rack'?'返回机柜':source==='wizard'?'返回换机向导':source==='detail'?'返回资产详情':'返回库房';
    overlay.classList.toggle('itl-hardware-light',source==='rack');
    pageStart=Math.min(Math.max(1,pageStart),host.slot_count);const last=pageStart+Math.min(47,host.slot_count-pageStart);
    let slots='';for(let slot=pageStart;slot<=last;slot++){
      const disk=disks.find(d=>d.slot_no===slot);
      slots+=`<button type="button" class="itl-disk-slot${disk?'':' itl-disk-empty'}${selectedSlot===slot?' itl-selected':''}" data-disk-slot="${slot}" aria-label="盘位${slot}${disk?'，'+esc(disk.name):'，空位'}"><small>#${slot}</small>${disk?`<strong>${esc(disk.model||disk.name)}</strong><span>${esc(disk.sn||'未填SN')}</span>${L.badge(disk.status)}`:`<span>${host.status==='in_service'&&L.canWrite()?'空盘位 · 点此装盘':'空盘位'}</span>`}</button>`;
    }
    const disk=disks.find(d=>d.slot_no===selectedSlot);
    let operations='<p class="itl-muted">选择盘位查看或操作。</p>';
    if(disk){
      operations=`<h3>#${disk.slot_no} · ${esc(disk.name)}</h3><p>${esc(disk.model||'—')} · SN ${esc(disk.sn||'—')}</p>`;
      if(canOperate){operations+=host.status==='in_service'?`<div class="itl-disk-operation-columns"><section><h4>换盘</h4><p>选择库房可用散盘，并指定旧盘去向。</p><button type="button" class="u-btn-primary" data-disk-op="disk_swap" data-disk-id="${disk.id}">换盘</button></section><section><h4>移盘</h4><p>移到另一台在位宿主的空盘位。</p><button type="button" class="u-btn-secondary" data-disk-op="disk_move" data-disk-id="${disk.id}">移盘</button></section></div>`:'';
        operations+=`<button type="button" class="u-btn-secondary" data-disk-op="disk_unmount" data-disk-id="${disk.id}">拆盘</button>`;
      }
    }else if(selectedSlot&&host.status==='in_service'&&L.canWrite())operations=`<h3>#${selectedSlot} · 空盘位</h3><button type="button" class="u-btn-primary" data-disk-op="disk_mount" data-host-id="${host.id}" data-target-slot="${selectedSlot}">选择散盘安装</button>`;
    $('#itlHardwareBody').innerHTML=`${host.slot_count>48?`<div class="itl-disk-pager"><button type="button" class="u-btn-secondary" data-disk-page="prev"${pageStart===1?' disabled':''}>前48槽</button><label>跳至盘位 <input id="itlDiskJump" type="number" min="1" max="${host.slot_count}" value="${pageStart}"></label><button type="button" class="u-btn-secondary" data-hardware-command="jump">查看</button><button type="button" class="u-btn-secondary" data-disk-page="next"${last===host.slot_count?' disabled':''}>后48槽</button><span>${pageStart}–${last} / ${host.slot_count}</span></div>`:''}<div class="itl-disk-grid">${slots}</div><section class="itl-disk-operations">${operations}</section>`;
  }
  async function diskForm(action,diskId,targetId,slotNo){
    if(!L.canWrite())return;
    const rows=(await L.api()).items;const disk=rows.find(a=>a.id===diskId),from=rows.find(a=>a.id===disk?.parent_asset_id);
    const targets=rows.filter(a=>hostEligible(a)&&a.status==='in_service'&&a.id!==from?.id),available=rows.filter(loose);
    const titles={disk_mount:'装盘',disk_unmount:'拆盘',disk_swap:'换盘',disk_move:'移盘'};
    if(action!=='disk_mount'&&(!disk||!from)){L.refresh();throw new Error('装载关系已变化，已更新为最新数据，请重新选择。');}
    let html=disk?`<p>${esc(disk.name)} · ${esc(disk.sn||'未填SN')}</p>`:'';
    if(action==='disk_mount'||action==='disk_swap')html+=L.formField('new_disk_id',action==='disk_mount'?'库房可用散盘':'替换用新盘',action==='disk_mount'&&disk?disk.id:'',{required:true,choices:[['','请选择散盘'],...available.map(d=>[d.id,`${d.name} · ${d.model||''} · ${d.sn||'未填SN'}`])]});
    if(action==='disk_move'||action==='disk_mount')html+=L.formField('parent_asset_id','目标宿主',targetId||'',{required:true,choices:[['','请选择在位宿主'],...targets.map(h=>[h.id,`${h.name} · ${h.slot_count}盘位`])]})+L.formField('slot_no','目标盘位',slotNo||1,{type:'number',min:1,required:true})+'<p class="u-hint" id="itlDiskTargetHint"></p>';
    if(action==='disk_unmount'||action==='disk_swap')html+=L.formField('to','旧盘去向',action==='disk_swap'?'faulty':'in_depot',{choices:(action==='disk_swap'?['faulty','to_retire','in_depot']:['in_depot','faulty']).map(s=>[s,L.statuses[s]])});
    L.openModal(titles[action],html,async form=>{
      let primary=disk,params={},target;
      if(action==='disk_mount'||action==='disk_move'){
        target=targets.find(a=>a.id===Number(form.elements.parent_asset_id.value));const slot=Number(form.elements.slot_no.value);
        if(!target)throw Object.assign(new Error('请选择在位宿主。'),{field:'parent_asset_id'});
        if(!Number.isSafeInteger(slot)||slot<1)throw Object.assign(new Error('盘位须为安全正整数。'),{field:'slot_no'});
        if(slot>target.slot_count)$('#itlDiskTargetHint').textContent='当前快照显示盘位超出宿主容量；提交时服务器再次校验。';
        params={parent_asset_id:target.id,slot_no:slot,peer_versions:peer(from,target)};
      }
      if(action==='disk_mount'||action==='disk_swap'){
        const replacement=available.find(a=>a.id===Number(form.elements.new_disk_id.value));if(!replacement)throw Object.assign(new Error('请选择可用散盘。'),{field:'new_disk_id'});
        if(action==='disk_mount')primary=replacement;else params={new_disk_id:replacement.id,to:form.elements.to.value,peer_versions:peer(from,replacement)};
      }
      if(action==='disk_unmount')params={to:form.elements.to.value,peer_versions:peer(from)};
      await L.action(primary,action,params);L.closeModal(true);selectedSlot=null;await L.refresh();L.toast(titles[action]+'已完成');
      if(!overlay||overlay.hidden)await openDisks((target||from).id,'depot');else paint();
    },'确认'+titles[action],{assetId:action==='disk_mount'?(disk?.id||available.find(d=>d.id===L.resolutionAssetId?.())?.id):disk.id});
    if(action==='disk_mount'||action==='disk_move'){
      const hint=()=>{const h=targets.find(a=>a.id===Number($('#itlForm').elements.parent_asset_id.value));const occupied=h?rows.filter(a=>a.parent_asset_id===h.id).map(a=>a.slot_no).sort((a,b)=>a-b):[];$('#itlDiskTargetHint').textContent=h?`总${h.slot_count}槽，已占：${occupied.join('、')||'无'}。提交时服务器再次校验。`:'先选择宿主。';};
      $('#itlForm').elements.parent_asset_id.addEventListener('change',hint);hint();
    }
  }
  function paintReplacement(){
    if(!L.canWrite()){close();return;}
    $('#itlHardwareTitle').textContent='换机向导';$('#itlHardwareSub').textContent='每一步独立保存，提示始终按服务器当前状态生成。';$('#itlHardwareClose').textContent='关闭向导';overlay.classList.remove('itl-hardware-light');
    const machines=L.state.assets.filter(a=>machine(a)&&a.status!=='retired'),old=asset(oldId),next=asset(newId);
    let step='<p class="itl-empty">请选择旧机与新机。</p>';
    if(old&&next&&old.id===next.id)step='<p role="alert">旧机和新机不能是同一台。</p>';
    else if(old&&next){
      const oldDisks=L.children(old),newDisks=L.children(next);
      if(old.status==='in_service')step=`<h3>下一步：旧机下架</h3><p>${esc(old.name)}及${oldDisks.length}块随装盘一起转入库房可用栏。</p><button type="button" class="u-btn-primary" data-hardware-command="wizard-out">下架旧机</button>`;
      else if(oldDisks.length)step=`<h3>下一步：逐盘拆出旧机硬盘</h3><p>旧机仍有${oldDisks.length}块随装盘。每次拆盘独立保存，建议转可用后再装入新机。</p><button type="button" class="u-btn-primary" data-wizard-disks="${old.id}">打开旧机盘位</button>`;
      else if(next.status==='in_depot')step=`<h3>下一步：新机上架选位</h3><p>旧机当前已无随装盘。为${esc(next.name)}选择机柜与U位，上架后可重新打开向导。</p><button type="button" class="u-btn-primary" data-hardware-command="wizard-rack-in">为新机选位</button>`;
      else if(next.status==='in_service')step=next.slot_count>0?`<h3>下一步：逐盘装入新机</h3><p>新机当前已装${newDisks.length}盘。请在真实库房散盘中选择需要迁移的硬盘；完成后关闭向导即可。</p><button type="button" class="u-btn-primary" data-wizard-disks="${next.id}">打开新机盘位</button>`:`<h3>新机已在位</h3><p>新机尚未配置盘位。如果需要迁移硬盘，请先编辑新机盘位数；无需迁盘时可关闭向导。</p><button type="button" class="u-btn-secondary" data-hardware-command="wizard-edit">编辑新机资料</button>`;
      else step='<p role="alert">新机须处于库房可用或在位状态，请先在库房调整状态。</p>';
      step+=`<div class="itl-wizard-status"><span>旧机：${esc(L.statuses[old.status])} · ${oldDisks.length}盘</span><span>新机：${esc(L.statuses[next.status])} · ${newDisks.length}盘</span></div>`;
    }
    $('#itlHardwareBody').innerHTML=`<div class="itl-form-grid">${L.formField('wizard_old','旧机',oldId||'',{choices:[['','请选择旧机'],...machines.map(a=>[a.id,a.name])]})}${L.formField('wizard_new','新机',newId||'',{choices:[['','请选择新机'],...machines.filter(a=>a.id!==oldId).map(a=>[a.id,a.name])]})}</div><section class="itl-wizard-next">${step}</section><p class="u-hint">不会自动回滚已完成步骤。需要恢复时，旧机可从库房重新上架，拆出的可用散盘可装回任一在位宿主。重新打开页面后再选择两台机器即可查看下一步。</p>`;
    $('[name="wizard_old"]').addEventListener('change',e=>{oldId=Number(e.target.value)||null;if(oldId===newId)newId=null;paintReplacement();});
    $('[name="wizard_new"]').addEventListener('change',e=>{newId=Number(e.target.value)||null;paintReplacement();});
  }
  async function command(name){
    if(name==='close'){if(source==='wizard'&&mode==='disks')await openReplacement();else close();return;}
    if(name==='jump'){const n=Number($('#itlDiskJump').value),h=asset(hostId);if(!h||!hostEligible(h)){close();L.notice('宿主已不存在或已无盘位。');return;}if(Number.isSafeInteger(n)&&n>=1&&n<=h.slot_count){pageStart=n;paintDisks();}return;}
    if(!L.canWrite())return;
    if(name==='wizard-edit')return L.openAssetForm(newId);
    if(name==='wizard-out'){
      const old=(await L.api('/'+oldId)).asset;L.openModal('旧机下架',`<p>将 ${esc(old.name)} 和随装盘转入库房可用栏。</p>`,async()=>{await L.action(old,'rack_out',{to:'in_depot'});L.closeModal(true);await L.refresh();paint();},'确认下架',{assetId:old.id});
    }
    if(name==='wizard-rack-in'){
      const next=(await L.api('/'+newId)).asset;if(!L.state.racks.length)throw new Error('请先创建机柜。');close();await L.openRack(L.state.racks[0].id,next);
    }
  }
  L.openDisks=openDisks;L.openReplacement=openReplacement;L.hardwareOverlayOpen=()=>!!overlay&&!overlay.hidden;
  L.hasReplacementSelection=()=>!!oldId&&!!newId;
  L.registerView('hardware',{onRefresh:paint,onAccessLost(){close();if(overlay){overlay.remove();overlay=null;}oldId=null;newId=null;},actions(a){const list=[];if(hostEligible(a)&&a.status!=='retired')list.push({key:'open_disks',label:'打开盘位'});if(machine(a)&&a.status!=='retired')list.push({key:'replace_machine',label:'换机向导'});if(loose(a))list.push({key:'disk_mount',label:'装盘'});if(a.category==='disk'&&a.parent_asset_id){const h=asset(a.parent_asset_id);if(h&&['in_service','in_depot','faulty','to_retire'].includes(h.status))list.push({key:'disk_unmount',label:'拆盘'});if(h?.status==='in_service')list.push({key:'disk_swap',label:'换盘'},{key:'disk_move',label:'移盘'});}return list;},async action(key,a){if(key==='open_disks'){await openDisks(a.id,'depot');return true;}if(key==='replace_machine'){await openReplacement(a.id);return true;}if(['disk_mount','disk_unmount','disk_swap','disk_move'].includes(key)){await diskForm(key,a.id);return true;}return false;}});
  document.addEventListener('click',e=>{
    const b=e.target.closest('[data-disk-slot],[data-disk-op],[data-disk-page],[data-hardware-command],[data-wizard-disks],[data-open-disks],[data-open-replacement]');if(!b)return;
    const task=async()=>{
      if(b.dataset.openDisks)return openDisks(Number(b.dataset.openDisks));if(b.dataset.openReplacement)return openReplacement(Number(b.dataset.openReplacement));
      if(b.dataset.hardwareCommand)return command(b.dataset.hardwareCommand);if(b.dataset.wizardDisks)return openDisks(Number(b.dataset.wizardDisks),'wizard');
      if(b.dataset.diskSlot){selectedSlot=Number(b.dataset.diskSlot);paintDisks();}
      if(b.dataset.diskOp)return diskForm(b.dataset.diskOp,Number(b.dataset.diskId)||null,Number(b.dataset.hostId)||null,Number(b.dataset.targetSlot)||null);
      if(b.dataset.diskPage){const h=asset(hostId);if(!h||!hostEligible(h)){close();L.notice('宿主已不存在或已无盘位。');return;}pageStart=b.dataset.diskPage==='next'?pageStart+Math.min(48,h.slot_count-pageStart):Math.max(1,pageStart-48);paintDisks();}
    };task().catch(error=>L.notice(error.message));
  });
  document.addEventListener('keydown',e=>{
    if(!L.hardwareOverlayOpen()||$('#itlModal').classList.contains('open'))return;
    if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();command('close').catch(error=>L.notice(error.message));}
    if(e.key==='Tab'){const items=[...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(el=>el.getClientRects().length),first=items[0],last=items.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}e.stopImmediatePropagation();}
  },true);
})();
