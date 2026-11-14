// C8 准备稿：材料版本引用与冻结助手。不依赖 packages / confirm-core，避免环。
'use strict';
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { attachmentDisplayName } = require('./attachments');
const { attachmentStateFields } = require('./attachments');
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), { field: field || 'material_version_ids' });
const internal = (message) => makeError(500, 'SYSBUILD_INTERNAL', '内部错误：' + message);
function snapshotObject(raw) {
  if (typeof raw === 'string') {
    try { return snapshotObject(JSON.parse(raw)); } catch (err) { if (err && err.code === 'SYSBUILD_INVALID_INPUT') throw err; throw internal('内容包快照无法解析'); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('内容包快照必须是对象', 'snapshot_json');
  return raw;
}
function materialIdsOf(raw) {
  const snap = snapshotObject(raw);
  if (!has(snap, 'material_version_ids')) return [];
  const ids = snap.material_version_ids;
  if (!Array.isArray(ids) || ids.length > 100 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw invalid('材料版本列表须为至多100个正整数编号');
  if (new Set(ids).size !== ids.length) throw invalid('材料版本编号不能重复');
  return ids.slice();
}
async function boundMaterialAttachments(q, versionId) {
  return q.all(
    `SELECT a.id AS attachment_id, a.project_id AS project_id, a.sha256 AS sha256, a.original_name AS original_name,
            a.mime_type AS mime_type, a.size AS size, a.is_image AS is_image, a.deleted_at AS deleted_at, a.deleted_by AS deleted_by,
            a.masked_at AS masked_at, a.masked_by AS masked_by, a.mask_reason AS mask_reason,
            COALESCE(mu.display_name, mu.username) AS masked_by_name, COALESCE(du.display_name, du.username) AS deleted_by_name
       FROM sysbuild_attachments a LEFT JOIN users mu ON mu.id = a.masked_by LEFT JOIN users du ON du.id = a.deleted_by
      WHERE a.id IN (
        SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'material_version' AND owner_id = ?
        UNION SELECT attachment_id FROM sysbuild_attachment_refs WHERE owner_type = 'material_version' AND owner_id = ?
      ) ORDER BY a.id`,
    [versionId, versionId]
  );
}
function attachmentPublicView(a, frozenHash) {
  return {
    attachment_id: a.attachment_id, sha256: frozenHash === undefined ? a.sha256 : frozenHash,
    name: attachmentDisplayName(a), original_name: attachmentDisplayName(a), mime_type: a.mime_type, size: a.size, is_image: a.is_image === 1,
    masked: !!a.masked_at, masked_at: a.masked_at, masked_by: a.masked_by, masked_by_name: a.masked_by_name, mask_reason: a.mask_reason,
    deleted: !!a.deleted_at, deleted_at: a.deleted_at, deleted_by: a.deleted_by, deleted_by_name: a.deleted_by_name,
    ...attachmentStateFields(a),
  };
}
async function materialVersionRecord(q, versionId) {
  return q.get(
    `SELECT v.id AS id, v.material_id AS material_id, v.version_no AS version_no, v.body AS body, v.created_by AS created_by, v.created_at AS created_at,
            m.node_id AS node_id, m.material_key AS material_key, m.name AS name, n.project_id AS project_id, n.name AS node_name,
            COALESCE(u.display_name, u.username) AS created_by_name
       FROM sysbuild_material_versions v JOIN sysbuild_materials m ON m.id = v.material_id
       JOIN sysbuild_nodes n ON n.id = m.node_id LEFT JOIN users u ON u.id = v.created_by WHERE v.id = ?`,
    [versionId]
  );
}
// 所有引用入口共用：草稿编辑 / 普通提交 / 历史导入 / 生效（含变更派生）都核同一项目与同一材料不得选两版。
// usable=true：新增引用或发起时拒绝已删除 / 已遮蔽的附件；纯读旧快照不重写、不丢失已遮蔽事实。
async function selectedMaterials(q, projectId, snapshot, options) {
  const ids = materialIdsOf(snapshot);
  const materialIds = new Set();
  const out = [];
  for (const id of ids) {
    const record = await materialVersionRecord(q, id);
    if (!record || record.project_id !== projectId) throw invalid('材料版本不存在或不属于本项目');
    if (materialIds.has(record.material_id)) throw invalid('同一材料在一个内容包版本中只能引用一版');
    materialIds.add(record.material_id);
    const bound = await boundMaterialAttachments(q, id);
    const frozen = await q.all("SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'material_version' AND object_version_id = ? ORDER BY attachment_id", [id]);
    if (bound.length !== frozen.length || bound.some((a, i) => a.attachment_id !== frozen[i].attachment_id || a.project_id !== projectId || a.sha256 !== frozen[i].sha256)) throw internal('材料附件与其冻结清单不一致');
    if (options && options.usable && bound.some((a) => a.deleted_at || a.masked_at)) throw invalid('材料含已删除或已遮蔽的附件，不能新增引用，请建立可复核的新版本');
    out.push(Object.assign({}, record, { attachments: bound.map((a, i) => attachmentPublicView(a, frozen[i].sha256)), frozen }));
  }
  return out;
}
// 包版本冻结不读最新材料、不重新计算已冻结附件的hash。只追加原材料版本的冻结编号与hash。
async function freezeSelectedMaterials(q, args) {
  const { projectId, versionId, operatorId, operatorName } = args;
  const snapshot = await packageMaterialSnapshot(q, projectId, versionId);
  const selected = await selectedMaterials(q, projectId, snapshot, { usable: true });
  for (const material of selected) for (const attachment of material.frozen) {
    const exists = await q.get("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", [versionId, attachment.attachment_id]);
    if (exists) {
      if (exists.sha256 !== attachment.sha256) throw internal('内容包重复附件的冻结hash不一致');
      continue;
    }
    await q.run("INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES ('package_version', ?, ?, ?)", [versionId, attachment.attachment_id, attachment.sha256]);
    await writeEvent(q, {
      projectId, objectType: 'attachment', objectId: attachment.attachment_id, eventType: 'attachment_frozen',
      payload: { object_type: 'package_version', object_version_id: versionId, sha256: attachment.sha256, material_version_id: material.id }, operatorId, operatorName,
    });
  }
  return selected;
}
async function materialUses(q, projectId, versionId) {
  const rows = await q.all(
    `SELECT v.id AS package_version_id, v.version_no AS version_no, v.status AS status, v.snapshot_json AS snapshot_json, p.type AS package_type, p.batch_id AS batch_id
       FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? ORDER BY v.id`, [projectId]
  );
  return rows.filter((r) => materialIdsOf(r.snapshot_json).includes(versionId)).map((r) => ({ package_version_id: r.package_version_id, version_no: r.version_no, status: r.status, package_type: r.package_type, batch_id: r.batch_id }));
}
async function materialView(q, record) {
  const checked = await selectedMaterials(q, record.project_id, { material_version_ids: [record.id] }, { usable: false });
  return Object.assign({}, record, { attachments: checked[0].attachments, uses: await materialUses(q, record.project_id, record.id) });
}
async function packageMaterialSnapshot(q, projectId, versionId) {
  const saved = await q.get('SELECT v.snapshot_json AS snapshot_json, p.project_id AS project_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE v.id = ?', [versionId]);
  if (!saved || saved.project_id !== projectId) throw internal('材料引用所在内容包版本不存在或不属于本项目');
  return saved.snapshot_json;
}
async function assertMaterialFreezes(q, projectId, version) {
  const snapshot = await packageMaterialSnapshot(q, projectId, version.id);
  const selected = await selectedMaterials(q, projectId, snapshot, { usable: false });
  for (const material of selected) for (const attachment of material.frozen) {
    const row = await q.get("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ? AND attachment_id = ?", [version.id, attachment.attachment_id]);
    if (!row || row.sha256 !== attachment.sha256) throw internal('内容包缺少引用材料的原始冻结附件');
  }
  return selected;
}
module.exports = { snapshotObject, materialIdsOf, selectedMaterials, freezeSelectedMaterials, assertMaterialFreezes, boundMaterialAttachments, materialVersionRecord, materialView, attachmentPublicView };
