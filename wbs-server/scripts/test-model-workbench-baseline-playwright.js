#!/usr/bin/env node
/**
 * #77 C3a-0：模型中心「配置台」页面级行为基线（Playwright，P1–P7 + U5）。
 *
 * 目的：C3b 要把配置台（注册 / 编辑配置 / 只读配置）从 Model_Center.html 迁到新页 Model_Workbench.html。
 *   迁之前没有任何浏览器侧回归网；本用例在 HEAD 上把「现在的行为」录成文件化基线，C3b 在新页上用同夹具重放、逐项对拍。
 *
 * 跑法（均在 wbs-server 目录下；不需要先启动任何服务——脚本自己起隔离实例）：
 *   node scripts/test-model-workbench-baseline-playwright.js            校验模式（默认）：重放 → 与基线文件逐项比较，任何差异判红
 *   node scripts/test-model-workbench-baseline-playwright.js --self-test-settle   settle 硬门自证（不起服务、只起浏览器）：活动 setInterval / >5000ms 的 setTimeout 必须判红，对照组不误报
 *   node scripts/test-model-workbench-baseline-playwright.js --self-test-compare  比较机制自测（不起服务）：登记键只在 --allow-changes 下、且值满足期望时放行；未登记键 / 第三个值仍判红
 *   node scripts/test-model-workbench-baseline-playwright.js --record   录制模式：重写基线文件（只在 HEAD 上用）；
 *        基线 meta 里存录制时 Model_Center.html 的 SHA-256，当前文件哈希不同即拒绝重录（C3a / C3b 改过页面之后不得再录）；
 *        --force-record 是显式逃生口，会打印醒目警告
 *   node scripts/test-model-workbench-baseline-playwright.js --allow-changes
 *        C3b 专用：基线 allowedChanges 里登记的键允许与基线不同，但**当前值必须满足登记的期望新值**（expect）；
 *        未登记的键仍须等于基线；登记键变成「既不是基线值也不满足期望」的第三个值照样判红
 *
 * 隔离实例（不碰 3000）：
 *   - [#106 S4b2] 不再自起 wrapper / 写死端口 3377 / 复制真实库 / 读 .env：入口第一条 `await testEnv.ready(…)`（scripts/lib/test-env.js）起隔离实例
 *     （本检出库快照 + 隔离模式 server.js，端口随机，数据根在系统临时目录，teardown 时整体删除）；`--port` / MC_BASELINE_WORKDIR 随之删除。
 *     自测模式（--self-test-*）不需要服务，但按「ready 是入口第一条有副作用语句」的规则也会先起实例（裁定 D5）。
 *   - ready() 之后在实例库里清钉钉凭证 / db_connections / 周期任务 / 任务池 / 用户（终态与原来在库副本上清洗相同），
 *     删除全部模型后按脱敏夹具（fixtures/model-workbench-baseline/models.json）以固定 id 插入，另补 25 条填充 ODS 行
 *     （让列表跨页）与 4 个测试账号（admin / viewer / 技术负责人 user / 非负责人 user）。其余业务表（验收配置、迁移标记等）
 *     仍是本机库快照的内容——本基线的测量面不读它们，但「不依赖本机库」只对模型 / 账号 / 字典这几张表成立。
 *   - JWT 秘钥取 testEnv.env().jwtSecret（实例随机密钥，与服务端同源）。
 *   - 浏览器侧会写共享 uploads 目录的请求（POST /api/models/:id/save-scripts）在 context 层一律 fulfill 拦截，不落盘。
 *
 * 冻结环境：每个 browser context 固定 timezoneId=Asia/Shanghai + clock.setFixedTime(2026-01-15T04:05:06Z)（与 golden 同一时刻）；
 *   每个页面加载后自检 new Date().toISOString() 等于固定值，不等即判红。生成器脚本头里的日期 / 生成时间因此与运行日无关。
 *
 * 取样：每个夹具新开页面（P1 补充的「连续编辑」与「陈旧 currentEditId」两例是有意同页，用来录 HEAD 的串状态缺陷）；
 *   「空闲信号」= 无在途请求 + 页面内 ≤1200ms 的 setTimeout 全部已触发（init 脚本包了 setTimeout 计数）
 *   + 状态快照哈希连续两次相同（间隔 200ms），总上限 10s，超时判红。不使用固定 sleep 当同步手段。
 *
 * 基线内容：只存哈希（12 位）、计数、键集合、布尔、枚举与「差异项名称」（结构路径，不含字段原文）；夹具本身已脱敏。
 *   顶层 allowedChanges = 方案 v0.10 §6.2 第 5、6、8、11、12 条预先登记的 10 项「已知行为变更」（AC-1..AC-10），
 *   每项是 { id, rules:[ { pathRe, expect } ] }：pathRe 是基线键路径的整串正则（可含捕获组，期望里用 $1 引用），
 *   expect 是 { eq } / { absent } / { notIncludes } / { sameAsCurrent }（见 satisfies()）。定不了新值的键不登记——
 *   C3b 若改变它们，须在该提交里逐项登记并说明理由；
 *   knownLossy = HEAD 自身的有损往返（DIM#50 派生字段 source 的 "NULL"→""、DWD#52 changeTracking.companionModelId 不回读、#55 往返差异清单）。
 *
 * C4c-2 迁移（目录列表由 tr 表格改为双行卡片 + ⋯ 菜单 + data-act 委托）：INIT_SCRIPT 的高亮探针改认条目 [data-id] 上的 data-focus-highlight 属性（highlightedEver 0 差异）；
 *   openPage / interceptWrite 的等待与 deepState.rows 改 #modelListBody [data-id]；P7 与 U5 的行内入口改走 clickRowAct（先点 ⋯ 触发按钮、再点 [data-act] 项）；
 *   U5 不再产出 rows / rowsHash（由 C4-0 矩阵接替）；actionHeaderPresent 读 #modelListOpHeader。登记 AC-16 共 9 条（p7.editMenuEntry.menuItems 2 → 6；4 角色 rows / rowsHash absent），
 *   --allow-changes 下 AC-15（11 条）与 AC-16（9 条）每条至少命中一次。baseline.json 不动。
 *   子批 2c：AC-12（16 条：13 条 rows.<id>.buttons.<i>.handler + 3 条 rowsHash，全部挂在 U5 的 rows / rowsHash 上）整体删除——U5 不再产出这两个节点，规则在真实运行里已不可能命中；其语义改由 C4-0 矩阵承担。
 *
 * 不进 FAMILY：现有 Playwright 用例（test-*-playwright.js）一律不进 run-verify-family.js（需要浏览器与长耗时，
 *   FAMILY 只收纯 node / 自起服务的 verify-* 套件）；本用例沿用此惯例，由主会话在 C3a / C3b 提交前手动跑。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const testEnv = require('./lib/test-env');

// [#106 S4b2] 顶层只有纯声明：下面这些路径 / 参数在入口函数里 `await testEnv.ready()` 之后由 initRuntime() 赋值。
let ROOT = null;
let MODELS_FILE = null;
let BASELINE_FILE = null;
let MC_HTML = null;
let BASE = null;          // testEnv.env().baseUrl
let ARGS = [];
let RECORD = false;
let ALLOW_CHANGES = false;
let FORCE_RECORD = false;
function initRuntime() {
  ROOT = path.resolve(__dirname, '..');
  const FIX_DIR = path.join(__dirname, 'fixtures', 'model-workbench-baseline');
  MODELS_FILE = path.join(FIX_DIR, 'models.json');
  BASELINE_FILE = path.join(FIX_DIR, 'baseline.json');
  MC_HTML = path.join(ROOT, 'public', 'Model_Center.html');
  BASE = testEnv.env().baseUrl;
  ARGS = process.argv.slice(2);
  RECORD = ARGS.includes('--record');
  ALLOW_CHANGES = ARGS.includes('--allow-changes');
  FORCE_RECORD = ARGS.includes('--force-record');
}
const SETTLE_LIMIT_MS = 10000;
const FIXED_ISO = '2026-01-15T04:05:06.000Z';
const TIMEZONE = 'Asia/Shanghai';

const { chromium } = require('playwright');
const jwt = require('jsonwebtoken');
const sqlite3 = require('sqlite3');

const h = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha256File = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// ---------------------------------------------------------------------------------------------
// 夹具与隔离库
// ---------------------------------------------------------------------------------------------
const FIXTURE_IDS = { dim: [50, 55, 60, 62, 65], dwd: [52, 59], dimCustom: 58, dwdCompanion: 53, ods: [6, 8], deletedDim: 66 };
const FILLER_COUNT = 25;
const USERS = [
  { id: 1, username: 'admin', display_name: '管理员', role: 'admin' },
  { id: 2, username: 'viewer_user', display_name: '测试查看者', role: 'viewer' },
  { id: 3, username: 'owner_user', display_name: '测试负责人', role: 'user' },
  { id: 4, username: 'nonowner_user', display_name: '测试非负责人', role: 'user' },
];
const loadModelRows = () => JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8')).rows;

function dbRun(db, sql, params = []) { return new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); })); }
function dbClose(db) { return new Promise((res, rej) => db.close(e => e ? rej(e) : res())); }

/** [#106 S4b2] 对实例库（ready() 已建好的隔离快照）清洗并按夹具造数。原来是起服务前在库副本上做，现在服务已在跑：只开一条 OPEN_READWRITE（不带 OPEN_CREATE）连接，关库等回调完成。
 *  整表清场：批跑只能登记为 exclusive:true 或 needsService:false，不能做共享实例成员（会抹掉同一实例上其他成员的数据）。 */
async function prepareDb(dbPath) {
  const db = await new Promise((res, rej) => { const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, e => { if (e) return rej(e); d.configure('busyTimeout', 8000); res(d); }); });
  // 清外部副作用面：钉钉凭证 / 数仓连接 / 周期任务；清与模型关联的数据与账号
  for (const t of ['system_configs', 'db_connections', 'periodic_tasks', 'model_change_logs', 'model_test_records', 'task_pool', 'data_models', 'users', 'sys_domains', 'sys_source_systems']) {
    await dbRun(db, `DELETE FROM ${t}`);
  }
  // C4b（§C-19 / L10）：本机库将来若有实现对象登记，夹具同号行会挂上对象名；表存在才清（与 C4-0 驱动一致）
  for (const t of ['model_impl_links', 'model_impl_objects']) { const ex = await new Promise((res, rej) => db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [t], (e, r) => e ? rej(e) : res(r))); if (ex) await dbRun(db, `DELETE FROM ${t}`); }
  for (const u of USERS) await dbRun(db, 'INSERT INTO users (id, username, password, display_name, role, status) VALUES (?, ?, ?, ?, ?, ?)', [u.id, u.username, 'not-used-jwt-only', u.display_name, u.role, 'active']);
  for (const [code, name] of [['dom_a', '域甲'], ['dom_b', '域乙'], ['dom_c', '域丙']]) await dbRun(db, "INSERT INTO sys_domains (code, name, description, status) VALUES (?, ?, '', 'active')", [code, name]);
  for (const [code, name] of [['SYS_A', '来源系统甲'], ['SYS_B', '来源系统乙']]) await dbRun(db, "INSERT INTO sys_source_systems (code, name, description) VALUES (?, ?, '')", [code, name]);
  // [#106 S4b2a] 与原驱动「起服务前清场」等价：原来清场在服务启动之前，服务启动时 server.js:1371 的幂等写入
  //   `INSERT OR IGNORE ... ('HRD', ...)` 会在清场之后补回 HRD，页面「来源系统」下拉（GET /api/source-systems，server.js:11702 ORDER BY code）
  //   于是是 HRD / SYS_A / SYS_B 三项，P3 注册 ODS 取 options[1] = HRD（baseline.json p3.ods.fieldHashes.source_system = e1f1dc20073a = h(JSON.stringify('HRD'))，见 hashFields）。
  //   现在清场在服务启动之后，那次启动写入被一并清掉，下拉只剩 SYS_A / SYS_B，options[1] 变成 SYS_A。这里用同一条幂等写入补回 HRD（字面量与 server.js:1371 一致）。
  await dbRun(db, "INSERT OR IGNORE INTO sys_source_systems (code, name, description) VALUES ('HRD', '人力资源系统', 'HRD 人力资源系统 - MySQL 源')");
  const COLS =['id', 'layer', 'domain', 'table_name', 'table_comment', 'tech_owner', 'biz_owner', 'update_cycle', 'status', 'created_at', 'updated_at', 'source_table', 'source_system', 'model_type', 'created_by_id', 'category', 'dim_config', 'is_deleted', 'config_mode', 'design_notes', 'companion_of'];
  const ins = (row) => dbRun(db, `INSERT INTO data_models (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`, COLS.map(c => (c === 'dim_config' ? (row.dim_config == null ? null : JSON.stringify(row.dim_config)) : (row[c] === undefined ? null : row[c]))));
  const rows = loadModelRows();
  for (const r of rows) await ins(r);
  // 软删除夹具：62 的副本（CREATED 状态、is_deleted=1），用于解释「?validate=1 不开弹窗」
  const r62 = rows.find(r => r.id === 62);
  await ins({ ...r62, id: FIXTURE_IDS.deletedDim, table_name: r62.table_name + '_gone', is_deleted: 1 });
  // 填充 ODS（按表名排序排在 ods_w* 之前，让 DIM/DWD 夹具在第 1 页、ODS#6/#8 在第 2 页，列表跨页）
  for (let i = 1; i <= FILLER_COUNT; i++) {
    const nn = String(i).padStart(2, '0');
    await ins({ id: 100 + i, layer: 'ods', domain: '', table_name: `ods_filler_${nn}_df`, table_comment: '填充', tech_owner: '管理员', biz_owner: '', update_cycle: 'df', status: 'ONLINE', created_at: '2026-01-01 08:00:00', updated_at: '2026-01-02 08:00:00', source_table: `filler_${nn}`, source_system: 'SYS_A', model_type: 'TABLE', created_by_id: 1, category: 'general', dim_config: null, is_deleted: 0, config_mode: 'standard', design_notes: null, companion_of: null });
  }
  await dbClose(db);
}

// [#106 S4b2] 原 portBusy / killServer / stopServerAndCleanup / startServer（写死 3377、按 pid 杀 wrapper 进程、等日志就绪、删库副本）整段删除：实例由 test-env 起停。
//   「服务就绪」的判定：原来靠日志 "Task Pool Server running"；改为 main() 里一次真实请求——未带 token 访问 /api/models 必须 401。

// ---------------------------------------------------------------------------------------------
// 页面取样基础设施
// ---------------------------------------------------------------------------------------------
// init 脚本：包 setTimeout（计数 ≤5000ms 的待触发定时器；28 号审 H3 由 1200 提到 5000。28-R：setInterval / 延迟 >5000ms 的 setTimeout 不参与「空闲」计数，但登记后在 settle 返回前一律硬门判红。原说明：setInterval 不计：HEAD 页面与共享脚本里只有 app.js 的 XLSX 加载轮询一处（仅批量导入时触发，本基线不涉及））、记录曾被高亮的行、记录 scrollIntoView 目标、记录 warning / error 类 toast 出现（橙 / 红底；info / success 不算「提示」，HEAD 进入编辑态时本来就会弹）
const INIT_SCRIPT = () => {
  const st = window.setTimeout, ct = window.clearTimeout, si = window.setInterval, ci = window.clearInterval;
  const live = new Map();
  window.__mcShortTimers = 0;
  // 28-R 硬门：活动的 setInterval（未 clear）与延迟 > 5000ms 且尚未触发的 setTimeout 登记在 longLive，settle 返回前若非空直接判红
  const longLive = new Map();
  const where = () => String(new Error().stack || '').split('\n').slice(2, 5).map(x => x.trim()).join(' <- ');
  window.__mcLongLive = () => Array.from(longLive.values());
  window.setTimeout = function (fn, d, ...args) {
    const short = (Number(d) || 0) <= 5000;
    let id;
    const wrapped = function (...a) {
      if (live.has(id)) { if (live.get(id)) window.__mcShortTimers--; live.delete(id); }
      longLive.delete('t' + id);
      return typeof fn === 'function' ? fn.apply(this, a) : (0, eval)(fn);
    };
    id = st.call(window, wrapped, d, ...args);
    live.set(id, short); if (short) window.__mcShortTimers++;
    if (!short) longLive.set('t' + id, { kind: 'setTimeout', delay: Number(d) || 0, where: where() });
    return id;
  };
  window.clearTimeout = function (id) { if (live.has(id)) { if (live.get(id)) window.__mcShortTimers--; live.delete(id); } longLive.delete('t' + id); return ct.call(window, id); };
  window.setInterval = function (fn, d, ...args) {
    const id = si.call(window, fn, d, ...args);
    longLive.set('i' + id, { kind: 'setInterval', delay: Number(d) || 0, where: where() });
    return id;
  };
  window.clearInterval = function (id) { longLive.delete('i' + id); return ci.call(window, id); };
  window.__mcHighlighted = [];
  window.__mcScrollCalls = [];
  window.__mcToasts = 0;
  window.__mcToastTexts = [];   // C3b：记录出现过的全部 toast 文本，配置台入口以「已加载」类 toast 作灌控件完成信号
  const origScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (...a) { window.__mcScrollCalls.push(String(this.className || this.id || this.tagName)); return origScroll.apply(this, a); };
  document.addEventListener('DOMContentLoaded', () => {
    new MutationObserver((muts) => {
      for (const m of muts) {
        const el = m.target;
        // C4c-2：高亮 = 条目 [data-id] 上的 data-focus-highlight 属性（旧：tr 的 style 背景色）；语义同「曾被高亮」，记下被设上该属性的条目 id
        if (el.dataset && el.dataset.id && el.hasAttribute('data-focus-highlight') && !window.__mcHighlighted.includes(el.dataset.id)) window.__mcHighlighted.push(el.dataset.id);
      }
    }).observe(document.body, { attributes: true, attributeFilter: ['data-focus-highlight'], subtree: true });
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1 && n.parentElement && n.parentElement.id === 'toast-container') { window.__mcToastTexts.push(n.textContent || ''); if (/217, 119, 6|220, 38, 38/.test(n.style.background)) window.__mcToasts++; }
    }).observe(document.body, { childList: true, subtree: true });
  });
};

const NAV_ABORT_WINDOW_MS = 2000;
function track(page) {
  const tr = { inflight: 0, total: 0, reqs: [], hardErrors: 0, windowFetchErrs: 0, abortCredits: 0, pageErrors: 0, dialogs: 0, lastNavAt: -Infinity };
  // 30T-R H1 / M1：Failed to fetch 的放行与「真实取消请求」绑定——
  //   窗口起点只取主框架导航请求的开始时间（framenavigated 不覆盖起点）；page 监听 requestfailed，errorText 含 ERR_ABORTED 且发生在导航窗口内的记一次「可抵扣取消数」；
  //   每条在窗口内的 TypeError: Failed to fetch 只有在还有未用完的可抵扣取消数时才放行（放行一条抵扣一次），多出来的、窗口外的一律计为错误。
  //   errors 是 getter：hardErrors（非 Failed to fetch 的错误 / 窗口外的 Failed to fetch）+ max(0, 窗口内 Failed to fetch 条数 - 可抵扣取消数)；两个事件的先后顺序不影响结果。
  page.on('request', (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) tr.lastNavAt = Date.now(); });
  Object.defineProperty(tr, 'errors', { get() { return tr.hardErrors + Math.max(0, tr.windowFetchErrs - tr.abortCredits); }, enumerable: true });
  page.on('request', (r) => { tr.inflight++; tr.total++; if (/\/api\/models/.test(r.url())) tr.reqs.push(r.method() + ' ' + new URL(r.url()).pathname.replace(/\/\d+/g, '/:id')); });
  page.on('requestfinished', () => { tr.inflight--; });
  page.on('requestfailed', (r) => { tr.inflight--; const f = r.failure(); if (f && /ERR_ABORTED/.test(f.errorText || '') && Date.now() - tr.lastNavAt <= NAV_ABORT_WINDOW_MS) tr.abortCredits++; });
  // C3b：跳转 / 重定向离开页面时，浏览器会取消进行中的 fetch，app.js 自带的 loadTasks / loadAllModels 等把它记成 console.error『TypeError: Failed to fetch』——
  //   这是换页本身的副产物，不是页面缺陷（目录页与配置台各自加载的零 console error 由 test-model-workbench-playwright.js 的 T9 单独断言），不计入 consoleErrors
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/TypeError: Failed to fetch/.test(m.text()) && Date.now() - tr.lastNavAt <= NAV_ABORT_WINDOW_MS) tr.windowFetchErrs++; else tr.hardErrors++;
    if (process.env.MC_DEBUG) console.log('[console.error]', m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => { tr.pageErrors++; if (process.env.MC_DEBUG) console.log('[pageerror]', String(e).slice(0, 300)); });
  page.on('dialog', (d) => { tr.dialogs++; d.dismiss().catch(() => {}); });
  return tr;
}
/**
 * 等到「空闲 + 快照连续两次相同（间隔 200ms）」，再做一次「稳定后再确认」：
 *   读数 r0（在途请求 / 待触发 ≤5000ms 定时器 / 请求总数）→ 等 SETTLE_CONFIRM_MS → 读数 r1 → 取快照 → 读数 r2；
 *   要求 r0 空闲且 r0 = r1 = r2、快照与稳定时相同才返回（快照期间新起的请求 / 定时器会让 r2 ≠ r1），否则回到稳定判定重来。
 * 确认等待与整个循环共用 SETTLE_LIMIT_MS 总时限，超时抛错（判红）。
 * 28-R 硬门（返回前）：页面存在活动的 setInterval，或延迟 > 5000ms 且尚未触发的 setTimeout，直接判红，不做更智能的等待。
 */
const SETTLE_CONFIRM_MS = 300;
async function assertNoLongTimers(page, what) {
  const longs = await page.evaluate(() => (window.__mcLongLive ? window.__mcLongLive() : []));
  if (longs.length) throw new Error('页面存在长期 / 周期定时器：' + longs.map(l => l.kind + ' 延迟 ' + l.delay + 'ms，创建于 ' + (l.where || '(未知位置)')).join('；') + '，需在基线里登记或改写取样（' + what + '）');
}
// C3b：深链 / 跳转用例会在取样过程中换页（目录页 → 配置台 → 目录页）。页面导航会让进行中的 evaluate 抛
// 「Execution context was destroyed」——这是换页本身，不是失败：丢弃本轮读数、从头判稳定（总时限不重置）。
const isNavError = (e) => /Execution context was destroyed|Target closed|Navigation|navigat/i.test(String(e && e.message));
async function settle(page, tr, snapFn, what) {
  const t0 = Date.now(); let prev = null;
  const overLimit = () => Date.now() - t0 > SETTLE_LIMIT_MS;
  const read = async () => ({ inflight: tr.inflight, total: tr.total, timers: await page.evaluate(() => window.__mcShortTimers) });
  for (;;) {
    if (overLimit()) throw new Error('取样超时（' + SETTLE_LIMIT_MS + 'ms 内未稳定）：' + what);
    try {
      const idle = tr.inflight === 0 && await page.evaluate(() => window.__mcShortTimers === 0);
      const cur = idle ? String(await snapFn()) : null;
      if (cur !== null && prev !== null && cur === prev) {
        const r0 = await read();
        await sleep(SETTLE_CONFIRM_MS);
        if (overLimit()) throw new Error('取样超时（确认等待计入 ' + SETTLE_LIMIT_MS + 'ms 总时限）：' + what);
        const r1 = await read();
        const snap = String(await snapFn());
        const r2 = await read();
        const same = (x, y) => x.inflight === y.inflight && x.total === y.total && x.timers === y.timers;
        if (r0.inflight === 0 && r0.timers === 0 && same(r0, r1) && same(r1, r2) && snap === cur) {
          await assertNoLongTimers(page, what);
          return;
        }
        prev = null; continue;
      }
      prev = cur;
    } catch (e) {
      if (!isNavError(e)) throw e;
      prev = null;   // 换页：丢弃本轮读数
    }
    await sleep(200);
  }
}

// ---- settle 硬门自证（--self-test-settle：不起服务，只起浏览器 + data: 页面；注入 interval / 6000ms 定时器必须判红）----
async function selfTestSettle() {
  const browser = await chromium.launch({ headless: true });
  let bad = 0, n = 0;
  const check = (label, cond, extra) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label + (extra ? '：' + extra : '')); } };
  try {
    const run = async (label, inject, expectRed, re) => {
      const ctx = await browser.newContext();
      await ctx.addInitScript(INIT_SCRIPT);
      const page = await ctx.newPage();
      const tr = track(page);
      await page.goto('data:text/html,<html><body>x</body></html>');
      await page.evaluate(inject);
      let err = null;
      try { await settle(page, tr, () => page.evaluate(() => document.body.innerHTML.length), 'self-test'); } catch (e) { err = e; }
      if (expectRed) check(label + '：判红', !!err && re.test(err.message), err ? err.message.slice(0, 160) : '未抛错');
      else check(label + '：不误报', !err, err && err.message.slice(0, 160));
      await ctx.close();
    };
    await run('对照：无定时器', () => {}, false);
    await run('对照：短 setTimeout（100ms）会触发并等待', () => { setTimeout(() => {}, 100); }, false);
    await run('对照：2000ms setTimeout 等它触发，不触发硬门', () => { setTimeout(() => {}, 2000); }, false);
    await run('对照：interval 已 clear', () => { const i = setInterval(() => {}, 500); clearInterval(i); }, false);
    await run('对照：6000ms 定时器已 clear', () => { const t = setTimeout(() => {}, 6000); clearTimeout(t); }, false);
    await run('变异：注入活动 setInterval', () => { setInterval(() => {}, 700); }, true, /长期 \/ 周期定时器：setInterval/);
    await run('变异：注入 6000ms setTimeout', () => { setTimeout(() => {}, 6000); }, true, /长期 \/ 周期定时器：setTimeout 延迟 6000ms/);
    await run('变异：interval 在 setTimeout 回调里创建', () => { setTimeout(() => { setInterval(() => {}, 300); }, 150); }, true, /setInterval/);
  } finally { await browser.close(); }
  console.log('[self-test-settle] ' + (n - bad) + '/' + n + ' 通过');
  return bad ? 1 : 0;
}

// 描述页内控件的安全键（含脱敏词形的 id 一律哈希，防止字段名进基线）
const SAFE_KEY_FN = `(raw) => (/[wW]\\d{4}|[\\u3400-\\u9fff]/.test(raw) ? 'h' + raw.length + '_' + Array.from(raw).reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7) : raw)`;
/** 命名区卡片快照；卡片不存在（C3b 迁出后的目录页）时返回 absent 空快照，不抛错 */
async function cardSnapshot(page) {
  return page.evaluate(`(() => {
    const safe = ${SAFE_KEY_FN};
    const card = document.querySelector('.model-generator-card');
    if (!card) return { absent: true, controls: {}, n: 0, disabled: 0, hidden: 0, vis: {}, text: '' };
    const controls = {};
    let n = 0, disabled = 0, hidden = 0;
    card.querySelectorAll('input, select, textarea').forEach((el, i) => {
      const raw = el.id || el.name || '';
      const key = i + ':' + el.tagName.toLowerCase() + (el.type ? '.' + el.type : '') + ':' + safe(raw);
      const v = (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? 'C' : 'u') : (el.value || '');
      const dis = !!el.disabled, hid = el.offsetParent === null;
      controls[key] = v + '|' + (dis ? 'D' : '') + (hid ? 'H' : '');
      n++; if (dis) disabled++; if (hid) hidden++;
    });
    const vis = {};
    card.querySelectorAll('[id]').forEach((el) => { vis[safe(el.id)] = el.offsetParent !== null ? 1 : 0; });
    return { controls, n, disabled, hidden, vis, text: card.innerText };
  })()`);
}
const hashSnapshot = (s) => ({
  controlCount: s.n, disabledCount: s.disabled, enabledCount: s.n - s.disabled, hiddenCount: s.hidden,
  controlHash: h(JSON.stringify(s.controls)), visibilityHash: h(JSON.stringify(s.vis)), cardTextHash: h(s.text),
  controlHashes: Object.fromEntries(Object.entries(s.controls).map(([k, v]) => [k, h(v)])),
});
const finalLoc = (page) => page.evaluate(() => ({ finalPath: location.pathname.replace(/^\//, ''), finalSearch: location.search }));
const snapKey = async (page) => { const s = await cardSnapshot(page); return JSON.stringify([s.controls, s.vis, h(s.text), await finalLoc(page)]); };

function deepDiff(a, b, p = '', out = []) {
  if (a === b) return out;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb || a === null || b === null || ta !== 'object') { out.push(p || '(root)'); return out; }
  if (Array.isArray(a) !== Array.isArray(b)) { out.push(p || '(root)'); return out; }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) deepDiff(a[k], b[k], p ? `${p}.${k}` : k, out);
  return out;
}
const hashFields = (obj) => Object.fromEntries(Object.keys(obj).map(k => [k, h(JSON.stringify(obj[k]))]));
const ENUM_KEYS = ['layer', 'update_cycle', 'config_mode', 'status', 'category', 'model_type'];
/** 请求体摘要。keys / bodyHash 不含 domain（domain 单独用 domainState + fieldHashes.domain 记，便于登记「不再发送 domain」） */
function summarizeBody(raw, originalDomain) {
  if (raw == null) return { none: true };
  const b = JSON.parse(raw);
  const { domain, ...rest } = b;
  const scalars = {}; for (const k of ENUM_KEYS) if (k in b) scalars[k] = b[k];
  const domainState = !('domain' in b) ? 'absent' : (b.domain === '' ? 'empty' : (b.domain === originalDomain ? 'equalsOriginal' : 'other'));
  return { keys: Object.keys(rest), scalars, domainState, fieldHashes: hashFields(b), bodyHash: h(JSON.stringify(rest)) };
}

// ---------------------------------------------------------------------------------------------
// 页面驱动（HEAD 的全局函数；C3b 换成新页时只改这一节）
// ---------------------------------------------------------------------------------------------
/**
 * C4c-2：经真实点击路径触发条目动作——动作项若在菜单里，先点该菜单的触发按钮（[data-menu][aria-controls=<菜单 id>]），再点 [data-act] 项；
 * 菜外的直接按钮（ODS 的 validate）直接点。条目与动作按 data-id / data-act 定位，不依赖按钮文字。
 */
async function clickRowAct(page, id, act) {
  const entry = page.locator(`#modelListBody [data-id="${id}"]`);
  const item = entry.locator(`[data-act="${act}"]`).first();
  const menuId = await item.evaluate((el) => { const m = el.closest('[role="menu"]'); return m ? m.id : null; });
  if (menuId) await entry.locator(`[data-menu][aria-controls="${menuId}"]`).click();
  await item.click();
}
/** 新开页面（每个夹具一页）：加载目录页、校验冻结时钟、等列表稳定；opts.noSettle 用于深链（调用方自己等） */
async function frozenClockCheck(page) {
  for (let i = 0; ; i++) {
    try {
      const iso = await page.evaluate(() => new Date().toISOString());
      if (iso !== FIXED_ISO) throw new Error(`浏览器时钟未冻结：页面 new Date() = ${iso}，期望 ${FIXED_ISO}`);
      return;
    } catch (e) { if (!isNavError(e) || i > 20) throw e; await sleep(100); }
  }
}
async function openPage(ctx, query = '', opts = {}) {
  const page = await ctx.newPage();
  const tr = track(page);
  try { await page.goto(`${BASE}/Model_Center.html${query}`, { waitUntil: 'load' }); } catch (e) { if (!isNavError(e)) throw e; }
  // C3b：深链可能被目录页（或再经配置台）跳走：等「目录列表行」或「已离开目录页」，两者之一即可（28-R MED）
  await page.waitForFunction(() => !!document.querySelector('#modelListBody [data-id]') || !/Model_Center\.html$/.test(location.pathname), null, { timeout: SETTLE_LIMIT_MS });
  await frozenClockCheck(page);
  if (!opts.noSettle) await settle(page, tr, () => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length), `目录页加载 ${query}`);
  return { page, tr };
}
/** 配置台入口完成信号：注册模式 = 命名区就绪；编辑 / 只读 = 编辑目标 id 已设置且「已加载」类 toast 出现（openDimEditModal / openDwdEditModal 末尾才弹） */
async function waitWbReady(page, query) {
  if (/[?&]id=\d+/.test(query)) {
    await page.waitForFunction(() => typeof dimEditModelId !== 'undefined' && typeof dwdEditModelId !== 'undefined' && (dimEditModelId !== null || dwdEditModelId !== null)
      && (window.__mcToastTexts || []).some(t => /已加载|（只读）/.test(t)), null, { timeout: SETTLE_LIMIT_MS });
  } else {
    await page.waitForSelector('#genLayer', { timeout: SETTLE_LIMIT_MS });
  }
}
/** 新开配置台页面（Model_Workbench.html）：无 query = 注册；?id=&mode= = 编辑 / 只读 */
async function openWb(ctx, query = '', opts = {}) {
  const page = await ctx.newPage();
  const tr = track(page);
  await page.goto(`${BASE}/Model_Workbench.html${query}`, { waitUntil: 'load' });
  await waitWbReady(page, query);
  await frozenClockCheck(page);
  if (!opts.noSettle) await settle(page, tr, () => snapKey(page), `配置台加载 ${query}`);
  return { page, tr };
}
/** 已在目录页 → 点击后换到配置台（菜单 / 按钮入口）：等 URL 变成配置台，再等入口完成信号并取样 */
async function waitIntoWb(page, tr, what) {
  await page.waitForURL(u => /Model_Workbench\.html$/.test(u.pathname), { waitUntil: 'load', timeout: SETTLE_LIMIT_MS });
  await waitWbReady(page, page.url().replace(/^[^?]*/, ''));
  await settle(page, tr, () => snapKey(page), what);
}

function stubFieldsFor(cfg) {
  const arr = []; const seen = new Set();
  const add = (n, dt, c) => { if (!n || seen.has(n)) return; seen.add(n); arr.push({ column_name: n, data_type: dt || 'nvarchar(128)', column_comment: c || '' }); };
  const sc = cfg && cfg.scdConfig;
  if (sc) { const fm = {}; (sc.fieldMappings || []).forEach(m => { fm[m.srcField] = m; }); (sc.trackFields || []).forEach(t => add(t, fm[t] && fm[t].dataType, fm[t] && fm[t].comment)); (sc.fieldMappings || []).forEach(m => add(m.srcField, m.dataType, m.comment)); }
  ((cfg && cfg.selectedFields) || []).forEach(m => add(m.srcField, m.dataType, m.comment));
  return arr;
}

/**
 * 拦截一次写请求并执行 fn。opts.nav = true：写成功后页面会跳回目录页（C3b：保存 / 注册 / 放弃 → Model_Center.html?focus=<id>）——
 *   先登记「等 URL 变成目录页」再执行 fn（fn 的 evaluate 可能因换页被中断，属预期），落点（landing）取自换页提交那一刻的 URL
 *   （目录页处理完 ?focus 会 replaceState 清参，所以必须在清参前取），再等目录列表行出现、按 snapFn 取样。
 */
async function interceptWrite(page, tr, method, urlGlob, status, respBody, fn, snapFn, what, opts = {}) {
  let body = null;
  const handler = async (route) => {
    const req = route.request();
    if (req.method() === method) { body = req.postData(); await route.fulfill({ status, contentType: 'application/json', body: respBody }); } else await route.continue();
  };
  await page.route(urlGlob, handler);
  const before = tr.reqs.length;
  let landing = null;
  try {
    if (opts.nav) {
      const navP = page.waitForURL(u => /Model_Center\.html$/.test(u.pathname), { waitUntil: 'commit', timeout: SETTLE_LIMIT_MS });
      try { await fn(); } catch (e) { if (!isNavError(e)) throw e; }
      await navP;
      const u = new URL(page.url());
      landing = { finalPath: u.pathname.replace(/^\//, ''), finalSearch: u.search };
      await page.waitForSelector('#modelListBody [data-id]', { timeout: SETTLE_LIMIT_MS });
    } else {
      await fn();
    }
    await settle(page, tr, snapFn, what);
  } finally { await page.unroute(urlGlob, handler); }
  const after = {};
  for (const r of tr.reqs.slice(before)) after[r] = (after[r] || 0) + 1;
  return { body, requestsAfter: after, landing };
}

// ---------------------------------------------------------------------------------------------
// 比较（allowedChanges 规则）
// ---------------------------------------------------------------------------------------------
const escRe = (s) => s.replace(/[.+?^${}()|[\]\\]/g, (c) => '\\' + c);
const exactRe = (p) => '^' + escRe(p) + '$';
const subst = (v, m) => (typeof v === 'string' ? v.replace(/\$(\d)/g, (_, i) => (m && m[+i] !== undefined ? m[+i] : '')) : v);
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 路径解析（键名本身可含 '.'，逐段贪婪匹配） */
function getAt(o, p) {
  if (p === '') return { found: true, value: o };
  if (o === null || typeof o !== 'object') return { found: false };
  for (const k of Object.keys(o)) {
    if (p === k) return { found: true, value: o[k], parent: o, key: k };
    if (p.startsWith(k + '.')) { const r = getAt(o[k], p.slice(k.length + 1)); if (r.found) return r; }
  }
  return { found: false };
}
function subsetOf(a, b) {   // a 的每个叶子在 b 里同键同值
  if (a === null || typeof a !== 'object') return deepEqual(a, b);
  if (b === null || typeof b !== 'object') return false;
  return Object.keys(a).every(k => k in b && subsetOf(a[k], b[k]));
}
/** 期望判定：value 取自「当前运行」cur 的节点 p；m 是 pathRe 的捕获组 */
function satisfies(expect, cur, p, m) {
  const r = getAt(cur, p);
  if (expect.absent) return { ok: !r.found, why: '期望键不存在' };
  if (!r.found) return { ok: false, why: '键不存在' };
  if ('eq' in expect) { const want = subst(expect.eq, m); return { ok: deepEqual(r.value, want), why: `期望 ${JSON.stringify(want)}，实得 ${JSON.stringify(r.value)}` }; }
  if ('notIncludes' in expect) return { ok: Array.isArray(r.value) && !r.value.includes(expect.notIncludes), why: `期望数组不含 ${JSON.stringify(expect.notIncludes)}，实得 ${JSON.stringify(r.value)}` };
  if ('sameAsCurrent' in expect) {
    // 28 号审 H4：不再按「键子集」判（空对象 / 截断数组都是子集会被放行）。改为：规则里写死字段清单 fields，
    // 节点的键集合必须恰好等于该清单，每个字段与对照节点逐字段全等（数组、对象按 JSON 全等，不按键子集）；
    // nonEmpty 里的字段还必须非空（数字 > 0、字符串 / 数组非空、对象有键），防「两边都被清空」互相相等。
    const ref = subst(expect.sameAsCurrent, m);
    const other = getAt(cur, ref);
    const fail = (why) => ({ ok: false, why: `期望与当前 ${ref} 逐字段全等：${why}` });
    if (!Array.isArray(expect.fields) || !expect.fields.length) return fail('规则未写死字段清单');
    if (!other.found || other.value === null || typeof other.value !== 'object') return fail('对照节点不存在');
    if (r.value === null || typeof r.value !== 'object' || Array.isArray(r.value)) return fail('当前值不是对象');
    const keys = Object.keys(r.value).sort(), want = [...expect.fields].sort();
    if (!deepEqual(keys, want)) return fail(`键集合 ${JSON.stringify(keys)} ≠ 清单 ${JSON.stringify(want)}`);
    for (const k of expect.fields) if (!(k in other.value) || !deepEqual(r.value[k], other.value[k])) return fail(`字段 ${k} 与对照不等`);
    const nonEmpty = (v) => (typeof v === 'number' ? v > 0 : typeof v === 'string' ? v.length > 0 : Array.isArray(v) ? v.length > 0 : (v !== null && typeof v === 'object') ? Object.keys(v).length > 0 : !!v);
    for (const k of expect.nonEmpty || []) if (!nonEmpty(r.value[k])) return fail(`字段 ${k} 为空`);
    return { ok: true, why: '' };
  }
  return { ok: false, why: '未知期望类型' };
}
// ---------------------------------------------------------------------------------------------
// C3b 补登记（AC-11..AC-14）：C3a-0 预登记 AC-1..AC-10 之外、C3b 在新页上重放时出现的、同样由 §6.2「迁出」必然带来的变化。
//   期望值全部由基线里已录的「改前」测量数据按规则推出（不取自本次运行结果）；baseline.json 本身不动（不重录），补登记在这里随驱动入库。
//   每项都是 {eq} 精确值，比 AC-1..10 同样严格；第三个值照样判红。
// ---------------------------------------------------------------------------------------------
const clone = (o) => JSON.parse(JSON.stringify(o));
function extraAllowedChanges(base) {
  const E = (p, expect) => ({ pathRe: exactRe(p), expect });
  const WB = 'Model_Workbench.html';
  const out = [];
  // AC-11：保存 / 注册后换页到目录页，目录页自己加载一次列表（app.js 的 loadAllModels 另发一次 GET /api/models），
  //   故「保存后请求计数」里 GET /api/models 由 1 变 2；原先 DWD 保存路径里 cancelDwdEditMode 触发的 GET /api/models/check（重置命名区时的表名检测）不再发生；
  //   editIdAfter 在目录页上没有该全局变量，读数为 'n/a'。
  const ac11 = [];
  const newReqs = (reqs) => { const r = {}; for (const k of Object.keys(reqs)) { if (k === 'GET /api/models/check') continue; r[k] = k === 'GET /api/models' ? reqs[k] + 1 : reqs[k]; } return r; };
  for (const k of Object.keys(base.p2 || {})) { ac11.push(E(`p2.${k}.afterSave.requests`, { eq: newReqs(base.p2[k].afterSave.requests) })); ac11.push(E(`p2.${k}.afterSave.editIdAfter`, { eq: 'n/a' })); }
  for (const k of Object.keys(base.p3 || {})) ac11.push(E(`p3.${k}.afterRegister.requests`, { eq: newReqs(base.p3[k].afterRegister.requests) }));
  for (const k of ['saveUnchanged', 'saveAfterScdChange']) ac11.push(E(`u5.custom58.${k}.afterSave.requests`, { eq: newReqs(base.u5.custom58[k].afterSave.requests) }));
  out.push({ id: 'AC-11', source: '方案 v0.10 §6.2 第 8、12 条', title: '保存 / 注册后换页到目录页：目录页自身加载使 GET /api/models 计数 +1（app.js loadAllModels），DWD 保存不再发重置命名区的 GET /api/models/check，editIdAfter 读数 n/a', rules: ac11 });
  // AC-12 已于 C4c-2 子批 2c 删除：它的 16 条规则（13 条 u5.roles.{admin, owner_user, nonowner_user}.rows.<id>.buttons.<i>.handler 与 3 条 u5.roles.<角色>.rowsHash）
  //   全部挂在 U5 逐行按钮清单 rows / rowsHash 上；C4c-2 起 U5 不再产出这两个节点（由 AC-16 的 absent 命中），这些 eq 规则在真实运行里一次都不会命中（死规则）。
  //   「编辑配置 → openWorkbench / 配置 → openDwdConfigViewModal」这层语义改由 C4-0 矩阵（test-model-catalog-baseline-playwright.js，call.fn 逐格比较）承担。
  // AC-13：目录页 ?dev=1 / 角色深链换页到配置台后，读数落在配置台页面上：URL 保留 ?id=&mode=（urlSearchEmpty=false），没有目录列表（rows=0，currentPage 不存在=null）
  const ac13 = [];
  for (const k of ['dim50_dev', 'dwd52_dev', 'dim58custom_dev', 'dwd53companion_dev']) { ac13.push(E(`p6.${k}.urlSearchEmpty`, { eq: false })); ac13.push(E(`p6.${k}.page`, { eq: null })); ac13.push(E(`p6.${k}.rows`, { eq: 0 })); }
  for (const [role, dls] of [['admin', ['dim50_dev', 'dwd52_dev', 'dim55_dev']], ['owner_user', ['dim50_dev', 'dwd52_dev', 'dim55_dev']], ['nonowner_user', ['dim50_dev', 'dwd52_dev', 'dim55_dev']]]) for (const dl of dls) ac13.push(E(`u5.roles.${role}.deepLinks.${dl}.urlSearchEmpty`, { eq: false }));
  out.push({ id: 'AC-13', source: '方案 v0.10 §6.2 第 6、11 条', title: '深链换页到配置台后的读数：地址栏保留 ?id=&mode=（urlSearchEmpty=false）、页面上没有目录列表（rows=0、currentPage 不存在读 null）；viewer 回目录页并清参，仍为 true（不登记）', rules: ac13 });
  // AC-14：目录页没有命名区 genLayer：P7 前后读数由 'ods' 变 null
  const ac14 = [];
  for (const k of ['dimDdl50', 'dimEtl50', 'dwdDdl52', 'dwdEtl52']) for (const w of ['before', 'after']) ac14.push(E(`p7.${k}.${w}.genLayer`, { eq: null }));
  // AC-15（C4b）：目录列表按「组」分页（每页 20 组，伴生表不占位、紧跟主模型）。本基线夹具 36 行 / 35 组（唯一伴生 #53 随 #52）：
  //   第 1 页 20 组 = 21 行（含 #52 + #53），第 2 页 15 组 = 15 行。留在目录页的深链读数 p6.<case>.rows 因此：第 1 页 20 → 21（9 例）、第 2 页 16 → 15（2 例）。
  //   规则：base.p6[case] 里 page=1 且 rows=20 → 21；page=2 且 rows=16 → 15；跳去配置台的 4 例由 AC-13 定为 rows 0，不在此登记；搜索例 rows=1 不变。
  //   登记值由基线里已录的改前读数按上述规则推出（不取自运行结果）；推出后硬断言恰 11 条（21 × 9、15 × 2）。
  const ac15 = [];
  const AC13_CASES = ['dim50_dev', 'dwd52_dev', 'dim58custom_dev', 'dwd53companion_dev'];
  for (const [k, v] of Object.entries(base.p6 || {})) {
    if (AC13_CASES.includes(k)) continue;
    if (v.page === 1 && v.rows === 20) ac15.push(E(`p6.${k}.rows`, { eq: 21 }));
    else if (v.page === 2 && v.rows === 16) ac15.push(E(`p6.${k}.rows`, { eq: 15 }));
  }
  if (ac15.length !== 11 || ac15.filter(r => r.expect.eq === 21).length !== 9 || ac15.filter(r => r.expect.eq === 15).length !== 2) throw new Error('AC-15 应推出 11 条（21 × 9、15 × 2），实得 ' + ac15.map(r => r.pathRe + '=' + r.expect.eq).join(' '));
  out.push({ id: 'AC-15', source: 'C4b：目录列表按组分页（方案 §3.4 每页 20 组）', title: '深链落在目录页时的列表行数：第 1 页 20 组 = 21 行（20 → 21，9 例）、第 2 页 15 组 = 15 行（16 → 15，2 例）；page 不变', rules: ac15 });
  out.push({ id: 'AC-14', source: '方案 v0.10 §6.2 第 6 条（命名区迁出，同 AC-10）', title: '目录页没有命名助手：P7 读 genLayer 由 "ods" 变 null', rules: ac14 });
  // AC-16（C4c-2）：目录列表由 tr 表格改为卡片 + ⋯ 菜单 + data-act 委托。共 9 条，条数硬断言：
  //   (1) p7.editMenuEntry.menuItems：旧「编辑 ▾」下拉 2 项 → ⋯ 菜单 6 项（ETL / DDL / 编辑配置 / 编辑信息 / 变更历史 / 删除，方案 §3.5 / 驱动契约 4），期望 6；
  //   (2) u5.roles.{admin, viewer_user, owner_user, nonowner_user}.rows 与 .rowsHash 不再产出（逐行按钮清单依赖 tr + onclick 文本，新结构是 data-act 委托）。
  //       理由：由 C4-0 矩阵接替（8 角色 ⊃ 这 4 角色；矩阵逐格比较 call / inert / enabled / reason）。
  const ac16 = [E('p7.editMenuEntry.menuItems', { eq: 6 })];
  for (const role of ['admin', 'viewer_user', 'owner_user', 'nonowner_user']) { ac16.push(E(`u5.roles.${role}.rows`, { absent: true })); ac16.push(E(`u5.roles.${role}.rowsHash`, { absent: true })); }
  if (ac16.length !== 9) throw new Error('AC-16 应为 9 条，实得 ' + ac16.length);
  out.push({ id: 'AC-16', source: 'C4c-2：目录列表改卡片 + ⋯ 菜单（派单 §4.6）', title: '菜单入口读数：⋯ 菜单项数 2 → 6；U5 逐行按钮清单（rows / rowsHash，4 角色）不再产出，由 C4-0 矩阵接替', rules: ac16 });
  // AC-17（末次合并审 M8 + 收口批 2 MED-1）：目录页「编辑信息」对 DIM 模型，在 SCD 类型 / 配置方式都没改时不再回传 dim_config、update_cycle、config_mode
  //   （改前总是用列表缓存里可能过期的值整份回传，会静默回退别人在配置台改过的配置，或写出 SCD2 + df 这类半新半旧组合）。
  //   P4 对 DIM#50 / DIM#55 调 openEditModal 后直接 confirmRegister()、什么都不改，所以请求体由 14 个键（含 update_cycle、config_mode、dim_config）变为 11 个。
  //   登记按「每个模型 7 条」，共 14 条，条数硬断言：
  //   (1) keys：整个键序数组（keys 是按位置记的数组，在中间去掉 update_cycle 后面所有下标都会前移，逐下标登记会漏掉移位）eq 为基线 keys 去掉这三个键后的数组——由基线推出，不取自运行结果；
  //   (2) scalars.update_cycle、scalars.config_mode 缺席（absent，各 1 条）；
  //   (3) fieldHashes.update_cycle、fieldHashes.config_mode、fieldHashes.dim_config 缺席（absent，各 1 条）；
  //   (4) bodyHash 改为新值（eq，1 条）。
  //   bodyHash 新值来源：2026-10-11 用 MC_DUMP 实跑本驱动（--allow-changes，端口 3385，库副本）取得后写死，它是整个请求体（11 个键）的指纹；
  //   其他字段（layer / table_name / 状态 / 分类等的 fieldHashes 与 scalars）与基线逐项相同，仍受比较约束，第三个值照样判红。
  const AC17_DROPPED = ['update_cycle', 'config_mode', 'dim_config'];
  //   取值：E:/tmp/mc77-c6/f46b/out/ac17b_dump.json 的 p4.dim50.bodyHash（:2508）= ab4f89cdf91b、p4.dim55.bodyHash（:2551）= edf8c130b229；日志 E:/tmp/mc77-c6/f46b/out/c3a_dump.log
  const AC17_BODY_HASH = { dim50: 'ab4f89cdf91b', dim55: 'edf8c130b229' };
  const ac17 = [];
  for (const k of ['dim50', 'dim55']) {
    const baseKeys = ((base.p4 || {})[k] || {}).keys;
    if (!Array.isArray(baseKeys) || !AC17_DROPPED.every(x => baseKeys.includes(x))) throw new Error('AC-17：基线 p4.' + k + '.keys 应含 ' + AC17_DROPPED.join(' / ') + '，实得 ' + JSON.stringify(baseKeys));
    ac17.push(E(`p4.${k}.keys`, { eq: baseKeys.filter(x => !AC17_DROPPED.includes(x)) }));
    ac17.push(E(`p4.${k}.scalars.update_cycle`, { absent: true }));
    ac17.push(E(`p4.${k}.scalars.config_mode`, { absent: true }));
    for (const f of AC17_DROPPED) ac17.push(E(`p4.${k}.fieldHashes.${f}`, { absent: true }));
    ac17.push(E(`p4.${k}.bodyHash`, { eq: AC17_BODY_HASH[k] }));
  }
  if (ac17.length !== 14) throw new Error('AC-17 应为 14 条，实得 ' + ac17.length);
  out.push({ id: 'AC-17', source: '末次合并审 M8 + 收口批 2 MED-1：编辑信息在 SCD / 配置方式未变时不再回传 dim_config、update_cycle、config_mode', title: 'P4 编辑信息 PUT 请求体（DIM#50 / DIM#55）：keys 去掉 update_cycle / config_mode / dim_config 三个键，scalars 与 fieldHashes 里对应项缺席，bodyHash 为新值', rules: ac17 });
  // AC-18（用户 10-12 裁定 P53 = B）：ODS 验收后自动保存的 save-scripts 请求体新增 purpose、expected_config_rev 两个键（插在 tableName 之后），
  //   首次落盘豁免只认这一种请求；同一场景的 scriptKeys / ddlHash / syncHash / tableNameHash 不变，仍受比较约束。
  //   登记 1 条：整个键序数组 eq，期望由基线推出（基线必须恰为 [tableName, scripts]），不取自运行结果。
  const ac18Base = ((base.p7 || {}).odsValidate8 || {}).saveScriptsBodyKeys;
  if (JSON.stringify(ac18Base) !== JSON.stringify(['tableName', 'scripts'])) throw new Error('AC-18：基线 p7.odsValidate8.saveScriptsBodyKeys 应为 ["tableName","scripts"]，实得 ' + JSON.stringify(ac18Base));
  out.push({ id: 'AC-18', source: '用户 10-12 裁定 P53 = B：首次保存豁免只留给 ODS 验收后自动保存（带 purpose 与 expected_config_rev）', title: 'P7 ODS 验收后自动保存的 save-scripts 请求体 keys：tableName 之后插入 purpose、expected_config_rev', rules: [E('p7.odsValidate8.saveScriptsBodyKeys', { eq: ['tableName', 'purpose', 'expected_config_rev', 'scripts'] })] });
  return out;
}
function withExtraAcs(base) {
  if ((base.allowedChanges || []).some(a => a.id === 'AC-11')) return base;
  return { ...base, allowedChanges: [...(base.allowedChanges || []), ...extraAllowedChanges(base)] };
}

const nodeCandidates = (d) => { const c = [d]; for (let i = 0; i < d.length; i++) if (d[i] === '.') c.push(d.slice(0, i)); return c; };
function compareBaselines(base0, cur, allowChanges = ALLOW_CHANGES) {
  const base = withExtraAcs(base0);
  const diffs = deepDiff(cur, base).filter(d => !d.startsWith('meta.') && !d.startsWith('allowedChanges') && !d.startsWith('knownLossy'));
  const rules = (base.allowedChanges || []).flatMap(a => a.rules.map(r => ({ id: a.id, re: new RegExp(r.pathRe), expect: r.expect })));
  const real = [], allowed = [], cache = new Map(), hitKeys = new Set();
  for (const d of diffs) {
    if (!allowChanges) { real.push(d); continue; }
    let hit = null, why = null;
    for (const P of nodeCandidates(d)) {
      for (const r of rules) {
        const m = r.re.exec(P); if (!m) continue;
        const key = r.id + '|' + r.re.source + '|' + P;
        if (!cache.has(key)) cache.set(key, satisfies(r.expect, cur, P, m));
        const s = cache.get(key);
        if (s.ok) { hit = r; break; }
        if (!why) why = `[${r.id}] ${P}：${s.why}`;
      }
      if (hit) break;
    }
    if (hit) { allowed.push(`${d}  [允许 ${hit.id}]`); hitKeys.add(hit.id + '|' + hit.re.source); } else real.push(why ? `${d}  （登记键未满足期望：${why}）` : d);
  }
  return { real, allowed, hitKeys };
}

// ---- 比较机制自测（不起服务）----
function leafPaths(o, p = '', out = []) {
  if (o !== null && typeof o === 'object') { for (const k of Object.keys(o)) leafPaths(o[k], p ? p + '.' + k : k, out); } else out.push(p);
  return out;
}
function setAt(o, p, v, del) { const r = getAt(o, p); if (!r.found) throw new Error('setAt 找不到 ' + p); if (del) delete r.parent[r.key]; else r.parent[r.key] = v; }
function selfTestCompare() {
  const base = withExtraAcs(JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')));
  const leaves = leafPaths(base).filter(l => !l.startsWith('allowedChanges.') && !l.startsWith('knownLossy.') && !l.startsWith('meta.'));
  let bad = 0, n = 0;
  const check = (label, cond) => { n++; if (!cond) { bad++; console.log('  FAIL ' + label); } };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const same = compareBaselines(base, clone(base), true);
  check('未改动：0 差异', same.real.length === 0 && same.allowed.length === 0);
  const allRules = base.allowedChanges.flatMap(a => a.rules.map(r => ({ id: a.id, re: new RegExp(r.pathRe), expect: r.expect })));
  for (const r of allRules) {
    // 找一个真实存在的节点路径：某叶子的「自身或点前缀」整串匹配该规则
    let P = null, m = null;
    for (const l of leaves) { for (const c of nodeCandidates(l)) { const mm = r.re.exec(c); if (mm && getAt(base, c).found) { P = c; m = mm; break; } } if (P) break; }
    if (!P) { check(`${r.id} 规则 ${r.re.source} 在基线里找不到对应节点（登记路径失效）`, false); continue; }
    const label = `${r.id} ${P}`;
    // (a) 满足期望的新值：--allow-changes 放行；默认模式若有差异则判红
    const a = clone(base);
    if (r.expect.absent) setAt(a, P, null, true);
    else if ('eq' in r.expect) setAt(a, P, subst(r.expect.eq, m));
    else if ('notIncludes' in r.expect) setAt(a, P, []);
    else if ('sameAsCurrent' in r.expect) { const o = getAt(a, subst(r.expect.sameAsCurrent, m)).value; const pick = {}; for (const k of r.expect.fields) pick[k] = clone(o[k]); setAt(a, P, pick); }
    const ra = compareBaselines(base, a, true), rd = compareBaselines(base, a, false);
    check(`${label}：满足期望的新值在 --allow-changes 下放行`, ra.real.length === 0);
    check(`${label}：同一改动在默认模式下${rd.real.length ? '判红' : '无差异'}`, rd.real.length === ra.allowed.length);
    // (b) 第三个值（既不是基线值也不满足期望）：--allow-changes 下仍判红
    const b = clone(base);
    if ('notIncludes' in r.expect) setAt(b, P, [r.expect.notIncludes, '__x__']); else setAt(b, P, '__third__');
    const rb = compareBaselines(base, b, true);
    check(`${label}：第三个值在 --allow-changes 下判红`, rb.real.length >= 1 && rb.allowed.length === 0);
  }
  // 28 号审 H4：sameAsCurrent 的退化结果在 --allow-changes 下必须判红
  for (const r of allRules.filter(x => 'sameAsCurrent' in x.expect)) {
    const P = r.re.source.replace(/^\^|\$$/g, '').replace(/\\(.)/g, '$1');
    const refP = r.expect.sameAsCurrent, o = getAt(base, refP).value;
    const variants = [
      ['空对象', () => ({})],
      ['控件散列表截断为空', (v) => ({ ...v, controlHashes: {} })],
      ['控件散列表只留首项', (v) => ({ ...v, controlHashes: Object.fromEntries(Object.entries(v.controlHashes).slice(0, 1)) })],
      ['缺一个字段', (v) => { const c = { ...v }; delete c.configHash; return c; }],
      ['多一个未登记字段', (v) => ({ ...v, extra: 1 })],
      ['控件数为 0', (v) => ({ ...v, controlCount: 0 })],
    ];
    for (const [name, fn] of variants) {
      const c = clone(base); const okv = {}; for (const k of r.expect.fields) okv[k] = clone(o[k]);
      setAt(c, P, fn(okv));
      const rr = compareBaselines(base, c, true);
      check(`${r.id} ${P}：${name}在 --allow-changes 下判红`, rr.real.length >= 1 && rr.allowed.length === 0);
    }
    // 两边同空：对照与当前都被清空 → 相等但为空，必须判红（nonEmpty）
    const c2 = clone(base); const emptyV = {};
    for (const k of r.expect.fields) emptyV[k] = (typeof o[k] === 'number') ? 0 : (typeof o[k] === 'string' ? '' : {});
    setAt(c2, P, clone(emptyV)); setAt(c2, refP, clone(emptyV));
    const r2 = compareBaselines(base, c2, true);
    check(`${r.id} ${P}：两边同被清空在 --allow-changes 下判红`, !r2.allowed.some(x => x.startsWith(P)));
    // 数组按全等比较：直接对 satisfies 做单元断言
    const ex = { sameAsCurrent: 'b', fields: ['arr'], nonEmpty: ['arr'] };
    check('数组截断：satisfies 判红', !satisfies(ex, { a: { arr: [1, 2] }, b: { arr: [1, 2, 3] } }, 'a', []).ok);
    check('数组全等：satisfies 放行', satisfies(ex, { a: { arr: [1, 2, 3] }, b: { arr: [1, 2, 3] } }, 'a', []).ok);
  }
  // 未登记键的变化仍须判红
  const unreg = ['p6.dim50_dev.dimEditModelId', 'u5.roles.viewer_user.hiddenNavItems', 'u5.roles.nonowner_user.actionHeaderPresent', 'p5.dim50.controlHash'].filter(l => leaves.includes(l) && !allRules.some(r => nodeCandidates(l).some(c => r.re.test(c))));
  check('至少选到 3 个未登记键做变异', unreg.length >= 3);
  for (const l of unreg) { const c = clone(base); setAt(c, l, '__third__'); const r = compareBaselines(base, c, true); check(`未登记键 ${l}：--allow-changes 下仍判红`, r.real.length === 1 && r.allowed.length === 0); }
  console.log(`[self-test-compare] ${n - bad}/${n} 通过（规则 ${allRules.length} 条，涉及 AC ${base.allowedChanges.length} 项）`);
  return bad ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------
function tokenFor(secret, u) { return jwt.sign({ id: u.id, username: u.username, display_name: u.display_name, role: u.role }, secret, { expiresIn: '2h' }); }

function loadExistingBaseline() { try { return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch (_) { return null; } }
function checkRecordGuard() {
  if (!RECORD) return;
  const cur = sha256File(MC_HTML);
  const old = loadExistingBaseline();
  const rec = old && old.meta && old.meta.modelCenterSha256;
  if (rec && rec !== cur) {
    if (!FORCE_RECORD) {
      console.error(`[record] 拒绝：Model_Center.html 的 SHA-256 与基线录制时不同（基线 ${rec.slice(0, 12)}… / 当前 ${cur.slice(0, 12)}…）。期望值必须来自改前代码，C3a / C3b 改过页面之后不得再录制。确需重录请加 --force-record。`);
      process.exit(2);
    }
    console.error('!!!!!! [record] --force-record：Model_Center.html 已与基线录制时不同，本次录制会把改后的行为固化为期望，仅限你明确知道在做什么 !!!!!!');
  }
}

async function main() {
  checkRecordGuard();
  const secret = testEnv.env().jwtSecret;   // 实例随机密钥（与服务端同源）；不再读 .env
  const rows = loadModelRows();
  const cfgOf = (id) => rows.find(r => r.id === id).dim_config;
  const rowOf = (id) => rows.find(r => r.id === id);
  const probe = await fetch(`${BASE}/api/models`);
  if (probe.status !== 401) throw new Error(`[就绪核对] 未带 token 访问 /api/models 应 401，实得 ${probe.status}（服务没有在应答本脚本要测的路由）`);
  await prepareDb(testEnv.env().dbPath);
  const browser = await chromium.launch({ headless: true });
  const out = {};
  try {
    const stubRef = { fields: [] };
    const mkCtx = async (user) => {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: TIMEZONE });
      await ctx.clock.setFixedTime(new Date(FIXED_ISO));
      const tok = tokenFor(secret, user);
      await ctx.addInitScript(([t, u]) => { try { localStorage.setItem('token', t); localStorage.setItem('user', JSON.stringify({ display_name: u })); } catch (e) { /* ignore */ } }, [tok, user.display_name]);
      await ctx.addInitScript(INIT_SCRIPT);
      await ctx.route('**/api/warehouse/describe-table*', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stubRef.fields) });
      });
      // 兜底：写共享 uploads 目录的保存脚本请求一律 fulfill，不落盘（具体用例需要读 body 时用页面级 route 抢先）
      await ctx.route('**/api/models/*/save-scripts', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"savedFiles":[],"configRevBumped":false}' });
      });
      return ctx;
    };
    const admin = await mkCtx(USERS[0]);
    const withStub = (id) => { stubRef.fields = stubFieldsFor(cfgOf(id)); };
    const cardSettle = (page, tr, what) => settle(page, tr, () => snapKey(page), what);
    const listHash = (page) => page.evaluate(() => document.getElementById('modelListBody').innerHTML.length + ':' + (typeof currentPage !== 'undefined' ? currentPage : ''));
    const deepState = async (page, tr) => ({
      ...(await page.evaluate(() => ({
        urlSearchEmpty: location.search === '', dimEditModelId: typeof dimEditModelId !== 'undefined' ? dimEditModelId : null, dwdEditModelId: typeof dwdEditModelId !== 'undefined' ? dwdEditModelId : null,
        registerModalOpen: !!document.getElementById('registerModal') && getComputedStyle(document.getElementById('registerModal')).display !== 'none',
        validationModalOpen: !!document.getElementById('validationModal') && getComputedStyle(document.getElementById('validationModal')).display !== 'none',
        validationModelId: typeof currentValidationModelId !== 'undefined' ? currentValidationModelId : null,
        searchKeywordSet: !!document.getElementById('searchKeyword') && document.getElementById('searchKeyword').value !== '',
        page: typeof currentPage !== 'undefined' ? currentPage : null, rows: document.querySelectorAll('#modelListBody [data-id]').length, highlightedEver: (window.__mcHighlighted || []).slice(),
        toasts: window.__mcToasts || 0,
      }))),
      ...(await finalLoc(page)),
    });
    const noticeOf = async (page, tr) => tr.dialogs > 0 || (await page.evaluate(() => window.__mcToasts || 0)) > 0;
    const liveHashes = (g) => (g ? { ddl: h(g.ddl), full: h(g.fullLoad), incr: h(g.incremental), fdl: h(g.fdl), len: [g.ddl.length, g.fullLoad.length, g.incremental.length, g.fdl.length] } : { none: true });
    const loc = async (page) => finalLoc(page);

    // ---- P1 + P2：编辑配置灌控件后取值 / 保存配置 PUT body（DIM 5 个 + DWD 2 个）----
    out.p1 = {}; out.p2 = {};
    for (const id of [...FIXTURE_IDS.dim, ...FIXTURE_IDS.dwd]) {
      const isDim = rowOf(id).layer === 'dim';
      withStub(id);
      const { page, tr } = await openWb(admin, `?id=${id}&mode=edit`);   // C3b：配置台入口 = URL（编辑配置）；openWb 内已 settle
      await cardSettle(page, tr, `P1 编辑配置 #${id}`);
      const snap = await cardSnapshot(page);
      const got = await page.evaluate((d) => (d ? getDimConfig() : getDwdConfig()), isDim);
      const cfg = cfgOf(id);
      const expectCfg = isDim ? { scdConfig: cfg.scdConfig, sourceTables: cfg.sourceTables, advancedSql: cfg.advancedSql } : { dwdConfig: cfg.dwdConfig, sourceTables: cfg.sourceTables, advancedSql: cfg.advancedSql, selectedFields: cfg.selectedFields, derivedFields: cfg.derivedFields, configType: 'DWD' };
      const gotCmp = isDim ? { scdConfig: got.scdConfig, sourceTables: got.sourceTables, advancedSql: got.advancedSql } : got;
      const diffs = deepDiff(gotCmp, expectCfg);
      const entry = { ...hashSnapshot(snap), configKeys: Object.keys(got), configHash: h(JSON.stringify(got)), diffCount: diffs.length, diffNamesHash: h(diffs.join('|')), diffNames: id === 55 ? diffs : diffs.slice(0, 60) };
      if (isDim) {
        // 配置台「生成 DDL」（实时版 generateDimDDL + 三个共用生成器）
        const live = await page.evaluate(() => {
          try { openDdlPreviewModal(); } catch (e) { return { err: e.name }; }
          const g = window.generatedScripts ? { ddl: window.generatedScripts.ddl, fullLoad: window.generatedScripts.fullLoad, incremental: window.generatedScripts.incremental, fdl: window.generatedScripts.fdl } : null;
          const m = document.getElementById('ddlPreviewModal'); if (m) m.remove();
          return { g, scriptModelId: window.currentScriptModelId === undefined ? null : window.currentScriptModelId };
        });
        entry.livePreview = live.err ? live : { ...liveHashes(live.g), scriptModelId: live.scriptModelId };
      }
      out.p1[`${isDim ? 'dim' : 'dwd'}${id}`] = entry;
      // P2：保存配置（拦截 PUT，不落库）
      const w = await interceptWrite(page, tr, 'PUT', `**/api/models/${id}`, 200, '{"noChange":true}',
        () => page.evaluate((d) => (d ? saveDimConfigDirectly() : saveDwdConfigDirectly()), isDim), () => listHash(page), `P2 保存配置 #${id}`, { nav: true });
      const pb = w.body ? JSON.parse(w.body) : null;
      out.p2[`${isDim ? 'dim' : 'dwd'}${id}`] = {
        ...summarizeBody(w.body, rowOf(id).domain),
        dimConfigEqGetConfig: pb ? deepDiff(pb.dim_config, got).length === 0 : null,
        afterSave: {
          requests: w.requestsAfter,
          editIdAfter: await page.evaluate((d) => (d ? (typeof dimEditModelId !== 'undefined' ? dimEditModelId : 'n/a') : (typeof dwdEditModelId !== 'undefined' ? dwdEditModelId : 'n/a')), isDim),
          ...w.landing,   // C3b：落点 = 换页提交时的 URL（目录页清 ?focus 之前）
        },
      };
      out.p1[`${isDim ? 'dim' : 'dwd'}${id}`].consoleErrors = tr.errors + tr.pageErrors;
      await page.close();
    }

    // ---- P1 补充（有意同页）：连续编辑串状态，与陈旧 currentEditId（脚本写错模型目录）----
    {
      withStub(50);
      const { page, tr } = await openWb(admin, '?id=50&mode=edit');
      await cardSettle(page, tr, '连续编辑：先 #50');
      withStub(62);
      // C3b：配置台里无法在页内切换模型，「连续编辑」= 同一标签页里再进入 #62（整页重载，状态不再串）
      await page.goto(`${BASE}/Model_Workbench.html?id=62&mode=edit`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof dimEditModelId !== 'undefined' && dimEditModelId === 62 && (window.__mcToastTexts || []).some(t => /已加载|（只读）/.test(t)), null, { timeout: SETTLE_LIMIT_MS });
      await cardSettle(page, tr, '连续编辑：再 #62');
      const s2 = await cardSnapshot(page);
      const g2 = await page.evaluate(() => getDimConfig());
      out.p1Sequence = { dim50Then62: { ...hashSnapshot(s2), configHash: h(JSON.stringify(g2)) } };
      await page.close();
    }
    {
      withStub(55);
      const { page, tr } = await openPage(admin);
      await page.evaluate(async () => { const m = allModelsData.find(x => x.id == 6); await openEditModal(m); });   // 设置 currentEditId=6
      await page.evaluate(() => { document.getElementById('registerModal').style.display = 'none'; });
      // C3b：目录页里先设置 currentEditId=6，再进入配置台编辑 #55（配置台没有 currentEditId）
      await page.goto(`${BASE}/Model_Workbench.html?id=55&mode=edit`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof dimEditModelId !== 'undefined' && dimEditModelId === 55 && (window.__mcToastTexts || []).some(t => /已加载|（只读）/.test(t)), null, { timeout: SETTLE_LIMIT_MS });
      await cardSettle(page, tr, '陈旧 currentEditId：编辑 #55');
      const r = await page.evaluate(() => { try { openDdlPreviewModal(); } catch (e) { return { err: e.name }; } const v = window.currentScriptModelId; const m = document.getElementById('ddlPreviewModal'); if (m) m.remove(); return { scriptModelId: v === undefined ? null : v }; });
      out.staleCurrentEditId = { editedModel: 55, ...r };
      await page.close();
    }

    // ---- P3：注册新模型 POST body（ods / dim / dwd / ads，每层一个新页面）----
    out.p3 = {};
    for (const layer of ['ods', 'dim', 'dwd', 'ads']) {
      stubRef.fields = [];
      const { page, tr } = await openWb(admin);   // C3b：无 id = 注册新模型
      await page.evaluate((layer) => {
        document.getElementById('genLayer').value = layer; onLayerChange();
        document.getElementById('genObject').value = 'probe'; document.getElementById('genDesc').value = '探针';
        const dom = document.getElementById('genDomain'); if (dom.options.length > 1) dom.value = dom.options[1].value;
        if (layer === 'ods') { const ss = document.getElementById('genSourceSystem'); if (ss.options.length > 1) ss.value = ss.options[1].value; document.getElementById('genSourceTable').value = 'SrcTbl'; }
        generateName();
      }, layer);
      await cardSettle(page, tr, `P3 命名 ${layer}`);
      const name = await page.evaluate(() => document.getElementById('namePreview').value);
      await page.evaluate(() => openRegisterModal());
      const modalOpened = await page.evaluate(() => getComputedStyle(document.getElementById('registerModal')).display !== 'none');
      const w = await interceptWrite(page, tr, 'POST', '**/api/models', 200, '{"id":999}', () => page.evaluate(() => confirmRegister()), () => listHash(page), `P3 注册 ${layer}`, { nav: true });
      out.p3[layer] = { nameHash: h(name), modalOpenedBeforeConfirm: modalOpened, ...summarizeBody(w.body, null), afterRegister: { requests: w.requestsAfter, modalClosed: await page.evaluate(() => getComputedStyle(document.getElementById('registerModal')).display === 'none'), ...w.landing }, consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }

    // ---- P4：编辑信息 PUT body（ODS#6 / DIM#50 / DIM#55 / DWD#52，每个模型一个新页面）----
    out.p4 = {};
    for (const id of [6, 50, 55, 52]) {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin);
      await page.evaluate(async (i) => { const m = allModelsData.find(x => x.id == i); await openEditModal(m); }, id);
      await cardSettle(page, tr, `P4 编辑信息 #${id}`);
      const w = await interceptWrite(page, tr, 'PUT', `**/api/models/${id}`, 200, '{"noChange":true}', () => page.evaluate(() => confirmRegister()), () => listHash(page), `P4 提交 #${id}`);
      out.p4[`${rowOf(id).layer}${id}`] = { ...summarizeBody(w.body, rowOf(id).domain), originalDomainIsNull: rowOf(id).domain == null, afterSubmit: { requests: w.requestsAfter }, consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }

    // ---- P5：只读态（DIM#50 / DWD#52 / 伴生 DWD#53 / custom DIM#58）----
    out.p5 = {};
    for (const [label, id, fn] of [['dim50', 50, 'openDimConfigViewModal'], ['dwd52', 52, 'openDwdConfigViewModal'], ['dwd53companion', 53, 'openDwdConfigViewModal'], ['dim58custom', 58, 'openDimConfigViewModal']]) {
      withStub(id);
      void fn;   // C3b：原先调 window[fn](id)（openDimConfigViewModal / openDwdConfigViewModal）；现入口 = URL ?mode=view
      const { page, tr } = await openWb(admin, `?id=${id}&mode=view`);
      await cardSettle(page, tr, `P5 只读 ${label}`);
      const snap = await cardSnapshot(page);
      const extra = await page.evaluate(() => ({
        dimReadOnly: typeof dimEditReadOnly !== 'undefined' ? dimEditReadOnly : null, dwdReadOnly: typeof dwdEditReadOnly !== 'undefined' ? dwdEditReadOnly : null,
        dimEditModelId: dimEditModelId, dwdEditModelId: dwdEditModelId,
        closeBtnText: ((document.getElementById('cancelEditBtn') || document.getElementById('cancelDwdEditBtn') || {}).textContent || '').trim(),
        registerBtnDisabled: !!(document.getElementById('registerBtn') || {}).disabled,
        configMode: typeof getCurrentConfigMode === 'function' ? getCurrentConfigMode() : null,
      }));
      const { closeBtnText, ...extraRest } = extra;
      out.p5[label] = { ...hashSnapshot(snap), ...extraRest, closeBtnHash: h(closeBtnText), consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }

    // ---- U5：custom DIM#58 编辑后保存（三步各一个新页面）----
    out.u5 = { custom58: {} };
    {
      withStub(58);
      const a = await openWb(admin, '?id=58&mode=edit');
      await cardSettle(a.page, a.tr, 'U5 custom#58 编辑');
      const snap = await cardSnapshot(a.page);
      out.u5.custom58.edit = { ...hashSnapshot(snap), configMode: await a.page.evaluate(() => getCurrentConfigMode()), genLayer: await a.page.evaluate(() => document.getElementById('genLayer').value) };
      const w1 = await interceptWrite(a.page, a.tr, 'PUT', '**/api/models/58', 200, '{"noChange":true}', () => a.page.evaluate(() => saveDimConfigDirectly()), () => listHash(a.page), 'U5 custom#58 保存', { nav: true });
      out.u5.custom58.saveUnchanged = { ...summarizeBody(w1.body, rowOf(58).domain), afterSave: { requests: w1.requestsAfter, ...w1.landing } };
      const errA = a.tr.errors + a.tr.pageErrors;
      await a.page.close();
      const b = await openWb(admin, '?id=58&mode=edit');
      await cardSettle(b.page, b.tr, 'U5 custom#58 再次编辑');
      await b.page.evaluate(() => { const s = document.getElementById('genScdType'); s.value = 'SCD1'; s.dispatchEvent(new Event('change', { bubbles: true })); });
      await cardSettle(b.page, b.tr, 'U5 custom#58 改 SCD 类型');
      const w2 = await interceptWrite(b.page, b.tr, 'PUT', '**/api/models/58', 200, '{"noChange":true}', () => b.page.evaluate(() => saveDimConfigDirectly()), () => listHash(b.page), 'U5 custom#58 改后保存', { nav: true });
      out.u5.custom58.saveAfterScdChange = { ...summarizeBody(w2.body, rowOf(58).domain), afterSave: { requests: w2.requestsAfter, ...w2.landing } };
      out.u5.custom58.consoleErrors = errA + b.tr.errors + b.tr.pageErrors;
      await b.page.close();
    }

    // ---- P6：深链行为表 ----
    out.p6 = {};
    const deepCases = [
      ['dim50_dev', '?id=50&dev=1'], ['dwd52_dev', '?id=52&dev=1'], ['ods6_dev', '?id=6&dev=1'], ['dim58custom_dev', '?id=58&dev=1'], ['dwd53companion_dev', '?id=53&dev=1'],
      ['ods6_edit', '?id=6&edit=1'], ['dim55_plainId', '?id=55'], ['ods8_plainId', '?id=8'],
      ['dim65_validate', '?id=65&validate=1'], ['dim50_validate', '?id=50&validate=1'], ['dim62_validate_created', '?id=62&validate=1'], ['dwd52_validate_created', '?id=52&validate=1'], ['dim66_validate_softdeleted', `?id=${FIXTURE_IDS.deletedDim}&validate=1`],
      ['missing_dev', '?id=9999&dev=1'], ['missing_plain', '?id=9999'], ['search', '?search=' + encodeURIComponent(rowOf(55).table_name)],
    ];
    for (const [label, q] of deepCases) {
      const id = Number((q.match(/id=(\d+)/) || [])[1]) || null;
      if (id && rowOf(id)) withStub(id); else stubRef.fields = [];
      const { page, tr } = await openPage(admin, q, { noSettle: true });
      await settle(page, tr, async () => JSON.stringify(await deepState(page, tr)) + (await snapKey(page)), `P6 ${label}`);
      out.p6[label] = { ...(await deepState(page, tr)), noticeShown: await noticeOf(page, tr), consoleErrors: tr.errors + tr.pageErrors };
      delete out.p6[label].toasts;
      await page.close();
    }

    // ---- P7：目录页 DDL / ETL 按钮（真实点击，每个按钮一个新页面）+ ODS 生成路径 + 菜单入口 + goToPage ----
    out.p7 = {};
    const stateOf = (page) => page.evaluate(() => ({ dimEditModelId: typeof dimEditModelId !== 'undefined' ? dimEditModelId : null, dwdEditModelId: typeof dwdEditModelId !== 'undefined' ? dwdEditModelId : null, genLayer: (document.getElementById('genLayer') || {}).value || null }));
    const modalProbe = (page, modalId) => page.evaluate((mid) => { const m = document.getElementById(mid); return m ? { open: true, textHash: m.innerText.length + ':' + Array.from(m.innerText).reduce((a, c) => ((a * 31 + c.charCodeAt(0)) >>> 0), 7) } : { open: false }; }, modalId);
    for (const [label, id, btnText, modalId] of [['dimDdl50', 50, 'DDL', 'dimDdlPreviewModal'], ['dimEtl50', 50, 'ETL', 'dimEtlPreviewModal'], ['dwdDdl52', 52, 'DDL', 'dwdDdlModal'], ['dwdEtl52', 52, 'ETL', 'dwdEtlPreviewModal']]) {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin);
      const before = await stateOf(page);
      await clickRowAct(page, id, btnText === 'DDL' ? 'ddl' : 'etl');   // C4c-2：DDL / ETL 在 ⋯ 菜单里
      await page.waitForSelector('#' + modalId, { timeout: SETTLE_LIMIT_MS });
      await settle(page, tr, async () => JSON.stringify(await modalProbe(page, modalId)), `P7 ${label}`);
      const probe = await modalProbe(page, modalId);
      out.p7[label] = { modalOpen: probe.open, textHash: probe.open ? h(probe.textHash) : null, before, after: await stateOf(page), consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }
    // ODS#8：目录 DDL 按钮（openDDLModal → generateODSDDL / generateSyncScript）与「从源表获取字段」（generateODSDDLWithColumns）
    {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin);
      await page.route('**/api/db-connections/table-columns*', async (route) => {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ columns: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO', is_primary_key: true }, { column_name: 'name', data_type: 'nvarchar', max_length: 50, is_nullable: 'YES', column_comment: "o'k" }], table_comment: 'cmt' }) });
      });
      await page.evaluate(() => { currentPage = 2; renderModelsPage(); });
      await settle(page, tr, () => listHash(page), 'P7 ODS 翻到第 2 页');
      await clickRowAct(page, 8, 'ddl');   // C4c-2：ODS 的 DDL 在 ⋯ 菜单里
      await page.waitForFunction(() => getComputedStyle(document.getElementById('ddlModal')).display !== 'none', null, { timeout: SETTLE_LIMIT_MS });
      const odsState = () => page.evaluate(() => ({ ddl: document.getElementById('ddlCodeBlock').value, sync: document.getElementById('syncScriptBlock').value, fetchVisible: getComputedStyle(document.getElementById('fetchColumnsSection')).display !== 'none' }));
      await settle(page, tr, async () => JSON.stringify(await odsState()), 'P7 ODS DDL 弹窗');
      const s1 = await odsState();
      await page.locator('#fetchColumnsBtn').click();
      await settle(page, tr, async () => (await odsState()).ddl, 'P7 ODS 带字段 DDL');
      const s2 = await odsState();
      out.p7.odsDdl8 = { modalOpen: true, ddlHash: h(s1.ddl), syncHash: h(s1.sync), fetchSectionVisible: s1.fetchVisible, withColumnsDdlHash: h(s2.ddl), withColumnsDiffersFromPlain: s2.ddl !== s1.ddl, consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }
    // ODS#8：?validate=1 打开验收弹窗，并触发验收后的自动保存脚本（autoSaveOdsScripts：generateODSDDL + generateSyncScript → save-scripts 请求体，拦截不落盘）
    {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin, '?id=8&validate=1', { noSettle: true });
      await settle(page, tr, async () => JSON.stringify(await deepState(page, tr)), 'P7 ODS 验收弹窗');
      const opened = (await deepState(page, tr)).validationModalOpen;
      const w = await interceptWrite(page, tr, 'POST', '**/api/models/8/save-scripts', 200, '{"savedFiles":[],"configRevBumped":false}', () => page.evaluate(() => autoSaveOdsScripts()), async () => JSON.stringify(await deepState(page, tr)), 'P7 ODS 自动保存脚本');
      const body = w.body ? JSON.parse(w.body) : null;
      out.p7.odsValidate8 = { validationModalOpen: opened, saveScriptsBodyKeys: body ? Object.keys(body) : null, scriptKeys: body && body.scripts ? Object.keys(body.scripts) : null, ddlHash: body && body.scripts ? h(body.scripts.ddl) : null, syncHash: body && body.scripts ? h(body.scripts.sync) : null, tableNameHash: body ? h(body.tableName) : null, consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
    }
    // 经行内「编辑 ▾ → 编辑配置」菜单进入配置台（入口语义；C3b 改为跳转）
    {
      withStub(50);
      const { page, tr } = await openPage(admin);
      // C4c-2：旧「编辑 ▾」下拉（2 项）换成 ⋯ 菜单（6 项：ETL / DDL / 编辑配置 / 编辑信息 / 变更历史 / 删除）；菜单项数读「更多」菜单自身（AC-16 登记 2 → 6）
      const entry50 = page.locator('#modelListBody [data-id="50"]');
      await entry50.locator('[data-menu="more"]').click();
      const menuItems = await entry50.locator('.model-row-actions [role="menu"]:not([hidden]) [role="menuitem"]').count();
      await entry50.locator('[role="menuitem"][data-act="edit-config"]').click();
      await waitIntoWb(page, tr, 'P7 菜单进入编辑配置');   // C3b：菜单「编辑配置」= 跳转配置台
      out.p7.editMenuEntry = { menuItems, after: await stateOf(page), ...(await loc(page)) };
      await page.close();
    }
    // 经行内「配置」（只读）按钮进入：伴生 DWD#53（admin 也只读）
    {
      withStub(53);
      const { page, tr } = await openPage(admin);
      await clickRowAct(page, 53, 'view-config');   // C4c-2：「配置」（只读）在 ⋯ 菜单里
      await waitIntoWb(page, tr, 'P7 配置（只读）入口');
      out.p7.readonlyEntry = { after: await stateOf(page), ...(await loc(page)) };
      await page.close();
    }
    // goToPage：HEAD 会滚动到命名助手卡（.model-generator-card）
    {
      stubRef.fields = [];
      const { page, tr } = await openPage(admin);
      const totalPages = await page.evaluate(() => getCatalogView().totalPages);   // C4b：总页数按组算（唯一来源 = 核心视图）；值仍为 2
      const totalPagesByRows = await page.evaluate(() => Math.ceil(allModelsData.length / pageSize));   // 旧按行算式，仅打印对照（36 行 / 35 组：两者都是 2）
      console.log('[p7 goToPage] totalPages 按组 ' + totalPages + '，旧按行算式 ' + totalPagesByRows);
      await page.evaluate(() => { window.__mcScrollCalls.length = 0; goToPage(2); });
      await settle(page, tr, () => listHash(page), 'P7 goToPage(2)');
      out.p7.goToPage = { totalPages, currentPage: await page.evaluate(() => currentPage), scrollTargets: await page.evaluate(() => window.__mcScrollCalls.map(c => (/model-generator-card/.test(c) ? 'model-generator-card' : 'other'))) };
      out.p7.consoleErrors = tr.errors;
      await page.close();
    }

    // ---- U5：角色可见性（admin / viewer / 技术负责人 / 非负责人）----
    out.u5.roles = {};
    for (const user of USERS) {
      const rctx = user.role === 'admin' ? admin : await mkCtx(user);
      const label = user.username;
      stubRef.fields = [];
      const { page, tr } = await openPage(rctx);
      // C4c-2：旧 describeRows（逐行按钮清单 rows / rowsHash）依赖 tr + onclick 文本，新结构是 data-act 委托；该信息由 C4-0 矩阵（8 角色 ⊃ 这 4 角色）接替，
      //   故不再产出 rows / rowsHash（AC-16 登记 absent）。第 2 页渲染保留：继续收集该角色翻页渲染时的 console error / pageerror。
      await page.evaluate(() => { currentPage = 2; renderModelsPage(); });
      await settle(page, tr, () => listHash(page), `角色 ${label} 第 2 页`);
      const generic = await page.evaluate(() => {
        const card = document.querySelector('.model-generator-card');
        return {
          generatorCardDisplay: card ? getComputedStyle(card).display : 'absent',
          hiddenNavItems: Array.from(document.querySelectorAll('a.nav-item')).filter(a => a.style.display === 'none').length,
          // C4c-2：新列头条的「操作」格 #modelListOpHeader（viewer 隐藏但节点保留；旧口径读 textContent，与可见性无关，故 viewer 仍为 true）
          actionHeaderPresent: !!document.getElementById('modelListOpHeader') && /操作/.test(document.getElementById('modelListOpHeader').textContent),
        };
      });
      out.u5.roles[label] = { ...generic, consoleErrors: tr.errors + tr.pageErrors };
      await page.close();
      // 非负责人：行内「配置」（只读）按钮进入
      if (label === 'nonowner_user') {
        withStub(50);
        const c = await openPage(rctx);
        await clickRowAct(c.page, 50, 'view-config');   // C4c-2：「配置」（只读）在 ⋯ 菜单里
        await waitIntoWb(c.page, c.tr, '非负责人 配置（只读）入口');
        out.u5.roles[label].configButton = { after: await stateOf(c.page), ...(await loc(c.page)) };
        await c.page.close();
      }
      // 该角色经深链进入 DIM / DWD 编辑的行为
      out.u5.roles[label].deepLinks = {};
      for (const [dl, q, id] of [['dim50_dev', '?id=50&dev=1', 50], ['dwd52_dev', '?id=52&dev=1', 52], ['dim55_dev', '?id=55&dev=1', 55]]) {
        withStub(id);
        const d = await openPage(rctx, q, { noSettle: true });
        await settle(d.page, d.tr, async () => JSON.stringify(await deepState(d.page, d.tr)) + (await snapKey(d.page)), `角色 ${label} 深链 ${dl}`);
        const st = await deepState(d.page, d.tr);
        out.u5.roles[label].deepLinks[dl] = { dimEditModelId: st.dimEditModelId, dwdEditModelId: st.dwdEditModelId, urlSearchEmpty: st.urlSearchEmpty, finalPath: st.finalPath, finalSearch: st.finalSearch, noticeShown: await noticeOf(d.page, d.tr), consoleErrors: d.tr.errors + d.tr.pageErrors };
        await d.page.close();
      }
      if (rctx !== admin) await rctx.close();
    }
    // U5：?validate=1 在 CREATED 模型上不开弹窗的原因 = 软删除（is_deleted=1）模型不在列表里、找不到目标；
    //   同为 CREATED 的未删除模型（#52、#62）能正常打开（见 p6 里 dim62_validate_created / dwd52_validate_created / dim66_validate_softdeleted 三项对照）。
    out.u5.validateOnCreatedNote = '#62 在 N0 本地库里 is_deleted=1（软删除）：GET /api/models 过滤已删除行，目标找不到 → 深链静默无动作；与状态 CREATED 无关。对照见 p6。';

    // ---- 登记：已知行为变更（C3b 允许不同，且必须满足期望新值）与既有有损往返 ----
    const R = (pathRe, expect) => ({ pathRe, expect });
    const E = (p, expect) => R(exactRe(p), expect);
    const WB = 'Model_Workbench.html', MC = 'Model_Center.html';
    const p2Keys = Object.keys(out.p2), p3Keys = Object.keys(out.p3).filter(k => k !== 'consoleErrors');
    const idOfKey = (k) => String((k.match(/(\d+)/) || [])[1]);
    const roleDeep = (role, dl, id, mode) => [E(`u5.roles.${role}.deepLinks.${dl}.finalPath`, { eq: WB }), E(`u5.roles.${role}.deepLinks.${dl}.finalSearch`, { eq: `?id=${id}&mode=${mode}` })];
    out.allowedChanges = [
      { id: 'AC-1', source: '方案 v0.10 §6.2 第 12 条①', title: '页内连续编辑串状态消失（迁出后每次编辑是新页）：连续编辑 #50→#62 的结果必须与直接编辑 #62 的当前结果逐字段全等（字段清单写死、数组全等比较、关键字段非空）',
        rules: [E('p1Sequence.dim50Then62', { sameAsCurrent: 'p1.dim62', fields: ['controlCount', 'disabledCount', 'enabledCount', 'hiddenCount', 'controlHash', 'visibilityHash', 'cardTextHash', 'controlHashes', 'configHash'], nonEmpty: ['controlCount', 'controlHash', 'visibilityHash', 'cardTextHash', 'controlHashes', 'configHash'] })] },
      { id: 'AC-2', source: '方案 v0.10 §6.2 第 12 条②', title: 'currentScriptModelId 不再取陈旧的 currentEditId（修「脚本写错模型目录」）：期望 = 正在编辑的模型 id 55',
        rules: [E('staleCurrentEditId.scriptModelId', { eq: 55 })] },
      { id: 'AC-3', source: '方案 v0.10 §6.2 第 12、8 条', title: '保存 / 注册后由「原页刷新」变「跳回目录页并 ?focus=<id> 定位」：落点 = 目录页、search = 精确值（保存：?focus=<id>&notice=unchanged；注册：?focus=999&notice=registered；#77 P20 加 notice 参数，目录页显示原成功提示后清参）。注：本脚本的保存桩响应恒为 {"noChange":true}（见 interceptWrite 调用处），所以保存路径的 notice code 恒为 unchanged；注册用桩返回的新 id 999',
        rules: [
          ...p2Keys.flatMap(k => [E(`p2.${k}.afterSave.finalPath`, { eq: MC }), E(`p2.${k}.afterSave.finalSearch`, { eq: `?focus=${idOfKey(k)}&notice=unchanged` })]),
          ...p3Keys.flatMap(k => [E(`p3.${k}.afterRegister.finalPath`, { eq: MC }), E(`p3.${k}.afterRegister.finalSearch`, { eq: '?focus=999&notice=registered' })]),
          ...['saveUnchanged', 'saveAfterScdChange'].flatMap(k => [E(`u5.custom58.${k}.afterSave.finalPath`, { eq: MC }), E(`u5.custom58.${k}.afterSave.finalSearch`, { eq: '?focus=58&notice=unchanged' })]),
        ] },
      { id: 'AC-4', source: '方案 v0.10 §6.2 第 12 条④', title: 'goToPage 不再滚动到命名助手卡：scrollTargets 不得含 model-generator-card',
        rules: [E('p7.goToPage.scrollTargets', { notIncludes: 'model-generator-card' })] },
      { id: 'AC-5', source: '方案 v0.10 §6.2 第 5 条', title: '目录页「编辑信息」DIM 不再发送 domain（写死：请求体不含 domain 键；#50 原值 null、#55 原值 dom_b 两种都验）',
        rules: ['dim50', 'dim55'].flatMap(k => [E(`p4.${k}.domainState`, { eq: 'absent' }), E(`p4.${k}.fieldHashes.domain`, { absent: true })]) },
      { id: 'AC-6', source: '方案 v0.10 §6.2 第 11、12 条', title: 'viewer 经 ?id=&dev=1 深链 → 重定向回目录页并提示：最终落在目录页、无编辑态（dimEditModelId / dwdEditModelId 为 null）、出现提示（toast 或 alert）',
        rules: ['dim50_dev', 'dwd52_dev', 'dim55_dev'].flatMap(dl => [E(`u5.roles.viewer_user.deepLinks.${dl}.finalPath`, { eq: MC }), E(`u5.roles.viewer_user.deepLinks.${dl}.dimEditModelId`, { eq: null }), E(`u5.roles.viewer_user.deepLinks.${dl}.dwdEditModelId`, { eq: null }), E(`u5.roles.viewer_user.deepLinks.${dl}.noticeShown`, { eq: true })]) },
      { id: 'AC-7', source: '方案 v0.10 §6.2 第 11、12 条', title: '非负责人 user 打开编辑 → 降为只读：最终落在 Model_Workbench.html?id=<id>&mode=view（非负责人的 3 条深链；技术负责人对非自己负责的 #55 同理）',
        rules: [...['dim50_dev:50', 'dwd52_dev:52', 'dim55_dev:55'].flatMap(x => roleDeep('nonowner_user', x.split(':')[0], x.split(':')[1], 'view')), ...roleDeep('owner_user', 'dim55_dev', 55, 'view')] },
      { id: 'AC-8', source: '方案 v0.10 §6.2 第 6 条', title: '目录页 DIM / DWD 的 ?id=&dev=1（admin、负责人本人）→ 最终落在 Model_Workbench.html?id=<id>&mode=edit；ODS / ADS 的 ?dev=1 不变、不登记',
        rules: [
          ...['dim50_dev:50', 'dwd52_dev:52', 'dim58custom_dev:58', 'dwd53companion_dev:53'].flatMap(x => [E(`p6.${x.split(':')[0]}.finalPath`, { eq: WB }), E(`p6.${x.split(':')[0]}.finalSearch`, { eq: `?id=${x.split(':')[1]}&mode=edit` })]),
          ...['dim50_dev:50', 'dwd52_dev:52', 'dim55_dev:55'].flatMap(x => roleDeep('admin', x.split(':')[0], x.split(':')[1], 'edit')),
          ...['dim50_dev:50', 'dwd52_dev:52'].flatMap(x => roleDeep('owner_user', x.split(':')[0], x.split(':')[1], 'edit')),
        ] },
      { id: 'AC-9', source: '方案 v0.10 §6.2 第 6 条', title: '目录菜单「编辑配置」→ 跳 Model_Workbench.html?id=<id>&mode=edit；「配置（只读）」→ mode=view',
        rules: [E('p7.editMenuEntry.finalPath', { eq: WB }), E('p7.editMenuEntry.finalSearch', { eq: '?id=50&mode=edit' }), E('p7.readonlyEntry.finalPath', { eq: WB }), E('p7.readonlyEntry.finalSearch', { eq: '?id=53&mode=view' }), E('u5.roles.nonowner_user.configButton.finalPath', { eq: WB }), E('u5.roles.nonowner_user.configButton.finalSearch', { eq: '?id=50&mode=view' })] },
      { id: 'AC-10', source: '方案 v0.10 §6.2 第 6 条', title: '目录页不再有命名助手卡：generatorCardDisplay 期望 absent（卡不存在）',
        rules: USERS.map(u => E(`u5.roles.${u.username}.generatorCardDisplay`, { eq: 'absent' })) },
    ].map(a => ({ ...a, rules: a.rules.map(r => ({ pathRe: r.pathRe, expect: r.expect })) }));
    out.knownLossy = [
      { model: 50, kind: 'dim', what: '派生字段 source 的 "NULL" 回读为 ""（HEAD 自身的有损往返）', evidence: 'p1.dim50.diffNames', count: out.p1.dim50.diffCount },
      { model: 52, kind: 'dwd', what: 'changeTracking.companionModelId 不回读（HEAD 自身的有损往返）', evidence: 'p1.dwd52.diffNames', count: out.p1.dwd52.diffCount },
      { model: 55, kind: 'dim', what: 'U7：往返差异清单（桩按 trackFields 顺序给字段后仍有的差异），全量名称见 evidence', evidence: 'p1.dim55.diffNames', count: out.p1.dim55.diffCount },
    ];
    out.meta = { schema: 2, port: Number(new URL(BASE).port), fillerRows: FILLER_COUNT, frozenInstant: FIXED_ISO, timezoneId: TIMEZONE, modelCenterSha256: sha256File(MC_HTML), note: '基线只存哈希 / 计数 / 键集合 / 布尔 / 枚举 / 差异项名称（结构路径）；夹具已脱敏，映射表不入库；modelCenterSha256 是录制时工作区 Model_Center.html 的字节哈希（工作区为 CRLF，与 git show 的 LF 规范化哈希不同）' };
  } finally {
    await browser.close();
  }
  return out;
}

(async () => {
  let code = 1;
  // [#106 S4b2] ready() 是入口函数里第一条有副作用的语句（选项是纯字面量）。自测模式（--self-test-*）本不需要服务，但按硬规则也先起实例（裁定 D5）。
  //   SIGINT / SIGTERM 由 test-env 自己收实例（teardown 后以 130 / 143 退出），进程退出时的清理由它的 exit 钩子兜底。
  await testEnv.ready({ extraEnv: { SYS_FASTLANE_ENABLE: '0', LOG_LEVEL: 'INFO' } });
  initRuntime();
  process.on('uncaughtException', (e) => { console.error(e && e.stack || e); process.exit(1); });
  process.on('unhandledRejection', (e) => { console.error(e && e.stack || e); process.exit(1); });
  if (ARGS.includes('--self-test-compare')) { const c = selfTestCompare(); await testEnv.teardown(); testEnv.finish(c); return; }
  if (ARGS.includes('--self-test-settle')) { const c = await selfTestSettle(); await testEnv.teardown(); testEnv.finish(c); return; }
  try {
    const cur = await main();
    if (process.env.MC_DUMP) fs.writeFileSync(process.env.MC_DUMP, JSON.stringify(cur, null, 1));   // 调试：落盘本次实测（不入库）
    if (RECORD) {
      fs.writeFileSync(BASELINE_FILE, JSON.stringify(cur, null, 1) + '\n');
      console.log(`[record] 基线已写入 ${path.relative(ROOT, BASELINE_FILE)}（${Object.keys(cur).length} 个顶层段，${fs.statSync(BASELINE_FILE).size} 字节）`);
      code = 0;
    } else {
      if (!fs.existsSync(BASELINE_FILE)) throw new Error('缺少基线文件，请先在 HEAD 上 --record');
      const base = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
      const { real, allowed, hitKeys } = compareBaselines(base, JSON.parse(JSON.stringify(cur)));
      allowed.forEach(a => console.log('  允许差异 ' + a));
      real.forEach(d => console.log('  ✗ 差异 ' + d));
      console.log(`[baseline] 与基线比较：不允许的差异 ${real.length}，已登记的允许差异 ${allowed.length}`);
      if (ALLOW_CHANGES) {   // L4：AC-15 每条规则至少命中一次（登记是「允许」不是「要求」；页面退回按行分页时 rows 不变、没有差异可命中，这里判红）
        const ac15 = (withExtraAcs(base).allowedChanges || []).find(a => a.id === 'AC-15');
        const miss = ac15 ? ac15.rules.filter(r => !hitKeys.has('AC-15|' + new RegExp(r.pathRe).source)).map(r => r.pathRe) : ['(没有 AC-15)'];
        console.log(`[登记命中] AC-15 每条规则至少命中一次：${(ac15 ? ac15.rules.length : 0) - miss.length}/${ac15 ? ac15.rules.length : 0}`);
        if (miss.length) { miss.forEach(m => console.log('  ✗ AC-15 规则未被命中：' + m)); process.exitCode = 1; }
        const ac16 = (withExtraAcs(base).allowedChanges || []).find(a => a.id === 'AC-16');   // C4c-2：AC-16 同样每条至少命中一次
        const miss16 = ac16 ? ac16.rules.filter(r => !hitKeys.has('AC-16|' + new RegExp(r.pathRe).source)).map(r => r.pathRe) : ['(没有 AC-16)'];
        console.log(`[登记命中] AC-16 每条规则至少命中一次：${(ac16 ? ac16.rules.length : 0) - miss16.length}/${ac16 ? ac16.rules.length : 0}`);
        if (miss16.length) { miss16.forEach(m => console.log('  ✗ AC-16 规则未被命中：' + m)); process.exitCode = 1; }
        const ac17 = (withExtraAcs(base).allowedChanges || []).find(a => a.id === 'AC-17');   // 末次合并审 M8：AC-17 同样每条至少命中一次
        const miss17 = ac17 ? ac17.rules.filter(r => !hitKeys.has('AC-17|' + new RegExp(r.pathRe).source)).map(r => r.pathRe) : ['(没有 AC-17)'];
        console.log(`[登记命中] AC-17 每条规则至少命中一次：${(ac17 ? ac17.rules.length : 0) - miss17.length}/${ac17 ? ac17.rules.length : 0}`);
        if (miss17.length) { miss17.forEach(m => console.log('  ✗ AC-17 规则未被命中：' + m)); process.exitCode = 1; }
        const ac18 = (withExtraAcs(base).allowedChanges || []).find(a => a.id === 'AC-18');   // P53 = B：AC-18 同样每条至少命中一次
        const miss18 = ac18 ? ac18.rules.filter(r => !hitKeys.has('AC-18|' + new RegExp(r.pathRe).source)).map(r => r.pathRe) : ['(没有 AC-18)'];
        console.log(`[登记命中] AC-18 每条规则至少命中一次：${(ac18 ? ac18.rules.length : 0) - miss18.length}/${ac18 ? ac18.rules.length : 0}`);
        if (miss18.length) { miss18.forEach(m => console.log('  ✗ AC-18 规则未被命中：' + m)); process.exitCode = 1; }
      }
      code = (real.length || process.exitCode) ? 1 : 0;
    }
  } catch (e) {
    console.error(e && e.stack || e);
    code = 1;
  } finally {
    await testEnv.teardown();
  }
  // [#106 S4b2a] teardown 已在上面的 finally 里 await 落定；成功 / 失败出口改 finish（只设退出码，不终止执行），所以这是入口函数的最后一条语句。入口 .catch 里的 process.exit(1) 不改。
  testEnv.finish(code);
})().catch(async (e) => {
  console.error(e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 尽力收实例 */ }
  process.exit(1);
});
