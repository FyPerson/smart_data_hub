// 验证脚本：系统迭代 C4 上线批次（建/列表/详情/加删单 M-8/发布 H-3 原子性/hotfix 兜底）
//   用法：node scripts/verify-sys-release.js
//
// in-process express app（挂真实 router）+ 内存库 + 自签 token，覆盖（方案 §6 / 编码方案 §五 C4）：
//   1. 建批次（自动号 R-YYYYMMDD-N 递增 / 手填 / 手填重号 409 / 超长 400 / 计划上线日期非法 400）
//   2. 加单 M-8（待上线+未挂批次成功 / 非待上线 409 / 已挂批次 409 / config 类 409 / 计划中外 409 / 原子全败）
//   3. 移除单 M-8（在本批次成功清 release_id / 不在本批次 409 / 计划中外 409）
//   4. 发布闸门③（release_note/version_tag trim 非空 + 长度上限）
//   5. 发布 H-3 原子性（≥1 校验 / 全待上线 / 批量翻已上线校 changes / 每单 release timeline ref_id=批次 / 批次已发布+released_at）
//   6. 空批次发布 409 / 成员非待上线 409 / 已发布批次再发/加/删 409
//   7. hotfix-publish（单条自动建 is_hotfix=1 批次 + 一键发布原子 / 非待上线 409 / config 409 / 缺说明 400）
//   8. 权限（非 admin 403）+ 列表/详情
//   9. config DB CHECK（release_id 永空，直接 UPDATE 被拒）+ [C6·§6.5] reopen 收窄：已上线未归档 reopen→409
//      ISSUE_NOT_ARCHIVED（须先归档）+ 归档(close)后 reopen→开发中清 release_id 脱离批次（§6.4/§6.5 集成）
//   9b. [C6·§6.5 完整回环] 发布→归档→重开→重新开发到待上线→加入新批次→再发布：逐环断言 release_id/
//      released_at/closed_at 清空 + 能成功加入新批次 + 新旧两 release 快照/timeline 互不干扰 + 旧 release
//      全程稳定 source=snapshot（红线：release 从未被拖回「计划中」）
//   10-11. 自动号碰撞规避（A）+ issue_ids 元素数上限（E）
//   12. release_id 三段断言（v1.6 §2.3 H-2 改写）：feature/improvement 已上线⟹release_id 非空（原样）；
//       bug 侧改走新 G3(assign-release-dev)+G5/G6(execute-release) 流程——mode=hotfix⟹release_id 为空（不建批次），
//       mode=publish⟹release_id 非空（建批次）。bug 上线编排完整覆盖+越权矩阵见 verify-sys-release-orchestration.js；
//       本文件 1-11 节纯 release CRUD（变更流为主）保持不变，仅第 12 节的 bug 分支随 C3b 改写。
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-release-secret';
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

// [7-⑨]（C2b 事务原子性）用：dbRunAsync 可控故障注入——按 SQL 文本匹配，跳过前 DB_RUN_FAIL_SKIP 次命中
// （放行照常执行），第 DB_RUN_FAIL_SKIP+1 次命中才拒绝并自动清空标志（单发）。⭐ MED-2（Opus 预筛）：
// 跳过次数可调是为了真打「已有部分写入成功、后续写入才失败」这条更强的部分回滚不变量——若第一次命中
// 就拒绝，只证明"INSERT 本身失败不留痕"，证不到"前面已经成功写入的兄弟行也会被一并回滚"（[7-⑨] 用
// executors=[5,13] 两人，跳过 1 次=放行第一人 INSERT 成功、拒绝第二人 INSERT，验证的正是后者）。
// 调用方仍应在 finally 里把两个标志一并兜底复位，防止"本该触发但没触发"漏留误伤后续用例。⚠️ 只影响经
// 模块内部 dbRunAsync 发出的写入（route handler 内部逻辑），本文件测试自身用的 run(...) 直调不受影响。
let DB_RUN_FAIL_ON = null;
let DB_RUN_FAIL_SKIP = 0;
const runTestable = (sql, params = []) => {
  if (DB_RUN_FAIL_ON && sql.includes(DB_RUN_FAIL_ON)) {
    if (DB_RUN_FAIL_SKIP > 0) {
      DB_RUN_FAIL_SKIP--;
      return run(sql, params);   // 放行本次命中，继续正常执行（供后续命中真正触发拒绝）
    }
    DB_RUN_FAIL_ON = null;
    return Promise.reject(new Error('[7-⑨]注入故障：模拟写入失败'));
  }
  return run(sql, params);
};

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: runTestable, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),   // C3b 起 REQUIRED_DEPS 含附件 4 项，stub 注入过工厂校验
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
// [C4 合并修复批 275-M5] 示例对接人（受理人白名单）——真实 ⑦ 路径夹具需要它调 liaison-test-pass。
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
// C3：§7 hotfix-publish 系列用户第三个合格执行人（id=20，[7-⑤e] PUT executors 换人后的目标集合成员）。
const dev20Tok = jwt.sign({ id: 20, username: 'dev20', display_name: '开发丙', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
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

// 把一张 feature 单推到「待上线」（create→schedule→assign→estimate→submit→accept）。
//   D（codex L-1）：固定指派 dev(id=5)、estimate/submit 用 devTok——ownerGuard 严格本人，admin 不能代开发提交，
//   不再保留 adminTok 误导分支。
async function seedToReady() {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level（否则 400 RISK_LEVEL_REQUIRED）。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本文件测上线批次（建/加删单/发布原子性），
  // 与「待对接测试」段本身无关（后者由专门的 verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时
  // 失效，触发 §3.0-⑥ 降级路径，使 submit 仍直落"待验证"→可立即 accept 到"待上线"——本文件其余断言
  // 零改动，这也是方案承认的合法真实场景（非造假绕过）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-23' }], self_tested: true, test_env_deployed: true });
  assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'accept 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  const row = await get('SELECT status, release_id FROM sys_issues WHERE id=?', [id]);
  assert.strictEqual(row.status, '待上线', 'seed 后应为待上线');
  assert.strictEqual(row.release_id, null, 'seed 后 release_id NULL');
  return id;
}
// [C4 合并修复批 275-M5] 真实 ⑦ 路径代表夹具——本文件其余场景默认走上方 seedToReady 的 999999 降级(⑥)
// 简化路径（上线批次机制本身与走⑥/⑦无关，见 seedToReady 注释）。保留有效 intake_liaison_id=13，
// 走真实 GATE ⑦（待对接测试）+ liaison-test-pass 落到待验证，再照常 accept 到待上线——999999 手法
// 仍是本文件其余场景的默认，本函数只服务下方跑 1-2 条代表性下游断言的专用场景。
async function seedToReadyViaRealLiaisonTest() {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't-真实⑦路径', system_name: 'BMS', source: '内部', description: '275-M5 真实⑦路径 fixture', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070098' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: futureEst(30), estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-24' }], self_tested: true, test_env_deployed: true });
  assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.main_status, '待对接测试', '[275-M5] submit → 待对接测试（真实 ⑦ 路径，非 999999 降级）');
  // ⭐ D22-④ 批2：pass 现须凭证二选一，本夹具补 test_note。
  r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '275-M5 夹具测试通过' });
  assert.strictEqual(r.status, 200, 'liaison-test-pass 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.status, '待验证', '[275-M5] liaison-test-pass → 待验证');
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'accept 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  const row = await get('SELECT status, release_id FROM sys_issues WHERE id=?', [id]);
  assert.strictEqual(row.status, '待上线', '[275-M5] seed 后应为待上线');
  assert.strictEqual(row.release_id, null, '[275-M5] seed 后 release_id NULL');
  return id;
}
const issueRow = (id) => get('SELECT status, release_id, released_at FROM sys_issues WHERE id=?', [id]);
const relRow = (id) => get('SELECT status, release_no, is_hotfix, release_note, version_tag, released_at FROM sys_releases WHERE id=?', [id]);

// C3（方案 §4.3 全文）：publish 唯一合法入口收窄为 /sys-releases/:id/execute，语义整体切换为「确认我
//   这一份」+ R-GATE（多人各自确认、在册人数≥1 ∧ 全员 done 才真正翻已发布，决策 7 三修下限 2→1）。本文件 §4-6/§9/§12 关注
//   的是 _publishReleaseCoreInTxn 内核本身的校验/原子性行为（release_note 闸门/成员非空/全待上线/
//   roster 门/timeline/批次翻已发布），不关心"怎么走到可执行态"这段——**301-M3 过渡夹具标注兑现**：
//   旧版本直写批次级 release_assignee_* 单列钉三前提，C3 落地后单列已不驱动中心守卫，本 helper 改为
//   走真实两段子表流：PUT executors 设两人（executorId + 固定"影子搭档" SHADOW_EXECUTOR_ID）→ SQL
//   把两行 notify_status 置 sent（等价"已安排上线"，跳过行级通知外呼这段与本文件验证目标无关的
//   环节）→ 影子搭档先真实调用 /execute 确认完（幂等跳过，见下方"若已 done"分支）→ 调用方指定的
//   executorId 最后调用 /execute（带 body），R-GATE 在这次调用里被满足，真正触发发布。
//   **幂等感知**：本 helper 可能在同一 relId 上被多次调用（本文件多处先用坏 body 验证 400/409，最后
//   一次才用合法 body 验证 200 真发布——同一批次多次尝试）——每次调用先查当前在册行状态，已存在则跳
//   过重复 PUT（避免撞 PUT executors 闸①EXECUTORS_LOCKED）、影子搭档已 done 则跳过重复确认（避免打
//   在一个已经 done 的行上撞回幂等分支，浪费一次无意义的往返）。
//   外部契约不变：调用方仍只传 relId+body（+可选 executorId/executorTok/executorName），拿到的仍是
//   "这次确认"的 HTTP 响应——只是现在这个响应就是触发发布的那一次真实行级确认。
//   本文件全部经由本 helper 调用 execute() 的用例（§1/2/4-6/9/9b/10-12 等约 15+ 处）均因此自动获得新
//   模型支持，不必逐个调用点单独重写（唯二例外：line 373 一带"已发布批次再发布→409"与 line 335 一带
//   `.released` 字段读法，语义/契约本身在新模型下变了，需单独改，见完成报告"测试分诊清单"）。
const SHADOW_EXECUTOR_ID = 999901;
const shadowExecutorTok = jwt.sign({ id: SHADOW_EXECUTOR_ID, username: 'shadow-partner', display_name: '影子搭档', role: 'user' }, SECRET);
async function publishRelease(relId, body, executorId = 5, executorTok = devTok, executorName = '开发王') {
  await run(`INSERT OR IGNORE INTO users (id, username, display_name, role, status) VALUES (?, 'shadow-partner', '影子搭档', 'user', 'active')`, [SHADOW_EXECUTOR_ID]);
  let rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  if (rows.length === 0) {
    const rSet = await call('PUT', `/api/sys-releases/${relId}/executors`, adminTok, { user_ids: [executorId, SHADOW_EXECUTOR_ID] });
    if (rSet.status !== 200) return rSet;   // 调用方自行断言这个失败响应（罕见路径，正常用例不会走到）
    rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  }
  const myRow = rows.find(r => r.user_id === executorId);
  if (!myRow) throw new Error(`publishRelease helper: executorId=${executorId} 不在 release ${relId} 的在册执行人子表中`);
  // LOW-6（Opus 预筛）：markSent 挪到"rows.length===0"分支外——统一覆盖"本 helper 刚建的两行"与"调用方
  //   经别的路径（如先前失败的 PUT/别的 helper）已建好的 not_sent/pending 行"两种起点，对齐
  //   verify-sys-multidev-snapshots.js / verify-sys-bug-transitions.js 两份姊妹 helper 同款写法（三份
  //   口径统一，不再是本文件独有的"只在刚建时置 sent"窄口径）。CHECK 要求 notified_at 同步非空（单列
  //   UPDATE 会撞 sys_release_executors 值域约束）。
  const notSentIds = rows.filter(r => r.notify_status !== 'sent').map(r => r.id);
  if (notSentIds.length > 0) {
    const ph = notSentIds.map(() => '?').join(',');
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE id IN (${ph})`, notSentIds);
    rows = await all(`SELECT id, user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [relId]);
  }
  const shadowRow = rows.find(r => r.user_id === SHADOW_EXECUTOR_ID);
  if (shadowRow && shadowRow.exec_status === 'pending') {
    // 303-M2（Opus 对抗审）：中间预确认调用不许静默吞——断言真成功且未提前触发发布（released===false，
    //   两人批次里影子搭档必非最后一人），失败带上下文抛错方便定位。
    const rShadow = await call('POST', `/api/sys-releases/${relId}/execute`, shadowExecutorTok, { executor_row_id: shadowRow.id });
    if (rShadow.status !== 200 || rShadow.body.released !== false) {
      throw new Error(`publishRelease helper: 影子搭档(row ${shadowRow.id}) 预确认异常，relId=${relId} status=${rShadow.status} body=${JSON.stringify(rShadow.body)}`);
    }
  }
  return call('POST', `/api/sys-releases/${relId}/execute`, executorTok, { ...body, executor_row_id: myRow.id });
}

async function main() {
  mod.initSchema();
  await waitReady();
  // status/phone/dingtalk_user_id 列：C3 后端批改造后大量用例改走 /sys-releases/:id/execute（中心守卫要走
  //   hasReleaseEligibility(userId)：SELECT status, role——本文件 §7 hotfix-publish 闸门②③正是这个函数）。
  //   ⭐ MED-1（Opus 预筛）注释写实：本文件不再有任何路径真调 sendReleaseNotifyAndWriteback（C2b 起
  //   hotfix-publish 已不再复用该服务，本文件也从未直接调用 /sys-releases/:id/notify-executor 路由）——
  //   L1 订正：这两者现已随 C4b H1 退场从生产代码整体删除，"从未调用"这句话依然成立且更彻底（不是本文件
  //   刻意不调，是全项目已无处可调），phone/dingtalk_user_id 两列在本文件现已是历史遗留（无消费方），
  //   status 列仍被 hasReleaseEligibility 真实消费，继续保留 CREATE TABLE 原样未做清理（不在本次改造范围）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  // id=20：C2b hotfix-publish 执行人闸门测试用第三个合格用户（子表聚合/软删行不出现场景需要 ≥3 名合格
  //   执行人轮换，5/13 两个不够构造"移除一人换一人"的场景）。
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active'),(13,'wangtaotao','示例对接人','user','active'),(20,'dev20','开发丙','user','active')`);
  await new Promise((res) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; res(); }); });

  // 当天号前缀（与后端 strftime 同源）
  const ymd = (await get("SELECT strftime('%Y%m%d', datetime('now','localtime')) AS ymd")).ymd;
  const prefix = `R-${ymd}-`;

  // ── 1. 建批次 ──────────
  let r = await call('POST', '/api/sys-releases', adminTok, { title: '6月批次' });
  assert.strictEqual(r.status, 201, '建批次 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.release_no, prefix + '1', '自动号 R-YYYYMMDD-1, got ' + r.body.release_no);
  assert.strictEqual(r.body.status, '计划中');
  const relA = r.body.id;
  ok('建批次：自动号 ' + r.body.release_no + ' + 计划中');

  r = await call('POST', '/api/sys-releases', adminTok, {});
  assert.strictEqual(r.body.release_no, prefix + '2', '同日第二个批次号递增, got ' + r.body.release_no);
  const relB = r.body.id;
  ok('自动号同日递增 -2');

  r = await call('POST', '/api/sys-releases', adminTok, { release_no: 'V-MANUAL-1' });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.body.release_no, 'V-MANUAL-1');
  ok('手填批次号');
  r = await call('POST', '/api/sys-releases', adminTok, { release_no: 'V-MANUAL-1' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_NO_DUP');
  ok('手填重号 → 409 RELEASE_NO_DUP');

  r = await call('POST', '/api/sys-releases', adminTok, { title: 'x'.repeat(201) });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_TITLE_TOO_LONG');
  ok('批次说明超长 → 400');
  r = await call('POST', '/api/sys-releases', adminTok, { planned_date: '2026-13-45' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_PLANNED_DATE');
  ok('计划上线日期非法 → 400');

  // ── 2. 加单 M-8 ──────────
  const i1 = await seedToReady();   // 待上线
  const i2 = await seedToReady();   // 待上线
  r = await call('POST', `/api/sys-releases/${relA}/add-issues`, adminTok, { issue_ids: [i1, i2] });
  assert.strictEqual(r.status, 200, '加单 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.count, 2);
  assert.strictEqual((await issueRow(i1)).release_id, relA, 'i1 release_id 绑 relA');
  assert.strictEqual((await issueRow(i2)).release_id, relA, 'i2 release_id 绑 relA');
  ok('加单：2 单挂入 relA');

  // 已挂批次 → 不能再加入另一批次
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [i1] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE');
  assert.strictEqual((await issueRow(i1)).release_id, relA, '加失败后 i1 仍属 relA（未被抢占）');
  ok('已挂批次单加入它批次 → 409 ISSUE_NOT_ADDABLE');

  // 非待上线（新建未走流程，状态=待评估）→ 不能加
  const draftId = (await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'd', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 })).body.id;
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [draftId] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE');
  ok('非待上线单加入 → 409');

  // 原子全败：[待上线, 非待上线] 一起加 → 整批回滚，待上线单也不被加
  const i3 = await seedToReady();
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [i3, draftId] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE');
  assert.strictEqual((await issueRow(i3)).release_id, null, '原子回滚：i3 未被加（全败）');
  ok('混合加单原子全败 → 待上线单也回滚');

  // config 类不可加（直接造一张 config·待上线·未挂批次的脏数据测 type 闸门）
  const cfgRes = await run(
    "INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name) VALUES ('config','待上线','P2','c','BMS','内部',1,'管理员')"
  );
  const cfgId = cfgRes.lastID;
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [cfgId] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_ADDABLE');
  ok('config 类加单 → 409（type 闸门挡）');

  // 加单负向：批次不存在 / id 非法 / 空数组
  r = await call('POST', `/api/sys-releases/999999/add-issues`, adminTok, { issue_ids: [i3] });
  assert.strictEqual(r.status, 404); assert.strictEqual(r.body.code, 'RELEASE_NOT_FOUND');
  ok('加单到不存在批次 → 404');
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [] });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'ISSUE_IDS_REQUIRED');
  ok('加单空数组 → 400');
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: [-1] });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'INVALID_ISSUE_ID');
  ok('加单非法 id → 400');

  // ── 3. 移除单 M-8 ──────────
  r = await call('POST', `/api/sys-releases/${relA}/remove-issues`, adminTok, { issue_ids: [i2] });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.count, 1);
  assert.strictEqual((await issueRow(i2)).release_id, null, 'i2 移除后 release_id 清空');
  assert.strictEqual((await issueRow(i1)).release_id, relA, 'i1 仍在 relA（移除不误伤）');
  ok('移除单：i2 清 release_id，i1 不受影响');
  r = await call('POST', `/api/sys-releases/${relA}/remove-issues`, adminTok, { issue_ids: [i2] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_REMOVABLE');
  ok('移除不在本批次的单 → 409');

  // ── 4+5. 发布闸门 + H-3 原子性 ──────────
  // relA 当前只有 i1。先把 i2 加回（验收回 relA 多单发布）
  await call('POST', `/api/sys-releases/${relA}/add-issues`, adminTok, { issue_ids: [i2] });
  // 闸门：批次无 release_note/version_tag，直接 publish 不带 → 400（C3 改走 /execute，publishRelease
  //   helper 已同步走真实两段子表流把中心守卫执行人闸（actor 在册∧在册人数≥1∧全员 exec_status=done，
  //   决策 7 三修下限 2→1）钉好，测试目标——release_note 闸门本身（_publishReleaseCoreInTxn 内部闸门
  //   ③）——不受影响，LOW-5 订正：
  //   旧措辞"三前提"是改造前单列比对时代的说法，新模型不再是三个平行前提，已随口径更新）
  r = await publishRelease(relA, {});
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  ok('发布缺上线说明 → 400 RELEASE_NOTE_REQUIRED');
  r = await publishRelease(relA, { release_note: '   ', version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  ok('发布上线说明纯空格 → 400');
  // [C6 断言变更] 原「发布缺版本号 → 400 VERSION_TAG_REQUIRED」用例已随 SSOT §8「去 version_tag 必填」/S21 废止——
  //   不能在此位置就地改成"期望成功"：relA 当前 i1/i2 均已是待上线（i2 要到下方 218 行才被临时改开发中），
  //   若在此处真放行一次成功发布会提前把 relA 转「已发布」，打穿下方 214-242 行整段"成员非待上线 409 回滚 +
  //   成功发布 200"的既有断言链（成功发布只应发生一次，就是下方 227 行那次）。version_tag 去必填的正例改到
  //   独立小节验证，见下方「[C6] S21：发布无 version_tag」块（不复用/不提前消费 relA）。
  r = await publishRelease(relA, { release_note: 'x'.repeat(1001), version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_TOO_LONG');
  ok('上线说明超长 → 400');

  // 成员非待上线（造脏：直接把 i2 改回开发中但保留 release_id）→ 409 RELEASE_MEMBER_NOT_READY
  await run("UPDATE sys_issues SET status='开发中' WHERE id=?", [i2]);
  r = await publishRelease(relA, { release_note: '上线说明A', version_tag: 'v2.0' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_MEMBER_NOT_READY');
  assert.strictEqual((await relRow(relA)).status, '计划中', '发布失败批次仍计划中');
  assert.strictEqual((await issueRow(i1)).status, '待上线', '发布失败 i1 未被翻（原子回滚）');
  ok('成员非待上线 → 409 + 整体回滚');
  await run("UPDATE sys_issues SET status='待上线' WHERE id=?", [i2]);   // 恢复

  // 成功发布：单步带 release_note+version_tag（RELEASE 中心守卫要求在册开发≥1 且全完成态——
  //   i1/i2 均由 seedToReady() 走真实 assign→estimate→submit→accept 全流程，roster 天然满足，见函数定义）
  r = await publishRelease(relA, { release_note: '6月版上线A', version_tag: 'v2.0.0' });
  assert.strictEqual(r.status, 200, '发布 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  // C3：released 字段改为布尔（是否因本次确认触发发布），issue_id 数组挪到 released_issue_ids。
  assert.strictEqual(r.body.released, true, '发布响应 released=true（布尔，C3 新契约）');
  assert.strictEqual(r.body.count, 2); assert.deepStrictEqual(r.body.released_issue_ids.sort(), [i1, i2].sort());
  const ra = await relRow(relA);
  assert.strictEqual(ra.status, '已发布'); assert.ok(ra.released_at, '批次 released_at 落');
  assert.strictEqual(ra.release_note, '6月版上线A'); assert.strictEqual(ra.version_tag, 'v2.0.0');
  for (const iid of [i1, i2]) {
    const row = await issueRow(iid);
    assert.strictEqual(row.status, '已上线', `#${iid} 翻已上线`); assert.ok(row.released_at, `#${iid} released_at 落`);
    const tl = await get("SELECT event_type, from_status, to_status, ref_id, round_no, summary FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'", [iid]);
    assert.ok(tl, `#${iid} 有 release timeline`); assert.strictEqual(tl.ref_id, relA, 'ref_id=批次');
    assert.strictEqual(tl.from_status, '待上线'); assert.strictEqual(tl.to_status, '已上线');
    assert.strictEqual(tl.round_no, null, 'release timeline round_no NULL（非交付轮）');
    assert.strictEqual(tl.summary, '6月版上线A', 'release timeline summary=上线说明');
  }
  ok('发布成功：2 单翻已上线 + released_at + release timeline(ref_id/from/to/summary) + 批次已发布');

  // [codex 98 号 MED7① 自检补漏] W07 十动作证据表——close 此前全套 verify 从未走真实路由调用（仅
  //   verify-sys-flow.js 用直接 SQL 把状态改到「已关闭」测 reopen 前置，close 端点本身零覆盖）。补：
  //   合法通过（已上线 admin close → 已关闭）+ 非法拒绝（待上线态 close → 400 INVALID_TRANSITION，
  //   from 白名单仅 ['已上线']）。close 目标态非 DEV/VERIFY/RELEASE 族，W07 [2b] 门禁的 entering* 三项
  //   均不适用（不进族动作），故不受 roster 状态影响——与本自检①"hold/void/close 等不进族动作没被误拦"
  //   的结论一致（此处即该结论的真实路由证据）。
  {
    // 用 i2（本节之后无下游引用，i1 后续仍需保持已上线态供 reopen 等测试使用，不可复用）
    let r2 = await call('POST', `/api/sys-issues/${i2}/close`, adminTok, {});
    assert.strictEqual(r2.status, 200, `close 合法通过（已上线→已关闭）200, got ${r2.status} ${JSON.stringify(r2.body)}`);
    const closedRow = await get('SELECT status, closed_at FROM sys_issues WHERE id=?', [i2]);
    assert.strictEqual(closedRow.status, '已关闭', 'close 落库为已关闭');
    assert.ok(closedRow.closed_at, 'close 盖 closed_at');
    ok('[W07 证据·close] 合法通过：已上线 admin close → 200 已关闭（+closed_at），不进族不受 roster 影响');

    const iReady = await seedToReady();   // 待上线态（未发布）
    r2 = await call('POST', `/api/sys-issues/${iReady}/close`, adminTok, {});
    assert.strictEqual(r2.status, 400, `close 非法拒绝（待上线→close 无此边）应 400, got ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_TRANSITION', 'close from 白名单仅 [已上线]，待上线态被拒');
    ok('[W07 证据·close] 非法拒绝：待上线态 close → 400 INVALID_TRANSITION（from 白名单外）');
  }

  // ── 6. 已发布批次再操作 ──────────
  // ⭐ 断言过时→改写（C3，测试分诊）：旧版本"已发布批次再发布 → 409 RELEASE_NOT_PLANNING"建立在"单人
  //   一次性发布"的旧模型上——新模型下"再次点确认"是同一个人对同一行的重复请求，命中的是幂等三分诊
  //   ②（done 优先于通知态，v1.3·M-b），返回 200 幂等成功而非报错；已发布批次真正的"不能再动"体现在
  //   add-issues/remove-issues 这类批次级写操作上（下方两条断言不变，那两个端点自身的 RELEASE_NOT_PLANNING
  //   闸门未受本次改造影响）。改为断言新的正确行为：已发布批次的原执行人再次调用 execute() → 200 幂等
  //   （my_status='done'/already=true/released=true/pending_count=0），零副作用（不产生新的 timeline/
  //   不改变批次状态）。
  const relATlCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_executor_done'`, [relA])).c;
  r = await publishRelease(relA, { release_note: 'x', version_tag: 'y' });
  assert.strictEqual(r.status, 200, `已发布批次再次确认应 200(幂等), got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.my_status, 'done', '已发布批次再次确认 my_status=done');
  assert.strictEqual(r.body.already, true, '已发布批次再次确认 already=true（幂等，非新动作）');
  assert.strictEqual(r.body.released, true, '已发布批次再次确认 released=true（如实反映批次已发布）');
  assert.strictEqual(r.body.pending_count, 0, '已发布批次再次确认 pending_count=0（全员早已 done）');
  const relATlCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE ref_id=? AND action_code='release_executor_done'`, [relA])).c;
  assert.strictEqual(relATlCountAfter, relATlCountBefore, '幂等确认零副作用：不新增"确认完成"timeline（该分支是纯读回滚，不写入）');
  ok('已发布批次再次确认（原执行人重复点）→ 200 幂等成功（my_status=done/already=true/released=true），零副作用（C3 新模型：批次级"不能再动"体现在 add-issues/remove-issues 端点自身闸门，非 execute 端点，见下方两条）');
  const iNew = await seedToReady();
  r = await call('POST', `/api/sys-releases/${relA}/add-issues`, adminTok, { issue_ids: [iNew] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_NOT_PLANNING');
  ok('已发布批次加单 → 409');
  r = await call('POST', `/api/sys-releases/${relA}/remove-issues`, adminTok, { issue_ids: [i1] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_NOT_PLANNING');
  ok('已发布批次移除 → 409');

  // 空批次发布 → 409 RELEASE_EMPTY（relB 当前无成员）
  r = await publishRelease(relB, { release_note: 'a', version_tag: 'b' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_EMPTY');
  ok('空批次发布 → 409 RELEASE_EMPTY');

  // ── 7. hotfix-publish（C3 重写 + C2b 改造：方案 v1.7 §4.4 改造 2b/10——去自动定人+子表聚合响应）─────
  //   ⚠️ 断言全面重写（C2b）：本端点不再复用批次级 preemptReleaseNotifySend（L1 订正：该函数已随 C4b
  //   H1 退场整体删除，此处是历史设计记录）查排班自动定人，改收
  //   `executors[]`（admin 选人弹窗产出）→「建单+加单+写执行人子表」单事务原子提交；**通知整体移出
  //   本端点**（不再有②事务外通知阶段），响应不含 notify_status/notification_attempted/notify_error
  //   等"已通知"暗示字段，只带子表聚合 executors 数组（同 PUT executors 响应形状）。旧版本节测试的
  //   NO_ELIGIBLE_DUTY_ROSTER/sending/sent/failed/stale/not_sent 五态幂等分支全部建立在"自动查排班+
  //   自动外呼"这条已被移除的路径上——**断言过时（非实现错）**：验证目标本身（排班自动定人/自动外呼）
  //   已被本次改造字面移除，不是这次改动把它测挂了，故全部改写为 C2b 新行为断言，不保留旧夹具。
  //   "重复调用"分支的 idempotent/hint 判定逻辑本身**未改**（仍读 rel.ns 批次级旧列，见 index.js 路由
  //   头部注释"改造10"段的flagged决策），故 [7-②]～[7-④] 沿用相同的 SQL 直改 notify_status 构造五态
  //   手法，只是给每次调用体加上 executors[] 字段（输入面校验统一发生在最前，重复调用分支虽不消费该
  //   字段但仍须通过形状校验），并新增对 executors 子表聚合数组的断言（改造10 的正面验证）。

  // [7-①] hotfix 正常链：executors=[5,13] 两人首次调用 → 200·建单+加单+写执行人子表原子提交（决策 7
  //   三修后 1 人亦合法，本用例选 2 人纯粹是覆盖多人形态，非闸门强制下限——见下方 [7-②负]/[7-②正]
  //   对人数闸本身的精确判定），响应不含任何
  //   "已通知"暗示；批次级 10 列（release_assignee_*）除 notify_status 保持 DDL 默认 'not_sent' 外全 NULL
  //   （C2b 反模式禁双写：本端点绝不写批次级列）；子表 N 行均 not_sent/pending。
  // ⭐ LOW-6（Opus 预筛）断言补回：planned_date 这一列仍由本端点写入（date('now','localtime')，C2b 未
  // 动这段——虽已不再驱动自动查排班，但展示/统计口径仍需要它），删掉排班相关断言时被连带误删，此处补回。
  const todayRow = await get("SELECT date('now','localtime') AS d");
  const today = todayRow.d;
  const hf = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '紧急修复', version_tag: 'v2.0.1', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-①] hotfix 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, true, '[7-①] created_new=true');
  assert.strictEqual(r.body.notify_status, undefined, '[7-①] 响应不含 notify_status（C2b：通知已整体移出本端点，不留"已通知"暗示字段）');
  assert.strictEqual(r.body.notification_attempted, undefined, '[7-①] 响应不含 notification_attempted');
  assert.strictEqual(r.body.notify_error, undefined, '[7-①] 响应不含 notify_error');
  assert.ok(Array.isArray(r.body.executors), '[7-①] 响应含 executors 数组');
  assert.strictEqual(r.body.executors.length, 2, `[7-①] executors 数组含 2 行, 实际 ${r.body.executors.length}`);
  assert.ok(r.body.executors.every(e => e.notify_status === 'not_sent' && e.exec_status === 'pending'), '[7-①] 每行均 not_sent/pending（DDL 默认值，未被通知触碰）');
  const hfIssue = await issueRow(hf);
  assert.strictEqual(hfIssue.status, '待上线', '[7-①] 单仍停在待上线（原子建单不直接翻已上线）');
  assert.ok(hfIssue.release_id, '[7-①] hotfix issue 挂上自动批次');
  const hfRel = await get(
    `SELECT is_hotfix, release_kind, status, release_note, planned_date,
            release_assignee_id, release_assignee_name, release_assignee_notify_status AS ns,
            release_assignee_notify_started_at, release_assignee_notified_at, release_assignee_notify_message_key,
            release_assignee_notify_error, release_assignee_notify_token, release_assignee_read_at
       FROM sys_releases WHERE id=?`,
    [hfIssue.release_id]);
  assert.strictEqual(hfRel.is_hotfix, 1, '[7-①] hotfix 批次 is_hotfix=1');
  assert.strictEqual(hfRel.release_kind, 'emergency', '[7-①] release_kind=emergency（§6.12 emergency_display 口径，10 列之一但非"通知/执行人"字段，本身就该被设为 emergency，不参与下面的 NULL 断言组）');
  assert.strictEqual(hfRel.status, '计划中', '[7-①] 批次仍计划中（未发布）');
  assert.strictEqual(hfRel.planned_date, today, '[7-①] planned_date=建单当日（该列仍由本端点写入，C2b 未动，此处需要看守断言）');
  assert.strictEqual(hfRel.release_note, '紧急修复');
  // 批次级 10 列（方案 §4.2「release_assignee_* 10 列」= 上方 9 个 release_assignee_ 前缀列 + release_kind）：
  //   C2b 反模式禁双写——本端点全程不碰这 9 列（release_kind 是第 10 列，但它是批次类型标记非通知/
  //   执行人字段，本端点仍需要合法写它=emergency，已在上面单独断言，不入本组 NULL 断言）。⚠️ sys_issues
  //   另有一个同名前缀的 `release_assignee_notify_sent_by` 列（角色权限重构 C2b ALTER 补的，在 issue 主表，
  //   非批次表 sys_releases，两者字面撞名极易混淆——本组特意不查它，因为它根本不属于"批次级 10 列"）。
  assert.strictEqual(hfRel.release_assignee_id, null, '[7-①] 批次级 release_assignee_id 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_name, null, '[7-①] 批次级 release_assignee_name 仍 NULL');
  assert.strictEqual(hfRel.ns, 'not_sent', "[7-①] 批次级 notify_status 仍是 DDL 默认值 'not_sent'（该列 NOT NULL DEFAULT，非 NULL 但同样未被本端点写过，与其余 8 列的空态同一件事）");
  assert.strictEqual(hfRel.release_assignee_notify_started_at, null, '[7-①] release_assignee_notify_started_at 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_notified_at, null, '[7-①] release_assignee_notified_at 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_notify_message_key, null, '[7-①] release_assignee_notify_message_key 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_notify_error, null, '[7-①] release_assignee_notify_error 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_notify_token, null, '[7-①] release_assignee_notify_token 仍 NULL');
  assert.strictEqual(hfRel.release_assignee_read_at, null, '[7-①] release_assignee_read_at 仍 NULL');
  const hfExecRows = await all(`SELECT user_id, user_name, notify_status, exec_status, added_by FROM sys_release_executors WHERE release_id=? ORDER BY user_id`, [hfIssue.release_id]);
  assert.strictEqual(hfExecRows.length, 2, '[7-①] 子表恰 2 行');
  assert.deepStrictEqual(hfExecRows.map(x => x.user_id).sort((a, b) => a - b), [5, 13], '[7-①] 子表 user_id 与 executors[] 输入一致');
  assert.ok(hfExecRows.every(x => x.notify_status === 'not_sent' && x.exec_status === 'pending' && x.added_by === 1), '[7-①] 子表每行 not_sent/pending/added_by=actor(admin=1)');
  ok('[7-①] hotfix 正常链：executors[5,13] 首次调用 → 200 原子建单+加单+写执行人子表（2 行 not_sent/pending），响应不含任何"已通知"暗示（notify_status/notification_attempted/notify_error 均 undefined，只带 executors 数组），批次级 10 列除 notify_status 保持 DDL 默认外全 NULL（C2b 反模式禁双写坐实）');

  // [7-②负]（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订）：原断言"executors 去重后<2 → 400
  // EXECUTORS_TOO_FEW"（用 [5,5] 去重后仅 1 人来构造）钉的是三修前的旧下限——下限降到 1 人后，
  // 去重后 1 人不再是负例（见下方 [7-②正]），红灯诊断=断言过时非实现错（[[feedback_test_assertion_
  // self_error]]）。人数闸真正的负例收窄到去重后 0 人（空数组），同 verify-sys-release-executors.js
  // [2-②负] 同款反转口径。
  const hfEmpty = await seedToReady();
  const emptyCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  r = await call('POST', `/api/sys-issues/${hfEmpty}/hotfix-publish`, adminTok, { release_note: '空集合', executors: [] });
  assert.strictEqual(r.status, 400, `[7-②负] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'EXECUTORS_TOO_FEW', `[7-②负] code 应为 EXECUTORS_TOO_FEW，实际 ${r.body.code}`);
  const emptyCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(emptyCountAfter, emptyCountBefore, '[7-②负] 库内零残留：sys_releases 未新增行（人数闸在建批次之前拦截，不占用批次号）');
  const hfEmptyRow = await issueRow(hfEmpty);
  assert.strictEqual(hfEmptyRow.status, '待上线', '[7-②负] issue 状态未变');
  assert.strictEqual(hfEmptyRow.release_id, null, '[7-②负] issue release_id 仍 NULL（未绑单）');
  ok('[7-②负]（反转：原"去重后1人→400"已过时，人数闸负例收窄到空数组）executors=[] → 400 EXECUTORS_TOO_FEW，库内零残留');

  // [7-②正]（新增·决策 7 三修）：executors **去重后**恰 1 人 → 200 成功建单，子表新增 1 行。沿用
  // LOW-5①原本的真去重输入 [5,5]（原始长度 2，去重后仅 1 人）——同一份输入，此刻验证的是"去重后 1 人
  // 应放行"而非"应拦截"，两个方向共用同一个能证伪"闸门判的是原始长度还是去重后集合大小"的输入构造。
  const hfSingle = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hfSingle}/hotfix-publish`, adminTok, { release_note: '单人成功', executors: [5, 5] });
  assert.strictEqual(r.status, 200, `[7-②正] 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, true, '[7-②正] created_new=true');
  const hfSingleExecRows = await all(`SELECT user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=?`, [r.body.release_id]);
  assert.strictEqual(hfSingleExecRows.length, 1, '[7-②正] 子表恰 1 行（[5,5] 去重后仅 1 人，非 2 行）');
  assert.strictEqual(hfSingleExecRows[0].user_id, 5, '[7-②正] 子表行 user_id=5');
  assert.ok(hfSingleExecRows[0].notify_status === 'not_sent' && hfSingleExecRows[0].exec_status === 'pending', '[7-②正] 子表行 not_sent/pending（DDL 默认值）');
  ok('[7-②正]（新增·决策 7 三修）人数闸正例：executors=[5,5]（去重后仅 1 人）→ 200，子表新增 1 行（单人批次本身合法，同 PUT executors 闸②同码同"去重后"口径）');

  // [7-③] 资格闸负例：executors 含无资格用户（admin id=1）→ 400 EXECUTOR_NOT_ELIGIBLE，库内零残留。
  const hfIneligible = await seedToReady();
  const ineligibleCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  r = await call('POST', `/api/sys-issues/${hfIneligible}/hotfix-publish`, adminTok, { release_note: '资格不符', executors: [5, 1] });
  assert.strictEqual(r.status, 400, `[7-③] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'EXECUTOR_NOT_ELIGIBLE', `[7-③] code 应为 EXECUTOR_NOT_ELIGIBLE，实际 ${r.body.code}`);
  const ineligibleCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(ineligibleCountAfter, ineligibleCountBefore, '[7-③] 库内零残留：sys_releases 未新增行');
  const hfIneligibleRow = await issueRow(hfIneligible);
  assert.strictEqual(hfIneligibleRow.release_id, null, '[7-③] issue release_id 仍 NULL（未绑单，含合格的 5 也未单独落库——整体拒绝同 PUT 闸③精神）');
  ok('[7-③] 资格闸负例：executors=[5,1]（1=admin 无资格，同 PUT executors 闸③同函数 hasReleaseEligibility）→ 400 EXECUTOR_NOT_ELIGIBLE，库内零残留');

  // [7-④] executors 缺失/畸形 → 400 INVALID_USER_IDS（三变体：缺字段/非数组/元素非法），均于任何 DB 访问
  //   之前的纯输入面校验拦下，零残留。
  const hfBad = await seedToReady();
  const badCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  r = await call('POST', `/api/sys-issues/${hfBad}/hotfix-publish`, adminTok, { release_note: '缺executors' });
  assert.strictEqual(r.status, 400, `[7-④a] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'INVALID_USER_IDS', `[7-④a] code 应为 INVALID_USER_IDS，实际 ${r.body.code}`);
  r = await call('POST', `/api/sys-issues/${hfBad}/hotfix-publish`, adminTok, { release_note: '非数组', executors: 'not-an-array' });
  assert.strictEqual(r.status, 400, `[7-④b] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'INVALID_USER_IDS', `[7-④b] code 应为 INVALID_USER_IDS，实际 ${r.body.code}`);
  r = await call('POST', `/api/sys-issues/${hfBad}/hotfix-publish`, adminTok, { release_note: '含非法元素', executors: [5, 0] });
  assert.strictEqual(r.status, 400, `[7-④c] 期望 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'INVALID_USER_IDS', `[7-④c] code 应为 INVALID_USER_IDS，实际 ${r.body.code}`);
  const badCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(badCountAfter, badCountBefore, '[7-④] 三变体均库内零残留（纯输入面校验，早于任何 DB 访问）');
  const hfBadRow = await issueRow(hfBad);
  assert.strictEqual(hfBadRow.release_id, null, '[7-④] issue release_id 仍 NULL');
  ok('[7-④] executors 缺失（未传字段）/畸形（非数组/元素非法 0）→ 均 400 INVALID_USER_IDS（同 PUT executors 输入面同码），库内零残留');

  // [7-⑤] 重复调用五态：C4a（方案 §4.4 登记①）收口——notify_status/idempotent/hint 判定改子表聚合语义，
  //   不再读批次级旧列 rel.ns（该列 C2b 后无人写，出厂即 DDL 默认 'not_sent'，本组不再对它做任何 SQL 构造）。
  //   五态改为直接 UPDATE 子表两行（[7-①] 落库的 5/13）的 notify_status（+ CHECK 要求的配套列），每次调用体
  //   仍需带 executors[] 字段通过输入面校验（该字段在重复调用分支不被消费）。hint 统一改为"请到批次详情逐人
  //   发通知"（新 UI 范式无"重新发送"单点动作），idempotent 判据="在册行至少一行 sent/sending"。
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用', version_tag: 'v9', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤a] sent 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, false, '[7-⑤a] created_new=false');
  assert.strictEqual(r.body.notification_attempted, false, '[7-⑤a] notification_attempted=false（本端点不重发，字段本身仍保留——未在此响应形状里一并去除，见 index.js 头部注释）');
  assert.strictEqual(r.body.idempotent, true, '[7-⑤a] idempotent=true（子表两行均 sent）');
  assert.strictEqual(r.body.notify_status, 'sent', '[7-⑤a] notify_status=子表聚合"sent"（在册全 sent）');
  assert.strictEqual(r.body.release_id, hfIssue.release_id, '[7-⑤a] release_id 与首次一致（未建新批次）');
  assert.ok(Array.isArray(r.body.executors), '[7-⑤a] 改造10：响应含 executors 数组（子表聚合，替代旧列 release_assignee_id/name）');
  assert.strictEqual(r.body.executors.length, 2, '[7-⑤a] executors 数组含在册 2 行');
  assert.strictEqual(r.body.release_assignee_id, undefined, '[7-⑤a] 改造10：响应不再含旧列 release_assignee_id（已被 executors 数组取代）');
  assert.strictEqual(r.body.release_assignee_name, undefined, '[7-⑤a] 改造10：响应不再含旧列 release_assignee_name');
  // 其中一行转 sending（CHECK 要求 notify_started_at/notify_token 非空）——聚合优先级"存在 sending"命中。
  await run(`UPDATE sys_release_executors SET notify_status='sending', notify_started_at=datetime('now','localtime'), notify_token='tok-7-5a' WHERE release_id=? AND user_id=5`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用2', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤a] sending 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.idempotent, true, '[7-⑤a] sending 态同样幂等标记（有 sent/sending 即 idempotent）');
  assert.strictEqual(r.body.notify_status, 'sending', '[7-⑤a] notify_status=子表聚合"sending"（优先级最高，5 号在途）');
  await run(`UPDATE sys_release_executors SET notify_status='sent', notify_started_at=NULL, notify_token=NULL WHERE release_id=? AND user_id=5`, [hfIssue.release_id]);   // 复原
  ok('[7-⑤a] 应急单 sending/sent：200 幂等·返回现状·不重发；notify_status/idempotent 改子表聚合语义（登记①），响应改带 executors 子表聚合数组（2 行在册），不再含旧列 release_assignee_id/name');

  await run(`UPDATE sys_release_executors SET notify_status='failed', notify_error='模拟失败', notified_at=NULL WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用3', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤b] failed 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.notify_status, 'failed', '[7-⑤b] 返回现状 notify_status=子表聚合"failed"（在册全 failed，无 sent/sending）');
  assert.strictEqual(r.body.idempotent, undefined, '[7-⑤b] 无 sent/sending → 不是 idempotent（响应无该字段）');
  assert.strictEqual(r.body.notification_attempted, false, '[7-⑤b] 不重发');
  assert.strictEqual(r.body.hint, '请到批次详情逐人发通知', '[7-⑤b] hint 改子表聚合语义写实提示（登记①，不再指旧"安排上线"入口）');
  ok('[7-⑤b] 应急单 failed：200·返回现状 + hint「请到批次详情逐人发通知」，本端点不重发');

  await run(`UPDATE sys_release_executors SET notify_status='stale', notify_error=NULL WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用3b', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤c] stale 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.release_id, hfIssue.release_id, '[7-⑤c] release_id 不变（仍指向同一应急单，未误建新单）');
  // 方案 §4.3："stale 归入 failed 是刻意归并"（对 admin 而言两者动作相同——重试那一行）——聚合值不是 'stale'。
  assert.strictEqual(r.body.notify_status, 'failed', "[7-⑤c] notify_status=子表聚合'failed'（stale 刻意归并入 failed，非 'stale' 本身，方案 §4.3 明文）");
  assert.strictEqual(r.body.created_new, false, '[7-⑤c] created_new=false（重复调用非首次）');
  assert.strictEqual(r.body.hint, '请到批次详情逐人发通知', '[7-⑤c] hint 改子表聚合语义写实提示（登记①）');
  ok('[7-⑤c] 应急单 stale：200·release_id 不变/notify_status 聚合归并为 failed/created_new=false + hint「请到批次详情逐人发通知」');

  await run(`UPDATE sys_release_executors SET notify_status='not_sent', notify_error=NULL, notified_at=NULL WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用4', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤d] not_sent 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.notify_status, 'not_sent', '[7-⑤d] notify_status=子表聚合"not_sent"（在册全 not_sent）');
  assert.strictEqual(r.body.hint, '请到批次详情逐人发通知', '[7-⑤d] hint 改子表聚合语义写实提示（登记①，不再区分"重新发送"文案）');
  ok('[7-⑤d] 应急单 not_sent：200·返回现状 + hint「请到批次详情逐人发通知」（可达：cancel-schedule/加单/移单/改期均会重置到此态）');

  // [7-⑤e] 重复调用分支子表聚合正确性专项（改造10 核心）：软删行不出现——把 hf 批次的执行人集合从
  //   [5,13] 换成 [13,20]（PUT executors，5 被软删），再调一次 hotfix-publish（重复调用分支），响应
  //   executors 数组应只含当前在册的 [13,20] 两行，被软删的 5 不出现。
  const putReplace = await call('PUT', `/api/sys-releases/${hfIssue.release_id}/executors`, adminTok, { user_ids: [13, 20] });
  assert.strictEqual(putReplace.status, 200, `[7-⑤e-fixture] PUT executors 换人应 200, got ${putReplace.status} ${JSON.stringify(putReplace.body)}`);
  const removedRow5 = await get(`SELECT removed_at FROM sys_release_executors WHERE release_id=? AND user_id=5 ORDER BY id DESC LIMIT 1`, [hfIssue.release_id]);
  assert.ok(removedRow5 && removedRow5.removed_at, '[7-⑤e-fixture] 用户 5 的行已软删（换人生效）');
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用5', executors: [5, 13] });
  assert.strictEqual(r.status, 200, `[7-⑤e] 期望 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.executors.length, 2, `[7-⑤e] executors 数组应恰 2 行（当前在册），实际 ${r.body.executors.length}`);
  const execIds5e = r.body.executors.map(x => x.user_id).sort((a, b) => a - b);
  assert.deepStrictEqual(execIds5e, [13, 20], `[7-⑤e] executors 数组应为当前在册 [13,20]，软删的 5 不出现，实际 ${JSON.stringify(execIds5e)}`);
  ok('[7-⑤e] 重复调用分支子表聚合正确性（改造10 核心）：PUT executors 换人后（5 软删/20 新增），重复调用响应的 executors 数组只含当前在册 [13,20]，软删行不出现');

  // [7-⑥] 应急单已发布：409（真正走完 execute 发布——C3 新模型：execute() 中心守卫已改口径为行级子表
  //   多人确认，与 hotfix-publish 本身的 C2b 改造相互独立。本批次此刻在册执行人是 [13,20]（[7-⑤e]
  //   PUT executors 换过），把两行都置 sent 后各自真实调用 execute 确认，第二人（20）触发真正发布。
  await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  const hfExecRowsFor6 = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [hfIssue.release_id]);
  const row13For6 = hfExecRowsFor6.find(x => x.user_id === 13);
  const row20For6 = hfExecRowsFor6.find(x => x.user_id === 20);
  const rExec13 = await call('POST', `/api/sys-releases/${hfIssue.release_id}/execute`, liaisonTok, { executor_row_id: row13For6.id });
  assert.strictEqual(rExec13.status, 200, `[7-⑥前置a] 13 确认应 200(还差1人), got ${rExec13.status} ${JSON.stringify(rExec13.body)}`);
  assert.strictEqual(rExec13.body.released, false, '[7-⑥前置a] 13 确认后 released=false（20 尚未确认）');
  const rExecHf = await call('POST', `/api/sys-releases/${hfIssue.release_id}/execute`, dev20Tok, { release_note: '紧急修复真发布', executor_row_id: row20For6.id });
  assert.strictEqual(rExecHf.status, 200, `[7-⑥前置b] execute 真发布应 200, got ${rExecHf.status} ${JSON.stringify(rExecHf.body)}`);
  assert.strictEqual(rExecHf.body.released, true, '[7-⑥前置b] 20 确认（最后一人）触发真正发布');
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '已发布后重试', executors: [5, 13] });
  assert.strictEqual(r.status, 409, `[7-⑥] 应急单已发布应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'ISSUE_ALREADY_RELEASED', '[7-⑥] code=ISSUE_ALREADY_RELEASED');
  ok('[7-⑥] 应急单已发布：409 ISSUE_ALREADY_RELEASED（任务已上线，不可再建应急单）');

  // [7-⑦] 非应急上线单（普通单，即已挂入 relB 这种 admin 建的常规批次）：409（请勿混用应急口）
  const normalMember = await seedToReady();
  await call('POST', '/api/sys-releases', adminTok, { title: '普通批次-混用测试' });
  const relNormal = (await get("SELECT id FROM sys_releases WHERE title='普通批次-混用测试'")).id;
  await call('POST', `/api/sys-releases/${relNormal}/add-issues`, adminTok, { issue_ids: [normalMember] });
  r = await call('POST', `/api/sys-issues/${normalMember}/hotfix-publish`, adminTok, { release_note: '混用测试', executors: [5, 13] });
  assert.strictEqual(r.status, 409, `[7-⑦] 混用应急口应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'ISSUE_IN_NON_EMERGENCY_RELEASE', '[7-⑦] code=ISSUE_IN_NON_EMERGENCY_RELEASE');
  ok('[7-⑦] 任务已在非应急（普通）上线单中：409 ISSUE_IN_NON_EMERGENCY_RELEASE（请勿混用应急口）');

  // [7-⑧] 并发首次调用：仅一方建单；败方回滚并返回赢家 release_id + executors 子表聚合（同响应形状，created_new=false）
  const concurId = await seedToReady();
  const [c1, c2] = await Promise.all([
    call('POST', `/api/sys-issues/${concurId}/hotfix-publish`, adminTok, { release_note: '并发A', executors: [5, 13] }),
    call('POST', `/api/sys-issues/${concurId}/hotfix-publish`, adminTok, { release_note: '并发B', executors: [5, 13] }),
  ]);
  assert.strictEqual(c1.status, 200); assert.strictEqual(c2.status, 200, `并发双方应均 200, got ${c1.status}/${c2.status}`);
  const winners = [c1, c2].filter(r2 => r2.body.created_new === true);
  const losers = [c1, c2].filter(r2 => r2.body.created_new === false);
  assert.strictEqual(winners.length, 1, `[7-⑧] 恰一方 created_new=true，实际 ${winners.length}`);
  assert.strictEqual(losers.length, 1, `[7-⑧] 恰一方 created_new=false（败方），实际 ${losers.length}`);
  assert.strictEqual(losers[0].body.release_id, winners[0].body.release_id, '[7-⑧] 败方返回赢家的 release_id');
  assert.ok(Array.isArray(losers[0].body.executors), '[7-⑧] 败方响应含 executors 数组（赢家批次的子表聚合，改造10 覆盖并发败方分支）');
  assert.strictEqual(losers[0].body.executors.length, 2, '[7-⑧] 败方 executors 数组反映赢家真实建的 2 行');
  const concurReleases = await all("SELECT id FROM sys_releases WHERE title=?", [`hotfix #${concurId}`]);
  assert.strictEqual(concurReleases.length, 1, '[7-⑧] 库内仅 1 条应急批次（败方新建的已回滚，无残留）');
  const concurExecRows = await all(`SELECT user_id FROM sys_release_executors WHERE release_id=?`, [winners[0].body.release_id]);
  assert.strictEqual(concurExecRows.length, 2, '[7-⑧] 库内执行人子表仅赢家那 2 行（败方新建的子表行随批次回滚一并消失，无残留）');
  ok('[7-⑧] 并发首次调用：仅一方 created_new=true 真建单+写子表，败方 created_new=false 返回赢家 release_id+executors 聚合，库内零残留（BEGIN IMMEDIATE 重读抢占）');

  // [7-⑨] 事务原子性：注入第 2 个执行人的 sys_release_executors INSERT 失败（跳过第 1 个，放行成功）→
  //   批次单 + issue 绑定 + **已成功写入的第一人行**全部回滚零残留（C2b 核心不变量：①"建单+加单+写执行
  //   人子表"是单事务原子提交，任一环节失败都不留部分产物）。⭐ MED-2（Opus 预筛）：跳过第 1 次命中放行
  //   是为了真打"部分回滚"这条更强的不变量——若第 1 次命中就拒绝（旧版本写法），子表 INSERT 从未真正
  //   成功过一次，测不出"已经成功写入的兄弟行会不会被一并回滚"，只能测到"INSERT 本身失败不留痕"这条
  //   较弱的结论；executors=[5,13] 两人，跳过 1 次=放行 user_id=5 那行 INSERT 真成功、拒绝 user_id=13
  //   那行，验证的正是"第一人行已经成功写入，第二人炸→连同第一人行一并回滚"。
  const hfAtomic = await seedToReady();
  const atomicRelCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  const atomicExecCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_release_executors`)).c;
  DB_RUN_FAIL_ON = 'INSERT INTO sys_release_executors';
  DB_RUN_FAIL_SKIP = 1;   // 放行第 1 次命中（user_id=5 那行真成功），第 2 次命中（user_id=13）才拒绝
  let rAtomic;
  try {
    rAtomic = await call('POST', `/api/sys-issues/${hfAtomic}/hotfix-publish`, adminTok, { release_note: '原子性注入故障', executors: [5, 13] });
  } finally {
    DB_RUN_FAIL_ON = null;   // 兜底复位：防止万一没触发而误伤后续用例
    DB_RUN_FAIL_SKIP = 0;
  }
  assert.strictEqual(rAtomic.status, 500, `[7-⑨] 注入故障应 500（未预期错误走 sendSysTransitionError 兜底）, got ${rAtomic.status} ${JSON.stringify(rAtomic.body)}`);
  const atomicRelCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  const atomicExecCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_release_executors`)).c;
  assert.strictEqual(atomicRelCountAfter, atomicRelCountBefore, '[7-⑨] sys_releases 零残留（批次 INSERT 已回滚）');
  assert.strictEqual(atomicExecCountAfter, atomicExecCountBefore, '[7-⑨] sys_release_executors 零残留（第 1 人行已经写入成功，也随事务一并回滚——非"INSERT 本身没发生过"，是"发生过但被撤销"，部分回滚不变量坐实）');
  const hfAtomicRow = await issueRow(hfAtomic);
  assert.strictEqual(hfAtomicRow.release_id, null, '[7-⑨] issue release_id 仍 NULL（绑单一并回滚，非"建单成功但子表写失败"的半原子态）');
  assert.strictEqual(hfAtomicRow.status, '待上线', '[7-⑨] issue 状态未变');
  ok('[7-⑨] 事务原子性：注入第 2 个执行人 INSERT 失败（放行第 1 个真成功）→ 500，批次单/issue 绑定/子表（含已成功写入的第一人行）全部零残留（单事务原子回滚，坐实部分回滚不变量，非仅"注入点本身不留痕"）');

  // hotfix 负向：缺说明（不因 release_id/type 分支提前拦截而漏测）
  // [对抗审"假绿猎手"视角裁定必修 F] 补库内零残留断言——此前只测了状态码/code，未证明"400 拒绝时真的
  //   什么都没落库"（本用例的 release_note 校验在 hotfix-publish 事务开始**之前**做，理论上不该有任何
  //   写入，但没有断言就等于没验证过这条不变量，见方案 §6.7"缺说明/config 单独负例"两条附录A行）。
  const releasesCountBefore1 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  const hf2 = await seedToReady();
  // ⚠️ seedToReady() 本身会走 create→intake-accept→assign→estimate→submit→accept 全链路，天然产生若干条
  //   timeline 行（assign/estimate/submit/accept 等）——"零残留"指的是"这次 400 调用没有新增"，不是"这单
  //   从来没有过 timeline"，故用调用前后的计数差而非绝对值 0 来断言。
  const hf2TimelineCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [hf2])).c;
  r = await call('POST', `/api/sys-issues/${hf2}/hotfix-publish`, adminTok, { version_tag: 'v1' });   // 缺 release_note，先于 executors 校验命中
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  const releasesCountAfter1 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(releasesCountAfter1, releasesCountBefore1, '缺说明 400 后 sys_releases 计数不变（未建任何批次）');
  const hf2Row = await issueRow(hf2);
  assert.strictEqual(hf2Row.status, '待上线', '缺说明 400 后 issue 状态仍待上线（未被误动）');
  assert.strictEqual(hf2Row.release_id, null, '缺说明 400 后 issue release_id 仍 NULL（未绑单）');
  const hf2TimelineCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [hf2])).c;
  assert.strictEqual(hf2TimelineCountAfter, hf2TimelineCountBefore, '缺说明 400 后该单 timeline 计数不变（无新增，零副作用；本身已有的 assign/estimate/submit/accept 等历史行不受影响）');
  ok('hotfix 缺上线说明 → 400，库内零残留（sys_releases 计数不变 + issue 状态/release_id 未动 + timeline 计数不变）');
  // hotfix config → CONFIG_NO_RELEASE（用上面 cfgId，状态待上线；C2b：须带合法 executors[] 才能通过输入面校验走到类型闸）
  const releasesCountBefore2 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  const cfgTimelineCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [cfgId])).c;
  r = await call('POST', `/api/sys-issues/${cfgId}/hotfix-publish`, adminTok, { release_note: 'a', version_tag: 'b', executors: [5, 13] });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'CONFIG_NO_RELEASE');
  const releasesCountAfter2 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(releasesCountAfter2, releasesCountBefore2, 'config 类 409 后 sys_releases 计数不变（未建任何批次）');
  const cfgRow = await issueRow(cfgId);
  assert.strictEqual(cfgRow.status, '待上线', 'config 类 409 后 issue 状态仍待上线（未被误动）');
  assert.strictEqual(cfgRow.release_id, null, 'config 类 409 后 issue release_id 仍 NULL（DB CHECK 本就禁 config 带 release_id，此处再验一次运行时行为）');
  const cfgTimelineCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [cfgId])).c;
  assert.strictEqual(cfgTimelineCountAfter, cfgTimelineCountBefore, 'config 类 409 后该单 timeline 计数不变（无新增，零副作用）');
  ok('hotfix config 类 → 409 CONFIG_NO_RELEASE（附录A"config 单独负例"），库内零残留（sys_releases 计数不变 + issue 状态/release_id 未动 + timeline 计数不变）');

  // ── 8. 权限 + 列表/详情 ──────────
  r = await call('POST', '/api/sys-releases', devTok, { title: 'x' });
  assert.strictEqual(r.status, 403); ok('非 admin 建批次 → 403');
  // C3：/publish 全类型 409（LEGACY_RELEASE_FLOW_DISABLED），不再区分角色——原"非 admin 发布 → 403"
  //   已随 requireAdmin 中间件移除而不再成立，改断言"任意角色（含非 admin）→ 409"（附录A"任意 → 409"）。
  r = await call('POST', `/api/sys-releases/${relB}/publish`, devTok, { release_note: 'a', version_tag: 'b' });
  assert.strictEqual(r.status, 409, `[C3] /publish 非 admin 也应 409（非 403）, got ${r.status}`);
  assert.strictEqual(r.body.code, 'LEGACY_RELEASE_FLOW_DISABLED', '[C3] /publish 全类型 409 确切码');
  ok('[C3 改造] /publish 全类型 409（含非 admin），端点已整体退场不再区分角色');
  // 执行人入口批（2026-07-31 用户拍板）：列表对普通用户从 403 改为 200 + mine 过滤（仅"执行人=我"的
  //   批次，无则空数组）——原"非 admin → 403"断言随行为拍板变更而更新，全量分支断言在
  //   verify-sys-release-my-entry.js 专项覆盖。
  // [codex 审 LOW-3 收口] 直插一条"执行人=user 5"批次做正例——没有它 every([]) 恒真（断言永远成立形态，
  //   feedback_test_assertion_self_error 第三形态），mine 过滤"过滤了什么"完全没被本脚本咬合。
  await run(`INSERT INTO sys_releases (release_no, title, status, is_hotfix, release_assignee_id, release_assignee_name,
              release_assignee_notify_status, created_by, created_by_name, created_at)
             VALUES ('R-MINE-5', 'mine 过滤正例·执行人5', '计划中', 0, 5, '开发王', 'sent', 1, '管理员', datetime('now'))`);
  const mine5RelId = (await get(`SELECT id FROM sys_releases WHERE release_no='R-MINE-5'`)).id;
  // C4a（方案 §4.4 #8）：mine 过滤已从批次级单列（release_assignee_id）改子表 EXISTS——上方 INSERT 里的
  //   旧列仍保留（历史读路径/[2]类断言兼容），但可见性真正生效的判据现在是子表在册行，补一条同一人的行。
  await run(`INSERT INTO sys_release_executors (release_id, user_id, user_name, notify_status, notified_at, added_by, added_by_name)
             VALUES (?, 5, '开发王', 'sent', datetime('now','localtime'), 1, '管理员')`, [mine5RelId]);
  // C4a：本文件此处之前 publishRelease() helper（含 relB 的"空批次发布→409"用例）会在子表为空时自动
  // PUT executors [5,影子搭档] 铺垫——relB 早已不是"从未指定执行人"的干净反例。改为现造一条全新、从未
  // 被任何 helper 碰过的批次，保证反例真实成立（子表零行）。
  const relNoExecR = await call('POST', '/api/sys-releases', adminTok, { title: 'mine 反例·从未指定执行人' });
  const relNoExec = relNoExecR.body.id;
  const relNoExecRows = await all(`SELECT 1 FROM sys_release_executors WHERE release_id=?`, [relNoExec]);
  assert.strictEqual(relNoExecRows.length, 0, '前提：relNoExec 子表确实零行（防夹具自己变假）');

  r = await call('GET', '/api/sys-releases', devTok, null);
  assert.strictEqual(r.status, 200, `非 admin 看批次列表 → 200 mine 视角, got ${r.status}`);
  assert.strictEqual(r.body.scope, 'mine', '普通用户 scope=mine');
  assert.ok(r.body.items.length >= 1, 'mine 视角至少含刚插入的本人批次（非空数组，every 真实咬合）');
  // C4a（方案 §4.4 #8）：mine 过滤已从批次级单列改子表 EXISTS——正例=R-MINE-5 真出现；反例=relNoExec
  // （子表零行的纯 admin 批次）不出现。⚠️ 不再用"every 全部是 R-MINE-5"（旧单列世界的假设）——用户 5
  // 经本文件此前 [7-⑧]/publishRelease 等 helper 已合法成为**多个**批次的在册执行人，不止一条。
  assert.ok(r.body.items.some(x => x.release_no === 'R-MINE-5'), '本人批次真实返回（正例：子表在册命中）');
  assert.ok(r.body.items.every(x => x.id !== relNoExec), 'mine 视角不含 relNoExec（子表零行的纯 admin 批次，反例：子表无该行）');
  // MED-5（Opus 预筛）断言升级：逐行反查子表在册，返回集里每一条都必须真有 5 号的在册行，全体命中才算过。
  for (const item of r.body.items) {
    const rosterHit = await get(`SELECT 1 FROM sys_release_executors WHERE release_id=? AND user_id=5 AND removed_at IS NULL`, [item.id]);
    assert.ok(rosterHit, `MED-5 逐行反查：返回集中批次 #${item.id}（${item.release_no}）必须有 5 号的在册行，未命中即判定过滤条件泄漏`);
  }
  ok('非 admin 看批次列表 → 200 mine 过滤（正例非空 + 他人批次被滤 + MED-5 返回集逐行反查子表在册全命中·执行人入口批新契约）');

  r = await call('GET', '/api/sys-releases', adminTok, null);
  assert.strictEqual(r.status, 200); assert.ok(r.body.total >= 3, '列表含多批次');
  const relAItem = r.body.items.find(x => x.id === relA);
  assert.strictEqual(relAItem.issue_count, 2, 'relA issue_count=2');
  assert.strictEqual(relAItem.status, '已发布');
  ok('批次列表：含成员数 issue_count + status');
  r = await call('GET', `/api/sys-releases?status=${encodeURIComponent('计划中')}`, adminTok, null);
  assert.ok(r.body.items.every(x => x.status === '计划中'), 'status 筛选生效');
  ok('批次列表 status 筛选');
  r = await call('GET', `/api/sys-releases/${relA}`, adminTok, null);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.issues.length, 2);
  assert.strictEqual(r.body.release.id, relA);
  ok('批次详情：批次 + 组内 issue 列表');
  r = await call('GET', `/api/sys-releases/999999`, adminTok, null);
  assert.strictEqual(r.status, 404); ok('批次详情不存在 → 404');

  // ── 9. config DB CHECK + 重开清 release_id（§6.4 集成）──────────
  let checkRejected = false;
  try { await run("UPDATE sys_issues SET release_id=? WHERE id=?", [relB, cfgId]); }
  catch (e) { checkRejected = /CHECK|constraint/i.test(e.message); }
  assert.ok(checkRejected, 'DB CHECK 拒绝给 config 写 release_id');
  ok('config release_id 永空 DB CHECK 生效（直接 UPDATE 被拒）');

  // [C6·方案 v3.4 §6.5] reopen 收窄：i1 当前「已上线」（未归档）直接 reopen → 409 须先归档（附录 A 明列，
  //   原 §6.4 时代"重开已上线单直接清 release_id"这条行为已作废——现须先 close 归档再 reopen）。
  r = await call('POST', `/api/sys-issues/${i1}/reopen`, adminTok, { reason: '上线后发现缺陷' });
  assert.strictEqual(r.status, 409, `[C6] 已上线未归档直接 reopen 应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'ISSUE_NOT_ARCHIVED', '[C6] code=ISSUE_NOT_ARCHIVED（须先归档）');
  assert.strictEqual((await issueRow(i1)).status, '已上线', '[C6] 拒绝后 i1 仍停在已上线（未被误翻）');
  ok('[C6·§6.5] reopen 收窄：已上线（未归档）直接 reopen → 409 ISSUE_NOT_ARCHIVED（须先归档，附录 A 明列）');

  // 先归档（close）：已上线 → 已关闭。
  r = await call('POST', `/api/sys-issues/${i1}/close`, adminTok, {});
  assert.strictEqual(r.status, 200, `[C6] i1 归档应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual((await issueRow(i1)).status, '已关闭', '[C6] i1 归档后落库为已关闭');

  // 归档后重开：已关闭 → 开发中，release_id 清空脱离批次（§6.4/§6.5 集成）。
  r = await call('POST', `/api/sys-issues/${i1}/reopen`, adminTok, { reason: '上线后发现缺陷' });
  assert.strictEqual(r.status, 200, 'reopen 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  const reRow = await issueRow(i1);
  assert.strictEqual(reRow.status, '开发中'); assert.strictEqual(reRow.release_id, null, '重开清 release_id 脱离批次');
  ok('已归档单重开 → 开发中 + 清 release_id 脱离原批次（§6.4/§6.5）');

  // ── 9b. [C6·方案 v3.4 §6.5] 完整回环：发布→归档(close)→重开(reopen)→重新开发到待上线→加入新批次→再发布 ──────────
  //   红线核对（方案 §6.5 明文）：release 本身不得被拖回「计划中」——重开只清 issue 侧的
  //   release_id/released_at/closed_at，不碰旧 release 行；旧 release 的 getReleaseMembers 在归档/重开/
  //   再发布前后全程稳定返回 source='snapshot'（成员为发布时冻结值），不因 issue 重开而变化/降级。全部
  //   用独立夹具（cycId/relCyc/relCyc2），不与本文件其余测试的 i1/relA 等既有夹具交叉。
  {
    const cycId = await seedToReady();   // 待上线态 feature（独立夹具）
    const relCyc = (await call('POST', '/api/sys-releases', adminTok, { title: 'C6回环批次' })).body.id;
    let r13 = await call('POST', `/api/sys-releases/${relCyc}/add-issues`, adminTok, { issue_ids: [cycId] });
    assert.strictEqual(r13.status, 200, '[C6回环①] 加单应 200');
    r13 = await publishRelease(relCyc, { release_note: 'C6回环首发', version_tag: 'v-cyc-1' });
    assert.strictEqual(r13.status, 200, `[C6回环①] 首发应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    const afterFirstPublish = await issueRow(cycId);
    assert.strictEqual(afterFirstPublish.status, '已上线', '[C6回环①] 单已翻已上线');
    assert.strictEqual(afterFirstPublish.release_id, relCyc, '[C6回环①] release_id=首发批次');
    assert.ok(afterFirstPublish.released_at, '[C6回环①] released_at 已落');

    // 首发后立即读一次（基线）：应走 snapshot 源，供后续多次比对。
    const gmBefore = await I.getReleaseMembers({ id: relCyc, status: '已发布' });
    assert.strictEqual(gmBefore.source, 'snapshot', '[C6回环②] 首发后 getReleaseMembers 走 snapshot 源（基线）');
    assert.strictEqual(gmBefore.members.length, 1, '[C6回环②] 快照恰 1 个成员');
    assert.strictEqual(gmBefore.members[0].issue_id, cycId);
    assert.strictEqual(gmBefore.members[0].status_at_publish, '已上线', '[C6回环②] 快照冻结的发布时状态=已上线');

    // 归档（close）：已上线 → 已关闭。
    r13 = await call('POST', `/api/sys-issues/${cycId}/close`, adminTok, {});
    assert.strictEqual(r13.status, 200, `[C6回环③] 归档应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    assert.strictEqual((await issueRow(cycId)).status, '已关闭', '[C6回环③] 单已归档');

    // 重开（reopen）：已关闭 → 开发中（change 流目标态）。
    r13 = await call('POST', `/api/sys-issues/${cycId}/reopen`, adminTok, { reason: '上线后发现缺陷，需重开修复' });
    assert.strictEqual(r13.status, 200, `[C6回环④] 重开应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    assert.strictEqual(r13.body.status, '开发中', '[C6回环④] 重开目标态=开发中（change 流）');
    const afterReopen = await issueRow(cycId);
    assert.strictEqual(afterReopen.status, '开发中', '[C6回环④] 单已回到开发中');
    assert.strictEqual(afterReopen.release_id, null, '[C6回环④] release_id 已清空（脱离旧批次）');
    assert.strictEqual(afterReopen.released_at, null, '[C6回环④] released_at 已清空');
    const afterReopenFull = await get('SELECT closed_at, reopen_count, reopened_at FROM sys_issues WHERE id=?', [cycId]);
    assert.strictEqual(afterReopenFull.closed_at, null, '[C6回环④] closed_at 已清空');
    assert.strictEqual(afterReopenFull.reopen_count, 1, '[C6回环④] reopen_count=1');
    assert.ok(afterReopenFull.reopened_at, '[C6回环④] reopened_at 已盖');

    // 红线核对：旧 release 本身完全未动（仍「已发布」），getReleaseMembers 仍稳定返回 snapshot 源、成员
    // 仍是发布时冻结值（status_at_publish 仍是「已上线」——不因 issue 当前已是「开发中」而变化/降级）。
    const relCycRowAfterReopen = await relRow(relCyc);
    assert.strictEqual(relCycRowAfterReopen.status, '已发布', '[C6回环] 红线：重开后旧 release 仍「已发布」（未被拖回计划中）');
    const gmAfterReopen = await I.getReleaseMembers({ id: relCyc, status: '已发布' });
    assert.strictEqual(gmAfterReopen.source, 'snapshot', '[C6回环] 红线核心：重开后旧 release 的 getReleaseMembers 仍 source=snapshot（未降级）');
    assert.strictEqual(gmAfterReopen.degraded, false, '[C6回环] 红线：重开后旧 release 读取仍非降级');
    assert.strictEqual(gmAfterReopen.members.length, 1, '[C6回环] 红线：旧 release 快照成员数不变');
    assert.strictEqual(gmAfterReopen.members[0].status_at_publish, '已上线', '[C6回环] 红线：快照里的 status_at_publish 仍冻结为「已上线」（issue 当前已是开发中，快照值不随之改变）');
    assert.deepStrictEqual(gmAfterReopen, gmBefore, '[C6回环] 红线：重开前后旧 release 的 getReleaseMembers 返回值逐字段完全一致（不因 issue 重开而变化）');

    // 重新开发到待上线（estimate→submit→accept）。⚠️ reopen 不重置 dev_assignees 完成态（同 return 语义，
    //   见 verify-sys-multidev-members.js S10g「roster 完成态保留」）——本单首轮 submit 已把 dev(5) 的
    //   roster 行推成 'no_code'，直接再 submit 会撞 INVALID_STATUS（"已提交过或状态已变"）。正规重置手法
    //   =临时加协作解除 LAST_ASSIGNEE 限制→remove 旧完成态实例→re-add（完整范式见 verify-sys-bug-transitions.js
    //   "二轮"），但本文件聚焦 release/snapshot 隔离而非多开发 roster 机制（roster 机制已有独立 verify-sys-multidev-*
    //   系列全覆盖），故直接 SQL 把该行重置回 'pending'——只影响本测试无关注的 roster 完成态字段，不影响
    //   本用例真正验证的 release/snapshot/timeline 隔离逻辑。
    await run(`UPDATE sys_issue_dev_assignees SET dev_status='pending' WHERE issue_id=? AND user_id=5 AND removed_at IS NULL`, [cycId]);
    r13 = await call('POST', `/api/sys-issues/${cycId}/estimate`, devTok, { dev_estimated_at: futureEst(60), estimated_effort_days: 1 });
    assert.strictEqual(r13.status, 200, `[C6回环⑤] estimate 应 200, got ${r13.status}`);
    r13 = await call('POST', `/api/sys-issues/${cycId}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-25' }], self_tested: true, test_env_deployed: true });
    assert.strictEqual(r13.status, 200, `[C6回环⑤] submit 应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    r13 = await call('POST', `/api/sys-issues/${cycId}/accept`, adminTok, {});
    assert.strictEqual(r13.status, 200, `[C6回环⑤] accept 应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    assert.strictEqual((await issueRow(cycId)).status, '待上线', '[C6回环⑤] 重新走完流程后回到待上线');

    // 加入新批次（不能是旧批次——旧批次已「已发布」，add-issues 会因 RELEASE_NOT_PLANNING 409；须建新批次；
    //   本步同时验证"能成功加入新批次"——红线的另一半，release_id 清空后真放行 add-issues 的 IS NULL 条件）。
    const relCyc2 = (await call('POST', '/api/sys-releases', adminTok, { title: 'C6回环新批次' })).body.id;
    r13 = await call('POST', `/api/sys-releases/${relCyc2}/add-issues`, adminTok, { issue_ids: [cycId] });
    assert.strictEqual(r13.status, 200, `[C6回环⑥] 加入新批次应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    assert.strictEqual((await issueRow(cycId)).release_id, relCyc2, '[C6回环⑥] 已挂新批次');

    // 再发布（execute）：新批次真实发布。
    r13 = await publishRelease(relCyc2, { release_note: 'C6回环二次发布', version_tag: 'v-cyc-2' });
    assert.strictEqual(r13.status, 200, `[C6回环⑦] 再发布应 200, got ${r13.status} ${JSON.stringify(r13.body)}`);
    const afterSecondPublish = await issueRow(cycId);
    assert.strictEqual(afterSecondPublish.status, '已上线', '[C6回环⑦] 二次发布后单再次翻已上线');
    assert.strictEqual(afterSecondPublish.release_id, relCyc2, '[C6回环⑦] release_id=新批次（非旧批次）');

    // 新旧两 release 的快照/timeline 互不干扰：各自 ref_id 独立一份、各自 UNIQUE(release_id,issue_id) 独立一份。
    const gmOldFinal = await I.getReleaseMembers({ id: relCyc, status: '已发布' });
    const gmNewFinal = await I.getReleaseMembers({ id: relCyc2, status: '已发布' });
    assert.strictEqual(gmOldFinal.source, 'snapshot', '[C6回环⑧] 二次发布后旧 release 仍 snapshot（第三次读取仍稳定）');
    assert.strictEqual(gmNewFinal.source, 'snapshot', '[C6回环⑧] 新 release 也是 snapshot 源');
    assert.deepStrictEqual(gmOldFinal, gmBefore, '[C6回环⑧] 旧 release 的读取结果自始至终（首发/归档重开后/二次发布后）逐字段完全一致');
    assert.strictEqual(gmNewFinal.members.length, 1, '[C6回环⑧] 新 release 快照恰 1 个成员');
    assert.strictEqual(gmNewFinal.members[0].issue_id, cycId);

    const oldSnapCount = (await get('SELECT COUNT(*) AS n FROM sys_issue_release_commit_snapshots WHERE release_id=?', [relCyc])).n;
    const newSnapCount = (await get('SELECT COUNT(*) AS n FROM sys_issue_release_commit_snapshots WHERE release_id=?', [relCyc2])).n;
    assert.strictEqual(oldSnapCount, 1, '[C6回环⑧] 旧 release 快照表恰 1 行（未被二次发布覆盖/新增）');
    assert.strictEqual(newSnapCount, 1, '[C6回环⑧] 新 release 快照表独立恰 1 行');
    const oldTlCount = (await get(`SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE ref_id=? AND event_type='scope_change' AND action_code='release_published'`, [relCyc])).n;
    const newTlCount = (await get(`SELECT COUNT(*) AS n FROM sys_issue_timeline WHERE ref_id=? AND event_type='scope_change' AND action_code='release_published'`, [relCyc2])).n;
    assert.strictEqual(oldTlCount, 1, '[C6回环⑧] 旧 release 的 release_published timeline 恰 1 条（ref_id 隔离，未被二次发布污染）');
    assert.strictEqual(newTlCount, 1, '[C6回环⑧] 新 release 的 release_published timeline 独立恰 1 条');

    // 该单本身的 release timeline（event_type='release'）应有两条（两次真实发布各一条），按批次分别对应。
    const releaseTlRows = await all(`SELECT ref_id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release' ORDER BY id ASC`, [cycId]);
    assert.strictEqual(releaseTlRows.length, 2, '[C6回环⑧] 该单 release timeline 恰 2 条（两次真实发布各一条，两次上线史并存，方案 §6.6 明文）');
    assert.strictEqual(releaseTlRows[0].ref_id, relCyc, '[C6回环⑧] 第一条 release timeline 指向旧批次');
    assert.strictEqual(releaseTlRows[1].ref_id, relCyc2, '[C6回环⑧] 第二条 release timeline 指向新批次');

    ok('⭐ [C6·§6.5 完整回环] 发布→归档(close)→重开(reopen)→重新开发到待上线→加入新批次→再发布：全环逐环断言通过——重开后 release_id/released_at/closed_at 均 NULL + 能成功加入新批次 + 新旧两 release 的快照/timeline 互不干扰（各自 ref_id/UNIQUE 独立） + 旧 release 全程稳定返回 source=snapshot 成员为发布时冻结值（红线验证：release 从未被拖回「计划中」，两次上线史并存）');
  }

  // ── 10. A：自动号 MAX(后缀)+1 不碰撞（手填号落进自动空间且跳号）──────────
  r = await call('POST', '/api/sys-releases', adminTok, { release_no: `R-${ymd}-999` });
  assert.strictEqual(r.status, 201, '手填 R-日期-999（落进自动空间的跳号）成功');
  r = await call('POST', '/api/sys-releases', adminTok, {});
  assert.strictEqual(r.status, 201, '手填跳号后自动建仍 201（MAX+1 不撞 UNIQUE 不卡死）');
  assert.strictEqual(r.body.release_no, `R-${ymd}-1000`, '自动号=MAX(999)+1=1000, got ' + r.body.release_no);
  ok('A：手填跳号 R-日期-999 后自动号=R-日期-1000（MAX(后缀)+1 不碰撞、不卡死）');

  // ── 11. E：issue_ids 元素数上限（≤200，防 DoS）──────────
  const bigIds = Array.from({ length: 201 }, (_, k) => k + 1);
  r = await call('POST', `/api/sys-releases/${relB}/add-issues`, adminTok, { issue_ids: bigIds });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'TOO_MANY_ISSUES');
  ok('E：add-issues 超 200 → 400 TOO_MANY_ISSUES');
  r = await call('POST', `/api/sys-releases/${relB}/remove-issues`, adminTok, { issue_ids: bigIds });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'TOO_MANY_ISSUES');
  ok('E：remove-issues 超 200 → 400 TOO_MANY_ISSUES');

  // ── 12. release_id 三段断言（v1.6 §2.3 H-2 收口，通知改造 C3b 改写——旧 bug needs_release 语义已退场）──────────
  //   feature/improvement 已上线 ⟹ release_id NOT NULL（原样，本文件 1-9 节大量用例已隐含验证，此处显式断言收口）；
  //   ⚠️ bug 侧三段断言已随 v1.6 §2.3 改写：旧 needs_release 决定 release_id 归宿的语义整体退场（needs_release 转只读
  //   残留，见 verify-sys-bug-transitions.js [R1退场]）；新语义改由 execute-release 的 mode 决定（H-2）：
  //   mode=hotfix ⟹ release_id IS NULL 且 version_tag IS NULL（不建批次）；
  //   mode=publish ⟹ release_id IS NOT NULL 且 version_tag IS NOT NULL（建/复用批次）。
  //   两条新路径完整覆盖 + 越权矩阵见独立脚本 verify-sys-release-orchestration.js；本文件仅收口"release_id 是否为空"
  //   这一最终不变量，与本文件既有 release CRUD 断言同源保持在一处。
  {
    const seg1 = await get("SELECT COUNT(*) AS n FROM sys_issues WHERE type IN ('feature','improvement') AND status='已上线' AND release_id IS NULL");
    assert.strictEqual(seg1.n, 0, '三段断言①：feature/improvement 已上线 ⟹ release_id 全部非空');
    ok('release_id 三段断言①：type∈(feature,improvement) AND status=已上线 ⟹ release_id IS NOT NULL（全库扫描零违例）');

    // bug 段（C3 改造）：原 H-2 语义（execute-release mode=hotfix⟹release_id NULL 不建批次 / mode=publish⟹
    //   release_id 非空建批次）随该端点退场整体作废——新统一机制下 hotfix-publish **恒建批次**（is_hotfix=1
    //   的 release_kind='emergency' 批次，§6.1"自动建批次+一键完成"逐字未变，只是"一键"现在只到"安排上线"
    //   为止），不再存在"不建批次"的旁路分支，"mode 决定 release_id 归宿"这条不变量不复存在。改为单一
    //   断言：bug 经统一入口（hotfix-publish 建单+加单+抢占 → execute 真发布）⟹ release_id/version_tag
    //   均非空（与 feature/improvement 完全同构，佐证"全类型统一"）。
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'seg-bug', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const bugSeg = r.body.id;
    // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${bugSeg}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${bugSeg}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${bugSeg}/estimate`, devTok, { dev_estimated_at: futureEst(30) });
    await call('POST', `/api/sys-issues/${bugSeg}/submit`, devTok, { mode: 'commits', commits: [{ component: 'backend', commit_ref: 'c9-keep-batch-26' }], self_tested: true, test_env_deployed: true });
    await call('POST', `/api/sys-issues/${bugSeg}/accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${bugSeg}/hotfix-publish`, adminTok, { release_note: 'seg-bug 应急建单', executors: [5, 13] });
    assert.strictEqual(r.status, 200, `bug hotfix-publish 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.created_new, true, 'bug hotfix-publish created_new=true');
    const bugSegRelId = r.body.release_id;
    assert.ok(bugSegRelId, '三段断言②③合并：bug hotfix-publish 建单后 release_id 非空（恒建批次，无"不建批次"分支）');
    // 真正发布（execute）：C3 新模型——本批次在册执行人是 hotfix-publish 建单时写入的 [5,13]，把两行
    //   置 sent 后各自真实调用 execute 确认，验证 bug 走到已上线后 version_tag 落库。
    await run(`UPDATE sys_release_executors SET notify_status='sent', notified_at=datetime('now','localtime') WHERE release_id=? AND removed_at IS NULL`, [bugSegRelId]);
    const bugSegExecRows = await all(`SELECT id, user_id FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL`, [bugSegRelId]);
    const bugSegRow13 = bugSegExecRows.find(x => x.user_id === 13);
    const bugSegRow5 = bugSegExecRows.find(x => x.user_id === 5);
    // 303-M2（Opus 对抗审·全文扫描收口）：中间预确认不许静默吞——断言 13 号真成功且未提前触发发布。
    const rBugSegPre13 = await call('POST', `/api/sys-releases/${bugSegRelId}/execute`, liaisonTok, { executor_row_id: bugSegRow13.id });
    assert.strictEqual(rBugSegPre13.status, 200, `[bugSeg-pre]13号预确认期望 200, got ${rBugSegPre13.status} ${JSON.stringify(rBugSegPre13.body)}`);
    assert.strictEqual(rBugSegPre13.body.released, false, '[bugSeg-pre]13号预确认不该提前触发发布');
    const rExecSeg = await call('POST', `/api/sys-releases/${bugSegRelId}/execute`, devTok, { release_note: 'seg-bug 真发布', version_tag: 'vseg-bug', executor_row_id: bugSegRow5.id });
    assert.strictEqual(rExecSeg.status, 200, `bug execute 应 200, got ${rExecSeg.status} ${JSON.stringify(rExecSeg.body)}`);
    assert.strictEqual(rExecSeg.body.released, true, 'bug execute 最后一人确认触发真正发布');
    const rowSeg = await issueRow(bugSeg);
    assert.strictEqual(rowSeg.status, '已上线');
    assert.strictEqual(rowSeg.release_id, bugSegRelId, '三段断言②③合并：bug 已上线 ⟹ release_id 非空且=hotfix-publish 建的批次');
    const relSeg = await relRow(bugSegRelId);
    assert.strictEqual(relSeg.version_tag, 'vseg-bug', '三段断言②③合并：批次 version_tag 落库');
    assert.strictEqual(relSeg.status, '已发布', 'bug 批次已发布');
    ok('release_id 三段断言②③合并（C3"全类型统一"新语义）：type=bug 经统一入口 hotfix-publish+execute AND status=已上线 ⟹ release_id/version_tag 均非空（恒建批次，与 feature/improvement 完全同构，原"mode 决定是否建批次"的 H-2 语义随 execute-release 退场作废）');
  }

  // [codex 102 号 HIGH 回填 + C3 改造] RELEASE 守卫接线——真实路由负例①：零在册待上线单走真实发布入口
  //   /execute（legacy /publish 已 409 退场，改走中心守卫收窄后的唯一合法入口）→ 400 GATE_INVARIANT，
  //   且状态/批次/快照均未落库（早于批量 UPDATE 拦下，H-3 原子性精神）。[LOW-5 订正] 旧注释"中心守卫
  //   三前提（notify_status=sent ∧ 执行人本人 ∧ 资格）用 publishRelease() 直接 SQL 钉好在先"是改造前
  //   单列比对时代的描述，已过时——新模型下 publishRelease() 走的是真实两段子表流：PUT executors 真实
  //   建两人（executorId + 影子搭档）→ SQL 把两行 notify_status 置 sent（唯一保留的 SQL 捷径，跳过通知
  //   外呼这段与本用例无关的环节）→ 两人各自真实调用 /execute 确认到底，行级 CAS 五条件随之一并真实
  //   走过。[决策 7 三修同步更正引用] 原提及的"MED-1 在册人数闸（≥2）"已随执行人下限 2→1 整体删除
  //   （该闸不再存在，不是"变成≥1"，是这一步判序彻底没了——见 execute 路由头部注释），本用例的两人
  //   夹具与验证目标不受影响（两人本身仍是合法批次，只是不再依赖那道已删除的闸来"顺带"验证它）。
  //   故本用例命中的必然是"执行人闸全部通过之后"、
  //   `_publishReleaseCoreInTxn` 内部更深一层的 issue 级开发 roster 门禁（zeroRosterId 自己没有
  //   `sys_issue_dev_assignees` 行），而非被执行人闸提前挡下——与改造前 legacy /publish 直达 roster 门
  //   的验证目标一致。
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '零在册待上线单', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
    const zeroRosterId = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段，直接受理。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
    await call('POST', `/api/sys-issues/${zeroRosterId}/intake-accept`, adminTok, { risk_level: '二级' });
    // 手工快进到"待上线"但不建任何 roster 行（模拟脏数据/历史遗留单，正常业务流程不可达——非 submit 场景准备）。
    await run(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [zeroRosterId]);
    r = await call('POST', '/api/sys-releases', adminTok, { title: '零在册反例批次' });
    assert.strictEqual(r.status, 201, '零在册反例：建批次 201');
    const relZero = r.body.id;
    r = await call('POST', `/api/sys-releases/${relZero}/add-issues`, adminTok, { issue_ids: [zeroRosterId] });
    assert.strictEqual(r.status, 200, `零在册反例：加单应 200（add-issues 不查 roster）, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await publishRelease(relZero, { release_note: '零在册反例', version_tag: 'v0-roster' });
    assert.strictEqual(r.status, 400, `零在册反例：execute 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', '零在册反例：错误码 GATE_INVARIANT（RELEASE 守卫③层进族门禁）');
    const issueAfter = await issueRow(zeroRosterId);
    assert.strictEqual(issueAfter.status, '待上线', '零在册反例：⭐ 单状态未变（仍待上线，未落库已上线）');
    assert.strictEqual(issueAfter.released_at, null, '零在册反例：released_at 未落');
    const relAfter = await relRow(relZero);
    assert.strictEqual(relAfter.status, '计划中', '零在册反例：⭐ 批次状态未变（仍计划中，未落库已发布，无快照）');
    const tlZero = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [zeroRosterId]);
    assert.strictEqual(tlZero.length, 0, '零在册反例：release timeline 零残留');
    ok('[HIGH 回归①·C3 改造] 零在册待上线单真实入口 /execute → 400 GATE_INVARIANT，状态/批次/快照全零落库（RELEASE 守卫已接线，非 SSOT 有门代码没接的矛盾态；legacy /publish 已退场，验证目标转移到真实唯一入口）');
  }

  // [codex 102 号 HIGH 回填] 正例回归：既有发布路径（全员完成种子，本文件上方大量既有用例均已走真实 /assign→
  //   estimate→submit→accept 完整流程建立合法 roster）在本轮接线后全部保持通过——已由本文件整体 EXIT:0 证实，
  //   不额外重复断言（守卫对"在册≥1∧无 pending"的合法批次天然放行，零回归）。

  // ── [C4 合并修复批 275-M5] 真实 ⑦ 路径代表夹具——建批次+加单+发布，跑本文件核心代表性下游断言 ──
  {
    const idReal = await seedToReadyViaRealLiaisonTest();
    let r = await call('POST', '/api/sys-releases', adminTok, { title: '275-M5 真实⑦路径批次' });
    assert.strictEqual(r.status, 201, '[275-M5] 建批次 201, got ' + r.status);
    const relReal = r.body.id;
    r = await call('POST', `/api/sys-releases/${relReal}/add-issues`, adminTok, { issue_ids: [idReal] });
    assert.strictEqual(r.status, 200, '[275-M5] 加单应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual((await issueRow(idReal)).release_id, relReal, '[275-M5] 加单后 release_id 绑批次');
    r = await publishRelease(relReal, { release_note: '275-M5 真实⑦路径发布', version_tag: 'v275m5' });
    assert.strictEqual(r.status, 200, '[275-M5] 发布应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const issueAfterReal = await issueRow(idReal);
    assert.strictEqual(issueAfterReal.status, '已上线', '[275-M5] 发布后单据状态=已上线');
    assert.strictEqual(issueAfterReal.release_id, relReal, '[275-M5] release_id 保持绑定');
    ok('[275-M5] 真实⑦路径代表夹具：submit→待对接测试→liaison-test-pass→待验证→accept→待上线，全走真实链路（非 999999 降级）后，建批次/加单/发布三条本文件核心代表性断言仍成立（防正常主路径跨模块回归被全 ⑥ 化的夹具集合掩盖）');
  }

  console.log(`\n✅ verify-sys-release 全部通过（${passed} 项断言）`);
  server.close();
}

main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
