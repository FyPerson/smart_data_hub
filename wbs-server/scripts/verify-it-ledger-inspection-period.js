'use strict';
// 巡检周期判据纯函数验证（#200 C0，方案 v1.5 §4.3）。
// 被测：routes/it-ledger/inspection-period.js。纯函数，不起服务、不用夹具、不读钟；结果不随运行当天变化。
// 变异对照：脚本把被测源码（先归一 CRLF）按下面的常量表逐个改一处，在内存里加载变异版，跑同一组断言，
//   每个变异必须至少让一条断言失败，否则判红（变异存活 = 这组断言管不住那条边界）。
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '../routes/it-ledger/inspection-period.js');

// [名称, 原文串（必须在源码中恰好出现一次）, 替换串]
const MUTATIONS = [
  ['周起点周一改周日', '(new Date(ms).getUTCDay() + 6) % 7', 'new Date(ms).getUTCDay()'],
  ['周长7天改6天', 'start + 6 * MS_PER_DAY', 'start + 5 * MS_PER_DAY'],
  ['月末差一天', 'Date.UTC(y, mo, 1) - MS_PER_DAY', 'Date.UTC(y, mo, 1)'],
  ['月初差一天', 'Date.UTC(y, mo - 1, 1)', 'Date.UTC(y, mo - 1, 2)'],
  ['inPeriod起点闭区间改开区间', 'period.start <= day', 'period.start < day'],
  ['inPeriod终点闭区间改开区间', 'day <= period.end', 'day < period.end'],
  ['resolveCycle默认值改month', "const DEFAULT_CYCLE = 'week';", "const DEFAULT_CYCLE = 'month';"],
  ['不存在的日期不再抛错', "throw new Error('日期不存在：' + day);", 'void back;'],
];

function loadModule(src) {
  const mod = { exports: {} };
  const fn = vm.runInThisContext('(function (module, exports, require) {' + src + '\n})', { filename: SOURCE });
  fn(mod, mod.exports, require);
  return mod.exports;
}

// 同一组断言：返回 [{name, ok, error}]，不在第一条失败处中断。
function runSuite(api) {
  const results = [];
  const check = (name, fn) => {
    try { fn(); results.push({ name, ok: true }); } catch (error) { results.push({ name, ok: false, error: error && error.message }); }
  };
  const equal = (name, actual, expected) => check(name, () => assert.deepEqual(actual, expected));
  const throws = (name, fn) => check(name, () => assert.throws(fn));
  const week = (start, end) => ({ cycle: 'week', start, end });
  const month = (start, end) => ({ cycle: 'month', start, end });

  // periodOf：周（周一起、周日止）
  equal('周·周一当天', api.periodOf('2026-11-16', 'week'), week('2026-11-16', '2026-11-22'));
  equal('周·周三', api.periodOf('2026-11-18', 'week'), week('2026-11-16', '2026-11-22'));
  equal('周·周四', api.periodOf('2026-11-19', 'week'), week('2026-11-16', '2026-11-22'));
  equal('周·周日当天', api.periodOf('2026-11-22', 'week'), week('2026-11-16', '2026-11-22'));
  equal('周·周日次日落入下一周', api.periodOf('2026-11-23', 'week'), week('2026-11-23', '2026-11-29'));
  equal('周·跨月（12-30）', api.periodOf('2026-12-30', 'week'), week('2026-12-28', '2027-01-03'));
  equal('周·跨月周的周一当天', api.periodOf('2026-12-28', 'week'), week('2026-12-28', '2027-01-03'));
  equal('周·跨年周的周日当天', api.periodOf('2027-01-03', 'week'), week('2026-12-28', '2027-01-03'));
  equal('周·跨年（元旦）', api.periodOf('2027-01-01', 'week'), week('2026-12-28', '2027-01-03'));
  equal('周·跨年（2024-12-31）', api.periodOf('2024-12-31', 'week'), week('2024-12-30', '2025-01-05'));
  equal('周·月末周日跨月（03-01）', api.periodOf('2026-03-01', 'week'), week('2026-02-23', '2026-03-01'));
  equal('周·闰年2月末（2028-02-29）', api.periodOf('2028-02-29', 'week'), week('2028-02-28', '2028-03-05'));
  // periodOf：月
  equal('月·月中', api.periodOf('2026-11-19', 'month'), month('2026-11-01', '2026-11-30'));
  equal('月·月初当天', api.periodOf('2026-11-01', 'month'), month('2026-11-01', '2026-11-30'));
  equal('月·月末当天', api.periodOf('2026-11-30', 'month'), month('2026-11-01', '2026-11-30'));
  equal('月·12月', api.periodOf('2026-12-15', 'month'), month('2026-12-01', '2026-12-31'));
  equal('月·31日月末（2027-01-31）', api.periodOf('2027-01-31', 'month'), month('2027-01-01', '2027-01-31'));
  equal('月·平年2月', api.periodOf('2026-02-10', 'month'), month('2026-02-01', '2026-02-28'));
  equal('月·闰年2月末（2028-02-29）', api.periodOf('2028-02-29', 'month'), month('2028-02-01', '2028-02-29'));
  // inPeriod
  const w = api.periodOf('2026-11-19', 'week'), m = api.periodOf('2026-11-19', 'month');
  equal('inPeriod·周起点为真', api.inPeriod('2026-11-16', w), true);
  equal('inPeriod·周终点为真', api.inPeriod('2026-11-22', w), true);
  equal('inPeriod·周中间为真', api.inPeriod('2026-11-19', w), true);
  equal('inPeriod·周起点前一天为假', api.inPeriod('2026-11-15', w), false);
  equal('inPeriod·周终点后一天为假', api.inPeriod('2026-11-23', w), false);
  equal('inPeriod·月起点为真', api.inPeriod('2026-11-01', m), true);
  equal('inPeriod·月终点为真', api.inPeriod('2026-11-30', m), true);
  equal('inPeriod·月起点前一天为假', api.inPeriod('2026-10-31', m), false);
  equal('inPeriod·月终点后一天为假', api.inPeriod('2026-12-01', m), false);
  equal('inPeriod·null为假', api.inPeriod(null, w), false);
  // 入参不合法
  for (const bad of ['2026-1-5', '2026-02-30', '2026-13-01', '2026-00-10', '2026-11-31', '20261105', '', 'abc', null, undefined, 20261105]) {
    throws('periodOf·非法日期抛错 ' + JSON.stringify(bad), () => api.periodOf(bad, 'week'));
  }
  throws('periodOf·非法周期抛错', () => api.periodOf('2026-11-19', 'day'));
  equal('periodOf·闰年当天合法 2028-02-29 / 平年 2027-02-28 合法', [api.periodOf('2028-02-29', 'month').end, api.periodOf('2027-02-28', 'month').end], ['2028-02-29', '2027-02-28']);
  throws('periodOf·平年2月29日不存在', () => api.periodOf('2027-02-29', 'month'));
  // 周期取值
  equal('CYCLES', api.CYCLES, ['week', 'month']);
  equal('resolveCycle·undefined 默认 week', api.resolveCycle(undefined), 'week');
  equal('resolveCycle·week', api.resolveCycle('week'), 'week');
  equal('resolveCycle·month', api.resolveCycle('month'), 'month');
  equal('resolveCycle· Month 去空白转小写', api.resolveCycle(' Month '), 'month');
  equal('resolveCycle·weekly 非法默认 week', api.resolveCycle('weekly'), 'week');
  equal('resolveCycle·空串默认 week', api.resolveCycle(''), 'week');
  equal('readCycleFromEnv·未设置', api.readCycleFromEnv({}), { cycle: 'week', raw: undefined, valid: true });
  equal('readCycleFromEnv·week', api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'week' }), { cycle: 'week', raw: 'week', valid: true });
  equal('readCycleFromEnv·month', api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'month' }), { cycle: 'month', raw: 'month', valid: true });
  equal('readCycleFromEnv· Month ', api.readCycleFromEnv({ IT_INSPECTION_CYCLE: ' Month ' }), { cycle: 'month', raw: ' Month ', valid: true });
  equal('readCycleFromEnv·weekly', api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'weekly' }), { cycle: 'week', raw: 'weekly', valid: false });
  equal('readCycleFromEnv·空串', api.readCycleFromEnv({ IT_INSPECTION_CYCLE: '' }), { cycle: 'week', raw: '', valid: false });
  // 启动日志行
  equal('cycleLogLine·未设置', api.cycleLogLine(api.readCycleFromEnv({})), '[it-ledger] 巡检周期=week（IT_INSPECTION_CYCLE 未设置，用默认）');
  equal('cycleLogLine·week', api.cycleLogLine(api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'week' })), '[it-ledger] 巡检周期=week');
  equal('cycleLogLine·month', api.cycleLogLine(api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'month' })), '[it-ledger] 巡检周期=month');
  equal('cycleLogLine·不合法', api.cycleLogLine(api.readCycleFromEnv({ IT_INSPECTION_CYCLE: 'xx' })), '[it-ledger] 巡检周期=week（IT_INSPECTION_CYCLE="xx" 不合法，用默认）');
  return results;
}

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('[OK] ' + name); };
const bad = (name, detail) => { fail++; console.error('[FAIL] ' + name + (detail ? ' :: ' + detail : '')); };

const source = fs.readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n');

// 一、真实源码：整组断言全绿
const clean = runSuite(loadModule(source));
for (const r of clean) { if (r.ok) ok(r.name); else bad(r.name, r.error); }
if (clean.length < 50) bad('断言数不足，疑似用例被删', String(clean.length));

// 一-B、前端取词与标题（#200 C0 修复批 1 L2）：从前端源码按函数声明文本截出 periodWord / periodTitle，
//   在 vm 里求值断言。声明文本找不到或出现多于一处一律判红（防止函数改名 / 复制后断言悄悄测了别的东西）。
const FRONT = path.join(__dirname, '../public/assets/js/it-ledger-inspection-sheets.js');
function extractFunction(text, name) {
  const marker = 'function ' + name + '(';
  const first = text.indexOf(marker);
  if (first < 0 || text.indexOf(marker, first + 1) >= 0) return null;
  const open = text.indexOf('{', first);
  let depth = 0, i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  return depth === 0 ? text.slice(first, i + 1) : null;
}
const frontSource = fs.readFileSync(FRONT, 'utf8').replace(/\r\n/g, '\n');
const wordSrc = extractFunction(frontSource, 'periodWord'), titleSrc = extractFunction(frontSource, 'periodTitle');
if (!wordSrc || !titleSrc) bad('前端 periodWord / periodTitle 声明必须各恰好出现一处', 'periodWord=' + Boolean(wordSrc) + ' periodTitle=' + Boolean(titleSrc));
else {
  ok('前端 periodWord / periodTitle 声明各恰好一处');
  const front = vm.runInNewContext(wordSrc + '\n' + titleSrc + '\n({ periodWord, periodTitle })');
  const frontEqual = (name, actual, expected) => { try { assert.deepEqual(actual, expected); ok(name); } catch (e) { bad(name, JSON.stringify(actual) + ' != ' + JSON.stringify(expected)); } };
  frontEqual('前端标题·周同月', front.periodTitle({ cycle: 'week', start: '2026-11-16', end: '2026-11-22' }), '11 月 16 日–22 日');
  frontEqual('前端标题·周跨月', front.periodTitle({ cycle: 'week', start: '2026-03-30', end: '2026-04-05' }), '3 月 30 日–4 月 5 日');
  frontEqual('前端标题·周跨年', front.periodTitle({ cycle: 'week', start: '2026-12-28', end: '2027-01-03' }), '12 月 28 日–1 月 3 日');
  frontEqual('前端标题·月', front.periodTitle({ cycle: 'month', start: '2026-11-01', end: '2026-11-30' }), '2026 年 11 月');
  frontEqual('前端用词·周', front.periodWord('week'), '本周');
  frontEqual('前端用词·月', front.periodWord('month'), '本月');
}

// 一-C、周期用词只有一处来源（#200 末次合并审修复批 1 F5（段 6），预筛 LOW-1）：待处理块源码里不再自己写「本周」「本月」，
//   用词只经 L.periodWord（定义在巡检视图，导出到 L）。判据函数自带对照：喂入带字面量的副本必须判红，防止判据本身是空的。
const PENDING = path.join(__dirname, '../public/assets/js/it-ledger-pending.js');
const pendingSource = fs.readFileSync(PENDING, 'utf8').replace(/\r\n/g, '\n');
const hasPeriodLiteral = text => /本周|本月/.test(text);
if (hasPeriodLiteral(pendingSource)) bad('F5 待处理块源码里不再出现「本周」「本月」字面量');
else ok('F5 待处理块源码里不再出现「本周」「本月」字面量');
if (!pendingSource.includes('L.periodWord(')) bad('F5 待处理块经 L.periodWord(...) 取周期用词');
else ok('F5 待处理块经 L.periodWord(...) 取周期用词');
if (frontSource.split('L.periodWord = periodWord;').length - 1 !== 1) bad('F5 巡检视图恰好一处导出 L.periodWord = periodWord');
else ok('F5 巡检视图恰好一处导出 L.periodWord = periodWord');
if (!hasPeriodLiteral(pendingSource + "\nconst word = cycle === 'month' ? '本月' : '本周';")) bad('F5 对照：带字面量的副本必须被判据识别');
else ok('F5 对照：带字面量的副本被判据识别（变异判红）');

// 二、变异对照：每个变异恰好命中一处，且至少让一条断言失败
for (const [name, from, to] of MUTATIONS) {
  const hits = source.split(from).length - 1;
  if (hits !== 1) { bad('变异原文串必须恰好出现一次 ' + name, 'hits=' + hits); continue; }
  ok('变异原文串唯一 ' + name);
  const mutated = runSuite(loadModule(source.replace(from, () => to)));
  const failed = mutated.filter(r => !r.ok).map(r => r.name);
  if (failed.length >= 1) ok('变异被判红 ' + name + ' → 首条失败断言：' + failed[0] + '（共 ' + failed.length + ' 条）');
  else bad('变异存活 ' + name);
}

console.log('PERIOD PASS=' + pass + ' FAIL=' + fail);
if (fail) process.exitCode = 1;
