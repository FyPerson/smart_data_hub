// 验证脚本：系统迭代 bug 流状态机 + 端点（bug流_方案_20260702_v1.2 §2/§3/§8，Commit ①+② + 通知改造 v1.6 §2.3 C3b 退场）
//   用法：node scripts/verify-sys-bug-transitions.js
//
// 覆盖（真实 HTTP 端点 + 常量层双面）：
//   [M] meta/常量：bug 状态集 11 态（含受理门 + C6 新增「已关闭」终态·§6.5 + bug暂缓方案 20260803 v0.4
//       新增「已暂缓」·§4.1）/ 初始态 / 动作集恰好 24 个
//       （v1.6 §2.3 退场 set_release_flag/publish/confirm-online-norelease 三条 + 新增 assign-release-dev/
//       execute-release 两条上线编排 + 受理门 6 条 + set_scheduled_start + C6 新增 close/reopen 两条 +
//       bug暂缓方案新增 hold/resume 两条（原"有意省略暂缓"设计已推翻）；
//       仍无 评估三动作/scope_change/schedule）+ isDevWorkState 单元 +
//       REQUIRES_ASSIGNEE_STATUSES（含 [C6] 已关闭锁定）+ RELEASABLE_TYPES ② 恢复含 bug 铁证
//   [E] 端点链路：建单落待处理 → schedule 拒（前段裁剪）→ assign 直达处理中 → submit 闸门（缺 est/空 summary）
//       → estimate → submit → 待验证 → return（return_count++/清 est）→ 二轮 → accept → 待上线
//   [R] 上线两路径已退场（v1.6 §2.3 [C-1]）——LEGACY gate × bug/变更流双向矩阵：R1(set-release-flag)/
//       R3(confirm-online-norelease) 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED；R2(hotfix-publish)
//       [C3"全类型统一"后反向放行，见 R3反向]；R4(legacy /sys-releases/:id/publish) 对 release_type='bug'
//       字面量批次（脏库/手工改场景）+ 对"成员实际含 bug 但 release_type=NULL"的批次（R5g-b，H-1 收口）
//       两条防线仍一律拒绝，未变。R5(add-issues/remove-issues)：add-issues 对 bug 的独立闸门（bugIssueIds
//       恒 409 + needs_release=1 条件）已随双闸拆除整体删除（2026-07-29 主会话裁定选项 A，方案 v3.4
//       §5a/§5b），R5①/R5e/R5f/R5g-a 断言反转为"200 放行"，bug 现与 feature/improvement（R5d 同批/R5e 追加/
//       R5f 移空复用）完全同源零特殊分支；remove-issues 对 release_type='bug' 字面量批次的旧防御闸
//       [2026-07-30 用户拍板已删除]——C3 时标注"仅 hotfix-publish 建的 emergency 批次可能命中、递延处理"，
//       用户实测确认误伤（应急上线单永远无法移单）后收尾，R5⑤ 断言翻转为真实链路放行（见 [R5⑤翻转]）。
//       [C5 收口批·C3 遗留补做] 族别隔离
//       （"混批守卫"）已整体拆除（方案 §5a），R5d/R5f 断言反转为"release_type 不再回填"；新增混批放行端到端
//       用例（bug 经 hotfix-publish 建批次 + add-issues 追加 feature → deriveReleaseType 返回 mixed →
//       execute 真发布成功；双闸拆除后混批还多一条更直接的路径——普通批次 add-issues 一次性混选
//       [bug,feature]，见 R5①放行混选用例）。新 G3-G6 上线编排完整覆盖 + 越权矩阵见
//       verify-sys-release-orchestration.js。
//   [G] 旁路：issue_reject 仅前段 / reactivate 回待处理 / void 任意态 / reassign 两前置态
//   [A] 附件：bug 处理中 delivery 可传（isDevWorkState 放行）/ 待处理拒 409
//   [T→⑤放开] derive ① 临时闸已拆：feature→bug 派生 201（SYS_BUG_DERIVE_PENDING 不再触发）；bug 语境完整覆盖见 verify-sys-bug-derive.js。feasibility·blocked 端点对 bug 仍 409
//   [C] 变更流零回归 canary：feature 建单→schedule→assign 正常（assign expectedFrom=null 改动无回归）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-bug-transitions-secret';
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
const T = I.transitions;
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
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
const TOK_BY_USER_ID = { 5: devTok, 6: dev2Tok };

// C3（方案 §4.3 全文，301-M3 过渡夹具标注兑现）：本文件三处"驱动 execute 真发布"的过渡夹具统一改走
//   真实子表流——通用化处理两种起点：① 批次已有在册执行人（hotfix-publish 建单自带 [5,6]，本文件多
//   数场景）② 批次尚无在册执行人（普通 add-issues 建的批次，需先 PUT executors）。统一把所有 not_sent
//   在册行置 sent → 除 executorId 外逐个确认 → executorId 最后确认触发 R-GATE 真正发布。同款完整论述
//   见 verify-sys-release.js 的 publishRelease 定义处，此处不重复。
async function confirmAndPublish(relId, body, executorId = 5) {
  let rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  if (rows.length === 0) {
    const rSet = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [executorId, executorId === 5 ? 6 : 5] });
    if (rSet.status !== 200) return rSet;
    rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  }
  const myRow = rows.find(r => r.user_id === executorId);
  if (!myRow) throw new Error(`confirmAndPublish helper: executorId=${executorId} 不在 release ${relId} 的在册执行人子表中`);
  const notSentIds = rows.filter(r => r.notify_status !== 'sent').map(r => r.id);
  if (notSentIds.length > 0) {
    const ph = notSentIds.map(() => '?').join(',');
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id IN (${ph})`, notSentIds);
  }
  for (const r of rows) {
    if (r.user_id === executorId || r.exec_status === 'done') continue;
    const tok = TOK_BY_USER_ID[r.user_id] || jwt.sign({ id: r.user_id, username: `u${r.user_id}`, display_name: `占位${r.user_id}`, role: 'user' }, SECRET);
    // 303-M2（Opus 对抗审）：中间预确认不许静默吞——断言真成功且未提前触发发布，失败带上下文抛错。
    const rPre = await call('POST', `/api/sys-releases/${relId}/execute`, tok, { executor_row_id: r.id });
    if (rPre.status !== 200 || rPre.body.released !== false) {
      throw new Error(`confirmAndPublish helper: 预确认异常，relId=${relId} user_id=${r.user_id} row=${r.id} status=${rPre.status} body=${JSON.stringify(rPre.body)}`);
    }
  }
  const myTok = TOK_BY_USER_ID[executorId] || jwt.sign({ id: executorId, username: `u${executorId}`, display_name: `占位${executorId}`, role: 'user' }, SECRET);
  return call('POST', `/api/sys-releases/${relId}/execute`, myTok, { ...body, executor_row_id: myRow.id });
}

let server, port;
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// 手搓 multipart 上传（field=files，可带 attachment_type 文本域）
function upload(id, tok, filename, attachmentType) {
  return new Promise((resolve, reject) => {
    const boundary = '----vfy' + Date.now();
    const parts = [];
    if (attachmentType) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="attachment_type"\r\n\r\n${attachmentType}\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\nfake-bytes\r\n`);
    parts.push(`--${boundary}--\r\n`);
    const data = Buffer.from(parts.join(''), 'utf8');
    const req = http.request({ host: '127.0.0.1', port, path: `/api/sys-issues/${id}/attachments`, method: 'POST', headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': data.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// 2026-08-01：硬编码未来日期到期（ESTIMATE_BEFORE_ASSIGN 时限炸弹），改动态生成——远期字面量迟早到期，勿回退此写法
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);
const EST2 = futureEst(31);   // 二轮重估用，与 EST 区分（re-add 后二轮回填）

// 建 bug 单 → 指派到 devId，返回 id（处理中态）
async function seedBugToDev(devId = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'bug单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建 bug 单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  assert.strictEqual(r.status, 200, 'bug assign 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
// 建 bug 单 → 指派 → estimate → submit → accept，返回 id（待上线态，Commit② [R] 测试起点）
async function seedBugToReady(devId = 5, devTok2 = devTok) {
  const id = await seedBugToDev(devId);
  let r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok2, { dev_estimated_at: EST });
  assert.strictEqual(r.status, 200, `bug estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  // [B4b 全仓扫净] bug 单必填 bug_cause_note（C6 拍板生效后）——seedBugToReady 建的是 bug 单，会真过必填闸。
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-10' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions）' });
  assert.strictEqual(r.status, 200, `bug submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `bug accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(await statusOf(id), '待上线', 'seedBugToReady 应停在 待上线');
  return id;
}
// 走变更流（feature/improvement）全流程到待上线（[R] 批次族别测试用）
async function seedChangeToReady(type = 'feature', devId = 5, devTok2 = devTok) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type, title: type + '-mix', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：本 seed 专服务**变更流**（feature/improvement），建单直落「待受理」，
  //   无需再走预沟通段。bug 流的 seed 是 seedBugToReady，不含本步。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5，⭐ 用户拍板批1改造B后订正] feature/improvement 受理必带 risk_level，bug 不带（原"仅 feature 必带、improvement 不带"口径已随改造B废止）。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, (type === 'feature' || type === 'improvement') ? { risk_level: '二级' } : {});
  // 受理排期改造：schedule 退场——建单直落待指派，直接 assign。
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, `${type} 补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: devId });
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本 helper 服务批次族别/release-batch
  //   等下游测试（本文件是 bug 流验证，feature/improvement 只是拿来当批次混选 fixture），与「待对接
  //   测试」段本身无关（后者由专门的 verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时失效
  //   （模拟受理人后续停用/移出白名单），触发 §3.0-⑥ 降级路径，使 feature submit 仍直落"待验证"→可
  //   立即 accept 到"待上线"——本 helper 下游全部调用点零改动，这也是方案承认的合法真实场景（非造假）。
  //   improvement/bug 不受影响（未接决策树），此处统一处理不额外分 type 判断，简化维护。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  await call('POST', `/api/sys-issues/${id}/estimate`, devTok2, { dev_estimated_at: EST, estimated_effort_days: 1 });
  await call('POST', `/api/sys-issues/${id}/submit`, devTok2, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-11' }], self_tested: true, test_env_deployed: true });
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, `${type} accept 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return id;
}
const seedFeatureToReady = (devId = 5, devTok2 = devTok) => seedChangeToReady('feature', devId, devTok2);
async function statusOf(id) { return (await get('SELECT status FROM sys_issues WHERE id=?', [id])).status; }
async function rowOf(id) { return await get('SELECT * FROM sys_issues WHERE id=?', [id]); }
async function issueRowRelease(id) { return (await get('SELECT release_id FROM sys_issues WHERE id=?', [id])).release_id; }

async function main() {
  mod.initSchema();
  await waitReady();
  // users 表（assign 端点查 users 校验被指派人）；status 列（DEFAULT 'active'）：C3 后 hotfix-publish
  //   补排班后会真走到 hasReleaseEligibility(userId)（SELECT status, role FROM users），缺列即报错。
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(7,'viewer','观察员','viewer'),(13,'wangtaotao','示例对接人','user')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [M] meta / 常量层 ═══
  {
    const meta = T.buildMeta();
    // 受理排期改造 §4.1/§4.3：bug 状态集 7→9 态（加「待受理/待修改」受理门·bug 也走受理门·用户拍板）。
    // [C6·方案 v3.4 §6.5] 9→10 态：补「已关闭」归档终态（原"已上线即终态"设计作废）。
    // ⭐ [bug暂缓方案 20260803 v0.4 §4.1] 10→11 态：补「已暂缓」——bug 流原"无暂缓（有意省略）"设计已被本
    //   方案推翻，兑现 `bug流_方案_20260702_v1.0.md:68` 当年留的预留口子。顺序须与 transitions.js
    //   BUG_FLOW_STATUSES 实际声明顺序一致（statusLabels 直接透传 ALLOWED_STATUSES，非重排）。
    assert.deepStrictEqual(meta.statusLabels.bug, ['待受理', '待修改', '待处理', '处理中', '待验证', '待上线', '已上线', '已关闭', '已暂缓', '已拒绝', '已作废'], 'bug 状态集 11 态（含受理门 + C6 已关闭 + bug暂缓方案已暂缓）');
    // 受理排期改造 §9：initialStatusesByType 新形状（bug 受理→待受理·无受理→待处理）。
    assert.strictEqual(meta.initialStatusesByType.bug.with_intake, '待受理', 'bug 受理模式初始态=待受理');
    assert.strictEqual(meta.initialStatusesByType.bug.without_intake, '待处理', 'bug 无受理初始态=待处理');
    const bugActions = meta.typeFlows.bug.map(t => t.action).sort();
    // [v1.6 退场] set_release_flag/publish/confirm-online-norelease 移除，新增 assign-release-dev/execute-release。
    // 受理排期改造 §4.3：bug 也走受理门 → 加 6 个受理门动作（intake_accept/intake_return/resubmit_intake/edit_in_revision/request_tech_consult/change_intake_mode）+ set_scheduled_start（H2 bug 亦支持）→ 13+7=20 个。
    // [C6·方案 v3.4 §6.5] 20→22 个：新增 close/reopen（归档+重开，与变更流同构条目）。
    // ⭐ [bug暂缓方案 20260803 v0.4 §4.2] 22→24 个：新增 hold/resume（bug 流原"有意省略暂缓"设计已被本
    //   方案推翻，见下方 banned 清单同步更正）。
    assert.deepStrictEqual(bugActions,
      ['accept', 'assign', 'assign-release-dev', 'change_intake_mode', 'close', 'create', 'derive', 'edit_in_revision', 'estimate', 'execute-release',
       'hold', 'intake_accept', 'intake_return', 'issue_reject', 'reactivate', 'reassign', 'reopen', 'request_tech_consult', 'resubmit_intake',
       'resume', 'return', 'set_scheduled_start', 'submit', 'void'].sort(),
      `bug 动作集恰好 24 个（原 22 + bug暂缓方案新增 hold/resume），实际 ${bugActions.join(',')}`);
    // [C6 改造] close/reopen 已从"永久禁止"改为"合法新增"——banned 清单收窄，移出这两项（§6.5）。
    // ⭐ [bug暂缓方案 20260803 v0.4 §4.2·断言写错更正] 原断言锁定的是"bug typeFlows 不应含 hold/resume"——
    //   这条断言锁的是 bug 流"有意省略暂缓"这个已被本方案明确推翻的旧事实（`bug流_方案_20260702_v1.0.md:68`
    //   当年"有意省略"本就是留了将来补的口子，本方案兑现该口子）。继续断言"不应含"会把方案要新增的功能
    //   反过来锁死为 bug——故改为**正向断言应含**，与上方 bugActions 24 个的清单互相印证。
    for (const shouldContain of ['hold', 'resume']) {
      assert.ok(bugActions.includes(shouldContain), `bug typeFlows 应含 ${shouldContain}（bug暂缓方案 20260803 v0.4 §4.2 新增）`);
    }
    for (const banned of ['feasibility', 'blocked', 'unblock', 'scope_change', 'schedule',
      'set_release_flag', 'publish', 'confirm-online-norelease']) {
      assert.ok(!bugActions.includes(banned), `bug typeFlows 不应含 ${banned}`);   // v1.6 退场三动作 + ⑤ 后 derive 移出 banned；schedule 退场后 bug 亦无
    }
    const assignReleaseDevEntry = meta.typeFlows.bug.find(t => t.action === 'assign-release-dev');
    assert.strictEqual(assignReleaseDevEntry.kind, 'side_effect', 'assign-release-dev 应标 side_effect（不改 status，SIDE_EFFECT_ACTIONS 白名单）');
    const executeReleaseEntry = meta.typeFlows.bug.find(t => t.action === 'execute-release');
    assert.strictEqual(executeReleaseEntry.kind, 'transition', 'execute-release 应标 transition（真实改 status 为已上线）');
    assert.strictEqual(executeReleaseEntry.to, '已上线', 'execute-release meta.to=已上线');
    const deriveEntry = meta.typeFlows.bug.find(t => t.action === 'derive');   // ⑤：bug derive 仅从已上线 + side_effect（路由专用端点，非通用引擎）
    assert.deepStrictEqual(deriveEntry.from, ['已上线'], 'bug derive from 应恰为 [已上线]（§4 仅从已上线单派生）');
    assert.strictEqual(deriveEntry.kind, 'side_effect', 'derive 应标 side_effect（走 POST /derive 专用端点，不误入通用 transition）');
    // [C6] close/reopen 元数据形状断言——两者均真实改 status（kind='transition'，非旁路），reopen 的
    //   from 精确收窄为仅 ['已关闭']（附录 A：已上线未归档不可直接 reopen），to='处理中'（bug 的 DEV 族，
    //   与变更流 reopen 的 to='开发中' 对称、非共用同一常量）。
    const closeEntry = meta.typeFlows.bug.find(t => t.action === 'close');
    assert.strictEqual(closeEntry.kind, 'transition', '[C6] bug close 应标 transition（真实改 status）');
    assert.deepStrictEqual(closeEntry.from, ['已上线'], '[C6] bug close.from 应恰为 [已上线]');
    assert.strictEqual(closeEntry.to, '已关闭', '[C6] bug close.to=已关闭');
    const reopenEntry = meta.typeFlows.bug.find(t => t.action === 'reopen');
    assert.strictEqual(reopenEntry.kind, 'transition', '[C6] bug reopen 应标 transition（真实改 status）');
    assert.deepStrictEqual(reopenEntry.from, ['已关闭'], '[C6] bug reopen.from 应恰为 [已关闭]（收窄，不含已上线）');
    assert.strictEqual(reopenEntry.to, '处理中', '[C6] bug reopen.to=处理中（DEV 族，与变更流「开发中」对称）');
    // ACTION_LABELS 保留旧三动作标签（历史 timeline 行仍需渲染 action_code，v1.6 §2.3 明确要求不删标签）
    assert.strictEqual(meta.actions.set_release_flag, '填发版信息', 'set_release_flag 标签保留（历史 timeline 渲染）');
    assert.strictEqual(meta.actions['confirm-online-norelease'], '确认上线（不发版）', 'confirm-online-norelease 标签保留');
    assert.ok(meta.actions['assign-release-dev'] && meta.actions['execute-release'], '新增两动作标签存在');
    ok('meta：bug 状态集 11 态（含受理门待受理/待修改 + C6 已关闭 + bug暂缓方案已暂缓）+ 初始态新形状（受理→待受理/无受理→待处理）+ 动作集恰好 24（原 22 + bug暂缓方案新增 hold/resume）+ close/reopen 元数据形状正确（kind=transition/from/to）+ 现含 hold/resume·仍无评估三动作/scope_change/schedule + 旧标签保留供历史渲染');
  }
  {
    assert.strictEqual(T.isDevWorkState('bug', '处理中'), true, 'bug 处理中=开发工作态');
    assert.strictEqual(T.isDevWorkState('bug', '开发中'), false, 'bug 开发中≠工作态（态名按类型）');
    assert.strictEqual(T.isDevWorkState('feature', '开发中'), true);
    assert.strictEqual(T.isDevWorkState('feature', '处理中'), false);
    assert.strictEqual(T.isDevWorkState('config', '处理中'), false, 'config 未定义 → false（追加 config 流时补）');
    assert.strictEqual(T.isDevWorkState('bug', null), false, 'null status → false');
    assert.ok(T.REQUIRES_ASSIGNEE_STATUSES.includes('处理中') && T.REQUIRES_ASSIGNEE_STATUSES.includes('开发中'), 'RC-M5 全集含 处理中+开发中');
    assert.ok(!T.REQUIRES_ASSIGNEE_STATUSES.includes('待处理'), 'RC-M5 全集不含 待处理（未指派前段）');
    // [C6·方案 v3.4 §6.5] REQUIRES_ASSIGNEE_STATUSES 含「已关闭」以 verify 断言锁定（任务书明文要求）——
    //   该值已跨类型通用（非按 type 拆分的数组，见 transitions.js 该常量处注释），本断言钉死不因未来
    //   改动误删。
    assert.ok(T.REQUIRES_ASSIGNEE_STATUSES.includes('已关闭'), '[C6] RC-M5 全集含 已关闭（bug 补终态后仍须有 assigned_to）');
    ok('isDevWorkState 单元（bug=处理中/feature=开发中/config 未定义 false/null false）+ REQUIRES_ASSIGNEE_STATUSES 边界（含 [C6] 已关闭锁定）');
  }
  {
    assert.ok(I.RELEASABLE_TYPES.includes('bug'), '② 恢复：RELEASABLE_TYPES 含 bug（见 [R]）');
    assert.deepStrictEqual(I.RELEASABLE_TYPES, ['feature', 'improvement', 'bug'], 'RELEASABLE_TYPES=[feature,improvement,bug]');
    ok('⭐ ② 铁证：RELEASABLE_TYPES 恢复含 bug（[2026-07-29 双闸拆除] 曾在 add-issues/hotfix-publish/_publishReleaseCoreInTxn 三处同步落地的 needs_release=1 闸门已随本次双闸拆除全数删除，bug 现与其余可发布类型共用同一道 type IN RELEASABLE_TYPES 闸，见 [R]）');
  }
  {
    // KEY_COLS 锚点（[审:M1]）：readiness 与新列同源
    for (const c of ['needs_release', 'related_correction_no', 'fix_gap_note', 'dingtalk_chat_id']) {
      assert.ok(I.SYS_ISSUES_KEY_COLS.includes(c), `SYS_ISSUES_KEY_COLS 应含锚点 ${c}`);
    }
    assert.ok(I.SYS_RELEASES_KEY_COLS.includes('release_type'), 'SYS_RELEASES_KEY_COLS 应含 release_type');
    ok('readiness 锚点：needs_release/related_correction_no/fix_gap_note/dingtalk_chat_id + release_type 已入 KEY_COLS（[审:M1]）');
  }

  // ═══ [E] 端点正向链路 ═══
  let mainId;
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: '导出按钮报错', system_name: 'BMS', source: '业务方', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, requester_dept: '财务部', requester_name: '张三', requester_phone: '13800000000' });
    assert.strictEqual(r.status, 201, '建 bug 单 201');
    // ⭐ 角色权限重构 C0：受理门焊死（全类型必经）→ bug 建单落「待受理」，「待处理」改为受理通过后的落态。
    assert.strictEqual(r.body.status, '待受理', 'C0：bug 建单落 待受理（原直落待处理已是绕过受理门的缺口）');
    mainId = r.body.id;
    const iaMain = await call('POST', `/api/sys-issues/${mainId}/intake-accept`, adminTok, {});
    assert.strictEqual(iaMain.status, 200, '夹具受理 200, got ' + iaMain.status + ' ' + JSON.stringify(iaMain.body));
    assert.strictEqual(iaMain.body.status, '待处理', 'C0：bug 受理通过 → 待处理（与旧建单落态一致·下游链路断言不变）');
    const tl = await all('SELECT * FROM sys_issue_timeline WHERE issue_id=?', [mainId]);
    assert.strictEqual(tl[0].event_type, 'created', '建单写 created timeline');
    ok('建单：type=bug → 201 落「待处理」（前段裁剪，无评估/排期）+ created timeline + 报障人 requester_* 可选录入');
  }
  {
    const r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, needs_feasibility: 1 });
    assert.strictEqual(r.status, 400, 'bug + needs_feasibility=1 应 400');
    assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE');
    ok('建单守卫：bug 传 needs_feasibility=1 → 400 FEASIBILITY_NOT_APPLICABLE（评估环节不适用 bug，守卫实弹）');
  }
  {
    const r = await call('POST', `/api/sys-issues/${mainId}/schedule`, adminTok, {});
    // 受理排期改造：schedule 端点退场·恒返 409 SCHEDULE_DISABLED（早于 findTransition·比 INVALID_TRANSITION 更友好）。
    assert.strictEqual(r.status, 409, 'schedule 退场应 409');
    assert.strictEqual(r.body.code, 'SCHEDULE_DISABLED');
    ok('schedule 退场：任意 type schedule → 409 SCHEDULE_DISABLED');
  }
  {
    let r = await call('POST', `/api/sys-issues/${mainId}/assign`, devTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 403, '非 admin 指派应 403（① 白名单=④）');
    r = await call('POST', `/api/sys-issues/${mainId}/assign`, adminTok, { assigned_to: 7 });
    assert.strictEqual(r.status, 400, '指派 viewer 应 400');
    r = await call('POST', `/api/sys-issues/${mainId}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, 'bug assign 200');
    assert.strictEqual(r.body.status, '处理中', 'assign 直达 处理中');
    const row = await rowOf(mainId);
    assert.ok(row.assigned_at, 'assigned_at 盖时间');
    ok('指派：待处理 →assign→ 处理中（直达）+ 非 admin 403（对接人白名单=④）+ viewer 拒');
  }
  {
    // [C3 退场] 原"submit 闸门（缺 est → ESTIMATE_REQUIRED / 空 summary → SUBMIT_SUMMARY_REQUIRED）"随旧
    //   单人 summary 模型退场——新 submit（方案 §6.1/§6.2）不查 dev_estimated_at/summary。estimate 的"严格
    //   在册"仍保留，改走 W06/assertDevMember：非在册开发（dev2）→ 403 NOT_ROSTERED（语义同构于旧
    //   NOT_AUTHORIZED_FOR_TRANSITION，均为"actor 无权限"，故意不call submit 避免提前推进 mainId 状态，
    //   下方 [A] 附件区仍需 mainId 停在「处理中」）。
    let r = await call('POST', `/api/sys-issues/${mainId}/estimate`, dev2Tok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 403, '非在册 estimate 403（W06 assertDevMember）');
    r = await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: EST });
    assert.strictEqual(r.status, 200, '在册开发 estimate 200（bug 处理中态内回填）');
    ok('estimate 严格在册（W06 assertDevMember 替代旧 ownerGuard）：非在册 403 / 在册 200');
  }

  // ═══ [A] 附件（isDevWorkState 放行 bug 处理中）═══
  {
    let r = await upload(mainId, devTok, 'fix-evidence.png', 'delivery');
    assert.strictEqual(r.status, 200, `bug 处理中 delivery 上传应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.attachments.length, 1);
    ok('⭐ 附件：bug 单「处理中」开发本人可传 delivery（isDevWorkState 修复——旧硬编码「开发中」会 409 断链）');
    // 负向：待处理 bug 单（未指派）上传 → 403/409（守卫仍在）
    const r2 = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'x2', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const rUp = await upload(r2.body.id, devTok, 'x.png', 'delivery');
    assert.ok(rUp.status === 403 || rUp.status === 409, `待处理 bug 上传应拒, got ${rUp.status}`);
    ok('附件负向：待处理（非工作态/非本人）上传仍被拒（isDevWorkState 未放松守卫）');
  }

  {
    // 合法 submit → 待验证（C3：新 commit 事件模型，无 first_submitted_at/round_no timeline——
    //   这两个字段随旧单人 summary 模型退场，唯一在册开发 no_code 完成 → W-GATE 同事务转待验证）。
    // [B4b 全仓扫净] mainId 是 bug 单，bug 单必填 bug_cause_note（C6 拍板生效后）。
    const r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { mode: 'no_code', no_code_reason: '缺陷已修复（占位理由）', self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions）' });
    assert.strictEqual(r.status, 200, 'submit 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', 'submit → 待验证（W-GATE，main_status 字段，非旧 status）');
    const devEv = await get(`SELECT action, payload_json FROM sys_issue_dev_events WHERE issue_id=? AND action='no_code'`, [mainId]);
    assert.ok(devEv, 'sys_issue_dev_events 应有 1 条 no_code 事件（新事件模型落点）');
    ok('提交修复：处理中 →submit→ 待验证（W-GATE）+ no_code 事件落 sys_issue_dev_events（新模型，替代旧 timeline round_no）');
  }
  {
    // return（待验证→处理中，return_count++ 清 est）；打回原因必填
    let r = await call('POST', `/api/sys-issues/${mainId}/return`, adminTok, { reason: ' ' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RETURN_REASON_REQUIRED');
    r = await call('POST', `/api/sys-issues/${mainId}/return`, adminTok, { reason: '还是报错' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.status, '处理中');
    const row = await rowOf(mainId);
    assert.strictEqual(row.return_count, 1, 'return_count=1');
    assert.strictEqual(row.dev_estimated_at, null, '打回清 dev_estimated_at');
    ok('验收打回：待验证 →return→ 处理中 + return_count++ + 清 dev_estimated_at + 原因必填');
  }
  {
    // 二轮：return 后 roster 完成态残留在 no_code（return 只清主表 dev_estimated_at，不碰 dev_assignees 子表——
    //   §1 不变量1"完成态不回 pending"+§4.1"完成态互转/回 pending 禁止"，本例首次暴露：return 与多开发
    //   roster 完成态是两条独立不变量线，旧完成态实例不能原地复用重提）。协调人需：① 先加协作解除
    //   LAST_ASSIGNEE 限制（单开发不能直接 remove 自己）② remove 旧完成态实例 ③ re-add 同一开发（全新
    //   pending 实例，方案 §4.4）④ 两名在册开发都完成后 W-GATE 才转待验证。
    let r = await call('POST', `/api/sys-issues/${mainId}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, '临时加协作(6) 200, got ' + JSON.stringify(r.body));
    const oldDa = r.body.dev_assignees.find(d => d.user_id === 5);
    r = await call('DELETE', `/api/sys-issues/${mainId}/dev-assignees/${oldDa.id}`, adminTok, { reason: '二轮重置旧完成态实例' });
    assert.strictEqual(r.status, 200, 'remove 旧完成态实例 200, got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${mainId}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, 're-add(5) 200, got ' + JSON.stringify(r.body));
    await call('POST', `/api/sys-issues/${mainId}/estimate`, devTok, { dev_estimated_at: EST2 });
    // [B4b 全仓扫净] 二轮两名在册开发各自提交，bug 单逐人填 bug_cause_note（C6 拍板生效后）。
    r = await call('POST', `/api/sys-issues/${mainId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-13' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions·二轮-5）' });
    assert.strictEqual(r.status, 200, '二轮 submit(5) 200, got ' + JSON.stringify(r.body));
    r = await call('POST', `/api/sys-issues/${mainId}/submit`, dev2Tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-14' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions·二轮-6）' });
    assert.strictEqual(r.status, 200, '协作(6) submit 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', '全员完成 → W-GATE 转待验证');
    r = await call('POST', `/api/sys-issues/${mainId}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, 'accept 200, got ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.status, '待上线', 'accept → 待上线（W07 具名边，makeTransitionEndpoint 响应形未变）');
    assert.ok((await rowOf(mainId)).accepted_at, 'accepted_at 盖');
    ok('验收通过：二轮（扩容协作解除 LAST_ASSIGNEE + remove/re-add 重置完成态实例 + 全员完成 submit）→ accept → 待上线 + accepted_at（T-M1；C3：round_no/旧 timeline 模型断言随退场）');
  }

  // ═══ [D] 待上线态下三个动作均无有效边（②/C6/bug暂缓方案之后依然如此，非本次范围）═══
  {
    // ⭐ [bug暂缓方案 20260803 v0.4 §4.1/§4.2 更正] hold 现已是 bug 的合法动作（from: ['处理中']），
    //   "对 bug 恒无 transition（有意省略）"的旧表述已失效——但「待上线」不在 hold.from 内，故本节验证的
    //   仍是同一个结论（400 INVALID_TRANSITION），只是理由从"动作不存在"变为"当前前置态非法"，与
    //   close/reopen 的理由（动作存在但 from 不含待上线）现已完全同构。
    for (const [ep, code] of [['close', 'INVALID_TRANSITION'], ['hold', 'INVALID_TRANSITION'], ['reopen', 'INVALID_TRANSITION']]) {
      const rr = await call('POST', `/api/sys-issues/${mainId}/${ep}`, adminTok, { reason: 'x' });
      assert.strictEqual(rr.status, 400, `bug ${ep} 应 400`);
      assert.strictEqual(rr.body.code, code, `bug ${ep} → ${code}`);
    }
    assert.strictEqual(await statusOf(mainId), '待上线', 'mainId 未被本节改动，仍停在 待上线');
    ok('待上线态：close/hold/reopen 对 bug 均无有效边 → 400（三者现均是合法动作但各自 from 不含待上线，hold 从"不存在"改为"前置态非法"同构于 close/reopen，C6+bug暂缓方案后仍零回归）');
  }

  // ═══ [R] 上线两路径已退场（v1.6 §2.3 [C-1]，通知改造 C3b）——LEGACY gate × bug/变更流双向矩阵 ═══
  //   R1/R2/R3 三个旧直连端点仍对 bug 一律 LEGACY_RELEASE_FLOW_DISABLED（R2 已反向放行，见 R3反向）；
  //   R4（legacy publish）/remove-issues 对 release_type='bug' 字面量批次的独立防线未变（本次任务范围外）。
  //   [2026-07-29 双闸拆除] R5（add-issues）对 bug 的独立闸门已整体拆除——bug 现与
  //   **变更流(feature/improvement)完全同源零行为变化**：同一批 R5d/R5e/R5f/R5g 变更流场景原样保留断言
  //   不变，"加入 bug"的收尾从"应被 LEGACY 挡"反转为"同样放行"（R5①/R5e/R5f/R5g-a）。
  //   新 G3-G6 上线编排流程（assign-release-dev/reassign-release-dev/execute-release）+ 越权矩阵见
  //   独立脚本 verify-sys-release-orchestration.js（聚焦编排流程本身，本文件聚焦"旧入口关严实"）。
  {
    // R1 退场（C3 升级）：set-release-flag 全类型 410 Gone（不再是 409 LEGACY_RELEASE_FLOW_DISABLED——
    //   C3 把本端点从"业务前置条件不满足"收窄为"端点资源已永久移除"，语义更准确，见 index.js 路由处注释）。
    const r1 = await seedBugToReady(5, devTok);
    let r = await call('POST', `/api/sys-issues/${r1}/set-release-flag`, devTok, { needs_release: 1 });
    assert.strictEqual(r.status, 410, `[R1退场] bug set-release-flag 应 410 Gone, got ${r.status}`);
    assert.strictEqual(r.body.code, 'ENDPOINT_GONE', '[R1退场] code=ENDPOINT_GONE');
    assert.strictEqual((await rowOf(r1)).needs_release, null, '[R1退场] needs_release 未被写入（列转只读残留，F5）');
    const midBug = await seedBugToDev(5);   // 处理中态（非待上线），同样应 410（不因状态不同而有别——端点整体已移除）
    r = await call('POST', `/api/sys-issues/${midBug}/set-release-flag`, adminTok, { needs_release: 1 });
    assert.strictEqual(r.status, 410); assert.strictEqual(r.body.code, 'ENDPOINT_GONE', '[R1退场] 处理中态 bug 同样 410（非 SET_RELEASE_FLAG_STATUS_INVALID，端点已整体移除不再看 status）');
    ok('[R1退场→C3 升级为 410] set-release-flag：全类型 410 Gone（ENDPOINT_GONE），needs_release 不再被写入');

    // R2 退场：confirm-online-norelease 对 bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED
    const r2 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${r2}/confirm-online-norelease`, adminTok, {});
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R2退场] code');
    assert.strictEqual(await statusOf(r2), '待上线', '[R2退场] 拒绝后单仍停在待上线（未被误翻已上线）');
    ok('[R2退场] confirm-online-norelease：bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED，单未被误翻已上线');

    // [R3 反向：C3"全类型统一"] hotfix-publish 现**放行** bug——旧"bug 一律 409 LEGACY_RELEASE_FLOW_DISABLED"
    //   随上线体统一重构 C3 撤销（附录A明文类型一律 RELEASABLE_TYPES=bug/feature/improvement，config 单独
    //   负例；hotfix-publish 不再对 bug 特殊拒绝，见 index.js 路由处注释）。断言改为：bug 可成功建应急单，
    //   响应=200（非 201，C3 响应契约收窄为"返回即已安排"）+ created_new=true；单本身仍停在「待上线」（真正
    //   翻已上线要等被通知的值班执行人调用 /execute，两阶段语义，见方案 §6.7）。
    const r3 = await seedBugToReady(5, devTok);
    // [C3 裁定修正 2026-07-29] 抢占失败（当日无在册值班人）现回滚+409（不再是"200+not_sent 悬单"），
    //   本用例验证目标是"bug 类型放行"本身，非闸门分支——[C2b] 排班表已与本端点脱钩（不再自动查排班定
    //   人），下方 INSERT 保留仅作历史遗留 no-op（不影响本用例，未删是因为不属于本次改造范围内的清理项）；
    //   走通①全链改靠传 executors[5,6]（同 PUT executors 闸②③同码）。
    await run(`INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (date('now','localtime'), 5, '开发王', 1, '管理员')`);
    r = await call('POST', `/api/sys-issues/${r3}/hotfix-publish`, adminTok, { release_note: '修复上线', version_tag: 'v9.9', executors: [5, 6] });
    assert.strictEqual(r.status, 200, `[R3反向] bug hotfix-publish 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.created_new, true, '[R3反向] created_new=true（首次调用真建单）');
    assert.ok(r.body.release_id, '[R3反向] release_id 非空（已建应急单）');
    assert.strictEqual(await statusOf(r3), '待上线', '[R3反向] 单仍停在待上线（两阶段语义，真正发布要等值班执行人 /execute）');
    const r3RelKind = await get('SELECT release_kind, release_type FROM sys_releases WHERE id=?', [r.body.release_id]);
    assert.strictEqual(r3RelKind.release_kind, 'emergency', '[R3反向] 建的批次 release_kind=emergency');
    assert.strictEqual(r3RelKind.release_type, 'bug', '[R3反向] 批次族别按成员类型回填=bug');
    ok('[R3反向·全类型统一] hotfix-publish：bug 现与其他类型一视同仁，可成功建应急单（200+created_new=true+release_kind=emergency），单停在待上线等值班执行人执行');

    // [R5①放行·2026-07-29 双闸拆除] add-issues 现同样放行任意 bug 单——bugIssueIds 恒 409 闸门 +
    //   needs_release=1 条件已一并拆除（2026-07-29 主会话裁定选项 A，方案 v3.4 §5a/§5b），bug 与
    //   feature/improvement 完全同源，仅剩 type IN RELEASABLE_TYPES 一道闸（config 除外）。
    const r5Bug = await seedBugToReady(5, devTok);
    const relForBug = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relForBug}/add-issues`, adminTok, { issue_ids: [r5Bug] });
    assert.strictEqual(r.status, 200, `[R5①放行] add-issues 单条 bug 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 1, '[R5①放行] count=1');
    assert.strictEqual((await issueRowRelease(r5Bug)), relForBug, '[R5①放行] bug 已挂入批次');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relForBug])).release_type, null, '[R5①放行] 批次 release_type 仍 NULL（add-issues 从不写这一列，C5 起族别回填机制已整体删除）');
    ok('[R5①放行] add-issues：任意 bug 单现与 feature/improvement 同源放行（200，仅剩可发布类型闸），双闸拆除后零特殊拒绝');

    // [R5①放行（混选）·2026-07-29 双闸拆除] 一次加入 [bug, feature] → 同批成功，两单均挂入（族别隔离
    //   已随 C5"混批守卫"拆除、bug 双闸本次一并拆除，add-issues 层面 bug/feature/improvement 可任意
    //   同批混入，deriveReleaseType 会把这种批次判为 mixed，§6.9 合法派生值）。
    const r5MixBug = await seedBugToReady(5, devTok);
    const r5MixFeature = await seedFeatureToReady(5, devTok);
    const relMix2 = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relMix2}/add-issues`, adminTok, { issue_ids: [r5MixBug, r5MixFeature] });
    assert.strictEqual(r.status, 200, `[R5①放行] 混选 bug+feature 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 2, '[R5①放行] 混选 count=2');
    assert.strictEqual((await issueRowRelease(r5MixBug)), relMix2, '[R5①放行] bug 已挂入');
    assert.strictEqual((await issueRowRelease(r5MixFeature)), relMix2, '[R5①放行] feature 已挂入');
    ok('[R5①放行] add-issues 混选 [bug,feature]：整批 200 一次性挂入（双闸拆除后 bug 不再被单独摘出拒绝，原子性不变——全成而非全败）');

    // ═══ [R5①放行·端到端] bug（不再需要 needs_release）经 add-issues 进普通批次 → PUT executors + 行级
    //   通知 → execute → 已上线；与 feature 走**同一条统一路径**，断言两者结果同构（Task C 核对结论：
    //   行级通知/execute/getReleaseMembers/deriveReleaseType 均不读 sys_issues.type 做任何 bug 专属
    //   分支，故本用例并列驱动 bug/feature 两条批次，逐项比对响应形状与终态，而非只测 bug 单独过。
    //   [C4b 退场改写] 原批次级 POST .../notify-executor 端点已随批次级单执行人通知机制整体退场删除
    //   （H1 根治）——改用 PUT executors + 行级通知端点 POST .../executors/:userId/notify，两批次各自
    //   走同一套行级实现，比对响应字段集合的核心断言意图不变。 ═══
    {
      const e2eBug = await seedBugToReady(5, devTok);
      const e2eFeat = await seedFeatureToReady(5, devTok);
      const relBugE2E = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
      const relFeatE2E = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
      let rAdd = await call('POST', `/api/sys-releases/${relBugE2E}/add-issues`, adminTok, { issue_ids: [e2eBug] });
      assert.strictEqual(rAdd.status, 200, `端到端：bug add-issues 应 200, got ${rAdd.status} ${JSON.stringify(rAdd.body)}`);
      rAdd = await call('POST', `/api/sys-releases/${relFeatE2E}/add-issues`, adminTok, { issue_ids: [e2eFeat] });
      assert.strictEqual(rAdd.status, 200, `端到端：feature add-issues 应 200, got ${rAdd.status} ${JSON.stringify(rAdd.body)}`);

      // 执行人选定（PUT executors，新权威路径——不再需要计划上线日期/排班表，那是已删除的批次级
      //   notify-executor 才有的"查排班自动定人"语义，行级机制下执行人由 admin 显式指定）。
      let rSetBug = await call('PUT', `/api/sys-releases/${relBugE2E}/executors`, adminTok, { user_ids: [5, 6] });
      assert.strictEqual(rSetBug.status, 200, `端到端：bug PUT executors 应 200, got ${rSetBug.status} ${JSON.stringify(rSetBug.body)}`);
      let rSetFeat = await call('PUT', `/api/sys-releases/${relFeatE2E}/executors`, adminTok, { user_ids: [5, 6] });
      assert.strictEqual(rSetFeat.status, 200, `端到端：feature PUT executors 应 200, got ${rSetFeat.status} ${JSON.stringify(rSetFeat.body)}`);

      // 行级通知（真实 HTTP 端点，非 raw SQL 抢占捷径）：两批次各自独立走同一内部服务
      //   （preemptReleaseExecutorNotifySend + sendReleaseExecutorNotifyAndWriteback），对 5 号发送。
      let rNotifyBug = await call('POST', `/api/sys-releases/${relBugE2E}/executors/5/notify`, adminTok, {});
      assert.strictEqual(rNotifyBug.status, 200, `端到端：bug 行级通知应 200, got ${rNotifyBug.status} ${JSON.stringify(rNotifyBug.body)}`);
      assert.strictEqual(rNotifyBug.body.notify_status, 'sent', '端到端：bug 5 号行通知状态=sent');
      let rNotifyFeat = await call('POST', `/api/sys-releases/${relFeatE2E}/executors/5/notify`, adminTok, {});
      assert.strictEqual(rNotifyFeat.status, 200, `端到端：feature 行级通知应 200, got ${rNotifyFeat.status} ${JSON.stringify(rNotifyFeat.body)}`);
      assert.strictEqual(rNotifyFeat.body.notify_status, 'sent', '端到端：feature 5 号行通知状态=sent');
      assert.deepStrictEqual(Object.keys(rNotifyBug.body).sort(), Object.keys(rNotifyFeat.body).sort(), '端到端：行级通知响应字段集合 bug/feature 完全一致（同一实现，零 type 分支）');

      // 执行上线（execute）：两批次已有在册执行人子表（5 号已 sent），confirmAndPublish 内部据此跳过
      //   自建 PUT executors，把 6 号标记 sent 后各自确认（301-M3 过渡夹具兑现）。
      let rExecBug = await confirmAndPublish(relBugE2E, { release_note: '端到端 bug 真发布', version_tag: 've2e-bug' });
      assert.strictEqual(rExecBug.status, 200, `端到端：bug execute 应 200, got ${rExecBug.status} ${JSON.stringify(rExecBug.body)}`);
      let rExecFeat = await confirmAndPublish(relFeatE2E, { release_note: '端到端 feature 真发布', version_tag: 've2e-feat' });
      assert.strictEqual(rExecFeat.status, 200, `端到端：feature execute 应 200, got ${rExecFeat.status} ${JSON.stringify(rExecFeat.body)}`);
      assert.deepStrictEqual(Object.keys(rExecBug.body).sort(), Object.keys(rExecFeat.body).sort(), '端到端：execute 响应字段集合 bug/feature 完全一致（同一实现，零 type 分支）');

      assert.strictEqual(await statusOf(e2eBug), '已上线', '端到端：bug 单真实翻已上线');
      assert.strictEqual(await statusOf(e2eFeat), '已上线', '端到端：feature 单真实翻已上线');
      const relBugRow = await get('SELECT status, version_tag FROM sys_releases WHERE id=?', [relBugE2E]);
      const relFeatRow = await get('SELECT status, version_tag FROM sys_releases WHERE id=?', [relFeatE2E]);
      assert.strictEqual(relBugRow.status, '已发布', '端到端：bug 批次已发布');
      assert.strictEqual(relFeatRow.status, '已发布', '端到端：feature 批次已发布');
      assert.strictEqual(relBugRow.version_tag, 've2e-bug', '端到端：bug 批次 version_tag 落库');
      assert.strictEqual(relFeatRow.version_tag, 've2e-feat', '端到端：feature 批次 version_tag 落库');

      // deriveReleaseType 端到端：两批次各自单一族别（非 mixed），与 feature 完全同构（同一函数、同一判据）。
      const gmBug = await I.getReleaseMembers({ id: relBugE2E, status: '已发布' });
      const gmFeat = await I.getReleaseMembers({ id: relFeatE2E, status: '已发布' });
      assert.strictEqual(I.deriveReleaseType(gmBug).category, 'single', '端到端：bug 批次 deriveReleaseType=single');
      assert.strictEqual(I.deriveReleaseType(gmBug).type, 'bug', '端到端：bug 批次 type=bug');
      assert.strictEqual(I.deriveReleaseType(gmFeat).category, 'single', '端到端：feature 批次 deriveReleaseType=single');
      assert.strictEqual(I.deriveReleaseType(gmFeat).type, 'feature', '端到端：feature 批次 type=feature');

      ok('⭐ [R5①放行·端到端] bug（不再需要 needs_release）经 add-issues 进普通批次 → PUT executors + 行级通知 → execute → 已上线，与 feature 走同一条统一路径产生完全同构的结果（行级通知/execute 响应字段集合相同 + 批次终态相同 + deriveReleaseType 均为 single，零 bug 专属分支）');
    }

    // [C5 收口批·C3 遗留补做] ⭐ R5d 改造：feature + improvement 同批仍应成功（这条本就与"混批守卫"无关，
    //   feature/improvement 同属'change'族，从未被拒绝过）——唯一变化是 release_type 不再被 add-issues
    //   回填（族别隔离整体拆除，落地机制 famClause+首次落定回填一并删除，见 index.js add-issues 处注释），
    //   故断言从"回填=change"改为"仍为 NULL（不再写这一列）"。
    const chFeat = await seedChangeToReady('feature', 5, devTok);
    const chImpr = await seedChangeToReady('improvement', 5, devTok);
    const relChange = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chFeat, chImpr] });
    assert.strictEqual(r.status, 200, `feature+improvement 同批应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.count, 2);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relChange])).release_type, null, '[C5改造] add-issues 不再回填 release_type（族别隔离机制整体拆除，非"回填成 change"）');
    assert.strictEqual((await issueRowRelease(chFeat)), relChange, 'feature 已挂批次');
    assert.strictEqual((await issueRowRelease(chImpr)), relChange, 'improvement 已挂批次');
    ok('⭐ R5d[C5改造]：feature + improvement 同批成功（本身与混批守卫无关，从未被拒绝）——release_type 不再被回填，仍为 NULL');

    // [R5e 放行·2026-07-29 双闸拆除] 批次追加 improvement 成功（与族别隔离无关，未变）；追加 bug 现同样
    //   成功（原"add-issues 对 bug 整体不可用"闸门本次随 bugIssueIds/needs_release 双闸一并拆除）。
    const chImpr2 = await seedChangeToReady('improvement', 5, devTok);
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [chImpr2] });
    assert.strictEqual(r.status, 200, `批次追加 improvement 应 200, got ${r.status}`);
    const bugForChange = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relChange}/add-issues`, adminTok, { issue_ids: [bugForChange] });
    assert.strictEqual(r.status, 200, `[R5e 放行] 批次加 bug 经 add-issues 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await issueRowRelease(bugForChange)), relChange, '[R5e 放行] bug 已挂入原变更流批次（混族别成功）');
    ok('R5e[双闸拆除]：批次追加 improvement 成功（未变）+ 追加 bug 经 add-issues 同样成功（原独立闸门本次拆除，批次变为 bug+feature+improvement 混族别）');

    // [C5 收口批·C3 遗留补做 + 2026-07-29 双闸拆除] ⭐ R5f 改造：批次移空后 release_type 复位 NULL
    //   （remove-issues 的 F-4 复位逻辑本批未动，逐字保留）——由于 add-issues 不再回填 release_type，
    //   复用时 release_type 恒保持 NULL，不再有"改判"这回事；双闸拆除后"任意类型（含 bug）均可占用"
    //   是完整新语义，不再有"仅限非 bug"这一例外。
    const relReset = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const rf = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, null, '[C5改造] 加 feature 后 release_type 仍 NULL（不再回填）');
    r = await call('POST', `/api/sys-releases/${relReset}/remove-issues`, adminTok, { issue_ids: [rf] });
    assert.strictEqual(r.status, 200, 'remove 200');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, null, 'F-4：批次移空后 release_type 复位 NULL（remove-issues 逻辑本身未动，此处恒为 NULL 的 no-op 复位）');
    const improvementReuse = await seedChangeToReady('improvement', 5, devTok);
    r = await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [improvementReuse] });
    assert.strictEqual(r.status, 200, `移空后的批次可被 improvement 重新占用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relReset])).release_type, null, '[C5改造] 复用后 release_type 仍 NULL（不再"改判"，本就没有族别可判）');
    // [R5f 放行·双闸拆除] 同一批次再追加 bug（经 add-issues）→ 200 一并放行，bug 与 improvement 混族别共存于同一批次。
    const bugTryReuse = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relReset}/add-issues`, adminTok, { issue_ids: [bugTryReuse] });
    assert.strictEqual(r.status, 200, `[R5f 放行] 移空后批次追加 bug 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await issueRowRelease(bugTryReuse)), relReset, '[R5f 放行] bug 已挂入（与 improvementReuse 混族别共存于同一批次）');
    ok('⭐ R5f[双闸拆除]（F-4）：批次移空 → release_type 复位 NULL（remove-issues 逻辑未动）→ 可被任意类型（含 bug）重新占用/追加，双闸拆除后不再有"仅限非 bug"这一例外');

    // ═══ [C5 收口批·Group 2] 混批放行端到端：bug + feature 真实同批 → deriveReleaseType 返回 mixed → execute 真发布 ═══
    //   [2026-07-29 双闸拆除后更正] 本组建立混批的方式仍是"批次已有 bug 成员（经 hotfix-publish 单条建立），
    //   admin 再用 add-issues 追加非 bug 成员"——这是"全类型统一"落地当时（C5）就已可达的路径。双闸拆除
    //   后，混批还多了一条更直接的路径：普通批次用 add-issues 一次性混选 [bug, feature]（见上方 R5①放行
    //   混选用例）。两条路径殊途同归，本组继续保留 hotfix-publish 起手这条，兼顾覆盖 hotfix-publish 建单
    //   本身的行为（release_kind=emergency）。
    {
      const mixBug = await seedBugToReady(5, devTok);
      const rHf = await call('POST', `/api/sys-issues/${mixBug}/hotfix-publish`, adminTok, { release_note: '混批测试建单', executors: [5, 6] });
      assert.strictEqual(rHf.status, 200, `混批测试：hotfix-publish 建单应 200, got ${rHf.status} ${JSON.stringify(rHf.body)}`);
      const mixRelId = rHf.body.release_id;
      assert.ok(mixRelId, '混批测试：release_id 非空（hotfix-publish 恒建批次）');

      const mixFeature = await seedChangeToReady('feature', 5, devTok);
      const rAddMix = await call('POST', `/api/sys-releases/${mixRelId}/add-issues`, adminTok, { issue_ids: [mixFeature] });
      assert.strictEqual(rAddMix.status, 200, `[混批放行] 已含 bug 成员的批次追加 feature 应 200（族别隔离已拆除）, got ${rAddMix.status} ${JSON.stringify(rAddMix.body)}`);
      assert.strictEqual((await issueRowRelease(mixFeature)), mixRelId, '混批测试：feature 单已挂进含 bug 成员的批次');

      // deriveReleaseType 端到端：members 里同时含 bug/feature → mixed（非 §6.9 明文合法派生值的实证）。
      const gmMix = await I.getReleaseMembers({ id: mixRelId, status: '计划中' });
      const derivedMix = I.deriveReleaseType(gmMix);
      assert.strictEqual(gmMix.members.length, 2, '混批测试：getReleaseMembers 读到 2 个成员（bug+feature）');
      const memberTypesMix = new Set(gmMix.members.map(m => m.type));
      assert.ok(memberTypesMix.has('bug') && memberTypesMix.has('feature'), `混批测试：成员类型集合应同时含 bug/feature，实得 ${JSON.stringify([...memberTypesMix])}`);
      assert.strictEqual(derivedMix.category, 'mixed', `[混批放行端到端] deriveReleaseType 应返回 mixed，实得 ${JSON.stringify(derivedMix)}`);
      assert.strictEqual(derivedMix.type, null, '[混批放行端到端] mixed 态 type=null');

      // execute 真发布：混批也能真实发布——C3 新模型，本批次在册执行人是 hotfix-publish 建单时写入的
      //   [5,6]，confirmAndPublish 统一走真实子表流（301-M3 过渡夹具兑现）。
      const rExecMix = await confirmAndPublish(mixRelId, { release_note: '混批真发布' });
      assert.strictEqual(rExecMix.status, 200, `[混批放行端到端] execute 真发布应 200（发布事务内族别一致性检查已拆除，不再因混批被拦）, got ${rExecMix.status} ${JSON.stringify(rExecMix.body)}`);
      assert.strictEqual(await statusOf(mixBug), '已上线', '混批测试：bug 单真实翻已上线');
      assert.strictEqual(await statusOf(mixFeature), '已上线', '混批测试：feature 单真实翻已上线');
      // 发布后 getReleaseMembers 走 snapshot 源，deriveReleaseType 应仍稳定返回 mixed（发布前后口径一致）。
      const relRowMix = await get('SELECT status FROM sys_releases WHERE id=?', [mixRelId]);
      assert.strictEqual(relRowMix.status, '已发布', '混批测试：批次真实转已发布');
      const gmMixAfter = await I.getReleaseMembers({ id: mixRelId, status: '已发布' });
      assert.strictEqual(gmMixAfter.source, 'snapshot', '混批测试：发布后 getReleaseMembers 走 snapshot 源');
      const derivedMixAfter = I.deriveReleaseType(gmMixAfter);
      assert.strictEqual(derivedMixAfter.category, 'mixed', '混批测试：发布后 deriveReleaseType 仍稳定返回 mixed（快照 payload 里的 type 字段逐字保留，读源切换不影响派生结果）');

      ok('[C5 收口批·Group 2 端到端] 混批放行：hotfix-publish 建的 bug 批次可被 add-issues 追加 feature 成员（族别隔离已拆除，409 RELEASE_TYPE_MISMATCH/MIXED_TYPE_BATCH 不再触发）→ getReleaseMembers 正确读到两个成员 → deriveReleaseType 返回 mixed（§6.9 合法派生值实证）→ execute 真实发布成功，两单均翻已上线，发布前后 mixed 判定稳定');
    }

    // ⭐ R5g（F-2 / codex M-2，变更流零行为变化）：历史 release_type=NULL 非空批次场景（模拟 Commit② 前遗留态）
    const relHist = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    const histFeat = await seedChangeToReady('feature', 5, devTok);
    await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histFeat] });   // C5 起 add-issues 不再回填 release_type，加单本身不影响其取值
    await run('UPDATE sys_releases SET release_type=NULL WHERE id=?', [relHist]);   // DB 直改还原「有成员但 release_type=NULL」历史态（C5 后对新库路径已是 no-op，保留只为不依赖该前提、显式钉死前置条件）
    // (a) [R5g-a 放行·2026-07-29 双闸拆除] add-issues 加 bug 单现同样成功——bug 检测已不存在，与 feature/improvement 完全同源。
    const histBug = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${relHist}/add-issues`, adminTok, { issue_ids: [histBug] });
    assert.strictEqual(r.status, 200, `[R5g-a 放行] 历史 NULL 批次加 bug 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await issueRowRelease(histBug)), relHist, '[R5g-a 放行] bug 已挂入历史 NULL 批次（与 histFeat 混族别共存）');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [relHist])).release_type, null, '[R5g-a 放行] release_type 仍 NULL（add-issues 从不写这一列，未被误回填）');
    ok('R5g-a[双闸拆除]：历史 NULL 批次 add-issues 加 bug 单 → 200（原独立闸门已拆除，批次现真实持有 feature+bug 混族别成员，供下方 (b) 验证 legacy /publish 端点的深层防线）');
    // (b) [H-1 收口·codex40，独立于本次 add-issues 双闸拆除] publish 对"成员含 bug 族别"的历史 NULL 批次
    //   仍 fail-closed（这条防线本身语义未变）：codex40 HIGH 当初指出 R4 端点只查存量 release_type='bug'
    //   字面量会漏"release_type IS NULL 但成员实际含 bug"的这类批次，直发即绕过执行权；收口=
    //   publishReleaseTransition（R4 唯一 wrapper）改按**成员实际族别**拦截，不看 release_type 字面量。
    //   relHist 经上方 (a) 已是真实的"release_type=NULL + 含 bug 成员"批次——双闸拆除后这本身就是 add-issues
    //   的合法可达状态（非脏库/历史残留），不再需要额外 DB 强塞模拟，直接验证 legacy /publish 端点对它
    //   仍 fail-closed 即可。内核 family 一致性检查逐字保留（不动核内），现被 H-1 外层闸遮蔽、成为更深一层
    //   纵深防线——见 verify-sys-release-orchestration.js [H-1] 纯 bug NULL 批次同拒用例。
    r = await call('POST', `/api/sys-releases/${relHist}/publish`, adminTok, { release_note: '含 bug 测试', version_tag: 'vmix' });
    assert.strictEqual(r.status, 409, `含 bug 的 NULL 批次 publish 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R5g-b·H-1收口] 成员含 bug 的历史 NULL 批次 publish → LEGACY（publishReleaseTransition 按成员族别拦，早于核内 mismatch，与 add-issues 双闸拆除无关，独立防线未变）');
    assert.strictEqual(await statusOf(histFeat), '待上线', 'publish 拒后 histFeat 未被翻已上线（原子回滚）');
    assert.strictEqual(await statusOf(histBug), '待上线', 'publish 拒后 histBug 未被翻已上线（原子回滚）');
    ok('R5g-b（H-1 收口，双闸拆除后仍有效）：历史 NULL 批次含 bug 成员 publish → 409 LEGACY_RELEASE_FLOW_DISABLED（R4 wrapper 按成员实际族别 fail-closed，堵住脏 bug 批次绕执行权直发；核内 family 检查保留为更深纵深防线；这条防线独立于 add-issues 层面的 bug 双闸，故双闸拆除不影响它）');

    // [R4 退场] legacy /sys-releases/:id/publish 对 release_type='bug' 批次一律 409（正常路径下批次不可能是 bug 族别，
    //   因 add-issues 已堵死；此处直接 DB 强改 release_type 验证 R4 端点自身的防线，独立于 add-issues 防线）。
    const relBugFamily = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    await run(`UPDATE sys_releases SET release_type='bug' WHERE id=?`, [relBugFamily]);   // 模拟 bug 族别批次（正常路径不可达，纯 R4 端点自身防线测试）
    r = await call('POST', `/api/sys-releases/${relBugFamily}/publish`, adminTok, { release_note: 'x', version_tag: 'y' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[R4退场] release_type=bug 批次 publish → 409 LEGACY（端点自身前置闸）');
    ok('[R4退场] legacy /sys-releases/:id/publish：release_type=\'bug\' 批次一律 409 LEGACY_RELEASE_FLOW_DISABLED（端点自身防线，独立于 add-issues）');

    // [R5⑤翻转·2026-07-30 用户拍板] remove-issues 对 release_type='bug' 批次的旧防御闸已删除——旧闸前提
    //   （"正常路径不可达，仅防脏库残留"）在 C3 全类型统一后失效：bug 经 hotfix-publish 建应急批次会真实写入
    //   release_type='bug'（[R3反向] 已断言），每个 bug 应急单都命中旧闸＝应急上线单永远无法移单（用户实测
    //   发现的误伤；C3 时头注已标"仅 emergency 批次可能命中、递延"，本次收尾）。本用例走**真实可达路径**
    //   （非 DB 强改模拟）验证翻转：bug → hotfix-publish 建应急批次（复用 [R3反向] 已建今日排班）→
    //   remove-issues 200 + release_id 清空 + 单仍待上线 + 批次移空 F-4 复位 release_type=NULL。
    const rmBug = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${rmBug}/hotfix-publish`, adminTok, { release_note: '待移除夹具', version_tag: 'vrm', executors: [5, 6] });
    assert.strictEqual(r.status, 200, `[R5⑤翻转] 夹具 hotfix-publish 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rmRelId = r.body.release_id;
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [rmRelId])).release_type, 'bug',
      '[R5⑤翻转] 前置：应急批次 release_type=bug（正常路径真实可达——这正是旧闸"不可达"前提的反例）');
    r = await call('POST', `/api/sys-releases/${rmRelId}/remove-issues`, adminTok, { issue_ids: [rmBug] });
    assert.strictEqual(r.status, 200, `[R5⑤翻转] bug 应急批次 remove-issues 应 200（旧防御闸已删）, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await issueRowRelease(rmBug), null, '[R5⑤翻转] 移除后 release_id 已清空');
    assert.strictEqual(await statusOf(rmBug), '待上线', '[R5⑤翻转] 单仍「待上线」（可重新应急或走常规安排上线）');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [rmRelId])).release_type, null,
      '[R5⑤翻转] 批次移空 → F-4 复位 release_type=NULL（可被任意族别复用）');
    ok('[R5⑤翻转·2026-07-30] remove-issues：bug 应急批次可正常移单（旧"release_type=bug 一律 409"防御闸已删——其前提在 C3 后失效，会锁死每一个应急上线单的移单能力）+ 移空后 F-4 复位');

    // [R5⑤翻转·非空场景(codex 210 审 MED-1 补)] 应急批次追加成员后移除其一——release_type 仅移空时 F-4 复位，
    //   非空保持 'bug'。该残值无准入/发布分流依赖：schema 注释已钉死"展示用途，禁止恢复准入判断"，execute 按
    //   成员实际族别 derive（deriveReleaseType 不读本列）、legacy /publish 全类型恒 409。本组把非空语义锁进断言。
    const rmBug2 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-issues/${rmBug2}/hotfix-publish`, adminTok, { release_note: '非空夹具', version_tag: 'vrm2', executors: [5, 6] });
    assert.strictEqual(r.status, 200, `[R5⑤翻转·非空] 夹具 hotfix-publish 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rmRelId2 = r.body.release_id;
    const rmBug3 = await seedBugToReady(5, devTok);
    r = await call('POST', `/api/sys-releases/${rmRelId2}/add-issues`, adminTok, { issue_ids: [rmBug3] });
    assert.strictEqual(r.status, 200, `[R5⑤翻转·非空] 应急批次追加 bug 应 200（add-issues 无 kind 门，语义现状）, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-releases/${rmRelId2}/remove-issues`, adminTok, { issue_ids: [rmBug2] });
    assert.strictEqual(r.status, 200, `[R5⑤翻转·非空] 移除其一应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await issueRowRelease(rmBug2), null, '[R5⑤翻转·非空] 被移单 release_id 已清空');
    assert.strictEqual(await issueRowRelease(rmBug3), rmRelId2, '[R5⑤翻转·非空] 留存单仍绑定本批次（部分移除不误伤同批他单）');
    assert.strictEqual((await get('SELECT release_type FROM sys_releases WHERE id=?', [rmRelId2])).release_type, 'bug',
      '[R5⑤翻转·非空] 批次非空时 release_type 保持 bug 不复位（F-4 仅移空触发；展示性残值，无准入/发布分流依赖）');
    ok('[R5⑤翻转·非空（codex 210 MED-1）] 应急批次追加成员后移除其一：被移单清空 / 留存单仍绑 / release_type 非空不复位——非空场景契约锁定');
  }

  // ═══ [C6·方案 v3.4 §6.5] bug 补「已关闭」终态：归档(close)+重开(reopen) ═══
  //   bug 现与变更流一样支持 close（已上线→已关闭）/reopen（已关闭→处理中，目标态与变更流「开发中」对称，
  //   非共用同一常量——见 transitions.js BUG_FLOW_TRANSITIONS 新增两条目）。原"上线后出问题一律派生新单"
  //   设计作废；derive（仅从已上线发起）与本次改动正交，两条路径并存，互不排斥。
  {
    // 走真实发布链路（hotfix-publish + execute，复用本文件 R3反向 已建的今日排班 duty_date=today/user_id=5，
    //   不重复 INSERT——idx_sys_duty_roster_active 对同一 duty_date 只允许一条在册行）拿到一个真实「已上线」bug。
    const c6Bug = await seedBugToReady(5, devTok);
    const rHf = await call('POST', `/api/sys-issues/${c6Bug}/hotfix-publish`, adminTok, { release_note: 'C6归档重开测试', executors: [5, 6] });
    assert.strictEqual(rHf.status, 200, `[C6] hotfix-publish 建单应 200, got ${rHf.status} ${JSON.stringify(rHf.body)}`);
    const c6RelId = rHf.body.release_id;
    // C3 新模型：本批次在册执行人是 hotfix-publish 建单时写入的 [5,6]，confirmAndPublish 统一走真实
    //   子表流（301-M3 过渡夹具兑现，定义处完整论述）。
    const rExec = await confirmAndPublish(c6RelId, { release_note: 'C6真发布' });
    assert.strictEqual(rExec.status, 200, `[C6] execute 应 200, got ${rExec.status} ${JSON.stringify(rExec.body)}`);
    assert.strictEqual(await statusOf(c6Bug), '已上线', '[C6] 前置：bug 真实翻已上线');

    // 负例（附录 A）：已上线（未归档）直接 reopen → 409 ISSUE_NOT_ARCHIVED（须先归档）。
    let r = await call('POST', `/api/sys-issues/${c6Bug}/reopen`, adminTok, { reason: '未归档误触' });
    assert.strictEqual(r.status, 409, `[C6负例] bug 已上线未归档 reopen 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'ISSUE_NOT_ARCHIVED', '[C6负例] code=ISSUE_NOT_ARCHIVED');
    assert.strictEqual(await statusOf(c6Bug), '已上线', '[C6负例] 拒绝后仍停在已上线（未被误翻）');
    ok('[C6负例] bug reopen from 已上线（未归档）→ 409 ISSUE_NOT_ARCHIVED（须先归档）——与变更流同一段精判代码，附录 A 明列');

    // 归档（close）：已上线 → 已关闭。
    r = await call('POST', `/api/sys-issues/${c6Bug}/close`, adminTok, {});
    assert.strictEqual(r.status, 200, `[C6] bug close 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    let row = await rowOf(c6Bug);
    assert.strictEqual(row.status, '已关闭', '[C6] bug close → 已关闭');
    assert.ok(row.closed_at, '[C6] closed_at 已盖');

    // config 负例（附录 A 末行）：config 单 close/reopen 一律拒绝（本就无 transitions 条目，恒 400，未变）。
    const cfgIns = await run(
      "INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name) VALUES ('config','已上线','P2','c','BMS','内部',1,'管理员')"
    );
    const cfgId = cfgIns.lastID;
    r = await call('POST', `/api/sys-issues/${cfgId}/close`, adminTok, {});
    assert.strictEqual(r.status, 400, `[C6负例] config close 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '[C6负例] config close → INVALID_TRANSITION（config 无 transitions 定义，族外拒绝，未变）');
    await run("UPDATE sys_issues SET status='已关闭' WHERE id=?", [cfgId]);
    r = await call('POST', `/api/sys-issues/${cfgId}/reopen`, adminTok, { reason: 'x' });
    assert.strictEqual(r.status, 400, `[C6负例] config reopen 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_TRANSITION', '[C6负例] config reopen → INVALID_TRANSITION（同上，未变）');
    ok('[C6负例] config 单 close/reopen 一律 400 INVALID_TRANSITION（config 无 transitions 定义，族外拒绝，附录A末行·本方案不改变既有 config 流程）');

    // 重开（reopen）：已关闭 → 处理中（bug 目标态，与变更流「开发中」对称）。
    r = await call('POST', `/api/sys-issues/${c6Bug}/reopen`, adminTok, { reason: '上线后回归缺陷' });
    assert.strictEqual(r.status, 200, `[C6] bug reopen 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '处理中', '[C6] bug reopen 目标态=处理中（DEV 族，非变更流的开发中）');
    row = await rowOf(c6Bug);
    assert.strictEqual(row.status, '处理中', '[C6] bug 已回到处理中');
    assert.strictEqual(row.release_id, null, '[C6] release_id 已清空（脱离旧批次）');
    assert.strictEqual(row.released_at, null, '[C6] released_at 已清空');
    assert.strictEqual(row.closed_at, null, '[C6] closed_at 已清空');
    assert.strictEqual(row.reopen_count, 1, '[C6] reopen_count=1');
    assert.ok(row.reopened_at, '[C6] reopened_at 已盖');

    // 红线核对：旧 release 本身完全未动（仍「已发布」），getReleaseMembers 仍稳定返回 snapshot 源
    // （成员为发布时冻结值，不因 issue 重开而变化/降级——直接验证方案 §6.5/§6.6 明文的红线）。
    const c6RelRow = await get('SELECT status FROM sys_releases WHERE id=?', [c6RelId]);
    assert.strictEqual(c6RelRow.status, '已发布', '[C6] 红线：重开后旧 release 仍「已发布」（未被拖回计划中）');
    const gmAfterReopen = await I.getReleaseMembers({ id: c6RelId, status: '已发布' });
    assert.strictEqual(gmAfterReopen.source, 'snapshot', '[C6] 红线核心：重开后旧 release 的 getReleaseMembers 仍 source=snapshot（未降级）');
    assert.strictEqual(gmAfterReopen.degraded, false, '[C6] 红线：重开后旧 release 读取仍非降级');

    // 重新开发到待上线：reopen 不重置 dev_assignees 完成态（S10g 已证同 return 语义，roster 完成态残留在
    //   no_code，见 verify-sys-multidev-members.js）——须走本文件既有"二轮重置"范式（临时加协作解除
    //   LAST_ASSIGNEE 限制 → remove 旧完成态实例 → re-add 同一开发全新 pending 实例 → estimate → submit，
    //   与上方"验收通过：二轮"逐字同构，非另造一套）。
    r = await call('POST', `/api/sys-issues/${c6Bug}/dev-assignees`, adminTok, { user_ids: [6] });
    assert.strictEqual(r.status, 200, `[C6] 临时加协作(6) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const c6OldDa = r.body.dev_assignees.find(d => d.user_id === 5);
    r = await call('DELETE', `/api/sys-issues/${c6Bug}/dev-assignees/${c6OldDa.id}`, adminTok, { reason: 'C6 重开后重置旧完成态实例' });
    assert.strictEqual(r.status, 200, `[C6] remove 旧完成态实例应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${c6Bug}/dev-assignees`, adminTok, { user_ids: [5] });
    assert.strictEqual(r.status, 200, `[C6] re-add(5) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // codex 221a HIGH 收口（全文扫描收尾）：本行原硬编码 '2026-09-01 10:00'——P4 批次按"当时已失败清单"
    // 收口时它仍在未来（今天 08-01），未触发 ESTIMATE_BEFORE_ASSIGN 侥幸漏网，但同样会在 09-01 到期，
    // 改用本文件顶部已有的 futureEst(30) 动态生成，与本文件其余三处调用同源。
    r = await call('POST', `/api/sys-issues/${c6Bug}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    assert.strictEqual(r.status, 200, `[C6] estimate 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    // [B4b 全仓扫净] c6Bug 重开后二轮两名在册开发各自提交，bug 单逐人填 bug_cause_note（C6 拍板生效后）。
    r = await call('POST', `/api/sys-issues/${c6Bug}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-15' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions·C6-5）' });
    assert.strictEqual(r.status, 200, `[C6] submit(5) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', `/api/sys-issues/${c6Bug}/submit`, dev2Tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-16' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions·C6-6）' });
    assert.strictEqual(r.status, 200, `[C6] submit(6) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.main_status, '待验证', '[C6] 全员完成 → W-GATE 转待验证');
    r = await call('POST', `/api/sys-issues/${c6Bug}/accept`, adminTok, {});
    assert.strictEqual(r.status, 200, `[C6] accept 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(c6Bug), '待上线', '[C6] 重新走完流程后回到待上线（reopen 不遗留半残状态卡死后续流转）');

    // 加入新批次（普通 add-issues，非 hotfix）→ 再发布，验证能成功加入新批次（红线的另一半：release_id 已清空
    // 不会被旧批次的历史状态卡住，add-issues 的 `release_id IS NULL` 条件真放行）。
    const c6RelId2 = (await call('POST', '/api/sys-releases', adminTok, {})).body.id;
    r = await call('POST', `/api/sys-releases/${c6RelId2}/add-issues`, adminTok, { issue_ids: [c6Bug] });
    assert.strictEqual(r.status, 200, `[C6] 加入新批次应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual((await issueRowRelease(c6Bug)), c6RelId2, '[C6] 已挂新批次（非旧批次）');
    // C3 新模型：c6RelId2 是纯 add-issues 建的批次，尚无在册执行人——confirmAndPublish 自动 PUT
    //   executors [5,6] 后走真实子表流（301-M3 过渡夹具兑现）。
    r = await confirmAndPublish(c6RelId2, { release_note: 'C6二次发布', version_tag: 'v-c6-2' });
    assert.strictEqual(r.status, 200, `[C6] 再发布应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(c6Bug), '已上线', '[C6] 二次发布后再次翻已上线');
    row = await rowOf(c6Bug);
    assert.strictEqual(row.release_id, c6RelId2, '[C6] release_id=新批次（非旧批次）');

    // 新旧两 release 互不干扰：各自快照/timeline 独立一份，旧 release 依旧 snapshot 且成员数不变。
    const gmOldFinal = await I.getReleaseMembers({ id: c6RelId, status: '已发布' });
    const gmNewFinal = await I.getReleaseMembers({ id: c6RelId2, status: '已发布' });
    assert.strictEqual(gmOldFinal.source, 'snapshot', '[C6] 二次发布后旧 release 仍 snapshot（第三次读取仍稳定）');
    assert.strictEqual(gmNewFinal.source, 'snapshot', '[C6] 新 release 也是 snapshot 源');
    assert.strictEqual(gmOldFinal.members.length, 1, '[C6] 旧 release 快照成员数不变（仍恰 1）');
    assert.strictEqual(gmNewFinal.members.length, 1, '[C6] 新 release 快照恰 1 个成员');
    const oldSnapCount = (await get('SELECT COUNT(*) AS n FROM sys_issue_release_commit_snapshots WHERE release_id=?', [c6RelId])).n;
    const newSnapCount = (await get('SELECT COUNT(*) AS n FROM sys_issue_release_commit_snapshots WHERE release_id=?', [c6RelId2])).n;
    assert.strictEqual(oldSnapCount, 1, '[C6] 旧 release 快照表恰 1 行（未被二次发布覆盖/新增）');
    assert.strictEqual(newSnapCount, 1, '[C6] 新 release 快照表独立恰 1 行');
    const releaseTlRows = await all(`SELECT ref_id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release' ORDER BY id ASC`, [c6Bug]);
    assert.strictEqual(releaseTlRows.length, 2, '[C6] 该单 release timeline 恰 2 条（两次真实发布各一条，两次上线史并存）');
    assert.strictEqual(releaseTlRows[0].ref_id, c6RelId, '[C6] 第一条指向旧批次');
    assert.strictEqual(releaseTlRows[1].ref_id, c6RelId2, '[C6] 第二条指向新批次');

    ok('⭐ [C6·§6.5 完整回环·bug] hotfix发布→归档(close)→重开(reopen→处理中)→重新开发到待上线→加入新批次→再发布：全环通过——reopen 后 release_id/released_at/closed_at 均 NULL + 能成功加入新批次 + 新旧两 release 快照/timeline 互不干扰（各自 ref_id/独立行） + 旧 release 全程稳定 source=snapshot（红线验证：release 从未被拖回「计划中」，两次上线史并存）');
  }

  // ═══ [T→⑤ 放开] derive 双向临时闸已放开（完整派生/双描述/M5 覆盖见 verify-sys-bug-derive.js）═══
  {
    // ⑤ 放开验证：从 feature 原单派生 bug 新单 —— 旧 ① 临时闸 SYS_BUG_DERIVE_PENDING 应已消失（201 成功）。
    //   feature 原单 originIsBug=false，故无 M5 反向约束、derive_reason 免填、fix_gap_note 首提亦跳过（origin.type≠bug）。
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'f', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const featureId = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    await call('POST', `/api/sys-issues/${featureId}/intake-accept`, adminTok, { risk_level: '二级' });
    r = await call('POST', `/api/sys-issues/${featureId}/derive`, adminTok, { type: 'bug', title: 'd', system_name: 'BMS', source: '内部' });
    assert.strictEqual(r.status, 201, `feature→bug 派生应放开 201, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.notStrictEqual(r.body.code, 'SYS_BUG_DERIVE_PENDING');
    ok('derive ① 临时闸已放开（⑤）：feature→bug 派生 201，SYS_BUG_DERIVE_PENDING 不再触发（bug 语境完整覆盖见 verify-sys-bug-derive）');
  }
  {
    const bugId = await seedBugToDev(5);
    let r = await call('POST', `/api/sys-issues/${bugId}/feasibility`, devTok, { conclusion: '可行', requirement_confirm: 'x', dev_estimated_at: EST });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'FEASIBILITY_NOT_APPLICABLE');
    r = await call('POST', `/api/sys-issues/${bugId}/blocked`, devTok, { reason: '卡住了' });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'BLOCKED_NOT_APPLICABLE');
    r = await call('POST', `/api/sys-issues/${bugId}/scope-change`, adminTok, { summary: '改范围' });
    assert.ok(r.status === 400 || r.status === 409, `bug scope-change 应拒, got ${r.status}`);
    ok('评估/范围变更不适用 bug：feasibility/blocked → 409 NOT_APPLICABLE + scope-change 拒（需求变化走 ⑤ 派生）');
  }

  // ═══ [G] 旁路：issue_reject / reactivate / void / reassign ═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: '误报', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const rejId = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${rejId}/intake-accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${rejId}/issue-reject`, adminTok, {});
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'REASON_REQUIRED');
    r = await call('POST', `/api/sys-issues/${rejId}/issue-reject`, adminTok, { reason: '非缺陷，操作问题' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(rejId), '已拒绝');
    // 受理排期改造 §4.3：bug issue_reject.from 双 from（待受理/待处理）——本例从「待处理」拒（上方已受理过）。
    // ⭐ 角色权限重构 C0：reactivate 落态**不再读单据 intake_required 分两支**，恒回受理门（待受理）。
    //   原断言「回待处理（intake_required=0 无受理分支）」正是 v1.5 §2.2-B 认定的绕过缺口，已堵。
    r = await call('POST', `/api/sys-issues/${rejId}/reactivate`, adminTok, { reason: '复现了' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(rejId), '待受理');
    const rejRow = await get('SELECT intake_required FROM sys_issues WHERE id=?', [rejId]);
    assert.strictEqual(rejRow.intake_required, 1, 'C0：reactivate 同事务置 intake_required=1（防「待受理+ir0」卡死受理）');
    ok('拒绝/重新激活：待处理 →issue_reject→ 已拒绝（原因必填）→reactivate→ 回「待受理」（C0 恒回受理门 + intake_required=1 原子同写）');
    // 处理中不可拒（bug 仅前段可拒）
    const midId = await seedBugToDev(5);
    r = await call('POST', `/api/sys-issues/${midId}/issue-reject`, adminTok, { reason: 'x' });
    assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_TRANSITION');
    ok('拒绝边界：处理中 bug 不可 issue_reject（仅前段 待处理 可拒）→ 400 INVALID_TRANSITION');
    // void 任意态（处理中 → 已作废）
    r = await call('POST', `/api/sys-issues/${midId}/void`, adminTok, { reason: '重复建单' });
    assert.strictEqual(r.status, 200); assert.strictEqual(await statusOf(midId), '已作废');
    ok('作废：处理中 →void→ 已作废（from=* 任意态，软删除逃生口）');
  }
  {
    // ⚠️ 既有测试变更（C2 破坏性变更，详见交付汇报"既有测试变更清单"）：reassign 改声明式最终 roster
    // （member_ids + reason，方案 §3），不再是 newAssignedTo/oldAssignedTo 换主语义；"换主清 dev_estimated_at"
    // 是旧版"换主=新一轮"的业务规则，v2.9 无"主开发"概念故也无"换主"这件事，dev_estimated_at 清零属
    // W07/ADMIN_TRANSITION 侧关切（C3 范围，本轮不碰）——不再断言。"待验证换人→回处理中"这一结果性行为
    // 仍然成立，但机制变了：新增的 pending 成员触发 W-GATE（VERIFY→DEV），非硬编码 reassign→处理中 映射。
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [6], reason: '开发王休假' });
    assert.strictEqual(r.status, 200, `bug reassign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    let row = await rowOf(id);
    assert.strictEqual(Number(row.assigned_to), 6, '换人到 dev2（选举：5 移除后仅剩 6 在册，当选代表）');
    assert.strictEqual(row.status, '处理中', '同态换人仍 处理中（DEV 族内增减不触发 W-GATE）');
    // 待验证换人 → 回 处理中（W-GATE：新增 pending 成员 5 打破"全员完成"，VERIFY→DEV）
    await call('POST', `/api/sys-issues/${id}/estimate`, dev2Tok, { dev_estimated_at: EST });
    // [B4b 全仓扫净] bug 单必填 bug_cause_note（C6 拍板生效后）。
    await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-17' }], self_tested: true, test_env_deployed: true, bug_cause_note: 'verify 夹具：bug 产生原因（bug-transitions）' });
    assert.strictEqual(await statusOf(id), '待验证');
    r = await call('POST', `/api/sys-issues/${id}/reassign`, adminTok, { member_ids: [5], reason: '返工换回' });
    assert.strictEqual(r.status, 200, `reassign 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(id), '处理中', '待验证换人 → 回 处理中（W-GATE：新增 pending 触发 VERIFY→DEV）');
    ok('换人（C2 新语义 member_ids）：处理中 →reassign→ 处理中（选举正确）+ 待验证 →reassign→ 处理中（W-GATE 联动，非硬编码映射）');
  }
  {
    // C3：W05 唯一 submit 改 assertDevMember（在册判定，非旧 ownerGuard 严格本人）——非在册开发/admin 均不在
    // roster 内，同样 403（错误码 NOT_ROSTERED，语义与旧 H-1"严格本人"口径一致：无权限即拒）。
    const id = await seedBugToDev(5);
    await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST });
    let r = await call('POST', `/api/sys-issues/${id}/submit`, dev2Tok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-18' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 403, '非在册开发 submit 403');
    r = await call('POST', `/api/sys-issues/${id}/submit`, adminTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-19' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 403, 'admin 代提交 403（admin 本身不在册，W06/W05 assertDevMember 统一口径）');
    ok('W05 assertDevMember 严格在册：bug submit 非在册开发/admin 均 403（同构于旧 H-1"严格本人"口径）');
  }

  // ═══ [C] 变更流零回归 canary（受理排期改造：schedule 退场·建单直落待指派）═══
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'canary', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const id = r.body.id;
    // ⭐ 角色权限重构 C0：建单恒 intake_required=1（受理门焊死·全类型）。
    // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单落态回归「待受理」（预沟通段整体撤销）。
    assert.strictEqual(r.body.status, '待受理', 'v2.1：feature 建单落待受理（C2.5 已撤销）');
    // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    const canaryIa = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
    assert.strictEqual(canaryIa.status, 200, `canary 受理 200, got ${canaryIa.status} ${JSON.stringify(canaryIa.body)}`);
    assert.strictEqual(canaryIa.body.status, '待指派', 'C0：feature 受理通过 → 待指派（与旧建单落态一致）');
    // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
    const canaryOa = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
    assert.strictEqual(canaryOa.status, 200, `canary 补 OA 号 200, got ${canaryOa.status} ${JSON.stringify(canaryOa.body)}`);
    // 待指派直接 assign → 成功（受理排期改造后 assign.from=待指派·无需 schedule 中转）。
    r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
    assert.strictEqual(r.status, 200, `feature 待指派 assign 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.status, '开发中', 'assign 待指派→开发中');
    ok('⭐ 变更流 canary：v2.1 C2.5 撤销后·建单落待受理→受理→待指派→补 OA→assign→开发中（新前段状态机零回归）');
  }

  console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代 bug 流状态机 + 端点验证通过（Commit ①+②）`);
  console.log('  覆盖：meta/isDevWorkState/RC-M5全集/RELEASABLE恢复含bug + 建单落待处理 + 前段裁剪 + 全生命周期到待上线 + 上线两路径(填发版信息/确认上线·发版/不发版) + release_id三段断言 + [C5收口批]混批守卫拆除(feature+improvement同批✓/移空复位/历史NULL fail-closed/混批放行端到端+deriveReleaseType=mixed) + [2026-07-29双闸拆除]add-issues的bug独立闸门(bugIssueIds+needs_release=1)整体拆除·bug与feature/improvement同源放行(R5①单条+混选/R5e追加/R5f复用/R5g-a历史NULL) + [C6·§6.5]bug补已关闭终态(meta形状+已上线未归档reopen→409+config负例+完整回环发布→归档→重开(处理中)→重开发→新批次→再发布+旧release全程snapshot红线) + 附件处理中放行 + derive/评估临时闸 + 拒绝/激活/作废/换人 + ownerGuard + 变更流 canary');
  server.close(); db.close();
}

main().catch(e => { console.error('\n[失败]', e.message, e.stack); try { server && server.close(); } catch (_) {} db.close(); process.exit(1); });
