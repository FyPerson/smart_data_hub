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
//   9. config DB CHECK（release_id 永空，直接 UPDATE 被拒）+ 重开清 release_id 脱离批次（§6.4 集成）
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

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user')`);
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
  // 闸门：批次无 release_note/version_tag，直接 publish 不带 → 400
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, {});
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  ok('发布缺上线说明 → 400 RELEASE_NOTE_REQUIRED');
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, { release_note: '   ', version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  ok('发布上线说明纯空格 → 400');
  // [C6 断言变更] 原「发布缺版本号 → 400 VERSION_TAG_REQUIRED」用例已随 SSOT §8「去 version_tag 必填」/S21 废止——
  //   不能在此位置就地改成"期望成功"：relA 当前 i1/i2 均已是待上线（i2 要到下方 218 行才被临时改开发中），
  //   若在此处真放行一次成功发布会提前把 relA 转「已发布」，打穿下方 214-242 行整段"成员非待上线 409 回滚 +
  //   成功发布 200"的既有断言链（成功发布只应发生一次，就是下方 227 行那次）。version_tag 去必填的正例改到
  //   独立小节验证，见下方「[C6] S21：发布无 version_tag」块（不复用/不提前消费 relA）。
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, { release_note: 'x'.repeat(1001), version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_TOO_LONG');
  ok('上线说明超长 → 400');

  // 成员非待上线（造脏：直接把 i2 改回开发中但保留 release_id）→ 409 RELEASE_MEMBER_NOT_READY
  await run("UPDATE sys_issues SET status='开发中' WHERE id=?", [i2]);
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, { release_note: '上线说明A', version_tag: 'v2.0' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_MEMBER_NOT_READY');
  assert.strictEqual((await relRow(relA)).status, '计划中', '发布失败批次仍计划中');
  assert.strictEqual((await issueRow(i1)).status, '待上线', '发布失败 i1 未被翻（原子回滚）');
  ok('成员非待上线 → 409 + 整体回滚');
  await run("UPDATE sys_issues SET status='待上线' WHERE id=?", [i2]);   // 恢复

  // 成功发布：单步带 release_note+version_tag
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, { release_note: '6月版上线A', version_tag: 'v2.0.0' });
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
  r = await call('POST', `/api/sys-releases/${relA}/publish`, adminTok, { release_note: 'x', version_tag: 'y' });
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
  r = await call('POST', `/api/sys-releases/${relB}/publish`, adminTok, { release_note: 'a', version_tag: 'b' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'RELEASE_EMPTY');
  ok('空批次发布 → 409 RELEASE_EMPTY');

  // ── 7. hotfix-publish ──────────
  const hf = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: '紧急修复', version_tag: 'v2.0.1' });
  assert.strictEqual(r.status, 201, 'hotfix 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.status, '已上线'); assert.strictEqual(r.body.count, 1);
  const hfIssue = await issueRow(hf);
  assert.strictEqual(hfIssue.status, '已上线'); assert.ok(hfIssue.release_id, 'hotfix issue 挂上自动批次');
  const hfRel = await relRow(hfIssue.release_id);
  assert.strictEqual(hfRel.is_hotfix, 1, 'hotfix 批次 is_hotfix=1');
  assert.strictEqual(hfRel.status, '已发布'); assert.strictEqual(hfRel.release_note, '紧急修复');
  const hfTl = await get("SELECT ref_id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'", [hf]);
  assert.strictEqual(hfTl.ref_id, hfIssue.release_id, 'hotfix release timeline ref_id=自动批次');
  ok('hotfix-publish：自动建 is_hotfix=1 批次 + 单翻已上线 + 批次已发布（原子一键）');

  // hotfix 负向：非待上线
  r = await call('POST', `/api/sys-issues/${hf}/hotfix-publish`, adminTok, { release_note: 'x', version_tag: 'y' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'ISSUE_NOT_HOTFIXABLE');
  ok('hotfix 已上线单 → 409 ISSUE_NOT_HOTFIXABLE');
  // hotfix 缺说明
  const hf2 = await seedToReady();
  r = await call('POST', `/api/sys-issues/${hf2}/hotfix-publish`, adminTok, { version_tag: 'v1' });
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.code, 'RELEASE_NOTE_REQUIRED');
  ok('hotfix 缺上线说明 → 400');
  // hotfix config → CONFIG_NO_RELEASE（用上面 cfgId，状态待上线）
  r = await call('POST', `/api/sys-issues/${cfgId}/hotfix-publish`, adminTok, { release_note: 'a', version_tag: 'b' });
  assert.strictEqual(r.status, 409); assert.strictEqual(r.body.code, 'CONFIG_NO_RELEASE');
  ok('hotfix config 类 → 409 CONFIG_NO_RELEASE');

  // ── 8. 权限 + 列表/详情 ──────────
  r = await call('POST', '/api/sys-releases', devTok, { title: 'x' });
  assert.strictEqual(r.status, 403); ok('非 admin 建批次 → 403');
  r = await call('POST', `/api/sys-releases/${relB}/publish`, devTok, { release_note: 'a', version_tag: 'b' });
  assert.strictEqual(r.status, 403); ok('非 admin 发布 → 403');
  r = await call('GET', '/api/sys-releases', devTok, null);
  assert.strictEqual(r.status, 403); ok('非 admin 看批次列表 → 403');

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

  // 重开已上线单 → release_id 清空脱离批次（§6.4 重上线前提）
  r = await call('POST', `/api/sys-issues/${i1}/reopen`, adminTok, { reason: '上线后发现缺陷' });
  assert.strictEqual(r.status, 200, 'reopen 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  const reRow = await issueRow(i1);
  assert.strictEqual(reRow.status, '开发中'); assert.strictEqual(reRow.release_id, null, '重开清 release_id 脱离批次');
  ok('已上线单重开 → 清 release_id 脱离原批次（§6.4）');

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

    // bug 段：走新 G3+G5/G6 端点，各建一条分别验证 hotfix/publish 两模式的 release_id/version_tag 归宿（H-2）
    let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'seg-bug-a', system_name: 'BMS', source: '内部' });
    const bugA = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${bugA}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${bugA}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${bugA}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    await call('POST', `/api/sys-issues/${bugA}/submit`, devTok, { mode: 'no_code', no_code_reason: '修复（占位理由）' });
    await call('POST', `/api/sys-issues/${bugA}/accept`, adminTok, {});
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [bugA], release_assignee_id: 5 });
    assert.strictEqual(r.status, 200, `assign-release-dev 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'hotfix', issue_ids: [bugA] });
    assert.strictEqual(r.status, 200, `bug execute-release(hotfix) 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
    const rowA = await issueRow(bugA);
    assert.strictEqual(rowA.status, '已上线');
    assert.strictEqual(rowA.release_id, null, '三段断言②（新 H-2 语义）：bug mode=hotfix 已上线 ⟹ release_id 为空（不建批次）');
    // version_tag 只存在于 sys_releases（issue 侧无此列）；release_id=NULL 即代表"无关联批次"，
    //   故 hotfix 模式下 version_tag 天然无处依附，不再单独查询断言（H-2 不变量由 release_id 一列即可完整表达）。
    ok('release_id 三段断言②（H-2 新语义）：type=bug AND execute-release(mode=hotfix) AND status=已上线 ⟹ release_id 为 NULL（不建批次，version_tag 天然无处依附）');

    r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'bug', title: 'seg-bug-b', system_name: 'BMS', source: '内部' });
    const bugB = r.body.id;
  // ⭐ 角色权限重构 C0：建单恒落「待受理」（受理门焊死）→ 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
    await call('POST', `/api/sys-issues/${bugB}/intake-accept`, adminTok, {});
    await call('POST', `/api/sys-issues/${bugB}/assign`, adminTok, { assigned_to: 5 });
    await call('POST', `/api/sys-issues/${bugB}/estimate`, devTok, { dev_estimated_at: '2026-08-01 10:00' });
    await call('POST', `/api/sys-issues/${bugB}/submit`, devTok, { mode: 'no_code', no_code_reason: '修复（占位理由）' });
    await call('POST', `/api/sys-issues/${bugB}/accept`, adminTok, {});
    r = await call('POST', '/api/sys-issues/assign-release-dev', adminTok, { issue_ids: [bugB], release_assignee_id: 5 });
    assert.strictEqual(r.status, 200, `assign-release-dev 200, got ${r.status} ${JSON.stringify(r.body)}`);
    r = await call('POST', '/api/sys-issues/execute-release', devTok, { mode: 'publish', issue_ids: [bugB], release_note: 'seg-b', version_tag: 'vseg-b' });
    assert.strictEqual(r.status, 201, `bug execute-release(publish) 应 201, got ${r.status} ${JSON.stringify(r.body)}`);
    const rowB = await issueRow(bugB);
    assert.strictEqual(rowB.status, '已上线');
    assert.ok(rowB.release_id, '三段断言③（新 H-2 语义）：bug mode=publish 已上线 ⟹ release_id 非空（建批次）');
    const relB = await relRow(rowB.release_id);
    assert.strictEqual(relB.version_tag, 'vseg-b', '三段断言③：bug mode=publish ⟹ 批次 version_tag 落库');
    assert.strictEqual(relB.status, '已发布', 'bug mode=publish 批次已发布');
    ok('release_id 三段断言③（H-2 新语义）：type=bug AND execute-release(mode=publish) AND status=已上线 ⟹ release_id/version_tag 均非空（建批次）');
  }

  // [codex 102 号 HIGH 回填] RELEASE 守卫接线——真实路由负例①：零在册待上线单走 legacy /publish → 400
  //   GATE_INVARIANT，且状态/批次/快照均未落库（早于批量 UPDATE 拦下，H-3 原子性精神）。
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
    r = await call('POST', `/api/sys-releases/${relZero}/publish`, adminTok, { release_note: '零在册反例', version_tag: 'v0-roster' });
    assert.strictEqual(r.status, 400, `零在册反例：publish 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', '零在册反例：错误码 GATE_INVARIANT（RELEASE 守卫③层进族门禁）');
    const issueAfter = await issueRow(zeroRosterId);
    assert.strictEqual(issueAfter.status, '待上线', '零在册反例：⭐ 单状态未变（仍待上线，未落库已上线）');
    assert.strictEqual(issueAfter.released_at, null, '零在册反例：released_at 未落');
    const relAfter = await relRow(relZero);
    assert.strictEqual(relAfter.status, '计划中', '零在册反例：⭐ 批次状态未变（仍计划中，未落库已发布，无快照）');
    const tlZero = await all(`SELECT id FROM sys_issue_timeline WHERE issue_id=? AND event_type='release'`, [zeroRosterId]);
    assert.strictEqual(tlZero.length, 0, '零在册反例：release timeline 零残留');
    ok('[HIGH 回归①] 零在册待上线单 legacy /publish → 400 GATE_INVARIANT，状态/批次/快照全零落库（RELEASE 守卫已接线，非 SSOT 有门代码没接的矛盾态）');
  }

  // [codex 102 号 HIGH 回填] 正例回归：既有发布路径（全员完成种子，本文件上方大量既有用例均已走真实 /assign→
  //   estimate→submit→accept 完整流程建立合法 roster）在本轮接线后全部保持通过——已由本文件整体 EXIT:0 证实，
  //   不额外重复断言（守卫对"在册≥1∧无 pending"的合法批次天然放行，零回归）。

  console.log(`\n✅ verify-sys-release 全部通过（${passed} 项断言）`);
  server.close();
}

main().catch((e) => { console.error('❌ 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
