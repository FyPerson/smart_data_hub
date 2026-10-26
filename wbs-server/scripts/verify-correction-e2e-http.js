// verify-correction-e2e-http.js — M-2（codex 末次审）端点级 http 冒烟
//   起隔离测试实例（真实 server.js 子进程）+ 实例密钥签 admin token + 请求 correction 关键端点，证明抽 routes 后
//   端点运行期依赖没漏接（漏注入会 500）。覆盖读（列表/详情/已读查询）+ 写（建单→作废清理）。
//   不重测业务逻辑，只验"工厂注入 + 端点依赖在真实 HTTP 路径下完整"。
//
// [#106 S4c-C] 迁移到 test-env 隔离实例：
//   · 不再自 spawn server.js、不再写死 localhost:3000、不再加载 .env / 读 JWT_SECRET：入口第一条副作用语句 `await testEnv.ready()`
//     自起临时隔离实例（或核对 TEST_* 变量组指向的隔离实例）；主机 / 端口取实例的 baseUrl，token 用 testEnv.signToken(1) 签（读实例库 users 行）。
//   · 原 waitServer / sleep(800)（等服务与 correction readiness）已删：ready() 返回时 test-env 已确认实例与全部模块就绪。
//   · 原「服务日志无 ReferenceError/TypeError」断言（原先读自己 spawn 的 stdout/stderr 缓冲）改读 <实例数据根>/server.log：
//     入口 ready 后立即记录文件大小 LOG_OFFSET。扫描窗口：自起实例（env().selfStarted）从文件开头扫（与原「spawn 以来的全部输出」等价）；
//     跑在共享实例（变量组形态）上才只看 LOG_OFFSET 之后新增的部分。数据根取不到（变量组形态下 sdh-instance.json 与实例不一致）、
//     日志文件不存在 / 比记录的偏移还短 → 该断言计失败，不静默通过。
//     [#106 S4c-2] 正向对照：[0, LOG_OFFSET) 里必须有本实例的 `[instance] mode=isolated instance=<身份> ... port=<本实例端口>` 启动行（server.js:22782 的 console.log，
//     不受 LOG_LEVEL 影响），证明读的就是本实例的日志，不满足计失败；info 级日志已开时窗口里还须出现本次建单产生的「建数据修正单 #<id>」（routes/corrections.js:1522），
//     证明窗口在记录本脚本的请求。
//     启动期日志里正常行误命中 /ReferenceError|is not defined|is not a function|TypeError/ 的可能：静态检索 server.js / routes / utils，这几个词只出现在注释和
//     运行期才抛的错误里（如 normalizeSqlDefinition 的入参 TypeError），没有启动期打印的日志文案含它们；启动期若真出现，正是原脚本要抓的注入缺失。
//   · 批跑：写实例库（建单后作废）；实例是本脚本私有的，可与别的隔离实例脚本并行。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const testEnv = require('./lib/test-env');

// ready() 之后在入口里赋值（BASE 相关读取在 ready 之前会抛 TE_NOT_READY）
let TARGET = null;      // new URL(实例 baseUrl)：主机 / 端口
let token = null;       // admin（id=1）token，由 testEnv.signToken 签
let LOG_FILE = null;    // <实例数据根>/server.log，取不到为 null
let LOG_OFFSET = null;  // ready 时刻的日志文件大小（正向对照前缀的终点），取不到为 null
let SCAN_START = 0;     // 日志扫描窗口起点：自起实例 0（从头扫），共享实例 = LOG_OFFSET
let LOG_PROBLEM = null; // 日志定位阶段的问题描述（非 null → 日志断言计失败）

function req(method, p, body, tokenOverride) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: TARGET.hostname, port: Number(TARGET.port), method, path: p,
      headers: { Authorization: 'Bearer ' + (tokenOverride || token), 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}

let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label + ' — ' + detail); fail++; } };

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
 *  正向对照（证明读的就是本实例的日志，而不是别的文件或空文件）：[0, LOG_OFFSET) 里必须有本实例的 `[instance] mode=isolated instance=<身份> ` 启动行，且该行含 port=<本实例端口>。
 *  可选更强项：前缀里已有 `[INFO]` 行（说明 info 级日志是开的）时，窗口里还必须出现 expectLine（本次请求产生的 info 日志，如「建数据修正单 #<id>」），
 *  证明窗口确实在记录本脚本的请求；info 级没开（前缀无 [INFO] 行）时这一项做不到，不检查。 */
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
      return { problem: `正向对照失败：info 级日志已开（前缀有 [INFO] 行），但日志窗口里没有本次请求产生的 ${expectLine}，窗口未在记录本脚本的请求` };
    }
    return { text };
  } catch (e) {
    return { problem: `读取 server.log 失败（${LOG_FILE}）：${e && e.code ? e.code : e.message}` };
  }
}

// 返回失败项数（不在 helper 里 process.exit：由入口在 teardown 之后 finish）
async function main() {
  console.log('=== M-2 端点级 http 冒烟（隔离测试实例 + 实例密钥签 token）===\n');

  // [读] 列表 —— 端点注册 + auth + db 依赖
  const list = await req('GET', '/api/corrections');
  check(list.status === 200, '[读] GET /api/corrections 列表 200（非 500=db/auth 依赖没漏）', `status=${list.status} ${(list.body || '').slice(0, 120)}`);

  let firstId = null;
  try { const j = JSON.parse(list.body || '{}'); const arr = j.data || j.corrections || j.list || j.items || (Array.isArray(j) ? j : []); firstId = arr[0] && arr[0].id; } catch (_) {}

  // [读] 详情 + 已读查询（通知字段映射依赖）—— 用现有单
  if (firstId) {
    const detail = await req('GET', '/api/corrections/' + firstId);
    check(detail.status === 200, `[读] GET 详情 #${firstId} 200`, `status=${detail.status}`);
    const rs = await req('GET', '/api/corrections/' + firstId + '/notify-read-status');
    check(rs.status !== 500, `[读] GET notify-read-status 非 500（CORRECTION_READ_FIELD_MAP 依赖没漏）`, `status=${rs.status} ${(rs.body || '').slice(0, 100)}`);
    // 注：对接人(白名单13)查 dev read-status 非 403（K2-M1 写读同源）放 verify-correction-relay-e2e（那里 seed id=13；e2e-http 不 seed 用户）
  } else {
    console.log('  （库中无现有 correction 单，跳过详情/已读查询读测）');
  }

  // [写] 建单 → 作废清理（correctionStorage/校验/transition/history 依赖）
  const create = await req('POST', '/api/corrections', {
    source_system: 'BMS', location_info: 'E2E 端点冒烟测试单（M-2，测后作废）', requester_name: 'E2E 测试',
    correction_type: 'single', correction_count: 1, reason: 'E2E 端点冒烟测试原因背景',
  });
  check(create.status !== 500, '[写] POST 建单 非 500（建单端点依赖没漏）', `status=${create.status} ${(create.body || '').slice(0, 150)}`);
  let newId = null;
  try { const j = JSON.parse(create.body || '{}'); newId = j.id || (j.data && j.data.id); } catch (_) {}
  // [#106 S4c 送审前小修] 与下面 kb / mp 两块同款：「建单成功（200/201）∧ 有效 id」合为一条必过断言，移到 if 之外（原先在 if 里面，无 id 时静默跳过后续与作废清理），并补 else 显式判红
  check((create.status === 200 || create.status === 201) && Number.isInteger(newId) && newId > 0, `[写] 建单成功且响应含有效 id${newId ? ' #' + newId : ''}`, `status=${create.status} ${(create.body || '').slice(0, 150)}`);
  if (newId) {
    // [写] 细优② notify-creator：PENDING_ASSIGN 不可发 → 409（验证端点挂载 + correctionActor/isCorrectionRelayWhitelisted/sendable 依赖完整，非 500）
    const nc = await req('POST', '/api/corrections/' + newId + '/notify-creator', {});
    check(nc.status !== 500, `[写] POST notify-creator #${newId} 非 500（细优② 端点依赖没漏）`, `status=${nc.status} ${(nc.body || '').slice(0, 120)}`);
    check(nc.status === 409, `[写] notify-creator PENDING_ASSIGN → 409 状态闸门（仅 FIXED/REFIXED 可发）`, `status=${nc.status}`);
    const voidRes = await req('POST', '/api/corrections/' + newId + '/void', { void_reason: 'E2E 冒烟测试清理' });
    // [#106 S4c 收口] 清理动作（作废）失败必须计失败：原先只判「非 500」，void 返 409 / 404 时测试单留在共享实例里却不计失败；
    //   改为与下面两条同款的真实成功契约 200 ∧ { ok:true, status:'VOIDED' }（不改变本条「流转端点依赖没漏」的原意：500 仍判红）
    let voidJson = null; try { voidJson = JSON.parse(voidRes.body || '{}'); } catch (_) {}
    check(voidRes.status === 200 && !!voidJson && voidJson.ok === true && voidJson.status === 'VOIDED', `[写] POST void 作废清理 #${newId} → 200 {ok:true,status:VOIDED}（流转端点依赖没漏·真作废不留测试单）`, `status=${voidRes.status} ${(voidRes.body || '').slice(0, 100)}`);
  } else {
    check(false, `[写] BMS 建单后的 notify-creator 与 void 清理被跳过（建单响应无有效 id=响应结构回归·可能遗留测试单）`, `body=${(create.body || '').slice(0, 200)}`);
  }

  // [写] 所属系统新元素「客户报销平台」端到端建单（2026-08-17 追加·防白名单常量层通过而端点校验/落库漂移）→ 作废清理
  const createKb = await req('POST', '/api/corrections', {
    source_system: '客户报销平台', location_info: 'E2E 新系统名冒烟测试单（测后作废）', requester_name: 'E2E 测试',
    correction_type: 'single', correction_count: 1, reason: 'E2E 客户报销平台建单冒烟原因背景',
  });
  let kbId = null;
  try { const j = JSON.parse(createKb.body || '{}'); kbId = j.id || (j.data && j.data.id); } catch (_) {}
  // [codex 495 M1/M2 按模式收口·既有块同款] 200 ∧ 有效 id 合为一条必过断言（响应结构回归时不得静默跳过后续）；void 钉真实成功契约
  //   { ok:true, status:'VOIDED' }（routes/corrections.js POST /:id/void 成功恒 res.json），不再用「非 500」代表清理成功。
  check(createKb.status === 200 && Number.isInteger(kbId) && kbId > 0, `[写] source_system=客户报销平台 建单成功且响应含有效 id${kbId ? ' #' + kbId : ''}（白名单校验放行）`, `status=${createKb.status} ${(createKb.body || '').slice(0, 150)}`);
  if (kbId) {
    const kbDetail = await req('GET', '/api/corrections/' + kbId);
    check(kbDetail.status === 200 && (kbDetail.body || '').includes('客户报销平台'), `[写] #${kbId} 详情回读 source_system=客户报销平台（落库一致）`, `status=${kbDetail.status}`);
    const kbVoid = await req('POST', '/api/corrections/' + kbId + '/void', { void_reason: 'E2E 新系统名冒烟测试清理' });
    let kbVoidJson = null; try { kbVoidJson = JSON.parse(kbVoid.body || '{}'); } catch (_) {}
    check(kbVoid.status === 200 && !!kbVoidJson && kbVoidJson.ok === true && kbVoidJson.status === 'VOIDED', `[写] POST void 作废清理 #${kbId} → 200 {ok:true,status:VOIDED}（真作废·不留测试单）`, `status=${kbVoid.status} ${(kbVoid.body || '').slice(0, 100)}`);
  } else {
    check(false, `[写] 客户报销平台 详情回读与 void 清理被跳过（建单响应无有效 id=响应结构回归·可能遗留测试单）`, `body=${(createKb.body || '').slice(0, 200)}`);
  }

  // [写] 所属系统第五元素「小程序-智荟人力」端到端建单（2026-09-02 追加·所属系统接入方案 v1.2 §5·同款范式：
  //   防白名单常量层通过而端点校验/落库漂移）→ 作废清理。实现坏成什么样这条会红：routes/corrections.js 漏加
  //   成员（400 INVALID）、或前端副本加了后端没加（本条走真实端点直接暴露）。
  const createMp = await req('POST', '/api/corrections', {
    source_system: '小程序-智荟人力', location_info: 'E2E 新系统名冒烟测试单（测后作废）', requester_name: 'E2E 测试',
    correction_type: 'single', correction_count: 1, reason: 'E2E 小程序-智荟人力建单冒烟原因背景',
  });
  let mpId = null;
  try { const j = JSON.parse(createMp.body || '{}'); mpId = j.id || (j.data && j.data.id); } catch (_) {}
  // [codex 495 M1/M2] 同上：200 ∧ 有效 id 一条必过；无 id 显式判红不静默跳过；void 钉 { ok:true, status:'VOIDED' } 真实成功契约。
  check(createMp.status === 200 && Number.isInteger(mpId) && mpId > 0, `[写] source_system=小程序-智荟人力 建单成功且响应含有效 id${mpId ? ' #' + mpId : ''}（白名单校验放行）`, `status=${createMp.status} ${(createMp.body || '').slice(0, 200)}`);
  if (mpId) {
    const mpDetail = await req('GET', '/api/corrections/' + mpId);
    check(mpDetail.status === 200 && (mpDetail.body || '').includes('小程序-智荟人力'), `[写] #${mpId} 详情回读 source_system=小程序-智荟人力（落库一致·含连字符原样）`, `status=${mpDetail.status}`);
    const mpVoid = await req('POST', '/api/corrections/' + mpId + '/void', { void_reason: 'E2E 新系统名冒烟测试清理' });
    let mpVoidJson = null; try { mpVoidJson = JSON.parse(mpVoid.body || '{}'); } catch (_) {}
    check(mpVoid.status === 200 && !!mpVoidJson && mpVoidJson.ok === true && mpVoidJson.status === 'VOIDED', `[写] POST void 作废清理 #${mpId} → 200 {ok:true,status:VOIDED}（真作废·不留测试单）`, `status=${mpVoid.status} ${(mpVoid.body || '').slice(0, 100)}`);
  } else {
    check(false, `[写] 小程序-智荟人力 详情回读与 void 清理被跳过（建单响应无有效 id=响应结构回归·可能遗留测试单）`, `body=${(createMp.body || '').slice(0, 200)}`);
  }
  // [写·反证] 白名单外系统名仍被端点拒绝（成对断言：放行 ∧ 拒绝——若白名单校验被整体放宽，本条会红）
  const createBad = await req('POST', '/api/corrections', {
    source_system: '不存在的系统-E2E', location_info: 'E2E 反证', requester_name: 'E2E 测试',
    correction_type: 'single', correction_count: 1, reason: 'E2E 白名单外系统名应被拒绝',
  });
  // 钉错误码而非只钉 400：建单校验顺序=OA 号 → 业务方 → 白名单（routes/corrections.js 建单端点），将来在白名单之前插新闸门时
  //   裸 400 会继续绿而失去区分力；只有 code=INVALID_SOURCE_SYSTEM 才证明是白名单在拦（Opus 预筛 S4 P1）。
  let badJson = null; try { badJson = JSON.parse(createBad.body || '{}'); } catch (_) {}
  // [codex 495 L1] 解析 JSON 精确断言 code 字段（子串匹配会被 message/调试文本里的同词假绿）；解析失败也判红
  check(createBad.status === 400 && !!badJson && badJson.code === 'INVALID_SOURCE_SYSTEM', `[写·反证] source_system=白名单外 → 400 且 JSON code===INVALID_SOURCE_SYSTEM（白名单校验仍在且是它在拦）`, `status=${createBad.status} ${(createBad.body || '').slice(0, 120)}`);
  if (createBad.status !== 400) {
    // 反证失败=白名单被整体放宽时该请求会真建一张单——红灯同时不留垃圾单（Opus 预筛 S4 P2）
    let badId = null;
    try { const j = JSON.parse(createBad.body || '{}'); badId = j.id || (j.data && j.data.id); } catch (_) {}
    if (badId) await req('POST', '/api/corrections/' + badId + '/void', { void_reason: 'E2E 反证意外放行清理' });
  }

  // 服务日志断言：扫描窗口见 locateLog（自起实例从头扫，共享实例只看 ready 之后）；日志定位 / 读取失败 / 正向对照不满足 → 计失败，不静默通过
  const nl = readNewLog(kbId ? new RegExp(`建数据修正单 #${kbId}(?!\\d)`) : null);   // 本脚本「客户报销平台」建单产生的 info 日志（正向对照，见 readNewLog；id 后不得再接数字）
  if (nl.problem) {
    check(false, '服务日志无 ReferenceError/TypeError（注入完整）', nl.problem);
  } else {
    const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(nl.text);
    check(!crashed, '服务日志无 ReferenceError/TypeError（注入完整）', crashed ? nl.text.slice(-300) : '');
  }

  console.log(`\n${fail === 0 ? '✅' : '✗'} M-2 端点冒烟：${pass} 通过 / ${fail} 失败`);
  return fail;
}

(async () => {
  // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
  await testEnv.ready();   // 先于任何网络请求 / 读库：自起隔离实例（或核对 TEST_* 变量组）
  let code = 1;
  try {
    TARGET = new URL(testEnv.env().baseUrl);
    locateLog();   // ready 之后立即记录日志偏移（只看之后新增的部分）
    token = await testEnv.signToken(1);   // 读实例库 users 行（id=1 admin）并用实例密钥签 1 小时 token
    const nFailed = await main();
    code = nFailed > 0 ? 1 : 0;
  } catch (e) {
    console.error('✗ e2e 异常：', e && e.message);
  } finally {
    try { await testEnv.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
  }
  testEnv.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
  console.error('correction-e2e-http 启动失败：', e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
