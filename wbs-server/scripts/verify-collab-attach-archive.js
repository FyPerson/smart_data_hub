/**
 * 数据协作 附件压缩包支持 verify（附件压缩包支持方案 D6/D9/D12，C3 阶段）
 *
 * 覆盖方案 §5：V1（协作两类型）/ V2a（协作两类型）/ V4（result_data_screenshot + example_xlsx）/ V11（issueUpload）
 * + 附加断言（COLLAB_ALLOWED_EXTS_UNION 派生自证 / result_data·result_script·example_xlsx 未放开压缩包 /
 *   validateCollabAttachmentRule 原型键守）。
 *
 * ⚠️ 数据协作模块仍在单体 server.js 内（非 routes/ 工厂函数），没有 in-process mock 通道——本文件照抄既有
 *   scripts/verify-collab-multifile-datascope.js 的活体 e2e 范式（真实 fetch + _test-fixture.js 真实
 *   task_pool.db + JWT），**前置要求本地 server 已启动**（localhost:3000，PORT 环境变量对齐 .env）。
 * 用法：node scripts/verify-collab-attach-archive.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const BASE = fx.BASE;
const DB_PATH = fx.DB_PATH;
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const COLLAB_PENDING = path.join(UPLOAD_DIR, 'collab', '_pending');
const ISSUE_PENDING = path.join(UPLOAD_DIR, 'issues', '_pending');

const createdCollabIds = [];
const createdIssueIds = [];
let testTmpDir = null;

function makeTmpFile(filename, buf) {
  if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-archive-'));
  const p = path.join(testTmpDir, filename);
  fs.writeFileSync(p, buf);
  return p;
}

async function uploadCollabAttachment(reqId, token, attachmentType, fileName, buf) {
  const fd = new FormData();
  fd.append('attachment_type', attachmentType);
  const b = fs.readFileSync(makeTmpFile(fileName, buf));
  fd.append('files', new Blob([b]), fileName);
  const r = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

// 多文件同批上传（codex 07 M2：合法文件 + 超限文件同批，验「本批全清」）
async function uploadCollabAttachmentsMulti(reqId, token, attachmentType, files) {
  const fd = new FormData();
  fd.append('attachment_type', attachmentType);
  for (const [name, buf] of files) fd.append('files', new Blob([fs.readFileSync(makeTmpFile(name, buf))]), name);
  const r = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

// 导出端点：POST /api/collab/requests/:id/submit-export（field 名 result_data / result_data_screenshot）
async function uploadExportAttachment(reqId, token, dataBuf, shotBuf, shotName) {
  const fd = new FormData();
  fd.append('result_data', new Blob([fs.readFileSync(makeTmpFile('rd.xlsx', dataBuf))]), 'rd.xlsx');
  fd.append('result_data_screenshot', new Blob([fs.readFileSync(makeTmpFile(shotName, shotBuf))]), shotName);
  const r = await fetch(`${BASE}/api/collab/requests/${reqId}/submit-export`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

async function uploadIssueAttachment(issueId, token, fileName, buf) {
  const fd = new FormData();
  const b = fs.readFileSync(makeTmpFile(fileName, buf));
  fd.append('files', new Blob([b]), fileName);
  const r = await fetch(`${BASE}/api/issues/${issueId}/attachments`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null;
  try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.all(sql, params, (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
  });
}
function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.get(sql, params, (err, row) => { db.close(); err ? reject(err) : resolve(row); });
  });
}
function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.run(sql, params, function (err) { db.close(); err ? reject(err) : resolve(this); });
  });
}

async function cleanupCollabDisk(reqId) {
  try {
    const rows = await dbAll('SELECT file_name FROM collab_attachments WHERE collab_request_id=?', [reqId]);
    for (const r of rows) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file_name)); } catch (_) {} }
  } catch (_) {}
  try { fs.rmSync(path.join(COLLAB_PENDING, String(reqId)), { recursive: true, force: true }); } catch (_) {}
}
async function cleanupIssueDisk(issueId) {
  try {
    const rows = await dbAll('SELECT file_name FROM issue_attachments WHERE issue_id=?', [issueId]);
    for (const r of rows) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file_name)); } catch (_) {} }
    await dbRun('DELETE FROM issue_attachments WHERE issue_id=?', [issueId]);
  } catch (_) {}
  try { fs.rmSync(path.join(ISSUE_PENDING, String(issueId)), { recursive: true, force: true }); } catch (_) {}
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}

async function main() {
  console.log('=== 数据协作 附件压缩包支持 verify（依赖本地 localhost:3000 活体 server）===\n');

  const ctx = await fx.createPendingFixture();
  createdCollabIds.push(ctx.id);

  // ── V1：建单 screenshot / data_scope 各上传 1 字节 .zip/.rar/.7z → 2xx 入库；下载 200（静态服务，非 res.download） ──
  console.log('— V1 —');
  for (const attachmentType of ['screenshot', 'data_scope']) {
    for (const ext of ['zip', 'rar', '7z']) {
      const payload = Buffer.from('x');
      const r = await uploadCollabAttachment(ctx.id, ctx.adminToken, attachmentType, `a.${ext}`, payload);
      assert(r.status === 200, `[V1] ${attachmentType} 上传 1 字节 .${ext} → 200（实现坏成什么样它会红：exts 漏并入 ARCHIVE_EXTS → 400），实际 ${r.status} ${JSON.stringify(r.body)}`);
      // codex 07 M3：响应附件结构缺失不得静默跳过后续断言——attachments[0].file_name 必过；入库 attachment_type / file_size 查库核；下载比对字节
      const att0 = r.body && r.body.attachments && r.body.attachments[0];
      assert(!!(att0 && att0.file_name && att0.id), `[V1] ${attachmentType} .${ext} 响应须含 attachments[0].id/file_name（缺则计红，不静默减少断言数），实际 ${JSON.stringify(r.body)}`);
      if (att0 && att0.id) {
        const row = await dbGet('SELECT attachment_type, file_name FROM collab_attachments WHERE id=?', [att0.id]);
        // collab_attachments 无 file_size 列（方案 V1 该句对协作不适用，已订正）：磁盘 stat 大小充当入库大小断言
        let diskSize = -1; try { diskSize = fs.statSync(path.join(UPLOAD_DIR, row.file_name)).size; } catch (_) {}
        assert(!!row && row.attachment_type === attachmentType && diskSize === payload.length,
          `[V1] ${attachmentType} .${ext} 入库 attachment_type=${attachmentType} 且落盘大小=${payload.length}（实现坏成什么样它会红：类型串写或文件未落/截断），实际 ${JSON.stringify(row)} disk=${diskSize}`);
        const dl = await fetch(`${BASE}/uploads/${att0.file_name.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
        const dlBuf = Buffer.from(await dl.arrayBuffer());
        assert(dl.status === 200 && dlBuf.equals(payload), `[V1] ${attachmentType} .${ext} 静态下载 200 且字节与上传一致（collab 走 express.static 非 res.download，无 attachment 头，方案 V1 订正），实际 ${dl.status} len=${dlBuf.length}`);
      }
    }
  }

  // ── V2a：两类型各上传 52428801 字节 .zip → 400；pending 本请求文件已清、父目录存在（正向对照） ──
  console.log('— V2a —');
  // codex 07 M2：① 恰 52428800 字节须 2xx（区分「50MB 上限」与「误沿用 10MB」）；② 超限断言匹配大小超限文案；
  //   ③ 超限请求同批带一个合法文件 → 本批全清；④ 另一请求目录放哨兵 → 跨请求隔离不误删
  const sentinelDir = path.join(COLLAB_PENDING, 'verify-sentinel-' + Date.now());
  fs.mkdirSync(sentinelDir, { recursive: true });
  const sentinelFile = path.join(sentinelDir, 'sentinel.txt');
  fs.writeFileSync(sentinelFile, 'keep-me');
  try {
    for (const attachmentType of ['screenshot', 'data_scope']) {
      const exact = Buffer.alloc(52428800, 1);
      const rOk = await uploadCollabAttachment(ctx.id, ctx.adminToken, attachmentType, 'exact.zip', exact);
      assert(rOk.status === 200, `[V2a] ${attachmentType} 恰 52428800 字节 .zip → 200（实现坏成什么样它会红：压缩包误沿用 10MB 默认上限 → 400），实际 ${rOk.status} ${JSON.stringify(rOk.body)}`);
      if (rOk.body && rOk.body.attachments && rOk.body.attachments[0]) {
        const row = await dbGet('SELECT file_name FROM collab_attachments WHERE id=?', [rOk.body.attachments[0].id]);
        let diskSize = -1; try { diskSize = fs.statSync(path.join(UPLOAD_DIR, row.file_name)).size; } catch (_) {}
        assert(diskSize === 52428800, `[V2a] ${attachmentType} 恰 50MB 落盘大小=52428800（无 file_size 列，stat 磁盘），实际 ${diskSize}`);
      }
      const big = Buffer.alloc(52428801, 1);
      const legalName = attachmentType === 'screenshot' ? 'legal-first.png' : 'legal-first.txt';   // 各类型自己的合法扩展名（data_scope 不收 png）
      const r = await uploadCollabAttachmentsMulti(ctx.id, ctx.adminToken, attachmentType, [[legalName, Buffer.from('x')], ['big.zip', big]]);
      assert(r.status === 400 && r.body && /文件大小超限/.test(r.body.error || ''), `[V2a] ${attachmentType} 合法 ${legalName} + 52428801 字节 .zip 同批 → 400 且文案为大小超限（实现坏成什么样它会红：二次卡缺失 → 顶上限 100MB 放过 200；命中别的闸 → 文案不同），实际 ${r.status} ${JSON.stringify(r.body)}`);
      const pendingReqDir = path.join(COLLAB_PENDING, String(ctx.id));
      let leftover = [];
      try { leftover = fs.readdirSync(pendingReqDir); } catch (_) { /* 目录不存在也算已清 */ }
      assert(leftover.length === 0, `[V2a] ${attachmentType} 拒绝后 pending/${ctx.id}/ 内本批两个文件（含先到的合法文件）全清（实际残留 ${JSON.stringify(leftover)}）`);
      assert(fs.existsSync(sentinelFile) && fs.readFileSync(sentinelFile, 'utf8') === 'keep-me', '[V2a] 另一请求目录的哨兵文件仍在且内容不变（跨请求清理隔离；正向对照：清理只删本请求文件）');
    }
  } finally {
    try { fs.rmSync(sentinelDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ── V4：result_data_screenshot 入口上传 .zip → 400（与 .pdf 同一 code）；example_xlsx 上传 .zip → 400 ──
  console.log('— V4 —');
  {
    const r = await uploadExportAttachment(ctx.id, ctx.adminToken, Buffer.from('xlsxdata'), Buffer.from('x'), 'shot.zip');
    assert(r.status === 400 && r.body && r.body.code === 'INVALID_SCREENSHOT',
      `[V4] result_data_screenshot 入口上传 .zip → 400 INVALID_SCREENSHOT（与既有 .pdf 排除同一 code，实现坏成什么样它会红：漏排除 → 200），实际 ${r.status} ${JSON.stringify(r.body)}`);
  }
  {
    const r = await uploadCollabAttachment(ctx.id, ctx.adminToken, 'example_xlsx', 'tpl.zip', Buffer.from('x'));
    assert(r.status === 400, `[V4] example_xlsx 上传 .zip → 400（本次未放开压缩包，实现坏成什么样它会红：exts 被联合白名单派生连带放宽 → 200），实际 ${r.status} ${JSON.stringify(r.body)}`);
  }

  await cleanupCollabDisk(ctx.id);
  await fx.cleanup(ctx.id);

  // ── V11：issueUpload 上传 a.zip 与 A.ZIP → 400 且消息不含 zip；.exe → 400 且「仅允许」列表不含 zip/rar/7z ──
  console.log('— V11 —');
  {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const createRes = await fx.apiCall('POST', '/api/issues', adminToken, {
      // Opus 预筛 C3 H1：建单校验（server.js:11728-11740）要求 type ∈ ISSUE_TYPES、requester_dept ∈ COLLAB_REQUESTER_DEPTS、priority ∈ P0-P3——
      //   首版缺三必填致 400 后整段静默跳过（23 条里没有 V11）。取各枚举首项。
      title: '附件压缩包 C3 verify fixture', description: 'issueUpload 压缩包拒绝 e2e', priority: 'P2',
      type: '数据治理需求', requester_dept: '市场营销部', requester_name: '压缩包e2e业务方',
    });
    if (createRes.status !== 201 && createRes.status !== 200) {
      // 跳过必须与失败一样刷屏并计入失败（guard_static_analysis_gotchas）——fixture 建不出来就是红
      failed++;
      console.log(`  ✗ [V11] 建 issue fixture 失败（${createRes.status} ${JSON.stringify(createRes.body)}），V11 六条断言未执行=计红`);
    } else {
      const issueId = createRes.body.id;
      createdIssueIds.push(issueId);

      let r = await uploadIssueAttachment(issueId, adminToken, 'a.zip', Buffer.from('x'));
      assert(r.status === 400, `[V11] issueUpload 上传 a.zip → 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body && /仅允许/.test(`${r.body.error || ''} ${r.body.detail || ''}`) && !/zip/i.test(`${r.body.error || ''} ${r.body.detail || ''}`), `[V11] a.zip 拒绝消息不含 "zip"（有效白名单剔除压缩包），实际消息："${r.body && (r.body.error || r.body.detail)}"`);

      r = await uploadIssueAttachment(issueId, adminToken, 'A.ZIP', Buffer.from('x'));
      assert(r.status === 400, `[V11] issueUpload 上传 A.ZIP（大写）→ 400（归一化小写后同样命中拦截），实际 ${r.status} ${JSON.stringify(r.body)}`);
      assert(r.body && /仅允许/.test(`${r.body.error || ''} ${r.body.detail || ''}`) && !/zip/i.test(`${r.body.error || ''} ${r.body.detail || ''}`), `[V11] A.ZIP 拒绝消息不含 "zip"`);

      r = await uploadIssueAttachment(issueId, adminToken, 'x.exe', Buffer.from('x'));
      assert(r.status === 400, `[V11] issueUpload 上传 x.exe → 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
      // fileFilter 的消息落在 detail（error 恒为「上传文件失败」），首版只取 error||detail 拿不到列表（断言写错，主会话亲跑纠正）
      const msg = r.body ? `${r.body.error || ''} ${r.body.detail || ''}` : '';
      assert(/仅允许/.test(msg) && !/zip|rar|7z/i.test(msg), `[V11] x.exe「仅允许」列表不含 zip/rar/7z（实现坏成什么样它会红：拒绝消息误用未过滤联合白名单 → 含 zip），实际消息："${msg}"`);

      await cleanupIssueDisk(issueId);
      try { await dbRun('DELETE FROM issues WHERE id=?', [issueId]); } catch (_) {}
    }
  }

  // ── 附加：COLLAB_ALLOWED_EXTS_UNION 含三扩展名（HTTP 侧接受面自证，不 require server.js） ──
  console.log('— 附加 —');
  {
    const ctx2 = await fx.createPendingFixture();
    createdCollabIds.push(ctx2.id);
    for (const ext of ['zip', 'rar', '7z']) {
      // 用一个必然被 fileFilter 判定"扩展名合法"但会被 attachment_type 规则二次卡挡的场景反证联合白名单含压缩包：
      // 传 example_xlsx（/attachments 端点的合法类型，但方案 D6 未放开压缩包）——若 multer fileFilter 层就把 .zip 拦了，
      // 消息是 fileFilter 的「不支持的扩展名 …，仅允许 …」；到达二次卡才是 validateCollabAttachmentRule 的
      // 「example_xlsx 不支持扩展名 .zip」（无「的」字，正则区分）。
      // ⚠️ 首版用 result_script 是断言写错：该端点对 result_data/result_script 在读文件前就 409「请通过 /submit 提交」，到不了二次卡（主会话亲跑纠正）。
      const r = await uploadCollabAttachment(ctx2.id, ctx.adminToken || (await fx.signAs(fx.ADMIN_ID)), 'example_xlsx', `x.${ext}`, Buffer.from('x'));
      assert(r.status === 400 && r.body && /example_xlsx 不支持扩展名/.test(r.body.error || ''),
        `[附加] example_xlsx 上传 .${ext}：应命中 attachment_type 二次卡（联合白名单已含 .${ext}，fileFilter 放行）而非 fileFilter「不支持的扩展名」，实际 ${r.status} ${JSON.stringify(r.body)}`);
    }
    // H2（Opus 预筛 C3·方案 D8 前移）：admin 代提旧字段 result_data / result_script 随联合白名单扩容可落 .zip → 显式 400
    for (const field of ['result_data', 'result_script']) {
      const fd = new FormData();
      fd.append('reason', '附件压缩包 C3b 旁路用例：旧字段不接受压缩包');
      fd.append(field, new Blob([Buffer.from('x')]), 'payload.zip');
      const r = await fetch(`${BASE}/api/collab/requests/${ctx2.id}/admin-submit-on-behalf`, {
        method: 'POST', headers: { authorization: `Bearer ${await fx.signAs(fx.ADMIN_ID)}` }, body: fd,
      });
      let j = null; try { j = await r.json(); } catch (_) {}
      assert(r.status === 400 && j && j.code === 'ADMIN_FIELD_ARCHIVE_NOT_ALLOWED' && j.attachment_type === field,
        `[附加/H2] 代提 ${field}=payload.zip → 400 ADMIN_FIELD_ARCHIVE_NOT_ALLOWED（实现坏成什么样它会红：旧字段无压缩包闸 → 走 expected_status/状态门返其他码或 2xx 落成 ${field}），实际 ${r.status} ${JSON.stringify(j)}`);
    }
    await cleanupCollabDisk(ctx2.id);
    await fx.cleanup(ctx2.id);
  }

  console.log(`\n${failed === 0 ? '✅' : '❌'} verify-collab-attach-archive：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('💥 执行异常:', e && e.stack || e);
  process.exitCode = 1;
}).finally(async () => {
  for (const id of createdCollabIds) { try { await cleanupCollabDisk(id); await fx.cleanup(id); } catch (_) {} }
  for (const id of createdIssueIds) { try { await cleanupIssueDisk(id); await dbRun('DELETE FROM issues WHERE id=?', [id]); } catch (_) {} }
  if (testTmpDir) { try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) {} }
});
