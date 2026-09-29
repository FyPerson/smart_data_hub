'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{spawnSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'it-reconcile-e2e-'));
try{
 const r=spawnSync(process.execPath,[path.join(__dirname,'verify-it-reconcile-r5-browser.js')],{cwd:path.resolve(__dirname,'..'),encoding:'utf8',windowsHide:true,timeout:180000,maxBuffer:8*1024*1024,env:{...process.env,IT_LEDGER_E2E_COPY:'1',IT_LEDGER_RECONCILE_LOW:'1'}});
 const output=String(r.stdout||'')+String(r.stderr||'');fs.writeFileSync(path.join(dir,'browser.log'),output);assert.equal(r.status,0,output.slice(-6000));assert.ok(!r.error&&!r.signal);
 const match=output.match(/^ISOLATED_ARTIFACTS=(.+)$/m);assert.ok(match);const artifacts=match[1].trim();
 const copy=JSON.parse(fs.readFileSync(path.join(artifacts,'db-copy.json'),'utf8')),cleanup=JSON.parse(fs.readFileSync(path.join(artifacts,'cleanup-manifest.json'),'utf8'));
 assert.equal(copy.seedHash,copy.copyHash);assert.ok(copy.seedRemoved&&!fs.existsSync(copy.seed));assert.ok(cleanup.completed&&cleanup.files.length>0&&cleanup.files.every(p=>!fs.existsSync(p)));
 const required=['真实multipart上传201','上传不导入资产或事件','found报告写200且无资产事件副作用','批量真实200与零资产写入','普通关闭200且台账全等','导出预览台账事件全表不变','1100x600导出按钮可达','非admin真实xlsx35列保留八行'];
 for(const label of required)assert.ok(output.includes('[OK] '+label),label);
 const report=output.match(/R5_BROWSER PASS=(\d+) FAIL=0/);assert.ok(report);assert.ok(Number(report[1])>=70);
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify({artifacts,copy,cleanup,required,pass:Number(report[1]),fail:0},null,2));
 console.log('R6_E2E_ARTIFACTS='+dir);console.log(`PASS=${report[1]} FAIL=0`);
}catch(e){console.error(e.stack);console.log('R6_E2E_ARTIFACTS='+dir);console.log('PASS=0 FAIL=1');process.exitCode=1;}
