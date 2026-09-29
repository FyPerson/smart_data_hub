'use strict';
// routes/it-ledger/inspection-photo-files.js — 巡检台账照片：文件校验、落盘、清理、目录对账
//   （长任务 E · C2）。方案 SSOT = docs/local/信息化资产_轻量版/巡检台账改版_方案_20260923_v0.4.md
//   §2.3、§2.6、§5.2、§5.6。
//
// 只服务图片（jpg/jpeg/png/webp，方案 §2.3）。魔数判定与文件名净化的写法从 inspections.js:55-62、
//   75-76 复制而非引用——那个模块的类型表覆盖音视频/PDF、大小上限也不同（200MiB vs 本模块 20MiB），
//   两个白名单独立演进，不互相牵连。
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const MAX_SIZE = 20 * 1024 * 1024; // 20 MiB（方案 §2.3）
const STORED_NAME_RE = /^[0-9a-f-]{36}\.bin$/; // 与 inspections.js:66 同写法（复制）
const RECONCILE_STALE_MS = 60 * 60 * 1000; // 1 小时门槛（方案 §2.6，辅助保护）

// 复制自 inspections.js:55-61（matches），子集为 jpg/jpeg/png/webp。
function matchesMagic(ext, b) {
  const ascii = (a, z) => b.toString('ascii', a, z);
  switch (ext) {
    case 'jpg': case 'jpeg': return b.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case 'png': return b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'webp': return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    default: return false;
  }
}

// 复制自 inspections.js:75-76（文件名解码 + 净化）。
function sanitizeOriginalName(rawName) {
  let name = rawName || '';
  if (!/[^\u0000-ÿ]/.test(name)) {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (!decoded.includes('�')) name = decoded;
  }
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  return name;
}

// 复制自 inspections.js:66（filePath）——按 stored_name 解析绝对路径前必须先过正则，
//   防止路径穿越（../../etc/passwd 一类）。
function safeFilePath(storageDir, storedName) {
  if (!STORED_NAME_RE.test(storedName)) { const e = new Error('照片存储编号无效'); e.status = 500; e.code = 'SHEET_PHOTO_STORAGE'; throw e; }
  return path.join(storageDir, storedName);
}

// 复制自 inspections.js:67（removeFile）——ENOENT 视为成功（文件本就不在，目标已达成）。
async function removeStoredFile(storageDir, storedName) {
  try { await fsp.unlink(safeFilePath(storageDir, storedName)); return true; }
  catch (e) { if (e.code === 'ENOENT') return true; return false; }
}

// 复制自 inspections.js:63（upload），限制改为单图片、20MiB（+1 让 multer 的硬限制略宽于业务
//   校验，精确的「超过20MiB」提示由 validateUploadedFile 给，不依赖 multer 的错误信息）。
function createUpload(storageDir) {
  return multer({
    storage: multer.diskStorage({
      destination(req, file, cb) { fsp.mkdir(storageDir, { recursive: true }).then(() => cb(null, storageDir), cb); },
      filename(req, file, cb) { cb(null, crypto.randomUUID() + '.bin'); },
    }),
    limits: { fileSize: MAX_SIZE + 1, files: 1, fields: 2, fieldSize: 8000, parts: 4 },
  }).single('file');
}

// 复制自 inspections.js:64（receive）——把 multer 的回调式接口包成 Promise。
function receiveUpload(upload) {
  return (req, res) => new Promise((resolve, reject) => {
    upload(req, res, (e) => (e
      ? reject(Object.assign(new Error(e.code === 'LIMIT_FILE_SIZE' ? '照片不能超过20 MiB' : '上传失败：只允许一个文件及 slot、target_id 字段'), { status: 400, code: 'LEDGER_BAD_REQUEST' }))
      : resolve()));
  });
}

// 类型（扩展名+魔数）、空文件、大小校验，返回净化后的文件名/扩展名/mime/sha256。
//   顺序：扩展名 → 空文件 → 大小 → 魔数（与 inspections.js 的既有顺序一致）。
async function validateUploadedFile(file) {
  const name = sanitizeOriginalName(file.originalname);
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = IMAGE_TYPES[ext];
  if (!mime) { const e = new Error('只支持 jpg/jpeg/png/webp 格式的图片'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e; }
  if (!file.size) { const e = new Error('不能上传空文件'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e; }
  if (file.size > MAX_SIZE) { const e = new Error('照片不能超过20 MiB'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e; }
  const fd = await fsp.open(file.path, 'r');
  let bytes;
  try { const buf = Buffer.alloc(32); const r = await fd.read(buf, 0, 32, 0); bytes = buf.subarray(0, r.bytesRead); }
  finally { await fd.close(); }
  if (!matchesMagic(ext, bytes)) { const e = new Error('文件内容与扩展名不匹配'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e; }
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk);
  const sha256 = hash.digest('hex');
  return { name, ext, mime, sha256 };
}

function dbAllRaw(db, sql, params) {
  return new Promise((resolve, reject) => { db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows))); });
}

// C2c M2：对账耗时要计入启动预算——deadlineTs（来自 runLifecycleInit 的同一个软预算）传进来，
//   循环里每处理一个候选前都检查剩余时间；不足 RECONCILE_MIN_REMAINING_MS（5秒）就停止并 warn，
//   绝不为了扫完目录拖垮初始化发布。批量归属判定也从"每个候选发2次SQL"改成"先一次性把两张表的
//   全部 stored_name 读进 Set"，减少候选多时的DB往返（Set 命中的候选直接跳过，连"删除前复核"
//   都不用做——真正会走到复核+unlink 的只有 Set 未命中的那一小撮）。
const RECONCILE_MIN_REMAINING_MS = 5000;

// 目录对账（方案 §2.6、33-R2 M1）：只应由调用方（index.js 的 runLifecycleInit）在进程首次初始化、
//   标记就绪之前调用恰好一次；本函数自身不做"只跑一次"的把关（那是调用方的职责，见 index.js
//   的 isStartup 参数 + 模块级一次性标记），只负责"跑起来绝不抛出、绝不误删有主文件"。
//   db：尚未发布为 itDb 的原生 sqlite3.Database 连接（此刻请求层的 requireLedgerReady 挡住一切
//   请求，不存在与本函数并发的正常写入）。deadlineTs：可选，传了就参与预算判断；不传视为不设限
//   （供旧调用方/测试直接调用时兼容，生产路径 index.js 恒会传）。
async function reconcilePhotoDirectoryOnce({ db, storageDir, logger, deadlineTs, now: nowFn }) {
  const log = logger || console;
  // C2e-3：仅测试可用的时钟注入——now 参数默认 Date.now，只从调用方（index.js 的
  //   deps.inspectionSheetReconcileNow）传入才会换成别的实现；生产路径恒为 undefined，落回真实
  //   Date.now，语义与之前完全一致。
  const clock = nowFn || Date.now;
  // C2e-2：readdir 一次性把整个目录读进内存再逐项处理，本身就是一段不受预算约束的耗时——目录项
  //   数量不受控时，仅仅是"把 entries 数组建出来"这一步就可能拖垮启动预算。改用 fsp.opendir 做
  //   真正的逐项流式迭代（for await...of 在提前 break 时会自动关闭底层目录句柄，见 Node 文档），
  //   让下面同一个 deadlineTs 检查在"读到第几项"这个粒度上就能生效，不必等整个目录读完。
  let dir;
  try {
    dir = await fsp.opendir(storageDir);
  } catch (e) {
    if (e.code === 'ENOENT') return { skipped: true, reason: 'dir_missing' };
    log.warn(`[it-ledger] 巡检照片目录对账：读取目录失败(不影响初始化，跳过本次对账): ${e.message}`);
    return { skipped: true, reason: 'readdir_failed' };
  }
  const candidates = [];
  const nowSnapshot = clock();
  let statStoppedEarly = false;
  try {
    // C2d S-M（本轮 C2e-2 改用 opendir 逐项迭代承接同一条不变量）：逐个目录项前都检查剩余时间，
    //   不足就停止并 warn（与下面几个阶段用同一个 RECONCILE_MIN_REMAINING_MS 门槛，语义一致——
    //   "对账没跑完，下次启动继续"）。
    for await (const ent of dir) {
      if (deadlineTs && deadlineTs - clock() < RECONCILE_MIN_REMAINING_MS) {
        statStoppedEarly = true;
        log.warn('[it-ledger] 巡检照片目录对账未完成(启动预算剩余不足5秒，readdir/stat阶段)，下次启动继续');
        break;
      }
      if (!ent.isFile || !ent.isFile() || !STORED_NAME_RE.test(ent.name)) continue;
      let stat;
      try { stat = await fsp.stat(path.join(storageDir, ent.name)); } catch (_statErr) { continue; }
      if (nowSnapshot - stat.mtimeMs < RECONCILE_STALE_MS) continue; // 1小时门槛：辅助保护，避免误删在途文件
      candidates.push(ent.name);
    }
  } catch (e) {
    log.warn(`[it-ledger] 巡检照片目录对账：opendir逐项迭代出错(不影响初始化，跳过本次对账): ${e.message}`);
    return { skipped: true, reason: 'opendir_iter_failed' };
  }
  if (!candidates.length) return { deleted: 0, checked: 0, stoppedEarly: statStoppedEarly };

  // C2e-2：两表名单查询前也检查一次剩余预算——不足就直接停止，连这两条SELECT都不发。
  if (deadlineTs && deadlineTs - clock() < RECONCILE_MIN_REMAINING_MS) {
    log.warn('[it-ledger] 巡检照片目录对账未完成(启动预算剩余不足5秒，名单查询阶段)，下次启动继续');
    return { deleted: 0, checked: candidates.length, stoppedEarly: true };
  }

  let tableRows;
  try {
    tableRows = await dbAllRaw(db, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('it_inspection_sheet_photos','it_inspection_file_cleanup')");
  } catch (e) {
    log.warn(`[it-ledger] 巡检照片目录对账：查询表结构失败(不影响初始化，跳过本次对账): ${e.message}`);
    return { skipped: true, reason: 'schema_query_failed' };
  }
  const tableNames = new Set((tableRows || []).map((r) => r.name));
  const photosTableExists = tableNames.has('it_inspection_sheet_photos');
  const cleanupTableExists = tableNames.has('it_inspection_file_cleanup');

  // 先一次性把两张表的全部 stored_name 读进一个 Set（各一条 SELECT，不按候选数量翻倍）。
  const ownedNames = new Set();
  try {
    if (photosTableExists) { const rows = await dbAllRaw(db, 'SELECT stored_name FROM it_inspection_sheet_photos'); for (const r of rows) ownedNames.add(r.stored_name); }
    if (cleanupTableExists) { const rows = await dbAllRaw(db, 'SELECT stored_name FROM it_inspection_file_cleanup'); for (const r of rows) ownedNames.add(r.stored_name); }
  } catch (e) {
    log.warn(`[it-ledger] 巡检照片目录对账：批量读取归属集合失败(不影响初始化，跳过本次对账): ${e.message}`);
    return { skipped: true, reason: 'owned_set_query_failed' };
  }

  let deleted = 0;
  let stoppedEarly = false;
  for (const storedName of candidates) {
    if (deadlineTs && deadlineTs - clock() < RECONCILE_MIN_REMAINING_MS) {
      stoppedEarly = true;
      log.warn('[it-ledger] 巡检照片目录对账未完成(启动预算剩余不足5秒，unlink阶段)，下次启动继续');
      break;
    }
    if (ownedNames.has(storedName)) continue; // 批量集合已经判定有主，跳过——连复核查询都不用发。
    try {
      // 删除前再复核一次——批量集合是本次对账开始时的快照，这里针对 Set 未命中的候选单独再查一次
      // 两张表（不是重新查全表，只查这一个 stored_name），防止"批量读取之后、真正删除之前"这段
      // 极短窗口内又有了归属（初始化期间理论上不会有并发写，这层复核是纵深防御，不是应对已知场景）。
      let owned = false;
      if (photosTableExists) {
        const rows = await dbAllRaw(db, 'SELECT 1 v FROM it_inspection_sheet_photos WHERE stored_name=? LIMIT 1', [storedName]);
        if (rows.length) owned = true;
      }
      if (!owned && cleanupTableExists) {
        const rows = await dbAllRaw(db, 'SELECT 1 v FROM it_inspection_file_cleanup WHERE stored_name=? LIMIT 1', [storedName]);
        if (rows.length) owned = true;
      }
      if (owned) continue;
      const ok = await removeStoredFile(storageDir, storedName);
      if (ok) { deleted++; log.info(`[it-ledger] 巡检照片目录对账：已删除无主文件 ${storedName}`); }
      else log.warn(`[it-ledger] 巡检照片目录对账：删除无主文件失败 ${storedName}`);
    } catch (e) {
      log.warn(`[it-ledger] 巡检照片目录对账：处理文件 ${storedName} 时出错(不影响初始化): ${e.message}`);
    }
  }
  return { deleted, checked: candidates.length, stoppedEarly: stoppedEarly || statStoppedEarly };
}

module.exports = {
  IMAGE_TYPES, MAX_SIZE, STORED_NAME_RE, RECONCILE_STALE_MS,
  matchesMagic, sanitizeOriginalName, safeFilePath, removeStoredFile,
  createUpload, receiveUpload, validateUploadedFile,
  reconcilePhotoDirectoryOnce,
};
