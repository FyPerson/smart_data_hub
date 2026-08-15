/**
 * 部署前检测脚本：sys_issues.deadline 全库归一探针（§14·S11 预筛 MED-3）
 *
 * 背景：方案 v1.8 §14.1-F3 承诺"非法非空 deadline ⇒ 上线前全库探针证『归一失败的非空值结构性不存在』"——
 *   S11 首版实现只写了 SYS_DEADLINE_MALFORMED 这道运行时防线（评估函数 evaluateCompletionOverrun 内联
 *   normalizeDateOnlyForToleranceCalc，归一失败即 409），但漏做承诺的"上线前探针"这一半（存量数据面的
 *   证据），S11 预筛补齐。
 *
 * 做什么：
 *   ① 真实库扫描——连接生产同构的本地 task_pool.db，读出 sys_issues.deadline 全部非空值，逐个跑
 *      真实归一函数（I.normalizeDateOnlyForToleranceCalc，直调 index.js _internals 导出的同一份实现，
 *      非复刻——防复刻漂移，同 RC-L2 既有纪律），断言归一失败计数=0。
 *   ② 双向证明（[[feedback_probe_test_bidirectional_proof]]）——①只证"没抓到问题"，不证"探针真的
 *      会抓问题"；本节人为构造几个真实畸形值（'2026-13-01'/'非日期字符串'/'2026-02-30' 等）喂给同一个
 *      归一函数，断言这些值确实被判失败——证明探针本身有效，不是"regex 恒真"这类自欺。
 *
 * 用途：上线前跑一次（或 completion-overrun 部署闸的一部分），确认当前无存量脏 deadline 数据会撞
 *   SYS_DEADLINE_MALFORMED；跑完不改任何数据（全程只读）。
 *
 * 运行：node scripts/probe-sys-deadline-normalize.js
 */
'use strict';

const path = require('path');
const assert = require('assert');
const sqlite3 = require('sqlite3');

// ── 工厂期依赖：复用既有 verify 惯例（内存库供路由工厂启动用，本脚本不落地任何路由请求，只借
//   _internals.normalizeDateOnlyForToleranceCalc 这一个纯函数，避免复刻其正则/归一契约产生漂移）。
const memDb = new sqlite3.Database(':memory:');
const memRun = (sql, params = []) => new Promise((res, rej) => memDb.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const memAll = (sql, params = []) => new Promise((res, rej) => memDb.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const memGet = (sql, params = []) => new Promise((res, rej) => memDb.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};
const authenticateToken = (_req, res) => res.status(401).json({ error: '未登录' });
const requireAdmin = (_req, res) => res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db: memDb, dbRunAsync: memRun, dbGetAsync: memGet, dbAllAsync: memAll,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
});
const I = mod._internals;

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ probe-sys-deadline-normalize 失败: ' + msg); process.exit(1); }

async function main() {
  mod.initSchema();
  await waitReady();
  assert.strictEqual(typeof I.normalizeDateOnlyForToleranceCalc, 'function', '[前置] normalizeDateOnlyForToleranceCalc 应可从 _internals 直调（非复刻）');

  // ══════════════════════════ ① 真实库扫描 ══════════════════════════
  const REAL_DB_FILE = path.join(__dirname, '..', 'task_pool.db');
  console.log(`=== sys_issues.deadline 全库归一探针 ===`);
  console.log(`REAL_DB_FILE: ${REAL_DB_FILE}\n`);
  const realDb = new sqlite3.Database(REAL_DB_FILE, sqlite3.OPEN_READONLY);
  const realAll = (sql, params = []) => new Promise((res, rej) => realDb.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

  let rows;
  try {
    rows = await realAll(`SELECT id, deadline FROM sys_issues WHERE deadline IS NOT NULL AND TRIM(deadline) != ''`);
  } catch (e) {
    fail(`真实库查询失败（${REAL_DB_FILE} 可能不存在或 sys_issues 表未就绪）：${e && e.message}`);
  }
  const failures = [];
  for (const r of rows) {
    const result = I.normalizeDateOnlyForToleranceCalc(r.deadline);
    if (!result.ok) failures.push({ id: r.id, deadline: r.deadline });
  }
  assert.deepStrictEqual(failures, [], `[①真实库] 应零归一失败，实得 ${JSON.stringify(failures)}（存量脏数据，需先人工修复再上线）`);
  ok(`[①真实库] 扫描 ${rows.length} 行非空 deadline，归一失败 0 行——存量数据结构性不存在会撞 SYS_DEADLINE_MALFORMED 的脏值`);
  realDb.close();

  // ══════════════════════════ ② 双向证明：人为构造畸形值，证探针真的会抓 ══════════════════════════
  const badInputs = [
    '2026-13-01',        // 月份非法
    '2026-02-30',         // 日期不存在（分量回比对应拒）
    '非日期字符串',        // 完全非日期格式
    '2026-08-14T00:00:00Z',   // 时区后缀（契约拒绝）
    '2026-8-1',            // 非零填充
    '',                     // 空串（本探针①已用 TRIM(deadline)!='' 过滤，此处单独证明函数自身对空串的处理不是意外通过）
  ];
  const shouldFailButPassed = [];
  for (const bad of badInputs) {
    const result = I.normalizeDateOnlyForToleranceCalc(bad);
    if (result.ok) shouldFailButPassed.push(bad);
  }
  assert.deepStrictEqual(shouldFailButPassed, [], `[②双向证明] 构造的畸形值应全部被判失败，实得放行 ${JSON.stringify(shouldFailButPassed)}（探针本身失效，非"库里没有坏数据"）`);
  ok(`[②双向证明] ${badInputs.length} 个人为构造的畸形值全部被 normalizeDateOnlyForToleranceCalc 正确判为归一失败——探针确有检出能力，①的"零失败"不是 regex 恒真的假阳性`);

  // 正例对照：合法值应放行（三形态：纯日期/带时分/带秒，同函数契约文档三形态）。
  const goodInputs = ['2026-08-14', '2026-08-14 09:00', '2026-08-14 09:00:00', '  2026-08-14  '];
  const shouldPassButFailed = [];
  for (const good of goodInputs) {
    const result = I.normalizeDateOnlyForToleranceCalc(good);
    if (!result.ok) shouldPassButFailed.push(good);
  }
  assert.deepStrictEqual(shouldPassButFailed, [], `[②-对照] 合法值应全部放行，实得误拒 ${JSON.stringify(shouldPassButFailed)}`);
  ok('[②-对照] 合法三形态（纯日期/带时分/带秒，含前导尾随空白）全部正确放行——②的"畸形值判失败"不是矫枉过正的恒拒');

  console.log(`\n[全部通过] ${passed}/${passed} ✓ sys_issues.deadline 全库归一探针通过`);
  console.log('  ①：真实 task_pool.db 全量非空 deadline 归一零失败（存量数据面证据）');
  console.log('  ②：人为构造畸形值 100% 被检出 + 合法值 100% 放行（双向证明探针本身有效，非 regex 恒真/恒假两种自欺之一）');
}

main().catch((e) => { fail(e && e.stack || e); });
