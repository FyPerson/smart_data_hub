'use strict';
// C2（长任务 E · 巡检台账照片）接口层守卫。用 createFixture() 直接打 HTTP + 原生 multipart
// （Node18+ FormData/Blob + fetch），覆盖派单 spec-C2.md §二 1-9 条 + 变异自检 ≥6 处。
// 目录对账（第8条）需要 enableTestHooks + 对初始化时序的完全控制，createFixture() 内部无条件
// 调用 initSchema()（早于测试代码能往存储目录放文件），因此第8条走独立的自建 harness
// （testDirectoryReconciliation()），不复用 createFixture()。其余 1-7/9 条共用一个 createFixture()
// 会话。
//
// G3A（41S/41T 审查订正保证边界，与 verify-it-ledger-inspection-sheets.js/-collect.js 一致）→
// G3A-b（M6：探针入口扩到 assertWrite）：本文件末尾"G2A2 运行时探针"节的零违规断言，保证范围
// 只到"经 withRead / withWrite 注入的 q.get/all/run/assertWrite 四个入口执行的 SQL"为止；路由
// （或其 require 的本地助手模块）自行打开数据库连接不在探针可见范围内，由 R10 结构规则挡住
// （G3A-b M5 起覆盖 inspection-sheets.js / inspections.js / inspection-collect.js /
// inspection-photo-files.js 四个文件），不是"任何写法都绕不过"。
const assert = require('assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { createFixture, isProbeViolation, normalizeInspectionRouteKey } = require('./it-ledger-browser-fixture');
// C2b：恢复阶段要用"真实"的 removeStoredFile 实现（不是测试注入的假实现），直接引用生产模块。
const photoFilesReal = require('../routes/it-ledger/inspection-photo-files');

let pass = 0;
function check(name, ok, detail) { if (!ok && detail !== undefined) console.error('DETAIL', name, JSON.stringify(detail)); assert.ok(ok, name); pass++; console.log('[OK] ' + name); }

// C2c M1：清理队列处理挪到响应发出之后（fire-and-forget，不再阻塞响应）——任何"写请求响应一
// 回来就检查清理队列/文件是否已经处理完"的断言不能再假定同步完成，改用有界轮询等到达信号，不用
// 盲 sleep（到达就立刻返回，超时才报错，poll 间隔20ms足够快不会拖慢正常通过的用例）。
async function waitFor(checkFn, { timeoutMs = 3000, intervalMs = 20, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    const result = await checkFn();
    if (result) return result;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor(${label}): 超时(${timeoutMs}ms)未满足条件`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ============================================================
// 最小合法字节 / 明显非法字节（够 matchesMagic() 判定，不需要真能解码像素）
// ============================================================
const MIN_JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
const MIN_PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 1)]);
const MIN_WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(8, 2)]);
const NOT_AN_IMAGE_BYTES = Buffer.from('this is plain text, not an image, padding padding padding padding');
function bigBuffer(sizeBytes) { const b = Buffer.alloc(sizeBytes, 3); MIN_JPEG_BYTES.copy(b, 0); return b; }

// ============================================================
// 共享测试助手（与 verify-it-ledger-inspection-sheets.js 同款写法，独立复制一份——两个文件各自
// 独立运行，不互相 require）。
// ============================================================
async function makeRoom(f, roomName, rackCount = 1, devicesPerRack = 1) {
  const racks = [];
  for (let i = 0; i < rackCount; i++) {
    const r = (await f.api('POST', '/racks', { name: roomName + '-柜' + (i + 1), room: roomName, u_total: 20 })).body;
    racks.push(r);
    for (let d = 0; d < devicesPerRack; d++) {
      await f.api('POST', '', { category: 'server', name: roomName + '-设备' + (i + 1) + '-' + (d + 1), u_height: 1, placement: { kind: 'rack', rack_id: r.id, u_start: d + 1 } });
    }
  }
  return racks;
}
const createSheetAs = (f, uid, roomName) => f.api('POST', '/inspections/sheets', { room_name: roomName }, uid);
const getSheetAs = (f, sheetId, uid) => f.api('GET', '/inspections/sheets/' + sheetId, undefined, uid);
function fillPayloadAllOk(items, numberDefault) {
  return items.map((it) => (it.value_kind === 'number'
    ? { id: it.id, result: null, number_value: numberDefault[it.item_key] ?? 25, note: null }
    : { id: it.id, result: 'ok', number_value: null, note: null }));
}
const NUMBER_DEFAULT = { temperature: 22, humidity: 45 };
async function buildDraftSheet(f, roomName, ownerUid = 2, rackCount = 1) {
  await makeRoom(f, roomName, rackCount);
  const created = await createSheetAs(f, ownerUid, roomName);
  assert.equal(created.status, 201, 'buildDraftSheet ' + roomName + ' ' + JSON.stringify(created.body));
  return created.body;
}
async function uploadPhoto(f, sheetId, slot, targetId, uid, opts = {}) {
  const fd = new FormData();
  fd.append('slot', slot);
  fd.append('target_id', String(targetId));
  const bytes = opts.bytes || MIN_JPEG_BYTES;
  fd.append('file', new Blob([bytes], { type: opts.mime || 'image/jpeg' }), opts.filename || 'p.jpg');
  const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd });
  const body = await resp.json();
  return { status: resp.status, body };
}
// C2b 任务3：手写 multipart 请求体，用原生 http.request 分两段写——第一段发完之后，调用方的
// onMidway(hasResponded) 回调有机会在"请求体还没发完、服务端 multer 还在等更多字节"这个窗口内
// 插一次另一条连接的请求，验证 §5.1 不可拆分条件（照片上传唯一的锁外窗口是 receive() 期间）。
// 不用 fetch+ReadableStream（duplex:'half' 在部分 Node 版本上行为不稳定），直接用 http.request
// 更好控制"确实没发完"这件事——第二段字节与结尾边界在 onMidway 跑完之前根本不存在于线上。
const http = require('http');
async function uploadPhotoChunked(f, sheetId, slot, targetId, uid, bytes, onMidway) {
  const boundary = '----c2bBoundary' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const preamble = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="slot"${CRLF}${CRLF}${slot}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="target_id"${CRLF}${CRLF}${targetId}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="chunked.jpg"${CRLF}Content-Type: image/jpeg${CRLF}${CRLF}`
  );
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const mid = Math.max(1, Math.floor(bytes.length / 2));
  const fileChunk1 = bytes.subarray(0, mid);
  const fileChunk2 = bytes.subarray(mid);
  const url = new URL(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos');
  let responded = false;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
      headers: { Authorization: 'Bearer fixture-' + uid, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        responded = true;
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_e) { /* keep {} */ }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.write(preamble);
    req.write(fileChunk1);
    // 到这里为止：preamble + 第一段文件字节已经发到服务端，第二段与结尾边界都还没写进 socket——
    // multer/busboy 语法上不可能判定这是一个完整的 multipart 请求，服务端此刻必然还在等更多字节，
    // 不是"大概率"而是由我们自己还没调用 req.write(fileChunk2)/req.end() 这件事保证的。
    (async () => {
      try {
        await onMidway(() => responded);
        req.write(fileChunk2);
        req.end(epilogue);
      } catch (e) { reject(e); }
    })();
  });
}
async function deletePhoto(f, sheetId, photoId, uid) {
  const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos/' + photoId, { method: 'DELETE', headers: { Authorization: 'Bearer fixture-' + uid } });
  const body = await resp.json();
  return { status: resp.status, body };
}
async function discardPendingPhotos(f, sheetId, uid) {
  const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/pending-photos', { method: 'DELETE', headers: { Authorization: 'Bearer fixture-' + uid } });
  const body = await resp.json();
  return { status: resp.status, body };
}
async function getPhotoContent(f, sheetId, photoId, uid) {
  const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos/' + photoId + '/content', { headers: { Authorization: 'Bearer fixture-' + uid } });
  const buf = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, headers: resp.headers, buf };
}
async function uploadAllRackFrontPhotos(f, sheetId, scope, uid) {
  const uploaded = [];
  for (const r of scope.racks) {
    const res = await uploadPhoto(f, sheetId, 'rack_front', r.id, uid);
    assert.equal(res.status, 201, 'uploadAllRackFrontPhotos ' + JSON.stringify(res.body));
    uploaded.push(res.body.photo);
  }
  return uploaded;
}
async function buildSubmittedSheet(f, roomName, ownerUid = 2, rackCount = 1) {
  const created = await buildDraftSheet(f, roomName, ownerUid, rackCount);
  const detail = await getSheetAs(f, created.id, ownerUid);
  const put = await f.api('PUT', '/inspections/sheets/' + created.id, { expected_version: created.version, items: fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT) }, ownerUid);
  assert.equal(put.status, 200, 'buildSubmittedSheet put ' + JSON.stringify(put.body));
  await uploadAllRackFrontPhotos(f, created.id, created.scope, ownerUid);
  const submit = await f.api('POST', '/inspections/sheets/' + created.id + '/submit', { expected_version: put.body.version }, ownerUid);
  assert.equal(submit.status, 200, 'buildSubmittedSheet submit ' + JSON.stringify(submit.body));
  return submit.body;
}
async function currentVersionAs(f, sheetId, uid = 1) { const r = await getSheetAs(f, sheetId, uid); return r.body.version; }

// ============================================================
// 主流程：1-7、9 条，共用一个 createFixture()。
// ============================================================
async function mainHttpTests() {
  // C2d T-H2：整个 mainHttpTests 共享一个可变的 testHooks 对象——queueUnlink 默认 undefined（落回
  //   真实 fsp.unlink），各用例在需要时中途把它换成一个恒抛错的函数，模拟"队列处理时 unlink 失败"，
  //   验证完之后清空恢复。与 removeFile()/queueUnlink() 的"每次调用时才读"写法配套，不需要为T-H2
  //   这10个子例各起一个新fixture。
  const sharedTestHooks = {};
  // G2A2（长任务 E 段2）：运行时锁外读库探针——本套件末尾断言违规数精确为0（见文件尾）。
  const sqlProbeRecords = [];
  // C2f：inspectionSheetTestHooks 现在只在 enableTestHooks:true 时才生效（M8 闸收口），T-H2 这批
  //   用例需要 queueUnlink 真的被注入，必须显式传。
  const f = await createFixture({ inspectionSheetTestHooks: sharedTestHooks, enableTestHooks: true, sqlProbe: (rec) => sqlProbeRecords.push(rec) });
  console.log('ISOLATED_ARTIFACTS=' + f.dir);
  try {
    // ============================================================
    // 1) 上传校验：类型（扩展名/魔数）、大小、空文件；目标校验；可见性与权限
    // ============================================================
    {
      const s1 = await buildDraftSheet(f, 'P1-Upload', 2);
      const rackId = s1.scope.racks[0].id;
      const detail1 = await getSheetAs(f, s1.id, 2);
      const tempItem = detail1.body.items.find((it) => it.item_key === 'temperature');
      const doorItem = detail1.body.items.find((it) => it.item_key === 'door');

      const badExt = await uploadPhoto(f, s1.id, 'rack_front', rackId, 2, { filename: 'x.gif', bytes: MIN_PNG_BYTES, mime: 'image/gif' });
      check('P1不支持的扩展名400', badExt.status === 400 && badExt.body.code === 'LEDGER_BAD_REQUEST', badExt.body);

      const magicMismatch = await uploadPhoto(f, s1.id, 'rack_front', rackId, 2, { filename: 'x.jpg', bytes: NOT_AN_IMAGE_BYTES, mime: 'image/jpeg' });
      check('P1魔数与扩展名不符400', magicMismatch.status === 400 && magicMismatch.body.code === 'LEDGER_BAD_REQUEST', magicMismatch.body);

      const tooBig = await uploadPhoto(f, s1.id, 'rack_front', rackId, 2, { filename: 'x.jpg', bytes: bigBuffer(21 * 1024 * 1024) });
      check('P1超过20MiB400', tooBig.status === 400, tooBig.body);

      const empty = await uploadPhoto(f, s1.id, 'rack_front', rackId, 2, { filename: 'x.jpg', bytes: Buffer.alloc(0) });
      check('P1空文件400', empty.status === 400 && empty.body.code === 'LEDGER_BAD_REQUEST', empty.body);

      // 目标校验
      const s1b = await buildDraftSheet(f, 'P1-OtherSheet', 2);
      const otherRackUpload = await uploadPhoto(f, s1.id, 'rack_front', s1b.scope.racks[0].id, 2);
      check('P1他单机柜400', otherRackUpload.status === 400 && otherRackUpload.body.code === 'LEDGER_BAD_REQUEST', otherRackUpload.body);
      const outOfScopeRack = await uploadPhoto(f, s1.id, 'rack_front', 999999, 2);
      check('P1范围外机柜400', outOfScopeRack.status === 400 && outOfScopeRack.body.code === 'LEDGER_BAD_REQUEST', outOfScopeRack.body);
      const numberItemUpload = await uploadPhoto(f, s1.id, 'item', tempItem.id, 2);
      check('P1number项400', numberItemUpload.status === 400 && numberItemUpload.body.code === 'LEDGER_BAD_REQUEST', numberItemUpload.body);
      const otherSheetItemId = (await getSheetAs(f, s1b.id, 2)).body.items.find((it) => it.item_key === 'door').id;
      const otherItemUpload = await uploadPhoto(f, s1.id, 'item', otherSheetItemId, 2);
      check('P1他单item400', otherItemUpload.status === 400 && otherItemUpload.body.code === 'LEDGER_BAD_REQUEST', otherItemUpload.body);
      void doorItem;

      // 可见性与权限
      await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
      const othersDraftUpload = await uploadPhoto(f, s1.id, 'rack_front', rackId, 3); // uid3只读：requireLedgerWrite先挡
      check('P1只读上传403 LEDGER_FORBIDDEN', othersDraftUpload.status === 403 && othersDraftUpload.body.code === 'LEDGER_FORBIDDEN', othersDraftUpload.body);
      // 草稿对非owner/非admin可见性是summary(不是full)——uid5其他写权限者连详情都看不到，应404，不是403。
      const otherWriterOnDraft = await uploadPhoto(f, s1.id, 'rack_front', rackId, 5);
      check('P1其他写权限者对他人草稿上传404(草稿summary可见,先于isManager)', otherWriterOnDraft.status === 404, otherWriterOnDraft.body);
      const notOwnerDraftUpload = await uploadPhoto(f, s1.id, 'rack_front', rackId, 1); // 管理员：草稿对admin恒full可见+isManager恒真
      check('P1管理员对他人草稿上传201(admin恒isManager)', notOwnerDraftUpload.status === 201, notOwnerDraftUpload.body);

      // submitted态对所有人full可见——这时uid5其他写权限者能看到详情，但isManager挡它，才是真正的
      // 403 SHEET_FORBIDDEN 场景（与草稿态的404区分开）。
      const s1sub = await buildSubmittedSheet(f, 'P1-SubmittedForbidden', 2);
      const otherWriterOnSubmitted = await uploadPhoto(f, s1sub.id, 'rack_front', s1sub.scope.racks[0].id, 5);
      check('P1其他写权限者对他人已提交单上传403 SHEET_FORBIDDEN', otherWriterOnSubmitted.status === 403 && otherWriterOnSubmitted.body.code === 'SHEET_FORBIDDEN', otherWriterOnSubmitted.body);

      const s1archived = await buildSubmittedSheet(f, 'P1-Archived', 2);
      const archiveResp = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: s1archived.id, expected_version: s1archived.version }] }, 1);
      check('P1辅助单归档200', archiveResp.status === 200, archiveResp.body);
      const archivedUpload = await uploadPhoto(f, s1archived.id, 'rack_front', s1archived.scope.racks[0].id, 2);
      check('P1已归档单上传409 SHEET_STATE', archivedUpload.status === 409 && archivedUpload.body.code === 'SHEET_STATE', archivedUpload.body);

      const s1deleted = await buildSubmittedSheet(f, 'P1-Deleted', 2);
      const delResp = await f.api('DELETE', '/inspections/sheets/' + s1deleted.id, { expected_version: s1deleted.version, reason: 'P1测试删除' }, 2);
      check('P1辅助单逻辑删除200', delResp.status === 200, delResp.body);
      const deletedUpload = await uploadPhoto(f, s1deleted.id, 'rack_front', s1deleted.scope.racks[0].id, 2);
      check('P1已删除单上传404', deletedUpload.status === 404, deletedUpload.body);
      const deletedUploadAdmin = await uploadPhoto(f, s1deleted.id, 'rack_front', s1deleted.scope.racks[0].id, 1);
      check('P1已删除单管理员上传也404(明示例外之外一律404)', deletedUploadAdmin.status === 404, deletedUploadAdmin.body);
    }

    // ============================================================
    // 2) 三状态转换：草稿替换、已提交→pending、保存修改生效、改回正常失效、非异常pending丢弃、放弃修改
    // ============================================================
    let s2;
    {
      s2 = await buildDraftSheet(f, 'P2-States', 2);
      const rackId = s2.scope.racks[0].id;
      const up1 = await uploadPhoto(f, s2.id, 'rack_front', rackId, 2, { bytes: MIN_JPEG_BYTES });
      check('P2草稿首次上传201', up1.status === 201 && up1.body.photo.state === 'active', up1.body);
      const oldPhotoId = up1.body.photo.id;
      const oldStoredRow = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [oldPhotoId]))[0];
      const oldFilePath = path.join(f.dir, 'sheet-photos', oldStoredRow.stored_name);
      check('P2旧文件确实落盘', fs.existsSync(oldFilePath));

      const up2 = await uploadPhoto(f, s2.id, 'rack_front', rackId, 2, { bytes: MIN_PNG_BYTES, filename: 'p2.png', mime: 'image/png' });
      check('P2草稿替换上传201', up2.status === 201 && up2.body.photo.state === 'active', up2.body);
      check('P2追加上传不覆盖已有照片', (await getSheetAs(f,s2.id,2)).body.photos.length === 2);
      assert.equal((await deletePhoto(f,s2.id,oldPhotoId,2)).status,200);
      const rowsAfterReplace = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE id=?', [oldPhotoId]);
      check('P2旧照片行已删除(替换)', rowsAfterReplace.length === 0);
      // C2c M1：清理挪到响应之后 fire-and-forget，不能假定收到响应时已经处理完，改轮询等到达信号。
      await waitFor(() => !fs.existsSync(oldFilePath), { label: 'P2旧文件被清理' });
      check('P2旧文件已被清理队列删除(替换后best-effort异步处理)', !fs.existsSync(oldFilePath));
      const cleanupRowsAfterReplace = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup'); return rows.length === 0 ? rows : null; }, { label: 'P2清理队列处理完' });
      check('P2清理队列已处理完不留残留', cleanupRowsAfterReplace.length === 0, cleanupRowsAfterReplace);

      // 提交
      const detail2 = await getSheetAs(f, s2.id, 2);
      const doorItem2 = detail2.body.items.find((it) => it.item_key === 'door');
      const put2 = await f.api('PUT', '/inspections/sheets/' + s2.id, { expected_version: s2.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT) }, 2);
      check('P2保存全部ok200', put2.status === 200, put2.body);
      const submit2 = await f.api('POST', '/inspections/sheets/' + s2.id + '/submit', { expected_version: put2.body.version }, 2);
      check('P2提交200', submit2.status === 200, submit2.body);

      // 已提交上传 -> pending，只对上传者可见
      const pendingUp = await uploadPhoto(f, s2.id, 'rack_front', rackId, 2, { bytes: MIN_WEBP_BYTES, filename: 'p2b.webp', mime: 'image/webp' });
      check('P2已提交上传201且为pending', pendingUp.status === 201 && pendingUp.body.photo.state === 'pending', pendingUp.body);
      const pendingId = pendingUp.body.photo.id;
      const detailAsUid2 = await getSheetAs(f, s2.id, 2);
      check('P2上传者自己能在my_pending_photos看到', detailAsUid2.body.my_pending_photos.some((p) => p.id === pendingId), detailAsUid2.body.my_pending_photos);
      const detailAsAdmin = await getSheetAs(f, s2.id, 1);
      check('P2他人(管理员)看不到别人的pending', !detailAsAdmin.body.my_pending_photos.some((p) => p.id === pendingId), detailAsAdmin.body.my_pending_photos);
      check('P2active照片列表未变(pending不替换active)', detailAsAdmin.body.photos.length === 1 && detailAsAdmin.body.photos[0].state === 'active', detailAsAdmin.body.photos);
      const adminDeleteOthersPending = await deletePhoto(f, s2.id, pendingId, 1);
      check('P2他人不能删除别人的pending404', adminDeleteOthersPending.status === 404 && adminDeleteOthersPending.body.code === 'SHEET_PHOTO_NOT_FOUND', adminDeleteOthersPending.body);
      const adminGetOthersPendingContent = await getPhotoContent(f, s2.id, pendingId, 1);
      check('P2他人不能下载别人的pending内容404', adminGetOthersPendingContent.status === 404, adminGetOthersPendingContent.status);

      // 保存修改：pending生效
      const oldActiveRow = detailAsAdmin.body.photos[0];
      assert.equal((await deletePhoto(f,s2.id,oldActiveRow.id,2)).status,200);
      const editActivate = await f.api('PUT', '/inspections/sheets/' + s2.id, { expected_version: submit2.body.version, items: [] }, 2);
      check('P2保存修改生效pending200', editActivate.status === 200 && editActivate.body.version === submit2.body.version + 1, editActivate.body);
      const activeAfterEdit = editActivate.body.photos.find((p) => p.slot === 'rack_front' && p.target_id === rackId);
      check('P2生效后active是原pending', activeAfterEdit && activeAfterEdit.id === pendingId, editActivate.body.photos);
      const oldActiveRowAfter = (await f.all('SELECT state,superseded_by,superseded_at FROM it_inspection_sheet_photos WHERE id=?', [oldActiveRow.id]))[0];
      check('P2原active照片变superseded且superseded_by/at有值', oldActiveRowAfter.state === 'superseded' && oldActiveRowAfter.superseded_by === 2 && !!oldActiveRowAfter.superseded_at, oldActiveRowAfter);
      function lastEditLog(logArr) { const edits = logArr.filter((l) => l.action === 'edit'); return edits[edits.length - 1]; }
      const photoDiff = lastEditLog(editActivate.body.log).diff.find((d) => d.kind === 'photo');
      check('P2 diff含photo条目且before/after_photo_id正确', photoDiff && photoDiff.before_photo_id === null && photoDiff.after_photo_id === pendingId && editActivate.body.log.some(l=>l.diff?.some(d=>d.kind==='photo_removed'&&d.photo_id===oldActiveRow.id)), photoDiff);

      // 改回正常 -> item照片失效（先标bad+传pending+生效，再改回ok）
      const doorItemId = doorItem2.id;
      const badUp = await uploadPhoto(f, s2.id, 'item', doorItemId, 2);
      check('P2门项pending照片上传201', badUp.status === 201 && badUp.body.photo.state === 'pending', badUp.body);
      const markBad = await f.api('PUT', '/inspections/sheets/' + s2.id, { expected_version: editActivate.body.version, items: [{ id: doorItemId, result: 'bad', number_value: null, note: 'P2测试异常' }] }, 2);
      check('P2标异常且门项照片生效200', markBad.status === 200, markBad.body);
      const doorPhotoActive = markBad.body.photos.find((p) => p.slot === 'item' && p.target_id === doorItemId);
      check('P2门项照片已生效为active', !!doorPhotoActive, markBad.body.photos);
      const revertNormal = await f.api('PUT', '/inspections/sheets/' + s2.id, { expected_version: markBad.body.version, items: [{ id: doorItemId, result: 'ok', number_value: null, note: null }] }, 2);
      check('P2改回正常200', revertNormal.status === 200, revertNormal.body);
      const doorPhotoRowAfterRevert = (await f.all('SELECT state FROM it_inspection_sheet_photos WHERE id=?', [doorPhotoActive.id]))[0];
      check('P2改回正常后门项照片变superseded', doorPhotoRowAfterRevert.state === 'superseded', doorPhotoRowAfterRevert);
      const invalidatedDiff = lastEditLog(revertNormal.body.log).diff.find((d) => d.kind === 'photo_invalidated');
      check('P2 diff含photo_invalidated', invalidatedDiff && invalidatedDiff.photo_id === doorPhotoActive.id, invalidatedDiff);

      // 非异常项pending丢弃（对一个当前ok的项传pending，保存修改后应被丢弃不生效）
      const lightsItem = revertNormal.body.items.find((it) => it.item_key === 'lights');
      const notBadUp = await uploadPhoto(f, s2.id, 'item', lightsItem.id, 2);
      check('P2非异常项pending上传201', notBadUp.status === 201, notBadUp.body);
      const notBadStoredName = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [notBadUp.body.photo.id]))[0].stored_name;
      const notBadPath = path.join(f.dir, 'sheet-photos', notBadStoredName);
      check('L9准备:非异常项pending文件确实落盘', fs.existsSync(notBadPath));
      const saveNoActivate = await f.api('PUT', '/inspections/sheets/' + s2.id, { expected_version: revertNormal.body.version, items: [] }, 2);
      check('P2保存修改200(非异常pending应丢弃)', saveNoActivate.status === 200, saveNoActivate.body);
      const notBadPhotoRow = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [notBadUp.body.photo.id]);
      check('P2非异常项pending已被丢弃(行不存在)', notBadPhotoRow.length === 0, notBadPhotoRow);
      check('P2非异常项pending丢弃不进diff(版本未变=没有变化)', saveNoActivate.body.version === revertNormal.body.version, { before: revertNormal.body.version, after: saveNoActivate.body.version });
      // C2c L9：pending_not_abnormal丢弃后，文件与清理队列也该被处理干净（不只是行没了）。
      await waitFor(() => !fs.existsSync(notBadPath), { label: 'L9非异常pending文件被清理' });
      check('L9非异常项pending丢弃后文件不在磁盘', !fs.existsSync(notBadPath));
      const notBadQueueRow = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [notBadStoredName]); return rows.length === 0 ? rows : null; }, { label: 'L9非异常pending队列清空' });
      check('L9非异常项pending丢弃后清理队列不留残留', notBadQueueRow.length === 0, notBadQueueRow);

      // 放弃修改：上传两张pending后一次性丢弃
      const p1 = await uploadPhoto(f, s2.id, 'rack_front', rackId, 2, { bytes: MIN_PNG_BYTES, filename: 'discard1.png', mime: 'image/png' });
      const p2b = await uploadPhoto(f, s2.id, 'item', lightsItem.id, 2, { bytes: MIN_WEBP_BYTES, filename: 'discard2.webp', mime: 'image/webp' });
      check('P2放弃修改前两张pending上传201', p1.status === 201 && p2b.status === 201, { p1: p1.body, p2b: p2b.body });
      const discardResp = await discardPendingPhotos(f, s2.id, 2);
      check('P2放弃修改200且discarded=2', discardResp.status === 200 && discardResp.body.discarded === 2, discardResp.body);
      const afterDiscard = await getSheetAs(f, s2.id, 2);
      check('P2放弃修改后my_pending_photos为空', afterDiscard.body.my_pending_photos.length === 0, afterDiscard.body.my_pending_photos);
    }

    // ============================================================
    // 3) 保存修改七步——版本冲突、重读回滚、diff以落库值为准、两人pending互不影响
    // ============================================================
    {
      const s3 = await buildSubmittedSheet(f, 'P3-SevenSteps', 2);
      const wrongVersionSave = await f.api('PUT', '/inspections/sheets/' + s3.id, { expected_version: s3.version + 999, items: [] }, 2);
      check('P3步骤1版本冲突409', wrongVersionSave.status === 409 && wrongVersionSave.body.code === 'SHEET_VERSION_CONFLICT', wrongVersionSave.body);

      // 步骤6回滚：标异常但不传照片 -> 400，且重读后该项result/note未变(整事务回滚)
      const detail3 = await getSheetAs(f, s3.id, 2);
      const doorItem3 = detail3.body.items.find((it) => it.item_key === 'door');
      const beforeRow = (await f.all('SELECT result,note FROM it_inspection_sheet_items WHERE id=?', [doorItem3.id]))[0];
      // C2c L3：回滚用例再带一张 rack_front pending——400 之后 pending 应仍是 pending(整事务回滚
      // 连第4步已经做的"激活"也一起撤销)，原 active 不该变成 superseded，清理队列不该多出行。
      const rackFrontActiveBefore = (await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND state='active'", [s3.id]))[0];
      const pendingBeforeRollback = await uploadPhoto(f, s3.id, 'rack_front', s3.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'l3-pending.png', mime: 'image/png' });
      check('L3回滚前置:rack_front pending上传201', pendingBeforeRollback.status === 201 && pendingBeforeRollback.body.photo.state === 'pending', pendingBeforeRollback.body);
      const queueCountBeforeRollback = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      // C2d T-M7：只比总数不够——总数不变也可能是"删了一行又加了一行"这种净零的伪装，改比id与
      // stored_name的完整集合（排序后全等），才是真的"一行都没动过"。
      const queueRowsBeforeRollback = await f.all('SELECT id, stored_name FROM it_inspection_file_cleanup ORDER BY id');
      const incompleteSave = await f.api('PUT', '/inspections/sheets/' + s3.id, { expected_version: s3.version, items: [{ id: doorItem3.id, result: 'bad', number_value: null, note: '缺照片测试' }] }, 2);
      check('P3步骤6不完整400 SHEET_INCOMPLETE', incompleteSave.status === 400 && incompleteSave.body.code === 'SHEET_INCOMPLETE', incompleteSave.body);
      check('P3步骤6回滚:missing_photo_positions含该item', incompleteSave.body.detail.missing_photo_positions.some((p) => p.slot === 'item' && p.target_id === doorItem3.id), incompleteSave.body.detail);
      const afterRollbackRow = (await f.all('SELECT result,note FROM it_inspection_sheet_items WHERE id=?', [doorItem3.id]))[0];
      check('P3步骤6回滚:item result未变(整事务回滚)', afterRollbackRow.result === beforeRow.result && afterRollbackRow.note === beforeRow.note, { beforeRow, afterRollbackRow });
      const sheetVersionAfterRollback = await currentVersionAs(f, s3.id);
      check('P3步骤6回滚:单据版本未变', sheetVersionAfterRollback === s3.version, { expect: s3.version, got: sheetVersionAfterRollback });
      const pendingRowAfterRollback = (await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [pendingBeforeRollback.body.photo.id]))[0];
      check('L3回滚后:pending仍是pending(第4步的激活被整事务回滚撤销)', pendingRowAfterRollback && pendingRowAfterRollback.state === 'pending', pendingRowAfterRollback);
      check('T-M7回滚后:pending照片文件仍在磁盘(没被误当废弃清掉)', !!pendingRowAfterRollback && fs.existsSync(path.join(f.dir, 'sheet-photos', pendingRowAfterRollback.stored_name)), pendingRowAfterRollback);
      const rackFrontActiveAfter = (await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND state='active'", [s3.id]))[0];
      check('L3回滚后:原active照片未变superseded', rackFrontActiveAfter && rackFrontActiveAfter.id === rackFrontActiveBefore.id && rackFrontActiveAfter.state === 'active', { rackFrontActiveBefore, rackFrontActiveAfter });
      const queueCountAfterRollback = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      check('L3回滚后:清理队列未增行', queueCountAfterRollback === queueCountBeforeRollback, { queueCountBeforeRollback, queueCountAfterRollback });
      const queueRowsAfterRollback = await f.all('SELECT id, stored_name FROM it_inspection_file_cleanup ORDER BY id');
      check('T-M7回滚后:清理队列的id与stored_name集合与回滚前逐行全等(不只总数)', JSON.stringify(queueRowsAfterRollback) === JSON.stringify(queueRowsBeforeRollback), { before: queueRowsBeforeRollback, after: queueRowsAfterRollback });
      // 收尾：丢弃这张pending，避免影响后面同一张单的其它断言。
      const discardL3 = await discardPendingPhotos(f, s3.id, 2);
      check('L3收尾:丢弃刚才那张pending200', discardL3.status === 200 && discardL3.body.discarded === 1, discardL3.body);

      // diff以落库值为准：提交完全相同的值 -> 空diff、不写日志、版本不变
      const sameValueSave = await f.api('PUT', '/inspections/sheets/' + s3.id, { expected_version: s3.version, items: [{ id: doorItem3.id, result: 'ok', number_value: null, note: null }] }, 2);
      check('P3相同值保存200且版本不变(空diff不写日志)', sameValueSave.status === 200 && sameValueSave.body.version === s3.version, sameValueSave.body);
      const editLogsAfterSameValue = sameValueSave.body.log.filter((l) => l.action === 'edit');
      check('P3相同值保存无新edit日志', editLogsAfterSameValue.length === 0, editLogsAfterSameValue);

      // 两人各自pending互不影响；后保存者409
      const s3b = await buildSubmittedSheet(f, 'P3-TwoUsers', 2);
      const vBase = await currentVersionAs(f, s3b.id);
      const uid2Upload = await uploadPhoto(f, s3b.id, 'rack_front', s3b.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'u2.png', mime: 'image/png' }); // uid2 pending
      const uid1Upload = await uploadPhoto(f, s3b.id, 'rack_front', s3b.scope.racks[0].id, 1, { bytes: MIN_WEBP_BYTES, filename: 'u1.webp', mime: 'image/webp' }); // uid1(admin) pending, 同位置各自独立
      const uid2Save = await f.api('PUT', '/inspections/sheets/' + s3b.id, { expected_version: vBase, items: [] }, 2);
      check('P3两人各自pending-uid2先保存200', uid2Save.status === 200 && uid2Save.body.version === vBase + 1, uid2Save.body);
      const uid1SaveStale = await f.api('PUT', '/inspections/sheets/' + s3b.id, { expected_version: vBase, items: [] }, 1);
      check('P3两人各自pending-uid1后保存(过期版本)409', uid1SaveStale.status === 409 && uid1SaveStale.body.code === 'SHEET_VERSION_CONFLICT', uid1SaveStale.body);
      const detailAfterUid2Save = await getSheetAs(f, s3b.id, 1);
      check('P3uid1的pending未受uid2保存影响(仍在自己的my_pending_photos)', detailAfterUid2Save.body.my_pending_photos.length === 1, detailAfterUid2Save.body.my_pending_photos);
      // C2c L4：uid2生效后，rack_front的active此刻就是uid2Upload那张照片。
      const uid2ActiveAfterOwnSave = (await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND id=? AND state='active'", [s3b.id,uid2Upload.body.photo.id]))[0];
      check('L4 uid2保存后active是uid2自己上传的那张', uid2ActiveAfterOwnSave.id === uid2Upload.body.photo.id, { uid2ActiveAfterOwnSave, uid2UploadId: uid2Upload.body.photo.id });
      const uid1SaveRetry = await f.api('PUT', '/inspections/sheets/' + s3b.id, { expected_version: uid2Save.body.version, items: [] }, 1);
      check('P3uid1用最新版本重试200', uid1SaveRetry.status === 200, uid1SaveRetry.body);
      // C2c L4：uid1重试成功后，uid1的照片变active，uid2那张(刚才的active)转superseded且
      // superseded_by正确；diff里的photo条目before/after_photo_id对应这次真正生效的转换。
      const uid1ActiveAfterRetry = (await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [uid1Upload.body.photo.id]))[0];
      check('L4 uid1重试成功后自己的照片变active', uid1ActiveAfterRetry.state === 'active', uid1ActiveAfterRetry);
      const uid2Superseded = (await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [uid2Upload.body.photo.id]))[0];
      check('L4 uid1追加不会替换uid2已保存的照片', uid2Superseded.state === 'active' && uid2Superseded.superseded_by === null, uid2Superseded);
      const uid1RetryPhotoDiff = uid1SaveRetry.body.log.filter((l) => l.action === 'edit').slice(-1)[0].diff.find((d) => d.kind === 'photo');
      check('L4 diff记录uid1追加且不虚构替换关系', uid1RetryPhotoDiff && uid1RetryPhotoDiff.before_photo_id === null && uid1RetryPhotoDiff.after_photo_id === uid1Upload.body.photo.id, uid1RetryPhotoDiff);
    }

    // ============================================================
    // C2c H1：已提交单保存修改的检查项/备注diff——只改note/只改remark/只改number_value（都不带
    // 照片），diff与手写期望数组全等；另加两人持同一版本先后保存(后者409)且不涉及照片。
    // ============================================================
    {
      const sH1a = await buildSubmittedSheet(f, 'H1-NoteOnly', 2);
      const detailH1a = await getSheetAs(f, sH1a.id, 2);
      const doorH1a = detailH1a.body.items.find((it) => it.item_key === 'door');
      const editH1a = await f.api('PUT', '/inspections/sheets/' + sH1a.id, { expected_version: sH1a.version, items: [{ id: doorH1a.id, result: 'ok', number_value: null, note: '只改说明' }] }, 2);
      check('H1只改note:200且version+1且unchanged=false', editH1a.status === 200 && editH1a.body.version === sH1a.version + 1 && editH1a.body.unchanged === false, editH1a.body);
      const editLogH1a = editH1a.body.log.filter((l) => l.action === 'edit');
      check('H1只改note:edit日志恰多1行', editLogH1a.length === 1, editLogH1a);
      const expectedDiffH1a = [{ kind: 'item', item_id: doorH1a.id, label: doorH1a.target_label + ' · ' + doorH1a.item_label, field: 'note', before: null, after: '只改说明' }];
      check('H1只改note:diff与手写期望全等', JSON.stringify(editLogH1a[0].diff) === JSON.stringify(expectedDiffH1a), { got: editLogH1a[0].diff, expected: expectedDiffH1a });
      const listH1a = await f.api('GET', '/inspections/sheets?room=H1-NoteOnly', undefined, 2);
      check('H1只改note:列表edit_count为1', listH1a.body.items[0].edit_count === 1, listH1a.body.items[0]);

      const sH1b = await buildSubmittedSheet(f, 'H1-RemarkOnly', 2);
      const editH1b = await f.api('PUT', '/inspections/sheets/' + sH1b.id, { expected_version: sH1b.version, items: [], remark: '只改备注' }, 2);
      check('H1只改remark:200且version+1且unchanged=false', editH1b.status === 200 && editH1b.body.version === sH1b.version + 1 && editH1b.body.unchanged === false, editH1b.body);
      const editLogH1b = editH1b.body.log.filter((l) => l.action === 'edit');
      check('H1只改remark:edit日志恰多1行', editLogH1b.length === 1, editLogH1b);
      const expectedDiffH1b = [{ kind: 'remark', before: null, after: '只改备注' }];
      check('H1只改remark:diff与手写期望全等', JSON.stringify(editLogH1b[0].diff) === JSON.stringify(expectedDiffH1b), { got: editLogH1b[0].diff, expected: expectedDiffH1b });
      const listH1b = await f.api('GET', '/inspections/sheets?room=H1-RemarkOnly', undefined, 2);
      check('H1只改remark:列表edit_count为1', listH1b.body.items[0].edit_count === 1, listH1b.body.items[0]);

      const sH1c = await buildSubmittedSheet(f, 'H1-NumberOnly', 2);
      const detailH1c = await getSheetAs(f, sH1c.id, 2);
      const tempH1c = detailH1c.body.items.find((it) => it.item_key === 'temperature');
      const editH1c = await f.api('PUT', '/inspections/sheets/' + sH1c.id, { expected_version: sH1c.version, items: [{ id: tempH1c.id, result: null, number_value: 19, note: null }] }, 2);
      check('H1只改number_value:200且version+1且unchanged=false', editH1c.status === 200 && editH1c.body.version === sH1c.version + 1 && editH1c.body.unchanged === false, editH1c.body);
      const editLogH1c = editH1c.body.log.filter((l) => l.action === 'edit');
      check('H1只改number_value:edit日志恰多1行', editLogH1c.length === 1, editLogH1c);
      const expectedDiffH1c = [{ kind: 'item', item_id: tempH1c.id, label: tempH1c.target_label + ' · ' + tempH1c.item_label, field: 'number_value', before: NUMBER_DEFAULT.temperature, after: 19 }];
      check('H1只改number_value:diff与手写期望全等', JSON.stringify(editLogH1c[0].diff) === JSON.stringify(expectedDiffH1c), { got: editLogH1c[0].diff, expected: expectedDiffH1c });
      const listH1c = await f.api('GET', '/inspections/sheets?room=H1-NumberOnly', undefined, 2);
      check('H1只改number_value:列表edit_count为1', listH1c.body.items[0].edit_count === 1, listH1c.body.items[0]);

      // C2c L2：空diff保存返回unchanged=true。
      const sH1e = await buildSubmittedSheet(f, 'H1-Unchanged', 2);
      const noopH1e = await f.api('PUT', '/inspections/sheets/' + sH1e.id, { expected_version: sH1e.version, items: [] }, 2);
      check('H1空更新200且unchanged=true且version不变', noopH1e.status === 200 && noopH1e.body.unchanged === true && noopH1e.body.version === sH1e.version, noopH1e.body);

      // 两人持同一版本先后保存，后者409（不涉及照片）
      const sH1d = await buildSubmittedSheet(f, 'H1-TwoUsersConflict', 2);
      const vH1d = sH1d.version;
      const detailH1d = await getSheetAs(f, sH1d.id, 2);
      const doorH1d = detailH1d.body.items.find((it) => it.item_key === 'door');
      const firstSave = await f.api('PUT', '/inspections/sheets/' + sH1d.id, { expected_version: vH1d, items: [{ id: doorH1d.id, result: 'ok', number_value: null, note: '第一次保存' }] }, 2);
      check('H1两人冲突:先保存者200', firstSave.status === 200 && firstSave.body.version === vH1d + 1, firstSave.body);
      const secondSave = await f.api('PUT', '/inspections/sheets/' + sH1d.id, { expected_version: vH1d, items: [], remark: '第二次保存(过期版本)' }, 1);
      check('H1两人冲突:后保存者409 SHEET_VERSION_CONFLICT(不涉及照片)', secondSave.status === 409 && secondSave.body.code === 'SHEET_VERSION_CONFLICT', secondSave.body);
    }

    // ============================================================
    // C2d T-H4：diff以落库值为准——用AFTER UPDATE触发器模拟"落库值与请求值不同"（DB层另有规则改写
    // 了值），断言edit日志diff的after取的是保存后重读的落库值，不是请求体里原样传入的值（如果实现
    // 图省事直接把请求值塞进diff.after而不重读，这里就测不出来）。
    // ============================================================
    {
      const sH4t = await buildSubmittedSheet(f, 'H4T-TriggerRewrite', 2);
      const detailH4t = await getSheetAs(f, sH4t.id, 2);
      const doorH4t = detailH4t.body.items.find((it) => it.item_key === 'door');
      await f.run("CREATE TRIGGER trg_th4_note_rewrite AFTER UPDATE OF note ON it_inspection_sheet_items WHEN NEW.note='T-H4请求值' BEGIN UPDATE it_inspection_sheet_items SET note='T-H4触发器改写值' WHERE id=NEW.id; END");
      try {
        const editH4t = await f.api('PUT', '/inspections/sheets/' + sH4t.id, { expected_version: sH4t.version, items: [{ id: doorH4t.id, result: 'ok', number_value: null, note: 'T-H4请求值' }] }, 2);
        check('T-H4触发器改写场景:200', editH4t.status === 200, editH4t.body);
        const editLogH4t = editH4t.body.log.filter((l) => l.action === 'edit');
        const diffEntryH4t = editLogH4t[0] && editLogH4t[0].diff.find((d) => d.kind === 'item' && d.item_id === doorH4t.id && d.field === 'note');
        check('T-H4 diff.after取的是触发器改写后的落库值,不是原样请求值', !!diffEntryH4t && diffEntryH4t.after === 'T-H4触发器改写值', diffEntryH4t);
        const dbRowH4t = (await f.all('SELECT note FROM it_inspection_sheet_items WHERE id=?', [doorH4t.id]))[0];
        check('T-H4落库值确实是触发器改写后的值(独立SQL核对,不是巧合)', dbRowH4t.note === 'T-H4触发器改写值', dbRowH4t);
      } finally {
        await f.run('DROP TRIGGER trg_th4_note_rewrite');
      }
    }

    // ============================================================
    // C2d T-H3：四处口径交叉——同一张已提交单构造「缺一张机柜正面照+一个异常项缺照片」（直接SQL
    // 删除两处active行，绕开正常写路径，制造"照片本该有但没有"的场景），断言列表/详情的
    // photos_expected/photos_uploaded一致且精确，保存修改400且missing_photo_positions精确包含
    // 两处、且整个事务回滚（remark/version都没被那次失败的保存改动）。
    // ============================================================
    {
      const sH3 = await buildSubmittedSheet(f, 'H3-CrossCheck', 2);
      const rackIdH3 = sH3.scope.racks[0].id;
      const detailH3a = await getSheetAs(f, sH3.id, 2);
      const doorH3 = detailH3a.body.items.find((it) => it.item_key === 'door');
      const pendingDoorH3 = await uploadPhoto(f, sH3.id, 'item', doorH3.id, 2, { bytes: MIN_PNG_BYTES, filename: 'h3-door.png', mime: 'image/png' });
      check('T-H3准备:door项pending照片201', pendingDoorH3.status === 201, pendingDoorH3.body);
      const activateH3 = await f.api('PUT', '/inspections/sheets/' + sH3.id, { expected_version: sH3.version, items: [{ id: doorH3.id, result: 'bad', number_value: null, note: 'T-H3异常项' }] }, 2);
      check('T-H3准备:标异常并生效为active照片200', activateH3.status === 200, activateH3.body);
      // 直接SQL删除两处active行，模拟"照片本该在、但实际不在"（绕开正常写路径，接口不可达状态）。
      // 先记下这两行的stored_name——直接删DB行不会连带删磁盘文件/入清理队列，用完这两个用例后要
      // 自己把物理文件也清掉，不然会在这个共享fixture的目录里留下真正的孤儿文件，污染后面P7那条
      // "目录扫描确认没有孤儿文件"的断言（该断言按当前全部stored_name做全目录扫描，不是只看本次
      // 动作新增的文件）。
      const rackFrontStoredH3 = (await f.all("SELECT stored_name FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND target_id=? AND state='active'", [sH3.id, rackIdH3]))[0].stored_name;
      const itemStoredH3 = (await f.all("SELECT stored_name FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='item' AND target_id=? AND state='active'", [sH3.id, doorH3.id]))[0].stored_name;
      await f.run("DELETE FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND target_id=? AND state='active'", [sH3.id, rackIdH3]);
      await f.run("DELETE FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='item' AND target_id=? AND state='active'", [sH3.id, doorH3.id]);

      const listH3 = await f.api('GET', '/inspections/sheets?room=H3-CrossCheck', undefined, 2);
      const rowH3 = listH3.body.items.find((x) => x.id === sH3.id);
      check('T-H3列表:目标行存在', !!rowH3, listH3.body);
      check('T-H3列表:photos_expected精确为2(1机柜+1异常项)', rowH3.photos_expected === 2, rowH3);
      check('T-H3列表:photos_uploaded精确为0(两处active都被删)', rowH3.photos_uploaded === 0, rowH3);

      const detailH3b = await getSheetAs(f, sH3.id, 2);
      check('T-H3详情:progress.photosExpected精确为2且与列表一致', detailH3b.body.progress.photosExpected === 2 && detailH3b.body.progress.photosExpected === rowH3.photos_expected, detailH3b.body.progress);
      check('T-H3详情:progress.photosUploaded精确为0且与列表一致', detailH3b.body.progress.photosUploaded === 0 && detailH3b.body.progress.photosUploaded === rowH3.photos_uploaded, detailH3b.body.progress);
      const posH3 = detailH3b.body.progress.missing.missingPhotoPositions;
      check('T-H3详情:missingPhotoPositions精确含两处(rack_front+item)', posH3.length === 2 && posH3.some((p) => p.slot === 'rack_front' && p.target_id === rackIdH3) && posH3.some((p) => p.slot === 'item' && p.target_id === doorH3.id), posH3);

      const remarkBeforeH3 = (await f.all('SELECT remark, version FROM it_inspection_sheets WHERE id=?', [sH3.id]))[0];
      const saveH3 = await f.api('PUT', '/inspections/sheets/' + sH3.id, { expected_version: activateH3.body.version, items: [], remark: 'T-H3不该生效的备注改动' }, 2);
      check('T-H3保存修改400 SHEET_INCOMPLETE', saveH3.status === 400 && saveH3.body.code === 'SHEET_INCOMPLETE', saveH3.body);
      const posH3b = saveH3.body.detail.missing_photo_positions;
      check('T-H3保存修改400的missing_photo_positions精确含两处', Array.isArray(posH3b) && posH3b.length === 2 && posH3b.some((p) => p.slot === 'rack_front' && p.target_id === rackIdH3) && posH3b.some((p) => p.slot === 'item' && p.target_id === doorH3.id), posH3b);
      const remarkAfterH3 = (await f.all('SELECT remark, version FROM it_inspection_sheets WHERE id=?', [sH3.id]))[0];
      check('T-H3事务回滚:remark未被那次失败的保存改动', remarkAfterH3.remark === remarkBeforeH3.remark, { before: remarkBeforeH3, after: remarkAfterH3 });
      check('T-H3事务回滚:version未被那次失败的保存改动', remarkAfterH3.version === remarkBeforeH3.version, { before: remarkBeforeH3, after: remarkAfterH3 });
      // 用例结束，清掉直接SQL删行留下的两个真孤儿文件，不污染后面的目录扫描类断言（P7）。
      for (const sn of [rackFrontStoredH3, itemStoredH3]) {
        try { fs.unlinkSync(path.join(f.dir, 'sheet-photos', sn)); } catch (_e) { /* 不存在也无妨 */ }
      }
    }

    // ============================================================
    // C2c M4：放弃修改的判别力——调用前让另一用户在同单也有1张pending，断言调用者丢弃数正确且
    // 另一用户那张仍是pending（直接查库）。
    // ============================================================
    {
      const sM4 = await buildSubmittedSheet(f, 'M4-DiscardJudgement', 2);
      const rackIdM4 = sM4.scope.racks[0].id;
      const myPending = await uploadPhoto(f, sM4.id, 'rack_front', rackIdM4, 2, { bytes: MIN_PNG_BYTES, filename: 'm4-mine.png', mime: 'image/png' });
      check('M4我方pending上传201', myPending.status === 201, myPending.body);
      const detailM4 = await getSheetAs(f, sM4.id, 2);
      const doorM4 = detailM4.body.items.find((it) => it.item_key === 'door');
      const otherPending = await uploadPhoto(f, sM4.id, 'item', doorM4.id, 1, { bytes: MIN_WEBP_BYTES, filename: 'm4-other.webp', mime: 'image/webp' });
      check('M4另一用户(管理员)pending上传201', otherPending.status === 201 && otherPending.body.photo.state === 'pending', otherPending.body);
      const discardM4 = await discardPendingPhotos(f, sM4.id, 2);
      check('M4放弃修改200且丢弃数为1(只丢自己的)', discardM4.status === 200 && discardM4.body.discarded === 1, discardM4.body);
      const myPendingRowAfter = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [myPending.body.photo.id]);
      check('M4我方pending行已被丢弃', myPendingRowAfter.length === 0, myPendingRowAfter);
      const otherPendingRowAfter = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [otherPending.body.photo.id]);
      check('M4另一用户pending仍在(未被误丢,直接查库)', otherPendingRowAfter.length === 1 && otherPendingRowAfter[0].state === 'pending', otherPendingRowAfter);
    }

    // ============================================================
    // C2c M5：草稿物理删除与单张删除成功路径——三例，各断言照片行0/文件不在/清理队列清空
    // ============================================================
    {
      const sM5a = await buildDraftSheet(f, 'M5-DraftDelete', 2);
      const upM5a = await uploadPhoto(f, sM5a.id, 'rack_front', sM5a.scope.racks[0].id, 2, { bytes: MIN_JPEG_BYTES, filename: 'm5a.jpg' });
      check('M5a草稿照片上传201', upM5a.status === 201, upM5a.body);
      const storedM5a = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upM5a.body.photo.id]))[0].stored_name;
      const pathM5a = path.join(f.dir, 'sheet-photos', storedM5a);
      const delM5a = await f.api('DELETE', '/inspections/sheets/' + sM5a.id, { expected_version: sM5a.version }, 2);
      check('M5a草稿物理删除200', delM5a.status === 200, delM5a.body);
      const rowsM5a = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=?', [sM5a.id]);
      check('M5a删除后照片行为0', rowsM5a.length === 0, rowsM5a);
      await waitFor(() => !fs.existsSync(pathM5a), { label: 'M5a文件被清理' });
      check('M5a文件不在磁盘', !fs.existsSync(pathM5a));
      const queueM5a = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedM5a]); return rows.length === 0 ? rows : null; }, { label: 'M5a队列清空' });
      check('M5a清理队列不留残留', queueM5a.length === 0, queueM5a);

      const sM5b = await buildDraftSheet(f, 'M5-SinglePhotoDelete', 2);
      const upM5b = await uploadPhoto(f, sM5b.id, 'rack_front', sM5b.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'm5b.png', mime: 'image/png' });
      check('M5b草稿照片上传201', upM5b.status === 201, upM5b.body);
      const storedM5b = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upM5b.body.photo.id]))[0].stored_name;
      const pathM5b = path.join(f.dir, 'sheet-photos', storedM5b);
      const delPhotoM5b = await deletePhoto(f, sM5b.id, upM5b.body.photo.id, 2);
      check('M5b删单张照片200', delPhotoM5b.status === 200, delPhotoM5b.body);
      const rowsM5b = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [upM5b.body.photo.id]);
      check('M5b删除后照片行为0', rowsM5b.length === 0, rowsM5b);
      await waitFor(() => !fs.existsSync(pathM5b), { label: 'M5b文件被清理' });
      check('M5b文件不在磁盘', !fs.existsSync(pathM5b));
      const queueM5b = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedM5b]); return rows.length === 0 ? rows : null; }, { label: 'M5b队列清空' });
      check('M5b清理队列不留残留', queueM5b.length === 0, queueM5b);

      const sM5c = await buildSubmittedSheet(f, 'M5-SubmittedOwnPending', 2);
      const upM5c = await uploadPhoto(f, sM5c.id, 'rack_front', sM5c.scope.racks[0].id, 2, { bytes: MIN_WEBP_BYTES, filename: 'm5c.webp', mime: 'image/webp' });
      check('M5c已提交单pending上传201', upM5c.status === 201 && upM5c.body.photo.state === 'pending', upM5c.body);
      const storedM5c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upM5c.body.photo.id]))[0].stored_name;
      const pathM5c = path.join(f.dir, 'sheet-photos', storedM5c);
      const delPhotoM5c = await deletePhoto(f, sM5c.id, upM5c.body.photo.id, 2);
      check('M5c删除自己的pending200', delPhotoM5c.status === 200, delPhotoM5c.body);
      const rowsM5c = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [upM5c.body.photo.id]);
      check('M5c删除后行为0', rowsM5c.length === 0, rowsM5c);
      await waitFor(() => !fs.existsSync(pathM5c), { label: 'M5c文件被清理' });
      check('M5c文件不在磁盘', !fs.existsSync(pathM5c));
      const queueM5c = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedM5c]); return rows.length === 0 ? rows : null; }, { label: 'M5c队列清空' });
      check('M5c清理队列不留残留', queueM5c.length === 0, queueM5c);
    }

    // ============================================================
    // C2c M6：列表照片计数——1柜已传+1异常项(直接SQL构造)未传+1张pending，断言列表
    // photos_expected/photos_uploaded精确值。
    // ============================================================
    {
      const sM6 = await buildSubmittedSheet(f, 'M6-ListPhotoCount', 2); // 已有1个active rack_front照片
      const detailM6 = await getSheetAs(f, sM6.id, 1);
      const doorM6 = detailM6.body.items.find((it) => it.item_key === 'door');
      // 直接SQL把door标记为异常(绕开完整性校验，构造"异常项缺照片"这个接口到不了的状态)。
      await f.run("UPDATE it_inspection_sheet_items SET result='bad', note='M6异常(直接构造)' WHERE id=?", [doorM6.id]);
      const pendingM6 = await uploadPhoto(f, sM6.id, 'rack_front', sM6.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'm6pending.png', mime: 'image/png' });
      check('M6 pending照片上传201', pendingM6.status === 201 && pendingM6.body.photo.state === 'pending', pendingM6.body);
      const listM6 = await f.api('GET', '/inspections/sheets?room=M6-ListPhotoCount', undefined, 2);
      const rowM6 = listM6.body.items.find((x) => x.id === sM6.id);
      check('M6列表photos_expected精确为2(1机柜+1异常项)', rowM6.photos_expected === 2, rowM6);
      check('M6列表photos_uploaded精确为1(机柜active已传;异常项door未传;pending不计入)', rowM6.photos_uploaded === 1, rowM6);
    }

    // ============================================================
    // 4) 完整性：缺机柜照不能提交；异常项缺照片不能提交；草稿里正常项传的照片提交后被删除入队
    // ============================================================
    {
      const s4a = await buildDraftSheet(f, 'P4-MissingRackPhoto', 2);
      const detail4a = await getSheetAs(f, s4a.id, 2);
      const put4a = await f.api('PUT', '/inspections/sheets/' + s4a.id, { expected_version: s4a.version, items: fillPayloadAllOk(detail4a.body.items, NUMBER_DEFAULT) }, 2);
      const submit4a = await f.api('POST', '/inspections/sheets/' + s4a.id + '/submit', { expected_version: put4a.body.version }, 2);
      check('P4缺机柜照不能提交400', submit4a.status === 400 && submit4a.body.code === 'SHEET_INCOMPLETE' && submit4a.body.detail.missing_photo_positions.some((p) => p.slot === 'rack_front'), submit4a.body);

      const s4b = await buildDraftSheet(f, 'P4-AbnormalNoPhoto', 2);
      const detail4b = await getSheetAs(f, s4b.id, 2);
      const doorItem4b = detail4b.body.items.find((it) => it.item_key === 'door');
      const fill4b = fillPayloadAllOk(detail4b.body.items, NUMBER_DEFAULT).map((it) => (it.id === doorItem4b.id ? { ...it, result: 'bad', note: 'P4异常无照片' } : it));
      const put4b = await f.api('PUT', '/inspections/sheets/' + s4b.id, { expected_version: s4b.version, items: fill4b }, 2);
      await uploadAllRackFrontPhotos(f, s4b.id, s4b.scope, 2);
      const submit4b = await f.api('POST', '/inspections/sheets/' + s4b.id + '/submit', { expected_version: put4b.body.version }, 2);
      check('P4异常项缺照片不能提交400', submit4b.status === 400 && submit4b.body.code === 'SHEET_INCOMPLETE' && submit4b.body.detail.missing_photo_positions.some((p) => p.slot === 'item' && p.target_id === doorItem4b.id), submit4b.body);

      const s4c = await buildDraftSheet(f, 'P4-NormalItemPhotoPruned', 2);
      const detail4c = await getSheetAs(f, s4c.id, 2);
      const lightsItem4c = detail4c.body.items.find((it) => it.item_key === 'lights');
      const stray = await uploadPhoto(f, s4c.id, 'item', lightsItem4c.id, 2);
      check('P4草稿里给正常项传照片201(先传后标允许)', stray.status === 201, stray.body);
      const put4c = await f.api('PUT', '/inspections/sheets/' + s4c.id, { expected_version: s4c.version, items: fillPayloadAllOk(detail4c.body.items, NUMBER_DEFAULT) }, 2);
      await uploadAllRackFrontPhotos(f, s4c.id, s4c.scope, 2);
      const submit4c = await f.api('POST', '/inspections/sheets/' + s4c.id + '/submit', { expected_version: put4c.body.version }, 2);
      check('P4正常项有多余照片仍可提交200', submit4c.status === 200, submit4c.body);
      const strayRowAfter = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [stray.body.photo.id]);
      check('P4提交后正常项多余照片已删除入队并清理(行不存在)', strayRowAfter.length === 0, strayRowAfter);
    }

    // ============================================================
    // 5) 重复提示：full可见给单据信息；summary/none只给restricted_match；pending不参与；本单内不比对
    // ============================================================
    {
      const dupBytesFull = Buffer.concat([MIN_JPEG_BYTES, Buffer.from('full-visible-marker')]);
      const sA = await buildSubmittedSheet(f, 'P5-FullVisible-A', 2);
      // sA已在buildSubmittedSheet里传了rack_front(不同字节)；额外传一张已知字节的item照片到一个bad项上
      const detailA = await getSheetAs(f, sA.id, 2);
      const doorA = detailA.body.items.find((it) => it.item_key === 'door');
      // 先传pending照片，再一次PUT里同时标bad+让第4步激活它——不能先标bad再传照片：标bad那次PUT
      // 因为当时还没有该item的照片，第6步完整性检查会先拦下(与P3步骤6同款)。
      const upA = await uploadPhoto(f, sA.id, 'item', doorA.id, 2, { bytes: dupBytesFull });
      check('P5-A准备:item照片上传201(pending,先不激活)', upA.status === 201, upA.body);
      const activateA = await f.api('PUT', '/inspections/sheets/' + sA.id, { expected_version: sA.version, items: [{ id: doorA.id, result: 'bad', number_value: null, note: 'P5异常A' }] }, 2);
      check('P5-A准备:标异常并生效为active照片200', activateA.status === 200, activateA.body);

      const sB = await buildDraftSheet(f, 'P5-FullVisible-B', 2);
      const dupCheckFull = await uploadPhoto(f, sB.id, 'rack_front', sB.scope.racks[0].id, 2, { bytes: dupBytesFull });
      check('P5相同字节上传到B成功201', dupCheckFull.status === 201, dupCheckFull.body);
      check('P5-B full可见命中A', dupCheckFull.body.duplicate_of.matches.some((m) => m.sheet_id === sA.id), dupCheckFull.body.duplicate_of);
      check('P5-B duplicate_of不含restricted_match(命中的是自己可见的单)', dupCheckFull.body.duplicate_of.restricted_match === false, dupCheckFull.body.duplicate_of);
      // C2d T-H5：full命中逐字段精确断言，不只断言"命中了"——sheet_id/at/photo_state/sheet_deleted
      // 四个字段都与独立SQL读出的落库真值全等（at=submitted_at||created_at，findDuplicateMatches
      // 实现同款口径）。
      {
        const sARow = (await f.all('SELECT submitted_at, created_at FROM it_inspection_sheets WHERE id=?', [sA.id]))[0];
        const matchA = dupCheckFull.body.duplicate_of.matches.find((m) => m.sheet_id === sA.id);
        const expectedMatchA = { sheet_id: sA.id, at: sARow.submitted_at || sARow.created_at, photo_state: 'active', sheet_deleted: false };
        check('T-H5 full命中逐字段与落库真值全等(sheet_id/at/photo_state/sheet_deleted)', !!matchA && JSON.stringify(matchA) === JSON.stringify(expectedMatchA), { got: matchA, expected: expectedMatchA });
      }

      // 本单内不比对：B自己已经传了这张照片，再对B的另一个机柜(若只有1个机柜则用item)传同样字节，不应把B自己算进matches
      const detailB = await getSheetAs(f, sB.id, 2);
      const lightsB = detailB.body.items.find((it) => it.item_key === 'lights');
      const dupWithinB = await uploadPhoto(f, sB.id, 'item', lightsB.id, 2, { bytes: dupBytesFull });
      check('P5本单内不比对:matches不含B自己', !dupWithinB.body.duplicate_of.matches.some((m) => m.sheet_id === sB.id), dupWithinB.body.duplicate_of);

      // summary/none 受限：他人草稿
      const dupBytesRestricted = Buffer.concat([MIN_PNG_BYTES, Buffer.from('restricted-marker')]);
      const sOtherDraft = await buildDraftSheet(f, 'P5-OthersDraft', 5); // uid5拥有的草稿，对uid2是summary(ACL已在P1插入)
      const upOtherDraft = await uploadPhoto(f, sOtherDraft.id, 'rack_front', sOtherDraft.scope.racks[0].id, 5, { bytes: dupBytesRestricted, filename: 'r.png', mime: 'image/png' });
      check('P5他人草稿准备:上传201', upOtherDraft.status === 201, upOtherDraft.body);
      const sC = await buildDraftSheet(f, 'P5-RestrictedCheck-C', 2);
      const dupCheckRestricted = await uploadPhoto(f, sC.id, 'rack_front', sC.scope.racks[0].id, 2, { bytes: dupBytesRestricted, filename: 'r2.png', mime: 'image/png' });
      check('P5他人草稿命中只给restricted_match', dupCheckRestricted.body.duplicate_of.restricted_match === true && dupCheckRestricted.body.duplicate_of.matches.length === 0, dupCheckRestricted.body.duplicate_of);
      // C2d T-H5：summary/none受限场景——matches恰为空数组、restricted_match恰为true，且响应体里
      // (递归到所有嵌套层)不出现任何一个单据标识字段名，防止绕过matches直接在别的键上泄漏单据信息。
      {
        function deepKeys(obj, acc) { if (obj && typeof obj === 'object') { for (const k of Object.keys(obj)) { acc.push(k); deepKeys(obj[k], acc); } } return acc; }
        const restrictedKeys = deepKeys(dupCheckRestricted.body.duplicate_of, []);
        check('T-H5 summary/none:响应不含任何单据标识字段', !restrictedKeys.some((k) => ['sheet_id', 'at', 'photo_state', 'sheet_deleted'].includes(k)), restrictedKeys);
        check('T-H5 summary/none:matches为空数组且restricted_match恰为true', Array.isArray(dupCheckRestricted.body.duplicate_of.matches) && dupCheckRestricted.body.duplicate_of.matches.length === 0 && dupCheckRestricted.body.duplicate_of.restricted_match === true, dupCheckRestricted.body.duplicate_of);
      }

      // summary/none 受限：已删除单（非管理员）
      const dupBytesDeleted = Buffer.concat([MIN_WEBP_BYTES, Buffer.from('deleted-marker')]);
      const sDel = await buildSubmittedSheet(f, 'P5-DeletedSheet', 2);
      const upDel = await uploadPhoto(f, sDel.id, 'rack_front', sDel.scope.racks[0].id, 2, { bytes: dupBytesDeleted, filename: 'd.webp', mime: 'image/webp' });
      // 已提交单上传变pending，需保存修改生效才是active——直接改用管理员对未删除单再传一次覆盖简化：改走替换active
      const putForDelSheet = await f.api('PUT', '/inspections/sheets/' + sDel.id, { expected_version: sDel.version, items: [] }, 2);
      check('P5已删除单准备:保存修改(生效pending)200', putForDelSheet.status === 200, putForDelSheet.body);
      const delSheetVersion = putForDelSheet.body.version;
      const delResp5 = await f.api('DELETE', '/inspections/sheets/' + sDel.id, { expected_version: delSheetVersion, reason: 'P5测试删除' }, 2);
      check('P5已删除单准备:逻辑删除200', delResp5.status === 200, delResp5.body);
      void upDel;
      const sD = await buildDraftSheet(f, 'P5-RestrictedCheck-D', 2);
      const dupCheckDeletedAsOwner = await uploadPhoto(f, sD.id, 'rack_front', sD.scope.racks[0].id, 2, { bytes: dupBytesDeleted, filename: 'd2.webp', mime: 'image/webp' });
      check('P5已删除单(非管理员)命中只给restricted_match', dupCheckDeletedAsOwner.body.duplicate_of.restricted_match === true && dupCheckDeletedAsOwner.body.duplicate_of.matches.length === 0, dupCheckDeletedAsOwner.body.duplicate_of);
      const sE = await buildDraftSheet(f, 'P5-RestrictedCheck-E-Admin', 1);
      const dupCheckDeletedAsAdmin = await uploadPhoto(f, sE.id, 'rack_front', sE.scope.racks[0].id, 1, { bytes: dupBytesDeleted, filename: 'd3.webp', mime: 'image/webp' });
      check('P5已删除单管理员命中给完整信息且sheet_deleted=true', dupCheckDeletedAsAdmin.body.duplicate_of.matches.some((m) => m.sheet_id === sDel.id && m.sheet_deleted === true), dupCheckDeletedAsAdmin.body.duplicate_of);
      // C2d T-H5：已删除单管理员命中同样逐字段核对（photo_state 从独立SQL读真值，不假设）。
      {
        const delPhotoRow = (await f.all('SELECT state FROM it_inspection_sheet_photos WHERE id=?', [upDel.body.photo.id]))[0];
        const sDelRow = (await f.all('SELECT submitted_at, created_at FROM it_inspection_sheets WHERE id=?', [sDel.id]))[0];
        const delMatch = dupCheckDeletedAsAdmin.body.duplicate_of.matches.find((m) => m.sheet_id === sDel.id);
        const expectedDelMatch = { sheet_id: sDel.id, at: sDelRow.submitted_at || sDelRow.created_at, photo_state: delPhotoRow.state, sheet_deleted: true };
        check('T-H5 已删除单管理员命中逐字段与落库真值全等', !!delMatch && JSON.stringify(delMatch) === JSON.stringify(expectedDelMatch), { got: delMatch, expected: expectedDelMatch });
      }

      // pending不参与比对
      const dupBytesPendingOnly = Buffer.concat([MIN_JPEG_BYTES, Buffer.from('pending-only-marker')]);
      const sPendingHost = await buildSubmittedSheet(f, 'P5-PendingHost', 2);
      const upPendingOnly = await uploadPhoto(f, sPendingHost.id, 'rack_front', sPendingHost.scope.racks[0].id, 2, { bytes: dupBytesPendingOnly, filename: 'po.jpg' });
      check('P5pending专用:上传201且为pending', upPendingOnly.status === 201 && upPendingOnly.body.photo.state === 'pending', upPendingOnly.body);
      const sF = await buildDraftSheet(f, 'P5-PendingCheck-F', 2);
      const dupCheckPending = await uploadPhoto(f, sF.id, 'rack_front', sF.scope.racks[0].id, 2, { bytes: dupBytesPendingOnly, filename: 'po2.jpg' });
      check('P5pending不参与比对:matches为空且restricted_match为false', dupCheckPending.body.duplicate_of.matches.length === 0 && dupCheckPending.body.duplicate_of.restricted_match === false, dupCheckPending.body.duplicate_of);

      // C2b 任务4：同一单内 active 优先。先传A(激活)->再传B替换(A变superseded,B激活)->再传与A
      // 同哈希的C替换(B变superseded,C激活)——sG 此时同时持有哈希A的 superseded 行(即最初的A，
      // id更小)和哈希A的 active 行(即C，id更大)。查重命中该单时必须报 active，不能因为
      // ORDER BY p.id 先遇到那条更早的 superseded 行就报「已替换」。
      {
        const sG = await buildSubmittedSheet(f, 'P5-ActivePriority-G', 2);
        const rackIdG = sG.scope.racks[0].id;
        const bytesA = Buffer.concat([MIN_JPEG_BYTES, Buffer.from('active-priority-A')]);
        const bytesB = Buffer.concat([MIN_PNG_BYTES, Buffer.from('active-priority-B')]);
        const upA = await uploadPhoto(f, sG.id, 'rack_front', rackIdG, 2, { bytes: bytesA, filename: 'a.jpg' });
        check('C2b④准备:传A(pending)201', upA.status === 201, upA.body);
        const activateA = await f.api('PUT', '/inspections/sheets/' + sG.id, { expected_version: sG.version, items: [] }, 2);
        check('C2b④准备:激活A200', activateA.status === 200, activateA.body);
        const upB = await uploadPhoto(f, sG.id, 'rack_front', rackIdG, 2, { bytes: bytesB, filename: 'b.png', mime: 'image/png' });
        check('C2b④准备:传B(pending,将替换A)201', upB.status === 201, upB.body);
        assert.equal((await deletePhoto(f,sG.id,upA.body.photo.id,2)).status,200);
        const activateB = await f.api('PUT', '/inspections/sheets/' + sG.id, { expected_version: activateA.body.version, items: [] }, 2);
        check('C2b④准备:激活B200(A变superseded)', activateB.status === 200, activateB.body);
        const upC = await uploadPhoto(f, sG.id, 'rack_front', rackIdG, 2, { bytes: bytesA, filename: 'c.jpg' }); // 与A同哈希
        check('C2b④准备:传C(pending,与A同哈希)201', upC.status === 201, upC.body);
        assert.equal((await deletePhoto(f,sG.id,upB.body.photo.id,2)).status,200);
        const activateC = await f.api('PUT', '/inspections/sheets/' + sG.id, { expected_version: activateB.body.version, items: [] }, 2);
        check('C2b④准备:激活C200(B变superseded,C变active)', activateC.status === 200, activateC.body);

        const hashA = crypto.createHash('sha256').update(bytesA).digest('hex');
        const supersededRowsWithHashA = await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='superseded' AND sha256=?", [sG.id, hashA]);
        const activeRowsWithHashA = await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active' AND sha256=?", [sG.id, hashA]);
        check('C2b④前提:sG同时有一条superseded和一条active的哈希A记录且superseded的id更小(否则测不出老逻辑的bug)', supersededRowsWithHashA.length === 1 && activeRowsWithHashA.length === 1 && supersededRowsWithHashA[0].id < activeRowsWithHashA[0].id, { supersededRowsWithHashA, activeRowsWithHashA });

        const sH = await buildDraftSheet(f, 'P5-ActivePriority-H', 2);
        const dupCheck = await uploadPhoto(f, sH.id, 'rack_front', sH.scope.racks[0].id, 2, { bytes: bytesA, filename: 'check.jpg' });
        const matchForG = dupCheck.body.duplicate_of.matches.find((m) => m.sheet_id === sG.id);
        check('C2b④重复提示同单active优先(不报旧的superseded)', matchForG && matchForG.photo_state === 'active', dupCheck.body.duplicate_of);
      }
    }

    // ============================================================
    // 6) 内容下载：可见性、state规则、他人pending404、响应头
    // ============================================================
    {
      const s6 = await buildDraftSheet(f, 'P6-Content', 2);
      const up6 = await uploadPhoto(f, s6.id, 'rack_front', s6.scope.racks[0].id, 2, { bytes: MIN_JPEG_BYTES, filename: 'c.jpg' });
      const content6 = await getPhotoContent(f, s6.id, up6.body.photo.id, 2);
      check('P6可见者下载200', content6.status === 200);
      check('P6下载字节与上传一致', content6.buf.equals(MIN_JPEG_BYTES), { len: content6.buf.length });
      check('P6响应头Cache-Control正确', content6.headers.get('cache-control') === 'private, no-store', content6.headers.get('cache-control'));
      check('P6响应头X-Content-Type-Options正确', content6.headers.get('x-content-type-options') === 'nosniff', content6.headers.get('x-content-type-options'));
      check('P6响应头Content-Type正确', content6.headers.get('content-type') === 'image/jpeg', content6.headers.get('content-type'));

      const othersDraftContent = await getPhotoContent(f, s6.id, up6.body.photo.id, 3); // uid3只读, 他人草稿summary可见, 不是full
      check('P6他人草稿(summary可见)下载不到照片(404,不因只读单独放行)', othersDraftContent.status === 404, othersDraftContent.status);

      const notFoundPhoto = await getPhotoContent(f, s6.id, 999999, 2);
      check('P6不存在的照片404', notFoundPhoto.status === 404, notFoundPhoto.status);

      // C2c L5：superseded可下载；自己的pending 200；非管理员下载已删除单的照片404。
      const s6sub = await buildSubmittedSheet(f, 'P6-Superseded', 2);
      const oldActiveRow6 = (await f.all("SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active'", [s6sub.id]))[0];
      const replacePending6 = await uploadPhoto(f, s6sub.id, 'rack_front', s6sub.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'p6replace.png', mime: 'image/png' });
      check('L5准备:pending上传201', replacePending6.status === 201, replacePending6.body);
      const pendingContent6 = await getPhotoContent(f, s6sub.id, replacePending6.body.photo.id, 2);
      check('L5自己的pending下载200', pendingContent6.status === 200, pendingContent6.status);
      assert.equal((await deletePhoto(f,s6sub.id,oldActiveRow6.id,2)).status,200);
      const activateEdit6 = await f.api('PUT', '/inspections/sheets/' + s6sub.id, { expected_version: s6sub.version, items: [] }, 2);
      check('L5准备:保存修改生效200(原active变superseded)', activateEdit6.status === 200, activateEdit6.body);
      const supersededContent6 = await getPhotoContent(f, s6sub.id, oldActiveRow6.id, 2);
      check('L5 superseded照片可下载200', supersededContent6.status === 200, supersededContent6.status);

      const s6del = await buildSubmittedSheet(f, 'P6-DeletedSheet', 2);
      const photoIdForDel6 = (await f.all("SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active'", [s6del.id]))[0].id;
      const delResp6 = await f.api('DELETE', '/inspections/sheets/' + s6del.id, { expected_version: s6del.version, reason: 'L5测试删除' }, 2);
      check('L5准备:逻辑删除200', delResp6.status === 200, delResp6.body);
      const deletedContentAsOwner6 = await getPhotoContent(f, s6del.id, photoIdForDel6, 2);
      check('L5非管理员下载已删除单的照片404', deletedContentAsOwner6.status === 404, deletedContentAsOwner6.status);
      const deletedContentAsAdmin6 = await getPhotoContent(f, s6del.id, photoIdForDel6, 1);
      check('L5管理员下载已删除单的照片仍200(admin对已删除单full可见)', deletedContentAsAdmin6.status === 200, deletedContentAsAdmin6.status);
    }

    // ============================================================
    // 7) 清理队列：unlink失败重试；写事务失败上传文件立即删除；M3归属复核；M1饥饿修复
    // ============================================================
    {
      const s7 = await buildDraftSheet(f, 'P7-CleanupQueue', 2);

      // C2c M3：改用"无归属文件名"——不再借用一张真实照片的 stored_name（那张照片行还在
      // it_inspection_sheet_photos 里，新的归属复核会正确判定"仍被引用"而跳过，测不出真正的
      // unlink 失败）。改成一个从未进过照片表、只手工放进清理队列的独立 UUID.bin，对它伪装成
      // 目录来制造 unlink 失败(跨平台可靠；只读目录在 Windows 上对 unlink 不总生效)。
      const orphanName1 = crypto.randomUUID() + '.bin';
      const orphanPath1 = path.join(f.dir, 'sheet-photos', orphanName1);
      fs.mkdirSync(orphanPath1, { recursive: true }); // 伪装成目录=注定 unlink 失败(EISDIR)
      await f.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)', [orphanName1, 'sheet_photos', 'draft_removed', new Date().toISOString()]);
      // 触发一次巡检单写请求，顺带处理清理队列(最多20条，C2c M1后是响应发出之后异步处理，轮询等)。
      const triggerWrite1 = await f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: s7.version, items: [] }, 2);
      check('P7触发写请求200', triggerWrite1.status === 200, triggerWrite1.body);
      const cleanupAfterFail = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [orphanName1]); return rows.length && rows[0].attempts >= 1 ? rows : null; }, { label: 'P7 unlink失败attempts递增' });
      check('P7 unlink失败后队列行保留且attempts递增', cleanupAfterFail.length === 1 && cleanupAfterFail[0].attempts >= 1 && !!cleanupAfterFail[0].last_error && cleanupAfterFail[0].last_error !== '仍被引用', cleanupAfterFail);

      // 恢复(去掉伪装目录)，下一次写请求应顺带清掉。
      fs.rmdirSync(orphanPath1);
      const triggerWrite2 = await f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: triggerWrite1.body.version, items: [] }, 2);
      check('P7恢复后再次触发写请求200', triggerWrite2.status === 200, triggerWrite2.body);
      const cleanupAfterRecover = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [orphanName1]); return rows.length === 0 ? rows : null; }, { label: 'P7恢复后队列行清掉' });
      check('P7恢复后下一次写请求顺带清掉队列行', cleanupAfterRecover.length === 0, cleanupAfterRecover);

      // C2c M3：队列里放一个"在用照片"的文件名——归属复核应该判定仍被引用，不删文件、不unlink，
      // 只记 last_error='仍被引用'、attempts+1；文件仍在、照片仍可正常下载。
      const inUse = await uploadPhoto(f, s7.id, 'rack_front', s7.scope.racks[0].id, 2, { bytes: MIN_JPEG_BYTES, filename: 'inuse.jpg' });
      check('P7在用照片上传201', inUse.status === 201, inUse.body);
      const inUseStoredRow = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [inUse.body.photo.id]))[0];
      const inUsePath = path.join(f.dir, 'sheet-photos', inUseStoredRow.stored_name);
      check('P7在用照片文件确实落盘', fs.existsSync(inUsePath));
      await f.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)', [inUseStoredRow.stored_name, 'sheet_photos', 'draft_removed', new Date().toISOString()]);
      const triggerWrite3 = await f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: triggerWrite2.body.version, items: [] }, 2);
      check('P7在用照片触发写请求200', triggerWrite3.status === 200, triggerWrite3.body);
      const inUseQueueRow = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [inUseStoredRow.stored_name]); return rows.length && rows[0].attempts >= 1 ? rows[0] : null; }, { label: 'P7在用照片归属复核' });
      check('P7在用照片队列行last_error为"仍被引用"且未真的unlink', inUseQueueRow.last_error === '仍被引用', inUseQueueRow);
      check('P7在用照片文件仍在磁盘(未被误删)', fs.existsSync(inUsePath));
      const inUseContent = await getPhotoContent(f, s7.id, inUse.body.photo.id, 2);
      check('P7在用照片仍可正常下载', inUseContent.status === 200);
      // 清理：直接删照片行(绕开正常流程)让下一轮写请求把它真正清掉，避免脏数据影响别的用例统计。
      await f.run('DELETE FROM it_inspection_sheet_photos WHERE id=?', [inUse.body.photo.id]);
      const triggerWrite4 = await f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: triggerWrite3.body.version, items: [] }, 2);
      await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [inUseStoredRow.stored_name]); return rows.length === 0 ? true : null; }, { label: 'P7在用照片善后清理' });

      // 写事务失败的上传文件被立即删除(不进队列)：item slot 挂在 number 项上，内容校验通过但写
      // 事务里的目标校验会拒绝——文件已经落盘，catch 分支里应立即 unlink，不留队列行。这条走的是
      // 上传失败的 catch 分支（C2b 已改成同步先于响应），不受 M1 的 fire-and-forget 影响。
      const detail7 = await getSheetAs(f, s7.id, 2);
      const tempItem7 = detail7.body.items.find((it) => it.item_key === 'temperature');
      const beforeCleanupCount = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      const failedUpload = await uploadPhoto(f, s7.id, 'item', tempItem7.id, 2, { bytes: MIN_JPEG_BYTES, filename: 'fail.jpg' });
      check('P7写事务失败上传400', failedUpload.status === 400, failedUpload.body);
      const afterCleanupCount = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      check('P7写事务失败未新增清理队列行(立即unlink成功)', afterCleanupCount === beforeCleanupCount, { beforeCleanupCount, afterCleanupCount });
      const allStoredNamesAfterFail = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos')).map((r) => r.stored_name);
      // 失败上传的文件名不在任何照片行里(从未入库)；用目录扫描确认目录下不存在"孤儿"文件(除已知的active照片外)。
      const dirFiles = fs.readdirSync(path.join(f.dir, 'sheet-photos'));
      const orphanFiles = dirFiles.filter((name) => !allStoredNamesAfterFail.includes(name));
      check('P7写事务失败上传的文件不留在目录里(立即删除,不是孤儿)', orphanFiles.length === 0, orphanFiles);

      // C2c M1：队列饥饿修复——21条持续失败的旧行(attempts持续增长) + 1条新行，一次写请求后新行
      // 应该被清掉(不会因为处理名额被前面20条持续失败的老行占满而永远排不上号)。
      const starveOrphans = [];
      for (let i = 0; i < 21; i++) {
        const name = crypto.randomUUID() + '.bin';
        const p = path.join(f.dir, 'sheet-photos', name);
        fs.mkdirSync(p, { recursive: true }); // 伪装成目录=持续失败
        await f.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at,attempts) VALUES(?,?,?,?,?)', [name, 'sheet_photos', 'draft_removed', new Date().toISOString(), 5]);
        starveOrphans.push({ name, path: p });
      }
      const freshOrphanName = crypto.randomUUID() + '.bin';
      const freshOrphanPath = path.join(f.dir, 'sheet-photos', freshOrphanName);
      fs.writeFileSync(freshOrphanPath, MIN_JPEG_BYTES); // 真实文件，能被正常unlink成功
      await f.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at,attempts) VALUES(?,?,?,?,?)', [freshOrphanName, 'sheet_photos', 'draft_removed', new Date().toISOString(), 0]);
      const triggerWrite5 = await f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: triggerWrite4.body.version, items: [] }, 2);
      check('P7饥饿用例触发写请求200', triggerWrite5.status === 200, triggerWrite5.body);
      await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [freshOrphanName]); return rows.length === 0 ? true : null; }, { label: 'P7饥饿修复:新行被优先清掉', timeoutMs: 5000 });
      check('P7饥饿修复:21条持续失败旧行没有饿死1条新行', !fs.existsSync(freshOrphanPath));
      // 善后：清掉21条伪装目录，避免残留影响别的用例或磁盘。
      for (const o of starveOrphans) { try { fs.rmdirSync(o.path); } catch (_e) { /* best-effort */ } await f.run('DELETE FROM it_inspection_file_cleanup WHERE stored_name=?', [o.name]); }
    }

    // ============================================================
    // 9) 归档/逻辑删除丢弃pending并返回discarded_pending；日志行仍满足CHECK
    // ============================================================
    {
      const s9a = await buildSubmittedSheet(f, 'P9-ArchiveDiscard', 2);
      const s9b = await buildSubmittedSheet(f, 'P9-ArchiveDiscard2', 2);
      const pend9a1 = await uploadPhoto(f, s9a.id, 'rack_front', s9a.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'a1.png', mime: 'image/png' });
      const pend9a2 = await uploadPhoto(f, s9a.id, 'rack_front', s9a.scope.racks[0].id, 1, { bytes: MIN_WEBP_BYTES, filename: 'a2.webp', mime: 'image/webp' });
      const pend9b1 = await uploadPhoto(f, s9b.id, 'rack_front', s9b.scope.racks[0].id, 2, { bytes: MIN_PNG_BYTES, filename: 'b1.png', mime: 'image/png' });
      // C2c L9：先记下这3张pending的stored_name/路径，归档后要断言文件真的被清掉(不只是行没了)。
      const archivePendingPaths = await Promise.all([pend9a1, pend9a2, pend9b1].map(async (p) => {
        const row = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [p.body.photo.id]))[0];
        return path.join(f.dir, 'sheet-photos', row.stored_name);
      }));
      check('L9准备:3张待归档pending文件都确实落盘', archivePendingPaths.every((p) => fs.existsSync(p)), archivePendingPaths);
      const archiveResp9 = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: s9a.id, expected_version: s9a.version }, { id: s9b.id, expected_version: s9b.version }] }, 1);
      check('P9批量归档200且discarded_pending=3', archiveResp9.status === 200 && archiveResp9.body.discarded_pending === 3, archiveResp9.body);
      const archiveLogRow = (await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='archive'", [s9a.id]))[0];
      check('P9归档日志diff_json为NULL(CHECK约束)', archiveLogRow.diff_json === null, archiveLogRow);
      check('P9归档日志reason为NULL(CHECK约束)', archiveLogRow.reason === null, archiveLogRow);
      const remainingPendingAfterArchive = await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id IN (?,?) AND state='pending'", [s9a.id, s9b.id]);
      check('P9归档后不留任何pending行', remainingPendingAfterArchive.length === 0, remainingPendingAfterArchive);
      await waitFor(() => archivePendingPaths.every((p) => !fs.existsSync(p)), { label: 'L9归档丢弃的pending文件被清理', timeoutMs: 4000 });
      check('L9归档丢弃的3张pending文件都已从磁盘删除', archivePendingPaths.every((p) => !fs.existsSync(p)), archivePendingPaths);

      const s9c = await buildSubmittedSheet(f, 'P9-DeleteDiscard', 2);
      const pend9c = await uploadPhoto(f, s9c.id, 'rack_front', s9c.scope.racks[0].id, 2, { bytes: MIN_JPEG_BYTES, filename: 'c1.jpg' });
      const pend9cStoredName = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [pend9c.body.photo.id]))[0].stored_name;
      const pend9cPath = path.join(f.dir, 'sheet-photos', pend9cStoredName);
      const deleteResp9 = await f.api('DELETE', '/inspections/sheets/' + s9c.id, { expected_version: s9c.version, reason: 'P9测试删除' }, 2);
      check('P9逻辑删除200且discarded_pending=1', deleteResp9.status === 200 && deleteResp9.body.discarded_pending === 1, deleteResp9.body);
      const deleteLogRow = (await f.all("SELECT * FROM it_inspection_sheet_log WHERE sheet_id=? AND action='delete'", [s9c.id]))[0];
      check('P9删除日志diff_json为NULL(CHECK约束)', deleteLogRow.diff_json === null, deleteLogRow);
      check('P9删除日志reason为用户填写的原因(非NULL,CHECK要求)', deleteLogRow.reason === 'P9测试删除', deleteLogRow);
      await waitFor(() => !fs.existsSync(pend9cPath), { label: 'L9删除丢弃的pending文件被清理' });
      check('L9逻辑删除丢弃的pending文件已从磁盘删除', !fs.existsSync(pend9cPath));
    }

    // ============================================================
    // C2c L10：同一人对同一位置再传一张pending（pending_discarded）——旧pending行删除、文件清理、
    // 新行pending。
    // ============================================================
    {
      const sL10 = await buildSubmittedSheet(f, 'L10-PendingReplaced', 2);
      const rackIdL10 = sL10.scope.racks[0].id;
      const firstPendingL10 = await uploadPhoto(f, sL10.id, 'rack_front', rackIdL10, 2, { bytes: MIN_PNG_BYTES, filename: 'l10-first.png', mime: 'image/png' });
      check('L10第一张pending上传201', firstPendingL10.status === 201 && firstPendingL10.body.photo.state === 'pending', firstPendingL10.body);
      const firstStoredNameL10 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [firstPendingL10.body.photo.id]))[0].stored_name;
      const firstPathL10 = path.join(f.dir, 'sheet-photos', firstStoredNameL10);
      check('L10第一张pending文件确实落盘', fs.existsSync(firstPathL10));
      const secondPendingL10 = await uploadPhoto(f, sL10.id, 'rack_front', rackIdL10, 2, { bytes: MIN_WEBP_BYTES, filename: 'l10-second.webp', mime: 'image/webp' });
      check('L10同一人同位置再传一张pending201(替换)', secondPendingL10.status === 201 && secondPendingL10.body.photo.state === 'pending', secondPendingL10.body);
      check('L10同一位置pending追加不覆盖', (await getSheetAs(f,sL10.id,2)).body.my_pending_photos.length === 2);
      assert.equal((await deletePhoto(f,sL10.id,firstPendingL10.body.photo.id,2)).status,200);
      const firstRowAfterReplaceL10 = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [firstPendingL10.body.photo.id]);
      check('L10旧pending行已删除', firstRowAfterReplaceL10.length === 0, firstRowAfterReplaceL10);
      await waitFor(() => !fs.existsSync(firstPathL10), { label: 'L10旧pending文件被清理' });
      check('L10旧pending文件已从磁盘删除', !fs.existsSync(firstPathL10));
      const secondRowL10 = (await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [secondPendingL10.body.photo.id]))[0];
      check('L10新行仍是pending', secondRowL10.state === 'pending' && secondRowL10.pending_by === 2, secondRowL10);
    }

    // ============================================================
    // C2d T-H2：删除分支是否同事务入队——用新增的 testHooks.queueUnlink 注入「队列处理时 unlink
    // 失败」，覆盖草稿替换/草稿删单张/草稿物理删除/pending替换/pending丢弃(两条路由)/放弃修改/
    // 第4步pending_not_abnormal/第5步不涉及文件(负例)/归档丢弃/逻辑删除丢弃 这10条路径。每条：
    // 断言照片行已删、队列恰1行reason精确、文件此刻仍在磁盘；注入unlink失败后确认attempts自增、
    // 行与文件都还在；恢复注入点后下一次写请求（用一次性的草稿建单当"泵"）能追上，队列行与文件
    // 都被真正清掉。
    // ============================================================
    // C2d T-H2 关键顺序问题：queueUnlink 的失败注入必须在"触发丢弃的那个写请求"之前就设好——
    //   discardPhotoRow 插入 cleanup 队列行、与该路由响应后 M1 的 processCleanupQueueBestEffort()
    //   同属一条请求生命周期，若在触发动作之后才设注入点，真实 unlink 可能已经在我们查询之前就
    //   成功清掉了（本地实测第一版"先触发再设注入"就是这样，队列行在断言前已经消失）。
    let th2PumpCounter = 0;
    async function assertQueueUnlinkFailureAroundAction(label, { photoId, storedName, filePath, trigger, expectedReason }) {
      sharedTestHooks.queueUnlink = async () => { throw new Error('T-H2模拟unlink失败:' + storedName); };
      await trigger();
      const photoRowGone = await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [photoId]);
      check(label + ':照片行已删', photoRowGone.length === 0, photoRowGone);
      const afterFail = await waitFor(async () => {
        const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedName]);
        return (rows.length === 1 && rows[0].attempts >= 1) ? rows : null;
      }, { label: label + ':队列unlink失败后attempts自增(证明失败路径真被走过)', timeoutMs: 4000 });
      check(label + ':队列恰1行且reason精确(退避重试,不是被删)', afterFail.length === 1 && afterFail[0].reason === expectedReason, afterFail);
      check(label + ':unlink失败后文件仍在磁盘(没被误删)', fs.existsSync(filePath));
      sharedTestHooks.queueUnlink = undefined;
      th2PumpCounter += 1;
      const pump2 = await buildDraftSheet(f, 'T-H2-Pump-' + th2PumpCounter, 1);
      void pump2;
      await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedName]); return rows.length === 0 ? true : null; }, { label: label + ':恢复后队列行被清掉', timeoutMs: 4000 });
      await waitFor(() => !fs.existsSync(filePath), { label: label + ':恢复后文件也被删除', timeoutMs: 4000 });
    }

    // 1) 草稿替换(draft_removed)
    {
      const sT1 = await buildDraftSheet(f, 'T-H2-1-DraftReplaced', 2);
      const rackIdT1 = sT1.scope.racks[0].id;
      const firstT1 = await uploadPhoto(f, sT1.id, 'rack_front', rackIdT1, 2, { bytes: MIN_PNG_BYTES, filename: 't1-first.png', mime: 'image/png' });
      check('T-H2-1准备:草稿首次上传201(active)', firstT1.status === 201 && firstT1.body.photo.state === 'active', firstT1.body);
      const firstStoredT1 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [firstT1.body.photo.id]))[0].stored_name;
      const firstPathT1 = path.join(f.dir, 'sheet-photos', firstStoredT1);
      await assertQueueUnlinkFailureAroundAction('T-H2-1草稿替换(draft_removed)', {
        photoId: firstT1.body.photo.id, storedName: firstStoredT1, filePath: firstPathT1, expectedReason: 'draft_removed',
        trigger: async () => {
          const secondT1 = await uploadPhoto(f, sT1.id, 'rack_front', rackIdT1, 2, { bytes: MIN_WEBP_BYTES, filename: 't1-second.webp', mime: 'image/webp' });
          check('T-H2-1准备:草稿追加上传201', secondT1.status === 201, secondT1.body);
          assert.equal((await deletePhoto(f,sT1.id,firstT1.body.photo.id,2)).status,200);
        },
      });
    }

    // 2) 草稿删单张(draft_removed)
    {
      const sT2 = await buildDraftSheet(f, 'T-H2-2-DraftRemoved', 2);
      const rackIdT2 = sT2.scope.racks[0].id;
      const upT2 = await uploadPhoto(f, sT2.id, 'rack_front', rackIdT2, 2, { bytes: MIN_PNG_BYTES, filename: 't2.png', mime: 'image/png' });
      check('T-H2-2准备:草稿照片上传201', upT2.status === 201, upT2.body);
      const storedT2 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT2.body.photo.id]))[0].stored_name;
      const pathT2 = path.join(f.dir, 'sheet-photos', storedT2);
      await assertQueueUnlinkFailureAroundAction('T-H2-2草稿删单张(draft_removed)', {
        photoId: upT2.body.photo.id, storedName: storedT2, filePath: pathT2, expectedReason: 'draft_removed',
        trigger: async () => {
          const delT2 = await f.api('DELETE', '/inspections/sheets/' + sT2.id + '/photos/' + upT2.body.photo.id, undefined, 2);
          check('T-H2-2删除单张照片200', delT2.status === 200, delT2.body);
        },
      });
    }

    // 3) 草稿物理删除(draft_deleted)
    {
      const sT3 = await buildDraftSheet(f, 'T-H2-3-DraftDeleted', 2);
      const rackIdT3 = sT3.scope.racks[0].id;
      const upT3 = await uploadPhoto(f, sT3.id, 'rack_front', rackIdT3, 2, { bytes: MIN_PNG_BYTES, filename: 't3.png', mime: 'image/png' });
      check('T-H2-3准备:草稿照片上传201', upT3.status === 201, upT3.body);
      const storedT3 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT3.body.photo.id]))[0].stored_name;
      const pathT3 = path.join(f.dir, 'sheet-photos', storedT3);
      await assertQueueUnlinkFailureAroundAction('T-H2-3草稿物理删除(draft_deleted)', {
        photoId: upT3.body.photo.id, storedName: storedT3, filePath: pathT3, expectedReason: 'draft_deleted',
        trigger: async () => {
          const delSheetT3 = await f.api('DELETE', '/inspections/sheets/' + sT3.id, { expected_version: sT3.version, reason: 'T-H2-3测试' }, 2);
          check('T-H2-3草稿物理删除200', delSheetT3.status === 200 && delSheetT3.body.ok === true, delSheetT3.body);
        },
      });
    }

    // 4) pending替换(pending_discarded)
    {
      const sT4 = await buildSubmittedSheet(f, 'T-H2-4-PendingReplaced', 2);
      const rackIdT4 = sT4.scope.racks[0].id;
      const firstT4 = await uploadPhoto(f, sT4.id, 'rack_front', rackIdT4, 2, { bytes: MIN_PNG_BYTES, filename: 't4-first.png', mime: 'image/png' });
      check('T-H2-4准备:第一张pending上传201', firstT4.status === 201 && firstT4.body.photo.state === 'pending', firstT4.body);
      const storedT4 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [firstT4.body.photo.id]))[0].stored_name;
      const pathT4 = path.join(f.dir, 'sheet-photos', storedT4);
      await assertQueueUnlinkFailureAroundAction('T-H2-4pending替换(pending_discarded)', {
        photoId: firstT4.body.photo.id, storedName: storedT4, filePath: pathT4, expectedReason: 'pending_discarded',
        trigger: async () => {
          const secondT4 = await uploadPhoto(f, sT4.id, 'rack_front', rackIdT4, 2, { bytes: MIN_WEBP_BYTES, filename: 't4-second.webp', mime: 'image/webp' });
          check('T-H2-4准备:第二张pending追加上传201', secondT4.status === 201, secondT4.body);
          assert.equal((await deletePhoto(f,sT4.id,firstT4.body.photo.id,2)).status,200);
        },
      });
    }

    // 5) pending丢弃-单张删除路由(pending_discarded)
    {
      const sT5 = await buildSubmittedSheet(f, 'T-H2-5-PendingDiscarded', 2);
      const rackIdT5 = sT5.scope.racks[0].id;
      const upT5 = await uploadPhoto(f, sT5.id, 'rack_front', rackIdT5, 2, { bytes: MIN_PNG_BYTES, filename: 't5.png', mime: 'image/png' });
      check('T-H2-5准备:pending上传201', upT5.status === 201 && upT5.body.photo.state === 'pending', upT5.body);
      const storedT5 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT5.body.photo.id]))[0].stored_name;
      const pathT5 = path.join(f.dir, 'sheet-photos', storedT5);
      await assertQueueUnlinkFailureAroundAction('T-H2-5pending丢弃-单张删除路由(pending_discarded)', {
        photoId: upT5.body.photo.id, storedName: storedT5, filePath: pathT5, expectedReason: 'pending_discarded',
        trigger: async () => {
          const delT5 = await f.api('DELETE', '/inspections/sheets/' + sT5.id + '/photos/' + upT5.body.photo.id, undefined, 2);
          check('T-H2-5删除自己的pending照片200', delT5.status === 200, delT5.body);
        },
      });
    }

    // 6) 放弃修改路由(pending_discarded)
    {
      const sT6 = await buildSubmittedSheet(f, 'T-H2-6-DiscardEdit', 2);
      const rackIdT6 = sT6.scope.racks[0].id;
      const upT6 = await uploadPhoto(f, sT6.id, 'rack_front', rackIdT6, 2, { bytes: MIN_PNG_BYTES, filename: 't6.png', mime: 'image/png' });
      check('T-H2-6准备:pending上传201', upT6.status === 201 && upT6.body.photo.state === 'pending', upT6.body);
      const storedT6 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT6.body.photo.id]))[0].stored_name;
      const pathT6 = path.join(f.dir, 'sheet-photos', storedT6);
      await assertQueueUnlinkFailureAroundAction('T-H2-6放弃修改路由(pending_discarded)', {
        photoId: upT6.body.photo.id, storedName: storedT6, filePath: pathT6, expectedReason: 'pending_discarded',
        trigger: async () => {
          const discardT6 = await discardPendingPhotos(f, sT6.id, 2);
          check('T-H2-6放弃修改200且丢弃1张', discardT6.status === 200 && discardT6.body.discarded === 1, discardT6.body);
        },
      });
    }

    // 7) 第4步pending_not_abnormal
    {
      const sT7 = await buildSubmittedSheet(f, 'T-H2-7-PendingNotAbnormal', 2);
      const detailT7 = await getSheetAs(f, sT7.id, 2);
      const doorT7 = detailT7.body.items.find((it) => it.item_key === 'door');
      const upT7 = await uploadPhoto(f, sT7.id, 'item', doorT7.id, 2, { bytes: MIN_PNG_BYTES, filename: 't7.png', mime: 'image/png' });
      check('T-H2-7准备:door项pending上传201', upT7.status === 201, upT7.body);
      const storedT7 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT7.body.photo.id]))[0].stored_name;
      const pathT7 = path.join(f.dir, 'sheet-photos', storedT7);
      await assertQueueUnlinkFailureAroundAction('T-H2-7第4步pending_not_abnormal', {
        photoId: upT7.body.photo.id, storedName: storedT7, filePath: pathT7, expectedReason: 'pending_not_abnormal',
        trigger: async () => {
          // door项保持正常(ok)不标异常——第4步判定该pending不该生效，直接丢弃(不是激活)。
          const saveT7 = await f.api('PUT', '/inspections/sheets/' + sT7.id, { expected_version: sT7.version, items: [] }, 2);
          check('T-H2-7保存修改200(door仍正常,pending判定不生效)', saveT7.status === 200, saveT7.body);
        },
      });
    }

    // 8) 第5步不涉及文件(负例：不注入unlink失败，断言压根不产生队列行/不动文件)
    {
      const sT8 = await buildSubmittedSheet(f, 'T-H2-8-Step5NoFile', 2);
      const detailT8a = await getSheetAs(f, sT8.id, 2);
      const doorT8 = detailT8a.body.items.find((it) => it.item_key === 'door');
      const upT8 = await uploadPhoto(f, sT8.id, 'item', doorT8.id, 2, { bytes: MIN_PNG_BYTES, filename: 't8.png', mime: 'image/png' });
      check('T-H2-8准备:door项pending上传201', upT8.status === 201, upT8.body);
      const activateT8 = await f.api('PUT', '/inspections/sheets/' + sT8.id, { expected_version: sT8.version, items: [{ id: doorT8.id, result: 'bad', number_value: null, note: 'T-H2-8异常' }] }, 2);
      check('T-H2-8准备:标异常并生效为active照片200', activateT8.status === 200, activateT8.body);
      const activePhotoT8 = (await f.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='item' AND target_id=? AND state='active'", [sT8.id, doorT8.id]))[0];
      const pathT8 = path.join(f.dir, 'sheet-photos', activePhotoT8.stored_name);
      const queueBeforeT8 = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      // 改回正常——第5步只把active照片改superseded，不discard、不入队、不动文件。
      const revertT8 = await f.api('PUT', '/inspections/sheets/' + sT8.id, { expected_version: activateT8.body.version, items: [{ id: doorT8.id, result: 'ok', number_value: null, note: null }] }, 2);
      check('T-H2-8改回正常200', revertT8.status === 200, revertT8.body);
      const supersededPhotoT8 = (await f.all('SELECT * FROM it_inspection_sheet_photos WHERE id=?', [activePhotoT8.id]))[0];
      check('T-H2-8第5步:照片行转superseded(不是删除)', !!supersededPhotoT8 && supersededPhotoT8.state === 'superseded', supersededPhotoT8);
      const queueAfterT8 = (await f.all('SELECT COUNT(*) n FROM it_inspection_file_cleanup'))[0].n;
      check('T-H2-8第5步:清理队列未增行(不涉及文件)', queueAfterT8 === queueBeforeT8, { queueBeforeT8, queueAfterT8 });
      check('T-H2-8第5步:文件仍在磁盘(未被当作废弃处理)', fs.existsSync(pathT8));
    }

    // 9) 归档丢弃(archive_pending_discarded)
    {
      const sT9 = await buildSubmittedSheet(f, 'T-H2-9-ArchiveDiscarded', 2);
      const rackIdT9 = sT9.scope.racks[0].id;
      const upT9 = await uploadPhoto(f, sT9.id, 'rack_front', rackIdT9, 2, { bytes: MIN_PNG_BYTES, filename: 't9.png', mime: 'image/png' });
      check('T-H2-9准备:pending上传201', upT9.status === 201 && upT9.body.photo.state === 'pending', upT9.body);
      const storedT9 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT9.body.photo.id]))[0].stored_name;
      const pathT9 = path.join(f.dir, 'sheet-photos', storedT9);
      await assertQueueUnlinkFailureAroundAction('T-H2-9归档丢弃(archive_pending_discarded)', {
        photoId: upT9.body.photo.id, storedName: storedT9, filePath: pathT9, expectedReason: 'archive_pending_discarded',
        trigger: async () => {
          const archiveT9 = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: sT9.id, expected_version: sT9.version }] }, 1);
          check('T-H2-9归档200', archiveT9.status === 200, archiveT9.body);
        },
      });
    }

    // 10) 逻辑删除丢弃(delete_pending_discarded)
    {
      const sT10 = await buildSubmittedSheet(f, 'T-H2-10-DeleteDiscarded', 2);
      const rackIdT10 = sT10.scope.racks[0].id;
      const upT10 = await uploadPhoto(f, sT10.id, 'rack_front', rackIdT10, 2, { bytes: MIN_PNG_BYTES, filename: 't10.png', mime: 'image/png' });
      check('T-H2-10准备:pending上传201', upT10.status === 201 && upT10.body.photo.state === 'pending', upT10.body);
      const storedT10 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [upT10.body.photo.id]))[0].stored_name;
      const pathT10 = path.join(f.dir, 'sheet-photos', storedT10);
      await assertQueueUnlinkFailureAroundAction('T-H2-10逻辑删除丢弃(delete_pending_discarded)', {
        photoId: upT10.body.photo.id, storedName: storedT10, filePath: pathT10, expectedReason: 'delete_pending_discarded',
        trigger: async () => {
          const delT10 = await f.api('DELETE', '/inspections/sheets/' + sT10.id, { expected_version: sT10.version, reason: 'T-H2-10测试' }, 2);
          check('T-H2-10逻辑删除200', delT10.status === 200, delT10.body);
        },
      });
    }

    // ============================================================
    // G2A2 运行时探针：套件末尾统一断言（预筛见 verify-it-ledger-inspection-sheets.js 文件头
    // "结构约定检查声明"）。
    // ============================================================
    {
      // M4（G2A2b 必修）：谓词改用夹具统一导出的 isProbeViolation（写请求内事务外的任何SQL，不再
      // 限定表名）。
      const violations = sqlProbeRecords.filter(isProbeViolation);
      check('G2A2探针: 写请求锁外SQL违规数精确为0', violations.length === 0, violations.slice(0, 10));
      const inTxnCount = sqlProbeRecords.filter((r) => r.writeRequest === true && r.inWriteTxn === true).length;
      check('G2A2探针: 确实收到过写请求写事务内的SQL记录(探针接通,非空跑)', inTxnCount > 0, { inTxnCount, total: sqlProbeRecords.length });
      // M2（G2A2b 必修）：逐路由接通断言——本文件(mainHttpTests)覆盖的2条写路由。
      const PHOTOS_COVERED_WRITE_ROUTES = ['delete:/:id/photos/:photoId', 'delete:/:id/pending-photos'];
      const photosSeenRouteKeys = new Set(sqlProbeRecords.filter((r) => r.writeRequest === true).map((r) => normalizeInspectionRouteKey(r.method, r.path)));
      for (const routeKey of PHOTOS_COVERED_WRITE_ROUTES) {
        check(`M2逐路由接通: ${routeKey} 存在writeRequest:true的探针记录`, photosSeenRouteKeys.has(routeKey), [...photosSeenRouteKeys]);
      }
    }

    console.log(`INSPECTION_PHOTOS_HTTP PASS=${pass}`);
  } finally {
    await f.close();
  }
}

// ============================================================
// 8) 目录对账：只在进程首次初始化时执行一次；运行期 reinitForTest 不触发。
//    需要 enableTestHooks:true 才能拿到 _internals.reinitForTest，且需要在 initSchema() 之前把
//    文件放进存储目录——createFixture() 内部无条件调用 initSchema()，来不及插手，所以这里不用它，
//    自建一个最小 harness（写法参照 verify-it-ledger.js 的 fakeAuthenticateToken/seedUsers）。
// ============================================================
async function testDirectoryReconciliation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-reconcile-'));
  const dbFile = path.join(dir, 'fixture.db');
  const storageDir = path.join(dir, 'sheet-photos');
  fs.mkdirSync(storageDir, { recursive: true });

  const referencedName = crypto.randomUUID() + '.bin';
  const oldOrphanName = crypto.randomUUID() + '.bin';
  const youngOrphanName = crypto.randomUUID() + '.bin';
  const queuedOnlyName = crypto.randomUUID() + '.bin'; // C2c L7：只在清理队列里挂号，不在照片表
  fs.writeFileSync(path.join(storageDir, referencedName), MIN_JPEG_BYTES);
  fs.writeFileSync(path.join(storageDir, oldOrphanName), MIN_JPEG_BYTES);
  fs.writeFileSync(path.join(storageDir, youngOrphanName), MIN_JPEG_BYTES);
  fs.writeFileSync(path.join(storageDir, queuedOnlyName), MIN_JPEG_BYTES);
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(path.join(storageDir, referencedName), twoHoursAgo, twoHoursAgo); // 有主但也故意设老——证明"有主"优先于"1小时门槛"
  fs.utimesSync(path.join(storageDir, oldOrphanName), twoHoursAgo, twoHoursAgo);
  fs.utimesSync(path.join(storageDir, queuedOnlyName), twoHoursAgo, twoHoursAgo); // 也设老，确保会被扫进候选
  // youngOrphanName 保持刚写入的当前 mtime(<1小时)

  // 首次初始化前直接写库，种一行引用 referencedName 的照片记录（§2.6 提示的 dbCopyPath 之外另一
  // 种写法：table 只要具备 reconcilePhotoDirectoryOnce 查询要用到的列即可，不需要完整 DDL），
  // 再种一行只挂在清理队列表里的记录（L7：验证"在队列中也视为有主"这条分支）。
  await new Promise((resolve, reject) => {
    const seedDb = new sqlite3.Database(dbFile);
    seedDb.serialize(() => {
      seedDb.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, password TEXT, display_name TEXT, role TEXT, status TEXT)`);
      seedDb.run(`INSERT INTO users VALUES (1,'admin','x','管理员','admin','active')`);
      seedDb.run(`INSERT INTO users VALUES (2,'alice','x','Alice','user','active')`);
      seedDb.run(`CREATE TABLE it_inspection_sheet_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id INTEGER NOT NULL, slot TEXT NOT NULL, target_id INTEGER NOT NULL,
        original_name TEXT NOT NULL, stored_name TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL,
        sha256 TEXT NOT NULL, created_by INTEGER NOT NULL, created_at TEXT NOT NULL, state TEXT NOT NULL,
        pending_by INTEGER, superseded_by INTEGER, superseded_at TEXT)`);
      seedDb.run(`CREATE TABLE it_inspection_file_cleanup (
        id INTEGER PRIMARY KEY AUTOINCREMENT, stored_name TEXT NOT NULL UNIQUE, dir_key TEXT NOT NULL,
        reason TEXT NOT NULL, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
      seedDb.run('INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state) VALUES (1,\'rack_front\',1,\'r.jpg\',?,\'image/jpeg\',10,\'x\',1,?,\'active\')',
        [referencedName, new Date().toISOString()]);
      seedDb.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES (?,\'sheet_photos\',\'draft_removed\',?)',
        [queuedOnlyName, new Date().toISOString()], (err) => {
          if (err) { seedDb.close(); reject(err); return; }
          seedDb.close((closeErr) => (closeErr ? reject(closeErr) : resolve()));
        });
    });
  });

  const warnLogs = [];
  const logger = { info() {}, warn(...a) { warnLogs.push(a.join(' ')); }, error(...a) { console.error('[ERROR]', ...a); } };
  const authenticateToken = (req, res, next) => {
    const uid = req.headers['x-test-user-id'];
    if (uid === undefined) return res.status(401).json({ error: '未登录' });
    req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' };
    next();
  };
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
  const ledgerFactory = require('../routes/it-ledger');
  // C2c M8：仅测试可用的探针，记录对账真正开始时 state.ready 是什么。
  const probeCalls = [];
  // C2d T-M6：queuedOnlyName 只挂号在清理队列表（L7场景），但 initSchema() 发布后还会 fire-and-
  //   forget 触发一次 processCleanupQueue(20)（真正的队列重试，不只是目录对账）——它眼里
  //   queuedOnlyName 是一条正常待处理的队列行（没有任何照片表引用去挡它），如果这次重试跑得比
  //   下面的 check() 快，文件会被"正常队列重试"删掉，让"对账把队列里的文件当有主"这条断言的通过
  //   与否偶然取决于两个异步任务谁先跑完。用 T-H2 同一套 testHooks.queueUnlink 挡住这次重试的
  //   unlink，让断言只依赖"对账阶段没删它"这一件事，不再靠时序侥幸。
  const testHooksReconcile = { queueUnlink: async () => { throw new Error('T-M6测试专用:阻止queuedOnlyName被开机队列重试提前清掉'); } };
  const ledger = ledgerFactory({ logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir, enableTestHooks: true, inspectionSheetReconcileProbe: (info) => probeCalls.push(info), inspectionSheetTestHooks: testHooksReconcile });
  await ledger.initSchema();
  try {
    check('P8初始化后:超1小时无主文件已删除', !fs.existsSync(path.join(storageDir, oldOrphanName)));
    check('P8初始化后:1小时内无主文件仍保留', fs.existsSync(path.join(storageDir, youngOrphanName)));
    check('P8初始化后:有主文件仍保留(即便mtime也老,有主优先)', fs.existsSync(path.join(storageDir, referencedName)));
    // C2c L7：只在清理队列表挂号(不在照片表)的文件也应视为"有主"，不被对账删。
    check('P8初始化后:只在清理队列表挂号的文件也视为有主,不被对账删', fs.existsSync(path.join(storageDir, queuedOnlyName)));
    // C2c M8：探针记录的是对账真正开始时的 state.ready——此刻模块还没发布，必须是 false。
    check('P8对账探针被调用恰一次', probeCalls.length === 1, probeCalls);
    check('P8对账发生在就绪之前(state.ready===false)', probeCalls[0] && probeCalls[0].readyAtCallTime === false, probeCalls);

    // 运行期重新初始化不触发对账：init之后新放一个"超1小时无主"的文件，reinitForTest 不应删它。
    const lateOrphanName = crypto.randomUUID() + '.bin';
    fs.writeFileSync(path.join(storageDir, lateOrphanName), MIN_JPEG_BYTES);
    fs.utimesSync(path.join(storageDir, lateOrphanName), twoHoursAgo, twoHoursAgo);
    check('P8运行期新增的超1小时无主文件在reinit前存在', fs.existsSync(path.join(storageDir, lateOrphanName)));
    await ledger._internals.reinitForTest();
    check('P8运行期reinitForTest不触发对账(该文件仍保留)', fs.existsSync(path.join(storageDir, lateOrphanName)));
    // 对账失败才会 warn；本例两次初始化（首次+reinit）全程不该有任何对账失败噪音。
    check('P8全程无对账失败warn', warnLogs.filter((l) => l.includes('目录对账')).length === 0, warnLogs);
  } finally {
    await ledger.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
  }
  console.log(`INSPECTION_PHOTOS_RECONCILE PASS=${pass}`);
}

// ============================================================
// C2c M2：目录对账耗时计入启动预算——用现有的 _testHooks.ddlDeadlineMsOverride（reinitForTest
// 同一套预算机制，setDdlDeadlineMsOverride 在 initSchema() 之前调用即可生效）把整个初始化的软
// 预算压到 3 秒：DDL 本身（几张 CREATE TABLE IF NOT EXISTS）正常几十毫秒就能跑完，但 deadlineTs
// 从一开始就只有 3000ms 之内，等真正跑到对账这一步时剩余预算必然已经 < 5000ms（因为预算总量本
// 身就小于 5000ms），触发"提前停止"分支——不需要额外的新注入点，直接复用已有的 DDL 预算钩子。
// ============================================================
async function testReconcileDeadlineBudget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-reconcile-deadline-'));
  const dbFile = path.join(dir, 'fixture.db');
  const storageDir = path.join(dir, 'sheet-photos');
  fs.mkdirSync(storageDir, { recursive: true });
  const orphanNames = [];
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (let i = 0; i < 5; i++) {
    const name = crypto.randomUUID() + '.bin';
    fs.writeFileSync(path.join(storageDir, name), MIN_JPEG_BYTES);
    fs.utimesSync(path.join(storageDir, name), twoHoursAgo, twoHoursAgo);
    orphanNames.push(name);
  }
  const warnLogs = [];
  const logger = { info() {}, warn(...a) { warnLogs.push(a.join(' ')); }, error(...a) { console.error('[ERROR]', ...a); } };
  const authenticateToken = (req, res, next) => { const uid = req.headers['x-test-user-id']; if (uid === undefined) return res.status(401).json({ error: '未登录' }); req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' }; next(); };
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
  const ledgerFactory = require('../routes/it-ledger');
  const ledger = ledgerFactory({ logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir, enableTestHooks: true });
  ledger._internals.setDdlDeadlineMsOverride(3000); // 总预算3秒，远小于5秒门槛，对账一进循环就该停
  await ledger.initSchema();
  try {
    check('M2对账预算不足时warn"未完成,下次启动继续"', warnLogs.some((l) => l.includes('对账未完成') && l.includes('下次启动继续')), warnLogs);
    check('M2预算不足未让初始化失败(仍然就绪)', ledger._internals.state.ready === true, ledger._internals.state);
    // 提前停止后，至少有一个候选文件因为没轮到而幸存(不代表判定它有主，只是没处理到)。
    const survivedCount = orphanNames.filter((n) => fs.existsSync(path.join(storageDir, n))).length;
    check('M2预算不足时至少有候选文件未被处理(提前停止生效,不是碰巧全删完)', survivedCount > 0, { survivedCount, total: orphanNames.length });
  } finally {
    await ledger.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
  }
  console.log(`INSPECTION_PHOTOS_RECONCILE_DEADLINE PASS=${pass}`);
}

// ============================================================
// C2d S-M：逐文件stat阶段也要受同一个截止时刻约束——上面 testReconcileDeadlineBudget() 只验证了
// "决定删不删"那个循环受预算约束，没验证"先readdir+逐个stat决定谁是候选"这个更前面的阶段。用同一
// 个 setDdlDeadlineMsOverride(3000) 把预算压紧（进入 reconcile 时剩余必然<5000门槛），配合足够多
// 的候选文件（20个）。判别力不在"文件是否被删"——旧代码下 unlink 阶段原有的检查本来就会在第一次
// 迭代就拦下，删除数在新旧代码下都是0，这条不具区分力；真正的判别信号是 warn 文案里"readdir/stat
// 阶段"这几个字——只有 stat 循环自己也做了预算检查才会打这行日志，旧代码即便预算再紧也只会打
// unlink阶段那条不带"readdir/stat"字样的日志（甚至可能因为stat循环无约束地跑完全部候选而打印
// 别的日志），断言这个更精确的文案，变异删掉stat阶段检查就会让这条断言真正变红。
// ============================================================
async function testReconcileStatPhaseDeadlineBudget() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-reconcile-statphase-'));
  const dbFile = path.join(dir, 'fixture.db');
  const storageDir = path.join(dir, 'sheet-photos');
  fs.mkdirSync(storageDir, { recursive: true });
  const orphanNames = [];
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (let i = 0; i < 20; i++) {
    const name = crypto.randomUUID() + '.bin';
    fs.writeFileSync(path.join(storageDir, name), MIN_JPEG_BYTES);
    fs.utimesSync(path.join(storageDir, name), twoHoursAgo, twoHoursAgo);
    orphanNames.push(name);
  }
  const warnLogs = [];
  const logger = { info() {}, warn(...a) { warnLogs.push(a.join(' ')); }, error(...a) { console.error('[ERROR]', ...a); } };
  const authenticateToken = (req, res, next) => { const uid = req.headers['x-test-user-id']; if (uid === undefined) return res.status(401).json({ error: '未登录' }); req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' }; next(); };
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
  const ledgerFactory = require('../routes/it-ledger');
  const ledger = ledgerFactory({ logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir, enableTestHooks: true });
  ledger._internals.setDdlDeadlineMsOverride(3000);
  await ledger.initSchema();
  try {
    check('S-M对账预算不足时warn文案精确含"readdir/stat阶段"(不是笼统的未完成)', warnLogs.some((l) => l.includes('对账未完成') && l.includes('readdir/stat阶段') && l.includes('下次启动继续')), warnLogs);
    check('S-M预算不足未让初始化失败(仍然就绪)', ledger._internals.state.ready === true, ledger._internals.state);
    const survivedCount = orphanNames.filter((n) => fs.existsSync(path.join(storageDir, n))).length;
    check('S-M预算不足时20个候选文件全部因stat阶段提前停止而幸存', survivedCount === orphanNames.length, { survivedCount, total: orphanNames.length });
  } finally {
    await ledger.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
  }
  console.log(`INSPECTION_PHOTOS_RECONCILE_STATPHASE PASS=${pass}`);
}

// ============================================================
// C2e-3：stat 阶段预算用例要能分辨"逐项检查"与"只在进入循环前检查一次"——用仅测试可用的时钟注入
// （deps.inspectionSheetReconcileNow）代替真实 Date.now：前 K 次循环迭代让时钟保持在"预算充足"的
// 真实当前时间，第 K+1 次迭代直接把时钟跳到10分钟以后（远超任何真实deadlineTs，不需要精确算出
// deadlineTs本身的数值）。用 deps.inspectionSheetReconcileResultProbe 拿到
// reconcilePhotoDirectoryOnce 的真实返回值{checked,stoppedEarly}，断言 checked 精确等于 K（不是
// K+M）——"只查一次"的错误实现会让第一次(真实当前时间,预算充足)检查通过后就不再检查，最终会把
// K+M个候选全处理掉，checked会是K+M，被这条精确等式断言直接测出来。
// ============================================================
async function testReconcileStatPhaseClockInjection() {
  const K = 4;
  const M = 3;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-reconcile-clock-'));
  const dbFile = path.join(dir, 'fixture.db');
  const storageDir = path.join(dir, 'sheet-photos');
  fs.mkdirSync(storageDir, { recursive: true });
  const orphanNames = [];
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (let i = 0; i < K + M; i++) {
    const name = crypto.randomUUID() + '.bin';
    fs.writeFileSync(path.join(storageDir, name), MIN_JPEG_BYTES);
    fs.utimesSync(path.join(storageDir, name), twoHoursAgo, twoHoursAgo);
    orphanNames.push(name);
  }
  const warnLogs = [];
  const logger = { info() {}, warn(...a) { warnLogs.push(a.join(' ')); }, error(...a) { console.error('[ERROR]', ...a); } };
  const authenticateToken = (req, res, next) => { const uid = req.headers['x-test-user-id']; if (uid === undefined) return res.status(401).json({ error: '未登录' }); req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' }; next(); };
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
  const ledgerFactory = require('../routes/it-ledger');
  let calls = 0;
  const fakeNow = () => {
    calls += 1;
    // 第1次调用是nowSnapshot(用于staleness比较，种子文件mtime已设2小时前，不受影响)；
    // 第2..(K+1)次调用对应readdir/stat循环的第1..K次迭代前置检查——都返回真实当前时间(预算充足)；
    // 第(K+2)次调用(第K+1次迭代)起直接跳到10分钟后，远超任何真实deadlineTs，触发提前停止。
    if (calls <= 1 + K) return Date.now();
    return Date.now() + 10 * 60 * 1000;
  };
  let reconcileResult = null;
  const ledger = ledgerFactory({
    logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir, enableTestHooks: true,
    inspectionSheetReconcileNow: fakeNow,
    inspectionSheetReconcileResultProbe: (r) => { reconcileResult = r; },
  });
  await ledger.initSchema();
  try {
    check('C2e-3对账探针拿到了结果(inspectionSheetReconcileResultProbe被调用)', reconcileResult !== null, reconcileResult);
    check('C2e-3 checked精确等于K=4(不是K+M=7，证明是逐项检查不是只查一次)', reconcileResult && reconcileResult.checked === K, reconcileResult);
    check('C2e-3 stoppedEarly为true', reconcileResult && reconcileResult.stoppedEarly === true, reconcileResult);
    check('C2e-3 warn文案精确含"readdir/stat阶段"', warnLogs.some((l) => l.includes('对账未完成') && l.includes('readdir/stat阶段') && l.includes('下次启动继续')), warnLogs);
    check('C2e-3初始化仍发布(state.ready===true)', ledger._internals.state.ready === true, ledger._internals.state);
    const survivedCount = orphanNames.filter((n) => fs.existsSync(path.join(storageDir, n))).length;
    check('C2e-3全部候选文件都幸存(K个被评估到候选后也卡在名单查询阶段之前未删,K+M个里没有一个被删)', survivedCount === orphanNames.length, { survivedCount, total: orphanNames.length });
  } finally {
    await ledger.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
  }
  console.log(`INSPECTION_PHOTOS_RECONCILE_CLOCK PASS=${pass}`);
}

// ============================================================
// C2e-2：两表名单查询前的预算检查——上面 C2e-3 的用例让时钟在 readdir/stat 循环内跳变，candidates
// 永远凑不满，测不到"名单查询阶段"这个新加的检查点自己是否生效。本用例反过来：让 readdir/stat
// 循环用真实时钟正常跑完(候选全部收集齐)，只在循环结束后、发两条SELECT之前那一次检查上跳变时钟，
// 断言 checked===总候选数(证明确实进了名单查询阶段这一步，不是卡在更早的stat循环)、deleted===0、
// warn文案精确含"名单查询阶段"、全部文件幸存。
// ============================================================
async function testReconcileNameListBudgetCheck() {
  const N = 3;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-reconcile-namelist-'));
  const dbFile = path.join(dir, 'fixture.db');
  const storageDir = path.join(dir, 'sheet-photos');
  fs.mkdirSync(storageDir, { recursive: true });
  const orphanNames = [];
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  for (let i = 0; i < N; i++) {
    const name = crypto.randomUUID() + '.bin';
    fs.writeFileSync(path.join(storageDir, name), MIN_JPEG_BYTES);
    fs.utimesSync(path.join(storageDir, name), twoHoursAgo, twoHoursAgo);
    orphanNames.push(name);
  }
  const warnLogs = [];
  const logger = { info() {}, warn(...a) { warnLogs.push(a.join(' ')); }, error(...a) { console.error('[ERROR]', ...a); } };
  const authenticateToken = (req, res, next) => { const uid = req.headers['x-test-user-id']; if (uid === undefined) return res.status(401).json({ error: '未登录' }); req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' }; next(); };
  const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
  const ledgerFactory = require('../routes/it-ledger');
  let calls = 0;
  const fakeNow = () => {
    calls += 1;
    // 第1次(nowSnapshot)到第1+N次(readdir/stat循环N次迭代的前置检查)都返回真实当前时间——循环
    // 正常跑完，候选全部收集齐；第(N+2)次调用正是名单查询阶段那一次检查，跳到10分钟后触发早停。
    if (calls <= 1 + N) return Date.now();
    return Date.now() + 10 * 60 * 1000;
  };
  let reconcileResult = null;
  const ledger = ledgerFactory({
    logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir, enableTestHooks: true,
    inspectionSheetReconcileNow: fakeNow,
    inspectionSheetReconcileResultProbe: (r) => { reconcileResult = r; },
  });
  await ledger.initSchema();
  try {
    check('C2e-2对账探针拿到了结果', reconcileResult !== null, reconcileResult);
    check('C2e-2 checked精确等于N=3(readdir/stat循环正常跑完,候选全收集齐)', reconcileResult && reconcileResult.checked === N, reconcileResult);
    check('C2e-2 deleted精确为0(名单查询阶段之前就停了,一条SELECT都没发)', reconcileResult && reconcileResult.deleted === 0, reconcileResult);
    check('C2e-2 stoppedEarly为true', reconcileResult && reconcileResult.stoppedEarly === true, reconcileResult);
    check('C2e-2 warn文案精确含"名单查询阶段"', warnLogs.some((l) => l.includes('对账未完成') && l.includes('名单查询阶段') && l.includes('下次启动继续')), warnLogs);
    check('C2e-2初始化仍发布(state.ready===true)', ledger._internals.state.ready === true, ledger._internals.state);
    const survivedCount = orphanNames.filter((n) => fs.existsSync(path.join(storageDir, n))).length;
    check('C2e-2全部候选文件都幸存(名单查询没发起,谁都判不了有主无主,不删)', survivedCount === orphanNames.length, { survivedCount, total: orphanNames.length });
  } finally {
    await ledger.shutdown();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
  }
  console.log(`INSPECTION_PHOTOS_RECONCILE_NAMELIST PASS=${pass}`);
}

// ============================================================
// C2b 任务2：测试专用注入点覆盖「写事务失败且立即删除也失败」→ upload_aborted 入队；
// 再加一例「入队也失败」→ 响应不变、只记日志、文件留给目录对账。
// 需要 inspectionSheetTestHooks（只有本次派单新增，createFixture 透传 options.inspectionSheetTestHooks
// 到工厂 deps），独立开一个 fixture（testHooks 只在工厂构造时捕获一次，不能中途注入到已有的
// 共享 fixture 上）。
// ============================================================
async function testUploadAbortedInjection() {
  let removeImpl = async () => false; // 默认：模拟"unlink 本身也失败"
  const testHooks = { removeStoredFile: (dir, name) => removeImpl(dir, name) };
  // C2f：同上，闸未开时 inspectionSheetTestHooks 不生效，必须显式传 enableTestHooks:true。
  const f = await createFixture({ inspectionSheetTestHooks: testHooks, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const s = await buildDraftSheet(f, 'C2b-UploadAborted', 2);
    const rackId = s.scope.racks[0].id;
    const sheetPhotosDir = path.join(f.dir, 'sheet-photos');
    fs.mkdirSync(sheetPhotosDir, { recursive: true }); // 懒建目录：本函数首个动作是上传前的读目录，目录可能还不存在

    // --- 子例A：写事务失败(触发器ABORT) + unlink本身也失败(testHooks) -> upload_aborted 入队 ---
    await f.run("CREATE TRIGGER trg_c2b_fail_insert_a BEFORE INSERT ON it_inspection_sheet_photos BEGIN SELECT RAISE(ABORT,'C2b注入A:写事务失败'); END");
    const beforeQueueA = await f.all('SELECT * FROM it_inspection_file_cleanup');
    const filesBeforeA = new Set(fs.readdirSync(sheetPhotosDir));
    const respA = await uploadPhoto(f, s.id, 'rack_front', rackId, 2);
    check('C2b-A 写事务失败响应仍是原失败原因(500 LEDGER_INTERNAL,不被清理逻辑改写)', respA.status === 500 && respA.body.code === 'LEDGER_INTERNAL', respA.body);
    const afterQueueA = await f.all('SELECT * FROM it_inspection_file_cleanup');
    check('C2b-A 清理队列恰好多一行', afterQueueA.length === beforeQueueA.length + 1, { beforeQueueA, afterQueueA });
    const queuedRowA = afterQueueA.find((r) => !beforeQueueA.some((b) => b.id === r.id));
    check('C2b-A 新队列行reason=upload_aborted', queuedRowA && queuedRowA.reason === 'upload_aborted', queuedRowA);
    const filesAfterA = fs.readdirSync(sheetPhotosDir);
    const newFileA = filesAfterA.find((n) => !filesBeforeA.has(n));
    check('C2b-A 队列行stored_name等于那个未入库的文件', !!newFileA && queuedRowA.stored_name === newFileA, { newFileA, queuedRowA });
    check('C2b-A 文件仍在磁盘(unlink失败=没被真的删掉)', fs.existsSync(path.join(sheetPhotosDir, newFileA)));

    // 恢复注入点(撤触发器+切回真实unlink实现)，下一次写请求应把文件与队列行都清掉。
    await f.run('DROP TRIGGER trg_c2b_fail_insert_a');
    removeImpl = photoFilesReal.removeStoredFile;
    const triggerWrite = await f.api('PUT', '/inspections/sheets/' + s.id, { expected_version: s.version, items: [] }, 2);
    check('C2b-A 恢复后下一次写请求200', triggerWrite.status === 200, triggerWrite.body);
    // C2c M1：清理挪到响应之后 fire-and-forget，轮询等到达信号。
    const afterRecoverQueue = await waitFor(async () => { const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE id=?', [queuedRowA.id]); return rows.length === 0 ? rows : null; }, { label: 'C2b-A 队列行清掉' });
    check('C2b-A 恢复后队列行被清掉', afterRecoverQueue.length === 0, afterRecoverQueue);
    await waitFor(() => !fs.existsSync(path.join(sheetPhotosDir, newFileA)), { label: 'C2b-A 文件被删除' });
    check('C2b-A 恢复后文件也被删除', !fs.existsSync(path.join(sheetPhotosDir, newFileA)));

    // --- 子例B：写事务失败 + unlink也失败 + 入队也失败(队列表INSERT也ABORT) -> 只记日志，文件留给目录对账 ---
    removeImpl = async () => false;
    await f.run("CREATE TRIGGER trg_c2b_fail_insert_b BEFORE INSERT ON it_inspection_sheet_photos BEGIN SELECT RAISE(ABORT,'C2b注入B:写事务失败'); END");
    await f.run("CREATE TRIGGER trg_c2b_fail_cleanup_insert BEFORE INSERT ON it_inspection_file_cleanup BEGIN SELECT RAISE(ABORT,'C2b注入B:入队也失败'); END");
    const beforeQueueB = await f.all('SELECT * FROM it_inspection_file_cleanup');
    const filesBeforeB = new Set(fs.readdirSync(sheetPhotosDir));
    const respB = await uploadPhoto(f, s.id, 'rack_front', rackId, 2);
    check('C2b-B 双重失败响应仍是原失败原因(500 LEDGER_INTERNAL,不受清理级联失败影响)', respB.status === 500 && respB.body.code === 'LEDGER_INTERNAL', respB.body);
    const afterQueueB = await f.all('SELECT * FROM it_inspection_file_cleanup');
    check('C2b-B 清理队列未增行(入队本身也失败)', afterQueueB.length === beforeQueueB.length, { beforeQueueB, afterQueueB });
    const filesAfterB = fs.readdirSync(sheetPhotosDir);
    const newFileB = filesAfterB.find((n) => !filesBeforeB.has(n));
    check('C2b-B 文件仍留在磁盘(两次清理尝试都失败,只能等下次进程重启的目录对账)', !!newFileB && fs.existsSync(path.join(sheetPhotosDir, newFileB)), { newFileB });

    await f.run('DROP TRIGGER trg_c2b_fail_insert_b');
    await f.run('DROP TRIGGER trg_c2b_fail_cleanup_insert');
    check('G2A2探针: 写请求锁外SQL违规数精确为0', f.probeViolations().length === 0, f.probeViolations().slice(0, 10));
    check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
  } finally {
    await f.close();
  }
  console.log(`INSPECTION_PHOTOS_UPLOAD_ABORTED PASS=${pass}`);
}

// ============================================================
// C2e 36-R H1：删照片与入队是否真的在同一事务——对 it_inspection_file_cleanup 加
// BEFORE INSERT ... RAISE(ABORT) 触发器，逼 discardPhotoRow 的 INSERT 失败，验证整个 withWrite
// 事务(含更早的照片行 DELETE、单据 status/version 更新)一起回滚，不是只有入队这一步失败、前面的
// DELETE 已经提交。覆盖草稿替换/草稿删单张/草稿物理删除/pending替换/pending丢弃(两条路由)/
// 第4步pending_not_abnormal/归档丢弃/逻辑删除丢弃 共9条路径，逐一断言：请求500 LEDGER_INTERNAL
// （未分类错误的既定编码，同C2b-A先例）、照片行仍在、文件仍在磁盘、单据status/version未变。
// ============================================================
async function testDiscardQueueSameTransaction() {
  // C2g-1（36-R2 H）：原来一个全局触发器拦截 it_inspection_file_cleanup 的所有 INSERT，断言只看
  //   通用 500/LEDGER_INTERNAL——若某条路径在到达目标入队语句之前就因为别的原因（如替换上传自己的
  //   upload_aborted 入队）内部出错，测试也会"误判通过"。改为：① 触发器按本用例目标照片的
  //   stored_name 与预期 reason 精确限定（WHEN NEW.stored_name=? AND NEW.reason=?），别的
  //   INSERT（如别的用例、别的 stored_name/reason 组合）不受影响；② 每个触发器用唯一标记文本，
  //   服务端 handleErr 对未分类错误走 `logger.error('[it-ledger] 未分类错误: '+err.stack)`
  //   这条路径（已用夹具默认 500/LEDGER_INTERNAL 编码验证过是这条分支），标记文本会原样出现在
  //   err.stack 里——用自定义 logger 把这些 error(...) 调用参数收进数组，断言"这次操作之后新增的
  //   日志里出现了这条唯一标记"，确认 500 确实来自这一条触发器，不是同一事务里别的原因；③ 每条
  //   用例配一个无触发器的对照：同一操作在没有触发器时确实成功、确实把目标照片从照片表移除、且
  //   确实按预期 reason 入队（用 T-H2 同款 queueUnlink 注入暂时挡住真正的 unlink，撑出一个窗口读
  //   队列行的 reason 值，读完立即手动清掉这一行与文件，不留给下一个用例）。
  const capturedErrors = [];
  const testLogger = { info() {}, warn() {}, error(...args) { capturedErrors.push(args.join(' ')); } };
  const sharedTestHooks = {};
  const f = await createFixture({ logger: testLogger, inspectionSheetTestHooks: sharedTestHooks, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    async function withScopedAbortTrigger(storedName, reason, marker, fn) {
      // stored_name 恒为 `${uuid}.bin`（表 CHECK 约束保证只含 [0-9a-f-] 与字面 ".bin"）、reason 是
      // 我们自己写的固定枚举字符串——都不含引号/特殊字符，直接拼进 DDL 文本安全（CREATE TRIGGER 的
      // WHEN/RAISE 子句不支持 `?` 绑定参数，只能拼字面量）。
      await f.run(`CREATE TRIGGER trg_c2g_scoped BEFORE INSERT ON it_inspection_file_cleanup WHEN NEW.stored_name='${storedName}' AND NEW.reason='${reason}' BEGIN SELECT RAISE(ABORT,'${marker}'); END`);
      try { await fn(); } finally { await f.run('DROP TRIGGER trg_c2g_scoped'); }
    }
    async function assertWholeTxnRolledBack(label, { photoId, filePath, sheetId, marker, action }) {
      const logCountBefore = capturedErrors.length;
      const sheetBefore = (await f.all('SELECT status, version FROM it_inspection_sheets WHERE id=?', [sheetId]))[0];
      const result = await action();
      check(`${label}:请求失败500 LEDGER_INTERNAL(入队被trigger ABORT,同C2b-A既定编码)`, result.status === 500 && result.body && result.body.code === 'LEDGER_INTERNAL', result.body);
      const newLogs = capturedErrors.slice(logCountBefore);
      check(`${label}:错误确实来自该精确限定的触发器(服务端未分类错误日志含唯一标记文本)`, newLogs.some((l) => l.includes(marker)), newLogs);
      const rowAfter = (await f.all('SELECT id FROM it_inspection_sheet_photos WHERE id=?', [photoId]))[0];
      check(`${label}:照片行仍在(整事务回滚,不是只入队那一步单独失败)`, !!rowAfter && rowAfter.id === photoId, rowAfter);
      check(`${label}:文件仍在磁盘`, fs.existsSync(filePath));
      const sheetAfter = (await f.all('SELECT status, version FROM it_inspection_sheets WHERE id=?', [sheetId]))[0];
      check(`${label}:单据status/version未变`, sheetAfter.status === sheetBefore.status && sheetAfter.version === sheetBefore.version, { sheetBefore, sheetAfter });
    }
    // 对照组(无触发器)：同一操作应该成功、目标照片行确实被丢弃、且确实按预期 reason 入队。
    async function assertControlDiscard(label, { photoId, storedName, expectedReason, action }) {
      sharedTestHooks.queueUnlink = async () => { throw new Error('C2g对照组:临时挡住unlink,只为在真正清理前读一眼reason'); };
      const result = await action();
      check(`${label}对照组(无触发器):请求成功`, [200, 201].includes(result.status), result.body);
      const rowAfter = (await f.all('SELECT id FROM it_inspection_sheet_photos WHERE id=?', [photoId]))[0];
      check(`${label}对照组:目标照片行确实已被丢弃(不在照片表)`, !rowAfter, rowAfter);
      const queuedRow = await waitFor(async () => {
        const rows = await f.all('SELECT * FROM it_inspection_file_cleanup WHERE stored_name=?', [storedName]);
        return rows.length ? rows[0] : null;
      }, { label: `${label}对照组队列行出现` });
      check(`${label}对照组:队列行reason精确等于预期(${expectedReason})`, queuedRow.reason === expectedReason, queuedRow);
      // 读完立即手动收掉(真实unlink被临时挡住，文件还在磁盘)，不留给下一个用例。
      sharedTestHooks.queueUnlink = undefined;
      await f.run('DELETE FROM it_inspection_file_cleanup WHERE id=?', [queuedRow.id]);
      const filePath = path.join(f.dir, 'sheet-photos', storedName);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    // 1) 草稿替换(draft_removed)
    {
      const s1 = await buildDraftSheet(f, 'C2eH1-1-DraftReplaced', 2);
      const rackId1 = s1.scope.racks[0].id;
      const first1 = await uploadPhoto(f, s1.id, 'rack_front', rackId1, 2, { bytes: MIN_PNG_BYTES, filename: 'e1-first.png', mime: 'image/png' });
      check('C2eH1-1准备:首次上传201', first1.status === 201, first1.body);
      const stored1 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [first1.body.photo.id]))[0].stored_name;
      const path1 = path.join(f.dir, 'sheet-photos', stored1);
      await withScopedAbortTrigger(stored1, 'draft_removed', 'C2g-1-唯一标记', () => assertWholeTxnRolledBack('C2eH1-1草稿替换', {
        photoId: first1.body.photo.id, filePath: path1, sheetId: s1.id, marker: 'C2g-1-唯一标记',
        action: () => deletePhoto(f,s1.id,first1.body.photo.id,2),
      }));
      const s1c = await buildDraftSheet(f, 'C2gControl-1-DraftReplaced', 2);
      const rackId1c = s1c.scope.racks[0].id;
      const first1c = await uploadPhoto(f, s1c.id, 'rack_front', rackId1c, 2, { bytes: MIN_PNG_BYTES, filename: 'e1c-first.png', mime: 'image/png' });
      check('C2eH1-1对照组准备:首次上传201', first1c.status === 201, first1c.body);
      const stored1c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [first1c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-1草稿替换', {
        photoId: first1c.body.photo.id, storedName: stored1c, expectedReason: 'draft_removed',
        action: () => deletePhoto(f,s1c.id,first1c.body.photo.id,2),
      });
    }

    // 2) 草稿删单张(draft_removed)
    {
      const s2 = await buildDraftSheet(f, 'C2eH1-2-DraftRemoved', 2);
      const rackId2 = s2.scope.racks[0].id;
      const up2 = await uploadPhoto(f, s2.id, 'rack_front', rackId2, 2, { bytes: MIN_PNG_BYTES, filename: 'e2.png', mime: 'image/png' });
      check('C2eH1-2准备:上传201', up2.status === 201, up2.body);
      const stored2 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up2.body.photo.id]))[0].stored_name;
      const path2 = path.join(f.dir, 'sheet-photos', stored2);
      await withScopedAbortTrigger(stored2, 'draft_removed', 'C2g-2-唯一标记', () => assertWholeTxnRolledBack('C2eH1-2草稿删单张', {
        photoId: up2.body.photo.id, filePath: path2, sheetId: s2.id, marker: 'C2g-2-唯一标记',
        action: () => f.api('DELETE', '/inspections/sheets/' + s2.id + '/photos/' + up2.body.photo.id, undefined, 2),
      }));
      const s2c = await buildDraftSheet(f, 'C2gControl-2-DraftRemoved', 2);
      const rackId2c = s2c.scope.racks[0].id;
      const up2c = await uploadPhoto(f, s2c.id, 'rack_front', rackId2c, 2, { bytes: MIN_PNG_BYTES, filename: 'e2c.png', mime: 'image/png' });
      check('C2eH1-2对照组准备:上传201', up2c.status === 201, up2c.body);
      const stored2c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up2c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-2草稿删单张', {
        photoId: up2c.body.photo.id, storedName: stored2c, expectedReason: 'draft_removed',
        action: () => f.api('DELETE', '/inspections/sheets/' + s2c.id + '/photos/' + up2c.body.photo.id, undefined, 2),
      });
    }

    // 3) 草稿物理删除(draft_deleted)
    {
      const s3 = await buildDraftSheet(f, 'C2eH1-3-DraftDeleted', 2);
      const rackId3 = s3.scope.racks[0].id;
      const up3 = await uploadPhoto(f, s3.id, 'rack_front', rackId3, 2, { bytes: MIN_PNG_BYTES, filename: 'e3.png', mime: 'image/png' });
      check('C2eH1-3准备:上传201', up3.status === 201, up3.body);
      const stored3 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up3.body.photo.id]))[0].stored_name;
      const path3 = path.join(f.dir, 'sheet-photos', stored3);
      await withScopedAbortTrigger(stored3, 'draft_deleted', 'C2g-3-唯一标记', () => assertWholeTxnRolledBack('C2eH1-3草稿物理删除', {
        photoId: up3.body.photo.id, filePath: path3, sheetId: s3.id, marker: 'C2g-3-唯一标记',
        action: () => f.api('DELETE', '/inspections/sheets/' + s3.id, { expected_version: s3.version, reason: 'C2eH1-3测试' }, 2),
      }));
      // 物理删除是"删单据"，事务回滚意味着单据本身也该还在——额外核实一下(不只是status/version)。
      const sheetStillThere3 = (await f.all('SELECT id FROM it_inspection_sheets WHERE id=?', [s3.id]))[0];
      check('C2eH1-3草稿物理删除:单据行本身仍在(未被真的物理删除)', !!sheetStillThere3, sheetStillThere3);
      const s3c = await buildDraftSheet(f, 'C2gControl-3-DraftDeleted', 2);
      const rackId3c = s3c.scope.racks[0].id;
      const up3c = await uploadPhoto(f, s3c.id, 'rack_front', rackId3c, 2, { bytes: MIN_PNG_BYTES, filename: 'e3c.png', mime: 'image/png' });
      check('C2eH1-3对照组准备:上传201', up3c.status === 201, up3c.body);
      const stored3c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up3c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-3草稿物理删除', {
        photoId: up3c.body.photo.id, storedName: stored3c, expectedReason: 'draft_deleted',
        action: () => f.api('DELETE', '/inspections/sheets/' + s3c.id, { expected_version: s3c.version, reason: 'C2g对照组测试' }, 2),
      });
    }

    // 4) pending替换(pending_discarded)
    {
      const s4 = await buildSubmittedSheet(f, 'C2eH1-4-PendingReplaced', 2);
      const rackId4 = s4.scope.racks[0].id;
      const first4 = await uploadPhoto(f, s4.id, 'rack_front', rackId4, 2, { bytes: MIN_PNG_BYTES, filename: 'e4-first.png', mime: 'image/png' });
      check('C2eH1-4准备:第一张pending上传201', first4.status === 201 && first4.body.photo.state === 'pending', first4.body);
      const stored4 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [first4.body.photo.id]))[0].stored_name;
      const path4 = path.join(f.dir, 'sheet-photos', stored4);
      await withScopedAbortTrigger(stored4, 'pending_discarded', 'C2g-4-唯一标记', () => assertWholeTxnRolledBack('C2eH1-4pending替换', {
        photoId: first4.body.photo.id, filePath: path4, sheetId: s4.id, marker: 'C2g-4-唯一标记',
        action: () => deletePhoto(f,s4.id,first4.body.photo.id,2),
      }));
      const s4c = await buildSubmittedSheet(f, 'C2gControl-4-PendingReplaced', 2);
      const rackId4c = s4c.scope.racks[0].id;
      const first4c = await uploadPhoto(f, s4c.id, 'rack_front', rackId4c, 2, { bytes: MIN_PNG_BYTES, filename: 'e4c-first.png', mime: 'image/png' });
      check('C2eH1-4对照组准备:第一张pending上传201', first4c.status === 201 && first4c.body.photo.state === 'pending', first4c.body);
      const stored4c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [first4c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-4pending替换', {
        photoId: first4c.body.photo.id, storedName: stored4c, expectedReason: 'pending_discarded',
        action: () => deletePhoto(f,s4c.id,first4c.body.photo.id,2),
      });
    }

    // 5) pending丢弃-单张删除路由(pending_discarded)
    {
      const s5 = await buildSubmittedSheet(f, 'C2eH1-5-PendingDiscarded', 2);
      const rackId5 = s5.scope.racks[0].id;
      const up5 = await uploadPhoto(f, s5.id, 'rack_front', rackId5, 2, { bytes: MIN_PNG_BYTES, filename: 'e5.png', mime: 'image/png' });
      check('C2eH1-5准备:pending上传201', up5.status === 201 && up5.body.photo.state === 'pending', up5.body);
      const stored5 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up5.body.photo.id]))[0].stored_name;
      const path5 = path.join(f.dir, 'sheet-photos', stored5);
      await withScopedAbortTrigger(stored5, 'pending_discarded', 'C2g-5-唯一标记', () => assertWholeTxnRolledBack('C2eH1-5pending丢弃-单张删除路由', {
        photoId: up5.body.photo.id, filePath: path5, sheetId: s5.id, marker: 'C2g-5-唯一标记',
        action: () => f.api('DELETE', '/inspections/sheets/' + s5.id + '/photos/' + up5.body.photo.id, undefined, 2),
      }));
      const s5c = await buildSubmittedSheet(f, 'C2gControl-5-PendingDiscarded', 2);
      const rackId5c = s5c.scope.racks[0].id;
      const up5c = await uploadPhoto(f, s5c.id, 'rack_front', rackId5c, 2, { bytes: MIN_PNG_BYTES, filename: 'e5c.png', mime: 'image/png' });
      check('C2eH1-5对照组准备:pending上传201', up5c.status === 201 && up5c.body.photo.state === 'pending', up5c.body);
      const stored5c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up5c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-5pending丢弃-单张删除路由', {
        photoId: up5c.body.photo.id, storedName: stored5c, expectedReason: 'pending_discarded',
        action: () => f.api('DELETE', '/inspections/sheets/' + s5c.id + '/photos/' + up5c.body.photo.id, undefined, 2),
      });
    }

    // 6) 放弃修改路由(pending_discarded)
    {
      const s6 = await buildSubmittedSheet(f, 'C2eH1-6-DiscardEdit', 2);
      const rackId6 = s6.scope.racks[0].id;
      const up6 = await uploadPhoto(f, s6.id, 'rack_front', rackId6, 2, { bytes: MIN_PNG_BYTES, filename: 'e6.png', mime: 'image/png' });
      check('C2eH1-6准备:pending上传201', up6.status === 201 && up6.body.photo.state === 'pending', up6.body);
      const stored6 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up6.body.photo.id]))[0].stored_name;
      const path6 = path.join(f.dir, 'sheet-photos', stored6);
      await withScopedAbortTrigger(stored6, 'pending_discarded', 'C2g-6-唯一标记', () => assertWholeTxnRolledBack('C2eH1-6放弃修改路由', {
        photoId: up6.body.photo.id, filePath: path6, sheetId: s6.id, marker: 'C2g-6-唯一标记',
        action: () => discardPendingPhotos(f, s6.id, 2),
      }));
      const s6c = await buildSubmittedSheet(f, 'C2gControl-6-DiscardEdit', 2);
      const rackId6c = s6c.scope.racks[0].id;
      const up6c = await uploadPhoto(f, s6c.id, 'rack_front', rackId6c, 2, { bytes: MIN_PNG_BYTES, filename: 'e6c.png', mime: 'image/png' });
      check('C2eH1-6对照组准备:pending上传201', up6c.status === 201 && up6c.body.photo.state === 'pending', up6c.body);
      const stored6c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up6c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-6放弃修改路由', {
        photoId: up6c.body.photo.id, storedName: stored6c, expectedReason: 'pending_discarded',
        action: () => discardPendingPhotos(f, s6c.id, 2),
      });
    }

    // 7) 第4步pending_not_abnormal
    {
      const s7 = await buildSubmittedSheet(f, 'C2eH1-7-PendingNotAbnormal', 2);
      const detail7 = await getSheetAs(f, s7.id, 2);
      const door7 = detail7.body.items.find((it) => it.item_key === 'door');
      const up7 = await uploadPhoto(f, s7.id, 'item', door7.id, 2, { bytes: MIN_PNG_BYTES, filename: 'e7.png', mime: 'image/png' });
      check('C2eH1-7准备:door项pending上传201', up7.status === 201, up7.body);
      const stored7 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up7.body.photo.id]))[0].stored_name;
      const path7 = path.join(f.dir, 'sheet-photos', stored7);
      await withScopedAbortTrigger(stored7, 'pending_not_abnormal', 'C2g-7-唯一标记', () => assertWholeTxnRolledBack('C2eH1-7第4步pending_not_abnormal', {
        photoId: up7.body.photo.id, filePath: path7, sheetId: s7.id, marker: 'C2g-7-唯一标记',
        action: () => f.api('PUT', '/inspections/sheets/' + s7.id, { expected_version: s7.version, items: [] }, 2),
      }));
      const s7c = await buildSubmittedSheet(f, 'C2gControl-7-PendingNotAbnormal', 2);
      const detail7c = await getSheetAs(f, s7c.id, 2);
      const door7c = detail7c.body.items.find((it) => it.item_key === 'door');
      const up7c = await uploadPhoto(f, s7c.id, 'item', door7c.id, 2, { bytes: MIN_PNG_BYTES, filename: 'e7c.png', mime: 'image/png' });
      check('C2eH1-7对照组准备:door项pending上传201', up7c.status === 201, up7c.body);
      const stored7c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up7c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-7第4步pending_not_abnormal', {
        photoId: up7c.body.photo.id, storedName: stored7c, expectedReason: 'pending_not_abnormal',
        action: () => f.api('PUT', '/inspections/sheets/' + s7c.id, { expected_version: s7c.version, items: [] }, 2),
      });
    }

    // 8) 归档丢弃(archive_pending_discarded)
    {
      const s8 = await buildSubmittedSheet(f, 'C2eH1-8-ArchiveDiscarded', 2);
      const rackId8 = s8.scope.racks[0].id;
      const up8 = await uploadPhoto(f, s8.id, 'rack_front', rackId8, 2, { bytes: MIN_PNG_BYTES, filename: 'e8.png', mime: 'image/png' });
      check('C2eH1-8准备:pending上传201', up8.status === 201 && up8.body.photo.state === 'pending', up8.body);
      const stored8 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up8.body.photo.id]))[0].stored_name;
      const path8 = path.join(f.dir, 'sheet-photos', stored8);
      await withScopedAbortTrigger(stored8, 'archive_pending_discarded', 'C2g-8-唯一标记', () => assertWholeTxnRolledBack('C2eH1-8归档丢弃', {
        photoId: up8.body.photo.id, filePath: path8, sheetId: s8.id, marker: 'C2g-8-唯一标记',
        action: () => f.api('POST', '/inspections/sheets/archive', { items: [{ id: s8.id, expected_version: s8.version }] }, 1),
      }));
      const s8c = await buildSubmittedSheet(f, 'C2gControl-8-ArchiveDiscarded', 2);
      const rackId8c = s8c.scope.racks[0].id;
      const up8c = await uploadPhoto(f, s8c.id, 'rack_front', rackId8c, 2, { bytes: MIN_PNG_BYTES, filename: 'e8c.png', mime: 'image/png' });
      check('C2eH1-8对照组准备:pending上传201', up8c.status === 201 && up8c.body.photo.state === 'pending', up8c.body);
      const stored8c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up8c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-8归档丢弃', {
        photoId: up8c.body.photo.id, storedName: stored8c, expectedReason: 'archive_pending_discarded',
        action: () => f.api('POST', '/inspections/sheets/archive', { items: [{ id: s8c.id, expected_version: s8c.version }] }, 1),
      });
    }

    // 9) 逻辑删除丢弃(delete_pending_discarded)
    {
      const s9 = await buildSubmittedSheet(f, 'C2eH1-9-DeleteDiscarded', 2);
      const rackId9 = s9.scope.racks[0].id;
      const up9 = await uploadPhoto(f, s9.id, 'rack_front', rackId9, 2, { bytes: MIN_PNG_BYTES, filename: 'e9.png', mime: 'image/png' });
      check('C2eH1-9准备:pending上传201', up9.status === 201 && up9.body.photo.state === 'pending', up9.body);
      const stored9 = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up9.body.photo.id]))[0].stored_name;
      const path9 = path.join(f.dir, 'sheet-photos', stored9);
      await withScopedAbortTrigger(stored9, 'delete_pending_discarded', 'C2g-9-唯一标记', () => assertWholeTxnRolledBack('C2eH1-9逻辑删除丢弃', {
        photoId: up9.body.photo.id, filePath: path9, sheetId: s9.id, marker: 'C2g-9-唯一标记',
        action: () => f.api('DELETE', '/inspections/sheets/' + s9.id, { expected_version: s9.version, reason: 'C2eH1-9测试' }, 2),
      }));
      const s9c = await buildSubmittedSheet(f, 'C2gControl-9-DeleteDiscarded', 2);
      const rackId9c = s9c.scope.racks[0].id;
      const up9c = await uploadPhoto(f, s9c.id, 'rack_front', rackId9c, 2, { bytes: MIN_PNG_BYTES, filename: 'e9c.png', mime: 'image/png' });
      check('C2eH1-9对照组准备:pending上传201', up9c.status === 201 && up9c.body.photo.state === 'pending', up9c.body);
      const stored9c = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [up9c.body.photo.id]))[0].stored_name;
      await assertControlDiscard('C2eH1-9逻辑删除丢弃', {
        photoId: up9c.body.photo.id, storedName: stored9c, expectedReason: 'delete_pending_discarded',
        action: () => f.api('DELETE', '/inspections/sheets/' + s9c.id, { expected_version: s9c.version, reason: 'C2g对照组测试' }, 2),
      });
    }
    check('G2A2探针: 写请求锁外SQL违规数精确为0', f.probeViolations().length === 0, f.probeViolations().slice(0, 10));
    check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
  } finally {
    await f.close();
  }
  console.log(`INSPECTION_PHOTOS_DISCARD_TXN PASS=${pass}`);
}

// ============================================================
// C2b 任务3：§5.1 不可拆分条件的反例——照片上传唯一的锁外窗口是接收文件体期间。用手写分段
// multipart 请求，在服务端还没发完响应、multer 还在等文件体剩余字节时，另一条连接改单据状态，
// 断言最终按最新状态被拒，照片表无新行、存储目录无残留。
// ============================================================
async function testStreamingUploadRace() {
  const f = await createFixture({ enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const sheetPhotosDir = path.join(f.dir, 'sheet-photos');
    fs.mkdirSync(sheetPhotosDir, { recursive: true }); // 懒建目录：确保首次 readdirSync 不因目录不存在而 ENOENT

    // 反例①：流式接收期间另一连接把单据逻辑删除 -> 最终404，不落库不落盘。
    {
      const s = await buildSubmittedSheet(f, 'C2b-StreamDelete', 2);
      const rackId = s.scope.racks[0].id;
      const filesBefore = new Set(fs.readdirSync(sheetPhotosDir));
      const rowsBefore = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      const resp = await uploadPhotoChunked(f, s.id, 'rack_front', rackId, 2, MIN_JPEG_BYTES, async (hasResponded) => {
        check('C2b①前提:改状态前原上传请求确实尚未结束', hasResponded() === false);
        const delResp = await f.api('DELETE', '/inspections/sheets/' + s.id, { expected_version: s.version, reason: 'C2b流式测试删除' }, 2);
        check('C2b①另一连接逻辑删除200', delResp.status === 200, delResp.body);
      });
      check('C2b①流式接收期间单据被删除,最终404', resp.status === 404, resp.body);
      const rowsAfter = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      check('C2b①照片表无新行', rowsAfter.length === rowsBefore.length, { rowsBefore, rowsAfter });
      const filesAfter = fs.readdirSync(sheetPhotosDir);
      check('C2b①存储目录无残留新文件', filesAfter.filter((n) => !filesBefore.has(n)).length === 0, { filesBefore: [...filesBefore], filesAfter });
    }

    // 反例②：流式接收期间另一连接把单据归档 -> 最终409 SHEET_STATE。
    {
      const s = await buildSubmittedSheet(f, 'C2b-StreamArchive', 2);
      const rackId = s.scope.racks[0].id;
      const filesBefore = new Set(fs.readdirSync(sheetPhotosDir));
      const rowsBefore = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      const resp = await uploadPhotoChunked(f, s.id, 'rack_front', rackId, 2, MIN_JPEG_BYTES, async (hasResponded) => {
        check('C2b②前提:改状态前原上传请求确实尚未结束', hasResponded() === false);
        const archResp = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: s.id, expected_version: s.version }] }, 1);
        check('C2b②另一连接归档200', archResp.status === 200, archResp.body);
      });
      check('C2b②流式接收期间单据被归档,最终409 SHEET_STATE', resp.status === 409 && resp.body.code === 'SHEET_STATE', resp.body);
      const rowsAfter = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      check('C2b②照片表无新行', rowsAfter.length === rowsBefore.length, { rowsBefore, rowsAfter });
      const filesAfter = fs.readdirSync(sheetPhotosDir);
      check('C2b②存储目录无残留新文件', filesAfter.filter((n) => !filesBefore.has(n)).length === 0, { filesBefore: [...filesBefore], filesAfter });
    }

    // 反例③：流式接收期间另一连接收回上传者的写权限 -> 最终403 LEDGER_FORBIDDEN(assertWrite首句挡)。
    {
      const s = await buildDraftSheet(f, 'C2b-StreamRevokeAcl', 2);
      const rackId = s.scope.racks[0].id;
      const filesBefore = new Set(fs.readdirSync(sheetPhotosDir));
      const rowsBefore = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      const resp = await uploadPhotoChunked(f, s.id, 'rack_front', rackId, 2, MIN_JPEG_BYTES, async (hasResponded) => {
        check('C2b③前提:改状态前原上传请求确实尚未结束', hasResponded() === false);
        await f.run('DELETE FROM it_asset_acl WHERE user_id=2');
      });
      check('C2b③流式接收期间上传者写权限被收回,最终403 LEDGER_FORBIDDEN', resp.status === 403 && resp.body.code === 'LEDGER_FORBIDDEN', resp.body);
      const rowsAfter = await f.all('SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=?', [s.id]);
      check('C2b③照片表无新行', rowsAfter.length === rowsBefore.length, { rowsBefore, rowsAfter });
      const filesAfter = fs.readdirSync(sheetPhotosDir);
      check('C2b③存储目录无残留新文件', filesAfter.filter((n) => !filesBefore.has(n)).length === 0, { filesBefore: [...filesBefore], filesAfter });
      await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (2,'write',1)"); // 恢复，避免影响后续(本函数用独立fixture，其实不影响别处，仅为对称收尾)
    }
    check('G2A2探针: 写请求锁外SQL违规数精确为0', f.probeViolations().length === 0, f.probeViolations().slice(0, 10));
    check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
  } finally {
    await f.close();
  }
  console.log(`INSPECTION_PHOTOS_STREAM_RACE PASS=${pass}`);
}

// ============================================================
// C2f 任务1（spec-C2f.md 第1条，反向用例）：deps.inspectionSheetTestHooks（改写 unlink 行为）与
// deps.inspectionSheetReconcileNow（改写时钟）已改为只在 deps.enableTestHooks===true 时才真的生效
// （M8 闸收口）；两个只观察不改写的探针（inspectionSheetReconcileProbe/
// inspectionSheetReconcileResultProbe）也一并收进闸内。本函数验证闸关闭这一半：不传
// enableTestHooks 时，即使调用方传了这四个测试专用 deps 字段，也不该有任何可观察效果——真实删除
// 照常发生、时钟用真实 Date.now、两个探针一次都不会被调用。
// ============================================================
async function testEnableTestHooksGateBlocksInjectionWhenDisabled() {
  // --- Part A：queueUnlink 注入在未开闸时不生效，真实 fsp.unlink 照常执行 ---
  {
    // C2g-2（36-R2 M）：注入函数本身现在也计数——只看"最终文件状态像是没生效"不够：如果接缝其实被
    // 调用了、只是它抛出的异常被上层吞掉、随后又回退成真实操作，最终状态会一样"看起来没生效"，但
    // 那已经不是"闸把它挡在外面"，是另一种巧合。精确断言调用次数为0，才是"闸生效"本身的证据。
    const queueUnlinkCalls = { count: 0 };
    const sharedTestHooks = { queueUnlink: async () => { queueUnlinkCalls.count += 1; throw new Error('C2f-GateOff-A：这个函数不该被调用，因为没传 enableTestHooks'); } };
    // 故意不传 enableTestHooks——这正是本用例要验证的场景（对照 mainHttpTests 里 T-H2 那份必须
    // 显式传 enableTestHooks:true 才能让同一个注入点生效）。
    const f = await createFixture({ inspectionSheetTestHooks: sharedTestHooks });
    try {
      const s = await buildDraftSheet(f, 'C2f-GateOff-A', 2);
      const rackId = s.scope.racks[0].id;
      const first = await uploadPhoto(f, s.id, 'rack_front', rackId, 2, { bytes: MIN_PNG_BYTES, filename: 'gate-a-1.png', mime: 'image/png' });
      check('C2f-GateOff-A准备:首次上传201', first.status === 201, first.body);
      const storedName = (await f.all('SELECT stored_name FROM it_inspection_sheet_photos WHERE id=?', [first.body.photo.id]))[0].stored_name;
      const filePath = path.join(f.dir, 'sheet-photos', storedName);
      check('C2f-GateOff-A准备:文件已落盘', fs.existsSync(filePath));
      // 草稿替换：discardPhotoRow 把旧的 active 行删除+入队，响应之后 fire-and-forget 处理队列。
      const replace = await uploadPhoto(f, s.id, 'rack_front', rackId, 2, { bytes: MIN_WEBP_BYTES, filename: 'gate-a-2.webp', mime: 'image/webp' });
      check('C2f-GateOff-A替换201', replace.status === 201, replace.body);
      assert.equal((await deletePhoto(f,s.id,first.body.photo.id,2)).status,200);
      // 未开闸：注入的 queueUnlink（恒抛错）不该被调用，真实 fsp.unlink 应该正常执行——旧文件被
      // 真的删除，清理队列最终清空（没有因为假失败被卡住重试）。
      await waitFor(async () => (fs.existsSync(filePath) ? null : true), { label: 'C2f-GateOff-A文件被真实删除(证明queueUnlink注入被闸挡住)' });
      check('C2f-GateOff-A文件确实被删除(queueUnlink注入未生效,真实unlink执行了)', !fs.existsSync(filePath));
      // C2g-2：队列清空也改有界等待——unlink成功与队列行DELETE是processCleanupQueue里先后两步
      // （见该函数注释），文件消失那一刻队列行不一定已经删完，直接查一次会有竞态。
      await waitFor(async () => {
        const rows = await f.all('SELECT * FROM it_inspection_file_cleanup');
        return rows.length === 0 ? true : null;
      }, { label: 'C2f-GateOff-A清理队列最终清空' });
      const queueRows = await f.all('SELECT * FROM it_inspection_file_cleanup');
      check('C2f-GateOff-A清理队列为空(没有因假失败被卡住重试)', queueRows.length === 0, queueRows);
      check('C2f-GateOff-A注入的queueUnlink调用次数精确为0(闸真的挡住了,不是调用了但异常被吞掉又回退成真实操作)', queueUnlinkCalls.count === 0, queueUnlinkCalls);
    } finally {
      await f.close();
    }
  }

  // --- Part B：inspectionSheetReconcileNow 与两个探针在未开闸时都不生效 ---
  {
    const K = 3;
    const M = 2;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-ledger-photo-gateoff-clock-'));
    const dbFile = path.join(dir, 'fixture.db');
    const storageDir = path.join(dir, 'sheet-photos');
    fs.mkdirSync(storageDir, { recursive: true });
    const orphanNames = [];
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    for (let i = 0; i < K + M; i++) {
      const name = crypto.randomUUID() + '.bin';
      fs.writeFileSync(path.join(storageDir, name), MIN_JPEG_BYTES);
      fs.utimesSync(path.join(storageDir, name), twoHoursAgo, twoHoursAgo);
      orphanNames.push(name);
    }
    const logger = { info() {}, warn() {}, error(...a) { console.error('[ERROR]', ...a); } };
    const authenticateToken = (req, res, next) => { const uid = req.headers['x-test-user-id']; if (uid === undefined) return res.status(401).json({ error: '未登录' }); req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' }; next(); };
    const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: '权限不足' }));
    const ledgerFactory = require('../routes/it-ledger');
    let calls = 0;
    // 与 testReconcileStatPhaseClockInjection 同款假时钟：若真的生效，第 K+1 次检查起就会跳到
    // 10 分钟后触发提前停止；若被闸挡住（本用例期望），这个函数根本不会被调用。
    const fakeNow = () => { calls += 1; if (calls <= 1 + K) return Date.now(); return Date.now() + 10 * 60 * 1000; };
    const probeCalls = [];
    const resultProbeCalls = [];
    const ledger = ledgerFactory({
      logger, DB_FILE: dbFile, authenticateToken, requireAdmin, inspectionSheetStorageDir: storageDir,
      // 故意不传 enableTestHooks——本用例要验证的正是这三个注入点在闸关闭时统统不生效。
      inspectionSheetReconcileNow: fakeNow,
      inspectionSheetReconcileProbe: (info) => probeCalls.push(info),
      inspectionSheetReconcileResultProbe: (r) => resultProbeCalls.push(r),
    });
    await ledger.initSchema();
    try {
      check('C2f-GateOff-B两个探针都未被调用(闸关闭,观察类注入点也不生效)', probeCalls.length === 0 && resultProbeCalls.length === 0, { probeCalls, resultProbeCalls });
      // C2g-2：假时钟本身也精确计数为0——同一条理由，只看"文件是否幸存"不够精确（见 Part A 同名
      // 注释），必须证明这个函数真的一次都没被调用过，不是被调用后异常被吞掉又回退成真实Date.now。
      check('C2f-GateOff-B注入的假时钟(fakeNow)调用次数精确为0(闸真的挡住了)', calls === 0, { calls });
      // fakeNow 未生效 ⇒ 用的是真实 Date.now ⇒ 默认启动预算下 K+M 个候选应该正常检查完并全部删除
      // （不会像 C2e-3 那样在第 K+1 次检查看到假的"10分钟后"而提前停止、让文件幸存）。
      const survivedCount = orphanNames.filter((n) => fs.existsSync(path.join(storageDir, n))).length;
      check('C2f-GateOff-B全部候选文件都被真实清理(inspectionSheetReconcileNow注入未生效,用的是真实时钟)', survivedCount === 0, { survivedCount, total: orphanNames.length });
      check('C2f-GateOff-B初始化仍发布(state.ready===true)', ledger._internals.state.ready === true, ledger._internals.state);
    } finally {
      await ledger.shutdown();
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
    }
  }
  console.log(`INSPECTION_PHOTOS_GATE_OFF PASS=${pass}`);
}

// ============================================================
// C2f 任务2（spec-C2f.md 第2条）：T-H3 覆盖缺口——agent#2 交接摘要 §5 记录过，已提交单构造不出
// "某位置只有 pending、没有 active"这个场景（当时直接 SQL 删了 rack_front 与 item 两个位置的
// active 行，且 item 的 pending 早已被促成 active 后又被删，最终整单零照片，测不出"pending 误当
// active"这个缺口）。本函数只动 rack_front 一个位置、且从不触发任何 PUT/saveSubmittedEdit（§5.3
// 第4步只在成功的写事务内才会把 pending 促成 active），避免重蹈那个坑：
// 已提交单没有任何正常 API 路径能让一个 rack_front 位置"只剩 pending、没有 active"（提交前必须
// 全部 active；DELETE /photos/:id 对已提交单只允许删 pending，不允许删 active）——按派单说明的
// 例子，直接 SQL 删那一行 active，绕开正常写路径，构造这个覆盖缺口场景。
// ============================================================
async function testPendingPhotoNotCountedAsActiveProgress() {
  const f = await createFixture({ enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const s = await buildSubmittedSheet(f, 'C2f-T2-PendingCoverage', 2, 1);
    const rackId = s.scope.racks[0].id;
    const activeRow = (await f.all("SELECT id,stored_name FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND target_id=? AND state='active'", [s.id, rackId]))[0];
    check('T2准备:提交时该机柜正面照确实是active', !!activeRow, activeRow);

    // 已提交单再传同位置只会新增 pending，不会顶掉 active——先确认这一步没有意外把旧 active 顶掉，
    // 此刻该位置暂时同时有 active(旧) 与 pending(新) 两行。
    const pendingUp = await uploadPhoto(f, s.id, 'rack_front', rackId, 2, { bytes: MIN_WEBP_BYTES, filename: 't2-pending.webp', mime: 'image/webp' });
    check('T2准备:再次上传201且state=pending', pendingUp.status === 201 && pendingUp.body.photo.state === 'pending', pendingUp.body);
    const stillActive = (await f.all("SELECT id FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND target_id=? AND state='active'", [s.id, rackId]))[0];
    check('T2准备:旧active未被顶掉(submitted只新增pending,不同于draft替换)', !!stillActive && stillActive.id === activeRow.id, stillActive);

    // 直接 SQL 删除 active 行（绕开正常写路径与 discardPhotoRow，不入队、不连带 pending）；随后手动
    // 清理磁盘文件，避免污染后续目录对账类断言（agent#2 交接摘要 §6 坑3）。全程不发起任何 PUT/
    // submit 请求，pending 因此不会被自然促成 active。
    await f.run('DELETE FROM it_inspection_sheet_photos WHERE id=?', [activeRow.id]);
    const activeFilePath = path.join(f.dir, 'sheet-photos', activeRow.stored_name);
    if (fs.existsSync(activeFilePath)) fs.unlinkSync(activeFilePath);
    const nowState = await f.all("SELECT id,state FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='rack_front' AND target_id=?", [s.id, rackId]);
    check('T2准备:该位置此刻只剩pending一行,没有active', nowState.length === 1 && nowState[0].state === 'pending', nowState);

    // ---- 断言：详情 ----
    const detail = await getSheetAs(f, s.id, 2);
    check('T2详情200', detail.status === 200, detail.body);
    check('T2详情progress.photosUploaded不把该pending计入(仍为0,不是1)', detail.body.progress.photosUploaded === 0, detail.body.progress);
    check('T2详情missing_photo_positions仍含该机柜正面照位置', detail.body.progress.missing.missingPhotoPositions.some((p) => p.slot === 'rack_front' && p.target_id === rackId), detail.body.progress.missing.missingPhotoPositions);
    check('T2详情my_pending_photos含该pending照片', detail.body.my_pending_photos.some((p) => p.id === pendingUp.body.photo.id), detail.body.my_pending_photos);
    check('T2详情photos(active列表)不含该位置', !detail.body.photos.some((p) => p.slot === 'rack_front' && p.target_id === rackId), detail.body.photos);

    // ---- 断言：列表 ----
    const list = await f.api('GET', '/inspections/sheets?room=C2f-T2-PendingCoverage', undefined, 2);
    check('T2列表200', list.status === 200, list.body);
    const listRowForS = list.body.items.find((r) => r.id === s.id);
    check('T2列表能找到该单', !!listRowForS, list.body.items);
    check('T2列表photos_uploaded不把该pending计入(仍为0,不是1)', listRowForS.photos_uploaded === 0, listRowForS);
    check('T2列表photos_expected仍为1(该机柜正面照仍是"应传")', listRowForS.photos_expected === 1, listRowForS);
    check('G2A2探针: 写请求锁外SQL违规数精确为0', f.probeViolations().length === 0, f.probeViolations().slice(0, 10));
    check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
  } finally {
    await f.close();
  }
  console.log(`INSPECTION_PHOTOS_PENDING_COVERAGE PASS=${pass}`);
}

async function main() {
  await mainHttpTests();
  await testDirectoryReconciliation();
  await testReconcileDeadlineBudget();
  await testReconcileStatPhaseDeadlineBudget();
  await testReconcileStatPhaseClockInjection();
  await testReconcileNameListBudgetCheck();
  await testUploadAbortedInjection();
  await testDiscardQueueSameTransaction();
  await testStreamingUploadRace();
  await testEnableTestHooksGateBlocksInjectionWhenDisabled();
  await testPendingPhotoNotCountedAsActiveProgress();
  console.log(`INSPECTION_PHOTOS PASS=${pass} FAIL=0`);
}
main().catch((e) => { console.error(e.stack); console.log(`INSPECTION_PHOTOS PASS=${pass} FAIL=1`); process.exitCode = 1; });
