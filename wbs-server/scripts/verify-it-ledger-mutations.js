'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict');
const {spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),source=path.join(root,'routes/it-ledger');
const files=['index.js','invariants.js','single-asset-actions.js','stocktakes.js','reconcile-parser.js','reconciles.js','inspections.js','inspection-collector.js','inspection-collect.js','record-management.js','inspection-sheets.js','inspection-photo-files.js'];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const before=Object.fromEntries(files.map(f=>[f,hash(path.join(source,f))]));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'it-ledger-c12-mutations-'));
let pass=0;const check=(name,ok)=>{assert.ok(ok,name);pass++;console.log('[OK] '+name);};
const variants=[
 ['version','index.js','if (primary.version !== body.expected_version) {','if (false && primary.version !== body.expected_version) {'],
 ['overlap','invariants.js','if (lo <= ohi && olo <= hi) {','if (false && lo <= ohi && olo <= hi) {'],
 ['closed','stocktakes.js',"if (row.status !== 'open') throw err(400, 'LEDGER_BAD_REQUEST', 'status', '关闭后核对字段冻结');", "if (false && row.status !== 'open') throw err(400, 'LEDGER_BAD_REQUEST', 'status', '关闭后核对字段冻结');"]
];
function probe(kind,factory,label){
 const evidence=path.join(dir,label+'.json');
 const r=spawnSync(process.execPath,[path.join(__dirname,'verify-it-ledger-mutation-probe.js'),kind,factory,evidence],{cwd:root,encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,NODE_PATH:path.join(root,'node_modules')}});
 fs.writeFileSync(path.join(dir,label+'.log'),String(r.stdout||'')+String(r.stderr||''));
 if(r.error||r.signal||!fs.existsSync(evidence))throw Error('Probe did not reach target: '+label+' '+r.error+' '+r.stderr);
 return {status:r.status,data:JSON.parse(fs.readFileSync(evidence,'utf8'))};
}
try{
 for(const [kind,file,needle,replacement]of variants){
  const golden=probe(kind,path.join(source,'index.js'),kind+'-golden');
  check(kind+' golden exit0 and exact rejection/no-write',golden.status===0&&golden.data.ok===true&&golden.data.unchanged===true);
  const clone=path.join(dir,kind);fs.mkdirSync(clone);for(const f of files)fs.copyFileSync(path.join(source,f),path.join(clone,f));
  const target=path.join(clone,file),text=fs.readFileSync(target,'utf8');check(kind+' mutation hits exactly once',text.split(needle).length===2);fs.writeFileSync(target,text.replace(needle,replacement));
  const mutant=probe(kind,path.join(clone,'index.js'),kind+'-mutant');
  check(kind+' mutant reaches golden assertion and fails',mutant.status===1&&mutant.data.ok===false);
  check(kind+' mutant actually accepts and changes rows',mutant.data.response.status===200&&mutant.data.unchanged===false);
 }
 check('production source hashes unchanged',files.every(f=>hash(path.join(source,f))===before[f]));
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({files,before,pass},null,2));
 console.log('MUTATION_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=0`);
}catch(e){console.error(e.stack);console.log('MUTATION_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=1`);process.exitCode=1;}
