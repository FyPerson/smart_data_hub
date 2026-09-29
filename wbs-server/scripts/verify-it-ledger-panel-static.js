// IT ledger panel registration + exact label coverage. Sys-specific guards stay unchanged.
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),acorn=require('acorn');
const publicRoot=path.resolve(__dirname,'../public');
const read=p=>fs.readFileSync(path.join(publicRoot,p),'utf8');
const modules=['it-ledger','it-ledger-forms','it-ledger-records','it-ledger-racks','it-ledger-disks','it-ledger-category-views','it-ledger-aps','it-ledger-stocktakes','it-ledger-evidence','it-ledger-inspection-sheets','it-ledger-inspections','it-ledger-export-layout','it-ledger-reconciles'];
const expected={
 categories:{server:'服务器',disk:'硬盘',laptop:'笔记本',desktop:'台式机',ap:'无线 AP',other:'其他设备',software:'软件',subscription:'订阅'},
 statuses:{in_service:'在用',in_depot:'可用',faulty:'故障',to_retire:'待报废',retired:'已报废',active:'有效',cancelled:'已停用'},
 actionNames:{register:'登记',update:'编辑资料',rack_in:'上架',rack_out:'下架',rack_move:'迁柜',rack_relocate:'柜内移位',mark_status:'调整库房状态',retire:'报废',disk_mount:'装盘',disk_unmount:'拆盘',disk_swap:'换盘',disk_move:'移盘',assign:'领用',reassign:'更换保管人',return:'归还',place:'放置',relocate:'移动位置',ap_place:'安装 AP',ap_relocate:'移动 AP',ap_unmount:'拆下 AP',renew:'续费',cancel:'停用'}
};
function walk(node,fn){if(!node||typeof node!=='object')return;fn(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(v=>walk(v,fn));else if(value&&typeof value==='object')walk(value,fn);}}
function literalObject(ast,name){const nodes=[];walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.id.name===name)nodes.push(n.init);});assert.equal(nodes.length,1,'one '+name);assert.equal(nodes[0].type,'ObjectExpression');const out={};for(const p of nodes[0].properties){assert.equal(p.type,'Property');assert.equal(p.computed,false);assert.equal(p.value.type,'Literal');const key=p.key.name??p.key.value;assert.ok(!Object.hasOwn(out,key));out[key]=p.value.value;}return out;}
function validate(html,sources){
 assert.ok(/<body class="unified-page itl-plan-b">/.test(html));
 assert.ok(/it-ledger-plan-b\.css\?v=[^"\s]+/.test(html),'Plan B theme registered after base stylesheet');
 // Copying the complete standard header also guards SVGs, dropdown children,
 // nav-item count, and userProfileArea nesting without a permissive regex parser.
 const navbar=html.match(/<nav class="navbar fixed-header">[\s\S]*?<\/nav>/);
 const standard=read('Legacy_Archive.html').match(/<nav class="navbar fixed-header">[\s\S]*?<\/nav>/);
 assert.ok(navbar,'standard fixed navbar exists');
 assert.ok(standard,'reference navbar exists');
 assert.equal(navbar[0].replace(/\s+/g,' '),standard[0].replace(/\s+/g,' '),'complete standard navbar structure');
 assert.match(html,/<aside class="itl-sidebar"[^>]*>[\s\S]*?<nav id="itlTabs"/,'module navigation lives in sidebar');
 assert.match(html,/<div class="itl-workspace" id="itlWorkspace">[\s\S]*?<section id="itlContent"[\s\S]*?<aside id="itlDrawer"/,'content and detail share the workspace');
 assert.match(html,/<h1 id="itlViewTitle">/,'view-specific heading exists');
 const references=[...html.matchAll(/src="assets\/js\/(it-ledger[^"?]*)\.js\?v=([^"\s]+)"/g)];
 assert.deepEqual(references.map(x=>x[1]),modules,'complete ordered module registration');
 const asts={};for(const m of modules)asts[m]=acorn.parse(sources[m],{ecmaVersion:'latest'});
 for(const name of Object.keys(expected))assert.deepEqual(literalObject(asts['it-ledger'],name),expected[name],'exact '+name);
 const authCalls=[];
 for(const m of modules)walk(asts[m],n=>{
  if(n.type==='CallExpression'&&n.callee.type==='MemberExpression'&&['fetch','authFetch'].includes(n.callee.computed?n.callee.property.value:n.callee.property.name))throw Error('Member request bypasses authenticated entry');
  if(n.type==='CallExpression'&&n.callee.type==='Identifier'&&['fetch','authFetch'].includes(n.callee.name)){
   assert.equal(n.callee.name,'authFetch','all direct requests authenticated');authCalls.push(m);
  }
 });
 // R5 frozen implementation explicitly has authenticated binary source-file download,
 // while L.api parses JSON. Inspection evidence adds one authenticated binary entry.
 // Assert the complete three-call list exactly, never exempt arbitrary callers.
 assert.deepEqual(authCalls,['it-ledger','it-ledger-evidence','it-ledger-reconciles']);
 assert.ok(sources['it-ledger-evidence'].includes("authFetch('/api/it-assets'+url)"));
 assert.ok(sources['it-ledger-reconciles'].includes('authFetch(`/api/it-assets/reconciles/${bid}/source-file`)'));
 assert.ok(sources['it-ledger'].includes("getToken()")&&sources['it-ledger'].includes("'/api/it-assets'"));
 assert.ok(sources['it-ledger-reconciles'].includes('人工声明，待新批次验证'));
 assert.ok(/it-ledger\.css\?v=[^"\s]+/.test(html));
}
const html=read('IT_Ledger.html'),sources=Object.fromEntries(modules.map(m=>[m,read('assets/js/'+m+'.js')]));
let pass=0;function check(name,fn){fn();pass++;console.log('[OK] '+name);}
check('panel and labels exact registration',()=>validate(html,sources));
check('rack U geometry CSS and JS agree',()=>{
 const cssValues=[...read('assets/css/it-ledger.css').matchAll(/--itl-u-h:\s*(\d+)px\s*;/g)];
 assert.equal(cssValues.length,1,'one CSS U height');
 const jsValues=[];walk(acorn.parse(sources['it-ledger-racks'],{ecmaVersion:'latest'}),node=>{if(node.type==='VariableDeclarator'&&node.id.name==='U_PX')jsValues.push(node.init);});
 assert.equal(jsValues.length,1,'one JS U height');assert.equal(jsValues[0].type,'Literal');
 assert.equal(Number(cssValues[0][1]),jsValues[0].value,'rack U geometry CSS and JS agree');
});
check('missing nav-right fails closed',()=>assert.throws(()=>validate(html.replace('class="nav-right"','class="wrong"'),sources)));
check('profile outside nav-right fails closed',()=>assert.throws(()=>validate(html.replace('<div id="userProfileArea"></div>','').replace('</nav>','<div id="userProfileArea"></div></nav>'),sources)));
check('missing dropdown fails closed',()=>assert.throws(()=>validate(html.replace('class="nav-dropdown"','class="wrong"'),sources)));
check('missing workspace sidebar fails closed',()=>assert.throws(()=>validate(html.replace('class="itl-sidebar"','class="wrong"'),sources)));
check('missing detail workspace fails closed',()=>assert.throws(()=>validate(html.replace('id="itlWorkspace"','id="wrong"'),sources)));
check('missing module fails closed',()=>assert.throws(()=>validate(html.replace(/<script src="assets\/js\/it-ledger-racks[^>]+><\/script>/,''),sources)));
check('missing label fails closed',()=>assert.throws(()=>validate(html,{...sources,'it-ledger':sources['it-ledger'].replace("rack_in: '上架',",'')})));
check('wrong label fails closed',()=>assert.throws(()=>validate(html,{...sources,'it-ledger':sources['it-ledger'].replace("rack_in: '上架'","rack_in: '错误'")})));
check('unauthenticated fetch fails closed',()=>assert.throws(()=>validate(html,{...sources,'it-ledger-forms':sources['it-ledger-forms']+'\nfetch("/api/it-assets");'})));
check('window fetch fails closed',()=>assert.throws(()=>validate(html,{...sources,'it-ledger-forms':sources['it-ledger-forms']+'\nwindow.fetch("/api/it-assets");'})));
check('backend asset events have labels',()=>{
 const ast=acorn.parse(fs.readFileSync(path.join(__dirname,'../routes/it-ledger/index.js'),'utf8'),{ecmaVersion:'latest'});const found=[];
 walk(ast,n=>{if(n.type==='VariableDeclarator'&&n.id.name==='ACTIONS')found.push(n.init);});assert.equal(found.length,1);const init=found[0];assert.equal(init.type,'NewExpression');assert.equal(init.callee.name,'Set');assert.equal(init.arguments.length,1);assert.equal(init.arguments[0].type,'ArrayExpression');
 const keys=init.arguments[0].elements.map(n=>{assert.equal(n.type,'Literal');return n.value;});
 const all=['rack_in','rack_out','rack_move','rack_relocate','place','relocate','ap_place','ap_relocate','assign','reassign','return','disk_mount','disk_unmount','disk_swap','disk_move','mark_status','retire','renew','cancel','update','register','acl_grant','acl_revoke','floor_update'];
 assert.deepEqual(keys,all);const labels=literalObject(acorn.parse(sources['it-ledger'],{ecmaVersion:'latest'}),'actionNames');
 for(const key of all.slice(0,21))assert.equal(typeof labels[key],'string',key);
});
console.log(`PASS=${pass} FAIL=0`);
