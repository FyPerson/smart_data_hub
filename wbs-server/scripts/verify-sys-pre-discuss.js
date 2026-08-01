// 验证脚本：系统迭代 角色权限重构 C2.5 撤销与流程重构（方案 v2.1·189/190 号定点复审后定稿）
//   用法：node scripts/verify-sys-pre-discuss.js
//
// 背景：C2.5「预沟通段/待商议」已被彻底撤销——本文件（原名 verify-sys-pre-discuss.js，专测该已撤销机制）
//   改为**撤销哨兵 + 新流程验收**双职责：① 证明预沟通段的可执行状态引用（状态字面量/路由/transitions 条目）
//   已随撤销清零；② 覆盖 v2.1 §2 状态矩阵重新设计的 issue_reject 权限收敛 + intake_accept 阻断 + 三边自动清
//   + OA 号生命周期（新端点 set-oa-number）+ assign 的 OA 前置守卫。
//
// 覆盖（§2/§3/§4/§8 逐条对应）：
//   [S] 撤销哨兵：三类型建单均落「待受理」（含变更流）+ pre-discuss-pass 路由 404 + transitions 无
//       pre_discuss_pass 可达路径（任意 type × from 组合皆 null）+ PRE_DISCUSS 相关导出已删除
//   [RJ] issue_reject 权限交叉矩阵（§2 末·7 格）+ 前置守卫三态（未咨询/咨询未回复 409·已回复 200）
//       + reason 缺失 400
//   [BA] intake_accept 受理阻断：挂未回复咨询 409 INTAKE_BLOCKED_BY_PENDING_CONSULT（全类型验一半）·
//       已回复 200·已取消 200
//   [CL] 自动清三边（clearPendingConsultOnLeave 覆盖面）：bug issue_reject / intake_return / void
//       各一组——未回复→清九列+cancel_consult 留痕；已回复→不清不留痕（对照）
//   [OA] set-oa-number：每类型（变更流以 feature 代表 + bug）允许集内 1 正例 + 集外 1 反例（非待受理）
//       + 待受理拒 + 格式非法拒 + number 类型拒 + 同值再提交 200 no-op（timeline 不新增）+ 首次成功
//       落一条 action_code='set_oa_number' timeline
//   [AS] assign 的 OA 前置守卫：变更流无号/空串/非法值 409 ASSIGN_REQUIRES_OA_NUMBER·有效号 200·
//       bug 无号 200（不受限，D2）
//
// ✅ 已裁定（S4 收口·2026-07-28·原"待主会话核对"矛盾已闭）：bug 流**无**「已暂缓」——契约首版照抄
//   变更流集合属方案笔误，SYS_OA_ALLOWED_STATUSES.bug 与方案 v2.1 §4 均已收窄（`2afa103`）。
//   [OA] 组现含 bug×已暂缓 的显式集外反例断言（S7 末次审要求：争议格裁定后要测进去，不留"绕开"痕迹）。
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-pre-discuss-secret';
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
async function mockSend() { return { ok: true, message_key: 'stub-key' }; }
async function mockBaseUrl() { return ''; }

// ⭐ P8（用户裁定尾巴·193 号"原子性声称收窄"的注入版补齐）：故障注入包装——命中 clearPendingConsultOnLeave
//   的 cancel_consult 留痕 INSERT 且开关打开时拒绝，用于证明"清九列+状态迁移+留痕"同事务整体回滚。
//   fired 断言防 SQL 片段漂移成永真（[CR]/[RN] 同款纪律）。
let injectClearFailTargetId = null;
let injectClearFailFired = false;
const CLEAR_CONSULT_INSERT_MARKER = "VALUES (?, 'note', ?, 'cancel_consult', ?, ?)";
const runFI = (sql, params = []) => {
  if (injectClearFailTargetId != null && sql.includes(CLEAR_CONSULT_INSERT_MARKER) && params[0] === injectClearFailTargetId) {
    injectClearFailFired = true; injectClearFailTargetId = null;
    return Promise.reject(new Error('[P8 注入] cancel_consult 留痕写入失败'));
  }
  return run(sql, params);
};

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: runFI, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSend,
  getSafePlatformBaseUrl: mockBaseUrl,
});
const I = mod._internals;
const T = require('../routes/sys-iteration/transitions');

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

// ⚠️ 测试 id 与生产 users.id 无对应关系：授权只看 JWT role 与白名单常量（同 verify-sys-role-perm-c1 说明）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);   // 受理人白名单
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);       // 技术负责人白名单
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);               // 普通用户（非 admin 非受理人）
// ⭐ 双身份假设单：uid=13（受理人白名单）但 role='admin'——190 号末轮修正：intake_liaison_only 判定
//   只看 uid 是否∈受理人白名单、不看 role，故本 token 应与 liaisonTok 同样放行变更流拒绝。
const dualTok = jwt.sign({ id: 13, username: 'wangtaotao_dual', display_name: '示例对接人(双身份)', role: 'admin' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => {
      // 404 HTML 等非 JSON 响应兜底（[S] 哨兵要打已删路由，express 默认 404 页不是 JSON）
      let b = '';
      r.on('data', c => b += c);
      r.on('end', () => { let parsed = null; if (b) { try { parsed = JSON.parse(b); } catch (e) { parsed = { _raw: b.slice(0, 120) }; } } resolve({ status: r.statusCode, body: parsed }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const create = (type, extra = {}) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: 2, type, title: `${type}-v2.1`, system_name: 'BMS', source: '内部',
    description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });
const statusOf = async (id) => (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status;
const consult = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/request-tech-consult`, tok, { tech_lead_id: 7 });
const currentRound = async (id) => {
  const r = await get('SELECT tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id]);
  return r ? r.ev : null;
};
const comment = async (id, tok, text, expectedEventId) => call('POST', `/api/sys-issues/${id}/tech-lead-comment`, tok,
  { comment: text, expected_request_event_id: expectedEventId !== undefined ? expectedEventId : await currentRound(id) });
const cancelConsult = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/cancel-consult`, tok, {});
const reject = (id, tok, reason) => call('POST', `/api/sys-issues/${id}/issue-reject`, tok, reason === undefined ? {} : { reason });
const intakeAccept = (id, tok = liaisonTok) => call('POST', `/api/sys-issues/${id}/intake-accept`, tok, {});
const intakeReturn = (id, tok = liaisonTok, reason = '材料不全') => call('POST', `/api/sys-issues/${id}/intake-return`, tok, { reason });
const voidIssue = (id, tok = adminTok, reason = '误建') => call('POST', `/api/sys-issues/${id}/void`, tok, { reason });
const setOa = (id, tok, oa_number) => call('POST', `/api/sys-issues/${id}/set-oa-number`, tok, { oa_number });
const assignCall = (id, tok, assigned_to) => call('POST', `/api/sys-issues/${id}/assign`, tok, { assigned_to });

const TECH_LEAD_COLS = ['tech_lead_id', 'tech_lead_name', 'tech_lead_notify_request_event_id', 'tech_lead_notify_status',
  'tech_lead_notified_at', 'tech_lead_notify_message_key', 'tech_lead_read_at', 'tech_lead_notify_error', 'tech_lead_notify_sent_by'];
const assertTechLeadCleared = (row) => {
  assert.strictEqual(row.tech_lead_notify_status, 'not_sent', 'tech_lead_notify_status=not_sent（整组归零）');
  for (const c of TECH_LEAD_COLS.filter(x => x !== 'tech_lead_notify_status')) {
    assert.strictEqual(row[c], null, `${c} = NULL（整组归零）`);
  }
};
// 建一张已咨询且已回复的变更流单（issue_reject 前置守卫要求"当前轮已有意见"的正例前置）
async function seedFeatureWithComment() {
  const c = await create('feature');
  const id = c.body.id;
  const rq = await consult(id);
  assert.strictEqual(rq.status, 200, `夹具 request-tech-consult 200, got ${rq.status} ${JSON.stringify(rq.body)}`);
  const cm = await comment(id, techTok, '技术上可行，建议排期');
  assert.strictEqual(cm.status, 200, `夹具 tech-lead-comment 200, got ${cm.status} ${JSON.stringify(cm.body)}`);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });
  ok('readiness ready + HTTP harness（admin1 / 受理人13 / 技术负责人7 / dev5 / 双身份dual13-admin）');

  // ═══ [S] 撤销哨兵：三类型建单均落待受理 + pre-discuss-pass 路由 404 + transitions 无可达路径 ═══
  {
    for (const type of ['feature', 'improvement', 'bug']) {
      const r = await create(type);
      assert.strictEqual(r.status, 201, `${type} 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '待受理', `${type} 建单落「待受理」（v2.1：C2.5 撤销·全类型归一）`);
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, '待受理', `${type} 落库 status=待受理`);
      assert.strictEqual(row.intake_required, 1, `${type} 落库 intake_required=1（C0 不变量不受影响）`);
    }
    // 路由已删 → 404（Express 无匹配路由，非业务层 400/409 —— 与"路由存在但拒绝"要区分清楚）
    const c = await create('feature');
    const pre = await call('POST', `/api/sys-issues/${c.body.id}/pre-discuss-pass`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(pre.status, 404, `pre-discuss-pass 路由应 404（已删）, got ${pre.status} ${JSON.stringify(pre.body)}`);
    // ⭐ S7 末次审 M（抽样→穷举）：遍历**每类型的完整 ALLOWED_STATUSES**（外加已删的「待商议」字面量），
    //   不再手挑五个 from——残留条目若在未抽查状态上，抽样哨兵会假绿。
    for (const type of ['feature', 'improvement', 'bug']) {
      const allStatuses = (T.ALLOWED_STATUSES && T.ALLOWED_STATUSES[type]) || [];
      assert.ok(allStatuses.length > 0, `[S] 前置：${type} 的 ALLOWED_STATUSES 非空（穷举基座）`);
      assert.ok(!allStatuses.includes('待商议'), `[S] ${type} 的 ALLOWED_STATUSES 不应再含「待商议」`);
      for (const from of [...allStatuses, '待商议']) {
        assert.strictEqual(T.findTransition(type, 'pre_discuss_pass', from), null,
          `${type} 的 pre_discuss_pass 从「${from}」应无可达 transition`);
      }
    }
    // meta 层穷举：typeFlows 任何类型的 action 清单不得含 pre_discuss_pass
    const meta = T.buildMeta();
    for (const type of Object.keys(meta.typeFlows || {})) {
      const acts = (meta.typeFlows[type] || []).map(t => t.action);
      assert.ok(!acts.includes('pre_discuss_pass'), `[S] meta.typeFlows.${type} 不应含 pre_discuss_pass（实际 ${acts.join(',')}）`);
    }
    // 状态族层：无 PRE_DISCUSS 族·任何族的任何状态集不含「待商议」
    const SF = require('../routes/sys-iteration/status-families');
    assert.strictEqual(SF.SYS_PRE_DISCUSS_STATUSES, undefined, '[S] status-families 的 SYS_PRE_DISCUSS_STATUSES 应已删除');
    for (const fam of (SF.FAMILY_NAMES || [])) {
      assert.notStrictEqual(fam, 'PRE_DISCUSS', '[S] 族名清单不应含 PRE_DISCUSS');
      for (const t of ['feature', 'improvement', 'bug']) {
        const sts = SF.getFamilyStatuses(t, fam) || [];   // 193 复审 M：不吞异常——族映射损坏必须红灯（fam 来自 FAMILY_NAMES 自身·合法族抛错即真故障）
        assert.ok(!sts.includes('待商议'), `[S] 族 ${fam}/${t} 不应含「待商议」`);
      }
    }
    // PRE_DISCUSS 相关导出应已删除（可执行状态引用，§7 必删清单）
    assert.strictEqual(T.SYS_PRE_DISCUSS_TYPES, undefined, 'SYS_PRE_DISCUSS_TYPES 应已随撤销删除');
    assert.strictEqual(T.SYS_PRE_DISCUSS_STATUS, undefined, 'SYS_PRE_DISCUSS_STATUS 应已随撤销删除');
    ok('[S] 撤销哨兵（穷举版·S7 收口）：三类型建单落待受理 + 路由 404 + findTransition 全 ALLOWED_STATUSES×3型穷举 + meta.typeFlows 无该 action + 状态族无 PRE_DISCUSS/待商议 + 导出已删');
  }

  // ═══ [RJ] issue_reject 权限交叉矩阵（§2 末·7 格）═══
  {
    // ① admin 拒 bug → 200（关键允许格·防误拦）
    const b1 = await create('bug');
    const r1 = await reject(b1.body.id, adminTok, '不是缺陷');
    assert.strictEqual(r1.status, 200, `[RJ①] admin 拒 bug 应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.status, '已拒绝', '[RJ①] bug 拒绝 → 已拒绝');

    // ② admin 拒变更单 → 403
    const f2 = await seedFeatureWithComment();   // 即使前置守卫已满足，admin 仍应被角色守卫拦下
    const r2 = await reject(f2, adminTok, '需求不合理');
    assert.strictEqual(r2.status, 403, `[RJ②] admin 拒变更单应 403, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(await statusOf(f2), '待受理', '[RJ②] 403 后状态零变动');

    // ③ 受理人拒 bug → 403
    const b3 = await create('bug');
    const r3 = await reject(b3.body.id, liaisonTok, '不是缺陷');
    assert.strictEqual(r3.status, 403, `[RJ③] 受理人拒 bug 应 403, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(await statusOf(b3.body.id), '待受理', '[RJ③] 403 后状态零变动');

    // ④ 受理人拒变更单（有意见）→ 200
    const f4 = await seedFeatureWithComment();
    const r4 = await reject(f4, liaisonTok, '需求不合理，技术负责人已评估');
    assert.strictEqual(r4.status, 200, `[RJ④] 受理人拒变更单(有意见) 应 200, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.status, '已拒绝', '[RJ④] 变更单拒绝 → 已拒绝');

    // ⑤ 受理人拒变更单（无意见/未咨询）→ 409
    const f5 = await create('feature');
    const r5 = await reject(f5.body.id, liaisonTok, '需求不合理');
    assert.strictEqual(r5.status, 409, `[RJ⑤] 受理人拒变更单(无意见) 应 409, got ${r5.status} ${JSON.stringify(r5.body)}`);
    assert.strictEqual(r5.body.code, 'REJECT_REQUIRES_TECH_COMMENT', '[RJ⑤] 应为 REJECT_REQUIRES_TECH_COMMENT');
    assert.strictEqual(await statusOf(f5.body.id), '待受理', '[RJ⑤] 409 后状态零变动');

    // ⑥ 普通用户（非 admin 非受理人）拒两类 → 均 403
    const b6 = await create('bug');
    const r6a = await reject(b6.body.id, devTok, '普通用户尝试拒 bug');
    assert.strictEqual(r6a.status, 403, `[RJ⑥a] 普通用户拒 bug 应 403, got ${r6a.status} ${JSON.stringify(r6a.body)}`);
    const f6 = await seedFeatureWithComment();
    const r6b = await reject(f6, devTok, '普通用户尝试拒变更单');
    assert.strictEqual(r6b.status, 403, `[RJ⑥b] 普通用户拒变更单应 403（即便前置守卫已满足）, got ${r6b.status} ${JSON.stringify(r6b.body)}`);

    // ⑦ 双身份（uid∈受理人白名单 且 role=admin）拒变更单 → 200（判定只看 uid∈白名单，不看 role）
    const f7 = await seedFeatureWithComment();
    const r7 = await reject(f7, dualTok, '双身份用户拒绝');
    assert.strictEqual(r7.status, 200, `[RJ⑦] 双身份(uid13∈白名单·role=admin) 拒变更单应 200, got ${r7.status} ${JSON.stringify(r7.body)}`);
    assert.strictEqual(r7.body.status, '已拒绝', '[RJ⑦] 双身份拒绝 → 已拒绝');

    // 前置守卫三态补全：未咨询（⑤已覆盖）/ 咨询未回复 / 已回复（④已覆盖）
    const f8 = await create('feature');
    await consult(f8.body.id);   // 已发起咨询但技术负责人尚未回复
    const r8 = await reject(f8.body.id, liaisonTok, '需求不合理');
    assert.strictEqual(r8.status, 409, `[RJ 三态·未回复] 应 409, got ${r8.status} ${JSON.stringify(r8.body)}`);
    assert.strictEqual(r8.body.code, 'REJECT_REQUIRES_TECH_COMMENT', '[RJ 三态·未回复] 应为 REJECT_REQUIRES_TECH_COMMENT');

    // reason 缺失 → 400（bug/变更单各验一次）
    const b9 = await create('bug');
    const r9a = await reject(b9.body.id, adminTok, undefined);
    assert.strictEqual(r9a.status, 400, `[RJ reason 缺失·bug] 应 400, got ${r9a.status} ${JSON.stringify(r9a.body)}`);
    const f9 = await seedFeatureWithComment();
    const r9b = await reject(f9, liaisonTok, undefined);
    assert.strictEqual(r9b.status, 400, `[RJ reason 缺失·变更单] 应 400, got ${r9b.status} ${JSON.stringify(r9b.body)}`);

    ok('[RJ] issue_reject 权限交叉矩阵 7 格全验（admin拒bug200/admin拒变更403/受理人拒bug403/受理人拒变更(有意见)200/受理人拒变更(无意见)409/普通用户拒两类403/双身份拒变更200）+ 前置守卫三态（未咨询·咨询未回复 均409，已回复200）+ reason 缺失400（两类各验）');
  }

  // ═══ [BA] intake_accept 受理阻断（全类型）：挂未回复咨询 409·已回复 200·已取消 200 ═══
  {
    // 变更流：未回复 → 409
    const f1 = await create('feature');
    await consult(f1.body.id);
    const r1 = await intakeAccept(f1.body.id);
    assert.strictEqual(r1.status, 409, `[BA] 变更流未回复咨询受理应 409, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'INTAKE_BLOCKED_BY_PENDING_CONSULT', '[BA] 应为 INTAKE_BLOCKED_BY_PENDING_CONSULT');
    assert.strictEqual(await statusOf(f1.body.id), '待受理', '[BA] 409 后状态零变动');

    // bug：未回复 → 409（全类型验证，与 feature 对称）
    const b1 = await create('bug');
    await consult(b1.body.id);
    const rb1 = await intakeAccept(b1.body.id);
    assert.strictEqual(rb1.status, 409, `[BA] bug 未回复咨询受理应 409, got ${rb1.status} ${JSON.stringify(rb1.body)}`);
    assert.strictEqual(rb1.body.code, 'INTAKE_BLOCKED_BY_PENDING_CONSULT', '[BA] bug 应为 INTAKE_BLOCKED_BY_PENDING_CONSULT');

    // 已回复 → 200
    const f2 = await create('feature');
    const rq2 = await consult(f2.body.id);
    await comment(f2.body.id, techTok, '已回复，受理可继续', rq2.body.request_event_id);
    const r2 = await intakeAccept(f2.body.id);
    assert.strictEqual(r2.status, 200, `[BA] 已回复咨询受理应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.status, '待指派', '[BA] 受理通过 → 待指派');

    // 已取消 → 200
    const f3 = await create('feature');
    await consult(f3.body.id);
    const rc3 = await cancelConsult(f3.body.id);
    assert.strictEqual(rc3.status, 200, `[BA] 取消咨询应 200, got ${rc3.status} ${JSON.stringify(rc3.body)}`);
    const r3 = await intakeAccept(f3.body.id);
    assert.strictEqual(r3.status, 200, `[BA] 已取消咨询受理应 200, got ${r3.status} ${JSON.stringify(r3.body)}`);

    ok('[BA] intake_accept 受理阻断：未回复 409 INTAKE_BLOCKED_BY_PENDING_CONSULT（feature/bug 均验）·已回复 200·已取消 200');
  }

  // ═══ [CL] 自动清三边（clearPendingConsultOnLeave）：bug issue_reject / intake_return / void
  //   各一组——未回复→清九列+cancel_consult 留痕；已回复→不清不留痕（对照）═══
  {
    // ── 边 1：bug issue_reject ──
    {
      const c1 = await create('bug');
      await consult(c1.body.id);   // 未回复
      const beforeCnt = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c1.body.id])).c;
      const r1 = await reject(c1.body.id, adminTok, '不是缺陷');
      assert.strictEqual(r1.status, 200, `[CL/reject] bug 未回复拒绝应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
      const row1 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c1.body.id]);
      assertTechLeadCleared(row1);
      const tl1 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult' ORDER BY id DESC LIMIT 1`, [c1.body.id]);
      assert.ok(tl1, '[CL/reject] 应新增 cancel_consult timeline 行');
      assert.ok(/自动取消/.test(tl1.summary), `[CL/reject] summary 应含"自动取消"，实际：${tl1.summary}`);
      const afterCnt = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c1.body.id])).c;
      assert.strictEqual(afterCnt, beforeCnt + 1, '[CL/reject] cancel_consult 行数 +1');

      // 对照：已回复 → 不清不留痕
      const c2 = await create('bug');
      const rq2 = await consult(c2.body.id);
      await comment(c2.body.id, techTok, '已回复的意见', rq2.body.request_event_id);
      const beforeCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      // S7 收口：九列全快照（只查 tech_lead_id 时，误清 notify_status/时间戳/message_key 等仍会假绿）
      const snap2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      const r2 = await reject(c2.body.id, adminTok, '不是缺陷');
      assert.strictEqual(r2.status, 200, `[CL/reject 对照] 已回复拒绝应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      const row2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      assert.deepStrictEqual(row2, snap2, '[CL/reject 对照] 已回复轮次是历史——九列全快照逐列一致（不得部分清空）');
      const afterCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      assert.strictEqual(afterCnt2, beforeCnt2, '[CL/reject 对照] 已回复不应新增 cancel_consult 留痕');
    }

    // ── 边 2：intake_return（全类型代表·用 feature）──
    {
      const c1 = await create('feature');
      await consult(c1.body.id);   // 未回复
      const r1 = await intakeReturn(c1.body.id);
      assert.strictEqual(r1.status, 200, `[CL/return] 未回复退回应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
      const row1 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c1.body.id]);
      assertTechLeadCleared(row1);
      const tl1 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult' ORDER BY id DESC LIMIT 1`, [c1.body.id]);
      assert.ok(tl1 && /自动取消/.test(tl1.summary), '[CL/return] 应新增含"自动取消"的 cancel_consult 行');

      // 对照：已回复 → 不清不留痕
      const c2 = await create('feature');
      const rq2 = await consult(c2.body.id);
      await comment(c2.body.id, techTok, '已回复的意见', rq2.body.request_event_id);
      const beforeCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      // S7 收口：九列全快照（只查 tech_lead_id 时，误清 notify_status/时间戳/message_key 等仍会假绿）
      const snap2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      const r2 = await intakeReturn(c2.body.id);
      assert.strictEqual(r2.status, 200, `[CL/return 对照] 已回复退回应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      const row2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      assert.deepStrictEqual(row2, snap2, '[CL/return 对照] 已回复轮次是历史——九列全快照逐列一致（不得部分清空）');
      const afterCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      assert.strictEqual(afterCnt2, beforeCnt2, '[CL/return 对照] 已回复不应新增 cancel_consult 留痕');
    }

    // ── 边 3：void（全类型代表·用 feature）──
    {
      const c1 = await create('feature');
      await consult(c1.body.id);   // 未回复
      const r1 = await voidIssue(c1.body.id);
      assert.strictEqual(r1.status, 200, `[CL/void] 未回复作废应 200, got ${r1.status} ${JSON.stringify(r1.body)}`);
      const row1 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c1.body.id]);
      assertTechLeadCleared(row1);
      const tl1 = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult' ORDER BY id DESC LIMIT 1`, [c1.body.id]);
      assert.ok(tl1 && /自动取消/.test(tl1.summary), '[CL/void] 应新增含"自动取消"的 cancel_consult 行');

      // 对照：已回复 → 不清不留痕
      const c2 = await create('feature');
      const rq2 = await consult(c2.body.id);
      await comment(c2.body.id, techTok, '已回复的意见', rq2.body.request_event_id);
      const beforeCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      // S7 收口：九列全快照（只查 tech_lead_id 时，误清 notify_status/时间戳/message_key 等仍会假绿）
      const snap2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      const r2 = await voidIssue(c2.body.id);
      assert.strictEqual(r2.status, 200, `[CL/void 对照] 已回复作废应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      const row2 = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [c2.body.id]);
      assert.deepStrictEqual(row2, snap2, '[CL/void 对照] 已回复轮次是历史——九列全快照逐列一致（不得部分清空）');
      const afterCnt2 = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [c2.body.id])).c;
      assert.strictEqual(afterCnt2, beforeCnt2, '[CL/void 对照] 已回复不应新增 cancel_consult 留痕');
    }

    // ⚠️ 声称边界（S7 收口）：本组证明的是**成功路径的结果一致性**（清了什么/留了什么/留痕有无）；
    //   "清字段+状态迁移+留痕在同一事务原子提交"属代码审结论（helper 明文要求调用方事务内调用+失败 throw
    //   整体回滚·191 号审已核），本组不声称已用故障注入证明——注入版留待追认（锚点 P 项）。
    // ⭐ P8 注入版：bug 拒绝边上，留痕 INSERT 被注入失败 → 整个 transition 必须原子回滚
    //   （status 仍待受理·九列原值完好·零 cancel_consult 行）——193 号收窄的"原子性属代码审结论"就此升级为实测。
    {
      const cI = await create('bug');
      const rqI = await consult(cI.body.id);
      const snapI = await get(`SELECT status, ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [cI.body.id]);
      injectClearFailTargetId = cI.body.id; injectClearFailFired = false;
      const rI = await reject(cI.body.id, adminTok, '注入场景拒绝');
      assert.ok(injectClearFailFired, '[CL/P8] 注入必须真的命中（防 SQL 片段漂移成永真）');
      assert.ok(rI.status >= 500 || rI.status === 409, `[CL/P8] 留痕失败应整体失败, got ${rI.status}`);
      const afterI = await get(`SELECT status, ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [cI.body.id]);
      assert.deepStrictEqual(afterI, snapI, '[CL/P8] 原子回滚：status+九列逐列与注入前完全一致——注入点(留痕 INSERT)在 status UPDATE 与九列清 UPDATE **之后**，本断言证明的是含状态迁移在内的整体回滚，非仅清理段（196 增量审 M4 澄清）');
      assert.strictEqual(Number(afterI.tech_lead_notify_request_event_id), Number(rqI.body.request_event_id), '[CL/P8] event_id 未被吞');
      const cntI = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='cancel_consult'`, [cI.body.id])).c;
      assert.strictEqual(cntI, 0, '[CL/P8] 零 cancel_consult 行');
      // 撤注入后同一张单正常拒绝可走通（对照·证明失败仅来自注入）
      const rOk = await reject(cI.body.id, adminTok, '正常拒绝');
      assert.strictEqual(rOk.status, 200, `[CL/P8] 撤注入后拒绝应 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
    }
    ok('[CL] 自动清三边（成功路径一致性·九列快照版）：bug issue_reject / intake_return / void——未回复→清九列+留痕含"自动取消"；已回复→**九列 deepStrictEqual 逐列保留**+不新增留痕');
  }

  // ═══ [OA] set-oa-number：每类型允许集内 1 正例 + 集外 1 反例（非待受理）+ 待受理拒 + 格式非法拒 +
  //   number 类型拒 + 同值再提交 200 no-op（不新增 timeline）+ 首次成功落 1 条 action_code='set_oa_number' ═══
  {
    for (const [type, allowedProbe, oaVal] of [['feature', '待指派', '2026070101'], ['bug', '待处理', '2026070102']]) {
      // 待受理拒（专项：紧邻的"受理前"态，未走 intake-accept）
      const cPending = await create(type);
      const rPending = await setOa(cPending.body.id, adminTok, oaVal);
      assert.strictEqual(rPending.status, 409, `[OA/${type}] 待受理态设 OA 应 409, got ${rPending.status} ${JSON.stringify(rPending.body)}`);
      assert.strictEqual(rPending.body.code, 'OA_NUMBER_STATUS_NOT_ALLOWED', `[OA/${type}] 待受理拒应为 OA_NUMBER_STATUS_NOT_ALLOWED`);
      assert.strictEqual((await get('SELECT oa_number FROM sys_issues WHERE id=?', [cPending.body.id])).oa_number, null, `[OA/${type}] 待受理拒后 oa_number 仍 NULL`);

      // 集外反例（非待受理·用"已拒绝"，两类型均合法且明确不在 OA 允许集内，见文件头"待主会话核对"）
      const cOut = await create(type);
      await run(`UPDATE sys_issues SET status='已拒绝' WHERE id=?`, [cOut.body.id]);
      const rOut = await setOa(cOut.body.id, adminTok, oaVal);
      assert.strictEqual(rOut.status, 409, `[OA/${type}] 已拒绝态设 OA 应 409, got ${rOut.status} ${JSON.stringify(rOut.body)}`);
      assert.strictEqual(rOut.body.code, 'OA_NUMBER_STATUS_NOT_ALLOWED', `[OA/${type}] 集外反例应为 OA_NUMBER_STATUS_NOT_ALLOWED`);

      // 集内正例：受理通过后的首个态（feature=待指派 / bug=待处理）
      const cIn = await create(type);
      const accIn = await intakeAccept(cIn.body.id);
      assert.strictEqual(accIn.status, 200, `[OA/${type}] 夹具受理 200, got ${accIn.status} ${JSON.stringify(accIn.body)}`);
      assert.strictEqual(accIn.body.status, allowedProbe, `[OA/${type}] 夹具受理落态应为 ${allowedProbe}`);

      // 格式非法拒（带前缀横杠·非纯数字）
      const rBadFmt = await setOa(cIn.body.id, adminTok, 'OA-2026-001');
      assert.strictEqual(rBadFmt.status, 400, `[OA/${type}] 格式非法应 400, got ${rBadFmt.status} ${JSON.stringify(rBadFmt.body)}`);
      // number 类型拒
      const rBadNum = await setOa(cIn.body.id, adminTok, 2026070001);
      assert.strictEqual(rBadNum.status, 400, `[OA/${type}] number 类型应 400, got ${rBadNum.status} ${JSON.stringify(rBadNum.body)}`);
      assert.strictEqual((await get('SELECT oa_number FROM sys_issues WHERE id=?', [cIn.body.id])).oa_number, null, `[OA/${type}] 负例后 oa_number 仍 NULL（无半成品写入）`);

      // 集内正例成功写入 + timeline 留痕
      const tlBefore = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_oa_number'`, [cIn.body.id])).c;
      const rOk = await setOa(cIn.body.id, adminTok, oaVal);
      assert.strictEqual(rOk.status, 200, `[OA/${type}] 集内正例设 OA 应 200, got ${rOk.status} ${JSON.stringify(rOk.body)}`);
      assert.strictEqual((await get('SELECT oa_number FROM sys_issues WHERE id=?', [cIn.body.id])).oa_number, oaVal, `[OA/${type}] OA 号落库=${oaVal}`);
      const tlAfter = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_oa_number'`, [cIn.body.id])).c;
      assert.strictEqual(tlAfter, tlBefore + 1, `[OA/${type}] 首次成功应新增 1 条 set_oa_number timeline`);

      // 同值再提交 → 200 no-op（timeline 不新增）
      const rNoop = await setOa(cIn.body.id, adminTok, oaVal);
      assert.strictEqual(rNoop.status, 200, `[OA/${type}] 同值再提交应 200, got ${rNoop.status} ${JSON.stringify(rNoop.body)}`);
      const tlAfterNoop = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_oa_number'`, [cIn.body.id])).c;
      assert.strictEqual(tlAfterNoop, tlAfter, `[OA/${type}] 同值再提交不应新增 timeline（no-op）`);
    }
    // ⭐ S7 末次审 HIGH 收口：**权限矩阵**——端点 requireAdmin，仅 admin 可写；受理人/技术负责人/普通用户
    //   一律 403 且零副作用（oa_number 不变·无新增 timeline）。此前只测 admin 成功路径——中间件缺失/放宽时
    //   全绿，而未授权补号会直接满足变更流指派门槛（这正是该 HIGH 的攻击面）。
    {
      const cP = await create('feature');
      await intakeAccept(cP.body.id);   // 进「待指派」（允许集内·排除"状态不对"干扰，只测权限维）
      for (const [who, tok] of [['受理人13', liaisonTok], ['技术负责人7', techTok], ['普通用户5', devTok]]) {
        const before = await get('SELECT oa_number FROM sys_issues WHERE id=?', [cP.body.id]);
        const tlB = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_oa_number'`, [cP.body.id])).c;
        const r = await setOa(cP.body.id, tok, '20260728555');
        assert.strictEqual(r.status, 403, `[OA/权限] ${who} 补号应 403, got ${r.status} ${JSON.stringify(r.body)}`);
        const after = await get('SELECT oa_number FROM sys_issues WHERE id=?', [cP.body.id]);
        assert.strictEqual(after.oa_number, before.oa_number, `[OA/权限] ${who} 被拒后 oa_number 零副作用`);
        const tlA = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='set_oa_number'`, [cP.body.id])).c;
        assert.strictEqual(tlA, tlB, `[OA/权限] ${who} 被拒后零 timeline 增量`);
      }
      // admin 正例（对照·证明 403 来自权限而非单据状态）
      const rA = await setOa(cP.body.id, adminTok, '20260728555');
      assert.strictEqual(rA.status, 200, `[OA/权限] admin 同单同状态补号应 200（对照）, got ${rA.status}`);
    }
    // ⭐ S7 末次审 M 收口：bug×「已暂缓」显式集外反例——该格曾是"契约 vs 状态机"争议点（S4 已裁定
    //   bug 无已暂缓），裁定后的格要测进去，不留"绕开"痕迹。bug 流无法真实到达已暂缓，用原子 SQL 造态
    //   直击 set-oa-number 的允许集判定（测的是判定本身，不是状态可达性）。
    {
      const cB = await create('bug');
      await run(`UPDATE sys_issues SET status='已暂缓' WHERE id=?`, [cB.body.id]);
      const rB = await setOa(cB.body.id, adminTok, '20260728666');
      assert.strictEqual(rB.status, 409, `[OA/bug×已暂缓] 应 409（bug 允许集无该态）, got ${rB.status} ${JSON.stringify(rB.body)}`);
      assert.strictEqual(rB.body.code, 'OA_NUMBER_STATUS_NOT_ALLOWED', '[OA/bug×已暂缓] 确切码');
    }
    ok('[OA] set-oa-number：feature/bug 各验——待受理拒 + 集外反例拒 + 集内正例 200 + 格式非法/number 400 + timeline 留痕 + 同值 no-op + ⭐权限矩阵（受理人/技术负责人/普通用户 403 零副作用·admin 对照 200）+ ⭐bug×已暂缓显式 409（裁定格测进）');
  }

  // ═══ [AS] assign 的 OA 前置守卫：变更流无号/空串/非法值 409 ASSIGN_REQUIRES_OA_NUMBER·有效号 200·
  //   bug 无号 200（不受限，D2）═══
  {
    // 变更流：无号（NULL）→ 409
    const f1 = await create('feature');
    await intakeAccept(f1.body.id);   // → 待指派，oa_number 仍 NULL
    const r1 = await assignCall(f1.body.id, adminTok, 5);
    assert.strictEqual(r1.status, 409, `[AS] 变更流无 OA 号 assign 应 409, got ${r1.status} ${JSON.stringify(r1.body)}`);
    assert.strictEqual(r1.body.code, 'ASSIGN_REQUIRES_OA_NUMBER', '[AS] 应为 ASSIGN_REQUIRES_OA_NUMBER');
    assert.strictEqual(await statusOf(f1.body.id), '待指派', '[AS] 409 后状态零变动');

    // 变更流：空串（原子 SQL 造脏值，绕过 set-oa-number 自身的校验）→ 409
    const f2 = await create('feature');
    await intakeAccept(f2.body.id);
    await run(`UPDATE sys_issues SET oa_number='' WHERE id=?`, [f2.body.id]);
    const r2 = await assignCall(f2.body.id, adminTok, 5);
    assert.strictEqual(r2.status, 409, `[AS] 变更流空串 OA 号 assign 应 409, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'ASSIGN_REQUIRES_OA_NUMBER', '[AS] 空串应为 ASSIGN_REQUIRES_OA_NUMBER');

    // 变更流：非法值（原子 SQL 造脏值）→ 409
    const f3 = await create('feature');
    await intakeAccept(f3.body.id);
    await run(`UPDATE sys_issues SET oa_number='OA-bad' WHERE id=?`, [f3.body.id]);
    const r3 = await assignCall(f3.body.id, adminTok, 5);
    assert.strictEqual(r3.status, 409, `[AS] 变更流非法 OA 号 assign 应 409, got ${r3.status} ${JSON.stringify(r3.body)}`);
    assert.strictEqual(r3.body.code, 'ASSIGN_REQUIRES_OA_NUMBER', '[AS] 非法值应为 ASSIGN_REQUIRES_OA_NUMBER');

    // 变更流：有效号 → 200
    const f4 = await create('feature');
    await intakeAccept(f4.body.id);
    const oa4 = await setOa(f4.body.id, adminTok, '2026070201');
    assert.strictEqual(oa4.status, 200, `[AS] 夹具补 OA 号 200, got ${oa4.status} ${JSON.stringify(oa4.body)}`);
    const r4 = await assignCall(f4.body.id, adminTok, 5);
    assert.strictEqual(r4.status, 200, `[AS] 变更流有效 OA 号 assign 应 200, got ${r4.status} ${JSON.stringify(r4.body)}`);
    assert.strictEqual(r4.body.status, '开发中', '[AS] assign 待指派→开发中');

    // bug：无号 → 200（不受限，D2）
    const b1 = await create('bug');
    await intakeAccept(b1.body.id);   // → 待处理，oa_number 仍 NULL
    const rb1 = await assignCall(b1.body.id, adminTok, 5);
    assert.strictEqual(rb1.status, 200, `[AS] bug 无 OA 号 assign 应 200（不受限）, got ${rb1.status} ${JSON.stringify(rb1.body)}`);
    assert.strictEqual(rb1.body.status, '处理中', '[AS] bug assign 待处理→处理中');

    // ⭐ 196 号线（用户手测抓出绕过·191 M 当时漏裁）：守卫下沉共享 helper 后，**三入口全测**——
    //   /assign 之外，dev-assignees POST 加成员与 reassign 批量新增在待指派族同样必须被拦。
    {
      const cD = await create('feature');
      await intakeAccept(cD.body.id);   // 待指派·无 OA
      const rAdd = await call('POST', `/api/sys-issues/${cD.body.id}/dev-assignees`, adminTok, { user_ids: [5] });
      assert.strictEqual(rAdd.status, 409, `[AS/加成员] 待指派无 OA 加成员应 409, got ${rAdd.status} ${JSON.stringify(rAdd.body)}`);
      assert.strictEqual(rAdd.body.code, 'ASSIGN_REQUIRES_OA_NUMBER', '[AS/加成员] 确切码');
      // reassign：变更流在 D_PRE 被**族闸先拦**（MEMBER_ACTION_FAMILY_TYPE_OVERRIDE 仅 DEV/VERIFY）——
      //   该入口对变更流待指派不可达=无绕过面（红灯诊断=断言写错：首版期望 OA 码，实为族闸 INVALID_STATUS）。
      //   本断言即"不可达哨兵"：若未来放开该族，红灯提醒同步评估 OA 守卫（守卫已防御性在位）。
      const rRe = await call('POST', `/api/sys-issues/${cD.body.id}/reassign`, adminTok, { member_ids: [5], reason: '探针' });
      assert.strictEqual(rRe.status, 409, `[AS/reassign] 变更流待指派 reassign 应 409, got ${rRe.status} ${JSON.stringify(rRe.body)}`);
      assert.strictEqual(rRe.body.code, 'INVALID_STATUS', '[AS/reassign] 族闸先拦（入口不可达哨兵·非 OA 维）');
      // 补号后放行（同单对照·证明 409 来自 OA 维非其他）
      await setOa(cD.body.id, adminTok, '20260728400');
      const rAdd2 = await call('POST', `/api/sys-issues/${cD.body.id}/dev-assignees`, adminTok, { user_ids: [5] });
      assert.strictEqual(rAdd2.status, 200, `[AS/加成员] 补号后应 200, got ${rAdd2.status} ${JSON.stringify(rAdd2.body)}`);
      // bug 对照：待处理加成员无 OA 直通
      const cB = await create('bug');
      await intakeAccept(cB.body.id);
      const rB = await call('POST', `/api/sys-issues/${cB.body.id}/dev-assignees`, adminTok, { user_ids: [5] });
      assert.strictEqual(rB.status, 200, `[AS/bug] 待处理无 OA 加成员应 200, got ${rB.status} ${JSON.stringify(rB.body)}`);
    }
    ok('[AS] assign OA 前置守卫（共享 helper）：**两个可达入口实测**（/assign NULL/空串/非法值 409+有效号 200·dev-assignees 加成员 409+补号 200 对照）+ **一个不可达入口哨兵**（reassign 变更流 D_PRE 被族闸先拦 INVALID_STATUS·守卫防御性在位未经路由级证明——196 增量审声称收窄）；bug 全入口不受限（D2）');
  }


  // ═══ [MI] P9（用户裁定尾巴·191 号建议）：[1a-9] 防御性迁移的幂等与安全面 ═══
  //   迁移跑在 runSysMigration（模块 init 期），harness 内无法重启模块——本组分两层：
  //   ① 源码存在性哨兵：index.js 必含该迁移语句原文（防"测试里复刻的 SQL 还在、生产代码里的已被删"）；
  //   ② 语句级实测：raw 造待商议行 → 执行同一语句 → 转换且 oa/其他列不动 → 复跑 changes=0（幂等）。
  {
    const fs2 = require('fs');
    const src = fs2.readFileSync(require('path').join(__dirname, '../routes/sys-iteration/index.js'), 'utf8');
    const MIG_SQL = "UPDATE sys_issues SET status = '待受理' WHERE status = '待商议'";
    assert.ok(src.includes(MIG_SQL), '[MI] 源码存在性哨兵：index.js 必含 [1a-9] 迁移语句原文');
    assert.ok(src.includes('[1a-9]'), '[MI] 迁移段标记 [1a-9] 在位');
    const cM = await create('feature');
    await run(`UPDATE sys_issues SET status='待商议' WHERE id=?`, [cM.body.id]);
    const before = await get('SELECT oa_number, title, intake_required FROM sys_issues WHERE id=?', [cM.body.id]);
    const m1 = await run(MIG_SQL);
    assert.strictEqual(m1.changes, 1, `[MI] 首跑应恰迁 1 行, got ${m1.changes}`);
    const after = await get('SELECT status, oa_number, title, intake_required FROM sys_issues WHERE id=?', [cM.body.id]);
    assert.strictEqual(after.status, '待受理', '[MI] 迁移落待受理');
    assert.strictEqual(after.oa_number, before.oa_number, '[MI] oa_number 不动');
    assert.strictEqual(after.title, before.title, '[MI] title 不动（抽查）');
    assert.strictEqual(after.intake_required, before.intake_required, '[MI] intake_required 不动');
    const m2 = await run(MIG_SQL);
    assert.strictEqual(m2.changes, 0, `[MI] 复跑 changes=0（幂等）, got ${m2.changes}`);
    ok('[MI] [1a-9] 迁移（P9）：源码存在性哨兵 + 待商议→待受理恰 1 行 + oa/title/intake 零触碰 + 复跑幂等 changes=0');
  }

  console.log(`\n✅ verify-sys-pre-discuss 全部通过（${passed} 组·C2.5 撤销哨兵 + issue_reject 权限矩阵 + 受理阻断 + 三边自动清 + OA 号生命周期 + assign OA 守卫）`);
  server.close(); db.close();
}

main().catch(e => { console.error('\n❌ verify-sys-pre-discuss 失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } db.close(); process.exit(1); });
