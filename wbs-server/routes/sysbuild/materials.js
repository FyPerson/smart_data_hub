// C8 准备稿：定稿材料候选版本。只追加；由被生效内容包引用的版本确定执行依据。
'use strict';
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const materials = require('./materials-core');
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const operatorNameOf = (user) => user.display_name || user.username || 'user#' + user.id;
function readId(raw, field) {
  const id = rules.parseId(raw);
  if (!id) throw invalid('编号不合法', field);
  return id;
}
function readText(raw, field, max, required) {
  if (raw === undefined || raw === null) { if (required) throw invalid('请填写材料名称', field); return null; }
  if (typeof raw !== 'string' || rules.hasControlChar(raw)) throw invalid('文本格式不正确', field);
  const text = raw.trim();
  if (!text && required) throw invalid('请填写材料名称', field);
  if (Array.from(text).length > max) throw invalid('文本超过 ' + max + ' 字', field);
  return text || null;
}
function readIds(raw, field) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw invalid('附件列表最多20项', field);
  const ids = raw.map((id) => readId(id, field));
  if (new Set(ids).size !== ids.length) throw invalid('附件编号重复', field);
  return ids;
}
function createMaterialRoutes(ctx) {
  for (const key of ['db', 'logger', 'readonlyIds', 'writeRoles', 'attachmentHelpers']) if (ctx[key] === undefined) throw new Error('routes/sysbuild/materials 缺参数: ' + key);
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set) || !(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) throw new Error('routes/sysbuild/materials 的账号集合格式不正确');
  if (typeof ctx.attachmentHelpers.bindStagedAttachments !== 'function' || typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') throw new Error('routes/sysbuild/materials 缺附件助手');
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  function sendError(res, err) {
    if (res.headersSent) return;
    if (err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_')) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      if (err.status >= 500) logger.error('[sysbuild] 材料接口内部错误: ' + err.message);
      return res.status(err.status).json(body);
    }
    logger.error('[sysbuild] 材料接口内部错误: ' + (err && err.message || String(err)));
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((err) => sendError(res, err)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '128kb' })(req, res, (err) => err ? sendError(res, invalid('请求体不是合法的JSON对象', 'body')) : next());
  async function loadNode(q, nodeId, user) {
    const node = await q.get('SELECT id, project_id, batch_id, name, status FROM sysbuild_nodes WHERE id = ?', [nodeId]);
    if (!node) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, node.project_id, user, accessOpts());
    rules.assertVisible(access);
    const batch = node.batch_id === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [node.batch_id, node.project_id]);
    if (node.batch_id !== null && !batch) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：材料节点所属批次不存在');
    return { node, access, target: { nodeStatus: node.status, batchStatus: batch ? batch.status : undefined } };
  }
  // 只限本材料的旧版本，不把项目内其他任意附件当成可沿用来源。
  async function assertRefs(q, refIds, projectId, materialId, versionNo) {
    for (const id of refIds) {
      const a = await q.get('SELECT id, project_id, deleted_at, masked_at FROM sysbuild_attachments WHERE id = ?', [id]);
      if (!a || a.project_id !== projectId || a.deleted_at || a.masked_at) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
      const bound = await q.get(
        `SELECT b.id AS id FROM sysbuild_attachment_bindings b JOIN sysbuild_material_versions v ON v.id = b.owner_id
          WHERE b.attachment_id = ? AND b.owner_type = 'material_version' AND v.material_id = ? AND v.version_no < ? LIMIT 1`, [id, materialId, versionNo]
      );
      const ref = bound ? null : await q.get(
        `SELECT r.id AS id FROM sysbuild_attachment_refs r JOIN sysbuild_material_versions v ON v.id = r.owner_id
          WHERE r.attachment_id = ? AND r.owner_type = 'material_version' AND v.material_id = ? AND v.version_no < ? LIMIT 1`, [id, materialId, versionNo]
      );
      if (!bound && !ref) throw invalid('附件不存在或不可沿用', 'ref_attachment_ids');
    }
  }
  router.post('/sysbuild/nodes/:nid/materials/:key/versions', parseJsonBody, handle(async (req, res) => {
    const nodeId = readId(req.params.nid, 'nid');
    const key = req.params.key;
    if (typeof key !== 'string' || !/^[a-z][a-z0-9_-]{0,59}$/.test(key)) throw invalid('材料标识不合法', 'key');
    const body = req.body === undefined ? {} : req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('请求体必须是JSON对象', 'body');
    for (const field of Object.keys(body)) if (!['name', 'body', 'attachment_ids', 'ref_attachment_ids'].includes(field)) throw invalid('不支持的字段 ' + field, field);
    const name = readText(body.name, 'name', 100, false);
    const text = readText(body.body, 'body', 12000, false);
    const attachmentIds = readIds(body.attachment_ids, 'attachment_ids');
    const refIds = readIds(body.ref_attachment_ids, 'ref_attachment_ids');
    if (attachmentIds.length + refIds.length > 20 || new Set(attachmentIds.concat(refIds)).size !== attachmentIds.length + refIds.length) throw invalid('每版最多20个不重复附件', 'attachment_ids');
    if (text === null && attachmentIds.length + refIds.length === 0) throw invalid('材料须有正文或附件', 'body');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadNode(q, nodeId, user);
      rules.assertOp('material_version_create', c.access, c.access.project, c.target);
      let material = await q.get('SELECT id, name FROM sysbuild_materials WHERE node_id = ? AND material_key = ?', [nodeId, key]);
      if (!material) {
        if (name === null) throw invalid('新材料须填写名称', 'name');
        const ins = await q.run('INSERT INTO sysbuild_materials (node_id, material_key, name) VALUES (?, ?, ?)', [nodeId, key, name]);
        material = { id: ins.lastID, name };
        await writeEvent(q, { projectId: c.node.project_id, objectType: 'material', objectId: material.id, eventType: 'material_created', payload: { node_id: nodeId, material_key: key }, operatorId: Number(user.id), operatorName: operatorNameOf(user) });
      } else if (name !== null && name !== material.name) throw invalid('材料名称已确定；新版本不修改材料名称', 'name');
      const last = await q.get('SELECT COALESCE(MAX(version_no), 0) AS n FROM sysbuild_material_versions WHERE material_id = ?', [material.id]);
      const versionNo = last.n + 1;
      await assertRefs(q, refIds, c.node.project_id, material.id, versionNo);
      const version = await q.run('INSERT INTO sysbuild_material_versions (material_id, version_no, body, created_by) VALUES (?, ?, ?, ?)', [material.id, versionNo, text, Number(user.id)]);
      const uid = Number(user.id);
      const operatorName = operatorNameOf(user);
      await attachmentHelpers.bindStagedAttachments(q, { projectId: c.node.project_id, userId: uid, attachmentIds, ownerType: 'material_version', ownerId: version.lastID, operatorName });
      for (const id of refIds) {
        await q.run("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'material_version', ?, ?)", [c.node.project_id, id, version.lastID, uid]);
        await writeEvent(q, { projectId: c.node.project_id, objectType: 'attachment', objectId: id, eventType: 'attachment_referenced', payload: { owner_type: 'material_version', owner_id: version.lastID }, operatorId: uid, operatorName });
      }
      await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'material_version', objectVersionId: version.lastID, ownerType: 'material_version', ownerId: version.lastID, projectId: c.node.project_id, operatorId: uid, operatorName });
      await writeEvent(q, { projectId: c.node.project_id, objectType: 'material_version', objectId: version.lastID, eventType: 'material_version_created', payload: { node_id: nodeId, material_id: material.id, version_no: versionNo }, operatorId: uid, operatorName });
      return { material: { id: material.id, node_id: nodeId, material_key: key, name: material.name }, version: { id: version.lastID, version_no: versionNo, body: text }, attachment_ids: attachmentIds.concat(refIds) };
    });
    res.status(201).json(out);
  }));
  router.get('/sysbuild/projects/:id/materials', handle(async (req, res) => {
    const projectId = readId(req.params.id, 'id');
    const out = await db.withRead(async (q) => {
      const access = await rules.loadProjectAccess(q, projectId, req.user, accessOpts());
      rules.assertVisible(access);
      const nodes = await q.all('SELECT id, name FROM sysbuild_nodes WHERE project_id = ? ORDER BY sort_order, id', [projectId]);
      const nodeViews = [];
      const items = [];
      for (const n of nodes) {
        const c = await loadNode(q, n.id, req.user);
        const canCreate = rules.opAllowed('material_version_create', c.access, c.access.project, c.target);
        nodeViews.push({ id: n.id, name: n.name, actions: { create_version: canCreate } });
        const rows = await q.all('SELECT id, material_key, name FROM sysbuild_materials WHERE node_id = ? ORDER BY id', [n.id]);
        for (const m of rows) {
          const versions = await q.all('SELECT id FROM sysbuild_material_versions WHERE material_id = ? ORDER BY version_no', [m.id]);
          const versionViews = [];
          for (const version of versions) versionViews.push(await materials.materialView(q, await materials.materialVersionRecord(q, version.id)));
          items.push({ id: m.id, node_id: n.id, material_key: m.material_key, name: m.name, versions: versionViews, actions: { new_version: canCreate } });
        }
      }
      return { project_id: projectId, nodes: nodeViews, materials: items };
    });
    res.json(out);
  }));
  router.get('/sysbuild/material-versions/:vid', handle(async (req, res) => {
    const versionId = readId(req.params.vid, 'vid');
    const out = await db.withRead(async (q) => {
      const record = await materials.materialVersionRecord(q, versionId);
      if (!record) throw rules.notFound();
      const c = await loadNode(q, record.node_id, req.user);
      return { version: await materials.materialView(q, record), actions: { new_version: rules.opAllowed('material_version_create', c.access, c.access.project, c.target) } };
    });
    res.json(out);
  }));
  return { router };
}
module.exports = { createMaterialRoutes };
