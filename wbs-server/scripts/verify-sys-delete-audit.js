// 验证脚本：系统迭代 角色权限重构 C2a — 物理删除审计（方案 v1.7 §4-C2a）
//   用法：node scripts/verify-sys-delete-audit.js
//
// 背景（codex 167 号 HIGH-1）：`DELETE /sys-issues/:id` 是 admin 专用不可逆物删，且级联
//   `DELETE FROM sys_issue_timeline` 把审计链和单据一起抹掉 —— DB 内零痕迹，只有 PM2 应用日志
//   记了 username（会轮转 / 不可查询 / 非审计表）。端点注释「场景：admin **单人**清理测试/脏单」
//   是"系统里只有一个 admin"时代的化石，生产实为 6 个 active admin。
//   C2a 不改软删（改动面远大于收益），只解决"查得到谁删了什么"：删除事务内**先写审计再删业务行**。
//
// ⭐ 对抗审（Fable 三视角挖 + GPT 逐条核）F1/F7 收口后扩面：**按 issue_id 子表全集**校验，不再是"挑三张"。
//   带 issue_id 的子表共 6 张（timeline / attachments / dev_assignees / dev_commits / dev_events /
//   release_commit_snapshots）；此前级联只删 3 张、快照只存 3 份，且**两份清单还互不相同** ——
//   dev_assignees 删了没快照（连带把 C2b 的逐 dev notify_sent_by 一起抹掉），dev_commits/dev_events 既没删也没快照。
//
// 覆盖（每组都同时断"该发生的发生了"与"不该发生的没发生"）：
//   [S] schema：审计表进 SYS_REQUIRED_TABLES + 关键列全（**从 _internals 常量派生，不手抄第二份**）
//       + **不带 issue_id 外键**（它必须活得比业务行久）+ reason DB 层 CHECK
//   [V] reason 契约：缺失 / 空白 / 超长(201) → 400 VALIDATION，且**七表一行不少**（负例无副作用）
//   [D] 正常删除：200 + **七表全清** + 审计行落库，**八份快照可还原**且与计数逐一交叉一致
//       （含 dev 名册的软删历史行与逐人 notify_sent_by、commit 留痕、开发侧事件链、先行上线两步化执行人软删历史行）
//   [R] ⭐ 故障注入：审计 INSERT 失败 → **整体 rollback**，七表一行不少、审计表零行
//       （"删了但没记"在 sys 模块内被结构性排除；跨模块事务纠缠属 P3 架构债，见端点注释）
//   [G] 守卫拒删路径（派生子单 409 / 已挂批次 409 / 不存在 404）→ **不留审计行**（拒绝不是删除）
//   [P] 审计行不随业务级联删：删 A 后再删 B，A 的审计行仍在（本表不进任何级联清单）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-delete-audit-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// 一次性故障注入（复刻 verify-sys-intake-gate 范式）：证明审计 INSERT 与业务 DELETE 同处一个事务。
//   平时 injectFailureOnSql=null，runFI 行为与 run 完全一致；命中后自动复位并置 fired=true
//   （供断言"确实命中过"，防 SQL 片段写错导致故障从未注入、测试静默假绿）。
let injectFailureOnSql = null;
let injectFailureFired = false;
const runFI = (sql, params = []) => {
  if (injectFailureOnSql && sql.includes(injectFailureOnSql)) {
    const marker = injectFailureOnSql;
    injectFailureOnSql = null;
    injectFailureFired = true;
    return Promise.reject(new Error(`[测试注入故障] 命中 SQL 片段「${marker}」`));
  }
  return run(sql, params);
};

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
  db, dbRunAsync: runFI, dbGetAsync: get, dbAllAsync: all,
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

// ⚠️ 测试 id 与生产 users.id 无对应关系（授权只看 JWT role 与白名单常量）。
//   admin1/admin2 两个 admin 是**刻意**的：C2a 的整个动机就是"6 个 admin 谁删的分不清"，
//   只有一个 admin 的夹具测不出 operator 归属（[[feedback_test_assertion_self_error]] 夹具规模不足形态）。
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const admin2Tok = jwt.sign({ id: 2, username: 'admin2', display_name: '第二管理员', role: 'admin' }, SECRET);
const userTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const CONTRACT_V = 2;
const create = (extra) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: CONTRACT_V, type: 'feature', title: '待删测试单', system_name: 'BMS', source: '内部',
    description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13, ...extra });

// 业务表残留计数（负例断"无副作用"、正例断"真清干净"都用它）
//   ⭐ 对抗审 F7 收口：原来只查四张表（issue/timeline/attachments/dev_assignees），
//   **断言口径本身遮蔽了另外两张带 issue_id 的表** —— dev_commits/dev_events 既没被删、也没被断言，
//   于是"四表全清"绿灯与"永久孤儿行"可以同时成立。现在按 issue_id 子表**全集**断言。
//   ⛔ 以后再加带 issue_id 的表，这里必须同步扩，否则同样的洞会重开。
//   ⭐ [S1 收口批·H1] 先行上线两步化新增 sys_fast_release_executors 正是"同样的洞重开"的实例——
//   建表 commit 补了 DELETE 级联，但本文件的残留计数口径没跟着扩，级联删得对不对**零测试覆盖**，
//   违反 index.js DELETE 端点头部"⛔ 三件套契约"（快照读/DELETE/verify 残留断言必须同步）。现补齐第 7 项。
async function bizRows(id) {
  const [issue, tl, att, dev, commits, events, snaps, fastExec] = await Promise.all([
    get('SELECT COUNT(*) c FROM sys_issues WHERE id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_attachments WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_dev_commits WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_dev_events WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_issue_release_commit_snapshots WHERE issue_id=?', [id]),
    get('SELECT COUNT(*) c FROM sys_fast_release_executors WHERE issue_id=?', [id]),
  ]);
  return { issue: issue.c, timeline: tl.c, att: att.c, dev: dev.c,
    commits: commits.c, events: events.c, snaps: snaps.c, fastExec: fastExec.c };
}
const auditCount = async (id) => (await get('SELECT COUNT(*) c FROM sys_issue_delete_audit WHERE issue_id=?', [id])).c;

// 造一张"有料"的单：七张 issue_id 子表**全部**塞进可识别内容，使快照与级联都有可验证的对象。
//   ⭐ 对抗审 F1/F7 收口：原来只塞 timeline/附件/**一条** dev_assignees，于是
//   "dev 名册没进快照""commits/events 既没删也没断言"两个缺口都被夹具的贫瘠一起盖住了
//   （[[feedback_test_assertion_self_error]] 的"夹具规模不足"形态：夹具造不出的东西，断言就测不到）。
async function makeRichIssue(title) {
  const r = await create({ title });
  assert.strictEqual(r.status, 201, `建单 201（实际 ${r.status}：${JSON.stringify(r.body)}）`);
  const id = r.body.id;
  await run(`INSERT INTO sys_issue_timeline (issue_id, event_type, from_status, to_status, summary, action_code, operator_id, operator_name)
             VALUES (?,?,?,?,?,?,?,?)`, [id, 'note', null, null, '这条 note 是审计链的可识别内容', 'audit_probe', 1, '管理员']);
  await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
             VALUES (?,?,?,?,?,?,?,?)`, [id, 'spec', 'probe-file.txt', '需求说明.txt', 12, 'text/plain', 1, '管理员']);
  // 协作开发**三行**：主代表 + 协作 + 一条已软删的历史行（removed_at 非空）——
  //   历史行同样必须进快照：它记录着"这单曾经指派过谁、谁通知过他"，删掉就再也说不清换过谁。
  const da1 = await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, notify_status, notify_sent_by)
                         VALUES (?,?,?,1,'sent',13)`, [id, 5, '开发王']);
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, notify_status, notify_sent_by)
             VALUES (?,?,?,0,'failed',2)`, [id, 6, '开发李']);
  await run(`INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, removed_at)
             VALUES (?,?,?,0,datetime('now','localtime'))`, [id, 7, '示例发布者']);
  // commit 留痕 + 开发侧事件审计链（C0 新增的两张表·正是此前既没删也没快照的那两张）
  await run(`INSERT INTO sys_issue_dev_commits (issue_id, dev_assignee_id, dev_user_id, component, commit_ref, created_at)
             VALUES (?,?,?,?,?,datetime('now','localtime'))`, [id, da1.lastID, 5, 'backend', 'r12345-可识别commit']);
  await run(`INSERT INTO sys_issue_dev_events (issue_id, dev_assignee_id, action, operator_id, reason, created_at)
             VALUES (?,?,?,?,?,datetime('now','localtime'))`, [id, da1.lastID, 'add', 13, '可识别的事件原因']);
  // [S1 收口批·H1] 先行上线两步化执行人集合**两行**——1 条在册 + 1 条已软删历史行，证明级联删的是
  //   全量（含软删历史行）而不只是"当前代次"（同 dev_assignees 三行含 1 软删历史行的既有夹具设计理念）。
  await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name)
             VALUES (?,?,?,?,?)`, [id, 8, '执行人甲', 1, '管理员']);
  const fe1 = await run(`INSERT INTO sys_fast_release_executors (issue_id, user_id, user_name, added_by, added_by_name)
             VALUES (?,?,?,?,?)`, [id, 9, '执行人乙', 1, '管理员']);
  await run(`UPDATE sys_fast_release_executors SET removed_at = datetime('now','localtime'), removed_by = 1, removed_by_name = '管理员' WHERE id = ?`, [fe1.lastID]);
  return id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(2,'admin2','第二管理员','admin','13800000002'),
    (5,'dev','开发王','user','13800000005'),(13,'wangtaotao','示例对接人','user','19900000024')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [S] schema 契约 ═══
  {
    assert.ok(I.SYS_REQUIRED_TABLES.includes('sys_issue_delete_audit'),
      'sys_issue_delete_audit 必须在 SYS_REQUIRED_TABLES —— 表不在=删了查不到，而删除不可逆，应 fail-closed 到 503');
    const cols = (await all(`PRAGMA table_info(sys_issue_delete_audit)`)).map(c => c.name);
    // ⚠️ 列清单**从 _internals 常量派生**，不在测试里手抄第二份 ——
    //   本片刚修完的 F1/F7 与 C2a 那次 `SYS_REQUIRED_TABLES` vs SQL IN 列表，根因都是"同一事实抄了两处"。
    //   在测试里再抄一份，等于给自己埋同款漂移。
    const MUST = I.SYS_DELETE_AUDIT_KEY_COLS;
    for (const c of MUST) assert.ok(cols.includes(c), `审计表缺列 ${c}`);
    // ⭐ [S1 收口批增量·终裁=补] 25 列（原 23 + fast_release_executors_json 第 5 张 json-only 快照，
    //   +fast_release_executors_count 配套计数列——补齐后本表五组 issue_id 子表快照全部 json+count 成对，
    //   不再有"6 组配对里唯一漏 count"的不对称）。
    assert.ok(MUST.length >= 25, `审计表锚点应含五张子表的 json+count（实际 ${MUST.length} 列）`);
    // NOT NULL 约束：审计三要素（谁/为什么/什么时候）与五份快照都不允许空行占位
    //   （fast_release_executors_json/_count 同批加入——它们经 alterAddMissingCols 老库路径分别带
    //   DEFAULT '[]'/DEFAULT 0 补列，本断言验证的是**新库 CREATE TABLE 路径**这两列同样 NOT NULL，
    //   非只在 ALTER 路径生效）。
    const info = await all(`PRAGMA table_info(sys_issue_delete_audit)`);
    for (const c of ['issue_id', 'issue_json', 'timeline_json', 'attachments_json', 'fast_release_executors_json', 'fast_release_executors_count', 'operator_id', 'operator_name', 'reason', 'deleted_at']) {
      assert.strictEqual(info.find(x => x.name === c).notnull, 1, `${c} 必须 NOT NULL（审计行不允许半空）`);
    }
    // ⭐ 不带 FK：本表要活得比业务行久。若哪天有人给它加 FOREIGN KEY(issue_id) REFERENCES sys_issues(id)，
    //   一旦项目开了 PRAGMA foreign_keys=ON + ON DELETE CASCADE，审计行会随被删单据一起消失 —— 审计表自杀。
    const fks = await all(`PRAGMA foreign_key_list(sys_issue_delete_audit)`);
    assert.strictEqual(fks.length, 0, '⭐ 审计表不得有外键（它必须在被审计对象消失后继续存在）');
    // 同理：源码里不得出现对本表的 DELETE（本模块级联全是手写 DELETE，写了才会被删）。
    //   ⚠️ 扫描前**剥掉行注释**——建表处的说明文字里就引用了这条语句作为反例，
    //   连注释一起扫会把"文档说明"误判成"真有删除代码"（第一版就踩了这个，属断言写错非实现错）。
    const codeLines = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8')
      .split('\n').filter(l => !l.trimStart().startsWith('//'));
    const delHits = codeLines.filter(l => /delete\s+from\s+sys_issue_delete_audit/i.test(l));
    assert.strictEqual(delHits.length, 0,
      `⭐ **业务路由源码**（routes/sys-iteration/index.js·去注释行后）不得删除审计表——它不在任何级联清单里。` +
      `注意这不是全仓约束：本测试脚本自己会清理探针行，运维/归档脚本将来也可能有意删旧审计。命中：${JSON.stringify(delHits)}`);
    // reason 的 DB 层 CHECK（codex C2a 审 MED）：端点校验只管"走端点的写入"，运维直连 SQLite 或未来新端点会绕开它。
    //   这里**直写 DB**（不经端点）验证 CHECK 真的在 DB 上生效——否则这条约束等于只存在于注释里。
    // ⚠️ [S1 收口批·M2] 列清单须带上 fast_release_executors_json——它是 NOT NULL 且**新库 CREATE TABLE
    //   路径无 DEFAULT**（只有 ALTER 老库路径带 DEFAULT '[]'，见 index.js 迁移段注释），漏掉这一列会让
    //   下面三条负例都因"NOT NULL constraint failed"而非"CHECK constraint failed"被拒——rejects 的
    //   /CHECK/i 断言反而会因错误消息对不上而抛出，把"测错了东西"伪装成"测试正确地抓到了拒绝"。
    const rawInsert = (reason) => run(
      `INSERT INTO sys_issue_delete_audit (issue_id, attachment_count, timeline_count, issue_json, timeline_json,
        attachments_json, dev_assignees_json, dev_commits_json, dev_events_json, release_snapshots_json,
        fast_release_executors_json,
        operator_id, operator_name, reason, deleted_at)
       VALUES (9990, 0, 0, '{}', '[]', '[]', '[]', '[]', '[]', '[]', '[]', 1, '管理员', ?, '2026-07-27 00:00:00')`, [reason]);
    await assert.rejects(rawInsert(''), /CHECK/i, 'DB 层拒绝空 reason（不经端点也拦得住）');
    await assert.rejects(rawInsert('   '), /CHECK/i, 'DB 层拒绝纯空白 reason（trim 后为空）');
    await assert.rejects(rawInsert('z'.repeat(201)), /CHECK/i, 'DB 层拒绝超长 reason（>200）');
    await rawInsert('合法原因');   // 正例：证明上面三条拒绝不是"这条 INSERT 本身就写不进去"
    await run(`DELETE FROM sys_issue_delete_audit WHERE issue_id = 9990`);   // 清掉本组探针行，不污染 [P] 的计数
    // [S13 收口·顺带发现] 此处列数字面量此前写"25"——SYS_DELETE_AUDIT_KEY_COLS 实际早已是 27 列
    // （S13-b·B3 补 issue_derive_root_id/issue_derive_seq 时改了数组、漏改这条日志文案的字面数字，
    // 与本批 LOW-3/LOW-4 无因果关系，顺手一并订正，非本批引入的新偏差）。
    ok(`[S] schema：进 REQUIRED_TABLES + **${MUST.length} 列锚点（从 _internals 常量派生，含 S1 收口批新增 fast_release_executors_json/_count + S13-b·B3 新增 issue_derive_root_id/issue_derive_seq）** + 审计要素 NOT NULL + **零外键、零 DELETE 语句** + reason DB 层 CHECK（空/空白/超长直写也被拒）`);
  }

  // ═══ [V] reason 契约（负例必须无副作用）═══
  {
    const id = await makeRichIssue('V-reason 契约');
    const before = await bizRows(id);
    assert.deepStrictEqual(before, { issue: 1, timeline: 2, att: 1, dev: 3, commits: 1, events: 1, snaps: 0, fastExec: 2 },
      '前置：单据 + 2 条 timeline + 附件 + **3 行协作开发（含 1 软删历史行）** + commit + dev event' +
      ' + **2 行先行上线两步化执行人（含 1 软删历史行）** 各就位' +
      '（夹具自检：夹具造不出的东西断言就测不到，F1/F7 两个洞正是被贫瘠夹具盖住的；fastExec 同理是 S1 收口批 H1 补的洞）');

    for (const [label, body] of [
      ['缺 reason 字段', undefined],
      ['reason 为空串', { reason: '' }],
      ['reason 纯空白（trim 后为空）', { reason: '   ' }],
      ['reason 非字符串', { reason: 12345 }],
      ['reason 超长 201 字', { reason: 'x'.repeat(201) }],
    ]) {
      const r = await call('DELETE', '/api/sys-issues/' + id, adminTok, body);
      assert.strictEqual(r.status, 400, `${label} → 400（实际 ${r.status}）`);
      assert.strictEqual(r.body.code, 'VALIDATION', `${label} → code=VALIDATION`);
      assert.deepStrictEqual(await bizRows(id), before, `${label}：**业务七表一行不少**（负例无副作用）`);
      assert.strictEqual(await auditCount(id), 0, `${label}：不写审计行（没删就不该有删除记录）`);
    }
    // 边界正例：恰好 200 字应放行（防把边界写反）——放在最后，它会真删掉这张单
    const r200 = await call('DELETE', '/api/sys-issues/' + id, adminTok, { reason: 'y'.repeat(200) });
    assert.strictEqual(r200.status, 200, 'reason 恰 200 字 → 放行（边界含右端）');
    assert.strictEqual((await bizRows(id)).issue, 0, '边界正例确实删掉了（不是被别的分支挡下）');
    assert.strictEqual((await get('SELECT length(reason) n FROM sys_issue_delete_audit WHERE issue_id=?', [id])).n, 200, '审计行 reason 原样落 200 字');
    ok('[V] reason 契约：缺失/空串/纯空白/非字符串/201 字 五形态全 400 且业务**七表**零副作用；**200 字边界放行**');
  }

  // ═══ [D] 正常删除：业务行清干净 + 审计快照可还原 ═══
  let firstDeletedId;
  {
    const id = await makeRichIssue('D-正常删除');
    firstDeletedId = id;
    const issueBefore = await get('SELECT * FROM sys_issues WHERE id=?', [id]);
    // ⭐ 用 admin2 删 admin1 建的单——这正是 C2a 要回答的问题（6 个 admin 里到底是谁删的）
    const r = await call('DELETE', '/api/sys-issues/' + id, admin2Tok, { reason: '清理测试脏单' });
    assert.strictEqual(r.status, 200, `删除 200（实际 ${r.status}：${JSON.stringify(r.body)}）`);

    assert.deepStrictEqual(await bizRows(id), { issue: 0, timeline: 0, att: 0, dev: 0, commits: 0, events: 0, snaps: 0, fastExec: 0 },
      '⭐ **七张 issue_id 子表全清**（对抗审 F7：dev_commits/dev_events 此前从不被删，留永久孤儿行；' +
      'fastExec=0 若 index.js 的 DELETE FROM sys_fast_release_executors 那行不存在，本条会红——若该行只删了' +
      '在册行、漏删软删历史行，fastExec 会残留 1 而非 0，同样会红：断言覆盖的是"全量"而非"当前代次"）');

    const a = await get('SELECT * FROM sys_issue_delete_audit WHERE issue_id=?', [id]);
    assert.ok(a, '审计行存在');
    assert.strictEqual(a.operator_id, 2, '⭐ operator_id=2（**删的人**，不是建单人 1）——多 admin 归属正是本片存在的理由');
    assert.strictEqual(a.operator_name, '第二管理员', 'operator_name 落显示名');
    assert.strictEqual(a.reason, '清理测试脏单', 'reason 原样落库');
    assert.strictEqual(a.issue_type, issueBefore.type, 'issue_type 快照与删前一致');
    assert.strictEqual(a.issue_status, issueBefore.status, 'issue_status 快照与删前一致');
    assert.strictEqual(a.issue_title, 'D-正常删除', 'issue_title 快照与删前一致');
    assert.strictEqual(a.issue_created_by, 1, 'issue_created_by 记的是**建单人**（与 operator_id 分列两栏，才能看出"谁删了谁的单"）');
    assert.ok(a.deleted_at && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(a.deleted_at), `deleted_at 为 localtime 格式（实际 ${a.deleted_at}）`);

    // 快照可还原性：JSON 能解析 + 与计数交叉一致 + 内容真在里面
    const ij = JSON.parse(a.issue_json);
    const tj = JSON.parse(a.timeline_json);
    const aj = JSON.parse(a.attachments_json);
    assert.strictEqual(ij.id, id, 'issue_json 是被删那一行');
    assert.strictEqual(ij.title, 'D-正常删除', 'issue_json 含标题');
    assert.ok(Object.keys(ij).length > 30, `issue_json 是**整行**快照（SELECT * ·实际 ${Object.keys(ij).length} 列），非挑几列`);
    assert.strictEqual(a.timeline_count, tj.length, 'timeline_count 与 timeline_json 长度交叉一致');
    assert.strictEqual(a.attachment_count, aj.length, 'attachment_count 与 attachments_json 长度交叉一致');
    assert.strictEqual(tj.length, 2, 'timeline 两条（建单事件 + probe）全部进快照');
    assert.ok(tj.some(t => t.summary === '这条 note 是审计链的可识别内容' && t.action_code === 'audit_probe'),
      '⭐ 被 DELETE 抹掉的 timeline **内容**真在快照里（只记条数=知道有过证据但不知道是什么）');
    assert.ok(tj.every(t => t.operator_id != null && t.created_at), 'timeline 快照保留操作者与时刻（审计链的关键两列）');
    // ⭐ 三份快照都必须是**整行**（SELECT *），不是挑列（codex C2a 审 HIGH）。
    //   判据取"挑列版本里不会有的列"——issue_id：它对审计而言冗余（audit.issue_id 已有），
    //   所以任何"挑有用的列"的写法都会把它省掉。它在 ⟹ 用的是 SELECT *，将来给表加列会自动进快照。
    const tCols = (await all(`PRAGMA table_info(sys_issue_timeline)`)).map(c => c.name);
    const aCols = (await all(`PRAGMA table_info(sys_issue_attachments)`)).map(c => c.name);
    for (const c of tCols) assert.ok(c in tj[0], `timeline 快照缺列 ${c} —— 快照必须是整行（SELECT *），否则加列即漏证`);
    for (const c of aCols) assert.ok(c in aj[0], `附件快照缺列 ${c} —— 同上`);
    assert.ok('issue_id' in tj[0] && 'issue_id' in aj[0],
      '⭐ 快照含 issue_id 这类"挑列时必被省掉"的列 —— 这是"整行快照"的可判别证据');
    assert.strictEqual(aj[0].original_name, '需求说明.txt', '附件快照含原始文件名（磁盘文件可能已删，名字是唯一线索）');
    assert.strictEqual(aj[0].file_name, 'probe-file.txt', '附件快照含落盘名（供人工到 uploads 里找残留文件）');

    // ⭐ 对抗审 F1/F7 收口 + S1 收口批 M2：另外五张子表的快照也必须可还原
    const daj = JSON.parse(a.dev_assignees_json);
    const dcj = JSON.parse(a.dev_commits_json);
    const dej = JSON.parse(a.dev_events_json);
    const rsj = JSON.parse(a.release_snapshots_json);
    assert.strictEqual(a.dev_assignee_count, daj.length, 'dev_assignee_count 与快照长度交叉一致');
    assert.strictEqual(a.dev_commit_count, dcj.length, 'dev_commit_count 与快照长度交叉一致');
    assert.strictEqual(a.dev_event_count, dej.length, 'dev_event_count 与快照长度交叉一致');
    assert.strictEqual(a.release_snapshot_count, rsj.length, 'release_snapshot_count 与快照长度交叉一致');
    assert.strictEqual(daj.length, 3, '协作开发名册三行全进快照（含软删历史行）');
    assert.ok(daj.some(d => d.user_id === 7 && d.removed_at),
      '⭐ **软删历史行也在快照里** —— 它记着"这单曾指派过谁"，丢了就说不清换过人');
    assert.ok(daj.some(d => d.user_id === 5 && d.notify_status === 'sent' && d.notify_sent_by === 13),
      '⭐⭐ 逐 dev 的 **notify_sent_by 进了快照** —— 「谁给这张被删单的哪个开发发过钉钉」查得到，' +
      '这正是 C2b 存在的理由；此前 dev 名册整张被删且无快照，C2b 的归属数据被 C2a 自己抹掉');
    assert.strictEqual(dcj[0].commit_ref, 'r12345-可识别commit', 'commit 留痕内容进快照');
    assert.strictEqual(dej[0].reason, '可识别的事件原因', '开发侧事件审计链（含 operator/reason）进快照');
    assert.ok(dej[0].operator_id === 13, 'dev event 的 operator_id 保留');

    // ⭐ [S1 收口批增量·终裁=补] 第五张 issue_id 子表（先行上线两步化执行人集合）快照——现已配套
    //   fast_release_executors_count（与其余四对 json+count 同批同源对齐），故本组同时做 count 交叉
    //   一致断言（若 index.js 的 fastReleaseExecRows 读点漏读了软删历史行，或 INSERT 时值序错位，
    //   下面任一条会红）。
    const fej = JSON.parse(a.fast_release_executors_json);
    assert.strictEqual(a.fast_release_executors_count, fej.length, 'fast_release_executors_count 与快照长度交叉一致');
    assert.strictEqual(a.fast_release_executors_count, 2, `fast_release_executors_count 应=塞入行数 2（1 在册+1 软删），实得 ${a.fast_release_executors_count}`);
    assert.strictEqual(fej.length, 2, '先行上线两步化执行人两行（1 在册 + 1 软删）全进快照，实得 ' + fej.length);
    assert.ok(fej.some(e => e.user_id === 8 && e.removed_at === null),
      '⭐ 在册那行（user_id=8）确实在快照里且 removed_at 仍为 NULL（未被误标软删）');
    assert.ok(fej.some(e => e.user_id === 9 && e.removed_at && e.removed_by === 1 && e.removed_by_name === '管理员'),
      '⭐ **软删历史行也在快照里**（user_id=9），且软删三件套（removed_at/removed_by/removed_by_name）完整——' +
      '同 dev_assignees 软删历史行同一断言精神，"这单曾安排过谁执行"不因物删而说不清');
    const feCols = (await all(`PRAGMA table_info(sys_fast_release_executors)`)).map(c => c.name);
    for (const c of feCols) assert.ok(c in fej[0], `先行上线两步化执行人快照缺列 ${c} —— 快照必须是整行（SELECT *），否则加列即漏证`);
    ok('[D] 正常删除：**七表清空** + 审计行含 operator/reason + **八份 JSON 快照可还原、与计数逐一交叉一致**（含 dev 名册/软删历史行/commit/events/先行上线两步化执行人软删历史行）（admin2 删 admin1 的单，归属分得清）');
  }

  // ═══ [R] ⭐ 故障注入：审计写失败 → 整体 rollback ═══
  {
    const id = await makeRichIssue('R-审计写失败');
    const before = await bizRows(id);
    injectFailureOnSql = 'INSERT INTO sys_issue_delete_audit';
    injectFailureFired = false;
    const r = await call('DELETE', '/api/sys-issues/' + id, adminTok, { reason: '这次审计会写失败' });
    assert.strictEqual(injectFailureFired, true,
      '⭐ 故障**确实注入了**（若为 false 说明 SQL 片段没匹配上 —— 那本组等于没测，是典型的静默假绿）');
    assert.strictEqual(r.status, 500, `审计写失败 → 500（实际 ${r.status}：${JSON.stringify(r.body)}）`);
    assert.deepStrictEqual(await bizRows(id), before,
      '⭐⭐ 业务七表**一行不少** —— "删了但没记"被事务结构性排除，而不是靠"审计写应该不会失败"');
    assert.strictEqual(await auditCount(id), 0, '审计表零行（回滚把半截审计行也带走了）');
    injectFailureOnSql = null;
    // 同一张单重试：这次审计写成功 → 正常删掉（证明失败是可恢复的，没把单据锁死）
    const r2 = await call('DELETE', '/api/sys-issues/' + id, adminTok, { reason: '重试删除' });
    assert.strictEqual(r2.status, 200, '故障复位后重试 → 200（失败不留后遗症）');
    assert.strictEqual((await bizRows(id)).issue, 0, '重试后单据确实删掉');
    assert.strictEqual(await auditCount(id), 1, '重试后恰 1 条审计行（失败那次没留残行）');
    ok('[R] ⭐ 审计写失败 → 整体 rollback：业务七表零变化 + 审计零行 + 故障复位后可重试删成（含"故障真被注入"自证）');
  }

  // ═══ [R2] ⭐ 反向故障：审计已写成功、随后的业务 DELETE 失败 → 审计行必须一并回滚 ═══
  //   [R] 测的是"删了但没记"，本组测它的镜像面「**记了但没删**」——那会留下一条说"这单已被删除"的审计行，
  //   而单据其实还在。误导性审计比没有审计更危险（查审计的人会据此认为单据已不存在）。
  //   注入点选 timeline 的 DELETE：它排在审计 INSERT 之后，且正是 C2a 要保护的那张表。
  {
    const id = await makeRichIssue('R2-业务删除失败');
    const before = await bizRows(id);
    injectFailureOnSql = 'DELETE FROM sys_issue_timeline';
    injectFailureFired = false;
    const r = await call('DELETE', '/api/sys-issues/' + id, adminTok, { reason: '审计写成功但业务删失败' });
    assert.strictEqual(injectFailureFired, true, '⭐ 故障确实注入（false = 本组空跑）');
    assert.strictEqual(r.status, 500, `业务 DELETE 失败 → 500（实际 ${r.status}）`);
    assert.deepStrictEqual(await bizRows(id), before, '业务七表一行不少（删除整体失败）');
    assert.strictEqual(await auditCount(id), 0,
      '⭐⭐ 审计行**也被回滚** —— 不允许留下"记了删除、单据却还在"的误导性审计行');
    injectFailureOnSql = null;
    ok('[R2] ⭐ 反向故障（审计已写 → 业务 DELETE 失败）：审计行随事务一并回滚，杜绝"记了但没删"的假审计');
  }

  // ═══ [G] 拒删路径不留审计行 ═══
  {
    // ① 有派生子单 → 409
    const parent = await makeRichIssue('G-母单');
    const der = await call('POST', `/api/sys-issues/${parent}/derive`, adminTok,
      { type: 'feature', title: 'G-派生子单', system_name: 'BMS', source: '内部' });
    assert.strictEqual(der.status, 201, `派生 201（实际 ${der.status}：${JSON.stringify(der.body)}）`);
    const rP = await call('DELETE', '/api/sys-issues/' + parent, adminTok, { reason: '试图删母单' });
    assert.strictEqual(rP.status, 409, '有派生子单 → 409');
    assert.strictEqual(rP.body.code, 'SYS_ISSUE_HAS_DERIVED', 'code=SYS_ISSUE_HAS_DERIVED');
    assert.strictEqual((await bizRows(parent)).issue, 1, '母单仍在');
    assert.strictEqual(await auditCount(parent), 0, '⭐ 拒删**不写审计行**（拒绝不是删除，写了会污染"删过什么"的查询结果）');

    // ② 已挂上线批次 → 409
    const inRel = await makeRichIssue('G-已挂批次');
    await run(`UPDATE sys_issues SET release_id = 999 WHERE id = ?`, [inRel]);
    const rR = await call('DELETE', '/api/sys-issues/' + inRel, adminTok, { reason: '试图删已挂批次单' });
    assert.strictEqual(rR.status, 409, '已挂批次 → 409');
    assert.strictEqual(rR.body.code, 'SYS_ISSUE_IN_RELEASE', 'code=SYS_ISSUE_IN_RELEASE');
    assert.strictEqual(await auditCount(inRel), 0, '拒删不写审计行');

    // ③ 不存在的单 → 404（且 reason 合法，确保走到的是存在性判定而非参数校验）
    const rN = await call('DELETE', '/api/sys-issues/99999', adminTok, { reason: '删一个不存在的单' });
    assert.strictEqual(rN.status, 404, '不存在 → 404');
    assert.strictEqual(await auditCount(99999), 0, '不存在的单不留审计行');

    // ④ 非 admin → 403，且**不因缺 reason 而变成 400**（权限判定必须先于参数校验之外的业务动作；
    //    这里 body 带合法 reason，确保测的是权限而不是校验顺序）
    const okIssue = await makeRichIssue('G-权限');
    const rU = await call('DELETE', '/api/sys-issues/' + okIssue, userTok, { reason: '非 admin 尝试删除' });
    assert.strictEqual(rU.status, 403, '非 admin → 403');
    assert.strictEqual((await bizRows(okIssue)).issue, 1, '非 admin 删除被拒后单据仍在');
    assert.strictEqual(await auditCount(okIssue), 0, '非 admin 不留审计行');
    ok('[G] 拒删路径（派生 409 / 批次 409 / 不存在 404 / 非 admin 403）**一律不写审计行**且单据无损');
  }

  // ═══ [P] 审计行不随后续业务删除消失 ═══
  {
    const other = await makeRichIssue('P-另一张单');
    const r = await call('DELETE', '/api/sys-issues/' + other, adminTok, { reason: '再删一张' });
    assert.strictEqual(r.status, 200, '再删一张 200');
    assert.strictEqual(await auditCount(firstDeletedId), 1,
      '⭐ [D] 组那条审计行在后续删除后**仍在**（本表不进任何级联清单，也没有外键把它带走）');
    const total = (await get('SELECT COUNT(*) c FROM sys_issue_delete_audit')).c;
    assert.strictEqual(total, 4, `审计表累计 4 条（V 边界 + D + R 重试 + P），实际 ${total} —— 记录只增不减`);
    ok('[P] 审计行只增不减：历史审计行不被后续删除带走，累计条数与实际删除次数逐条对得上');
  }

  // ═══ [T]（codex 382-H1 替代护栏）静态扫描：全部生产 INSERT 写点显式含 fast_release_executors 两列 ═══
  //   背景：sys_issue_delete_audit 的 fast_release_executors_json/_count 两列走 alterAddMissingCols
  //   ALTER 路径补入（老库带 DEFAULT），与 2.10 段 CREATE TABLE 新库侧裸 NOT NULL（无 DEFAULT）对"省略
  //   该列的 INSERT"行为并不等效——升级库省列 INSERT 会静默回填 DEFAULT 放行，新库省列 INSERT 会被
  //   NOT NULL 直接拒绝报错（见 index.js alterAddMissingCols 调用处 codex 382-H1 订正注释）。主会话裁定
  //   不重建生产审计表抹平分叉，改用本组护栏堵"未来新写点漏列"这条风险面：扫描 routes/ 目录下全部
  //   `INSERT INTO sys_issue_delete_audit (...)` 语句，逐条断言列清单显式含两列——"实现坏成什么样这条
  //   会红"：日后若有人在别处（或改这处）新增一条不带这两列的 INSERT，本组静态断言先红，不必等升级库/
  //   新库分叉在生产实际触发（例如老库省列 INSERT 静默回填、新库省列 INSERT 报 500）才被发现。
  //   ⚠️ 已知局限（如实登记，不宣称机制闭合）：本护栏是源码正则扫描，只覆盖 `routes/` 目录内的静态
  //   INSERT 语句文本；维护脚本/临时补丁等旁路直接 SQL 写入若不落在扫描范围内仍可能漏检，残余风险
  //   待追认锚点见方案 §9。
  //   [codex 383-M3 加固] 原正则 `/INSERT INTO sys_issue_delete_audit\s*\(([\s\S]*?)\)\s*VALUES/g` 只认
  //   大小写敏感的裸 `INSERT INTO`——大小写变体（insert into）、冲突子句变体（INSERT OR ROLLBACK/ABORT/
  //   FAIL/IGNORE/REPLACE INTO）、带引号/方括号/反引号的表名（"sys_issue_delete_audit" / [同名] /
  //   反引号包裹同名，MySQL 风格标识符写法，本仓不用但迁移脚本/历史代码可能出现）均会被裸正则漏扫，
  //   造成"有 INSERT 但护栏没看到"的假阴性——比误报更危险（假阴性=护栏在但没生效，比没护栏更骗自己）。
  //   加固为不区分大小写 + 覆盖冲突子句 + 三种带引号表名写法 + 任意空白/换行容忍。
  //   ⚠️ [集中写入 helper 方案] 384 轮复核结果（S13 收口批同步）：本组的 regex builder（INSERT 列清单
  //   提取，按表名变体/冲突子句容错）与 scripts/lib/sql-select-boundary.js（SELECT 外层 FROM 边界定位）
  //   是**不同性质**的两类扫描——本组解决"逐字符抓 INSERT 括号内列清单+容忍表名/冲突子句写法变体"，
  //   sql-select-boundary.js 解决"跳过子查询找外层边界"，抽出去也不会是同一个模块。scripts/lib/ 现在
  //   确有"多真实消费点→抽公共 helper"的落地先例（该模块服务 verify-sys-list-badge-fields.js +
  //   verify-sys-prerelease-flags.js 两处），但本组 buildInsertAuditRegex 本身**依旧只有 index.js 一处
  //   真实生产 INSERT 写点**，抽出去复用的收益仍不存在——按原定纪律继续不抽（不为"将来可能"预先设计），
  //   即"已抽"的示例已经有了，不代表"这一处"也该抽；真出现第二张审计表复用同款扫描时，直接放
  //   scripts/lib/（已有存放位置与命名先例，不必再等）。
  {
    // [S13 收口 LOW-4] 纳入 issue_derive_root_id/issue_derive_seq（S13-b·B3 删除审计双记新增两列，
    //   index.js :11779 一带真实 INSERT 已带这两列——本护栏补上，未来新写点/改写点漏列即红，不必等
    //   生产运行时才发现列表页子编号展示缺口）。
    const REQUIRED_COLS = ['fast_release_executors_json', 'fast_release_executors_count', 'issue_derive_root_id', 'issue_derive_seq'];
    // 表名匹配三种带引号写法 + 裸写法（正则字面量本身允许含反引号字符，不受"模板字符串禁反引号"规则
    // 约束——那条规则管的是 JS 模板字符串里嵌 SQL 注释，这里是普通 /.../ 正则字面量，性质不同）。
    const TABLE_NAME_ALT = '(?:"sys_issue_delete_audit"|\\[sys_issue_delete_audit\\]|`sys_issue_delete_audit`|sys_issue_delete_audit)';
    function buildInsertAuditRegex() {
      return new RegExp(
        'INSERT\\s+(?:OR\\s+(?:ROLLBACK|ABORT|FAIL|IGNORE|REPLACE)\\s+)?INTO\\s+' + TABLE_NAME_ALT + '\\s*\\(([\\s\\S]*?)\\)\\s*VALUES',
        'gi'
      );
    }

    // [codex 383-M3] 合成反例自测——先证扫描器本身在下列变体下真能提取到列清单，不是纸面声称"已加固"。
    //   ⚠️ 样本⑤反引号表名故意用单引号包裹 JS 字符串（非模板字符串）——若改用反引号包裹的模板字符串
    //   装载一段本身含反引号的 SQL 文本，会触发本项目已知坑（模板字符串遇内嵌反引号提前截断），本组
    //   全部样本因此统一用单引号/双引号 JS 字符串装载，不用模板字符串。
    const SYNTH_SAMPLES = [
      { label: '①大小写混合', sql: 'insert INTO sys_issue_delete_audit (a, fast_release_executors_json, fast_release_executors_count, issue_derive_root_id, issue_derive_seq) values (?,?,?,?,?)' },
      { label: '②INSERT OR ROLLBACK 冲突子句', sql: 'INSERT OR ROLLBACK INTO sys_issue_delete_audit (a, fast_release_executors_json, fast_release_executors_count, issue_derive_root_id, issue_derive_seq) VALUES (?,?,?,?,?)' },
      { label: '③双引号表名', sql: 'INSERT INTO "sys_issue_delete_audit" (a, fast_release_executors_json, fast_release_executors_count, issue_derive_root_id, issue_derive_seq) VALUES (?,?,?,?,?)' },
      { label: '④方括号表名', sql: 'INSERT INTO [sys_issue_delete_audit] (a, fast_release_executors_json, fast_release_executors_count, issue_derive_root_id, issue_derive_seq) VALUES (?,?,?,?,?)' },
      { label: '⑤反引号表名', sql: 'INSERT INTO `sys_issue_delete_audit` (a, fast_release_executors_json, fast_release_executors_count, issue_derive_root_id, issue_derive_seq) VALUES (?,?,?,?,?)' },
      { label: '⑥任意空白换行混排', sql: 'INSERT\n\tINTO   sys_issue_delete_audit\n  (\n    a,\n    fast_release_executors_json,\n    fast_release_executors_count,\n    issue_derive_root_id,\n    issue_derive_seq\n  )\n VALUES (?,?,?,?,?)' },
    ];
    for (const { label, sql } of SYNTH_SAMPLES) {
      const re = buildInsertAuditRegex();
      const m = re.exec(sql);
      assert.ok(m, `[T-合成反例${label}] 扫描器应能从该变体提取到 INSERT INTO sys_issue_delete_audit 语句，样本："${sql.replace(/\s+/g, ' ')}"`);
      for (const col of REQUIRED_COLS) {
        assert.ok(m[1].includes(col), `[T-合成反例${label}] 提取到的列清单应含 ${col}，实得列清单："${m[1]}"`);
      }
    }
    ok(`[T-合成反例] 扫描器加固自测：${SYNTH_SAMPLES.length} 个变体样本（大小写混合/INSERT OR 冲突子句/双引号表名/方括号表名/反引号表名/任意空白换行混排）均能正确提取列清单——证明加固真生效，非纸面声称`);

    // 真实扫描：改用加固后的 regex builder 扫 routes/ 全部 .js 文件（逻辑与 codex 382-H1 首版一致，
    // 仅替换正则本体）。
    const routesDir = path.join(__dirname, '..', 'routes');
    function listJsFilesRecursive(dir) {
      let out = [];
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) out = out.concat(listJsFilesRecursive(full));
        else if (ent.isFile() && ent.name.endsWith('.js')) out.push(full);
      }
      return out;
    }
    const jsFiles = listJsFilesRecursive(routesDir);
    let insertSitesFound = 0;
    for (const file of jsFiles) {
      const src = fs.readFileSync(file, 'utf8');
      const re = buildInsertAuditRegex();
      let m;
      while ((m = re.exec(src)) !== null) {
        insertSitesFound++;
        const colListText = m[1];
        for (const col of REQUIRED_COLS) {
          assert.ok(colListText.includes(col),
            `[T] ${path.relative(routesDir, file)} 内一处 INSERT INTO sys_issue_delete_audit 的列清单应显式含 ${col}，实得列清单文本：${colListText.replace(/\s+/g, ' ').trim()}`);
        }
      }
    }
    assert.ok(insertSitesFound >= 1,
      `[T] 应在 routes/ 下至少扫到 1 处 INSERT INTO sys_issue_delete_audit（若为 0，说明扫描正则本身失效或写点被移走，本护栏形同虚设），实得 ${insertSitesFound} 处`);
    ok(`[T] 静态扫描：routes/ 下 ${insertSitesFound} 处 INSERT INTO sys_issue_delete_audit 全部显式含 ${REQUIRED_COLS.join(' + ')}（codex 382-H1 替代护栏 + codex 383-M3 加固 + S13 收口 LOW-4 纳入两新列：大小写/冲突子句/三种带引号表名/任意空白换行全覆盖，未来新写点漏列即红）`);
  }

  console.log(`\n✅ verify-sys-delete-audit 全部通过（${passed} 组·角色权限重构 C2a 物删审计 + codex 382-H1 静态护栏）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } process.exit(1); });
