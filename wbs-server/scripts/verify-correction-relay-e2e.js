// verify-correction-relay-e2e.js — 路线 B 对接人白名单化端到端（隔离测试实例 + 实例密钥签 token + seed）
//   验证真实 http 路径（中间件 requireRelayOrPublisherOrAdmin → handler → correctionTransition 串起来）下：
//   建单 path B 白名单+phone 校验 / 列表+详情可见性 handler / user 角色白名单 relay 派单(RC-M3) / 越权 403。
//   seed：实例库（本机库快照）无 id=13、id=7 无 phone → 复制 id=7 行造 id=13(user+phone) + 临时给 id=7 补 phone；测后清理恢复。
//
// [#106 S4c-C] 迁移到 test-env 隔离实例：
//   · 不再自 spawn server.js、不再写死 localhost:3000、不再直写真实库 task_pool.db、不再加载 .env / 读 JWT_SECRET：
//     入口第一条副作用语句 `await testEnv.ready()` 自起临时隔离实例（或核对 TEST_* 变量组）；seed / 清理都作用在 **实例库**（env().dbPath）。
//   · token 一律 testEnv.signToken(id)：它读实例库 users 行，所以 id=13 必须先 seed 再签（顺序见入口）；
//     id=1 / id=7 / id=9 的 role 取实例库里的值（不再手填 'admin' / 'user'）：id=9 在原脚本里伪造为 role=user，现取库内值——
//     首跑核对点：id=9 在实例库里应为非白名单、非 admin/publisher 的普通账号，否则「越权 403」两条断言会变（见交付报告）。
//   · 原 sleep(900)（等服务与 correction readiness）已删：ready() 返回时 test-env 已确认实例与全部模块就绪。
//   · 原「服务日志无 ReferenceError/TypeError」断言（读自己 spawn 的 stdout/stderr 缓冲）改读 <实例数据根>/server.log：
//     入口 ready 后立即记录文件大小 LOG_OFFSET。扫描窗口：自起实例（env().selfStarted）从文件开头扫（与原「spawn 以来的全部输出」等价），
//     跑在共享实例（变量组形态）上才只看 LOG_OFFSET 之后新增的部分；数据根 / 日志取不到、日志变短 → 断言计失败，不静默通过。
//     [#106 S4c-2] 正向对照：[0, LOG_OFFSET) 里必须有本实例的 `[instance] mode=isolated instance=<身份> ... port=<本实例端口>` 启动行（server.js:22782，不受 LOG_LEVEL 影响），
//     不满足计失败；info 级日志已开时窗口里还须出现本脚本建单产生的「建数据修正单 #<id>」（corrections.js:1522）。
//     启动期日志误命中 /ReferenceError|is not defined|is not a function|TypeError/ 的可能：静态检索 server.js / routes / utils，这几个词只出现在注释和运行期才抛的错误里，
//     没有启动期打印的日志文案含它们。
//   · 越权 403 的身份前提（S4c-2）：seed 之后断言 id=9 为 active、role 不是 admin / publisher、不在 RELAY_WHITELIST_IDS；三条 403 断言（id=9 看详情、
//     白名单 relay(13) 看 / 派非本人经手单）再要求响应体不是「账号已被禁用 / 账号不存在」（authenticateToken 对这两种也回 403）。
//   · 清理里的 `LIKE 'E2E%'` 通配只在 exclusive 时安全（会删同实例上别的脚本的 E2E 开头单），relay 必须 exclusive。
//   · 批跑须 exclusive：本脚本改 users 表（id=7 补 phone、插 id=13），变量组形态下实例会被多个脚本共用，不得与读用户表的套件并行。
//     实例是自起的则 teardown 整个删除；清理（恢复 id=7 phone、删 id=13、删 E2E 单）仍保留，供变量组形态的共享实例使用，清理失败计入失败数。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const testEnv = require('./lib/test-env');

// 以下在 ready() 之后的入口里赋值
let TARGET = null;      // new URL(实例 baseUrl)
let db = null;          // 实例库连接（OPEN_READWRITE，不带 OPEN_CREATE）
let T_ADMIN = null, T_R13 = null, T_NONWL = null;   // id=9 本地存在、非白名单、非测试单任何角色
let LOG_FILE = null, LOG_OFFSET = null, LOG_PROBLEM = null;
let SCAN_START = 0;     // 日志扫描窗口起点：自起实例 0（从头扫），共享实例 = LOG_OFFSET

const get = (s, p = []) => new Promise((res, rej) => db.get(s, p, (e, r) => e ? rej(e) : res(r)));
const run = (s, p = []) => new Promise((res, rej) => db.run(s, p, function (e) { e ? rej(e) : res(this); }));

// [#106 S4c 收口] 与 _test-fixture.js 的 openInstanceDb 同源写法（OPEN_READWRITE、不带 OPEN_CREATE、打开回调转 Promise）；本脚本只用 testEnv、不经 fx，故保留本地副本
function openInstanceDb(dbPath) {
  return new Promise((resolve, reject) => {
    const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(d)));
  });
}

function req(token, method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: TARGET.hostname, port: Number(TARGET.port), method, path: p,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data); r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const jparse = (b) => { try { return JSON.parse(b || '{}'); } catch (_) { return {}; } };
const listIds = (b) => { const j = jparse(b); const a = j.data || j.corrections || j.list || j.items || (Array.isArray(j) ? j : []); return a.map(x => x.id); };

let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label + ' — ' + (detail || '')); fail++; } };

// [#106 S4c-2 收口] 三个独立标记，不再用 `orig7phone !== null` 同时表示「原值」与「是否已 seed」（id=7 的原 phone 本来就可能是 NULL）：
//   captured7 = 已读到 id=7 的原 phone（orig7phone 才有意义）；modified7 = 已对 id=7 发出改写（改写前先置，见 seed）；seeded13 = 已插入 id=13（插入成功后置）。
let orig7phone = null, captured7 = false, modified7 = false, seeded13 = false, cleaned = false;

/** 取 ready 之后的日志位置：数据根 / 日志文件任一取不到都记入 LOG_PROBLEM（断言处计失败）。
 *  LOG_OFFSET = ready 时刻的文件大小（[0, LOG_OFFSET) 是正向对照的前缀）；扫描起点 SCAN_START：自起实例（env().selfStarted）从文件开头扫
 *  （与原脚本「spawn 以来的全部输出」等价，启动期异常也能抓到），变量组形态才用 LOG_OFFSET。
 *  [#106 S4c 收口] 为什么按 selfStarted 判定：变量组形态下实例可能被别的脚本共用，从头扫会混进他人的日志；但脚本从 env() 分不出变量组指向的是共享还是 exclusive 实例，
 *  只能按 selfStarted（自起 = 本脚本私有）判定，变量组形态一律按「可能共享」处理、只看 LOG_OFFSET 之后新增的部分。 */
function locateLog() {
  const e = testEnv.env();
  const dataDir = e.dataDir;
  if (!dataDir) { LOG_PROBLEM = '取不到实例数据根（env().dataDir 为 null）：无法定位 server.log，日志断言无法进行'; return; }
  LOG_FILE = path.join(dataDir, 'server.log');
  try {
    LOG_OFFSET = fs.statSync(LOG_FILE).size;
    SCAN_START = e.selfStarted ? 0 : LOG_OFFSET;
  } catch (er) {
    LOG_PROBLEM = `server.log 不存在或读不了（${LOG_FILE}）：${er && er.code ? er.code : er.message}`;
  }
}
/** 读日志窗口 [SCAN_START, 末尾)；任何异常 / 日志变短 / 正向对照不满足都返回 { problem }。
 *  正向对照（证明读的就是本实例的日志）：[0, LOG_OFFSET) 里必须有本实例的 `[instance] mode=isolated instance=<身份> ` 启动行，且该行含 port=<本实例端口>。
 *  可选更强项：前缀里已有 `[INFO]` 行（info 级日志是开的）时，窗口里还必须出现 expectLine（本脚本建单产生的「建数据修正单 #<id>」，routes/corrections.js:1522），
 *  证明窗口在记录本脚本的请求；info 级没开时这一项做不到，不检查。 */
function readNewLog(expectLine) {
  if (LOG_PROBLEM) return { problem: LOG_PROBLEM };
  try {
    const buf = fs.readFileSync(LOG_FILE);
    if (buf.length < LOG_OFFSET) return { problem: `server.log 比 ready 时记录的偏移还短（${buf.length} < ${LOG_OFFSET}）：日志被截断或替换，断言不可信` };
    const prefix = buf.subarray(0, LOG_OFFSET).toString('utf8');
    const instance = testEnv.env().instance;
    const instLine = instance ? prefix.split(/\r?\n/).find((l) => l.includes(`[instance] mode=isolated instance=${instance} `)) : null;
    if (!instLine) return { problem: `正向对照失败：server.log 的 ready 前缀里没有本实例的 "[instance] mode=isolated instance=${instance} " 启动行，读的可能不是本实例的日志` };
    // [#106 S4c 收口] port 子串匹配收紧边界：port= 后须接空白或行尾（启动行里 port= 是最后一个字段），避免 port=300 误中 port=3001 这类前缀碰撞
    if (!new RegExp(`\\bport=${TARGET.port}(\\s|$)`).test(instLine)) return { problem: `正向对照失败：启动行 "${instLine.slice(0, 160)}" 不含 port=${TARGET.port}（后接空白或行尾）` };
    const text = buf.subarray(SCAN_START).toString('utf8');
    // [#106 S4c 收口] 「建数据修正单 #<id>」同样收紧边界：id 后不得再接数字（日志格式 `建数据修正单 #<id>（类型/系统）`，routes/corrections.js:1522），避免 #1 误中 #12
    if (prefix.includes('[INFO]') && expectLine && !expectLine.test(text)) {
      return { problem: `正向对照失败：info 级日志已开（前缀有 [INFO] 行），但日志窗口里没有本脚本建单产生的 ${expectLine}，窗口未在记录本脚本的请求` };
    }
    return { text };
  } catch (e) {
    return { problem: `读取 server.log 失败（${LOG_FILE}）：${e && e.code ? e.code : e.message}` };
  }
}

// authenticateToken 对「账号已被禁用 / 账号不存在」也回 403（server.js:4383-4388）：越权 403 断言要排除这两种，证明 403 来自可见性 / transition 闸门而不是账号状态
// [#106 S4c 收口] 另加「登录已过期」：authenticateToken 的 token 无效分支（server.js:4380）同样回 403，文案「登录已过期」
const ACCOUNT_STATE_403_RE = /账号已被禁用|账号不存在|登录已过期/;
// 平台上的白名单对接人 id：与 routes/corrections.js:692 的 CORRECTION_RELAY_USER_IDS 同值（该常量不便在本脚本里加载，改动时须同步，id=9 前提断言会在失配时出错）
const RELAY_WHITELIST_IDS = [7, 13];

async function seed() {
  const u7 = await get('SELECT * FROM users WHERE id = 7');
  if (!u7) throw new Error('实例库无 id=7，无法 seed（端到端需要 publisher 基准行）');
  orig7phone = u7.phone;
  captured7 = true;     // 先捕获原值（可能就是 NULL）
  modified7 = true;     // 再改写；标记在发出 UPDATE 之前置：改写若半途出错，补清理按原值恢复也是幂等的（恢复到本来的值），比「成功后才置」不会漏恢复
  await run("UPDATE users SET phone = '13800000007' WHERE id = 7");                    // 临时给示例发布者补 phone（path B 测）
  const existing13 = await get('SELECT id FROM users WHERE id = 13');
  if (!existing13) {
    const row13 = Object.assign({}, u7, { id: 13, username: 'TEST_RELAY_13', display_name: '示例对接人(e2e)', role: 'user', phone: '19900000024' });
    const cols = Object.keys(row13);
    await run(`INSERT INTO users (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, cols.map(c => row13[c]));
    seeded13 = true;
  } else {
    await run("UPDATE users SET role='user', phone='19900000024' WHERE id=13");
  }
}
/** 清理：返回失败描述数组（空 = 全部成功）。服务端还连着实例库，写锁偶发 busy，每步重试几次 */
async function cleanup() {
  cleaned = true;
  const errs = [];
  const retry = async (label, fn) => {
    let last = null;
    for (let i = 0; i < 6; i++) {
      try { await fn(); return; } catch (e) { last = e; await sleep(300); }
    }
    errs.push(`${label}：${last && last.message}`);
  };
  // 兜底按 location_info 删所有 E2E 单（不依赖 created id）
  await retry('删 E2E 单的状态历史', () => run("DELETE FROM correction_status_history WHERE correction_request_id IN (SELECT id FROM correction_requests WHERE location_info LIKE 'E2E%')"));
  await retry('删 E2E 单', () => run("DELETE FROM correction_requests WHERE location_info LIKE 'E2E%'"));
  if (seeded13) await retry('删 seed 的用户 id=13', () => run('DELETE FROM users WHERE id=13'));
  if (captured7 && modified7) await retry('恢复 id=7 的 phone', () => run('UPDATE users SET phone=? WHERE id=7', [orig7phone]));   // 原值可能是 NULL：按 captured7 / modified7 判断，不看值是否为 null
  return errs;
}

// 返回失败项数（不在 helper 里 process.exit：由入口在 teardown 之后 finish）
async function main() {
  console.log('=== 路线 B 对接人白名单化 端到端（隔离测试实例 + 实例密钥签 token）===\n');
  const created = [];
  try {
    // 1. 建单 path B：admin 建 relay=13 单 → 白名单+phone 通过
    const c13 = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'BMS', location_info: 'E2E relay13 单', requester_name: 'E2E', correction_type: 'single', reason: 'relay13 对接人测试原因', relay_notified_user_id: 13 });
    const id13 = jparse(c13.body).id; if (id13) created.push(id13);
    check(c13.status === 200 && !!id13, `建单 path B relay=13（白名单+phone 通过）→ 200 #${id13}`, `status=${c13.status} ${(c13.body || '').slice(0, 140)}`);

    // 2. 列表可见性：白名单 relay(13) 列表可见其经手单
    const lst = await req(T_R13, 'GET', '/api/corrections');
    check(lst.status === 200 && listIds(lst.body).includes(id13), `白名单 relay(13,user) 列表可见其经手单 #${id13}（列表 OR handler）`, `status=${lst.status}`);

    // 3. CR-M1 详情可见性：白名单 relay(13) 详情 200（列表↔详情一致）
    const d13 = await req(T_R13, 'GET', '/api/corrections/' + id13);
    check(d13.status === 200, `白名单 relay(13) 详情 #${id13} → 200（CR-M1：列表↔详情可见性一致）`, `status=${d13.status} ${(d13.body || '').slice(0, 120)}`);

    // 4. RC-M3 核心：user 角色白名单 relay 派单成功（中间件→handler→transition 真实路径）
    const asg = await req(T_R13, 'POST', '/api/corrections/' + id13 + '/assign', { assigned_to: 8 });
    check(asg.status === 200 && jparse(asg.body).status === 'ASSIGNED_PENDING_ESTIMATE', `RC-M3：user 角色白名单 relay(13) 派单 → 200 + 状态 ASSIGNED_PENDING_ESTIMATE`, `status=${asg.status} ${(asg.body || '').slice(0, 140)}`);

    // 4b. 细优④A：白名单 relay(13) 能通知开发（notify-developer 放开对接人）→ 非 403/非 500（无钉钉配置 failed 落库，但权限/依赖通过）
    const ndev = await req(T_R13, 'POST', '/api/corrections/' + id13 + '/notify-developer', {});
    check(ndev.status !== 403 && ndev.status !== 500, `细优④A：白名单 relay(13) notify-developer 非 403/500（能指派也能通知开发，补断层）`, `status=${ndev.status} ${(ndev.body || '').slice(0, 120)}`);

    // 4c. 细优 K2-M1 写读同源：白名单 relay(13) 查 dev read-status → 非 403（read-status 与 notify-developer 放开同步）
    const rsDev = await req(T_R13, 'GET', '/api/corrections/' + id13 + '/notify-read-status?recipient=dev');
    check(rsDev.status !== 403, `K2-M1：白名单 relay(13) 查 dev read-status 非 403（与 notify-developer 同权）`, `status=${rsDev.status} ${(rsDev.body || '').slice(0, 120)}`);

    // 5-前提. 越权 403 的身份前提：id=9 token 由实例库的 users 行签出，必须确实是「active、非 admin / publisher、非白名单对接人」的普通账号，
    //   否则 403 可能来自账号被禁用 / 不存在（authenticateToken 也回 403），或 id=9 其实有权限而断言方向反了
    const u9 = await get('SELECT id, status, role FROM users WHERE id = 9');
    check(!!u9 && u9.status === 'active' && u9.role !== 'admin' && u9.role !== 'publisher' && !RELAY_WHITELIST_IDS.includes(9),
      '越权前提：实例库 id=9 为 active、role 非 admin/publisher、不在白名单对接人 [7,13] 内',
      JSON.stringify(u9 || null));

    // 5. 越权：非白名单 user(99) 详情该单 → 403（且 403 不是账号被禁用 / 不存在）
    const d99 = await req(T_NONWL, 'GET', '/api/corrections/' + id13);
    check(d99.status === 403 && !ACCOUNT_STATE_403_RE.test(d99.body || ''), `非白名单 user(9) 详情 #${id13} → 403（可见性越权防护，非账号状态 403）`, `status=${d99.status} ${(d99.body || '').slice(0, 120)}`);

    // 6. 越权：白名单 relay(13) 看不到/不能派 非本人经手单（relay=7 单）
    const c7 = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'HRD', location_info: 'E2E relay7 单', requester_name: 'E2E', correction_type: 'single', reason: 'relay7 对接人测试原因', relay_notified_user_id: 7 });
    const id7 = jparse(c7.body).id; if (id7) created.push(id7);
    // [#106 S4c 送审前小修] 与 relay=13 那块同款：建单成功必须有显式断言（原先 id7 为空时静默继续，后面的 403 断言拿着 /api/corrections/undefined 去判，红因被掩盖）
    check(c7.status === 200 && !!id7, `建单 path B relay=7（经手单）→ 200 #${id7}`, `status=${c7.status} ${(c7.body || '').slice(0, 140)}`);
    const d13on7 = await req(T_R13, 'GET', '/api/corrections/' + id7);
    check(d13on7.status === 403 && !ACCOUNT_STATE_403_RE.test(d13on7.body || ''), `白名单 relay(13) 详情非本人经手单(relay=7) #${id7} → 403（非账号状态 403）`, `status=${d13on7.status} ${(d13on7.body || '').slice(0, 120)}`);
    const a13on7 = await req(T_R13, 'POST', '/api/corrections/' + id7 + '/assign', { assigned_to: 8 });
    check(a13on7.status === 403 && !ACCOUNT_STATE_403_RE.test(a13on7.body || ''), `白名单 relay(13) 派非本人经手单(relay=7) → 403（transition 权威闸门，非账号状态 403）`, `status=${a13on7.status} ${(a13on7.body || '').slice(0, 120)}`);

    // 7. path B 非白名单 → 400
    const cNon = await req(T_ADMIN, 'POST', '/api/corrections', { source_system: 'BMS', location_info: 'E2E 非白名单', requester_name: 'E2E', correction_type: 'single', reason: '非白名单对接人测试原因', relay_notified_user_id: 1 });
    check(cNon.status === 400 && jparse(cNon.body).code === 'RELAY_USER_NOT_IN_WHITELIST', `建单 path B 非白名单 relay=1 → 400 RELAY_USER_NOT_IN_WHITELIST`, `status=${cNon.status} ${(cNon.body || '').slice(0, 120)}`);

    // 服务日志断言：只看 ready 之后新增的部分；日志定位 / 读取失败 → 计失败，不静默通过
    const nl = readNewLog(id13 ? new RegExp(`建数据修正单 #${id13}(?!\\d)`) : null);   // 本脚本建 relay=13 单产生的 info 日志（正向对照，见 readNewLog；id 后不得再接数字）
    if (nl.problem) {
      check(false, '服务日志无 ReferenceError/TypeError', nl.problem);
    } else {
      const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(nl.text);
      check(!crashed, '服务日志无 ReferenceError/TypeError', crashed ? nl.text.slice(-300) : '');
    }
  } finally {
    // 服务仍在跑（实例随后由入口 teardown）：先清理 seed / E2E 单；清理失败计入失败数，不静默
    const errs = await cleanup();
    for (const m of errs) check(false, '清理 seed / E2E 单', m);
  }
  console.log(`\n${fail === 0 ? '✅' : '✗'} 路线 B 端到端：${pass} 通过 / ${fail} 失败`);
  return fail;
}

(async () => {
  // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
  await testEnv.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
  let code = 1;
  try {
    TARGET = new URL(testEnv.env().baseUrl);
    locateLog();   // ready 之后立即记录日志偏移
    db = await openInstanceDb(testEnv.env().dbPath);
    db.configure('busyTimeout', 5000);
    await seed();   // 先 seed 再签 token：signToken 读实例库 users 行，id=13 在 seed 之前不存在
    T_ADMIN = await testEnv.signToken(1);
    T_R13 = await testEnv.signToken(13);
    T_NONWL = await testEnv.signToken(9);   // id=9：角色取实例库值（原脚本伪造 role=user），首跑核对
    const nFailed = await main();
    code = nFailed > 0 ? 1 : 0;
  } catch (e) {
    console.error('✗ e2e 异常：', e && e.message);
    // seed 之后、main 之前出错（如签 token 失败）：main 的 finally 没机会跑，这里补一次清理（main 的 finally 已清理过则 cleaned 为真，不重复；seed 什么都没发生（三个标记都为假）则跳过。判据用独立标记，原 phone 为 NULL 时部分 seed 失败也会恢复）
    if (db && !cleaned && (seeded13 || modified7)) {
      const errs = await cleanup();
      for (const m of errs) console.error(`✗ 清理失败：${m}`);
    }
  } finally {
    if (db) await new Promise((resolve) => { db.close((cerr) => { if (cerr) { console.error(`关库失败：${cerr.message}`); code = 1; } resolve(); }); });
    try { await testEnv.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
  }
  testEnv.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
  console.error('correction-relay-e2e 启动失败：', e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
