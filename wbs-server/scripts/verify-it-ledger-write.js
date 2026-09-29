/**
 * C2 登记/编辑/机柜/楼层 verify · 信息化资产轻量台账（长任务 D）
 * 方案 docs/local/信息化资产_轻量版/信息化资产轻量台账_方案_20260918_v0.7.md §2.1/§2.1.1/§2.2/
 * §2.2b/§2.3/§2.7/§5/§10
 * 执行 agent spec docs/local/信息化资产_轻量版/_agent_specs/C2_登记编辑机柜楼层_spec.md §7
 *
 * 写法：与 verify-it-ledger.js 同款——独立 express 实例挂本模块路由，临时 db 文件，伪造
 * authenticateToken（按请求头 x-test-user-id/x-test-user-role 注入 req.user）与 requireAdmin。
 * 本文件独立起自己的 express/db/助手（不 require verify-it-ledger.js），避免任何一处改动波及
 * 已冻结的 C1 守卫基线（338 断言）。
 *
 * 用法：node scripts/verify-it-ledger-write.js
 */
'use strict';
const { listenOnSafePort } = require('./lib/listen-safe-port');
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();

const TEST_DB = path.join(os.tmpdir(), `it-ledger-write-verify-${Date.now()}-${process.pid}.db`);
// T-M3（Opus 复看第8批）：MUTANT_DIR 在 main() 内部才知道最终路径（可配置根目录 +
// 时间戳/pid），fatalExit 是模块顶层函数——用一个模块级可写引用桥接，main() 算出路径后立刻
// 赋值，让致命退出时也能报出这个目录（不止 TEST_DB），方便人工排查残留。
let currentMutantDir = null;

let pass = 0; let fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`[OK] ${name}`); } else { fail++; results.push(`[FAIL] ${name}${detail ? ' · ' + String(detail) : ''}`); }
}
function fatalExit(label, detail) {
  check(label, false, detail);
  console.error(`[FATAL] ${label}${detail ? ' · ' + String(detail) : ''}——终止 verify 进程`);
  console.error(`[FATAL] 当前汇总 PASS=${pass} FAIL=${fail}`);
  console.error(`[FATAL] TEST_DB=${TEST_DB}（临时文件留待人工清理，本进程不再尝试删除）`);
  console.error(`[FATAL] MUTANT_DIR=${currentMutantDir || '(尚未创建)'}（临时目录留待人工清理，本进程不再尝试删除）`);
  process.exit(1);
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时(>${ms}ms)`), { __timeout: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function schedulingBarrier() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}
async function awaitArrived(arrivedPromise, label, opPromise) {
  const racers = [arrivedPromise.then(() => ({ kind: 'arrived' }))];
  if (opPromise) {
    racers.push(opPromise.then(
      (v) => ({ kind: 'earlyDone', value: v }),
      (e) => ({ kind: 'earlyFail', earlyFail: e })
    ));
  }
  let result;
  try {
    result = await withTimeout(Promise.race(racers), 3000, `${label} 到达信号`);
  } catch (e) {
    fatalExit(`${label}: 到达信号超时`, e && e.message);
    return;
  }
  // T-M3（Opus 复看第5批 HIGH）：原实现只处理了 earlyFail 分支——opPromise 在到达信号之前就
  // 正常 resolve（earlyDone）完全没被拦截，会被当成"到达了"悄悄放过，掩盖"时序假设根本不成立"
  // 这个真问题（该操作压根没走到预期的闸/排队点就已经结束）。现在只有 kind==='arrived' 才继续
  // 往下走，earlyDone 与 earlyFail 一样立即 fatalExit，并把响应体带出来方便排查。
  if (result && result.kind === 'earlyFail') {
    fatalExit(`${label}: 对应操作在到达信号之前提前失败`, result.earlyFail && (result.earlyFail.stack || result.earlyFail.message));
    return;
  }
  if (result && result.kind === 'earlyDone') {
    fatalExit(`${label}: 对应操作在到达信号之前就已正常结束(时序假设不成立)`, JSON.stringify(result.value));
    return;
  }
}

// T-M6（Opus 预筛）：复用 verify-it-ledger.js 同款范式——生产代码没有"mutex 排队计数变化"的
// 到达信号 Promise（不像 openGate/txnMidGate 那样有显式 arrived），只能轮询一个布尔条件；套
// withTimeout 让"条件迟迟不成立"走 fatalExit（不是弱弱地在超时后 check(false) 继续跑），
// 消除裸 setTimeout 轮询循环里"超时后只是断言失败、继续跑后面用例"的脆弱性。
async function waitForCondition(predicateFn, label, timeoutMs) {
  const poll = new Promise((resolve) => {
    const tick = () => (predicateFn() ? resolve(true) : setTimeout(tick, 10));
    tick();
  });
  try {
    return await withTimeout(poll, timeoutMs || 3000, label);
  } catch (e) {
    fatalExit(`${label}: 等待条件成立超时`, e && e.message);
    return undefined;
  }
}

function fakeAuthenticateToken(req, res, next) {
  const uid = req.headers['x-test-user-id'];
  if (uid === undefined) return res.status(401).json({ error: '未登录' });
  req.user = { id: Number(uid), role: req.headers['x-test-user-role'] || 'user' };
  next();
}
function fakeRequireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '权限不足' });
  next();
}
const logger = { info: () => {}, warn: (...a) => console.warn('[WARN]', ...a), error: (...a) => console.error('[ERROR]', ...a) };

async function seedUsers() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.serialize(() => {
      db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        display_name TEXT,
        role TEXT DEFAULT 'user',
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT (datetime('now','localtime'))
      )`);
      const stmt = db.prepare('INSERT INTO users (id, username, password, display_name, role) VALUES (?,?,?,?,?)');
      stmt.run(1, 'admin', 'x', '管理员', 'admin');
      stmt.run(2, 'alice', 'x', 'Alice', 'user'); // ACL write
      stmt.run(3, 'bob', 'x', 'Bob', 'user'); // ACL read
      stmt.run(4, 'carol', 'x', 'Carol', 'user'); // 无 ACL
      stmt.run(10, 'erin', 'x', 'Erin', 'user'); // I 组：排队期撤权
      stmt.finalize((err) => { db.close(() => (err ? reject(err) : resolve())); });
    });
  });
}

let seq = 0;
function uniq(prefix) { seq += 1; return `${prefix}-${Date.now()}-${seq}`; }
// T-M9（Opus 预筛）：floorId 用递增计数器而非 Math.random()，避免"理论上可重复"的随机性——
// 计数器单调递增，跨用例、跨次跑脚本都不会撞号（同一进程内 seq 单调，配合 Date.now() 更保险）。
let floorSeq = 0;
function nextFloorId() { floorSeq += 1; return `F${Date.now() % 100000}${floorSeq}`; }

// 通用只读助手：独立原生连接查询一次即关闭（供并发/事件类断言做 DB 层回查）。
// T-M2：事件快照精确比较用的稳定序列化（对象键排序递归，数组保持原序）——与 index.js 的
// stableStringify 同一份判据，供本文件比较 to_state/资产落库值是否真的完全一致（而不只是
// "键存在"）。
function stableStringifyForTest(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringifyForTest).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyForTest(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function rawAll(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.all(sql, params || [], (e, rows) => { db.close(); e ? reject(e) : resolve(rows); });
  });
}

// 补齐缺口用：原生连接直接执行写 SQL（不经模块 mutex/JS 校验），用于往库里直插坏 JSON 之类
// 应用层永远不会自己产出的畸形数据，验证读路径的 fail-closed（S-M5）。
// Opus 复看第7批第3条（MED）：这条裸连接绕开了模块自己的 itTxnMutex，如果调用时机恰好撞上
// 模块正持有写锁在跑 BEGIN IMMEDIATE，裸连接可能被 SQLite 拒绝或短暂等锁——开连接后先设
// PRAGMA busy_timeout=5000（与模块自己的 itDb 同一个量级），整个调用套 withTimeout(10s) 兜底
// （比 busy_timeout 本身宽松，容忍"退避到点了但还没来得及把结果回调走完"这类调度抖动）。
function rawRun(sql, params) {
  // T-rec M8（Opus 复看第8批）：db.close() 本身也是异步的（带回调），此前调用完就立刻
  // resolve/reject，不等 close 真正完成——理论上下一步操作（比如紧接着的 GET 请求）可能在这条
  // 连接的句柄还没释放干净时就发生，Windows 下容易撞见"文件被占用"类的间歇性问题。现在等
  // close 的回调触发后才 resolve/reject（close 回调本身出错也不掩盖，优先暴露原始的业务结果，
  // close 失败只是补充信息打印，不改变 resolve/reject 的判定）。
  const op = new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    const closeAndSettle = (settle) => {
      db.close((closeErr) => {
        if (closeErr) console.warn('[WARN] rawRun: db.close 失败(不影响主结果)', closeErr.message);
        settle();
      });
    };
    db.run('PRAGMA busy_timeout = 5000', (pragmaErr) => {
      if (pragmaErr) { closeAndSettle(() => reject(pragmaErr)); return; }
      db.run(sql, params || [], function (e) {
        const lastID = this.lastID; const changes = this.changes;
        closeAndSettle(() => (e ? reject(e) : resolve({ lastID, changes })));
      });
    });
  });
  return withTimeout(op, 10000, `rawRun(${sql.slice(0, 40)}...)`);
}

async function main() {
  let currentCaseLabel = '启动段';
  const MAIN_DEADLINE_MS = 180000;
  const mainDeadlineTimer = setTimeout(() => fatalExit('MAIN_DEADLINE 超时·仍在: ' + currentCaseLabel), MAIN_DEADLINE_MS);
  if (typeof mainDeadlineTimer.unref === 'function') mainDeadlineTimer.unref();

  // T2（Opus 复看第9小批修复）：try 起点前移到"第一个会创建外部资源的语句"之前——此前 try 起点
  // 排在 seedUsers()/itLedgerFactory()/首次 initSchema()/server.listen() 全部完成之后，这几步
  // 里任何一步抛错都会绕过 finally，留下已创建但没人清理的资源（比如 seedUsers 已经在 TEST_DB
  // 里建了表，server 已经在监听端口）。句柄改用可空的 let（在 try 外先声明为 null），finally
  // 按"是否非 null"判断要不要清理，不再假设它们一定已经创建成功。
  let itLedgerModule = null;
  let server = null;

  try {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await seedUsers();

    const app = express();
    app.use(express.json());
    const itLedgerFactory = require('../routes/it-ledger');
    itLedgerModule = itLedgerFactory({
      logger, DB_FILE: TEST_DB, authenticateToken: fakeAuthenticateToken, requireAdmin: fakeRequireAdmin,
      enableTestHooks: true,
    });
    app.use('/api', itLedgerModule.router);
    const { itTxnMutex } = itLedgerModule._internals;

    currentCaseLabel = '首次 initSchema() 真实调用';
    await withTimeout(itLedgerModule.initSchema(), 15000, '首次 initSchema() 调用落定');

    server = await listenOnSafePort(app, null);
    const PORT = server.address().port;
    const BASE = `http://localhost:${PORT}`;

  // Opus 复看第1条（HIGH）：declaredCodes 覆盖率不能靠源码文本扫描（注释/候选数组里出现过
  //   码名字面量也会被误判"命中"，SLOT_OCCUPIED 就是这样在文本扫描下显绿、实际零次真实触发）。
  //   改成运行期真实观测——observedCodes 在唯一的 HTTP 出口 api() 里自动记录每一次响应体里
  //   出现过的 code（不需要逐个断言点手工搬运，天然不会漏记任何一次真实发生的响应），
  //   是比"逐个断言点手工调用某个记录函数"更不容易漏斗的收敛点：只要某个 code 真的被服务端
  //   返回过一次（不论是不是被显式断言过），这里就会记到。纯函数直调（不经 HTTP 的用例，如
  //   J 组变异测试、M 组的 U_INTERVAL_OUT_OF_RANGE/LEDGER_INTERNAL 直调）另行显式
  //   observedCodes.add()。
  const observedCodes = new Set();
  async function api(method, urlPath, { uid, role, body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (uid !== undefined) headers['x-test-user-id'] = String(uid);
    if (role !== undefined) headers['x-test-user-role'] = String(role);
    const doFetch = (async () => {
      const r = await fetch(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      let j = null;
      try { j = await r.json(); } catch (_e) { /* ignore */ }
      if (j && typeof j.code === 'string') observedCodes.add(j.code);
      return { status: r.status, body: j };
    })();
    try {
      return await withTimeout(doFetch, 5000, `api(${method} ${urlPath})`);
    } catch (e) {
      fatalExit(`api(${method} ${urlPath}) 超时/异常`, e && e.message);
      return undefined;
    }
  }

  // expectCode：单码断言的统一入口——用例统一走它做"实际收到的 code === 期望码"这类断言
  // （observedCodes 的记录已经在 api() 里做了，这里只负责断言本身，保持调用点简洁一致）。
  function expectCode(res, code, label) {
    const ok = !!(res && res.body && res.body.code === code);
    check(label, ok, JSON.stringify(res && res.body));
    return ok;
  }

  // T-M3（Opus 复看第8批，T2 第9小批扩大范围）：main 流程的资源清理集中到一个 finally 里——
  // 此前"收尾"代码块只是顺序执行到文件末尾，如果中途任何一段测试代码抛出未被内层 try/catch
  // 吞掉的异常，收尾清理（server.close/shutdown/删临时文件目录）会被整段跳过。try 的起点已在
  // T2 里前移到 seedUsers()/首次 initSchema()/server.listen() 之前（见上方），这里不再重复
  // 开一层 try——本段代码已经身处那个外层 try 内部，finally 收尾覆盖面比 T-M3 原版更大。
  currentCaseLabel = '等待 initSchema 就绪';
  await withTimeout(
    new Promise((resolve) => {
      const poll = () => (itLedgerModule._internals.state.ready ? resolve() : setTimeout(poll, 10));
      poll();
    }),
    15000, 'initSchema 就绪等待'
  );

  // ── 基础夹具 ──────────────────────────────────────────────────────────────────────
  currentCaseLabel = '夹具准备';
  await api('PUT', '/api/it-assets/acl/2', { uid: 1, role: 'admin', body: { level: 'write' } });
  await api('PUT', '/api/it-assets/acl/3', { uid: 1, role: 'admin', body: { level: 'read' } });

  const rackA = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('RACK'), u_total: 10 } });
  check('夹具: 机柜创建成功', rackA.status === 201, JSON.stringify(rackA.body));
  const rackId = rackA.body.id;

  const floorId = nextFloorId();
  const floorCreate = await api('PUT', `/api/it-assets/floors/${floorId}`, {
    uid: 1, role: 'admin', body: { name: uniq('楼层'), rooms: [{ id: 'R1', name: '机房1', w: 50, h: 50 }] },
  });
  check('夹具: 楼层创建成功', floorCreate.status === 200, JSON.stringify(floorCreate.body));

  function regAdmin(body) { return api('POST', '/api/it-assets', { uid: 1, role: 'admin', body }); }
  function editAdmin(id, body) { return api('PUT', `/api/it-assets/${id}`, { uid: 1, role: 'admin', body }); }

  // fullRow（长任务D·L3第2批·主会话裁定 A/B）：C3 新增的 validateRowSchema 要求「完整行」
  // （Object.keys(row) 恰等于 ASSET_ROW_KEYS），本文件里大量"纯函数直调"用例此前只手写十几个
  // 业务字段——补一个骨架 + 合法缺省值，调用方只需 Object.assign 自己关心的反例字段，不破坏
  // 各用例原有的反例语义（未被覆盖的列保持"随便一个合法值"，不影响该用例要独占触发的那条
  // RULE）。id:1 是合法安全正整数（非新建场景，纯函数直调不受"新建=undefined"限制）。
  function fullRow(overrides) {
    return Object.assign({
      id: 1, asset_no: null, category: 'other', name: 'x', brand: null, model: null, sn: null,
      status: 'in_depot', slot_count: 0, u_height: 0, u_start: null, rack_id: null, location_text: null,
      floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null,
      custodian_user_id: null, custodian_name: null, purchased_at: null, expires_at: null, attrs: {},
      fin_amount: null, fin_vendor: null, fin_contract_no: null, note: null, version: 1, created_by: 1,
      created_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00',
      owner_name: null, owner_dept: null, asset_class: null,
    }, overrides || {});
  }

  // ============================================================
  // A. 登记初态（方案 §5 六分支 + peer_versions 版本闭环）
  // ============================================================
  currentCaseLabel = 'A组: 登记初态';

  // A-非法组合（至少6种）
  const badCombos = [
    { category: 'disk', placement: { kind: 'rack', rack_id: rackId, u_start: 1 } },
    { category: 'server', placement: { kind: 'host', parent_asset_id: 1, slot_no: 1 } },
    { category: 'ap', placement: { kind: 'place', location_text: 'x' } },
    { category: 'laptop', placement: { kind: 'room', floor_id: floorId, room_id: 'R1' } },
    { category: 'other', placement: { kind: 'host', parent_asset_id: 1, slot_no: 1 } }, // u_height 未给=0，非机柜 other 不支持 host
    { category: 'ap', placement: { kind: 'custodian' } },
  ];
  for (let i = 0; i < badCombos.length; i++) {
    const c = badCombos[i];
    const r = await regAdmin({ category: c.category, name: uniq('bad'), placement: c.placement });
    check(`A-非法组合${i + 1}: category=${c.category} kind=${c.placement.kind} → 400`, r.status === 400, JSON.stringify(r.body));
    if (i === 0) {
      // T-H5 覆盖：INVALID_PLACEMENT_COMBO 码由 deriveInitialState 对"合法 kind 但类别不支持"
      // 场景专用返回，取第一条（disk+rack）做代表性 code 断言。
      check('A-非法组合1: code=INVALID_PLACEMENT_COMBO', r.body.code === 'INVALID_PLACEMENT_COMBO', JSON.stringify(r.body));
    }
  }
  const swBad = await regAdmin({ category: 'software', name: uniq('sw'), placement: { kind: 'depot' } });
  check('A-非法组合7: software 携带 placement → 400', swBad.status === 400, JSON.stringify(swBad.body));

  // A-顶层禁止键（T-M7：REGISTER_FORBIDDEN_TOP_FIELDS 全部 11 个键逐一注入，合法请求 + 单独
  //   携带该键 → 400 且 field 精确指向该键）。
  const REGISTER_FORBIDDEN_TOP_TABLE = [
    ['status', 'in_service'], ['rack_id', rackId], ['u_start', 1], ['parent_asset_id', 1],
    ['slot_no', 1], ['custodian_user_id', 1], ['custodian_name', 'x'], ['floor_id', floorId],
    ['room_id', 'R1'], ['pos', { x: 0.5, y: 0.5 }], ['version', 1],
  ];
  for (const [field, val] of REGISTER_FORBIDDEN_TOP_TABLE) {
    const r = await regAdmin({ category: 'server', name: uniq('topbad'), u_height: 2, [field]: val });
    check(`A-顶层禁止键${field}: 400 field=${field}`, r.status === 400 && r.body.field === field, JSON.stringify(r.body));
  }

  // A-placement 多余键（T-M7：补 field 断言）
  const extraKeyReg = await regAdmin({ category: 'server', name: uniq('srv'), u_height: 2, placement: { kind: 'rack', rack_id: rackId, u_start: 1, foo: 1 } });
  check('A-placement多余键: rack.kind 多余键 → 400 field=placement', extraKeyReg.status === 400 && extraKeyReg.body.field === 'placement', JSON.stringify(extraKeyReg.body));

  // A-host 缺 peer_versions / 非 host 带非空 peer_versions
  const srvForHost = await regAdmin({ category: 'server', name: uniq('host-srv'), u_height: 2, slot_count: 4, placement: { kind: 'depot' } });
  check('A夹具: 登记宿主 server(库房态) 成功', srvForHost.status === 201, JSON.stringify(srvForHost.body));
  const hostId = srvForHost.body && srvForHost.body.id;
  const hostVersion0 = srvForHost.body && srvForHost.body.version;

  const missingPeer = await regAdmin({ category: 'disk', name: uniq('disk'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 } });
  check('A-host缺peer_versions: 400', missingPeer.status === 400 && missingPeer.body.field === 'peer_versions', JSON.stringify(missingPeer.body));

  const nonHostWithPeer = await regAdmin({
    category: 'other', name: uniq('other-place'), u_height: 0, placement: { kind: 'place', location_text: 'A栋' },
    peer_versions: { 1: 1 },
  });
  check('A-非host带非空peer_versions: 400', nonHostWithPeer.status === 400, JSON.stringify(nonHostWithPeer.body));

  // T-M4②（Opus 复看第8批）：非 host 分支的 peer_versions:null 此前只测过"非空对象"这一种非法
  // 值（S-L1 改的是"null 不再算缺省"，但没有专门测 null 本身），补上。
  const nonHostWithNullPeer = await regAdmin({
    category: 'other', name: uniq('other-place-nullpeer'), u_height: 0, placement: { kind: 'place', location_text: 'A栋' },
    peer_versions: null,
  });
  check('T-M4②-非host带peer_versions:null: 400 field=peer_versions', nonHostWithNullPeer.status === 400 && nonHostWithNullPeer.body.field === 'peer_versions', JSON.stringify(nonHostWithNullPeer.body));

  const staleVer = await regAdmin({
    category: 'disk', name: uniq('disk'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 },
    peer_versions: { [hostId]: hostVersion0 + 99 },
  });
  check('A-宿主陈旧版本: 409 VERSION_CONFLICT', staleVer.status === 409 && staleVer.body.code === 'VERSION_CONFLICT', JSON.stringify(staleVer.body));

  const diskOk = await regAdmin({
    category: 'disk', name: uniq('disk'), placement: { kind: 'host', parent_asset_id: hostId, slot_no: 1 },
    peer_versions: { [hostId]: hostVersion0 },
    owner_name: '张三', owner_dept: '信息技术部', asset_class: 'fixed',
  });
  check('A-host合法登记成功: 201', diskOk.status === 201, JSON.stringify(diskOk.body));
  check('A-host合法登记: 硬盘status跟随宿主(库房态)', diskOk.body && diskOk.body.status === 'in_depot', JSON.stringify(diskOk.body));
  const diskId = diskOk.body && diskOk.body.id;

  const hostAfter = await api('GET', `/api/it-assets/${hostId}`, { uid: 1, role: 'admin' });
  check('A-host合法登记: 宿主version+1', hostAfter.body.asset.version === hostVersion0 + 1, JSON.stringify(hostAfter.body.asset));
  const affectedEvent = hostAfter.body.events.find((e) => e.action === 'register' && e.role === 'affected' && e.related_asset_id === diskId);
  check('A-host合法登记: 宿主affected事件载荷正确', !!affectedEvent
    && affectedEvent.from_state.slot_no === 1 && affectedEvent.from_state.disk_id === null
    && affectedEvent.to_state.slot_no === 1 && affectedEvent.to_state.disk_id === diskId,
    JSON.stringify(affectedEvent));

  // 宿主 retired
  const retiredHost = await regAdmin({ category: 'server', name: uniq('retired-host'), u_height: 2, slot_count: 2, placement: { kind: 'depot' } });
  const retiredHostId = retiredHost.body.id;
  await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.run("UPDATE it_assets SET status='retired' WHERE id=?", [retiredHostId], (e) => { db.close(); e ? reject(e) : resolve(); });
  });
  const hostRetiredRow = await api('GET', `/api/it-assets/${retiredHostId}`, { uid: 1, role: 'admin' });
  const toRetiredReg = await regAdmin({
    category: 'disk', name: uniq('disk'), placement: { kind: 'host', parent_asset_id: retiredHostId, slot_no: 1 },
    peer_versions: { [retiredHostId]: hostRetiredRow.body.asset.version },
  });
  check('A-宿主retired: 400', toRetiredReg.status === 400, JSON.stringify(toRetiredReg.body));

  // register 事件 to_state 覆盖（T-H3 扩为键集合全等断言）：库房三态各一 + rack + host +
  //   custodian + room + software/subscription（9 例，覆盖数超过"7 例"下限）。
  const regCases = [];
  const p10Depot = { owner_name: '张三', owner_dept: '信息技术部', asset_class: 'fixed' };
  const depotInDepot = await regAdmin({ category: 'server', name: uniq('depot-in_depot'), u_height: 1, placement: { kind: 'depot', status: 'in_depot' }, ...p10Depot });
  regCases.push(['库房态in_depot', depotInDepot, p10Depot]);
  const depotFaulty = await regAdmin({ category: 'server', name: uniq('depot-faulty'), u_height: 1, placement: { kind: 'depot', status: 'faulty' }, ...p10Depot });
  regCases.push(['库房态faulty', depotFaulty, p10Depot]);
  const depotToRetire = await regAdmin({ category: 'server', name: uniq('depot-to_retire'), u_height: 1, placement: { kind: 'depot', status: 'to_retire' }, ...p10Depot });
  regCases.push(['库房态to_retire', depotToRetire, p10Depot]);
  const rackReg = await regAdmin({ category: 'server', name: uniq('rack-srv'), u_height: 1, placement: { kind: 'rack', rack_id: rackId, u_start: 3 }, ...p10Depot });
  regCases.push(['rack', rackReg, p10Depot]);
  const p10Disk = { owner_name: '张三', owner_dept: '信息技术部', asset_class: 'fixed' };
  regCases.push(['host', diskOk, p10Disk]);
  const p10Custodian = { owner_name: '李四', owner_dept: '行政部', asset_class: 'low_value' };
  const custReg = await regAdmin({ category: 'laptop', name: uniq('laptop'), placement: { kind: 'custodian', custodian_name: '张三' }, ...p10Custodian });
  regCases.push(['custodian', custReg, p10Custodian]);
  const roomReg = await regAdmin({ category: 'ap', name: uniq('ap'), placement: { kind: 'room', floor_id: floorId, room_id: 'R1' }, ...p10Depot });
  regCases.push(['room', roomReg, p10Depot]);
  const p10Sw = { owner_name: '张三', owner_dept: '信息技术部', asset_class: 'low_value' };
  const swReg = await regAdmin({ category: 'software', name: uniq('sw'), expires_at: null, ...p10Sw });
  regCases.push(['software', swReg, p10Sw]);
  const subReg = await regAdmin({ category: 'subscription', name: uniq('sub'), expires_at: '2027-01-01', ...p10Sw });
  regCases.push(['subscription', subReg, p10Sw]);
  const EXPECTED_REGISTER_TO_STATE_KEYS = [
    'status', 'rack_id', 'u_start', 'location_text', 'floor_id', 'room_id', 'pos',
    'parent_asset_id', 'slot_no', 'custodian_user_id', 'custodian_name', 'expires_at',
    'owner_name', 'owner_dept', 'asset_class',
  ].sort();
  for (const [label, r, inputP10] of regCases) {
    check(`A-register事件覆盖(${label}): 登记成功`, r.status === 201, JSON.stringify(r.body));
    if (r.status === 201) {
      const detail = await api('GET', `/api/it-assets/${r.body.id}`, { uid: 1, role: 'admin' });
      const ev = detail.body.events.find((e) => e.action === 'register' && e.role === 'primary');
      check(`A-register事件覆盖(${label}): from_state={}`, ev && Object.keys(ev.from_state).length === 0, JSON.stringify(ev));
      const actualKeys = ev ? Object.keys(ev.to_state).sort() : [];
      check(`A-register事件覆盖(${label}): to_state键集合恰等于期望集合(status+全部位置列+custodian两列+expires_at+P10三键，null也写键)`,
        JSON.stringify(actualKeys) === JSON.stringify(EXPECTED_REGISTER_TO_STATE_KEYS), JSON.stringify(actualKeys));
      // T-M2（Opus 复看第5批）：不止比键集合，逐键与刚登记出来的资产实际落库值精确比较
      // （detail.asset 里的同名列），覆盖 status 与全部位置列的真实取值，而不仅仅是"这个键
      // 存在"。
      if (ev) {
        const asset = detail.body.asset;
        const mismatches = EXPECTED_REGISTER_TO_STATE_KEYS.filter((k) => stableStringifyForTest(ev.to_state[k]) !== stableStringifyForTest(asset[k]));
        check(`A-register事件覆盖(${label}): to_state逐键值与落库资产精确一致`, mismatches.length === 0,
          JSON.stringify({ mismatches, to_state: ev.to_state, asset }));
      }
      // T1（Opus 复看第9小批，coordinator 2026-09）：P10 三值的"权威真相"是本次请求实际传入
      // 的输入值——分别独立核对资产详情与 register 事件 to_state 是否等于输入，而不是像上面
      // 那样"资产 vs 事件互相比对"（互比只能证明两者一致，证不出"两者都对"，万一两处用同一个
      // 错误值就会互相掩护，测不出问题）。
      if (ev) {
        const p10Mismatches = Object.keys(inputP10).filter((k) => detail.body.asset[k] !== inputP10[k]);
        check(`A-register事件覆盖(${label}): 资产详情P10三值等于输入(权威源比对，非互比)`,
          p10Mismatches.length === 0, JSON.stringify({ mismatches: p10Mismatches, asset: detail.body.asset, input: inputP10 }));
        const p10EventMismatches = Object.keys(inputP10).filter((k) => ev.to_state[k] !== inputP10[k]);
        check(`A-register事件覆盖(${label}): register事件to_state的P10三值等于输入(权威源比对，非互比)`,
          p10EventMismatches.length === 0, JSON.stringify({ mismatches: p10EventMismatches, to_state: ev.to_state, input: inputP10 }));
      }
    }
  }

  // T-M4（Opus 复看第5批）：真并发用事务门闩（既有 txnMidGate 钩子）显式控制——阻塞第一笔在
  // BEGIN 之后、业务逻辑之前，等第二笔真的进了 mutex 等待队列（waiterCount 到达信号，不是猜
  // 时间）再放行，Promise.all 收两者最终结果。这样能保证"两者确实重叠竞争过 mutex"，不是靠
  // Promise.all 天然的调度顺序侥幸撞上。
  async function raceViaMutexGate(makeFirst, makeSecond, label) {
    const arrived = itLedgerModule._internals.setTxnMidGate(new Promise((resolve) => { itLedgerModule.__resolveRaceGate = resolve; }));
    const p1 = makeFirst();
    await awaitArrived(arrived, `${label}到达txnMidGate`, p1);
    const p2 = makeSecond();
    await schedulingBarrier();
    const queued = await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, `${label}等待第二笔排队`, 3000);
    check(`${label}: 第二笔确实已排入mutex等待队列`, queued === true, `waiterCount=${itTxnMutex._internals.waiterCount()}`);
    itLedgerModule.__resolveRaceGate();
    itLedgerModule._internals.setTxnMidGate(null);
    return Promise.all([p1, p2]);
  }

  // Promise.all 竞争：同柜同区间（T-H2：加 body.code 断言 + DB 回查恰一行）
  {
    const rackName = uniq('RACK-RACE');
    const raceRack = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: rackName, u_total: 10 } });
    const raceRackId = raceRack.body.id;
    const [r1, r2] = await raceViaMutexGate(
      () => regAdmin({ category: 'server', name: uniq('race-a'), u_height: 2, placement: { kind: 'rack', rack_id: raceRackId, u_start: 1 } }),
      () => regAdmin({ category: 'server', name: uniq('race-b'), u_height: 2, placement: { kind: 'rack', rack_id: raceRackId, u_start: 1 } }),
      'A-并发同柜同区间'
    );
    const raceResults = [r1, r2];
    const raceSucc = raceResults.filter((r) => r.status === 201);
    const raceFail = raceResults.filter((r) => r.status !== 201);
    check('A-并发同柜同区间: 恰一成功一409', raceSucc.length === 1 && raceFail.length === 1 && raceFail[0].status === 409, JSON.stringify([r1.status, r2.status]));
    check('A-并发同柜同区间: 失败方code=RACK_SLOT_OCCUPIED', raceFail.length === 1 && raceFail[0].body.code === 'RACK_SLOT_OCCUPIED', JSON.stringify(raceFail[0] && raceFail[0].body));
    const raceRows = await rawAll("SELECT id FROM it_assets WHERE rack_id=? AND u_start=1 AND status='in_service'", [raceRackId]);
    check('A-并发同柜同区间: DB回查该区间恰一行', raceRows.length === 1, `rows=${raceRows.length}`);
  }
  // Promise.all 竞争：两盘同宿主同slot（Opus 复看第2条收紧）：两请求各自持同一个正确宿主
  //   版本——mutex 串行后第二个请求重读宿主发现 version 已被第一个请求 +1，必撞版本比对（版本
  //   比对先于 slot 预查执行），如实收紧为单码 VERSION_CONFLICT（不再留 SLOT_OCCUPIED 候选，
  //   这条并发用例从未、也不可能触发 SLOT_OCCUPIED——该码的端到端覆盖见下方新增的串行用例）。
  {
    const raceHost = await regAdmin({ category: 'server', name: uniq('race-host'), u_height: 1, slot_count: 2, placement: { kind: 'depot' } });
    const raceHostId = raceHost.body.id;
    const rv = raceHost.body.version;
    const [d1, d2] = await raceViaMutexGate(
      () => regAdmin({ category: 'disk', name: uniq('race-disk-a'), placement: { kind: 'host', parent_asset_id: raceHostId, slot_no: 1 }, peer_versions: { [raceHostId]: rv } }),
      () => regAdmin({ category: 'disk', name: uniq('race-disk-b'), placement: { kind: 'host', parent_asset_id: raceHostId, slot_no: 1 }, peer_versions: { [raceHostId]: rv } }),
      'A-并发同宿主同slot'
    );
    const slotResults = [d1, d2];
    const slotSucc = slotResults.filter((r) => r.status === 201);
    const slotFail = slotResults.filter((r) => r.status !== 201);
    check('A-并发同宿主同slot: 恰一成功一409', slotSucc.length === 1 && slotFail.length === 1 && slotFail[0].status === 409, JSON.stringify([d1.status, d2.status]));
    expectCode(slotFail[0], 'VERSION_CONFLICT', 'A-并发同宿主同slot: 失败方code=VERSION_CONFLICT(版本比对先于slot预查，两请求同版本必撞版本冲突，如实收紧为单码)');
    const slotRows = await rawAll('SELECT id FROM it_assets WHERE parent_asset_id=? AND slot_no=1', [raceHostId]);
    check('A-并发同宿主同slot: DB回查该slot恰一行', slotRows.length === 1, `rows=${slotRows.length}`);
  }
  // 串行用例：SLOT_OCCUPIED 端到端真实触发（Opus 复看第2条新增）——盘 A 先登记进宿主 slot1
  //   （真实提交、宿主 version+1），重新 GET 宿主拿最新 version，盘 B 用这个正确的新版本再登记
  //   同一个 slot1：版本比对通过，落到 slot 预查才会撞 409，这是 SLOT_OCCUPIED 唯一能被触发的
  //   路径（并发场景版本比对必然先拦，见上一条）。
  {
    const slotHost = await regAdmin({ category: 'server', name: uniq('slot-host'), u_height: 1, slot_count: 2, placement: { kind: 'depot' } });
    const slotHostId = slotHost.body.id;
    const diskA = await regAdmin({ category: 'disk', name: uniq('slot-disk-a'), placement: { kind: 'host', parent_asset_id: slotHostId, slot_no: 1 }, peer_versions: { [slotHostId]: slotHost.body.version } });
    check('串行SLOT_OCCUPIED夹具: 盘A登记成功', diskA.status === 201, JSON.stringify(diskA.body));
    const slotHostAfterA = await api('GET', `/api/it-assets/${slotHostId}`, { uid: 1, role: 'admin' });
    const diskB = await regAdmin({ category: 'disk', name: uniq('slot-disk-b'), placement: { kind: 'host', parent_asset_id: slotHostId, slot_no: 1 }, peer_versions: { [slotHostId]: slotHostAfterA.body.asset.version } });
    check('串行SLOT_OCCUPIED: 盘B用正确新版本登记同slot: 409', diskB.status === 409, JSON.stringify(diskB.body));
    expectCode(diskB, 'SLOT_OCCUPIED', '串行SLOT_OCCUPIED: code=SLOT_OCCUPIED(端到端真实触发，非并发场景绕开版本比对)');
    const slotOccRows = await rawAll('SELECT id FROM it_assets WHERE parent_asset_id=? AND slot_no=1', [slotHostId]);
    check('串行SLOT_OCCUPIED: DB回查slot1恰一行(盘A)', slotOccRows.length === 1 && slotOccRows[0].id === diskA.body.id, JSON.stringify(slotOccRows));
  }

  // T-rec M4（Opus 复看第8批）：保留一条无门闩的裸 Promise.all 竞争用例——不用 txnMidGate
  // 人为控制时序，让两个请求按 Node/操作系统的自然调度真实抢 mutex。断言收紧到"不允许两者
  // 都成功"（不管是恰一成功一 409，还是理论上两者都撞了别的 409，只要没有出现"两个都拿到
  // 201"这种破坏唯一性约束的结果就算过）——这条用例的价值是"哪怕不用任何人工时序控制，
  // 真实并发下也不会出现重复占用"，与上面两条门闩精确控制的用例互补而不是重复。
  {
    const rawRackName = uniq('RACK-RAW-RACE');
    const rawRaceRack = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: rawRackName, u_total: 10 } });
    const rawRaceRackId = rawRaceRack.body.id;
    const [rawR1, rawR2] = await Promise.all([
      regAdmin({ category: 'server', name: uniq('raw-race-a'), u_height: 2, placement: { kind: 'rack', rack_id: rawRaceRackId, u_start: 1 } }),
      regAdmin({ category: 'server', name: uniq('raw-race-b'), u_height: 2, placement: { kind: 'rack', rack_id: rawRaceRackId, u_start: 1 } }),
    ]);
    const rawSuccessCount = [rawR1, rawR2].filter((r) => r.status === 201).length;
    check('T-rec M4-无门闩裸并发同柜同区间: 不允许两者都成功', rawSuccessCount <= 1, JSON.stringify([rawR1.status, rawR2.status]));
    const rawRaceRows = await rawAll("SELECT id FROM it_assets WHERE rack_id=? AND u_start=1 AND status='in_service'", [rawRaceRackId]);
    check('T-rec M4-无门闩裸并发: DB回查该区间不超过一行', rawRaceRows.length <= 1, `rows=${rawRaceRows.length}`);
  }

  // ============================================================
  // B. 唯一性
  // ============================================================
  currentCaseLabel = 'B组: 唯一性';
  const snVal = uniq('sn').toUpperCase();
  const b1 = await regAdmin({ category: 'other', name: uniq('b1'), u_height: 0, sn: snVal, placement: { kind: 'place', location_text: 'x' } });
  check('B-SN首次登记成功', b1.status === 201, JSON.stringify(b1.body));
  const b2 = await regAdmin({ category: 'other', name: uniq('b2'), u_height: 0, sn: snVal.toLowerCase(), placement: { kind: 'place', location_text: 'x' } });
  check('B-SN大小写归一后重复: 409', b2.status === 409 && b2.body.code === 'DUPLICATE_SN', JSON.stringify(b2.body));

  const assetNoVal = uniq('AN');
  const b3 = await regAdmin({ category: 'other', name: uniq('b3'), u_height: 0, asset_no: assetNoVal, placement: { kind: 'place', location_text: 'x' } });
  check('B-asset_no首次登记成功', b3.status === 201, JSON.stringify(b3.body));
  const b4 = await regAdmin({ category: 'other', name: uniq('b4'), u_height: 0, asset_no: assetNoVal, placement: { kind: 'place', location_text: 'x' } });
  check('B-asset_no重复: 409', b4.status === 409 && b4.body.code === 'DUPLICATE_ASSET_NO', JSON.stringify(b4.body));

  const b5 = await regAdmin({ category: 'other', name: uniq('b5'), u_height: 0, sn: '', placement: { kind: 'place', location_text: 'x' } });
  const b6 = await regAdmin({ category: 'other', name: uniq('b6'), u_height: 0, sn: '', placement: { kind: 'place', location_text: 'x' } });
  check('B-空串sn两次登记都成功(归NULL)', b5.status === 201 && b6.status === 201, JSON.stringify([b5.body, b6.body]));
  // T-M7：DB 回查两行的 sn 确实是 NULL（不是空字符串本身撞了唯一索引又恰好被放行）。
  const bSnRows = await rawAll('SELECT sn FROM it_assets WHERE id IN (?,?)', [b5.body.id, b6.body.id]);
  check('B-空串sn两次登记: DB回查sn均为NULL', bSnRows.length === 2 && bSnRows.every((r) => r.sn === null), JSON.stringify(bSnRows));

  // T-M4①（Opus 复看第8批，回应23-R指正）：第5批回报声称"编辑改他人sn/asset_no各一条409
  // （已有B组延伸覆盖）"，但守卫全文实际找不到对应 PUT 请求——如实补齐真实的 PUT 用例（不是
  // 声称，是这里能看到的具体请求+断言），并在本次回报里给出确切行号。
  const dupAssetA = await regAdmin({
    category: 'other', name: uniq('dup-a'), u_height: 0, sn: uniq('DUPSNA').toUpperCase(), asset_no: uniq('DUPANA'),
    placement: { kind: 'place', location_text: 'x' },
  });
  check('T-M4①夹具: 资产A登记成功(带sn/asset_no)', dupAssetA.status === 201, JSON.stringify(dupAssetA.body));
  const dupAssetB = await regAdmin({
    category: 'other', name: uniq('dup-b'), u_height: 0, sn: uniq('DUPSNB').toUpperCase(), asset_no: uniq('DUPANB'),
    placement: { kind: 'place', location_text: 'x' },
  });
  check('T-M4①夹具: 资产B登记成功(带不同sn/asset_no)', dupAssetB.status === 201, JSON.stringify(dupAssetB.body));

  const dupSnPut = await editAdmin(dupAssetB.body.id, { expected_version: dupAssetB.body.version, sn: dupAssetA.body.sn });
  check('T-M4①-PUT把B的sn改成A的sn: 409 DUPLICATE_SN', dupSnPut.status === 409 && dupSnPut.body.code === 'DUPLICATE_SN', JSON.stringify(dupSnPut.body));
  const dupBAfterSnAttempt = await api('GET', `/api/it-assets/${dupAssetB.body.id}`, { uid: 1, role: 'admin' });
  check('T-M4①-B未变(sn与version均不变)',
    dupBAfterSnAttempt.body.asset.sn === dupAssetB.body.sn && dupBAfterSnAttempt.body.asset.version === dupAssetB.body.version,
    JSON.stringify(dupBAfterSnAttempt.body.asset));

  const dupAssetNoPut = await editAdmin(dupAssetB.body.id, { expected_version: dupAssetB.body.version, asset_no: dupAssetA.body.asset_no });
  check('T-M4①-PUT把B的asset_no改成A的asset_no: 409 DUPLICATE_ASSET_NO', dupAssetNoPut.status === 409 && dupAssetNoPut.body.code === 'DUPLICATE_ASSET_NO', JSON.stringify(dupAssetNoPut.body));
  const dupBAfterAssetNoAttempt = await api('GET', `/api/it-assets/${dupAssetB.body.id}`, { uid: 1, role: 'admin' });
  check('T-M4①-B未变(asset_no与version均不变)',
    dupBAfterAssetNoAttempt.body.asset.asset_no === dupAssetB.body.asset_no && dupBAfterAssetNoAttempt.body.asset.version === dupAssetB.body.version,
    JSON.stringify(dupBAfterAssetNoAttempt.body.asset));

  // R-M1（codex 22-R）：mapConstraintError 纯函数直调单测——真实并发窗口在 mutex 全局串行下
  // 无法被正常业务请求触发（预查在同一事务内先于 INSERT/UPDATE 执行，见调用点注释），退而
  // 求其次：直接构造带 code='SQLITE_CONSTRAINT' 与真实消息文本的 Error 对象喂给映射函数，
  // 断言两条索引精确映射，`it_racks.name`（其它表单列唯一约束）与复合索引（两列一起违反）
  // 均不映射（维持原样直通 500）。
  {
    const { mapConstraintError } = itLedgerModule._internals;
    const mkErr = (message, code) => Object.assign(new Error(message), { code: code === undefined ? 'SQLITE_CONSTRAINT' : code });

    const snErr = mapConstraintError(mkErr('SQLITE_CONSTRAINT: UNIQUE constraint failed: it_assets.sn'));
    check('R-M1-mapConstraintError: it_assets.sn精确映射DUPLICATE_SN/409',
      !!snErr && snErr.code === 'DUPLICATE_SN' && snErr.status === 409 && snErr.field === 'sn', JSON.stringify(snErr));

    const assetNoErr = mapConstraintError(mkErr('SQLITE_CONSTRAINT: UNIQUE constraint failed: it_assets.asset_no'));
    check('R-M1-mapConstraintError: it_assets.asset_no精确映射DUPLICATE_ASSET_NO/409',
      !!assetNoErr && assetNoErr.code === 'DUPLICATE_ASSET_NO' && assetNoErr.status === 409 && assetNoErr.field === 'asset_no', JSON.stringify(assetNoErr));

    const rackNameErr = mapConstraintError(mkErr('SQLITE_CONSTRAINT: UNIQUE constraint failed: it_racks.name'));
    check('R-M1-mapConstraintError: it_racks.name(其它表单列)不映射(null)', rackNameErr === null, JSON.stringify(rackNameErr));

    const compositeErr = mapConstraintError(mkErr('SQLITE_CONSTRAINT: UNIQUE constraint failed: it_assets.parent_asset_id, it_assets.slot_no'));
    check('R-M1-mapConstraintError: 复合索引(两列)不映射(null)', compositeErr === null, JSON.stringify(compositeErr));

    // 非 SQLITE_CONSTRAINT 的普通错误（哪怕消息文本长得像）也不该被误映射。
    const nonConstraintErr = mapConstraintError(new Error('UNIQUE constraint failed: it_assets.sn'));
    check('R-M1-mapConstraintError: 非SQLITE_CONSTRAINT错误(即使消息文本相似)不映射(null)', nonConstraintErr === null, JSON.stringify(nonConstraintErr));

    // errno===19 也应被识别（node-sqlite3 有的版本只带 errno 不带 code 字符串）。
    const errnoErr = mapConstraintError(Object.assign(new Error('UNIQUE constraint failed: it_assets.sn'), { errno: 19 }));
    check('R-M1-mapConstraintError: 仅带errno=19(不带code字符串)也能识别映射', !!errnoErr && errnoErr.code === 'DUPLICATE_SN', JSON.stringify(errnoErr));
  }

  // ============================================================
  // C. slot_count / u_height 边界
  // ============================================================
  currentCaseLabel = 'C组: slot_count/u_height边界';
  const cHost = await regAdmin({ category: 'server', name: uniq('c-host'), u_height: 1, slot_count: 2, placement: { kind: 'depot' } });
  const cHostId = cHost.body.id;
  await regAdmin({ category: 'disk', name: uniq('c-disk1'), placement: { kind: 'host', parent_asset_id: cHostId, slot_no: 1 }, peer_versions: { [cHostId]: cHost.body.version } });
  const cHostV1 = await api('GET', `/api/it-assets/${cHostId}`, { uid: 1, role: 'admin' });
  await regAdmin({ category: 'disk', name: uniq('c-disk2'), placement: { kind: 'host', parent_asset_id: cHostId, slot_no: 2 }, peer_versions: { [cHostId]: cHostV1.body.asset.version } });
  const cHostV2 = await api('GET', `/api/it-assets/${cHostId}`, { uid: 1, role: 'admin' });

  const c1 = await editAdmin(cHostId, { expected_version: cHostV2.body.asset.version, slot_count: 1 });
  check('C-slot_count减小到低于已占: 409', c1.status === 409 && c1.body.code === 'SLOT_COUNT_BELOW_OCCUPIED', JSON.stringify(c1.body));
  const c2 = await editAdmin(cHostId, { expected_version: cHostV2.body.asset.version, slot_count: 0 });
  check('C-带随装盘改slot_count=0: 409', c2.status === 409 && c2.body.code === 'SLOT_COUNT_BELOW_OCCUPIED', JSON.stringify(c2.body));

  const otherRack = await regAdmin({ category: 'other', name: uniq('other-rack'), u_height: 1, placement: { kind: 'rack', rack_id: rackId, u_start: 6 } });
  check('C夹具: other上架登记成功', otherRack.status === 201, JSON.stringify(otherRack.body));
  const c3 = await editAdmin(otherRack.body.id, { expected_version: otherRack.body.version, u_height: 2 });
  check('C-other在位改u_height: 409 U_HEIGHT_LOCKED', c3.status === 409 && c3.body.code === 'U_HEIGHT_LOCKED', JSON.stringify(c3.body));

  const c4 = await regAdmin({ category: 'server', name: uniq('c4'), u_height: 0, placement: { kind: 'depot' } });
  check('C-server登记u_height=0: 400 field=u_height', c4.status === 400 && c4.body.field === 'u_height', JSON.stringify(c4.body));

  const otherDepot = await regAdmin({ category: 'other', name: uniq('other-depot'), u_height: 0, placement: { kind: 'place', location_text: 'A栋' } });
  check('C夹具: other非机柜(库房态)登记成功', otherDepot.status === 201, JSON.stringify(otherDepot.body));
  // 跨0边界前先转到库房态：place kind 本身即 in_service，故改用 depot 分支重建一条库房态记录
  const otherDepot2 = await regAdmin({ category: 'other', name: uniq('other-depot2'), u_height: 0, placement: { kind: 'depot' } });
  const c5 = await editAdmin(otherDepot2.body.id, { expected_version: otherDepot2.body.version, u_height: 3 });
  check('C-other库房态跨0边界改u_height: 成功', c5.status === 200 && c5.body.u_height === 3, JSON.stringify(c5.body));

  // ============================================================
  // D. 保管人条件非空（HTTP 可达部分；库房态带保管人不可经 register/edit 到达，见回报第8项）
  // ============================================================
  currentCaseLabel = 'D组: 保管人条件非空';
  const d1 = await regAdmin({ category: 'laptop', name: uniq('laptop-nocust'), placement: { kind: 'custodian' } });
  check('D-终端在位无保管人: 409 CUSTODIAN_REQUIRED', d1.status === 409 && d1.body.code === 'CUSTODIAN_REQUIRED', JSON.stringify(d1.body));
  const d2 = await regAdmin({ category: 'server', name: uniq('srv-cust'), u_height: 1, placement: { kind: 'custodian', custodian_name: 'x' } });
  check('D-server带保管人(非法placement组合): 400', d2.status === 400, JSON.stringify(d2.body));
  // 直接调用 invariants 纯函数证明"库房态带保管人 409"规则本身存在（HTTP 层暂不可达，见回报）。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const row = fullRow({
      category: 'laptop', status: 'in_depot', custodian_user_id: 1,
    });
    const violation = validateAssetInvariants(row, {});
    check('D-库房态带保管人(纯函数直调): CUSTODIAN_REQUIRED/409', !!violation && violation.code === 'CUSTODIAN_REQUIRED' && violation.status === 409, JSON.stringify(violation));
  }

  // Opus 复看第7批契约裁定①：宿主 retired + 子盘 retired 的行不再受困——HOST_SLOT（硬盘行
  // 视角）与 HOST_DISK_STATUS_SYNC（宿主行视角）都应放行（PARENT_ALLOWED_STATUSES 已挪成
  // 装盘动作前置条件，不再是这两条规则里对"行内自洽"的校验对象）。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const retiredDiskRow = fullRow({
      category: 'disk', status: 'retired', parent_asset_id: 100, slot_no: 1,
    });
    const diskViolation = validateAssetInvariants(retiredDiskRow, { parent: { slot_count: 2, status: 'retired', category: 'server' } });
    check('D-宿主retired+子盘retired(纯函数直调,硬盘行视角HOST_SLOT): 不受困，放行(null)', diskViolation === null, JSON.stringify(diskViolation));

    const retiredHostRow = fullRow({
      category: 'server', status: 'retired', u_height: 2, slot_count: 2,
    });
    const hostViolation = validateAssetInvariants(retiredHostRow, { childDisks: [{ slot_no: 1, status: 'retired' }] });
    check('D-宿主retired+子盘retired(纯函数直调,宿主行视角HOST_DISK_STATUS_SYNC): 不受困，放行(null)', hostViolation === null, JSON.stringify(hostViolation));
  }

  // R-M2（codex 22-R）→ S2（codex 22-R2/23-R2 第9小批修复）：NUMERIC_DOMAIN 纯函数反例四条，
  // 按"键缺失(undefined，调用方编程错误) → ctxMissing/500"与"显式非法值(null 给必填字段/
  // 小数/负数，数据问题) → v()/400"两条分流断言——此前四条统一按 400 断言，S2 收紧后前三条
  // （键缺失）改判 500，只有 u_height=null（显式给了非法值，不是漏传）仍是 400。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const baseRow = fullRow({ category: 'other', status: 'in_depot', location_text: 'x' });
    const r1 = validateAssetInvariants(Object.assign({}, baseRow, { u_height: null }), {});
    check('R-M2反例①: u_height=null(显式非法值) → NUMERIC_DOMAIN违反 400 LEDGER_BAD_REQUEST',
      !!r1 && r1.rule === 'NUMERIC_DOMAIN' && r1.field === 'u_height' && r1.status === 400 && r1.code === 'LEDGER_BAD_REQUEST', JSON.stringify(r1));

    // 契约变更（主会话 2026-09-20 裁定 B.3）：漏键现由 C3 新增的前置层 validateRowSchema 一次性
    // 拦截（rule 由 NUMERIC_DOMAIN 改为 ROW_SCHEMA），不再是 NUMERIC_DOMAIN 自己判"键缺失"。
    const r2Row = Object.assign({}, baseRow); delete r2Row.slot_count;
    const r2 = validateAssetInvariants(r2Row, {});
    check('R-M2反例②: slot_count缺键 → ROW_SCHEMA违反(前置层拦截) 500 LEDGER_INTERNAL',
      !!r2 && r2.rule === 'ROW_SCHEMA' && r2.field === 'slot_count' && r2.status === 500 && r2.code === 'LEDGER_INTERNAL', JSON.stringify(r2));

    const r3Row = Object.assign({}, baseRow); delete r3Row.u_start;
    const r3 = validateAssetInvariants(r3Row, {});
    check('R-M2反例③: u_start缺键 → ROW_SCHEMA违反(前置层拦截) 500 LEDGER_INTERNAL',
      !!r3 && r3.rule === 'ROW_SCHEMA' && r3.field === 'u_start' && r3.status === 500 && r3.code === 'LEDGER_INTERNAL', JSON.stringify(r3));

    const r4Row = Object.assign({}, baseRow); delete r4Row.slot_no;
    const r4 = validateAssetInvariants(r4Row, {});
    check('R-M2反例④: slot_no缺键 → ROW_SCHEMA违反(前置层拦截) 500 LEDGER_INTERNAL',
      !!r4 && r4.rule === 'ROW_SCHEMA' && r4.field === 'slot_no' && r4.status === 500 && r4.code === 'LEDGER_INTERNAL', JSON.stringify(r4));
  }

  // S1（codex 22-R2/23-R2 第9小批修复）：ctx.childDisks 元素形态反例三条——null/undefined/'x'
  // 各一条，均须返回结构化 500 违反对象（而不是抛未捕获异常，验证方式是直接调用并断言返回值，
  // 若这里真的抛异常，测试进程会在此处崩溃，本身就是失败信号）。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const hostRowForChildDisks = fullRow({ category: 'server', status: 'in_depot', u_height: 2, slot_count: 2 });
    for (const [label, badChild] of [['null', null], ['undefined', undefined], ["'x'", 'x']]) {
      const violation = validateAssetInvariants(hostRowForChildDisks, { childDisks: [badChild] });
      check(`S1反例: ctx.childDisks=[${label}] → 返回500违反对象(不抛异常)`,
        !!violation && violation.code === 'LEDGER_INTERNAL' && violation.status === 500 && violation.field === 'childDisks',
        JSON.stringify(violation));
    }
  }

  // R-M3（codex 22-R）→ 第4批 HIGH-1（主会话裁定）：ctx 数值反例三条——occupiedIntervals
  // 端点 NaN / 反向区间(lo>hi) / childDisks.slot_no undefined。补全行后这三条实际由
  // validateRowSchema（ROW_SCHEMA）的 ctx 形态校验先一步拦下（不再是 ruleNumericDomain 的
  // ctxMissing），断言收紧到 rule + field 精确名，不只看 code/status（500/LEDGER_INTERNAL
  // 两者本就相同，光看这两个字段测不出"是谁拦的"，会被"缺键also是500"这种巧合遮蔽）。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const rackRow = fullRow({
      category: 'server', status: 'in_service', u_height: 2, slot_count: 0, u_start: 1, rack_id: 1,
    });
    const rNan = validateAssetInvariants(rackRow, { rack: { u_total: 10 }, occupiedIntervals: [[NaN, 5, 99]], childDisks: [] });
    check('R-M3反例①: occupiedIntervals端点NaN → ROW_SCHEMA/occupiedIntervals',
      !!rNan && rNan.rule === 'ROW_SCHEMA' && rNan.field === 'occupiedIntervals' && rNan.code === 'LEDGER_INTERNAL' && rNan.status === 500,
      JSON.stringify(rNan));

    const rReversed = validateAssetInvariants(rackRow, { rack: { u_total: 10 }, occupiedIntervals: [[8, 3, 99]], childDisks: [] });
    check('R-M3反例②: occupiedIntervals反向区间(lo>hi) → ROW_SCHEMA/occupiedIntervals',
      !!rReversed && rReversed.rule === 'ROW_SCHEMA' && rReversed.field === 'occupiedIntervals' && rReversed.code === 'LEDGER_INTERNAL' && rReversed.status === 500,
      JSON.stringify(rReversed));

    const hostRow2 = fullRow({
      category: 'server', status: 'in_depot', u_height: 2, slot_count: 2,
    });
    const rSlotUndef = validateAssetInvariants(hostRow2, { childDisks: [{ slot_no: undefined, status: 'in_depot' }] });
    check('R-M3反例③: childDisks.slot_no=undefined → ROW_SCHEMA/childDisks',
      !!rSlotUndef && rSlotUndef.rule === 'ROW_SCHEMA' && rSlotUndef.field === 'childDisks' && rSlotUndef.code === 'LEDGER_INTERNAL' && rSlotUndef.status === 500,
      JSON.stringify(rSlotUndef));
  }

  // ============================================================
  // E. 版本与编辑白名单 + 财务
  // ============================================================
  currentCaseLabel = 'E组: 版本与编辑白名单/财务';
  const eAsset = await regAdmin({ category: 'other', name: uniq('e-asset'), u_height: 0, placement: { kind: 'place', location_text: '原位置' } });
  const eId = eAsset.body.id;
  const e1 = await api('PUT', `/api/it-assets/${eId}`, { uid: 1, role: 'admin', body: { name: 'x' } });
  check('E-PUT缺expected_version: 400', e1.status === 400, JSON.stringify(e1.body));
  const e2 = await editAdmin(eId, { expected_version: eAsset.body.version + 99, name: 'x' });
  check('E-PUT陈旧版本: 409', e2.status === 409 && e2.body.code === 'VERSION_CONFLICT', JSON.stringify(e2.body));

  // T-M7：UPDATE_REJECT_FIELDS 全部 13 个键逐一注入，合法请求 + 单独携带该键 → 400 且 field
  // 精确指向该键。
  const UPDATE_REJECT_TABLE = [
    ['category', 'server'], ['status', 'in_service'], ['rack_id', rackId], ['u_start', 1],
    ['location_text', 'x'], ['floor_id', floorId], ['room_id', 'R1'], ['pos', { x: 0.5, y: 0.5 }],
    ['parent_asset_id', 1], ['slot_no', 1], ['custodian_user_id', 1], ['custodian_name', 'x'],
    ['version', 99],
  ];
  for (const [field, val] of UPDATE_REJECT_TABLE) {
    const r = await editAdmin(eId, { expected_version: eAsset.body.version, [field]: val });
    check(`E-PUT拒绝键${field}: 400 field=${field}`, r.status === 400 && r.body.field === field, JSON.stringify(r.body));
  }

  // T-H1（Opus 复看第5批）：非 admin 对四类财务字段（含不属于资产列的 external_amount）各单独
  //   尝试一次 PUT（合法值 + 当前 version）→ 400 财务禁键码 + 资产/version/事件三者均不变。
  const FIN_FORBIDDEN_KEYS = ['fin_amount', 'fin_vendor', 'fin_contract_no', 'external_amount'];
  let financeGuardBefore = await api('GET', `/api/it-assets/${eId}`, { uid: 1, role: 'admin' });
  for (const f of FIN_FORBIDDEN_KEYS) {
    const val = f === 'fin_amount' || f === 'external_amount' ? 500 : '某厂商';
    // T-M1（Opus 复看第8批）：请求前做一次 DB 直读全行快照（不经应用层 stripFinance，含全部
    // 财务列），拒绝后再直读一次，逐列精确比较——不再只看 API 响应里的 version/事件数这种
    // 弱证据，DB 层面的"一列都没变"才是真正的证明。
    const dbRowBefore = (await rawAll('SELECT * FROM it_assets WHERE id = ?', [eId]))[0];
    const eventCountBefore = (await rawAll('SELECT COUNT(*) AS c FROM it_asset_events WHERE asset_id = ?', [eId]))[0].c;
    const r = await api('PUT', `/api/it-assets/${eId}`, { uid: 2, role: 'user', body: { expected_version: financeGuardBefore.body.asset.version, [f]: val } });
    expectCode(r, 'FINANCE_FIELD_FORBIDDEN', `E-非admin带${f}: code=FINANCE_FIELD_FORBIDDEN`);
    check(`E-非admin带${f}: 状态码400`, r.status === 400, JSON.stringify(r.body));
    const dbRowAfter = (await rawAll('SELECT * FROM it_assets WHERE id = ?', [eId]))[0];
    const eventCountAfter = (await rawAll('SELECT COUNT(*) AS c FROM it_asset_events WHERE asset_id = ?', [eId]))[0].c;
    const changedCols = Object.keys(dbRowBefore).filter((col) => stableStringifyForTest(dbRowBefore[col]) !== stableStringifyForTest(dbRowAfter[col]));
    check(`E-非admin带${f}: DB全行逐列精确比较无一列变化`, changedCols.length === 0, `变化列: ${changedCols.join(',') || '(无)'}`);
    check(`E-非admin带${f}: 事件数不变(DB直读)`, eventCountAfter === eventCountBefore, `before=${eventCountBefore} after=${eventCountAfter}`);
    const after = await api('GET', `/api/it-assets/${eId}`, { uid: 1, role: 'admin' });
    check(`E-非admin带${f}: 资产version不变`, after.body.asset.version === financeGuardBefore.body.asset.version,
      `before=${financeGuardBefore.body.asset.version} after=${after.body.asset.version}`);
    check(`E-非admin带${f}: 事件数不变(未写入)`, after.body.events.length === financeGuardBefore.body.events.length,
      `before=${financeGuardBefore.body.events.length} after=${after.body.events.length}`);
  }

  // T-H2（Opus 复看第5批）：admin 先写入三项非空旧值，再改成三项不同新值——结构化核对事件
  //   from_state/to_state 的键集合（只允许 fin_changed，禁止四个真实财务键），且事件整体 JSON
  //   不含任何旧值/新值字面量；非 admin 时间线仍能看到该 update 事件与 fin_changed 字段名数组。
  const finOldVals = { fin_amount: 1000.5, fin_vendor: '旧供应商名称', fin_contract_no: 'OLD-CONTRACT-001' };
  const finBaseline = await editAdmin(eId, Object.assign({ expected_version: financeGuardBefore.body.asset.version }, finOldVals));
  check('E-admin写入三项财务旧值: 成功', finBaseline.status === 200, JSON.stringify(finBaseline.body));

  // T-H1（Opus 复看第8批）：不再用 `.filter().pop()` 猜"最后一条 update 事件就是这次改的"
  // （eId 之前已经历过 rejectFields 循环等多次 PUT 尝试，虽然大多是 400 未落库，但这种猜测式
  // 定位在测试演化中容易悄悉变得不可靠）——改成事件 id 差集：更新前记一次完整事件列表，更新
  // 后再取一次，差集里"新出现的 id"就是这次操作确凿产生的那一条，不依赖数组顺序假设。
  const eventsBeforeFinUpdate = (await api('GET', `/api/it-assets/${eId}`, { uid: 1, role: 'admin' })).body.events;
  const beforeFinUpdateIds = new Set(eventsBeforeFinUpdate.map((ev) => ev.id));

  const finNewVals = { fin_amount: 2000.75, fin_vendor: '新供应商名称', fin_contract_no: 'NEW-CONTRACT-002' };
  const finUpdated = await editAdmin(eId, Object.assign({ expected_version: finBaseline.body.version }, finNewVals));
  check('E-admin改三项财务新值: 成功', finUpdated.status === 200, JSON.stringify(finUpdated.body));

  const eDetailAdmin = await api('GET', `/api/it-assets/${eId}`, { uid: 1, role: 'admin' });
  const newFinEvents = eDetailAdmin.body.events.filter((ev) => !beforeFinUpdateIds.has(ev.id));
  check('E-财务改新值: 恰好新增一条事件(按id差集定位)', newFinEvents.length === 1, JSON.stringify(newFinEvents.map((e) => e.id)));
  const finEvent = newFinEvents[0];
  // T3（Opus 复看第9小批，coordinator 2026-09）：光靠"事件 id 是新出现的"不足以证明这就是
  // 那次财务编辑产生的 update 事件——同一批操作理论上可能夹带其它动作产生的事件（本例目前
  // 不会，但断言不该依赖"目前不会"这种偶然性），显式核对 action/role/asset_id 三项契约。
  check('E-财务编辑事件(admin视角): action=update, role=primary, asset_id=eId',
    !!finEvent && finEvent.action === 'update' && finEvent.role === 'primary' && finEvent.asset_id === eId,
    JSON.stringify(finEvent));
  const finFromKeys = finEvent ? Object.keys(finEvent.from_state) : [];
  const finToKeys = finEvent ? Object.keys(finEvent.to_state) : [];
  // index.js 的 fromPrimary 从不写 fin_changed（只有 to_state 记"哪些财务字段变了"），纯财务
  // 变动的 from_state 因此应为空对象——不是"两侧都有 fin_changed"，是"to 有、from 没有"。
  check('E-财务编辑事件(结构化): from_state为空对象(财务变动不记旧值)', finFromKeys.length === 0, JSON.stringify(finFromKeys));
  check('E-财务编辑事件(结构化): to_state键集合恰为{fin_changed}', finToKeys.length === 1 && finToKeys[0] === 'fin_changed', JSON.stringify(finToKeys));
  check('E-财务编辑事件(结构化): from/to两侧均不含四真实财务键',
    !!finEvent && FIN_FORBIDDEN_KEYS.every((k) => !finFromKeys.includes(k) && !finToKeys.includes(k)), JSON.stringify({ finFromKeys, finToKeys }));
  check('E-财务编辑事件(结构化): to_state.fin_changed恰含三字段名', !!finEvent
    && new Set(finEvent.to_state.fin_changed).size === 3
    && ['fin_amount', 'fin_vendor', 'fin_contract_no'].every((k) => finEvent.to_state.fin_changed.includes(k)),
    JSON.stringify(finEvent && finEvent.to_state));
  const finEventJson = JSON.stringify(finEvent);
  check('E-财务编辑事件(结构化): JSON不含旧值字面量(零泄露)', !finEventJson.includes('1000.5') && !finEventJson.includes('旧供应商名称') && !finEventJson.includes('OLD-CONTRACT-001'), finEventJson);
  check('E-财务编辑事件(结构化): JSON不含新值字面量(零泄露)', !finEventJson.includes('2000.75') && !finEventJson.includes('新供应商名称') && !finEventJson.includes('NEW-CONTRACT-002'), finEventJson);
  check('E-admin详情含三项财务真实新值(对照)',
    eDetailAdmin.body.asset.fin_amount === 2000.75 && eDetailAdmin.body.asset.fin_vendor === '新供应商名称' && eDetailAdmin.body.asset.fin_contract_no === 'NEW-CONTRACT-002',
    JSON.stringify(eDetailAdmin.body.asset));

  const eDetailUser = await api('GET', `/api/it-assets/${eId}`, { uid: 3, role: 'user' });
  check('E-非admin详情无四财务键', eDetailUser.status === 200 && FIN_FORBIDDEN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(eDetailUser.body.asset, k)), JSON.stringify(eDetailUser.body.asset));
  check('E-非admin详情保留非敏感字段(name)', eDetailUser.body.asset.name === eDetailAdmin.body.asset.name, JSON.stringify(eDetailUser.body.asset));
  // T-H1：非 admin 一侧核对的必须是"同一个事件 id"（不是再猜一次"最后一条"），确保两次读取
  // 看到的是同一条被改造过的记录，而不是碰巧对上的两条不同事件。
  const finEventUser = eDetailUser.body.events.find((ev) => ev.id === finEvent.id);
  check('E-非admin时间线能按id找到同一条update事件', !!finEventUser, `finEvent.id=${finEvent && finEvent.id}`);
  // T3：非 admin 视角同样核对 action/role/asset_id 三项契约（stripFinance 只该剔除财务字段，
  // 不该动这几个结构性字段）。
  check('E-非admin时间线该事件: action=update, role=primary, asset_id=eId',
    !!finEventUser && finEventUser.action === 'update' && finEventUser.role === 'primary' && finEventUser.asset_id === eId,
    JSON.stringify(finEventUser));
  const finFromKeysUser = finEventUser ? Object.keys(finEventUser.from_state) : [];
  const finToKeysUser = finEventUser ? Object.keys(finEventUser.to_state) : [];
  check('E-非admin时间线该事件: from_state空对象、to_state恰为{fin_changed}',
    finFromKeysUser.length === 0 && finToKeysUser.length === 1 && finToKeysUser[0] === 'fin_changed',
    JSON.stringify({ finFromKeysUser, finToKeysUser }));
  check('E-非admin时间线fin_changed恰含三字段名(结构化)',
    !!finEventUser && Array.isArray(finEventUser.to_state.fin_changed) && finEventUser.to_state.fin_changed.length === 3
    && ['fin_amount', 'fin_vendor', 'fin_contract_no'].every((k) => finEventUser.to_state.fin_changed.includes(k)),
    JSON.stringify(finEventUser));
  const finEventUserJson = JSON.stringify(finEventUser);
  check('E-非admin时间线该事件JSON零泄露(新旧值均不出现)',
    !finEventUserJson.includes('1000.5') && !finEventUserJson.includes('2000.75')
    && !finEventUserJson.includes('旧供应商名称') && !finEventUserJson.includes('新供应商名称')
    && !finEventUserJson.includes('OLD-CONTRACT-001') && !finEventUserJson.includes('NEW-CONTRACT-002'),
    finEventUserJson);

  const listUser = await api('GET', '/api/it-assets?category=other', { uid: 3, role: 'user' });
  const listedE = listUser.body.items.find((it) => it.id === eId);
  check('E-非admin列表无四财务键且该行存在', !!listedE && FIN_FORBIDDEN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(listedE, k)), JSON.stringify(listedE));

  // ============================================================
  // F. 事件（仅记改动列 + 零变化不写事件）
  // ============================================================
  currentCaseLabel = 'F组: 事件';
  const fAsset = await regAdmin({ category: 'other', name: uniq('f-asset'), note: '旧备注', u_height: 0, placement: { kind: 'place', location_text: 'x' } });
  const fId = fAsset.body.id;
  const f1 = await editAdmin(fId, { expected_version: fAsset.body.version, name: uniq('f-new-name'), note: '新备注' });
  check('F-改name+note: 编辑成功', f1.status === 200, JSON.stringify(f1.body));
  const fDetail1 = await api('GET', `/api/it-assets/${fId}`, { uid: 1, role: 'admin' });
  const fEvent1 = fDetail1.body.events.find((ev) => ev.action === 'update');
  const toKeys = fEvent1 ? Object.keys(fEvent1.to_state).sort() : [];
  const fromKeys1 = fEvent1 ? Object.keys(fEvent1.from_state).sort() : [];
  check('F-update事件只记改动列(恰两键 name/note)', toKeys.length === 2 && toKeys.includes('name') && toKeys.includes('note'), JSON.stringify(fEvent1));
  // T-M2（Opus 复看第5批）：两侧键集合精确一致（from/to 必须是同一组键，不能一边多一边少）+
  // 旧新值精确比较（from 是登记时的旧值，to 是编辑后的新值），不止是"两个键"这么弱的断言。
  check('F-update事件: from_state/to_state键集合完全一致', JSON.stringify(fromKeys1) === JSON.stringify(toKeys), JSON.stringify({ fromKeys1, toKeys }));
  check('F-update事件: from_state.name/note为登记时旧值',
    !!fEvent1 && fEvent1.from_state.name === fAsset.body.name && fEvent1.from_state.note === '旧备注', JSON.stringify(fEvent1 && fEvent1.from_state));
  check('F-update事件: to_state.name/note为编辑后新值',
    !!fEvent1 && fEvent1.to_state.name === f1.body.name && fEvent1.to_state.note === '新备注', JSON.stringify(fEvent1 && fEvent1.to_state));

  const eventsBefore = fDetail1.body.events.length;
  const versionBefore = f1.body.version;
  const f2 = await editAdmin(fId, { expected_version: versionBefore, name: f1.body.name, note: f1.body.note });
  check('F-零变化编辑: 200且version不变', f2.status === 200 && f2.body.version === versionBefore, JSON.stringify(f2.body));
  const fDetail2 = await api('GET', `/api/it-assets/${fId}`, { uid: 1, role: 'admin' });
  check('F-零变化编辑: 不新增事件', fDetail2.body.events.length === eventsBefore, `before=${eventsBefore} after=${fDetail2.body.events.length}`);

  // ============================================================
  // G. 机柜 CRUD
  // ============================================================
  currentCaseLabel = 'G组: 机柜CRUD';

  // T-M4③（Opus 复看第8批）：rack POST room 字段形态非法（null/数字）此前零覆盖，补上。
  const gRoomNull = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('G-ROOM-NULL'), room: null } });
  check('T-M4③-rack POST room:null: 400 field=room', gRoomNull.status === 400 && gRoomNull.body.field === 'room', JSON.stringify(gRoomNull.body));
  const gRoomNum = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('G-ROOM-NUM'), room: 123 } });
  check('T-M4③-rack POST room:123: 400 field=room', gRoomNum.status === 400 && gRoomNum.body.field === 'room', JSON.stringify(gRoomNum.body));

  const gRack = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('G-RACK'), u_total: 10 } });
  const gRackId = gRack.body.id;
  const gAsset = await regAdmin({ category: 'server', name: uniq('g-srv'), u_height: 2, placement: { kind: 'rack', rack_id: gRackId, u_start: 8 } }); // 占用 8-9
  check('G夹具: 机柜设备登记成功(占用8-9)', gAsset.status === 201, JSON.stringify(gAsset.body));

  const g1 = await api('PUT', `/api/it-assets/racks/${gRackId}`, { uid: 1, role: 'admin', body: { u_total: 8 } });
  check('G-改u_total低于最大占用(9): 409', g1.status === 409 && g1.body.code === 'U_TOTAL_BELOW_OCCUPIED', JSON.stringify(g1.body));
  const g2 = await api('PUT', `/api/it-assets/racks/${gRackId}`, { uid: 1, role: 'admin', body: { u_total: 9 } });
  check('G-改u_total等于最大占用: 成功', g2.status === 200 && g2.body.u_total === 9, JSON.stringify(g2.body));

  const g3 = await api('DELETE', `/api/it-assets/racks/${gRackId}`, { uid: 1, role: 'admin' });
  check('G-删非空柜: 409 RACK_NOT_EMPTY', g3.status === 409 && g3.body.code === 'RACK_NOT_EMPTY', JSON.stringify(g3.body));

  const emptyRack = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: uniq('EMPTY-RACK') } });
  const g4 = await api('DELETE', `/api/it-assets/racks/${emptyRack.body.id}`, { uid: 1, role: 'admin' });
  check('G-删空柜: 成功', g4.status === 200 && g4.body.ok === true, JSON.stringify(g4.body));

  const dupName = uniq('DUP-RACK');
  await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: dupName } });
  const g5 = await api('POST', '/api/it-assets/racks', { uid: 1, role: 'admin', body: { name: dupName } });
  check('G-机柜名重复: 409 code=LEDGER_DUPLICATE_RACK_NAME', g5.status === 409 && g5.body.code === 'LEDGER_DUPLICATE_RACK_NAME', JSON.stringify(g5.body));

  const gList = await api('GET', '/api/it-assets/racks', { uid: 3, role: 'user' });
  check('G-机柜列表可读且含occupied_count', gList.status === 200 && gList.body.items.some((r) => r.id === gRackId && typeof r.occupied_count === 'number'), JSON.stringify(gList.body.items.find((r) => r.id === gRackId)));

  // ============================================================
  // H. 楼层（引用完整性 + rooms 校验 + floor_update 事件）
  // ============================================================
  currentCaseLabel = 'H组: 楼层';
  const hFloorId = nextFloorId();
  const hFloorName = uniq('H楼层');
  const hCreate = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin', body: { name: hFloorName, rooms: [{ id: 'R1', name: '房间1', w: 50, h: 50 }] },
  });
  check('H夹具: 楼层创建成功', hCreate.status === 200, JSON.stringify(hCreate.body));

  // T-M4③（Opus 复看第8批）：floor PUT note 字段形态非法（数字）此前零覆盖，补上。
  const hNoteNum = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin', body: { name: hFloorName, rooms: [{ id: 'R1', name: '房间1', w: 50, h: 50 }], note: 123 },
  });
  check('T-M4③-floor PUT note:123: 400 field=note', hNoteNum.status === 400 && hNoteNum.body.field === 'note', JSON.stringify(hNoteNum.body));

  const hEvDetail1 = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.all("SELECT * FROM it_asset_events WHERE action='floor_update' ORDER BY id DESC LIMIT 1", [], (e, rows) => { db.close(); e ? reject(e) : resolve(rows); });
  });
  const hEv1 = hEvDetail1[0];
  check('H-floor_update事件: asset_id为NULL', hEv1 && hEv1.asset_id === null, JSON.stringify(hEv1));
  const hEv1To = JSON.parse(hEv1.to_state);
  check('H-floor_update事件: 新建from={}', JSON.parse(hEv1.from_state) && Object.keys(JSON.parse(hEv1.from_state)).length === 0);
  check('H-floor_update事件: to含四键全量快照', ['floor_id', 'name', 'sort_order', 'rooms'].every((k) => Object.prototype.hasOwnProperty.call(hEv1To, k)), JSON.stringify(hEv1To));
  // T-M2（Opus 复看第5批）：新建楼层的完整前后快照精确比较（不止是"含四键"）。
  check('H-floor_update事件(新建): to快照与请求体完全一致',
    hEv1To.floor_id === hFloorId && hEv1To.name === hFloorName && hEv1To.sort_order === 0
    && stableStringifyForTest(hEv1To.rooms) === stableStringifyForTest([{ id: 'R1', name: '房间1', w: 50, h: 50 }]),
    JSON.stringify(hEv1To));
  // T-M2（Opus 复看第8批）：不止是"含四键"，还要"恰好四键、role/related_asset_id/asset_id
  // 均符合契约、无额外键"——完整预期对象一次性精确比较。
  const hEv1ExpectedTo = { floor_id: hFloorId, name: hFloorName, sort_order: 0, rooms: [{ id: 'R1', name: '房间1', w: 50, h: 50 }] };
  check('H-floor_update事件(新建): to对象精确等于完整预期(恰四键无额外键)',
    stableStringifyForTest(hEv1To) === stableStringifyForTest(hEv1ExpectedTo), JSON.stringify({ actual: hEv1To, expected: hEv1ExpectedTo }));
  check('H-floor_update事件(新建): role=primary, related_asset_id=null, asset_id=null',
    hEv1.role === 'primary' && hEv1.related_asset_id === null && hEv1.asset_id === null, JSON.stringify(hEv1));

  const apOnH = await regAdmin({ category: 'ap', name: uniq('h-ap'), placement: { kind: 'room', floor_id: hFloorId, room_id: 'R1' } });
  check('H夹具: AP登记到房间成功', apOnH.status === 201, JSON.stringify(apOnH.body));
  const apDetailAfterReg = await api('GET', `/api/it-assets/${apOnH.body.id}`, { uid: 1, role: 'admin' });
  const apRegEvent = apDetailAfterReg.body.events.find((e) => e.action === 'register');
  check('H-登记placement=room: to_state含floor/room/pos', apRegEvent && apRegEvent.to_state.floor_id === hFloorId && apRegEvent.to_state.room_id === 'R1' && !!apRegEvent.to_state.pos, JSON.stringify(apRegEvent));

  // 新增一个未被引用的房间 R2（后续用于验证"未引用房间可整包移除"分支）。
  const hAddR2 = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin',
    body: { name: hFloorName, rooms: [{ id: 'R1', name: '房间1', w: 50, h: 50 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] },
  });
  check('H夹具: 新增未引用房间R2成功', hAddR2.status === 200, JSON.stringify(hAddR2.body));

  // ①契约纠正（coordinator 2026-09-19，以方案 §2.2b 为准）：只冻结房间 id，已有房间的
  //   name/x/y/w/h/corridor 均可在整包替换里修改——改已有房间矩形（R1）→ 200，且该楼层内 AP
  //   的 pos/version 不受影响、不写资产事件；floor_update 事件的 rooms 前后值反映长宽变化。
  const apBeforeRectChange = await api('GET', `/api/it-assets/${apOnH.body.id}`, { uid: 1, role: 'admin' });
  const apEventsCountBefore = apBeforeRectChange.body.events.length;
  const h2a = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin',
    body: { name: hFloorName, rooms: [{ id: 'R1', name: '房间1', w: 30, h: 30 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] },
  });
  check('H①-改已有房间矩形: 200', h2a.status === 200, JSON.stringify(h2a.body));
  const apAfterRectChange = await api('GET', `/api/it-assets/${apOnH.body.id}`, { uid: 1, role: 'admin' });
  check('H①-改矩形不改AP的pos',
    JSON.stringify(apAfterRectChange.body.asset.pos) === JSON.stringify(apBeforeRectChange.body.asset.pos),
    JSON.stringify([apBeforeRectChange.body.asset.pos, apAfterRectChange.body.asset.pos]));
  check('H①-改矩形不改AP的version',
    apAfterRectChange.body.asset.version === apBeforeRectChange.body.asset.version,
    `${apBeforeRectChange.body.asset.version} -> ${apAfterRectChange.body.asset.version}`);
  check('H①-改矩形不写资产事件',
    apAfterRectChange.body.events.length === apEventsCountBefore,
    `before=${apEventsCountBefore} after=${apAfterRectChange.body.events.length}`);
  const floorEvAfterRect = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.all("SELECT * FROM it_asset_events WHERE action='floor_update' ORDER BY id DESC LIMIT 1", [], (e, rows) => { db.close(); e ? reject(e) : resolve(rows); });
  });
  const rectEvFrom = JSON.parse(floorEvAfterRect[0].from_state);
  const rectEvTo = JSON.parse(floorEvAfterRect[0].to_state);
  const rectEvFromR1 = rectEvFrom.rooms.find((r) => r.id === 'R1');
  const rectEvToR1 = rectEvTo.rooms.find((r) => r.id === 'R1');
  check('H①-floor_update事件rooms前后值反映长宽变化',
    !!rectEvFromR1 && !!rectEvToR1 && rectEvFromR1.w === 50 && rectEvFromR1.h === 50 && rectEvToR1.w === 30 && rectEvToR1.h === 30,
    JSON.stringify({ from: rectEvFromR1, to: rectEvToR1 }));
  // T-M2（Opus 复看第8批）：修改（矩形变更）事件的完整预期 from/to 四键对象精确比较——不止
  // 挑 R1 一个子对象看局部字段，rooms 完整数组（含 R2 保持不变）都要对上，且恰好四键。
  const hRectExpectedFrom = { floor_id: hFloorId, name: hFloorName, sort_order: 0, rooms: [{ id: 'R1', name: '房间1', w: 50, h: 50 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] };
  const hRectExpectedTo = { floor_id: hFloorId, name: hFloorName, sort_order: 0, rooms: [{ id: 'R1', name: '房间1', w: 30, h: 30 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] };
  check('H①-floor_update事件(修改): from对象精确等于完整预期(恰四键含R2不变)',
    stableStringifyForTest(rectEvFrom) === stableStringifyForTest(hRectExpectedFrom), JSON.stringify({ actual: rectEvFrom, expected: hRectExpectedFrom }));
  check('H①-floor_update事件(修改): to对象精确等于完整预期(恰四键含R2不变)',
    stableStringifyForTest(rectEvTo) === stableStringifyForTest(hRectExpectedTo), JSON.stringify({ actual: rectEvTo, expected: hRectExpectedTo }));
  check('H①-floor_update事件(修改): role=primary, related_asset_id=null, asset_id=null',
    floorEvAfterRect[0].role === 'primary' && floorEvAfterRect[0].related_asset_id === null && floorEvAfterRect[0].asset_id === null,
    JSON.stringify(floorEvAfterRect[0]));

  // ②改已有房间 name → 200
  const h2b = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin',
    body: { name: hFloorName, rooms: [{ id: 'R1', name: '改名后的房间1', w: 30, h: 30 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] },
  });
  check('H②-改已有房间name: 200',
    h2b.status === 200 && h2b.body.rooms.find((r) => r.id === 'R1').name === '改名后的房间1',
    JSON.stringify(h2b.body));

  // ③"改 id"这个动作在数据形态上就是"删旧建新"：旧 id 若仍被引用 → 409 ROOM_IN_USE（这就是
  //   方案"改已有房间 id 409"用例的真实语义）；未被引用则允许移除。
  const h1 = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin', body: { name: hFloorName, rooms: [{ id: 'R2', name: '房间2', w: 20, h: 20 }] },
  });
  check('H③-移除被引用房间(R1): 409 ROOM_IN_USE',
    h1.status === 409 && h1.body.code === 'ROOM_IN_USE'
      && h1.body.detail && Array.isArray(h1.body.detail.rooms) && Array.isArray(h1.body.detail.assets),
    JSON.stringify(h1.body));
  // T-M1（Opus 复看第5批）：detail 内容断言到具体值，不止是"是数组"。
  check('H③-ROOM_IN_USE detail.rooms含R1', h1.body.detail.rooms.includes('R1'), JSON.stringify(h1.body.detail));
  check('H③-ROOM_IN_USE detail.assets含apOnH.id', h1.body.detail.assets.includes(apOnH.body.id), JSON.stringify(h1.body.detail));

  // T-M1：把 R1"改成"新 id（其余字段原样保留）——数据形态上等价于"删除 R1、新建一个不叫 R1
  // 的房间"，R1 仍被引用 → 409；回查原房间数组与 AP 的引用必须原封不动（失败请求不能有任何
  // 副作用）。
  const h1FloorBefore = await api('GET', '/api/it-assets/floors', { uid: 1, role: 'admin' });
  const h1FloorRowBefore = h1FloorBefore.body.items.find((f) => f.id === hFloorId);
  const h1RenameId = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin',
    body: { name: hFloorName, rooms: [{ id: 'R1-RENAMED', name: '房间1', w: 50, h: 50 }, { id: 'R2', name: '房间2', w: 20, h: 20 }] },
  });
  check('H③-把R1改成新id(其余保留): 409 ROOM_IN_USE', h1RenameId.status === 409 && h1RenameId.body.code === 'ROOM_IN_USE', JSON.stringify(h1RenameId.body));
  const h1FloorAfter = await api('GET', '/api/it-assets/floors', { uid: 1, role: 'admin' });
  const h1FloorRow = h1FloorAfter.body.items.find((f) => f.id === hFloorId);
  // T-rec M1（Opus 复看第8批）：不再只挑"含R1/不含R1-RENAMED"两个断言点，改成完整 rooms
  // 数组的精确比较（stableStringifyForTest，键序无关但值必须逐一对上）——防止"顺带改了 R2
  // 或漏了某个字段"这类只看局部断言点测不出来的副作用。
  check('H③-把R1改成新id失败后: 楼层rooms完整数组精确不变',
    !!h1FloorRow && stableStringifyForTest(h1FloorRow.rooms) === stableStringifyForTest(h1FloorRowBefore.rooms),
    JSON.stringify({ before: h1FloorRowBefore.rooms, after: h1FloorRow && h1FloorRow.rooms }));
  const apAfterRenameAttempt = await api('GET', `/api/it-assets/${apOnH.body.id}`, { uid: 1, role: 'admin' });
  check('H③-把R1改成新id失败后: AP的floor_id/room_id引用不变',
    apAfterRenameAttempt.body.asset.floor_id === hFloorId && apAfterRenameAttempt.body.asset.room_id === 'R1',
    JSON.stringify(apAfterRenameAttempt.body.asset));

  const h2c = await api('PUT', `/api/it-assets/floors/${hFloorId}`, {
    uid: 1, role: 'admin',
    body: { name: hFloorName, rooms: [{ id: 'R1', name: '改名后的房间1', w: 30, h: 30 }] },
  });
  check('H③-移除未引用房间(R2): 200', h2c.status === 200 && h2c.body.rooms.length === 1, JSON.stringify(h2c.body));

  const hFloorEmpty = nextFloorId();
  await api('PUT', `/api/it-assets/floors/${hFloorEmpty}`, { uid: 1, role: 'admin', body: { name: uniq('空楼层'), rooms: [{ id: 'X1', name: 'x', w: 10, h: 10 }] } });
  const h3 = await api('DELETE', `/api/it-assets/floors/${hFloorEmpty}`, { uid: 1, role: 'admin' });
  // S-M7（Opus 预筛）：删楼层时"rooms 非空"本身不是"被引用"，新码 FLOOR_NOT_EMPTY。
  check('H-删楼层含房间: 409 FLOOR_NOT_EMPTY', h3.status === 409 && h3.body.code === 'FLOOR_NOT_EMPTY' && Array.isArray(h3.body.detail && h3.body.detail.rooms), JSON.stringify(h3.body));
  const hFloorEmptyName2 = uniq('空楼层2');
  await api('PUT', `/api/it-assets/floors/${hFloorEmpty}`, { uid: 1, role: 'admin', body: { name: hFloorEmptyName2, rooms: [] } });
  const h3b = await api('DELETE', `/api/it-assets/floors/${hFloorEmpty}`, { uid: 1, role: 'admin' });
  check('H-删空房间楼层: 成功', h3b.status === 200 && h3b.body.ok === true, JSON.stringify(h3b.body));
  const hDelEv = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(TEST_DB);
    db.all("SELECT * FROM it_asset_events WHERE action='floor_update' ORDER BY id DESC LIMIT 1", [], (e, rows) => { db.close(); e ? reject(e) : resolve(rows); });
  });
  check('H-删楼层事件: to={}', hDelEv[0] && JSON.parse(hDelEv[0].to_state) && Object.keys(JSON.parse(hDelEv[0].to_state)).length === 0, JSON.stringify(hDelEv[0]));
  // T-M2（Opus 复看第5批）：删除事件的 from_state 是完整的删除前快照，精确比较（不止是校验
  // to={}）。
  const hDelEvFrom = hDelEv[0] && JSON.parse(hDelEv[0].from_state);
  check('H-删楼层事件: from_state为删除前完整快照',
    !!hDelEvFrom && hDelEvFrom.floor_id === hFloorEmpty && hDelEvFrom.name === hFloorEmptyName2
    && hDelEvFrom.sort_order === 0 && stableStringifyForTest(hDelEvFrom.rooms) === stableStringifyForTest([]),
    JSON.stringify(hDelEvFrom));
  // T-M2（Opus 复看第8批）：删除事件完整预期 from/to 四键对象精确比较 + role/asset_id 契约。
  const hDelExpectedFrom = { floor_id: hFloorEmpty, name: hFloorEmptyName2, sort_order: 0, rooms: [] };
  check('H-删楼层事件: from对象精确等于完整预期(恰四键)',
    stableStringifyForTest(hDelEvFrom) === stableStringifyForTest(hDelExpectedFrom), JSON.stringify({ actual: hDelEvFrom, expected: hDelExpectedFrom }));
  check('H-删楼层事件: to对象精确为{}(零键)', Object.keys(JSON.parse(hDelEv[0].to_state)).length === 0, hDelEv[0].to_state);
  check('H-删楼层事件: role=primary, related_asset_id=null, asset_id=null',
    hDelEv[0].role === 'primary' && hDelEv[0].related_asset_id === null && hDelEv[0].asset_id === null, JSON.stringify(hDelEv[0]));

  const roomBadCases = [
    ['未知键', [{ id: 'B1', name: 'x', w: 10, h: 10, foo: 1 }]],
    ['id重复', [{ id: 'B1', name: 'x', w: 10, h: 10 }, { id: 'B1', name: 'y', w: 10, h: 10 }]],
    ['w=0', [{ id: 'B1', name: 'x', w: 0, h: 10 }]],
    ['w超过500', [{ id: 'B1', name: 'x', w: 500.1, h: 10 }]],
    ['负数h', [{ id: 'B1', name: 'x', w: 10, h: -1 }]],
    ['旧房间x键', [{ id: 'B1', name: 'x', x: 0, w: 10, h: 10 }]],
    ['旧房间y键', [{ id: 'B1', name: 'x', y: 0, w: 10, h: 10 }]],
    ['h超过500', [{ id: 'B1', name: 'x', w: 10, h: 501 }]],
    ['非数值w', [{ id: 'B1', name: 'x', w: '12.5', h: 10 }]],
  ];
  for (const [label, rooms] of roomBadCases) {
    const rFloorId = nextFloorId();
    const r = await api('PUT', `/api/it-assets/floors/${rFloorId}`, { uid: 1, role: 'admin', body: { name: uniq('rb-' + label), rooms } });
    // T-M7：补 field 断言——field 必须指向 rooms 数组内的具体元素/子键，不能只是笼统 400。
    check(`H-rooms非法(${label}): 400 field指向rooms`,
      r.status === 400 && r.body.code === 'LEDGER_BAD_REQUEST' && typeof r.body.field === 'string' && r.body.field.startsWith('rooms'), JSON.stringify(r.body));
  }

  const meterFloorId = nextFloorId();
  const meterRooms = [{id:'meters',name:'米数边界',w:12.5,h:500,corridor:true}];
  const meterResult = await api('PUT', `/api/it-assets/floors/${meterFloorId}`, {uid:1,role:'admin',body:{name:uniq('meters'),rooms:meterRooms}});
  check('H-rooms米数小数与500上限接受', meterResult.status === 200, JSON.stringify(meterResult.body));

  const roomNotInFloor = await regAdmin({ category: 'ap', name: uniq('ap-badroom'), placement: { kind: 'room', floor_id: hFloorId, room_id: 'NOT_EXIST' } });
  check('H-房间不属于该楼层: 400 field=room_id', roomNotInFloor.status === 400 && roomNotInFloor.body.field === 'room_id', JSON.stringify(roomNotInFloor.body));
  const posOutOfRange = await regAdmin({ category: 'ap', name: uniq('ap-badpos'), placement: { kind: 'room', floor_id: hFloorId, room_id: 'R1', pos: { x: 1.5, y: 0.5 } } });
  check('H-pos越界: 400 field=placement.pos', posOutOfRange.status === 400 && posOutOfRange.body.field === 'placement.pos', JSON.stringify(posOutOfRange.body));

  // ============================================================
  // I. assertWrite 生产接线
  // ============================================================
  currentCaseLabel = 'I组: assertWrite生产接线';
  const i1 = await api('POST', '/api/it-assets', { uid: 2, role: 'user', body: { category: 'other', name: uniq('i1'), u_height: 0, placement: { kind: 'place', location_text: 'x' } } });
  check('I-ACL write用户登记成功', i1.status === 201, JSON.stringify(i1.body));
  const i2 = await api('POST', '/api/it-assets', { uid: 3, role: 'user', body: { category: 'other', name: uniq('i2'), u_height: 0, placement: { kind: 'place', location_text: 'x' } } });
  check('I-ACL read用户登记: 403', i2.status === 403, JSON.stringify(i2.body));

  // 排队期撤权：先让"撤销"占住 mutex 并卡在 txnMidGate，登记请求排队等待，撤销放行提交后
  // 登记才轮到，此时 assertWrite 在同一事务内重读 ACL，应看到已撤销状态 → 403。
  await api('PUT', '/api/it-assets/acl/10', { uid: 1, role: 'admin', body: { level: 'write' } });
  const arrived = itLedgerModule._internals.setTxnMidGate(new Promise((resolve) => { itLedgerModule.__resolveGate = resolve; }));
  let revokeSettled = false;
  const revokeP = api('DELETE', '/api/it-assets/acl/10', { uid: 1, role: 'admin' }).then((r) => { revokeSettled = true; return r; });
  await awaitArrived(arrived, 'I-排队期撤权到达txnMidGate', revokeP);
  const registerP = api('POST', '/api/it-assets', { uid: 10, role: 'user', body: { category: 'other', name: uniq('i3'), u_height: 0, placement: { kind: 'place', location_text: 'x' } } });
  await schedulingBarrier();
  const queuedOk = await waitForCondition(() => itTxnMutex._internals.waiterCount() >= 1, 'I-排队期撤权等待登记请求排队', 3000);
  check('I-排队期撤权: 登记请求已排入等待队列', queuedOk === true, `waiterCount=${itTxnMutex._internals.waiterCount()}`);
  // T-M3（Opus 复看第5批）：释放门闩前同时确认"撤权请求确实还没落定"（还卡在闸上，业务逻辑
  // 没跑完）——否则前面的 awaitArrived 只证明了"到达过闸"，不能排除闸后瞬间又自己跑完的可能，
  // 那样下面"登记请求排队"这个时序推论就不成立了。
  check('I-释放门闩前: 撤销请求仍未落定(还卡在txnMidGate)', revokeSettled === false, `revokeSettled=${revokeSettled}`);
  itLedgerModule.__resolveGate();
  itLedgerModule._internals.setTxnMidGate(null);
  const revokeResult = await withTimeout(revokeP, 5000, 'I-撤销请求落定');
  check('I-撤销请求成功', revokeResult.status === 200, JSON.stringify(revokeResult.body));
  const registerResult = await withTimeout(registerP, 5000, 'I-登记请求落定');
  check('I-排队期撤权: 登记请求403(权限已在其BEGIN前失效)', registerResult.status === 403 && registerResult.body.code === 'LEDGER_FORBIDDEN', JSON.stringify(registerResult.body));

  // ============================================================
  // J. 不变量变异（活体，静态变异 invariants.js 源码）
  // ============================================================
  currentCaseLabel = 'J组: 不变量活体变异';
  // T-M8（Opus 预筛）：变异体源文件落到 scratchpad 目录（不再用 os.tmpdir()），且 require 失败
  //   单独归类为"变异体加载失败"（结构化错误对象），不与"规则判红"混在一条 check 里——加载失败
  //   是脚本自身的工具性故障，和"目标规则是否真的独占拦截了反例"是两件事，混在一起会让"变异体
  //   加载出问题"被误读成"规则失效判红"，掩盖排查方向。
  // T-M6（Opus 复看第5批）：scratchpad 根目录可配置（env IT_VERIFY_SCRATCH 优先，否则回退
  // os.tmpdir()，不再写死本次会话的临时目录路径——脚本本身应当能在任何环境下独立运行）；本次
  // 运行独占一个子目录（含时间戳+pid，避免和其它并发跑的 verify 进程互相踩文件），显式 mkdir。
  const SCRATCH_ROOT = process.env.IT_VERIFY_SCRATCH || os.tmpdir();
  const MUTANT_DIR = path.join(SCRATCH_ROOT, `it-ledger-write-mutants-${Date.now()}-${process.pid}`);
  fs.mkdirSync(MUTANT_DIR, { recursive: true });
  currentMutantDir = MUTANT_DIR; // 桥接给顶层 fatalExit，见该函数上方注释。
  const mutantFilesWritten = [];
  function mutateInvariants(ruleName) {
    const srcPath = path.join(__dirname, '..', 'routes', 'it-ledger', 'invariants.js');
    let src;
    try {
      src = fs.readFileSync(srcPath, 'utf8');
    } catch (e) {
      return { ok: false, stage: 'read', error: e };
    }
    const re = new RegExp(`\\{ name: '${ruleName}', fn: (\\w+) \\}`);
    if (!re.test(src)) return { ok: false, stage: 'locate', error: new Error(`未找到规则声明: ${ruleName}`) };
    const mutated = src.replace(re, `{ name: '${ruleName}', fn: () => null }`);
    const tmpPath = path.join(MUTANT_DIR, `it-ledger-invariants-mutant-${ruleName}-${Date.now()}-${seq += 1}.js`);
    // T-M6：写入失败与加载(require)失败分开两个 try，stage 字段各自精确标注——写入失败是磁盘/
    // 权限问题，加载失败是"变异后的代码本身语法/运行时错误"，混在一个 try 里会互相掩盖。
    try {
      fs.writeFileSync(tmpPath, mutated, 'utf8');
      mutantFilesWritten.push(tmpPath);
    } catch (e) {
      return { ok: false, stage: 'write', error: e, tmpPath };
    }
    try {
      const mod = require(tmpPath);
      return { ok: true, mod, tmpPath };
    } catch (e) {
      return { ok: false, stage: 'require', error: e, tmpPath };
    }
  }
  // T-M6：finally 统一清理——文件本体 + require 缓存都要清，不管本次调用成功与否（缓存残留会
  // 让"同一路径下次被复用"这种理论场景读到旧模块，虽然本次每条 tmpPath 都带时间戳+序号不会真
  // 复用，但显式清干净不留隐患）。
  function cleanupMutantFile(tmpPath) {
    if (!tmpPath) return;
    try { delete require.cache[tmpPath]; } catch (e) { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch (e) { /* Windows 下偶发句柄占用，忽略——目录级清理兜底 */ }
  }

  const mutationCases = [
    {
      // coordinator 2026-09-19 补齐：AP 在位但 floor_id/room_id/pos 全空——rule1
      // （CATEGORY_FIELD_MATRIX）对该行不判违反（floor 族允许为空，不要求非空），
      // 只有 rule2（AP_LOCATION_FAMILY）会拦。
      rule: 'AP_LOCATION_FAMILY', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'ap', status: 'in_service', u_height: 0, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: {},
    },
    {
      // coordinator 2026-09-19 补齐：server 在位但 rack_id/u_start 全空——rule1 对该行不判违反
      // （rack 族允许为空），只有 rule3（RACK_INTERVAL）会拦。
      rule: 'RACK_INTERVAL', code: 'LEDGER_BAD_REQUEST',
      // ctx.childDisks 显式传空数组：mutant 化后该行还要过 rule6（SLOT_COUNT_FLOOR，hostEligible
      // 恒要求 ctx.childDisks），否则会撞 ctx 缺失 500 而不是"mutatedViolation===null"。
      row: fullRow({ category: 'server', status: 'in_service', u_height: 2, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [] },
    },
    {
      // coordinator 2026-09-19 补齐：宿主 slot_count(1) 低于已占用子盘最大 slot_no(5)——status
      // 用 in_depot（rack 字段恒空，rule3 天然不判违反），只有 rule6（SLOT_COUNT_FLOOR）会拦。
      rule: 'SLOT_COUNT_FLOOR', code: 'SLOT_COUNT_BELOW_OCCUPIED',
      // childDisks 元素须带 status（HOST_DISK_STATUS_SYNC 恒要求），取与宿主 row.status 相同
      // 的值，确保该规则不被 HOST_DISK_STATUS_SYNC 先一步拦下，SLOT_COUNT_FLOOR 才是独占者。
      row: fullRow({ category: 'server', status: 'in_depot', u_height: 2, slot_count: 1, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [{ slot_no: 5, status: 'in_depot' }] },
    },
    {
      // S-H1（Opus 复看第5批）新增规则：宿主行自身视角——子盘 status 与宿主 status 不一致。
      rule: 'HOST_DISK_STATUS_SYNC', code: 'HOST_DISK_STATUS_SYNC',
      row: fullRow({ category: 'server', status: 'in_depot', u_height: 2, slot_count: 2, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [{ slot_no: 1, status: 'faulty' }] },
    },
    {
      // S-M1（Opus 复看第5批）新增规则：数值域——u_height 非安全整数（此处用 1.5 制造非整数）。
      rule: 'NUMERIC_DOMAIN', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'other', status: 'in_depot', u_height: 1.5, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [] },
    },
    {
      rule: 'CATEGORY_FIELD_MATRIX', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'disk', status: 'in_depot', u_height: 0, slot_count: 0, u_start: null, rack_id: 5, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: {},
    },
    {
      rule: 'CUSTODIAN_CONDITIONAL', code: 'CUSTODIAN_REQUIRED',
      row: fullRow({ category: 'laptop', status: 'in_service', u_height: 0, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: {},
    },
    {
      rule: 'STATUS_DOMAIN', code: 'LEDGER_BAD_REQUEST',
      // ctx.childDisks 必须显式传（S-H1 后 SLOT_COUNT_FLOOR 对 hostEligible 行恒要求它），
      // 否则会先撞 ctx 缺失的 fail-closed 500，掩盖本条要测的 STATUS_DOMAIN 违反。
      row: fullRow({ category: 'server', status: 'active', u_height: 2, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [] },
    },
    {
      rule: 'EXPIRES_REQUIRED', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'subscription', status: 'active', u_height: 0, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: {},
    },
    {
      rule: 'U_HEIGHT_DOMAIN', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'server', status: 'in_depot', u_height: 0, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: null, slot_no: null, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { childDisks: [] },
    },
    {
      rule: 'HOST_SLOT', code: 'LEDGER_BAD_REQUEST',
      row: fullRow({ category: 'disk', status: 'in_depot', u_height: 0, slot_count: 0, u_start: null, rack_id: null, location_text: null, floor_id: null, room_id: null, pos: null, parent_asset_id: 9, slot_no: 999, custodian_user_id: null, custodian_name: null, expires_at: null }),
      ctx: { parent: { slot_count: 2, status: 'in_depot', category: 'server' } },
    },
  ];

  // T-M5（Opus 复看第5批）：mutationCases 覆盖的规则名集合必须恰等于 invariants.js 的 RULES
  // 名字集合（无遗漏、无重复），否则新增规则时容易漏配变异用例还不自知。
  const mutationRuleNames = mutationCases.map((c) => c.rule);
  const RULES_NAMES = itLedgerModule._internals.invariants.RULES.map((r) => r.name);
  const mutationRuleNameSet = new Set(mutationRuleNames);
  const rulesNameSet = new Set(RULES_NAMES);
  check('J-mutationCases规则名无重复', mutationRuleNames.length === mutationRuleNameSet.size,
    `共${mutationRuleNames.length}条，去重后${mutationRuleNameSet.size}条`);
  const missingFromMutation = RULES_NAMES.filter((n) => !mutationRuleNameSet.has(n));
  const extraInMutation = mutationRuleNames.filter((n) => !rulesNameSet.has(n));
  check('J-mutationCases规则名集合恰等于RULES名字集合(无遗漏无多余)',
    missingFromMutation.length === 0 && extraInMutation.length === 0,
    `缺失: ${missingFromMutation.join(',') || '(无)'}；多余: ${extraInMutation.join(',') || '(无)'}`);

  for (const c of mutationCases) {
    const originalViolation = itLedgerModule._internals.invariants.validateAssetInvariants(c.row, c.ctx);
    // T-M5：原始反例除了"确实是该规则拦的"，还要求 status ∈ {400,409} 与预期 code 精确匹配——
    // 不止是"有违反"这么弱的断言。
    check(`J-规则${c.rule}(原始): 反例恰被该规则拦截(独占，非更早规则先拦)且status∈{400,409}且code匹配`,
      !!originalViolation && originalViolation.rule === c.rule
      && [400, 409].includes(originalViolation.status) && originalViolation.code === c.code,
      JSON.stringify(originalViolation));
    // R-L1（codex 22-R）：原始反例的 code 必须真的 ∈ WRITE_ERROR_CODES 闭集（不是只信任
    // c.code 硬编码值本身没写错——两者都要对得上）；同时手工记进 observedCodes（J 组走纯函数
    // 直调，不经 api()，不会被自动记录）。
    if (originalViolation) {
      check(`J-规则${c.rule}(原始): violation.code∈WRITE_ERROR_CODES闭集`,
        itLedgerModule._internals.WRITE_ERROR_CODES.has(originalViolation.code), originalViolation.code);
      observedCodes.add(originalViolation.code);
    }
    const mutantResult = mutateInvariants(c.rule);
    if (!mutantResult.ok) {
      // T-M8：加载失败单列标签，不与"判红"混淆——这是脚本工具性故障，不是规则本身的问题。
      check(`J-规则${c.rule}(变异体${mutantResult.stage}失败，非判红): 未能构造变异体`, false,
        `stage=${mutantResult.stage} error=${mutantResult.error && mutantResult.error.message}`);
      cleanupMutantFile(mutantResult.tmpPath);
      continue;
    }
    // T-M3（Opus 复看第8批）：每个变异体的使用都套 try/finally——validateAssetInvariants 本身
    // 理论上不该抛异常，但如果变异后的代码本身语法/运行时有意外问题导致抛错，finally 仍要
    // 保证清理跑到，不能让一次意外异常导致后续所有变异体文件残留在 MUTANT_DIR 里。
    try {
      const mutatedViolation = mutantResult.mod.validateAssetInvariants(c.row, c.ctx);
      // T-H1（Opus 预筛）：判据收紧为"变异后必须完全放行(null)"，不再接受"换成另一条规则拦"
      // 这种弱判据（那种情况只证明反例不独占，测不出目标规则本身是否失效）。
      check(`J-规则${c.rule}(变异后): 该反例完全放行(mutatedViolation===null)`, mutatedViolation === null, JSON.stringify(mutatedViolation));
    } finally {
      cleanupMutantFile(mutantResult.tmpPath);
    }
  }
  // T-M6：本次运行独占的变异体子目录整体清理（兜底——单个文件清理理论上已经覆盖，这里再删
  // 一次目录本身，避免长期堆积空目录）。
  try { fs.rmSync(MUTANT_DIR, { recursive: true, force: true }); } catch (e) { /* 尽力而为，不影响主流程 */ }

  // ============================================================
  // K. attrs 冻结键集合（§2.7，每类别一条合法一条多余键）
  // ============================================================
  currentCaseLabel = 'K组: attrs冻结键集合';
  const attrsCases = [
    ['server', { ip: '10.0.0.1' }, { ip: '10.0.0.1', bad: 1 }, { placement: { kind: 'depot' }, u_height: 2 }],
    ['disk', { capacity: '1T' }, { capacity: '1T', bad: 1 }, {}],
    ['laptop', { cpu: 'i7' }, { cpu: 'i7', bad: 1 }, { placement: { kind: 'custodian', custodian_name: 'x' } }],
    ['desktop', { ram: '16G' }, { ram: '16G', bad: 1 }, { placement: { kind: 'custodian', custodian_name: 'x' } }],
    ['ap', { ssid_group: 'g1' }, { ssid_group: 'g1', bad: 1 }, { placement: { kind: 'room', floor_id: floorId, room_id: 'R1' } }],
    ['other', { subtype: 'x' }, { subtype: 'x', bad: 1 }, { u_height: 0, placement: { kind: 'place', location_text: 'x' } }],
    ['software', { version: '1.0' }, { version: '1.0', bad: 1 }, {}],
    ['subscription', { cycle: 'year' }, { cycle: 'year', bad: 1 }, { expires_at: '2027-01-01' }],
  ];
  for (const [category, goodAttrs, badAttrs, extra] of attrsCases) {
    const good = await regAdmin(Object.assign({ category, name: uniq(`k-${category}-good`), attrs: goodAttrs }, extra));
    check(`K-attrs合法(${category}): 登记成功`, good.status === 201, JSON.stringify(good.body));
    const bad = await regAdmin(Object.assign({ category, name: uniq(`k-${category}-bad`), attrs: badAttrs }, extra));
    check(`K-attrs多余键(${category}): 400`, bad.status === 400 && bad.body.field === 'attrs', JSON.stringify(bad.body));
  }

  // 补齐缺口①（coordinator 2026-09-19）：S-M3 stableStringify 的专项正向证明——attrs 仅换键
  // 顺序（值完全一样）不应被判定为"改动"；紧接着真的改一个值才应该判定为改动。
  currentCaseLabel = 'K补: attrs仅换键顺序不算改动(S-M3 stableStringify)';
  const kOrderAsset = await regAdmin({
    category: 'server', name: uniq('k-order'), u_height: 2, placement: { kind: 'depot' },
    attrs: { ip: '10.0.0.1', purpose: 'web' },
  });
  check('K补-登记带attrs{ip,purpose}成功', kOrderAsset.status === 201, JSON.stringify(kOrderAsset.body));
  const kOrderId = kOrderAsset.body.id;
  const kOrderBefore = await api('GET', `/api/it-assets/${kOrderId}`, { uid: 1, role: 'admin' });
  const kOrderReorder = await editAdmin(kOrderId, { expected_version: kOrderBefore.body.asset.version, attrs: { purpose: 'web', ip: '10.0.0.1' } });
  check('K补-仅换键顺序PUT: 200', kOrderReorder.status === 200, JSON.stringify(kOrderReorder.body));
  check('K补-仅换键顺序: version不变', kOrderReorder.body.version === kOrderBefore.body.asset.version,
    `before=${kOrderBefore.body.asset.version} after=${kOrderReorder.body.version}`);
  const kOrderAfterReorder = await api('GET', `/api/it-assets/${kOrderId}`, { uid: 1, role: 'admin' });
  check('K补-仅换键顺序: 事件数不变(未写update事件)', kOrderAfterReorder.body.events.length === kOrderBefore.body.events.length,
    `before=${kOrderBefore.body.events.length} after=${kOrderAfterReorder.body.events.length}`);

  const kOrderRealChange = await editAdmin(kOrderId, { expected_version: kOrderReorder.body.version, attrs: { purpose: 'web-updated', ip: '10.0.0.1' } });
  check('K补-真改一个值PUT: 200', kOrderRealChange.status === 200, JSON.stringify(kOrderRealChange.body));
  check('K补-真改一个值: version+1', kOrderRealChange.body.version === kOrderReorder.body.version + 1,
    `before=${kOrderReorder.body.version} after=${kOrderRealChange.body.version}`);
  const kOrderAfterRealChange = await api('GET', `/api/it-assets/${kOrderId}`, { uid: 1, role: 'admin' });
  const kOrderEvent = kOrderAfterRealChange.body.events.filter((ev) => ev.action === 'update').pop();
  check('K补-真改一个值: 新增update事件且from/to只含attrs键',
    !!kOrderEvent && JSON.stringify(Object.keys(kOrderEvent.from_state)) === JSON.stringify(['attrs'])
    && JSON.stringify(Object.keys(kOrderEvent.to_state)) === JSON.stringify(['attrs']),
    JSON.stringify(kOrderEvent));
  check('K补-真改一个值: to_state.attrs为新值', !!kOrderEvent && kOrderEvent.to_state.attrs.purpose === 'web-updated' && kOrderEvent.to_state.attrs.ip === '10.0.0.1', JSON.stringify(kOrderEvent && kOrderEvent.to_state));
  check('K补-真改一个值: from_state.attrs为旧值', !!kOrderEvent && kOrderEvent.from_state.attrs.purpose === 'web' && kOrderEvent.from_state.attrs.ip === '10.0.0.1', JSON.stringify(kOrderEvent && kOrderEvent.from_state));

  // 补齐缺口②（coordinator 2026-09-19）：S-M5 parse 失败 500 的专项正向证明——直接用 rawRun
  // 往库里插/改畸形 JSON（应用层永远不会自己产出的数据），验证读路径 fail-closed，用完立即清理
  // 这两行，不让损坏数据遗留影响后续用例。
  currentCaseLabel = 'K补: 坏JSON读路径fail-closed(S-M5)';
  const kBadEventAsset = await regAdmin({ category: 'other', name: uniq('k-badevent'), u_height: 0, placement: { kind: 'place', location_text: 'x' } });
  check('K补-坏事件夹具: 登记成功', kBadEventAsset.status === 201, JSON.stringify(kBadEventAsset.body));
  const kBadEventAssetId = kBadEventAsset.body.id;
  const kBadEventInsert = await rawRun(
    `INSERT INTO it_asset_events (op_id, asset_id, action, role, related_asset_id, from_state, to_state, operator_id, note, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now','localtime'))`,
    [uniq('bad-op'), kBadEventAssetId, 'update', 'primary', null, '{bad', '{}', 1, null]
  );
  const kBadEventRowId = kBadEventInsert.lastID;
  const kBadEventGet = await api('GET', `/api/it-assets/${kBadEventAssetId}`, { uid: 1, role: 'admin' });
  expectCode(kBadEventGet, 'LEDGER_INTERNAL', 'K补-坏事件行GET详情: code=LEDGER_INTERNAL');
  check('K补-坏事件行GET详情: 状态码500', kBadEventGet.status === 500, JSON.stringify(kBadEventGet.body));
  check('K补-坏事件行GET详情: 响应体不含损坏原文{bad', !JSON.stringify(kBadEventGet.body).includes('{bad'), JSON.stringify(kBadEventGet.body));
  // 清理：删掉这一行坏事件，恢复该资产可正常读取。
  await rawRun('DELETE FROM it_asset_events WHERE id = ?', [kBadEventRowId]);
  const kBadEventGetAfterCleanup = await api('GET', `/api/it-assets/${kBadEventAssetId}`, { uid: 1, role: 'admin' });
  check('K补-坏事件行清理后: GET详情恢复200', kBadEventGetAfterCleanup.status === 200, JSON.stringify(kBadEventGetAfterCleanup.body));

  const kBadAttrsAsset = await regAdmin({ category: 'other', name: uniq('k-badattrs'), u_height: 0, placement: { kind: 'place', location_text: 'x' } });
  check('K补-坏attrs夹具: 登记成功', kBadAttrsAsset.status === 201, JSON.stringify(kBadAttrsAsset.body));
  const kBadAttrsAssetId = kBadAttrsAsset.body.id;
  await rawRun('UPDATE it_assets SET attrs = ? WHERE id = ?', ['{bad', kBadAttrsAssetId]);
  const kBadAttrsGetDetail = await api('GET', `/api/it-assets/${kBadAttrsAssetId}`, { uid: 1, role: 'admin' });
  expectCode(kBadAttrsGetDetail, 'LEDGER_INTERNAL', 'K补-坏attrs行GET详情: code=LEDGER_INTERNAL');
  check('K补-坏attrs行GET详情: 状态码500', kBadAttrsGetDetail.status === 500, JSON.stringify(kBadAttrsGetDetail.body));
  const kBadAttrsGetList = await api('GET', '/api/it-assets?category=other', { uid: 1, role: 'admin' });
  expectCode(kBadAttrsGetList, 'LEDGER_INTERNAL', 'K补-坏attrs行GET列表: code=LEDGER_INTERNAL');
  check('K补-坏attrs行GET列表: 状态码500', kBadAttrsGetList.status === 500, JSON.stringify(kBadAttrsGetList.body));
  // 清理：把这一行的 attrs 恢复成合法空对象，不让损坏数据遗留影响后面任何一条按 category=other
  // 扫描的用例。
  await rawRun("UPDATE it_assets SET attrs = '{}' WHERE id = ?", [kBadAttrsAssetId]);
  const kBadAttrsGetAfterCleanup = await api('GET', `/api/it-assets/${kBadAttrsAssetId}`, { uid: 1, role: 'admin' });
  check('K补-坏attrs行清理后: GET详情恢复200', kBadAttrsGetAfterCleanup.status === 200, JSON.stringify(kBadAttrsGetAfterCleanup.body));

  // R-M4（codex 22-R）：双重编码 JSON——attrs 列存的是一个"被 JSON.stringify 了两次"的字符串
  // （第一次 parse 能成功，但产出的是一个字符串而不是对象），这种畸形数据 JSON.parse 本身不
  // 报错，必须靠形状校验（isPlainObjectShape）拦下，否则会把一个字符串当 attrs 对象往下传。
  const kDoubleEncodedAsset = await regAdmin({ category: 'other', name: uniq('k-doubleenc'), u_height: 0, placement: { kind: 'place', location_text: 'x' } });
  check('K补-双重编码JSON夹具: 登记成功', kDoubleEncodedAsset.status === 201, JSON.stringify(kDoubleEncodedAsset.body));
  const kDoubleEncodedId = kDoubleEncodedAsset.body.id;
  await rawRun('UPDATE it_assets SET attrs = ? WHERE id = ?', [JSON.stringify('{"fin_amount":1}'), kDoubleEncodedId]);
  const kDoubleEncodedGet = await api('GET', `/api/it-assets/${kDoubleEncodedId}`, { uid: 1, role: 'admin' });
  expectCode(kDoubleEncodedGet, 'LEDGER_INTERNAL', 'K补-双重编码attrs GET详情: code=LEDGER_INTERNAL');
  check('K补-双重编码attrs GET详情: 状态码500', kDoubleEncodedGet.status === 500, JSON.stringify(kDoubleEncodedGet.body));
  await rawRun("UPDATE it_assets SET attrs = '{}' WHERE id = ?", [kDoubleEncodedId]);
  const kDoubleEncodedAfterCleanup = await api('GET', `/api/it-assets/${kDoubleEncodedId}`, { uid: 1, role: 'admin' });
  check('K补-双重编码attrs清理后: GET详情恢复200', kDoubleEncodedAfterCleanup.status === 200, JSON.stringify(kDoubleEncodedAfterCleanup.body));

  // ============================================================
  // L. P10 三字段可见性 + 财务字段隔离补充覆盖（T-H4）
  // ============================================================
  currentCaseLabel = 'L组: P10三字段与财务隔离补充覆盖';

  // ①P10 三字段登记/编辑写入 → 详情/列表可见（非 admin 也可见，反向断言不被误剔）；
  //   asset_class 非法值 400（登记与编辑各一，各测两个非法值）。
  const lReg = await regAdmin({
    category: 'other', name: uniq('l-p10'), u_height: 0, placement: { kind: 'place', location_text: 'x' },
    owner_name: '张三', owner_dept: '信息技术部', asset_class: 'fixed',
  });
  check('L①-登记写入owner_name/owner_dept/asset_class: 成功', lReg.status === 201, JSON.stringify(lReg.body));
  const lDetailNonAdmin = await api('GET', `/api/it-assets/${lReg.body.id}`, { uid: 3, role: 'user' });
  check('L①-非admin详情可见owner_name/owner_dept/asset_class(不被误剔)',
    lDetailNonAdmin.body.asset.owner_name === '张三' && lDetailNonAdmin.body.asset.owner_dept === '信息技术部' && lDetailNonAdmin.body.asset.asset_class === 'fixed',
    JSON.stringify(lDetailNonAdmin.body.asset));
  const lListNonAdmin = await api('GET', '/api/it-assets?category=other', { uid: 3, role: 'user' });
  const lListedItem = lListNonAdmin.body.items.find((it) => it.id === lReg.body.id);
  check('L①-非admin列表可见P10三字段(不被误剔)',
    !!lListedItem && lListedItem.owner_name === '张三' && lListedItem.owner_dept === '信息技术部' && lListedItem.asset_class === 'fixed',
    JSON.stringify(lListedItem));
  // T-M2（Opus 复看第8批）：核登记事件本身的 to_state 也带上了这三个真实值（不止是"落库资产
  // 看得到"，事件快照也要对得上，两处不能有一处漏记）。
  const lRegEvent = lDetailNonAdmin.body.events.find((ev) => ev.action === 'register');
  check('L①-register事件to_state含P10三值(结构化精确比较)',
    !!lRegEvent && lRegEvent.to_state.owner_name === '张三' && lRegEvent.to_state.owner_dept === '信息技术部' && lRegEvent.to_state.asset_class === 'fixed',
    JSON.stringify(lRegEvent && lRegEvent.to_state));

  const lRegBadClass1 = await regAdmin({ category: 'other', name: uniq('l-badclass1'), u_height: 0, placement: { kind: 'place', location_text: 'x' }, asset_class: 'FIXED' });
  check("L①-登记asset_class非法值'FIXED': 400 code=INVALID_ASSET_CLASS", lRegBadClass1.status === 400 && lRegBadClass1.body.code === 'INVALID_ASSET_CLASS', JSON.stringify(lRegBadClass1.body));
  const lRegBadClass2 = await regAdmin({ category: 'other', name: uniq('l-badclass2'), u_height: 0, placement: { kind: 'place', location_text: 'x' }, asset_class: 'other' });
  check("L①-登记asset_class非法值'other': 400", lRegBadClass2.status === 400, JSON.stringify(lRegBadClass2.body));

  const lEditOwner = await editAdmin(lReg.body.id, { expected_version: lReg.body.version, owner_name: '李四', owner_dept: '财务部', asset_class: 'low_value' });
  check('L①-编辑写入owner_name/owner_dept/asset_class: 成功',
    lEditOwner.status === 200 && lEditOwner.body.owner_name === '李四' && lEditOwner.body.owner_dept === '财务部' && lEditOwner.body.asset_class === 'low_value',
    JSON.stringify(lEditOwner.body));
  const lEditBadClass1 = await editAdmin(lReg.body.id, { expected_version: lEditOwner.body.version, asset_class: 'FIXED' });
  check("L①-编辑asset_class非法值'FIXED': 400", lEditBadClass1.status === 400, JSON.stringify(lEditBadClass1.body));
  const lEditBadClass2 = await editAdmin(lReg.body.id, { expected_version: lEditOwner.body.version, asset_class: 'other' });
  check("L①-编辑asset_class非法值'other': 400", lEditBadClass2.status === 400, JSON.stringify(lEditBadClass2.body));

  // ②非 admin 带四类财务字段（含不属于资产列的 external_amount）各一条 400。
  const financeBadFields = ['fin_amount', 'fin_vendor', 'fin_contract_no', 'external_amount'];
  for (const f of financeBadFields) {
    const val = f === 'fin_amount' ? 999 : 'x';
    const r = await api('POST', '/api/it-assets', {
      uid: 2, role: 'user',
      body: { category: 'other', name: uniq(`l-fin-${f}`), u_height: 0, placement: { kind: 'place', location_text: 'x' }, [f]: val },
    });
    check(`L②-非admin登记带${f}: 400 FINANCE_FIELD_FORBIDDEN`, r.status === 400 && r.body.code === 'FINANCE_FIELD_FORBIDDEN', JSON.stringify(r.body));
  }

  // ③admin 先写入三列真实非空财务值 → 非 admin 详情/列表/时间线均不含四键，预期行存在，
  //   非敏感字段（name）保留；admin 响应含真实值作对照。
  const lFinAsset = await regAdmin({
    category: 'other', name: uniq('l-fin-asset'), u_height: 0, placement: { kind: 'place', location_text: 'x' },
    fin_amount: 88888.88, fin_vendor: '某供应商', fin_contract_no: 'HT-2027-001',
  });
  check('L③夹具: admin登记带三项真实财务值成功', lFinAsset.status === 201, JSON.stringify(lFinAsset.body));
  const lFinId = lFinAsset.body.id;
  const lFinDetailAdmin = await api('GET', `/api/it-assets/${lFinId}`, { uid: 1, role: 'admin' });
  check('L③-admin详情含三项财务真实值(对照)',
    lFinDetailAdmin.body.asset.fin_amount === 88888.88 && lFinDetailAdmin.body.asset.fin_vendor === '某供应商' && lFinDetailAdmin.body.asset.fin_contract_no === 'HT-2027-001',
    JSON.stringify(lFinDetailAdmin.body.asset));
  const lFinDetailUser = await api('GET', `/api/it-assets/${lFinId}`, { uid: 3, role: 'user' });
  const FIN_KEYS = ['fin_amount', 'fin_vendor', 'fin_contract_no', 'external_amount'];
  check('L③-非admin详情不含四键', FIN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(lFinDetailUser.body.asset, k)), JSON.stringify(lFinDetailUser.body.asset));
  check('L③-非admin详情预期行存在且name等非敏感字段保留',
    lFinDetailUser.body.asset.id === lFinId && lFinDetailUser.body.asset.name === lFinAsset.body.name, JSON.stringify(lFinDetailUser.body.asset));
  // T-H2（Opus 复看第5批）：删掉序列化字符串搜索的写法，改为结构化键集合核对——逐个事件的
  // from_state/to_state 键集合都不含四财务键（register 事件本身按 PAYLOAD_KEYS 白名单就不可能
  // 带财务键，这里做的是"响应层确实经过同一套 stripFinance/事件白名单"的结构化断言，不靠字符串
  // 猜测覆盖到什么程度）。
  check('L③-非admin时间线(events)每条事件的from_state/to_state键集合均不含四财务键',
    lFinDetailUser.body.events.every((ev) => FIN_KEYS.every((k) => !Object.keys(ev.from_state).includes(k) && !Object.keys(ev.to_state).includes(k))),
    JSON.stringify(lFinDetailUser.body.events));

  const lFinListUser = await api('GET', '/api/it-assets?category=other', { uid: 3, role: 'user' });
  const lFinListedItem = lFinListUser.body.items.find((it) => it.id === lFinId);
  check('L③-非admin列表预期行存在', !!lFinListedItem, JSON.stringify(lFinListedItem));
  check('L③-非admin列表不含四键', !!lFinListedItem && FIN_KEYS.every((k) => !Object.prototype.hasOwnProperty.call(lFinListedItem, k)), JSON.stringify(lFinListedItem));

  // ============================================================
  // M. 补齐剩余错误码覆盖 + WRITE_ERROR_CODES 对拍（T-H5）
  // ============================================================
  currentCaseLabel = 'M组: 补齐错误码覆盖与WRITE_ERROR_CODES对拍';

  // LEDGER_NOT_FOUND：编辑/机柜/楼层三处不存在的资源。
  const mEditNotFound = await editAdmin(999999999, { expected_version: 1, name: 'x' });
  check('M-编辑不存在的资产: 404 LEDGER_NOT_FOUND', mEditNotFound.status === 404 && mEditNotFound.body.code === 'LEDGER_NOT_FOUND', JSON.stringify(mEditNotFound.body));

  // LEDGER_DUPLICATE_FLOOR_NAME：两个不同 id 的楼层同名。
  const mFloorNameDup = uniq('楼层重名');
  const mFloorA = nextFloorId();
  const mFloorB = nextFloorId();
  await api('PUT', `/api/it-assets/floors/${mFloorA}`, { uid: 1, role: 'admin', body: { name: mFloorNameDup, rooms: [] } });
  const mFloorDupResult = await api('PUT', `/api/it-assets/floors/${mFloorB}`, { uid: 1, role: 'admin', body: { name: mFloorNameDup, rooms: [] } });
  check('M-楼层同名(不同id): 409 LEDGER_DUPLICATE_FLOOR_NAME', mFloorDupResult.status === 409 && mFloorDupResult.body.code === 'LEDGER_DUPLICATE_FLOOR_NAME', JSON.stringify(mFloorDupResult.body));

  // LEDGER_INVALID_ID：路径参数非正整数。
  const mInvalidId = await api('GET', '/api/it-assets/not-a-number', { uid: 1, role: 'admin' });
  check('M-详情id非数字: 400 LEDGER_INVALID_ID', mInvalidId.status === 400 && mInvalidId.body.code === 'LEDGER_INVALID_ID', JSON.stringify(mInvalidId.body));

  // U_INTERVAL_OUT_OF_RANGE：越顶（HTTP 可达，register 直接触发）。u_start<1 这一支已随 Opus
  //   复看第5批的 S-M1（NUMERIC_DOMAIN 规则，排在 RULES 最前）被前移接管——ruleRackInterval
  //   自身的"u_start<1"分支现已被证明是死代码并删除（NUMERIC_DOMAIN 先一步判定 u_start 必须
  //   是安全整数且 ≥1，跑到 RACK_INTERVAL 时 u_start<1 不可能再发生），故 u_start<1 场景现在
  //   走 NUMERIC_DOMAIN 的 LEDGER_BAD_REQUEST/400（见下方 J 组同名规则用例），不再归属
  //   U_INTERVAL_OUT_OF_RANGE。
  const mOverTop = await regAdmin({ category: 'server', name: uniq('m-overtop'), u_height: 3, placement: { kind: 'rack', rack_id: rackId, u_start: 9 } });
  check('M-机柜区间越顶: 409 U_INTERVAL_OUT_OF_RANGE', mOverTop.status === 409 && mOverTop.body.code === 'U_INTERVAL_OUT_OF_RANGE', JSON.stringify(mOverTop.body));

  // LEDGER_INTERNAL：S-H1 fail-closed 分支——生产 HTTP 路径永远显式设 ctx，不应该被触达；
  //   如实用纯函数直调证明该 fail-closed 分支存在且真的会拦（不是死代码）。
  //   第4批 HIGH-1：补全行后 ctx={} 本身没有 rack 键可查（不是"元素形态非法"），ROW_SCHEMA
  //   的 ctx 校验对"键不存在"不报错——这条真正命中的是 RACK_INTERVAL 规则自己的 ctxMissing
  //   分支（row.status='in_service' 且 isHostEligible 时要求 ctx.rack+occupiedIntervals），
  //   与 ROW_SCHEMA 无关，断言收紧到 rule='RACK_INTERVAL' + field='rack'。
  {
    const { validateAssetInvariants } = itLedgerModule._internals.invariants;
    const row = fullRow({ category: 'server', status: 'in_service', u_height: 2, slot_count: 0, u_start: 3, rack_id: 1 });
    const violation = validateAssetInvariants(row, {}); // 故意不传 ctx.rack/occupiedIntervals
    check('M-ctx缺失(纯函数直调，生产HTTP路径不可达因index.js恒显式设ctx): RACK_INTERVAL/rack/500',
      !!violation && violation.rule === 'RACK_INTERVAL' && violation.field === 'rack' && violation.code === 'LEDGER_INTERNAL' && violation.status === 500,
      JSON.stringify(violation));
    if (violation) observedCodes.add(violation.code);
  }

  // C4 #25 用户批准：既有基础设施码 LEDGER_BUSY 补登，C2 真实 COMMIT 忙覆盖，不加闭集豁免。
  {
    currentCaseLabel = 'M组: COMMIT忙真实503与完整回滚';
    const fixture = await regAdmin({ category: 'disk', name: uniq('M-busy'), placement: { kind: 'depot', status: 'in_depot' } });
    check('M-BUSY:夹具登记201', fixture.status === 201, JSON.stringify(fixture));
    if (fixture.status !== 201) throw new Error('M-BUSY fixture failed');
    let reader; let inTransaction = false;
    const run = (sql) => new Promise((resolve, reject) => reader.run(sql, (error) => error ? reject(error) : resolve()));
    const all = (sql) => new Promise((resolve, reject) => reader.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
    try {
      reader = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(TEST_DB, sqlite3.OPEN_READONLY, (error) => error ? reject(error) : resolve(db));
      });
      const before = await all('SELECT * FROM it_assets ORDER BY id');
      const beforeEvents = await all('SELECT * FROM it_asset_events ORDER BY id');
      check('M-BUSY:资产与事件快照非空', before.length > 0 && beforeEvents.length > 0);
      check('M-BUSY:delete日志模式', (await all('PRAGMA journal_mode'))[0].journal_mode === 'delete');
      await run('BEGIN'); inTransaction = true;
      await all('SELECT * FROM it_assets LIMIT 1'); // 获取真实 SHARED 锁，允许另一连接 BEGIN/UPDATE，阻止其 COMMIT。
      await itLedgerModule._internals.setBusyTimeout(100);
      itLedgerModule._internals.clearConnTrace();
      const r = await editAdmin(fixture.body.id, { expected_version: 1, name: 'busy must rollback' });
      await run('ROLLBACK'); inTransaction = false; // 释放读快照后重查，防止旧快照掩盖错误提交。
      check('M-BUSY:HTTP 503 LEDGER_BUSY', r.status === 503 && r.body.code === 'LEDGER_BUSY', JSON.stringify(r));
      const trace = itLedgerModule._internals.getConnTrace();
      check('M-BUSY:到达COMMIT再ROLLBACK', trace.some((x) => x.sql === 'COMMIT') && trace.some((x) => x.sql === 'ROLLBACK'), JSON.stringify(trace));
      check('M-BUSY:全资产完整行回滚', JSON.stringify(before) === JSON.stringify(await all('SELECT * FROM it_assets ORDER BY id')));
      check('M-BUSY:全事件完整行回滚', JSON.stringify(beforeEvents) === JSON.stringify(await all('SELECT * FROM it_asset_events ORDER BY id')));
    } finally {
      try {
        if (reader) {
          try { if (inTransaction) await run('ROLLBACK'); }
          finally { await new Promise((resolve, reject) => reader.close((error) => error ? reject(error) : resolve())); }
        }
      } finally { await itLedgerModule._internals.setBusyTimeout(5000); }
    }
  }

  // WRITE_ERROR_CODES 对拍（Opus 复看第1条收紧）：
  // ①「用到但不在集合」——仍走文本扫描（这个方向本质是"防手滑发明新码/写错码名"的静态检查，
  //   跟运行期是否真触发无关，文本扫描本身没问题）。
  // ②「集合里的码是否真被这套守卫至少触发过一次」——改成运行期观测（observedCodes，由 api()
  //   在唯一 HTTP 出口自动记录 + 两处纯函数直调手工补记，见上文），不再用文本扫描——文本扫描
  //   连注释、候选数组字面量都算命中，SLOT_OCCUPIED 曾经就是这样在文本扫描下显绿、实际零次
  //   真实触发（Opus 复看第2条已补上真正触发它的串行用例）。
  const selfSource = fs.readFileSync(__filename, 'utf8');
  // C3（长任务D·L3·主会话2026-09-20裁定B.5）：ACTION_ERROR_CODES 六码已并入共享的
  // WRITE_ERROR_CODES 闭集（供 index.js 单一真相源），但它们只能经 /actions/:action 端点触发，
  // 本文件（C2 登记/编辑/机柜/楼层）从不调用该端点——完备性检查排除这六码，改由
  // verify-it-ledger-actions.js 的 N10 组负责核验它们"至少被观测一次"（该守卫已覆盖）。
  // 这不是放宽本文件的断言语义，是修正"闭集因新增族群扩大导致本文件断言范围失真"这个真实的
  // 结构性问题——本文件仍然要求"自己能触达的每个码都被真实触发过"，一条不少。
  // L21（主会话第3批裁定）：**C4/C5/C6 新增动作码的接线纪律**——新码必须同时做两件事：
  // ① 加进 index.js 的 ACTION_ERROR_CODES（会自动并入这里排除的集合，本文件不用跟着改）；
  // ② 在 verify-it-ledger-actions.js 的 N10 组补一条“该码至少被观测一次”的真实触发用例
  // （不能只满足于 ACTION_ERROR_CODES 收录，收录不等于真被 HTTP 路径触发过）。
  const actionCodes = itLedgerModule._internals.ACTION_ERROR_CODES || new Set();
  const declaredCodes = Array.from(itLedgerModule._internals.WRITE_ERROR_CODES).filter((c) => !actionCodes.has(c));
  const codeAssertionRe = /\.code\s*===\s*'([A-Z][A-Z0-9_]+)'/g;
  const usedViaAssertion = new Set();
  let mCodeMatch;
  while ((mCodeMatch = codeAssertionRe.exec(selfSource))) usedViaAssertion.add(mCodeMatch[1]);
  // expectCode(...) 调用点的第二个参数（期望码）也算"用到"，一并纳入①方向的扫描，否则改用
  // expectCode 的断言点会被①的文本扫描漏记（该正则只认 `.code === 'X'` 这一种写法）。
  const expectCodeCallRe = /expectCode\([^,]+,\s*'([A-Z][A-Z0-9_]+)'/g;
  while ((mCodeMatch = expectCodeCallRe.exec(selfSource))) usedViaAssertion.add(mCodeMatch[1]);
  const declaredSet = new Set(declaredCodes);
  const usedNotDeclared = [...usedViaAssertion].filter((c) => !declaredSet.has(c));
  check('M-WRITE_ERROR_CODES: 本文件断言用到的码均∈集合(无越界新码)', usedNotDeclared.length === 0, `越界: ${usedNotDeclared.join(',') || '(无)'}`);
  const declaredButNotObserved = declaredCodes.filter((code) => !observedCodes.has(code));
  check('M-WRITE_ERROR_CODES: 集合内每个码运行期至少被真实触发一次(observedCodes，非文本扫描)',
    declaredButNotObserved.length === 0, `未命中: ${declaredButNotObserved.join(',') || '(无)'}`);

  } finally {
  // ── 收尾（T-M8，Opus 复看第5批 → T-M3 第8批收进 finally）──────────────────────────
  // server.close 套独立超时（不能让"关闭 http server"这一步本身无限期挂起整个进程）；
  // shutdown 失败计入 FAIL（不是 best-effort 静默吞掉——收尾失败本身就是一个真实信号）；
  // 清理失败要输出残留路径且让 FAIL≠0；断言是否通过与清理是否成功分两条 check()，不混在一起
  // （"全绿但留了一堆垃圾文件"和"清理成功但断言有假"都不该被对方掩盖）。
  // T2（Opus 复看第9小批修复）：server/itLedgerModule 现在可能是 null（早期失败，try 内还没
  // 走到创建它们那一步）——按存在与否分支处理，不再假设它们一定已创建好，否则这里自己先抛
  // TypeError，会把真正的原始错误信息盖掉。
  if (server) {
    try {
      await withTimeout(new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }), 5000, '收尾server.close');
      check('收尾: server.close()成功', true);
    } catch (e) {
      check('收尾: server.close()成功', false, e && e.message);
    }
  } else {
    check('收尾: server未创建(无需close，早期失败)', true);
  }
  if (itLedgerModule) {
    try {
      await withTimeout(itLedgerModule.shutdown(), 5000, '收尾shutdown');
      check('收尾: itLedgerModule.shutdown()成功', true);
    } catch (e) {
      check('收尾: itLedgerModule.shutdown()成功', false, e && e.message);
    }
  } else {
    check('收尾: itLedgerModule未创建(无需shutdown，早期失败)', true);
  }
  // Opus 复看第7批第2条（MED）：Windows 下 sqlite3 关闭连接与文件句柄真正释放之间可能有极短
  // 延迟，TEST_DB 首次 unlink 偶发 EBUSY/EPERM 不代表真的清理失败——改为有界重试（3 次，间隔
  // 100ms），整体套 withTimeout 防止意外挂起；重试耗尽仍失败才真的计入 cleanupFailures。
  // MUTANT_DIR 保持严格单次尝试（它是脚本自己刚写完、刚 require 过的临时文件，没有类似的
  // 驱动层延迟释放场景，重试掩盖不了真实问题）。
  async function unlinkWithRetry(filePath, attempts, delayMs) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return { ok: true };
      } catch (e) {
        lastErr = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return { ok: false, error: lastErr };
  }
  const cleanupFailures = [];
  try {
    const dbCleanup = await withTimeout(unlinkWithRetry(TEST_DB, 3, 100), 3000, '收尾TEST_DB删除(有界重试)');
    if (!dbCleanup.ok) cleanupFailures.push(TEST_DB);
  } catch (e) {
    cleanupFailures.push(TEST_DB);
  }
  // T-M3：这里在 finally 块里，看不见 try 块内部用 const 声明的 MUTANT_DIR（块作用域，try/
  // finally 是并列的兄弟块，不是嵌套）——改用桥接变量 currentMutantDir（同一份路径，main()
  // 一算出来就同步赋值过，见 J 组开头）。
  try { if (currentMutantDir && fs.existsSync(currentMutantDir)) fs.rmSync(currentMutantDir, { recursive: true, force: true }); } catch (e) { cleanupFailures.push(currentMutantDir); }
  check('收尾: 临时文件/目录清理成功(TEST_DB+MUTANT_DIR)', cleanupFailures.length === 0,
    cleanupFailures.length ? `残留路径: ${cleanupFailures.join(', ')}` : undefined);
  } // 关闭 T-M3 的 try/finally（finally 收尾至此结束）

  clearTimeout(mainDeadlineTimer);
  console.log(results.join('\n'));
  console.log(`PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL] main() 未捕获异常', err && (err.stack || err.message));
  // T2（Opus 复看第9小批修复）：main().catch 与 fatalExit 统一输出全部残留路径——finally 里的
  // 清理已经尽力做过一遍，但如果异常发生在 finally 本身收尾逻辑之外（比如 finally 之后的
  // console.log/process.exit 段抛错，理论上不太可能但不排除），或者 finally 内部清理本身也
  // 失败了，这里再报一次同样的两个路径，方便人工核实是否真的干净。
  console.error(`[FATAL] TEST_DB=${TEST_DB}（临时文件留待人工清理，本进程不再尝试删除）`);
  console.error(`[FATAL] MUTANT_DIR=${currentMutantDir || '(尚未创建)'}（临时目录留待人工清理，本进程不再尝试删除）`);
  console.log(results.join('\n'));
  console.log(`PASS=${pass} FAIL=${fail + 1}`);
  process.exit(1);
});
