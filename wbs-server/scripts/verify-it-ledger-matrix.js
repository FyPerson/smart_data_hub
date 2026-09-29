// Single FAMILY member; existing independent suites remain runnable unchanged.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),{spawnSync}=require('child_process');
function run(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'it-ledger-matrix-'));let pass=0,fail=0;
 for(const file of ['verify-it-test-http.js','verify-it-ledger.js','verify-it-ledger-write.js','verify-it-ledger-actions.js','verify-it-ledger-mutations.js']){
  const r=spawnSync(process.execPath,[path.join(__dirname,file)],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:64*1024*1024});
  const output=String(r.stdout||'')+String(r.stderr||'');fs.writeFileSync(path.join(dir,file+'.log'),output);
  const reports=[...output.matchAll(/^PASS=(\d+) FAIL=(\d+)\s*$/gm)],last=reports.at(-1);
  const ok=r.status===0&&!r.error&&!r.signal&&last&&Number(last[1])>0&&Number(last[2])===0;
  if(ok){pass+=Number(last[1]);console.log('MATRIX '+file+' '+last[0].trim());}
  else{fail++;console.error('MATRIX RED '+file+' exit='+r.status+' '+(r.error||''));console.error(output.slice(-12000));}
 }
 console.log('MATRIX_ARTIFACTS='+dir);console.log(`PASS=${pass} FAIL=${fail}`);return fail?1:0;
}
module.exports={run};
if(require.main===module)process.exitCode=run();
