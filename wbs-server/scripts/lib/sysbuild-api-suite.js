// 验证脚本：项目管理（系统建设记录）模块 C2a——权限核心（rules.js 身份与判定函数、项目状态 × 动作查表）与项目五个端点
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261027_v1.1.md §4.5 / §5 / §7
//   派单：docs/local/系统建设记录/送审准备/C2a_权限核心与项目端点_派单_20261029.md
//
// 本文件是 scripts/verify-sysbuild-api.js 的用例与夹具库（拆出来的原因：测试隔离守卫要求迁移脚本的入口函数第一条有副作用的语句就是
//   `await ready()`，不允许在它之前按命令行参数分流，而本套用例需要两种跑法）：
//   · runInstanceSuite(fx)  由 verify-sysbuild-api.js 在 `await fx.ready()` 之后调用：真实 HTTP + 真实 token 打在 test-env 自起的临时隔离实例上；
//   · runSelfTest(argv)     变异自检：对 routes/sysbuild/ 下被测文件逐一注入变异，每个变异在子进程里以 --inproc 重跑用例，
//                           必须至少一条判红（否则说明对应断言没有判别力）。两种跑法（P-S0，2026-11-01）：
//                           默认「过滤模式」——子进程只跑该变异 expect 前缀命中的用例（--only-file），另做子集基线（未变异副本跑同一子集，必须全绿，
//                           且子进程实际跑的用例名集合与名单逐项全等）与空跑对照（无语义改动的变异必须被判「未判红」；对照不过则汇总行写「判定无效」）；
//                           子集基线不绿的组，名下变异一律「不计为检出」；`--full` = 旧行为，每条变异跑全部用例（408 条时约 3.3 小时，C9 前跑一次；550 条时过滤模式实测 411–423 秒，`--full --mutations 408-549` 的 142 条 3136 秒）；
//                           `--mutations 0,5,400-407`（MUTATIONS 下标，含端点）只跑被挑中的变异，可与过滤 / --full 组合；逐条输出行带 `#<下标>`。
//                           下标方式只作快速定位用：展平数组由 membership / plan / items / confirm 几段依次展开，向较早的段追加变异会插到中间，「上一阶段总长度起的尾部区间」
//                           就不再是新增的那批（codex 20 号 M-1）。阶段补检一律按变异 id 名单：`--mutation-ids <JSON 文件>`（内容是 id 字符串数组），每个 id 必须在 MUTATIONS 中
//                           存在且恰好出现一次，名单内不得重复，与 `--mutations` 互斥，可与 `--full` 组合；MUTATIONS 加载时校验 id 全局唯一，有重复列出并以退出码 1 结束。
//                           expect 在两种模式共用的准备阶段统一校验（codex 20 号 L-1）：数组非空、每项为去首尾空白后非空的字符串、每项至少匹配一条基线用例；
//                           不过的变异不起子进程、不计为检出（输出 ✗ 行并计入未判红）。
//                           自检路径只收 `--self-test`、`--full`、`--mutations <值>`、`--mutation-ids <文件>`，其余参数（含 `--mutations=342`、`--mutation`）报参数错误、退出码非 0；
//                           主跑路径不收任何参数（含 `--full` / `--mutations` / `--self-test=1`），出现即报错（修订批二 LOW-8）。
//                           主跑汇总行 `N/M 通过`；有跳过（如停用账号只能在进程内夹具构造的用例，实例模式下打印「跳过（进程内专属）」）时为
//                           `N/M 通过（跳过 K）`，跳过不算通过也不算失败（修订批二 LOW-6）。
//                           修订批三（codex 19 号）起 MUTATIONS 共 587 条：新增下标 558–586；原地改锚点 / 改期望的下标 465、491、493、495、496、515、519、533–536、554（该批 41 条的 id 名单：tmp/c4a/fix4_ids_41.json）。
//                           【P30 阶段边界约定】过滤模式的变异只跑 expect 命中的用例，测不到「单跑判红、顺序跑被前序数据掩盖」；所以每个 sysbuild 阶段边界
//                           除过滤自检外，再跑一次 `--self-test --full --mutation-ids <本阶段新增与改动的变异 id 名单文件>`（这些变异在全量用例顺序下也要判红）；
//                           C9 前跑一次全量 `--self-test --full`。名单 = 本阶段新增的变异 + 本阶段改过锚点 / 改过 expect 的变异的 id（不再用「上一阶段总长度起的下标区间」）。
//   · node scripts/lib/sysbuild-api-suite.js --inproc [--module-dir <目录>] [--no-keep] [--only-file <JSON 文件>]（只供变异自检的子进程用）
//         --only-file：JSON 数组，元素为用例名前缀；只跑名字以任一前缀开头的用例（保持原顺序），汇总行 M = 实际跑的条数；
//         任一前缀匹配 0 条用例 → 不跑、打印原因、runWith 返回 3、进程退出码 1（不打印汇总行）；上层 runChild 按「无汇总行」判异常，不计为检出。
//         同一批用例改在进程内的自建 express 应用上跑（被测模块取自 --module-dir，缺省 routes/sysbuild；测试鉴权替身按请求头
//         x-test-user 设 req.user，一次性临时库 + 回环端口经 listenOnSafePort 取 20000–49999）。变异后的副本不能被整站实例加载，
//         所以变异自检用它；接线完整的验证（server.js 挂载、真实鉴权中间件、全局 JSON 解析）由主跑的真实实例承担。
//
// 期望值一律手写，不从被测代码取值（状态 × 动作表、转移表、错误码都在本文件里独立写出一份）。
'use strict';
const assert = require('assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { spawn } = require('child_process');
const { listenOnSafePort } = require('./listen-safe-port');
const { makeDingDouble } = require('./sysbuild-api-suite-notify'); // C6b：进程内夹具的钉钉 / 配置替身

let INPROC = false;
let NO_KEEP = false;
let DEFAULT_DIR = '';
let MODULE_DIR = '';
let ONLY = null; // --only-file 给出的用例名前缀数组；null = 跑全部
const READONLY_IDS = [6, 11]; // 与 server.js 的 READONLY_LEADER_IDS 同值
function parseArgs(argv) {
  INPROC = argv.includes('--inproc');
  NO_KEEP = argv.includes('--no-keep');
  DEFAULT_DIR = path.join(__dirname, '..', '..', 'routes', 'sysbuild');
  const argDirIdx = argv.indexOf('--module-dir');
  MODULE_DIR = argDirIdx >= 0 ? path.resolve(argv[argDirIdx + 1]) : DEFAULT_DIR;
  ONLY = null;
  const onlyIdx = argv.indexOf('--only-file');
  if (onlyIdx >= 0) {
    if (!argv[onlyIdx + 1]) throw new Error('--only-file 缺少文件路径');
    const arr = JSON.parse(fs.readFileSync(path.resolve(argv[onlyIdx + 1]), 'utf8'));
    if (!Array.isArray(arr) || arr.length === 0 || arr.some((x) => typeof x !== 'string' || x === '')) {
      throw new Error('--only-file 必须是非空字符串数组（用例名前缀）的 JSON 文件');
    }
    ONLY = arr;
  }
}

// ── 小工具 ───────────────────────────────────────────────────────────────────────────
function removeTree(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (fs.lstatSync(p).isSymbolicLink()) {
      try { fs.unlinkSync(p); } catch (_) { fs.rmdirSync(p); }
    } else if (e.isDirectory()) removeTree(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}
function openDb(file) {
  return new Promise((resolve, reject) => {
    const c = new sqlite3.Database(file, sqlite3.OPEN_READWRITE, (err) => {
      if (err) return reject(err);
      c.run('PRAGMA busy_timeout = 3000', (e) => (e ? reject(e) : resolve(c)));
      return undefined;
    });
  });
}
const dbExec = {
  run: (c, sql, p) => new Promise((res, rej) => c.run(sql, p || [], function cb(e) { if (e) rej(e); else res({ lastID: this.lastID, changes: this.changes }); })),
  get: (c, sql, p) => new Promise((res, rej) => c.get(sql, p || [], (e, r) => (e ? rej(e) : res(r)))),
  all: (c, sql, p) => new Promise((res, rej) => c.all(sql, p || [], (e, r) => (e ? rej(e) : res(r)))),
  close: (c) => new Promise((res) => { try { sqlite3.Database.prototype.close.call(c, () => res()); } catch (_) { res(); } }),
};

// ── 夹具（两种）──────────────────────────────────────────────────────────────────────
// H = { mode, world, call(uid, method, path, opts), sql: { run, get, all }, teardown(failed) }
//   world = { adminId, roId, plain: [用户编号…] }；plain 全是 active、非 admin、不在只读名单里的用户。
async function makeInstanceHarness(fx) { // 调用方已 await fx.ready()（fx = scripts/_test-fixture.js）
  const BASE = fx.BASE;
  const DB_FILE = fx.DB_PATH;
  const sql = {
    async run(s, p) { const c = await openDb(DB_FILE); try { return await dbExec.run(c, s, p); } finally { await dbExec.close(c); } },
    async get(s, p) { const c = await openDb(DB_FILE); try { return await dbExec.get(c, s, p); } finally { await dbExec.close(c); } },
    async all(s, p) { const c = await openDb(DB_FILE); try { return await dbExec.all(c, s, p); } finally { await dbExec.close(c); } },
  };
  const hr = await fetch(`${BASE}/api/health/ready`);
  const hj = await hr.json();
  if (!(hj && hj.modules && hj.modules.sysbuild && hj.modules.sysbuild.ready === true)) throw new Error('sysbuild 未就绪，用例无意义');
  const roRows = await sql.all(`SELECT id FROM users WHERE status = 'active' AND id IN (${READONLY_IDS.join(',')}) ORDER BY id`, []);
  if (roRows.length === 0) throw new Error(`实例库里没有 active 的只读账号（${READONLY_IDS.join(' / ')}）：无法验证只读否决`);
  // 普通用户：active、非 admin、不在只读名单。用例里的 PM 候选等都从这里取，而 viewer 不能建项也不能被指定为 PM（D1），
  //   所以先取写入角色（publisher / user）的用户，不够 11 位时把后面的 viewer 在实例库（一次性隔离副本，随 teardown 删除）里改成 user。
  const plain = await sql.all(`SELECT id, role FROM users WHERE status = 'active' AND role <> 'admin' AND id NOT IN (${READONLY_IDS.join(',')}) ORDER BY CASE WHEN role IN ('publisher', 'user') THEN 0 ELSE 1 END, id LIMIT 14`, []);
  if (plain.length < 11) throw new Error(`实例库里 active 的非 admin 普通用户不足 11 位（${plain.length}）`);
  for (const u of plain.slice(0, 11)) {
    if (u.role !== 'publisher' && u.role !== 'user') await sql.run("UPDATE users SET role = 'user' WHERE id = ?", [u.id]);
  }
  const tokens = {};
  // C6b：写请求提交后，发送意图在事务外异步发送并回写（状态 / 事件）；轮询到「最近 20 秒内创建的 pending 意图」清零再把响应交给用例（信号 = 意图状态，不用固定 sleep；
  //   用例自己造的旧 pending 夹具行创建时刻早于窗口，不会拖慢后续请求）。上限 3 秒，超时不报错（发送侧遇忙 / 异常的意图留在 pending，等补发）。
  async function settleSends() {
    for (let i = 0; i < 150; i += 1) {
      const row = await sql.get("SELECT COUNT(*) AS n FROM sysbuild_send_intents WHERE status = 'pending' AND created_at >= datetime('now','localtime','-20 seconds')", []);
      if (row.n === 0) return;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  const call = async (uid, method, urlPath, opts) => {
    const o = opts || {};
    const headers = {};
    if (uid !== null) {
      if (!tokens[uid]) tokens[uid] = await fx.signAs(uid);
      headers.Authorization = `Bearer ${tokens[uid]}`;
    }
    let body;
    if (o.formData !== undefined) body = o.formData;
    else if (o.raw !== undefined) { headers['content-type'] = 'application/json'; body = o.raw; } else if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    const r = await fetch(`${BASE}/api${urlPath}`, { method, headers, body });
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed = null;
    if ((r.headers.get('content-type') || '').includes('application/json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; } }
    if (method !== 'GET') await settleSends();
    return { status: r.status, body: parsed, text: buf.toString('utf8'), headers: r.headers }; // C4c：确认单用例要断言响应头
  };
  return {
    mode: '真实实例',
    notifyKit: null, // C6b：实例模式没有进程内替身；通知用例改读平台钉钉替身日志（dataDir 下 external-calls.jsonl）
    dataDir: () => { try { return require('./test-env').env().dataDir; } catch (_) { return null; } },
    world: { adminId: fx.ADMIN_ID, roId: roRows[0].id, plain: plain.map((r) => r.id) },
    call,
    sql,
    // 把某个用户的平台角色临时改掉（用例结束前改回）；令牌按改后的角色重新签。
    async setRole(uid, role) { await sql.run('UPDATE users SET role = ? WHERE id = ?', [role, uid]); delete tokens[uid]; },
    async teardown() { /* 实例由入口 await fx.teardown() 收掉 */ },
  };
}

async function makeInprocHarness() {
  const dbMod = require(path.join(MODULE_DIR, 'db.js'));
  const schema = require(path.join(MODULE_DIR, 'schema.js'));
  const { createProjectRoutes } = require(path.join(MODULE_DIR, 'projects.js'));
  const { createMembershipRoutes } = require(path.join(MODULE_DIR, 'membership.js'));
  const { createPlanRoutes } = require(path.join(MODULE_DIR, 'plan.js'));
  const { createItemRoutes } = require(path.join(MODULE_DIR, 'items.js'));
  const { createPackageRoutes } = require(path.join(MODULE_DIR, 'packages.js'));
  const { createConfirmRoutes } = require(path.join(MODULE_DIR, 'confirm.js'));
  const { createHistoryRoutes } = require(path.join(MODULE_DIR, 'history.js'));
  const { createConfirmationSheetRoutes } = require(path.join(MODULE_DIR, 'confirmation-sheet.js'));
  const { createEntryRoutes } = require(path.join(MODULE_DIR, 'entries.js'));
  const { createChangeRoutes } = require(path.join(MODULE_DIR, 'changes.js'));
  const { createGoliveRoutes } = require(path.join(MODULE_DIR, 'golive.js'));
  const { createNotifier, createNotifyRoutes } = require(path.join(MODULE_DIR, 'notify.js')); // C6b：通知（发送侧 + PM 补发 / 待办端点）
  // C8也验附件的读侧入口；路由和助手都取被测副本，不能让attachments.js变异跑到未变异的原件。
  // copyModuleDir已将multer等第三方依赖改成绝对路径，私有副本能够独立解析。
  const { createAttachmentRoutes } = require(path.join(MODULE_DIR, 'attachments.js'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-api-'));
  const DB_FILE = path.join(root, 'case.db');
  const logs = [];
  const mk = (level) => (...a) => { logs.push({ level, msg: a.map(String).join(' ') }); };
  const logger = { info: mk('info'), warn: mk('warn'), error: mk('error') };
  const rawDb = dbMod.createSysbuildDb({
    logger, DB_FILE, schemaObjects: schema.SCHEMA_OBJECTS, busyTimeoutMs: 1000, lockTimeoutMs: 3000,
    processExit: () => {}, enableTestHooks: true, // 只为拿到模块连接以便收尾关闭（getConnForTest）
  });
  await rawDb.initSchema();
  assert.strictEqual(rawDb.getReadiness().ready, true, '夹具库应初始化就绪');
  // C6b：钉钉替身（记录调用、可配置失败）与配置替身注入通知发送侧；各路由拿到的 db 是包装后的（事务提交后在事务外派发发送意图，回滚不发）。
  const ding = makeDingDouble();
  let settleSends = true; // 写请求之后等发送完成（见 call）；notifyKit.setSettle(false) 关闭
  const notifier = createNotifier({ db: rawDb, logger, dingtalkNotify: ding.api, getSystemConfig: ding.getSystemConfig, readonlyIds: READONLY_IDS, backgroundJobs: false });
  const db = notifier.wrapDb(rawDb);
  const ext = await openDb(DB_FILE);
  const sql = { run: (s, p) => dbExec.run(ext, s, p), get: (s, p) => dbExec.get(ext, s, p), all: (s, p) => dbExec.all(ext, s, p) };
  // 平台用户表（真实站点里由 server.js 建；这里只建被测代码用到的列）。
  await sql.run('CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT, role TEXT, status TEXT, phone TEXT, dingtalk_user_id TEXT)', []); // C6b：通知读收件人的 phone / dingtalk_user_id
  // C6b：夹具用户默认都有钉钉号（通知发送走替身，默认成功）；用例要走「无钉钉号 / 按手机号反查」分支时自己改 users 行
  const seedUser = (id, role) => sql.run('INSERT INTO users (id, username, display_name, role, status, dingtalk_user_id) VALUES (?, ?, ?, ?, ?, ?)', [id, `u${id}`, `用户${id}`, role, 'active', `ding-u${id}`]);
  await seedUser(1, 'admin');
  for (const id of READONLY_IDS) await seedUser(id, 'user');
  const plain = [];
  for (let i = 101; i <= 114; i += 1) { await seedUser(i, 'user'); plain.push(i); }
  const userInfo = {};
  for (const r of await sql.all('SELECT id, username, display_name, role FROM users', [])) userInfo[r.id] = r;
  const routes = createProjectRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'] }); // 与 server.js 的 WRITE_ALLOWED_ROLES 同值
  const app = express();
  app.use((req, res, next) => {
    const h = req.headers['x-test-user'];
    if (!h) return res.status(401).json({ code: 'UNAUTHORIZED' });
    req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); // 显示名含中文，请求头里用 base64 传
    return next();
  });
  app.use('/api', routes.router);
  const attachmentModule = createAttachmentRoutes({
    db, logger, UPLOAD_DIR: root, normalizeAttachmentExt: (n) => path.extname(String(n)).toLowerCase(), safeDeleteFileSync: () => {},
    COLLAB_ALLOWED_EXTS_UNION: ['.png'], readonlyIds: READONLY_IDS,
  });
  const attachmentHelpers = attachmentModule.helpers;
  app.use('/api', attachmentModule.router);
  // 固定「今天」（C3a 预筛 L9）：进程内夹具注入固定的 todayProvider，用例以服务端返回的日期为准并核对它等于这个注入值；与墙钟脱钩。
  //   currentToday 可由用例往回拨 / 复原（H.setToday）：codex 17 号 M-1 的收口防御用例要构造「实际开始晚于收口日期」，只有注入的 todayProvider 能做到。
  let currentToday = '2026-11-15';
  // C4b：代录端点（任职 / 授权 / 确认任务）绑定凭据附件用真实 attachments.js 的助手，外部确认日期上限用同一个注入的「今天」。
  const membershipRoutes = createMembershipRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday });
  app.use('/api', membershipRoutes.router);
  const planRoutes = createPlanRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday });
  app.use('/api', planRoutes.router);
  // C3b：模块 / 需求条目 / 内容包端点（条目登记与新版本沿用附件用真实 attachments.js 的绑定助手）
  app.use('/api', createItemRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers }).router);
  app.use('/api', createPackageRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'] }).router);
  app.use('/api', require(path.join(MODULE_DIR, 'materials.js')).createMaterialRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers }).router);
  // C4a：内容包提交确认 / 撤回、确认任务改发 / 浏览 / 决策、待我确认（提交时用真实 attachments.js 的冻结助手）
  const confirmRoutes = createConfirmRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday });
  app.use('/api', confirmRoutes.router);
  // C4b Q-S2：历史补录窗口 / 历史补录 / 历史事实导入（复用 confirm 的条目集合重核与 plan 的收口取数；同一个「今天」注入）
  app.use('/api', createHistoryRoutes({
    db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday,
    recheckOverallSet: confirmRoutes.recheckOverallSet, loadPlanData: planRoutes.loadPlanData,
  }).router);
  // C4c R-S1：需求确认单导出（纯读，不需要附件助手与「今天」）
  app.use('/api', createConfirmationSheetRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'] }).router);
  // C5 S-S1a：登记与办理、知会与知会异议（写登记绑定附件、给结论冻结登记附件用真实 attachments.js 的助手；同一个注入的「今天」）
  const entryRoutes = createEntryRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday });
  app.use('/api', entryRoutes.router);
  app.use('/api', createChangeRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers }).router);
  // C6a：上线交接集合 / 交接确认发起 / 确认试运行结束 / 撤销上线（里程碑节点收口记的实际日期用同一个注入的「今天」）
  app.use('/api', createGoliveRoutes({ db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers, todayProvider: () => currentToday }).router);
  // C6b：PM 补发 / 发送意图列表、我的待办（待办的待我确认 / 知会两类读 confirm / entries 导出的同一取数函数）
  app.use('/api', createNotifyRoutes({
    db, logger, readonlyIds: READONLY_IDS, writeRoles: ['admin', 'publisher', 'user'], notifier,
    myConfirmationItems: confirmRoutes.myConfirmationItems, myNoticeItems: entryRoutes.myNoticeItems, myInvitationItems: membershipRoutes.myInvitationItems,
  }).router);
  // C8：仅夹具的可控读后交错；在第一次读锁释放后执行一次hook，验证任务GET二次锁内仍核修订。
  const readInterleaveKit = { install(fn) {
    const original = db.withRead;
    let armed = true;
    db.withRead = async (...args) => {
      const value = await original(...args);
      if (armed) { armed = false; await fn(); }
      return value;
    };
    return () => { db.withRead = original; };
  } };
  const server = await listenOnSafePort(app);
  const port = server.address().port;
  const call = async (uid, method, urlPath, opts) => {
    const o = opts || {};
    const headers = {};
    if (uid !== null) headers['x-test-user'] = Buffer.from(JSON.stringify(userInfo[uid]), 'utf8').toString('base64');
    let body;
    if (o.formData !== undefined) body = o.formData;
    else if (o.raw !== undefined) { headers['content-type'] = 'application/json'; body = o.raw; } else if (o.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(o.json); }
    const r = await fetch(`http://127.0.0.1:${port}/api${urlPath}`, { method, headers, body });
    const buf = Buffer.from(await r.arrayBuffer());
    let parsed = null;
    if ((r.headers.get('content-type') || '').includes('application/json')) { try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; } }
    // C6b：写请求提交后，发送意图在事务外异步发送并回写（状态 / 事件）；等它们发完再把响应交给用例，用例读到的库状态是确定的（信号 = notifier.whenIdle，不用固定 sleep）。
    //   用例要在「发送中」观察时关掉自动等待（notifyKit.setSettle(false)）。
    if (method !== 'GET' && settleSends) await notifier.whenIdle();
    return { status: r.status, body: parsed, text: buf.toString('utf8'), headers: r.headers }; // C4c：确认单用例要断言响应头
  };
  return {
    mode: '进程内',
    readInterleaveKit,
    notifyKit: { notifier, ding, db: rawDb, readonlyIds: READONLY_IDS, setSettle: (v) => { settleSends = v === true; }, modulePath: () => path.join(MODULE_DIR, 'notify.js') }, // C6b：发送侧、钉钉 / 配置替身、模块 db（beforeCommit 钩子构造事务回滚）
    get fixedToday() { return currentToday; },
    setToday(d) { currentToday = d; },
    world: { adminId: 1, roId: READONLY_IDS[0], plain },
    call,
    sql,
    async setRole(uid, role) { await sql.run('UPDATE users SET role = ? WHERE id = ?', [role, uid]); userInfo[uid].role = role; },
    async teardown(failed) {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((r) => server.close(() => r()));
      const mc = db._internals.getConnForTest && db._internals.getConnForTest();
      if (mc) await dbExec.close(mc);
      await dbExec.close(ext);
      if (failed && !NO_KEEP) { console.log(`  [保留现场] ${root}`); return; }
      try { removeTree(root); } catch (e) { console.log(`  [清理] 临时目录未删除: ${root} — ${e.message}`); }
    },
  };
}

// ── 用例 ─────────────────────────────────────────────────────────────────────────────
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
// 用例函数返回 SKIP = 本跑法下没有可断言的内容（如停用账号只能在进程内夹具里构造）：打印「跳过」，汇总行另计，不算通过也不算失败（修订批二 LOW-6）。
const SKIP = Symbol.for('sysbuild-api-suite.skip');
let H = null;
let W = null;
let seq = 0;
let MODS = null;

const U = {}; // 角色 → 用户编号，开跑前由 world 分配
function assignUsers() {
  const p = W.plain;
  Object.assign(U, {
    admin: W.adminId, ro: W.roId,
    pm: p[0], m1: p[1], m2: p[2], out: p[3], cand: p[4], cand2: p[5], own: p[6], del: p[7], x1: p[8], x2: p[9], x3: p[10], inactive: p[10], // inactive 只在单条用例里短暂置为停用再恢复，与 x3 不会同时使用
  });
}
const api = (uid, method, urlPath, json) => H.call(uid, method, urlPath, json === undefined ? {} : { json });
const sqlRun = (s, p) => H.sql.run(s, p);
const sqlGet = (s, p) => H.sql.get(s, p);
const sqlAll = (s, p) => H.sql.all(s, p);

function expectErr(r, status, code, label) {
  assert.strictEqual(r.status, status, `${label || ''} 状态码应为 ${status}，实际 ${r.status} ${String(r.text).slice(0, 200)}`);
  assert.ok(r.body && r.body.code === code, `${label || ''} code 应为 ${code}，实际 ${JSON.stringify(r.body)}`);
}
const GOOD = { system_name: '测试系统', build_type: 'inhouse' };
const eventsOf = (pid, type) => sqlAll('SELECT * FROM sysbuild_events WHERE project_id = ? AND event_type = ? ORDER BY id', [pid, type]);

// 种子：直接写库造项目 / 成员 / 参与方 / 任职 / 授权（只用于读侧与规则断言）。
async function mkProject(pm, status) {
  seq += 1;
  const r = await sqlRun("INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, status, created_by) VALUES (?, 'inhouse', ?, ?, ?)", [`种子项目${seq}`, pm, status || 'active', W.adminId]);
  await sqlRun("INSERT INTO sysbuild_members (project_id, user_id, joined_at, added_by) VALUES (?, ?, '2026-10-01 10:00:00', ?)", [r.lastID, pm, W.adminId]);
  return r.lastID;
}
// C6a 已结项夹具：结项只经 p_closing 收口产生，重开项目（closed → active）时 projects.js 要求整体验收结项节点是已收口（否则 500 数据不一致，预筛 LOW-3）；
//   直接把项目 UPDATE 成 closed 的夹具要让 p_closing 也处于已收口：有该节点就改成已收口，没有（mkProject 的种子项目不带模板节点）就补一个。只在要走「重开」的夹具里用。
async function markProjectClosedFixture(pid) {
  const node = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND batch_id IS NULL AND template_key = 'p_closing'", [pid]);
  if (node) {
    await sqlRun("UPDATE sysbuild_nodes SET status = 'closed', opened_at = COALESCE(opened_at, '2026-10-01 10:00:00'), closed_at = '2026-10-02 10:00:00' WHERE id = ?", [node.id]);
  } else {
    await sqlRun("INSERT INTO sysbuild_nodes (project_id, batch_id, template_key, name, sort_order, status, opened_at, closed_at) VALUES (?, NULL, 'p_closing', '整体验收结项', 99, 'closed', '2026-10-01 10:00:00', '2026-10-02 10:00:00')", [pid]);
  }
  await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [pid]);
}
async function addMember(pid, uid, opt) {
  const o = opt || {};
  const r = await sqlRun(
    'INSERT INTO sysbuild_members (project_id, party_id, user_id, joined_at, removed_at, removed_reason, added_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [pid, o.party || null, uid, o.pending ? null : '2026-10-01 10:00:00', o.removed ? '2026-10-02 10:00:00' : null, o.removed ? '离项' : null, W.adminId]
  );
  return r.lastID;
}
async function addParty(pid, name, side) {
  const r = await sqlRun('INSERT INTO sysbuild_parties (project_id, side, name, sort_order, created_by) VALUES (?, ?, ?, 0, ?)', [pid, side || 'demand', name, W.adminId]);
  return r.lastID;
}
async function addInvitation(pid, memberId, kind, status, invitedBy, apptId) {
  const r = await sqlRun(
    'INSERT INTO sysbuild_invitations (project_id, member_id, kind, appointment_id, status, invited_by, responded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [pid, memberId, kind, apptId || null, status, invitedBy, status === 'pending' ? null : '2026-10-05 10:00:00']
  );
  return r.lastID;
}
async function addAppointment(partyId, memberId, status) {
  const r = await sqlRun('INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at) VALUES (?, ?, ?, ?, ?)', [partyId, memberId, status, W.adminId, status === 'active' ? '2026-10-02 10:00:00' : null]);
  return r.lastID;
}
async function addDelegation(partyId, memberId, appointmentId, status) {
  const r = await sqlRun('INSERT INTO sysbuild_delegations (party_id, member_id, appointment_id, status, proposed_by, effective_at) VALUES (?, ?, ?, ?, ?, ?)', [partyId, memberId, appointmentId, status, W.adminId, status === 'active' ? '2026-10-03 10:00:00' : null]);
  return r.lastID;
}

// ── 用例登记（入口调用 defineCases()；测试隔离守卫要求模块顶层只有声明与一个入口调用，所以用例的 test(...) 都收在这个函数里）──
function defineCases() {
// ── 建项 ─────────────────────────────────────────────────────────────────────────────
test('建项：普通用户成功且自己是 PM；成员行已加入；事件 project_created / member_added 内容手写核对；空白被 trim、可空列缺省为 null', async () => {
  const r = await api(U.pm, 'POST', '/sysbuild/projects', { system_name: '  新系统  ', phase_name: '一期', build_type: 'outsource', goal: '目标', oa_number: '12345', initiated_on: '2026-10-01' });
  assert.strictEqual(r.status, 201, r.text);
  const p = r.body.project;
  assert.strictEqual(p.system_name, '新系统');
  assert.strictEqual(p.phase_name, '一期');
  assert.strictEqual(p.build_type, 'outsource');
  assert.strictEqual(p.goal, '目标');
  assert.strictEqual(p.oa_number, '12345');
  assert.strictEqual(p.initiated_on, '2026-10-01');
  assert.strictEqual(p.pm_user_id, U.pm);
  assert.strictEqual(p.status, 'active');
  assert.strictEqual(p.history_window, 'never');
  assert.strictEqual(r.body.actions.edit_basics, true);
  assert.ok(r.body.me.roles.includes('pm'));
  const members = await sqlAll('SELECT * FROM sysbuild_members WHERE project_id = ?', [p.id]);
  assert.strictEqual(members.length, 1);
  assert.strictEqual(members[0].user_id, U.pm);
  assert.strictEqual(members[0].party_id, null);
  assert.ok(members[0].joined_at, 'PM 成员行应已加入');
  assert.strictEqual(members[0].removed_at, null);
  assert.strictEqual(members[0].added_by, U.pm);
  const ev = await eventsOf(p.id, 'project_created');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].operator_id, U.pm);
  assert.strictEqual(ev[0].object_type, 'project');
  assert.strictEqual(ev[0].object_id, p.id);
  assert.deepStrictEqual(JSON.parse(ev[0].payload_json), { system_name: '新系统', phase_name: '一期', build_type: 'outsource', goal: '目标', oa_number: '12345', initiated_on: '2026-10-01', pm_user_id: U.pm });
  const mev = await eventsOf(p.id, 'member_added');
  assert.strictEqual(mev.length, 1);
  assert.deepStrictEqual(JSON.parse(mev[0].payload_json), { user_id: U.pm, party_id: null, as: 'pm' });
  const min = await api(U.pm, 'POST', '/sysbuild/projects', GOOD);
  assert.strictEqual(min.status, 201, min.text);
  assert.strictEqual(min.body.project.phase_name, null);
  assert.strictEqual(min.body.project.goal, null);
  assert.strictEqual(min.body.project.oa_number, null);
  assert.strictEqual(min.body.project.initiated_on, null);
});

test('建项：只读账号 403 且没有任何行；非 admin 传 pm_user_id 403', async () => {
  const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n;
  expectErr(await api(U.ro, 'POST', '/sysbuild/projects', GOOD), 403, 'SYSBUILD_FORBIDDEN', '只读账号建项');
  expectErr(await api(U.pm, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: U.m1 }, GOOD)), 403, 'SYSBUILD_FORBIDDEN', '非 admin 指定 PM');
  assert.strictEqual((await H.call(null, 'POST', '/sysbuild/projects', { json: GOOD })).status, 401, '未登录 401');
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, n0, '被拒绝的建项不得留行');
});

test('建项 D1：平台角色不在写入名单内（viewer）不能建项 403，也不能被指定为建项 PM / 更换后的 PM（各 400，field pm_user_id）', async () => {
  const v = U.x3;
  const orig = (await sqlGet('SELECT role FROM users WHERE id = ?', [v])).role;
  await H.setRole(v, 'viewer');
  try {
    const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n;
    expectErr(await api(v, 'POST', '/sysbuild/projects', GOOD), 403, 'SYSBUILD_FORBIDDEN', 'viewer 建项');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, n0, 'viewer 建项被拒不得留行');
    const c = await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: v }, GOOD));
    expectErr(c, 400, 'SYSBUILD_INVALID_INPUT', 'viewer 被指定为建项 PM');
    assert.strictEqual(c.body.field, 'pm_user_id');
    const pid = await mkProject(U.pm);
    const r = await api(U.admin, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: v, reason: '换' });
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', 'viewer 被指定为更换后的 PM');
    assert.strictEqual(r.body.field, 'pm_user_id');
    assert.strictEqual((await sqlGet('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid])).pm_user_id, U.pm);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, n0 + 1, '只有种子项目多了一行');
  } finally {
    await H.setRole(v, orig);
  }
  // 对照：恢复角色后同一个人可以建项。
  assert.strictEqual((await api(v, 'POST', '/sysbuild/projects', GOOD)).status, 201, '恢复为写入角色后可建项');
});

test('建项：admin 代建——不传 pm_user_id 400；候选 PM 是只读账号 / 不存在 / 账号停用 各 400；代建成功且 admin 不是成员', async () => {
  const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n;
  const bad = await api(U.admin, 'POST', '/sysbuild/projects', GOOD);
  expectErr(bad, 400, 'SYSBUILD_INVALID_INPUT', 'admin 不传 PM');
  assert.strictEqual(bad.body.field, 'pm_user_id');
  const ro = await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: U.ro }, GOOD));
  expectErr(ro, 400, 'SYSBUILD_INVALID_INPUT', '候选 PM 是只读账号');
  assert.strictEqual(ro.body.field, 'pm_user_id');
  expectErr(await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: 987654 }, GOOD)), 400, 'SYSBUILD_INVALID_INPUT', '候选 PM 不存在');
  expectErr(await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: 'abc' }, GOOD)), 400, 'SYSBUILD_INVALID_INPUT', '候选 PM 编号不合法');
  await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.inactive]);
  try {
    expectErr(await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: U.inactive }, GOOD)), 400, 'SYSBUILD_INVALID_INPUT', '候选 PM 账号停用');
  } finally {
    await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.inactive]);
  }
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, n0, '被拒绝的代建不得留行');
  const ok = await api(U.admin, 'POST', '/sysbuild/projects', Object.assign({ pm_user_id: U.cand }, GOOD));
  assert.strictEqual(ok.status, 201, ok.text);
  const pid = ok.body.project.id;
  assert.strictEqual(ok.body.project.pm_user_id, U.cand);
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.admin])).n, 0, 'admin 代建时不自动成为成员');
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND joined_at IS NOT NULL', [pid, U.cand])).n, 1);
  const ev = await eventsOf(pid, 'project_created');
  assert.strictEqual(ev[0].operator_id, U.admin, '事件操作人是 admin');
  assert.strictEqual(JSON.parse(ev[0].payload_json).pm_user_id, U.cand);
  assert.strictEqual(ok.body.me.is_member, false, 'admin 代建后不是成员');
  assert.strictEqual(ok.body.actions.edit_basics, false, 'admin 未接管不能改基本信息');
});

test('建项：参数校验各 400（系统名空 / 超长 / 非文本、build_type、期次名、目标、OA 号、立项日期、非法 JSON）；边界值通过；失败不留行', async () => {
  const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n;
  const bads = [
    [{ build_type: 'inhouse' }, 'system_name', '缺系统名'],
    [{ system_name: '   ', build_type: 'inhouse' }, 'system_name', '系统名空白'],
    [{ system_name: 'a'.repeat(101), build_type: 'inhouse' }, 'system_name', '系统名 101 字'],
    [{ system_name: 123, build_type: 'inhouse' }, 'system_name', '系统名非文本'],
    [{ system_name: '系统' }, 'build_type', '缺 build_type'],
    [{ system_name: '系统', build_type: 'x' }, 'build_type', 'build_type 非法'],
    [{ system_name: '系统', build_type: 'inhouse', phase_name: 'p'.repeat(51) }, 'phase_name', '期次名 51 字'],
    [{ system_name: '系统', build_type: 'inhouse', goal: 'g'.repeat(2001) }, 'goal', '目标 2001 字'],
    [{ system_name: '系统', build_type: 'inhouse', oa_number: 'abc' }, 'oa_number', 'OA 非数字'],
    [{ system_name: '系统', build_type: 'inhouse', oa_number: '1'.repeat(21) }, 'oa_number', 'OA 21 位'],
    [{ system_name: '系统', build_type: 'inhouse', oa_number: 123 }, 'oa_number', 'OA 是数字类型'],
    [{ system_name: '系统', build_type: 'inhouse', initiated_on: '2026-13-01' }, 'initiated_on', '月份 13'],
    [{ system_name: '系统', build_type: 'inhouse', initiated_on: '2026-02-30' }, 'initiated_on', '2 月 30 日'],
    [{ system_name: '系统', build_type: 'inhouse', initiated_on: '20261001' }, 'initiated_on', '无连字符'],
    [{ system_name: '系统', build_type: 'inhouse', initiated_on: '1999-12-31' }, 'initiated_on', '1999 年'],
  ];
  for (const [body, field, label] of bads) {
    const r = await api(U.pm, 'POST', '/sysbuild/projects', body);
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
    assert.strictEqual(r.body.field, field, `${label} 的 field`);
  }
  // 非法 JSON：真实站点里 server.js 的全局 JSON 解析先于本模块的解析器应答（{ error: '无效的JSON格式' }，没有 code），
  //   进程内夹具里是本模块自己的解析器（SYSBUILD_INVALID_INPUT）。两处都只断言 400 且不留行。
  assert.strictEqual((await H.call(U.pm, 'POST', '/sysbuild/projects', { raw: '{' })).status, 400, '非法 JSON 400');
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_projects', [])).n, n0, '参数错误不得留行');
  const edge = await api(U.pm, 'POST', '/sysbuild/projects', { system_name: 's'.repeat(100), build_type: 'procurement', phase_name: 'p'.repeat(50), goal: 'g'.repeat(2000), oa_number: '1'.repeat(20), initiated_on: '2099-12-31' });
  assert.strictEqual(edge.status, 201, edge.text);
  assert.strictEqual(Array.from(edge.body.project.system_name).length, 100);
});

// ── 可见性与列表 ──────────────────────────────────────────────────────────────────────
test('可见性：非成员 GET 详情 404 且与不存在的项目响应体逐字相同；只读账号与 admin 可见；待接受 / 已移出的人也是 404', async () => {
  const pid = await mkProject(U.pm);
  await addMember(pid, U.m1);
  await addMember(pid, U.x1, { pending: true });
  await addMember(pid, U.x2, { removed: true });
  const nf = await api(U.out, 'GET', `/sysbuild/projects/${pid}`);
  expectErr(nf, 404, 'SYSBUILD_NOT_FOUND', '非成员');
  const none = await api(U.out, 'GET', '/sysbuild/projects/99999999');
  expectErr(none, 404, 'SYSBUILD_NOT_FOUND', '不存在');
  assert.deepStrictEqual(nf.body, { code: 'SYSBUILD_NOT_FOUND', message: '项目或附件不存在' });
  assert.deepStrictEqual(nf.body, none.body, '两种 404 响应体必须相同');
  expectErr(await api(U.x1, 'GET', `/sysbuild/projects/${pid}`), 404, 'SYSBUILD_NOT_FOUND', '待接受的人还不是成员');
  expectErr(await api(U.x2, 'GET', `/sysbuild/projects/${pid}`), 404, 'SYSBUILD_NOT_FOUND', '已移出的人');
  assert.strictEqual((await api(U.m1, 'GET', `/sysbuild/projects/${pid}`)).status, 200);
  assert.strictEqual((await api(U.pm, 'GET', `/sysbuild/projects/${pid}`)).status, 200);
  assert.strictEqual((await api(U.ro, 'GET', `/sysbuild/projects/${pid}`)).status, 200, '只读账号可见');
  assert.strictEqual((await api(U.admin, 'GET', `/sysbuild/projects/${pid}`)).status, 200, 'admin 可见');
  expectErr(await api(U.pm, 'GET', '/sysbuild/projects/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
});

test('列表：scope=mine 只含本人已加入的项目（含 PM）；scope=all 普通用户 403、admin 与只读账号可见全部；非法 scope 400', async () => {
  const a = await mkProject(U.pm);
  const b = await mkProject(U.cand);
  await addMember(b, U.m1);
  const c = await mkProject(U.cand2);
  await addMember(c, U.m1, { pending: true });
  const d = await mkProject(U.cand);
  await addMember(d, U.m1, { removed: true });
  const mineM1 = await api(U.m1, 'GET', '/sysbuild/projects?scope=mine');
  assert.strictEqual(mineM1.status, 200, mineM1.text);
  const idsM1 = mineM1.body.projects.map((p) => p.id);
  assert.ok(idsM1.includes(b), 'm1 是 b 的成员');
  assert.ok(!idsM1.includes(a) && !idsM1.includes(c), 'm1 不是 a 的成员，在 c 里只是待接受');
  assert.ok(!idsM1.includes(d), 'm1 在 d 里已被移出，d 不在 scope=mine 里（M4）');
  // PM 即使没有成员行也算「我的」项目（PM 视为成员）：scope=mine 的 PM 分支。
  seq += 1;
  const noRow = (await sqlRun("INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, created_by) VALUES (?, 'inhouse', ?, ?)", [`无成员行${seq}`, U.x1, W.adminId])).lastID;
  const mineX1 = await api(U.x1, 'GET', '/sysbuild/projects?scope=mine');
  assert.ok(mineX1.body.projects.map((p) => p.id).includes(noRow), 'PM 没有成员行也在自己的 scope=mine 里（X2）');
  assert.strictEqual((await api(U.x1, 'GET', `/sysbuild/projects/${noRow}`)).status, 200, 'PM 没有成员行也能看详情');
  const mineDefault = await api(U.m1, 'GET', '/sysbuild/projects');
  assert.deepStrictEqual(mineDefault.body.projects.map((p) => p.id), idsM1, '缺省 scope = mine');
  const item = mineM1.body.projects.find((p) => p.id === b);
  assert.strictEqual(item.pm_user_id, U.cand);
  assert.ok(typeof item.pm_name === 'string' && item.pm_name.length > 0, '带 PM 显示名');
  assert.strictEqual(item.actions.edit_basics, false);
  assert.ok(item.me.roles.includes('member'));
  const mineAdmin = await api(U.admin, 'GET', '/sysbuild/projects?scope=mine');
  assert.ok(!mineAdmin.body.projects.map((p) => p.id).includes(a), 'admin 非成员，scope=mine 不含');
  expectErr(await api(U.m1, 'GET', '/sysbuild/projects?scope=all'), 403, 'SYSBUILD_FORBIDDEN', '普通用户 scope=all');
  expectErr(await api(U.pm, 'GET', '/sysbuild/projects?scope=all'), 403, 'SYSBUILD_FORBIDDEN', 'PM 也不能 scope=all');
  for (const uid of [U.admin, U.ro]) {
    const all = await api(uid, 'GET', '/sysbuild/projects?scope=all');
    assert.strictEqual(all.status, 200, all.text);
    const ids = all.body.projects.map((p) => p.id);
    assert.ok(ids.includes(a) && ids.includes(b) && ids.includes(c), `${uid} 应看到全部`);
  }
  expectErr(await api(U.m1, 'GET', '/sysbuild/projects?scope=everything'), 400, 'SYSBUILD_INVALID_INPUT', '非法 scope');
});

// ── 详情 ─────────────────────────────────────────────────────────────────────────────
test('详情：普通成员看不到待接受 / 已移出成员且无 removed_* 字段；PM 与 admin 看得到；只读账号按普通成员口径；参与方带现任负责人与生效代表人；身份卡', async () => {
  const pid = await mkProject(U.pm);
  const mC = await addMember(pid, U.m1);
  const pend = await addMember(pid, U.x1, { pending: true });
  const rem = await addMember(pid, U.x2, { removed: true });
  const party = await addParty(pid, '财务部');
  const mOwn = await addMember(pid, U.own, { party });
  const mDel = await addMember(pid, U.del, { party });
  const appt = await addAppointment(party, mOwn, 'active');
  await addDelegation(party, mDel, appt, 'active');
  // M2：已移出的人名下残留生效任职 / 授权，不能再以现任负责人 / 生效代表人的名义显示（对任何人，含 PM 与 admin）。
  const partyR = await addParty(pid, '残留任职部');
  await addAppointment(partyR, rem, 'active');
  const partyR2 = await addParty(pid, '残留授权部');
  await addDelegation(partyR2, rem, appt, 'active');
  const names = (r) => r.body.members.map((m) => m.id).sort((a, b) => a - b);
  const pmView = await api(U.pm, 'GET', `/sysbuild/projects/${pid}`);
  assert.strictEqual(pmView.status, 200, pmView.text);
  const statusOf = (r, id) => (r.body.members.find((m) => m.id === id) || {}).status;
  assert.strictEqual(statusOf(pmView, pend), 'pending');
  assert.strictEqual(statusOf(pmView, rem), 'removed');
  assert.strictEqual(statusOf(pmView, mC), 'joined');
  assert.strictEqual(pmView.body.members.find((m) => m.id === rem).removed_reason, '离项');
  assert.strictEqual(pmView.body.members.length, 6, 'PM 看到全部 6 行（PM 本人、m1、待接受、已移出、负责人、代表人）');
  const adminView = await api(U.admin, 'GET', `/sysbuild/projects/${pid}`);
  assert.deepStrictEqual(names(adminView), names(pmView), 'admin 与 PM 看到同一批成员行');
  for (const uid of [U.m1, U.own, U.ro]) {
    const v = await api(uid, 'GET', `/sysbuild/projects/${pid}`);
    assert.strictEqual(v.status, 200, `${uid} ${v.text}`);
    const ids = names(v);
    assert.ok(!ids.includes(pend) && !ids.includes(rem), `${uid} 不得看到待接受 / 已移出`);
    assert.ok(v.body.members.every((m) => m.status === 'joined'), `${uid} 只见已加入`);
    assert.ok(v.body.members.every((m) => !('removed_at' in m) && !('removed_reason' in m)), `${uid} 的成员行不带 removed_* 字段`);
    assert.strictEqual(v.body.members.length, 4, `${uid} 看到 4 位已加入成员`);
  }
  const ownerView = await api(U.own, 'GET', `/sysbuild/projects/${pid}`);
  assert.strictEqual(ownerView.body.parties.length, 3);
  assert.strictEqual(ownerView.body.parties[0].name, '财务部');
  assert.strictEqual(ownerView.body.parties[0].owner.member_id, mOwn);
  assert.strictEqual(ownerView.body.parties[0].delegate.member_id, mDel);
  for (const v of [ownerView, pmView, adminView]) {
    const byName = (n) => v.body.parties.find((p) => p.name === n);
    assert.strictEqual(byName('残留任职部').owner, null, '已移出的人不是现任负责人（M2）');
    assert.strictEqual(byName('残留授权部').delegate, null, '已移出的人不是生效代表人（M2）');
  }
  assert.deepStrictEqual(ownerView.body.me.owner_of_parties, [party]);
  assert.ok(ownerView.body.me.roles.includes('owner') && !ownerView.body.me.roles.includes('member'));
  const delView = await api(U.del, 'GET', `/sysbuild/projects/${pid}`);
  assert.deepStrictEqual(delView.body.me.delegate_of_parties, [party]);
  assert.ok(delView.body.me.roles.includes('delegate'));
  const roView = await api(U.ro, 'GET', `/sysbuild/projects/${pid}`);
  assert.ok(roView.body.me.roles.includes('readonly') && roView.body.me.is_member === false);
  assert.strictEqual(roView.body.actions.edit_basics, false);
  assert.strictEqual(pmView.body.project.id, pid);
  assert.strictEqual(pmView.body.me.is_pm, true);
});

// ── 改基本信息 ────────────────────────────────────────────────────────────────────────
test('改基本信息：PM 成功且事件 payload 只含改动列；相同值不写事件；null 清空可空列；非 PM 成员 403、admin（未接管）403', async () => {
  const pid = await mkProject(U.pm);
  await addMember(pid, U.m1);
  await sqlRun("UPDATE sysbuild_projects SET goal = '旧目标', phase_name = '二期', updated_at = '2000-01-01 00:00:00' WHERE id = ?", [pid]);
  const origName = (await sqlGet('SELECT system_name FROM sysbuild_projects WHERE id = ?', [pid])).system_name;
  const r = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '新目标', phase_name: '二期', system_name: '  改名后  ' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.body.changed.sort(), ['goal', 'system_name']);
  assert.strictEqual(r.body.project.goal, '新目标');
  assert.strictEqual(r.body.project.system_name, '改名后');
  const ev = await eventsOf(pid, 'project_updated');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].operator_id, U.pm);
  assert.deepStrictEqual(JSON.parse(ev[0].payload_json), { before: { goal: '旧目标', system_name: origName }, after: { goal: '新目标', system_name: '改名后' } }, 'payload 只含改动列（期次名未变，不在其中）');
  assert.notStrictEqual((await sqlGet('SELECT updated_at FROM sysbuild_projects WHERE id = ?', [pid])).updated_at, '2000-01-01 00:00:00', '改基本信息要更新 updated_at（X3）');
  assert.notStrictEqual(r.body.project.updated_at, '2000-01-01 00:00:00');
  const same = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '新目标' });
  assert.strictEqual(same.status, 200);
  assert.deepStrictEqual(same.body.changed, []);
  assert.strictEqual((await eventsOf(pid, 'project_updated')).length, 1, '无实际变化不写事件');
  const clr = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { phase_name: null, goal: '' });
  assert.strictEqual(clr.status, 200, clr.text);
  assert.strictEqual(clr.body.project.phase_name, null);
  assert.strictEqual(clr.body.project.goal, null);
  expectErr(await api(U.m1, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '非 PM 成员');
  expectErr(await api(U.admin, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
  expectErr(await api(U.ro, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '只读账号（非成员）');
  expectErr(await api(U.out, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
});

test('改基本信息：别的键（status / pm_user_id / history_window）400；空体 400；非法值 400；系统名不能清空；已终止 / 已结项 409，已暂停可改；只读账号即使是 PM 也 403', async () => {
  const pid = await mkProject(U.pm);
  for (const k of ['status', 'pm_user_id', 'history_window', 'created_by', 'foo']) {
    expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { [k]: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', `键 ${k}`);
  }
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, {}), 400, 'SYSBUILD_INVALID_INPUT', '空体');
  // 合法的基本信息列夹带不允许的键：整个请求 400，且合法列也没有被改（不是「忽略多余的键」）。
  const before = await sqlGet('SELECT goal, status, pm_user_id FROM sysbuild_projects WHERE id = ?', [pid]);
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '夹带', status: 'terminated' }), 400, 'SYSBUILD_INVALID_INPUT', '夹带 status');
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '夹带', pm_user_id: U.m1 }), 400, 'SYSBUILD_INVALID_INPUT', '夹带 pm_user_id');
  assert.deepStrictEqual(await sqlGet('SELECT goal, status, pm_user_id FROM sysbuild_projects WHERE id = ?', [pid]), before, '被拒绝的请求不得改任何列');
  // C3a（方案 v1.2 D44）：build_type 建项后不可改——PATCH 带它一律 400（值合法与否都一样，不是「值非法」）；「值非法」的校验只在 POST 建项上保留（见建项参数校验用例）。
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { build_type: 'zzz' }), 400, 'SYSBUILD_INVALID_INPUT', 'PATCH 带 build_type（字段不可改）');
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { build_type: 'outsource' }), 400, 'SYSBUILD_INVALID_INPUT', 'PATCH 带合法的 build_type 同样 400（字段不可改，不是值非法）');
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { system_name: null }), 400, 'SYSBUILD_INVALID_INPUT', '系统名不能清空');
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { oa_number: 'x1' }), 400, 'SYSBUILD_INVALID_INPUT', 'OA 非数字');
  const expectations = [['paused', 200, null], ['terminated', 409, 'SYSBUILD_PROJECT_READONLY'], ['closed', 409, 'SYSBUILD_PROJECT_READONLY'], ['active', 200, null]];
  for (const [st, status, code] of expectations) {
    await sqlRun('UPDATE sysbuild_projects SET status = ? WHERE id = ?', [st, pid]);
    const r = await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: `g-${st}` });
    if (code) expectErr(r, status, code, `状态 ${st}`); else assert.strictEqual(r.status, status, `状态 ${st}: ${r.text}`);
  }
  const roPid = await mkProject(U.ro);
  expectErr(await api(U.ro, 'PATCH', `/sysbuild/projects/${roPid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '只读账号是 PM 也不能改');
});

// ── 状态转移 ──────────────────────────────────────────────────────────────────────────
test('状态：四种合法转移成功（暂停 / 恢复 / 终止 / 重开）与事件内容；closed 可重开；终止后再暂停等非法转移 409；转入 closed 409；原因被 trim', async () => {
  const pid = await mkProject(U.pm);
  const step = async (to, reason) => api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to, reason });
  let r = await step('paused', '  暂停原因  ');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.project.status, 'paused');
  r = await step('active', '恢复');
  assert.strictEqual(r.body.project.status, 'active');
  r = await step('terminated', '终止');
  assert.strictEqual(r.body.project.status, 'terminated');
  r = await step('active', '重开');
  assert.strictEqual(r.body.project.status, 'active');
  r = await step('paused', '先暂停');
  r = await step('terminated', '暂停后直接终止');
  assert.strictEqual(r.body.project.status, 'terminated');
  expectErr(await step('paused', '非法'), 409, 'SYSBUILD_STATE', '终止后暂停');
  expectErr(await step('terminated', '非法'), 409, 'SYSBUILD_STATE', '终止后再终止');
  expectErr(await step('closed', '非法'), 409, 'SYSBUILD_STATE', '转入 closed');
  await step('active', '重开');
  expectErr(await step('active', '非法'), 409, 'SYSBUILD_STATE', '进行中再恢复');
  expectErr(await step('closed', '非法'), 409, 'SYSBUILD_STATE', '进行中转入 closed');
  await markProjectClosedFixture(pid);
  expectErr(await step('paused', '非法'), 409, 'SYSBUILD_STATE', '已结项暂停');
  expectErr(await step('terminated', '非法'), 409, 'SYSBUILD_STATE', '已结项终止');
  r = await step('active', '结项后重开');
  assert.strictEqual(r.status, 200, r.text);
  const evs = await eventsOf(pid, 'project_status_changed');
  assert.deepStrictEqual(evs.map((e) => JSON.parse(e.payload_json)), [
    { from: 'active', to: 'paused', reason: '暂停原因' },
    { from: 'paused', to: 'active', reason: '恢复' },
    { from: 'active', to: 'terminated', reason: '终止' },
    { from: 'terminated', to: 'active', reason: '重开' },
    { from: 'active', to: 'paused', reason: '先暂停' },
    { from: 'paused', to: 'terminated', reason: '暂停后直接终止' },
    { from: 'terminated', to: 'active', reason: '重开' },
    { from: 'closed', to: 'active', reason: '结项后重开' },
  ]);
  assert.ok(evs.every((e) => e.operator_id === U.admin));
});

test('状态：非 admin（PM / 成员 / 只读）403；非成员 404；缺 reason / 空白 / 超长 400；to 非法 400；失败不改状态不写事件', async () => {
  const pid = await mkProject(U.pm);
  await addMember(pid, U.m1);
  const body = { to: 'paused', reason: '原因' };
  expectErr(await api(U.pm, 'POST', `/sysbuild/projects/${pid}/status`, body), 403, 'SYSBUILD_FORBIDDEN', 'PM');
  expectErr(await api(U.m1, 'POST', `/sysbuild/projects/${pid}/status`, body), 403, 'SYSBUILD_FORBIDDEN', '成员');
  expectErr(await api(U.ro, 'POST', `/sysbuild/projects/${pid}/status`, body), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
  expectErr(await api(U.out, 'POST', `/sysbuild/projects/${pid}/status`, body), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'paused' }), 400, 'SYSBUILD_INVALID_INPUT', '缺 reason');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'paused', reason: '   ' }), 400, 'SYSBUILD_INVALID_INPUT', '空白 reason');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'paused', reason: 'r'.repeat(501) }), 400, 'SYSBUILD_INVALID_INPUT', '501 字 reason');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'foo', reason: '原因' }), 400, 'SYSBUILD_INVALID_INPUT', 'to 非法');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { reason: '原因' }), 400, 'SYSBUILD_INVALID_INPUT', '缺 to');
  assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_projects WHERE id = ?', [pid])).status, 'active');
  assert.strictEqual((await eventsOf(pid, 'project_status_changed')).length, 0);
  const ok = await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'paused', reason: 'r'.repeat(500) });
  assert.strictEqual(ok.status, 200, '500 字原因通过');
});

// ── 更换 PM / 接管 ────────────────────────────────────────────────────────────────────
test('接管：admin 接管后能改基本信息，原 PM 不再能改（403）但仍可见；事件 takeover=true；admin 成员行新建', async () => {
  const pid = await mkProject(U.pm);
  expectErr(await api(U.admin, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '接管前');
  const r = await api(U.admin, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: U.admin, reason: '  接管处理  ' });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.body.project.pm_user_id, U.admin);
  assert.strictEqual(r.body.actions.edit_basics, true, '接管后 admin 的 actions.edit_basics 为真');
  assert.strictEqual(r.body.actions.takeover, false, '已是 PM 后不能再接管');
  const am = await sqlAll('SELECT * FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.admin]);
  assert.strictEqual(am.length, 1);
  assert.ok(am[0].joined_at && am[0].removed_at === null && am[0].party_id === null);
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND joined_at IS NOT NULL AND removed_at IS NULL', [pid, U.pm])).n, 1, '原 PM 的成员行保留');
  assert.strictEqual((await api(U.admin, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'admin 改' })).status, 200);
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: '原 PM 改' }), 403, 'SYSBUILD_FORBIDDEN', '原 PM');
  const old = await api(U.pm, 'GET', `/sysbuild/projects/${pid}`);
  assert.strictEqual(old.status, 200, '原 PM 仍是成员，可见');
  assert.strictEqual(old.body.me.is_pm, false);
  assert.ok(old.body.me.roles.includes('member'));
  const ev = await eventsOf(pid, 'project_pm_changed');
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(JSON.parse(ev[0].payload_json), { from: U.pm, to: U.admin, reason: '接管处理', takeover: true });
  const madded = (await eventsOf(pid, 'member_added')).filter((e) => JSON.parse(e.payload_json).user_id === U.admin);
  assert.strictEqual(madded.length, 1);
  assert.deepStrictEqual(JSON.parse(madded[0].payload_json), { user_id: U.admin, party_id: null, as: 'pm', via: 'pm_change' }, '更换 PM 新建成员行的 member_added 带 via');
  assert.strictEqual(madded[0].object_type, 'member');
  assert.strictEqual(madded[0].object_id, am[0].id);
});

test('更换 PM（M3 / D5 硬门）：新 PM 有待接受的成员行 → 409 且不被置为已加入；成员行属某参与方 → 409；已加入且不属参与方 → 200 不新建；没有行 → 200 新建并写 member_added；已移出的残留行不影响', async () => {
  const pid = await mkProject(U.pm);
  const post = (uid) => api(U.admin, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: uid, reason: '换人' });
  const pmNow = async () => (await sqlGet('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid])).pm_user_id;
  const pendRow = await addMember(pid, U.cand, { pending: true });
  expectErr(await post(U.cand), 409, 'SYSBUILD_STATE', '待接受的成员行');
  assert.strictEqual((await sqlGet('SELECT joined_at FROM sysbuild_members WHERE id = ?', [pendRow])).joined_at, null, '不替本人把待接受的行置为已加入');
  assert.strictEqual(await pmNow(), U.pm);
  const party = await addParty(pid, '甲部');
  await addMember(pid, U.m2, { party });
  expectErr(await post(U.m2), 409, 'SYSBUILD_STATE', '成员行属某参与方');
  assert.strictEqual(await pmNow(), U.pm);
  assert.strictEqual((await eventsOf(pid, 'project_pm_changed')).length, 0, '被挡住的更换不写事件');
  // 已加入且不属于参与方：直接换，不新建行，也不写 member_added。
  const m = await addMember(pid, U.m1);
  const r2 = await post(U.m1);
  assert.strictEqual(r2.status, 200, r2.text);
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.m1])).n, 1);
  assert.strictEqual((await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.m1])).id, m);
  assert.strictEqual((await eventsOf(pid, 'member_added')).filter((e) => JSON.parse(e.payload_json).user_id === U.m1).length, 0, '没新建行就不写 member_added');
  const ev = await eventsOf(pid, 'project_pm_changed');
  assert.deepStrictEqual(JSON.parse(ev[0].payload_json), { from: U.pm, to: U.m1, reason: '换人', takeover: false });
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL', [pid, U.pm])).n, 1, '原 PM 的成员行保留');
  // 没有行：新建（已加入、不属参与方）并写 member_added（via pm_change）。
  const r3 = await post(U.cand2);
  assert.strictEqual(r3.status, 200, r3.text);
  const c2 = await sqlAll('SELECT * FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.cand2]);
  assert.strictEqual(c2.length, 1);
  assert.ok(c2[0].joined_at && c2[0].party_id === null && c2[0].removed_at === null);
  const ma = (await eventsOf(pid, 'member_added')).filter((e) => JSON.parse(e.payload_json).user_id === U.cand2);
  assert.strictEqual(ma.length, 1);
  assert.deepStrictEqual(JSON.parse(ma[0].payload_json), { user_id: U.cand2, party_id: null, as: 'pm', via: 'pm_change' });
  // 已移出的残留行（连同一条生效任职）不影响：既不算「已有行」，也不算兼任；换完后恰有一条新的已加入行，旧的已移出行原样保留。
  const partyOld = await addParty(pid, '旧部');
  const gone = await addMember(pid, U.x1, { party: partyOld, removed: true });
  await addAppointment(partyOld, gone, 'active');
  await addAppointment(partyOld, gone, 'pending'); // 残留的待处理提议也只算未移出的行（X16）
  const r4 = await post(U.x1);
  assert.strictEqual(r4.status, 200, r4.text);
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL AND joined_at IS NOT NULL', [pid, U.x1])).n, 1, '换完后有一条已加入的未移出行（X11）');
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.x1])).n, 2, '旧的已移出行保留');
  assert.strictEqual((await eventsOf(pid, 'member_added')).filter((e) => JSON.parse(e.payload_json).user_id === U.x1).length, 1);
});

test('更换 PM：新 PM 是某方现任负责人 / 生效代表人 / 有待接受的任职或授权提议 → 409 SYSBUILD_STATE，PM 不变、不写事件；PM 不得兼任', async () => {
  const pid = await mkProject(U.pm);
  const party = await addParty(pid, '业务部');
  // 成员行 party_id 都留空：否则 pmClash 的「成员行属某参与方」会先于兼任判断挡住，遮蔽兼任查询本身（任职 / 授权挂在 party 上与成员行的 party_id 无关）。
  const mOwn = await addMember(pid, U.own);
  const mDel = await addMember(pid, U.del);
  const mP1 = await addMember(pid, U.x1);
  const mP2 = await addMember(pid, U.x2);
  const mP3 = await addMember(pid, U.x3);
  const appt = await addAppointment(party, mOwn, 'active');
  await addDelegation(party, mDel, appt, 'active');
  const party2 = await addParty(pid, '另一部');
  await addAppointment(party2, mP1, 'pending');
  await addDelegation(party, mP2, appt, 'pending_owner');
  await addDelegation(party, mP3, appt, 'pending_accept');
  for (const [uid, label] of [[U.own, '现任负责人'], [U.del, '生效代表人'], [U.x1, '待接受的任职提议'], [U.x2, '待负责人确认的授权提议'], [U.x3, '待本人接受的授权提议']]) {
    expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: uid, reason: '换' }), 409, 'SYSBUILD_STATE', label);
  }
  assert.strictEqual((await sqlGet('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid])).pm_user_id, U.pm);
  assert.strictEqual((await eventsOf(pid, 'project_pm_changed')).length, 0);
  // 已结束的任职不算兼任
  const pid2 = await mkProject(U.pm);
  const party3 = await addParty(pid2, '丙部');
  const mOld = await addMember(pid2, U.own);
  await sqlRun("INSERT INTO sysbuild_appointments (party_id, member_id, status, proposed_by, effective_at, ended_at, end_reason) VALUES (?, ?, 'ended', ?, '2026-10-02 10:00:00', '2026-10-05 10:00:00', '卸任')", [party3, mOld, W.adminId]);
  const ok = await api(U.admin, 'POST', `/sysbuild/projects/${pid2}/pm`, { pm_user_id: U.own, reason: '已卸任可担任' });
  assert.strictEqual(ok.status, 200, ok.text);
});

test('更换 PM：新 PM 是只读账号 / 不存在 / 账号停用 各 400；与现 PM 相同 409；非 admin 403；缺 reason / 缺 pm_user_id 400；非成员 404', async () => {
  const pid = await mkProject(U.pm);
  await addMember(pid, U.m1);
  const post = (uid, b) => api(uid, 'POST', `/sysbuild/projects/${pid}/pm`, b);
  const ro = await post(U.admin, { pm_user_id: U.ro, reason: '换' });
  expectErr(ro, 400, 'SYSBUILD_INVALID_INPUT', '只读账号');
  assert.strictEqual(ro.body.field, 'pm_user_id');
  expectErr(await post(U.admin, { pm_user_id: 987654, reason: '换' }), 400, 'SYSBUILD_INVALID_INPUT', '不存在');
  await sqlRun("UPDATE users SET status = 'disabled' WHERE id = ?", [U.inactive]);
  try {
    expectErr(await post(U.admin, { pm_user_id: U.inactive, reason: '换' }), 400, 'SYSBUILD_INVALID_INPUT', '账号停用');
  } finally {
    await sqlRun("UPDATE users SET status = 'active' WHERE id = ?", [U.inactive]);
  }
  expectErr(await post(U.admin, { pm_user_id: U.pm, reason: '换' }), 409, 'SYSBUILD_STATE', '与现 PM 相同');
  expectErr(await post(U.pm, { pm_user_id: U.cand, reason: '换' }), 403, 'SYSBUILD_FORBIDDEN', 'PM 自己不能换');
  expectErr(await post(U.m1, { pm_user_id: U.cand, reason: '换' }), 403, 'SYSBUILD_FORBIDDEN', '成员');
  expectErr(await post(U.ro, { pm_user_id: U.cand, reason: '换' }), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
  expectErr(await post(U.out, { pm_user_id: U.cand, reason: '换' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  expectErr(await post(U.admin, { pm_user_id: U.cand }), 400, 'SYSBUILD_INVALID_INPUT', '缺 reason');
  expectErr(await post(U.admin, { reason: '换' }), 400, 'SYSBUILD_INVALID_INPUT', '缺 pm_user_id');
  expectErr(await post(U.admin, { pm_user_id: 'x', reason: '换' }), 400, 'SYSBUILD_INVALID_INPUT', 'pm_user_id 非法');
  assert.strictEqual((await sqlGet('SELECT pm_user_id FROM sysbuild_projects WHERE id = ?', [pid])).pm_user_id, U.pm);
  assert.strictEqual((await eventsOf(pid, 'project_pm_changed')).length, 0);
  assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.cand])).n, 0, '被拒绝的更换不得留成员行');
});

// ── 检查顺序 ──────────────────────────────────────────────────────────────────────────
test('检查顺序：非成员对不存在的项目 → 404；成员无权限且项目已终止 → 403（不是 409）；参数非法且无权限 → 400；参数非法且项目不存在 → 400；非 admin 做非法转移 → 403', async () => {
  const gone = 99999999;
  expectErr(await api(U.out, 'PATCH', `/sysbuild/projects/${gone}`, { goal: 'x' }), 404, 'SYSBUILD_NOT_FOUND', 'PATCH 不存在');
  expectErr(await api(U.out, 'POST', `/sysbuild/projects/${gone}/status`, { to: 'paused', reason: 'r' }), 404, 'SYSBUILD_NOT_FOUND', 'status 不存在');
  expectErr(await api(U.out, 'POST', `/sysbuild/projects/${gone}/pm`, { pm_user_id: U.cand, reason: 'r' }), 404, 'SYSBUILD_NOT_FOUND', 'pm 不存在');
  const pid = await mkProject(U.pm, 'terminated');
  await addMember(pid, U.m1);
  expectErr(await api(U.out, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '非成员 + 终止');
  expectErr(await api(U.m1, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 403, 'SYSBUILD_FORBIDDEN', '无权限 + 终止应是 403');
  expectErr(await api(U.pm, 'PATCH', `/sysbuild/projects/${pid}`, { goal: 'x' }), 409, 'SYSBUILD_PROJECT_READONLY', '有权限 + 终止才是 409');
  expectErr(await api(U.m1, 'PATCH', `/sysbuild/projects/${pid}`, { oa_number: 'x1' }), 400, 'SYSBUILD_INVALID_INPUT', '参数非法先于权限');
  expectErr(await api(U.out, 'PATCH', `/sysbuild/projects/${gone}`, { oa_number: 'x1' }), 400, 'SYSBUILD_INVALID_INPUT', '参数非法先于存在性');
  expectErr(await api(U.out, 'POST', `/sysbuild/projects/${gone}/status`, { to: 'foo', reason: 'r' }), 400, 'SYSBUILD_INVALID_INPUT', 'to 非法先于存在性');
  expectErr(await api(U.m1, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'terminated', reason: 'r' }), 403, 'SYSBUILD_FORBIDDEN', '无权限先于非法转移');
  expectErr(await api(U.admin, 'POST', `/sysbuild/projects/${pid}/status`, { to: 'terminated', reason: 'r' }), 409, 'SYSBUILD_STATE', 'admin 的非法转移才是 409');
});

// ── actions 与执行一致 ────────────────────────────────────────────────────────────────
const STATUSES = ['active', 'paused', 'terminated', 'closed'];
// 身份：pm / member / admin（非成员）/ readonly（非成员）/ admin_pm（admin 已接管）；
//   admin_owner = admin 兼某方现任负责人；admin_pendrow = admin 在本项目有待接受的成员行；admin_party = admin 的成员行属某参与方
//   （后三种让 takeover 的 pmClash 三种挡法各有一个身份：标志为假、执行 409，M1 / M3 / D5）。
const KINDS = ['pm', 'member', 'admin', 'readonly', 'admin_pm', 'admin_owner', 'admin_pendrow', 'admin_party'];
// 手写期望（不取自被测代码）：谁能改基本信息 / 状态 / 更换 PM / 接管，及合法转移目标。
const EXPECT_EDIT = (kind, status) => (kind === 'pm' || kind === 'admin_pm') && (status === 'active' || status === 'paused');
const EXPECT_ADMIN = (kind) => kind === 'admin' || kind.startsWith('admin_');
const EXPECT_TARGETS = { active: ['paused', 'terminated'], paused: ['active', 'terminated'], terminated: ['active'], closed: ['active'] };

async function fresh(kind, status) {
  const pm = kind === 'admin_pm' ? U.admin : U.pm;
  const pid = await mkProject(pm, status);
  if (status === 'closed') await markProjectClosedFixture(pid); // 矩阵里的 closed → active 要真实执行（重开要求 p_closing 已收口）
  await addMember(pid, U.m1);
  if (kind === 'admin_owner') {
    const party = await addParty(pid, '甲部');
    const mAdm = await addMember(pid, U.admin, { party });
    await addAppointment(party, mAdm, 'active');
  } else if (kind === 'admin_pendrow') {
    await addMember(pid, U.admin, { pending: true });
  } else if (kind === 'admin_party') {
    const party = await addParty(pid, '乙部');
    await addMember(pid, U.admin, { party });
  }
  const uid = { pm: U.pm, member: U.m1, readonly: U.ro }[kind] || U.admin; // 其余身份都是 admin 本人
  return { pid, uid };
}
async function flagsOf(kind, status) {
  const { pid, uid } = await fresh(kind, status);
  const d = await api(uid, 'GET', `/sysbuild/projects/${pid}`);
  assert.strictEqual(d.status, 200, `${kind}/${status} 详情: ${d.text}`);
  return { pid, uid, actions: d.body.actions };
}

test('actions 与执行一致：8 种身份（含 admin 兼负责人 / 有待接受成员行 / 属参与方）× 4 种项目状态，标志为真 ⇔ 真实调用写端点成功；标志与手写期望表一致；为假时被拒（403 / 409）', async () => {
  for (const status of STATUSES) {
    for (const kind of KINDS) {
      const tag = `${kind}/${status}`;
      // 改基本信息
      {
        const { pid, uid, actions } = await flagsOf(kind, status);
        assert.strictEqual(actions.edit_basics, EXPECT_EDIT(kind, status), `${tag} edit_basics 与手写期望`);
        const r = await api(uid, 'PATCH', `/sysbuild/projects/${pid}`, { goal: `g-${tag}` });
        assert.strictEqual(r.status === 200, actions.edit_basics, `${tag} edit_basics 标志与执行结果不一致: 标志=${actions.edit_basics} 状态码=${r.status} ${r.text.slice(0, 120)}`);
        if (!actions.edit_basics) {
          const pmLike = kind === 'pm' || kind === 'admin_pm';
          if (pmLike) expectErr(r, 409, 'SYSBUILD_PROJECT_READONLY', `${tag} PM 被拒是状态原因`);
          else expectErr(r, 403, 'SYSBUILD_FORBIDDEN', `${tag} 非 PM 被拒是权限原因`);
        }
      }
      // 状态转移：每个目标状态各用一个新项目
      for (const to of STATUSES) {
        const { pid, uid, actions } = await flagsOf(kind, status);
        assert.strictEqual(actions.change_status, EXPECT_ADMIN(kind), `${tag} change_status 与手写期望`);
        assert.deepStrictEqual(actions.status_targets, EXPECT_ADMIN(kind) ? EXPECT_TARGETS[status] : [], `${tag} status_targets 与手写期望`);
        const allowed = actions.change_status && actions.status_targets.includes(to);
        const r = await api(uid, 'POST', `/sysbuild/projects/${pid}/status`, { to, reason: `测试${tag}→${to}` });
        assert.strictEqual(r.status === 200, allowed, `${tag}→${to} 标志与执行结果不一致: 允许=${allowed} 状态码=${r.status} ${r.text.slice(0, 120)}`);
        if (!allowed) {
          if (actions.change_status) expectErr(r, 409, 'SYSBUILD_STATE', `${tag}→${to}`);
          else expectErr(r, 403, 'SYSBUILD_FORBIDDEN', `${tag}→${to}`);
        }
      }
      // 更换 PM
      {
        const { pid, uid, actions } = await flagsOf(kind, status);
        assert.strictEqual(actions.change_pm, EXPECT_ADMIN(kind), `${tag} change_pm 与手写期望`);
        const r = await api(uid, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: U.cand, reason: `换${tag}` });
        assert.strictEqual(r.status === 200, actions.change_pm, `${tag} change_pm 标志与执行结果不一致: 标志=${actions.change_pm} 状态码=${r.status} ${r.text.slice(0, 120)}`);
        if (!actions.change_pm) expectErr(r, 403, 'SYSBUILD_FORBIDDEN', `${tag} change_pm`);
      }
      // 接管
      {
        const { pid, uid, actions } = await flagsOf(kind, status);
        assert.strictEqual(actions.takeover, kind === 'admin', `${tag} takeover 与手写期望`);
        const r = await api(uid, 'POST', `/sysbuild/projects/${pid}/pm`, { pm_user_id: uid, reason: `接管${tag}` });
        assert.strictEqual(r.status === 200, actions.takeover, `${tag} takeover 标志与执行结果不一致: 标志=${actions.takeover} 状态码=${r.status} ${r.text.slice(0, 120)}`);
        if (!actions.takeover) {
          // 期望（手写）：非 admin 身份缺权限 403；admin 的几种身份是候选人（本人）被 pmClash 或「已是 PM」挡住 → 409 SYSBUILD_STATE。
          if (kind.startsWith('admin_')) expectErr(r, 409, 'SYSBUILD_STATE', `${tag} takeover 被挡`);
          else expectErr(r, 403, 'SYSBUILD_FORBIDDEN', `${tag} takeover 缺权限`);
        }
      }
    }
  }
});

test('actions 在列表接口里与详情一致（同一项目、同一身份）', async () => {
  for (const kind of ['pm', 'admin', 'readonly']) {
    const { pid, uid, actions } = await flagsOf(kind, 'paused');
    const list = await api(uid, 'GET', `/sysbuild/projects?scope=${kind === 'pm' ? 'mine' : 'all'}`);
    assert.strictEqual(list.status, 200, list.text);
    const item = list.body.projects.find((p) => p.id === pid);
    assert.ok(item, `${kind} 的列表应含该项目`);
    assert.deepStrictEqual(item.actions, actions, `${kind} 列表与详情的 actions`);
  }
});

// ── 纯函数：状态 × 动作表与判定函数（手写矩阵）──────────────────────────────────────────
test('rules：项目状态 × 动作表逐格与手写矩阵全等；未登记的类别 / 状态拒绝；附件四态都允许（C1c 结果不变）', async () => {
  const { projectAllowsWrite } = MODS.rules;
  const T = true;
  const F = false;
  // 列顺序：进行中 / 已暂停 / 已终止 / 已结项
  //   方案 §4.5 表第 5 行「既有登记继续办理（结论、确认、异议、转迭代）」四态为 是 / 是 / 是 / 是，与 resolve 完全相同，并入 resolve，不单列类别（L1）。
  //   D3：接受 / 拒绝加入、任职、授权按 membership 判状态（M-S2 用），不按 accept。
  const expected = {
    basics: [T, T, F, F],
    maintain: [T, T, F, F],
    accept: [T, T, F, F],
    resolve: [T, T, T, T],
    register_process: [T, T, F, F],
    register_supplement: [T, T, T, T],
    comment: [T, T, T, T],
    attachment: [T, T, T, T],
    golive: [T, F, F, F],
    history_import: [T, T, F, F],
    g7: [F, F, F, T],
    membership: [T, T, F, T],
    close: [T, F, F, F], // C3a（方案 v1.2 §4.5 第二行）：节点收口单列——暂停时不能收口
    history_close: [T, T, T, T], // C4b Q-S2 预筛 P67：关闭「历史补录中」窗口不受项目状态限制（关闭只收窄能力）；开启 / 重开 / 补录 / 导入仍按 history_import 行
  };
  for (const [kind, row] of Object.entries(expected)) {
    STATUSES.forEach((st, i) => assert.strictEqual(projectAllowsWrite(st, kind), row[i], `${kind} × ${st}`));
  }
  assert.deepStrictEqual(Object.keys(MODS.rules.PROJECT_ACTION_TABLE).sort(), Object.keys(expected).sort(), '表里不多不少恰是这 14 类');
  assert.strictEqual(projectAllowsWrite('active', 'nonexistent'), false);
  assert.strictEqual(projectAllowsWrite('weird', 'basics'), false);
  assert.strictEqual(projectAllowsWrite('active', 'constructor'), false);
  assert.strictEqual(projectAllowsWrite('active', '__proto__'), false);
  assert.deepStrictEqual(MODS.rules.STATUS_TRANSITIONS, EXPECT_TARGETS, '转移表与手写期望全等');
});

test('rules：项目级判定函数的矩阵与只读一票否决（admin / PM 同样被否决）', async () => {
  const r = MODS.rules;
  const id = (o) => Object.assign({ project: { id: 1, status: 'active' }, isAdmin: false, isPm: false, isMember: false, isReadonly: false }, o);
  assert.strictEqual(r.canEditProjectBasics(id({ isPm: true })), true);
  assert.strictEqual(r.canEditProjectBasics(id({ isPm: true, isReadonly: true })), false, '只读 PM 否决');
  assert.strictEqual(r.canEditProjectBasics(id({ isAdmin: true })), false, 'admin 未接管');
  assert.strictEqual(r.canEditProjectBasics(id({ isMember: true })), false);
  assert.strictEqual(r.canChangeProjectStatus(id({ isAdmin: true })), true);
  assert.strictEqual(r.canChangeProjectStatus(id({ isAdmin: true, isReadonly: true })), false, '只读 admin 否决');
  assert.strictEqual(r.canChangeProjectStatus(id({ isPm: true })), false);
  assert.strictEqual(r.canChangePm(id({ isAdmin: true })), true);
  assert.strictEqual(r.canChangePm(id({ isAdmin: true, isReadonly: true })), false);
  assert.strictEqual(r.canChangePm(id({ isPm: true })), false);
  assert.strictEqual(r.canViewProject(id({ isMember: true })), true);
  assert.strictEqual(r.canViewProject(id({ isReadonly: true })), true);
  assert.strictEqual(r.canViewProject(id({ isAdmin: true })), true);
  assert.strictEqual(r.canViewProject(id({})), false);
  assert.strictEqual(r.canViewProject({ project: null, isAdmin: true }), false, '项目不存在不可见');
  assert.strictEqual(r.canListAll({ isAdmin: true, isReadonly: false }), true);
  assert.strictEqual(r.canListAll({ isAdmin: false, isReadonly: true }), true);
  assert.strictEqual(r.canListAll({ isAdmin: false, isReadonly: false }), false);
  assert.strictEqual(r.canCreateProject({ isAdmin: false, isReadonly: false, roleCanWrite: true }), true);
  assert.strictEqual(r.canCreateProject({ isAdmin: true, isReadonly: false, roleCanWrite: true }), true);
  assert.strictEqual(r.canCreateProject({ isAdmin: true, isReadonly: true, roleCanWrite: true }), false);
  assert.strictEqual(r.canCreateProject({ isAdmin: false, isReadonly: true, roleCanWrite: true }), false);
  assert.strictEqual(r.canCreateProject({ isAdmin: false, isReadonly: false, roleCanWrite: false }), false, '角色不在写入名单内（viewer）不能建项（D1）');
  assert.throws(() => r.platformIdentity({ id: 1 }, {}), (e) => e.status === 500 && e.code === 'SYSBUILD_INTERNAL', 'readonlyIds 缺失抛错');
  assert.throws(() => r.platformIdentity({ id: 1 }, { readonlyIds: [6] }), (e) => e.status === 500 && e.code === 'SYSBUILD_INTERNAL', 'writeRoles 缺失抛错');
  const popts = { readonlyIds: [6], writeRoles: ['admin', 'publisher', 'user'] };
  assert.deepStrictEqual(r.platformIdentity({ id: 5, role: 'viewer' }, popts), { isAdmin: false, isReadonly: false, roleCanWrite: false });
  assert.deepStrictEqual(r.platformIdentity({ id: 5, role: 'publisher' }, popts), { isAdmin: false, isReadonly: false, roleCanWrite: true });
  assert.deepStrictEqual(r.platformIdentity({ id: 6, role: 'user' }, popts), { isAdmin: false, isReadonly: true, roleCanWrite: true });
  assert.deepStrictEqual(r.platformIdentity({ id: 1, role: 'admin' }, popts), { isAdmin: true, isReadonly: false, roleCanWrite: true });
  // pmClash 纯函数（期望手写）：clash 先于 pending_member 先于 in_party；全空返回 null。
  const base = { ownerOfParties: [], delegateOfParties: [], hasPendingProposal: false, pendingMemberRow: false, partyId: null };
  assert.strictEqual(r.pmClash(base), null);
  assert.strictEqual(r.pmClash(Object.assign({}, base, { ownerOfParties: [3] })).code, 'clash');
  assert.strictEqual(r.pmClash(Object.assign({}, base, { delegateOfParties: [3] })).code, 'clash');
  assert.strictEqual(r.pmClash(Object.assign({}, base, { hasPendingProposal: true })).code, 'clash');
  assert.strictEqual(r.pmClash(Object.assign({}, base, { pendingMemberRow: true })).code, 'pending_member');
  assert.strictEqual(r.pmClash(Object.assign({}, base, { partyId: 7 })).code, 'in_party');
  assert.strictEqual(r.pmClash(Object.assign({}, base, { partyId: 7, pendingMemberRow: true, ownerOfParties: [1] })).code, 'clash');
  // actions.takeover 与 pmClash 同源（纯函数层面）：admin 且不是 PM 且 pmClash 为 null 才为真。
  const adm = (o) => Object.assign({ project: { id: 1, status: 'active' }, isAdmin: true, isPm: false, isMember: false, isReadonly: false }, base, o);
  assert.strictEqual(r.actionsFor(adm({}), { status: 'active' }).takeover, true);
  assert.strictEqual(r.actionsFor(adm({ ownerOfParties: [1] }), { status: 'active' }).takeover, false);
  assert.strictEqual(r.actionsFor(adm({ pendingMemberRow: true }), { status: 'active' }).takeover, false);
  assert.strictEqual(r.actionsFor(adm({ partyId: 2 }), { status: 'active' }).takeover, false);
  assert.strictEqual(r.actionsFor(adm({ isPm: true }), { status: 'active' }).takeover, false);
  assert.strictEqual(r.actionsFor(adm({ ownerOfParties: [1] }), { status: 'active' }).change_pm, true, 'change_pm 只表示可以发起，不含候选人校验');
});

test('rules：loadProjectIdentity 返回成员行、所属参与方、负责人 / 代表人集合与待处理邀请；待接受 / 已移出的人没有项目身份', async () => {
  const pid = await mkProject(U.pm);
  const party = await addParty(pid, '甲部');
  const mOwn = await addMember(pid, U.own, { party });
  const mDel = await addMember(pid, U.del, { party });
  const appt = await addAppointment(party, mOwn, 'active');
  await addDelegation(party, mDel, appt, 'active');
  const mPend = await addMember(pid, U.x1, { party, pending: true });
  await sqlRun("INSERT INTO sysbuild_invitations (project_id, member_id, kind, status, invited_by) VALUES (?, ?, 'join', 'pending', ?)", [pid, mPend, W.adminId]);
  const mGone = await addMember(pid, U.x2, { party, removed: true });
  const partyB = await addParty(pid, '乙部');
  await addAppointment(partyB, mGone, 'active'); // 已移出的人名下残留一条生效任职：不能算负责人
  // X8：已处理的邀请（accepted / declined / withdrawn）不算「待处理邀请」。
  await sqlRun("INSERT INTO sysbuild_invitations (project_id, member_id, kind, status, invited_by, responded_at) VALUES (?, ?, 'join', 'accepted', ?, '2026-10-05 10:00:00')", [pid, mPend, W.adminId]);
  await sqlRun("INSERT INTO sysbuild_invitations (project_id, member_id, kind, status, invited_by, responded_at) VALUES (?, ?, 'join', 'declined', ?, '2026-10-06 10:00:00')", [pid, mPend, W.adminId]);
  // X6：已移出的人名下残留生效授权，不算生效代表人；残留的待处理任职提议不算「有待处理提议」（只看未移出的行）。
  const partyF = await addParty(pid, '丙部');
  await addDelegation(partyF, mGone, appt, 'active');
  await addAppointment(partyF, mGone, 'pending');
  // X7：待接受（未加入）的成员行名下的生效任职不算负责人。
  const partyG = await addParty(pid, '丁部');
  const mPend3 = await addMember(pid, U.x3, { pending: true });
  await addAppointment(partyG, mPend3, 'active');
  // 正向：未移出的成员名下有待处理的任职提议 / 授权提议 → hasPendingProposal；已加入且属某参与方、没有任职 → partyId 非空。
  const partyH = await addParty(pid, '戊部');
  const mM2 = await addMember(pid, U.m2);
  await addAppointment(partyH, mM2, 'pending');
  const mCand = await addMember(pid, U.cand);
  await addDelegation(partyH, mCand, appt, 'pending_owner');
  await addMember(pid, U.out, { party });
  // rules.loadProjectIdentity 只用 q 的 get / all：直接拿夹具的外部连接包成 q 调用（与端点读的是同一份库）。
  const qExt = { get: sqlGet, all: sqlAll, run: sqlRun };
  const loadIn = (projectId, user) => MODS.rules.loadProjectIdentity(qExt, projectId, user, { readonlyIds: READONLY_IDS });
  const load = (uid, role) => loadIn(pid, { id: uid, role: role || 'user' });
  const own = await load(U.own);
  assert.strictEqual(own.memberId, mOwn);
  assert.strictEqual(own.partyId, party);
  assert.deepStrictEqual(own.ownerOfParties, [party]);
  assert.deepStrictEqual(own.delegateOfParties, []);
  const del = await load(U.del);
  assert.deepStrictEqual(del.delegateOfParties, [party]);
  assert.deepStrictEqual(del.ownerOfParties, []);
  const pend = await load(U.x1);
  assert.strictEqual(pend.isMember, false);
  assert.strictEqual(pend.memberId, null, '待接受的人没有成员身份');
  assert.deepStrictEqual(pend.pendingInvitations.map((i) => i.kind), ['join']);
  assert.strictEqual(pend.pendingInvitations.length, 1, '已接受 / 已拒绝的邀请不算待处理（X8）');
  assert.strictEqual(pend.pendingMemberRow, true);
  const gone = await load(U.x2);
  assert.strictEqual(gone.isMember, false);
  assert.deepStrictEqual(gone.ownerOfParties, []);
  assert.deepStrictEqual(gone.delegateOfParties, [], '已移出的人不是生效代表人（X6）');
  assert.strictEqual(gone.hasPendingProposal, false, '已移出的行上的待处理提议不算（X16）');
  assert.strictEqual(gone.pendingMemberRow, false);
  const pend3 = await load(U.x3);
  assert.deepStrictEqual(pend3.ownerOfParties, [], '待接受的成员行名下的生效任职不算负责人（X7）');
  assert.strictEqual(pend3.memberId, null);
  assert.strictEqual(pend3.pendingMemberRow, true);
  assert.strictEqual(pend3.hasPendingProposal, false);
  const m2id = await load(U.m2);
  assert.strictEqual(m2id.hasPendingProposal, true, '名下有待处理的任职提议');
  assert.strictEqual(m2id.ownerOfParties.length, 0);
  const candId = await load(U.cand);
  assert.strictEqual(candId.hasPendingProposal, true, '名下有待负责人确认的授权提议');
  assert.strictEqual(own.hasPendingProposal, false);
  assert.strictEqual(own.pendingMemberRow, false);
  // pmClash：同一个判定，三种挡法与不挡（期望手写）。
  assert.strictEqual(MODS.rules.pmClash(own).code, 'clash');
  assert.strictEqual(MODS.rules.pmClash(del).code, 'clash');
  assert.strictEqual(MODS.rules.pmClash(m2id).code, 'clash');
  assert.strictEqual(MODS.rules.pmClash(candId).code, 'clash');
  assert.strictEqual(MODS.rules.pmClash(pend).code, 'pending_member');
  assert.strictEqual(MODS.rules.pmClash(await load(U.out)).code, 'in_party');
  assert.strictEqual(MODS.rules.pmClash(gone), null, '已移出的人不挡');
  assert.strictEqual(MODS.rules.pmClash(await load(U.pm)), null);
  const pm = await load(U.pm);
  assert.strictEqual(pm.isPm, true);
  assert.strictEqual(pm.isMember, true);
  const adm = await load(U.admin, 'admin');
  assert.strictEqual(adm.isAdmin, true);
  assert.strictEqual(adm.isMember, false);
  const none = await loadIn(99999999, { id: U.pm, role: 'user' });
  assert.strictEqual(none.project, null);
});

// C2b（M-S2）：参与方 / 成员 / 任职 / 授权 / 邀请 / 窄范围入口的用例在 sysbuild-api-suite-membership.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-membership').defineMembershipCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, mkProject, addMember, addParty, addAppointment, addDelegation, addInvitation,
  getMods: () => MODS, getModuleDir: () => MODULE_DIR, setRole: (uid, role) => H.setRole(uid, role),
});

// C4a（#113 段 4）：「生产路径生效」共用助手（交接 ②：plan / items 套件里能经生产路径到达的 effective 改走提交 + 全部确认）与确认相关用例在 sysbuild-api-suite-confirm.js。
const confirmHelpers = require('./sysbuild-api-suite-confirm').makeConfirmHelpers({ U, api, sqlRun, sqlGet, sqlAll, addMember, addParty, addAppointment, addDelegation });

// C3a（#113 段 3 N-S1）：默认批次 / 节点模板 / 节点动作 / 排期与改期 / §4.5 收口闸门的用例在 sysbuild-api-suite-plan.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-plan').definePlanCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, getMods: () => MODS, getWorld: () => W, confirm: confirmHelpers,
  getModuleDir: () => MODULE_DIR, getFixedToday: () => (H && H.fixedToday) || null,
  // 往回拨 / 复原注入的「今天」；实例模式没有注入点，返回 false（用例据此跳过只能在进程内构造的部分）
  setFixedToday: (d) => { if (H && typeof H.setToday === 'function') { H.setToday(d); return true; } return false; },
});

// C3b（#113 段 3 N-S2）：模块 / 需求条目与版本 / 内容包与版本 / 附件沿用的用例在 sysbuild-api-suite-items.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-items').defineItemCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, getMods: () => MODS, getWorld: () => W,
  getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  // 原始 JSON 文本请求（不经 JSON.stringify）：18 号 L-1 要发 1e400 这类 JSON.stringify 会先改写成 null 的数字
  apiRaw: (uid, method, urlPath, rawText) => H.call(uid, method, urlPath, { raw: rawText }),
});

// C4a（#113 段 4）：内容包提交 / 撤回 / 浏览 / 决策 / 改发 / 生效与基线 / 提出人确认 / 待我确认 / actions 的用例，同一套夹具与变异自检。
require('./sysbuild-api-suite-confirm').defineConfirmCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C4b Q-S1（#113 段 5）：代录——无账号确认人 / 确认任务代录 / 任职接受与授权代录 / 提出人任务与改发 / 动作标志的用例在 sysbuild-api-suite-proxy.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-proxy').defineProxyCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C4b Q-S2（#113 段 5）：「历史补录中」时间窗 / 历史补录 / 历史事实导入 / 与当前确认任务按对象互斥的用例在 sysbuild-api-suite-history.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-history').defineHistoryCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C4c R-S1（#113 段 6）：需求确认单导出（GET …/confirmation-sheet）的用例在 sysbuild-api-suite-sheet.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-sheet').defineSheetCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C5 S-S1a（#113 段 7）：登记与办理、知会与知会异议、办理结论确认与负责人裁定的用例在 sysbuild-api-suite-entries.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-entries').defineEntryCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C5 S-S1b（#113 段 7）：问题分流与判定快照、混合拆分与手动拆分、待判定归属、节点收口前置、收口后异议、记系统迭代单号的用例在 sysbuild-api-suite-routing.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-routing').defineRoutingCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C5 S-S1c（#113 段 7）：正式变更（变更包生效生成新总体规划版本）与登记结论「转正式变更」/ 挂靠变更的用例在 sysbuild-api-suite-changes.js，同一套夹具与变异自检。
require('./sysbuild-api-suite-changes').defineChangeCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C5 S-S1c（#113 段 7）：开发方关键事项（处理说明 / 交付物 / 开发方来源的涉及承诺的认可、本人提交并确认、修订重提、办理依据、改期引用）与预筛第 3 轮三条 LOW 的用例在 sysbuild-api-suite-devkey.js。
require('./sysbuild-api-suite-devkey').defineDevKeyCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C6a（#113 段 8）：统一上线判据、批次验收包与结项包提交、上线交接集合与交接确认、确认试运行结束 / 撤销上线、整体结项与重开、上线事件历史导入的用例在 sysbuild-api-suite-golive.js。
require('./sysbuild-api-suite-golive').defineGoliveCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
});

// C6b（#113 段 8）：发送意图（触发点 × 收件人）、事务外发送与补发 / 扫描、防重、待办七类、改期知会与知会异议的用例在 sysbuild-api-suite-notify.js（进程内用钉钉替身；实例模式读平台钉钉替身日志）。
require('./sysbuild-api-suite-notify').defineNotifyCases({
  test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, getMods: () => MODS, getModuleDir: () => MODULE_DIR, confirm: confirmHelpers,
  getFixedToday: () => (H && H.fixedToday) || null, SKIP,
  getKit: () => (H && H.notifyKit) || null, getDataDir: () => (H && typeof H.dataDir === 'function' ? H.dataDir() : null),
});
// C7：空列表入口能力与只读时间线分页。
require('./sysbuild-api-suite-frontend').defineFrontendCases({
  test, U, api, sqlGet, sqlAll, mkProject, addMember, expectErr, setRole: (uid, role) => H.setRole(uid, role),
});
require('./sysbuild-api-suite-stage8').defineStage8Cases({ test, U, api, sqlGet, sqlAll, sqlRun, confirm: confirmHelpers, SKIP, getReadInterleaveKit: () => H && H.readInterleaveKit,
  stageFile: async (uid, pid) => {
    const data = new FormData();
    data.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO/aK7kAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'evidence.png');
    const response = await H.call(uid, 'POST', '/sysbuild/projects/' + pid + '/attachments/stage', { formData: data });
    assert.strictEqual(response.status, 200, response.text);
    return response.body.attachment.id;
  },
});
}

// ── 运行 ─────────────────────────────────────────────────────────────────────────────
// 汇总行 `N/M 通过`：M = 实际跑的用例数；有跳过时写 `N/M 通过（跳过 K）`。计数口径（修订批二 LOW-6）：N = 通过数，K = 跳过数，N + K + 失败数 = M；
//   跳过**不算通过也不算失败**——过滤 / 全量模式的变异自检子进程都是进程内夹具，不会有跳过，所以它们的 N/M 口径不变（runChild 遇到跳过一律按异常处理）。
async function runAll() {
  let failed = 0;
  let skipped = 0;
  for (const c of cases) {
    try {
      const r = await c.fn();
      if (r === SKIP) {
        skipped += 1;
        console.log(`  - ${c.name}\n      跳过（进程内专属）`);
      } else console.log(`  ✓ ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`  ✗ ${c.name}\n      ${e && e.message}`);
    }
  }
  console.log(`\n${cases.length - failed - skipped}/${cases.length} 通过${skipped > 0 ? `（跳过 ${skipped}）` : ''}`);
  return failed;
}

// ── 变异自检 ─────────────────────────────────────────────────────────────────────────
// 每条变异 = 对被测文件副本做若干唯一锚点替换（edits: [{ file, from, to }]）；变异后至少一条用例判红才算有判别力。
//   expect：期望被打红的用例名前缀（预筛 L4）。自检时核对「实际打红的用例集合」对每个前缀至少命中一条，没命中即自检失败——
//   防止变异被一个无关的用例误打红、而真正负责的断言其实没有判别力。
//   M-S2 加变异的写法：{ id, expect: ['用例名前缀', …], edits: [{ file, from, to }, …] }；锚点必须在副本里恰好出现一次。
//   新增变异必须登记 expect：默认（过滤模式）的自检只跑 expect 前缀命中的用例，没有 expect 直接判自检失败；前缀匹配 0 条用例也判失败。
//   expect 要列全「会被这条变异打红的负责用例」——漏列的用例在过滤模式下根本不会运行；子集基线（未变异副本跑同一子集）会拦住「缺前置状态的假红」。
const MUTATIONS = [
  { id: '只读否决被去掉（建项）', expect: ['建项：只读账号', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'return !!(!platform.isReadonly && platform.roleCanWrite);', to: 'return !!platform.roleCanWrite;' }] },
  { id: '建项不查平台角色（viewer 可建项，D1）', expect: ['建项 D1', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'return !!(!platform.isReadonly && platform.roleCanWrite);', to: 'return !platform.isReadonly;' }] },
  { id: '候选 PM 不查平台角色（viewer 可被指定为 PM，D1）', expect: ['建项 D1'], edits: [{ file: 'projects.js', from: 'if (!plat.roleCanWrite) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: '只读否决被去掉（PM 改基本信息）', expect: ['改基本信息：别的键', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm && !identity.isReadonly);', to: 'return !!identity.isPm;' }] },
  { id: '只读否决被去掉（admin 改状态）', expect: ['rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'function canChangeProjectStatus(identity) {\n  return !!(identity.isAdmin && !identity.isReadonly);', to: 'function canChangeProjectStatus(identity) {\n  return !!identity.isAdmin;' }] },
  { id: 'scope=all 不查角色', expect: ['列表：'], edits: [{ file: 'projects.js', from: "if (scope === 'all' && !rules.canListAll(platform)) throw", to: "if (false) throw" }] },
  { id: '状态查表：已终止放行 basics', expect: ['改基本信息：别的键', 'rules：项目状态 × 动作表', 'actions 与执行一致'], edits: [{ file: 'rules.js', from: 'basics: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),', to: 'basics: Object.freeze({ active: true, paused: true, terminated: true, closed: false }),' }] },
  { id: '状态查表：已结项放行 membership 以外的 maintain', expect: ['rules：项目状态 × 动作表'], edits: [{ file: 'rules.js', from: 'maintain: Object.freeze({ active: true, paused: true, terminated: false, closed: false }),', to: 'maintain: Object.freeze({ active: true, paused: true, terminated: false, closed: true }),' }] },
  { id: 'actions 忽略项目状态（与执行用了不同判定）', expect: ['actions 与执行一致'], edits: [{ file: 'rules.js', from: 'const editBasics = canEditProjectBasics(identity, project) && projectAllowsWrite(status, \'basics\');', to: 'const editBasics = canEditProjectBasics(identity, project);' }] },
  { id: 'actions 的 status_targets 不看转移表', expect: ['actions 与执行一致'], edits: [{ file: 'rules.js', from: "status_targets: changeStatus ? Array.from(STATUS_TRANSITIONS[status] || []) : [],", to: "status_targets: changeStatus ? ['active', 'paused', 'terminated'] : []," }] },
  { id: 'actions 的 takeover 不排除已是 PM', expect: ['actions 与执行一致', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'takeover: changePm && !identity.isPm && pmClash(identity) === null,', to: 'takeover: changePm && pmClash(identity) === null,' }] },
  { id: 'actions 的 takeover 不看 pmClash（M1：标志为真执行 409）', expect: ['actions 与执行一致', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'takeover: changePm && !identity.isPm && pmClash(identity) === null,', to: 'takeover: changePm && !identity.isPm,' }] },
  { id: '更换 PM 不查 pmClash（兼任 / 待接受行 / 属参与方都放行）', expect: ['更换 PM（M3', '更换 PM：新 PM 是某方'], edits: [{ file: 'projects.js', from: 'if (block) throw stateError(block.message);', to: 'if (false) throw stateError(block.message);' }] },
  { id: 'pmClash 的兼任判断被去掉', expect: ['更换 PM：新 PM 是某方', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'if (identity.ownerOfParties.length > 0 || identity.delegateOfParties.length > 0 || identity.hasPendingProposal) {', to: 'if (false) {' }] },
  { id: 'pmClash 的待接受成员行硬门被去掉（M3）', expect: ['更换 PM（M3', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'if (identity.pendingMemberRow) {', to: 'if (false) {' }] },
  { id: 'pmClash 的成员行属参与方硬门被去掉（D5）', expect: ['更换 PM（M3', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'if (identity.partyId !== null && identity.partyId !== undefined) {', to: 'if (false) {' }] },
  { id: '兼任判断漏掉待处理的任职提议', expect: ['更换 PM：新 PM 是某方', 'rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "a.member_id = m.id AND a.status = 'pending')", to: "a.member_id = m.id AND a.status = 'none')" }] },
  { id: '兼任判断漏掉待负责人确认 / 待本人接受的授权提议', expect: ['更换 PM：新 PM 是某方'], edits: [{ file: 'rules.js', from: "d.status IN ('pending_owner', 'pending_accept')", to: "d.status IN ('pending_owner')" }] },
  { id: '待处理提议查询含已移出的成员行（X16）', expect: ['rules：loadProjectIdentity', '更换 PM（M3'], edits: [{ file: 'rules.js', from: 'WHERE m.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL\n        AND (EXISTS', to: 'WHERE m.project_id = ? AND m.user_id = ?\n        AND (EXISTS' }] },
  { id: '建项不写 PM 成员行', expect: ['建项：普通用户成功'], edits: [{ file: 'projects.js', from: 'await ensurePmMemberRow(q, pid, pmId, user);', to: '' }] },
  { id: '更换 PM / 接管不写新 PM 成员行', expect: ['接管：', '更换 PM（M3'], edits: [{ file: 'projects.js', from: "await ensurePmMemberRow(q, pid, newPm, user, 'pm_change');", to: '' }] },
  { id: '更换 PM 新建成员行的事件缺 via', expect: ['接管：', '更换 PM（M3'], edits: [{ file: 'projects.js', from: "await ensurePmMemberRow(q, pid, newPm, user, 'pm_change');", to: 'await ensurePmMemberRow(q, pid, newPm, user);' }] },
  { id: 'PM 成员行查找含已移出的行（X11）', expect: ['更换 PM（M3'], edits: [{ file: 'projects.js', from: "'SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1'", to: "'SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1'" }] },
  { id: '非成员 404 被改成 403', expect: ['可见性：'], edits: [{ file: 'rules.js', from: 'if (!canViewProject(access)) throw NOT_FOUND();', to: "if (!canViewProject(access)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');" }] },
  { id: 'canViewProject 对非成员放行（可见性只有这一份，L3）', expect: ['可见性：', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'return !!(identity.project && (identity.isAdmin || identity.isMember || identity.isReadonly));', to: 'return !!identity.project;' }] },
  { id: '检查顺序：状态 409 先于权限 403', expect: ['检查顺序：'], edits: [{ file: 'rules.js', from: "  if (!canFn(access, access.project)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');\n  const writeKind = opts && opts.writeKind;\n  if (writeKind && !projectAllowsWrite(access.project.status, writeKind)) {\n    throw makeError(409, 'SYSBUILD_PROJECT_READONLY', '当前项目状态不允许该写入');\n  }", to: "  const writeKind = opts && opts.writeKind;\n  if (writeKind && !projectAllowsWrite(access.project.status, writeKind)) {\n    throw makeError(409, 'SYSBUILD_PROJECT_READONLY', '当前项目状态不允许该写入');\n  }\n  if (!canFn(access, access.project)) throw makeError(403, 'SYSBUILD_FORBIDDEN', '没有权限执行该操作');" }] },
  { id: '详情不排除待接受 / 已移出成员', expect: ['详情：'], edits: [{ file: 'projects.js', from: 'if (!visibility.memberVisible(identity, m)) continue;', to: '' }] },
  { id: '详情对普通成员也带 removed_* 字段', expect: ['详情：'], edits: [{ file: 'projects.js', from: 'if (manager) { item.removed_at = m.removed_at; item.removed_reason = m.removed_reason; }', to: 'item.removed_at = m.removed_at; item.removed_reason = m.removed_reason;' }] },
  { id: '详情的现任负责人不过滤成员行（M2）', expect: ['详情：'], edits: [{ file: 'projects.js', from: "WHERE a.status = 'active' AND p.project_id = ? AND ${rules.MEMBER_ACTIVE_SQL}`", to: "WHERE a.status = 'active' AND p.project_id = ?`" }] },
  { id: '详情的生效代表人不过滤成员行（M2）', expect: ['详情：'], edits: [{ file: 'projects.js', from: "WHERE d.status = 'active' AND p.project_id = ? AND ${rules.MEMBER_ACTIVE_SQL}`", to: "WHERE d.status = 'active' AND p.project_id = ?`" }] },
  { id: '转入 closed 放行（同时放开转移表）', expect: ['状态：四种合法'], edits: [
    { file: 'projects.js', from: "if (to === 'closed') throw stateError(", to: "if (false) throw stateError(" },
    { file: 'rules.js', from: "active: Object.freeze(['paused', 'terminated']),", to: "active: Object.freeze(['paused', 'terminated', 'closed'])," },
  ] },
  { id: '状态转移表：已终止允许直接暂停', expect: ['状态：四种合法', 'rules：项目状态 × 动作表'], edits: [{ file: 'rules.js', from: "terminated: Object.freeze(['active']),", to: "terminated: Object.freeze(['active', 'paused'])," }] },
  { id: '状态更新不记 reason（事件 payload 缺原因）', expect: ['状态：四种合法'], edits: [{ file: 'projects.js', from: 'payload: { from, to, reason }', to: 'payload: { from, to }' }] },
  { id: '改基本信息事件 payload 含未改动的列', expect: ['改基本信息：PM 成功'], edits: [{ file: 'projects.js', from: 'if (cur[f] !== next[f]) {', to: 'if (true) {' }] },
  { id: '改基本信息允许非 PM 成员', expect: ['改基本信息：PM 成功', 'rules：项目级判定函数'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm && !identity.isReadonly);', to: 'return !!((identity.isPm || identity.isMember) && !identity.isReadonly);' }] },
  { id: 'PATCH 接受 status 等非基本信息键', expect: ['改基本信息：别的键'], edits: [{ file: 'projects.js', from: 'if (!BASIC_FIELDS.includes(k)) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: '改基本信息不更新 updated_at（X3）', expect: ['改基本信息：PM 成功'], edits: [{ file: 'projects.js', from: "initiated_on = ?, updated_at = datetime('now','localtime') WHERE id = ?", to: 'initiated_on = ? WHERE id = ?' }] },
  { id: '候选 PM 不查只读账号', expect: ['建项：admin 代建', '更换 PM：新 PM 是只读账号'], edits: [{ file: 'projects.js', from: 'if (plat.isReadonly) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: '候选 PM 不查账号状态', expect: ['建项：admin 代建', '更换 PM：新 PM 是只读账号'], edits: [{ file: 'projects.js', from: "if (!u || u.status !== 'active') throw invalid(", to: "if (!u) throw invalid(" }] },
  { id: '列表 scope=mine 返回全部项目', expect: ['列表：'], edits: [{ file: 'projects.js', from: 'WHERE p.pm_user_id = ? OR EXISTS', to: 'WHERE 1 = 1 OR p.pm_user_id = ? OR EXISTS' }] },
  { id: '列表 scope=mine 去掉 PM 分支（X2）', expect: ['列表：'], edits: [{ file: 'projects.js', from: 'WHERE p.pm_user_id = ? OR EXISTS', to: 'WHERE (0 AND p.pm_user_id = ?) OR EXISTS' }] },
  { id: '列表 scope=mine 含已移出的成员（X1 / M4）', expect: ['列表：'], edits: [{ file: 'projects.js', from: 'm.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL})', to: 'm.user_id = ? AND m.joined_at IS NOT NULL)' }] },
  { id: '身份解析：已移出成员仍算负责人（X7 同族）', expect: ['rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "WHERE a.status = 'active' AND p.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL}", to: "WHERE a.status = 'active' AND p.project_id = ? AND m.user_id = ?" }] },
  { id: '身份解析：待接受的成员行名下的生效任职算负责人（X7）', expect: ['rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "WHERE a.status = 'active' AND p.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL}", to: "WHERE a.status = 'active' AND p.project_id = ? AND m.user_id = ? AND m.removed_at IS NULL" }] },
  { id: '身份解析：已移出成员仍算生效代表人（X6）', expect: ['rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "WHERE d.status = 'active' AND p.project_id = ? AND m.user_id = ? AND ${MEMBER_ACTIVE_SQL}", to: "WHERE d.status = 'active' AND p.project_id = ? AND m.user_id = ?" }] },
  { id: '身份解析：已处理的邀请也算待处理（X8）', expect: ['rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "AND i.status = 'pending' AND m.removed_at IS NULL", to: 'AND m.removed_at IS NULL' }] },
  { id: 'MEMBER_ACTIVE_SQL 漏掉「已加入」条件（共用片段）', expect: ['rules：loadProjectIdentity'], edits: [{ file: 'rules.js', from: "const MEMBER_ACTIVE_SQL = 'm.removed_at IS NULL AND m.joined_at IS NOT NULL';", to: "const MEMBER_ACTIVE_SQL = 'm.removed_at IS NULL';" }] },
  // C2b（M-S2）的变异在 sysbuild-api-suite-membership.js
  ...require('./sysbuild-api-suite-membership').MEMBERSHIP_MUTATIONS,
  // C3a 的变异在 sysbuild-api-suite-plan.js
  ...require('./sysbuild-api-suite-plan').PLAN_MUTATIONS,
  // C3b 的变异在 sysbuild-api-suite-items.js
  ...require('./sysbuild-api-suite-items').ITEM_MUTATIONS,
  // C4a 的变异在 sysbuild-api-suite-confirm.js
  ...require('./sysbuild-api-suite-confirm').CONFIRM_MUTATIONS,
  // C4b Q-S1 的变异在 sysbuild-api-suite-proxy.js
  ...require('./sysbuild-api-suite-proxy').PROXY_MUTATIONS,
  // C4b Q-S2 的变异在 sysbuild-api-suite-history.js
  ...require('./sysbuild-api-suite-history').HISTORY_MUTATIONS,
  // C4c R-S1 的变异在 sysbuild-api-suite-sheet.js
  ...require('./sysbuild-api-suite-sheet').SHEET_MUTATIONS,
  // C5 S-S1a 的变异在 sysbuild-api-suite-entries.js
  ...require('./sysbuild-api-suite-entries').ENTRY_MUTATIONS,
  // C5 S-S1b 的变异在 sysbuild-api-suite-routing.js
  ...require('./sysbuild-api-suite-routing').ROUTING_MUTATIONS,
  // C5 S-S1c 的变异在 sysbuild-api-suite-changes.js
  ...require('./sysbuild-api-suite-changes').CHANGE_MUTATIONS,
  // C5 S-S1c 的变异（开发方关键事项与预筛第 3 轮）在 sysbuild-api-suite-devkey.js
  ...require('./sysbuild-api-suite-devkey').DEVKEY_MUTATIONS,
  // C6a 的变异在 sysbuild-api-suite-golive.js
  ...require('./sysbuild-api-suite-golive').GOLIVE_MUTATIONS,
  // C6b 的变异在 sysbuild-api-suite-notify.js（id 前缀 C6b ）
  ...require('./sysbuild-api-suite-notify').NOTIFY_MUTATIONS,
  ...require('./sysbuild-api-suite-frontend').FRONTEND_MUTATIONS,
  ...require('./sysbuild-api-suite-stage8').STAGE8_MUTATIONS,
];

// 变异 id 全局唯一（codex 20 号 M-1）：阶段补检改按 id 名单选择（--mutation-ids），id 必须能唯一定位一条变异。加载时校验，有重复就列出重复的 id 并让进程以退出码 1 结束
//   （抛错：被 require 的位置未捕获，Node 以退出码 1 结束；子进程 --inproc 同样加载本文件，所以重复 id 在任何入口都会被拦下）。
function findDuplicateMutationIds(list) {
  const seen = new Map();
  for (const m of list) seen.set(m.id, (seen.get(m.id) || 0) + 1);
  return Array.from(seen.entries()).filter(([, n]) => n > 1).map(([id, n]) => `${id}（${n} 次）`);
}
{
  const dups = findDuplicateMutationIds(MUTATIONS);
  if (dups.length > 0) {
    process.exitCode = 1;
    throw new Error(`MUTATIONS 里有重复的变异 id（--mutation-ids 要求 id 全局唯一）：\n  ${dups.join('\n  ')}`);
  }
}

function runChild(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    const timer = setTimeout(() => { child.kill(); }, 420000);
    child.on('error', (e) => { clearTimeout(timer); resolve({ kind: 'abnormal', detail: e.message }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const m = /^(\d+)\/(\d+) 通过(?:（跳过 (\d+)）)?\s*$/m.exec(out);
      if (signal || m === null) return resolve({ kind: 'abnormal', detail: signal || (errOut.split('\n').filter(Boolean).slice(-3).join(' | ') || out.split('\n').filter(Boolean).slice(-2).join(' | ') || '无汇总行') });
      const passedN = Number(m[1]);
      const totalN = Number(m[2]);
      // 子进程都是进程内夹具，不应出现跳过；出现跳过说明有用例没真的跑，变异结果不可信（跳过不算通过也不算失败，但自检不接受）。
      if (m[3] !== undefined) return resolve({ kind: 'abnormal', detail: `子进程出现 ${m[3]} 条跳过（自检要求全部用例都真的运行）` });
      // 被打红的用例名（子进程输出里以「  ✗ 」开头的行），供变异的 expect 核对。
      const failedNames = out.split('\n').filter((l) => l.startsWith('  ✗ ')).map((l) => l.slice(4).trim());
      // 通过的用例名（未变异的全量基线用它得到完整用例名单，供过滤模式按 expect 前缀圈定子集）。
      const passedNames = out.split('\n').filter((l) => l.startsWith('  ✓ ')).map((l) => l.slice(4).trim());
      if (code === 1 && passedN < totalN) return resolve({ kind: 'red', detail: `${passedN}/${totalN}`, failedNames, passedNames, total: totalN });
      if (code === 0 && passedN === totalN) return resolve({ kind: 'green', detail: `${passedN}/${totalN}`, failedNames, passedNames, total: totalN });
      return resolve({ kind: 'abnormal', detail: `退出码 ${code} 与汇总 ${passedN}/${totalN} 不一致` });
    });
  });
}
function copyModuleDir(dstDir, transform) {
  const requires = {
    "require('sqlite3')": `require(${JSON.stringify(require.resolve('sqlite3'))})`,
    "require('express')": `require(${JSON.stringify(require.resolve('express'))})`,
    "require('multer')": `require(${JSON.stringify(require.resolve('multer'))})`, // items.js 取 attachments.js 的 attachmentDisplayName（C3b 预筛 LOW-5），副本里要有 attachments.js
  };
  for (const f of ['db.js', 'schema.js', 'rules.js', 'events.js', 'membership.js', 'membership-visibility.js', 'projects.js', 'templates.js', 'plan.js', 'items.js', 'packages.js', 'materials.js', 'materials-core.js', 'confirm-core.js', 'confirm.js', 'history.js', 'confirmation-sheet.js', 'entries-core.js', 'entries-routing.js', 'entries.js', 'changes.js', 'golive-core.js', 'golive.js', 'notify-core.js', 'notify-schedule.js', 'notify.js', 'attachments.js']) { // C8：材料与同源身份可见助手同样进入每个变异副本。
    let src = fs.readFileSync(path.join(DEFAULT_DIR, f), 'utf8').replace(/\r\n/g, '\n');
    for (const [from, to] of Object.entries(requires)) src = src.split(from).join(to);
    if (transform) src = transform(f, src);
    fs.writeFileSync(path.join(dstDir, f), src);
  }
}
// --mutations 的列表：`0,5,400-407`（MUTATIONS 下标，含端点）；返回升序去重的下标数组，格式或范围不对抛错。
function parseMutationPicks(spec, total) {
  if (typeof spec !== 'string' || spec === '' || spec.startsWith('--')) throw new Error('--mutations 缺少列表（形如 0,5,400-407）');
  const set = new Set();
  for (const part of spec.split(',')) {
    const t = part.trim();
    let m = /^(\d+)$/.exec(t);
    let lo;
    let hi;
    if (m) { lo = Number(m[1]); hi = lo; } else {
      m = /^(\d+)-(\d+)$/.exec(t);
      if (!m) throw new Error(`--mutations 里的「${t}」不是下标或下标范围（形如 0,5,400-407）`);
      lo = Number(m[1]); hi = Number(m[2]);
      if (lo > hi) throw new Error(`--mutations 里的范围「${t}」起点大于终点`);
    }
    if (hi >= total) throw new Error(`--mutations 里的「${t}」超出 MUTATIONS 范围（0–${total - 1}）`);
    for (let i = lo; i <= hi; i += 1) set.add(i);
  }
  return Array.from(set).sort((a, b) => a - b);
}
// --mutation-ids 的名单（codex 20 号 M-1）：JSON 文件，内容是变异 id 字符串数组。名单本身不能为空、不能有重复项；每个 id 必须在 MUTATIONS 里存在且恰好出现一次
//   （MUTATIONS 加载时已保证 id 全局唯一，这里仍按出现次数核对，不存在或不唯一都报参数错）。返回升序下标数组。
function parseMutationIdPicks(file, list) {
  if (typeof file !== 'string' || file === '' || file.startsWith('--')) throw new Error('--mutation-ids 缺少 JSON 文件路径（内容是变异 id 字符串数组）');
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (e) {
    throw new Error(`--mutation-ids 的文件读不了或不是合法 JSON: ${file}（${e.message}）`);
  }
  if (!Array.isArray(arr) || arr.length === 0 || !arr.every((x) => typeof x === 'string' && x.trim() !== '')) {
    throw new Error('--mutation-ids 的文件内容必须是非空的变异 id 字符串数组（每项为非空字符串）');
  }
  const dupInFile = arr.filter((x, i) => arr.indexOf(x) !== i);
  if (dupInFile.length > 0) throw new Error(`--mutation-ids 的名单里有重复的 id: ${Array.from(new Set(dupInFile)).join(' / ')}`);
  const idxOf = new Map();
  list.forEach((m, i) => { if (!idxOf.has(m.id)) idxOf.set(m.id, []); idxOf.get(m.id).push(i); });
  const missing = arr.filter((id) => !idxOf.has(id));
  if (missing.length > 0) throw new Error(`--mutation-ids 里的 id 在 MUTATIONS 中不存在: ${missing.join(' / ')}`);
  const notUnique = arr.filter((id) => idxOf.get(id).length !== 1);
  if (notUnique.length > 0) throw new Error(`--mutation-ids 里的 id 在 MUTATIONS 中不是恰好出现一次: ${notUnique.join(' / ')}`);
  return arr.map((id) => idxOf.get(id)[0]).sort((a, b) => a - b);
}
// 自检路径的参数白名单（P-S0 LOW-2）：只收 `--self-test`、`--full`、`--mutations <值>`、`--mutation-ids <JSON 文件>`，各至多一次；其余一律报错（含 `--mutations=342`、`--mutation`、位置参数）。
//   `--mutations` / `--mutation-ids` 后面紧跟的那个词当作它的值（值缺失或以 `--` 开头报错）。两者互斥（codex 20 号 M-1）：同时给报参数错。
function parseSelfTestArgs(argv, list) {
  const total = list.length;
  let full = false;
  let selfTest = false;
  let picks = null;
  let seenMutations = false;
  let seenIds = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') {
      if (selfTest) throw new Error('--self-test 重复出现');
      selfTest = true;
    } else if (a === '--full') {
      if (full) throw new Error('--full 重复出现');
      full = true;
    } else if (a === '--mutations') {
      if (seenMutations) throw new Error('--mutations 重复出现');
      if (seenIds) throw new Error('--mutations 与 --mutation-ids 互斥，不能同时给');
      seenMutations = true;
      i += 1;
      picks = parseMutationPicks(argv[i], total);
    } else if (a === '--mutation-ids') {
      if (seenIds) throw new Error('--mutation-ids 重复出现');
      if (seenMutations) throw new Error('--mutations 与 --mutation-ids 互斥，不能同时给');
      seenIds = true;
      i += 1;
      picks = parseMutationIdPicks(argv[i], list);
    } else {
      throw new Error(`不支持的参数「${a}」（自检只收 --self-test、--full、--mutations <值>、--mutation-ids <JSON 文件>；列表形如 0,5,400-407，不能写成 --mutations=…）`);
    }
  }
  return { full, picks };
}
// 主跑路径的参数检查（修订批二 LOW-8：主跑不收任何参数）：出现任何参数都是用错了命令，报错而不是静默忽略——
//   含自检专用的 --full / --mutations，也含 `--self-test=1` 这类拼写变体（verify-sysbuild-api.js 只认精确的 `--self-test` 才走自检，变体会落到主跑，这里拦下）。
function checkMainArgs(argv) {
  if (argv.length > 0) {
    const a = argv[0];
    throw new Error(`主跑不收任何参数（收到「${a}」）${a === '--full' || a.startsWith('--mutation') || a.startsWith('--self-test') ? '；--self-test / --full / --mutations / --mutation-ids 只属于自检，写法形如 --self-test --full --mutation-ids <JSON 文件>' : ''}`);
  }
}
async function selfTest(argv) {
  const startedAt = Date.now();
  let opts;
  try {
    opts = parseSelfTestArgs(argv, MUTATIONS);
  } catch (e) {
    console.log(`  ✗ 参数错误：${e.message}`);
    return 1;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-api-mut-'));
  try {
    return await selfTestIn(root, opts);
  } finally {
    try { removeTree(root); } catch (e) { console.log(`  [清理] 变异临时目录未删除: ${root} — ${e.message}`); }
    console.log(`自检耗时：${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  }
}
async function selfTestIn(root, opts) {
  const filterMode = !opts.full;
  const baseDir = path.join(root, 'base');
  fs.mkdirSync(baseDir);
  copyModuleDir(baseDir, null);
  const base = await runChild(['--inproc', '--module-dir', baseDir, '--no-keep']);
  if (base.kind !== 'green') {
    console.log(`  ✗ 未变异基线（副本，进程内）不是全绿（${base.kind}：${base.detail}${Array.isArray(base.failedNames) && base.failedNames.length > 0 ? `；红的用例：${base.failedNames.map((n) => n.slice(0, 60)).join(' | ')}` : ''}），变异自检无意义，终止`); // C6a：带出红的用例名，便于定位
    return 1;
  }
  console.log(`  ✓ 未变异基线（进程内）${base.detail} 全绿`);
  const allNames = base.passedNames; // 全量基线全绿，通过名单 = 完整用例名单（原顺序）
  const brokenDir = path.join(root, 'broken');
  fs.mkdirSync(brokenDir);
  copyModuleDir(brokenDir, (f, src) => (f === 'projects.js' ? `${src}\n这一行不是合法的 JavaScript(\n` : src));
  const broken = await runChild(['--inproc', '--module-dir', brokenDir, '--no-keep']);
  if (broken.kind !== 'abnormal') {
    console.log(`  ✗ 分类器自检：语法错误的模块被判为 ${broken.kind}（应为异常），变异结果不可信，终止`);
    return 1;
  }
  console.log(`  ✓ 分类器自检：语法错误的模块判为异常（${broken.detail}）`);
  if (allNames.length !== base.total) {
    console.log(`  ✗ 基线输出里解析出 ${allNames.length} 个用例名，与汇总 ${base.total} 不符，无法按 expect 圈定子集，终止`);
    return 1;
  }
  const pickIdx = opts.picks || MUTATIONS.map((_, i) => i);
  const prepared = [];
  let weak = 0;
  pickIdx.forEach((i) => {
    const mu = MUTATIONS[i];
    const dir = path.join(root, `m${i}`);
    fs.mkdirSync(dir);
    let bad = null;
    copyModuleDir(dir, (f, src) => {
      let out = src;
      for (const e of mu.edits.filter((x) => x.file === f)) {
        const count = out.split(e.from).length - 1;
        if (count !== 1) { bad = `变异锚点出现 ${count} 次（应恰好 1 次）: ${f} ${JSON.stringify(e.from.slice(0, 60))}`; return src; }
        out = out.replace(e.from, () => e.to);
      }
      return out;
    });
    if (bad) { console.log(`  ✗ #${i} [${mu.id}] ${bad}`); weak += 1; } else prepared.push({ mu, dir, idx: i });
  });
  // 子进程实际跑的用例名集合（通过 ∪ 失败，排序）必须与名单逐项全等，不只比条数（P-S0 LOW-3）。
  const ranNames = (res) => (res.passedNames || []).concat(res.failedNames || []).slice().sort();
  const sameNameSet = (res, names) => JSON.stringify(ranNames(res)) === JSON.stringify(names.slice().sort());

  // 过滤模式：先按 expect 圈定每条变异的子集（用例名集合），同一集合只做一次子集基线。
  const tasks = []; // { kind: 'sub' | 'mut' | 'ctl', ... , res }
  const groups = new Map(); // 排序后的名单 JSON → { prefixes, names, task }
  let onlySeq = 0;
  const writeOnly = (prefixes) => {
    onlySeq += 1;
    const file = path.join(root, `only-${onlySeq}.json`);
    fs.writeFileSync(file, JSON.stringify(prefixes));
    return file;
  };
  // expect 统一校验（codex 20 号 L-1，过滤与 --full 两种模式共用）：数组非空；每项是字符串且去首尾空白后非空；每项至少匹配一条基线用例（按原串 startsWith，
  //   与子进程 --only-file 的匹配一致）。不过的变异不起子进程、不计为检出（走下面的 p.skip → weak）。全量模式原先只在判定时看「非空数组」，
  //   `expect: ['']` 会让任何用例判红都满足核对（任何用例名都以空串开头），这里在准备阶段拦下。
  for (const p of prepared) {
    const expect = p.mu.expect;
    if (!Array.isArray(expect) || expect.length === 0) { p.skip = '没有登记 expect（不起子进程）'; continue; }
    const notText = expect.filter((pre) => typeof pre !== 'string' || pre.trim() === '');
    if (notText.length > 0) { p.skip = `expect 含空或非字符串的项（${JSON.stringify(notText)}）；每项须是去首尾空白后非空的字符串（不起子进程）`; continue; }
    const unmatched = expect.filter((pre) => !allNames.some((n) => n.startsWith(pre)));
    if (unmatched.length > 0) p.skip = `expect 前缀没有命中任何用例: ${unmatched.join(' / ')}（不起子进程）`;
  }
  if (filterMode) {
    for (const p of prepared) {
      if (p.skip) continue;
      const expect = p.mu.expect;
      p.names = allNames.filter((n) => expect.some((pre) => n.startsWith(pre)));
      const key = JSON.stringify(p.names.slice().sort());
      p.onlyFile = writeOnly(expect);
      if (!groups.has(key)) {
        const g = { prefixes: expect, names: p.names, kind: 'sub', onlyFile: writeOnly(expect) };
        groups.set(key, g);
        tasks.push(g);
      }
      p.group = groups.get(key); // 判定时先核所属组的子集基线（MED-1）
      tasks.push(p);
      p.kind = 'mut';
    }
  } else {
    for (const p of prepared) { if (p.skip) continue; p.kind = 'mut'; tasks.push(p); }
  }
  // 空跑对照：无语义改动的变异，过滤模式下必须被判「未判红」（证明过滤子进程真的在跑、并能报绿）。
  let ctl = null;
  if (filterMode) {
    const donor = prepared.find((p) => p.names);
    const ctlPrefixes = donor ? donor.mu.expect : [allNames[0]];
    const ctlNames = allNames.filter((n) => ctlPrefixes.some((pre) => n.startsWith(pre)));
    const ctlDir = path.join(root, 'ctl');
    fs.mkdirSync(ctlDir);
    copyModuleDir(ctlDir, (f, src) => (f === 'rules.js' ? `${src}\n// 空跑对照：无语义改动\n` : src));
    ctl = { kind: 'ctl', dir: ctlDir, names: ctlNames, onlyFile: writeOnly(ctlPrefixes) };
    tasks.push(ctl);
  }

  let next = 0;
  const worker = async () => {
    for (;;) {
      const idx = next; next += 1;
      if (idx >= tasks.length) return;
      const t = tasks[idx];
      const args = ['--inproc', '--module-dir', t.kind === 'sub' ? baseDir : t.dir, '--no-keep'];
      if (filterMode && t.onlyFile) args.push('--only-file', t.onlyFile);
      t.res = await runChild(args);
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  let extraFail = 0;
  let ctlBad = false;
  // 子集基线：未变异副本跑同一子集必须全绿，且实际跑的用例名集合与名单逐项全等；否则「缺前置状态造成的假红」会被算作检出。
  //   每个组的结果记在 g.baselineOk，下面逐条判定时先核所属组（MED-1）：组基线不绿 → 名下变异标「判红，但子集基线不绿，不计为检出」并计入 weak。
  if (filterMode) {
    let subBad = 0;
    for (const g of groups.values()) {
      const r = g.res;
      g.baselineOk = r.kind === 'green' && sameNameSet(r, g.names);
      if (g.baselineOk) continue;
      subBad += 1;
      const why = r.kind !== 'green' ? `${r.kind}：${r.detail}` : `实际跑的用例集合与名单不等（实际 ${r.total} 条，应为 ${g.names.length} 条）`;
      console.log(`  ✗ 子集基线不是全绿（${why}）；前缀 ${g.prefixes.join(' / ')}；用例集合 ${g.names.length} 条: ${g.names.join(' | ')}${r.failedNames && r.failedNames.length ? `\n      失败用例: ${r.failedNames.join(' | ')}` : ''}`);
    }
    if (subBad > 0) extraFail += subBad;
    else console.log(`  ✓ 子集基线：${groups.size} 个不同的用例集合（来自 ${prepared.filter((p) => p.names).length} 条变异），未变异副本上全绿且用例集合与名单全等`);
    const cr = ctl.res;
    if (cr.kind === 'green' && sameNameSet(cr, ctl.names) && ctl.names.length > 0) {
      console.log(`  ✓ 空跑对照：无语义改动的变异被判「未判红」（${cr.detail}，子集 ${ctl.names.length} 条）`);
    } else {
      ctlBad = true;
      extraFail += 1;
      console.log(`  ✗ 空跑对照：应为「未判红」（全绿且用例集合与名单全等，${ctl.names.length} 条），实际 ${cr.kind}：${cr.detail}${cr.failedNames && cr.failedNames.length ? `（打红: ${cr.failedNames.join(' | ')}）` : ''}`);
    }
  }

  prepared.forEach((p) => {
    const tag = `#${p.idx} [${p.mu.id}]`;
    if (p.skip) {
      console.log(`  ✗ ${tag} ${p.skip}`);
      weak += 1;
      return;
    }
    const res = p.res;
    // 过滤模式：所属组的子集基线不绿，这条变异的「判红」不可信（可能是缺前置状态的假红），不计为检出。
    if (filterMode && p.group && p.group.baselineOk !== true) {
      console.log(`  ✗ ${tag} ${res.kind === 'red' ? '判红' : res.kind}，但子集基线不绿，不计为检出`);
      weak += 1;
      return;
    }
    // expect 核对：每个期望前缀都必须有被打红的用例以它开头；没登记 expect 的变异本身就是自检失败（L4）。
    const expect = Array.isArray(p.mu.expect) ? p.mu.expect : null;
    const missed = res.kind === 'red' && expect ? expect.filter((pre) => !res.failedNames.some((n) => n.startsWith(pre))) : [];
    let label;
    let ok = false;
    if (res.kind !== 'red') label = res.kind === 'green' ? '未判红（断言无判别力）' : `异常（${res.detail}），不计为检出`;
    else if (!expect || expect.length === 0) label = `判红（${res.detail}），但没有登记 expect`;
    else if (filterMode && !sameNameSet(res, p.names)) label = `判红（${res.detail}），但子进程实际跑的用例集合与名单不等（实际 ${res.total} 条，应为 ${p.names.length} 条；过滤未生效）`;
    else if (missed.length > 0) label = `判红（${res.detail}），但期望的用例没被打红: ${missed.join(' / ')}（实际打红: ${res.failedNames.map((n) => n.slice(0, 14)).join(' / ')}）`;
    else { ok = true; label = `判红（${res.detail}），命中期望 ${expect.length} 项`; }
    console.log(`  ${ok ? '✓' : '✗'} ${tag} ${label}`);
    if (!ok) weak += 1;
  });
  const modeLabel = filterMode ? '过滤模式' : '--full 全量模式';
  if (ctlBad) console.log('\n变异自检：判定无效（空跑对照未通过）'); // 对照不过 = 过滤子进程没有真的在跑 / 报绿，逐条结果都不可信，不输出得分
  else console.log(`\n变异自检：${pickIdx.length - weak}/${pickIdx.length} 判红（挑选 ${pickIdx.length} / 共 ${MUTATIONS.length}；${modeLabel}）`);
  if (extraFail > 0) console.log(`  ✗ 自检判失败：子集基线 / 空跑对照 ${extraFail} 项不通过（见上）`);
  return weak + extraFail;
}

// 跑一遍用例；返回失败条数（夹具 / 加载失败返回 3，不打印汇总行，上层按「异常」处理）。
async function runWith(makeHarness) {
  let failed = 1;
  try {
    MODS = { rules: require(path.join(MODULE_DIR, 'rules.js')), sheet: require(path.join(MODULE_DIR, 'confirmation-sheet.js')), entries: require(path.join(MODULE_DIR, 'entries-core.js')), confirmCore: require(path.join(MODULE_DIR, 'confirm-core.js')) }; // C4c：确认单用例直接测转义助手与映射函数；C5：登记用例直接测派生状态纯函数
    defineCases();
    if (ONLY) {
      // --only-file：只保留名字以任一前缀开头的用例（原顺序）；任一前缀匹配 0 条 → 不跑，按「夹具 / 加载失败」返回 3。
      const unmatched = ONLY.filter((pre) => !cases.some((c) => c.name.startsWith(pre)));
      if (unmatched.length > 0) {
        console.log(`夹具 / 加载失败（不计为用例失败）: --only-file 的前缀没有命中任何用例: ${unmatched.join(' / ')}`);
        return 3;
      }
      const kept = cases.filter((c) => ONLY.some((pre) => c.name.startsWith(pre)));
      cases.length = 0;
      kept.forEach((c) => cases.push(c));
    }
    H = await makeHarness();
    W = H.world;
    assignUsers();
    console.log(`夹具：${H.mode}`);
    failed = await runAll();
  } catch (e) {
    console.log(`夹具 / 加载失败（不计为用例失败）: ${e && e.stack}`);
    failed = 3;
  } finally {
    if (H) { try { await H.teardown(failed !== 0); } catch (e) { console.log(`夹具收尾失败: ${e.message}`); } }
  }
  return failed;
}
// 主跑：调用方已 await fx.ready()；实例本身由调用方 await fx.teardown() 收掉。
//   argv：同上；主跑不收 --full / --mutations（P-S0 LOW-2），出现即报参数错误、返回 1。
async function runInstanceSuite(fx, argv) {
  try {
    checkMainArgs(Array.isArray(argv) ? argv : []);
  } catch (e) {
    console.log(`  ✗ 参数错误：${e.message}`);
    return 1;
  }
  parseArgs([]);
  return runWith(() => makeInstanceHarness(fx));
}
// argv：verify-sysbuild-api.js 的命令行参数（process.argv.slice(2)），取其中的 --full / --mutations。
async function runSelfTest(argv) {
  parseArgs([]);
  return selfTest(Array.isArray(argv) ? argv : []);
}

module.exports = { runInstanceSuite, runSelfTest };

// 命令行入口：只给变异自检的子进程用（--inproc）。
if (require.main === module) {
  (async () => {
    try {
      parseArgs(process.argv.slice(2));
    } catch (e) {
      console.log(`夹具 / 加载失败（不计为用例失败）: ${e.message}`);
      process.exitCode = 3;
      return;
    }
    if (!INPROC) {
      console.log('本文件只支持 --inproc；主跑与自检请用 scripts/verify-sysbuild-api.js');
      process.exitCode = 2;
      return;
    }
    const failed = await runWith(() => makeInprocHarness());
    process.exitCode = failed === 0 ? 0 : 1;
  })();
}
