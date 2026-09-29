'use strict';
// routes/it-ledger/inspection-sheets.js — 巡检台账数据层与接口（长任务 E · C1+C2）
//   方案 SSOT = docs/local/信息化资产_轻量版/巡检台账改版_方案_20260923_v0.4.md §2/§3/§4/§5
//   执行派单 = E:/tmp/insp-sheet-review/c1/spec-C1.md（C1）、E:/tmp/insp-sheet-review/c2/spec-C2.md（C2）
//
// C1 范围：五表懒建、模板 v1、建单/保存(仅草稿)/提交/逻辑删除/恢复/归档/撤回、权限与可见性、
//   操作记录（create/submit/archive/unarchive/delete/restore）。
// C2 范围（本次新增）：照片三状态（上传/替换/移除/待生效/丢弃/下载）、重复提示与可见性例外、
//   清理队列与重试、未入库文件清理、就绪目录对账（由 index.js 调用 inspection-photo-files.js 的
//   reconcilePhotoDirectoryOnce）、草稿物理删除补照片清理、已提交单「保存修改」§5.3 七步、归档与
//   逻辑删除丢弃 pending 并在响应里给 discarded_pending。不含：it_device_inspections 改列与兼容、
//   一键采集、设备判断规则、任何前端（C3/C4/C5）。
//
// 工厂函数形态与 ./inspections.js 一致：入参从 index.js 注入 withRead/withWrite/
//   requireLedgerWrite/handleErr/recordManagement/storageDir，导出
//   {router, sheetActions, sheetVisibility, sheetProgress, processCleanupQueue}。
//
// C2b（方案 §7.2 明文要求的自动化覆盖，测试专用注入点）：testHooks 只应由 index.js 从
//   deps.inspectionSheetTestHooks 取（生产装配 server.js 从不传这个 dep，值恒为 undefined）；
//   夹具 it-ledger-browser-fixture.js 加同名可选项透传。当前认 testHooks.removeStoredFile
//   （覆盖"未入库文件立即删除"这一步的实现）与 C2d T-H2 新增的 testHooks.queueUnlink（覆盖
//   processCleanupQueue 里真正的 unlink 调用），用于制造"unlink 本身也失败"这个纯文件系统层面在
//   Windows 上难以可靠触发的场景——不影响生产路径的真实删除逻辑（testHooks 为 undefined 时两个
//   钩子都落回真实实现）。
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const photoFiles = require('./inspection-photo-files');

// G2A2 Commit2（主会话裁定）→ G3A（41T H2 收窄）：runCleanupDetached(limit) 由 index.js 注入——
//   仅测试模式让固定的清理函数（index.js 内绑定的 processCleanupQueue 引用）显式退出当前写请求的
//   ALS 上下文（ledgerRequestContext.exit），生产路径原样同步调用。只接受一个数字型 limit，不
//   接受任何回调——即使路由处理器借 Reflect.get(arguments[0], 'runCleanupDetached') 反射拿到它，
//   调用它也只会触发这一个固定动作，包不住路由自己的代码（见 index.js 该函数定义处注释）。只在
//   processCleanupQueueBestEffort() 里用（见该函数），静态守卫 R8 约束它不得出现在任何路由处理器
//   内或本文件其它位置。
module.exports = function createInspectionSheets({ withRead, withWrite, requireLedgerWrite, handleErr, recordManagement, storageDir, testHooks, collect, stripFinance, runCleanupDetached }) {
  const router = express.Router();
  const error = (status, code, message, detail) => Object.assign(new Error(message), { status, code, ...(detail !== undefined ? { detail } : {}) });
  const bad = (message) => error(400, 'LEDGER_BAD_REQUEST', message);
  const notFound = (message = '巡检单不存在或无权查看') => error(404, 'SHEET_NOT_FOUND', message);
  const versionConflict = (message = '资料已变化，请重新打开核对') => error(409, 'SHEET_VERSION_CONFLICT', message);
  const forbidden = (message = '无权对该单执行此操作') => error(403, 'SHEET_FORBIDDEN', message);
  const photoNotFound = (message = '照片不存在') => error(404, 'SHEET_PHOTO_NOT_FOUND', message);
  const id = (v) => { const n = Number(v); if (!Number.isSafeInteger(n) || n < 1) throw bad('记录编号无效'); return n; };
  const input = (body, keys) => { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((k) => !keys.includes(k))) throw bad('请求包含未声明字段'); return body; };
  async function canRead(q, user) { if (user.role === 'admin') return; const row = await q.get('SELECT level FROM it_asset_acl WHERE user_id=?', [user.id]); if (!row) throw error(403, 'LEDGER_FORBIDDEN', '访问权限已变化'); }
  async function currentLevel(q, user) { if (user.role === 'admin') return 'admin'; const row = await q.get('SELECT level FROM it_asset_acl WHERE user_id=?', [user.id]); return row ? row.level : null; }
  function isManager(user, sheet) { return user.role === 'admin' || sheet.created_by === user.id; }

  // ============================================================
  // 一、懒建 DDL（方案 §2.1–§2.4、§2.6，逐字落地）；只在首个授权写事务内建
  // ============================================================
  async function exists(q) { return !!(await q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='it_inspection_sheets'")); }
  const PHOTO_LIMIT = 10;
  async function photoRemovalsExist(q) { return !!(await q.get("SELECT name FROM sqlite_master WHERE type='table' AND name='it_inspection_photo_removals'")); }
  async function ensurePhotoCollections(q) {
    // Previous schema enforced one active and one pending photo per position. Rows/files remain intact.
    await q.run('DROP INDEX IF EXISTS uq_it_inspection_sheet_photos_active');
    await q.run('DROP INDEX IF EXISTS uq_it_inspection_sheet_photos_pending');
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_photos_position ON it_inspection_sheet_photos(sheet_id,slot,target_id,state,pending_by)');
    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_photo_removals (
      sheet_id INTEGER NOT NULL, photo_id INTEGER NOT NULL, pending_by INTEGER NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(photo_id,pending_by)
    )`);
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_photo_removals_sheet ON it_inspection_photo_removals(sheet_id,pending_by)');
  }
  async function pendingPhotoRemovals(q, sheetId, userId) {
    if (!(await photoRemovalsExist(q))) return [];
    return q.all("SELECT r.photo_id FROM it_inspection_photo_removals r JOIN it_inspection_sheet_photos p ON p.id=r.photo_id AND p.sheet_id=r.sheet_id WHERE r.sheet_id=? AND r.pending_by=? AND p.state='active' ORDER BY r.photo_id", [sheetId,userId]);
  }
  async function effectivePhotoCount(q, sheetId, slot, targetId, userId) {
    const count = await q.get("SELECT COUNT(*) n FROM it_inspection_sheet_photos p WHERE p.sheet_id=? AND p.slot=? AND p.target_id=? AND ((p.state='active' AND NOT EXISTS (SELECT 1 FROM it_inspection_photo_removals r WHERE r.photo_id=p.id AND r.pending_by=?)) OR (p.state='pending' AND p.pending_by=?))", [sheetId,slot,targetId,userId,userId]);
    return count.n;
  }
  async function clearPhotoRemovals(q, sheetId, userId) {
    if (!(await photoRemovalsExist(q))) return 0;
    const result = await q.run('DELETE FROM it_inspection_photo_removals WHERE sheet_id=?' + (userId === undefined ? '' : ' AND pending_by=?'), userId === undefined ? [sheetId] : [sheetId,userId]);
    return result.changes;
  }
  async function ensureTables(q) {
    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_sheets (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      room_name        TEXT NOT NULL,
      scope_json       TEXT NOT NULL,
      template_version TEXT NOT NULL,
      status           TEXT NOT NULL CHECK(status IN ('draft','submitted','archived')),
      remark           TEXT CHECK(remark IS NULL OR length(remark)<=2000),
      created_by       INTEGER NOT NULL,
      created_at       TEXT NOT NULL,
      submitted_by     INTEGER,
      submitted_at     TEXT,
      archived_by      INTEGER,
      archived_at      TEXT,
      deleted_by       INTEGER,
      deleted_at       TEXT,
      delete_reason    TEXT,
      version          INTEGER NOT NULL DEFAULT 1,
      updated_at       TEXT NOT NULL,
      CHECK (
        (status = 'draft'
           AND submitted_by IS NULL AND submitted_at IS NULL
           AND archived_by IS NULL AND archived_at IS NULL
           AND deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
        OR (status = 'submitted'
           AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
           AND archived_by IS NULL AND archived_at IS NULL
           AND ((deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
             OR (deleted_by IS NOT NULL AND deleted_at IS NOT NULL
                 AND delete_reason IS NOT NULL AND length(trim(delete_reason)) > 0)))
        OR (status = 'archived'
           AND submitted_by IS NOT NULL AND submitted_at IS NOT NULL
           AND archived_by IS NOT NULL AND archived_at IS NOT NULL
           AND deleted_by IS NULL AND deleted_at IS NULL AND delete_reason IS NULL)
      )
    )`);
    await q.run("CREATE UNIQUE INDEX IF NOT EXISTS uq_it_inspection_sheets_draft_room ON it_inspection_sheets(room_name) WHERE status='draft'");

    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_sheet_items (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id              INTEGER NOT NULL,
      section               TEXT NOT NULL CHECK(section IN ('room','rack','device')),
      target_id             INTEGER NOT NULL,
      target_label          TEXT NOT NULL,
      item_key              TEXT NOT NULL,
      item_label            TEXT NOT NULL,
      value_kind            TEXT NOT NULL CHECK(value_kind IN ('check','number')),
      result                TEXT CHECK(result IS NULL OR result IN ('ok','bad')),
      number_value          REAL,
      note                  TEXT CHECK(note IS NULL OR length(note)<=500),
      device_inspection_id  INTEGER,
      manual_observation_json TEXT,
      CHECK ((value_kind='number' AND result IS NULL AND note IS NULL AND device_inspection_id IS NULL) OR (value_kind='check' AND number_value IS NULL)),
      CHECK (device_inspection_id IS NULL OR section='device'),
      CHECK (number_value IS NULL OR typeof(number_value) IN ('real','integer'))
    )`);
    await q.run('CREATE UNIQUE INDEX IF NOT EXISTS uq_it_inspection_sheet_items ON it_inspection_sheet_items(sheet_id, section, target_id, item_key)');
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_sheet_items_target ON it_inspection_sheet_items(section, target_id)');
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_sheet_items_device ON it_inspection_sheet_items(device_inspection_id)');

    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_sheet_photos (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id       INTEGER NOT NULL,
      slot           TEXT NOT NULL CHECK(slot IN ('rack_front','item')),
      target_id      INTEGER NOT NULL,
      original_name  TEXT NOT NULL,
      stored_name    TEXT NOT NULL UNIQUE,
      mime           TEXT NOT NULL,
      size           INTEGER NOT NULL,
      sha256         TEXT NOT NULL,
      created_by     INTEGER NOT NULL,
      created_at     TEXT NOT NULL,
      state          TEXT NOT NULL CHECK(state IN ('active','pending','superseded')),
      pending_by     INTEGER,
      superseded_by  INTEGER,
      superseded_at  TEXT,
      CHECK ((state='pending' AND pending_by IS NOT NULL) OR (state<>'pending' AND pending_by IS NULL)),
      CHECK ((state='superseded' AND superseded_by IS NOT NULL AND superseded_at IS NOT NULL) OR (state<>'superseded' AND superseded_by IS NULL AND superseded_at IS NULL)),
      CHECK (length(stored_name)=40 AND substr(stored_name,37)='.bin' AND NOT substr(stored_name,1,36) GLOB '*[^0-9a-f-]*')
    )`);
    await ensurePhotoCollections(q);
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_sheet_photos_sheet ON it_inspection_sheet_photos(sheet_id, state)');
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_sheet_photos_sha ON it_inspection_sheet_photos(sha256)');

    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_sheet_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      sheet_id   INTEGER NOT NULL,
      actor_id   INTEGER NOT NULL,
      at         TEXT NOT NULL,
      op_id      TEXT NOT NULL,
      action     TEXT NOT NULL CHECK(action IN ('create','submit','edit','archive','unarchive','delete','restore')),
      reason     TEXT,
      diff_json  TEXT,
      CHECK (
        ((action IN ('unarchive','delete') AND reason IS NOT NULL AND length(trim(reason)) > 0)
          OR (action NOT IN ('unarchive','delete') AND reason IS NULL))
        AND ((action = 'edit' AND diff_json IS NOT NULL) OR (action <> 'edit' AND diff_json IS NULL))
      )
    )`);
    await q.run('CREATE INDEX IF NOT EXISTS idx_it_inspection_sheet_log_sheet ON it_inspection_sheet_log(sheet_id, id)');

    await q.run(`CREATE TABLE IF NOT EXISTS it_inspection_file_cleanup (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      stored_name  TEXT NOT NULL UNIQUE,
      dir_key      TEXT NOT NULL CHECK(dir_key IN ('sheet_photos')),
      reason       TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      CHECK (length(stored_name)=40 AND substr(stored_name,37)='.bin' AND NOT substr(stored_name,1,36) GLOB '*[^0-9a-f-]*')
    )`);
  }

  // ============================================================
  // 二、检查项模板 v1（方案 §3）
  // ============================================================
  const TEMPLATE_VERSION = 'v1';
  const ROOM_ITEMS = [
    { key: 'temperature', label: '温度（℃，参考 18–27）', kind: 'number', min: -20, max: 60 },
    { key: 'humidity', label: '湿度（%，参考 40–60）', kind: 'number', min: 0, max: 100 },
    { key: 'aircon', label: '空调运行', kind: 'check' },
    { key: 'ups', label: 'UPS 与供电', kind: 'check' },
    { key: 'fire', label: '消防设施', kind: 'check' },
    { key: 'access', label: '门禁与门锁', kind: 'check' },
    { key: 'water', label: '漏水与地面', kind: 'check' },
    { key: 'cleanliness', label: '卫生与杂物', kind: 'check' },
  ];
  const RACK_ITEMS = [
    { key: 'door', label: '柜门锁闭', kind: 'check' },
    { key: 'lights', label: '运行指示灯', kind: 'check' },
    { key: 'cabling', label: '线缆与标签', kind: 'check' },
    { key: 'pdu', label: 'PDU 与电源', kind: 'check' },
  ];
  const DEVICE_ITEMS = [{ key: 'front_panel', label: '前面板与告警灯', kind: 'check' }];
  const NUMBER_RANGE_BY_KEY = Object.fromEntries(ROOM_ITEMS.filter((x) => x.kind === 'number').map((x) => [x.key, [x.min, x.max]]));
  // Additive, transactional migration. Existing read-only requests can still read pre-migration rows.
  async function ensureManualObservationColumn(q) {
    const columns = await q.all('PRAGMA table_info(it_inspection_sheet_items)');
    if (!columns.some(c => c.name === 'manual_observation_json')) await q.run('ALTER TABLE it_inspection_sheet_items ADD COLUMN manual_observation_json TEXT');
  }
  function manualObservation(it) { return it.manual_observation ?? (it.manual_observation_json ? JSON.parse(it.manual_observation_json) : null); }
  function manualObservationIncomplete(it) {
    const m = manualObservation(it);
    return !!(m && ['cpu_percent', 'memory_percent', 'disk_percent'].some(k => m[k] !== null && m[k] !== undefined) && (!m.source || !m.observed_at));
  }
  function validateManualObservation(value) {
    if (value === null) return null;
    const keys = ['observation', 'cpu_percent', 'memory_percent', 'disk_percent', 'disk_label', 'source', 'observed_at'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw bad('人工观察记录字段无效');
    const out = {};
    for (const k of keys) out[k] = value[k] ?? null;
    for (const [k, limit] of [['observation', 500], ['disk_label', 100]]) {
      if (out[k] !== null && (typeof out[k] !== 'string' || out[k].length > limit)) throw bad(k === 'observation' ? '观察记录最多500字' : '磁盘/卷名称最多100字');
      if (out[k] !== null && !out[k].trim()) out[k] = null;
    }
    for (const k of ['cpu_percent', 'memory_percent', 'disk_percent']) if (out[k] !== null && (typeof out[k] !== 'number' || !Number.isFinite(out[k]) || out[k] < 0 || out[k] > 100)) throw bad('人工运行指标须为0–100之间的数值');
    if (out.source !== null && !['management', 'monitor', 'instrument', 'other'].includes(out.source)) throw bad('人工读数来源无效');
    if (out.observed_at !== null) {
      if (typeof out.observed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(out.observed_at) || !Number.isFinite(Date.parse(out.observed_at)) || new Date(out.observed_at).toISOString() !== out.observed_at) throw bad('人工观察时间须为有效的ISO时间');
    }
    return keys.every(k => out[k] === null) ? null : out;
  }
  async function writeItemPatch(q, it, sheetId) {
    if (Object.hasOwn(it, 'manual_observation')) await q.run('UPDATE it_inspection_sheet_items SET result=?,number_value=?,note=?,manual_observation_json=? WHERE id=? AND sheet_id=?', [it.result, it.number_value, it.note, it.manual_observation ? JSON.stringify(it.manual_observation) : null, it.id, sheetId]);
    else await q.run('UPDATE it_inspection_sheet_items SET result=?,number_value=?,note=? WHERE id=? AND sheet_id=?', [it.result, it.number_value, it.note, it.id, sheetId]);
  }

  async function buildScope(q, roomName) {
    const racks = await q.all('SELECT id,name,u_total FROM it_racks WHERE room=? ORDER BY id', [roomName]);
    if (!racks.length) throw bad('该机房没有机柜，无法建单');
    const rackIds = racks.map((r) => r.id);
    const clause = await recordManagement.activeClause(q);
    const devices = await q.all(
      `SELECT id,name,category,rack_id,u_start,u_height FROM it_assets WHERE rack_id IN (${rackIds.map(() => '?').join(',')}) AND status='in_service' AND ${clause} ORDER BY rack_id,u_start`,
      rackIds
    );
    return {
      racks: racks.map((r) => ({ id: r.id, name: r.name, u_total: r.u_total })),
      devices: devices.map((d) => ({ id: d.id, name: d.name, category: d.category, rack_id: d.rack_id, u_start: d.u_start, u_height: d.u_height })),
    };
  }
  function buildItemRows(scope) {
    const rows = [];
    for (const it of ROOM_ITEMS) rows.push({ section: 'room', target_id: 0, target_label: '机房环境', item_key: it.key, item_label: it.label, value_kind: it.kind });
    for (const rack of scope.racks) for (const it of RACK_ITEMS) rows.push({ section: 'rack', target_id: rack.id, target_label: rack.name, item_key: it.key, item_label: it.label, value_kind: it.kind });
    for (const dev of scope.devices) for (const it of DEVICE_ITEMS) rows.push({ section: 'device', target_id: dev.id, target_label: dev.name, item_key: it.key, item_label: it.label, value_kind: it.kind });
    return rows;
  }

  // ============================================================
  // 三、完整性、权限、可见性——三个纯函数（方案 §3.1/§4.1/§4.2）
  // ============================================================
  // C2：sheetProgress 签名改为 (sheet, items, photos)（codex 35S 建议），应传/已传按单据冻结的
  //   范围快照（scope_json）计算——sheet 可传原始行（scope_json 为字符串）或已 sheetView() 过的
  //   对象（scope 为对象），两种形态都兼容。调用方全部改点：listRow/loadDetail/submit 路由/保存
  //   修改七步第6步。
  // C2c L6：photos 现在要求每一行都显式带 state 字段——不再把"没选 state 列"悄悄当成"就是
  //   active"。之前的宽松写法（state===undefined 也算 active）让调用方可以靠 SQL 里的
  //   `WHERE state='active'` 预过滤、自己不选 state 列也能蒙混过关；这次全扫调用方把 state 加进
  //   SELECT 列表，sheetProgress 自己做唯一的过滤判据（不再依赖调用方的预过滤）。缺 state 直接
  //   抛错——这是故意的：比起"缺列时默默算错 photosUploaded"，宁可在开发/测试阶段就炸出来。
  // C3（方案 §3.1 最后一条）：新增第4个参数 collections——device 行若关联了采集记录（
  //   item.device_inspection_id 非空），完整性还要满足设备判断规则（inspection-collect.js 的
  //   deviceJudgementError；该判断规则原与服务器单独判断 POST /inspections/:id/review 共用同一份
  //   实现，C7 单独设备巡检整体退役后那条路由已删，目前只有本文件在调用）。本函数
  //   仍是纯函数、不查库（C2c L6 photos.state 同一先例）——collections 由调用方查好传入，形态是
  //   Map<itemId, {collectionStatus, alertsCount, cleanupWarningsCount}>，只需要覆盖"当前 items 里
  //   带 device_inspection_id 的那些行"，四处调用方（listRow/loadDetail/submit/
  //   saveSubmittedEdit）都要传，用下面同一个 loadDeviceCollections() 助手查。
  function sheetProgress(sheet, items, photos, collections) {
    // L6：number 项「已填」须落在模板范围内——与写路径（validateItemAgainstTarget）同一常量
    // NUMBER_RANGE_BY_KEY，不是随便一个有限数就算填了。
    const isFilled = (it) => {
      if (it.value_kind === 'check') return it.result === 'ok' || it.result === 'bad';
      if (!Number.isFinite(it.number_value)) return false;
      const range = NUMBER_RANGE_BY_KEY[it.item_key];
      return !range || (it.number_value >= range[0] && it.number_value <= range[1]);
    };
    const unfilledIds = items.filter((it) => !isFilled(it)).map((it) => it.id);
    const badItems = items.filter((it) => it.result === 'bad');
    const missingNoteIds = badItems.filter((it) => !it.note || !it.note.trim()).map((it) => it.id);

    const scope = sheet && typeof sheet.scope_json === 'string' ? JSON.parse(sheet.scope_json) : (sheet && sheet.scope) || { racks: [] };
    const expectedRackIds = (scope.racks || []).map((r) => r.id);
    const expectedItemIds = badItems.map((it) => it.id);
    const activePhotos = (photos || []).filter((p) => {
      if (p.state === undefined) throw new Error('sheetProgress: photo 缺少 state 字段——调用方必须显式 SELECT state，不能再靠 SQL 预过滤兜底（C2c L6）');
      return p.state === 'active';
    });
    const uploadedKeys = new Set(activePhotos.map((p) => p.slot + ':' + p.target_id));
    const missingPhotoPositions = [];
    let photosUploaded = 0;
    for (const rid of expectedRackIds) { if (uploadedKeys.has('rack_front:' + rid)) photosUploaded++; else missingPhotoPositions.push({ slot: 'rack_front', target_id: rid }); }
    for (const iid of expectedItemIds) { if (uploadedKeys.has('item:' + iid)) photosUploaded++; else missingPhotoPositions.push({ slot: 'item', target_id: iid }); }
    const photosExpected = expectedRackIds.length + expectedItemIds.length;

    // C3：device 行关联采集记录时的完整性缺口——尚未判断（result 为 null）的行已经被 unfilledIds
    // 捕获，这里只处理"已判断但违反设备判断规则"的情况（采集failed却判正常、或partial/告警/清理
    // 警告却判正常无说明）。collections 里没有对应条目直接炸出来（同 L6 photos 的 state 字段先
    // 例）——宁可开发/测试阶段就发现调用方漏传，不要默默放行。
    const deviceIssueItemIds = [];
    const manualObservationItemIds = items.filter(manualObservationIncomplete).map(it => it.id);
    for (const it of items) {
      if (!it.device_inspection_id) continue;
      const collection = (collections || new Map()).get(it.id);
      if (!collection) throw new Error('sheetProgress: item#' + it.id + ' 关联了采集记录(device_inspection_id)但调用方未在 collections 里传入对应条目（C3）');
      if (it.result !== 'ok' && it.result !== 'bad') continue;
      const judgement = it.result === 'bad' ? 'attention' : 'normal';
      if (collect.deviceJudgementError(collection, judgement, it.note) && !deviceIssueItemIds.includes(it.id)) deviceIssueItemIds.push(it.id);
    }

    return {
      filled: items.length - unfilledIds.length,
      total: items.length,
      abnormal: badItems.length,
      photosExpected,
      photosUploaded,
      complete: unfilledIds.length === 0 && missingNoteIds.length === 0 && missingPhotoPositions.length === 0 && deviceIssueItemIds.length === 0 && manualObservationItemIds.length === 0,
      missing: { unfilledItemIds: unfilledIds, missingNoteItemIds: missingNoteIds, missingPhotoPositions, deviceIssueItemIds, ...(manualObservationItemIds.length ? { manualObservationItemIds } : {}) },
    };
  }
  // C3：sheetProgress 的 collections 参数统一由这个助手查——四处调用方（listRow/loadDetail/submit/
  //   saveSubmittedEdit）共用，不各写一份 JOIN。items 里没有 device_inspection_id 的行不查、不占
  //   IN(...)参数；it_device_inspections 表不存在时（本库从未采集过）直接返回空 Map。
  async function loadDeviceCollections(q, items) {
    const inspectionIds = [...new Set(items.filter((it) => it.device_inspection_id).map((it) => it.device_inspection_id))];
    if (!inspectionIds.length || !(await collect.exists(q))) return new Map();
    const rows = await q.all(`SELECT id,collection_status,snapshot_json FROM it_device_inspections WHERE id IN (${inspectionIds.map(() => '?').join(',')})`, inspectionIds);
    const byInspectionId = new Map();
    for (const row of rows) {
      let alertsCount = 0, cleanupWarningsCount = 0;
      try {
        const s = JSON.parse(row.snapshot_json);
        alertsCount = Array.isArray(s.alerts) ? s.alerts.length : 0;
        cleanupWarningsCount = Array.isArray(s.cleanup_warnings) ? s.cleanup_warnings.length : 0;
      } catch (_e) {
        // C3b L5：快照解析失败按「不完整」处理（宁可拒绝，不能悄悄当成 0 条告警/清理警告放行）——
        // 把两个计数都顶到非零，让 deviceJudgementError 的第二条规则（判正常时无说明→拒）照常拦下，
        // 与 deviceJudgementError 自身"读不出快照就没法安全地判正常"的判断方向一致（该函数原为服务
        // 器单独判断 POST /inspections/:id/review 与本文件共用，C7 已随单独设备巡检退役删除那条
        // 路由，现在只有本文件在调用，判断方向不变），不因为巡检单这条路径多包了一层 Map 缓存就悄悄
        // 变宽松。
        alertsCount = 1;
        cleanupWarningsCount = 1;
      }
      byInspectionId.set(row.id, { collectionStatus: row.collection_status, alertsCount, cleanupWarningsCount });
    }
    const byItemId = new Map();
    for (const it of items) { if (it.device_inspection_id && byInspectionId.has(it.device_inspection_id)) byItemId.set(it.id, byInspectionId.get(it.device_inspection_id)); }
    return byItemId;
  }
  // 已提交单按方案 §5.3 可保存修改；权限由 sheetActions 和写事务共同校验。
  function sheetActions(user, level, sheet) {
    if (!sheet) return [];
    const canWriteBase = user.role === 'admin' || level === 'write';
    if (!canWriteBase) return [];
    const isAdmin = user.role === 'admin';
    const manager = isAdmin || sheet.created_by === user.id;
    if (sheet.deleted_at) return isAdmin ? ['restore'] : [];
    const actions = [];
    if (sheet.status === 'draft') {
      // C3b L6：collect（一键采集）只对草稿有效（方案 §5.4/§5.2），能编辑这张草稿的人（manager）
      // 才该看到这个动作——与 save/submit/delete 同一批判据，不单独维护一份权限逻辑。
      if (manager) actions.push('save', 'submit', 'delete', 'collect');
    } else if (sheet.status === 'submitted') {
      if (manager) actions.push('save', 'delete');
      if (isAdmin) actions.push('archive');
    } else if (sheet.status === 'archived') {
      if (isAdmin) actions.push('unarchive');
    }
    return actions;
  }
  function sheetVisibility(user, sheet) {
    if (!sheet) return 'none';
    const isAdmin = user.role === 'admin';
    const isOwner = sheet.created_by === user.id;
    if (sheet.deleted_at) return isAdmin ? 'full' : 'none';
    if (sheet.status === 'draft') return isAdmin || isOwner ? 'full' : 'summary';
    return 'full';
  }

  // ============================================================
  // 四、响应整形
  // ============================================================
  const PHOTO_VIEW_COLUMNS = 'id,slot,target_id,original_name,mime,size,created_by,created_at,state';
  function sheetView(row) {
    const { scope_json, ...rest } = row;
    return { ...rest, scope: JSON.parse(scope_json) };
  }
  async function displayName(q, userId) { const row = await q.get('SELECT display_name FROM users WHERE id=?', [userId]); return row ? row.display_name : null; }
  // level: the caller's ledger level, looked up once per list request by the caller.
  async function listRow(q, user, sheet, level) {
    const visibility = sheetVisibility(user, sheet);
    if (visibility === 'none') return null;
    const actions = sheetActions(user, level, sheet);
    const createdByName = await displayName(q, sheet.created_by);
    // item_key is needed by sheetProgress to apply the template range to number items (same rule as detail and submit).
    // C3：加 device_inspection_id——sheetProgress 用它判定该行是否关联了采集记录，需要走设备判断
    // 规则（不加这一列就等于永远查不到 collections，device 规则悄悄失效）。
    const items = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=?', [sheet.id]);
    // C2：全扫调用方补真实照片——35S 的教训是列表口径漏改；这里查 active 照片位置供 sheetProgress
    // 计算真实的 photos_expected/photos_uploaded（35T-R M2 handoff 提醒）。C2c L6：SELECT 里带上
    // state 列——sheetProgress 现在自己判定 state==='active'，不再信任这里的 WHERE 预过滤。
    const photos = await q.all("SELECT slot,target_id,state FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active'", [sheet.id]);
    // C3：设备判断规则所需的采集信息——调用方查好传入（sheetProgress 是纯函数，不查库）。
    const collections = await loadDeviceCollections(q, items);
    const progress = sheetProgress(sheet, items, photos, collections);
    if (visibility === 'summary') {
      return { id: sheet.id, room_name: sheet.room_name, created_by_name: createdByName, created_at: sheet.created_at, filled: progress.filled, total: progress.total, visibility, actions };
    }
    const editCount = (await q.get("SELECT COUNT(*) n FROM it_inspection_sheet_log WHERE sheet_id=? AND action='edit'", [sheet.id])).n;
    // C4：只给 full 可见的行加 version——批量归档(POST /sheets/archive)与恢复(POST /sheets/:id/restore)
    // 都要求 expected_version，列表此前不返回这个字段，前端拿不到就没法发起这两个写请求（唯一允许的
    // routes/ 改动）。summary 行（他人草稿）不加：草稿既不能批量归档也不能恢复，用不到版本号，且
    // 版本号会额外暴露他人草稿的保存次数，按 §4.2 摘要白名单口径不放出。
    return {
      id: sheet.id, room_name: sheet.room_name, status: sheet.status, version: sheet.version,
      abnormal: progress.abnormal, filled: progress.filled, total: progress.total,
      photos_expected: progress.photosExpected, photos_uploaded: progress.photosUploaded,
      edit_count: editCount, created_by_name: createdByName, created_at: sheet.created_at,
      submitted_at: sheet.submitted_at, archived_at: sheet.archived_at,
      deleted_at: sheet.deleted_at, delete_reason: sheet.delete_reason,
      visibility, actions,
    };
  }
  async function loadDetail(q, user, sheetId, sheetRow) {
    const sheet = sheetRow || (await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [sheetId]));
    const items = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=? ORDER BY id', [sheetId]);
    const photos = await q.all(`SELECT ${PHOTO_VIEW_COLUMNS} FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active' ORDER BY id`, [sheetId]);
    // C2 §5.2：详情另加 my_pending_photos——调用者自己在本单上的待生效照片（他人的 pending 不出现）。
    const myPendingPhotos = await q.all(`SELECT ${PHOTO_VIEW_COLUMNS} FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='pending' AND pending_by=? ORDER BY id`, [sheetId, user.id]);
    const myRemovedPhotoIds = (await pendingPhotoRemovals(q, sheetId, user.id)).map(r=>r.photo_id);
    const logRows = await q.all('SELECT l.id,l.actor_id,u.display_name AS actor_name,l.at,l.op_id,l.action,l.reason,l.diff_json FROM it_inspection_sheet_log l LEFT JOIN users u ON u.id=l.actor_id WHERE l.sheet_id=? ORDER BY l.id', [sheetId]);
    const log = logRows.map(({ diff_json, ...rest }) => ({ ...rest, diff: diff_json ? JSON.parse(diff_json) : null }));
    // C3：items 这里是 SELECT * 已经带 device_inspection_id，设备判断规则所需的采集信息查好传入。
    const collections = await loadDeviceCollections(q, items);
    const progress = sheetProgress(sheet, items, photos, collections);
    const level = await currentLevel(q, user);
    const actions = sheetActions(user, level, sheet);
    const createdByName = await displayName(q, sheet.created_by);
    return { ...sheetView(sheet), created_by_name: createdByName, items: items.map(it => { const { manual_observation_json, ...rest } = it; return { ...rest, manual_observation: manualObservation(it) }; }), photos, my_pending_photos: myPendingPhotos, my_removed_photo_ids: myRemovedPhotoIds, photo_limit: PHOTO_LIMIT, log, progress, actions };
  }

  // ============================================================
  // 五、检查项写入校验（PUT 请求体，方案 §5.6）
  // ============================================================
  const ITEM_PATCH_KEYS = ['id', 'result', 'number_value', 'note'];
  function validateItemPatch(it) {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw bad('检查项格式无效');
    if (Object.keys(it).some(k => ![...ITEM_PATCH_KEYS, 'manual_observation'].includes(k)) || !ITEM_PATCH_KEYS.every((k) => Object.hasOwn(it, k))) throw bad('检查项须包含 id/result/number_value/note，另可带人工观察记录');
    if (Object.hasOwn(it, 'manual_observation')) it.manual_observation = validateManualObservation(it.manual_observation);
    if (!Number.isSafeInteger(it.id) || it.id < 1) throw bad('检查项编号无效');
    if (it.result !== null && !['ok', 'bad'].includes(it.result)) throw bad('检查项结果须为 ok/bad/null');
    if (it.number_value !== null && !Number.isFinite(it.number_value)) throw bad('数值项须为有限数或 null');
    if (it.note !== null && (typeof it.note !== 'string' || it.note.length > 500)) throw bad('说明最多500字');
    // C2c L1：空串与纯空白规范为 null——校验层就地把它变成"没有说明"，不让空白字符串混进落库值，
    // 下游（缺说明判定、edit diff 比对）才能用严格相等而不必到处补 trim()/||null 兜底。
    if (it.note !== null && it.note.trim() === '') it.note = null;
  }
  function validateItemAgainstTarget(it, target) {
    if (!target) throw bad('检查项不属于本单');
    if (Object.hasOwn(it, 'manual_observation') && target.section !== 'device') throw bad('仅设备检查项支持人工观察记录');
    if (target.value_kind === 'number') {
      if (it.result !== null) throw bad('数值项不接受结果字段');
      if (it.note !== null) throw bad('数值项不接受说明字段');
      if (it.number_value !== null) {
        const range = NUMBER_RANGE_BY_KEY[target.item_key];
        if (range && (it.number_value < range[0] || it.number_value > range[1])) throw bad('数值超出模板范围');
      }
    } else if (it.number_value !== null) throw bad('勾选项不接受数值字段');
  }

  // ============================================================
  // 五之二、照片与清理队列（方案 §2.3、§2.6、§5.2、§5.6，C2）
  // ============================================================
  // discardPhotoRow：删除一张照片行并在同一写事务里把它的文件名插入清理队列（§2.6 规则一）。
  //   调用方必须已经拿着写事务的 q，本函数不新开事务——保持"删行+入队"在同一个写事务内。
  async function discardPhotoRow(q, photoRow, reason) {
    if (await photoRemovalsExist(q)) await q.run('DELETE FROM it_inspection_photo_removals WHERE photo_id=?', [photoRow.id]);
    await q.run('DELETE FROM it_inspection_sheet_photos WHERE id=?', [photoRow.id]);
    await q.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)', [photoRow.stored_name, 'sheet_photos', reason, new Date().toISOString()]);
  }
  async function insertPhotoRow(q, { sheetId, slot, targetId, name, storedName, mime, size, sha256, userId, now, state, pendingBy }) {
    const ins = await q.run(
      'INSERT INTO it_inspection_sheet_photos(sheet_id,slot,target_id,original_name,stored_name,mime,size,sha256,created_by,created_at,state,pending_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      [sheetId, slot, targetId, name, storedName, mime, size, sha256, userId, now, state, pendingBy || null]
    );
    return ins.lastID;
  }
  async function photoRowView(q, photoId) { return q.get(`SELECT ${PHOTO_VIEW_COLUMNS} FROM it_inspection_sheet_photos WHERE id=?`, [photoId]); }

  // 重复照片提示（§5.6、33-R H2、33-R2 M2）：本单以外、state IN ('active','superseded') 的照片
  //   （排除全部 pending，含调用者自己在别的单上的 pending）；命中按 sheetVisibility 分流：full →
  //   单号/时间/照片状态/单据是否已删除；summary/none → 只置 restrictedMatch=true，不带单据信息。
  //   同一张单只报一次（取遇到的第一条命中）——C2b 修复（主会话验收发现）：原先只按 p.id 排序，
  //   若同一单里既有旧的 superseded 又有新的 active 命中同一哈希，会先遇到 id 更小的 superseded
  //   行并把它当成该单的代表结果，明明这张单当前有一张有效照片却报「已替换」。改为 active 优先：
  //   ORDER BY 把 state='active' 的行整体排到所有 superseded 行之前，同一单第一次被记入
  //   seenSheetIds 时就是它的 active 命中（如果存在）。
  async function findDuplicateMatches(q, user, excludeSheetId, sha256) {
    const rows = await q.all(
      `SELECT p.sheet_id, p.state AS photo_state, s.status AS sheet_status, s.created_by, s.created_at, s.submitted_at, s.deleted_at
       FROM it_inspection_sheet_photos p JOIN it_inspection_sheets s ON s.id=p.sheet_id
       WHERE p.sheet_id<>? AND p.sha256=? AND p.state IN ('active','superseded')
       ORDER BY (CASE WHEN p.state='active' THEN 0 ELSE 1 END), p.id`,
      [excludeSheetId, sha256]
    );
    const matches = [];
    let restrictedMatch = false;
    const seenSheetIds = new Set();
    for (const r of rows) {
      const vis = sheetVisibility(user, { created_by: r.created_by, status: r.sheet_status, deleted_at: r.deleted_at });
      if (vis === 'full') {
        if (seenSheetIds.has(r.sheet_id)) continue;
        seenSheetIds.add(r.sheet_id);
        matches.push({ sheet_id: r.sheet_id, at: r.submitted_at || r.created_at, photo_state: r.photo_state, sheet_deleted: !!r.deleted_at });
      } else {
        restrictedMatch = true;
      }
    }
    return { matches, restricted_match: restrictedMatch };
  }

  const upload = photoFiles.createUpload(storageDir);
  const receive = photoFiles.receiveUpload(upload);

  // 未入库上传文件的兜底清理（§2.6 规则二）：独立顶层函数，不内联进任何 router.xxx(...) 的处理器体
  // 内——C1 的静态守卫（verify-it-ledger-inspection-sheets.js）用 AST 逐路由核对"恰有1处withWrite
  // 且首句assertWrite"；若把这段"另开写事务入队"直接写进 POST /:id/photos 的处理器函数体，会在同一
  // 条路由里出现第2处withWrite，破坏该路由"恰有1处"的判别力。抽成独立函数后，AST 只在遍历
  // router.post('/:id/photos', handler) 的 handler 子树时才会收集withWrite节点，不会跟进
  // queueUploadAborted 这个被调用的、但物理上不在该子树内的函数体，因此不计入该路由的withWrite数。
  async function queueUploadAborted(storedName) {
    await withWrite(async (q) => {
      await ensureTables(q);
      await q.run('INSERT INTO it_inspection_file_cleanup(stored_name,dir_key,reason,created_at) VALUES(?,?,?,?)', [storedName, 'sheet_photos', 'upload_aborted', new Date().toISOString()]);
    });
  }
  // 上传失败时的兜底：立即 unlink；失败则退避到 queueUploadAborted；再失败只记日志（不改响应，
  // 响应仍按原失败原因返回，§2.6）。同样是独立顶层函数（不在任何路由处理器体内）。
  // removeFile：每次调用时才读 testHooks.removeStoredFile（不在工厂构造时把函数引用摘出来绑死）——
  // 这样测试可以在同一个已构造好的模块实例上，中途改写 testHooks.removeStoredFile 的行为（先模拟
  // "unlink本身也失败"，验证完 upload_aborted 入队后，再切回真实实现验证"恢复注入点后下一次写
  // 请求清掉"），不需要为每种场景各起一个新夹具。testHooks 存在时用它，否则落回
  // photoFiles.removeStoredFile 原样（生产路径 testHooks 恒为 undefined）。
  async function removeFile(dir, name) {
    const fn = (testHooks && typeof testHooks.removeStoredFile === 'function') ? testHooks.removeStoredFile : photoFiles.removeStoredFile;
    return fn(dir, name);
  }
  async function cleanupAbortedUpload(storedName) {
    const ok = await removeFile(storageDir, storedName);
    if (ok) return;
    try {
      await queueUploadAborted(storedName);
    } catch (queueErr) {
      // eslint-disable-next-line no-console
      console.error('[inspection-sheets] upload_aborted 入队失败，等下一次目录对账兜底：', queueErr && queueErr.message);
    }
  }

  // C2d T-H2：processCleanupQueue 真正的 unlink 调用挪到这个包装函数后面——每次调用时才读
  //   testHooks.queueUnlink（同 removeFile() 的写法，不在工厂构造时把函数引用摘出来绑死），
  //   测试可以中途把它换成一个恒抛错的函数，模拟"队列处理时 unlink 失败"，验证失败退避（记
  //   last_error、attempts+1、队列行不删、文件不动）与恢复后下一次处理能追上这两段路径；
  //   testHooks 不存在或没设 queueUnlink 时落回真实 fsp.unlink，生产路径行为不变。
  async function queueUnlink(fullPath) {
    const fn = (testHooks && typeof testHooks.queueUnlink === 'function') ? testHooks.queueUnlink : fsp.unlink;
    return fn(fullPath);
  }

  // 清理队列重试（§2.6 规则三/四）：独立顶层函数，同理不出现在任何路由处理器体的 AST 子树内。
  //   分两阶段：① withRead 读出至多 limit 条待清理行 ② 锁外逐个 unlink（M3：删除前复核归属，仍被
  //   it_inspection_sheet_photos 引用的行不删文件） ③ 一个新的 withWrite 把成功的删行、失败的
  //   attempts+1/last_error（比逐条各开一次写事务更省锁）。
  //   C2c M1：ORDER BY 从纯 id 改成 `attempts, id`——一批持续失败（attempts 一直增长）的旧行会沉到
  //   队尾，不会占满每次最多 limit 条的处理名额把后面新入队的正常行"饿死"（新行 attempts=0，永远
  //   排在失败行前面，只要它能成功处理就会被优先清掉，不用等前面那批坏行"轮到"）。
  async function processCleanupQueue(limit = 20) {
    const rows = await withRead(async (q) => {
      if (!(await exists(q))) return [];
      return q.all('SELECT id,stored_name FROM it_inspection_file_cleanup ORDER BY attempts, id LIMIT ?', [limit]);
    });
    if (!rows.length) return { processed: 0, failed: 0 };
    // M3：删除前复核归属——stored_name 理论上不该再被 it_inspection_sheet_photos 引用（全局唯一
    // 且每次上传都是全新 UUID，discardPhotoRow 删行与入队在同一事务），这里是纵深防御，覆盖"通过
    // SQL 直接构造的不可达状态"（守卫测试会这么干）；命中的话不删文件，只记"仍被引用"、
    // attempts+1，跟真正的 unlink 失败走同一套重试节奏，不会死循环误删也不会卡死不重试。
    const stillOwned = await withRead(async (q) => {
      const set = new Set();
      for (const row of rows) {
        const r = await q.get('SELECT 1 v FROM it_inspection_sheet_photos WHERE stored_name=? LIMIT 1', [row.stored_name]);
        if (r) set.add(row.stored_name);
      }
      return set;
    });
    const outcomes = [];
    for (const row of rows) {
      if (stillOwned.has(row.stored_name)) { outcomes.push({ id: row.id, ok: false, message: '仍被引用' }); continue; }
      try {
        await queueUnlink(photoFiles.safeFilePath(storageDir, row.stored_name));
        outcomes.push({ id: row.id, ok: true });
      } catch (e) {
        if (e.code === 'ENOENT') outcomes.push({ id: row.id, ok: true });
        else outcomes.push({ id: row.id, ok: false, message: e.message });
      }
    }
    await withWrite(async (q) => {
      for (const o of outcomes) {
        if (o.ok) await q.run('DELETE FROM it_inspection_file_cleanup WHERE id=?', [o.id]);
        else await q.run('UPDATE it_inspection_file_cleanup SET attempts=attempts+1,last_error=? WHERE id=?', [o.message || 'unlink failed', o.id]);
      }
    });
    return { processed: rows.length, failed: outcomes.filter((o) => !o.ok).length };
  }
  // best-effort 包装：每次巡检单写请求成功后顺带处理最多20条（§2.6 规则三），失败绝不能连累触发
  // 它的那个请求——只吞掉异常，不重新抛出。C2c M1：调用点从"响应发出之前"挪到"响应发出之后"
  // （各路由内 `res.json(...)` 之后调用、不 await），不再让用户的写请求等这把锁——处理最多20条
  // 涉及最多20次 unlink + 一次写事务，如果队列里堆积了很多行，这段延迟不该算在当前这个用户的
  // 请求耗时里。调用方需要自己决定是否 await：路由处理器里改成"发响应后 fire-and-forget"，不在
  // 这个函数内部强制。
  // G2A2 Commit2（主会话裁定）→ G3A（41T H2 收窄）：本函数改为把 limit 原样交给
  //   runCleanupDetached(limit)——响应已发出之后的独立维护动作，index.js 内部借这个数字型参数
  //   显式退出触发它的那次写请求的 ALS 上下文，探针不再把这段读记成"写请求上下文里的"；try/catch
  //   仍在这里做（best-effort 语义——清理失败不能连累触发它的那次请求，也不能变成未处理的 rejected
  //   promise）。runCleanupDetached 标识符只允许出现在本文件顶部工厂参数解构处与这一处直接调用
  //   （静态守卫 R8）。
  async function processCleanupQueueBestEffort(limit) {
    try { await runCleanupDetached(limit); } catch (_e) { /* best-effort，下次写请求或下次就绪对账再清 */ }
  }

  // ============================================================
  // 六、路由——字面路径必须先于 /:id 注册（Express 顺序匹配）
  // ============================================================
  router.get('/', async (req, res) => {
    try {
      if (Object.keys(req.query).some((k) => !['room', 'status'].includes(k))) throw bad('未声明的筛选字段');
      if (req.query.room !== undefined && typeof req.query.room !== 'string') throw bad('room 参数无效');
      if (req.query.status !== undefined && typeof req.query.status !== 'string') throw bad('status 参数无效');
      if (req.query.status !== undefined && !['draft', 'submitted', 'archived'].includes(req.query.status)) throw bad('status 参数无效');
      const rows = await withRead(async (q) => {
        await canRead(q, req.user);
        if (!(await exists(q))) return [];
        let sql = 'SELECT * FROM it_inspection_sheets WHERE deleted_at IS NULL';
        const params = [];
        if (req.query.room !== undefined) { sql += ' AND room_name=?'; params.push(req.query.room); }
        if (req.query.status !== undefined) { sql += ' AND status=?'; params.push(req.query.status); }
        sql += ' ORDER BY id DESC';
        const sheets = await q.all(sql, params);
        const out = [];
        const level = await currentLevel(q, req.user);
        for (const s of sheets) { const row = await listRow(q, req.user, s, level); if (row) out.push(row); }
        return out;
      });
      res.json({ items: rows });
    } catch (e) { handleErr(res, e); }
  });

  router.get('/overview', async (req, res) => {
    try {
      const result = await withRead(async (q) => {
        await canRead(q, req.user);
        const { month } = await q.get("SELECT strftime('%Y-%m','now','localtime') AS month");
        const rackRooms = await q.all('SELECT DISTINCT room FROM it_racks');
        const sheets = (await exists(q)) ? await q.all(
          "SELECT *, strftime('%Y-%m',submitted_at,'localtime')=strftime('%Y-%m','now','localtime') AS month_done, CAST(julianday(date('now','localtime'))-julianday(date(submitted_at,'localtime')) AS INTEGER) AS days_since FROM it_inspection_sheets WHERE deleted_at IS NULL ORDER BY submitted_at DESC,id DESC"
        ) : [];
        const names = new Set(rackRooms.map(r => r.room).filter(Boolean));
        sheets.forEach(s => names.add(s.room_name));
        const level = await currentLevel(q, req.user);
        const rooms = [];
        // Same localeCompare ordering as the front-end rooms() selector.
        for (const room of [...names].sort((a, b) => a.localeCompare(b))) {
          const roomSheets = sheets.filter(s => s.room_name === room);
          const completed = roomSheets.filter(s => ['submitted', 'archived'].includes(s.status));
          const last = completed[0];
          const lastRow = last ? await listRow(q, req.user, last, level) : null;
          const draftSheet = roomSheets.find(s => s.status === 'draft');
          let draft = null;
          if (draftSheet) {
            // listRow owns sheetVisibility and the summary field boundary.
            const row = await listRow(q, req.user, draftSheet, level);
            draft = { id: row.id, created_by_name: row.created_by_name, created_at: row.created_at, filled: row.filled, total: row.total, visibility: row.visibility };
            if (row.visibility === 'full') draft.abnormal = row.abnormal;
          }
          rooms.push({ room, this_month_done: completed.some(s => s.month_done === 1),
            last_submitted_at: last ? last.submitted_at : null,
            last_submitted_by_name: last ? await displayName(q, last.submitted_by) : null,
            last_filled: lastRow ? lastRow.filled : null, last_total: lastRow ? lastRow.total : null,
            last_abnormal: lastRow ? lastRow.abnormal : null, days_since_last: last ? last.days_since : null, draft });
        }
        return { month, rooms };
      });
      res.json(result);
    } catch (e) { handleErr(res, e); }
  });

  router.get('/stats', async (req, res) => {
    try {
      const result = await withRead(async (q) => {
        await canRead(q, req.user);
        if (!(await exists(q))) return { submitted_month: 0, abnormal_month: 0, drafts: 0, pending_archive: 0 };
        const monthSheets = await q.all(
          "SELECT id FROM it_inspection_sheets WHERE status IN ('submitted','archived') AND deleted_at IS NULL AND submitted_at IS NOT NULL AND strftime('%Y-%m',submitted_at,'localtime')=strftime('%Y-%m','now','localtime')"
        );
        let abnormalMonth = 0;
        for (const s of monthSheets) { const n = (await q.get("SELECT COUNT(*) n FROM it_inspection_sheet_items WHERE sheet_id=? AND result='bad'", [s.id])).n; if (n > 0) abnormalMonth++; }
        const drafts = (await q.get("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status='draft'")).n;
        const pendingArchive = (await q.get("SELECT COUNT(*) n FROM it_inspection_sheets WHERE status='submitted' AND deleted_at IS NULL")).n;
        return { submitted_month: monthSheets.length, abnormal_month: abnormalMonth, drafts, pending_archive: pendingArchive };
      });
      res.json(result);
    } catch (e) { handleErr(res, e); }
  });

  router.get('/deleted', async (req, res) => {
    try {
      if (req.user.role !== 'admin') throw forbidden('仅管理员可查看已删除列表');
      const rows = await withRead(async (q) => {
        await canRead(q, req.user);
        if (!(await exists(q))) return [];
        const sheets = await q.all('SELECT * FROM it_inspection_sheets WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
        const out = [];
        const level = await currentLevel(q, req.user);
        for (const s of sheets) { const row = await listRow(q, req.user, s, level); if (row) out.push(row); }
        return out;
      });
      res.json({ items: rows });
    } catch (e) { handleErr(res, e); }
  });

  router.post('/', requireLedgerWrite, async (req, res) => {
    try {
      const b = input(req.body, ['room_name']);
      if (typeof b.room_name !== 'string' || !b.room_name.trim()) throw bad('请填写机房名称');
      const roomName = b.room_name.trim();
      const detail = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        await ensureTables(q);
        const existing = await q.get("SELECT s.id,s.created_at,u.display_name AS created_by_name FROM it_inspection_sheets s LEFT JOIN users u ON u.id=s.created_by WHERE s.room_name=? AND s.status='draft'", [roomName]);
        if (existing) throw error(409, 'SHEET_DRAFT_EXISTS', '该机房已有一张草稿', { draft: { id: existing.id, created_by_name: existing.created_by_name, created_at: existing.created_at } });
        const scope = await buildScope(q, roomName);
        const now = new Date().toISOString();
        const ins = await q.run('INSERT INTO it_inspection_sheets(room_name,scope_json,template_version,status,created_by,created_at,version,updated_at) VALUES(?,?,?,?,?,?,1,?)', [roomName, JSON.stringify(scope), TEMPLATE_VERSION, 'draft', req.user.id, now, now]);
        const sheetId = ins.lastID;
        for (const r of buildItemRows(scope)) {
          await q.run('INSERT INTO it_inspection_sheet_items(sheet_id,section,target_id,target_label,item_key,item_label,value_kind) VALUES(?,?,?,?,?,?,?)', [sheetId, r.section, r.target_id, r.target_label, r.item_key, r.item_label, r.value_kind]);
        }
        await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [sheetId, req.user.id, now, crypto.randomUUID(), 'create']);
        return loadDetail(q, req.user, sheetId);
      });
      res.status(201).json(detail);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.post('/archive', requireLedgerWrite, async (req, res) => {
    try {
      const b = input(req.body, ['items']);
      if (!Array.isArray(b.items) || !b.items.length) throw bad('items 不能为空');
      for (const it of b.items) {
        if (!it || typeof it !== 'object' || Array.isArray(it) || Object.keys(it).some((k) => !['id', 'expected_version'].includes(k))) throw bad('items 元素字段无效');
        if (!Number.isSafeInteger(it.id) || it.id < 1) throw bad('单据编号无效');
        if (!Number.isSafeInteger(it.expected_version) || it.expected_version < 1) throw bad('版本号无效');
      }
      const ids = b.items.map((x) => x.id);
      if (new Set(ids).size !== ids.length) throw bad('items 中存在重复编号');
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (req.user.role !== 'admin') throw forbidden('仅管理员可以归档');
        const problems = [];
        const sheets = [];
        for (const it of b.items) {
          const sheet = (await exists(q)) ? await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [it.id]) : null;
          if (!sheet || sheet.deleted_at) problems.push({ id: it.id, reason: '不存在或已删除' });
          else if (sheet.status !== 'submitted') problems.push({ id: it.id, reason: '不是已提交状态' });
          else if (sheet.version !== it.expected_version) problems.push({ id: it.id, reason: '版本不符' });
          else sheets.push(sheet);
        }
        if (problems.length) throw error(409, 'SHEET_STATE', '存在不合格的单据，未归档', { problems });
        const now = new Date().toISOString(); const opId = crypto.randomUUID();
        // C2 §4.1：归档同事务丢弃该单全部待生效照片（不分是谁的 pending）；丢弃数放进响应
        // discarded_pending，不写进日志——§4.1 文字说"日志注明丢弃张数"，但 §2.4 的 CHECK 规定
        // archive 行 reason 必须为 NULL、diff_json 也必须为 NULL，两者矛盾，按 CHECK 为准（详见
        // 报告"与方案的冲突点"）。
        // Claude 复核 L4：discarded_pending 只计照片张数；清掉的「待移除」暂存另记 discarded_removals。
        let discardedPendingTotal = 0, discardedRemovalsTotal = 0;
        for (const sheet of sheets) {
          const pendingRows = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='pending'", [sheet.id]);
          for (const p of pendingRows) await discardPhotoRow(q, p, 'archive_pending_discarded');
          discardedPendingTotal += pendingRows.length;
          discardedRemovalsTotal += await clearPhotoRemovals(q, sheet.id);
          await q.run('UPDATE it_inspection_sheets SET status=?,archived_by=?,archived_at=?,version=version+1,updated_at=? WHERE id=?', ['archived', req.user.id, now, now, sheet.id]);
          await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [sheet.id, req.user.id, now, opId, 'archive']);
        }
        return { archived: sheets.map((s) => s.id), op_id: opId, discarded_pending: discardedPendingTotal, discarded_removals: discardedRemovalsTotal };
      });
      res.json(result);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.get('/:id', async (req, res) => {
    try {
      const n = id(req.params.id);
      const detail = await withRead(async (q) => {
        await canRead(q, req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) !== 'full') throw notFound();
        return loadDetail(q, req.user, n, sheet);
      });
      res.json(detail);
    } catch (e) { handleErr(res, e); }
  });

  // C2 §5.3：已提交单「保存修改」七步，抽成独立函数（仍在同一个 withWrite 回调内被 PUT /:id
  // 调用，不新开事务——AST 静态守卫按"路由处理器体内的 withWrite 调用次数"计数，saveDraft/
  // saveSubmittedEdit 是被 PUT 处理器的 withWrite 回调直接调用的普通函数，不新增该路由的
  // withWrite 计数）。
  async function saveDraft(q, user, n, sheet, b, items, hasRemark) {
    if (sheet.version !== b.expected_version) throw versionConflict();
    // L5：items 为空且不带 remark 时没有任何要保存的内容，不写库、不增版本，直接返回当前详情。
    if (!items.length && !hasRemark) return loadDetail(q, user, n, sheet);
    await ensureManualObservationColumn(q);
    if (items.length) {
      const rows = await q.all('SELECT id,section,value_kind,item_key FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const it of items) validateItemAgainstTarget(it, byId.get(it.id));
      for (const it of items) await writeItemPatch(q, it, n);
    }
    const now = new Date().toISOString();
    if (hasRemark) await q.run('UPDATE it_inspection_sheets SET remark=?,version=version+1,updated_at=? WHERE id=?', [b.remark, now, n]);
    else await q.run('UPDATE it_inspection_sheets SET version=version+1,updated_at=? WHERE id=?', [now, n]);
    return loadDetail(q, user, n);
  }

  function itemLabel(itemsById, itemId) { const it = itemsById.get(itemId); return it ? (it.target_label + ' · ' + it.item_label) : ('检查项#' + itemId); }
  function rackLabel(scope, rackId) { const r = (scope.racks || []).find((x) => x.id === rackId); return r ? r.name : ('机柜#' + rackId); }

  async function saveSubmittedEdit(q, user, n, sheet, b, items, hasRemark) {
    // 1) 复核版本（状态=submitted、未删除、归属已在 PUT 处理器里核过）。
    if (sheet.version !== b.expected_version) throw versionConflict();
    const scope = JSON.parse(sheet.scope_json);
    await ensureManualObservationColumn(q);
    await ensurePhotoCollections(q);

    // 2) 写前快照（检查项、备注、active 照片）。
    const beforeItems = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=? ORDER BY id', [n]);
    const beforeItemsById = new Map(beforeItems.map((it) => [it.id, it]));
    const beforeRemark = sheet.remark;

    // 3) 写入检查项与备注（只接受本单已有的 item id——validateItemAgainstTarget 对 byId.get 未命中
    //    的情况会抛"检查项不属于本单"）。
    if (items.length) {
      const rows = await q.all('SELECT id,section,value_kind,item_key FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const it of items) validateItemAgainstTarget(it, byId.get(it.id));
      for (const it of items) await writeItemPatch(q, it, n);
    }
    if (hasRemark) await q.run('UPDATE it_inspection_sheets SET remark=? WHERE id=?', [b.remark, n]);

    // 4) 处理调用者在本单的 pending 照片：rack_front、以及写后为异常的 item 照片生效（原 active
    //    改 superseded 并记 superseded_by/at，pending 改 active）；写后不是异常的 item pending
    //    直接丢弃（删行入队），不生效、不进 diff。
    const afterItemsForStep4 = await q.all('SELECT id,result FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
    const badIdsNow = new Set(afterItemsForStep4.filter((it) => it.result === 'bad').map((it) => it.id));
    const rackIds = new Set((scope.racks || []).map((r) => r.id));
    const myPending = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='pending' AND pending_by=?", [n, user.id]);
    const photoDiffEntries = [];
    const removals = await pendingPhotoRemovals(q, n, user.id);
    for (const removal of removals) {
      const p = await q.get("SELECT * FROM it_inspection_sheet_photos WHERE id=? AND sheet_id=? AND state='active'", [removal.photo_id,n]);
      if (!p) continue;
      await q.run("UPDATE it_inspection_sheet_photos SET state='superseded',superseded_by=?,superseded_at=? WHERE id=?", [user.id,new Date().toISOString(),p.id]);
      photoDiffEntries.push({kind:'photo_removed',slot:p.slot,target_id:p.target_id,label:p.slot==='rack_front'?rackLabel(scope,p.target_id):itemLabel(beforeItemsById,p.target_id),photo_id:p.id});
      await q.run('DELETE FROM it_inspection_photo_removals WHERE photo_id=?', [p.id]);
    }
    for (const p of myPending) {
      const shouldActivate = (p.slot === 'rack_front' && rackIds.has(p.target_id)) || (p.slot === 'item' && badIdsNow.has(p.target_id));
      if (shouldActivate) {
        await q.run("UPDATE it_inspection_sheet_photos SET state='active',pending_by=NULL WHERE id=?", [p.id]);
        const label = p.slot === 'rack_front' ? rackLabel(scope, p.target_id) : itemLabel(beforeItemsById, p.target_id);
        photoDiffEntries.push({ kind: 'photo', slot: p.slot, target_id: p.target_id, label, before_photo_id: null, after_photo_id: p.id });
      } else {
        await discardPhotoRow(q, p, 'pending_not_abnormal');
      }
    }

    // 5) 写后结果为正常、但仍有 active item 照片的项：照片改 superseded，diff 记 photo_invalidated。
    for (const it of afterItemsForStep4) {
      if (it.result === 'bad') continue;
      const activeItemPhotos = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='item' AND target_id=? AND state='active'", [n, it.id]);
      for (const activeItemPhoto of activeItemPhotos) {
        const nowInvalidate = new Date().toISOString();
        await q.run('UPDATE it_inspection_sheet_photos SET state=?,superseded_by=?,superseded_at=? WHERE id=?', ['superseded', user.id, nowInvalidate, activeItemPhoto.id]);
        await q.run('DELETE FROM it_inspection_photo_removals WHERE photo_id=?', [activeItemPhoto.id]);
        photoDiffEntries.push({ kind: 'photo_invalidated', slot: 'item', target_id: it.id, label: itemLabel(beforeItemsById, it.id), photo_id: activeItemPhoto.id, cause: '改回正常' });
      }
    }

    // 6) 重读落库值校验完整性；不完整则整事务回滚（withWrite 的 catch 分支自动 ROLLBACK，pending
    //    照片因回滚而保持 pending，与草稿区分开——不是本函数手动恢复）。
    const finalItems = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
    const overLimit = await q.get("SELECT slot,target_id,COUNT(*) n FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active' GROUP BY slot,target_id HAVING COUNT(*)>? LIMIT 1", [n,PHOTO_LIMIT]);
    if (overLimit) throw error(409,'SHEET_PHOTO_LIMIT','每个附件位置最多10张图片，请移除多余照片后保存');
    const finalActivePhotos = await q.all("SELECT slot,target_id,state FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active'", [n]);
    // C3：finalItems 已含 device_inspection_id（SELECT *），设备判断规则所需的采集信息查好传入。
    const finalCollections = await loadDeviceCollections(q, finalItems);
    const progress = sheetProgress({ scope_json: sheet.scope_json }, finalItems, finalActivePhotos, finalCollections);
    if (!progress.complete) throw error(400, 'SHEET_INCOMPLETE', '检查项未填写完整', { unfilled_item_ids: progress.missing.unfilledItemIds, missing_note_item_ids: progress.missing.missingNoteItemIds, missing_photo_positions: progress.missing.missingPhotoPositions, device_issue_item_ids: progress.missing.deviceIssueItemIds, ...(progress.missing.manualObservationItemIds ? { manual_observation_item_ids: progress.missing.manualObservationItemIds } : {}) });

    // 7) 比对写前写后生成 diff；非空才写 edit 日志（新 op_id）并 version+1；空则不增版本、不写日志
    //    （返回的 loadDetail 里 version/log 都与写前一致，就是"没有变化"的可观察信号）。
    const afterItemsFull = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=? ORDER BY id', [n]);
    const itemDiffs = [];
    for (const after of afterItemsFull) {
      const before = beforeItemsById.get(after.id);
      if (!before) continue;
      const label = before.target_label + ' · ' + before.item_label;
      if (before.result !== after.result) itemDiffs.push({ kind: 'item', item_id: after.id, label, field: 'result', before: before.result, after: after.result });
      if (before.number_value !== after.number_value) itemDiffs.push({ kind: 'item', item_id: after.id, label, field: 'number_value', before: before.number_value, after: after.number_value });
      // C2c L1：note 已经在 validateItemPatch 里把空串/纯空白规范为 null（写路径落库前）——写前
      // 快照 beforeItems 读的是同样规则落库的历史值，两边严格相等比较即可，不再需要 ||null 兜底
      // （那种写法会把"从没填过"和"填了但后来清空成空串"这两种在旧数据里可能出现的情况悄悄合并成
      // 一样，掩盖真实变化）。
      if (before.note !== after.note) itemDiffs.push({ kind: 'item', item_id: after.id, label, field: 'note', before: before.note, after: after.note });
      if (before.manual_observation_json !== after.manual_observation_json) itemDiffs.push({ kind: 'item', item_id: after.id, label, field: 'manual_observation', before: manualObservation(before), after: manualObservation(after) });
    }
    const afterSheetRow = await q.get('SELECT remark FROM it_inspection_sheets WHERE id=?', [n]);
    const remarkDiffs = [];
    if (beforeRemark !== afterSheetRow.remark) remarkDiffs.push({ kind: 'remark', before: beforeRemark, after: afterSheetRow.remark });
    const diff = [...itemDiffs, ...remarkDiffs, ...photoDiffEntries];
    if (diff.length) {
      const now = new Date().toISOString();
      await q.run('UPDATE it_inspection_sheets SET version=version+1,updated_at=? WHERE id=?', [now, n]);
      await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,diff_json) VALUES(?,?,?,?,?,?)', [n, user.id, now, crypto.randomUUID(), 'edit', JSON.stringify(diff)]);
    }
    // C2c L2（方案 §2.4 原句「返回没有变化」）：diff 为空时响应体带 unchanged:true，非空时
    // unchanged:false——不再只靠"版本没变"这个间接信号，调用方（前端）能直接读这个字段判断。
    const detail = await loadDetail(q, user, n);
    return { ...detail, unchanged: !diff.length };
  }

  router.put('/:id', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const b = input(req.body, ['expected_version', 'items', 'remark']);
      if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 1) throw bad('版本号无效');
      if (Object.hasOwn(b, 'remark') && b.remark !== null && (typeof b.remark !== 'string' || b.remark.length > 2000)) throw bad('备注最多2000字');
      // C2c L1：remark 同 note 一样，空串/纯空白规范为 null。
      if (Object.hasOwn(b, 'remark') && b.remark !== null && b.remark.trim() === '') b.remark = null;
      const items = Object.hasOwn(b, 'items') ? b.items : [];
      if (!Array.isArray(items)) throw bad('items 必须是数组');
      items.forEach(validateItemPatch);
      // L5：同一请求内拒绝重复的 item id。
      if (new Set(items.map((it) => it.id)).size !== items.length) throw bad('items 中存在重复编号');
      const hasRemark = Object.hasOwn(b, 'remark');
      const detail = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) === 'none') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以保存');
        if (sheet.status === 'draft') return saveDraft(q, req.user, n, sheet, b, items, hasRemark);
        if (sheet.status === 'submitted') return saveSubmittedEdit(q, req.user, n, sheet, b, items, hasRemark);
        throw error(409, 'SHEET_STATE', '当前状态不允许保存');
      });
      res.json(detail);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.post('/:id/submit', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const b = input(req.body, ['expected_version']);
      if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 1) throw bad('版本号无效');
      const detail = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) === 'none') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以提交');
        if (sheet.status !== 'draft') throw error(409, 'SHEET_STATE', '只有草稿可以提交');
        if (sheet.version !== b.expected_version) throw versionConflict();
        const items = await q.all('SELECT * FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
        const photos = await q.all("SELECT slot,target_id,state FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='active'", [n]);
        // C3：items 已含 device_inspection_id（SELECT *），设备判断规则所需的采集信息查好传入。
        const collections = await loadDeviceCollections(q, items);
        const progress = sheetProgress(sheet, items, photos, collections);
        if (!progress.complete) throw error(400, 'SHEET_INCOMPLETE', '检查项未填写完整', { unfilled_item_ids: progress.missing.unfilledItemIds, missing_note_item_ids: progress.missing.missingNoteItemIds, missing_photo_positions: progress.missing.missingPhotoPositions, device_issue_item_ids: progress.missing.deviceIssueItemIds, ...(progress.missing.manualObservationItemIds ? { manual_observation_item_ids: progress.missing.manualObservationItemIds } : {}) });
        // C2 §3.1/§5.6：提交前丢弃"未标异常的 check 项"上残留的 item 照片（草稿阶段允许先传后标，
        // 提交时按当前结果修剪，不影响本次刚验过的 progress.complete——因为这些照片本来就不在
        // "应传"集合里，删不删都不影响 photosExpected/photosUploaded）。
        const badIds = new Set(items.filter((it) => it.result === 'bad').map((it) => it.id));
        const itemPhotos = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND slot='item' AND state='active'", [n]);
        for (const p of itemPhotos) { if (!badIds.has(p.target_id)) await discardPhotoRow(q, p, 'submit_pruned'); }
        const now = new Date().toISOString();
        await q.run('UPDATE it_inspection_sheets SET status=?,submitted_by=?,submitted_at=?,version=version+1,updated_at=? WHERE id=?', ['submitted', req.user.id, now, now, n]);
        await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [n, req.user.id, now, crypto.randomUUID(), 'submit']);
        return loadDetail(q, req.user, n);
      });
      res.json(detail);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.delete('/:id', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const b = input(req.body, ['expected_version', 'reason']);
      if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 1) throw bad('版本号无效');
      if (Object.hasOwn(b, 'reason') && b.reason !== null && typeof b.reason !== 'string') throw bad('删除原因无效');
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        // L1：判定顺序与 PUT/submit 一致——显式 sheetVisibility（none → 404）→ 已删除 404 →
        // 归属 403 → 状态（archived 409）→ 版本。
        if (!sheet || sheetVisibility(req.user, sheet) === 'none') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以删除');
        if (sheet.status === 'archived') throw error(409, 'SHEET_STATE', '已归档的单不能删除');
        if (sheet.version !== b.expected_version) throw versionConflict();
        if (sheet.status === 'draft') {
          // C2：补照片行删除+入队（草稿的照片全是 active，从不产生 pending）。
          const photoRows = await q.all('SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=?', [n]);
          for (const p of photoRows) await discardPhotoRow(q, p, 'draft_deleted');
          // C3（方案 §5.5）：该单关联的采集记录解除归属——sheet_id 置空、detached_from_sheet_id 置
          // 为本单，与下面即将执行的 items 物理删除同一事务（item 行马上就没了，device_inspection_id
          // 指向谁已经不重要，但 it_device_inspections 那边的记录不会跟着消失，必须显式解除归属，
          // 否则会一直挂着一个已经不存在的巡检单）。表可能还不存在（本库从未采集过）或缺两列（本地
          // 旧库）——先兜底建表/补列（幂等）再更新，UPDATE 对 0 行匹配也是安全的空操作。
          await collect.ensure(q);
          await collect.ensureDeviceInspectionColumns(q);
          await q.run('UPDATE it_device_inspections SET sheet_id=NULL, detached_from_sheet_id=? WHERE sheet_id=?', [n, n]);
          await q.run('DELETE FROM it_inspection_sheet_items WHERE sheet_id=?', [n]);
          await q.run('DELETE FROM it_inspection_sheet_log WHERE sheet_id=?', [n]);
          await q.run('DELETE FROM it_inspection_sheets WHERE id=?', [n]);
          return { physical: true };
        }
        if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 2000) throw bad('删除已提交的单需要填写原因（最多2000字）');
        // C2 §4.1：逻辑删除同事务丢弃该单全部待生效照片（不分是谁的 pending），丢弃数放进响应
        // discarded_pending，不写进日志（同归档的 CHECK 矛盾，见 POST /archive 同一条注释）。
        const pendingRows = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='pending'", [n]);
        for (const p of pendingRows) await discardPhotoRow(q, p, 'delete_pending_discarded');
        const removedChanges = await clearPhotoRemovals(q,n);
        const now = new Date().toISOString();
        await q.run('UPDATE it_inspection_sheets SET deleted_by=?,deleted_at=?,delete_reason=?,version=version+1,updated_at=? WHERE id=?', [req.user.id, now, b.reason.trim(), now, n]);
        await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)', [n, req.user.id, now, crypto.randomUUID(), 'delete', b.reason.trim()]);
        // L2：不再另开读事务返回完整明细，直接给精简结果。
        return { physical: false, id: n, version: sheet.version + 1, deleted_at: now, discarded_pending: pendingRows.length, discarded_removals: removedChanges };
      });
      if (result.physical) res.json({ ok: true });
      else res.json({ id: result.id, version: result.version, deleted_at: result.deleted_at, discarded_pending: result.discarded_pending, discarded_removals: result.discarded_removals });
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.post('/:id/restore', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const b = input(req.body, ['expected_version']);
      if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 1) throw bad('版本号无效');
      const detail = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (req.user.role !== 'admin') throw forbidden('仅管理员可以恢复');
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || !sheet.deleted_at) throw notFound();
        if (sheet.version !== b.expected_version) throw versionConflict();
        const now = new Date().toISOString();
        await q.run('UPDATE it_inspection_sheets SET deleted_by=NULL,deleted_at=NULL,delete_reason=NULL,version=version+1,updated_at=? WHERE id=?', [now, n]);
        await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action) VALUES(?,?,?,?,?)', [n, req.user.id, now, crypto.randomUUID(), 'restore']);
        return loadDetail(q, req.user, n);
      });
      res.json(detail);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.post('/:id/unarchive', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const b = input(req.body, ['expected_version', 'reason']);
      if (!Number.isSafeInteger(b.expected_version) || b.expected_version < 1) throw bad('版本号无效');
      if (typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 2000) throw bad('请填写撤回原因（最多2000字）');
      const detail = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (req.user.role !== 'admin') throw forbidden('仅管理员可以撤回归档');
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheet.deleted_at) throw notFound();
        if (sheet.status !== 'archived') throw error(409, 'SHEET_STATE', '只有已归档的单可以撤回');
        if (sheet.version !== b.expected_version) throw versionConflict();
        const now = new Date().toISOString();
        await q.run('UPDATE it_inspection_sheets SET status=?,archived_by=NULL,archived_at=NULL,version=version+1,updated_at=? WHERE id=?', ['submitted', now, n]);
        await q.run('INSERT INTO it_inspection_sheet_log(sheet_id,actor_id,at,op_id,action,reason) VALUES(?,?,?,?,?,?)', [n, req.user.id, now, crypto.randomUUID(), 'unarchive', b.reason.trim()]);
        return loadDetail(q, req.user, n);
      });
      res.json(detail);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  // ============================================================
  // 七、照片路由（方案 §5.2、C2）
  // ============================================================
  router.post('/:id/photos', requireLedgerWrite, async (req, res) => {
    let saved = false;
    try {
      const n = id(req.params.id);
      await receive(req, res);
      const b = input(req.body, ['slot', 'target_id']);
      if (!req.file) throw bad('请选择照片');
      if (!['rack_front', 'item'].includes(b.slot)) throw bad('slot 参数无效');
      const targetId = Number(b.target_id);
      if (!Number.isSafeInteger(targetId) || targetId < 1) throw bad('target_id 无效');
      const { name, mime, sha256 } = await photoFiles.validateUploadedFile(req.file);
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) !== 'full') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以上传照片');
        if (sheet.status !== 'draft' && sheet.status !== 'submitted') throw error(409, 'SHEET_STATE', '当前状态不允许上传照片');
        await ensurePhotoCollections(q);
        // 目标校验（§5.6）：rack_front 的 target 须为本单 scope_json 中的机柜；item 的 target
        // 须为本单 value_kind='check' 的检查项（草稿里不要求当前是异常，允许先传后标）。
        if (b.slot === 'rack_front') {
          const scope = JSON.parse(sheet.scope_json);
          if (!(scope.racks || []).some((r) => r.id === targetId)) throw bad('机柜不属于本单范围');
        } else {
          const targetItem = await q.get('SELECT id,value_kind FROM it_inspection_sheet_items WHERE id=? AND sheet_id=?', [targetId, n]);
          if (!targetItem || targetItem.value_kind !== 'check') throw bad('检查项不属于本单或不是勾选类');
        }
        if (await effectivePhotoCount(q,n,b.slot,targetId,req.user.id) >= PHOTO_LIMIT) throw error(409,'SHEET_PHOTO_LIMIT','每个附件位置最多10张图片，请先移除图片再添加');
        const duplicateOf = await findDuplicateMatches(q, req.user, n, sha256);
        const now = new Date().toISOString();
        if (sheet.status === 'draft') {
          const insId = await insertPhotoRow(q, { sheetId: n, slot: b.slot, targetId, name, storedName: req.file.filename, mime, size: req.file.size, sha256, userId: req.user.id, now, state: 'active' });
          return { photo: await photoRowView(q, insId), duplicate_of: duplicateOf };
        }
        const insId = await insertPhotoRow(q, { sheetId: n, slot: b.slot, targetId, name, storedName: req.file.filename, mime, size: req.file.size, sha256, userId: req.user.id, now, state: 'pending', pendingBy: req.user.id });
        return { photo: await photoRowView(q, insId), duplicate_of: duplicateOf };
      });
      // C2b 修复（主会话验收发现）：saved 必须在 withWrite 成功返回(真正 COMMIT 过)之后才置位。
      // 之前在回调里提前置 true——withWrite 的 COMMIT 在回调返回之后才执行（index.js 的
      // withWrite：`result = await fn(q)` 先跑完回调，随后才 `await dbRunOn(conn,'COMMIT')`），
      // COMMIT 失败时会显式 execRollback 把回调里刚插入的照片行撤销，但那时 saved 已经是 true，
      // finally 会误以为文件已经安全入库而不清理——文件既不立即删除也不进清理队列，只能等下一次
      // 进程重启的目录对账兜底。改为 withWrite 调用本身成功返回后才置位，回调内部不再摸 saved。
      saved = true;
      res.status(201).json(result);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) {
      // §2.6 规则二：未入库的上传文件——写事务失败（含内容校验失败，此时根本没进 withWrite）时，
      // 请求结束前立即 unlink；失败再退避到 queueUploadAborted；这两步都在独立顶层函数里，不影响
      // 本路由的 AST withWrite 计数。C2b：改在 handleErr(res,e) 之前做（原先是 finally 块，在
      // catch 之后才跑）——finally 里的清理虽然逻辑上不影响响应内容，但它是在 res.json/res.status
      // 已经把响应字节写进 socket 之后才继续执行的异步延续；客户端收到响应这件事只取决于字节何时
      // 到达 socket，不等这条请求自己的 JS 调用栈真正跑完，会出现"客户端已经拿到响应，但清理队列
      // 还没来得及写入"的可观测窗口（本函数唯一会让 saved 保持 false 的路径就是这个 catch 分支，
      // 见上面"saved 必须在 withWrite 成功返回之后才置位"那条注释——所以把清理挪到 handleErr 前面
      // 不会漏掉任何原本该清理的场景，只是让"清理完成"严格先于"响应发出"，不再需要靠巧合的事件
      // 循环调度顺序侥幸不出现竞态）。
      if (req.file && !saved) await cleanupAbortedUpload(req.file.filename);
      handleErr(res, e);
    }
  });

  router.delete('/:id/photos/:photoId', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const photoId = id(req.params.photoId);
      const options = input(req.body || {}, ['undo_removal']);
      if (Object.hasOwn(options,'undo_removal') && options.undo_removal !== true) throw bad('撤销移除参数无效');
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) !== 'full') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以删除照片');
        if (sheet.status !== 'draft' && sheet.status !== 'submitted') throw error(409, 'SHEET_STATE', '当前状态不允许删除照片');
        await ensurePhotoCollections(q);
        const photo = await q.get('SELECT * FROM it_inspection_sheet_photos WHERE id=? AND sheet_id=?', [photoId, n]);
        if (!photo) throw photoNotFound();
        if (sheet.status === 'draft') {
          if (options.undo_removal) throw bad('草稿照片移除后不可撤销');
          if (photo.state !== 'active') throw photoNotFound();
          await discardPhotoRow(q, photo, 'draft_removed');
        } else {
          if (photo.state === 'active') {
            if (options.undo_removal) {
              const removing = await q.get('SELECT photo_id FROM it_inspection_photo_removals WHERE sheet_id=? AND photo_id=? AND pending_by=?', [n,photoId,req.user.id]);
              if (removing && await effectivePhotoCount(q,n,photo.slot,photo.target_id,req.user.id) >= PHOTO_LIMIT) throw error(409,'SHEET_PHOTO_LIMIT','撤销后将超过10张，请先移除新增图片');
              await q.run('DELETE FROM it_inspection_photo_removals WHERE sheet_id=? AND photo_id=? AND pending_by=?', [n,photoId,req.user.id]);
            }
            else await q.run('INSERT OR IGNORE INTO it_inspection_photo_removals(sheet_id,photo_id,pending_by,created_at) VALUES(?,?,?,?)', [n,photoId,req.user.id,new Date().toISOString()]);
          } else {
            if (options.undo_removal || photo.state !== 'pending' || photo.pending_by !== req.user.id) throw photoNotFound();
            await discardPhotoRow(q, photo, 'pending_discarded');
          }
        }
        return { ok: true };
      });
      res.json(result);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.delete('/:id/pending-photos', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) !== 'full') throw notFound();
        if (sheet.deleted_at) throw notFound();
        if (!isManager(req.user, sheet)) throw forbidden('只有巡检人或管理员可以放弃修改');
        if (sheet.status !== 'submitted') throw error(409, 'SHEET_STATE', '当前状态没有待生效照片');
        const rows = await q.all("SELECT * FROM it_inspection_sheet_photos WHERE sheet_id=? AND state='pending' AND pending_by=?", [n, req.user.id]);
        for (const row of rows) await discardPhotoRow(q, row, 'pending_discarded');
        const removedChanges = await clearPhotoRemovals(q,n,req.user.id);
        return { discarded: rows.length, discarded_removals: removedChanges };
      });
      res.json(result);
      processCleanupQueueBestEffort(); // C2c M1：响应发出之后顺带处理，不让本次请求等这把锁
    } catch (e) { handleErr(res, e); }
  });

  router.get('/:id/photos/:photoId/content', async (req, res) => {
    try {
      const n = id(req.params.id);
      const photoId = id(req.params.photoId);
      const photo = await withRead(async (q) => {
        await canRead(q, req.user);
        if (!(await exists(q))) throw notFound();
        const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [n]);
        if (!sheet || sheetVisibility(req.user, sheet) !== 'full') throw notFound();
        const row = await q.get('SELECT * FROM it_inspection_sheet_photos WHERE id=? AND sheet_id=?', [photoId, n]);
        if (!row) throw photoNotFound();
        if (row.state === 'pending' && row.pending_by !== req.user.id) throw photoNotFound();
        return row;
      });
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': photo.mime });
      res.download(photoFiles.safeFilePath(storageDir, photo.stored_name), photo.original_name, (e) => { if (e && !res.headersSent) handleErr(res, photoNotFound('照片文件暂不可用')); });
    } catch (e) { handleErr(res, e); }
  });

  // ============================================================
  // 八、采集路由（方案 §5.4，C3；G1A 改白名单硬门后重写）
  // ============================================================
  // 采集流程天然跨两个写事务（第一个判资格→锁外调用采集器→第二个复核并落库，方案 §5.4 第二条）。
  // G1A 之前的实现为了绕开旧的"每写路由恰1处withWrite"静态守卫，把第一阶段判资格的逻辑塞进一个
  // 独立顶层函数（不占路由的 withWrite 计数），但那样做又撞上另一条旧守卫（"白名单顶层函数体内不
  // 得读 it_inspection_sheets 主表"），两条守卫互相打架，逼出了"第一阶段根本不判单据状态/归属/
  // 可见性、只判检查项与资产资格"的实现形状——代价是对无权限/非draft的单也会先白跑一次远程采集才
  // 被第二阶段拒绝（P5、37S H1，已被 G1 用户裁定要求改掉）。
  //
  // G1=A 改法：静态守卫本身从"逐条列举绕过写法"改成"只放行已知写法"（白名单硬门，见
  // verify-it-ledger-inspection-sheets.js 的 runSheetRouteGuard），并显式允许"一条写路由处理器体内
  // 恰有2处withWrite"这个新形状（采集路由专属）。这样第一、第二阶段可以共用同一组判定函数——它们
  // 只在写路由的 withWrite 回调内被调用，天然落在事务里。
  // 订正（L1，G2A2b）：本段原文声称"静态守卫的锁外白名单只覆盖写路由处理器的锁外调用，锁内调用不
  // 受那条约束限制"——这条"锁外白名单"（旧 R3）已在 G2A2 整体删除，静态守卫现在只做不涉及绑定/
  // 数据流分析的结构核对（R1/R2/R5/R6/R7/R8/R9），不再对"锁内调用哪些函数"有任何约束；"写路由锁外
  // 不读库"这条性质改由运行时探针（routes/it-ledger/index.js 的 probeSql）在测试模式下保证——两个
  // 判定函数只在 withWrite 回调内被调用这件事，现在是被探针的"事务内 SQL 不计违规"这条判据自然
  // 覆盖，不是被某条静态白名单覆盖。于是仍可以老老实实按 PUT /:id 同款判定顺序、同款拒绝码（写权限
  // 403→单据存在且可见且未删除404→归属403→状态draft409 SHEET_STATE→检查项存在且属device段404
  // SHEET_ITEM_NOT_FOUND→资产可采集409）在两个阶段各判一遍，任一不满足都不发起/不采信远程采集，
  // 不再有"白跑一次采集"的残留副作用。
  //
  // G1A-b（M6）：单据/归属/状态/检查项判定（checkSheetAndItem）与资产资格判定（
  // assertCollectableAsset）拆成两个函数，不再合并成一个 checkCollectable——合并版在第二阶段会先
  // 判资产资格、再比对 target_id，若锁外窗口内该行被改指向一台"不可采集"的资产，会先被资产资格
  // 判定挡下报 409 SHEET_STATE，掩盖了更具体的"检查项已指向另一台资产"这个原因（该报 409
  // SHEET_COLLECT_CONFLICT，更具体的原因优先）；而且第二阶段这样会对新资产调用两次 target()（一次
  // 在旧 checkCollectable 里、一次在 reverifyTarget 里）。拆开后第二阶段只调用 checkSheetAndItem
  // （不碰资产资格），先比对 target_id，只有没变才走 reverifyTarget（内部才调用一次 target()）。
  async function checkSheetAndItem(q, user, sheetId, itemId) {
    if (!(await exists(q))) throw notFound();
    const sheet = await q.get('SELECT * FROM it_inspection_sheets WHERE id=?', [sheetId]);
    if (!sheet || sheetVisibility(user, sheet) === 'none') throw notFound();
    if (sheet.deleted_at) throw notFound();
    if (!isManager(user, sheet)) throw forbidden('只有巡检人或管理员可以采集');
    if (sheet.status !== 'draft') throw error(409, 'SHEET_STATE', '当前状态不允许采集');
    const item = await q.get("SELECT * FROM it_inspection_sheet_items WHERE id=? AND sheet_id=? AND section='device'", [itemId, sheetId]);
    if (!item) throw error(404, 'SHEET_ITEM_NOT_FOUND', '检查项不存在');
    return { sheet, item };
  }
  // 资产资格判定复用 target()——它自己认得出的业务错误（400/404/409，如资产不合格、未登记序列号）
  // 统一映射成 409 SHEET_STATE，不把内部故障伪装成业务拒绝。G1A-b（L5）：message 带上原始原因（
  // 如"须登记序列号以核对身份"这类可操作提示不能被笼统文案吞掉）。只在第一阶段使用——第二阶段的
  // 资产复核走 reverifyTarget（先比对 target_id，见下方路由代码），不重复调用本函数。
  async function assertCollectableAsset(q, targetId) {
    try {
      return await collect.target(q, targetId);
    } catch (e) {
      if (e && [400, 404, 409].includes(e.status)) throw error(409, 'SHEET_STATE', '设备当前不满足采集条件：' + e.message);
      throw e;
    }
  }

  router.post('/:id/items/:itemId/collect', requireLedgerWrite, async (req, res) => {
    try {
      const n = id(req.params.id);
      const itemId = id(req.params.itemId);
      const { asset } = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        const { item } = await checkSheetAndItem(q, req.user, n, itemId);
        const asset = await assertCollectableAsset(q, item.target_id);
        return { asset };
      });
      // 锁外：collectSnapshot 内部按 host 的单飞集合（原与服务器单独采集共用同一份、不形成两把锁，
      // C7 单独设备巡检退役后那个采集入口已删，现在只有本路由在用这份集合，实现不变）+
      // 调用采集器，慢的是这一步，绝不能夹在两个写事务之间持锁做（方案 §5.1 明文）。
      const snapshot = await collect.collectSnapshot(asset);
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        // 第二阶段：与第一阶段完全同一组判定（写权限已由本行 assertWrite 判过——G1A-b：现由
        // checkSheetAndItem 承担单据/归属/状态/检查项判定，不再含资产资格），兼顾方案 §5.1/§5.4
        // 要求的"锁外窗口内状态变化必须拦下"——无论是从一开始就不满足、还是采集期间才变得不满足，
        // 这里重新判一遍都会拦下，不落库。
        const { item: freshItem } = await checkSheetAndItem(q, req.user, n, itemId);
        // C3c H2（codex 37S/37T，保持现有代码）：这一行此刻仍须指向第一阶段判过资格的那台资产——
        // 锁外窗口内，这一行的 target_id 可能被改指向另一台"序列号和host都相同"的资产（例如误操作
        // 把两台设备的登记对调），reverifyTarget 只核对 sn+host 是否一致，两台资产若恰好同 sn 同
        // host（本不该发生，但写路径不能假设它不会发生）会被误判成"同一台"，快照就会挂错资产。
        // G1A-b（M6）：这一步必须排在资产资格判定之前——若排在后面，锁外窗口内把该行改指向一台
        // "不可采集"的资产会先被资产资格判定（SHEET_STATE）挡下，掩盖了这里本该给出的更具体的
        // SHEET_COLLECT_CONFLICT；这一步本身也不需要再判资产资格（那是下面 reverifyTarget 的职责，
        // 不重复调用 target()）。G1A 追加：本单据采集路由内用专属 code SHEET_COLLECT_CONFLICT，不
        // 复用裸 VERSION_CONFLICT——那个 code 与前端全局错误表（it-ledger.js:16）里资产台账主体的
        // VERSION_CONFLICT 撞名，文案"资料已被其他操作更新…"且 formError 会触发 modalStale+refresh
        // 特判，语义与本路由完全不同，不能共用同一个 code（不进 reverifyTarget，不落库）。
        if (freshItem.target_id !== asset.id) throw error(409, 'SHEET_COLLECT_CONFLICT', '检查项在采集期间已指向另一台资产，请重新采集');
        // 资产资格与身份（sn+host）复核——采集期间资产可能被改为非在用，或换了另一台设备接同一个
        // host；两者都必须整体判失败，不落库（方案 §5.1/§5.4）。L1：改调用 inspection-collect.js
        // 的 reverifyTarget（原样重新判资格+核对身份），不再自己内联一份同样的逻辑；不改
        // inspection-collect.js 本身——G1A 当时只改本路由这一处消费点，刻意不动服务器单独采集路由
        // （inspections.js）是因为那边前端仍依赖裸 VERSION_CONFLICT；C7 已把那条路由整体退役，这层
        // 顾虑现已不存在，reverifyTarget 目前只被本路由调用。
        let current;
        try {
          current = await collect.reverifyTarget(q, freshItem.target_id, asset);
        } catch (e) {
          // M2：reverifyTarget 自己的身份不一致判定——原始 code 是裸 VERSION_CONFLICT（同上，与
          // 资产台账主体撞名），本路由内映射成专属 SHEET_COLLECT_CONFLICT 再抛出，不是"原样抛出"；
          // target()/assertActive() 自己认得出的业务错误（400/404/409，如资产不合格）映射成统一的
          // 409 SHEET_STATE；没有 status 或状态码不在这个集合里的意外错误（比如采集器本身的内部
          // 故障）原样抛出，不能被这里悄悄降级成看似"正常拒绝"的 409，那样会把真正的内部故障伪装成
          // 用户可理解的业务拒绝。
          if (e && e.code === 'VERSION_CONFLICT') throw error(409, 'SHEET_COLLECT_CONFLICT', '设备身份在采集期间发生变化，请重新采集');
          if (e && [400, 404, 409].includes(e.status)) throw error(409, 'SHEET_STATE', '设备已不满足采集条件，请重新采集');
          throw e;
        }
        await collect.ensure(q);
        await collect.ensureDeviceInspectionColumns(q);
        const saved = await q.run(
          'INSERT INTO it_device_inspections(asset_id,asset_name,source_host,started_at,completed_at,collection_status,snapshot_json,requested_by,sheet_id) VALUES(?,?,?,?,?,?,?,?,?)',
          [current.id, current.name, current.host, snapshot.started_at, snapshot.completed_at, snapshot.collection_status, JSON.stringify(snapshot), req.user.id, n]
        );
        const newInspectionId = saved.lastID;
        // 该行已关联旧采集：旧记录解除归属（sheet_id 置空、detached_from_sheet_id 置为本单），
        // 33号H1/M3、方案§5.4第三条——同一事务内做，不留"新记录已插入但旧记录还挂着sheet_id"的窗口。
        if (freshItem.device_inspection_id) {
          await q.run('UPDATE it_device_inspections SET sheet_id=NULL, detached_from_sheet_id=? WHERE id=?', [n, freshItem.device_inspection_id]);
        }
        await q.run('UPDATE it_inspection_sheet_items SET device_inspection_id=? WHERE id=?', [newInspectionId, itemId]);
        const inspectionRow = await q.get('SELECT * FROM it_device_inspections WHERE id=?', [newInspectionId]);
        const itemRow = await q.get('SELECT * FROM it_inspection_sheet_items WHERE id=?', [itemId]);
        return { inspectionRow, itemRow };
      });
      // 非管理员过 stripFinance（原与服务器单独采集响应整形一致，C7 已退役那条路由，现在这条规则
      // 只在本路由生效）。不带、不改单据版本（方案 §5.1）。
      res.status(201).json({
        inspection: req.user.role === 'admin' ? collect.view(result.inspectionRow) : stripFinance(collect.view(result.inspectionRow)),
        item: result.itemRow,
      });
      processCleanupQueueBestEffort(); // L7：响应发出之后顺带处理，不让本次请求等这把锁（同其余9个写路由）。
    } catch (e) { handleErr(res, e); }
  });

  return { router, sheetActions, sheetVisibility, sheetProgress, processCleanupQueue };
};
