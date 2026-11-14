// routes/sysbuild/index.js — 项目管理（系统建设记录）模块：工厂、就绪闸门、路由
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §7（接口）、§10（技术实现）
//
// 范式：照 routes/legacy-archive 的 REQUIRED_DEPS（缺依赖即 throw）与就绪闸门形状；连接 / 锁 / 事务
//   在 ./db.js（本模块独立连接，不注入共享连接助手）；结构在 ./schema.js。
//   server.js 只做四件事：实例化 + app.use('/api', router)、在共享连接回调里调用 initSchema()、
//   /api/health/ready 的 modules 增加 sysbuild、UPLOADS_PROTECTED_DIRS 增加 'sysbuild'。
//   C1b 骨架与就绪闸门；C1c 起挂附件端点（./attachments.js），C2 起逐批加入其余端点。
'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const { createSysbuildDb } = require('./db');
const schema = require('./schema');
const { createAttachmentRoutes } = require('./attachments');
const { createProjectRoutes } = require('./projects');
const { createMembershipRoutes } = require('./membership');
const { createPlanRoutes } = require('./plan');
const { createItemRoutes } = require('./items');
const { createPackageRoutes } = require('./packages');
const { createMaterialRoutes } = require('./materials');
const { createConfirmRoutes } = require('./confirm');
const { createHistoryRoutes } = require('./history');
const { createConfirmationSheetRoutes } = require('./confirmation-sheet');
const { createEntryRoutes } = require('./entries');
const { createChangeRoutes } = require('./changes');
const { createGoliveRoutes } = require('./golive');
const { createNotifier, createNotifyRoutes } = require('./notify');

module.exports = (deps) => {
  const REQUIRED_DEPS = [
    'logger', 'DB_FILE', 'authenticateToken', 'UPLOAD_DIR',
    'normalizeAttachmentExt', 'safeDeleteFileSync', 'COLLAB_ALLOWED_EXTS_UNION', 'READONLY_LEADER_IDS',
    'WRITE_ALLOWED_ROLES', // 平台写接口允许的角色（server.js:4449 数组 ['admin','publisher','user']）：建项与「可被指定为 PM」限这些角色（排除 viewer）
    'dingtalkNotify', // C6b：utils/dingtalk-notify.js 模块对象（进程内测试注入同形替身；隔离实例走平台钉钉替身 SDH_EXTERNAL=stub）
    'readSystemConfig', // C6b：读 system_configs 并解密（server.js 的 readSystemConfig，同名简写注入——verify-instance-config-keys F-form 不允许改名传递）：钉钉凭证三项与 platform_base_url
  ];
  for (const k of REQUIRED_DEPS) {
    if (deps[k] === undefined) throw new Error('routes/sysbuild 缺注入依赖: ' + k);
  }
  const { logger, DB_FILE, authenticateToken, UPLOAD_DIR } = deps;
  const UPLOAD_SUBDIR = path.join(UPLOAD_DIR, 'sysbuild');

  const rawDb = createSysbuildDb({
    logger,
    DB_FILE,
    schemaObjects: schema.SCHEMA_OBJECTS,
    busyTimeoutMs: deps.busyTimeoutMs,
    lockTimeoutMs: deps.lockTimeoutMs,
    processExit: deps.processExit,
    enableTestHooks: deps.enableTestHooks === true,
    // 发布前预建上传目录；失败即初始化失败（503 SCHEMA_NOT_READY），不带着建不出目录的状态就绪。
    beforePublish: () => { fs.mkdirSync(UPLOAD_SUBDIR, { recursive: true }); },
  });
  // C6b 通知：发送侧用未包装的 rawDb（回写发送结果）；各路由拿到的 db 是包装后的——withWriteTxn 提交成功后在事务外派发本事务写下的发送意图（回滚不发）。
  //   backgroundJobs（server.js 传 INSTANCE_CONFIG.background === 'on'）：只在后台任务开关为 on 时，模块就绪后扫描 pending / failed 的意图补发；缺省 false（隔离实例默认 off）。
  //   修订批 1（K1）：发送前复核收件人此刻还能不能作出确认，要按只读账号集合判项目可见性（与站内「待我确认」同一个函数 confirm-core.confirmAvailabilityBlock），所以也传 readonlyIds。
  //   配置读取只能以「解构简写 / 字面量键直接调用」形态出现（verify-instance-config-keys F-form / F-call-arg），所以按发送侧要用的 4 个键
  //   逐个字面量调用，其余键一律 null（顺带把 sysbuild 能读的配置收成白名单）。
  const { readSystemConfig } = deps;
  const SYS_CFG_READERS = Object.freeze({
    dingtalk_app_key: () => readSystemConfig('dingtalk_app_key'),
    dingtalk_app_secret: () => readSystemConfig('dingtalk_app_secret'),
    dingtalk_robot_code: () => readSystemConfig('dingtalk_robot_code'),
    platform_base_url: () => readSystemConfig('platform_base_url'),
  });
  const getSystemConfig = async (key) => (Object.prototype.hasOwnProperty.call(SYS_CFG_READERS, key) ? SYS_CFG_READERS[key]() : null);
  const notifier = createNotifier({ db: rawDb, logger, dingtalkNotify: deps.dingtalkNotify, getSystemConfig, readonlyIds: deps.READONLY_LEADER_IDS, backgroundJobs: deps.backgroundJobs === true });
  const db = notifier.wrapDb(rawDb);

  const router = express.Router();

  // 就绪闸门：只拦 /api/sysbuild/*，未匹配的 /api/* 不受影响。
  function requireSysbuildReady(req, res, next) {
    const r = db.getReadiness();
    if (!r.ready) {
      const message = r.code === 'SYSBUILD_SCHEMA_INITIALIZING' ? '项目管理模块正在初始化，请稍后重试'
        : r.code === 'SYSBUILD_SCHEMA_NOT_READY' ? '项目管理模块初始化失败，需人工处理后重启'
          : '项目管理模块暂不可用，需重启服务恢复';
      return res.status(503).json({ code: r.code, message });
    }
    return next();
  }
  router.use('/sysbuild', authenticateToken, requireSysbuildReady);

  // 附件端点（C1c）：路径都以 /sysbuild/ 开头，已在上一行前置鉴权与就绪闸门。
  const attachments = createAttachmentRoutes({
    db,
    logger,
    UPLOAD_DIR,
    normalizeAttachmentExt: deps.normalizeAttachmentExt,
    safeDeleteFileSync: deps.safeDeleteFileSync,
    COLLAB_ALLOWED_EXTS_UNION: deps.COLLAB_ALLOWED_EXTS_UNION,
    readonlyIds: deps.READONLY_LEADER_IDS,
    nowProvider: typeof deps.nowProvider === 'function' ? deps.nowProvider : () => new Date(),
    enableTestHooks: deps.enableTestHooks === true,
  });
  router.use(attachments.router);

  // 项目端点（C2a）：同款前置，只读账号集合与附件端点共用 READONLY_LEADER_IDS。
  const projects = createProjectRoutes({ db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES });
  router.use(projects.router);

  // 参与方 / 成员 / 任职 / 授权 / 邀请端点与受邀人窄范围入口（C2b）：同款前置与依赖。
  //   C4b：无账号成员的任职 / 授权由 PM 代录，代录端点在同一事务里绑定凭据附件（attachments.helpers），外部确认日期上限用 todayProvider（缺省 = 服务器本地日期）。
  const membership = createMembershipRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined,
  });
  router.use(membership.router);

  // 批次 / 节点 / 排期端点（C3a）：放在附件之后，用 attachments.helpers 在同一事务里绑定改期证据附件。todayProvider 可选，缺省 = 服务器本地日期。
  const plan = createPlanRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined,
  });
  router.use(plan.router);

  // 模块 / 需求条目端点（C3b）：新版本沿用附件、登记时绑定证据附件都用 attachments.helpers。
  const items = createItemRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
  });
  router.use(items.router);

  // 内容包与版本 / 条目集合修订端点（C3b，草稿期；提交确认与生效是 C4）。
  const packages = createPackageRoutes({ db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES });
  router.use(packages.router);
  const materials = createMaterialRoutes({ db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES, attachmentHelpers: attachments.helpers });
  router.use(materials.router);

  // 内容包提交确认 / 撤回、确认任务改发 / 浏览 / 决策、待我确认（C4a）：提交时用 attachments.helpers 冻结附件清单。
  const confirm = createConfirmRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined, // C4b：代录的外部确认日期上限
  });
  router.use(confirm.router);

  // 「历史补录中」时间窗、历史补录、历史事实导入（C4b Q-S2）：复用 confirm 的条目集合重核与 plan 的收口取数。
  const history = createHistoryRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined,
    recheckOverallSet: confirm.recheckOverallSet,
    loadPlanData: plan.loadPlanData,
  });
  router.use(history.router);

  // 需求确认单导出（C4c R-S1）：纯读的打印友好 HTML；导出时刻可注入（nowProvider，缺省 = 服务器当前时刻）。
  const confirmationSheet = createConfirmationSheetRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    nowProvider: typeof deps.nowProvider === 'function' ? deps.nowProvider : undefined,
  });
  router.use(confirmationSheet.router);

  // 登记与办理、知会与知会异议（C5 S-S1a）：写登记时绑定附件、给结论时冻结登记附件都用 attachments.helpers；todayProvider 可选（业务日期上限与「收口后第 N 天」，缺省 = 服务器本地日期）。
  const entries = createEntryRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined,
  });
  router.use(entries.router);

  // 正式变更（C5 S-S1c）：建变更 / 出新版本 / 读；提交与撤回在 confirm 路由（POST /changes/:cid/submit、包版本 withdraw），生效在 confirm-core。建变更时绑定方向类证据附件用 attachments.helpers。
  const changes = createChangeRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
  });
  router.use(changes.router);

  // 上线交接集合 / 交接确认发起 / 确认试运行结束（上线、再上线）/ 撤销上线（C6a）：发起交接确认时冻结登记附件用 attachments.helpers；todayProvider 可选（里程碑节点收口记的实际日期，缺省 = 服务器本地日期）。
  const golive = createGoliveRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES,
    attachmentHelpers: attachments.helpers,
    todayProvider: typeof deps.todayProvider === 'function' ? deps.todayProvider : undefined,
  });
  router.use(golive.router);

  // 通知与待办（C6b）：PM 补发 / 发送意图列表、我的待办。待办的「待我确认」「知会」两类读 confirm / entries 导出的同一取数函数（与 GET /my/confirmations、/my/notices 同源）。
  const notifyRoutes = createNotifyRoutes({
    db, logger, readonlyIds: deps.READONLY_LEADER_IDS, writeRoles: deps.WRITE_ALLOWED_ROLES, notifier,
    myConfirmationItems: confirm.myConfirmationItems, myNoticeItems: entries.myNoticeItems, myInvitationItems: membership.myInvitationItems,
  });
  router.use(notifyRoutes.router);

  // 初始化成功后触发一次「模块就绪时扫描」（后台任务开关 off 时 notifier.onReady 什么也不做）；返回的仍是底层单飞的同一个 Promise。
  const initSchema = () => {
    const p = db.initSchema();
    p.then(() => { if (db.getReadiness().ready) notifier.onReady(); }).catch(() => {});
    return p;
  };

  const _internals = {
    db: db._internals,
    withRead: db.withRead,
    withWriteTxn: db.withWriteTxn,
    UPLOAD_SUBDIR,
    attachments: attachments._internals,
  };

  return {
    initSchema,
    router,
    notifier, // C6b：测试等待发送完成（whenIdle）、直接触发补发 / 扫描用
    getReadiness: db.getReadiness,
    // 事务内附件助手（绑定 / 冻结），供 C3 起的记录提交接口在各自的 withWriteTxn 回调里调用
    attachmentHelpers: attachments.helpers,
    _internals,
  };
};
