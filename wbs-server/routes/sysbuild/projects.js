// routes/sysbuild/projects.js — 项目管理（系统建设记录）模块：项目端点（C2a）
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §4.5（状态机与状态 × 动作）、§5（权限）、§7（接口）。
//   派单 = docs/local/系统建设记录/送审准备/C2a_权限核心与项目端点_派单_20261029.md。
//
// 工厂 createProjectRoutes(ctx) 返回 { router }。ctx：{ db, logger, readonlyIds }，readonlyIds 必填（数组或 Set），缺失抛错。
//   router 上的路径都以 /sysbuild/ 开头；鉴权与就绪闸门由 index.js 对 /sysbuild 前置，这里不再挂。
//
// 检查顺序固定（§5.3）：参数 400 → 对象存在 404 → 可见性（成员 / admin / 只读，否则 404）→ 动作 403 → 项目状态 409
//   SYSBUILD_PROJECT_READONLY → 对象状态与业务规则 409 SYSBUILD_STATE / 400。写端点全部在 withWriteTxn 内完成
//   「加载 → 校验 → 写 → 写事件」，读端点用 withRead。可见性 / 动作 / 状态三步全部经 rules.assertCan，不在这里自己拆开排序。
//
// 返回给客户端的 actions 与写端点的执行同源：都调用 rules.js 的同一组判定函数 + PROJECT_ACTION_TABLE（rules.actionsFor），前端不推算。
'use strict';
const visibility = require('./membership-visibility');
const express = require('express');
const schema = require('./schema');
const rules = require('./rules');
const { makeError } = require('./db');
const { writeEvent } = require('./events');
const membership = require('./membership');
const { seedProjectStructure } = require('./templates');
const confirmCore = require('./confirm-core');
const goliveCore = require('./golive-core'); // C6a：项目详情的 golive_progress（与 GET /plan 同源）
const notifyCore = require('./notify-core'); // C6b：PM 的项目视图带通知发送失败条数

const SYSTEM_NAME_MAX = 100;
const PHASE_NAME_MAX = 50;
const GOAL_MAX = 2000;
const REASON_MAX = 500;
// PATCH 可改的基本信息：build_type 建项后不可改（方案 v1.2 D44），所以不在这里；建项字段 = 基本信息 + build_type。
const BASIC_FIELDS = ['system_name', 'phase_name', 'goal', 'oa_number', 'initiated_on'];
const CREATE_FIELDS = ['system_name', 'phase_name', 'build_type', 'goal', 'oa_number', 'initiated_on'];

function operatorNameOf(user) {
  return (user && (user.display_name || user.username)) || ('user#' + (user && user.id));
}

function createProjectRoutes(ctx) {
  for (const k of ['db', 'logger']) {
    if (ctx[k] === undefined) throw new Error('routes/sysbuild/projects 缺参数: ' + k);
  }
  if (!(Array.isArray(ctx.readonlyIds) || ctx.readonlyIds instanceof Set)) {
    throw new Error('routes/sysbuild/projects 参数 readonlyIds 必须是数组或 Set');
  }
  // writeRoles：平台写接口允许的角色（server.js 的 WRITE_ALLOWED_ROLES）。建项与「可被指定为 PM」限这些角色（D1，排除 viewer）。
  if (!(Array.isArray(ctx.writeRoles) || ctx.writeRoles instanceof Set)) {
    throw new Error('routes/sysbuild/projects 参数 writeRoles 必须是数组或 Set');
  }
  const { db, logger } = ctx;
  const router = express.Router();
  const accessOpts = () => ({ readonlyIds: ctx.readonlyIds, writeRoles: ctx.writeRoles });

  // ── 统一错误出口（与 attachments.js 同款）──────────────────────────────────────────────
  function sendError(res, err) {
    if (res.headersSent) return;
    const isBiz = !!(err && typeof err.status === 'number' && typeof err.code === 'string' && err.code.startsWith('SYSBUILD_'));
    if (isBiz && err.status < 500) {
      const body = { code: err.code, message: err.message };
      if (err.field) body.field = err.field;
      return res.status(err.status).json(body);
    }
    const cause = err && (err.cause || err);
    logger.error(`[sysbuild] 项目接口内部错误: ${(cause && cause.message) || String(err)}`);
    if (isBiz) return res.status(err.status).json({ code: err.code, message: err.message });
    return res.status(500).json({ code: 'SYSBUILD_INTERNAL', message: '内部错误' });
  }
  const handle = (fn) => (req, res) => { Promise.resolve().then(() => fn(req, res)).catch((e) => sendError(res, e)); };
  const invalid = (message, field) => Object.assign(makeError(400, 'SYSBUILD_INVALID_INPUT', message), field ? { field } : {});
  const stateError = (message) => makeError(409, 'SYSBUILD_STATE', message);
  // 注意：真实站点里 server.js 的全局 JSON 解析（上限 50mb）先于本模块应答——非法 JSON 由它回 { error: '无效的JSON格式' } 400（没有 code），
  //   体积也由它放行；下面这个 16kb 解析器只在进程内夹具里（没有全局解析）起作用。逐字段长度上限由 readText 等在参数解析里卡死，不靠这个解析器（L2）。
  const parseJsonBody = (req, res, next) => express.json({ limit: '16kb' })(req, res, (err) => (
    err ? sendError(res, invalid('请求体不是合法的 JSON')) : next()
  ));
  // 请求体：没有请求体（undefined / null）按空对象；存在却不是普通对象（express.json 的 strict 模式仍会放行数组根值）→ 400（codex 17 号 L-1）。
  const bodyOf = (req) => {
    const b = req.body;
    if (b === undefined || b === null) return {};
    if (typeof b !== 'object' || Array.isArray(b)) throw invalid('请求体必须是 JSON 对象', 'body');
    return b;
  };

  // ── 参数解析（400）────────────────────────────────────────────────────────────────────
  const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // 文本：undefined / null / 空白 → null（必填则 400）；非字符串 400；trim 后按码点计长。
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
    if (rules.hasControlChar(v)) throw invalid(`${label}不能包含控制字符`, field); // 预筛 L1：NUL 等控制字符否则落到库内 CHECK 以 500 暴露
    if (Array.from(v).length > max) throw invalid(`${label}不能超过 ${max} 个字符`, field);
    return v;
  }
  function validDate(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (y < 2000 || y > 2099) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  }
  // 基本信息单列解析：返回规范化后的值（可空列无值返回 null）。
  function parseBasic(field, raw) {
    switch (field) {
      case 'system_name': return readText(raw, field, '系统名', SYSTEM_NAME_MAX, true);
      case 'phase_name': return readText(raw, field, '期次名', PHASE_NAME_MAX, false);
      case 'goal': return readText(raw, field, '建设目标', GOAL_MAX, false);
      case 'build_type': {
        if (typeof raw !== 'string' || !schema.ENUMS.buildType.includes(raw)) throw invalid(`建设方式必须是 ${schema.ENUMS.buildType.join(' / ')} 之一`, field);
        return raw;
      }
      case 'oa_number': {
        const v = readText(raw, field, 'OA 单号', 20, false);
        if (v !== null && !/^[0-9]{1,20}$/.test(v)) throw invalid('OA 单号必须是 1–20 位数字', field);
        return v;
      }
      case 'initiated_on': {
        const v = readText(raw, field, '立项日期', 10, false);
        if (v !== null && !validDate(v)) throw invalid('立项日期必须是 YYYY-MM-DD 格式的有效日期（2000–2099）', field);
        return v;
      }
      default: throw invalid(`不支持的字段 ${field}`, field);
    }
  }
  function readReason(body) {
    return readText(body.reason, 'reason', '原因', REASON_MAX, true);
  }
  function readUserId(raw, field, label, required) {
    if (raw === undefined || raw === null || raw === '') {
      if (required) throw invalid(`${label}必填`, field);
      return null;
    }
    const id = rules.parseId(raw);
    if (!id) throw invalid(`${label}不合法`, field);
    return id;
  }

  // ── 读库小助手 ──────────────────────────────────────────────────────────────────────────
  const PROJECT_COLS = 'p.id AS id, p.system_name AS system_name, p.phase_name AS phase_name, p.build_type AS build_type, p.goal AS goal, p.oa_number AS oa_number, p.initiated_on AS initiated_on, p.pm_user_id AS pm_user_id, p.status AS status, p.history_window AS history_window, p.created_by AS created_by, p.created_at AS created_at, p.updated_at AS updated_at, COALESCE(u.display_name, u.username) AS pm_name';
  const PROJECT_FROM = 'FROM sysbuild_projects p LEFT JOIN users u ON u.id = p.pm_user_id';
  async function loadProjectRow(q, pid) {
    return q.get(`SELECT ${PROJECT_COLS} ${PROJECT_FROM} WHERE p.id = ?`, [pid]);
  }
  // 本人身份卡（供前端显示「我是谁」；不含任何推算出来的按钮权限，按钮只看 actions）。
  function identityCard(identity) {
    const roles = [];
    if (identity.isAdmin) roles.push('admin');
    if (identity.isReadonly) roles.push('readonly');
    if (identity.isPm) roles.push('pm');
    if (identity.ownerOfParties.length) roles.push('owner');
    if (identity.delegateOfParties.length) roles.push('delegate');
    if (identity.isMember && !identity.isPm && !identity.ownerOfParties.length && !identity.delegateOfParties.length) roles.push('member');
    return {
      roles,
      is_admin: identity.isAdmin,
      is_readonly: identity.isReadonly,
      is_pm: identity.isPm,
      is_member: identity.isMember,
      member_id: identity.memberId,
      party_id: identity.partyId,
      owner_of_parties: identity.ownerOfParties,
      delegate_of_parties: identity.delegateOfParties,
      pending_invitation_count: identity.pendingInvitations.length,
    };
  }
  function viewOf(row) {
    return {
      id: row.id,
      system_name: row.system_name,
      phase_name: row.phase_name,
      build_type: row.build_type,
      goal: row.goal,
      oa_number: row.oa_number,
      initiated_on: row.initiated_on,
      pm_user_id: row.pm_user_id,
      pm_name: row.pm_name,
      status: row.status,
      history_window: row.history_window,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  // 写端点的响应体：写完后在同一事务里重读，actions 用操作人当前身份重算。
  async function projectResponse(q, pid, user) {
    const row = await loadProjectRow(q, pid);
    const identity = await rules.loadProjectIdentity(q, pid, user, accessOpts());
    return { project: viewOf(row), me: identityCard(identity), actions: rules.actionsFor(identity, row) };
  }

  // 候选 PM（建项时 admin 指定、更换 PM 时的新 PM）：须存在、账号 active、不是只读账号、角色在平台写入角色名单内（D1，排除 viewer）。
  //   其余规则（兼任、待接受成员行、属参与方等）在更换 PM 端点里经 rules.pmClash 判。
  async function assertEligiblePm(q, pmUserId) {
    const u = await q.get('SELECT id, status, role FROM users WHERE id = ?', [pmUserId]);
    if (!u || u.status !== 'active') throw invalid('指定的负责人不存在或账号不可用', 'pm_user_id');
    const plat = rules.platformIdentity({ id: pmUserId, role: u.role }, accessOpts());
    if (plat.isReadonly) throw invalid('只读账号不能担任项目 PM', 'pm_user_id');
    if (!plat.roleCanWrite) throw invalid('该账号的平台角色没有写入权限，不能担任项目 PM', 'pm_user_id');
    return u;
  }
  // PM 的成员行：没有「未移出」的行就新建一行（已加入、不挂参与方）并写 member_added；已有行则不动。返回是否新建。
  //   不再把「待接受」的成员行替本人置为已加入（预筛 M3 硬门）：更换 PM 前 pmClash 已挡住有待接受成员行 / 成员行属某参与方的候选人，
  //   所以走到这里要么没有未移出的行，要么是已加入且 party_id 为空的行。via：事件 payload 里的来源（更换 PM 传 'pm_change'，建项不传）。
  async function ensurePmMemberRow(q, pid, pmUserId, operator, via) {
    const row = await q.get(
      'SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1',
      [pid, pmUserId]
    );
    if (row) return false;
    const ins = await q.run(
      "INSERT INTO sysbuild_members (project_id, party_id, user_id, joined_at, added_by) VALUES (?, NULL, ?, datetime('now','localtime'), ?)",
      [pid, pmUserId, Number(operator.id)]
    );
    const payload = via ? { user_id: pmUserId, party_id: null, as: 'pm', via } : { user_id: pmUserId, party_id: null, as: 'pm' };
    await writeEvent(q, {
      projectId: pid, objectType: 'member', objectId: ins.lastID, eventType: 'member_added',
      payload, operatorId: Number(operator.id), operatorName: operatorNameOf(operator),
    });
    return true;
  }
  // 先可见性、再补齐其余身份字段（L6）：看不见的人（不存在 / 非成员）只付 loadProjectAccess 的查询就得到 404。
  async function loadVisibleIdentity(q, pid, user) {
    const access = await rules.loadProjectAccess(q, pid, user, accessOpts());
    rules.assertVisible(access);
    return rules.completeIdentity(q, access, user);
  }

  // ── POST /sysbuild/projects：建项 ─────────────────────────────────────────────────────
  // 参数先于角色检查（400 在前）；角色相关的参数规则（admin 必须指定 PM、非 admin 不能指定）放在角色检查之后。
  //   只读账号 403；非 admin 传 pm_user_id 403（只有 admin 可以指定负责人）；admin 不传 pm_user_id 400；
  //   候选 PM 不存在 / 账号不可用 / 是只读账号 / 平台角色不在写入名单内 → 400（指定的参数不合格）。
  //   建项人自己的平台角色不在写入名单内（viewer）→ 403（D1：建项与「可被指定为 PM」都限 WRITE_ALLOWED_ROLES）。
  router.post('/sysbuild/projects', parseJsonBody, handle(async (req, res) => {
    const body = bodyOf(req);
    const values = {};
    for (const f of CREATE_FIELDS) values[f] = parseBasic(f, body[f]);
    const pmRaw = hasKey(body, 'pm_user_id') ? readUserId(body.pm_user_id, 'pm_user_id', '项目负责人', false) : null;
    const user = req.user;
    const uid = Number(user.id);
    const platform = rules.platformIdentity(user, accessOpts());
    if (!rules.canCreateProject(platform)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');
    if (!platform.isAdmin && pmRaw !== null) throw makeError(403, 'SYSBUILD_FORBIDDEN', '只有 admin 可以指定项目负责人');
    if (platform.isAdmin && pmRaw === null) throw invalid('admin 代建项目必须指定项目负责人（pm_user_id）', 'pm_user_id');
    const pmId = platform.isAdmin ? pmRaw : uid;
    const out = await db.withWriteTxn(async (q) => {
      if (platform.isAdmin) await assertEligiblePm(q, pmId);
      const ins = await q.run(
        'INSERT INTO sysbuild_projects (system_name, phase_name, build_type, goal, oa_number, initiated_on, pm_user_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [values.system_name, values.phase_name, values.build_type, values.goal, values.oa_number, values.initiated_on, pmId, uid]
      );
      const pid = ins.lastID;
      await ensurePmMemberRow(q, pid, pmId, user);
      await writeEvent(q, {
        projectId: pid, objectType: 'project', objectId: pid, eventType: 'project_created',
        payload: Object.assign({}, values, { pm_user_id: pmId }), operatorId: uid, operatorName: operatorNameOf(user),
      });
      // C3a：同一事务带出默认批次与节点（方案 v1.2 §2.3 / §3）；任何一步失败整个建项回滚。
      await seedProjectStructure(q, { projectId: pid, buildType: values.build_type, operatorId: uid, operatorName: operatorNameOf(user) });
      return projectResponse(q, pid, user);
    });
    res.status(201).json(out);
  }));

  // ── GET /sysbuild/projects?scope=mine|all ─────────────────────────────────────────────
  router.get('/sysbuild/projects', handle(async (req, res) => {
    const scope = req.query.scope === undefined ? 'mine' : req.query.scope;
    if (scope !== 'mine' && scope !== 'all') throw invalid('scope 必须是 mine 或 all', 'scope');
    const user = req.user;
    const uid = Number(user.id);
    const platform = rules.platformIdentity(user, accessOpts());
    if (scope === 'all' && !rules.canListAll(platform)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');
    const items = await db.withRead(async (q) => {
      const rows = scope === 'all'
        ? await q.all(`SELECT ${PROJECT_COLS} ${PROJECT_FROM} ORDER BY p.id DESC`, [])
        : await q.all(
          `SELECT ${PROJECT_COLS} ${PROJECT_FROM}
            WHERE p.pm_user_id = ? OR EXISTS (SELECT 1 FROM sysbuild_members m WHERE m.project_id = p.id AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL})
            ORDER BY p.id DESC`,
          [uid, uid]
        );
      const out = [];
      for (const row of rows) {
        const identity = await rules.loadProjectIdentity(q, row.id, user, accessOpts());
        out.push(Object.assign(viewOf(row), { me: identityCard(identity), actions: rules.actionsFor(identity, row) }));
      }
      return out;
    });
    // C7：空列表时也能决定入口；与真实建项 / 全部项目权限共用判定，前端不复制平台只读名单。
    res.json({ scope, projects: items, actions: {
      create: rules.canCreateProject(platform),
      list_all: rules.canListAll(platform),
      create_pm_required: platform.isAdmin === true,
    } });
  }));

  // C7 时间线框架：只返回事件事实元数据，不返回任意 payload。
  //   附件原名、渠道响应等不经这个通用入口暴露；业务正文从相应的受权详情接口读取。
  router.get('/sysbuild/projects/:id/events', handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const query = req.query || {};
    const before = query.before === undefined ? null : rules.parseId(query.before);
    const limit = query.limit === undefined ? 50 : rules.parseId(query.limit);
    if (query.before !== undefined && before === null) throw invalid('分页游标不合法', 'before');
    if (!limit || limit > 100) throw invalid('每页条数须为 1–100', 'limit');
    const out = await db.withRead(async (q) => {
      // 复用详情的当前可见对象集合：时间线不能成为未接受 / 拒绝 / 撤回意图的读取旁路。
      const detail = await projectDetailView(q, pid, req.user);
      const visibleMembers = new Set(detail.members.map((m) => m.id));
      const visibleAppointments = new Set(detail.appointments.map((a) => a.id));
      const visibleDelegations = new Set(detail.delegations.map((d) => d.id));
      const visibilityCache = Object.create(null);
      async function visibleMembershipObject(type, id) {
        if (type === 'member') return visibleMembers.has(id);
        if (type === 'appointment') return visibleAppointments.has(id);
        if (type === 'delegation') return visibleDelegations.has(id);
        if (type !== 'invitation') return false;
        const invitation = await q.get('SELECT kind, member_id, appointment_id FROM sysbuild_invitations WHERE id = ? AND project_id = ?', [id, pid]);
        if (!invitation) return false;
        return invitation.kind === 'join' ? visibleMembers.has(invitation.member_id) : invitation.kind === 'appointment' && visibleAppointments.has(invitation.appointment_id);
      }
      async function visibleTimelineEvent(event) {
        const key = event.object_type + ':' + event.object_id;
        if (hasKey(visibilityCache, key)) return visibilityCache[key];
        let visible;
        if (['member', 'appointment', 'delegation', 'invitation'].includes(event.object_type)) {
          visible = await visibleMembershipObject(event.object_type, event.object_id);
        } else if (event.object_type === 'confirm_task' || event.object_type === 'confirm_revision') {
          const task = event.object_type === 'confirm_task'
            ? await q.get('SELECT object_type, object_id FROM sysbuild_confirm_tasks WHERE id = ? AND project_id = ?', [event.object_id, pid])
            : await q.get('SELECT t.object_type AS object_type, t.object_id AS object_id FROM sysbuild_confirm_task_revisions r JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE r.id = ? AND t.project_id = ?', [event.object_id, pid]);
          visible = !!task && (task.object_type === 'invitation' || task.object_type === 'delegation'
            ? await visibleMembershipObject(task.object_type, task.object_id)
            : ['package_version', 'item_version', 'dev_entry', 'conclusion', 'adjudication', 'handover'].includes(task.object_type));
        } else visible = true;
        visibilityCache[key] = visible;
        return visible;
      }
      const visibleRows = [];
      let candidateBefore = before;
      for (;;) {
        const rows = await q.all(
          `SELECT id, project_id, object_type, object_id, event_type, operator_id, operator_name, created_at
           FROM sysbuild_events WHERE project_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
          [pid, candidateBefore, candidateBefore, 100]
        );
        for (const event of rows) {
          if (await visibleTimelineEvent(event)) visibleRows.push(event);
          if (visibleRows.length > limit) break;
        }
        if (visibleRows.length > limit || rows.length < 100) break;
        candidateBefore = rows[rows.length - 1].id;
      }
      const hasMore = visibleRows.length > limit;
      const items = visibleRows.slice(0, limit);
      return { project_id: pid, items, next_before: hasMore && items.length ? items[items.length - 1].id : null };
    });
    res.json(out);
  }));

  // ── GET /sysbuild/projects/:id：详情 ──────────────────────────────────────────────────
  async function projectDetailView(q, pid, user) {
      const identity = await loadVisibleIdentity(q, pid, user);
      const row = await loadProjectRow(q, pid);
      const manager = identity.isPm || identity.isAdmin;
      const parties = await q.all('SELECT id, side, name, sort_order FROM sysbuild_parties WHERE project_id = ? ORDER BY sort_order, id', [pid]);
      const owners = await q.all(
        `SELECT a.party_id AS party_id, a.member_id AS member_id, a.effective_at AS effective_at, COALESCE(u.display_name, u.username, m.person_name) AS name
           FROM sysbuild_appointments a JOIN sysbuild_members m ON m.id = a.member_id JOIN sysbuild_parties p ON p.id = a.party_id LEFT JOIN users u ON u.id = m.user_id
          WHERE a.status = 'active' AND p.project_id = ? AND ${rules.MEMBER_ACTIVE_SQL}`,
        [pid]
      );
      const delegates = await q.all(
        `SELECT d.party_id AS party_id, d.member_id AS member_id, d.effective_at AS effective_at, COALESCE(u.display_name, u.username, m.person_name) AS name
           FROM sysbuild_delegations d JOIN sysbuild_members m ON m.id = d.member_id JOIN sysbuild_parties p ON p.id = d.party_id LEFT JOIN users u ON u.id = m.user_id
          WHERE d.status = 'active' AND p.project_id = ? AND ${rules.MEMBER_ACTIVE_SQL}`,
        [pid]
      );
      const memberRows = await q.all(
        `SELECT m.id AS id, m.party_id AS party_id, m.user_id AS user_id, COALESCE(u.display_name, u.username, m.person_name) AS name,
                m.joined_at AS joined_at, m.removed_at AS removed_at, m.removed_reason AS removed_reason
           FROM sysbuild_members m LEFT JOIN users u ON u.id = m.user_id WHERE m.project_id = ? ORDER BY m.id`,
        [pid]
      );
      const members = [];
      for (const m of memberRows) {
        const status = m.removed_at !== null ? 'removed' : (m.joined_at === null ? 'pending' : 'joined');
        // 普通成员（含只读账号）一律排除待接受与已移出（08a M-2、08b M-6）；PM 与 admin 为管理需要全部可见。
        if (!visibility.memberVisible(identity, m)) continue;
        const item = { id: m.id, party_id: m.party_id, user_id: m.user_id, name: m.name, status, joined_at: m.joined_at };
        if (manager) { item.removed_at = m.removed_at; item.removed_reason = m.removed_reason; }
        members.push(item);
      }
      const ownerOf = (partyId) => owners.find((o) => o.party_id === partyId) || null;
      const delegateOf = (partyId) => delegates.find((d) => d.party_id === partyId) || null;
      const partyItems = parties.map((p) => {
        const o = ownerOf(p.id);
        const d = delegateOf(p.id);
        return {
          id: p.id, side: p.side, name: p.name, sort_order: p.sort_order,
          owner: o ? { member_id: o.member_id, name: o.name, effective_at: o.effective_at } : null,
          delegate: d ? { member_id: d.member_id, name: d.name, effective_at: d.effective_at } : null,
        };
      });
      // C2b：参与方 / 成员补逐对象 actions；任职与授权列表（按本人可见范围）。判定与写端点同源（rules.OBJECT_OPS）。
      const objs = await membership.decorateDetail(q, identity, row, partyItems, members, ctx.readonlyIds);
      // 预筛 LOW-5：部分上线进度（已正式上线 n / 有效批次 m，转出单列）与 GET /plan 的 project.golive_progress 同一个函数
      const golive_progress = await goliveCore.goliveProgressOf(q, pid);
      const detail = { project: Object.assign(viewOf(row), { golive_progress }), parties: partyItems, members, appointments: objs.appointments, delegations: objs.delegations, me: identityCard(identity), actions: rules.actionsFor(identity, row) };
      // C6b（§9.2）：PM 的项目视图显示「通知发送失败 N 条」，供点补发（POST …/send-intents/resend）；只给本人是 PM 的详情，其他人不带这个字段
      if (identity.isPm === true) detail.notify = { send_failed: await notifyCore.failedIntentCount(q, pid), needs_offline: await notifyCore.needsOfflineCount(q, pid) }; // 修订批 2（P184）：补发能处理的失败 / 须线下通知的（无账号负责人的改期知会）拆成两个数
      return detail;
  }
  router.get('/sysbuild/projects/:id', handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const out = await db.withRead((q) => projectDetailView(q, pid, req.user));
    res.json(out);
  }));

  // ── PATCH /sysbuild/projects/:id：改基本信息五列 ──────────────────────────────────────
  // 只收五个基本信息字段（出现 build_type / pm_user_id / status / history_window 等别的键 → 400；build_type 建项后不可改，方案 v1.2 D44）；
  // 至少给一个；可空列传 null 表示清空。
  router.patch('/sysbuild/projects/:id', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const body = bodyOf(req);
    for (const k of Object.keys(body)) {
      if (!BASIC_FIELDS.includes(k)) throw invalid(`不能通过本接口修改 ${k}`, k);
    }
    const given = BASIC_FIELDS.filter((f) => hasKey(body, f));
    if (given.length === 0) throw invalid('至少修改一个基本信息字段', 'body');
    const next = {};
    for (const f of given) next[f] = parseBasic(f, body[f]);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const identity = await loadVisibleIdentity(q, pid, user);
      rules.assertCan(identity, rules.canEditProjectBasics, { writeKind: 'basics' });
      const cur = await loadProjectRow(q, pid);
      const before = {};
      const after = {};
      for (const f of given) {
        if (cur[f] !== next[f]) { before[f] = cur[f]; after[f] = next[f]; }
      }
      const changed = Object.keys(after);
      if (changed.length > 0) {
        const merged = {};
        for (const f of BASIC_FIELDS) merged[f] = hasKey(after, f) ? after[f] : cur[f];
        const r = await q.run(
          "UPDATE sysbuild_projects SET system_name = ?, phase_name = ?, goal = ?, oa_number = ?, initiated_on = ?, updated_at = datetime('now','localtime') WHERE id = ?",
          [merged.system_name, merged.phase_name, merged.goal, merged.oa_number, merged.initiated_on, pid]
        );
        if (r.changes === 0) throw stateError('项目状态已变化，请刷新后重试');
        await writeEvent(q, {
          projectId: pid, objectType: 'project', objectId: pid, eventType: 'project_updated',
          payload: { before, after }, operatorId: uid, operatorName: operatorNameOf(user),
        });
      }
      return Object.assign(await projectResponse(q, pid, user), { changed });
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/status：暂停 / 恢复 / 终止 / 重开 ─────────────────────
  // admin；{ to, reason }；转移表见 rules.STATUS_TRANSITIONS；closed 只由整体结项（p_closing 收口，plan.js，C6a）产生，这里转入 closed 一律 409；closed → active（重开）同事务把 p_closing 退回进行中。
  router.post('/sysbuild/projects/:id/status', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const body = bodyOf(req);
    const to = body.to;
    if (typeof to !== 'string' || !schema.ENUMS.projectStatus.includes(to)) throw invalid(`to 必须是 ${schema.ENUMS.projectStatus.join(' / ')} 之一`, 'to');
    const reason = readReason(body);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const identity = await loadVisibleIdentity(q, pid, user);
      rules.assertCan(identity, rules.canChangeProjectStatus);
      const from = identity.project.status;
      if (to === 'closed') throw stateError('结项只能由整体结项产生，不能通过状态转移进入');
      if (!(rules.STATUS_TRANSITIONS[from] || []).includes(to)) throw stateError(`项目当前状态不能转为 ${to}`);
      const r = await q.run("UPDATE sysbuild_projects SET status = ?, updated_at = datetime('now','localtime') WHERE id = ? AND status = ?", [to, pid, from]);
      if (r.changes === 0) throw stateError('项目状态已变化，请刷新后重试');
      await writeEvent(q, {
        projectId: pid, objectType: 'project', objectId: pid, eventType: 'project_status_changed',
        payload: { from, to, reason }, operatorId: uid, operatorName: operatorNameOf(user),
      });
      // C4a P38：转入已终止的同一事务里，本项目全部待确认的任务修订置为已失效（原因「项目已终止」）；重开后由 PM 对内容包任务改发（reissue 允许已失效的修订）。
      //   C2 代码按 C4a 修订批派单改动。
      if (to === 'terminated') await confirmCore.invalidatePendingRevisionsOfProject(q, user, pid, confirmCore.PROJECT_TERMINATED_REASON);
      // C6a（主会话裁定 P142）：已结项项目重开（closed → active，admin）的同一事务里，整体验收结项节点 p_closing 由已收口退回进行中（写节点事件），之后可以再收口 = 再结项。
      //   其余「已结项」派生随项目状态现取，重开后自然恢复：登记时段判定读项目当前状态（entries-core.decideEntryPeriod：项目整体登记在已结项时是补充登记、重开后是过程登记；已写入的登记时段在登记时固化，不改写）、
      //   状态 × 动作表按当前状态查。
      if (from === 'closed' && to === 'active') {
        // 预筛 LOW-3：已结项项目的 p_closing 必须是已收口（结项只经 p_closing 收口产生）；不是（或没有该节点）= 数据不一致，报 500，不静默跳过让项目带着进行中的结项节点重开。
        const closing = await q.get("SELECT id, status FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS NULL AND template_key = 'p_closing'", [pid]);
        if (!closing || closing.status !== 'closed') throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：已结项项目的整体验收结项节点不是已收口，数据不一致');
        const nr = await q.run("UPDATE sysbuild_nodes SET status = 'in_progress', closed_at = NULL, updated_at = datetime('now','localtime') WHERE id = ? AND status = 'closed'", [closing.id]);
        if (nr.changes === 0) throw stateError('节点状态已变化，请刷新后重试');
        await writeEvent(q, {
          projectId: pid, objectType: 'node', objectId: closing.id, eventType: 'node_reopened',
          payload: { reason, via: 'project_reopen' }, operatorId: uid, operatorName: operatorNameOf(user),
        });
      }
      return projectResponse(q, pid, user);
    });
    res.json(out);
  }));

  // ── POST /sysbuild/projects/:id/pm：更换 PM / 接管 ───────────────────────────────────
  // admin；{ pm_user_id, reason }。接管 = admin 把自己设为 PM（同一端点）。任何项目状态都可做（D2 显式例外，理由见 rules.js 表注释）。
  //   新 PM 须 active、非只读、平台角色在写入名单内（否则 400）；候选人在本项目的身份由 rules.pmClash 判，挡住一律 409（SYSBUILD_STATE）：
  //   某一方的现任负责人 / 生效代表人 / 有待处理的任职或授权提议（PM 不得兼任，§5.1）、有待接受的成员行（M3 硬门：不替本人置为已加入）、
  //   已加入的成员行属某参与方（D5）。没有未移出的成员行时新建一行（party_id 为空）并写 member_added（via 'pm_change'）。
  router.post('/sysbuild/projects/:id/pm', parseJsonBody, handle(async (req, res) => {
    const pid = rules.parseId(req.params.id);
    if (!pid) throw invalid('项目编号不合法', 'id');
    const body = bodyOf(req);
    const newPm = readUserId(body.pm_user_id, 'pm_user_id', '新项目负责人', true);
    const reason = readReason(body);
    const user = req.user;
    const uid = Number(user.id);
    const out = await db.withWriteTxn(async (q) => {
      const identity = await loadVisibleIdentity(q, pid, user);
      rules.assertCan(identity, rules.canChangePm);
      const oldPm = identity.project.pm_user_id;
      if (newPm === oldPm) throw stateError('该用户已是本项目 PM');
      await assertEligiblePm(q, newPm);
      // 候选人在本项目的身份挡不挡担任 PM：与 actions.takeover 同一个判定（rules.pmClash），目标用户是候选人而不是操作人。
      const target = await rules.loadProjectIdentity(q, pid, { id: newPm, role: 'user' }, accessOpts());
      const block = rules.pmClash(target);
      if (block) throw stateError(block.message);
      const r = await q.run("UPDATE sysbuild_projects SET pm_user_id = ?, updated_at = datetime('now','localtime') WHERE id = ? AND pm_user_id = ?", [newPm, pid, oldPm]);
      if (r.changes === 0) throw stateError('项目负责人已变化，请刷新后重试');
      await ensurePmMemberRow(q, pid, newPm, user, 'pm_change');
      // C2b（M1 ③）：同事务撤回原 PM 发出的待处理邀请及关联的待接受成员行 / 任职提议——邀请人失权即失效，不留惰性悬挂（admin 发出的不受影响）。
      await membership.withdrawInvitationsOfInviter(q, user, pid, oldPm, ctx.readonlyIds);
      await writeEvent(q, {
        projectId: pid, objectType: 'project', objectId: pid, eventType: 'project_pm_changed',
        payload: { from: oldPm, to: newPm, reason, takeover: newPm === uid }, operatorId: uid, operatorName: operatorNameOf(user),
      });
      return projectResponse(q, pid, user);
    });
    res.json(out);
  }));

  return { router };
}

module.exports = { createProjectRoutes };
