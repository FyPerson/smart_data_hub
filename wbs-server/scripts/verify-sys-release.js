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

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: run, dbGetAsync: get, dbAllAsync: all,
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

// 把一张 feature 单推到「待上线」（create→schedule→assign→estimate→submit→accept）。
//   D（codex L-1）：固定指派 dev(id=5)、estimate/submit 用 devTok——ownerGuard 严格本人，admin 不能代开发提交，
//   不再保留 adminTok 误导分支。
async function seedToReady() {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部' });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, {});
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, { mode: 'no_code', no_code_reason: '交付完成（占位理由）' });
  assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
  assert.strictEqual(r.status, 200, 'accept 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  const row = await get('SELECT status, release_id FROM sys_issues WHERE id=?', [id]);
  assert.strictEqual(row.status, '待上线', 'seed 后应为待上线');
  assert.strictEqual(row.release_id, null, 'seed 后 release_id NULL');
  return id;
}
const issueRow = (id) => get('SELECT status, release_id, released_at FROM sys_issues WHERE id=?', [id]);
const relRow = (id) => get('SELECT status, release_no, is_hotfix, release_note, version_tag, released_at FROM sys_releases WHERE id=?', [id]);

// C3（上线体统一重构）后端批改造：legacy /sys-releases/:id/publish 现全类型 409（LEGACY_RELEASE_FLOW_DISABLED，
//   见 index.js 路由处注释），唯一合法发布入口收窄为 /sys-releases/:id/execute（中心守卫要求
//   notify_status='sent' ∧ release_assignee_id===actor.id ∧ 实时资格）。本文件 §4-6/§9/§12 关注的是
//   _publishReleaseCoreInTxn 内核本身的校验/原子性行为（release_note 闸门/成员非空/全待上线/roster 门/
//   timeline/批次翻已发布），不关心"怎么走到可执行态"这段——直接 SQL 把中心守卫三前提钉好（同
//   verify-sys-mutex.js 并发 execute 用例同款手法），再调真实 /execute，内核校验/写入逻辑逐字未变，
//   验证目标不受影响。默认执行人=dev(5)，与本文件既有 devTok 常量一致。
async function publishRelease(relId, body, executorId = 5, executorTok = devTok, executorName = '开发王') {
  await run(
    `UPDATE sys_releases SET release_assignee_id=?, release_assignee_name=?, release_assignee_notify_status='sent'
       WHERE id=?`,
    [executorId, executorName, relId]
  );
  return call('POST', `/api/sys-releases/${relId}/execute`, executorTok, body);
}

async function main() {
  mod.initSchema();
  await waitReady();
  // status/phone/dingtalk_user_id 列：C3 后端批改造后大量用例改走 /sys-releases/:id/execute（中心守卫要走
  //   hasReleaseEligibility(userId)：SELECT status, role）+ §7 hotfix-publish 首次调用真走 notify-executor
  //   同款抢占+外呼服务（sendReleaseNotifyAndWriteback：SELECT id, display_name, phone, dingtalk_user_id）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status) VALUES (1,'admin','管理员','admin','active'),(5,'dev','开发王','user','active')`);
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
  const draftId = (await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 'd', system_name: 'BMS', source: '内部' })).body.id;
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
  //   helper 已同步把中心守卫三前提钉好，测试目标——release_note 闸门本身——不受影响）
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
  assert.strictEqual(r.body.count, 2); assert.deepStrictEqual(r.body.released.sort(), [i1, i2].sort());
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
  r = await publishRelease(relA, { release_note: 'x', version_tag: 'y' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_NOT_PLANNING');
  ok('已发布批次再发布 → 409 RELEASE_NOT_PLANNING');
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

  // ── 7. hotfix-publish（C3 重写：§6.7 两阶段语义 + 7 态响应表 + 并发首次调用）──────────
  //   ⚠️ 断言反转（收窄后"返回即已安排"语义）：hotfix-publish 不再直接翻已上线（那是第①阶段建单+加单+
  //   抢占发送权，真正发布要等被通知的值班执行人调用 /execute）——响应 200（非 201）+ 统一字段
  //   release_id/notify_status/created_new/notification_attempted。
  const todayRow = await get("SELECT date('now','localtime') AS d");
  const today = todayRow.d;

  // [7-前置·抢占失败回滚·C3 裁定修正 2026-07-29] 方案 §6.7 首段字面：①阶段"建单+加单+抢占发送权"是
  //   原子提交——抢占失败（当日无在册值班人）= ①整体失败，须回滚本次新建的批次+绑单，409，不留
  //   not_sent 悬单（"不回滚建单"字面只限定②外部通知失败，不覆盖①阶段内的抢占失败）。此刻尚未插入
  //   今日排班行，天然满足"无在册值班人"这一抢占失败前提，验证目标=库内零残留（真回滚发生）。
  const noRosterCountBefore = await get(`SELECT COUNT(*) AS c FROM sys_releases`);
  const hfNoRoster = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hfNoRoster}/hotfix-publish`, adminTok, { release_note: '紧急修复（无排班）', version_tag: 'v2.0.0-noroster' });
  assert.strictEqual(r.status, 409, `[7-前置] 无排班应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'NO_ELIGIBLE_DUTY_ROSTER', '[7-前置] code=NO_ELIGIBLE_DUTY_ROSTER');
  assert.strictEqual(r.body.release_id, null, '[7-前置] 响应字段完整但置空：release_id=null');
  assert.strictEqual(r.body.notify_status, null, '[7-前置] notify_status=null');
  assert.strictEqual(r.body.created_new, false, '[7-前置] created_new=false');
  assert.strictEqual(r.body.notification_attempted, false, '[7-前置] notification_attempted=false');
  const noRosterCountAfter = await get(`SELECT COUNT(*) AS c FROM sys_releases`);
  assert.strictEqual(noRosterCountAfter.c, noRosterCountBefore.c, '[7-前置] 库内零残留：sys_releases 未新增行（①阶段整体回滚，真回滚发生）');
  const hfNoRosterIssueRow = await get('SELECT status, release_id FROM sys_issues WHERE id=?', [hfNoRoster]);
  assert.strictEqual(hfNoRosterIssueRow.status, '待上线', '[7-前置] issue 状态未变（仍待上线）');
  assert.strictEqual(hfNoRosterIssueRow.release_id, null, '[7-前置] issue release_id 仍 NULL（未绑单，回滚生效）');
  ok('[7-前置] 抢占失败（当日无在册值班人）：409 NO_ELIGIBLE_DUTY_ROSTER，库内零残留（sys_releases 无新增 + issue 状态/release_id 未变，①阶段原子回滚，不留 not_sent 悬单）');

  // 补排班后重试同一 issue：验证 409 后幂等可重来（issue 未被"报废"，回滚彻底可重新发起）。
  await run(
    `INSERT INTO sys_release_duty_roster (duty_date, user_id, user_name, created_by, created_by_name) VALUES (?, 5, '开发王', 1, '管理员')`,
    [today]
  );
  r = await call('POST', `/api/sys-issues/${hfNoRoster}/hotfix-publish`, adminTok, { release_note: '紧急修复（补排班重试）', version_tag: 'v2.0.0-retry' });
  assert.strictEqual(r.status, 200, `[7-前置-重试] 补排班后重试应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, true, '[7-前置-重试] created_new=true（同一 issue 重新真建单）');
  assert.strictEqual(r.body.notification_attempted, true, '[7-前置-重试] notification_attempted=true（排班已补，抢占+外呼真走通）');
  assert.strictEqual(r.body.notify_status, 'sent', '[7-前置-重试] notify_status=sent');
  ok('[7-前置-重试] 补排班后重试同一 issue：200 created_new=true 全链走通（验证 409 回滚彻底，issue 可重新发起应急上线，非报废态）');

  // [7-①] 无 release_id：200·新建单+抢占+发通知（当日有排班·stub sendIssueDingtalkRaw 恒成功）
  const hf = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '紧急修复', version_tag: 'v2.0.1' });
  assert.strictEqual(r.status, 200, `[7-①] hotfix 应 200（C3 收窄，非 201）, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, true, '[7-①] created_new=true');
  assert.strictEqual(r.body.notification_attempted, true, '[7-①] notification_attempted=true（当日有排班，真走了抢占+外呼）');
  assert.strictEqual(r.body.notify_status, 'sent', '[7-①] notify_status=sent（stub 发送恒成功）');
  const hfIssue = await issueRow(hf);
  assert.strictEqual(hfIssue.status, '待上线', '[7-①] 单仍停在待上线（两阶段语义，未直接翻已上线）');
  assert.ok(hfIssue.release_id, '[7-①] hotfix issue 挂上自动批次');
  const hfRel = await get('SELECT is_hotfix, release_kind, status, release_note, release_assignee_id, release_assignee_notify_status AS ns, planned_date FROM sys_releases WHERE id=?', [hfIssue.release_id]);
  assert.strictEqual(hfRel.is_hotfix, 1, '[7-①] hotfix 批次 is_hotfix=1');
  assert.strictEqual(hfRel.release_kind, 'emergency', '[7-①] release_kind=emergency（§6.12 emergency_display 口径）');
  assert.strictEqual(hfRel.status, '计划中', '[7-①] 批次仍计划中（未发布）');
  assert.strictEqual(hfRel.release_note, '紧急修复');
  assert.strictEqual(hfRel.release_assignee_id, 5, '[7-①] 抢占成功，执行人=当日排班 dev5');
  assert.strictEqual(hfRel.ns, 'sent');
  assert.strictEqual(hfRel.planned_date, today, '[7-①] planned_date=建单当日（供抢占查排班）');
  ok('[7-①] 无 release_id：200·新建单+加单+抢占发送权+外呼成功（created_new=true/notification_attempted=true/notify_status=sent），单仍待上线（两阶段，真正发布要等 /execute）');

  // [7-②] 应急单 sending/sent：200 幂等·不重发
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用', version_tag: 'v9' });
  assert.strictEqual(r.status, 200, `[7-②] sent 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.created_new, false, '[7-②] created_new=false');
  assert.strictEqual(r.body.notification_attempted, false, '[7-②] notification_attempted=false（本端点不重发）');
  assert.strictEqual(r.body.idempotent, true, '[7-②] idempotent=true');
  assert.strictEqual(r.body.release_id, hfIssue.release_id, '[7-②] release_id 与首次一致（未建新批次）');
  await run(`UPDATE sys_releases SET release_assignee_notify_status='sending' WHERE id=?`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用2' });
  assert.strictEqual(r.status, 200, `[7-②] sending 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.idempotent, true, '[7-②] sending 态同样幂等标记');
  await run(`UPDATE sys_releases SET release_assignee_notify_status='sent' WHERE id=?`, [hfIssue.release_id]);   // 复原
  ok('[7-②] 应急单 sending/sent：200 幂等·返回现状·不重发（created_new=false/notification_attempted=false）');

  // [7-③] 应急单 failed/stale：200·返回现状 + 提示「请用『安排上线』重试」
  await run(`UPDATE sys_releases SET release_assignee_notify_status='failed', release_assignee_notify_error='模拟失败' WHERE id=?`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用3' });
  assert.strictEqual(r.status, 200, `[7-③] failed 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.notify_status, 'failed', '[7-③] 返回现状 notify_status=failed');
  assert.strictEqual(r.body.notification_attempted, false, '[7-③] 不重发');
  assert.ok(/安排上线/.test(r.body.hint || '') && /重试/.test(r.body.hint || ''), '[7-③] hint 提示走「安排上线」重试');
  ok('[7-③] 应急单 failed：200·返回现状 + hint 提示「安排上线」重试，本端点不重发');

  // [7-③b·对抗审"假绿猎手"视角裁定必修 D] 应急单 stale：独立真实调用验证——不满足于"stale 在代码里与
  //   failed 走同一 ternary 分支"这一静态读代码推断，必须真实调一次 hotfix-publish 验证响应确实如此。
  //   stale 本身如何产生（sending 悬挂超阈值的惰性转换）已在 verify-sys-release-batch.js ⑪「崩溃恢复链」
  //   组真实覆盖，此处不重复造"时间流逝"夹具，直接 SQL 落 stale 结果态，只关心 hotfix-publish 面对这个
  //   状态的响应本身。
  await run(`UPDATE sys_releases SET release_assignee_notify_status='stale', release_assignee_notify_error=NULL WHERE id=?`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用3b' });
  assert.strictEqual(r.status, 200, `[7-③b] stale 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.release_id, hfIssue.release_id, '[7-③b] release_id 不变（仍指向同一应急单，未误建新单）');
  assert.strictEqual(r.body.notify_status, 'stale', '[7-③b] 返回现状 notify_status=stale');
  assert.strictEqual(r.body.created_new, false, '[7-③b] created_new=false（重复调用非首次）');
  assert.strictEqual(r.body.notification_attempted, false, '[7-③b] 不重发（本端点一律不自动重发）');
  assert.ok(/安排上线/.test(r.body.hint || '') && /重试/.test(r.body.hint || ''), '[7-③b] hint 提示走「安排上线」重试');
  ok('[7-③b] 应急单 stale：200·release_id 不变/notify_status=stale/created_new=false/notification_attempted=false + hint「安排上线」重试——独立真实调用验证（此前仅测 failed，stale 只能靠"代码同分支"推断，未有真实调用逐项断言）');

  // [7-④·v3.4 新增] 应急单 not_sent（cancel-schedule/加单/移单/改日期均会重置到此态，此处用 SQL 模拟）：
  //   200·返回现状 + 提示「请用『安排上线』重新发送」
  await run(`UPDATE sys_releases SET release_assignee_id=NULL, release_assignee_name=NULL, release_assignee_notify_status='not_sent', release_assignee_notify_error=NULL WHERE id=?`, [hfIssue.release_id]);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '重复调用4' });
  assert.strictEqual(r.status, 200, `[7-④] not_sent 重复调用应 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.notify_status, 'not_sent', '[7-④] 返回现状 notify_status=not_sent');
  assert.strictEqual(r.body.notification_attempted, false, '[7-④] 不自动重发');
  assert.ok(/安排上线/.test(r.body.hint || '') && /重新发送/.test(r.body.hint || ''), '[7-④] hint 提示走「安排上线」重新发送');
  ok('[7-④·v3.4新增] 应急单 not_sent：200·返回现状 + hint 提示「安排上线」重新发送（可达：cancel-schedule/加单/移单/改期均会重置到此态）');

  // [7-⑤] 应急单已发布：409（真正走完 execute 发布，需先恢复 sent 态并补在册开发行满足 RELEASE 中心守卫）
  await run(`UPDATE sys_releases SET release_assignee_id=5, release_assignee_name='开发王', release_assignee_notify_status='sent' WHERE id=?`, [hfIssue.release_id]);
  const rExecHf = await call('POST', `/api/sys-releases/${hfIssue.release_id}/execute`, devTok, { release_note: '紧急修复真发布' });
  assert.strictEqual(rExecHf.status, 200, `[7-⑤前置] execute 真发布应 200, got ${rExecHf.status} ${JSON.stringify(rExecHf.body)}`);
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '已发布后重试' });
  assert.strictEqual(r.status, 409, `[7-⑤] 应急单已发布应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'ISSUE_ALREADY_RELEASED', '[7-⑤] code=ISSUE_ALREADY_RELEASED');
  ok('[7-⑤] 应急单已发布：409 ISSUE_ALREADY_RELEASED（任务已上线，不可再建应急单）');

  // [7-⑥] 非应急上线单（普通单，即已挂入 relB 这种 admin 建的常规批次）：409（请勿混用应急口）
  const normalMember = await seedToReady();
  await call('POST', '/api/sys-releases', adminTok, { title: '普通批次-混用测试' });
  const relNormal = (await get("SELECT id FROM sys_releases WHERE title='普通批次-混用测试'")).id;
  await call('POST', `/api/sys-releases/${relNormal}/add-issues`, adminTok, { issue_ids: [normalMember] });
  r = await call('POST', `/api/sys-issues/${normalMember}/hotfix-publish`, adminTok, { release_note: '混用测试' });
  assert.strictEqual(r.status, 409, `[7-⑥] 混用应急口应 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.code, 'ISSUE_IN_NON_EMERGENCY_RELEASE', '[7-⑥] code=ISSUE_IN_NON_EMERGENCY_RELEASE');
  ok('[7-⑥] 任务已在非应急（普通）上线单中：409 ISSUE_IN_NON_EMERGENCY_RELEASE（请勿混用应急口）');

  // [7-⑦] 并发首次调用：仅一方建单；败方回滚并返回赢家 release_id（同响应形状，created_new=false）
  const concurId = await seedToReady();
  const [c1, c2] = await Promise.all([
    call('POST', `/api/sys-issues/${concurId}/hotfix-publish`, adminTok, { release_note: '并发A' }),
    call('POST', `/api/sys-issues/${concurId}/hotfix-publish`, adminTok, { release_note: '并发B' }),
  ]);
  assert.strictEqual(c1.status, 200); assert.strictEqual(c2.status, 200, `并发双方应均 200, got ${c1.status}/${c2.status}`);
  const winners = [c1, c2].filter(r2 => r2.body.created_new === true);
  const losers = [c1, c2].filter(r2 => r2.body.created_new === false);
  assert.strictEqual(winners.length, 1, `[7-⑦] 恰一方 created_new=true，实际 ${winners.length}`);
  assert.strictEqual(losers.length, 1, `[7-⑦] 恰一方 created_new=false（败方），实际 ${losers.length}`);
  assert.strictEqual(losers[0].body.release_id, winners[0].body.release_id, '[7-⑦] 败方返回赢家的 release_id');
  const concurReleases = await all("SELECT id FROM sys_releases WHERE title=?", [`hotfix #${concurId}`]);
  assert.strictEqual(concurReleases.length, 1, '[7-⑦] 库内仅 1 条应急批次（败方新建的已回滚，无残留）');
  ok('[7-⑦] 并发首次调用：仅一方 created_new=true 真建单，败方 created_new=false 返回赢家 release_id，库内零残留（BEGIN IMMEDIATE 重读抢占）');

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
  r = await call('POST', `/api/sys-issues/${hf2}/hotfix-publish`, adminTok, { version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  const releasesCountAfter1 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  assert.strictEqual(releasesCountAfter1, releasesCountBefore1, '缺说明 400 后 sys_releases 计数不变（未建任何批次）');
  const hf2Row = await issueRow(hf2);
  assert.strictEqual(hf2Row.status, '待上线', '缺说明 400 后 issue 状态仍待上线（未被误动）');
  assert.strictEqual(hf2Row.release_id, null, '缺说明 400 后 issue release_id 仍 NULL（未绑单）');
  const hf2TimelineCountAfter = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [hf2])).c;
  assert.strictEqual(hf2TimelineCountAfter, hf2TimelineCountBefore, '缺说明 400 后该单 timeline 计数不变（无新增，零副作用；本身已有的 assign/estimate/submit/accept 等历史行不受影响）');
  ok('hotfix 缺上线说明 → 400，库内零残留（sys_releases 计数不变 + issue 状态/release_id 未动 + timeline 计数不变）');
  // hotfix config → CONFIG_NO_RELEASE（用上面 cfgId，状态待上线）
  const releasesCountBefore2 = (await get(`SELECT COUNT(*) AS c FROM sys_releases`)).c;
  const cfgTimelineCountBefore = (await get(`SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?`, [cfgId])).c;
  r = await call('POST', `/api/sys-issues/${cfgId}/hotfix-publish`, adminTok, { release_note: 'a', version_tag: 'b' });
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
  r = await call('GET', '/api/sys-releases', devTok, null);
  assert.strictEqual(r.status, 200, `非 admin 看批次列表 → 200 mine 视角, got ${r.status}`);
  assert.strictEqual(r.body.scope, 'mine', '普通用户 scope=mine');
  assert.ok(r.body.items.length >= 1, 'mine 视角至少含刚插入的本人批次（非空数组，every 真实咬合）');
  assert.ok(r.body.items.every(x => Number(x.release_assignee_id) === 5), 'mine 视角只含"执行人=我"的行（夹具中另有多条他人/无执行人批次被过滤掉）');
  assert.ok(r.body.items.some(x => x.release_no === 'R-MINE-5'), '本人批次真实返回');
  ok('非 admin 看批次列表 → 200 mine 过滤（正例非空 + 他人批次被滤·执行人入口批新契约）');

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
    r13 = await call('POST', `/api/sys-issues/${cycId}/estimate`, devTok, { dev_estimated_at: '2026-09-01 10:00' });
    assert.strictEqual(r13.status, 200, `[C6回环⑤] estimate 应 200, got ${r13.status}`);
    r13 = await call('POST', `/api/sys-issues/${cycId}/submit`, devTok, { mode: 'no_code', no_code_reason: '缺陷已修复（占位理由）' });
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
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'seg-bug', system_name: 'BMS', source: '内部' });
    const bugSeg = r.body.id;
    // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${bugSeg}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${bugSeg}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${bugSeg}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    await call('POST', `/api/sys-issues/${bugSeg}/submit`, devTok, { mode: 'no_code', no_code_reason: '修复（占位理由）' });
    await call('POST', `/api/sys-issues/${bugSeg}/accept`, adminTok, {});
    r = await call('POST', `/api/sys-issues/${bugSeg}/hotfix-publish`, adminTok, { release_note: 'seg-bug 应急建单' });
    assert.strictEqual(r.status, 200, `bug hotfix-publish 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.created_new, true, 'bug hotfix-publish created_new=true');
    const bugSegRelId = r.body.release_id;
    assert.ok(bugSegRelId, '三段断言②③合并：bug hotfix-publish 建单后 release_id 非空（恒建批次，无"不建批次"分支）');
    // 真正发布（execute）：直接 SQL 满足中心守卫三前提（同本文件 publishRelease 手法），验证 bug 走到已上线后 version_tag 落库。
    await run(`UPDATE sys_releases SET release_assignee_id=5, release_assignee_name='开发王', release_assignee_notify_status='sent' WHERE id=?`, [bugSegRelId]);
    const rExecSeg = await call('POST', `/api/sys-releases/${bugSegRelId}/execute`, devTok, { release_note: 'seg-bug 真发布', version_tag: 'vseg-bug' });
    assert.strictEqual(rExecSeg.status, 200, `bug execute 应 200, got ${rExecSeg.status} ${JSON.stringify(rExecSeg.body)}`);
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
  //   且状态/批次/快照均未落库（早于批量 UPDATE 拦下，H-3 原子性精神）。中心守卫三前提（notify_status=
  //   sent ∧ 执行人本人 ∧ 资格）用 publishRelease() 直接 SQL 钉好在先，故本用例命中的必然是"三前提之后"
  //   的 roster 门，而非被中心守卫提前挡下——与改造前 legacy /publish 直达 roster 门的验证目标一致。
  {
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: '零在册待上线单', system_name: 'BMS', source: '内部' });
    const zeroRosterId = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：变更流建单直落「待受理」，无需再走预沟通段，直接受理。
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${zeroRosterId}/intake-accept`, adminTok, {});
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

  console.log(`\n✅ verify-sys-release 全部通过（${passed} 项断言）`);
  server.close();
}

main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
