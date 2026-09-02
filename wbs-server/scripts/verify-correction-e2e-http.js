// verify-correction-e2e-http.js — M-2（codex 末次审）端点级 http 冒烟
//   spawn 真实 server.js + JWT 注入 admin token + 请求 correction 关键端点，证明抽 routes 后
//   端点运行期依赖没漏接（漏注入会 500）。覆盖读（列表/详情/已读查询）+ 写（建单→作废清理）。
//   不重测业务逻辑，只验"工厂注入 + 端点依赖在真实 HTTP 路径下完整"。
'use strict';
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, JWT_SECRET, { expiresIn: '1h' });

function req(method, p, body, tokenOverride) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: 'localhost', port: 3000, method, path: p,
      headers: { Authorization: 'Bearer ' + (tokenOverride || token), 'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    r.on('error', e => resolve({ status: 0, error: e.message }));
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitServer(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await req('GET', '/api/version');
    if (v.status === 200) return true;
    await sleep(250);
  }
  throw new Error('服务未在 ' + timeoutMs + 'ms 内就绪');
}

const server = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..') });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

let pass = 0, fail = 0;
const check = (cond, label, detail) => { if (cond) { console.log('  ✓ ' + label); pass++; } else { console.log('  ✗ ' + label + ' — ' + detail); fail++; } };

(async () => {
  console.log('=== M-2 端点级 http 冒烟（真实 server.js + JWT 注入）===\n');
  await waitServer();
  await sleep(800);   // 等 correction readiness（initSchema 在 db 回调）

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
  if (newId) {
    check(create.status === 200 || create.status === 201, `[写] 建单成功 #${newId}`, `status=${create.status}`);
    // [写] 细优② notify-creator：PENDING_ASSIGN 不可发 → 409（验证端点挂载 + correctionActor/isCorrectionRelayWhitelisted/sendable 依赖完整，非 500）
    const nc = await req('POST', '/api/corrections/' + newId + '/notify-creator', {});
    check(nc.status !== 500, `[写] POST notify-creator #${newId} 非 500（细优② 端点依赖没漏）`, `status=${nc.status} ${(nc.body || '').slice(0, 120)}`);
    check(nc.status === 409, `[写] notify-creator PENDING_ASSIGN → 409 状态闸门（仅 FIXED/REFIXED 可发）`, `status=${nc.status}`);
    const voidRes = await req('POST', '/api/corrections/' + newId + '/void', { void_reason: 'E2E 冒烟测试清理' });
    check(voidRes.status !== 500, `[写] POST void 作废清理 #${newId} 非 500（流转端点依赖没漏）`, `status=${voidRes.status} ${(voidRes.body || '').slice(0, 100)}`);
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

  const crashed = /ReferenceError|is not defined|is not a function|TypeError/.test(log);
  check(!crashed, '服务日志无 ReferenceError/TypeError（注入完整）', crashed ? log.slice(-300) : '');

  console.log(`\n${fail === 0 ? '✅' : '✗'} M-2 端点冒烟：${pass} 通过 / ${fail} 失败`);
  server.kill('SIGKILL');
  await sleep(300);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('✗ e2e 异常：', e.message); server.kill('SIGKILL'); process.exit(1); });
