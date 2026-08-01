// routes/quick-log/index.js — 零星事项台账（快速通道）
//   业务 SSOT = docs/local/系统迭代/系统迭代_零星事项台账_方案_20260801_v0.1.md
//   admin 自主记录提效工具/demo 类小开发，无状态纯完成留痕；统计轴 = 类型 × 月份（COALESCE(end_date, date(created_at))）。
//
// ⚠️ 硬边界（方案 §三明文）：本模块与 sys_issues / 受理门触发器 / 46 条 transition / sysTxnMutex **零交集**——
//   不 require、不调用 routes/sys-iteration 的任何状态机/守卫/mutex；单表 CRUD 不开显式事务（BEGIN/COMMIT）。
//   挂载方式（factory + deps 注入）照 routes/sys-iteration 的工厂/DI 范式对齐（server.js 同风格 REQUIRED_DEPS
//   校验 + 返回 { router }），仅取其"挂载壳"，不共享其内部基础设施。
//   schema（CREATE TABLE IF NOT EXISTS 首启自建）本身**不**在本模块内——照 issue_lite 范式直接建在
//   server.js（db.serialize 块，紧邻 issue_lite schema 之后），本模块只消费已就绪的表，通过注入的
//   requireQuickLogSchemaReady 中间件挡未就绪窗口（503）。
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { cleanupPendingFiles } = require('../../utils/collab-submit-helpers');   // 无状态 util，直接 require（对齐 sys-iteration 对 issueNotify/dingtalkNotify 的处理方式，不注入）

module.exports = (deps) => {
  const REQUIRED_DEPS = [
    'logger', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken', 'requireAdmin',
    'requireQuickLogSchemaReady', 'UPLOAD_DIR', 'normalizeAttachmentExt', 'safeDeleteFileSync',
    'COLLAB_ALLOWED_EXTS_UNION',
  ];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/quick-log 缺注入依赖: ' + __k);
  }
  const {
    logger, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken, requireAdmin,
    requireQuickLogSchemaReady, UPLOAD_DIR, normalizeAttachmentExt, safeDeleteFileSync,
    COLLAB_ALLOWED_EXTS_UNION,
  } = deps;

  const router = express.Router();

  // ============================================================
  // 一、常量 + 纯函数 helper
  // ============================================================

  // category 值域（方案 §二：服务层白名单保证，绝不设 DB CHECK——吸取 issue_lite「改 CHECK 需重建表」教训）
  const QUICK_LOG_CATEGORIES = ['tool', 'demo', 'other'];

  // ── 标题派生：复制自 routes/sys-iteration/index.js:1632-1646（deriveSysTitleFromDescription，建单优化批
  //   C1，方案 20260731_v1.2 §6b.3）——该函数是纯函数（无 sys-iteration 闭包依赖，仅 String/Array 原生操作），
  //   但定义在 sys-iteration 工厂闭包内部、只经该模块 _internals 导出，直接 require 该模块会连带整个 sys
  //   工厂实例化（14 项强依赖 + SYS_SCHEMA_STATE 等重基础设施），违反本模块"零交集"硬边界（见文件头注释）。
  //   故按任务指令"内嵌不可导出则复制纯函数并注明来源"处理：算法逐字复刻，未来 sys-iteration 侧算法变更
  //   需人工同步（复制点已注明来源行号，供 grep 巡检）。
  //   算法：description 整体 trim → 按换行分割取第一个非空行 → 按 Unicode code point（Array.from）截取前
  //   40 个字符 → 有截断则追加"…"。调用前提：description 已过非空校验，故首个非空行必然存在。
  function deriveQuickLogTitleFromDescription(desc) {
    const trimmed = String(desc == null ? '' : desc).trim();
    const lines = trimmed.split(/\r\n|\r|\n/);
    const firstNonEmptyLine = (lines.find(l => l.trim().length > 0) || '').trim();
    const chars = Array.from(firstNonEmptyLine);
    if (chars.length <= 40) return firstNonEmptyLine;
    return chars.slice(0, 40).join('') + '…';
  }

  // 正整数 id 解析（对齐 issue_lite /^[1-9]\d*$/ 范式，用于 :id / :attId 路径参数）
  function parsePositiveId(v) {
    if (typeof v !== 'string' && typeof v !== 'number') return null;
    const s = String(v);
    if (!/^[1-9]\d*$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }

  // 真实日期校验（对齐 server.js issue_lite POST 的 req_date 校验范式，拒 2026-02-30 一类月内溢出）
  function isValidDateStr(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    // codex S1 审 LOW 采纳：改走 Date.UTC 构造 + getUTC* 回比，去掉 `new Date(...)` 本地时区解析依赖
    // （原写法在服务器时区异常/DST 边界等场景理论上可能有回比误差，UTC 构造与本地时区无关，恒定可靠）。
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return !isNaN(dt.getTime()) && dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === mo && dt.getUTCDate() === d;
  }

  // LIKE 关键词转义（对齐 issue_lite 列表搜索范式：% _ \ 三字符转义）
  function escapeLikeKeyword(s) {
    return s.replace(/[\\%_]/g, m => '\\' + m);
  }

  // ── POST/PUT 共用校验（同一份契约：PUT 按方案 §六-1"admin 可编辑全字段"，与 POST 同规则整单重填）──
  //   返回 { ok:true, data } 或 { ok:false, status, body }
  function validateQuickLogInput(body) {
    const b = body || {};

    // category 白名单（错 → 400 code VALIDATION，方案端点表明文口径）
    const category = b.category;
    if (typeof category !== 'string' || !QUICK_LOG_CATEGORIES.includes(category)) {
      return { ok: false, status: 400, body: { error: '类型不合法（仅 tool/demo/other）', code: 'VALIDATION' } };
    }

    // category_note：仅 category='other' 时接受 ≤200；非 other 传了也不报错，强制归一 NULL
    let categoryNote = null;
    if (category === 'other') {
      if (b.category_note !== undefined && b.category_note !== null && b.category_note !== '') {
        if (typeof b.category_note !== 'string') {
          return { ok: false, status: 400, body: { error: '其他类型备注格式错误', code: 'CATEGORY_NOTE_INVALID' } };
        }
        const t = b.category_note.trim();
        if (t.length > 200) {
          return { ok: false, status: 400, body: { error: '其他类型备注过长（上限200字）', code: 'CATEGORY_NOTE_TOO_LONG' } };
        }
        categoryNote = t || null;
      }
    }
    // category !== 'other'：categoryNote 保持 null（无论 body 传了什么，静默归一，不报错——方案端点表明文口径）

    // description 必填 ≤2000（trim）
    if (typeof b.description !== 'string') {
      return { ok: false, status: 400, body: { error: '事项描述必填', code: 'DESCRIPTION_REQUIRED' } };
    }
    const description = b.description.trim();
    if (!description) {
      return { ok: false, status: 400, body: { error: '事项描述必填', code: 'DESCRIPTION_REQUIRED' } };
    }
    if (description.length > 2000) {
      return { ok: false, status: 400, body: { error: '事项描述过长（上限2000字）', code: 'DESCRIPTION_TOO_LONG' } };
    }

    // result_note 必填 ≤2000（trim）
    if (typeof b.result_note !== 'string') {
      return { ok: false, status: 400, body: { error: '结果说明必填', code: 'RESULT_NOTE_REQUIRED' } };
    }
    const resultNote = b.result_note.trim();
    if (!resultNote) {
      return { ok: false, status: 400, body: { error: '结果说明必填', code: 'RESULT_NOTE_REQUIRED' } };
    }
    if (resultNote.length > 2000) {
      return { ok: false, status: 400, body: { error: '结果说明过长（上限2000字）', code: 'RESULT_NOTE_TOO_LONG' } };
    }

    // result_link 选填 ≤500
    let resultLink = null;
    if (b.result_link !== undefined && b.result_link !== null && b.result_link !== '') {
      if (typeof b.result_link !== 'string') {
        return { ok: false, status: 400, body: { error: '结果链接格式错误', code: 'RESULT_LINK_INVALID' } };
      }
      const t = b.result_link.trim();
      if (t.length > 500) {
        return { ok: false, status: 400, body: { error: '结果链接过长（上限500字）', code: 'RESULT_LINK_TOO_LONG' } };
      }
      resultLink = t || null;
    }

    // requester_name 选填 ≤50（NULL = 自主发起）
    let requesterName = null;
    if (b.requester_name !== undefined && b.requester_name !== null && b.requester_name !== '') {
      if (typeof b.requester_name !== 'string') {
        return { ok: false, status: 400, body: { error: '需求方格式错误', code: 'REQUESTER_NAME_INVALID' } };
      }
      const t = b.requester_name.trim();
      if (t.length > 50) {
        return { ok: false, status: 400, body: { error: '需求方过长（上限50字）', code: 'REQUESTER_NAME_TOO_LONG' } };
      }
      requesterName = t || null;
    }

    // requester_dept 选填 ≤100（NULL = 自主发起）
    let requesterDept = null;
    if (b.requester_dept !== undefined && b.requester_dept !== null && b.requester_dept !== '') {
      if (typeof b.requester_dept !== 'string') {
        return { ok: false, status: 400, body: { error: '需求部门格式错误', code: 'REQUESTER_DEPT_INVALID' } };
      }
      const t = b.requester_dept.trim();
      if (t.length > 100) {
        return { ok: false, status: 400, body: { error: '需求部门过长（上限100字）', code: 'REQUESTER_DEPT_TOO_LONG' } };
      }
      requesterDept = t || null;
    }

    // start_date / end_date 选填 YYYY-MM-DD 且为真实日期（服务端校验，不只靠 DB CHECK 兜底）
    let startDate = null;
    if (b.start_date !== undefined && b.start_date !== null && b.start_date !== '') {
      if (typeof b.start_date !== 'string') {
        return { ok: false, status: 400, body: { error: '开始日期格式错误', code: 'START_DATE_INVALID' } };
      }
      const t = b.start_date.trim();
      if (!isValidDateStr(t)) {
        return { ok: false, status: 400, body: { error: '开始日期非法（应为真实存在的 YYYY-MM-DD）', code: 'START_DATE_INVALID' } };
      }
      startDate = t;
    }
    let endDate = null;
    if (b.end_date !== undefined && b.end_date !== null && b.end_date !== '') {
      if (typeof b.end_date !== 'string') {
        return { ok: false, status: 400, body: { error: '结束日期格式错误', code: 'END_DATE_INVALID' } };
      }
      const t = b.end_date.trim();
      if (!isValidDateStr(t)) {
        return { ok: false, status: 400, body: { error: '结束日期非法（应为真实存在的 YYYY-MM-DD）', code: 'END_DATE_INVALID' } };
      }
      endDate = t;
    }

    // title 服务端派生（不收前端输入；PUT 同样每次重新派生——纯函数、幂等，天然满足
    //   "description 改动时 title 重派生"：不管 description 是否真的变了，重新派生的结果与当前
    //   description 恒一致，比"仅在检测到变化时才派生"更强的不变量：title 任何时刻都是 description 的忠实投影）
    const title = deriveQuickLogTitleFromDescription(description);

    return {
      ok: true,
      data: { category, categoryNote, title, requesterName, requesterDept, description, resultNote, resultLink, startDate, endDate },
    };
  }

  // ============================================================
  // 二、附件基础设施（照 issue_lite D3 范式整套对齐：server.js:13825-13854）
  // ============================================================
  const QUICK_LOG_UPLOAD_BASE = path.join(UPLOAD_DIR, 'quick-log');
  if (!fs.existsSync(QUICK_LOG_UPLOAD_BASE)) fs.mkdirSync(QUICK_LOG_UPLOAD_BASE, { recursive: true });
  // 白名单 = collab 联合白名单 + 压缩包（工具类产出物可能是程序包，方案 §六-2 拍板：沿用 issue_lite 200MB 规格）
  const QUICK_LOG_ALLOWED_EXTS = Array.from(new Set([...COLLAB_ALLOWED_EXTS_UNION, '.zip', '.rar', '.7z']));
  const QUICK_LOG_ATTACHMENT_LIMIT = 20;   // 单条登记附件数上限（对齐 issue_lite D3-H-1）

  const quickLogStorage = multer.diskStorage({
    destination: function (req, file, cb) {
      // 纵深防御：id 非正整数直接拒（filename 用 id 拼名，防落非预期路径）
      if (!/^[1-9]\d*$/.test(String(req.params.id))) return cb(new Error('非法 id'));
      cb(null, QUICK_LOG_UPLOAD_BASE);
    },
    filename: function (req, file, cb) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8'); // 中文名乱码修复
      // 落盘名截断防 ENAMETOOLONG（对齐 issue_lite D3-L-1）：按码点截断 60 个 + 去 Windows 尾部点/空格 + 空兜底
      const safe = Array.from(file.originalname.replace(/[\\/:*?"<>|]/g, '_')).slice(0, 60).join('').replace(/[. ]+$/, '') || 'file';
      cb(null, `${req.params.id}_${Date.now()}_${Math.round(Math.random() * 1e9)}_${safe}`);
    }
  });
  const quickLogUpload = multer({
    storage: quickLogStorage,
    limits: { fileSize: 200 * 1024 * 1024, files: 1 }, // 200MB（压缩包可能较大）·单文件逐个传
    fileFilter: function (req, file, cb) {
      const ext = normalizeAttachmentExt(file.originalname);
      if (!ext) return cb(new Error('文件名为空或包含非法字符'));
      if (!QUICK_LOG_ALLOWED_EXTS.includes(ext)) return cb(new Error(`不支持的扩展名 ${ext}，仅允许 ${QUICK_LOG_ALLOWED_EXTS.join('/')}`));
      cb(null, true);
    }
  });

  // ============================================================
  // 三、CRUD 端点（全端点 authenticateToken + requireAdmin；免原因·免事务，方案 §六-1）
  // ============================================================

  // 列表：category / keyword 筛选 + 分页；倒序 COALESCE(end_date, date(created_at))
  router.get('/quick-logs', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    try {
      const { category, keyword } = req.query;
      if (category !== undefined && category !== '' && !QUICK_LOG_CATEGORIES.includes(category)) {
        return res.status(400).json({ error: '类型筛选不合法', code: 'INVALID_CATEGORY_FILTER' });
      }
      let keywordLike = null;
      if (keyword !== undefined && keyword !== '') {
        if (typeof keyword !== 'string') return res.status(400).json({ error: '无效的关键词', code: 'INVALID_KEYWORD' });
        const k = keyword.trim();
        if (k.length > 100) return res.status(400).json({ error: '关键词过长（上限100字）', code: 'KEYWORD_TOO_LONG' });
        if (k) keywordLike = '%' + escapeLikeKeyword(k) + '%';
      }
      // 分页（page 1-based / pageSize 默认20上限100）——非法值静默 clamp 到默认，不 400（列表筛选类参数容错优先）
      let page = parseInt(req.query.page, 10);
      if (!Number.isInteger(page) || page < 1) page = 1;
      let pageSize = parseInt(req.query.pageSize, 10);
      if (!Number.isInteger(pageSize) || pageSize < 1) pageSize = 20;
      if (pageSize > 100) pageSize = 100;

      const where = [];
      const params = [];
      if (category) { where.push('category = ?'); params.push(category); }
      if (keywordLike) {
        where.push(`(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR result_note LIKE ? ESCAPE '\\' OR requester_name LIKE ? ESCAPE '\\')`);
        params.push(keywordLike, keywordLike, keywordLike, keywordLike);
      }
      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const totalRow = await dbGetAsync(`SELECT COUNT(*) AS c FROM sys_quick_log ${whereSql}`, params);
      const total = totalRow ? totalRow.c : 0;
      const offset = (page - 1) * pageSize;
      // att_count：相关子查询逐行统计附件数（方案 §四"列 = ... 附件数"）——表加别名 q 供子查询关联；
      //   WHERE/ORDER 里的裸列名在单表 FROM 下仍无歧义解析到 q，无需改写既有 where 拼接。
      // codex S1 审 LOW 半采纳：ORDER BY 是表达式（COALESCE + date()），不走索引，全表排序——本表预期量级
      //   极小（admin 自主记录，个位数/月），显式接受这一成本，不为此加表达式索引；量级若明显增长再评估。
      const rows = await dbAllAsync(
        `SELECT q.*, (SELECT COUNT(*) FROM sys_quick_log_attachments a WHERE a.quick_log_id = q.id) AS att_count
           FROM sys_quick_log q
           ${whereSql}
           ORDER BY COALESCE(q.end_date, date(q.created_at)) DESC, q.id DESC
           LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      );
      res.json({ items: rows || [], total });
    } catch (err) {
      logger.error('[零星事项台账] 列表失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 新建
  router.post('/quick-logs', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    try {
      const v = validateQuickLogInput(req.body);
      if (!v.ok) return res.status(v.status).json(v.body);
      const { category, categoryNote, title, requesterName, requesterDept, description, resultNote, resultLink, startDate, endDate } = v.data;
      const createdById = Number(req.user.id);
      const createdByName = req.user.display_name || req.user.username || ('user#' + createdById);
      const result = await dbRunAsync(
        `INSERT INTO sys_quick_log (category, category_note, title, requester_name, requester_dept, description, result_note, result_link, start_date, end_date, created_by, created_by_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [category, categoryNote, title, requesterName, requesterDept, description, resultNote, resultLink, startDate, endDate, createdById, createdByName]
      );
      const row = await dbGetAsync('SELECT * FROM sys_quick_log WHERE id = ?', [result.lastID]);
      res.json({ success: true, item: row });
    } catch (err) {
      // DB CHECK 兜底（服务端已校验日期真实性，这里是纵深防御第二道防线，理论不可达）
      if (err && /CHECK constraint failed/i.test(err.message || '')) {
        return res.status(400).json({ error: '日期格式非法', code: 'DATE_CHECK_FAILED' });
      }
      logger.error('[零星事项台账] 新建失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 编辑（全字段，同 POST 校验；免原因）
  router.put('/quick-logs/:id', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    try {
      const existing = await dbGetAsync('SELECT id FROM sys_quick_log WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: '登记不存在', code: 'QUICK_LOG_NOT_FOUND' });
      const v = validateQuickLogInput(req.body);
      if (!v.ok) return res.status(v.status).json(v.body);
      const { category, categoryNote, title, requesterName, requesterDept, description, resultNote, resultLink, startDate, endDate } = v.data;
      await dbRunAsync(
        `UPDATE sys_quick_log SET category=?, category_note=?, title=?, requester_name=?, requester_dept=?,
                description=?, result_note=?, result_link=?, start_date=?, end_date=?, updated_at=datetime('now','localtime')
          WHERE id=?`,
        [category, categoryNote, title, requesterName, requesterDept, description, resultNote, resultLink, startDate, endDate, id]
      );
      const row = await dbGetAsync('SELECT * FROM sys_quick_log WHERE id = ?', [id]);
      res.json({ success: true, item: row });
    } catch (err) {
      if (err && /CHECK constraint failed/i.test(err.message || '')) {
        return res.status(400).json({ error: '日期格式非法', code: 'DATE_CHECK_FAILED' });
      }
      logger.error('[零星事项台账] 编辑失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 删除（物理删，免原因）——手动级联（本库 PRAGMA foreign_keys 从未开启）：先删附件物理文件 + 附件表行，再删主记录
  router.delete('/quick-logs/:id', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    try {
      const existing = await dbGetAsync('SELECT id FROM sys_quick_log WHERE id = ?', [id]);
      if (!existing) return res.status(404).json({ error: '登记不存在', code: 'QUICK_LOG_NOT_FOUND' });
      const atts = await dbAllAsync('SELECT id, file_name FROM sys_quick_log_attachments WHERE quick_log_id = ?', [id]);
      for (const att of atts) {
        const ok = safeDeleteFileSync(att.file_name, UPLOAD_DIR);
        if (!ok) logger.warn(`[零星事项台账] 删除附件物理文件失败或已不存在: ${att.file_name}`); // 文件删失败只 warn 不阻断
      }
      await dbRunAsync('DELETE FROM sys_quick_log_attachments WHERE quick_log_id = ?', [id]);
      await dbRunAsync('DELETE FROM sys_quick_log WHERE id = ?', [id]);
      res.json({ success: true, id });
    } catch (err) {
      logger.error('[零星事项台账] 删除失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ============================================================
  // 四、附件端点（列表 + 上传/下载/删除，照 issue_lite D3 范式：server.js:13859-13971）
  // ============================================================

  // 附件列表——方案端点表未单列本端点，系 §四"列 = ... 附件数"与 S2 前端编辑弹窗展示附件清单
  //   （下载/删除入口都需要 attId）的读端支撑，主会话抽查补（S1 首版遗漏）。
  //   字段选择/中间件链对齐 issue_lite `GET /api/issue-lite/:id/attachments`（server.js:13859-13874）：
  //   同款 5 列（original_name/file_size/mime_type/uploaded_by_name/created_at，不暴露内部 file_name）+
  //   父记录不存在 404 判定；差异点：issue_lite 端点返回裸数组（供前端 `list.length` 取计数），本端点改用
  //   `{items:[...]}` 包裹——对齐本模块 POST/PUT `{success,item}` 与列表 `{items,total}` 的统一响应壳惯例，
  //   而非照抄裸数组（列表附件数已由上方 att_count 相关子查询提供，本端点只负责清单本身）。
  router.get('/quick-logs/:id/attachments', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
    try {
      const parent = await dbGetAsync('SELECT id FROM sys_quick_log WHERE id = ?', [id]);
      if (!parent) return res.status(404).json({ error: '登记不存在', code: 'QUICK_LOG_NOT_FOUND' });
      const rows = await dbAllAsync(
        'SELECT id, original_name, file_size, mime_type, uploaded_by_name, created_at FROM sys_quick_log_attachments WHERE quick_log_id = ? ORDER BY id ASC',
        [id]
      );
      res.json({ items: rows || [] });
    } catch (err) {
      logger.error('[零星事项台账] 附件列表失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 上传（multipart·field 名 files·单文件逐个传）
  router.post('/quick-logs/:id/attachments', authenticateToken, requireAdmin, requireQuickLogSchemaReady,
    (req, res, next) => { // 前置 id 校验（在 multer 之前，纵深防御）
      if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'id 必须是正整数', code: 'INVALID_ID' });
      next();
    },
    (req, res, next) => { // multer 错误捕获（对齐 issue_lite 范式）
      quickLogUpload.array('files', 1)(req, res, (err) => {
        if (!err) return next();
        const isMulterErr = err && err.name === 'MulterError';
        try { cleanupPendingFiles(req.files, logger); } catch (_) { /* ignore */ }
        logger.warn(`[零星事项台账 附件] multer error: ${err.message}`);
        return res.status(400).json({ error: '上传文件失败', code: isMulterErr ? err.code : 'UPLOAD_ERROR', detail: err.message });
      });
    },
    async (req, res) => {
      const id = parseInt(req.params.id, 10);
      const file = Array.isArray(req.files) && req.files.length > 0 ? req.files[0] : null;
      const relPath = file ? path.join('quick-log', file.filename).replace(/\\/g, '/') : null;
      const cleanup = () => { if (relPath) safeDeleteFileSync(relPath, UPLOAD_DIR); };
      if (!file) return res.status(400).json({ error: '未收到上传文件（field 名应为 files）', code: 'NO_FILE' });
      try {
        const uploaderId = Number(req.user.id);
        const uploaderName = req.user.display_name || req.user.username || ('user#' + uploaderId);
        const fileSize = (typeof file.size === 'number') ? file.size : null;
        const mimeType = (typeof file.mimetype === 'string' && file.mimetype.trim()) ? file.mimetype : null;
        // 条件 INSERT...SELECT 一次性收口两个不变量（codex S1 审 MED 采纳）：① 主记录存在 ② 附件数量 < 上限。
        //   数量判定并入同一条 SQL 原子执行——关掉旧版"先 SELECT COUNT 再 INSERT"两步之间的竞态窗口。
        //   ⚠️ 成立前提（codex 复审 MED 收窄）：本项目部署形态=PM2 单实例单 Node 进程、全服务共享单条
        //   sqlite3 连接（语句级串行）——该前提下单语句判定即收口；多进程/多写连接部署不成立，届时需
        //   BEGIN IMMEDIATE 包住判定+插入或 DB 级配额约束。changes=0 时
        //   （对齐 issue_lite D3-M-4 关 TOCTOU 的条件 INSERT 范式，本次扩展判据覆盖存在性+数量两条）
        //   再查父记录是否存在以分辨两种失败：父不存在 → 404；父存在（说明是数量上限触发）→ 400
        //   ATTACHMENT_LIMIT——状态码对齐 issue_lite 同款上限拒（server.js:14041 400 ATTACHMENT_LIMIT），
        //   原子条件 INSERT 只改判定时机不改错误码语义（主会话裁定：跨模块同名错误码不同状态=口径不一致）。
        const result = await dbRunAsync(
          `INSERT INTO sys_quick_log_attachments (quick_log_id, file_name, original_name, file_size, mime_type, uploaded_by, uploaded_by_name)
           SELECT ?,?,?,?,?,?,? FROM sys_quick_log
            WHERE id = ? AND (SELECT COUNT(*) FROM sys_quick_log_attachments WHERE quick_log_id = ?) < ?`,
          [id, relPath, file.originalname, fileSize, mimeType, uploaderId, uploaderName, id, id, QUICK_LOG_ATTACHMENT_LIMIT]
        );
        if (result.changes === 0) {
          cleanup();
          const rec = await dbGetAsync('SELECT id FROM sys_quick_log WHERE id = ?', [id]);
          if (!rec) return res.status(404).json({ error: '登记不存在', code: 'QUICK_LOG_NOT_FOUND' });
          return res.status(400).json({ error: `单条登记附件数已达上限(${QUICK_LOG_ATTACHMENT_LIMIT})`, code: 'ATTACHMENT_LIMIT' });
        }
        logger.info(`[零星事项台账] #${id} 上传附件 ${file.originalname} by ${req.user.username}`);
        res.json({ success: true, attachment: { id: result.lastID, quick_log_id: id, original_name: file.originalname, file_size: fileSize, mime_type: mimeType, uploaded_by_name: uploaderName } });
      } catch (err) {
        cleanup();
        logger.error('[零星事项台账] 附件上传失败:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

  // 下载（res.download·手动子树路径校验防穿越·返回原名）——UPLOAD_DIR 下收紧到本模块子树 QUICK_LOG_UPLOAD_BASE
  //   （对齐 sys-iteration 6788-6796 的更严格子树校验，因 isPathSafe 未注入本模块，等效自实现）
  router.get('/quick-logs/attachments/:attId/download', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    if (!/^[1-9]\d*$/.test(req.params.attId)) return res.status(400).json({ error: 'attId 必须是正整数', code: 'INVALID_ID' });
    try {
      const att = await dbGetAsync('SELECT quick_log_id, file_name, original_name FROM sys_quick_log_attachments WHERE id = ?', [req.params.attId]);
      if (!att) return res.status(404).json({ error: '附件不存在', code: 'ATTACHMENT_NOT_FOUND' });
      const parent = await dbGetAsync('SELECT id FROM sys_quick_log WHERE id = ?', [att.quick_log_id]);
      if (!parent) return res.status(404).json({ error: '附件所属登记不存在', code: 'QUICK_LOG_NOT_FOUND' });
      const base = path.resolve(QUICK_LOG_UPLOAD_BASE);
      const absPath = path.resolve(UPLOAD_DIR, att.file_name);
      const within = (absPath === base) || absPath.startsWith(base + path.sep);
      if (!within) {
        logger.warn(`[零星事项台账] 下载路径越界拦截: ${att.file_name}`);
        return res.status(403).json({ error: '非法文件路径', code: 'ILLEGAL_FILE_PATH' });
      }
      if (!fs.existsSync(absPath)) return res.status(404).json({ error: '附件文件不存在', code: 'FILE_NOT_FOUND' });
      res.download(absPath, att.original_name || path.basename(absPath));
    } catch (err) {
      logger.error('[零星事项台账] 附件下载失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // 删除
  router.delete('/quick-logs/attachments/:attId', authenticateToken, requireAdmin, requireQuickLogSchemaReady, async (req, res) => {
    if (!/^[1-9]\d*$/.test(req.params.attId)) return res.status(400).json({ error: 'attId 必须是正整数', code: 'INVALID_ID' });
    try {
      const att = await dbGetAsync('SELECT id, quick_log_id, file_name FROM sys_quick_log_attachments WHERE id = ?', [req.params.attId]);
      if (!att) return res.status(404).json({ error: '附件不存在', code: 'ATTACHMENT_NOT_FOUND' });
      const del = await dbRunAsync('DELETE FROM sys_quick_log_attachments WHERE id = ?', [req.params.attId]);
      if (del.changes === 0) return res.status(404).json({ error: '附件不存在（可能已被并发删除）', code: 'ATTACHMENT_NOT_FOUND' });
      const ok = safeDeleteFileSync(att.file_name, UPLOAD_DIR);
      if (!ok) logger.warn(`[零星事项台账] 删除附件物理文件失败或已不存在: ${att.file_name}`);
      res.json({ success: true, id: att.quick_log_id, attachment_id: att.id });
    } catch (err) {
      logger.error('[零星事项台账] 附件删除失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const _internals = {
    QUICK_LOG_CATEGORIES,
    deriveQuickLogTitleFromDescription,
    parsePositiveId,
    isValidDateStr,
    validateQuickLogInput,
    QUICK_LOG_UPLOAD_BASE,
    QUICK_LOG_ALLOWED_EXTS,
  };

  return { router, _internals };
};
