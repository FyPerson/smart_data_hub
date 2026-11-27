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
  // #200 C0：周期判据本体的边界变异在 verify-it-ledger-inspection-period.js 里杀；这里只证接口把「是否落在本期」交给了判据。
  ['period', 'inspectionPeriod.inPeriod(s.submitted_day, period)', 'true', 'OV周期边界上周归档不计本周'],
  ['summary', "if (row.visibility === 'full') draft.abnormal = row.abnormal;", "draft.abnormal = row.abnormal || 0;", 'OV他人草稿summary不含abnormal'],
  ['deleted', 'FROM it_inspection_sheets WHERE deleted_at IS NULL ORDER BY submitted_at DESC,id DESC', 'FROM it_inspection_sheets ORDER BY submitted_at DESC,id DESC', 'OV已删除单不计入'],
  ['draft', "roomSheets.find(s => s.status === 'draft')", 'null', 'OV本周与草稿共存字段全等'],
  ['completed', "roomSheets.filter(s => ['submitted', 'archived'].includes(s.status))", "roomSheets.filter(s => s.status === 'submitted')", 'OV周期边界上周归档不计本周'],
  ['latest', 'ORDER BY submitted_at DESC,id DESC', 'ORDER BY id DESC', 'OV最近单按提交时间取归档单'],
  ['union', 'sheets.forEach(s => names.add(s.room_name));', 'void sheets;', 'OV机房集合和排序全等'],
  ['sort', '[...names].sort((a, b) => a.localeCompare(b))', '[...names].sort((a, b) => b.localeCompare(a))', 'OV机房集合和排序全等'],
  ['days', "julianday(?)-julianday(date(submitted_at,'localtime'))", "julianday(?)-julianday(date(submitted_at,'localtime'))+1", 'OV周期边界上周归档不计本周'],
  // #200 C0 修复批 2：OV 组经 testHooks.overviewNowMs 把「现在」钉在 2026-11-16（周一）00:15 本地，OV-B 提交于同一时刻、OV-C 提交于前一天周日 23:30，
  // 与真实运行日无关；下面三个变异管住「本地日期口径（提交日、今天各一处）」与「自然周而非滚动 7 天」，在任何运行日都恒被杀。
  // 漏写 localtime（提交日）：周一 00:15 本地在 UTC 下是上周日 16:15，submitted_day 变成上周日 → OV-B 被判到上周。
  // 时区前提：只在夹具时刻（2026-11-16 00:15 本地）的 UTC 日期与本地日期不同（即本机时区早于 UTC 超过 15 分钟，本机 UTC+8）时与正确实现有差异；
  // 不满足时按下方 SKIP_REASONS 跳过并进 report（不算失败）。
  ['localtime', "date(submitted_at,'localtime') AS submitted_day", "date(submitted_at) AS submitted_day", 'OV本周与草稿共存字段全等'],
  // 漏写 localtime（今天）：固定时刻 UTC 日期是上周日，period 退到上一周、days_since 随之错位，空库响应的 period 第一个对不上。
  ['today-localtime', "SELECT date(?,'unixepoch','localtime') AS today", "SELECT date(?,'unixepoch') AS today", 'OV空库响应全等'],
  // 滚动 7 天冒充自然周：OV-C 距「现在」1 天，< 7 判为本期，与周边界期望相反。
  ['rolling7', 'inspectionPeriod.inPeriod(s.submitted_day, period)', 's.days_since < 7', 'OV周期边界上周归档不计本周'],
  // 月档（#200 C0 修复批 2）：默认 week 下 OV 组全过，这两个变异只被文件末尾的月档用例（IT_INSPECTION_CYCLE=month + 固定 2026-11-19 10:00）抓住。
  ['cycle-hardwired', 'inspectionPeriod.periodOf(today, cycleConfig.cycle)', "inspectionPeriod.periodOf(today, 'week')", 'OV月周期响应period全等'],
  ['rooms-week-only', 'inspectionPeriod.inPeriod(s.submitted_day, period)', "inspectionPeriod.inPeriod(s.submitted_day, inspectionPeriod.periodOf(today, 'week'))", 'OV月周期本月归档计入上月末不计'],
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
    ['priority', "draft ? '填写中' : room.period_done ? word + '已巡检' : word + '未巡检'", "room.period_done ? word + '已巡检' : draft ? '填写中' : word + '未巡检'", 'RD卡片状态优先草稿'],
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
    ['missing-focus', 'target.focus({ preventScroll: true });', 'void target;', 'RF缺失项聚焦 unfilled:2'], // C0b：v2 夹具里 id=1 的「漏水与地面」被标异常，第一个未填项是 id=2 的「卫生与杂物」（原 v1 是 id=1 的温度）
    ['missing-note', "...missing.missingNoteItemIds.map(id => itemEntry('note', id, ' · 缺异常说明'))", "...[].map(id => itemEntry('note', id, ' · 缺异常说明'))", 'RF缺失清单含全部照片阻塞'],
    // C0b 修复批 1：去掉点缺失项聚焦数值输入框的选择器，旧单温度缺失项聚焦落空（null），由旧单块的新断言抓住。
    ['missing-num-focus', "'[data-num-id=\"' + entry.id + '\"], [data-seg-ok=\"' + entry.id + '\"]'", "'[data-seg-ok=\"' + entry.id + '\"]'", 'RF旧单缺失项聚焦数值输入框 temperature'],
    ['number-unit',"it.item_key === 'temperature' ? '℃' : '%'", "it.item_key === 'temperature' ? '%' : '℃'", 'RF温湿度单位'],
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
    // C0b：新单没有温湿度项，指标条不渲染这两张卡；去掉 .filter 后新单会多出两张「—」卡。
    // 修复批 1（LOW-1）：去掉容器上的 --itl-metric-cols 注入，CSS 回退成 5 列，新单三卡不再铺满一行。
    ['metric-cols', ' style="--itl-metric-cols:${3+(temp?1:0)+(hum?1:0)}"', '', 'DD新单三卡等宽且铺满容器宽度(1440)'],
    ['temp-cards',".filter(([it])=>!!it).map(([it,label,unit,key])=>", ".map(([it,label,unit,key])=>", 'DD新单未填指标只有三张卡且不含温湿度'],
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
  // Relative archive name with cwd=dir: a GNU tar earlier on PATH (Git Bash) reads the drive letter in 'E:\...' as a remote host and exits 128.
  assert.equal(run('tar',['-xf','base.tar'],{cwd:dir}).status,0);
  // 工作区未提交的后端改动也要对浏览器阶段可见（C0 起页面读 period 字段）：后端 inspection-sheets.js 与 inspection-period.js
  // 在所有阶段都覆盖到基线上；Set 去重（c1 的 source 本身就是 inspection-sheets.js）。
  const candidates = [...new Set([source,suite,'wbs-server/routes/it-ledger/inspection-sheets.js','wbs-server/routes/it-ledger/inspection-period.js'])];
  // c1 is the backend route suite (node, no page), so only the browser phases c2-c4 need the page files overlaid.
  // it-ledger-theme.css added 2026-10-31 (#200 C1b-2, C1a prescreen L7): the page loads it after it-ledger.css, so uncommitted theme edits must be visible to the browser suites.
  if (phase !== 'c1') candidates.push('wbs-server/public/assets/css/it-ledger.css','wbs-server/public/assets/css/it-ledger-theme.css','wbs-server/public/IT_Ledger.html');
  for (const file of candidates) fs.copyFileSync(path.join(root,file),path.join(dir,file));
  const original = fs.readFileSync(path.join(dir,source),'utf8');
  const env = {...process.env,NODE_PATH:[path.join(root,'wbs-server/node_modules'),path.join(root,'node_modules')].join(path.delimiter)};
  // 环境前提不满足时无差异的变异：不算失败，跳过，往 report 数组写 {name, skipped:true, reason} 并打印一行（与 mutations-*.json 一起留档）。
  //   「漏写 localtime」两个变异（提交日、今天）：夹具靠「周一 00:15 本地在 UTC 下落到上周日」抓它，只在本机时区早于 UTC 时成立；
  //   判据直接看夹具时刻本身：2026-11-16 00:15 本地的 UTC 日期（toISOString 前 10 位）不等于 '2026-11-16' 才跑这两个变异，否则跳过（本机 UTC+8，UTC 日期是 2026-11-15）。
  //   滚动 7 天变异不再依赖运行日（固定周一），不需要跳过。
  const tzReason = () => phase === 'c1' && new Date(2026, 10, 16, 0, 15).toISOString().slice(0, 10) === '2026-11-16' ? '夹具时刻 2026-11-16 00:15 本地的 UTC 日期与本地日期相同（本机时区不早于 UTC 超过 15 分钟），漏写 localtime 的变异在夹具上无差异' : null;
  const SKIP_REASONS = { localtime: tzReason, 'today-localtime': tzReason };
  for (const [name,from,to,target] of [['clean',null,null,null],...cases]) {
    const skipReason = SKIP_REASONS[name] ? SKIP_REASONS[name]() : null;
    if (skipReason) { report.push({name,skipped:true,reason:skipReason}); console.log(JSON.stringify(report[report.length-1])); continue; }
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
