// scripts/verify-sys-eta-overrun-snapshot.js — 系统迭代·组 C「期望对表与准时统计」SC1 阶段验收
//   SSOT = docs/local/系统迭代/预计完成时间与先行上线_方案_20260812_v1.3.md §3C.2/§3C.3/§3C.4/§3C.5
//   用法：node scripts/verify-sys-eta-overrun-snapshot.js
//
// 覆盖（每组均含正反双向，"实现坏成什么样这条会红"写在各断言注释里）：
//   [U] 纯函数单元测试——normalizeDateOnlyForToleranceCalc/computeEtaDeadlineGapDays/evaluateEtaOverrun/
//       validateEtaOverrunReasonInput 四件直调：日期归一非法输入（前导空白/Tab/秒级/ISO 'T'/2026-02-31/
//       非零填充月日）+ 容差边界（严格大于，第 5/7 天不算超）+ bug/config 不参与 + deadline 空不参与 +
//       理由三态缺一即拒。
//   [A] intake_accept 四写分支（§3C.3 矩阵）：人工设定（超→拦/边界放行）/ 自动生成（C11 跳过，纵有巨大
//       缺口也不要求理由，首诺仍写）/ 超时受理必填（超→拦）/ 过期重填必填（超→拦）。
//   [B] /assign、/reassign：超时指派必填 + 现值 NULL 时人工设定——两分支均适用容差；未过期现值分支
//       （不触发写入）不参与。
//   [C] /estimate、/feasibility：容差校验 + 首诺快照 + bug 类型不参与（/estimate 可达 bug）。
//   [D] 理由生命周期：与 ETA 同事务写入/清空——return/liaison_test_return/reopen 清空两列；容差内改写
//       同样清空（此前已超容差写过理由的单，改填一个容差内的新 ETA 应清空理由，不遗留旧理由挂在新值上）。
//   [E] 首诺快照（dev_estimated_first_at）跨轮锁死——五个写点任一次首写生效，同一单再次写不同 ETA 不变；
//       return/reopen 打回不清（新一轮再次写入仍不变）。
//   [F] release 快照（dev_estimated_at_on_release）三写点全覆盖：C9 免上线直翻 accept / 快车道直上 submit /
//       批次发布 —— released_at 落库同事务快照 = 当时 dev_estimated_at；reopen 后该列历史值不被清空
//       （可回溯），主表 dev_estimated_at 则被清空（两者语义分裂，唯一价值正在于此）。
//   [G] 通知 markdown/发送函数直调（isAutoNotifyEnabled 总闸恒 false，dispatchSysNotify 走不到发送，
//       故直调 buildSysEtaOverrunReasonMarkdown / sendSysEtaOverrunReasonNotify 验证内容与落库，与既有
//       verify-sys-notify 对其余 marker 的验证手法同源）。
//   [H] §3C.7 通知触发谓词补充（SC2·三条·B3 后 H2 已翻转为新行为）：重复保存同一理由不重复通知
//       （命中 unchanged no-op 快捷路径）/ 同理由但 ETA 换另一超容差日期**现会通知**（P10 已裁：
//       超容差∧(理由变化∨ETA 值变化)）/ 改回容差内清理由且不通知——借道 /estimate 直调
//       resolveEtaOverrunReasonForWrite + isEtaValueChangedForNotify 预演 + 真实端点落库结果交叉验证。
//   [S] schema/KEY_COLS 静态守卫：PRAGMA 4 新列存在 + SYS_ISSUES_KEY_COLS 含四列锚点。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-eta-overrun-snapshot-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
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

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);
const dev6Tok = jwt.sign({ id: 6, username: 'dev6', display_name: '开发李', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: p, method, headers: {
        'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (r) => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
function fail(msg) { console.error('\n❌ verify-sys-eta-overrun-snapshot 失败: ' + msg); process.exit(1); }

// ── 通用时间 helper（同既有 verify-sys-* 惯例：日期炸弹教训，动态生成不硬编码未来/过去字面量）────────
const pad2 = (n) => String(n).padStart(2, '0');
function fmtDateOnly(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
function fmtDateTimeNoSec(dt) { return `${fmtDateOnly(dt)} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }
function addDays(dt, d) { const c = new Date(dt.getTime()); c.setDate(c.getDate() + d); return c; }
// 锚点：距今 60 天的固定 10:00（留足未来窗口，deadline/ETA 均相对本锚点推导，互不依赖系统当前时刻的日历位置）。
const ANCHOR = (() => { const d = new Date(); d.setDate(d.getDate() + 60); d.setHours(10, 0, 0, 0); return d; })();
function deadlineAt(offsetDays) { return fmtDateOnly(addDays(ANCHOR, offsetDays)); }         // 纯日期（deadline 常见形态）
function etaAt(offsetDays) { return fmtDateTimeNoSec(addDays(ANCHOR, offsetDays)); }          // 带时分（ETA 必填形态）

let seq = 0;
async function mkIssue(type, overrides = {}) {
  seq++;
  const isChange = type === 'feature' || type === 'improvement';
  const r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type, title: `SC1-探针-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'verify-sys-eta-overrun-snapshot 夹具', intake_liaison_id: 13,
    ...(isChange ? { needs_feasibility: 0 } : {}),
    ...overrides,
  });
  assert.strictEqual(r.status, 201, `建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}
function issueRow(id) {
  return get(`SELECT id, type, status, deadline, dev_estimated_at, eta_overrun_reason_code, eta_overrun_reason_note,
                     dev_estimated_first_at, dev_estimated_at_on_release, released_at, reopen_count, return_count,
                     first_submitted_at
                FROM sys_issues WHERE id=?`, [id]);
}
function latestTimeline(id) {
  return get(`SELECT summary, event_type, action_code FROM sys_issue_timeline WHERE issue_id=? ORDER BY id DESC LIMIT 1`, [id]);
}
// [追加批·2026-08-13·codex 370-MED-2 采纳] 行数+最新 id 快照——latestTimeline 只比对"最新一行的 summary
//   文案"，若实现误插一条内容相同的重复留痕（双写）或该插的没插（no-op 场景被误判成真写），单看
//   summary 字符串仍会绿（新插入的重复行与旧行文案逐字相同时尤其如此）。本函数与 latestTimeline 成对
//   使用：c=该 issue 的 timeline 总行数，mid=当前最大 id（MAX(id) 对空表返回 null，故写点前 c 恒>=1
//   时 mid 不会是 null——本文件夹具在任一写点探测前均已有 created/受理等前置行，不存在空表场景）。
//   用法：写入前后各拍一次，real write 断言 `after.c === before.c + 1`（防止 0 或 2 行两种畸变）；
//   no-op 断言 `after.c === before.c && after.mid === before.mid`（防"内容相同的重复插入"这一遗漏面，
//   比单比 summary 字符串更强——重复插入的新行 id 必然更大，即便文案完全相同也会被 mid 差异揪出来）。
function timelineSnapshot(id) {
  return get(`SELECT COUNT(*) AS c, MAX(id) AS mid FROM sys_issue_timeline WHERE issue_id=?`, [id]);
}

// bug → 处理中（受理 + 指派 dev5），不涉及 OA/feasibility，最省心的通用夹具。
async function bugToProcessing(overrides = {}) {
  const id = await mkIssue('bug', overrides);
  let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `[夹具-bug 受理] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-bug 指派] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
// improvement/feature → 开发中（受理 risk_level + 补 OA + 指派 dev5），nf=0 走 /estimate。
let oaSeq = 0;
async function changeToDev(type, overrides = {}) {
  oaSeq++;
  const id = await mkIssue(type, overrides);
  let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `[夹具-${type} 受理] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026080000 + oaSeq) });
  assert.strictEqual(r.status, 200, `[夹具-${type} 补 OA] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具-${type} 指派] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES
    (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),
    (6,'dev6','开发李','user','active'),(13,'wangtaotao','示例对接人','user','active')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / 受理人13 / dev5,6）');

  // ══════════════════════════ [S] schema/KEY_COLS 静态守卫 ══════════════════════════
  {
    const cols = await all(`PRAGMA table_info(sys_issues)`);
    const names = cols.map(c => c.name);
    for (const c of ['eta_overrun_reason_code', 'eta_overrun_reason_note', 'dev_estimated_first_at', 'dev_estimated_at_on_release']) {
      assert.ok(names.includes(c), `[S] sys_issues 应含新列 ${c}`);
    }
    ok('[S] 4 新列（eta_overrun_reason_code/_note/dev_estimated_first_at/dev_estimated_at_on_release）已通过 alterAddMissingCols 落库');
    for (const c of ['eta_overrun_reason_code', 'eta_overrun_reason_note', 'dev_estimated_first_at', 'dev_estimated_at_on_release']) {
      assert.ok(I.SYS_ISSUES_KEY_COLS.includes(c), `[S] SYS_ISSUES_KEY_COLS 应含 ${c}（mid-migration 崩溃防护锚点）`);
    }
    ok('[S] SYS_ISSUES_KEY_COLS 已含 4 新列锚点');
  }

  // ══════════════════════════ [U] 纯函数单元测试 ══════════════════════════
  {
    for (const fn of ['normalizeDateOnlyForToleranceCalc', 'computeEtaDeadlineGapDays', 'evaluateEtaOverrun',
      'validateEtaOverrunReasonInput', 'resolveEtaOverrunReasonForWrite', 'writeDevEstimatedFirstSnapshot']) {
      assert.strictEqual(typeof I[fn], 'function', `[U 前置] ${fn} 应已导出`);
    }
    ok('[U 前置] 六个核心函数均已从 _internals 导出（RC-L2：verify 直调真实逻辑，非复刻）');

    // ── 日期归一非法输入用例（方案 §3C.3 验证清单点名的六类）──
    const badInputs = [
      ['前导空白', '  2026-03-01'],
      ['Tab', '\t2026-03-01'],
      ['非零填充月日（单位数月份）', '2026-3-01'],
      ['ISO 秒级+Z 时区后缀', '2026-03-01T10:00:00Z'],
      ['真实无效日期（2026-02-31）', '2026-02-31'],
      ['真实无效日期（2026-13-01）', '2026-13-01'],
    ];
    // 前导空白/Tab 经 String.trim() 后应合法（trim 后剩余是 '2026-03-01'，纯 JS trim 天然去 Tab，不是
    //   SQLite trim() 那个"只去空格"的坑——本函数是纯 JS 层，见函数头注释）。
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('  2026-03-01').ok, true, '[U-1] 前导空白应被 trim 后正常归一（JS trim 非 SQLite trim，Tab/空格均去除）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('\t2026-03-01\t').ok, true, '[U-2] Tab 应被 trim 后正常归一');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-03-01 10:30:45').ok, true, '[U-3] 秒级形态应被接受（正则显式允许可选 :SS）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-03-01T10:30').ok, true, '[U-4] ISO T 分隔应被接受（正则 [ T] 二选一）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-3-01').ok, false, '[U-5] 非零填充月份应被拒（正则要求两位数字，不宽松匹配）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-02-31').ok, false, '[U-6] 2026-02-31 真实无效日期应被拒（构造后回比对拦截，非裸 date() 回绕）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-13-01').ok, false, '[U-7] 2026-13-01 月份非法应被拒');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('2026-03-01T10:00:00Z').ok, false, '[U-8] 带时区后缀的 ISO 字符串应被拒（正则不认 Z/±HH:MM 后缀，非本函数声明的三形态之一）');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc(null).ok, false, '[U-9] null 应拒');
    assert.strictEqual(I.normalizeDateOnlyForToleranceCalc('').ok, false, '[U-10] 空串应拒');
    ok('[U-1..10] 日期归一契约：合法三形态（纯日期/带分/带秒，含前导空白/Tab/ISO T 分隔）通过，非法值（非零填充/真实无效日期×2/时区后缀/null/空串）全部拒绝');

    // ── 整日差计算：deadline 缺失/畸形 → null（不参与，不阻断）──
    assert.strictEqual(I.computeEtaDeadlineGapDays('2026-03-10', null), null, '[U-11] deadline 为 null → 不可计算');
    assert.strictEqual(I.computeEtaDeadlineGapDays('2026-03-10', ''), null, '[U-12] deadline 为空串 → 不可计算');
    assert.strictEqual(I.computeEtaDeadlineGapDays('2026-03-10', '2026-02-31'), null, '[U-13] deadline 畸形（真实无效日期）→ 不可计算，不阻断（防御性降级，非响亮拒绝——deadline 已经过 normalizeDeadlineDT 校验才能入库，此分支理论不可达）');
    assert.strictEqual(I.computeEtaDeadlineGapDays('2026-03-10', '2026-03-05'), 5, '[U-14] 整日差=5（2026-03-10 减 2026-03-05）');
    assert.strictEqual(I.computeEtaDeadlineGapDays('2026-03-10 23:59', '2026-03-05 00:01'), 5, '[U-15] 整日差只取日期分量，忽略时分（业务口径=自然日）');
    ok('[U-11..15] 整日差计算：deadline 缺失/畸形返回 null 不阻断；正常两值按日期分量相减');

    // ── 容差边界（严格大于，正好第 5/7 天不算超）──
    let e = I.evaluateEtaOverrun('improvement', '2026-03-10', '2026-03-05');   // 整日差=5，容差=5
    assert.deepStrictEqual([e.applicable, e.overrun, e.gapDays], [true, false, 5], '[U-16] improvement 整日差恰好=5（容差本身）→ 不算超，边界放行');
    e = I.evaluateEtaOverrun('improvement', '2026-03-11', '2026-03-05');   // 整日差=6
    assert.deepStrictEqual([e.applicable, e.overrun, e.gapDays], [true, true, 6], '[U-17] improvement 整日差=6（容差+1）→ 超');
    e = I.evaluateEtaOverrun('feature', '2026-03-12', '2026-03-05');   // 整日差=7，容差=7
    assert.deepStrictEqual([e.applicable, e.overrun, e.gapDays], [true, false, 7], '[U-18] feature 整日差恰好=7（容差本身）→ 不算超，边界放行');
    e = I.evaluateEtaOverrun('feature', '2026-03-13', '2026-03-05');   // 整日差=8
    assert.deepStrictEqual([e.applicable, e.overrun, e.gapDays], [true, true, 8], '[U-19] feature 整日差=8（容差+1）→ 超');
    ok('[U-16..19] 容差边界双向成对：improvement 5 天/feature 7 天，严格大于才算超（第 5/7 天本身放行）');

    // ── bug/config 不参与；deadline 空不参与；C11 skipToleranceCheck 不参与 ──
    e = I.evaluateEtaOverrun('bug', '2026-06-01', '2026-01-01');   // 巨大缺口
    assert.deepStrictEqual([e.applicable, e.overrun], [false, false], '[U-20] bug 类型不参与容差判定（不入 ETA_OVERRUN_TOLERANCE_DAYS 表），纵有巨大缺口也不算超');
    e = I.evaluateEtaOverrun('config', '2026-06-01', '2026-01-01');
    assert.deepStrictEqual([e.applicable, e.overrun], [false, false], '[U-21] config 类型同样不参与');
    e = I.evaluateEtaOverrun('improvement', '2026-06-01', null);
    assert.deepStrictEqual([e.applicable, e.overrun], [false, false], '[U-22] deadline 未填（C2 选填语义）→ 不参与，不阻断');
    e = I.evaluateEtaOverrun('improvement', '2026-06-01', '2026-01-01', { skipToleranceCheck: true });
    assert.deepStrictEqual([e.applicable, e.overrun], [false, false], '[U-23] skipToleranceCheck=true（C11 自动生成路径）→ 即便巨大缺口也不参与');
    ok('[U-20..23] 三类"不参与"情形（bug/config 类型·deadline 未填·C11 跳过）均不触发容差判定');

    // ── 理由校验三态缺一即拒 ──
    let v = I.validateEtaOverrunReasonInput({});
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_CODE_REQUIRED'], '[U-24] 两项皆缺 → 拒（先报 code 缺失）');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_code: '需求变更' });
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_NOTE_REQUIRED'], '[U-25] 仅有 code 无 note → 拒');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_note: '说明文字' });
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_CODE_REQUIRED'], '[U-26] 仅有 note 无 code → 拒');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_code: '不存在的标签', eta_overrun_reason_note: 'x' });
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_CODE_REQUIRED'], '[U-27] code 不在五值域内 → 拒（值域=需求变更/技术难度超预期/依赖阻塞/资源冲突/其他）');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_code: '技术难度超预期', eta_overrun_reason_note: '  ' });
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_NOTE_REQUIRED'], '[U-28] note 纯空白视同未填 → 拒（trim 后判空）');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_code: '依赖阻塞', eta_overrun_reason_note: 'x'.repeat(301) });
    assert.deepStrictEqual([v.ok, v.code], [false, 'ETA_OVERRUN_REASON_NOTE_TOO_LONG'], '[U-29] note 超 300 字 → 拒');
    v = I.validateEtaOverrunReasonInput({ eta_overrun_reason_code: '资源冲突', eta_overrun_reason_note: '正常说明' });
    assert.deepStrictEqual([v.ok, v.code, v.note], [true, '资源冲突', '正常说明'], '[U-30] 两项齐全且合法 → 放行');
    ok('[U-24..30] 理由两件缺一即拒（code 缺/note 缺/code 非法值/note 纯空白/note 超长 五种负例）+ 合法正例放行');

    // ── resolveEtaOverrunReasonForWrite：容差内清空理由（即便 body 携带了理由值也不采纳）──
    const notOverrun = I.resolveEtaOverrunReasonForWrite({
      type: 'improvement', etaValue: '2026-03-10', deadlineRaw: '2026-03-05',
      body: { eta_overrun_reason_code: '其他', eta_overrun_reason_note: '不该被采纳' }, skipToleranceCheck: false,
    });
    assert.deepStrictEqual([notOverrun.overrun, notOverrun.reasonCode, notOverrun.reasonNote], [false, null, null],
      '[U-31] 容差内（恰好=5 天）→ 即便 body 携带理由值，reasonCode/reasonNote 仍强制为 null（C7"期望保留、理由作废"由此天然实现，不是"忘了清"）');
    assert.throws(() => I.resolveEtaOverrunReasonForWrite({
      type: 'improvement', etaValue: '2026-03-11', deadlineRaw: '2026-03-05', body: {}, skipToleranceCheck: false,
    }), /SysTransitionError/, '[U-32] 超容差且 body 无理由 → 抛 SysTransitionError（400）');
    ok('[U-31..32] resolveEtaOverrunReasonForWrite：容差内强制清空理由（不采纳误传值）+ 超容差缺理由抛错');
  }

  // ══════════════════════════ [A] intake_accept 四写分支（§3C.3 矩阵）══════════════════════════
  {
    // [A1] 人工设定（为空×SLA未超×inputProvided）：改造为 improvement 型，容差=5。
    //   构造：deadline = ANCHOR - 6 天（提前 6 天）；用户当场手填 ETA = ANCHOR（gap=6，超容差 5）。
    let id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-6) });
    // [追加批·370-MED-2] 建单前置快照——建单本身即写一条 event_type='created' 行，故基线非 0，改用
    //   相对 delta（不猜绝对值，只证明"这一步有没有让行数变化"，更稳）。
    const tlBaseA1 = await timelineSnapshot(id);
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {
      risk_level: '二级', dev_estimated_at: etaAt(0),
    });
    assert.strictEqual(r.status, 400, `[A1-负例] 人工设定超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[A1-负例] 确切码，实得 ${r.body.code}`);
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, null, '[A1-负例] 零写入——理由缺失时整个 intake_accept 应回滚，dev_estimated_at 仍为 NULL');
    // [追加批·370-MED-2] 负例已回滚（上方 dev_estimated_at 仍 NULL 已证），零写入延伸到 timeline 一并核对：
    //   400 分支应连一行都没插（非"插了但没人看"）——与建单后基线比较，行数/最新 id 均不变。
    const tlBeforeA1Neg = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeA1Neg.c, tlBaseA1.c, `[A1-负例·计数] 400 回滚应零写入，实得 ${tlBaseA1.c} → ${tlBeforeA1Neg.c}`);
    assert.strictEqual(tlBeforeA1Neg.mid, tlBaseA1.mid, '[A1-负例·计数] 400 回滚不应产生新的最新记录 id');
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {
      risk_level: '二级', dev_estimated_at: etaAt(0),
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: '业务方临时改需求',
    });
    assert.strictEqual(r.status, 200, `[A1-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.ok(row.dev_estimated_at, '[A1-正例] dev_estimated_at 已写');
    assert.strictEqual(row.eta_overrun_reason_code, '需求变更', '[A1-正例] 理由码已落库');
    assert.strictEqual(row.eta_overrun_reason_note, '业务方临时改需求', '[A1-正例] 理由说明已落库');
    assert.strictEqual(row.dev_estimated_first_at, row.dev_estimated_at, '[A1-正例] 首诺快照=首次写入的 ETA 值');
    // [修复 a] timeline 携带理由——gap=6（deadlineAt(-6) 到 etaAt(0)），容差=5，超 1 天。
    const tlA1 = await latestTimeline(id);
    assert.ok(tlA1.summary.includes('（超出期望 6 天）——需求变更：业务方临时改需求'),
      `[A1-正例·修复 a] intake_accept「人工设定」timeline summary 应携带超期天数+理由标签+说明，实得="${tlA1.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写：若实现误插两条同文案行，单看 summary 不会发觉）。
    const tlAfterA1 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterA1.c, tlBeforeA1Neg.c + 1, `[A1-正例·计数] intake_accept 成功后 timeline 应恰新增 1 行，实得 ${tlBeforeA1Neg.c} → ${tlAfterA1.c}`);
    ok('[A1] intake_accept「受理弹窗人工设定」：超容差缺理由 400+零写入；带理由 200+理由落库+首诺快照写入+timeline 携带理由+恰新增 1 行');

    // [A1b] 边界放行：新单，gap 恰好=5（容差本身），不要求理由。
    id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-5) });
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级', dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, `[A1b] 边界（gap=5）应放行 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[A1b] 边界放行时理由列为 NULL（未被要求也未被误写）');
    ok('[A1b] intake_accept 人工设定边界：gap 恰好=容差（5 天）→ 不要求理由，正例放行');

    // [A2] 自动生成（C11）：留空 → 系统按创建锚计算默认 SLA。deadline 设成很早（保证自动生成值必超容差），
    //   断言即便超容差也不要求理由（body 不带 eta_overrun_reason_*），首诺仍写。
    id = await mkIssue('improvement', { needs_feasibility: 0, deadline: '2020-01-01' });
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });   // 不填 dev_estimated_at
    assert.strictEqual(r.status, 200, `[A2] 自动生成应 200（C11 不要求理由），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.eta && r.body.eta.auto_generated, true, '[A2] 响应体标记 auto_generated=true');
    row = await issueRow(id);
    assert.ok(row.dev_estimated_at, '[A2] 自动生成的 ETA 已写');
    assert.strictEqual(row.eta_overrun_reason_code, null, '[A2] ⭐ C11：即便 deadline=2020-01-01（缺口巨大）也不要求/不写理由——系统动作无可归责的人');
    assert.strictEqual(row.dev_estimated_first_at, row.dev_estimated_at, '[A2] ⭐ 首诺快照仍写——容差跳过与首诺快照是两件独立的事，C11 只跳过前者');
    ok('[A2] intake_accept「受理自动生成」（C11）：跳过容差校验（纵有巨大缺口也不要求理由）+ 首诺快照仍正常写入');

    // [A3] 超时受理必填：为空 × SLA 已超 → 弹窗必填。用创建时间伪造成很早（触发 SLA 已超），
    //   受理时必须填新值；若超容差还须带理由。
    id = await mkIssue('bug');   // bug 建单后先不受理，直接改 created_at 伪造超时
    await run(`UPDATE sys_issues SET created_at = '2020-01-01 08:00:00' WHERE id=?`, [id]);
    // bug 不参与容差（用 bug 验证"必填但不要求理由"这一半）；用另一张 improvement 单验证"必填且超容差要理由"。
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
    assert.strictEqual(r.status, 400, `[A3-必填负例] bug 超时受理不填应 400，实得 ${r.status}`);
    assert.strictEqual(r.body.code, 'INTAKE_ESTIMATE_REQUIRED', `[A3-必填负例] 确切码，实得 ${r.body.code}`);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, `[A3-bug 正例] bug 填值应 200（不要求理由），实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[A3-bug 正例] bug 类型不参与容差，理由列 NULL');
    assert.strictEqual(row.dev_estimated_first_at, row.dev_estimated_at, '[A3-bug 正例] 首诺快照已写');

    id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-6) });
    // [追加批·370-MED-2] 建单后基线（含 created 行），后续两次 400 应不改变它——相对 delta，不猜绝对值。
    const tlBaseA3 = await timelineSnapshot(id);
    await run(`UPDATE sys_issues SET created_at = '2020-01-01 08:00:00' WHERE id=?`, [id]);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级', dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 400, `[A3-超容差负例] 超时受理+超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[A3-超容差负例] 确切码，实得 ${r.body.code}`);
    const tlBeforeA3 = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeA3.c, tlBaseA3.c, `[A3-超容差正例·计数前置] 两次 400 负例均应零写入，实得 ${tlBaseA3.c} → ${tlBeforeA3.c}`);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {
      risk_level: '二级', dev_estimated_at: etaAt(0),
      eta_overrun_reason_code: '技术难度超预期', eta_overrun_reason_note: '排期紧张',
    });
    assert.strictEqual(r.status, 200, `[A3-超容差正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '技术难度超预期', '[A3-超容差正例] 理由已落库');
    // [修复 a] timeline 携带理由——同 A1 一带 gap=6（deadlineAt(-6) 到 etaAt(0)）。
    const tlA3 = await latestTimeline(id);
    assert.ok(tlA3.summary.includes('（超出期望 6 天）——技术难度超预期：排期紧张'),
      `[A3-超容差正例·修复 a] intake_accept「超时受理必填」timeline summary 应携带理由，实得="${tlA3.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）。
    const tlAfterA3 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterA3.c, tlBeforeA3.c + 1, `[A3-超容差正例·计数] 应恰新增 1 行，实得 ${tlBeforeA3.c} → ${tlAfterA3.c}`);
    ok('[A3] intake_accept「超时受理必填」：不填 400 必填闸；bug 类型填值后理由 NULL（不参与）；improvement 超容差缺理由 400、带理由 200 落库+timeline 携带理由+恰新增 1 行');

    // [A4] 过期重填必填：非空 × 已过期 → 弹窗必填新值。
    //   ⚠️ 夹具说明：矩阵这一格要求"仍在待受理态、但 dev_estimated_at 已非空且过期"——intake_return 的
    //   from 严格限定「待受理」（transitions.js 逐字：待受理→待修改），而 ETA 唯一写点是 intake_accept
    //   本身（受理成功后单已离开待受理），故"待受理 + 非空 ETA"这一组合在纯 HTTP 链路里只能经
    //   issue_reject（待处理→已拒绝，bug 双 from 之一）→ reactivate（已拒绝→待受理，且不清 ETA）绕行，
    //   与本组"验证 intake_accept 这一格分支自身的容差/理由逻辑"这个目标无关，绕行本身不增加信度反而
    //   引入 issue_reject/reactivate 两条无关链路的耦合。改用直接 DB 置态（同 verify-sys-eta-generation.js
    //   [M7] 一带"DB 置过期模拟拖延"同款既有手法）——只摆事实（待受理 + 非空且过期的 ETA），不模拟"如何
    //   走到这个事实"，专注验证本格分支代码本身。
    id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-6) });
    // [追加批·370-MED-2] 建单后基线（含 created 行）；DB 摆态直写不经 API，不产生新 timeline 行。
    const tlBaseA4 = await timelineSnapshot(id);
    await run(`UPDATE sys_issues SET dev_estimated_at = '2020-01-01 10:00:00' WHERE id=?`, [id]);   // 摆态：待受理 + 已过期 ETA
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });   // 不填新值
    assert.strictEqual(r.status, 400, `[A4-必填负例] 过期不填新值应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INTAKE_ESTIMATE_REQUIRED', `[A4-必填负例] 确切码，实得 ${r.body.code}`);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级', dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 400, `[A4-超容差负例] 过期重填+超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[A4-超容差负例] 确切码，实得 ${r.body.code}`);
    const tlBeforeA4 = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeA4.c, tlBaseA4.c, `[A4-正例·计数前置] DB 摆态+两次 400 负例均应零写入，实得 ${tlBaseA4.c} → ${tlBeforeA4.c}`);
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {
      risk_level: '二级', dev_estimated_at: etaAt(0),
      eta_overrun_reason_code: '依赖阻塞', eta_overrun_reason_note: '等待上游接口',
    });
    assert.strictEqual(r.status, 200, `[A4-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '依赖阻塞', '[A4-正例] 理由已落库');
    // dev_estimated_first_at 在本单从未被真正写点（本次 intake_accept 是第一次）触碰过——DB 摆态的
    // '2020-01-01 10:00:00' 只写了 dev_estimated_at 一列，first_at 仍是 NULL，故双条件守卫本次会真写。
    assert.strictEqual(row.dev_estimated_first_at, row.dev_estimated_at, '[A4-正例] 首诺快照=本次真正写入的新值（direct DB 摆态只动了 dev_estimated_at，first_at 此前仍 NULL，本次是真正的首次写点）');
    // [修复 a] timeline 携带理由——同 A1/A3 一带 gap=6（deadlineAt(-6) 到 etaAt(0)）。
    const tlA4 = await latestTimeline(id);
    assert.ok(tlA4.summary.includes('（超出期望 6 天）——依赖阻塞：等待上游接口'),
      `[A4-正例·修复 a] intake_accept「过期重填必填」timeline summary 应携带理由，实得="${tlA4.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）。
    const tlAfterA4 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterA4.c, tlBeforeA4.c + 1, `[A4-正例·计数] 应恰新增 1 行，实得 ${tlBeforeA4.c} → ${tlAfterA4.c}`);
    ok('[A4] intake_accept「过期重填必填」：不填 400 必填闸；超容差缺理由 400；带理由 200 落库+首诺快照写入+timeline 携带理由+恰新增 1 行');
  }

  // ══════════════════════════ [B] /assign、/reassign 容差校验 ══════════════════════════
  {
    // [B1] /assign 超时指派必填：improvement 走 changeToDev 到「待指派」前一步——手工模拟"已有 ETA 但已过期"。
    //   changeToDev 内部会经过 intake-accept（此时也会写一次 ETA/首诺），assign 是"第二次"写点，
    //   用于验证 assign 自己的容差校验独立生效。
    let id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-6) });
    let r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级', dev_estimated_at: etaAt(-1) });
    assert.strictEqual(r.status, 200, `[B1-前置] 受理成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026090000 + (++oaSeq)) });
    assert.strictEqual(r.status, 200, '[B1-前置] 补 OA 成功');
    const firstSnap = (await issueRow(id)).dev_estimated_first_at;
    assert.ok(firstSnap, '[B1-前置] 首诺快照已在受理阶段写入');
    await run(`UPDATE sys_issues SET dev_estimated_at = '2020-01-01 10:00:00' WHERE id=?`, [id]);   // 模拟已过期
    // [追加批·370-MED-2] 两次 400 负例前的基线（B1-前置 intake-accept 已写入的行数，具体多少不猜，只比相对量）。
    const tlBaseB1 = await timelineSnapshot(id);
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 400, `[B1-必填负例] 已过期不带新值应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ASSIGN_ESTIMATE_REQUIRED', `[B1-必填负例] 确切码，实得 ${r.body.code}`);
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5, dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 400, `[B1-超容差负例] 超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[B1-超容差负例] 确切码，实得 ${r.body.code}`);
    let row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, '2020-01-01 10:00:00', '[B1-超容差负例] 零写入——理由缺失时整个 assign 应回滚，ETA 仍是探针塞入的旧值');
    const tlBeforeB1 = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeB1.c, tlBaseB1.c, `[B1-正例·计数前置] 两次 400 负例均应零写入，实得 ${tlBaseB1.c} → ${tlBeforeB1.c}`);
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, {
      assigned_to: 5, dev_estimated_at: etaAt(0),
      eta_overrun_reason_code: '资源冲突', eta_overrun_reason_note: '开发资源被占用',
    });
    assert.strictEqual(r.status, 200, `[B1-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '资源冲突', '[B1-正例] 理由已落库');
    assert.strictEqual(row.dev_estimated_first_at, firstSnap, '[B1-正例] ⭐ 首诺快照跨轮锁死——assign 是受理之后第二次写 ETA，首诺仍锁在受理阶段那次的值，未被 assign 这次覆盖');
    // [修复 a] timeline 携带理由——gap=6（deadlineAt(-6) 到 etaAt(0)），本次是"超时指派"分支。
    const tlB1 = await latestTimeline(id);
    assert.ok(tlB1.summary.includes('（超出期望 6 天）——资源冲突：开发资源被占用'),
      `[B1-正例·修复 a] /assign「超时指派」timeline summary 应携带理由，实得="${tlB1.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）。
    const tlAfterB1 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterB1.c, tlBeforeB1.c + 1, `[B1-正例·计数] 应恰新增 1 行，实得 ${tlBeforeB1.c} → ${tlAfterB1.c}`);
    ok('[B1] /assign「超时指派必填」：不带新值 400 必填闸；超容差缺理由 400+零写入；带理由 200 落库 + 首诺快照维持受理阶段锁定值 + timeline 携带理由+恰新增 1 行');

    // [B2] /reassign 同款——用 bug（D_PRE 可达 reassign）验证"不参与容差"一侧，用 improvement 验证"超容差"一侧。
    id = await bugToProcessing();   // 已在处理中，dev_estimated_at 尚为 NULL（bug 未经过 intake 自动生成？—— 实际会：intake-accept 内已写一次）
    row = await issueRow(id);
    assert.ok(row.dev_estimated_at, '[B2-前置] bug 受理阶段已自动生成 ETA');
    await run(`UPDATE sys_issues SET dev_estimated_at = '2020-01-01 10:00:00' WHERE id=?`, [id]);
    // [追加批·370-MED-2] 只取相对基线，不猜 bugToProcessing 链路具体写了几行（建单/受理/指派各自写点
    //   数量不是本组重点）。
    const tlBeforeB2bug = await timelineSnapshot(id);
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '改派测试', dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, `[B2-bug 正例] bug 改派填过期后新值应 200（不要求理由），实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[B2-bug 正例] bug 类型理由列 NULL');
    // [修复 a 对照组] bug 不参与容差，本就无理由可携带——timeline summary 不应含理由/清除后缀（此前
    //   理由列也本为 NULL，non-overrun 分支的"真清空"判据天然不触发）。
    const tlB2bug = await latestTimeline(id);
    assert.ok(!tlB2bug.summary.includes('超出期望') && !tlB2bug.summary.includes('已清除'),
      `[B2-bug 正例·修复 a 对照组] bug 类型 reassign timeline summary 不应含理由段，实得="${tlB2bug.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（reassign 真写入了新 ETA，虽无理由段，仍是一次真实写点，防双写）。
    const tlAfterB2bug = await timelineSnapshot(id);
    assert.strictEqual(tlAfterB2bug.c, tlBeforeB2bug.c + 1, `[B2-bug 正例·计数] reassign 应恰新增 1 行，实得 ${tlBeforeB2bug.c} → ${tlAfterB2bug.c}`);

    id = await mkIssue('improvement', { needs_feasibility: 0, deadline: deadlineAt(-6) });
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级', dev_estimated_at: etaAt(-1) });
    assert.strictEqual(r.status, 200, `[B2-前置] 受理成功，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(2026090000 + (++oaSeq)) });
    assert.strictEqual(r.status, 200, '[B2-前置] 补 OA 成功');
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '[B2-前置] 指派成功');
    await run(`UPDATE sys_issues SET dev_estimated_at = '2020-01-01 10:00:00' WHERE id=?`, [id]);
    // [追加批·370-MED-2] 负例前基线——B2-前置链路（intake-accept/set-oa-number/assign）具体写几行不猜，只比相对量。
    const tlBaseB2 = await timelineSnapshot(id);
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5, 6], reason: '加人', dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 400, `[B2-超容差负例] 超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[B2-超容差负例] 确切码，实得 ${r.body.code}`);
    const tlBeforeB2 = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeB2.c, tlBaseB2.c, `[B2-正例·计数前置] 400 负例应零写入，实得 ${tlBaseB2.c} → ${tlBeforeB2.c}`);
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, {
      member_ids: [5, 6], reason: '加人', dev_estimated_at: etaAt(0),
      eta_overrun_reason_code: '其他', eta_overrun_reason_note: '综合原因',
    });
    assert.strictEqual(r.status, 200, `[B2-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '其他', '[B2-正例] 理由已落库');
    // [修复 a] timeline 携带理由——gap=6（deadlineAt(-6) 到 etaAt(0)）。
    const tlB2 = await latestTimeline(id);
    assert.ok(tlB2.summary.includes('（超出期望 6 天）——其他：综合原因'),
      `[B2-正例·修复 a] /reassign timeline summary 应携带理由，实得="${tlB2.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写；400 负例已确认零写入，见 tlBeforeB2）。
    const tlAfterB2 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterB2.c, tlBeforeB2.c + 1, `[B2-正例·计数] 应恰新增 1 行，实得 ${tlBeforeB2.c} → ${tlAfterB2.c}`);
    ok('[B2] /reassign 同款：bug 类型改派不要求理由；improvement 超容差缺理由 400、带理由 200 落库+timeline 携带理由+恰新增 1 行');
  }

  // ══════════════════════════ [C] /estimate、/feasibility 容差校验 + 首诺快照 ══════════════════════════
  {
    // [C1] /estimate：bug 类型不参与容差（纵有巨大缺口）；improvement(nf=0) 超容差要理由。
    let id = await bugToProcessing({ deadline: '2020-01-01' });
    // [追加批·370-MED-2] 相对基线（不猜 bugToProcessing 链路具体写了几行）。
    const tlBeforeC1bug = await timelineSnapshot(id);
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, `[C1-bug] 应 200（bug 不参与容差），实得 ${r.status} ${JSON.stringify(r.body)}`);
    let row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[C1-bug] bug 类型理由列 NULL');
    // [修复 a 对照组] bug 不参与容差、此前也无理由——estimate timeline summary 应是纯裸值（estMin），
    //   不含任何理由/清除后缀（D3 裸值契约不因本次改动而破坏，与 verify-sys-effort-c7/
    //   verify-sys-time-precision 两文件既有的 strictEqual(summary, EST) 断言同一口径）。
    const tlC1bug = await latestTimeline(id);
    assert.strictEqual(tlC1bug.summary, etaAt(0),
      `[C1-bug·修复 a 对照组] bug 类型 estimate timeline summary 应是纯裸值，不含理由段，实得="${tlC1bug.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（真实写点，虽无理由段，仍要防双写）。
    const tlAfterC1bug = await timelineSnapshot(id);
    assert.strictEqual(tlAfterC1bug.c, tlBeforeC1bug.c + 1, `[C1-bug·计数] 应恰新增 1 行，实得 ${tlBeforeC1bug.c} → ${tlAfterC1bug.c}`);

    // ⚠️ changeToDev 内部经 intake-accept（未传 dev_estimated_at）→ C11 自动生成分支已经写过一次
    //   dev_estimated_at + dev_estimated_first_at——本组 /estimate 调用是**第二次**写点，不是首次；
    //   下方断言据此改为"与受理阶段的自动生成值比对"，而非误当"estimate 是首次写"。
    id = await changeToDev('improvement', { deadline: deadlineAt(-6) });
    const preEstimateRow = await issueRow(id);
    assert.ok(preEstimateRow.dev_estimated_at, '[C1-前置] changeToDev 内 intake-accept 自动生成分支已写入 ETA（本单进入 /estimate 时并非空白单）');
    const firstSnapC1 = preEstimateRow.dev_estimated_first_at;
    assert.ok(firstSnapC1, '[C1-前置] 首诺快照已在受理阶段写入（本组验证的正是它此后不再被 /estimate 覆盖）');
    // [追加批·370-MED-2] 负例前基线——changeToDev 链路具体写几行不猜，只比相对量。
    const tlBaseC1 = await timelineSnapshot(id);
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: etaAt(0), estimated_effort_days: 3 });
    assert.strictEqual(r.status, 400, `[C1-超容差负例] 超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[C1-超容差负例] 确切码，实得 ${r.body.code}`);
    row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, preEstimateRow.dev_estimated_at, '[C1-超容差负例] 零写入——理由缺失时整条 UPDATE（含 estimated_effort_days）均应回滚，ETA 仍是受理阶段自动生成的旧值');
    const tlBeforeC1 = await timelineSnapshot(id);
    assert.strictEqual(tlBeforeC1.c, tlBaseC1.c, `[C1-正例·计数前置] 400 负例应零写入，实得 ${tlBaseC1.c} → ${tlBeforeC1.c}`);
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaAt(0), estimated_effort_days: 3,
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: '范围扩大',
    });
    assert.strictEqual(r.status, 200, `[C1-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '需求变更', '[C1-正例] 理由已落库');
    assert.notStrictEqual(row.dev_estimated_at, preEstimateRow.dev_estimated_at, '[C1-正例] ETA 真的被本次 /estimate 改写（非巧合同值）');
    assert.strictEqual(row.dev_estimated_first_at, firstSnapC1, '[C1-正例] ⭐⭐ 首诺快照跨写点锁死——/estimate 是受理阶段之后的第二次写 ETA，首诺仍锁在受理阶段那次自动生成的值，未被本次覆盖（跨越 intake_accept→estimate 两个不同写点的锁死，比同写点重复调用更强的证据）');
    // [修复 a] timeline 携带理由——estimate 的裸值契约（D3）保留：summary = 裸值 + 理由后缀，非重新
    //   拼一整句话。gap=6（deadlineAt(-6) 到 etaAt(0)）。
    const tlC1 = await latestTimeline(id);
    assert.strictEqual(tlC1.summary, etaAt(0) + '（超出期望 6 天）——需求变更：范围扩大',
      `[C1-正例·修复 a] /estimate timeline summary 应是"裸值+理由后缀"，实得="${tlC1.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）。
    const tlAfterC1 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterC1.c, tlBeforeC1.c + 1, `[C1-正例·计数] 应恰新增 1 行，实得 ${tlBeforeC1.c} → ${tlAfterC1.c}`);
    // [C1-跨轮/边界] 边界=容差本身放行；同一单再次写不同值时首诺不变（跨轮锁死的最短复现：不打回，直接
    //   同一状态再提交一次不同值，验证"锁死"不依赖打回这一动作触发，而是纯粹"非首次写=不再更新"）。
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaAt(-1), estimated_effort_days: 3,   // 改小 gap 到容差内（-1 天偏移，gap=5）
    });
    assert.strictEqual(r.status, 200, `[C1-边界改写] 改容差内应 200 不要求理由，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[C1-边界改写] ⭐ 改到容差内后理由两列应被清空（同一条 UPDATE 里理由与 ETA 同生命周期，不因"这次没传就保留旧理由"）');
    assert.strictEqual(row.dev_estimated_first_at, firstSnapC1, '[C1-边界改写] ⭐ 首诺快照仍锁在第一次写入的值，未被本次改写覆盖');
    // [修复 a] timeline 携带清除说明——此前理由列确非空（[C1-正例] 刚写过），本次真清空。
    const tlC1b = await latestTimeline(id);
    assert.strictEqual(tlC1b.summary, etaAt(-1) + '（回到期望容差内，超期原因已清除）',
      `[C1-边界改写·修复 a] 真清空应追加清除说明，实得="${tlC1b.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（清除正例同样防双写）。
    const tlAfterC1b = await timelineSnapshot(id);
    assert.strictEqual(tlAfterC1b.c, tlAfterC1.c + 1, `[C1-边界改写·计数] 应恰新增 1 行，实得 ${tlAfterC1.c} → ${tlAfterC1b.c}`);
    ok('[C1] /estimate：bug 不参与容差；improvement(nf=0) 超容差缺理由 400+零写入、带理由 200 落库；首诺快照首写锁定；改写到容差内清空理由但首诺不变；timeline 携带理由/清除说明+均恰新增 1 行');

    // [C2] /feasibility：feature(nf=1) 超容差要理由；边界放行。
    //   ⚠️ 同 C1 一带：intake-accept 未传 dev_estimated_at 时已走 C11 自动生成分支，本组 /feasibility
    //   调用同样是第二次写点，断言据此与"受理阶段已写值"比对，不假设为首次写。
    let idF = await mkIssue('feature', { needs_feasibility: 1, deadline: deadlineAt(-8) });   // 容差=7，偏移-8 保证超
    r = await call('POST', `/api/sys-issues/${idF}/intake-accept`, adminTok, { risk_level: '三级' });
    assert.strictEqual(r.status, 200, '[C2-前置] 受理成功（feature 默认 nf=1）');
    r = await call('POST', `/api/sys-issues/${idF}/set-oa-number`, adminTok, { oa_number: String(2026090000 + (++oaSeq)) });
    assert.strictEqual(r.status, 200, '[C2-前置] 补 OA 成功');
    r = await call('POST', `/api/sys-issues/${idF}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '[C2-前置] 指派成功');
    const preFeasRow = await issueRow(idF);
    assert.ok(preFeasRow.dev_estimated_at, '[C2-前置] 受理阶段自动生成分支已写入 ETA');
    const firstSnapC2 = preFeasRow.dev_estimated_first_at;
    assert.ok(firstSnapC2, '[C2-前置] 首诺快照已在受理阶段写入');
    // [追加批·370-MED-2] 负例前基线（C2-前置链路具体写几行不猜，只比相对量）。
    const tlBaseC2 = await timelineSnapshot(idF);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: etaAt(0), estimated_effort_days: 5,
    });
    assert.strictEqual(r.status, 400, `[C2-超容差负例] 超容差缺理由应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ETA_OVERRUN_REASON_CODE_REQUIRED', `[C2-超容差负例] 确切码，实得 ${r.body.code}`);
    row = await issueRow(idF);
    assert.strictEqual(row.dev_estimated_at, preFeasRow.dev_estimated_at, '[C2-超容差负例] 零写入——ETA 仍是受理阶段自动生成的旧值');
    const tlBeforeC2 = await timelineSnapshot(idF);
    assert.strictEqual(tlBeforeC2.c, tlBaseC2.c, `[C2-正例·计数前置] 400 负例应零写入，实得 ${tlBaseC2.c} → ${tlBeforeC2.c}`);
    r = await call('POST', `/api/sys-issues/${idF}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: etaAt(0), estimated_effort_days: 5,
      eta_overrun_reason_code: '技术难度超预期', eta_overrun_reason_note: '方案复杂度高于预期',
    });
    assert.strictEqual(r.status, 200, `[C2-正例] 带理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(idF);
    assert.strictEqual(row.eta_overrun_reason_code, '技术难度超预期', '[C2-正例] 理由已落库');
    assert.notStrictEqual(row.dev_estimated_at, preFeasRow.dev_estimated_at, '[C2-正例] ETA 真的被本次 /feasibility 改写');
    assert.strictEqual(row.dev_estimated_first_at, firstSnapC2, '[C2-正例] ⭐⭐ 首诺快照跨写点锁死——/feasibility 是受理阶段之后的第二次写 ETA，首诺仍锁在受理阶段那次自动生成的值');
    // [修复 a] timeline 携带理由——feasibility 的快照文本本就是完整句子，理由后缀追加在其后。gap=8
    //   （deadlineAt(-8) 到 etaAt(0)，容差=7）。
    const tlC2 = await latestTimeline(idF);
    assert.ok(tlC2.summary.includes('（超出期望 8 天）——技术难度超预期：方案复杂度高于预期'),
      `[C2-正例·修复 a] /feasibility timeline summary（快照文本）应携带理由，实得="${tlC2.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）。
    const tlAfterC2 = await timelineSnapshot(idF);
    assert.strictEqual(tlAfterC2.c, tlBeforeC2.c + 1, `[C2-正例·计数] 应恰新增 1 行，实得 ${tlBeforeC2.c} → ${tlAfterC2.c}`);
    // 边界：gap 恰好=7
    let idF2 = await mkIssue('feature', { needs_feasibility: 1, deadline: deadlineAt(-7) });
    r = await call('POST', `/api/sys-issues/${idF2}/intake-accept`, adminTok, { risk_level: '三级' });
    assert.strictEqual(r.status, 200, '[C2b-前置] 受理成功');
    r = await call('POST', `/api/sys-issues/${idF2}/set-oa-number`, adminTok, { oa_number: String(2026090000 + (++oaSeq)) });
    assert.strictEqual(r.status, 200, '[C2b-前置] 补 OA 成功');
    r = await call('POST', `/api/sys-issues/${idF2}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, '[C2b-前置] 指派成功');
    // [追加批·370-MED-2] 相对基线（不猜 C2b-前置链路具体写了几行），供下方"恰新增 1 行"delta 断言用。
    const tlBeforeC2b = await timelineSnapshot(idF2);
    r = await call('POST', `/api/sys-issues/${idF2}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求已确认', dev_estimated_at: etaAt(0), estimated_effort_days: 5,
    });
    assert.strictEqual(r.status, 200, `[C2b-边界] gap 恰好=7 应放行 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    // [修复 a 对照组] 边界放行（gap=7=容差本身）+ idF2 此前从未写过理由——feasibility 快照文本不应
    //   含任何理由/清除后缀（对照组=容差内正常改期 summary 不含理由段）。
    const tlC2b = await latestTimeline(idF2);
    assert.ok(!tlC2b.summary.includes('超出期望') && !tlC2b.summary.includes('已清除'),
      `[C2b-边界·修复 a 对照组] 容差内（边界放行）feasibility timeline summary 不应含理由段，实得="${tlC2b.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（真实写点，虽无理由段，仍要防双写）。
    const tlAfterC2b = await timelineSnapshot(idF2);
    assert.strictEqual(tlAfterC2b.c, tlBeforeC2b.c + 1, `[C2b-边界·计数] 应恰新增 1 行，实得 ${tlBeforeC2b.c} → ${tlAfterC2b.c}`);
    ok('[C2] /feasibility：feature(nf=1) 超容差缺理由 400+零写入、带理由 200 落库+首诺快照写入；gap 恰好=7（容差本身）边界放行；timeline 携带理由/对照组不含理由段+均恰新增 1 行');
  }

  // ══════════════════════════ [D]+[E] 理由生命周期 + 首诺跨轮锁死（打回/重开）══════════════════════════
  {
    // 造一个已写入超容差理由的 improvement 单，走到「开发中」→ return 打回 → 断言：
    //   ① dev_estimated_at 清空 ② 理由两列清空 ③ dev_estimated_first_at 不变（跨轮锁死）
    //   ④ 重新走 estimate 写入新值后 → dev_estimated_first_at 仍是第一轮那个值。
    const id = await changeToDev('improvement', { deadline: deadlineAt(-6) });
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaAt(0), estimated_effort_days: 2,
      eta_overrun_reason_code: '依赖阻塞', eta_overrun_reason_note: '等三方接口',
    });
    assert.strictEqual(r.status, 200, `[D-前置] estimate 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let row = await issueRow(id);
    const firstRoundEta = row.dev_estimated_at;
    const firstSnap = row.dev_estimated_first_at;
    const deadlineBefore = row.deadline;   // normalizeDeadlineDT 落库形态（纯日期补 '00:00:00'），不用裸输入字符串比较
    assert.ok(firstSnap, '[D-前置] 首诺快照已写');
    assert.strictEqual(row.eta_overrun_reason_code, '依赖阻塞', '[D-前置] 理由已落库');

    // 提交 → 待验证 → 验收打回（return）
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
      mode: 'no_code', no_code_reason: 'D 组测试无提交', self_tested: true, test_env_deployed: true,
    });
    assert.strictEqual(r.status, 200, `[D-前置] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', `[D-前置] submit 后应落待验证，实得 ${r.body.main_status}`);
    // [追加批·370-MED-2] return 前拍一次快照——D 组前置链路（intake-accept/estimate/submit）具体写了
    //   几行不是本组重点，故不断言绝对值，只用相对 delta 证明 return 恰新增 1 行（不双写/不漏写）。
    const tlBeforeD1 = await timelineSnapshot(id);
    r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '需要返工' });
    assert.strictEqual(r.status, 200, `[D1] return 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, null, '[D1] return 后 dev_estimated_at 清空');
    assert.strictEqual(row.eta_overrun_reason_code, null, '[D1] ⭐ return 后理由两列同事务清空（C7「期望保留、理由作废」）');
    assert.strictEqual(row.eta_overrun_reason_note, null, '[D1] return 后理由说明同样清空');
    assert.strictEqual(row.dev_estimated_first_at, firstSnap, '[D1] ⭐ 首诺快照跨轮锁死——return 打回不清 dev_estimated_first_at');
    assert.strictEqual(row.deadline, deadlineBefore, '[D1] deadline（期望完成，业务方期望）不受 return 影响——本单是"期望保留"的载体');
    // [修复 a 对照组·用户明确排除] return 打回不追加"已清除"文案——轮次重置语义已由打回留痕本身
    //   （summary=打回原因原文）承载，追加"超期原因已清除"是重复啰嗦的噪音（任务锚点原话）。
    //   此前理由列确非空（[D-前置] 刚写过依赖阻塞），若误套用了"真清空"分支，本断言会抓到（strictEqual
    //   而非 includes，任何多余后缀都会让它红）。
    const tlD1 = await latestTimeline(id);
    assert.strictEqual(tlD1.summary, '需要返工',
      `[D1·修复 a 对照组] return 打回的 timeline summary 应恒等于打回原因本身，不追加清除说明，实得="${tlD1.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行 + 最新 id 确已变化（防"没插"或"插了两条一模一样的"）。
    const tlAfterD1 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterD1.c, tlBeforeD1.c + 1, `[D1·计数] return 应恰新增 1 行，实得 ${tlBeforeD1.c} → ${tlAfterD1.c}`);
    assert.notStrictEqual(tlAfterD1.mid, tlBeforeD1.mid, '[D1·计数] 最新记录 id 应已变化（证明是真插入而非复用旧行）');

    // 第二轮：重新指派（roster 已因 return 保留，直接 estimate 写入不同值）——需先确认在册（return 不动 roster）
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaAt(-30), estimated_effort_days: 2,   // 容差内的新值（无需理由）
    });
    assert.strictEqual(r.status, 200, `[D2] 第二轮 estimate 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.notStrictEqual(row.dev_estimated_at, firstRoundEta, '[D2] 第二轮 ETA 值与第一轮不同（真实验证"重写"而非巧合同值）');
    assert.strictEqual(row.dev_estimated_first_at, firstSnap, '[D2] ⭐⭐ 首诺快照仍锁在第一轮的值——第二轮写入不会覆盖已锁死的首诺（方案 §3C.4 核心不变量）');
    assert.strictEqual(row.eta_overrun_reason_code, null, '[D2] 第二轮容差内写入，理由列仍 NULL');
    // [修复 a 对照组] 容差内正常改期（此前理由列已被 return 清空为 NULL，本次也未超容差）——summary
    //   应恒等于裸值本身，不含任何理由段（正是任务①点名要求的对照组）。
    const tlD2 = await latestTimeline(id);
    assert.strictEqual(tlD2.summary, etaAt(-30),
      `[D2·修复 a 对照组] 容差内正常改期 timeline summary 不含理由段，应恒等于裸值，实得="${tlD2.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行 + 最新 id 已变化（本次是真实写入——ETA 从 firstRoundEta 换到新值，
    //   只是没有理由段，不是 no-op，故按"真新增 1 行"口径，而非"零新增"口径）。
    const tlAfterD2 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterD2.c, tlAfterD1.c + 1, `[D2·计数] 应恰新增 1 行，实得 ${tlAfterD1.c} → ${tlAfterD2.c}`);
    assert.notStrictEqual(tlAfterD2.mid, tlAfterD1.mid, '[D2·计数] 最新记录 id 应已变化');
    ok('[D1..D2] 理由与 ETA 同生命周期（return 同事务清空两列）+ 首诺快照跨轮锁死（return 不清、第二轮 estimate 重写不覆盖）+ timeline 对照组（return 不加清除文案/容差内改期不含理由段）+ 均恰新增 1 行');

    // liaison_test_return 同款——用一张新单快速验证清空面（不必重复整条链路，直调 sysIssueTransition 会更省，
    //   但为保持"真实端点链路"原则，走完整 liaison-test 流程需要对接人池等复杂前置，本处改直调 _internals
    //   验证 setFrags 常量确实含清空片段——见静态守卫段，此处只做最小化真实端点覆盖：reopen 见下方 [F] 段
    //   与 release 快照测试合并覆盖，reopen 同样触发理由清空，一并断言）。
  }

  // ══════════════════════════ [F] release 快照三写点全覆盖 ══════════════════════════
  {
    // [F1] C9 免上线直翻 accept：bug 单，0 commit，submit(no_code) → accept 直翻已上线。
    let id = await bugToProcessing();
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, '[F1-前置] estimate 应 200');
    let row = await issueRow(id);
    const etaBeforeRelease = row.dev_estimated_at;
    assert.ok(etaBeforeRelease, '[F1-前置] ETA 已写');
    assert.strictEqual(row.dev_estimated_at_on_release, null, '[F1-前置] release 快照初始应为 NULL（尚未上线）');
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
      mode: 'no_code', no_code_reason: 'F1 无提交交付', self_tested: true, test_env_deployed: true,
      bug_cause_note: 'F1 bug 产生原因',
    });
    assert.strictEqual(r.status, 200, `[F1-前置] submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[F1-前置] submit 后待验证');
    r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[F1] accept 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '已上线', `[F1] ⭐ 0 commit → C9 直翻已上线，实得 ${r.body.status}`);
    row = await issueRow(id);
    assert.ok(row.released_at, '[F1] released_at 已写');
    assert.strictEqual(row.dev_estimated_at_on_release, etaBeforeRelease, '[F1] ⭐ release 快照写点①（C9 直翻）：dev_estimated_at_on_release = 上线那一刻的 dev_estimated_at');
    ok('[F1] release 快照写点①：C9 免上线直翻 accept 同事务落 dev_estimated_at_on_release');

    // [F1-reopen] 归档后重开：主表 dev_estimated_at 清空，release 快照历史值不清（可回溯）。
    r = await call('POST', `/api/sys-issues/${id}/close`, adminTok, {});
    assert.strictEqual(r.status, 200, `[F1-reopen-前置] close 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/reopen`, adminTok, { reason: '需要重新处理' });
    assert.strictEqual(r.status, 200, `[F1-reopen] reopen 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.dev_estimated_at, null, '[F1-reopen] 主表 dev_estimated_at 已清空（reopen 既有 sideEffect）');
    assert.strictEqual(row.dev_estimated_at_on_release, etaBeforeRelease, '[F1-reopen] ⭐⭐ release 快照历史值不被清空——两列语义分裂正在此体现：release 快照是"上线时刻的历史事实"，不因 reopen 作废');
    assert.strictEqual(row.eta_overrun_reason_code, null, '[F1-reopen] 理由列同样清空（reopen 既有 sideEffect，本单原本就是 bug 不参与容差，恒 NULL 本无悬念，仅作完整性核对）');
    ok('[F1-reopen] reopen 后主表 dev_estimated_at 清空但 release 快照（dev_estimated_at_on_release）保留历史值，可回溯');

    // [F2] 快车道直上 submit（direct_release=true）。
    id = await bugToProcessing();
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, '[F2-前置] estimate 应 200');
    row = await issueRow(id);
    const etaBeforeF2 = row.dev_estimated_at;
    r = await call('POST', `/api/sys-issues/${id}/fast-release-authorize`, adminTok, { note: 'F2 授权' });
    assert.strictEqual(r.status, 200, `[F2-前置] 授权应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
      mode: 'no_code', no_code_reason: 'F2 无提交交付', self_tested: true, test_env_deployed: true,
      bug_cause_note: 'F2 bug 产生原因', direct_release: true,
    });
    assert.strictEqual(r.status, 200, `[F2] direct_release submit 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[F2] 快车道直上后已上线');
    assert.ok(row.released_at, '[F2] released_at 已写');
    assert.strictEqual(row.dev_estimated_at_on_release, etaBeforeF2, '[F2] ⭐ release 快照写点②（快车道直上）：dev_estimated_at_on_release = 上线那一刻的 dev_estimated_at');
    ok('[F2] release 快照写点②：组 B 快车道直上 submit 同事务落 dev_estimated_at_on_release');

    // [F3] 批次发布：bug 单走"有 commit"分支，accept 落「待上线」而非 C9 直翻，再挂批次执行发布。
    id = await bugToProcessing();
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: etaAt(0) });
    assert.strictEqual(r.status, 200, '[F3-前置] estimate 应 200');
    row = await issueRow(id);
    const etaBeforeF3 = row.dev_estimated_at;
    r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, {
      mode: 'commits', commits: [{ component: 'backend', commit_ref: `F3-ref-${Date.now()}` }],
      self_tested: true, test_env_deployed: true, bug_cause_note: 'F3 bug 产生原因',
    });
    assert.strictEqual(r.status, 200, `[F3-前置] submit(commits) 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[F3-前置] accept 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '待上线', `[F3-前置] ⭐ 有 commit → 落待上线（非 C9 直翻），实得 ${r.body.status}`);
    const relR = await call('POST', '/api/sys-releases', adminTok, { title: 'F3-批次' });
    assert.strictEqual(relR.status, 201, '[F3-前置] 建批次应 201');
    const relId = relR.body.id;
    r = await call('POST', `/api/sys-releases/${relId}/add-issues`, adminTok, { issue_ids: [id] });
    assert.strictEqual(r.status, 200, `[F3-前置] 加单应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, `[F3-前置] 设置执行人应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const execRow = await get(`SELECT id FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`, [relId]);
    assert.ok(execRow, '[F3-前置] 执行人子表行已生成');
    // execute 闸门要求 notify_status='sent'（真实链路=行级通知端点，本脚本不测通知本身，直接置态——
    //   同 verify-sys-release-batch.js 既有手法）。
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id=?`, [execRow.id]);
    r = await call('POST', `/api/sys-releases/${relId}/execute`, devTok, { release_note: 'F3 批次发布', executor_row_id: execRow.id });
    assert.strictEqual(r.status, 200, `[F3] execute 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.status, '已上线', '[F3] 批次发布后已上线');
    assert.ok(row.released_at, '[F3] released_at 已写');
    assert.strictEqual(row.dev_estimated_at_on_release, etaBeforeF3, '[F3] ⭐ release 快照写点③（批次发布 _publishReleaseCoreInTxn 内核）：dev_estimated_at_on_release = 发布那一刻的 dev_estimated_at');
    ok('[F3] release 快照写点③：批次发布（_publishReleaseCoreInTxn，publish/hotfix-publish/execute-release 共用内核）同事务落 dev_estimated_at_on_release');
  }

  // ══════════════════════════ [G] 通知 markdown/发送函数直调 ══════════════════════════
  {
    for (const fn of ['buildSysEtaOverrunReasonMarkdown', 'sendSysEtaOverrunReasonNotify']) {
      assert.strictEqual(typeof I[fn], 'function', `[G 前置] ${fn} 应已导出`);
    }
    const id = await changeToDev('improvement', { deadline: deadlineAt(-6) });
    const r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaAt(0), estimated_effort_days: 1,
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: '通知直调测试专用理由',
    });
    assert.strictEqual(r.status, 200, `[G-前置] estimate 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    const issue = await get('SELECT * FROM sys_issues WHERE id=?', [id]);
    const md = I.buildSysEtaOverrunReasonMarkdown(issue, '');
    assert.ok(/预计完成时间超出期望/.test(md.title), `[G-1] markdown title 含"预计完成时间超出期望"，实得 ${md.title}`);
    assert.ok(/预计完成时间超出业务方期望/.test(md.md), `[G-1b] markdown 正文标题含"预计完成时间超出业务方期望"，实得 ${md.md}`);
    assert.ok(md.md.includes('通知直调测试专用理由'), '[G-2] markdown 正文含理由说明');
    assert.ok(md.md.includes('需求变更'), '[G-3] markdown 正文含理由标签');
    // 直调 sendSysEtaOverrunReasonNotify（绕开 isAutoNotifyEnabled 总闸，同既有 verify-sys-notify 对其余 marker 的验证手法）。
    await I.sendSysEtaOverrunReasonNotify(issue, '', 1);
    const after = await get('SELECT creator_notify_status, creator_notify_message_key FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(after.creator_notify_status, 'sent', `[G-4] 直调发送后 creator_notify_status 应落 sent（stub 恒 ok），实得 ${after.creator_notify_status}`);
    ok('[G] buildSysEtaOverrunReasonMarkdown 内容正确（标题/理由标签/说明）+ sendSysEtaOverrunReasonNotify 直调落库 creator_notify_status=sent');

    // 无建单人分支：created_by 不存在时应 no-op（不落库、不抛错）。
    await run(`UPDATE sys_issues SET created_by = 999999, creator_notify_status = 'not_sent' WHERE id=?`, [id]);
    const issue2 = await get('SELECT * FROM sys_issues WHERE id=?', [id]);
    await I.sendSysEtaOverrunReasonNotify(issue2, '', 1);
    const after2 = await get('SELECT creator_notify_status FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(after2.creator_notify_status, 'failed', `[G-5] 建单人查无此人 → 落 failed（dev_not_found），实得 ${after2.creator_notify_status}`);
    ok('[G-5] 建单人不存在时 sendSysEtaOverrunReasonNotify 落 failed（dev_not_found），不抛异常');
  }

  // ══════════════════════════ [H] §3C.7 通知触发谓词补充断言（SC2 三条·codex 365 MED + 预筛 LOW-2·
  //   B3·用户拍板 P10 终裁后扩展）══════════════════════════════════════════════════════════
  //   背景：isAutoNotifyEnabled 总闸恒 false（见 [G] 段注释），dispatchSysNotify 经真实端点调用时
  //   查完 issue 后立即早退——无论 notify_reason 真假，通知都不会真的发出，"发没发出"这个外部可观测
  //   副作用无法区分两者。真正承载"是否应通知"这个业务判定的，是各写点内联的
  //   `overrun && (reasonCode !== oldReasonCode || reasonNote !== oldReasonNote || 值变化)` 表达式
  //   （§3C.7 触发谓词字面，七处内联：intake_accept 三分支 + assign + reassign + estimate +
  //   feasibility，未抽成独立可导出函数——"值变化"半条件已抽出为独立函数 isEtaValueChangedForNotify，
  //   但整条三元 OR 表达式本身仍是各写点内联）。[P10 用户终裁·B3] 原判据只认"理由变化"，被指出遗漏
  //   "同一理由、ETA 换到另一超容差日期"这类真实场景——用户拍板扩展为"超容差∧(理由变化∨ETA 值变化)"，
  //   H2 组由此从"钉现状=不通知"翻转为"钉新行为=会通知"，H1/H3 语义不受影响（各自的短路条件与新增的
  //   第三个 OR 分支无关）。本组沿用 [G] 段"直调真实逻辑而非复刻"的既有测试范式：直调已导出的
  //   resolveEtaOverrunReasonForWrite + isEtaValueChangedForNotify（/estimate 端点在同一行调用的同一
  //   份函数）预演本次写入会得到的 overrun/reasonCode/reasonNote/值变化，再用真实 HTTP 调用的落库结果
  //   反向校验——不是"重新发明一套判断逻辑碰巧对上"，是"调用同一份函数、复算同一行表达式、用真实端点
  //   写入结果交叉验证"。三条断言全部借道 /estimate（唯一在同一单上可重复调用、不因"现值已非空且未
  //   过期"而 409 的写点，见 §3C.3 P3 收窄裁定）。
  {
    // [H1] 同一理由重复保存（ETA 与理由逐字均不变）——命中既有 §7 M-3 同值 no-op 快捷路径：
    //   curEstMin===estMin 且 effortUnchanged 时整个写入短路（index.js :9958-9979），连
    //   resolveEtaOverrunReasonForWrite 都不会被调用，notify_reason 无从置真——这是"不重复通知"
    //   最强的一种实现（连判定都没跑，不是跑了判定后算出 false）。
    let id = await changeToDev('improvement', { deadline: deadlineAt(-6) });   // 容差=5
    const etaVal = etaAt(0);   // gap=6，超容差
    // [追加批·370-MED-2] 相对基线（不猜 changeToDev 链路具体写了几行）。
    const tlBeforeH1Pre = await timelineSnapshot(id);
    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaVal, estimated_effort_days: 2,
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: 'H1 同一理由复测',
    });
    assert.strictEqual(r.status, 200, `[H1-前置] 首次超容差写入应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, '需求变更', '[H1-前置] 理由已落库');
    // [修复 a] timeline 携带理由——gap=6（deadlineAt(-6) 到 etaAt(0)）。
    const tlH1Before = await latestTimeline(id);
    assert.strictEqual(tlH1Before.summary, etaVal + '（超出期望 6 天）——需求变更：H1 同一理由复测',
      `[H1-前置·修复 a] timeline summary 应是"裸值+理由后缀"，实得="${tlH1Before.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写）——这份快照同时兼作下面 no-op 断言的"写入后基线"。
    const tlSnapAfterH1Pre = await timelineSnapshot(id);
    assert.strictEqual(tlSnapAfterH1Pre.c, tlBeforeH1Pre.c + 1, `[H1-前置·计数] 应恰新增 1 行，实得 ${tlBeforeH1Pre.c} → ${tlSnapAfterH1Pre.c}`);
    const rowBeforeRepeat = row;
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: etaVal, estimated_effort_days: 2,   // 完全相同的 ETA（截分钟同值）+ 相同理由
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: 'H1 同一理由复测',
    });
    assert.strictEqual(r.status, 200, `[H1] 重复保存同一理由应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.unchanged, true, '[H1] ⭐ 命中 §7 M-3 同值 no-op 快捷路径（ETA+工期均未变）——resolveEtaOverrunReasonForWrite 根本不会被调用，notify_reason 无从置真');
    row = await issueRow(id);
    assert.deepStrictEqual(
      [row.eta_overrun_reason_code, row.eta_overrun_reason_note, row.dev_estimated_at],
      [rowBeforeRepeat.eta_overrun_reason_code, rowBeforeRepeat.eta_overrun_reason_note, rowBeforeRepeat.dev_estimated_at],
      '[H1] 重复保存后三列逐字未变（真·零写入，非"写了但值一样"）'
    );
    // [修复 a] 零写入延伸到 timeline——no-op 快捷路径根本不到 INSERT 语句，同一条留痕行原样未变。
    const tlH1After = await latestTimeline(id);
    assert.strictEqual(tlH1After.summary, tlH1Before.summary, '[H1·修复 a] no-op 快捷路径零写入延伸到 timeline——summary 逐字未变（非"写了但内容一样"）');
    // [追加批·370-MED-2·codex 370-MED-2 采纳] 单比 summary 字符串不够——若实现误插一条内容相同的重复
    //   留痕，上面 tlH1After.summary===tlH1Before.summary 这条断言仍会绿（新插入行的文案与旧行逐字相同）。
    //   补行数不变 + 最新记录 id 不变两条更强证据：真正证明"连一条新行都没插"，不是"插了但内容凑巧一样"。
    const tlCountAfterRepeat = await timelineSnapshot(id);
    assert.strictEqual(tlCountAfterRepeat.c, tlSnapAfterH1Pre.c, `[H1·计数] no-op 应零新增行，实得 ${tlSnapAfterH1Pre.c} → ${tlCountAfterRepeat.c}`);
    assert.strictEqual(tlCountAfterRepeat.mid, tlSnapAfterH1Pre.mid, '[H1·计数] no-op 最新记录 id 应不变（比"summary 逐字相同"更强的证据：连新 INSERT 都没发生）');
    ok('[H1] 超容差重复保存同一理由（ETA+理由均逐字不变）：命中既有 unchanged no-op 快捷路径，notify_reason 无从触发（notify_reason=false 现口径最强形式）+ timeline 零写入（行数+最新 id 双证）');

    // [H2·B3 翻转·用户拍板 P10 终裁新行为] 同一理由、但 ETA 改到"另一个仍超容差"的新日期——真实写入
    //   会发生（截分钟值变了，不命中 H1 那条 no-op 快捷路径），resolveEtaOverrunReasonForWrite 会被
    //   真正调用；直调预演 + 真实端点写入结果交叉验证：notify_reason **新口径下为 true**（理由内容
    //   逐字未变，但 ETA 值变化半条件由 isEtaValueChangedForNotify 判真，OR 表达式整体成立）——本条
    //   [P10 已裁场景] 原判据只认"理由内容变了没"，现扩展为"理由变化∨ETA 值变化"任一为真即触发。
    const rowBeforeH2 = await issueRow(id);
    const newEtaVal = etaAt(20);   // 换到 20 天后（gap=26，仍超容差，但与 H1 的 gap=6 明显是另一个日子）
    const predictedH2 = I.resolveEtaOverrunReasonForWrite({
      type: 'improvement', etaValue: newEtaVal, deadlineRaw: rowBeforeH2.deadline,
      body: { eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: 'H1 同一理由复测' },
      skipToleranceCheck: false,
    });
    const predictedEtaChangedH2 = I.isEtaValueChangedForNotify(newEtaVal, rowBeforeH2.dev_estimated_at);
    const predictedNotifyReasonH2 = predictedH2.overrun
      && (predictedH2.reasonCode !== (rowBeforeH2.eta_overrun_reason_code || null)
          || predictedH2.reasonNote !== (rowBeforeH2.eta_overrun_reason_note || null)
          || predictedEtaChangedH2);
    assert.strictEqual(predictedH2.overrun, true, '[H2-直调] 新 ETA（gap=26）应判定超容差');
    assert.strictEqual(predictedEtaChangedH2, true, '[H2-直调] ⭐ isEtaValueChangedForNotify 应判定"ETA 日期分量确已变化"（H1 的 gap=6 日子 → H2 的 gap=26 日子，跨天）');
    assert.strictEqual(predictedNotifyReasonH2, true,
      '[H2-直调] ⭐⭐ [B3 新行为] 理由标签/文字逐字未变，但 ETA 已换到另一个超容差日期 → notify_reason=true——' +
      '新口径「理由内容变了没」∨「ETA 数值变了没」任一为真即触发（方案 §3C.7 P10 已裁字面）。');
    // [追加批·370-MED-2] H2 前的行数基线——直接复用 H1 段末尾的 tlCountAfterRepeat（no-op 未新增行，
    //   两者内容相同），不必重新查一次。
    const tlBeforeH2 = tlCountAfterRepeat;
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, {
      dev_estimated_at: newEtaVal, estimated_effort_days: 2,
      eta_overrun_reason_code: '需求变更', eta_overrun_reason_note: 'H1 同一理由复测',   // 理由逐字未变
    });
    assert.strictEqual(r.status, 200, `[H2] 应 200（理由逐字未变，非"不给理由"），实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.notStrictEqual(r.body.unchanged, true, '[H2] ⭐ 本次是真实写入（ETA 换了新日期），不应命中 H1 的 no-op 快捷路径');
    row = await issueRow(id);
    assert.notStrictEqual(row.dev_estimated_at, rowBeforeH2.dev_estimated_at, '[H2] ETA 确已被真实改写为新日期');
    assert.strictEqual(row.eta_overrun_reason_code, '需求变更', '[H2] 理由标签逐字未变（落库值与直调预演一致）');
    assert.strictEqual(row.eta_overrun_reason_note, 'H1 同一理由复测', '[H2] 理由说明逐字未变（落库值与直调预演一致）');
    // [修复 a] timeline 携带理由——理由文字未变但超期天数已从 6 变为 26（gapDays 随新 ETA 重算，不是
    //   沿用旧值），证明后缀不是"复制上一条"，是每次写入按本次真实 gapDays 重新拼接。
    const tlH2 = await latestTimeline(id);
    assert.strictEqual(tlH2.summary, newEtaVal + '（超出期望 26 天）——需求变更：H1 同一理由复测',
      `[H2·修复 a] timeline summary 应反映新的超期天数（26，非沿用 H1 的 6），实得="${tlH2.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（防双写——H2 是真实写点，不是 no-op）。
    const tlAfterH2 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterH2.c, tlBeforeH2.c + 1, `[H2·计数] 应恰新增 1 行，实得 ${tlBeforeH2.c} → ${tlAfterH2.c}`);
    assert.notStrictEqual(tlAfterH2.mid, tlBeforeH2.mid, '[H2·计数] 最新记录 id 应已变化');
    ok('[H2·B3 翻转] 同理由但 ETA 改到另一超容差日期：真实写入发生 + notify_reason 新口径为 true（理由内容不变，但 ETA 数值变化半条件已判真，OR 表达式整体成立）——P10 已裁：ETA 变化确会通知；timeline summary 超期天数随新 ETA 重算+恰新增 1 行');

    // [H3] 改回容差内 → 理由两列清空 + notify_reason 现口径为 false（overrun=false 在
    //   resolveEtaOverrunReasonForWrite 内直接短路，恒不校验/恒清空理由——[U-31] 已直调覆盖该分支
    //   返回值，本处改走真实端点交叉验证落库效果 + 显式钉 notify_reason 语义，呼应任务②"改回容差内
    //   清理由且不通知"）。
    const rowBeforeH3 = await issueRow(id);
    assert.ok(rowBeforeH3.eta_overrun_reason_code, '[H3-前置] 改回容差内之前，理由列非空（承接 H2 状态）');
    const withinToleranceEta = etaAt(-1);   // gap=5（容差本身，不算超）——同 [C1-边界改写] 手法
    const predictedH3 = I.resolveEtaOverrunReasonForWrite({
      type: 'improvement', etaValue: withinToleranceEta, deadlineRaw: rowBeforeH3.deadline,
      body: {}, skipToleranceCheck: false,   // 容差内不要求理由，body 不带理由字段
    });
    // [B3] 三元 OR 表达式补全第三项（isEtaValueChangedForNotify）——即便 ETA 确实从 H2 的 newEtaVal
    //   变成了这里的 withinToleranceEta（值变化半条件此刻会判真），overrun=false 仍在 && 左侧直接短路
    //   整条表达式，第三项真假不影响最终结果，仍写全是为了让直调复算与真实实现的表达式逐字同构
    //   （不因某一项"反正会被短路掉"就省略，防将来表达式结构变化时这条断言悄悄漂移出同构关系）。
    const predictedEtaChangedH3 = I.isEtaValueChangedForNotify(withinToleranceEta, rowBeforeH3.dev_estimated_at);
    const predictedNotifyReasonH3 = predictedH3.overrun
      && (predictedH3.reasonCode !== (rowBeforeH3.eta_overrun_reason_code || null)
          || predictedH3.reasonNote !== (rowBeforeH3.eta_overrun_reason_note || null)
          || predictedEtaChangedH3);
    assert.strictEqual(predictedH3.overrun, false, '[H3-直调] gap=5（容差本身）应判定不算超');
    assert.strictEqual(predictedNotifyReasonH3, false, '[H3-直调] 容差内 overrun=false 直接短路 notify_reason=false（&& 左侧短路，与 ETA/理由是否变化无关——即便 ETA 确实变了）');
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: withinToleranceEta, estimated_effort_days: 2 });
    assert.strictEqual(r.status, 200, `[H3] 改回容差内应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await issueRow(id);
    assert.strictEqual(row.eta_overrun_reason_code, null, '[H3] ⭐ 改回容差内后理由两列被清空（C7「期望保留、理由作废」）');
    assert.strictEqual(row.eta_overrun_reason_note, null, '[H3] 理由说明同样清空');
    // [修复 a] timeline 携带清除说明——此前理由列确非空（承接 H2），本次真清空。
    const tlH3 = await latestTimeline(id);
    assert.strictEqual(tlH3.summary, withinToleranceEta + '（回到期望容差内，超期原因已清除）',
      `[H3·修复 a] timeline summary 应追加清除说明，实得="${tlH3.summary}"`);
    // [追加批·370-MED-2] 恰新增 1 行（清除正例同样防双写——H3 是真实写点：ETA 从 newEtaVal 改到
    //   withinToleranceEta，只是不再超容差，不是 no-op）。
    const tlAfterH3 = await timelineSnapshot(id);
    assert.strictEqual(tlAfterH3.c, tlAfterH2.c + 1, `[H3·计数] 应恰新增 1 行，实得 ${tlAfterH2.c} → ${tlAfterH3.c}`);
    assert.notStrictEqual(tlAfterH3.mid, tlAfterH2.mid, '[H3·计数] 最新记录 id 应已变化');
    ok('[H3] 改回容差内：理由两列清空 + notify_reason 现口径为 false（overrun=false 短路，直调复算与真实端点落库效果一致）+ timeline 携带清除说明+恰新增 1 行');
  }

  console.log(`\n✅ verify-sys-eta-overrun-snapshot 全部通过（${passed} 项）`);
  server.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); fail(e.message || String(e)); });
