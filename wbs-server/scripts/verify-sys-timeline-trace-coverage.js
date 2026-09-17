// scripts/verify-sys-timeline-trace-coverage.js — S4a·#67 六写点补齐·库层实证（feasibility / set-scheduled-start /
//   set-oa-number / scope-change 受控）
//   SSOT = docs/local/系统迭代/时间线留痕覆盖面补齐_方案_20260917_v0.2.md §5.1/§6；
//          docs/local/系统迭代/任务_变更留痕收口_S4a派单spec_20260917.md
//   用法：node scripts/verify-sys-timeline-trace-coverage.js
//
// 覆盖组（每条断 action_code 字面量 + Object.keys(payload)===['changes'] + 每项三键 + 到分/到值 + 同值不进）：
//   [F] /feasibility——首次（五字段中四项变化，risk 留空同值不进）/ 五字段全变更 / risk 非空→null（新结论
//       必须「可行」）/ 负向：有条件可行清空 risk → 400 FEASIBILITY_RISK_REQUIRED 零新增 / 数值字符串等价
//       工期不进 + 全同值 ⇒ 行仍写、两列 NULL、feasibility 行数 +1（合并一组断言）。
//   [S] set-scheduled-start——设（首次 old=null）/ 改 / 清（new=null）/ 同值 no-op 零新增行。
//   [O] set-oa-number——补填（首次 old=null）/ 改 / 同值 no-op 零新增行。
//   [C4b] scope-change 受控——① 四类型（feature/improvement/bug/config）真实端点各断 409（feature/improvement
//       SCOPE_CHANGE_DISABLED；bug/config SCOPE_STATUS_INVALID）且 timeline 行数增量为零；② 直调
//       buildScopeChangeDeadlineChanges 四格（未传→[]／同值→[]／首次 空→X／更新 X→Y）。
//       ③ [S4a2] 源码正则：新 INSERT 列清单/字面量码/payload 参数位引用构造函数返回值 + 四端点 else 分支保持改造前形状。
//       ⚠️ 本组只证「拒绝路径、构造函数及 INSERT 静态结构已检查」，不宣称写入分支已验证（该动作当前
//       对全部四类型均不可达，见方案 §2.1 六处写点表 #5 与 D4 拍板）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
// [G3·长任务B S4c] 平衡花括号提取——跳过字符串/模板/正则/注释内部的假花括号（见 :434 一带用途注释）
const { findMatchingBraceIndex } = require('./lib/extract-function-body.js');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-timeline-trace-coverage-secret';
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
  return new Promise((resolve, reject) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); resolve(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); reject(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); reject(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

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
function fail(msg) { console.error('\n❌ verify-sys-timeline-trace-coverage 失败: ' + msg); process.exit(1); }

const pad2 = (n) => String(n).padStart(2, '0');
function fmtLocalNoSec(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`; }
function addDays(dt, d) { const c = new Date(dt); c.setDate(c.getDate() + d); return c; }

async function timelineCount(id) {
  return Number((await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?`, [id])).c);
}
function assertChangesShape(changes, expectedLen, ctx) {
  assert.ok(Array.isArray(changes) && changes.length === expectedLen, `${ctx} changes 应恰 ${expectedLen} 项，实得 ${JSON.stringify(changes)}`);
  for (const ch of changes) {
    assert.deepStrictEqual(Object.keys(ch).sort(), ['field', 'new', 'old'], `${ctx} 每项恰 {field,old,new} 三键，实得 ${JSON.stringify(ch)}`);
  }
}
function parsePayload(tl, ctx) {
  assert.ok(tl && tl.payload_json, `${ctx} payload_json 应非空，实得 ${JSON.stringify(tl && tl.payload_json)}`);
  const p = JSON.parse(tl.payload_json);
  assert.deepStrictEqual(Object.keys(p), ['changes'], `${ctx} payload 恰含 changes 一键，实得 ${JSON.stringify(Object.keys(p))}`);
  return p;
}

let seq = 0;

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin1 / 受理人13 / dev5,6）');

  // ── 建单夹具（同 verify-sys-eta-generation.js seedS4aDevIssue 范式）──────────────────────
  async function seedDevIssue(type, needsFeasibility, riskLevel) {
    seq++;
    const payload = {
      intake_contract_version: 2, type, title: `S4a-trace-${type}-${seq}`, system_name: 'BMS', source: '内部',
      description: 'S4a #67 六写点补齐（trace-coverage）verify 建单', intake_liaison_id: 13,
    };
    if (type === 'feature' || type === 'improvement') payload.needs_feasibility = needsFeasibility;
    let r = await call('POST', '/api/sys-issues', adminTok, payload);
    assert.strictEqual(r.status, 201, `[夹具] 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const id = r.body.id;
    const acc = (type === 'feature' || type === 'improvement') ? { risk_level: riskLevel || '二级' } : {};
    r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, acc);
    assert.strictEqual(r.status, 200, `[夹具] 受理 200, got ${r.status} ${JSON.stringify(r.body)}`);
    if (type === 'feature' || type === 'improvement' || type === 'config') {
      r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(40260700 + seq).padStart(10, '4') });
      assert.strictEqual(r.status, 200, `[夹具] 补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
    }
    r = await call('POST', `/api/sys-issues/${id}/assign`, liaisonTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `[夹具] assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    await run(`UPDATE sys_issues SET intake_liaison_id = 999999, dev_estimated_at = NULL WHERE id = ?`, [id]);
    return id;
  }
  async function latestTl(id, eventType) {
    return get(`SELECT action_code, payload_json, summary FROM sys_issue_timeline WHERE issue_id=? AND event_type=? ORDER BY id DESC LIMIT 1`, [id, eventType]);
  }

  // ══════════════════════════ [F] /feasibility 变更留痕（附带变更类）══════════════════════════
  {
    const id = await seedDevIssue('feature', 1);
    const est1 = fmtLocalNoSec(addDays(new Date(), 20));
    // [F1] 首次：conclusion=可行（risk 留空，可行不强制风险）——四字段变化（dev_estimated_at/effort/conclusion/requirement_confirm），risk old=null new=null 不进
    let r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求已明确', risk: '', dev_estimated_at: est1, estimated_effort_days: 2,
    });
    assert.strictEqual(r.status, 200, `[F1] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let tl = await latestTl(id, 'feasibility');
    assert.strictEqual(tl.action_code, 'feasibility_change', `[F1] action_code 应为 feasibility_change，实得 ${tl.action_code}`);
    let p = parsePayload(tl, '[F1]');
    assertChangesShape(p.changes, 4, '[F1]');
    const byField = (arr, f) => arr.find(c => c.field === f);
    assert.strictEqual(byField(p.changes, 'dev_estimated_at').old, null, '[F1] dev_estimated_at old=null');
    assert.strictEqual(byField(p.changes, 'dev_estimated_at').new, est1, `[F1] dev_estimated_at new=${est1}`);
    assert.strictEqual(byField(p.changes, 'estimated_effort_days').old, null, '[F1] estimated_effort_days old=null');
    assert.strictEqual(byField(p.changes, 'estimated_effort_days').new, 2, '[F1] estimated_effort_days new=2');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').old, null, '[F1] feasibility_conclusion old=null');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').new, '可行', '[F1] feasibility_conclusion new=可行');
    assert.strictEqual(byField(p.changes, 'feasibility_requirement_confirm').old, null, '[F1] feasibility_requirement_confirm old=null');
    assert.strictEqual(byField(p.changes, 'feasibility_requirement_confirm').new, '需求已明确', '[F1] feasibility_requirement_confirm new');
    assert.strictEqual(byField(p.changes, 'feasibility_risk'), undefined, '[F1] risk 留空且旧值本为 null ⇒ 同值不进 changes');
    ok('[F1] ⭐【#67 六写点补齐】/feasibility 首次（结论=可行·risk 留空）：action_code=feasibility_change + changes 四项，risk 同值不进');

    // [F2] 五字段全变更：conclusion→有条件可行（须填 risk），三处正文字段+日期+工期全变
    const est2 = fmtLocalNoSec(addDays(new Date(), 25));
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, {
      conclusion: '有条件可行', requirement_confirm: '需求理解已更新', risk: '存在依赖风险X', dev_estimated_at: est2, estimated_effort_days: 3,
    });
    assert.strictEqual(r.status, 200, `[F2] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    tl = await latestTl(id, 'feasibility');
    p = parsePayload(tl, '[F2]');
    assert.strictEqual(tl.action_code, 'feasibility_change', `[F2] action_code 应为 feasibility_change，实得 ${tl.action_code}`);
    assertChangesShape(p.changes, 5, '[F2]');
    assert.strictEqual(byField(p.changes, 'dev_estimated_at').old, est1, '[F2] dev_estimated_at old=上次值');
    assert.strictEqual(byField(p.changes, 'dev_estimated_at').new, est2, '[F2] dev_estimated_at new');
    assert.strictEqual(byField(p.changes, 'estimated_effort_days').old, 2, '[F2] estimated_effort_days old=2');
    assert.strictEqual(byField(p.changes, 'estimated_effort_days').new, 3, '[F2] estimated_effort_days new=3');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').old, '可行', '[F2] feasibility_conclusion old=可行');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').new, '有条件可行', '[F2] feasibility_conclusion new');
    assert.strictEqual(byField(p.changes, 'feasibility_requirement_confirm').old, '需求已明确', '[F2] requirement_confirm old');
    assert.strictEqual(byField(p.changes, 'feasibility_requirement_confirm').new, '需求理解已更新', '[F2] requirement_confirm new');
    assert.strictEqual(byField(p.changes, 'feasibility_risk').old, null, '[F2] feasibility_risk old=null（此前未填）');
    assert.strictEqual(byField(p.changes, 'feasibility_risk').new, '存在依赖风险X', '[F2] feasibility_risk new');
    ok('[F2] ⭐【#67 六写点补齐】/feasibility 五字段全变更：changes 恰五项，old 均为上一次落库值');

    // [F3] risk 非空→null 正例（新结论必须「可行」）：conclusion 有条件可行→可行，其余字段不变，risk 清空
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求理解已更新', risk: '', dev_estimated_at: est2, estimated_effort_days: 3,
    });
    assert.strictEqual(r.status, 200, `[F3] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    tl = await latestTl(id, 'feasibility');
    p = parsePayload(tl, '[F3]');
    assert.strictEqual(tl.action_code, 'feasibility_change', `[F3] action_code 应为 feasibility_change，实得 ${tl.action_code}`);
    assertChangesShape(p.changes, 2, '[F3]');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').old, '有条件可行', '[F3] conclusion old');
    assert.strictEqual(byField(p.changes, 'feasibility_conclusion').new, '可行', '[F3] conclusion new');
    assert.strictEqual(byField(p.changes, 'feasibility_risk').old, '存在依赖风险X', '[F3] risk old（清空前的非空值）');
    assert.strictEqual(byField(p.changes, 'feasibility_risk').new, null, '[F3] risk new=null（清空，仅新结论=可行时合法）');
    ok('[F3] ⭐【#67 六写点补齐】risk 非空→null 正例：新结论=可行时合法清空，changes 恰含 conclusion+risk 两项');

    // [F4] 负向：有条件可行清空 risk → 400 FEASIBILITY_RISK_REQUIRED，timeline 零新增
    const tlBefore4 = await timelineCount(id);
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, {
      conclusion: '有条件可行', requirement_confirm: '需求理解已更新', risk: '', dev_estimated_at: est2, estimated_effort_days: 3,
    });
    assert.strictEqual(r.status, 400, `[F4] 应 400，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'FEASIBILITY_RISK_REQUIRED', `[F4] code 应为 FEASIBILITY_RISK_REQUIRED，实得 ${r.body.code}`);
    assert.strictEqual(await timelineCount(id), tlBefore4, '[F4] timeline 零新增（校验在写入前拦截）');
    ok('[F4] ⭐【#67 负向】「有条件可行」清空 risk → 400 FEASIBILITY_RISK_REQUIRED，timeline 零新增');

    // [F5] 数值字符串等价工期不进 + 全同值 ⇒ 行仍写、两列 NULL、既有 feasibility 行数 +1
    const feasCountBefore = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility'`, [id])).length;
    const tlBefore5 = await timelineCount(id);
    r = await call('POST', `/api/sys-issues/${id}/feasibility`, devTok, {
      conclusion: '可行', requirement_confirm: '需求理解已更新', risk: '', dev_estimated_at: est2, estimated_effort_days: '3.0',
    });
    assert.strictEqual(r.status, 200, `[F5] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await timelineCount(id), tlBefore5 + 1, '[F5] 本端点无同值 rollback 分支，行仍写（+1）');
    const feasCountAfter = (await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='feasibility'`, [id])).length;
    assert.strictEqual(feasCountAfter, feasCountBefore + 1, '[F5] 既有 feasibility 行数 +1');
    tl = await latestTl(id, 'feasibility');
    assert.strictEqual(tl.action_code, null, `[F5] 全同值（'3.0' 数值等价 3）⇒ action_code 应为 NULL，实得 ${JSON.stringify(tl.action_code)}`);
    assert.strictEqual(tl.payload_json, null, `[F5] 全同值 ⇒ payload_json 应为 NULL，实得 ${JSON.stringify(tl.payload_json)}`);
    ok('[F5] ⭐【#67 六写点补齐】数值字符串等价工期（"3.0"≈3）不进 changes + 全同值 ⇒ 行仍写、两列 NULL、feasibility 行数 +1（原有事件照旧）');
  }

  // ══════════════════════════ [S] set-scheduled-start 变更留痕（修改类）══════════════════════════
  {
    const id = await seedDevIssue('feature', 0);
    // set-scheduled-start 设非空值须 dev_estimated_at 非空（§7.2）——夹具已清空，先经真实 /estimate 回填。
    const estForS = fmtLocalNoSec(addDays(new Date(), 30));
    let rEst = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: estForS, estimated_effort_days: 1 });
    assert.strictEqual(rEst.status, 200, `[S 前置] estimate 回填 200，实得 ${rEst.status} ${JSON.stringify(rEst.body)}`);
    const day1 = fmtLocalNoSec(addDays(new Date(), 3)).slice(0, 10);
    // [S1] 设（首次 old=null）
    let r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: day1 });
    assert.strictEqual(r.status, 200, `[S1] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let tl = await latestTl(id, 'note');
    assert.strictEqual(tl.action_code, 'set_scheduled_start', `[S1] action_code 应为 set_scheduled_start，实得 ${tl.action_code}`);
    let p = parsePayload(tl, '[S1]');
    assertChangesShape(p.changes, 1, '[S1]');
    assert.strictEqual(p.changes[0].field, 'scheduled_start', '[S1] field=scheduled_start');
    assert.strictEqual(p.changes[0].old, null, '[S1] 首次 old=null');
    assert.strictEqual(p.changes[0].new, day1, `[S1] new=${day1}`);
    ok('[S1] ⭐【#67 六写点补齐】set-scheduled-start 首次：action_code=set_scheduled_start + changes old=null');

    // [S2] 改
    const day2 = fmtLocalNoSec(addDays(new Date(), 5)).slice(0, 10);
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: day2 });
    assert.strictEqual(r.status, 200, `[S2] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    tl = await latestTl(id, 'note');
    p = parsePayload(tl, '[S2]');
    assert.strictEqual(tl.action_code, 'set_scheduled_start', `[S2] action_code 应为 set_scheduled_start，实得 ${tl.action_code}`);
    assertChangesShape(p.changes, 1, '[S2]');
    assert.strictEqual(p.changes[0].field, 'scheduled_start', `[S2] field 应为 scheduled_start，实得 ${p.changes[0].field}`);
    assert.strictEqual(p.changes[0].old, day1, `[S2] old=${day1}`);
    assert.strictEqual(p.changes[0].new, day2, `[S2] new=${day2}`);
    ok('[S2] ⭐【#67 六写点补齐】set-scheduled-start 改：old 为上次值');

    // [S3] 清（new=null）
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: null });
    assert.strictEqual(r.status, 200, `[S3] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    tl = await latestTl(id, 'note');
    p = parsePayload(tl, '[S3]');
    assert.strictEqual(tl.action_code, 'set_scheduled_start', `[S3] action_code 应为 set_scheduled_start，实得 ${tl.action_code}`);
    assertChangesShape(p.changes, 1, '[S3]');
    assert.strictEqual(p.changes[0].field, 'scheduled_start', `[S3] field 应为 scheduled_start，实得 ${p.changes[0].field}`);
    assert.strictEqual(p.changes[0].old, day2, `[S3] old=${day2}`);
    assert.strictEqual(p.changes[0].new, null, '[S3] new=null（清除）');
    ok('[S3] ⭐【#67 六写点补齐】set-scheduled-start 清：new=null');

    // [S4] 同值 no-op（此刻现值为 null，再传 null）⇒ 零新增行
    const tlBefore4 = await timelineCount(id);
    r = await call('POST', `/api/sys-issues/${id}/set-scheduled-start`, adminTok, { scheduled_start: null });
    assert.strictEqual(r.status, 200, `[S4] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.unchanged, true, '[S4] unchanged=true');
    assert.strictEqual(await timelineCount(id), tlBefore4, '[S4] 同值 no-op 零新增 timeline 行');
    ok('[S4] ⭐【#67 六写点补齐】set-scheduled-start 同值 no-op：零新增行（既有 no-op 分支先于本次改造 return）');
  }

  // ══════════════════════════ [O] set-oa-number 变更留痕（修改类）══════════════════════════
  {
    const id = await seedDevIssue('feature', 0);
    // seedDevIssue 内 assign 前置已补过 OA 号（assertSysDevCommitmentOaGuard 必填）——本组要测「首次补填
    // old=null」这一格，须先清空模拟"指派前免 OA/历史脏数据"等 old 确实为空的场景。
    await run(`UPDATE sys_issues SET oa_number = NULL WHERE id = ?`, [id]);
    // [O1] 补填（首次 old=null）
    let r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026090101' });
    assert.strictEqual(r.status, 200, `[O1] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    let tl = await latestTl(id, 'note');
    assert.strictEqual(tl.action_code, 'set_oa_number', `[O1] action_code 应为 set_oa_number，实得 ${tl.action_code}`);
    let p = parsePayload(tl, '[O1]');
    assertChangesShape(p.changes, 1, '[O1]');
    assert.strictEqual(p.changes[0].field, 'oa_number', '[O1] field=oa_number');
    assert.strictEqual(p.changes[0].old, null, '[O1] 首次 old=null（本夹具建单未带 OA 号）');
    assert.strictEqual(p.changes[0].new, '2026090101', '[O1] new=2026090101');
    ok('[O1] ⭐【#67 六写点补齐】set-oa-number 首次补填：action_code=set_oa_number + changes old=null');

    // [O2] 改
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026090102' });
    assert.strictEqual(r.status, 200, `[O2] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    tl = await latestTl(id, 'note');
    p = parsePayload(tl, '[O2]');
    assert.strictEqual(tl.action_code, 'set_oa_number', `[O2] action_code 应为 set_oa_number，实得 ${tl.action_code}`);
    assertChangesShape(p.changes, 1, '[O2]');
    assert.strictEqual(p.changes[0].field, 'oa_number', `[O2] field 应为 oa_number，实得 ${p.changes[0].field}`);
    assert.strictEqual(p.changes[0].old, '2026090101', '[O2] old=上次值');
    assert.strictEqual(p.changes[0].new, '2026090102', '[O2] new=2026090102');
    ok('[O2] ⭐【#67 六写点补齐】set-oa-number 改：old 为上次值');

    // [O3] 同值 no-op ⇒ 零新增行
    const tlBefore3 = await timelineCount(id);
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026090102' });
    assert.strictEqual(r.status, 200, `[O3] 应 200，实得 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.changed, false, '[O3] changed=false');
    assert.strictEqual(await timelineCount(id), tlBefore3, '[O3] 同值 no-op 零新增 timeline 行');
    ok('[O3] ⭐【#67 六写点补齐】set-oa-number 同值 no-op：零新增行（既有 no-op 分支先于本次改造 return）');
  }

  // ══════════════════════════ [C4b] scope-change 受控实证（不可达写点·防御性补齐）══════════════════════════
  {
    // ① 真实端点四类型各断 409 + timeline 增量为零
    // feature：建单+受理（落"待指派"）→ scope-change → 409 SCOPE_CHANGE_DISABLED
    {
      const id = await seedDevIssueSimple('feature');
      const before = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/scope-change`, adminTok, { summary: 'C4b 探针-feature' });
      assert.strictEqual(r.status, 409, `[C4b-feature] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', `[C4b-feature] code 应为 SCOPE_CHANGE_DISABLED，实得 ${r.body.code}`);
      assert.strictEqual(await timelineCount(id), before, '[C4b-feature] timeline 增量为零');
      ok('[C4b-feature] ⭐【#67 受控】feature 单 scope-change → 409 SCOPE_CHANGE_DISABLED，timeline 零增量');
    }
    // improvement：同 feature
    {
      const id = await seedDevIssueSimple('improvement');
      const before = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/scope-change`, adminTok, { summary: 'C4b 探针-improvement' });
      assert.strictEqual(r.status, 409, `[C4b-improvement] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SCOPE_CHANGE_DISABLED', `[C4b-improvement] code 应为 SCOPE_CHANGE_DISABLED，实得 ${r.body.code}`);
      assert.strictEqual(await timelineCount(id), before, '[C4b-improvement] timeline 增量为零');
      ok('[C4b-improvement] ⭐【#67 受控】improvement 单 scope-change → 409 SCOPE_CHANGE_DISABLED，timeline 零增量');
    }
    // bug：建单+受理（落"待处理"）→ scope-change → 409 SCOPE_STATUS_INVALID（findTransition 恒 null）
    {
      const id = await seedDevIssueSimple('bug');
      const before = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/scope-change`, adminTok, { summary: 'C4b 探针-bug' });
      assert.strictEqual(r.status, 409, `[C4b-bug] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SCOPE_STATUS_INVALID', `[C4b-bug] code 应为 SCOPE_STATUS_INVALID，实得 ${r.body.code}`);
      assert.strictEqual(await timelineCount(id), before, '[C4b-bug] timeline 增量为零');
      ok('[C4b-bug] ⭐【#67 受控】bug 单 scope-change → 409 SCOPE_STATUS_INVALID（无该动作条目），timeline 零增量');
    }
    // config：建单+受理+补OA（落"待处理"）→ scope-change → 409 SCOPE_STATUS_INVALID
    {
      const id = await seedDevIssueSimple('config');
      const before = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/scope-change`, adminTok, { summary: 'C4b 探针-config' });
      assert.strictEqual(r.status, 409, `[C4b-config] 应 409，实得 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'SCOPE_STATUS_INVALID', `[C4b-config] code 应为 SCOPE_STATUS_INVALID，实得 ${r.body.code}`);
      assert.strictEqual(await timelineCount(id), before, '[C4b-config] timeline 增量为零');
      ok('[C4b-config] ⭐【#67 受控】config 单 scope-change → 409 SCOPE_STATUS_INVALID（CONFIG_FLOW_TRANSITIONS 无此条目），timeline 零增量');
    }

    // ② 直调 buildScopeChangeDeadlineChanges 四格
    assert.strictEqual(typeof I.buildScopeChangeDeadlineChanges, 'function', '[C4b②前置] buildScopeChangeDeadlineChanges 应已导出');
    {
      const r1 = I.buildScopeChangeDeadlineChanges({ provided: false, dlTextOld: '2026-09-20 10:00', dlTextNew: undefined });
      assert.deepStrictEqual(r1, [], `[C4b②-未传] provided:false ⇒ []，实得 ${JSON.stringify(r1)}`);
      const r2 = I.buildScopeChangeDeadlineChanges({ provided: true, dlTextOld: '2026-09-20 10:00', dlTextNew: '2026-09-20 10:00' });
      assert.deepStrictEqual(r2, [], `[C4b②-同值] 新旧相同 ⇒ []，实得 ${JSON.stringify(r2)}`);
      const r3 = I.buildScopeChangeDeadlineChanges({ provided: true, dlTextOld: null, dlTextNew: '2026-09-20 10:00' });
      assert.deepStrictEqual(r3, [{ field: 'deadline', old: null, new: '2026-09-20 10:00' }], `[C4b②-首次] old 应为 null，实得 ${JSON.stringify(r3)}`);
      const r4 = I.buildScopeChangeDeadlineChanges({ provided: true, dlTextOld: '2026-09-20 10:00', dlTextNew: '2026-09-25 18:00' });
      assert.deepStrictEqual(r4, [{ field: 'deadline', old: '2026-09-20 10:00', new: '2026-09-25 18:00' }], `[C4b②-更新] 实得 ${JSON.stringify(r4)}`);
      ok('[C4b②] ⭐【#67 受控】buildScopeChangeDeadlineChanges 四格：未传→[]／同值→[]／首次 空→X／更新 X→Y');
    }
    console.log('  ⚠️ [C4b 结论措辞] 拒绝路径、构造函数及 INSERT 静态结构已检查；写入分支未验证（端点当前对全部四类型均不可达）——将来放开该动作时须补端到端写入测试，不得沿用本次受控检查作为放行证据。');
  }

  // ── [C4b③·S4a2 → S4a3·codex 584 M] INSERT 静态结构断言（限定到路由片段 + if/else 配对 + scope-change 同变量链）──
  //   S4a2 版只查「全文出现次数」，codex 584 指出：互换 scope-change 两个分支、或把 legacy 形状挪到别的路由，
  //   正则照过 ⇒ 「M2 已锁住 else 分支」「返回值同源」的声明强于判别力。本版：
  //   ① 路由片段切片：从 router.post('/sys-issues/:id/<path>' 到该处理器收尾 "\n  });" 之间；
  //   ② 片段内恰 1 处「if (<changes>.length) { INSERT(含 action_code+payload_json·字面量码·payload 引用 <changes>) } else { INSERT(不含 action_code) }」配对；
  //   ③ scope-change 额外：<changes> 由 buildScopeChangeDeadlineChanges({ provided… }) 赋值恰 1 处，
  //      "if (scopeChangeDeadlineChanges.length) {" 恰 2 处（SET 片段 + INSERT），SET 片段块内含 setFrags.push('deadline = ?')。
  //   变异自证（scratchpad 脚本·不进仓库）：互换 scope-change 两个 INSERT 分支 → ② 红；去掉 SET 外层 if → ③ 红。
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
    const routeSlice = (p) => {
      const key = `router.post('/sys-issues/:id/${p}'`;
      const i = src.indexOf(key); assert.ok(i >= 0, `[静态] 未找到路由 ${key}`);
      assert.strictEqual(src.indexOf(key, i + 1), -1, `[静态] 路由 ${key} 出现多次`);
      // 切片终点 = 该处理器自身的收尾 "\n  });"（2 空格缩进）——不能用下一个 router. 做终点：路由之间夹着模块级
      //   helper（如 derive 的 insertDerivedSysIssue）也会写 timeline，会把别的 INSERT 切进来（S4a3 首跑实得 3）。
      const j = src.indexOf('\n  });', i + key.length);
      assert.ok(j >= 0, `[静态] 路由 ${key} 未找到处理器收尾 "  });"`);
      return src.slice(i, j + 6);
    };
    const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pairRe = (v, evt, code) => new RegExp(
      'if \\(' + esc(v) + '\\.length\\) \\{\\s*await dbRunAsync\\(\\s*`INSERT INTO sys_issue_timeline \\([^)]*action_code[^)]*payload_json\\)\\s*VALUES \\([^)]*\'' + esc(evt) + '\'[^)]*\'' + esc(code) + '\'[^)]*\\)`,\\s*\\[[^\\]]*JSON\\.stringify\\(\\{ changes: ' + esc(v) + ' \\}\\)\\]\\s*\\);\\s*\\} else \\{\\s*await dbRunAsync\\(\\s*`INSERT INTO sys_issue_timeline \\((?![^)]*action_code)(?![^)]*payload_json)[^)]*\\)\\s*VALUES \\([^)]*\'' + esc(evt) + '\'[^)]*\\)`', 'g');
    const SITES = [
      ['estimate', 'estimateChanges', 'estimate', 'estimate_eta'],
      ['feasibility', 'feasibilityChanges', 'feasibility', 'feasibility_change'],
      ['assign', 'assignChanges', 'assign', 'assign_eta'],
      ['scope-change', 'scopeChangeDeadlineChanges', 'scope_change', 'scope_change_deadline'],
    ];
    for (const [p, v, evt, code] of SITES) {
      const slice = routeSlice(p);
      const n = (slice.match(pairRe(v, evt, code)) || []).length;
      assert.strictEqual(n, 1, `[静态·${p}] 路由片段内「if (${v}.length){新 INSERT('${code}'·payload 引用 ${v})} else {原形状 INSERT(无 action_code/payload_json)}」配对应恰 1 处，实得 ${n}`);
      const legacyAll = (slice.match(/INSERT INTO sys_issue_timeline \((?![^)]*action_code)[^)]*\)/g) || []).length;
      assert.strictEqual(legacyAll, 1, `[静态·${p}] 路由片段内不含 action_code 的 INSERT 应只有 else 分支那 1 处，实得 ${legacyAll}`);
    }
    ok('[静态·M2] 四路由片段内各恰 1 处「有变化新 INSERT / 无变化原形状 INSERT」if-else 配对，且原形状 INSERT 只出现在 else 分支');
    const sc = routeSlice('scope-change');
    const assignN = (sc.match(/const scopeChangeDeadlineChanges = buildScopeChangeDeadlineChanges\(\{\s*provided: dlValue !== undefined, dlTextOld, dlTextNew,?\s*\}\);/g) || []).length;
    assert.strictEqual(assignN, 1, `[静态·C4b③] scopeChangeDeadlineChanges 须由 buildScopeChangeDeadlineChanges({provided: dlValue !== undefined, dlTextOld, dlTextNew}) 赋值恰 1 处，实得 ${assignN}`);
    const ifN = (sc.match(/if \(scopeChangeDeadlineChanges\.length\) \{/g) || []).length;
    assert.strictEqual(ifN, 2, `[静态·C4b③] "if (scopeChangeDeadlineChanges.length) {" 应恰 2 处（SET 片段 + INSERT 分支），实得 ${ifN}`);
    // SET 片段块内含模板字面量 ${…}，不能用 [^}]* 界定块体；取首个 if 之后的 400 字符窗口（块体实际 ~200 字符）。
    // [S6a·codex 587-R M2] 「在 if 之后、UPDATE 之前」证不了「在 if 块内」——保留空 if {} 把 SET 构造挪到块后照样过。
    //   改为平衡括号取首个 if 的 consequent 块（块内模板 \`\${dlTextOld || '空'}\` 的花括号成对，计数不受影响），
    //   断 push 与 setParams.push 都在块内，且块外（到 UPDATE 之间）不再出现 setFrags.push('deadline'。
    const firstIf = sc.indexOf('if (scopeChangeDeadlineChanges.length) {');
    assert.ok(firstIf >= 0, '[静态·C4b③] 未找到首个 if (scopeChangeDeadlineChanges.length) {');
    // [G3·长任务B S4c·2026-09-17] 原朴素深度计数逐字符统计花括号，不区分字符串/模板字面量/注释——
    //   块内若出现模板字符串含裸 `}`（如 `${…}还剩 } 才对`这类说明性拼接）或注释里写了 `{`，计数会被
    //   带偏（提前收尾/越界吞并后续代码），"提取成功≠边界正确"同 verify-sys-release-panel-static.js 头部
    //   :90-108 一带记录的同款风险。改用共享 lib（scripts/lib/extract-function-body.js）的有限状态词法
    //   扫描——跳过字符串/模板/正则/注释内部的假花括号，只让真代码态字符参与深度计数。
    const braceOpen = sc.indexOf('{', firstIf);
    const braceClose = findMatchingBraceIndex(sc, braceOpen);
    assert.ok(braceClose > braceOpen, '[静态·C4b③] 首个 if 块花括号不平衡');
    const ifBlock = sc.slice(braceOpen, braceClose + 1);
    assert.ok(ifBlock.includes("setFrags.push('deadline = ?')") && ifBlock.includes('setParams.push(dlValue)'), '[静态·C4b③] SET 片段（setFrags.push deadline + setParams.push dlValue）必须在首个 if (scopeChangeDeadlineChanges.length) 的块**内**');
    const between = sc.slice(braceClose + 1, sc.indexOf('const upd = await dbRunAsync', braceClose));
    assert.ok(between.indexOf("setFrags.push('deadline") === -1, '[静态·C4b③] if 块之后到 UPDATE 之间不得再出现 deadline 的 SET 构造（防「空 if + 块外无条件 push」）');
    assert.ok(braceClose < sc.indexOf('const upd = await dbRunAsync'), '[静态·C4b③] 首个 if 块须在 UPDATE 之前');
    ok('[静态·C4b③] scope-change：构造函数赋值 → 同一变量同时门控 SET 片段与新 INSERT（参数位引用同一变量）');

    // ══════════════════════════════════════════════════════════════════════
    // [G3·长任务B S4c·2026-09-17] mutated 反例——纯合成最小片段（不改动任何生产文件），证明改用共享 lib
    // （findMatchingBraceIndex）前后确有判别力差异：改造前的朴素深度计数逐字符统计花括号、不区分代码/
    // 字符串/模板/注释，遇到"块内模板字符串含裸 }"与"注释含裸 {"两类输入会分别数错（提前收尾 / 提取
    // 失败），改造后（有限状态词法扫描剥掉字符串/模板/注释后再计数）两类输入都能取到正确边界。
    // ══════════════════════════════════════════════════════════════════════
    {
      // 反例①：块内模板字符串含裸 } ——旧版朴素计数会被模板文本里的 } 带偏，提前在 doStuff() 之前收尾。
      const fixtureA = "if (x.length) {\n" +
        "  const label = `还剩 ${x.length} } 项`;\n" +
        "  doStuff();\n" +
        "}\nconst after = 1;";
      const openA = fixtureA.indexOf('{');
      const newCloseA = findMatchingBraceIndex(fixtureA, openA);
      assert.ok(newCloseA >= 0, '[G3 mutated①] 新版（共享 lib）应能在含模板字符串裸 } 的片段里找到收尾 }');
      const newBlockA = fixtureA.slice(openA, newCloseA + 1);
      assert.ok(newBlockA.includes('doStuff()') && !newBlockA.includes('const after'),
        `[G3 mutated①] 新版应恰好取到含 doStuff() 的完整块、不越界吞并块外代码，实得 ${JSON.stringify(newBlockA)}`);
      // 旧版朴素深度计数（照抄改造前 :440-442 逐字符实现，仅用于本对照，非生产代码路径）。
      let depthA = 0, legacyCloseA = -1;
      for (let i = openA; i < fixtureA.length; i++) {
        if (fixtureA[i] === '{') depthA++;
        else if (fixtureA[i] === '}') { depthA--; if (depthA === 0) { legacyCloseA = i; break; } }
      }
      const legacyBlockA = legacyCloseA >= 0 ? fixtureA.slice(openA, legacyCloseA + 1) : null;
      assert.ok(!legacyBlockA || !legacyBlockA.includes('doStuff()'),
        `[G3 mutated①] 旧版朴素计数应在此漏检（被模板字符串内的裸 } 带偏提前收尾，取不到 doStuff()）——若此断言失败说明旧版行为已意外改变，需重估 G3 是否仍必要，旧版实得 ${JSON.stringify(legacyBlockA)}`);

      // 反例②：注释含裸 { ——旧版朴素计数会被注释文本里的 { 带偏，多欠一层深度，导致提取失败（找不到收尾）。
      const fixtureB = "if (x.length) {\n" +
        "  /* 说明：这里的 " + "{" + " 只是举例，不是代码 */\n" +
        "  doStuff();\n" +
        "}\nfunction unrelated() { return 1; }\n";
      const openB = fixtureB.indexOf('{');
      const newCloseB = findMatchingBraceIndex(fixtureB, openB);
      assert.ok(newCloseB >= 0, '[G3 mutated②] 新版（共享 lib）应能在含注释裸 { 的片段里找到收尾 }');
      const newBlockB = fixtureB.slice(openB, newCloseB + 1);
      assert.ok(newBlockB.includes('doStuff()') && !newBlockB.includes('unrelated'),
        `[G3 mutated②] 新版应恰好取到含 doStuff() 的完整块、不吞并块外的 unrelated 函数，实得 ${JSON.stringify(newBlockB)}`);
      let depthB = 0, legacyCloseB = -1;
      for (let i = openB; i < fixtureB.length; i++) {
        if (fixtureB[i] === '{') depthB++;
        else if (fixtureB[i] === '}') { depthB--; if (depthB === 0) { legacyCloseB = i; break; } }
      }
      assert.strictEqual(legacyCloseB, -1,
        `[G3 mutated②] 旧版朴素计数应在此漏检（被注释内的裸 { 带偏，多欠一层深度导致提取失败/越界），若此断言失败说明旧版行为已意外改变，需重估 G3 是否仍必要，旧版实得收尾下标=${legacyCloseB}`);

      ok('[G3·长任务B S4c] mutated 反例：块内模板字符串含裸 }/注释含裸 { 两类输入，新版（共享 lib 状态机）均取到正确边界，旧版朴素深度计数在同输入下分别"提前收尾漏掉块尾代码"与"提取失败"');
    }
    const newCodes = { estimate_eta: "'estimate', ?, 'estimate_eta'", feasibility_change: "'feasibility', ?, 'feasibility_change'", assign_eta: "?, ?, ?, 'assign_eta'", scope_change_deadline: "'scope_change', ?, 'scope_change_deadline'" };
    for (const [code, frag] of Object.entries(newCodes)) {
      const n = src.split(frag).length - 1;
      assert.strictEqual(n, 1, `[静态] 新码 ${code} 的字面量 INSERT 全文应恰 1 处，实得 ${n}`);
    }
    ok('[静态] 四新码字面量全文各恰 1 处（与 label-coverage 58 站点解析互证）');
  }
  server.close();
  console.log(`\n[全部通过] ${passed}/${passed} ✓ S4a·#67 六写点补齐·库层实证（feasibility/set-scheduled-start/set-oa-number/scope-change 受控）验收通过`);
}

// scope-change 受控组用的极简建单 helper（无需 assign/estimate，只需到达 scope-change 判定点前的状态）。
async function seedDevIssueSimple(type) {
  seq++;
  const payload = {
    intake_contract_version: 2, type, title: `S4a-trace-simple-${type}-${seq}`, system_name: 'BMS', source: '内部',
    description: 'S4a #67 六写点补齐（scope-change 受控）verify 建单', intake_liaison_id: 13,
  };
  let r = await call('POST', '/api/sys-issues', adminTok, payload);
  assert.strictEqual(r.status, 201, `[C4b 夹具] 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const acc = (type === 'feature' || type === 'improvement' || type === 'config') ? { risk_level: '二级' } : {};
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, acc);
  assert.strictEqual(r.status, 200, `[C4b 夹具] 受理 200, got ${r.status} ${JSON.stringify(r.body)}`);
  if (type === 'config') {
    r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(40260800 + seq).padStart(10, '4') });
    assert.strictEqual(r.status, 200, `[C4b 夹具] 补 OA 200, got ${r.status} ${JSON.stringify(r.body)}`);
  }
  return id;
}

main().catch((e) => { fail(e && e.stack || e); });
