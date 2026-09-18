// 验证脚本：系统迭代 验收通过 accept 说明+附件 / 验收打回 return 附件
//   SSOT = docs/local/系统迭代/验收说明附件与admin闭环放开_决策记录_20260906_v1.0.md
//          §2 D3/D4、§3 J4-J13、§4「S2 系统迭代」段
//   用法：node scripts/verify-sys-accept-evidence.js
//
// in-process express app（挂真实 router）+ 内存库 + 真实临时落盘（_sys-attach-test-deps）+ 自签 token，
// 骨架抄 verify-sys-liaison-test.js（in-process 范式）+ verify-sys-attachments.js（multipart 上传/落盘）。
// 夹具走真实 API 到「待验证」（improvement 路径最短：create→intake_accept→set-oa-number→assign→
// estimate→submit，改流不经「待对接测试」段——IMPROVEMENT_FLOW_TRANSITIONS 的 submit 静态边直落
// 「待验证」，见 transitions.js :294）。
//
// 覆盖：
//   [A1]   accept 无 note 无 ids → 200，payload_json/summary 均 NULL（D3：90 处既有 /accept 调用零改动契约）
//   [A2]   accept note（无附件）→ payload_json.note 精确形状 + summary 精确文案
//   [A2b]  note 100 码点（含 emoji）→ summary 预览恰 80 码点 + '…'（码点非 UTF-16 code unit）；payload_json.note 全文
//   [A3]   note 501 码点 → 400 ACCEPT_NOTE_TOO_LONG，零副作用（状态/timeline 行数不变）
//   [A3b]  note 非字符串（数字）→ 400 ACCEPT_NOTE_INVALID
//   [A4]   真实上传 screenshot 拿 id → accept {attachment_ids} → payload_json/summary 精确形状
//   [A5]   note+ids 同传 → payload_json 两键共存 + summary 说明预览带附件后缀
//   [A6]   ids 含另一张单的附件 id → 400 ACCEPT_ATTACHMENT_INVALID，零副作用
//   [A7]   ids 指向 spec 类型 / 已 superseded 的附件 → 均 400 ACCEPT_ATTACHMENT_INVALID
//   [A8]   ids 非数组/含 0/含 'x'/长度 6 → 均 400 ACCEPT_ATTACHMENT_IDS_INVALID，状态不变
//   [A9]   C9 无 commit 直翻夹具 + note → 落「已上线」，summary 恒为 SYS_NO_COMMIT_ONLINE_SUMMARY 审计文案
//          （不被验收说明挤掉），note 仍写入 payload_json（决策记录 J7）
//   [R1]   return 无 reason → 400 RETURN_REASON_REQUIRED（既有回归）
//   [R2]   return reason+ids → payload_json 精确形状 + summary===reason（不变）+ return_count++
//   [R3]   return ids 非本单 → 400 RETURN_ATTACHMENT_INVALID，状态不变
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-accept-evidence-secret';
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
  ...require('./_sys-attach-test-deps'),   // 真实临时落盘 + normalizeAttachmentExt/safeDeleteFileSync/ALLOWED_FILE_DIRS
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
const devTok = jwt.sign({ id: 5, username: 'dev', display_name: '开发王', role: 'user' }, SECRET);

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
// multipart 上传（同 verify-sys-attachments.js 范式）
function upload(p, tok, fields, fileName, fileBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysAcceptEvidenceBoundary' + (p.length * 7919);
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    if (fileName) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: image/png\r\n\r\n`));
      chunks.push(fileBuf || png); chunks.push(Buffer.from('\r\n'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
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

const issueRow = (id) => get('SELECT * FROM sys_issues WHERE id=?', [id]);
const statusOf = async (id) => (await issueRow(id)).status;
const timelineCount = async (id) => {
  const r = await get('SELECT COUNT(*) AS c FROM sys_issue_timeline WHERE issue_id=?', [id]);
  return r.c;
};
// accept 恒 event_type='status_change' + action_code='accept'（transitions.js 三条目一致，见 :309/654/943）；
// return 恒 event_type='return' + action_code=null（transitions.js 三条目一致，见 :318/663/952）。
const latestAcceptTimeline = (id) => get(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND action_code='accept' ORDER BY id DESC LIMIT 1`, [id]);
const latestReturnTimeline = (id) => get(`SELECT * FROM sys_issue_timeline WHERE issue_id=? AND event_type='return' ORDER BY id DESC LIMIT 1`, [id]);
// [C3c·M1·538 回卷] accept 端只要进入「已写 payload」分支（note/attachment_ids/config online_mode/
// expected_delivery_rev 任一），delivery_rev 现无条件写入（见 index.js accept 分支注释）——本文件
// A2/A4/A5/A10/A11 四条 deepStrictEqual 精确形状断言原本按「改前」契约只列 note/attachment_ids 键，
// 现须补上 delivery_rev 键。accept 本身不改交付内容（commits/attachments），事后 computeDeliveryRev(id)
// 与事务内当时算出的值同源同值，可直接拿来拼期望对象。
async function expectAcceptPayloadWithRev(id, tl, extraFields, msg) {
  const rev = await I.computeDeliveryRev(id);
  assert.deepStrictEqual(JSON.parse(tl.payload_json), { ...extraFields, delivery_rev: rev }, msg);
}

let oaSeq = 20260906001;
// improvement 最短路径夹具：create → intake-accept(risk_level) → set-oa-number → assign → estimate →
// submit → 落「待验证」。opts.mode='commits'（默认，≥1 条 commit，accept 时不会命中 C9 直翻）或
// 'no_code'（零 commit，供 [A9] C9 直翻夹具专用）。
async function seedImprovementToVerify(opts = {}) {
  const mode = opts.mode || 'commits';
  let r = await call('POST', '/api/sys-issues', adminTok, {
    intake_contract_version: 2, type: 'improvement', title: opts.title || 'S2a-验收说明附件-fixture',
    system_name: 'BMS', source: '内部', description: 'S2a 验收说明附件与打回附件 verify 场景建单',
    intake_liaison_id: 13,
  });
  assert.strictEqual(r.status, 201, `建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  r = await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  assert.strictEqual(r.status, 200, `受理通过 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: String(oaSeq++) });
  assert.strictEqual(r.status, 200, `补 OA 号 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: 5 });
  assert.strictEqual(r.status, 200, `assign 200, got ${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, `estimate 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const submitBody = mode === 'no_code'
    ? { mode: 'no_code', no_code_reason: 'C9 直翻夹具（占位理由）', self_tested: true, test_env_deployed: true }
    : { mode: 'commits', commits: [{ component: 'backend', commit_ref: `fix/accept-evidence-${id}` }], self_tested: true, test_env_deployed: true };
  r = await call('POST', `/api/sys-issues/${id}/submit`, devTok, submitBody);
  assert.strictEqual(r.status, 200, `submit 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.main_status, '待验证', `submit → 待验证 fixture 前置，got ${r.body.main_status}`);
  return id;
}
async function uploadScreenshot(issueId, fileName) {
  const r = await upload(`/api/sys-issues/${issueId}/attachments`, adminTok, { attachment_type: 'screenshot' }, fileName || 'evidence.png');
  assert.strictEqual(r.status, 200, `上传 screenshot 200, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.attachments[0].id;
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, status, phone) VALUES
    (1,'admin','管理员','admin','active','13900000001'),(5,'dev','开发王','user','active','13900000005'),(13,'wangtaotao','示例对接人','user','active','13900000013')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users（admin/dev/示例对接人）');

  try {
    // ══════════════════════════════════════════════════════════════════════
    // [A1] accept 无 note 无 ids → 200；timeline 最新 accept 行 payload_json/summary 均 NULL；status=待上线
    //   [C3b·【A1】注释] expected_delivery_rev（方案 v1.5 D11）也是同一枚 payload 开关——传了才打开 payload
    //   （见 index.js accept 分支 hasExpectedDeliveryRev），本用例不传该键，D3「90 处既有零改动」契约不受
    //   影响，payload_json 仍应为 NULL（版本锁校验本身也缺省放行，见 verify-sys-submit-amend.js [版本锁]组）。
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, {});
      assert.strictEqual(r.status, 200, `[A1] accept 无 note 无 ids 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '待上线', '[A1] accept → 待上线');
      const tl = await latestAcceptTimeline(id);
      assert.strictEqual(tl.payload_json, null, '[A1] ⭐ timeline 最新 accept 行 payload_json IS NULL（D3：无说明无附件时零改动契约）');
      assert.strictEqual(tl.summary, null, '[A1] ⭐ summary IS NULL（既有行为逐字不变，90 处既有 /accept 调用零改动）');
      assert.strictEqual(await statusOf(id), '待上线', '[A1] 落库 status=待上线');
      ok('[A1] accept 无 note 无 ids → 200，payload_json/summary 均 NULL（决策记录 D3：90 处既有 /accept 调用零改动契约）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A2] accept note（无附件）→ payload_json 精确形状 + summary 精确文案
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const note = '验收通过，功能符合预期';
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note });
      assert.strictEqual(r.status, 200, `[A2] accept note 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      await expectAcceptPayloadWithRev(id, tl, { note }, '[A2] ⭐ payload_json 精确形状：note + delivery_rev 两键（无附件，attachment_ids 不落键——538 回卷 M1 起进入 payload 分支恒带 delivery_rev）');
      assert.strictEqual(tl.summary, `验收说明：${note}`, '[A2] ⭐ summary 精确文案（决策记录 J7：说明预览+可选附件后缀，本例无附件后缀）');
      ok('[A2] accept note（无附件）→ payload_json={note,delivery_rev} + summary="验收说明：<note>"（决策记录 J6/J7 + 538 回卷 M1）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A2b] note 100 码点（含 emoji）→ summary 预览恰 80 码点 + '…'；payload_json.note 全文
    // ══════════════════════════════════════════════════════════════════════
    {
      const note = '测'.repeat(50) + '😀'.repeat(50);   // 50+50=100 码点（非 UTF-16 长度：'😀' 占 2 code unit）
      assert.strictEqual([...note].length, 100, '[A2b] fixture 前置：应恰 100 码点');
      const id = await seedImprovementToVerify();
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note });
      assert.strictEqual(r.status, 200, `[A2b] accept 100 码点 note 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      const expectedPreview = [...note].slice(0, 80).join('') + '…';
      assert.strictEqual(tl.summary, `验收说明：${expectedPreview}`, '[A2b] ⭐ summary 预览恰 80 码点 + 省略号（码点计数，非 UTF-16 code unit 计数——emoji 不被截断在代理对中间）');
      assert.strictEqual(JSON.parse(tl.payload_json).note, note, '[A2b] ⭐ payload_json.note 保存全文（100 码点未截断，summary 只是预览）');
      ok('[A2b] note 100 码点（含 emoji 代理对）→ summary 预览按码点截取恰 80+"…"，payload_json.note 全文保真');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A3] note 501 码点 → 400 ACCEPT_NOTE_TOO_LONG，零副作用（状态/timeline 行数不变）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const before = await timelineCount(id);
      const longNote = 'x'.repeat(501);
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note: longNote });
      assert.strictEqual(r.status, 400, `[A3] note 501 码点应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ACCEPT_NOTE_TOO_LONG', '[A3] 错误码 ACCEPT_NOTE_TOO_LONG');
      assert.strictEqual(await statusOf(id), '待验证', '[A3] 拒绝后状态不变（整事务回滚，未落库）');
      assert.strictEqual(await timelineCount(id), before, '[A3] timeline 行数不变（零副作用）');
      ok('[A3] note 501 码点（超 500 上限）→ 400 ACCEPT_NOTE_TOO_LONG，状态/timeline 零副作用');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A3b] note 非字符串（数字）→ 400 ACCEPT_NOTE_INVALID
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const before = await timelineCount(id);
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note: 12345 });
      assert.strictEqual(r.status, 400, `[A3b] note 非字符串应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ACCEPT_NOTE_INVALID', '[A3b] 错误码 ACCEPT_NOTE_INVALID');
      assert.strictEqual(await statusOf(id), '待验证', '[A3b] 拒绝后状态不变');
      assert.strictEqual(await timelineCount(id), before, '[A3b] timeline 行数不变（零副作用·Opus 预筛 L1）');
      ok('[A3b] note 非字符串（数字 12345）→ 400 ACCEPT_NOTE_INVALID，状态/timeline 零副作用');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A4] 真实上传 screenshot 拿 id → accept {attachment_ids} → payload_json/summary 精确形状
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const attId = await uploadScreenshot(id, 'a4-evidence.png');
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [attId] });
      assert.strictEqual(r.status, 200, `[A4] accept 携真实附件 id 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      await expectAcceptPayloadWithRev(id, tl, { attachment_ids: [attId] }, '[A4] ⭐ payload_json 精确形状：attachment_ids + delivery_rev 两键（无说明，note 不落键；538 回卷 M1 起恒带 delivery_rev）');
      assert.strictEqual(tl.summary, '验收附件 1 个', '[A4] ⭐ summary 精确文案（仅附件路径固定文案，决策记录 J7）');
      ok('[A4] 真实上传 screenshot（POST /sys-issues/:id/attachments）拿 id → accept {attachment_ids} → payload_json={attachment_ids:[id],delivery_rev} + summary="验收附件 1 个"');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A5] note+ids 同传 → payload_json 两键共存 + summary 说明预览带附件后缀
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const attId = await uploadScreenshot(id, 'a5-evidence.png');
      const note = '验收通过（附截图为证）';
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note, attachment_ids: [attId] });
      assert.strictEqual(r.status, 200, `[A5] accept 携说明+附件应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      await expectAcceptPayloadWithRev(id, tl, { note, attachment_ids: [attId] }, '[A5] ⭐ payload_json 三键共存（note+attachment_ids+delivery_rev，538 回卷 M1 起恒带 delivery_rev）');
      assert.strictEqual(tl.summary, `验收说明：${note}（另有 1 个验收附件）`, '[A5] ⭐ summary=说明预览+附件数量后缀（决策记录 J7）');
      ok('[A5] note+ids 同传 → payload_json={note,attachment_ids,delivery_rev} + summary="验收说明：<note>（另有 1 个验收附件）"');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A6] ids 含另一张单的附件 id → 400 ACCEPT_ATTACHMENT_INVALID，零副作用
    // ══════════════════════════════════════════════════════════════════════
    {
      const idSelf = await seedImprovementToVerify();
      const idOther = await seedImprovementToVerify();
      const otherAttId = await uploadScreenshot(idOther, 'a6-other-issue.png');
      const beforeStatus = await statusOf(idSelf);
      const beforeCount = await timelineCount(idSelf);
      const r = await call('POST', `/api/sys-issues/${idSelf}/accept`, adminTok, { attachment_ids: [otherAttId] });
      assert.strictEqual(r.status, 400, `[A6] 跨单附件 id 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'ACCEPT_ATTACHMENT_INVALID', '[A6] 错误码 ACCEPT_ATTACHMENT_INVALID');
      assert.strictEqual(await statusOf(idSelf), beforeStatus, '[A6] 拒绝后状态不变（整事务回滚）');
      assert.strictEqual(await timelineCount(idSelf), beforeCount, '[A6] timeline 未增行');
      ok('[A6] ids 含另一张单的附件 id（WHERE issue_id 不匹配）→ 400 ACCEPT_ATTACHMENT_INVALID，零副作用');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A7] ids 指向 spec 类型 / 已 superseded 的附件 → 均 400 ACCEPT_ATTACHMENT_INVALID
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      // spec 类型：admin 恒为协调人，待验证态（非终态）可上传 spec；resolveEvidenceAttachmentIds 只放行
      // delivery/screenshot 两类，spec 结构上必被拒。
      const upSpec = await upload(`/api/sys-issues/${id}/attachments`, adminTok, { attachment_type: 'spec' }, 'a7-spec.pdf');
      assert.strictEqual(upSpec.status, 200, `[A7] 上传 spec 200, got ${upSpec.status} ${JSON.stringify(upSpec.body)}`);
      const specId = upSpec.body.attachments[0].id;

      // 已 superseded：delivery/screenshot 无真实 API 路径产出 superseded 态（supersede 机制仅接在 spec
      // 分支，见 index.js :14158 一带"12-M1 二次 WHERE attachment_type='spec'"）——raw SQL 直接改状态
      // 模拟"曾 active 后来失效"边界态，同 verify-sys-liaison-test.js 惯例（[6b]/[6c] 等直改花名册字段）。
      const upSS = await upload(`/api/sys-issues/${id}/attachments`, adminTok, { attachment_type: 'screenshot' }, 'a7-superseded.png');
      assert.strictEqual(upSS.status, 200, `[A7] 上传待作废 screenshot 200, got ${upSS.status}`);
      const ssId = upSS.body.attachments[0].id;
      await run(`UPDATE sys_issue_attachments SET status='superseded' WHERE id=?`, [ssId]);
      // [#83·S1 订正] beforeA7 挪到两次上传（均各自写一条 attachment_added 时间线行，方案 v1.3 B1）之后、
      // 两次预期 400 accept 之前——本用例断言的是"两次**被拒绝**的 accept 零副作用"，不是"上传零副作用"
      // （上传写行是 #83 的既定新行为，不在本用例断言范围内）。
      const beforeA7 = await timelineCount(id);
      const rSpec = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [specId] });
      assert.strictEqual(rSpec.status, 400, `[A7-spec] spec 类型 id 应 400, got ${rSpec.status} ${JSON.stringify(rSpec.body)}`);
      assert.strictEqual(rSpec.body.code, 'ACCEPT_ATTACHMENT_INVALID', '[A7-spec] 错误码 ACCEPT_ATTACHMENT_INVALID');
      const rSS = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [ssId] });
      assert.strictEqual(rSS.status, 400, `[A7-superseded] 已失效附件 id 应 400, got ${rSS.status} ${JSON.stringify(rSS.body)}`);
      assert.strictEqual(rSS.body.code, 'ACCEPT_ATTACHMENT_INVALID', '[A7-superseded] 错误码 ACCEPT_ATTACHMENT_INVALID');
      assert.strictEqual(await statusOf(id), '待验证', '[A7] 两次拒绝后状态均不变');
      assert.strictEqual(await timelineCount(id), beforeA7, '[A7] 两次拒绝 timeline 均未增行（零副作用·Opus 预筛 L1）');
      ok('[A7] ids 指向 spec 类型（结构性类型不符）/ 已 superseded（raw SQL 模拟失效边界）的附件 → 均 400 ACCEPT_ATTACHMENT_INVALID');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A8] ids 非数组 / 含 0 / 含 'x' / 长度 6 → 均 400 ACCEPT_ATTACHMENT_IDS_INVALID，状态不变
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const beforeA8 = await timelineCount(id);
      const cases = [
        { label: '非数组', value: 'not-an-array' },
        { label: '含0', value: [0] },
        { label: "含'x'", value: ['x'] },
        { label: '长度6', value: [1, 2, 3, 4, 5, 6] },
      ];
      for (const c of cases) {
        const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: c.value });
        assert.strictEqual(r.status, 400, `[A8-${c.label}] 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ACCEPT_ATTACHMENT_IDS_INVALID', `[A8-${c.label}] 错误码应 ACCEPT_ATTACHMENT_IDS_INVALID, got ${JSON.stringify(r.body)}`);
      }
      assert.strictEqual(await statusOf(id), '待验证', '[A8] 全部格式拒绝后状态不变（格式闸先于查库）');
      assert.strictEqual(await timelineCount(id), beforeA8, '[A8] 四次格式拒绝 timeline 均未增行（零副作用·Opus 预筛 L1）');
      ok('[A8] attachment_ids 非数组/含 0/含非数字字符串/长度超 5（=6）→ 均 400 ACCEPT_ATTACHMENT_IDS_INVALID（格式闸，不查库）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A10]【Opus 预筛 M2】delivery 类型附件也可作验收凭证（helper 放行 delivery/screenshot 两类·决策记录 J4）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const upDl = await upload(`/api/sys-issues/${id}/attachments`, adminTok, { attachment_type: 'delivery' }, 'a10-delivery.xlsx');
      assert.strictEqual(upDl.status, 200, `[A10] 上传 delivery 200, got ${upDl.status} ${JSON.stringify(upDl.body)}`);
      const dlId = upDl.body.attachments[0].id;
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [dlId] });
      assert.strictEqual(r.status, 200, `[A10] delivery 类型 id 作凭证应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      await expectAcceptPayloadWithRev(id, tl, { attachment_ids: [dlId] }, '[A10] ⭐ payload_json 含 delivery 附件 id + delivery_rev（若 helper 被收窄成仅 screenshot，此处 400 判红；538 回卷 M1 起恒带 delivery_rev）');
      assert.strictEqual(tl.summary, '验收附件 1 个', '[A10] summary 固定文案');
      ok('[A10] delivery 类型附件 id 作验收凭证 → 200 + payload_json={attachment_ids:[id],delivery_rev}（钉住 helper 的 delivery/screenshot 双类放行）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A11]【Opus 预筛 M3】多附件：降序且带重复的 ids → payload 去重升序、summary N=2；空数组 → 视同未传（payload/summary 均 NULL）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const a = await uploadScreenshot(id, 'a11-first.png');
      const b = await uploadScreenshot(id, 'a11-second.png');
      assert.ok(b > a, `[A11] fixture 前置：第二张附件 id 应大于第一张（a=${a}, b=${b}）`);
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [b, a, a] });
      assert.strictEqual(r.status, 200, `[A11] 降序带重复 ids 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      await expectAcceptPayloadWithRev(id, tl, { attachment_ids: [a, b] }, '[A11] ⭐ payload_json.attachment_ids 去重后数值升序（[b,a,a] → [a,b]；字典序/未去重均判红）+ delivery_rev（538 回卷 M1 起恒带）');
      assert.strictEqual(tl.summary, '验收附件 2 个', '[A11] ⭐ summary N=2（硬编码 1 判红）');
      ok('[A11] ids=[b,a,a] → payload attachment_ids=[a,b]+delivery_rev + summary="验收附件 2 个"（去重/升序/计数三契约各有区分力）');

      const id2 = await seedImprovementToVerify();
      const r2 = await call('POST', `/api/sys-issues/${id2}/accept`, adminTok, { attachment_ids: [] });
      assert.strictEqual(r2.status, 200, `[A11-empty] attachment_ids=[] 应 200, got ${r2.status} ${JSON.stringify(r2.body)}`);
      const tl2 = await latestAcceptTimeline(id2);
      assert.strictEqual(tl2.payload_json, null, '[A11-empty] ⭐ 空数组视同未传：payload_json IS NULL');
      assert.strictEqual(tl2.summary, null, '[A11-empty] ⭐ 空数组视同未传：summary IS NULL');
      ok('[A11-empty] attachment_ids=[]（前端未选文件时的可能形状）→ 200 且 payload_json/summary 均 NULL');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A12]【Opus 预筛 M4】500 闸按码点：400 个 emoji（400 码点 / 800 UTF-16 code unit）→ 200；.length 实现会误判 400
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const note = '😀'.repeat(400);
      assert.strictEqual([...note].length, 400, '[A12] fixture 前置：400 码点');
      assert.strictEqual(note.length, 800, '[A12] fixture 前置：800 UTF-16 code unit（区分力来源）');
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note });
      assert.strictEqual(r.status, 200, `[A12] ⭐ 400 码点（800 code unit）note 应 200（500 闸按码点计数；若退回 .length 会 400 判红）, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestAcceptTimeline(id);
      assert.strictEqual(JSON.parse(tl.payload_json).note, note, '[A12] payload_json.note 全文保真');
      assert.strictEqual(tl.summary, `验收说明：${'😀'.repeat(80)}…`, '[A12] summary 预览恰 80 码点 emoji + 省略号（不劈开代理对）');
      ok('[A12] 400 个 emoji（800 code unit）→ 200，500 闸与 80 预览均按码点（.length 退化即判红）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A9] C9 无 commit 直翻夹具 + note → 落「已上线」，summary 恒为 SYS_NO_COMMIT_ONLINE_SUMMARY
    //   审计文案（不被验收说明挤掉），note 仍写入 payload_json（决策记录 J7：C9 分支已写 summary 时不覆盖）
    // ══════════════════════════════════════════════════════════════════════
    {
      // SYS_NO_COMMIT_ONLINE_SUMMARY 字面量（index.js :3348）——未导出供 verify 直引用，按既有惯例
      // 硬编码期望文案（同文件 [6a] 一带 hardcode '对接测试通过｜凭证：本轮测试附件' 等先例）。
      const SYS_NO_COMMIT_ONLINE_SUMMARY = '无提交免上线（验收通过自动结单）';
      const id = await seedImprovementToVerify({ mode: 'no_code', title: 'S2a-C9直翻-fixture' });
      const note = 'C9 直翻夹具·验收说明（不应覆盖审计口径 summary）';
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { note });
      assert.strictEqual(r.status, 200, `[A9] C9 直翻 accept 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '已上线', '[A9] ⭐ 零 commit 单验收直翻「已上线」（不因带验收说明而改变直翻裁决，C9 §10.1 准入四条件与本批正交）');
      assert.strictEqual(await statusOf(id), '已上线', '[A9] 落库 status=已上线（回读，不只信响应体·Opus 预筛 L3）');
      const tl = await latestAcceptTimeline(id);
      // codex 500 L：新建夹具无删除提交历史 → deletedN=0 → summary 应**严格等于** SYS_NO_COMMIT_ONLINE_SUMMARY（startsWith 会放过「后面追加了验收说明」的错误实现）
      assert.strictEqual(tl.summary, SYS_NO_COMMIT_ONLINE_SUMMARY,
        `[A9] ⭐ summary 严格等于 SYS_NO_COMMIT_ONLINE_SUMMARY（C9 审计口径文案优先且不被验收说明追加/覆盖，决策记录 J7），实际：${tl.summary}`);
      assert.strictEqual(JSON.parse(tl.payload_json).note, note, '[A9] ⭐ payload_json.note 仍写入（说明只进 payload_json 不进 summary，决策记录 J7）');
      ok('[A9] C9 无 commit 直翻夹具 + note → status=已上线 ∧ summary 恒 SYS_NO_COMMIT_ONLINE_SUMMARY 开头（不被验收说明挤掉）∧ payload_json.note 存在');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [R1] return 无 reason → 400 RETURN_REASON_REQUIRED（既有回归）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, {});
      assert.strictEqual(r.status, 400, `[R1] return 无 reason 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'RETURN_REASON_REQUIRED', '[R1] 错误码 RETURN_REASON_REQUIRED（既有回归，未受本批改动影响）');
      assert.strictEqual(await statusOf(id), '待验证', '[R1] 拒绝后状态不变');
      ok('[R1] return 无 reason → 400 RETURN_REASON_REQUIRED（既有回归，reason 仍必填）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [R2] return reason+ids → payload_json={attachment_ids} + summary===reason（不变）+ return_count++
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const attId = await uploadScreenshot(id, 'r2-evidence.png');
      const reason = '列不齐，缺少验收材料';
      const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason, attachment_ids: [attId] });
      assert.strictEqual(r.status, 200, `[R2] return 携 reason+ids 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, '开发中', '[R2] return → 开发中（improvement 流）');
      const tl = await latestReturnTimeline(id);
      assert.deepStrictEqual(JSON.parse(tl.payload_json), { attachment_ids: [attId] }, '[R2] ⭐ payload_json 精确形状：仅 attachment_ids 一键（return 无 note 概念）');
      assert.strictEqual(tl.summary, reason, '[R2] ⭐ summary 恒=reason 不变（决策记录 J7：附件只进 payload_json，不重复展示原因文本）');
      const row = await issueRow(id);
      assert.strictEqual(row.return_count, 1, '[R2] return_count++（U-2，既有行为不变）');
      ok('[R2] return reason+ids → payload_json={attachment_ids} + summary===reason（不变）+ return_count=1');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [R3] return ids 非本单 → 400 RETURN_ATTACHMENT_INVALID，状态不变
    // ══════════════════════════════════════════════════════════════════════
    {
      const idSelf = await seedImprovementToVerify();
      const idOther = await seedImprovementToVerify();
      const otherAttId = await uploadScreenshot(idOther, 'r3-other-issue.png');
      const r = await call('POST', `/api/sys-issues/${idSelf}/return`, adminTok, { reason: '测试非本单附件', attachment_ids: [otherAttId] });
      assert.strictEqual(r.status, 400, `[R3] 跨单附件 id 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'RETURN_ATTACHMENT_INVALID', '[R3] 错误码 RETURN_ATTACHMENT_INVALID');
      assert.strictEqual(await statusOf(idSelf), '待验证', '[R3] 拒绝后状态不变（整事务回滚）');
      const rowR3 = await issueRow(idSelf);
      assert.strictEqual(rowR3.return_count, 0, '[R3] return_count 不递增（整事务回滚·Opus 预筛 L2：声称必须有断言）');
      ok('[R3] return ids 非本单（WHERE issue_id 不匹配）→ 400 RETURN_ATTACHMENT_INVALID，状态不变、return_count=0');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [R4]【codex 500 L】return 仅 reason 不带附件 → payload_json 恒 NULL、summary===reason（零行为变化契约的 return 侧）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const reason = '仅原因打回，不带附件';
      const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason });
      assert.strictEqual(r.status, 200, `[R4] return 仅 reason 应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      const tl = await latestReturnTimeline(id);
      assert.strictEqual(tl.payload_json, null, '[R4] ⭐ 无附件时 payload_json IS NULL（不得写成 "{}"）');
      assert.strictEqual(tl.summary, reason, '[R4] summary===reason');
      ok('[R4] return 仅 reason → 200，payload_json NULL、summary===reason（return 侧零行为变化契约）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [R5]【codex 500 L】return attachment_ids 格式闸 → 400 RETURN_ATTACHMENT_IDS_INVALID（前缀须为 RETURN，非 ACCEPT）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const beforeR5 = await timelineCount(id);
      for (const c of [{ label: '非数组', value: 'x' }, { label: '含0', value: [0] }, { label: '长度6', value: [1, 2, 3, 4, 5, 6] }]) {
        const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '格式闸测试', attachment_ids: c.value });
        assert.strictEqual(r.status, 400, `[R5-${c.label}] 应 400, got ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'RETURN_ATTACHMENT_IDS_INVALID', `[R5-${c.label}] 错误码应 RETURN_ATTACHMENT_IDS_INVALID（前缀 RETURN）, got ${JSON.stringify(r.body)}`);
      }
      assert.strictEqual(await statusOf(id), '待验证', '[R5] 格式拒绝后状态不变');
      assert.strictEqual(await timelineCount(id), beforeR5, '[R5] timeline 未增行');
      ok('[R5] return attachment_ids 非数组/含 0/长度 6 → 均 400 RETURN_ATTACHMENT_IDS_INVALID，零副作用');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A13]【codex 500 HIGH 采纳】被时间线凭证引用的附件不可删：accept 关联的附件 DELETE → 409 ATTACHMENT_REFERENCED_BY_TIMELINE；
    //   同单未被引用的附件仍可删（200）——凭证不可变，历史留痕不悬空
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const refId = await uploadScreenshot(id, 'a13-referenced.png');
      const freeId = await uploadScreenshot(id, 'a13-free.png');
      const r = await call('POST', `/api/sys-issues/${id}/accept`, adminTok, { attachment_ids: [refId] });
      assert.strictEqual(r.status, 200, `[A13] accept 携附件应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // 待上线 ∉ TERMINAL → 删除端点的终态闸不拦，只有本批新加的引用闸能挡
      const delRef = await call('DELETE', `/api/sys-issues/${id}/attachments/${refId}`, adminTok);
      assert.strictEqual(delRef.status, 409, `[A13] 删除被引用凭证应 409, got ${delRef.status} ${JSON.stringify(delRef.body)}`);
      assert.strictEqual(delRef.body.code, 'ATTACHMENT_REFERENCED_BY_TIMELINE', '[A13] 错误码 ATTACHMENT_REFERENCED_BY_TIMELINE');
      const stillThere = await get(`SELECT status FROM sys_issue_attachments WHERE id=?`, [refId]);
      assert.ok(stillThere && stillThere.status === 'active', '[A13] 被引用附件仍 active（未被删）');
      const delFree = await call('DELETE', `/api/sys-issues/${id}/attachments/${freeId}`, adminTok);
      assert.strictEqual(delFree.status, 200, `[A13] 删除未被引用附件应 200（引用闸不误伤）, got ${delFree.status} ${JSON.stringify(delFree.body)}`);
      const gone = await get(`SELECT id FROM sys_issue_attachments WHERE id=?`, [freeId]);
      assert.strictEqual(gone, undefined, '[A13] 未被引用附件已物理删除');
      ok('[A13] 验收凭证附件 DELETE → 409 ATTACHMENT_REFERENCED_BY_TIMELINE 且仍 active；同单未引用附件 DELETE → 200（引用闸精确不误伤）');
    }

    // ══════════════════════════════════════════════════════════════════════
    // [A13b]【codex 500-R L】return 写点的凭证同样受引用闸保护（三写点共用同一 json_each 查询，钉住 return 分支不分叉）
    // ══════════════════════════════════════════════════════════════════════
    {
      const id = await seedImprovementToVerify();
      const refId = await uploadScreenshot(id, 'a13b-return-referenced.png');
      const r = await call('POST', `/api/sys-issues/${id}/return`, adminTok, { reason: '打回并附凭证', attachment_ids: [refId] });
      assert.strictEqual(r.status, 200, `[A13b] return 携附件应 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // 开发中 ∈ DEV 族（非终态）→ 删除端点终态闸不拦，只有引用闸能挡
      const delRef = await call('DELETE', `/api/sys-issues/${id}/attachments/${refId}`, adminTok);
      assert.strictEqual(delRef.status, 409, `[A13b] 删除打回凭证应 409, got ${delRef.status} ${JSON.stringify(delRef.body)}`);
      assert.strictEqual(delRef.body.code, 'ATTACHMENT_REFERENCED_BY_TIMELINE', '[A13b] 错误码 ATTACHMENT_REFERENCED_BY_TIMELINE');
      ok('[A13b] 打回凭证附件 DELETE → 409（return 写点与 accept 共用引用闸）');
    }

    console.log(`\n[全部通过] ${passed}/${passed} ✓ 系统迭代验收说明附件与打回附件验证通过`);
  } finally {
    server.close();
    db.close();
  }
}
main().catch((e) => { console.error('❌ verify-sys-accept-evidence 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
