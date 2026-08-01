// scripts/verify-sys-multidev-attachments.js — C5 验收：附件授权改造（§5.4 唯一权威表）+ round_no 遗产清理
//   SSOT = 方案 v2.9 §5.4「附件口径统一表」+ §0 line33 角色定义 + §4.0 SYS_TERMINAL_STATUSES +
//   联合 SSOT §13 验收表 S20/S32 + §16 补丁九 M-P4（round_no 遗产三件）。
//   用法：node scripts/verify-sys-multidev-attachments.js
//
// 覆盖 S20（附件矩阵逐格：历史参与可下不可删 / broad_user 拒下拒删 / 兼具显式角色按角色算 / 非在册非协调人上传拒）
// + S32 附件部分（族外状态上传/删除拒）+ round_no 遗产③（存量已绑行按新终态门规则）+ DEV∪VERIFY 上传窗口
// （现网 isDevWorkState 只放 DEV，VERIFY 态在册可传属真实行为放宽，正向断言）+ 下载矩阵（在册/历史参与 200，
// 无关 user 403）。单人基线场景（正向上传/下载/删除/supersede/path 安全等）在 verify-sys-attachments.js，
// 两文件不重复覆盖同一场景——本文件只测「多开发 roster 授权矩阵」这一新维度。
//
// DB 直接 seed roster（mkIssue/mkMember，同 verify-sys-multidev-commits.js 范式）+ HTTP harness（upload/download/
// call，同 verify-sys-attachments.js 范式）。
'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-multidev-attach-secret';
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

// 用户：admin(1) / dev5,dev6,dev8（普通开发） / liaison7（bug 对接人白名单，见 index.js SYS_BUG_LIAISON_USER_IDS=[7,13]）
const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const devTok = (id) => jwt.sign({ id, username: 'dev' + id, display_name: '开发' + id, role: 'user' }, SECRET);
// ⭐ 角色权限重构 C1：协调人（附件上传/删除权）由「bug 对接人[7,13] 且 type=bug」收敛为「受理人[13]·全类型」。
//   liaisonTok 保留 id=7 用于**失权负例**；新增 intakeTok(13) 作为 C1 后真正的协调人。
const liaisonTok = jwt.sign({ id: 7, username: 'liaison7', display_name: '对接人柒', role: 'user' }, SECRET);
const intakeTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

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
function upload(p, tok, fields, fileName) {
  return new Promise((resolve, reject) => {
    const boundary = '----MdAttBoundary' + (p.length * 7919 + Date.now());
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
function download(p, tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { 'Authorization': 'Bearer ' + tok } },
      (r) => { let n = 0; r.on('data', c => n += c.length); r.on('end', () => resolve({ status: r.statusCode, bytes: n })); });
    req.on('error', reject); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// codex 221a HIGH 收口（验证层残余日期字面量·全文扫描收尾）：dev_estimated_at 默认值原硬编码
// '2026-07-01 10:00:00'，本文件是直连 SQL 造数（不经 /estimate 端点闸门，当前潜伏未触发
// ESTIMATE_BEFORE_ASSIGN），但远期字面量迟早到期，同 P4/221a 范式统一改动态生成，不留隐患。
function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── DB 直接 seed（同 verify-sys-multidev-commits.js 范式，跳过 API 链路直接摆好 roster 场景）──────────
async function mkIssue(type, status, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issues (type, status, title, system_name, source, created_by, created_by_name, dev_estimated_at, release_assignee_id)
     VALUES (?, ?, ?, 'BMS', '内部', 1, '管理员', ?, ?)`,
    [type, status, extra.title || `${type}-${status}-单`, extra.devEstimatedAt || futureEst(30), extra.releaseAssigneeId || null]
  );
  return r.lastID;
}
async function mkMember(issueId, userId, userName, devStatus, extra = {}) {
  const r = await run(
    `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at, no_code_reason, removed_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    [issueId, userId, userName, devStatus, extra.resolvedAt || (devStatus === 'pending' ? null : '2026-07-16 10:00:00'),
     extra.noCodeReason || (devStatus === 'no_code' ? '占位原因，测试用' : null), extra.removedAt || null]
  );
  return r.lastID;
}
async function removeMember(daId) {
  await run(`UPDATE sys_issue_dev_assignees SET removed_at = '2026-07-16 12:00:00' WHERE id = ?`, [daId]);
}
// 直接落一行附件（round_no 可控——遗产③场景需构造"存量已绑 round_no"的历史行，绕开上传端点恒 NULL 的新写路径）。
async function mkAttachment(issueId, type, uploaderId, uploaderName, roundNo) {
  const r = await run(
    `INSERT INTO sys_issue_attachments (issue_id, attachment_type, round_no, file_name, original_name, uploaded_by, uploaded_by_name, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [issueId, type, roundNo, `sys-iteration/${issueId}/seed-${Date.now()}-${Math.random().toString(36).slice(2)}.png`, 'seed.png', uploaderId, uploaderName]
  );
  return r.lastID;
}
async function attRow(attId) {
  return get('SELECT id, attachment_type, round_no, status, uploaded_by FROM sys_issue_attachments WHERE id = ?', [attId]);
}
const ATT = (id) => `/api/sys-issues/${id}/attachments`;
const dlPath = (id, attId) => `/api/sys-issues/${id}/attachments/${attId}/download`;

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES
    (1,'admin','管理员','admin'),(5,'dev5','开发甲','user'),(6,'dev6','开发乙','user'),(7,'liaison7','对接人柒','user'),(8,'dev8','开发戊','user')`);
  await new Promise((resolve) => { const app = express(); app.use(express.json()); app.use('/api', mod.router); server = app.listen(0, () => { port = server.address().port; resolve(); }); });
  ok('readiness ready + HTTP harness 起服务（seed admin/dev5/dev6/liaison7(=SYS_BUG_LIAISON_USER_IDS白名单)/dev8）');

  // ══════════════════════════════════════════════════════════════════════
  // S20①：历史参与可下不可删（含本人上传的删 → 403）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');
    const r = await upload(ATT(id), devTok(5), { attachment_type: 'delivery' }, 'a.png');
    assert.strictEqual(r.status, 200, `S20①：在册上传应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const attId = r.body.attachments[0].id;
    await removeMember(daId);   // dev5 变历史参与者（曾有行且当前不在册）

    const dl = await download(dlPath(id, attId), devTok(5));
    assert.strictEqual(dl.status, 200, `S20①：历史参与者下载应 200，实际 ${dl.status}`);
    const del = await call('DELETE', `/api/sys-issues/${id}/attachments/${attId}`, devTok(5));
    assert.strictEqual(del.status, 403, `S20①：历史参与者删除（含本人上传）应 403，实际 ${del.status} ${JSON.stringify(del.body)}`);
    assert.strictEqual(del.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT', 'S20①：错误码 NOT_AUTHORIZED_FOR_ATTACHMENT');
    assert.strictEqual((await attRow(attId)).status, 'active', 'S20①：拒绝后附件行仍 active（未被误删，零副作用）');
    // [codex 106 号验收补强] 删除被拒后再下载一次——证明失败的 DELETE 尝试对状态零副作用（非"部分回滚"脏态），
    //   历史参与者的下载权不受刚才那次被拒的删除请求影响，仍然 200（同一份历史参与身份，两种权限各自独立生效）。
    const dlAfter = await download(dlPath(id, attId), devTok(5));
    assert.strictEqual(dlAfter.status, 200, `S20①：删除被拒后再下载仍应 200，实际 ${dlAfter.status}`);
    ok('S20①：历史参与者（曾在册·当前 removed_at 非空）→ 下载 200 / 删除 403（含本人上传行，§0 line33"无任何写权"优先）；删除失败零副作用（行仍 active + 下载权不受影响，仍 200）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S20②：broad_user（仅扩读来源，release_assignee_id）拒下拒删；③兼具显式角色（同时在册）按角色算
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('bug', '处理中', { releaseAssigneeId: 6 });   // dev6 是 release_assignee（扩读来源），未在 roster
    const daId = await mkMember(id, 8, '开发戊', 'code_submitted');
    const r = await upload(ATT(id), devTok(8), { attachment_type: 'delivery' }, 'b.png');
    assert.strictEqual(r.status, 200, `S20②准备：dev8 在册上传应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    const attId = r.body.attachments[0].id;

    // dev6 仅 release_assignee_id（broad_user，仅扩读整单，非附件授权来源）→ 下载/删除均拒
    let dl = await download(dlPath(id, attId), devTok(6));
    assert.strictEqual(dl.status, 403, `S20②：broad_user(release_assignee) 下载应 403，实际 ${dl.status}`);
    let del = await call('DELETE', `/api/sys-issues/${id}/attachments/${attId}`, devTok(6));
    assert.strictEqual(del.status, 403, `S20②：broad_user(release_assignee) 删除应 403，实际 ${del.status}`);
    ok('S20②：broad_user（仅 release_assignee_id 扩读来源，非在册非协调人）→ 下载/删除均 403（§5.4 footnote：仅凭它不得下载/删除）');

    // S20③：dev6 追加进 roster（兼具显式角色）→ 按在册角色算，下载放行
    await mkMember(id, 6, '开发乙', 'pending');
    dl = await download(dlPath(id, attId), devTok(6));
    assert.strictEqual(dl.status, 200, `S20③：兼具在册角色后下载应 200，实际 ${dl.status}`);
    ok('S20③：兼具显式角色（同时在册）→ 按角色（在册）算，下载放行（不再受 broad_user 限制）');
    void daId;
  }

  // ══════════════════════════════════════════════════════════════════════
  // S20④：非在册非协调人上传拒（变更流单，dev8 完全无关）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'pending');   // dev5 在册，dev8 不在册
    const r = await upload(ATT(id), devTok(8), { attachment_type: 'delivery' }, 'c.png');
    assert.strictEqual(r.status, 403, `S20④：非在册非协调人上传应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT', 'S20④：错误码 NOT_AUTHORIZED_FOR_ATTACHMENT');
    ok('S20④：非在册非协调人（dev8 与本单无关）上传 delivery → 403');
  }

  // ══════════════════════════════════════════════════════════════════════
  // ⭐ 角色权限重构 C1：协调人 = admin ∨ 受理人[13]·**全类型**（原为 bug 对接人[7,13] 且仅 bug）
  //   本组由"type 精判：bug 能、变更流不能"反转为"全类型都能；而原白名单里的示例发布者(7) 全类型都不能"。
  // ══════════════════════════════════════════════════════════════════════
  {
    // ① 受理人(13)：bug 与变更流**都**可上传/删除（全类型放开）
    for (const [type, st] of [['bug', '处理中'], ['feature', '开发中']]) {
      const id = await mkIssue(type, st);
      let r = await upload(ATT(id), intakeTok, { attachment_type: 'delivery' }, `d-${type}.png`);
      assert.strictEqual(r.status, 200, `⭐ 协调人(13) 在 ${type} 单上传 delivery 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
      const attId = r.body.attachments[0].id;
      const del = await call('DELETE', `/api/sys-issues/${id}/attachments/${attId}`, intakeTok);
      assert.strictEqual(del.status, 200, `⭐ 协调人(13) 在 ${type} 单删除应 200，实际 ${del.status} ${JSON.stringify(del.body)}`);
      // spec 通道同样放开
      r = await upload(ATT(id), intakeTok, { attachment_type: 'spec' }, `s-${type}.pdf`);
      assert.strictEqual(r.status, 200, `⭐ 协调人(13) 在 ${type} 单上传 spec 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
    ok('⭐ [C1] 协调人全类型放开：受理人(13) 在 bug 与 feature 单上传/删除 delivery + 上传 spec 均 200（原先仅 bug 可用）');

    // ② 示例发布者(7)：C1 后不再是协调人，全类型均拒（他既不在册开发、也不再有协调人身份）
    for (const [type, st] of [['bug', '处理中'], ['feature', '开发中']]) {
      const id = await mkIssue(type, st);
      let r = await upload(ATT(id), liaisonTok, { attachment_type: 'delivery' }, `x-${type}.png`);
      assert.strictEqual(r.status, 403, `⭐ 示例发布者(7) 在 ${type} 单上传 delivery 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
      r = await upload(ATT(id), liaisonTok, { attachment_type: 'spec' }, `y-${type}.pdf`);
      assert.strictEqual(r.status, 403, `⭐ 示例发布者(7) 在 ${type} 单上传 spec 应 403，实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
    ok('⭐ [C1] 技术负责人无附件权：示例发布者(7) 在 bug 与 feature 单上传 delivery/spec 全部 403（方案 v1.5 §3「不看附件」）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S32 附件部分①：族外/未知状态写 → 拒（assertKnownIssueStatus 前置）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '这是一个不存在的状态');
    let r = await upload(ATT(id), adminTok, { attachment_type: 'spec' }, 'g.pdf');
    assert.strictEqual(r.status, 409, `S32①：族外状态上传应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'GATE_INVARIANT', 'S32①：错误码 GATE_INVARIANT（assertKnownIssueStatus 前置）');
    ok('S32①：族外/未知 (issue_type,status) 上传 → 409 GATE_INVARIANT（附件写先过 assertKnownIssueStatus）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // S32 附件部分②：待上线（RELEASE 族，非 DEV∪VERIFY）delivery 上传拒；已上线（TERMINAL）spec 删除拒
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待上线');
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const r = await upload(ATT(id), devTok(5), { attachment_type: 'delivery' }, 'h.png');
    assert.strictEqual(r.status, 409, `S32②a：待上线态 delivery 上传应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT', 'S32②a：错误码 INVALID_STATE_FOR_ATTACHMENT');
    ok('S32②a：待上线（RELEASE 族，非 SYS_DEV∪SYS_VERIFY）delivery 上传 → 409（在册身份满足，纯状态门拒）');

    const id2 = await mkIssue('feature', '开发中');
    const specId = await mkAttachment(id2, 'spec', 1, '管理员', null);
    await run(`UPDATE sys_issues SET status = '已上线' WHERE id = ?`, [id2]);
    const del = await call('DELETE', `/api/sys-issues/${id2}/attachments/${specId}`, adminTok);
    assert.strictEqual(del.status, 409, `S32②b：已上线态 spec 删除应 409，实际 ${del.status} ${JSON.stringify(del.body)}`);
    assert.strictEqual(del.body.code, 'ATTACHMENT_BOUND_NOT_DELETABLE', 'S32②b：错误码 ATTACHMENT_BOUND_NOT_DELETABLE');
    assert.strictEqual((await attRow(specId)).status, 'active', 'S32②b：拒绝后 spec 行仍 active');
    ok('S32②b：已上线（TERMINAL 族）spec 删除 → 409 ATTACHMENT_BOUND_NOT_DELETABLE（admin/协调人也拦，判定看状态）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // round_no 遗产③：存量已绑 round_no 的历史行——非终态可删（round_no 不再是判定依据）；终态同样拦
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    const daId = await mkMember(id, 5, '开发甲', 'code_submitted');
    const legacyAttId = await mkAttachment(id, 'delivery', 5, '开发甲', 3);   // 存量行：round_no=3（旧模型已绑）
    assert.strictEqual((await attRow(legacyAttId)).round_no, 3, '前置：存量行 round_no=3 已落库');

    // 非终态（开发中）：旧模型会因 round_no NOT NULL 拒绝删除（409 ATTACHMENT_BOUND_NOT_DELETABLE）；
    // 新模型 round_no 不参与判定，仅看状态族——非终态 → 允许删除（上传者本人在册）。
    const del1 = await call('DELETE', `/api/sys-issues/${id}/attachments/${legacyAttId}`, devTok(5));
    assert.strictEqual(del1.status, 200, `round_no 遗产③a：非终态下存量已绑行应可删，实际 ${del1.status} ${JSON.stringify(del1.body)}`);
    assert.strictEqual(await attRow(legacyAttId), undefined, 'round_no 遗产③a：物理删除');
    ok('round_no 遗产③a：存量 round_no NOT NULL 行在非终态下可删（判定依据已从 round_no 改为终态族，与旧模型行为不同，属预期变化）');

    // 终态下：即便 round_no 是 NULL（新模型正常落库形态），一样被终态门拦——round_no 值不影响结果。
    const legacyAttId2 = await mkAttachment(id, 'delivery', 5, '开发甲', null);
    await run(`UPDATE sys_issues SET status = '已作废' WHERE id = ?`, [id]);
    const del2 = await call('DELETE', `/api/sys-issues/${id}/attachments/${legacyAttId2}`, devTok(5));
    assert.strictEqual(del2.status, 409, `round_no 遗产③b：终态下应拒，实际 ${del2.status} ${JSON.stringify(del2.body)}`);
    assert.strictEqual(del2.body.code, 'ATTACHMENT_BOUND_NOT_DELETABLE');
    ok('round_no 遗产③b：终态门与 round_no 值无关（NULL/NOT NULL 结果一致）——round_no 列已彻底退出判定，仅作历史数据保留');
    void daId;
  }

  // ══════════════════════════════════════════════════════════════════════
  // DEV∪VERIFY 上传窗口：VERIFY 态在册可传（现网 isDevWorkState 仅放 DEV，属真实行为放宽，正向断言）；
  //   D_PRE 态仍拒（未拓宽越界）
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '待验证');
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const r = await upload(ATT(id), devTok(5), { attachment_type: 'screenshot' }, 'i.png');
    assert.strictEqual(r.status, 200, `DEV∪VERIFY窗口：待验证态在册上传 screenshot 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[C5] DEV∪VERIFY 上传窗口：待验证（VERIFY 族）在册开发可传 screenshot → 200（§5.4 拓宽，原 isDevWorkState 仅放 DEV 会 409）');

    const idPre = await mkIssue('feature', '待指派');
    await mkMember(idPre, 5, '开发甲', 'pending');
    const r2 = await upload(ATT(idPre), devTok(5), { attachment_type: 'delivery' }, 'j.png');
    assert.strictEqual(r2.status, 409, `DEV∪VERIFY窗口：D_PRE 态上传应仍 409，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    assert.strictEqual(r2.body.code, 'INVALID_STATE_FOR_ATTACHMENT');
    ok('DEV∪VERIFY 上传窗口：待指派（D_PRE 族）在册开发上传 delivery → 仍 409（未越界拓宽，只加 VERIFY 不加 D_PRE）');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 下载矩阵收尾：无关 user（非在册/非历史参与/非协调人/非 admin）→ 403
  // ══════════════════════════════════════════════════════════════════════
  {
    const id = await mkIssue('feature', '开发中');
    await mkMember(id, 5, '开发甲', 'code_submitted');
    const specId = await mkAttachment(id, 'spec', 1, '管理员', null);
    const dl = await download(dlPath(id, specId), devTok(8));   // dev8 与本单毫无关系
    assert.strictEqual(dl.status, 403, `下载矩阵：无关 user 下载应 403，实际 ${dl.status}`);
    assert.strictEqual((await call('GET', `/api/sys-issues/${id}`, adminTok)).status, 200, '前置健全性：详情可读（admin）');
    ok('下载矩阵收尾：无关 user（非在册/非历史/非协调人/非 admin）下载 → 403 NOT_AUTHORIZED_TO_VIEW');
  }

  server.close();
  console.log(`\n✅ verify-sys-multidev-attachments 全部通过：${passed} 组断言`);
}

main().catch(e => { console.error('❌ verify-sys-multidev-attachments 失败:', e && (e.stack || e.message || e)); if (server) server.close(); process.exit(1); });
