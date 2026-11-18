// L1：送审范围与开发评估事实。所有查询只读；提交和评估只能从本文件取得将冻结的内容。
// 将来增加任何可冻结内容，必须加进 readSubmissionScope；不得给 submitVersion 增设独立取数路径。
'use strict';
const crypto = require('crypto');
const rules = require('./rules');
const { makeError } = require('./db');
const core = require('./confirm-core');
const entriesCore = require('./entries-core');
const materialsCore = require('./materials-core');
const { readAttachmentSet } = require('./attachments');
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
const internal = (message) => makeError(500, 'SYSBUILD_INTERNAL', '内部错误：' + message);
const EVIDENCE_REASON_MIN = 10;
// 延迟读取 packages 的导出，避免 packages.versionFactsOf → 本文件形成初始化循环。
const loadFoldedSet = (...args) => require('./packages').loadFoldedSet(...args);
const setList = (...args) => require('./packages').setList(...args);
const resolveCurrentPlan = (...args) => require('./packages').resolveCurrentPlan(...args);

async function evidenceCount(q, itemVersionId) {
  const r = await q.get(
    `SELECT COUNT(*) AS n FROM sysbuild_attachments a
      WHERE a.deleted_at IS NULL
        AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'item_version' AND owner_id = ?
                     UNION SELECT attachment_id FROM sysbuild_attachment_refs WHERE owner_type = 'item_version' AND owner_id = ?)`,
    [itemVersionId, itemVersionId]
  );
  return r.n;
}
// 总体规划包版本：集合非空；每个条目版本属本项目；每条都有承诺批次；承诺批次属本项目、未转出 / 未被替代；已上线条目不能换到未上线批次；方向类证据按
//   「未软删除的绑定 ∪ 引用」重核。违反时按固定优先级抛第一类，文案列出条目编号。返回折叠后的集合（升序）。
async function recheckOverallSet(q, pkg, ver) {
  const pid = pkg.project_id;
  const set = setList(await loadFoldedSet(q, ver.id));
  if (set.length === 0) throw stateError('总体规划的条目集合为空，请先添加条目');
  const cur = await resolveCurrentPlan(q, pid);
  const bad = { project: [], noBatch: [], batchGone: [], structure: [], liveMove: [], liveFrozen: [], evidence: [] };
  // C5 S-S1c：第一期只有默认批次，变更包版本里承诺批次只能是默认批次——批次转出 / 拆分 / 合并（sysbuild_batch_relations、batches.transfer_change_id）第二期才开放，改变批次结构的变更 409
  const defaultBatch = pkg.type === 'change' ? await q.get('SELECT id FROM sysbuild_batches WHERE project_id = ? AND is_default = 1', [pid]) : null;
  const batchCache = {};
  const batchOf = async (bid) => {
    if (!hasKey(batchCache, bid)) batchCache[bid] = await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [bid, pid]) || null;
    return batchCache[bid];
  };
  // C6a：「已正式上线」的判据 = entriesCore.batchLiveState（与分流同一个函数），不再读 batches.status = 'live'
  const liveCache = {};
  const isLive = async (bid) => {
    if (!hasKey(liveCache, bid)) liveCache[bid] = (await entriesCore.batchLiveState(q, bid)).live;
    return liveCache[bid];
  };
  for (const it of set) {
    const row = await q.get(
      `SELECT it.code AS code, it.project_id AS project_id, iv.no_written_evidence AS no_written_evidence, iv.no_evidence_reason AS no_evidence_reason
         FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?`,
      [it.item_version_id]
    );
    const label = row ? row.code : `条目版本#${it.item_version_id}`;
    if (!row || row.project_id !== pid) { bad.project.push(label); continue; }
    if (it.committed_batch_id === null) bad.noBatch.push(label);
    else {
      const batch = await batchOf(it.committed_batch_id);
      if (!batch || rules.BATCH_FROZEN_STATUSES.includes(batch.status)) bad.batchGone.push(label);
      else if (pkg.type === 'change' && (!defaultBatch || batch.id !== defaultBatch.id)) bad.structure.push(label);
      else if (hasKey(cur.byItem, it.item_id)) {
        const was = await batchOf(cur.byItem[it.item_id].committed_batch_id);
        if (was && (await isLive(was.id)) && !(await isLive(batch.id))) bad.liveMove.push(label);
      }
    }
    const n = await evidenceCount(q, it.item_version_id);
    const reasonOk = row.no_written_evidence === 1 && typeof row.no_evidence_reason === 'string' && Array.from(row.no_evidence_reason.trim()).length >= EVIDENCE_REASON_MIN;
    if (n === 0 && !reasonOk) bad.evidence.push(label);
  }
  // P163 / P169 / P170：已上线批次的承诺条目版本集合冻结。判定只有一份（entries-core.liveFreezeBreaches，变更生效时 confirm-core.applyChangeEffect 再用同一份核一次）：
  //   frozen = 往已上线批次加条目 / 给已承诺到已上线批次的条目换版本 / 把条目移入已上线批次；removed = 现行规划里承诺到已上线批次的条目被移出（预筛 M6：上线的事实不因变更消失，
  //   后续增强请建新条目；只对变更包）。已上线的判据 = 批次状态 live 或 batchLiveState（P170，冻结属编辑类守卫，上线后同一秒内也冻结）。
  const breaches = await entriesCore.liveFreezeBreaches(q, cur.byItem, set);
  const codeOfItem = async (id) => {
    const r = await q.get('SELECT code FROM sysbuild_items WHERE id = ?', [id]);
    return r ? r.code : `条目#${id}`;
  };
  for (const id of breaches.frozen) bad.liveFrozen.push(await codeOfItem(id));
  const liveRemoved = [];
  if (pkg.type === 'change') for (const id of breaches.removed) liveRemoved.push(await codeOfItem(id));
  const list = (arr) => arr.join('、');
  if (liveRemoved.length > 0 && bad.project.length === 0 && bad.noBatch.length === 0 && bad.batchGone.length === 0 && bad.structure.length === 0 && bad.liveMove.length === 0) throw stateError(`已上线条目不能移出规划，后续增强请建新条目：${list(liveRemoved)}`);
  if (bad.project.length > 0) throw stateError(`以下条目版本不属于本项目：${list(bad.project)}`);
  if (bad.noBatch.length > 0) throw stateError(`以下条目没有承诺批次：${list(bad.noBatch)}`);
  if (bad.batchGone.length > 0) throw stateError(`以下条目的承诺批次已转出、被替代或不属于本项目：${list(bad.batchGone)}`);
  if (bad.structure.length > 0) throw stateError(`第二期开放：本期变更不能改变批次结构，承诺批次只能是默认批次，以下条目的承诺批次不是默认批次：${list(bad.structure)}`);
  if (bad.liveMove.length > 0) throw stateError(`以下条目已在已上线批次，不能换到未上线批次：${list(bad.liveMove)}`);
  if (bad.liveFrozen.length > 0) throw stateError(`已上线批次的承诺条目版本集合已冻结，不能新增、换版本或移入，后续增强请建新条目：${list(bad.liveFrozen)}`);
  if (bad.evidence.length > 0) throw stateError(`以下条目版本的方向类证据已不齐（附件被删除或未声明无书面证据）：${list(bad.evidence)}`);
  return set;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

// L2：声明只在立项包使用；缺键表示未声明，给了键就必须是可复核的 10–500 字文本。
function readNoWrittenBasisReason(snapshot) {
  const value = materialsCore.snapshotObject(snapshot);
  if (!hasKey(value, 'no_written_basis_reason')) return null;
  const raw = value.no_written_basis_reason;
  const reason = typeof raw === 'string' ? raw.trim() : null;
  if (reason === null || Array.from(reason).length < 10 || Array.from(reason).length > 500 || rules.hasControlChar(reason)) {
    throw Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', '无书面立项依据原因须为 10–500 字且不含控制字符'), { field: 'snapshot_json.no_written_basis_reason' });
  }
  return reason;
}

// L2：读接口与提交门共用。材料、可用附件只消费送审范围已读的那一份；这里只补查节点身份。
// 提交事务最后一次调用传入即将冻结的 scope，不能再自行选材料或读附件。
async function initiationBasisOf(q, pkg, ver, scope) {
  try {
    if (pkg.type !== 'initiation') return { fact: 'missing' };
    const current = scope || await readSubmissionScope(q, pkg, ver);
    const reason = readNoWrittenBasisReason(current.snapshot);
    const nodes = await q.all("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [pkg.project_id]);
    const nodeIds = new Set(nodes.map((node) => node.id));
    // L2 initiation: only selected initiation-node material with usable attachment qualifies.
    const hasBasis = current.materials.some((material) => nodeIds.has(material.node_id)
      && material.attachments.some((attachment) => !attachment.deleted && !attachment.masked));
    return { fact: hasBasis || reason !== null ? 'ok' : 'missing' };
  } catch (err) {
    // 保留原材料等业务拒绝，不把非法材料包装成「请补立项依据」；其他取数失败仍保守拒绝。
    return isBusinessRejection(err)
      ? { fact: 'missing', scopeRejection: { status: err.status, code: err.code, message: err.message } }
      : { fact: 'missing' };
  }
}

async function readSubmissionScope(q, pkg, ver) {
  const items = pkg.type === 'overall' || pkg.type === 'change' ? await recheckOverallSet(q, pkg, ver) : [];
  const calc = await require('./packages').computeFormAndParent(q, pkg);
  const snapshot = canonicalJson(materialsCore.snapshotObject(ver.snapshot_json));
  const nodePlans = await core.currentNodePlans(q, pkg.project_id);
  const materials = await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: true });
  const change = pkg.type === 'change' ? await q.get('SELECT id, title FROM sysbuild_changes WHERE package_id = ?', [pkg.id]) : null;
  if (pkg.type === 'change' && !change) throw internal('变更包没有对应的变更');
  const owners = items.map((it) => ({ ownerType: 'item_version', ownerId: it.item_version_id }));
  owners.push({ ownerType: 'package_version', ownerId: ver.id });
  if (change) owners.push({ ownerType: 'change', ownerId: change.id });
  const attachmentSources = [];
  const manifest = [];
  for (const owner of owners) {
    const rows = await readAttachmentSet(q, { ...owner, projectId: pkg.project_id });
    attachmentSources.push({ ...owner, rows });
    for (const r of rows) manifest.push({ source_type: owner.ownerType, source_id: owner.ownerId, attachment_id: r.attachment_id, sha256: r.sha256 });
  }
  for (const material of materials) for (const r of material.frozen) {
    manifest.push({ source_type: 'material_version', source_id: material.id, attachment_id: r.attachment_id, sha256: r.sha256 });
  }
  // 材料的原冻结散列不能被其它来源的同名附件覆盖。沿用 freezeSelectedMaterials 的一致性约束。
  const hashes = Object.create(null);
  for (const r of manifest) {
    if (hasKey(hashes, r.attachment_id) && hashes[r.attachment_id] !== r.sha256) throw internal('内容包重复附件的冻结hash不一致');
    hashes[r.attachment_id] = r.sha256;
  }
  const digestInput = {
    version_id: ver.id, // L1 scope: version
    items: items.slice().sort((a, b) => a.item_version_id - b.item_version_id).map((it) => [it.item_version_id, it.committed_batch_id]), // L1 scope: items
    snapshot, // L1 scope: snapshot
    form_and_parent: calc, // L1 scope: form
    node_plans: nodePlans.map((n) => [n.node_id, n.planned_start, n.planned_end]).sort((a, b) => a[0] - b[0]), // L1 scope: plans
    attachments: manifest.sort((a, b) => (a.source_type < b.source_type ? -1 : a.source_type > b.source_type ? 1 : 0) || a.source_id - b.source_id || a.attachment_id - b.attachment_id), // L1 scope: attachments
  };
  const scope_digest = crypto.createHash('sha256').update(JSON.stringify(digestInput)).digest('hex');
  return { items, snapshot, calc, nodePlans, materials, change, attachmentSources, digestInput, scope_digest };
}

// 送审内容本身不合法（集合重核、材料可用性等 400 / 409 业务拒绝）不是「评估取不到」：原样带回拒绝原因，由提交规则在评估事实之前报出（51 号 HIGH-1）。
const isBusinessRejection = (err) => !!err && (err.status === 400 || err.status === 409) && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_');
// 调用方在读接口和提交事务里共用本函数；取数失败只给 unknown，不能回退到较旧评估。
async function devAssessmentOf(q, pkg, ver, scope) {
  try {
    const partyId = await entriesCore.devPartyIdOf(q, pkg.project_id);
    const ever = partyId === null ? null : await q.get('SELECT id FROM sysbuild_appointments WHERE party_id = ? AND effective_at IS NOT NULL LIMIT 1', [partyId]);
    if (!ever) return { fact: 'exempt', payload: { exempt: 'dev_never_joined' } };
    const change = await q.get('SELECT id FROM sysbuild_changes WHERE package_id = ? AND project_id = ?', [pkg.id, pkg.project_id]);
    if (!change) return { fact: 'unknown', payload: null };
    const rows = await q.all(`SELECT ${entriesCore.ENTRY_COLS} FROM sysbuild_entries
      WHERE project_id = ? AND purpose = 'dev_note'
        AND id NOT IN (SELECT entry_id FROM sysbuild_entry_actions WHERE action = 'void')
      ORDER BY id DESC`, [pkg.project_id]);
    const { readEntryForm } = require('./entry-forms');
    let latest = null;
    let latestForm = null;
    let unreadableId = 0;
    for (const entry of rows) {
      const parsed = readEntryForm(entry);
      if (parsed.form_unreadable) unreadableId = Math.max(unreadableId, entry.id);
      if (!latest && parsed.form_kind === 'dev_assessment' && parsed.form.about_change_id === change.id) {
        latest = entry;
        latestForm = parsed.form;
      }
    }
    if (unreadableId > (latest ? latest.id : 0)) return { fact: 'unknown', payload: null };
    let fact = 'none';
    let payload = null;
    if (latest) {
      const approved = await entriesCore.devConfirmOf(q, latest);
      if (approved.status !== 'approved') fact = 'not_approved';
      else {
        let current = scope;
        if (!current) {
          try { current = await readSubmissionScope(q, pkg, ver); } catch (err) {
            if (!isBusinessRejection(err)) throw err;
            return { fact: 'unknown', payload: null, scopeRejection: { status: err.status, code: err.code, message: err.message } };
          }
        }
        if (latestForm.package_version_id !== ver.id || latestForm.scope_digest !== current.scope_digest) fact = 'stale';
        else {
          const confirmation = await q.get("SELECT created_at FROM sysbuild_confirmations WHERE task_revision_id = ? AND decision = 'confirm' ORDER BY id DESC LIMIT 1", [approved.revision.id]);
          if (!confirmation) return { fact: 'unknown', payload: null };
          fact = 'ok';
          payload = { entry_id: latest.id, scope_digest: latestForm.scope_digest, confirm_task_revision_id: approved.revision.id, approved_by_member_id: approved.revision.required_member_id, approved_at: confirmation.created_at };
        }
      }
    }
    if (['none', 'not_approved', 'stale'].includes(fact) && !(await core.currentOwner(q, partyId))) fact = 'dev_lead_vacant';
    return { fact, payload };
  } catch (_) {
    return { fact: 'unknown', payload: null };
  }
}
module.exports = { readSubmissionScope, recheckOverallSet, devAssessmentOf, canonicalJson, readNoWrittenBasisReason, initiationBasisOf };
