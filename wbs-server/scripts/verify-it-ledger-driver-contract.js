// Negative controls for orchestration, not substitutes for the real FAMILY run.
'use strict';
const vm=require('vm'),fs=require('fs'),path=require('path'),assert=require('assert/strict');
let pass=0;
function check(name,ok){assert.ok(ok,name);pass++;console.log('[OK] '+name);}
function matrix(first){
 let calls=0;const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'verify-it-ledger-matrix.js'),'utf8'),{
  __dirname,module,require:id=>id==='child_process'?{spawnSync(){return calls++===0?first:{status:0,stdout:'PASS=1 FAIL=0\n'};}}:id==='fs'?{mkdtempSync:()=>'/unused',writeFileSync(){}}:require(id),
  console:{log(){},error(){}},process:{execPath:process.execPath}
 });return {status:module.exports.run(),calls};
}
for(const [name,input]of [
 ['missing report',{status:0,stdout:'finished'}],['zero checks',{status:0,stdout:'PASS=0 FAIL=0'}],
 ['reported failure',{status:0,stdout:'PASS=2 FAIL=1'}],['nonzero exit',{status:1,stdout:'PASS=2 FAIL=0'}],
 ['timeout',{status:null,error:new Error('timeout'),stdout:'PASS=2 FAIL=0'}]
]){const r=matrix(input);check('matrix rejects '+name+' and runs remaining suites',r.status===1&&r.calls===4);}
check('matrix accepts positive reports',matrix({status:0,stdout:'PASS=2 FAIL=0'}).status===0);
for(const broken of [null,'ledger','reconcile']){
 let exit,calls=[];const output=[];
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'run-verify-family.js'),'utf8'),{
  __dirname,require:id=>id==='child_process'?{spawnSync(exe,args){calls.push(args);return {status:(broken==='ledger'&&args.includes('--matrix'))||(broken==='reconcile'&&args[0].endsWith('verify-it-reconcile.js'))?1:0,stdout:'fixture result'};}}:id==='fs'?{readdirSync:()=>['verify-sys-a.js','verify-sys-b.js']}:require(id),
  console:{log:x=>output.push(x)},process:{execPath:process.execPath,chdir(){},exit:code=>{exit=code;}}
 });
 check('FAMILY member failure propagation '+broken,exit===(broken?1:0)&&calls.filter(c=>c.includes('--matrix')).length===1&&output.some(s=>s.includes(broken?'FAMILY PASS=3 FAIL=1':'FAMILY PASS=4 FAIL=0')));
 check('FAMILY keeps five legacy guards and IT panel guard '+broken,calls.length===10);
}
console.log(`PASS=${pass} FAIL=0`);
