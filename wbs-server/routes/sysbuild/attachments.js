// routes/sysbuild/attachments.js — 项目管理（系统建设记录）模块：附件端点与事务内助手（C1c）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §5（权限）、§7（附件端点）、§10.3（附件）。
//   派单说明 = docs/local/系统建设记录/送审准备/C1c_附件_派单说明_20261028.md。
//
// 工厂 createAttachmentRoutes(ctx) 返回 { router, helpers, _internals }。ctx：
//   { db, logger, UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync, COLLAB_ALLOWED_EXTS_UNION,
//     readonlyIds, nowProvider, enableTestHooks }
//   readonlyIds 必填（数组或 Set，只读账号 id 集合）；缺失或类型不对工厂直接抛错，不回落为空集合。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置，这里不再挂。
//
// ── 已落盘文件的删除只有一条路：deleteUploadIfUnreferenced（本文件里 safeDeleteFileSync 唯一的调用点）──
//   09-R2 用户拍板方案 A：事务结果的推断（db.js 的 txnOutcome）只是参考标注，不是删文件的依据。
//   五条验收条件（09-R3）与实现位置：
//     1. 只在原 withWriteTxn 调用完全结束（await 落定，成败不论）之后调用——stageHandler 的 try/catch 之后；
//     2. 文件名由服务端生成且唯一（时间戳 + crypto.randomBytes(12) 十六进制 + 截断原名，并以 'wx' 独占创建保证不覆盖），
//        回读之后无任何代码路径再写入引用它的记录；
//     3. 回读用 db.withRead，SELECT COUNT(*) … WHERE file_name = ?，任何一行都算引用（不论软删除 / 遮蔽 / 是否绑定）；
//     4. 只有查询成功、行格式正确且 n === 0 才删；查询抛错 / 结果缺失 / 格式异常一律保留并记「孤儿文件待人工核对」；
//     5. 查询与删除用同一个变量 fileRelPath，进入事务阶段的失败清理入口（头部校验失败、事务失败、事务后失败）
//        都走这一个函数。multer 自己报错时（发生在进入事务之前，不可能有记录引用该文件），multer 回调本文件
//        存储引擎（stageStorage）的 _removeFile，它只删「本引擎独占创建的路径」（见该引擎的不变量 I1–I3）；
//        runUpload 里的 leftover 分支只是兜底（req.file 仍在、且路径仍归本请求所有时），同样走这一个函数，
//        免得出现第二个按名字删文件的点；引擎已经删过的路径它不再处理（避免二次删除别人复用的同名文件）。
//        （引擎的 unlink 只作用于它自己 openSync(…,'wx') 成功创建的路径，不是「按库里的名字删文件」。）
//   孤儿文件口径：磁盘上有文件、库里没有任何 file_name 等于它的行。出现原因是回读失败（模块故障 / 等锁超时 /
//   结果异常）而保守保留，日志「孤儿文件待人工核对：<完整路径>」，按记录核对后人工处理。
'use strict';
const visibility = require('./membership-visibility');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');

const MAX_FILE_BYTES = 200 * 1024 * 1024;           // 单文件上限（沿用零星事项 / issue_lite 规格）
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;           // 识别为图片时的上限
const ORIGINAL_NAME_MAX_CODEPOINTS = 200;           // 原文件名上限（按码点；超出拒绝，不截断原名字段）
const DISK_NAME_MAX_CODEPOINTS = 60;                // 落盘名里原名片段的截断长度
const STAGE_TTL_MS = 24 * 3600 * 1000;              // 暂存后 24 小时内可绑定
const MASK_REASON_MAX = 500;
const EXTRA_EXTS = ['.zip', '.rar', '.7z'];

const STAGE_NAME_ATTEMPTS = 5;                      // 暂存文件名撞名（EEXIST）后最多重新起名的次数

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const IMAGE_EXT_MIME = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
});

// ── 纯函数 ────────────────────────────────────────────────────────────────────────────
// 读文件头识别真实图片类型；识别不了返回 null。
function sniffImageType(head) {
  if (!Buffer.isBuffer(head)) return null;
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'image/jpeg';
  if (head.length >= 6) {
    const g = head.subarray(0, 6).toString('latin1');
    if (g === 'GIF87a' || g === 'GIF89a') return 'image/gif';
  }
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

// multer（busboy）对普通 filename= 参数按 latin1 解出原始字节；浏览器发的是 UTF-8 字节，需要还原。
//   但 filename*=UTF-8''… 形式 busboy 已按 UTF-8 解好，其中 é（U+00E9）这类 ≤ 0xFF 的字符再按 latin1 转码会变成乱码，
//   所以只在「所有字符 ≤ 0xFF，且这些字节构成合法 UTF-8，且解码结果与原串不同」时才采用解码结果，否则原样保留。
//   残余歧义：原名本身恰好是一段合法 UTF-8 字节序列的 latin1 写法（如字面量 "Ã©"）会被当作 UTF-8 转码，无法区分。
function decodeOriginalName(name) {
  const s = String(name || '');
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) > 255) return s;
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1'));
  } catch (_) {
    return s;
  }
  return decoded !== s ? decoded : s;
}

// 落盘名里的原名片段：替换路径分隔与 Windows 非法字符及控制字符、按码点截断、去尾部点与空格、空则 file。
//   照 routes/quick-log/index.js:226-229。
function diskSafeName(originalName) {
  return Array.from(String(originalName).replace(/[\\/:*?"<>|\x00-\x1F\x7F]/g, '_')) // eslint-disable-line no-control-regex
    .slice(0, DISK_NAME_MAX_CODEPOINTS).join('').replace(/[. ]+$/, '') || 'file';
}

// RFC 5987：encodeURIComponent 不转义 ! ' ( ) *，补转。
function encodeRfc5987(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Q8（用户裁定 2026-10-29）：附件被遮蔽后，任何接口都不再返回原文件名。原名只留在 sysbuild_attachments.original_name，
//   事件 payload 不写原名；磁盘文件名 file_name（含原名前 60 个码点）同样不得返回客户端（列表 / 详情接口不得选出 file_name 交给前端）。
//   凡是把附件名交给客户端的地方（后续阶段的列表 / 详情接口、下载与预览的文件名头）一律经下面的函数取名：
//   attachmentDisplayName(att)：未遮蔽 → 原名；已遮蔽（masked_at 非空）→ null（调用方自己决定显示什么，不得回退到 original_name）。
//     fail-closed：调用方的 SELECT 必须带 masked_at 列——键不存在或值为 undefined 抛 500，不放行原名；null 视为未遮蔽。
//   maskedFileName(att)（工厂闭包内，要用到上传白名单）：遮蔽后下载 / 预览头里用的替代名 attachment-<id><扩展名>。
function attachmentDisplayName(att) {
  if (!Object.prototype.hasOwnProperty.call(att, 'masked_at') || att.masked_at === undefined) {
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件显示名缺遮蔽状态');
  }
  return att.masked_at ? null : att.original_name;
}
// 记录内附件的统一状态事实；操作者显示名由同一次SELECT关联users取得。此处不授予读写权限。
function attachmentStateFields(att) {
  if (!att) return { missing: true, masked: false, masked_at: null, masked_by: null, masked_by_name: null, mask_reason: null, deleted: false, deleted_at: null, deleted_by: null, deleted_by_name: null };
  for (const key of ['masked_at', 'masked_by', 'mask_reason', 'deleted_at', 'deleted_by']) {
    if (!Object.prototype.hasOwnProperty.call(att, key) || att[key] === undefined) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件状态视图缺必要字段');
  }
  return {
    missing: false, masked: !!att.masked_at, masked_at: att.masked_at, masked_by: att.masked_by, masked_by_name: att.masked_by_name || null, mask_reason: att.mask_reason,
    deleted: !!att.deleted_at, deleted_at: att.deleted_at, deleted_by: att.deleted_by, deleted_by_name: att.deleted_by_name || null,
  };
}

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}

// sqlite 的 datetime('now','localtime') 文本（本地时间）→ Date。
function parseLocalDatetime(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(text || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

function hashFile(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    let size = 0;
    const headParts = [];
    let headLen = 0;
    const s = fs.createReadStream(absPath);
    s.on('data', (chunk) => {
      h.update(chunk);
      size += chunk.length;
      if (headLen < 16) {
        const take = chunk.subarray(0, 16 - headLen);
        headParts.push(take);
        headLen += take.length;
      }
    });
    s.on('error', reject);
    s.on('end', () => resolve({ sha256: h.digest('hex'), size, head: Buffer.concat(headParts) }));
  });
}

function createAttachmentRoutes(ctx) {
  for (const k of ['db', 'logger', 'UPLOAD_DIR', 'normalizeAttachmentExt', 'safeDeleteFileSync', 'COLLAB_ALLOWED_EXTS_UNION']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/attachments 缺参数: ' + k);
  }
  // readonlyIds 必填：缺失会让只读账号静默拥有写权限，所以工厂就拒绝（rules.loadProjectAccess 每次请求再核一次）。
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/attachments 参数 readonlyIds 必须是数组或 Set');
  }
  const { db, logger, UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync } = ctx;
  const nowProvider = typeof ctx.nowProvider === 'function' ? ctx.nowProvider : () => new Date();
  const TEST_HOOKS_ENABLED = ctx.enableTestHooks === true;
  const ALLOWED_EXTS = new Set([...ctx.COLLAB_ALLOWED_EXTS_UNION, ...EXTRA_EXTS]);
  const UPLOAD_SUBDIR = path.join(UPLOAD_DIR, 'sysbuild');
  // 遮蔽后的替代文件名。扩展名不取磁盘文件名 file_name（落盘名里的原名片段被截断到 60 码点，截断点落在原名中间的「.」之后时，
  //   「扩展名」会是原名的一段，如手机号前 8 位），而取原名真实扩展名 normalizeAttachmentExt(original_name)（带点、小写），
  //   且必须属于上传白名单 ALLOWED_EXTS 才加，否则不加——白名单是硬门，结果只能是白名单里的词，原名的任何片段都进不来。
  function maskedFileName(att) {
    const ext = normalizeAttachmentExt(att.original_name);
    return `attachment-${att.id}${ALLOWED_EXTS.has(ext) ? ext : ''}`;
  }
  // 下载 / 预览头里用的文件名：未遮蔽用原名，已遮蔽用替代名。
  function dispositionFileName(att) {
    const shown = attachmentDisplayName(att);
    return shown === null ? maskedFileName(att) : shown;
  }
  const router = express.Router();

  // 测试专用钩子（仅 enableTestHooks 时可设置，生产恒为 null）。
  const hooks = { beforeStageTxn: null, afterStageCommit: null, beforeRespond: null, failStageTxn: null, beforeReadback: null, nameGenerator: null, afterRemoveFile: null, beforeOwnershipCheck: null };
  let fileSizeLimit = MAX_FILE_BYTES;

  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds });

  // ── 统一错误出口 ────────────────────────────────────────────────────────────────────
  // 本模块自己的业务错误（带 status + code，code 以 SYSBUILD_ 开头）回 { code, message[, field] }；
  //   其余（驱动错误、Express / send 抛出的带 status 与 code 的系统错误如 EACCES，路径可能在 message 里）
  //   记日志后回 500 SYSBUILD_INTERNAL + 通用文案，不回内部细节。
  //   status >= 500 的 SYSBUILD_ 错误（SYSBUILD_BUSY / UNAVAILABLE 等）原样回，同时记日志。
  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 附件接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});

  // ── 回读门：已落盘文件的唯一删除点（见文件头注）────────────────────────────────────────
  async function deleteUploadIfUnreferenced(fileRelPath) {
    const absForLog = path.join(UPLOAD_DIR, fileRelPath);
    const orphan = (why) => logger.error(`[sysbuild] 孤儿文件待人工核对：${absForLog}（${why}）`);
    try {
      let row;
      try {
        if (hooks.beforeReadback) await hooks.beforeReadback({ fileName: fileRelPath });
        row = await db.withRead((q) => q.get('SELECT COUNT(*) AS n FROM sysbuild_attachments WHERE file_name = ?', [fileRelPath]));
      } catch (err) {
        orphan(`回读失败，无法确认是否被记录引用: ${(err && err.message) || err}`);
        return { deleted: false, reason: 'readback_failed' };
      }
      if (!row || typeof row.n !== 'number' || !Number.isInteger(row.n) || row.n < 0) {
        orphan('回读结果缺失或格式异常');
        return { deleted: false, reason: 'readback_malformed' };
      }
      if (row.n !== 0) {
        logger.warn(`[sysbuild] 上传请求失败但文件已被 ${row.n} 条附件记录引用，保留: ${absForLog}`);
        return { deleted: false, reason: 'referenced' };
      }
      const ok = safeDeleteFileSync(fileRelPath, UPLOAD_DIR);
      if (!ok) logger.warn(`[sysbuild] 未被引用的上传文件删除未成功（可能已不存在）: ${absForLog}`);
      return { deleted: !!ok, reason: 'unreferenced' };
    } catch (err) {
      orphan(`清理过程异常: ${(err && err.message) || err}`);
      return { deleted: false, reason: 'cleanup_error' };
    }
  }

  // ── 暂存上传 ────────────────────────────────────────────────────────────────────────
  // 暂存存储引擎（取代 multer.diskStorage：它的 filename 回调只起名、不保证独占，同名会静默覆盖已有文件）。
  //   不变量：
  //     I1 本引擎创建的每个文件都是 fs.openSync(path, 'wx') 独占创建成功的——绝不覆盖任何已存在的文件
  //        （别的附件、别的请求写了一半的文件都不会被碰）；
  //     I2 'wx' 报 EEXIST 就换名重试，最多 STAGE_NAME_ATTEMPTS 次，耗尽报 500 SYSBUILD_INTERNAL，此时没有创建任何文件；
  //     I3 删除只发生在本引擎自己创建的路径上：独占创建成功后立刻把路径登记进 createdPaths（模块私有集合）；
  //        写失败的清理、multer 调用的 _removeFile 与 runUpload 的 leftover 兜底都只认这个集合——路径不在集合里什么都不删；
  //        集合成员的 delete 是「取得所有权」的唯一动作，引擎清理与 leftover 兜底互斥（谁先 delete 成功谁负责，另一方跳过）。
  //        （不用挂在 multer file 对象上的标记：multer 把 file 与 info 合并成新对象再交给 _removeFile，Symbol 键会丢。）
  //        上传成功交给后续处理后（runUpload 的成功分支）路径移出集合，此后 multer 不会再为它调 _removeFile，
  //        已落盘的文件只由回读门处理。
  //   名字 = <时间戳>_<24 位十六进制随机（crypto.randomBytes(12)）>_<截断原名>；目录 = UPLOAD_DIR/sysbuild/<project_id>/。
  //   已知局限（与 multer.diskStorage 相同）：客户端中途断开且上传流不再结束时，半截文件留在磁盘上、库里没有行
  //   （孤儿口径，人工核对）。
  //   L5：createdPaths 是 路径 → 创建它的 req 的登记表。所有权按请求判定：只有 createdPaths[p] === req 才算本请求拥有，
  //   取得所有权的动作是 `createdPaths[p] === req && delete createdPaths[p]`（同步、无 await，两步之间不会被插入）。
  //   这样即使别的请求复用了同名路径，也不会误删到不属于自己的登记。
  //   实现用 null 原型的普通对象而不是 Map：静态守卫 verify-sysbuild-static.js 的 S5 把 `.get(` 的接收者限定为 q / router
  //   （Map.get 同样判红，不做智能放行），读 Map 值只有 .get；语义与 Map<路径, req> 相同，键只来自服务端生成的落盘路径。
  const createdPaths = Object.create(null);
  function removeCreated(p, req) {
    if (typeof p !== 'string' || !(createdPaths[p] === req && delete createdPaths[p])) return;
    try { fs.unlinkSync(p); } catch (e) { if (!e || e.code !== 'ENOENT') logger.warn(`[sysbuild] 清理本次创建的上传文件失败: ${p} (${e && e.message})`); }
  }
  const stageStorage = {
    _handleFile(req, file, cb) {
      let settled = false;
      const finish = (err, info) => { if (settled) return; settled = true; cb(err, info); };
      const pid = rules.parseId(req.params.id);
      if (!pid) return finish(invalid('项目编号不合法', 'id'));
      const dir = path.join(UPLOAD_SUBDIR, String(pid));
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { return finish(e); }
      let fd = null;
      let name = null;
      for (let attempt = 0; attempt < STAGE_NAME_ATTEMPTS && fd === null; attempt += 1) {
        name = hooks.nameGenerator
          ? hooks.nameGenerator(file.originalname, attempt)
          : `${Date.now()}_${crypto.randomBytes(12).toString('hex')}_${diskSafeName(file.originalname)}`;
        try {
          fd = fs.openSync(path.join(dir, name), 'wx');
        } catch (e) {
          if (!e || e.code !== 'EEXIST') return finish(e);
        }
      }
      if (fd === null) return finish(makeError(500, 'SYSBUILD_INTERNAL', '内部错误：暂存文件名重复'));
      const full = path.join(dir, name);
      createdPaths[full] = req;
      const out = fs.createWriteStream(full, { fd, autoClose: true });
      let size = 0;
      file.stream.on('data', (chunk) => { size += chunk.length; });
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        out.once('close', () => { removeCreated(full, req); finish(err); }); // 先等文件句柄关闭再删（Windows 下否则 EBUSY）
        out.destroy();
      };
      out.on('error', fail);
      file.stream.on('error', fail);
      out.on('finish', () => finish(null, { destination: dir, filename: name, path: full, size }));
      file.stream.pipe(out);
      return undefined;
    },
    _removeFile(req, file, cb) {
      removeCreated(file && file.path, req);
      if (hooks.afterRemoveFile) hooks.afterRemoveFile(file && file.path); // 测试钩子：引擎删除之后、通知 multer 之前（生产恒为 null）
      cb(null);
    },
  };

  function buildUploader() {
    return multer({
      storage: stageStorage,
      limits: { fileSize: fileSizeLimit, files: 1 },
      // fileFilter 自己拒绝的错误带 uploadRejected 标记：runUpload 只对它们（与 MulterError）回 400，
      //   其余（磁盘 EACCES / ENOSPC 等）一律 500。
      fileFilter(req, file, cb) {
        file.originalname = decodeOriginalName(file.originalname);
        // 整个原文件名（不只扩展名）出现控制字符就拒绝：normalizeAttachmentExt 先 trim，
        //   前后的 \r \n \t 会被它吃掉，只靠它挡不住。
        if (/[\x00-\x1F\x7F]/.test(file.originalname)) { // eslint-disable-line no-control-regex
          return cb(invalid('文件名包含非法字符', 'file'));
        }
        if (Array.from(file.originalname).length > ORIGINAL_NAME_MAX_CODEPOINTS) {
          return cb(makeError(400, 'SYSBUILD_FILENAME_TOO_LONG', `文件名过长（上限 ${ORIGINAL_NAME_MAX_CODEPOINTS} 个字符）`));
        }
        const ext = normalizeAttachmentExt(file.originalname);
        if (!ext) return cb(Object.assign(new Error('文件名为空或包含非法字符'), { uploadRejected: true }));
        if (!ALLOWED_EXTS.has(ext)) return cb(Object.assign(new Error(`不支持的扩展名 ${ext}`), { uploadRejected: true }));
        return cb(null, true);
      },
    }).single('file');
  }

  // 预检：通过前不让 multer 落盘（非成员 / 只读账号 / 项目不存在都在这里拒绝）。
  async function stagePrecheck(req, res, next) {
    try {
      const pid = rules.parseId(req.params.id);
      if (!pid) throw invalid('项目编号不合法', 'id');
      await db.withRead(async (q) => {
        const access = await rules.loadProjectAccess(q, pid, req.user, accessOpts());
        rules.assertCan(access, rules.canStageAttachment, { writeKind: 'attachment' }); // 预检
      });
      next();
    } catch (e) {
      sendError(res, e);
    }
  }

  // multer 报错发生在进入事务之前（不可能有记录引用该文件），multer 自己会清掉它写了一半的文件；
  //   这里的 leftover 分支只是兜底，同样走回读门，保持全文件只有一个按名字删文件的点。
  //   leftover 以 createdPaths 归属为前提，与引擎清理互斥：multer 2.x 的 .single 在文件写完后即设 req.file，
  //   之后若再出错（第二个文件 LIMIT_FILE_COUNT、流中断等），abortWithError 会先对已上传文件调 _removeFile
  //   （引擎删一次并把路径移出 createdPaths），req.file 却不会被清。此时路径已不归本请求所有（可能已被别的请求复用），
  //   绝不能再按名字删第二次；只有路径仍在 createdPaths（引擎尚未处理）时，所有权才仍属本请求，才交给回读门。
  //   响应：MulterError 与 fileFilter 自己拒绝的错误回 400；业务错误（SYSBUILD_*）原样回；
  //   其余（磁盘 EACCES / ENOSPC、解析器内部错误等）记日志后 500，不回原始 message。
  function runUpload(req, res, next) {
    buildUploader()(req, res, (err) => {
      if (!err) {
        if (req.file && req.file.path) createdPaths[req.file.path] === req && delete createdPaths[req.file.path]; // 交接：此后已落盘文件只由回读门处理
        return next();
      }
      const pid = rules.parseId(req.params.id);
      const settle = () => {
        // 请求级所有权判定：路径仍登记在 createdPaths 且登记的就是本请求（引擎没处理过），所有权才属本请求。
        //   在 multer 2.0.2 下本分支的 owned=true 不可达：文件写完后的 done(err) 都先经 removeUploadedFiles
        //   （引擎已把路径移出 createdPaths），所以这里恒为 false；保留这一分支只作 multer 版本漂移的兜底。
        const owned = !!(req.file && req.file.path && createdPaths[req.file.path] === req && delete createdPaths[req.file.path]);
        const leftover = owned && req.file.filename && pid ? `sysbuild/${pid}/${req.file.filename}` : null;
        Promise.resolve(leftover ? deleteUploadIfUnreferenced(leftover) : null).then(() => {
          const isMulterErr = err && err.name === 'MulterError';
          if (!isMulterErr && !(err && err.uploadRejected)) return sendError(res, err);
          logger.warn(`[sysbuild] 附件上传被拒绝: ${err.message}`);
          return res.status(400).json({
            code: isMulterErr ? err.code : 'UPLOAD_ERROR',
            message: isMulterErr ? `上传文件失败: ${err.message}` : err.message,
          });
        }).catch((e) => sendError(res, e));
      };
      // 测试钩子（仅 enableTestHooks 可设置，生产恒为 null）：在所有权判定之前 await，让用例确定性地插入「别的请求复用同一路径」的时序。
      //   未设置时同步走原路径。
      if (hooks.beforeOwnershipCheck) {
        Promise.resolve().then(() => hooks.beforeOwnershipCheck({ fileName: req.file && req.file.filename })).then(settle).catch((e) => sendError(res, e));
        return undefined;
      }
      settle();
      return undefined;
    });
  }

  async function stageHandler(req, res) {
    const file = req.file;
    if (!file) return sendError(res, invalid('未收到上传文件（字段名应为 file）', 'file'));
    const pid = rules.parseId(req.params.id);
    const fileRelPath = `sysbuild/${pid}/${file.filename}`;
    let attachment = null;
    let failure = null;
    try {
      const { sha256, size, head } = await hashFile(file.path);
      const ext = normalizeAttachmentExt(file.originalname);
      const expectedMime = IMAGE_EXT_MIME[ext] || null;
      const detected = sniffImageType(head);
      // 识别为图片就按图片规则：先看大小（20MB 上限按识别结果，与扩展名无关）；
      //   然后文件头识别的类型必须与扩展名对应的图片类型一致——图片头配普通扩展名（.txt）、
      //   图片扩展名配不同类型的头（.jpg 配 png 头）、图片扩展名配非图片内容，一律拒绝。
      //   两边都不是图片（detected 与 expectedMime 都是 null）才按普通文件存。
      if (detected && size > IMAGE_MAX_BYTES) throw invalid('图片大小不能超过 20MB', 'file');
      if (detected !== expectedMime) throw invalid('文件内容与扩展名不符，不是有效的图片文件', 'file');
      const isImage = detected ? 1 : 0;
      // 非图片的 mime_type 统一存 application/octet-stream；下载时显式以存储的 mime_type 作 Content-Type
      //   （不让 Express 按扩展名推断，避免 .html 之类被浏览器当页面渲染）。
      const mimeType = isImage ? detected : 'application/octet-stream';
      const user = req.user;
      const uid = Number(user.id);

      if (hooks.beforeStageTxn) await hooks.beforeStageTxn({ fileName: fileRelPath });

      attachment = await db.withWriteTxn(async (q) => {
        const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
        rules.assertCan(access, rules.canStageAttachment, { writeKind: 'attachment' });
        const ins = await q.run(
          'INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [pid, fileRelPath, file.originalname, mimeType, size, sha256, isImage, uid]
        );
        if (hooks.failStageTxn) await hooks.failStageTxn({ fileName: fileRelPath });
        await writeEvent(q, {
          projectId: pid, objectType: 'attachment', objectId: ins.lastID, eventType: 'attachment_staged',
          payload: { size, sha256, is_image: isImage }, // Q8：事件不写原文件名（遮蔽后任何接口都不再返回原名，事件表是只追加的）
          operatorId: uid, operatorName: operatorNameOf(user),
        });
        // Q8：返回给客户端的文件名经 attachmentDisplayName 构造（SELECT 必须带 masked_at）；响应字段名仍叫 original_name。
        //   刚暂存的行必未遮蔽，值 = 原名，行为不变。
        const row = await q.get('SELECT id, original_name, masked_at, size, sha256, is_image, staged_at FROM sysbuild_attachments WHERE id = ?', [ins.lastID]);
        return { id: row.id, original_name: attachmentDisplayName(row), size: row.size, sha256: row.sha256, is_image: row.is_image, staged_at: row.staged_at };
      });
      // 事务已提交之后的步骤也在 try 内：它们失败同样走下面的回读门（回读会看到记录而保留文件）。
      if (hooks.afterStageCommit) await hooks.afterStageCommit({ fileName: fileRelPath, attachment });
      // 写出响应同样在 try 内：它抛错（序列化 / 套接字异常）也走下面的回读门——回读会看到已提交的记录而保留文件。
      if (hooks.beforeRespond) await hooks.beforeRespond({ fileName: fileRelPath, attachment });
      res.json({ attachment });
    } catch (err) {
      failure = err;
    }
    if (failure) {
      // 原 withWriteTxn 已完全落定（如果走到过它）。是否删文件只看回读，不看 failure.txnOutcome。
      await deleteUploadIfUnreferenced(fileRelPath);
      if (res.headersSent) { res.destroy(); return undefined; } // 响应已开始写出：不能再改状态码，直接断开
      return sendError(res, failure);
    }
    return undefined;
  }

  router.post('/sysbuild/projects/:id/attachments/stage', stagePrecheck, runUpload, handle(stageHandler));

  // ── 下载 / 预览 ─────────────────────────────────────────────────────────────────────
  // 读检查（§5.3 + 附件状态）：读附件行 → 用其 project_id 查项目权限 → 软删除 404 → 遮蔽且非 admin 403。
  async function loadReadableAttachment(req) {
    const aid = rules.parseId(req.params.aid);
    if (!aid) throw invalid('附件编号不合法', 'aid');
    return db.withRead(async (q) => {
      const att = await q.get(
        'SELECT id, project_id, file_name, original_name, mime_type, is_image, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [aid]
      );
      if (!att) throw rules.notFound();
      const access = await rules.loadProjectAccess(q, att.project_id, req.user, accessOpts());
      rules.assertCan(access, rules.canViewAttachments);
      const identity = await rules.completeIdentity(q, access, req.user);
      if (!(await visibility.attachmentVisible(q, identity, att.project_id, att.id))) throw rules.notFound();
      if (att.deleted_at) throw rules.notFound();
      if (att.masked_at && !access.isAdmin) throw makeError(403, 'SYSBUILD_ATTACHMENT_MASKED', '该附件已被遮蔽');
      return att;
    });
  }
  // 锁外：子树校验（基准目录 = UPLOAD_DIR/sysbuild，越界 403）+ 文件存在性（404）。照 quick-log/index.js:464-470。
  function resolveStoredFile(att) {
    const base = path.resolve(UPLOAD_SUBDIR);
    const abs = path.resolve(UPLOAD_DIR, att.file_name);
    const deny = () => {
      logger.warn(`[sysbuild] 附件路径越界拦截: attachment#${att.id} ${att.file_name}`);
      return makeError(403, 'SYSBUILD_FORBIDDEN', '非法文件路径');
    };
    if (!abs.startsWith(base + path.sep)) throw deny(); // 第一道：文本前缀（挡 ../ 与绝对路径）
    let st = null;
    try { st = fs.statSync(abs); } catch (_) { st = null; }
    if (!st || !st.isFile()) throw makeError(404, 'SYSBUILD_NOT_FOUND', '附件文件不存在');
    // 第二道：真实路径归属——目录联接 / 符号链接可以让文本上在子树内的路径实际指向子树外。
    //   基准目录与目标文件分别取真实路径，目标的真实路径必须仍在真实基准目录内；返回真实路径，后面的读取不再经过链接。
    let realBase;
    let realAbs;
    try {
      realBase = fs.realpathSync.native(base);
      realAbs = fs.realpathSync.native(abs);
    } catch (_) {
      throw makeError(404, 'SYSBUILD_NOT_FOUND', '附件文件不存在');
    }
    if (!realAbs.startsWith(realBase + path.sep)) throw deny();
    return { abs: realAbs, size: st.size };
  }

  // 附件记录与逐对象动作，纯读；遮蔽时不返回原名或存储路径。
  router.get('/sysbuild/attachments/:aid', handle(async (req, res) => {
    const aid = rules.parseId(req.params.aid);
    if (!aid) throw invalid('附件编号不合法', 'aid');
    const out = await db.withRead(async (q) => {
      const att = await q.get(`SELECT a.id AS id, a.project_id AS project_id, a.original_name AS original_name, a.mime_type AS mime_type,
        a.size AS size, a.sha256 AS sha256, a.is_image AS is_image, a.uploaded_by AS uploaded_by, a.staged_at AS staged_at,
        a.masked_at AS masked_at, a.masked_by AS masked_by, a.mask_reason AS mask_reason, a.deleted_at AS deleted_at, a.deleted_by AS deleted_by,
        COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name,
        COALESCE(up.display_name, up.username) AS uploaded_by_name
        FROM sysbuild_attachments a LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
        LEFT JOIN users up ON up.id = a.uploaded_by WHERE a.id = ?`, [aid]);
      if (!att) throw rules.notFound();
      const access = await rules.loadProjectAccess(q, att.project_id, req.user, accessOpts());
      rules.assertCan(access, rules.canViewAttachments);
      const identity = await rules.completeIdentity(q, access, req.user);
      if (!(await visibility.attachmentVisible(q, identity, att.project_id, att.id))) throw rules.notFound();
      const frozen = await isAttachmentFrozen(q, aid);
      const evidence = await q.get("SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1", [aid]);
      const permitted = (can) => {
        try { rules.assertCan(access, can, { writeKind: 'attachment' }); return true; }
        catch (err) { if (err.status === 403 || err.status === 409) return false; throw err; }
      };
      const readable = !att.deleted_at && (!att.masked_at || access.isAdmin);
      return { attachment: {
        attachment_id: att.id, project_id: att.project_id, name: attachmentDisplayName(att), mime_type: att.mime_type, size: att.size, sha256: att.sha256, is_image: att.is_image === 1,
        uploaded_by: att.uploaded_by, uploaded_by_name: att.uploaded_by_name, staged_at: att.staged_at, frozen, evidence_bound: !!evidence,
        ...attachmentStateFields(att),
        actions: { download: !!readable, preview: !!readable && att.is_image === 1, mask: !att.deleted_at && !att.masked_at && permitted(rules.canMaskAttachment), delete: !att.deleted_at && !frozen && !evidence && permitted(rules.canSoftDeleteAttachment) },
      } };
    });
    res.json(out);
  }));
  router.get('/sysbuild/attachments/:aid/download', handle(async (req, res) => {
    const att = await loadReadableAttachment(req);
    const { abs } = resolveStoredFile(att);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    // 显式以存储的 mime_type 作 Content-Type（非图片即 application/octet-stream），不让 send 按扩展名推断。
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    res.download(abs, dispositionFileName(att), (err) => { // Q8：已遮蔽（仅 admin 能走到这里，见 loadReadableAttachment）用 attachment-<id><扩展名>
      if (!err) return;
      // 已开始写出（首块已发出）后才出错：不能再回 JSON，直接断开，让客户端在有界时间内得到连接错误而不是挂起。
      if (res.headersSent) { res.destroy(); return; }
      res.removeHeader('Content-Disposition');
      res.setHeader('Content-Type', 'application/json; charset=utf-8'); // 上面预置的是文件类型，错误体是 JSON
      sendError(res, err.status === 404 ? makeError(404, 'SYSBUILD_NOT_FOUND', '附件文件不存在') : err);
    });
  }));

  router.get('/sysbuild/attachments/:aid/preview', handle(async (req, res) => {
    const att = await loadReadableAttachment(req);
    if (!att.is_image) throw rules.notFound();
    const { abs, size } = resolveStoredFile(att);
    res.status(200);
    res.setHeader('Content-Type', att.mime_type);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeRfc5987(dispositionFileName(att))}`); // Q8：已遮蔽不出原名
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    const stream = fs.createReadStream(abs);
    stream.on('error', (e) => {
      logger.error(`[sysbuild] 预览读取文件失败: ${e.message}`);
      if (!res.headersSent) {
        // 头部已按图片预置：错误响应是 JSON，先把图片相关头部恢复 / 移除，否则 JSON 会带着 image/* 与 inline 文件名发出去。
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        sendError(res, e);
      } else res.destroy();
    });
    stream.pipe(res);
  }));

  // ── 软删除 / 受控遮蔽 ────────────────────────────────────────────────────────────────
  router.post('/sysbuild/attachments/:aid/delete', handle(async (req, res) => {
    const aid = rules.parseId(req.params.aid);
    if (!aid) throw invalid('附件编号不合法', 'aid');
    const user = req.user;
    const uid = Number(user.id);
    await db.withWriteTxn(async (q) => {
      const att = await q.get('SELECT id, project_id, deleted_at FROM sysbuild_attachments WHERE id = ?', [aid]);
      if (!att) throw rules.notFound();
      const access = await rules.loadProjectAccess(q, att.project_id, user, accessOpts());
      rules.assertCan(access, rules.canSoftDeleteAttachment, { writeKind: 'attachment' });
      // 已删除放在权限检查之后：有权限的人重复删除得到 409，无权限的人始终是 404 / 403，不借此探测。
      if (att.deleted_at) throw makeError(409, 'SYSBUILD_STATE', '附件已删除');
      if (await isAttachmentFrozen(q, aid)) throw makeError(409, 'SYSBUILD_STATE', '附件已被确认版本引用，不能删除；如需隐藏请由项目经理遮蔽');
      // C4b Q-S1 预筛 D1（不变量 9，同模式全扫 P59）：作为凭据绑定的附件——代录确认凭据（confirmation）、历史补录 / 历史事实导入凭据（history_import）、改期证据（schedule_record）——
      //   与已冻结的一样不能普通软删除（凭据一删，确认 / 改期的依据就没了），受控遮蔽仍可用。
      //   C4b Q-S2：历史补录窗口的开启 / 关闭 / 重开凭据以 owner_type = event 绑定（grep 核对：event 除这三个窗口动作外没有任何绑定用途），同属凭据，一并纳入。
      const evidenceBound = await q.get(
        "SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ? AND owner_type IN ('confirmation', 'history_import', 'schedule_record', 'event') LIMIT 1",
        [aid]
      );
      if (evidenceBound) throw makeError(409, 'SYSBUILD_STATE', '附件已作为确认 / 改期凭据，不能删除；如需隐藏请由项目经理遮蔽');
      const r = await q.run("UPDATE sysbuild_attachments SET deleted_at = datetime('now','localtime'), deleted_by = ? WHERE id = ? AND deleted_at IS NULL", [uid, aid]);
      if (r.changes === 0) throw makeError(409, 'SYSBUILD_STATE', '附件状态已变化，请刷新后重试');
      await writeEvent(q, {
        projectId: att.project_id, objectType: 'attachment', objectId: aid, eventType: 'attachment_deleted',
        payload: {}, operatorId: uid, operatorName: operatorNameOf(user), // Q8：事件不写原文件名
      });
    });
    res.json({ ok: true });
  }));

  // 请求体解析失败（非法 JSON / 超长）统一回 400 SYSBUILD_INVALID_INPUT，不落到 Express 默认的 HTML 错误页。
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  router.post('/sysbuild/attachments/:aid/mask', parseJsonBody, handle(async (req, res) => {
    const aid = rules.parseId(req.params.aid);
    if (!aid) throw invalid('附件编号不合法', 'aid');
    const rawReason = req.body && req.body.reason;
    const reason = typeof rawReason === 'string' ? rawReason.trim() : '';
    const reasonLen = Array.from(reason).length;
    if (reasonLen < 1 || reasonLen > MASK_REASON_MAX) throw invalid(`遮蔽原因必填，1–${MASK_REASON_MAX} 字`, 'reason');
    if (rules.hasControlChar(reason)) throw invalid('遮蔽原因不能包含控制字符', 'reason'); // 预筛 L1：与其余文本入参同一判定（NUL 等否则落到库内 CHECK 以 500 暴露）
    const user = req.user;
    const uid = Number(user.id);
    await db.withWriteTxn(async (q) => {
      const att = await q.get('SELECT id, project_id, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [aid]);
      if (!att) throw rules.notFound();
      const access = await rules.loadProjectAccess(q, att.project_id, user, accessOpts());
      rules.assertCan(access, rules.canMaskAttachment, { writeKind: 'attachment' });
      if (att.deleted_at) throw makeError(409, 'SYSBUILD_STATE', '附件已删除');
      if (att.masked_at) throw makeError(409, 'SYSBUILD_STATE', '附件已遮蔽');
      // 被冻结清单引用的附件可以遮蔽——这正是遮蔽相对软删除的用途。
      const r = await q.run("UPDATE sysbuild_attachments SET masked_at = datetime('now','localtime'), masked_by = ?, mask_reason = ? WHERE id = ? AND masked_at IS NULL", [uid, reason, aid]);
      if (r.changes === 0) throw makeError(409, 'SYSBUILD_STATE', '附件状态已变化，请刷新后重试');
      await writeEvent(q, {
        projectId: att.project_id, objectType: 'attachment', objectId: aid, eventType: 'attachment_masked',
        payload: { reason }, operatorId: uid, operatorName: operatorNameOf(user), // Q8：事件不写原文件名
      });
    });
    res.json({ ok: true });
  }));

  // ── 事务内助手（供 C3 起的记录提交接口在它们自己的 withWriteTxn 回调里调用）─────────────────
  async function isAttachmentFrozen(q, attachmentId) {
    const row = await q.get('SELECT id FROM sysbuild_frozen_attachments WHERE attachment_id = ? LIMIT 1', [attachmentId]);
    return !!row;
  }

  // 校验全部通过后才写入；任一不通过整体抛错（调用方事务回滚）。operatorName 是对派单签名的可选补充
  //   （sysbuild_events.operator_name 非空，事件必须有操作人名）。
  async function bindStagedAttachments(q, args) {
    const { projectId, userId, attachmentIds, ownerType, ownerId } = args;
    const now = args.now instanceof Date ? args.now : nowProvider();
    const operatorName = args.operatorName || ('user#' + userId);
    if (!schema.ENUMS.bindingOwnerType.includes(ownerType)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件绑定的所属类型未登记');
    if (!Number.isInteger(ownerId) || ownerId <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件绑定的所属对象编号不合法');
    // 没带附件（undefined / null）当空数组；带了但不是数组是调用方的输入错误，不静默当空。
    if (attachmentIds !== undefined && attachmentIds !== null && !Array.isArray(attachmentIds)) throw invalid('附件编号列表格式不对', 'attachment_ids');
    const ids = attachmentIds || [];
    if (new Set(ids).size !== ids.length) throw invalid('附件编号重复', 'attachment_ids');
    const checked = [];
    for (const id of ids) {
      if (!Number.isInteger(id) || id <= 0) throw invalid('附件编号不合法', 'attachment_ids');
      const att = await q.get('SELECT id, project_id, uploaded_by, staged_at, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [id]);
      // 不存在 / 别的项目 / 别人上传 / 已删除 / 已遮蔽：同一句提示，不借此探测别处的附件。
      if (!att || att.project_id !== projectId) throw invalid('附件不存在或不可用', 'attachment_ids');
      if (att.uploaded_by !== userId) throw invalid('附件不存在或不可用', 'attachment_ids');
      if (att.deleted_at) throw invalid('附件不存在或不可用', 'attachment_ids');
      // C3b 预筛 D5(a)：已遮蔽的暂存附件不得新绑定（与「遮蔽后的附件不得被新版本引用」同口径，否则遮蔽的内容会被带进新记录）。
      if (att.masked_at) throw invalid('附件不存在或不可用', 'attachment_ids');
      const bound = await q.get('SELECT id FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [id]);
      if (bound) throw invalid('附件已被使用，不能重复提交', 'attachment_ids');
      const stagedAt = parseLocalDatetime(att.staged_at);
      if (!stagedAt) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件暂存时间格式异常');
      if (now.getTime() - stagedAt.getTime() > STAGE_TTL_MS) throw invalid('附件已超过 24 小时未提交，请重新上传', 'attachment_ids');
      checked.push(att);
    }
    for (const att of checked) {
      await q.run('INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, ?, ?, ?)', [att.id, ownerType, ownerId, userId]);
      await writeEvent(q, {
        projectId, objectType: 'attachment', objectId: att.id, eventType: 'attachment_bound',
        payload: { owner_type: ownerType, owner_id: ownerId }, operatorId: userId, operatorName,
      });
    }
    return checked.map((a) => a.id);
  }

  // 冻结：取该 owner「绑定 ∪ 引用」且未软删除的附件（C3b / D40：新版本沿用旧版本附件走 sysbuild_attachment_refs，冻结清单按并集生成，去重），
  //   逐个写冻结清单（含 sha256）。返回 [{ attachment_id, sha256 }]。
  async function freezeAttachmentSet(q, args) {
    const { objectType, objectVersionId, ownerType, ownerId, operatorId, operatorName, projectId } = args;
    if (!schema.ENUMS.frozenObjectType.includes(objectType)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：冻结对象类型未登记');
    if (!schema.ENUMS.bindingOwnerType.includes(ownerType)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：附件绑定的所属类型未登记');
    if (!Number.isInteger(ownerId) || ownerId <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：冻结的所属对象编号不合法');
    if (!Number.isInteger(objectVersionId) || objectVersionId <= 0) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：冻结的对象版本编号不合法');
    const rows = await q.all(
      `SELECT a.id AS attachment_id, a.sha256 AS sha256, a.project_id AS project_id
         FROM sysbuild_attachments a
        WHERE a.id IN (
                SELECT b.attachment_id FROM sysbuild_attachment_bindings b WHERE b.owner_type = ? AND b.owner_id = ?
                UNION
                SELECT r.attachment_id FROM sysbuild_attachment_refs r WHERE r.owner_type = ? AND r.owner_id = ?
              )
          AND a.deleted_at IS NULL
        ORDER BY a.id`,
      [ownerType, ownerId, ownerType, ownerId]
    );
    const frozen = [];
    for (const r of rows) {
      if (r.project_id !== projectId) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：绑定的附件不属于该项目');
      await q.run('INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES (?, ?, ?, ?)', [objectType, objectVersionId, r.attachment_id, r.sha256]);
      await writeEvent(q, {
        projectId, objectType: 'attachment', objectId: r.attachment_id, eventType: 'attachment_frozen',
        payload: { object_type: objectType, object_version_id: objectVersionId, sha256: r.sha256 }, operatorId, operatorName,
      });
      frozen.push({ attachment_id: r.attachment_id, sha256: r.sha256 });
    }
    return frozen;
  }

  const helpers = { bindStagedAttachments, freezeAttachmentSet, isAttachmentFrozen };
  const _internals = {
    sniffImageType, decodeOriginalName, diskSafeName, encodeRfc5987, parseLocalDatetime, deleteUploadIfUnreferenced, UPLOAD_SUBDIR,
    stageStorage,
  };
  if (TEST_HOOKS_ENABLED) {
    _internals.setBeforeStageTxn = (fn) => { hooks.beforeStageTxn = fn || null; };
    _internals.setNameGenerator = (fn) => { hooks.nameGenerator = fn || null; };
    _internals.setBeforeRespond = (fn) => { hooks.beforeRespond = fn || null; };
    _internals.setAfterStageCommit = (fn) => { hooks.afterStageCommit = fn || null; };
    _internals.setFailStageTxn = (fn) => { hooks.failStageTxn = fn || null; };
    _internals.setBeforeReadback = (fn) => { hooks.beforeReadback = fn || null; };
    _internals.setAfterRemoveFile = (fn) => { hooks.afterRemoveFile = fn || null; };
    _internals.setBeforeOwnershipCheck = (fn) => { hooks.beforeOwnershipCheck = fn || null; };
    _internals.setFileSizeLimit = (n) => { fileSizeLimit = Number.isInteger(n) && n > 0 ? n : MAX_FILE_BYTES; };
  }
  return { router, helpers, _internals };
}

module.exports = { createAttachmentRoutes, sniffImageType, diskSafeName, decodeOriginalName, attachmentDisplayName, attachmentStateFields };
