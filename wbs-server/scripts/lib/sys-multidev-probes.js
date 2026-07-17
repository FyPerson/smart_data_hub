// scripts/lib/sys-multidev-probes.js — 探针 P1-P15（C0，多开发协作与 commit 留痕重构 v2.9；P15 为 2026-07-17
//   对抗审 H1 新增，95 号复审收口）
//   SSOT = 开发计划 v2.9 §3.2「探针全表 P1-P15」（逐条断言逐字对照）+ 方案 v2.9 §9（时点/恒真分离原则：
//   探针只查恒真不变量，时点断言归各验收场景 S 系列，不在本模块）。
//
// 设计：runProbes(db) 纯 SELECT（无 INSERT/UPDATE/DELETE），可在调用方已开启的事务内安全调用
//   （C0 一次性重置脚本 sys-multidev-c0-reset.js 事务内复用本模块；独立跑器 verify-sys-multidev-probes.js
//   在测试库正例/反例场景下调用验证探针本身能正确亮红）。
//   部分探针的"载荷结构/JSON 合法性"校验用 JS 侧 JSON.parse + 字段校验（而非纯 SQL json1 函数拼接）——
//   更精确的错误消息 + 更易读；SELECT 本身仍是唯一的数据库交互动作，满足"纯 SELECT"契约。
'use strict';

const { isInFamily } = require('../../routes/sys-iteration/status-families');

// ── db helper（原生 sqlite3.Database 实例的 Promise 化，探针模块自带，不依赖调用方注入 dbAllAsync）──────────
function promisifyDb(db) {
  return {
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []))),
    get: (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))),
  };
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const COMPONENT_ENUM = ['frontend', 'backend'];
const DEV_STATUS_ENUM = ['pending', 'code_submitted', 'no_code', 'excused'];

// 必填 reason 的字面 action 值（方案 §3：「必填动作=excuse/remove/self-remove/supersede-excuse/delete-commit/reassign（请求级）」——
//   reassign **不是** sys_issue_dev_events.action 的字面枚举值（DDL CHECK 无 'reassign'，方案 §3「事件按差量记 remove+add」，
//   reassign 落地为共享 operation_id 的 add/remove 事件组），故这里只列 DB 实际会写入的 5 个字面值；reassign 请求级
//   reason 必填由端点写入前校验（不在本探针职责——P13 负责 reassign 事件组 payload.reason 一致性，非本条"非空"判断）。
const REQUIRED_REASON_ACTIONS = ['excuse', 'remove', 'self-remove', 'supersede-excuse', 'delete-commit'];

function nonEmptyTrim(s, min, max) {
  return typeof s === 'string' && s.trim().length >= min && s.trim().length <= max;
}

// H3（86 号审）：commit_id/dev_assignee_id 的「原始值为正整数」校验——禁 Number(v) 强转（会把 null/''/'3'
//   这类非数字类型静默转成合法数字放行，如 Number(null)===0 恰巧不过、但 Number('3')===3 会误放行字符串）。
function isPositiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// H3（86 号审）：commit_ref 严格校验——在 nonEmptyTrim 的"trim 后长度合规"之上，再加"原始值即等于其 trim 结果"
//   （对齐 P8 对 sys_issue_dev_commits.commit_ref 本身的校验口径，计划 §3.2 P11「字段值域合规」）。
function strictCommitRef(s) {
  return nonEmptyTrim(s, 1, 200) && s === s.trim();
}

function safeParseJson(raw) {
  if (raw === null || raw === undefined) return { ok: false, value: undefined };
  try { return { ok: true, value: JSON.parse(raw) }; } catch (_) { return { ok: false, value: undefined }; }
}

function result(id, pass, detail) {
  return { id, pass: !!pass, detail };
}

// ── P1：dev_status 值域 ──────────
async function p1(H) {
  const rows = await H.all(`SELECT COUNT(*) c FROM sys_issue_dev_assignees WHERE dev_status NOT IN (${DEV_STATUS_ENUM.map(() => '?').join(',')})`, DEV_STATUS_ENUM);
  const c = rows[0].c;
  return result('P1', c === 0, c === 0 ? 'dev_status 值域全部合法' : `${c} 行 dev_status 不在 ('pending','code_submitted','no_code','excused') 值域内`);
}

// ── P2：pending 配对 ── resolved_at IS NULL ∧ no_code_reason IS NULL ∧ commit 行=0
async function p2(H) {
  const rows = await H.all(`
    SELECT COUNT(*) c FROM sys_issue_dev_assignees da
    WHERE da.dev_status = 'pending'
      AND NOT (
        da.resolved_at IS NULL AND da.no_code_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM sys_issue_dev_commits c WHERE c.dev_assignee_id = da.id)
      )
  `);
  const c = rows[0].c;
  return result('P2', c === 0, c === 0 ? 'pending 配对全部合规' : `${c} 行 pending 违反配对不变量（resolved_at/no_code_reason 应为 NULL 且 commit 行应为 0）`);
}

// ── P3：code_submitted 配对 ── resolved_at NOT NULL ∧ no_code_reason IS NULL ∧ commit 行≥1
async function p3(H) {
  const rows = await H.all(`
    SELECT COUNT(*) c FROM sys_issue_dev_assignees da
    WHERE da.dev_status = 'code_submitted'
      AND NOT (
        da.resolved_at IS NOT NULL AND da.no_code_reason IS NULL
        AND EXISTS (SELECT 1 FROM sys_issue_dev_commits c WHERE c.dev_assignee_id = da.id)
      )
  `);
  const c = rows[0].c;
  return result('P3', c === 0, c === 0 ? 'code_submitted 配对全部合规' : `${c} 行 code_submitted 违反配对不变量（resolved_at 应非空/no_code_reason 应为 NULL/commit 行应≥1）`);
}

// ── P4：no_code 配对 ── resolved_at NOT NULL ∧ trim(no_code_reason) 长度 1..500 ∧ commit 行=0
async function p4(H) {
  const rows = await H.all(`
    SELECT COUNT(*) c FROM sys_issue_dev_assignees da
    WHERE da.dev_status = 'no_code'
      AND NOT (
        da.resolved_at IS NOT NULL
        AND da.no_code_reason IS NOT NULL AND length(trim(da.no_code_reason)) BETWEEN 1 AND 500
        AND NOT EXISTS (SELECT 1 FROM sys_issue_dev_commits c WHERE c.dev_assignee_id = da.id)
      )
  `);
  const c = rows[0].c;
  return result('P4', c === 0, c === 0 ? 'no_code 配对全部合规' : `${c} 行 no_code 违反配对不变量（resolved_at 非空/no_code_reason trim 长度 1..500/commit 行应为 0）`);
}

// ── P5：excused 配对 ── resolved_at NOT NULL ∧ no_code_reason IS NULL ∧ commit 行=0
async function p5(H) {
  const rows = await H.all(`
    SELECT COUNT(*) c FROM sys_issue_dev_assignees da
    WHERE da.dev_status = 'excused'
      AND NOT (
        da.resolved_at IS NOT NULL AND da.no_code_reason IS NULL
        AND NOT EXISTS (SELECT 1 FROM sys_issue_dev_commits c WHERE c.dev_assignee_id = da.id)
      )
  `);
  const c = rows[0].c;
  return result('P5', c === 0, c === 0 ? 'excused 配对全部合规' : `${c} 行 excused 违反配对不变量（resolved_at 应非空/no_code_reason 应为 NULL/commit 行应为 0）`);
}

// ── P6：双在册 ── 同 (issue_id,user_id) 在册（removed_at IS NULL）计数≤1
async function p6(H) {
  const rows = await H.all(`
    SELECT issue_id, user_id, COUNT(*) c FROM sys_issue_dev_assignees
    WHERE removed_at IS NULL
    GROUP BY issue_id, user_id HAVING COUNT(*) > 1
  `);
  return result('P6', rows.length === 0, rows.length === 0 ? '无双在册' : `${rows.length} 组 (issue_id,user_id) 同时在册≥2 行：${rows.map(r => `(${r.issue_id},${r.user_id})×${r.c}`).join('; ')}`);
}

// ── P7：commit 三元组 ── 每行 (issue_id, dev_user_id) 与其 dev_assignee_id 指向的 assignees 行一致
async function p7(H) {
  const rows = await H.all(`
    SELECT c.id FROM sys_issue_dev_commits c
    LEFT JOIN sys_issue_dev_assignees da ON da.id = c.dev_assignee_id
    WHERE da.id IS NULL OR c.issue_id <> da.issue_id OR c.dev_user_id <> da.user_id
  `);
  return result('P7', rows.length === 0, rows.length === 0 ? 'commit 三元组全部一致' : `${rows.length} 行 commit 的 (issue_id,dev_user_id) 与 dev_assignee_id 指向行不一致或指向不存在：id=${rows.map(r => r.id).join(',')}`);
}

// ── P8：commit 自然键+trim ── 同 (dev_assignee_id, component, commit_ref) 无重复 ∧ commit_ref = trim(commit_ref)
async function p8(H) {
  const dupRows = await H.all(`
    SELECT dev_assignee_id, component, commit_ref, COUNT(*) c FROM sys_issue_dev_commits
    GROUP BY dev_assignee_id, component, commit_ref HAVING COUNT(*) > 1
  `);
  const trimRows = await H.all(`SELECT id FROM sys_issue_dev_commits WHERE commit_ref <> trim(commit_ref)`);
  const pass = dupRows.length === 0 && trimRows.length === 0;
  const details = [];
  if (dupRows.length > 0) details.push(`${dupRows.length} 组自然键重复`);
  if (trimRows.length > 0) details.push(`${trimRows.length} 行 commit_ref 未 trim（id=${trimRows.map(r => r.id).join(',')}）`);
  return result('P8', pass, pass ? 'commit 自然键无重复且全部已 trim' : details.join('；'));
}

// ── P9：supersede 一致性（双向+防自指+防分叉+id 序）──────────
async function p9(H) {
  // a) superseded_by 指向存在行 ∧ 同 issue ∧ 同 user_id ∧ 目标 id≠源 id ∧ 目标 id>源 id
  const badLink = await H.all(`
    SELECT src.id FROM sys_issue_dev_assignees src
    LEFT JOIN sys_issue_dev_assignees tgt ON tgt.id = src.superseded_by
    WHERE src.superseded_by IS NOT NULL
      AND (tgt.id IS NULL OR tgt.issue_id <> src.issue_id OR tgt.user_id <> src.user_id OR tgt.id <= src.id)
  `);
  // b) 防分叉：每个非空 superseded_by 值至多被一个源行引用
  const forkRows = await H.all(`
    SELECT superseded_by FROM sys_issue_dev_assignees WHERE superseded_by IS NOT NULL
    GROUP BY superseded_by HAVING COUNT(*) > 1
  `);
  // c) 源行 excused ∧ removed_at NOT NULL
  const badSource = await H.all(`
    SELECT id FROM sys_issue_dev_assignees
    WHERE superseded_by IS NOT NULL AND (dev_status <> 'excused' OR removed_at IS NULL)
  `);
  // d) 双向恰一条事件——正向：链（superseded_by 非空的源行）⇒ 必有恰一条对应 supersede-excuse 事件
  const srcRows = await H.all(`SELECT id, issue_id, superseded_by FROM sys_issue_dev_assignees WHERE superseded_by IS NOT NULL`);
  const badEvent = [];
  for (const src of srcRows) {
    const evRows = await H.all(
      `SELECT COUNT(*) c FROM sys_issue_dev_events WHERE action = 'supersede-excuse' AND dev_assignee_id = ? AND related_dev_assignee_id = ? AND issue_id = ?`,
      [src.id, src.superseded_by, src.issue_id]
    );
    if (evRows[0].c !== 1) badEvent.push(src.id);
  }
  // d) 双向恰一条事件——反向（H2，86 号审）：每条 supersede-excuse 事件 ⇒ 必有恰一条对应链（源行 src 满足
  //   src.id=事件.dev_assignee_id ∧ src.superseded_by=事件.related_dev_assignee_id ∧ src.issue_id=事件.issue_id）。
  //   正向只保证「有链必有事件」，不保证「有事件必有链」——凭空插一条 supersede-excuse 事件（related 指向存在
  //   行但源行 superseded_by 未指回它）此前不会被拦截，本反向查询补上。
  const orphanEvents = await H.all(`
    SELECT e.id FROM sys_issue_dev_events e
    LEFT JOIN sys_issue_dev_assignees src
      ON src.id = e.dev_assignee_id AND src.superseded_by = e.related_dev_assignee_id AND src.issue_id = e.issue_id
    WHERE e.action = 'supersede-excuse' AND src.id IS NULL
  `);
  const pass = badLink.length === 0 && forkRows.length === 0 && badSource.length === 0 && badEvent.length === 0 && orphanEvents.length === 0;
  const details = [];
  if (badLink.length > 0) details.push(`${badLink.length} 行 superseded_by 链路非法（不存在/跨 issue/跨 user/id 序错误）：id=${badLink.map(r => r.id).join(',')}`);
  if (forkRows.length > 0) details.push(`${forkRows.length} 个目标 id 被多个源行引用（分叉）`);
  if (badSource.length > 0) details.push(`${badSource.length} 行源行非 excused 或未软删：id=${badSource.map(r => r.id).join(',')}`);
  if (badEvent.length > 0) details.push(`${badEvent.length} 行 supersede-excuse 事件非恰一条：源id=${badEvent.join(',')}`);
  if (orphanEvents.length > 0) details.push(`${orphanEvents.length} 条 supersede-excuse 事件无对应链（反向缺失）：event id=${orphanEvents.map(r => r.id).join(',')}`);
  return result('P9', pass, pass ? 'supersede 一致性全部合规（双向+防自指+防分叉+id 序）' : details.join('；'));
}

// ── P10：events related（双向）── supersede-excuse ⇒ related 必非空；其它 ⇒ 必空
async function p10(H) {
  const missingRelated = await H.all(`SELECT id FROM sys_issue_dev_events WHERE action = 'supersede-excuse' AND related_dev_assignee_id IS NULL`);
  const extraRelated = await H.all(`SELECT id FROM sys_issue_dev_events WHERE action <> 'supersede-excuse' AND related_dev_assignee_id IS NOT NULL`);
  const pass = missingRelated.length === 0 && extraRelated.length === 0;
  const details = [];
  if (missingRelated.length > 0) details.push(`${missingRelated.length} 条 supersede-excuse 事件 related 缺失：id=${missingRelated.map(r => r.id).join(',')}`);
  if (extraRelated.length > 0) details.push(`${extraRelated.length} 条非 supersede-excuse 事件 related 非空：id=${extraRelated.map(r => r.id).join(',')}`);
  return result('P10', pass, pass ? 'events related 双向合规' : details.join('；'));
}

// ── P11：events 载荷结构（恒真版）──────────
//   ① 必填动作 reason 非空；② submit 事件 payload 合法 JSON∧commits 非空∧commit_id 唯一∧字段值域合规∧dev_assignee_id 一致
//     （不与当前行数比较——时点断言归 S2/S23）；③ no_code 事件 payload 结构；④ commit 事件（add/edit/delete-commit）载荷含规格字段。
async function p11(H) {
  const badReason = [];
  const reasonRows = await H.all(
    `SELECT id, action, reason FROM sys_issue_dev_events WHERE action IN (${REQUIRED_REASON_ACTIONS.map(() => '?').join(',')})`,
    REQUIRED_REASON_ACTIONS
  );
  for (const r of reasonRows) {
    if (!nonEmptyTrim(r.reason, 1, 200)) badReason.push(r.id);
  }

  const badSubmit = [];
  const submitRows = await H.all(`SELECT id, dev_assignee_id, payload_json FROM sys_issue_dev_events WHERE action = 'submit'`);
  for (const r of submitRows) {
    const { ok, value } = safeParseJson(r.payload_json);
    // 复审残留1：顶层 dev_assignee_id 同 H3 口径改「原始值正整数 + 严格相等」，禁 Number() 强转
    //   （Number("1")===Number(1) 会误放行字符串 "1"）。
    let good = ok && value && value.mode === 'commits' && Array.isArray(value.commits) && value.commits.length >= 1
      && isPositiveInt(value.dev_assignee_id) && value.dev_assignee_id === r.dev_assignee_id;
    if (good) {
      const seenCommitIds = new Set();
      for (const item of value.commits) {
        if (item == null || typeof item !== 'object') { good = false; break; }
        if (!isPositiveInt(item.commit_id)) { good = false; break; }   // H3：commits[].commit_id 必须原始正整数（禁 Number() 强转）
        if (seenCommitIds.has(item.commit_id)) { good = false; break; }
        seenCommitIds.add(item.commit_id);
        if (!COMPONENT_ENUM.includes(item.component)) { good = false; break; }
        if (!strictCommitRef(item.commit_ref)) { good = false; break; }   // H3：commit_ref 须原始值即等于其 trim
      }
    }
    if (!good) badSubmit.push(r.id);
  }

  const badNoCode = [];
  const noCodeRows = await H.all(`SELECT id, payload_json FROM sys_issue_dev_events WHERE action = 'no_code'`);
  for (const r of noCodeRows) {
    const { ok, value } = safeParseJson(r.payload_json);
    const good = ok && value && value.mode === 'no_code' && nonEmptyTrim(value.no_code_reason, 1, 500);
    if (!good) badNoCode.push(r.id);
  }

  const badCommitEvent = [];
  const addDelRows = await H.all(`SELECT id, action, dev_assignee_id, payload_json FROM sys_issue_dev_events WHERE action IN ('add-commit','delete-commit')`);
  for (const r of addDelRows) {
    const { ok, value } = safeParseJson(r.payload_json);
    // H3：commit_id/dev_assignee_id 改「原始值为正整数」校验（禁 Number() 强转）；dev_assignee_id 额外须与
    //   事件自身 dev_assignee_id 列严格相等（===，非强转后的松散相等）。
    const good = ok && value && COMPONENT_ENUM.includes(value.component) && strictCommitRef(value.commit_ref)
      && isPositiveInt(value.commit_id) && isPositiveInt(value.dev_assignee_id) && value.dev_assignee_id === r.dev_assignee_id;
    if (!good) badCommitEvent.push(r.id);
  }
  const editRows = await H.all(`SELECT id, payload_json FROM sys_issue_dev_events WHERE action = 'edit-commit'`);
  for (const r of editRows) {
    const { ok, value } = safeParseJson(r.payload_json);
    const validSide = (side) => side && COMPONENT_ENUM.includes(side.component) && strictCommitRef(side.commit_ref);
    const good = ok && value && isPositiveInt(value.commit_id) && validSide(value.old) && validSide(value.new);
    if (!good) badCommitEvent.push(r.id);
  }

  const pass = badReason.length === 0 && badSubmit.length === 0 && badNoCode.length === 0 && badCommitEvent.length === 0;
  const details = [];
  if (badReason.length > 0) details.push(`${badReason.length} 条必填 reason 动作 reason 空/非法：id=${badReason.join(',')}`);
  if (badSubmit.length > 0) details.push(`${badSubmit.length} 条 submit 事件 payload 结构非法：id=${badSubmit.join(',')}`);
  if (badNoCode.length > 0) details.push(`${badNoCode.length} 条 no_code 事件 payload 结构非法：id=${badNoCode.join(',')}`);
  if (badCommitEvent.length > 0) details.push(`${badCommitEvent.length} 条 commit 事件（add/edit/delete-commit）payload 结构非法：id=${badCommitEvent.join(',')}`);
  return result('P11', pass, pass ? 'events 载荷结构全部合规' : details.join('；'));
}

// ── P12：零在册开发执行态 ── 主状态∈SYS_DEV 的 issue 在册≥1
async function p12(H) {
  const rows = await H.all(`
    SELECT i.id, i.type, i.status,
      (SELECT COUNT(*) FROM sys_issue_dev_assignees da WHERE da.issue_id = i.id AND da.removed_at IS NULL) AS active_count
    FROM sys_issues i
  `);
  const bad = rows.filter(r => isInFamily(r.type, r.status, 'DEV') && r.active_count === 0);
  return result('P12', bad.length === 0, bad.length === 0 ? '所有开发执行态 issue 在册≥1' : `${bad.length} 单主状态∈SYS_DEV 但零在册：issue_id=${bad.map(r => r.id).join(',')}`);
}

// ── P13（恒真版·Mz-3 收窄）：reassign 事件组内部一致 ──────────
//   reassign 落地为共享 payload.operation_id 的 add/remove 事件组（非独立 action 值，方案 §3）。
//   H4（86 号审）判别式改法：**payload_json 是否非空**才是"是否走 reassign 信封校验"的判别标准——
//   payload_json IS NULL = 普通 add/remove 合法形态（方案 §3 events 规格：payload 仅用于 submit 明细/commit
//   载荷/reassign）；payload_json 非空则**必须**是完整合法的 reassign 信封（合法 JSON + operation_id 非空
//   合法 UUID + reason trim 1..200 且 event.reason=payload.reason + added/removed_user_ids 为数组），任一
//   环节不满足直接判 P13 fail——不再有"坏 JSON/缺 operation_id 就静默当普通 add/remove 放过"的口子。
async function p13(H) {
  const rows = await H.all(`
    SELECT e.id, e.issue_id, e.dev_assignee_id, e.action, e.reason, e.operator_id, e.payload_json, da.user_id
    FROM sys_issue_dev_events e
    LEFT JOIN sys_issue_dev_assignees da ON da.id = e.dev_assignee_id
    WHERE e.action IN ('add', 'remove')
  `);
  const badEnvelopes = [];   // 单事件级信封校验失败（坏 JSON/结构非法/字段非法）
  const groups = new Map();   // operation_id → [{...row, payload}]（仅信封校验通过的事件才入组）
  for (const r of rows) {
    if (r.payload_json === null || r.payload_json === undefined) continue;   // 普通 add/remove 合法形态，不参与 reassign 校验
    const { ok, value } = safeParseJson(r.payload_json);
    if (!ok || !value || typeof value !== 'object') { badEnvelopes.push(`event#${r.id}: payload_json 非合法 JSON`); continue; }
    if (typeof value.operation_id !== 'string' || value.operation_id.length === 0) { badEnvelopes.push(`event#${r.id}: operation_id 缺失/非法`); continue; }
    if (!UUID_RE.test(value.operation_id)) { badEnvelopes.push(`event#${r.id}: operation_id 非法 UUID 格式`); continue; }
    if (!nonEmptyTrim(value.reason, 1, 200)) { badEnvelopes.push(`event#${r.id}: payload.reason 非法（须 trim 长度 1..200）`); continue; }
    if (r.reason !== value.reason) { badEnvelopes.push(`event#${r.id}: event.reason≠payload.reason`); continue; }
    if (!Array.isArray(value.added_user_ids) || !Array.isArray(value.removed_user_ids)) { badEnvelopes.push(`event#${r.id}: added_user_ids/removed_user_ids 须为数组`); continue; }
    // 复审残留2：数组元素同 H3 口径逐个校验「原始值正整数」（禁 Number() 强转——如字符串 "107" 不放行）。
    if (!value.added_user_ids.every(isPositiveInt) || !value.removed_user_ids.every(isPositiveInt)) {
      badEnvelopes.push(`event#${r.id}: added_user_ids/removed_user_ids 元素须为原始正整数`); continue;
    }
    const opId = value.operation_id;
    if (!groups.has(opId)) groups.set(opId, []);
    groups.get(opId).push({ ...r, payload: value });
  }

  const badGroups = [];
  for (const [opId, group] of groups) {
    const issueIds = new Set(group.map(g => g.issue_id));
    const operatorIds = new Set(group.map(g => g.operator_id));
    if (issueIds.size > 1) { badGroups.push(`${opId}: issue_id 组内不一致`); continue; }
    if (operatorIds.size > 1) { badGroups.push(`${opId}: operator_id 组内不一致`); continue; }
    const payloadStrs = new Set(group.map(g => JSON.stringify({ reason: g.payload.reason, added: g.payload.added_user_ids, removed: g.payload.removed_user_ids })));
    if (payloadStrs.size > 1) { badGroups.push(`${opId}: payload(reason/added/removed) 组内不一致`); continue; }
    const first = group[0].payload;
    // 复审残留2：Set 不再 map(Number)——added_user_ids/removed_user_ids 元素已在信封校验阶段确保是原始正整数，
    //   成员比对用原始值严格相等（===，Set.has 天然按值等同判断，无需再强转）。
    const addedSet = new Set(first.added_user_ids);
    const removedSet = new Set(first.removed_user_ids);
    for (const g of group) {
      // 复审残留2：LEFT JOIN 未命中（g.user_id===null）= dev_assignee_id 指向不存在的 assignee 行，直接判组 fail，
      //   不能带 null 去比对（null 会被当成"哪个集合都不在"从而产生误导性 detail，需显式识别）。
      if (g.user_id === null) { badGroups.push(`${opId}: 事件(id=${g.id})的 dev_assignee_id 指向不存在的 assignee 行`); break; }
      const uid = g.user_id;
      if (g.action === 'add' && !addedSet.has(uid)) { badGroups.push(`${opId}: add 事件成员(uid=${uid})不在 added_user_ids`); break; }
      if (g.action === 'remove' && !removedSet.has(uid)) { badGroups.push(`${opId}: remove 事件成员(uid=${uid})不在 removed_user_ids`); break; }
    }
  }
  const allBad = badEnvelopes.concat(badGroups);
  return result('P13', allBad.length === 0, allBad.length === 0 ? `reassign 事件组内部一致（共 ${groups.size} 组）` : allBad.join('；'));
}

// ── P14：VERIFY 态恒真 ── 主状态∈SYS_VERIFY 的 issue：在册≥1 ∧ 无 pending 在册
async function p14(H) {
  const rows = await H.all(`
    SELECT i.id, i.type, i.status,
      (SELECT COUNT(*) FROM sys_issue_dev_assignees da WHERE da.issue_id = i.id AND da.removed_at IS NULL) AS active_count,
      (SELECT COUNT(*) FROM sys_issue_dev_assignees da WHERE da.issue_id = i.id AND da.removed_at IS NULL AND da.dev_status = 'pending') AS pending_count
    FROM sys_issues i
  `);
  const bad = rows.filter(r => isInFamily(r.type, r.status, 'VERIFY') && (r.active_count === 0 || r.pending_count > 0));
  return result('P14', bad.length === 0, bad.length === 0 ? '所有待验证态 issue 在册≥1 且无 pending 在册' : `${bad.length} 单主状态∈SYS_VERIFY 但零在册或含 pending：issue_id=${bad.map(r => r.id).join(',')}`);
}

// ── P15（H1·对抗审 2026-07-17 引入，95 号复审收口）：SYS_RELEASE 族恒真 ── 主状态∈SYS_RELEASE（待上线/
//   已上线）的 issue：在册≥1 ∧ 无 pending 在册（同 P14 对 SYS_VERIFY 的口径，按 issue_type 取族常量，禁硬
//   编码状态清单）。
//   本探针是 runProbes(db) 的一部分，会被 C0 一次性重置脚本（sys-multidev-c0-reset.js）在事务内自动纳入
//   （该脚本调用 runProbes(db) 而非硬编码探针清单）。⚠️（95 号复审收口）此探针最初引入时暴露过一个死循环：
//   若 reset 脚本对全部 issue（含已在 SYS_RELEASE 族的存量单）一律置 pending，则 RELEASE 族单每次重跑都会
//   被本探针拒绝、reset 永远无法收敛（不是可接受的 fail-closed）——已通过修 reset 脚本本身解决（非改本探针）：
//   reset 现按主状态族区分回填，RELEASE 族单的 roster 行统一回填为 no_code 完成态（方案 §3 四态配对不变量
//   规格自带形态），零在册的 RELEASE 族单由 reset 自身的 pre-check 在覆盖动作前 fail-fast 拦截、要求人工先
//   补齐——reset 收敛后产出的 RELEASE 族单必然满足本探针，不再有死循环。
async function p15(H) {
  const rows = await H.all(`
    SELECT i.id, i.type, i.status,
      (SELECT COUNT(*) FROM sys_issue_dev_assignees da WHERE da.issue_id = i.id AND da.removed_at IS NULL) AS active_count,
      (SELECT COUNT(*) FROM sys_issue_dev_assignees da WHERE da.issue_id = i.id AND da.removed_at IS NULL AND da.dev_status = 'pending') AS pending_count
    FROM sys_issues i
  `);
  const bad = rows.filter(r => isInFamily(r.type, r.status, 'RELEASE') && (r.active_count === 0 || r.pending_count > 0));
  return result('P15', bad.length === 0, bad.length === 0 ? '所有发布控制态(SYS_RELEASE)issue 在册≥1 且无 pending 在册' : `${bad.length} 单主状态∈SYS_RELEASE 但零在册或含 pending：issue_id=${bad.map(r => r.id).join(',')}`);
}

const PROBE_FNS = [p1, p2, p3, p4, p5, p6, p7, p8, p9, p10, p11, p12, p13, p14, p15];

// 依次跑 P1-P15，返回 [{id,pass,detail}, ...]（顺序固定 P1→P15）。
//   纯 SELECT——db 若已在事务内（BEGIN IMMEDIATE 已开），本函数不额外开/提交/回滚事务，调用方自行控制。
async function runProbes(db) {
  const H = promisifyDb(db);
  const results = [];
  for (const fn of PROBE_FNS) {
    results.push(await fn(H));
  }
  return results;
}

module.exports = { runProbes, promisifyDb, UUID_RE, COMPONENT_ENUM, DEV_STATUS_ENUM, REQUIRED_REASON_ACTIONS };
