'use strict';
// C3（长任务 E · 巡检台账）接口层守卫：采集共用模块、巡检单采集、设备判断规则进完整性、
// it_device_inspections 两列与兼容、单独判断与附件 409、服务器历史归属展示、references() 扩展。
// 方案 SSOT = docs/local/信息化资产_轻量版/巡检台账改版_方案_20260923_v0.4.md §2.5/§3.1/§5.4
// 执行派单 = E:/tmp/insp-sheet-review/c3/spec-C3.md
//
// 与 verify-it-ledger-inspection-sheets.js/-photos.js 同款写法（各自独立运行，不互相 require），
// 用 createFixture() 打真实 HTTP。假采集器（fakeCollector）是本文件特有的：collect() 可编程返回
// success/partial/failed 快照、可在真正开始采集那一刻插一个回调（供"锁外窗口"race 测试用另一条
// 连接改数据）、可挂起等待手动释放（供"单飞共享"测试用）。不触发任何真实远程采集。
//
// G3A（41S/41T 审查订正保证边界，与另两个接口测试文件一致）→ G3A-b（M6：探针入口扩到
// assertWrite）：本文件的 G2A2 探针零违规断言保证范围只到"经 withRead / withWrite 注入的
// q.get/all/run/assertWrite 四个入口执行的 SQL"为止；路由（或其 require 的本地助手模块）自行
// 打开数据库连接不在探针可见范围内，由 R10 结构规则挡住（G3A-b M5 起覆盖 inspection-sheets.js /
// inspections.js / inspection-collect.js / inspection-photo-files.js 四个文件），不是"任何写法
// 都绕不过"。
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createFixture, isProbeViolation, normalizeInspectionRouteKey } = require('./it-ledger-browser-fixture');

let pass = 0;
function check(name, ok, detail) { if (!ok && detail !== undefined) console.error('DETAIL', name, JSON.stringify(detail)); assert.ok(ok, name); pass++; console.log('[OK] ' + name); }
// C7-e（codex 46-R，措辞降级）：单凭状态码===404判断"路由已退役"会假绿——路由哪怕仍注册着，也可能
// 因为其它原因（文件缺失/权限判定/内部404）走到业务层的404。这条只是辅助特征，不单独证明"路由不
// 存在"——主判据是 verify-it-ledger-inspection-sheets.js 里新增的运行时路由表全等断言（读 Express
// 自己的 router.stack，与源码怎么写路由无关）。这里核对的是 Express 默认404处理器的两个具体特征：
// content-type 为 text/html、body 含精确的 "Cannot <METHOD> <path>" 文案（finalhandler 的固定格式，
// 已用真实fixture实测过）——只有"非JSON+无业务code"太弱（业务处理器自己返回纯文本/HTML 404 也会
// 满足），改成核对这个更具体的固定文案，识别力更强，但仍然是辅助——一旦哪天 Express 升级换了默认
// 404 文案，这条会先坏，不能靠它顶替主判据。
function checkExpressDefault404(label, method, urlPath, contentType, bodyText) {
  const isHtml = /text\/html/i.test(contentType || '');
  const hasCannotLine = (bodyText || '').includes('Cannot ' + method + ' ' + urlPath);
  check('C7-e:' + label + '——响应具备Express默认404的具体特征(text/html且含"Cannot ' + method + ' ' + urlPath + '",辅助特征,主判据见inspection-sheets.js运行时路由表)', isHtml && hasCannotLine, { contentType, bodyText: (bodyText || '').slice(0, 300) });
}
// C3b L10：等一个 Promise 不能无界等——如果被等的事件因为某个回归永远不发生（比如单飞共享坏了，
// collect() 从未被真正调用到），测试应该在有限时间内明确判红，不是挂起到外层 spawnSync 超时被杀、
// 只留一个含糊的"进程超时"信号，看不出具体是哪个等待卡住了。
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`withTimeout(${label}): 超时(${timeoutMs}ms)未等到`)), timeoutMs); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const MIN_PNG_BYTES = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 1)]);
const HOST = '203.0.113.7'; // TEST-NET-3，安全的文档用途占位 IP，不指向真实设备。

// ============================================================
// 假采集器：host() 固定返回 HOST；collect() 行为由 ctrl 控制。
// ============================================================
function makeFakeCollector() {
  const state = { mode: 'success', onEnter: null, waitResolve: null, overrides: {}, entryWaiters: [] };
  const collector = {
    host: () => HOST,
    collect: async () => {
      // C3：每次真正进入 collect() 就唤醒一次"进入等待者"——单飞共享测试用它精确同步"第一个请求
      // 已经把 active 集合占住"这一刻（collectSnapshot() 的 active.add(a.host) 在调用 collect()
      // 之前就做了，见 inspection-collect.js），不靠"等一个固定时长"这种可能judge太早/太晚的猜测。
      const waiters = state.entryWaiters; state.entryWaiters = [];
      for (const resolve of waiters) resolve();
      if (state.onEnter) { const fn = state.onEnter; state.onEnter = null; await fn(); }
      if (state.mode === 'wait') { await new Promise((resolve) => { state.waitResolve = resolve; }); }
      if (state.mode === 'throw') throw new Error('模拟采集器异常');
      const now = new Date().toISOString();
      const snap = {
        schema_version: 1, source_host: HOST,
        server: { name: 'srv', manufacturer: 'x', model: 'y', serial_number: state.overrides.sn || 'FAKE-SN-001', os: 'Windows', memory_bytes: 0, cpus: [] },
        volumes: [], physical_disks: [], virtual_disks: [], enclosures: [],
        alerts: state.overrides.alerts || [], component_errors: [],
        cleanup_warnings: state.overrides.cleanupWarnings || [],
        collection_status: state.overrides.collectionStatus || 'success',
        started_at: now, completed_at: now,
      };
      if (state.mode === 'identity-mismatch') snap.server.serial_number = 'DIFFERENT-SN-999';
      return snap;
    },
  };
  return {
    collector,
    setMode(m) { state.mode = m; },
    setOverrides(o) { state.overrides = o; },
    setOnEnter(fn) { state.onEnter = fn; },
    // 返回一个 Promise，下一次 collect() 真正开始执行（active 已占住 host）时 resolve。
    waitUntilEntered() { return new Promise((resolve) => { state.entryWaiters.push(resolve); }); },
    release() { if (state.waitResolve) { const r = state.waitResolve; state.waitResolve = null; r(); } },
    reset() { state.mode = 'success'; state.onEnter = null; state.waitResolve = null; state.overrides = {}; state.entryWaiters = []; },
  };
}

// ============================================================
// 共享测试助手
// ============================================================
const createSheetAs = (f, uid, roomName) => f.api('POST', '/inspections/sheets', { room_name: roomName }, uid);
const getSheetAs = (f, sheetId, uid) => f.api('GET', '/inspections/sheets/' + sheetId, undefined, uid);
function fillPayloadAllOk(items, numberDefault) {
  return items.map((it) => (it.value_kind === 'number'
    ? { id: it.id, result: null, number_value: numberDefault[it.item_key] ?? 25, note: null }
    : { id: it.id, result: 'ok', number_value: null, note: null }));
}
const NUMBER_DEFAULT = { temperature: 22, humidity: 45 };
// 建一个带 1 机柜 + 1 台可采集服务器（sn+attrs.ip=HOST，category=server，in_service）的机房，
// 返回 {rack, device}——与 inspection-sheets/photos 测试文件里的 makeRoom() 不同，那边的设备不带
// sn/attrs.ip，采集不了。
async function makeCollectibleRoom(f, roomName, opts = {}) {
  const rack = (await f.api('POST', '/racks', { name: roomName + '-柜1', room: roomName, u_total: 20 })).body;
  const device = (await f.api('POST', '', {
    category: 'server', name: opts.deviceName || (roomName + '-设备1'), sn: opts.sn || ('SN-' + crypto.randomUUID().slice(0, 8)),
    attrs: { ip: HOST }, u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 },
  })).body;
  return { rack, device };
}
// 独立可采集资产（不属于任何巡检单范围，只给标准单独采集用）——必须挂机柜且 in_service，创建时
// depot 放置默认落 in_depot 状态，target() 要求 in_service，所以这里也走机柜安置（各自建一个专用
// 机柜，不与任何巡检单的房间共用，避免误入某张单的 device 范围）。
let standaloneAssetSeq = 0;
async function makeCollectibleAsset(f, opts = {}) {
  standaloneAssetSeq += 1;
  const rack = (await f.api('POST', '/racks', { name: 'C3-独立机柜-' + standaloneAssetSeq, room: 'C3-独立资产间', u_total: 20 })).body;
  return (await f.api('POST', '', {
    category: 'server', name: opts.deviceName || ('C3-独立设备-' + standaloneAssetSeq), sn: opts.sn || ('SN-STANDALONE-' + standaloneAssetSeq),
    attrs: { ip: HOST }, u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 },
  })).body;
}
async function buildDraftSheetWithDevice(f, roomName, ownerUid = 2, opts = {}) {
  const { rack, device } = await makeCollectibleRoom(f, roomName, opts);
  const created = await createSheetAs(f, ownerUid, roomName);
  assert.equal(created.status, 201, 'buildDraftSheetWithDevice ' + roomName + ' ' + JSON.stringify(created.body));
  return { sheet: created.body, rack, device };
}
function deviceItemOf(detailBody, deviceId) { return detailBody.items.find((it) => it.section === 'device' && it.target_id === deviceId); }
async function uploadAllRackFrontPhotos(f, sheetId, scope, uid) {
  for (const r of scope.racks) {
    const fd = new FormData();
    fd.append('slot', 'rack_front'); fd.append('target_id', String(r.id));
    fd.append('file', new Blob([MIN_PNG_BYTES], { type: 'image/png' }), 'p.png');
    const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd });
    assert.equal(resp.status, 201, 'uploadAllRackFrontPhotos');
  }
}
async function uploadItemPhoto(f, sheetId, targetId, uid) {
  const fd = new FormData();
  fd.append('slot', 'item'); fd.append('target_id', String(targetId));
  fd.append('file', new Blob([MIN_PNG_BYTES], { type: 'image/png' }), 'p.png');
  const resp = await fetch(f.base + '/api/it-assets/inspections/sheets/' + sheetId + '/photos', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd });
  return { status: resp.status, body: await resp.json() };
}
// C7（方案v0.6 §7）：设备巡检附件路由（POST /:kind/:recordId/evidence 等）已整体删除，任何请求都落
// Express默认404（HTML响应，不是JSON）——原实现对响应体无条件 .json() 解析，遇到这类404会直接抛出
// SyntaxError，而不是给出一条干净的失败断言（同 verify-it-ledger-evidence-browser.js 的 routeGone
// 手法要解决的同一个坑）。改为 .text()，本文件里这个helper此刻只剩一个调用方
// （testStandaloneGatedBySheetId），且必然只能探到404。
async function uploadEvidence(f, kind, recordId, uid, opts = {}) {
  const fd = new FormData();
  fd.append('phase', opts.phase || 'initial');
  fd.append('description', opts.description || '现场记录');
  fd.append('file', new Blob([opts.bytes || MIN_PNG_BYTES], { type: 'image/png' }), opts.filename || 'e.png');
  const urlPath = '/api/it-assets/inspections/' + kind + '/' + recordId + '/evidence';
  const resp = await fetch(f.base + urlPath, { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid }, body: fd });
  return { status: resp.status, method: 'POST', urlPath, contentType: resp.headers.get('content-type') || '', body: await resp.text() };
}
// C7：标准单独采集路由（POST /）已删除，同样落Express默认404 HTML——原来经 f.api() 派发，同样会在
// .json() 上抛异常，改走裸 fetch + .text()。本文件里凡是需要探测"这条已退役的路由确实404"的地方
// （而不是需要一条真实存在的历史采集记录做对照组，那种场景改用下面 seedStandaloneInspection）都用
// 这个函数。
async function collectStandalone(f, assetId, uid = 2) {
  const resp = await fetch(f.base + '/api/it-assets/inspections', { method: 'POST', headers: { Authorization: 'Bearer fixture-' + uid, 'Content-Type': 'application/json' }, body: JSON.stringify({ asset_id: assetId }) });
  return { status: resp.status, method: 'POST', urlPath: '/api/it-assets/inspections', contentType: resp.headers.get('content-type') || '', body: await resp.text() };
}
// C7：多处对照组测试（正向采集替换、草稿删除解除归属）此前用一条真实的标准单独采集记录（不挂任何
// 巡检单）证明"重新采集/删除只按id精确定位,不会误伤其它记录"——POST /退役后无法再用真实请求造出这类
// 记录，改为直接SQL插入一条同形状的历史行（sheet_id/detached_from_sheet_id均为NULL），语义上正好
// 对应方案v0.6 §6"不属于任何巡检单的历史记录,生产不存在,只有本地测试数据"这句——判别力不变：仍是
// 一条真实存在于it_device_inspections的、id不同于目标记录的行，仍能证明UPDATE按id/sheet_id精确
// 定位不会牵连它。返回值形状对齐原collectStandalone()成功时的{status:201,body:{id}}，下游既有的
// `.status===201`/`.body.id`断言不用改写（只改断言文案，见各调用点）。
async function seedStandaloneInspection(f, assetId, opts = {}) {
  await f.run(`CREATE TABLE IF NOT EXISTS it_device_inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, asset_name TEXT NOT NULL, source_host TEXT NOT NULL,
    started_at TEXT NOT NULL, completed_at TEXT NOT NULL, collection_status TEXT NOT NULL CHECK(collection_status IN ('success','partial','failed')),
    snapshot_json TEXT NOT NULL, requested_by INTEGER NOT NULL, judgement TEXT CHECK(judgement IN ('normal','attention')),
    judgement_note TEXT, reviewed_by INTEGER, reviewed_at TEXT,
    sheet_id INTEGER, detached_from_sheet_id INTEGER,
    CHECK((judgement IS NULL AND judgement_note IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (judgement IS NOT NULL AND judgement_note IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
    CHECK(sheet_id IS NULL OR detached_from_sheet_id IS NULL)
  )`);
  const now = new Date().toISOString();
  const snapshot = JSON.stringify({ schema_version: 1, source_host: HOST, server: { serial_number: opts.sn || ('LEGACY-SN-' + assetId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)) }, volumes: [], physical_disks: [], virtual_disks: [], enclosures: [], alerts: [], component_errors: [], cleanup_warnings: [], collection_status: 'success', started_at: now, completed_at: now });
  const ins = await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES(?,?,?,?,?,?,?,?)', [assetId, opts.assetName || ('legacy-standalone-' + assetId), HOST, now, now, 'success', snapshot, 1]);
  return { status: 201, body: { id: ins.lastID } };
}
async function collectOnSheet(f, sheetId, itemId, uid = 2) { return f.api('POST', '/inspections/sheets/' + sheetId + '/items/' + itemId + '/collect', undefined, uid); }

// ============================================================
// 1) 单飞集合（方案 §5.4 第一条；C7 前为"两入口单飞共享"，C7 之后标准单独采集入口已整体退役——
//    inspections.js 不再有任何写路由，模块局部的 active 集合此刻只被巡检单一个入口读写，"共享"这件
//    事本身不再可能出现两个入口互相排队的现象）。C7 把本函数改写为两件事：①证明标准单独采集入口
//    不论 host 忙不忙都是 404（route 已删除，与忙闲状态无关，不会因为巧合落回旧的 409），
//    ②证明单飞集合本身（按 host 判忙，不是按 asset/item）仍然对巡检单入口自己生效——两张不同草稿
//    单的两个 device 检查项指向同一个 host 时，先到的占住、后到的 409 INSPECTION_BUSY，这是原
//    Part B 里"用另一台设备触发巡检单采集确认判忙用的是host"这条判别力的延续，只是不再需要标准
//    单独采集作为对照的另一侧。
// ============================================================
async function testSingleFlightShared() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w1 = await buildDraftSheetWithDevice(f, 'C3-SF-1', 2);
    const detail1 = await getSheetAs(f, w1.sheet.id, 2);
    const item1 = deviceItemOf(detail1.body, w1.device.id);
    const other = await makeCollectibleAsset(f);

    // Part A：巡检单采集进行中（host忙），标准单独采集应 404（路由已删除，不是被单飞挡住的409——
    // 与host是否忙无关，即使巧合撞在忙的窗口内，命中的也只会是"路由不存在"这一层）。
    fc.setMode('wait');
    const entered1 = fc.waitUntilEntered();
    const sheetCollectPromise = collectOnSheet(f, w1.sheet.id, item1.id, 2);
    // C3b L10：有界等待——单飞一旦回归(比如active集合坏了)，collect() 可能永远不会被这次请求真正
    // 调用到，entered1 就永远不resolve；不加超时会一直挂起，只能等外层 spawnSync 超时被杀，看不出
    // 具体是哪一步卡住。超时本身就是一种"红"，不是把这条路径豁免掉。
    await withTimeout(entered1, 5000, '单飞A等待collect()真正进入');
    const standaloneWhileBusy = await collectStandalone(f, other.id, 2);
    check('单飞A(C7):巡检单采集进行中(host忙),标准单独采集仍是404而非409(路由已删除,不是被忙状态挡住)', standaloneWhileBusy.status === 404, standaloneWhileBusy.body);
    checkExpressDefault404('标准单独采集路由(host忙场景)', standaloneWhileBusy.method, standaloneWhileBusy.urlPath, standaloneWhileBusy.contentType, standaloneWhileBusy.body);
    fc.release();
    const sheetCollectResult = await withTimeout(sheetCollectPromise, 5000, '单飞A等待巡检单采集响应');
    check('单飞A:巡检单采集本身成功201', sheetCollectResult.status === 201, sheetCollectResult.body);
    fc.reset();

    // Part B（C7 改写）：两张不同草稿单的两个device检查项指向同一个host——单飞集合仍按host判忙，
    // 不是按asset/item，第二个请求409 INSPECTION_BUSY；这条判别力此前由"标准单独采集 vs 巡检单采集"
    // 互证，现在只剩巡检单一个入口，改成巡检单内部自己的两个请求互证同一条性质。
    const w2 = await buildDraftSheetWithDevice(f, 'C3-SF-2', 2);
    const detail2 = await getSheetAs(f, w2.sheet.id, 2);
    const item2 = deviceItemOf(detail2.body, w2.device.id);
    const w2b = await buildDraftSheetWithDevice(f, 'C3-SF-2b', 2);
    // buildDraftSheetWithDevice 内部固定用 attrs.ip=HOST（见 makeCollectibleRoom），sn 各自独立生成
    // 互不冲突——两张单的device各自代表不同资产，但采集器host()固定返回同一个HOST，单飞按host判忙
    // 天然会把这两个请求排到一起，不需要真的让两台资产的sn相同。
    const detail2b = await getSheetAs(f, w2b.sheet.id, 2);
    const item2b = deviceItemOf(detail2b.body, w2b.device.id);
    fc.setMode('wait');
    const entered2 = fc.waitUntilEntered();
    const firstSheetPromise = collectOnSheet(f, w2.sheet.id, item2.id, 2);
    await withTimeout(entered2, 5000, '单飞B等待collect()真正进入');
    const secondSheetWhileBusy = await collectOnSheet(f, w2b.sheet.id, item2b.id, 2);
    check('单飞B(C7):同host的另一张草稿单采集进行中,第二个巡检单请求409 INSPECTION_BUSY(单飞按host判忙,不是按asset/item)', secondSheetWhileBusy.status === 409 && secondSheetWhileBusy.body.code === 'INSPECTION_BUSY', secondSheetWhileBusy.body);
    fc.release();
    const firstSheetResult = await withTimeout(firstSheetPromise, 5000, '单飞B等待第一个巡检单采集响应');
    check('单飞B:第一个巡检单采集本身成功201', firstSheetResult.status === 201, firstSheetResult.body);
    fc.reset();

    // Part C（C7 改写）：采集结束后（host空闲），巡检单可以再采；标准单独采集依旧404（不会因为host
    // 空闲就"恢复正常"——它是路由层面被删除，不是被单飞状态挡住）。
    const w3 = await buildDraftSheetWithDevice(f, 'C3-SF-3', 2);
    const detail3 = await getSheetAs(f, w3.sheet.id, 2);
    const item3 = deviceItemOf(detail3.body, w3.device.id);
    const afterA = await collectOnSheet(f, w3.sheet.id, item3.id, 2);
    check('单飞C:采集结束后巡检单再采仍成功', afterA.status === 201, afterA.body);
    const other2 = await makeCollectibleAsset(f);
    const afterB = await collectStandalone(f, other2.id, 2);
    check('单飞C(C7):host空闲后标准单独采集仍404(退役是路由层面的,不因host状态变化而恢复)', afterB.status === 404, afterB.body);
    checkExpressDefault404('标准单独采集路由(host空闲场景)', afterB.method, afterB.urlPath, afterB.contentType, afterB.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_SINGLE_FLIGHT PASS=${pass}`);
}

// ============================================================
// 2) 锁外窗口复核（方案 §5.1 末条不可拆分条件的反例，C3 版）——假采集器 collect() 内部用另一条连接
//    把状态改掉，断言第二个写事务能拦下、不落库。
// ============================================================
async function testRaceWindowReverify() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    // 本测试每个子场景都在"第二个写事务复核失败、不落库"之前触发，it_device_inspections 表在
    // 这个夹具里可能还从未被任何一次成功采集懒建过——先查表是否存在，不存在按0计数，不直接查会
    // 报 SQLITE_ERROR: no such table。
    async function countDeviceInspections() {
      const exists = await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name='it_device_inspections'");
      if (!exists.length) return 0;
      return (await f.all('SELECT COUNT(*) n FROM it_device_inspections'))[0].n;
    }
    async function scenario(label, mutateFn, expectStatus, expectCodeCheck) {
      const w = await buildDraftSheetWithDevice(f, 'C3-Race-' + label, 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const beforeCount = await countDeviceInspections();
      fc.setOnEnter(mutateFn(w, item));
      const result = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check(`锁外窗口-${label}:状态码${expectStatus}`, result.status === expectStatus, result.body);
      check(`锁外窗口-${label}:错误码符合预期`, expectCodeCheck(result.body), result.body);
      const afterCount = await countDeviceInspections();
      check(`锁外窗口-${label}:it_device_inspections行数不变(未落库)`, afterCount === beforeCount, { beforeCount, afterCount });
      const itemAfter = (await f.all('SELECT device_inspection_id FROM it_inspection_sheet_items WHERE id=?', [item.id]))[0];
      check(`锁外窗口-${label}:该行device_inspection_id不变(仍为null)`, itemAfter.device_inspection_id === null, itemAfter);
      fc.reset();
    }

    await scenario('单据改submitted', (w) => async () => {
      // 直接 SQL 把单据置为已提交状态，绕开正常提交流程（本场景只关心"锁外这段时间单据状态变
      // 了"，不关心完整性——直接 SQL 改状态本来就绕开完整性校验，与其他"直接SQL造不可达状态"的
      // 既有测试手法一致）。
      const now = new Date().toISOString();
      await f.run('UPDATE it_inspection_sheets SET status=?,submitted_by=?,submitted_at=?,version=version+1,updated_at=? WHERE id=?', ['submitted', 1, now, now, w.sheet.id]);
    }, 409, (body) => body.code === 'SHEET_STATE');

    // 草稿单只有物理删除这一种删除形态（表级CHECK不允许status='draft'同时deleted_at非空——逻辑
    // 删除只对submitted/archived成立），直接SQL删行模拟"锁外这段时间单据被删掉"。
    await scenario('单据被物理删除', (w) => async () => {
      await f.run('DELETE FROM it_inspection_sheets WHERE id=?', [w.sheet.id]);
    }, 404, (body) => body.code === 'SHEET_NOT_FOUND');

    await scenario('资产改为非在用', (w) => async () => {
      await f.run("UPDATE it_assets SET status='retired' WHERE id=?", [w.device.id]);
    }, 409, (body) => body.code === 'SHEET_STATE');

    await scenario('调用者写权限被收回', (w) => async () => {
      await f.run('DELETE FROM it_asset_acl WHERE user_id=2');
    }, 403, (body) => body.code === 'LEDGER_FORBIDDEN');
    // 恢复 ACL，避免影响后续用例（本函数后面还会以 uid=2 继续操作）。
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (2,'write',1)");

    // C3b M5：锁外窗口内资产身份变了（sn 或 attrs.ip）——target() 本身仍能找到一台合格设备（换了
    // sn 后 category/status/host/sn 都还满足要求），但和第一阶段判资格时记录的身份不是同一台，
    // reverifyTarget() 的身份核对该拦；这条走的是本路由专属 SHEET_COLLECT_CONFLICT（reverifyTarget
    // 自己的判据映射而来，G1A 追加：不复用裸 VERSION_CONFLICT——那个 code 与前端全局错误表里资产
    // 台账主体的 VERSION_CONFLICT 撞名，语义不同，见 inspection-sheets.js 采集路由注释），不是
    // target() 本身判不合格那条 SHEET_STATE——M2 收紧之后两条必须能分清楚，这里钉的就是这个区分。
    await scenario('资产身份(sn)在锁外窗口被改变', (w) => async () => {
      await f.run('UPDATE it_assets SET sn=? WHERE id=?', ['SN-CHANGED-' + Date.now(), w.device.id]);
    }, 409, (body) => body.code === 'SHEET_COLLECT_CONFLICT');

    // C3c H2（codex 37S/37T）：锁外窗口内检查项的 target_id 被改指向另一台资产——即便新资产恰好
    // sn/host 都合格（reverifyTarget 单看 sn+host 判断不出区别），第二阶段也必须先核对"这一行是否
    // 还指向第一阶段判过资格的那台资产"，不相等就 409（同上，本路由专属 SHEET_COLLECT_CONFLICT）、
    // 不落库，不能让快照挂错资产。
    await scenario('检查项target_id在锁外窗口被改指向另一台资产', (w, item) => async () => {
      const other = await makeCollectibleAsset(f, { deviceName: 'C3c-Race-换绑目标' });
      // 关键：把新资产的 sn/attrs(ip) 改成与原资产完全一致——reverifyTarget 自己的 sn+host 比较
      // 在这种"恰好同 sn 同 host"的构造下判不出区别，必须靠新加的 target_id 比较才能拦下，这样
      // 才是真正隔离出"只有这条新判据在起作用"的场景。sn 有部分唯一索引（WHERE sn IS NOT
      // NULL），不能一步就餐两条行同时持有同一个 sn——先把原资产的 sn 让出去（模拟真实世界
      // "原设备换了个新编号"），再把新资产的 sn 改成原值（"旧编号被另一台设备顶替"），两条
      // UPDATE 各自都不违反唯一索引。
      const deviceRow = (await f.all('SELECT sn,attrs FROM it_assets WHERE id=?', [w.device.id]))[0];
      await f.run('UPDATE it_assets SET sn=? WHERE id=?', ['SN-VACATED-' + Date.now(), w.device.id]);
      await f.run('UPDATE it_assets SET sn=?,attrs=? WHERE id=?', [deviceRow.sn, deviceRow.attrs, other.id]);
      await f.run('UPDATE it_inspection_sheet_items SET target_id=? WHERE id=?', [other.id, item.id]);
    }, 409, (body) => body.code === 'SHEET_COLLECT_CONFLICT');

    // G1A-b M6：锁外窗口内检查项的 target_id 被改指向一台"不可采集"的资产（retired）——修复前
    // （单一 checkCollectable 函数）第二阶段会先判新资产的资格，资产不合格就先给出 409
    // SHEET_STATE，掩盖了更具体的"检查项已指向另一台资产"这个原因；修复后 target_id 比对排在
    // 资产资格判定之前，即使新资产本身不合格，也该报同一个 409 SHEET_COLLECT_CONFLICT（与上面
    // 两条 target_id/身份变化场景口径一致），不应该报 SHEET_STATE。
    await scenario('检查项target_id在锁外窗口被改指向一台不可采集的资产', (w, item) => async () => {
      const ineligible = await makeCollectibleAsset(f, { deviceName: 'M6-Race-不可采集目标' });
      await f.run("UPDATE it_assets SET status='retired' WHERE id=?", [ineligible.id]);
      await f.run('UPDATE it_inspection_sheet_items SET target_id=? WHERE id=?', [ineligible.id, item.id]);
    }, 409, (body) => body.code === 'SHEET_COLLECT_CONFLICT');

    // C3c（37T 补测）：只有 host 身份变化的反例——37S/37T 审阅担心"若实现漏掉 host 比较，只改
    // sn 那一例测不出来"；reverifyTarget 现有代码本身已经是 `current.sn!==first.sn ||
    // current.host!==first.host` 两条都判（inspection-collect.js:42），这里补一条只变 host（sn
    // 不变）的独立反例，证明 host 这一半判据也真的在生效，不是靠 sn 那一半侥幸兜住。同步改资产
    // 登记的 attrs.ip 与假采集器的 host()，让 target() 本身仍判"合格"（否则会先撞成资产不合格的
    // 409 SHEET_STATE，测不出 host 不一致这条），但与第一阶段记录的 host 不同。
    const raceHostOriginal = fc.collector.host;
    await scenario('仅host身份(IP)在锁外窗口被改变(sn不变)', (w) => async () => {
      const newHost = '203.0.113.77';
      const row = (await f.all('SELECT attrs FROM it_assets WHERE id=?', [w.device.id]))[0];
      const attrs = JSON.parse(row.attrs || '{}');
      await f.run('UPDATE it_assets SET attrs=? WHERE id=?', [JSON.stringify({ ...attrs, ip: newHost }), w.device.id]);
      fc.collector.host = () => newHost;
    }, 409, (body) => body.code === 'SHEET_COLLECT_CONFLICT');
    fc.collector.host = raceHostOriginal; // 恢复，避免影响后面的场景（同 M2 场景一致的收尾写法）。

    // C3b M2（补充，复核发现原 testM2OnlyBusinessErrorsRemapped 未踩在真正的判据上）：那个测试全程
    // 让 collector.host() 抛错，第一阶段 checkCollectable 里的 target() 调用会先撞上，第一个
    // withWrite 直接把这个无 status 的原始错误抛出去（G1A 之前是"记下来延后到第二阶段再抛"，G1A
    // 之后是"第一阶段这次调用本身就直接失败"，两种写法最终都落到路由最外层 catch(e){handleErr}，
    // 表现一致），根本不会走到 reverifyTarget 自己的 catch——那个测试实际验证的是"第一阶段的原始
    // 错误被重新抛出时没有被中途裹坏"，不是M2这段"reverifyTarget的异常按业务/意外分类"本身。要真正
    // 踩在M2这段判据上，必须让第一阶段成功，只在锁外
    // 窗口内、collectSnapshot()与第二阶段reverifyTarget()之间这段时间把host()换成会抛无status异常
    // 的版本——这样第一阶段用的是原host()（已经成功），第二阶段reverifyTarget内部再次调用target()
    // 时才会撞上这个新host()，真正触发1216-1224行的分类逻辑（无.status/.code，不在{400,404,409}
    // 集合，也不是VERSION_CONFLICT——落到最后一条"throw e"原样抛出，应为500而非被误判成409）。
    const originalHost = fc.collector.host;
    await scenario('第二阶段host()内部故障(无status,不应被误判成409-真正踩在M2判据上)', (w) => async () => {
      fc.collector.host = () => { throw new Error('模拟collector.host()锁外窗口内部故障(无status)'); };
    }, 500, (body) => body.code === 'LEDGER_INTERNAL');
    fc.collector.host = originalHost; // 恢复，防止污染理论上可能追加在后面的场景（当前是最后一条，双重保险）。

    // C7-b（用户2026-09-25 22:xx裁定，verify-it-ledger-records-browser.js退役清理迁移）：锁外窗口
    // 内资产被作废/删除——record-management.js的void/delete动作往it_asset_record_controls插入
    // 一行控制行；target()（inspection-collect.js:31）第一行就是
    // recordManagement.assertActive(q,assetId)，第二阶段reverifyTarget()内部再次调用target()时会
    // 撞上这行控制行，抛一个status:409/code:'ASSET_RECORD_INACTIVE'的Error。**实测订正**：这个
    // Error 并不会原样透出给调用方——inspection-sheets.js:1246附近的catch块把 reverifyTarget 抛出
    // 的、status落在[400,404,409]集合里的业务错误（除专属映射的VERSION_CONFLICT外）统一收窄映射成
    // 409 SHEET_STATE（该处注释原文："target()/assertActive()自己认得出的业务错误...映射成统一的
    // 409 SHEET_STATE"）——与"资产改为非在用"场景（上面308-310行,status='retired'）观测到的HTTP
    // 契约完全一致，都是409 SHEET_STATE，不是像最初设想的那样能观测到ASSET_RECORD_INACTIVE透传。
    // 即便如此，这条场景仍有独立判别力：它走的是target()内部assertActive()这一条判定分支（读
    // it_asset_record_controls表），不是"资产改为非在用"场景走的status列判定分支——两条分支目前
    // 汇合到同一个映射结果，但底层代码路径不同，一旦将来这段映射逻辑改动（比如给ASSET_RECORD_
    // INACTIVE开专属分支），这条场景能第一时间测出行为差异，不是纯重复。这条性质此前只能在已退役的
    // 标准单独采集入口上，通过一套真实的disk_unmount(拆随装盘)+rack_out(下架)+void(作废)动作序列
    // 间接测到（原verify-it-ledger-records-browser.js:108-114，POST /inspections+等待released构造
    // 锁外窗口）；该入口整体退役后，这里改为直接在巡检单采集入口上构造"锁外窗口内资产被作废/删除"
    // 这个最小充分条件——不需要先拆盘/下架，作废/删除这一步本身单独就能触发assertActive，拆盘/下架
    // 只是让void/delete这个动作本身能通过它自己的写前置条件（"有随装盘不能作废"等），不是reverify
    // 这条判据要验证的内容，所以直接SQL插控制行，不经过真实的disk_unmount/rack_out/void三段动作
    // 序列。与其它场景一致，直接SQL造状态（不经过真实manage()调用），表与触发器DDL取自
    // record-management.js:ensure()原文（懒建表，先CREATE TABLE/TRIGGER IF NOT EXISTS再插控制行）。
    const ensureRecordControls = async () => {
      await f.run(`CREATE TABLE IF NOT EXISTS it_asset_record_controls(asset_id INTEGER PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('voided','deleted')),reason TEXT NOT NULL,operator_id INTEGER NOT NULL,created_at TEXT NOT NULL)`);
      await f.run(`CREATE TRIGGER IF NOT EXISTS it_record_block_update BEFORE UPDATE ON it_assets WHEN EXISTS(SELECT 1 FROM it_asset_record_controls WHERE asset_id=OLD.id) BEGIN SELECT RAISE(ABORT,'ASSET_RECORD_INACTIVE'); END`);
      await f.run(`CREATE TRIGGER IF NOT EXISTS it_record_block_parent_insert BEFORE INSERT ON it_assets WHEN EXISTS(SELECT 1 FROM it_asset_record_controls WHERE asset_id=NEW.parent_asset_id) BEGIN SELECT RAISE(ABORT,'ASSET_RECORD_INACTIVE'); END`);
      await f.run(`CREATE TRIGGER IF NOT EXISTS it_record_block_parent_update BEFORE UPDATE ON it_assets WHEN EXISTS(SELECT 1 FROM it_asset_record_controls WHERE asset_id=NEW.parent_asset_id) BEGIN SELECT RAISE(ABORT,'ASSET_RECORD_INACTIVE'); END`);
    };
    await scenario('资产在锁外窗口被作废(record-management控制行state=voided,assertActive挡→映射409 SHEET_STATE)', (w) => async () => {
      await ensureRecordControls();
      await f.run('INSERT INTO it_asset_record_controls(asset_id,state,reason,operator_id,created_at) VALUES(?,?,?,?,?)', [w.device.id, 'voided', 'C7-b锁外窗口作废测试', 1, new Date().toISOString()]);
    }, 409, (body) => body.code === 'SHEET_STATE');
    await scenario('资产在锁外窗口被删除(record-management控制行state=deleted,assertActive挡→映射409 SHEET_STATE)', (w) => async () => {
      await ensureRecordControls();
      await f.run('INSERT INTO it_asset_record_controls(asset_id,state,reason,operator_id,created_at) VALUES(?,?,?,?,?)', [w.device.id, 'deleted', 'C7-b锁外窗口删除测试', 1, new Date().toISOString()]);
    }, 409, (body) => body.code === 'SHEET_STATE');
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_RACE_WINDOW PASS=${pass}`);
}

// ============================================================
// 3) 正向：草稿采集成功，插入行带 sheet_id；同一行重复采集，旧记录解除归属（sheet_id NULL、
//    detached_from_sheet_id 为本单），新记录接上（item.device_inspection_id 指向新记录）。
// ============================================================
async function testPositiveCollectAndReplace() {
  const fc = makeFakeCollector();
  // G2A2（长任务 E 段2）：运行时锁外读库探针——本套件是采集路由(collect)最完整的正向流程，是
  // spec 变异自检①"采集路由第一阶段 checkSheetAndItem 改成 withRead 执行"的目标套件，见文件尾
  // 断言。
  const sqlProbeRecords = [];
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: (rec) => sqlProbeRecords.push(rec) });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3-Positive', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    check('正向准备:该行初始未关联采集', item.device_inspection_id === null || item.device_inspection_id === undefined, item);

    // C3d 第6条（37T）：既有 M7 对照组（下方）全部用不同资产，测不出"按 asset_id 而非 id 精确
    // 定位"这类回归——同一资产的其它记录理论上也该被误伤，但对照组从没覆盖过这种情况。这里先补
    // 两条同资产对照：①标准单独采集（不挂任何单）②另一张单(同资产，直接SQL把检查项target_id
    // 改指到本资产，复用C3c H2场景已验证过的手法)，全程贯穿本测试目标行经历的两次detach。
    // C7：标准单独采集入口已退役，这条对照记录改用 seedStandaloneInspection 直接SQL插入（见该函数
    // 注释）——不再需要 fc.setOverrides 配合假采集器身份校验。
    const sameAssetStandalone = await seedStandaloneInspection(f, w.device.id);
    check('同资产对照组准备:历史独立记录已插入(标准单独采集已退役,直接SQL造数)', sameAssetStandalone.status === 201, sameAssetStandalone.body);
    const w4 = await buildDraftSheetWithDevice(f, 'C3-Positive-SameAssetSheet', 2);
    const detailW4 = await getSheetAs(f, w4.sheet.id, 2);
    const itemW4 = deviceItemOf(detailW4.body, w4.device.id);
    await f.run('UPDATE it_inspection_sheet_items SET target_id=? WHERE id=?', [w.device.id, itemW4.id]);
    const collectW4 = await collectOnSheet(f, w4.sheet.id, itemW4.id, 2);
    check('同资产跨单对照组准备:另一张单(同资产)采集201', collectW4.status === 201, collectW4.body);
    const sameAssetIds = { standalone: sameAssetStandalone.body.id, crossSheet: collectW4.body.inspection.id };
    const sameAssetBefore = {};
    for (const key of Object.keys(sameAssetIds)) sameAssetBefore[key] = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [sameAssetIds[key]]))[0];

    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn, alerts: [], cleanupWarnings: [], collectionStatus: 'success' });
    const first = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('正向:首次采集201', first.status === 201, first.body);
    check('正向:响应含inspection.id与sheet_id', !!first.body.inspection && first.body.inspection.sheet_id === w.sheet.id, first.body);
    check('正向:响应item.device_inspection_id指向该记录', first.body.item.device_inspection_id === first.body.inspection.id, first.body);
    const firstId = first.body.inspection.id;
    const firstRow = (await f.all('SELECT * FROM it_device_inspections WHERE id=?', [firstId]))[0];
    check('正向:落库sheet_id正确', firstRow.sheet_id === w.sheet.id, firstRow);
    check('正向:落库detached_from_sheet_id为空', firstRow.detached_from_sheet_id === null, firstRow);
    check('正向:落库不带版本变化(单据version未变)', (await getSheetAs(f, w.sheet.id, 2)).body.version === w.sheet.version, (await getSheetAs(f, w.sheet.id, 2)).body);

    // 同一行重复采集。
    const second = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('正向:重复采集201', second.status === 201, second.body);
    const secondId = second.body.inspection.id;
    check('正向:重复采集产生新记录(id不同)', secondId !== firstId, { firstId, secondId });
    const firstAfter = (await f.all('SELECT * FROM it_device_inspections WHERE id=?', [firstId]))[0];
    check('正向:旧记录sheet_id被置空', firstAfter.sheet_id === null, firstAfter);
    check('正向:旧记录detached_from_sheet_id指向本单', firstAfter.detached_from_sheet_id === w.sheet.id, firstAfter);
    const itemAfter = (await f.all('SELECT device_inspection_id FROM it_inspection_sheet_items WHERE id=?', [item.id]))[0];
    check('正向:该行device_inspection_id指向新记录', itemAfter.device_inspection_id === secondId, itemAfter);
    const secondRow = (await f.all('SELECT * FROM it_device_inspections WHERE id=?', [secondId]))[0];
    check('正向:新记录sheet_id正确、detached为空', secondRow.sheet_id === w.sheet.id && secondRow.detached_from_sheet_id === null, secondRow);

    // C3b M7：解除归属对照组——同单另一台设备、另一张单、以及一条标准单独采集记录，证明"重复采集
    // 只解除目标那一条的归属，不会牵连其他记录"（UPDATE 语句按 id=? 精确定位，理论上不该牵连，
    // 但这条防的是"WHERE 条件写错成按 sheet_id 或 target_id 批量改"这类回归）。
    const roomM7 = 'C3-Positive-M7';
    const rackM7 = (await f.api('POST', '/racks', { name: roomM7 + '-柜1', room: roomM7, u_total: 20 })).body;
    const deviceA = (await f.api('POST', '', { category: 'server', name: roomM7 + '-设备A', sn: 'SN-M7-A-' + Date.now(), attrs: { ip: HOST }, u_height: 1, placement: { kind: 'rack', rack_id: rackM7.id, u_start: 1 } })).body;
    const deviceB = (await f.api('POST', '', { category: 'server', name: roomM7 + '-设备B', sn: 'SN-M7-B-' + Date.now(), attrs: { ip: HOST }, u_height: 1, placement: { kind: 'rack', rack_id: rackM7.id, u_start: 2 } })).body;
    const sheetM7 = (await createSheetAs(f, 2, roomM7)).body;
    const detailM7 = await getSheetAs(f, sheetM7.id, 2);
    const itemA = deviceItemOf(detailM7.body, deviceA.id);
    const itemB = deviceItemOf(detailM7.body, deviceB.id);
    // 同单两台设备各采一次。
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [deviceA.id]))[0].sn });
    const collectA = await collectOnSheet(f, sheetM7.id, itemA.id, 2);
    check('M7对照组准备:设备A采集201', collectA.status === 201, collectA.body);
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [deviceB.id]))[0].sn });
    const collectB = await collectOnSheet(f, sheetM7.id, itemB.id, 2);
    check('M7对照组准备:设备B采集201', collectB.status === 201, collectB.body);
    // 另一张单(w2)也采一次。
    const w2 = await buildDraftSheetWithDevice(f, 'C3-Positive-M7-Other', 2);
    const detailW2 = await getSheetAs(f, w2.sheet.id, 2);
    const itemW2 = deviceItemOf(detailW2.body, w2.device.id);
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w2.device.id]))[0].sn });
    const collectW2 = await collectOnSheet(f, w2.sheet.id, itemW2.id, 2);
    check('M7对照组准备:另一张单采集201', collectW2.status === 201, collectW2.body);
    // 一条历史独立记录(不挂任何sheet；C7标准单独采集入口已退役,改用seedStandaloneInspection直接
    // SQL插入)。
    const standaloneDevice = await makeCollectibleAsset(f);
    const collectStandaloneResp = await seedStandaloneInspection(f, standaloneDevice.id);
    check('M7对照组准备:历史独立记录已插入', collectStandaloneResp.status === 201, collectStandaloneResp.body);
    const controlIds = { A: collectA.body.inspection.id, B: collectB.body.inspection.id, W2: collectW2.body.inspection.id, standalone: collectStandaloneResp.body.id };
    const controlBefore = {};
    for (const key of Object.keys(controlIds)) controlBefore[key] = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [controlIds[key]]))[0];

    // 触发目标行(w/item)的第三次采集——重复采集只应解除 w/item 这一条(secondId)的归属，不牵连上面
    // 四条对照记录。
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn });
    const third = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('M7:目标行第三次采集201', third.status === 201, third.body);
    for (const key of Object.keys(controlIds)) {
      const after = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [controlIds[key]]))[0];
      check(`M7对照组:重复采集后非目标记录[${key}]的sheet_id/detached_from_sheet_id两列不变`, after.sheet_id === controlBefore[key].sheet_id && after.detached_from_sheet_id === controlBefore[key].detached_from_sheet_id, { key, before: controlBefore[key], after });
    }
    // C3d 第6条：同资产的标准单独采集、同资产跨单采集，经历目标行两次detach(second替换first、
    // third替换second)全程后，两列仍应与最初一致——真正排除"UPDATE按asset_id而非id批量生效"。
    for (const key of Object.keys(sameAssetIds)) {
      const after = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [sameAssetIds[key]]))[0];
      check(`同资产对照组:目标行两次detach后同资产记录[${key}]的sheet_id/detached_from_sheet_id两列不变`, after.sheet_id === sameAssetBefore[key].sheet_id && after.detached_from_sheet_id === sameAssetBefore[key].detached_from_sheet_id, { key, before: sameAssetBefore[key], after });
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
      // M2（G2A2b 必修）：逐路由接通断言——本文件(testPositiveCollectAndReplace)覆盖collect路由。
      const collectSeenRouteKeys = new Set(sqlProbeRecords.filter((r) => r.writeRequest === true).map((r) => normalizeInspectionRouteKey(r.method, r.path)));
      check('M2逐路由接通: post:/:id/items/:itemId/collect 存在writeRequest:true的探针记录', collectSeenRouteKeys.has('post:/:id/items/:itemId/collect'), [...collectSeenRouteKeys]);
    }
  } finally {
    fc.release();
    await f.close();
  }
  console.log(`INSPECTION_COLLECT_POSITIVE PASS=${pass}`);
}

// ============================================================
// 4) 负向：非 draft（submitted/archived/已删除）、非本单的行、非 device 段的行、他人草稿（非管理员）
//    →各自的拒绝码。G1A 之后 checkCollectable 在第一阶段就把这六类原因全部判齐（不再有"部分原因
//    留到第二阶段才判"的区分），全部在第一次尝试就被拒绝、不发起真实采集——本函数只钉状态码/code，
//    更完整的"状态码+响应体逐字段+假采集器调用次数+库内行数不变"四件套断言见
//    testFirstStageRejectionsNoCollection。
// ============================================================
async function testNegativeValidation() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    // 非本单的行：拿A单的item id去打B单的collect端点。
    const wa = await buildDraftSheetWithDevice(f, 'C3-Neg-A', 2);
    const wb = await buildDraftSheetWithDevice(f, 'C3-Neg-B', 2);
    const detailA = await getSheetAs(f, wa.sheet.id, 2);
    const itemA = deviceItemOf(detailA.body, wa.device.id);
    const crossSheet = await collectOnSheet(f, wb.sheet.id, itemA.id, 2);
    check('负向:非本单的行404 SHEET_ITEM_NOT_FOUND', crossSheet.status === 404 && crossSheet.body.code === 'SHEET_ITEM_NOT_FOUND', crossSheet.body);

    // 非device段的行：room/rack段的检查项id去打collect端点。
    // G1A-b：checkSheetAndItem 里的检查项查询本身就带 `AND section='device'`，room段item在第一阶段
    // （第一次withWrite，checkSheetAndItem+assertCollectableAsset那一次）就查不到，直接404
    // SHEET_ITEM_NOT_FOUND，第二阶段根本不会执行，不会走到资产判定那一步。
    const roomItem = detailA.body.items.find((it) => it.section === 'room');
    const notDevice = await collectOnSheet(f, wa.sheet.id, roomItem.id, 2);
    check('负向:非device段的行404 SHEET_ITEM_NOT_FOUND(被第一阶段的device段过滤挡住)', notDevice.status === 404 && notDevice.body.code === 'SHEET_ITEM_NOT_FOUND', notDevice.body);

    // 已提交状态：正常走 submit（先补全整单，含设备行判ok+全部照片，再提交）。
    const put = await f.api('PUT', '/inspections/sheets/' + wa.sheet.id, { expected_version: wa.sheet.version, items: fillPayloadAllOk(detailA.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('负向准备:PUT补全200', put.status === 200, put.body);
    await uploadAllRackFrontPhotos(f, wa.sheet.id, wa.sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + wa.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('负向准备:提交200', submit.status === 200, submit.body);
    const submittedCollect = await collectOnSheet(f, wa.sheet.id, itemA.id, 2);
    check('负向:非draft(submitted)409 SHEET_STATE', submittedCollect.status === 409 && submittedCollect.body.code === 'SHEET_STATE', submittedCollect.body);

    // 已归档状态：管理员批量归档。
    const archive = await f.api('POST', '/inspections/sheets/archive', { items: [{ id: wa.sheet.id, expected_version: submit.body.version }] }, 1);
    check('负向准备:归档200', archive.status === 200, archive.body);
    const archivedCollect = await collectOnSheet(f, wa.sheet.id, itemA.id, 2);
    check('负向:非draft(archived)409 SHEET_STATE', archivedCollect.status === 409 && archivedCollect.body.code === 'SHEET_STATE', archivedCollect.body);

    // 已逻辑删除（先撤回归档回submitted，再逻辑删除）。
    const unarchive = await f.api('POST', '/inspections/sheets/' + wa.sheet.id + '/unarchive', { expected_version: archive.body.archived.length ? (await getSheetAs(f, wa.sheet.id, 1)).body.version : null, reason: '撤回测试' }, 1);
    check('负向准备:撤回归档200', unarchive.status === 200, unarchive.body);
    const del = await f.api('DELETE', '/inspections/sheets/' + wa.sheet.id, { expected_version: unarchive.body.version, reason: '逻辑删除测试' }, 1);
    check('负向准备:逻辑删除200', del.status === 200, del.body);
    const deletedCollect = await collectOnSheet(f, wa.sheet.id, itemA.id, 1);
    check('负向:已逻辑删除404 SHEET_NOT_FOUND', deletedCollect.status === 404 && deletedCollect.body.code === 'SHEET_NOT_FOUND', deletedCollect.body);

    // 他人草稿（非管理员）：uid=2建的草稿，uid=5（写权限但非管理员非本单巡检人）来采集。
    const wc = await buildDraftSheetWithDevice(f, 'C3-Neg-C', 2);
    const detailC = await getSheetAs(f, wc.sheet.id, 2);
    const itemC = deviceItemOf(detailC.body, wc.device.id);
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    const othersDraft = await collectOnSheet(f, wc.sheet.id, itemC.id, 5);
    check('负向:他人草稿(非管理员)403 SHEET_FORBIDDEN', othersDraft.status === 403 && othersDraft.body.code === 'SHEET_FORBIDDEN', othersDraft.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_NEGATIVE PASS=${pass}`);
}

// ============================================================
// 5) 设备规则进完整性（方案 §3.1 最后一条）：failed 时判正常→400 且缺项清单指明该行；partial/
//    alerts/cleanup_warnings 非空时判正常无说明→400，有说明→通过；已提交单「保存修改」同样生效。
// ============================================================
async function testDeviceRuleFeedsCompleteness() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    async function submitWith(w, item, patch) {
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const items = fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT).map((it) => (it.id === item.id ? { ...it, ...patch } : it));
      const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail.body.version, items, remark: null }, 2);
      assert.equal(put.status, 200, 'submitWith PUT ' + JSON.stringify(put.body));
      await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
      return f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    }

    // --- A：collection_status='failed'，device行判正常(ok)→400，缺项清单指明该行 ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-A', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'failed' });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则A准备:采集201且collection_status=failed', collectResp.status === 201 && collectResp.body.inspection.collection_status === 'failed', collectResp.body);
      const rejectNormal = await submitWith(w, item, { result: 'ok', number_value: null, note: null });
      check('设备规则A:failed判正常提交400', rejectNormal.status === 400 && rejectNormal.body.code === 'SHEET_INCOMPLETE', rejectNormal.body);
      check('设备规则A:缺项清单device_issue_item_ids含该行', Array.isArray(rejectNormal.body.detail.device_issue_item_ids) && rejectNormal.body.detail.device_issue_item_ids.includes(item.id), rejectNormal.body.detail);
      // 改判异常(bad)+说明+该行照片→应该能提交通过(device规则只管"判正常"这一支，异常不受限)。
      const detail2 = await getSheetAs(f, w.sheet.id, 2);
      const put2 = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail2.body.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT).map((it) => (it.id === item.id ? { ...it, result: 'bad', note: '面板告警灯异常' } : it)), remark: null }, 2);
      check('设备规则A准备:改判异常200', put2.status === 200, put2.body);
      await uploadItemPhoto(f, w.sheet.id, item.id, 2);
      await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
      const acceptAbnormal = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put2.body.version }, 2);
      check('设备规则A:改判异常后提交200', acceptAbnormal.status === 200, acceptAbnormal.body);
    }

    // --- B：collection_status='partial'，device行判正常无说明→400；有说明→通过 ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-B', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'partial' });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则B准备:采集201且collection_status=partial', collectResp.status === 201 && collectResp.body.inspection.collection_status === 'partial', collectResp.body);
      const rejectNoNote = await submitWith(w, item, { result: 'ok', number_value: null, note: null });
      check('设备规则B:partial判正常无说明提交400', rejectNoNote.status === 400 && rejectNoNote.body.code === 'SHEET_INCOMPLETE', rejectNoNote.body);
      check('设备规则B:缺项清单device_issue_item_ids含该行', rejectNoNote.body.detail.device_issue_item_ids.includes(item.id), rejectNoNote.body.detail);
      const acceptWithNote = await submitWith(w, item, { result: 'ok', number_value: null, note: '本次采集不完整，人工目视确认前面板正常' });
      check('设备规则B:partial判正常有说明提交200', acceptWithNote.status === 200, acceptWithNote.body);
    }

    // --- C：alerts 非空（collection_status仍可为success），判正常无说明→400 ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-C', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'success', alerts: [{ severity: 'attention', kind: 'volume_space', message: '卷C 可用空间 5%' }] });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则C准备:采集201且alerts非空', collectResp.status === 201 && Array.isArray(collectResp.body.inspection.snapshot.alerts) && collectResp.body.inspection.snapshot.alerts.length === 1, collectResp.body);
      const rejectNoNote = await submitWith(w, item, { result: 'ok', number_value: null, note: null });
      check('设备规则C:alerts非空判正常无说明提交400', rejectNoNote.status === 400 && rejectNoNote.body.detail.device_issue_item_ids.includes(item.id), rejectNoNote.body);
      const acceptWithNote = await submitWith(w, item, { result: 'ok', number_value: null, note: '告警已现场核实为误报' });
      check('设备规则C:alerts非空判正常有说明提交200', acceptWithNote.status === 200, acceptWithNote.body);
    }

    // --- C3b M3：collection_status='failed'，device行判正常(ok)+有非空说明→仍400(failed这条规则
    //    不看note，第一条规则无条件拒绝判正常，不是"没说明才拒绝") ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-M3', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'failed' });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则M3准备:采集201且collection_status=failed', collectResp.status === 201 && collectResp.body.inspection.collection_status === 'failed', collectResp.body);
      const rejectWithNote = await submitWith(w, item, { result: 'ok', number_value: null, note: '现场目视确认正常，仅采集器连接失败' });
      check('设备规则M3:failed判正常即便有说明仍400(failed规则不看note)', rejectWithNote.status === 400 && rejectWithNote.body.code === 'SHEET_INCOMPLETE', rejectWithNote.body);
      check('设备规则M3:缺项清单device_issue_item_ids含该行', rejectWithNote.body.detail.device_issue_item_ids.includes(item.id), rejectWithNote.body.detail);
    }

    // --- C3b M4：success + cleanup_warnings 非空，判正常无说明→400；有说明→通过 ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-M4', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'success', cleanupWarnings: ['临时文件清理超时，已跳过'] });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则M4准备:采集201且cleanup_warnings非空', collectResp.status === 201 && Array.isArray(collectResp.body.inspection.snapshot.cleanup_warnings) && collectResp.body.inspection.snapshot.cleanup_warnings.length === 1, collectResp.body);
      const rejectNoNote = await submitWith(w, item, { result: 'ok', number_value: null, note: null });
      check('设备规则M4:cleanup_warnings非空判正常无说明提交400', rejectNoNote.status === 400 && rejectNoNote.body.detail.device_issue_item_ids.includes(item.id), rejectNoNote.body);
      const acceptWithNote = await submitWith(w, item, { result: 'ok', number_value: null, note: '清理超时不影响硬件状态，已现场复核' });
      check('设备规则M4:cleanup_warnings非空判正常有说明提交200', acceptWithNote.status === 200, acceptWithNote.body);
    }

    // --- D：已提交单「保存修改」同样生效——先以bad+说明+照片提交通过，再改判ok，无说明该次保存
    //    400整体回滚(item仍是bad)，补说明后保存200生效。
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-D', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'partial' });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则D准备:采集201', collectResp.status === 201, collectResp.body);
      const detail2 = await getSheetAs(f, w.sheet.id, 2);
      const put1 = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail2.body.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT).map((it) => (it.id === item.id ? { ...it, result: 'bad', note: '现场目视异常' } : it)), remark: null }, 2);
      check('设备规则D准备:改判异常200', put1.status === 200, put1.body);
      await uploadItemPhoto(f, w.sheet.id, item.id, 2);
      await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
      const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put1.body.version }, 2);
      check('设备规则D准备:提交200', submit.status === 200, submit.body);

      const submittedDetail = await getSheetAs(f, w.sheet.id, 2);
      const rejectEdit = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: submittedDetail.body.version, items: [{ id: item.id, result: 'ok', number_value: null, note: null }], remark: null }, 2);
      check('设备规则D:保存修改改判正常无说明400', rejectEdit.status === 400 && rejectEdit.body.code === 'SHEET_INCOMPLETE', rejectEdit.body);
      check('设备规则D:缺项清单含该行', rejectEdit.body.detail.device_issue_item_ids.includes(item.id), rejectEdit.body.detail);
      const afterReject = await getSheetAs(f, w.sheet.id, 2);
      check('设备规则D:400整体回滚,该行仍是bad(未落库半截状态)', afterReject.body.items.find((it) => it.id === item.id).result === 'bad', afterReject.body.items.find((it) => it.id === item.id));
      check('设备规则D:回滚后version未变', afterReject.body.version === submittedDetail.body.version, afterReject.body);
      const acceptEdit = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: submittedDetail.body.version, items: [{ id: item.id, result: 'ok', number_value: null, note: '复核后确认正常' }], remark: null }, 2);
      check('设备规则D:补说明后保存修改200', acceptEdit.status === 200, acceptEdit.body);
    }

    // --- C3b L5：快照解析失败按「不完整」处理(宁可拒绝)——直接SQL把snapshot_json改成非法JSON，
    //    判正常无说明应仍400；这条不测"有说明能不能通过"(能，因为note非空这个判据本来就不依赖
    //    快照内容能否解析)，只测"解析失败不能被悄悄当成0条告警/清理警告从而放行"。 ---
    {
      const w = await buildDraftSheetWithDevice(f, 'C3-DevRule-L5', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, collectionStatus: 'success' });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('设备规则L5准备:采集201', collectResp.status === 201, collectResp.body);
      await f.run('UPDATE it_device_inspections SET snapshot_json=? WHERE id=?', ['这不是合法的JSON{{{', collectResp.body.inspection.id]);
      const rejectNoNote = await submitWith(w, item, { result: 'ok', number_value: null, note: null });
      check('设备规则L5:快照解析失败判正常无说明仍400(不能悄悄当成0条告警放行)', rejectNoNote.status === 400 && rejectNoNote.body.detail.device_issue_item_ids.includes(item.id), rejectNoNote.body);
    }
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_DEVICE_RULE PASS=${pass}`);
}

// ============================================================
// C3c M7（37T）：deviceJudgementError 原来只判 `!note`，纯空格字符串会被当成"已说明"放行。
//   PUT 请求体自己的 validateItemPatch（C2c L1）已经会把纯空白 note 归一化成 null，正常走
//   PUT→提交这条路径根本递不进一个"落库后仍是空白"的 note——这条判据真正生效的位置只有绕开
//   PUT 归一化、直接 SQL 把某行 note 改成纯空格这一种落库状态（同 M3 §2.6"仍被引用"注释一样，
//   是纵深防御，覆盖"通过 SQL 直接构造的不可达状态"）。partial / 告警 / 清理警告三种情形各一例。
// ============================================================
async function testM7WhitespaceNoteRejected() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    async function whitespaceCase(label, overrides) {
      const w = await buildDraftSheetWithDevice(f, 'C3c-M7-' + label, 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn, ...overrides });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check(`M7空白说明[${label}]准备:采集201`, collectResp.status === 201, collectResp.body);
      // 先用一个非空占位 note 正常 PUT 通过 validateItemPatch（不能直接 PUT 纯空格，会在写入前就
      // 被归一化成 null），再用直接 SQL 把该行 note 改成纯空格，模拟"落库值本身就是空白"。
      const detail2 = await getSheetAs(f, w.sheet.id, 2);
      const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail2.body.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT).map((it) => (it.id === item.id ? { ...it, result: 'ok', note: '占位说明' } : it)), remark: null }, 2);
      check(`M7空白说明[${label}]准备:PUT200(占位note)`, put.status === 200, put.body);
      await f.run('UPDATE it_inspection_sheet_items SET note=? WHERE id=?', ['   ', item.id]);
      await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
      const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
      check(`M7空白说明[${label}]:纯空格note(绕开PUT归一化)判正常仍400`, submit.status === 400 && submit.body.code === 'SHEET_INCOMPLETE' && submit.body.detail.device_issue_item_ids.includes(item.id), submit.body);
    }
    await whitespaceCase('partial', { collectionStatus: 'partial' });
    await whitespaceCase('alerts', { collectionStatus: 'success', alerts: [{ severity: 'attention', kind: 'test', message: '测试告警' }] });
    await whitespaceCase('cleanup', { collectionStatus: 'success', cleanupWarnings: ['清理超时，已跳过'] });
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_M7_WHITESPACE_NOTE PASS=${pass}`);
}

// ============================================================
// 6) 单独判断与附件路由整体退役后的 404（C7，方案 v0.6 §7「v0.6 追加退役」段）：改造前（C3）
//    带 sheet_id 的采集记录，判断/附件上传/附件删除三处走 409 INSPECTION_IN_SHEET，解除归属
//    （detached_from_sheet_id）后可正常单独判断——C7 把这三条路由和 GET /targets、POST / 一并整体
//    删除，不再是"按sheet_id状态放行/拒绝"的业务闸，而是路由层面对任何请求都404（Express默认404，
//    与C6机房路由退役同一手法）。本函数改造为：用真实存在的记录id（既有归属、也有已解除归属两种
//    状态）分别证明——不管记录处于哪种状态，这些路由都404，不会因为记录"看起来该被放行"就意外200或
//    409（对应派单C7要求的"每个退役接口404，含带合法id的请求"）。
// ============================================================
async function testStandaloneGatedBySheetId() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3-Gate', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
    fc.setOverrides({ sn: assetSn });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('闸准备:采集201', collectResp.status === 201, collectResp.body);
    const recordId = collectResp.body.inspection.id;
    const before = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
    check('闸准备:该记录确实有sheet_id(前提成立)', !!before.sheet_id && before.detached_from_sheet_id === null, before);

    // C7：review/删除用裸fetch而不是f.api()——f.api()对响应体无条件.json()，Express默认404是HTML,
    // 会直接抛异常而不是给出一条干净的失败断言（同上面collectStandalone/uploadEvidence要解决的坑）。
    const reviewUrlPath = '/api/it-assets/inspections/' + recordId + '/review';
    const reviewProbe = async (body) => { const resp = await fetch(f.base + reviewUrlPath, { method: 'POST', headers: { Authorization: 'Bearer fixture-2', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: resp.status, method: 'POST', urlPath: reviewUrlPath, contentType: resp.headers.get('content-type') || '', body: await resp.text() }; };
    const review = await reviewProbe({ judgement: 'normal', note: '' });
    check('C7:归属巡检单的记录,判断路由404(路由已删除,不是409 INSPECTION_IN_SHEET那类业务闸)', review.status === 404, review.status === 404 ? undefined : review.body);
    checkExpressDefault404('归属巡检单的记录,判断路由', review.method, review.urlPath, review.contentType, review.body);
    const upload = await uploadEvidence(f, 'device', recordId, 2);
    check('C7:归属巡检单的记录,附件上传路由404', upload.status === 404, upload.status === 404 ? undefined : upload.body);
    checkExpressDefault404('归属巡检单的记录,附件上传路由', upload.method, upload.urlPath, upload.contentType, upload.body);
    // 附件删除：先直接 SQL 插一条附件行（不经上传接口，上传路由本身已404），验证删除路由同样404。
    await f.run("CREATE TABLE IF NOT EXISTS it_inspection_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,record_id INTEGER NOT NULL,original_name TEXT NOT NULL,stored_name TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,phase TEXT NOT NULL,description TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_by INTEGER,deleted_at TEXT,cleanup_pending INTEGER NOT NULL DEFAULT 0)");
    const insEvidence = await f.run("INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES('device',?,?,?,?,1,'x','initial','x',1,?)", [recordId, 'fake.png', crypto.randomUUID() + '.bin', 'image/png', new Date().toISOString()]);
    const delUrlPath = '/api/it-assets/inspections/device/' + recordId + '/evidence/' + insEvidence.lastID;
    const delResp = await fetch(f.base + delUrlPath, { method: 'DELETE', headers: { Authorization: 'Bearer fixture-2' } });
    const del = { status: delResp.status, method: 'DELETE', urlPath: delUrlPath, contentType: delResp.headers.get('content-type') || '', body: await delResp.text() };
    check('C7:归属巡检单的记录,附件删除路由404', del.status === 404, del.status === 404 ? undefined : del.body);
    checkExpressDefault404('归属巡检单的记录,附件删除路由', del.method, del.urlPath, del.contentType, del.body);

    // 重复采集触发旧记录解除归属——即使解除后视同单独采集，判断/附件路由仍然404（路由层面的退役，
    // 不受sheet_id/detached_from_sheet_id取值影响；C3时代"解除后可单独判断200"这条正向断言随本次
    // 退役一并失效，改判404）。
    const collectResp2 = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('闸准备:重复采集201', collectResp2.status === 201, collectResp2.body);
    const afterDetach = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
    check('闸准备:旧记录已解除归属(前提成立)', afterDetach.sheet_id === null && afterDetach.detached_from_sheet_id === w.sheet.id, afterDetach);
    const reviewDetached = await reviewProbe({ judgement: 'attention', note: '人工复核' });
    check('C7:解除归属后判断路由仍404(不会因为detached就恢复200,路由本身已不存在)', reviewDetached.status === 404, reviewDetached.status === 404 ? undefined : reviewDetached.body);
    checkExpressDefault404('解除归属后判断路由', reviewDetached.method, reviewDetached.urlPath, reviewDetached.contentType, reviewDetached.body);
    const uploadDetached = await uploadEvidence(f, 'device', recordId, 2);
    check('C7:解除归属后附件上传路由仍404', uploadDetached.status === 404, uploadDetached.status === 404 ? undefined : uploadDetached.body);
    checkExpressDefault404('解除归属后附件上传路由', uploadDetached.method, uploadDetached.urlPath, uploadDetached.contentType, uploadDetached.body);
    // GET /:id(记录只读详情)保留——解除归属后仍应正常200，证明本函数改造只影响三条已删路由，不影响
    // 保留路由。
    const stillReadable = await f.api('GET', '/inspections/' + recordId, undefined, 2);
    check('C7:保留路由GET /:id不受影响,解除归属后仍200', stillReadable.status === 200, stillReadable.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_GATE PASS=${pass}`);
}

// ============================================================
// C3c H3（codex 37S/37T，§4.2）：归属巡检单（sheet_id 非空未解除）的采集记录，独立采集详情/列表
//   接口也要按单据可见性收窄——非 full 一律 404（详情）或摘掉快照派生字段（列表），不能绕过草稿
//   summary 可见性、已删除单 none 可见性拿到完整内容。
// ============================================================
async function testInspectionVisibilityOnSheetLinkedRecords() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3c-Vis', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn, alerts: [{ severity: 'attention', kind: 'test', message: '测试告警' }] });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('H3准备:草稿采集201且alerts非空', collectResp.status === 201 && collectResp.body.inspection.snapshot.alerts.length === 1, collectResp.body);
    const recordId = collectResp.body.inspection.id;

    // uid=5：有写权限、非本单巡检人非管理员——对草稿单的可见性是 summary。
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");

    const ownerGet = await f.api('GET', '/inspections/' + recordId, undefined, 2);
    check('H3:巡检人本人读详情200且带完整快照', ownerGet.status === 200 && ownerGet.body.snapshot.alerts.length === 1, ownerGet.body);
    const adminGet = await f.api('GET', '/inspections/' + recordId, undefined, 1);
    check('H3:管理员读详情200', adminGet.status === 200, adminGet.body);
    const otherGet = await f.api('GET', '/inspections/' + recordId, undefined, 5);
    check('H3:他人对summary可见草稿读详情404(与不存在同码,不额外泄露)', otherGet.status === 404 && otherGet.body.code === 'LEDGER_NOT_FOUND', otherGet.body);

    // C7（方案v0.6 §7）：附件列表/附件内容下载两条路由（GET /:kind/:recordId/evidence、
    // GET .../evidence/:attachmentId/content）随退役整体删除——原44T M1/L3那套"三档可见性分别断言
    // 200/200/404"的业务闸测试因此失去对象（路由不在了，不存在"可见性收窄到404 vs 不收窄"这种区分，
    // 任何调用者、任何可见性状态下都是同一种404，与GET /:id单独已经404的记录同码一致，不额外泄露）。
    // 改为一条最小化探针：证明这两条路由确实404（含合法id），不是被visibility逻辑判定成404——本人
    // （巡检人，对这条记录本该是full可见）去请求同样404，证明退役是路由层面的，与可见性无关。裸fetch
    // 而不是f.api()——Express默认404是HTML，f.api()对响应体无条件.json()会直接抛异常。
    const evidenceListUrlPath = '/api/it-assets/inspections/device/' + recordId + '/evidence';
    const evidenceListResp = await fetch(f.base + evidenceListUrlPath, { headers: { Authorization: 'Bearer fixture-2' } });
    check('C7:附件列表路由404(即使调用者对该记录本该是full可见)', evidenceListResp.status === 404, evidenceListResp.status);
    checkExpressDefault404('附件列表路由', 'GET', evidenceListUrlPath, evidenceListResp.headers.get('content-type') || '', await evidenceListResp.text());
    // 内容下载探针带一个真实存在的附件id（直接SQL插入，上传路由已删除无法经API产生）——证明就算id
    // 合法、行确实存在，路由本身还是404（"含带合法id的请求"，不是靠id查不到才404）。
    await f.run("CREATE TABLE IF NOT EXISTS it_inspection_evidence(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,record_id INTEGER NOT NULL,original_name TEXT NOT NULL,stored_name TEXT NOT NULL UNIQUE,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,phase TEXT NOT NULL,description TEXT NOT NULL,created_by INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_by INTEGER,deleted_at TEXT,cleanup_pending INTEGER NOT NULL DEFAULT 0)");
    const h3Evidence = await f.run("INSERT INTO it_inspection_evidence(kind,record_id,original_name,stored_name,mime,size,sha256,phase,description,created_by,created_at) VALUES('device',?,?,?,?,1,'x','initial','x',1,?)", [recordId, 'h3.png', crypto.randomUUID() + '.bin', 'image/png', new Date().toISOString()]);
    const evidenceContentUrlPath = '/api/it-assets/inspections/device/' + recordId + '/evidence/' + h3Evidence.lastID + '/content';
    const evidenceContentResp = await fetch(f.base + evidenceContentUrlPath, { headers: { Authorization: 'Bearer fixture-2' } });
    check('C7:附件内容下载路由404(合法id、行确实存在,仍是路由不存在的404)', evidenceContentResp.status === 404, evidenceContentResp.status);
    checkExpressDefault404('附件内容下载路由(合法id、行确实存在)', 'GET', evidenceContentUrlPath, evidenceContentResp.headers.get('content-type') || '', await evidenceContentResp.text());

    // C6-b H1（Opus预筛）：白名单加 restricted:true（供前端识别"这行受限，不能点查看、不该被默认
    // 选中"），受限行键集合从四键变五键——下面两处 keySet 全等断言同步改。
    const RESTRICTED_KEYS = ['id', 'asset_id', 'started_at', 'sheet_ref', 'restricted'];
    const keySet = (obj) => Object.keys(obj).sort().join(',');
    const ownerList = (await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 2)).body.items.find((x) => x.id === recordId);
    check('H3:巡检人本人列表带alert_count', !!ownerList && ownerList.alert_count === 1, ownerList);
    // C3e（codex 37-RS）：巡检人本人/管理员是full可见，键集合应是完整行——不能只满足于alert_count
    // 正确，还要断言"没有被误裁成白名单形状"，否则白名单实现万一把full也裁了，这条测不出来。
    // C7（方案v0.6 §6）：新增item_result键——此刻只做过采集(collectOnSheet)、还没PUT写过检查项
    // 结果，对应it_inspection_sheet_items.result仍是初始NULL,期望item_result===null。
    check('H3:巡检人本人列表键集合完整(未被误套白名单,含C7新增item_result)', keySet(ownerList) === 'alert_count,asset_id,asset_name,collection_status,completed_at,detached_from_sheet_id,id,item_result,judgement,judgement_note,requested_by,reviewed_at,reviewed_by,sheet_id,sheet_ref,source_host,started_at', ownerList);
    check('C7:巡检人本人列表item_result为null(检查项尚未PUT写入结果,前提成立)', ownerList.item_result === null, ownerList.item_result);
    const adminList = (await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 1)).body.items.find((x) => x.id === recordId);
    check('H3:管理员列表键集合完整(未被误套白名单)', keySet(adminList) === keySet(ownerList), adminList);
    const otherList = (await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 5)).body.items.find((x) => x.id === recordId);
    // C3e：改正C3c"只摘alert_count"的半成品修复——受限行(summary可见性)改用响应白名单，键集合
    // 必须与白名单完全相等，不能只挑着看某个字段值对不对，否则
    // judgement_note/collection_status/asset_name/source_host/requested_by等仍会原样漏出去
    // （这正是37-RS指出的漏洞：C3c的写法"先展开整行、再删alert_count"，其余字段从未被摘掉）。
    // C6-b H1：白名单加 restricted:true，五键全等（不再是四键）。C7：item_result不进这份白名单
    // （方案v0.6 §6"受限行不加"）——下面全等断言天然覆盖了"没有被多塞进item_result"这件事。
    check('H3(summary):受限行键集合与白名单(五键,不含C7新增的item_result)完全相等', keySet(otherList) === keySet({ id: 0, asset_id: 0, started_at: 0, sheet_ref: 0, restricted: 0 }), otherList);
    check('H3(summary):受限行五个键各自取值正确', otherList.id === recordId && otherList.asset_id === w.device.id && otherList.started_at === ownerList.started_at && otherList.restricted === true && otherList.sheet_ref && otherList.sheet_ref.text === `巡检单 #${w.sheet.id}（填写中）` && otherList.sheet_ref.linkable === false && otherList.sheet_ref.kind === 'attached', { otherList, ownerList });

    // 提交并逻辑删除该单——非管理员 visibility=none，采集详情同样404；管理员仍200。该设备行
    // alerts非空，判正常须带说明（设备规则C），其余行走标准全正常填法。
    const fillItems = fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT).map((it) => (it.id === item.id ? { ...it, note: 'H3测试:告警已核实' } : it));
    const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail.body.version, items: fillItems, remark: null }, 2);
    check('H3准备:PUT补全200', put.status === 200, put.body);
    await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('H3准备:提交200', submit.status === 200, submit.body);
    const del = await f.api('DELETE', '/inspections/sheets/' + w.sheet.id, { expected_version: submit.body.version, reason: 'H3测试删除' }, 2);
    check('H3准备:逻辑删除200', del.status === 200, del.body);
    const deletedOtherGet = await f.api('GET', '/inspections/' + recordId, undefined, 5);
    check('H3:非管理员看已删除单的采集详情404', deletedOtherGet.status === 404 && deletedOtherGet.body.code === 'LEDGER_NOT_FOUND', deletedOtherGet.body);
    const deletedAdminGet = await f.api('GET', '/inspections/' + recordId, undefined, 1);
    check('H3:管理员看已删除单的采集详情仍200', deletedAdminGet.status === 200, deletedAdminGet.body);
    // C7：附件列表/内容下载路由已删除，已删除单场景下同样404——不必重复整套三档可见性对照（上面
    // "路由层面404,与可见性无关"已证明过），这里只留一条最小回归：单据被删除、可见性从summary变成
    // none之后，这两条路由依旧404（不会因为单据状态变化而意外"恢复"）。
    const deletedEvidenceListResp = await fetch(f.base + evidenceListUrlPath, { headers: { Authorization: 'Bearer fixture-1' } });
    check('C7:单据逻辑删除后,附件列表路由仍404', deletedEvidenceListResp.status === 404, deletedEvidenceListResp.status);
    checkExpressDefault404('单据逻辑删除后的附件列表路由', 'GET', evidenceListUrlPath, deletedEvidenceListResp.headers.get('content-type') || '', await deletedEvidenceListResp.text());
    const deletedEvidenceContentResp = await fetch(f.base + evidenceContentUrlPath, { headers: { Authorization: 'Bearer fixture-1' } });
    check('C7:单据逻辑删除后,附件内容下载路由仍404', deletedEvidenceContentResp.status === 404, deletedEvidenceContentResp.status);
    checkExpressDefault404('单据逻辑删除后的附件内容下载路由', 'GET', evidenceContentUrlPath, deletedEvidenceContentResp.headers.get('content-type') || '', await deletedEvidenceContentResp.text());
    // C7-d（codex 46S H，主会话已核实属实）：none视角（非管理员看已删除单）不再是"收窄到白名单"，
    // 而是整行不出现——方案§4.2「none 的单不出现在列表」「full 以外不暴露是否存在」，旧断言反而验证
    // 了"受限五键+已删除文案确实透出"，与方案矛盾（哪怕摘掉了大部分字段，"这条记录存在、归属一张已
    // 删除的单"这件事本身就是泄露）。这是与 testSheetRefAttribution 那条（草稿→提交→删除路径）相同
    // 的问题在"提交后再删除"这条独立路径上的第二处实证，两处都要修、断言不能只挑一条路径。
    const deletedOtherList = (await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 5)).body.items.find((x) => x.id === recordId);
    check('C7-d:H3(none)非管理员看已删除单,该记录不在列表中(方案§4.2不暴露是否存在)', deletedOtherList === undefined, deletedOtherList);
    const deletedAdminList = (await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 1)).body.items.find((x) => x.id === recordId);
    // C7：提交时该设备检查项被填了result:'ok'（fillPayloadAllOk默认值，见上面H3准备段），管理员
    // (full可见,不受单据删除影响)此刻应能在列表里看到item_result:'ok'——判断结果列有真实取值。
    check('C7:管理员列表item_result为ok(检查项已PUT写入结果并提交)', deletedAdminList.item_result === 'ok', deletedAdminList.item_result);
    check('H3:管理员看已删除单,列表键集合仍完整(full可见性不受影响)', keySet(deletedAdminList) === keySet(ownerList), deletedAdminList);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_H3_VISIBILITY PASS=${pass}`);
}

// ============================================================
// 7) 服务器历史「归属」展示（方案 §2.5 第三条）：四种文本各一例，按三档可见性断言。
// ============================================================
async function testSheetRefAttribution() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    // uid=3 是夹具默认的只读用户（read ACL），本测试只用 GET，不需要额外授权。
    const w = await buildDraftSheetWithDevice(f, 'C3-Attr', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
    fc.setOverrides({ sn: assetSn });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('归属准备:采集201', collectResp.status === 201, collectResp.body);
    const recordId = collectResp.body.inspection.id;

    async function sheetRefAs(uid) {
      const list = await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, uid);
      assert.equal(list.status, 200, 'sheetRefAs ' + uid + ' ' + JSON.stringify(list.body));
      const row = list.body.items.find((r) => r.id === recordId);
      assert.ok(row, '归属:找不到记录 ' + recordId);
      return row.sheet_ref;
    }
    // C7（方案v0.6 §6）：取完整行（不只sheet_ref），断言item_result这个新字段——可见行有值(null或
    // 'ok'/'bad')，受限行整个不带这个键。
    async function rowAs(uid) {
      const list = await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, uid);
      return list.body.items.find((r) => r.id === recordId);
    }

    const refFull = await sheetRefAs(2);
    check('归属-可见(巡检人本人,草稿full):文本正确', refFull && refFull.text === `见巡检单 #${w.sheet.id}` && refFull.linkable === true && refFull.id === w.sheet.id, refFull);
    // C6-b H1：kind:'attached'（仍归属，非已解除）；linkable行补status，草稿单status应为'draft'。
    check('归属-可见(巡检人本人,草稿full):kind=attached且status=draft', refFull.kind === 'attached' && refFull.status === 'draft', refFull);
    const rowFull = await rowAs(2);
    check('C7:归属可见(巡检人本人,草稿full)item_result为null(检查项此刻仅完成采集,尚未PUT写入结果)', rowFull.item_result === null, rowFull.item_result);
    const refSummary = await sheetRefAs(3);
    check('归属-他人草稿(summary):文本正确', refSummary && refSummary.text === `巡检单 #${w.sheet.id}（填写中）` && refSummary.linkable === false, refSummary);
    check('归属-他人草稿(summary):kind=attached且不带status(非linkable行不补status)', refSummary.kind === 'attached' && !Object.hasOwn(refSummary, 'status'), refSummary);
    const rowSummary = await rowAs(3);
    check('C7:归属他人草稿(summary)受限行不带item_result键', !Object.hasOwn(rowSummary, 'item_result'), rowSummary);

    // 提交后逻辑删除，管理员仍full，非管理员non-none。
    const detail2 = await getSheetAs(f, w.sheet.id, 2);
    const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail2.body.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('归属准备:PUT补全200', put.status === 200, put.body);
    await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('归属准备:提交200', submit.status === 200, submit.body);
    const del = await f.api('DELETE', '/inspections/sheets/' + w.sheet.id, { expected_version: submit.body.version, reason: '归属测试删除' }, 2);
    check('归属准备:逻辑删除200', del.status === 200, del.body);

    // C7-d（codex 46S H，主会话已核实属实）：非管理员看已删除单——sheetVisibility 判 none，方案
    // §4.2「none 的单不出现在列表」「full 以外不暴露是否存在」。原先的期望是"受限五键+已删除文案"，
    // 本身就与方案矛盾（哪怕不能点，暴露"存在一条巡检记录、归属一张已删除的单"这件事本身就是泄露）；
    // 改为这条记录整行不出现（按 id 精确查找为空），并补详情接口同样 404（不只列表要挡，单条查询也
    // 不能漏）。
    const listDeletedNonAdmin = await f.api('GET', '/inspections?asset_id=' + w.device.id, undefined, 3);
    assert.equal(listDeletedNonAdmin.status, 200, 'listDeletedNonAdmin ' + JSON.stringify(listDeletedNonAdmin.body));
    check('C7-d:归属已删除且非管理员(none)——该记录不在列表中(方案§4.2不暴露是否存在)', listDeletedNonAdmin.body.items.every((r) => r.id !== recordId), listDeletedNonAdmin.body);
    const detailDeletedNonAdmin = await f.api('GET', '/inspections/' + recordId, undefined, 3);
    check('C7-d:归属已删除且非管理员(none)——GET /inspections/:id详情同样404', detailDeletedNonAdmin.status === 404, detailDeletedNonAdmin.body);
    const refDeletedAdmin = await sheetRefAs(1);
    check('归属-已删除但管理员(full):见巡检单可点', refDeletedAdmin && refDeletedAdmin.text === `见巡检单 #${w.sheet.id}` && refDeletedAdmin.linkable === true, refDeletedAdmin);
    // C6-b H1：管理员对已删除单仍是full可见，text/linkable不变（同上一条既有断言），但status要能
    // 让前端分派识别出"这单其实已经被删了"——status==='deleted'，不是普通submitted/archived。
    check('归属-已删除但管理员(full):status=deleted(供前端识别,text/linkable本身不变)', refDeletedAdmin.kind === 'attached' && refDeletedAdmin.status === 'deleted', refDeletedAdmin);
    const rowDeletedAdmin = await rowAs(1);
    check('C7:归属已删除但管理员(full)item_result为ok(检查项已PUT写入且提交,fillPayloadAllOk默认result=ok)', rowDeletedAdmin.item_result === 'ok', rowDeletedAdmin.item_result);

    // 已解除：另开一张草稿单，采集后立刻在同一行重复采集，第一条记录解除归属。
    const w2 = await buildDraftSheetWithDevice(f, 'C3-Attr-Detach', 2);
    const detail3 = await getSheetAs(f, w2.sheet.id, 2);
    const item2 = deviceItemOf(detail3.body, w2.device.id);
    const assetSn2 = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w2.device.id]))[0].sn;
    fc.setOverrides({ sn: assetSn2 });
    const first = await collectOnSheet(f, w2.sheet.id, item2.id, 2);
    check('归属准备:第一次采集201', first.status === 201, first.body);
    const firstId = first.body.inspection.id;
    // MED-3（C7-c，Opus预筛）：重新采集前先把这一项的判断结果PUT成'bad'——item_result取的是"当前
    // 指向这条记录的检查项现取值"，不是采集响应/快照自身的字段（it_device_inspections没有
    // judgement/result这类列，全靠it_inspection_sheet_items.result间接来），要证明这一点必须先有一
    // 个非null的取值再重采，不能像原来那样两条记录全程result恒为null(P3类"item_result不管哪行全部
    // 串成同一个值"这种回归，在两条都是null的构造下测不出来)。
    const putBadBeforeDetach = await f.api('PUT', '/inspections/sheets/' + w2.sheet.id, { expected_version: detail3.body.version, items: [{ id: item2.id, result: 'bad', number_value: null, note: 'C7-c验证item_result取值' }], remark: null }, 2);
    check('归属准备:PUT把检查项标为bad', putBadBeforeDetach.status === 200, putBadBeforeDetach.body);
    const second = await collectOnSheet(f, w2.sheet.id, item2.id, 2);
    check('归属准备:第二次采集201(解除第一条)', second.status === 201, second.body);
    const secondId = second.body.inspection.id;
    // C7-c 自审修正：w2 的单据此刻仍是草稿（未提交/删除），以 uid=3（他人）查询会落 summary 可见性、
    // 整行不带 item_result 键（同本函数上方 1051-1055 行 rowAs(3) 的既有断言同一行为）——secondId
    // 这条记录仍归属该草稿单，要断言 item_result 取值就必须以 uid=2（本人，w2 的创建者）查询，才能
    // 拿到 full 可见性带 item_result 的行；firstId 已解除归属（detached），任意可见性都是 full，
    // 用 2 查不影响下面几条 detachedRow 断言。
    const listForDevice2 = await f.api('GET', '/inspections?asset_id=' + w2.device.id, undefined, 2);
    const detachedRow = listForDevice2.body.items.find((r) => r.id === firstId);
    const attachedRow = listForDevice2.body.items.find((r) => r.id === secondId);
    check('C7-c(MED-3):新记录(secondId)item_result为bad(取的是检查项当前值,重采后result原样保留)', attachedRow && attachedRow.item_result === 'bad', attachedRow);
    check('归属-已解除:文本正确(任意可见性都一样,不受visibility影响)', detachedRow && detachedRow.sheet_ref && detachedRow.sheet_ref.text === `来自巡检单 #${w2.sheet.id} 的采集（已解除）` && detachedRow.sheet_ref.linkable === false && detachedRow.sheet_ref.id === w2.sheet.id, detachedRow);
    // C6-b H1：kind='detached'（区别于attached）；已解除记录恒为full可见（非restricted），不带
    // restricted键；detached分支不补status(只有linkable行才补)。
    check('归属-已解除:kind=detached且不带status,行本身不带restricted键', detachedRow.sheet_ref.kind === 'detached' && !Object.hasOwn(detachedRow.sheet_ref, 'status') && !Object.hasOwn(detachedRow, 'restricted'), detachedRow);
    // C7：已解除的记录，它原来对应的检查项(device_inspection_id)已经被第二次采集改指向新记录
    // (secondId)——firstId这条记录此刻查不到任何it_inspection_sheet_items行引用它，item_result应为
    // null（不是"确实判断为空"与"记录已经没有检查项在指它"这两种语义的区分，前端呈现的意义相同）。
    check('C7:归属已解除(detached)item_result为null(检查项已改指向新记录,查不到匹配行)', detachedRow.item_result === null, detachedRow.item_result);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_ATTRIBUTION PASS=${pass}`);
}

// ============================================================
// 8) 旧表兼容（方案 §2.5）：没有两列的旧结构 it_device_inspections（直接 SQL 建旧 DDL）→读接口正常
//    且两字段为 null；第一次巡检单采集后两列被补上且数据正确；再次调用不重复 ALTER（幂等，不报错）。
//    it_device_inspections 不是 initSchema() 的一部分（懒建），createFixture() 内部的 initSchema()
//    不会碰它——建完夹具后、发起任何采集请求前，直接 SQL 建旧表安全。
// ============================================================
async function testOldTableCompat() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    await f.run(`CREATE TABLE it_device_inspections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, asset_name TEXT NOT NULL, source_host TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, collection_status TEXT NOT NULL CHECK(collection_status IN ('success','partial','failed')),
      snapshot_json TEXT NOT NULL, requested_by INTEGER NOT NULL, judgement TEXT CHECK(judgement IN ('normal','attention')),
      judgement_note TEXT, reviewed_by INTEGER, reviewed_at TEXT,
      CHECK((judgement IS NULL AND judgement_note IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (judgement IS NOT NULL AND judgement_note IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
    )`);
    const oldSnapshot = JSON.stringify({ schema_version: 1, source_host: HOST, server: { serial_number: 'OLD-SN' }, volumes: [], physical_disks: [], virtual_disks: [], enclosures: [], alerts: [], component_errors: [], cleanup_warnings: [], collection_status: 'success', started_at: new Date().toISOString(), completed_at: new Date().toISOString() });
    const insOld = await f.run('INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by) VALUES (999,?,?,?,?,?,?,1)', ['旧设备记录', HOST, new Date().toISOString(), new Date().toISOString(), 'success', oldSnapshot]);
    const oldId = insOld.lastID;
    const colsBefore = await f.all('PRAGMA table_info(it_device_inspections)');
    check('旧表准备:确实没有两列(前提成立)', !colsBefore.some((c) => c.name === 'sheet_id') && !colsBefore.some((c) => c.name === 'detached_from_sheet_id'), colsBefore);

    const single = await f.api('GET', '/inspections/' + oldId, undefined, 1);
    check('旧表:读单条正常200', single.status === 200, single.body);
    const list = await f.api('GET', '/inspections?asset_id=999', undefined, 1);
    check('旧表:读列表正常200', list.status === 200, list.body);
    const rowInList = list.body.items.find((r) => r.id === oldId);
    check('旧表:列表里该行sheet_ref为null(缺列按NULL读,不报错)', rowInList && rowInList.sheet_ref === null, rowInList);
    // C7：此刻it_inspection_sheets/it_inspection_sheet_items两张表都还不存在（本测试尚未创建过任何
    // 巡检单）——buildItemResults对"表不存在"要有防御，不能报"no such table"；item_result键仍应
    // 存在且为null（与sheet_id/detached_from_sheet_id同一口径：缺列/缺表按NULL读，不报错、不丢键）。
    check('旧表(C7):it_inspection_sheet_items此刻确实不存在(前提成立)', (await f.all("SELECT name FROM sqlite_master WHERE name='it_inspection_sheet_items'")).length === 0);
    check('旧表(C7):列表记录item_result键显式存在且为null(表不存在时的防御路径)', Object.hasOwn(rowInList, 'item_result') && rowInList.item_result === null, rowInList);
    // C3c（37T 补测）：不只判"值为null"，显式判两个键本身存在——旧代码若省略这两个键（而不是
    // 给null），JSON.stringify会把undefined的键整个丢掉，前端没法区分"确实是null"和"键缺失"。
    check('旧表:单条响应sheet_id键显式存在且为null', Object.hasOwn(single.body, 'sheet_id') && single.body.sheet_id === null, single.body);
    check('旧表:单条响应detached_from_sheet_id键显式存在且为null', Object.hasOwn(single.body, 'detached_from_sheet_id') && single.body.detached_from_sheet_id === null, single.body);
    check('旧表:列表记录sheet_id键显式存在且为null', rowInList && Object.hasOwn(rowInList, 'sheet_id') && rowInList.sheet_id === null, rowInList);
    check('旧表:列表记录detached_from_sheet_id键显式存在且为null', rowInList && Object.hasOwn(rowInList, 'detached_from_sheet_id') && rowInList.detached_from_sheet_id === null, rowInList);

    // 触发一次真正的巡检单采集（走写路径），应该在同一事务里把两列补上。
    const w = await buildDraftSheetWithDevice(f, 'C3-OldTable', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
    fc.setOverrides({ sn: assetSn });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('旧表:巡检单采集201(触发ALTER)', collectResp.status === 201, collectResp.body);
    const colsAfter = await f.all('PRAGMA table_info(it_device_inspections)');
    check('旧表:两列已补上', colsAfter.some((c) => c.name === 'sheet_id') && colsAfter.some((c) => c.name === 'detached_from_sheet_id'), colsAfter);
    const oldRowAfter = (await f.all('SELECT * FROM it_device_inspections WHERE id=?', [oldId]))[0];
    check('旧表:旧记录原有数据仍完整,新列为NULL', oldRowAfter.asset_id === 999 && oldRowAfter.sheet_id === null && oldRowAfter.detached_from_sheet_id === null, oldRowAfter);
    const oldViaApi = await f.api('GET', '/inspections/' + oldId, undefined, 1);
    check('旧表:补列后旧记录仍可正常读', oldViaApi.status === 200, oldViaApi.body);

    // 再次调用(第二次巡检单采集，同一sheet同一item，触发旧行的替换/新行插入，都会再走一次
    // ensureDeviceInspectionColumns)——不该重复ALTER报错(幂等)。
    const collectResp2 = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('旧表:二次采集仍201(ALTER幂等,未报错)', collectResp2.status === 201, collectResp2.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_OLD_TABLE PASS=${pass}`);
}

// ============================================================
// C3c M（codex 37S，改正 C3b L4"做不到"的错误结论）：旧表补列时，新加的列能带上"两列互斥"
//   CHECK——分三种历史列状态覆盖：两列都缺、只缺 detached_from_sheet_id、只缺 sheet_id。三种状态
//   补列后都应受 CHECK 保护（直接 SQL 让两列同时非空必须被拒）。
// ============================================================
async function testOldTableAlterAddsCheckConstraint() {
  // SQLite 的 CREATE TABLE 语法：全部列定义必须排在表级约束（这里的最后一条 CHECK）之前，列定义
  // 不能出现在表级约束之后——BASE_PREFIX 收纳到 reviewed_at 为止的全部普通列，额外列（模拟"只缺
  // 一列"场景里已经存在的那一列）拼在 BASE_PREFIX 尾部，表级 CHECK 固定放最后（BASE_SUFFIX）。
  const BASE_PREFIX = `id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id INTEGER NOT NULL, asset_name TEXT NOT NULL, source_host TEXT NOT NULL,
      started_at TEXT NOT NULL, completed_at TEXT NOT NULL, collection_status TEXT NOT NULL CHECK(collection_status IN ('success','partial','failed')),
      snapshot_json TEXT NOT NULL, requested_by INTEGER NOT NULL, judgement TEXT CHECK(judgement IN ('normal','attention')),
      judgement_note TEXT, reviewed_by INTEGER, reviewed_at TEXT`;
  const BASE_SUFFIX = `CHECK((judgement IS NULL AND judgement_note IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (judgement IS NOT NULL AND judgement_note IS NOT NULL AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))`;
  const tableSql = (extraCol) => `CREATE TABLE it_device_inspections (${BASE_PREFIX}${extraCol ? ', ' + extraCol : ''}, ${BASE_SUFFIX})`;
  async function scenario(label, createSql, missingCols) {
    const fc = makeFakeCollector();
    const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
    try {
      await f.run(createSql);
      const colsBefore = await f.all('PRAGMA table_info(it_device_inspections)');
      const names = new Set(colsBefore.map((c) => c.name));
      check(`ALTER补CHECK[${label}]准备:列状态符合预期(前提成立)`, missingCols.every((c) => !names.has(c)), colsBefore);
      const w = await buildDraftSheetWithDevice(f, 'C3c-AlterCheck-' + label, 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn });
      const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check(`ALTER补CHECK[${label}]:采集201(触发ALTER补列)`, collectResp.status === 201, collectResp.body);
      const recordId = collectResp.body.inspection.id;
      const colsAfter = await f.all('PRAGMA table_info(it_device_inspections)');
      check(`ALTER补CHECK[${label}]:两列此刻均已存在`, colsAfter.some((c) => c.name === 'sheet_id') && colsAfter.some((c) => c.name === 'detached_from_sheet_id'), colsAfter);
      let rejected = false;
      let msg = '';
      try {
        await f.run('UPDATE it_device_inspections SET sheet_id=?, detached_from_sheet_id=? WHERE id=?', [w.sheet.id, w.sheet.id, recordId]);
      } catch (e) {
        rejected = true;
        msg = e.message || String(e);
      }
      check(`ALTER补CHECK[${label}]:补列后两列同时非空被CHECK拒绝`, rejected && /CHECK constraint failed/.test(msg), msg);
      check(`G2A2探针[${label}]: 写请求锁外SQL违规数精确为0`, f.probeViolations().length === 0, f.probeViolations().slice(0, 10));
      check(`G2A2探针[${label}]: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)`, f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    } finally {
      fc.release();
      await f.close();
    }
  }
  await scenario('两列都缺', tableSql(null), ['sheet_id', 'detached_from_sheet_id']);
  await scenario('只缺detached', tableSql('sheet_id INTEGER'), ['detached_from_sheet_id']);
  await scenario('只缺sheet_id', tableSql('detached_from_sheet_id INTEGER'), ['sheet_id']);
  console.log(`INSPECTION_COLLECT_ALTER_CHECK PASS=${pass}`);
}

// ============================================================
// 9) references()（方案 §7.1）：巡检单范围内的资产不能删除/彻底删除（原因文案与既有 inspections 同
//    口径）；同一资产（非服务器类别）仍可改类别（第8条的反向证明——refs.inspection_sheets 不并入
//    refs.inspections 那条 reclassify 闸）；巡检单被物理删除后引用消失；被逻辑删除仍算引用。
// ============================================================
async function testReferencesInspectionSheets() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const roomName = 'C3-Refs';
    const rack = (await f.api('POST', '/racks', { name: roomName + '-柜1', room: roomName, u_total: 20 })).body;
    // category='other'——非服务器类别，验证第8条"不并入refs.inspections"不会挡住改类别。
    const device = (await f.api('POST', '', { category: 'other', name: roomName + '-设备', u_height: 1, placement: { kind: 'rack', rack_id: rack.id, u_start: 1 } })).body;

    const rmBefore = await f.api('GET', '/' + device.id + '/record-management', undefined, 1);
    check('references准备:改类别前引用为0(前提成立)', rmBefore.status === 200 && rmBefore.body.references.inspection_sheets === 0, rmBefore.body);

    const sheet = (await createSheetAs(f, 2, roomName)).body;
    const rmAfter = await f.api('GET', '/' + device.id + '/record-management', undefined, 1);
    check('references:建单后inspection_sheets计为1', rmAfter.status === 200 && rmAfter.body.references.inspection_sheets === 1, rmAfter.body);

    // 第8条反向证明：同一资产(非服务器)仍可改类别(refs.inspections没算它，reclassify闸不受影响)。
    const reclassify = await f.api('POST', '/' + device.id + '/record-management', { action: 'reclassify', category: 'server', reason: '改类别测试', expected_version: device.version }, 1);
    check('references:非服务器类别仍可改类别(第8条反向证明)', reclassify.status === 200, reclassify.body);

    // 提交第一张单(同一机房同名同status='draft'的单只能有一张，UNIQUE INDEX——要建第二张必须先把
    // 这张挪出draft状态)。提交不改设备状态，设备此刻仍in_service+挂机柜。
    const detail = await getSheetAs(f, sheet.id, 2);
    const put = await f.api('PUT', '/inspections/sheets/' + sheet.id, { expected_version: detail.body.version, items: fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT), remark: null }, 2);
    await uploadAllRackFrontPhotos(f, sheet.id, sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('references准备:提交200', submit.status === 200, submit.body);

    // 第二张草稿单必须在下面"下架(rack_out)"之前建——buildScope 建单时要求设备 status='in_service'
    // 且挂在机柜上，下架之后这个房间新建的单不会再把它收进 device 范围（这是"范围在建单时冻结"
    // 的另一面：新单从一开始就收不进已经不在用的设备）。
    const sheet2 = (await createSheetAs(f, 2, roomName)).body;
    const rmWithTwoSheets = await f.api('GET', '/' + device.id + '/record-management', undefined, 1);
    check('references准备:两张单(1已提交+1草稿)累计为2', rmWithTwoSheets.body.references.inspection_sheets === 2, rmWithTwoSheets.body);

    // 删除前先下架（rack_out）——detached()那道闸对"仍在机柜/在用"的资产本来就会先拦一次，要单独
    // 看清"是inspection_sheets这一条在挡"，得先把"仍在用"这个更前置的理由排除掉。rack_out 不看
    // 巡检单引用，即便设备已在两张单的范围里也能正常下架。
    const afterReclassify = (await f.api('GET', '/' + device.id + '/record-management', undefined, 1)).body.asset;
    const rackOut = await f.api('POST', '/' + device.id + '/actions/rack_out', { expected_version: afterReclassify.version }, 1);
    check('references准备:下架200(排除detached()挡路,单独看inspection_sheets这条)', rackOut.status === 200 && rackOut.body.rack_id === null, rackOut.body);
    const afterRackOut = rackOut.body;

    // 第8条反向证明的严格版本：上面 category='other'→'server' 那次改类别，target==='server'，根本
    // 没碰到第52行 `refs.inspections&&target!=='server'` 这条判据（target!=='server'恒假），不算
    // 真正验证"inspection_sheets没有被并入refs.inspections"。这里反过来再改一次 'server'→'other'
    // （target='other'!=='server'为真，且此刻 refs.inspections 仍是0——本测试全程没有调用过标准
    // 单独采集，从未往 it_device_inspections 插过行——只有 refs.inspection_sheets>0），才是真正踩在
    // 第52行判据的触发条件上验证它。
    const reclassify2 = await f.api('POST', '/' + device.id + '/record-management', { action: 'reclassify', category: 'other', reason: '第8条反向证明(target!==server分支)', expected_version: afterRackOut.version }, 1);
    check('references:再次改类别(target!==server分支,第8条反向证明完整覆盖)', reclassify2.status === 200, reclassify2.body);
    const afterReclassify2 = reclassify2.body.asset;

    // C3b H1（Opus预筛）：原来这里直接用上面这台已经经历过 reclassify(写审计)+rack_out(写事件)
    // 的设备测删除/彻底删除被挡——但 refs.managed(reclassify的审计行)、refs.used(rack_out的事件行)
    // 此刻都已经非零，即便去掉 refs.inspection_sheets 这一项，删除依然会被这两项之一挡住，断言测不出
    // inspection_sheets 本身有没有起作用(无判别力)。改用一台全新设备，用直接SQL把它挪出机柜+置为
    // in_depot(不经过rack_out这个action，不产生it_asset_events/it_asset_record_audit行)，先断言
    // 前提(其余refs字段全0、inspection_sheets非零)，再断言delete_reason/purge_reason非空；对照组
    // 直接SQL删掉该资产的device检查项行后delete_reason变null，证明因果关系精确成立。
    // 用独立机房(自己的机柜)，不复用 roomName——roomName 此刻还有 sheet2 这张活跃草稿单占着
    // UNIQUE INDEX(sheet_id,status='draft')，在这里再建一张会409，H1 的设备根本进不了任何单的
    // device 范围(此前一版真栽在这个坑上：createSheetAs 静默拿到409，device2 从未被任何真实单
    // 收录，inspection_sheets 前提断言直接失败)。
    const roomH1 = roomName + '-H1';
    const rackH1 = (await f.api('POST', '/racks', { name: roomH1 + '-柜1', room: roomH1, u_total: 20 })).body;
    const device2 = (await f.api('POST', '', { category: 'server', name: roomH1 + '-设备(H1专用)', sn: 'SN-H1-' + Date.now(), attrs: { ip: '203.0.113.9' }, u_height: 1, placement: { kind: 'rack', rack_id: rackH1.id, u_start: 1 } })).body;
    await createSheetAs(f, 2, roomH1);
    const rmH1BeforeMove = await f.api('GET', '/' + device2.id + '/record-management', undefined, 1);
    check('H1准备:新设备已计入inspection_sheets(前提成立)', rmH1BeforeMove.body.references.inspection_sheets === 1, rmH1BeforeMove.body);
    // 直接SQL挪出机柜+置in_depot——不经过rack_out这个action，不写it_asset_events/it_asset_record_audit。
    // C3d 第7条踩坑：只清rack_id会留下u_start非空，'非在位机柜设备须rack_id/u_start为空'这条
    // 资产不变量校验(validateAssetInvariants)在真调用写动作(delete)时会拦下来——之前只用GET读
    // 从未触发写路径的这层校验，没暴露这个不一致。一并清空u_start才是"真下架"的完整状态。
    await f.run("UPDATE it_assets SET rack_id=NULL, u_start=NULL, status='in_depot' WHERE id=?", [device2.id]);
    const rmH1 = await f.api('GET', '/' + device2.id + '/record-management', undefined, 1);
    const refsH1 = rmH1.body.references;
    check('H1前提:其余refs字段全为0(used/managed/stocktakes/reconciles/inspections)', refsH1.used === 0 && refsH1.managed === 0 && refsH1.stocktakes === 0 && refsH1.reconciles === 0 && refsH1.inspections === 0, refsH1);
    check('H1前提:inspection_sheets非零(仅有的非零字段)', refsH1.inspection_sheets === 1, refsH1);
    check('H1:delete_reason非空(仅因inspection_sheets被挡,判别力成立)', typeof rmH1.body.delete_reason === 'string' && rmH1.body.delete_reason.length > 0, rmH1.body);
    check('H1:purge_reason非空(仅因inspection_sheets被挡,判别力成立)', typeof rmH1.body.purge_reason === 'string' && rmH1.body.purge_reason.length > 0, rmH1.body);
    // C3d 第7条（37T）：只查GET的delete_reason/purge_reason字符串测不出删除/彻底删除接口自己是否
    // 真的参与了判定——哪怕接口内部完全忽略inspection_sheets这条引用，只要被别的历史拦住，GET查到
    // 的字符串依然非空，断言照样全绿。这里真调用两个接口断言409。
    const h1Fresh = rmH1.body.asset;
    const h1DeleteTry = await f.api('POST', '/' + device2.id + '/record-management', { action: 'delete', reason: 'H1真删除测试', expected_version: h1Fresh.version }, 1);
    check('H1:真调用删除接口409(仅因inspection_sheets被挡)', h1DeleteTry.status === 409 && /已有业务或管理历史/.test(h1DeleteTry.body.message || ''), h1DeleteTry.body);
    const h1PurgeTry = await f.api('DELETE', '/' + device2.id + '/purge', { reason: 'H1真彻底删除测试', confirm_name: h1Fresh.name, expected_version: h1Fresh.version }, 1);
    check('H1:真调用彻底删除接口409(仅因inspection_sheets被挡)', h1PurgeTry.status === 409 && /已有业务或管理历史/.test(h1PurgeTry.body.message || ''), h1PurgeTry.body);
    // 对照组：直接SQL删掉该资产的device检查项行(不影响其余refs字段)，inspection_sheets归零后
    // delete_reason应变null——证明因果关系精确成立，不是巧合。
    await f.run("DELETE FROM it_inspection_sheet_items WHERE section='device' AND target_id=?", [device2.id]);
    const rmH1After = await f.api('GET', '/' + device2.id + '/record-management', undefined, 1);
    check('H1对照组:删掉device检查项行后inspection_sheets归零', rmH1After.body.references.inspection_sheets === 0, rmH1After.body);
    check('H1对照组:delete_reason变为null(因果关系精确成立)', rmH1After.body.delete_reason === null, rmH1After.body);
    // C3d 第7条：移除引用后，真调用删除接口的阻挡也应消失（不再409，直接200成功）——这是"阻挡
    // 消失"唯一有判别力的证明方式，不是再看一遍GET返回的字符串。
    const h1DeleteAfter = await f.api('POST', '/' + device2.id + '/record-management', { action: 'delete', reason: 'H1移除引用后删除测试', expected_version: rmH1After.body.asset.version }, 1);
    check('H1对照组:移除引用后真调用删除接口200(阻挡消失)', h1DeleteAfter.status === 200, h1DeleteAfter.body);

    // C3f 第1条（37-R2 partial）：彻底删除(purge)也要真调用断言成功，不只查GET的purge_reason。
    // device2此刻已被上面的delete动作消费掉(逻辑删除)，不能复用来测purge——另建一台隔离资产
    // (device3，独立机房，只有inspection_sheets这一条引用)专门测purge：引用还在时409对照保留，
    // 移除引用后真调用purge断言成功。
    const roomH1Purge = roomName + '-H1Purge';
    const rackH1Purge = (await f.api('POST', '/racks', { name: roomH1Purge + '-柜1', room: roomH1Purge, u_total: 20 })).body;
    const device3 = (await f.api('POST', '', { category: 'server', name: roomH1Purge + '-设备(H1Purge专用)', sn: 'SN-H1Purge-' + Date.now(), attrs: { ip: '203.0.113.19' }, u_height: 1, placement: { kind: 'rack', rack_id: rackH1Purge.id, u_start: 1 } })).body;
    await createSheetAs(f, 2, roomH1Purge);
    const rmH1PurgeBefore = await f.api('GET', '/' + device3.id + '/record-management', undefined, 1);
    check('H1Purge准备:新设备已计入inspection_sheets(前提成立)', rmH1PurgeBefore.body.references.inspection_sheets === 1, rmH1PurgeBefore.body);
    await f.run("UPDATE it_assets SET rack_id=NULL, u_start=NULL, status='in_depot' WHERE id=?", [device3.id]);
    const rmH1Purge = await f.api('GET', '/' + device3.id + '/record-management', undefined, 1);
    check('H1Purge前提:其余refs字段全为0', rmH1Purge.body.references.used === 0 && rmH1Purge.body.references.managed === 0 && rmH1Purge.body.references.stocktakes === 0 && rmH1Purge.body.references.reconciles === 0 && rmH1Purge.body.references.inspections === 0, rmH1Purge.body.references);
    check('H1Purge前提:inspection_sheets非零(仅有的非零字段)', rmH1Purge.body.references.inspection_sheets === 1, rmH1Purge.body.references);
    const h1PurgeBefore = rmH1Purge.body.asset;
    const h1PurgeTryBefore = await f.api('DELETE', '/' + device3.id + '/purge', { reason: 'H1Purge引用还在测试', confirm_name: h1PurgeBefore.name, expected_version: h1PurgeBefore.version }, 1);
    check('H1Purge:引用还在时真调用彻底删除409(对照保留)', h1PurgeTryBefore.status === 409 && /已有业务或管理历史/.test(h1PurgeTryBefore.body.message || ''), h1PurgeTryBefore.body);
    await f.run("DELETE FROM it_inspection_sheet_items WHERE section='device' AND target_id=?", [device3.id]);
    const rmH1PurgeAfter = await f.api('GET', '/' + device3.id + '/record-management', undefined, 1);
    check('H1Purge对照组:移除引用后inspection_sheets归零', rmH1PurgeAfter.body.references.inspection_sheets === 0, rmH1PurgeAfter.body);
    const h1PurgeTryAfter = await f.api('DELETE', '/' + device3.id + '/purge', { reason: 'H1Purge移除引用后测试', confirm_name: rmH1PurgeAfter.body.asset.name, expected_version: rmH1PurgeAfter.body.asset.version }, 1);
    check('H1Purge:移除引用后真调用彻底删除成功(阻挡消失)', h1PurgeTryAfter.status === 200, h1PurgeTryAfter.body);
    check('H1Purge:彻底删除后资产真的不存在了(不是假成功)', (await f.all('SELECT id FROM it_assets WHERE id=?', [device3.id])).length === 0, {});

    const delTry = await f.api('POST', '/' + device.id + '/record-management', { action: 'delete', reason: '误建测试', expected_version: afterReclassify2.version }, 1);
    check('references:巡检单范围内的资产不能删除409(现实多因素场景,与上面H1精确判别力互补)', delTry.status === 409 && /已有业务或管理历史/.test(delTry.body.message || ''), delTry.body);
    const purgeTry = await f.api('DELETE', '/' + device.id + '/purge', { reason: '彻底删除测试', confirm_name: afterReclassify2.name, expected_version: afterReclassify2.version }, 1);
    check('references:巡检单范围内的资产不能彻底删除409(现实多因素场景,与上面H1精确判别力互补)', purgeTry.status === 409 && /已有业务或管理历史/.test(purgeTry.body.message || ''), purgeTry.body);

    // 逻辑删除第一张(已提交)单——references().inspection_sheets 应仍计入它(含已逻辑删除)，此刻两张
    // 单(1已逻辑删除+1草稿)累计仍是2。
    const del = await f.api('DELETE', '/inspections/sheets/' + sheet.id, { expected_version: submit.body.version, reason: '逻辑删除测试' }, 2);
    check('references准备:逻辑删除200', del.status === 200, del.body);
    const rmAfterLogicalDelete = await f.api('GET', '/' + device.id + '/record-management', undefined, 1);
    check('references:巡检单被逻辑删除后引用仍计入(含已逻辑删除,两张单累计仍2)', rmAfterLogicalDelete.body.references.inspection_sheets === 2, rmAfterLogicalDelete.body);

    // 物理删除第二张(草稿)单——引用应减为1(只剩已逻辑删除那张)。
    const delDraft = await f.api('DELETE', '/inspections/sheets/' + sheet2.id, { expected_version: sheet2.version }, 2);
    check('references准备:草稿物理删除200', delDraft.status === 200, delDraft.body);
    const rmAfterPhysicalDelete = await f.api('GET', '/' + device.id + '/record-management', undefined, 1);
    check('references:巡检单被物理删除后该条引用消失(仍剩逻辑删除那1条)', rmAfterPhysicalDelete.body.references.inspection_sheets === 1, rmAfterPhysicalDelete.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_REFERENCES PASS=${pass}`);
}

// ============================================================
// 10) 草稿删除解除采集归属（方案 §5.5）：该单关联的采集记录 sheet_id 置空、detached_from_sheet_id
//     置为本单；解除后该记录可单独判断。
// ============================================================
async function testDraftDeleteDetaches() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3-DraftDelete', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
    fc.setOverrides({ sn: assetSn });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('草稿删除准备:采集201', collectResp.status === 201, collectResp.body);
    const recordId = collectResp.body.inspection.id;
    const beforeDelete = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
    check('草稿删除准备:删除前该记录确实归属本单(前提成立)', beforeDelete.sheet_id === w.sheet.id, beforeDelete);

    // C3b M7：解除归属对照组（草稿删除这一支）——另一张单也采一次、加一条标准单独采集记录，证明
    // "草稿删除只解除本单关联记录的归属，不会牵连其他记录"（UPDATE 按 sheet_id=? 定位，理论上只影响
    // 本单，这里用真实数据防回归）。
    const w2 = await buildDraftSheetWithDevice(f, 'C3-DraftDelete-Other', 2);
    const detailW2 = await getSheetAs(f, w2.sheet.id, 2);
    const itemW2 = deviceItemOf(detailW2.body, w2.device.id);
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w2.device.id]))[0].sn });
    const collectW2 = await collectOnSheet(f, w2.sheet.id, itemW2.id, 2);
    check('M7对照组准备(草稿删除):另一张单采集201', collectW2.status === 201, collectW2.body);
    const standaloneDevice = await makeCollectibleAsset(f);
    const collectStandaloneResp = await seedStandaloneInspection(f, standaloneDevice.id);
    check('M7对照组准备(草稿删除):历史独立记录已插入(标准单独采集已退役)', collectStandaloneResp.status === 201, collectStandaloneResp.body);
    const controlIds = { W2: collectW2.body.inspection.id, standalone: collectStandaloneResp.body.id };
    const controlBefore = {};
    for (const key of Object.keys(controlIds)) controlBefore[key] = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [controlIds[key]]))[0];

    // C3d 第6条（37T）：上面的对照组全是不同资产，补两条同资产对照——①历史独立记录 ②另一张单
    // (同资产，直接SQL把检查项target_id改指到本资产)，证明草稿删除的解除归属(按sheet_id=?定位)
    // 不会误伤同一资产在其它地方的记录（防"WHERE条件写错成按asset_id批量改"这类回归）。
    const sameAssetStandalone = await seedStandaloneInspection(f, w.device.id);
    check('同资产对照组准备(草稿删除):历史独立记录已插入(标准单独采集已退役)', sameAssetStandalone.status === 201, sameAssetStandalone.body);
    const w3 = await buildDraftSheetWithDevice(f, 'C3-DraftDelete-CrossSheet', 2);
    const detailW3 = await getSheetAs(f, w3.sheet.id, 2);
    const itemW3 = deviceItemOf(detailW3.body, w3.device.id);
    await f.run('UPDATE it_inspection_sheet_items SET target_id=? WHERE id=?', [w.device.id, itemW3.id]);
    fc.setOverrides({ sn: assetSn });
    const collectW3 = await collectOnSheet(f, w3.sheet.id, itemW3.id, 2);
    check('同资产跨单对照组准备(草稿删除):另一张单(同资产)采集201', collectW3.status === 201, collectW3.body);
    const sameAssetIds = { standalone: sameAssetStandalone.body.id, crossSheet: collectW3.body.inspection.id };
    const sameAssetBefore = {};
    for (const key of Object.keys(sameAssetIds)) sameAssetBefore[key] = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [sameAssetIds[key]]))[0];

    const del = await f.api('DELETE', '/inspections/sheets/' + w.sheet.id, { expected_version: w.sheet.version }, 2);
    check('草稿删除:物理删除200', del.status === 200 && del.body.ok === true, del.body);
    const afterDelete = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
    check('草稿删除:该记录sheet_id已置空', afterDelete.sheet_id === null, afterDelete);
    check('草稿删除:该记录detached_from_sheet_id指向已删除的本单', afterDelete.detached_from_sheet_id === w.sheet.id, afterDelete);
    for (const key of Object.keys(controlIds)) {
      const after = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [controlIds[key]]))[0];
      check(`M7对照组(草稿删除):非目标记录[${key}]的sheet_id/detached_from_sheet_id两列不变`, after.sheet_id === controlBefore[key].sheet_id && after.detached_from_sheet_id === controlBefore[key].detached_from_sheet_id, { key, before: controlBefore[key], after });
    }
    for (const key of Object.keys(sameAssetIds)) {
      const after = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [sameAssetIds[key]]))[0];
      check(`同资产对照组(草稿删除):删除后同资产记录[${key}]的sheet_id/detached_from_sheet_id两列不变`, after.sheet_id === sameAssetBefore[key].sheet_id && after.detached_from_sheet_id === sameAssetBefore[key].detached_from_sheet_id, { key, before: sameAssetBefore[key], after });
    }
    // C7：判断路由已整体退役——草稿删除解除归属后，这条记录视同单独采集，C3时代"可单独判断200"
    // 这条正向断言随退役一并失效，改判404（裸fetch，f.api()对HTML404响应体.json()会抛异常）。
    const reviewedUrlPath = '/api/it-assets/inspections/' + recordId + '/review';
    const reviewedResp = await fetch(f.base + reviewedUrlPath, { method: 'POST', headers: { Authorization: 'Bearer fixture-2', 'Content-Type': 'application/json' }, body: JSON.stringify({ judgement: 'attention', note: '草稿删除后单独判断' }) });
    check('C7:草稿删除解除归属后,判断路由仍404(不会因为detached就恢复200,路由本身已不存在)', reviewedResp.status === 404, reviewedResp.status);
    checkExpressDefault404('草稿删除解除归属后的判断路由', 'POST', reviewedUrlPath, reviewedResp.headers.get('content-type') || '', await reviewedResp.text());
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_DRAFT_DELETE_DETACH PASS=${pass}`);
}

// ============================================================
// C3b M6：it_device_inspections 表级 CHECK「两列不同时非空」——直接 SQL 反例：sheet_id 与
// detached_from_sheet_id 同时非空 → CHECK constraint failed；各只一列非空（或都为空）→ 成功。
// 用真实建表（走一次正常采集触发 collect.ensure()），不需要单独的隔离环境。
// ============================================================
async function testTwoColumnCheckConstraint() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3-CheckConstraint', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn });
    const collectResp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('CHECK准备:采集201(借此触发collect.ensure()真实建表)', collectResp.status === 201, collectResp.body);
    const recordId = collectResp.body.inspection.id;

    // 反例：两列同时非空 → CHECK constraint failed。
    let rejected = false;
    let rejectMessage = '';
    try {
      await f.run('UPDATE it_device_inspections SET sheet_id=?, detached_from_sheet_id=? WHERE id=?', [w.sheet.id, w.sheet.id, recordId]);
    } catch (e) {
      rejected = true;
      rejectMessage = e.message || String(e);
    }
    check('CHECK反例:两列同时非空被拒(CHECK constraint failed)', rejected && /CHECK constraint failed/.test(rejectMessage), rejectMessage);
    const afterReject = (await f.all('SELECT sheet_id,detached_from_sheet_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
    check('CHECK反例:被拒后原有数据不变(仍是sheet_id非空、detached为空)', afterReject.sheet_id === w.sheet.id && afterReject.detached_from_sheet_id === null, afterReject);

    // 正向：各只一列非空 → 成功。
    const acceptDetached = await f.run('UPDATE it_device_inspections SET sheet_id=NULL, detached_from_sheet_id=? WHERE id=?', [w.sheet.id, recordId]);
    check('CHECK正向:只detached_from_sheet_id非空(sheet_id为空)成功', acceptDetached.changes === 1, acceptDetached);
    const acceptSheetId = await f.run('UPDATE it_device_inspections SET sheet_id=?, detached_from_sheet_id=NULL WHERE id=?', [w.sheet.id, recordId]);
    check('CHECK正向:只sheet_id非空(detached为空)成功', acceptSheetId.changes === 1, acceptSheetId);
    const acceptBothNull = await f.run('UPDATE it_device_inspections SET sheet_id=NULL, detached_from_sheet_id=NULL WHERE id=?', [recordId]);
    check('CHECK正向:两列都为空(既不归属也未解除,如标准单独采集)成功', acceptBothNull.changes === 1, acceptBothNull);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_CHECK_CONSTRAINT PASS=${pass}`);
}

// ============================================================
// C3b M1（G1A 已按新语义重写判据顺序——不再有"第一阶段失败先记下、延后到第二阶段才抛"的机制，
// checkCollectable 在两个阶段各自完整判一遍，失败即抛，见 inspection-sheets.js 采集路由注释）：
// 若调用者根本看不见这张单，错误码不能在可见性确认之前就把"这张看不见的单是否存在"泄露出去。
// 补两例：不存在的单、非管理员看已逻辑删除的单——返回码完全相同（404 SHEET_NOT_FOUND），且假采集
// 器全程未被调用；他人草稿（summary）同理不得泄露检查项分段或资产信息（isManager 判定在 item/资产
// 查询之前，先给 403）。G1A 之后这三例的"假采集器未被调用"不再是"因为该分支恰好没走到集抓集"，
// 而是 checkCollectable 判定顺序本身保证的（更完整的测试见本文件末尾
// testFirstStageRejectionsNoCollection，本函数保留作历史/M1 场景的独立佐证）。
// ============================================================
async function testM1VisibilityGatesPhase1Error() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    // 持久计数，不用 fc.setOnEnter（那是一次性的，触发一次就被消费掉，这里要跨多个子例累计计数）。
    let collectorCalls = 0;
    const originalCollect = fc.collector.collect;
    fc.collector.collect = async (...args) => { collectorCalls += 1; return originalCollect.apply(fc.collector, args); };

    // 例1：不存在的单——item 查询按 id=? AND sheet_id=? 精确匹配，一个从未存在过的 sheetId 不可能
    // 匹配到任何 item，第一阶段自然失败；第二阶段 freshSheet 也查不到，两条路径汇合成同一个404。
    const bogusResp = await collectOnSheet(f, 999999, 1, 1); // uid=1管理员，排除权限干扰，只看单据本身
    check('M1例1:不存在的单→404 SHEET_NOT_FOUND', bogusResp.status === 404 && bogusResp.body.code === 'SHEET_NOT_FOUND', bogusResp.body);
    check('M1例1:假采集器未被调用', collectorCalls === 0, { collectorCalls });

    // 例2：非管理员看已逻辑删除的单——item 确实存在且属于该单、section=device，资产本身保持真实
    // 合格（G1A-b L11：去掉了原先"额外把设备置为retired"这个构造——checkSheetAndItem 现在把
    // sheetVisibility==='none' 判定排在 isManager/status/item/资产资格所有判定之前，"假采集器未被
    // 调用"这个断言完全由可见性短路本身保证，不需要再靠资产不合格来兜底；若retired还留着，即使日后
    // 有人不小心把可见性判定挪到资产资格判定之后，这条测试也会因为资产恰好不合格而侥幸不触发采集，
    // 测不出回归——去掉retired后，这条测试才是"可见性判定顺序"本身的真判别力）。
    const w = await buildDraftSheetWithDevice(f, 'C3b-M1-DeletedSheet', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: detail.body.version, items: fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('M1例2准备:PUT补全200', put.status === 200, put.body);
    await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('M1例2准备:提交200', submit.status === 200, submit.body);
    const del = await f.api('DELETE', '/inspections/sheets/' + w.sheet.id, { expected_version: submit.body.version, reason: 'M1测试删除' }, 2);
    check('M1例2准备:逻辑删除200', del.status === 200, del.body);
    // uid=3 默认只有 read 级 ACL，会先被 requireLedgerWrite 中间件挡在路由之外(403)，根本进不了
    // 这条路由——要验证的是"路由内部的可见性判定"，得用一个有写权限、但不是本单巡检人也不是管理员
    // 的用户(uid=5，夹具默认不在 ACL 里，需要显式插入 write 级)。
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    const deletedResp = await collectOnSheet(f, w.sheet.id, item.id, 5); // uid=5写权限、非管理员、非本单巡检人
    check('M1例2:非管理员看已逻辑删除的单→404 SHEET_NOT_FOUND(与例1返回码完全相同)', deletedResp.status === 404 && deletedResp.body.code === 'SHEET_NOT_FOUND', deletedResp.body);
    check('M1例2:假采集器未被调用', collectorCalls === 0, { collectorCalls });

    // 他人草稿(summary可见性)同理不得泄露检查项分段或资产信息——非owner非admin对一张draft单的
    // 可见性是summary(不是none)，isManager会先给403，同样不会走到item/资产查询那一步。注意：这个
    // 场景的设备是真实合格的——G1A 之前 isManager 的判定被推迟到第二阶段，第一阶段(collectPhase1
    // Check)只查检查项与资产，会正常成功并真的调用一次采集器才被第二阶段拒绝(P5、37S H1 的病根)；
    // G1A 之后 checkCollectable 把 isManager 判定挪到 item/资产查询之前，两个阶段都用同一份判定，
    // 第一阶段(第一次withWrite)本身就会在isManager这一步拒绝，不会再有"白跑一次采集"的残留——
    // 这里补回"假采集器未被调用"的断言，之前(G1A之前)因为这个已知残留只能不做这条断言。
    const w2 = await buildDraftSheetWithDevice(f, 'C3b-M1-OthersDraft', 2);
    const detail2 = await getSheetAs(f, w2.sheet.id, 2);
    const item2 = deviceItemOf(detail2.body, w2.device.id);
    // uid=5 的 write 级 ACL 已经在例2那段插过了(同一个夹具，不能重复插入撞主键)。
    collectorCalls = 0;
    const othersDraftResp = await collectOnSheet(f, w2.sheet.id, item2.id, 5); // uid=5写权限但非本单巡检人非管理员
    check('M1他人草稿:403 SHEET_FORBIDDEN(不泄露检查项分段或资产信息,不是笼统的资产不合格提示)', othersDraftResp.status === 403 && othersDraftResp.body.code === 'SHEET_FORBIDDEN', othersDraftResp.body);
    check('M1他人草稿:假采集器未被调用(G1A修复后不再有白跑一次采集的残留)', collectorCalls === 0, { collectorCalls });
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_M1_VISIBILITY_GATE PASS=${pass}`);
}

// ============================================================
// C3b M1旁证（原标注为M2，复核后改正——本例第一阶段就先撞上host()异常，checkCollectable 内
// target() 的调用没有 .status，直接原样冒出第一个 withWrite、一路冒到路由最外层的
// catch(e){handleErr(res,e)}，根本不经过reverifyTarget自己的分类catch，验证的其实是"第一阶段的
// 原始异常被重新抛出时中途没被裹坏"——不是M2业务/意外错误分类本身。真正踩在M2判据上的场景已补在
// testRaceWindowReverify的最后一条scenario（"第二阶段host()内部故障...真正踩在M2判据上"）：让第
// 一阶段先成功，只在锁外窗口内换掉host()，逼reverifyTarget自己的target()调用去撞异常。两例都留着，
// 互不重复：这例证明第一阶段的异常不背刺，那例证明reverifyTarget路径按判据分类。
// ============================================================
async function testM1PhaseErrorRethrowNotReclassified() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3b-M2', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const item = deviceItemOf(detail.body, w.device.id);
    // host() 直接抛一个普通 Error（没有 .status/.code）——第一阶段 checkCollectable 里的 target()
    // 调用先撞上，第一个 withWrite 本身就以这个原始错误失败，一路冒到路由最外层的
    // catch(e){handleErr(res,e)}。
    fc.collector.host = () => { throw new Error('模拟collector.host()内部故障(无status)'); };
    const resp = await collectOnSheet(f, w.sheet.id, item.id, 2);
    check('M1旁证:第一阶段host()内部故障(无status)最终是500,重新抛出时未被裹坏或误判成409', resp.status === 500 && resp.body.code === 'LEDGER_INTERNAL', resp.body);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_M1_RETHROW_FIDELITY PASS=${pass}`);
}

// ============================================================
// C3d 第8条（37T）：makeFakeCollector 早就支持 identity-mismatch 与 throw 两种模式（用于既有
//   inspections-browser 套件），但 collect 这条测试套件从未真正触发过——身份不符改写failed快照
//   （collectSnapshot 的第二个 if）、collect() 抛异常被吞掉改写（try/catch）这两段代码，若被误删
//   现有断言测不出来。各触发一次，核对落库的 collection_status、错误信息、不保存不匹配硬件数据。
// ============================================================
async function testFakeCollectorIdentityMismatchAndThrowModes() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    // C3f 第2条（37-R2 partial）：接口返回值本身可能被响应整形层"美化"过，不能只看collectOnSheet
    // 的返回体——读回真正落库的行（直接SQL，绕开任何响应层加工），逐项核对collection_status、
    // 错误信息、硬件字段为空。
    async function readBack(recordId) {
      const row = (await f.all('SELECT * FROM it_device_inspections WHERE id=?', [recordId]))[0];
      return { row, snapshot: JSON.parse(row.snapshot_json) };
    }
    // C3g（37-R3 partial）：只按响应里的记录id readBack不够——如果采集路由错误地"复用上一场景
    // 的记录id"（比如source_host分支根本没真的落一条新记录，直接把sn-mismatch那条的id原样传回），
    // 只查这一个id仍然能读到一条collection_status=failed、错误信息一致、硬件字段为空的行，测试照样
    // 通过。改用方案一：调用前后各统计一次"这台设备名下的记录数"，断言恰好多了一条；读回的那一行
    // 额外断言sheet_id/asset_id对应当前单据与设备；当前检查项的device_inspection_id指向这条新记录
    // ——三条一起，才能证明"这条记录确实是这次新增、且属于当前场景"，不是复用来的。
    async function countByAsset(assetId) {
      // 本函数可能在任何一次真实采集把it_device_inspections表懒建出来之前就被调用（比如本测试
      // 函数第一个场景的"采集前"计数）——先查表存不存在，不存在按0计数，不直接查会报SQLITE_ERROR。
      const exists = await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name='it_device_inspections'");
      if (!exists.length) return 0;
      return (await f.all('SELECT COUNT(*) n FROM it_device_inspections WHERE asset_id=?', [assetId]))[0].n;
    }
    async function assertNewOwnedRecord(label, w, item, recordId) {
      const row = (await f.all('SELECT sheet_id,asset_id FROM it_device_inspections WHERE id=?', [recordId]))[0];
      check(`${label}:读回行归属正确(sheet_id对应当前单据、asset_id对应当前设备)`, !!row && row.sheet_id === w.sheet.id && row.asset_id === w.device.id, row);
      const itemAfter = (await f.all('SELECT device_inspection_id FROM it_inspection_sheet_items WHERE id=?', [item.id]))[0];
      check(`${label}:当前检查项device_inspection_id指向这条新记录`, itemAfter.device_inspection_id === recordId, itemAfter);
    }
    // identity-mismatch（序列号不符）：远端序列号与登记设备不符。
    {
      const w = await buildDraftSheetWithDevice(f, 'C3d-Identity', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn });
      fc.setMode('identity-mismatch');
      const beforeCount = await countByAsset(w.device.id);
      const resp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      const afterCount = await countByAsset(w.device.id);
      check('假采集器identity-mismatch(sn):采集201但collection_status=failed', resp.status === 201 && resp.body.inspection.collection_status === 'failed', resp.body);
      check('假采集器identity-mismatch(sn):错误信息提示身份不符', resp.body.inspection.snapshot.component_errors[0] === '远端身份与登记设备不一致，本次未保存其硬件数据', resp.body);
      check('假采集器identity-mismatch(sn):不保存不匹配的硬件数据(server为null、volumes为空)', resp.body.inspection.snapshot.server === null && Array.isArray(resp.body.inspection.snapshot.volumes) && resp.body.inspection.snapshot.volumes.length === 0, resp.body);
      check('假采集器identity-mismatch(sn):该设备记录数恰好多了一条(不是复用旧记录)', afterCount === beforeCount + 1, { beforeCount, afterCount });
      const { row: savedSn, snapshot: savedSnSnapshot } = await readBack(resp.body.inspection.id);
      check('假采集器identity-mismatch(sn):读回落库行collection_status=failed', savedSn.collection_status === 'failed', savedSn);
      check('假采集器identity-mismatch(sn):读回落库快照错误信息一致', savedSnSnapshot.component_errors[0] === '远端身份与登记设备不一致，本次未保存其硬件数据', savedSnSnapshot);
      check('假采集器identity-mismatch(sn):读回落库快照硬件字段为空', savedSnSnapshot.server === null && savedSnSnapshot.volumes.length === 0, savedSnSnapshot);
      await assertNewOwnedRecord('假采集器identity-mismatch(sn)', w, item, resp.body.inspection.id);
      fc.setMode('success');
    }
    // C3f 第2条新增：source_host单独不符（sn仍相符）——不能只靠sn那一半判据兜底身份核对。让
    // target()判定资产合格（资产attrs.ip与collector.host()一致，用一个新值altHost），但collect()
    // 的snapshot.source_host固定返回HOST常量（假采集器写死的），两者不等，制造"只有source_host
    // 不符"的场景，隔离出这一半判据独立生效。
    {
      const w = await buildDraftSheetWithDevice(f, 'C3f-SourceHostMismatch', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      const assetSn = (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn;
      fc.setOverrides({ sn: assetSn });
      const altHost = '203.0.113.88';
      await f.run('UPDATE it_assets SET attrs=? WHERE id=?', [JSON.stringify({ ip: altHost }), w.device.id]);
      const originalHost = fc.collector.host;
      fc.collector.host = () => altHost;
      // C3g：捕获假采集器这次真正返回的原始快照(collectSnapshot改写成failed之前)，证明这个场景
      // 确实只在source_host这一项上不符——sn与登记值相符、source_host与登记主机(altHost)不同。
      let capturedRawSnapshot = null;
      const originalCollect = fc.collector.collect;
      fc.collector.collect = async (...args) => { const r = await originalCollect.apply(fc.collector, args); capturedRawSnapshot = r; return r; };
      const beforeCount = await countByAsset(w.device.id);
      const resp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      const afterCount = await countByAsset(w.device.id);
      fc.collector.host = originalHost;
      fc.collector.collect = originalCollect;
      check('假采集器source_host不符:原始快照证明只有source_host不符(sn相符、source_host与登记主机不同)', !!capturedRawSnapshot && capturedRawSnapshot.server.serial_number.trim().toUpperCase() === assetSn.trim().toUpperCase() && capturedRawSnapshot.source_host === HOST && HOST !== altHost, capturedRawSnapshot); // 37-R4 M：source_host 精确等于假采集器固定返回的 HOST（不接受缺失值），且与登记主机 altHost 不同
      check('假采集器source_host不符(sn仍相符):采集201但collection_status=failed', resp.status === 201 && resp.body.inspection.collection_status === 'failed', resp.body);
      check('假采集器source_host不符:错误信息提示身份不符', resp.body.inspection.snapshot.component_errors[0] === '远端身份与登记设备不一致，本次未保存其硬件数据', resp.body);
      check('假采集器source_host不符:不保存不匹配的硬件数据(server为null、volumes为空)', resp.body.inspection.snapshot.server === null && Array.isArray(resp.body.inspection.snapshot.volumes) && resp.body.inspection.snapshot.volumes.length === 0, resp.body);
      check('假采集器source_host不符:该设备记录数恰好多了一条(不是复用sn-mismatch场景的旧记录)', afterCount === beforeCount + 1, { beforeCount, afterCount });
      const { row: savedHost, snapshot: savedHostSnapshot } = await readBack(resp.body.inspection.id);
      check('假采集器source_host不符:读回落库行collection_status=failed', savedHost.collection_status === 'failed', savedHost);
      check('假采集器source_host不符:读回落库快照错误信息一致', savedHostSnapshot.component_errors[0] === '远端身份与登记设备不一致，本次未保存其硬件数据', savedHostSnapshot);
      check('假采集器source_host不符:读回落库快照硬件字段为空', savedHostSnapshot.server === null && savedHostSnapshot.volumes.length === 0, savedHostSnapshot);
      await assertNewOwnedRecord('假采集器source_host不符', w, item, resp.body.inspection.id);
    }
    // throw：collect() 本身抛异常。
    {
      const w = await buildDraftSheetWithDevice(f, 'C3d-Throw', 2);
      const detail = await getSheetAs(f, w.sheet.id, 2);
      const item = deviceItemOf(detail.body, w.device.id);
      fc.setOverrides({ sn: (await f.all('SELECT sn FROM it_assets WHERE id=?', [w.device.id]))[0].sn });
      fc.setMode('throw');
      const resp = await collectOnSheet(f, w.sheet.id, item.id, 2);
      check('假采集器throw:采集201但collection_status=failed', resp.status === 201 && resp.body.inspection.collection_status === 'failed', resp.body);
      check('假采集器throw:错误信息是通用提示,不泄露采集器内部异常文本', resp.body.inspection.snapshot.component_errors[0] === '采集失败或超时，请检查连接后重试' && !JSON.stringify(resp.body).includes('模拟采集器异常'), resp.body);
      check('假采集器throw:不保存硬件数据(server为null)', resp.body.inspection.snapshot.server === null, resp.body);
      const { row: savedThrow, snapshot: savedThrowSnapshot } = await readBack(resp.body.inspection.id);
      check('假采集器throw:读回落库行collection_status=failed', savedThrow.collection_status === 'failed', savedThrow);
      check('假采集器throw:读回落库快照错误信息一致且不泄露内部异常', savedThrowSnapshot.component_errors[0] === '采集失败或超时，请检查连接后重试' && !JSON.stringify(savedThrowSnapshot).includes('模拟采集器异常'), savedThrowSnapshot);
      check('假采集器throw:读回落库快照硬件字段为空', savedThrowSnapshot.server === null, savedThrowSnapshot);
      fc.setMode('success');
    }
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_FAKE_MODES PASS=${pass}`);
}

// ============================================================
// C3d 第9条（37T）：同一张不可见单据，分别请求 room 段的行、无效检查项 id、资产不合格的 device
//   行三种第一阶段错误——response 逐字段（状态码/错误码/消息）必须完全一致，不能只是"都是404"
//   这种粗粒度比较；若实现让不同输入在不同判据上失败，会在这个逐字段比对上露出差异。用 uid=5（写
//   权限、非本单巡检人非管理员）访问一张他人草稿单（summary可见性），三种输入都该在第一阶段
//   （checkCollectable 内、item/资产查询之前）就统一先撞上同一个 isManager 判定，收敛成同一个
//   403 SHEET_FORBIDDEN——三种输入的差异（room段/无效id/资产不合格）根本没机会被判到，因为
//   isManager 排在它们前面。
// ============================================================
async function testM1SameInvisibleSheetErrorsIdentical() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    const w = await buildDraftSheetWithDevice(f, 'C3d-M9', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const roomItem = detail.body.items.find((it) => it.section === 'room');
    const deviceItem = deviceItemOf(detail.body, w.device.id);
    // 让device行资产不合格（retired），确保三种输入都真的在第一阶段各自的判据上失败（不是碰巧）。
    await f.run("UPDATE it_assets SET status='retired' WHERE id=?", [w.device.id]);
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");

    const respRoom = await collectOnSheet(f, w.sheet.id, roomItem.id, 5); // room段的行——非device
    const respBadItem = await collectOnSheet(f, w.sheet.id, 999999, 5); // 无效检查项id——查不到
    const respIneligible = await collectOnSheet(f, w.sheet.id, deviceItem.id, 5); // 合法device行但资产不合格(retired)

    // C3f 第3条（37-R2 partial）：不只比{status,code,message}这个自己挑的子集，断言整个响应体
    // （键集合+内容）完全相等，并且等于一个手写的最小期望对象——如果实现在某个分支意外多带了
    // field/detail等额外键（handleErr支持这两个可选字段），只比子集测不出来，全等比较才能。
    const keySet = (obj) => Object.keys(obj).sort().join(',');
    const bodies = [respRoom.body, respBadItem.body, respIneligible.body];
    check('M9:三种第一阶段错误状态码完全一致', respRoom.status === respBadItem.status && respBadItem.status === respIneligible.status, [respRoom.status, respBadItem.status, respIneligible.status]);
    check('M9:三种第一阶段错误响应体键集合完全一致', keySet(bodies[0]) === keySet(bodies[1]) && keySet(bodies[1]) === keySet(bodies[2]), bodies.map(keySet));
    check('M9:三种第一阶段错误响应体逐字节完全相等', JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]) && JSON.stringify(bodies[1]) === JSON.stringify(bodies[2]), bodies);
    // 手写的最小期望响应体——三种输入必须逐字节等于同一个字面量，不是"结构相似"或"字段子集匹配"。
    const expectedBody = { code: 'SHEET_FORBIDDEN', message: '只有巡检人或管理员可以采集' };
    check('M9:响应体与手写的最小期望对象完全相等', bodies.every((b) => JSON.stringify(b) === JSON.stringify(expectedBody)), { bodies, expectedBody });
    check('M9:统一收敛成403 SHEET_FORBIDDEN(显式断言保留)', respRoom.status === 403 && respRoom.body.code === 'SHEET_FORBIDDEN', respRoom.body);
    check('M9:响应体不含检查项细节(不支持采集/检查项不存在/资产不合格等具体文案)', !/该检查项不支持采集|检查项不存在|设备未配置可用的服务器采集连接|采集设备须登记序列号/.test(JSON.stringify(bodies)), bodies);
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_M9_INVISIBLE_CONSISTENCY PASS=${pass}`);
}

// ============================================================
// G1A-b L9（原C3f第3条"看不见的单"改造为真正的none场景，而不是summary）：同一张对调用者完全不
// 可见的单据（deleted_at已设+调用者非管理员=sheetVisibility==='none'），分别请求该行不存在(无效
// id)/该行非device段(room段)/资产不可采集(retired)三种第一阶段输入——三个响应{status,code,
// message}逐字段相同且等于手写404 SHEET_NOT_FOUND期望，假采集器调用次数精确为0（不泄露该单是否
// 存在、检查项分段、资产是否合格）。testM1SameInvisibleSheetErrorsIdentical(本文件上方)覆盖的是
// summary场景(403 SHEET_FORBIDDEN收敛，isManager判定)，两者判据不同、互不重复——本测试收敛的是
// checkSheetAndItem里更靠前的`!sheet||sheetVisibility===none`那一行。
// ============================================================
async function testL9NoneSheetInputsIdentical() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    let collectorCalls = 0;
    const originalCollect = fc.collector.collect;
    fc.collector.collect = async (...args) => { collectorCalls += 1; return originalCollect.apply(fc.collector, args); };

    const w = await buildDraftSheetWithDevice(f, 'G1A-L9-None', 2);
    const detail = await getSheetAs(f, w.sheet.id, 2);
    const roomItem = detail.body.items.find((it) => it.section === 'room');
    const deviceItem = deviceItemOf(detail.body, w.device.id);
    // 让device行资产不合格(retired)——证明就算这一条件也成立，仍然被可见性判定先挡下，不泄露。
    await f.run("UPDATE it_assets SET status='retired' WHERE id=?", [w.device.id]);
    // 补全并提交、再由巡检人本人逻辑删除，让sheetVisibility对非管理员(uid=5)判'none'
    // (deleted_at非空+非admin)。
    const put = await f.api('PUT', '/inspections/sheets/' + w.sheet.id, { expected_version: w.sheet.version, items: fillPayloadAllOk(detail.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('L9准备:PUT补全200', put.status === 200, put.body);
    await uploadAllRackFrontPhotos(f, w.sheet.id, w.sheet.scope, 2);
    const submit = await f.api('POST', '/inspections/sheets/' + w.sheet.id + '/submit', { expected_version: put.body.version }, 2);
    check('L9准备:提交200', submit.status === 200, submit.body);
    const del = await f.api('DELETE', '/inspections/sheets/' + w.sheet.id, { expected_version: submit.body.version, reason: 'L9测试删除' }, 2);
    check('L9准备:巡检人逻辑删除200', del.status === 200, del.body);
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");

    const respBadItem = await collectOnSheet(f, w.sheet.id, 999999, 5); // 该行不存在
    const respRoom = await collectOnSheet(f, w.sheet.id, roomItem.id, 5); // 该行非device段
    const respIneligible = await collectOnSheet(f, w.sheet.id, deviceItem.id, 5); // 资产不可采集(retired)

    const keySet = (obj) => Object.keys(obj).sort().join(',');
    const bodies = [respBadItem.body, respRoom.body, respIneligible.body];
    check('L9:三种第一阶段输入状态码完全一致', respBadItem.status === respRoom.status && respRoom.status === respIneligible.status, [respBadItem.status, respRoom.status, respIneligible.status]);
    check('L9:三种第一阶段输入响应体键集合完全一致', keySet(bodies[0]) === keySet(bodies[1]) && keySet(bodies[1]) === keySet(bodies[2]), bodies.map(keySet));
    check('L9:三种第一阶段输入响应体逐字节完全相等', JSON.stringify(bodies[0]) === JSON.stringify(bodies[1]) && JSON.stringify(bodies[1]) === JSON.stringify(bodies[2]), bodies);
    const expectedBody = { code: 'SHEET_NOT_FOUND', message: '巡检单不存在或无权查看' };
    check('L9:响应体与手写的最小期望对象完全相等', bodies.every((b) => JSON.stringify(b) === JSON.stringify(expectedBody)), { bodies, expectedBody });
    check('L9:统一收敛成404 SHEET_NOT_FOUND(显式断言保留)', respBadItem.status === 404 && respBadItem.body.code === 'SHEET_NOT_FOUND', respBadItem.body);
    check('L9:响应体不含检查项细节(不支持采集/检查项不存在/资产不合格等具体文案)', !/该检查项不支持采集|检查项不存在|设备已不满足采集条件|设备当前不满足采集条件/.test(JSON.stringify(bodies)), bodies);
    check('L9:假采集器调用次数精确为0(三次请求全部未触发远程采集)', collectorCalls === 0, { collectorCalls });
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_L9_NONE_CONSISTENCY PASS=${pass}`);
}

// ============================================================
// G1A 任务4：第一阶段（G1A-b 拆分后为 checkSheetAndItem + assertCollectableAsset，两个withWrite里
// 的第一个）现在判齐单据全部条件、判定失败就绝不发起远程采集——不再有旧的"collectPhase1Check 只判
// 检查项与资产、单据状态/归属/可见性留到第二阶段才判"这种残留（那种写法会对无权限/非draft的单先
// 白跑一次真实采集才拒绝，是 P5、37S H1 的病根，G1 用户裁定必须改掉）。逐场景断言三件套：状态码+响应体逐字段等于
// 手写期望（不只挑{status,code}子集）、假采集器调用次数精确为0、it_device_inspections 表行数
// 调用前后不变——证明"没通过第一阶段就真的一次远程采集都没发起"，不是只看最终响应码对不对。
// ============================================================
async function testFirstStageRejectionsNoCollection() {
  const fc = makeFakeCollector();
  const f = await createFixture({ inspectionCollector: fc.collector, enableTestHooks: true, sqlProbe: 'collect' });
  try {
    let collectorCalls = 0;
    const originalCollect = fc.collector.collect;
    // 持久 monkey-patch（不用一次性的 setOnEnter）：本函数逐场景累计计数，每个场景开始前清零。
    fc.collector.collect = async (...args) => { collectorCalls += 1; return originalCollect.apply(fc.collector, args); };
    async function countDeviceInspections() {
      const exists = await f.all("SELECT name FROM sqlite_master WHERE type='table' AND name='it_device_inspections'");
      if (!exists.length) return 0;
      return (await f.all('SELECT COUNT(*) n FROM it_device_inspections'))[0].n;
    }
    async function assertRejected(label, doRequest, expectedStatus, expectedBody) {
      collectorCalls = 0;
      const before = await countDeviceInspections();
      const resp = await doRequest();
      check(`${label}:状态码${expectedStatus}`, resp.status === expectedStatus, resp.body);
      check(`${label}:响应体逐字段等于手写期望`, JSON.stringify(resp.body) === JSON.stringify(expectedBody), { got: resp.body, expected: expectedBody });
      check(`${label}:假采集器调用次数精确为0`, collectorCalls === 0, { collectorCalls });
      const after = await countDeviceInspections();
      check(`${label}:it_device_inspections行数不变`, after === before, { before, after });
      return resp;
    }

    // 场景1：写权限被收回——ACL 行删空，requireLedgerWrite 中间件在路由体之前就拒绝，路由体（含
    // checkCollectable）根本不会执行，message 是中间件自己的文案（与 q.assertWrite 内部判定的
    // message 不同一句，两者都是 LEDGER_FORBIDDEN 但文案不同，这里钉的是中间件这一层）。
    const w1 = await buildDraftSheetWithDevice(f, 'G1A-S1-NoAcl', 2);
    const detail1 = await getSheetAs(f, w1.sheet.id, 2);
    const item1 = deviceItemOf(detail1.body, w1.device.id);
    await f.run('DELETE FROM it_asset_acl WHERE user_id=2');
    await assertRejected('场景1写权限被收回', () => collectOnSheet(f, w1.sheet.id, item1.id, 2), 403, { code: 'LEDGER_FORBIDDEN', message: '权限不足' });
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (2,'write',1)"); // 恢复，后续场景仍需要uid=2建单

    // 场景2a：单据不存在——一个从未存在过的sheetId，uid=1管理员排除权限干扰，只看单据本身。G1A-b
    // L8：标签去掉"(none)"后缀——这条命中的是checkSheetAndItem里`!sheet`这一半短路条件（sheet查
    // 询本身查不到行），sheetVisibility()根本不会被调用，不是visibility==='none'那一支。真正的
    // "sheetVisibility===='none'"分支（单据存在+已删除+调用者非管理员）已有等价用例覆盖，见
    // testM1VisibilityGatesPhase1Error 的"例2"（本文件:1286-1307，`M1例2:...`那几条check），未
    // 重复新增。
    await assertRejected('场景2a单据不存在', () => collectOnSheet(f, 999999, 1, 1), 404, { code: 'SHEET_NOT_FOUND', message: '巡检单不存在或无权查看' });

    // 场景2b：已逻辑删除——用管理员查看（sheetVisibility 对admin恒'full'，不会走 visibility==='none'
    // 那一支），专门踩在"if (sheet.deleted_at) throw notFound()"这条独立判据上，与2a是两条不同代码
    // 路径，不是同一个check的重复。
    const w2 = await buildDraftSheetWithDevice(f, 'G1A-S2b-Deleted', 2);
    const detail2 = await getSheetAs(f, w2.sheet.id, 2);
    const item2 = deviceItemOf(detail2.body, w2.device.id);
    const put2 = await f.api('PUT', '/inspections/sheets/' + w2.sheet.id, { expected_version: w2.sheet.version, items: fillPayloadAllOk(detail2.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('场景2b准备:PUT补全200', put2.status === 200, put2.body);
    await uploadAllRackFrontPhotos(f, w2.sheet.id, w2.sheet.scope, 2);
    const submit2 = await f.api('POST', '/inspections/sheets/' + w2.sheet.id + '/submit', { expected_version: put2.body.version }, 2);
    check('场景2b准备:提交200', submit2.status === 200, submit2.body);
    const del2 = await f.api('DELETE', '/inspections/sheets/' + w2.sheet.id, { expected_version: submit2.body.version, reason: 'G1A场景2b测试删除' }, 1);
    check('场景2b准备:管理员逻辑删除200', del2.status === 200, del2.body);
    await assertRejected('场景2b已逻辑删除(管理员查看,踩独立deleted_at判据)', () => collectOnSheet(f, w2.sheet.id, item2.id, 1), 404, { code: 'SHEET_NOT_FOUND', message: '巡检单不存在或无权查看' });

    // 场景3：summary可见的他人草稿——uid=5写权限但非owner非admin，isManager先给403，不泄露检查项
    // 分段或资产合格与否（本场景设备本身合格，若第一阶段真的白跑一次采集，collectorCalls会>0，
    // 三件套里的"假采集器调用次数为0"能精确抓出这类残留）。
    const w3 = await buildDraftSheetWithDevice(f, 'G1A-S3-OthersDraft', 2);
    const detail3 = await getSheetAs(f, w3.sheet.id, 2);
    const item3 = deviceItemOf(detail3.body, w3.device.id);
    await f.run("INSERT INTO it_asset_acl (user_id,level,granted_by) VALUES (5,'write',1)");
    await assertRejected('场景3summary可见的他人草稿', () => collectOnSheet(f, w3.sheet.id, item3.id, 5), 403, { code: 'SHEET_FORBIDDEN', message: '只有巡检人或管理员可以采集' });

    // 场景4：已提交单——正常补全并提交后再打collect端点。
    const w4 = await buildDraftSheetWithDevice(f, 'G1A-S4-Submitted', 2);
    const detail4 = await getSheetAs(f, w4.sheet.id, 2);
    const item4 = deviceItemOf(detail4.body, w4.device.id);
    const put4 = await f.api('PUT', '/inspections/sheets/' + w4.sheet.id, { expected_version: w4.sheet.version, items: fillPayloadAllOk(detail4.body.items, NUMBER_DEFAULT), remark: null }, 2);
    check('场景4准备:PUT补全200', put4.status === 200, put4.body);
    await uploadAllRackFrontPhotos(f, w4.sheet.id, w4.sheet.scope, 2);
    const submit4 = await f.api('POST', '/inspections/sheets/' + w4.sheet.id + '/submit', { expected_version: put4.body.version }, 2);
    check('场景4准备:提交200', submit4.status === 200, submit4.body);
    await assertRejected('场景4已提交单', () => collectOnSheet(f, w4.sheet.id, item4.id, 2), 409, { code: 'SHEET_STATE', message: '当前状态不允许采集' });

    // 场景5：该行不属于本单device段——room段的检查项id去打collect端点（同一张单、同一个调用者，
    // 只有"段"不对，证明是"AND section='device'"这一条判据在起作用，不是可见性/归属/状态问题）。
    const w5 = await buildDraftSheetWithDevice(f, 'G1A-S5-NotDevice', 2);
    const detail5 = await getSheetAs(f, w5.sheet.id, 2);
    const roomItem5 = detail5.body.items.find((it) => it.section === 'room');
    await assertRejected('场景5该行不属于本单device段', () => collectOnSheet(f, w5.sheet.id, roomItem5.id, 2), 404, { code: 'SHEET_ITEM_NOT_FOUND', message: '检查项不存在' });

    // 场景6：资产不可采集——一切都合规（草稿、owner、device段行），唯独资产本身不合格(retired)，
    // 从"第一次尝试"就该拒绝(不是race-window测试里"采集期间才变得不合格"那种场景，那类已在
    // testRaceWindowReverify覆盖)。G1A-b L5：第一阶段(assertCollectableAsset)的message改为带上
    // 原始原因（"设备当前不满足采集条件："+target()自己的message），不是笼统的"请重新采集"——那句
    // "请重新采集"只属于第二阶段(reverifyTarget映射)的语境，第一阶段这是第一次尝试，不存在"重新"。
    const w6 = await buildDraftSheetWithDevice(f, 'G1A-S6-Ineligible', 2);
    const detail6 = await getSheetAs(f, w6.sheet.id, 2);
    const item6 = deviceItemOf(detail6.body, w6.device.id);
    await f.run("UPDATE it_assets SET status='retired' WHERE id=?", [w6.device.id]);
    await assertRejected('场景6资产不可采集', () => collectOnSheet(f, w6.sheet.id, item6.id, 2), 409, { code: 'SHEET_STATE', message: '设备当前不满足采集条件：该设备未配置可用的服务器采集连接' });
  } finally {
    fc.release();
    await f.close();
  }
      {
      const v = f.probeViolations();
      check('G2A2探针: 写请求锁外SQL违规数精确为0', v.length === 0, v.slice(0, 10));
      check('G2A2探针: 本子套件内writeRequest且inWriteTxn记录数>0(接通,非空跑)', f.probeInTxnCount() > 0, { inTxnCount: f.probeInTxnCount(), total: f.probeRecordCount() });
    }
    console.log(`INSPECTION_COLLECT_FIRST_STAGE_REJECTIONS PASS=${pass}`);
}

// ============================================================
// M1（G2A2b 必修）：sqlProbe:'collect' 在 enableTestHooks!==true 时必须直接抛错（不静默返回空）。
// 不建真实fixture(不需要，构造参数校验发生在网络/DB操作之前)。
// ============================================================
async function testSqlProbeCollectGuardThrowsWithoutTestHooks() {
  let threw = null;
  try {
    await createFixture({ sqlProbe: 'collect' }); // 故意不传 enableTestHooks
  } catch (e) {
    threw = e;
  }
  check('M1: sqlProbe:\'collect\' 缺enableTestHooks时createFixture直接抛错(不静默返回空)', threw !== null && /enableTestHooks/.test(threw.message), threw && threw.message);
  console.log(`INSPECTION_COLLECT_M1_GUARD PASS=${pass}`);
}

// ============================================================
// C7（方案v0.6 §7）：G3A/G3A-b/G3A-c 这套"设备巡检证据上传路由成功路径探针"
// （testEvidenceUploadStandaloneProbeZeroViolation，原10条check()）随 POST /:kind/:recordId/
// evidence 路由整体删除一并移除，不是精简，是这条写路径已经不存在——inspections.js 退役后只剩
// GET /、GET /:id(\d+) 两条只读路由，从不调用 withWrite，没有"写事务锁外SQL""预检/落库两段事务
// txnSeq"这类性质可探。这些探针原本验证的"两段独立写事务、较早段只读、较晚段真落库"性质，现在改由
// 巡检单采集（inspection-sheets.js 的 POST /sheets/:id/items/:itemId/collect）单独承担，该路径的
// 同类探针见本文件"2) 锁外窗口复核"（testRaceWindowReverify）与各正向/负向用例末尾的
// G2A2探针断言，覆盖未失去。
// ============================================================

async function main() {
  await testSqlProbeCollectGuardThrowsWithoutTestHooks();
  await testSingleFlightShared();
  await testRaceWindowReverify();
  await testPositiveCollectAndReplace();
  await testNegativeValidation();
  await testDeviceRuleFeedsCompleteness();
  await testM7WhitespaceNoteRejected();
  await testStandaloneGatedBySheetId();
  await testInspectionVisibilityOnSheetLinkedRecords();
  await testSheetRefAttribution();
  await testOldTableCompat();
  await testOldTableAlterAddsCheckConstraint();
  await testReferencesInspectionSheets();
  await testDraftDeleteDetaches();
  await testTwoColumnCheckConstraint();
  await testM1VisibilityGatesPhase1Error();
  await testM1PhaseErrorRethrowNotReclassified();
  await testFakeCollectorIdentityMismatchAndThrowModes();
  await testM1SameInvisibleSheetErrorsIdentical();
  await testL9NoneSheetInputsIdentical();
  await testFirstStageRejectionsNoCollection();
  console.log(`INSPECTION_COLLECT PASS=${pass} FAIL=0`);
}
main().catch((e) => { console.error(e.stack); console.log(`INSPECTION_COLLECT PASS=${pass} FAIL=1`); process.exitCode = 1; });
