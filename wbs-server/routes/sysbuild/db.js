// routes/sysbuild/db.js — 项目管理（系统建设记录）模块的连接 / 锁 / 事务 / 故障路径
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §10.2
//   （沿用 v1.2 §7.2 的已审设计 + v1.1 §10.2 替换清单 R1–R6），C1 单独做故障路径聚焦审。
//
// 蓝本 = routes/it-ledger/index.js 的独立连接范式，按替换清单改写，不照抄：
//   R1 无事务豁免同时校验 err.code === 'SQLITE_ERROR' 与完整短语（台账只按消息匹配）
//   R2 「Database is closed」进入故障路径，不按回滚完成返回（台账按已回滚返回并安排重建）
//   R3 连接 error 监听器立即置不可用，关闭排到锁内执行（台账触发重建）
//   R4 回滚失败时已持锁，直接调用锁内故障助手，不再次取锁（台账取锁后重建）
//   R5 不重开连接；重复进入故障复用同一个关闭结果，关闭回调成功后才释放锁，关闭失败受控退出
//   R6 查询助手发 SQL 前检查本次事务标记与模块状态，失效即拒绝（台账的标记只给探针看）
// 本模块没有重建、没有停机 close：故障是终态，恢复靠重启服务（v1.2 §7.2「生命周期」）。
//   `.close(` 只出现在 closeUnpublished（初始化失败）与 closeFaultedConnOnce（故障路径）两处，
//   `processExit` 只出现在故障路径——verify-sysbuild-static.js 按此扫描。
//
// 启动期争库（项目记忆 sqlite_module_lifecycle_gotchas 2026-10-16 段、PROJECT_STATUS #122）：
//   第二条连接的启动 DDL 不能与主连接的启动写入交错持锁。initSchema 先只读核对结构合约，全部
//   存在且一致就直接发布，不拿任何写锁；确有缺失才逐条自动提交执行 CREATE（每条语句只在自身执行
//   期间持锁，不跨语句持有 RESERVED），不开显式事务。
'use strict';
const sqlite3 = require('sqlite3');

const NO_TXN_PHRASE = 'cannot rollback - no transaction is active';
const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;
const DDL_BUSY_BACKOFF_MS = [500, 1000, 2000, 4000];

// ── 纯函数（_internals 导出，verify 直接构造错误对象测试）──────────────────────────────
// R1：两个条件同时满足才算「事务已由 SQLite 自动结束」。只含「cannot rollback」或只含
//   「no transaction」的相近文案、code 不是 SQLITE_ERROR 的同文案，一律不豁免。
function isNoTxnRollbackError(err) {
  return !!(err && err.code === 'SQLITE_ERROR' && typeof err.message === 'string'
    && err.message.includes(NO_TXN_PHRASE));
}

function isBusyError(err) {
  return !!(err && (err.code === 'SQLITE_BUSY' || err.errno === 5));
}

// 业务错误 = 路由或规则函数主动抛出、同时带 status 与 code 的错误；原样透传。
// 驱动错误（sqlite3 只带 code / errno）：SQLITE_BUSY → 503 SYSBUILD_BUSY，其余 → 500 SYSBUILD_INTERNAL。
function isBusinessError(err) {
  return !!(err && typeof err.status === 'number' && typeof err.code === 'string');
}
function classifyDbError(err) {
  if (isBusinessError(err)) return err;
  const e = isBusyError(err)
    ? makeError(503, 'SYSBUILD_BUSY', '系统繁忙，请稍后重试')
    : makeError(500, 'SYSBUILD_INTERNAL', '内部错误');
  e.cause = err;
  return e;
}

function makeError(status, code, message) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

// 结构合约标准形：只对引号区外的文本去掉 IF NOT EXISTS（SQLite 存储时就会去掉）、折叠空白、
//   统一小写、去掉括号与逗号两侧空白；字符串字面量与带引号的标识符（'…'、"…"、`…`、[…]）原样
//   保留，CHECK 里 'created' 与 'CREATED' 判为不同（09 号 M-1）。只做字面标准化，不做语义等价
//   判断——同名但定义不同的对象只可能来自人工改动，判未就绪交人工处理。
const QUOTE_CLOSE = { "'": "'", '"': '"', '`': '`', '[': ']' };
function normalizeSchemaSql(sql) {
  const s = String(sql || '');
  const parts = [];
  let outside = '';
  let i = 0;
  const flushOutside = () => {
    parts.push(outside.toLowerCase()
      .replace(/\bif\s+not\s+exists\b/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),])\s*/g, '$1'));
    outside = '';
  };
  while (i < s.length) {
    const ch = s[i];
    const close = QUOTE_CLOSE[ch];
    if (!close) { outside += ch; i += 1; continue; }
    flushOutside();
    let j = i + 1;
    for (;;) {
      if (j >= s.length) break;
      if (s[j] === close) {
        // 'it''s' 这类成对转义：同一种引号连写两次仍在字面量内（[…] 没有转义写法）
        if (close !== ']' && s[j + 1] === close) { j += 2; continue; }
        break;
      }
      j += 1;
    }
    parts.push(s.slice(i, j + 1));
    i = j + 1;
  }
  flushOutside();
  return parts.join('').trim();
}

// 09 号 H-1：业务查询不得自行开启或结束事务——否则「无活动事务」不再代表「确知未提交」，上传
//   接口据此删文件会删掉已提交记录引用的文件。跳过开头的空白、空语句分号（09-R：SQLite 准备语句时
//   会跳过前导空语句，'; COMMIT' 实测真实提交）与注释后看第一个关键字。
//   这只是第一道防线（拦在发 SQL 之前、报错清楚）；事务结果的权威判定靠下方「事务标记」硬核对，
//   不依赖对 SQL 文本的解析是否完备（09-R 用户拍板方案 B）。
const TXN_CONTROL_KEYWORDS = new Set(['begin', 'commit', 'end', 'rollback', 'savepoint', 'release']);
function isTxnControlSql(sql) {
  let s = String(sql || '');
  for (;;) {
    const t = s.replace(/^[\s;]+/, '');
    if (t.startsWith('--')) { const nl = t.indexOf('\n'); s = nl < 0 ? '' : t.slice(nl + 1); continue; }
    if (t.startsWith('/*')) { const end = t.indexOf('*/'); s = end < 0 ? '' : t.slice(end + 2); continue; }
    s = t;
    break;
  }
  const m = /^[A-Za-z]+/.exec(s);
  return !!(m && TXN_CONTROL_KEYWORDS.has(m[0].toLowerCase()));
}

// ── 工厂 ───────────────────────────────────────────────────────────────────────────────
// opts：logger、DB_FILE、schemaObjects（[{ type:'table'|'index', name, sql }]，按建表顺序）
//   必需；busyTimeoutMs、lockTimeoutMs、processExit（缺省 process.exit）、beforePublish
//   （发布前的同步或异步准备动作，如预建上传目录；失败即初始化失败）、enableTestHooks 可选。
function createSysbuildDb(opts) {
  for (const k of ['logger', 'DB_FILE', 'schemaObjects']) {
    if (opts[k] === undefined) throw new Error('routes/sysbuild/db 缺参数: ' + k);
  }
  const { logger, DB_FILE, schemaObjects } = opts;
  const busyTimeoutMs = Number.isInteger(opts.busyTimeoutMs) && opts.busyTimeoutMs > 0 ? opts.busyTimeoutMs : DEFAULT_BUSY_TIMEOUT_MS;
  const lockTimeoutMs = Number.isInteger(opts.lockTimeoutMs) && opts.lockTimeoutMs > 0 ? opts.lockTimeoutMs : DEFAULT_LOCK_TIMEOUT_MS;
  const processExit = typeof opts.processExit === 'function' ? opts.processExit : (code) => process.exit(code);
  const beforePublish = typeof opts.beforePublish === 'function' ? opts.beforePublish : null;
  const TEST_HOOKS_ENABLED = opts.enableTestHooks === true;
  // 测试专用（仅 enableTestHooks 时生效）：调小故障关闭超时；连接打开后回调一次（构造初始化期故障）。
  const closeTimeoutMs = TEST_HOOKS_ENABLED && Number.isInteger(opts.closeTimeoutMs) && opts.closeTimeoutMs > 0 ? opts.closeTimeoutMs : CLOSE_TIMEOUT_MS;
  const onConnOpenedForTest = TEST_HOOKS_ENABLED && typeof opts.onConnOpenedForTest === 'function' ? opts.onConnOpenedForTest : null;

  // 模块状态：initError = 初始化失败（终态，重启恢复）；fault = 连接进入故障（终态，重启恢复）。
  const state = { ready: false, initError: null, fault: null };
  let sbDb = null;
  let initPromise = null;
  // 故障路径：faultClosePromise 是唯一的关闭结果，重复进入故障一律复用它（R5）。
  //   closedOnce 只表示「已发起关闭」，不表示关闭成功；关闭成功以 close 回调为准。
  let closedOnce = false;
  let faultClosePromise = null;
  let faultQueuedPromise = null;
  // 测试专用：仅 enableTestHooks 时生效，生产恒为 null。
  const _testHooks = { beforeCommit: null, beforeRollback: null };
  // 事务标记（09-R H-1 方案 B）：每个写事务 BEGIN 后在本连接的临时表里写一行本事务序号。临时表
  //   属于本连接的 temp 库，写它不对业务库文件加锁；它随本事务一起提交或回滚。ROLLBACK 报「无活动
  //   事务」时查这一行：不在 = SQLite 确已自动回滚（确知未提交）；还在 = 事务被提前提交（结果不确定，
  //   进入故障路径）。正常 COMMIT 成功后删掉本行。
  const TXN_MARK_TABLE = 'temp.sysbuild_txn_mark';
  let txnMarkSeq = 0;

  // ── 模块锁：FIFO 队列闭包（照 it-ledger itTxnMutex 的 acquire / release 形状）──────────
  //   读与写共用；timeoutMs 传 0 表示不设超时（只供故障关闭排队使用：它必须排在在途事务之后）。
  const mutex = (() => {
    let locked = false;
    const waiters = [];
    function acquire(timeoutMs) {
      return new Promise((resolve, reject) => {
        const node = { resolve, timer: null, acquired: false };
        if (!locked) {
          locked = true;
          node.acquired = true;
          resolve(makeRelease());
          return;
        }
        waiters.push(node);
        if (timeoutMs) {
          node.timer = setTimeout(() => {
            if (node.acquired) return;
            const idx = waiters.indexOf(node);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(makeError(503, 'SYSBUILD_BUSY', '系统繁忙，请稍后重试'));
          }, timeoutMs);
        }
      });
    }
    function makeRelease() {
      let released = false;
      return function release() {
        if (released) return;
        released = true;
        while (waiters.length > 0) {
          const next = waiters.shift();
          if (next.acquired) continue;
          if (next.timer) clearTimeout(next.timer);
          next.acquired = true;
          next.resolve(makeRelease());
          return;
        }
        locked = false;
      };
    }
    return { acquire, waitingCount: () => waiters.length, isLocked: () => locked };
  })();

  // ── 底层 Promise 化助手（只在本文件内使用，不导出给路由）────────────────────────────
  function runOn(conn, sql, params) {
    return new Promise((resolve, reject) => {
      conn.run(sql, params || [], function onRun(err) {
        if (err) reject(err); else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }
  function getOn(conn, sql, params) {
    return new Promise((resolve, reject) => {
      conn.get(sql, params || [], (err, row) => (err ? reject(err) : resolve(row)));
    });
  }
  function allOn(conn, sql, params) {
    return new Promise((resolve, reject) => {
      conn.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  // ── 状态判定：锁前快速拒绝与锁后复核共用（04 号 M-1）─────────────────────────────────
  function readinessError() {
    if (state.fault) return makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复');
    if (state.initError) return makeError(503, 'SYSBUILD_SCHEMA_NOT_READY', '项目管理模块初始化失败，需人工处理后重启');
    if (!state.ready || !sbDb) return makeError(503, 'SYSBUILD_SCHEMA_INITIALIZING', '项目管理模块正在初始化，请稍后重试');
    return null;
  }
  function assertUsable() {
    const e = readinessError();
    if (e) throw e;
  }
  function getReadiness() {
    const e = readinessError();
    return e ? { ready: false, code: e.code } : { ready: true, code: null };
  }

  // R6：查询助手。每条语句真正发给驱动之前查本次读 / 写的标记（标记在 COMMIT / ROLLBACK 发出之前、
  //   读回调结束之后置为失效）与模块状态，任一不满足直接拒绝，驱动收不到任何 SQL。
  // 09-R2 方案 A：同一次读 / 写内的语句串行发送（前一条落定才发下一条）；写事务内任一语句报出驱动
  //   错误后本次事务作废（marker.poisoned），之后的语句一律拒绝，收尾时必须回滚——SQLite 自动回滚
  //   （如 INSERT OR ROLLBACK、RAISE(ROLLBACK)）之后业务代码即使吞掉错误继续写，也不会有语句在
  //   自动提交模式下落库。这一条只让事务结果的标注更保守，不是删文件的依据（见 withWriteTxn 契约）。
  function makeQuery(conn, marker) {
    function guard(sql) {
      if (!marker.active) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：查询助手在读写范围结束后被调用');
      if (state.fault) throw makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复');
      if (marker.poisoned) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：本事务已发生数据库错误，后续语句不再执行');
      if (isTxnControlSql(sql)) throw makeError(500, 'SYSBUILD_INTERNAL', '内部错误：业务查询不得开启或结束事务');
    }
    function enqueue(driverFn, sql, params) {
      // 09-R3 H-1：在范围内（标记有效时）接纳、却因收尾标记失效而没能发出的语句，同样作废本次
      //   事务——否则回调不等它就返回时，前面已发出的写照常提交，形成部分写入。范围结束后才发起的
      //   新调用只拒绝（不影响事务结果）。
      const acceptedInScope = marker.active;
      const p = marker.chain.then(() => {
        if (!marker.active && acceptedInScope) marker.poisoned = true;
        guard(sql);
        return driverFn(conn, sql, params).catch((err) => { marker.poisoned = true; throw err; });
      });
      marker.chain = p.then(() => {}, () => {});
      return p;
    }
    return {
      get: (sql, params) => enqueue(getOn, sql, params),
      all: (sql, params) => enqueue(allOn, sql, params),
      run: (sql, params) => enqueue(runOn, sql, params),
    };
  }
  function newMarker() {
    return { active: false, poisoned: false, chain: Promise.resolve() };
  }

  // ── 故障路径 ─────────────────────────────────────────────────────────────────────────
  function markFault(reason) {
    if (!state.fault) {
      state.fault = reason;
      state.ready = false;
      logger.error(`[sysbuild] 🚫 连接进入故障态（需重启服务恢复）: ${reason}`);
    }
  }

  // 唯一的关闭点（故障路径）。只关一次；关闭回调成功即连接已释放数据库文件锁并回滚未结束的
  //   事务；回调报错或 5 秒内无回调 → 锁可能仍未释放，受控退出进程由 PM2 重启（04 号风险）。
  function closeFaultedConnOnce(conn) {
    closedOnce = true;
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, err: new Error(`关闭超时（${closeTimeoutMs}ms 内没有 close 回调）`) });
      }, closeTimeoutMs);
      conn.close((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(err ? { ok: false, err } : { ok: true, err: null });
      });
    }).then((result) => {
      if (result.ok) {
        logger.error('[sysbuild] 故障连接已关闭，数据库文件锁已释放；本模块保持不可用直到重启');
      } else {
        logger.error(`[sysbuild] ☠️ 故障连接关闭失败，受控退出进程: ${result.err && result.err.message}`);
        processExit(1);
      }
      return result;
    });
  }

  // 锁内故障助手（R4）：调用方必须已持有模块锁。重复调用复用同一个关闭结果（R5）。
  //   返回关闭结果；调用方在它落定之后才释放锁（关闭回调成功是锁释放的确认点）。
  function enterFaultUnderLock(reason) {
    markFault(reason);
    if (!faultClosePromise) {
      faultClosePromise = sbDb ? closeFaultedConnOnce(sbDb) : Promise.resolve({ ok: true, err: null });
    }
    return faultClosePromise;
  }

  // 锁外入口（R3）：连接 error 事件。立即置不可用（之后的锁前判定、锁后复核与查询助手都会拒绝），
  //   关闭排到模块锁内、在途事务之后执行；只排一次。
  function enterFault(reason) {
    markFault(reason);
    if (faultClosePromise) return faultClosePromise;
    if (!faultQueuedPromise) {
      faultQueuedPromise = mutex.acquire(0).then((release) => enterFaultUnderLock(reason).finally(release));
    }
    return faultQueuedPromise;
  }

  // R2：ROLLBACK 失败只有 R1 一种豁免；「Database is closed」等其余错误一律进入故障路径。
  //   R1 豁免另须事务标记核对通过（09-R H-1）：标记行已随回滚消失才算「已回滚」。
  //   返回 'rolled_back' | 'fault'。调用方已持锁。markSeq 为 null 表示本事务尚未写入标记。
  //   ROLLBACK 成功时同样核对标记：业务回调若提前提交后又自行开了新事务，ROLLBACK 只回滚了新事务，
  //   标记（随前一段一起已提交）仍在，不能判「确知未提交」。
  async function rollbackOrFault(conn, markSeq) {
    try {
      if (TEST_HOOKS_ENABLED && _testHooks.beforeRollback) await _testHooks.beforeRollback();
      await runOn(conn, 'ROLLBACK');
    } catch (rbErr) {
      if (!isNoTxnRollbackError(rbErr)) {
        await enterFaultUnderLock(`ROLLBACK 失败: ${rbErr && rbErr.message}`);
        return 'fault';
      }
      logger.warn(`[sysbuild] ROLLBACK 时事务已由 SQLite 结束，核对事务标记: ${rbErr.message}`);
    }
    if (markSeq === null) return 'rolled_back';
    let markRow;
    try {
      markRow = await getOn(conn, `SELECT seq FROM ${TXN_MARK_TABLE} WHERE seq = ?`, [markSeq]);
    } catch (markErr) {
      await enterFaultUnderLock(`回滚后事务标记无法核对: ${markErr && markErr.message}`);
      return 'fault';
    }
    if (markRow) {
      await enterFaultUnderLock('事务被提前提交（事务标记已落库），本次写入结果不确定');
      return 'fault';
    }
    return 'rolled_back';
  }

  function withOutcome(err, outcome) {
    err.txnOutcome = outcome;
    return err;
  }

  // ── 读助手 ───────────────────────────────────────────────────────────────────────────
  async function withRead(fn) {
    assertUsable();
    const release = await mutex.acquire(lockTimeoutMs);
    const marker = newMarker();
    try {
      assertUsable();
      const conn = sbDb;
      marker.active = true;
      try {
        return await fn(makeQuery(conn, marker));
      } catch (err) {
        throw classifyDbError(err);
      }
    } finally {
      marker.active = false;
      // 已发出的语句落定之后才放锁，不让下一个持锁者与它们交错。
      await marker.chain;
      release();
    }
  }

  // ── 写事务助手 ─────────────────────────────────────────────────────────────────────────
  //   成功 resolve 业务结果（已提交）。失败时抛出的错误带 txnOutcome：
  //   'not_committed' 按底座所知未提交（锁前 / BEGIN 失败、回滚成功或事务已由 SQLite 结束且事务标记核对通过）；
  //   'uncertain' 结果不确定（进入了故障路径，或 COMMIT 本身返回非 BUSY 错误）。
  //   ⚠️ 契约（09-R2 用户拍板方案 A）：txnOutcome 只是**参考标注**，尽量保守但不保证完备（同源三轮审查
  //   证明「从事务过程推断是否已提交」堵不完）。**任何删除已落盘文件的决定都不得只凭它**：调用方须在
  //   事务结束后用 withRead 回读，确认没有任何记录引用该文件才可删除；回读失败或模块不可用时保留文件
  //   （孤儿文件按记录核对口径人工处理）。保证的性质是「绝不删除被已提交记录引用的文件」，由回读保证。
  async function withWriteTxn(fn) {
    try {
      assertUsable();
    } catch (e) {
      throw withOutcome(e, 'not_committed');
    }
    let release;
    try {
      release = await mutex.acquire(lockTimeoutMs);
    } catch (e) {
      throw withOutcome(e, 'not_committed');
    }
    const marker = newMarker();
    try {
      try {
        assertUsable();
      } catch (e) {
        throw withOutcome(e, 'not_committed');
      }
      const conn = sbDb;
      try {
        await runOn(conn, 'BEGIN IMMEDIATE');
      } catch (beginErr) {
        logger.warn(`[sysbuild] BEGIN IMMEDIATE 失败（不执行 ROLLBACK）: ${beginErr.message}`);
        throw withOutcome(classifyDbError(beginErr), 'not_committed');
      }
      let markSeq = null;
      let result;
      // 09-R3 M-1：失败与否用独立布尔值判断——回调抛出 null / undefined / 0 这类假值也算失败。
      let failed = false;
      let failure;
      try {
        const seq = ++txnMarkSeq;
        await runOn(conn, `INSERT INTO ${TXN_MARK_TABLE}(seq) VALUES (?)`, [seq]);
        markSeq = seq;
        marker.active = true;
        result = await fn(makeQuery(conn, marker));
      } catch (bizErr) {
        failed = true;
        failure = bizErr;
      }
      // 收尾前：标记失效（之后才执行的排队语句一律被拒；范围内已接纳的被拒即作废事务），再等已发出的语句落定。
      marker.active = false;
      await marker.chain;
      // 业务回调吞掉了驱动错误、或有已接纳的语句被收尾取消却正常返回：事务已作废，必须回滚。
      if (!failed && marker.poisoned) {
        failed = true;
        failure = makeError(500, 'SYSBUILD_INTERNAL', '内部错误：事务内有语句失败或未执行，本事务已回滚');
      }
      if (!failed) {
        try {
          if (TEST_HOOKS_ENABLED && _testHooks.beforeCommit) await _testHooks.beforeCommit();
          await marker.chain;
          // 09 号 M-2：业务回调执行期间连接已进入故障（error 事件）时不再提交，改走回滚并返回 503。
          if (state.fault) { failed = true; failure = makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复'); }
        } catch (preCommitErr) {
          failed = true;
          failure = preCommitErr;
        }
      }
      if (failed) {
        const rb = await rollbackOrFault(conn, markSeq);
        if (rb === 'fault') {
          throw withOutcome(makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复'), 'uncertain');
        }
        throw withOutcome(classifyDbError(failure), 'not_committed');
      }
      // 发出 COMMIT（与上面最后一次故障检查之间没有 await）。
      try {
        await runOn(conn, 'COMMIT');
      } catch (commitErr) {
        // 09-R2 H-2：COMMIT 本身返回的错误只有 SQLITE_BUSY 有「事务仍在、整体未提交」的明确语义，回滚后
        //   标「未提交」；其余错误（IOERR 等）主库可能已提交，一律进入故障路径、标「不确定」。
        if (isBusyError(commitErr)) {
          logger.warn(`[sysbuild] COMMIT 遇忙，回滚: ${commitErr.message}`);
          const rb = await rollbackOrFault(conn, markSeq);
          if (rb === 'fault') {
            throw withOutcome(makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复'), 'uncertain');
          }
          throw withOutcome(classifyDbError(commitErr), 'not_committed');
        }
        await enterFaultUnderLock(`COMMIT 返回错误，提交结果不确定: ${commitErr && commitErr.message}`);
        throw withOutcome(makeError(503, 'SYSBUILD_UNAVAILABLE', '项目管理模块暂不可用，需重启服务恢复'), 'uncertain');
      }
      // 已提交。删掉本事务的标记行（只动本连接的临时表）；失败只记日志——序号不复用，残留行不影响
      //   之后任何事务的核对，也不改变本次「已提交」的结果。
      try {
        await runOn(conn, `DELETE FROM ${TXN_MARK_TABLE} WHERE seq = ?`, [markSeq]);
      } catch (cleanErr) {
        logger.warn(`[sysbuild] 已提交，事务标记清理失败（不影响结果）: ${cleanErr && cleanErr.message}`);
      }
      return result;
    } finally {
      marker.active = false;
      release();
    }
  }

  // ── 初始化 ───────────────────────────────────────────────────────────────────────────
  function openConn() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const conn = new sqlite3.Database(DB_FILE, (err) => {
        if (settled) return;
        settled = true;
        if (err) reject(Object.assign(err, { conn })); else resolve(conn);
      });
      conn.__faulted = false;
      // 监听器在构造时挂上，避免底层驱动另发的 error 事件因无监听器被当作未处理异常抛出。
      //   未发布的连接只置旗标，由初始化流程判失败；已发布的连接进入故障路径（R3）。
      conn.on('error', (err) => {
        const msg = err && err.message;
        logger.error(`[sysbuild] 连接 error 事件: ${msg}`);
        if (!settled) {
          settled = true;
          reject(Object.assign(err || new Error('连接 error 事件'), { conn }));
          return;
        }
        conn.__faulted = true;
        if (conn === sbDb) enterFault(`连接 error 事件: ${msg}`);
      });
    });
  }

  // 初始化失败分支的关闭（未发布连接，不涉及在途请求）。关闭失败只记日志：此刻连接上没有显式
  //   事务（DDL 逐条自动提交），不持有数据库文件锁。
  function closeUnpublished(conn, reason) {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logger.error(`[sysbuild] 初始化失败后关闭连接超时（${reason}）`);
        resolve();
      }, CLOSE_TIMEOUT_MS);
      conn.close((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) logger.error(`[sysbuild] 初始化失败后关闭连接失败（${reason}）: ${err.message}`);
        resolve();
      });
    });
  }

  // 结构合约核对：逐个对象比对 sqlite_master 中同名对象的类型与标准形 SQL。
  async function checkSchemaContract(conn) {
    const names = schemaObjects.map((o) => o.name);
    const rows = await allOn(conn, `SELECT type, name, sql FROM sqlite_master WHERE name IN (${names.map(() => '?').join(',')})`, names);
    const byName = new Map(rows.map((r) => [r.name, r]));
    const missing = [];
    const mismatched = [];
    for (const obj of schemaObjects) {
      const row = byName.get(obj.name);
      if (!row) { missing.push(obj.name); continue; }
      if (row.type !== obj.type || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(obj.sql)) mismatched.push(obj.name);
    }
    return { missing, mismatched };
  }

  async function runDdlWithBusyRetry(conn, obj) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await runOn(conn, obj.sql);
        return;
      } catch (err) {
        if (!isBusyError(err) || attempt >= DDL_BUSY_BACKOFF_MS.length) throw err;
        logger.warn(`[sysbuild] 建 ${obj.name} 遇忙，${DDL_BUSY_BACKOFF_MS[attempt]}ms 后重试`);
        await new Promise((r) => setTimeout(r, DDL_BUSY_BACKOFF_MS[attempt]));
      }
      if (conn.__faulted) throw new Error('初始化期间连接 error 事件');
    }
  }

  async function runInit() {
    let conn = null;
    try {
      conn = await openConn();
      if (onConnOpenedForTest) onConnOpenedForTest(conn);
      await runOn(conn, `PRAGMA busy_timeout = ${busyTimeoutMs}`);
      // 事务标记表：本连接私有的临时表，不进业务库、不在结构合约里。
      await runOn(conn, `CREATE TEMP TABLE IF NOT EXISTS sysbuild_txn_mark (seq INTEGER PRIMARY KEY)`);
      let contract = await checkSchemaContract(conn);
      if (contract.mismatched.length === 0 && contract.missing.length > 0) {
        for (const obj of schemaObjects) {
          if (!contract.missing.includes(obj.name)) continue;
          if (conn.__faulted) throw new Error('初始化期间连接 error 事件');
          await runDdlWithBusyRetry(conn, obj);
        }
        contract = await checkSchemaContract(conn);
      }
      if (contract.mismatched.length > 0 || contract.missing.length > 0) {
        const parts = [];
        if (contract.mismatched.length) parts.push(`同名对象定义不符（需人工处理）: ${contract.mismatched.join(', ')}`);
        if (contract.missing.length) parts.push(`缺失: ${contract.missing.join(', ')}`);
        throw new Error(`结构合约不符 — ${parts.join('；')}`);
      }
      if (beforePublish) await beforePublish();
      // 发布：最后一次检查与发布之间零 await。
      if (conn.__faulted) throw new Error('初始化期间连接 error 事件');
      sbDb = conn;
      state.ready = true;
      logger.info(`[sysbuild] ✅ ${schemaObjects.length} 个结构对象就绪，项目管理接口放行`);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      state.ready = false;
      state.initError = msg;
      logger.error(`[sysbuild] 🚫 初始化失败（接口返回 503 SYSBUILD_SCHEMA_NOT_READY，修复后重启）: ${msg}`);
      const toClose = conn || (err && err.conn);
      if (toClose) await closeUnpublished(toClose, msg);
    }
  }

  // 非 async：首次调用创建并缓存 Promise，之后返回同一个对象（单飞）。初始化失败不自动重试。
  function initSchema() {
    if (!initPromise) initPromise = runInit();
    return initPromise;
  }

  const _internals = {
    isNoTxnRollbackError, isBusyError, classifyDbError, normalizeSchemaSql, isTxnControlSql,
    waitingCount: () => mutex.waitingCount(),
    getState: () => ({ ready: state.ready, initError: state.initError, fault: state.fault, closedOnce }),
  };
  if (TEST_HOOKS_ENABLED) {
    _internals.getConnForTest = () => sbDb;
    _internals.enterFaultForTest = (reason) => enterFault(reason);
    _internals.setBeforeCommit = (fn) => { _testHooks.beforeCommit = fn || null; };
    _internals.setBeforeRollback = (fn) => { _testHooks.beforeRollback = fn || null; };
  }

  return { initSchema, withRead, withWriteTxn, getReadiness, makeError, _internals };
}

module.exports = {
  createSysbuildDb,
  isNoTxnRollbackError, isBusyError, classifyDbError, normalizeSchemaSql, isTxnControlSql, makeError,
};
