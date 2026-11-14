// routes/sysbuild/packages.js — 项目管理（系统建设记录）模块：内容包与版本、条目集合修订、现行版本解析（C3b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 1–4、§2.3（总体规划单一身份）、§4.5、§5.2、§6.2、§6.3、§7。
//   派单 = docs/local/系统建设记录/送审准备/C3b_模块条目内容包_派单_20261030.md。
//
// 工厂 createPackageRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles }。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY
//   → 对象状态 409 SYSBUILD_STATE → 业务规则（400 / 409）。权限 / 项目状态 / 对象状态三步全部经 rules.assertOp（OBJECT_OPS + OP_KIND），
//   读接口的逐对象 actions 用 rules.opAllowed 与同一个 target 构造函数——同一张表同一个顺序，前端不推算。
// 本文件只做内容包「草稿期」：建包、建草稿版本、编辑 snapshot、修订条目集合。提交确认 / 生效 / 替代是 C4。
'use strict';
const materialsCore = require('./materials-core');
const express = require('express');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const confirmCore = require('./confirm-core'); // 依赖只有 rules / db / events，不回头 require 本文件（无环）：提交标志的「必需确认人是否齐全」事实
const entriesCore = require('./entries-core'); // C6a：结项包提交前置 closingFactsOf（entries-core 依赖 rules / db / events / confirm-core，不回头 require 本文件，无环）

const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_DEPTH = 64;

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
// 请求体：没有请求体（undefined / null）按空对象；存在却不是普通对象（含数组）→ 400（codex 17 号 L-1）。
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

// ── 条目集合折叠与现行版本解析（纯函数 + 取数）────────────────────────────────────────────────────
// 修订行 → 当前集合：按 id 升序回放；add 放入 item_id → { item_id, item_version_id, committed_batch_id }，remove 按 item_id 移出。
//   同一条目重复 add 写入时已拒（package_item_add 的 inSet 判定）；折叠时遇到仍按最后一次为准。
function foldRevisions(rows) {
  const byItem = {};
  for (const r of rows) {
    if (r.op === 'add') byItem[r.item_id] = { item_id: r.item_id, item_version_id: r.item_version_id, committed_batch_id: r.committed_batch_id };
    else if (r.op === 'remove') delete byItem[r.item_id];
  }
  return byItem;
}
async function loadRevisionRows(q, versionId) {
  return q.all(
    `SELECT r.id AS id, r.op AS op, r.item_version_id AS item_version_id, r.committed_batch_id AS committed_batch_id, iv.item_id AS item_id
       FROM sysbuild_package_item_revisions r JOIN sysbuild_item_versions iv ON iv.id = r.item_version_id
      WHERE r.package_version_id = ? ORDER BY r.id`,
    [versionId]
  );
}
async function loadFoldedSet(q, versionId) {
  return foldRevisions(await loadRevisionRows(q, versionId));
}
const setList = (byItem) => Object.keys(byItem).map((k) => byItem[k]).sort((a, b) => a.item_id - b.item_id);

// 现行版本解析函数（方案 §2.2 不变量 2，**单一来源**）：
//   取本项目总体规划包的已生效版本（至多一个，uq_sysbuild_package_versions_effective + uq_sysbuild_packages_project_single 保证），折叠其条目集合，
//   返回 { overall_version_id, byItem }，byItem[item_id] = { item_id, item_version_id, committed_batch_id, overall_version_id }；
//   没有生效版本时 overall_version_id 为 null、byItem 为空对象。
//   条目派生：现行版本 = byItem 里的 item_version_id；版本号大于现行版本的为「待处理版本」；不在 byItem 里的条目没有现行版本（读接口标「未入生效规划」）。
//   **分流判定、判定快照、总体换版影响判断都必须调用本函数、读同一个版本**（C4 / C5 不得另写取数）。
//   C3 无法经生产路径产生已生效版本——测试用夹具把总体规划版本直接置为 effective，C4 生效路径就绪后改为生产路径复验。
async function resolveCurrentPlan(q, projectId) {
  const effId = await effectiveOverallVersionId(q, projectId);
  if (effId === null) return { overall_version_id: null, byItem: {} };
  const byItem = await loadFoldedSet(q, effId);
  for (const k of Object.keys(byItem)) byItem[k].overall_version_id = effId;
  return { overall_version_id: effId, byItem };
}
// 本项目总体规划包的已生效版本编号（没有则 null）。resolveCurrentPlan 与 C4a 的「基线随生效形成 / 生效后首次设计划写基线」共用这一处定义。
async function effectiveOverallVersionId(q, projectId) {
  const eff = await q.get(
    `SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,
    [projectId]
  );
  return eff ? eff.id : null;
}

// 本项目立项包的已生效版本编号（没有则 null）。提交总体规划包的 G0 前置（P37）读它：提交标志（读接口 actions.submit）与提交执行都经 versionFactsOf 取这一处。
async function effectiveInitiationVersionId(q, projectId) {
  const eff = await q.get(
    `SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
      WHERE p.project_id = ? AND p.type = 'initiation' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,
    [projectId]
  );
  return eff ? eff.id : null;
}

// 提交确认的项目级事实（C4a 修订批二 MED-1）：提交标志与提交执行**同源**——两端都用本函数的结果构造 target，由 rules.OBJECT_OPS.package_version_submit 统一判定，
//   端点里不再另写一份「立项包是否生效 / 必需确认人是否齐全」的判断。只对开放提交的包类型（rules.SUBMITTABLE_PACKAGE_TYPES）取：
//   confirmersMissing（P23：null = 齐全，否则 { noParty, missing }）、initiationEffective（P37：只对总体规划包取）与 planMissing（codex 19 号 H-1 / P43：
//   总体规划包提交前应形成基线的节点计划须齐全，null = 齐全，否则缺计划节点的标签数组；form 取 computeFormAndParent 的提交时重算值）。其余类型返回空对象。
//   标志承诺的范围见 rules.js package_version_submit：权限、对象状态、立项前置、确认人齐全、计划齐全；条目集合的提交时重核（P24）只在执行时做，仍可能 409。
async function versionFactsOf(q, pkg, ver) {
  // parentSuperseded（C5 S-S1c，C4 / C5 交接）：草稿建立时继承的总体规划版本（parent_overall_version_id）已被替代。批次包（第一期没有）与变更包共用；所有类型都取，规则层只在 === true 时拒绝。
  const facts = {};
  if (ver && ver.parent_overall_version_id !== null && ver.parent_overall_version_id !== undefined) {
    const p = await q.get('SELECT status FROM sysbuild_package_versions WHERE id = ?', [ver.parent_overall_version_id]);
    facts.parentSuperseded = !!p && p.status === 'superseded';
  } else facts.parentSuperseded = false;
  if (!rules.SUBMITTABLE_PACKAGE_TYPES.includes(pkg.type)) return facts;
  // historyConflict（C4b Q-S2，P58）：历史补录窗口开启期间该内容包已有历史导入 / 历史补录记录 → 文案，否则 null；提交标志与执行同源。
  //   变更包（C5 S-S1c）= 自身 ∪ 总体规划包（confirm-core.historyPackageIdsOf：变更生效会替换总体规划包的生效版本，预筛 M3：并集不是替换）。
  facts.confirmersMissing = await confirmCore.confirmersMissing(q, pkg.project_id, pkg.type);
  facts.historyConflict = await confirmCore.packageHistoryConflict(q, pkg.project_id, await confirmCore.historyPackageIdsOf(q, pkg));
  // C6a 待确认互斥（P139）：总体规划 / 变更 / 批次验收 / 结项四类里，项目内已有别的包的待确认版本 → 事实 = 该包的类型（取编号最小的一个，文案只指一个类型），否则 null；
  //   本包自己的版本不会是待确认（提交的是草稿；撤回 / 驳回后再提交时旧版本已是 superseded），所以排除本包只是防御。
  if (rules.EXCLUSIVE_PENDING_PACKAGE_TYPES.includes(pkg.type)) {
    const other = await q.get(
      `SELECT p.type AS type FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
        WHERE p.project_id = ? AND p.type IN (${rules.EXCLUSIVE_PENDING_SQL_LIST}) AND v.status = 'pending' AND p.id <> ? ORDER BY v.id LIMIT 1`,
      [pkg.project_id, pkg.id]
    );
    facts.otherPendingPackage = other ? other.type : null;
  }
  // C6a 结项包提交前置：每个有效批次已正式上线、已转出批次有已生效变更包（entries-core.closingFactsOf，p_closing 收口前置读同一个函数）；null = 满足
  if (pkg.type === 'closing') {
    const cf = await entriesCore.closingFactsOf(q, pkg.project_id);
    facts.closingNotReady = cf.notLive.length === 0 && cf.transferNoChange.length === 0
      ? null : { notLive: cf.notLive.map((b) => b.name), transferNoChange: cf.transferNoChange.map((b) => b.name) };
  }
  if (pkg.type === 'overall') {
    facts.initiationEffective = (await effectiveInitiationVersionId(q, pkg.project_id)) !== null;
    facts.planMissing = await confirmCore.planMissingNodes(q, pkg.project_id, (await computeFormAndParent(q, pkg)).form);
  }
  if (pkg.type === 'change') {
    const ch = await q.get('SELECT id, status, no_written_evidence, no_evidence_reason FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);
    facts.changeStatus = ch ? ch.status : undefined;
    // 预筛 M2：变更的方向类证据在建变更时校验过一次，提交时按「未软删除的绑定 ∪ 引用」重核（与 confirm.recheckOverallSet 的条目证据同口径）；读写两端同一个事实
    if (ch) {
      const n = await q.get(
        `SELECT COUNT(*) AS n FROM sysbuild_attachments a
          WHERE a.deleted_at IS NULL
            AND a.id IN (SELECT attachment_id FROM sysbuild_attachment_bindings WHERE owner_type = 'change' AND owner_id = ?
                         UNION SELECT attachment_id FROM sysbuild_attachment_refs WHERE owner_type = 'change' AND owner_id = ?)`,
        [ch.id, ch.id]
      );
      const reasonOk = ch.no_written_evidence === 1 && typeof ch.no_evidence_reason === 'string' && Array.from(ch.no_evidence_reason.trim()).length >= 10;
      facts.changeEvidenceOk = n.n > 0 || reasonOk;
    }
    const other = await q.get(
      "SELECT v.id AS id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id WHERE p.project_id = ? AND p.type = 'change' AND p.id <> ? AND v.status = 'pending' LIMIT 1",
      [pkg.project_id, pkg.id]
    );
    facts.otherChangePending = !!other;
  }
  return facts;
}

// 内容包版本动作（编辑 / 增删条目 / 提交 / 撤回）的 target 构造：读接口 actions 与写端点（本文件与 confirm.js）共用这一份。
//   facts = versionFactsOf 的结果（只有提交需要；编辑 / 增删条目 / 撤回不传）。
const versionTarget = (ver, pkg, batchStatus, facts) => Object.assign({ versionStatus: ver.status, packageType: pkg.type, batchStatus }, facts);

// form 与 parent_overall_version_id 按项目现状计算（建草稿版本与提交确认时的重算共用这一个函数，修订批二 LOW-4）：
//   form：只在总体规划包的版本上填写——本项目有效批次（非已转出 / 被替代）恰 1 个时为单批合并形态 overall_batch_req，否则 overall；
//   parent：批次包（挂批次的包）= 当前生效的总体规划版本（没有则空）；总体规划包与其余包为空。
//   C5 交接（主会话 11-01 裁定，S-S1c 已落实）：草稿的 parent 对应的总体版本已被替代 → 提交 409「请基于现行规划重建草稿」，不静默回写 parent——版本事实 parentSuperseded（versionFactsOf）进
//   rules.package_version_submit，批次需求包（第一期没有，类型本身不开放提交，纯规则用例）与变更包共用；变更包的 parent = 当前生效的总体规划版本（本函数的 change 分支）。
async function computeFormAndParent(q, pkg) {
  // C5 S-S1c：变更包版本 = 提议的下一版完整总体规划，继承来源 = 当前生效的总体规划版本（parent），形态照它（生效时新总体版本也照它）。提交时 parent 已被替代由规则层先 409（parentSuperseded），不走回写。
  if (pkg.type === 'change') {
    const effId = await effectiveOverallVersionId(q, pkg.project_id);
    const eff = effId === null ? null : await q.get('SELECT id, form FROM sysbuild_package_versions WHERE id = ?', [effId]);
    return { form: eff ? eff.form : null, parent: eff ? eff.id : null };
  }
  let form = null;
  if (pkg.type === 'overall') {
    const marks = rules.BATCH_FROZEN_STATUSES.map(() => '?').join(', ');
    const cnt = await q.get(`SELECT COUNT(*) AS n FROM sysbuild_batches WHERE project_id = ? AND status NOT IN (${marks})`, [pkg.project_id, ...rules.BATCH_FROZEN_STATUSES]);
    form = cnt.n === 1 ? 'overall_batch_req' : 'overall';
  }
  //   C6a：批次包（挂批次）与结项包都「只引用验收 / 结项时的现行版本」（§2.2 不变量 2、§4.3），parent 取当前生效的总体规划版本，建草稿与提交时都按现行版本重写。
  //   「引用的是现行版本」这件事由三处共同成立，缺一不可：① 本函数让建草稿与提交时的 parent = 当时的现行规划版本（草稿期间换版不拒绝，rules.package_version_submit 的 parentSuperseded 豁免）；
  //   ② 生效之后规划又经正式变更换版时，parent 就不再是现行版本——上线前置 ACCEPT_STALE（golive-core.goliveBlockersOf）与 p_closing 收口前置 CLOSING_STALE（plan.closeBlockers，
  //   事实 entries-core.closingFactsOf.closingStale）把这种过期的生效包挡在上线 / 结项之外（P168）；③ 重新确认的出路：已有生效版本的验收包 / 结项包可以建新草稿（rules.package_version_create 只拦
  //   总体规划包）、提交（parent 重写成现行）、确认生效（旧生效版本被替代）；待确认的规划类包期间不能上线（PLAN_PENDING）、有待确认内容包不能结项（PACKAGE_PENDING，P164）。
  let parentId = null;
  if (pkg.batch_id !== null || pkg.type === 'closing') parentId = await effectiveOverallVersionId(q, pkg.project_id);
  return { form, parent: parentId };
}

// 提交确认与历史事实导入（内容包生效）共用的「形态重算与回写」（P32，C4b Q-S2 预筛 LOW-3 从 confirm.js 抽出）：
//   按提交时的项目现状重算 form / parent_overall_version_id（computeFormAndParent）；与草稿存的值不同则在 status = 'draft' 条件下回写（条件更新，影响行数 0 → 409）。
//   返回 { calc, changed }：changed 只含发生变化的项（form_from / form_to / parent_from / parent_to），提交事件与导入事件的 payload 同名记录。
async function rewriteFormAndParent(q, pkg, ver) {
  const calc = await computeFormAndParent(q, pkg);
  const changed = {};
  if (ver.form !== calc.form || ver.parent_overall_version_id !== calc.parent) {
    const wb = await q.run(
      "UPDATE sysbuild_package_versions SET form = ?, parent_overall_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'",
      [calc.form, calc.parent, ver.id]
    );
    if (wb.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
    if (ver.form !== calc.form) { changed.form_from = ver.form; changed.form_to = calc.form; }
    if (ver.parent_overall_version_id !== calc.parent) { changed.parent_from = ver.parent_overall_version_id; changed.parent_to = calc.parent; }
  }
  return { calc, changed };
}

// 变更包的新草稿版本（C5 S-S1c，建变更与出新版本共用）：继承**当前生效的总体规划版本**（不是上一版变更草稿——上一版被异议或撤回时，现行规划才是可靠基线）的条目集合（折叠后逐条写 add 修订）、
//   snapshot_json 与 form；parent_overall_version_id 记继承来源。返回 { id, version_no, parent, form, copied }。调用方负责权限与状态判定（rules change_create / change_new_version）。
async function createChangeDraft(q, user, pkg) {
  const { form, parent } = await computeFormAndParent(q, pkg);
  if (parent === null) throw stateError('总体规划尚未生效，直接修改总体规划草稿');
  const prev = await q.get('SELECT MAX(version_no) AS n FROM sysbuild_package_versions WHERE package_id = ?', [pkg.id]);
  const versionNo = (prev && prev.n ? prev.n : 0) + 1;
  const base = await q.get('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [parent]);
  await materialsCore.selectedMaterials(q, pkg.project_id, base.snapshot_json, { usable: false });
  const ins = await q.run(
    "INSERT INTO sysbuild_package_versions (package_id, version_no, parent_overall_version_id, form, status, snapshot_json, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
    [pkg.id, versionNo, parent, form, base.snapshot_json, Number(user.id)]
  );
  let copied = 0;
  for (const it of setList(await loadFoldedSet(q, parent))) {
    await q.run(
      "INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)",
      [ins.lastID, it.item_version_id, it.committed_batch_id, Number(user.id)]
    );
    copied += 1;
  }
  await writeEvent(q, {
    projectId: pkg.project_id, objectType: 'package_version', objectId: ins.lastID, eventType: 'package_version_created',
    payload: { package_id: pkg.id, version_no: versionNo, form, parent_overall_version_id: parent, copied_items: copied, change: true },
    operatorId: Number(user.id), operatorName: operatorNameOf(user),
  });
  return { id: ins.lastID, version_no: versionNo, parent, form, copied };
}

function createPackageRoutes(ctx) {
  for (const k of ['db', 'logger']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/packages 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/packages 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/packages 参数 writeRoles 必须是数组或 Set');
  }
  const { db, logger } = ctx;
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
    logger.error(`[sysbuild] 内容包接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  // snapshot_json 上限 64KB，解析器上限放到 256kb，超限由本文件的字段级校验给出带 field 的 400。
  const parseJsonBody = (req, res, next) => express.json({ limit: '256kb' })(req, res, (err) => (
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

  // ── 加载 ───────────────────────────────────────────────────────────────────────────────
  async function loadPackageCtx(q, pkid, user) {
    const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [pkid]);
    if (!pkg) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, pkg.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { pkg, access, batchStatus: await batchStatusOf(q, pkg) };
  }
  // 批次包（batch_id 非空）所在批次的状态；项目级包没有批次，返回 undefined（D2：批次已转出 / 被替代时批次包的写动作一律拒绝）。
  async function batchStatusOf(q, pkg) {
    if (pkg.batch_id === null) return undefined;
    const b = await q.get('SELECT status FROM sysbuild_batches WHERE id = ?', [pkg.batch_id]);
    return b ? b.status : undefined;
  }
  async function loadVersionCtx(q, vid, user) {
    const ver = await q.get(
      'SELECT id, package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json, created_by, created_at, updated_at FROM sysbuild_package_versions WHERE id = ?',
      [vid]
    );
    if (!ver) throw rules.notFound();
    const { pkg, access, batchStatus } = await loadPackageCtx(q, ver.package_id, user);
    return { ver, pkg, access, batchStatus };
  }
  const listVersions = (q, pkid) => q.all('SELECT id, version_no, status FROM sysbuild_package_versions WHERE package_id = ? ORDER BY version_no, id', [pkid]);

  // target 构造（读写两端同一份）。versionTarget 在模块级定义并导出（C4a 预筛 L4：confirm.js 的提交 / 撤回与本文件的版本详情 actions 共用同一份）。
  const newVersionTarget = (versions, pkg, batchStatus) => ({
    packageType: pkg.type,
    hasDraft: versions.some((v) => v.status === 'draft'),
    hasPending: versions.some((v) => v.status === 'pending'),
    hasEffective: versions.some((v) => v.status === 'effective'),
    batchStatus,
  });
  function versionActions(access, ver, pkg, versions, batchStatus, facts) {
    const t = versionTarget(ver, pkg, batchStatus, facts);
    return {
      edit: rules.opAllowed('package_version_edit', access, access.project, t),
      add_item: rules.opAllowed('package_item_add', access, access.project, t),
      remove_item: rules.opAllowed('package_item_remove', access, access.project, t),
      // C4a：提交确认 / 撤回提交（与 confirm.js 的执行端点同一个动作判定与 target 构造；submit 的项目级事实 facts 由 versionFactsOf 取，读写两端同源）。
      //   submit 标志承诺：权限、对象状态、立项前置、确认人齐全；条目集合的提交时重核失败（P24）执行时仍可能 409。
      //   放在 new_version 之前：C3b 变异的锚点要求 new_version 是对象里的最后一项。
      submit: rules.opAllowed('package_version_submit', access, access.project, t),
      withdraw: rules.opAllowed('package_version_withdraw', access, access.project, t),
      // C4c：导出需求确认单（读动作，可见且版本已提交过即可；与 confirmation-sheet.js 的执行端点调用同一个判定 rules.canExportConfirmationSheet）。
      export_sheet: rules.canExportConfirmationSheet(access, ver),
      new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus)),
    };
  }
  function parseSnapshot(text) {
    try { return JSON.parse(text); } catch (_) { return {}; }
  }
  // 建包的「同类型包是否已存在」预查（写端点与读接口的 create_package_types 共用）。批次类型只在批次确属本项目时才查（batch 非空），
  //   否则对别项目的批次号会泄露「那个批次有没有验收包」（预筛 LOW-2）；batch 为空时端点后面会报 400。
  async function packageExists(q, pid, type, batchId, batch) {
    if (type === 'batch_req' || type === 'batch_accept') {
      return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));
    }
    if (type === 'change') return false;
    return !!(await q.get('SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = ?', [pid, type]));
  }
  // 递归检查 snapshot（预筛 LOW-1）：嵌套深度上限 SNAPSHOT_MAX_DEPTH（过深的结构交给数据库会以 500 暴露）；字符串值与对象键名拒收 C0 控制字符
  //   （保留 \n \r \t，与 rules.hasControlChar 同一判定，同自由文本入参一致）。违反 → 400 field snapshot_json。
  //   18 号 L-1：数字必须是有限数（1e400 解析成 Infinity，JSON.stringify 会把它静默改成 null，保存的内容就不是请求的内容）。
  function checkSnapshotValue(v, depth) {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw invalid('snapshot_json 的数字必须是有限数', 'snapshot_json');
      return;
    }
    if (typeof v === 'string') {
      if (rules.hasControlChar(v)) throw invalid('snapshot_json 的文本不能包含控制字符', 'snapshot_json');
      return;
    }
    if (v === null || typeof v !== 'object') return;
    if (depth > SNAPSHOT_MAX_DEPTH) throw invalid(`snapshot_json 嵌套不能超过 ${SNAPSHOT_MAX_DEPTH} 层`, 'snapshot_json');
    if (Array.isArray(v)) {
      for (const x of v) checkSnapshotValue(x, depth + 1);
      return;
    }
    for (const k of Object.keys(v)) {
      if (rules.hasControlChar(k)) throw invalid('snapshot_json 的键名不能包含控制字符', 'snapshot_json');
      checkSnapshotValue(v[k], depth + 1);
    }
  }

  // ── POST /sysbuild/projects/:id/packages：建包 ─────────────────────────────────────────────────
  router.post('/sysbuild/projects/:id/packages', parseJsonBody, handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const body = bodyOf(req);
    onlyKeys(body, ['type', 'batch_id']);
    if (typeof body.type !== 'string' || !schema.ENUMS.packageType.includes(body.type)) {
      throw invalid(`type 必须是 ${schema.ENUMS.packageType.join(' / ')} 之一`, 'type');
    }
    const type = body.type;
    const needsBatch = type === 'batch_req' || type === 'batch_accept';
    const givenBatch = body.batch_id !== undefined && body.batch_id !== null;
    let batchId = null;
    if (needsBatch) {
      if (!givenBatch) throw invalid('该类型的内容包必须指定批次', 'batch_id');
      batchId = readIdParam(body.batch_id, 'batch_id', '批次编号');
    } else if (givenBatch) {
      throw invalid('该类型的内容包不挂批次', 'batch_id');
    }
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
      rules.assertVisible(access);
      const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, pid]);
      const exists = await packageExists(q, pid, type, batchId, batch);
      rules.assertOp('package_create', access, access.project, { type, exists, batchStatus: batch ? batch.status : undefined });
      if (needsBatch && !batch) throw invalid('批次不存在或不属于本项目', 'batch_id');
      const ins = await q.run('INSERT INTO sysbuild_packages (project_id, batch_id, type, created_by) VALUES (?, ?, ?, ?)', [pid, batchId, type, Number(user.id)]);
      await emit(q, user, pid, 'package', ins.lastID, 'package_created', { type, batch_id: batchId });
      return { package: { id: ins.lastID, project_id: pid, batch_id: batchId, type } };
    });
    res.status(201).json(out);
  }));

  // ── POST /sysbuild/packages/:pkid/versions：新建草稿版本 ──────────────────────────────────────────
  router.post('/sysbuild/packages/:pkid/versions', parseJsonBody, handle(async (req, res) => {
    const pkid = readIdParam(req.params.pkid, 'pkid', '内容包编号');
    onlyKeys(bodyOf(req), []);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const { pkg, access, batchStatus } = await loadPackageCtx(q, pkid, user);
      const versions = await listVersions(q, pkid);
      rules.assertOp('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus));
      // form 与 parent_overall_version_id：与提交确认时的重算同一个函数（computeFormAndParent，修订批二 LOW-4）。
      const { form, parent: parentId } = await computeFormAndParent(q, pkg);
      const prev = versions.length > 0 ? versions[versions.length - 1] : null;
      const versionNo = prev ? prev.version_no + 1 : 1;
      // 新草稿的 snapshot_json 继承上一版本（与集合继承取同一个「上一版本」，预筛裁定「执行者没把握 3」）；没有上一版本则为空对象。
      const prevSnapshot = prev ? (await q.get('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [prev.id])).snapshot_json : '{}';
      await materialsCore.selectedMaterials(q, pkg.project_id, prevSnapshot, { usable: false });
      const ins = await q.run(
        "INSERT INTO sysbuild_package_versions (package_id, version_no, parent_overall_version_id, form, status, snapshot_json, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
        [pkid, versionNo, parentId, form, prevSnapshot, uid]
      );
      // S4：新草稿版本的初始条目集合 = 上一个版本（最大 version_no）的集合，逐条写 op=add 修订，created_by = 操作人。
      let copied = 0;
      if (prev) {
        const prevSet = setList(await loadFoldedSet(q, prev.id));
        for (const it of prevSet) {
          await q.run(
            "INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, 'add', ?)",
            [ins.lastID, it.item_version_id, it.committed_batch_id, uid]
          );
          copied += 1;
        }
      }
      await emit(q, user, pkg.project_id, 'package_version', ins.lastID, 'package_version_created', {
        package_id: pkid, version_no: versionNo, form, parent_overall_version_id: parentId, copied_items: copied,
      });
      return { version: { id: ins.lastID, package_id: pkid, version_no: versionNo, status: 'draft', form, parent_overall_version_id: parentId }, copied_items: copied };
    });
    res.status(201).json(out);
  }));

  // ── PATCH /sysbuild/package-versions/:vid：编辑草稿 snapshot_json ───────────────────────────────────
  router.patch('/sysbuild/package-versions/:vid', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const body = bodyOf(req);
    onlyKeys(body, ['snapshot_json']);
    const snap = body.snapshot_json;
    if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) throw invalid('snapshot_json 必须是 JSON 对象', 'snapshot_json');
    checkSnapshotValue(snap, 1);
    const text = JSON.stringify(snap);
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > SNAPSHOT_MAX_BYTES) throw invalid(`snapshot_json 序列化后不能超过 ${SNAPSHOT_MAX_BYTES / 1024}KB`, 'snapshot_json');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      rules.assertOp('package_version_edit', access, access.project, versionTarget(ver, pkg, batchStatus));
      await materialsCore.selectedMaterials(q, pkg.project_id, snap, { usable: true });
      // 条件更新（schema.CONDITIONAL_UPDATES）：WHERE 带 status = 'draft'，影响行数 0 → 409。
      const r = await q.run("UPDATE sysbuild_package_versions SET snapshot_json = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [text, vid]);
      if (r.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      await emit(q, user, pkg.project_id, 'package_version', vid, 'package_version_edited', { package_id: pkg.id, version_no: ver.version_no, bytes });
      return { version: { id: vid, status: 'draft', snapshot_json: snap } };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/package-versions/:vid/items：草稿版本的条目集合修订（add / remove）──────────────────
  router.post('/sysbuild/package-versions/:vid/items', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const body = bodyOf(req);
    onlyKeys(body, ['op', 'item_version_id', 'committed_batch_id']);
    if (body.op !== 'add' && body.op !== 'remove') throw invalid('op 必须是 add 或 remove', 'op');
    const op = body.op;
    const itemVersionId = readIdParam(body.item_version_id, 'item_version_id', '条目版本编号');
    const givenBatch = body.committed_batch_id !== undefined && body.committed_batch_id !== null;
    let batchId = null;
    if (givenBatch) {
      if (op === 'remove') throw invalid('移出条目不需要承诺批次', 'committed_batch_id');
      batchId = readIdParam(body.committed_batch_id, 'committed_batch_id', '承诺批次');
    }
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      const iv = await q.get(
        'SELECT iv.id AS id, iv.item_id AS item_id FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ? AND it.project_id = ?',
        [itemVersionId, pkg.project_id]
      );
      const set = await loadFoldedSet(q, vid);
      const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, pkg.project_id]);
      const base = versionTarget(ver, pkg, batchStatus);
      if (op === 'add') {
        const inSet = !!iv && hasKey(set, iv.item_id);
        rules.assertOp('package_item_add', access, access.project, Object.assign({}, base, { inSet, commitBatchStatus: batch ? batch.status : undefined }));
      } else {
        // 条目版本不属本项目时 inSet 留空（不判），交给下面统一的 400（预筛 LOW-3：与 add 同样 400，不因「不在集合」报 409 而泄露差别）。
        const inSet = iv ? hasKey(set, iv.item_id) && set[iv.item_id].item_version_id === itemVersionId : undefined;
        rules.assertOp('package_item_remove', access, access.project, Object.assign({}, base, { inSet }));
      }
      if (!iv) throw invalid('条目版本不存在或不属于本项目', 'item_version_id');
      if (batchId !== null && !batch) throw invalid('承诺批次不存在或不属于本项目', 'committed_batch_id');
      const ins = await q.run(
        'INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, ?, ?, ?)',
        [vid, itemVersionId, batchId, op, uid]
      );
      await emit(q, user, pkg.project_id, 'package_version', vid, op === 'add' ? 'package_item_added' : 'package_item_removed', {
        revision_id: ins.lastID, item_id: iv.item_id, item_version_id: itemVersionId, committed_batch_id: batchId,
      });
      return { revision_id: ins.lastID, items: setList(await loadFoldedSet(q, vid)) };
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/projects/:id/packages ────────────────────────────────────────────────────────
  router.get('/sysbuild/projects/:id/packages', handle(async (req, res) => {
    const pid = readIdParam(req.params.id, 'id', '项目编号');
    const out = await db.withRead(async (q) => {
      const access = await rules.loadProjectAccess(q, pid, req.user, accessOpts());
      rules.assertVisible(access);
      const pkgs = await q.all('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE project_id = ? ORDER BY id', [pid]);
      const packages = [];
      for (const pkg of pkgs) {
        const vrows = await q.all('SELECT id, version_no, status, form, parent_overall_version_id, effective_at, created_at FROM sysbuild_package_versions WHERE package_id = ? ORDER BY version_no, id', [pkg.id]);
        const versions = [];
        for (const v of vrows) {
          versions.push(Object.assign({}, v, { item_count: Object.keys(await loadFoldedSet(q, v.id)).length }));
        }
        packages.push({
          id: pkg.id, batch_id: pkg.batch_id, type: pkg.type, versions,
          actions: { new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(vrows, pkg, await batchStatusOf(q, pkg))) },
        });
      }
      // D9：项目级 actions.create_package_types = 每个包类型各调一次 opAllowed('package_create')（与建包端点同一个 target 构造：exists 同一个预查）。
      //   批次类型（batch_req / batch_accept）按本项目每个批次各算一次，任一批次可建即列入。
      const batches = await q.all('SELECT id, status FROM sysbuild_batches WHERE project_id = ? ORDER BY id', [pid]);
      const createTypes = [];
      for (const type of schema.ENUMS.packageType) {
        let can = false;
        if (type === 'batch_req' || type === 'batch_accept') {
          for (const b of batches) {
            const exists = await packageExists(q, pid, type, b.id, b);
            if (rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: b.status })) can = true;
          }
        } else {
          const exists = await packageExists(q, pid, type, null, null);
          can = rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: undefined });
        }
        if (can) createTypes.push(type);
      }
      const cur = await resolveCurrentPlan(q, pid);
      return { project_id: pid, overall_version_id: cur.overall_version_id, packages, actions: { create_package_types: createTypes } };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/package-versions/:vid ─────────────────────────────────────────────────────────
  router.get('/sysbuild/package-versions/:vid', handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const out = await db.withRead(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, req.user);
      const versions = await listVersions(q, pkg.id);
      const facts = await versionFactsOf(q, pkg, ver);
      const set = setList(await loadFoldedSet(q, vid));
      const items = [];
      for (const it of set) {
        const row = await q.get(
          'SELECT it.code AS code, iv.version_no AS version_no FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?',
          [it.item_version_id]
        );
        items.push({ item_id: it.item_id, code: row.code, item_version_id: it.item_version_id, version_no: row.version_no, committed_batch_id: it.committed_batch_id });
      }
      return {
        package: { id: pkg.id, project_id: pkg.project_id, batch_id: pkg.batch_id, type: pkg.type },
        version: {
          id: ver.id, package_id: ver.package_id, version_no: ver.version_no, parent_overall_version_id: ver.parent_overall_version_id, form: ver.form,
          status: ver.status, effective_at: ver.effective_at, created_by: ver.created_by, created_at: ver.created_at, updated_at: ver.updated_at,
        },
        snapshot_json: parseSnapshot(ver.snapshot_json),
        materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),
        items,
        // C4b Q-S2：本版本的历史补录记录（method = history，与当前修订的确认记录分开）与历史导入记录（凭 sysbuild_history_imports 识别「历史导入」）
        history_confirmations: await confirmCore.historyConfirmationsOf(q, pkg.project_id, 'package_version', vid),
        history_imports: await confirmCore.historyImportsOf(q, pkg.project_id, 'package_version', vid),
        actions: versionActions(access, ver, pkg, versions, batchStatus, facts),
      };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = {
  createPackageRoutes, resolveCurrentPlan, effectiveOverallVersionId, effectiveInitiationVersionId, foldRevisions, loadFoldedSet, setList,
  versionTarget, versionFactsOf, computeFormAndParent, rewriteFormAndParent, createChangeDraft,
};
