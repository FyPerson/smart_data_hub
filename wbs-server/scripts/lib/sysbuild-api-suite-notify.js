// 验证脚本库：项目管理（系统建设记录）模块 C6b——发送意图（触发点 × 收件人）、事务外发送与结果回写、补发与就绪扫描、防重、待办七类、改期知会与知会异议（#113 段 8 C6b）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §4.4（:748）、§6.2（:930 / :939 / :956–958）、§7（:992 / :996）、§9.1、§9.2（:1033–1040）、§12（:1157）
//   派单：docs/local/系统建设记录/送审准备/C6_C6b_通知待办改期知会_派单_20261107.md（§6 测试清单与本文件的 T_* 常量逐项对应）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检；方案 §12 写的独立脚本 verify-sysbuild-notify.js 改为 api 套件内新套件，P160）。期望值一律手写，不取自被测代码。
// 两种跑法：
//   · 进程内夹具（kit 非空）：钉钉与配置读取用本文件的替身（makeDingDouble：记录每次调用、可配置失败 / 延迟 / 异常），发送内容（标题 / 正文 / 链接）逐字核对；写请求之后夹具自动等发送完成（notifier.whenIdle，信号不是 sleep）；
//   · 真实实例（kit 为空）：外发走平台钉钉替身（SDH_EXTERNAL=stub，日志 <数据根>/external-calls.jsonl，只记正文长度不记正文），只核「发出去了」与意图 / 事件留痕；只能在进程内造的用例返回 SKIP。
// 夹具规则：建项、成员、任职、授权、内容包、确认、登记、改期全部走生产端点。只有这几类直接写库：① 需求方参与方 / 成员 / 任职 / 授权（H.seedParty 等）；② 发送意图夹具行
//   （造「提交后、发送前进程退出」的旧 pending、失败行、已发行，以及指向固定修订的意图）；③ 时间校准：修订 / 意图 created_at 回拨（超期 3 天、补发 5 分钟）；④ 用户的钉钉号 / 手机号（走「无钉钉号」「按手机号反查」分支）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const P = 'C6b 通知：';
const T_TRIG = `${P}触发点与收件人`;
const T_LEADER = 'B3.1 领导知悉按同一提交重核';
const T_LEADER_TEXT = 'B3.2 验收与结项领导知悉全文';
const T_LEADER_DISABLED = 'B3.2 领导知悉停用恢复补发';
const T_LEADER_REMOVED = 'B3.2 领导知悉移出项目永久跳过';
const T_LEADER_CHANNELS = 'B3.2 领导知悉终止后的补发与就绪扫描';
const T_DEVMSG = `${P}开发方负责人收确认通知走摘要文案`; // #212 C6：接替整删的 T_SELF 用例（M1822 改挂）
const T_C6_R7 = 'C6 R7：知会与待办不再有异议与 notice 类';
const T_ROLLBACK = `${P}事务回滚不留发送意图`;
const T_SEND = `${P}事务外发送与结果回写`;
const T_DEDUP = `${P}防重`;
const T_RESEND = `${P}补发端点`;
const T_SCAN = `${P}模块就绪扫描`;
const T_TODO = `${P}待办七类`;
const T_SCHED = `${P}改期知会生成`;
const T_STUB = `${P}实例模式钉钉替身日志`;
const T_FIX = `${P}残余修订`;
const T_STALE = `${P}发送前复核收件人资格`; // 修订批 1（K1）
const T_NOPM = `${P}决策人就是 PM 不通知自己`; // 修订批 1（L6）
const T_SCANBATCH = `${P}扫描分批处理积压`; // 修订批 2（M1）
const T_RESENDCAP = `${P}补发剩余条数按总数算`; // 修订批 2（M3）
const T_TRAIL = `${P}令牌重试两次渠道结果留痕`; // 修订批 2（M4）
const T_IDLE = `${P}whenIdle 跟踪直接调用`; // 修订批 2（L1）
const T_SYSTEMIC = `${P}限流 / 无权限 / 机器人编码无效中止补发`; // 修订批 2（LOW-b）
const T_DISABLED = `${P}停用账号记失败可重试`; // 修订批 2（P186）
const T_DISCOMBO = `${P}停用账号叠加永久失格仍跳过`; // 修订批 3（预筛 MED-B）
const T_RECHECK = `${P}外发前一刻重新复核资格`; // 修订批 3（codex N3）
const T_JUDGE = `${P}渠道响应统一判定与逐次留痕`; // 修订批 3（codex N2）
const T_NOSTARVE = `${P}补发候选不饿死`; // 修订批 3（codex N1）
const T_SCANABORT = `${P}扫描遇系统性失败中止本轮`; // 修订批 3（预筛 LOW-1）
const T_ADDR = `${P}外发前重核最新账号与钉钉地址`; // 修订批 4（codex 28-R2 O1）
const T_SCHEDDIS = `${P}改期知会不因负责人账号停用而漏建`; // 修订批 4（codex 28-R2 O2）
const T_THROWSYS = `${P}抛异常分支的系统性判定统一`; // 修订批 4（codex 28-R2 O3）

const BASE_URL = 'http://sdh-test.invalid';
const SECRETS = ['AK-SECRET-0001', 'AS-SECRET-0002', 'RC-SECRET-0003', 'TOKEN-SECRET-0004'];
const FLOOR_PAST = '2020-01-01 00:00:00';

// ── 进程内夹具的钉钉 / 配置替身（sysbuild-api-suite.js 的 makeInprocHarness 注入）────────────────────────────────────────────
//   api 与 utils/dingtalk-notify.js 同形（getAccessToken / getUserIdByMobile / sendMarkdownToUser / classifyError / clearCachedToken / escapeMarkdown），classifyError 与 escapeMarkdown 直接用真实实现；
//   state：config（getSystemConfig 的返回）、tokenError、sendMode（ok / errcode / throw / invalid_list / flow_list / filtered_list / no_key / token_expired_once）、mobileMap、gate（sendMarkdownToUser 等它）。
function makeDingDouble() {
  // eslint-disable-next-line global-require
  const real = require('../../utils/dingtalk-notify');
  const defaults = () => ({
    config: { dingtalk_app_key: SECRETS[0], dingtalk_app_secret: SECRETS[1], dingtalk_robot_code: SECRETS[2], platform_base_url: BASE_URL },
    configError: null, tokenError: null, sendMode: 'ok', sendErrcode: 88002, thrown: null, mobileMap: {}, mobileError: null, gate: null, expiredServed: false,
    tokenHook: null, mobileHook: null, // 修订批 3（N3）：取令牌 / 手机号反查期间让用例改库（async (第几次调用) => …），造「外发前一刻收件人资格变化」
  });
  const state = defaults();
  const calls = [];
  const api = {
    async getAccessToken(appKey) {
      calls.push({ api: 'getAccessToken', appKey });
      if (state.tokenHook) await state.tokenHook(calls.filter((c) => c.api === 'getAccessToken').length);
      if (state.tokenError) throw state.tokenError;
      return SECRETS[3];
    },
    async getUserIdByMobile(token, phone) {
      calls.push({ api: 'getUserIdByMobile', phone });
      if (state.mobileHook) await state.mobileHook(calls.filter((c) => c.api === 'getUserIdByMobile').length);
      if (state.mobileError) throw state.mobileError;
      if (!Object.prototype.hasOwnProperty.call(state.mobileMap, phone)) throw Object.assign(new Error('get_by_mobile failed: errcode=60121 errmsg=not found'), { errcode: 60121, errmsg: 'not found' });
      return state.mobileMap[phone];
    },
    async sendMarkdownToUser(token, robotCode, userIds, title, markdown) {
      calls.push({ api: 'sendMarkdownToUser', token, robotCode, userIds: userIds.slice(), title, markdown });
      if (state.gate) await state.gate;
      const id = String(userIds[0]);
      const okBody = { errcode: 0, flowControlledStaffIdList: [], invalidStaffIdList: [], filteredStaffIdList: [], processQueryKey: 'pqk-test' };
      switch (state.sendMode) {
        case 'throw': throw state.thrown || new Error('fetch failed');
        case 'errcode': return { errcode: state.sendErrcode, errmsg: 'send refused' };
        case 'invalid_list': return Object.assign({}, okBody, { invalidStaffIdList: [id] });
        case 'flow_list': return Object.assign({}, okBody, { flowControlledStaffIdList: [id] });
        case 'filtered_list': return Object.assign({}, okBody, { filteredStaffIdList: [id] });
        case 'no_key': return { errcode: 0, flowControlledStaffIdList: [], invalidStaffIdList: [], filteredStaffIdList: [] };
        case 'empty': return null; // 空响应（修订批 3 N2）
        case 'token_expired_once':
          if (!state.expiredServed) { state.expiredServed = true; return { errcode: 42001, errmsg: 'token expired' }; }
          return okBody;
        case 'token_expired_refresh_fail': // 令牌失效后刷新令牌失败（修订批 2 M4）：第一次发送返回 42001，同时让之后的 getAccessToken 报错
          if (!state.expiredServed) {
            state.expiredServed = true;
            state.tokenError = Object.assign(new Error('gettoken failed: errcode=40001 errmsg=bad'), { errcode: 40001, errmsg: 'bad' });
            return { errcode: 42001, errmsg: 'token expired' };
          }
          return okBody;
        case 'token_expired_then_filtered': // 第一次 42001，令牌刷新后的重发被钉钉规则过滤（修订批 3 N2：重发的软失败也要如实留痕）
          if (!state.expiredServed) { state.expiredServed = true; return { errcode: 42001, errmsg: 'token expired' }; }
          return Object.assign({}, okBody, { filteredStaffIdList: [id] });
        case 'token_expired_then_throw': // 第一次 42001，令牌刷新后的重发抛异常（修订批 4 O3：thrown 为 rate_limit / no_scope 类也要判系统性）
          if (!state.expiredServed) { state.expiredServed = true; return { errcode: 42001, errmsg: 'token expired' }; }
          throw state.thrown || new Error('fetch failed');
        case 'token_expired_refresh_throw': // 第一次 42001，随后刷新令牌抛 thrown（修订批 4 O3）
          if (!state.expiredServed) {
            state.expiredServed = true;
            state.tokenError = state.thrown || new Error('fetch failed');
            return { errcode: 42001, errmsg: 'token expired' };
          }
          return okBody;
        case 'robot_invalid': // 新版 batchSend 的机器人编码无效：没有 errcode，只有 code / message（修订批 2 LOW-b）
          return { code: 'InvalidParameter.robotCode', message: 'robotCode is invalid' };
        default: return okBody;
      }
    },
    classifyError: (x) => real.classifyError(x),
    escapeMarkdown: (s) => real.escapeMarkdown(s),
    clearCachedToken() { calls.push({ api: 'clearCachedToken' }); },
  };
  const getSystemConfig = async (key) => {
    if (state.configError) throw state.configError;
    return Object.prototype.hasOwnProperty.call(state.config, key) ? state.config[key] : null;
  };
  return {
    api, getSystemConfig, state, calls,
    reset() { Object.assign(state, defaults()); calls.length = 0; },
    sends() { return calls.filter((c) => c.api === 'sendMarkdownToUser'); },
  };
}

function defineNotifyCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, SKIP, confirm: H } = T;
  const { newProject, seedParty, produceEffectiveOverall, produceEffectiveInitiation, seedEffectiveInitiation, mkPackage, mkVersion, mkPreparedVersion, declareInitiationBasis, planAllNodes, tasksOf, openAndDecide } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const kitOrNull = () => (T.getKit ? T.getKit() : null);

  // ── 助手 ───────────────────────────────────────────────────────────────────────────────────
  const lastId = async (pid) => (await sqlGet('SELECT COALESCE(MAX(id), 0) AS n FROM sysbuild_send_intents WHERE project_id = ?', [pid])).n;
  const intentsAfter = (pid, afterId) => sqlAll('SELECT id, purpose, ref_type, ref_id, recipient_user_id, channel, status, attempts, last_error, created_at FROM sysbuild_send_intents WHERE project_id = ? AND id > ? ORDER BY id', [pid, afterId || 0]);
  const brief = (rows) => rows.map((r) => [r.purpose, r.ref_type, r.recipient_user_id]);
  const intentRow = (id) => sqlGet('SELECT * FROM sysbuild_send_intents WHERE id = ?', [id]);
  const sysName = async (pid) => (await sqlGet('SELECT system_name FROM sysbuild_projects WHERE id = ?', [pid])).system_name;
  async function mkScene(o) {
    const opt = o || {};
    const pid = await newProject();
    const A = await seedParty(pid, '甲部', U.own, U.del);
    const mM1 = await addMember(pid, U.m1, { party: A.party });
    const B = opt.partyB ? await seedParty(pid, '乙部', U.x1, U.x2) : null;
    return { pid, A, B, mM1 };
  }
  async function changeRepresentative(s, userId) {
    const updated = await api(U.pm, 'PUT', `/sysbuild/parties/${s.A.party}/people`, {
      leader_user_id: U.own, representative_user_id: userId,
      expected_appointment_id: s.A.apt, expected_delegation_id: s.A.dlg, reason: '项目人员调整',
    });
    assert.strictEqual(updated.status, 200, updated.text);
  }
  // 提交一个立项包（不确认）：返回 { pk, pv, tasks }（tasks 按任务编号：负责人在前）
  async function submitInitiation(pid, packageId) {
    const pk = packageId || await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    // L2 fixture：本助手只准备成功的待确认立项包，显式满足新立项门，不改通用 submit 请求。
    await declareInitiationBasis(pv);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    return { pk, pv, tasks: await tasksOf(pv) };
  }
  // 从真实入口取得负责人范围任务。需同时核领导的待确认消息时，再提交一版独立立项。
  async function submitOverall(pid, { includeInitiationTask = true } = {}) {
    const initiation = await seedEffectiveInitiation(pid);
    const ownerTasks = includeInitiationTask ? (await submitInitiation(pid, initiation.pk)).tasks : [];
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkPreparedVersion(pk);
    await planAllNodes(pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    const own = ownerTasks.find((t) => t.user_id === U.own);
    const del = tasks.find((t) => t.user_id === U.del);
    assert.ok(del && (!includeInitiationTask || own), '前置：负责人有范围任务，需要时领导有独立的立项任务');
    return { pk, pv, tasks, ridOwn: own?.rev_id, ridDel: del.rev_id, tidOwn: own?.task_id, tidDel: del.task_id };
  }
  const memberIdOf = async (pid, uid) => (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1', [pid, uid])).id;
  const todayStr = () => (T.getFixedToday && T.getFixedToday()) || (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
  // 直接写一条发送意图夹具行（status 默认 pending；createdAt 默认此刻，旧值用来造「提交后、发送前进程退出」）
  async function fixIntent(pid, uid, refId, o) {
    const x = o || {};
    const r = await sqlRun(
      'INSERT INTO sysbuild_send_intents (project_id, purpose, ref_type, ref_id, recipient_user_id, channel, status, attempts, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime(\'now\',\'localtime\')))',
      [pid, x.purpose || 'confirm_request', x.refType || 'confirm_revision', refId, uid, 'dingtalk', x.status || 'pending', x.attempts || 0, x.lastError === undefined ? null : x.lastError, x.createdAt === undefined ? null : x.createdAt]
    );
    return r.lastID;
  }
  const setUser = (uid, ding, phone) => sqlRun('UPDATE users SET dingtalk_user_id = ?, phone = ? WHERE id = ?', [ding, phone, uid]);

  // ═══════════════════════ 1 触发点 × 收件人（§2 / 事实表 B §I）═══════════════════════
  test(`${T_TRIG}——确认任务修订生成（立项包 / 总体规划包首修订）→ 必需确认人；改发 → 新修订的必需确认人；有异议 / 不认可 → 项目 PM（确认不通知）；每条意图 pending 起步、引用修订编号、渠道钉钉，发完不再 pending`, async () => {
    const kit = kitOrNull();
    if (kit) kit.ding.reset();
    const s = await mkScene({ partyB: true });
    const { pid } = s;
    let mark = await lastId(pid);
    // ① 立项包：每个需求部门现任负责人各一条（own、x1），引用各自首修订；确认（confirm）不产生通知
    const ini = await produceEffectiveInitiation(pid);
    const iniTasks = await tasksOf(ini.pv);
    let rows = await intentsAfter(pid, mark);
    assert.deepStrictEqual(brief(rows), [['confirm_request', 'confirm_revision', U.own], ['confirm_request', 'confirm_revision', U.x1]], '立项包：两个部门负责人');
    assert.deepStrictEqual(rows.map((r) => r.ref_id), iniTasks.map((t) => t.rev_id), '意图引用各自首修订');
    assert.ok(rows.every((r) => r.channel === 'dingtalk' && r.status !== 'pending'), '发完不再 pending');
    if (kit) assert.deepStrictEqual(rows.map((r) => [r.status, r.attempts, r.last_error]), [['sent', 1, null], ['sent', 1, null]]);
    // ② 总体规划包：负责人各一条待确认通知，领导各一条知悉消息。
    mark = await lastId(pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkPreparedVersion(pk);
    await planAllNodes(pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    rows = await intentsAfter(pid, mark);
    assert.deepStrictEqual(brief(rows), [
      ['confirm_request', 'confirm_revision', U.del], ['confirm_request', 'confirm_revision', U.x2],
      ['leader_confirmation_notice', 'confirm_revision', U.own], ['leader_confirmation_notice', 'confirm_revision', U.x1],
    ]);
    assert.deepStrictEqual(rows.map((r) => r.ref_id), [...tasks, ...tasks].map((t) => t.rev_id));
    if (kit) {
      const notices = kit.ding.sends().filter((call) => call.title === '【系统建设记录】确认发起知悉');
      assert.deepStrictEqual(notices.map((call) => call.userIds[0]).sort(), [`ding-u${U.own}`, `ding-u${U.x1}`].sort());
      for (const call of notices) assert.strictEqual(call.markdown, `### 【系统建设记录】确认发起知悉\n\n项目有一项范围确认已发起，由需求部门负责人确认，供知悉\n\n[查看项目](${BASE_URL}/Sys_Build.html?project=${pid})`);
    }
    for (const leader of [U.own, U.x1]) {
      const todo = (await get(leader, '/sysbuild/my/todo')).body;
      assert.ok(!(todo.items.confirm || []).some((item) => item.project_id === pid), '领导没有这次范围确认的待办');
    }
    // ③ 改发：甲部负责人的任务改发 → 新修订一条 confirm_reissue（同一人），引用新修订
    mark = await lastId(pid);
    const rs = await post(U.pm, `/sysbuild/confirm-tasks/${tasks[0].task_id}/reissue`, { reason: '重新发给负责人' });
    assert.strictEqual(rs.status, 200, rs.text);
    rows = await intentsAfter(pid, mark);
    assert.deepStrictEqual(brief(rows), [['confirm_reissue', 'confirm_revision', U.del]]);
    assert.strictEqual(rows[0].ref_id, rs.body.revision.id);
    // ④ 平台上有异议 / 不认可 → PM（引用被决策的修订）；确认 → 无意图
    mark = await lastId(pid);
    const rj = await openAndDecide(U.del, tasks[0].task_id, 'reject');
    assert.strictEqual(rj.status, 200, rj.text);
    rows = await intentsAfter(pid, mark);
    assert.deepStrictEqual(brief(rows), [['decision_objected', 'confirm_revision', U.pm]], '不认可 → PM');
    assert.strictEqual(rows[0].ref_id, rs.body.revision.id);
    if (kit) {
      // L5（修订批 1）：通知 PM 的正文逐字——标题、项目名、「有确认被提出异议或不认可：」+ 对象摘要、链接（ROUTES.confirm 形状 project + rev）；PM 不是需求部门负责人，所以带项目名与摘要而不是固定文案
      const toPm = kit.ding.sends().filter((c) => c.userIds[0] === `ding-u${U.pm}`);
      assert.strictEqual(toPm.length, 1);
      assert.strictEqual(toPm[0].title, '【系统建设记录】确认被提出异议或不认可');
      assert.strictEqual(toPm[0].markdown, `### 【系统建设记录】确认被提出异议或不认可\n\n**项目**：${await sysName(pid)}\n\n有确认被提出异议或不认可：总体规划内容包第 1 版待确认\n\n[打开确认](${BASE_URL}/Sys_Build.html?project=${pid}&rev=${rs.body.revision.id})`);
    }
    mark = await lastId(pid);
    const ob = await openAndDecide(U.x2, tasks[1].task_id, 'object');
    assert.strictEqual(ob.status, 200, ob.text);
    assert.deepStrictEqual(brief(await intentsAfter(pid, mark)), [['decision_objected', 'confirm_revision', U.pm]], '有异议 → PM');
    mark = await lastId(pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${tasks[1].task_id}/reissue`, { reason: '确认意见已处理' })).status, 200);
    mark = await lastId(pid);
    assert.strictEqual((await openAndDecide(U.x2, tasks[1].task_id, 'confirm')).status, 200);
    assert.deepStrictEqual(await intentsAfter(pid, mark), [], '确认不产生通知');
    // ⑤ 业务状态不受通知影响：任务修订状态由决策决定（与发送结果无关）
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [rs.body.revision.id])).status, 'rejected');
  });

  test(`${T_LEADER}——改发和已确认不丢失知悉；撤回、终止待确认、换领导或引用不符时跳过`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const purpose = 'leader_confirmation_notice';
    const leaderNotices = async (pid) => (await intentsAfter(pid)).filter((row) => row.purpose === purpose);
    const replay = async (intent) => {
      await sqlRun("UPDATE sysbuild_send_intents SET status = 'failed', attempts = 1 WHERE id = ?", [intent.id]);
      return kit.notifier.deliverIntent(intent.id);
    };
    const scene = await mkScene();
    const sub = await submitOverall(scene.pid, { includeInitiationTask: false });
    const [notice] = await leaderNotices(scene.pid);
    assert.deepStrictEqual([notice.ref_id, notice.recipient_user_id], [sub.ridDel, U.own]);
    const changed = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidDel}/reissue`, { reason: '再请现任负责人确认' });
    assert.strictEqual(changed.status, 200, changed.text);
    assert.strictEqual((await leaderNotices(scene.pid)).length, 1, '改发不新增领导知悉');
    assert.strictEqual((await replay(notice)).outcome, 'sent', '有效提交中，首修订已被改发仍可发送');
    const decision = await openAndDecide(U.del, sub.tidDel, 'confirm');
    assert.strictEqual(decision.body.effective, true);
    assert.strictEqual((await replay(notice)).outcome, 'sent', '负责人先确认不影响知悉');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${scene.pid}/status`, { to: 'terminated', reason: '终止已确认项目' })).status, 200);
    assert.strictEqual((await replay(notice)).outcome, 'sent', '已经生效的提交在项目后来终止后仍可知悉');

    const retry = await mkScene();
    const pending = await submitOverall(retry.pid, { includeInitiationTask: false });
    const [before] = await leaderNotices(retry.pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pending.pv}/withdraw`, { reason: '补充范围说明' })).status, 200);
    assert.strictEqual((await replay(before)).outcome, 'skipped');
    const next = await mkVersion(pending.pk);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${next}/submit`)).status, 200);
    const [oldNotice, newNotice] = await leaderNotices(retry.pid);
    assert.notStrictEqual(oldNotice.ref_id, newNotice.ref_id, '撤回后重新提交取得新的部门首修订');
    assert.strictEqual(newNotice.recipient_user_id, U.own);
    const foreign = await fixIntent(scene.pid, U.own, newNotice.ref_id, { purpose });
    const mismatch = await kit.notifier.deliverIntent(foreign);
    assert.deepStrictEqual([mismatch.outcome, mismatch.reason], ['skipped', '确认发起知悉的提交对象不符'], '先核项目归属');
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'invalid', status_reason = '夹具：已作废' WHERE id = ?", [newNotice.ref_id]);
    const invalid = await replay(newNotice);
    assert.deepStrictEqual([invalid.outcome, invalid.reason], ['skipped', '本次确认提交已有失效任务']);
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'pending', status_reason = NULL WHERE id = ?", [newNotice.ref_id]);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${retry.pid}/status`, { to: 'terminated', reason: '终止待确认项目' })).status, 200);
    const terminated = await replay(newNotice);
    assert.deepStrictEqual([terminated.outcome, terminated.reason], ['skipped', '项目已终止，本次确认提交已失效']);

    const transfer = await mkScene();
    await submitOverall(transfer.pid, { includeInitiationTask: false });
    const [prior] = await leaderNotices(transfer.pid);
    const replaced = await api(U.pm, 'PUT', `/sysbuild/parties/${transfer.A.party}/people`, {
      leader_user_id: U.cand, representative_user_id: U.del, expected_appointment_id: transfer.A.apt,
      expected_delegation_id: transfer.A.dlg, reason: '需求方领导调整',
    });
    assert.strictEqual(replaced.status, 200, replaced.text);
    assert.strictEqual((await replay(prior)).outcome, 'skipped', '收件人已不在任');
    assert.strictEqual((await leaderNotices(transfer.pid)).length, 1, '接任后不补发');

    const same = await mkScene();
    // 直接指定入口禁止同账号担任两种角色。夹具只验证通知的防御性去重。
    await sqlRun('UPDATE sysbuild_delegations SET member_id = ? WHERE id = ?', [same.A.mOwn, same.A.dlg]);
    await seedEffectiveInitiation(same.pid);
    await planAllNodes(same.pid);
    const identical = await mkPreparedVersion(await mkPackage(same.pid, 'overall'));
    const submitted = await post(U.pm, `/sysbuild/package-versions/${identical}/submit`);
    assert.strictEqual(submitted.status, 200, submitted.text);
    assert.deepStrictEqual(submitted.body.tasks.map((task) => task.required_member_id), [same.A.mOwn]);
    assert.deepStrictEqual(await leaderNotices(same.pid), []);
  });

  test(T_LEADER_TEXT, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const scene = await mkScene();
    await produceEffectiveOverall(scene.pid);
    const batch = await H.defaultBatchId(scene.pid);
    const assertText = (stage) => {
      const title = '【系统建设记录】确认发起知悉';
      const calls = kit.ding.sends().filter((call) => call.title === title);
      assert.deepStrictEqual(calls.map((call) => [call.userIds, call.title, call.markdown]), [[
        [`ding-u${U.own}`], title,
        `### 【系统建设记录】确认发起知悉\n\n项目有一项${stage}确认已发起，由需求部门负责人确认，供知悉\n\n[查看项目](${BASE_URL}/Sys_Build.html?project=${scene.pid})`,
      ]], `[leader-text-${stage}] 完整标题、正文、项目链接与收件人逐字`);
    };
    kit.ding.reset();
    await H.readyForGolive(scene.pid, batch);
    assertText('验收');
    await H.productionGolive(batch);
    await H.prepareAdditionalClosingCards(scene.pid);
    kit.ding.reset();
    const version = await mkVersion(await mkPackage(scene.pid, 'closing'));
    const submitted = await post(U.pm, `/sysbuild/package-versions/${version}/submit`);
    assert.strictEqual(submitted.status, 200, submitted.text);
    assertText('结项');
  });

  function leaderDelivery(kit) {
    const notice = async (pid) => (await intentsAfter(pid)).find((row) => row.purpose === 'leader_confirmation_notice');
    const requeue = (id) => sqlRun("UPDATE sysbuild_send_intents SET status = 'failed', attempts = 1 WHERE id = ?", [id]);
    const resend = (pid) => post(U.pm, `/sysbuild/projects/${pid}/send-intents/resend`);
    const sendsFor = (pid) => kit.ding.sends().filter((call) => call.markdown.includes(`project=${pid})`));
    const attempt = async (pid, id) => (await payloads(pid, 'send_intent_attempted')).filter((event) => event.intent_id === id).at(-1);
    return { notice, requeue, resend, sendsFor, attempt };
  }

  test(T_LEADER_DISABLED, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { notice, resend, sendsFor, attempt } = leaderDelivery(kit);
    const disabled = await mkScene();
    await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.own]);
    try {
      kit.ding.reset();
      await submitOverall(disabled.pid, { includeInitiationTask: false });
      const intent = await notice(disabled.pid);
      const failed = await attempt(disabled.pid, intent.id);
      assert.deepStrictEqual([intent.status, intent.attempts, failed.outcome, failed.response.reason], ['failed', 1, 'failed', 'user_disabled']);
      assert.deepStrictEqual(sendsFor(disabled.pid), [], '账号停用期间没有知悉外发');
    } finally { await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.own]); }
    const recover = await notice(disabled.pid);
    kit.ding.reset();
    const restored = await resend(disabled.pid);
    assert.strictEqual(restored.status, 200, restored.text);
    assert.ok(restored.body.results.some((row) => row.id === recover.id && row.outcome === 'sent'));
    assert.deepStrictEqual(sendsFor(disabled.pid).map((row) => row.userIds), [[`ding-u${U.own}`]], '恢复后经补发端点发送一次');
  });

  test(T_LEADER_REMOVED, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { notice, requeue, resend, sendsFor, attempt } = leaderDelivery(kit);
    const removed = await mkScene();
    await submitOverall(removed.pid, { includeInitiationTask: false });
    const removedIntent = await notice(removed.pid);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${removed.A.mOwn}/remove`, { reason: '需求方领导已调离本项目' })).status, 200);
    await requeue(removedIntent.id);
    kit.ding.reset();
    const gone = await resend(removed.pid);
    assert.strictEqual(gone.status, 200, gone.text);
    assert.ok(gone.body.results.some((row) => row.id === removedIntent.id && row.outcome === 'skipped'));
    const stored = await intentRow(removedIntent.id);
    assert.deepStrictEqual([stored.status, stored.attempts, stored.last_error], ['sent', 1, '无需发送：收件人已不是该部门现任领导'], '永久跳过进入终态，尝试次数不变');
    const skipped = await attempt(removed.pid, removedIntent.id);
    assert.deepStrictEqual([skipped.via, skipped.outcome], ['resend', 'skipped']);
    assert.deepStrictEqual(sendsFor(removed.pid), [], '领导移出后无外发');
  });

  test(T_LEADER_CHANNELS, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { notice, requeue, resend, sendsFor, attempt } = leaderDelivery(kit);
    const stopped = await mkScene();
    await submitOverall(stopped.pid, { includeInitiationTask: false });
    const stoppedIntent = await notice(stopped.pid);
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${stopped.pid}/status`, { to: 'terminated', reason: '终止时范围仍待确认' })).status, 200);
    await requeue(stoppedIntent.id);
    kit.ding.reset();
    const blocked = await resend(stopped.pid);
    assert.strictEqual(blocked.status, 200, blocked.text);
    assert.ok(blocked.body.results.some((row) => row.id === stoppedIntent.id && row.outcome === 'skipped'));
    const byResend = await attempt(stopped.pid, stoppedIntent.id);
    assert.deepStrictEqual([byResend.via, byResend.outcome], ['resend', 'skipped']);
    assert.deepStrictEqual(sendsFor(stopped.pid), []);

    await requeue(stoppedIntent.id);
    kit.ding.reset();
    const { createNotifier } = require(kit.modulePath());
    const scanner = createNotifier({
      db: kit.db, logger: { info() {}, warn() {}, error() {} }, dingtalkNotify: kit.ding.api,
      getSystemConfig: kit.ding.getSystemConfig, readonlyIds: kit.readonlyIds, backgroundJobs: true,
    });
    assert.strictEqual(scanner.onReady(), true);
    await scanner.whenIdle();
    const byScan = await attempt(stopped.pid, stoppedIntent.id);
    assert.deepStrictEqual([byScan.via, byScan.outcome], ['scan', 'skipped']);
    assert.strictEqual((await intentRow(stoppedIntent.id)).attempts, 1);
    assert.deepStrictEqual(sendsFor(stopped.pid), []);
  });

  test(`${T_ROLLBACK}——触发通知的写事务回滚（注入提交前失败）时不留发送意图、不外发，业务写入也随之回滚`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const s = await mkScene();
    const sub = await submitInitiation(s.pid);
    const before = await countOf('SELECT COUNT(*) AS n FROM sysbuild_send_intents', []);
    const revs = await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions', []);
    const sendsBefore = kit.ding.sends().length;
    kit.db._internals.setBeforeCommit(async () => { throw new Error('注入：提交前失败'); });
    let r;
    try {
      r = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tasks[0].task_id}/reissue`, { reason: '会被回滚的改发' });
    } finally {
      kit.db._internals.setBeforeCommit(null);
    }
    assert.ok(r.status >= 500, `回滚的请求应是 5xx，实际 ${r.status} ${r.text}`);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_send_intents', []), before, '回滚不留意图');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirm_task_revisions', []), revs, '业务写入同样回滚');
    assert.strictEqual(kit.ding.sends().length, sendsBefore, '回滚不外发');
    // 对照：钩子拿掉后同一请求成功，意图随之出现
    const ok = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tasks[0].task_id}/reissue`, { reason: '这次成功' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_send_intents', []), before + 1);
  });

  // ═══════════════════════ 2 事务外发送与结果回写 ═══════════════════════
  test(`${T_SEND}——成功：sent、attempts + 1、last_error 空，渠道返回摘要写 send_intent_attempted 事件；内容 = 标题 + 摘要 + 「打开确认」链接（base url + 路由）；需求部门负责人只给固定文案 + 链接；失败（errcode / 异常 / 软失败三种名单 / 无消息标识 / 配置缺失 / 无钉钉号）：failed、attempts + 1、last_error 写原因不含令牌与凭证，业务状态不变；手机号反查不回写 users；引用已无需通知则跳过`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    // 用例中途断言失败时也要还原用户的钉钉号 / 手机号并复位替身，否则后面的用例被连带拖红
    try { await sendCases(kit); } finally { await setUser(U.del, `ding-u${U.del}`, null); kit.ding.reset(); }
    return undefined;
  });
  async function sendCases(kit) {
    const { ding, notifier } = kit;
    const s = await mkScene();
    const { pid } = s;
    const sub = await submitOverall(pid); // 两类待确认消息：领导立项、负责人范围。
    const rid = sub.ridDel;
    const ridOf = (uid) => (uid === U.own ? sub.ridOwn : sub.ridDel);
    const name = await sysName(pid);
    const deliver = async (uid, o) => {
      const id = await fixIntent(pid, uid, ridOf(uid), o);
      const res = await notifier.deliverIntent(id);
      return { id, res, row: await intentRow(id) };
    };
    // ① 成功 + 内容（收件人 del = 代表人，不是部门负责人：带项目名与摘要）
    ding.reset();
    let x = await deliver(U.del);
    assert.strictEqual(x.res.outcome, 'sent');
    assert.deepStrictEqual([x.row.status, x.row.attempts, x.row.last_error], ['sent', 1, null]);
    let call = ding.sends()[0];
    assert.deepStrictEqual(call.userIds, [`ding-u${U.del}`]);
    assert.strictEqual(call.robotCode, SECRETS[2]);
    assert.strictEqual(call.title, '【系统建设记录】待确认');
    const link = `${BASE_URL}/Sys_Build.html?project=${pid}&rev=${rid}`;
    assert.strictEqual(call.markdown, `### 【系统建设记录】待确认\n\n**项目**：${name}\n\n总体规划内容包第 1 版待确认\n\n[打开确认](${link})`);
    const ev = (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === x.id);
    assert.strictEqual(ev.length, 1);
    assert.deepStrictEqual([ev[0].outcome, ev[0].from_status, ev[0].to_status, ev[0].attempts_after, ev[0].via, ev[0].purpose], ['sent', 'pending', 'sent', 1, 'auto', 'confirm_request']);
    assert.strictEqual(JSON.stringify(ev[0]).includes(SECRETS[3]), false, '事件不含令牌');
    // K3（修订批 1）：成功时渠道返回的消息标识（替身返回 processQueryKey = 'pqk-test'）写进事件 response；失败的事件该字段为空
    assert.strictEqual(ev[0].response.process_query_key, 'pqk-test', '成功：事件 response 记 processQueryKey');
    // L2（修订批 1）：系统发送的事件，操作人名一律「系统」（schema.js 约定②）
    const evRow = (await eventsOf(pid, 'send_intent_attempted')).find((e) => JSON.parse(e.payload_json).intent_id === x.id);
    assert.strictEqual(evRow.operator_name, '系统', '系统操作人名');
    // ② 需求部门负责人（own）：固定文案 + 链接，不带项目名与对象摘要
    ding.reset();
    x = await deliver(U.own);
    assert.strictEqual(x.row.status, 'sent');
    call = ding.sends()[0];
    const linkOwn = `${BASE_URL}/Sys_Build.html?project=${pid}&rev=${sub.ridOwn}`;
    assert.strictEqual(call.title, '【系统建设记录】有事项需要您处理');
    assert.strictEqual(call.markdown, `### 【系统建设记录】有事项需要您处理\n\n您有一项事项需要处理，请打开平台查看。\n\n[打开确认](${linkOwn})`);
    assert.ok(!call.markdown.includes(name) && !call.markdown.includes('总体规划'), '负责人不带对象摘要');
    // ③ errcode ≠ 0 → failed
    ding.reset(); ding.state.sendMode = 'errcode'; ding.state.sendErrcode = 88002;
    x = await deliver(U.del);
    assert.strictEqual(x.res.outcome, 'failed');
    assert.deepStrictEqual([x.row.status, x.row.attempts], ['failed', 1]);
    assert.ok(/user_invalid/.test(x.row.last_error) && /88002/.test(x.row.last_error), x.row.last_error);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE id = ?', [rid])).status, 'pending', '发送失败不影响业务状态');
    // ④ 补发成功：failed → sent，attempts 2
    ding.reset();
    assert.strictEqual((await notifier.deliverIntent(x.id)).outcome, 'sent');
    assert.deepStrictEqual([(await intentRow(x.id)).status, (await intentRow(x.id)).attempts], ['sent', 2]);
    assert.strictEqual((await notifier.deliverIntent(x.id)).outcome, 'already_sent', 'sent 是终态，再发直接跳过');
    assert.strictEqual(ding.sends().length, 1);
    // ⑤ 异常（消息里夹带凭证与令牌）→ failed，last_error / 事件不含任何敏感值
    ding.reset(); ding.state.sendMode = 'throw'; ding.state.thrown = new Error(`network down ${SECRETS[0]} ${SECRETS[1]} ${SECRETS[2]} ${SECRETS[3]} ding-u${U.del}`);
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'failed');
    for (const sec of SECRETS.concat([`ding-u${U.del}`])) assert.strictEqual(x.row.last_error.includes(sec), false, `last_error 不含 ${sec}`);
    const evx = (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === x.id);
    assert.strictEqual(evx.length, 1);
    for (const sec of SECRETS) assert.strictEqual(JSON.stringify(evx[0]).includes(sec), false, `事件不含 ${sec}`);
    // ⑥ 三种软失败名单与无消息标识
    for (const [mode, reason] of [['invalid_list', 'user_invalid'], ['flow_list', 'rate_limit'], ['filtered_list', 'filtered'], ['no_key', 'no_query_key']]) {
      ding.reset(); ding.state.sendMode = mode;
      x = await deliver(U.del);
      assert.strictEqual(x.row.status, 'failed', mode);
      assert.ok(x.row.last_error.includes(reason), `${mode}: ${x.row.last_error}`);
    }
    // ⑦ 令牌失效 → 清缓存重发一次 → 成功
    ding.reset(); ding.state.sendMode = 'token_expired_once';
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'sent');
    assert.strictEqual(ding.sends().length, 2, '令牌失效后重发一次');
    assert.ok(ding.calls.some((c) => c.api === 'clearCachedToken'));
    // ⑧ 配置缺失 / 读取失败 / 取令牌失败
    ding.reset(); ding.state.config = { platform_base_url: BASE_URL };
    x = await deliver(U.del);
    assert.deepStrictEqual([x.row.status, x.row.last_error.includes('no_config') || x.row.last_error.includes('配置缺失')], ['failed', true]);
    assert.strictEqual(ding.sends().length, 0, '配置缺失不外发');
    ding.reset(); ding.state.configError = new Error('config db down');
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'failed');
    ding.reset(); ding.state.tokenError = Object.assign(new Error('gettoken failed: errcode=40001 errmsg=bad'), { errcode: 40001, errmsg: 'bad' });
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'failed');
    assert.ok(/gettoken/.test(x.row.last_error), x.row.last_error);
    // ⑨ 收件人无钉钉号：有手机号 → 反查成功后发送，反查结果只在内存里用，不回写 users；无手机号 → 失败
    await setUser(U.del, null, '13800000001');
    ding.reset(); ding.state.mobileMap['13800000001'] = 'ding-looked-up';
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'sent');
    assert.deepStrictEqual(ding.sends()[0].userIds, ['ding-looked-up']);
    assert.deepStrictEqual(await sqlGet('SELECT dingtalk_user_id, phone FROM users WHERE id = ?', [U.del]), { dingtalk_user_id: null, phone: '13800000001' }, '不回写 users');
    ding.reset(); ding.state.mobileMap = {};
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'failed');
    assert.ok(/get_by_mobile/.test(x.row.last_error), x.row.last_error);
    await setUser(U.del, null, null);
    ding.reset();
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'failed');
    assert.ok(/没有钉钉号/.test(x.row.last_error), x.row.last_error);
    assert.strictEqual(ding.sends().length, 0);
    await setUser(U.del, `ding-u${U.del}`, null);
    // ⑩ platform_base_url 缺失：照常发送，链接退化为相对路径（不算失败）
    ding.reset(); delete ding.state.config.platform_base_url;
    x = await deliver(U.del);
    assert.strictEqual(x.row.status, 'sent');
    assert.ok(ding.sends()[0].markdown.endsWith(`[打开确认](/Sys_Build.html?project=${pid}&rev=${rid})`), ding.sends()[0].markdown);
    // ⑪ 引用对象已无需通知：修订不再待确认 → 跳过（sent、attempts 不变、last_error 说明、不外发）
    ding.reset();
    assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'confirm')).status, 200);
    ding.reset();
    x = await deliver(U.del);
    assert.strictEqual(x.res.outcome, 'skipped');
    assert.deepStrictEqual([x.row.status, x.row.attempts, x.row.last_error], ['sent', 0, '无需发送：修订已不是待确认']);
    assert.strictEqual(ding.sends().length, 0);
    const evs = (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === x.id);
    assert.deepStrictEqual([evs[0].outcome, evs[0].response], ['skipped', { skipped: '修订已不是待确认' }]);
  }

  test(`${T_DEDUP}——同一意图并发发送两次只外发一次（内存集合标记发送中，P156）；发送完成后再发直接跳过；不同意图互不影响`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const s = await mkScene();
    const sub = await submitOverall(s.pid);
    const rid = sub.ridDel; // 夹具意图的收件人必须是该修订的必需确认人（代表人 del），多条意图可以指向同一收件人 + 同一修订（互相独立，各自一条）
    const id1 = await fixIntent(s.pid, U.del, rid);
    const id2 = await fixIntent(s.pid, U.del, rid);
    ding.reset();
    // 断言失败时也必须放行 gate 并复位替身（否则后面的用例会被卡住的发送拖死），所以整个用例放在 try / finally 里
    const releases = [];
    try {
    let release;
    ding.state.gate = new Promise((r) => { release = r; });
    releases.push(() => release());
    const p1 = notifier.deliverIntent(id1);
    // 让第一次发送进入钉钉调用（卡在 gate 上）：轮询「钉钉替身收到的调用数」这个信号，上限 5 秒
    for (let i = 0; i < 1000 && ding.sends().length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    assert.strictEqual(ding.sends().length, 1, '第一次已进入发送');
    // 第二次调用：有「发送中」标记时立刻返回 in_flight；没有标记就会卡在 gate 上，所以用 500ms 超时兜底（先放行再断言，不让用例挂住）
    const second = await Promise.race([notifier.deliverIntent(id1), new Promise((r) => setTimeout(() => r({ outcome: 'blocked' }), 500))]);
    release();
    assert.strictEqual(second.outcome, 'in_flight', '同一意图已在发送中：跳过');
    const first = await p1;
    assert.strictEqual(first.outcome, 'sent');
    assert.strictEqual(ding.sends().length, 1, '只外发一次');
    assert.deepStrictEqual([(await intentRow(id1)).status, (await intentRow(id1)).attempts], ['sent', 1]);
    assert.strictEqual((await notifier.deliverIntent(id1)).outcome, 'already_sent');
    assert.strictEqual(ding.sends().length, 1);
    // 不同意图并发各发一次
    ding.reset();
    const [a, b] = await Promise.all([notifier.deliverIntent(id2), notifier.deliverIntent(await fixIntent(s.pid, U.del, rid))]);
    assert.deepStrictEqual([a.outcome, b.outcome], ['sent', 'sent']);
    assert.strictEqual(ding.sends().length, 2);
    // 发送期间别处已把这条意图处理完（条件更新的旧状态不符）：本次不再覆盖写，结果 conflict，不记事件
    const id3 = await fixIntent(s.pid, U.del, rid);
    ding.reset();
    let release3;
    ding.state.gate = new Promise((r) => { release3 = r; });
    releases.push(() => release3());
    const p3 = notifier.deliverIntent(id3);
    for (let i = 0; i < 1000 && ding.sends().length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent', attempts = 5 WHERE id = ?", [id3]);
    release3();
    assert.strictEqual((await p3).outcome, 'conflict');
    assert.deepStrictEqual([(await intentRow(id3)).status, (await intentRow(id3)).attempts], ['sent', 5], '不覆盖别处的结果');
    assert.strictEqual((await payloads(s.pid, 'send_intent_attempted')).filter((p) => p.intent_id === id3).length, 0, '冲突不记事件');
    } finally {
      for (const f of releases) f();
      await notifier.whenIdle();
      ding.reset();
    }
  });

  // ═══════════════════════ 3 补发端点与列表 ═══════════════════════
  test(`${T_RESEND}——POST send-intents/resend：重发本项目 failed 的全部与创建超过 5 分钟的 pending（新建不足 5 分钟的 pending、已发的、别的项目的不动），返回各条结果计数；权限 PM（非 PM 成员 403、admin 未接管 403、非成员 404）；四种项目状态都可；GET send-intents 列表（PM、status 筛选、不含敏感字段）；PM 详情带发送失败条数`, async () => {
    const kit = kitOrNull();
    const s = await mkScene();
    const { pid } = s;
    const url = `/sysbuild/projects/${pid}/send-intents`;
    // 权限与参数（两种跑法都做）
    expectErr(await post(U.m1, `${url}/resend`), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
    expectErr(await post(U.admin, `${url}/resend`), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
    expectErr(await post(U.out, `${url}/resend`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, `${url}/resend`, { x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '不支持的字段');
    expectErr(await get(U.m1, url), 403, 'SYSBUILD_FORBIDDEN', '非 PM 看不到列表');
    expectErr(await get(U.out, url), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await get(U.pm, `${url}?status=bogus`), 400, 'SYSBUILD_INVALID_INPUT', '非法 status');
    if (!kit) return undefined;
    const { ding } = kit;
    const sub = await submitOverall(pid);
    const rid = sub.ridDel;
    // 夹具意图的收件人 = 所引用修订的必需确认人（K1：发送前复核）；多条意图可指向同一收件人 + 同一修订
    const f1 = await fixIntent(pid, U.del, rid, { status: 'failed', attempts: 1, lastError: '旧失败' });
    const f2 = await fixIntent(pid, U.del, rid, { status: 'failed', attempts: 3, lastError: '旧失败 3' });
    const oldPending = await fixIntent(pid, U.del, rid, { createdAt: "2020-01-01 00:00:00" });
    const freshPending = await fixIntent(pid, U.del, rid, { createdAt: (await sqlGet("SELECT datetime('now','localtime','-1 minutes') AS t", [])).t });
    const sentRow = await fixIntent(pid, U.own, sub.ridOwn, { status: 'sent', attempts: 1 });
    await fixIntent(pid, U.own, sub.ridOwn, { status: 'sent', attempts: 1 }); // 已发的共 4 条（含创建任务时自动发的两条），与失败条数区分开
    const other = await mkScene();
    const otherRid = (await submitOverall(other.pid)).ridDel;
    const otherFailed = await fixIntent(other.pid, U.del, otherRid, { status: 'failed', attempts: 1, lastError: '别的项目' });
    // 列表：PM 可见，status 筛选；不含手机号 / 钉钉号
    const all = await get(U.pm, url);
    assert.strictEqual(all.status, 200, all.text);
    assert.strictEqual(all.body.failed_count, 3, 'L3：失败的 2 条 + 超过 5 分钟仍 pending 的 1 条（新建不足 5 分钟的不计）');
    const failedList = await get(U.pm, `${url}?status=failed`);
    assert.deepStrictEqual(failedList.body.items.map((i) => i.id).sort((a, b) => a - b), [f1, f2], '按 status 筛选仍是原始状态（待发送超时的 pending 不在 failed 筛选里）');
    const sample = failedList.body.items[0];
    assert.deepStrictEqual(Object.keys(sample).sort(), ['attempts', 'channel', 'created_at', 'id', 'last_error', 'purpose', 'recipient_name', 'recipient_user_id', 'ref_id', 'ref_type', 'status', 'updated_at']);
    // PM 详情带发送失败条数（非 PM 详情不带）
    assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${pid}`)).body.notify, { send_failed: 3 });
    assert.strictEqual((await get(U.m1, `/sysbuild/projects/${pid}`)).body.notify, undefined);
    // L3：PM 待办 send_failed 同口径——超时 pending 文案「待发送超时」，新建不足 5 分钟的不列
    const sfTodo = (await get(U.pm, '/sysbuild/my/todo')).body.items.send_failed.filter((i) => i.project_id === pid);
    assert.deepStrictEqual(sfTodo.map((i) => [i.intent_id, i.kind, i.last_error]).sort((a, b) => a[0] - b[0]), [[f1, 'intent_failed', '旧失败'], [f2, 'intent_failed', '旧失败 3'], [oldPending, 'intent_pending_timeout', '待发送超时']]);
    // 暂停项目：补发不改业务，四种状态都可（先用暂停验证，最后终止再验一次）
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/status`, { to: 'paused', reason: '补发用例' })).status, 200);
    ding.reset();
    const r = await post(U.pm, `${url}/resend`);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.counts, { total: 3, sent: 3, failed: 0, skipped: 0, other: 0, remaining: 0 }, '失败 2 条 + 旧 pending 1 条');
    // 修订批 3（N1）：补发候选按「最近尝试时间升序」取，从未尝试的（oldPending，attempts 0）最先，其余按上次尝试从旧到新（同秒内 attempts 少的在前，f1 先于 f2）
    assert.deepStrictEqual(r.body.results.map((x) => [x.id, x.outcome]), [[oldPending, 'sent'], [f1, 'sent'], [f2, 'sent']]);
    assert.strictEqual(ding.sends().length, 3);
    assert.strictEqual((await intentRow(freshPending)).status, 'pending', '新建不足 5 分钟的 pending 不动');
    assert.deepStrictEqual([(await intentRow(sentRow)).status, (await intentRow(sentRow)).attempts], ['sent', 1], '已发的不动');
    assert.strictEqual((await intentRow(otherFailed)).status, 'failed', '别的项目的不动');
    assert.deepStrictEqual([(await intentRow(f1)).attempts, (await intentRow(f2)).attempts, (await intentRow(oldPending)).attempts], [2, 4, 1]);
    const resent = await payloads(pid, 'send_intents_resent');
    assert.deepStrictEqual(resent[0].intent_ids, [oldPending, f1, f2]);
    // 补发再次失败：计数 failed；已终止的项目也能补发（终止会让待确认修订失效，所以夹具改用「被不认可通知 PM」这种用途——它不看修订是否仍待确认；
    //   K1 之后该意图要引用一条真实被不认可的修订：恢复进行中 → 代表人不认可自己的任务（发送让它失败）→ 终止 → 补发）
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/status`, { to: 'active', reason: '补发用例' })).status, 200);
    ding.reset(); ding.state.sendMode = 'errcode';
    const markRj = await lastId(pid);
    assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
    const objIntent = (await intentsAfter(pid, markRj)).find((x) => x.purpose === 'decision_objected');
    assert.deepStrictEqual([objIntent.status, objIntent.attempts], ['failed', 1], '前置：通知 PM 的意图发送失败');
    assert.strictEqual((await post(U.admin, `/sysbuild/projects/${pid}/status`, { to: 'terminated', reason: '补发用例' })).status, 200);
    ding.reset(); ding.state.sendMode = 'errcode';
    const r2 = await post(U.pm, `${url}/resend`);
    assert.strictEqual(r2.status, 200, r2.text);
    assert.deepStrictEqual(r2.body.counts, { total: 1, sent: 0, failed: 1, skipped: 0, other: 0, remaining: 0 }, '已终止项目也可补发');
    assert.strictEqual(r2.body.aborted, null, '用户失效类的失败不是系统性失败，不中止');
    ding.reset();
    // L4（修订批 1）：补发遇到第一个系统性失败（取令牌 / 配置缺失 / 网络类）就中止本批，剩余计入 remaining，响应带中止原因；非系统性失败（收件人失效）不中止
    const ab = await mkScene();
    const subA = await submitOverall(ab.pid);
    const abUrl = `/sysbuild/projects/${ab.pid}/send-intents/resend`;
    const three = [];
    for (let i = 0; i < 3; i += 1) three.push(await fixIntent(ab.pid, U.del, subA.ridDel, { status: 'failed', attempts: 1, lastError: `旧失败 ${i}` }));
    ding.reset(); ding.state.sendMode = 'errcode';
    const c1 = await post(U.pm, abUrl);
    assert.deepStrictEqual([c1.body.counts, c1.body.aborted], [{ total: 3, sent: 0, failed: 3, skipped: 0, other: 0, remaining: 0 }, null], '收件人失效类失败：三条都试，不中止');
    const attemptsOf = async () => Promise.all(three.map(async (id) => (await intentRow(id)).attempts));
    assert.deepStrictEqual(await attemptsOf(), [2, 2, 2]);
    //   修订批 3（N1）：候选按最近尝试时间升序，刚被试过的排后——连续几次因系统性失败中止时，被试的依次是 three[0]、three[1]、three[2]（轮转），不再每次卡在第一条
    const abortCase = async (setup, reasonRe, label, idx) => {
      ding.reset(); setup(ding.state);
      const before = await attemptsOf();
      const x = await post(U.pm, abUrl);
      assert.strictEqual(x.status, 200, x.text);
      assert.deepStrictEqual([x.body.counts.total, x.body.counts.failed, x.body.counts.remaining], [1, 1, 2], `${label}：只试一条，剩余 2 条计入 remaining`);
      assert.strictEqual(x.body.aborted.intent_id, three[idx], label);
      assert.ok(reasonRe.test(x.body.aborted.reason), `${label}：中止原因 ${x.body.aborted.reason}`);
      const after = await attemptsOf();
      assert.deepStrictEqual(after.map((a, i) => a - before[i]), three.map((_, i) => (i === idx ? 1 : 0)), `${label}：只有被试的那条 attempts + 1，另两条没有被试`);
      assert.strictEqual((await payloads(ab.pid, 'send_intents_resent')).pop().aborted.reason, x.body.aborted.reason, `${label}：补发事件同样记中止原因`);
    };
    await abortCase((st) => { st.tokenError = Object.assign(new Error('gettoken failed: errcode=40001 errmsg=bad'), { errcode: 40001, errmsg: 'bad' }); }, /^gettoken_/, '取令牌失败', 0);
    await abortCase((st) => { st.config = { platform_base_url: BASE_URL }; }, /^no_config$/, '钉钉配置缺失', 1);
    await abortCase((st) => { st.sendMode = 'throw'; st.thrown = new Error('fetch failed'); }, /^send_network$/, '网络类失败', 2);
    ding.reset();
  });

  test(`${T_SCAN}——模块就绪扫描：pending 与 failed 且 attempts < 3 的意图重发（attempts 已满 3 次的失败行不动）；后台任务开关为 on 才扫（off 的 onReady 什么也不做）；扫描函数与补发端点同一套发送流程`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const { createNotifier } = require(kit.modulePath());
    const s = await mkScene();
    const sub = await submitOverall(s.pid);
    const rid = sub.ridDel; // 夹具意图的收件人 = 该修订的必需确认人（K1：发送前复核）
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent' WHERE status = 'pending'", []); // 前面用例遗留的 pending 不干扰本用例
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent' WHERE status = 'failed' AND attempts < 3", []);
    const pend = await fixIntent(s.pid, U.del, rid, { createdAt: null });
    const f2 = await fixIntent(s.pid, U.del, rid, { status: 'failed', attempts: 2, lastError: '失败两次' });
    const f3 = await fixIntent(s.pid, U.del, rid, { status: 'failed', attempts: 3, lastError: '失败三次' });
    ding.reset();
    const res = await notifier.scan();
    assert.deepStrictEqual([res.total, res.sent], [2, 2], '扫描只发 pending 与 attempts < 3 的 failed');
    assert.deepStrictEqual([(await intentRow(pend)).status, (await intentRow(f2)).status, (await intentRow(f2)).attempts], ['sent', 'sent', 3]);
    assert.deepStrictEqual([(await intentRow(f3)).status, (await intentRow(f3)).attempts], ['failed', 3], '失败满 3 次的不扫');
    // 开关：off 不扫；on 就绪后扫一次（再调用不重复）
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'pending' WHERE id = ?", [pend]);
    const off = createNotifier({ db: kit.db, logger: { info() {}, warn() {}, error() {} }, dingtalkNotify: ding.api, getSystemConfig: ding.getSystemConfig, readonlyIds: kit.readonlyIds, backgroundJobs: false });
    ding.reset();
    assert.strictEqual(off.onReady(), false);
    await off.whenIdle();
    assert.strictEqual((await intentRow(pend)).status, 'pending', '开关 off：不扫');
    const on = createNotifier({ db: kit.db, logger: { info() {}, warn() {}, error() {} }, dingtalkNotify: ding.api, getSystemConfig: ding.getSystemConfig, readonlyIds: kit.readonlyIds, backgroundJobs: true });
    assert.strictEqual(on.onReady(), true);
    await on.whenIdle();
    assert.strictEqual((await intentRow(pend)).status, 'sent', '开关 on：扫描补发');
    assert.strictEqual(on.onReady(), false, '只扫一次');
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent' WHERE status = 'pending'", []);
  });

  // ═══════════════════════ 4 待办（§9.1 / §4；C6 起没有 routing / notice / objection 三类，handle 里也没有 entry_unresolved）═══════════════════════
  test(`${T_TODO}——GET /my/todo 各类各一例（载体 = 内容包确认任务）：confirm（角标计数 = GET /my/confirmations）/ handle（PM：被不认可 / 有异议的修订未改发前，kind = revision_declined）/ send_failed（PM：失败的意图）/ overdue（PM：超过 3 天仍待确认）；非 PM 看不到 PM 类别；counts / items 键集合按现行类别核对；items 每类至多 50 条`, async () => {
    const s = await mkScene();
    const { pid } = s;
    const sub = await submitOverall(pid); // 分别用立项与范围任务保留两种角色的待办和处理路径。
    const mine = (todo, key) => todo.items[key].filter((i) => i.project_id === pid);
    const todoOf = async (uid) => { const r = await get(uid, '/sysbuild/my/todo'); assert.strictEqual(r.status, 200, r.text); return r.body; };
    const ITEM_KEYS = ['confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task'];
    // ① confirm：代表人 del 有待确认任务 sub.tidDel
    const confUid = U.del;
    const confTodo = await todoOf(confUid);
    const conf = await get(confUid, '/sysbuild/my/confirmations');
    assert.strictEqual(confTodo.counts.confirm, conf.body.items.length, '角标计数 = my/confirmations 条数');
    assert.deepStrictEqual(confTodo.items.confirm, conf.body.items.slice(0, 50), 'confirm 类与 my/confirmations 同源（前 50 条）');
    assert.ok(conf.body.items.some((i) => i.task_id === sub.tidDel), '本任务在 my/confirmations 里');
    if (confTodo.counts.confirm <= 50) assert.ok(mine(confTodo, 'confirm').some((i) => i.task_id === sub.tidDel), '不足 50 条时全量列出');
    // 非 PM 看不到 PM 类别；键集合精确全等（不只逐键断言为空，防止被删类别键残留）
    const m1Todo = await todoOf(U.m1);
    for (const k of ['handle', 'send_failed', 'overdue']) assert.deepStrictEqual(mine(m1Todo, k), [], `非 PM 的 ${k} 为空`);
    assert.deepStrictEqual(Object.keys(m1Todo.items).sort(), ITEM_KEYS, '非 PM 的 items 键集合精确全等');
    // ④ handle：被有异议 / 被不认可的修订（PM 尚未改发前）——own 对 sub.tidOwn 提 object（修订 objected），del 对 sub.tidDel 提 reject（修订 rejected）
    assert.strictEqual((await openAndDecide(U.own, sub.tidOwn, 'object')).status, 200);
    assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
    const declined = mine(await todoOf(U.pm), 'handle').filter((i) => i.kind === 'revision_declined');
    assert.ok(declined.some((i) => i.task_id === sub.tidOwn && i.status === 'objected'), '被有异议的修订进 PM 的 handle（status = objected）');
    assert.ok(declined.some((i) => i.task_id === sub.tidDel && i.status === 'rejected'), '被不认可的修订进 PM 的 handle（status = rejected；原承载 notify 1223 用例的 rejected 一格并入这里）');
    // PM 对两个任务各改发后，两项都不再列（任务最新修订不再是被否 / 有异议的）
    const rsOwn = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidOwn}/reissue`, { reason: '重新发给负责人' });
    assert.strictEqual(rsOwn.status, 200, rsOwn.text);
    const rsDel = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidDel}/reissue`, { reason: '重新发给代表人' });
    assert.strictEqual(rsDel.status, 200, rsDel.text);
    const after = mine(await todoOf(U.pm), 'handle').filter((i) => i.kind === 'revision_declined');
    assert.ok(!after.some((i) => i.task_id === sub.tidOwn || i.task_id === sub.tidDel), '改发后不再列');
    // ④b handle 的 package_version 分支（declinedStillOpen）：另起场景（不能复用 sub：后面 overdue 依赖 sub.tidOwn 的 rev_no = 2）。
    //   负责人对待确认版本提异议（修订 objected，仍是最新修订）→ PM 撤回提交（版本 pending → superseded，只关 pending 修订，objected 修订原样保留）→ 不再列。
    //   「改发」不能验这个分支：改发产生 rev_no + 1 的新修订，旧修订在 SQL 的「最新修订」条件就被排除，走不到 declinedStillOpen（#212 C6 CA5g M1753）
    {
      const s2 = await mkScene();
      const sub2 = await submitOverall(s2.pid, { includeInitiationTask: false });
      assert.strictEqual((await openAndDecide(U.del, sub2.tidDel, 'object')).status, 200);
      const declinedOf = async () => (await todoOf(U.pm)).items.handle.filter((i) => i.project_id === s2.pid && i.kind === 'revision_declined');
      assert.ok((await declinedOf()).some((i) => i.task_id === sub2.tidDel), '对照：撤回提交前列出（版本仍待确认）');
      const latest = () => sqlGet('SELECT id, status FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1', [sub2.tidDel]); // 193-M3：撤回前后最新修订不变
      const before = await latest();
      assert.strictEqual(before.status, 'objected', '前置：最新修订是 objected');
      const wd2 = await post(U.pm, `/sysbuild/package-versions/${sub2.pv}/withdraw`, { reason: '撤回后不再处理该异议' });
      assert.strictEqual(wd2.status, 200, wd2.text);
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [sub2.pv])).status, 'superseded', '前置：版本 pending → superseded');
      assert.deepStrictEqual(await latest(), { id: before.id, status: 'objected' }, '撤回不改异议修订、它仍是最新修订');
      assert.ok(!(await declinedOf()).some((i) => i.task_id === sub2.tidDel), '撤回提交（版本不再待确认）后不再列');
    }
    // ⑥ overdue：PM 所担任项目内创建超过 3 天仍待确认的修订（回拨 sub.tidOwn 改发后的 rev_no = 2 待确认修订）
    const rid2 = (await sqlGet('SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ? AND rev_no = 2', [sub.tidOwn])).id;
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET created_at = datetime('now','localtime','-2 days') WHERE id = ?", [rid2]);
    assert.ok(!mine(await todoOf(U.pm), 'overdue').some((i) => i.revision_id === rid2), '2 天：未超期');
    await sqlRun("UPDATE sysbuild_confirm_task_revisions SET created_at = datetime('now','localtime','-4 days') WHERE id = ?", [rid2]);
    assert.ok(mine(await todoOf(U.pm), 'overdue').some((i) => i.revision_id === rid2), '4 天：超期');
    assert.ok(!mine(await todoOf(U.m1), 'overdue').length, '非 PM 看不到 overdue');
    // ⑦ send_failed：失败的意图（引用同一条 rev_no = 2 待确认修订，收件人 own）
    const failedId = await fixIntent(pid, U.own, rid2, { status: 'failed', attempts: 1, lastError: '待办用例' });
    const sf = await todoOf(U.pm);
    assert.ok(mine(sf, 'send_failed').some((i) => i.intent_id === failedId && i.last_error === '待办用例'), '失败的发送意图进 send_failed');
    await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent' WHERE id = ?", [failedId]);
    assert.ok(!mine(await todoOf(U.pm), 'send_failed').some((i) => i.intent_id === failedId), '补发成功后不再列');
    // ⑧ 每类至多 50 条：counts 是全量
    const sample = await todoOf(U.pm);
    for (const k of Object.keys(sample.items)) assert.ok(sample.items[k].length <= 50, `${k} 至多 50 条`);
    assert.deepStrictEqual(Object.keys(sample.counts).sort(), ['badge', 'confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task']);
    assert.deepStrictEqual(Object.keys(sample.items).sort(), ITEM_KEYS);
    assert.strictEqual(confTodo.counts.badge, confTodo.counts.confirm, '角标只计待确认');
    assert.strictEqual((await get(U.out, '/sysbuild/my/todo')).status, 200, '无任何项目的用户也是空待办而不是报错');
  });

  // ═══════════════════════ C6 新增：知会与待办不再有异议与 notice 类（4.3 第 5 条；变异 N15–N17 / M1777 / M1020）═══════════════════════
  test(`${T_C6_R7}——GET /my/todo 的 counts / items 键集合不再有 notice / routing / objection，handle 里没有 entry_unresolved（登记未办结不再进待办，对照 revision_declined 仍在）；GET /my/notices 的 items[] 去 objected / actions；POST /notices/:nid/object 路由已删；服务启动不因缺 myNoticeItems 抛错`, async () => {
    const s = await mkScene({ partyB: true });
    const { pid } = s;
    // 夹具：PM 担任的项目里经正常入口登记一条 type: feedback、未作废的登记（旧版会把它列为 handle 的 entry_unresolved）；另造一条被有异议的修订（对照 revision_declined 仍在）
    const fb = await post(U.m1, `/sysbuild/projects/${pid}/entries`, { type: 'feedback', title: '未办结的意见', body: '内容' });
    assert.strictEqual(fb.status, 201, fb.text);
    const sub = await submitOverall(pid);
    assert.strictEqual((await openAndDecide(U.own, sub.tidOwn, 'object')).status, 200);
    const todo = (await get(U.pm, '/sysbuild/my/todo')).body;
    assert.deepStrictEqual(Object.keys(todo.counts).sort(), ['badge', 'confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task']);
    assert.deepStrictEqual(Object.keys(todo.items).sort(), ['confirm', 'handle', 'opinion', 'overdue', 'report_due', 'report_overdue', 'send_failed', 'work_task']);
    const handle = todo.items.handle.filter((i) => i.project_id === pid);
    assert.ok(!handle.some((i) => i.kind === 'entry_unresolved'), 'handle 里不再有 entry_unresolved');
    assert.ok(handle.some((i) => i.kind === 'revision_declined' && i.task_id === sub.tidOwn), '对照：revision_declined 仍在');
    // 改期知会：接收人查看、详情照常；items[] 去 objected / actions，as 恒为 recipient
    const eff = await effectiveScene();
    assert.strictEqual((await resched(eff.mile, '2026-12-08')).status, 201);
    const ns = await noticesOf(eff.pid);
    assert.strictEqual(ns.length, 2, '前置：改期知会生成');
    const mineN = (await get(U.own, '/sysbuild/my/notices')).body.items.find((i) => i.id === ns[0].id);
    assert.ok(mineN && !('objected' in mineN) && !('actions' in mineN) && !('objection' in mineN), 'items[] 去 objected / actions');
    assert.strictEqual(mineN.as, 'recipient');
    const det = await get(U.own, `/sysbuild/notices/${ns[0].id}`);
    assert.strictEqual(det.status, 200, det.text);
    assert.ok(!('objection' in det.body.notice), '详情去 objection 键');
    assert.deepStrictEqual((await get(U.out, '/sysbuild/my/notices')).body.items, [], '非成员读 my/notices 为空');
    // POST /notices/:nid/object 路由已删：Express 默认 404（不再有业务码）；不存在的编号与存在的编号同形
    const gone = await post(U.own, `/sysbuild/notices/${ns[0].id}/object`, { reason: '异议' });
    assert.strictEqual(gone.status, 404, gone.text);
    assert.ok(!gone.body || gone.body.code === undefined || !String(gone.body.code).startsWith('SYSBUILD_'), '路由已删：不是业务 JSON');
    const gone2 = await post(U.own, '/sysbuild/notices/99999999/object', { reason: '异议' });
    assert.strictEqual(gone2.status, 404, gone2.text);
    // 已退役待办类别的查询依赖退出，通知工厂只需要当前确认任务读链。
    const notifyMod = require(path.join(T.getModuleDir(), 'notify.js'));
    const baseCtx = { db: {}, logger: { info() {}, warn() {}, error() {} }, notifier: {}, readonlyIds: [], writeRoles: [], myConfirmationItems: async () => [] };
    assert.doesNotThrow(() => notifyMod.createNotifyRoutes(baseCtx), '缺旧类别查询时照常构造');
    const { myConfirmationItems: _omit, ...noConfirm } = baseCtx;
    assert.throws(() => notifyMod.createNotifyRoutes(noConfirm), /myConfirmationItems/, '保留的待确认查询仍必填');
  });

  // ═══════════════════════ C6b 新增：开发方负责人收确认通知走摘要文案（4.3 第 5 条；接替整删的 T_SELF 用例；变异 M1822）═══════════════════════
  test(`${T_DEVMSG}——内容包任务载体：开发方负责人作为必需确认人（夹具：把总体规划包任务的当前修订改成开发方负责人，依据 = 开发方现任任职）收到的「待确认」钉钉消息走项目名 + 对象摘要文案，不是需求方负责人的固定文案（isDemandOwnerUser 按 side = demand 判）`, async () => {
    // #212 C7：原载体是需求条目的提出人确认任务（C7 随需求条目流程删除）；生产路径里需求方以外的人不再是确认人，所以用夹具造「开发方负责人是必需确认人」。
    //   发送口径只在进程内（有消息捕获器）跑，与本文件其余捕获器用例同口径 SKIP，不写 assert.ok(kit)（实例模式会让主跑恒红）；变异自检的子进程遇到跳过一律判异常，缺捕获器不会静默放过。
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const s = await mkScene();
    const sub = await submitOverall(s.pid, { includeInitiationTask: false });
    const D = await addParty(s.pid, '开发方', 'dev');
    const mDev = await addMember(s.pid, U.x1, { party: D });
    const aptDev = await addAppointment(D, mDev, 'active');
    await sqlRun('UPDATE sysbuild_confirm_task_revisions SET required_member_id = ?, basis_appointment_id = ?, basis_delegation_id = NULL WHERE id = ?', [mDev, aptDev, sub.ridDel]);
    kit.ding.reset();
    const intentId = await fixIntent(s.pid, U.x1, sub.ridDel);
    const res = await kit.notifier.deliverIntent(intentId);
    assert.strictEqual(res.outcome, 'sent', '收件人 = 开发方负责人 x1，必需确认人与收件人一致、成员在位：发送');
    const pname = await sysName(s.pid);
    const sends = kit.ding.sends().filter((c) => c.markdown.includes(`project=${s.pid}&rev=`));
    assert.strictEqual(sends.length, 1);
    assert.deepStrictEqual(sends[0].userIds, [`ding-u${U.x1}`], '193-L5：钉钉收件人 = 开发方负责人 x1 的钉钉号');
    assert.strictEqual(sends[0].title, '【系统建设记录】待确认');
    assert.strictEqual(sends[0].markdown, `### 【系统建设记录】待确认\n\n**项目**：${pname}\n\n总体规划内容包第 1 版待确认\n\n[打开确认](${BASE_URL}/Sys_Build.html?project=${s.pid}&rev=${sub.ridDel})`, '摘要文案逐字：项目名 + 对象摘要，不是固定文案');
  });

  // ═══════════════════════ 5 改期知会生成与异议（§5）═══════════════════════
  async function effectiveScene() {
    const s = await mkScene({ partyB: true });
    await produceEffectiveOverall(s.pid);
    const mile = await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND is_golive_milestone = 1', [s.pid]);
    const other = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS NOT NULL AND is_golive_milestone = 0 AND status <> 'cancelled' ORDER BY sort_order LIMIT 1", [s.pid]);
    return Object.assign({ mile: mile.id, other: other.id }, s);
  }
  const resched = (nid, end, extra) => post(U.pm, `/sysbuild/nodes/${nid}/schedule`, Object.assign({ kind: 'plan', planned_start: '2026-11-02', planned_end: end, reason: '客户方要求顺延', no_written_evidence: true, no_evidence_reason: '口头沟通后的书面说明补充' }, extra || {}));
  const noticesOf = (pid) => sqlAll("SELECT n.id AS id, n.kind AS kind, n.ref_type AS ref_type, n.ref_id AS ref_id, n.recipient_member_id AS member_id, m.user_id AS user_id FROM sysbuild_notices n JOIN sysbuild_members m ON m.id = n.recipient_member_id WHERE n.project_id = ? AND n.kind = 'schedule_change' ORDER BY n.id", [pid]);

  test(`${T_SCHED}——正式上线里程碑计划结束日期推后 → 每个需求部门现任负责人一条 schedule_change 知会（ref = 改期记录）+ 一条发送意图（schedule_notice）+ 发送结果记 notice_attempts；提前 / 同日 / 非里程碑 / 草稿期计划不知会；知会视图带改前后日期、原因、批次与里程碑名；发送失败时 PM 待办可见`, async () => {
    const kit = kitOrNull();
    if (kit) kit.ding.reset(); // 前面用例中途失败时可能留下的替身状态（失败模式 / gate）不带进来
    // ⓪ 草稿期（项目还没有生效的总体规划）：里程碑计划推后也不知会
    const dr = await mkScene({ partyB: true });
    await planAllNodes(dr.pid);
    const dMile = (await sqlGet('SELECT id FROM sysbuild_nodes WHERE project_id = ? AND is_golive_milestone = 1', [dr.pid])).id;
    assert.strictEqual((await post(U.pm, `/sysbuild/nodes/${dMile}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2027-01-15' })).status, 201);
    assert.deepStrictEqual(await noticesOf(dr.pid), [], '草稿期计划不知会');
    const s = await effectiveScene();
    const { pid } = s;
    const cur = await sqlGet("SELECT planned_start, planned_end FROM sysbuild_node_schedule_records WHERE node_id = ? AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1", [s.mile]);
    assert.strictEqual(cur.planned_end, '2026-11-30');
    // ① 提前、同日（只改开始）、非里程碑推后：都不知会
    assert.strictEqual((await resched(s.mile, '2026-11-20')).status, 201);
    assert.strictEqual((await resched(s.mile, '2026-11-20', { planned_start: '2026-11-03' })).status, 201);
    assert.strictEqual((await resched(s.other, '2026-12-20')).status, 201);
    assert.deepStrictEqual(await noticesOf(pid), [], '提前 / 同日 / 非里程碑不生成');
    // ② 推后：甲部负责人 own、乙部负责人 x1 各一条
    const mark = await lastId(pid);
    const r = await post(U.pm, `/sysbuild/nodes/${s.mile}/schedule`, { kind: 'plan', planned_start: '2026-11-02', planned_end: '2026-12-05', reason: '客户方要求顺延' });
    assert.strictEqual(r.status, 201, r.text);
    const rec = r.body.record_id;
    const ns = await noticesOf(pid);
    assert.deepStrictEqual(ns.map((n) => [n.ref_type, n.ref_id, n.member_id, n.user_id]), [['schedule_record', rec, s.A.mOwn, U.own], ['schedule_record', rec, s.B.mOwn, U.x1]], '每个需求部门的现任负责人一条');
    const rows = await intentsAfter(pid, mark);
    assert.deepStrictEqual(brief(rows), [['schedule_notice', 'notice', U.own], ['schedule_notice', 'notice', U.x1]]);
    assert.deepStrictEqual(rows.map((x) => x.ref_id), ns.map((n) => n.id));
    assert.ok(rows.every((x) => x.status !== 'pending'));
    const attempts = await sqlAll('SELECT notice_id, channel, result, response_code FROM sysbuild_notice_attempts WHERE notice_id IN (?, ?) ORDER BY id', [ns[0].id, ns[1].id]);
    // K3（修订批 1）：成功的发送尝试记渠道返回的消息标识（替身返回 processQueryKey = 'pqk-test'），不再记固定的 'ok'
    if (kit) assert.deepStrictEqual(attempts, [{ notice_id: ns[0].id, channel: 'dingtalk', result: 'sent', response_code: 'pqk-test' }, { notice_id: ns[1].id, channel: 'dingtalk', result: 'sent', response_code: 'pqk-test' }]);
    else assert.deepStrictEqual(attempts.map((a) => a.channel), ['dingtalk', 'dingtalk']);
    const created = (await payloads(pid, 'notice_created')).filter((p) => p.kind === 'schedule_change');
    assert.deepStrictEqual(created.map((p) => [p.record_id, p.before_end, p.after_end, p.recipient_member_id]), [[rec, '2026-11-20', '2026-12-05', s.A.mOwn], [rec, '2026-11-20', '2026-12-05', s.B.mOwn]]);
    if (kit) {
      const sends = kit.ding.sends().filter((c) => c.markdown.includes(`project=${pid}&notice=`));
      assert.strictEqual(sends.length, 2);
      // L7（修订批 1）：改期知会对负责人是知会口吻，与「有事项需要您处理」的确认类文案区分；仍只给固定文案 + 链接，不带日期
      assert.ok(sends.every((c) => c.title === '【系统建设记录】改期知会' && !c.markdown.includes('2026-12-05')), '负责人只给固定文案 + 链接');
      const nlink = (n) => `${BASE_URL}/Sys_Build.html?project=${pid}&notice=${n.id}`;
      assert.deepStrictEqual(sends.map((c) => c.markdown), ns.map((n) => `### 【系统建设记录】改期知会\n\n有一条改期知会，请查看。\n\n[打开查看](${nlink(n)})`), '知会正文逐字');
    }
    // ③ 知会视图：改前后日期、原因、批次与里程碑名；actions.object 为真；非接收人的代表人列不出
    const mine = (await get(U.own, '/sysbuild/my/notices')).body.items.find((i) => i.id === ns[0].id);
    assert.deepStrictEqual([mine.kind, mine.as], ['schedule_change', 'recipient']);
    assert.ok(!('objected' in mine) && !('actions' in mine), 'my/notices 的 items[] 不再有 objected / actions（C6：知会异议随 S7 删除）');
    assert.deepStrictEqual(mine.schedule, {
      record_id: rec, node_id: s.mile, node_name: (await sqlGet('SELECT name FROM sysbuild_nodes WHERE id = ?', [s.mile])).name, batch_id: (await sqlGet('SELECT batch_id FROM sysbuild_nodes WHERE id = ?', [s.mile])).batch_id,
      batch_name: '第 1 批', before: { start: '2026-11-03', end: '2026-11-20' }, after: { start: '2026-11-02', end: '2026-12-05' }, reason: '客户方要求顺延', changed_at: mine.schedule.changed_at,
    });
    assert.ok(!(await get(U.del, '/sysbuild/my/notices')).body.items.some((i) => i.id === ns[0].id), '不是接收人的代表人列不出这条知会');
    // ⑤ 发送失败 → 知会照常生成、改期不受影响；PM 待办 send_failed 可见（进程内：让钉钉报错）
    if (kit) {
      kit.ding.reset(); kit.ding.state.sendMode = 'errcode';
      const mark3 = await lastId(pid);
      const r3 = await resched(s.mile, '2026-12-12');
      assert.strictEqual(r3.status, 201, '发送失败不影响改期');
      kit.ding.reset();
      const rows3 = await intentsAfter(pid, mark3);
      assert.ok(rows3.length === 2 && rows3.every((x) => x.status === 'failed' && x.attempts === 1), JSON.stringify(rows3));
      const failedAtt = await sqlAll("SELECT result FROM sysbuild_notice_attempts WHERE notice_id IN (SELECT ref_id FROM sysbuild_send_intents WHERE id IN (?, ?)) ORDER BY id", [rows3[0].id, rows3[1].id]);
      assert.deepStrictEqual(failedAtt.map((a) => a.result), ['failed', 'failed']);
      const sf = (await get(U.pm, '/sysbuild/my/todo')).body.items.send_failed.filter((i) => i.project_id === pid).map((i) => i.intent_id);
      assert.ok(rows3.every((x) => sf.includes(x.id)), 'PM 待办看到失败的发送');
      // 有发送意图的失败按意图计，不会再当「没有意图的失败尝试」重复计入（NOT EXISTS 判据）
      assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}/send-intents`)).body.failed_count, rows3.length, '失败的意图不重复计数');
    }
    // ⑥ 改期知会生成时跳过没有现任负责人的部门（notify-schedule.js 现任负责人取数；接替整删的异议用例里的同一断言，全仓唯一）：
    //   先记下改期前的最大知会编号，乙部负责人任职结束后再次推后，只按「新增知会编号 > maxId」断言新增 1 条、收件人是甲部现任负责人（不用绝对数）
    const maxId = (await noticesOf(pid)).reduce((m, n) => Math.max(m, n.id), 0);
    const aptB = await sqlGet("SELECT id FROM sysbuild_appointments WHERE party_id = ? AND status = 'active'", [s.B.party]);
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${aptB.id}/end`, { reason: '负责人调离' })).status, 200);
    const r6 = await resched(s.mile, '2026-12-28');
    assert.strictEqual(r6.status, 201, r6.text);
    const fresh = (await noticesOf(pid)).filter((n) => n.id > maxId);
    assert.deepStrictEqual(fresh.map((n) => [n.member_id, n.user_id]), [[s.A.mOwn, U.own]], '乙部已无现任负责人：只给甲部现任负责人生成 1 条知会');
  });

  // ═══════════════════════ 5b 修订批 1：发送前复核收件人资格（K1）、决策人就是 PM、代录决策、邀请 / 授权跳过分支（L5 / L6）═══════════════════════
  test(`${T_STALE}——（K1）补发 / 扫描 / 首次发送都在外发前复核收件人此刻仍有资格（与站内「待我确认」同一个函数）：移出成员、换 PM、换代表人、停用账号四种情形补发时各自 skipped（status sent、attempts 不变、last_error「无需发送：…」）且外发 0 次，同一次补发里没变化的对照意图照常发；不认可通知在改发后跳过；改期知会的接收人被移出 / 不再是现任负责人 / 账号与知会不符同样跳过`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    try { await staleCases(ding); } finally { await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', U.del]); ding.reset(); }
    return undefined;
  });
  async function staleCases(ding) {
    const sendsTo = (uid) => ding.sends().filter((c) => c.userIds[0] === `ding-u${uid}`).length;
    const resendBy = async (uid, pid) => {
      ding.reset();
      const r = await post(uid, `/sysbuild/projects/${pid}/send-intents/resend`);
      assert.strictEqual(r.status, 200, r.text);
      return r;
    };
    const outcomeOf = (r, id) => r.body.results.find((x) => x.id === id);
    const expectSkipped = async (r, id, re, attemptsBefore, label) => {
      const o = outcomeOf(r, id);
      assert.strictEqual(o && o.outcome, 'skipped', `${label}：${JSON.stringify(o)}`);
      const row = await intentRow(id);
      assert.deepStrictEqual([row.status, row.attempts], ['sent', attemptsBefore], `${label}：status sent、attempts 不变`);
      assert.ok(row.last_error.startsWith('无需发送：') && re.test(row.last_error), `${label}：${row.last_error}`);
    };
    const expectSent = async (r, id, attemptsBefore, label) => {
      assert.strictEqual(outcomeOf(r, id).outcome, 'sent', label);
      assert.deepStrictEqual([(await intentRow(id)).status, (await intentRow(id)).attempts], ['sent', attemptsBefore + 1], label);
    };
    // ① 移出成员：代表人 del 被移出项目（级联结束其授权）→ 他的失败意图补发时跳过；负责人 own 的对照意图照常发
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      const iDel = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      const iOwn = await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1, lastError: '旧失败' });
      // 收件人不是所引用修订的必需确认人（意图写给 own、引用的却是 del 的修订）：跳过——收件人 own 本身资格完好，只有「必需确认人就是收件人」这一条能拦下它
      const iMis = await fixIntent(s.pid, U.own, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberIdOf(s.pid, U.del)}/remove`, { reason: '调离' })).status, 200);
      const r = await resendBy(U.pm, s.pid);
      assert.deepStrictEqual([r.body.counts.total, r.body.counts.sent, r.body.counts.skipped], [3, 1, 2]);
      await expectSkipped(r, iDel, /收件人此刻不能作出确认：收件人看不到该项目/, 1, '移出成员');
      await expectSkipped(r, iMis, /收件人已不是该修订的必需确认人/, 1, '收件人不是必需确认人');
      await expectSent(r, iOwn, 1, '对照：负责人照常发');
      assert.deepStrictEqual([sendsTo(U.del), sendsTo(U.own)], [0, 1], '移出成员：外发 0 次；对照 1 次（写给 own 但引用别人修订的那条不外发）');
    }
    // ② 换 PM：代表人不认可 → PM 收到 decision_objected（发送失败）→ admin 换了 PM → 原 PM 的意图补发（新 PM 触发）时跳过，外发 0 次
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      ding.reset(); ding.state.sendMode = 'errcode';
      const mark = await lastId(s.pid);
      assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
      const iPm = (await intentsAfter(s.pid, mark)).find((x) => x.purpose === 'decision_objected');
      assert.deepStrictEqual([iPm.recipient_user_id, iPm.status, iPm.attempts], [U.pm, 'failed', 1], '前置：通知原 PM 的意图发送失败');
      const ch = await post(U.admin, `/sysbuild/projects/${s.pid}/pm`, { pm_user_id: U.cand, reason: '换 PM 用例' });
      assert.strictEqual(ch.status, 200, ch.text);
      const r = await resendBy(U.cand, s.pid);
      await expectSkipped(r, iPm.id, /收件人已不是本项目现任项目经理/, 1, '换 PM');
      assert.strictEqual(sendsTo(U.pm), 0, '换 PM：外发 0 次');
    }
    // ③ 换代表人：负责人提议并由 m1 接受新的代表人授权 → 原代表人 del 的授权被撤销 → 他的失败意图补发时跳过
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      const iDel = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      const iOwn = await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1, lastError: '旧失败' });
      await changeRepresentative(s, U.m1);
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iDel, /收件人此刻不能作出确认.*负责人授权已不再生效/, 1, '换代表人');
      await expectSent(r, iOwn, 1, '对照：负责人照常发');
      assert.deepStrictEqual([sendsTo(U.del), sendsTo(U.own)], [0, 1], '换代表人：外发 0 次；对照 1 次');
    }
    // ④ 停用账号：收件人账号 status 不是 active → 外发 0 次，记 failed（P186：可恢复的条件不记「无需发送」终态，attempts + 1、last_error 写原因、可被补发 / 扫描重试）；账号恢复后同一条意图再补发送出
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      const iDel = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['disabled', U.del]);
      const r = await resendBy(U.pm, s.pid);
      const od = outcomeOf(r, iDel);
      assert.deepStrictEqual([od.outcome, od.reason, r.body.aborted], ['failed', 'user_disabled', null], '停用账号：failed，不是 skipped；单个收件人的问题，不是系统性失败，不中止补发');
      const rowD = await intentRow(iDel);
      assert.deepStrictEqual([rowD.status, rowD.attempts], ['failed', 2], '停用账号：状态仍 failed、attempts + 1');
      assert.ok(rowD.last_error.includes('收件人账号已停用'), rowD.last_error);
      assert.strictEqual(sendsTo(U.del), 0, '停用账号：外发 0 次');
      await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', U.del]);
      const r2 = await resendBy(U.pm, s.pid);
      await expectSent(r2, iDel, 2, '账号恢复后，原来那条意图经补发送出');
    }
    // ⑤ 不认可通知：PM 把被不认可的任务改发后，旧修订的 decision_objected 补发时跳过（修订已不是任务最新修订）；未改发的对照意图照常发
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      ding.reset(); ding.state.sendMode = 'errcode';
      const mark = await lastId(s.pid);
      assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
      assert.strictEqual((await openAndDecide(U.own, sub.tidOwn, 'object')).status, 200);
      const objs = (await intentsAfter(s.pid, mark)).filter((x) => x.purpose === 'decision_objected');
      assert.strictEqual(objs.length, 2, '前置：两条通知 PM 的意图（都失败）');
      const iDel = objs.find((x) => x.ref_id === sub.ridDel);
      const iOwn = objs.find((x) => x.ref_id === sub.ridOwn);
      assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidDel}/reissue`, { reason: '重新发给代表人' })).status, 200);
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iDel.id, /该确认已改发/, 1, '不认可后已改发');
      await expectSent(r, iOwn.id, 1, '对照：未改发的有异议照常通知 PM');
      assert.strictEqual(sendsTo(U.pm), 1, '改发后：只外发对照那一条');
    }
    // ⑤b 修订已被改发而旧修订仍显示待确认（防御：改发正常会把旧修订关掉；夹具把旧修订写回 pending，只剩「不是该任务最新修订」这一条能拦下）
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      assert.strictEqual((await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidDel}/reissue`, { reason: '重新发给代表人' })).status, 200);
      // 先把新修订关掉（同一任务同时只能有一条待确认修订），再把旧修订写回 pending
      await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'superseded', status_reason = '夹具' WHERE task_id = ? AND rev_no = 2", [sub.tidDel]);
      await sqlRun("UPDATE sysbuild_confirm_task_revisions SET status = 'pending', status_reason = NULL WHERE id = ?", [sub.ridDel]);
      const iOld = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iOld, /修订已被改发/, 1, '旧修订已被改发');
    }
    // ⑤c 项目状态不允许作出这项确认：项目已终止而修订仍显示待确认（夹具直接把项目状态写成已终止，绕开终止时对待确认修订的失效处理，只剩状态判定能拦下）→ 跳过
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      const iDel = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      await sqlRun("UPDATE sysbuild_projects SET status = 'terminated' WHERE id = ?", [s.pid]);
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iDel, /项目当前状态不允许作出这项确认/, 1, '项目已终止');
      assert.strictEqual(sendsTo(U.del), 0);
    }
    // ⑤e 不认可 / 有异议通知：被不认可的内容包版本之后被撤回（版本 pending → superseded）→ 异议 / 不认可已处理，补发时跳过
    //   （原载体 = 结论确认任务 + PM 重新给结论，随 C6 删；declinedStillOpen 的 package_version 分支保留：v.status === 'pending' 才仍待处理。⑤d 办理结论确认按 resolve 类判随结论确认任务整块删）
    {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      ding.reset(); ding.state.sendMode = 'errcode';
      const mark = await lastId(s.pid);
      assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
      const iObj = (await intentsAfter(s.pid, mark)).find((x) => x.purpose === 'decision_objected');
      assert.strictEqual(iObj.status, 'failed', '前置：通知 PM 的意图失败');
      const r0 = await resendBy(U.pm, s.pid); // 版本仍待确认：不认可仍待处理 → 照常发（对照）
      await expectSent(r0, iObj.id, 1, '对照：不认可仍待处理时照常通知 PM');
      const iObj2 = await fixIntent(s.pid, U.pm, iObj.ref_id, { purpose: 'decision_objected', status: 'failed', attempts: 1, lastError: '旧失败' });
      const wd = await post(U.pm, `/sysbuild/package-versions/${sub.pv}/withdraw`, { reason: '撤回后不再处理该不认可' });
      assert.strictEqual(wd.status, 200, wd.text);
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [sub.pv])).status, 'superseded', '前置：版本 pending → superseded');
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iObj2, /异议 \/ 不认可已处理/, 1, '版本已撤回');
    }
    // ⑥ 改期知会：接收人 own 被移出（A 部）→ 跳过；B 部负责人 x1 未变 → 照常发
    {
      const s = await effectiveScene();
      ding.reset(); ding.state.sendMode = 'errcode';
      assert.strictEqual((await resched(s.mile, '2026-12-05')).status, 201);
      ding.reset();
      const [nA, nB] = await noticesOf(s.pid);
      const iA = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nA.id])).id;
      const iB = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nB.id])).id;
      assert.deepStrictEqual([(await intentRow(iA)).status, (await intentRow(iB)).status], ['failed', 'failed'], '前置：两条知会意图发送失败');
      assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberIdOf(s.pid, U.own)}/remove`, { reason: '调离' })).status, 200);
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iA, /接收人已不是本项目成员/, 1, '知会：接收人被移出');
      await expectSent(r, iB, 1, '对照：B 部负责人照常发');
      assert.deepStrictEqual([sendsTo(U.own), sendsTo(U.x1)], [0, 1]);
    }
    // ⑦ 改期知会：B 部换了现任负责人（x1 仍是成员但不再是现任）→ 跳过；账号与知会不符（意图收件人 ≠ 接收人成员的账号）→ 跳过；A 部照常发
    {
      const s = await effectiveScene();
      ding.reset(); ding.state.sendMode = 'errcode';
      assert.strictEqual((await resched(s.mile, '2026-12-05')).status, 201);
      ding.reset();
      const [nA, nB] = await noticesOf(s.pid);
      const iA = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nA.id])).id;
      const iB = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nB.id])).id;
      const swapped = await api(U.pm, 'PUT', `/sysbuild/parties/${s.B.party}/people`, {
        leader_user_id: U.x3, representative_user_id: U.x2, expected_appointment_id: s.B.apt, expected_delegation_id: s.B.dlg, reason: '变更领导',
      });
      assert.strictEqual(swapped.status, 200, swapped.text);
      const iMismatch = await fixIntent(s.pid, U.x2, nA.id, { purpose: 'schedule_notice', refType: 'notice', status: 'failed', attempts: 1, lastError: '旧失败' });
      const r = await resendBy(U.pm, s.pid);
      await expectSkipped(r, iB, /接收人已不是该参与方的现任负责人/, 1, '知会：换了现任负责人');
      await expectSkipped(r, iMismatch, /接收人账号与知会不符/, 1, '知会：账号不符');
      await expectSent(r, iA, 1, '对照：A 部负责人照常发');
      assert.deepStrictEqual([sendsTo(U.x1), sendsTo(U.x2), sendsTo(U.own)], [0, 0, 1]);
    }
  }

  test(`${T_NOPM}——（L6）作出有异议 / 不认可决策的人本人就是项目 PM 时不写 decision_objected（不通知自己）；其他成员作同样的决策仍通知 PM`, async () => {
    // #212 C7：原载体是 PM 本人 / 成员 m1 作提出人的条目任务（随需求条目流程删除）；改用内容包任务，夹具把当前修订的必需确认人改成 PM 本人 / m1（依据清空，同「C4a 失资格（L2）」）。
    const s = await mkScene();
    const { pid } = s;
    const sub = await submitOverall(pid);
    const pmRow = await memberIdOf(pid, U.pm);
    const retarget = (rid, memberId) => sqlRun('UPDATE sysbuild_confirm_task_revisions SET required_member_id = ?, basis_appointment_id = NULL, basis_delegation_id = NULL WHERE id = ?', [memberId, rid]);
    // PM 本人是必需确认人：PM 对自己的任务不认可 → 没有 decision_objected
    await retarget(sub.ridOwn, pmRow);
    let mark = await lastId(pid);
    assert.strictEqual((await openAndDecide(U.pm, sub.tidOwn, 'reject')).status, 200);
    assert.deepStrictEqual(await intentsAfter(pid, mark), [], 'PM 自己作出的决策不通知 PM');
    // 对照：另一成员 m1 是必需确认人，他不认可 → 通知 PM
    await retarget(sub.ridDel, s.mM1);
    mark = await lastId(pid);
    assert.strictEqual((await openAndDecide(U.m1, sub.tidDel, 'reject')).status, 200);
    assert.deepStrictEqual(brief(await intentsAfter(pid, mark)), [['decision_objected', 'confirm_revision', U.pm]]);
  });

  const quietLogger = { info() {}, warn() {}, error() {} };
  const mkNotifier = (kit, extra) => require(kit.modulePath()).createNotifier(Object.assign({
    db: kit.db, logger: quietLogger, dingtalkNotify: kit.ding.api, getSystemConfig: kit.ding.getSystemConfig, readonlyIds: kit.readonlyIds, backgroundJobs: false,
  }, extra || {}));
  const pmOp = () => ({ id: U.pm, display_name: '项目经理' });
  const settleAll = async (kit) => { await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent' WHERE status IN ('pending', 'failed')", []); kit.ding.reset(); };

  test(`${T_SCANBATCH}——（M1）就绪扫描按 id 游标分批处理（每批条数可注入，用例设 2），积压超过一批时末尾的意图也被处理；批间让出事件循环；本轮内失败的意图不重复重试（游标只前进）`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const small = mkNotifier(kit, { scanBatchCap: 2 });
      const ids = [];
      for (let i = 0; i < 5; i += 1) ids.push(await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null }));
      const res = await small.scan();
      assert.deepStrictEqual([res.total, res.sent], [5, 5], '积压 5 条、每批 2 条：三批都处理，末尾的也发出');
      for (const id of ids) assert.deepStrictEqual([(await intentRow(id)).status, (await intentRow(id)).attempts], ['sent', 1]);
      assert.strictEqual(ding.sends().length, 5);
      // 批间让出事件循环：5 条积压、每批 2 条 = 3 批，批间各让出一次（setImmediate 调用 ≥ 2 次；底层 sqlite 驱动与本模块其余路径不调 setImmediate，没有让出时是 0 次）
      await settleAll(kit);
      for (let i = 0; i < 5; i += 1) await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null });
      const origImmediate = global.setImmediate;
      let immCalls = 0;
      global.setImmediate = (...a) => { immCalls += 1; return origImmediate(...a); };
      try {
        await small.scan();
      } finally {
        global.setImmediate = origImmediate;
      }
      assert.ok(immCalls >= 2, `批间让出：setImmediate 调用 ${immCalls} 次`);
      // 本轮内失败的意图不重复重试：3 条 pending、每批 2 条，发送全部失败 → 每条只试一次（attempts 1），不会因为仍是 failed 且 attempts < 3 被同一轮再次取到
      await settleAll(kit);
      const fl = [];
      for (let i = 0; i < 3; i += 1) fl.push(await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null }));
      ding.reset(); ding.state.sendMode = 'errcode';
      const r2 = await small.scan();
      assert.deepStrictEqual([r2.total, r2.failed], [3, 3], '三条各试一次');
      for (const id of fl) assert.deepStrictEqual([(await intentRow(id)).status, (await intentRow(id)).attempts], ['failed', 1], '本轮不重复重试');
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_RESENDCAP}——（M3）补发 remaining = 候选总数 − 本次已处理（同一读快照另查总数，单次上限可注入，用例设 2）：5 条候选分三次补完（remaining 3 → 1 → 0）；首条即系统性失败中止时按总数算（4 条候选只试 1 条 → remaining 3）`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const cap2 = mkNotifier(kit, { resendBatchCap: 2 });
      for (let i = 0; i < 5; i += 1) await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      const a = await cap2.resendProject(s.pid, pmOp());
      assert.deepStrictEqual([a.counts.total, a.counts.sent, a.counts.remaining], [2, 2, 3]);
      const b = await cap2.resendProject(s.pid, pmOp());
      assert.deepStrictEqual([b.counts.total, b.counts.remaining], [2, 1]);
      const c = await cap2.resendProject(s.pid, pmOp());
      assert.deepStrictEqual([c.counts.total, c.counts.remaining], [1, 0]);
      // 首条即中止：4 条候选，取令牌失败 → 只试 1 条，remaining = 4 - 1
      const s2 = await mkScene();
      const sub2 = await submitOverall(s2.pid);
      await settleAll(kit);
      for (let i = 0; i < 4; i += 1) await fixIntent(s2.pid, U.del, sub2.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
      ding.reset(); ding.state.tokenError = Object.assign(new Error('gettoken failed: errcode=40001 errmsg=bad'), { errcode: 40001, errmsg: 'bad' });
      const d = await cap2.resendProject(s2.pid, pmOp());
      assert.deepStrictEqual([d.counts.total, d.counts.failed, d.counts.remaining], [1, 1, 3], '首条即中止：remaining 按候选总数算');
      assert.ok(d.aborted && /^gettoken_/.test(d.aborted.reason));
      // 端点（默认上限 100）：候选 ≤ 上限时 remaining 为 0
      ding.reset();
      const ep = await post(U.pm, `/sysbuild/projects/${s2.pid}/send-intents/resend`);
      assert.deepStrictEqual([ep.body.counts.total, ep.body.counts.remaining], [4, 0]);
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_TRAIL}——（M4）令牌失效后重发：两次渠道调用的脱敏结果都记入 send_intent_attempted 事件的 response.channel_results（首次 token_expired + 重发成功 / 刷新令牌失败），一次 deliverIntent 计 1 次 attempts；改期知会的 notice_attempts 只记最终结果；普通发送只有一条`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const evOf = async (id) => (await payloads(s.pid, 'send_intent_attempted')).filter((p) => p.intent_id === id).pop();
      // ① 重发成功
      ding.reset(); ding.state.sendMode = 'token_expired_once';
      const i1 = await fixIntent(s.pid, U.del, sub.ridDel);
      assert.strictEqual((await notifier.deliverIntent(i1)).outcome, 'sent');
      const e1 = await evOf(i1);
      assert.deepStrictEqual(e1.response.channel_results, [
        { stage: 'send', outcome: 'failed', reason: 'token_expired', errcode: 42001, process_query_key: null },
        { stage: 'retry', outcome: 'ok', reason: 'ok', errcode: null, process_query_key: 'pqk-test' },
      ]);
      assert.deepStrictEqual([e1.attempts_after, (await intentRow(i1)).attempts, e1.response.process_query_key], [1, 1, 'pqk-test'], '一次 deliverIntent 计 1 次 attempts');
      // ② 刷新令牌失败
      ding.reset(); ding.state.sendMode = 'token_expired_refresh_fail';
      const i2 = await fixIntent(s.pid, U.del, sub.ridDel);
      const r2 = await notifier.deliverIntent(i2);
      assert.deepStrictEqual([r2.outcome, (await intentRow(i2)).status, (await intentRow(i2)).attempts], ['failed', 'failed', 1]);
      const e2 = await evOf(i2);
      assert.deepStrictEqual(e2.response.channel_results.map((x) => [x.stage, x.outcome, x.reason]), [['send', 'failed', 'token_expired'], ['refresh_token', 'failed', 'other:40001']]);
      assert.strictEqual(JSON.stringify(e2).includes(SECRETS[3]), false, '事件不含令牌');
      // ③ 普通发送只有一条
      ding.reset();
      const i3 = await fixIntent(s.pid, U.del, sub.ridDel);
      await notifier.deliverIntent(i3);
      assert.deepStrictEqual((await evOf(i3)).response.channel_results, [{ stage: 'send', outcome: 'ok', reason: 'ok', errcode: null, process_query_key: 'pqk-test' }]);
      // ④ 改期知会：notice_attempts 只记最终结果（一行 sent），事件记全部（两条）
      const es = await effectiveScene();
      ding.reset(); ding.state.sendMode = 'token_expired_once';
      const mark = await lastId(es.pid);
      assert.strictEqual((await resched(es.mile, '2026-12-05')).status, 201);
      ding.reset();
      const nrow = (await noticesOf(es.pid))[0];
      const att = await sqlAll('SELECT result, response_code FROM sysbuild_notice_attempts WHERE notice_id = ?', [nrow.id]);
      assert.deepStrictEqual(att, [{ result: 'sent', response_code: 'pqk-test' }], 'notice_attempts 只记最终结果');
      const sIntent = (await intentsAfter(es.pid, mark)).find((x) => x.ref_id === nrow.id);
      const eN = (await payloads(es.pid, 'send_intent_attempted')).filter((p) => p.intent_id === sIntent.id).pop();
      assert.strictEqual(eN.response.channel_results.length, 2, '事件记全部尝试');
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_IDLE}——（L1）whenIdle 统一跟踪在途发送：直接启动 deliverIntent / resendProject / scan（不经 dispatch）后，whenIdle 等到它们结束才返回`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const releases = [];
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
      const probe = async (label, start, setup, after) => {
        ding.reset();
        let release;
        ding.state.gate = new Promise((r) => { release = r; });
        releases.push(() => release());
        if (setup) await setup();
        const p = start();
        for (let i = 0; i < 1000 && ding.sends().length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
        assert.strictEqual(ding.sends().length, 1, `${label}：已进入发送`);
        let idle = false;
        const w = notifier.whenIdle().then(() => { idle = true; });
        await flush();
        assert.strictEqual(idle, false, `${label}：发送还在途，whenIdle 不能返回`);
        if (after) {
          // 两条意图的工作：第一条放行后立刻给第二条换一道新闸门，让第二条停在「发送中」；此时整个工作还没做完，whenIdle 仍不能返回（不能只等到第一条发完）
          let release2;
          ding.state.gate = new Promise((r) => { release2 = r; });
          releases.push(() => release2());
          release();
          for (let i = 0; i < 1000 && ding.sends().length < 2; i += 1) await new Promise((r) => setTimeout(r, 5));
          assert.strictEqual(ding.sends().length, 2, `${label}：第二条也进入发送`);
          await flush();
          assert.strictEqual(idle, false, `${label}：第一条发完、第二条在途，whenIdle 仍不能返回`);
          release2();
        } else {
          release();
        }
        await w;
        if (after) await after();
        await p;
        assert.strictEqual(idle, true, `${label}：发送结束后 whenIdle 返回`);
      };
      const i1 = await fixIntent(s.pid, U.del, sub.ridDel);
      await probe('deliverIntent', () => notifier.deliverIntent(i1));
      assert.strictEqual((await intentRow(i1)).status, 'sent');
      const two = [];
      await probe('resendProject', () => notifier.resendProject(s.pid, pmOp()), async () => {
        two.length = 0;
        for (let i = 0; i < 2; i += 1) two.push(await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' }));
      }, async () => {
        for (const id of two) assert.strictEqual((await intentRow(id)).status, 'sent', 'resendProject：whenIdle 返回时两条都已处理（不只是第一条）');
      });
      const two2 = [];
      await probe('scan', () => notifier.scan(), async () => {
        two2.length = 0;
        for (let i = 0; i < 2; i += 1) two2.push(await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null }));
      }, async () => {
        for (const id of two2) assert.strictEqual((await intentRow(id)).status, 'sent', 'scan：whenIdle 返回时两条都已处理（不只是第一条）');
      });
    } finally {
      for (const f of releases) f();
      await notifier.whenIdle();
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_SYSTEMIC}——（LOW-b）限流（errcode 90018）、应用未开通权限（60011）、机器人编码无效（batchSend 返回 code / message）都是系统性失败，补发遇到即中止本批；对照：收件人失效（88002）不中止`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const url = `/sysbuild/projects/${s.pid}/send-intents/resend`;
      const three = [];
      for (let i = 0; i < 3; i += 1) three.push(await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' }));
      ding.reset(); ding.state.sendMode = 'errcode'; ding.state.sendErrcode = 88002;
      const c0 = await post(U.pm, url);
      assert.deepStrictEqual([c0.body.counts.total, c0.body.aborted], [3, null], '对照：收件人失效不中止');
      const cases = [
        ['限流 90018', (st) => { st.sendMode = 'errcode'; st.sendErrcode = 90018; }, 'send_rate_limit'],
        ['未开通权限 60011', (st) => { st.sendMode = 'errcode'; st.sendErrcode = 60011; }, 'send_no_scope'],
        ['机器人编码无效', (st) => { st.sendMode = 'robot_invalid'; }, 'robot_code_invalid'],
      ];
      // 修订批 3（N1）：每次中止时被试的是「最近尝试最早」的那条——轮转 three[0]、three[1]、three[2]
      for (const [i, [label, setup, reason]] of cases.entries()) {
        ding.reset(); setup(ding.state);
        const x = await post(U.pm, url);
        assert.strictEqual(x.status, 200, x.text);
        assert.deepStrictEqual([x.body.counts.total, x.body.counts.remaining, x.body.aborted && x.body.aborted.reason, x.body.aborted && x.body.aborted.intent_id], [1, 2, reason, three[i]], `${label}：系统性失败，只试一条`);
      }
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_DISABLED}——（P186）发送前复核里可恢复的条件（收件人账号停用）记 failed 而不是「无需发送」终态：首次发送失败（attempts + 1、last_error 写原因、外发 0 次），账号恢复后经补发送出；其余资格丢失（移出成员）仍是跳过`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const id = await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null });
      await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['disabled', U.del]);
      const r1 = await notifier.deliverIntent(id);
      assert.deepStrictEqual([r1.outcome, r1.reason, (await intentRow(id)).status, (await intentRow(id)).attempts], ['failed', 'user_disabled', 'failed', 1]);
      assert.ok((await intentRow(id)).last_error.includes('收件人账号已停用'));
      assert.strictEqual(ding.sends().length, 0);
      const ev = (await payloads(s.pid, 'send_intent_attempted')).filter((p) => p.intent_id === id).pop();
      assert.deepStrictEqual([ev.outcome, ev.to_status, ev.attempts_after], ['failed', 'failed', 1]);
      await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', U.del]);
      const sc = await notifier.scan();
      assert.ok(sc.results.some((x) => x.id === id && x.outcome === 'sent'), '账号恢复后，就绪扫描也能把它送出（还没满 3 次）');
      assert.deepStrictEqual([(await intentRow(id)).status, (await intentRow(id)).attempts], ['sent', 2]);
    } finally {
      await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', U.del]);
      await settleAll(kit);
    }
    return undefined;
  });

  // ═══════════════════════ 5d 修订批 3：codex 28-R（N1–N3）与预筛 3（MED-B、LOW-1–3）═══════════════════════
  test(`${T_DISCOMBO}——（预筛 MED-B）发送前复核先按与账号状态无关的条件判永久失格：账号停用叠加「成员已移出 / 代表人授权失效 / 修订已确认 / 修订已改发给别人 / 前任 PM / 改期知会接收人已移出」都记跳过（status sent、attempts 不变）且外发 0 次，账号恢复后也不会再发；对照：只是账号停用（确认类、改期知会）→ failed（可恢复，P186 口径不变）`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const setStatus = (uid, st) => sqlRun('UPDATE users SET status = ? WHERE id = ?', [st, uid]);
    const touched = new Set();
    const disable = async (uid) => { touched.add(uid); await setStatus(uid, 'disabled'); };
    const restore = async (uid) => setStatus(uid, 'active');
    const expectSkip = async (label, id, re, attemptsBefore) => {
      ding.reset();
      const r = await notifier.deliverIntent(id);
      assert.strictEqual(r.outcome, 'skipped', `${label}：${JSON.stringify(r)}`);
      const row = await intentRow(id);
      assert.deepStrictEqual([row.status, row.attempts], ['sent', attemptsBefore], `${label}：status sent、attempts 不变`);
      assert.ok(row.last_error.startsWith('无需发送：') && re.test(row.last_error), `${label}：${row.last_error}`);
      assert.strictEqual(ding.sends().length, 0, `${label}：外发 0 次`);
    };
    const expectFailedDisabled = async (label, id, attemptsBefore) => {
      ding.reset();
      const r = await notifier.deliverIntent(id);
      assert.deepStrictEqual([r.outcome, r.reason], ['failed', 'user_disabled'], `${label}：${JSON.stringify(r)}`);
      const row = await intentRow(id);
      assert.deepStrictEqual([row.status, row.attempts], ['failed', attemptsBefore + 1], `${label}：failed、attempts + 1`);
      assert.ok(row.last_error.includes('收件人账号已停用'), row.last_error);
      assert.strictEqual(ding.sends().length, 0, `${label}：外发 0 次`);
    };
    try {
      // 对照 C1：只是账号停用（确认类，修订仍待确认、成员仍在、授权仍生效）→ failed；恢复后补发送出
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
        await disable(U.del);
        await expectFailedDisabled('对照 C1 只是账号停用（确认类）', id, 1);
        await restore(U.del);
        ding.reset();
        assert.strictEqual((await notifier.deliverIntent(id)).outcome, 'sent', '对照 C1：账号恢复后送出');
      }
      // X1 停用 + 成员已移出（项目对收件人不可见）
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
        assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberIdOf(s.pid, U.del)}/remove`, { reason: '调离' })).status, 200);
        await disable(U.del);
        await expectSkip('X1 停用 + 成员已移出', id, /收件人此刻不能作出确认：收件人看不到该项目/, 1);
        await restore(U.del);
        ding.reset();
        const again = await post(U.pm, `/sysbuild/projects/${s.pid}/send-intents/resend`);
        assert.strictEqual(again.status, 200, again.text);
        assert.strictEqual(ding.sends().length, 0, 'X1：账号恢复后补发也不再发这条');
      }
      // X1b 停用 + 代表人授权已失效（项目仍可见、成员仍在：走到资格复核第二层「依据的授权不再生效」）
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
        await changeRepresentative(s, U.m1);
        await disable(U.del);
        await expectSkip('X1b 停用 + 代表人授权失效', id, /收件人此刻不能作出确认.*负责人授权已不再生效/, 1);
        await restore(U.del);
      }
      // X2 停用 + 修订已确认
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'confirm')).status, 200);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
        await disable(U.del);
        await expectSkip('X2 停用 + 修订已确认', id, /修订已不是待确认/, 1);
        await restore(U.del);
      }
      // X3 停用 + 修订已改发给别人（代表人换成 m1，PM 把任务改发给新代表人）
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' });
        await changeRepresentative(s, U.m1);
        const rs = await post(U.pm, `/sysbuild/confirm-tasks/${sub.tidDel}/reissue`, { reason: '改发给新代表人' });
        assert.strictEqual(rs.status, 200, rs.text);
        await disable(U.del);
        await expectSkip('X3 停用 + 修订已改发给别人', id, /修订已不是待确认/, 1);
        await restore(U.del);
      }
      // X4 停用的前任 PM + PM 已更换（有异议通知的收件人）
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        ding.reset(); ding.state.sendMode = 'errcode';
        const mark = await lastId(s.pid);
        assert.strictEqual((await openAndDecide(U.del, sub.tidDel, 'reject')).status, 200);
        const iPm = (await intentsAfter(s.pid, mark)).find((x) => x.purpose === 'decision_objected');
        assert.deepStrictEqual([iPm.recipient_user_id, iPm.status, iPm.attempts], [U.pm, 'failed', 1], '前置：通知原 PM 的意图发送失败');
        assert.strictEqual((await post(U.admin, `/sysbuild/projects/${s.pid}/pm`, { pm_user_id: U.cand, reason: '换 PM 用例' })).status, 200);
        await disable(U.pm);
        try {
          await expectSkip('X4 停用的前任 PM', iPm.id, /收件人已不是本项目现任项目经理/, 1);
        } finally {
          await restore(U.pm);
        }
      }
      // X5 + 对照 C2：改期知会——接收人 own 被移出又停用 → 跳过；B 部负责人 x1 只是账号停用 → failed
      {
        const s = await effectiveScene();
        ding.reset(); ding.state.sendMode = 'errcode';
        assert.strictEqual((await resched(s.mile, '2026-12-05')).status, 201);
        ding.reset();
        const [nA, nB] = await noticesOf(s.pid);
        const iA = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nA.id])).id;
        const iB = (await sqlGet("SELECT id FROM sysbuild_send_intents WHERE purpose = 'schedule_notice' AND ref_id = ?", [nB.id])).id;
        assert.deepStrictEqual([(await intentRow(iA)).status, (await intentRow(iB)).status], ['failed', 'failed'], '前置：两条知会意图发送失败');
        assert.strictEqual((await post(U.pm, `/sysbuild/members/${await memberIdOf(s.pid, U.own)}/remove`, { reason: '调离' })).status, 200);
        await disable(U.own);
        await disable(U.x1);
        await expectSkip('X5 停用 + 知会接收人已移出', iA, /接收人已不是本项目成员/, 1);
        await expectFailedDisabled('对照 C2 知会接收人只是账号停用', iB, 1);
        await restore(U.own);
        await restore(U.x1);
        ding.reset();
        assert.strictEqual((await notifier.deliverIntent(iB)).outcome, 'sent', '对照 C2：账号恢复后送出');
        assert.strictEqual((await notifier.deliverIntent(iA)).outcome, 'already_sent', 'X5：被跳过的那条已是终态，账号恢复后也不再发');
      }
    } finally {
      for (const uid of touched) await restore(uid);
      ding.reset();
    }
    return undefined;
  });

  test(`${T_RECHECK}——（codex N3）每次实际调用钉钉发送前重新复核资格：取令牌期间 / 手机号反查期间 / 令牌刷新期间收件人被移出 → 跳过、不外发（刷新令牌期间不发第二次，首次令牌失效的留痕保留）；账号停用 → failed；意图被别处处理 / 删除 → 不发；复核后重算消息（期间成为需求部门负责人 → 首次与重试都只给固定文案 + 链接）；对照：期间无变化照发`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const touched = new Set();
    const evOf = async (pid, id) => (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === id).pop();
    const tokenCalls = () => ding.calls.filter((c) => c.api === 'getAccessToken').length;
    const newCase = async () => {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const id = await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null });
      return { s, sub, id, pid: s.pid, memDel: await memberIdOf(s.pid, U.del) };
    };
    // 钩子在发送流程中途被调用：不能走 HTTP 端点（夹具在写请求后等 whenIdle，而这条发送还在等钩子 → 死锁），一律直接写库造「期间发生变化」
    const removeDel = async (c) => { await sqlRun("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = '夹具：外发前移出' WHERE id = ?", [c.memDel]); };
    const disableDel = async () => { touched.add(U.del); await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['disabled', U.del]); };
    const restoreDel = () => sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', U.del]);
    const expectSkipped = async (c, r, label, attemptsBefore) => {
      assert.strictEqual(r.outcome, 'skipped', `${label}：${JSON.stringify(r)}`);
      const row = await intentRow(c.id);
      assert.deepStrictEqual([row.status, row.attempts], ['sent', attemptsBefore], `${label}：status sent、attempts 不变`);
      assert.ok(row.last_error.startsWith('无需发送：'), `${label}：${row.last_error}`);
    };
    try {
      // A 对照：期间无变化 → 照发，正文带项目名与摘要（收件人是代表人，不是部门负责人）
      {
        const c = await newCase();
        ding.reset();
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'sent');
        assert.strictEqual(ding.sends().length, 1);
        assert.ok(ding.sends()[0].markdown.includes(await sysName(c.pid)), '对照：非负责人的正文带项目名');
      }
      // B 取令牌期间收件人被移出 → 跳过，不外发
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await removeDel(c); };
        const r = await notifier.deliverIntent(c.id);
        await expectSkipped(c, r, 'B 取令牌期间被移出', 0);
        assert.deepStrictEqual([ding.sends().length, tokenCalls()], [0, 1], 'B：外发 0 次（令牌取过一次）');
        assert.match((await intentRow(c.id)).last_error, /收件人此刻不能作出确认/);
        const ev = await evOf(c.pid, c.id);
        assert.deepStrictEqual([ev.outcome, ev.response.skipped.startsWith('收件人此刻不能作出确认')], ['skipped', true]);
      }
      // C 取令牌期间账号被停用 → failed（可恢复），不外发；恢复后再发送出
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await disableDel(); };
        const r = await notifier.deliverIntent(c.id);
        assert.deepStrictEqual([r.outcome, r.reason], ['failed', 'user_disabled']);
        assert.deepStrictEqual([(await intentRow(c.id)).status, (await intentRow(c.id)).attempts, ding.sends().length], ['failed', 1, 0], 'C：failed、attempts 1、外发 0 次');
        await restoreDel();
        ding.reset();
        assert.strictEqual((await notifier.deliverIntent(c.id)).outcome, 'sent', 'C：账号恢复后送出');
      }
      // D 手机号反查期间收件人被移出 → 跳过，不外发
      {
        const c = await newCase();
        try {
          await setUser(U.del, null, '13800000009');
          ding.reset();
          ding.state.mobileMap['13800000009'] = 'ding-looked-up-9';
          ding.state.mobileHook = async (n) => { if (n === 1) await removeDel(c); };
          const r = await notifier.deliverIntent(c.id);
          await expectSkipped(c, r, 'D 手机号反查期间被移出', 0);
          assert.deepStrictEqual([ding.sends().length, ding.calls.filter((x) => x.api === 'getUserIdByMobile').length], [0, 1], 'D：反查过一次、外发 0 次');
        } finally {
          await setUser(U.del, `ding-u${U.del}`, null);
        }
      }
      // E 令牌失效重发：对照（期间无变化）发两次；刷新令牌期间被移出 → 只发了第一次（被拒绝的那次），不发第二次，首次令牌失效的留痕保留
      {
        const c0 = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        assert.strictEqual((await notifier.deliverIntent(c0.id)).outcome, 'sent');
        assert.strictEqual(ding.sends().length, 2, '对照 E0：令牌失效后重发一次');
        const c = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        ding.state.tokenHook = async (n) => { if (n === 2) await removeDel(c); };
        const r = await notifier.deliverIntent(c.id);
        await expectSkipped(c, r, 'E 刷新令牌期间被移出', 0);
        assert.strictEqual(ding.sends().length, 1, 'E：只有首次那一次被拒绝的发送，不发第二次');
        assert.ok(ding.calls.some((x) => x.api === 'clearCachedToken'), 'E：确实走了刷新令牌');
        const ev = await evOf(c.pid, c.id);
        assert.strictEqual(ev.outcome, 'skipped');
        assert.deepStrictEqual(ev.response.channel_results, [{ stage: 'send', outcome: 'failed', reason: 'token_expired', errcode: 42001, process_query_key: null }], 'E：首次令牌失效的留痕保留在跳过事件里');
      }
      // F 刷新令牌期间账号被停用 → failed、只发了第一次、留痕保留
      {
        const c = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        ding.state.tokenHook = async (n) => { if (n === 2) await disableDel(); };
        const r = await notifier.deliverIntent(c.id);
        assert.deepStrictEqual([r.outcome, r.reason], ['failed', 'user_disabled']);
        assert.deepStrictEqual([(await intentRow(c.id)).status, (await intentRow(c.id)).attempts, ding.sends().length], ['failed', 1, 1], 'F：failed、attempts 1、只发过首次');
        const ev = await evOf(c.pid, c.id);
        assert.deepStrictEqual(ev.response.channel_results.map((x) => [x.stage, x.outcome, x.reason]), [['send', 'failed', 'token_expired']], 'F：首次令牌失效的留痕保留');
        await restoreDel();
      }
      // G 取令牌期间收件人成为需求部门现任负责人 → 复核后重算消息：首次发送就只给固定文案 + 链接
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => {
          if (n !== 1) return;
          const partyD = await addParty(c.pid, '丁部', 'demand');
          await addAppointment(partyD, c.memDel, 'active');
        };
        assert.strictEqual((await notifier.deliverIntent(c.id)).outcome, 'sent');
        assert.strictEqual(ding.sends().length, 1);
        assert.strictEqual(ding.sends()[0].markdown, `### 【系统建设记录】有事项需要您处理\n\n您有一项事项需要处理，请打开平台查看。\n\n[打开确认](${BASE_URL}/Sys_Build.html?project=${c.pid}&rev=${c.sub.ridDel})`, 'G：首次发送按复核后的身份重算消息');
      }
      // H 令牌失效重发：刷新令牌期间成为需求部门负责人 → 重试那一次的消息也重算（第一次是详情，第二次是固定文案）
      {
        const c = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        ding.state.tokenHook = async (n) => {
          if (n !== 2) return;
          const partyD = await addParty(c.pid, '丁部', 'demand');
          await addAppointment(partyD, c.memDel, 'active');
        };
        assert.strictEqual((await notifier.deliverIntent(c.id)).outcome, 'sent');
        assert.strictEqual(ding.sends().length, 2);
        assert.ok(ding.sends()[0].markdown.includes(await sysName(c.pid)), 'H：首次是带项目名的详情');
        assert.strictEqual(ding.sends()[1].markdown, `### 【系统建设记录】有事项需要您处理\n\n您有一项事项需要处理，请打开平台查看。\n\n[打开确认](${BASE_URL}/Sys_Build.html?project=${c.pid}&rev=${c.sub.ridDel})`, 'H：重试前重新复核并重算消息');
      }
      // I 取令牌期间意图被别处处理（状态变了）→ 不外发，也不覆盖别处的结果
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await sqlRun("UPDATE sysbuild_send_intents SET status = 'sent', attempts = 7 WHERE id = ?", [c.id]); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'conflict', JSON.stringify(r));
        assert.strictEqual(ding.sends().length, 0, 'I：不外发');
        assert.deepStrictEqual([(await intentRow(c.id)).status, (await intentRow(c.id)).attempts], ['sent', 7], 'I：不覆盖别处的结果');
      }
      // J 取令牌期间意图行被删除 → 不外发（不抛错、不是 error）
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await sqlRun('DELETE FROM sysbuild_send_intents WHERE id = ?', [c.id]); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'conflict', JSON.stringify(r));
        assert.strictEqual(ding.sends().length, 0, 'J：不外发');
      }
    } finally {
      for (const uid of touched) await sqlRun('UPDATE users SET status = ? WHERE id = ?', ['active', uid]);
      await setUser(U.del, `ding-u${U.del}`, null);
      ding.reset();
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_JUDGE}——（codex N2）渠道响应判定统一：逐次留痕（channel_results）与最终结果共用同一个判定——收件人在 invalid / flowControlled / filtered 名单、消息标识缺失、空响应、机器人编码无效、限流 / 无权限 errcode 都记 failed，且与最终 failed 的 reason 一致；成功记 ok 与消息标识；令牌失效后重发的软失败照样留痕（首次令牌过期记录保留）`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const run = async (mode, setup) => {
        ding.reset(); ding.state.sendMode = mode; if (setup) setup(ding.state);
        const id = await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null });
        const r = await notifier.deliverIntent(id);
        const ev = (await payloads(s.pid, 'send_intent_attempted')).filter((p) => p.intent_id === id).pop();
        return { id, r, row: await intentRow(id), ev, trail: ev.response.channel_results };
      };
      const cases = [
        ['invalid_list', null, 'user_invalid', 'user_invalid', null],
        ['flow_list', null, 'rate_limit', 'rate_limit', null],
        ['filtered_list', null, 'filtered', 'filtered', null],
        ['no_key', null, 'no_query_key', 'no_query_key', null],
        ['empty', null, 'no_query_key', 'no_query_key', null],
        ['robot_invalid', null, 'robot_code_invalid', 'robot_code_invalid', null],
        ['errcode', (st) => { st.sendErrcode = 90018; }, 'rate_limit', 'send_rate_limit', 90018],
        ['errcode', (st) => { st.sendErrcode = 60011; }, 'no_scope', 'send_no_scope', 60011],
      ];
      for (const [mode, setup, trailReason, finalReason, errcode] of cases) {
        const x = await run(mode, setup);
        const label = `${mode}${errcode ? `（${errcode}）` : ''}`;
        assert.deepStrictEqual([x.row.status, x.row.attempts, x.ev.outcome], ['failed', 1, 'failed'], `${label}：最终 failed`);
        assert.strictEqual(x.trail.length, 1, `${label}：一次渠道调用一条留痕`);
        assert.deepStrictEqual([x.trail[0].stage, x.trail[0].outcome, x.trail[0].reason, x.trail[0].errcode, x.trail[0].process_query_key], ['send', 'failed', trailReason, errcode, null], `${label}：留痕判 failed，原因与最终结果一致`);
        assert.strictEqual(x.ev.response.reason, finalReason, `${label}：最终原因`);
        assert.strictEqual(x.r.reason, finalReason);
      }
      // 成功：留痕 ok + 消息标识
      const ok = await run('ok');
      assert.deepStrictEqual([ok.row.status, ok.trail], ['sent', [{ stage: 'send', outcome: 'ok', reason: 'ok', errcode: null, process_query_key: 'pqk-test' }]]);
      // 令牌失效后重发被过滤：两条留痕（首次令牌过期 + 重发 filtered），最终 failed filtered、attempts 只加 1
      const tf = await run('token_expired_then_filtered');
      assert.deepStrictEqual([tf.row.status, tf.row.attempts, tf.ev.response.reason], ['failed', 1, 'filtered']);
      assert.deepStrictEqual(tf.trail, [
        { stage: 'send', outcome: 'failed', reason: 'token_expired', errcode: 42001, process_query_key: null },
        { stage: 'retry', outcome: 'failed', reason: 'filtered', errcode: null, process_query_key: null },
      ], '重发的软失败照样留痕，首次令牌过期记录保留');
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_NOSTARVE}——（codex N1）补发候选按「最近尝试时间升序」取（从未尝试的最先、刚失败的排后，同秒内 attempts 少的在前），上限 2 时前 2 条持续因个人原因失败，连续两次补发后尾部有效意图也被处理；remaining 口径不变`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    const cap2 = mkNotifier(kit, { resendBatchCap: 2 });
    const tsOf = async (ids, ts) => { for (const id of ids) await sqlRun('UPDATE sysbuild_send_intents SET updated_at = ? WHERE id = ?', [ts, id]); };
    const idsOf = (r) => r.results.map((x) => x.id);
    try {
      await setUser(U.own, null, null); // own 没有钉钉号也没有手机号：个人原因失败（no_dingtalk_id，不是系统性失败，不中止补发）
      // ① 端到端：A 两条（own，持续失败，id 较小）、B 两条（del，有效）。连续两次补发后 B 被处理
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        await settleAll(kit);
        const A = [await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1, lastError: '旧失败' }), await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1, lastError: '旧失败' })];
        const B = [await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' }), await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1, lastError: '旧失败' })];
        ding.reset();
        const r1 = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual([idsOf(r1), r1.counts.failed, r1.counts.remaining, r1.aborted], [A, 2, 2, null], '第一次补发：前 2 条（个人原因失败，不中止）');
        const r2 = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual([idsOf(r2), r2.counts.sent, r2.counts.remaining], [B, 2, 2], '第二次补发：刚失败的 A 排后，尾部有效的 B 被处理（remaining = 候选总数 4 − 本次 2 = 2）');
        for (const id of B) assert.deepStrictEqual([(await intentRow(id)).status, (await intentRow(id)).attempts], ['sent', 2]);
        const r3 = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual([idsOf(r3), r3.counts.remaining], [A, 0], '第三次补发：只剩 A');
      }
      // ② 按上次尝试时间：A 的上次尝试比 B 新（夹具写 updated_at）→ B 先于 A，不论 id
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        await settleAll(kit);
        const A = [await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1 }), await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1 })];
        const B = [await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1 }), await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1 })];
        await tsOf(A, '2026-11-08 10:00:00');
        await tsOf(B, '2026-11-01 10:00:00');
        ding.reset();
        const r = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual(idsOf(r), B, '上次尝试更早的 B 先处理（id 更大也先）');
      }
      // ③ 从未尝试的最先：C（pending，创建很久，attempts 0）的 updated_at 比 A（failed，attempts 1）新，C 仍排在 A 前
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        await settleAll(kit);
        const A = [await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1 }), await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 1 })];
        const C = await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: FLOOR_PAST });
        await tsOf(A, '2020-06-01 00:00:00');
        ding.reset();
        const r = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual(idsOf(r), [C, A[0]], '从未尝试的先于所有已尝试的（即使它的 updated_at 更新）');
      }
      // ④ 同一秒内：updated_at 相同，attempts 少的在前（A 已试 2 次、B 试 1 次）
      {
        const s = await mkScene();
        const sub = await submitOverall(s.pid);
        await settleAll(kit);
        const A = [await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 2 }), await fixIntent(s.pid, U.own, sub.ridOwn, { status: 'failed', attempts: 2 })];
        const B = [await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1 }), await fixIntent(s.pid, U.del, sub.ridDel, { status: 'failed', attempts: 1 })];
        await tsOf(A.concat(B), '2026-11-08 10:00:00');
        ding.reset();
        const r = await cap2.resendProject(s.pid, pmOp());
        assert.deepStrictEqual(idsOf(r), B, '同一秒内 attempts 少的在前');
      }
    } finally {
      await setUser(U.own, `ding-u${U.own}`, null);
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_SCANABORT}——（预筛 LOW-1）就绪扫描遇到第一个系统性失败就停止本轮（与补发同一规则，跨批也停）：其余意图不被试、attempts 不动，返回 aborted；对照：非系统性失败（收件人失效）不中止，三条都试`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const small = mkNotifier(kit, { scanBatchCap: 1 }); // 每批 1 条：中止必须跨批生效（只 break 内层循环会继续取下一批）
      const ids = [];
      for (let i = 0; i < 3; i += 1) ids.push(await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null }));
      ding.reset(); ding.state.tokenError = Object.assign(new Error('gettoken failed: errcode=40001 errmsg=bad'), { errcode: 40001, errmsg: 'bad' });
      const res = await small.scan();
      assert.deepStrictEqual([res.total, res.failed, res.aborted && res.aborted.intent_id], [1, 1, ids[0]], '系统性失败：只试第一条');
      assert.ok(/^gettoken_/.test(res.aborted.reason), res.aborted.reason);
      assert.deepStrictEqual([(await intentRow(ids[1])).status, (await intentRow(ids[1])).attempts, (await intentRow(ids[2])).status, (await intentRow(ids[2])).attempts], ['pending', 0, 'pending', 0], '后两条没有被试');
      assert.strictEqual(ding.calls.filter((c) => c.api === 'getAccessToken').length, 1, '只取过一次令牌');
      // 对照：收件人失效（88002）不是系统性失败 → 三条都试（第一条已 failed、attempts 1 < 3 仍在扫描范围）
      ding.reset(); ding.state.sendMode = 'errcode'; ding.state.sendErrcode = 88002;
      const res2 = await small.scan();
      assert.deepStrictEqual([res2.total, res2.failed, res2.aborted], [3, 3, null], '对照：非系统性失败不中止');
    } finally {
      await settleAll(kit);
    }
    return undefined;
  });

  // ═══════════════════════ 5e 修订批 4：codex 28-R2（O1–O3）═══════════════════════
  test(`${T_ADDR}——（codex 28-R2 O1）外发前复核同时核最新账号行：取令牌 / 刷新令牌期间钉钉号被更正 → 发到新地址（含重试）；按手机号反查的，手机号被更正 → 用新手机号重新反查再发，改成有钉钉号 → 直接用；账号行被删除 → 不外发（跳过「收件人账号已不存在」）；重新解析失败 → failed 不外发；重新解析之后再复核一次（期间被移出 → 跳过）；地址一直在变 → failed（recipient_changing）；对照：无变化 / 有钉钉号时只改手机号 → 不重新反查`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding, notifier } = kit;
    const phones = ['13800000030', '13800000031', '13800000032', '13800000033', '13800000034'];
    let savedUser = null;
    const evOf = async (pid, id) => (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === id).pop();
    const newCase = async () => {
      await resetUser();
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const id = await fixIntent(s.pid, U.del, sub.ridDel, { createdAt: null });
      return { s, sub, id, pid: s.pid, memDel: await memberIdOf(s.pid, U.del) };
    };
    // 钩子在发送流程中途被调用：不能走 HTTP 端点（夹具在写请求后等 whenIdle，而这条发送还在等钩子 → 死锁），一律直接写库
    const resetUser = () => setUser(U.del, `ding-u${U.del}`, null);
    const removeDel = async (c) => { await sqlRun("UPDATE sysbuild_members SET removed_at = datetime('now','localtime'), removed_reason = '夹具：外发前移出' WHERE id = ?", [c.memDel]); };
    const deleteUserRow = async () => {
      savedUser = await sqlGet('SELECT * FROM users WHERE id = ?', [U.del]);
      await sqlRun('DELETE FROM users WHERE id = ?', [U.del]);
    };
    const restoreUserRow = async () => {
      if (!savedUser) return;
      const cols = Object.keys(savedUser);
      await sqlRun(`INSERT OR REPLACE INTO users (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => savedUser[k]));
      savedUser = null;
    };
    const sendTargets = () => ding.sends().map((c) => c.userIds[0]);
    const lookups = () => ding.calls.filter((c) => c.api === 'getUserIdByMobile').map((c) => c.phone);
    const expectSkipped = async (c, r, label, re) => {
      assert.strictEqual(r.outcome, 'skipped', `${label}：${JSON.stringify(r)}`);
      const row = await intentRow(c.id);
      assert.deepStrictEqual([row.status, row.attempts], ['sent', 0], `${label}：status sent、attempts 不变`);
      assert.ok(row.last_error.startsWith('无需发送：') && re.test(row.last_error), `${label}：${row.last_error}`);
    };
    try {
      // A 对照：无变化 → 发给账号上的钉钉号，不反查
      {
        const c = await newCase();
        ding.reset();
        assert.strictEqual((await notifier.deliverIntent(c.id)).outcome, 'sent');
        assert.deepStrictEqual([sendTargets(), lookups()], [[`ding-u${U.del}`], []], 'A：发给账号上的钉钉号');
      }
      // B 取令牌期间钉钉号被更正 → 发到新地址（旧地址不发）
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await setUser(U.del, 'ding-new-B', null); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'sent', JSON.stringify(r));
        assert.deepStrictEqual([sendTargets(), lookups()], [['ding-new-B'], []], 'B：发到更正后的钉钉号');
        assert.deepStrictEqual([(await intentRow(c.id)).status, (await intentRow(c.id)).attempts], ['sent', 1]);
      }
      // C 取令牌期间账号行被删除 → 不外发
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await deleteUserRow(); };
        const r = await notifier.deliverIntent(c.id);
        await restoreUserRow();
        await expectSkipped(c, r, 'C 取令牌期间删除账号行', /收件人账号已不存在/);
        assert.strictEqual(ding.sends().length, 0, 'C：外发 0 次');
        const ev = await evOf(c.pid, c.id);
        assert.deepStrictEqual([ev.outcome, ev.response.skipped], ['skipped', '收件人账号已不存在']);
      }
      // D 令牌失效重发：刷新令牌期间钉钉号被更正 → 首次发给旧地址（被拒绝），重试发到新地址
      {
        const c = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        ding.state.tokenHook = async (n) => { if (n === 2) await setUser(U.del, 'ding-new-D', null); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'sent', JSON.stringify(r));
        assert.deepStrictEqual(sendTargets(), [`ding-u${U.del}`, 'ding-new-D'], 'D：重试发到更正后的钉钉号');
        const ev = await evOf(c.pid, c.id);
        assert.deepStrictEqual(ev.response.channel_results.map((x) => [x.stage, x.outcome]), [['send', 'failed'], ['retry', 'ok']]);
      }
      // E 按手机号反查：取令牌期间手机号被更正 → 用新手机号重新反查再发
      {
        const c = await newCase();
        await setUser(U.del, null, phones[0]);
        ding.reset(); ding.state.mobileMap[phones[0]] = 'ding-lk-0'; ding.state.mobileMap[phones[1]] = 'ding-lk-1';
        ding.state.tokenHook = async (n) => { if (n === 1) await setUser(U.del, null, phones[1]); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'sent', JSON.stringify(r));
        assert.deepStrictEqual([lookups(), sendTargets()], [[phones[0], phones[1]], ['ding-lk-1']], 'E：重新反查并发到新地址');
      }
      // F 按手机号反查：取令牌期间补上了钉钉号 → 直接用，不再反查新的
      {
        const c = await newCase();
        await setUser(U.del, null, phones[0]);
        ding.reset(); ding.state.mobileMap[phones[0]] = 'ding-lk-0';
        ding.state.tokenHook = async (n) => { if (n === 1) await setUser(U.del, 'ding-new-F', phones[0]); };
        const r = await notifier.deliverIntent(c.id);
        assert.strictEqual(r.outcome, 'sent', JSON.stringify(r));
        assert.deepStrictEqual([lookups(), sendTargets()], [[phones[0]], ['ding-new-F']], 'F：直接用补上的钉钉号');
      }
      // G 重新解析失败（新手机号反查不到）→ failed，不外发
      {
        const c = await newCase();
        await setUser(U.del, null, phones[0]);
        ding.reset(); ding.state.mobileMap[phones[0]] = 'ding-lk-0';
        ding.state.tokenHook = async (n) => { if (n === 1) await setUser(U.del, null, phones[4]); };
        const r = await notifier.deliverIntent(c.id);
        assert.deepStrictEqual([r.outcome, /^get_by_mobile_/.test(r.reason), r.systemic], ['failed', true, false], JSON.stringify(r));
        assert.deepStrictEqual([ding.sends().length, lookups()], [0, [phones[0], phones[4]]], 'G：外发 0 次');
        assert.deepStrictEqual([(await intentRow(c.id)).status, (await intentRow(c.id)).attempts], ['failed', 1]);
      }
      // H 重新解析之后再复核一次：重新反查期间收件人被移出 → 跳过，不外发
      {
        const c = await newCase();
        await setUser(U.del, null, phones[0]);
        ding.reset(); ding.state.mobileMap[phones[0]] = 'ding-lk-0'; ding.state.mobileMap[phones[1]] = 'ding-lk-1';
        ding.state.tokenHook = async (n) => { if (n === 1) await setUser(U.del, null, phones[1]); };
        ding.state.mobileHook = async (n) => { if (n === 2) await removeDel(c); };
        const r = await notifier.deliverIntent(c.id);
        await expectSkipped(c, r, 'H 重新反查期间被移出', /收件人此刻不能作出确认/);
        assert.deepStrictEqual([ding.sends().length, lookups()], [0, [phones[0], phones[1]]], 'H：外发 0 次');
      }
      // I 地址一直在变（每次反查期间手机号又被改）→ 有界重复后 failed（recipient_changing），不外发
      {
        const c = await newCase();
        await setUser(U.del, null, phones[0]);
        ding.reset();
        for (let i = 0; i < 4; i += 1) ding.state.mobileMap[phones[i]] = `ding-lk-${i}`;
        ding.state.mobileHook = async (n) => { await setUser(U.del, null, phones[n]); };
        const r = await notifier.deliverIntent(c.id);
        assert.deepStrictEqual([r.outcome, r.reason], ['failed', 'recipient_changing'], JSON.stringify(r));
        assert.deepStrictEqual([ding.sends().length, lookups()], [0, [phones[0], phones[1], phones[2], phones[3]]], 'I：外发 0 次');
      }
      // J 令牌失效重发：刷新令牌期间账号行被删除 → 只发了第一次，不发第二次
      {
        const c = await newCase();
        ding.reset(); ding.state.sendMode = 'token_expired_once';
        ding.state.tokenHook = async (n) => { if (n === 2) await deleteUserRow(); };
        const r = await notifier.deliverIntent(c.id);
        await restoreUserRow();
        await expectSkipped(c, r, 'J 刷新令牌期间删除账号行', /收件人账号已不存在/);
        assert.strictEqual(ding.sends().length, 1, 'J：只有首次那一次被拒绝的发送');
      }
      // K 对照：有钉钉号时只改了手机号 → 地址依据没变，不重新反查、不换地址
      {
        const c = await newCase();
        ding.reset();
        ding.state.tokenHook = async (n) => { if (n === 1) await sqlRun('UPDATE users SET phone = ? WHERE id = ?', [phones[2], U.del]); };
        assert.strictEqual((await notifier.deliverIntent(c.id)).outcome, 'sent');
        assert.deepStrictEqual([sendTargets(), lookups()], [[`ding-u${U.del}`], []], 'K：只改手机号不影响有钉钉号的地址');
      }
    } finally {
      await restoreUserRow();
      await resetUser();
      ding.reset();
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_SCHEDDIS}——（codex 28-R2 O2）改期推后时需求部门负责人账号已停用：知会与发送意图照常生成（负责人按与账号状态无关的任职资格选），发送记 failed（user_disabled，外发 0 次）、发送尝试记 failed；PM 的失败计数 / 失败列表 / 待办都含它；账号恢复后补发送出；另一个部门不受影响`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    const setStatus = (uid, st) => sqlRun('UPDATE users SET status = ? WHERE id = ?', [st, uid]);
    try {
      const s = await effectiveScene();
      const { pid } = s;
      await settleAll(kit);
      await setStatus(U.own, 'disabled');
      ding.reset();
      const mark = await lastId(pid);
      const r = await resched(s.mile, '2026-12-05');
      assert.strictEqual(r.status, 201, r.text);
      const ns = await noticesOf(pid);
      assert.deepStrictEqual(ns.map((n) => [n.member_id, n.user_id]), [[s.A.mOwn, U.own], [s.B.mOwn, U.x1]], '账号停用的负责人也生成知会');
      const rows = await intentsAfter(pid, mark);
      assert.deepStrictEqual(brief(rows), [['schedule_notice', 'notice', U.own], ['schedule_notice', 'notice', U.x1]]);
      assert.deepStrictEqual(rows.map((x) => x.ref_id), ns.map((n) => n.id));
      const [iA, iB] = rows;
      assert.deepStrictEqual([iA.status, iA.attempts], ['failed', 1], '停用负责人的意图：failed、attempts 1');
      assert.ok(iA.last_error.includes('收件人账号已停用'), iA.last_error);
      assert.deepStrictEqual([iB.status, iB.attempts], ['sent', 1], '另一个部门照发');
      assert.deepStrictEqual(ding.sends().map((c) => c.userIds[0]), [`ding-u${U.x1}`], '停用账号外发 0 次');
      const evA = (await payloads(pid, 'send_intent_attempted')).filter((p) => p.intent_id === iA.id).pop();
      assert.deepStrictEqual([evA.outcome, evA.response.reason], ['failed', 'user_disabled']);
      const attA = () => sqlAll('SELECT result, response_code FROM sysbuild_notice_attempts WHERE notice_id = ? ORDER BY id', [ns[0].id]);
      assert.deepStrictEqual(await attA(), [{ result: 'failed', response_code: 'user_disabled' }], '发送尝试记 failed（user_disabled）');
      // PM 的失败计数含它：项目视图 / 发送意图列表 / 待办 send_failed
      assert.deepStrictEqual((await get(U.pm, `/sysbuild/projects/${pid}`)).body.notify, { send_failed: 1 }, '项目视图的失败计数含它');
      const list = (await get(U.pm, `/sysbuild/projects/${pid}/send-intents`)).body;
      assert.strictEqual(list.failed_count, 1);
      assert.ok((await get(U.pm, '/sysbuild/my/todo')).body.items.send_failed.some((i) => i.project_id === pid && i.intent_id === iA.id), '待办 send_failed 含它');
      // 账号恢复后补发送出
      await setStatus(U.own, 'active');
      ding.reset();
      const rs = await post(U.pm, `/sysbuild/projects/${pid}/send-intents/resend`);
      assert.strictEqual(rs.status, 200, rs.text);
      assert.strictEqual(rs.body.results.find((x) => x.id === iA.id).outcome, 'sent', JSON.stringify(rs.body.results));
      assert.deepStrictEqual(ding.sends().map((c) => c.userIds[0]), [`ding-u${U.own}`], '恢复后发给负责人');
      assert.deepStrictEqual([(await intentRow(iA.id)).status, (await intentRow(iA.id)).attempts], ['sent', 2]);
      assert.deepStrictEqual(await attA(), [{ result: 'failed', response_code: 'user_disabled' }, { result: 'sent', response_code: 'pqk-test' }]);
      assert.strictEqual((await get(U.pm, `/sysbuild/projects/${pid}/send-intents`)).body.failed_count, 0);
    } finally {
      await setStatus(U.own, 'active');
      ding.reset();
      await settleAll(kit);
    }
    return undefined;
  });

  test(`${T_THROWSYS}——（codex 28-R2 O3）发送调用 / 刷新令牌 / 手机号反查抛出异常、且异常归类为限流（90018）或应用未开通权限（60011）时，与渠道返回同样判系统性失败：补发与就绪扫描立即中止当前批（首次发送、令牌刷新后重发、刷新令牌、反查四处）；对照：网络类异常照旧中止，收件人失效（88002）类异常不中止`, async () => {
    const kit = kitOrNull();
    if (!kit) return SKIP;
    const { ding } = kit;
    const thrownOf = (errcode) => Object.assign(new Error(`dingtalk errcode=${errcode}`), { errcode, errmsg: `e${errcode}` });
    try {
      const s = await mkScene();
      const sub = await submitOverall(s.pid);
      await settleAll(kit);
      const url = `/sysbuild/projects/${s.pid}/send-intents/resend`;
      const small = mkNotifier(kit, { scanBatchCap: 1 });
      const mkIntents = async (status) => {
        const ids = [];
        for (let i = 0; i < 3; i += 1) ids.push(await fixIntent(s.pid, U.del, sub.ridDel, status === 'failed' ? { status: 'failed', attempts: 1, lastError: '旧失败' } : { createdAt: null }));
        return ids;
      };
      const mode = (m, code) => (st) => { st.sendMode = m; st.thrown = thrownOf(code); };
      const cases = [
        ['首次发送抛限流', mode('throw', 90018), 'send_rate_limit'],
        ['首次发送抛无权限', mode('throw', 60011), 'send_no_scope'],
        ['令牌刷新后重发抛限流', mode('token_expired_then_throw', 90018), 'retry_rate_limit'],
        ['令牌刷新后重发抛无权限', mode('token_expired_then_throw', 60011), 'retry_no_scope'],
        ['刷新令牌抛限流', mode('token_expired_refresh_throw', 90018), 'retry_rate_limit'],
        ['刷新令牌抛无权限', mode('token_expired_refresh_throw', 60011), 'retry_no_scope'],
        ['首次发送抛网络类异常（对照，原本就中止）', (st) => { st.sendMode = 'throw'; st.thrown = new Error('fetch failed'); }, 'send_network'],
      ];
      for (const [label, setup, reason] of cases) {
        // 补发：只试第一条就中止，其余两条不被试
        await settleAll(kit);
        let ids = await mkIntents('failed');
        ding.reset(); setup(ding.state);
        const x = await post(U.pm, url);
        assert.strictEqual(x.status, 200, x.text);
        assert.deepStrictEqual([x.body.counts.total, x.body.counts.remaining, x.body.aborted && x.body.aborted.reason, x.body.aborted && x.body.aborted.intent_id], [1, 2, reason, ids[0]], `补发 ${label}：系统性失败，只试一条`);
        // 扫描：同一规则
        await settleAll(kit);
        ids = await mkIntents('pending');
        ding.reset(); setup(ding.state);
        const res = await small.scan();
        assert.deepStrictEqual([res.total, res.failed, res.aborted && res.aborted.intent_id, res.aborted && res.aborted.reason], [1, 1, ids[0], reason], `扫描 ${label}：系统性失败，只试一条`);
        assert.deepStrictEqual([(await intentRow(ids[1])).attempts, (await intentRow(ids[2])).attempts], [0, 0], `扫描 ${label}：后两条没有被试`);
      }
      // 反查抛异常（收件人没有钉钉号、按手机号反查）
      try {
        await setUser(U.del, null, '13800000041');
        for (const [label, code, reason] of [['反查抛限流', 90018, 'get_by_mobile_rate_limit'], ['反查抛无权限', 60011, 'get_by_mobile_no_scope']]) {
          await settleAll(kit);
          const ids = await mkIntents('failed');
          ding.reset(); ding.state.mobileError = thrownOf(code);
          const x = await post(U.pm, url);
          assert.deepStrictEqual([x.body.counts.total, x.body.counts.remaining, x.body.aborted && x.body.aborted.reason, x.body.aborted && x.body.aborted.intent_id], [1, 2, reason, ids[0]], `补发 ${label}：系统性失败，只试一条`);
        }
      } finally {
        await setUser(U.del, `ding-u${U.del}`, null);
      }
      // 对照：抛出的是收件人失效（88002）→ 个人原因，不中止，三条都试
      await settleAll(kit);
      await mkIntents('failed');
      ding.reset(); ding.state.sendMode = 'throw'; ding.state.thrown = thrownOf(88002);
      const c0 = await post(U.pm, url);
      assert.deepStrictEqual([c0.body.counts.total, c0.body.aborted], [3, null], '对照：收件人失效类异常不中止');
      assert.ok(c0.body.results.every((r) => r.reason === 'send_user_invalid'), JSON.stringify(c0.body.results));
    } finally {
      await setUser(U.del, `ding-u${U.del}`, null);
      await settleAll(kit);
    }
    return undefined;
  });

  // ═══════════════════════ 6 实例模式：平台钉钉替身日志 ═══════════════════════
  test(`${T_STUB}——发起立项确认后意图 sent、attempts = 1，外发一次 batchSend（收件人 1 个、正文非空）；事件留痕；收件人无钉钉号有手机号时按手机号反查一次、users 行不回写。真实实例读平台钉钉替身日志（stubbed、手机号已脱敏），进程内读钉钉替身的调用记录（同一套断言口径）`, async () => {
    const kit = kitOrNull();
    const dir = kit ? null : (T.getDataDir ? T.getDataDir() : null);
    if (!kit && !dir) return SKIP;
    const file = dir ? path.join(dir, 'external-calls.jsonl') : null;
    const readLog = () => (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
    // 统一视角：每次外发 = { kind: 'batchSend' | 'lookup', users, textLen }
    const mark = () => (kit ? kit.ding.calls.length : readLog().length);
    const seen = (from) => {
      if (kit) {
        return kit.ding.calls.slice(from).filter((c) => c.api === 'sendMarkdownToUser' || c.api === 'getUserIdByMobile')
          .map((c) => (c.api === 'sendMarkdownToUser' ? { kind: 'batchSend', users: c.userIds.length, textLen: c.markdown.length } : { kind: 'lookup' }));
      }
      return readLog().slice(from).filter((r) => r.api === '/v1.0/robot/oToMessages/batchSend' || r.api === '/user/get_by_mobile')
        .map((r) => (r.api === '/user/get_by_mobile' ? { kind: 'lookup' } : { kind: 'batchSend', outcome: r.outcome, users: r.params.body.userIds === '[1 items]' ? 1 : -1, textLen: Number((/^<string len (\d+)>$/.exec(r.params.body.msgParam) || [0, 0])[1]), raw: JSON.stringify(r) }));
    };
    if (kit) kit.ding.reset();
    const s = await mkScene();
    await setUser(U.own, `ding-inst-${U.own}`, '13900000003');
    const m1 = mark();
    const mk1 = await lastId(s.pid);
    await submitInitiation(s.pid);
    const rows = await intentsAfter(s.pid, mk1);
    assert.deepStrictEqual(brief(rows), [['confirm_request', 'confirm_revision', U.own]]);
    assert.deepStrictEqual([rows[0].status, rows[0].attempts], ['sent', 1], rows[0].last_error);
    const out1 = seen(m1);
    assert.strictEqual(out1.length, 1);
    assert.strictEqual(out1[0].kind, 'batchSend');
    assert.strictEqual(out1[0].users, 1);
    assert.ok(out1[0].textLen > 0, '正文非空');
    if (!kit) {
      assert.strictEqual(out1[0].outcome, 'stubbed');
      assert.strictEqual(out1[0].raw.includes('13900000003'), false, '手机号不入日志');
    }
    const ev = (await payloads(s.pid, 'send_intent_attempted')).filter((p) => p.intent_id === rows[0].id);
    assert.deepStrictEqual([ev.length, ev[0].outcome], [1, 'sent']);
    // 收件人无钉钉号、有手机号：反查一次 + batchSend 一次，users 行不回写
    const lookupScene = await mkScene();
    await setUser(U.own, null, '13900000003');
    if (kit) kit.ding.state.mobileMap['13900000003'] = 'ding-looked-up';
    const m2 = mark();
    const mk2 = await lastId(lookupScene.pid);
    await submitInitiation(lookupScene.pid);
    const rows2 = await intentsAfter(lookupScene.pid, mk2);
    assert.deepStrictEqual([rows2.length, rows2[0].status, rows2[0].attempts], [1, 'sent', 1], rows2[0] && rows2[0].last_error);
    assert.deepStrictEqual(seen(m2).map((x) => x.kind), ['lookup', 'batchSend'], '按手机号反查一次，再发一次');
    assert.deepStrictEqual(await sqlGet('SELECT dingtalk_user_id FROM users WHERE id = ?', [U.own]), { dingtalk_user_id: null }, '不回写 users');
    await setUser(U.own, kit ? `ding-u${U.own}` : null, null);
    if (kit) kit.ding.reset();
  });

  // ═══════════════════════ 7 修订批残余 ═══════════════════════
  test(`${T_FIX}——notify-core 常量与枚举：用途 / 引用类型集合手写核对；页面路由形如 /Sys_Build.html?project=<pid>&rev=<修订 id>；改期知会异议的 mode 枚举含 to_pm`, async () => {
    const dir = T.getModuleDir();
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const nc = require(path.join(dir, 'notify-core.js'));
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const schema = require(path.join(dir, 'schema.js'));
    assert.deepStrictEqual([...nc.PURPOSE_LIST].sort(), ['confirm_reissue', 'confirm_request', 'decision_objected', 'leader_confirmation_notice',
      'opinion_assess_notice', 'opinion_cut_notice', 'opinion_ready_notice', 'opinion_result_notice', 'schedule_notice']);
    assert.deepStrictEqual([...nc.REF_TYPE_LIST].sort(), ['confirm_revision', 'cut_approval', 'notice', 'opinion']);
    assert.strictEqual(nc.ROUTES.confirm(7, 9), '/Sys_Build.html?project=7&rev=9');
    assert.strictEqual(nc.ROUTES.project(7), '/Sys_Build.html?project=7');
    // L5（修订批 1）：其余页面路由的形状（C7 页面按这些查询参数解析）
    assert.strictEqual(nc.ROUTES.notice(7, 9), '/Sys_Build.html?project=7&notice=9');
    assert.strictEqual(nc.ROUTES.sendIntents(7), '/Sys_Build.html?project=7&view=send-intents');
    // 消息正文：非负责人收到的改期知会（K1 之后发送侧不会再把改期知会发给非负责人，所以直接调 buildMessage 核对分支）；负责人收到的改期知会 / 确认类的固定文案
    const kit = kitOrNull();
    if (kit) {
      const bm = kit.notifier._internals.buildMessage;
      const base = 'http://b.invalid';
      assert.deepStrictEqual(
        bm({ intent: { purpose: 'schedule_notice' }, ownerRecipient: false, systemName: '系统甲', summary: '正式上线里程碑的计划日期推后，请查看改期知会', route: nc.ROUTES.notice(7, 9) }, base),
        { title: '【系统建设记录】改期知会', text: '### 【系统建设记录】改期知会\n\n**项目**：系统甲\n\n正式上线里程碑的计划日期推后，请查看改期知会\n\n[打开确认](http://b.invalid/Sys_Build.html?project=7&notice=9)', link: 'http://b.invalid/Sys_Build.html?project=7&notice=9' },
        '非负责人的改期知会：标题 + 项目名 + 摘要 + 「打开确认」'
      );
      assert.deepStrictEqual(
        bm({ intent: { purpose: 'schedule_notice' }, ownerRecipient: true, systemName: '系统甲', summary: 'x', route: nc.ROUTES.notice(7, 9) }, base),
        { title: '【系统建设记录】改期知会', text: '### 【系统建设记录】改期知会\n\n有一条改期知会，请查看。\n\n[打开查看](http://b.invalid/Sys_Build.html?project=7&notice=9)', link: 'http://b.invalid/Sys_Build.html?project=7&notice=9' },
        '负责人的改期知会：知会口吻的固定文案 + 「打开查看」'
      );
      assert.deepStrictEqual(
        bm({ intent: { purpose: 'confirm_request' }, ownerRecipient: true, systemName: '系统甲', summary: 'x', route: nc.ROUTES.confirm(7, 9) }, base),
        { title: '【系统建设记录】有事项需要您处理', text: '### 【系统建设记录】有事项需要您处理\n\n您有一项事项需要处理，请打开平台查看。\n\n[打开确认](http://b.invalid/Sys_Build.html?project=7&rev=9)', link: 'http://b.invalid/Sys_Build.html?project=7&rev=9' },
        '负责人的确认类：固定文案'
      );
    }
    assert.deepStrictEqual([nc.RESEND_PENDING_MINUTES, nc.SCAN_MAX_ATTEMPTS, nc.OVERDUE_DAYS], [5, 3, 3]);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const nf = require(path.join(dir, 'notify.js'));
    assert.deepStrictEqual([nf.TODO_ITEM_CAP, nf.RESEND_BATCH_CAP], [50, 100], '待办每类上限 50；一次补发上限 100');
    assert.strictEqual(nf.normalizeBaseUrl(' http://a.example/// '), 'http://a.example');
    assert.strictEqual(nf.normalizeBaseUrl('https://a.example:3000/x'), 'https://a.example:3000/x');
    for (const bad of ['', '   ', 'javascript:alert(1)', 'ftp://a.example', 'a.example', null, undefined, 3]) assert.strictEqual(nf.normalizeBaseUrl(bad), '', `不合法的 base url：${String(bad)}`);
    assert.strictEqual(nf.scrub('x TOKEN-1234 y KEY-5678', ['TOKEN-1234', 'KEY-5678', 'ab']), 'x *** y ***');
    assert.strictEqual(nf.scrub('a'.repeat(300), []).length, 200, '超长截断');
    // 入参不合法 = 编程错误（500），不写行
    const fake = { run: async () => { throw new Error('不该写库'); } };
    for (const bad of [{ projectId: 0, purpose: 'confirm_request', refType: 'confirm_revision', refId: 1, recipientUserId: 1 }, { projectId: 1, purpose: 'nope', refType: 'confirm_revision', refId: 1, recipientUserId: 1 },
      { projectId: 1, purpose: 'confirm_request', refType: 'nope', refId: 1, recipientUserId: 1 }, { projectId: 1, purpose: 'confirm_request', refType: 'confirm_revision', refId: 0, recipientUserId: 1 },
      { projectId: 1, purpose: 'confirm_request', refType: 'confirm_revision', refId: 1, recipientUserId: null }]) {
      await assert.rejects(() => nc.enqueueSendIntent(fake, bad), (e) => e.status === 500 && e.code === 'SYSBUILD_INTERNAL');
    }
  });
}

// ── 变异 ───────────────────────────────────────────────────────────────────────────────────────
// 每条 { id（前缀 C6b ）, expect: [用例名前缀], edits: [{ file, from, to }] }；锚点必须在副本里恰好出现一次（LF 归一后）。expect 列全会被打红的负责用例。
//   不覆盖（残余）：dispatch 在回滚路径上误派发——回滚的事务里写下的意图行随事务消失，派发时按编号读不到行（outcome = gone），不会外发，所以这条变异没有可观察差异（等价变异，不登记）；
//   代录（method = proxy）的有异议 / 不认可不通知 PM（需要完整的代录凭据夹具，本批未单设用例）；邀请 / 授权意图的「引用对象已处理 → 跳过」分支（describeRef 的 invitation / delegation 两支，
//   只有修订一支有用例）；待办 confirm 类的取数（直接取自 GET /my/confirmations 的同一函数，用例核对两者全等）。
const nm = (id, expect, file, from, to) => ({ id: `C6b ${id}`, expect, edits: [{ file, from, to }] });
const FIXED = "if (data.ownerRecipient) {";
const NOTIFY_MUTATIONS = [
  nm('B3.2 验收与结项知悉称呼错置', [T_LEADER_TEXT], 'notify-core.js', "batch_accept: '验收', closing: '结项'", "batch_accept: '结项', closing: '验收'"),
  nm('B3.1 提交漏发领导知悉', [T_TRIG], 'confirm.js', 'if (Object.hasOwn(notifyCore.LEADER_CONFIRMATION_SUBJECTS, pkg.type)) {', 'if (false) {'),
  nm('B3.1 领导知悉走通用确认消息', [T_TRIG], 'notify.js', 'if (data.intent.purpose === PURPOSES.LEADER_CONFIRMATION_NOTICE) {', 'if (false) {'),
  nm('B3.1 已生效提交不发知悉', [T_LEADER], 'notify.js', "if (submitted.status !== 'pending' && submitted.status !== 'effective')", "if (submitted.status !== 'pending')"),
  nm('B3.1 发前忽略领导已换', [T_LEADER], 'notify.js', "if (leader !== Number(intent.recipient_user_id)) return skip('收件人已不是该部门现任领导');", ''),
  nm('B3.1 发前忽略来源项目', [T_LEADER], 'notify.js', "WHERE r.id = ? AND t.project_id = ? AND t.object_type = 'package_version'", "WHERE r.id = ? AND (? IS NOT NULL) AND t.object_type = 'package_version'"),
  nm('B3.1 发前忽略项目终止', [T_LEADER], 'notify.js', "if (submitted.project_status === 'terminated') return skip('项目已终止，本次确认提交已失效');", ''),
  nm('B3.1 发前忽略修订失效', [T_LEADER], 'notify.js', "if (invalid) return skip('本次确认提交已有失效任务');", ''),
  nm('B3.1 同账号同时收到确认与知悉', [T_LEADER], 'confirm.js', 'if (leader === null || confirmerUsers.has(leader)) continue;', 'if (leader === null) continue;'),
  // ── notify-core.js：意图登记 ──
  nm('意图不登记到本事务的意图清单（提交后没人发）', [T_TRIG, T_SCHED], 'notify-core.js', 'if (Array.isArray(q.sendIntentIds)) q.sendIntentIds.push(ins.lastID);', ''),
  nm('改发的意图用途恒为首次（confirm_request）', [T_TRIG], 'notify-core.js', 'purpose: o.reissue === true ? PURPOSES.CONFIRM_REISSUE : PURPOSES.CONFIRM_REQUEST,', 'purpose: PURPOSES.CONFIRM_REQUEST,'),
  nm('有异议 / 不认可的通知发给了别人（不是项目 PM）', [T_TRIG], 'notify-core.js', 'recipientUserId: Number(p.pm_user_id) });', 'recipientUserId: Number(o.refId) });'),
  nm('PM 项目视图的失败条数只数无意图的改期知会（漏了失败的意图）', [T_RESEND], 'notify-core.js', 'return a ? Number(a.n) : 0;', 'return 0;'), // 修订批 2（P184）：failedIntentCount 只数补发能处理的意图失败，无账号的改期知会拆到 needsOfflineCount
  // ── 触发点 ──
  nm('确认任务首修订不写发送意图', [T_TRIG], 'confirm-core.js', "await notifyCore.enqueueRevisionIntent(q, { projectId: o.projectId, revisionId: r.lastID, requiredMemberId: o.requiredMemberId });", ''),
  nm('改发不写发送意图', [T_TRIG], 'confirm.js', "await notifyCore.enqueueRevisionIntent(q, { projectId: c.task.project_id, revisionId: ins.lastID, requiredMemberId: cur.memberId, reissue: true }); // C6b：改发后的必需确认人收到新的发送意图", ''),
  nm('有异议 / 不认可不通知 PM', [T_TRIG], 'confirm.js', "if (decision !== 'confirm') {", 'if (false) {'),
  nm('确认（confirm）也通知 PM', [T_TRIG], 'confirm.js', "if (decision !== 'confirm') {", 'if (true) {'),
  // ── 事务外发送 ──
  nm('提交后不派发（意图留在 pending）', [T_TRIG, T_SCHED], 'notify.js', 'dispatch(ids.slice());', ''),
  nm('发送成功不置 sent', [T_SEND], 'notify.js', "toStatus = 'sent'; attemptsAfter = intent.attempts + 1; lastError = null;", "toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = null;"),
  nm('发送成功不累加 attempts', [T_SEND], 'notify.js', "toStatus = 'sent'; attemptsAfter = intent.attempts + 1; lastError = null;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 1,", "toStatus = 'sent'; attemptsAfter = intent.attempts + 1; lastError = null;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 0,"),
  nm('发送失败不写 last_error', [T_SEND], 'notify.js', "toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = r.error;", "toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = null;"),
  nm('发送失败不累加 attempts', [T_SEND], 'notify.js', "toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = r.error;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 1,", "toStatus = 'failed'; attemptsAfter = intent.attempts + 1; lastError = r.error;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 0,"),
  nm('跳过的意图也累加 attempts', [T_SEND], 'notify.js', "toStatus = 'sent'; lastError = `无需发送：${r.reason}`;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, last_error = ?,", "toStatus = 'sent'; lastError = `无需发送：${r.reason}`;\n        up = await q.run(\"UPDATE sysbuild_send_intents SET status = ?, attempts = attempts + 1, last_error = ?,"),
  nm('回写不带旧状态条件（别处已改也覆盖）', [T_DEDUP], 'notify.js', "WHERE id = ? AND status = ?\", [toStatus, lastError, intent.id, intent.status]);\n      } else if (r.outcome === 'failed')", "WHERE id = ? AND ? IS NOT NULL\", [toStatus, lastError, intent.id, intent.status]);\n      } else if (r.outcome === 'failed')"),
  nm('不写 send_intent_attempted 事件的结果摘要', [T_SEND], 'notify.js', ": { reason: r.reason, errcode: r.errcode === undefined ? null : r.errcode, error: lastError, process_query_key: r.outcome === 'sent' && r.queryKey ? r.queryKey : null, channel_results: Array.isArray(r.channelResults) ? r.channelResults : [] },", ': null,'),
  nm('改期知会的发送结果不记 notice_attempts', [T_SCHED], 'notify.js', "if (intent.purpose === PURPOSES.SCHEDULE_NOTICE && r.outcome !== 'skipped') {", 'if (false) {'),
  // 修订批 3（N2）：渠道响应判定集中在 judgeChannelResponse，逐次留痕与最终结果共用，所以下面几条变异同时改了两处的判定（T_SEND 看最终结果，T_JUDGE 看留痕与最终一致）
  nm('errcode 非 0 不判失败', [T_SEND, T_JUDGE], 'notify.js', "if (res && res.errcode && res.errcode !== 0) {\n    const c = ctx.classify(res);", "if (false) {\n    const c = ctx.classify(res);"),
  nm('令牌失效不重试', [T_SEND], 'notify.js', 'if (!j.ok && j.tokenExpired) {', 'if (false) {'),
  nm('收件人在失效名单里也算成功', [T_SEND, T_JUDGE], 'notify.js', 'if (res && listHas(res.invalidStaffIdList)) return bad(', 'if (false) return bad('),
  nm('收件人被限流也算成功', [T_SEND, T_JUDGE], 'notify.js', 'if (res && listHas(res.flowControlledStaffIdList)) return bad(', 'if (false) return bad('),
  nm('收件人被过滤也算成功', [T_SEND, T_JUDGE], 'notify.js', 'if (res && listHas(res.filteredStaffIdList)) return bad(', 'if (false) return bad('),
  nm('没有消息标识也算成功', [T_SEND, T_JUDGE], 'notify.js', "if (!res || !res.processQueryKey) return bad(", 'if (false) return bad('),
  nm('配置缺失也照发', [T_SEND], 'notify.js', "if (!cfg.appKey || !cfg.appSecret || !cfg.robotCode) return fail(", 'if (false) return fail('),
  nm('没有钉钉号也不按手机号反查', [T_SEND, T_STUB], 'notify.js', 'if (direct) return { dingUserId: direct };', 'return { dingUserId: direct };'), // 修订批 4：反查逻辑抽成 resolveAddress，锚点随之改到「有钉钉号直接用」那一行（改成无条件直接用 = 没有钉钉号也不反查）
  nm('没有钉钉号也没有手机号也照发', [T_SEND], 'notify.js', "if (!phone) return fail('no_dingtalk_id'", "if (false) return fail('no_dingtalk_id'"),
  nm('失败原因不去掉令牌与凭证', [T_SEND, T_FIX], 'notify.js', "  for (const v of secrets || []) {\n    if (typeof v === 'string' && v.length >= 4) s = s.split(v).join('***');\n  }\n", ''),
  nm('platform_base_url 不取配置（链接一律相对路径）', [T_SEND], 'notify.js', 'const baseUrl = normalizeBaseUrl(cfg.baseUrl);', "const baseUrl = '';"),
  nm('base url 不合法也当有效', [T_FIX], 'notify.js', 'return /^https?:\\/\\/[^\\s]+$/i.test(v) ? v : \'\';', 'return v;'),
  nm('需求部门负责人也带对象摘要', [T_SEND], 'notify.js', FIXED, 'if (false) {'), // 修订批 1（L7）：改期知会的负责人文案走自己的分支，不再经过这个判断，所以只剩确认类用例能打红它
  nm('已发的意图再发', [T_SEND, T_DEDUP], 'notify.js', "if (data.intent.status === 'sent') return { id, outcome: 'already_sent' };", ''),
  nm('修订已不是待确认也照发', [T_SEND], 'notify.js', "if (rev.status !== 'pending') return skipWith('修订已不是待确认');", ''),
  nm('发送中的意图不挡并发', [T_DEDUP], 'notify.js', "if (inFlight[id] === true) return { id, outcome: 'in_flight' };", ''),
  nm('发送完不清发送中标记', [T_DEDUP, T_SEND], 'notify.js', '      delete inFlight[id];', ''),
  nm('待办每类上限放宽', [T_FIX], 'notify.js', 'const TODO_ITEM_CAP = 50;', 'const TODO_ITEM_CAP = 500;'),
  // ── 补发 / 扫描 ──
  nm('补发不重发失败的意图', [T_RESEND], 'notify.js', "(status = 'failed' OR (status = 'pending'", "(status = 'none' OR (status = 'pending'"),
  nm('补发把新建不足 5 分钟的 pending 也重发', [T_RESEND], 'notify.js', 'const args = [projectId, `-${notifyCore.RESEND_PENDING_MINUTES} minutes`];', 'const args = [projectId, `+1 days`];'),
  nm('补发不限本项目', [T_RESEND], 'notify.js', "const where = `project_id = ? AND (status = 'failed'", "const where = `? IS NOT NULL AND (status = 'failed'"),
  nm('补发对非 PM 放行', [T_RESEND], 'notify.js', "if (!rules.canActAsPm(access)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');", ''),
  nm('意图列表忽略 status 筛选', [T_RESEND], 'notify.js', '(? IS NULL OR i.status = ?)', '(? IS NULL OR 1 = 1 OR i.status = ?)'),
  nm('扫描连失败满 3 次的也重发', [T_SCAN], 'notify.js', "(status = 'failed' AND attempts < ?)) ORDER BY id LIMIT ?\"", "(status = 'failed' AND attempts < ? + 10)) ORDER BY id LIMIT ?\""),
  nm('后台任务开关 off 也扫描', [T_SCAN], 'notify.js', 'if (!backgroundJobs || readyScanned) return false;', 'if (readyScanned) return false;'),
  nm('就绪扫描可重复触发', [T_SCAN], 'notify.js', '    readyScanned = true;\n', ''),
  nm('PM 补发不写事件', [T_RESEND], 'notify.js', "eventType: 'send_intents_resent'", "eventType: 'send_intent_attempted'"),
  nm('事件类型 send_intent_attempted 未登记', [T_SEND], 'events.js', "'send_intent_attempted', 'send_intents_resent',", "'send_intents_resent',"),
  nm('非 PM 的项目详情也带发送失败条数', [T_RESEND], 'projects.js', 'if (identity.isPm === true) detail.notify =', 'if (true) detail.notify ='),
  // ── 待办 ──
  nm('待办 handle 被不认可的修订改发 / 出新结论后仍列', [T_TODO], 'notify.js', 'if (!(await declinedStillOpen(q, d))) continue;', ''),
  nm('待办 send_failed 读成已发', [T_TODO], 'notify-core.js', 'const intentFailedWhere = "(i.status = \'failed\' OR', 'const intentFailedWhere = "(i.status = \'sent\' OR'),
  nm('待办 overdue 超期天数缩成 1 天', [T_TODO], 'notify.js', '[p.id, `-${notifyCore.OVERDUE_DAYS} days`]', '[p.id, `-1 days`]'),
  nm('待办 PM 类别不限本人担任 PM 的项目', [T_TODO], 'notify.js', "FROM sysbuild_projects WHERE pm_user_id = ? ORDER BY id DESC', [uid]);", "FROM sysbuild_projects WHERE (pm_user_id = ? OR 1 = 1) ORDER BY id DESC', [uid]);"),
  // ── 改期知会生成 ──
  nm('plan.js 改期后不生成知会', [T_SCHED], 'plan.js', "await notifySchedule.createScheduleNotices(q, user, { projectId: node.project_id, node, recordId: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd } });", ''),
  nm('草稿期计划也生成改期知会', [T_SCHED], 'plan.js', "[nid, plannedStart, plannedEnd, loggedReason, uid]\n        );", "[nid, plannedStart, plannedEnd, loggedReason, uid]\n        );\n        await notifySchedule.createScheduleNotices(q, user, { projectId: node.project_id, node, recordId: ins.lastID, before: cur, after: { start: plannedStart, end: plannedEnd } });"),
  nm('提前也生成改期知会', [T_SCHED], 'notify-schedule.js', 'if (!(o.after.end > o.before.end)) return []; // 提前或同日不知会', 'if (false) return [];'),
  nm('同日也生成改期知会', [T_SCHED], 'notify-schedule.js', 'if (!(o.after.end > o.before.end)) return []; // 提前或同日不知会', 'if (!(o.after.end >= o.before.end)) return [];'),
  nm('非里程碑节点也生成改期知会', [T_SCHED], 'notify-schedule.js', 'if (!node || node.is_golive_milestone !== 1) return [];', 'if (!node) return [];'),
  nm('改期知会只给第一个需求部门', [T_SCHED], 'notify-schedule.js', 'for (const p of parties) {', 'for (const p of parties.slice(0, 1)) {'),
  nm('知会视图不带改期前后日期', [T_SCHED], 'entries.js', 'item.schedule = view;', ''),
  nm('知会视图的改前计划取最后一条（不是该记录之前的）', [T_SCHED], 'entries.js', "WHERE node_id = ? AND id < ? AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1", "WHERE node_id = ? AND ? > 0 AND kind IN ('baseline', 'plan_change') ORDER BY id DESC LIMIT 1"),
  // ── 改期知会：发送前复核（接收人仍是现任负责人；异议随 C6 删，变异 stop-only 退役）──
  nm('异议资格的「仍是现任负责人」恒为真', [T_STALE], 'notify-schedule.js', "stillOwner: !!cur && cur.memberId === m.id && !!party && party.side === 'demand',", 'stillOwner: true,'),
  // ── 常量与路由 ──
  nm('页面路由改了查询参数名', [T_FIX], 'notify-core.js', 'confirm: (projectId, revisionId) => `${PAGE}?project=${projectId}&rev=${revisionId}`,', 'confirm: (projectId, revisionId) => `${PAGE}?project=${projectId}&revision=${revisionId}`,'),
  nm('超期天数常量被改', [T_FIX], 'notify-core.js', 'const OVERDUE_DAYS = 3;', 'const OVERDUE_DAYS = 7;'),
  nm('补发的 pending 阈值被改', [T_FIX], 'notify-core.js', 'const RESEND_PENDING_MINUTES = 5;', 'const RESEND_PENDING_MINUTES = 30;'),
  nm('扫描的 attempts 阈值被改', [T_FIX], 'notify-core.js', 'const SCAN_MAX_ATTEMPTS = 3;', 'const SCAN_MAX_ATTEMPTS = 10;'),
  nm('发送意图用途集合漏了改期知会', [T_FIX], 'notify-core.js', "  SCHEDULE_NOTICE: 'schedule_notice', // 改期知会 → 需求部门现任负责人\n", ''),
  nm('入参校验不拒绝缺收件人', [T_FIX], 'notify-core.js', "if (!Number.isSafeInteger(a.recipientUserId) || a.recipientUserId <= 0) throw internal('发送意图缺收件人');", ''),
  // ── 修订批 1（预筛 1）：K1 发送前复核收件人资格（每条判据至少一条）──
  nm('R1 K1 确认类不复核收件人就是该修订的必需确认人', [T_STALE], 'notify.js', "if (rev.required_user_id === null || rev.required_user_id === undefined || Number(rev.required_user_id) !== Number(intent.recipient_user_id)) return skipWith('收件人已不是该修订的必需确认人');", ''),
  nm('R1 K1 确认类不复核修订是任务最新修订', [T_STALE], 'notify.js', "if (rev.rev_no !== rev.latest_rev_no) return skipWith('修订已被改发（不是该任务的最新修订）');", ''),
  nm('R1 K1 确认类不调共用的资格复核（confirmAvailabilityBlock）', [T_STALE], 'notify.js', 'if (user) {\n          const block = await core.confirmAvailabilityBlock(', 'if (false) {\n          const block = await core.confirmAvailabilityBlock('),
  nm('R1 K1 共用复核不核项目对收件人可见', [T_STALE], 'confirm-core.js', "if (!info.visible) return '收件人看不到该项目';", ''),
  nm('R1 K1 共用复核不核项目状态允许作出确认', [T_STALE], 'confirm-core.js', "if (!info.canDecide) return '项目当前状态不允许作出这项确认';", ''),
  nm('R1 K1 收件人账号停用也发', [T_STALE], 'notify.js', "const disabled = !!user && user.status !== 'active';", 'const disabled = false;'),
  nm('R1 K1 不认可通知不核收件人仍是现任 PM', [T_STALE], 'notify.js', "if (!proj || proj.pm_user_id === null || proj.pm_user_id === undefined || Number(proj.pm_user_id) !== Number(intent.recipient_user_id)) return skipWith('收件人已不是本项目现任项目经理');", ''),
  nm('R1 K1 不认可通知不核修订仍是任务最新修订', [T_STALE], 'notify.js', "if (rev.rev_no !== rev.latest_rev_no) return skipWith('该确认已改发（不是该任务的最新修订）');", ''),
  nm('R1 K1 不认可通知不核异议仍待处理（declinedStillOpen）', [T_STALE], 'notify.js', "if (!(await declinedStillOpen(q, rev))) return skipWith('该确认的异议 / 不认可已处理（已改发或已出新版本）');", ''),
  nm('R1 K1 改期知会不复核（整段）', [T_STALE], 'notify.js', 'if (intent.purpose === PURPOSES.SCHEDULE_NOTICE) {\n        // K1：', 'if (false) {\n        // K1：'),
  nm('R1 K1 改期知会接收人已移出也发', [T_STALE], 'notify.js', "if (!mem || mem.removed_at !== null || mem.joined_at === null) return skipWith('接收人已不是本项目成员');", ''),
  nm('R1 K1 改期知会接收人账号与知会不符也发', [T_STALE], 'notify.js', "if (facts.recipientUserId === null || facts.recipientUserId !== Number(intent.recipient_user_id)) return skipWith('接收人账号与知会不符');", ''),
  nm('R1 K1 改期知会接收人不再是现任负责人也发', [T_STALE], 'notify.js', "if (!facts.stillOwner) return skipWith('接收人已不是该参与方的现任负责人');", ''),
  nm('R1 K1 站内待我确认不调共用复核', ['C4a 待我确认'], 'confirm.js', 'if ((await core.confirmAvailabilityBlock(q, r, user, accessOpts(), projectInfo)) !== null) continue;', ''),
  // ── K2 无账号负责人的改期知会失败要让 PM 看见 ──
  // ── K3 成功时记渠道返回 ──
  nm('R1 K3 成功不带回消息标识', [T_SEND, T_SCHED], 'notify.js', 'link: msg.link, queryKey: scrub(String(res.processQueryKey), secrets) };', 'link: msg.link };'),
  nm('R1 K3 事件 response 不记消息标识', [T_SEND], 'notify.js', ", process_query_key: r.outcome === 'sent' && r.queryKey ? r.queryKey : null, channel_results:", ', channel_results:'),
  nm('R1 K3 发送尝试仍记固定 ok', [T_SCHED], 'notify.js', "r.outcome === 'sent' ? (r.queryKey || 'ok') : scrub(r.reason)", "r.outcome === 'sent' ? 'ok' : scrub(r.reason)"),
  // ── L1 / L2 / L3 / L4 ──
  nm('R1 L2 系统操作人名不是「系统」', [T_SEND], 'notify.js', "display_name: '系统' });", "display_name: '系统（钉钉通知）' });"),
  nm('R1 L3 待发送超时的 pending 不计入失败', [T_RESEND], 'notify-core.js', "const intentFailedWhere = \"(i.status = 'failed' OR (i.status = 'pending' AND i.created_at <= datetime('now','localtime', ?)))\";", "const intentFailedWhere = \"(i.status = 'failed' AND ? IS NOT NULL)\";"),
  nm('R1 L3 待发送超时条目不写「待发送超时」文案', [T_RESEND], 'notify-core.js', 'last_error: f.status === \'failed\' ? f.last_error : PENDING_TIMEOUT_TEXT,', 'last_error: f.last_error,'),
  nm('R1 L4 补发遇到系统性失败不中止本批', [T_RESEND], 'notify.js', "results.push(x);\n        if (x.outcome === 'failed' && x.systemic === true) {", "results.push(x);\n        if (false) {"),
  nm('R1 L4 取令牌失败不算系统性失败', [T_RESEND], 'notify.js', '{ errcode: c.errcode, systemic: true }); // L4：', '{ errcode: c.errcode }); // L4：'),
  nm('R1 L4 配置缺失不算系统性失败', [T_RESEND], 'notify.js', "fail('no_config', '钉钉配置缺失（凭证未填写）', { systemic: true })", "fail('no_config', '钉钉配置缺失（凭证未填写）')"),
  nm('R1 L4 发送时的网络类失败不算系统性失败', [T_RESEND], 'notify.js', "return fail(`send_${c.reason || 'error'}`, scrub(why('send', c, e), secrets.concat([dingUserId])), { errcode: c.errcode, systemic: isSystemicReason(c.reason) });","return fail(`send_${c.reason || 'error'}`, scrub(why('send', c, e), secrets.concat([dingUserId])), { errcode: c.errcode });"),
  nm('R1 L4 响应不带中止原因', [T_RESEND], 'notify.js', 'res.json({ project_id: pid, counts: done.counts, aborted: done.aborted, results:', 'res.json({ project_id: pid, counts: done.counts, results:'),
  nm('R1 L4 补发事件不记中止原因', [T_RESEND], 'notify.js', 'intent_ids: done.results.map((r) => r.id), aborted: done.aborted }', 'intent_ids: done.results.map((r) => r.id) }'),
  nm('R1 L4 剩余条数按上限而不是实际处理数算', [T_RESENDCAP], 'notify.js', 'counts.remaining = snap.total - results.length;', 'counts.remaining = snap.rows.length - results.length;'), // 修订批 2（M3）：remaining 按候选总数算，改回按取到的条数算即回到修订批 1 的低报
  // ── L5 补断言 ──
  nm('R1 L5 开发方负责人也走固定文案（isDemandOwnerUser 不限需求方）', [T_DEVMSG], 'notify.js', "AND p.project_id = ? AND p.side = 'demand' AND m.user_id = ?", 'AND p.project_id = ? AND m.user_id = ?'),
  nm('R1 L5 知会路由参数名被改', [T_FIX, T_SCHED], 'notify-core.js', 'notice: (projectId, noticeId) => `${PAGE}?project=${projectId}&notice=${noticeId}`,', 'notice: (projectId, noticeId) => `${PAGE}?project=${projectId}&n=${noticeId}`,'),
  nm('R1 L5 发送意图列表路由被改', [T_FIX], 'notify-core.js', '&view=send-intents`,', '&view=intents`,'),
  nm('R1 L5 不认可通知的摘要不带前缀', [T_TRIG], 'notify.js', 'summary: intent.purpose === PURPOSES.DECISION_OBJECTED ? `有确认被提出异议或不认可：${base}` : base', 'summary: base'),
  nm('R1 L5 不认可通知标题被改', [T_TRIG], 'notify.js', "[PURPOSES.DECISION_OBJECTED]: '确认被提出异议或不认可',", "[PURPOSES.DECISION_OBJECTED]: '异议',"),
  nm('R1 L5 非负责人的改期知会标题被改', [T_FIX], 'notify.js', "[PURPOSES.SCHEDULE_NOTICE]: '改期知会',", "[PURPOSES.SCHEDULE_NOTICE]: '知会',"),
  // ── L6 / L7 / L8 / L9 ──
  nm('R1 L6 决策人就是 PM 也写不认可通知', [T_NOPM], 'notify-core.js', 'if (o.actorUserId !== undefined && Number(p.pm_user_id) === Number(o.actorUserId)) return null;', ''),
  nm('R1 L6 调用方不传决策人', [T_NOPM], 'confirm.js', 'refId: c.latest.id, actorUserId: c.requiredUserId });', 'refId: c.latest.id });'),
  nm('R1 L7 改期知会对负责人仍用确认类固定文案', [T_SCHED, T_FIX], 'notify.js', 'if (data.ownerRecipient && data.intent.purpose === PURPOSES.SCHEDULE_NOTICE) {', 'if (false) {'),
  nm('R1 L7 改期知会链接文字仍是「打开确认」', [T_SCHED, T_FIX], 'notify.js', "const NOTICE_LINK_LABEL = '打开查看';", "const NOTICE_LINK_LABEL = '打开确认';"),
  // ── K5 主会话裁定 ──
  nm('#212 B2.2 角标遗漏待确认', [T_TODO], 'notify.js', 'counts.badge = counts.confirm;', 'counts.badge = 0;'),
  // ── 修订批 2（codex 28 / 预筛 2）──
  nm('R2 M1 扫描只处理第一批', [T_SCANBATCH], 'notify.js', 'if (rows.length < scanBatchCap) break;', 'break;'),
  nm('R2 M1 扫描游标不前进', [T_SCANBATCH], 'notify.js', 'cursor = rows[rows.length - 1].id;', 'cursor = 0;'),
  nm('R2 M1 扫描批间不让出事件循环', [T_SCANBATCH], 'notify.js', 'await new Promise((resolve) => setImmediate(resolve));', ''),
  nm('R2 M1 扫描每批条数不取注入值', [T_SCANBATCH], 'notify.js', 'const scanBatchCap = Number.isSafeInteger(opts.scanBatchCap) && opts.scanBatchCap > 0 ? opts.scanBatchCap : SCAN_BATCH_CAP;', 'const scanBatchCap = SCAN_BATCH_CAP;'),
  nm('R2 M3 补发单次上限不取注入值', [T_RESENDCAP], 'notify.js', 'const resendBatchCap = Number.isSafeInteger(opts.resendBatchCap) && opts.resendBatchCap > 0 ? opts.resendBatchCap : RESEND_BATCH_CAP;', 'const resendBatchCap = RESEND_BATCH_CAP;'),
  nm('R2 M3 候选总数少算一条', [T_RESENDCAP], 'notify.js', 'return { rows, total: tot ? Number(tot.n) : rows.length };', 'return { rows, total: (tot ? Number(tot.n) : rows.length) - 1 };'),
  nm('R2 M4 首次发送的渠道结果不留痕', [T_TRAIL], 'notify.js', "noteJudged('send', res, j);", ''),
  nm('R2 M4 令牌失效后的重发结果不留痕', [T_TRAIL, T_JUDGE], 'notify.js', "noteJudged('retry', res, j);", ''),
  nm('R2 M4 刷新令牌失败不留痕', [T_TRAIL], 'notify.js', "noteThrown('refresh_token', e);", ''),
  nm('R2 M4 事件不带渠道结果数组', [T_TRAIL], 'notify.js', ', channel_results: Array.isArray(r.channelResults) ? r.channelResults : [] }', ' }'),
  nm('R2 M4 发送函数不带回渠道结果数组', [T_TRAIL], 'notify.js', 'r.channelResults = trail;', ''),
  nm('R2 L1 whenIdle 不跟踪直接调用的 deliverIntent', [T_IDLE], 'notify.js', 'function deliverIntent(id, o) {\n    return track(async () => {', 'function deliverIntent(id, o) {\n    return ((fn) => fn())(async () => {'),
  nm('R2 L1 whenIdle 不跟踪直接调用的 resendProject', [T_IDLE], 'notify.js', 'function resendProject(projectId, user) {\n    return track(async () => {', 'function resendProject(projectId, user) {\n    return ((fn) => fn())(async () => {'),
  nm('R2 L1 whenIdle 不跟踪直接调用的 scan', [T_IDLE], 'notify.js', 'function scan() {\n    return track(async () => {', 'function scan() {\n    return ((fn) => fn())(async () => {'),
  nm('R2 LOW-b 限流 / 无权限不算系统性失败', [T_SYSTEMIC], 'notify.js', 'systemic: isSystemicReason(c.reason), tokenExpired: c.reason', 'tokenExpired: c.reason'),
  nm('R2 LOW-b 系统性原因漏了限流', [T_SYSTEMIC], 'notify.js', "Object.freeze(['rate_limit', 'no_scope'])", "Object.freeze(['no_scope'])"),
  nm('R2 LOW-b 系统性原因漏了应用未开通权限', [T_SYSTEMIC], 'notify.js', "Object.freeze(['rate_limit', 'no_scope'])", "Object.freeze(['rate_limit'])"),
  nm('R2 LOW-b 机器人编码无效不算系统性失败', [T_SYSTEMIC], 'notify.js', "机器人编码无效或机器人未启用，消息未送达', { systemic: true });", "机器人编码无效或机器人未启用，消息未送达');"),
  nm('R2 LOW-b 不识别机器人编码无效的响应', [T_SYSTEMIC], 'notify.js', '/robot/i.test(', '/robotXXX/i.test('),
  nm('R2 P186 停用账号仍记「无需发送」终态', [T_DISABLED, T_STALE], 'notify.js', 'if (data.failWith) return fail(data.failWith.reason, data.failWith.error);', "if (data.failWith) return { outcome: 'skipped', reason: data.failWith.error };"),
  nm('R2 P186 停用账号的失败被当作系统性失败（补发中止）', [T_STALE], 'notify.js', 'return fail(data.failWith.reason, data.failWith.error);', 'return fail(data.failWith.reason, data.failWith.error, { systemic: true });'),
  // ── 修订批 3（codex 28-R：N1–N3；预筛 3：MED-B、LOW-1–3）──
  // MED-B：发送前复核先按与账号状态无关的条件判永久失格，账号停用最后才记 failed
  nm('R3 MED-B 确认类资格复核仍把账号状态并进判定（忽略开关失效）', [T_DISCOMBO, T_STALE, T_DISABLED], 'confirm-core.js', 'o && o.ignoreAccountStatus === true ? rules.MEMBER_ACTIVE_SQL : CONFIRMER_ELIGIBLE_SQL', 'false ? rules.MEMBER_ACTIVE_SQL : CONFIRMER_ELIGIBLE_SQL'),
  nm('R3 MED-B 发送侧确认类复核不传「忽略账号状态」', [T_DISCOMBO, T_STALE], 'notify.js', 'accessOpts(), {}, NO_ACCOUNT_STATE);', 'accessOpts(), {});'),
  nm('R3 MED-B 改期知会接收人复核不传「忽略账号状态」', [T_DISCOMBO], 'notify.js', 'scheduleNoticeObjectorFacts(q, n, NO_ACCOUNT_STATE);', 'scheduleNoticeObjectorFacts(q, n);'),
  nm('R3 MED-B 知会现任负责人判定不透传「忽略账号状态」', [T_DISCOMBO], 'notify-schedule.js', 'await core.currentOwner(q, m.party_id, o)', 'await core.currentOwner(q, m.party_id)'),
  {
    id: 'C6b R3 MED-B 可恢复条件盖过永久失格（账号停用叠加移出 / 已确认 / 已改发也记 failed）',
    expect: [T_DISCOMBO],
    edits: [
      { file: 'notify.js', from: '    if (!ref.skip) {', to: '    {' },
      { file: 'notify.js', from: "    if (data.skip) return { outcome: 'skipped', reason: data.skip };\n    if (data.failWith) return fail(data.failWith.reason, data.failWith.error);", to: "    if (data.failWith) return fail(data.failWith.reason, data.failWith.error);\n    if (data.skip) return { outcome: 'skipped', reason: data.skip };" },
    ],
  },
  // N3：每次实际外发前重新复核
  nm('R3 N3 首次外发前不复核', [T_RECHECK], 'notify.js', 'const verdict1 = await settle(token);\n    if (verdict1) return verdict1;', ''),
  nm('R3 N3 令牌刷新后重试前不采纳复核结论（刷新期间被移出 / 停用仍发第二次）', [T_RECHECK], 'notify.js', 'if (verdict2) return verdict2;', ''),
  nm('R3 N3 复核结论里账号停用被忽略（取令牌期间停用仍发）', [T_RECHECK], 'notify.js', '      const v = verdictOf(fresh);\n      if (v) return v;', '      const v = fresh.skip ? verdictOf(fresh) : null;\n      if (v) return v;'),
  nm('R3 N3 复核后不重算消息（沿用加载意图时的身份）', [T_RECHECK], 'notify.js', 'cur = Object.assign({}, data, { user: fresh.user, summary: fresh.summary, route: fresh.route, ownerRecipient: fresh.ownerRecipient, systemName: fresh.systemName });', 'cur = data;'),
  nm('R3 N3 令牌刷新后重试前不重建消息', [T_RECHECK], 'notify.js', '      msg = buildMessage(cur, baseUrl);\n      try {\n        res = await attempt(fresh);', '      try {\n        res = await attempt(fresh);'),
  nm('R3 N3 意图状态被别处改变也照发', [T_RECHECK], 'notify.js', "if (fresh.intent.status !== data.intent.status) return { outcome: 'skipped', reason: '意图状态已被其他处理改变' };", ''),
  nm('R3 N3 复核时意图行已不存在不处理（空指针）', [T_RECHECK], 'notify.js', "if (!fresh) return { outcome: 'skipped', reason: '意图已不存在' };", ''),
  // N2：渠道响应统一判定
  nm('R3 N2 逐次留痕恒记 ok（不用统一判定）', [T_JUDGE, T_TRAIL], 'notify.js', "outcome: j.ok ? 'ok' : 'failed', reason: j.reason, errcode: j.errcode,", "outcome: 'ok', reason: j.reason, errcode: j.errcode,"),
  nm('R3 N2 逐次留痕的原因不取判定结果', [T_JUDGE, T_TRAIL], 'notify.js', "outcome: j.ok ? 'ok' : 'failed', reason: j.reason, errcode: j.errcode,", "outcome: j.ok ? 'ok' : 'failed', reason: 'ok', errcode: j.errcode,"),
  nm('R3 N2 逐次留痕不记渠道错误码', [T_JUDGE, T_TRAIL], 'notify.js', "outcome: j.ok ? 'ok' : 'failed', reason: j.reason, errcode: j.errcode,", "outcome: j.ok ? 'ok' : 'failed', reason: j.reason, errcode: null,"),
  nm('R3 N2 最终结果的原因不取判定结果', [T_JUDGE], 'notify.js', 'if (!j.ok) return fail(j.failReason, j.error,', "if (!j.ok) return fail('send_failed', j.error,"),
  nm('R3 N2 令牌失效重发后不重新判定（沿用首次结果）', [T_TRAIL, T_JUDGE], 'notify.js', "j = judge(res);\n      noteJudged('retry', res, j);", "noteJudged('retry', res, j);"),
  // N1：补发候选不饿死
  nm('R3 N1 补发候选回到按 id 升序', [T_NOSTARVE, T_RESEND], 'notify.js', 'ORDER BY (attempts > 0), updated_at, attempts, id LIMIT ?', 'ORDER BY id LIMIT ?'),
  nm('R3 N1 补发不让从未尝试的优先', [T_NOSTARVE], 'notify.js', 'ORDER BY (attempts > 0), updated_at, attempts, id LIMIT ?', 'ORDER BY updated_at, attempts, id LIMIT ?'),
  nm('R3 N1 补发不按上次尝试时间排', [T_NOSTARVE], 'notify.js', 'ORDER BY (attempts > 0), updated_at, attempts, id LIMIT ?', 'ORDER BY (attempts > 0), attempts, id LIMIT ?'),
  nm('R3 N1 同一秒内不按 attempts 少的在前', [T_NOSTARVE], 'notify.js', 'ORDER BY (attempts > 0), updated_at, attempts, id LIMIT ?', 'ORDER BY (attempts > 0), updated_at, id LIMIT ?'),
  // 预筛 LOW-1：扫描与补发同一规则
  nm('R3 LOW-1 扫描遇到系统性失败不中止', [T_SCANABORT], 'notify.js', "results.push(x);\n          if (x.outcome === 'failed' && x.systemic === true) {", 'results.push(x);\n          if (false) {'),
  nm('R3 LOW-1 扫描只中止当前批不中止本轮', [T_SCANABORT], 'notify.js', 'if (aborted !== null) break;', ''),
  nm('R3 LOW-1 扫描结果不带 aborted', [T_SCANABORT], 'notify.js', 'Object.assign(tally(results), { results, aborted })', 'Object.assign(tally(results), { results })'),
  // 预筛 LOW-2 → P187：终止项目里待处理的邀请 / 授权记 failed（可恢复）
  // 预筛 LOW-3 → P188：待办 counts / items 拆出 needs_offline
  // ── 修订批 4（codex 28-R2：O1–O3）──
  // O1：外发前复核最新账号行与钉钉地址
  nm('R4 O1 重检不核账号行是否还在', [T_ADDR], 'notify.js', "if (!fresh.user) return { outcome: 'skipped', reason: '收件人账号已不存在' };", ''),
  nm('R4 O1 复核后不比较钉钉地址（沿用解析时的地址）', [T_ADDR], 'notify.js', 'if (key === usedAddrKey) return null;', 'return null;'),
  nm('R4 O1 地址变化后不换用重新解析的地址', [T_ADDR], 'notify.js', 'dingUserId = re.dingUserId;\n        usedAddrKey = key;', 'usedAddrKey = key;'),
  nm('R4 O1 重新解析失败仍外发', [T_ADDR], 'notify.js', 'if (re.outcome) return re;', ''),
  nm('R4 O1 重新解析之后不再复核', [T_ADDR], 'notify.js', 'dingUserId = re.dingUserId;\n        usedAddrKey = key;', 'dingUserId = re.dingUserId;\n        usedAddrKey = key;\n        return null;'),
  nm('R4 O1 令牌刷新后的重试不核最新地址', [T_ADDR], 'notify.js', 'const verdict2 = await settle(fresh);', 'const verdict2 = await recheck();'),
  nm('R4 O1 地址依据只看钉钉号不看手机号', [T_ADDR], 'notify.js', "return d ? `d:${d}` : `p:${trimText(u && u.phone)}`;", "return d ? `d:${d}` : 'p:';"),
  nm('R4 O1 地址依据只看手机号不看钉钉号', [T_ADDR], 'notify.js', "return d ? `d:${d}` : `p:${trimText(u && u.phone)}`;", 'return `p:${trimText(u && u.phone)}`;'),
  nm('R4 O1 地址持续变化仍外发', [T_ADDR], 'notify.js', "return fail('recipient_changing', '收件人的钉钉账号信息在发送前持续变化，本次未发送（稍后补发 / 扫描会再试）');", 'return null;'),
  nm('R4 O1 复核后的账号行不带进当前身份', [T_ADDR], 'notify.js', '{ user: fresh.user, summary: fresh.summary,', '{ summary: fresh.summary,'),
  // O2：停用的负责人不漏建改期知会
  nm('R4 O2 改期知会选负责人仍要求账号启用', [T_SCHEDDIS], 'notify-schedule.js', 'await core.currentOwner(q, p.id, { ignoreAccountStatus: true })', 'await core.currentOwner(q, p.id)'),
  // O3：抛异常分支的系统性判定与返回错误同源
  nm('R4 O3 首次发送抛异常只按网络类判系统性', [T_THROWSYS], 'notify.js', "scrub(why('send', c, e), secrets.concat([dingUserId])), { errcode: c.errcode, systemic: isSystemicReason(c.reason) })", "scrub(why('send', c, e), secrets.concat([dingUserId])), { errcode: c.errcode, systemic: SYSTEMIC_NET_REASONS.includes(c.reason) })"),
  nm('R4 O3 刷新令牌抛异常只按网络类判系统性', [T_THROWSYS], 'notify.js', "noteThrown('refresh_token', e);\n        const c2 = classify(e);\n        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: isSystemicReason(c2.reason) });", "noteThrown('refresh_token', e);\n        const c2 = classify(e);\n        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: SYSTEMIC_NET_REASONS.includes(c2.reason) });"),
  nm('R4 O3 令牌刷新后重发抛异常只按网络类判系统性', [T_THROWSYS], 'notify.js', "noteThrown('retry', e);\n        const c2 = classify(e);\n        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: isSystemicReason(c2.reason) });", "noteThrown('retry', e);\n        const c2 = classify(e);\n        return fail(`retry_${c2.reason || 'error'}`, scrub(why('retry', c2, e), secrets.concat([dingUserId])), { errcode: c2.errcode, systemic: SYSTEMIC_NET_REASONS.includes(c2.reason) });"),
  nm('R4 O3 手机号反查抛异常只按网络类判系统性', [T_THROWSYS], 'notify.js', "scrub(why('get_by_mobile', c, e), secrets.concat([phone])), { errcode: c.errcode, systemic: isSystemicReason(c.reason) })", "scrub(why('get_by_mobile', c, e), secrets.concat([phone])), { errcode: c.errcode, systemic: SYSTEMIC_NET_REASONS.includes(c.reason) })"),
  nm('R4 O3 系统性判定的统一出口漏了应用层原因', [T_THROWSYS, T_SYSTEMIC], 'notify.js', 'SYSTEMIC_NET_REASONS.includes(reason) || SYSTEMIC_APP_REASONS.includes(reason);', 'SYSTEMIC_NET_REASONS.includes(reason);'),
];

module.exports = { makeDingDouble, defineNotifyCases, NOTIFY_MUTATIONS, T_NAMES: { T_TRIG, T_DEVMSG, T_C6_R7, T_ROLLBACK, T_SEND, T_DEDUP, T_RESEND, T_SCAN, T_TODO, T_SCHED, T_STUB, T_FIX, T_STALE, T_NOPM, T_SCANBATCH, T_RESENDCAP, T_TRAIL, T_IDLE, T_SYSTEMIC, T_DISABLED, T_DISCOMBO, T_RECHECK, T_JUDGE, T_NOSTARVE, T_SCANABORT, T_ADDR, T_SCHEDDIS, T_THROWSYS }, nm };
