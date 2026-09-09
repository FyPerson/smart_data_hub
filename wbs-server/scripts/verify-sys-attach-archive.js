// 验证脚本：系统迭代 附件压缩包支持（附件压缩包支持方案 D3/D12，C1 阶段）——覆盖方案 §5 V1/V2b/V3/V3u/V4/V12(SI 部分)
//   用法：node scripts/verify-sys-attach-archive.js
// in-process express app（挂真实 router）+ 内存库 + 真实临时落盘（_sys-attach-test-deps）+ 自签 token，覆盖：
//   V1  spec/delivery 上传 49MB .zip/.rar/.7z → 2xx，入库 file_size 正确，下载 200
//   V2b 修正/系统迭代顶上限：52428801 字节 .zip → multer LIMIT_FILE_SIZE；52428800 字节 → 2xx
//   V3  spec/delivery/screenshot 上传 21MB .pdf（非压缩包超 20MB）→ 400 ATTACHMENT_RULE_VIOLATION，
//       reason=SIZE_EXCEEDED，limit_mb=20；同请求 pending 目录内本请求文件已清
//   V3u 直调 _internals.validateSysAttachmentRule 七组用例
//   V4  screenshot 上传 .zip → 400（fileFilter 联合白名单放行后被二次卡 EXT_NOT_ALLOWED 拒）
//   附加：SYS_ALLOWED_EXTS 恰为规则表三类 exts 并集且含三压缩扩展名
'use strict';
const assert = require('assert');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR } = require('./_sys-attach-test-deps');
const { ARCHIVE_EXTS, ARCHIVE_MAX_SIZE } = require('../utils/attachment-archive');

const SECRET = 'verify-sys-attach-archive-secret';
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
// multipart 上传：fileName/fileBuf 支持数组（多文件）或单值
function upload(p, tok, fields, fileName, fileBuf) {
  return new Promise((resolve, reject) => {
    const boundary = '----SysArchBoundary' + (p.length * 7919 + Date.now());
    const chunks = [];
    for (const [k, v] of Object.entries(fields || {})) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    const names = Array.isArray(fileName) ? fileName : (fileName ? [fileName] : []);
    const bufs = Array.isArray(fileBuf) ? fileBuf : [fileBuf];
    names.forEach((fn, i) => {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fn}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      chunks.push(bufs[i] || Buffer.from('x'));
      chunks.push(Buffer.from('\r\n'));
    });
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(chunks);
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: p, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => { let j = null; try { j = b ? JSON.parse(b) : null; } catch (_) { j = { _raw: b.length }; } resolve({ status: r.statusCode, body: j }); }); });
    req.on('error', reject); req.write(bodyBuf); req.end();
  });
}
function download(p, tok) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers: { 'Authorization': 'Bearer ' + tok } },
      (r) => { let n = 0; r.on('data', c => n += c.length); r.on('end', () => resolve({ status: r.statusCode, bytes: n, disposition: String(r.headers['content-disposition'] || '') })); });
    req.on('error', reject); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

function futureEst(days) {
  const d = new Date(Date.now() + days * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const EST = futureEst(30);

async function seedDev(assignTo = 5) {
  let r = await call('POST', '/api/sys-issues', adminTok, { intake_contract_version: 2, type: 'feature', title: 't-archive', system_name: 'BMS', source: '内部', description: '附件压缩包支持 C1 verify fixture', intake_liaison_id: 13 });
  assert.strictEqual(r.status, 201, '建单 201, got ' + r.status + ' ' + JSON.stringify(r.body));
  const id = r.body.id;
  await call('POST', `/api/sys-issues/${id}/intake-accept`, adminTok, { risk_level: '二级' });
  await call('POST', `/api/sys-issues/${id}/schedule`, adminTok, {});
  r = await call('POST', `/api/sys-issues/${id}/set-oa-number`, adminTok, { oa_number: '2026070001' + String(id).padStart(3, '0') });
  assert.strictEqual(r.status, 200, '夹具补 OA 号 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  await call('POST', `/api/sys-issues/${id}/assign`, adminTok, { assigned_to: assignTo });
  await run(`UPDATE sys_issues SET intake_liaison_id = 999999 WHERE id = ?`, [id]);   // 降级⑥路径，落「开发中」（同 verify-sys-attachments 范式）
  r = await call('POST', `/api/sys-issues/${id}/estimate`, devTok, { dev_estimated_at: EST, estimated_effort_days: 1 });
  assert.strictEqual(r.status, 200, 'estimate 200, got ' + r.status + ' ' + JSON.stringify(r.body));
  return id;
}
const ATT = (id) => `/api/sys-issues/${id}/attachments`;
const attRow = (attId) => get('SELECT id, attachment_type, file_size, status FROM sys_issue_attachments WHERE id=?', [attId]);

// pending 目录：{issueId} 子目录内本请求文件应已被清理干净
function pendingDirFiles(issueId) {
  const dir = path.join(UPLOAD_DIR, 'sys-iteration', '_pending', String(issueId));
  try { return fs.readdirSync(dir); } catch (_) { return []; }
}

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT DEFAULT 'active', phone TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role) VALUES (1,'admin','管理员','admin'),(5,'dev','开发王','user'),(13,'wangtaotao','示例对接人','user')`);

  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  port = server.address().port;
  ok('in-process app 启动 + readiness ready + seed users');

  try {
    // ── 附加：SYS_ALLOWED_EXTS 恰为规则表三类 exts 并集且含三压缩扩展名 ──
    const unionSet = new Set(Object.values(I.SYS_ATTACHMENT_RULES).flatMap(r => r.exts));
    assert.strictEqual(I.SYS_ALLOWED_EXTS.length, unionSet.size, 'SYS_ALLOWED_EXTS 长度=规则表并集去重后长度');
    assert.ok(I.SYS_ALLOWED_EXTS.every(e => unionSet.has(e)), 'SYS_ALLOWED_EXTS 每一项都在并集里');
    for (const ext of ARCHIVE_EXTS) assert.ok(I.SYS_ALLOWED_EXTS.includes(ext), `SYS_ALLOWED_EXTS 含压缩扩展名 ${ext}`);
    ok('SYS_ALLOWED_EXTS 恰为 SYS_ATTACHMENT_RULES 三类 exts 并集且含三压缩扩展名（实现坏成什么样它会红：漏排某类 exts 或压缩扩展名未并入 → 断言红）');

    // ── V1：spec/delivery 各上传 49MB 的 .zip/.rar/.7z → 2xx，file_size 正确，下载 200 ──
    const size49 = 49 * 1024 * 1024;
    for (const attachmentType of ['spec', 'delivery']) {
      for (const ext of ['zip', 'rar', '7z']) {
        const id = await seedDev(5);
        const buf = Buffer.alloc(size49, 1);
        const tok = attachmentType === 'spec' ? adminTok : devTok;
        const r = await upload(ATT(id), tok, { attachment_type: attachmentType }, `a.${ext}`, buf);
        assert.strictEqual(r.status, 200, `[V1] ${attachmentType} 上传 49MB .${ext} 应 2xx，实际 ${r.status} ${JSON.stringify(r.body)}`);
        const attId = r.body.attachments[0].id;
        const row = await attRow(attId);
        assert.strictEqual(row.file_size, size49, `[V1] ${attachmentType} .${ext} file_size 入库正确`);
        const dl = await download(`${ATT(id)}/${attId}/download`, tok);
        assert.strictEqual(dl.status, 200, `[V1] ${attachmentType} .${ext} 下载应 200`);
        assert.strictEqual(dl.bytes, size49, `[V1] ${attachmentType} .${ext} 下载字节数与上传一致`);
        // D11 登记接受的唯一论据=下载走 res.download attachment disposition（平台侧不内联执行）；若将来改成 sendFile/inline 这里必红（Opus 预筛 M2）
        assert.ok(/^attachment/i.test(dl.disposition), `[V1] ${attachmentType} .${ext} 下载须为 Content-Disposition: attachment，实际「${dl.disposition}」`);
      }
    }
    ok('[V1] spec/delivery 各 3 种压缩扩展名 49MB 上传 → 2xx + file_size 正确 + 下载 200（实现坏成什么样它会红：白名单/规则表/multer 顶上限任一漏放 → 400 或 multer LIMIT_FILE_SIZE）');

    // ── V2b：52428801 字节 .zip → multer LIMIT_FILE_SIZE；52428800 字节 → 2xx ──
    {
      const idOver = await seedDev(5);
      const bufOver = Buffer.alloc(ARCHIVE_MAX_SIZE + 1, 2);
      let r = await upload(ATT(idOver), adminTok, { attachment_type: 'spec' }, 'over.zip', bufOver);
      assert.strictEqual(r.status, 400, `[V2b] 50MB+1 字节 .zip 应 400，实际 ${r.status}`);
      assert.strictEqual(r.body.code, 'LIMIT_FILE_SIZE', `[V2b] 50MB+1 字节 .zip 应命中既有 multer LIMIT_FILE_SIZE 映射，实际 code=${r.body.code}`);

      const idExact = await seedDev(5);
      const bufExact = Buffer.alloc(ARCHIVE_MAX_SIZE, 3);
      r = await upload(ATT(idExact), adminTok, { attachment_type: 'spec' }, 'exact.zip', bufExact);
      assert.strictEqual(r.status, 200, `[V2b] 恰 50MB .zip 应 2xx，实际 ${r.status} ${JSON.stringify(r.body)}`);
      ok('[V2b] 顶上限边界：50MB+1 字节 .zip → 400 LIMIT_FILE_SIZE；恰 50MB → 2xx（实现坏成什么样它会红：顶上限未抬 → 50MB 整被拒；抬过头 → 51MB 通过）');
    }

    // ── V3：spec/delivery/screenshot 上传 21MB .pdf（非压缩包超 20MB）→ 400 ATTACHMENT_RULE_VIOLATION ──
    {
      const size21 = 21 * 1024 * 1024;
      for (const attachmentType of ['spec', 'delivery', 'screenshot']) {
        const id = await seedDev(5);
        const tok = attachmentType === 'screenshot' ? devTok : (attachmentType === 'spec' ? adminTok : devTok);
        const buf = Buffer.alloc(size21, 4);
        const r = await upload(ATT(id), tok, { attachment_type: attachmentType }, 'big.pdf', buf);
        assert.strictEqual(r.status, 400, `[V3] ${attachmentType} 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION', `[V3] ${attachmentType} 21MB .pdf code 应 ATTACHMENT_RULE_VIOLATION`);
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED', `[V3] ${attachmentType} 21MB .pdf reason 应 SIZE_EXCEEDED`);
        assert.strictEqual(r.body.limit_mb, 20, `[V3] ${attachmentType} 21MB .pdf limit_mb 应 20`);
        // 正向对照（Opus 预筛 M3）：pending 父目录必须真实存在（multer destination 建出），排掉「路径拼错 → readdir 抛 → 恒空 → 恒绿」的假绿源
        assert.ok(fs.existsSync(path.join(UPLOAD_DIR, 'sys-iteration', '_pending')), '[V3] pending 父目录应存在（否则清理断言无判别力）');
        assert.deepStrictEqual(pendingDirFiles(id), [], `[V3] ${attachmentType} 拒绝后 pending 目录内本请求文件已清（issue=${id}）`);
      }
      ok('[V3] spec/delivery/screenshot 上传 21MB .pdf（非压缩包超 20MB）→ 400 ATTACHMENT_RULE_VIOLATION reason=SIZE_EXCEEDED limit_mb=20；pending 已清（实现坏成什么样它会红：只抬 multer 不加二次卡 → 2xx；某类型漏挂 → 该类型 2xx）');
    }

    // ── V3u：直调 _internals.validateSysAttachmentRule 七组用例 ──
    {
      let c = I.validateSysAttachmentRule('spec', 'a.zip', ARCHIVE_MAX_SIZE + 1);
      assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'SIZE_EXCEEDED');
      c = I.validateSysAttachmentRule('spec', 'a.zip', ARCHIVE_MAX_SIZE);
      assert.strictEqual(c.ok, true, `[V3u] spec .zip 恰 50MB 应过，实际 ${JSON.stringify(c)}`);
      c = I.validateSysAttachmentRule('screenshot', 'a.zip', 1);
      assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'EXT_NOT_ALLOWED');
      assert.strictEqual(c.ext, null, '[V3u] EXT_NOT_ALLOWED 时 ext 应为 null'); assert.strictEqual(c.sizeLimit, null, '[V3u] EXT_NOT_ALLOWED 时 sizeLimit 应为 null');
      c = I.validateSysAttachmentRule('spec', 'a.pdf', 20 * 1024 * 1024 + 1);
      assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'SIZE_EXCEEDED');
      c = I.validateSysAttachmentRule('spec', 'A.ZIP', 1);
      assert.strictEqual(c.ok, true, `[V3u] 大写 A.ZIP 应过（归一化小写），实际 ${JSON.stringify(c)}`);
      assert.strictEqual(c.normalizedExt, '.zip', '[V3u] normalizedExt 应为 .zip');
      c = I.validateSysAttachmentRule('spec', 'a\x01.zip', 1);
      assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'BAD_NAME', `[V3u] 含控制字符文件名应 BAD_NAME，实际 ${JSON.stringify(c)}`);
      c = I.validateSysAttachmentRule('spec', 'x.exe', 1);
      assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'EXT_NOT_ALLOWED', `[V3u] .exe 应 EXT_NOT_ALLOWED`);
      ok('[V3u] validateSysAttachmentRule 七组直调用例全部符合方案 §5 判据（实现坏成什么样它会红：任一分支写反 → 对应断言红）');
    }

    // ── V4：screenshot 上传 .zip → 400（fileFilter 联合白名单放行后被二次卡 EXT_NOT_ALLOWED 拒） ──
    {
      const id = await seedDev(5);
      const r = await upload(ATT(id), devTok, { attachment_type: 'screenshot' }, 'a.zip', Buffer.from('pk'));
      assert.strictEqual(r.status, 400, `[V4] screenshot 上传 .zip 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.attachment_type, 'screenshot', '[V4] 错误体 attachment_type 应回显 screenshot');
      assert.strictEqual(r.body.reason, 'EXT_NOT_ALLOWED', '[V4] reason 应为 EXT_NOT_ALLOWED（若误判成 SIZE_EXCEEDED 这里红·Opus 预筛 L4）');
      assert.strictEqual(r.body.limit_mb, null, '[V4] EXT_NOT_ALLOWED 时 limit_mb 应为 null');
      assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION', '[V4] 应命中二次卡 ATTACHMENT_RULE_VIOLATION（非 fileFilter，因联合白名单已放行 .zip）');
      ok('[V4] screenshot 上传 .zip → 400 ATTACHMENT_RULE_VIOLATION（fileFilter 联合白名单放行后被二次卡 EXT_NOT_ALLOWED 拒，实现坏成什么样它会红：分表漏排除压缩包 → 2xx）');
    }

    console.log(`\n✅ verify-sys-attach-archive 全部通过（${passed} 项断言）`);
  } finally {
    server.close();
    db.close();
  }
}
main().catch((e) => { console.error('❌ verify-sys-attach-archive 失败:', e && e.stack || e); if (server) server.close(); process.exit(1); });
