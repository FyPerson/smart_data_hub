/**
 * 数据协作 交付新类型 result_extra 全链 verify（附件压缩包支持方案 D7/D8，C4 阶段）
 *
 * 覆盖方案 §5：V5（/submit 四类文件名边界）/ V7（三类入库+smoke/列校验/dualcheck 日志）/
 * V8（数量约束四组）/ V8b（交错顺序保序）/ V9（代提 extra 各用例，不含撞名负向）/
 * V9c（done_at_source 四态）/ V10（DONE 重传 supersede 正向半段，回滚半段见
 * verify-collab-versioning-rollback-hook.js）/ V10b（代提连续两次 extra + smoke 失败 + EXPORTING 切回）。
 *
 * ⚠️ 未覆盖：V9b 的「stub buildFinalAttachmentName 返回定值 → 400 ATTACHMENT_NAME_COLLISION」负向分支——
 *   该分支需要在 server.js 已加载的 collabVersioning 模块上打桩，只有 in-process require 才能做到；本文件
 *   是外部 HTTP 请求打进已经在跑的 server.js 进程，无法从进程外注入桩。且按当前实现，同一批 result_extra
 *   的 typeOrdinal 按数组下标严格递增（1..N，见 server.js adminUploadedFiles 收集逻辑），同批内两个文件永远
 *   不会分到相同 typeOrdinal，正常输入下这条防线在黑盒层面本就不可达——见交付报告「拿不准的判断」。
 * ⚠️ 数据协作模块仍在单体 server.js 内（非 routes/ 工厂函数），没有 in-process mock 通道——本文件照抄既有
 *   scripts/verify-collab-attach-archive.js 的活体 e2e 范式（真实 fetch + _test-fixture.js 真实 task_pool.db
 *   + JWT），**前置要求本地 server 已用改后的代码重启**（localhost:3000）。
 * 用法：node scripts/verify-collab-delivery-extra.js
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

const createdCollabIds = [];
let testTmpDir = null;

let tmpSeq = 0;
function makeTmpFile(filename, buf) {
  if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-extra-'));
  // 落盘名用序号 + 净化名（Windows 不接受尾空格/控制字符文件名：V5 的 'a.zip ' / 'a\x01.zip' / '\na.zip' 只作为 multipart filename 送出，
  //   磁盘上用安全名承载内容）——主会话亲跑首次 ENOENT 纠正
  const safe = String(filename).replace(/[^A-Za-z0-9._-]/g, '_');
  const p = path.join(testTmpDir, `${++tmpSeq}_${safe}`);
  fs.writeFileSync(p, buf);
  return p;
}

// /submit：files 数组按调用方传入的顺序原样 append（保序，供 V8b 交错测试用）
async function postSubmit(reqId, token, files) {
  const fd = new FormData();
  for (const { name, content } of files) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content);
    fd.append('files', new Blob([fs.readFileSync(makeTmpFile(name, buf))]), name);
  }
  const r = await fetch(`${BASE}/api/collab/requests/${reqId}/submit`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
  return { status: r.status, body: j };
}

// admin 代提：{ reason, expected_status, result_script, result_data, result_extra:[{name,content}] }
async function postAdminSubmit(reqId, token, opts) {
  const fd = new FormData();
  fd.append('reason', opts.reason || '附件压缩包 C4 verify fixture 占位理由文本超过十字');
  if (opts.expected_status) fd.append('expected_status', opts.expected_status);
  if (opts.result_script) fd.append('result_script', new Blob([fs.readFileSync(makeTmpFile(opts.result_script.name, Buffer.from(opts.result_script.content)))]), opts.result_script.name);
  if (opts.result_data) fd.append('result_data', new Blob([fs.readFileSync(makeTmpFile(opts.result_data.name, Buffer.from(opts.result_data.content)))]), opts.result_data.name);
  if (Array.isArray(opts.result_extra)) {
    for (const e of opts.result_extra) {
      const buf = Buffer.isBuffer(e.content) ? e.content : Buffer.from(e.content || 'x');
      fd.append('result_extra', new Blob([fs.readFileSync(makeTmpFile(e.name, buf))]), e.name);
    }
  }
  const r = await fetch(`${BASE}/api/collab/requests/${reqId}/admin-submit-on-behalf`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd,
  });
  let j = null; try { j = await r.json(); } catch (_) {}
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
async function downloadBytes(fileName, token) {
  const r = await fetch(`${BASE}/uploads/${fileName.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
}

async function cleanupCollabDisk(reqId) {
  try {
    const rows = await dbAll('SELECT file_name FROM collab_attachments WHERE collab_request_id=?', [reqId]);
    for (const r of rows) { try { fs.unlinkSync(path.join(UPLOAD_DIR, r.file_name)); } catch (_) {} }
  } catch (_) {}
  try { fs.rmSync(path.join(COLLAB_PENDING, String(reqId)), { recursive: true, force: true }); } catch (_) {}
}

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}

async function freshFixture() {
  const ctx = await fx.createPendingFixture();
  createdCollabIds.push(ctx.id);
  return ctx;
}

async function main() {
  console.log('=== 数据协作 result_extra 全链 verify（依赖已重启的本地 localhost:3000 活体 server）===\n');

  // ── V5：/submit 四类文件名边界（对 result_extra 走归一化）──
  console.log('— V5 —');
  {
    // ① 'a.zip '（尾空格）→ 2xx
    const ctx1 = await freshFixture();
    const r1 = await postSubmit(ctx1.id, ctx1.dev1Token, [
      { name: 'd.xlsx', content: 'xlsx' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'a.zip ', content: 'PK' },
    ]);
    assert(r1.status === 200 && r1.body && r1.body.current_status === 'DONE',
      `[V5] 'a.zip '（尾空格）→ 2xx DONE（trim 后仍为合法压缩包扩展名），实际 ${r1.status} ${JSON.stringify(r1.body)}`);

    // ② 'a\x01.zip'（控制字符）→ 400
    const ctx2 = await freshFixture();
    const r2 = await postSubmit(ctx2.id, ctx2.dev1Token, [
      { name: 'd.xlsx', content: 'xlsx' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'a\x01.zip', content: 'PK' },
    ]);
    assert(r2.status === 400, `[V5] 'a\\x01.zip'（含控制字符）→ 400（normalizeAttachmentExt 拒控制字符 → ext='' → RESULT_INVALID_TYPE），实际 ${r2.status} ${JSON.stringify(r2.body)}`);

    // ③ '\na.zip'（前导换行，trim 后合法）→ 2xx
    const ctx3 = await freshFixture();
    const r3 = await postSubmit(ctx3.id, ctx3.dev1Token, [
      { name: 'd.xlsx', content: 'xlsx' }, { name: 's.sql', content: 'SELECT 1' }, { name: '\na.zip', content: 'PK' },
    ]);
    assert(r3.status === 200 && r3.body && r3.body.current_status === 'DONE',
      `[V5] '\\na.zip'（前导换行）→ 2xx DONE（F7：trim 先于控制字符检查，换行被 trim 掉后接受），实际 ${r3.status} ${JSON.stringify(r3.body)}`);

    // ④ 'A.ZIP'（大写）→ 2xx 且入库文件名含 re 前缀
    const ctx4 = await freshFixture();
    const r4 = await postSubmit(ctx4.id, ctx4.dev1Token, [
      { name: 'd.xlsx', content: 'xlsx' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'A.ZIP', content: 'PK' },
    ]);
    assert(r4.status === 200 && r4.body && r4.body.current_status === 'DONE',
      `[V5] 'A.ZIP'（大写）→ 2xx DONE（归一化转小写），实际 ${r4.status} ${JSON.stringify(r4.body)}`);
    if (r4.status === 200) {
      const row = await dbGet(`SELECT file_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctx4.id]);
      assert(!!(row && /_re_/.test(row.file_name)), `[V5] 'A.ZIP' 入库 file_name 含 '_re_' 前缀（ATTACHMENT_TYPE_TO_ABBR.result_extra='re'），实际 ${row && row.file_name}`);
    }
  }

  // ── V7：sql + xlsx + zip 三类入库、re 前缀、smoke 读 .sql、列校验读 .xlsx、dualcheck data_total=1 script_total=1 ──
  console.log('— V7 —');
  {
    const ctx = await freshFixture();
    const r = await postSubmit(ctx.id, ctx.dev1Token, [
      { name: 'result.xlsx', content: 'fake xlsx not validated' },
      { name: 'script.sql', content: 'SELECT 1 AS health_check' },
      { name: 'extra.zip', content: 'PK\x03\x04' },
    ]);
    assert(r.status === 200 && r.body && r.body.current_status === 'DONE' && r.body.sql_validation_status === 'passed',
      `[V7] sql+xlsx+zip → 200 DONE passed（实现坏成什么样它会红：§3.1 完整快照未放开 extra → INCOMPLETE_SNAPSHOT），实际 ${r.status} ${JSON.stringify(r.body)}`);
    const rows = await dbAll(`SELECT attachment_type, file_name FROM collab_attachments WHERE collab_request_id=? AND status='active' ORDER BY id`, [ctx.id]);
    assert(rows.length === 3 && rows.some(x => x.attachment_type === 'result_data') && rows.some(x => x.attachment_type === 'result_script') && rows.some(x => x.attachment_type === 'result_extra'),
      `[V7] 三类均入库 active，实际 ${JSON.stringify(rows)}`);
    const extraRow = rows.find(x => x.attachment_type === 'result_extra');
    assert(!!(extraRow && /_re_/.test(extraRow.file_name)), `[V7] result_extra file_name 含 '_re_' 前缀，实际 ${extraRow && extraRow.file_name}`);
    // smoke 真的跑了 script.sql（非 extra.zip）—— 响应 sql_validation_status=passed 已间接证明；
    // 列校验读 .xlsx —— quality_check.excel 侧应非因扩展名异常而 compute_failed
    assert(r.body.quality_check && r.body.quality_check.excel, `[V7] 响应含 quality_check.excel（列校验确实读了 .xlsx 一侧），实际 ${JSON.stringify(r.body.quality_check)}`);
    const logRow = await dbGet(`SELECT reason FROM collab_operation_logs WHERE collab_request_id=? AND operation_type='QUALITY_RECORD' AND reason LIKE 'dualcheck_checked_attachments%' ORDER BY id DESC LIMIT 1`, [ctx.id]);
    assert(!!(logRow && /data_total=1/.test(logRow.reason) && /script_total=1/.test(logRow.reason)),
      `[V7] dualcheck_checked_attachments 日志 data_total=1 script_total=1（不被 extra 污染），实际 ${logRow && logRow.reason}`);
  }

  // ── V8：数量约束四组 ──
  console.log('— V8 —');
  {
    // ① 只传 zip（无 data/script）→ RESULT_DATA_REQUIRED（分类器先检 data 后检 script）
    const ctx1 = await freshFixture();
    const r1 = await postSubmit(ctx1.id, ctx1.dev1Token, [{ name: 'only.zip', content: 'PK' }]);
    assert(r1.status === 400 && r1.body && r1.body.code === 'RESULT_DATA_REQUIRED',
      `[V8] 只传 zip → 400 RESULT_DATA_REQUIRED，实际 ${r1.status} ${JSON.stringify(r1.body)}`);

    // ② 5+5+5=15 → 2xx
    const ctx2 = await freshFixture();
    const files2 = [];
    for (let i = 1; i <= 5; i++) files2.push({ name: `d${i}.xlsx`, content: `d${i}` });
    for (let i = 1; i <= 5; i++) files2.push({ name: `s${i}.sql`, content: i === 1 ? 'SELECT 1' : `-- s${i}` });
    for (let i = 1; i <= 5; i++) files2.push({ name: `e${i}.zip`, content: `e${i}` });
    const r2 = await postSubmit(ctx2.id, ctx2.dev1Token, files2);
    assert(r2.status === 200 && r2.body && r2.body.current_status === 'DONE',
      `[V8] 5 data + 5 script + 5 extra = 15 → 200 DONE，实际 ${r2.status} ${JSON.stringify(r2.body)}`);

    // ③ 16 个 → multer LIMIT_FILE_COUNT（submitUpload.limits.files=15）
    const ctx3 = await freshFixture();
    const files3 = files2.concat([{ name: 'e6.zip', content: 'e6' }]);
    const r3 = await postSubmit(ctx3.id, ctx3.dev1Token, files3);
    assert(r3.status === 400 && r3.body && r3.body.code === 'LIMIT_FILE_COUNT',
      `[V8] 16 个文件 → 400 LIMIT_FILE_COUNT（submitUpload.limits.files=15），实际 ${r3.status} ${JSON.stringify(r3.body)}`);

    // ④ 1 data + 1 script + 6 extra=8 个（未超 multer 15）→ RESULT_EXTRA_TOO_MANY
    const ctx4 = await freshFixture();
    const files4 = [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }];
    for (let i = 1; i <= 6; i++) files4.push({ name: `e${i}.zip`, content: `e${i}` });
    const r4 = await postSubmit(ctx4.id, ctx4.dev1Token, files4);
    assert(r4.status === 400 && r4.body && r4.body.code === 'RESULT_EXTRA_TOO_MANY',
      `[V8] 1 data + 1 script + 6 extra → 400 RESULT_EXTRA_TOO_MANY，实际 ${r4.status} ${JSON.stringify(r4.body)}`);

    // ⑤ 6 script + 1 data + 1 extra=8 个 → RESULT_SCRIPT_TOO_MANY（与 extra 计数互不干扰）
    const ctx5 = await freshFixture();
    const files5 = [{ name: 'd.xlsx', content: 'd' }];
    for (let i = 1; i <= 6; i++) files5.push({ name: `s${i}.sql`, content: `-- s${i}` });
    files5.push({ name: 'e.zip', content: 'e' });
    const r5 = await postSubmit(ctx5.id, ctx5.dev1Token, files5);
    assert(r5.status === 400 && r5.body && r5.body.code === 'RESULT_SCRIPT_TOO_MANY',
      `[V8] 6 script + 1 data + 1 extra → 400 RESULT_SCRIPT_TOO_MANY，实际 ${r5.status} ${JSON.stringify(r5.body)}`);
  }

  // ── V8b：交错顺序 [xlsx, zip, sql, zip, sql] → orderedFiles 保序，取首脚本=第3个，取首数据=第1个，extra ordinal 1/2 ──
  console.log('— V8b —');
  {
    const ctx = await freshFixture();
    // 第 3 个（首个 sql）用健康脚本；第 5 个（第二个 sql）用会被黑名单层拦的危险脚本——
    // 若分类器/取首逻辑错把"最后一个 sql"当成首份去跑 smoke，会话直接 SMOKE_TEST_FAILED 而非 DONE，
    // 从而让"取首脚本=第 3 个"这条判据具备真实判别力（而不仅是"恰好都合法所以看不出取错"）。
    const r = await postSubmit(ctx.id, ctx.dev1Token, [
      { name: 'd1.xlsx', content: 'd1' },       // 位置1：首个 data
      { name: 'e1.zip', content: 'e1' },        // 位置2：首个 extra
      { name: 's1.sql', content: 'SELECT 1' },  // 位置3：首个 script（应被取首去跑 smoke，健康）
      { name: 'e2.zip', content: 'e2' },        // 位置4：第二个 extra
      { name: 's2.sql', content: "xp_cmdshell 'dir'" }, // 位置5：第二个 script（危险语句，若被误取首会 smoke 失败）
    ]);
    assert(r.status === 200 && r.body && r.body.current_status === 'DONE' && r.body.sql_validation_status === 'passed',
      `[V8b] 交错序 → 200 DONE passed（取首脚本必须是位置3 的健康脚本，若误取位置5 危险脚本会 SMOKE_TEST_FAILED），实际 ${r.status} ${JSON.stringify(r.body)}`);
    const dataRow = await dbGet(`SELECT original_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_data' AND status='active'`, [ctx.id]);
    assert(!!(dataRow && dataRow.original_name === 'd1.xlsx'), `[V8b] 取首数据=第1个（d1.xlsx），实际 ${dataRow && dataRow.original_name}`);
    const extraRows = await dbAll(`SELECT original_name, file_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active' ORDER BY id`, [ctx.id]);
    assert(extraRows.length === 2, `[V8b] extra 两个均入库，实际 ${extraRows.length}`);
    assert(!!(extraRows[0] && extraRows[0].original_name === 'e1.zip' && /_re_01_/.test(extraRows[0].file_name)),
      `[V8b] 第一个 extra（e1.zip，出现序 1）typeOrdinal=1（file_name 含 _re_01_），实际 ${JSON.stringify(extraRows[0])}`);
    assert(!!(extraRows[1] && extraRows[1].original_name === 'e2.zip' && /_re_02_/.test(extraRows[1].file_name)),
      `[V8b] 第二个 extra（e2.zip，出现序 2）typeOrdinal=2（file_name 含 _re_02_），实际 ${JSON.stringify(extraRows[1])}`);
  }

  // ── V9：代提各用例（不含撞名负向，见文件头注释）──
  console.log('— V9 —');
  {
    // ① 代提只传 extra → 2xx
    const ctx1 = await freshFixture();
    const r1 = await postAdminSubmit(ctx1.id, ctx1.adminToken, { expected_status: 'PENDING', result_extra: [{ name: 'only.zip', content: 'x' }] });
    assert(r1.status === 200, `[V9] 代提只传 extra → 200，实际 ${r1.status} ${JSON.stringify(r1.body)}`);
    // H1（Opus 预筛 C4·C4c 修）：同批 3 个 extra 须三条全 active——原逐文件「先 supersede 同类型 active 再 INSERT」会把本批前两个置 superseded
    {
      const ctxH = await freshFixture();
      const rH = await postAdminSubmit(ctxH.id, ctxH.adminToken, { expected_status: 'PENDING', result_extra: [
        { name: 'm1.zip', content: 'm1' }, { name: 'm2.rar', content: 'm2' }, { name: 'm3.7z', content: 'm3' } ] });
      assert(rH.status === 200, `[V9/H1] 代提同批 3 个 extra → 200，实际 ${rH.status} ${JSON.stringify(rH.body)}`);
      const rowsH = await dbAll(`SELECT status, file_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' ORDER BY id`, [ctxH.id]);
      const activeH = rowsH.filter(r => r.status === 'active').length;
      assert(rowsH.length === 3 && activeH === 3, `[V9/H1] 同批 3 个 extra 三条全 active（实现坏成什么样它会红：逐文件 supersede 循环把本批前两个置 superseded → active=1），实际 rows=${rowsH.length} active=${activeH} ${JSON.stringify(rowsH.map(r => r.status))}`);
      assert(new Set(rowsH.map(r => r.file_name)).size === 3 && rowsH.every(r => /_re_0[123]_/.test(r.file_name)), `[V9/H1] 三个 file_name 互异且带 _re_01/_02/_03 序号，实际 ${JSON.stringify(rowsH.map(r => r.file_name))}`);
      await cleanupCollabDisk(ctxH.id);
    }
    // V9b 正向（codex 08 M2）：同扩展名、不同内容两个 zip → 两条 active、file_name 互异、各自下载字节与上传内容一致（证明未覆盖/串写）
    {
      const ctxB = await freshFixture();
      const A = Buffer.from('AAAA-content-k1'), B = Buffer.from('BBBBBB-content-k2-longer');
      const rB = await postAdminSubmit(ctxB.id, ctxB.adminToken, { expected_status: 'PENDING', result_extra: [{ name: 'k1.zip', content: A }, { name: 'k2.zip', content: B }] });
      assert(rB.status === 200, `[V9b] 代提同扩展名两个 zip → 200，实际 ${rB.status} ${JSON.stringify(rB.body)}`);
      const rowsB = await dbAll(`SELECT file_name, original_name, status FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' ORDER BY id`, [ctxB.id]);
      assert(rowsB.length === 2 && rowsB.every(r => r.status === 'active') && rowsB[0].file_name !== rowsB[1].file_name,
        `[V9b] 两条全 active 且 file_name 互异（实现坏成什么样它会红：不传 typeOrdinal → 同名 rename 覆盖只剩一条/一份），实际 ${JSON.stringify(rowsB)}`);
      if (rowsB.length === 2) {
        const d1 = await downloadBytes(rowsB[0].file_name, ctxB.adminToken), d2 = await downloadBytes(rowsB[1].file_name, ctxB.adminToken);
        const byName = { [rowsB[0].original_name]: d1, [rowsB[1].original_name]: d2 };
        assert(d1.status === 200 && d2.status === 200 && byName['k1.zip'] && byName['k2.zip'] && byName['k1.zip'].buf.equals(A) && byName['k2.zip'].buf.equals(B),
          `[V9b] 两条各自下载字节与上传内容一致（k1=A、k2=B），实际 k1len=${byName['k1.zip'] && byName['k1.zip'].buf.length} k2len=${byName['k2.zip'] && byName['k2.zip'].buf.length}`);
      }
      await cleanupCollabDisk(ctxB.id);
    }

    // ② 代提 51MB zip → 400 ATTACHMENT_RULE_VIOLATION；codex 08 M3：与合法 script 同批 → 本批全清、零入库、跨请求哨兵不误删；恰 50MB 对照 → 200
    const ctx2 = await freshFixture();
    const big = Buffer.alloc(52428801, 1);
    const sentinelDir2 = path.join(COLLAB_PENDING, 'verify-sentinel-admin-' + Date.now());
    fs.mkdirSync(sentinelDir2, { recursive: true });
    const sentinelFile2 = path.join(sentinelDir2, 'sentinel.txt');
    fs.writeFileSync(sentinelFile2, 'keep-me');
    const r2 = await postAdminSubmit(ctx2.id, ctx2.adminToken, { expected_status: 'PENDING', result_script: { name: 'legal.sql', content: 'SELECT 1' }, result_extra: [{ name: 'big.zip', content: big }] });
    assert(r2.status === 400 && r2.body && r2.body.code === 'ATTACHMENT_RULE_VIOLATION',
      `[V9] 代提合法 sql + 51MB zip 同批 → 400 ATTACHMENT_RULE_VIOLATION，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    {
      const cnt = await dbGet(`SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=?`, [ctx2.id]);
      let leftover = []; try { leftover = fs.readdirSync(path.join(COLLAB_PENDING, String(ctx2.id))); } catch (_) {}
      assert(cnt && cnt.c === 0 && leftover.length === 0, `[V9/M3] 代提超限拒绝后零入库（含同批合法 sql）且 pending 本批全清，实际 rows=${cnt && cnt.c} leftover=${JSON.stringify(leftover)}`);
      assert(fs.existsSync(sentinelFile2) && fs.readFileSync(sentinelFile2, 'utf8') === 'keep-me', '[V9/M3] 另一请求目录哨兵文件仍在且内容不变（跨请求清理隔离）');
      const rExact = await postAdminSubmit(ctx2.id, ctx2.adminToken, { expected_status: 'PENDING', result_extra: [{ name: 'exact.zip', content: Buffer.alloc(52428800, 1) }] });
      assert(rExact.status === 200, `[V9/M3] 代提恰 52428800 字节 zip → 200（对照：规则误收紧这里红），实际 ${rExact.status} ${JSON.stringify(rExact.body)}`);
      try { fs.rmSync(sentinelDir2, { recursive: true, force: true }); } catch (_) {}
    }
    // /submit 侧同款（codex 08 M3）：sql + xlsx + 51MB zip 同批 → 400 RESULT_FILE_INVALID、零入库、pending 全清、哨兵不误删；恰 50MB → 200 DONE
    {
      const ctxS = await freshFixture();
      const sentinelDirS = path.join(COLLAB_PENDING, 'verify-sentinel-submit-' + Date.now());
      fs.mkdirSync(sentinelDirS, { recursive: true });
      const sentinelFileS = path.join(sentinelDirS, 'sentinel.txt');
      fs.writeFileSync(sentinelFileS, 'keep-me');
      const rS = await postSubmit(ctxS.id, ctxS.dev1Token, [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'big.zip', content: big }]);
      assert(rS.status === 400 && rS.body && rS.body.code === 'RESULT_FILE_INVALID', `[V2a/submit] sql+xlsx+51MB zip 同批 → 400 RESULT_FILE_INVALID（实现坏成什么样它会红：分类器不走 validateRule → 2xx），实际 ${rS.status} ${JSON.stringify(rS.body)}`);
      const cntS = await dbGet(`SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=?`, [ctxS.id]);
      let leftoverS = []; try { leftoverS = fs.readdirSync(path.join(COLLAB_PENDING, String(ctxS.id))); } catch (_) {}
      assert(cntS && cntS.c === 0 && leftoverS.length === 0, `[V2a/submit] 拒绝后零入库且 pending 本批（含合法 sql/xlsx）全清，实际 rows=${cntS && cntS.c} leftover=${JSON.stringify(leftoverS)}`);
      assert(fs.existsSync(sentinelFileS) && fs.readFileSync(sentinelFileS, 'utf8') === 'keep-me', '[V2a/submit] 哨兵文件仍在且内容不变');
      const rSx = await postSubmit(ctxS.id, ctxS.dev1Token, [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'exact.zip', content: Buffer.alloc(52428800, 1) }]);
      assert(rSx.status === 200 && rSx.body && rSx.body.current_status === 'DONE', `[V2a/submit] 恰 52428800 字节 zip → 200 DONE（对照），实际 ${rSx.status} ${JSON.stringify(rSx.body)}`);
      try { fs.rmSync(sentinelDirS, { recursive: true, force: true }); } catch (_) {}
      await cleanupCollabDisk(ctxS.id);
    }

    // ③ 代提 result_script 传 2MB .sql → 2xx（旧字段契约不收紧）
    const ctx3 = await freshFixture();
    const twoMb = Buffer.alloc(2 * 1024 * 1024, 1);
    const r3 = await postAdminSubmit(ctx3.id, ctx3.adminToken, { expected_status: 'PENDING', result_script: { name: 'big.sql', content: twoMb } });
    assert(r3.status === 200, `[V9] 代提 result_script 2MB .sql → 200（旧字段无 per-type 卡），实际 ${r3.status} ${JSON.stringify(r3.body)}`);

    // ④ 代提旧字段传 .zip → 400 ADMIN_FIELD_ARCHIVE_NOT_ALLOWED（C3b 已实现，此处复核不重复加代码）
    const ctx4 = await freshFixture();
    const r4 = await postAdminSubmit(ctx4.id, ctx4.adminToken, { expected_status: 'PENDING', result_script: { name: 'x.zip', content: 'x' } });
    assert(r4.status === 400 && r4.body && r4.body.code === 'ADMIN_FIELD_ARCHIVE_NOT_ALLOWED',
      `[V9] 代提 result_script=.zip → 400 ADMIN_FIELD_ARCHIVE_NOT_ALLOWED，实际 ${r4.status} ${JSON.stringify(r4.body)}`);

    // ⑤ 代提 6 个 extra → multer 既有码（fields maxCount:5，第 6 个越界 → LIMIT_UNEXPECTED_FILE）
    const ctx5 = await freshFixture();
    const extra6 = []; for (let i = 1; i <= 6; i++) extra6.push({ name: `e${i}.zip`, content: `e${i}` });
    const r5 = await postAdminSubmit(ctx5.id, ctx5.adminToken, { expected_status: 'PENDING', result_extra: extra6 });
    assert(r5.status === 400 && r5.body && r5.body.code === 'LIMIT_FILE_COUNT',
      `[V9] 代提 6 个 extra → 400（实测=collabUpload limits.files:5 先于 fields maxCount 触发 → LIMIT_FILE_COUNT；agent 首版猜 LIMIT_UNEXPECTED_FILE，主会话亲跑纠正），实际 ${r5.status} ${JSON.stringify(r5.body)}`);
  }

  // ── V9c：done_at_source 四态 ──
  console.log('— V9c —');
  {
    // ① SUBMITTED 且有开发 active rd/rs（先成功 DONE，再失败 resubmit 落回 SUBMITTED，旧 active 不动）
    const ctx1 = await freshFixture();
    const rFirst = await postSubmit(ctx1.id, ctx1.dev1Token, [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }]);
    assert(rFirst.status === 200 && rFirst.body.current_status === 'DONE', `[V9c①] 前置：首次提交 → DONE，实际 ${rFirst.status} ${JSON.stringify(rFirst.body)}`);
    const activeBefore = await dbGet(`SELECT MAX(created_at) AS last_at FROM collab_attachments WHERE collab_request_id=? AND status='active' AND attachment_type IN ('result_data','result_script')`, [ctx1.id]);
    const rSecond = await postSubmit(ctx1.id, ctx1.dev1Token, [{ name: 'd2.xlsx', content: 'd2' }, { name: 's2.sql', content: "xp_cmdshell 'dir'" }]);
    assert(rSecond.status === 200 && rSecond.body.business_error, `[V9c①] 前置：二次危险脚本提交 → smoke 失败，status 落回 SUBMITTED，实际 ${rSecond.status} ${JSON.stringify(rSecond.body)}`);
    const midState = await dbGet(`SELECT status FROM collab_requests WHERE id=?`, [ctx1.id]);
    assert(midState && midState.status === 'SUBMITTED', `[V9c①] 前置：二次失败后状态回到 SUBMITTED，实际 ${midState && midState.status}`);
    // codex 08 M1：把开发 active rd/rs 的 created_at 与 deadline 设成明确不同的历史时刻，严格断言 done_at（响应 + 库）== 开发附件 MAX(created_at)
    //   （首版 `|| true` 恒真断言 + 同秒执行掩盖误取新附件时间，已删）
    const DEV_TS = '2026-09-01 10:00:00', DEADLINE_TS = '2026-09-05 09:00:00';
    await dbRun(`UPDATE collab_attachments SET created_at=? WHERE collab_request_id=? AND status='active' AND attachment_type IN ('result_data','result_script')`, [DEV_TS, ctx1.id]);
    await dbRun(`UPDATE collab_requests SET deadline=? WHERE id=?`, [DEADLINE_TS, ctx1.id]);   // 夹具 setCollabState 白名单无 deadline，直写
    const r1 = await postAdminSubmit(ctx1.id, ctx1.adminToken, { expected_status: 'SUBMITTED', result_extra: [{ name: 'extra.zip', content: 'x' }] });
    assert(r1.status === 200 && r1.body && r1.body.done_at_source === 'dev_last_active_attachment',
      `[V9c①] SUBMITTED 有开发 active rd/rs，仅代提 extra → done_at_source=dev_last_active_attachment（非 admin，adminHasFormalDelivery=false），实际 ${r1.status} ${JSON.stringify(r1.body)}`);
    const dbDone1 = await dbGet(`SELECT done_at FROM collab_requests WHERE id=?`, [ctx1.id]);
    assert(dbDone1 && dbDone1.done_at === DEV_TS,   // 代提响应体只回 done_at_source 不回 done_at，以库为准
      `[V9c①] done_at（响应与库）应严格等于开发 active rd/rs 的 MAX(created_at)=${DEV_TS}（实现坏成什么样它会红：:20554 表达式误含 result_extra → 取到刚上传的 extra 时间=now；误退 deadline → ${DEADLINE_TS}），实际 db=${dbDone1 && dbDone1.done_at}（activeBefore 参考 ${activeBefore && activeBefore.last_at}）`);

    // ② SUBMITTED 且无 active rd/rs（直插残态）→ done_at=deadline, source=deadline
    const ctx2 = await freshFixture();
    const RESID_DEADLINE = '2026-09-06 08:00:00';
    await fx.setCollabState(ctx2.id, { status: 'SUBMITTED', submission_version: 1 });
    await dbRun(`UPDATE collab_requests SET deadline=? WHERE id=?`, [RESID_DEADLINE, ctx2.id]);
    const r2 = await postAdminSubmit(ctx2.id, ctx2.adminToken, { expected_status: 'SUBMITTED', result_extra: [{ name: 'extra.zip', content: 'x' }] });
    assert(r2.status === 200 && r2.body && r2.body.done_at_source === 'deadline',
      `[V9c②] SUBMITTED 直插残态（无 active rd/rs）→ done_at_source=deadline，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
    const dbDone2 = await dbGet(`SELECT done_at FROM collab_requests WHERE id=?`, [ctx2.id]);
    assert(dbDone2 && dbDone2.done_at === RESID_DEADLINE,
      `[V9c②] 残态 done_at 应严格等于 deadline=${RESID_DEADLINE}（codex 08 M1：不含 extra 时既有 COALESCE 退到 deadline；误含 extra → now），实际 db=${dbDone2 && dbDone2.done_at}`);

    // ③ PENDING → done_at_source=now（跳过附件反推）
    const ctx3 = await freshFixture();
    const r3 = await postAdminSubmit(ctx3.id, ctx3.adminToken, { expected_status: 'PENDING', result_extra: [{ name: 'extra.zip', content: 'x' }] });
    assert(r3.status === 200 && r3.body && r3.body.done_at_source === 'now',
      `[V9c③] PENDING → done_at_source=now，实际 ${r3.status} ${JSON.stringify(r3.body)}`);

    // ④ DONE → done_at 不变
    const ctx4 = await freshFixture();
    const rDone = await postSubmit(ctx4.id, ctx4.dev1Token, [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }]);
    assert(rDone.status === 200 && rDone.body.current_status === 'DONE', `[V9c④] 前置：首次提交 → DONE，实际 ${rDone.status}`);
    const beforeDoneAt = await dbGet(`SELECT done_at FROM collab_requests WHERE id=?`, [ctx4.id]);
    const r4 = await postAdminSubmit(ctx4.id, ctx4.adminToken, { expected_status: 'DONE', result_extra: [{ name: 'extra.zip', content: 'x' }] });
    assert(r4.status === 200, `[V9c④] DONE→DONE 仅代提 extra → 200，实际 ${r4.status} ${JSON.stringify(r4.body)}`);
    const afterDoneAt = await dbGet(`SELECT done_at FROM collab_requests WHERE id=?`, [ctx4.id]);
    assert(!!(beforeDoneAt && afterDoneAt && beforeDoneAt.done_at === afterDoneAt.done_at),
      `[V9c④] done_at 不变（COALESCE(done_at, now()) 保留原值），实际 before=${beforeDoneAt && beforeDoneAt.done_at} after=${afterDoneAt && afterDoneAt.done_at}`);
  }

  // ── V10：DONE 重传 supersede 正向半段（回滚半段见 verify-collab-versioning-rollback-hook.js）──
  console.log('— V10 —');
  {
    const ctx = await freshFixture();
    const r1 = await postSubmit(ctx.id, ctx.dev1Token, [
      { name: 'd1.xlsx', content: 'd1' }, { name: 's1.sql', content: 'SELECT 1' }, { name: 'old.zip', content: 'OLDZIP' },
    ]);
    assert(r1.status === 200 && r1.body.current_status === 'DONE', `[V10] 前置：首次提交（含 extra）→ DONE，实际 ${r1.status} ${JSON.stringify(r1.body)}`);
    const oldExtraRow = await dbGet(`SELECT id, file_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctx.id]);
    assert(!!oldExtraRow, '[V10] 前置：旧版 extra 已入库 active');

    const r2 = await postSubmit(ctx.id, ctx.dev1Token, [
      { name: 'd2.xlsx', content: 'd2' }, { name: 's2.sql', content: 'SELECT 1' }, { name: 'new.zip', content: 'NEWZIP' },
    ]);
    assert(r2.status === 200 && r2.body.current_status === 'DONE', `[V10] 重传（含新 extra）→ DONE，实际 ${r2.status} ${JSON.stringify(r2.body)}`);

    const oldRowAfter = await dbGet(`SELECT status FROM collab_attachments WHERE id=?`, [oldExtraRow.id]);
    assert(!!(oldRowAfter && oldRowAfter.status === 'superseded'), `[V10] 旧 extra 置 superseded（实现坏成什么样它会红：:605-613 supersede WHERE 未含 result_extra → 旧压缩包永远 active），实际 ${oldRowAfter && oldRowAfter.status}`);
    // 旧版仍可下载（superseded 不等于物理删除，express.static 仍可读）
    const dlOld = await fetch(`${BASE}/uploads/${oldExtraRow.file_name.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${ctx.adminToken}` } });
    assert(dlOld.status === 200, `[V10] 旧 extra 物理文件仍可下载（superseded≠删除），实际 ${dlOld.status}`);
    const newRows = await dbAll(`SELECT attachment_type FROM collab_attachments WHERE collab_request_id=? AND status='active'`, [ctx.id]);
    assert(newRows.length === 3 && ['result_data', 'result_script', 'result_extra'].every(t => newRows.some(r => r.attachment_type === t)),
      `[V10] 新版三类均 active，实际 ${JSON.stringify(newRows)}`);
  }

  // ── V10b：代提连续两次传 extra → 旧 superseded 新 active；smoke 失败 → extra 与 rd/rs 同批 failed；
  //          EXPORTING 切回流转 :18234 → extra 一并 superseded ──
  console.log('— V10b —');
  {
    // ① 代提连续两次 extra
    const ctx1 = await freshFixture();
    const rA = await postAdminSubmit(ctx1.id, ctx1.adminToken, { expected_status: 'PENDING', result_extra: [{ name: 'v1.zip', content: 'v1' }] });
    assert(rA.status === 200, `[V10b①] 代提第一次 extra → 200，实际 ${rA.status} ${JSON.stringify(rA.body)}`);
    const firstRow = await dbGet(`SELECT id FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctx1.id]);
    const rB = await postAdminSubmit(ctx1.id, ctx1.adminToken, { expected_status: 'DONE', result_extra: [{ name: 'v2.zip', content: 'v2' }] });
    assert(rB.status === 200, `[V10b①] 代提第二次 extra（DONE→DONE 修正）→ 200，实际 ${rB.status} ${JSON.stringify(rB.body)}`);
    const firstAfter = await dbGet(`SELECT status FROM collab_attachments WHERE id=?`, [firstRow.id]);
    assert(!!(firstAfter && firstAfter.status === 'superseded'), `[V10b①] 旧 extra 置 superseded，实际 ${firstAfter && firstAfter.status}`);
    const activeExtra = await dbGet(`SELECT original_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctx1.id]);
    assert(!!(activeExtra && activeExtra.original_name === 'v2.zip'), `[V10b①] 新 extra（v2.zip）active，实际 ${activeExtra && activeExtra.original_name}`);

    // ② smoke 失败 → extra 与 rd/rs 同批 failed
    const ctx2 = await freshFixture();
    const rFail = await postSubmit(ctx2.id, ctx2.dev1Token, [
      { name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: "xp_cmdshell 'dir'" }, { name: 'e.zip', content: 'e' },
    ]);
    assert(rFail.status === 200 && rFail.body.business_error, `[V10b②] 危险脚本触发 smoke 失败（撞墙保留），实际 ${rFail.status} ${JSON.stringify(rFail.body)}`);
    const failedRows = await dbAll(`SELECT attachment_type FROM collab_attachments WHERE collab_request_id=? AND status='failed'`, [ctx2.id]);
    assert(failedRows.length === 3 && ['result_data', 'result_script', 'result_extra'].every(t => failedRows.some(r => r.attachment_type === t)),
      `[V10b②] 三类同批 failed（extra 与 rd/rs 一起走 insertFailedAttachments），实际 ${JSON.stringify(failedRows)}`);

    // ③ EXPORTING 切回流转 :18234 → extra 一并 superseded
    const ctx3 = await freshFixture();
    const rOk = await postSubmit(ctx3.id, ctx3.dev1Token, [
      { name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'e.zip', content: 'e' },
    ]);
    assert(rOk.status === 200 && rOk.body.current_status === 'DONE', `[V10b③] 前置：提交成功 → DONE，实际 ${rOk.status}`);
    const extraRowExp = await dbGet(`SELECT id FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctx3.id]);
    // 构造 EXPORTING + admin_direct（切回流转端点准入条件）
    await fx.setCollabState(ctx3.id, { status: 'EXPORTING', assign_mode: 'admin_direct', exporter_user_id: fx.EXPORTER_ID, exporter_name: 'exporter' });
    const rFallback = await fetch(`${BASE}/api/collab/requests/${ctx3.id}/admin-direct-fallback`, {
      method: 'POST', headers: { authorization: `Bearer ${await fx.signAs(fx.ADMIN_ID)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ fallback_reason: 'C4 verify：切回流转验证 extra 一并 superseded' }),
    });
    const rFallbackBody = await rFallback.json().catch(() => ({}));
    assert(rFallback.status === 200, `[V10b③] 切回流转 EXPORTING→PENDING_ASSIGN → 200，实际 ${rFallback.status} ${JSON.stringify(rFallbackBody)}`);
    const extraRowAfterFallback = await dbGet(`SELECT status FROM collab_attachments WHERE id=?`, [extraRowExp.id]);
    assert(!!(extraRowAfterFallback && extraRowAfterFallback.status === 'superseded'),
      `[V10b③] 切回流转后 extra 一并 superseded（实现坏成什么样它会红：:18234 手写 IN 列表未改引常量 → extra 仍 active），实际 ${extraRowAfterFallback && extraRowAfterFallback.status}`);
  }

  // ── C6（用户 2026-09-09 裁定 P4）：补充材料删除入口——DONE 下当前开发 / admin 可删 result_extra，无关用户 403，不套用「最后一个」警示 ──
  console.log('— C6 删除入口 —');
  {
    const ctxD = await freshFixture();
    const rD = await postSubmit(ctxD.id, ctxD.dev1Token, [{ name: 'd.xlsx', content: 'd' }, { name: 's.sql', content: 'SELECT 1' }, { name: 'e1.zip', content: 'e1' }, { name: 'e2.zip', content: 'e2' }]);
    assert(rD.status === 200 && rD.body.current_status === 'DONE', `[C6] 前置：sql+xlsx+2 extra 提交 → DONE，实际 ${rD.status}`);
    const extras = await dbAll(`SELECT id, file_name FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active' ORDER BY id`, [ctxD.id]);
    assert(extras.length === 2, `[C6] 前置：两条 active extra，实际 ${extras.length}`);
    if (extras.length === 2) {
      const viewerToken = await fx.signAs(fx.VIEWER_ID);
      const rV = await fetch(`${BASE}/api/collab/attachments/${extras[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${viewerToken}` } });
      assert(rV.status === 403, `[C6] viewer 删 extra → 403（requireNonViewer 前置，覆盖 viewer 禁删；owner 闸另测），实际 ${rV.status}`);
      // codex 10 L1：用非 viewer、非当前开发的普通用户（admin 之外任取一个真实非 viewer 账号）验 DONE 分支 NOT_CURRENT_DEVELOPER / owner 闸
      const otherRow = await dbGet(`SELECT id FROM users WHERE id NOT IN (?, ?, ?) AND role NOT IN ('viewer','admin') AND status='active' ORDER BY id LIMIT 1`, [fx.ADMIN_ID, fx.DEV1_ID, fx.VIEWER_ID]);
      if (otherRow) {
        const rO = await fetch(`${BASE}/api/collab/attachments/${extras[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${await fx.signAs(otherRow.id)}` } });
        let jO = null; try { jO = await rO.json(); } catch (_) {}
        assert(rO.status === 403 && jO && /NOT_CURRENT_DEVELOPER|ATTACHMENT_OWNER/.test(jO.code || ''), `[C6] 非当前开发的普通用户删 extra → 403 且码为 NOT_CURRENT_DEVELOPER/owner 闸（实现坏成什么样它会红：isResultType 含 extra 后若 DONE 分支放行非本人 → 200），实际 ${rO.status} ${JSON.stringify(jO)}`);
      } else { failed++; console.log('  ✗ [C6] 找不到非 viewer 非 admin 的第三方用户造 NOT_CURRENT_DEVELOPER 用例=计红'); }
      const rDev = await fetch(`${BASE}/api/collab/attachments/${extras[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${ctxD.dev1Token}` } });
      const gone = await dbGet(`SELECT id FROM collab_attachments WHERE id=?`, [extras[0].id]);
      assert(rDev.status === 200 && !gone && !fs.existsSync(path.join(UPLOAD_DIR, extras[0].file_name)), `[C6] 当前开发删自己单的 extra → 200 且记录与文件消失（实现坏成什么样它会红：DONE 分支把 extra 归入「截图/模板仅管理员」→ 403 NOT_ADMIN_FOR_TYPE），实际 ${rDev.status} gone=${!gone}`);
      const rAdm = await fetch(`${BASE}/api/collab/attachments/${extras[1].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${ctxD.adminToken}` } });
      const st = await dbGet(`SELECT status FROM collab_requests WHERE id=?`, [ctxD.id]);
      const gone2 = await dbGet(`SELECT id FROM collab_attachments WHERE id=?`, [extras[1].id]);
      const activeExtra = await dbGet(`SELECT COUNT(*) AS c FROM collab_attachments WHERE collab_request_id=? AND attachment_type='result_extra' AND status='active'`, [ctxD.id]);
      const stRow = await dbGet(`SELECT status, sql_validation_status FROM collab_requests WHERE id=?`, [ctxD.id]);
      assert(rAdm.status === 200 && !gone2 && !fs.existsSync(path.join(UPLOAD_DIR, extras[1].file_name)) && activeExtra && activeExtra.c === 0 && st && st.status === 'DONE' && stRow && stRow.sql_validation_status === 'passed', `[C6] admin 删最后一个 extra → 200、记录与文件消失、active extra=0、单据仍 DONE 且 sql_validation_status 仍 passed（不回退、不重排 smoke；codex 10 L2），实际 ${rAdm.status} gone=${!gone2} active=${activeExtra && activeExtra.c} ${JSON.stringify(stRow)}`);
    }
    await cleanupCollabDisk(ctxD.id);
  }


  console.log(`\n${failed === 0 ? '✅' : '❌'} verify-collab-delivery-extra：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error('💥 执行异常:', e && e.stack || e);
  process.exitCode = 1;
}).finally(async () => {
  for (const id of createdCollabIds) { try { await cleanupCollabDisk(id); await fx.cleanup(id); } catch (_) {} }
  if (testTmpDir) { try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) {} }
});
