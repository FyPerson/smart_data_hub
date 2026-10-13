'use strict';
// All-assets table columns after the codex 50 redesign (plan D): category | asset | purpose / extra info | status | SN |
// location | actions. Every assertion reads the rendered cells of a row found by its own asset id. Coverage per codex 52:
// every category and purpose branch, hidden-column search, prototype-named sub-types, marker-only names, HTML / quote
// injection in name / sub-type / attrs / location, full-order sort restore in both directions, stale sorts.
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),{chromium}=require('playwright');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const f=await createFixture();let browser,pass=0;console.log('ISOLATED_ARTIFACTS='+f.dir);
 const check=(label,value)=>{assert.ok(value,label);pass++;console.log('[OK] '+label);};
 const create=async body=>{const r=await f.api('POST','',body);assert.equal(r.status,201,JSON.stringify(r.body));return r.body;};
 const XSS_NAME='<img src=x onerror="window.__xss=1">"Q\'&';
 try{
  const rack=(await f.api('POST','/racks',{name:'列测试柜',u_total:42})).body;
  const s1=await create({category:'server',name:'中通文博HRD系统数据库',brand:'Dell',model:'PowerEdge R720',sn:'LC-S1',u_height:2,attrs:{ip:'10.9.0.7',purpose:'中通文博HRD系统数据库'},placement:{kind:'rack',rack_id:rack.id,u_start:1}});
  const s2=await create({category:'server',name:'宿主机 10.9.0.10',brand:'Dell',model:'PowerEdge R750',sn:'LC-S2',u_height:2,attrs:{ip:'10.9.0.10',purpose:'宿主机'},placement:{kind:'rack',rack_id:rack.id,u_start:3}});
  const s3=await create({category:'server',name:'数据平台虚拟化',brand:'Dell',model:'PowerEdge R750',sn:'LC-S3',u_height:2,slot_count:4,attrs:{ip:'10.9.0.11',purpose:'虚拟化宿主机'},placement:{kind:'rack',rack_id:rack.id,u_start:5}});
  const o1=await create({category:'other',name:'核心交换机',brand:'Huawei',model:'S5720',u_height:1,attrs:{subtype:'switch',ip:'10.9.0.1'},placement:{kind:'rack',rack_id:rack.id,u_start:10}});
  const o2=await create({category:'other',name:'机房KVM',attrs:{subtype:'kvm'},placement:{kind:'place',location_text:'机房'}});
  const o3=await create({category:'other',name:'原型名细分甲',attrs:{subtype:'constructor'},placement:{kind:'place',location_text:'机房'}});
  const o4=await create({category:'other',name:'原型名细分乙',attrs:{subtype:'__proto__'},placement:{kind:'place',location_text:'机房'}});
  const x1=await create({category:'other',name:XSS_NAME,attrs:{subtype:'<b>"s"</b>',ip:'"><i>ip</i>'},placement:{kind:'place',location_text:'<u>loc</u>'}});
  const host=(await f.api('GET','/'+s3.id)).body.asset;
  const d1=await create({category:'disk',name:'【采集告警】R750 硬盘 · 盘位1',brand:'Seagate',model:'ST4000NM0023',sn:'LC-D1',attrs:{capacity:'4 TB',interface:'SAS',form_factor:'3.5"'},placement:{kind:'host',parent_asset_id:s3.id,slot_no:1},peer_versions:{[s3.id]:host.version}});
  const d2=await create({category:'disk',name:'【采集告警】【暂定】旧盘',attrs:{capacity:'1 TB'},placement:{kind:'depot'}});
  const d3=await create({category:'disk',name:'【暂定】',placement:{kind:'depot'}});
  const l1=await create({category:'laptop',name:'财务笔记本',asset_no:'FIN-0099',owner_name:'责任人甲',owner_dept:'审计部',attrs:{cpu:'i5',ram:'16GB',os:'Win11'},placement:{kind:'depot'}});
  const dt1=await create({category:'desktop',name:'前台电脑',attrs:{cpu:'i3',ram:'8GB'},placement:{kind:'depot'}});
  const ap1=await create({category:'ap',name:'会议室AP',attrs:{mgmt_ip:'10.9.1.20',ssid_group:'office'},placement:{kind:'depot'}});
  const sw0=await create({category:'software',name:'零许可软件',attrs:{license_count:0},expires_at:'2027-03-01'});
  const sw2=await create({category:'software',name:'只有到期日的软件',expires_at:'2027-04-01'});
  const sub1=await create({category:'subscription',name:'云服务订阅',attrs:{cycle:'年付',account_name:'ops-account'},expires_at:'2027-05-01'});
  const sw=await create({category:'software',name:'ESXi 授权',attrs:{version:'7.0'},expires_at:'2027-01-31'});
  const allIds=[s1,s2,s3,o1,o2,o3,o4,x1,d1,d2,d3,l1,dt1,ap1,sw0,sw2,sub1,sw].map(a=>a.id);

  browser=await chromium.launch({headless:true});const c=await browser.newContext({viewport:{width:1440,height:960}});await c.addInitScript(()=>{if(!localStorage.getItem('token'))localStorage.setItem('token','fixture-1');});
  // The page re-saves its context on pagehide, so a stale sort written before reload would be overwritten. A staged value
  // is applied here instead: after the old document's pagehide and before the new document's scripts read the context.
  await c.addInitScript(()=>{const stale=sessionStorage.getItem('__itlStaleSort');if(!stale)return;sessionStorage.removeItem('__itlStaleSort');
   const c=JSON.parse(sessionStorage.getItem('itl-workspace-context-v1')||'null');if(c){c.sortBy=stale;c.tablePage=1;sessionStorage.setItem('itl-workspace-context-v1',JSON.stringify(c));}});
  const p=await c.newPage(),errors=[];p.on('pageerror',e=>errors.push(e.message));
  await p.goto(f.base+'/IT_Ledger.html#all');await p.locator('#itlTable tbody tr[data-detail-row]').first().waitFor();
  const heads=await p.locator('#itlTable thead th').evaluateAll(ths=>ths.map(t=>t.textContent.replace(/[⇅↑↓]/g,'').trim()));
  check('表头为类别｜资产｜用途｜状态｜序列号｜位置/保管人｜操作',JSON.stringify(heads)===JSON.stringify(['序号','类别','资产','用途','状态','序列号','位置 / 保管人','操作']));
  check('编号与责任人两列已收起',!heads.includes('编号')&&!heads.includes('责任人'));
  // Cell reader: main text without sub-lines and tags, sub-lines, tag texts and classes, per column, for one asset id.
  const cells=id=>p.locator(`#itlTable tr[data-detail-row="${id}"] td:not(.itl-sequence)`).evaluateAll(tds=>tds.map(td=>{
   const clone=td.cloneNode(true);clone.querySelectorAll('.itl-cell-sub,.itl-flag,.itl-locate-entry').forEach(n=>n.remove());
   return {main:clone.textContent.trim(),sub:[...td.querySelectorAll('.itl-cell-sub')].map(n=>n.textContent.trim()),
    button:td.querySelector('[data-detail]')?.textContent.trim()??null,aria:td.querySelector('[data-detail]')?.getAttribute('aria-label')??null,
    flags:[...td.querySelectorAll('.itl-flag')].map(n=>[n.textContent.trim(),n.className])};}));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  let r=await cells(s1.id);
  check('服务器：类别列为「服务器」无细分',r[0].main==='服务器'&&r[0].sub.length===0);
  check('服务器：资产列主行为品牌型号',r[1].button==='Dell PowerEdge R720');
  check('名称与用途相同：资产列不显示名称次行',r[1].sub.length===0);
  check('服务器：用途列为用途、次行为 IP',r[2].main==='中通文博HRD系统数据库'&&same(r[2].sub,['10.9.0.7']));
  check('资产按钮的可访问名称是登记名称',r[1].aria==='中通文博HRD系统数据库');
  r=await cells(s2.id);check('名称为「用途 + IP」：不重复显示名称',r[1].button==='Dell PowerEdge R750'&&r[1].sub.length===0&&r[2].main==='宿主机');
  r=await cells(s3.id);check('同型号设备：名称作为次行区分',r[1].button==='Dell PowerEdge R750'&&same(r[1].sub,['数据平台虚拟化']));
  r=await cells(o1.id);check('网络设备直接分类，交换机为细分，IP作次行',r[0].main==='网络设备'&&same(r[0].sub,['交换机'])&&r[2].main===''&&same(r[2].sub,['10.9.0.1']));
  r=await cells(o2.id);check('未知细分原样显示，无 IP 显示「—」',same(r[0].sub,['kvm'])&&r[2].main==='—');
  r=await cells(o3.id);check('细分为 constructor 时原样显示（不命中对象原型）',same(r[0].sub,['constructor']));
  r=await cells(o4.id);check('细分为 __proto__ 时原样显示（不命中对象原型）',same(r[0].sub,['__proto__']));
  r=await cells(d1.id);
  check('未巡检硬盘不显示名称派生健康标签',r[1].button==='Seagate ST4000NM0023'&&r[1].flags.length===0&&same(r[1].sub,['R750 硬盘 · 盘位1']));
  check('硬盘参数不混入用途列',r[2].main==='—');
  check('标记前缀的设备可访问名称保留完整名称',r[1].aria==='【采集告警】R750 硬盘 · 盘位1');
  r=await cells(d2.id);
  check('无型号回退名称，仅保留暂定标签',r[1].button==='旧盘'&&same(r[1].flags.map(x=>x[0]),['暂定'])&&r[1].flags[0][1].includes('itl-flag-tentative')&&r[1].sub.length===0);
  r=await cells(d3.id);check('名称只有标记：按钮显示「未命名资产」，标记只出现在标签里，可访问名称保留原名',r[1].button==='未命名资产'&&same(r[1].flags.map(x=>x[0]),['暂定'])&&r[1].sub.length===0&&r[1].aria==='【暂定】');
  const flagStyle=await p.locator(`#itlTable tr[data-detail-row="${d2.id}"] .itl-flag`).evaluateAll(ns=>ns.map(n=>{const s=getComputedStyle(n);return [s.color,s.backgroundColor];}));
  check('暂定标签警示色和底色生效',flagStyle.length===1&&flagStyle[0][0]==='rgb(234, 88, 12)'&&flagStyle[0][1]!=='rgba(0, 0, 0, 0)');
  r=await cells(l1.id);check('未填笔记本用途，不用内存参数代填',r[2].main==='—');
  r=await cells(dt1.id);check('台式机类别保留，未填写用途显示空值',r[0].main==='台式机'&&r[2].main==='—');
  r=await cells(ap1.id);check('AP管理IP作次行，不混入SSID参数',r[0].main==='无线 AP'&&r[2].main===''&&same(r[2].sub,['10.9.1.20']));
  r=await cells(sw.id);check('软件版本和到期日不混入用途',r[2].main==='—'&&r[2].sub.length===0);
  r=await cells(sw0.id);check('许可数量不混入用途',r[2].main==='—'&&r[2].sub.length===0);
  r=await cells(sw2.id);check('仅有到期日不会自动填用途',r[2].main==='—'&&r[2].sub.length===0);
  r=await cells(sub1.id);check('订阅周期和账号不混入用途',r[0].main==='订阅'&&r[2].main==='—'&&r[2].sub.length===0);
  r=await cells(x1.id);
  check('名称细分IP位置安全按原文显示',r[1].button===XSS_NAME&&r[1].aria===XSS_NAME&&same(r[0].sub,['<b>"s"</b>'])&&r[2].main===''&&same(r[2].sub,['"><i>ip</i>'])&&r[5].main.startsWith('<u>loc</u>'));
  check('这些值没有变成页面元素，也没有执行脚本',await p.locator(`#itlTable tr[data-detail-row="${x1.id}"]`).locator('img,b,i,u,script').count()===0&&await p.evaluate(()=>window.__xss===undefined));

  const visibleIds=()=>p.locator('#itlTable tbody tr[data-detail-row]').evaluateAll(trs=>trs.map(t=>Number(t.dataset.detailRow)));
  const searchIs=async(q,ids)=>{await p.locator('#itlSearch').fill(q);return same([...await visibleIds()].sort((a,b)=>a-b),[...ids].sort((a,b)=>a-b));};
  check('搜索完整型号「Dell PowerEdge R750」命中两台同型号',await searchIs('Dell PowerEdge R750',[s2.id,s3.id]));
  check('搜索 IP 命中',await searchIs('10.9.0.7',[s1.id]));
  check('搜索已收起列的资产编号仍可命中',await searchIs('FIN-0099',[l1.id]));
  check('搜索已收起列的责任人仍可命中',await searchIs('责任人甲',[l1.id]));
  check('搜索已收起列的责任部门仍可命中',await searchIs('审计部',[l1.id]));
  check('搜索细分类别中文名命中',await searchIs('交换机',[o1.id]));
  check('搜索用途命中',await searchIs('HRD',[s1.id]));
  await p.locator('#itlSearch').fill('');await p.waitForFunction(n=>document.querySelectorAll('#itlTable tbody tr[data-detail-row]').length===n,allIds.length);
  check('全部记录在同一页（排序比较用整页顺序）',(await visibleIds()).length===allIds.length);

  // Sort by the asset column, then restore after a reload: full row order and direction icon must both survive.
  const sortTh=p.locator('th[data-sort-by="asset_label"]');
  const icon=()=>sortTh.locator('.u-sort-icon').textContent();
  await sortTh.click();
  const labelsDesc=await p.locator('#itlTable tbody tr[data-detail-row] [data-detail]').evaluateAll(bs=>{const t=bs.map(b=>b.textContent.trim());return t.every((v,i)=>i===0||t[i-1].localeCompare(v,'zh-Hans-CN')>=0);});
  check('点「资产」表头按品牌型号倒序',labelsDesc&&await icon()==='↓');
  for(const dir of ['desc','asc']){
   if(dir==='asc'){await sortTh.click();check('再点一次变为正序',await icon()==='↑');}
   const before=await visibleIds();
   check(`排序上下文按新列名保存（${dir}）`,same(JSON.parse(await p.evaluate(()=>sessionStorage.getItem('itl-workspace-context-v1'))).sortBy,'asset_label'));
   await p.reload();await p.locator('#itlTable tbody tr[data-detail-row]').first().waitFor();
   check(`刷新后恢复「资产」列${dir==='desc'?'倒序':'正序'}：整列顺序与方向图标都一致`,same(await visibleIds(),before)&&await icon()===(dir==='desc'?'↓':'↑')&&await sortTh.evaluate(th=>th.classList.contains('active')));
  }
  const numericDesc=[...allIds].sort((a,b)=>b-a);
  for(const stale of ['owner_name','asset_no','name']){
   await p.evaluate(s=>sessionStorage.setItem('__itlStaleSort',s),stale);
   await p.reload();await p.locator('#itlTable tbody tr[data-detail-row]').first().waitFor();
   check(`旧排序上下文「${stale}」回到默认编号数值倒序（整列）且不报错`,errors.length===0&&same(await visibleIds(),numericDesc)&&await p.locator('#itlTable th.active').count()===0);
   check(`旧排序上下文「${stale}」的注入脚本已执行`,await p.evaluate(()=>sessionStorage.getItem('__itlStaleSort'))===null);
  }
  const overflow=await p.locator('#itlContent .u-corr-table-wrap').evaluate(w=>w.scrollWidth-w.clientWidth);
  check('1440 宽度下表格无横向滚动',overflow<=0);
  await p.screenshot({path:path.join(f.dir,'list-columns.png'),fullPage:true});
  check('无未捕获浏览器异常',errors.length===0);
  fs.writeFileSync(path.join(f.dir,'list-columns-result.json'),JSON.stringify({pass,errors},null,2));console.log(`LIST_COLUMNS_BROWSER PASS=${pass} FAIL=0`);
 }finally{if(browser)await browser.close();await f.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
