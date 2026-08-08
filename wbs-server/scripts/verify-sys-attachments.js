// 验证脚本：系统迭代 附件（上传 / 下载 / 删除 / supersede）——单人基线场景，C3b 建立 + C5 附件授权改造随本次更新
//   用法：node scripts/verify-sys-attachments.js
//   多开发 roster 矩阵场景（历史参与/broad_user/协调人/DEV∪VERIFY 窗口/round_no 遗产存量行）见
//   verify-sys-multidev-attachments.js（C5 新增，两文件不重复覆盖同一场景）。
//
// in-process express app（挂真实 router）+ 内存库 + 真实临时落盘（_sys-attach-test-deps）+ 自签 token，覆盖：
//   1. 上传 delivery/screenshot（在册∨协调人·SYS_DEV∪SYS_VERIFY，round_no 恒 NULL）/ spec（协调人·∉SYS_TERMINAL）
//   2. 上传权限/状态/类型/无文件负向（403/409/400）——C5：admin 本就是协调人，delivery 上传由 403 改判 200（断言变更①）
//   3-5. [C3 退场] 旧 submit attachment_ids round_no 绑定机制（11-H2/RC-M4/orphan 回滚/spec 白名单排除）整体退场
//        ——新 §6.1 submit body 契约仅 {mode,...}，attachment_ids 为多余字段 → 400 VALIDATION；round_no 恒 null
//   6. supersede（10-M1 旧 spec superseded + 新 active）+ active 过滤（详情仅 active）
//   7. 12-M1 二次 WHERE attachment_type 守卫：spec supersede 不误伤 delivery
//   8. 下载（C5·§5.4：admin/协调人/在册/历史参与 200，其他 403，不存在 404；作废单下载不再单独 403——
//      断言变更②，下载列无状态限定，见完成报告契约裁定点）
//   9. 删除（C5·§5.4：(上传者∧非历史参与∨协调人∨admin) ∧ ∉SYS_TERMINAL；round_no 遗产③=旧"已绑定"判定改判"终态"）
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./_sys-attach-test-deps');   // A9：物理删除/越界路径断言用真实落盘根
const absOf = (relFileName) => path.join(UPLOAD_DIR, relFileName);   // file_name 相对 UPLOAD_DIR

const SECRET = 'verify-sys-attach-secret';
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
  ...require('./_sys-attach-test-deps'),   // C3b：真实临时落盘 + normalizeAttachmentExt/safeDeleteFileSync/ALLOWED_FILE_DIRS
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
const dev2Tok = jwt.sign({ id: 6, username: 'dev2', display_name: '开发李', role: 'user' }, SECRET);
// [C4 合并修复批 275-M5] 示例对接人（受理人白名单，SYS_INTAKE_LIAISON_IDS[13]）——真实 ⑦ 路径夹具需要它
// 调 liaison-test-pass。
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);

let server, port;
const png = Buffer.from('89504e470d0a1a0a', 'hex');

// JSON 端点
function call(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
// multipart 上传（fileName=null → 不带文件，测 NO_FILE）
function upload(path, tok, fields, fileName, fileBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysAttBoundary' + (path.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(fileBuf || png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
// 下载（不解析 body，只取 status + 字节数）
function download(path, tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { 'Authorization': 'Bearer ' + tok } },
      (r) => { let n = 0; r.on('data', c => n += c.length); r.on('end', () => resolve({ status: r.statusCode, bytes: n })); });
    req.on('error', reject); req.end();
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

async function seedDev(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't', system_name: 'BMS', source: '内部', description: '建单优化批 C1 fixture 补齐：verify 场景建单', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // ⭐ 角色权限重构 C2.5 撤销（v2.1）：建单直落「待受理」，无需再走预沟通段。
  // ⭐ 角色权限重构 C0：受理门仍必经 → 补一步受理，落态回到旧的 待指派/待处理（下游断言不变）
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  // ⭐ 角色权限重构 v2.1 §4：变更流 assign 前置要求 oa_number 通过校验 → 待指派态内先补号。
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.0-⑥·C4a 涟漪修复] 本文件测附件上传/下载/删除/supersede
  // 机制（SYS_DEV∪SYS_VERIFY 状态窗口），与「待对接测试」段本身无关（后者由专门的
  // verify-sys-liaison-test.js 覆盖）。让对接人在 GATE 判定时失效，触发 §3.0-⑥ 降级路径，使 submit
  // 仍直落"待验证"——本文件其余断言零改动，这也是方案承认的合法真实场景（非造假绕过）。
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);
  const tok = assignTo === 5 ? devTok : dev2Tok;
  r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: EST, estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
// [C4 合并修复批 275-M5] 真实 ⑦ 路径代表夹具——本文件其余场景默认走上方 seedDev 的 999999 降级(⑥)
// 简化路径（附件机制本身与走⑥/⑦无关，见 seedDev 注释）。但"全部夹具都 999999 化"意味着「开发中→⑦
// 待对接测试→liaison_test_pass→待验证」这条真实链路若出现跨模块回归（例如附件在「待对接测试」新增
// 状态窗口下的可见性/上传权限被意外破坏），本文件全 ⑥ 化的夹具集合完全测不出来。本函数保留有效
// intake_liaison_id=13，走真实 GATE ⑦，用于下方 [15] 段落跑 1-2 条本文件原有代表性下游断言。
async function seedDevViaRealLiaisonTest(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't-真实⑦路径', system_name: 'BMS', source: '内部', description: '275-M5 真实⑦路径 fixture', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  // [工期对接测试与风险等级拆分 方案 v1.1 §3.4·C5] feature 受理必带 risk_level。
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070099' });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  const tok = assignTo === 5 ? devTok : dev2Tok;
  r = await call('POST', `/api/sys-issues/${id}/estimate`, tok, { dev_estimated_at: EST, estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  r = await call('POST', `/api/sys-issues/${id}/submit`, tok, { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
  assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.main_status, '待对接测试', '[275-M5] submit → 待对接测试（真实 ⑦ 路径，非 999999 降级）');
  // ⭐ D22-④ 批2：pass 现须凭证二选一，本夹具补 test_note。
  r = await call('POST', `/api/sys-issues/${id}/liaison-test-pass`, liaisonTok, { test_note: '275-M5 夹具测试通过' });
  assert.strictEqual(r.status, 200, 'liaison-test-pass 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  assert.strictEqual(r.body.status, '待验证', '[275-M5] liaison-test-pass → 待验证');
  return id;
}
const ATT = (id) => `/api/sys-issues/${id}/attachments`;
const attRow = (attId) => get('SELECT id, attachment_type, round_no, status FROM sys_issue_attachments WHERE id=?', [attId]);
const activeAtts = (id) => all("SELECT id, attachment_type, round_no FROM sys_issue_attachments WHERE issue_id=? AND status='active' ORDER BY id", [id]);

async function main() {
  mod.initSchema();
  await waitReady();
  // 建单优化批 C3b（方案 §6c）：主建单端点需求方三字段全空时会 SELECT users.phone 做固化——
  //   users 夹具须含该列，否则撞 SQLITE_ERROR: no such column: phone（本次一并补齐）。
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(6,'dev2','开发李','user'),(9,'viewer','查看者','viewer'),(13,'wangtaotao','示例对接人','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ── [1] 上传 delivery / screenshot / spec（正向）──
    const id1 = await seedDev(5);
    let r = await upload(ATT(id1), devTok, { attachment_type: 'delivery' }, 'a.png');
    assert.strictEqual(r.status, 200, 'delivery 上传 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const d1 = r.body.attachments[0].id;
    let row = await attRow(d1);
    assert.strictEqual(row.attachment_type, 'delivery'); assert.strictEqual(row.round_no, null); assert.strictEqual(row.status, 'active');
    ok('上传 delivery（开发本人·开发中）→ 200，round_no=NULL 暂存 active');

    r = await upload(ATT(id1), devTok, { attachment_type: 'screenshot' }, 's.png');
    assert.strictEqual(r.status, 200, 'screenshot 200');
    const s1 = r.body.attachments[0].id;
    assert.strictEqual((await attRow(s1)).round_no, null);
    ok('上传 screenshot（开发本人）→ 200，round_no=NULL 暂存');

    r = await upload(ATT(id1), adminTok, { attachment_type: 'spec' }, 'spec.pdf');
    assert.strictEqual(r.status, 200, 'spec 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const spec1 = r.body.attachments[0].id;
    assert.strictEqual((await attRow(spec1)).round_no, null);
    ok('上传 spec（admin）→ 200，round_no=NULL（永不被 submit 绑）');

    // ── [2] 上传负向（权限/状态/类型/无文件）──
    r = await upload(ATT(id1), devTok, { attachment_type: 'spec' }, 'x.pdf');
    assert.strictEqual(r.status, 403, 'spec 非协调人 403'); assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT');
    ok('上传 spec by 开发（feature 单，非协调人=非 admin 且非 bug 对接人）→ 403');
    // [C5 断言变更①] delivery 上传 = (在册∨协调人) ∧ SYS_DEV∪SYS_VERIFY——admin 恒为协调人，故 admin 上传 delivery
    //   由旧"非 assignee 403"改判 200（§5.4 唯一权威表：delivery 上传行含"admin"，非仅"开发本人"）。
    //   旧断言：r.status===403 code=NOT_AUTHORIZED_FOR_ATTACHMENT；新断言：r.status===200（本条即断言变更①实测）。
    r = await upload(ATT(id1), adminTok, { attachment_type: 'delivery' }, 'x.png');
    assert.strictEqual(r.status, 200, `[C5 断言变更①] delivery 上传 by admin（协调人）应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
    ok('[C5] 上传 delivery by admin（协调人，非在册）→ 200（§5.4：在册∨协调人，原仅"开发本人"过窄）');
    {
      // 本条断言产生真实落库副作用（旧断言是纯负向、零落库）——清理掉，避免污染下方 active 附件计数断言（line ~197）。
      const adminDeliveryId = r.body.attachments[0].id;
      const rClean = await call('DELETE', `/api/sys-issues/${id1}/attachments/${adminDeliveryId}`, adminTok);
      assert.strictEqual(rClean.status, 200, '清理刚上传的 admin delivery（协调人可删，避免影响后续计数）');
    }
    r = await upload(ATT(id1), dev2Tok, { attachment_type: 'delivery' }, 'x.png');
    assert.strictEqual(r.status, 403, 'delivery 非在册非协调人 403');
    ok('上传 delivery by dev2（非在册/非协调人）→ 403');
    r = await upload(ATT(id1), devTok, { attachment_type: 'bogus' }, 'x.png');
    assert.strictEqual(r.status, 400, 'type 非法 400'); assert.strictEqual(r.body.code, 'INVALID_ATTACHMENT_TYPE');
    ok('上传 attachment_type=bogus → 400 INVALID_ATTACHMENT_TYPE');
    r = await upload(ATT(id1), devTok, { attachment_type: 'delivery' }, null);
    assert.strictEqual(r.status, 400, '无文件 400'); assert.strictEqual(r.body.code, 'NO_FILE');
    ok('上传无文件 → 400 NO_FILE');

    // ── [3-5] C3 退场：submit attachment_ids 绑定机制（旧模型 round_no 绑定/A2 严格校验/orphan 回滚/spec 白名单排除）──
    //   随 W05 唯一 submit 收敛整体退场：新 §6.1 submit body 契约仅 {mode:'no_code'|'commits', ...}，
    //   attachment_ids 属「多余字段」→ 400 VALIDATION（写库前拒绝，事务从未开始，无"部分绑定/orphan"概念）。
    //   附件与开发流程彻底解耦；round_no 列保留但不再被任何写路径填充，值恒为 null（见下方替代断言）。
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { mode: 'no_code', no_code_reason: '完成（占位理由）', attachment_ids: [d1, s1] });
    assert.strictEqual(r.status, 400, 'C3：submit 携 attachment_ids（多余字段）→ 400');
    assert.strictEqual(r.body.code, 'VALIDATION', 'C3：多余字段统一走 VALIDATION（非旧 SUBMIT_ATTACHMENT_INVALID）');
    assert.strictEqual((await attRow(d1)).round_no, null, 'C3：拒绝先于任何绑定，d1 未受影响');
    r = await call('POST', `/api/sys-issues/${id1}/submit`, devTok, { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
    assert.strictEqual(r.status, 200, 'submit 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(r.body.main_status, '待验证', 'submit → 待验证（main_status 字段，C2/C3 惯例）');
    assert.strictEqual((await attRow(d1)).round_no, null, 'C3：submit 不再绑定任何附件，delivery round_no 恒 null');
    assert.strictEqual((await attRow(s1)).round_no, null, 'C3：screenshot round_no 恒 null');
    assert.strictEqual((await attRow(spec1)).round_no, null, 'C3：spec round_no 恒 null');
    ok('C3 退场：submit attachment_ids 绑定机制整体退场（多余字段 400 VALIDATION）+ round_no 恒 null（新 §6.1 契约，附件/开发流程解耦）');

    // 详情 GET active（含 round_no 字段供前端读，恒 null）+ A7 specAttachments/hasSpecAttachment（不受 C3 影响，与 submit 无关）
    r = await call('GET', `/api/sys-issues/${id1}`, adminTok);
    assert.strictEqual(r.body.attachments.length, 3, '详情 3 个 active 附件');
    assert.ok(r.body.attachments.every(a => 'round_no' in a), 'A9：每个附件仍含 round_no 字段（值恒 null）');
    assert.strictEqual(r.body.hasSpecAttachment, true, 'A7 hasSpecAttachment=true');
    assert.strictEqual(r.body.specAttachments.length, 1, 'A7 specAttachments 1 个');
    assert.strictEqual(r.body.specAttachments[0].id, spec1, 'A7 specAttachments=spec 子集');
    ok('详情 GET active 附件 + round_no 字段存在 + A7 specAttachments/hasSpecAttachment（12-M2，不受 C3 影响）');

    // id2：不再用于 submit-orphan 场景（C3 退场），仅保留作 [8] 跨单越权下载测试的治具
    const id2 = await seedDev(5);
    await upload(ATT(id2), devTok, { attachment_type: 'delivery' }, 'b.png');

    // ── [6] supersede（10-M1）+ active 过滤 ──
    const id4 = await seedDev(5);
    r = await upload(ATT(id4), adminTok, { attachment_type: 'spec' }, 'v1.pdf'); const specA = r.body.attachments[0].id;
    r = await upload(ATT(id4), adminTok, { attachment_type: 'spec', supersede_id: String(specA) }, 'v2.pdf'); const specB = r.body.attachments[0].id;
    assert.strictEqual(r.status, 200, 'spec 替换 200');
    assert.strictEqual((await attRow(specA)).status, 'superseded', '旧 spec superseded');
    assert.strictEqual((await attRow(specB)).status, 'active', '新 spec active');
    const act4 = await activeAtts(id4);
    assert.ok(act4.every(a => a.id !== specA), 'active 过滤：旧 spec 不在 active 列表');
    assert.ok(act4.some(a => a.id === specB), '新 spec 在 active 列表');
    ok('supersede：旧 spec superseded + 新 active；详情 active 过滤排除旧 spec（10-M1）');

    // ── [7] 12-M1 二次 WHERE attachment_type 守卫：spec supersede 不误伤 delivery ──
    const id5 = await seedDev(5);
    r = await upload(ATT(id5), devTok, { attachment_type: 'delivery' }, 'd.png'); const d5 = r.body.attachments[0].id;
    r = await upload(ATT(id5), adminTok, { attachment_type: 'spec', supersede_id: String(d5) }, 'sp5.pdf');   // 用 spec 上传去 supersede 一个 delivery id
    assert.strictEqual(r.status, 200, 'spec 上传 200');
    assert.strictEqual((await attRow(d5)).status, 'active', '12-M1：delivery 未被 spec-supersede 误伤（仍 active）');
    assert.strictEqual((await attRow(d5)).round_no, null, '12-M1：delivery round_no 未动');
    ok('12-M1：spec supersede 的二次 WHERE attachment_type=spec → 不误伤 delivery（仍 active）');

    // ── [8] 下载（权限 + 不存在 + 作废）──
    const dlPath = (id, attId) => `/api/sys-issues/${id}/attachments/${attId}/download`;
    let dl = await download(dlPath(id1, d1), adminTok);
    assert.strictEqual(dl.status, 200, '下载 admin 200'); assert.ok(dl.bytes > 0, '下载有字节');
    ok('下载：admin → 200 + 字节 > 0');
    dl = await download(dlPath(id1, d1), devTok);
    assert.strictEqual(dl.status, 200, '下载 assignee 200');
    ok('下载：指派开发本人 → 200');
    dl = await download(dlPath(id1, d1), dev2Tok);
    assert.strictEqual(dl.status, 403, '下载非授权 403');
    ok('下载：dev2（非 admin/非 assignee）→ 403');
    dl = await download(dlPath(id1, 888888), adminTok);
    assert.strictEqual(dl.status, 404, '下载不存在 404');
    ok('下载：不存在 attId → 404');
    // 跨单越权：用 id2 的路径取 id1 的附件 id（二次 WHERE issue_id 不匹配）→ 404
    dl = await download(dlPath(id2, d1), adminTok);
    assert.strictEqual(dl.status, 404, '跨单附件 404');
    ok('下载：跨单 attId（issue_id 不匹配二次 WHERE）→ 404');

    // ── [9] 删除（未绑 delivery 本人 / spec admin / 已绑 409 / 非授权 403）──
    const id6 = await seedDev(5);
    r = await upload(ATT(id6), devTok, { attachment_type: 'delivery' }, 'e.png'); const d6 = r.body.attachments[0].id;
    r = await call('DELETE', `/api/sys-issues/${id6}/attachments/${d6}`, dev2Tok);
    assert.strictEqual(r.status, 403, '非上传本人删 403');
    ok('删除未绑 delivery by dev2（非上传本人/非 admin）→ 403');
    r = await call('DELETE', `/api/sys-issues/${id6}/attachments/${d6}`, devTok);
    assert.strictEqual(r.status, 200, '上传本人删 delivery 200');
    assert.strictEqual(await attRow(d6), undefined, '物理删除（行不存在）');
    ok('删除 delivery by 上传本人（在册非历史参与）→ 200 + 物理删行');
    // [C5 round_no 遗产③收口] 旧模型："submit 绑 round_no 后 delivery 变'已提交'不可删"（round_no NOT NULL 判定，
    //   index.js 旧 3697-3699 行）——C3 起 submit 不再写 round_no（[3-5] 已退场），该守卫恒不命中，一度形成
    //   "已提交交付附件失去历史留痕保护"的真实缺口（[C3 遗留缺口] 曾如实记录此状）。C5 已用状态族门补上：
    //   ATTACHMENT_BOUND_NOT_DELETABLE 改判「状态∈SYS_TERMINAL」（§4.0，已上线∪非发布终态，不含待上线）。
    //   id1 此刻状态为「待验证」（VERIFY 族，非终态）——不在新门禁范围内，故 admin（协调人）仍可删除 d1，
    //   这不是遗留缺口，而是"非终态窗口本就允许删除"的正确行为（§5.4：删除条件仅"∉SYS_TERMINAL"，不含
    //   "未提交"这一更严格的旧约束）。
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${d1}`, adminTok);
    assert.strictEqual(r.status, 200, '[C5] 待验证态（非终态）delivery 删除 by 协调人应 200，实际 ' + r.status + ' ' + JSON.stringify(r.body));
    assert.strictEqual(await attRow(d1), undefined, 'C5：非终态窗口内删除成功，物理删除');
    ok('[C5] 删除 delivery（待验证态·非终态）by admin（协调人）→ 200（round_no 遗产③：判定依据已从 round_no 改为终态族）');
    // spec 删除：dev（非协调人/非上传者）→ 403 / admin（协调人）→ 200
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${spec1}`, devTok);
    assert.strictEqual(r.status, 403, 'spec 删 by dev 403');
    ok('删除 spec by dev（非协调人/非上传者）→ 403（需求材料删除=(上传者∨协调人∨admin)）');
    r = await call('DELETE', `/api/sys-issues/${id1}/attachments/${spec1}`, adminTok);
    assert.strictEqual(r.status, 200, 'spec 删 by admin 200');
    assert.strictEqual(await attRow(spec1), undefined, 'spec 物理删除');
    ok('删除 spec by admin → 200 + 物理删 + timeline note');

    // ── [C5 新增] 终态门收口实测：delivery 附件所属单进入 SYS_TERMINAL（已作废）后 → 409 ATTACHMENT_BOUND_NOT_DELETABLE ──
    {
      const id9 = await seedDev(5);
      r = await upload(ATT(id9), devTok, { attachment_type: 'delivery' }, 'terminal-guard.png');
      assert.strictEqual(r.status, 200, '终态门测试：上传 delivery 200');
      const d9 = r.body.attachments[0].id;
      const rVoid = await call('POST', `/api/sys-issues/${id9}/void`, adminTok, { reason: '终态删除防线测试' });
      assert.strictEqual(rVoid.status, 200, '终态门测试：作废成功');
      r = await call('DELETE', `/api/sys-issues/${id9}/attachments/${d9}`, adminTok);
      assert.strictEqual(r.status, 409, `[C5] 终态（已作废）delivery 删除应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ATTACHMENT_BOUND_NOT_DELETABLE', 'C5：终态门错误码 ATTACHMENT_BOUND_NOT_DELETABLE（round_no 遗产③新判定依据）');
      const stillActive = await attRow(d9);
      assert.ok(stillActive && stillActive.status === 'active', 'C5：终态门拦下后附件行仍 active（未被误删，历史留痕保护生效）');
      ok('[C5] round_no 遗产③收口实测：终态（已作废）单的 delivery 附件删除 → 409 ATTACHMENT_BOUND_NOT_DELETABLE（admin/协调人也拦，判定看状态非身份）');
    }

    // ── [10] 作废单上传 spec → 409 ──
    const id7 = await seedDev(5);
    await call('POST', `/api/sys-issues/${id7}/void`, adminTok, { reason: '不做了' });
    r = await upload(ATT(id7), adminTok, { attachment_type: 'spec' }, 'v.pdf');
    assert.strictEqual(r.status, 409, '作废单上传 spec 409'); assert.strictEqual(r.body.code, 'INVALID_STATE_FOR_ATTACHMENT');
    ok('上传 spec 到已作废单 → 409 INVALID_STATE_FOR_ATTACHMENT');
    // [C5 断言变更②] 作废单下载：§5.4 下载列本身无状态限定（admin∨对接人∨在册∨历史参与即放行，不再单独判
    //   "已作废非 admin 403"）——旧断言"非 admin 403"与唯一权威表矛盾，已按契约裁定点改判 200（见完成报告）。
    //   在册开发（此处仍在册，未 remove）下载已作废单附件 → 200；admin 同 200。
    const id8 = await seedDev(5);
    r = await upload(ATT(id8), devTok, { attachment_type: 'delivery' }, 'f.png'); const d8 = r.body.attachments[0].id;
    await call('POST', `/api/sys-issues/${id8}/void`, adminTok, { reason: 'x' });
    dl = await download(dlPath(id8, d8), devTok);
    assert.strictEqual(dl.status, 200, `[C5 断言变更②] 作废单下载 by 在册开发应 200，实际 ${dl.status}`);
    ok('[C5] 下载已作废单附件 by 在册开发 → 200（§5.4 下载列无状态限定；旧断言=403 SYS_ISSUE_VOIDED，本条即断言变更②实测）');
    dl = await download(dlPath(id8, d8), adminTok);
    assert.strictEqual(dl.status, 200, '作废单 admin 下载 200');
    ok('下载已作废单附件 by admin → 200');

    // ── [11] C3 退场：A9 多轮 round_no（MAX+1 序列）──
    //   旧模型 submit 事务内对 attachment_ids 做 MAX(round_no)+1 绑定 + 写 sys_issue_timeline(event_type='submit', round_no=N)。
    //   新模型 submit 不再接受 attachment_ids（§6.1 契约见 [3-5]），且 submit/no_code 事件改写 sys_issue_dev_events
    //   （insertDevEvent，routes/sys-iteration/index.js:1019 起）而非 sys_issue_timeline——round_no 序列绑定机制随之整体退场。
    //   §1 不变量1「完成态不回 pending」：return 不重置 roster dev_status，故单人 roster 在 return 后不能直接
    //   resubmit（需走 remove+re-add 换新实例，属 verify-sys-bug-transitions.js「二轮」场景覆盖，非本文件职责）。
    //   本文件仅记录 return 后 double-guard 正确拒绝直接 resubmit 的边界，替代旧"两轮 round_no"断言。
    //   [codex 98 号 HIGH 回填·同批] ESTIMATE_REQUIRED 恢复后，return 同时清 dev_estimated_at（T-M2）——
    //   resubmit 时新恢复的「dev_estimated_at 未填」闸门在「dev_status 非 pending」闸门**之前**触发（与
    //   e39e65b 版旧 case 'submit' 的检查顺序一致：ESTIMATE_REQUIRED 排在最前），故实际观测错误码由
    //   INVALID_STATUS 改为 ESTIMATE_REQUIRED——这是对旧行为的更忠实复刻，非新引入的不一致。
    {
      const idR = await seedDev(5);
      let rr = await call('POST', `/api/sys-issues/${idR}/submit`, devTok, { mode: 'no_code', no_code_reason: '第一轮（占位理由）', self_tested: true, test_env_deployed: true });
      assert.strictEqual(rr.status, 200, '第一轮 submit 200');
      await call('POST', `/api/sys-issues/${idR}/return`, adminTok, { reason: '列不齐' });            // 回开发中，dev_status 不回 pending（§1 不变量1）+ 清 dev_estimated_at（T-M2）
      rr = await call('POST', `/api/sys-issues/${idR}/submit`, devTok, { mode: 'no_code', no_code_reason: '直接重提（占位理由）', self_tested: true, test_env_deployed: true });
      assert.strictEqual(rr.status, 400, 'return 后直接 resubmit → 400（dev_estimated_at 被 return 清空，ESTIMATE_REQUIRED 先于 dev_status 闸触发）');
      assert.strictEqual(rr.body.code, 'ESTIMATE_REQUIRED');
    }
    ok('C3 退场：round_no 绑定机制随 submit 事件模型迁移整体退场（见 [3-5]）；「完成态不回 pending」边界回归保留');

    // ── [12] A9：supersede 端点级 active 过滤 + superseded 软信号（A4）──
    const idSp = await seedDev(5);
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec' }, 'old.pdf'); const specOld = r.body.attachments[0].id;
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec', supersede_id: String(specOld) }, 'new.pdf'); const specNew = r.body.attachments[0].id;
    assert.strictEqual(r.body.superseded, true, 'A4 supersede 命中 → superseded=true');
    r = await call('GET', `/api/sys-issues/${idSp}`, adminTok);
    assert.ok(r.body.attachments.every(a => a.id !== specOld), '详情端点 active 过滤：旧 spec 不在 attachments');
    assert.ok(r.body.specAttachments.some(a => a.id === specNew) && r.body.specAttachments.every(a => a.id !== specOld), 'specAttachments 仅含新 spec');
    ok('A9：supersede 后详情端点 active 过滤排除旧 spec（端点级）+ A4 superseded=true');
    r = await upload(ATT(idSp), adminTok, { attachment_type: 'spec', supersede_id: '999999' }, 'miss.pdf');
    assert.strictEqual(r.body.superseded, false, 'A4 supersede 不命中 → superseded=false（软信号，新件仍保留）');
    ok('A4：supersede_id 不命中 → superseded=false 软信号');

    // ── [13] A9：下载路径越界 403（污染 file_name=../../）+ 物理删除落盘断言 ──
    const idP = await seedDev(5);
    r = await upload(ATT(idP), devTok, { attachment_type: 'delivery' }, 'phys.png'); const dPhys = r.body.attachments[0].id;
    const dPhysFile = (await get('SELECT file_name FROM sys_issue_attachments WHERE id=?', [dPhys])).file_name;
    assert.ok(fs.existsSync(absOf(dPhysFile)), '上传后文件真实落盘');
    await run(`INSERT INTO sys_issue_attachments (issue_id, attachment_type, round_no, file_name, original_name, uploaded_by, uploaded_by_name, status) VALUES (?,?,?,?,?,?,?,'active')`,
      [idP, 'spec', null, '../../evil.txt', 'evil.txt', 1, 'admin']);
    const evil = await get('SELECT id FROM sys_issue_attachments WHERE issue_id=? AND file_name=?', [idP, '../../evil.txt']);
    dl = await download(dlPath(idP, evil.id), adminTok);   // admin 有权限 → 403 必来自路径守卫
    assert.strictEqual(dl.status, 403, '越界 file_name 下载 403（A5 SYS_UPLOAD_BASE 子树守卫）');
    ok('A9：污染 file_name=../../ 越界 → 下载 403 ILLEGAL_FILE_PATH（A5）');
    r = await call('DELETE', `/api/sys-issues/${idP}/attachments/${dPhys}`, devTok);
    assert.strictEqual(r.status, 200, '删除未绑 delivery 200');
    assert.ok(!fs.existsSync(absOf(dPhysFile)), 'A9：删除后物理文件真消失（非仅删 DB 行）');
    ok('A9：删除未绑 delivery → DB 行删 + 物理文件真消失（落盘断言，验 safeDeleteFileSync）');

    // ── [14] A9：负向扩展名（不在白名单）→ 400（fileFilter 防线）──
    const idE = await seedDev(5);
    for (const fn of ['m.exe', 'v.svg', 'noext']) {
      r = await upload(ATT(idE), devTok, { attachment_type: 'delivery' }, fn);
      assert.strictEqual(r.status, 400, `${fn} → 400`);
    }
    ok('A9：上传 exe/svg/无扩展名 → 400（fileFilter 扩展名白名单防线）');

    // ── [S12 双路审查 Opus-2 MED 收口·方案 §3.5+C0 双登记必做项] delivery/screenshot 附件端点
    //   新增 LIAISON_TEST 族放行——此前本文件（含下方 [15]）只覆盖 pass 之后的「待验证」态，从未在
    //   「待对接测试」本身测过上传。不改 seedDevViaRealLiaisonTest 共享 helper（避免影响它原有
    //   "验证待验证态"职责），单独构造一条走到 submit 即止（落「待对接测试」）的夹具，测完上传后
    //   不再推进（该夹具生命周期到此为止，与下方 [15] 各自独立）。 ──
    {
      let r2 = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't-待对接测试上传', system_name: 'BMS', source: '内部', description: 'S12-Opus-2 待对接测试态上传 fixture', intake_liaison_id: 13 });
      assert.strictEqual(r2.status, 201, '[S12-Opus-2] 建单 201, got ' + r2.status);
      const idLt = r2.body.id;
      await call('POST', `/api/sys-issues/${idLt}/intake-accept`, adminTok, { risk_level: '二级' });
      await call('POST', `/api/sys-issues/${idLt}/schedule`, adminTok, {});
      r2 = await call('POST', `/api/sys-issues/${idLt}/set-oa-number`, adminTok, { oa_number: '2026070098' });
      assert.strictEqual(r2.status, 200, '[S12-Opus-2] 夹具补 OA 号 200, got ' + r2.status);
      await call('POST', `/api/sys-issues/${idLt}/assign`, adminTok, { assigned_to: 5 });
      r2 = await call('POST', `/api/sys-issues/${idLt}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
      assert.strictEqual(r2.status, 200, '[S12-Opus-2] estimate 200, got ' + r2.status);
      r2 = await call('POST', `/api/sys-issues/${idLt}/submit`, devTok, { mode: 'no_code', no_code_reason: '完成（占位理由）', self_tested: true, test_env_deployed: true });
      assert.strictEqual(r2.status, 200, '[S12-Opus-2] submit 200, got ' + r2.status);
      assert.strictEqual(r2.body.main_status, '待对接测试', '[S12-Opus-2] 前置：submit → 待对接测试（真实 ⑦ 路径，非 999999 降级）');

      const uploadDelivery = await upload(ATT(idLt), devTok, { attachment_type: 'delivery' }, 'lt-delivery.png');
      assert.strictEqual(uploadDelivery.status, 200, `[S12-Opus-2] ⭐ 待对接测试态上传 delivery 应 200，实际 ${uploadDelivery.status} ${JSON.stringify(uploadDelivery.body)}`);
      const uploadScreenshot = await upload(ATT(idLt), devTok, { attachment_type: 'screenshot' }, 'lt-screenshot.png');
      assert.strictEqual(uploadScreenshot.status, 200, `[S12-Opus-2] ⭐ 待对接测试态上传 screenshot 应 200，实际 ${uploadScreenshot.status} ${JSON.stringify(uploadScreenshot.body)}`);
      ok('[S12-Opus-2] MED 收口：delivery/screenshot 附件端点在「待对接测试」态上传均 200（LIAISON_TEST 族已加入白名单，此前只覆盖 DEV∪VERIFY 两族，方案 §3.5+C0 双登记必做项补齐）');
    }

    // ── [15] C4 合并修复批 275-M5：真实 ⑦ 路径代表夹具——跑 1-2 条本文件原有代表性下游断言 ──
    const idReal = await seedDevViaRealLiaisonTest(5);
    r = await upload(ATT(idReal), devTok, { attachment_type: 'delivery' }, 'real-path.png');
    assert.strictEqual(r.status, 200, '[275-M5] 真实⑦路径落「待验证」后上传 delivery 应 200, got ' + r.status + ' ' + JSON.stringify(r.body));
    const dReal = r.body.attachments[0].id;
    row = await attRow(dReal);
    assert.strictEqual(row.status, 'active', '[275-M5] 真实⑦路径夹具的附件行 status=active');
    dl = await download(dlPath(idReal, dReal), adminTok);
    assert.strictEqual(dl.status, 200, '[275-M5] 真实⑦路径夹具·admin 下载该附件应 200, got ' + dl.status);
    ok('[275-M5] 真实⑦路径代表夹具：submit→待对接测试→liaison-test-pass→待验证 全走真实链路（非 999999 降级）后，附件上传/下载两条本文件原有代表性断言仍成立（防正常主路径跨模块回归被全 ⑥ 化的夹具集合掩盖）');

    console.log(`\n✅ verify-sys-attachments 全部通过（${passed} 项断言）`);
  } finally {
    server.close();
    db.close();
  }
}
main().catch((e) => { console.error('❌ verify-sys-attachments 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
