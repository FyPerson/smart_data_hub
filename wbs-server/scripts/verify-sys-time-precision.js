// scripts/verify-sys-time-precision.js — 时间格式统一 S3「写入层补秒 + 幂等」验收
//   SSOT = 锚点 docs/local/系统迭代/任务_时间格式统一_20260804.md §3（D3/D4/D10）
//   用法：node scripts/verify-sys-time-precision.js
//
// 为什么单独建脚本而不是塞进既有 4 个：S3 的口径是**跨端点的一条横切规则**（库内到秒 / 文本到分 /
//   校验器幂等），散进 verify-sys-flow、-deadline-datetime、-feasibility-endpoints 会让"这条规则完整
//   覆盖了吗"无处可查。既有脚本里只更新它们各自被影响的断言，横切规则集中在本文件。
//
// 分四层（缺任一层都有静默失败的口子）：
//   [A] 校验器函数级 —— 补秒输出 + D10 幂等入参 + 秒位口径（':00' 收 / ':45' 拒）
//   [B] deadlineToMinuteText —— 新建的文本截断件；**它存在的理由**就是 truncToMinute 对纯日期返 null
//   [C] ⭐ 走真实 HTTP 端点 —— 层内全绿 ≠ 功能可用。库里真带秒了吗？把库里的值原样重提会被自己拒吗？
//   [D] ⭐ 同值 no-op 仍生效 —— 本阶段**最容易静默坏掉的一条**：est 补秒后与 truncToMinute 的现值
//       永不相等，同值判断会整个失效 ⇒ 每次重复提交都写库 + 写 timeline + **重复推送业务方钉钉通知**。
//       断言直接数 timeline 行数，不看返回值（返回值说 unchanged 但实际写了，照样是坏的）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-time-precision-secret';
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

// 2026-08-01 日期炸弹教训：远期字面量迟早到期，动态生成（同 verify-sys-attachments/deadline-datetime）
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 14:30`;
}
function futureDay(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 建一个「开发中 + 已指派」的单，供 estimate 类断言使用。
//   ⚠️ 流程照搬 verify-sys-flow 的 setup —— 建单恒落「待受理」（角色权限重构 C0 受理门焊死），
//   变更流 assign 前还要求 oa_number（v2.1 §4）。自创路径会卡在前置上，红得像 S3 改坏了。
async function setupAssignedIssue(title, oaNumber) {
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'feature', title, system_name: 'BMS',
    source: '内部', description: 'S3 时间精度 verify 夹具', intake_liaison_id: 13,
  });
  assert.strictEqual(r.status, 201, `[夹具] 建单应 201，实得 ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `[夹具] 受理应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: oaNumber });
  assert.strictEqual(r.status, 200, `[夹具] 补 OA 号应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `[夹具] 指派应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;

  try {
    // ══ [A] normalizeSysDatetime：补秒输出 + D10 幂等入参 ══════════════════════════════
    const N = I.normalizeSysDatetime;
    assert.ok(typeof N === 'function', '[A] 前置：_internals 应导出 normalizeSysDatetime');
    assert.strictEqual(N('2026-08-01 10:30'), '2026-08-01 10:30:00', '[A] D4：分钟级输入补 :00 入库');
    assert.strictEqual(N('2026-08-01T10:30'), '2026-08-01 10:30:00', '[A] T 分隔同样补秒');
    // ⭐ D10 幂等：把上一行的输出原样喂回去必须通过——不然从库里读回来重提会被自己 400 拒
    assert.strictEqual(N('2026-08-01 10:30:00'), '2026-08-01 10:30:00', '[A] ⭐ D10 幂等：自身输出重入原样通过');
    // ⭐ 放宽**仅限 :00**——放开任意合法秒就等于恢复吞秒，codex 15 M-2 那条防线白立
    assert.strictEqual(N('2026-08-01 10:30:45'), null, '[A] ⭐ 合法但非零的秒仍判非法（不恢复吞秒）');
    assert.strictEqual(N('2026-08-01 10:30:99'), null, '[A] 非法秒判非法（M-2 原防线保持）');
    assert.strictEqual(N('2026-02-30 10:30'), null, '[A] 真实日期回比对仍生效（2 月 30 日）');
    assert.strictEqual(N('2026-08-01 25:00'), null, '[A] 时位范围校验仍生效');
    assert.strictEqual(N(''), null, '[A] 空串 null');
    ok('[A] normalizeSysDatetime：补秒输出 + D10 幂等（:00 收 / :45 拒 / :99 拒）+ 既有防线未松动');

    // ══ [B] deadlineToMinuteText：它存在的理由 + ⭐ 跨层契约 ═══════════════════════════
    const DT = I.deadlineToMinuteText;
    assert.ok(typeof DT === 'function', '[B] 前置：_internals 应导出 deadlineToMinuteText');
    // ⭐ 本条是这个 helper 的**存在理由**：truncToMinute 对纯日期返 null，拿它拼留痕会把
    //   '2026-08-10' 说成"空"，凭空造出一条"从空改为 X"的假记录。
    assert.strictEqual(I.truncToMinute('2026-08-10'), null, '[B] 前提：truncToMinute 对纯日期确实返 null（所以不能拿它处理 deadline）');

    // ⭐⭐ **跨层契约向量表**（codex 253 LOW-2 采纳）：deadline 的文本规则前后端各有一份实现——
    //   后端 deadlineToMinuteText（本表）/ 前端 siFmtDeadline（Playwright 套件 [T24] 的 dlProbe）。
    //   两份实现天然会漂移，故把**同一组输入/期望**同时钉在两侧：改任一侧的规则，必须两边一起改，
    //   否则一侧红。⚠️ 唯一允许的差异：空值——后端返 null（供 `|| '空'` 之类拼接判断），
    //   前端返 '—'（直接进 DOM 的占位符）。差异本身也写死在下面，防有人"顺手统一"。
    const CONTRACT = [
      ['2026-08-10', '2026-08-10', '纯日期原样（不补零、不过 Date 解析）'],
      ['2026-08-10 14:30', '2026-08-10 14:30', '分钟级原样'],
      ['2026-08-10 14:30:00', '2026-08-10 14:30', 'S3 之后的库内形态 → 截到分'],
      ['2026-08-10T14:30:00', '2026-08-10 14:30', 'T 分隔归一'],
      ['2026-08-10T14:30:00+08:00', '2026-08-10 14:30', '时区后缀只取本地字面量、不做换算'],
      ['2026-08-10T14:30:00Z', '2026-08-10 14:30', 'Z 后缀同上'],
      ['2026-08-10 14:30garbage', '2026-08-10 14:30garbage', '尾部垃圾原样露出（正则锚定结尾）'],
      ['不是时间', '不是时间', '认不出的形态原样露出（脏数据露出比化妆更有诊断价值）'],
      ['2026-99-99 99:99:99', '2026-99-99 99:99', '只做形态归一、不做语义校验（语义校验在写入端）'],
    ];
    for (const [input, expect, why] of CONTRACT) {
      assert.strictEqual(DT(input), expect, `[B] 跨层契约 ${JSON.stringify(input)} → ${JSON.stringify(expect)}（${why}），实得 ${JSON.stringify(DT(input))}`);
    }
    ok(`[B1] ⭐ 跨层契约 ${CONTRACT.length} 例：与前端 siFmtDeadline 同一组向量（[T24] dlProbe）——改一侧必须改两侧`);

    assert.strictEqual(DT(null), null, '[B] 空值差异：后端返 null（前端 siFmtDeadline 返 "—"，见上方契约注释）');
    assert.strictEqual(DT(''), null, '[B] 空串 → null');
    assert.strictEqual(DT('   '), null, '[B] 纯空格 → null');
    ok('[B2] deadlineToMinuteText 空值三态 → null（且证明 truncToMinute 替代不了它）');

    // ══ [C] 走真实 HTTP 端点：库里真到秒了吗？幂等在端点层成立吗？════════════════════════
    const EST = futureEst(30);                 // 'YYYY-MM-DD 14:30'
    const EST_SEC = EST + ':00';
    // 夹具流程照搬 verify-sys-flow 的 setup（已验证路径，勿自创）：
    //   建单（恒落「待受理」）→ intake-accept（→「待指派」）→ set-oa-number（变更流 assign 前置）→ assign（→「开发中」）
    const id = await setupAssignedIssue('S3 时间精度夹具', '2026070001');
    let row = await get('SELECT status, assigned_at FROM sys_issues WHERE id=?', [id]);
    assert.ok(row.assigned_at, `[C] 前置：指派后 assigned_at 应非空（estimate 闸门依赖），实得 ${JSON.stringify(row.assigned_at)}`);

    let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, `[C] estimate 分钟级输入应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    row = await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.dev_estimated_at, EST_SEC, `[C] ⭐ D4：库内应到秒，实得 ${JSON.stringify(row.dev_estimated_at)}`);
    ok('[C1] estimate 端点：分钟级输入 → 库内 HH:MM:00（端点真的接了新口径，不只是函数对）');

    // ⭐ 幂等的**端到端**证明：把库里读回来的带秒值原样重提，必须 200 而不是 400。
    //   这正是 D10 存在的理由——校验器不幂等的话，前端「读回来再提交」的路径会被自己的后端拒掉。
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: row.dev_estimated_at });
    assert.strictEqual(r.status, 200, `[C] ⭐ D10 端到端幂等：库内带秒值原样重提应 200（不是 400），实得 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[C2] ⭐ D10 端到端幂等：从库里读回的带秒值重提不被自己的校验器拒');

    // ══ [D] ⭐ 同值 no-op 仍生效（S3 最容易静默坏掉的一条）═══════════════════════════════
    //   est 补秒后与 truncToMinute(现值) 永不相等 ⇒ 同值判断失效 ⇒ 每次重提都写库 + 写 timeline
    //   + 重复推送业务方钉钉。**数 timeline 行数**，不信返回值里的 unchanged 标记。
    const tlBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate'`, [id])).c;
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });        // 分钟级重提
    assert.strictEqual(r.status, 200, '[D] 同值重提应 200');
    assert.strictEqual(r.body && r.body.unchanged, true, `[D] 同值重提应返回 unchanged:true，实得 ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST_SEC });    // 带秒重提
    assert.strictEqual(r.body && r.body.unchanged, true, `[D] 带秒同值重提也应 unchanged:true，实得 ${JSON.stringify(r.body)}`);
    const tlAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate'`, [id])).c;
    assert.strictEqual(tlAfter, tlBefore,
      `[D] ⭐ 同值重提两次（分钟级 + 带秒）后 estimate timeline 行数必须不变，实得 ${tlBefore} → ${tlAfter}`
      + `——若增长即同值 no-op 失效，业务方会收到重复钉钉推送`);
    ok('[D1] ⭐ 同值 no-op 仍生效：分钟级与带秒两种形态重提都 unchanged，timeline 零增长');

    // ── [D2] timeline summary 是**给人看的文本** → 到分不带秒（D3）──────────────────────
    const tlRow = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tlRow && tlRow.summary, '[D2] 前置：应能取到 estimate 的 timeline 行');
    assert.strictEqual(tlRow.summary, EST,
      `[D2] ⭐ D3：timeline summary 是纯文本直出（前端不过格式化件），必须到分不带秒，实得 ${JSON.stringify(tlRow.summary)}`);
    ok('[D2] ⭐ timeline summary 到分不带秒（库内字段到秒 ≠ 留痕文本到秒）');

    // ── [D3] 真变更仍照常写（防"为了 no-op 把正常写入也堵了"）────────────────────────────
    const EST2 = futureEst(31);
    r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST2 });
    assert.strictEqual(r.status, 200, '[D3] 真变更应 200');
    assert.ok(!(r.body && r.body.unchanged), `[D3] 真变更不应返回 unchanged，实得 ${JSON.stringify(r.body)}`);
    row = await get('SELECT dev_estimated_at FROM sys_issues WHERE id=?', [id]);
    assert.strictEqual(row.dev_estimated_at, EST2 + ':00', `[D3] 真变更应落新值（带秒），实得 ${JSON.stringify(row.dev_estimated_at)}`);
    const tlFinal = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=? AND event_type='estimate'`, [id])).c;
    assert.strictEqual(tlFinal, tlBefore + 1, `[D3] 真变更应新增恰好 1 条 timeline，实得 ${tlBefore} → ${tlFinal}`);
    ok('[D3] 真变更仍照常写库 + 留痕（no-op 收紧没有误伤正常路径）');

    // ══ [E] deadline 侧：编辑端点幂等比对归到分（防"纯格式升级"被判成真变更）══════════════
    const DAY = futureDay(45);
    const cr2 = await call('POST', '/api/sys-issues', adminTok, {
      intake_contract_version: 2, type: 'feature', title: 'S3 deadline 幂等夹具', system_name: 'BMS',
      source: '内部', description: 'S3 verify 夹具 2', intake_liaison_id: 13, deadline: `${DAY} 09:15`,
    });
    assert.strictEqual(cr2.status, 201, `[E] 建单应 201，实得 ${cr2.status} ${JSON.stringify(cr2.body)}`);
    const id2 = cr2.body.id;
    row = await get('SELECT deadline FROM sys_issues WHERE id=?', [id2]);
    assert.strictEqual(row.deadline, `${DAY} 09:15:00`, `[E] 建单 deadline 应到秒，实得 ${JSON.stringify(row.deadline)}`);
    // 模拟 S3 之前写入的**无秒**存量值，再用编辑端点提交等价的分钟级值：
    //   纯格式升级不该被判成真变更（否则留一条"从 X 改为 X"的假记录）
    await run(`UPDATE sys_issues SET deadline = ? WHERE id = ?`, [`${DAY} 09:15`, id2]);
    const ed = await call('POST', `/api/sys-issues/${id2}/edit-in-revision`, adminTok, {
      title: 'S3 deadline 幂等夹具', description: 'S3 verify 夹具 2', system_name: 'BMS',
      module_name: null, priority: 'P2', deadline: `${DAY} 09:15`,
      requester_dept: null, requester_name: null, requester_phone: null, needs_feasibility: 0,
    });
    assert.strictEqual(ed.status, 200, `[E] 编辑应 200，实得 ${ed.status} ${JSON.stringify(ed.body)}`);
    // ⚠️ 判据是 **changed 不含 deadline**，不是整体 unchanged——建单时后端会固化 requester_* 三字段，
    //   本次传 null 属真实变更，整体必然不是 unchanged。用整体 unchanged 做判据会红得像 deadline 坏了，
    //   实际上诊断方向完全错（首版就是这么写的，红了才发现返回体里 deadline 压根不在 changed 里）。
    const edChanged = (ed.body && ed.body.changed) || [];
    assert.ok(!edChanged.includes('deadline'),
      `[E] ⭐ 无秒存量 vs 等价分钟级提交＝**纯格式升级**，幂等比对归到分后 deadline 不得进 changed。`
      + `实得 changed=${JSON.stringify(edChanged)}——若含 deadline，说明比对没归一，会写库并留一条"从 X 改为 X"的假记录`);
    row = await get('SELECT deadline FROM sys_issues WHERE id=?', [id2]);
    assert.strictEqual(row.deadline, `${DAY} 09:15`, `[E] 未变更 ⇒ 库里保持原样（不被动升级成带秒），实得 ${JSON.stringify(row.deadline)}`);
    ok('[E] ⭐ deadline 编辑幂等：纯格式升级（无秒 ↔ 带秒）不判真变更、不写库、不留假记录');

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 时间格式统一 S3：写入层补秒 + D10 幂等 + 同值 no-op + 文本到分`);
  } finally {
    if (server) server.close();
    db.close();
  }
}

main().catch((e) => {
  console.error('\n❌ verify-sys-time-precision 失败:', e && (e.stack || e.message || e));
  process.exit(1);
});
