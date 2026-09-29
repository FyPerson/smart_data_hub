'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),source=path.join(root,'routes/it-ledger'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'it-reconcile-r6-mutations-'));
const files=['index.js','invariants.js','single-asset-actions.js','stocktakes.js','reconcile-parser.js','reconciles.js','inspections.js','inspection-collector.js','inspection-collect.js','record-management.js','inspection-sheets.js','inspection-photo-files.js'];
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),before=Object.fromEntries(files.map(f=>[f,hash(path.join(source,f))]));
let pass=0;function check(name,ok){assert.ok(ok,name);pass++;console.log('[OK] '+name);}
function probe(kind,factory,label){
 const evidence=path.join(dir,label+'.json'),r=spawnSync(process.execPath,[path.join(__dirname,'verify-it-reconcile-mutation-probe.js'),kind,factory,evidence],{cwd:root,encoding:'utf8',windowsHide:true,timeout:45000,env:{...process.env,IT_LEDGER_E2E_COPY:'0',NODE_PATH:path.join(root,'node_modules')}});
 fs.writeFileSync(path.join(dir,label+'.log'),String(r.stdout||'')+String(r.stderr||''));
 if(r.error||r.signal||!fs.existsSync(evidence))throw Error('Probe missed target '+label+' '+r.error+' '+r.stderr);
 return {status:r.status,data:JSON.parse(fs.readFileSync(evidence,'utf8'))};
}
try{
 for(const [kind,needle,replacement]of [
  ['closed',"if (row.status !== 'open') throw err(409", "if (false && row.status !== 'open') throw err(409"],
  ['terminal','if (!RECONCILE_TRANSITIONS[before.result]?.has(body.result))','if (false && !RECONCILE_TRANSITIONS[before.result]?.has(body.result))']
 ]){
  const golden=probe(kind,path.join(source,'index.js'),kind+'-golden');check(kind+' original exact409 no writes',golden.status===0&&golden.data.ok&&golden.data.unchanged);
  const clone=path.join(dir,kind);fs.mkdirSync(clone);for(const file of files)fs.copyFileSync(path.join(source,file),path.join(clone,file));
  const file=path.join(clone,'reconciles.js'),text=fs.readFileSync(file,'utf8');check(kind+' exact one mutation',text.split(needle).length===2);fs.writeFileSync(file,text.replace(needle,replacement));
  const mutant=probe(kind,path.join(clone,'index.js'),kind+'-mutant');check(kind+' same golden assertion fails',mutant.status===1&&mutant.data.ok===false);
  check(kind+' real200 report change but ledger unchanged',mutant.data.response.status===200&&mutant.data.unchanged===false&&mutant.data.ledgerUnchanged);
 }
 check('production source SHA unchanged',files.every(f=>hash(path.join(source,f))===before[f]));
 fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({files,before,pass},null,2));console.log('R6_MUTATION_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=0`);
}catch(e){console.error(e.stack);console.log('R6_MUTATION_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=1`);process.exitCode=1;}
