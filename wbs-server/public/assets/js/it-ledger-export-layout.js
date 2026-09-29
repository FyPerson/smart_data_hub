/* R5 layout only. Values have already passed u-export's string normalization. */
(function(root,factory){const api=factory();if(typeof module!=='undefined'&&module.exports)module.exports=api;if(root)root.ITLedgerExportLayout=api;})(typeof window==='undefined'?null:window,function(){
  'use strict';
  function bytes(workbook,report,showHidden,X){
    if(!X?.CFB||!Array.isArray(report.columns)||!Array.isArray(report.rows)||report.groups?.length!==4||report.freeze_columns!==3||workbook.SheetNames.length!==1||typeof report.notice!=='string'||!Number.isFinite(Date.parse(report.exported_at)))throw new Error('导出布局元数据不完整。');
    const columns=report.columns,labels=columns.map(c=>c.label),grouped=report.groups.flatMap(g=>g.keys);
    if(new Set(labels).size!==labels.length||new Set(columns.map(c=>c.key)).size!==columns.length||grouped.join('\0')!==columns.map(c=>c.key).join('\0'))throw new Error('导出列或分组顺序不一致。');
    const original=workbook.Sheets[workbook.SheetNames[0]],sheet={};
    for(const [address,cell]of Object.entries(original)){
      if(address.startsWith('!'))continue;
      if(cell.t!=='s'||Object.hasOwn(cell,'f'))throw new Error('导出单元格必须是无公式的字符串。');
      const position=X.utils.decode_cell(address);sheet[X.utils.encode_cell({r:position.r+3,c:position.c})]={...cell};
    }
    const range=X.utils.decode_range(original['!ref']);if(range.e.c+1!==columns.length||range.e.r!==report.rows.length)throw new Error('归一化工作簿行列数与报告不一致。');sheet['!ref']=X.utils.encode_range({s:{r:0,c:0},e:{r:range.e.r+3,c:columns.length-1}});
    sheet.A1={t:'s',v:String(report.notice)};sheet.A2={t:'s',v:'导出时间（UTC）：'+report.exported_at};
    const merges=[{s:{r:0,c:0},e:{r:0,c:columns.length-1}},{s:{r:1,c:0},e:{r:1,c:columns.length-1}}];let start=0;
    for(const group of report.groups){sheet[X.utils.encode_cell({r:2,c:start})]={t:'s',v:group.label};if(group.keys.length>1)merges.push({s:{r:2,c:start},e:{r:2,c:start+group.keys.length-1}});start+=group.keys.length;}
    sheet['!merges']=merges;sheet['!cols']=columns.map(c=>({wch:['note','actual_fields','external_snapshot_diff','snapshot_current_diff'].includes(c.key)?32:20,hidden:!showHidden&&c.hidden===true}));
    sheet['!rows']=[{hpt:30},{hpt:20},{hpt:24},{hpt:28}];sheet['!autofilter']={ref:X.utils.encode_range({s:{r:3,c:0},e:{r:range.e.r+3,c:columns.length-1}})};
    const output=X.utils.book_new();X.utils.book_append_sheet(output,sheet,'对账报告');
    const zipped=X.write(output,{type:'array',bookType:'xlsx'}),archive=X.CFB.read(new Uint8Array(zipped),{type:'array'});
    const entry=X.CFB.find(archive,'/xl/worksheets/sheet1.xml');if(!entry)throw new Error('生成文件缺少工作表。');
    const xml=new TextDecoder().decode(entry.content),pattern=/<sheetViews>[\s\S]*?<\/sheetViews>/g;
    if((xml.match(pattern)||[]).length!==1)throw new Error('工作表视图结构不能安全定位。');
    const views='<sheetViews><sheetView workbookViewId="0"><pane xSplit="3" ySplit="4" topLeftCell="D5" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="D5" sqref="D5"/></sheetView></sheetViews>';
    X.CFB.utils.cfb_add(archive,'/xl/worksheets/sheet1.xml',new TextEncoder().encode(xml.replace(pattern,views)));
    const result=X.CFB.write(archive,{type:'array',fileType:'zip',compression:true});return result instanceof Uint8Array?result:new Uint8Array(result);
  }
  function download(workbook,filename,report,showHidden){
    const result=bytes(workbook,report,showHidden,window.XLSX),url=URL.createObjectURL(new Blob([result],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
    const link=document.createElement('a');link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  return {bytes,download};
});
