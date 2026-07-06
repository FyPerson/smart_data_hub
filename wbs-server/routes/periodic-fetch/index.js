// routes/periodic-fetch/index.js — 周期取数推送模块（手动触发·占位符日期·钉钉推送，仅 admin 独立新模块）
//   业务方案 SSOT = docs/local/周期取数推送/周期取数推送模块_方案_20260703_v1.0.md
//   编码任务书 = docs/local/周期取数推送/周期取数推送_Sonnet任务书_20260705_v1.0.md
//
// 集成点1 范围（已合并 main，908c7d2）：① schema 3 表（periodic_tasks / periodic_task_runs /
//   periodic_task_pushes，readiness 守门）+ ② 任务 CRUD（登记/改/禁用/列表/详情，全 requireAdmin）+
//   占位符校验（§3.4）+ 最小 SQL 形态校验（§4.1）。
//
// 集成点2 范围（本次新增，任务书附录 A）：③ 一键跑数落盘（占位符替换 → 运行前双校验 → source 全量执行
//   [OT-2：mssql 流式行数上限 / mysql 缓冲行数上限] → 结果 xlsx 落盘[非 public 目录+随机名] → run 快照
//   状态机 queued→running→success/failed/empty_result → 鉴权下载端点 → 删除守卫）+ ④ 钉钉推送（手机号
//   →钉钉身份反查核对[姓名/在职状态/钉钉ID后四位]→admin 确认→发文件→push 留痕+收件人快照+批量跳过继续）。
//   不做：⑤ 前端页面（集成点3）/ ⑥ #21 真样本容量实测（主线收）。
//   helper 拆两个新文件（不塞本文件/不塞 server.js）：./runner.js（跑数引擎：日期区间/source 执行/xlsx
//   生成/结果文件安全落盘删除）+ ./recipients.js（收件人核对：手机号→钉钉身份反查+详情）。
//
// 范式来源（逐项对齐 routes/sys-iteration/index.js C1，任务书 §2 复用锚点）：
//   - readiness：PERIODIC_SCHEMA_STATE + 关键列 PRAGMA 复查 + 未就绪 503（照 sys-iteration SYS_SCHEMA_STATE）
//   - initSchema：db.serialize 顺序建表 + recordErr 兜底 + serialize 末条 callback 触发 migration
//   - 全新模块：CREATE TABLE IF NOT EXISTS 一次建全，无 ALTER（本模块生产无旧表，无需 sys-iteration 那种
//     "已上线表演进 ALTER" 分支——那是 bug 流对已上线 sys 四表的追加列场景，本模块不适用）
//   - 导出 { initSchema, router, _internals }，_internals 供 verify require 真实逻辑（RC-L2 根治复刻漂移）
//
// OT-1（SQL 最小形态校验复用，任务书 §4）：组合复用 utils/sql-validator.js 的
//   layer0_lexerScan（挡多语句/EXEC/WAITFOR/OPENROWSET/xp_/sp_）+ checkTempTable（层0.5，挡 #tmp/##tmp/
//   TEMPORARY TABLE——方案 §4.1 明确要求"禁止...临时表"，layer0+layer1 均不覆盖此项，checkTempTable 无
//   business_db/跨库耦合，可安全复用）+ layer1_parse（挡非 SELECT，含 INSERT/UPDATE/DELETE/DDL 天然解析失败或
//   非 select 顶层）。**跳过** layer2（跨库/business_db 白名单检查——任务书明确指示跳过；本模块目标库因
//   source_connection_id 而异，但 layer2_astCheck 实际上是参数化的（接收 allowedDb 非硬编码），非任务书
//   描述的"硬编码 business_db"；本次按任务书字面指示跳过，跳过的代价 = 不限制脚本内的跨库三段名引用——即
//   admin 登记的脚本可读取同一只读账号可见的其他库/表，不仅限于 source_connection_id 绑定的目标库。
//   因 §4.1 定性为"防手滑非防注入"（admin 可信输入）且 source 账号本就只读，风险可接受，但这是一个可选
//   增强点，留给主会话判断是否要在后续迭代加固（见自审报告 OT-1 结论）+ layer3（TOP 100 注入——本模块
//   要全量结果，且 #21 原脚本本身用 UNION ALL，layer3 会拒绝 UNION，与本模块目标冲突，必须跳过）。
//   ⭐ H-1（集成审补拦）：跳过 layer2 后，`SELECT ... INTO new_table`（SQL Server 建永久表写操作）会被 layer1
//     当顶层 select 放行、checkTempTable 也拦不到（它只拦 #tmp/##tmp）。故 layer1 成功后**单独补一条真 INTO
//     拦截**（对齐 sql-validator isRealInto 判据：into.expr 非空才是真 INTO，不误伤 select 的 into:{position} 空占位），
//     不恢复整个 layer2、不引入跨库白名单/TOP 注入。跨库三段名引用的收窄仍是上述可选增强点（未做）。
'use strict';
const fs = require('fs');
const express = require('express');
const sqlValidator = require('../../utils/sql-validator');
// 集成点2 新增 require（均为只读复用存量导出函数，零修改存量文件——见 recipients.js 文件头注释边界说明）：
const dingtalkNotify = require('../../utils/dingtalk-notify');
const collabSubmitHelpers = require('../../utils/collab-submit-helpers'); // 只复用 sanitizeSqlError（脱敏 helper，纯函数）
const runner = require('./runner');
const recipients = require('./recipients');

module.exports = (deps) => {
  // 工厂期 deps 校验——漏注入即启动期 throw（对齐 sys-iteration codex M-2）。
  // 集成点2 扩：getMssqlPool/getMysqlPool（source 全量执行）+ readSystemConfig（钉钉凭证）+
  //   maskPhone（日志脱敏）+ decryptPassword（db_connections.password 解密——任务书附录 A.1 未列出
  //   此项，但 collab-submit 现成范式[server.js:14412-14415]证明"解密目标库密码"是执行前必经步骤，
  //   缺它无法真正连接 source 库；自审报告已标注这是对任务书清单的补充）。
  const REQUIRED_DEPS = [
    'logger', 'db', 'dbRunAsync', 'dbGetAsync', 'dbAllAsync', 'authenticateToken', 'requireAdmin',
    'getMssqlPool', 'getMysqlPool', 'readSystemConfig', 'maskPhone', 'decryptPassword',
  ];
  for (const __k of REQUIRED_DEPS) {
    if (deps[__k] === undefined) throw new Error('routes/periodic-fetch 缺注入依赖: ' + __k);
  }
  const {
    logger, db, dbRunAsync, dbGetAsync, dbAllAsync, authenticateToken, requireAdmin,
    getMssqlPool, getMysqlPool, readSystemConfig, maskPhone, decryptPassword,
  } = deps;

  // 结果文件目录首启即建（幂等 mkdirSync recursive），保证下载/清理端点随时可用。
  runner.ensurePeriodicResultsDir();

  // 全量导出资源上限（方案 §4.2 C-1 硬约束）：10 万行 + 60s 超时，超限直接失败不隐式截断。
  const PERIODIC_MAX_ROWS = 100000;
  const PERIODIC_QUERY_TIMEOUT_MS = 60000;
  // M-2③ 僵尸 run 复位阈值：进程崩溃/中断会把 run 永久卡在 'running'。启动时把超过此时长仍 running 的
  //   批量标 failed 自愈（阈值 > 单次执行超时 60s，留足正常执行窗口，取 10 分钟）。完整心跳/定时巡检不做
  //   （内网单机 PM2，过度）。
  const STALE_RUNNING_MINUTES = 10;
  // M-1（集成审 follow-up ⑤c）：僵尸 pending push 复位阈值。push/confirm 若进程在钉钉发送返回后、终态
  //   回写前崩溃/被 PM2 拉起，push 行会永久卡 plain 'pending'（无 WRITE_FAILED 标记）→ evaluatePushIdempotency
  //   永远判 PUSH_IN_PROGRESS、force 也穿不透，该 run 从此无法再推送。启动就绪后把超阈值仍 plain pending 的
  //   批量补 WRITE_FAILED 标记（保持 pending 不变），使其从 PUSH_IN_PROGRESS 降级为可 force 恢复的 NEEDS_RECONCILE。
  //   阈值同 STALE_RUNNING_MINUTES（10 分钟，远大于正常钉钉发送耗时）。
  const STALE_PENDING_PUSH_MINUTES = 10;

  // M-3（集成审）：本模块 SQL 最小形态校验依赖 sql-validator 的 `_internal.*`（源码标"仅测试用"，非公开契约，
  //   红线禁改 sql-validator 本体）。为把"契约不满足"从**线上请求路径随机炸**提前到**启动期 fail-closed**，
  //   工厂期显式断言三个复用函数就位（layer0_lexerScan/layer1_parse/checkTempTable）；任一缺失/非函数即启动失败。
  //   后续 sql-validator 若重构删/改这几个内部导出，此断言让 PM2 首启即报错、暴露在部署阶段，而非上线后建单时才炸。
  const REQUIRED_SQL_VALIDATOR_INTERNALS = ['layer0_lexerScan', 'layer1_parse', 'checkTempTable'];
  if (!sqlValidator._internal || typeof sqlValidator._internal !== 'object') {
    throw new Error('sql-validator._internal 契约不满足: _internal 缺失或非对象（周期取数推送模块最小 SQL 校验依赖它）');
  }
  for (const __fn of REQUIRED_SQL_VALIDATOR_INTERNALS) {
    if (typeof sqlValidator._internal[__fn] !== 'function') {
      throw new Error(`sql-validator._internal 契约不满足: ${__fn} 缺失或非函数（周期取数推送模块最小 SQL 校验依赖它）`);
    }
  }

  // ============================================================
  // 一、schema readiness state + 关键列锚点常量 + 守门中间件
  // ============================================================
  const PERIODIC_SCHEMA_STATE = { ready: false, error: null };
  const PERIODIC_REQUIRED_TABLES = ['periodic_tasks', 'periodic_task_runs', 'periodic_task_pushes'];

  // readiness 是"启动期就绪抽样"，挑代表性关键列（非全字段全量校验，全量校验是 verify-periodic-schema.js 职责，
  //   对齐 sys-iteration/corrections 既有分工）。
  const PERIODIC_TASKS_KEY_COLS = ['task_name', 'source_connection_id', 'script_template', 'template_version', 'status', 'created_by', 'created_at'];
  const PERIODIC_RUNS_KEY_COLS = ['task_id', 'rendered_script', 'task_name_snapshot', 'source_connection_snapshot',
    'template_version_snapshot', 'triggered_by', 'date_range_start', 'date_range_end', 'started_at', 'status', 'file_status'];
  const PERIODIC_PUSHES_KEY_COLS = ['run_id', 'phone_snapshot', 'push_status', 'pushed_by', 'pushed_at'];

  // 守门中间件：所有 periodic-tasks 写/读入口挂在路由前（对齐 sys-iteration requireSysSchemaReady）。
  function requirePeriodicSchemaReady(req, res, next) {
    if (PERIODIC_SCHEMA_STATE.error) {
      return res.status(503).json({
        error: '周期取数推送功能暂不可用：表结构未就绪',
        detail: PERIODIC_SCHEMA_STATE.error,
        code: 'PERIODIC_SCHEMA_NOT_READY',
      });
    }
    if (!PERIODIC_SCHEMA_STATE.ready) {
      return res.status(503).json({
        error: '周期取数推送功能正在初始化，请稍后重试',
        code: 'PERIODIC_SCHEMA_INITIALIZING',
      });
    }
    next();
  }

  // ============================================================
  // 二、DDL（三表 + 索引）。建表 serialize 块包进 initSchema()，
  //   server.js 启动 db 回调内调用 periodicFetchModule.initSchema()（照 sys-iteration 挂载时序）。
  // ============================================================
  function initSchema() {
    // 建表顺序：periodic_tasks → periodic_task_runs（引用 tasks）→ periodic_task_pushes（引用 runs）。
    //   本项目 foreign_keys=OFF（核实同 sys-iteration #1），CREATE 时不校验被引用表存在；此顺序为自文档 +
    //   未来开 PRAGMA 兼容 + verify 友好，运行不依赖。
    // ⚠️ 独立 serialize 块保证 CREATE→INDEX 严格串行（CREATE INDEX 编译期校验列名，corrections.js:110 同源踩坑）。
    db.serialize(() => {
      let firstDdlError = null;
      const recordErr = (label) => (err) => {
        if (err && !firstDdlError) {
          firstDdlError = `${label}: ${err.message}`;
          logger.error(`[周期取数推送] DDL 失败 @${label}：${err.message}`);
        }
      };

      // ── 2.1 periodic_tasks（周期任务，方案 §5.1）──────────
      //   task_name 仅 active 唯一（方案 §5.1："disabled 不占名，允许改名重建"）：SQLite 部分唯一索引
      //   实现（本项目已有先例：server.js:1711 idx_collab_oa_no_unique / verify-record-quality-for-developer-submit.js）。
      db.run(`CREATE TABLE IF NOT EXISTS periodic_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        description TEXT,
        source_connection_id INTEGER NOT NULL,
        script_template TEXT NOT NULL,
        template_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        created_by INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at DATETIME
      )`, recordErr('periodic_tasks'));
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_periodic_tasks_name_active ON periodic_tasks(task_name) WHERE status='active'`, recordErr('idx_periodic_tasks_name_active'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_periodic_tasks_status ON periodic_tasks(status)`, recordErr('idx_periodic_tasks_status'));

      // ── 2.2 periodic_task_runs（执行历史 + 不可变快照，方案 §5.2）──────────
      //   集成点1 只建表，不写入（③ 一键跑数落盘是集成点2 范围）。
      db.run(`CREATE TABLE IF NOT EXISTS periodic_task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL REFERENCES periodic_tasks(id),
        rendered_script TEXT NOT NULL,
        task_name_snapshot TEXT NOT NULL,
        source_connection_snapshot TEXT NOT NULL,
        template_version_snapshot INTEGER NOT NULL,
        triggered_by INTEGER NOT NULL,
        date_range_start TEXT NOT NULL,
        date_range_end TEXT NOT NULL,
        started_at DATETIME NOT NULL,
        finished_at DATETIME,
        duration_ms INTEGER,
        row_count INTEGER,
        result_file_path TEXT,
        file_status TEXT DEFAULT 'present' CHECK (file_status IN ('present','cleaned','missing')),
        status TEXT NOT NULL CHECK (status IN ('queued','running','success','failed','empty_result')),
        error_msg TEXT
      )`, recordErr('periodic_task_runs'));
      db.run(`CREATE INDEX IF NOT EXISTS idx_periodic_runs_task_started ON periodic_task_runs(task_id, started_at DESC)`, recordErr('idx_periodic_runs_task_started'));

      // ── 2.3 periodic_task_pushes（推送留痕 + 收件人快照，方案 §5.3）──────────
      //   集成点1 只建表，不写入（④ 推送是集成点2 范围）。
      db.run(`CREATE TABLE IF NOT EXISTS periodic_task_pushes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES periodic_task_runs(id),
        phone_snapshot TEXT NOT NULL,
        recipient_name_snapshot TEXT,
        dingtalk_user_id_snapshot TEXT,
        push_status TEXT NOT NULL CHECK (push_status IN ('pending','success','failed','skipped')),
        push_error TEXT,
        pushed_by INTEGER NOT NULL,
        pushed_at DATETIME NOT NULL
      )`, recordErr('periodic_task_pushes'));
      // ⚠️ 最后一个 DDL 的 callback 触发 migration（时序铁律，corrections.js/sys-iteration 同源：必须由
      //   serialize 块内最后一个 db.run callback 触发，否则 PRAGMA 与队列里 CREATE TABLE 竞态 → 永久 false）。
      db.run(`CREATE INDEX IF NOT EXISTS idx_periodic_pushes_run_pushed ON periodic_task_pushes(run_id, pushed_at DESC)`, (err) => {
        recordErr('idx_periodic_pushes_run_pushed')(err);
        runPeriodicMigration(firstDdlError);
      });
    });
  }

  // ── schema 就绪探测（全新模块，无 ALTER；对齐 sys-iteration C1 首版逻辑）─────────────────
  async function runPeriodicMigration(ddlError) {
    try {
      PERIODIC_SCHEMA_STATE.ready = false;

      if (ddlError) {
        PERIODIC_SCHEMA_STATE.error = `建表 DDL 失败：${ddlError}`;
        logger.error(`[周期取数推送] 🚫 ${PERIODIC_SCHEMA_STATE.error} → periodic-* 写入口将返 503`);
        return;
      }

      // [1] 三表存在性
      const tables = await new Promise((resolve, reject) => {
        db.all(
          "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('periodic_tasks','periodic_task_runs','periodic_task_pushes')",
          (err, rows) => err ? reject(err) : resolve((rows || []).map(r => r.name))
        );
      });
      const missingTables = PERIODIC_REQUIRED_TABLES.filter(t => !tables.includes(t));
      if (missingTables.length > 0) {
        PERIODIC_SCHEMA_STATE.error = `周期取数推送表缺失：${missingTables.join(',')}`;
        logger.error(`[周期取数推送] 🚫 ${PERIODIC_SCHEMA_STATE.error} → periodic-* 写入口将返 503`);
        return;
      }

      // [2] 三表关键列 PRAGMA 复查
      const checks = [
        ['periodic_tasks', PERIODIC_TASKS_KEY_COLS],
        ['periodic_task_runs', PERIODIC_RUNS_KEY_COLS],
        ['periodic_task_pushes', PERIODIC_PUSHES_KEY_COLS],
      ];
      for (const [tbl, keyCols] of checks) {
        const cols = await new Promise((resolve, reject) => {
          db.all(`PRAGMA table_info(${tbl})`, (err, rows) => err ? reject(err) : resolve(rows));
        });
        if (!cols || cols.length === 0) {
          PERIODIC_SCHEMA_STATE.error = `无法读取 ${tbl} 表结构（PRAGMA 失败）`;
          logger.error(`[周期取数推送] 🚫 ${PERIODIC_SCHEMA_STATE.error}`);
          return;
        }
        const colNames = cols.map(c => c.name);
        const missingCols = keyCols.filter(c => !colNames.includes(c));
        if (missingCols.length > 0) {
          PERIODIC_SCHEMA_STATE.error = `${tbl} 关键列缺失：${missingCols.join(',')}`;
          logger.error(`[周期取数推送] 🚫 ${PERIODIC_SCHEMA_STATE.error} → periodic-* 写入口将返 503`);
          return;
        }
      }

      // [3] 全部就位 → 置 ready
      PERIODIC_SCHEMA_STATE.error = null;
      PERIODIC_SCHEMA_STATE.ready = true;
      logger.info(`[周期取数推送] ✅ 三表就绪（${tables.length}/3 表 + 关键列锚点齐全），写入口放行。`);

      // M-2③ 僵尸 run 复位（best-effort，失败不影响 readiness）：进程若在上次执行中途崩溃，run 会永久
      //   卡 running。启动就绪后一次性把超阈值仍 running 的批量标 failed（自愈复位）。
      await reapStaleRunningRuns();
      // M-1（⑤c）僵尸 pending push 复位（best-effort）：进程在钉钉发送返回后、终态回写前崩溃 → push 行
      //   永久卡 plain pending。启动就绪后把超阈值 plain pending 补 WRITE_FAILED 标记（保持 pending），
      //   降级为可 force 恢复的 NEEDS_RECONCILE，闭合崩溃窗口。
      //   ⚠️ 仅此处（启动 readiness 阶段）调用——STARTUP-ONLY 契约见函数头注释（codex 08 H-1），
      //     禁运行期/定时巡检复用（会误标真在途 pending → force 二次发重复投递敏感文件）。
      await reapStalePendingPushes();
    } catch (e) {
      PERIODIC_SCHEMA_STATE.ready = false;
      PERIODIC_SCHEMA_STATE.error = `迁移异常：${e && e.message}`;
      logger.error(`[周期取数推送] 🚫 ${PERIODIC_SCHEMA_STATE.error}`);
    }
  }

  // ── M-2③ 僵尸 run reaper（启动一次性自愈复位）─────────────────
  //   把 status='running' 且 started_at 早于 (now - STALE_RUNNING_MINUTES) 的 run 批量标 failed。
  //   双条件守卫 status='running' 保证只动僵尸行、不误伤正常终态行。started_at 用 localtime 与写入口一致。
  //   ⚠️ 已知残留：崩溃发生在"结果文件已写盘但终态 UPDATE 未落库"的窗口时，result_file_path 在 DB 里仍为
  //     NULL（终态 UPDATE 才写该列），reaper 拿不到路径无法删该孤儿文件——这类无引用孤儿只能靠后续
  //     目录级定时清理兜底（任务书附录 A.2 defer）。reaper 仅负责状态复位，不负责文件回收。
  async function reapStaleRunningRuns() {
    try {
      const result = await dbRunAsync(
        `UPDATE periodic_task_runs
            SET status='failed',
                finished_at=datetime('now','localtime'),
                error_msg='疑似进程中断，启动自愈复位（run 曾卡 running 超阈值）'
          WHERE status='running'
            AND started_at < datetime('now','localtime','-${STALE_RUNNING_MINUTES} minutes')`
      );
      if (result && result.changes > 0) {
        logger.warn(`[周期取数推送] M-2③ 启动复位：${result.changes} 个僵尸 running run 已标 failed（疑似上次进程中断）`);
      }
    } catch (e) {
      logger.error(`[周期取数推送] M-2③ 僵尸 run 复位失败（不影响启动）：${e && e.message}`);
    }
  }

  // ── M-1（⑤c）僵尸 pending push reaper（启动一次性自愈复位）─────────────────
  //   把 push_status='pending' 且尚无 WRITE_FAILED 标记（push_error IS NULL 或不以 WRITE_FAILED 开头）
  //   且 pushed_at 早于 (now - STALE_PENDING_PUSH_MINUTES) 的 push 行，补 push_error='WRITE_FAILED:stale_reaped'。
  //   ⚠️ 保持 push_status='pending' 不变（只补标记）：这样 evaluatePushIdempotency 把它从 PUSH_IN_PROGRESS
  //     降级为 NEEDS_RECONCILE（可 force 恢复），对齐 M 语义——崩溃卡死的 pending 不再永久阻断该 run 的推送。
  //   三条守卫：push_status='pending'（只动卡死行）+ 无 WRITE_FAILED 标记（不重复标记已知卡死行）+
  //     pushed_at 超阈值（不误伤刚插入正在途的 pending）。pushed_at 用 localtime 与写入口一致。
  //
  //   ⚠️⚠️ STARTUP-ONLY 契约（codex 08 H-1，必须遵守，勿破坏）：本函数**只能在启动 readiness 阶段调用一次**。
  //     其安全性依赖一个隐含前提——启动时进程刚拉起、无任何 in-flight push，此刻表里所有 pending 都必然是
  //     上次进程崩溃遗留的僵尸行，"pushed_at 年龄超阈值"足以判定僵尸。**严禁把它复用到运行期/定时巡检/管理
  //     脚本**：运行期有真在途的 push（钉钉发送 + 终态回写正常进行中），若某次发送恰好耗时超阈值，会被本函数
  //     误标 WRITE_FAILED → admin 见 NEEDS_RECONCILE 后 force 二次发 → **同一 run 对同一收件人重复投递含
  //     身份证/银行账号的敏感文件**。若将来确需运行期巡检版，不能只看 pushed_at 年龄，必须引入"产生该 pending
  //     的 worker/进程已确定失活"的额外证据（如 worker 心跳表 / 进程 epoch 标记），本函数不承担那个职责。
  async function reapStalePendingPushes() {
    try {
      const result = await dbRunAsync(
        `UPDATE periodic_task_pushes
            SET push_error='WRITE_FAILED:stale_reaped'
          WHERE push_status='pending'
            AND (push_error IS NULL OR push_error NOT LIKE 'WRITE_FAILED%')
            AND pushed_at < datetime('now','localtime','-${STALE_PENDING_PUSH_MINUTES} minutes')`
      );
      if (result && result.changes > 0) {
        logger.warn(`[周期取数推送] M-1 启动复位：${result.changes} 个僵尸 pending push 已补 WRITE_FAILED 标记（疑似发送后进程中断，可 force 重发对账）`);
      }
    } catch (e) {
      logger.error(`[周期取数推送] M-1 僵尸 pending push 复位失败（不影响启动）：${e && e.message}`);
    }
  }

  // ============================================================
  // 三、helper：actor / id 解析 / source 连接解析（对齐 sys-iteration sysActor/parsePositiveId 范式）
  // ============================================================
  function periodicActor(req) {
    return {
      id: Number(req.user.id),
      name: req.user.display_name || req.user.username || `user#${req.user.id}`,
      role: req.user.role,
    };
  }

  function parsePositiveId(v) {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  // 校验 source_connection_id 指向合法的只读 source 连接（照 server.js:12502 SELECT 列口径），
  //   返回 { id, name, type } 供 SQL 最小形态校验按方言路由；不存在/非 source/方言不支持 → null。
  async function resolvePeriodicSourceConnection(sourceConnectionId) {
    const row = await dbGetAsync(
      `SELECT id, name, type FROM db_connections WHERE id = ? AND connection_type = 'source' AND type IN ('sqlserver', 'mysql')`,
      [sourceConnectionId]
    );
    return row || null;
  }

  // 取执行所需完整连接信息（含加密密码），供 ③ 一键跑数使用；照 server.js:14313-14318 collab-submit
  //   SELECT 列口径（同一张 db_connections 表，同一套 source 筛选条件，仅多取 host/port/database/
  //   username/password 用于真连接，集成点1 的 resolvePeriodicSourceConnection 只取 id/name/type 供
  //   校验用，两者职责不同不合并，避免校验路径意外携带密码字段扩大暴露面）。
  async function fetchFullSourceConnection(sourceConnectionId) {
    return dbGetAsync(
      `SELECT id, name, type, host, port, database, username, password
         FROM db_connections
        WHERE id = ? AND connection_type = 'source' AND type IN ('sqlserver', 'mysql')`,
      [sourceConnectionId]
    );
  }

  // ============================================================
  // 三.1、③ 一键跑数 helper（占位符渲染 / 执行失败文案 / 钉钉凭证获取 / 推送前置判定）
  // ============================================================
  // 纯字符串 replaceAll（方案 §3.5：模板脚本是 admin 登记的可信来源，占位符替换用最简单的字符串替换，
  //   不用正则——split/join 避免正则特殊字符转义问题，且占位符固定字面量无需正则能力）。
  function renderPlaceholders(template, dateRange) {
    return template
      .split('{{MONTH_START}}').join(dateRange.start)
      .split('{{MONTH_END}}').join(dateRange.end);
  }

  function describeExecFailure(outcome) {
    if (outcome.code === 'ROW_LIMIT_EXCEEDED') {
      return `结果行数超过上限（>${PERIODIC_MAX_ROWS} 行），请缩小日期范围或拆分任务`;
    }
    if (outcome.code === 'QUERY_TIMEOUT') {
      return `执行超时（>${PERIODIC_QUERY_TIMEOUT_MS / 1000} 秒），请缩小范围或联系管理员调整脚本`;
    }
    if (outcome.code === 'DUPLICATE_COLUMNS') {
      // E-1：宁可失败不可静默丢敏感列。有具名重复列（mysql）就列出，mssql 折叠拿不到名字只报存在重名。
      const dup = Array.isArray(outcome.duplicateColumns) && outcome.duplicateColumns.length
        ? `（重复列：${outcome.duplicateColumns.join('、')}）` : '';
      return `结果集含同名输出列${dup}，会导致数据列丢失，请在 SQL 里为重复列加列别名（如 a.id AS a_id, b.id AS b_id）后重跑`;
    }
    if (outcome.code === 'CONN_DECRYPT_FAILED') {
      return (outcome.error && outcome.error.message) || '目标库密码解密失败，请联系管理员检查连接配置';
    }
    const raw = outcome.error ? (outcome.error.message || String(outcome.error)) : '未知错误';
    return collabSubmitHelpers.sanitizeSqlError(raw);
  }

  // ============================================================
  // 三.2、④ 推送 helper（钉钉凭证获取 / run 可推送前置判定，方案 §6.1）
  // ============================================================
  async function getPeriodicDingtalkToken() {
    const [appKey, appSecret, robotCode] = await Promise.all(
      ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code'].map(readSystemConfig)
    );
    if (!appKey || !appSecret || !robotCode) return { ok: false, reason: 'no_config' };
    try {
      const token = await dingtalkNotify.getAccessToken(appKey, appSecret);
      return { ok: true, token, robotCode };
    } catch (err) {
      return { ok: false, reason: dingtalkNotify.classifyError(err).reason };
    }
  }

  // 可推送前置条件（方案 §6.1 定死）：仅 success 且 file present 才可推；empty_result 默认不可推
  //   （需 confirmEmpty 显式覆盖）；failed 不可推、不复用旧文件；running/queued 尚未完成不可推。
  function checkRunPushable(run, opts) {
    const confirmEmpty = !!(opts && opts.confirmEmpty);
    if (!run) return { ok: false, status: 404, error: 'run 记录不存在', code: 'PERIODIC_RUN_NOT_FOUND' };
    if (run.status === 'failed') {
      return { ok: false, status: 409, error: '失败的 run 不可推送（未生成有效结果文件）', code: 'RUN_FAILED_NOT_PUSHABLE' };
    }
    if (run.status === 'running' || run.status === 'queued') {
      return { ok: false, status: 409, error: 'run 尚未执行完成，暂不可推送', code: 'RUN_IN_PROGRESS' };
    }
    if (run.status === 'empty_result' && !confirmEmpty) {
      return { ok: false, status: 409, error: '本次结果为 0 行，如确认要发送空结果请显式确认（confirm_empty=true）', code: 'EMPTY_RESULT_CONFIRM_REQUIRED' };
    }
    if (run.file_status !== 'present') {
      return { ok: false, status: 409, error: '结果文件已过期或缺失，请重新跑本月', code: 'FILE_NOT_PRESENT' };
    }
    return { ok: true };
  }

  // ── H-new 幂等状态判定（供事务内调用，防并发竞态）─────────────────
  //   复审 H-new：仅查 success 拦不住"首个 confirm 已插 pending 但尚未写 success"时的并发第二请求。
  //   故改为在两阶段的 BEGIN IMMEDIATE 事务内一次性 SELECT 全部 push 状态，判 pending / success：
  //   - 已有 pending 且**无** WRITE_FAILED 标记 → PUSH_IN_PROGRESS（无论 force，防双击/慢响应重试重发敏感文件；
  //     这种 pending 可能是真正在途的发送，不能让 force 穿透）
  //   - 已有 pending 且带 WRITE_FAILED 标记（M，集成点3：阶段三回写失败时打的标记，见下方发送阶段三注释）→
  //     NEEDS_RECONCILE——区别于上面"真在途"的 PUSH_IN_PROGRESS：这种 pending 已确定不会再自愈（钉钉大概率
  //     已投递但 DB 回写失败），语义上更接近"需人工对账"而非"正在进行"；force=true 可覆盖放行重发（镜像
  //     ALREADY_PUSHED 的 force 语义）。⚠️ 自审 flag：force 覆盖 NEEDS_RECONCILE 是否合适（默认 yes），
  //     留给主会话/用户确认，见集成点3 自审报告。
  //   - 已有 success 且非 force → ALREADY_PUSHED
  //   本 helper 只做纯判定（不查库，入参为事务内已 SELECT 的行，含 push_status + push_error），保证
  //   "查+插同一事务原子"。
  function evaluatePushIdempotency(existingRows, force) {
    const isReconcileFlagged = (r) => typeof r.push_error === 'string' && r.push_error.indexOf('WRITE_FAILED') === 0;
    const pendingRows = existingRows.filter((r) => r.push_status === 'pending');
    const hasPlainPending = pendingRows.some((r) => !isReconcileFlagged(r));
    const hasReconcilePending = pendingRows.some(isReconcileFlagged);
    const hasSuccess = existingRows.some((r) => r.push_status === 'success');
    if (hasPlainPending) {
      return { blocked: true, status: 409, code: 'PUSH_IN_PROGRESS', error: '上一次推送正在进行，请勿重复点击' };
    }
    if (hasReconcilePending && !force) {
      return { blocked: true, status: 409, code: 'NEEDS_RECONCILE', error: '上次投递状态未落库、需人工对账，如确认重发请显式确认（force=true）' };
    }
    if (hasSuccess && !force) {
      return { blocked: true, status: 409, code: 'ALREADY_PUSHED', error: '本 run 已有成功推送留痕，如确需重发请显式确认（force=true）' };
    }
    return { blocked: false };
  }

  // ── L-new 归一化字符串比对（NFC + trim，吸收前端 trim/Unicode 不可见字符差异）─────────────
  function normalizeForCompare(s) {
    return String(s == null ? '' : s).normalize('NFC').trim();
  }

  // ── H-1 + L-new 收件人核对：fresh 反查结果与 preview 期望快照比对 ─────────────
  //   L-new：userid 作硬 gate（钉钉唯一身份，一致即达防错发目的）——userid 不一致才 RECIPIENT_MISMATCH 拒发；
  //   name/last4 用归一化比对，不一致**不拒发**、只标 drift（供 admin 知晓 preview 后有非关键变动），
  //   避免前端 trim/NFC 差异把合法收件人误判 MISMATCH。
  //   返回 { match: bool（userid 硬 gate）, drift: bool（name/last4 归一化后仍不一致）}。
  function compareRecipientSnapshot(fresh, expected) {
    if (!fresh || !expected) return { match: false, drift: false };
    if (String(fresh.userid) !== String(expected.userid)) return { match: false, drift: false };
    const drift = normalizeForCompare(fresh.name) !== normalizeForCompare(expected.name)
      || normalizeForCompare(fresh.dingUserIdLast4) !== normalizeForCompare(expected.last4);
    return { match: true, drift };
  }

  // ── M-1 手机号归一化去重（保序，返回去重后数组 + 被丢弃数）─────────────
  function dedupeByNormalizedPhone(rawList) {
    const seen = new Set();
    const kept = [];
    let dropped = 0;
    for (const item of rawList) {
      const phone = recipients.normalizePhone(typeof item === 'string' ? item : (item && item.phone));
      if (seen.has(phone)) { dropped++; continue; }
      seen.add(phone);
      kept.push(item);
    }
    return { kept, dropped };
  }

  // ============================================================
  // 四、占位符校验（方案 §3.4）
  // ============================================================
  const SUPPORTED_PLACEHOLDERS = ['MONTH_START', 'MONTH_END'];
  const SUPPORTED_PLACEHOLDER_TOKENS = SUPPORTED_PLACEHOLDERS.map(p => `{{${p}}}`);   // '{{MONTH_START}}' / '{{MONTH_END}}'
  // M-2（集成审）：保存期宽扫所有 {{...}} 片段（含畸形 {{MONTH-END}}（连字符）/ {{ MONTH_END }}（内嵌空格）），
  //   再逐个判**原始片段 token 是否严格 === 受支持 token**，否则一律 UNKNOWN_PLACEHOLDER——把畸形变体在保存期
  //   就拦下，不拖到运行前才炸（旧正则 /\{\{([A-Za-z0-9_]*)\}\}/ 抓不到含连字符/空格的畸形片段，与合法占位符
  //   共存时会蒙混过关，违背方案 §3.4「保存时直接报」）。严格区分大小写（小写变体也走 UNKNOWN，不静默归一）。
  const PLACEHOLDER_SCAN_RE = /\{\{[^}]+\}\}/g;

  // 保存任务时的静态校验：① 不含未知/畸形占位符 ② 至少含一个受支持占位符 ③ 占位符须单引号包裹
  //   （SQL Server 日期字面量需要引号，裸占位符替换后会变成非法/歧义表达式，方案 §3.4 M-1）。
  //   顺序（集成审 M-2）：未知/畸形检查**先于**「至少一个」——保证「仅含 {{MONTH-END}} 畸形」的模板报
  //   UNKNOWN_PLACEHOLDER（而非 NO_PLACEHOLDER_FOUND），合法+畸形共存也报 UNKNOWN。
  function validateTemplatePlaceholders(template) {
    if (typeof template !== 'string' || !template.trim()) {
      return { ok: false, reason: '模板脚本为空', code: 'TEMPLATE_EMPTY' };
    }
    const found = [];
    let m;
    PLACEHOLDER_SCAN_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_SCAN_RE.exec(template)) !== null) {
      const raw = m[0];   // 含双大括号的完整片段，如 '{{MONTH_START}}' / '{{MONTH-END}}' / '{{ MONTH_END }}'
      found.push({ raw, startIdx: m.index, endIdx: m.index + raw.length });
    }
    // ① 未知/畸形占位符先拦（严格 token 相等判据）：任一片段不严格等于受支持 token → UNKNOWN_PLACEHOLDER
    const unknown = found.filter(f => !SUPPORTED_PLACEHOLDER_TOKENS.includes(f.raw));
    if (unknown.length > 0) {
      const names = [...new Set(unknown.map(f => f.raw))].join('、');
      return {
        ok: false,
        reason: `模板脚本包含未知或畸形占位符：${names}（v1.0 仅支持 {{MONTH_START}} / {{MONTH_END}}，须严格拼写、无空格/连字符/大小写差异）`,
        code: 'UNKNOWN_PLACEHOLDER',
      };
    }
    // ①-b 残留花括号痕迹检查（集成审复审 M-2b 收口）：宽扫正则 /\{\{[^}]+\}\}/g 只命中"非空且闭合 }}"的片段，
    //   漏了结构畸形括号——空体 {{}} / 不闭合 {{MONTH_START / 多余右括号 {{MONTH_START}}}} / 合法+{{}} 共存。
    //   消费掉所有**合法 token** 后，若剩余串仍含 `{{` 或 `}}`，即结构畸形 → UNKNOWN_PLACEHOLDER（畸形保存期拦下）。
    //   ⚠️ 位置铁律：必须在 unknown 检查之后（合法 token 先由上面确认，此处才能安全消费）、
    //     NO_PLACEHOLDER_FOUND 之前——否则 `{{}}` only 会先落 NO_PLACEHOLDER_FOUND 而非畸形。
    {
      let consumed = template;
      for (const tok of SUPPORTED_PLACEHOLDER_TOKENS) consumed = consumed.split(tok).join('');
      if (consumed.includes('{{') || consumed.includes('}}')) {
        return {
          ok: false,
          reason: "模板含残缺/畸形占位符括号（空 {{}} / 不闭合 {{ / 多余括号 }} 等），请改成规范的 '{{MONTH_START}}' / '{{MONTH_END}}'",
          code: 'UNKNOWN_PLACEHOLDER',
        };
      }
    }
    // ② 至少含一个受支持占位符（走到这里 found 全是严格受支持 token）
    if (found.length === 0) {
      return {
        ok: false,
        reason: '模板脚本未包含任何受支持的占位符（{{MONTH_START}} / {{MONTH_END}}），周期任务无意义',
        code: 'NO_PLACEHOLDER_FOUND',
      };
    }
    // ③ 单引号包裹强制（基于精确命中片段位置判断前后字符）
    const unquoted = found.filter(f => template[f.startIdx - 1] !== "'" || template[f.endIdx] !== "'");
    if (unquoted.length > 0) {
      const names = [...new Set(unquoted.map(f => f.raw))].join('、');
      return {
        ok: false,
        reason: `占位符 ${names} 未用单引号包裹（应写作 '{{MONTH_START}}' / '{{MONTH_END}}'，SQL Server 日期字面量需要引号）`,
        code: 'PLACEHOLDER_NOT_QUOTED',
      };
    }
    return { ok: true, placeholders: [...new Set(found.map(f => f.raw.slice(2, -2)))] };   // 去 {{ }} 还原占位符名
  }

  // 运行前校验：占位符替换后不得残留任何 {{...}}（③ 一键跑数是集成点2 范围，本函数先备好，
  //   verify-periodic-placeholder.js 按任务书 §5 集成点1 断言覆盖"残留拒"）。
  const RESIDUAL_PLACEHOLDER_RE = /\{\{[^}]*\}\}/;
  function checkNoResidualPlaceholders(renderedSql) {
    if (typeof renderedSql === 'string' && RESIDUAL_PLACEHOLDER_RE.test(renderedSql)) {
      return { ok: false, reason: '替换后仍残留未解析的占位符（{{...}}），拒绝执行', code: 'PLACEHOLDER_RESIDUAL' };
    }
    return { ok: true };
  }

  // ── H-1（集成审）：真 INTO 建表检测（SELECT ... INTO new_table 是 SQL Server 建永久表写操作）─────────
  //   背景：跳过 layer2 后，`SELECT * INTO t2 FROM t1` 被 layer1 当顶层 select 放行，checkTempTable 只拦
  //     #tmp/##tmp、拦不到普通 INTO → 违背方案 §4.1「禁 DDL/建表」。不恢复整个 layer2（不引入跨库白名单/TOP
  //     注入），只补这一条 INTO 判据。
  //   判据来源：对齐 sql-validator.js 的 isRealInto（`into.expr != null` 才是真 INTO，无 INTO 的 select
  //     node-sql-parser 给 `into:{position}` 空占位——只有 position 无 expr，不能误伤）+ walkSelectNodes（递归
  //     所有 select 节点，含 CTE 内部 / UNION 链 / 子查询）。isRealInto/walkSelectNodes 未在 _internal 导出，
  //     故按同一判据在本模块内实现小工具（非复刻业务逻辑，是复用一个 2 行的结构判据）。
  function isRealInto(intoNode) {
    return !!(intoNode && typeof intoNode === 'object' && 'expr' in intoNode && intoNode.expr != null);
  }
  // 递归遍历 layer1_parse 返回的 ast，任一 select 节点带真 INTO 即返回 true（WeakSet 防环）。
  function astHasRealInto(root) {
    const seen = new WeakSet();
    let found = false;
    function walk(node) {
      if (found) return;
      if (!node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const it of node) walk(it); return; }
      if (node.type === 'select' && isRealInto(node.into)) { found = true; return; }
      for (const v of Object.values(node)) walk(v);
    }
    walk(root);
    return found;
  }

  // ============================================================
  // 五、最小 SQL 形态校验（方案 §4.1，OT-1 结论：组合复用 sql-validator layer0 + checkTempTable(层0.5) +
  //   layer1 + 真 INTO 拦截(H-1)，跳过 layer2 的跨库白名单/layer3 的 TOP 注入——详见文件头注释）
  // ============================================================
  function validatePeriodicSqlForm(sql, dialect) {
    dialect = dialect || 'sqlserver';
    if (dialect !== 'sqlserver' && dialect !== 'mysql') {
      return { ok: false, reason: `不支持的方言：${dialect}（仅支持 sqlserver/mysql）`, code: 'UNSUPPORTED_DIALECT' };
    }
    if (typeof sql !== 'string' || !sql.trim()) {
      return { ok: false, reason: 'SQL 为空', code: 'SQL_EMPTY' };
    }
    const layer0 = sqlValidator._internal.layer0_lexerScan(sql, dialect);
    if (!layer0.ok) {
      return { ok: false, reason: layer0.reason, code: 'SQL_FORM_REJECTED', layer: 0 };
    }
    // v1.79.0 前导分号剥离同款处理（sql-validator.js validateAndTransform 同逻辑）：仅 sqlserver 的
    //   ;WITH 合法前导分号在 layer0 已识别位置，此处按同一位置删字符再喂 layer1/checkTempTable，
    //   避免正则与 layer0 token 判断产生两套不一致。
    const pos = layer0.leadingSemicolonStart;
    const stripped = (pos != null) ? (sql.slice(0, pos) + sql.slice(pos + 1)) : sql;

    const tempCheck = sqlValidator._internal.checkTempTable(stripped, dialect);
    if (!tempCheck.ok) {
      // checkTempTable 原文案面向 smoke（"smoke test 不支持..."），本模块借用同一 helper 但不是 smoke，
      // 改写前缀避免 admin 看到无关的"smoke test"字样造成困惑（不改 sql-validator.js 本体，只在本模块内改写展示文案）。
      const reason = tempCheck.reason.replace(/^smoke test\s*/, '本模块');
      return { ok: false, reason, code: tempCheck.code || 'SQL_FORM_REJECTED', layer: 0.5 };
    }

    const layer1 = sqlValidator._internal.layer1_parse(stripped, dialect);
    if (!layer1.ok) {
      return { ok: false, reason: layer1.reason, detail: layer1.detail, code: 'SQL_FORM_REJECTED', layer: 1 };
    }
    // H-1（集成审）：layer1 拿到 ast（层1 成功返回 { ok, ast }）后拦真 INTO 建表——SELECT INTO 是 SQL Server
    //   建永久表写操作，layer1 会把它当顶层 select 放行，此处补拦（对齐方案 §4.1「禁 DDL/建表」）。
    if (astHasRealInto(layer1.ast)) {
      return { ok: false, reason: '检测到 SELECT ... INTO 建表，本模块只接收只读查询，不允许建表/写操作', code: 'SQL_FORM_REJECTED', layer: 1.5 };
    }
    return { ok: true };
  }

  // ============================================================
  // 六、路由（任务 CRUD，② 集成点1 范围）
  // ============================================================
  const router = express.Router();

  // 健康探针（仅 verify/部署确认 readiness 状态）。M-1（集成审）：加 requireAdmin，对齐方案 §4.3
  //   「所有端点 requireAdmin」（仅 admin 可见可操作，探针也不例外）。不挂 requirePeriodicSchemaReady——
  //   探针本就用于报告 readiness 状态，须在未就绪时也能返回。
  router.get('/periodic-tasks/_readiness', authenticateToken, requireAdmin, (req, res) => {
    res.json({ ready: PERIODIC_SCHEMA_STATE.ready, error: PERIODIC_SCHEMA_STATE.error });
  });

  // ── POST /periodic-tasks：登记任务（admin）──────────
  router.post('/periodic-tasks', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const b = req.body || {};
    try {
      const taskName = (typeof b.task_name === 'string') ? b.task_name.trim() : '';
      if (!taskName) return res.status(400).json({ error: '任务名不能为空', code: 'TASK_NAME_REQUIRED' });

      const sourceConnectionId = parsePositiveId(b.source_connection_id);
      if (!sourceConnectionId) {
        return res.status(400).json({ error: '目标库连接 ID 非法', code: 'INVALID_SOURCE_CONNECTION_ID' });
      }
      const connRow = await resolvePeriodicSourceConnection(sourceConnectionId);
      if (!connRow) {
        return res.status(400).json({ error: '目标库连接不存在或非只读 source 连接', code: 'SOURCE_CONNECTION_NOT_FOUND' });
      }

      const scriptTemplate = (typeof b.script_template === 'string') ? b.script_template : '';
      const placeholderCheck = validateTemplatePlaceholders(scriptTemplate);
      if (!placeholderCheck.ok) {
        return res.status(400).json({ error: placeholderCheck.reason, code: placeholderCheck.code });
      }
      const sqlCheck = validatePeriodicSqlForm(scriptTemplate, connRow.type);
      if (!sqlCheck.ok) {
        return res.status(400).json({ error: sqlCheck.reason, code: sqlCheck.code || 'SQL_FORM_REJECTED', detail: sqlCheck.detail });
      }

      const description = (typeof b.description === 'string' && b.description.trim()) ? b.description.trim() : null;
      const actor = periodicActor(req);

      let newId;
      try {
        const result = await dbRunAsync(
          `INSERT INTO periodic_tasks (task_name, description, source_connection_id, script_template, template_version, status, created_by)
           VALUES (?, ?, ?, ?, 1, 'active', ?)`,
          [taskName, description, sourceConnectionId, scriptTemplate, actor.id]
        );
        newId = result.lastID;
      } catch (dbErr) {
        if (/UNIQUE/i.test(dbErr.message)) {
          return res.status(409).json({ error: `任务名「${taskName}」已存在启用中的同名任务`, code: 'TASK_NAME_CONFLICT' });
        }
        throw dbErr;
      }
      res.status(201).json({ id: newId, task_name: taskName, status: 'active', template_version: 1 });
    } catch (err) {
      logger.error('[周期取数推送] 建任务失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '建任务失败' });
    }
  });

  // ── PUT /periodic-tasks/:id：改任务（模板改 → template_version+1，admin）──────────
  //   status 字段不走本端点改（用户须走 /disable，见下方端点，职责分离）。
  router.put('/periodic-tasks/:id', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的任务 ID', code: 'INVALID_TASK_ID' });
    const b = req.body || {};
    if (b.status !== undefined) {
      return res.status(400).json({
        error: '状态变更请使用禁用端点（POST /periodic-tasks/:id/disable），编辑接口不支持直接改状态',
        code: 'STATUS_CHANGE_NOT_ALLOWED_HERE',
      });
    }
    try {
      const existing = await dbGetAsync(`SELECT * FROM periodic_tasks WHERE id = ?`, [id]);
      if (!existing) return res.status(404).json({ error: '周期任务不存在', code: 'PERIODIC_TASK_NOT_FOUND' });

      const taskName = (b.task_name !== undefined)
        ? (typeof b.task_name === 'string' ? b.task_name.trim() : '')
        : existing.task_name;
      if (!taskName) return res.status(400).json({ error: '任务名不能为空', code: 'TASK_NAME_REQUIRED' });

      const description = (b.description !== undefined)
        ? ((typeof b.description === 'string' && b.description.trim()) ? b.description.trim() : null)
        : existing.description;

      let sourceConnectionId = existing.source_connection_id;
      if (b.source_connection_id !== undefined) {
        sourceConnectionId = parsePositiveId(b.source_connection_id);
        if (!sourceConnectionId) {
          return res.status(400).json({ error: '目标库连接 ID 非法', code: 'INVALID_SOURCE_CONNECTION_ID' });
        }
      }
      const connRow = await resolvePeriodicSourceConnection(sourceConnectionId);
      if (!connRow) {
        return res.status(400).json({ error: '目标库连接不存在或非只读 source 连接', code: 'SOURCE_CONNECTION_NOT_FOUND' });
      }

      const scriptChanged = (b.script_template !== undefined)
        && typeof b.script_template === 'string'
        && b.script_template !== existing.script_template;
      const scriptTemplate = scriptChanged ? b.script_template : existing.script_template;

      // 模板或连接方言任一变化都重新双校验（防遗留脚本对新连接方言非法，或编辑后占位符/形态被破坏）。
      const placeholderCheck = validateTemplatePlaceholders(scriptTemplate);
      if (!placeholderCheck.ok) {
        return res.status(400).json({ error: placeholderCheck.reason, code: placeholderCheck.code });
      }
      const sqlCheck = validatePeriodicSqlForm(scriptTemplate, connRow.type);
      if (!sqlCheck.ok) {
        return res.status(400).json({ error: sqlCheck.reason, code: sqlCheck.code || 'SQL_FORM_REJECTED', detail: sqlCheck.detail });
      }

      const newVersion = scriptChanged ? existing.template_version + 1 : existing.template_version;

      try {
        await dbRunAsync(
          `UPDATE periodic_tasks
              SET task_name = ?, description = ?, source_connection_id = ?, script_template = ?,
                  template_version = ?, updated_at = datetime('now','localtime')
            WHERE id = ?`,
          [taskName, description, sourceConnectionId, scriptTemplate, newVersion, id]
        );
      } catch (dbErr) {
        if (/UNIQUE/i.test(dbErr.message)) {
          return res.status(409).json({ error: `任务名「${taskName}」已被其他启用中任务占用`, code: 'TASK_NAME_CONFLICT' });
        }
        throw dbErr;
      }
      res.json({ id, task_name: taskName, template_version: newVersion, script_changed: scriptChanged });
    } catch (err) {
      logger.error('[周期取数推送] 改任务失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '改任务失败' });
    }
  });

  // ── POST /periodic-tasks/:id/disable：禁用（admin，状态机双守卫 + changes 检查 + 幂等）──────────
  router.post('/periodic-tasks/:id/disable', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的任务 ID', code: 'INVALID_TASK_ID' });
    try {
      const existing = await dbGetAsync(`SELECT id, status FROM periodic_tasks WHERE id = ?`, [id]);
      if (!existing) return res.status(404).json({ error: '周期任务不存在', code: 'PERIODIC_TASK_NOT_FOUND' });
      if (existing.status === 'disabled') {
        return res.json({ id, status: 'disabled', message: '任务已处于禁用状态（幂等）' });
      }
      // 双条件守卫（WHERE 含期望前置状态 status='active'）+ changes 检查（对齐
      //   feedback_state_machine_update_invariant：防并发下静默吞并发冲突）。
      const result = await dbRunAsync(
        `UPDATE periodic_tasks SET status = 'disabled', updated_at = datetime('now','localtime') WHERE id = ? AND status = 'active'`,
        [id]
      );
      if (result.changes !== 1) {
        return res.status(409).json({ error: '禁用失败：任务状态已变化，请刷新重试', code: 'PERIODIC_TASK_DISABLE_CONFLICT' });
      }
      res.json({ id, status: 'disabled' });
    } catch (err) {
      logger.error('[周期取数推送] 禁用任务失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '禁用失败' });
    }
  });

  // ── GET /periodic-tasks：列表（admin，可选 ?status=active|disabled|all）──────────
  router.get('/periodic-tasks', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    try {
      const statusFilter = (typeof req.query.status === 'string') ? req.query.status.trim() : '';
      let where = '';
      const params = [];
      if (statusFilter === 'active' || statusFilter === 'disabled') {
        where = 'WHERE pt.status = ?';
        params.push(statusFilter);
      } else if (statusFilter && statusFilter !== 'all') {
        return res.status(400).json({ error: 'status 仅支持 active/disabled/all', code: 'INVALID_STATUS_FILTER' });
      }
      const rows = await dbAllAsync(
        `SELECT pt.id, pt.task_name, pt.description, pt.source_connection_id,
                dc.name AS source_connection_name, dc.type AS source_connection_type,
                pt.template_version, pt.status, pt.created_by, pt.created_at, pt.updated_at
           FROM periodic_tasks pt
           LEFT JOIN db_connections dc ON dc.id = pt.source_connection_id
           ${where}
           ORDER BY pt.created_at DESC`,
        params
      );
      res.json({ items: rows });
    } catch (err) {
      logger.error('[周期取数推送] 列表查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '列表查询失败' });
    }
  });

  // ── GET /periodic-tasks/:id：详情（admin）──────────
  router.get('/periodic-tasks/:id', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的任务 ID', code: 'INVALID_TASK_ID' });
    try {
      const row = await dbGetAsync(
        `SELECT pt.*, dc.name AS source_connection_name, dc.type AS source_connection_type
           FROM periodic_tasks pt
           LEFT JOIN db_connections dc ON dc.id = pt.source_connection_id
          WHERE pt.id = ?`,
        [id]
      );
      if (!row) return res.status(404).json({ error: '周期任务不存在', code: 'PERIODIC_TASK_NOT_FOUND' });
      res.json(row);
    } catch (err) {
      logger.error('[周期取数推送] 详情查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '详情查询失败' });
    }
  });

  // ============================================================
  // 六.1、路由（③ 一键跑数落盘，集成点2 范围）
  // ============================================================

  // ── POST /periodic-tasks/:id/run：一键跑本月（admin）──────────
  //   流程（方案 §2②）：读任务 → 校验 active → 取完整 source 连接 → 算上月区间(Asia/Shanghai) →
  //   占位符渲染 → 运行前双校验(残留占位符/最小SQL形态) → 落 run 快照(status='running') →
  //   source 全量执行(行数上限+超时) → 失败则更新 failed；成功则生成 xlsx 落盘 → 更新
  //   success/empty_result。判定规则见方案 §5.2/§6.1。
  router.post('/periodic-tasks/:id/run', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的任务 ID', code: 'INVALID_TASK_ID' });
    try {
      const task = await dbGetAsync(`SELECT * FROM periodic_tasks WHERE id = ?`, [id]);
      if (!task) return res.status(404).json({ error: '周期任务不存在', code: 'PERIODIC_TASK_NOT_FOUND' });
      // 判断调用：禁用任务不可执行（业务上"禁用"= 该周期任务已退役，运行已退役脚本无意义且有误跑风险；
      //   方案未逐字写死此条，自审报告已标注供主会话确认）。
      if (task.status !== 'active') {
        return res.status(409).json({ error: '任务已禁用，不可执行（如需继续使用请重新登记）', code: 'TASK_DISABLED' });
      }

      const connRow = await fetchFullSourceConnection(task.source_connection_id);
      if (!connRow) {
        return res.status(409).json({ error: '目标库连接不存在或非只读 source 连接，请检查连接配置', code: 'SOURCE_CONNECTION_NOT_FOUND' });
      }

      const dateRange = runner.computeLastMonthRangeShanghai();
      const rendered = renderPlaceholders(task.script_template, dateRange);

      // 运行前双校验（方案 §3.4/§4.1"模板可能被改"兜底）：残留占位符校验 + 最小 SQL 形态校验。
      //   任一不过 → 拒绝执行，不落 run 行（未曾开始执行，无需审计占位）。
      const residual = checkNoResidualPlaceholders(rendered);
      if (!residual.ok) {
        return res.status(400).json({ error: residual.reason, code: residual.code });
      }
      const sqlCheck = validatePeriodicSqlForm(rendered, connRow.type);
      if (!sqlCheck.ok) {
        return res.status(400).json({ error: sqlCheck.reason, code: sqlCheck.code || 'SQL_FORM_REJECTED', detail: sqlCheck.detail });
      }

      const actor = periodicActor(req);
      const insertResult = await dbRunAsync(
        `INSERT INTO periodic_task_runs
           (task_id, rendered_script, task_name_snapshot, source_connection_snapshot, template_version_snapshot,
            triggered_by, date_range_start, date_range_end, started_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'), 'running')`,
        [task.id, rendered, task.task_name, `${connRow.name}(${connRow.type})`, task.template_version,
          actor.id, dateRange.start, dateRange.end]
      );
      const runId = insertResult.lastID;
      const t0 = Date.now();

      let execOutcome;
      try {
        let dbPassword;
        try {
          dbPassword = decryptPassword(connRow.password);
        } catch (e) {
          throw Object.assign(new Error('目标库密码解密失败，请联系管理员检查连接配置'), { code: 'CONN_DECRYPT_FAILED' });
        }
        const poolConfig = {
          host: connRow.host, port: connRow.port, database: connRow.database,
          username: connRow.username, password: dbPassword,
        };
        const pool = connRow.type === 'mysql' ? await getMysqlPool(poolConfig) : await getMssqlPool(poolConfig);
        execOutcome = connRow.type === 'mysql'
          ? await runner.runMysqlFullQuery(pool, rendered, { maxRows: PERIODIC_MAX_ROWS, timeoutMs: PERIODIC_QUERY_TIMEOUT_MS })
          : await runner.runMssqlFullQuery(pool, rendered, { maxRows: PERIODIC_MAX_ROWS, timeoutMs: PERIODIC_QUERY_TIMEOUT_MS });
      } catch (connErr) {
        execOutcome = { ok: false, code: connErr.code || 'CONNECTION_FAILED', error: connErr };
      }

      const durationMs = Date.now() - t0;

      // 终态 UPDATE 统一带状态机守卫 status='running'（feedback_state_machine_update_invariant：
      //   双条件守卫 + changes 检查，防僵尸 reaper/并发把行改走后再被本请求覆盖）。
      if (!execOutcome.ok) {
        const errMsg = describeExecFailure(execOutcome);
        await dbRunAsync(
          `UPDATE periodic_task_runs SET status='failed', finished_at=datetime('now','localtime'), duration_ms=?, row_count=?, error_msg=? WHERE id=? AND status='running'`,
          [durationMs, execOutcome.rowCount || null, errMsg, runId]
        );
        logger.warn(`[周期取数推送] run #${runId} 执行失败：${errMsg}`);
        return res.json({ run_id: runId, status: 'failed', error: errMsg, code: execOutcome.code });
      }

      const rowCount = execOutcome.rowCount;
      // M-2①（集成审）：buildResultXlsxBuffer 纳入 try——大结果集 XLSX.write 可能抛 RangeError（超
      //   Excel/字符串上限），旧代码它在 try 外裸调用，抛错会跳到外层 catch 只返 500 而 run 永久卡 running。
      //   现在生成+落盘同 try，任一抛错都落 failed（带状态机守卫），不留僵尸 running。
      let resultPath;
      try {
        const buffer = runner.buildResultXlsxBuffer(execOutcome.columns, execOutcome.rows);
        resultPath = runner.writeResultFile(buffer);
      } catch (fileErr) {
        await dbRunAsync(
          `UPDATE periodic_task_runs SET status='failed', finished_at=datetime('now','localtime'), duration_ms=?, row_count=?, error_msg=? WHERE id=? AND status='running'`,
          [durationMs, rowCount, `结果文件生成/落盘失败：${fileErr.message}`, runId]
        ).catch(() => {});
        logger.warn(`[周期取数推送] run #${runId} 结果文件生成/落盘失败：${fileErr.message}`);
        return res.status(500).json({ error: '结果文件生成/落盘失败，请重试', run_id: runId });
      }

      // empty_result（0 行）单独标识，不与 success 混同（方案 §5.2/§6.1）；文件仍生成(仅表头)，
      //   供 admin 显式确认后仍可下载/推送空结果。
      const finalStatus = rowCount === 0 ? 'empty_result' : 'success';
      // M-2②（集成审）：终态 UPDATE 用状态机守卫 + changes 检查；若失败（DB 异常/并发把行改走），
      //   此时文件已写盘 → 删掉孤儿结果文件再落 failed（避免磁盘留无法回收的敏感孤儿）。
      let termUpd;
      try {
        termUpd = await dbRunAsync(
          `UPDATE periodic_task_runs SET status=?, finished_at=datetime('now','localtime'), duration_ms=?, row_count=?, result_file_path=?, file_status='present' WHERE id=? AND status='running'`,
          [finalStatus, durationMs, rowCount, resultPath, runId]
        );
        if (!termUpd || termUpd.changes !== 1) {
          throw new Error(`终态 UPDATE 影响 ${termUpd ? termUpd.changes : 0} 行（期望 1；run 状态已被并发/复位改走）`);
        }
      } catch (updErr) {
        // 删孤儿文件（resultPath 在内存，deleteResultFileGuarded 会 realpath 校验落在结果目录子树内）
        const del = runner.deleteResultFileGuarded(resultPath);
        await dbRunAsync(
          `UPDATE periodic_task_runs SET status='failed', finished_at=datetime('now','localtime'), duration_ms=?, row_count=?, result_file_path=NULL, file_status='missing', error_msg=? WHERE id=? AND status='running'`,
          [durationMs, rowCount, `终态写入失败，已回收孤儿结果文件（删除=${del.ok}）：${updErr.message}`, runId]
        ).catch(() => {});
        logger.error(`[周期取数推送] run #${runId} 终态写入失败，孤儿文件回收=${del.ok}：${updErr.message}`);
        return res.status(500).json({ error: '结果状态写入失败，请重试', run_id: runId });
      }
      res.json({ run_id: runId, status: finalStatus, row_count: rowCount, duration_ms: durationMs });
    } catch (err) {
      logger.error('[周期取数推送] 一键跑数异常:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '一键跑数失败' });
    }
  });

  // ── GET /periodic-tasks/:id/runs：某任务的执行历史列表（admin）──────────
  //   不含 rendered_script 完整文本（避免列表响应体过大——审计全文走详情端点）。
  router.get('/periodic-tasks/:id/runs', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const id = parsePositiveId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效的任务 ID', code: 'INVALID_TASK_ID' });
    try {
      const task = await dbGetAsync(`SELECT id FROM periodic_tasks WHERE id = ?`, [id]);
      if (!task) return res.status(404).json({ error: '周期任务不存在', code: 'PERIODIC_TASK_NOT_FOUND' });
      const rows = await dbAllAsync(
        `SELECT id, task_id, task_name_snapshot, date_range_start, date_range_end, started_at, finished_at,
                duration_ms, row_count, file_status, status, error_msg
           FROM periodic_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT 200`,
        [id]
      );
      res.json({ items: rows });
    } catch (err) {
      logger.error('[周期取数推送] run 列表查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || 'run 列表查询失败' });
    }
  });

  // ── GET /periodic-tasks/runs/:runId：run 详情（admin，含完整 rendered_script 审计快照）──────────
  router.get('/periodic-tasks/runs/:runId', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    try {
      const row = await dbGetAsync(`SELECT * FROM periodic_task_runs WHERE id = ?`, [runId]);
      if (!row) return res.status(404).json({ error: 'run 记录不存在', code: 'PERIODIC_RUN_NOT_FOUND' });
      res.json(row);
    } catch (err) {
      logger.error('[周期取数推送] run 详情查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || 'run 详情查询失败' });
    }
  });

  // ── GET /periodic-tasks/runs/:runId/download：结果 xlsx 下载（admin 鉴权，方案 §4.4 硬约束）──────────
  //   不给静态直链——从 fs 读回、res 流式下发；realpath 校验路径落在 periodic-results 子树内（防穿越）。
  router.get('/periodic-tasks/runs/:runId/download', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    try {
      const run = await dbGetAsync(`SELECT * FROM periodic_task_runs WHERE id = ?`, [runId]);
      if (!run) return res.status(404).json({ error: 'run 记录不存在', code: 'PERIODIC_RUN_NOT_FOUND' });
      if (run.status !== 'success' && run.status !== 'empty_result') {
        return res.status(409).json({ error: '该 run 无可下载文件（未成功或已失败）', code: 'RUN_HAS_NO_FILE' });
      }
      if (run.file_status !== 'present') {
        return res.status(409).json({ error: '文件已过期或缺失，请重新跑本月', code: 'FILE_NOT_PRESENT' });
      }
      const safePath = runner.resolveSafeResultPath(run.result_file_path);
      if (!safePath) {
        await dbRunAsync(`UPDATE periodic_task_runs SET file_status='missing' WHERE id = ? AND file_status='present'`, [runId]).catch(() => {});
        return res.status(404).json({ error: '结果文件不存在（可能已被清理但状态未同步，已自动修正）', code: 'FILE_MISSING' });
      }
      const asciiName = `periodic-run-${runId}.xlsx`;
      const displayName = `周期取数_${run.task_name_snapshot}_run${runId}.xlsx`;
      res.setHeader('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(displayName)}`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const stream = fs.createReadStream(safePath);
      stream.on('error', (e) => {
        logger.error(`[周期取数推送] run #${runId} 文件流读取失败: ${e.message}`);
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
    } catch (err) {
      logger.error('[周期取数推送] 下载失败:', err && err.message);
      if (!res.headersSent) res.status(500).json({ error: (err && err.message) || '下载失败' });
    }
  });

  // ── POST /periodic-tasks/runs/:runId/file/clean：删除守卫（手动触发文件清理，admin）──────────
  //   方案 §4.4："文件已按期清理"(正常=cleaned) vs "文件不存在异常"(故障=missing) 不混同：
  //   本端点物理删除成功 → cleaned；物理文件本就不存在/越界 → missing（区别于正常清理）。
  //   本集成点先建守卫函数供手动触发；真正的定时清理任务 defer（任务书附录 A.2 明确允许）。
  //   W-1（集成审）：补 status 守卫——只允许对终态（success/empty_result/failed）run 清理。running/queued
  //     run 的 file_status 默认 present 但 result_file_path 仍 NULL，若允许清理会把它误标 missing（状态标签
  //     失真、且可能与正在跑的终态 UPDATE 打架）。对非终态 run 清理返 409 RUN_IN_PROGRESS。
  router.post('/periodic-tasks/runs/:runId/file/clean', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    try {
      const run = await dbGetAsync(`SELECT id, result_file_path, file_status, status FROM periodic_task_runs WHERE id = ?`, [runId]);
      if (!run) return res.status(404).json({ error: 'run 记录不存在', code: 'PERIODIC_RUN_NOT_FOUND' });
      if (run.status === 'running' || run.status === 'queued') {
        return res.status(409).json({ error: 'run 尚未执行完成，不可清理其结果文件', code: 'RUN_IN_PROGRESS' });
      }
      if (run.file_status !== 'present') {
        return res.json({ run_id: runId, file_status: run.file_status, message: '文件已非 present 状态（幂等）' });
      }
      const delResult = runner.deleteResultFileGuarded(run.result_file_path);
      if (delResult.ok) {
        const upd = await dbRunAsync(`UPDATE periodic_task_runs SET file_status='cleaned' WHERE id = ? AND file_status='present'`, [runId]);
        if (upd.changes !== 1) {
          return res.status(409).json({ error: '清理失败：文件状态已变化，请刷新重试', code: 'FILE_STATE_CONFLICT' });
        }
        return res.json({ run_id: runId, file_status: 'cleaned' });
      }
      await dbRunAsync(`UPDATE periodic_task_runs SET file_status='missing' WHERE id = ? AND file_status='present'`, [runId]).catch(() => {});
      return res.status(404).json({ error: '文件不存在或路径异常，已标记为 missing', code: 'FILE_MISSING', reason: delResult.reason });
    } catch (err) {
      logger.error('[周期取数推送] 文件清理失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '文件清理失败' });
    }
  });

  // ============================================================
  // 六.2、路由（④ 推送，集成点2 范围，方案 §6.2 H-4 硬约束）
  // ============================================================

  // ── POST /periodic-tasks/runs/:runId/push/preview：收件人核对预览（admin，无副作用不落库）──────────
  //   admin 填手机号(可多个) → 反查钉钉身份 → 返回姓名/在职状态/钉钉ID后四位供核对。
  //   本端点不发送、不落 push 行——纯预览。前端据 ok 项拼出 confirm 的 recipients 快照
  //   （{phone, userid, name, last4}），confirm 阶段后端会重新反查并逐项比对（H-1）。
  //   M-1：进逻辑前对归一化手机号去重（同号只查一次），响应带 deduped 提示。
  router.post('/periodic-tasks/runs/:runId/push/preview', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    const rawPhones = Array.isArray(req.body && req.body.phones) ? req.body.phones : null;
    if (!rawPhones || rawPhones.length === 0) return res.status(400).json({ error: '请提供至少一个手机号', code: 'PHONES_REQUIRED' });
    if (rawPhones.length > 20) return res.status(400).json({ error: '单批最多 20 个手机号', code: 'TOO_MANY_PHONES' });
    try {
      const run = await dbGetAsync(`SELECT * FROM periodic_task_runs WHERE id = ?`, [runId]);
      const confirmEmpty = !!(req.body && req.body.confirm_empty === true);
      const pushable = checkRunPushable(run, { confirmEmpty });
      if (!pushable.ok) return res.status(pushable.status).json({ error: pushable.error, code: pushable.code });

      const tokenResult = await getPeriodicDingtalkToken();
      if (!tokenResult.ok) {
        return res.status(502).json({ error: '钉钉凭证获取失败：' + tokenResult.reason, code: 'DINGTALK_TOKEN_FAILED', reason: tokenResult.reason });
      }
      // M-1：手机号去重
      const { kept, dropped } = dedupeByNormalizedPhone(rawPhones);
      const items = [];
      for (const raw of kept) {
        const r = await recipients.resolvePushRecipient(tokenResult.token, raw, {
          getUserIdByMobile: dingtalkNotify.getUserIdByMobile,
          classifyError: dingtalkNotify.classifyError,
        });
        // 只回给前端核对所需字段（含 last4 供 confirm 快照），不透传内部 deptIds 之外的东西
        items.push(r.ok
          ? { ok: true, phone: r.phone, userid: r.userid, name: r.name, last4: r.dingUserIdLast4, deptIds: r.deptIds }
          : { ok: false, phone: r.phone, reason: r.reason });
      }
      res.json({ run_id: runId, items, deduped: { by_phone: dropped } });
    } catch (err) {
      logger.error('[周期取数推送] 收件人预览失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '收件人预览失败' });
    }
  });

  // ── POST /periodic-tasks/runs/:runId/push/confirm：确认发送（admin）──────────
  //   H-1：请求**必须**带回 preview 阶段每个收件人的期望快照 recipients:[{phone,userid,name,last4}]。
  //     后端对每个手机号重新反查，逐项比对 userid/name/last4 一致才发（不一致→该号 RECIPIENT_MISMATCH
  //     拒发、不中断其余）。无快照 → 400。杜绝"admin 跳过 preview 直发 / 前端漏核对后端仍发"。
  //   H-3①：两阶段留痕——先对通过核对的收件人 INSERT push_status='pending'（发送前先落库），再发送，
  //     再按回执 UPDATE 为 success/failed。避免"人已收到但无留痕"。
  //   H-3②：幂等守卫——该 run 已有 success 留痕则默认拒（ALREADY_PUSHED），除非 force=true（显式重发）。
  //   M-1：手机号去重 + 发送前 userid 去重（防同人收重复敏感文件 + 留痕虚增）。
  router.post('/periodic-tasks/runs/:runId/push/confirm', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    const rawRecipients = Array.isArray(req.body && req.body.recipients) ? req.body.recipients : null;
    if (!rawRecipients || rawRecipients.length === 0) {
      return res.status(400).json({ error: '缺少收件人核对快照（recipients），请先走 preview 核对', code: 'RECIPIENTS_REQUIRED' });
    }
    if (rawRecipients.length > 20) return res.status(400).json({ error: '单批最多 20 个收件人', code: 'TOO_MANY_PHONES' });
    // H-1：每个 recipient 必须携带完整期望快照（phone+userid+name+last4），否则无法做核对比对 → 400
    for (const rc of rawRecipients) {
      if (!rc || typeof rc !== 'object'
        || !rc.phone || rc.userid === undefined || rc.userid === null || rc.userid === ''
        || rc.name === undefined || rc.name === null || rc.name === ''
        || rc.last4 === undefined || rc.last4 === null || rc.last4 === '') {
        return res.status(400).json({ error: '收件人核对快照不完整（需含 phone/userid/name/last4），请重新走 preview 核对', code: 'INVALID_RECIPIENT_SNAPSHOT' });
      }
    }
    const confirmEmpty = !!(req.body && req.body.confirm_empty === true);
    const force = !!(req.body && req.body.force === true);

    try {
      const run = await dbGetAsync(`SELECT * FROM periodic_task_runs WHERE id = ?`, [runId]);
      const pushable = checkRunPushable(run, { confirmEmpty });
      if (!pushable.ok) return res.status(pushable.status).json({ error: pushable.error, code: pushable.code });

      const safePath = runner.resolveSafeResultPath(run.result_file_path);
      if (!safePath) {
        await dbRunAsync(`UPDATE periodic_task_runs SET file_status='missing' WHERE id = ? AND file_status='present'`, [runId]).catch(() => {});
        return res.status(404).json({ error: '结果文件不存在，请重新跑本月', code: 'FILE_MISSING' });
      }

      // 注：H-new 复审——幂等检查不再在此处（事务外）做，移进下方 BEGIN IMMEDIATE 事务内与 pending
      //   插入同事务原子（防"已插 pending 未写 success"时并发第二请求穿透幂等再次发送）。

      const tokenResult = await getPeriodicDingtalkToken();
      if (!tokenResult.ok) {
        return res.status(502).json({ error: '钉钉凭证获取失败：' + tokenResult.reason, code: 'DINGTALK_TOKEN_FAILED', reason: tokenResult.reason });
      }

      const actor = periodicActor(req);

      // M-1：手机号去重（保留携带的期望快照）
      const { kept, dropped: phoneDropped } = dedupeByNormalizedPhone(rawRecipients);

      // 分类：对每个 recipient 重新反查 + H-1/L-new 快照比对（钉钉网络调用放在事务外，不长持写锁）
      const seenUserids = new Set();
      let useridDropped = 0;
      const classified = [];
      for (const expected of kept) {
        const fresh = await recipients.resolvePushRecipient(tokenResult.token, expected.phone, {
          getUserIdByMobile: dingtalkNotify.getUserIdByMobile,
          classifyError: dingtalkNotify.classifyError,
        });
        const phone = fresh.phone;
        if (!fresh.ok) {
          classified.push({ phone, disposition: 'skipped', reason: fresh.reason, userid: null, name: null });
          continue;
        }
        // L-new：userid 硬 gate；name/last4 归一化后不一致只标 drift 不拒发
        const cmp = compareRecipientSnapshot(fresh, expected);
        if (!cmp.match) {
          classified.push({ phone, disposition: 'skipped', reason: 'RECIPIENT_MISMATCH', userid: null, name: null });
          continue;
        }
        // M-1：发送前 userid 去重（不同手机号可能映射同一人）
        if (seenUserids.has(fresh.userid)) {
          useridDropped++;
          classified.push({ phone, disposition: 'skipped', reason: 'DUPLICATE_USERID', userid: fresh.userid, name: fresh.name });
          continue;
        }
        seenUserids.add(fresh.userid);
        classified.push({ phone, disposition: 'eligible', reason: null, userid: fresh.userid, name: fresh.name,
          snapshotWarning: cmp.drift ? 'name_or_last4_drift' : null });
      }

      // H-new + H-3① 阶段一：BEGIN IMMEDIATE 事务内**先查幂等后插 pending**（同一事务原子，SQLite RESERVED
      //   写锁串行化并发 confirm——第二个请求进事务后看到第一个已插的 pending → 被拦，不会重发敏感文件）。
      let idempotencyBlock = null;
      await dbRunAsync('BEGIN IMMEDIATE');
      try {
        // M（集成点3）：多取 push_error——evaluatePushIdempotency 靠它区分"真在途 pending"(PUSH_IN_PROGRESS)
        //   与"阶段三回写失败卡死 pending"(NEEDS_RECONCILE，见发送阶段三 WRITE_FAILED 标记)。
        const existingPushes = await dbAllAsync(`SELECT push_status, push_error FROM periodic_task_pushes WHERE run_id = ?`, [runId]);
        idempotencyBlock = evaluatePushIdempotency(existingPushes, force);
        if (idempotencyBlock.blocked) {
          await dbRunAsync('ROLLBACK');
        } else {
          // M-2（⑤c）：force 放行时，把旧的 WRITE_FAILED 卡死 pending 行转终态 failed（+SUPERSEDED 注记），
          //   使其退出 pending 幂等阻断——否则 force 重发成功后旧卡死行仍 pending，该 run 之后每次推送都先
          //   被 NEEDS_RECONCILE 拦（用户确认的决策②微调：留痕行不删、历史在，只转终态退出阻断）。
          //   ⚠️ 必须在本 BEGIN IMMEDIATE 事务内（与新 pending 插入原子），失败随下方 txErr catch + ROLLBACK 走，
          //   不额外 .catch 吞（吞了会让"旧行没转终态但新行已插"的半吊子状态提交，破坏幂等一致性）。
          //   只在 force 路径做（force=false 走不到这里——有 WRITE_FAILED pending 时 evaluatePushIdempotency 已 blocked）。
          //   ⚠️ 语义标注（codex 08 M-2）：这里写入的 push_status='failed' 是**人为 supersede 退出阻断的技术终态**，
          //     不等同"钉钉发送失败"。任何消费端做"真实发送失败"统计/告警时，必须用 push_error LIKE '%SUPERSEDED_BY_FORCE%'
          //     排除这类行（前端 pushHistory 已按此区分展示"已被强制重发替代"中性标签，非红色"失败"）。
          if (force === true) {
            await dbRunAsync(
              `UPDATE periodic_task_pushes
                  SET push_status='failed',
                      push_error = COALESCE(push_error,'') || '|SUPERSEDED_BY_FORCE'
                WHERE run_id=? AND push_status='pending' AND push_error LIKE 'WRITE_FAILED%'`,
              [runId]
            );
          }
          for (const c of classified) {
            const isEligible = c.disposition === 'eligible';
            const ins = await dbRunAsync(
              `INSERT INTO periodic_task_pushes
                 (run_id, phone_snapshot, recipient_name_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`,
              [runId, c.phone, isEligible ? c.name : null, isEligible ? c.userid : null,
                isEligible ? 'pending' : 'skipped', isEligible ? null : c.reason, actor.id]
            );
            c.pushId = ins.lastID;
          }
          await dbRunAsync('COMMIT');
        }
      } catch (txErr) {
        await dbRunAsync('ROLLBACK').catch(() => {});
        throw txErr;
      }
      if (idempotencyBlock && idempotencyBlock.blocked) {
        return res.status(idempotencyBlock.status).json({ error: idempotencyBlock.error, code: idempotencyBlock.code });
      }

      // H-3① 阶段二：发送（单次 uploadMedia + 单次 sendFileToUser(eligible userIds)）
      const eligibles = classified.filter((c) => c.disposition === 'eligible');
      const sendOutcomeByUserid = new Map();
      if (eligibles.length > 0) {
        try {
          const buffer = fs.readFileSync(safePath);
          const fileName = `periodic-run-${runId}.xlsx`;
          const mediaId = await dingtalkNotify.uploadMedia(tokenResult.token, fileName, buffer);
          const userIds = eligibles.map((c) => c.userid);
          const sendResp = await dingtalkNotify.sendFileToUser(tokenResult.token, tokenResult.robotCode, userIds, mediaId, fileName);
          const invalidSet = new Set(Array.isArray(sendResp && sendResp.invalidStaffIdList) ? sendResp.invalidStaffIdList : []);
          const respOk = !!(sendResp && (!sendResp.errcode || sendResp.errcode === 0));
          for (const uid of userIds) {
            if (!respOk) sendOutcomeByUserid.set(uid, { ok: false, reason: 'send_failed' });
            else if (invalidSet.has(uid)) sendOutcomeByUserid.set(uid, { ok: false, reason: 'invalid_staff' });
            else sendOutcomeByUserid.set(uid, { ok: true });
          }
        } catch (sendErr) {
          const reason = dingtalkNotify.classifyError(sendErr).reason || 'send_failed';
          for (const c of eligibles) sendOutcomeByUserid.set(c.userid, { ok: false, reason });
        }
      }

      // H-3① 阶段三 + M-new：按回执把 pending 行 UPDATE 为 success/failed，**逐条校验 changes===1**。
      //   回写失败（changes≠1 或抛错）→ 收进 writeFailures，该行**保持 pending**（下次幂等 pending 检查会
      //   拦、不重发），接口不静默返回全成功，返回体带 write_failures + 顶层 warning 提示人工对账。
      const writeFailures = [];
      for (const c of eligibles) {
        const outcome = sendOutcomeByUserid.get(c.userid) || { ok: false, reason: 'send_failed' };
        c.finalStatus = outcome.ok ? 'success' : 'failed';
        c.finalError = outcome.ok ? null : outcome.reason;
        try {
          const upd = await dbRunAsync(
            `UPDATE periodic_task_pushes SET push_status=?, push_error=? WHERE id=? AND push_status='pending'`,
            [c.finalStatus, c.finalError, c.pushId]
          );
          if (!upd || upd.changes !== 1) {
            c.writeFailed = true;
            writeFailures.push({ push_id: c.pushId, intended_status: c.finalStatus });
            logger.warn(`[周期取数推送] push 行 #${c.pushId} 终态回写影响 ${upd ? upd.changes : 0} 行（期望 1），保持 pending 待人工对账`);
            // M（集成点3）：best-effort 打 WRITE_FAILED 标记——保持 push_status='pending' 不变，只补
            //   push_error，供 evaluatePushIdempotency 把这种"确定不会自愈"的卡死 pending 与真正在途的
            //   PUSH_IN_PROGRESS 区分成 NEEDS_RECONCILE（否则 admin 会被"上次推送正在进行"误导且永久卡死无法
            //   重试）。best-effort：该行可能已被并发/复位改走，标记失败不影响主流程（.catch 吞错）。
            await dbRunAsync(
              `UPDATE periodic_task_pushes SET push_error=? WHERE id=? AND push_status='pending'`,
              [`WRITE_FAILED:${c.finalStatus}`, c.pushId]
            ).catch(() => {});
          }
        } catch (e) {
          c.writeFailed = true;
          writeFailures.push({ push_id: c.pushId, intended_status: c.finalStatus });
          logger.warn(`[周期取数推送] push 行 #${c.pushId} 终态回写异常：${e.message}，保持 pending 待人工对账`);
          // M（集成点3）：同上，标记 WRITE_FAILED（best-effort，见上方分支注释）。
          await dbRunAsync(
            `UPDATE periodic_task_pushes SET push_error=? WHERE id=? AND push_status='pending'`,
            [`WRITE_FAILED:${c.finalStatus}`, c.pushId]
          ).catch(() => {});
        }
      }

      // L（集成点3 决策）：snapshotWarning（drift，见 compareRecipientSnapshot）刻意**只在本响应体透出，
      //   不落库**——periodic_task_pushes 是本模块（集成点2）新建、尚未部署上线的表，为它现在加一列会给
      //   本地/未来环境引入一次本可避免的迁移；drift 已在 confirm 响应里给到 admin，前端会展示提醒，落库
      //   属可选增强而非必需。若后续需要审计 drift 历史（而非仅当次响应可见），需专门评估加迁移，不应
      //   在此顺手加列。若主会话认为应该落库，不要自行改 schema，留给用户拍板。
      const results = classified.map((c) => {
        const base = {
          phone: c.phone,
          status: c.disposition === 'eligible' ? c.finalStatus : 'skipped',
          reason: c.disposition === 'eligible' ? c.finalError : c.reason,
        };
        if (c.disposition === 'eligible' && c.snapshotWarning) base.snapshot_warning = c.snapshotWarning;
        return base;
      });
      const summary = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
      const skippedPhones = results.filter((r) => r.status === 'skipped').map((r) => r.phone);
      logger.info(`[周期取数推送] run #${runId} 推送完成：成功${summary.success || 0} 失败${summary.failed || 0} 跳过${summary.skipped || 0}`
        + (writeFailures.length ? `；⚠️${writeFailures.length} 条状态未落库需对账` : '')
        + (skippedPhones.length ? `；跳过：${skippedPhones.map((p) => maskPhone(p)).join(',')}` : ''));

      const respBody = { run_id: runId, results, summary, deduped: { by_phone: phoneDropped, by_userid: useridDropped } };
      if (writeFailures.length > 0) {
        respBody.write_failures = writeFailures;
        respBody.warning = `${writeFailures.length} 条投递状态未能落库（钉钉可能已投递但 DB 未更新），需人工对账；相关记录保持 pending`;
      }
      res.json(respBody);
    } catch (err) {
      logger.error('[周期取数推送] 推送确认失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '推送确认失败' });
    }
  });

  // ── GET /periodic-tasks/runs/:runId/pushes：某 run 的推送留痕列表（admin）──────────
  router.get('/periodic-tasks/runs/:runId/pushes', authenticateToken, requirePeriodicSchemaReady, requireAdmin, async (req, res) => {
    const runId = parsePositiveId(req.params.runId);
    if (!runId) return res.status(400).json({ error: '无效的 run ID', code: 'INVALID_RUN_ID' });
    try {
      const rows = await dbAllAsync(
        `SELECT id, run_id, phone_snapshot, recipient_name_snapshot, dingtalk_user_id_snapshot, push_status, push_error, pushed_by, pushed_at
           FROM periodic_task_pushes WHERE run_id = ? ORDER BY pushed_at DESC`,
        [runId]
      );
      res.json({ items: rows });
    } catch (err) {
      logger.error('[周期取数推送] 推送记录查询失败:', err && err.message);
      res.status(500).json({ error: (err && err.message) || '推送记录查询失败' });
    }
  });

  // ============================================================
  // 七、导出（_internals 供 verify require 真实逻辑，RC-L2）
  // ============================================================
  const _internals = {
    PERIODIC_SCHEMA_STATE,
    PERIODIC_REQUIRED_TABLES,
    PERIODIC_TASKS_KEY_COLS,
    PERIODIC_RUNS_KEY_COLS,
    PERIODIC_PUSHES_KEY_COLS,
    requirePeriodicSchemaReady,
    runPeriodicMigration,
    periodicActor,
    parsePositiveId,
    resolvePeriodicSourceConnection,
    SUPPORTED_PLACEHOLDERS,
    validateTemplatePlaceholders,
    checkNoResidualPlaceholders,
    validatePeriodicSqlForm,
    isRealInto,
    astHasRealInto,
    // 集成点2 新增导出（verify-periodic-run.js / verify-periodic-push.js require 真实逻辑，禁复刻）：
    fetchFullSourceConnection,
    renderPlaceholders,
    describeExecFailure,
    getPeriodicDingtalkToken,
    checkRunPushable,
    PERIODIC_MAX_ROWS,
    PERIODIC_QUERY_TIMEOUT_MS,
    // 集成审 fix 新增导出：
    reapStaleRunningRuns,
    dedupeByNormalizedPhone,
    STALE_RUNNING_MINUTES,
    // 复审 fix 新增导出（verify require 真实逻辑）：
    evaluatePushIdempotency,
    normalizeForCompare,
    compareRecipientSnapshot,
    // ⑤c 集成审 follow-up 新增导出（verify require 真实逻辑）：
    //   ⚠️ reapStalePendingPushes 导出**仅供 verify 脚本 require 真实逻辑做启动复位断言**（STARTUP-ONLY 契约，
    //   见函数头 codex 08 H-1）；**禁任何运行期业务路径 / 管理脚本经 _internals 调用它**（会误标真在途 pending）。
    reapStalePendingPushes,
    STALE_PENDING_PUSH_MINUTES,
  };

  return { initSchema, router, _internals };
};
