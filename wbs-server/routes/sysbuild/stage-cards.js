'use strict';

const { makeError } = require('./db');
const { hasControlChar } = require('./rules');
const { ACCEPTANCE_NODE_KEYS, ACTIVE_BATCH_STATUSES } = require('./templates');
const { currentScopePlans } = require('./scope-plans');
const materialCore = require('./materials-core');
const { batchLiveState } = require('./entries-core');

const CUSTOM_PREFIX = 'required-custom-';
const MATERIALS = Object.freeze({
  'initiation-basis': { name: '立项依据', required: true, declare: true },
  'contract-order': { name: '合同或订单', required: true, declare: true },
  'requirements-document': { name: '需求文档', required: true, attachments: true },
  'acceptance-record': { name: '验收记录', required: true, attachments: true },
  'operations-handover': { name: '运维交接材料', required: true, declare: true },
  'prototype-design': { name: '原型或设计稿', required: false },
  'test-report': { name: '测试报告', required: false },
  'user-manual': { name: '操作手册', required: false },
});
const PROTOTYPE_KEYS = Object.freeze({ outsource: 'b_design', procurement: 'b_config', inhouse: 'b_dev' });
const TEST_KEYS = Object.freeze({ outsource: 'b_test', procurement: 'b_training', inhouse: 'b_golive' });
const BASIS_KEYS = Object.freeze({ initiation: 'initiation-basis', overall: 'requirements-document', batch_accept: 'acceptance-record' });
const requiresAttachments = (key) => MATERIALS[key]?.attachments === true;

function nodeCards(buildType, node) {
  const result = [];
  const material = (key) => result.push({ key, kind: 'material', ...MATERIALS[key] });
  const confirm = (key, name) => result.push({ key, kind: 'confirmation', name, required: true });
  const automatic = (key, name) => result.push({ key, kind: 'automatic', name, required: true });
  if (node.batch_id === null) {
    if (node.template_key === 'p_initiation') { material('initiation-basis'); confirm('initiation', '立项确认'); }
    if (node.template_key === 'p_contract' && buildType !== 'inhouse') material('contract-order');
    if (node.template_key === 'p_overall') { material('requirements-document'); confirm('overall', '范围确认'); automatic('project-plan', '项目计划'); }
    if (node.template_key === 'p_closing') confirm('closing', '结项确认');
    return result;
  }
  if (node.template_key === ACCEPTANCE_NODE_KEYS[buildType]) { material('acceptance-record'); confirm('batch_accept', '验收确认'); }
  if (node.is_golive_milestone === 1) {
    automatic('golive', '正式上线记录');
    material('operations-handover');
    material('user-manual');
  }
  if (node.template_key === PROTOTYPE_KEYS[buildType]) material('prototype-design');
  if (node.template_key === TEST_KEYS[buildType]) material('test-report');
  return result;
}

function classifyMaterial(buildType, node, key, row) {
  if (Object.hasOwn(MATERIALS, key)) {
    return nodeCards(buildType, node).find((card) => card.key === key) || { invalid: 'wrong_stage' };
  }
  if (key.startsWith(CUSTOM_PREFIX)) {
    return row && /^required-custom-[1-9][0-9]*$/.test(key)
      ? { key, kind: 'material', name: row.name, required: true, declare: true, custom: true }
      : { invalid: 'missing_custom' };
  }
  return null;
}

function validReason(value) {
  if (typeof value !== 'string' || hasControlChar(value)) return null;
  const text = value.trim();
  const length = Array.from(text).length;
  return length >= 10 && length <= 500 ? text : null;
}

function frozenReason(snapshot) {
  return validReason(materialCore.snapshotObject(snapshot).no_written_basis_reason);
}

async function materialState(q, projectId, nodeId, descriptor, row) {
  const material = row === undefined
    ? await q.get('SELECT id, name FROM sysbuild_materials WHERE node_id = ? AND material_key = ?', [nodeId, descriptor.key]) : row;
  if (!material) return { qualified: [], declaration: null, afterConfirmation: [] };
  const versions = await q.all('SELECT id FROM sysbuild_material_versions WHERE material_id = ? ORDER BY version_no DESC', [material.id]);
  const qualified = [];
  for (const version of versions) {
    const [selected] = await materialCore.selectedMaterials(q, projectId, { material_version_ids: [version.id] }, { usable: false });
    if (materialCore.isQualifiedVersion(selected)) qualified.push(version.id);
  }
  let declaration = null;
  if (!qualified.length && descriptor.declare) {
    const latest = await q.get(
      "SELECT id, payload_json FROM sysbuild_events WHERE project_id = ? AND object_type = 'material' AND object_id = ? AND event_type = 'material_not_applicable' ORDER BY id DESC LIMIT 1",
      [projectId, material.id]
    );
    if (latest) {
      const upload = versions.length ? await q.get(
        "SELECT id FROM sysbuild_events WHERE project_id = ? AND object_type = 'material_version' AND object_id = ? AND event_type = 'material_version_created' ORDER BY id DESC LIMIT 1",
        [projectId, versions[0].id]
      ) : null;
      const reason = validReason(JSON.parse(latest.payload_json)?.reason);
      if (reason && (!versions.length || (upload && latest.id > upload.id))) declaration = { id: latest.id, reason };
    }
  }
  let afterConfirmation = [];
  if (versions.length && descriptor.key === 'requirements-document') {
    const effective = await q.get(
      `SELECT e.id FROM sysbuild_packages p JOIN sysbuild_package_versions v ON v.package_id = p.id AND v.status = 'effective'
        JOIN sysbuild_events e ON e.project_id = p.project_id AND e.object_type = 'package_version' AND e.object_id = v.id
         AND e.event_type = 'package_version_effective'
       WHERE p.project_id = ? AND p.type = 'overall' ORDER BY e.id DESC LIMIT 1`, [projectId]
    );
    if (effective) {
      const uploads = await q.all(
        `SELECT v.id FROM sysbuild_material_versions v JOIN sysbuild_events e ON e.object_type = 'material_version' AND e.object_id = v.id
          WHERE v.material_id = ? AND e.project_id = ? AND e.event_type = 'material_version_created' AND e.id > ?`,
        [material.id, projectId, effective.id]
      );
      afterConfirmation = uploads.map((v) => v.id);
    }
  }
  return { qualified, declaration, afterConfirmation };
}

async function submissionBasis(q, pkg, buildType, selected) {
  const key = BASIS_KEYS[pkg.type];
  if (!key) return { ok: true, declaration: null };
  const expectedKey = pkg.type === 'initiation' ? 'p_initiation' : pkg.type === 'overall' ? 'p_overall' : ACCEPTANCE_NODE_KEYS[buildType];
  const nodes = await q.all(
    'SELECT id, status FROM sysbuild_nodes WHERE project_id = ? AND template_key = ? AND batch_id IS ?',
    [pkg.project_id, expectedKey, pkg.type === 'batch_accept' ? pkg.batch_id : null]
  );
  if (nodes.length !== 1 || nodes[0].status === 'cancelled') return { ok: false, declaration: null };
  const nodeId = nodes[0].id;
  if (selected.some((m) => m.node_id === nodeId && m.material_key === key && materialCore.isQualifiedVersion(m))) return { ok: true, declaration: null };
  if (pkg.type !== 'initiation') return { ok: false, declaration: null };
  const state = await materialState(q, pkg.project_id, nodeId, { key, ...MATERIALS[key] });
  return { ok: !!state.declaration, declaration: state.declaration };
}

async function loadProjectCards(q, project) {
  const nodes = await q.all(
    `SELECT n.id, n.batch_id, n.name, n.template_key, n.status, n.is_golive_milestone, b.status AS batch_status, b.name AS batch_name
       FROM sysbuild_nodes n LEFT JOIN sysbuild_batches b ON b.id = n.batch_id AND b.project_id = n.project_id
      WHERE n.project_id = ?
      ORDER BY CASE WHEN n.batch_id IS NULL AND n.template_key = 'p_closing' THEN 2 WHEN n.batch_id IS NULL THEN 0 ELSE 1 END, b.seq, n.sort_order, n.id`,
    [project.id]
  );
  const versions = await q.all(
    `SELECT p.type, p.batch_id, v.id, v.snapshot_json
       FROM sysbuild_packages p JOIN sysbuild_package_versions v ON v.package_id = p.id AND v.status = 'effective'
      WHERE p.project_id = ?`, [project.id]
  );
  const effective = Object.fromEntries(versions.map((v) => [`${v.type}:${v.batch_id}`, v]));
  const plan = await currentScopePlans(q, project.id, project.build_type);
  const result = [];
  for (const node of nodes) {
    if (node.status === 'cancelled' || (node.batch_id !== null && !ACTIVE_BATCH_STATUSES.includes(node.batch_status))) continue;
    const stored = await q.all('SELECT id, name, material_key FROM sysbuild_materials WHERE node_id = ? ORDER BY id', [node.id]);
    const byKey = Object.fromEntries(stored.map((row) => [row.material_key, row]));
    const defs = nodeCards(project.build_type, node);
    for (const m of stored) {
      const custom = classifyMaterial(project.build_type, node, m.material_key, m);
      if (custom?.custom) defs.push(custom);
    }
    for (const card of defs) {
      const view = { ...card, node_id: node.id, node_name: node.name, batch_id: node.batch_id, batch_name: node.batch_name };
      if (card.kind === 'confirmation') {
        view.complete = Object.hasOwn(effective, `${card.key}:${node.batch_id}`);
      } else if (card.kind === 'automatic') {
        view.complete = card.key === 'project-plan' ? plan.blocked === null : (await batchLiveState(q, node.batch_id)).live;
      } else {
        const row = byKey[card.key] || null;
        const state = await materialState(q, project.id, node.id, card, row);
        const initiation = card.key === 'initiation-basis' ? effective['initiation:null'] : null;
        let frozen = false;
        if (initiation) {
          const chosen = await materialCore.assertMaterialFreezes(q, project.id, initiation);
          frozen = !!frozenReason(initiation.snapshot_json) || chosen.some((m) => m.node_id === node.id && m.material_key === card.key && m.attachments.length > 0);
        }
        view.material_id = row?.id ?? null;
        view.qualified_version_ids = state.qualified;
        view.after_confirmation_version_ids = state.afterConfirmation;
        view.declaration = state.declaration;
        view.complete = initiation ? frozen : state.qualified.length > 0 || !!state.declaration;
      }
      result.push(view);
    }
  }
  return result;
}

const missingCards = (cards, includeClosing) => cards.filter((c) => c.required && !c.complete && (includeClosing || c.key !== 'closing'));
function missingCardNames(cards) {
  return cards.map((c) => `${c.node_name}${c.batch_name ? '（' + c.batch_name + '）' : ''} · ${c.name}`).join('、');
}

const stateError = (message) => Object.assign(makeError(409, 'SYSBUILD_STATE', message), { field: 'key' });
function assertPlacement(descriptor) {
  if (descriptor?.invalid === 'wrong_stage') throw stateError('此材料卡片不适用于当前阶段');
  if (descriptor?.invalid === 'missing_custom') throw stateError('请先在当前阶段建立这张材料卡片');
}

module.exports = { CUSTOM_PREFIX, classifyMaterial, requiresAttachments, materialState, validReason, frozenReason, submissionBasis, loadProjectCards, missingCards, missingCardNames, assertPlacement };
