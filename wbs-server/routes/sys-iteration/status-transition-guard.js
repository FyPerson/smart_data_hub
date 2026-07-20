// routes/sys-iteration/status-transition-guard.js — assertMainStatusTransition（C2 交付物①）
//   SSOT = 方案 v2.9 §1 不变量 7（三层组合）+ 开发计划 v2.9 §2.6（routeKind×目标族白名单，联合 SSOT）
//
// ⚠️ C2 范围声明（红线）：本模块**完整实现**全部 routeKind 分支（CREATE/GATE/ADMIN_TRANSITION/RELEASE/RESET），
//   但 C2 只在 index.js 里接线 CREATE（W01 建单）与 GATE（W-GATE）两个调用方——ADMIN_TRANSITION（W07 状态流转
//   端点 /assign /schedule /accept 等）与 RELEASE（发布/hotfix）切换属 C3 范围，本次不改它们的调用路径，
//   只保证本函数自身对这两个 routeKind 的判断逻辑是完整、可独立单测的（verify 脚本对它们做纯函数直调断言，
//   不接 HTTP 端点）。
//
// 三层组合与函数签名的关系（工程取舍说明）：
//   方案 §1 原文"内部按序"①②③，但③"进族门禁"需要活体 roster 数据（在册计数/是否全完成态）——这类数据必须
//   在调用方的同一事务内查询（不变量 8：成员写+选举+门禁+主状态+event 同一事务），一个不接 db 的纯函数无法
//   自己去查。故本函数签名扩展方案原文的 6 个位置参数，加一个可选的第 7 参数 `rosterInfo`
//   `{ activeCount, allComplete }`——调用方在同一事务内查完 roster 后传入；不需要③层的 routeKind/edge 组合
//   （即 after 不落在 SYS_DEV/SYS_VERIFY 族，或本就在该族内的"横向"转移）不必传。①②层保持纯函数、不接 db，
//   可直接单测。三层仍是"同一次调用内按序执行"的组合，只是③层的输入来源从"函数内部查询"改为"调用方传入"，
//   语义不变、只是依赖注入方式不同（避免给一个状态机守卫函数硬绑 db 连接这个新的隐式依赖面）。
'use strict';

const SF = require('./status-families');
const T = require('./transitions');

// 结构化错误——不用 index.js 内的 SysTransitionError（本模块不依赖 index.js，防循环依赖）；
// 调用方 catch 后按 .httpStatus/.code/.message 转换（index.js 的 sendSysTransitionError 已加一段
// duck-typing 兼容，见该函数改动注释）。
class MainStatusGuardError extends Error {
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'MainStatusGuardError';
    this.httpStatus = httpStatus;
    this.code = code;
  }
}

const ROUTE_KINDS = ['CREATE', 'ADMIN_TRANSITION', 'GATE', 'RELEASE', 'RESET'];
const RELEASE_ACTION_KINDS = ['publish', 'hotfix', 'execute'];

// 白名单外 / 边非法 / 未知状态 → 409（状态机排他冲突，方案 §10）。
function reject409(msg) { throw new MainStatusGuardError(409, 'GATE_INVARIANT', msg); }
// 进族门禁（roster 不满足）→ 400（请求破坏门禁不变量，方案 §10：进族零在册 = 400 一例）。
function reject400(msg) { throw new MainStatusGuardError(400, 'GATE_INVARIANT', msg); }

// routeKind → 允许的「目标基础族」白名单（开发计划 v2.9 §2.6 表，联合 SSOT）。RESET 不改主状态，不在此列。
const ALLOWED_TARGET_FAMILIES = {
  // 受理排期改造 §9/§B：CREATE 可落 INTAKE(待受理)/D_PRE(待指派/待处理)/DEV(A 路径 assign)；
  //   ADMIN_TRANSITION 加 INTAKE——intake_accept/return/resubmit/change_intake_mode/reactivate 可进出 INTAKE 态（受理门流转）。
  CREATE: ['INTAKE', 'D_PRE', 'DEV'],
  GATE: ['DEV', 'VERIFY'],
  ADMIN_TRANSITION: ['INTAKE', 'D_PRE', 'DEV', 'VERIFY', 'NONRELEASE_TERMINAL', 'RELEASE'],
  RELEASE: ['RELEASE'],
};

// H1（91 号审）：RELEASE 的 action×actionKind 合法配对（开发计划 §2.5——publish=变更流 publish 动作／
//   hotfix=bug execute-release mode=hotfix／execute=bug execute-release mode=publish）。不在此表内的组合
//   一律拒绝（防调用方传错配对，如 action='publish' 却传 actionKind='hotfix'）。
const RELEASE_ACTION_ACTIONKIND_PAIRS = {
  publish: ['publish'],
  'execute-release': ['hotfix', 'execute'],
};

/**
 * assertMainStatusTransition —— 不变量 7 三层组合的统一入口。
 * @param {object} p
 * @param {'CREATE'|'ADMIN_TRANSITION'|'GATE'|'RELEASE'|'RESET'} p.routeKind
 * @param {string|null} p.action - CREATE 固定 'create'；ADMIN_TRANSITION 传 findTransition 解析出的具名 action
 *   （accept/resume/schedule/close/...）；RELEASE 传实际 action（publish/execute-release，供上层记录，本函数
 *   校验用 actionKind 不用这个字段）；GATE 恒 null，本函数强制校验其为 null（合成边，无统一动作码）。
 * @param {'publish'|'hotfix'|'execute'|null} p.actionKind - 仅 RELEASE 必填三值枚举，其余 routeKind 必须为 null。
 * @param {string} p.issueType
 * @param {string|null} p.before - CREATE 专属 null；其余 routeKind 必须是该 issueType 的已知状态。
 * @param {string} p.after - 目标状态，必须是该 issueType 的已知状态。
 * @param {number} [p.rosterActiveCount] - 进族门禁③层用：当前在册（含即将生效的写入，同事务内查）计数。
 * @param {boolean} [p.rosterAllComplete] - 进族门禁③层用：在册是否全员完成态（无 pending）。
 *   H1（对抗审 2026-07-17 引入·95 号复审收口为完整版）：afterFamily=SYS_RELEASE（ADMIN_TRANSITION 的
 *   accept/resume 两条具名边进「待上线」／RELEASE 的 publish/hotfix/execute 进「已上线」）**同等**复用本参数
 *   校验「在册≥1 ∧ 全员完成态」——不再区分 routeKind（C0 reset 脚本已改为按族区分回填，RELEASE 族单不再被
 *   置成全 pending，见该门禁分支注释）。
 * @returns {{ ok: true, afterFamily: string|null }}
 * @throws {MainStatusGuardError}
 */
function assertMainStatusTransition(p) {
  const { routeKind, action, actionKind, issueType, before, after, rosterActiveCount, rosterAllComplete } = p || {};

  if (!ROUTE_KINDS.includes(routeKind)) reject409(`未知 routeKind: ${routeKind}`);
  if (!SF.isKnownIssueType(issueType)) reject409(`未知 issue_type: ${issueType}（族外，不变量 7 ②层）`);

  // RESET（H1·91 号审 fail-closed 收口）：一次性例外，本身不改主状态——C0 重置脚本走内联实现，不调用本函数
  //   （当前无调用方，本分支仅为白名单完整性保留）。既然"不改主状态"，唯一合法输入形状=before/after 均为该
  //   issueType 已知状态且相等、action/actionKind 均不传——任何偏离都 fail-closed 拒绝，不再无条件放行。
  if (routeKind === 'RESET') {
    if (action !== null && action !== undefined) reject409('RESET routeKind 不应传 action');
    if (actionKind !== null && actionKind !== undefined) reject409('RESET routeKind 不应传 actionKind');
    const allowed = T.ALLOWED_STATUSES[issueType] || [];
    if (!allowed.includes(before) || !allowed.includes(after)) reject409(`RESET 要求 before/after 均为已知状态，实际 before=${before} after=${after}`);
    if (before !== after) reject409(`RESET 不改主状态，要求 before===after，实际 before=${before} after=${after}`);
    return { ok: true, afterFamily: null };
  }

  // GATE 的 action 恒 null（合成边）；其余 routeKind 必须传 action。
  if (routeKind === 'GATE') {
    if (action !== null && action !== undefined) reject409('GATE routeKind 的 action 必须为 null（合成边，不传不校）');
  } else if (routeKind === 'CREATE') {
    if (action !== 'create') reject409(`CREATE routeKind 的 action 必须固定为 'create'，实际=${action}`);
  } else if (routeKind === 'ADMIN_TRANSITION') {
    if (typeof action !== 'string' || !action) reject409('ADMIN_TRANSITION 必须传 findTransition 解析出的具名 action（resume 亦须传 action="resume"）');
  } else if (routeKind === 'RELEASE') {
    if (!RELEASE_ACTION_KINDS.includes(actionKind)) {
      reject409(`RELEASE routeKind 必须传合法 actionKind∈{${RELEASE_ACTION_KINDS.join(',')}}，实际=${actionKind}`);
    }
    // H1（91 号审）：action×actionKind 配对校验——仅 publish+publish / execute-release+hotfix /
    //   execute-release+execute 三组合法，其余拒（防调用方传错配对，如 publish+hotfix）。
    const validKinds = RELEASE_ACTION_ACTIONKIND_PAIRS[action];
    if (!validKinds || !validKinds.includes(actionKind)) {
      reject409(`RELEASE action="${action}" 与 actionKind="${actionKind}" 配对非法（仅允许 publish+publish / execute-release+hotfix / execute-release+execute）`);
    }
  }
  // actionKind 只应在 RELEASE 出现，其余 routeKind 传了非 null 视为调用方误用（fail-closed，防调用方把 actionKind
  // 和 action 搞混——两者语义完全不同：action 是具名转移动作，actionKind 是发布的三分类）。
  if (routeKind !== 'RELEASE' && actionKind !== null && actionKind !== undefined) {
    reject409(`routeKind=${routeKind} 不应传 actionKind（仅 RELEASE 使用），实际=${actionKind}`);
  }

  // ── ①动作级 source→target 边校验（H1·91 号审重排：①在②之前，对未知状态/before=null 全定义拒绝——
  //   边校验逻辑本身天然对未知 before/after 值不匹配任何已定义边，故独立于②的已知状态断言也能正确拒绝，
  //   不依赖②预先过滤，SSOT 明定顺序在此落地）→ 求出 afterFamily。──────────
  let afterFamily = null;
  const devStatus = SF.SYS_DEV_STATUSES[issueType][0];       // 单值族（v2.9 §4.0 快照，每 type 恰一个 DEV 态）
  const verifyStatus = SF.SYS_VERIFY_STATUSES[issueType][0]; // 单值族，恒'待验证'

  if (routeKind === 'CREATE') {
    if (before !== null && before !== undefined) reject409('CREATE 边要求 before=null（before=null 只校验 after）');
    // 受理排期改造 §9：create 落态由 resolveInitialStatus(type,intake_required) 动态解析——两种合法落态：
    //   intake_required=1 → '待受理'(INTAKE)；intake_required=0 → 无受理初始态（feature/improvement=待指派 / bug=待处理·D_PRE）。
    //   guard 纯函数拿不到 intake_required，故按"after 命中两解之一"校验（禁放宽任意 D_PRE/INTAKE 态）。
    //   建单后立即 A 路径 assign（→devStatus）仍保留（bug 专属·建单端点内串 assign）。
    const initialWithIntake = T.resolveInitialStatus(issueType, 1);      // 恒 '待受理'
    const initialWithoutIntake = T.resolveInitialStatus(issueType, 0);   // 待指派 / 待处理
    if (after === initialWithIntake) afterFamily = 'INTAKE';
    else if (after === initialWithoutIntake) afterFamily = SF.familyOfStatus(issueType, after);  // D_PRE
    else if (after === devStatus) afterFamily = 'DEV';
    else reject409(`CREATE 边非法：null→${after}（仅允许 null→${initialWithIntake} / null→${initialWithoutIntake} / null→${devStatus}）`);

  } else if (routeKind === 'GATE') {
    if (before === devStatus && after === verifyStatus) afterFamily = 'VERIFY';
    else if (before === verifyStatus && after === devStatus) afterFamily = 'DEV';
    else reject409(`GATE 边非法：${before}→${after}（仅允许 ${devStatus}→${verifyStatus} 或 ${verifyStatus}→${devStatus}）`);

  } else if (routeKind === 'ADMIN_TRANSITION') {
    // H1（91 号审）：resume 是 transitions.js 里 to:null 的动态转换（暂缓前活跃态由调用方查 timeline 解析），
    //   必须先于"进 SYS_RELEASE 族特殊限制"与"findTransition 静态边"两个分支单独处理——否则要么被误判成
    //   "旁路动作"拒绝（resume 恢复到 D_PRE/DEV/VERIFY 时，findTransition 分支的 resolvedTo===null 会误拒），
    //   要么只能命中"进待上线"这一种目标（resume 恢复到待上线只是众多可能目标之一，非唯一）。
    if (action === 'resume') {
      if (before !== '已暂缓') reject409(`resume 具名边要求 before=已暂缓，实际=${before}`);
      if (after === '已上线') reject409('resume 不得直接恢复到「已上线」（唯一入口=RELEASE routeKind）');
      // MED-1（92 号审）：合法恢复目标不是"任意已知状态"——此前实现会误放行 已暂缓（原地空转）/已拒绝/
      //   已作废/已关闭 等非活跃终态（familyOfStatus 只按族分类，不管"是不是暂缓前可能停留的活跃态"）。
      //   "暂缓恢复"的语义只能回到暂缓前的活跃态，唯一权威来源=该 issue_type 的 hold transition 的 from
      //   集合（transitions.js 单一定义，禁在此处硬编码复制第二份"活跃态"清单——写读同源）。
      const holdTransition = T.transitionsForType(issueType).find(t => t.action === 'hold');
      const legalResumeTargets = (holdTransition && Array.isArray(holdTransition.from)) ? holdTransition.from : [];
      if (!legalResumeTargets.includes(after)) {
        reject409(`resume 目标「${after}」不在合法恢复态集合内（issue_type=${issueType} 的 hold.from=${JSON.stringify(legalResumeTargets)}）`);
      }
      // resume 的真实目标态由调用方查 timeline 动态解析（"暂缓前处于哪个活跃态"）——本函数拿不到 timeline，
      //   只做静态可达性检查：after 已确认落在 hold.from 白名单内，这里只需求出其所属族（可能是
      //   D_PRE/DEV/VERIFY，也可能是 RELEASE 的"待上线"——hold 的 from 含"待上线"，见 transitions.js）。
      afterFamily = SF.familyOfStatus(issueType, after);
    } else if (SF.isInFamily(issueType, after, 'RELEASE')) {
      // 进 SYS_RELEASE 族的特殊限制（方案 §4.0/§2.6·v2.8 D+82 收口）：进「已上线」永不允许（唯一入口=RELEASE
      //   routeKind）；进「待上线」仅 accept（待验证→待上线）具名边（resume 已在上面单独处理，走不到这里）。
      if (after !== SF.SYS_RELEASE_STATUSES[issueType][0]) {   // SYS_RELEASE_STATUSES[type][0] 恒为"待上线"
        reject409(`ADMIN_TRANSITION 不得直写「已上线」（唯一入口=RELEASE routeKind），实际 after=${after}`);
      }
      if (action !== 'accept') reject409(`进「待上线」仅允许 accept/resume 具名边，实际 action=${action}`);
      if (before !== verifyStatus) reject409(`accept 具名边要求 before=${verifyStatus}，实际=${before}`);
      afterFamily = 'RELEASE';
    } else {
      const transition = T.findTransition(issueType, action, before);
      if (!transition) reject409(`ADMIN_TRANSITION 无此边：type=${issueType} action=${action} from=${before}`);
      // 受理排期改造 §9：dynamicTarget 具名边（reactivate·to=null 但落态由 resolveInitialStatus 动态解析·作用当前单）——
      //   仿 resume：不走"resolvedTo===null→旁路误拒"，只校 after 落在合法初始态集（两解之一）+ 求族。
      if (transition.dynamicTarget === 'initial_status' && transition.targetEntity === 'current_issue') {
        const initWithIntake = T.resolveInitialStatus(issueType, 1);      // 待受理
        const initWithoutIntake = T.resolveInitialStatus(issueType, 0);   // 待指派/待处理
        if (after !== initWithIntake && after !== initWithoutIntake) {
          reject409(`${action} 动态目标「${after}」不在合法初始态集（${initWithIntake}/${initWithoutIntake}）`);
        }
        afterFamily = SF.familyOfStatus(issueType, after);
      } else if (transition.dynamicTarget === 'intake_mode' && transition.targetEntity === 'current_issue') {
        // 受理排期改造 §5.4（codex131-M2 修）：change_intake_mode 切换受理模式·目标态依 before+intake_required+方向动态解析（§5.4 真值表）。
        //   ⚠️ 松校验：C0 阶段 guard 拿不到 intake_required（列未加·算不出开↔关方向），故只校 after ∈ 合法前段态集（INTAKE∪D_PRE 前段·待受理/待修改/待指派/待处理）+ 求族；
        //   完整方向校验（哪个方向落哪个态）留 change_intake_mode 端点事务内（C4）。防"dynamicTarget!=initial_status 掉进 else 被 resolveToStatus→null 误拒为旁路"。
        const intakeStatuses = SF.getFamilyStatuses(issueType, 'INTAKE');                    // 待受理/待修改
        const dPreFrontStatuses = SF.getFamilyStatuses(issueType, 'D_PRE').filter(s => s !== '已暂缓');   // 待指派(变更流)/待处理(bug)·非暂缓
        const legalTargets = [...intakeStatuses, ...dPreFrontStatuses];
        if (!legalTargets.includes(after)) {
          reject409(`change_intake_mode 动态目标「${after}」不在合法前段态集（${legalTargets.join('/')}）`);
        }
        afterFamily = SF.familyOfStatus(issueType, after);
      } else {
        const resolvedTo = T.resolveToStatus(transition, before);
        // resolvedTo===null 表示旁路动作（不改 status，如 estimate/feasibility）——不该以 ADMIN_TRANSITION 主状态
        //   routeKind 调用本函数（旁路动作不算主状态转换）。resume 已在上面单独处理，这里不会再遇到
        //   resolvedTo===undefined 的动态解析情形。
        if (resolvedTo === null) reject409(`action=${action} 是旁路动作（不改 status），不应以 ADMIN_TRANSITION routeKind 校验主状态转换`);
        if (resolvedTo !== undefined && resolvedTo !== after) {
          reject409(`ADMIN_TRANSITION 边解析目标「${resolvedTo}」与传入 after「${after}」不一致`);
        }
        afterFamily = SF.familyOfStatus(issueType, after);
      }
    }

  } else if (routeKind === 'RELEASE') {
    // Step0-2 回填：RELEASE 三 actionKind 边均=待上线→已上线（唯一入口进已上线）。
    const releaseFromStatus = SF.SYS_RELEASE_STATUSES[issueType][0];   // "待上线"
    if (!(before === releaseFromStatus && after === '已上线')) {
      reject409(`RELEASE 边非法：${before}→${after}（仅允许 ${releaseFromStatus}→已上线）`);
    }
    afterFamily = 'RELEASE';
  }

  // ── ② assertKnownIssueStatus + routeKind→目标族白名单（H1 重排：现在在①之后，作为第二层确认性检查——
  //   ①已用边逻辑独立拒绝了大部分未知值，这里补齐"after/before 显式落在 ALLOWED_STATUSES"的完整性断言，
  //   两层合起来满足 SSOT"①内对未知状态全定义拒绝"+"②assertKnownIssueStatus"的双重表述）。──────────
  const allowedStatuses = T.ALLOWED_STATUSES[issueType] || [];
  if (!allowedStatuses.includes(after)) reject409(`未知目标状态「${after}」（issue_type=${issueType}，族外拒绝）`);
  if (routeKind !== 'CREATE') {
    if (before === null || before === undefined) reject409(`routeKind=${routeKind} 的 before 不得为 null（仅 CREATE 允许 before=null）`);
    if (!allowedStatuses.includes(before)) reject409(`未知前置状态「${before}」（issue_type=${issueType}，族外拒绝）`);
  }
  // 白名单外目标族 → 409（routeKind 允许的目标族清单，开发计划 §2.6）。
  const allowedFamilies = ALLOWED_TARGET_FAMILIES[routeKind] || [];
  if (!afterFamily || !allowedFamilies.includes(afterFamily)) {
    reject409(`routeKind=${routeKind} 不允许写入目标族=${afterFamily || '(未知)'}（after=${after}）`);
  }

  // ③ 进族门禁（需要活体 roster 数据；调用方同事务内查询后经 rosterActiveCount/rosterAllComplete 传入）。
  const beforeFamily = (before === null || before === undefined) ? null : SF.familyOfStatus(issueType, before);
  const enteringDev = afterFamily === 'DEV' && beforeFamily !== 'DEV';
  const enteringVerify = afterFamily === 'VERIFY' && beforeFamily !== 'VERIFY';
  if (enteringDev) {
    if (!(Number(rosterActiveCount) >= 1)) reject400('进入开发执行态（SYS_DEV）要求在册成员数≥1');
  }
  if (enteringVerify) {
    if (!(Number(rosterActiveCount) >= 1 && rosterAllComplete === true)) {
      reject400('进入待验证态（SYS_VERIFY）要求在册成员数≥1 且全员完成态（无 pending）');
    }
  }

  // 进 SYS_RELEASE 族 roster 门（H1 · 对抗审 2026-07-17 引入，95 号复审收口为完整版本——**不再区分
  //   routeKind**，ADMIN_TRANSITION 的 accept/resume 具名边进「待上线」与 RELEASE 的 publish/hotfix/execute
  //   进「已上线」同等适用，理由如下）。
  //   缺陷背景（accept/resume 侧）：hold.from 含「待上线/待验证」（transitions.js）、「已暂缓」归 D_PRE 族
  //   （status-families.js），D_PRE 族允许 add/remove/reassign 且 W-GATE 天然短路（矩阵 §4.3 D_PRE 行"主状态
  //   不动"）——协调人可在暂缓窗口把新的 pending 成员塞进 roster；resume 恢复回「待上线」此前未经任何 roster
  //   门禁，pending 成员就此被静默带回 RELEASE 族、后续随 publish/hotfix 一并进「已上线」——违反「已上线态
  //   不应存在未完成开发」的业务直觉。
  //   ⚠️（95 号复审收口）此门最初只加在 ADMIN_TRANSITION 侧，理由是"C0 一次性重置脚本会把 RELEASE 族存量单
  //   的 roster 覆盖成 pending，若 RELEASE routeKind 也要求无 pending 会把历史遗留单的合法发布永久堵死"——
  //   该理由已被推翻：reset 脚本（sys-multidev-c0-reset.js）改为按主状态族区分回填，RELEASE 族单的 roster
  //   不再置 pending，而是回填为方案 §3 四态配对不变量里的 no_code 完成态（P15 恒真：主状态∈SYS_RELEASE ⇒
  //   在册≥1∧无 pending，随 reset 事务内探针自动校验）；零在册的 RELEASE 族单（roster 从未真正形成）由 reset
  //   自身的 pre-check 在覆盖动作前 fail-fast 拦截、要求人工先补齐——即 reset 收敛后产出的 RELEASE 族单
  //   roster 必然满足「在册≥1∧无 pending」，"历史遗留单被本门堵死"这个前提已不存在。RELEASE routeKind 与
  //   ADMIN_TRANSITION 因此改为**同等**适用本门，不再有例外分支。
  // ⚠️ 不能沿用 enteringDev/enteringVerify 的 `beforeFamily !== afterFamily` 写法：SYS_RELEASE 族本身把
  //   「待上线」与「已上线」并作同一族（status-families.js SYS_RELEASE_STATUSES=['待上线','已上线']），RELEASE
  //   routeKind 的 before 恒为「待上线」（①层已强校验），`familyOfStatus('待上线')` 本就返回 'RELEASE'——若照抄
  //   `beforeFamily !== 'RELEASE'` 会让 publish/hotfix/execute 永远判定为"未跨出该族"而漏判，此门形同虚设。
  //   实际只需 `afterFamily === 'RELEASE'`：②层白名单（ALLOWED_TARGET_FAMILIES）已保证只有 ADMIN_TRANSITION/
  //   RELEASE 两个 routeKind 能让 afterFamily 落在 'RELEASE'，且各自的边校验已强制 before 只能是「待验证」
  //   （accept）/「已暂缓」（resume）/「待上线」（RELEASE routeKind）——三者都是"产出/进入"该具体目标态的真实
  //   转移，不存在同态空转的可能，故不需要再判 beforeFamily。
  const enteringRelease = afterFamily === 'RELEASE';
  if (enteringRelease) {
    if (!(Number(rosterActiveCount) >= 1 && rosterAllComplete === true)) {
      reject400('进入发布控制态（SYS_RELEASE）要求在册成员数≥1 且全员完成态（无 pending）');
    }
  }

  return { ok: true, afterFamily };
}

module.exports = { assertMainStatusTransition, MainStatusGuardError, ROUTE_KINDS, RELEASE_ACTION_KINDS };
