#!/usr/bin/env node
/**
 * #77 C3b：配置台迁出后的跳转与门禁用例（Playwright，隔离实例 3377）。
 *
 * 覆盖：目录菜单「编辑配置」/ 按钮「配置（只读）」跳转并落到正确模式；?dev=1 兼容（DIM / DWD 跳配置台、ODS 留目录页定位）；
 *   编辑保存 / 放弃 / 关闭只读 → 回目录页 ?focus=<id> 并高亮定位；注册成功 → 回目录页定位新模型；
 *   viewer 打开编辑 / 注册 → 重定向回目录页并提示、打开只读 → 留在配置台只读；非负责人的 edit → 降为只读（地址栏同步 mode=view）；
 *   ?focus=<不存在> → toast；入口目标不是 DIM/DWD / 不存在 / 已删除 → 回目录页由目录页提示；两页零 console error。
 *
 * 跑法（wbs-server 目录下，脚本自己起隔离实例，不碰 3000）：node scripts/test-model-workbench-playwright.js
 * 隔离实例 / 库副本 / 账号夹具与 test-model-workbench-baseline-playwright.js 同款（下面「隔离实例」一段由 E:/tmp/mc77-c3/c3b/gen-wb-test.js 从该文件
 *   逐字生成，不手抄），库副本放 MC_WB_WORKDIR（默认 E:/tmp/mc77-c3/pw-wb-run），运行结束删除。
 * 时序：全部用「等 URL / 等元素 / 等 toast 文本 / 等高亮记录」的信号，不用固定 sleep 当同步手段；落点取换页提交那一刻的 URL
 *   （目录页处理完 ?focus / ?notice 会 replaceState 清参，所以必须在清参前取）。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const FIX_DIR = path.join(__dirname, 'fixtures', 'model-workbench-baseline');
const MODELS_FILE = path.join(FIX_DIR, 'models.json');
const PORT_ARG = (process.argv.slice(2).find(a => a.startsWith('--port=')) || '').slice('--port='.length);   // C4b：可指定端口（默认 3377），主工作区的其他 agent 占用 3377 时用
if (PORT_ARG && !/^\d{2,5}$/.test(PORT_ARG)) { console.error('--port 必须是数字：' + PORT_ARG); process.exit(2); }
const PORT = PORT_ARG ? Number(PORT_ARG) : 3377;
const BASE = `http://localhost:${PORT}`;
const WORKDIR = process.env.MC_WB_WORKDIR || (fs.existsSync('E:/tmp') ? 'E:/tmp/mc77-c3/pw-wb-run' : path.join(os.tmpdir(), 'mc77-c3-pw-wb-run'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// 隔离实例（逐字取自 test-model-workbench-baseline-playwright.js 的「夹具与隔离库」段）
// ---------------------------------------------------------------------------------------------
const FIXTURE_IDS = { dim: [50, 55, 60, 62, 65], dwd: [52, 59], dimCustom: 58, dwdCompanion: 53, ods: [6, 8], deletedDim: 66 };
const FILLER_COUNT = 25;
const CREATOR_DWD_ID = 71;   // 30T M2：DWD 创建者分支夹具
const CREATOR_DIM_ID = 70;   // 本用例追加：创建者分支夹具（见 prepareDb）
const USERS = [
  { id: 1, username: 'admin', display_name: '管理员', role: 'admin' },
  { id: 2, username: 'viewer_user', display_name: '测试查看者', role: 'viewer' },
  { id: 3, username: 'owner_user', display_name: '测试负责人', role: 'user' },
  { id: 4, username: 'nonowner_user', display_name: '测试非负责人', role: 'user' },
];
const loadModelRows = () => JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).rows;

function dbRun(db, sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
function dbClose(db) { return new Promise((res, rej) => db.close(e => e ? rej(e) : res())); }
const tryUnlink = (f) => { try { fs.unlinkSync(f); } catch (e) { if (e.code !== 'ENOENT') throw e; } };
const removeDbFiles = (dbPath) => { for (const s of ['', '-wal', '-shm', '-journal']) tryUnlink(dbPath + s); };

async function prepareDb(dbPath) {
  fs.mkdirSync(WORKDIR, { recursive: true });
  removeDbFiles(dbPath);
  const realDb = path.join(ROOT, 'task_pool.db');
  if (!fs.existsSync(realDb)) throw new Error('缺少 wbs-server/task_pool.db（包装器也要求它存在）');
  const src = await new Promise((res, rej) => { const d = new sqlite3.Database(realDb, sqlite3.OPEN_READONLY, e => e ? rej(e) : res(d)); });
  await dbRun(src, 'VACUUM INTO ?', [dbPath]);   // 一致性快照；VACUUM INTO 不写源库
  await dbClose(src);
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, e => e ? rej(e) : res(d)); });
  // 清外部副作用面：钉钉凭证 / 数仓连接 / 周期任务；清与模型关联的数据与账号
  for (const t of ['system_configs', 'db_connections', 'periodic_tasks', 'model_change_logs', 'model_test_records', 'task_pool', 'data_models', 'users', 'sys_domains', 'sys_source_systems']) {
    await dbRun(db, `DELETE FROM ${t}`);
  }
  // C4b（§C-19 / L10）：本机库将来若有实现对象登记，夹具同号行会挂上对象名；表存在才清（与 C4-0 驱动一致）
  for (const t of ['model_impl_links', 'model_impl_objects']) { const ex = await new Promise((res, rej) => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t], (e, r) => e ? rej(e) : res(r))); if (ex) await dbRun(db, `DELETE FROM ${t}`); }
  for (const u of USERS) await dbRun(db, 'INSERT INTO users (id, username, password, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)', [u.id, u.username, 'not-used-jwt-only', u.display_name, u.role, 'active']);
  for (const [code, name] of [['dom_a', '域甲'], ['dom_b', '域乙'], ['dom_c', '域丙']]) await dbRun(db, "INSERT INTO sys_domains (code, name, description, status) VALUES (?, ?, '', 'active')", [code, name]);
  for (const [code, name] of [['SYS_A', '来源系统甲'], ['SYS_B', '来源系统乙']]) await dbRun(db, "INSERT INTO sys_source_systems (code, name, description) VALUES (?, ?, '')", [code, name]);
  const COLS = ['id', 'layer', 'domain', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'created_at', 'updated_at', 'source_table', 'source_system', 'model_type', 'created_by_id', 'category', 'dim_config', 'is_deleted', 'config_mode', 'design_notes', 'companion_of'];
  const ins = (row) => dbRun(db, `INSERT INTO data_models (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => (c === 'dim_config' ? (row.dim_config == null ? null : JSON.stringify(row.dim_config)) : (row[c] === undefined ? null : row[c]))));
  const rows = loadModelRows();
  for (const r of rows) await ins(r);
  // 软删除夹具：62 的副本（CREATED 状态、is_deleted=1），用于解释「?validate=1 不开弹窗」
  const r62 = rows.find(r => r.id === 62);
  await ins({ ...r62, id: FIXTURE_IDS.deletedDim, table_name: r62.table_name + '_gone', is_deleted: 1 });
  // 本用例追加的夹具（不在共享基线夹具里）：创建者分支——50 的副本，created_by_id=测试负责人(3)、tech_owner 为他人
  await ins({ ...rows.find(r => r.id === 50), id: CREATOR_DIM_ID, table_name: rows.find(r => r.id === 50).table_name + '_mine', tech_owner: '另一位负责人', created_by_id: 3, is_deleted: 0 });
  // 30T M2：DWD 创建者分支夹具——52 的副本，created_by_id=测试负责人(3)、tech_owner 为他人
  await ins({ ...rows.find(r => r.id === 52), id: CREATOR_DWD_ID, table_name: rows.find(r => r.id === 52).table_name + '_mine', tech_owner: '另一位负责人', created_by_id: 3, is_deleted: 0 });
  // 填充 ODS（按表名排序排在 ods_w* 之前，让 DIM/DWD 夹具在第 1 页、ODS#6/#8 在第 2 页，列表跨页）
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const nn = String(i).padStart(2, '0');
    await ins({ id: 100 + i, layer: 'ods', domain: '', table_name: `ods_filler_${nn}_df`, table_comment: '填充', tech_owner: '管理员', biz_owner: '', update_cycle: 'df', status: 'ONLINE', created_at: '2026-01-01 08:00:00', updated_at: '2026-01-02 08:00:00', source_table: `filler_${nn}`, source_system: 'SYS_A', model_type: 'TABLE', created_by_id: 1, category: 'general', dim_config: null, is_deleted: 0, config_mode: 'standard', design_notes: null, companion_of: null });
  }
  await dbClose(db);
}

function portBusy() {
  return new Promise((resolve) => {
    const s = net.createConnection({ port: PORT, host: '127.0.0.1' });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

let serverChild = null;
let serverKillIssued = false;
/** 只按自己 spawn 的 pid 停，同一 pid 只杀一次（exit 钩子与 finally 都可能调用） */
function killServer() {
  if (!serverChild || !serverChild.pid || serverKillIssued || serverChild.__dead) return;
  serverKillIssued = true;
  try { spawnSync('taskkill', ['/T', '/F', '/PID', String(serverChild.pid)], { stdio: 'ignore' }); } catch (_) { /* 下面等 exit 事件 */ }
}
async function stopServerAndCleanup(dbPath) {
  killServer();
  const t0 = Date.now();
  while (serverChild && !serverChild.__dead && Date.now() - t0 < 10000) await sleep(100);
  if (serverChild && !serverChild.__dead) { console.error('[cleanup] 隔离实例进程未在 10s 内退出，库副本未删除：' + dbPath); return; }
  try { removeDbFiles(dbPath); } catch (e) { console.error('[cleanup] 删除库副本失败：' + e.message); }
}
async function startServer(dbPath) {
  const logPath = path.join(WORKDIR, 'server.log');
  const fd = fs.openSync(logPath, 'w');
  serverChild = spawn(process.execPath, [path.join(ROOT, 'scripts', '_test-it-asset-ledger-server-wrapper.js')], {
    cwd: ROOT, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(PORT), IA_TEST_DB_PATH: dbPath, SYS_FASTLANE_ENABLE: '0', LOG_LEVEL: 'INFO' },
  });
  fs.closeSync(fd);
  serverChild.on('exit', () => { serverChild.__dead = true; });
  const t0 = Date.now();
  for (;;) {
    if (serverChild.__dead) throw new Error('隔离实例提前退出，见日志 ' + logPath + '：\n' + fs.readFileSync(logPath, 'utf8').slice(-1500));
    if (/Task Pool Server running/.test(fs.readFileSync(logPath, 'utf8'))) return;
    if (Date.now() - t0 > 60000) throw new Error('隔离实例 60s 内未就绪，见日志 ' + logPath);
    await sleep(250);
  }
}


// ---------------------------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------------------------
const WAIT = 15000;
const NAV_ABORT_WINDOW_MS = 2000;
const MUT = process.env.MC_MUT || '';   // 变异开关（仅用于判别力自证；正常运行为空）：refuse1000 / late2500 / static404 / m7-paren（末次合并审 M7：去掉伴生链接 onclick 的右括号）/ h2-wb-off（末次合并审 H2：去掉保存的 409 分支）
let nPass = 0, nFail = 0;
const check = (name, cond, detail) => {
  if (cond) { nPass++; console.log('  PASS ' + name); } else { nFail++; console.log('  FAIL ' + name + (detail === undefined ? '' : '\n    ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))); }
};
const tokenFor = (secret, u) => jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, secret, { expiresIn: '2h' });

// 每页的探针：toast 文本、被高亮过的行、console 错误（init 脚本里的观察器 + page 事件）
const INIT_PROBE = () => {
  window.__toastTexts = []; window.__highlighted = [];
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.parentElement && n.parentElement.id === 'toast-container') window.__toastTexts.push(n.textContent || ''); }).observe(document.body, { childList: true, subtree: true });
    // C4c-2：高亮 = 条目 [data-id] 上的 data-focus-highlight 属性（旧：tr 的 style 背景色）；语义同「曾被高亮」
    new MutationObserver((muts) => { for (const m of muts) { const el = m.target; if (el.dataset && el.dataset.id && el.hasAttribute('data-focus-highlight') && !window.__highlighted.includes(el.dataset.id)) window.__highlighted.push(el.dataset.id); } }).observe(document.body, { attributes: true, attributeFilter: ['data-focus-highlight'], subtree: true });
  });
};

async function main(dbPath) {
  if (await portBusy()) { console.error(`端口 ${PORT} 已被占用，拒绝启动（3000 是用户进程，不得占用或杀）。`); process.exit(2); }
  const secret = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env'))).JWT_SECRET;
  if (!secret) throw new Error('wbs-server/.env 缺 JWT_SECRET');
  await prepareDb(dbPath);
  await startServer(dbPath);
  const browser = await chromium.launch({ headless: true });
  const errors = [];   // { label, text, url, inAbortWindow, pageState }
  const pageStates = [];
  const mkCtx = async (user) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const tok = tokenFor(secret, user);
    await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, user.display_name]);
    await ctx.addInitScript(INIT_PROBE);
    await ctx.route('**/api/warehouse/describe-table*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await ctx.route('**/api/models/*/save-scripts', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"savedFiles":[],"configRevBumped":false}' }));
    return ctx;
  };
  const newPage = async (ctx, label) => {
    const page = await ctx.newPage();
    // 30T-R H1 / M1 / M2：Failed to fetch 的放行与「真实取消请求」绑定——
    //   窗口起点只取主框架导航请求的开始时间（framenavigated 不覆盖起点）；page 监听 requestfailed，errorText 含 ERR_ABORTED 且发生在导航窗口内的，记入该 page 的可抵扣取消数 credits；
    //   每条窗口内的 Failed to fetch 记录带 pageState 引用，最终判定时放行至多 credits 条（放行一条抵扣一次），其余计为错误（两个事件的先后顺序不影响结果）。
    //   404 记录保存来源 URL（msg.location().url），按 URL 白名单放行。
    const pageState = { label, lastNavAt: -Infinity, credits: 0 };
    pageStates.push(pageState);
    page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) pageState.lastNavAt = Date.now(); });
    page.on('requestfailed', (r) => { const f = r.failure(); if (f && /ERR_ABORTED/.test(f.errorText || '') && Date.now() - pageState.lastNavAt <= NAV_ABORT_WINDOW_MS) pageState.credits++; });
    page.on('console', (m) => { if (m.type() === 'error') errors.push({ label, text: m.text().slice(0, 200), url: m.location().url || '', inAbortWindow: Date.now() - pageState.lastNavAt <= NAV_ABORT_WINDOW_MS, pageState }); });
    page.on('pageerror', (e) => errors.push({ label, text: 'pageerror ' + String(e).slice(0, 200) }));
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    return page;
  };
  const isNav = (e) => /Execution context was destroyed|Navigation|navigat|interrupted/i.test(String(e && e.message));
  const toCatalogUrl = (u) => /Model_Center\.html$/.test(u.pathname);
  const toWbUrl = (u) => /Model_Workbench\.html$/.test(u.pathname);
  /** 导航并捕获「提交时」的落点（目录页稍后会 replaceState 清掉 focus / notice 参数） */
  const gotoAndLand = async (page, url, want) => {
    const navP = page.waitForURL(want, { waitUntil: 'commit', timeout: WAIT });
    try { await page.goto(url, { waitUntil: 'load' }); } catch (e) { if (!isNav(e)) throw e; }
    await navP;
    const u = new URL(page.url());
    return { path: u.pathname.replace(/^\//, ''), search: u.search };
  };
  const wbReady = (page, id) => page.waitForFunction((i) => typeof dimEditModelId !== 'undefined' && typeof dwdEditModelId !== 'undefined' && (dimEditModelId === i || dwdEditModelId === i) && (window.__toastTexts || []).some(t => /已加载|（只读）/.test(t)), id, { timeout: WAIT });
  const catalogRows = (page) => page.waitForSelector('#modelListBody [data-id]', { timeout: WAIT });
  // C4c-2：经真实点击路径触发条目动作——动作项在菜单里则先点该菜单的触发按钮（[data-menu][aria-controls=<菜单 id>]）再点 [data-act] 项；菜外直接按钮直接点
  const clickRowAct = async (page, id, act) => {
    const entry = page.locator(`#modelListBody [data-id="${id}"]`);
    const item = entry.locator(`[data-act="${act}"]`).first();
    const menuId = await item.evaluate((el) => { const m = el.closest('[role="menu"]'); return m ? m.id : null; });
    if (menuId) await entry.locator(`[data-menu][aria-controls="${menuId}"]`).click();
    await item.click();
  };
  const highlighted = (page, id) => page.waitForFunction((i) => (window.__highlighted || []).includes(String(i)), id, { timeout: WAIT });
  const urlCleaned = (page) => page.waitForFunction(() => location.search === '', null, { timeout: WAIT });
  const toastSeen = (page, re) => page.waitForFunction((src) => (window.__toastTexts || []).some(t => new RegExp(src).test(t)), re.source, { timeout: WAIT });
  const toasts = (page) => page.evaluate(() => (window.__toastTexts || []).map(t => t.trim()));
  const state = (page) => page.evaluate(() => ({
    dim: typeof dimEditModelId !== 'undefined' ? dimEditModelId : null, dimRO: typeof dimEditReadOnly !== 'undefined' ? dimEditReadOnly : null,
    dwd: typeof dwdEditModelId !== 'undefined' ? dwdEditModelId : null, dwdRO: typeof dwdEditReadOnly !== 'undefined' ? dwdEditReadOnly : null,
    search: location.search, path: location.pathname.replace(/^\//, ''),
  }));
  const allDisabled = (page) => page.evaluate(() => { const els = Array.from(document.querySelectorAll('.model-generator-card input, .model-generator-card select, .model-generator-card textarea')); return els.length > 0 && els.every(e => e.disabled); });
  const captureWrites = async (page, method, glob, respBody) => {
    const calls = [];
    await page.route(glob, async (route) => {
      const req = route.request();
      if (req.method() === method) { calls.push(req.postData()); await route.fulfill({ status: 200, contentType: 'application/json', body: respBody }); } else await route.continue();
    });
    return calls;
  };

  try {
    const admin = await mkCtx(USERS[0]), viewer = await mkCtx(USERS[1]), owner = await mkCtx(USERS[2]), nonowner = await mkCtx(USERS[3]);

    // ---- T1 目录菜单 / 按钮 → 配置台，落到正确模式 ----
    console.log('T1 目录页入口跳转');
    {
      const page = await newPage(admin, 'T1-admin');
      await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
      await catalogRows(page);
      await clickRowAct(page, 50, 'edit-config');   // C4c-2：⋯ 菜单「编辑配置」
      await page.waitForURL(toWbUrl, { timeout: WAIT }); await wbReady(page, 50);
      let st = await state(page);
      check('DIM#50 菜单「编辑配置」→ ?id=50&mode=edit，进入编辑态（非只读）', st.search === '?id=50&mode=edit' && st.dim === 50 && st.dimRO === false, st);
      await page.goBack(); await catalogRows(page);
      await clickRowAct(page, 52, 'edit-config');   // C4c-2：⋯ 菜单「编辑配置」
      await page.waitForURL(toWbUrl, { timeout: WAIT }); await wbReady(page, 52);
      st = await state(page);
      check('DWD#52 菜单「编辑配置」→ ?id=52&mode=edit，进入编辑态', st.search === '?id=52&mode=edit' && st.dwd === 52 && st.dwdRO === false, st);
      await page.goBack(); await catalogRows(page);
      await clickRowAct(page, 53, 'view-config');   // C4c-2：⋯ 菜单「配置（只读）」
      await page.waitForURL(toWbUrl, { timeout: WAIT }); await wbReady(page, 53);
      st = await state(page);
      check('伴生 DWD#53「配置」→ ?id=53&mode=view，进入只读态（伴生表视图本就有少量可用控件，与改前基线 p5.dwd53companion 一致，不断言全禁用）', st.search === '?id=53&mode=view' && st.dwd === 53 && st.dwdRO === true, st);
      await page.close();
      const p2 = await newPage(nonowner, 'T1-nonowner');
      await p2.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' }); await catalogRows(p2);
      await clickRowAct(p2, 50, 'view-config');   // C4c-2：⋯ 菜单「配置（只读）」
      await p2.waitForURL(toWbUrl, { timeout: WAIT }); await wbReady(p2, 50);
      st = await state(p2);
      check('非负责人「配置」→ ?id=50&mode=view，DIM 只读且控件全禁用', st.search === '?id=50&mode=view' && st.dim === 50 && st.dimRO === true && await allDisabled(p2), st);
      await p2.close();
    }

    // ---- T2 ?dev=1 兼容：DIM / DWD 跳配置台，ODS 留目录页定位 ----
    console.log('T2 ?dev=1 兼容');
    {
      // 30T M1：四种 dev 深链（DIM#50、DWD#52、custom DIM#58、伴生 DWD#53）逐项断言落点精确 URL、对应 *EditModelId 与 *ReadOnly；admin 的伴生表按现行规则也是 edit
      for (const [id, key] of [[50, 'dim'], [52, 'dwd'], [FIXTURE_IDS.dimCustom, 'dim'], [FIXTURE_IDS.dwdCompanion, 'dwd']]) {
        const page = await newPage(admin, 'T2-' + id);
        const land = await gotoAndLand(page, `${BASE}/Model_Center.html?id=${id}&dev=1`, toWbUrl);
        await wbReady(page, id);
        const st = await state(page);
        const other = key === 'dim' ? 'dwd' : 'dim';
        check(`?id=${id}&dev=1（${key.toUpperCase()}）→ 精确落点 /Model_Workbench.html?id=${id}&mode=edit，${key}EditModelId=${id}、${key}EditReadOnly=false、${other}EditModelId=null`, land.path === 'Model_Workbench.html' && land.search === `?id=${id}&mode=edit` && st[key] === id && st[key + 'RO'] === false && st[other] === null, { land, st });
        await page.close();
      }
      const page = await newPage(admin, 'T2-ods');
      await page.goto(`${BASE}/Model_Center.html?id=6&dev=1`, { waitUntil: 'load' });
      await highlighted(page, 6); await urlCleaned(page);
      const st = await state(page);
      check('?id=6&dev=1（ODS）→ 留在目录页，定位高亮 #6，URL 清参', st.path === 'Model_Center.html' && st.search === '', st);
      await page.close();
    }

    // ---- T3 保存 / 放弃 / 关闭只读 → 回目录页并定位 ----
    console.log('T3 离开配置台 → 目录页 ?focus 定位');
    {
      let page = await newPage(admin, 'T3-save');
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=edit`, { waitUntil: 'load' }); await wbReady(page, 50);
      const puts = await captureWrites(page, 'PUT', '**/api/models/50', '{"noChange":true}');
      let navP = page.waitForURL(toCatalogUrl, { waitUntil: 'commit', timeout: WAIT });
      await page.locator('#registerBtn').click();
      await navP;
      let u = new URL(page.url());
      check('DIM#50 保存（noChange）→ 目录页 ?focus=50&notice=unchanged', u.pathname === '/Model_Center.html' && u.search === '?focus=50&notice=unchanged', u.pathname + u.search);
      await catalogRows(page); await highlighted(page, 50); await urlCleaned(page);
      check('保存后目录页高亮 #50 且清掉 focus 参数；PUT 恰发一次且带 dim_config', puts.length === 1 && !!JSON.parse(puts[0]).dim_config, puts.length);
      await toastSeen(page, /^配置未变更$/);
      check('DIM 未改动保存 → 目录页 toast 文本「配置未变更」（info）', (await toasts(page)).includes('配置未变更'), await toasts(page));
      await page.reload({ waitUntil: 'networkidle' }); await catalogRows(page);
      check('刷新目录页不再弹提示（toast 为空、地址栏无 notice）', (await toasts(page)).length === 0 && !/notice/.test(await page.evaluate(() => location.search)), await toasts(page));
      await page.close();

      // P20：DIM 真实保存 → 「配置更新成功」；DWD 真实保存 → 「DWD 配置更新成功」
      for (const [id, body, want, wantCode, label] of [[50, '{"message":"ok"}', '配置更新成功', 'saved', 'DIM'], [52, '{"message":"ok"}', 'DWD 配置更新成功', 'dwd_saved', 'DWD']]) {
        const pg = await newPage(admin, 'T3-saved-' + id);
        await pg.goto(`${BASE}/Model_Workbench.html?id=${id}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, id);
        const pu = await captureWrites(pg, 'PUT', `**/api/models/${id}`, body);
        const nv = pg.waitForURL(toCatalogUrl, { waitUntil: 'commit', timeout: WAIT });
        await pg.locator('#registerBtn').click();
        await nv;
        const uu = new URL(pg.url());
        check(`${label}#${id} 保存成功 → 目录页 ?focus=${id}&notice=${wantCode}`, uu.search === `?focus=${id}&notice=${wantCode}`, uu.pathname + uu.search);
        await catalogRows(pg); await highlighted(pg, id); await toastSeen(pg, new RegExp('^' + want + '$')); await urlCleaned(pg);
        const tx = await toasts(pg);
        check(`${label}#${id} 保存成功 → 目录页 toast 文本「${want}」，且地址栏已清掉 notice`, tx.includes(want) && pu.length === 1 && !/notice/.test(await pg.evaluate(() => location.search)), tx);
        await pg.reload({ waitUntil: 'networkidle' }); await catalogRows(pg);
        check(`${label}#${id} 刷新目录页不再弹「${want}」`, !(await toasts(pg)).includes(want), await toasts(pg));
        await pg.close();
      }

      // T3b（末次合并审 H2）：配置台保存遇 409（服务端版本条件写冲突「该模型已被他人修改，请刷新后重试」）→ 提示并提供刷新。
      //   DIM#50 / DWD#52 各两条：confirm 取消 = 留在配置台（地址 / 编辑态不变、不离开页面），确定 = 重载本页（再次加载到同一编辑目标）；两条都：PUT 恰 1 次、出现恰 1 个 confirm（文案含服务端提示与「刷新」）、toast 显示服务端提示。
      //   路由替身：PUT /api/models/<id> 回 409。变异 MC_MUT=h2-wb-off：把页面源里的 `res.status === 409` 判断换成 false（409 落到通用「更新失败」toast，没有对话框）→ 判红。
      const MSG409 = '该模型已被他人修改，请刷新后重试';
      for (const [id, label] of [[50, 'DIM'], [52, 'DWD']]) {
        for (const choice of ['dismiss', 'accept']) {
          const lab = `T3b-409-${id}-${choice}`;
          const pg = await newPage(admin, lab);
          pg.removeAllListeners('dialog');
          const dialogs = [];
          pg.on('dialog', async (d) => { dialogs.push({ type: d.type(), message: d.message() }); try { if (choice === 'accept') await d.accept(); else await d.dismiss(); } catch (_) { /* 已处理 */ } });
          if (MUT === 'h2-wb-off') {
            await pg.route('**/Model_Workbench.html*', async (route) => {
              const resp = await route.fetch();
              const body = (await resp.text()).split('res.status === 409').join('false');
              await route.fulfill({ response: resp, body });
            });
          }
          await pg.goto(`${BASE}/Model_Workbench.html?id=${id}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, id);
          let nPut = 0;
          await pg.route(`**/api/models/${id}`, async (route) => {
            if (route.request().method() === 'PUT') { nPut++; return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: MSG409 }) }); }
            return route.continue();
          });
          const reloadP = choice === 'accept' ? pg.waitForEvent('load', { timeout: 4000 }).then(() => true, () => false) : null;
          await pg.locator('#registerBtn').click();
          const t0 = Date.now(); while (dialogs.length === 0 && Date.now() - t0 < 4000) await sleep(50);   // 正向信号：对话框出现（有界轮询）
          const reloaded = reloadP ? await reloadP : null;
          if (reloaded) await wbReady(pg, id);
          const st = await state(pg);
          const tx = await toasts(pg);
          check(`${label}#${id} 保存遇 409（点「${choice === 'accept' ? '确定' : '取消'}」）：PUT 恰 1 次、恰 1 个对话框且是 confirm、文案含服务端提示与「刷新」`, nPut === 1 && dialogs.length === 1 && dialogs[0].type === 'confirm' && dialogs[0].message.includes(MSG409) && dialogs[0].message.includes('刷新'), { nPut, dialogs });
          if (choice === 'dismiss') check(`${label}#${id} 点「取消」：留在配置台（路径 / 编辑态不变、没跳去目录页），toast 显示服务端提示`, st.path === 'Model_Workbench.html' && (label === 'DIM' ? st.dim === id : st.dwd === id) && tx.includes(MSG409), { st, tx });
          else check(`${label}#${id} 点「确定」：本页重载（load 事件发生）并重新加载到同一编辑目标 #${id}，仍在配置台`, reloaded === true && st.path === 'Model_Workbench.html' && (label === 'DIM' ? st.dim === id : st.dwd === id) && st.search === `?id=${id}&mode=edit`, { reloaded, st });
          await pg.close();
        }
      }

      page = await newPage(admin, 'T3-cancel');
      await page.goto(`${BASE}/Model_Workbench.html?id=52&mode=edit`, { waitUntil: 'load' }); await wbReady(page, 52);
      const puts2 = await captureWrites(page, 'PUT', '**/api/models/52', '{"noChange":true}');
      navP = page.waitForURL(toCatalogUrl, { waitUntil: 'commit', timeout: WAIT });
      await page.locator('#cancelEditBtn').click();
      await navP;
      u = new URL(page.url());
      check('DWD#52「取消编辑」→ 目录页 ?focus=52', u.pathname === '/Model_Center.html' && u.search === '?focus=52', u.pathname + u.search);
      await catalogRows(page); await highlighted(page, 52); await urlCleaned(page);
      await page.waitForLoadState('networkidle');
      check('放弃修改没有发出 PUT', puts2.length === 0, puts2.length);
      check('取消 / 放弃路径目录页无成功类 toast（配置更新成功 / 配置未变更 / 注册成功）', !(await toasts(page)).some(t => /配置更新成功|配置未变更|注册成功/.test(t)), await toasts(page));
      await page.close();

      page = await newPage(admin, 'T3-close-view');
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=view`, { waitUntil: 'load' }); await wbReady(page, 50);
      await page.waitForFunction(() => { const b = document.getElementById('cancelEditBtn'); return b && !b.disabled && b.style.display !== 'none'; }, null, { timeout: WAIT });
      navP = page.waitForURL(toCatalogUrl, { waitUntil: 'commit', timeout: WAIT });
      await page.locator('#cancelEditBtn').click();
      await navP;
      u = new URL(page.url());
      check('只读「关闭」→ 目录页 ?focus=50（不带 notice）', u.pathname === '/Model_Center.html' && u.search === '?focus=50', u.pathname + u.search);
      await catalogRows(page); await urlCleaned(page); await page.waitForLoadState('networkidle');
      check('只读「关闭」目录页无成功类 toast', !(await toasts(page)).some(t => /配置更新成功|配置未变更|注册成功/.test(t)), await toasts(page));
      await page.close();
    }

    // ---- T4 注册成功 → 目录页定位新模型 ----
    console.log('T4 注册成功 → 目录页定位');
    {
      const page = await newPage(admin, 'T4-register');
      await page.goto(`${BASE}/Model_Workbench.html`, { waitUntil: 'load' });
      await page.waitForSelector('#genLayer', { timeout: WAIT });
      await page.waitForFunction(() => document.getElementById('genDomain').options.length > 1, null, { timeout: WAIT });
      await page.evaluate(() => {
        document.getElementById('genLayer').value = 'dwd'; onLayerChange();
        document.getElementById('genObject').value = 'probe'; document.getElementById('genDesc').value = '探针';
        const dom = document.getElementById('genDomain'); dom.value = dom.options[1].value; generateName();
      });
      await page.locator('#registerBtn').click();
      await page.waitForFunction(() => getComputedStyle(document.getElementById('registerModal')).display !== 'none', null, { timeout: WAIT });
      const posts = await captureWrites(page, 'POST', '**/api/models', '{"id":55,"message":"ok"}');
      const navP = page.waitForURL(toCatalogUrl, { waitUntil: 'commit', timeout: WAIT });
      await page.locator('#confirmRegisterBtn').click();
      await navP;
      const u = new URL(page.url());
      check('注册成功 → 目录页 ?focus=<响应里的新 id>&notice=registered', u.pathname === '/Model_Center.html' && u.search === '?focus=55&notice=registered', u.pathname + u.search);
      await catalogRows(page); await highlighted(page, 55);
      await toastSeen(page, /^模型注册成功！下一步：在任务池中发布对应开发任务$/); await urlCleaned(page);
      check('注册成功 → 目录页 toast 文本为原文案，地址栏已清掉 notice', (await toasts(page)).includes('模型注册成功！下一步：在任务池中发布对应开发任务') && !/notice/.test(await page.evaluate(() => location.search)), await toasts(page));
      await page.reload({ waitUntil: 'networkidle' }); await catalogRows(page);
      check('注册后刷新目录页不再弹提示', !(await toasts(page)).some(t => /注册成功/.test(t)), await toasts(page));
      const body = posts.length === 1 ? JSON.parse(posts[0]) : null;
      check('注册恰发一次 POST，layer=dwd 且带 config_mode / dim_config', !!body && body.layer === 'dwd' && body.config_mode === 'standard' && !!body.dim_config, posts.length);
      await page.close();
    }

    // ---- T5 viewer ----
    console.log('T5 viewer 门禁');
    {
      let page = await newPage(viewer, 'T5-edit');
      let land = await gotoAndLand(page, `${BASE}/Model_Workbench.html?id=50&mode=edit`, toCatalogUrl);
      await catalogRows(page); await toastSeen(page, /查看者/); await urlCleaned(page);
      let st = await state(page);
      check('viewer 打开 ?id=50&mode=edit → 重定向回目录页并提示，未进入编辑态', land.path === 'Model_Center.html' && st.dim === null && st.dwd === null, { land, st });
      await page.close();
      page = await newPage(viewer, 'T5-register');
      land = await gotoAndLand(page, `${BASE}/Model_Workbench.html`, toCatalogUrl);
      await catalogRows(page); await toastSeen(page, /查看者/);
      check('viewer 打开注册（无 id）→ 重定向回目录页并提示', land.path === 'Model_Center.html', land);
      await page.close();
      page = await newPage(viewer, 'T5-view');
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=view`, { waitUntil: 'load' }); await wbReady(page, 50);
      st = await state(page);
      check('viewer 打开 ?id=50&mode=view → 留在配置台，只读且控件全禁用', st.path === 'Model_Workbench.html' && st.dim === 50 && st.dimRO === true && await allDisabled(page), st);
      await page.close();
    }

    // ---- T6 非负责人 / 负责人 ----
    console.log('T6 非负责人 edit 降为只读');
    {
      let page = await newPage(nonowner, 'T6-nonowner');
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=edit`, { waitUntil: 'load' }); await wbReady(page, 50);
      let st = await state(page);
      check('非负责人 ?id=50&mode=edit → 只读，地址栏同步成 ?id=50&mode=view', st.dimRO === true && st.search === '?id=50&mode=view', st);
      await page.close();
      page = await newPage(owner, 'T6-owner-own');
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=edit`, { waitUntil: 'load' }); await wbReady(page, 50);
      st = await state(page);
      check('技术负责人本人 ?id=50&mode=edit → 保持编辑态', st.dimRO === false && st.search === '?id=50&mode=edit', st);
      await page.close();
      page = await newPage(owner, 'T6-owner-other');
      await page.goto(`${BASE}/Model_Workbench.html?id=55&mode=edit`, { waitUntil: 'load' }); await wbReady(page, 55);
      st = await state(page);
      check('技术负责人对非自己负责的 #55 → 只读', st.dimRO === true && st.search === '?id=55&mode=view', st);
      await page.close();
    }

    // ---- T7 ?focus ----
    console.log('T7 ?focus 入口');
    {
      let page = await newPage(admin, 'T7-missing');
      await page.goto(`${BASE}/Model_Center.html?focus=9999`, { waitUntil: 'load' });
      await toastSeen(page, /模型不存在或已删除/); await urlCleaned(page);
      await page.waitForLoadState('networkidle');
      const missToasts = (await toasts(page)).filter(t => /模型不存在或已删除/.test(t));
      const missSearch = await page.evaluate(() => location.search);
      check('?focus=<不存在> → toast「模型不存在或已删除」恰 1 条，URL 清参（search 为空）', missToasts.length === 1 && missSearch === '', { missToasts, missSearch });
      await page.close();
      const kw = rowOfName55();
      page = await newPage(admin, 'T7-search');
      await page.goto(`${BASE}/Model_Center.html?search=${encodeURIComponent(kw)}&focus=50`, { waitUntil: 'load' });
      await highlighted(page, 50);
      await page.waitForFunction(() => !/focus=/.test(location.search), null, { timeout: WAIT });
      const val = await page.evaluate(() => document.getElementById('searchKeyword').value);
      const searchAfter = await page.evaluate(() => location.search);
      check('?search=…&focus=50 → 先清空关键字搜索再定位，#50 高亮；地址栏的 search 与 focus 一起清掉（30 L-focus）', val === '' && searchAfter === '', { val, searchAfter });
      await page.close();
      page = await newPage(admin, 'T7-ods');
      await page.goto(`${BASE}/Model_Center.html?focus=6`, { waitUntil: 'load' });
      await highlighted(page, 6);
      const pg = await page.evaluate(() => currentPage);
      // C4b：currentPage 是「组页」（每页 20 组）。本套件夹具 38 行 / 37 组（唯一伴生 #53 随 #52），#6 是第 36 组 → 第 2 页（页号数值与按行算时相同，含义已变）
      check('?focus=6（ODS，第 36 组，在第 2 页）→ 跳到目标所在组页并高亮', pg === 2, pg);
      const gv = await page.evaluate(() => ({ view: getCatalogView(), loc: ModelCatalogCore.locate(catalogViewRaw(1), 6) }));
      check('getCatalogView：37 组 / 2 页，#6 在第 2 页第 16 个组（全局第 36 组）', gv.view.totalGroups === 37 && gv.view.totalPages === 2 && gv.loc && gv.loc.page === 2 && (gv.loc.page - 1) * 20 + gv.loc.index === 36, gv);
      await page.close();
    }

    // ---- T8 入口目标异常：回目录页由目录页提示 ----
    console.log('T8 目标不是 DIM/DWD / 不存在 / 已删除');
    {
      let page = await newPage(admin, 'T8-ods');
      let land = await gotoAndLand(page, `${BASE}/Model_Workbench.html?id=6&mode=edit`, toCatalogUrl);
      await catalogRows(page); await highlighted(page, 6);
      check('?id=6&mode=edit（ODS）→ 目录页 ?focus=6 并定位', land.path === 'Model_Center.html' && land.search === '?focus=6', land);
      await page.close();
      page = await newPage(admin, 'T8-missing');
      land = await gotoAndLand(page, `${BASE}/Model_Workbench.html?id=9999&mode=edit`, toCatalogUrl);
      await toastSeen(page, /模型不存在或已删除/);
      if (MUT === 'static404') { await page.evaluate(() => fetch('/assets/js/no-such-file-xyz.js')); await sleep(500); }   // 变异：额外请求一个不存在的静态资源（404）→ 不在 URL 白名单，必须判红
      check('?id=9999（不存在）→ 目录页 ?focus=9999 并提示', land.search === '?focus=9999', land);
      await page.close();
      page = await newPage(admin, 'T8-deleted');
      land = await gotoAndLand(page, `${BASE}/Model_Workbench.html?id=${FIXTURE_IDS.deletedDim}&mode=view`, toCatalogUrl);
      await toastSeen(page, /模型不存在或已删除/);
      check('已删除模型 → 目录页提示「不存在或已删除」', land.search === `?focus=${FIXTURE_IDS.deletedDim}`, land);
      await page.close();
    }

    // ---- T10 预筛修复补缺：注册入口 / 保存脚本表名 / 创建者分支 / 入口参数边界 ----
    console.log('T10 注册入口、保存脚本、创建者、入口参数');
    {
      // M1 目录页「注册新模型」入口：admin / user 可见，viewer 不可见；点击 → 配置台注册模式
      for (const [ctx, label, who] of [[admin, 'T10-reg-admin', 'admin'], [owner, 'T10-reg-owner', 'user']]) {
        const pg = await newPage(ctx, label);
        await pg.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' }); await catalogRows(pg);
        const vis = await pg.locator('#registerNewModelBtn').isVisible();
        check(`${who} 在目录页看得到「注册新模型」按钮`, vis === true, vis);
        const nv = pg.waitForURL(toWbUrl, { waitUntil: 'commit', timeout: WAIT });
        await pg.locator('#registerNewModelBtn').click();
        await nv;
        await pg.waitForSelector('#genLayer', { timeout: WAIT });
        await pg.waitForFunction(() => document.getElementById('genDomain').options.length > 1, null, { timeout: WAIT });
        const st = await state(pg);
        const btnText = await pg.locator('#registerBtnText').textContent();
        check(`${who} 点击「注册新模型」→ Model_Workbench.html（search 为空）且处于注册模式（无编辑目标、按钮为「注册此模型」）`, st.path === 'Model_Workbench.html' && st.search === '' && st.dim === null && st.dwd === null && /注册此模型/.test(btnText), { st, btnText });
        // C6a 预筛 LOW-1：配置台 cancelDimEditMode / cancelDwdEditMode 的「就地重置」分支已删（C6a §2）。删除依据 = 注册态取消按钮恒隐藏 + 函数在无编辑目标时什么都不做——固化成断言。
        //   变异开关 MC_MUT（仅判别力自证）：reg-cancel-visible = 注册态把按钮显示出来；reg-cancel-resets = 恢复「就地重置」（清对象名）；reg-cancel-navigates = 程序化取消会离开页面
        if (MUT === 'reg-cancel-visible') await pg.evaluate(() => { document.getElementById('cancelEditBtn').style.display = 'inline-block'; });
        if (MUT === 'reg-cancel-resets') await pg.evaluate(() => { window.cancelDimEditMode = function () { document.getElementById('genObject').value = ''; }; });
        if (MUT === 'reg-cancel-navigates') await pg.evaluate(() => { window.cancelDwdEditMode = function () { leaveWorkbench(7); }; });
        const cancelDisp = await pg.evaluate(() => getComputedStyle(document.getElementById('cancelEditBtn')).display);
        check(`${who} 注册态：#cancelEditBtn 计算样式 display=none（取消按钮只在有编辑目标时显示）`, cancelDisp === 'none', cancelDisp);
        const regFields = () => ['genLayer', 'genDomain', 'genObject', 'genDesc'].map((i) => document.getElementById(i).value);
        const regBefore = await pg.evaluate((fnSrc) => { const f = new Function('return ' + fnSrc)(); const d = document.getElementById('genDomain'); d.value = d.options[1].value; document.getElementById('genObject').value = 'wbt_cancel_probe'; document.getElementById('genDesc').value = 'wbt 注册态取消探针'; window.__unloads = 0; window.addEventListener('beforeunload', () => { window.__unloads++; }); return { path: location.pathname, fields: f() }; }, regFields.toString());
        let regAfter;
        try { regAfter = await pg.evaluate((fnSrc) => { const f = new Function('return ' + fnSrc)(); cancelDimEditMode(false); cancelDwdEditMode(false); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ path: location.pathname, fields: f(), unloads: window.__unloads })))); }, regFields.toString()); } catch (e) { regAfter = { navigated: String(e && e.message).slice(0, 80) }; }
        check(`${who} 注册态：程序化调用 cancelDimEditMode(false) 与 cancelDwdEditMode(false) 后不跳转（beforeunload 0 次、路径不变），表单字段（分层 / 业务域 / 对象名 / 描述）前后相等`, regAfter.unloads === 0 && regAfter.path === regBefore.path && JSON.stringify(regAfter.fields) === JSON.stringify(regBefore.fields), { regBefore, regAfter });
        await pg.close();
      }
      {
        const pg = await newPage(viewer, 'T10-reg-viewer');
        await pg.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' }); await catalogRows(pg);
        const vis = await pg.locator('#registerNewModelBtn').isVisible();
        check('viewer 在目录页看不到「注册新模型」按钮', vis === false, vis);
        await pg.close();
      }

      // M2 保存脚本到服务器：POST 恰 1 次，URL id 与 body.tableName 取自当前配置的模型（对照 50 / 55）
      const tn = (id) => loadModelRows().find(r => r.id === id).table_name;
      for (const id of [55, 50]) {
        const pg = await newPage(admin, 'T10-save-scripts-' + id);
        // 源表字段桩：由夹具配置的跟踪字段 / 字段映射推出，让「跟踪字段至少选一个」校验能过（同基线用例 stubFieldsFor 的思路）
        const sc = (loadModelRows().find(r => r.id === id).dim_config || {}).scdConfig || {};
        const names = [...(sc.trackFields || []), ...(sc.fieldMappings || []).map(m => m.srcField)].filter((n, i, a) => n && a.indexOf(n) === i);
        await pg.route('**/api/warehouse/describe-table*', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(names.map(n => ({ column_name: n, data_type: 'nvarchar(128)', column_comment: '' }))) }));
        await pg.goto(`${BASE}/Model_Workbench.html?id=${id}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, id);
        const posts = [];
        await pg.route('**/api/models/*/save-scripts', async (route) => {
          const req = route.request();
          posts.push({ url: req.url(), body: req.postData() });
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"脚本已保存","savedFiles":[],"configRevBumped":false}' });
        });
        await pg.waitForFunction(() => { const c = getScdConfig(); return !!c.businessKey && c.trackFields.length > 0; }, null, { timeout: WAIT });   // 等配置灌完（信号：业务标识与跟踪字段都已就位）
        await pg.evaluate(() => openDdlPreviewModal());   // 编辑态下 #generateDdlBtn 隐藏，基线用例同样直接调函数
        await pg.waitForSelector('#ddlPreviewModal', { timeout: WAIT });
        await pg.locator('#ddlPreviewModal button', { hasText: '保存到服务器' }).click();
        await toastSeen(pg, /脚本已保存/);
        const body = posts.length === 1 ? JSON.parse(posts[0].body) : null;
        check(`#${id} 保存脚本：POST 恰 1 次、URL 为 /api/models/${id}/save-scripts、body.tableName 为该模型表名`, posts.length === 1 && new URL(posts[0].url).pathname === `/api/models/${id}/save-scripts` && body.tableName === tn(id), { n: posts.length, url: posts[0] && posts[0].url, tableName: body && body.tableName, want: tn(id) });
        await pg.close();
      }

      // L5① 创建者分支：非技术负责人但 created_by_id 是自己 → 保持编辑态
      {
        const pg = await newPage(owner, 'T10-creator');
        await pg.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DIM_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, CREATOR_DIM_ID);
        const st = await state(pg);
        check('创建者（tech_owner 为他人）?id=<创建的 DIM>&mode=edit → 保持编辑态（dimEditReadOnly === false，地址栏不改写）', st.dim === CREATOR_DIM_ID && st.dimRO === false && st.search === `?id=${CREATOR_DIM_ID}&mode=edit`, st);
        await pg.close();
        const pg2 = await newPage(nonowner, 'T10-creator-other');
        await pg2.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DIM_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg2, CREATOR_DIM_ID);
        const st2 = await state(pg2);
        check('对照：另一位普通用户（既非负责人也非创建者）打开同一模型 edit → 降为只读', st2.dimRO === true && st2.search === `?id=${CREATOR_DIM_ID}&mode=view`, st2);
        await pg2.close();
      }

      // 30T M2：DWD 创建者分支
      {
        const pg = await newPage(owner, 'T10-creator-dwd');
        await pg.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DWD_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, CREATOR_DWD_ID);
        const st = await state(pg);
        check('创建者（tech_owner 为他人）?id=<创建的 DWD>&mode=edit → 保持编辑态（dwdEditReadOnly === false，地址栏不改写）', st.dwd === CREATOR_DWD_ID && st.dwdRO === false && st.search === `?id=${CREATOR_DWD_ID}&mode=edit`, st);
        await pg.close();
        const pg2 = await newPage(nonowner, 'T10-creator-dwd-other');
        await pg2.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DWD_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg2, CREATOR_DWD_ID);
        const st2 = await state(pg2);
        check('对照：另一位普通用户打开同一 DWD edit → 降为只读（dwdEditReadOnly === true，地址栏 mode=view）', st2.dwdRO === true && st2.search === `?id=${CREATOR_DWD_ID}&mode=view`, st2);
        await pg2.close();
      }

      // L5② 无 mode / 非法 mode → 只读
      for (const q of ['?id=50', '?id=50&mode=foo']) {
        const pg = await newPage(admin, 'T10-mode-' + q);
        await pg.goto(`${BASE}/Model_Workbench.html${q}`, { waitUntil: 'load' }); await wbReady(pg, 50);
        const st = await state(pg);
        check(`${q} → 只读（dimEditReadOnly === true）`, st.dim === 50 && st.dimRO === true, st);
        await pg.close();
      }

      // L5③ / 30T L1：非法 id → 回目录页且 search 为空（入口规则：id 必须全由数字组成才算数字，见 Model_Workbench.html 入口解析）
      //   ?id=0 通过数字判定，但模型 0 不存在 → 同样回目录页（不带 focus）；?id=50&id=52 取首个（URLSearchParams.get 的行为）→ 打开 #50 只读
      for (const q of ['abc', '50.5', '-1', '0', '1e2', '']) {
        const pg = await newPage(admin, 'T10-id-' + (q || 'empty'));
        const land = await gotoAndLand(pg, `${BASE}/Model_Workbench.html?id=${q}`, toCatalogUrl);
        await catalogRows(pg);
        check(`?id=${q} → 回到 Model_Center.html 且 search 为空`, land.path === 'Model_Center.html' && land.search === '' && (await pg.evaluate(() => location.search)) === '', land);
        await pg.close();
      }
      {
        const pg = await newPage(admin, 'T10-id-dup');
        await pg.goto(`${BASE}/Model_Workbench.html?id=50&id=52`, { waitUntil: 'load' }); await wbReady(pg, 50);
        const st = await state(pg);
        check('?id=50&id=52 → 取首个 id（#50），无 mode 按只读；不会打开 #52', st.dim === 50 && st.dimRO === true && st.dwd === null, st);
        await pg.close();
      }

      // 30T H1 / 30T-R：稳定加载零 console error（不放行 Failed to fetch）——配置台 DWD 编辑 / 伴生 DWD 只读 / custom DIM 编辑 / 标准 DIM#50 编辑 + 目录页各一次，
      //   加载完成后静置 NAV_ABORT_WINDOW_MS + 1000ms（= 3000ms，越过放行窗口，窗口外的任何 Failed to fetch 都会冒出来）。静置只是「留出时间让迟到的错误冒出来」，不是同步手段；同步仍靠 wbReady / catalogRows。
      //   变异开关 MC_MUT（验证时临时把默认值改掉再还原）：refuse1000 = 导航加载完成后立刻注入一次指向未监听端口的失败 fetch（连接拒绝，不是 ERR_ABORTED）；
      //   late2500 = 导航后 2500ms 注入同样的失败 fetch；static404 见 T8-missing（额外请求一个不存在的静态资源）。
      const STABLE_SETTLE_MS = NAV_ABORT_WINDOW_MS + 1000;
      const injectRefused = (pg) => pg.evaluate(() => { fetch('http://127.0.0.1:9/x').catch(e => console.error(e)); });
      const stableCases = [
        { label: 'T12-stable-52', url: '/Model_Workbench.html?id=52&mode=edit', ready: (pg) => wbReady(pg, 52), desc: '配置台 ?id=52&mode=edit（DWD）' },
        { label: 'T12-stable-53', url: `/Model_Workbench.html?id=${FIXTURE_IDS.dwdCompanion}&mode=view`, ready: (pg) => wbReady(pg, FIXTURE_IDS.dwdCompanion), desc: '配置台 ?id=53&mode=view（伴生 DWD）', companion: true },
        { label: 'T12-stable-58', url: `/Model_Workbench.html?id=${FIXTURE_IDS.dimCustom}&mode=edit`, ready: (pg) => wbReady(pg, FIXTURE_IDS.dimCustom), desc: '配置台 ?id=58&mode=edit（custom DIM）' },
        { label: 'T12-stable-50', url: '/Model_Workbench.html?id=50&mode=edit', ready: (pg) => wbReady(pg, 50), desc: '配置台 ?id=50&mode=edit（标准 DIM）' },
        { label: 'T12-stable-catalog', url: '/Model_Center.html', ready: (pg) => catalogRows(pg), desc: '目录页 Model_Center.html 直接打开' },
      ];
      for (const c of stableCases) {
        const pg = await newPage(admin, c.label);
        await pg.goto(`${BASE}${c.url}`, { waitUntil: 'load' });
        if (MUT === 'refuse1000') await injectRefused(pg);
        await c.ready(pg);
        if (MUT === 'late2500') { await sleep(2500); await injectRefused(pg); }
        await sleep(STABLE_SETTLE_MS);
        if (c.companion) {   // 30 L-showDwdEditModeHint：伴生表只读打开，「跳转到主表配置」链接的 mode 由入参 readOnly 决定 → view
          const onclick = await pg.evaluate(() => { const a = Array.from(document.querySelectorAll('a')).find(x => /跳转到主表配置/.test(x.textContent)); return a ? a.getAttribute('onclick') : null; });
          check('伴生 DWD 只读打开：「跳转到主表配置」链接指向 mode=view', !!onclick && /mode=view/.test(onclick) && !/mode=edit/.test(onclick), onclick);
        }
        const mine = errors.filter(e => e.label === c.label).map(e => ({ text: e.text, url: e.url, inAbortWindow: e.inAbortWindow }));
        check(`${c.desc} 稳定加载后静置 ${STABLE_SETTLE_MS}ms：console error / pageerror = 0（不放行 Failed to fetch）`, mine.length === 0, mine);
        await pg.close();
      }
    }

    // ---- T12b（末次合并审 M7）伴生表提示链接真点击：onclick 少一个右括号时点击抛 SyntaxError、页面不跳（上面 T12 只读 onclick 文本，抓不到）----
    //   伴生 #53 的主表是 #52（夹具 companion_of）。该链接只在 readOnly && companion_of 时渲染，所以链接里 `readOnly ? 'view' : 'edit'` 的 'edit' 一支不可达（链接恒指向 mode=view）。
    //   两种只读进入各一条：管理员以 mode=view 进入；非负责人以 mode=edit 进入（被降为只读，见 T10）。点击后都落到 ?id=52&mode=view。
    //   变异（去掉右括号，MC_MUT=m7-paren）：用 page.route 改写配置台页面源，把 `'edit'}')"` 还原成 `'edit'}'"`，点击后不跳转 → 两条都判红。
    console.log('T12b 伴生表「跳转到主表配置」真点击（M7）');
    for (const q of ['view', 'edit']) {
      const label = 'T12b-companion-link-' + q;
      const pg = await newPage(q === 'edit' ? nonowner : admin, label);
      if (MUT === 'm7-paren') {
        await pg.route('**/Model_Workbench.html*', async (route) => {
          const resp = await route.fetch();
          const body = (await resp.text()).replace("'edit'}')\"", "'edit'}'\"");
          await route.fulfill({ response: resp, body });
        });
      }
      await pg.goto(`${BASE}/Model_Workbench.html?id=${FIXTURE_IDS.dwdCompanion}&mode=${q}`, { waitUntil: 'load' });
      await wbReady(pg, FIXTURE_IDS.dwdCompanion);
      const link = pg.locator('#dwdEditModeHint a', { hasText: '跳转到主表配置' });
      await link.waitFor({ state: 'visible', timeout: WAIT });
      const navP = pg.waitForURL((u) => /Model_Workbench\.html$/.test(u.pathname) && u.search === '?id=52&mode=view', { waitUntil: 'commit', timeout: 4000 }).then(() => true, () => false);
      await link.click();
      const jumped = await navP;
      check(`伴生 #53 以 mode=${q} 进入 → 点「跳转到主表配置」→ 地址变为 Model_Workbench.html?id=52&mode=view`, jumped, { search: new URL(pg.url()).search });
      if (jumped) {
        await wbReady(pg, 52);
        const st = await state(pg);
        check(`  └ 落点页是主表 #52 的只读配置（dwdEditReadOnly === true，无伴生提示链接）`, st.dwd === 52 && st.dwdRO === true && (await pg.locator('#dwdEditModeHint a', { hasText: '跳转到主表配置' }).count()) === 0, st);
      }
      const mine = errors.filter(e => e.label === label).map(e => e.text);
      check(`  └ 点击过程零 console error / pageerror`, mine.length === 0, mine);
      await pg.close();
    }

    // ---- T11（C3c）其他页导航「模型配置台」→ 配置台注册模式 ----
    console.log('T11 导航入口（Task_Pool 的「数据中心」下拉 → 模型配置台）');
    {
      const pg = await newPage(admin, 'T11-nav');
      await pg.goto(`${BASE}/Task_Pool.html`, { waitUntil: 'load' });
      const dd = pg.locator('.nav-dropdown', { has: pg.locator('.nav-dropdown-menu a[href="/Model_Workbench.html"]') });
      await dd.locator('.nav-dropdown-trigger').hover();
      const item = dd.locator('.nav-dropdown-menu a[href="/Model_Workbench.html"]');
      await item.waitFor({ state: 'visible', timeout: WAIT });
      const itemText = (await item.textContent()).replace(/\s+/g, '');
      const nv = pg.waitForURL(toWbUrl, { waitUntil: 'commit', timeout: WAIT });
      await item.click();
      await nv;
      await pg.waitForSelector('#genLayer', { timeout: WAIT });
      await pg.waitForFunction(() => document.getElementById('genDomain').options.length > 1, null, { timeout: WAIT });
      const st = await state(pg);
      const btnText = await pg.locator('#registerBtnText').textContent();
      check('Task_Pool「数据中心」下拉里的「模型配置台」项文字正确', itemText === '模型配置台', itemText);
      check('点击「模型配置台」→ /Model_Workbench.html、search 为空、注册模式（无编辑目标、按钮为「注册此模型」）', st.path === 'Model_Workbench.html' && st.search === '' && st.dim === null && st.dwd === null && /注册此模型/.test(btnText), { st, btnText });
      await pg.close();
    }

    // ---- T13（C4a P22）ID 类型混用：目录页行按钮 / 配置台门禁对「数字 / 字符串」ID 混用的判断 ----
    //   背景：两份页面级基线的输入全是数字 ID，到不了 P22 的改动面；这里用 page.route 改写响应（route.fetch() 后改 JSON 再 fulfill），
    //   只改写 GET /api/models（路径精确等于 /api/models 的列表）、GET /api/models/70、GET /api/auth/me。用户 owner_user（id 3）。
    //   #70 = DIM、创建者 3、技术负责人为他人；#65 = DIM、技术负责人「管理员」（用户 3 对它既非负责人也非创建者）。
    console.log('T13 P22 ID 类型混用（目录页行按钮 / 配置台门禁）');
    {
      const jsonFulfill = async (route, mutate) => {
        const resp = await route.fetch();
        const j = await resp.json();
        const out = mutate(j) || j;
        await route.fulfill({ status: resp.status(), contentType: 'application/json', body: JSON.stringify(out) });
      };
      // C4c-2：旧口径按按钮文字找（编辑 ▾ 下拉 / 「配置」只读按钮 / 删除 / 验收），新结构按 data-act 找：
      //   editDropdown = 有 edit-config 项（可编辑 DIM / DWD）；cfgBtn = 有 view-config 项（只读 DIM / DWD）；delDisabled = delete 项的 disabled；
      //   验收：DIM / DWD 有权限时是 [data-menu="validate"] 触发按钮（valDropdown 真），否则是置灰的 button[data-act="validate"]（读其 disabled / title）。
      const rowInfo = (pg, id) => pg.evaluate((id) => {
        const tr = document.querySelector(`#modelListBody [data-id="${id}"]`);
        if (!tr) return null;
        const del = tr.querySelector('.model-row-actions [data-act="delete"]');
        const vMenu = tr.querySelector('.model-row-actions [data-menu="validate"]');
        const vDirect = tr.querySelector('.model-row-actions > [data-act="validate"]');
        const val = vMenu || vDirect;
        return { editDropdown: !!tr.querySelector('.model-row-actions [data-act="edit-config"]'), cfgBtn: !!tr.querySelector('.model-row-actions [data-act="view-config"]'), delDisabled: del ? del.disabled : null, valDisabled: val ? val.disabled : null, valTitle: val ? val.title : '', valDropdown: !!vMenu };
      }, id);
      // 打开目录页（owner_user），按需改写列表 / me；目标行不在第 1 页时先 highlightModel（会同步翻页并重渲染）
      const openCatalogMixed = async (label, { list, me, ctx }) => {
        const pg = await newPage(ctx || owner, label);
        if (list) await pg.route((u) => u.pathname === '/api/models', (route) => (route.request().method() === 'GET' ? jsonFulfill(route, list) : route.continue()));
        if (me) await pg.route((u) => u.pathname === '/api/auth/me', (route) => (route.request().method() === 'GET' ? jsonFulfill(route, me) : route.continue()));
        await pg.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await catalogRows(pg);
        await pg.waitForFunction(() => typeof allModelsData !== 'undefined' && allModelsData.length > 0, null, { timeout: WAIT });
        for (const id of [CREATOR_DIM_ID, 65]) { if (!(await pg.evaluate((i) => !!document.querySelector(`#modelListBody [data-id="${i}"]`), id))) { await pg.evaluate((i) => highlightModel(i), id); await pg.waitForSelector(`#modelListBody [data-id="${id}"]`, { timeout: WAIT }); } }
        return pg;
      };
      const setId = (id, field, val) => (j) => { const m = j.find(x => x.id === id); m[field] = val; };
      const editable = (r) => !!r && r.editDropdown === true && r.cfgBtn === false && r.delDisabled === false;
      const readOnly = (r) => !!r && r.editDropdown === false && r.cfgBtn === true && r.delDisabled === true;
      const validatable = (r) => !!r && r.valDropdown === true && r.valDisabled === false;
      const notValidatable = (r) => !!r && r.valDropdown === false && r.valDisabled === true && r.valTitle === '无验收权限';
      // 现行严格相等语义（P22 之前）的实现，用于变异：页面加载后换进去再重渲染，所有「混用应为 true」的断言必须判红
      const installStrict = (pg) => pg.evaluate(() => {
        const n = (s) => (s ? String(s).trim().toLowerCase() : '');
        window.userCanEditModel = function (model) { const nm = currentUser ? (currentUser.display_name || currentUser.username) : null; return !!((currentUser && currentUser.role === 'admin') || (nm && n(model.tech_owner) === n(nm)) || (currentUser && currentUser.id && model.created_by_id === currentUser.id)); };
        window.userCanValidateModel = function (model) { const nm = currentUser ? (currentUser.display_name || currentUser.username) : null; return !!((currentUser && (currentUser.role === 'admin' || currentUser.role === 'publisher')) || (nm && n(model.tech_owner) === n(nm)) || (currentUser && currentUser.id && model.latest_active_task_owner_id === currentUser.id)); };
        renderModelsPage();
      });

      // 类型探针（不改写）：现行输入全是 number / null；admin / owner / nonowner / viewer 四个角色各探一次
      for (const [role, rctx] of [['admin', admin], ['owner', owner], ['nonowner', nonowner], ['viewer', viewer]]) {
        const pg = await openCatalogMixed('T13-probe-' + role, { ctx: rctx });
        const probe = await pg.evaluate(() => ({ uid: typeof currentUser.id, rows: allModelsData.length, bad: allModelsData.filter(m => !(m.created_by_id === null || typeof m.created_by_id === 'number') || !(m.latest_active_task_owner_id === null || typeof m.latest_active_task_owner_id === 'number')).map(m => m.id) }));
        check(`类型探针（${role}）：typeof currentUser.id === number，且 allModelsData 每行 created_by_id / latest_active_task_owner_id 都是 number 或 null（P22 的输入域在现行数据外）`, probe.uid === 'number' && probe.rows > 0 && probe.bad.length === 0, probe);
        if (role === 'owner') {
          const r70 = await rowInfo(pg, CREATOR_DIM_ID), r65 = await rowInfo(pg, 65);
          check('对照（不改写）：#70 创建者数字 ID 全等 → 可编辑；#65 无任务 owner → 验收置灰', editable(r70) && notValidatable(r65), { r70, r65 });
        }
        await pg.close();
      }
      // 目录页 · 编辑权限：创建者 ID 字符串化
      {
        const pg = await openCatalogMixed('T13-edit-str', { list: setId(CREATOR_DIM_ID, 'created_by_id', '3') });
        const r = await rowInfo(pg, CREATOR_DIM_ID);
        check("目录页：#70 created_by_id: '3'（用户 id 为数字 3）→ 行内 ⋯ 菜单含「编辑配置」（可编辑）、删除可用", editable(r), r);
        await installStrict(pg);
        const r2 = await rowInfo(pg, CREATOR_DIM_ID);
        check('变异：把 userCanEditModel 换成严格相等实现后重渲染 → 同一行变为只读「配置」、删除置灰（断言抓得住严格相等）', readOnly(r2), r2);
        await pg.close();
      }
      {
        const pg = await openCatalogMixed('T13-edit-str-other', { list: setId(CREATOR_DIM_ID, 'created_by_id', '4') });
        const r = await rowInfo(pg, CREATOR_DIM_ID);
        check("对照：#70 created_by_id: '4' → 「配置」只读按钮、删除置灰", readOnly(r), r);
        await installStrict(pg);
        check('对照变异：严格相等实现下 #70 \'4\' 仍为只读（对照例不变）', readOnly(await rowInfo(pg, CREATOR_DIM_ID)));
        await pg.close();
      }
      {
        const pg = await openCatalogMixed('T13-edit-noncanon', { list: setId(CREATOR_DIM_ID, 'created_by_id', '03') });
        check("对照（codex 33）：#70 created_by_id: '03'（用户 id 3，非规范字符串，String 精确比较不等）→ 只读「配置」、删除置灰", readOnly(await rowInfo(pg, CREATOR_DIM_ID)));
        await pg.close();
      }
      // 目录页 · /api/auth/me 的 id 改成字符串、列表仍是数字
      {
        const pg = await openCatalogMixed('T13-me-str', { me: (j) => { j.id = String(j.id); } });
        const r = await rowInfo(pg, CREATOR_DIM_ID);
        check("目录页：/api/auth/me 的 id 改成 '3'、列表 created_by_id 仍是数字 3 → 同为可编辑", editable(r), r);
        await installStrict(pg);
        check('变异：严格相等实现下该组合变为只读（判红）', readOnly(await rowInfo(pg, CREATOR_DIM_ID)));
        await pg.close();
      }
      {
        const pg = await openCatalogMixed('T13-me-str-other', { me: (j) => { j.id = String(j.id); }, list: setId(CREATOR_DIM_ID, 'created_by_id', 4) });
        check("对照：me.id 为 '3'、列表里 #70 的 created_by_id 为 4 → 不可编辑", readOnly(await rowInfo(pg, CREATOR_DIM_ID)));
        await pg.close();
      }
      // 目录页 · 验收权限：任务 owner ID 字符串化
      {
        const pg = await openCatalogMixed('T13-val-str', { list: setId(65, 'latest_active_task_owner_id', '3') });
        const r = await rowInfo(pg, 65);
        check("目录页：#65（技术负责人为他人）latest_active_task_owner_id: '3' → 验收菜单触发按钮可用", validatable(r), r);
        await installStrict(pg);
        check('变异：严格相等实现下 #65 验收置灰（判红）', notValidatable(await rowInfo(pg, 65)));
        await pg.close();
      }
      {
        const pg = await openCatalogMixed('T13-val-str-other', { list: setId(65, 'latest_active_task_owner_id', '4') });
        const r = await rowInfo(pg, 65);
        check("对照：#65 latest_active_task_owner_id: '4' → 验收置灰、title=\"无验收权限\"", notValidatable(r), r);
        await pg.close();
      }
      // 配置台门禁：GET /api/models/70 的 created_by_id 字符串化
      for (const [val, wantRO, label] of [['3', false, 'T13-wb-str'], ['4', true, 'T13-wb-str-other'], ['03', true, 'T13-wb-str-noncanon']]) {
        const pg = await newPage(owner, label);
        await pg.route((u) => u.pathname === `/api/models/${CREATOR_DIM_ID}`, (route) => (route.request().method() === 'GET' ? jsonFulfill(route, (j) => { j.created_by_id = val; }) : route.continue()));
        await pg.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DIM_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, CREATOR_DIM_ID);
        const st = await state(pg);
        if (!wantRO) check(`配置台：/api/models/70 返回 created_by_id: '3' → ?id=70&mode=edit 保持编辑态（dimEditReadOnly === false、地址栏不改写）`, st.dim === CREATOR_DIM_ID && st.dimRO === false && st.search === `?id=${CREATOR_DIM_ID}&mode=edit`, st);
        else check(`对照：created_by_id: '${val}'${val === '03' ? '（非规范字符串，codex 33）' : ''} → 降为只读、地址栏改成 mode=view`, st.dim === CREATOR_DIM_ID && st.dimRO === true && st.search === `?id=${CREATOR_DIM_ID}&mode=view`, st);
        await pg.close();
      }
      // L4：门禁变异走真实进入路径——路由改写 Model_Workbench.html 源码，把创建者比较换成严格相等，再打开 ?id=70&mode=edit（接口返回 '3'）：
      //   混用 ID 应可编辑的例子此时必须被降为只读并把地址栏改成 mode=view（判红）；对照 '4' 的结果不变（本来就是只读）
      for (const [val, label] of [['3', 'T13-wb-mut-strict'], ['4', 'T13-wb-mut-strict-other']]) {
        const pg = await newPage(owner, label);
        let replaced = false;
        await pg.route((u) => u.pathname === '/Model_Workbench.html', async (route) => {
          const resp = await route.fetch();
          const html = await resp.text();
          const mutated = html.replace('String(model.created_by_id) === String(currentUser.id)', 'model.created_by_id === currentUser.id');
          replaced = mutated !== html;
          await route.fulfill({ status: resp.status(), headers: { ...resp.headers(), 'content-length': String(Buffer.byteLength(mutated)) }, body: mutated });
        });
        await pg.route((u) => u.pathname === `/api/models/${CREATOR_DIM_ID}`, (route) => (route.request().method() === 'GET' ? jsonFulfill(route, (j) => { j.created_by_id = val; }) : route.continue()));
        await pg.goto(`${BASE}/Model_Workbench.html?id=${CREATOR_DIM_ID}&mode=edit`, { waitUntil: 'load' }); await wbReady(pg, CREATOR_DIM_ID);
        const st = await state(pg);
        check(`门禁变异（改写页面源码为严格相等，接口 created_by_id '${val}'）：源码替换确实发生，且经真实进入路径被降为只读、地址栏改成 mode=view（'3' 时即「混用应可编辑」例判红；'4' 为对照，结果不变）`, replaced === true && st.dimRO === true && st.search === `?id=${CREATOR_DIM_ID}&mode=view`, { replaced, st });
        await pg.close();
      }
    }

    // ---- T9 两页零 console error ----
    console.log('T9 两页零 console error');
    {
      const before = errors.length;
      const page = await newPage(admin, 'T9');
      await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'networkidle' });
      await catalogRows(page);
      const cardOnCatalog = await page.evaluate(() => !!document.querySelector('.model-generator-card'));
      await page.goto(`${BASE}/Model_Workbench.html`, { waitUntil: 'networkidle' });
      const cardOnWb = await page.evaluate(() => !!document.querySelector('.model-generator-card'));
      await page.reload({ waitUntil: 'networkidle' });   // 硬刷新（同 test-sys-fastlane-playwright.js OTHER_PAGES 的口径）：reload 后再算一次零错误
      await page.waitForSelector('#genLayer', { timeout: WAIT });
      await page.goto(`${BASE}/Model_Workbench.html?id=50&mode=edit`, { waitUntil: 'networkidle' }); await wbReady(page, 50);
      await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'networkidle' });
      check('目录页没有命名助手卡、配置台有', cardOnCatalog === false && cardOnWb === true, { cardOnCatalog, cardOnWb });
      check('目录页 / 配置台（注册 / 编辑）加载与跳转过程 0 个 console error / pageerror', errors.length === before, errors.slice(before));
      await page.close();
    }
    // 跳转用例里被设计性中止的请求不算页面错误：重定向离开时进行中的 fetch 被浏览器取消（app.js 自带的 loadTasks / loadAllModels 等报 Failed to fetch）。
    // 放行条件（30T-R 硬门）：该条错误处于该 page 的「主框架导航请求开始后 2000ms」窗口内，**并且**该 page 还有未用完的可抵扣取消数（requestfailed 里 ERR_ABORTED 且在窗口内的次数），放行一条抵扣一次；
    // 连接拒绝之类的失败 fetch、窗口外的、超出取消数的一律计错。404 资源日志只放行两个设计内 URL：/api/models/9999（T8-missing）与 /api/models/0（T10-id-0），其他任何 404 都计错。
    const ALLOWED_404_PATHS = ['/api/models/9999', '/api/models/0'];
    const used = new Map();   // pageState -> 已抵扣次数
    const expected = (e) => {
      if (/status of 409/.test(e.text)) { let p = ''; try { p = new URL(e.url).pathname; } catch (_) { /* url 为空 → 不放行 */ } return /^T3b-409-/.test(e.label || '') && ['/api/models/50', '/api/models/52'].includes(p); }   // T3b 故意制造的 409（路由替身），只放行该标签 + 该路径
      if (/status of 404/.test(e.text)) { let p = ''; try { p = new URL(e.url).pathname; } catch (_) { /* url 为空 → 不放行 */ } return ALLOWED_404_PATHS.includes(p); }
      if (/Failed to fetch/.test(e.text) && e.inAbortWindow && e.pageState) { const n = used.get(e.pageState) || 0; if (n < e.pageState.credits) { used.set(e.pageState, n + 1); return true; } }
      return false;
    };
    const unexpected = errors.filter(e => !expected(e)).map(e => ({ label: e.label, text: e.text, url: e.url, inAbortWindow: e.inAbortWindow, credits: e.pageState && e.pageState.credits }));
    console.log(`  [info] 窗口内放行的 Failed to fetch ${[...used.values()].reduce((a, b) => a + b, 0)} 条（均有 ERR_ABORTED 取消请求抵扣）；全部错误记录 ${errors.length} 条`);
    check('全程所有页面 0 个非预期 console error / pageerror（仅放行「换页 2s 窗口内且有对应 ERR_ABORTED 取消请求抵扣」的 Failed to fetch，与 /api/models/9999、/api/models/0 的 404）', unexpected.length === 0, unexpected);
  } finally {
    await browser.close();
  }
  console.log(`[test-model-workbench] PASS=${nPass} FAIL=${nFail}`);
  return nFail ? 1 : 0;
}
const rowOfName55 = () => loadModelRows().find(r => r.id === 55).table_name;

(async () => {
  let code = 1;
  const dbPath = path.join(WORKDIR, 'wb.db');
  fs.mkdirSync(WORKDIR, { recursive: true });
  removeDbFiles(dbPath);
  const cleanupSync = () => {
    killServer();
    for (let i = 0; i < 20; i++) { try { removeDbFiles(dbPath); return; } catch (_) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); } }
  };
  process.on('exit', cleanupSync);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanupSync(); process.exit(130); });
  process.on('uncaughtException', (e) => { console.error(e && e.stack || e); cleanupSync(); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(e && e.stack || e); cleanupSync(); process.exit(1); });
  try { code = await main(dbPath); } catch (e) { console.error(e && e.stack || e); code = 1; } finally { await stopServerAndCleanup(dbPath); }
  process.exit(code);
})();
