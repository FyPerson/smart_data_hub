// routes/sysbuild/confirm.js — 项目管理（系统建设记录）模块：内容包提交确认 / 撤回、确认任务改发 / 浏览 / 决策、待我确认（C4a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 不变量 2–5 / 9、§4.2、§4.4、§4.5、§5.2–5.3、§6.2、§7「确认」组、§10.2–10.3。
//   派单 = docs/local/系统建设记录/送审准备/C4a_提交确认生效基线_派单_20261101.md（P22–P29）。
//
// 工厂 createConfirmRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds, writeRoles, attachmentHelpers, todayProvider? }（C4b：代录的外部确认日期上限，缺省取服务器本地日期）。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置。
// 检查顺序（§5.3）：参数格式 400 → 对象存在 / 可见 404 → 动作权限 403 → 项目状态 409 SYSBUILD_PROJECT_READONLY → 对象状态与业务规则 409 → 决策内容校验 400（decide 按派单 P27 最后）。
//   权限 / 项目状态 / 对象状态全部经 rules.assertOp（OBJECT_OPS + OP_KIND），读接口的 actions 用 rules.opAllowed 与同一个 target 构造函数。
// 写端点全部在 withWriteTxn 内「加载 → 重核 → 写 → 写事件」；状态转移用条件 UPDATE（WHERE 带旧状态），影响行数 0 → 409。
'use strict';
const visibility = require('./membership-visibility');
const materialsCore = require('./materials-core');
const express = require('express');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const { loadFoldedSet, setList, resolveCurrentPlan, versionTarget, versionFactsOf, rewriteFormAndParent } = require('./packages');
const core = require('./confirm-core');
const entriesCore = require('./entries-core');
const goliveCore = require('./golive-core'); // C6a：交接确认任务（对象类型 handover）的对象分支、改发解析
const notifyCore = require('./notify-core'); // C6b：改发 / 有异议 · 不认可 时写发送意图

const REASON_MAX = 500;
const EVIDENCE_REASON_MIN = 10;
const DECISIONS = Object.freeze({ confirm: 'confirmed', object: 'objected', reject: 'rejected' });
// C4b P45：POST /confirm-tasks/:tid/proxy 能代录的任务用途；C5 S-S1a 加入办理结论确认（无账号代表人只能代录）。负责人裁定（adjudicate）不加：裁定只在平台作出（方案 §4.1「负责人裁定只在平台」）。
//   C5 S-S1c：加入开发方关键事项认可（dev_key_confirm，无账号开发方负责人只能代录）。
//   C6a：加入交接确认两种用途（无账号的需求部门代表人只能代录）。P176（修订批 4）：交接确认的代录**只放无平台账号**的代表人（有账号的须本人在平台确认，见 proxyTarget 的 accountlessOnly / requiredHasAccount 与 rules.confirm_proxy），
//   与办理结论确认「有账号也可代录」的口径不同；别的用途不受影响。
const PROXYABLE_PURPOSES = Object.freeze(['package_confirm', 'proposer_confirm', 'conclusion_confirm', 'dev_key_confirm', 'handover_accept_issue', 'handover_no_further']);
// C5 S-S1a：办理结论确认 / 负责人裁定任务（confirm-core.ENTRY_TASK_PURPOSES）的决策取值：结论确认只认 确认 / 有异议；裁定只认 确认结论 / 不认可（400，决策内容校验）。
//   C5 S-S1c：开发方关键事项认可只认 确认 / 不认可（不认可 → 登记标「负责人未认可」，修订重提 = 新登记）。
//   C6a：交接确认（接受带此问题上线 / 不再处理）只认 确认 / 不认可（「有异议」不是交接确认的取值：业务不接受就是不认可，PM 须先把问题办理掉或改结论）。
const ENTRY_TASK_DECISIONS = Object.freeze({
  conclusion_confirm: Object.freeze(['confirm', 'object']), adjudicate: Object.freeze(['confirm', 'reject']), dev_key_confirm: Object.freeze(['confirm', 'reject']),
  handover_accept_issue: Object.freeze(['confirm', 'reject']), handover_no_further: Object.freeze(['confirm', 'reject']),
});
const ENTRY_TASK_DECISION_MESSAGES = Object.freeze({
  conclusion_confirm: '办理结论只能确认或提出异议（decision 为 confirm / object）',
  adjudicate: '负责人裁定只能确认结论或不认可（decision 为 confirm / reject）',
  dev_key_confirm: '开发方关键事项只能认可或不认可（decision 为 confirm / reject）',
  handover_accept_issue: '交接确认只能确认或不认可（decision 为 confirm / reject）',
  handover_no_further: '交接确认只能确认或不认可（decision 为 confirm / reject）',
});

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
const parseJsonOrEmpty = (text) => { try { return JSON.parse(text); } catch (_) { return {}; } };

function createConfirmRoutes(ctx) {
  for (const k of ['db', 'logger', 'attachmentHelpers']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/confirm 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/confirm 参数 readonlyIds 必须是数组或 Set');
  }
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/confirm 参数 writeRoles 必须是数组或 Set');
  }
  if (!ctx.attachmentHelpers || typeof ctx.attachmentHelpers.freezeAttachmentSet !== 'function') {
    throw new Error('routes/sysbuild/confirm 参数 attachmentHelpers 必须带 freezeAttachmentSet');
  }
  const { db, logger, attachmentHelpers } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });
  // 代录的外部确认日期上限 = 今天（服务器本地日期）。todayProvider 可选注入（进程内夹具用固定值，与 plan.js 同款），缺省取系统本地日期。
  const today = () => (typeof ctx.todayProvider === 'function' ? ctx.todayProvider() : core.localDateString(new Date()));

  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 确认接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  const emit = (q, user, projectId, objectType, objectId, eventType, payload) => writeEvent(q, {
    projectId, objectType, objectId, eventType, payload, operatorId: Number(user.id), operatorName: core.operatorNameOf(user),
  });
  function readIdParam(raw, field, label) {
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }

  // ── 加载 ───────────────────────────────────────────────────────────────────────────────
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
    const pkg = await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]);
    if (!pkg) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, pkg.project_id, user, accessOpts());
    rules.assertVisible(access);
    return { ver, pkg, access, batchStatus: await batchStatusOf(q, pkg) };
  }
  // 提交 / 撤回的 target 用 packages.js 导出的 versionTarget（预筛 L4：与版本详情 actions 同一份，不在本文件再写一份）；提交的项目级事实
  //   （必需确认人是否齐全、立项前置）用 packages.js 的 versionFactsOf，与读接口 actions.submit 同源（修订批二 MED-1），所以对应的 409 都由 rules.assertOp 给出。

  // 任务所在对象：包版本 → status = pending 才算「待确认」；条目版本 → proposer_status = pending。
  async function loadObject(q, task) {
    if (task.object_type === 'package_version') {
      const ver = await q.get(
        'SELECT id, package_id, version_no, parent_overall_version_id, form, status, effective_at, snapshot_json FROM sysbuild_package_versions WHERE id = ?',
        [task.object_version_id]
      );
      const pkg = ver ? await q.get('SELECT id, project_id, batch_id, type FROM sysbuild_packages WHERE id = ?', [ver.package_id]) : null;
      if (!ver || !pkg) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的内容包版本不存在');
      return { kind: 'package_version', ver, pkg, batchStatus: await batchStatusOf(q, pkg), pending: ver.status === 'pending', status: ver.status };
    }
    if (task.object_type === 'item_version') {
      const iv = await q.get(
        `SELECT iv.id AS id, iv.item_id AS item_id, iv.version_no AS version_no, iv.content AS content, iv.quote_text AS quote_text, iv.proposer_name AS proposer_name,
                iv.proposer_member_id AS proposer_member_id, iv.proposer_party_id AS proposer_party_id, iv.occasion AS occasion, iv.proposed_on AS proposed_on,
                iv.proposer_status AS proposer_status, iv.deny_reason AS deny_reason, iv.no_written_evidence AS no_written_evidence,
                iv.no_evidence_reason AS no_evidence_reason, it.code AS code
           FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?`,
        [task.object_version_id]
      );
      if (!iv) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的条目版本不存在');
      return { kind: 'item_version', iv, batchStatus: undefined, pending: iv.proposer_status === 'pending', status: iv.proposer_status };
    }
    // C4b P45：任职接受 / 授权批准与接受的代录在同一事务里建立「邀请 / 授权」类任务，修订当场就是已确认；这类任务只读（详情可看，不可决策 / 改发 / 代录）。
    if (task.object_type === 'invitation') {
      const inv = await q.get('SELECT id, kind, member_id, appointment_id, status FROM sysbuild_invitations WHERE id = ?', [task.object_version_id]);
      if (!inv) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的邀请不存在');
      return { kind: 'invitation', inv, batchStatus: undefined, pending: false, status: inv.status };
    }
    if (task.object_type === 'delegation') {
      const dg = await q.get('SELECT id, party_id, member_id, appointment_id, status FROM sysbuild_delegations WHERE id = ?', [task.object_version_id]);
      if (!dg) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的授权不存在');
      return { kind: 'delegation', dg, batchStatus: undefined, pending: false, status: dg.status };
    }
    // C5 S-S1a：办理结论确认（conclusion，版本号 = 结论动作编号）与负责人裁定（adjudication，版本号 = 交裁定动作编号）。对象「仍有效」= 该动作仍是登记的当前结论 / 裁定且登记未作废；
    //   否则 pending = false，decide 得 409 SYSBUILD_VERSION_CHANGED（与内容包版本不在待确认同口径：确认的对象已变）。状态由办理记录 + 修订派生，entries-core.loadEntryTaskObject。
    if (task.object_type === 'conclusion' || task.object_type === 'adjudication') {
      const eo = await entriesCore.loadEntryTaskObject(q, task);
      if (!eo) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的登记或办理动作不存在');
      return { kind: task.object_type, eo, batchStatus: undefined, pending: eo.pending, status: eo.status };
    }
    // C5 S-S1c：开发方关键事项认可（dev_entry，对象 = 登记，版本号 = 登记编号）。「仍有效」= 登记未作废且本任务是该登记最近一条认可任务；状态 pending = 修订待确认 / 已失效（可改发）、settled = 已有结果、voided = 已作废。
    //   项目状态类别 accept（decide / proxy）与 maintain（reissue），沿用内容包任务的 confirm_* 判定，不走 resolve 类。
    if (task.object_type === 'dev_entry') {
      const de = await entriesCore.loadDevTaskObject(q, task);
      if (!de) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的登记不存在');
      return { kind: 'dev_entry', de, batchStatus: undefined, pending: de.pending, status: de.status };
    }
    // C6a：交接确认（handover，对象 = 登记，版本号 = 状态指纹 = 发起时登记最后一条办理动作编号）。「仍有效」= 指纹仍是该登记的当前状态；之后登记有新办理动作，任务作废。
    //   项目状态类别 accept（推进类确认）与 maintain（改发），沿用内容包任务的 confirm_decide / confirm_proxy / confirm_reissue，不走 resolve 类。
    if (task.object_type === 'handover') {
      const ho = await goliveCore.loadHandoverTaskObject(q, task);
      if (!ho) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务所在的登记不存在');
      return { kind: 'handover', ho, batchStatus: undefined, pending: ho.pending, status: ho.status };
    }
    throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务的对象类型暂不支持');
  }
  const isEntryTask = (task) => core.ENTRY_TASK_PURPOSES.includes(task.purpose);
  // 项目状态类别：办理结论确认 / 裁定任务的决策、代录、改发按 resolve 判（四态都允许，方案 §4.5），其余任务沿用 accept / maintain；三个动作各一张 OBJECT_OPS 登记，判定委托同一份。
  const decideOpOf = (task) => (isEntryTask(task) ? 'entry_conclusion_decide' : 'confirm_decide');
  const proxyOpOf = (task) => (isEntryTask(task) ? 'entry_conclusion_proxy' : 'confirm_proxy');
  const reissueOpOf = (task) => (isEntryTask(task) ? 'entry_conclusion_reissue' : 'confirm_reissue');
  function assertEntryTaskDecision(task, decision) {
    if (!hasKey(ENTRY_TASK_DECISIONS, task.purpose)) return; // 办理结论 / 裁定 / 开发方关键事项认可 / 交接确认任务各有自己的决策取值（ENTRY_TASK_DECISIONS）；其余任务三种取值都收
    if (!ENTRY_TASK_DECISIONS[task.purpose].includes(decision)) throw invalid(ENTRY_TASK_DECISION_MESSAGES[task.purpose], 'decision');
  }
  async function loadTaskCtx(q, tid, user) {
    const task = await q.get('SELECT id, project_id, object_type, object_id, object_version_id, purpose, party_id, created_at FROM sysbuild_confirm_tasks WHERE id = ?', [tid]);
    if (!task) throw rules.notFound();
    const access = await rules.loadProjectAccess(q, task.project_id, user, accessOpts());
    // 登记残余（C4a 修订批）：必需确认人被移出项目后，若他不是 admin / 只读账号，就不再是项目成员——任务详情按项目可见性对他是 404，
    //   他看不到自己曾经的任务（这是可见性规则的直接结果，不单独放行）；PM 改发后由新人处理。只读账号被移出后仍可见（见 canViewProject），会看到 actions.decide 为假。
    rules.assertVisible(access);
    if (task.object_type === 'invitation' || task.object_type === 'delegation') {
      const identity = await rules.completeIdentity(q, access, user);
      if (!(await visibility.taskVisible(q, identity, task))) throw rules.notFound();
    }
    const latest = await core.latestRevision(q, tid);
    if (!latest) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：确认任务没有修订');
    const mem = await q.get('SELECT user_id FROM sysbuild_members WHERE id = ?', [latest.required_member_id]);
    const requiredUserId = mem && mem.user_id !== null ? Number(mem.user_id) : null;
    return { task, access, latest, requiredUserId, obj: await loadObject(q, task) };
  }

  // target 构造（读写两端同一份）。decide：isRequired = 本人是当前（rev_no 最大）修订的必需确认人；请求带的 revision_id / object_version_id 只在执行端点放进去。
  async function decideTarget(q, c, user, given) {
    const isRequired = c.requiredUserId !== null && c.requiredUserId === Number(user.id);
    const loss = c.latest.status === 'pending' ? await core.qualificationLoss(q, c.latest) : null;
    const t = {
      isRequired, currentRevisionId: c.latest.id, revisionStatus: c.latest.status, objectVersionId: c.task.object_version_id, objectPending: c.obj.pending, qualificationLoss: loss,
    };
    if (given) { t.revisionIdGiven = given.revisionId; t.objectVersionIdGiven = given.objectVersionId; }
    return t;
  }
  // 代录目标（读接口 actions.proxy 与执行端点共用）：given 带请求里的 revision_id / object_version_id（读接口不带）。
  //   PROXYABLE_PURPOSES 之外的任务（任职 / 授权代录时同事务建立、当场已确认的邀请 / 授权类任务）proxyable = false。
  async function proxyTarget(q, c, user, given) {
    const loss = c.latest.status === 'pending' ? await core.qualificationLoss(q, c.latest) : null;
    const t = {
      requiredIsSelf: c.requiredUserId !== null && c.requiredUserId === Number(user.id), // 预筛 D3 / P60：必需确认人就是操作人本人
      proxyable: PROXYABLE_PURPOSES.includes(c.task.purpose), currentRevisionId: c.latest.id, revisionStatus: c.latest.status, objectVersionId: c.task.object_version_id,
      objectPending: c.obj.pending, qualificationLoss: loss, historyConflict: await proxyWindowConflict(q, c),
      // P176（修订批 4）：交接确认的代录只放无平台账号的代表人——requiredUserId 是当前修订必需确认人的平台账号（null = 无账号，与任务详情 revision.proxy_only 同一个事实）
      accountlessOnly: goliveCore.HANDOVER_PURPOSES.includes(c.task.purpose), requiredHasAccount: c.requiredUserId !== null,
    };
    if (given) { t.revisionIdGiven = given.revisionId; t.objectVersionIdGiven = given.objectVersionId; }
    return t;
  }
  // 历史补录窗口（history_window = open）与本对象冲突时返回拒绝文案，否则 null（C4b Q-S2，P58，按对象）：内容包任务看该包任一版本的历史导入 / 历史补录记录，
  //   提出人任务看该条目任一版本的历史补录记录；窗口不是 open 一律 null。其他对象类型的任务（任职 / 授权代录同事务建立的邀请 / 授权类任务，不可代录 / 改发）返回 undefined，
  //   规则层对未取到的事实 fail-closed 拒绝（但它们在 proxyable / objectType 判定里已先被拒）。代录与改发共用，读接口 actions 同源。
  async function proxyWindowConflict(q, c) {
    if (c.obj.kind === 'package_version') return core.packageHistoryConflict(q, c.task.project_id, await core.historyPackageIdsOf(q, c.obj.pkg)); // 变更包 = 自身 ∪ 总体规划包（C5 S-S1c，P58；预筛 M3）
    if (c.obj.kind === 'item_version') return core.itemHistoryConflict(q, c.task.project_id, c.obj.iv.item_id);
    // C5 S-S1c：开发方关键事项认可任务（登记）同样不受历史补录窗口互斥约束
    if (c.obj.kind === 'dev_entry') return null;
    // C5 S-S1a：办理结论 / 裁定任务不受历史补录窗口互斥约束（窗口只管内容包、条目、任职 / 授权对象），明确返回「无冲突」而不是 undefined（undefined = 事实没取到，规则层 fail-closed 拒绝）
    if (c.obj.kind === 'conclusion' || c.obj.kind === 'adjudication') return null;
    // C6a：交接确认任务（登记）同样不受历史补录窗口互斥约束
    if (c.obj.kind === 'handover') return null;
    return undefined;
  }
  // 办理结论确认 / 裁定任务的改发解析（C5 S-S1a）：办理结论 = 按**当前**的确认人解析重新找人（entries-core.resolveConclusionConfirmer，与给结论时同一个函数）；
  //   负责人裁定 = 来源方当前现任负责人（须有平台账号，裁定只在平台作出）。解析不到 / 不再需要确认 → blocked 文案。
  async function resolveEntryReissue(q, c) {
    const { entry } = c.obj.eo;
    if (c.task.object_type === 'conclusion') {
      const conf = await entriesCore.resolveConclusionConfirmer(q, entry);
      if (conf.kind === 'none') return { isDelegate: false, cur: null, blocked: '该登记现在不需要确认人，无法改发', historyConflict: null };
      if (conf.kind === 'unavailable') return { isDelegate: false, cur: null, blocked: '来源方暂无代表人，请先完成授权后再改发', historyConflict: null };
      return {
        isDelegate: conf.kind === 'delegate',
        cur: { memberId: conf.memberId, appointmentId: conf.appointmentId, delegationId: conf.delegationId, proxyOnly: conf.proxyOnly },
        blocked: null, historyConflict: null,
      };
    }
    const adj = await entriesCore.resolveAdjudicator(q, entry);
    if (adj.state === 'missing') return { isDelegate: false, cur: null, blocked: '来源方当前没有现任负责人，请先完成任职后再改发', historyConflict: null };
    if (adj.state === 'proxy_only') return { isDelegate: false, cur: null, blocked: '来源方负责人没有平台账号，裁定只能在平台作出，无法改发', historyConflict: null };
    return {
      isDelegate: false, cur: { memberId: adj.owner.memberId, appointmentId: adj.owner.appointmentId, delegationId: null, proxyOnly: false }, blocked: null, historyConflict: null,
    };
  }
  // 改发的新必需确认人解析（读接口 actions.reissue 与执行端点共用这一个函数，预筛 L3①：标志为真则执行必 2xx）：
  //   内容包任务：按**当前**任职 / 授权重新解析（当前修订依据授权的是代表人任务，否则是负责人任务；「可作为确认人」与提交时同一判定，C4b P44 起含无账号成员）；解析不到、
  //   或新人在本版本、同一参与方的另一类任务上已确认（P36：同一人不能同时以负责人和代表人身份确认），返回 blocked 文案。
  //   提出人任务（C4b P48）：重解析 = 该条目**当前版本**（版本号最大）的提出人成员仍是确认人（平台或代录，已加入未移出、账号未停用）；条目已有新版本、提出人已不是确认人 → blocked。
  //   C4b Q-S2（P58）：解析结果另带 historyConflict（历史补录窗口与本对象的互斥，proxyWindowConflict 同一个函数），随 reissueTarget 进规则层，读写同源。
  async function resolveReissue(q, c) {
    if (isEntryTask(c.task)) return resolveEntryReissue(q, c);
    // C5 S-S1c：开发方关键事项认可的改发 = 重新解析开发方现任负责人（须有生效任职；无账号的负责人只能代录，改发解析仍给出，proxyOnly 照实返回）
    if (c.task.object_type === 'dev_entry') {
      // 预筛 L1：只有本登记最新一条认可任务可改发（旧任务改发会让两条任务并存）。预筛 M4：已失效的修订只在失效原因 = 项目已终止、且登记仍需要开发方负责人认可时可改发——
      //   取消涉及承诺 / 登记作废造成的失效不能靠改发复活（出路 = 重新标记涉及承诺 / 修订重提），否则「取消承诺」之后认可会回来。读接口 actions.reissue 与执行共用本函数（同源）。
      if (c.obj.de.isLatest !== true) return { isDelegate: false, cur: null, blocked: '该认可任务已被本登记新的认可任务取代，不能改发', historyConflict: null };
      // 修订批 3 H1（codex 26，P131）：负责人已作出决定（认可 confirmed / 不认可 rejected / 有异议 objected）的任务不能改发——不认可后 PM 直接改发等于绕开「修订重提」；只有待确认（换人）与已失效（项目终止后重开，见下）的修订放行。
      //   这条与 rules.confirm_reissue 的「对象已不是待确认」互为两道防线（对象状态由 entries-core.loadDevTaskObject 派生），读接口 actions.reissue 与执行共用本函数。
      if (c.latest.status !== 'pending' && c.latest.status !== 'invalid') return { isDelegate: false, cur: null, blocked: '开发方负责人已作出认可 / 不认可，不能改发；不认可的出路是修订重提', historyConflict: null };
      if (c.latest.status === 'invalid') {
        if (c.latest.status_reason !== core.PROJECT_TERMINATED_REASON) return { isDelegate: false, cur: null, blocked: '该认可已失效（取消涉及承诺 / 登记作废），不能改发；需要时请重新标记涉及承诺或修订重提', historyConflict: null };
        if (c.obj.de.needsDevConfirm !== true) return { isDelegate: false, cur: null, blocked: '该登记已不需要开发方负责人认可（已取消涉及承诺），不能改发', historyConflict: null };
      }
      const owner = await core.currentOwner(q, c.task.party_id);
      if (!owner) return { isDelegate: false, cur: null, blocked: '开发方当前没有现任负责人，请先完成任职后再改发', historyConflict: null };
      return { isDelegate: false, cur: { memberId: owner.memberId, appointmentId: owner.appointmentId, delegationId: null, proxyOnly: owner.proxyOnly }, blocked: null, historyConflict: null };
    }
    // C6a：交接确认的改发 = 重新解析该参与方当前的生效代表人（任务按需求部门各一条）；登记状态已变化（指纹过期）的任务由 rules.confirm_reissue 的「对象已不是待确认」先拦下（对象状态由 golive-core.loadHandoverTaskObject 按指纹派生），这里不再重复判；解析不到代表人 → blocked 文案。
    //   读接口 actions.reissue 与执行共用本函数（同源）。
    if (c.task.object_type === 'handover') {
      // P165（预筛 MED-1，照 dev_entry 先例 codex 26 H1）：代表人已作出决定（确认 confirmed / 有异议 objected / 不认可 rejected）的任务不能改发——不认可后 PM 直接改发再确认等于绕开「办理或改结论」；
      //   只有待确认（换人）与已失效（项目终止后重开）的修订放行。出路 = 办理 / 改结论让登记状态变化，指纹变化后重新发起（POST …/handover/requests 对同一指纹的 declined 也 409，rules.handover_request）。
      if (c.latest.status !== 'pending' && c.latest.status !== 'invalid') return { isDelegate: true, cur: null, blocked: '代表人已对该登记作出确认 / 有异议 / 不认可，不能改发；不认可或有异议的出路是办理或改结论（登记状态变化后重新发起）', historyConflict: null };
      const dlg = await core.currentDelegate(q, c.task.party_id);
      if (!dlg) return { isDelegate: true, cur: null, blocked: '该参与方当前没有生效代表人，请先完成授权后再改发', historyConflict: null };
      return { isDelegate: true, cur: { memberId: dlg.memberId, appointmentId: null, delegationId: dlg.delegationId, proxyOnly: dlg.proxyOnly }, blocked: null, historyConflict: null };
    }
    const historyConflict = await proxyWindowConflict(q, c);
    if (c.task.object_type === 'item_version') {
      const iv = c.obj.iv;
      const latest = await q.get('SELECT MAX(version_no) AS v FROM sysbuild_item_versions WHERE item_id = ?', [iv.item_id]);
      if (latest && latest.v !== iv.version_no) return { isDelegate: false, cur: null, blocked: '条目已有新版本，请对新版本的确认任务处理', historyConflict };
      const m = iv.proposer_member_id === null ? null : await core.eligibleMember(q, iv.proposer_member_id);
      if (!m) return { isDelegate: false, cur: null, blocked: '提出人已不是本项目可作为确认人的成员（已移出或账号不可用），无法改发', historyConflict };
      return { isDelegate: false, cur: { memberId: m.id, appointmentId: null, delegationId: null, proxyOnly: m.proxy_only }, blocked: null, historyConflict };
    }
    if (c.task.object_type !== 'package_version') return { isDelegate: false, cur: null, blocked: null, historyConflict };
    const isDelegate = c.latest.basis_delegation_id !== null;
    const cur = isDelegate ? await core.currentDelegate(q, c.task.party_id) : await core.currentOwner(q, c.task.party_id);
    if (!cur) return { isDelegate, cur: null, blocked: isDelegate ? '该参与方当前没有生效代表人，请先完成授权后再改发' : '该参与方当前没有现任负责人，请先完成任职后再改发', historyConflict };
    if (await core.confirmedOnOtherRoleBySameUser(q, c.task, cur.memberId)) {
      return { isDelegate, cur, blocked: '同一人不能在本版本同时以负责人和代表人身份确认，请调整人选或撤回后重新提交', historyConflict };
    }
    return { isDelegate, cur, blocked: null, historyConflict };
  }
  const reissueTarget = (c, res) => ({
    objectType: c.task.object_type, objectStatus: c.obj.status, revisionStatus: c.latest.status, batchStatus: c.obj.batchStatus, reissueBlocked: res.blocked, historyConflict: res.historyConflict,
    objectPending: c.obj.pending, // C5：办理结论 / 裁定任务的「对象仍是当前结论」判定用（entry_conclusion_reissue）
  });

  // ── 提交时重核整个集合（P24 / 交接 ④）─────────────────────────────────────────────────────────────
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
  // ── POST /sysbuild/package-versions/:vid/submit、POST /sysbuild/changes/:cid/submit：提交确认（P22–P24；C5 S-S1c 变更包）──────────────────
  //   两个入口共用 submitVersion（同一个写事务体）：变更的提交 = 提交该变更当前草稿版本，前置与确认人解析同总体规划包，另在同一事务里让 changes.status draft → pending 并回填 package_version_id。
  async function submitVersion(q, user, vid) {
    {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      // 权限 / 项目状态 / 对象状态 / 必需确认人齐全（P23）/ 立项前置（P37）全部在这一个 assertOp 里判（target 的项目级事实与读接口 actions.submit 同源，
      //   MED-1）；下面只剩 P24 的条目集合重核（只在执行时做）。
      rules.assertOp('package_version_submit', access, access.project, versionTarget(ver, pkg, batchStatus, await versionFactsOf(q, pkg, ver)));
      const pid = pkg.project_id;
      const set = pkg.type === 'overall' || pkg.type === 'change' ? await recheckOverallSet(q, pkg, ver) : []; // 变更包版本 = 提议的下一版完整总体规划，同一套集合重核
      // 必需确认人的具体名单（assertOp 已核对齐全；同一写事务内与上面的 confirmersMissing 读到的是同一状态）。
      const required = await core.resolvePackageConfirmers(q, pid, pkg.type);
      // P32（主会话 11-01 裁定）：form / parent_overall_version_id 按提交时的项目现状重算（packages.js computeFormAndParent，与建草稿版本同一个函数），
      //   与草稿存的值不同**不再 409**——草稿建好后批次数、总体规划生效情况都可能变化，重算的值才是确认对象的真实形态；不同则在 status = 'draft' 条件下回写
      //   （schema.js UPDATABLE_COLUMNS / CONDITIONAL_UPDATES 已登记 form、parent_overall_version_id；条件更新，影响行数 0 → 409），变化记进提交事件
      //   （form_from / form_to / parent_from / parent_to，只在变化时）。
      //   C5 交接（主会话 11-01 裁定）：批次需求包提交时若 parent 对应的总体版本已被替代，改为 409「请基于现行规划重建草稿」，不静默回写 parent
      //   （C4a 只开放总体规划包 / 立项包提交，批次包 parent 恒为空，这里的回写实际只作用于 form）。
      //   重算与回写（packages.js rewriteFormAndParent，与历史事实导入内容包生效共用一份）；changed = 变化项（form_from / form_to / parent_from / parent_to，只在变化时）。
      const { calc, changed } = await rewriteFormAndParent(q, pkg, ver);
      const up = await q.run("UPDATE sysbuild_package_versions SET status = 'pending', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [vid]);
      if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      // 冻结附件集合（不变量 9）：本版本引用的每个条目版本的附件（绑定 ∪ 引用）+ 包版本自己的材料附件，同一个冻结对象（package_version, vid）。
      const opId = Number(user.id);
      const opName = core.operatorNameOf(user);
      for (const it of set) {
        await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'item_version', ownerId: it.item_version_id, operatorId: opId, operatorName: opName, projectId: pid });
      }
      await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'package_version', ownerId: vid, operatorId: opId, operatorName: opName, projectId: pid });
      await materialsCore.freezeSelectedMaterials(q, { projectId: pid, versionId: vid, operatorId: opId, operatorName: opName });
      // C5 S-S1c：变更的方向类证据（owner_type = change）随变更包版本冻结，确认人看到的就是提交时的证据清单
      const changeRow = pkg.type === 'change' ? await q.get('SELECT id, title FROM sysbuild_changes WHERE package_id = ?', [pkg.id]) : null;
      if (pkg.type === 'change') {
        if (!changeRow) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更包没有对应的变更');
        await attachmentHelpers.freezeAttachmentSet(q, { objectType: 'package_version', objectVersionId: vid, ownerType: 'change', ownerId: changeRow.id, operatorId: opId, operatorName: opName, projectId: pid });
      }
      const frozen = await core.frozenSetOf(q, 'package_version', vid);
      const tasks = [];
      for (const e of required.entries) {
        const t = await core.createTaskWithRevision(q, user, {
          projectId: pid, objectType: 'package_version', objectId: pkg.id, objectVersionId: vid, purpose: 'package_confirm', partyId: e.partyId,
          requiredMemberId: e.memberId, basisAppointmentId: e.appointmentId, basisDelegationId: e.delegationId,
        });
        tasks.push({ task_id: t.taskId, revision_id: t.revisionId, party_id: e.partyId, kind: e.kind, required_member_id: e.memberId, proxy_only: e.proxyOnly === true });
      }
      // 总体规划包另记各未取消节点当时的当前计划（node_plans，P34）：总体排期基线是确认对象；生效时形成的基线要与它核对（confirm-core.formBaselines）。
      const payload = Object.assign({
        package_id: pkg.id, type: pkg.type, version_no: ver.version_no, form: calc.form, item_count: set.length,
        task_ids: tasks.map((t) => t.task_id), frozen_attachment_ids: frozen.map((f) => f.attachment_id),
      }, changed, pkg.type === 'overall' || pkg.type === 'change' ? { node_plans: await core.currentNodePlans(q, pid) } : {}, changeRow ? { change_id: changeRow.id } : {});
      await emit(q, user, pid, 'package_version', vid, 'package_version_submitted', payload);
      if (changeRow) {
        // 变更：draft → pending，回填当前送审版本（条件更新，影响行数 0 → 409）
        const cu = await q.run("UPDATE sysbuild_changes SET status = 'pending', package_version_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'draft'", [vid, changeRow.id]);
        if (cu.changes === 0) throw stateError('变更状态已变化，请刷新后重试');
        await emit(q, user, pid, 'change', changeRow.id, 'change_submitted', { change_id: changeRow.id, package_version_id: vid, version_no: ver.version_no, task_ids: tasks.map((t) => t.task_id) });
      }
      return { version: { id: vid, package_id: pkg.id, version_no: ver.version_no, status: 'pending' }, tasks, frozen_attachments: frozen, change_id: changeRow ? changeRow.id : undefined };
    }
  }
  router.post('/sysbuild/package-versions/:vid/submit', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    onlyKeys(bodyOf(req), []);
    res.json(await db.withWriteTxn((q) => submitVersion(q, req.user, vid)));
  }));
  // 变更的提交：取该变更包当前的草稿版本（至多一个）提交；没有草稿（已提交 / 已撤回 / 已生效）→ 409
  router.post('/sysbuild/changes/:cid/submit', parseJsonBody, handle(async (req, res) => {
    const cid = readIdParam(req.params.cid, 'cid', '变更编号');
    onlyKeys(bodyOf(req), []);
    res.json(await db.withWriteTxn(async (q) => {
      const ch = await q.get('SELECT id, package_id FROM sysbuild_changes WHERE id = ?', [cid]);
      if (!ch) throw rules.notFound();
      const draft = await q.get("SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1", [ch.package_id]);
      if (!draft) {
        // 先过可见性（非成员 404）与权限（非 PM 403），再报「没有草稿」409：借已有的提交判定给出同一套顺序
        const any = await q.get('SELECT id FROM sysbuild_package_versions WHERE package_id = ? ORDER BY id DESC LIMIT 1', [ch.package_id]);
        if (!any) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更包没有任何版本');
        return submitVersion(q, req.user, any.id);
      }
      return submitVersion(q, req.user, draft.id);
    }));
  }));

  // ── POST /sysbuild/package-versions/:vid/withdraw：撤回提交（P25）────────────────────────────────────
  router.post('/sysbuild/package-versions/:vid/withdraw', parseJsonBody, handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason']);
    const reason = readText(body.reason, 'reason', '撤回原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const { ver, pkg, access, batchStatus } = await loadVersionCtx(q, vid, user);
      rules.assertOp('package_version_withdraw', access, access.project, versionTarget(ver, pkg, batchStatus));
      const up = await q.run("UPDATE sysbuild_package_versions SET status = 'superseded', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [vid]);
      if (up.changes === 0) throw stateError('版本状态已变化，请刷新后重试');
      const revs = await q.all(
        `SELECT r.id AS id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
          WHERE t.object_type = 'package_version' AND t.object_version_id = ? AND r.status = 'pending' ORDER BY r.id`,
        [vid]
      );
      for (const r of revs) await core.closePendingRevision(q, r.id, 'invalid', reason);
      await emit(q, user, pkg.project_id, 'package_version', vid, 'package_version_withdrawn', {
        package_id: pkg.id, version_no: ver.version_no, reason, invalidated_revision_ids: revs.map((r) => r.id),
      });
      // C5 S-S1c：变更包版本撤回 → 同一事务 changes.status → withdrawn（撤回后的变更不能再提交，要再变更就新建一条）
      if (pkg.type === 'change') {
        const ch = await q.get('SELECT id FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);
        if (!ch) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更包没有对应的变更');
        const cu = await q.run("UPDATE sysbuild_changes SET status = 'withdrawn', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'", [ch.id]);
        if (cu.changes === 0) throw stateError('变更状态已变化，请刷新后重试');
        await emit(q, user, pkg.project_id, 'change', ch.id, 'change_withdrawn', { change_id: ch.id, package_version_id: vid, reason });
      }
      return { version: { id: vid, package_id: pkg.id, version_no: ver.version_no, status: 'superseded' }, invalidated_revision_ids: revs.map((r) => r.id) };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/package-versions/:vid/confirm-tasks：本版本的确认任务与当前修订 ─────────────────────────
  router.get('/sysbuild/package-versions/:vid/confirm-tasks', handle(async (req, res) => {
    const vid = readIdParam(req.params.vid, 'vid', '版本编号');
    const out = await db.withRead(async (q) => {
      const { ver } = await loadVersionCtx(q, vid, req.user);
      const tasks = await q.all(
        "SELECT id, party_id, purpose FROM sysbuild_confirm_tasks WHERE object_type = 'package_version' AND object_version_id = ? ORDER BY id",
        [vid]
      );
      const list = [];
      for (const t of tasks) {
        const cur = await core.latestRevision(q, t.id);
        // proxy_only：当前修订的必需确认人没有平台账号，任务只能由 PM 代录完成（C4b P44；任务行与修订行各带一份，前端按需取）
        const proxyOnly = await core.isProxyOnlyMember(q, cur.required_member_id);
        const partyName = t.party_id === null ? null : await q.get('SELECT name FROM sysbuild_parties WHERE id = ?', [t.party_id]);
        list.push({
          task_id: t.id, party_id: t.party_id, purpose: t.purpose, proxy_only: proxyOnly,
          current_revision: { id: cur.id, rev_no: cur.rev_no, status: cur.status, status_reason: cur.status_reason, required_member_id: cur.required_member_id, proxy_only: proxyOnly },
          required_name: await entriesCore.memberNameOf(q, cur.required_member_id), party_name: partyName ? partyName.name : null,
        });
      }
      return { version: { id: ver.id, status: ver.status }, tasks: list };
    });
    res.json(out);
  }));

  // ── POST /sysbuild/confirm-tasks/:tid/reissue：改发 / 换人（P26）────────────────────────────────────
  router.post('/sysbuild/confirm-tasks/:tid/reissue', parseJsonBody, handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const body = bodyOf(req);
    onlyKeys(body, ['reason', 'revision_id']);
    const expectedRevision = body.revision_id === undefined ? null : readIdParam(body.revision_id, 'revision_id', '当前任务修订编号');
    const reason = readText(body.reason, 'reason', '改发原因', REASON_MAX, true);
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadTaskCtx(q, tid, user);
      const res = await resolveReissue(q, c);
      rules.assertOp(reissueOpOf(c.task), c.access, c.access.project, reissueTarget(c, res));
      if (expectedRevision !== null && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请重新打开后再改发');
      const { isDelegate, cur } = res; // 非空：assertOp 的状态判定已把「解析不到」挡在前面（reissueBlocked）
      if (c.latest.status === 'pending') await core.closePendingRevision(q, c.latest.id, 'superseded', reason);
      const revNo = c.latest.rev_no + 1;
      const ins = await q.run(
        "INSERT INTO sysbuild_confirm_task_revisions (task_id, rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status, created_by) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
        [tid, revNo, cur.memberId, isDelegate ? null : cur.appointmentId, isDelegate ? cur.delegationId : null, Number(user.id)]
      );
      await emit(q, user, c.task.project_id, 'confirm_task', tid, 'confirm_task_reissued', {
        revision_id: ins.lastID, previous_revision_id: c.latest.id, rev_no: revNo, required_member_id: cur.memberId,
        basis_appointment_id: isDelegate ? null : cur.appointmentId, basis_delegation_id: isDelegate ? cur.delegationId : null, reason,
      });
      await notifyCore.enqueueRevisionIntent(q, { projectId: c.task.project_id, revisionId: ins.lastID, requiredMemberId: cur.memberId, reissue: true }); // C6b：改发后的必需确认人收到新的发送意图
      return { task_id: tid, revision: { id: ins.lastID, rev_no: revNo, status: 'pending', required_member_id: cur.memberId, proxy_only: cur.proxyOnly === true } };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/confirm-tasks/:tid：任务详情；必需确认人本人打开当前待确认修订即写一条浏览记录（P27）──────────────
  // P40（主会话 11-01 裁定，维持方案 §7「GET 打开即写浏览记录」）：C8 前端交接——任务列表与预取**不得**调用本接口（它对必需确认人本人会写浏览记录，
  //   而浏览记录是「已阅读」的证据）；只在用户真正进入确认页时调用一次。后端不为此加参数或分流。
  //   附件视图 attachmentView 与确认记录的凭据附件视图 attachConfirmationEvidence 已移到 confirm-core.js（C4b Q-S2 预筛 LOW-6：历史补录 / 历史导入的读接口共用同一份）。
  const attachmentView = core.attachmentView;
  async function objectView(q, c) {
    if (c.obj.kind === 'package_version') {
      const { ver, pkg } = c.obj;
      const items = [];
      for (const it of setList(await loadFoldedSet(q, ver.id))) {
        const row = await q.get(
          `SELECT it.code AS code, iv.version_no AS version_no, iv.content AS content, iv.quote_text AS quote_text, iv.proposer_name AS proposer_name,
                  iv.proposer_member_id AS proposer_member_id, iv.proposer_party_id AS proposer_party_id, iv.occasion AS occasion, iv.proposed_on AS proposed_on,
                  iv.no_written_evidence AS no_written_evidence, iv.no_evidence_reason AS no_evidence_reason
             FROM sysbuild_item_versions iv JOIN sysbuild_items it ON it.id = iv.item_id WHERE iv.id = ?`,
          [it.item_version_id]
        );
        // codex 19 号 M-2：每个条目版本的「无书面证据」声明与原因随条目版本展示（提交重核允许以「声明 + 至少十字原因」代替附件，确认人必须能看到这份声明，
        //   不能只凭冻结附件清单推断）。no_written_evidence 为布尔，未声明时 no_evidence_reason 为 null。
        items.push({
          item_id: it.item_id, item_version_id: it.item_version_id, committed_batch_id: it.committed_batch_id, code: row.code, version_no: row.version_no, content: row.content,
          quote_text: row.quote_text, proposer_name: row.proposer_name, proposer_member_id: row.proposer_member_id, proposer_party_id: row.proposer_party_id, occasion: row.occasion,
          proposed_on: row.proposed_on, no_written_evidence: row.no_written_evidence === 1, no_evidence_reason: row.no_evidence_reason,
          proposer_display_name: row.proposer_member_id === null ? row.proposer_name : await entriesCore.memberNameOf(q, row.proposer_member_id),
        });
      }
      // P34 / codex 19 号 H-2：总体规划包展示提交时记录的节点计划清单（将形成总体排期基线的内容，方案 §3.1 基线是确认对象）。**一律取提交事件里的快照字段**
      //   （node_id、名称、层、批次、模板键、起止日期），不读节点现值——待确认期间节点可改名，现值会让先后打开的确认人看到不同的排期内容；生效时 formBaselines 仍按
      //   node_id + 日期核对。快照缺某字段（旧事件）按 null 返回。其他类型的包为空数组。
      const nodePlans = [];
      if (pkg.type === 'overall' || pkg.type === 'change') {
        const snap = (v) => (v === undefined ? null : v);
        for (const np of (await core.submittedNodePlans(q, ver.id)) || []) {
          nodePlans.push({
            node_id: np.node_id, name: snap(np.name), layer: snap(np.layer), batch_id: snap(np.batch_id), batch_name: snap(np.batch_name), template_key: snap(np.template_key),
            planned_start: np.planned_start, planned_end: np.planned_end,
          });
        }
      }
      // C5 S-S1c：变更包版本带变更本身（标题、说明、影响、引用登记），确认人看到的是「为什么改、改什么」
      let change = null;
      if (pkg.type === 'change') {
        const ch = await q.get('SELECT id, title, body, affects_json, no_written_evidence, no_evidence_reason FROM sysbuild_changes WHERE package_id = ?', [pkg.id]);
        if (!ch) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：变更包没有对应的变更');
        const aff = parseJsonOrEmpty(ch.affects_json);
        change = {
          id: ch.id, title: ch.title, body: ch.body, affects: aff.affects === undefined ? {} : aff.affects, from_entry_ids: Array.isArray(aff.from_entry_ids) ? aff.from_entry_ids : [],
          no_written_evidence: ch.no_written_evidence === 1, no_evidence_reason: ch.no_evidence_reason,
        };
      }
      return {
        type: 'package_version',
        package: { id: pkg.id, type: pkg.type, batch_id: pkg.batch_id },
        change,
        version: { id: ver.id, version_no: ver.version_no, form: ver.form, status: ver.status, effective_at: ver.effective_at, parent_overall_version_id: ver.parent_overall_version_id },
        snapshot_json: parseJsonOrEmpty(ver.snapshot_json),
        materials: await materialsCore.selectedMaterials(q, pkg.project_id, ver.snapshot_json, { usable: false }),
        items,
        node_plans: nodePlans,
      };
    }
    if (c.obj.kind === 'invitation') return { type: 'invitation', invitation: c.obj.inv };
    if (c.obj.kind === 'delegation') return { type: 'delegation', delegation: c.obj.dg };
    if (c.obj.kind === 'conclusion' || c.obj.kind === 'adjudication') return entriesCore.entryTaskObjectView(q, c.task, c.obj.eo); // C5：登记原文、结论原文、异议历史
    if (c.obj.kind === 'dev_entry') return entriesCore.devEntryTaskObjectView(q, c.task, c.obj.de); // C5 S-S1c：开发方关键事项的登记原文与来源
    if (c.obj.kind === 'handover') return goliveCore.handoverTaskObjectView(q, c.task, c.obj.ho); // C6a：交接确认的登记原文、结论原文、风险标记与需要的交接确认种类
    const iv = c.obj.iv;
    return {
      type: 'item_version',
      item: { id: iv.item_id, code: iv.code },
      version: {
        id: iv.id, version_no: iv.version_no, content: iv.content, quote_text: iv.quote_text, proposer_name: iv.proposer_name, proposer_member_id: iv.proposer_member_id,
        proposer_party_id: iv.proposer_party_id, occasion: iv.occasion, proposed_on: iv.proposed_on, proposer_status: iv.proposer_status, deny_reason: iv.deny_reason,
        no_written_evidence: iv.no_written_evidence === 1, no_evidence_reason: iv.no_evidence_reason, // M-2：声明与原因一并返回（提出人确认的是这个条目版本）
        proposer_display_name: iv.proposer_member_id === null ? iv.proposer_name : await entriesCore.memberNameOf(q, iv.proposer_member_id),
      },
    };
  }
  // record = true（写事务里）才真正插浏览记录。返回 { body, shouldRecord }：shouldRecord = 本人是当前修订的必需确认人且该修订待确认。
  async function buildTaskResponse(q, tid, user, record, expectedRevision) {
    const c = await loadTaskCtx(q, tid, user);
    // C8：通知入口绑定所指修订。两次锁内均核对，尤其不能在定位后改发的竞态中写下新版浏览。
    if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== c.latest.id) throw makeError(409, 'SYSBUILD_TASK_SUPERSEDED', '任务修订已变化，请明确重新打开当前任务');
    const frozen = await core.frozenSetOfTask(q, c.task); // 办理结论 / 裁定任务的冻结清单挂在登记上（confirm-core.frozenKeyOfTask）
    const target = await decideTarget(q, c, user, null);
    const shouldRecord = target.isRequired && c.latest.status === 'pending';
    let viewId = null;
    if (record && shouldRecord) {
      const ins = await q.run(
        "INSERT INTO sysbuild_views (user_id, object_type, object_version_id, source, frozen_attachment_set) VALUES (?, ?, ?, 'page', ?)",
        [Number(user.id), c.task.object_type, c.task.object_version_id, JSON.stringify(frozen)]
      );
      viewId = ins.lastID;
    }
    const revRows = await q.all(
      `SELECT r.id AS id, r.rev_no AS rev_no, r.required_member_id AS required_member_id, r.status AS status, r.status_reason AS status_reason, r.created_at AS created_at,
              m.user_id AS member_user_id
         FROM sysbuild_confirm_task_revisions r LEFT JOIN sysbuild_members m ON m.id = r.required_member_id WHERE r.task_id = ? ORDER BY r.rev_no`,
      [tid]
    );
    // proxy_only：该修订的必需确认人没有平台账号，只能由 PM 代录（C4b P44）
    const revs = revRows.map((r) => ({
      id: r.id, rev_no: r.rev_no, required_member_id: r.required_member_id, status: r.status, status_reason: r.status_reason, created_at: r.created_at, proxy_only: r.member_user_id === null,
    }));
    for (const rev of revs) rev.required_name = await entriesCore.memberNameOf(q, rev.required_member_id);
    const confs = await q.all(
      `SELECT c.id AS id, c.task_revision_id AS revision_id, c.decision AS decision, c.method AS method, c.actor_user_id AS actor_user_id, c.reason AS reason, c.created_at AS created_at,
              c.external_date AS external_date, c.actual_confirmer AS actual_confirmer, c.identity_basis AS identity_basis, c.proxy_by AS proxy_by
         FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id WHERE r.task_id = ? ORDER BY c.id`,
      [tid]
    );
    // C4b 预筛 MED-2 / 小修批 F2：每条确认记录带它的凭据附件（代录确认以 owner_type = confirmation 绑定；平台确认没有，返回空）。
    //   口径与 plan.js 改期证据读接口（records[].attachment_ids）对齐：attachment_ids 含该记录名下**全部**绑定（包括已软删除的），不过滤；
    //   方案 §10.3「记录里显示『已删除』与删除人」：attachments 复用 attachmentView 的统一格式（遮蔽的附件 masked = true、name = null，不返回原名），
    //   每项另补 deleted（是否已软删除）、deleted_by（删除人用户编号）、deleted_by_name（删除人显示名）、deleted_at。
    //   D1 之后凭据附件经 API 已删不掉（附件删除端点 409），这条路径只在库内被直接改动时才会走到（测试用直接写库夹具）。
    for (const cf of confs) {
      await core.attachConfirmationEvidence(q, cf);
      const actor = cf.actor_user_id === null ? null : await q.get('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [cf.actor_user_id]);
      const proxy = cf.proxy_by === null ? null : await q.get('SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?', [cf.proxy_by]);
      cf.actor_name = actor ? actor.name : null;
      cf.proxy_by_name = proxy ? proxy.name : null;
    }
    const projectInfo = await q.get('SELECT id, system_name FROM sysbuild_projects WHERE id = ?', [c.task.project_id]);
    const body = {
      project: projectInfo,
      task: { id: c.task.id, project_id: c.task.project_id, object_type: c.task.object_type, object_id: c.task.object_id, object_version_id: c.task.object_version_id, purpose: c.task.purpose, party_id: c.task.party_id },
      revision: {
        id: c.latest.id, rev_no: c.latest.rev_no, status: c.latest.status, status_reason: c.latest.status_reason, required_member_id: c.latest.required_member_id,
        created_at: c.latest.created_at, proxy_only: c.requiredUserId === null, required_name: await entriesCore.memberNameOf(q, c.latest.required_member_id),
      },
      revisions: revs,
      confirmations: confs,
      object: await objectView(q, c),
      frozen_attachments: await attachmentView(q, frozen),
      checkbox_texts: core.checkboxTextsOf(c.task.purpose), // M-3：三种决策各一条固定文案（确认 / 有异议 / 不认可），页面按所选决策显示，提交时必须逐字带回对应那一条（C6a：交接确认按用途取）
      allowed_decisions: hasKey(ENTRY_TASK_DECISIONS, c.task.purpose) ? ENTRY_TASK_DECISIONS[c.task.purpose] : Object.keys(DECISIONS),
      view_id: viewId,
      // C4b Q-S2：本对象版本的历史补录记录（method = history，不挂任何任务修订），与上面 confirmations（本任务各修订的确认记录）分开返回；邀请 / 授权类任务没有。
      history_confirmations: c.obj.kind === 'package_version' || c.obj.kind === 'item_version' ? await core.historyConfirmationsOf(q, c.task.project_id, c.obj.kind, c.task.object_version_id) : [],
      actions: isEntryTask(c.task) ? {
        // C5：办理结论 / 裁定任务——与 POST …/decide、…/reissue、…/proxy 的 assertOp 同一张 OBJECT_OPS 表、同一个 target 构造函数（项目状态类别 resolve）
        decide: rules.opAllowed(decideOpOf(c.task), c.access, c.access.project, target),
        reissue: rules.opAllowed(reissueOpOf(c.task), c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),
        proxy: rules.opAllowed(proxyOpOf(c.task), c.access, c.access.project, await proxyTarget(q, c, user, null)),
      } : {
        decide: rules.opAllowed('confirm_decide', c.access, c.access.project, target),
        reissue: rules.opAllowed('confirm_reissue', c.access, c.access.project, reissueTarget(c, await resolveReissue(q, c))),
        proxy: rules.opAllowed('confirm_proxy', c.access, c.access.project, await proxyTarget(q, c, user, null)), // C4b：代录（与 POST …/proxy 的 assertOp 同一张表、同一个 target 构造函数）
      },
    };
    body.actions.export_sheet = c.obj.kind === 'package_version' && rules.canExportConfirmationSheet(c.access, c.obj.ver);
    return { body, shouldRecord };
  }
  // 纯读定位：rev 是通知修订号，不是task id；不调用可能写浏览记录的任务详情。
  router.get('/sysbuild/confirm-task-revisions/:rid', handle(async (req, res) => {
    const revisionId = readIdParam(req.params.rid, 'rid', '任务修订编号');
    const out = await db.withRead(async (q) => {
      const revision = await q.get('SELECT id, task_id, rev_no, status FROM sysbuild_confirm_task_revisions WHERE id = ?', [revisionId]);
      if (!revision) throw rules.notFound();
      const c = await loadTaskCtx(q, revision.task_id, req.user);
      return { revision_id: revision.id, task_id: c.task.id, project_id: c.task.project_id, rev_no: revision.rev_no, status: revision.status, is_current: revision.id === c.latest.id, current_revision_id: c.latest.id };
    });
    res.json(out);
  }));
  router.get('/sysbuild/confirm-tasks/:tid', handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const expectedRevision = req.query.revision_id === undefined ? null : readIdParam(req.query.revision_id, 'revision_id', '任务修订编号');
    const first = await db.withRead((q) => buildTaskResponse(q, tid, req.user, false, expectedRevision));
    if (!first.shouldRecord) return res.json(first.body);
    // 打开即写浏览记录：写事务里重新加载（期间状态可能变化），仍满足条件才写。
    const second = await db.withWriteTxn((q) => buildTaskResponse(q, tid, req.user, true, expectedRevision));
    return res.json(second.body);
  }));

  // ── POST /sysbuild/confirm-tasks/:tid/decide：确认 / 有异议 / 不认可（P27 / P28 / P29）───────────────────
  router.post('/sysbuild/confirm-tasks/:tid/decide', parseJsonBody, handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const body = bodyOf(req);
    onlyKeys(body, ['revision_id', 'object_version_id', 'decision', 'checkbox_text', 'reason']);
    const revisionId = readIdParam(body.revision_id, 'revision_id', '任务修订编号');
    const objectVersionId = readIdParam(body.object_version_id, 'object_version_id', '对象版本编号');
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadTaskCtx(q, tid, user);
      rules.assertOp(decideOpOf(c.task), c.access, c.access.project, await decideTarget(q, c, user, { revisionId, objectVersionId }));
      // 浏览证据：本人对该对象版本、打开时间不早于本修订创建时间的最新一条浏览记录；其冻结清单必须等于当前冻结清单。
      //   登记残余（C4a 修订批）：opened_at / created_at 都只到秒，「不早于」按秒比较——必需确认人在本修订创建的**同一秒**内之前的旧浏览（同人改发给同人、
      //   且旧浏览与新修订同秒）会被算作有效浏览。同一人被重新指定且旧浏览恰在同一秒的概率可忽略，且他仍须通过冻结清单比对；不为此加毫秒列。
      const view = await q.get(
        'SELECT id, frozen_attachment_set FROM sysbuild_views WHERE user_id = ? AND object_type = ? AND object_version_id = ? AND opened_at >= ? ORDER BY id DESC LIMIT 1',
        [uid, c.task.object_type, c.task.object_version_id, c.latest.created_at]
      );
      if (!view) throw makeError(409, 'SYSBUILD_NOT_VIEWED', '请先打开并查看本版本的全部内容后再作出确认');
      const frozenNow = await core.frozenSetOfTask(q, c.task);
      const seen = parseJsonOrEmpty(view.frozen_attachment_set);
      const seenKey = Array.isArray(seen) ? core.frozenKey(seen) : null;
      if (seenKey !== core.frozenKey(frozenNow)) throw makeError(409, 'SYSBUILD_VERSION_CHANGED', '附件清单与您查看时不一致，请重新打开查看');
      // 决策内容校验（400，派单 P27 放在最后）。
      const decision = body.decision;
      if (typeof decision !== 'string' || !hasKey(DECISIONS, decision)) throw invalid('decision 必须是 confirm / object / reject 之一', 'decision');
      assertEntryTaskDecision(c.task, decision); // C5：办理结论确认只认 confirm / object，负责人裁定只认 confirm / reject（400）
      // 勾选文案按**所选决策**严格匹配（M-3）：用 confirm 的文案提交 reject 一样 400。
      if (body.checkbox_text !== core.checkboxTextsOf(c.task.purpose)[decision]) throw invalid('勾选文案与所选决策的固定文案不一致', 'checkbox_text');
      const reason = readText(body.reason, 'reason', '原因', REASON_MAX, decision !== 'confirm');
      const toStatus = DECISIONS[decision];
      const up = await q.run(
        "UPDATE sysbuild_confirm_task_revisions SET status = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'pending'",
        [toStatus, c.latest.id]
      );
      if (up.changes === 0) throw stateError('确认任务修订状态已变化，请刷新后重试');
      const ins = await q.run(
        "INSERT INTO sysbuild_confirmations (task_revision_id, object_type, object_version_id, actor_user_id, method, decision, checkbox_text, reason, view_id) VALUES (?, ?, ?, ?, 'platform', ?, ?, ?, ?)",
        [c.latest.id, c.task.object_type, c.task.object_version_id, uid, decision, body.checkbox_text, reason, view.id] // 保存实际提交的文案（上面已校验与该决策的固定文案逐字相等）
      );
      await emit(q, user, c.task.project_id, 'confirm_task', tid, 'confirmation_recorded', {
        confirmation_id: ins.lastID, revision_id: c.latest.id, object_type: c.task.object_type, object_version_id: c.task.object_version_id,
        decision, method: 'platform', view_id: view.id, reason,
      });
      const result = { decision, revision: { id: c.latest.id, status: toStatus }, confirmation_id: ins.lastID };
      await applyDecisionEffects(q, user, c, decision, reason, ins.lastID, 'platform', result);
      return result;
    });
    res.json(out);
  }));

  // 决策落库之后的对象侧效果（decide 与代录共用，C4b：代录确认计入通过、提出人状态映射为 proxy_confirmed）。method = 'platform' | 'proxy'；result 原地补字段。
  async function applyDecisionEffects(q, user, c, decision, reason, confirmationId, method, result) {
    // C6b（§9.2）：确认人在平台上作出有异议 / 不认可 → 项目 PM 收到发送意图；代录（method = proxy）是 PM 自己录的，不通知。
    if (decision !== 'confirm' && method === 'platform') {
      await notifyCore.enqueuePmIntent(q, { projectId: c.task.project_id, purpose: notifyCore.PURPOSES.DECISION_OBJECTED, refType: notifyCore.REF_TYPES.REVISION, refId: c.latest.id, actorUserId: c.requiredUserId }); // L6：作出决策的人（必需确认人）本人就是 PM 时不写；代录时决策人是被代录的必需确认人，不是操作的 PM
    }
    if (c.task.object_type === 'package_version') {
      if (decision === 'confirm') {
        const eff = await core.takeEffectIfComplete(q, user, c.task.project_id, c.obj.pkg, c.obj.ver);
        result.effective = eff.effective;
        result.superseded_version_ids = eff.superseded;
        result.baseline_node_ids = eff.baselineNodes;
        result.advanced_batch_ids = eff.advancedBatches; // M-1：合并形态总体规划包生效时由「规划中」推进到「进行中」的批次
        if (eff.newOverallVersionId !== undefined) { // C5 S-S1c：变更包生效 → 新生成的完整总体规划版本
          result.new_overall_version_id = eff.newOverallVersionId;
          result.old_overall_version_id = eff.oldOverallVersionId;
        }
      } else {
        result.effective = false;
      }
      result.version = { id: c.obj.ver.id, status: result.effective ? 'effective' : 'pending' };
    } else if (c.task.object_type === 'item_version' && decision !== 'object') {
      // 提出人状态由确认记录驱动（不变量 3）：确认 → confirmed（代录 → proxy_confirmed）；不认可 → denied + 原因；有异议不改。条件更新带「proposer_status = 'pending'」。
      const confirmedTo = method === 'proxy' ? 'proxy_confirmed' : 'confirmed';
      const to = decision === 'confirm' ? confirmedTo : 'denied';
      const upd = decision === 'confirm'
        ? await q.run("UPDATE sysbuild_item_versions SET proposer_status = ? WHERE id = ? AND proposer_status = 'pending'", [confirmedTo, c.task.object_version_id])
        : await q.run("UPDATE sysbuild_item_versions SET proposer_status = 'denied', deny_reason = ? WHERE id = ? AND proposer_status = 'pending'", [reason, c.task.object_version_id]);
      if (upd.changes === 0) throw stateError('条目版本的提出人状态已变化，请刷新后重试');
      await emit(q, user, c.task.project_id, 'item_version', c.task.object_version_id, 'item_proposer_status_changed', Object.assign({
        item_id: c.task.object_id, from: 'pending', to, confirmation_id: confirmationId,
      }, method === 'proxy' ? { method } : {}));
      result.proposer_status = to;
    } else if (c.task.object_type === 'conclusion' || c.task.object_type === 'adjudication') {
      // C5：登记的结论状态由办理记录 + 修订状态派生（不落列、不另写），决策落库（修订终态 + 确认记录）之后重读派生值回填：
      //   结论确认 confirm → 已确认 / object → 有异议；裁定 confirm → 裁定通过 / reject → 裁定未通过（对应 entries-core.deriveEntryState）。
      const after = await entriesCore.loadEntryTaskObject(q, c.task);
      result.entry = { id: c.task.object_id, conclusion_state: after ? after.status : null };
    } else if (c.task.object_type === 'dev_entry') {
      // C5 S-S1c：开发方关键事项的认可状态由任务最近修订派生（不落列）：确认 → 已认可；不认可 → 负责人未认可
      const after = await entriesCore.loadDevTaskObject(q, c.task);
      result.entry = { id: c.task.object_id, dev_confirm: after ? after.devStatus : null };
    } else if (c.task.object_type === 'handover') {
      // C6a：交接确认没有对象侧写入（「已清」由任务修订状态 + 指纹在读 / 上线时派生）；响应带该登记当前的交接确认状态，页面免再取一次
      const after = await goliveCore.loadHandoverTaskObject(q, c.task);
      result.handover = { entry_id: c.task.object_id, purpose: c.task.purpose, fingerprint_current: after ? after.pending : false };
    }
  }

  // ── POST /sysbuild/confirm-tasks/:tid/proxy：代录一次决策（C4b P45 / P49 / P50）────────────────────────────
  // 对已存在的确认任务（package_confirm / proposer_confirm）的当前修订，由本项目 PM 代录必需确认人在平台外作出的确认 / 有异议 / 不认可：不要求浏览与勾选，
  //   必须写实际确认人、身份依据、外部确认日期（不晚于今天、不早于本修订创建日）并绑定至少 1 个本人暂存的凭据附件。有账号的人也可以被代录。
  //   检查顺序：400 参数形态 → 404 → 403 → 409（项目状态 / 修订号 / 版本号 / 修订状态 / 对象状态 / 资格 / 历史补录窗口）→ 400 日期范围与附件可用性。
  router.post('/sysbuild/confirm-tasks/:tid/proxy', parseJsonBody, handle(async (req, res) => {
    const tid = readIdParam(req.params.tid, 'tid', '任务编号');
    const body = bodyOf(req);
    onlyKeys(body, ['revision_id', 'object_version_id', 'decision', 'reason', ...core.PROXY_KEYS]);
    const revisionId = readIdParam(body.revision_id, 'revision_id', '任务修订编号');
    const objectVersionId = readIdParam(body.object_version_id, 'object_version_id', '对象版本编号');
    const decision = typeof body.decision === 'string' && hasKey(DECISIONS, body.decision) ? body.decision : null;
    if (decision === null) throw invalid('decision 必须是 confirm / object / reject 之一', 'decision');
    const reason = readText(body.reason, 'reason', '原因说明', REASON_MAX, decision !== 'confirm');
    const evidence = core.readProxyEvidence(body, '代录');
    const user = req.user;
    const out = await db.withWriteTxn(async (q) => {
      const c = await loadTaskCtx(q, tid, user);
      rules.assertOp(proxyOpOf(c.task), c.access, c.access.project, await proxyTarget(q, c, user, { revisionId, objectVersionId }));
      assertEntryTaskDecision(c.task, decision); // C5：办理结论确认的代录同样只认 confirm / object（负责人裁定不可代录，上一行 proxyable 已拒）
      core.assertProxyDate(evidence.externalDate, c.latest.created_at, today(), '本修订的创建日期');
      const toStatus = DECISIONS[decision];
      await core.settleRevision(q, c.latest.id, toStatus);
      const rec = await core.recordProxyConfirmation(q, user, attachmentHelpers, {
        projectId: c.task.project_id, taskId: tid, revisionId: c.latest.id, objectType: c.task.object_type, objectVersionId: c.task.object_version_id,
        requiredMemberId: c.latest.required_member_id, actorUserId: c.requiredUserId, decision, reason, evidence,
      });
      const result = { decision, method: 'proxy', revision: { id: c.latest.id, status: toStatus }, confirmation_id: rec.confirmationId, attachment_ids: rec.attachmentIds };
      await applyDecisionEffects(q, user, c, decision, reason, rec.confirmationId, 'proxy', result);
      return result;
    });
    res.json(out);
  }));

  // ── GET /sysbuild/my/confirmations：我作为必需确认人的待确认修订 ────────────────────────────────────────
  //   C6b：列表取数抽成 myConfirmationItems(q, user)，GET /my/todo 的 confirm 类与顶部角标计数读同一个函数（与本端点同源，不另写第二份口径）。
  async function myConfirmationItems(q, user) {
    const uid = Number(user.id);
    {
      const rows = await q.all(
        `SELECT r.id AS revision_id, r.rev_no AS rev_no, r.created_at AS created_at, r.required_member_id AS required_member_id,
                r.basis_appointment_id AS basis_appointment_id, r.basis_delegation_id AS basis_delegation_id,
                t.id AS task_id, t.project_id AS project_id, t.object_type AS object_type,
                t.object_id AS object_id, t.object_version_id AS object_version_id, t.purpose AS purpose, t.party_id AS party_id, p.system_name AS system_name
           FROM sysbuild_confirm_task_revisions r
           JOIN sysbuild_confirm_tasks t ON t.id = r.task_id
           JOIN sysbuild_members m ON m.id = r.required_member_id
           JOIN sysbuild_projects p ON p.id = t.project_id
          WHERE r.status = 'pending' AND m.user_id = ?
          ORDER BY r.id`,
        [uid]
      );
      // 只列「此刻我还能作出确认」的修订（预筛 L3②）：项目可见、项目状态允许作出推进类确认（P38：已终止 / 已结项的项目不列）、
      //   且资格复核通过——与 decide 同一个判定（core.qualificationLoss：成员已移出 / 账号停用 / 任职或授权不再生效的都不列）。
      //   C6b 修订批 1（K1）：三项判定抽成 core.confirmAvailabilityBlock，钉钉发送侧（notify.js describeRef）调同一个函数。
      const projectInfo = {};
      const items = [];
      for (const r of rows) {
        if ((await core.confirmAvailabilityBlock(q, r, user, accessOpts(), projectInfo)) !== null) continue;
        items.push({
          task_id: r.task_id, revision_id: r.revision_id, rev_no: r.rev_no, created_at: r.created_at, project_id: r.project_id, system_name: r.system_name,
          object_type: r.object_type, object_id: r.object_id, object_version_id: r.object_version_id, purpose: r.purpose, party_id: r.party_id,
        });
      }
      return items;
    }
  }
  router.get('/sysbuild/my/confirmations', handle(async (req, res) => {
    const out = await db.withRead(async (q) => ({ items: await myConfirmationItems(q, req.user) }));
    res.json(out);
  }));

  // recheckOverallSet 一并交出：历史事实导入（history.js package_effective）按 C4a 提交的同一套条目集合重核（P56），不复制。
  //   myConfirmationItems：C6b GET /my/todo 的 confirm 类与角标计数用（与 GET /my/confirmations 同源）。
  return { router, recheckOverallSet, myConfirmationItems };
}

module.exports = { createConfirmRoutes };
