'use strict';
// Archive the committed base, then overlay the explicit candidate files before commit.
// No mutation ever touches the checkout; dependencies are resolved without junctions.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const {spawnSync} = require('child_process');
const root = path.resolve(__dirname, '../..');
const phase = process.argv[2] || 'c1';
let source = 'wbs-server/routes/it-ledger/inspection-sheets.js';
let suite = 'wbs-server/scripts/verify-it-ledger-inspection-sheets.js';
let cases = [
  ['month', "strftime('%Y-%m',submitted_at,'localtime')=strftime('%Y-%m','now','localtime') AS month_done", "julianday('now')-julianday(submitted_at)<=30 AS month_done", 'OV月份边界上月归档不计本月'],
  ['summary', "if (row.visibility === 'full') draft.abnormal = row.abnormal;", "draft.abnormal = row.abnormal || 0;", 'OV他人草稿summary不含abnormal'],
  ['deleted', 'FROM it_inspection_sheets WHERE deleted_at IS NULL ORDER BY submitted_at DESC,id DESC', 'FROM it_inspection_sheets ORDER BY submitted_at DESC,id DESC', 'OV已删除单不计入'],
  ['draft', "roomSheets.find(s => s.status === 'draft')", 'null', 'OV本月月初与草稿共存字段全等'],
  ['completed', "roomSheets.filter(s => ['submitted', 'archived'].includes(s.status))", "roomSheets.filter(s => s.status === 'submitted')", 'OV月份边界上月归档不计本月'],
  ['latest', 'ORDER BY submitted_at DESC,id DESC', 'ORDER BY id DESC', 'OV最近单按提交时间取归档单'],
  ['union', 'sheets.forEach(s => names.add(s.room_name));', 'void sheets;', 'OV机房集合和排序全等'],
  ['sort', '[...names].sort((a, b) => a.localeCompare(b))', '[...names].sort((a, b) => b.localeCompare(a))', 'OV机房集合和排序全等'],
  ['days', "julianday(date('now','localtime'))-julianday(date(submitted_at,'localtime'))", "julianday(date('now','localtime'))-julianday(date(submitted_at,'localtime'))+1", 'OV月份边界上月归档不计本月'],
  ['actor', 'u.display_name AS actor_name,l.at', 'NULL AS actor_name,l.at', 'OV日志姓名关联'],
  ['actor-missing', 'LEFT JOIN users u ON u.id=l.actor_id', 'JOIN users u ON u.id=l.actor_id', 'OV日志用户不存在保留日志且姓名null'],
  ['submitter', 'await displayName(q, last.submitted_by)', 'lastRow.created_by_name', 'OV代提交姓名取实际提交人'],
];
if (phase === 'c2') {
  source = 'wbs-server/public/assets/js/it-ledger-inspection-sheets.js';
  suite = 'wbs-server/scripts/verify-it-ledger-inspection-redesign-browser.js';
  cases = [
    ['draft-exempt', "row.visibility === 'summary' || row.status === 'draft' || filters.period === 'all'", "filters.period === 'all'", 'RD90天草稿始终显示'],
    ['counts', 'const rows = baseFilteredItems();', 'const rows = lastItems;', 'RD初始页签计数全等'],
    ['priority', "draft ? '填写中' : room.this_month_done ? '本月已巡检' : '本月未巡检'", "room.this_month_done ? '本月已巡检' : draft ? '填写中' : '本月未巡检'", 'RD卡片状态优先草稿'],
    ['ninety', 'days <= 90', 'days < 90', 'RD默认90天提交边界全等'],
    ['year', "day.slice(0,4) === today.slice(0,4)", 'true', 'RD今年排除去年提交'],
    ['search-name', "[row.room_name, row.created_by_name || '']", '[row.room_name]', 'RD按巡检人搜索'],
    ['room-filter', "if (filters.room && row.room_name !== filters.room) return false;", 'void filters.room;', 'RD机房下拉结果'],
    ['clock', 'const today = L.serverToday();', 'const today = inspectionDate(new Date(Date.now()).toISOString());', 'RD浏览器时钟漂移不影响筛选'],
    ['unknown-clock', 'if (!today) return false;', 'if (!today) return true;', 'RD未知服务器日期只保留草稿'],
    ['future', 'days >= 0 && days <= 90', 'days <= 90', 'RD未来提交不计入近90天'],
    ['summary-ui', 'const abnormal = draft ? draft.abnormal : room.last_abnormal;', 'const abnormal = draft ? (draft.abnormal || 0) : room.last_abnormal;', 'RD他人草稿概览不泄露异常'],
    ['leave-search', "filters.period = '90'; filters.search = ''; overviewData = null;", "filters.period = '90'; overviewData = null;", 'RD离开清理新增筛选'],
  ];
} else if (phase === 'c3') {
  source = 'wbs-server/public/assets/js/it-ledger-inspection-sheets.js';
  suite = 'wbs-server/scripts/verify-it-ledger-inspection-redesign-form-browser.js';
  cases = [
    ['missing-photos', '...missing.missingPhotoPositions.map(position => {', '...[].map(position => {', 'RF缺失清单含全部照片阻塞'],
    ['missing-focus', 'target.focus({ preventScroll: true });', 'void target;', 'RF缺失项聚焦 unfilled:1'],
    ['missing-note', "...missing.missingNoteItemIds.map(id => itemEntry('note', id, ' · 缺异常说明'))", "...[].map(id => itemEntry('note', id, ' · 缺异常说明'))", 'RF缺失清单含全部照片阻塞'],
    ['number-unit', "it.item_key === 'temperature' ? '℃' : '%'", "it.item_key === 'temperature' ? '%' : '℃'", 'RF温湿度单位'],
  ];
} else if (phase === 'c4') {
  source = 'wbs-server/public/assets/js/it-ledger-inspection-sheets.js';
  suite = 'wbs-server/scripts/verify-it-ledger-inspection-redesign-detail-browser.js';
  cases = [
    ['rack-merge', "items.length === 4 && items.every(it => it.result === 'ok')", "items.length === 4 && items.some(it => it.result === 'ok')", 'DD机柜合并与逐项标签全等'],
    ['log-create', 'const operationLog = [...detail.log].sort', "const operationLog = detail.log.filter(row => row.action !== 'create').sort", 'DD操作记录含创建且倒序'],
    ['log-order', 'b.at.localeCompare(a.at) || b.id - a.id', 'a.at.localeCompare(b.at) || a.id - b.id', 'DD操作记录含创建且倒序'],
    ['actor-fallback', "row.actor_name || ('操作人 #' + row.actor_id)", "row.actor_name || '未知'", 'DD缺失用户回退操作人编号'],
    ['rack-single', "items.filter(visible).map(it => tag(r.name + ' · ' + it.item_label, unfilled(it)))", "[].map(it => tag(r.name + ' · ' + it.item_label, unfilled(it)))", 'DD机柜合并与逐项标签全等'],
    ['unfilled', "missing ? ' · 未填' : ''", "missing ? '' : ''", 'DD未填标签完整展示'],
    ['soft-range', "value<range[0]||value>range[1]", 'false', 'DD参考范围超出弱提示'],
  ];
} else assert.equal(phase, 'c1');
const stampResult = spawnSync('powershell.exe',['-NoProfile','-Command','Get-Date -Format yyyyMMdd-HHmmss-fff'],{encoding:'utf8',windowsHide:true,timeout:10000,killSignal:'SIGKILL'});
assert.equal(stampResult.status,0);
const stamp = stampResult.stdout.trim();
const parent = path.resolve('E:/tmp/insp-redesign/mut');
const dir = path.join(parent, phase+'-'+stamp);
const logs = path.resolve('E:/tmp/insp-redesign/'+phase);
fs.mkdirSync(dir,{recursive:true}); fs.mkdirSync(logs,{recursive:true});
const report = [];
const overallDeadline = Date.now() + 300000;
function run(cmd,args,options={}) {
  assert.ok(Date.now() < overallDeadline, 'mutation driver overall timeout');
  return spawnSync(cmd,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:Math.min(300000, overallDeadline-Date.now()),killSignal:'SIGKILL',maxBuffer:16*1024*1024,...options});
}
try {
  const archive = path.join(dir,'base.tar');
  assert.equal(run('git',['archive','--format=tar','--output='+archive,'HEAD','wbs-server']).status,0);
  assert.equal(run('tar',['-xf',archive,'-C',dir]).status,0);
  const candidates = [source,suite];
  if (phase !== 'c1') candidates.push('wbs-server/public/assets/css/it-ledger.css','wbs-server/public/IT_Ledger.html');
  for (const file of candidates) fs.copyFileSync(path.join(root,file),path.join(dir,file));
  const original = fs.readFileSync(path.join(dir,source),'utf8');
  const env = {...process.env,NODE_PATH:[path.join(root,'wbs-server/node_modules'),path.join(root,'node_modules')].join(path.delimiter)};
  for (const [name,from,to,target] of [['clean',null,null,null],...cases]) {
    if (from) assert.equal(original.split(from).length,2,'unique mutation '+name);
    fs.writeFileSync(path.join(dir,source),from ? original.replace(from,to) : original);
    const result = run(process.execPath,[path.join(dir,suite)],{cwd:dir,env});
    const output = (result.stdout||'')+(result.stderr||'');
    const log = path.join(logs,'mutation-'+name+'-'+stamp+'.log'); fs.writeFileSync(log,output);
    assert.equal(result.error,undefined,'execution error '+name);
    const first = output.match(/AssertionError[^\n]*: ([^\n]+)/);
    if (name === 'clean') assert.equal(result.status,0,output);
    else { assert.notEqual(result.status,0,'mutation survived '+name); assert.equal(first && first[1],target,output); }
    report.push({name,status:result.status,first:first && first[1],log});
    console.log(JSON.stringify(report[report.length-1]));
  }
  fs.writeFileSync(path.join(logs,'mutations-'+stamp+'.json'),JSON.stringify(report,null,2));
} finally {
  assert.equal(path.dirname(path.resolve(dir)),parent);
  const rejectLinks = p => { for (const ent of fs.readdirSync(p,{withFileTypes:true})) { const child=path.join(p,ent.name); assert.equal(fs.lstatSync(child).isSymbolicLink(),false,'refuse linked cleanup'); if(ent.isDirectory()) rejectLinks(child); } };
  rejectLinks(dir); fs.rmSync(dir,{recursive:true,force:true});
}
