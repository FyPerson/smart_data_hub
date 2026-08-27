// 验证脚本：「待我处理」全角色卡 · Phase P Commit 2 —— GET /sys-issues 两个新派生列
//   my_dev_pending / is_my_intake_liaison（方案 20260825_v1.3 §3.1 + §6 断言 1-5 + N0-6b 增补）
//   用法：node scripts/verify-sys-my-pending-cols.js
//
// 覆盖组（方案 §6「后端 verify-sys-my-pending-cols.js」清单，逐条对应）：
//   [1] my_dev_pending 正例：在册 + dev_status='pending' → 1
//   [2] my_dev_pending 反例四条：removed_at 非空 / code_submitted / no_code / excused（最易写错）→ 均 0
//   [3] is_my_intake_liaison：intake_liaison_id=me→1 / 他人→0 / NULL→0
//   [4] NaN uid 退化：admin 角色但 JWT id 非数字 → 两列均 0/false，请求不报错（200）
//   [5] 参数边界两层：① 结构层——直调 _internals.buildSysIssuesListQuery 传彼此不同的哨兵值，断言
//       bindParams 恰为 [nowStr,uid,uid,uid,...whereParams]逐项、且 sql 的 ? 计数 === bindParams.length
//       （457-H2 冻结，禁用源码正则/运行结果反推代替）；② 行为层——真实带筛选请求，断言筛选生效且
//       WHERE 参数未被新增 SELECT 参数吞掉/错移
//   [6] 跨用户正反例：同一单，开发本人查得 1，另一用户（visibility 理由独立于开发身份=admin 全量可见）
//       查得 0——且先断言该用户的响应里确实包含这张单（防可见性过滤假通过，456-M1）
//   [7]「待处理」预指派场景（N0-6b 增补）：status='待处理' + 开发在册 pending → my_dev_pending=1
//       （列如实出数——状态门是前端谓词的事，本列只验 SQL 语义）
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-my-pending-cols-secret';
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

// 多角色 JWT 夹具：admin(1) / 开发甲(5) / 开发乙(6) / 无关他人(13)
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devATok = jwt.sign({ id: 5, username: 'devA', display_name: '开发甲', role: 'user' }, SECRET);
const devBTok = jwt.sign({ id: 6, username: 'devB', display_name: '开发乙', role: 'user' }, SECRET);
// [4] NaN uid 退化夹具：admin 角色（不触发 uid>0 前置守卫的 1=0 空集分支）但 id 非数字。
const adminBadIdTok = jwt.sign({ id: 'not-a-number', username: 'admin-baduid', display_name: '异常令牌管理员', role: 'admin' }, SECRET);
// [codex 466 MED-1] "数值但无效"的身份：0 与 -1 是 Number() 转得出、但业务上不存在的 uid（users 自增
//   id 恒 ≥1）——路由 uid 有效域归一后应与 NaN 同出口（绑 null→两列恒 0），撞上脏关联行也不产生待办信号。
const adminZeroIdTok = jwt.sign({ id: 0, username: 'admin-zero', display_name: '零号管理员', role: 'admin' }, SECRET);
const adminNegIdTok = jwt.sign({ id: -1, username: 'admin-neg', display_name: '负号管理员', role: 'admin' }, SECRET);

let server, port;
function call(method, p, tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Authorization': 'Bearer ' + tok } },
      (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

async function insertIssue({ type = 'improvement', status = '开发中', system = 'BMS', title, intakeLiaisonId = null }) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, intake_liaison_id)
     VALUES (?, ?, 'P2', ?, ?, '内部', 1, '管理员', ?)`,
    [type, status, title, system, intakeLiaisonId]
  );
  return r.lastID;
}
async function addRoster(issueId, userId, userName, devStatus, removed) {
  await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, removed_at)
     VALUES (?, ?, ?, 1, ?, ${removed ? "datetime('now')" : 'NULL'})`,
    [issueId, userId, userName, devStatus]
  );
}
function findItem(body, id) { return (body.items || []).find((x) => x.id === id); }

async function main() {
  mod.initSchema();
  await waitReady();

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise((res) => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness（admin1 / 开发甲5 / 开发乙6 / 异常令牌 admin）');

  // ═══ [1]+[2] my_dev_pending 正例 + 反例四条 ═══
  {
    const idPending = await insertIssue({ title: 'my_dev_pending 正例' });
    await addRoster(idPending, 5, '开发甲', 'pending', false);
    const rPending = await call('GET', '/api/sys-issues', devATok);
    assert.strictEqual(rPending.status, 200, `[1-前置] 开发甲列表请求应 200，实得 ${rPending.status}`);
    const itPending = findItem(rPending.body, idPending);
    assert.ok(itPending, '[1] 开发甲应可见该单（在册即可见）');
    assert.strictEqual(itPending.my_dev_pending, 1, `[1] 正例：在册+dev_status=pending → my_dev_pending 应为 1，实得 ${itPending.my_dev_pending}`);
    ok('[1] my_dev_pending 正例：在册（removed_at IS NULL）∧ 本人 ∧ dev_status=pending → 1');

    const NEG_CASES = [
      { key: 'removed', devStatus: 'pending', removed: true, label: 'removed_at 非空（已移除）' },
      { key: 'code_submitted', devStatus: 'code_submitted', removed: false, label: "dev_status='code_submitted'" },
      { key: 'no_code', devStatus: 'no_code', removed: false, label: "dev_status='no_code'" },
      { key: 'excused', devStatus: 'excused', removed: false, label: "dev_status='excused'（免除≠待办，最易写错）" },
    ];
    for (const c of NEG_CASES) {
      const id = await insertIssue({ title: `my_dev_pending 反例·${c.key}` });
      await addRoster(id, 5, '开发甲', c.devStatus, c.removed);
      const r = await call('GET', '/api/sys-issues', devATok);
      assert.strictEqual(r.status, 200, `[2-${c.key}-前置] 应 200，实得 ${r.status}`);
      const it = findItem(r.body, id);
      assert.ok(it, `[2-${c.key}] 开发甲应可见该单（在册/历史参与皆可见，rosterVisibilitySql 不筛 removed_at）`);
      assert.strictEqual(it.my_dev_pending, 0, `[2-${c.key}] 反例（${c.label}）→ my_dev_pending 应为 0，实得 ${it.my_dev_pending}`);
    }
    ok('[2] my_dev_pending 反例四条全部证否：removed_at 非空 / code_submitted / no_code / excused 均不算待办');
  }

  // ═══ [3] is_my_intake_liaison：me→1 / 他人→0 / NULL→0 ═══
  {
    const idMe = await insertIssue({ title: 'is_my_intake_liaison=me', intakeLiaisonId: 5 });
    const rMe = await call('GET', '/api/sys-issues', devATok);
    const itMe = findItem(rMe.body, idMe);
    assert.ok(itMe, '[3-me] 开发甲应可见该单（intake_liaison_id=本人，写读同源析取项）');
    assert.strictEqual(itMe.is_my_intake_liaison, 1, `[3-me] intake_liaison_id=me → 应为 1，实得 ${itMe.is_my_intake_liaison}`);

    // 他人绑定 + NULL 两种反例：均需给开发甲另一条独立可见性理由（roster 在册），否则请求根本看不到该单，
    //   会把"看不到"误判成"is_my_intake_liaison=0"（456-M1 同款防假通过）。
    const idOther = await insertIssue({ title: 'is_my_intake_liaison=他人(13)', intakeLiaisonId: 13 });
    await addRoster(idOther, 5, '开发甲', 'no_code', false);
    const idNull = await insertIssue({ title: 'is_my_intake_liaison=NULL', intakeLiaisonId: null });
    await addRoster(idNull, 5, '开发甲', 'no_code', false);
    const rOther = await call('GET', '/api/sys-issues', devATok);
    const itOther = findItem(rOther.body, idOther);
    assert.ok(itOther, '[3-他人] 开发甲应可见该单（roster 独立可见性理由，非靠 intake_liaison 析取）');
    assert.strictEqual(itOther.is_my_intake_liaison, 0, `[3-他人] intake_liaison_id=13（他人）→ 应为 0，实得 ${itOther.is_my_intake_liaison}`);
    const itNull = findItem(rOther.body, idNull);
    assert.ok(itNull, '[3-NULL] 开发甲应可见该单（roster 独立可见性理由）');
    assert.strictEqual(itNull.is_my_intake_liaison, 0, `[3-NULL] intake_liaison_id=NULL → 应为 0，实得 ${itNull.is_my_intake_liaison}`);
    ok('[3] is_my_intake_liaison：me→1 / 他人(13)→0 / NULL→0（他人与 NULL 两条均先证可见再判列值，防可见性假通过）');
  }

  // ═══ [4] NaN uid 退化：admin 角色但 id 非数字 → 两列均 0/false，不报错 ═══
  {
    const id = await insertIssue({ title: 'NaN uid 退化探针' });
    await addRoster(id, 5, '开发甲', 'pending', false);
    const r = await call('GET', '/api/sys-issues', adminBadIdTok);
    assert.strictEqual(r.status, 200, `[4] 异常令牌（admin 角色+非数字 id）请求应仍 200（不报错），实得 ${r.status} ${JSON.stringify(r.body)}`);
    const it = findItem(r.body, id);
    assert.ok(it, '[4] admin 角色天然全量可见，异常 id 不影响可见性分支');
    assert.strictEqual(it.my_dev_pending, 0, `[4] NaN uid → my_dev_pending 应退化为 0，实得 ${it.my_dev_pending}`);
    assert.strictEqual(it.is_my_intake_liaison, 0, `[4] NaN uid → is_my_intake_liaison 应退化为 0，实得 ${it.is_my_intake_liaison}`);
    ok('[4] NaN uid 退化：admin 角色+非数字 JWT id（Number()→NaN→绑定为 NULL）→ 两列均 0，请求不报错（200）');
  }

  // ═══ [5] 参数边界两层 ═══
  {
    // 第一层（结构）：直调 buildSysIssuesListQuery，彼此不同的哨兵值——解决"三个 uid 值相同⇒错位不可观测"。
    assert.strictEqual(typeof I.buildSysIssuesListQuery, 'function', '[5-前置] _internals.buildSysIssuesListQuery 应已导出');
    const whereSql = 'WHERE status = ? AND system_name = ?';
    const { sql, bindParams } = I.buildSysIssuesListQuery({
      nowStr: '__NOW__', uid: '__UID__', whereSql, whereParams: ['__W1__', '__W2__'],
    });
    assert.deepStrictEqual(bindParams, ['__NOW__', '__UID__', '__UID__', '__UID__', '__W1__', '__W2__'],
      `[5-结构] bindParams 应恰为 [__NOW__,__UID__,__UID__,__UID__,__W1__,__W2__]（完整顺序逐项），实得 ${JSON.stringify(bindParams)}`);
    // [codex 466 MED-2] ? 计数须语法感知：剥掉 SQL 行注释（-- 到行尾）与单引号字符串后再数——
    //   否则将来注释/字符串里出现问号会误报，且"真实占位符增减"与"注释问号增减"可互相抵消成假绿。
    // [codex 467 MED-3] 占位符计数用 SQLite 词法状态机（非正则模拟）：正则版"先剥注释"会把字符串
    //   字面量里的 -- 误判为行注释（如 'x--?' 吞掉后续真占位符）；SQLite 字符串转义是 ''（双写单引号）
    //   非反斜杠。状态机三态：字符串（'' 转义继续）／-- 行注释到行尾／/* */ 块注释，其外的 ? 才计数。
    const countPlaceholders = (text) => {
      let n = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text[i]; const c2 = text[i + 1];
        if (c === "'") { // 字符串态：扫到收尾单引号（'' 双写=转义继续）
          i++;
          while (i < text.length) {
            if (text[i] === "'") { if (text[i + 1] === "'") { i += 2; continue; } break; }
            i++;
          }
        } else if (c === '-' && c2 === '-') { // 行注释态
          while (i < text.length && text[i] !== '\n') i++;
        } else if (c === '/' && c2 === '*') { // 块注释态
          i += 2;
          while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
          i++;
        } else if (c === '?') { n++; }
      }
      return n;
    };
    const qMarkCount = countPlaceholders(sql);
    assert.strictEqual(qMarkCount, bindParams.length,
      `[5-结构] 剥注释/字符串后 sql 的 ? 计数应 === bindParams.length（${bindParams.length}），实得 ? 计数=${qMarkCount}`);
    ok('[5-结构] 哨兵值参数边界（457-H2）：buildSysIssuesListQuery 直调证明四个 SELECT 段参数 + 两个 WHERE 段参数完整顺序无错位、? 计数与 bindParams 长度恰好相等（禁用源码正则/运行结果反推代替本断言）');

    // 第二层（行为）：真实带筛选请求——断言筛选生效 + WHERE 参数未被新增 SELECT 参数吞掉/错移。
    const idHit = await insertIssue({ type: 'bug', status: '开发中', system: 'BMS', title: '筛选绑定探针·命中' });
    await addRoster(idHit, 5, '开发甲', 'pending', false);
    const idMiss = await insertIssue({ type: 'bug', status: '待验证', system: 'BMS', title: '筛选绑定探针·状态不同不应命中' });
    await addRoster(idMiss, 5, '开发甲', 'pending', false);
    const rFiltered = await call('GET', `/api/sys-issues?status=${encodeURIComponent('开发中')}&system=BMS`, devATok);
    assert.strictEqual(rFiltered.status, 200, `[5-行为] 带筛选请求应 200，实得 ${rFiltered.status}`);
    const hitInFiltered = findItem(rFiltered.body, idHit);
    const missInFiltered = findItem(rFiltered.body, idMiss);
    assert.ok(hitInFiltered, '[5-行为] 筛选命中的单应出现在结果里（筛选未被新参数吞掉）');
    assert.strictEqual(missInFiltered, undefined, '[5-行为] status 不同的单不应出现在筛选结果里（WHERE 参数未被新 SELECT 参数错移导致失效）');
    assert.strictEqual(hitInFiltered.my_dev_pending, 1, `[5-行为] 命中单本人在册 pending → my_dev_pending 应仍为 1（新增列参数未挤占筛选参数位），实得 ${hitInFiltered.my_dev_pending}`);
    ok('[5-行为] 带筛选真实请求：status+system 双筛选生效、命中单 my_dev_pending 仍正确（参数绑定未因新增两列而错位）');
  }

  // ═══ [6] 跨用户正反例（先证可见再判列值，456-M1 防假通过） ═══
  {
    const id = await insertIssue({ title: '跨用户正反例·开发乙在册' });
    await addRoster(id, 6, '开发乙', 'pending', false);
    const rDevB = await call('GET', '/api/sys-issues', devBTok);
    const itDevB = findItem(rDevB.body, id);
    assert.ok(itDevB, '[6-正例] 开发乙（本人即开发）应可见该单');
    assert.strictEqual(itDevB.my_dev_pending, 1, `[6-正例] 开发乙查自己：应为 1，实得 ${itDevB.my_dev_pending}`);
    const rAdmin = await call('GET', '/api/sys-issues', adminTok);
    const itAdmin = findItem(rAdmin.body, id);
    assert.ok(itAdmin, '[6-反例] admin 应可见该单（admin 全量可见性——独立于开发身份的可见理由，非碰巧看不到）');
    assert.strictEqual(itAdmin.my_dev_pending, 0, `[6-反例] admin（非该单开发）查看：应为 0，实得 ${itAdmin.my_dev_pending}`);
    ok('[6] 跨用户正反例：开发乙查自己=1，admin（全量可见但非开发）查同一单=0——均先断言目标单确实出现在响应里，防可见性过滤把"看不到"误判成"列正确为 0"');
  }

  // ═══ [7]「待处理」预指派场景（N0-6b 增补）═══
  {
    const id = await insertIssue({ type: 'bug', status: '待处理', title: '待处理预指派场景' });
    await addRoster(id, 5, '开发甲', 'pending', false);
    const r = await call('GET', '/api/sys-issues', devATok);
    assert.strictEqual(r.status, 200, `[7-前置] 应 200，实得 ${r.status}`);
    const it = findItem(r.body, id);
    assert.ok(it, '[7] 开发甲应可见该单（在册即可见）');
    assert.strictEqual(it.my_dev_pending, 1,
      `[7]「待处理」+ 开发在册 pending → my_dev_pending 列如实出数应为 1（状态门是前端 siIsMyPending 谓词的事，本列只验 SQL 语义不做状态过滤），实得 ${it.my_dev_pending}`);
    ok('[7]「待处理」预指派场景：列不做状态门控，如实反映"在册+pending"这一事实（N0-6b 增补——bug 流"待处理"结构上虽通常无在册行，但设计内预指派路径可产生，列语义仍需保持正确）');
  }

  // ═══ [9]（codex 466 MED-1）"数值但无效"uid × 脏关联行——两列不得产生待办信号 ═══
  //   脏行本身可造（历史导入/手工修库都可能留 user_id=0），异常 JWT 是外部输入；组合态下路由 uid
  //   归一（正安全整数外一律绑 null）应让两列恒 0。admin 全量可见性不受归一影响（仍能看到单）。
  {
    const idZero = await insertIssue({ type: 'bug', status: '开发中', title: '脏行探针·user_id=0', intakeLiaisonId: 0 });
    await addRoster(idZero, 0, '脏行零号', 'pending', false);
    const idNeg = await insertIssue({ type: 'bug', status: '开发中', title: '脏行探针·user_id=-1', intakeLiaisonId: -1 });
    await addRoster(idNeg, -1, '脏行负号', 'pending', false);
    // 脏夹具自证（S3 预筛提示4）：先证 0/-1 真以原值落库——若 helper 某天把 0 静默存成 NULL，
    //   下方"两列应 0"会空洞通过（假绿），本断言让夹具坏掉时红在这里而不是静默。
    const dirtyRows = await all('SELECT da.user_id AS ru, si.intake_liaison_id AS rl FROM sys_issue_dev_assignees da JOIN sys_issues si ON si.id = da.issue_id WHERE da.issue_id IN (?, ?) ORDER BY da.issue_id', [idZero, idNeg]);
    assert.deepStrictEqual(dirtyRows.map((r) => [r.ru, r.rl]), [[0, 0], [-1, -1]],
      `[9-夹具自证] 脏行应以原值 0/-1 落库（非 NULL 归一），实得 ${JSON.stringify(dirtyRows)}`);
    for (const [tok, tokName, targetId] of [[adminZeroIdTok, 'id=0', idZero], [adminNegIdTok, 'id=-1', idNeg]]) {
      const r = await call('GET', '/api/sys-issues', tok);
      assert.strictEqual(r.status, 200, `[9-${tokName}] 应 200，实得 ${r.status}`);
      const it = findItem(r.body, targetId);
      assert.ok(it, `[9-${tokName}] admin 全量可见性不受 uid 归一影响，应可见目标单`);
      assert.strictEqual(it.my_dev_pending, 0, `[9-${tokName}] 无效 uid 撞脏 roster 行：my_dev_pending 应 0，实得 ${it.my_dev_pending}`);
      assert.strictEqual(it.is_my_intake_liaison, 0, `[9-${tokName}] 无效 uid 撞脏 intake_liaison_id：is_my_intake_liaison 应 0，实得 ${it.is_my_intake_liaison}`);
    }
    ok('[9] 数值但无效 uid（0/-1）×脏关联行：路由归一后两列恒 0、admin 可见性不受影响（codex 466 MED-1）');
  }

  // ═══ [8] 静态唯一消费断言（Opus 预筛 S2 提示4·457-H2"路由唯一消费"从注释约束升为守卫钉死）═══
  //   哨兵组走 _internals 直调、行为组走 HTTP，都拦不住"有人在路由里复制一份内联 SQL 绕过纯函数"
  //   ——内联副本能跑通、badge-fields indexOf 取首个匹配也不会察觉。两条文本计数断言堵死这条河。
  {
    const fs = require('fs');
    const path = require('path');
    const idxSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');
    const callCount = (idxSrc.match(/buildSysIssuesListQuery\(/g) || []).length;
    assert.strictEqual(callCount, 2,
      `[8] buildSysIssuesListQuery( 在 index.js 应恰出现 2 处（定义 1 + 路由唯一调用 1），实得 ${callCount}——多出=有人绕过纯函数复制了查询`);
    const selectHeadCount = (idxSrc.match(/SELECT id, type, status, priority, risk_level/g) || []).length;
    assert.strictEqual(selectHeadCount, 1,
      `[8] 列表 SELECT 首行字面量应恰 1 处（buildSysIssuesListSelect 内），实得 ${selectHeadCount}——多出=存在内联副本`);
    // [codex 466 MED-3 部分采纳·文本级强化] "函数名 2 次+首行 1 次"防不了"保留无用调用+另拼 SQL"——
    //   再钉两条数据流锚：路由解构声明恰 1 + 该解构变量直交 dbAllAsync 恰 1。AST 断言不引入（守卫家族
    //   恒为文本+沙箱+HTTP 行为三层范式，行为组已对真实路由输出兜底，文本层把绕过成本抬到故意伪装级即可）。
    const destructCount = (idxSrc.match(/const \{ sql: sysIssuesListSql, bindParams: sysIssuesListBindParams \} = buildSysIssuesListQuery\(/g) || []).length;
    assert.strictEqual(destructCount, 1,
      `[8] 路由解构声明（sysIssuesListSql/sysIssuesListBindParams = buildSysIssuesListQuery(...)）应恰 1 处，实得 ${destructCount}`);
    const feedCount = (idxSrc.match(/dbAllAsync\(sysIssuesListSql, sysIssuesListBindParams\)/g) || []).length;
    assert.strictEqual(feedCount, 1,
      `[8] 解构变量直交 dbAllAsync(sysIssuesListSql, sysIssuesListBindParams) 应恰 1 处，实得 ${feedCount}`);
    ok('[8] 静态唯一消费：函数名恰"定义+唯一调用"+SELECT 首行恰 1+路由解构声明恰 1+解构变量直交 dbAllAsync 恰 1（457-H2 守卫化·466 MED-3 文本级强化）');
  }

  console.log(`\n✅ verify-sys-my-pending-cols 全部通过（${passed} 组·「待我处理」全角色卡 Phase P Commit 2 后端两列）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', (e && e.stack) || e); try { server && server.close(); } catch (_) { /* 进程即将退出 */ } process.exit(1); });
