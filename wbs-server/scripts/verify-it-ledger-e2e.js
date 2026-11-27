// Eight production UI paths in isolated DB copies, plus exact low viewport.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'it-ledger-e2e-')),root=path.resolve(__dirname,'..');
const paths=[
 ['登记机柜初态','c7','server 表单真实登记/位置闭环'],
 ['机柜移位迁柜','c8','跨柜走rack_move真实200'],
 ['换盘','c9','换盘三行状态位置版本'],['移盘','c9','移盘主与两宿主各版本加一'],
 ['AP放置跨层','c10','跨楼层相对坐标'],['领用归还','c10','终端归还待报废且保管人位置清空'],
 ['续费','c10','续费后离开90天列表'],['盘点闭环','c11','无pending正常关闭200']
];
let pass=0,fail=0;const runs=[];
// Per-stage child timeout. 2026-10-31 #200 C1b-2: only inspection-sheet-form gets 420 s; basis = the before/after-C1a timed runs of that single script took
// 190-218 s (machine load 82-100%) so the old uniform 180 s limit sat on the line; 420 s is about 2x the measured time. Every other stage keeps 180 s.
const STAGE_TIMEOUT_MS={'inspection-sheet-form':420000},DEFAULT_STAGE_TIMEOUT_MS=180000;
const STAGES=['c7','c8','c9','c10','c11','low','workspace','priority','inspections','evidence','records','sheets','inspection-sheet-form','inspection-photo'];
// Prescreen C1b-2 LOW-5: a misspelt key would silently fall back to the 180 s default, so every key must be a real stage (hard rule, throws before any stage runs).
for(const key of Object.keys(STAGE_TIMEOUT_MS))if(!STAGES.includes(key))throw new Error('STAGE_TIMEOUT_MS key is not in the stage list: '+key);
for(const stage of STAGES){
 const script='verify-it-ledger-'+stage+'-browser.js';
 const r=spawnSync(process.execPath,[path.join(__dirname,script)],{cwd:root,encoding:'utf8',windowsHide:true,timeout:STAGE_TIMEOUT_MS[stage]??DEFAULT_STAGE_TIMEOUT_MS,maxBuffer:8*1024*1024,env:{...process.env,IT_LEDGER_E2E_COPY:'1'}});
 const output=String(r.stdout||'')+String(r.stderr||'');fs.writeFileSync(path.join(dir,stage+'.log'),output);
 try{
  assert.equal(r.status,0,output.slice(-4000));assert.ok(!r.error&&!r.signal);
  const report=output.match(/_BROWSER PASS=(\d+) FAIL=0/);assert.ok(report,'positive browser report');
  const match=output.match(/^ISOLATED_ARTIFACTS=(.+)$/m);assert.ok(match,'artifact path');const artifacts=match[1].trim();
  const copy=JSON.parse(fs.readFileSync(path.join(artifacts,'db-copy.json'),'utf8')),cleanup=JSON.parse(fs.readFileSync(path.join(artifacts,'cleanup-manifest.json'),'utf8'));
  assert.equal(copy.seedHash,copy.copyHash);assert.equal(copy.seedRemoved,true);assert.ok(!fs.existsSync(copy.seed));assert.equal(cleanup.completed,true);assert.ok(cleanup.files.length>0&&cleanup.files.every(p=>!fs.existsSync(p)));
  for(const [name,s,label]of paths.filter(x=>x[1]===stage)){assert.ok(output.includes('[OK] '+label),'path evidence '+name);console.log('PATH OK '+name);}
  pass+=Number(report[1]);runs.push({stage,pass:Number(report[1]),artifacts,copy,cleanup});console.log('E2E '+stage+' '+report[0]);
 }catch(e){fail++;console.error('E2E RED '+stage+' '+e.message);}
}
fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({paths,runs,pass,fail},null,2));
console.log('E2E_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=${fail}`);process.exitCode=fail?1:0;
