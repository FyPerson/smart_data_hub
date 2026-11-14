// routes/sysbuild/items.js — 项目管理（系统建设记录）模块：模块与需求条目（C3b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.1、§2.2 不变量 2、§4.1（需求条目登记 / 方向类证据）、§5.2、§6.2、§6.3、§7、§10.3（附件复用）。
//   派单 = docs/local/系统建设记录/送审准备/C3b_模块条目内容包_派单_20261030.md。
//
// 工厂 createItemRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers }。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY
//   → 对象状态 409 SYSBUILD_STATE → 业务规则（引用对象 400、提出人 400 / 409、方向类证据 400 SYSBUILD_EVIDENCE_REQUIRED）。
//   权限 / 项目状态 / 对象状态三步全部经 rules.assertOp（OBJECT_OPS + OP_KIND），读接口 actions 用 rules.opAllowed 与同一个 target 构造函数。
// 条目的现行版本 / 待处理版本 / 承诺批次由 packages.resolveCurrentPlan 派生（不变量 2 的单一来源），本文件不另写取数。
'use strict';
const { attachmentStateFields } = require('./attachments');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { resolveCurrentPlan } = require('./packages');
const { attachmentDisplayName } = require('./attachments');
const confirmCore = require('./confirm-core');

const NAME_MAX = 60;
const MODULE_NAME_MAX = 60;
const CONTENT_MAX = 4000;
const QUOTE_MAX = 2000;
const OCCASION_MAX = 200;
const EVIDENCE_REASON_MAX = 500;
const EVIDENCE_REASON_MIN = 10;
const ATTACHMENT_LIST_MAX = 20;

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
function bodyOf(req) {
  const b = req.body;
  if (b === undefined || b === null) return {};
  if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
  return b;
}
function onlyKeys(body, allowed) {
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw invalid(`不支持的字段 ${k}`, k);
  }
}
// 文本：undefined / null / 空白 → null（必填则 400）；非字符串 400；控制字符 400；trim 后按码点计长。
function readText(raw, field, label, max, required) {
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (typeof raw !== 'string') throw invalid(`${label}必须是文本`, field);
  const v = raw.trim();
  if (v === '') {
    if (required) throw invalid(`${label}必填`, field);
    return null;
  }
  if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field);
  if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
  return v;
}
function validDate(s) {
  if (typeof s !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 2000 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
function readOptionalDate(raw, field, label) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!validDate(raw)) throw invalid(`${label}必须是 YYYY-MM-DD 格式的有效日期（2000–2099）`, field);
  return raw;
}

function createItemRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/items 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/items 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/items 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function') {
    throw new Error('routes/sysbuild/items 参数 attachmentHelpers 必须带 bindStagedAttachments');
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 模块条目接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '64kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: operatorNameOf(user),
  });
  function readIdParam(raw, field, label) {
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }
  // 附件编号列表：undefined / null 当空；非数组 400；元素须为正整数、不重复、至多 ATTACHMENT_LIST_MAX 个。
  function readIdList(raw, field, label) {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw invalid(`${label}列表格式不对`, field);
    if (raw.length > ATTACHMENT_LIST_MAX) throw invalid(`${label}一次最多 ${ATTACHMENT_LIST_MAX} 个`, field);
    const ids = raw.map((v) => readIdParam(v, field, label));
    if (new Set(ids).size !== ids.length) throw invalid(`${label}重复`, field);
    return ids;
  }
  // 提出人字段组（member / name / party 三选一的组合规则）：member 与 name 二选一；给了 member 时参与方由成员行带出，不得再给 party。
  function readProposerGroup(body) {
    const given = ['proposer_member_id', 'proposer_name', 'proposer_party_id'].some((k) => body[k] !== undefined && body[k] !== null);
    if (!given) return { given: false };
    const memberGiven = body.proposer_member_id !== undefined && body.proposer_member_id !== null;
    const name = readText(body.proposer_name, 'proposer_name', '提出人姓名', NAME_MAX, false);
    if (memberGiven && name !== null) throw invalid('提出人只能二选一：本项目成员，或无账号提出人姓名', 'proposer_name');
    if (!memberGiven && name === null) throw invalid('提出人必填：本项目成员，或无账号提出人姓名', 'proposer_member_id');
    const partyGiven = body.proposer_party_id !== undefined && body.proposer_party_id !== null;
    if (memberGiven && partyGiven) throw invalid('提出人是成员时，提出方由其所属参与方带出，不用再填', 'proposer_party_id');
    return {
      given: true,
      memberId: memberGiven ? readIdParam(body.proposer_member_id, 'proposer_member_id', '提出人') : null,
      name,
      partyId: partyGiven ? readIdParam(body.proposer_party_id, 'proposer_party_id', '提出方') : null,
    };
  }
  // 方向类证据字段（§4.1）：附件、无书面证据声明与原因。
  function readEvidenceFields(body) {
    if (body.no_written_evidence !== undefined && typeof body.no_written_evidence !== 'boolean') throw invalid('no_written_evidence 必须是布尔值', 'no_written_evidence');
    return {
      noEvidence: body.no_written_evidence === true,
      noEvidenceReason: readText(body.no_evidence_reason, 'no_evidence_reason', '无书面证据原因', EVIDENCE_REASON_MAX, false),
    };
  }
  // 方向类证据校验（本次事务内的新绑定 + 新引用计入 count）：至少一个附件，或声明无书面证据并写明原因（≥10 字）；两种互斥。
  function assertEvidence(count, ev) {
    if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');
    if (!ev.noEvidence && ev.noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');
    if (!ev.noEvidence && count === 0) {
      throw makeError(400, 'SYSBUILD_EVIDENCE_REQUIRED', '登记需求条目须上传证据附件，或声明无书面证据并写明原因（至少 10 个字）');
    }
    if (ev.noEvidence && (ev.noEvidenceReason === null || Array.from(ev.noEvidenceReason).length < EVIDENCE_REASON_MIN)) {
      throw invalid(`无书面证据原因至少 ${EVIDENCE_REASON_MIN} 个字`, 'no_evidence_reason');
    }
  }

  // ── 加载与校验小助手 ──────────────────────────────────────────────────────────────────────
  async function loadProjectCtx(q, pid, user) {
    const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
    rules.assertVisible(access);
    return access;
  }
  async function loadItemCtx(q, iid, user) {
    const item = await q.get('SELECT id, project_id, code, module_id, created_by, created_at FROM sysbuild_items WHERE id = ?', [iid]);
    if (!item) throw rules.notFound();
    const access = await loadProjectCtx(q, item.project_id, user);
    return { item, access };
  }
  async function assertModuleInProject(q, moduleId, pid) {
    const m = await q.get('SELECT id FROM sysbuild_modules WHERE id = ? AND project_id = ?', [moduleId, pid]);
    if (!m) throw invalid('模块不存在或不属于本项目', 'module_id');
  }
  // 提出人解析：返回写入版本行的 { memberId, name, partyId }。成员须在本项目、已加入且未移出（不在本项目 400，已移出 / 未加入 409）；无账号提出人的参与方须是本项目参与方。
  async function resolveProposer(q, group, pid) {
    if (group.memberId !== null) {
      const m = await q.get('SELECT id, party_id, joined_at, removed_at FROM sysbuild_members WHERE id = ? AND project_id = ?', [group.memberId, pid]);
      if (!m) throw invalid('提出人不是本项目成员', 'proposer_member_id');
      if (m.removed_at !== null || m.joined_at === null) throw stateError('提出人已移出或尚未加入本项目');
      return { memberId: m.id, name: null, partyId: m.party_id };
    }
    if (group.partyId !== null) {
      const p = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [group.partyId, pid]);
      if (!p) throw invalid('提出方不是本项目的参与方', 'proposer_party_id');
    }
    return { memberId: null, name: group.name, partyId: group.partyId };
  }
  // S6（主会话自决，锚点 N9 待追认）：新版本可沿用的附件只限该条目任一旧版本已绑定或已引用、同项目、未软删除、未遮蔽的附件。
  //   每条校验独立成句，不满足一律同一句提示（不借此探测别处的附件）。
  //   18 号 L-2：「本条目旧版本」不再把旧版本编号展开成占位符（版本数没有业务上限，展开会撞上 SQLite 绑定参数上限而 500），
  //   改为联表 sysbuild_item_versions 用 item_id = ? 限定，并只认版本号小于新版本的行（新版本自己不算旧版本）；绑定与引用各一条查询。
  async function assertRefAttachments(q, refIds, pid, itemId, newVersionNo) {
    for (const id of refIds) {
      const att = await q.get('SELECT id, project_id, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [id]);
      if (!att || att.project_id !== pid) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
      if (att.deleted_at) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
      if (att.masked_at) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
      const bound = await q.get(
        `SELECT b.id AS id FROM sysbuild_attachment_bindings b JOIN sysbuild_item_versions iv ON iv.id = b.owner_id
          WHERE b.attachment_id = ? AND b.owner_type = 'item_version' AND iv.item_id = ? AND iv.version_no < ? LIMIT 1`,
        [id, itemId, newVersionNo]
      );
      const refd = bound ? null : await q.get(
        `SELECT r.id AS id FROM sysbuild_attachment_refs r JOIN sysbuild_item_versions iv ON iv.id = r.owner_id
          WHERE r.attachment_id = ? AND r.owner_type = 'item_version' AND iv.item_id = ? AND iv.version_no < ? LIMIT 1`,
        [id, itemId, newVersionNo]
      );
      if (!bound && !refd) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
    }
  }

  // ── 视图 ───────────────────────────────────────────────────────────────────────────────────
  const itemTarget = (item, user) => ({ isCreator: Number(item.created_by) === Number(user.id) });
  async function attachmentsOfVersion(q, versionId) {
    const rows = await q.all(
      `SELECT b.attachment_id AS attachment_id, 'bound' AS via, a.original_name AS original_name, a.masked_at AS masked_at, a.masked_by AS masked_by, a.mask_reason AS mask_reason,
              a.deleted_at AS deleted_at, a.deleted_by AS deleted_by, a.mime_type AS mime_type, a.size AS size, a.sha256 AS sha256, a.is_image AS is_image,
              COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
         FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id
         LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
        WHERE b.owner_type = 'item_version' AND b.owner_id = ?
       UNION ALL
       SELECT r.attachment_id AS attachment_id, 'ref' AS via, a.original_name AS original_name, a.masked_at AS masked_at, a.masked_by AS masked_by, a.mask_reason AS mask_reason,
              a.deleted_at AS deleted_at, a.deleted_by AS deleted_by, a.mime_type AS mime_type, a.size AS size, a.sha256 AS sha256, a.is_image AS is_image,
              COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
         FROM sysbuild_attachment_refs r JOIN sysbuild_attachments a ON a.id = r.attachment_id
         LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
        WHERE r.owner_type = 'item_version' AND r.owner_id = ?
        ORDER BY attachment_id`,
      [versionId, versionId]
    );
    // Q8：附件名经 attachmentDisplayName 构造（attachments.js 的唯一实现；SELECT 必须带 masked_at）——遮蔽后不返回原名（置 null，另给 masked 标志）。
    //   §10.3：遮蔽后普通成员看到「已遮蔽（原因、操作人、时间）」与 SHA-256；删除后记录里显示「已删除」与删除人。遮蔽 / 删除相关字段只在发生时才有值。
    return rows.map((a) => ({
      attachment_id: a.attachment_id, via: a.via,
      original_name: attachmentDisplayName(a), mime_type: a.mime_type, size: a.size, sha256: a.sha256, is_image: a.is_image === 1,
      ...attachmentStateFields(a),
    }));
  }
  const VERSION_COLS = 'id, item_id, version_no, content, quote_text, proposer_name, proposer_member_id, proposer_party_id, occasion, proposed_on, proposer_status, deny_reason, no_written_evidence, no_evidence_reason, created_by, created_at';
  async function buildItemView(q, access, item, versions, cur, user) {
    const entry = hasKey(cur.byItem, item.id) ? cur.byItem[item.id] : null;
    const currentVersion = entry ? versions.find((v) => v.id === entry.item_version_id) : null;
    const t = itemTarget(item, user);
    const vs = [];
    for (const v of versions) {
      const proposer = v.proposer_member_id === null ? null : await q.get('SELECT COALESCE(u.display_name, u.username, m.person_name) AS name FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?', [v.proposer_member_id]);
      const proposerTasks = await q.all(
        `SELECT t.id AS task_id, r.id AS revision_id, r.rev_no AS rev_no, r.status AS status,
                r.required_member_id AS required_member_id, COALESCE(u.display_name, u.username, m.person_name) AS required_name, m.user_id AS required_user_id
           FROM sysbuild_confirm_tasks t JOIN sysbuild_confirm_task_revisions r ON r.task_id = t.id
           LEFT JOIN sysbuild_members m ON m.id = r.required_member_id LEFT JOIN users u ON u.id = m.user_id
          WHERE t.object_type = 'item_version' AND t.object_version_id = ? AND r.rev_no = (SELECT MAX(r2.rev_no) FROM sysbuild_confirm_task_revisions r2 WHERE r2.task_id = t.id) ORDER BY t.id`, [v.id]
      );
      vs.push({
        id: v.id, version_no: v.version_no, content: v.content, quote_text: v.quote_text,
        proposer_name: v.proposer_name, proposer_member_id: v.proposer_member_id, proposer_party_id: v.proposer_party_id,
        occasion: v.occasion, proposed_on: v.proposed_on, proposer_status: v.proposer_status, deny_reason: v.deny_reason,
        no_written_evidence: v.no_written_evidence === 1, no_evidence_reason: v.no_evidence_reason, created_by: v.created_by, created_at: v.created_at,
        attachments: await attachmentsOfVersion(q, v.id),
        proposer_display_name: proposer ? proposer.name : v.proposer_name,
        confirm_tasks: proposerTasks.map((task) => ({ task_id: task.task_id, revision_id: task.revision_id, rev_no: task.rev_no, status: task.status, required_member_id: task.required_member_id, required_name: task.required_name, proxy_only: task.required_user_id === null })),
      });
    }
    return {
      id: item.id, project_id: item.project_id, code: item.code, module_id: item.module_id, created_by: item.created_by, created_at: item.created_at,
      in_effective_plan: !!entry,
      current_version_id: entry ? entry.item_version_id : null,
      committed_batch_id: entry ? entry.committed_batch_id : null,
      pending_version_ids: currentVersion ? versions.filter((v) => v.version_no > currentVersion.version_no).map((v) => v.id) : [],
      versions: vs,
      actions: {
        new_version: rules.opAllowed('item_version_create', access, access.project, t),
        set_module: rules.opAllowed('item_set_module', access, access.project, t),
      },
    };
  }
  async function itemViewById(q, iid, user) {
    const { item, access } = await loadItemCtx(q, iid, user);
    const versions = await q.all(`SELECT ${VERSION_COLS} FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no`, [iid]);
    const cur = await resolveCurrentPlan(q, item.project_id);
    return buildItemView(q, access, item, versions, cur, user);
  }

  // ── 模块 ───────────────────────────────────────────────────────────────────────────────────
  router.post('/sysbuild/projects/:id/modules', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['name']);
    const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const access = await loadProjectCtx(q, pid, user);
      const taken = await q.get('SELECT id FROM sysbuild_modules WHERE project_id = ? AND name = ?', [pid, name]);
      rules.assertOp('module_create', access, access.project, { nameTaken: !!taken });
      const ins = await q.run('INSERT INTO sysbuild_modules (project_id, name, created_by) VALUES (?, ?, ?)', [pid, name, Number(user.id)]);
      await emit(q, user, pid, 'module', ins.lastID, 'module_created', { name });
      return { module: { id: ins.lastID, project_id: pid, name } };
    });
    res.status(201).json(out);
  }));

  router.patch('/sysbuild/modules/:mid', parseJsonBody, handle(async (req, res) => {
    const mid = readIdParam(req.params.mid, 'mid', '模块编号');
    const body = bodyOf(req);
    onlyKeys(body, ['name']);
    const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const mod = await q.get('SELECT id, project_id, name FROM sysbuild_modules WHERE id = ?', [mid]);
      if (!mod) throw rules.notFound();
      const access = await loadProjectCtx(q, mod.project_id, user);
      const taken = await q.get('SELECT id FROM sysbuild_modules WHERE project_id = ? AND name = ? AND id <> ?', [mod.project_id, name, mid]);
      rules.assertOp('module_rename', access, access.project, { nameTaken: !!taken });
      let changed = false;
      if (name !== mod.name) {
        const r = await q.run('UPDATE sysbuild_modules SET name = ? WHERE id = ? AND name = ?', [name, mid, mod.name]);
        if (r.changes === 0) throw stateError('模块已变化，请刷新后重试');
        await emit(q, user, mod.project_id, 'module', mid, 'module_renamed', { before: mod.name, after: name });
        changed = true;
      }
      return { module: { id: mid, project_id: mod.project_id, name }, changed };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/items：登记需求条目（条目 + 版本 1 同一事务）─────────────────────────────────
  router.post('/sysbuild/projects/:id/items', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['module_id', 'content', 'quote_text', 'proposer_member_id', 'proposer_name', 'proposer_party_id', 'occasion', 'proposed_on', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
    const content = readText(body.content, 'content', '需求内容', CONTENT_MAX, true);
    const quote = readText(body.quote_text, 'quote_text', '原话要点', QUOTE_MAX, false);
    const occasion = readText(body.occasion, 'occasion', '提出场合', OCCASION_MAX, false);
    const proposedOn = readOptionalDate(body.proposed_on, 'proposed_on', '提出日期');
    const moduleId = body.module_id === undefined || body.module_id === null ? null : readIdParam(body.module_id, 'module_id', '模块');
    const group = readProposerGroup(body);
    if (!group.given) throw invalid('提出人必填：本项目成员，或无账号提出人姓名', 'proposer_member_id');
    const attachmentIds = readIdList(body.attachment_ids, 'attachment_ids', '附件编号');
    const ev = readEvidenceFields(body);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const access = await loadProjectCtx(q, pid, user);
      rules.assertOp('item_create', access, access.project, {});
      if (moduleId !== null) await assertModuleInProject(q, moduleId, pid);
      const proposer = await resolveProposer(q, group, pid);
      assertEvidence(attachmentIds.length, ev);
      const mx = await q.get('SELECT COALESCE(MAX(CAST(substr(code, 3) AS INTEGER)), 0) AS m FROM sysbuild_items WHERE project_id = ?', [pid]);
      const code = 'R-' + String(mx.m + 1).padStart(2, '0');
      const it = await q.run('INSERT INTO sysbuild_items (project_id, code, module_id, created_by) VALUES (?, ?, ?, ?)', [pid, code, moduleId, uid]);
      const vr = await q.run(
        `INSERT INTO sysbuild_item_versions (item_id, version_no, content, quote_text, proposer_name, proposer_member_id, proposer_party_id, occasion, proposed_on,
           proposer_status, no_written_evidence, no_evidence_reason, created_by) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [it.lastID, content, quote, proposer.name, proposer.memberId, proposer.partyId, occasion, proposedOn, ev.noEvidence ? 1 : 0, ev.noEvidence ? ev.noEvidenceReason : null, uid]
      );
      const bound = attachmentIds.length > 0
        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid, userId: uid, attachmentIds, ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) })
        : [];
      await emit(q, user, pid, 'item', it.lastID, 'item_created', {
        code, module_id: moduleId, item_version_id: vr.lastID, version_no: 1, proposer_member_id: proposer.memberId, proposer_name: proposer.name,
        proposer_party_id: proposer.partyId, attachment_ids: bound, no_written_evidence: ev.noEvidence,
      });
      // C4a P29：提出人是本项目有账号的成员 → 同一事务生成提出人确认任务与首条修订（并冻结本版本附件清单）；无账号 / 只填姓名不生成（C4b 代录）
      await confirmCore.createProposerTask(q, user, { projectId: pid, itemId: it.lastID, itemVersionId: vr.lastID, proposerMemberId: proposer.memberId, attachmentHelpers });
      return { item: await itemViewById(q, it.lastID, user) };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/items/:iid/versions：条目出新版本（S1）──────────────────────────────────────────────
  router.post('/sysbuild/items/:iid/versions', parseJsonBody, handle(async (req, res) => {
    const iid = readIdParam(req.params.iid, 'iid', '条目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['content', 'quote_text', 'proposer_member_id', 'proposer_name', 'proposer_party_id', 'occasion', 'proposed_on', 'attachment_ids', 'ref_attachment_ids', 'no_written_evidence', 'no_evidence_reason']);
    const content = readText(body.content, 'content', '需求内容', CONTENT_MAX, true);
    const quote = readText(body.quote_text, 'quote_text', '原话要点', QUOTE_MAX, false);
    const occasion = readText(body.occasion, 'occasion', '提出场合', OCCASION_MAX, false);
    const proposedOn = readOptionalDate(body.proposed_on, 'proposed_on', '提出日期');
    const group = readProposerGroup(body);
    const attachmentIds = readIdList(body.attachment_ids, 'attachment_ids', '附件编号');
    const refIds = readIdList(body.ref_attachment_ids, 'ref_attachment_ids', '沿用附件编号');
    const ev = readEvidenceFields(body);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const { item, access } = await loadItemCtx(q, iid, user);
      rules.assertOp('item_version_create', access, access.project, itemTarget(item, user));
      const old = await q.all('SELECT id, version_no, proposer_name, proposer_member_id, proposer_party_id FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no', [iid]);
      const prev = old[old.length - 1];
      // 未给的提出人字段整组沿用上一版本（沿用的是历史事实，不重新校验成员是否仍在）；给了任一字段就按新登记同样的规则校验整组。
      const proposer = group.given
        ? await resolveProposer(q, group, item.project_id)
        : { memberId: prev.proposer_member_id, name: prev.proposer_name, partyId: prev.proposer_party_id };
      const versionNo = prev.version_no + 1;
      if (refIds.length > 0) await assertRefAttachments(q, refIds, item.project_id, iid, versionNo);
      assertEvidence(attachmentIds.length + refIds.length, ev);
      const vr = await q.run(
        `INSERT INTO sysbuild_item_versions (item_id, version_no, content, quote_text, proposer_name, proposer_member_id, proposer_party_id, occasion, proposed_on,
           proposer_status, no_written_evidence, no_evidence_reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [iid, versionNo, content, quote, proposer.name, proposer.memberId, proposer.partyId, occasion, proposedOn, ev.noEvidence ? 1 : 0, ev.noEvidence ? ev.noEvidenceReason : null, uid]
      );
      const bound = attachmentIds.length > 0
        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: item.project_id, userId: uid, attachmentIds, ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) })
        : [];
      for (const aid of refIds) {
        await q.run("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'item_version', ?, ?)", [item.project_id, aid, vr.lastID, uid]);
        await emit(q, user, item.project_id, 'attachment', aid, 'attachment_referenced', { owner_type: 'item_version', owner_id: vr.lastID, item_id: iid });
      }
      await emit(q, user, item.project_id, 'item', iid, 'item_version_created', {
        item_version_id: vr.lastID, version_no: versionNo, attachment_ids: bound, ref_attachment_ids: refIds, no_written_evidence: ev.noEvidence,
      });
      // C4a P29：旧版本仍待确认的提出人修订 → superseded；新版本的提出人（沿用上一版本或本次给出的）是有账号的现任成员时生成新任务
      await confirmCore.supersedeProposerRevisions(q, user, item.project_id, iid, vr.lastID);
      await confirmCore.createProposerTask(q, user, { projectId: item.project_id, itemId: iid, itemVersionId: vr.lastID, proposerMemberId: proposer.memberId, attachmentHelpers });
      return { item: await itemViewById(q, iid, user), item_version_id: vr.lastID };
    });
    res.status(201).json(out);
  }));

  // ── PATCH /sysbuild/items/:iid：改所属模块（可置空）────────────────────────────────────────────────────
  router.patch('/sysbuild/items/:iid', parseJsonBody, handle(async (req, res) => {
    const iid = readIdParam(req.params.iid, 'iid', '条目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['module_id']);
    if (!hasKey(body, 'module_id')) throw invalid('module_id 必填（置空传 null）', 'module_id');
    const moduleId = body.module_id === null ? null : readIdParam(body.module_id, 'module_id', '模块');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { item, access } = await loadItemCtx(q, iid, user);
      rules.assertOp('item_set_module', access, access.project, itemTarget(item, user));
      if (moduleId !== null) await assertModuleInProject(q, moduleId, item.project_id);
      let changed = false;
      if (moduleId !== item.module_id) {
        const r = await q.run('UPDATE sysbuild_items SET module_id = ? WHERE id = ? AND module_id IS ?', [moduleId, iid, item.module_id]);
        if (r.changes === 0) throw stateError('条目已变化，请刷新后重试');
        await emit(q, user, item.project_id, 'item', iid, 'item_module_changed', { before: item.module_id, after: moduleId });
        changed = true;
      }
      return { item: await itemViewById(q, iid, user), changed };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/projects/:id/items ─────────────────────────────────────────────────────────────────
  router.get('/sysbuild/projects/:id/items', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const user = req.user;
    const out = await db.withRead(async (q) => {
      const access = await loadProjectCtx(q, pid, user);
      const cur = await resolveCurrentPlan(q, pid);
      const modules = await q.all('SELECT id, name FROM sysbuild_modules WHERE project_id = ? ORDER BY id', [pid]);
      const items = await q.all('SELECT id, project_id, code, module_id, created_by, created_at FROM sysbuild_items WHERE project_id = ? ORDER BY id', [pid]);
      const views = [];
      for (const item of items) {
        const versions = await q.all(`SELECT ${VERSION_COLS} FROM sysbuild_item_versions WHERE item_id = ? ORDER BY version_no`, [item.id]);
        views.push(await buildItemView(q, access, item, versions, cur, user));
      }
      return {
        project_id: pid,
        overall_version_id: cur.overall_version_id,
        modules: modules.map((m) => ({ id: m.id, name: m.name, actions: { rename: rules.opAllowed('module_rename', access, access.project, { nameTaken: false }) } })),
        items: views,
        actions: {
          create_item: rules.opAllowed('item_create', access, access.project, {}),
          create_module: rules.opAllowed('module_create', access, access.project, { nameTaken: false }),
        },
      };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/items/:iid ─────────────────────────────────────────────────────────────────────────
  router.get('/sysbuild/items/:iid', handle(async (req, res) => {
    const iid = readIdParam(req.params.iid, 'iid', '条目编号');
    const out = await db.withRead(async (q) => ({ item: await itemViewById(q, iid, req.user) }));
    res.json(out);
  }));

  return { router };
}

module.exports = { createItemRoutes };
