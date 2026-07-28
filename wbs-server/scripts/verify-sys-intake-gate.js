// 验证脚本：系统迭代 角色权限重构 C0 — 焊死受理门（方案 v1.5 §4-C0）
//   用法：node scripts/verify-sys-intake-gate.js
//
// 背景：v1.4 §2.2 认定三条"绕过受理门"的缺口——A 建单可勾选关闭受理、B derive 硬编码 intake=0 直落开发前段、
//   C reactivate 按单据自身 intake_required 分两支落态。C0 把三个创建入口收敛到唯一函数
//   T.resolveSysInitialStatusForCreate(type)（内部固定 intake=1、不收外部参数），并封死 intake_required 参数面。
//
// 覆盖：
//   [I] 创建入口不变量（源码扫描）：routes/ 下 INSERT INTO sys_issues 恰 2 处 + 三入口全部调用统一函数
//       + 创建路径不再直调 resolveInitialStatus（防日后新增入口时"忘了走统一函数"这类静默回归）
//   [C1] 建单三类型 → 恒「待受理」+ 入库 intake_required=1
//   [C2] derive 派生新单 → 恒「待受理」+ **INSERT 显式落 intake_required=1**（原 INSERT 未列该列·靠 DEFAULT 0
//        会造出「待受理 + ir=0」矛盾单 → 受理门不变量拒 409 → 单永久卡死。本组是该回归的专门哨兵）
//   [C3] reactivate（已拒绝 → 初始态）→ 恒「待受理」+ 同事务置 intake_required=1；含 ir=0 脏单可自愈
//   [R] resubmit-intake 契约：原子恢复 intake=1 + status=待受理 + **tech_lead_* 九列整组归零**
//       （只清 id/name 会留下"无负责人却有通知记录"，且旧轮次在途通知回写会靠 request_event_id 命中新轮次）
//   [G] 受理门闭环：待受理 → intake-accept → 待指派/待处理（三类型落态与旧建单落态逐字一致）
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');

const SECRET = 'verify-sys-intake-gate-secret';
const db = new sqlite3.Database(':memory:');
const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const noop = () => {};

// 一次性故障注入（复刻 verify-sys-multidev-members 范式）：证明 C0 新增的 SET 片段与 status 同处一个事务。
//   平时 injectFailureOnSql=null，runFI 行为与 run 完全一致；命中后自动复位并置 fired=true
//   （供断言"确实命中过"，防 SQL 片段写错导致故障从未注入、测试静默失效）。
let injectFailureOnSql = null;
let injectFailureFired = false;
const runFI = (sql, params = []) => {
  if (injectFailureOnSql && sql.includes(injectFailureOnSql)) {
    const marker = injectFailureOnSql;
    injectFailureOnSql = null;
    injectFailureFired = true;
    return Promise.reject(new Error(`[测试注入故障] 命中 SQL 片段「${marker}」`));
  }
  return run(sql, params);
};

const authenticateToken = (req, res, next) => {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!tok) return res.status(401).json({ error: '未登录' });
  try { req.user = jwt.verify(tok, SECRET); next(); }
  catch { return res.status(401).json({ error: 'token 无效' }); }
};
const requireAdmin = (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: '需要 admin' });

async function mockSendIssueDingtalkRaw() { return { ok: true, message_key: 'stub-key' }; }
async function mockGetSafePlatformBaseUrl() { return ''; }

const mod = require('../routes/sys-iteration')({
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  db, dbRunAsync: runFI, dbGetAsync: get, dbAllAsync: all,
  authenticateToken, requireAdmin,
  ...require('./_sys-attach-test-deps'),
  sendIssueDingtalkRaw: mockSendIssueDingtalkRaw,
  getSafePlatformBaseUrl: mockGetSafePlatformBaseUrl,
});
const I = mod._internals;
const T = require('../routes/sys-iteration/transitions');
// C0 受理门触发器测试辅助（造 ir=0 脏夹具时显式摘除·退出必重建）
const gate = require('./lib/sys-intake-gate-triggers')(run, I);

function waitReady() {
  return new Promise((res, rej) => {
    let n = 0;
    const t = setInterval(() => {
      if (I.SYS_SCHEMA_STATE.ready) { clearInterval(t); res(); }
      else if (I.SYS_SCHEMA_STATE.error) { clearInterval(t); rej(new Error(I.SYS_SCHEMA_STATE.error)); }
      else if (++n > 500) { clearInterval(t); rej(new Error('readiness 超时')); }
    }, 10);
  });
}

const adminTok = jwt.sign({ id: 1, username: 'admin', display_name: '管理员', role: 'admin' }, SECRET);
const liaisonTok = jwt.sign({ id: 13, username: 'wangtaotao', display_name: '示例对接人', role: 'user' }, SECRET);
// ⭐ 角色权限重构 C4·184 号预审（PH-2 上线后 [R] 组补的技术负责人 token）：id=7（示例发布者）已在下方 users
//   夹具里，与 verify-sys-tech-lead-comment.js 的 techTok 同一 id，仅本文件此前未声明。
const techTok = jwt.sign({ id: 7, username: 'shenjun', display_name: '示例发布者', role: 'publisher' }, SECRET);

let server, port;
function call(method, p, tok, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: {
      'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }}, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };
// 建单必带契约版本（codex C0 审 HIGH-1）：后端据此识别旧页面，缺失/过旧 → 400 CLIENT_CONTRACT_OUTDATED
const CONTRACT_V = 2;
const create = (extra) => call('POST', '/api/sys-issues', adminTok,
  { intake_contract_version: CONTRACT_V, type: 'feature', title: '测试单', system_name: 'BMS', source: '内部', ...extra });

// tech_lead_* 九列 + relay_* 七列（方案 v1.5 §2.5 + codex C0 审 MED-3：回受理门时两组均须整组归零）
const TECH_LEAD_COLS = ['tech_lead_id', 'tech_lead_name', 'tech_lead_notify_request_event_id', 'tech_lead_notify_status',
  'tech_lead_notified_at', 'tech_lead_notify_message_key', 'tech_lead_read_at', 'tech_lead_notify_error', 'tech_lead_notify_sent_by'];
const RELAY_COLS = ['relay_notified_user_id', 'relay_notified_user_name', 'relay_notify_status',
  'relay_notified_at', 'relay_read_at', 'relay_notify_message_key', 'relay_notify_error'];
// 两组的"已归零"判定：状态列回 'not_sent'（NOT NULL），其余列 NULL
const assertCleared = (row, cols, statusCol, label) => {
  assert.strictEqual(row[statusCol], 'not_sent', `${label}：${statusCol}='not_sent'`);
  for (const c of cols.filter(x => x !== statusCol)) {
    assert.strictEqual(row[c], null, `${label}：${c} = NULL`);
  }
};

async function main() {
  mod.initSchema();
  await waitReady();
  await run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, phone TEXT, dingtalk_user_id TEXT)`);
  await run(`INSERT INTO users (id, username, display_name, role, phone) VALUES
    (1,'admin','管理员','admin','13800000001'),(5,'dev','开发王','user','13800000005'),
    (7,'shenjun','示例发布者','publisher','13800000007'),(13,'wangtaotao','示例对接人','user','13800000013')`);
  const app = express();
  app.use(express.json());
  app.use('/api', mod.router);
  await new Promise(res => { server = app.listen(0, '127.0.0.1', res); });
  port = server.address().port;
  ok('readiness ready + HTTP harness 起服务');

  // ═══ [I] 创建入口不变量（源码扫描·防"新增入口忘走统一函数"静默回归）═══
  {
    // ⚠️ 扫描是**辅助哨兵**不是根本防线（codex C0 审 MED-4）：正则抓不到动态拼接 SQL / 公共仓储函数 /
    //   非 .js 载体。根本防线是「创建落态只能由 T.resolveSysInitialStatusForCreate 给出」+ 迁移归一 + 启动哨兵。
    //   本组的价值在于：**新增创建入口时会立刻红灯**，逼作者显式面对"这个入口是否走了统一函数"。
    //   为降低漏报，扫描范围扩到整个 wbs-server（排除 node_modules/scripts/public），并容忍大小写与空白差异。
    const ROOT = path.join(__dirname, '..');
    const SKIP_DIRS = new Set(['node_modules', 'scripts', 'public', 'uploads', 'data', '.git']);
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap(e => e.isDirectory()
        ? (SKIP_DIRS.has(e.name) ? [] : walk(path.join(d, e.name)))
        : (e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
    const srcs = walk(ROOT).map(f => ({ f, s: fs.readFileSync(f, 'utf8') }));

    // ① 服务端代码里"往 sys_issues 插行"的写法恰 2 处（建单 + derive）——方案 v1.5 §2.4 枚举闭合。
    //   正则容忍：大小写、INSERT OR REPLACE/IGNORE、关键字间任意空白（含换行）。
    const INSERT_RE = /insert\s+(?:or\s+\w+\s+)?into\s+sys_issues/gi;
    const inserts = srcs.flatMap(({ f, s }) => (s.match(INSERT_RE) || []).map(() => path.relative(ROOT, f)));
    assert.strictEqual(inserts.length, 2,
      `服务端代码里 INSERT INTO sys_issues 应恰 2 处（建单+derive），实际 ${inserts.length}：${JSON.stringify(inserts)}。` +
      `新增创建入口必须接入 T.resolveSysInitialStatusForCreate 并显式落 intake_required，然后同步更新本断言与方案 §2.4。`);
    // ②-pre 两处 INSERT 都必须显式列出 intake_required（防"漏列 → 吃 DEFAULT"重新制造矛盾单·codex 审 HIGH-2）
    for (const { f, s } of srcs) {
      const m = s.match(/insert\s+(?:or\s+\w+\s+)?into\s+sys_issues\s*\(([^)]*)\)/gi) || [];
      for (const stmt of m) {
        assert.ok(/intake_required/i.test(stmt),
          `${path.relative(ROOT, f)} 的 INSERT INTO sys_issues 未显式列出 intake_required（会落列 DEFAULT）：${stmt.slice(0, 120)}…`);
      }
    }

    const idx = srcs.find(x => x.f.endsWith(path.join('sys-iteration', 'index.js'))).s;

    // ② 三创建入口全部调用统一函数（建单 / derive / reactivate 的动态落态解析）
    const unifiedCalls = (idx.match(/T\.resolveSysInitialStatusForCreate\(/g) || []).length;
    assert.strictEqual(unifiedCalls, 3, `index.js 应恰 3 处调用 resolveSysInitialStatusForCreate（建单/derive/reactivate），实际 ${unifiedCalls}`);

    // ③ ⭐ index.js **完全不再直调** resolveInitialStatus（原 2 处属 change_intake_mode 的开/关目标态解析，
    //   随该端点实现体删除而消失·codex 审 MED-1）。落态解析的唯一对外入口就是统一函数——
    //   任何"想按 intake 标志分两支落态"的新代码都会让本断言红灯。
    const legacyCalls = (idx.match(/T\.resolveInitialStatus\(/g) || []).length;
    assert.strictEqual(legacyCalls, 0,
      `index.js 不应再直调 resolveInitialStatus（落态只能经 resolveSysInitialStatusForCreate），实际 ${legacyCalls} 处`);

    // ④ 统一函数确实不接受外部 intake 参数（形参数为 0 或仅 type）——防日后被"顺手加个参数"重新打开后门
    assert.strictEqual(T.resolveSysInitialStatusForCreate.length, 1, 'resolveSysInitialStatusForCreate 应只接受 type 一个形参（不得开放 intake 参数）');
    // ⭐ 角色权限重构 C2.5 撤销（v2.1 §5）：落态**全类型归一「待受理」**——预沟通段/PRE_DISCUSS 族整体撤销，
    //   建单/derive/reactivate 三入口统一收敛为恰一个目标值，不再按 type 分流。C0 焊死的「不受调用方影响」
    //   （函数不收 intake 参数、三入口只能调它）不变，只是分流表退化为单值表。
    const EXPECT_CREATE_STATUS = { feature: '待受理', improvement: '待受理', bug: '待受理' };
    for (const t of ['feature', 'improvement', 'bug']) {
      assert.strictEqual(T.resolveSysInitialStatusForCreate(t), EXPECT_CREATE_STATUS[t],
        `${t} 统一函数落态应为「${EXPECT_CREATE_STATUS[t]}」（v2.1：C2.5 撤销后全类型归一待受理）`);
    }
    // ⭐ 撤销哨兵（v2.1 §7"可执行状态引用必须删"）：PRE_DISCUSS 相关导出不应再被生产代码使用。
    //   ⚠️ 待主会话确认：若 transitions.js 物理删除了这两个导出，下两行访问不存在的属性本身即为
    //   undefined（断言仍成立）；若改为保留导出但清空内容，同样成立。两种实现路径本组均覆盖。
    assert.strictEqual(T.SYS_PRE_DISCUSS_TYPES, undefined, 'SYS_PRE_DISCUSS_TYPES 应已随 C2.5 撤销被删除（不得残留可执行状态引用）');
    assert.strictEqual(T.SYS_PRE_DISCUSS_STATUS, undefined, 'SYS_PRE_DISCUSS_STATUS 应已随 C2.5 撤销被删除（不得残留可执行状态引用）');
    assert.throws(() => T.resolveSysInitialStatusForCreate('unknown_type'), /未知\/未登记 type/, '未知 type fail-closed 抛错（不静默落态）');
    // ⭐ config **不参与受理流**（codex 九轮审 HIGH）：它没有 transitions，若能建单就会产生
    //   「config/待受理」这种**无受理转换可走**的卡死单。这里用三条断言把"已被拒绝"钉死，
    //   而不是只靠注释声明"不适用"。
    assert.ok(!T.ALLOWED_STATUSES.config, 'config 不在 ALLOWED_STATUSES（无合法状态集）');
    assert.ok(!T.TRANSITIONS.config, 'config 不在 TRANSITIONS（无状态机）');
    assert.throws(() => T.resolveSysInitialStatusForCreate('config'), /未知\/未登记 type/,
      'config 落态解析 fail-closed 抛错（不会产生 config/待受理 卡死单）');
    ok('[I] 创建入口不变量：服务端 INSERT INTO sys_issues 恰 2 处且均显式列出 intake_required + index.js 统一函数调用恰 3 处 + 不再直调 resolveInitialStatus(0 处) + 统一函数单形参/落态全类型归一待受理(v2.1 撤销分流) + PRE_DISCUSS 导出撤销哨兵 + 未知 type 与 config fail-closed');
  }

  // ═══ [C1] 建单三类型 → 落态全类型归一「待受理」（C2.5 撤销后）+ 入库 intake_required=1 恒成立（C0 不变量）═══
  //   ⭐ 角色权限重构 C2.5 撤销（v2.1）：预沟通段整体撤销后，三类型建单统一落「待受理」；
  //     intake_required 恒 1 这条 C0 不变量不受影响，受理门（DB 触发器只判 intake_required·与 status 无关）
  //     对三条路径**同样必经**。
  {
    const EXPECT_CREATE_STATUS = { feature: '待受理', improvement: '待受理', bug: '待受理' };
    for (const type of ['feature', 'improvement', 'bug']) {
      const r = await create({ type });
      assert.strictEqual(r.status, 201, `${type} 建单 201, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, EXPECT_CREATE_STATUS[type], `${type} 建单响应 status=${EXPECT_CREATE_STATUS[type]}`);
      const row = await get('SELECT status, intake_required FROM sys_issues WHERE id=?', [r.body.id]);
      assert.strictEqual(row.status, EXPECT_CREATE_STATUS[type], `${type} 落库 status=${EXPECT_CREATE_STATUS[type]}`);
      assert.strictEqual(row.intake_required, 1, `${type} 落库 intake_required=1`);
    }
    // ⭐ config 建单端到端被拒（承 [I] 的常量层断言·这里证 HTTP 入口同样拒绝）
    const rc = await create({ type: 'config' });
    assert.strictEqual(rc.status, 400, `config 建单应 400, got ${rc.status} ${JSON.stringify(rc.body)}`);
    assert.strictEqual(rc.body.code, 'TYPE_NOT_SUPPORTED', 'config 建单 code=TYPE_NOT_SUPPORTED（无受理流·不可能产生卡死单）');

    // 参数面封死（与 c10 [A2] 同源·此处只取代表值做冒烟，避免重复覆盖）
    const rj = await create({ intake_required: 0 });
    assert.strictEqual(rj.status, 400, 'intake_required=0 → 400');
    assert.strictEqual(rj.body.code, 'INTAKE_REQUIRED_FIXED', 'code=INTAKE_REQUIRED_FIXED');

    // ⭐ 客户端契约版本闸（codex C0 审 HIGH-1）：旧页面**取消勾选**时不传 intake_required，请求体与新版逐字相同，
    //   只能靠契约版本区分。缺失/过旧一律 400，且必须**早于** INTAKE_REQUIRED_FIXED 判定（旧页面勾选时两条都命中，
    //   应给"请刷新页面"这个可执行动作，而不是"参数已废弃"这个用户无从下手的提示）。
    const base = { type: 'feature', title: '旧页面模拟', system_name: 'BMS', source: '内部' };
    for (const [label, extra] of [
      ['旧页面·取消勾选（整个省略 intake_required）', {}],
      ['旧页面·勾选（传 intake_required=1）', { intake_required: 1 }],
      ['契约版本过旧', { intake_contract_version: 1 }],
      ['契约版本非法', { intake_contract_version: 'x' }],
    ]) {
      const r = await call('POST', '/api/sys-issues', adminTok, { ...base, ...extra });
      assert.strictEqual(r.status, 400, `${label} → 400, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.code, 'CLIENT_CONTRACT_OUTDATED', `${label} code=CLIENT_CONTRACT_OUTDATED（不是 INTAKE_REQUIRED_FIXED——契约闸在前）`);
      assert.strictEqual(r.body.expected_contract_version, CONTRACT_V, `${label} 响应回传期望契约版本（便于前端自检）`);
      assert.ok(/刷新/.test(r.body.error), `${label} 文案给出可执行动作（强制刷新）`);
    }
    // 零副作用：四次被拒均未建单
    const cnt = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE title='旧页面模拟'`)).c;
    assert.strictEqual(cnt, 0, '契约闸拒绝时不建单（守卫早于 INSERT）');
    ok('[C1] 建单三类型落态全类型归一待受理（v2.1：C2.5 撤销）+ 入库 ir=1 恒成立（C0 不变量）；intake_required 传值 400 FIXED；⭐ 契约版本缺失/过旧/非法一律 400 CLIENT_CONTRACT_OUTDATED（含"旧页面取消勾选"这一静默改义缺口）+ 零副作用');
  }

  // ═══ [C2] derive 派生新单：落态全类型归一「待受理」（C2.5 撤销）+ INSERT 显式落 intake_required=1（矛盾单哨兵）═══
  //   ⭐ 角色权限重构 C2.5 撤销（v2.1）：预沟通段整体撤销，派生出的变更流新单同建单一样直落「待受理」，
  //     不再需要 pre-discuss-pass 中转。表驱动直测三类型，把落态本身钉死。
  {
    // 造一张「已上线」bug 原单（derive 的 bug 分支要求 origin.status='已上线'）
    const ins = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('bug','已上线','P2','派生原单','BMS','内部',1,1,'管理员','native')`);
    const originId = ins.lastID;
    // 派生落态期望表（与建单同源：都走 resolveSysInitialStatusForCreate）+ 受理后落态
    const DERIVE_EXPECT = {
      bug:         { create: '待受理', afterIntake: '待处理' },
      feature:     { create: '待受理', afterIntake: '待指派' },
      improvement: { create: '待受理', afterIntake: '待指派' },
    };
    for (const [type, want] of Object.entries(DERIVE_EXPECT)) {
      const r = await call('POST', `/api/sys-issues/${originId}/derive`, adminTok,
        { type, title: `派生新单-${type}`, system_name: 'BMS', source: '内部', derive_reason: '同源复现' });
      assert.strictEqual(r.status, 201, `${type} derive 201, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.status, want.create, `${type} derive 新单落「${want.create}」（响应体）`);
      const row = await get('SELECT type, status, intake_required, oa_number, origin_issue_id FROM sys_issues WHERE id=?', [r.body.id]);
      // ⚠️ type 必须一并断言（codex Round-D 审 LOW）：feature 与 improvement 的状态路径逐字相同，
      //   improvement 被错存成 feature 时，只看 status 的断言会全绿。
      assert.strictEqual(row.type, type, `${type} derive 新单落库 type 应为 ${type}（实际 ${row.type}）`);
      assert.strictEqual(row.origin_issue_id, originId, `${type} derive 新单 origin_issue_id 应指回原单 ${originId}`);
      assert.strictEqual(row.status, want.create, `${type} derive 新单落「${want.create}」（落库）`);
      assert.strictEqual(row.intake_required, 1, `⭐ ${type} derive INSERT 显式落 intake_required=1（列 DEFAULT 0·漏列会造矛盾单）`);
      assert.strictEqual(row.oa_number, null, `${type} derive 新单 oa_number 为 NULL（派生单同样尚未走 OA）`);
      // 矛盾单哨兵：派生单必须真能被受理（若 ir=0 会被受理门不变量 409 卡死）
      const acc = await call('POST', `/api/sys-issues/${r.body.id}/intake-accept`, liaisonTok, {});
      assert.strictEqual(acc.status, 200, `${type} 派生单可被受理 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
      assert.strictEqual(acc.body.status, want.afterIntake, `${type} 派生单受理后 → ${want.afterIntake}`);
    }
    ok('[C2] derive 三类型落态全类型归一待受理（v2.1：C2.5 撤销）+ INSERT 显式 intake_required=1 + oa_number NULL + 均可走完前段（矛盾单「受理态+ir0」不会产生）');
  }

  // ═══ [C3] reactivate → 恒回受理门 + 同事务置 intake_required=1（含 ir=0 脏单自愈）═══
  {
    for (const [label, dirtyIr] of [['正常单', 1], ['ir=0 脏单', 0]]) {
      // 一并埋上一轮的咨询/转派痕迹（tech_lead_* + relay_*），验证回受理门时整组清空（codex 审 MED-3）
      // ir=0 是 C0 后的非法态，DB 触发器会拒——造这类脏夹具必须显式摘约束（见 lib/sys-intake-gate-triggers 说明）
      const ins = await gate.withoutTriggers(() => run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required,
          tech_lead_id, tech_lead_name, tech_lead_notify_status, tech_lead_notified_at, tech_lead_notify_sent_by,
          relay_notified_user_id, relay_notified_user_name, relay_notify_status, relay_notified_at,
          created_by, created_by_name, record_source)
        VALUES ('feature','已拒绝','P2',?,'BMS','内部',?, 7,'示例发布者','sent','2026-07-01 10:00',1,
          13,'示例对接人','sent','2026-07-01 10:00', 1,'管理员','native')`, [`reactivate-${label}`, dirtyIr]));
      const id = ins.lastID;
      const r = await call('POST', `/api/sys-issues/${id}/reactivate`, adminTok, { reason: '重新考虑' });
      assert.strictEqual(r.status, 200, `${label} reactivate 200, got ${r.status} ${JSON.stringify(r.body)}`);
      // ⭐ 角色权限重构 C2.5 撤销（v2.1）：**变更流复活恒回「待受理」**（预沟通段整体撤销，走同一个
      //   resolveSysInitialStatusForCreate）。C0 的关键性质没变：落态由创建路径唯一入口决定、
      //   **不按单据自身 ir 分两支**（v1.4 §2.2-C 的缺口仍堵着）。
      assert.strictEqual(r.body.status, '待受理', `${label} reactivate 落 待受理（v2.1：C2.5 撤销·仍不按单据 ir 分支）`);
      const row = await get(`SELECT status, intake_required, ${TECH_LEAD_COLS.join(',')}, ${RELAY_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
      assert.strictEqual(row.intake_required, 1, `${label} reactivate 同事务置 intake_required=1`);
      assertCleared(row, TECH_LEAD_COLS, 'tech_lead_notify_status', `${label} reactivate 清 tech_lead_*`);
      assertCleared(row, RELAY_COLS, 'relay_notify_status', `${label} reactivate 清 relay_*`);
      // 自愈证明：恢复后能真正走完前段（ir=0 脏单若不置 1 会在受理那步 409）
      const acc = await call('POST', `/api/sys-issues/${id}/intake-accept`, liaisonTok, {});
      assert.strictEqual(acc.status, 200, `${label} 恢复后可被受理 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
    }
    ok('[C3] reactivate 变更流恒回「待受理」（v2.1：C2.5 撤销）+ 同事务 intake_required=1 + tech_lead_*九列/relay_*七列 整组清空（ir=0 脏单自愈·恢复后可直接受理）');
  }

  // ═══ [R] resubmit-intake：原子恢复 + tech_lead_* 九列整组归零 ═══
  //   ⭐ 角色权限重构 v2.1（clearPendingConsultOnLeave 覆盖面扩至 intake_return）：本组咨询夹具补了一次
  //   tech-lead-comment 真实回复（见下方前置调用注释）——"未回复轮会被 intake_return 自动清"是 v2.1
  //   新增的合法行为，不是本组要测的东西；补上回复后这轮变成"已回复"（自动清对已回复轮次是 no-op），
  //   [R] 组才能继续验证它原本关心的"resubmit-intake 才是唯一清空点"这条不变量。
  {
    const c = await create({ type: 'feature' });
    const id = c.body.id;
    // ⭐ 角色权限重构 C2.5 撤销（v2.1 §2）：request-tech-consult 的开放态谓词全类型统一为「待受理」，
    //   建单落态已直接就是「待受理」，无需再经中转即可发起咨询。
    const rq = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    assert.strictEqual(rq.status, 200, `request-tech-consult 200, got ${rq.status} ${JSON.stringify(rq.body)}`);
    // ⭐ 角色权限重构 v2.1 §2（clearPendingConsultOnLeave 自动清覆盖面扩至 intake_return）：本组要走
    //   intake-return 验证"tech_lead_* 随单一路存续、不因中途状态流转被提前清空"——但 v2.1 起
    //   intake_return 边会**自动清空"未回复"的咨询**（本组下方原本从未提交过意见）。
    //   若不补一次 tech-lead-comment 回复，intake-return 会把 tech_lead_* 九列直接清空，[R] 组原本
    //   要验证的"存续"这件事根本无从谈起（这是新增的合法行为，非提前清空的回归 bug）。补一条真实回复，
    //   让这一轮变成"已回复"（明文口径：已回复的轮次是历史，不清不留痕），[R] 组原本关心的
    //   "resubmit-intake 才是唯一清空点、中途步骤不提前清"这条不变量才继续成立
    //   （自动清对已回复轮次是 no-op，不会干扰这条不变量）。
    // ⭐ 186 号 HIGH（轮次围栏）：tech-lead-comment 新增必填 expected_request_event_id——取上一步
    //   request-tech-consult 刚写入的当前轮 id（本组测的是"字段存续"不是围栏本身，取当前轮即保持原语义）。
    const roundEv = (await get('SELECT tech_lead_notify_request_event_id AS ev FROM sys_issues WHERE id=?', [id])).ev;
    const commentR = await call('POST', `/api/sys-issues/${id}/tech-lead-comment`, techTok,
      { comment: '[R]组前置：技术负责人已回复的意见（防 intake-return 自动清清空）', expected_request_event_id: roundEv });
    assert.strictEqual(commentR.status, 200, `[R] 组前置：技术负责人回复应 200, got ${commentR.status} ${JSON.stringify(commentR.body)}`);
    // ⭐ codex Round-C 审 MED（采纳·升级为真九列）：request-tech-consult 成功后 tech_lead_notify_error /
    //   tech_lead_read_at 两列本就是 NULL（v2.1 起 not_sent 场景恒无失败、尚未有人读）——Round-B 曾因此
    //   把它俩从中间态比对里豁免。这里改用原子 SQL 给这两列注入合法格式的哨兵值（error 用可辨识文本；
    //   read_at 用合法时间串），让下面的比对能覆盖全九列，不再豁免任何一列（这两列与
    //   tech_lead_notify_status='not_sent' 同时存在在真实业务里不会发生，但本组关心的是"中间步骤有没有
    //   提前清空"，不是业务语义完整性，注入哨兵值只是为了让这两列也有非空前值可比）。
    await run(`UPDATE sys_issues SET tech_lead_notify_error=?, tech_lead_read_at=? WHERE id=?`,
      ['SENTINEL-error-占位', '2020-06-01 00:00:00', id]);
    const before = await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
    assert.strictEqual(Number(before.tech_lead_id), 7, '前置：tech_lead_id=7 已写入');
    assert.ok(before.tech_lead_notify_request_event_id > 0, '前置：request_event_id 已写入（版本围栏依赖它）');
    // ⭐ 角色权限重构 v2.1 §6（S5 通知手动化）：request-tech-consult 不再自动发钉钉，首发响应/落库恒 not_sent。
    assert.strictEqual(before.tech_lead_notify_status, 'not_sent', '前置：通知态 not_sent（S5：首发不再自动发送）');

    // ⭐ codex Round-B 审 HIGH（采纳）：补中间态存续断言——原实现只在"request 之后"和"resubmit 之后"两点
    //   各拍一张快照，中间的 intake-return 步骤完全没读过 tech_lead_* 列（v2.1：原先另一个中间检查点
    //   pre-discuss-pass 随 C2.5 撤销一并删除，此处只剩 intake-return 一步）。这意味着，
    //   哪怕这一步"提前"误清了这些列（例如未来有人把 tech_lead 清理逻辑错挂到 intake_return 上而不判断
    //   是否已回复），本组照样绿——因为最终态"resubmit 后九列全空"这个断言分不清"是 resubmit 清的"还是
    //   "更早就被清了、resubmit 只是在一片已经是空的地上又清了一遍"。故在 intake-return 之后补一次
    //   读取，逐列比对与 request 后的快照一致。
    //   ⭐ codex Round-C 审 MED（采纳）：比对列从"七列非空子集"升级为**全九列**（TECH_LEAD_COLS）——
    //   上方已给 error/read_at 注入哨兵值，不再需要豁免它们。
    const assertTechLeadUnchanged = (row, label) => {
      for (const col of TECH_LEAD_COLS) {
        assert.strictEqual(row[col], before[col], `[R] ${label}：${col} 与 request 后快照一致（中间步骤未提前清空）`);
      }
    };

    // 受理退改 → 待修改
    const ret = await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '材料不全' });
    assert.strictEqual(ret.status, 200, `intake-return 200, got ${ret.status} ${JSON.stringify(ret.body)}`);
    assert.strictEqual((await get('SELECT status FROM sys_issues WHERE id=?', [id])).status, '待修改', '退改后 待修改');
    assertTechLeadUnchanged(await get(`SELECT ${TECH_LEAD_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]), 'intake-return 之后');

    // 建单人（admin=created_by）重新提交
    const re = await call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {});
    assert.strictEqual(re.status, 200, `resubmit-intake 200, got ${re.status} ${JSON.stringify(re.body)}`);
    const after = await get(`SELECT status, intake_required, ${TECH_LEAD_COLS.join(',')}, ${RELAY_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
    assert.strictEqual(after.status, '待受理', 'resubmit → 待受理');
    assert.strictEqual(after.intake_required, 1, 'resubmit 原子恢复 intake_required=1');
    // ⭐ 两组整组归零：状态列回 'not_sent'，其余列 NULL
    assertCleared(after, TECH_LEAD_COLS, 'tech_lead_notify_status', 'resubmit 归零 tech_lead_*（只清 id/name 会留跨轮次污染与展示面矛盾）');
    assertCleared(after, RELAY_COLS, 'relay_notify_status', 'resubmit 归零 relay_*（轮次状态不跨轮继承·codex 审 MED-3）');
    // 退回原因留在 timeline（留痕不清）
    const tl = await get(`SELECT summary FROM sys_issue_timeline WHERE issue_id=? AND action_code='intake_return' ORDER BY id DESC LIMIT 1`, [id]);
    assert.ok(tl && /材料不全/.test(tl.summary), 'resubmit 不清退回原因（timeline 留痕保留）');
    ok('[R] resubmit-intake：status=待受理 + intake_required=1 + tech_lead_* 九列 + relay_* 七列 两组整组归零 + 退回原因 timeline 留痕不清');
  }

  // ═══ [ATOM] 原子性直证（codex C0 审 MED-5）：注入 timeline 写入失败 → 新增 SET 片段与 status 一并回滚 ═══
  //   ⭐ codex Round-D 审 LOW（声称收窄）：本组能证明的是"全部字段与 status 在**同一事务**内原子回滚"——
  //   证明不了"同一条 UPDATE / 非分两次写"（两条 UPDATE 在同一事务里回滚结果与一条无异）；后者是代码审查
  //   结论非测试结论。另：哨兵值（900001 等虚构 ID）只满足字段格式不满足引用完整性——当前 schema 无外键
  //   约束故可用；若未来启用外键/跨字段触发器，本夹具会在进入被测路径前**显式失败**（红灯非假绿），届时换真实 ID 即可。
  //   ⭐ codex Round-B 审 HIGH：① request-tech-consult 调用补 200 断言 ② 发现原实现从没验证过 beforeRow
  //   里"预期该非空"的列真的非空——若某处代码回归把这些列错误地清成了 NULL，"逐列比对 afterRow===beforeRow"
  //   依然全绿（NULL===NULL），本组就失去了它号称要验的"原子性"证明力。Round-B 当时按各场景真实产生路径
  //   声明了一份"理应非空"的子集，但那只覆盖了"碰巧非空"的列。
  //   ⭐ codex Round-C 审 HIGH（采纳·彻底消灭 NULL 对 NULL 假绿面）：reactivate 与 resubmit_intake 两个
  //   端点的 case 分支都 push 了同一个 SYS_BACK_TO_INTAKE_GATE_SQL（intake-gate-sql.js），它的 SET 片段
  //   覆盖 tech_lead_* 全部九列 + relay_* 全部七列——不管这两个场景各自的"真实产生路径"是否恰好把每一列
  //   都填上了值（resubmit_intake 场景从未触达 relay_*，reactivate 的夹具 INSERT 也只显式赋值了其中几列），
  //   guarded UPDATE 的 SET 子句都会尝试清空全部十六列。故本组不再依赖"场景恰好产生了哪些非空列"，
  //   而是在注入故障前，用原子 SQL 把全部十六列**统一写成合法可辨识的哨兵值**（不是场景自然产生的值，
  //   是本组专门指定、一眼可辨"这是测试写的"的值）——这样无论该列在真实业务流程里是否会被填充，
  //   故障后的逐列比对都具备真实归因力：afterRow[col] === beforeRow[col] 证明的是"这一列的 SET 片段
  //   确实和 status 在同一个回滚的事务里"，不再可能是"两边都是 NULL"的巧合。
  {
    // 十六列统一哨兵值（notify_status 类用 DB 认可的合法枚举值 'failed'；时间列用可辨识的哨兵时间串；
    // 文本列用带 SENTINEL 前缀的字符串；id 类用不会与真实白名单用户冲突的大数字）——按 SYS_BACK_TO_INTAKE_GATE_SQL
    // 实际清理的字段清单来（intake-gate-sql.js：SYS_CLEAR_TECH_LEAD_FIELDS_SQL 九列 + SYS_CLEAR_RELAY_FIELDS_SQL 七列）。
    const TECH_LEAD_SENTINELS = {
      tech_lead_id: 900001, tech_lead_name: 'SENTINEL-技术负责人',
      tech_lead_notify_request_event_id: 900002, tech_lead_notify_status: 'failed',
      tech_lead_notified_at: '2020-01-01 00:00:01', tech_lead_notify_message_key: 'SENTINEL-msgkey-techlead',
      tech_lead_read_at: '2020-01-01 00:00:02', tech_lead_notify_error: 'SENTINEL-error-techlead',
      tech_lead_notify_sent_by: 900003,
    };
    const RELAY_SENTINELS = {
      relay_notified_user_id: 900004, relay_notified_user_name: 'SENTINEL-对接人',
      relay_notify_status: 'failed', relay_notified_at: '2020-01-01 00:00:03',
      relay_read_at: '2020-01-01 00:00:04', relay_notify_message_key: 'SENTINEL-msgkey-relay',
      relay_notify_error: 'SENTINEL-error-relay',
    };
    const ALL_SENTINEL_COLS = [...TECH_LEAD_COLS, ...RELAY_COLS];
    const ALL_SENTINELS = { ...TECH_LEAD_SENTINELS, ...RELAY_SENTINELS };
    for (const scene of ['reactivate', 'resubmit_intake']) {
      let id;
      if (scene === 'reactivate') {
        // ir=0 脏夹具 → 显式摘约束（同 [C3]）；INSERT 本身的 tech_lead_*/relay_* 赋值仅用于建立"合法存在"的
        // 起点，随后统一被下方的哨兵注入覆盖，故此处不必逐列齐全。
        const ins = await gate.withoutTriggers(() => run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required,
            tech_lead_id, tech_lead_name, tech_lead_notify_status, relay_notified_user_id, relay_notify_status,
            created_by, created_by_name, record_source)
          VALUES ('feature','已拒绝','P2','原子性-reactivate','BMS','内部',0, 7,'示例发布者','sent', 13,'sent', 1,'管理员','native')`));
        id = ins.lastID;
      } else {
        const c = await create({ type: 'feature', title: '原子性-resubmit' });
        id = c.body.id;
        // ⭐ 角色权限重构 v2.1（C2.5 撤销）：request_tech_consult 的开放态谓词全类型统一为「待受理」——
        //   建单落态已直接就是「待受理」，直接发起咨询即可进入"发起咨询→受理退改→重提"这条受理门内剧本
        //   （无需再经预沟通中转）。
        // ⭐ codex Round-B 审 HIGH（采纳）：补 200 断言（此前调用了但从不检查结果，静默失败会被后续
        //   快照掩盖）。
        const rq = await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
        assert.strictEqual(rq.status, 200, `[ATOM] 夹具 request-tech-consult 200, got ${rq.status} ${JSON.stringify(rq.body)}`);
        await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '补材料' });
      }

      // ⭐ codex Round-C 审 HIGH（采纳）：注入故障前，用原子 SQL 把十六列**全部**覆盖成哨兵值——不依赖
      // 场景自然产生的值恰好覆盖哪些列（resubmit_intake 场景从不触达 relay_*，此处也照样把它写上哨兵值，
      // 因为 guarded UPDATE 的 SET 子句本就会尝试清它，必须证明"清它"这个动作也参与了同一次回滚）。
      // ⚠️ reactivate 场景的夹具故意 ir=0（脏单）：受理门触发器对**任何** UPDATE 都按结果值校验
      // intake_required（不只是显式改它的 UPDATE），故这条纯改 tech_lead_*/relay_* 的哨兵注入也要
      // 摘除触发器（同 INSERT 夹具一样的理由），否则会被 C0 焊死的触发器拦下——这不是本组要测的东西。
      const sentinelSets = ALL_SENTINEL_COLS.map(c => `${c} = ?`).join(', ');
      const sentinelParams = [...ALL_SENTINEL_COLS.map(c => ALL_SENTINELS[c]), id];
      await gate.withoutTriggers(() => run(`UPDATE sys_issues SET ${sentinelSets} WHERE id=?`, sentinelParams));
      const beforeRow = await get(`SELECT status, intake_required, ${TECH_LEAD_COLS.join(',')}, ${RELAY_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
      // 哨兵写入自证：全部十六列都应等于哨兵值（不是"非空"这种弱断言，而是精确匹配预期哨兵，
      // 防哨兵 UPDATE 本身的列名/参数对不齐却静默通过）。
      for (const col of ALL_SENTINEL_COLS) {
        assert.strictEqual(beforeRow[col], ALL_SENTINELS[col], `[ATOM/${scene}] 哨兵注入自证：${col} 应等于哨兵值 ${ALL_SENTINELS[col]}，实际 ${beforeRow[col]}`);
      }

      injectFailureFired = false;
      injectFailureOnSql = 'INSERT INTO sys_issue_timeline';   // 状态 UPDATE 之后、COMMIT 之前
      const ep = scene === 'reactivate' ? 'reactivate' : 'resubmit-intake';
      const body = scene === 'reactivate' ? { reason: '重新考虑' } : {};
      const r = await call('POST', `/api/sys-issues/${id}/${ep}`, adminTok, body);
      assert.strictEqual(r.status, 500, `[ATOM/${scene}] 注入故障应 500, got ${r.status} ${JSON.stringify(r.body)}`);
      assert.ok(injectFailureFired, `[ATOM/${scene}] 确认故障真实命中（防 SQL 片段写错致测试静默失效）`);
      injectFailureOnSql = null; injectFailureFired = false;

      const afterRow = await get(`SELECT status, intake_required, ${TECH_LEAD_COLS.join(',')}, ${RELAY_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
      for (const col of ['status', 'intake_required', ...TECH_LEAD_COLS, ...RELAY_COLS]) {
        assert.strictEqual(afterRow[col], beforeRow[col],
          `[ATOM/${scene}] ${col} 随事务整体回滚到哨兵值（与 status 同一事务原子回滚·非 NULL 对 NULL 假绿——"同一条 UPDATE"属代码审查结论，见组头 Round-D 收窄注）`);
      }
    }
    ok('[ATOM] 原子性直证：reactivate / resubmit 在 timeline 写入失败时，status + intake_required + tech_lead_*九列 + relay_*七列 **全部十六列**（注入前统一写为合法可辨识哨兵值）回滚到哨兵值（证明同一事务·非顺序多次写·彻底消灭 NULL 对 NULL 假绿面）');
  }

  // ═══ [CC] 并发 CAS（codex C0 审 MED-5）：并发两次 resubmit → 恰一成功，另一个按既有乐观锁拒绝 ═══
  {
    const c = await create({ type: 'feature', title: '并发-resubmit' });
    const id = c.body.id;
    // ⭐ v2.1（C2.5 撤销）：建单落态已直接是「待受理」，无需预沟通中转即可发起咨询。
    await call('POST', `/api/sys-issues/${id}/request-tech-consult`, liaisonTok, { tech_lead_id: 7 });
    await call('POST', `/api/sys-issues/${id}/intake-return`, liaisonTok, { reason: '补材料' });

    const [r1, r2] = await Promise.all([
      call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {}),
      call('POST', `/api/sys-issues/${id}/resubmit-intake`, adminTok, {}),
    ]);
    const oks = [r1, r2].filter(x => x.status === 200);
    assert.strictEqual(oks.length, 1, `并发 resubmit 应恰 1 个 200，实际 ${JSON.stringify([r1.status, r2.status])} ${JSON.stringify([r1.body, r2.body])}`);
    const loser = [r1, r2].find(x => x.status !== 200);
    assert.ok(loser.status === 400 || loser.status === 409,
      `败方应是明确的业务拒绝（400 INVALID_TRANSITION / 409 并发冲突），实际 ${loser.status} ${JSON.stringify(loser.body)}`);
    assert.notStrictEqual(loser.status, 500, '败方不得是 500（并发不能退化成未处理异常）');
    // 终态一致 + 只落一条 resubmit timeline（不因并发写两条）
    const row = await get(`SELECT status, intake_required, ${TECH_LEAD_COLS.join(',')}, ${RELAY_COLS.join(',')} FROM sys_issues WHERE id=?`, [id]);
    assert.strictEqual(row.status, '待受理', '并发后终态 待受理');
    assert.strictEqual(row.intake_required, 1, '并发后 intake_required=1');
    assertCleared(row, TECH_LEAD_COLS, 'tech_lead_notify_status', '并发后 tech_lead_* 归零');
    assertCleared(row, RELAY_COLS, 'relay_notify_status', '并发后 relay_* 归零');
    const tlCnt = (await get(`SELECT COUNT(*) c FROM sys_issue_timeline WHERE issue_id=? AND action_code='resubmit_intake'`, [id])).c;
    assert.strictEqual(tlCnt, 1, `并发 resubmit 只落 1 条 timeline，实际 ${tlCnt}`);
    ok('[CC] 并发 CAS：两个并发 resubmit 恰 1 个 200、败方明确拒绝（非 500）+ 终态字段一致 + resubmit timeline 恰 1 条');
  }

  // ═══ [G] 受理门闭环：受理后落态与旧建单落态逐字一致 ═══
  {
    for (const [type, want] of [['feature', '待指派'], ['improvement', '待指派'], ['bug', '待处理']]) {
      const c = await create({ type });
      // ⭐ v2.1（C2.5 撤销）：三类型建单均直落「待受理」，受理门是唯一必经关口，无需预沟通中转。
      const acc = await call('POST', `/api/sys-issues/${c.body.id}/intake-accept`, liaisonTok, {});
      assert.strictEqual(acc.status, 200, `${type} 受理 200, got ${acc.status} ${JSON.stringify(acc.body)}`);
      assert.strictEqual(acc.body.status, want, `${type} 受理通过 → ${want}（与 C0 前建单落态逐字一致）`);
    }
    ok('[G] 受理门闭环：三类型 受理通过 → 待指派/待指派/待处理（与 C0 前建单落态一致·下游流程零改动）');
  }

  // ═══ [SCOPE] 契约版本闸的**适用范围**固化（codex C0 复审 HIGH-1）═══
  //   契约闸只管 POST /sys-issues（建单表单），**刻意不扩展**到 derive / reactivate。
  //   判据：该端点是否承载"用户在表单里表达的、可能被静默改义的意图"——建单的受理勾选有，
  //   详情页的单一动作按钮没有（用户只表达动作本身，结果状态当场可见）。
  //   本组把这条范围划定钉成断言：**不带契约字段调 derive/reactivate 必须正常工作**，
  //   防日后有人看到"只有建单校验"以为是漏了而顺手加闸（那会让契约字段渗透到每个写端点）。
  {
    const ins = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('bug','已上线','P2','SCOPE-derive源','BMS','内部',1,1,'管理员','native')`);
    const drv = await call('POST', `/api/sys-issues/${ins.lastID}/derive`, adminTok,
      { type: 'bug', title: 'SCOPE-派生', system_name: 'BMS', source: '内部', derive_reason: '范围固化用例' });
    assert.strictEqual(drv.status, 201, `derive 不要求契约字段（有意设计）, got ${drv.status} ${JSON.stringify(drv.body)}`);
    assert.strictEqual(drv.body.status, '待受理', 'derive 仍恒落待受理（落态由服务端统一函数决定·与契约字段无关）');

    const rej = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','已拒绝','P2','SCOPE-reactivate','BMS','内部',1,1,'管理员','native')`);
    const rea = await call('POST', `/api/sys-issues/${rej.lastID}/reactivate`, adminTok, { reason: '范围固化用例' });
    assert.strictEqual(rea.status, 200, `reactivate 不要求契约字段（有意设计）, got ${rea.status} ${JSON.stringify(rea.body)}`);
    // ⭐ v2.1（C2.5 撤销）：本单是 feature（变更流）→ 复活回「待受理」（预沟通段整体撤销）。本组要钉的是
    //   "落态由服务端统一函数决定、与契约字段无关"，这一点不因撤销而改变（变的只是那个函数的返回值）。
    assert.strictEqual(rea.body.status, '待受理', 'reactivate 落态仍由服务端统一函数决定（v2.1：变更流→待受理·与契约字段无关）');
    ok('[SCOPE] 契约闸范围固化：derive / reactivate **不要求** intake_contract_version 仍正常（有意设计·非遗漏），且落态照样由服务端统一函数决定');
  }

  // ═══ [TRG] 数据库层运行期约束（codex C0 二/三轮审 HIGH-2）：**全表** intake_required≠1 → 触发器 ABORT ═══
  //   ⚠️ 三轮审收口：第二轮曾把条件收窄到「受理态 + ir≠1」，理由是"只有该组合会卡死"+"零测试夹具适配"——错的。
  //     绕过受理门的产物恰恰是「待指派/待处理 + ir=0」这类**非受理态**单，收窄等于把要防的放行；
  //     且与同 commit 的迁移/DEFAULT/哨兵三处"全表恒 1"口径矛盾。测试适配成本不是放宽生产约束的理由，
  //     需要脏夹具的用例改为**显式摘除约束**（lib/sys-intake-gate-triggers.withoutTriggers）。
  {
    // ① INSERT 侧：受理态 + ir=0 → ABORT
    for (const st of ['待受理', '待修改']) {
      await assert.rejects(
        run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
             VALUES ('feature',?,'P2','TRG-ins','BMS','内部',0,1,'管理员','native')`, [st]),
        /intake_required/,
        `触发器应拒绝 INSERT「${st} + ir=0」`);
    }
    // ② "漏写 intake_required 列"这一真实形态，在两类库上由**不同防线**兜住，分别验证：
    //   · 全新库（本测试环境）：ALTER 的 DEFAULT 已改为 1 → 漏写自动落 1，触发器无需介入（不该拦）。
    //   · 已迁移旧库（生产）：DEFAULT 仍是 0（SQLite 无法原地改）→ 漏写落 0，由上方 ① 的触发器拦下。
    //   这里断言前者：先证 DEFAULT 确实是 1（防日后有人把它改回去），再证漏写落 1 且能正常受理。
    const dflt = (await all(`PRAGMA table_info(sys_issues)`)).find(c => c.name === 'intake_required');
    assert.ok(dflt, 'intake_required 列存在');
    assert.strictEqual(String(dflt.dflt_value), '1', `新库 intake_required 列 DEFAULT 应为 1（实际 ${dflt.dflt_value}）——漏写列时的第一道兜底`);
    const omitted = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, created_by, created_by_name, record_source)
      VALUES ('feature','待受理','P2','TRG-default','BMS','内部',1,'管理员','native')`);
    const omittedRow = await get(`SELECT intake_required FROM sys_issues WHERE id=?`, [omitted.lastID]);
    assert.strictEqual(omittedRow.intake_required, 1, '新库漏写 intake_required → 落 DEFAULT 1（不产生矛盾单）');
    // ③ UPDATE 侧：把受理态单的 ir 改成 0 → ABORT
    const okIns = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','待受理','P2','TRG-upd','BMS','内部',1,1,'管理员','native')`);
    await assert.rejects(run(`UPDATE sys_issues SET intake_required=0 WHERE id=?`, [okIns.lastID]),
      /intake_required/, '触发器应拒绝把受理态单的 intake_required 改回 0');
    // ④ UPDATE 侧：把历史遗留的 ir=0 单推进到受理态（不同时置 1）→ ABORT
    //   ⚠️ 夹具本身（ir=0 的开发中单）在新约束下已造不出来，故用 withoutTriggers 摘约束造——
    //     这正是"C0 之前的旧库形态"，重建约束后再测它能否被推进到受理态。
    const devIns = await gate.withoutTriggers(() => run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','开发中','P2','TRG-upd2','BMS','内部',0,1,'管理员','native')`));
    await assert.rejects(run(`UPDATE sys_issues SET status='待受理' WHERE id=?`, [devIns.lastID]),
      /intake_required/, '触发器应拒绝「把 ir=0 的历史单推进到受理态」');
    // 正路：同时置 1 则放行（迁移/自愈路径必须畅通，否则历史脏单永远修不好）
    await run(`UPDATE sys_issues SET status='待受理', intake_required=1 WHERE id=?`, [devIns.lastID]);
    assert.strictEqual((await get(`SELECT intake_required FROM sys_issues WHERE id=?`, [devIns.lastID])).intake_required, 1,
      '同一条 UPDATE 里同时置 status 与 ir=1 → 放行（自愈路径畅通）');
    // ⑤ ⭐ 约束是**全表恒 1**，与 status 无关（codex 三轮审 HIGH 收口）：
    //   绕过受理门的产物恰恰是「待指派/待处理 + ir=0」这类**非受理态**单，若按 status 收窄就等于把要防的放行了。
    //   本断言正是对"第二轮曾收窄到受理态"那个错误取舍的回归钉子。
    for (const [type, st] of [['feature', '开发中'], ['feature', '待上线'], ['feature', '已上线'],
      ['feature', '已拒绝'], ['feature', '待指派'], ['bug', '待处理']]) {
      await assert.rejects(
        run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
             VALUES (?,?,'P2','TRG-nonintake','BMS','内部',0,1,'管理员','native')`, [type, st]),
        /intake_required/,
        `非受理态「${st}」+ ir=0 也必须被拒（绕过受理门的产物正是这类非受理态单）`);
    }
    // ⑥ 摘除后可造脏（证明"测试适配靠显式摘约束"，而不是靠把生产约束调弱）
    await gate.withoutTriggers(async () => {
      const r = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
        VALUES ('feature','开发中','P2','TRG-摘除后','BMS','内部',0,1,'管理员','native')`);
      assert.ok(r.lastID > 0, '摘除触发器后可造 ir=0 脏数据（供内层防线回归用）');
    });
    await assert.rejects(run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','开发中','P2','TRG-重建后','BMS','内部',0,1,'管理员','native')`),
      /intake_required/, 'withoutTriggers 退出后触发器已自动重建');
    ok('[TRG] DB 运行期约束：**全表** intake_required≠1 的 INSERT/UPDATE 一律 ABORT（含受理态/非受理态六种状态 + "漏写列吃 DEFAULT" 形态）；withoutTriggers 作用域可临时摘除且退出必重建');
  }

  // ═══ [MIG] 真实升级路径（codex C0 复审 MED-1）：存量 ir=0 → C0 迁移归一 → 幂等 → 失败回滚 ═══
  //   上面各组都跑在"迁移已完成的空库"上，测不到真实升级。本组用"删标记 + 重跑 runSysMigration"复现
  //   （与 verify-sys-intake-schedule-migration 同范式）：造非受理态的 ir=0 存量（受理态会被触发器拦，
  //   这本身就是约束生效的旁证），再让 C0 迁移把它们归一。
  {
    const C0_KEY = 'role_perm_c0_intake_gate';
    const seedIds = [];
    // 存量 ir=0 是"C0 之前的旧库形态"——当时还没有触发器，故造夹具时显式摘除（真实升级顺序也是先修数据再建约束）
    await gate.withoutTriggers(async () => {
      for (const [type, st] of [['feature', '开发中'], ['feature', '待指派'], ['bug', '待处理'], ['feature', '已拒绝']]) {
        const r = await run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
          VALUES (?,?,'P2','MIG-存量','BMS','内部',0,1,'管理员','native')`, [type, st]);
        seedIds.push(r.lastID);
      }
    });
    const dirtyBefore = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE id IN (${seedIds.join(',')}) AND intake_required=0`)).c;
    assert.strictEqual(dirtyBefore, 4, '前置：4 行 ir=0 存量已就位');

    // ① 删标记 + 重跑 → 归一
    await run(`DELETE FROM sys_schema_migrations WHERE migration_key = ?`, [C0_KEY]);
    await I.runSysMigration(null);
    const dirtyAfter = (await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_required != 1 OR intake_required IS NULL`)).c;
    assert.strictEqual(dirtyAfter, 0, 'C0 迁移后全表 intake_required 恒 1');
    const marker = await get(`SELECT migration_key FROM sys_schema_migrations WHERE migration_key = ?`, [C0_KEY]);
    assert.ok(marker, 'C0 迁移标记已落');

    // ② 二次启动幂等：标记在 → 整段跳过，零改动
    const snapBefore = (await get(`SELECT COUNT(*) c FROM sys_issues`)).c;
    await I.runSysMigration(null);
    assert.strictEqual((await get(`SELECT COUNT(*) c FROM sys_issues`)).c, snapBefore, '二次跑迁移不增删行（幂等）');
    assert.strictEqual((await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_required != 1`)).c, 0, '二次跑后仍全 1');

    // ③ 迁移事务原子性：在写标记处注入失败 → 归一 UPDATE 必须整体回滚（标记与数据同事务）
    const r2 = await gate.withoutTriggers(() => run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','开发中','P2','MIG-回滚','BMS','内部',0,1,'管理员','native')`));
    await run(`DELETE FROM sys_schema_migrations WHERE migration_key = ?`, [C0_KEY]);
    injectFailureFired = false;
    injectFailureOnSql = 'INSERT INTO sys_schema_migrations';   // 归一 UPDATE 之后、COMMIT 之前
    // ⚠️ 不用 assert.rejects：runSysMigration 的最外层把异常转成 SYS_SCHEMA_STATE.error（可观测·不静默吞），
    //   不一定向调用方抛。故这里只要求"故障确实命中"，正确性由下面的**回滚断言**承担（那才是本用例的靶心）。
    try { await I.runSysMigration(null); } catch (_) { /* 抛与不抛都可以，见上 */ }
    assert.ok(injectFailureFired, '确认迁移故障真实命中（防 SQL 片段写错致用例静默失效）');
    injectFailureOnSql = null; injectFailureFired = false;
    // ⭐ 迁移事务的原子性证据 = **标记未落 + 数据未变**（标记与归一 UPDATE 同事务，写标记处失败 ⟹ 一起回滚）。
    //   ⚠️ 九轮审收敛后 [F] **不再修数据**（只恢复约束 + 如实报告），故"数据保持 0"重新成为正确期望：
    //     自动把 0 改成 1 会把"绕过受理门"洗成表面合法并抹掉判别信号，那份职责只属于带标记的正式迁移事务。
    const markerAfterFail = await get(`SELECT migration_key FROM sys_schema_migrations WHERE migration_key = ?`, [C0_KEY]);
    assert.ok(!markerAfterFail, '⭐ 迁移失败 → 标记未落（标记与归一同事务·下次启动会重跑）');
    const afterFail = await get(`SELECT intake_required FROM sys_issues WHERE id=?`, [r2.lastID]);
    assert.strictEqual(afterFail.intake_required, 0, '⭐ 迁移事务回滚 → 数据保持原值（[F] 不承担修数据职责）');
    // [F] 检测到非法行 → 阻断 readiness + 留证据（不修）
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, false, '⭐ 存在非法行时 [F] 阻断 readiness（宁可 503 不带病放行）');
    assert.ok(/非法数据/.test(I.SYS_SCHEMA_STATE.error || ''), `error 报告非法数据，实际：${I.SYS_SCHEMA_STATE.error}`);
    // 触发器仍必须已重建（迁移开头 DROP 过，异常路径同样要恢复——这是 [F] 保留的唯一"修复"职责）
    await assert.rejects(run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','开发中','P2','MIG-触发器自检','BMS','内部',0,1,'管理员','native')`),
    /intake_required/, '⭐ [F] 已重建触发器（异常路径不留无约束状态·与"不修数据"并行不悖）');
    // 清掉这条非法行，让后续用例回到干净态
    await gate.withoutTriggers(() => run(`DELETE FROM sys_issues WHERE id=?`, [r2.lastID]));
    // 收尾：让库回到干净态（重跑成功一次），避免污染后续可能新增的用例
    await I.runSysMigration(null);
    assert.strictEqual((await get(`SELECT COUNT(*) c FROM sys_issues WHERE intake_required != 1`)).c, 0, '重跑后恢复全 1');
    ok('[MIG] 真实升级路径：存量 ir=0（4 行）→ C0 迁移全归一 + 标记落 + 二次跑幂等 + ⭐ 写标记处注入失败 → 标记未落且数据保持原值（事务原子·[F] 不修数据）+ [F] 阻断 readiness 并留证据 + 触发器仍被重建');
  }

  // ═══ [REC] 收口 [F] 的异常恢复语义（codex C0 五轮审 HIGH-1 + HIGH-2）═══
  //   [F] 是"迁移无论怎么失败，受理门约束都必须回到位"的最后一道闸，它自身的行为必须有测试，
  //   否则 41/41 全绿只能证明正常路径，证明不了异常路径（codex 原话：全绿不覆盖异常恢复）。
  {
    const trgNames = I.SYS_INTAKE_GATE_TRIGGER_NAMES;
    const trgCount = async () => (await all(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${trgNames.map(() => '?').join(',')})`, trgNames)).length;

    // ① 跨启动恢复：模拟"上次进程 DROP 后被强杀"——手工摘掉触发器，再跑一次迁移 → 必须自动恢复
    await gate.drop();
    assert.strictEqual(await trgCount(), 0, '前置：触发器已被摘除（模拟上次进程 DROP 后崩溃）');
    await I.runSysMigration(null);
    assert.strictEqual(await trgCount(), 2, '⭐ [F] 跨启动恢复：正常迁移路径把两个触发器都补回来');

    // ② **ddlError 早退**路径（本次根本走不到 [0b] 的 DROP）+ 触发器缺失 → [F] 仍须恢复。
    //   这正是 gateTriggersDropped 标志挡不住的跨启动缺口：收口条件必须是"表在"而非"本次 DROP 过"。
    await gate.drop();
    assert.strictEqual(await trgCount(), 0, '前置：触发器再次被摘除');
    await I.runSysMigration('模拟建表 DDL 失败');
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, false, 'ddlError 路径 readiness=false（迁移本身失败）');
    assert.ok(/建表 DDL 失败/.test(I.SYS_SCHEMA_STATE.error || ''), '错误信息保留原始根因（建表 DDL 失败）');
    assert.strictEqual(await trgCount(), 2, '⭐ [F] 即便本次在 [0b] 之前早退，触发器仍被恢复（收口不依赖本次是否 DROP 过）');
    await I.runSysMigration(null);   // 复位 readiness
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '复位：正常迁移后 readiness 恢复');

    // ③ ⭐ C0 已生效后出现非法行 = 运行期污染（疑似绕过受理门）→ **不自动洗数据** + 阻断 readiness + 留证据
    const dirty = await gate.withoutTriggers(() => run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('bug','待处理','P2','REC-绕过受理门','BMS','内部',0,1,'管理员','native')`));
    await I.runSysMigration(null);
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, false, '⭐ C0 生效后发现非法行 → readiness=false（宁可 503 也不带病放行）');
    assert.ok(/非法数据/.test(I.SYS_SCHEMA_STATE.error || ''), `error 指明存在非法数据，实际：${I.SYS_SCHEMA_STATE.error}`);
    assert.ok(new RegExp(`#${dirty.lastID}`).test(I.SYS_SCHEMA_STATE.error || ''), 'error 含违规单据 id 证据（供人工裁决）');
    assert.ok(/待处理/.test(I.SYS_SCHEMA_STATE.error || ''), 'error 含 status 证据（判断是否已进开发流程的关键信号）');
    const stillDirty = await get(`SELECT intake_required FROM sys_issues WHERE id=?`, [dirty.lastID]);
    assert.strictEqual(stillDirty.intake_required, 0,
      '⭐ **不自动归一**：把绕过受理的单洗成 ir=1 会掩盖绕过行为并抹掉唯一的判别信号，必须保留原值等人工裁决');
    // ⭐⭐ 六轮审 HIGH 的回归钉子：阻断分支**必须仍然重建触发器**。
    //   否则结果是"数据脏 + 无约束 + 长期 503"三重坏——触发器缺失反而让外部写入继续扩大污染。
    //   「是否修数据」与「是否恢复未来写入约束」是两件事，后者无条件要做。
    assert.strictEqual(await trgCount(), 2, '⭐ 污染阻断时两个触发器仍被重建（名称存在）');
    await assert.rejects(run(`INSERT INTO sys_issues (type, status, priority, title, system_name, source, intake_required, created_by, created_by_name, record_source)
      VALUES ('feature','开发中','P2','REC-阻断后仍应拒绝','BMS','内部',0,1,'管理员','native')`),
    /intake_required/, '⭐ 污染阻断时触发器**具备实际拒绝能力**（不只是名字在）——新的违规 INSERT 被拒');
    await assert.rejects(run(`UPDATE sys_issues SET intake_required=0 WHERE id=?`, [dirty.lastID]),
      /intake_required/, '⭐ 污染阻断时 UPDATE 侧触发器同样生效');

    // 收尾：人工裁决的等价操作（此处按"确属误写"处理）→ 清掉违规单 → 迁移恢复正常
    await gate.withoutTriggers(() => run(`DELETE FROM sys_issues WHERE id=?`, [dirty.lastID]));
    await I.runSysMigration(null);
    assert.strictEqual(I.SYS_SCHEMA_STATE.ready, true, '违规单清理后 readiness 恢复');
    assert.strictEqual(await trgCount(), 2, '收尾：两个触发器就位');
    ok('[REC] 收口 [F] 异常恢复：①正常路径补回触发器 ②ddlError 早退路径同样补回（不依赖本次是否 DROP 过·跨启动缺口已堵）③C0 生效后的非法行**不自动洗**、阻断 readiness、error 带 id/status 证据');
  }

  console.log(`\n✅ verify-sys-intake-gate 全部通过（${passed} 组·角色权限重构 C0 焊死受理门）`);
  server.close();
  db.close();
}

main().catch((e) => { console.error('❌ 验证失败:', e && e.stack || e); try { server && server.close(); } catch (_) { /* 关闭失败无需处理·进程即将退出 */ } process.exit(1); });
