'use strict';
const fs=require('fs'),XLSX=require('xlsx');
const {createFixture}=require('./it-ledger-browser-fixture');
async function main(){
 const [kind,factoryPath,evidence]=process.argv.slice(2),f=await createFixture({factoryPath,cleanup:true});
 const call=async(method,url,body,status)=>{const r=await f.api(method,url,body);if(r.status!==status)throw Error('SETUP '+JSON.stringify(r));return r.body;};
 const snapshot=async()=>{const out={};for(const t of ['it_assets','it_asset_events','it_reconciles','it_reconcile_items'])out[t]=await f.all('SELECT * FROM '+t+' ORDER BY id');return out;};
 try{
  await call('POST','',{category:'other',name:'probe',asset_no:'R6-1',placement:{kind:'depot'}},201);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['编号','资产名称'],['R6-1','probe']]),'固定资产');
  const form=new FormData();form.append('file',new Blob([XLSX.write(wb,{type:'buffer',bookType:'xlsx'})]),'probe.xlsx');
  const uploaded=await fetch(f.base+'/api/it-assets/reconciles',{method:'POST',headers:{Authorization:'Bearer fixture-1'},body:form});if(uploaded.status!==201)throw Error('SETUP upload '+await uploaded.text());
  const batch=await uploaded.json(),detail=await call('GET','/reconciles/'+batch.id,undefined,200);if(detail.items.length!==1||detail.items[0].result!=='pending')throw Error('SETUP shape');
  const endpoint='/reconciles/'+batch.id+'/items/'+detail.items[0].id+'/check';let result;
  if(kind==='closed'){await call('POST','/reconciles/'+batch.id+'/close',{force:true},200);result='found';}
  else if(kind==='terminal'){await call('PUT',endpoint,{result:'found'},200);result='missing';}
  else throw Error('Unknown mutation');
  const before=await snapshot(),response=await f.api('PUT',endpoint,{result}),after=await snapshot();
  const unchanged=JSON.stringify(before)===JSON.stringify(after),ledgerUnchanged=JSON.stringify([before.it_assets,before.it_asset_events])===JSON.stringify([after.it_assets,after.it_asset_events]);
  const ok=response.status===409&&response.body.code==='ACTION_NOT_ALLOWED_IN_STATUS'&&unchanged;
  fs.writeFileSync(evidence,JSON.stringify({kind,response,before,after,unchanged,ledgerUnchanged,ok},null,2));console.log('TARGET_ASSERTION '+(ok?'PASS':'FAIL'));process.exitCode=ok?0:1;
 }finally{await f.close();}
}
main().catch(e=>{console.error('PROBE_SETUP_OR_RUNTIME_ERROR',e);process.exitCode=2;});
