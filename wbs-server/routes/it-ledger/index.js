// routes/it-ledger/index.js — 信息化资产轻量台账（长任务 D · C1 事务底座）
//   业务方案 SSOT = docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md
//   §1 冻结事实 / §2.1–§2.7（本 commit 只建 7 表，§2.8/§2.9 对账两表不属于 C1）/ §2.3 事件契约
//   （含 floor_update）/ §4 动作码集合（本 commit 只登记码与载荷键，不实现动作本身）/ §6 事件与事务
//   / §9 到期提醒（仅 /me 的 expiring_count）/ §10 权限与财务字段 / §12 与平台集成
//   执行 agent spec = docs/local/信息化资产_轻量版/_agent_specs/C1_事务底座_spec.md
//
// D10 独立连接（方案 §1 冻结事实 / §6）：本模块不复用 server.js:898 的共享 sqlite3.Database，而是
//   对同一个 DB_FILE 另开一个连接 itDb，busy_timeout=5000；本模块所有读写只走 itDb，且读请求也经
//   itTxnMutex 串行（同连接 SELECT 能看到本连接未提交的中间态，只靠写串行隔不开——方案 §1 表格
//   「本模块连接（D10）」一节明文）。
//
// 旧线参考（仅取一处，方案 §17 末「旧线参考清单」表 C1 行）：
//   git show archive/itasset-phase-b-20260903:wbs-server/routes/it-assets/index.js
//   只抽 itAssetLinkTransitionMutex 的 FIFO 队列闭包骨架（acquire/release）与
//   acquire → BEGIN IMMEDIATE → 业务 → COMMIT/ROLLBACK → finally release 的错误分支范式；
//   不取共享连接前提（旧线复用 server.js 共享连接，本模块是独立连接）、不取加解密与 secret 日志。
//
// 平台铁律（方案 §1）：本模块从不开 PRAGMA foreign_keys；REFERENCES 仅作文档，引用完整性在事务
//   内显式校验。journal_mode 编码前已 grep（见下方"编码期实测记录"），本模块不切换。
'use strict';
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
// G2A2（长任务 E 段2）：运行时锁外读库探针底座——只在 TEST_HOOKS_ENABLED 时真正
//   run()/getStore()，生产路径不引入 AsyncLocalStorage 调用（见 ledgerRequestContext 声明处、
//   requireLedgerWrite/withWrite 调用点注释）。
const { AsyncLocalStorage } = require('async_hooks');
// C2（长任务 D · 登记/编辑/机柜/楼层）：不变量校验「一处真相」，纯函数模块，见文件头注释。
const invariants = require('./invariants');
const installSingleAssetActions = require('./single-asset-actions'); const createStocktakes = require('./stocktakes'); const createReconciles = require('./reconciles');
// C2（长任务 E · 巡检台账照片）：目录对账（reconcilePhotoDirectoryOnce）在 runLifecycleInit 里调用，
//   与其它文件校验/落盘助手共用同一个模块，见 inspection-photo-files.js 文件头注释。
const inspectionPhotoFiles = require('./inspection-photo-files');
module.exports = (deps) => {
  const REQUIRED_DEPS = ['logger', 'DB_FILE', 'authenticateToken', 'requireAdmin'];
  for (const k of REQUIRED_DEPS) {
    if (deps[k] === undefined) throw new Error('routes/it-ledger 缺注入依赖: ' + k);
  }
  const { logger, DB_FILE, authenticateToken, requireAdmin } = deps;
  // 有意不注入 dbRunAsync 等共享连接助手（方案 §12「不再注入 dbRunAsync 等共享连接助手」）——
  // 本模块的所有 DB 访问都经下方独立连接 itDb + itTxnMutex，避免与共享连接的写入夹带。
  // S4（17-R3T 必修）：模块装配时刻捕获一次，供连接使用轨迹（connTrace）判断是否要真的写入——
  //   不是"存在但生产路径不调用"，是生产路径下这段追踪代码本身直接被短路，零开销、零副作用。
  const TEST_HOOKS_ENABLED = deps.enableTestHooks === true;
  // G2A2：巡检单静态守卫第四次被绕过（白名单版仍被高阶函数收函数引用/同名遮蔽/别名/路由注册
  //   返回值别名与条件注册绕过）后，用户裁定"写路由锁外不读库"这条性质不再靠 JS 静态分析（本质
  //   上无法完备）保证，改由运行时探针保证：测试模式下用 AsyncLocalStorage 记录每条 SQL 是否处在
  //   写请求 / withWrite 事务内，供 _testHooks.sqlProbe 判定违规。生产路径不调用 ALS 的
  //   run()/exit()/getStore()（L1 订正措辞）——这个实例本身在模块加载时刻就已构造（构造本身零
  //   开销），真正的行为分支都挂在 TEST_HOOKS_ENABLED 判据后（见 probeSql / requireLedgerWrite /
  //   withWrite / runCleanupDetached 调用点）。
  // G3A（41S/41T 审查订正保证边界，删去"写路由锁外不读库"这条性质本身"由探针保证"的无限定
  //   表述）：本探针的保证范围**只覆盖经 withRead / withWrite 注入的 q 包装执行的 SQL**——
  //   G3A-b（M6）起 q.get/all/run/assertWrite 四个入口是全部业务 SQL（含 ACL 终判查询）的唯一
  //   通道（本模块从不注入 dbGetOn/dbAllOn/dbRunOn 等底层连接助手，也不注入 sqlite3/
  //   better-sqlite3 驱动本身给任何路由文件或它们 require 的本地助手模块，见 R10 结构规则）。
  //   路由文件（或其 require 的本地助手模块）若自行引入数据库驱动、绕开这四个入口直接执行 SQL，
  //   探针看不到，不在这套运行时保证的覆盖范围内，由 R10 静态结构规则挡住（G3A-b M5 起白名单式
  //   全等比较，覆盖 inspection-sheets.js / inspections.js / inspection-collect.js /
  //   inspection-photo-files.js 四个文件），不是本探针的职责。
  const ledgerRequestContext = new AsyncLocalStorage();

  const router = express.Router();

  // ============================================================
  // 一、模块状态 + 独立连接 + mutex（D10 / §2.1 硬契约）
  // ============================================================
  // S1（17-R4S HIGH 根治，删 healing 子系统）：B3 引入的 state.healing CAS 认领标志与配套的
  //   isHealingCandidate()/admitForHealingOrThrowReadiness() 已整体删除——请求侧不再有任何
  //   "自愈候选放行"逻辑，withRead/withWrite/requireLedgerReady 的锁前判定回到纯
  //   throwReadinessError()（faulted 连接会先让 state.ready 变 false，见 S2，因此天然直接
  //   503 UNAVAILABLE，不需要额外放行分支）。自愈改由连接层 error 监听器主动触发（S2）。
  // S5（17-R4S 必修）：recoveryForbidden——旧连接关闭失败（rebuildUnderLock 里）时置 true，
  //   代表模块进入"终态"：任何后续 rebuildUnderLock 调用（含 S2 的自动重建）一律直接失败退出，
  //   不再尝试打开新连接。只有 reinitForTest()（测试专用，语义上等价于"运维重启"）会显式清空
  //   这个标志；生产路径没有清空手段，与"需重启恢复"文案一致。
  const state = { ready: false, error: null, draining: false, recoveryForbidden: false };
  let itDb = null;
  // S4（17-R4S 必修）：未发布连接（还没赋给 itDb 就已经在打开/准备阶段失败）关闭失败时的记录——
  //   push {connId, err, db}，shutdown() 在锁内逐个再尝试 close 一次并记录结果（best-effort，
  //   不影响 shutdown 本身收尾）。这类连接从未进入 itDb，不会被 closeItDb()/rebuildUnderLock
  //   覆盖到，若不额外追踪就是真正的句柄泄露。
  const orphanConns = [];
  // 小项（codex 17-R 裁定）：lastBusyPath 曾是共享变量，并发场景下会被后一次调用覆盖、读到
  //   串号的值——已删除，改为把路径直接挂在抛出的错误对象上（e.busyPath = 'begin'|'commit'），
  //   见 withWrite 内两处 throw 点。getLastBusyPath 已从 _internals 移除。
  //
  // C1 串行化重构（codex 17 / 17-R / 17-R2 三轮 HIGH 全落在"初始化/重建/停机可并发"这一族之后，
  //   主会话按止损判据裁定：并发生命周期仲裁这个子系统不该存在，改为恒串行模型——见
  //   docs/local/信息化资产_轻量版/_agent_specs/C1_生命周期串行化_spec.md §0）：
  //   同一时刻至多一个生命周期动作在跑，且除启动初始化外全部发生在 itTxnMutex 内；每个事务只碰
  //   自己取锁时捕获的那条连接。以下三个变量替换掉旧版的 lifecycleGen 代次仲裁机制：
  //   initPromise：initSchema 的单飞句柄（启动初始化在途时可被 shutdown 等待落地）。
  //   startupStarted：initSchema 只允许被真正执行一次的一次性闸门（见 initSchema 函数体）。
  //   connSeq/db.__id：纯粹的连接身份标签，只供日志辨识"这是第几条连接"，不参与任何判定——
  //     判定"是不是当前已发布连接"一律用对象恒等 itDb === db。
  //
  // 第十人记账（如实记录，不得写"简化"）：本次重构生命周期段（state/mutex/openItDb/
  //   openAndPrepare/withRead/withWrite/rebuildUnderLock/runLifecycleInit/initSchema/shutdown
  //   等，不含 DDL_STATEMENTS 纯 SQL 文本）纯代码行数 99 → 193 → 229 → 649 行，闸内行为改写型
  //   测试 seam 10 → 16 → 19 → 19 个（四段分别对应：初版并发仲裁模型 → C1 串行化重构 → 上一轮
  //   B1-B8 自愈 CAS/关闭失败显式化/连接使用轨迹 → 本轮 17-R4S/17-R5T 删 healing 子系统、
  //   自愈改由连接层 error 监听器 fire-and-forget 触发、orphanConns 孤儿连接追踪、
  //   recoveryForbidden 终态标志、execRollback 分支精确化）。**本轮行数暴涨主要来自两处**：
  //   ① S1 删掉 healing CAS 后又在 S2 补回一套语义不同的"发现方触发"自愈机制（scheduleSelfHeal
  //   IfNeeded + 两个新增调用点），净增而非净减；② S3/S4 把 openGate/txnMidGate 的 await 和
  //   PRAGMA/BEGIN 失败清理逻辑挪进同一个 try 块、补 orphanConns 记录，单个函数体变长。seam 数
  //   持平（19→19）是因为本轮删的（无）少于上一轮，纯粹是巧合，不代表复杂度没变——
  //   scheduleSelfHealIfNeeded 这种模块内部共享逻辑不算"测试 seam"，但它是新增的真实复杂度。
  //   代码量持续增长，换掉的是"并发交错的推理负担"——旧模型要证明正确性依赖"代次比较 + 三处
  //   发布前检查 + publishGate 精确时序"这类跨调用栈的隐式不变量，新模型的正确性只需要"同一
  //   时刻至多一个生命周期动作持有 itTxnMutex"这一条局部、可静态检查的锁不变量。行数变多不是
  //   白付出，是把隐式推理负担换成了更多但更简单、可独立验证的显式检查点。
  let initPromise = null;
  let startupStarted = false;
  let connSeq = 0;
  // C2（长任务 E · 巡检台账照片，33-R2 M1）：目录对账只在进程首次初始化时跑一次的第二道闸——
  //   isStartup 只由 initSchema() 的调用点传 true（rebuildUnderLock 的运行期重建调用不传），本
  //   标记是防御性第二层：就算未来某次重构不慎让 isStartup 被重复传 true，也不会对同一进程重复
  //   扫目录（"不信任调用方永远守约"，同款防御深度见 runLifecycleInit 发布段 prev 分支注释）。
  let sheetPhotoDirReconciled = false;

  // 测试专用注入钩子（供 scripts/verify-it-ledger.js 用 _internals 操纵，生产路径恒不触发）。
  const _testHooks = {
    // G3A-b（M1 必修）：awaitGateWithTimeout 的超时时长覆盖——null 时恒为 30s（生产装配不传
    //   enableTestHooks，对应 setter 不存在，该字段永远是 null）。
    gateTimeoutMsOverride: null,
    // G3A-c（41RT M4）：runCleanupDetached 每次真正开始/结算（无论成功或失败）各自的计数——两者
    //   相等即"当前没有清理动作在途"。
    cleanupStarted: 0,
    cleanupSettled: 0,
    ddlFailureLabel: null,   // initSchema 中命中该 label 的 DDL 语句会人为抛错（用例 2 / 10）
    // ddlBusyInjection：{label, count} —— 命中 label 的 DDL 前 count 次注入 SQLITE_BUSY，随后放行
    // 真实 dbRun（用例1b：验证 M1 退避重试最终能恢复成功）。
    ddlBusyInjection: null,
    // rollbackFailure：false=不注入；true=抛通用错误（用例10，走真实"ROLLBACK失败"路径4）；
    //   'no_txn'=抛"cannot rollback - no transaction is active"（用例10b，走豁免分支，不升级为路径4）。
    rollbackFailure: false,
    // 去掉锁内终判（用例14 活体变异①）：对齐旧线 itAssetSkipTerminalOuterCheckForTest 先例——
    //   显式声明的测试 seam，生产路径恒为 false，零行为变化。
    skipAssertWriteForTest: false,
    // 去掉"事务已不存在"豁免（用例14 活体变异③）：生产路径恒为 false，零行为变化。
    disableNoTxnExemption: false,
    // H2/M1：打开连接（openItDb）人为失败注入——initSchema 初次打开与 rebuildUnderLock 重建打开
    // 各自用得到，生产路径恒为 false。
    // openDbFailureInjection=true：真实构造成功后伪造一次 'error' emit（B4①，走真实
    //   settled/on('error') 分支，不再是构造前同步 reject）。
    openDbFailureInjection: false,
    // openDbCallbackErrInjection：B4①保留项——伪造"打开回调本身带 err"这条路径（不经过
    //   on('error')，直接命中回调里的错误分支，是旧版行为的等价替代，两条注入互不影响）。
    openDbCallbackErrInjection: false,
    // B3/M2：临时调小 runLifecycleInit 的总预算（默认普通30s/fastMode 3s），供 verify 在合理
    // 耗时内验证"deadline 到点即判失败，不再无限等退避"这条边界，生产恒为 null（走默认预算）。
    ddlDeadlineMsOverride: null,
    // H5①：openAndPrepare 实际被调用的次数——verify 用它断言"第二次 initSchema() 被忽略、连接
    // 身份不变、没有真的再开一条连接"。
    openAndPrepareCallCount: 0,
    // H5②（L2）：可等待的闸（Promise 或 null）——openAndPrepare 打开连接后、发布之前会 await 它，
    // 供 verify 精确卡住启动初始化流程的某个时间点，验证"shutdown 等 init 落地后才关闭"。
    openGate: null,
    // L6：openGate "到达"信号——setOpenGate(gate) 设置非空闸时同步返回一个 Promise，在
    // openAndPrepare 真正开始 await 这个闸的那一刻 resolve，供 verify 不靠猜 sleep 时长就能
    // 确定"流程确实已经卡在闸上"。
    openGateArrived: null,
    openGateArrivedResolve: null,
    // M1：DDL 退避窗口内手动 emit('error') 需要拿到"正在初始化、还未发布"的那条连接引用——
    // openAndPrepare 打开连接后立刻记录到这里（发布前的连接外部拿不到 getDbIdentity()）。
    // 串行化重构后不再有并发在途连接，简化为"最近一次打开"，去掉按 gen 索引的 Map。
    lastOpenedDbForTest: null,
    // S6（本轮 codex 17-R2 必修，可观测性信号；C1 串行化重构后语义简化）：只读生命周期计数器——
    // 每次 openAndPrepare 真正打开连接 opened+1；每次发布成功 published+1；每次本模块主动关闭一条
    // 连接（含发布失败关闭、重建前关闭旧连接、shutdown 关闭）closedAttempts+1。superseded 分支
    // 随代次仲裁机制一起删除（串行模型下不存在"被抢先"这种结果）。生产路径不读它，纯供 verify
    // 断言用，且全部按增量（countersBefore 快照差值）判断，不再断言绝对守恒式。
    // 17-R6S M：orphanRetryProcessed 供 verify 断言 shutdown() 收尾时的孤儿重试循环确实"处理
    // 过"（不管重试关闭本身成功还是仍失败，循环体每跑完一条 orphanConns 记录就 +1）。
    lifecycleCounters: { opened: 0, published: 0, closedAttempts: 0, orphanRetryProcessed: 0 },
    // L6：DDL 退避"到达"信号——setDdlBusyInjection(label, count) 注入非空 label 时同步返回一个
    // Promise，在 runDdlAndReadiness 真正进入 setTimeout 退避等待的那一刻 resolve。
    ddlBackoffArrived: null,
    ddlBackoffArrivedResolve: null,
    // L1：withWrite 在 BEGIN 成功、调用业务回调 fn(q) 之前会 await 的可等待闸（非空时才等），
    // 供 verify 把整个业务回调的起点精确卡在某个时间点上，模拟"事务已开、业务还没跑"这一窗口
    // 期内发生服务期连接层故障（对当前连接 emit('error')）。
    txnMidGate: null,
    // T2（本轮 17-R4T 必修）：txnMidGate "到达"信号——setTxnMidGate(gate) 设置非空闸时同步返回
    // 一个 Promise，在 withWrite 真正开始 await 这个闸的那一刻 resolve（BEGIN 已经真实成功、
    // 锁已持有），供 verify 不靠猜 sleep 时长就能确定"流程确实已经卡在闸上、持锁未释放"。
    txnMidGateArrived: null,
    txnMidGateArrivedResolve: null,
    // G3A（41S H1 测试钩子）：withWrite 内、txnMarker.active 已经置为 false、真正发出
    //   COMMIT（成功路径）或 ROLLBACK（bizErr 路径）之前会 await 的可等待闸（非空时才等），供
    //   verify 精确卡在"标记已翻转、SQL 尚未真正提交/回滚"这个窗口内，用捕获的 q 发起一次读，
    //   验证探针此刻是否已经把它记成"不在事务内"。到达信号语义与 txnMidGateArrived 一致。
    preCommitGate: null,
    preCommitGateArrived: null,
    preCommitGateArrivedResolve: null,
    // T3：execRollback 被调用的次数（不区分注入与否，任何一次进入函数体都计），供 verify 断言
    // "BEGIN 失败路径(路径1)确实一次 ROLLBACK 都没发过"。
    rollbackCallCount: 0,
    // S3：注入 close() 失败（closeAndCount 里判定），供 verify 验证"关闭失败不发布替代连接、
    // itDb 只在关闭成功后才置 null"这条契约。生产路径恒为 false。
    closeFailureInjection: false,
    // S4：连接使用轨迹——q.get/all/run、BEGIN、COMMIT、ROLLBACK 各自把所用连接的 __id push
    // 进这个数组（仅 TEST_HOOKS_ENABLED 时真正写入，生产路径零开销）。测试可读可清
    // （_internals.getConnTrace/clearConnTrace，仅 enableTestHooks 闸内）。
    connTrace: [],
    // G2A2：运行时锁外读库探针——测试夹具经 deps.sqlProbe 透传（见下方赋值），生产路径恒为
    //   null。只记录、不抛错、不改行为（probeSql 助手，紧邻 traceConn 之后）。
    sqlProbe: null,
  };
  // G2A2：sqlProbe 只在 TEST_HOOKS_ENABLED 时才从 deps.sqlProbe 取（与 deps.inspectionSheetTestHooks
  //   同一道闸），未传时保持 null——与 traceConn/connTrace 的既有约定一致。
  if (TEST_HOOKS_ENABLED && typeof deps.sqlProbe === 'function') _testHooks.sqlProbe = deps.sqlProbe;

  // S4/T6：连接使用轨迹记录助手——仅 TEST_HOOKS_ENABLED 时真正 push，生产路径这行直接短路
  //   返回。sql 可选（BEGIN/COMMIT/ROLLBACK 这类无参 SQL 也传进来，供 verify 按目标语句定位
  //   具体是哪一条 INSERT/UPDATE，而不是只能按 op==='run' 笼统匹配）。
  function traceConn(op, db, sql) {
    if (!TEST_HOOKS_ENABLED) return;
    _testHooks.connTrace.push({ op, connId: db && db.__id, sql });
  }

  // G2A2b Commit3（H1 必修，修探针漏报）：inWriteTxn 不再从 ALS store 读——旧实现让 withWrite
  //   内"不 await 的派生调用"（fire-and-forget 的 withRead()、setImmediate 回调、事务结束后才执行
  //   的已捕获 q）继承了创建时刻的 store（含 inWriteTxn:true），但这些调用真正执行 SQL 的时刻，
  //   写事务往往早已 COMMIT——继续按 store 判定会把"事务提交后才跑的 SQL"错记成"事务内"，
  //   探针漏报（明明是锁外读却不计违规）。改为按调用方（withRead 或 withWrite）显式传入
  //   inWriteTxn 的真值：withRead 恒传 false（withRead 与 withWrite 共用同一把 itTxnMutex，
  //   withRead 自己的 SQL 定义上不可能处在某个写事务内部——处在的话锁根本没法拿到，是死锁不是
  //   成功执行）；withWrite 传闭包里的可变 txnMarker.active（该 withWrite 调用自己的事务是否仍
  //   活动。G3A 订正：置 false 的时机是"发出 COMMIT / ROLLBACK 之前"，不是"之后的 finally 里"
  //   ——finally 里只保留一次兜底，见 withWrite 函数体内两处调用点注释），不管 SQL 实际在哪个
  //   ALS 上下文/哪个 tick 执行，只要事务已经结束（或正要结束）就如实报 false）。writeRequest/
  //   method/path 仍从 store 取（这三个字段不存在"事务提交后失真"的问题，本质是"这条 SQL 发生在
  //   哪次 HTTP 写请求的处理过程中"，请求级别的信息，请求还没结束就不会失真）。
  // L2 必修：sqlProbe 是测试夹具传入的外部回调，可能抛错（比如断言写错、访问了 undefined 属性）——
  //   包一层 try/catch，探针本身的错误只记到 stderr，绝不能把测试代码的 bug 传染成业务 SQL 失败。
  // G3A-c（41RT M3 必修，测试观测用字段）：txnSeq——每次 withWrite 的 BEGIN 成功后自增的序号，
  //   供 verify 区分同一次 HTTP 请求处理过程中先后发生的多个独立写事务（比如某些路由先做一次
  //   短事务预检、再做一次短事务落库，两次 withWrite 各自的 BEGIN...COMMIT 是完全独立的两段，
  //   仅靠 SQL 文本本身不足以区分调用发生在哪一段——两段可能执行完全相同的 SQL）。withRead 恒传
  //   null（不属于任何写事务）。调用方不传时（比如未来新增调用点漏传）也是 null，不是 0/undefined
  //   这种容易被误判成"属于某个事务"的假值。
  function probeSql(op, sql, inWriteTxn, txnSeq) {
    if (!TEST_HOOKS_ENABLED) return;
    if (typeof _testHooks.sqlProbe !== 'function') return;
    const store = ledgerRequestContext.getStore() || {};
    try {
      _testHooks.sqlProbe({
        op, sql,
        inWriteTxn: inWriteTxn === true,
        writeRequest: store.writeRequest === true,
        method: store.method,
        path: store.path,
        txnSeq: txnSeq === undefined ? null : txnSeq,
      });
    } catch (probeErr) {
      logger.error(`[it-ledger] sqlProbe 回调抛错(不影响业务，仅记录): ${probeErr && probeErr.message}`);
    }
  }
  // G3A-c（41RT M3 必修）：withWrite 的 txnSeq 计数器——只在 TEST_HOOKS_ENABLED 时才自增/赋值，
  //   生产路径恒不读取这个变量（withWrite 内赋值语句本身也判了 TEST_HOOKS_ENABLED），不产生任何
  //   行为差异。
  let _txnSeqCounter = 0;

  // B8（17-R4-B 必修）：openGate/txnMidGate 这两处测试专用可等待闸——生产路径恒为 null，
  //   不会碰这段代码；但若测试脚本忘了放闸（bug 或异常路径提前退出），本来会让 await 挂起到
  //   进程超时/永不返回。加一层安全网：等超过 30s 视为"闸没有被正确放行"，抛错并清空对应闸
  //   （避免残留的已挂起 Promise 继续卡住下一次可能复用同一个 _testHooks 字段的调用）。
  // G3A-b（M1 必修，配套测试用）：真实超时时长恒为 30s——`_testHooks.gateTimeoutMsOverride`
  //   只在 TEST_HOOKS_ENABLED 时才可能被 _internals.setGateTimeoutMsOverride 设成非 null（生产
  //   装配不传 enableTestHooks，这个 setter 根本不存在，字段恒为 undefined，超时恒为 30s，
  //   行为不变）。用于测试用例把"闸从不放行"这种场景的等待时长从 30s 调短，可控地验证
  //   "闸超时被当作 COMMIT/ROLLBACK 失败处理、连接与锁都能正确收尾"，不用真的等 30s。
  const GATE_TIMEOUT_MS = 30000;
  function awaitGateWithTimeout(gate, label, clearFn) {
    const timeoutMs = (TEST_HOOKS_ENABLED && _testHooks.gateTimeoutMsOverride) || GATE_TIMEOUT_MS;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (typeof clearFn === 'function') clearFn();
        reject(new Error(`[it-ledger] ${label} 等待超过 ${timeoutMs}ms，判定测试闸未被正确放行`));
      }, timeoutMs);
    });
    return Promise.race([gate, timeout]).finally(() => clearTimeout(timer));
  }

  // S2（17-R4S HIGH 根治）：自愈由"发现故障的一方"主动触发一次锁内重建（fire-and-forget），
  //   不再由请求侧的自愈分支去发现/触发。conn：报故障的那条连接对象；reasonMessage：写进
  //   state.error 的原始错误文案。只对"当前已发布连接"（itDb === conn）的故障更新全局 state
  //   并安排重建——已作废/未发布的连接报错不代表全局服务状态。db.__rebuildScheduled 保证同一条
  //   连接只安排一次重建（'error' 事件、execRollback 里发现连接已关闭等多个入口都可能调用本
  //   函数，不能让它们各自都排一次队）。withLifecycleLock 会真实 acquire itTxnMutex——若此刻
  //   有在途事务持锁，这次重建请求会排在它后面，事务跑完才轮到（FIFO 语义天然满足"排在在途
  //   事务之后执行"）；rebuildUnderLock 内部已有 draining 守卫，停机期间不会误开新连接。
  function scheduleSelfHealIfNeeded(conn, reasonMessage) {
    conn.__faulted = true;
    if (itDb !== conn) return;
    state.ready = false;
    state.error = `连接层错误: ${reasonMessage}`;
    logger.error(`[it-ledger] 🚫 ${state.error}`);
    if (conn.__rebuildScheduled) return;
    conn.__rebuildScheduled = true;
    withLifecycleLock(() => {
      // S1（17-R5S HIGH 必修）：排队期间可能已经有另一条路径（比如同一事务的 ROLLBACK 失败
      // 触发 handleRollbackFailure）抢先把这条故障连接重建掉了——真正拿到锁、要动手之前必须
      // 复核，不能想当然地认为"排队那一刻看到的故障状态"到"轮到自己执行"还原样成立。三个
      // 条件任一不满足就判定这次排队已经过时（stale），直接放弃：不重复关闭一条已经被别的
      // 重建换成的健康连接（那样会误伤刚发布的新连接）。
      if (itDb !== conn || !conn.__faulted || state.draining) {
        return { ok: false, kind: 'stale' };
      }
      return rebuildUnderLock({ fastMode: true });
    }, 0).catch((rebuildErr) => { // S3：0 = 不设超时，同 shutdown() 的理由
      logger.error(`[it-ledger] 连接层故障触发的重建异常: ${rebuildErr && rebuildErr.message}`);
    });
  }

  // S2（17-R5S 必修）：未发布连接的统一关闭出口——不再用"close 回调传空函数"这种吞掉关闭
  //   结果的写法，改走 closeAndCount 观察关闭是否真的成功；
  //   关闭失败时记进 orphanConns（供 shutdown() 收尾时再尝试一次），日志带上触发关闭的原因，
  //   排查时能看出"这条连接是因为什么才被丢弃的"。openItDb 的三处打开失败分支、
  //   runLifecycleInit 的全部"发布前"失败分支都统一走这里。
  async function discardUnpublished(db, reason) {
    const closeResult = await closeAndCount(db);
    if (!closeResult.ok) {
      logger.error(`[it-ledger] 未发布连接关闭失败(__id=${db.__id}，原因: ${reason}): ${closeResult.err && closeResult.err.message}`);
      orphanConns.push({ connId: db.__id, err: closeResult.err, db });
    }
    return closeResult;
  }

  // H2（Opus 预筛+主会话裁定）：连接打开统一出口，Promise 化并挂 'error' 事件监听——不让底层
  //   驱动在正常回调之外另发的 'error' 事件因无监听器被 Node 当未处理异常抛出（会直接崩进程）。
  //   任何调用方（initSchema / rebuildUnderLock）拿到的 reject 都是结构化 Error，不会有裸的
  //   进程级异常逃逸。
  // B4②/S2：连接成功打开、进入服务后才发生的连接层 'error'——交给 scheduleSelfHealIfNeeded
  //   置 state 不可用并安排一次锁内重建（fire-and-forget，本函数自己不等重建结果）。
  function openItDb() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const db = new sqlite3.Database(DB_FILE, (err) => {
        if (settled) return;
        if (_testHooks.openDbCallbackErrInjection) {
          settled = true;
          // 17-R6S M：三处打开失败分支不再 fire-and-forget——discardUnpublished 必须先完成
          // （关闭成功，或关闭失败已登记进 orphanConns）再 reject，避免 shutdown() 在这条连接
          // 还没来得及被登记为孤儿之前就已经跑完收尾重试、把它漏掉。reject 的错误对象带上
          // {openErr, closeResult}，方便调用方/日志区分"是哪个原始错误触发的、关闭本身是否
          // 也失败了"。
          const openErr = new Error('测试注入失败: openItDb(回调err)');
          discardUnpublished(db, '测试注入: openItDb回调err').then((closeResult) => {
            reject(Object.assign(openErr, { openErr, closeResult }));
          });
          return;
        }
        settled = true;
        if (err) {
          discardUnpublished(db, `openItDb回调err: ${err.message}`).then((closeResult) => {
            reject(Object.assign(err, { openErr: err, closeResult }));
          });
          return;
        }
        resolve(db);
      });
      db.__id = ++connSeq; // S2：构造即分配身份标签——即使这条连接最终打开失败，日志/孤儿追踪
      // 里也能辨认它是"第几条"；openAndPrepare 不再重复分配（避免同一条连接背两个 id）。
      db.on('error', (err) => {
        logger.error(`[it-ledger] itDb 连接层 error 事件: ${err && err.message}`);
        if (!settled) {
          settled = true;
          // 17-R6S M：同上——先等 discardUnpublished 落定（关闭完成或孤儿已登记）再 reject。
          discardUnpublished(db, `openItDb连接层error: ${err && err.message}`).then((closeResult) => {
            reject(Object.assign(err, { openErr: err, closeResult }));
          });
          return;
        }
        // S2：settled 之后才报的错——标记 __faulted，并对"当前已发布连接"安排一次锁内自愈
        // 重建（fire-and-forget）。不在监听器里关闭连接、不同步置 itDb=null——避免和正在这条
        // 连接上跑的在途事务交错；真正的关闭动作交给 rebuildUnderLock（锁内，事务跑完之后）。
        scheduleSelfHealIfNeeded(db, err && err.message);
      });
      if (_testHooks.openDbFailureInjection) {
        // B4①：process.nextTick 早于 sqlite3 底层线程池回调触发的时机，可靠命中上面
        // on('error') 里 "!settled" 这条真实分支。
        process.nextTick(() => db.emit('error', new Error('测试注入失败: openItDb(连接层error事件)')));
      }
    });
  }

  // M2（codex 17-R 裁定）：初始化期 DDL 要在**发布前**的本地 db 对象上执行（还没赋给全局
  //   itDb），不能借道下方"独立连接上的 Promise 化助手"（那三个读全局 itDb）。这三个是显式
  //   传入 db 的版本：runDdlAndReadiness/checkReadiness 在发布前用；1.4（连接绑定）落地后，
  //   withRead/withWrite 取锁后捕获的 conn 也改走这三个显式传参版本，不再有隐式读全局 itDb
  //   的独立助手（见下方 withRead/withWrite 与已删除的旧版 dbRun/dbGet/dbAll）。
  function dbRunOn(db, sql, params) {
    return new Promise((resolve, reject) => {
      db.run(sql, params || [], function (err) {
        if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
  function dbGetOn(db, sql, params) {
    return new Promise((resolve, reject) => {
      db.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
  function dbAllOn(db, sql, params) {
    return new Promise((resolve, reject) => {
      db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  // B9（本轮改为预算感知，M2）：连接打开 + 打身份标签 + 挂 __faulted 旗标（M1）+ PRAGMA
  //   busy_timeout（用当前剩余预算，封顶 5000，不再是固定 5000）的组合出口，initSchema 与
  //   rebuildUnderLock 都通过下方 runLifecycleInit 共用。
  //   deadlineTs：本次初始化/重建的绝对截止时间戳（软预算，锁等待与退避用，见 §1.5）。
  async function openAndPrepare(deadlineTs) {
    _testHooks.openAndPrepareCallCount += 1; // H5①：verify 用它断言"第二次 initSchema 被忽略、没有真的再开连接"
    const db = await openItDb();
    _testHooks.lifecycleCounters.opened += 1; // S6
    _testHooks.lastOpenedDbForTest = db; // M1：供 verify 拿到"发布前"的连接引用手动 emit('error')
    // S2：db.__id 已在 openItDb 构造时分配，这里不再重复赋值（避免同一条连接背两个 id）。
    db.__faulted = false; // 由 openItDb 内的 on('error') 监听器统一维护，此处不再重复挂监听器
    // S3（17-R4S 必修）：openGate 的 await 挪进这个"连接关闭保护"try 内——闸本身也可能失败
    // （awaitGateWithTimeout 30s 超时），和 PRAGMA 失败走同一条"关闭局部 db 后抛出"收尾路径，
    // 不再是闸失败就直接裸抛、把已打开但未发布的连接晾在那里。
    try {
      if (_testHooks.openGate) {
        // L2/L6：测试专用可等待闸，卡住启动初始化流程供 verify 精确操纵停机时序；到达即 resolve
        // "arrived" 信号，供 verify 不靠猜 sleep 时长就知道流程确实已经卡在闸上。
        if (_testHooks.openGateArrivedResolve) {
          _testHooks.openGateArrivedResolve();
          _testHooks.openGateArrivedResolve = null;
        }
        await awaitGateWithTimeout(_testHooks.openGate, 'openGate', () => { _testHooks.openGate = null; });
      }
      const remaining = Math.max(0, deadlineTs - Date.now());
      const busyTimeout = Math.min(5000, remaining); // M2：初始化期 busy_timeout 不超过剩余预算
      await new Promise((resolve, reject) => {
        db.run(`PRAGMA busy_timeout = ${busyTimeout}`, (err) => (err ? reject(err) : resolve()));
      });
    } catch (openErr) {
      // S2/S4：关闭失败也要被观察，不能吞掉——改走 discardUnpublished（统一出口），关闭结果与
      // 原始失败一起向上返回（挂在抛出的错误对象上）。
      const closeResult = await discardUnpublished(db, `openAndPrepare失败: ${openErr.message}`);
      openErr.closeResult = closeResult;
      throw openErr;
    }
    return db;
  }

  // itTxnMutex：照抄 archive/itasset-phase-b-20260903:routes/it-assets/index.js 的
  //   itAssetLinkTransitionMutex FIFO 队列闭包范式（acquire(timeoutMs)/release）。
  //   本模块用它同时串行化"读"与"写"（方案 §2.1："读也进锁"），故命名不带 Link 语义。
  const itTxnMutex = (() => {
    let locked = false;
    const waiters = [];

    // S1（17-R3S 必修）：timeoutMs 传 0/null 表示不设超时——排在队尾无限期等待，供 shutdown()
    //   使用（draining 已挡住新请求，在途请求排空后队列必然让出锁；真的挂住是独立故障，交给
    //   进程级 kill 兜底，不该在 mutex 层面伪装成"等够了就放弃"）。
    function acquire(timeoutMs = 5000) {
      return new Promise((resolve, reject) => {
        const node = { resolve, timer: null, acquired: false };
        if (!locked) {
          locked = true;
          node.acquired = true;
          return resolve(makeRelease(node));
        }
        waiters.push(node);
        if (timeoutMs) {
          node.timer = setTimeout(() => {
            if (node.acquired) return;
            const idx = waiters.indexOf(node);
            if (idx >= 0) waiters.splice(idx, 1);
            const e = new Error('IT_LEDGER_MUTEX_WAIT_TIMEOUT');
            e.code = 'IT_LEDGER_MUTEX_WAIT_TIMEOUT';
            reject(e);
          }, timeoutMs);
        }
      });
    }

    function makeRelease(node) {
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        while (waiters.length > 0) {
          const next = waiters.shift();
          if (next.acquired) {
            logger.warn('[it-ledger-mutex] invariant violated: waiter.acquired=true while still in queue');
            continue;
          }
          if (next.timer) clearTimeout(next.timer);
          next.acquired = true;
          return next.resolve(makeRelease(next));
        }
        locked = false;
      };
    }

    return {
      acquire,
      _internals: { isLocked: () => locked, waiterCount: () => waiters.length },
    };
  })();

  // 1.2 末尾（reinitForTest）用：取 mutex 后运行 fn，无论成败都 release——供测试专用的"外部强制
  //   重建"入口使用，与业务事务（withRead/withWrite）互斥，不绕过串行模型。
  // S3（17-R5S 必修）：timeoutMs 可选，默认 30000（initSchema/reinitForTest 用）——
  //   scheduleSelfHealIfNeeded 传 0（不设超时）：自愈排队本质上和 shutdown() 的处境一样
  //   （draining 挡新请求/在途事务跑完队列必然让出锁），不该因为一个固定超时数字就放弃一次
  //   本该发生的自愈重建；真正的死锁式挂起是独立故障，交给进程级 kill 兜底。
  async function withLifecycleLock(fn, timeoutMs) {
    const release = await itTxnMutex.acquire(timeoutMs === undefined ? 30000 : timeoutMs);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  // ROLLBACK 统一出口（供测试注入 #10/#10b）。conn：调用方取锁后捕获的那条连接（1.4 连接绑定），
  //   不再读全局 itDb——业务回调执行期间即使全局 itDb 被替换（只可能发生在锁内重建，而此时不
  //   存在别的在途事务），本函数处理的仍是自己事务开始时捕获的那条连接。
  //   主会话 2026-09-18 行号抽查抓出的必修点（方案 §6 路径3「COMMIT 失败且事务仍活动」的反面）：
  //   SQLITE_FULL / SQLITE_IOERR / SQLITE_NOMEM / SQLITE_INTERRUPT 等错误会让 SQLite 自动结束
  //   事务（COMMIT 或路径2的业务 SQL 均可能触发），此时事务已不存在，ROLLBACK 会报
  //   "cannot rollback - no transaction is active"——这不是"ROLLBACK 真的失败"，是"没有事务可
  //   回滚"，按已回滚处理（豁免），不升级为路径4模块不可用；其余真实 ROLLBACK 失败（连接层
  //   错误等）仍照旧抛出触发 handleRollbackFailure。豁免可被 _testHooks.disableNoTxnExemption
  //   关闭（用例14 活体变异③，验证这道豁免本身确实在起作用）。
  //   S6（17-R4S 必修，收紧 B6 的豁免范围）：豁免正则改回精确匹配
  //   /no transaction is active|cannot rollback/i（"没有事务可回滚"这一件事）。"Database is
  //   closed" 单独开一个分支——同样按已回滚处理（return，不升级为路径4），但额外对这条 conn
  //   置 __faulted 并通过 scheduleSelfHealIfNeeded 排一次锁内重建（若尚未排过）：这是发现
  //   "连接已经真的关闭"的另一个入口，不能光豁免不触发自愈，否则模块会卡在"表面上已回滚但
  //   实际上没有任何机制会去修好这条坏连接"的状态。其它 SQLITE_MISUSE（不是明确的"已关闭"）
  //   仍照旧抛出触发路径4——那类错误语义不明确，不该被静默吞掉。
  async function execRollback(conn) {
    _testHooks.rollbackCallCount += 1; // T3：只读调用计数，供 verify 断言"路径1(BEGIN失败)确实未发ROLLBACK"
    traceConn('ROLLBACK', conn, 'ROLLBACK'); // S4/T6：连接使用轨迹
    try {
      if (_testHooks.rollbackFailure === 'no_txn') {
        throw new Error('SQLITE_ERROR: cannot rollback - no transaction is active');
      }
      // S5 配套：字符串（非 'no_txn'）时原样当错误文案抛出——供 verify 精确构造"含 cannot
      // rollback 但不含完整豁免短语"这类边界消息，验证豁免正则真的是精确匹配而非松散关键词。
      if (typeof _testHooks.rollbackFailure === 'string') {
        throw new Error(_testHooks.rollbackFailure);
      }
      if (_testHooks.rollbackFailure) {
        throw new Error('测试注入失败: ROLLBACK');
      }
      await dbRunOn(conn, 'ROLLBACK');
    } catch (err) {
      const msg = (err && err.message) || '';
      if (_testHooks.disableNoTxnExemption) {
        throw err; // 用例14 活体变异③：整体关闭豁免，两条分支都不豁免
      }
      // S5（17-R5S 必修）：精确匹配 SQLite 真实错误文案的完整短语——不再用两个松散的
      // 关键词并集（"no transaction is active"/"cannot rollback"各自单独出现都会误命中）。
      // 只有这条完整短语才代表"没有事务可回滚"，含"cannot rollback"但不含这句完整短语的
      // 其它错误（比如真实的连接/IO 故障）必须照旧升级为路径4，不能被这道豁免捎带放过。
      if (/cannot rollback - no transaction is active/i.test(msg)) {
        logger.warn('[it-ledger] ROLLBACK 时事务已不存在（按已回滚处理）: ' + msg);
        return;
      }
      if (/Database is closed/i.test(msg)) {
        logger.warn('[it-ledger] ROLLBACK 时连接已关闭（按已回滚处理，排队触发重建）: ' + msg);
        scheduleSelfHealIfNeeded(conn, msg);
        return;
      }
      throw err;
    }
  }

  // S3（17-R3S 必修）：复用 closeAndCount 的结构化结果——itDb 只在关闭**成功**后才置 null；
  //   关闭失败时保留 itDb 原样（不假装它已经消失），把模块判不可用，交给下一次
  //   rebuildUnderLock/reinitForTest 重新面对这条连接。closeAndCount 定义在下方"生命周期"一节，
  //   函数声明会被提升，这里调用不受文本顺序影响。
  async function closeItDb() {
    if (itDb) {
      const toClose = itDb;
      const result = await closeAndCount(toClose);
      if (result.ok) {
        itDb = null;
      } else {
        state.ready = false;
        state.error = `连接关闭失败: ${result.err ? result.err.message : '未知错误'}(__id=${result.connId})`;
        logger.error(`[it-ledger] 🚫 ${state.error}`);
      }
    }
  }

  // B5（主会话 2026-09-18 裁定）：三处"模块是否可用"的判定收敛成一处——requireLedgerReady、
  //   withRead/withWrite 锁前快速拒绝、锁后权威复核，全部读同一份判据，不允许三处各自维护
  //   "state.error 和 !state.ready 谁优先"这条顺序而漂移出不一致的错误码（旧版锁前检查只查
  //   !state.ready，重建失败态下会误判成 NOT_READY 而不是真正的 UNAVAILABLE）。draining 不在
  //   本判据范围内——它有独立语义与文案，三处各自先单独判 draining。
  function readinessError() {
    if (state.error) return { status: 503, code: 'LEDGER_UNAVAILABLE' };
    if (!state.ready) return { status: 503, code: 'LEDGER_NOT_READY' };
    return null;
  }
  function readinessErrorMessage(code) {
    return code === 'LEDGER_UNAVAILABLE' ? '信息化资产台账模块暂不可用' : '信息化资产台账模块正在初始化，请稍后重试';
  }
  function throwReadinessError() {
    const re = readinessError();
    if (re) {
      const e = new Error(readinessErrorMessage(re.code));
      e.status = re.status; e.code = re.code;
      throw e;
    }
  }

  // S1（17-R4S HIGH 根治）：isHealingCandidate()/admitForHealingOrThrowReadiness()（B3/B7 引入
  //   的自愈候选 CAS 认领）已整体删除——不再有"请求侧发现 faulted 就放行去自愈"这条路径。
  //   ensureUsableUnderLock 只保留"权威复核 → 查 itDb → 捕获 conn"，没有自愈分支：自愈已经
  //   在 S2 挪到连接层 error 监听器里主动触发（fire-and-forget），走到这里时要么模块已经因为
  //   state.ready=false 被 throwReadinessError() 挡下，要么 itDb 已经是重建完成后的新连接。
  async function ensureUsableUnderLock() {
    throwReadinessError();
    if (!itDb) {
      const e = new Error('信息化资产台账模块暂不可用'); e.status = 503; e.code = 'LEDGER_UNAVAILABLE'; throw e;
    }
    return itDb;
  }

  // ── 事务内写授权终判助手（§2.3 "写授权终判在锁内"）─────────────────────────────────
  // M2（主会话 2026-09-18 裁定，不改代码只记账）：C1 目前没有生产端点会调用 assertWrite——ACL
  //   三端点走 requireAdmin（admin 分支在 assertWrite 内直接放行，不需要终判），本模块尚未实现
  //   任何非 admin 可写的业务端点。assertWrite 本身已实现并被 verify 用例6/14①覆盖，**生产分支
  //   的实际覆盖挂账给 C2 的第一个非 admin 写端点**（届时该端点必须在 withWrite 内调用它）。
  // conn：调用方（withWrite）取锁后捕获的那条连接（1.4 连接绑定），不读全局 itDb。
  // G3A-c（41RS M2 必修）：可选 onSql 回调——只在真正即将发出 ACL 查询（下面的 dbGetOn）之前，
  //   用**真实 SQL 文本**调一次；缺少 user.id / admin 分支 / 调用方压根没传 onSql（比如
  //   skipAssertWriteForTest 分支根本不构造这个函数）都不会触发，探针记录因此精确对应"是否真的
  //   执行了 ACL 查询"，不是"assertWrite 被调用了几次"这种粗粒度信号。
  function makeAssertWrite(conn, onSql) {
    return async function assertWrite(user) {
      if (!user || user.id === undefined) {
        const e = new Error('缺少操作用户'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
      if (user.role === 'admin') return;
      const sql = 'SELECT level FROM it_asset_acl WHERE user_id = ?';
      if (typeof onSql === 'function') onSql(sql);
      const row = await dbGetOn(conn, sql, [user.id]);
      if (!row || row.level !== 'write') {
        const e = new Error('权限不足，无法执行写操作'); e.status = 403; e.code = 'LEDGER_FORBIDDEN'; throw e;
      }
    };
  }

  // ── withRead / withWrite（§2.1 四条错误路径逐条对应；行号见回报）─────────────────────
  async function withRead(fn) {
    // draining 检查须在"取锁之前"（调用时刻）判定，而非取锁之后——否则一条在 shutdown() 调用前
    //   就已排入队列、但此刻仍在等锁的旧请求，会在真正拿到锁时才看到 draining=true 被误杀，
    //   与"两条旧写都完成"的契约矛盾（§2.1："先拒绝新请求"，"新"以调用时刻界定，不是取锁时刻）。
    if (state.draining) {
      const e = new Error('模块正在停机，请稍后重试'); e.status = 503; e.code = 'LEDGER_DRAINING'; throw e;
    }
    // M5/B5（S1 订正：不再有 admitForHealingOrThrowReadiness）：requireLedgerReady 是路由层
    //   第一道就绪闸，但 withRead/withWrite 本身也可能被非路由路径直接调用（如 verify 白盒
    //   测试、未来的内部任务）——补第二道防线，回到纯 throwReadinessError()，与
    //   requireLedgerReady/锁后权威复核共用同一份判据。
    throwReadinessError();
    let release;
    try {
      release = await itTxnMutex.acquire(5000);
    } catch (mutexErr) {
      const e = new Error('系统繁忙，请稍后重试'); e.status = 503; e.code = 'LEDGER_BUSY'; throw e;
    }
    try {
      // B7（S1 订正：ensureUsableUnderLock 已不含自愈分支）：取锁后的权威复核收进共用助手。
      const conn = await ensureUsableUnderLock();
      // 1.4（连接绑定）：取锁并通过就绪判定后捕获 conn——本次事务全程只碰这一条连接，即使锁内
      // 自愈重建把全局 itDb 换成另一条（只可能发生在下一次取锁之后），也不会跨连接执行 SQL。
      // H1：withRead 的 SQL 恒不在写事务内——withRead 与 withWrite 共用同一把 itTxnMutex，若真的
      //   处在某个写事务内部，withRead 自己的 acquire() 会被那个事务卡住拿不到锁，走不到这里；
      //   能执行到这一行就已经证明当前没有任何写事务持锁，第三个参数恒传 false，不读 ALS store。
      const q = {
        get: (sql, params) => { traceConn('get', conn, sql); probeSql('get', sql, false, null); return dbGetOn(conn, sql, params); },
        all: (sql, params) => { traceConn('all', conn, sql); probeSql('all', sql, false, null); return dbAllOn(conn, sql, params); },
        run: (sql, params) => { traceConn('run', conn, sql); probeSql('run', sql, false, null); return dbRunOn(conn, sql, params); },
      };
      return await fn(q);
    } finally {
      release();
    }
  }

  // mapConstraintError（R-M1，codex 22-R）：纯函数，识别 node-sqlite3 抛出的原生
  // SQLITE_CONSTRAINT(UNIQUE) 错误并精确解析被违反的列集合，只有恰好等于
  // {it_assets.sn} 或 {it_assets.asset_no}（单列、完全匹配）才映射为对应业务码，其它任何
  // 唯一约束（复合索引、其它表）返回 null（调用方继续按原样处理，通常走向 500）。
  // 判据用 `err.code === 'SQLITE_CONSTRAINT'`（node-sqlite3 原生异常自带）而不是猜测式的
  // `!err.code`——后者对结构化业务错误（我们自己 throw 的、总是带 code）和原生驱动错误
  // （也总是带 code）都为 false，是个恒假判据，之前的实现正是栽在这里（详见调用点注释）。
  const UNIQUE_CONSTRAINT_PREFIX = 'UNIQUE constraint failed: ';
  function mapConstraintError(err) {
    if (!err) return null;
    const isConstraint = err.code === 'SQLITE_CONSTRAINT' || err.errno === 19;
    if (!isConstraint || typeof err.message !== 'string') return null;
    const idx = err.message.indexOf(UNIQUE_CONSTRAINT_PREFIX);
    if (idx === -1) return null;
    const colsText = err.message.slice(idx + UNIQUE_CONSTRAINT_PREFIX.length).trim();
    const cols = colsText.split(',').map((c) => c.trim()).filter(Boolean);
    if (cols.length === 1 && cols[0] === 'it_assets.sn') {
      return { status: 409, code: 'DUPLICATE_SN', field: 'sn', message: 'SN 重复(唯一索引兜底)' };
    }
    if (cols.length === 1 && cols[0] === 'it_assets.asset_no') {
      return { status: 409, code: 'DUPLICATE_ASSET_NO', field: 'asset_no', message: 'asset_no 重复(唯一索引兜底)' };
    }
    return null;
  }

  async function withWrite(fn) {
    // 见 withRead 同名注释：draining/ready 检查须在调用时刻做，取锁之前。
    if (state.draining) {
      const e = new Error('模块正在停机，请稍后重试'); e.status = 503; e.code = 'LEDGER_DRAINING'; throw e;
    }
    // 见 withRead 同名注释：回到纯 throwReadinessError()。
    throwReadinessError();
    let release;
    try {
      release = await itTxnMutex.acquire(5000);
    } catch (mutexErr) {
      const e = new Error('系统繁忙，请稍后重试'); e.status = 503; e.code = 'LEDGER_BUSY'; throw e;
    }
    // H1：txnMarker 是本次 withWrite 调用自己的、独立的可变标记对象——声明在 BEGIN 之前，此时
    //   还是 null（BEGIN 失败/未及构造事务时 finally 里判空跳过，不会 ReferenceError）。
    let txnMarker = null;
    try {
      // B7：见 withRead 同名注释。
      const conn = await ensureUsableUnderLock();
      // 1.4（连接绑定）：取锁并通过就绪判定后捕获 conn——本次事务（BEGIN/业务/COMMIT/ROLLBACK）
      // 全程只碰这一条连接。

      // 路径1：BEGIN 失败（含 SQLITE_BUSY）→ 不执行 ROLLBACK，503 LEDGER_BUSY（方案 §6）
      traceConn('BEGIN', conn, 'BEGIN IMMEDIATE'); // S4/T6：连接使用轨迹
      try {
        await dbRunOn(conn, 'BEGIN IMMEDIATE');
      } catch (beginErr) {
        logger.warn(`[it-ledger] BEGIN IMMEDIATE 失败(含 SQLITE_BUSY): ${beginErr.message}`);
        // 小项：路径直接挂在错误对象上（e.busyPath），不再用共享变量——并发写请求各自的错误
        // 对象互不干扰，不存在"读到别的请求刚设的值"这种串号可能。
        const e = new Error('系统繁忙，请稍后重试'); e.status = 503; e.code = 'LEDGER_BUSY'; e.busyPath = 'begin'; throw e;
      }

      // H1（G2A2b Commit3 必修，G3A 订正置 false 时机）：BEGIN 成功、事务正式开始——这个对象的
      //   生命周期就是"这次事务是否仍活动"的唯一真相源，q.get/all/run 直接闭包读它（不经过 ALS
      //   store 转发）。G3A 之前的实现统一在最外层 finally 里置 false——COMMIT/ROLLBACK 发出后到
      //   真正 resolve 之间存在一个窗口，此时读到的 active 仍是 true，构成 41S H1 漏报（回调保留
      //   q、在 COMMIT/ROLLBACK 已排入连接队列但尚未完成时调用 q.get，会被误判成事务内）。现在
      //   改为在发出 COMMIT / ROLLBACK 之前就置 false（见下方两处调用点），finally 里只保留一次
      //   兜底（见函数尾）。不管这次事务里派生出的 fire-and-forget 调用（不 await 的 withRead()、
      //   setImmediate 回调、事务结束后才被调用的已捕获 q）实际在哪个 tick 执行，只要那一刻这个
      //   对象的 active 已经是 false，就如实报告"不在事务内"——不会像旧的 store 继承方案那样把
      //   "创建时刻恰好在事务内"误判成"执行时刻也在事务内"。
      // G3A-c（41RT M3 必修）：BEGIN 成功、事务正式开始的这一刻分配 txnSeq——只在 TEST_HOOKS_ENABLED
      //   时才真正自增（生产路径这行恒把 seq 留空，不产生任何行为差异），本次 withWrite 调用全程
      //   内经 q.get/all/run/assertWrite 发出的所有探针记录共用这同一个 seq，供 verify 区分"同一次
      //   HTTP 请求先后打开的多个独立写事务"。
      txnMarker = { active: true, seq: TEST_HOOKS_ENABLED ? (++_txnSeqCounter) : undefined };
      // G3A-b（M6 必修）→ G3A-c（41RS M2 订正，只记真实 SQL）：assertWrite 是第四个真正可能执行
      //   SQL（ACL 查询）的入口——探针此前只覆盖 get/all/run 三个，assertWrite 内部直接用
      //   dbGetOn(conn,...) 裸调用同一条连接、完全绕开探针。这不是"锁外读"意义上的绕过（走的是
      //   同一条已在写事务内的连接，不构成 41S/41T 那种安全性质问题），而是探针"接通"证据的覆盖
      //   缺口。旧实现（G3A-b M6）无条件记一条占位 SQL `<assertWrite>`，即使 admin 分支/
      //   skipAssertWriteForTest 从未真正发出 ACL 查询也照记，是一条不存在的假 SQL 记录——改为
      //   给 makeAssertWrite 传 onSql 回调，只在真正即将发出 dbGetOn 之前用**真实 SQL 文本**记录
      //   （inWriteTxn 语义仍是闭包读 txnMarker.active，与 get/all/run 一致）；admin 分支/跳过
      //   分支不产生任何记录。
      const q = {
        get: (sql, params) => { traceConn('get', conn, sql); probeSql('get', sql, txnMarker.active, txnMarker.seq); return dbGetOn(conn, sql, params); },
        all: (sql, params) => { traceConn('all', conn, sql); probeSql('all', sql, txnMarker.active, txnMarker.seq); return dbAllOn(conn, sql, params); },
        run: (sql, params) => { traceConn('run', conn, sql); probeSql('run', sql, txnMarker.active, txnMarker.seq); return dbRunOn(conn, sql, params); },
        assertWrite: _testHooks.skipAssertWriteForTest ? async () => {} : makeAssertWrite(conn, (sql) => probeSql('get', sql, txnMarker.active, txnMarker.seq)),
      };
      let result;
      try {
        // S3（17-R4S 必修）：txnMidGate 的 await 挪进这个"业务 try"内——闸本身失败（比如
        // awaitGateWithTimeout 30s 超时）现在会被下面的 catch(bizErr) 接住，走路径2 ROLLBACK
        // 收尾，而不是在闸这一步裸抛、跳过 ROLLBACK 直接把异常甩给调用方。
        if (_testHooks.txnMidGate) {
          // T2：到达信号——真正开始等这个闸的那一刻 resolve。
          if (_testHooks.txnMidGateArrivedResolve) {
            _testHooks.txnMidGateArrivedResolve();
            _testHooks.txnMidGateArrivedResolve = null;
          }
          await awaitGateWithTimeout(_testHooks.txnMidGate, 'txnMidGate', () => { _testHooks.txnMidGate = null; });
        }
        // G2A2（H1 订正）：仅测试模式把业务回调执行包进 ALS 上下文（继承外层 store，比如
        //   requireLedgerWrite 已设置的 writeRequest:true）——store 里挂的是 txn: txnMarker
        //   这个对象引用本身（不是把 inWriteTxn 布尔值直接摊平进 store），纯粹是给"万一将来某处
        //   需要从 store 侧内省当前事务标记"留一个入口；q.get/all/run 的 inWriteTxn 判定完全不
        //   依赖这个 store 字段，直接读闭包里的 txnMarker（见上）。生产路径直接调用 fn(q)，不
        //   调用 ALS 的 run/exit/getStore（L1 订正措辞：ledgerRequestContext 这个实例本身在模块
        //   加载时就已构造，构造本身零开销；"生产路径不变"指的是不调用它的 run()/exit()/getStore()
        //   这几个方法，不是"实例不存在"）。
        if (TEST_HOOKS_ENABLED) {
          const parentStore = ledgerRequestContext.getStore() || {};
          result = await ledgerRequestContext.run({ ...parentStore, txn: txnMarker }, () => fn(q));
        } else {
          result = await fn(q);
        }
      } catch (bizErr) {
        // 路径2：业务 SQL / fn 抛错 → ROLLBACK → 按错误类别返回
        // G3A（41S H1 必修）：发出 ROLLBACK 之前先把 txnMarker.active 置 false——execRollback 内部
        //   的 dbRunOn(conn,'ROLLBACK') 一旦发出，这条连接上的事务就已经进入"正在结束"状态；此后
        //   若业务代码保留的 q 被再次调用（比如某个 fire-and-forget 派生调用碰巧卡在这条 await
        //   还没 resolve 的窗口内），探针必须如实报告"不在事务内"，不能因为 ROLLBACK 尚未完成就
        //   继续按"事务内"放行——那正是 41S H1 的漏报窗口。
        // G3A-c（41RS/41RT M1 订正口径，保守语义）：这里置 false 的时刻严格早于"ROLLBACK 已提交
        //   给数据库连接、驱动回调尚未完成"这个更窄的窗口——active 一旦置 false，从此刻起到
        //   ROLLBACK 真正完成为止的整段时间里，经这个 q 发出的任何 SQL 都统一报"不在事务内"，
        //   不区分"排在 ROLLBACK 之前"还是"排在 ROLLBACK 之后"（在 SQLite 单连接顺序执行的前提
        //   下，只要还没调用 dbRunOn(conn,'ROLLBACK')，业务代码这次调用理论上仍可能排在它前面，
        //   届时 SQL 语句本身确实还在事务内执行）。这是刻意选择的保守（悲观）口径——宁可把"事务
        //   收尾前夕、可能仍在事务内执行"的 SQL 也计为违规，不去精确复现"驱动层已提交、回调未
        //   完成"这个更窄的窗口（那需要侵入 sqlite3 驱动内部才能构造，不做）。G3A①b 用例卡的
        //   正是这个更宽的"标记已失效"窗口，天然覆盖了更窄的"ROLLBACK 已排队未完成"窗口，不代表
        //   它单独复现了后者。
        txnMarker.active = false;
        // G3A-b（M1 必修）：闸本身的异常（比如闸超时）不能反过来打断即将执行的 execRollback——
        //   回滚是这条路径的收尾动作，无论闸等待成功与否都必须无条件执行到底，否则会像 COMMIT
        //   侧旧实现一样，让连接停留在"BEGIN 已发出、ROLLBACK 从未发出"的半开事务状态，下一次
        //   写请求复用同一条连接会在 BEGIN IMMEDIATE 那一步直接 SQLITE 报错。只记 warn，不重新
        //   抛出。
        if (_testHooks.preCommitGate) {
          if (_testHooks.preCommitGateArrivedResolve) { _testHooks.preCommitGateArrivedResolve(); _testHooks.preCommitGateArrivedResolve = null; }
          try {
            await awaitGateWithTimeout(_testHooks.preCommitGate, 'preCommitGate(rollback)', () => { _testHooks.preCommitGate = null; });
          } catch (gateErr) {
            logger.warn(`[it-ledger] preCommitGate(rollback) 异常(不影响回滚,仍会执行execRollback): ${gateErr && gateErr.message}`);
          }
        }
        try {
          await execRollback(conn);
        } catch (rollbackErr) {
          await handleRollbackFailure(rollbackErr);
          const e = new Error('系统暂不可用'); e.status = 503; e.code = 'LEDGER_UNAVAILABLE'; throw e;
        }
        // S-H2（Opus 复看第5批）→ R-M1（codex 22-R 修复，2026-09）：SQLITE_CONSTRAINT(UNIQUE)
        // 精准兜底映射——只认 it_assets.sn / it_assets.asset_no 这两条唯一索引（单列、恰好命中，
        // 复合索引或其它表的唯一约束一律不映射），映射到对应业务码；其余维持原样直通 500。
        // R-M1 修复：原判据 `!bizErr.code` 写反了——node-sqlite3 的原生约束异常自带
        // `err.code === 'SQLITE_CONSTRAINT'`（errno 19），`!bizErr.code` 对这类错误恒为
        // false，导致这段兜底代码对真实驱动异常永远不会执行，是彻头彻尾的死代码。改用
        // `mapConstraintError`（纯函数，定义见"五、事件写入助手"节前，已导出供守卫直调单测）
        // 识别真正的 SQLITE_CONSTRAINT 错误并精确解析列集合。
        const mapped = mapConstraintError(bizErr);
        if (mapped) {
          const e = new Error(mapped.message); e.status = mapped.status; e.code = mapped.code; e.field = mapped.field; throw e;
        }
        throw bizErr;
      }

      // G3A（41S H1 必修）：发出 COMMIT 之前先把 txnMarker.active 置 false——理由同上面 bizErr
      //   分支：一旦 dbRunOn(conn,'COMMIT') 发出，即使这个 await 尚未 resolve，这条连接上的事务
      //   也已经进入"正在提交"状态，此后任何经这个 q 发出的 SQL 都不再享有"处于本次写事务内"的
      //   原子性保证，探针必须报告"不在事务内"。COMMIT 失败改走 ROLLBACK（下面 commitErr 分支）
      //   时 active 已经是 false，不需要再置一次。
      // G3A-c（41RS/41RT M1 订正口径，保守语义）：置 false 的时刻严格早于"COMMIT 已提交给数据库
      //   连接、驱动回调尚未完成"这个更窄的窗口——从这一刻起到 COMMIT 真正完成为止，经这个 q 发出
      //   的任何 SQL 一律报"不在事务内"，不区分它在 SQLite 单连接顺序执行下是否恰好还排在 COMMIT
      //   之前（届时该条 SQL 事实上仍在事务内执行）。这是刻意选择的保守（悲观）口径：宁可多算
      //   违规，也不去精确复现"驱动层已提交、回调未完成"这个更窄的窗口（需要侵入 sqlite3 驱动内部
      //   才能构造，不做）。G3A①用例卡的是这个更宽的"标记已失效"窗口，天然覆盖了更窄的"COMMIT
      //   已排队未完成"窗口，不代表它单独复现了后者。
      txnMarker.active = false;
      traceConn('COMMIT', conn, 'COMMIT'); // S4/T6：连接使用轨迹
      // G3A-b（M1 必修）：闸等待挪进这个 try——闸超时/闸回调本身抛错现在与 COMMIT 失败走同一条
      //   收尾路径（下面 catch(commitErr)：显式 ROLLBACK 后返回 503 LEDGER_BUSY busyPath='commit'），
      //   与本函数 S3 注释里 txnMidGate 放进业务 try 的既有约定一致。旧实现把闸等待放在这个 try
      //   之外——闸超时抛出的裸 Error 会直接穿透 withWrite()，既不 COMMIT 也不 ROLLBACK，连接
      //   停留在"BEGIN 已发出、事务从未真正结束"的状态，下一次写请求复用同一条连接会在
      //   BEGIN IMMEDIATE 那一步撞见"cannot start a transaction within a transaction"。
      try {
        if (_testHooks.preCommitGate) {
          if (_testHooks.preCommitGateArrivedResolve) { _testHooks.preCommitGateArrivedResolve(); _testHooks.preCommitGateArrivedResolve = null; }
          await awaitGateWithTimeout(_testHooks.preCommitGate, 'preCommitGate(commit)', () => { _testHooks.preCommitGate = null; });
        }
        await dbRunOn(conn, 'COMMIT');
      } catch (commitErr) {
        // 路径3：COMMIT 失败（含闸超时/闸回调异常）且事务仍活动 → 显式 ROLLBACK 后返回 503
        // （txnMarker.active 在上面已经置为 false，这里不用再处理）
        logger.warn(`[it-ledger] COMMIT 失败: ${commitErr.message}`);
        try {
          await execRollback(conn);
        } catch (rollbackErr2) {
          await handleRollbackFailure(rollbackErr2);
          const e = new Error('系统暂不可用'); e.status = 503; e.code = 'LEDGER_UNAVAILABLE'; throw e;
        }
        const e = new Error('系统繁忙，请稍后重试'); e.status = 503; e.code = 'LEDGER_BUSY'; e.busyPath = 'commit'; throw e;
      }
      return result;
    } finally {
      // G3A（41S H1 订正）：真正的置 false 时机已经挪到"发出 COMMIT / ROLLBACK 之前"（见上面两处
      //   调用点注释）——这里保留的是兜底：① 路径1（BEGIN 失败）从未走到过创建 txnMarker 之外的
      //   活动事务，到这里 txnMarker 恒为 null，判空后直接跳过；② 万一未来某条路径改动后漏加
      //   "提交/回滚前置 false"（比如新增第四条路径），这里仍能保证事务真正结束后 active 不会
      //   停留在 true——重复置一次 false 是幂等操作，不影响已经正确处理的路径。
      if (txnMarker) txnMarker.active = false;
      release();
    }
  }

  // 1.2（C1 串行化重构）：重建的唯一实现——供两处调用：① withRead/withWrite 取锁后发现
  //   itDb.__faulted 的自愈路径；② handleRollbackFailure（withWrite 的 catch 分支，已持锁）；
  //   ③ _internals.reinitForTest（经 withLifecycleLock 取锁后调用）。**调用方必须已持有
  //   itTxnMutex，本函数自己不 acquire**——串行模型下重建与业务事务天然互斥，不再需要代次仲裁。
  async function rebuildUnderLock(opts) {
    const fastMode = !!(opts && opts.fastMode);
    // S5（17-R4S 必修）：recoveryForbidden 一旦置位就是终态——旧连接关闭失败过一次，说明这个
    // 进程里的连接状态已经不可信，不再尝试打开新连接（避免在一个已经诡异的状态上继续摞新的
    // 不确定性）。只有 reinitForTest()（测试专用，语义等价"运维重启"）会清空它。
    if (state.recoveryForbidden) {
      state.ready = false;
      state.error = '模块已不可用，需重启恢复';
      return { ok: false, kind: 'forbidden' };
    }
    // B4（17-R4-B 必修）：停机流程已经启动——不再开新连接。shutdown() 会自己负责关闭 itDb；
    // 这里提前退出，避免和 shutdown() 的 closeItDb() 打架（两边都想碰 itDb）。典型触发场景：
    // withRead/withWrite 取锁排队期间 shutdown() 被调用，轮到这次请求进锁自愈时模块已经在停机。
    if (state.draining) {
      state.ready = false;
      state.error = '模块停机中，不再重建';
      return { ok: false, kind: 'draining' };
    }
    state.ready = false;
    const toClose = itDb;
    if (toClose) {
      // S3（17-R3S 必修）：关闭失败 → 不发布替代连接，直接返回失败；itDb 保持原样（不置
      // null，不假装这条连接已经消失），state 记下明确的"连接关闭失败"文案（含 __id）。
      const closeResult = await closeAndCount(toClose);
      if (!closeResult.ok) {
        state.ready = false;
        state.recoveryForbidden = true; // S5：旧连接关闭失败 = 终态
        state.error = `连接关闭失败: ${closeResult.err ? closeResult.err.message : '未知错误'}(__id=${closeResult.connId})，模块已不可用，需重启恢复`;
        logger.error(`[it-ledger] 🚫 ${state.error}`);
        return { ok: false, kind: 'close', error: closeResult.err || new Error(state.error) };
      }
      itDb = null; // 只在关闭成功后才置 null
    }
    const result = await runLifecycleInit({ fastMode });
    if (!result.ok) {
      // S1/S2 订正：自愈失败是终态——不是因为"withRead/withWrite 的自愈判据不会再放行"（那条
      // 请求侧自愈分支已随 healing 子系统删除），而是因为失败后 itDb 为 null，S2 的自愈触发点
      // 只挂在"当前已发布连接"的 'error' 事件上，没有连接对象就不会再有任何事件把新一轮重建
      // 排上队——与方案 §6"初始化失败保持 503"同口径。要恢复只能人工 reinitForTest()（测试）
      // 或重启进程（生产），state.error 文案里显式写明这一点。
      state.ready = false;
      state.error = `重建连接失败: ${result.error ? result.error.message : '未知错误'}，模块已不可用，需重启恢复`;
      logger.error(`[it-ledger] 🚫 ${state.error}`);
    }
    return result;
  }

  // 路径4：ROLLBACK 失败 → 模块置不可用（503）并关闭 / 重建 itDb；重建成功且 schema 核验通过
  //   → ready 恢复（方案 §6）。
  // M4（本轮措辞修正，codex 17-R）：本函数确实是一条同步 await 链——**触发它的那次调用**（即
  //   抛出 LEDGER_UNAVAILABLE 给调用方的那次 withWrite）返回之后，后续请求立即成功或立即失败
  //   （取决于重建结果），不存在"拿到错误但状态还没定"的中间态。重建本身要花真实时间（close →
  //   open → PRAGMA → 7 表 DDL 全部 await），这段时间内其他并发到达的 HTTP 请求仍可能命中
  //   state.ready===false 而拿到 503——这是正常的、预期内的短暂不可用窗口，不是 bug。
  // H4/1.2（C1 串行化重构）：已经在锁内（本函数只会从 withWrite 的 catch 分支调用，此刻
  //   release() 还没执行），直接调用共用的 rebuildUnderLock——它不 acquire mutex，与本函数
  //   共享同一把已持有的锁。
  async function handleRollbackFailure(rollbackErr) {
    logger.error(`[it-ledger] ROLLBACK 失败，模块置不可用: ${rollbackErr.message}`);
    state.ready = false;
    state.error = `ROLLBACK 失败: ${rollbackErr.message}`;
    await rebuildUnderLock({ fastMode: true });
  }

  // ============================================================
  // 二、DDL（7 表 + 索引，方案 §2.1–§2.6；§2.8/§2.9 对账两表 = R1 范围，本 commit 不建）
  // ============================================================
  // 常量归一（coordinator 2026-09-19 裁定）：CATEGORY_VALUES/STATUS_VALUES 不再本地重复声明，
  //   一律引用 invariants.js 的导出（invariants 是零依赖纯模块，方向正确——index.js 依赖它，
  //   不是反过来）。STATUS_VALUES = 硬件五态 + 软件订阅两态，DDL 的 CHECK IN 拼接串直接消费
  //   同一份数组，不再有"两处各自维护同一枚举"的漂移风险。
  const CATEGORY_VALUES = invariants.CATEGORY_VALUES;
  const STATUS_VALUES = invariants.HARDWARE_STATUSES.concat(invariants.SOFTWARE_STATUSES);

  // ACTIONS/NULL_ASSET_ACTIONS 提前到此处定义（早于本被 DDL_STATEMENTS 消费——H1 必修：
  //   it_asset_events.action 列需要 CHECK 约束，枚举值与事件写入助手的运行时校验必须同源，不
  //   允许出现"建表时允许的动作码"和"写入时允许的动作码"两份独立维护的清单。完整的 ACTIONS
  //   语义注释、PAYLOAD_KEYS、writeEvent 等仍在下方"五、事件写入助手"一节，不重复搬迁。
  const ACTIONS = new Set([
    // §4 动作族矩阵（19 个，逐行按表序）
    'rack_in', 'rack_out', 'rack_move', 'rack_relocate',
    'place', 'relocate', 'ap_place', 'ap_relocate',
    'assign', 'reassign', 'return',
    'disk_mount', 'disk_unmount', 'disk_swap', 'disk_move',
    'mark_status', 'retire', 'renew', 'cancel',
    // C1 冻结的非动作族事件类型
    'update', 'register', 'acl_grant', 'acl_revoke', 'floor_update',
  ]);
  // NULL_ASSET_ACTIONS：其余 action 的 asset_id 必须非空（事务内校验，抛 500 级内部错误——
  //   这是编程错误不是用户错误，见 spec §2.5）。
  const NULL_ASSET_ACTIONS = new Set(['acl_grant', 'acl_revoke', 'floor_update']);

  // ============================================================
  // R1（信息化资产轻量台账 P10 对账族 · 长任务D · R1_对账表结构_spec.md）：常量 + 助手
  //   方案 §2.8/§2.9/§2.9.1（约束归属）/ §6「P10 结构增量」/ §7b.0 normalizeReconcileKey /
  //   §7b.1 result 十值与迁移表 / §7b.2 四种字段形态。本 commit 只建结构，不实现任何对账端点。
  // ============================================================
  // P10_ASSET_FIELDS：it_assets 新增三列（方案 §6 明文"均可空无默认值"），供 applyReconcileSchema
  //   的 ALTER TABLE 与 C2 白名单消费同源（spec §2.3）。
  const P10_ASSET_FIELDS = ['owner_name', 'owner_dept', 'asset_class'];
  // asset_class 合法值（方案 §2.1 2026-09-19 已改口径：无 DB CHECK，取值集合改由所有写入口
  //   服务层校验）。R1 的 ALTER TABLE ADD COLUMN 只加纯 TEXT 列（方案 §6"均可空无默认值"未
  //   要求随 ALTER 带 CHECK，SQLite 对 ALTER 新增 CHECK 约束有版本相关限制，且已由用户拍板
  //   明确不做 DB 层约束）——此常量只供服务层校验（C2+）与本模块 verify 断言复用，不在
  //   it_assets.asset_class 上加 DB CHECK（不做超出 R1 契约的加法）。
  const ASSET_CLASS_VALUES = ['fixed', 'low_value'];

  // assertAssetClass（rec 回补，方案 §2.1）：null/undefined = 未分类，放行；否则必须 ∈
  //   ASSET_CLASS_VALUES（大小写敏感）。本批只建助手，C2 登记/编辑入口接线时调用——所有写
  //   asset_class 列的入口都必须调用本助手（唯一取值集合权威源，同 ACTIONS 的 H1 原则）。
  function assertAssetClass(value) {
    if (value === null || value === undefined) return { ok: true };
    if (typeof value !== 'string' || !ASSET_CLASS_VALUES.includes(value)) {
      return { ok: false, code: 'INVALID_ASSET_CLASS' };
    }
    return { ok: true };
  }

  // RECONCILE_RESULTS：result 十值（§7b.1），DDL CHECK 与运行时校验同源（同 ACTIONS 的 H1 原则）。
  const RECONCILE_RESULTS = [
    'pending', 'found', 'missing', 'mismatch',
    'not_in_ledger', 'ledger_added',
    'not_in_sheet', 'confirmed_off_book',
    'ambiguous', 'ledger_fixed',
  ];
  // 自动分类四值（建批次时产生）⇒ checked_* 恒 NULL；其余六值（四条链终态）⇒ checked_* 非空
  // （§7b.1："checked_by/checked_at 只由 check/bulk 端点写"）。
  const RECONCILE_AUTO_RESULTS = ['pending', 'not_in_ledger', 'not_in_sheet', 'ambiguous'];
  const RECONCILE_TERMINAL_RESULTS = RECONCILE_RESULTS.filter((r) => !RECONCILE_AUTO_RESULTS.includes(r));

  // RECONCILE_TRANSITIONS：服务端冻结的迁移表（§7b.1），{from: Set(to)}，供 R3 校验；终态的
  //   to 为空 Set（表外一律 409，不设通用 result 写入口）。
  const RECONCILE_TRANSITIONS = {
    pending: new Set(['found', 'missing', 'mismatch']),
    not_in_ledger: new Set(['ledger_added']),
    not_in_sheet: new Set(['confirmed_off_book']),
    ambiguous: new Set(['ledger_fixed']),
    found: new Set(),
    missing: new Set(),
    mismatch: new Set(),
    ledger_added: new Set(),
    confirmed_off_book: new Set(),
    ledger_fixed: new Set(),
  };

  // RECONCILE_SHAPES：§7b.2 四种字段形态穷举——程序化生成 DB CHECK（buildShapeCheckSql），
  //   避免手写 SQL 逐列打字错误与 spec 逐条核对不一致。true=该列非空，false=该列必须为空。
  const RECONCILE_SHAPES = [
    { // 唯一匹配
      results: ['pending', 'found', 'missing', 'mismatch'],
      assetId: true, externalKey: true, externalRow: true, ledgerSnapshot: true, ambiguousCandidates: false,
    },
    { // 册上有台账无
      results: ['not_in_ledger', 'ledger_added'],
      assetId: false, externalKey: true, externalRow: true, ledgerSnapshot: false, ambiguousCandidates: false,
    },
    { // 台账有册上无
      results: ['not_in_sheet', 'confirmed_off_book'],
      assetId: true, externalKey: false, externalRow: false, ledgerSnapshot: true, ambiguousCandidates: false,
    },
    { // 编号歧义
      results: ['ambiguous', 'ledger_fixed'],
      assetId: false, externalKey: true, externalRow: true, ledgerSnapshot: false, ambiguousCandidates: true,
    },
  ];

  // M1（codex 18 回补，方案 §2.9.1 新增行，2026-09-19 用户拍板）：ambiguous 分支的
  //   ambiguous_candidates 不再只判 IS NOT NULL——DB CHECK 层再收紧到"合法 JSON 数组且长度
  //   ≥2"（json_valid + json_type='array' + json_array_length>=2），拦掉 '[]'/'[{}]'/'null'/
  //   '{}'/长度 1 这类"非空但不合法"的值；元素内部键集合/id 唯一性等更细的校验留服务层
  //   validateAmbiguousCandidates（见下）。SQLite 3.44.2 内置 JSON1，无需扩展。
  function ambiguousCandidatesCheckExpr(nonNull) {
    if (!nonNull) return 'ambiguous_candidates IS NULL';
    return "(ambiguous_candidates IS NOT NULL AND json_valid(ambiguous_candidates)"
      + " AND json_type(ambiguous_candidates)='array' AND json_array_length(ambiguous_candidates) >= 2)";
  }

  function buildShapeCheckSql() {
    const col = (name, nonNull) => `${name} IS ${nonNull ? 'NOT NULL' : 'NULL'}`;
    return RECONCILE_SHAPES.map((shape) => {
      const resultIn = shape.results.map((r) => `'${r}'`).join(',');
      return `(result IN (${resultIn})`
        + ` AND ${col('asset_id', shape.assetId)}`
        + ` AND ${col('external_key', shape.externalKey)}`
        + ` AND ${col('external_row', shape.externalRow)}`
        + ` AND ${col('ledger_snapshot', shape.ledgerSnapshot)}`
        + ` AND ${ambiguousCandidatesCheckExpr(shape.ambiguousCandidates)})`;
    }).join('\n        OR ');
  }

  function buildCheckedStarCheckSql() {
    const autoIn = RECONCILE_AUTO_RESULTS.map((r) => `'${r}'`).join(',');
    const termIn = RECONCILE_TERMINAL_RESULTS.map((r) => `'${r}'`).join(',');
    return `(result IN (${autoIn}) AND checked_by IS NULL AND checked_at IS NULL)`
      + `\n        OR (result IN (${termIn}) AND checked_by IS NOT NULL AND checked_at IS NOT NULL)`;
  }

  // JSON 键集合（冻结，§2.8/§2.9），供 R2/R3 校验请求体/落库 JSON 是否超集。
  const SOURCE_META_KEYS = new Set([
    'filename', 'stored_name', 'key_rule_version', 'sheets', 'header_map',
    'parsed_at', 'parsed_by', 'total_rows', 'skipped_rows', 'unknown_sheets',
  ]);
  const EXTERNAL_ROW_KEYS = new Set([
    'sheet', 'row_no', 'dept', 'device_type', 'asset_no_raw', 'asset_name',
    'brand', 'model', 'purchased_at', 'qty', 'owner_name', 'remark', 'retired_hint',
  ]);
  const LEDGER_SNAPSHOT_KEYS = new Set([
    'version', 'asset_no', 'name', 'brand', 'model', 'sn', 'category', 'status',
    'owner_name', 'owner_dept', 'asset_class', 'location_desc',
  ]);
  const AMBIGUOUS_CANDIDATE_KEYS = new Set(['id', 'asset_no', 'name', 'sn', 'category', 'location_desc']);

  // validateAmbiguousCandidates（M1 回补，方案 §2.9.1）：DB CHECK 只管"合法 JSON 数组且长度
  //   ≥2"（见 ambiguousCandidatesCheckExpr），元素内部结构（键集合恰等于六键 / id 正整数且
  //   互不重复 / 其余字段 string|null）由服务层本函数校验。本批只建助手 + 导出 _internals，
  //   R2 建批次入口时接线调用（spec §2 明文"本批只建助手"）。
  function validateAmbiguousCandidates(value) {
    if (!Array.isArray(value)) return { ok: false, reason: 'not_array' };
    if (value.length < 2) return { ok: false, reason: 'too_short' };
    const seenIds = new Set();
    for (const item of value) {
      // codex 19预筛 L1 回补：原先的 `typeof item !== 'object'` 认所有非 null 对象（含类实例、
      //   Object.create(自定义原型)）为"普通对象"——类实例/自定义原型对象可能带原型链上的
      //   getter/方法伪装出"看起来像候选"的形状，不该被当成纯数据对象接受。改用严格判据：
      //   原型必须恰为 Object.prototype 或 null（Object.create(null) 场景）。
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        return { ok: false, reason: 'element_not_object' };
      }
      const proto = Object.getPrototypeOf(item);
      if (proto !== Object.prototype && proto !== null) {
        return { ok: false, reason: 'element_not_plain_object' };
      }
      // Reflect.ownKeys 恰等六键：既排除 Symbol 键（Object.keys 本就不含 Symbol，但显式改用
      //   Reflect.ownKeys 是为了让"排除 Symbol 键"这条判据在代码里可见、可测，不依赖
      //   Object.keys 的隐含行为）、也排除不可枚举键（下面逐个用 propertyIsEnumerable 复核）。
      const ownKeys = Reflect.ownKeys(item);
      const stringKeys = ownKeys.filter((k) => typeof k === 'string');
      if (stringKeys.length !== ownKeys.length) {
        return { ok: false, reason: 'has_symbol_key' };
      }
      if (!stringKeys.every((k) => Object.prototype.propertyIsEnumerable.call(item, k))) {
        return { ok: false, reason: 'has_non_enumerable_key' };
      }
      if (stringKeys.length !== AMBIGUOUS_CANDIDATE_KEYS.size || !stringKeys.every((k) => AMBIGUOUS_CANDIDATE_KEYS.has(k))) {
        return { ok: false, reason: 'key_set_mismatch' };
      }
      if (!Number.isInteger(item.id) || item.id <= 0) {
        return { ok: false, reason: 'invalid_id' };
      }
      if (seenIds.has(item.id)) return { ok: false, reason: 'duplicate_id' };
      seenIds.add(item.id);
      for (const field of ['asset_no', 'name', 'sn', 'category', 'location_desc']) {
        const v = item[field];
        if (v !== null && typeof v !== 'string') return { ok: false, reason: `invalid_field:${field}` };
      }
    }
    return { ok: true };
  }

  // normalizeReconcileKey（§7b.0，按顺序七步，永不抛错）：命名刻意与台账 asset_no 规则区分——
  //   不修改台账持久化编号（不作用于 §5 写入口、不触发任何 it_assets UPDATE），只用于对账明细
  //   内部匹配与展示；其规范化结果可保存在 external_key 中。
  const KEY_RULE_VERSION = 1;
  function normalizeReconcileKey(input) {
    // 1. 非字符串 / null / undefined
    if (typeof input !== 'string') return { ok: false, reason: 'empty' };
    // 2. 含任何换行（CR或LF，不论位置）→ newline，须在 trim 之前判（否则首尾换行被 trim 悄悄裁掉而变合法）
    if (/[\r\n]/.test(input)) return { ok: false, reason: 'newline' };
    // 3. 全角空格（U+3000）转半角 → trim
    let key = input.replace(/　/g, ' ').trim();
    // 4. 结果为空串 → empty，须在字符/长度校验之前（否则空串会先撞长度下限报 charset）
    if (key.length === 0) return { ok: false, reason: 'empty' };
    // 5. toUpperCase
    key = key.toUpperCase();
    // 6. 非 [A-Za-z0-9_-] 或长度 >64 → charset
    if (!/^[A-Za-z0-9_-]+$/.test(key) || key.length > 64) return { ok: false, reason: 'charset' };
    // 7. 否则 → ok
    return { ok: true, key };
  }

  const REQUIRED_TABLES = [
    'it_assets', 'it_racks', 'it_floors', 'it_asset_events',
    'it_asset_acl', 'it_stocktakes', 'it_stocktake_items',
  ];

  const DDL_STATEMENTS = [
    ['CREATE it_assets', `CREATE TABLE IF NOT EXISTS it_assets (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_no            TEXT,
      category            TEXT NOT NULL CHECK (category IN (${CATEGORY_VALUES.map(v => `'${v}'`).join(',')})),
      name                TEXT NOT NULL,
      brand               TEXT,
      model               TEXT,
      sn                  TEXT,
      status              TEXT NOT NULL CHECK (status IN (${STATUS_VALUES.map(v => `'${v}'`).join(',')})),
      slot_count          INTEGER NOT NULL DEFAULT 0 CHECK (slot_count >= 0),
      u_height            INTEGER NOT NULL DEFAULT 0 CHECK (u_height >= 0),
      u_start             INTEGER CHECK (u_start IS NULL OR u_start > 0),
      rack_id             INTEGER REFERENCES it_racks(id),
      location_text       TEXT,
      floor_id            TEXT REFERENCES it_floors(id),
      room_id             TEXT,
      pos                 TEXT,
      parent_asset_id     INTEGER REFERENCES it_assets(id),
      slot_no             INTEGER CHECK (slot_no IS NULL OR slot_no > 0),
      custodian_user_id   INTEGER REFERENCES users(id),
      custodian_name      TEXT,
      purchased_at        TEXT,
      expires_at          TEXT,
      attrs               TEXT NOT NULL DEFAULT '{}',
      fin_amount          REAL,
      fin_vendor          TEXT,
      fin_contract_no     TEXT,
      note                TEXT,
      version             INTEGER NOT NULL DEFAULT 1,
      created_by          INTEGER NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`],
    ['CREATE it_racks', `CREATE TABLE IF NOT EXISTS it_racks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT NOT NULL UNIQUE,
      room         TEXT NOT NULL DEFAULT '机房',
      u_total      INTEGER NOT NULL DEFAULT 42 CHECK (u_total > 0),
      sort_order   INTEGER NOT NULL DEFAULT 0,
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`],
    ['CREATE it_floors', `CREATE TABLE IF NOT EXISTS it_floors (
      id           TEXT NOT NULL PRIMARY KEY,
      name         TEXT NOT NULL UNIQUE,
      sort_order   INTEGER NOT NULL DEFAULT 0,
      rooms        TEXT NOT NULL DEFAULT '[]',
      note         TEXT,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`],
    ['CREATE it_asset_events', `CREATE TABLE IF NOT EXISTS it_asset_events (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      op_id              TEXT NOT NULL,
      asset_id           INTEGER REFERENCES it_assets(id),
      action             TEXT NOT NULL CHECK (action IN (${[...ACTIONS].map(v => `'${v}'`).join(',')})),
      role               TEXT NOT NULL CHECK (role IN ('primary','affected')),
      related_asset_id   INTEGER,
      from_state         TEXT NOT NULL,
      to_state           TEXT NOT NULL,
      operator_id        INTEGER NOT NULL,
      note               TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`],
    ['CREATE it_asset_acl', `CREATE TABLE IF NOT EXISTS it_asset_acl (
      user_id      INTEGER NOT NULL PRIMARY KEY REFERENCES users(id),
      level        TEXT NOT NULL CHECK (level IN ('read','write')),
      granted_by   INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`],
    ['CREATE it_stocktakes', `CREATE TABLE IF NOT EXISTS it_stocktakes (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT NOT NULL,
      scope        TEXT NOT NULL,
      status       TEXT NOT NULL CHECK (status IN ('open','closed')),
      created_by   INTEGER NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      closed_at    TEXT,
      closed_by    INTEGER,
      summary      TEXT,
      note         TEXT,
      CHECK (
        (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
        OR (status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
      )
    )`],
    ['CREATE it_stocktake_items', `CREATE TABLE IF NOT EXISTS it_stocktake_items (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      stocktake_id      INTEGER NOT NULL REFERENCES it_stocktakes(id),
      asset_id          INTEGER NOT NULL REFERENCES it_assets(id),
      expected          TEXT NOT NULL,
      result            TEXT NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','found','missing','mismatch')),
      actual            TEXT,
      checked_by        INTEGER,
      checked_at        TEXT,
      resolved_op_id    TEXT,
      note              TEXT,
      -- M9（主会话 2026-09-18 裁定）：此双向 CHECK 比方案 §2.6 字面更严——方案只写"result≠pending时
      -- checked_by/checked_at 非空"，未明文反向约束"pending 时两者必须为空"；这里把反向也钉成正式
      -- DB 约束（pending 恒无 checked_*），是主会话裁定的正式约束，方案 §2.6 待补充这一反向措辞。
      CHECK (
        (result = 'pending' AND checked_by IS NULL AND checked_at IS NULL)
        OR (result != 'pending' AND checked_by IS NOT NULL AND checked_at IS NOT NULL)
      ),
      CHECK (result != 'mismatch' OR actual IS NOT NULL)
    )`],
    // ── 索引（严格排在 7 张表建表之后）────────────────────────────────
    ['CREATE idx_it_assets_asset_no_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_assets_asset_no_unique ON it_assets(asset_no) WHERE asset_no IS NOT NULL`],
    ['CREATE idx_it_assets_sn_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_assets_sn_unique ON it_assets(sn) WHERE sn IS NOT NULL`],
    ['CREATE idx_it_assets_parent_slot_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_assets_parent_slot_unique ON it_assets(parent_asset_id, slot_no) WHERE parent_asset_id IS NOT NULL`],
    ['CREATE idx_it_asset_events_asset_id',
      `CREATE INDEX IF NOT EXISTS idx_it_asset_events_asset_id ON it_asset_events(asset_id, id)`],
    ['CREATE idx_it_asset_events_op_id',
      `CREATE INDEX IF NOT EXISTS idx_it_asset_events_op_id ON it_asset_events(op_id)`],
    ['CREATE idx_it_stocktake_items_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_stocktake_items_unique ON it_stocktake_items(stocktake_id, asset_id)`],
  ];

  const REQUIRED_INDEXES = [
    'idx_it_assets_asset_no_unique',
    'idx_it_assets_sn_unique',
    'idx_it_assets_parent_slot_unique',
    'idx_it_asset_events_asset_id',
    'idx_it_asset_events_op_id',
    'idx_it_stocktake_items_unique',
  ];

  // codex 18预筛第二轮 MED回补：从 CREATE TABLE DDL 文本里程序化提取列名集合（不手写第二份
  //   常量）——checkReconcileStructure 据此核"两表自身列集合"，与 RECONCILE_DDL_STATEMENTS
  //   单一事实源，DDL 改了列名此处自动同步，不存在"两份常量各自维护、彼此漂移"的风险。
  //   解析规则：剥离 `-- ...` 行注释后按顶层(括号深度0)逗号切分子句；子句若以
  //   CHECK/PRIMARY KEY/UNIQUE/FOREIGN KEY/CONSTRAINT 开头视为表级约束（非列定义）跳过，
  //   否则取子句首个标识符作为列名（涵盖 `col TYPE ... PRIMARY KEY ...`/`col TYPE REFERENCES
  //   ...`/`col TYPE CHECK(...)` 等列级修饰写法）。
  function extractColumnNamesFromCreateTableSql(sql) {
    const openIdx = sql.indexOf('(');
    const closeIdx = sql.lastIndexOf(')');
    const body = sql.slice(openIdx + 1, closeIdx).replace(/--[^\n]*/g, '');
    const clauses = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '(') depth += 1;
      if (ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        clauses.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) clauses.push(current);
    const TABLE_CONSTRAINT_KEYWORDS = /^\s*(CHECK|PRIMARY\s+KEY|UNIQUE|FOREIGN\s+KEY|CONSTRAINT)\b/i;
    const columns = [];
    for (const clause of clauses) {
      const trimmed = clause.trim();
      if (!trimmed || TABLE_CONSTRAINT_KEYWORDS.test(trimmed)) continue;
      const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (m) columns.push(m[1]);
    }
    return columns;
  }

  // ── R1 对账两表 + 三索引（结构事务，方案 §6 P10 段 / spec §2.1-§2.2）─────────────────
  const RECONCILE_REQUIRED_TABLES = ['it_reconciles', 'it_reconcile_items'];
  const RECONCILE_REQUIRED_INDEXES = [
    'idx_it_reconcile_items_ext_key_unique',
    'idx_it_reconcile_items_asset_id_unique',
    'idx_it_reconcile_items_result',
  ];
  // codex 18预筛 HIGH-2 回补：checkReconcileStructure 光核索引名字存在，测不出"同名但被悄悄
  //   改成非 UNIQUE / 改了列序"这类结构漂移（生产侧同款风险：手工建的旧库若曾有同名但非
  //   UNIQUE 的索引，CREATE UNIQUE INDEX IF NOT EXISTS 会静默跳过，留下一个名字对但语义错的
  //   索引）。这里冻结每个索引的 unique/partial 位与列序期望，供 checkReconcileStructure 核验。
  // codex 19预筛 risk2回补：加 where 字段——unique/partial 位只证明"有 partial 谓词"，不证明
  //   谓词内容对（比如把 WHERE external_key IS NOT NULL 误改成 WHERE asset_id IS NOT NULL 仍
  //   然是 unique=1/partial=1，位不会变）。where:null 表示非 partial 索引，不核谓词文本。
  const RECONCILE_INDEX_SPECS = {
    idx_it_reconcile_items_ext_key_unique: { unique: 1, partial: 1, columns: ['reconcile_id', 'external_key'], where: 'external_key IS NOT NULL' },
    idx_it_reconcile_items_asset_id_unique: { unique: 1, partial: 1, columns: ['reconcile_id', 'asset_id'], where: 'asset_id IS NOT NULL' },
    idx_it_reconcile_items_result: { unique: 0, partial: 0, columns: ['reconcile_id', 'result'], where: null },
  };
  // ALL_REQUIRED_TABLES/ALL_REQUIRED_INDEXES：供 verify 断言"全量 9 表+全部索引"用（保留导出，
  //   兼容既有 verify-it-ledger.js 用例10b 等）。checkReadiness 本身自 codex 18 H1 回补后不再
  //   直接消费这两个合并常量——C1 的 7 表/6 索引由 checkReadiness 自查，对账两表/三索引/
  //   it_assets 三列改由 checkReconcileStructure（见下）统一负责，事务提交前后各调一次同一
  //   函数（写读同源）。REQUIRED_TABLES/REQUIRED_INDEXES（7/6）保留不动。
  const ALL_REQUIRED_TABLES = REQUIRED_TABLES.concat(RECONCILE_REQUIRED_TABLES);
  const ALL_REQUIRED_INDEXES = REQUIRED_INDEXES.concat(RECONCILE_REQUIRED_INDEXES);

  const RECONCILE_DDL_STATEMENTS = [
    ['it_reconciles', `CREATE TABLE IF NOT EXISTS it_reconciles (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT NOT NULL,
      status        TEXT NOT NULL CHECK (status IN ('open','closed')),
      source_meta   TEXT NOT NULL,
      created_by    INTEGER NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      closed_at     TEXT,
      closed_by     INTEGER,
      summary       TEXT,
      note          TEXT,
      CHECK (
        (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
        OR (status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
      )
    )`],
    ['it_reconcile_items', `CREATE TABLE IF NOT EXISTS it_reconcile_items (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      reconcile_id           INTEGER NOT NULL REFERENCES it_reconciles(id),
      asset_id               INTEGER REFERENCES it_assets(id),
      external_key           TEXT,
      external_row           TEXT,
      external_amount        REAL,
      ledger_snapshot        TEXT,
      ambiguous_candidates   TEXT,
      result                 TEXT NOT NULL CHECK (result IN (${RECONCILE_RESULTS.map((v) => `'${v}'`).join(',')})),
      actual                 TEXT,
      checked_by             INTEGER,
      checked_at             TEXT,
      note                   TEXT,
      -- §7b.2 四种字段形态（穷举，程序化生成，见 buildShapeCheckSql）
      CHECK (
        ${buildShapeCheckSql()}
      ),
      -- §2.9.1：checked_by 与 checked_at 同时为空或同时非空
      CHECK (
        (checked_by IS NULL AND checked_at IS NULL) OR (checked_by IS NOT NULL AND checked_at IS NOT NULL)
      ),
      -- §7b.1：自动分类四值 checked_* 恒 NULL；四条链终态 checked_* 必须非空
      CHECK (
        ${buildCheckedStarCheckSql()}
      ),
      -- §2.9：result='mismatch' ⇒ actual 非 NULL；其他 result ⇒ actual 必须 NULL
      CHECK (
        (result = 'mismatch' AND actual IS NOT NULL) OR (result != 'mismatch' AND actual IS NULL)
      )
    )`],
    // 索引排在两表之后（spec §2.2）
    ['idx_it_reconcile_items_ext_key_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_reconcile_items_ext_key_unique ON it_reconcile_items(reconcile_id, external_key) WHERE external_key IS NOT NULL`],
    ['idx_it_reconcile_items_asset_id_unique',
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_it_reconcile_items_asset_id_unique ON it_reconcile_items(reconcile_id, asset_id) WHERE asset_id IS NOT NULL`],
    ['idx_it_reconcile_items_result',
      `CREATE INDEX IF NOT EXISTS idx_it_reconcile_items_result ON it_reconcile_items(reconcile_id, result)`],
  ];

  // codex 18预筛第二轮 MED回补：两表列名集合，从 RECONCILE_DDL_STATEMENTS 同源派生（见上方
  //   extractColumnNamesFromCreateTableSql）——checkReconcileStructure 用它核"表自身列集合"，
  //   拦住"IF NOT EXISTS 对已存在但列不全的旧表静默放行"这类漂移（HIGH-2 同款生产侧风险的
  //   列版本：手工建的旧库若曾有同名表但缺列，CREATE TABLE IF NOT EXISTS 不会补列）。
  const RECONCILE_TABLE_COLUMN_SPECS = {
    it_reconciles: extractColumnNamesFromCreateTableSql(RECONCILE_DDL_STATEMENTS[0][1]),
    it_reconcile_items: extractColumnNamesFromCreateTableSql(RECONCILE_DDL_STATEMENTS[1][1]),
  };

  // checkReconcileStructure（codex 18 H1 回补新增）：对账两表 + 三索引 + it_assets 三列的结构
  //   核验，单独抽出——事务提交前（applyReconcileSchema）与提交后（checkReadiness）各调一次
  //   同一份实现（写读同源）。事务提交前调用时，PRAGMA/sqlite_master 查询走的是"提交本连接、
  //   本事务内尚未 COMMIT 的 DDL"（同连接同事务内可见未提交变更，sqlite 3.44.2 语义），因此能
  //   在 COMMIT 之前就核出"虽然 CREATE/ALTER 语句本身没报错，但结构不符预期"这类问题。
  async function checkReconcileStructure(db) {
    // 测试注入（复用既有 ddlFailureLabel 比较字段，不新增 setter）：codex 18 spec §1 用例④
    //   "事务内结构核验不符"。
    if (_testHooks.ddlFailureLabel === 'RECONCILE_STRUCTURE_CHECK_FAIL') {
      return { ok: false, error: '测试注入失败(对账结构核验): RECONCILE_STRUCTURE_CHECK_FAIL' };
    }
    try {
      const tableRows = await dbAllOn(
        db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${RECONCILE_REQUIRED_TABLES.map(() => '?').join(',')})`,
        RECONCILE_REQUIRED_TABLES
      );
      const tableNames = (tableRows || []).map((r) => r.name);
      const missingTables = RECONCILE_REQUIRED_TABLES.filter((t) => !tableNames.includes(t));
      if (missingTables.length > 0) {
        return { ok: false, error: `对账表缺失: ${missingTables.join(',')}` };
      }
      // codex 18预筛第二轮 MED回补：表名存在只是第一关——IF NOT EXISTS 对已存在的表是纯只读
      //   快路径，不会补列。逐表核列名集合（缺列/多列都拒），不只核表名和索引。
      for (const tableName of RECONCILE_REQUIRED_TABLES) {
        // eslint-disable-next-line no-await-in-loop
        const colsRows = await dbAllOn(db, `PRAGMA table_info(${tableName})`);
        const actualColNames = new Set((colsRows || []).map((c) => c.name));
        const expectedColNames = RECONCILE_TABLE_COLUMN_SPECS[tableName];
        const missingCols = expectedColNames.filter((c) => !actualColNames.has(c));
        const extraCols = [...actualColNames].filter((c) => !expectedColNames.includes(c));
        if (missingCols.length > 0 || extraCols.length > 0) {
          return {
            ok: false,
            error: `对账表列不符: ${tableName}(缺列=${missingCols.join(',') || '无'};多列=${extraCols.join(',') || '无'})`,
          };
        }
      }
      const indexRows = await dbAllOn(
        db,
        `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${RECONCILE_REQUIRED_INDEXES.map(() => '?').join(',')})`,
        RECONCILE_REQUIRED_INDEXES
      );
      const indexNames = (indexRows || []).map((r) => r.name);
      const missingIndexes = RECONCILE_REQUIRED_INDEXES.filter((i) => !indexNames.includes(i));
      if (missingIndexes.length > 0) {
        return { ok: false, error: `对账索引缺失: ${missingIndexes.join(',')}` };
      }
      // codex 18预筛 HIGH-2：名字存在只是第一关——再核 unique/partial 位与列序（index 名不含
      //   参数占位符风险，全部来自本模块自己冻结的常量，不拼接外部输入）。
      const idxListRows = await dbAllOn(db, 'PRAGMA index_list(it_reconcile_items)');
      const idxListByName = {};
      for (const r of idxListRows || []) idxListByName[r.name] = r;
      for (const idxName of RECONCILE_REQUIRED_INDEXES) {
        const spec = RECONCILE_INDEX_SPECS[idxName];
        const row = idxListByName[idxName];
        if (!row || row.unique !== spec.unique || row.partial !== spec.partial) {
          return {
            ok: false,
            error: `对账索引结构不符: ${idxName}(实际unique=${row && row.unique},partial=${row && row.partial}；期望unique=${spec.unique},partial=${spec.partial})`,
          };
        }
        // eslint-disable-next-line no-await-in-loop
        const infoRows = await dbAllOn(db, `PRAGMA index_info(${idxName})`);
        const colSeq = (infoRows || []).slice().sort((a, b) => a.seqno - b.seqno).map((r) => r.name);
        if (JSON.stringify(colSeq) !== JSON.stringify(spec.columns)) {
          return {
            ok: false,
            error: `对账索引列序不符: ${idxName}(实际=${JSON.stringify(colSeq)}；期望=${JSON.stringify(spec.columns)})`,
          };
        }
        // codex 19预筛 risk2回补，codex 19-R MED-1 再修：partial 谓词文本对拍（PRAGMA
        //   index_list/index_info 只给 unique/partial 位与列序，不给 WHERE 子句本身——谓词
        //   内容改错但位不变的漂移只能靠核 sqlite_master.sql 文本本身拦住）。MED-1：原先用
        //   indexOf 子串匹配，`WHERE external_key IS NOT NULL AND reconcile_id < 0` 这种"谓词
        //   被追加了额外条件"的漂移也能蒙混过去（子串仍然存在）。改为：提取 WHERE 到末尾的
        //   完整子句（`/\bWHERE\b([\s\S]*)$/i`，SQLite 里 WHERE 后面没有别的子句，取到末尾即
        //   可）、去掉可能的尾部分号、空白折叠成单空格后与 spec.where 做**全等**比较（大小写
        //   不敏感）——多任何一个 AND 条件都会导致全等比较失败，不再是"包含即通过"。
        // eslint-disable-next-line no-await-in-loop
        const sqlRow = await dbGetOn(db, `SELECT sql FROM sqlite_master WHERE type='index' AND name=?`, [idxName]);
        const indexSqlText = (sqlRow && sqlRow.sql) || '';
        const whereMatch = indexSqlText.match(/\bWHERE\b([\s\S]*)$/i);
        const actualWhereClause = whereMatch
          ? whereMatch[1].replace(/;\s*$/, '').replace(/\s+/g, ' ').trim()
          : null;
        if (spec.where) {
          const expectedWhereClause = spec.where.replace(/\s+/g, ' ').trim();
          if (!actualWhereClause || actualWhereClause.toUpperCase() !== expectedWhereClause.toUpperCase()) {
            return {
              ok: false,
              error: `对账索引partial谓词不符: ${idxName}(实际WHERE="${actualWhereClause}"；期望="${expectedWhereClause}"；完整sql=${indexSqlText})`,
            };
          }
        } else if (actualWhereClause) {
          // 非 partial 索引不该有 WHERE 子句——有的话本身就是结构漂移（比如被悄悄改成了
          // partial index），必须拒。
          return {
            ok: false,
            error: `对账索引partial谓词不符: ${idxName}(期望非partial索引不含WHERE子句,实际含WHERE="${actualWhereClause}")`,
          };
        }
      }
      const assetCols = await dbAllOn(db, 'PRAGMA table_info(it_assets)');
      const assetColNames = (assetCols || []).map((c) => c.name);
      const missingAssetCols = P10_ASSET_FIELDS.filter((c) => !assetColNames.includes(c));
      if (missingAssetCols.length > 0) {
        return { ok: false, error: `it_assets 缺 P10 列: ${missingAssetCols.join(',')}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `对账结构核验异常: ${err.message}` };
    }
  }

  // readiness 最小 schema 合约（照 legacy-archive 思路：表存在 + 关键索引存在，不符 → ready=false）。
  // M2：接收显式 db 参数——发布前的 readiness 查询要打在本地 db 对象上，不是全局 itDb。
  // codex 18 H1 回补：C1 的 7 表/6 索引仍由本函数自查；对账两表/三索引/it_assets 三列的核验
  //   改调 checkReconcileStructure（与 applyReconcileSchema 提交前核验同源）。
  async function checkReadiness(db) {
    try {
      const tableRows = await dbAllOn(
        db,
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})`,
        REQUIRED_TABLES
      );
      const tableNames = (tableRows || []).map((r) => r.name);
      const missingTables = REQUIRED_TABLES.filter((t) => !tableNames.includes(t));
      if (missingTables.length > 0) {
        return { ok: false, error: `it-ledger 表缺失: ${missingTables.join(',')}` };
      }
      const indexRows = await dbAllOn(
        db,
        `SELECT name FROM sqlite_master WHERE type='index' AND name IN (${REQUIRED_INDEXES.map(() => '?').join(',')})`,
        REQUIRED_INDEXES
      );
      const indexNames = (indexRows || []).map((r) => r.name);
      const missingIndexes = REQUIRED_INDEXES.filter((i) => !indexNames.includes(i));
      if (missingIndexes.length > 0) {
        return { ok: false, error: `it-ledger 索引缺失: ${missingIndexes.join(',')}` };
      }
      const reconcileCheck = await checkReconcileStructure(db);
      if (!reconcileCheck.ok) {
        return reconcileCheck;
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: `readiness 核验异常: ${err.message}` };
    }
  }

  // applyReconcileSchema（R1 结构事务，方案 §6 P10 结构增量段 / spec §2.1）：
  //   BEGIN IMMEDIATE → ① CREATE it_reconciles ② CREATE it_reconcile_items ③ 三索引
  //   ④ PRAGMA table_info(it_assets) 判缺列 → 缺哪列 ALTER ADD COLUMN → 提交前三项核验
  //   （预算/连接故障/结构 readiness，codex 18 H1 回补）→ COMMIT。
  //   本函数自身返回 {ok:false}——codex 19预筛 rec③回补，收窄措辞：除"ROLLBACK 自身也失败"
  //   这一分支外（那种情况下事务状态不可控，见下方 catch 内层 catch），其余失败返回都对应
  //   "COMMIT 之前失败、已整体 ROLLBACK"（沿用 execRollback），结构与行数据在这个函数的视角内
  //   保证不变。COMMIT 是不可撤销点：本函数返回 ok:true 之后，
  //   调用方（runDdlAndReadiness）自己的后续检查（faulted/deadline/checkReadiness）若失败，
  //   结构已经提交，只是"本次初始化不发布"，不再是本函数的语义范围（方案 §6 2026-09-19 已改
  //   口径，见 runDdlAndReadiness 调用处注释）。调用方走 discardUnpublished，不新增就绪态。
  //   幂等：CREATE TABLE IF NOT EXISTS 与"缺列才 ALTER"均可重复执行零副作用。
  async function applyReconcileSchema(db, opts) {
    const deadlineTs = opts.deadlineTs;
    // codex 18预筛 MED-3：标记"是否已经真正执行到 COMMIT 语句本身"，供 catch 分支区分
    // "提交前三项检查未通过"与"COMMIT 语句自己失败"这两种不同语义（前者事务从未走到 COMMIT，
    // 后者是 COMMIT 本身没生效——两者都会被 ROLLBACK 兜底，但措辞不该混为一谈）。
    let committing = false;
    try {
      const remaining = Math.max(1, deadlineTs - Date.now());
      await new Promise((resolve, reject) => {
        db.run(`PRAGMA busy_timeout = ${Math.min(5000, remaining)}`, (err) => (err ? reject(err) : resolve()));
      });
      await dbRunOn(db, 'BEGIN IMMEDIATE');
    } catch (beginErr) {
      return { ok: false, error: `对账结构事务开启失败: ${beginErr.message}` };
    }

    try {
      // 测试注入复用既有的 _testHooks.ddlFailureLabel/setDdlFailureInjection（C1 已冻结在
      //   verify-it-ledger.js 用例T4 的 _internals 键差集清单里，本 commit 不许再新增测试专用
      //   setter 破坏那条冻结断言）——C1 的 DDL_STATEMENTS 标签（'CREATE it_assets' 等）与本表的
      //   标签（'it_reconciles'/'it_reconcile_items'/三个索引名/'ALTER it_assets ADD COLUMN
      //   <col>'）互不重叠，共用同一个字符串比较字段是安全的。
      for (const [label, sql] of RECONCILE_DDL_STATEMENTS) {
        if (_testHooks.ddlFailureLabel === label) {
          throw new Error('测试注入失败(R1结构事务): ' + label);
        }
        await dbRunOn(db, sql);
      }
      // ④ PRAGMA table_info(it_assets) 判缺列 → 缺哪列 ALTER 哪列（均可空无默认值，方案 §6）。
      //   asset_class 只加纯 TEXT 列，不带 DB CHECK——取值集合校验按方案 §2.1 新口径（2026-09-19
      //   已改）改由所有写入口服务层调用 assertAssetClass()，不在此列上加约束。
      const cols = await dbAllOn(db, 'PRAGMA table_info(it_assets)');
      const colNames = new Set((cols || []).map((c) => c.name));
      for (const col of P10_ASSET_FIELDS) {
        if (colNames.has(col)) continue; // 幂等：已存在则跳过，不重复 ALTER
        // spec §3 用例2"结构事务原子性"：注入第二/第三次 ALTER 失败（owner_dept/asset_class）。
        const alterLabel = `ALTER it_assets ADD COLUMN ${col}`;
        if (_testHooks.ddlFailureLabel === alterLabel) {
          throw new Error(`测试注入失败(R1结构事务): ${alterLabel}`);
        }
        await dbRunOn(db, `ALTER TABLE it_assets ADD COLUMN ${col} TEXT`);
      }

      // codex 18 H1 回补（方案 §6 2026-09-19 已改口径）：结构事务承诺边界——COMMIT 是不可撤销
      //   点，"初始化失败则 it_assets 结构与行数据都不变"这个承诺只能覆盖到 COMMIT 之前；预算
      //   检查、连接故障检查、结构 readiness 核验三项必须在 COMMIT 之前全部做完，任一不过就
      //   走 ROLLBACK（此刻两表/三列尚未提交，ROLLBACK 后连同 CREATE/ALTER 一并撤销）。三项
      //   顺序：① 预算（Date.now() > deadlineTs）② 连接故障（db.__faulted）③ 结构 readiness
      //   （checkReconcileStructure，同连接同事务内可见本事务尚未提交的 DDL）。
      if (_testHooks.ddlFailureLabel === 'RECONCILE_PRECOMMIT_DEADLINE' || Date.now() > deadlineTs) {
        throw new Error('对账结构事务提交前超时(预算已耗尽)');
      }
      // ③ 连接故障：真实路径判 db.__faulted（scheduleSelfHealIfNeeded 置位，测试可用
      //   getLastOpenedDbForTest() 拿引用真实 emit('error') 触发）；额外收一个确定性哨兵
      //   （同②的理由：真实路径依赖"DDL 全部跑完之前发生故障"这一时序窗口，容易随 DDL 语句数
      //   变化而变脆——sqlite_module_lifecycle_gotchas 与 feedback_timing_tests_signal_not_sleep
      //   均要求时序类断言禁用猜时序，哨兵给出一个不依赖调度的确定性验证路径，不新增 setter）。
      if (db.__faulted || _testHooks.ddlFailureLabel === 'RECONCILE_PRECOMMIT_FAULTED') {
        throw new Error('连接层错误: 对账结构事务提交前发生');
      }
      const structureCheck = await checkReconcileStructure(db);
      if (!structureCheck.ok) {
        throw new Error(`对账结构事务提交前核验未通过: ${structureCheck.error}`);
      }

      // codex 19 H1 回补：checkReconcileStructure 内部有多次 await（多条 PRAGMA/sqlite_master
      //   查询），返回 ok:true 到这里之间的等待窗口里，预算可能已耗尽、或 error 监听器可能已
      //   置位 __faulted——如果直接 COMMIT，会在"三项检查刚通过"和"真正提交"之间留一个没被
      //   两项检查覆盖的缝隙。同款范式=C1 发布点"最后一次仲裁与发布之间零 await"
      //   （sqlite_module_lifecycle_gotchas："发布点与最后一次检查之间零 await"）：核验成功
      //   返回后、COMMIT 语句执行前，同步（不经过任何 await）再查一次预算与 __faulted，中间
      //   不留可被插队的缝隙。
      if (_testHooks.ddlFailureLabel === 'RECONCILE_PRECOMMIT_DEADLINE' || Date.now() > deadlineTs) {
        throw new Error('对账结构事务提交前超时(预算已耗尽,核验后复核)');
      }
      if (db.__faulted || _testHooks.ddlFailureLabel === 'RECONCILE_PRECOMMIT_FAULTED') {
        throw new Error('连接层错误: 对账结构事务提交前发生(核验后复核)');
      }

      committing = true;
      await dbRunOn(db, 'COMMIT');
      return { ok: true };
    } catch (err) {
      try {
        await execRollback(db);
      } catch (rollbackErr) {
        logger.error(`[it-ledger] 对账结构事务 ROLLBACK 失败: ${rollbackErr.message}`);
        return { ok: false, error: `对账结构事务失败且回滚失败: ${err.message} / ${rollbackErr.message}` };
      }
      // codex 18预筛 MED-3 回补：COMMIT 语句本身抛错是独立分支——它发生在"提交前三项检查全部
      // 通过之后"，此时事务确实**从未真正提交**（COMMIT 失败代表这条语句自己没有生效），
      // ROLLBACK 撤销的是"三项检查通过后、COMMIT 执行前"这段状态，语义上不是"提交前已回滚"
      // （那句话专指三项检查本身没通过的分支），用独立文案避免和"提交前失败"这句话混为一谈。
      if (committing) {
        return { ok: false, error: `对账结构事务COMMIT失败(事务未提交,已回滚): ${err.message}` };
      }
      return { ok: false, error: `对账结构事务失败(提交前已回滚,结构与行数据未变): ${err.message}` };
    }
  }

  // SQLITE_BUSY 类错误判定（M1）：只对"忙"这一暂时性错误做退避重试，语法/约束等永久性错误
  //   重试无意义，直接判失败。
  function isBusyDdlError(err) {
    return !!(err && /SQLITE_BUSY|database is locked/i.test(err.message || ''));
  }

  // M1（主会话 2026-09-18 裁定）：对 SQLITE_BUSY 类错误做有限退避重试（5 次·500ms/1s/2s/4s/8s），
  //   仍败才判该条 DDL 失败；LOW 条一并修：**首条 DDL 失败即 break**，不再继续跑剩余语句
  //   （旧版会继续跑完整个 DDL_STATEMENTS 数组，导致第一张表建失败后，后续依赖它的索引语句
  //   连锁报"no such table"，纯噪音且无意义——见本轮改前 verify 日志实测）。
  const DDL_BUSY_RETRY_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
  // fastMode 下把退避预算压成单次 500ms 重试——handleRollbackFailure 调用本函数时事务锁仍被
  //   当前 withWrite 占着（release() 要等它跑完才执行），若继续用满额 5 次退避（最长 15.5s/条
  //   DDL × 多条语句），相当于"重建期间"把整个模块锁死可能长达几十秒到上百秒，其他并发请求
  //   全部排队等这一把锁——不可接受，用一条更短的退避换快速失败。
  const DDL_BUSY_RETRY_BACKOFF_MS_FAST = [500];

  // M2（codex 17-R 必修）：DDL 执行——不碰 state/itDb，只返回描述结果，由 runLifecycleInit 统一
  //   决定要不要发布/怎么收尾（本函数不知道自己是不是"赢家"，代次判定不归它管）。deadlineTs 是
  //   runLifecycleInit 传入的绝对截止时间戳（真实预算，不是"从本函数起再算一遍"）。
  async function runDdlAndReadiness(db, opts) {
    const fastMode = !!(opts && opts.fastMode);
    const backoffSchedule = fastMode ? DDL_BUSY_RETRY_BACKOFF_MS_FAST : DDL_BUSY_RETRY_BACKOFF_MS;
    const deadlineTs = opts.deadlineTs;
    let ddlError = null;
    for (const [label, sql] of DDL_STATEMENTS) {
      let lastErr = null;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (Date.now() > deadlineTs) {
          lastErr = new Error(`初始化整体超时(预算已耗尽)`);
          break;
        }
        if (db.__faulted) { // M1：每条 SQL 尝试前也查一次，故障连接不再继续跑后续 DDL
          lastErr = new Error('连接层错误: 初始化期间发生');
          break;
        }
        try {
          if (_testHooks.ddlFailureLabel === label) {
            throw new Error('测试注入失败: ' + label);
          }
          if (_testHooks.ddlBusyInjection && _testHooks.ddlBusyInjection.label === label && _testHooks.ddlBusyInjection.count > 0) {
            _testHooks.ddlBusyInjection.count -= 1;
            throw new Error('SQLITE_BUSY: database is locked (测试注入 · 用例1b/B3)');
          }
          // S3（本轮 codex 17-R2 必修）：每条 SQL 前按"此刻剩余预算"动态设置 busy_timeout，
          //   而不是只在 openAndPrepare 时设一次固定值——固定值设完之后如果前面几条 DDL/退避
          //   已经消耗掉大半预算，后面这条 SQL 仍可能傻等一个远超"实际剩余时间"的 busy_timeout，
          //   把等待上界真正钉死在预算内。上界 = 剩余预算 + 一次 SQL 的 busy_timeout 本身（含
          //   SQLite busy 重试循环约 1.5× 的真实调度开销，实测见用例 M2-② 的注释）。
          const remainingForThisSql = Math.max(1, deadlineTs - Date.now());
          const dynamicBusyTimeout = Math.min(5000, remainingForThisSql);
          await new Promise((resolve, reject) => {
            db.run(`PRAGMA busy_timeout = ${dynamicBusyTimeout}`, (err) => (err ? reject(err) : resolve()));
          });
          await dbRunOn(db, sql);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isBusyDdlError(err) || attempt >= backoffSchedule.length) break;
          if (Date.now() + backoffSchedule[attempt] > deadlineTs) {
            // 等这次退避会超过 deadline，不必再等，直接判失败（不浪费时间等一个注定超时的结果）。
            break;
          }
          logger.warn(`[it-ledger] DDL @${label} 遇忙(第${attempt + 1}次)，退避${backoffSchedule[attempt]}ms后重试: ${err.message}`);
          // L6：真正进入退避 setTimeout 等待的这一刻 resolve "到达"信号，供 verify 不靠猜
          // sleep 时长就能确定"流程确实已经卡在退避窗口里"。
          if (_testHooks.ddlBackoffArrivedResolve) {
            _testHooks.ddlBackoffArrivedResolve();
            _testHooks.ddlBackoffArrivedResolve = null;
          }
          await new Promise((r) => setTimeout(r, backoffSchedule[attempt]));
          attempt += 1;
        }
      }
      // M1：这条 DDL 语句本身跑完（无论成功与否）之后再查一次——覆盖"重试等待期间报的错，
      //   紧接着下一次尝试又恰好成功"这种命中窗口很窄的时序。
      if (db.__faulted && !lastErr) {
        lastErr = new Error('连接层错误: 初始化期间发生');
      }
      if (lastErr) {
        ddlError = `${label}: ${lastErr.message}`;
        logger.error(`[it-ledger] DDL 失败 @${label}: ${lastErr.message}`);
        break;
      }
    }
    if (ddlError) {
      return { ok: false, error: `建表失败: ${ddlError}` };
    }
    if (Date.now() > deadlineTs) {
      return { ok: false, error: '初始化整体超时(预算已耗尽)' };
    }
    // R1（spec §2.1）：C1 的 7 表 DDL 跑完之后、统一 readiness 核验（已扩为 9 表，见下方
    //   checkReadiness）之前，另起一个结构事务 applyReconcileSchema——建对账两表 + 三索引 +
    //   it_assets 补三列，四步在同一显式事务内执行；预算/连接故障/结构 readiness 三项核验已
    //   收进该事务内部、COMMIT 之前完成（codex 18 H1 回补），提交前失败整体 ROLLBACK、结构与
    //   行数据均不变。applyReconcileSchema 返回 ok:true 时 COMMIT 已经落地——本行往下（含
    //   db.__faulted / deadline / checkReadiness）全部是**提交后**的检查：COMMIT 是不可撤销
    //   点，这些检查只决定"这次初始化本身是否发布"，命中任一条只代表"提交后失败：结构与
    //   it_assets 三列已提交、本次初始化不发布"，不再承诺、也不撤销"结构未变"（方案 §6
    //   2026-09-19 已改口径）。
    const reconcileResult = await applyReconcileSchema(db, { deadlineTs });
    if (!reconcileResult.ok) {
      return { ok: false, error: reconcileResult.error };
    }
    // codex 18预筛 HIGH-1 回补：提交后失败哨兵——复用既有 ddlFailureLabel 比较字段（不新增
    //   setter），命中即判"提交后失败"，方向是多一条拒绝（COMMIT 已经真实落地之后才检查这个
    //   哨兵，不影响 applyReconcileSchema 自身的提交前原子性），供 verify 区分"提交后失败"与
    //   "正常初始化到底后再人工破坏已发布连接"这两种不同语义（前者是本函数自身的失败分支，
    //   后者只是间接验证 checkReadiness 对已关闭连接的行为，不是同一件事）。
    if (_testHooks.ddlFailureLabel === 'RECONCILE_POSTCOMMIT_FAIL') {
      return { ok: false, error: '提交后失败(测试哨兵): 结构已提交、本次初始化不发布' };
    }
    // 提交后失败①：结构已提交、本次初始化不发布（不是"结构不变"）。
    if (db.__faulted) {
      return { ok: false, error: '连接层错误: 初始化期间发生(对账结构事务提交后核验，结构已提交、本次初始化不发布)' };
    }
    if (Date.now() > deadlineTs) {
      return { ok: false, error: '初始化整体超时(预算已耗尽，对账结构事务已提交、本次初始化不发布)' };
    }
    // S3：readiness 查询前同样按剩余预算动态设置 busy_timeout（readiness 也是"SQL"，不豁免）；
    //   PRAGMA 本身失败也走统一的失败返回，不让异常裸抛到 runLifecycleInit（那里没有包 try/catch，
    //   会变成未处理的 rejection）。提交后失败②：结构已提交、本次初始化不发布。
    try {
      await new Promise((resolve, reject) => {
        const remainingForReadiness = Math.max(1, deadlineTs - Date.now());
        db.run(`PRAGMA busy_timeout = ${Math.min(5000, remainingForReadiness)}`, (err) => (err ? reject(err) : resolve()));
      });
    } catch (pragmaErr) {
      return { ok: false, error: `busy_timeout设置失败(readiness前，结构已提交、本次初始化不发布): ${pragmaErr.message}` };
    }
    // 提交后失败③：readiness 本身失败（比如 C1 那 7 表/6 索引出问题）——结构已提交、不发布。
    const readiness = await checkReadiness(db);
    if (!readiness.ok) {
      return { ok: false, error: readiness.error };
    }
    // M1：readiness 查询后再查一次——DDL 全过、readiness 也过，但查询期间这条连接可能才报错。
    // 提交后失败④：结构已提交、本次初始化不发布。
    if (db.__faulted) {
      return { ok: false, error: '连接层错误: 初始化期间发生(结构已提交、本次初始化不发布)' };
    }
    if (Date.now() > deadlineTs) {
      return { ok: false, error: '初始化整体超时(预算已耗尽，结构已提交、本次初始化不发布)' };
    }
    return { ok: true };
  }

  // 生命周期初始化的唯一核心实现——initSchema（启动一次性）与 rebuildUnderLock（锁内重建）都
  //   通过它，两者的差异只在 fastMode。返回 { ok:true } 或 { ok:false, kind:'open'|'ddl', error }。
  // S6（本轮 codex 17-R2 + Opus 复看必修，可观测信号）：关闭+计数的统一出口——生命周期各失败
  //   分支都经它关连接，保证 closedAttempts 计数不会漏记。
  // S3（17-R3S 必修）：close 回调的错误必须被观察，不能吞掉——返回结构化 {ok, err, connId}。
  //   本函数自己也记一条日志（含 __id），调用方无论是否检查返回值都不会丢失这条诊断信息；
  //   需要据此改变发布/收尾行为的调用方（closeItDb/rebuildUnderLock）另行处理返回值。
  async function closeAndCount(db) {
    _testHooks.lifecycleCounters.closedAttempts += 1;
    const connId = db && db.__id;
    if (_testHooks.closeFailureInjection) {
      const err = new Error('测试注入失败: close()');
      logger.error(`[it-ledger] 连接关闭失败(注入,__id=${connId}): ${err.message}`);
      // 17-R6S M：可选延迟——供 verify 制造"discardUnpublished 仍在途"的真实窗口（比如在这个
      // 窗口内并发调用 shutdown()，验证 shutdown() 不会抢在 discardUnpublished 落定之前就
      // 完成收尾）。默认 0（不延迟），不影响既有用例的同步期望。
      const delayMs = Number(_testHooks.closeFailureDelayMs) || 0;
      if (delayMs > 0) {
        return new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, err, connId }), delayMs);
        });
      }
      return { ok: false, err, connId };
    }
    // 17-R6S M 复审实锤（openItDb 改"discardUnpublished 完成后才 reject"暴露）：底层
    //   sqlite3.Database 在 open 本身失败（比如目录不存在、SQLITE_CANTOPEN）之后，对同一个 db
    //   对象调 close() 的回调**永远不会触发**（已用真实复现脚本确认：等 5s 无回调）。以前
    //   discardUnpublished 是 fire-and-forget，这个"永不回调"不影响 reject 时序；现在 openItDb
    //   的三处失败分支都要等 discardUnpublished 落定才 reject——如果不给 db.close() 加超时兜底，
    //   一条打开失败的连接会让整条 initSchema()/rebuildUnderLock() 永久挂起（真死锁，不是测试
    //   假象）。这里给 close() 包一个 5s 超时：超时按失败处理（ok:false），仍记日志+计入孤儿，
    //   语义等价于"关闭这个动作本身失败"，不虚报成功。
    let timedOut = false;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        logger.error(`[it-ledger] 连接关闭超时(__id=${connId}，5s 内未收到 close() 回调，很可能是 open 本身就失败的连接)`);
        resolve({ ok: false, err: new Error('连接关闭超时(5s内未收到close()回调)'), connId });
      }, 5000);
      db.close((err) => {
        if (timedOut) return; // 超时已经 resolve 过一次，迟到的回调不再二次 resolve
        clearTimeout(timer);
        if (err) {
          // S4（17-R5S 必修）：驱动明确报"这条连接已经关闭过了"（比如测试/调用方自己先手动
          // close() 过一次）——这不是"关闭这个动作本身失败"，是"关闭动作发现自己没必要做"，
          // 结果等价于关闭成功（视为 ok:true，不置 recoveryForbidden 那种终态）；用
          // alreadyClosed 标出这条特殊路径，调用方需要区分时可以看这个字段。其余关闭错误
          // （磁盘/句柄类真实故障）维持原判：ok:false，交给调用方决定要不要终态化。
          if (/Database is closed/i.test(err.message || '')) {
            logger.warn(`[it-ledger] 连接关闭时发现已经关闭过(__id=${connId})，按关闭完成处理: ${err.message}`);
            resolve({ ok: true, err: null, connId, alreadyClosed: true });
            return;
          }
          logger.error(`[it-ledger] 连接关闭失败(__id=${connId}): ${err.message}`);
          resolve({ ok: false, err, connId });
        } else {
          resolve({ ok: true, err: null, connId });
        }
      });
    });
  }

  // C1 串行化重构（codex 17/17-R/17-R2 三轮 HIGH 全落在"初始化/重建/停机可并发"这一族后，主
  //   会话按止损判据裁定改为恒串行模型）：本函数不再需要 lifecycleGen 代次仲裁——启动初始化只
  //   跑一次（initSchema 一次性闸），重建恒在 itTxnMutex 内串行（rebuildUnderLock 契约），因此
  //   不存在"这次初始化被更晚一次抢先"的场景，删除原检查①②与 superseded 分支。唯一保留的
  //   同步复核是发布前对 draining/__faulted/deadline 的检查（见下）——这不是并发仲裁，是"这次
  //   初始化本身是否还值得发布"的收尾判断（比如启动初始化跑到一半 shutdown() 被调用）。
  async function runLifecycleInit(opts) {
    const fastMode = !!(opts && opts.fastMode);
    // C2（巡检照片目录对账，33-R2 M1）：isStartup 只由 initSchema() 的调用点传 true——本函数还被
    //   rebuildUnderLock（运行期锁内重建）共用，那条路径不传，天然不会触发对账（见下方对账插入点
    //   注释）。
    const isStartup = !!(opts && opts.isStartup);
    const totalBudgetMs = fastMode ? 3000 : 30000; // M2：普通 30s / fastMode 3s（软预算，见 §1.5）
    const budgetMs = _testHooks.ddlDeadlineMsOverride || totalBudgetMs;
    const deadlineTs = Date.now() + budgetMs;

    let db;
    try {
      db = await openAndPrepare(deadlineTs); // B9/M1/M2：open + 打身份标签 + 挂故障旗标 + PRAGMA
    } catch (openErr) {
      return { ok: false, kind: 'open', error: openErr };
    }

    const ddlResult = await runDdlAndReadiness(db, { fastMode, deadlineTs });

    if (!ddlResult.ok) {
      await discardUnpublished(db, `DDL失败: ${ddlResult.error}`);
      return { ok: false, kind: 'ddl', error: new Error(ddlResult.error) };
    }
    // M1：DDL/readiness 全部成功，但不得被这个"成功"掩盖掉中途可能发生的连接层错误——发布前
    //   最后一次故障旗标核验（下方发布前同步检查会再核一次，这里先快速失败，少走一次 PRAGMA）。
    if (db.__faulted) {
      await discardUnpublished(db, '连接层错误: 初始化期间发生(DDL后核验)');
      return { ok: false, kind: 'ddl', error: new Error('连接层错误: 初始化期间发生') };
    }

    // 恢复正常 busy_timeout（准备阶段收尾，§1.5）——发布前最后一步会做的动作全部收在这个
    //   PRAGMA 之前完成，紧接着就是§1.1要求的"零 await"同步检查。
    try {
      await new Promise((resolve, reject) => {
        db.run('PRAGMA busy_timeout = 5000', (err) => (err ? reject(err) : resolve()));
      });
    } catch (restoreErr) {
      await discardUnpublished(db, `PRAGMA busy_timeout恢复失败: ${restoreErr.message}`);
      return { ok: false, kind: 'ddl', error: restoreErr };
    }

    // C2（巡检照片目录对账，方案 §2.6、33-R2 M1）：只在进程首次初始化、标记就绪之前执行一次，且
    //   必须在下面的"§1.1 发布前同步检查"这段零 await 窗口**之前**完成——对账本身有多次 await
    //   （readdir/stat/两次 SELECT/unlink），绝不能夹在检查与发布之间，否则会破坏"检查与发布之间
    //   零 await"这条不变量（该不变量保证 draining/__faulted 判定与发布是原子的，见上方注释）。
    //   isStartup 只由 initSchema() 传 true，rebuildUnderLock 的运行期重建调用不传，天然只在"进程
    //   首次初始化"这条路径上触发；sheetPhotoDirReconciled 是防御性第二道闸（见其声明处注释）。
    //   此刻请求层的 requireLedgerReady 因 state.ready 还是 false 而拒绝一切请求，不存在与本次
    //   对账并发的正常写入，用未发布的 db 连接直接查两张表是安全的。
    if (isStartup && !sheetPhotoDirReconciled) {
      sheetPhotoDirReconciled = true;
      // C2f（M8 闸的收口，spec-C2f.md 第1条）：C2c M8 原裁定只挡"会改写行为"的测试 seam；本行
      // 与下面 inspectionSheetReconcileResultProbe 是纯观察探针（不改写任何生产行为），当初没收
      // 进闸内。这次一并收进——不是因为它们会造成生产风险（不会），而是统一"所有 inspectionSheet*
      // 测试专用 deps 字段只在 TEST_HOOKS_ENABLED 时才可能生效"这一条单一心智模型，避免以后有人
      // 类比着新增一个真正改写行为的探针时，误以为"探针类不用管这道闸"。TEST_HOOKS_ENABLED 声明
      // 在 index.js:41，本函数与其在同一个 module.exports 闭包内，直接可见。
      if (TEST_HOOKS_ENABLED && typeof deps.inspectionSheetReconcileProbe === 'function') {
        // 在对账真正开始之前把此刻的 state.ready 报给探针，供测试断言"对账发生在就绪之前"（此刻
        // state.ready 恒为 false——本函数所在的 runLifecycleInit 还没跑到下面的发布语句）。探针本身
        // 出错不能影响初始化，包一层 try/catch 吞掉。
        try { deps.inspectionSheetReconcileProbe({ readyAtCallTime: state.ready }); } catch (_probeErr) { /* 测试探针出错不影响生产初始化 */ }
      }
      try {
        // C2c M2：把本次初始化的同一个软预算 deadlineTs 传给对账——对账耗时计入启动预算，剩余
        // 不足5秒会自己停止并 warn，不会为了扫完目录拖垮发布。
        // C2e-3/C2f：仅测试可用的时钟注入——只在 TEST_HOOKS_ENABLED 时才从 deps.inspectionSheetReconcileNow
        // 取，闸未开时恒传 undefined（reconcilePhotoDirectoryOnce 内部落回真实 Date.now），生产装配从不传。
        const reconcileResult = await inspectionPhotoFiles.reconcilePhotoDirectoryOnce({ db, storageDir: inspectionSheetStorageDir, logger, deadlineTs, now: TEST_HOOKS_ENABLED ? deps.inspectionSheetReconcileNow : undefined });
        // 仅测试可用的结果探针——同上收进闸内；让测试能拿到 {deleted,checked,stoppedEarly} 而不必
        // 自己重新解析 warn 文案。
        if (TEST_HOOKS_ENABLED && typeof deps.inspectionSheetReconcileResultProbe === 'function') {
          try { deps.inspectionSheetReconcileResultProbe(reconcileResult); } catch (_probeErr) { /* 测试探针出错不影响生产初始化 */ }
        }
      } catch (reconcileErr) {
        // 对账失败只记 warn，绝不能让初始化失败——reconcilePhotoDirectoryOnce 内部已经自己
        // try/catch 过一层，这里是双保险（防御性兜底，不代表内部实现不可信）。
        logger.warn(`[it-ledger] 巡检照片目录对账失败(不影响初始化): ${reconcileErr && reconcileErr.message}`);
      }
    }

    // §1.1 发布前同步检查（零 await 窗口）：draining / 连接故障 / 预算耗尽，任一命中都不发布。
    //   典型触发场景：启动初始化跑到这里时 shutdown() 已经被调用（H5②/L2 场景）。
    if (state.draining || db.__faulted || Date.now() > deadlineTs) {
      const reason = state.draining ? '初始化被停机中止' : (db.__faulted ? '连接层错误: 初始化期间发生' : '初始化整体超时(预算已耗尽)');
      await discardUnpublished(db, `发布前检查未通过: ${reason}`);
      logger.warn(`[it-ledger] 初始化未发布(conn#${db.__id}): ${reason}`);
      return { ok: false, kind: 'ddl', error: new Error(reason) };
    }

    // 发布——上面的同步检查与本行之间零 await，JS 单线程语义保证这中间不会被任何其他代码插队
    //   改动 draining。
    const prev = itDb;
    itDb = db;
    state.ready = true;
    state.error = null;
    _testHooks.lifecycleCounters.published += 1;
    logger.info(`[it-ledger] ✅ 7 表 + 关键索引就绪，it-ledger 接口放行。(conn#${db.__id})`);
    if (prev && prev !== db) {
      // B1（Opus 复看必修）：锁内保证 + 纵深防御——本函数现在恒被 withLifecycleLock/itTxnMutex
      // 持锁调用（initSchema 启动初始化也已包进 withLifecycleLock），正常路径下 prev 此刻恒为
      // null（rebuildUnderLock 的契约是"先关旧连接、再开新连接"）。这里不是"这不可能发生"，是
      // 不信任调用方永远守约：万一未来某次重构在这条路径插入新分支、不慎在关闭旧连接之前就跑
      // 到这里，这行代码防止旧连接被静默丢弃成孤儿句柄（不关闭 = 句柄泄露 + 可能仍在被引用）。
      await closeAndCount(prev);
    }
    // C2（方案 §2.6 规则三）：清理队列"模块就绪后执行一次"——这里已经在发布之后（itDb/state.ready
    //   都已就位），不再受零 await 窗口约束；只在 isStartup 触发一次，不阻塞 initSchema() 的返回
    //   （fire-and-forget + 兜底 catch，队列处理本身是 best-effort，失败只留给下一次写请求或下一次
    //   进程重启的目录对账兜底）。
    if (isStartup) {
      inspectionSheets.processCleanupQueue(20).catch((queueErr) => {
        logger.warn(`[it-ledger] 巡检照片清理队列首次处理失败(不影响初始化): ${queueErr && queueErr.message}`);
      });
    }
    return { ok: true };
  }

  // 1.1（C1 串行化重构）：initSchema 只允许在启动时被真正执行一次——此后任何调用（无论
  //   ready/draining 与否）一律忽略。旧版"已就绪 no-op"与"并发共用 initPromise"两种分支随
  //   lifecycleGen 代次仲裁一起删除，只剩"第一次"与"其余"。initPromise 仍保留（供 shutdown()
  //   在启动初始化仍在途时等它落地），但不再有"并发调用复用同一个 Promise"这层含义——第二次
  //   调用直接同步 return，根本不会碰 initPromise。
  // B1（Opus 复看必修）：初始化体本身也包进 withLifecycleLock——启动时刻不会有人竞争这把锁
  // （请求在 readinessError 处就被拒，不会排队；shutdown() 会先 await initPromise 再去
  // acquire；reinitForTest 天然排在它后面），包这一层换来的是"发布连接"这个动作从此**统一**
  // 只发生在持锁状态下（不区分启动初始化还是锁内重建），上面 runLifecycleInit 发布段的 prev
  // 纵深防御分支据此才有意义——不是为了在启动阶段解决某个真实存在的并发问题。
  function initSchema() {
    if (startupStarted) {
      logger.warn('[it-ledger] initSchema 只允许启动时调用一次，本次忽略');
      return Promise.resolve();
    }
    startupStarted = true;
    initPromise = withLifecycleLock(async () => {
      try {
        await closeItDb(); // 防御性 no-op：startupStarted 一次性闸下 itDb 此刻恒为 null
        // C2：isStartup:true 只在这一个调用点传——这是"进程首次初始化"路径（startupStarted 一次性
        //   闸保证 initSchema() 本身只跑一次）；下方 751 行 rebuildUnderLock 的调用点不传，运行期
        //   重建因此天然不触发巡检照片目录对账（方案 §2.6：只在首次初始化跑一次）。
        const result = await runLifecycleInit({ fastMode: false, isStartup: true });
        if (!result.ok) {
          if (result.kind === 'open') {
            state.ready = false;
            logger.error(`[it-ledger] 🚫 打开连接失败: ${result.error.message} → it-ledger 接口将返 503 LEDGER_NOT_READY`);
          } else if (result.kind === 'ddl') {
            state.ready = false;
            state.error = result.error.message;
            logger.error(`[it-ledger] 🚫 ${state.error} → it-ledger 接口将返 503 LEDGER_UNAVAILABLE`);
          }
        }
      } catch (unexpectedErr) {
        state.ready = false;
        state.error = `初始化异常: ${unexpectedErr.message}`;
        logger.error(`[it-ledger] 🚫 ${state.error} → it-ledger 接口将返 503 LEDGER_UNAVAILABLE`);
        await closeItDb();
      }
    }).finally(() => { initPromise = null; });
    return initPromise;
  }

  // 停机排空（§2.1："只导出，不在 server.js 注册 process 级信号处理"——是否挂 SIGTERM/SIGINT 由
  //   主会话裁定；本文件 grep 结果见回报第4项）。
  // 1.3（C1 串行化重构）：置 draining → 若启动初始化仍在途，等它先落地（成功/失败都算落地，用
  //   .catch(()=>{}) 吞掉）→ 真实 acquire 这把 itTxnMutex（替代旧版 while(isLocked()) 轮询）——
  //   draining 已经挡住新请求，在途请求排空后队列必然让出锁，shutdown 与任何在途事务/锁内重建
  //   天然串行，不再需要 ++lifecycleGen 兜底。
  // S1（17-R3S HIGH 必修，S7 订正过期表述）：不设超时地等这把锁——acquire(0) 不设超时，
  //   draining 已经挡住新请求，在途请求排空后队列必然让出锁，这条路径上没有"永远等不到"的
  //   正常场景。任何路径不得无锁调用 closeItDb：本函数在拿到锁之后才碰 itDb，不存在无锁分支。
  //   极端情况下（比如某笔业务回调本身死循环）本函数会跟着无限期挂起——这是比"假装收尾但连接
  //   仍在跑"更严重的独立故障，交给进程级 kill/重启兜底，不在这里掩盖。
  async function shutdown() {
    state.draining = true;
    if (initPromise) {
      await initPromise.catch(() => {});
    }
    const release = await itTxnMutex.acquire(0); // 0 = 不设超时
    // B2：关闭连接前先置 state.ready=false——避免"ready 显示 true 但 itDb 其实已被关闭"的
    //   短暂错误画面；readiness 判据（B5 的 readinessError）本就以 state.ready 为准。
    try {
      state.ready = false;
      await closeItDb();
      // S4（17-R4S 必修）：锁内逐个再尝试关闭此前遗留的孤儿连接（未发布连接在 openAndPrepare
      // 阶段关闭失败时记进 orphanConns）——best-effort，不影响 shutdown 本身的收尾；成功/失败
      // 都记日志，不吞掉。
      while (orphanConns.length > 0) {
        const entry = orphanConns.shift();
        try {
          // 17-R7S H1（主会话直修）：必须走带 5s 超时的 closeAndCount，不得裸调 entry.db.close()——
          //   打开失败后的 close() 回调可能永不触发，裸等会让 shutdown 永久持锁挂起。
          //   closeAndCount 返回结构化结果、不 throw；本次收尾失败不重新入队。
          const retryResult = entry.db ? await closeAndCount(entry.db) : { ok: true };
          if (retryResult.ok) {
            logger.info(`[it-ledger] 孤儿连接(__id=${entry.connId})收尾关闭成功${retryResult.alreadyClosed ? '(已关闭)' : ''}`);
          } else {
            logger.error(`[it-ledger] 孤儿连接(__id=${entry.connId})收尾关闭仍失败: ${retryResult.err && retryResult.err.message ? retryResult.err.message : retryResult.err}`);
          }
        } catch (retryErr) {
          logger.error(`[it-ledger] 孤儿连接(__id=${entry.connId})收尾关闭异常: ${retryErr && retryErr.message}`);
        } finally {
          _testHooks.lifecycleCounters.orphanRetryProcessed += 1; // 17-R6S M：无论成败，处理过一条就计一次
        }
      }
    } finally {
      release();
    }
  }

  // ============================================================
  // 三、就绪门中间件 + 读写守卫（§2.2 / §2.3）
  // ============================================================
  function requireLedgerReady(req, res, next) {
    if (state.draining) {
      return res.status(503).json({ code: 'LEDGER_DRAINING', message: '模块正在停机，请稍后重试' });
    }
    // S1（17-R4S HIGH 根治）：不再有"faulted 就放行"的自愈候选分支——faulted 连接的 error
    //   监听器（S2）已经同步把 state.ready 置 false，本中间件回到纯 readinessError() 判定，
    //   与 withRead/withWrite 的锁前/锁后判据完全同源，三处不再各自维护任何自愈相关的旁路。
    // B5：与 withRead/withWrite 的锁前/锁后判据共用同一个 readinessError()。
    const re = readinessError();
    if (re) {
      const body = { code: re.code, message: readinessErrorMessage(re.code) };
      // L1：state.error 可能含内部实现细节（表名/SQL片段/文件路径等），只在开发环境回给客户端，
      // 生产环境只回通用文案，详细原因走 logger（本模块各处失败分支已有 logger.error）。
      if (re.code === 'LEDGER_UNAVAILABLE' && process.env.NODE_ENV === 'development') body.detail = state.error;
      return res.status(re.status).json(body);
    }
    next();
  }

  // 必须排在 requireLedgerReady 之后（route 挂载顺序）：本中间件内部调用 withRead 查 ACL，
  // 若模块未就绪会走 M5 的第二道防线拿到 LEDGER_NOT_READY，但语义上"是否就绪"应由
  // requireLedgerReady 先判且给出更明确的 503 文案，不应该让 ACL 授权中间件替就绪闸背锅。
  // requireLedgerRead：admin 或 ACL 任一级别放行，否则 403（中间件只做粗筛，§2.3）。
  async function requireLedgerRead(req, res, next) {
    try {
      if (req.user.role === 'admin') return next();
      const row = await withRead((q) => q.get('SELECT level FROM it_asset_acl WHERE user_id = ?', [req.user.id]));
      if (!row) return res.status(403).json({ code: 'LEDGER_FORBIDDEN', message: '权限不足' });
      req.itLedgerAclLevel = row.level;
      next();
    } catch (err) {
      return handleErr(res, err);
    }
  }

  // 必须排在 requireLedgerReady 之后（route 挂载顺序）：理由同 requireLedgerRead 上方注释。
  // requireLedgerWrite：admin 或 write 放行。
  // G2A2：仅测试模式把 next() 包进"writeRequest:true"的 ALS 上下文（admin 分支与普通分支都要
  //   包；中间件自己这一次 ACL 判定用的 withRead 在 run() 之外，不计入——它是路由挂载序里排在
  //   requireLedgerWrite 之前的 requireLedgerRead 同款判定，不在本探针要盯的"写路由请求期间"窗口
  //   内；G2A2b M4 订正：探针谓词已放宽为"写请求内事务外的任何SQL"，不再限定表名，这里"不计入"
  //   单纯是因为这段 ACL 判定发生在写请求上下文建立之前，与是否限定表名无关）。生产路径直接调用
  //   next()，不调用 ALS 的 run/exit/getStore（L1 订正措辞，理由同 withWrite 处）。
  function runNextInWriteContext(req, next) {
    if (!TEST_HOOKS_ENABLED) return next();
    return ledgerRequestContext.run({ writeRequest: true, method: req.method, path: req.originalUrl }, next);
  }

  // G2A2 Commit2（主会话裁定，G3A 收窄）：清理队列维护动作（processCleanupQueueBestEffort）不
  //   属于写请求业务读，但不能靠收紧谓词/按名字排除/加例外绕过探针——让这段维护动作显式退出当前
  //   请求的 ALS 上下文。仅测试模式调用 ledgerRequestContext.exit(fn)：fn 执行期间（含其内部所有
  //   await 链）getStore() 返回 undefined，probeSql 据此不再把 fn 内的 SQL 记成"写请求上下文里
  //   的"。生产路径直接同步调用，不引入 setImmediate、不改时序，不调用 ALS 的 run/exit/getStore
  //   （L1 订正措辞，理由同 withWrite 处）。
  // G3A（41T H2 必修）：旧版 detachFromRequest(fn) 接受任意回调——一旦路由处理器（哪怕靠
  //   Reflect.get(arguments[0], 'detachFromRequest') 反射取值，不需要在源码里出现这个标识符）
  //   拿到它，就能把自己的任意读包进去，借 exit() 让探针把这次读误判成"不在写请求上下文里"，
  //   静态守卫 R8（只扫标识符文本）与运行时探针都会被绕过。改为 runCleanupDetached(limit)：只
  //   接受一个数字型 limit，内部固定触发清理队列维护本身（inspectionSheetsCleanupQueueRef，见
  //   下方"以及"字段——只在 inspectionSheets 工厂构造完成后由本文件赋值一次，不进入任何工厂的
  //   deps 参数对象，也就不在 Reflect.get(arguments[0], ...) 能触达的范围内）；不管调用方传什么
  //   参数（哪怕故意传一个函数期望被当回调调用），internally 只会把这个参数原样交给固定的
  //   cleanupFn(limit)，从不把参数当函数调用——路由文件即使借反射拿到 runCleanupDetached 本身，
  //   也只能触发这一个固定动作，包不住自己的任何代码。作为依赖注入给 inspection-sheets.js
  //   （inspectionSheets 工厂调用处），不在本文件内部消费。
  let inspectionSheetsCleanupQueueRef = null;
  // G3A-b（L1）：两处收紧都是"暴露真实故障，不再静默吞掉"——
  //   ① inspectionSheetsCleanupQueueRef 为 null 只可能发生在模块构造过程中（inspectionSheets
  //      工厂尚未返回、本文件还没来得及赋值那一行），任何路由处理器能调用到这里时模块早已构造
  //      完成，这个分支理论上不会在生产请求路径触发；静默 resolve 会把"引用没接上"这种配置错误
  //      伪装成"清理动作正常跑完但没有行要处理"，改为直接 throw。
  //   ② limit 只接受 undefined（让 processCleanupQueue 走它自己的默认值 20）或安全正整数——不接受
  //      任何非数字/非整数值（含函数、对象、字符串），也不接受 0/负数/超出 Number.MAX_SAFE_INTEGER
  //      的值（G3A-c 41RS L1 订正：旧版用 Number.isInteger，仍会放行负数与超出安全整数范围的值，
  //      与"只接受安全整数"这句注释承诺不符），从根上堵死"传函数指望被当回调调用"这条路，不依赖
  //      processCleanupQueue 内部 SQL 参数绑定失败这种偶然的副作用来"顺便"证明安全。
  //   processCleanupQueueBestEffort 的 try/catch（inspection-sheets.js）仍然把这两种新抛出的
  //   错误当 best-effort 失败吞掉（"下次写请求或下次就绪对账再清"），不影响触发它的那次写请求；
  //   R9（processCleanupQueueBestEffort 只能以不 await 的独立语句出现）不受影响，判定逻辑与
  //   本函数内部实现无关。
  // G3A-c（41RT M4 必修，测试观测用完成计数）：cleanupStarted/cleanupSettled 只在
  //   TEST_HOOKS_ENABLED 分支里计数（生产分支 return cleanupFn(limit) 不经过这两行，零开销、零
  //   行为差异）——供 verify 判定"清理动作是否真的跑完了"，而不是靠"探针记录数连续几轮不再
  //   增长"这种间接、可能被更晚到达的异步任务打破的猜测。
  function runCleanupDetached(limit) {
    const cleanupFn = inspectionSheetsCleanupQueueRef;
    if (typeof cleanupFn !== 'function') throw new Error('[it-ledger] runCleanupDetached: inspectionSheetsCleanupQueueRef 未就绪');
    if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0)) throw new Error('[it-ledger] runCleanupDetached: limit 必须是 undefined 或安全正整数');
    if (!TEST_HOOKS_ENABLED) return cleanupFn(limit);
    _testHooks.cleanupStarted += 1;
    const settleOnce = () => { _testHooks.cleanupSettled += 1; };
    return ledgerRequestContext.exit(() => cleanupFn(limit)).then(
      (v) => { settleOnce(); return v; },
      (e) => { settleOnce(); throw e; },
    );
  }

  async function requireLedgerWrite(req, res, next) {
    try {
      if (req.user.role === 'admin') return runNextInWriteContext(req, next);
      const row = await withRead((q) => q.get('SELECT level FROM it_asset_acl WHERE user_id = ?', [req.user.id]));
      if (!row || row.level !== 'write') return res.status(403).json({ code: 'LEDGER_FORBIDDEN', message: '权限不足' });
      req.itLedgerAclLevel = row.level;
      runNextInWriteContext(req, next);
    } catch (err) {
      return handleErr(res, err);
    }
  }

  // L3（不改逻辑，记账）：authenticateToken/requireAdmin 是外部注入的平台中间件（server.js 既有
  //   实现），它们的 401/403 沿用平台既有 `{error: '...'}` 响应形态，与本模块自己产出的
  //   `{code, message}` 形态不统一——这是有意的：本模块只对自己代码路径的错误负责改造响应形状，
  //   不重写平台鉴权中间件的既有行为契约（改了会波及全平台所有使用这两个中间件的路由）。
  function handleErr(res, err) {
    if(String(err?.message).includes('ASSET_RECORD_INACTIVE'))return res.status(409).json({code:'ASSET_RECORD_INACTIVE',message:'记录已作废或删除，不能继续操作或作为宿主'});
    if (err && err.status && err.code) {
      if (err.status >= 500) logger.error(`[it-ledger] ${err.code}: ${err.message}`);
      // C2 回补：可选透传 field（400 时定位具体字段）与 detail（如 ROOM_IN_USE 的 rooms/assets
      //   列表）——两者都是可选附加信息，未设置时行为与改动前完全一致（不影响 C1 已有错误响应
      //   形状）。S-M5（Opus 预筛）：detail 曾用 Object.assign 平铺进 body，会覆盖同名的
      //   code/message 顶层键（如 detail 里意外出现 code 字段）；改为收进 body.detail 嵌套对象，
      //   field 仍留在顶层（它是"定位单个字段"的通用信息，语义上与 detail 的"结构化补充数据"
      //   不同）。
      const body = { code: err.code, message: err.message };
      if (err.field !== undefined) body.field = err.field;
      if (err.detail && typeof err.detail === 'object') body.detail = err.detail;
      return res.status(err.status).json(body);
    }
    logger.error(`[it-ledger] 未分类错误: ${(err && err.stack) || err}`);
    return res.status(500).json({ code: 'LEDGER_INTERNAL', message: '内部错误' });
  }

  // ============================================================
  // 四、财务字段助手（方案 §10，C1 硬契约 §2.4）
  // ============================================================
  const FINANCE_FIELDS = new Set(['fin_amount', 'fin_vendor', 'fin_contract_no', 'external_amount']);

  // M7（主会话 2026-09-18 裁定）：改为递归，与 stripFinance 对称——原版只查顶层键，嵌套对象/
  //   数组内的财务字段（如 { attrs: { fin_amount: 1 } }）会被漏判。Buffer/Date 早返回、WeakSet
  //   防环，理由同 stripFinance 下方注释。
  // B8（主会话 2026-09-18 裁定）：递归游标（这里是 WeakSet）改成内部 _impl 函数的必传参数，
  //   外部只暴露两参包装 —— 调用方（含 _internals，供 verify 与未来 C2+ 消费）永远不必关心
  //   "第三个参数是什么"这个实现细节，也不会有人不小心从外部传入一个游标半途接力（那样会破坏
  //   "每次顶层调用都是一次全新遍历"这个不变量）。
  function rejectFinanceFieldsImpl(body, isAdmin, seen) {
    if (isAdmin) return;
    if (!body || typeof body !== 'object') return;
    if (Buffer.isBuffer(body) || body instanceof Date) return;
    if (seen.has(body)) return; // 已访问过，防环
    seen.add(body);
    if (Array.isArray(body)) {
      for (const item of body) rejectFinanceFieldsImpl(item, isAdmin, seen);
      return;
    }
    for (const [key, v] of Object.entries(body)) {
      if (FINANCE_FIELDS.has(key)) {
        const e = new Error(`非管理员不得提交财务字段: ${key}`);
        e.status = 400; e.code = 'FINANCE_FIELD_FORBIDDEN';
        throw e;
      }
      if (v && typeof v === 'object') rejectFinanceFieldsImpl(v, isAdmin, seen);
    }
  }
  function rejectFinanceFields(body, isAdmin) {
    return rejectFinanceFieldsImpl(body, isAdmin, new WeakSet());
  }

  // M6（主会话 2026-09-18 裁定）：
  //   ① Buffer.isBuffer(value) / value instanceof Date 早返回——这两类"看起来是对象"但不该被当成
  //      普通 JSON 对象递归拆解（会把 Buffer 当数组、Date 拆成一堆内部字段，语义都是错的）。C1 目前
  //      不产出这两类值（资产字段全走 JSON.parse/字符串列），此处是防御性收紧，为未来消费方兜底。
  // H1（主会话 2026-09-18 修正——推翻上一版 WeakSet 方案的一个真实缺陷）：WeakSet 只记"访问过
  //   没有"，分不清"这是真环（同一节点在自己的祖先链上再次出现）"还是"同一个对象被两个不同的
  //   属性/数组元素共享引用（不是环，只是同一份数据被引用了两次）"——旧实现对后者也会命中
  //   seen.has()==true 提前返回**原始未脱敏对象**，导致共享引用场景下财务字段直接泄露（复现：
  //   `const x={fin_amount:100}; stripFinance({a:x,b:x},false)` 时 b 拿到的是原始 x，不是脱敏
  //   副本）。改用 WeakMap<原对象, 脱敏副本>：递归前先造一个空容器（对象或数组）登记进 map，
  //   再回填内容——同一个原对象不论被引用几次，返回的都是同一份已脱敏（或正在脱敏中）的副本，
  //   不会把原始引用漏出去；对真环（如 `x.self = x`），第二次访问 x 时 map 已有它对应的容器
  //   （此时容器可能还没填完，但对象引用已经存在，赋值 `out.self = 那个容器`后续会自动补全），
  //   不会无限递归。
  // B7（主会话 2026-09-18 裁定，补注释）：本函数返回值**保持输入的引用共享结构**——输入里两处
  //   引用同一个对象，输出里对应两处也引用同一个（已脱敏的）副本对象，不是各自独立深拷贝；
  //   消费方**不得原地修改**返回值（改一处会影响所有共享该引用的地方，和输入端的共享语义一致，
  //   不是本函数的 bug）。环输入的环输出仍是环（`x.self=x` 脱敏后 `out.self===out`），不会被
  //   拍平成非环结构。
  // B8：同 rejectFinanceFields——递归游标（WeakMap）收进内部 _impl，外部只暴露两参包装。
  function stripFinanceImpl(value, isAdmin, map) {
    if (isAdmin) return value;
    if (Buffer.isBuffer(value) || value instanceof Date) return value;
    if (Array.isArray(value)) {
      if (map.has(value)) return map.get(value);
      const out = [];
      map.set(value, out);
      for (const v of value) out.push(stripFinanceImpl(v, isAdmin, map));
      return out;
    }
    if (value && typeof value === 'object') {
      if (map.has(value)) return map.get(value);
      const out = {};
      map.set(value, out);
      for (const [k, v] of Object.entries(value)) {
        if (FINANCE_FIELDS.has(k)) continue;
        out[k] = stripFinanceImpl(v, isAdmin, map);
      }
      return out;
    }
    return value;
  }
  function stripFinance(value, isAdmin) {
    return stripFinanceImpl(value, isAdmin, new WeakMap());
  }

  // ============================================================
  // 五、事件写入助手（方案 §2.3，含 floor_update 契约收口）
  // ============================================================
  // ACTIONS = §4 全部 19 个动作码 + update/register/acl_grant/acl_revoke/floor_update（方案 §2.3 逐字）。
  //   定义已提前到"二、DDL"一节（H1 必修：it_asset_events.action 的 CHECK 约束需要同源枚举），
  //   此处不重复声明，只留 PAYLOAD_KEYS 等下游消费。
  //
  // PAYLOAD_KEYS：action × role → 允许键集合。C1 只落 register/update/acl_grant/acl_revoke/
  //   floor_update 五个非动作族事件类型的键集合；§4 的 19 个动作码方案未给出逐动作字段表（只有
  //   §2.3 的通用性描述），按 spec §2.5"方案没写明的动作留空集合，回报里逐条列出"处理——
  //   留空集合意味着 C2–C6 实现对应动作前，writeEvent 对它们的任何非空 from/to 都会因超集被拒绝，
  //   这是有意的 fail-closed（防止在契约冻结前意外写出未经校验的事件载荷）。
  const PAYLOAD_KEYS = {
    // L4（R1 已落地）：register.primary 补 P10 三键（owner_name/owner_dept/asset_class）——
    //   它们随 R1 通过 ALTER TABLE 加到 it_assets（方案 §6），register 的 to_state = 初态全部
    //   位置列 + P10 三字段初值（方案 §2.3 第165行）。
    register: {
      primary: new Set([
        'status', 'rack_id', 'u_start', 'location_text', 'floor_id', 'room_id', 'pos',
        'parent_asset_id', 'slot_no', 'custodian_user_id', 'custodian_name', 'expires_at',
        'owner_name', 'owner_dept', 'asset_class',
      ]),
      affected: new Set(['slot_no', 'disk_id']),
    },
    update: {
      primary: new Set([
        'name', 'brand', 'model', 'sn', 'asset_no', 'purchased_at', 'note', 'attrs',
        'expires_at', 'slot_count', 'u_height', 'fin_changed',
        'owner_name', 'owner_dept', 'asset_class',
      ]),
      affected: new Set(),
    },
    acl_grant: {
      primary: new Set(['user_id', 'level']),
      affected: new Set(),
    },
    acl_revoke: {
      primary: new Set(['user_id', 'level']),
      affected: new Set(),
    },
    // floor_update 载荷定义（方案 §2.3 "v0.7 补，C1 冻结事件助手前必须落地"）：
    //   asset_id=NULL；role='primary'；related_asset_id=NULL；键集合 {floor_id,name,sort_order,rooms}。
    floor_update: {
      primary: new Set(['floor_id', 'name', 'sort_order', 'rooms']),
      affected: new Set(),
    },
    // C3（机柜动作族，方案 §4 矩阵 + spec §3 逐字）：primary=实际改动的状态/位置列；
    //   affected=随装盘同步 status（仅 rack_in/rack_out/mark_status 联动，方案 §2.3 第165行）；
    //   rack_move/rack_relocate/retire「受影响：无」→ affected 恒空集合，写非空 affected 会被
    //   writeEvent 的超集校验直接拒绝（这是有意的 fail-closed，见 spec §3 末句）。
    rack_in: {
      primary: new Set(['status', 'rack_id', 'u_start']),
      affected: new Set(['status']),
    },
    rack_out: {
      primary: new Set(['status', 'rack_id', 'u_start']),
      affected: new Set(['status']),
    },
    rack_move: {
      primary: new Set(['rack_id', 'u_start']),
      affected: new Set(),
    },
    rack_relocate: {
      primary: new Set(['u_start']),
      affected: new Set(),
    },
    mark_status: {
      primary: new Set(['status']),
      affected: new Set(['status']),
    },
    retire: {
      primary: new Set(['status']),
      affected: new Set(),
    },
  };
  // 未在本处定义的动作先留空集合；C4 在工厂尾部登记四个 disk_* 动作的精确载荷。
  for (const action of ACTIONS) {
    if (!PAYLOAD_KEYS[action]) PAYLOAD_KEYS[action] = { primary: new Set(), affected: new Set() };
  }

  function newOpId() {
    return crypto.randomUUID();
  }

  // M3（主会话 2026-09-18 裁定）：递归查找 value 内任意深度是否出现 FINANCE_FIELDS 键（含数组内
  //   对象），命中返回该键名，否则返回 false——原实现只查 from_state/to_state 的顶层键，嵌套对象
  //   （如 { attrs: { fin_amount: 1 } }）会漏判。
  // B1（必修，主会话 2026-09-18 裁定）：加 _seen WeakSet 防环——写法照 rejectFinanceFields 的
  //   防环方式（本文件同名做法第二处），环形 to_state（如 x.self = x）会导致无限递归栈溢出。
  function findFinanceKeyDeep(value, _seen) {
    if (Array.isArray(value)) {
      const seen = _seen || new WeakSet();
      if (seen.has(value)) return false; // 已访问过，防环
      seen.add(value);
      for (const item of value) {
        const hit = findFinanceKeyDeep(item, seen);
        if (hit) return hit;
      }
      return false;
    }
    if (value && typeof value === 'object' && !Buffer.isBuffer(value) && !(value instanceof Date)) {
      const seen = _seen || new WeakSet();
      if (seen.has(value)) return false;
      seen.add(value);
      for (const [k, v] of Object.entries(value)) {
        if (FINANCE_FIELDS.has(k)) return k;
        const hit = findFinanceKeyDeep(v, seen);
        if (hit) return hit;
      }
      return false;
    }
    return false;
  }

  // M2（主会话 2026-09-18 裁定）：floor_update 专项校验——role 恒 primary、related_asset_id 恒
  //   NULL、from/to 不得同时为空对象、非空一侧必须**恰好**含 {floor_id,name,sort_order,rooms}
  //   四键且类型合法（缺字段/多字段/类型不对都拒），方案 §2.3 floor_update 载荷定义的完整落地。
  const FLOOR_UPDATE_KEY_TYPES = {
    floor_id: (v) => typeof v === 'string',
    name: (v) => typeof v === 'string',
    sort_order: (v) => Number.isInteger(v),
    rooms: (v) => Array.isArray(v) && v.every((r) => r && typeof r === 'object' && !Array.isArray(r)),
  };
  const FLOOR_UPDATE_KEYS = Object.keys(FLOOR_UPDATE_KEY_TYPES);

  // B6（主会话 2026-09-18 裁定，不改代码只记账）：口径收紧——非空侧恒四键**全量快照**（不是
  //   "只记变了哪些键"的增量 diff），方案 §2.3 目前只给了 floor_update 的键集合，没有明文写清
  //   "非空侧到底是全量快照还是增量"，这里按全量快照实现，待补进方案正文（锚点待追认 #2）。
  //   rooms 键传入时必须已经是 **JSON.parse 后的数组**（不是 rooms 字段本身的 JSON 字符串）——
  //   本函数不做字符串解析，调用方负责在传入前 parse 好。
  function validateFloorUpdateSide(label, obj) {
    const keys = Object.keys(obj);
    if (keys.length === 0) return; // 允许该侧为空对象（新建 from={} 或删除 to={}）
    const missing = FLOOR_UPDATE_KEYS.filter((k) => !(k in obj));
    const extra = keys.filter((k) => !FLOOR_UPDATE_KEYS.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      const e = new Error(
        `floor_update ${label} 键集合必须恰好是 {floor_id,name,sort_order,rooms}` +
        `（缺:${missing.join(',') || '-'} 多:${extra.join(',') || '-'}）`
      );
      e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    for (const k of FLOOR_UPDATE_KEYS) {
      if (!FLOOR_UPDATE_KEY_TYPES[k](obj[k])) {
        const e = new Error(`floor_update ${label}.${k} 类型不合法`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
    }
  }

  // writeEvent：事务内助手（q 由 withWrite 提供，不再取锁）。
  async function writeEvent(q, { op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, note }) {
    if (!ACTIONS.has(action)) {
      const e = new Error(`未知动作码: ${action}`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    if (role !== 'primary' && role !== 'affected') {
      const e = new Error(`非法 role: ${role}`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    const assetIdRequired = !NULL_ASSET_ACTIONS.has(action);
    const assetIdIsNull = asset_id === null || asset_id === undefined;
    if (assetIdRequired && assetIdIsNull) {
      const e = new Error(`动作 ${action} 要求 asset_id 非空`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    if (!assetIdRequired && !assetIdIsNull) {
      const e = new Error(`动作 ${action} 的 asset_id 必须为 NULL`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    for (const [label, obj] of [['from_state', from_state], ['to_state', to_state]]) {
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        const e = new Error(`${label} 必须是对象`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
    }
    if (action === 'floor_update') {
      if (role !== 'primary') {
        const e = new Error('floor_update 的 role 必须是 primary'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
      if (related_asset_id !== null && related_asset_id !== undefined) {
        const e = new Error('floor_update 的 related_asset_id 必须为 NULL'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
      const fromEmpty = Object.keys(from_state).length === 0;
      const toEmpty = Object.keys(to_state).length === 0;
      if (fromEmpty && toEmpty) {
        const e = new Error('floor_update 的 from_state/to_state 不得同时为空对象'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
      validateFloorUpdateSide('from_state', from_state);
      validateFloorUpdateSide('to_state', to_state);
    }
    // S-rec2（第5批）：affected 键集合为空集合的动作（rack_move/rack_relocate/retire，方案
    //   §3 矩阵"受影响：无"）——role='affected' 本身就不该被调用，不能只靠"载荷键不在允许集合
    //   里"这条防线（那条防线对**完全空**的 from_state/to_state({} / {})会失效：Object.keys({})
    //   是空数组，下面的逐键校验循环零次迭代，永远不会命中"不允许字段"，等于放行了一次
    //   "载荷为空但角色本不该存在"的 affected 事件）。这里直接按 role 拒绝，不看载荷内容。
    if (role === 'affected' && PAYLOAD_KEYS[action] && PAYLOAD_KEYS[action].affected.size === 0) {
      const e = new Error(`动作 ${action} 不允许 affected 角色事件（该动作矩阵"受影响：无"）`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }
    const allowedKeys = isDiskAction(action) ? await diskEventKeys(q, action, role, asset_id, from_state, to_state) : ((PAYLOAD_KEYS[action] && PAYLOAD_KEYS[action][role]) || new Set());
    for (const obj of [from_state, to_state]) {
      for (const key of Object.keys(obj)) {
        if (!allowedKeys.has(key)) {
          const e = new Error(`动作 ${action}(${role}) 不允许字段: ${key}`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
        }
        if (key === 'fin_changed') {
          // M3：fin_changed 记的是"被改动的财务字段名"，不是值——必须是字符串数组，元素 ∈
          //   FINANCE_FIELDS 且 ≠ external_amount（external_amount 是对账明细专用列，不属于
          //   资产表/资产事件的字段范围，资产事件不该出现它）。
          const val = obj[key];
          const ok = Array.isArray(val) && val.every((v) => typeof v === 'string' && FINANCE_FIELDS.has(v) && v !== 'external_amount');
          if (!ok) {
            const e = new Error('fin_changed 必须是字符串数组，元素 ∈ FINANCE_FIELDS 且 ≠ external_amount');
            e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
          }
          continue; // fin_changed 本身允许含财务字段"名"（字符串），不当成"记录了财务值"
        }
        if (FINANCE_FIELDS.has(key)) {
          const e = new Error(`事件不得记录财务字段值: ${key}`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
        }
        // M3：递归查值内任意深度（含数组内对象）是否夹带财务字段——原实现只查顶层键。
        const nestedHit = findFinanceKeyDeep(obj[key]);
        if (nestedHit) {
          const e = new Error(`事件不得记录财务字段值: ${nestedHit}`); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
        }
      }
    }
    await q.run(
      `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
      [
        op_id,
        assetIdIsNull ? null : asset_id,
        action, role,
        related_asset_id === undefined ? null : related_asset_id,
        JSON.stringify(from_state), JSON.stringify(to_state),
        operator_id, note || null,
      ]
    );
  }

  // ============================================================
  // 六、路由（/me + ACL 三端点，方案 §10 / §2.4）
  // ============================================================

  // ── /me：模块内唯一不过读守卫的端点（方案 §10）；仍过 requireLedgerReady——这是基础设施就绪
  //    闸而非 ACL 授权闸，DB 未就绪时本端点同样无法回答 level（spec §2.3 "读不懂就只返回 level
  //    并回报"——本实现能读懂 §9 口径，一并返回 expiring_count）。
  router.get('/it-assets/me', authenticateToken, requireLedgerReady, async (req, res) => {
    try {
      const result = await withRead(async (q) => {
        let level = null;
        if (req.user.role === 'admin') {
          level = 'admin';
        } else {
          const row = await q.get('SELECT level FROM it_asset_acl WHERE user_id = ?', [req.user.id]);
          level = row ? row.level : null;
        }
        if (level === null) return { level: null };
        // §9：category ∈ (software, subscription) 且 status=active 且 expires_at 非空
        //   且 expires_at ≤ today+90 的计数。
        const row = await q.get(
          `SELECT COUNT(*) AS c FROM it_assets
             WHERE category IN ('software','subscription')
               AND status = 'active'
               AND expires_at IS NOT NULL
               AND expires_at <= date('now','localtime','+90 day') AND ${await recordManagement.activeClause(q)}`
        );
        return { level, expiring_count: row ? row.c : 0 };
      });
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── ACL 三端点（全部 requireAdmin，全部在 withWrite 内、写事件，方案 §2.3）───────────
  router.get('/it-assets/acl', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    try {
      const rows = await withRead((q) => q.all(
        `SELECT a.user_id, a.level, a.granted_by, a.created_at, u.display_name AS user_name
           FROM it_asset_acl a LEFT JOIN users u ON u.id = a.user_id
          ORDER BY a.user_id ASC`
      ));
      res.json({ items: rows || [] });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.put('/it-assets/acl/:userId', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ code: 'LEDGER_INVALID_USER_ID', message: 'userId 必须是正整数' });
    }
    const level = req.body && req.body.level;
    if (level !== 'read' && level !== 'write') {
      return res.status(400).json({ code: 'LEDGER_INVALID_LEVEL', message: 'level 仅支持 read/write' });
    }
    try {
      const opId = newOpId();
      const result = await withWrite(async (q) => {
        const targetUser = await q.get('SELECT id, role FROM users WHERE id = ?', [userId]);
        if (!targetUser) {
          const e = new Error('用户不存在'); e.status = 404; e.code = 'LEDGER_USER_NOT_FOUND'; throw e;
        }
        if (targetUser.role === 'admin') {
          const e = new Error('admin 用户无需（也不允许）加入 ACL'); e.status = 400; e.code = 'LEDGER_TARGET_IS_ADMIN'; throw e;
        }
        const existing = await q.get('SELECT user_id, level FROM it_asset_acl WHERE user_id = ?', [userId]);
        const fromState = existing ? { user_id: existing.user_id, level: existing.level } : {};
        await q.run(
          `INSERT INTO it_asset_acl (user_id, level, granted_by, created_at)
           VALUES (?, ?, ?, datetime('now','localtime'))
           ON CONFLICT(user_id) DO UPDATE SET level = excluded.level, granted_by = excluded.granted_by`,
          [userId, level, req.user.id]
        );
        await writeEvent(q, {
          op_id: opId, asset_id: null, action: 'acl_grant', role: 'primary',
          related_asset_id: null, from_state: fromState, to_state: { user_id: userId, level },
          operator_id: req.user.id, note: null,
        });
        return { user_id: userId, level };
      });
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.delete('/it-assets/acl/:userId', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ code: 'LEDGER_INVALID_USER_ID', message: 'userId 必须是正整数' });
    }
    try {
      const opId = newOpId();
      await withWrite(async (q) => {
        const existing = await q.get('SELECT user_id, level FROM it_asset_acl WHERE user_id = ?', [userId]);
        if (!existing) {
          const e = new Error('该用户不在 ACL 内'); e.status = 404; e.code = 'LEDGER_ACL_NOT_FOUND'; throw e;
        }
        await q.run('DELETE FROM it_asset_acl WHERE user_id = ?', [userId]);
        await writeEvent(q, {
          op_id: opId, asset_id: null, action: 'acl_revoke', role: 'primary',
          related_asset_id: null, from_state: { user_id: existing.user_id, level: existing.level }, to_state: {},
          operator_id: req.user.id, note: null,
        });
      });
      res.json({ ok: true });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ============================================================
  // 六b、C2（长任务 D · 登记/编辑/机柜/楼层）：白名单常量 + 助手 + 端点
  //   方案 §5（登记/编辑）/ §2.2（机柜）/ §2.2b（楼层） / 执行 agent spec
  //   docs/local/信息化资产_轻量版/_agent_specs/C2_登记编辑机柜楼层_spec.md
  // ============================================================
  const {
    normalizeAssetFields, deriveInitialState, validatePeerVersions,
    validateRoomsArray, validateAssetInvariants,
  } = invariants;

  // 登记顶层白名单（方案 §5 L351 逐字，财务三字段单独经 rejectFinanceFields 把关）。
  const REGISTER_ASSET_FIELDS = [
    'category', 'name', 'brand', 'model', 'sn', 'asset_no', 'purchased_at', 'expires_at',
    'attrs', 'slot_count', 'u_height', 'note', 'fin_amount', 'fin_vendor', 'fin_contract_no',
    'owner_name', 'owner_dept', 'asset_class',
  ];
  // 登记顶层禁止键（初态只能由 placement 派生，不允许两个来源，方案 §5 L351）。
  const REGISTER_FORBIDDEN_TOP_FIELDS = [
    'status', 'rack_id', 'u_start', 'parent_asset_id', 'slot_no',
    'custodian_user_id', 'custodian_name', 'floor_id', 'room_id', 'pos', 'version',
  ];
  // 编辑可编辑白名单（方案 §5 L356 逐字）。
  const UPDATE_ASSET_FIELDS = [
    'name', 'brand', 'model', 'sn', 'asset_no', 'purchased_at', 'note', 'attrs', 'expires_at',
    'slot_count', 'u_height', 'fin_amount', 'fin_vendor', 'fin_contract_no',
    'owner_name', 'owner_dept', 'asset_class',
  ];
  // 编辑拒绝键（方案 §5 L356 逐字）。
  const UPDATE_REJECT_FIELDS = [
    'category', 'status', 'rack_id', 'u_start', 'location_text', 'floor_id', 'room_id', 'pos',
    'parent_asset_id', 'slot_no', 'custodian_user_id', 'custodian_name', 'version',
  ];
  // 楼层 id 格式（方案 §2.2b："如 F15"）。
  const FLOOR_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

  // WRITE_ERROR_CODES：C2 全部端点可能返回的错误码闭集，供守卫对拍（spec §1）。部分码是方案
  //   §1/§10 明文给出的闭集成员（VERSION_CONFLICT/RACK_SLOT_OCCUPIED/DUPLICATE_SN/
  //   DUPLICATE_ASSET_NO/ROOM_IN_USE/RACK_NOT_EMPTY/U_TOTAL_BELOW_OCCUPIED/
  //   SLOT_COUNT_BELOW_OCCUPIED/CUSTODIAN_REQUIRED/FINANCE_FIELD_FORBIDDEN 由 rejectFinanceFields
  //   既有实现产出，命名早于本 commit）；另有若干方案未点名具体码值的业务分支，本 commit 按最
  //   贴近语义新起了码名（LEDGER_DUPLICATE_RACK_NAME/LEDGER_DUPLICATE_FLOOR_NAME/
  //   U_HEIGHT_LOCKED/INVALID_ASSET_CLASS——回报里逐条列为"方案未定义，本 commit 新增"，供主
  //   会话复核是否需要并入方案正文的错误码表）。LEDGER_ROOM_ID_LOCKED 已随契约纠正
  //   （coordinator 2026-09-19：只冻结房间 id 本身，已有房间内容可改）删除，"改已有房间 id"
  //   场景现在统一走 ROOM_IN_USE（旧 id 从新数组消失即等价删除，被引用则 409）。
  // Opus 预筛（2026-09-19）新增三码：U_INTERVAL_OUT_OF_RANGE（S-H2，机柜区间越顶/u_start<1，
  //   原先误配 LEDGER_BAD_REQUEST+409）、SLOT_OCCUPIED（S-M6，硬盘装盘位冲突不再借用机柜专用
  //   的 RACK_SLOT_OCCUPIED）、FLOOR_NOT_EMPTY（S-M7，删楼层"rooms 非空"不再借用 ROOM_IN_USE）。
  //   LEDGER_INTERNAL 也纳入闭集——S-H1 的 ctx 缺失 fail-closed 分支对外泄出的码。
  const WRITE_ERROR_CODES = new Set([
    'LEDGER_BAD_REQUEST', 'VERSION_CONFLICT', 'RACK_SLOT_OCCUPIED', 'DUPLICATE_SN', 'DUPLICATE_ASSET_NO',
    'ROOM_IN_USE', 'RACK_NOT_EMPTY', 'U_TOTAL_BELOW_OCCUPIED', 'SLOT_COUNT_BELOW_OCCUPIED', 'CUSTODIAN_REQUIRED',
    'FINANCE_FIELD_FORBIDDEN', 'LEDGER_NOT_FOUND', 'LEDGER_FORBIDDEN', 'LEDGER_DUPLICATE_RACK_NAME',
    'LEDGER_DUPLICATE_FLOOR_NAME', 'U_HEIGHT_LOCKED', 'INVALID_ASSET_CLASS',
    'INVALID_PLACEMENT_COMBO', 'LEDGER_INVALID_ID',
    'U_INTERVAL_OUT_OF_RANGE', 'SLOT_OCCUPIED', 'FLOOR_NOT_EMPTY', 'LEDGER_INTERNAL', 'LEDGER_BUSY', // #25: 既有503补登
    // R-L1（codex 22-R）：HOST_DISK_STATUS_SYNC（invariants.js 的 HOST_SLOT/HOST_DISK_STATUS_SYNC
    // 两条规则共用的码）此前遗漏未登记进闭集。
    'HOST_DISK_STATUS_SYNC',
  ]);

  // ── 响应构造助手：把 DB 里的 JSON 字符串列还原成对象（stripFinance 需要真实对象才能递归剔除
  //    嵌套财务字段；直接透传 JSON 字符串会让 stripFinance 的按键剔除失效，方案 §10"不把 JSON
  //    字符串原样透出"）。
  // S-M5（Opus 复看第5批）：解析失败不再静默保留原字符串（那样会把损坏的 JSON 原文直接透给
  //   客户端，且调用方完全看不出这一列已经损坏）——抛结构化 500 LEDGER_INTERNAL，消息里只带
  //   id 定位，不回传解析失败的原文（避免把可能很大或包含垃圾字节的损坏内容塞进错误响应）。
  // R-M4（codex 22-R）：JSON.parse 成功不等于"形状合法"——双重编码的 JSON（比如
  // attrs 列存的是 `'"{\"fin_amount\":1}"'`，parse 一次后得到的是一个字符串，不是对象）会让
  // parse 本身不报错，但产出的值形状不对，下游（stripFinance/事件白名单等）按对象处理会出
  // 意外行为。补一层形状校验：attrs/from_state/to_state 必须是非数组的普通对象；pos 必须是
  // null 或恰含 {x,y} 两个有限数键的对象。形状不对同样判 500 LEDGER_INTERNAL，不回传原文。
  function isPlainObjectShape(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }
  function isValidPosShape(v) {
    if (v === null) return true;
    if (!isPlainObjectShape(v)) return false;
    const keys = Object.keys(v);
    if (keys.length !== 2 || !('x' in v) || !('y' in v)) return false;
    return typeof v.x === 'number' && Number.isFinite(v.x) && typeof v.y === 'number' && Number.isFinite(v.y);
  }
  function parseAssetRow(row) {
    if (!row) return row;
    const out = Object.assign({}, row);
    if (typeof out.attrs === 'string') {
      try { out.attrs = JSON.parse(out.attrs); } catch (e) {
        const err = new Error(`资产 attrs 列 JSON 解析失败(id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
      if (!isPlainObjectShape(out.attrs)) {
        const err = new Error(`资产 attrs 列解析结果形状非法(id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
    }
    if (typeof out.pos === 'string') {
      try { out.pos = JSON.parse(out.pos); } catch (e) {
        const err = new Error(`资产 pos 列 JSON 解析失败(id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
      if (!isValidPosShape(out.pos)) {
        const err = new Error(`资产 pos 列解析结果形状非法(id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
    }
    return out;
  }
  function parseEventRow(row) {
    if (!row) return row;
    const out = Object.assign({}, row);
    if (typeof out.from_state === 'string') {
      try { out.from_state = JSON.parse(out.from_state); } catch (e) {
        const err = new Error(`事件 from_state 列 JSON 解析失败(event id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
      if (!isPlainObjectShape(out.from_state)) {
        const err = new Error(`事件 from_state 列解析结果形状非法(event id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
    }
    if (typeof out.to_state === 'string') {
      try { out.to_state = JSON.parse(out.to_state); } catch (e) {
        const err = new Error(`事件 to_state 列 JSON 解析失败(event id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
      if (!isPlainObjectShape(out.to_state)) {
        const err = new Error(`事件 to_state 列解析结果形状非法(event id=${row.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; throw err;
      }
    }
    return out;
  }

  // S-M3（Opus 复看第5批）：稳定序列化——对象键递归排序后再比较，数组保持原序（顺序本身是
  //   语义的一部分，不排序）。`JSON.stringify` 直接比较对同一逻辑值的两种不同键序列化结果
  //   会误判"变了"（例如 attrs 从 `{a:1,b:2}` 改写成 `{b:2,a:1}`，值完全一样，naive 字符串比较
  //   会判定为改动，多写一次 UPDATE/事件/version+1）。
  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      const keys = Object.keys(value).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  }

  // buildOccupiedIntervals（R-M3，codex 22-R）：组装 ctx.occupiedIntervals 时同样校验源数据——
  //   invariants.js 的 NUMERIC_DOMAIN 规则会在 validateAssetInvariants 内部再校验一次（双重
  //   防线），但这里先在读出 DB 行的当下就 fail-closed，不把畸形数据一路带到不变量校验那一层
  //   才发现（尽早失败，且报错位置更贴近数据来源，排查更直接）。
  function buildOccupiedIntervals(rows) {
    return rows.map((r) => {
      if (!invariants.isSafePosInt(r.u_start) || !invariants.isSafePosInt(r.u_height)) {
        const e = new Error(`在位区间源数据非法(asset id=${r.id}, u_start=${r.u_start}, u_height=${r.u_height})`);
        e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
      }
      return [r.u_start, r.u_start + r.u_height - 1, r.id];
    });
  }

  // register 事件 to_state：状态 + 全部位置/装载/保管人列 + expires_at + P10 三键（方案 §2.3
  //   register 载荷定义），键集合 ⊆ PAYLOAD_KEYS.register.primary，值 null 也写键。
  function buildRegisterToState(state, expiresAt, ownerFields) {
    return {
      status: state.status,
      rack_id: state.rack_id,
      u_start: state.u_start,
      location_text: state.location_text,
      floor_id: state.floor_id,
      room_id: state.room_id,
      pos: state.pos,
      parent_asset_id: state.parent_asset_id,
      slot_no: state.slot_no,
      custodian_user_id: state.custodian_user_id,
      custodian_name: state.custodian_name,
      expires_at: expiresAt === undefined ? null : expiresAt,
      owner_name: ownerFields.owner_name,
      owner_dept: ownerFields.owner_dept,
      asset_class: ownerFields.asset_class,
    };
  }

  // ── POST /api/it-assets（登记，方案 §5）──────────────────────────────────────────────
  router.post('/it-assets', authenticateToken, requireLedgerReady, requireLedgerRead, requireLedgerWrite, async (req, res) => {
    try {
      const body = req.body || {};
      const isAdmin = req.user.role === 'admin';

      for (const k of REGISTER_FORBIDDEN_TOP_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
          return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `登记顶层不允许携带 ${k}（初态只能由 placement 派生）`, field: k });
        }
      }
      rejectFinanceFields(body, isAdmin);

      const allowedTop = new Set(REGISTER_ASSET_FIELDS.concat(['placement', 'peer_versions']));
      const unknownTop = Object.keys(body).filter((k) => !allowedTop.has(k));
      if (unknownTop.length > 0) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `未知字段: ${unknownTop.join(',')}`, field: unknownTop[0] });
      }
      if (typeof body.category !== 'string' || !invariants.CATEGORY_VALUES.includes(body.category)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'category 非法', field: 'category' });
      }
      if (Object.prototype.hasOwnProperty.call(body, 'asset_class')) {
        const classCheck = assertAssetClass(body.asset_class);
        if (!classCheck.ok) return res.status(400).json({ code: classCheck.code || 'LEDGER_BAD_REQUEST', message: 'asset_class 非法', field: 'asset_class' });
      }

      // S-H3（Opus 预筛 2026-09-19）：登记/编辑两端统一形态闸——name/brand/model/note/
      //   owner_name/owner_dept/fin_vendor/fin_contract_no/fin_amount 曾经零类型校验（直接把
      //   body 里的任意值塞进 SQL 参数），现在全部并入 normalizeAssetFields 一次性校验。
      const normInput = {
        name: body.name,
        brand: body.brand === undefined ? null : body.brand,
        model: body.model === undefined ? null : body.model,
        note: body.note === undefined ? null : body.note,
        owner_name: body.owner_name === undefined ? null : body.owner_name,
        owner_dept: body.owner_dept === undefined ? null : body.owner_dept,
        fin_amount: body.fin_amount === undefined ? null : body.fin_amount,
        fin_vendor: body.fin_vendor === undefined ? null : body.fin_vendor,
        fin_contract_no: body.fin_contract_no === undefined ? null : body.fin_contract_no,
        sn: body.sn === undefined ? null : body.sn,
        asset_no: body.asset_no === undefined ? null : body.asset_no,
        attrs: body.attrs === undefined ? {} : body.attrs,
        expires_at: body.expires_at === undefined ? null : body.expires_at,
        purchased_at: body.purchased_at === undefined ? null : body.purchased_at,
        slot_count: body.slot_count === undefined ? 0 : body.slot_count,
        u_height: body.u_height === undefined ? 0 : body.u_height,
      };
      const normResult = normalizeAssetFields(body.category, normInput);
      if (!normResult.ok) return res.status(normResult.status || 400).json({ code: normResult.code, message: normResult.message, field: normResult.field });
      const norm = normResult.values;

      const deriveResult = deriveInitialState(body.category, body.placement, { uHeight: norm.u_height });
      if (!deriveResult.ok) return res.status(deriveResult.status || 400).json({ code: deriveResult.code, message: deriveResult.message, field: deriveResult.field });
      const kind = deriveResult.kind;
      const state = deriveResult.state;

      // S-L10：custodian_name 空串归一为 null（唯一来源是 placement.custodian_name，对其它
      //   kind 恒为 null，调用本函数是幂等的无害操作）。
      const custodianNorm = normalizeAssetFields(body.category, { custodian_name: state.custodian_name });
      if (!custodianNorm.ok) return res.status(custodianNorm.status || 400).json({ code: custodianNorm.code, message: custodianNorm.message, field: custodianNorm.field });
      state.custodian_name = custodianNorm.values.custodian_name;

      const peerCheck = validatePeerVersions(kind, body.peer_versions, body.placement && body.placement.parent_asset_id);
      if (!peerCheck.ok) return res.status(peerCheck.status || 400).json({ code: peerCheck.code, message: peerCheck.message, field: peerCheck.field });

      const opId = newOpId();
      const ownerFields = {
        owner_name: norm.owner_name === undefined ? null : norm.owner_name,
        owner_dept: norm.owner_dept === undefined ? null : norm.owner_dept,
        asset_class: body.asset_class === undefined ? null : body.asset_class,
      };

      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);

        if (norm.sn !== undefined && norm.sn !== null) {
          const dup = await q.get('SELECT id FROM it_assets WHERE sn = ?', [norm.sn]);
          if (dup) { const e = new Error('SN 重复'); e.status = 409; e.code = 'DUPLICATE_SN'; e.field = 'sn'; throw e; }
        }
        if (norm.asset_no !== undefined && norm.asset_no !== null) {
          const dup = await q.get('SELECT id FROM it_assets WHERE asset_no = ?', [norm.asset_no]);
          if (dup) { const e = new Error('asset_no 重复'); e.status = 409; e.code = 'DUPLICATE_ASSET_NO'; e.field = 'asset_no'; throw e; }
        }

        // S-H1（Opus 预筛）：登记是新建资产，不可能已有硬盘挂在它下面，childDisks 恒为空数组
        //   ——但必须显式传 []，不能省略这个键（invariants.js 的 SLOT_COUNT_FLOOR 规则对
        //   host-eligible 资产强制要求 ctx.childDisks 是数组，缺失即 fail-closed 500）。
        const ctx = { childDisks: [] };
        let hostRow = null;
        if (kind === 'rack') {
          const rack = await q.get('SELECT id, u_total FROM it_racks WHERE id = ?', [state.rack_id]);
          if (!rack) { const e = new Error('机柜不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'placement.rack_id'; throw e; }
          const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [state.rack_id]);
          ctx.rack = { u_total: rack.u_total };
          ctx.occupiedIntervals = buildOccupiedIntervals(occ);
        } else if (kind === 'host') {
          hostRow = await q.get('SELECT id, version, status, slot_count, category FROM it_assets WHERE id = ?', [state.parent_asset_id]);
          if (!hostRow) { const e = new Error('宿主不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'placement.parent_asset_id'; throw e; }
          if (peerCheck.expectedVersion !== hostRow.version) { const e = new Error('宿主版本冲突'); e.status = 409; e.code = 'VERSION_CONFLICT'; throw e; }
          // Opus 复看第7批契约裁定：宿主状态域是「装盘」这个动作的前置条件（不是资产行的
          // 恒定不变量，见 invariants.js 头注释与 PARENT_ALLOWED_STATUSES 定义处），登记 host
          // 分支在这里一次性判断（retired 及域外值一律拒绝新装盘），不再放进
          // validateAssetInvariants 里对硬盘行做恒定校验——常量导出自 invariants.js，供未来 C4
          // disk_mount 动作复用同一份判据。
          if (!invariants.PARENT_ALLOWED_STATUSES.includes(hostRow.status)) {
            const e = new Error(`宿主状态(${hostRow.status})不允许装盘`); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e;
          }
          if (!(hostRow.slot_count > 0)) { const e = new Error('宿主不具备宿主资格'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e; }
          if (!(state.slot_no >= 1 && state.slot_no <= hostRow.slot_count)) {
            const e = new Error('slot_no 超出宿主容量'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'placement.slot_no'; throw e;
          }
          const occSlot = await q.get('SELECT id FROM it_assets WHERE parent_asset_id = ? AND slot_no = ?', [hostRow.id, state.slot_no]);
          // S-M6（Opus 预筛）：硬盘装盘位冲突不再复用机柜专用的 RACK_SLOT_OCCUPIED，方案没给
          //   盘位专用码，新起 SLOT_OCCUPIED（已登记进 WRITE_ERROR_CODES）。
          if (occSlot) { const e = new Error('该盘位已被占用'); e.status = 409; e.code = 'SLOT_OCCUPIED'; throw e; }
          state.status = hostRow.status === 'in_service' ? 'in_service' : hostRow.status;
          ctx.parent = { slot_count: hostRow.slot_count, status: hostRow.status, category: hostRow.category };
        } else if (kind === 'room') {
          const floor = await q.get('SELECT id, rooms FROM it_floors WHERE id = ?', [state.floor_id]);
          if (!floor) { const e = new Error('楼层不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'placement.floor_id'; throw e; }
          ctx.floor = { rooms: JSON.parse(floor.rooms) };
        } else if (kind === 'custodian' && state.custodian_user_id !== null) {
          const u = await q.get('SELECT id, display_name FROM users WHERE id = ?', [state.custodian_user_id]);
          if (!u) { const e = new Error('保管人不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'placement.custodian_user_id'; throw e; }
          state.custodian_name = u.display_name;
        }

        // C3 首件（validateRowSchema）要求「完整行」——row 必须恰含 it_assets 全部列名
        // （invariants.ASSET_ROW_KEYS），id 是新建时唯一允许 undefined 的键。此前只传业务规则
        // 用得到的十几个字段（缺 asset_no/name/brand/model/sn/purchased_at/attrs/fin_*/note/
        // version/created_by/created_at/updated_at/owner_*/asset_class），validateAssetInvariants
        // 首行调用 validateRowSchema 后这些缺键会被判 500——一并补全，值直接取自本函数已算好
        // 的 norm/ownerFields/isAdmin，不新起第二份计算。
        const row = {
          id: undefined,
          asset_no: norm.asset_no === undefined ? null : norm.asset_no,
          category: body.category,
          name: norm.name,
          brand: norm.brand === undefined ? null : norm.brand,
          model: norm.model === undefined ? null : norm.model,
          sn: norm.sn === undefined ? null : norm.sn,
          status: state.status,
          u_height: norm.u_height,
          slot_count: norm.slot_count,
          u_start: state.u_start,
          rack_id: state.rack_id,
          location_text: state.location_text,
          floor_id: state.floor_id,
          room_id: state.room_id,
          pos: state.pos,
          parent_asset_id: state.parent_asset_id,
          slot_no: state.slot_no,
          custodian_user_id: state.custodian_user_id,
          custodian_name: state.custodian_name,
          purchased_at: norm.purchased_at === undefined ? null : norm.purchased_at,
          // L15（主会话第3批裁定）：与下方 INSERT 参数用同一表达式（原来这里少了 undefined
          //   守卫，虽然 normalizeAssetFields 的调用点已保证 norm.expires_at 恒被赋值不会真的
          //   是 undefined，但两处写法不一致本身是隐患——统一成完全相同的表达式，写读同源无歧义）。
          expires_at: norm.expires_at === undefined ? null : norm.expires_at,
          attrs: norm.attrs,
          fin_amount: isAdmin ? (norm.fin_amount === undefined ? null : norm.fin_amount) : null,
          fin_vendor: isAdmin ? (norm.fin_vendor === undefined ? null : norm.fin_vendor) : null,
          fin_contract_no: isAdmin ? (norm.fin_contract_no === undefined ? null : norm.fin_contract_no) : null,
          note: norm.note === undefined ? null : norm.note,
          version: 1,
          created_by: req.user.id,
          // L16：刻意占位 null——真实 created_at/updated_at 由 INSERT 语句里的 SQL
          //   datetime('now','localtime') 生成，此刻尚未落库不可能提前知道具体值；
          //   ASSET_COLUMN_SCHEMA 对这两列的校验是"null 或字符串"（宽松），且没有任何 RULE
          //   读取这两列参与业务判断，占位符不会改变任何校验结论。
          created_at: null,
          updated_at: null,
          owner_name: ownerFields.owner_name,
          owner_dept: ownerFields.owner_dept,
          asset_class: ownerFields.asset_class,
        };
        const violation = validateAssetInvariants(row, ctx);
        if (violation) {
          const e = new Error(violation.message); e.status = violation.status || 400; e.code = violation.code || 'LEDGER_BAD_REQUEST'; e.field = violation.field; throw e;
        }

        const insertResult = await q.run(
          `INSERT INTO it_assets (
             asset_no, category, name, brand, model, sn, status, slot_count, u_height, u_start, rack_id,
             location_text, floor_id, room_id, pos, parent_asset_id, slot_no, custodian_user_id, custodian_name,
             purchased_at, expires_at, attrs, fin_amount, fin_vendor, fin_contract_no, note, version, created_by,
             owner_name, owner_dept, asset_class, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, datetime('now','localtime'), datetime('now','localtime'))`,
          [
            norm.asset_no === undefined ? null : norm.asset_no,
            body.category, norm.name,
            norm.brand === undefined ? null : norm.brand,
            norm.model === undefined ? null : norm.model,
            norm.sn === undefined ? null : norm.sn,
            state.status, norm.slot_count, norm.u_height,
            state.u_start, state.rack_id, state.location_text, state.floor_id, state.room_id,
            state.pos ? JSON.stringify(state.pos) : null,
            state.parent_asset_id, state.slot_no, state.custodian_user_id, state.custodian_name,
            norm.purchased_at === undefined ? null : norm.purchased_at,
            norm.expires_at === undefined ? null : norm.expires_at,
            JSON.stringify(norm.attrs),
            isAdmin ? (norm.fin_amount === undefined ? null : norm.fin_amount) : null,
            isAdmin ? (norm.fin_vendor === undefined ? null : norm.fin_vendor) : null,
            isAdmin ? (norm.fin_contract_no === undefined ? null : norm.fin_contract_no) : null,
            norm.note === undefined ? null : norm.note,
            1, req.user.id,
            ownerFields.owner_name, ownerFields.owner_dept, ownerFields.asset_class,
          ]
        );
        const newId = insertResult.lastID;

        if (kind === 'host') {
          await q.run("UPDATE it_assets SET version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [hostRow.id]);
        }

        await writeEvent(q, {
          op_id: opId, asset_id: newId, action: 'register', role: 'primary', related_asset_id: null,
          from_state: {}, to_state: buildRegisterToState(state, norm.expires_at, ownerFields),
          operator_id: req.user.id, note: null,
        });

        if (kind === 'host') {
          await writeEvent(q, {
            op_id: opId, asset_id: hostRow.id, action: 'register', role: 'affected', related_asset_id: newId,
            from_state: { slot_no: state.slot_no, disk_id: null }, to_state: { slot_no: state.slot_no, disk_id: newId },
            operator_id: req.user.id, note: null,
          });
        }

        const detail = await q.get('SELECT * FROM it_assets WHERE id = ?', [newId]);
        return parseAssetRow(detail);
      });

      res.status(201).json(stripFinance(result, isAdmin));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── GET /api/it-assets（列表，最小形态，方案未把读端点归到某 commit，C2 需要它做 HTTP 层
  //    对拍——主会话自决，见 spec §1 表注） ──────────────────────────────────────────
  router.get('/it-assets', authenticateToken, requireLedgerReady, requireLedgerRead, async (req, res) => {
    try {
      const isAdmin = req.user.role === 'admin';
      const query = req.query || {};
      const allowedQueryKeys = ['category', 'status', 'record_state'];
      const recordState=query.record_state||'active';if(!['active','voided','deleted'].includes(recordState))return res.status(400).json({code:'LEDGER_BAD_REQUEST',message:'记录范围无效'});
      const unknownQuery = Object.keys(query).filter((k) => !allowedQueryKeys.includes(k));
      if (unknownQuery.length > 0) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `不支持的查询参数: ${unknownQuery.join(',')}` });
      }
      const clauses = []; const params = [];
      if (query.category !== undefined) {
        if (!invariants.CATEGORY_VALUES.includes(query.category)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'category 非法', field: 'category' });
        clauses.push('category = ?'); params.push(query.category);
      }
      if (query.status !== undefined) {
        if (!STATUS_VALUES.includes(query.status)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'status 非法', field: 'status' });
        clauses.push('status = ?'); params.push(query.status);
      }
      const rows = await withRead(async q=>{const active=await recordManagement.activeClause(q);if(recordState==='active')clauses.push(active);else{if(active==='1=1')return [];clauses.push('EXISTS (SELECT 1 FROM it_asset_record_controls rc WHERE rc.asset_id=it_assets.id AND rc.state=?)');params.push(recordState);}return q.all(`SELECT * FROM it_assets${clauses.length?' WHERE '+clauses.join(' AND '):''} ORDER BY id ASC`,params);});
      const items = (rows || []).map(parseAssetRow);
      res.json(stripFinance({ items }, isAdmin));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── 机柜 CRUD（方案 §2.2，admin） ─────────────────────────────────────────────────
  router.get('/it-assets/racks', authenticateToken, requireLedgerReady, requireLedgerRead, async (req, res) => {
    try {
      const rows = await withRead((q) => q.all(
        `SELECT r.id, r.name, r.room, r.u_total, r.sort_order, r.note, r.created_at,
                (SELECT COUNT(*) FROM it_assets a WHERE a.rack_id = r.id AND a.status = 'in_service') AS occupied_count
           FROM it_racks r ORDER BY r.sort_order ASC, r.id ASC`
      ));
      res.json({ items: rows || [] });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.post('/it-assets/racks', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const allowed = ['name', 'room', 'u_total', 'sort_order', 'note'];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length > 0) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `未知字段: ${unknown.join(',')}`, field: unknown[0] });
      if (typeof body.name !== 'string' || body.name.trim() === '') return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'name 必填', field: 'name' });
      const room = body.room === undefined ? '机房' : body.room;
      // S-M2（Opus 复看第5批）：room 曾经只查类型不查非空——null/数字虽然会被 typeof 挡掉，
      //   但空字符串 '' 会被当成合法值悄悄存进去；补齐非空校验。
      if (typeof room !== 'string' || room.trim() === '') return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'room 必须是非空字符串', field: 'room' });
      const uTotal = body.u_total === undefined ? 42 : body.u_total;
      // S-M1：u_total 是五个数值域字段之一，改用与 invariants.js 同源的 isSafePosInt。
      if (!invariants.isSafePosInt(uTotal)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'u_total 必须是安全正整数', field: 'u_total' });
      const sortOrder = body.sort_order === undefined ? 0 : body.sort_order;
      if (!Number.isInteger(sortOrder)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'sort_order 必须是整数', field: 'sort_order' });
      // S-M2：note 字符串或 null（不接受数字/对象/数组等其它类型）。
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'note 必须是字符串或 null', field: 'note' });
      }
      const note = body.note === undefined ? null : body.note;

      const result = await withWrite(async (q) => {
        const dup = await q.get('SELECT id FROM it_racks WHERE name = ?', [body.name]);
        if (dup) { const e = new Error('机柜名重复'); e.status = 409; e.code = 'LEDGER_DUPLICATE_RACK_NAME'; e.field = 'name'; throw e; }
        const r = await q.run(
          "INSERT INTO it_racks (name, room, u_total, sort_order, note, created_at) VALUES (?,?,?,?,?, datetime('now','localtime'))",
          [body.name, room, uTotal, sortOrder, note]
        );
        return q.get('SELECT * FROM it_racks WHERE id = ?', [r.lastID]);
      });
      res.status(201).json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.put('/it-assets/racks/:id', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: 'LEDGER_INVALID_ID', message: 'id 必须是正整数' });
    try {
      const body = req.body || {};
      const allowed = ['name', 'room', 'u_total', 'sort_order', 'note'];
      const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
      if (unknown.length > 0) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `未知字段: ${unknown.join(',')}`, field: unknown[0] });
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'name 非法', field: 'name' });
      }
      // S-M2：PUT 之前完全没有 room 校验（可静默存入 null/数字/空串）——补齐与 POST 同款。
      if (body.room !== undefined && (typeof body.room !== 'string' || body.room.trim() === '')) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'room 必须是非空字符串', field: 'room' });
      }
      if (body.u_total !== undefined && !invariants.isSafePosInt(body.u_total)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'u_total 必须是安全正整数', field: 'u_total' });
      }
      if (body.sort_order !== undefined && !Number.isInteger(body.sort_order)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'sort_order 非法', field: 'sort_order' });
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'note 必须是字符串或 null', field: 'note' });
      }

      const result = await withWrite(async (q) => {
        const current = await q.get('SELECT * FROM it_racks WHERE id = ?', [id]);
        if (!current) { const e = new Error('机柜不存在'); e.status = 404; e.code = 'LEDGER_NOT_FOUND'; throw e; }
        if (body.name !== undefined && body.name !== current.name) {
          const dup = await q.get('SELECT id FROM it_racks WHERE name = ? AND id != ?', [body.name, id]);
          if (dup) { const e = new Error('机柜名重复'); e.status = 409; e.code = 'LEDGER_DUPLICATE_RACK_NAME'; e.field = 'name'; throw e; }
        }
        const nextUTotal = body.u_total !== undefined ? body.u_total : current.u_total;
        if (body.u_total !== undefined) {
          const maxRow = await q.get(
            "SELECT MAX(u_start + u_height - 1) AS m FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [id]
          );
          const maxU = (maxRow && maxRow.m) || 0;
          if (nextUTotal < maxU) { const e = new Error('u_total 低于当前最大占用'); e.status = 409; e.code = 'U_TOTAL_BELOW_OCCUPIED'; e.field = 'u_total'; throw e; }
        }
        const fields = {
          name: body.name !== undefined ? body.name : current.name,
          room: body.room !== undefined ? body.room : current.room,
          u_total: nextUTotal,
          sort_order: body.sort_order !== undefined ? body.sort_order : current.sort_order,
          note: body.note !== undefined ? body.note : current.note,
        };
        await q.run('UPDATE it_racks SET name=?, room=?, u_total=?, sort_order=?, note=? WHERE id=?',
          [fields.name, fields.room, fields.u_total, fields.sort_order, fields.note, id]);
        return q.get('SELECT * FROM it_racks WHERE id = ?', [id]);
      });
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.delete('/it-assets/racks/:id', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: 'LEDGER_INVALID_ID', message: 'id 必须是正整数' });
    try {
      await withWrite(async (q) => {
        const current = await q.get('SELECT id FROM it_racks WHERE id = ?', [id]);
        if (!current) { const e = new Error('机柜不存在'); e.status = 404; e.code = 'LEDGER_NOT_FOUND'; throw e; }
        const cnt = await q.get('SELECT COUNT(*) AS c FROM it_assets WHERE rack_id = ?', [id]);
        if (cnt.c > 0) { const e = new Error('机柜非空，不可删除'); e.status = 409; e.code = 'RACK_NOT_EMPTY'; throw e; }
        await q.run('DELETE FROM it_racks WHERE id = ?', [id]);
      });
      res.json({ ok: true });
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── 楼层统一写入口（方案 §2.2b，唯一写路径，PUT/DELETE 共用同一个事务内函数）──────────
  async function applyFloorWrite(q, { floorId, body, isDelete, operatorId }) {
    if (!FLOOR_ID_RE.test(floorId)) {
      const e = new Error('楼层 id 格式非法'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'id'; throw e;
    }
    const current = await q.get('SELECT id, name, sort_order, rooms, note FROM it_floors WHERE id = ?', [floorId]);
    const currentRooms = current ? JSON.parse(current.rooms) : [];

    let newName; let newSortOrder; let newRooms; let newNote;
    if (isDelete) {
      if (!current) { const e = new Error('楼层不存在'); e.status = 404; e.code = 'LEDGER_NOT_FOUND'; throw e; }
      if (currentRooms.length > 0) {
        // S-M7（Opus 预筛）：删楼层时"rooms 非空"本身不是"房间被占用"，不该复用 ROOM_IN_USE
        //   （那是给"被 AP 引用"场景用的），新起 FLOOR_NOT_EMPTY。
        const e = new Error('删除楼层要求 rooms 已为空');
        e.status = 409; e.code = 'FLOOR_NOT_EMPTY'; e.detail = { rooms: currentRooms.map((r) => r.id) };
        throw e;
      }
      newRooms = [];
    } else {
      if (Object.prototype.hasOwnProperty.call(body, 'id')) {
        const e = new Error('不允许修改楼层 id（建后不可改）'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'id'; throw e;
      }
      const allowedKeys = ['name', 'sort_order', 'rooms', 'note'];
      const unknown = Object.keys(body).filter((k) => !allowedKeys.includes(k));
      if (unknown.length > 0) { const e = new Error(`未知字段: ${unknown.join(',')}`); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = unknown[0]; throw e; }
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        const e = new Error('name 必填'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'name'; throw e;
      }
      const sortOrder = body.sort_order === undefined ? (current ? current.sort_order : 0) : body.sort_order;
      if (!Number.isInteger(sortOrder)) { const e = new Error('sort_order 必须是整数'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'sort_order'; throw e; }
      // S-M2（Opus 复看第5批）：note 字符串或 null（与机柜同款，此前零校验）。
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        const e = new Error('note 必须是字符串或 null'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'note'; throw e;
      }
      const roomsValidation = validateRoomsArray(body.rooms);
      if (!roomsValidation.ok) {
        const e = new Error(roomsValidation.message); e.status = roomsValidation.status || 400; e.code = roomsValidation.code || 'LEDGER_BAD_REQUEST'; e.field = roomsValidation.field; throw e;
      }
      // 契约纠正（coordinator 2026-09-19，以方案 §2.2b 为准）：只冻结房间 id 本身（id 是数组
      //   内的主键，"改 id"这个动作在数据形态上就是"删旧建新"，不存在可校验的"同一房间改了
      //   id"这回事）——已存在 id 的 name/x/y/w/h/corridor 允许在整包替换里任意修改。旧 id
      //   若从新数组里消失（等价于"删除该房间"），仍受下方"引用完整性"检查约束：被 AP 引用则
      //   409 ROOM_IN_USE，未被引用则允许（这正是方案"改已有房间 id 409"用例的真实语义——
      //   字面上是在测"删除一个仍被引用的房间"，不是测"不可修改房间内容"）。本函数不再对
      //   "仍存在的旧 id 内容是否变化"做任何比对。
      newName = body.name; newSortOrder = sortOrder; newRooms = body.rooms;
      newNote = body.note === undefined ? (current ? current.note : null) : body.note;
    }

    if (!isDelete) {
      const dup = await q.get('SELECT id FROM it_floors WHERE name = ? AND id != ?', [newName, floorId]);
      if (dup) { const e = new Error('楼层名重复'); e.status = 409; e.code = 'LEDGER_DUPLICATE_FLOOR_NAME'; e.field = 'name'; throw e; }
    }

    // 引用完整性：该楼层全部 AP 引用，被引用房间必须仍在新数组内（方案 §2.2b）。
    const apRefs = await q.all('SELECT id, room_id FROM it_assets WHERE floor_id = ?', [floorId]);
    const newRoomIds = new Set((newRooms || []).map((r) => r.id));
    const violated = apRefs.filter((a) => !newRoomIds.has(a.room_id));
    if (violated.length > 0) {
      const e = new Error('存在被引用的房间将被移除');
      e.status = 409; e.code = 'ROOM_IN_USE';
      e.detail = { rooms: [...new Set(violated.map((v) => v.room_id))], assets: violated.map((v) => v.id) };
      throw e;
    }

    const fromState = current ? { floor_id: current.id, name: current.name, sort_order: current.sort_order, rooms: currentRooms } : {};
    const toState = isDelete ? {} : { floor_id: floorId, name: newName, sort_order: newSortOrder, rooms: newRooms };

    if (current) {
      if (isDelete) {
        await q.run('DELETE FROM it_floors WHERE id = ?', [floorId]);
      } else {
        await q.run('UPDATE it_floors SET name=?, sort_order=?, rooms=?, note=? WHERE id=?', [newName, newSortOrder, JSON.stringify(newRooms), newNote, floorId]);
      }
    } else {
      await q.run(
        "INSERT INTO it_floors (id, name, sort_order, rooms, note, created_at) VALUES (?,?,?,?,?, datetime('now','localtime'))",
        [floorId, newName, newSortOrder, JSON.stringify(newRooms), newNote]
      );
    }

    await writeEvent(q, {
      op_id: newOpId(), asset_id: null, action: 'floor_update', role: 'primary', related_asset_id: null,
      from_state: fromState, to_state: toState, operator_id: operatorId, note: null,
    });

    if (isDelete) return { ok: true };
    const saved = await q.get('SELECT id, name, sort_order, rooms, note, created_at FROM it_floors WHERE id = ?', [floorId]);
    return Object.assign({}, saved, { rooms: JSON.parse(saved.rooms) });
  }

  router.get('/it-assets/floors', authenticateToken, requireLedgerReady, requireLedgerRead, async (req, res) => {
    try {
      const rows = await withRead((q) => q.all('SELECT id, name, sort_order, rooms, note, created_at FROM it_floors ORDER BY sort_order ASC, id ASC'));
      const items = (rows || []).map((r) => Object.assign({}, r, { rooms: JSON.parse(r.rooms) }));
      res.json({ items });
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.put('/it-assets/floors/:id', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    try {
      const result = await withWrite((q) => applyFloorWrite(q, { floorId: req.params.id, body: req.body || {}, isDelete: false, operatorId: req.user.id }));
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  router.delete('/it-assets/floors/:id', authenticateToken, requireLedgerReady, requireAdmin, async (req, res) => {
    try {
      const result = await withWrite((q) => applyFloorWrite(q, { floorId: req.params.id, body: {}, isDelete: true, operatorId: req.user.id }));
      res.json(result);
    } catch (err) {
      handleErr(res, err);
    }
  });

  const recordManagement=require('./record-management')({withRead,withWrite,requireLedgerWrite,handleErr,stripFinance,invariants,parseAssetRow});
  router.use('/it-assets',authenticateToken,requireLedgerReady,requireLedgerRead,recordManagement.router);
  const stocktakes = createStocktakes({ activeClause:recordManagement.activeClause, withRead, withWrite, requireLedgerWrite, stripFinance, rejectFinanceFields, handleErr, invariants, parseAssetRow, toRowForCheck }); router.use('/it-assets/stocktakes', authenticateToken, requireLedgerReady, requireLedgerRead, stocktakes.router); const reconciles = createReconciles({ activeClause:recordManagement.activeClause, withRead, withWrite, requireLedgerWrite, requireAdmin, stripFinance, handleErr, logger, normalizeReconcileKey, validateAmbiguousCandidates, SOURCE_META_KEYS, EXTERNAL_ROW_KEYS, LEDGER_SNAPSHOT_KEYS, AMBIGUOUS_CANDIDATE_KEYS, KEY_RULE_VERSION, RECONCILE_RESULTS, RECONCILE_TRANSITIONS, RECONCILE_AUTO_RESULTS, parseAssetRow, rejectFinanceFields, storageDir: deps.reconcileStorageDir }); router.use('/it-assets/reconciles', authenticateToken, requireLedgerReady, requireLedgerRead, reconciles.router);
  //    Express 会把 'racks'/'floors' 当成 :id 匹配掉（路由按注册顺序逐条尝试）。
  // C1（长任务 E · 巡检台账）：sheets 必须先于 inspections 挂载——router.use 是前缀匹配，
  //   若 inspections（挂在 '/it-assets/inspections'）先注册，'/it-assets/inspections/sheets'
  //   会先落进它的前缀匹配，再被 inspections.js:101 的 GET '/:id' 当成设备巡检编号截走
  //   （方案 §5.2 / codex 33-R M4）。C1 守卫用「GET /inspections/sheets 返回台账列表结构」验证命中。
  // C2：巡检照片存储目录，与 inspections.js 的 inspectionStorageDir 同写法（deps 注入优先，否则
  //   落在 DB 同目录下的 private/it-inspection-sheets/）；同一个变量在上面 runLifecycleInit 的目录
  //   对账里也会用到（后定义、先被那个异步函数引用——同一闭包内合法，见该处注释）。
  const inspectionSheetStorageDir = deps.inspectionSheetStorageDir || require('path').join(require('path').dirname(require('path').resolve(DB_FILE)), 'private', 'it-inspection-sheets');
  // C3：采集器与采集共用模块（inspection-collect.js）在这里只 new 一次，传给 inspectionSheets——
  //   MED-5（C7-c）：原本还单独传一份 collector 给 inspections.js 的 GET /targets 直接用，那条路由
  //   随单独设备巡检整体退役已经删除，inspections.js 不再需要 collector 这个依赖（工厂签名同批收窄，
  //   见该文件头部注释）。
  const inspectionCollector = deps.inspectionCollector || require('./inspection-collector').createCollector(deps.inspectionConfigPath);
  const inspectionCollect = require('./inspection-collect')({ collector: inspectionCollector, recordManagement });
  // C2b/C2f：仅测试可用的注入点——只在 TEST_HOOKS_ENABLED（deps.enableTestHooks===true）时才从
  //   deps.inspectionSheetTestHooks 取，闸未开时恒传 undefined（与 C2c M8 那批 _internals 测试
  //   seam 同一道闸，2026-09-18 裁定：会改写行为的测试接缝只在这个 flag 下生效）；生产装配
  //   （server.js）从不传 enableTestHooks，生产路径 testHooks 恒为 undefined，inspection-sheets.js
  //   内部据此回落到真实实现（见该文件工厂签名处注释）。调用方需要这个注入点时必须显式传
  //   enableTestHooks:true（夹具 it-ledger-browser-fixture.js 透传 options.enableTestHooks）。
  const inspectionSheets = require('./inspection-sheets')({ recordManagement, withRead, withWrite, requireLedgerWrite, handleErr, storageDir: inspectionSheetStorageDir, testHooks: TEST_HOOKS_ENABLED ? deps.inspectionSheetTestHooks : undefined, collect: inspectionCollect, stripFinance, runCleanupDetached });
  // G3A：绑定 runCleanupDetached 内部固定调用的清理函数——只在这里赋值一次，赋值语句本身不在任何
  //   工厂的 deps 参数对象里，inspection-sheets.js 与其路由处理器都拿不到
  //   inspectionSheetsCleanupQueueRef 这个变量（只能拿到已经构造好的 runCleanupDetached 本身）。
  inspectionSheetsCleanupQueueRef = inspectionSheets.processCleanupQueue;
  router.use('/it-assets/inspections/sheets', authenticateToken, requireLedgerReady, requireLedgerRead, inspectionSheets.router);
  // C3：sheetVisibility 直接复用 inspection-sheets.js 导出的那份（服务器详情「归属」展示要用，方案
  //   §2.5 第三条明文"不另写判断"）——inspectionSheets 必须先于这里构造好，已经是既有挂载顺序
  //   （sheets 先于 inspections，方案 §5.2 M4）。
  const inspections = require('./inspections')({ withRead, handleErr, collect: inspectionCollect, sheetVisibility: inspectionSheets.sheetVisibility, stripFinance });
  router.use('/it-assets/inspections', authenticateToken, requireLedgerReady, requireLedgerRead, inspections.router);

  router.get('/it-assets/:id', authenticateToken, requireLedgerReady, requireLedgerRead, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: 'LEDGER_INVALID_ID', message: 'id 必须是正整数' });
    try {
      const isAdmin = req.user.role === 'admin';
      const result = await withRead(async (q) => {
        const row = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
        if (!row) return null;
        const events = await q.all('SELECT * FROM it_asset_events WHERE asset_id = ? ORDER BY id ASC', [id]);
        return { asset: parseAssetRow(row), events: events.map(parseEventRow),record_control:await recordManagement.control(q,id),record_history:await recordManagement.history(q,id) };
      });
      if (!result) return res.status(404).json({ code: 'LEDGER_NOT_FOUND', message: '资产不存在' });
      res.json(stripFinance(result, isAdmin));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ── PUT /api/it-assets/:id（编辑，方案 §5）── 同样排在 racks/floors 之后。
  router.put('/it-assets/:id', authenticateToken, requireLedgerReady, requireLedgerRead, requireLedgerWrite, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ code: 'LEDGER_INVALID_ID', message: 'id 必须是正整数' });
    try {
      const body = req.body || {};
      const isAdmin = req.user.role === 'admin';
      if (body.expected_version === undefined) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'expected_version 必填', field: 'expected_version' });
      if (!Number.isInteger(body.expected_version)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'expected_version 必须是整数', field: 'expected_version' });
      // LOW-3（第4批 Opus 复看）：与动作端点（L3646）同判据，isSafePosInt 排除负数/0/超出
      // 安全整数范围的巨大浮点数。
      if (body.stocktake_item_id !== undefined && body.stocktake_item_id !== null && !invariants.isSafePosInt(body.stocktake_item_id)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'stocktake_item_id 必须是安全正整数', field: 'stocktake_item_id' });
      }
      rejectFinanceFields(body, isAdmin);
      for (const k of UPDATE_REJECT_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(body, k)) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `不允许编辑 ${k}`, field: k });
      }
      const allowed = new Set(UPDATE_ASSET_FIELDS.concat(['expected_version', 'stocktake_item_id']));
      const unknown = Object.keys(body).filter((k) => !allowed.has(k));
      if (unknown.length > 0) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `未知字段: ${unknown.join(',')}`, field: unknown[0] });
      if (Object.prototype.hasOwnProperty.call(body, 'asset_class')) {
        const cc = assertAssetClass(body.asset_class);
        if (!cc.ok) return res.status(400).json({ code: cc.code || 'LEDGER_BAD_REQUEST', message: 'asset_class 非法', field: 'asset_class' });
      }

      // C6：实际编辑先重读校验，写primary事件后同事务绑定；零变化编辑不能绑定无事件的op。
      // 普通未携带stocktake_item_id的零变化编辑仍保持C2的200语义。
      const opId = newOpId();
      const result = await withWrite(async (q) => {
        await q.assertWrite(req.user);
        await recordManagement.assertActive(q,id);
        const current = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
        if (!current) { const e = new Error('资产不存在'); e.status = 404; e.code = 'LEDGER_NOT_FOUND'; throw e; }
        if (current.version !== body.expected_version) { const e = new Error('版本冲突'); e.status = 409; e.code = 'VERSION_CONFLICT'; throw e; }

        if (Object.prototype.hasOwnProperty.call(body, 'expires_at')
          && (current.category === 'software' || current.category === 'subscription')) {
          const e = new Error('software/subscription 不接受 expires_at 编辑（走 renew）'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'expires_at'; throw e;
        }

        // S-H3（Opus 预筛）：编辑白名单字段并入同一套形态闸（name/brand/model/note/
        //   owner_name/owner_dept/fin_amount/fin_vendor/fin_contract_no 曾经零类型校验）。
        const toNormalize = {};
        for (const k of [
          'name', 'brand', 'model', 'note', 'owner_name', 'owner_dept',
          'fin_amount', 'fin_vendor', 'fin_contract_no',
          'sn', 'asset_no', 'attrs', 'expires_at', 'purchased_at', 'slot_count', 'u_height',
        ]) {
          if (Object.prototype.hasOwnProperty.call(body, k)) toNormalize[k] = body[k];
        }
        const normResult = normalizeAssetFields(current.category, toNormalize);
        if (!normResult.ok) { const e = new Error(normResult.message); e.status = normResult.status || 400; e.code = normResult.code || 'LEDGER_BAD_REQUEST'; e.field = normResult.field; throw e; }
        const norm = normResult.values;

        if (norm.slot_count !== undefined) {
          const children = await q.all('SELECT slot_no FROM it_assets WHERE parent_asset_id = ?', [id]);
          const maxSlot = children.length ? Math.max(...children.map((c) => c.slot_no)) : 0;
          if (norm.slot_count < maxSlot) { const e = new Error('slot_count 低于已占用最大 slot_no'); e.status = 409; e.code = 'SLOT_COUNT_BELOW_OCCUPIED'; throw e; }
          if (children.length > 0 && norm.slot_count === 0) { const e = new Error('带随装盘时 slot_count 不得为 0'); e.status = 409; e.code = 'SLOT_COUNT_BELOW_OCCUPIED'; throw e; }
        }
        if (norm.u_height !== undefined && norm.u_height !== current.u_height) {
          if (current.rack_id !== null) {
            const e = new Error('在位时不可改 u_height（须先下架）'); e.status = 409; e.code = 'U_HEIGHT_LOCKED'; throw e;
          }
          if (current.category === 'other') {
            const hasChildren = await q.get('SELECT 1 FROM it_assets WHERE parent_asset_id = ? LIMIT 1', [id]);
            const crossesZero = (current.u_height === 0) !== (norm.u_height === 0);
            if (crossesZero) {
              const okToCross = ['in_depot', 'faulty', 'to_retire'].includes(current.status) && !hasChildren && current.location_text === null;
              if (!okToCross) { const e = new Error('other 跨 0 边界改 u_height 的前置条件不满足'); e.status = 409; e.code = 'U_HEIGHT_LOCKED'; throw e; }
            }
          } else if (current.category !== 'server' && norm.u_height !== 0) {
            const e = new Error('该类别 u_height 必须恒为 0'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; throw e;
          }
        }

        const candidate = Object.assign({}, current);
        for (const f of ['name', 'brand', 'model', 'note', 'owner_name', 'owner_dept']) {
          if (norm[f] !== undefined) candidate[f] = norm[f];
        }
        if (Object.prototype.hasOwnProperty.call(body, 'asset_class')) candidate.asset_class = body.asset_class;
        if (norm.sn !== undefined) candidate.sn = norm.sn;
        if (norm.asset_no !== undefined) candidate.asset_no = norm.asset_no;
        // S-H2（Opus 复看第5批）：编辑改 sn/asset_no 此前完全没有唯一性预查——DB 唯一索引虽然
        //   兜底，但命中时会抛裸 SQLITE_CONSTRAINT，走到业务异常出口只会被判 500，不是给用户看
        //   的 409。事务内预查（排除自身 id），实际变化且非空才查。
        if (candidate.sn !== current.sn && candidate.sn !== null) {
          const dupSn = await q.get('SELECT id FROM it_assets WHERE sn = ? AND id != ?', [candidate.sn, id]);
          if (dupSn) { const e = new Error('SN 重复'); e.status = 409; e.code = 'DUPLICATE_SN'; e.field = 'sn'; throw e; }
        }
        if (candidate.asset_no !== current.asset_no && candidate.asset_no !== null) {
          const dupAssetNo = await q.get('SELECT id FROM it_assets WHERE asset_no = ? AND id != ?', [candidate.asset_no, id]);
          if (dupAssetNo) { const e = new Error('asset_no 重复'); e.status = 409; e.code = 'DUPLICATE_ASSET_NO'; e.field = 'asset_no'; throw e; }
        }
        if (norm.purchased_at !== undefined) candidate.purchased_at = norm.purchased_at;
        if (norm.expires_at !== undefined) candidate.expires_at = norm.expires_at;
        if (norm.slot_count !== undefined) candidate.slot_count = norm.slot_count;
        if (norm.u_height !== undefined) candidate.u_height = norm.u_height;
        // S-M4（Opus 预筛）：finChanged 曾经把"请求体带了这个键"当成"改动了"，同值重复提交也会
        //   被记进事件、递增 version——改成真 diff，只有值真的变化才计入。
        const finChanged = [];
        if (isAdmin) {
          for (const f of ['fin_amount', 'fin_vendor', 'fin_contract_no']) {
            if (norm[f] !== undefined) {
              const oldV = current[f] === undefined ? null : current[f];
              const newV = norm[f] === undefined ? null : norm[f];
              candidate[f] = newV;
              if (oldV !== newV) finChanged.push(f);
            }
          }
        }

        const currentAttrsParsed = JSON.parse(current.attrs);
        const candidateAttrs = norm.attrs !== undefined ? norm.attrs : currentAttrsParsed;

        const ctx = {};
        // C3 首件（validateRowSchema）要求「完整行」——candidate 已经是 current 的完整列拷贝
        // （Object.assign({}, current) + 各字段覆盖，见上方），除 attrs/pos 两列仍是 DB 里的 JSON
        // 字符串外其余列已就绪，这里只需再补这两列的已解析对象形态、并保持位置族字段仍取
        // current（编辑端点不改位置/状态，UPDATE_REJECT_FIELDS 已拒绝）。
        const rowForCheck = Object.assign({}, candidate, {
          status: current.status,
          rack_id: current.rack_id,
          u_start: current.u_start,
          location_text: current.location_text,
          floor_id: current.floor_id,
          room_id: current.room_id,
          pos: current.pos ? JSON.parse(current.pos) : null,
          parent_asset_id: current.parent_asset_id,
          slot_no: current.slot_no,
          custodian_user_id: current.custodian_user_id,
          custodian_name: current.custodian_name,
          attrs: candidateAttrs,
        });
        // S-H1（Opus 预筛）：row 形态要求某个引用存在时，查不到不再是"跳过设置 ctx（等于让
        //   invariants 侧静默放行）"，而是显式拒绝；凡是形态要求的 ctx 分支，永远显式赋值
        //   （哪怕是空对象/空数组）。
        // Opus 复看第3条（MED）：这三处查不到的语义是"数据不一致"，不是"用户输入错误"——机柜
        //   删除受 RACK_NOT_EMPTY 保护（非空不可删）、楼层删除受引用完整性保护（被 AP 引用不可
        //   删），正常业务路径走不到"current.rack_id/floor_id 指向一个已经不存在的行"这一步；
        //   真出现只可能是数据已经损坏。此前误用 409+LEDGER_BAD_REQUEST（业务冲突/请求形态错的
        //   混合码），与 S-H2 刚消灭的"码状态错配"同款复发，统一改回 500+LEDGER_INTERNAL，与
        //   invariants.js 的 ctxMissing/脏区间处置同源（同一种"不该发生，发生了就是内部错误"
        //   的语义）。
        if (current.rack_id !== null) {
          const rack = await q.get('SELECT u_total FROM it_racks WHERE id = ?', [current.rack_id]);
          if (!rack) { const e = new Error('机柜引用不存在(数据不一致)'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e; }
          const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [current.rack_id]);
          ctx.rack = { u_total: rack.u_total };
          ctx.occupiedIntervals = buildOccupiedIntervals(occ);
        }
        if (current.category === 'disk' && current.parent_asset_id !== null) {
          const parent = await q.get('SELECT slot_count, status, category FROM it_assets WHERE id = ?', [current.parent_asset_id]);
          if (!parent) { const e = new Error('宿主引用不存在(数据不一致)'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e; }
          ctx.parent = parent;
        }
        if (current.category === 'ap' && current.floor_id !== null) {
          const floor = await q.get('SELECT rooms FROM it_floors WHERE id = ?', [current.floor_id]);
          if (!floor) { const e = new Error('楼层引用不存在(数据不一致)'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e; }
          ctx.floor = { rooms: JSON.parse(floor.rooms) };
        }
        // SLOT_COUNT_FLOOR 规则对宿主资格资产（含 slot_count=0 的 server/机柜 other）恒要求
        // ctx.childDisks 是数组——不能只在 slot_count>0 时才传，否则 slot_count=0 的宿主资格
        // 资产在编辑时会撞 ctx 缺失的 fail-closed 500。S-H1（Opus 复看第5批）：新增
        // HOST_DISK_STATUS_SYNC 规则要求每个元素带 status，SELECT 列同步补上。
        if (invariants.isHostEligible(rowForCheck)) {
          ctx.childDisks = await q.all('SELECT slot_no, status FROM it_assets WHERE parent_asset_id = ?', [id]);
        }

        const violation = validateAssetInvariants(rowForCheck, ctx);
        if (violation) {
          const e = new Error(violation.message); e.status = violation.status || 400; e.code = violation.code || 'LEDGER_BAD_REQUEST'; e.field = violation.field; throw e;
        }

        const fromPrimary = {}; const diffPrimary = {};
        const simpleDiffs = [
          ['name', current.name, candidate.name], ['brand', current.brand, candidate.brand],
          ['model', current.model, candidate.model], ['sn', current.sn, candidate.sn],
          ['asset_no', current.asset_no, candidate.asset_no], ['purchased_at', current.purchased_at, candidate.purchased_at],
          ['note', current.note, candidate.note], ['expires_at', current.expires_at, candidate.expires_at],
          ['slot_count', current.slot_count, candidate.slot_count], ['u_height', current.u_height, candidate.u_height],
          ['owner_name', current.owner_name, candidate.owner_name], ['owner_dept', current.owner_dept, candidate.owner_dept],
          ['asset_class', current.asset_class, candidate.asset_class],
        ];
        for (const [key, oldV, newV] of simpleDiffs) {
          const oldNorm = oldV === undefined ? null : oldV; const newNorm = newV === undefined ? null : newV;
          if (oldNorm !== newNorm) { fromPrimary[key] = oldNorm; diffPrimary[key] = newNorm; }
        }
        const attrsChanged = stableStringify(currentAttrsParsed) !== stableStringify(candidateAttrs);
        if (attrsChanged) { fromPrimary.attrs = currentAttrsParsed; diffPrimary.attrs = candidateAttrs; }

        const hasChange = Object.keys(diffPrimary).length > 0 || finChanged.length > 0;
        if (!hasChange) {
          await stocktakes.bind(q, id, body.stocktake_item_id, opId); const finalRowNoChange = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
          return { row: parseAssetRow(finalRowNoChange), changed: false };
        }
        if (finChanged.length > 0) diffPrimary.fin_changed = finChanged;

        const setClauses = []; const params = [];
        const colMap = {
          name: 'name', brand: 'brand', model: 'model', sn: 'sn', asset_no: 'asset_no', purchased_at: 'purchased_at',
          note: 'note', expires_at: 'expires_at', slot_count: 'slot_count', u_height: 'u_height',
          owner_name: 'owner_name', owner_dept: 'owner_dept', asset_class: 'asset_class',
        };
        for (const key of Object.keys(diffPrimary)) {
          if (key === 'fin_changed') continue;
          if (key === 'attrs') { setClauses.push('attrs = ?'); params.push(JSON.stringify(candidateAttrs)); continue; }
          setClauses.push(`${colMap[key]} = ?`); params.push(diffPrimary[key]);
        }
        for (const f of finChanged) { setClauses.push(`${f} = ?`); params.push(candidate[f]); }
        setClauses.push('version = version + 1');
        setClauses.push("updated_at = datetime('now','localtime')");
        params.push(id);
        await q.run(`UPDATE it_assets SET ${setClauses.join(', ')} WHERE id = ?`, params);
        await stocktakes.validateWrittenAsset(q, id);
        await writeEvent(q, {
          op_id: opId, asset_id: id, action: 'update', role: 'primary', related_asset_id: null,
          from_state: fromPrimary, to_state: diffPrimary, operator_id: req.user.id, note: null,
        });

        await stocktakes.bind(q, id, body.stocktake_item_id, opId); const finalRow = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
        return { row: parseAssetRow(finalRow), changed: true };
      });

      res.status(200).json(stripFinance(result.row, isAdmin));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ============================================================
  // C3：机柜动作族——通用协议骨架 + 六个动作
  //   rack_in / rack_out / rack_move / rack_relocate / mark_status / retire
  //   方案 §4 矩阵逐字（切片第83-107行）；执行 spec §2/§3/§4/§5。
  //   C4 四个 disk_* 动作在工厂尾部登记；C5 九个单资产动作由独立模块登记，
  //   仅复用 C1–C3 底座，可在撤销 C4 后保留；不在动作表的名字返回 UNKNOWN_ACTION。
  //   C4 对端协议仍按 #18–#24；C5 按 #26–#29，不依赖 disk_* 助手。
  // ============================================================

  // ACTION_ERROR_CODES（spec §5）：方案 §4 矩阵未给出错误码字面量，本 commit 新起六个动作专用
  //   码——回报里列为"方案未定义，本 commit 新增，待追认 #14"，闭集导出供守卫对拍。
  const ACTION_ERROR_CODES = new Set([
    'UNKNOWN_ACTION', 'ACTION_NOT_APPLICABLE', 'ACTION_NOT_ALLOWED_IN_STATUS',
    'NO_OP_TRANSITION', 'MOUNTED_DISK_ACTION_FORBIDDEN', 'RETIRE_BLOCKED_BY_DISKS',
  ]);
  for (const code of ACTION_ERROR_CODES) WRITE_ERROR_CODES.add(code);

  // toRowForCheck：DB 行（attrs/pos 是 JSON 字符串）→ validateAssetInvariants 需要的完整行
  //   （attrs/pos 已解析为对象），叠加本次动作产生的目标态覆盖字段。不得往返回对象上挂额外
  //   键（会被 validateRowSchema 的"完整行契约"判 500 未声明列）。
  function toRowForCheck(dbRow, overrides) {
    // LOW-1（第7批 Opus 复看）：attrs 的 JSON.parse 复用 parseAssetRow 同款 try/catch+形状校验
    // 范式——库内存量脏 attrs（解析失败，或解析出来不是普通对象）必须 fail-closed 成 500
    // LEDGER_INTERNAL（field='attrs'），不能让裸 JSON.parse 抛出未分类的 SyntaxError 一路
    // 冒泡到 withWrite 的兜底分支，也不能让一个解析成功但形状不对的值（比如字符串/数组）
    // 悄悄当 attrs 对象往下传。
    let attrs;
    if (typeof dbRow.attrs === 'string') {
      try {
        attrs = JSON.parse(dbRow.attrs);
      } catch (e) {
        const err = new Error(`资产 attrs 列 JSON 解析失败(id=${dbRow.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; err.field = 'attrs'; throw err;
      }
      if (!isPlainObjectShape(attrs)) {
        const err = new Error(`资产 attrs 列解析结果形状非法(id=${dbRow.id})`); err.status = 500; err.code = 'LEDGER_INTERNAL'; err.field = 'attrs'; throw err;
      }
    } else {
      attrs = dbRow.attrs;
    }
    return Object.assign({}, dbRow, {
      attrs,
      pos: dbRow.pos ? JSON.parse(dbRow.pos) : null,
    }, overrides || {});
  }

  // LOW-4（第4批 Opus 复看）：H1 重写让四个动作各自在 UPDATE 之后重读同一行——理论上不可能
  //   查不到（同一事务内刚 UPDATE 过的行），但"理论上不可能"不等于"代码里不用防"，显式判空
  //   fail-closed 成 500，而不是让下游 toRowForCheck(undefined,...) 抛出未分类的裸 TypeError。
  function assertRereadFound(row, id) {
    if (!row) { const e = new Error(`重读资产行失败(id=${id})，数据不一致`); e.status = 500; e.code = 'LEDGER_INTERNAL'; e.field = 'id'; throw e; }
    return row;
  }

  // assertUFitsInRack（RS-M1，第8批）：参数校验阶段就用"不溢出"的比较提前拦住越顶请求——
  //   不等 UPDATE 落库、`buildOccupiedIntervals` 算出 `u_start+u_height-1` 才发现。这不只是
  //   "提前拒绝"的效率优化：u_start 允许到 Number.MAX_SAFE_INTEGER（isSafePosInt 唯一的域约束），
  //   若真传这么大的值，写后重读阶段 `buildOccupiedIntervals` 会把这条刚写入、状态已是
  //   in_service 的自身行也纳入 occ 查询结果，`r.u_start + r.u_height - 1` 这一步在 u_height≥2
  //   时会超出 Number.MAX_SAFE_INTEGER（精度丢失），下游 NUMERIC_DOMAIN/ROW_SCHEMA 对
  //   occupiedIntervals 元素的 isSafePosInt 校验会判"形态非法"而不是"越顶"，最终吐出 500
  //   LEDGER_INTERNAL 而不是本该给用户看的 409 U_INTERVAL_OUT_OF_RANGE——用户输入错误被误判成
  //   内部错误。两条比较都改写成不做"两个可能很大的数相加"的形式：`u_start > u_total` 直接比较
  //   两个已知在安全整数范围内的数；`u_height > u_total - u_start + 1`（u_start ≤ u_total 已经
  //   由第一条保证，`u_total - u_start` 不会是很大的正数，+1 后仍在安全范围内）。
  // LOW-1（第9批 Opus 复看）：第4参 field 三处调用点从未传入（恒 'u_start'），删掉这个死形参，
  // 两处 throw 直接写字面量 'u_start'。
  function assertUFitsInRack(uStart, uHeight, uTotal) {
    if (uStart > uTotal) {
      const e = new Error('u_start 超出机柜总U数'); e.status = 409; e.code = 'U_INTERVAL_OUT_OF_RANGE'; e.field = 'u_start'; throw e;
    }
    if (uHeight > uTotal - uStart + 1) {
      const e = new Error('区间超出机柜总U数'); e.status = 409; e.code = 'U_INTERVAL_OUT_OF_RANGE'; e.field = 'u_start'; throw e;
    }
  }

  async function loadChildren(q, hostId) {
    return q.all('SELECT * FROM it_assets WHERE parent_asset_id = ?', [hostId]);
  }

  function throwViolation(v, fallbackStatus, fallbackCode) {
    const e = new Error(v.message);
    e.status = v.status || fallbackStatus || 400;
    e.code = v.code || fallbackCode || 'LEDGER_BAD_REQUEST';
    e.field = v.field;
    throw e;
  }

  async function loadAndCheckPrimary(q, req, id, body) {
    await q.assertWrite(req.user);
    await recordManagement.assertActive(q,id);
    const primary = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
    if (!primary) { const e = new Error('资产不存在'); e.status = 404; e.code = 'LEDGER_NOT_FOUND'; throw e; }
    if (primary.version !== body.expected_version) {
      const e = new Error('版本冲突'); e.status = 409; e.code = 'VERSION_CONFLICT'; throw e;
    }
    return primary;
  }

  function assertEligible(cond, action) {
    if (!cond) { const e = new Error(`资产不适用动作 ${action}`); e.status = 400; e.code = 'ACTION_NOT_APPLICABLE'; e.field = 'action'; throw e; }
  }

  function assertStatusIn(actual, allowedList, action) {
    if (!allowedList.includes(actual)) {
      const e = new Error(`当前状态(${actual})不允许动作 ${action}`);
      e.status = 409; e.code = 'ACTION_NOT_ALLOWED_IN_STATUS'; e.detail = { current_status: actual }; throw e;
    }
  }

  // finishHostSyncedAction：rack_in/rack_out/mark_status 共用尾段（方案 §3.3 第1条"所有随装盘
  //   在同一事务内同步到宿主的新 status，各写一行 affected 事件"）。
  // H1（主会话第3批裁定，结构性重写）：**校验落库结果，不校验意图**——原实现先在内存里拼出
  //   "目标行"（primaryTarget/childTarget，含人为覆写的 status 字段）校验通过后才写库，校验的
  //   对象和实际写库的对象不是同一份数据，子盘 ctx/target 恒用 primaryTarget.status 覆盖真实
  //   status，导致 HOST_DISK_STATUS_SYNC/HOST_SLOT 的状态同步分支永远重言式通过、子盘其余
  //   字段（u_height/slot_no/parent_asset_id 等）从未被真实校验过。现在改为：先把主行与全部
  //   子盘的 UPDATE 落到事务里 → SELECT 重读主行与全部子盘的真实行 → 用重读到的真实数据跑
  //   validateAssetInvariants → 违反则 throw（withWrite 捕获后 ROLLBACK，等价"这次写从未发生
  //   过"）→ 只有校验通过才写 writeEvent（primary + 每个子盘 affected）。
  //   M7：不再用 isHostEligible(primary) 门槛决定要不要查子盘——恒查（loadChildren 对非宿主
  //   资格类别自然返回空数组，代价可忽略），ctx.childDisks 恒显式传数组。
  // LOW-5（第4批 Opus 复看）：rackInfo（{rackId, uTotal} | null）——rack 是否存在 + u_total
  //   仍在调用方（runRackIn）UPDATE 之前查一次（那是输入校验，机柜不存在要 400，不能等写完
  //   再发现），但 occupiedIntervals（在位设备占用区间）改到 UPDATE **之后**在本函数内重新
  //   查询，与 rack_move/rack_relocate 的"写后重读再算"保持统一，不再用写之前的旧占用快照。
  async function finishHostSyncedAction(q, req, action, opId, primary, targetStatus, primarySql, rackInfo, note) {
    await q.run(primarySql.sql, primarySql.params);
    const children = await loadChildren(q, primary.id);
    for (const child of children) {
      await q.run("UPDATE it_assets SET status = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [targetStatus, child.id]);
    }

    const rereadPrimary = assertRereadFound(await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.id]), primary.id);
    // LOW-4（第9批 Opus 复看）：children.length===0 时短路成 []，不真的去查 rereadChildren——
    //   这意味着下面这条比较对"0→N"这个方向是不可达的（若 children 为空数组，rereadChildren
    //   恒被赋值为 []，不管重读会查到什么，两边永远相等）；比较实质只对"N→更少/更多"敏感，
    //   即已知有子盘时集合是否变化。这不是漏洞：本模块全程持 itTxnMutex 恒串行，同一事务内
    //   两次查询之间不存在别的写操作能把 parent_asset_id 从"无主"改成"有主"，0→N 这条路径在
    //   当前架构下本就不可达，短路只是省一次空查询，不改变可检测到的故障面。
    const rereadChildren = children.length > 0 ? await q.all('SELECT * FROM it_assets WHERE parent_asset_id = ?', [primary.id]) : [];

    // RS-L1（第8批）：children（UPDATE 前查到、决定"要同步谁"）与 rereadChildren（UPDATE 后
    //   重读）的 id 集合必须全等——同一个事务里，两次查询之间没有任何其它写操作能改变
    //   parent_asset_id 归属（本模块恒串行，不存在别的事务插入/移出子盘的窗口），若不等说明
    //   出现了未预期的并发/逻辑错误，fail-closed 成 500 并让事务回滚，不能带着"我以为同步了
    //   N 个子盘，实际数据库里变成另一批"的不一致状态继续往下走。
    const childrenIds = children.map((c) => c.id).sort((a, b) => a - b);
    const rereadChildrenIds = rereadChildren.map((c) => c.id).sort((a, b) => a - b);
    if (JSON.stringify(childrenIds) !== JSON.stringify(rereadChildrenIds)) {
      const e = new Error(`子盘集合在同一事务内发生变化(before=${JSON.stringify(childrenIds)} after=${JSON.stringify(rereadChildrenIds)})`);
      e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e;
    }

    let rackCtxExtra = {};
    if (rackInfo) {
      const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [rackInfo.rackId]);
      rackCtxExtra = { rack: { u_total: rackInfo.uTotal }, occupiedIntervals: buildOccupiedIntervals(occ) };
    }
    const primaryRow = toRowForCheck(rereadPrimary, {});
    const ctxPrimary = Object.assign(
      { childDisks: rereadChildren.map((c) => ({ slot_no: c.slot_no, status: c.status })) },
      rackCtxExtra
    );
    const violation = validateAssetInvariants(primaryRow, ctxPrimary);
    if (violation) throwViolation(violation);

    const ctxChild = { parent: { slot_count: primaryRow.slot_count, status: primaryRow.status, category: primaryRow.category } };
    for (const child of rereadChildren) {
      const childRow = toRowForCheck(child, {});
      const cv = validateAssetInvariants(childRow, ctxChild);
      // LOW-1（第4批 Opus 复看）：validateAssetInvariants 的违反对象恒自带 status/code（RULES
      // 每条分支都显式写了这两个字段，ROW_SCHEMA 同理），throwViolation 的 fallback 参数在
      // 这条调用点上从未被用到——删掉两个死 fallback，沿用违反对象自带状态码。
      if (cv) throwViolation(cv);
    }

    await writeEvent(q, {
      op_id: opId, asset_id: primary.id, action, role: 'primary', related_asset_id: null,
      from_state: primarySql.fromState, to_state: primarySql.toState, operator_id: req.user.id, note: note || null,
    });

    const affectedIds = [];
    for (const child of children) {
      await writeEvent(q, {
        op_id: opId, asset_id: child.id, action, role: 'affected', related_asset_id: primary.id,
        from_state: { status: child.status }, to_state: { status: targetStatus },
        operator_id: req.user.id, note: note || null,
      });
      affectedIds.push(child.id);
    }

    return { primary: parseAssetRow(rereadPrimary), affectedIds };
  }

  // ── rack_in（方案 §4 L312 逐字）──────────────────────────────────────────────
  async function runRackIn(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.isRackEligible(primary), 'rack_in');
    assertStatusIn(primary.status, ['in_depot'], 'rack_in');
    const rackId = body.rack_id;
    const uStart = body.u_start;
    if (!invariants.isSafePosInt(rackId)) {
      const e = new Error('rack_id 必须是正整数'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'rack_id'; throw e;
    }
    if (!invariants.isSafePosInt(uStart)) {
      const e = new Error('u_start 必须是安全整数且 ≥1'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'u_start'; throw e;
    }
    const rack = await q.get('SELECT id, u_total FROM it_racks WHERE id = ?', [rackId]);
    if (!rack) { const e = new Error('机柜不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'rack_id'; throw e; }
    assertUFitsInRack(uStart, primary.u_height, rack.u_total);
    // LOW-5：occupiedIntervals 不在这里查——finishHostSyncedAction 会在 UPDATE 之后重新查询
    // （与 rack_move/rack_relocate 统一）。

    const primarySql = {
      sql: "UPDATE it_assets SET status = 'in_service', rack_id = ?, u_start = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      params: [rackId, uStart, primary.id],
      fromState: { status: primary.status, rack_id: primary.rack_id, u_start: primary.u_start },
      toState: { status: 'in_service', rack_id: rackId, u_start: uStart },
    };
    return finishHostSyncedAction(q, req, 'rack_in', opId, primary, 'in_service', primarySql, { rackId, uTotal: rack.u_total }, body.note);
  }

  // ── rack_out（方案 §4 L315 逐字，含库房三选去向）──────────────────────────────
  async function runRackOut(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.isRackEligible(primary), 'rack_out');
    assertStatusIn(primary.status, ['in_service'], 'rack_out');
    const to = body.to === undefined ? 'in_depot' : body.to;
    if (!invariants.DEPOT_STATUSES.includes(to)) {
      const e = new Error(`to 必须 ∈ {${invariants.DEPOT_STATUSES.join(',')}}`); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'to'; throw e;
    }
    const primarySql = {
      sql: "UPDATE it_assets SET status = ?, rack_id = NULL, u_start = NULL, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      params: [to, primary.id],
      fromState: { status: primary.status, rack_id: primary.rack_id, u_start: primary.u_start },
      toState: { status: to, rack_id: null, u_start: null },
    };
    return finishHostSyncedAction(q, req, 'rack_out', opId, primary, to, primarySql, null, body.note);
  }

  // ── mark_status（方案 §4 L329 逐字，随装盘除外）───────────────────────────────
  async function runMarkStatus(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.HARDWARE_CATEGORIES.includes(primary.category), 'mark_status');
    if (primary.category === 'disk' && primary.parent_asset_id !== null) {
      const e = new Error('随装盘不得独立改库房栏，请先 disk_unmount'); e.status = 409; e.code = 'MOUNTED_DISK_ACTION_FORBIDDEN'; throw e;
    }
    assertStatusIn(primary.status, invariants.DEPOT_STATUSES, 'mark_status');
    const status = body.status;
    if (!invariants.DEPOT_STATUSES.includes(status)) {
      const e = new Error(`status 必须 ∈ {${invariants.DEPOT_STATUSES.join(',')}}`); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'status'; throw e;
    }
    if (status === primary.status) {
      const e = new Error('目标状态与当前状态相同'); e.status = 409; e.code = 'NO_OP_TRANSITION'; throw e;
    }
    const primarySql = {
      sql: "UPDATE it_assets SET status = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      params: [status, primary.id],
      fromState: { status: primary.status },
      toState: { status },
    };
    return finishHostSyncedAction(q, req, 'mark_status', opId, primary, status, primarySql, null, body.note);
  }

  // ── rack_move（方案 §4 L318 逐字，受影响：无）─────────────────────────────────
  async function runRackMove(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.isRackEligible(primary), 'rack_move');
    assertStatusIn(primary.status, ['in_service'], 'rack_move');
    const rackId = body.rack_id;
    const uStart = body.u_start;
    if (!invariants.isSafePosInt(rackId)) {
      const e = new Error('rack_id 必须是正整数'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'rack_id'; throw e;
    }
    if (rackId === primary.rack_id) {
      const e = new Error('目标机柜与当前机柜相同'); e.status = 409; e.code = 'NO_OP_TRANSITION'; throw e;
    }
    if (!invariants.isSafePosInt(uStart)) {
      const e = new Error('u_start 必须是安全整数且 ≥1'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'u_start'; throw e;
    }
    const rack = await q.get('SELECT id, u_total FROM it_racks WHERE id = ?', [rackId]);
    if (!rack) { const e = new Error('机柜不存在'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'rack_id'; throw e; }
    assertUFitsInRack(uStart, primary.u_height, rack.u_total);

    // H1（主会话第3批裁定）：先写后重读再校验，统一原则——校验落库结果，不校验意图。
    await q.run(
      "UPDATE it_assets SET rack_id = ?, u_start = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      [rackId, uStart, primary.id]
    );
    const reread = assertRereadFound(await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.id]), primary.id);
    // 受影响：无（矩阵）——不逐子盘校验/不写事件，但 SLOT_COUNT_FLOOR/HOST_DISK_STATUS_SYNC
    // 仍要求 ctx.childDisks（M7：恒查，不再用 isHostEligible 门槛）。
    const children = await loadChildren(q, primary.id);
    const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [rackId]);
    const rackCtx = { rack: { u_total: rack.u_total }, occupiedIntervals: buildOccupiedIntervals(occ) };
    const ctxPrimary = Object.assign({ childDisks: children.map((c) => ({ slot_no: c.slot_no, status: c.status })) }, rackCtx);
    const violation = validateAssetInvariants(toRowForCheck(reread, {}), ctxPrimary);
    if (violation) throwViolation(violation);

    await writeEvent(q, {
      op_id: opId, asset_id: primary.id, action: 'rack_move', role: 'primary', related_asset_id: null,
      from_state: { rack_id: primary.rack_id, u_start: primary.u_start },
      to_state: { rack_id: rackId, u_start: uStart },
      operator_id: req.user.id, note: body.note || null,
    });
    return { primary: parseAssetRow(reread), affectedIds: [] };
  }

  // ── rack_relocate（方案 §4 L321 逐字，同柜移位，排除自身）─────────────────────
  async function runRackRelocate(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.isRackEligible(primary), 'rack_relocate');
    assertStatusIn(primary.status, ['in_service'], 'rack_relocate');
    const uStart = body.u_start;
    if (!invariants.isSafePosInt(uStart)) {
      const e = new Error('u_start 必须是安全整数且 ≥1'); e.status = 400; e.code = 'LEDGER_BAD_REQUEST'; e.field = 'u_start'; throw e;
    }
    if (uStart === primary.u_start) {
      const e = new Error('新 u_start 与当前相同'); e.status = 409; e.code = 'NO_OP_TRANSITION'; throw e;
    }
    // 当前机柜引用理应存在（S-H2 同款先例：查不到=数据不一致，500 非 400）。
    const rack = await q.get('SELECT id, u_total FROM it_racks WHERE id = ?', [primary.rack_id]);
    if (!rack) { const e = new Error('机柜引用不存在(数据不一致)'); e.status = 500; e.code = 'LEDGER_INTERNAL'; throw e; }
    assertUFitsInRack(uStart, primary.u_height, rack.u_total);
    // H1（主会话第3批裁定）：先写后重读再校验。
    await q.run(
      "UPDATE it_assets SET u_start = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      [uStart, primary.id]
    );
    const reread = assertRereadFound(await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.id]), primary.id);
    const children = await loadChildren(q, primary.id); // M7：恒查。
    const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [primary.rack_id]);
    const rackCtx = { rack: { u_total: rack.u_total }, occupiedIntervals: buildOccupiedIntervals(occ) };
    const ctxPrimary = Object.assign({ childDisks: children.map((c) => ({ slot_no: c.slot_no, status: c.status })) }, rackCtx);
    const violation = validateAssetInvariants(toRowForCheck(reread, {}), ctxPrimary);
    if (violation) throwViolation(violation);

    await writeEvent(q, {
      op_id: opId, asset_id: primary.id, action: 'rack_relocate', role: 'primary', related_asset_id: null,
      from_state: { u_start: primary.u_start }, to_state: { u_start: uStart },
      operator_id: req.user.id, note: body.note || null,
    });
    return { primary: parseAssetRow(reread), affectedIds: [] };
  }

  // ── retire（方案 §4 L330 逐字，随装盘/带随装盘的宿主除外）─────────────────────
  async function runRetire(q, req, id, body, opId) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(invariants.HARDWARE_CATEGORIES.includes(primary.category), 'retire');
    if (primary.category === 'disk' && primary.parent_asset_id !== null) {
      const e = new Error('随装盘不得独立报废，请先 disk_unmount'); e.status = 409; e.code = 'MOUNTED_DISK_ACTION_FORBIDDEN'; throw e;
    }
    assertStatusIn(primary.status, ['to_retire'], 'retire');
    // M7：COUNT(*) 恒查（不再用 isHostEligible 门槛）——disk/laptop 等结构上不可能有子盘的类别
    // 查出来恒为 0，代价可忽略。
    const cnt = await q.get('SELECT COUNT(*) AS c FROM it_assets WHERE parent_asset_id = ?', [primary.id]);
    if (cnt && cnt.c > 0) {
      const e = new Error('宿主存在随装盘，禁止报废，请先逐盘拆出'); e.status = 409; e.code = 'RETIRE_BLOCKED_BY_DISKS'; throw e;
    }

    // H1（主会话第3批裁定）：先写后重读再校验。
    await q.run(
      "UPDATE it_assets SET status = 'retired', version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?",
      [primary.id]
    );
    const reread = assertRereadFound(await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.id]), primary.id);
    // 走到这里已证明无随装盘（count=0）；ctx.childDisks 恒显式传空数组（M7：SLOT_COUNT_FLOOR/
    // HOST_DISK_STATUS_SYNC 的 fail-closed 契约，不再按 isHostEligible 门槛决定要不要传）。
    const violation = validateAssetInvariants(toRowForCheck(reread, {}), { childDisks: [] });
    if (violation) throwViolation(violation);

    await writeEvent(q, {
      op_id: opId, asset_id: primary.id, action: 'retire', role: 'primary', related_asset_id: null,
      from_state: { status: primary.status }, to_state: { status: 'retired' },
      operator_id: req.user.id, note: body.note || null,
    });
    return { primary: parseAssetRow(reread), affectedIds: [] };
  }

  // S-L2（第5批，主会话裁定，spec §2 结构说明·不改代码只加注）：本通用路由只做协议层
  //   （id/action 合法性、expected_version/stocktake_item_id/note/peer_versions 形态、财务字段
  //   隔离、未知顶层字段拒绝）；每个 handler（runRackIn/runRackOut/...）各自是事务体，在
  //   withWrite 回调内完成"读主行→前置判定→写→重读→校验→写事件"。rack_in/rack_out/
  //   mark_status 三个"联动子盘"动作共享 finishHostSyncedAction 尾段（H1 重写：写后重读再
  //   校验）；rack_move/rack_relocate/retire 无联动，各自内联同款"写后重读再校验"骨架。
  //   C4/C5/C6 接线：新动作只需在 ACTION_HANDLERS 上新增一项 `{paramKeys, run}`，run 函数自己
  //   决定是否复用 finishHostSyncedAction（仅适用于"主资产变宿主状态、子盘同步"这一种形状；
  //   C4 的装/拆/换/移盘是相反方向——子盘是主资产、宿主是受影响资产——不适用，需要新写骨架）。
  // S-M1（第5批）：ACTION_HANDLERS 改用 Object.create(null) 承载——普通对象字面量的原型链上有
  //   `constructor`/`toString`/`__proto__` 等继承属性，`ACTION_HANDLERS[action]` 用这些名字
  //   做键查找会读到继承来的函数/访问器而不是 undefined，被误判成"存在的动作"。改用无原型对象
  //   + `Object.hasOwn` 精确判断"自身是否有这个键"，从查找机制上排除原型链干扰。
  const ACTION_HANDLERS = Object.assign(Object.create(null), {
    rack_in: { paramKeys: ['rack_id', 'u_start'], run: runRackIn },
    rack_out: { paramKeys: ['to'], run: runRackOut },
    rack_move: { paramKeys: ['rack_id', 'u_start'], run: runRackMove },
    rack_relocate: { paramKeys: ['u_start'], run: runRackRelocate },
    mark_status: { paramKeys: ['status'], run: runMarkStatus },
    retire: { paramKeys: [], run: runRetire },
  });
  installSingleAssetActions({ ACTION_HANDLERS, PAYLOAD_KEYS, invariants, loadAndCheckPrimary, assertEligible, assertStatusIn, throwViolation, toRowForCheck, parseAssetRow, writeEvent });
  // ── POST /api/it-assets/:id/actions/:action（通用协议，方案 §4 通用协议段 + spec §2）──────
  router.post('/it-assets/:id/actions/:action', authenticateToken, requireLedgerReady, requireLedgerRead, requireLedgerWrite, async (req, res) => {
    const id = Number(req.params.id);
    if (!invariants.isSafePosInt(id)) return res.status(400).json({ code: 'LEDGER_INVALID_ID', message: 'id 必须是正整数' });
    const action = req.params.action;
    // LOW-3（第7批 Opus 复看）：Object.hasOwn 是 ES2022（Node 16.9+）——生产 Node 版本未核实，
    // 改用 Object.prototype.hasOwnProperty.call 这个自古就有的等价写法，去掉版本依赖。
    const handlerDef = Object.prototype.hasOwnProperty.call(ACTION_HANDLERS, action) ? ACTION_HANDLERS[action] : undefined;
    if (!handlerDef) return res.status(400).json({ code: 'UNKNOWN_ACTION', message: `未知或未实现的动作: ${action}`, field: 'action' });
    try {
      const body = req.body || {};
      const isAdmin = req.user.role === 'admin';
      // M9（主会话第3批裁定）：expected_version/stocktake_item_id 改用 invariants.isSafePosInt
      //   （与其它动作参数的数值域判据同源，不用裸 Number.isInteger——排除负数/0/超出安全整数
      //   范围的巨大浮点数）。
      if (body.expected_version === undefined || !invariants.isSafePosInt(body.expected_version)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'expected_version 必填且为安全正整数', field: 'expected_version' });
      }
      if (body.stocktake_item_id !== undefined && body.stocktake_item_id !== null && !invariants.isSafePosInt(body.stocktake_item_id)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'stocktake_item_id 必须是安全正整数', field: 'stocktake_item_id' });
      }
      if (body.note !== undefined && body.note !== null && (typeof body.note !== 'string' || body.note.length > 500)) {
        return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: 'note 必须是 ≤500 字符的字符串', field: 'note' });
      }
      // C4 四动作要求 peer_versions；其余已实现动作仍须缺省或空对象（用户 #19/#22）。
      if (handlerDef.peerRequired) assertDiskPeerShape(body.peer_versions);
      if (!handlerDef.peerRequired && body.peer_versions !== undefined) {
        const pv = body.peer_versions;
        const isEmptyObj = pv !== null && typeof pv === 'object' && !Array.isArray(pv) && Object.keys(pv).length === 0;
        if (!isEmptyObj) {
          return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: '此动作的 peer_versions 必须缺省或为空对象', field: 'peer_versions' });
        }
      }
      rejectFinanceFields(body, isAdmin);
      const allowedTop = new Set(['expected_version', 'stocktake_item_id', 'note', 'peer_versions'].concat(handlerDef.paramKeys));
      const unknown = Object.keys(body).filter((k) => !allowedTop.has(k));
      if (unknown.length > 0) return res.status(400).json({ code: 'LEDGER_BAD_REQUEST', message: `未知字段: ${unknown.join(',')}`, field: unknown[0] });

      const opId = newOpId();
      const result = await withWrite(async (q) => { const value = await handlerDef.run(q, req, id, body, opId); await stocktakes.bind(q, id, body.stocktake_item_id, opId); return value; });
      res.status(200).json(Object.assign({}, stripFinance(result.primary, isAdmin), { op_id: opId, affected_ids: result.affectedIds }));
    } catch (err) {
      handleErr(res, err);
    }
  });

  // ============================================================
  // 七、_internals（供 verify-it-ledger.js 直调与故障注入）
  // ============================================================
  const _internals = {
    state,
    itTxnMutex,
    withRead,
    withWrite,
    requireLedgerReady,
    requireLedgerRead,
    requireLedgerWrite,
    FINANCE_FIELDS,
    rejectFinanceFields,
    stripFinance,
    ACTIONS,
    NULL_ASSET_ACTIONS,
    PAYLOAD_KEYS,
    writeEvent,
    newOpId,
    REQUIRED_TABLES,
    REQUIRED_INDEXES,
    // codex 19预筛 M3回补：导出 C1 的 DDL_STATEMENTS（含 'CREATE it_assets' 语句本体），供
    // verify 对"手写旧结构 DDL"做静态防漂移对拍（旧库手写文本 vs 生产DDL去掉三列定义行后
    // 的文本），不是新增行为改写型 setter，只是导出既有常量数据。
    DDL_STATEMENTS,
    checkReadiness,
    runDdlAndReadiness,
    // R1（长任务D · 对账族）：结构常量 + 助手，供 verify-it-reconcile.js 与后续 R2/R3/C2 消费。
    applyReconcileSchema,
    RECONCILE_REQUIRED_TABLES,
    RECONCILE_REQUIRED_INDEXES,
    RECONCILE_TABLE_COLUMN_SPECS,
    // M2 回补：DDL 语句文本导出供 verify 做静态文本断言（防止把 UNIQUE INDEX 悄悄改成
    // 非唯一 INDEX 也测不出来——静态断言 + 行为对拍双保险；codex 19-R rec：此前"活体变异"
    // 措辞不准确，这里只是静态正则断言，没有真实运行时改写行为，已订正措辞）。
    RECONCILE_DDL_STATEMENTS,
    ALL_REQUIRED_TABLES,
    ALL_REQUIRED_INDEXES,
    RECONCILE_RESULTS,
    RECONCILE_AUTO_RESULTS,
    RECONCILE_TERMINAL_RESULTS,
    RECONCILE_TRANSITIONS,
    RECONCILE_SHAPES,
    SOURCE_META_KEYS,
    EXTERNAL_ROW_KEYS,
    LEDGER_SNAPSHOT_KEYS,
    AMBIGUOUS_CANDIDATE_KEYS,
    normalizeReconcileKey,
    KEY_RULE_VERSION,
    P10_ASSET_FIELDS,
    ASSET_CLASS_VALUES,
    assertAssetClass,
    validateAmbiguousCandidates,
    // codex 18 H1 回补：结构核验单一实现，事务提交前（applyReconcileSchema 内部）与提交后
    // （checkReadiness）各调一次，导出供 verify 直接单测该函数本身（不必只能间接触发）。
    checkReconcileStructure,
    setBusyTimeout: (ms) => new Promise((resolve, reject) => {
      if (!itDb) return reject(new Error('itDb 未初始化'));
      itDb.run(`PRAGMA busy_timeout = ${Number(ms) || 0}`, (err) => (err ? reject(err) : resolve()));
    }),
    isDbOpen: () => !!itDb,
    // 连接身份：直接返回 itDb 对象引用，供 verify 用 === 比对"连接是否被替换过"（用例10b）。
    getDbIdentity: () => itDb,
    getDbFile: () => DB_FILE,
    // B5：纯读判据（不修改任何状态），供 verify 直接核对"锁前/锁后/路由层"三处是否真的同源。
    readinessError,
    // S4：只读诊断——未收尾的孤儿连接数量（不暴露连接对象本身，避免外部误用）。
    getOrphanConnCount: () => orphanConns.length,
    // C2（长任务 D · 登记/编辑/机柜/楼层）：invariants.js 全部导出项 + C2 白名单/端点助手，
    //   供 verify-it-ledger-write.js 直调（静态变异对 invariants.js 源码禁用某条 RULES 的场景
    //   不经过本对象，见 spec §7 group J），也供未来 C3–C6 复用同一份"一处真相"。
    invariants,
    REGISTER_ASSET_FIELDS,
    REGISTER_FORBIDDEN_TOP_FIELDS,
    UPDATE_ASSET_FIELDS,
    UPDATE_REJECT_FIELDS,
    WRITE_ERROR_CODES,
    applyFloorWrite,
    parseAssetRow,
    parseEventRow,
    mapConstraintError,
    // C3（机柜动作族）：新增错误码闭集 + 动作分发表，供 verify-it-ledger-actions.js 对拍。
    ACTION_ERROR_CODES,
    ACTION_HANDLERS,
  };

  // M8（主会话 2026-09-18 裁定）：行为改写型测试 seam 只在 deps.enableTestHooks === true 时
  //   挂载到 _internals；server.js 生产装配不传该 flag（保持既有 4 行注入不变），这些 setter
  //   在生产环境下**根本不存在**（不是"存在但生产路径不调用"，是 undefined），彻底消除生产代码
  //   被误调用这些测试专用行为改写口的可能性。setBusyTimeout/isDbOpen/getDbIdentity/
  //   readinessError 等纯只读或运维性质的口子不受此限制（不改变模块的判断逻辑本身）。
  // 1.6（C1 串行化重构保留清单）：随 lifecycleGen 代次仲裁一起删除的接口——
  //   setPublishGate / setSkipGenCheck3ForTest / getLifecycleGen（已彻底移除，不再挂载）。
  // S7（17-R4S 必修，清理过期声称）：handleRollbackFailure 已不再直接导出（见 S2 段落，测试
  //   改走 reinitForTest() 或注入 ROLLBACK 失败让生产路径自己触发）——上面这句"仍保留"是本轮
  //   之前遗留的过期表述，与实作不符，已订正。
  if (deps.enableTestHooks === true) {
    _internals.setDdlFailureInjection = (label) => { _testHooks.ddlFailureLabel = label; };
    // ddlBusyInjection 同属"行为改写"性质（伪造 DDL 层 BUSY），一并纳入本闸（M1 用例1b 需要）。
    // L6：非空注入同步返回"到达"信号（第一次真正进入退避 setTimeout 的那一刻 resolve），供
    //   verify 不靠猜 sleep 时长就知道流程确实已经卡在退避窗口里；传 null 清除注入与信号。
    _internals.setDdlBusyInjection = (labelOrNull, count) => {
      _testHooks.ddlBusyInjection = labelOrNull ? { label: labelOrNull, count: Number(count) || 0 } : null;
      if (labelOrNull) {
        let resolveArrived;
        _testHooks.ddlBackoffArrived = new Promise((r) => { resolveArrived = r; });
        _testHooks.ddlBackoffArrivedResolve = resolveArrived;
      } else {
        _testHooks.ddlBackoffArrived = null;
        _testHooks.ddlBackoffArrivedResolve = null;
      }
      return _testHooks.ddlBackoffArrived;
    };
    // 原样传值（不做 !!强转）——'no_txn' 字符串与 true 是两种不同的注入语义，强转成布尔会丢失
    // 'no_txn' 这一档（用例10b）。
    _internals.setRollbackFailureInjection = (value) => { _testHooks.rollbackFailure = value; };
    _internals.setSkipAssertWriteForTest = (flag) => { _testHooks.skipAssertWriteForTest = !!flag; };
    // 用例14 活体变异③：关闭"事务已不存在"豁免。
    _internals.setDisableNoTxnExemptionForTest = (flag) => { _testHooks.disableNoTxnExemption = !!flag; };
    // H2/M1：openItDb 人为失败注入（initSchema 首次打开 / rebuildUnderLock 重建打开）。
    _internals.setOpenDbFailureInjection = (flag) => { _testHooks.openDbFailureInjection = !!flag; };
    // B4①保留项：伪造"打开回调本身带 err"。
    _internals.setOpenDbCallbackErrInjection = (flag) => { _testHooks.openDbCallbackErrInjection = !!flag; };
    // B3/M2：临时调小 runLifecycleInit 的总预算（ms），传 null/0 恢复默认（普通30s/fastMode 3s）。
    _internals.setDdlDeadlineMsOverride = (ms) => { _testHooks.ddlDeadlineMsOverride = ms || null; };
    // G3A-b（M1 必修）：调小 awaitGateWithTimeout 的超时时长（ms），传 null/0 恢复默认 30s——
    //   供 verify 用短超时可控地验证"闸从不放行"场景下 COMMIT/ROLLBACK 失败收尾是否正确，不用
    //   真等 30s。
    _internals.setGateTimeoutMsOverride = (ms) => { _testHooks.gateTimeoutMsOverride = ms || null; };
    // H5①：openAndPrepare 实际调用次数（纯读计数器）。
    _internals.getOpenAndPrepareCallCount = () => _testHooks.openAndPrepareCallCount;
    // H5②/L2/L6：设置/清除可等待闸——传一个 Promise 卡住 openAndPrepare 的发布前流程，供 verify
    //   精确卡住启动初始化流程的某个时间点验证"shutdown 等 init 落地后才关闭"。非空时同步返回
    //   "到达"信号（openAndPrepare 真正开始 await 这个闸的那一刻 resolve）；传 null 复原并清空
    //   信号（不自动放行，调用方必须自己 resolve 那个 Promise 才算"放闸"）。
    _internals.setOpenGate = (gateOrNull) => {
      _testHooks.openGate = gateOrNull;
      if (gateOrNull) {
        let resolveArrived;
        _testHooks.openGateArrived = new Promise((r) => { resolveArrived = r; });
        _testHooks.openGateArrivedResolve = resolveArrived;
        return _testHooks.openGateArrived;
      }
      _testHooks.openGateArrived = null;
      _testHooks.openGateArrivedResolve = null;
      return null;
    };
    // L1/T2：设置/清除 withWrite 内 BEGIN 成功、业务回调开始之前的可等待闸——非空时同步返回
    // "到达"信号（withWrite 真正开始等这个闸的那一刻 resolve），传 null 复原并清空信号。
    _internals.setTxnMidGate = (gateOrNull) => {
      _testHooks.txnMidGate = gateOrNull;
      if (gateOrNull) {
        let resolveArrived;
        _testHooks.txnMidGateArrived = new Promise((r) => { resolveArrived = r; });
        _testHooks.txnMidGateArrivedResolve = resolveArrived;
        return _testHooks.txnMidGateArrived;
      }
      _testHooks.txnMidGateArrived = null;
      _testHooks.txnMidGateArrivedResolve = null;
      return null;
    };
    // G3A（41S H1 测试钩子）：设置/清除 withWrite 内"txnMarker.active 已置 false、真正发出
    //   COMMIT/ROLLBACK 之前"的可等待闸——语义与 setTxnMidGate 一致（非空时同步返回"到达"信号，
    //   传 null 复原并清空信号），只是卡的时间点不同（这里是事务收尾前夕，不是业务回调开始前）。
    _internals.setPreCommitGate = (gateOrNull) => {
      _testHooks.preCommitGate = gateOrNull;
      if (gateOrNull) {
        let resolveArrived;
        _testHooks.preCommitGateArrived = new Promise((r) => { resolveArrived = r; });
        _testHooks.preCommitGateArrivedResolve = resolveArrived;
        return _testHooks.preCommitGateArrived;
      }
      _testHooks.preCommitGateArrived = null;
      _testHooks.preCommitGateArrivedResolve = null;
      return null;
    };
    // M1/S6：拿到"正在初始化、还未发布"的连接引用，供手动 emit('error') 模拟初始化期连接层
    //   故障。串行化重构后不再有并发在途连接，简化为"最近一次打开"，去掉按 gen 索引的参数。
    _internals.getLastOpenedDbForTest = () => _testHooks.lastOpenedDbForTest;
    // S6：只读生命周期计数器快照（浅拷贝，防外部修改内部计数状态）——{opened, published, closedAttempts}。
    _internals.getLifecycleCounters = () => ({ ..._testHooks.lifecycleCounters });
    // T3：execRollback 调用次数只读快照。
    _internals.getRollbackCallCount = () => _testHooks.rollbackCallCount;
    // S2（17-R3S 必修）：改为——先等在途的启动初始化落地（若非空），再取 mutex；锁内若发现
    //   state.draining 已置 true（比如取锁排队期间 shutdown() 被调用），直接抛 503 DRAINING、
    //   不重建——不能在停机流程正在收尾的同时又抢着开一条新连接，那样会和 shutdown() 的
    //   closeItDb() 打架（两边都在碰 itDb）。仍是测试专用的外部重建入口，与业务事务互斥。
    // S5 补充：reinitForTest 语义上等价于"运维重启"——真实进程重启会让 state.recoveryForbidden
    //   这类内存态归零，测试侧的等价动作就是显式清空它，否则一旦某条用例触发过一次"连接关闭
    //   失败"，recoveryForbidden 会一直卡住 rebuildUnderLock 的最前置检查，后续所有想借
    //   reinitForTest() 复原模块的用例都会失败——不清空这个标志，"reinitForTest 能让模块
    //   恢复"这条契约本身就不成立。生产路径没有这个清空手段。
    _internals.reinitForTest = async () => {
      if (initPromise) {
        await initPromise.catch(() => {});
      }
      return withLifecycleLock(async () => {
        if (state.draining) {
          const e = new Error('模块正在停机，请稍后重试'); e.status = 503; e.code = 'LEDGER_DRAINING'; throw e;
        }
        state.recoveryForbidden = false;
        return rebuildUnderLock({ fastMode: false });
      });
    };
    // S2（17-R3S 必修）：不再直接导出 handleRollbackFailure——测试需要模拟"重建失败"改走
    // reinitForTest()（真实取锁重建路径）或 setRollbackFailureInjection/setOpenDbFailureInjection
    // 等注入手段让生产路径自己触发 handleRollbackFailure，不再绕开锁语义直接裸调用内部函数。
    // S3：注入 close() 失败——生产路径恒为 false。
    _internals.setCloseFailureInjection = (flag) => { _testHooks.closeFailureInjection = !!flag; };
    // 17-R6S M：配合 closeFailureInjection 使用，给注入的关闭失败加一段真实延迟（ms）。
    _internals.setCloseFailureDelayMs = (ms) => { _testHooks.closeFailureDelayMs = Number(ms) || 0; };
    // S4：连接使用轨迹只读快照（浅拷贝数组，防外部修改内部状态）与清空。
    _internals.getConnTrace = () => _testHooks.connTrace.slice();
    _internals.clearConnTrace = () => { _testHooks.connTrace.length = 0; };
    // S4：把全局 itDb 临时替换成给定连接对象——供 T4 活体变异验证"若实现改回读全局 itDb 而非
    // 绑定的 conn，connTrace 会出现第二个连接 id"；仅供 verify 用，生产从不需要这个操作。
    _internals.setSwapGlobalItDbForTest = (db) => { itDb = db; };
    // G2A2：导出 ledgerRequestContext 本身（不是 setter，是 AsyncLocalStorage 实例引用）——供
    //   verify 直接 .run({writeRequest:true,...}, () => withRead(...)) 构造"写请求上下文里发生
    //   一次锁外读"的正向对照场景（withRead 已在 _internals 无条件导出，见"七、_internals"节顶部
    //   常量列表）。生产装配不传 enableTestHooks，这个键在生产 _internals 里不存在——新增进
    //   verify-it-ledger.js 用例T4 的手写冻结清单（20→21）。
    _internals.ledgerRequestContext = ledgerRequestContext;
    // R1：applyReconcileSchema 内的失败注入复用既有 setDdlFailureInjection（不新增测试专用
    //   setter，避免破坏 verify-it-ledger.js 用例T4 对 _internals 键差集的冻结断言）——传
    //   'it_reconciles'/'it_reconcile_items'/三个索引名之一命中两表/三索引的 CREATE 语句，传
    //   `ALTER it_assets ADD COLUMN <col>`（col ∈ owner_name/owner_dept/asset_class）命中对应
    //   ALTER 语句，供 verify-it-reconcile.js 的"结构事务原子性"用例（spec §3 用例2）复用。
    // G3A（41T H2 必修）：导出 runCleanupDetached 本身（不是 setter，是函数引用，与
    //   ledgerRequestContext 同款导出方式）——供 verify 直接拿到与 inspection-sheets.js 工厂
    //   收到的完全同一个函数引用（依赖注入的对象恒等），构造"即使借 Reflect.get(arguments[0], ...)
    //   反射取值也拿不到任意回调执行权"的用例，不需要真的改 inspection-sheets.js 源码去模拟反射
    //   取值这个动作本身——被反射取到的和这里导出的是同一个函数，行为完全一致。生产装配不传
    //   enableTestHooks，这个键在生产 _internals 里不存在——新增进 verify-it-ledger.js 用例T4 的
    //   手写冻结清单。
    _internals.runCleanupDetached = runCleanupDetached;
    // G3A-c（41RT M4）：只读快照——供 verify 判定"清理动作是否真的跑完了"（started===settled）。
    _internals.getCleanupSettleCounters = () => ({ started: _testHooks.cleanupStarted, settled: _testHooks.cleanupSettled });
  }

  // C4：盘为主行，宿主为 affected；新增逻辑集中在尾部（用户 #19）。
  function isDiskAction(action) {
    return action === 'disk_mount' || action === 'disk_unmount' || action === 'disk_swap' || action === 'disk_move';
  }

  Object.assign(PAYLOAD_KEYS, {
    disk_mount: { primary: new Set(['status', 'parent_asset_id', 'slot_no']), affected: new Set(['slot_no', 'disk_id']) },
    disk_unmount: { primary: new Set(['status', 'parent_asset_id', 'slot_no']), affected: new Set(['slot_no', 'disk_id']) },
    disk_swap: {
      primary: new Set(['status', 'parent_asset_id', 'slot_no']),
      affected: { disk: new Set(['status', 'parent_asset_id', 'slot_no']), host: new Set(['slot_no', 'disk_id']) },
    },
    disk_move: { primary: new Set(['parent_asset_id', 'slot_no']), affected: new Set(['slot_no', 'disk_id']) },
  });
  Object.assign(ACTION_HANDLERS, {
    disk_mount: { paramKeys: ['parent_asset_id', 'slot_no'], peerRequired: true, run: runDiskMount },
    disk_unmount: { paramKeys: ['to'], peerRequired: true, run: runDiskUnmount },
    disk_swap: { paramKeys: ['new_disk_id', 'to'], peerRequired: true, run: runDiskSwap },
    disk_move: { paramKeys: ['parent_asset_id', 'slot_no'], peerRequired: true, run: runDiskMove },
  });

  function diskError(status, code, field, message) {
    const err = new Error(message);
    err.status = status; err.code = code; err.field = field;
    return err;
  }

  // C4 事件字段全等；swap 的 affected 分支由数据库接收资产决定，不能由载荷自行选宽表。
  async function diskEventKeys(q, action, role, assetId, fromState, toState) {
    const row = await q.get('SELECT * FROM it_assets WHERE id = ?', [assetId]);
    if (!row) throw diskError(500, 'LEDGER_INTERNAL', 'asset_id', 'C4 事件资产不存在');
    const diskRecipient = row.category === 'disk';
    const hostRecipient = invariants.isHostEligible(row);
    if ((role === 'primary' && !diskRecipient) || (role === 'affected' && !(hostRecipient || (action === 'disk_swap' && diskRecipient)))) {
      throw diskError(500, 'LEDGER_INTERNAL', 'asset_id', 'C4 事件接收资产类别不符');
    }
    const allowed = action === 'disk_swap' && role === 'affected'
      ? PAYLOAD_KEYS.disk_swap.affected[diskRecipient ? 'disk' : 'host']
      : PAYLOAD_KEYS[action][role];
    for (const side of [fromState, toState]) {
      const keys = Object.keys(side);
      if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) {
        throw diskError(500, 'LEDGER_INTERNAL', 'from_state/to_state', 'C4 事件载荷键集合必须全等');
      }
    }
    return allowed;
  }

  function assertDiskPeerShape(peers) {
    if (!isPlainObjectShape(peers)) throw diskError(400, 'LEDGER_BAD_REQUEST', 'peer_versions', 'peer_versions 必填且为对象');
    const keys = Object.keys(peers);
    if (keys.length === 0 || keys.some((key) => !/^[1-9]\d*$/.test(key) || !invariants.isSafePosInt(Number(key)) || !invariants.isSafePosInt(peers[key]))) {
      throw diskError(400, 'LEDGER_BAD_REQUEST', 'peer_versions', 'peer_versions 必须使用规范资产id和安全正整数版本');
    }
  }

  function assertDiskPeers(peers, rows) {
    const keys = Object.keys(peers).sort();
    const expected = rows.map((row) => String(row.id)).sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) throw diskError(400, 'LEDGER_BAD_REQUEST', 'peer_versions', 'peer_versions 键集合与本动作对端必须全等');
    for (const row of rows) {
      if (peers[row.id] !== row.version) throw diskError(409, 'VERSION_CONFLICT', 'peer_versions', '对端资产版本冲突');
    }
  }

  function assertDiskId(value, field) {
    if (!invariants.isSafePosInt(value)) throw diskError(400, 'LEDGER_BAD_REQUEST', field, `${field} 必填且为安全正整数`);
  }

  async function diskInputAsset(q, id, field) {
    assertDiskId(id, field);
    const row = await q.get('SELECT * FROM it_assets WHERE id = ?', [id]);
    if (!row) throw diskError(400, 'LEDGER_BAD_REQUEST', field, '指定资产不存在');
    return row;
  }

  function assertDiskForm(row, mounted) {
    if ((row.parent_asset_id !== null) !== mounted) {
      const e = diskError(409, 'ACTION_NOT_ALLOWED_IN_STATUS', 'parent_asset_id', '盘装载形态不适用本动作');
      e.detail = { current_status: row.status }; throw e;
    }
  }

  async function loadDiskParticipants(q, req, id, body, action) {
    const primary = await loadAndCheckPrimary(q, req, id, body);
    assertEligible(primary.category === 'disk', action);
    assertDiskForm(primary, action !== 'disk_mount');
    let source = null; let target = null; let replacement = null;
    if (action !== 'disk_mount') {
      source = await q.get('SELECT * FROM it_assets WHERE id = ?', [primary.parent_asset_id]);
      if (!source) throw diskError(500, 'LEDGER_INTERNAL', 'parent_asset_id', '已有随装盘的宿主引用缺失');
    }
    if (action === 'disk_mount' || action === 'disk_move') {
      target = await diskInputAsset(q, body.parent_asset_id, 'parent_asset_id');
      assertDiskId(body.slot_no, 'slot_no');
      if (source && target.id === source.id) throw diskError(409, 'NO_OP_TRANSITION', 'parent_asset_id', '同宿主换槽须拆盘再装盘');
    }
    if (action === 'disk_swap') {
      replacement = await diskInputAsset(q, body.new_disk_id, 'new_disk_id');
      if (replacement.id === primary.id) throw diskError(409, 'NO_OP_TRANSITION', 'new_disk_id', '不能用旧盘替换自身');
    }
    const hosts = [source, target].filter(Boolean);
    assertDiskPeers(body.peer_versions, replacement ? [replacement, ...hosts] : hosts);
    if (action === 'disk_mount') assertStatusIn(primary.status, ['in_depot'], action);
    if (source) {
      assertEligible(invariants.isHostEligible(source) && source.slot_count > 0, action);
      assertStatusIn(source.status, action === 'disk_unmount' ? invariants.PARENT_ALLOWED_STATUSES : ['in_service'], action);
      assertStatusIn(primary.status, [source.status], action);
      assertDiskId(primary.slot_no, 'slot_no');
      if (primary.slot_no > source.slot_count) throw diskError(400, 'LEDGER_BAD_REQUEST', 'slot_no', '原盘槽号超出宿主容量');
    }
    if (target) {
      assertEligible(invariants.isHostEligible(target) && target.slot_count > 0, action);
      assertStatusIn(target.status, ['in_service'], action);
      if (body.slot_no > target.slot_count) throw diskError(400, 'LEDGER_BAD_REQUEST', 'slot_no', '目标槽号超出宿主容量');
      const occupied = await q.get('SELECT id FROM it_assets WHERE parent_asset_id = ? AND slot_no = ?', [target.id, body.slot_no]);
      if (occupied) throw diskError(409, 'SLOT_OCCUPIED', 'slot_no', '目标盘位已被占用');
    }
    if (replacement) {
      assertEligible(replacement.category === 'disk', action);
      assertDiskForm(replacement, false);
      assertStatusIn(replacement.status, ['in_depot'], action);
    }
    if (action === 'disk_unmount' || action === 'disk_swap') {
      const allowedTo = action === 'disk_unmount' ? ['in_depot', 'faulty'] : invariants.DEPOT_STATUSES;
      if (!allowedTo.includes(body.to)) throw diskError(400, 'LEDGER_BAD_REQUEST', 'to', 'to 必填且属于该动作允许的库房状态');
    }
    const beforeChildren = new Map();
    for (const host of hosts) beforeChildren.set(host.id, await loadChildren(q, host.id));
    return { primary, source, target, replacement, hosts, beforeChildren };
  }

  async function bumpDiskHostVersions(q, hosts) {
    for (const host of hosts) {
      await q.run("UPDATE it_assets SET version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [host.id]); // C4_HOST_VERSION
    }
  }

  // 真正重读写入结果及全部兄弟盘；预期集合只用于成员核验，不作为不变量的目标态输入。
  async function rereadDiskAction(q, participants) {
    const { primary, source, target, replacement, hosts, beforeChildren } = participants;
    const rows = new Map(); const childrenByHost = new Map(); const hostContexts = new Map();
    for (const before of [primary, replacement, ...hosts].filter(Boolean)) {
      rows.set(before.id, assertRereadFound(await q.get('SELECT * FROM it_assets WHERE id = ?', [before.id]), before.id));
    }
    for (const host of hosts) {
      const children = await loadChildren(q, host.id);
      childrenByHost.set(host.id, children);
      const expected = beforeChildren.get(host.id).map((child) => child.id).filter((childId) => !(source && host.id === source.id && childId === primary.id));
      if (target && host.id === target.id) expected.push(primary.id);
      if (replacement && host.id === source.id) expected.push(replacement.id);
      if (JSON.stringify(expected.sort((a, b) => a - b)) !== JSON.stringify(children.map((child) => child.id).sort((a, b) => a - b))) {
        throw diskError(500, 'LEDGER_INTERNAL', 'parent_asset_id', 'C4 写后子盘集合与动作变更不符');
      }
      const realHost = rows.get(host.id);
      const ctx = { childDisks: children.map((child) => ({ slot_no: child.slot_no, status: child.status })) };
      if (realHost.rack_id !== null) {
        const rack = await q.get('SELECT u_total FROM it_racks WHERE id = ?', [realHost.rack_id]);
        if (!rack) throw diskError(500, 'LEDGER_INTERNAL', 'rack_id', '宿主机柜引用缺失');
        const occ = await q.all("SELECT id, u_start, u_height FROM it_assets WHERE rack_id = ? AND status = 'in_service'", [realHost.rack_id]);
        ctx.rack = { u_total: rack.u_total }; ctx.occupiedIntervals = buildOccupiedIntervals(occ);
      }
      hostContexts.set(host.id, ctx);
    }
    validateDiskActionRows(rows, childrenByHost, hostContexts); // C4_REREAD_VALIDATE
    return rows;
  }

  function validateDiskActionRows(rows, childrenByHost, hostContexts) {
    const validate = (row, ctx) => {
      const violation = validateAssetInvariants(toRowForCheck(row), ctx);
      if (violation) throwViolation(violation);
    };
    for (const [hostId, ctx] of hostContexts) validate(rows.get(hostId), ctx);
    const disks = new Map();
    for (const row of rows.values()) if (row.category === 'disk') disks.set(row.id, row);
    for (const children of childrenByHost.values()) for (const child of children) disks.set(child.id, child);
    for (const disk of disks.values()) {
      const ctx = {};
      if (disk.parent_asset_id !== null) {
        const parent = rows.get(disk.parent_asset_id);
        if (!parent) throw diskError(500, 'LEDGER_INTERNAL', 'parent_asset_id', '重读盘的宿主不在参与集合');
        ctx.parent = { slot_count: parent.slot_count, status: parent.status, category: parent.category };
      }
      validate(disk, ctx);
    }
  }

  function diskState(row, includeStatus) {
    const state = { parent_asset_id: row.parent_asset_id, slot_no: row.slot_no };
    if (includeStatus) state.status = row.status;
    return state;
  }

  async function finishDiskAction(q, req, action, body, opId, p) {
    await bumpDiskHostVersions(q, p.hosts);
    const rows = await rereadDiskAction(q, p);
    const primary = rows.get(p.primary.id);
    await writeEvent(q, {
      op_id: opId, asset_id: primary.id, action, role: 'primary', related_asset_id: null,
      from_state: diskState(p.primary, action !== 'disk_move'), to_state: diskState(primary, action !== 'disk_move'),
      operator_id: req.user.id, note: body.note || null,
    });
    const affectedIds = [];
    if (p.replacement) {
      await writeEvent(q, {
        op_id: opId, asset_id: p.replacement.id, action, role: 'affected', related_asset_id: primary.id,
        from_state: diskState(p.replacement, true), to_state: diskState(rows.get(p.replacement.id), true),
        operator_id: req.user.id, note: body.note || null,
      });
      affectedIds.push(p.replacement.id);
    }
    for (const host of p.hosts) {
      const isSource = p.source && host.id === p.source.id;
      const slot = isSource ? p.primary.slot_no : primary.slot_no;
      const fromDisk = isSource ? primary.id : null;
      const toDisk = p.replacement ? p.replacement.id : (isSource ? null : primary.id);
      await writeEvent(q, { // C4_HOST_EVENT_BEGIN
        op_id: opId, asset_id: host.id, action, role: 'affected', related_asset_id: primary.id,
        from_state: { slot_no: slot, disk_id: fromDisk }, to_state: { slot_no: slot, disk_id: toDisk },
        operator_id: req.user.id, note: body.note || null,
      }); // C4_HOST_EVENT_END
      affectedIds.push(host.id);
    }
    return { primary: parseAssetRow(primary), affectedIds };
  }

  async function runDiskMount(q, req, id, body, opId) {
    const p = await loadDiskParticipants(q, req, id, body, 'disk_mount');
    await q.run("UPDATE it_assets SET status = 'in_service', parent_asset_id = ?, slot_no = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [p.target.id, body.slot_no, id]);
    return finishDiskAction(q, req, 'disk_mount', body, opId, p);
  }

  async function runDiskUnmount(q, req, id, body, opId) {
    const p = await loadDiskParticipants(q, req, id, body, 'disk_unmount');
    await q.run("UPDATE it_assets SET status = ?, parent_asset_id = NULL, slot_no = NULL, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [body.to, id]);
    return finishDiskAction(q, req, 'disk_unmount', body, opId, p);
  }

  async function runDiskSwap(q, req, id, body, opId) {
    const p = await loadDiskParticipants(q, req, id, body, 'disk_swap');
    await q.run("UPDATE it_assets SET status = ?, parent_asset_id = NULL, slot_no = NULL, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [body.to, id]);
    await q.run("UPDATE it_assets SET status = 'in_service', parent_asset_id = ?, slot_no = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [p.source.id, p.primary.slot_no, p.replacement.id]);
    return finishDiskAction(q, req, 'disk_swap', body, opId, p);
  }

  async function runDiskMove(q, req, id, body, opId) {
    const p = await loadDiskParticipants(q, req, id, body, 'disk_move');
    await q.run("UPDATE it_assets SET parent_asset_id = ?, slot_no = ?, version = version + 1, updated_at = datetime('now','localtime') WHERE id = ?", [p.target.id, body.slot_no, id]);
    return finishDiskAction(q, req, 'disk_move', body, opId, p);
  }

  return { initSchema, router, shutdown, _internals };
};
