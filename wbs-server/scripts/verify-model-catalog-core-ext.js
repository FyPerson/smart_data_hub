#!/usr/bin/env node
/**
 * #77 C4c-0a：目录页纯函数核心 public/assets/js/model-catalog-core.js 的「扩展件」手写期望表守卫（纯 node，不起服务）。
 * 与 verify-model-catalog-core.js（VCC，C4b 的七节冻结与既有期望）并列、互不修改；本文件只钉 C4c-0a 新增的纯函数。
 *
 * 判据（全部从手写夹具与手写期望出发，期望值不由被测函数生成；每张期望表逐条写了推导理由）：
 *   十 扩展排序：acceptance_at / domain 两个新排序键的 desc / asc / 清除三态（含 null acceptance、伴生、同刻并列、'T' 分隔符、空串域）、
 *     分组仍只看主模型、未登记键抛错、toggleSort 接受新键、SORT_KEYS 手写 12 键、搬入件 SORT_FIELD_TYPES 未被污染。
 *   十一 新筛选：view / status / domain 逐取值、DOMAIN_NONE、view 未知值抛错、多键 AND、值为空不筛、
 *     P23 对照例 F3x（状态筛选只命中伴生、搜索只命中主模型：当前口径 same-member 与另一口径 independent 的结果并列写出）。
 *   十二 railCounts：手写完整期望对象（ods / ODS 合并、伴生计入、rel === null 不算 pending、acceptance === null 不算 stale、三个列表顺序、未设置域），
 *     并用 FILTER_PREDICATES 做计数 = 点开后列表的二次对拍。
 *   十三 listFailed：令牌不符 / 为 0 丢弃；loading 变 error；loaded 保留旧数据；之后 retryExpand 发起请求；带旧令牌的 listArrived 仍被丢弃；深冻结入参不抛错。
 *   十四 显示映射：firstSentence 期望表、acceptanceView 八种 kind + 未知 state 抛错 + at 缺失、
 *     IMPL_BADGE_LABELS 与后端 routes/model-center/impl-verify.js 的 BADGE_LABELS deepEqual（require 失败直接判红，不跳过）、IMPL_BADGE_TONE 键集恰为 7 个 code。
 *   十五 P36（C4c-4 4a）：带着 view / status / domain 筛选键与已加载关系数据的状态上，setQuery 同词 / gotoPage 同页一个字段都不动（含 effects 为空）；异词 / 异页才清展开与关系数据且保留筛选键；
 *     setFilter 同值不在 P36 范围（仍清空）；列表刷新失败后展开项的 error 态在同词 / 同页后保留、仍可 retryExpand（XP:*，变异 X27–X31）。
 *   八 不修改入参：新函数对深冻结入参不抛；导出表冻结。
 *   B 两端加载一致：node require 与 vm 里按浏览器方式（window、无 module）加载的核心，对本文件夹具的新函数输出 JSON 相等；导出键两端相同。
 *   行尾：自证读入核心源码后先统一成 LF 再定位锚点（工作区是 CRLF），并带「整体转 CRLF」与「只加注释」两个对照组。
 * 用法：node scripts/verify-model-catalog-core-ext.js [--self-test]
 *   --self-test：把核心源码连同 model-detail-normalize.js 复制到临时目录，逐个施加锚定替换（锚点不存在或不唯一即报错），子进程重跑本文件，
 *     每个变异必须判红且首条失败以指定用例编号开头；对照组必须全绿。
 *   环境变量 MC_CORE_DIR（内部用）：指定核心与 normalize 所在目录，默认 public/assets/js。
 * 威胁模型：只防「诚实实现写错」（排序键退化、空值位置错、谓词漏分支、计数单位错、事件漏处理 / 漏比对令牌、文案漂移…），不防故意绕开观测。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');

const REAL_JS_DIR = path.join(__dirname, '..', 'public', 'assets', 'js');
const JS_DIR = process.env.MC_CORE_DIR ? path.resolve(process.env.MC_CORE_DIR) : REAL_JS_DIR;
const CORE_FILE = path.join(JS_DIR, 'model-catalog-core.js');
const KIT_FILE = path.join(JS_DIR, 'model-detail-normalize.js');

// ───────────────────────────── 自测变异表 ─────────────────────────────
// [编号, 说明, 锚点（须在核心源码里恰好出现一次）, 替换, 期望首条失败的用例编号（null = 对照组，须全绿）]
const MUTATIONS = [
  ['X1', 'EXTRA 排序键退化成输入序（compareByField 对扩展键恒返回并列）', 'var xy = sortByField([x, y], f, dir);', 'if (f !== field) return 0;\n        var xy = sortByField([x, y], f, dir);', 'XS:acc.desc'],
  ['X2', 'acceptance_at 的 null acceptance 不排末尾（被当成最早的日期）', 'row.acceptance ? row.acceptance.at : null', "row.acceptance ? row.acceptance.at : '1970-01-01 00:00:00'", 'XS:acc.desc'],
  ['X3', 'domain 谓词忽略 DOMAIN_NONE（按普通代码比较）', 'if (v === DOMAIN_NONE) return isBlankDomain(row.domain);', '', 'XF:domain.none'],
  ['X4', "view 'pending' 不看 rel.obj", "return row.config_mode === 'custom' && !!row.rel && row.rel.obj === 0;", "return row.config_mode === 'custom' && !!row.rel;", 'XF:view.pending'],
  ['X5', 'railCounts 不做大写归一（ods / ODS 分成两项）', "var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer).toUpperCase();", "var lv = String(row.layer === null || row.layer === undefined ? '' : row.layer);", 'XR:full'],
  ['X6', 'railCounts 按组而不是按模型计数（跳过伴生）', 'rows.forEach(function (row) {', 'rows.forEach(function (row) {\n            if (!isBlankLink(row.companion_of)) return;', 'XR:full'],
  ['X7', 'listFailed 留下 loading（不置 error）', "c.expandStatus[k] = 'error';", 'c.expandStatus[k] = c.expandStatus[k];', 'XL:loading.error'],
  ['X8', 'listFailed 接受错误令牌（只要令牌非 0）', 'if (!tk || tk !== S.listToken) {', 'if (!tk) {', 'XL:token.wrong'],
  ['X9', "firstSentence 不认「；」", "i2 = s.indexOf('；');", 'i2 = -1;', 'XD:fs'],
  ['X10', 'acceptanceView 把 partial 的两种文案对调', "var ptext = missData ? '◐ 缺数据验收' : '◐ 缺结构验收';", "var ptext = missData ? '◐ 缺结构验收' : '◐ 缺数据验收';", 'XD:av.partial'],
  ['X11', '文案表漂移（核心副本里 stale 的文案与后端不同）', "stale: '待重核',", "stale: '待复核',", 'XD:labels.backend'],
  ['X12', 'tone 表缺一个 code（unregistered）', "unregistered: 'muted',\n    });", '    });', 'XD:tone.keys'],
  ['X13', "「需复验」谓词把 partial / fail 也算进去（M1）", "return !!row.acceptance && row.acceptance.state === 'stale';", "return !!row.acceptance && (row.acceptance.state === 'stale' || row.acceptance.state === 'partial' || row.acceptance.state === 'fail');", 'XF:view.stale'],
  ['X14', '业务域排序不把纯空白当空值（L3）', 'isBlankDomain(row.domain) ? null : row.domain', 'row.domain', 'XS:dom.asc'],
  ['X15', '左栏列表改用 localeCompare 而不是码元序（L2）', 'function codeCmp(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }', "function codeCmp(a, b) { return String(a).localeCompare(String(b), 'zh-Hans-CN'); }", 'XR:codeunit'],
  ['X16', 'setFilter 不校验 view 取值（L5）', "if (key === 'view' && value !== null && value !== undefined && value !== '' && VIEW_VALUES.indexOf(value) === -1) throw new Error('model-catalog-core：未登记的视图取值 ' + String(value));", '', 'XF:setfilter.view'],
  ['X17', '空串 layer 也进 layer 列表（L4）', "if (lv !== '') layers[lv] = (layers[lv] || 0) + 1;", 'layers[lv] = (layers[lv] || 0) + 1;', 'XR:full'],
  ['X18', '空串 status 也进 status 列表（L4）', "row.status !== null && row.status !== undefined && row.status !== ''", 'row.status !== null && row.status !== undefined', 'XR:full'],
  ['X19', "custom 视图把未知 config_mode 也算进去（M1 第 3 点）", "if (v === 'custom') return row.config_mode === 'custom';", "if (v === 'custom') return row.config_mode !== 'standard' && row.config_mode !== 'companion';", 'XF:view.custom'],
  ['X20', "custom 谓词改为「非 standard」（把伴生与未知模式都算成自定义）（38T M3）", "if (v === 'custom') return row.config_mode === 'custom';", "if (v === 'custom') return row.config_mode !== 'standard';", 'XF:view.custom'],
  ['X21', "pending 谓词改为「非 standard」且对象数为 0（伴生被算成待补）（38T M3）", "return row.config_mode === 'custom' && !!row.rel && row.rel.obj === 0;", "return row.config_mode !== 'standard' && !!row.rel && row.rel.obj === 0;", 'XF:view.pending'],
  ['X22', "railCounts 过滤孤儿伴生（主模型不在输入里的伴生不计）（38T M1）", 'rows.forEach(function (row) {', "rows.forEach(function (row) {\n            if (!isBlankLink(row.companion_of) && !rows.some(function (p) { return String(p.id) === String(row.companion_of); })) return;", 'XR:full'],
  ['X23', "railCounts 按 companion_of 去重（同一主模型的伴生只算一个）（38T M1）", 'rows.forEach(function (row) {', "var seenComp = {};\n        rows.forEach(function (row) {\n            if (!isBlankLink(row.companion_of)) { var kk = 'c' + row.companion_of; if (seenComp[kk]) return; seenComp[kk] = true; }", 'XR:full'],
  ['X24', "组排序取组内最后一个成员（伴生）的值而不是主模型（38T M2）", 'var primaries = kept.map(function (g) { return g.primary; });', (src) => {
    const a = 'var primaries = kept.map(function (g) { return g.primary; });';
    const b = 'kept.forEach(function (g) { groupOf.set(g.primary, g); });';
    if (src.split(a).length !== 2 || src.split(b).length !== 2) throw new Error('X24 锚点');
    return src.replace(a, 'var primaries = kept.map(function (g) { return g.members[g.members.length - 1]; });').replace(b, 'kept.forEach(function (g) { groupOf.set(g.members[g.members.length - 1], g); });');
  }, 'XS:acc.desc'],
  ['X25', "listFailed 只处理第一个展开项（38T L2）", 'Object.keys(c.expandStatus).forEach(function (k) {', 'Object.keys(c.expandStatus).slice(0, 1).forEach(function (k) {', 'XL:mixed'],
  ['X26', "listFailed 把所有 loading 都置 error（不看令牌是否有效）（38T L2）", "if (c.expandStatus[k] === 'loading' && c.expandTokens[k] === undefined) {", "if (c.expandStatus[k] === 'loading') {", 'XL:live'],
  ["X27", "C4c-4 P36：setQuery 去掉同词守卫", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (false) {", "XP:q.same"],
  ["X28", "C4c-4 P36：gotoPage 去掉同页守卫", "if (p === S.page) return { state: c, effects: [] };", "", "XP:p.same"],
  ["X29", "C4c-4 P36：setQuery 同词分支误清筛选（只该保持不动）", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) {", "if (String(q === null || q === undefined ? '' : q).trim() === String(S.query === null || S.query === undefined ? '' : S.query).trim()) { c.filters = {};", "XP:q.same"],
  ["X30", "C4c-4 P36：setQuery 异词分支误清筛选", "c.query = q;\n        c.page = 1;", "c.query = q;\n        c.filters = {};\n        c.page = 1;", "XP:q.diff"],
  ["X31", "C4c-4 P36：把守卫误加到 setFilter（同值不清展开）", "var c = copyState(S);\n        c.filters[key] = value;", "var c = copyState(S);\n        if (S.filters[key] === value) return { state: c, effects: [] };\n        c.filters[key] = value;", "XP:f.same"],
  ['CRLF', '对照组：核心整体转 CRLF（锚点仍可定位、本体全绿）', null, (src) => src.replace(/\n/g, '\r\n'), null],
  ['CTRL', '对照组：只加注释与空行', 'var hasOwn = Object.prototype.hasOwnProperty;', 'var hasOwn = Object.prototype.hasOwnProperty;\n\n    // 对照组：注释与空行不应改变任何结果\n\n', null],
];

// ───────────────────────────── 自测模式 ─────────────────────────────
if (process.argv.includes('--self-test')) process.exit(selfTest());

function selfTest() {
  const toLF = (t) => t.replace(/\r\n/g, '\n');
  const coreSrc = toLF(fs.readFileSync(path.join(REAL_JS_DIR, 'model-catalog-core.js'), 'utf8'));
  const kitSrc = toLF(fs.readFileSync(path.join(REAL_JS_DIR, 'model-detail-normalize.js'), 'utf8'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-core-ext-selftest-'));
  const DEFAULT_TIMEOUT = Number(process.env.MC_SELFTEST_TIMEOUT_MS) || 60000;
  let bad = 0;
  const runWith = (src, label) => {
    const dir = path.join(root, label);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'model-catalog-core.js'), src);
    fs.writeFileSync(path.join(dir, 'model-detail-normalize.js'), kitSrc);
    const env = Object.assign({}, process.env, { MC_CORE_DIR: dir });
    const r = spawnSync(process.execPath, [__filename], { env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: DEFAULT_TIMEOUT });
    const timedOut = !!(r.error && r.error.code === 'ETIMEDOUT');
    const lines = String(r.stdout || '').split(/\r?\n/);
    return { status: r.status, timedOut, first: lines.find(l => l.startsWith('FAIL ')) || null, stderr: String(r.stderr || '').trim().split(/\r?\n/)[0] };
  };
  const base = runWith(coreSrc, 'base');
  if (base.timedOut || base.status !== 0 || base.first) { console.log('[self-test] 未变异的核心应全绿，实得 ' + (base.timedOut ? '超时' : (base.first || ('退出码 ' + base.status + ' ' + base.stderr)))); return 1; }
  console.log('[self-test] 未变异：全绿');
  for (const [id, desc, anchor, repl, want] of MUTATIONS) {
    let mutated;
    try {
      if (anchor !== null) {
        const n = coreSrc.split(anchor).length - 1;
        if (n !== 1) { console.log('[self-test] FAIL ' + id + '：变异锚点不存在或不唯一（出现 ' + n + ' 次）'); bad++; continue; }
      }
      mutated = typeof repl === 'function' ? repl(coreSrc) : coreSrc.split(anchor).join(repl);
      if (anchor !== null && mutated === coreSrc) { console.log('[self-test] FAIL ' + id + '：变异构造后源码没有变化'); bad++; continue; }
    } catch (e) { console.log('[self-test] FAIL ' + id + '：构造变异失败（' + e.message + '）'); bad++; continue; }
    const r = runWith(mutated, id);
    if (r.timedOut) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：子进程超时'); bad++; continue; }
    if (want === null) {
      if (r.status === 0 && !r.first) console.log('[self-test] OK   ' + id + '（' + desc + '）：全绿');
      else { console.log('[self-test] FAIL ' + id + '：对照组不应判红，实得 ' + (r.first || r.stderr)); bad++; }
      continue;
    }
    if (r.status === 0 || !r.first) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：变异后仍全绿（判别力不足）'); bad++; continue; }
    if (!r.first.startsWith('FAIL ' + want + ' ')) { console.log('[self-test] FAIL ' + id + '（' + desc + '）：首条失败应以 ' + want + ' 开头，实得 ' + r.first.slice(0, 160)); bad++; continue; }
    console.log('[self-test] OK   ' + id + '（' + desc + '）：首条判红 ' + r.first.slice(0, 120));
  }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
  console.log(bad ? '[self-test] ' + bad + ' 项失败' : '[self-test] 全部通过');
  return bad ? 1 : 0;
}

// ───────────────────────────── 断言框架 ─────────────────────────────
const core = require(CORE_FILE);
let pass = 0, fail = 0;
const perSection = {};
let curSection = '';
const J = (v) => JSON.stringify(v);
function check(code, name, cond, detail) {
  perSection[curSection] = (perSection[curSection] || 0) + 1;
  if (cond) { pass++; return; }
  fail++;
  console.log(`FAIL ${code} | ${name}${detail === undefined ? '' : '\n  ' + detail}`);
}
const eq = (code, name, got, want) => check(code, name, J(got) === J(want), `got=${J(got)} want=${J(want)}`);
function section(name, fn) {
  curSection = name;
  try { fn(); } catch (e) { check(name.split(' ')[0] + ':THROW', `${name} 抛异常`, false, String(e && e.stack || e).split('\n').slice(0, 3).join(' / ')); }
}
const throwsMsg = (fn) => { try { fn(); return ''; } catch (e) { return String(e.message); } };

// ───────────────────────────── 夹具 ─────────────────────────────
const R = (o) => Object.assign({
  id: 0, layer: 'ods', table_name: '', table_comment: null, impl_note: null, source_table: null, source_system: null,
  config_mode: 'standard', companion_of: null, dim_config: null, impl_obj_names: [], status: 'ONLINE',
  updated_at: '2026-01-02 08:00:00', tech_owner: '', biz_owner: '', update_cycle: 'df', archived_task_count: 0,
}, o);
const P20 = (o) => Object.assign({ query: '', filters: {}, sortBy: null, sortDir: 'desc', page: 1, pageSize: 20 }, o || {});
const view = (rows, o) => core.computeView(rows, P20(o));
const S0 = (o) => Object.assign({ page: 1, sortBy: null, sortDir: 'desc', query: '', filters: {}, expanded: [], listToken: 0, expandTokens: {}, expandStatus: {}, relations: {}, seq: 0 }, o || {});
const acc = (state, at, extra) => Object.assign({ state, at: at === undefined ? null : at, rows: null, stages: null, prevResult: null }, extra || {});

// 扩展排序夹具（输入顺序 = 默认序；#7 是 #2 的伴生，#8 是落单伴生）。
//   acceptance_at：#1 与 #4 同刻（并列）；#6 用 'T' 分隔符；#3 的 acceptance 整体为 null；#5 / #8 的 at 为 null；
//   伴生 #7 故意取 2030 年的 at 与 'Z_LAST' 域，若它参与分组排序，#2 组会跑到别处。
const SORT_X = [
  R({ id: 1, table_name: 'p1', acceptance: acc('pass', '2026-03-05 10:00:00'), domain: 'B_HR' }),
  R({ id: 2, table_name: 'p2', acceptance: acc('warn', '2026-01-10 09:00:00'), domain: 'A_FIN' }),
  R({ id: 7, table_name: 'c7', config_mode: 'companion', companion_of: 2, acceptance: acc('companion', '2030-01-01 00:00:00'), domain: 'Z_LAST' }),
  R({ id: 3, table_name: 'p3', acceptance: null, domain: null }),
  R({ id: 4, table_name: 'p4', acceptance: acc('fail', '2026-03-05 10:00:00'), domain: '' }),
  R({ id: 5, table_name: 'p5', acceptance: acc('none', null), domain: 'C_OPS' }),
  R({ id: 6, table_name: 'p6', acceptance: acc('stale', '2025-12-31T23:59:59', { prevResult: 'pass' }), domain: 'A_FIN' }),
  R({ id: 8, table_name: 'o8', config_mode: 'companion', companion_of: 99, acceptance: acc('companion', null), domain: 'D_X' }),
  // #9：域为纯空白（L3：与左栏 / 筛选的 DOMAIN_NONE 口径一致，按空值排末尾）；acceptance 为 null
  R({ id: 9, table_name: 'p9', acceptance: null, domain: '   ' }),
  // #10 #11（38T M2）：主模型 #3 / #9 的 acceptance 与 domain 为空，伴生却带极端值——#10 是最晚的 at（2031）和字典序最小的域 A_AAA，
  //   #11 是最早的 at（1999）和字典序最大的域 Z_ZZZ。组位置只由主模型决定：伴生的值无论取最大 / 最小 / 任一成员都不得改变组序。
  R({ id: 10, table_name: 'c10', config_mode: 'companion', companion_of: 3, acceptance: acc('companion', '2031-01-01 00:00:00'), domain: 'A_AAA' }),
  R({ id: 11, table_name: 'c11', config_mode: 'companion', companion_of: 9, acceptance: acc('companion', '1999-01-01 00:00:00'), domain: 'Z_ZZZ' }),
];

// ═════════ 十 扩展排序 ═════════
section('十 扩展排序', () => {
  const ids = (key, dir) => view(SORT_X, { sortBy: key, sortDir: dir }).orderedIds;
  eq('XS:default', '默认序：主模型按输入顺序、伴生 #7 紧随 #2、落单 #8 在输入位置', view(SORT_X).orderedIds, [1, 2, 7, 3, 10, 4, 5, 6, 8, 9, 11]);
  // acceptance_at desc：有日期的按时间倒序：#1 与 #4 同刻（2026-03-05 10:00）并列 → 输入序 1,4；其后 #2（01-10）、#6（2025-12-31，'T' 分隔符按时间解析）；
  //   空值（#3 / #9 acceptance 为 null、#5 与 #8 的 at 为 null）恒末尾，空值之间按输入序 3,5,8,9；#2 组带伴生 #7 紧随（#7 的 2030 年不参与）。
  eq('XS:acc.desc', 'acceptance_at desc（手写期望）', ids('acceptance_at', 'desc'), [1, 4, 2, 7, 6, 3, 10, 5, 8, 9, 11]);  // 空值组 3(+10)、5、8、9(+11) 按主模型输入序排末尾；伴生 #10（2031）#11（1999）不参与
  // asc：最早的 #6 在前，其后 #2(+7)、#1、#4（并列输入序），空值仍在末尾（3,5,8）——空值不随方向翻转。
  eq('XS:acc.asc', 'acceptance_at asc（手写期望；空值仍在末尾）', ids('acceptance_at', 'asc'), [6, 2, 7, 1, 4, 3, 10, 5, 8, 9, 11]);  // 同上：空值组仍在末尾，#11 的 1999 年不会把 9 组拉到最前
  eq('XS:acc.clear', 'acceptance_at 清除（sortBy null）回到默认序', view(SORT_X, { sortBy: null, sortDir: 'desc' }).orderedIds, [1, 2, 7, 3, 10, 4, 5, 6, 8, 9, 11]);
  // domain 取原始代码，字符串序：A_FIN < B_HR < C_OPS < D_X（首字母即可区分，不依赖 ICU 细节）；#2 与 #6 同为 A_FIN，并列按输入序 2,6；
  //   空值：#3 为 null、#4 为 ''、#9 为纯空白（L3，投影时按空值处理），恒末尾，输入序 3,4,9；伴生 #7 的 'Z_LAST' 不参与（否则 #2 组在 desc 下会排第一）。
  eq('XS:dom.asc', 'domain asc（手写期望）', ids('domain', 'asc'), [2, 7, 6, 1, 5, 8, 3, 10, 4, 9, 11]);  // 空值组 3(+10)、4、9(+11) 在末尾；#10 的 A_AAA 不会把 3 组拉到最前
  eq('XS:dom.desc', 'domain desc（手写期望；并列仍按输入序、空值仍在末尾）', ids('domain', 'desc'), [8, 5, 1, 2, 7, 6, 3, 10, 4, 9, 11]);  // #11 的 Z_ZZZ 不会把 9 组拉到最前
  eq('XS:dom.clear', 'domain 清除回到默认序', view(SORT_X, { sortBy: null }).orderedIds, [1, 2, 7, 3, 10, 4, 5, 6, 8, 9, 11]);
  // 旧键在同一夹具上不受影响（对照）：主模型 id 倒序 [9(+11),8,6,5,4,3(+10),2(+7),1] → 9,11,8,6,5,4,3,10,2,7,1
  eq('XS:old.id', '旧键对照：id desc 仍按主模型 id 倒序、伴生随主模型', ids('id', 'desc'), [9, 11, 8, 6, 5, 4, 3, 10, 2, 7, 1]);
  // 未登记键 / 非法方向仍然抛错（fail-closed）
  for (const k of ['nosuch', 'toString', 'constructor', '', 'acceptance', 'Domain']) {
    check('XS:unreg', '未登记的 sortBy ' + J(k) + ' 抛错', /排序字段/.test(throwsMsg(() => view(SORT_X, { sortBy: k, sortDir: 'asc' }))));
    check('XS:unreg', 'toggleSort 对未登记字段 ' + J(k) + ' 抛错', /排序字段/.test(throwsMsg(() => core.toggleSort(S0({}), k))));
  }
  check('XS:dir', '新键配非法 sortDir 仍抛错', /sortDir/.test(throwsMsg(() => view(SORT_X, { sortBy: 'domain', sortDir: 'up' }))));
  // toggleSort 接受新键，三态：desc → asc → 清除
  for (const k of ['acceptance_at', 'domain']) {
    const s1 = core.toggleSort(S0({ page: 3 }), k).state;
    eq('XS:toggle', 'toggleSort ' + k + ' 首击：新列 desc、回第 1 页', [s1.sortBy, s1.sortDir, s1.page], [k, 'desc', 1]);
    const s2 = core.toggleSort(s1, k).state;
    const s3 = core.toggleSort(s2, k).state;
    eq('XS:toggle', 'toggleSort ' + k + ' 二击 asc、三击清除', [s2.sortBy, s2.sortDir, s3.sortBy, s3.sortDir], [k, 'asc', null, 'desc']);
  }
  // SORT_KEYS 手写：SORT_FIELD_TYPES 的 10 个键（声明序）+ 两个扩展键
  eq('XS:keys', 'SORT_KEYS 恰为 12 个键（旧 10 个 + acceptance_at + domain）', Array.from(core.SORT_KEYS), ['id', 'layer', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'archived_task_count', 'updated_at', 'acceptance_at', 'domain']);
  check('XS:keys', 'SORT_KEYS 里每个键 computeView / toggleSort 都接受（不抛错）', core.SORT_KEYS.every(k => throwsMsg(() => view(SORT_X, { sortBy: k, sortDir: 'asc' })) === '' && throwsMsg(() => core.toggleSort(S0({}), k)) === ''));
  eq('XS:extra', 'EXTRA_SORT_FIELDS 内容：acceptance_at → date、domain → string', J(core.EXTRA_SORT_FIELDS), J({ acceptance_at: 'date', domain: 'string' }));
  check('XS:frozen', 'EXTRA_SORT_FIELDS / SORT_KEYS 已冻结', Object.isFrozen(core.EXTRA_SORT_FIELDS) && Object.isFrozen(core.SORT_KEYS));
  check('XS:moved', '搬入件 SORT_FIELD_TYPES 没有被加键（仍恰为 10 个，不含新键）', Object.keys(core.SORT_FIELD_TYPES).length === 10 && !('acceptance_at' in core.SORT_FIELD_TYPES) && !('domain' in core.SORT_FIELD_TYPES));
  // 借用键依赖：新键的比较类型由 updated_at（date）/ table_name（string）承担，旧表若改了类型这里会先红
  eq('XS:borrow', '借用键类型：updated_at 为 date、table_name 为 string', [core.SORT_FIELD_TYPES.updated_at, core.SORT_FIELD_TYPES.table_name], ['date', 'string']);
  // 事件层：带新排序键的状态喂 listArrived / focus 不抛错，页码按新序定位
  {
    const st = Object.assign(core.reloadStart(S0({ sortBy: 'domain', sortDir: 'asc' })).state);
    const la = core.listArrived(st, { token: st.listToken, rows: SORT_X });
    eq('XS:event', '状态里 sortBy 为新键时 listArrived 正常到达（不抛错、page 1）', [la.state.page, la.state.sortBy], [1, 'domain']);
    const fo = core.focus(S0({ sortBy: 'acceptance_at', sortDir: 'desc' }), { id: 7, rows: SORT_X });
    eq('XS:event', '状态里 sortBy 为新键时 focus 伴生 #7 → 第 1 页并高亮', [fo.state.page, fo.effects], [1, [{ type: 'highlight', id: 7, ms: 3000 }]]);
  }
});

// ═════════ 十一 新筛选 ═════════
// 筛选夹具：每行的各字段都是为某个谓词手写的。
//   #1 ods ONLINE A_FIN pass rel.obj 2；#6 是 #1 的伴生（dwd、config_mode companion）；
//   #2 dim CREATED 域未设置（无 domain 键）stale rel.obj 0 但 config_mode standard（不是 pending）；
//   #3 dwd custom DEVELOPING 域为纯空白 acceptance null rel.obj 0 → pending + custom + 域未设置；
//   #4 dwd custom ONLINE B_HR stale rel.obj 3 → custom + stale、不是 pending；
//   #5 dim custom OFFLINE 域空串 none rel null → custom；rel null 不算 pending；
//   #9 ods standard ONLINE 域 null acceptance 缺省（undefined）→ 不算 stale、域未设置。
const FR = [
  R({ id: 1, layer: 'ods', table_name: 'f1', status: 'ONLINE', domain: 'A_FIN', acceptance: acc('pass', '2026-03-01 00:00:00'), rel: { obj: 2, up: 0, down: 0 } }),
  R({ id: 6, layer: 'dwd', table_name: 'f6_change', config_mode: 'companion', companion_of: 1, status: 'ONLINE', domain: 'A_FIN', acceptance: acc('companion'), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 2, layer: 'dim', table_name: 'f2', status: 'CREATED', acceptance: acc('stale', '2026-02-01 00:00:00', { prevResult: 'pass' }), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 3, layer: 'dwd', table_name: 'f3', config_mode: 'custom', status: 'DEVELOPING', domain: '  ', acceptance: null, rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 4, layer: 'dwd', table_name: 'f4', config_mode: 'custom', status: 'ONLINE', domain: 'B_HR', acceptance: acc('stale', '2026-02-02 00:00:00'), rel: { obj: 3, up: 0, down: 0 } }),
  R({ id: 5, layer: 'dim', table_name: 'f5', config_mode: 'custom', status: 'OFFLINE', domain: '', acceptance: acc('none'), rel: null }),
  R({ id: 9, layer: 'ods', table_name: 'f9', status: 'ONLINE', domain: null, rel: { obj: 1, up: 0, down: 0 } }),
  // #10 #11 #12（M1）：warn / fail / partial 都不是「需复验」（方案 §3.2：当前版本有失败记录显示「未通过」而非「需复验」）；
  //   三行都是 standard、status REVIEWING、域 C_OPS，不进入其它视图 / 状态 / 域的既有期望。
  R({ id: 10, layer: 'ads', table_name: 'f10', status: 'REVIEWING', domain: 'C_OPS', acceptance: acc('warn', '2026-03-10 00:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 11, layer: 'ads', table_name: 'f11', status: 'REVIEWING', domain: 'C_OPS', acceptance: acc('fail', '2026-03-11 00:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 12, layer: 'ads', table_name: 'f12', status: 'REVIEWING', domain: 'C_OPS', acceptance: acc('partial', '2026-03-12 00:00:00', { stages: { structure: 'pass', data: null } }), rel: { obj: 1, up: 0, down: 0 } }),
];
section('十一 新筛选', () => {
  const ids = (filters, q) => view(FR, { filters, query: q || '' }).orderedIds;
  const P = core.FILTER_PREDICATES;
  eq('XF:keys', 'FILTER_PREDICATES 的键恰为 layer / view / status / domain', Object.keys(P).sort(), ['domain', 'layer', 'status', 'view']);
  check('XF:frozen', 'FILTER_PREDICATES 已冻结，页面注册不进新键', Object.isFrozen(P) && !(() => { try { P.__probe__ = () => true; return '__probe__' in P; } catch (e) { return false; } })());
  // view：逐成员直接调谓词（成员 = 行，不看组）
  const rowsBy = (v) => FR.filter(r => P.view(r, v)).map(r => r.id);
  eq('XF:view.all', "view 'all' 恒真：全部 10 行", rowsBy('all'), [1, 6, 2, 3, 4, 5, 9, 10, 11, 12]);
  eq('XF:view.stale', "view 'stale' ⇔ acceptance 非 null 且 state === stale：#2 #4（#3 的 acceptance 为 null、#9 缺省、#1 pass、#5 none、#10 warn、#11 fail、#12 partial 都不算）", rowsBy('stale'), [2, 4]);
  eq('XF:view.pending', "view 'pending' ⇔ custom 且 rel 非 null 且 rel.obj === 0：只有 #3（#4 obj 3；#5 rel 为 null；#2 obj 0 但是 standard；#6 obj 0 但是 companion）", rowsBy('pending'), [3]);
  eq('XF:view.custom', "view 'custom' ⇔ config_mode === custom：#3 #4 #5", rowsBy('custom'), [3, 4, 5]);
  // M1 第 3 点：未知 config_mode（legacy）只认字面 custom，与后端 decideObjectState 兜底一致——不算 custom，也不算 pending（即使 rel.obj 为 0）
  // 38T M3：伴生（config_mode 'companion'）即使 rel.obj 为 0 且带对象数据，也不是 custom、不是 pending
  const COMP = R({ id: 98, layer: 'dwd', config_mode: 'companion', companion_of: 1, rel: { obj: 0, up: 1, down: 2 } });
  eq('XF:view.custom', "伴生 config_mode 'companion'（rel.obj 为 0、up 1、down 2）：custom 与 pending 都为假", [P.view(COMP, 'custom'), P.view(COMP, 'pending')], [false, false]);
  check('XF:view.pending', "伴生行逐行真值：FR 里的伴生 #6（rel.obj 0）不在 custom / pending 里", !rowsBy('custom').includes(6) && !rowsBy('pending').includes(6));
  const LEGACY = R({ id: 99, config_mode: 'legacy', rel: { obj: 0, up: 0, down: 0 } });
  eq('XF:view.custom', "未知 config_mode 'legacy'（rel.obj 为 0）：custom 与 pending 都为假", [P.view(LEGACY, 'custom'), P.view(LEGACY, 'pending')], [false, false]);
  const bad = throwsMsg(() => P.view(FR[0], 'bogus'));
  check('XF:view.unknown', "view 未知取值 'bogus' 抛错（带取值）", /bogus/.test(bad), bad);
  check('XF:view.unknown', "view 取值大小写敏感：'STALE' 抛错", /STALE/.test(throwsMsg(() => P.view(FR[0], 'STALE'))));
  // 经 computeView（组语义；同成员规则，下面各例的命中成员都与通过筛选的成员相同）
  eq('XF:view.cv', "computeView view=stale → 组 [2]、[4]", ids({ view: 'stale' }), [2, 4]);
  eq('XF:view.cv', "computeView view=pending → [3]", ids({ view: 'pending' }), [3]);
  eq('XF:view.cv', "computeView view=custom → [3,4,5]", ids({ view: 'custom' }), [3, 4, 5]);
  eq('XF:view.cv', "computeView view=all → 全部（#6 随 #1 组）", ids({ view: 'all' }), [1, 6, 2, 3, 4, 5, 9, 10, 11, 12]);
  check('XF:view.cv', 'computeView view=bogus 抛错（有行时）', /bogus/.test(throwsMsg(() => ids({ view: 'bogus' }))));
  // status：严格相等
  eq('XF:status', "status=ONLINE → #1 #6 #4 #9：组 [1,6]、[4]、[9]", ids({ status: 'ONLINE' }), [1, 6, 4, 9]);
  eq('XF:status', "status=OFFLINE → [5]；DEVELOPING → [3]；CREATED → [2]", [ids({ status: 'OFFLINE' }), ids({ status: 'DEVELOPING' }), ids({ status: 'CREATED' })], [[5], [3], [2]]);
  eq('XF:status', "status 严格相等：小写 online → 无命中；不存在的 ARCHIVED → 无命中；REVIEWING → [10,11,12]", [ids({ status: 'online' }), ids({ status: 'ARCHIVED' }), ids({ status: 'REVIEWING' })], [[], [], [10, 11, 12]]);
  // domain：代码严格相等；DOMAIN_NONE ⇔ 未设置
  check('XF:domain.const', 'DOMAIN_NONE 是非空字符串（空串在筛选里表示「不筛」）、且不被 trim 掉', typeof core.DOMAIN_NONE === 'string' && core.DOMAIN_NONE.length > 0 && core.DOMAIN_NONE === core.DOMAIN_NONE.trim());
  eq('XF:domain.code', "domain=A_FIN → #1 #6：组 [1,6]；C_OPS → [10,11,12]", [ids({ domain: 'A_FIN' }), ids({ domain: 'C_OPS' })], [[1, 6], [10, 11, 12]]);
  eq('XF:domain.code', "domain 严格相等：a_fin → 无命中", ids({ domain: 'a_fin' }), []);
  eq('XF:domain.none', "domain=DOMAIN_NONE → 未设置：#2（无键）#3（纯空白）#5（空串）#9（null）；#1 #4 #6 有代码不算", ids({ domain: core.DOMAIN_NONE }), [2, 3, 5, 9]);
  eq('XF:domain.none', "DOMAIN_NONE 逐行谓词：无键 / 纯空白 / 空串 / null 为真，有代码为假", FR.map(r => P.domain(r, core.DOMAIN_NONE)), [false, false, true, true, false, true, true, false, false, false]);
  // 值为空：不筛（null / undefined / ''），与旧键同口径
  eq('XF:empty', "新键值为 null / '' / undefined → 不筛（orderedIds 含伴生共 10 个模型 = 9 组）", [ids({ view: null }).length, ids({ status: '' }).length, ids({ domain: undefined }).length], [10, 10, 10]);
  // 多键 AND（同一成员须同时通过全部筛选）
  eq('XF:and', "view=custom 且 status=ONLINE → 只有 #4", ids({ view: 'custom', status: 'ONLINE' }), [4]);
  eq('XF:and', "layer=dwd 且 view=stale → #4（#3 是 dwd 但 acceptance null）", ids({ layer: 'dwd', view: 'stale' }), [4]);
  eq('XF:and', "status=ONLINE 且 domain=A_FIN 且 layer=DWD → 只有伴生 #6 同时通过 → 组 [1,6] 保留", ids({ status: 'ONLINE', domain: 'A_FIN', layer: 'DWD' }), [1, 6]);
  eq('XF:and', "view=pending 且 domain=A_FIN → 没有成员同时满足 → []", ids({ view: 'pending', domain: 'A_FIN' }), []);
  check('XF:unreg', '未登记的筛选键仍然抛错', /nosuch/.test(throwsMsg(() => ids({ nosuch: 'x' }))));
  eq('XF:setfilter.view', 'VIEW_VALUES 手写为 all / stale / pending / custom 且已冻结（L5）', [Array.from(core.VIEW_VALUES), Object.isFrozen(core.VIEW_VALUES)], [['all', 'stale', 'pending', 'custom'], true]);
  {
    const st = S0({ page: 2, expanded: [22] }); const before = J(st);
    const m = throwsMsg(() => core.setFilter(st, 'view', 'bogus'));
    check('XF:setfilter.view', "setFilter(view, 'bogus') 立即抛错（不依赖有行被评估），且入参状态不变", /bogus/.test(m) && J(st) === before, m);
    check('XF:setfilter.view', "setFilter(view, 'STALE')（大小写不符）也抛错；数字 / 对象同样", /STALE/.test(throwsMsg(() => core.setFilter(st, 'view', 'STALE'))) && throwsMsg(() => core.setFilter(st, 'view', 0)) !== '' && throwsMsg(() => core.setFilter(st, 'view', {})) !== '');
    check('XF:setfilter.view', 'setFilter(view, 四个合法值 / null / 空串 / undefined) 都不抛', ['all', 'stale', 'pending', 'custom', null, '', undefined].every(v => throwsMsg(() => core.setFilter(st, 'view', v)) === ''));
    check('XF:setfilter.view', '其它键不受视图校验影响：status / domain / layer 的任意值仍可 setFilter', ['status', 'domain', 'layer'].every(k => throwsMsg(() => core.setFilter(st, k, 'bogus')) === ''));
  }
  eq('XF:setFilter', 'setFilter 接受 view / status / domain 并回第 1 页、清展开', [['view', 'stale'], ['status', 'ONLINE'], ['domain', 'A_FIN']].map(([k, v]) => { const s = core.setFilter(S0({ page: 2, expanded: [1] }), k, v).state; return [s.filters[k], s.page, s.expanded]; }), [['stale', 1, []], ['ONLINE', 1, []], ['A_FIN', 1, []]]);

  // P23 对照例 F3x：状态筛选只命中伴生 #2（OFFLINE），搜索只命中主模型 #1（表名 main_hit）。
  //   当前口径 same-member（GROUP_HIT_RULE）：没有同一成员既命中搜索又通过筛选 → 组不显示 → []。
  //   另一口径 independent（组内有成员命中搜索、且可能是另一成员通过筛选）会得到整组 [1,2]。
  //   用户裁定（P23）后若改口径，只改核心里标注 P23 的那一行，并把本组期望改为 [1,2]、GROUP_HIT_RULE 改为 independent。
  const SPLIT = [R({ id: 1, layer: 'dim', table_name: 'main_hit', status: 'ONLINE' }), R({ id: 2, layer: 'dwd', table_name: 'c_x', config_mode: 'companion', companion_of: 1, status: 'OFFLINE' })];
  check('XF:F3x', 'GROUP_HIT_RULE 仍为 same-member（P23 暂按 A；改口径须同步改本组期望）', core.GROUP_HIT_RULE === 'same-member');
  eq('XF:F3x', '搜索只命中主模型、状态筛选只命中伴生 → same-member 下组不显示（independent 口径会得到 [1,2]）', view(SPLIT, { query: 'main_hit', filters: { status: 'OFFLINE' } }).orderedIds, []);
  eq('XF:F3x', '搜索与状态筛选都落在伴生 → 同一成员满足 → 整组 [1,2]', view(SPLIT, { query: 'c_x', filters: { status: 'OFFLINE' } }).orderedIds, [1, 2]);
  eq('XF:F3x', '搜索与状态筛选都落在主模型 → 整组 [1,2]（组里伴生不要求通过筛选）', view(SPLIT, { query: 'main_hit', filters: { status: 'ONLINE' } }).orderedIds, [1, 2]);
  eq('XF:F3x', '只有筛选、无搜索：伴生通过 OFFLINE → 整组 [1,2]（空搜索对每个成员都为真）', view(SPLIT, { filters: { status: 'OFFLINE' } }).orderedIds, [1, 2]);
});

// ═════════ 十二 railCounts ═════════
// 手写夹具（10 个模型，含伴生）：
//   #1 ods / #2 ODS（大小写合并）；#3 dim custom pending；#4 dwd 伴生（rel null）；#5 dwd custom rel null（不算 pending，stale）；
//   #6 dws；#7 ads standard rel.obj 0（standard 不算 pending）；#8 未知层 abc / 域纯空白；#9 未知层 xyz custom pending / 未知状态 ARCHIVED；#10 状态 null / acceptance 缺省。
const RC = [
  R({ id: 1, layer: 'ods', status: 'ONLINE', domain: 'B_HR', acceptance: acc('pass', '2026-03-01 00:00:00'), rel: { obj: 3, up: 0, down: 0 } }),
  R({ id: 2, layer: 'ODS', status: 'ONLINE', domain: 'B_HR', acceptance: acc('stale', '2026-02-01 00:00:00'), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 3, layer: 'dim', config_mode: 'custom', status: 'CREATED', domain: 'A_FIN', acceptance: null, rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 4, layer: 'dwd', config_mode: 'companion', companion_of: 1, status: 'ONLINE', domain: 'B_HR', acceptance: acc('companion'), rel: null }),
  R({ id: 5, layer: 'dwd', config_mode: 'custom', status: 'DEVELOPING', domain: null, acceptance: acc('stale', '2026-01-01 00:00:00'), rel: null }),
  R({ id: 6, layer: 'dws', status: 'REVIEWING', domain: '', acceptance: acc('none'), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 7, layer: 'ads', status: 'WEIRD', domain: 'Z_ZZ', acceptance: acc('pass', '2026-03-02 00:00:00'), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 8, layer: 'abc', status: 'OFFLINE', domain: '  ', acceptance: acc('stale', '2026-01-02 00:00:00'), rel: { obj: 2, up: 0, down: 0 } }),
  R({ id: 9, layer: 'xyz', config_mode: 'custom', status: 'ARCHIVED', domain: 'A_FIN', acceptance: acc('pass', '2026-03-03 00:00:00'), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 10, layer: 'dim', status: null, domain: 'A_FIN', rel: { obj: 4, up: 0, down: 0 } }),
  // #11 #12 #13（M1）：warn / fail / partial 不算 stale；#14（M1 第 3 点）未知 config_mode 'legacy'：不算 custom、不算 pending（即使 rel.obj 为 0）；
  // #15（L4）layer 与 status 都是空串：只计入 total，不进 layer / status 列表。
  R({ id: 11, layer: 'ods', status: 'ONLINE', domain: 'B_HR', acceptance: acc('warn', '2026-03-10 00:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 12, layer: 'dim', status: 'CREATED', domain: 'A_FIN', acceptance: acc('fail', '2026-03-11 00:00:00'), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 13, layer: 'dwd', status: 'DEVELOPING', domain: 'Z_ZZ', acceptance: acc('partial', '2026-03-12 00:00:00', { stages: { structure: null, data: 'pass' } }), rel: { obj: 1, up: 0, down: 0 } }),
  R({ id: 14, layer: 'dws', config_mode: 'legacy', status: 'REVIEWING', domain: null, acceptance: acc('pass', '2026-03-13 00:00:00'), rel: { obj: 0, up: 0, down: 0 } }),
  R({ id: 15, layer: '', status: '', domain: 'A_FIN', rel: { obj: 1, up: 0, down: 0 } }),
  // #16 #17（38T M1）：孤儿伴生——companion_of 指向 999，主模型不在输入里，且两行指向同一个缺失的主模型。计数单位是「输入的模型行」，
  //   孤儿伴生与同主模型的多个伴生都照常各计 1；config_mode 为 companion、rel.obj 为 0 且带对象数据，仍不算 custom / pending。
  R({ id: 16, layer: 'dwd', config_mode: 'companion', companion_of: 999, status: 'ONLINE', domain: 'B_HR', acceptance: acc('companion'), rel: { obj: 0, up: 1, down: 2 } }),
  R({ id: 17, layer: 'dwd', config_mode: 'companion', companion_of: 999, status: 'ONLINE', domain: 'A_FIN', acceptance: acc('companion'), rel: { obj: 0, up: 1, down: 2 } }),
];
section('十二 railCounts', () => {
  // 推导：total 10（伴生 #4 计入）。
  //   （#11–#17 为补的反例行，计数推导见各行注释；下面的数字已含它们：total 17。#16 #17 是孤儿伴生：DWD +2、ONLINE +2、B_HR +1、A_FIN +1，view 不变。）
  //   view：all 15；stale = acceptance.state 为 stale：#2 #5 #8 → 3（#3 的 acceptance 为 null、#10 缺省都不算）；
  //         pending = custom 且 rel.obj === 0：#3 #9 → 2（#5 custom 但 rel null 不算；#7 obj 0 但 standard 不算）；custom = #3 #5 #9 → 3。
  //   layer（大写归一后）：ODS = #1 + #2 = 2；DIM = #3 #10 = 2；DWD = #4 #5 = 2；DWS 1；ADS 1；ABC 1；XYZ 1。
  //         序：ODS DIM DWD DWS ADS 在前，其余 ABC XYZ 按码元序。
  //   status（#10 为 null 不进列表）：ONLINE = #1 #2 #4 = 3；CREATED 1；DEVELOPING 1；REVIEWING 1；OFFLINE 1；未知 WEIRD 1、ARCHIVED 1。
  //         序：STATUS_SORT_ORDER（CREATED DEVELOPING REVIEWING ONLINE OFFLINE），未知按码元序 ARCHIVED WEIRD。
  //   domain：A_FIN = #3 #9 #10 = 3；B_HR = #1 #2 #4 = 3；Z_ZZ 1；未设置 = #5（null）#6（空串）#8（纯空白）= 3 → DOMAIN_NONE 放最后。
  const WANT = {
    total: 17,
    view: { all: 17, stale: 3, pending: 2, custom: 3 },
    layer: [{ value: 'ODS', count: 3 }, { value: 'DIM', count: 3 }, { value: 'DWD', count: 5 }, { value: 'DWS', count: 2 }, { value: 'ADS', count: 1 }, { value: 'ABC', count: 1 }, { value: 'XYZ', count: 1 }],
    status: [{ value: 'CREATED', count: 2 }, { value: 'DEVELOPING', count: 2 }, { value: 'REVIEWING', count: 2 }, { value: 'ONLINE', count: 6 }, { value: 'OFFLINE', count: 1 }, { value: 'ARCHIVED', count: 1 }, { value: 'WEIRD', count: 1 }],
    domain: [{ value: 'A_FIN', count: 6 }, { value: 'B_HR', count: 5 }, { value: 'Z_ZZ', count: 2 }, { value: core.DOMAIN_NONE, count: 4 }],
  };
  eq('XR:full', 'railCounts 完整期望对象', core.railCounts(RC), WANT);
  const rc = core.railCounts(RC);
  eq('XR:sum', '三个列表的计数各自求和：layer 16（#15 层为空串）、status 15（#10 为 null、#15 为空串）、domain 17（含孤儿伴生 #16 #17）；「全部」计数取 total，不是分区求和', [rc.layer, rc.status, rc.domain].map(l => l.reduce((s, e) => s + e.count, 0)), [16, 15, 17]);
  // 二次对拍：计数 = 点开后（逐成员谓词）命中的模型数，保证左栏数字与点进去的列表同源
  const P = core.FILTER_PREDICATES;
  eq('XR:xcheck', '每个 view 计数 = FILTER_PREDICATES.view 命中的模型数', ['all', 'stale', 'pending', 'custom'].map(k => RC.filter(r => P.view(r, k)).length), [rc.view.all, rc.view.stale, rc.view.pending, rc.view.custom]);
  eq('XR:xcheck', '每个 layer 计数 = layer 谓词命中数', rc.layer.map(e => RC.filter(r => P.layer(r, e.value)).length), rc.layer.map(e => e.count));
  eq('XR:xcheck', '每个 status 计数 = status 谓词命中数', rc.status.map(e => RC.filter(r => P.status(r, e.value)).length), rc.status.map(e => e.count));
  eq('XR:xcheck', '每个 domain 计数（含 DOMAIN_NONE）= domain 谓词命中数', rc.domain.map(e => RC.filter(r => P.domain(r, e.value)).length), rc.domain.map(e => e.count));
  // L2：左栏列表用码元序（codeCmp）：'Zeta'（大写 Z=90）< 'a1'（'1'=49）< 'a_1'（'_'=95）< 'alpha'（'l'=108）。
  //   localeCompare 下 a_1 与 a1 的先后依赖 ICU 且大小写顺序相反，所以只有码元序能写出确定的手写期望。未知状态同理：'B'（66）< 'a'（97）< 'b'（98）。
  eq('XR:codeunit', 'domain 列表按码元序（Zeta < a1 < a_1 < alpha）', core.railCounts([R({ id: 1, domain: 'alpha' }), R({ id: 2, domain: 'a_1' }), R({ id: 3, domain: 'Zeta' }), R({ id: 4, domain: 'a1' })]).domain.map(e => e.value), ['Zeta', 'a1', 'a_1', 'alpha']);
  eq('XR:codeunit', '未知状态与未知层按码元序（B < a < b；AB < ZZ）', [core.railCounts([R({ id: 1, status: 'b' }), R({ id: 2, status: 'a' }), R({ id: 3, status: 'B' })]).status.map(e => e.value), core.railCounts([R({ id: 1, layer: 'zz' }), R({ id: 2, layer: 'ab' })]).layer.map(e => e.value)], [['B', 'a', 'b'], ['AB', 'ZZ']]);
  // L4：空串 / null 的 layer 与 status 只计 total
  eq('XR:empty.layer', 'layer / status 为空串 / null 的行只计入 total，不进分区列表', (() => { const r = core.railCounts([R({ id: 1, layer: '', status: '' }), R({ id: 2, layer: null, status: null })]); return [r.total, r.layer, r.status]; })(), [2, [], []]);
  // 不受筛选 / 搜索影响：先做一次带筛选搜索的视图计算，计数不变；只收 rows
  const before = J(core.railCounts(RC));
  view(RC, { query: 'zzz', filters: { layer: 'ods', view: 'stale' } });
  eq('XR:indep', 'railCounts 不受筛选 / 搜索影响（与 computeView 无共享状态）', J(core.railCounts(RC)), before);
  eq('XR:viewkeys', 'railCounts.view 的键 = VIEW_VALUES', Object.keys(core.railCounts([]).view), Array.from(core.VIEW_VALUES));
  eq('XR:empty', '空数组：total 0、四个 view 为 0、三个列表为空', core.railCounts([]), { total: 0, view: { all: 0, stale: 0, pending: 0, custom: 0 }, layer: [], status: [], domain: [] });
  check('XR:arg', '非数组入参抛错（fail-closed）', /railCounts/.test(throwsMsg(() => core.railCounts(null))) && /railCounts/.test(throwsMsg(() => core.railCounts({}))));
  // 无域模型全部归 DOMAIN_NONE、且没有其他域时只有一项
  eq('XR:none', '全部模型未设置业务域 → domain 列表仅 DOMAIN_NONE 一项', core.railCounts([R({ id: 1 }), R({ id: 2, domain: '' })]).domain, [{ value: core.DOMAIN_NONE, count: 2 }]);
  // 无原型字典：status 为 "toString" / "__proto__" 这类原型键也如实计数
  eq('XR:proto', 'status 为 "toString" / "__proto__" 时按未知状态计数、不被原型语义污染', core.railCounts([R({ id: 1, status: 'toString' }), R({ id: 2, status: '__proto__' }), R({ id: 3, status: 'ONLINE' })]).status, [{ value: 'ONLINE', count: 1 }, { value: '__proto__', count: 1 }, { value: 'toString', count: 1 }]);
});

// ═════════ 十三 listFailed ═════════
section('十三 listFailed', () => {
  // 场景：展开 #22（loading）与 #30（响应到达 → loaded 带数据 D）→ 开始重载（令牌 3；展开令牌全部作废，状态与数据保留）
  const DATA = { upstream: [{ name: 'x' }], objects: [] };
  let S = S0({ page: 2, query: 'q', sortBy: 'id', sortDir: 'asc', filters: { layer: 'dwd' } });
  S = core.toggleExpand(S, { id: 22 }).state;
  S = core.toggleExpand(S, { id: 30 }).state;
  S = core.relationsArrived(S, { id: 30, token: 2, ok: true, data: DATA }).state;
  const R1 = core.reloadStart(S);
  const armed = R1.state;
  eq('XL:setup', '前提：重载令牌 3、展开令牌清空、#22 仍 loading、#30 loaded 且数据保留', [armed.listToken, J(armed.expandTokens), J(armed.expandStatus), J(armed.relations)], [3, '{}', J({ 22: 'loading', 30: 'loaded' }), J({ 30: DATA })]);
  const f = core.listFailed(armed, { token: 3 });
  eq('XL:loading.error', '失败：令牌作废的 loading（#22）改为 error', J(f.state.expandStatus), J({ 22: 'error', 30: 'loaded' }));
  eq('XL:keep', '失败：loaded 的 #30 保留旧关系数据；页码 / 搜索 / 排序 / 筛选 / 展开集合 / 序号原样', [J(f.state.relations), f.state.page, f.state.query, f.state.sortBy, f.state.sortDir, J(f.state.filters), f.state.expanded, f.state.seq], [J({ 30: DATA }), 2, 'q', 'id', 'asc', J({ layer: 'dwd' }), [22, 30], armed.seq]);
  eq('XL:token0', '失败：listToken 置 0；effects 为 []', [f.state.listToken, f.effects], [0, []]);
  // 之后 retryExpand 能对 #22 重试：发新令牌（seq+1）、回 loading；对 loaded 的 #30 无动作
  const rt = core.retryExpand(f.state, { id: 22 });
  eq('XL:retry', '失败后 retryExpand(#22)：fetch-relations 令牌 = seq+1、状态回 loading', [rt.effects, J(rt.state.expandStatus), J(rt.state.expandTokens)], [[{ type: 'fetch-relations', id: 22, token: armed.seq + 1 }], J({ 22: 'loading', 30: 'loaded' }), J({ 22: armed.seq + 1 })]);
  eq('XL:retry', '失败后 retryExpand(#30)（loaded）无动作', core.retryExpand(f.state, { id: 30 }).effects, []);
  // 带旧令牌的 listArrived 仍被丢弃（令牌已归 0）；成功到达的重复 / 迟到不改状态
  const late = core.listArrived(f.state, { token: 3, rows: [R({ id: 22, table_name: 'a' }), R({ id: 30, table_name: 'b' })] });
  eq('XL:late', '失败后旧令牌 3 的 listArrived 被丢弃且状态不变', [late.effects, J(late.state)], [[{ type: 'discard-list', token: 3 }], J(f.state)]);
  // 令牌不符 / 为 0 / 缺失：丢弃，状态不变
  for (const tk of [999, 4, 0, undefined, null]) {
    const r = core.listFailed(armed, { token: tk });
    check('XL:token.wrong', 'listFailed 令牌 ' + String(tk) + ' 不符：丢弃 discard-list、状态不变', r.effects.length === 1 && r.effects[0].type === 'discard-list' && J(r.state) === J(armed), J(r));
  }
  // 更新的重载已开始后，旧失败迟到：丢弃（listToken 已是 5）
  const R2 = core.reloadStart(armed);
  const lateFail = core.listFailed(R2.state, { token: 3 });
  eq('XL:stale', '更新的重载（令牌 5）已开始，令牌 3 的失败迟到：丢弃且状态不变', [lateFail.effects.map(e => e.type), J(lateFail.state)], [['discard-list'], J(R2.state)]);
  // listToken 为 0（没有重载在途）时任何失败都丢弃
  check('XL:idle', '没有重载在途（listToken 0）时 listFailed 丢弃', core.listFailed(S, { token: 3 }).effects[0].type === 'discard-list');
  // 重载开始之后才展开的行：令牌有效、请求在途 → 失败后保持 loading（不被误置 error）
  const after = core.toggleExpand(armed, { id: 40 }).state;
  const f2 = core.listFailed(after, { token: after.listToken });
  eq('XL:live', '重载开始后才展开的 #40（令牌有效）失败后保持 loading，旧 #22 仍改 error', [J(f2.state.expandStatus), J(f2.state.expandTokens)], [J({ 22: 'error', 30: 'loaded', 40: 'loading' }), J(after.expandTokens)]);
  // 38T L2：混合有效 / 作废令牌。#22 #30 在重载开始前展开（令牌被 reloadStart 作废），#50 #60 在重载开始后展开（令牌有效）；
  //   只有 #22 #30 变 error，#50 #60 保持 loading 且令牌原样——只处理首项（#30 仍 loading）或全量置 error（#50 #60 变 error）都会判红
  {
    let M = core.toggleExpand(core.toggleExpand(S0({}), { id: 22 }).state, { id: 30 }).state;
    M = core.reloadStart(M).state;
    M = core.toggleExpand(core.toggleExpand(M, { id: 50 }).state, { id: 60 }).state;
    const tok = J(M.expandTokens);
    const mf = core.listFailed(M, { token: M.listToken });
    eq('XL:mixed', '混合令牌：作废的 #22 #30 变 error，有效的 #50 #60 保持 loading', J(mf.state.expandStatus), J({ 22: 'error', 30: 'error', 50: 'loading', 60: 'loading' }));
    eq('XL:mixed', '混合令牌：有效令牌原样保留（{50,60}），effects 为 []', [J(mf.state.expandTokens), mf.effects], [tok, []]);
    eq('XL:mixed', '混合令牌：作废的两项都能 retryExpand，有效的两项（loading）不能', [core.retryExpand(mf.state, { id: 22 }).effects.length, core.retryExpand(mf.state, { id: 30 }).effects.length, core.retryExpand(mf.state, { id: 50 }).effects.length, core.retryExpand(mf.state, { id: 60 }).effects.length], [1, 1, 0, 0]);
  }
  // 已经是 error 的保持 error
  const withErr = core.relationsArrived(core.toggleExpand(S0({}), { id: 7 }).state, { id: 7, token: 1, ok: false }).state;
  const armedErr = core.reloadStart(withErr).state;
  eq('XL:err', '原本就是 error 的展开项失败后仍为 error', J(core.listFailed(armedErr, { token: armedErr.listToken }).state.expandStatus), J({ 7: 'error' }));
  // id 类型：字符串 "22" 的 loading 同样被置 error
  const strS = core.reloadStart(core.toggleExpand(S0({}), { id: '22' }).state).state;
  eq('XL:idtype', '展开用字符串 "22" 同样被置 error；重试用数字 22 生效', [J(core.listFailed(strS, { token: strS.listToken }).state.expandStatus), core.retryExpand(core.listFailed(strS, { token: strS.listToken }).state, { id: 22 }).effects.length], [J({ 22: 'error' }), 1]);
  // pageSize 参数：与其它事件一致，传了即抛错
  check('XL:ps', 'listFailed 的参数里带 pageSize 抛错', /不接收 pageSize/.test(throwsMsg(() => core.listFailed(armed, { token: 3, pageSize: 20 }))));
  // 不修改入参（深冻结）
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(k => deepFreeze(o[k])); } return o; };
  const frozenArmed = deepFreeze(JSON.parse(J(armed)));
  const ok1 = throwsMsg(() => core.listFailed(frozenArmed, { token: 3 }));
  const ok2 = throwsMsg(() => core.listFailed(frozenArmed, { token: 9 }));
  check('XL:frozen', 'listFailed 对深冻结入参不抛（命中 / 丢弃两条路径）', ok1 === '' && ok2 === '', ok1 + ' ' + ok2);
  // 状态由 createState 开始的完整链路：reloadStart → listFailed → reloadStart → listArrived 正常
  const c0 = core.reloadStart(core.createState());
  const c1 = core.listFailed(c0.state, { token: c0.state.listToken });
  const c2 = core.reloadStart(c1.state);
  const c3 = core.listArrived(c2.state, { token: c2.state.listToken, rows: [R({ id: 1, table_name: 'a' })] });
  eq('XL:chain', '失败后再重载再到达：令牌递增（1 → 失败 → 2）、到达后 listToken 归 0', [c0.state.listToken, c1.state.listToken, c2.state.listToken, c3.state.listToken], [1, 0, 2, 0]);
});

// ═════════ 十四 显示映射 ═════════
section('十四 显示映射', () => {
  // firstSentence 期望表：[输入, 期望, 推导]
  const FS = [
    [null, '', 'null → 空'], [undefined, '', 'undefined → 空'], ['', '', '空串'], ['   \n\t ', '', '纯空白 trim 后为空'],
    ['无分隔符的说明', '无分隔符的说明', '没有分隔符取全文'],
    ['  前后空白  ', '前后空白', '先 trim'],
    ['首句。第二句', '首句', '「。」之前'],
    ['首句；第二句。第三句', '首句', '「；」在「。」之前，取更早的分隔符'],
    ['首句。第二句；第三句', '首句', '「。」在「；」之前'],
    ['。开头句号后文', '', '以分隔符开头 → 空（页面显示「（未填写实现说明）」）'],
    ['；开头分号后文', '', '以分隔符开头 → 空'],
    ['  。前有空白的句号', '', 'trim 后以分隔符开头 → 空'],
    ['  甲  。乙', '甲', '截取后再 trim'],
    ['首句；', '首句', '结尾分号'],
    ['A.B;C', 'A.B;C', 'ASCII 的 . 和 ; 不是分隔符'],
    ['第一行\n第二行。三', '第一行\n第二行', '换行不是分隔符'],
    ['只有分号；后面还有；更多', '只有分号', '取第一个「；」'],
  ];
  FS.forEach(([inp, want, why]) => eq('XD:fs', 'firstSentence ' + J(inp) + '（' + why + '）', core.firstSentence(inp), want));

  // acceptanceView：8 种 kind。MM-DD 取 at 的第 6–10 个字符（索引 5..10）。
  const AV = (state, at, extra) => acc(state, at, extra);
  const mk = (kind, mark, text, date, staleBadge, title) => ({ kind, mark, text, date, staleBadge, title: title || '' });
  eq('XD:av.pass', 'pass：✓ 通过 + MM-DD', core.acceptanceView(AV('pass', '2026-03-05 10:00:00')), mk('pass', '✓', '✓ 通过', '03-05', false));
  eq('XD:av.warn', 'warn：! 有警告 + MM-DD', core.acceptanceView(AV('warn', '2026-11-30 01:02:03')), mk('warn', '!', '! 有警告', '11-30', false));
  eq('XD:av.fail', 'fail：✕ 未通过 + MM-DD', core.acceptanceView(AV('fail', '2026-12-31 23:59:59')), mk('fail', '✕', '✕ 未通过', '12-31', false));
  eq('XD:av.partial', 'partial：structure 非 null 且 data 为 null → 缺数据验收', core.acceptanceView(AV('partial', '2026-04-01 00:00:00', { stages: { structure: 'pass', data: null } })), mk('partial', '◐', '◐ 缺数据验收', '04-01', false));
  eq('XD:av.partial', 'partial：structure 为 null、data 非 null → 缺结构验收', core.acceptanceView(AV('partial', '2026-04-01 00:00:00', { stages: { structure: null, data: 'warn' } })), mk('partial', '◐', '◐ 缺结构验收', '04-01', false));
  eq('XD:av.partial', 'partial：两者都为 null → 其余情形 → 缺结构验收', core.acceptanceView(AV('partial', '2026-04-01 00:00:00', { stages: { structure: null, data: null } })).text, '◐ 缺结构验收');
  eq('XD:av.partial', 'partial：stages 为 null（ODS 无阶段）→ 其余情形 → 缺结构验收', core.acceptanceView(AV('partial', '2026-04-01 00:00:00', { stages: null })).text, '◐ 缺结构验收');
  eq('XD:av.partial', 'partial：两者都非 null（理论上不会出现）→ 其余情形 → 缺结构验收', core.acceptanceView(AV('partial', '2026-04-01 00:00:00', { stages: { structure: 'pass', data: 'pass' } })).text, '◐ 缺结构验收');
  eq('XD:av.stale', 'stale + prevResult pass：✓、MM-DD、staleBadge', core.acceptanceView(AV('stale', '2026-02-10 08:00:00', { prevResult: 'pass' })), mk('stale', '✓', '✓', '02-10', true));
  eq('XD:av.stale', 'stale + prevResult warn：!', core.acceptanceView(AV('stale', '2026-02-10 08:00:00', { prevResult: 'warn' })), mk('stale', '!', '!', '02-10', true));
  eq('XD:av.stale', 'stale + prevResult 缺失（null / undefined）：—', [core.acceptanceView(AV('stale', '2026-02-10 08:00:00', { prevResult: null })), core.acceptanceView({ state: 'stale', at: '2026-02-10 08:00:00' })], [mk('stale', '—', '—', '02-10', true), mk('stale', '—', '—', '02-10', true)]);
  check('XD:av.stale', 'stale + 意外的 prevResult（fail）抛错，不静默当作某一态', /fail/.test(throwsMsg(() => core.acceptanceView(AV('stale', '2026-02-10 08:00:00', { prevResult: 'fail' })))));
  eq('XD:av.none', 'none：无验收，不带日期（即使 at 有值）', core.acceptanceView(AV('none', '2026-02-10 08:00:00')), mk('none', '', '无验收', '', false));
  eq('XD:av.companion', 'companion：随主模型，不带日期', core.acceptanceView(AV('companion', '2026-02-10 08:00:00')), mk('companion', '', '随主模型', '', false));
  eq('XD:av.unknown', 'acc 为 null（D-6 第七态）：unknown、—、title 提示', core.acceptanceView(null), { kind: 'unknown', mark: '', text: '—', date: '', staleBadge: false, title: '验收摘要加载失败' });
  eq('XD:av.unknown', 'acc 为 undefined 同 null', core.acceptanceView(undefined), core.acceptanceView(null));
  for (const bad of ['weird', 'PASS', '', undefined, 'toString']) {
    check('XD:av.bad', '未知 state ' + J(bad) + ' 抛错（分类表兜底分支）', /验收状态/.test(throwsMsg(() => core.acceptanceView({ state: bad, at: null }))));
  }
  eq('XD:av.at', 'at 缺失（null / undefined / 缺键）→ date 为空串', [core.acceptanceView({ state: 'pass', at: null }).date, core.acceptanceView({ state: 'pass' }).date, core.acceptanceView({ state: 'warn', at: undefined }).date], ['', '', '']);
  eq('XD:av.at', "at 用 'T' 分隔符也取第 6–10 个字符：2025-12-31T23:59:59 → 12-31", core.acceptanceView({ state: 'fail', at: '2025-12-31T23:59:59' }).date, '12-31');
  eq('XD:av.at', 'at 过短（不足 6 个字符）→ 空串', core.acceptanceView({ state: 'pass', at: '2026' }).date, '');

  // 徽章文案：与后端同源。require 失败直接判红（不跳过）
  let backend = null, backendErr = '';
  try { backend = require('../routes/model-center/impl-verify.js').BADGE_LABELS; } catch (e) { backendErr = String(e && e.message || e); }
  check('XD:labels.backend', 'require(../routes/model-center/impl-verify.js).BADGE_LABELS 可取到且是对象（失败即红，不跳过）', !!backend && typeof backend === 'object', backendErr);
  eq('XD:labels.backend', 'IMPL_BADGE_LABELS 与后端 BADGE_LABELS deepEqual', JSON.parse(J(core.IMPL_BADGE_LABELS)), backend ? JSON.parse(J(backend)) : '(后端表缺失)');
  // 手写文案表（方案 §4.4）：后端被误改时由这张表兜底
  eq('XD:labels.hand', 'IMPL_BADGE_LABELS 手写期望（7 项）', JSON.parse(J(core.IMPL_BADGE_LABELS)), { unverified: '未核验', verify_failed: '核验失败', stale: '待重核', prod_missing: '生产缺失', unregistered: '未登记', consistent: '一致', inconsistent: '不一致' });
  check('XD:labels.frozen', 'IMPL_BADGE_LABELS / IMPL_BADGE_TONE 已冻结', Object.isFrozen(core.IMPL_BADGE_LABELS) && Object.isFrozen(core.IMPL_BADGE_TONE));
  // tone：键集恰为 7 个 code；取值手写（D-35）
  const CODES = ['consistent', 'inconsistent', 'prod_missing', 'stale', 'unregistered', 'unverified', 'verify_failed'];
  eq('XD:tone.keys', 'IMPL_BADGE_TONE 的键集恰为 7 个 code', Object.keys(core.IMPL_BADGE_TONE).sort(), CODES);
  eq('XD:tone.val', 'IMPL_BADGE_TONE 取值：consistent ok；inconsistent / prod_missing bad；stale / verify_failed warn；unverified / unregistered muted', JSON.parse(J(core.IMPL_BADGE_TONE)), { consistent: 'ok', inconsistent: 'bad', prod_missing: 'bad', stale: 'warn', verify_failed: 'warn', unverified: 'muted', unregistered: 'muted' });
  eq('XD:tone.cover', 'tone 的键集 = labels 的键集（每个文案 code 都有色调）', Object.keys(core.IMPL_BADGE_TONE).sort(), Object.keys(core.IMPL_BADGE_LABELS).sort());
});

// ═════════ 十五 P36（C4c-4 4a）：条件没变时扩展状态字段原样保留 ═════════
section('十五 P36', () => {
  // 状态带着 C4c-0 起的三个筛选键（view / status / domain）与一份已加载的关系数据；setQuery 同词 / gotoPage 同页必须一个字段都不动。
  const REL = { upstream: [], downstream: [], objects: [], objectState: 'standard' };
  const base = S0({ page: 2, query: 'x', filters: { view: 'stale', status: 'ONLINE', domain: '__none__' }, expanded: [5], expandTokens: { 5: 3 }, expandStatus: { 5: 'loaded' }, relations: { 5: REL }, seq: 3 });
  const BASE_J = J(base);
  const sameQ = core.setQuery(base, ' x ');
  eq('XP:q.same', '同词（首尾空格不同）：筛选 / 展开 / 令牌 / 状态 / 关系数据 / 页码 / seq / effects 全部不变', [J(sameQ.state), sameQ.effects], [BASE_J, []]);
  const sameP = core.gotoPage(base, { page: 2, totalPages: 5 });
  eq('XP:p.same', '翻到当前页：同上全部不变', [J(sameP.state), sameP.effects], [BASE_J, []]);
  // 改了才动：异词 / 异页清展开与关系数据，筛选键原样保留（setQuery / gotoPage 不改筛选）
  const diffQ = core.setQuery(base, 'y').state;
  eq('XP:q.diff', '异词：回第 1 页、展开 / 令牌 / 状态 / 关系数据清空，三个筛选键保留', [diffQ.page, diffQ.query, diffQ.expanded, diffQ.expandTokens, diffQ.expandStatus, diffQ.relations, diffQ.filters], [1, 'y', [], {}, {}, {}, { view: 'stale', status: 'ONLINE', domain: '__none__' }]);
  const diffP = core.gotoPage(base, { page: 3, totalPages: 5 }).state;
  eq('XP:p.diff', '异页：展开 / 令牌 / 状态 / 关系数据清空，筛选键保留', [diffP.page, diffP.expanded, diffP.expandTokens, diffP.expandStatus, diffP.relations, diffP.filters], [3, [], {}, {}, {}, { view: 'stale', status: 'ONLINE', domain: '__none__' }]);
  // 边界：P36 只覆盖 setQuery / gotoPage；setFilter 同值仍按改筛选处理（回第 1 页并清空）——左栏的「再点已选中项」走回「全部」，不会产生同值调用
  const sf = core.setFilter(base, 'status', 'ONLINE').state;
  eq('XP:f.same', 'setFilter 传同一取值不在 P36 范围：仍回第 1 页并清空展开', [sf.page, sf.expanded, sf.expandTokens, sf.expandStatus, sf.relations], [1, [], {}, {}, {}]);
  // 列表刷新失败后（展开项 loading → error 可重试），同词 / 同页不得抹掉可重试的 error 态
  const e0 = core.toggleExpand(S0({ page: 1, query: 'x' }), { id: 5 }).state;
  const e1 = core.reloadStart(e0).state;
  const failed = core.listFailed(e1, { token: e1.listToken }).state;
  eq('XP:err.pre', '前提：失败后展开项 5 为 error 且无有效令牌', [failed.expandStatus, failed.expandTokens], [{ 5: 'error' }, {}]);
  const failedSame = core.setQuery(failed, 'x').state;
  const failedSamePage = core.gotoPage(failed, { page: 1, totalPages: 1 }).state;
  eq('XP:err.keep', '失败后同词 / 同页：error 态与展开集合保留（可重试）', [failedSame.expandStatus, failedSame.expanded, failedSamePage.expandStatus, failedSamePage.expanded], [{ 5: 'error' }, [5], { 5: 'error' }, [5]]);
  eq('XP:err.retry', '失败后同词再重试：仍发出 fetch-relations', core.retryExpand(failedSame, { id: 5 }).effects.map(e => e.type + ':' + e.id), ['fetch-relations:5']);
});

// ═════════ 八 不修改入参 ═════════
section('八 不修改入参', () => {
  const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach(k => deepFreeze(o[k])); } return o; };
  const sortRows = deepFreeze(JSON.parse(J(SORT_X)));
  const filtRows = deepFreeze(JSON.parse(J(FR)));
  const rcRows = deepFreeze(JSON.parse(J(RC)));
  const st = deepFreeze(S0({ page: 2, expanded: [22], expandTokens: { 22: 1 }, expandStatus: { 22: 'loading' }, seq: 1, filters: { view: 'stale' }, listToken: 5, sortBy: 'domain', sortDir: 'asc' }));
  const run = (name, fn) => { try { fn(); check('XI', `${name}：对深冻结入参不抛（未修改入参）`, true); } catch (e) { check('XI', `${name}：修改了入参`, false, e.message); } };
  run('computeView（acceptance_at desc）', () => core.computeView(sortRows, P20({ sortBy: 'acceptance_at', sortDir: 'desc' })));
  run('computeView（domain asc）', () => core.computeView(sortRows, P20({ sortBy: 'domain', sortDir: 'asc' })));
  run('computeView（view / status / domain 筛选）', () => core.computeView(filtRows, P20({ filters: { view: 'custom', status: 'ONLINE', domain: core.DOMAIN_NONE } })));
  run('railCounts', () => core.railCounts(rcRows));
  run('listFailed（命中）', () => core.listFailed(st, { token: 5 }));
  run('listFailed（丢弃）', () => core.listFailed(st, { token: 6 }));
  run('toggleSort（新键）', () => core.toggleSort(st, 'acceptance_at'));
  run('setFilter（新键）', () => core.setFilter(st, 'view', 'pending'));
  run('listArrived（状态带新排序键）', () => core.listArrived(st, { token: 5, rows: sortRows }));
  run('focus（状态带新排序键）', () => core.focus(st, { id: 7, rows: sortRows }));
  run('firstSentence / acceptanceView', () => { core.firstSentence('甲。乙'); core.acceptanceView(deepFreeze({ state: 'stale', at: '2026-01-01 00:00:00', prevResult: 'pass', stages: { structure: 'pass', data: null }, rows: null })); });
  for (const n of ['EXTRA_SORT_FIELDS', 'SORT_KEYS', 'VIEW_VALUES', 'IMPL_BADGE_LABELS', 'IMPL_BADGE_TONE']) check('XZ', n + ' 导出表已冻结', Object.isFrozen(core[n]));
});

// ═════════ B 两端加载一致 + 导出 ═════════
section('B 两端加载一致', () => {
  const coreSrc = fs.readFileSync(CORE_FILE, 'utf8').replace(/\r\n/g, '\n');
  const kitSrc = fs.readFileSync(KIT_FILE, 'utf8').replace(/\r\n/g, '\n');
  const ctx = vm.createContext({});
  vm.runInContext('var window = this;', ctx);
  vm.runInContext(kitSrc, ctx);
  vm.runInContext(coreSrc, ctx);
  const bc = vm.runInContext('window.ModelCatalogCore', ctx);
  check('XB:load', '浏览器方式（window、无 module）加载得到 ModelCatalogCore，且有新导出', !!bc && ['listFailed', 'railCounts', 'firstSentence', 'acceptanceView'].every(k => typeof bc[k] === 'function'));
  eq('XB:keys', '导出键两端相同', Object.keys(bc).sort(), Object.keys(core).sort());
  const NEW = ['EXTRA_SORT_FIELDS', 'SORT_KEYS', 'DOMAIN_NONE', 'VIEW_VALUES', 'listFailed', 'railCounts', 'firstSentence', 'acceptanceView', 'IMPL_BADGE_LABELS', 'IMPL_BADGE_TONE'];
  check('XB:keys', '导出了全部 10 个新名字', NEW.every(k => k in core), NEW.filter(k => !(k in core)).join());
  const both = (name, fn) => check('XB:same', name + ' 两端一致', J(fn(core)) === J(fn(bc)), J(fn(core)) + ' vs ' + J(fn(bc)));
  both('computeView acceptance_at desc', (c) => c.computeView(SORT_X, P20({ sortBy: 'acceptance_at', sortDir: 'desc' })));
  both('computeView domain asc', (c) => c.computeView(SORT_X, P20({ sortBy: 'domain', sortDir: 'asc' })));
  both('computeView 新筛选', (c) => c.computeView(FR, P20({ filters: { view: 'custom', status: 'ONLINE' } })));
  both('railCounts', (c) => c.railCounts(RC));
  both('acceptanceView', (c) => [c.acceptanceView(null), c.acceptanceView({ state: 'partial', at: '2026-01-02 00:00:00', stages: { structure: 'pass', data: null } })]);
  both('firstSentence', (c) => ['首句；第二句', '  ', null].map(c.firstSentence));
  both('listFailed', (c) => { const a = c.reloadStart(c.toggleExpand(c.createState(), { id: 1 }).state).state; return c.listFailed(a, { token: a.listToken }); });
  both('IMPL 表', (c) => [c.IMPL_BADGE_LABELS, c.IMPL_BADGE_TONE, c.DOMAIN_NONE, c.SORT_KEYS, c.VIEW_VALUES]);
  // 头注释的接线契约三条
  const head = coreSrc.slice(0, coreSrc.indexOf('*/'));
  check('XB:contract', '头注释写明：排序键只能取 SORT_KEYS', /排序键只能取 SORT_KEYS/.test(head));
  check('XB:contract', '头注释写明：筛选键只能取 FILTER_PREDICATES 的键', /筛选键只能取 FILTER_PREDICATES 的键/.test(head));
  check('XB:contract', '头注释写明：左栏计数只能用 railCounts', /左栏计数只能用 railCounts/.test(head));
  check('XB:contract', '头注释职责范围补上显示映射与 listFailed', /显示映射/.test(head) && /listFailed/.test(head));
});

console.log(`通过 ${pass}，失败 ${fail}`);
console.log('各节断言数：' + Object.keys(perSection).map(k => `${k} ${perSection[k]}`).join('；'));
process.exit(fail ? 1 : 0);
