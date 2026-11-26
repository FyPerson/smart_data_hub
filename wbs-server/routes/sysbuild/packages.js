// routes/sysbuild/packages.js — 项目管理（系统建设记录）模块：内容包与版本、现行总体规划版本编号（C3b）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 1–4、§2.3（总体规划单一身份）、§4.5、§5.2、§6.2、§6.3、§7。
//   派单 = docs/local/系统建设记录/送审准备/C3b_模块条目内容包_派单_20261030.md。
//
// 工厂 createPackageRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles }。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 项目可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY
//   → 对象状态 409 SYSBUILD_STATE → 业务规则（400 / 409）。权限 / 项目状态 / 对象状态三步全部经 rules.assertOp（OBJECT_OPS + OP_KIND），
//   读接口的逐对象 actions 用 rules.opAllowed 与同一个 target 构造函数——同一张表同一个顺序，前端不推算。
// 本文件只做内容包「草稿期」：建包、建草稿版本、编辑 snapshot。提交确认 / 生效 / 替代是 C4。
'use strict';
const materialsCore = require('./materials-core');
const express = require('express');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const confirmCore = require('./confirm-core'); // 依赖只有 rules / db / events，不回头 require 本文件（无环）：提交标志的「必需确认人是否齐全」事实
const entriesCore = require('./entries-core'); // C6a：结项包提交前置 closingFactsOf（entries-core 依赖 rules / db / events / confirm-core，不回头 require 本文件，无环）
const { pendingClosingWork, pendingWorkMessage, scopeAdjustments } = require('./work-core');
const cards = require('./stage-cards');
const { currentScopePlans } = require('./scope-plans');
const { readSubmissionScope } = require('./submission-scope');

const SNAPSHOT_MAX_BYTES = 64 * 1024;
const SNAPSHOT_MAX_DEPTH = 64;

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}
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

// 本项目总体规划包的已生效版本编号（没有则 null）。读接口的 overall_version_id 与 C4a 的「基线随生效形成 / 生效后首次设计划写基线」共用这一处定义。
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
//   标志承诺的范围见 rules.js package_version_submit：权限、对象状态、立项前置、确认人齐全、计划齐全。
async function versionFactsOf(q, pkg, ver, project) {
  // parentSuperseded（C5 S-S1c，C4 / C5 交接）：草稿建立时继承的总体规划版本（parent_overall_version_id）已被替代。批次包（第一期没有）；所有类型都取，规则层只在 === true 时拒绝。
  const facts = {};
  if (ver && ver.parent_overall_version_id !== null && ver.parent_overall_version_id !== undefined) {
    const p = await q.get('SELECT status FROM sysbuild_package_versions WHERE id = ?', [ver.parent_overall_version_id]);
    facts.parentSuperseded = !!p && p.status === 'superseded';
  } else facts.parentSuperseded = false;
  if (ver.status !== 'draft' || !rules.SUBMITTABLE_PACKAGE_TYPES.includes(pkg.type)) return facts;
  facts.confirmersMissing = await confirmCore.confirmersMissing(q, pkg.project_id, pkg.type);
  // C6a 待确认互斥（P139）：总体规划 / 批次验收 / 结项三类里（C5 后互斥类型即这三类），项目内已有别的包的待确认版本 → 事实 = 该包的类型（取编号最小的一个，文案只指一个类型），否则 null；
  //   本包自己的版本不会是待确认（提交的是草稿；撤回 / 驳回后再提交时旧版本已是 superseded），所以排除本包只是防御。
  if (rules.EXCLUSIVE_PENDING_PACKAGE_TYPES.includes(pkg.type)) {
    const other = await q.get(
      `SELECT p.type AS type FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id
        WHERE p.project_id = ? AND p.type IN (${rules.EXCLUSIVE_PENDING_SQL_LIST}) AND v.status = 'pending' AND p.id <> ? ORDER BY v.id LIMIT 1`,
      [pkg.project_id, pkg.id]
    );
    facts.otherPendingPackage = other ? other.type : null;
  }
  // C6a 结项包提交前置：每个有效批次已正式上线（entries-core.closingFactsOf，p_closing 收口前置读同一个函数）；null = 满足
  if (pkg.type === 'closing') {
    const cf = await entriesCore.closingFactsOf(q, pkg.project_id);
    facts.closingNotReady = cf.notLive.length === 0 ? null : { notLive: cf.notLive.map((b) => b.name) };
    if (facts.closingNotReady === null) {
      facts.missingCards = cards.missingCardNames(cards.missingCards(await cards.loadProjectCards(q, project), false));
      const items = await pendingClosingWork(q, pkg.project_id);
      if (items.length) facts.pendingWork = { code: 'SYSBUILD_STATE', message: pendingWorkMessage(items), pending_work: items };
    }
  }
  if (pkg.type === 'overall') {
    facts.initiationEffective = (await effectiveInitiationVersionId(q, pkg.project_id)) !== null;
    facts.plan = await currentScopePlans(q, pkg.project_id, project.build_type);
    facts.planMissing = facts.plan.blocked;
  }
  // 读动作、提交拦截和写入冻结使用相同的送审范围。
  try {
    facts.submissionScope = await readSubmissionScope(q, pkg, ver);
    const text = facts.submissionScope.snapshot.text;
    facts.hasConfirmationText = typeof text === 'string' && text.trim().length > 0;
    const basis = await cards.submissionBasis(q, pkg, project.build_type, facts.submissionScope.materials);
    facts.initiationBasis = basis.ok ? 'ok' : 'missing';
    facts.pairedBasis = basis.ok;
    facts.basisDeclaration = basis.declaration;
  } catch (error) {
    const exposed = error.code === 'SYSBUILD_INTERNAL'
      || ([400, 409].includes(error.status) && typeof error.code === 'string' && error.code.startsWith('SYSBUILD_'));
    facts.scopeRejection = exposed
      ? { status: error.status, code: error.code, message: error.message, field: error.field }
      : { status: 500, code: 'SYSBUILD_INTERNAL', message: '内部错误' };
  }
  return facts;
}

// 内容包版本动作（编辑 / 提交 / 撤回）的 target 构造：读接口 actions 与写端点（本文件与 confirm.js）共用这一份。
//   facts = versionFactsOf 的结果（只有提交需要；编辑 / 撤回不传）。
const versionTarget = (ver, pkg, batchStatus, facts) => Object.assign({ versionStatus: ver.status, packageType: pkg.type, batchStatus }, facts);

// form 与 parent_overall_version_id 按项目现状计算（建草稿版本与提交确认时的重算共用这一个函数，修订批二 LOW-4）：
//   form：只在总体规划包的版本上填写——使用现行合并形态 overall_batch_req；
//   parent：批次包（挂批次的包）= 当前生效的总体规划版本（没有则空）；总体规划包与其余包为空。
//   草稿所基于的总体规划被替代时，由提交规则按包类型决定是拒绝，还是重新读取现行规划。
async function computeFormAndParent(q, pkg) {
  const form = pkg.type === 'overall' ? 'overall_batch_req' : null;
  //   C6a：批次包（挂批次）与结项包都「只引用验收 / 结项时的现行版本」（§2.2 不变量 2、§4.3），parent 取当前生效的总体规划版本，建草稿与提交时都按现行版本重写。
  //   「引用的是现行版本」这件事由三处共同成立，缺一不可：① 本函数让建草稿与提交时的 parent = 当时的现行规划版本（草稿期间换版不拒绝，rules.package_version_submit 的 parentSuperseded 豁免）；
  //   ② 生效之后总体规划换版时（C5 后没有生产入口，只剩夹具造数据），parent 就不再是现行版本——上线前置 ACCEPT_STALE（golive-core.goliveBlockersOf）与 p_closing 收口前置 CLOSING_STALE（plan.closeBlockers，
  //   事实 entries-core.closingFactsOf.closingStale）把这种过期的生效包挡在上线 / 结项之外（P168）；③ 重新确认的出路：已有生效版本的验收包 / 结项包可以建新草稿（rules.package_version_create 只拦
  //   总体规划包）、提交（parent 重写成现行）、确认生效（旧生效版本被替代）；待确认的规划类包期间不能上线（PLAN_PENDING）、有待确认内容包不能结项（PACKAGE_PENDING，P164）。
  let parentId = null;
  if (pkg.batch_id !== null || pkg.type === 'closing') parentId = await effectiveOverallVersionId(q, pkg.project_id);
  return { form, parent: parentId };
}

// 提交确认用的「形态重算与回写」（P32，C4b Q-S2 预筛 LOW-3 从 confirm.js 抽出）：
//   按提交时的项目现状重算 form / parent_overall_version_id（computeFormAndParent）；与草稿存的值不同则在 status = 'draft' 条件下回写（条件更新，影响行数 0 → 409）。
//   返回 { calc, changed }：changed 只含发生变化的项（form_from / form_to / parent_from / parent_to），提交事件的 payload 同名记录。
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
      // C4a：提交确认 / 撤回提交（与 confirm.js 的执行端点同一个动作判定与 target 构造；submit 的项目级事实 facts 由 versionFactsOf 取，读写两端同源）。
      //   submit 标志承诺：权限、对象状态、立项前置、确认人齐全。
      //   放在 new_version 之前：C3b 变异的锚点要求 new_version 是对象里的最后一项。
      submit: rules.opAllowed('package_version_submit', access, access.project, t),
      withdraw: rules.opAllowed('package_version_withdraw', access, access.project, t),
      // C4c：导出需求确认单（读动作，可见且版本已提交过即可；与 confirmation-sheet.js 的执行端点调用同一个判定 rules.canExportConfirmationSheet）。
      export_sheet: rules.canExportConfirmationSheet(access, ver),
      new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus)),
    };
  }
  // 55 号 D1（用户 2026-11-16 定 A）：草稿不能提交时的原因，与 actions.submit 同一个判定（opAllowed = checkOp 为 null）、同一个 target 构造。
  //   只对草稿给；无权限（403）不给原因，交由按钮不显示即可；其余拒绝原样给出 code 与文案，前端只展示、不据此另判。
  function submitBlockOf(access, ver, pkg, batchStatus, facts) {
    if (ver.status !== 'draft') return null;
    const v = rules.checkOp('package_version_submit', access, access.project, versionTarget(ver, pkg, batchStatus, facts));
    return v && v.status !== 403 ? {
      code: v.code, message: v.message, ...(v.field ? { field: v.field } : {}),
      ...(v.pending_work ? { pending_work: v.pending_work } : {}),
    } : null;
  }
  function parseSnapshot(text) {
    try { return JSON.parse(text); } catch (_) { return {}; }
  }
  // 建包的「同类型包是否已存在」预查（写端点与读接口的 create_package_types 共用）。批次类型只在批次确属本项目时才查（batch 非空），
  //   否则对别项目的批次号会泄露「那个批次有没有验收包」（预筛 LOW-2）；batch 为空时端点后面会报 400。
  async function packageExists(q, pid, type, batchId, batch) {
    if (type === 'batch_accept') {
      return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));
    }
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
    // C5（R10）：类型校验按最终取值清单，位置在批次校验、可见性与权限之前；读接口 create_package_types 同读 PACKAGE_TYPES_FINAL。
    if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) {
      throw invalid(`type 必须是 ${rules.PACKAGE_TYPES_FINAL.join(' / ')} 之一`, 'type');
    }
    const type = body.type;
    const needsBatch = type === 'batch_accept';
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
      // 新草稿的 snapshot_json 继承上一版本；没有上一版本则为空对象。
      let prevSnapshot = prev ? (await q.get('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [prev.id])).snapshot_json : '{}';
      await materialsCore.selectedMaterials(q, pkg.project_id, prevSnapshot, { usable: false });
      if (pkg.type === 'initiation') {
        const snapshot = materialsCore.snapshotObject(prevSnapshot);
        delete snapshot.no_written_basis_reason;
        prevSnapshot = JSON.stringify(snapshot);
      }
      const ins = await q.run(
        "INSERT INTO sysbuild_package_versions (package_id, version_no, parent_overall_version_id, form, status, snapshot_json, created_by) VALUES (?, ?, ?, ?, 'draft', ?, ?)",
        [pkid, versionNo, parentId, form, prevSnapshot, uid]
      );
      await emit(q, user, pkg.project_id, 'package_version', ins.lastID, 'package_version_created', {
        package_id: pkid, version_no: versionNo, form, parent_overall_version_id: parentId,
      });
      return { version: { id: ins.lastID, package_id: pkid, version_no: versionNo, status: 'draft', form, parent_overall_version_id: parentId } };
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
      // L2 initiation: validate a supplied declaration before saving the draft snapshot.
      if (pkg.type === 'initiation' && Object.hasOwn(snap, 'no_written_basis_reason')) throw invalid('请在立项依据卡片填写无书面依据原因', 'snapshot_json.no_written_basis_reason');
      await materialsCore.selectedMaterials(q, pkg.project_id, snap, { usable: true });
      // 条件更新（schema.CONDITIONAL_UPDATES）：WHERE 带 status = 'draft'，影响行数 0 → 409。
      const r = await q.run("UPDATE sysbuild_package_versions SET snapshot_json = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [text, vid]);
      if (r.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      await emit(q, user, pkg.project_id, 'package_version', vid, 'package_version_edited', { package_id: pkg.id, version_no: ver.version_no, bytes });
      return { version: { id: vid, status: 'draft', snapshot_json: snap } };
    });
    res.json(out);
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
        for (const v of vrows) versions.push(v);
        packages.push({
          id: pkg.id, batch_id: pkg.batch_id, type: pkg.type, versions,
          actions: { new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(vrows, pkg, await batchStatusOf(q, pkg))) },
        });
      }
      // D9：项目级 actions.create_package_types = 每个包类型各调一次 opAllowed('package_create')（与建包端点同一个 target 构造：exists 同一个预查）。
      //   C5 起最终清单里只有批次验收包是批次级类型（批次需求包不在清单内）：按本项目每个批次各算一次，任一批次可建即列入。
      const batches = await q.all('SELECT id, status FROM sysbuild_batches WHERE project_id = ? ORDER BY id', [pid]);
      const createTypes = [];
      for (const type of rules.PACKAGE_TYPES_FINAL) {
        let can = false;
        if (type === 'batch_accept') {
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
      const overallVersionId = await effectiveOverallVersionId(q, pid);
      return { project_id: pid, overall_version_id: overallVersionId, packages, actions: { create_package_types: createTypes } };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/package-versions/:vid ─────────────────────────────────────────────────────────
  router.get('/sysbuild/package-versions/:vid', handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const out = await db.withRead(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, req.user);
      const versions = await listVersions(q, pkg.id);
      const facts = await versionFactsOf(q, pkg, ver, access.project);
      return {
        package: { id: pkg.id, project_id: pkg.project_id, batch_id: pkg.batch_id, type: pkg.type },
        version: {
          id: ver.id, package_id: ver.package_id, version_no: ver.version_no, parent_overall_version_id: ver.parent_overall_version_id, form: ver.form,
          status: ver.status, effective_at: ver.effective_at, created_by: ver.created_by, created_at: ver.created_at, updated_at: ver.updated_at,
        },
        snapshot_json: parseSnapshot(ver.snapshot_json),
        ...(pkg.type === 'overall' && (ver.status === 'effective' || ver.effective_at !== null)
          ? { scope_adjustments: await scopeAdjustments(q, pkg.project_id, vid) } : {}),
        ...(pkg.type === 'initiation' && ver.status === 'draft' ? { basis_declaration: facts.basisDeclaration?.reason ?? null } : {}),
        materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),
        actions: versionActions(access, ver, pkg, versions, batchStatus, facts),
        submit_block: submitBlockOf(access, ver, pkg, batchStatus, facts),
      };
    });
    res.json(out);
  }));

  return { router };
}

module.exports = {
  createPackageRoutes, effectiveOverallVersionId, effectiveInitiationVersionId,
  versionTarget, versionFactsOf, computeFormAndParent, rewriteFormAndParent,
};
