/**
 * A3 verify e2e · 历史台账归档模块 只读 API 四枚 + 权限矩阵 + 403 拦截
 * 方案 docs/local/历史台账归档/历史台账归档_方案_20260820_v1.0.md §5/§6/§7
 * 编码范式备忘 docs/local/历史台账归档/A2-A4_编码范式备忘_20260820.md
 *
 * harness 范式对齐 scripts/verify-quick-log.js（B 套 e2e）：spawn 真实 server.js（TEST_PORT=3459）
 * + 真库 task_pool.db（非临时库副本——与 verify-legacy-archive-schema.js PART 2 用临时文件库不同，
 * 本脚本按任务指令走"真库 + 彻底清理"范式，前置用 import-legacy-archive.js 往真实 dev 库导一个批次
 * + --activate，全部测试跑完在 finally 里逐表 DELETE + 删 uploads/legacy-archive/<batch_id>/ 目录）。
 *
 * 覆盖：
 *   组0：静态断言——5 条路由注册行 + 中间件顺序（authenticateToken→requireAdmin→
 *        requireLegacyArchiveSchemaReady）
 *   组1：未鉴权 401 ×5 + 非 admin 403 ×5（五端点逐个，2026-08-22 增 source-file）
 *   组2：/uploads/legacy-archive 直连 403 DIRECT_ACCESS_FORBIDDEN
 *   组3：admin 正环——datasets 清单（8 数据集+行数+批次横幅）/ rows 分页（total=8232+默认分页）/
 *        排序 sort&dir（asc/desc 双向库内核对+稳定二级序+非法 400+默认序回归，2026-08-22 增）/
 *        q 筛选命中与未命中 / pageSize 钳制（>200→200，非法→50）/ 行详情（detail 字段+images）/
 *        图片端点（200+Content-Type image/*+Content-Disposition inline）/
 *        源文件端点（200+attachment+Content-Length=磁盘 size+X-Source-SHA256=库内值，2026-08-22 增）
 *   组4：未知 dataset 404 / 非法 id 400（含 id=0）/ 越界页空 rows+真实 total / batchId 非数字 400 /
 *        batchId 非 active 404 / file 白名单外(../ via %2f) 400 / file 合法但未被引用 404 /
 *        file 合法(..)经 DB 篡改后越界 403 ILLEGAL_FILE_PATH / 源文件缺失 404 fail-closed
 *   组5：批次 retire 后 datasets 返回空+notice（no-active 语义）+ 该批次 rows/source-file 端点随之 404
 *   组6（finally）：彻底清理——按 batch_id 逐表 DELETE（rows→datasets→batches）+ 删物理目录，
 *        清理断言到磁盘（目录不存在 + 三表行数归零）
 *
 * 用法：node scripts/verify-legacy-archive-api.js
 */
'use strict';
const { spawn, execFileSync } = require('child_process');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3459;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const ADMIN_ID = fx.ADMIN_ID;      // 1，admin
const NONADMIN_ID = fx.CONTACT_ID; // 3，role=user（非 admin）

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}

async function api(method, urlPath, token) {
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${urlPath}`, opts);
  let j = null;
  try { j = await r.json(); } catch (_) { /* 图片端点非 json */ }
  return { status: r.status, body: j, raw: r };
}

// WHATWG URL 解析器会在客户端把恰好等于 ".."（含 "%2e%2e"/".%2e"/"%2e." 等等价编码形式，规范
// 明文规定的四种"double-dot path segment"写法）的路径段就地折叠掉（连同它前面那一段一起丢弃）——
// 这是浏览器/fetch 内建的路径遍历防护，发生在请求真正发出之前。用 fetch 测"服务端子树越界护栏"
// 这类场景会被这层客户端归一化拦在半路，永远走不到服务端。改用 Node 原生 http.request 直发原始
// path 字符串（不经 URL 归一化），才能验证服务端自己的越界拦截是否真的生效。
function rawGet(rawPath, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port: TEST_PORT, path: rawPath, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body = null;
          try { body = JSON.parse(raw); } catch (_) { /* 非 json */ }
          resolve({ status: res.statusCode, body, raw });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// netstat 精确端口比较（findstr 子串匹配会误命中，对齐 verify-issue-lite-c2/verify-quick-log 范式）
function killPort(port) {
  try {
    const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
    const pids = new Set();
    out.split(/\r?\n/).forEach(line => {
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
        const m = cols[1].match(/:(\d+)$/);
        if (m && Number(m[1]) === port) pids.add(cols[4]);
      }
    });
    pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ } });
  } catch (_) { /* ignore */ }
}

function safeParse(text, fallback) {
  try { return JSON.parse(text); } catch (_) { return fallback; }
}

function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE);
    db.all(sql, params || [], (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
  });
}
function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE);
    db.get(sql, params || [], (err, row) => { db.close(); err ? reject(err) : resolve(row); });
  });
}
function dbRun(sql, params) {
  return new Promise((resolve) => {
    const db = new sqlite3.Database(DB_FILE);
    db.run(sql, params || [], function (err) { db.close(); resolve({ err, changes: this && this.changes }); });
  });
}

async function waitReady(getLog, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // 探测锚用"接口放行"稳定后缀（对齐 verify-quick-log.js 教训：别钉在会演进的展示性文案上）。
    if (/\[历史台账归档\] ✅ .*legacy-archive 接口放行/.test(getLog())) {
      try { const r = await fetch(`${BASE}/api/legacy-archive/datasets`); if (r.status === 401) return true; } catch (_) { /* ignore */ }
    }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

function execFileSyncSafe(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
    return { ok: true, out };
  } catch (e) {
    // 对齐 A2 L5 修复精神：execFileSync 失败时把子进程 stdout/stderr 一并打出来，不只留 e.message。
    const stdout = e && e.stdout ? String(e.stdout) : '';
    const stderr = e && e.stderr ? String(e.stderr) : '';
    return { ok: false, out: stdout + '\n' + stderr, message: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// 前置：往真实 dev 库导一个批次 + --activate（真库 + 彻底清理范式）
// ---------------------------------------------------------------------------
async function importAndActivateBatch() {
  // M4（codex 08 复审·本轮当场修）：兜底改用"导入前 MAX(id) 快照（preMax，无行则 0）+ 导入后查
  // id>preMax"——不再用裸 `ORDER BY id DESC LIMIT 1`（隐含"导入期间无并发写入"假设：若另一个进程/
  // 会话恰好也在此时写入了 legacy_archive_batches，裸 MAX(id) 可能拿到的是别人的批次，本脚本
  // finally 会把别人的批次错误地清理掉）。preMax 是导入开始前的基线，导入后只认"比这个基线更新"
  // 的行——把"识别本次新增批次"从"猜最大值是谁的"改成"排除掉导入前已存在的所有行"，对并发更稳健
  // （仍无法 100% 排除"导入期间又有第三方恰好也插入"这种病态交错——那种情况下会有 >1 条新增行，
  // 下面显式判定为无法确认归属而报错，不猜）。
  const preMaxRow = await dbGet(`SELECT MAX(id) AS m FROM legacy_archive_batches`);
  const preMax = (preMaxRow && preMaxRow.m) || 0;

  const importResult = execFileSyncSafe('node', ['scripts/import-legacy-archive.js']);
  if (!importResult.ok) {
    throw new Error(`前置导入失败（import-legacy-archive.js）：${importResult.message}\n${importResult.out}`);
  }
  let batchId = null;
  const m = /batch #(\d+) 导入完成并置 verified/.exec(importResult.out);
  if (m) {
    batchId = Number(m[1]);
  } else {
    // M4：正则解析失败不等于导入失败——execFileSyncSafe.ok===true 已经证明子进程 exit code 0
    // （import-legacy-archive.js 自己的成功判定已通过），只是本脚本的 stdout 文案匹配没对上（未来
    // 措辞变化的常见踩坑）。若直接 throw，批次已经建好+写入真实 dev 库，但本脚本从未拿到它的 id，
    // finally 永远清不到它——比"正则没匹配上"本身更严重（真库永久残留）。
    const newRows = await dbAll(`SELECT id FROM legacy_archive_batches WHERE id > ? ORDER BY id ASC`, [preMax]);
    if (!newRows || newRows.length === 0) {
      throw new Error(`前置导入未能从输出中解析出 batch id，且兜底查询（id > ${preMax}）也未找到任何新增批次：\n${importResult.out}`);
    }
    if (newRows.length > 1) {
      // 出现多条新增批次——说明导入期间确有并发写入（本机单 admin 场景理论罕见但不排除），无法
      // 单从 id 序确认"哪条是这次导入自己的"，这种歧义值得人工核实，不靠猜测继续往下跑。
      throw new Error(
        `前置导入未能从输出中解析出 batch id，兜底查询（id > ${preMax}）发现 ${newRows.length} 条新增批次` +
        `（疑似导入期间有并发写入，无法确认归属，需人工核实）：${JSON.stringify(newRows)}\n${importResult.out}`
      );
    }
    batchId = newRows[0].id;
    console.log(`⚠️ [M4兜底] 前置导入输出文案未匹配到预期正则，改用 id>preMax(${preMax}) 兜底拿到 batch #${batchId}`);
  }

  const activateResult = execFileSyncSafe('node', ['scripts/import-legacy-archive.js', '--activate', String(batchId)]);
  if (!activateResult.ok) {
    throw new Error(`前置激活失败（--activate ${batchId}）：${activateResult.message}\n${activateResult.out}`);
  }
  if (!/已激活（active）/.test(activateResult.out)) {
    // M4：同款兜底——不纯信 stdout 文案，直接查 db 里该 batch 的真实 status 判定是否真的激活成功。
    const statusRow = await dbGet(`SELECT status FROM legacy_archive_batches WHERE id = ?`, [batchId]);
    if (!statusRow || statusRow.status !== 'active') {
      throw new Error(`前置激活未见成功文案，且 db 查证 batch #${batchId} 状态非 active（实得 ${statusRow ? statusRow.status : '(不存在)'}）：\n${activateResult.out}`);
    }
    console.log(`⚠️ [M4兜底] 前置激活输出文案未匹配到预期正则，但 db 查证 batch #${batchId} 状态确为 active，视为成功`);
  }
  return batchId;
}

// 本机实测踩坑（本次新发现，2026-08-20）：`fs.rmSync(dir, {recursive:true, force:true})` 在本环境
// （Windows + Node v24.11.1）对含 467 个文件的目录**静默 no-op**——不抛异常、不报错、目录与全部文件
// 原样保留，重复调用 8 次 + 每次间隔 500ms 仍无变化（已用最小复现脚本反复验证：同一批文件对
// `fs.unlinkSync` 单文件删除完全正常，只有 rmSync 的 recursive 批量路径失效）。这比
// scripts/verify-legacy-archive-schema.js removeWithRetry 注释记录的"同进程 stat 可见性滞后"更
// severe——那个踩坑是"删除已生效只是复核看不到"，这个是"删除调用本身就没有真正执行"。
// 根治：不依赖 rmSync 的 recursive 内部实现，手写递归——逐文件 unlinkSync + 目录清空后 rmdirSync，
// 外层仍包一层短退避重试兜住单文件级别的真实瞬时锁（AV 扫描新落盘文件等场景）。
// M5（外部 codex 07 审·本轮当场修，三处同步之一，另两处 import-legacy-archive.js
// removeDirManualSync / verify-legacy-archive-schema.js removeManualSync）：lstatSync 判定类型——
// 命中符号链接/Windows 目录联接（junction，Node 的 lstat 对两者统一走 isSymbolicLink() 分支）时
// 只删链接节点本身，不递归进目标（防被链接指向的路径拖进来误删——本文件下方 H2 负向自证专门会
// 在 batchDir 里放一个 junction，finally 清理阶段也得扛得住这种目录内容）；先 unlinkSync，遇
// EPERM/EISDIR（目录型链接部分场景）退到 rmdirSync。普通文件遇 EPERM（Windows 只读属性）先
// chmodSync 0o666 去只读位再重删一次。目录深度说明：本函数目标是 uploads/legacy-archive/
// <batch_id>/<图片文件>，该层级下只放扁平图片文件（import-legacy-archive.js 落盘逻辑本身不产生
// 子目录），递归深度恒为 1，无深递归栈风险。
function removeDirManual(dir) {
  // M5（codex 08 复审·本轮当场修）：上一版只对递归"子项"做了 lstat 判定，传入的 dir 根节点本身
  // 没查——若 batchDir（uploads/legacy-archive/<batch_id>）这个根目录被替换成指向外部路径的
  // symlink/junction，会直接 readdirSync(dir) 把外部目标目录的内容当成"本模块的图片文件"扫进来
  // 递归删除。根节点与子项用同一套判定逻辑：命中链接只删链接节点本身，绝不 readdir 递归进去。
  const rootSt = fs.lstatSync(dir);
  if (rootSt.isSymbolicLink()) {
    try {
      fs.unlinkSync(dir);
    } catch (e) {
      if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir);
      else throw e;
    }
    return;
  }
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink()) {
      try {
        fs.unlinkSync(full);
      } catch (e) {
        if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(full);
        else throw e;
      }
      continue;
    }
    if (st.isDirectory()) {
      removeDirManual(full);
      continue;
    }
    try {
      fs.unlinkSync(full);
    } catch (e) {
      if (e && e.code === 'EPERM') {
        fs.chmodSync(full, 0o666);
        fs.unlinkSync(full);
      } else {
        throw e;
      }
    }
  }
  fs.rmdirSync(dir);
}

async function removeDirWithRetry(dir, { maxRetries = 5 } = {}) {
  if (!fs.existsSync(dir)) return true;
  const delays = [50, 100, 200, 300, 300];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (!fs.existsSync(dir)) return true;
    try {
      removeDirManual(dir);
      if (!fs.existsSync(dir)) return true;
    } catch (_) { /* 单文件级瞬时锁，下一轮重试 */ }
    await new Promise((res) => setTimeout(res, delays[attempt] || 300));
  }
  return !fs.existsSync(dir);
}

// ---------------------------------------------------------------------------
// 收尾：按 batch_id 逐表 DELETE + 删物理目录（对齐任务指令"真库导入的批次必须在 finally 清干净"）
// ---------------------------------------------------------------------------
async function cleanupBatch(batchId) {
  if (!batchId) return { datasetIds: [], deleteErrors: [] };
  // M4（外部 codex 07 审）：此前每个 DELETE 的 { err, changes } 结果被直接丢弃——dbRun 内部已把
  // sqlite 错误 catch 成 { err } 返回而非 reject（配合 db.close() 无条件执行），调用方若不检查
  // err，一条 DELETE 真失败了也会被当作"清理成功"悄悄放过，直到下面的行数归零断言才可能间接测出来
  // （而且只测总数对不对，测不出"是哪条 DELETE 语句本身出错"）。现在逐条收集 err，让清理失败在
  // 来源处就判红，而不是靠下游断言侧面反推。
  const deleteErrors = [];
  const datasetRows = await dbAll(`SELECT id FROM legacy_archive_datasets WHERE batch_id = ?`, [batchId]);
  const datasetIds = (datasetRows || []).map(r => r.id);
  for (const dsId of datasetIds) {
    const res = await dbRun(`DELETE FROM legacy_archive_rows WHERE dataset_id = ?`, [dsId]);
    if (res.err) deleteErrors.push(`DELETE legacy_archive_rows(dataset_id=${dsId}): ${res.err.message}`);
  }
  const dsDel = await dbRun(`DELETE FROM legacy_archive_datasets WHERE batch_id = ?`, [batchId]);
  if (dsDel.err) deleteErrors.push(`DELETE legacy_archive_datasets(batch_id=${batchId}): ${dsDel.err.message}`);
  const batchDel = await dbRun(`DELETE FROM legacy_archive_batches WHERE id = ?`, [batchId]);
  if (batchDel.err) deleteErrors.push(`DELETE legacy_archive_batches(id=${batchId}): ${batchDel.err.message}`);
  const dir = path.join(ROOT, 'uploads', 'legacy-archive', String(batchId));
  const dirRemoved = await removeDirWithRetry(dir);
  return { datasetIds, dir, dirRemoved, deleteErrors };
}

(async () => {
  killPort(TEST_PORT);
  let batchId = null;
  let child = null;
  let log = '';
  let originalActiveId = null;

  try {
    // ===== MED1：记录本次测试前是否已有 active 批次 =====
    //   本次前置 import+activate 会把当时的旧 active 批次 retire 掉（runActivate 的既定语义）——
    //   若测试前 dev 库已有一条真实业务在用的 active 批次，e2e 跑完必须把它的 active 状态恢复回来，
    //   不能让"跑一次测试"变成"悄悄改动了生产可见的活动批次"。当前 dev 库实测无 active 批次（功能
    //   未上线），但这条防线写成不依赖这个当前事实——防止未来真上线后本脚本被人在有真实数据时误跑。
    const originalActiveRow = await dbGet(`SELECT id FROM legacy_archive_batches WHERE status = 'active'`);
    originalActiveId = originalActiveRow ? originalActiveRow.id : null;
    if (originalActiveId) {
      console.log(`[前置·MED1] 检测到已存在 active 批次 #${originalActiveId}，本次测试完成后会恢复其 active 状态`);
    } else {
      console.log('[前置·MED1] 当前无 active 批次，测试完成后无需恢复');
    }

    // ===== 前置：真实导入 + 激活 =====
    batchId = await importAndActivateBatch();
    console.log(`[前置] batch #${batchId} 已导入并激活（真实 dev 库 ${DB_FILE}）`);

    // ===== 组 0：静态断言——路由注册行 + 中间件顺序 =====
    const routerSrcPath = path.join(ROOT, 'routes', 'legacy-archive', 'index.js');
    const routerSrc = fs.readFileSync(routerSrcPath, 'utf8');
    const regLines = routerSrc.split(/\r?\n/).filter(l => /router\.(get|post|put|delete)\(/.test(l));
    check('静态断言：找到全部5条路由注册行', regLines.length === 5, `实际 ${regLines.length} 行：${JSON.stringify(regLines.map(l => l.trim()))}`);
    const badOrderLines = regLines.filter(l => {
      const posAuth = l.indexOf('authenticateToken');
      const posAdmin = l.indexOf('requireAdmin');
      const posSchema = l.indexOf('requireLegacyArchiveSchemaReady');
      return !(posAuth >= 0 && posAdmin >= 0 && posSchema >= 0 && posAuth < posAdmin && posAdmin < posSchema);
    });
    check('静态断言：全部5条 authenticateToken→requireAdmin→requireLegacyArchiveSchemaReady 顺序正确', badOrderLines.length === 0, JSON.stringify(badOrderLines.map(l => l.trim())));

    // ===== 启动测试服务 =====
    child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    const ready = await waitReady(() => log);
    check('测试服务 + legacy-archive schema 就绪', ready);
    if (!ready) throw new Error('服务未就绪：' + log.slice(-2000));

    const adminTok = await fx.signAs(ADMIN_ID);
    const nonAdminTok = await fx.signAs(NONADMIN_ID);

    // 采样：bug_list 里带图片的一行（供详情/图片/q筛选测试复用）
    const sampleRow = await dbGet(
      `SELECT r.id, r.row_index, r.images, r.search_text
         FROM legacy_archive_rows r
         JOIN legacy_archive_datasets d ON r.dataset_id = d.id
        WHERE d.batch_id = ? AND d.dataset_key = 'bug_list' AND r.images IS NOT NULL AND r.images != '[]'
        ORDER BY r.id ASC LIMIT 1`,
      [batchId]
    );
    check('前置采样：bug_list 内取到至少一行带图片的样本行', !!sampleRow, JSON.stringify(sampleRow));
    const sampleImages = JSON.parse(sampleRow.images);
    const sampleImageFile = sampleImages[0].file;
    // L1 自查踩坑（本轮实测发现）：路由层对 q 做 `qRaw.trim().toLowerCase()`（合理行为——去掉用户
    // 输入的首尾空白再搜索）。此处若只 `.trim().slice(0,4)` 不再二次 trim，切出来的 4 字符可能带
    // 尾随空格（如"474 "），路由端实际拿去 LIKE 的却是трим 过的"474"（3 字符，无空格）——两边用词
    // 不一致，会让下面的强化断言（核对返回行是否真含关键词）产生假红：LIKE '%474%' 命中的行不含
    // 空格版"474 "是完全合理的（router 从未用带空格的词搜过），错的是测试端还拿着带空格的旧词去核对。
    // 切片后再 trim 一次，保证测试端使用的词与路由端实际使用的词逐字节一致。
    const qHitTerm = String(sampleRow.search_text || '').trim().slice(0, 4).trim();
    check('前置采样：q 命中词非空', qHitTerm.length > 0, `search_text="${sampleRow.search_text}"`);

    const datasetsPath = '/api/legacy-archive/datasets';
    const rowsPath = '/api/legacy-archive/datasets/bug_list/rows';
    const rowDetailPath = `/api/legacy-archive/rows/${sampleRow.id}`;
    const imagePath = `/api/legacy-archive/images/${batchId}/${sampleImageFile}`;

    // ===== 组 1：未鉴权 401 ×5 + 非admin 403 ×5 =====
    check('未鉴权 GET datasets → 401', (await api('GET', datasetsPath)).status === 401);
    check('未鉴权 GET rows分页 → 401', (await api('GET', rowsPath)).status === 401);
    check('未鉴权 GET 行详情 → 401', (await api('GET', rowDetailPath)).status === 401);
    check('未鉴权 GET 图片 → 401', (await api('GET', imagePath)).status === 401);
    check('非admin GET datasets → 403', (await api('GET', datasetsPath, nonAdminTok)).status === 403);
    check('非admin GET rows分页 → 403', (await api('GET', rowsPath, nonAdminTok)).status === 403);
    check('非admin GET 行详情 → 403', (await api('GET', rowDetailPath, nonAdminTok)).status === 403);
    check('非admin GET 图片 → 403', (await api('GET', imagePath, nonAdminTok)).status === 403);
    const sourceFilePath = '/api/legacy-archive/source-file';
    check('未鉴权 GET 源文件 → 401', (await api('GET', sourceFilePath)).status === 401);
    check('非admin GET 源文件 → 403', (await api('GET', sourceFilePath, nonAdminTok)).status === 403);

    // ===== 组 2：/uploads/legacy-archive 直连 403 拦截 =====
    let up = await api('GET', `/uploads/legacy-archive/${batchId}/${sampleImageFile}`, adminTok);
    check('/uploads/legacy-archive 直连（even admin token 也拦，静态拦截不看鉴权）→ 403 DIRECT_ACCESS_FORBIDDEN',
      up.status === 403 && up.body && up.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(up.body));

    // ===== 组 2b（H1）：%编码绕过对照组 =====
    //   express@4.22.1 下 app.use(prefix,...) 的挂载点匹配用**未解码**的原始 req.url 做前缀+边界
    //   字符判断，而 express.static→send 模块取文件前会先 decodeURIComponent 一次，两处解码时机
    //   不一致——纯字面前缀拦截可被 %编码绕过。用 rawGet（原生 http.request，不经 WHATWG URL 客户端
    //   归一化）直发三种编码变体 + 一种畸形编码，锚定服务端解码后判定的真实行为（fetch 对这几种输入
    //   要么按字面转发不代表攻击面、要么被客户端提前拦截，测不出服务端自己的判定逻辑）。
    let er = await rawGet(`/uploads/legacy%2Darchive/${batchId}/${sampleImageFile}`, adminTok);
    check('H1 编码绕过对照组：legacy%2Darchive（%2D=-）→ 403 DIRECT_ACCESS_FORBIDDEN',
      er.status === 403 && er.body && er.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(er.body || er.raw));

    er = await rawGet(`/uploads/%6Cegacy-archive/${batchId}/${sampleImageFile}`, adminTok);
    check('H1 编码绕过对照组：%6Cegacy-archive（%6C=l）→ 403 DIRECT_ACCESS_FORBIDDEN',
      er.status === 403 && er.body && er.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(er.body || er.raw));

    er = await rawGet(`/uploads/legacy-archive%2F${batchId}/${sampleImageFile}`, adminTok);
    check('H1 编码绕过对照组：legacy-archive%2F<id>（%2F=/，字面前缀边界字符检查这里失效的原始洞）→ 403 DIRECT_ACCESS_FORBIDDEN',
      er.status === 403 && er.body && er.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(er.body || er.raw));

    er = await rawGet(`/uploads/legacy-archive/%`, adminTok);
    check('H1 编码绕过对照组：畸形 % 编码 → 400 BAD_PATH_ENCODING',
      er.status === 400 && er.body && er.body.code === 'BAD_PATH_ENCODING', JSON.stringify(er.body || er.raw));

    // ===== 组 3：admin 正环 =====
    let r = await api('GET', datasetsPath, adminTok);
    check('datasets 清单：8 个数据集', r.status === 200 && Array.isArray(r.body.datasets) && r.body.datasets.length === 8, JSON.stringify(r.body && r.body.datasets));
    const bugListEntry = r.body.datasets.find(d => d.dataset_key === 'bug_list');
    check('datasets 清单：bug_list row_count=8232', bugListEntry && bugListEntry.row_count === 8232, JSON.stringify(bugListEntry));
    check('datasets 清单：批次横幅字段齐全（source_file/source_sha256_short长度8/script_version/cutoff=2026-08-01）',
      r.body.batch && typeof r.body.batch.source_file === 'string' && r.body.batch.source_sha256_short && r.body.batch.source_sha256_short.length === 8
      && r.body.batch.script_version && r.body.batch.cutoff === '2026-08-01',
      JSON.stringify(r.body.batch));

    r = await api('GET', rowsPath, adminTok);
    check('rows 分页：total=8232（bug_list）', r.status === 200 && r.body.total === 8232, JSON.stringify({ status: r.status, total: r.body && r.body.total }));
    check('rows 分页：默认 page=1/pageSize=50/rows.length=50', r.body.page === 1 && r.body.pageSize === 50 && Array.isArray(r.body.rows) && r.body.rows.length === 50, JSON.stringify({ page: r.body.page, pageSize: r.body.pageSize, len: r.body.rows && r.body.rows.length }));

    // ===== MED2：投影反向断言 =====
    //   不满足于"响应形状看起来对"——从 db 侧独立核对该出现的字段都在、不该出现的字段都不在，
    //   防"列表端点悄悄多吐了 detail/none 字段"或"image_count/first_image 与库内真实值脱节"这类
    //   写读两端语义漂移（同类问题历史上在本项目多次以"渲染端与后端字段不同步"形式出现）。
    check('MED2 投影反向断言：columns.length=18（bug_list list 可见列数，方案 §3.2 冻结口径）',
      Array.isArray(r.body.columns) && r.body.columns.length === 18, JSON.stringify((r.body.columns || []).length));
    const columnFieldSet = new Set((r.body.columns || []).map(c => c.field));
    check('MED2 投影反向断言：detail 列 f019/f051 不出现在 columns（仅 list 可见列投影）',
      !columnFieldSet.has('f019') && !columnFieldSet.has('f051'), JSON.stringify([...columnFieldSet]));
    const firstRowData = r.body.rows[0] && r.body.rows[0].data;
    const noneFieldsSample = ['f020', 'f035', 'f050']; // 31 个 none 可见性字段（f020-f050）里抽样 3 个
    const noneFieldsAbsent = !!firstRowData && noneFieldsSample.every(f => !Object.prototype.hasOwnProperty.call(firstRowData, f));
    check('MED2 投影反向断言：抽样 3 个 none 可见性字段键（f020/f035/f050）不出现在 rows[0].data',
      noneFieldsAbsent, JSON.stringify(firstRowData && Object.keys(firstRowData)));

    const firstRowId = r.body.rows[0] && r.body.rows[0].id;
    const firstRowDbRaw = await dbGet(`SELECT images FROM legacy_archive_rows WHERE id = ?`, [firstRowId]);
    const firstRowImagesDb = safeParse(firstRowDbRaw && firstRowDbRaw.images, []);
    check('MED2 投影反向断言：image_count 与库内该行 images 数组长度一致',
      r.body.rows[0].image_count === (Array.isArray(firstRowImagesDb) ? firstRowImagesDb.length : 0),
      JSON.stringify({ apiCount: r.body.rows[0].image_count, dbCount: firstRowImagesDb.length }));
    const expectedFirstImage = (Array.isArray(firstRowImagesDb) && firstRowImagesDb[0] && firstRowImagesDb[0].file) ? firstRowImagesDb[0].file : null;
    check('MED2 投影反向断言：first_image 与库内 images[0].file 一致',
      r.body.rows[0].first_image === expectedFirstImage,
      JSON.stringify({ apiFirst: r.body.rows[0].first_image, dbFirst: expectedFirstImage }));

    // L4（Opus 预筛留存）：q 命中断言改断 total>=1，不再断言"样本行必然出现在默认第一页结果里"——
    //   命中数一旦超过默认 pageSize（50）且样本行按 row_index 排序恰好落在第一页之外，旧断言会
    //   flaky 判红（不是功能坏了，是断言本身对分页边界的假设不成立）。
    r = await api('GET', `${rowsPath}?q=${encodeURIComponent(qHitTerm)}`, adminTok);
    check('rows q筛选命中：total>=1（不锚定样本行必落第一页，防分页边界 flaky）',
      r.status === 200 && typeof r.body.total === 'number' && r.body.total >= 1, JSON.stringify({ status: r.status, total: r.body && r.body.total }));

    // L1（外部 codex 07 审）：total>=1 只证明"命中数不为 0"，不证明命中的是"真的含关键词的行"
    // （极端情况下若匹配逻辑有 bug 把不相关行也算进去，这条弱断言测不出来）。补一层：返回首行要么
    // 自己的 data 字段值（小写）含关键词，要么独立查库核对其 search_text 确实含关键词——双路径
    // 任一命中即可（data 只投影 list 字段，关键词理论上也可能只出现在 search_text 拼接后的整体
    // 里，两条路径互补，不是同一件事测两遍）。
    const qHitFirstRow = r.body.rows && r.body.rows[0];
    let qHitVerified = false;
    let qHitDetail = null;
    if (qHitFirstRow) {
      const dataValuesLower = Object.values(qHitFirstRow.data || {})
        .filter(v => v !== null && v !== undefined)
        .map(v => String(v).toLowerCase());
      const matchInData = dataValuesLower.some(v => v.includes(qHitTerm));
      const dbRowForQ = await dbGet(`SELECT search_text FROM legacy_archive_rows WHERE id = ?`, [qHitFirstRow.id]);
      const matchInSearchText = !!(dbRowForQ && dbRowForQ.search_text && dbRowForQ.search_text.includes(qHitTerm));
      qHitVerified = matchInData || matchInSearchText;
      qHitDetail = { id: qHitFirstRow.id, matchInData, matchInSearchText, qHitTerm, dbSearchText: dbRowForQ && dbRowForQ.search_text, apiData: qHitFirstRow.data };
    }
    check('L1 q筛选命中强化：返回首行的 data 字段值或库内 search_text 确实含关键词（非"凑巧命中"）',
      qHitVerified, JSON.stringify(qHitDetail));

    r = await api('GET', `${rowsPath}?q=${encodeURIComponent('ZZZ_LEGACY_ARCHIVE_VERIFY_NO_SUCH_TERM_9f8e7d')}`, adminTok);
    check('rows q筛选未命中：total=0', r.status === 200 && r.body.total === 0 && Array.isArray(r.body.rows) && r.body.rows.length === 0, JSON.stringify(r.body));

    r = await api('GET', `${rowsPath}?pageSize=500`, adminTok);
    check('rows pageSize越界钳制：500→200', r.status === 200 && r.body.pageSize === 200, JSON.stringify({ pageSize: r.body && r.body.pageSize }));
    r = await api('GET', `${rowsPath}?pageSize=0`, adminTok);
    check('rows pageSize非法回退默认：0→50', r.status === 200 && r.body.pageSize === 50, JSON.stringify({ pageSize: r.body && r.body.pageSize }));

    // ===== 排序（2026-08-22 需求变更：sort/dir 全字段列排序）=====
    //   双向证明（feedback_probe_test_bidirectional_proof）：asc/desc 两方向各自与库内独立
    //   SQL 核对（同一排序表达式，谁错谁暴露）；同值稳定二级序单独断言；非法 sort/dir 各断 400；
    //   末尾回归断言"省略参数=原表行序"防默认契约被排序改动带偏。
    const sortDsRow = await dbGet(
      `SELECT d.id AS did FROM legacy_archive_datasets d WHERE d.batch_id = ? AND d.dataset_key = 'bug_list'`, [batchId]);
    const sortDsId = sortDsRow && sortDsRow.did;

    r = await api('GET', `${rowsPath}?sort=_row&dir=desc`, adminTok);
    const maxRowIdxDb = await dbGet(`SELECT MAX(row_index) AS m FROM legacy_archive_rows WHERE dataset_id = ?`, [sortDsId]);
    check('排序 _row desc：首行 row_index=库内 MAX(row_index)',
      r.status === 200 && r.body.rows[0] && r.body.rows[0].row_index === maxRowIdxDb.m,
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].row_index, db: maxRowIdxDb && maxRowIdxDb.m }));

    // f001（序号列）asc/desc 双向：与库内同表达式独立核对（含 NULL 沉底——库侧核对 SQL 显式排除 NULL，
    // API 侧若 NULL 浮顶则首行值对不上）。codex 17 MED-4 采纳：断言条件显式要求库内最小/最大值
    // 非 null——f001 全 NULL 的退化场景下 String(null)===String(null) 恒真会让断言 vacuous 空转，
    // 非空前置让该场景直接判红暴露。核对表达式与实现同源（json_valid 守卫同步），同源同错风险由
    // f003 稳定序断言（纯 JS 比较）+ 总数锚 + 本条非空前置共同对冲，完全独立表达式的全序列核对
    // 成本不匹配（8232 行×多页拉取），登记不做。
    r = await api('GET', `${rowsPath}?sort=f001&dir=asc`, adminTok);
    const minF001Db = await dbGet(
      `SELECT (CASE WHEN json_valid(data) THEN json_extract(data,'$.f001') END) AS v FROM legacy_archive_rows
        WHERE dataset_id = ? AND (CASE WHEN json_valid(data) THEN json_extract(data,'$.f001') END) IS NOT NULL
        ORDER BY 1 ASC, row_index ASC LIMIT 1`, [sortDsId]);
    check('排序 f001 asc：首行 f001=库内最小非空值（NULL 沉底观测面·库内样本非空前置）',
      r.status === 200 && r.body.rows[0] && !!minF001Db && minF001Db.v !== null
      && String(r.body.rows[0].data.f001) === String(minF001Db.v),
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].data.f001, db: minF001Db && minF001Db.v }));
    r = await api('GET', `${rowsPath}?sort=f001&dir=desc`, adminTok);
    const maxF001Db = await dbGet(
      `SELECT (CASE WHEN json_valid(data) THEN json_extract(data,'$.f001') END) AS v FROM legacy_archive_rows
        WHERE dataset_id = ? AND (CASE WHEN json_valid(data) THEN json_extract(data,'$.f001') END) IS NOT NULL
        ORDER BY 1 DESC, row_index ASC LIMIT 1`, [sortDsId]);
    check('排序 f001 desc：首行 f001=库内最大非空值（反向一对，双向证明·库内样本非空前置）',
      r.status === 200 && r.body.rows[0] && !!maxF001Db && maxF001Db.v !== null
      && String(r.body.rows[0].data.f001) === String(maxF001Db.v),
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].data.f001, db: maxF001Db && maxF001Db.v }));

    // 稳定二级序：f003（风险等级，枚举列，首页 50 行内必有同值相邻对）——相邻同值对的 row_index
    // 必须严格递增；同时断言"同值相邻对至少存在一个"，防枚举分布变化让本断言 vacuous 空转。
    r = await api('GET', `${rowsPath}?sort=f003&dir=asc`, adminTok);
    let tiePairs = 0, tieStable = true;
    if (r.status === 200 && Array.isArray(r.body.rows)) {
      for (let i = 1; i < r.body.rows.length; i++) {
        const a = r.body.rows[i - 1], b = r.body.rows[i];
        if (a.data.f003 === b.data.f003) {
          tiePairs++;
          if (!(a.row_index < b.row_index)) { tieStable = false; break; }
        }
      }
    }
    check('排序 f003 asc 稳定二级序：同值相邻对 row_index 严格递增（且同值对>0 非空转）',
      r.status === 200 && tiePairs > 0 && tieStable, JSON.stringify({ tiePairs, tieStable }));

    r = await api('GET', `${rowsPath}?sort=_images&dir=desc`, adminTok);
    const maxImgDb = await dbGet(
      `SELECT MAX(CASE WHEN images IS NOT NULL AND json_valid(images) THEN json_array_length(images) ELSE 0 END) AS m FROM legacy_archive_rows WHERE dataset_id = ?`, [sortDsId]);
    check('排序 _images desc：首行 image_count=库内最大图片数',
      r.status === 200 && r.body.rows[0] && r.body.rows[0].image_count === maxImgDb.m,
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].image_count, db: maxImgDb && maxImgDb.m }));
    r = await api('GET', `${rowsPath}?sort=_images&dir=asc`, adminTok);
    const minImgDb = await dbGet(
      `SELECT MIN(CASE WHEN images IS NOT NULL AND json_valid(images) THEN json_array_length(images) ELSE 0 END) AS m FROM legacy_archive_rows WHERE dataset_id = ?`, [sortDsId]);
    check('排序 _images asc：首行 image_count=库内最小图片数（反向一对）',
      r.status === 200 && r.body.rows[0] && r.body.rows[0].image_count === minImgDb.m,
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].image_count, db: minImgDb && minImgDb.m }));

    // dir 单独给（sort 省略）＝按行号排：语义上 sort 缺省即 _row
    r = await api('GET', `${rowsPath}?dir=desc`, adminTok);
    check('排序 dir 单独 desc：首行 row_index=库内 MAX（sort 缺省按 _row）',
      r.status === 200 && r.body.rows[0] && r.body.rows[0].row_index === maxRowIdxDb.m,
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].row_index }));

    // 非法值 400 显式拒绝（非钳制家族）：detail 列键 f051 不在 list 白名单同样 400
    r = await api('GET', `${rowsPath}?sort=f999`, adminTok);
    check('排序非法 sort=f999：400 INVALID_SORT', r.status === 400 && !!r.body && r.body.code === 'INVALID_SORT', JSON.stringify({ status: r.status, code: r.body && r.body.code }));
    r = await api('GET', `${rowsPath}?sort=f051`, adminTok);
    check('排序非白名单 sort=f051（detail 列）：400 INVALID_SORT', r.status === 400 && !!r.body && r.body.code === 'INVALID_SORT', JSON.stringify({ status: r.status, code: r.body && r.body.code }));
    r = await api('GET', `${rowsPath}?sort=${encodeURIComponent("f001')--")}`, adminTok);
    check('排序注入形 sort 值：400 INVALID_SORT（正则+白名单双闸）', r.status === 400 && !!r.body && r.body.code === 'INVALID_SORT', JSON.stringify({ status: r.status, code: r.body && r.body.code }));
    r = await api('GET', `${rowsPath}?sort=_row&dir=up`, adminTok);
    check('排序非法 dir=up：400 INVALID_SORT_DIR', r.status === 400 && !!r.body && r.body.code === 'INVALID_SORT_DIR', JSON.stringify({ status: r.status, code: r.body && r.body.code }));

    // 回归：省略 sort/dir 默认契约不变（原表行序 row_index ASC）
    r = await api('GET', rowsPath, adminTok);
    const minRowIdxDb = await dbGet(`SELECT MIN(row_index) AS m FROM legacy_archive_rows WHERE dataset_id = ?`, [sortDsId]);
    check('排序回归：省略 sort/dir 首行 row_index=库内 MIN（默认原表行序契约不变）',
      r.status === 200 && r.body.rows[0] && r.body.rows[0].row_index === minRowIdxDb.m,
      JSON.stringify({ api: r.body.rows && r.body.rows[0] && r.body.rows[0].row_index, db: minRowIdxDb && minRowIdxDb.m }));

    r = await api('GET', rowDetailPath, adminTok);
    check('行详情：dataset_key=bug_list + images 非空', r.status === 200 && r.body.dataset_key === 'bug_list' && Array.isArray(r.body.images) && r.body.images.length > 0, JSON.stringify({ status: r.status, dataset_key: r.body && r.body.dataset_key, images: r.body && r.body.images }));
    const hasDetailCol = Array.isArray(r.body.columns) && r.body.columns.some(c => c.visibility === 'detail');
    const detailFieldPresent = hasDetailCol && r.body.columns.filter(c => c.visibility === 'detail').every(c => Object.prototype.hasOwnProperty.call(r.body.data, c.field));
    check('行详情：columns 含 detail 可见性列，且 data 覆盖该字段键', hasDetailCol && detailFieldPresent, JSON.stringify({ hasDetailCol, detailFieldPresent }));

    // M1（外部 codex 07 审·部分采纳，只加断言不改行为）：行详情返回全量 data 是设计（详情页展示
    // 全字段，方案 §5），none 可见性字段（WPS 图片外溢列，本无格值）理应恒为 null——加断言防将来
    // 万一某个 none 列意外携带了非 null 值（如源表结构变化导致某"图片外溢列"实际混入了文本）而
    // 从未被任何断言捕获到。
    const noneFieldsNullInDetail = ['f020', 'f035', 'f050'].every(f => r.body.data[f] === null);
    check('M1 行详情 none 投影：抽验 3 个 none 字段（f020/f035/f050）值均为 null（图片外溢列本无格值，不改行为）',
      noneFieldsNullInDetail, JSON.stringify({ f020: r.body.data.f020, f035: r.body.data.f035, f050: r.body.data.f050 }));

    let imgRes = await fetch(`${BASE}${imagePath}`, { headers: { Authorization: `Bearer ${adminTok}` } });
    const imgBuf = await imgRes.arrayBuffer();
    check('图片端点：200 + Content-Type image/* + 非空字节流', imgRes.status === 200 && /^image\//.test(imgRes.headers.get('content-type') || '') && imgBuf.byteLength > 0,
      `status=${imgRes.status} content-type=${imgRes.headers.get('content-type')} bytes=${imgBuf.byteLength}`);
    check('图片端点：Content-Disposition=inline', imgRes.headers.get('content-disposition') === 'inline', imgRes.headers.get('content-disposition'));
    check('L2 图片端点：X-Content-Type-Options=nosniff', imgRes.headers.get('x-content-type-options') === 'nosniff', imgRes.headers.get('x-content-type-options'));

    // ===== 组 3b：源文件下载端点正环（2026-08-22 增·随 D4 源文件收口）=====
    //   只读响应头即 cancel body——源文件 ~70MB，拉全量进 verify 内存既慢又无断言价值；
    //   Content-Length 与磁盘真实 size、X-Source-SHA256 与库内 batches.source_sha256 各自独立核对。
    const srcBatchRow = await dbGet(`SELECT source_file, source_sha256 FROM legacy_archive_batches WHERE id = ?`, [batchId]);
    const srcDiskPath = path.join(ROOT, 'uploads', 'legacy-archive', 'source', srcBatchRow.source_file);
    const srcDiskSize = fs.existsSync(srcDiskPath) ? fs.statSync(srcDiskPath).size : -1;
    const srcRes = await fetch(`${BASE}${sourceFilePath}`, { headers: { Authorization: `Bearer ${adminTok}` } });
    const srcDisp = srcRes.headers.get('content-disposition') || '';
    const srcLen = Number(srcRes.headers.get('content-length'));
    const srcSha = srcRes.headers.get('x-source-sha256');
    if (srcRes.body) await srcRes.body.cancel();
    check('源文件端点：200 + xlsx Content-Type + attachment 含 UTF-8 文件名',
      srcRes.status === 200
      && srcRes.headers.get('content-type') === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      && srcDisp.startsWith('attachment;') && srcDisp.includes(`filename*=UTF-8''${encodeURIComponent(srcBatchRow.source_file)}`),
      `status=${srcRes.status} type=${srcRes.headers.get('content-type')} disp=${srcDisp}`);
    check('源文件端点：Content-Length=磁盘真实 size（独立 stat 核对）',
      srcDiskSize > 0 && srcLen === srcDiskSize, JSON.stringify({ srcLen, srcDiskSize }));
    check('源文件端点：X-Source-SHA256=库内 batches.source_sha256',
      !!srcSha && srcSha === srcBatchRow.source_sha256, JSON.stringify({ srcSha, db: srcBatchRow.source_sha256 }));

    // ===== 组 4：404/400 边界 =====
    r = await api('GET', '/api/legacy-archive/datasets/no_such_dataset_key/rows', adminTok);
    check('未知 dataset key → 404 LEGACY_ARCHIVE_DATASET_NOT_FOUND', r.status === 404 && r.body.code === 'LEGACY_ARCHIVE_DATASET_NOT_FOUND', JSON.stringify(r.body));

    r = await api('GET', '/api/legacy-archive/rows/abc', adminTok);
    check('非数字 id → 400 INVALID_ID', r.status === 400 && r.body.code === 'INVALID_ID', JSON.stringify(r.body));
    r = await api('GET', '/api/legacy-archive/rows/0', adminTok);
    check('id=0 → 400 INVALID_ID（非正整数）', r.status === 400 && r.body.code === 'INVALID_ID', JSON.stringify(r.body));

    r = await api('GET', `${rowsPath}?page=99999`, adminTok);
    check('越界页：空 rows + 真实 total=8232', r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length === 0 && r.body.total === 8232, JSON.stringify({ status: r.status, len: r.body.rows && r.body.rows.length, total: r.body.total }));

    // L1（Opus 预筛留存，本轮当场修）：page 极端值（超长数字串）不应把 sqlite3 驱动/SQLite 自身的
    // 原始报错文本透传给客户端——路由层 PAGE_MAX 钳制后，这类请求应与"越界页"同款语义：200 + 空
    // rows + 真实 total，而不是 500 + 内部实现细节泄露。
    r = await api('GET', `${rowsPath}?page=99999999999999999999`, adminTok);
    check('L1 page 极端值：不泄露原始报错，200 + 空 rows + 真实 total=8232',
      r.status === 200 && Array.isArray(r.body.rows) && r.body.rows.length === 0 && r.body.total === 8232,
      JSON.stringify({ status: r.status, body: r.body }));

    r = await api('GET', `/api/legacy-archive/images/abc/${sampleImageFile}`, adminTok);
    check('图片端点：batchId 非数字 → 400 INVALID_BATCH_ID', r.status === 400 && r.body.code === 'INVALID_BATCH_ID', JSON.stringify(r.body));
    r = await api('GET', `/api/legacy-archive/images/999999999/${sampleImageFile}`, adminTok);
    check('图片端点：batchId 不是 active 批次 → 404 LEGACY_ARCHIVE_BATCH_NOT_FOUND', r.status === 404 && r.body.code === 'LEGACY_ARCHIVE_BATCH_NOT_FOUND', JSON.stringify(r.body));

    // file 白名单外（%2f 编码斜杠，服务端 decode 后含 '/'，被 IMAGE_FILENAME_PATTERN 拒）
    r = await api('GET', `/api/legacy-archive/images/${batchId}/..%2f..%2fsecret`, adminTok);
    check('图片端点：文件名白名单外(../ via %2f) → 400 INVALID_FILE_NAME', r.status === 400 && r.body.code === 'INVALID_FILE_NAME', JSON.stringify(r.body));

    // file 合法（白名单内）但未被任何行引用 → 404
    r = await api('GET', `/api/legacy-archive/images/${batchId}/ID_NOTAREALFILE00000000000000000000.png`, adminTok);
    check('图片端点：合法文件名但不在 images 记录中 → 404 LEGACY_ARCHIVE_IMAGE_NOT_FOUND', r.status === 404 && r.body.code === 'LEGACY_ARCHIVE_IMAGE_NOT_FOUND', JSON.stringify(r.body));

    // file 合法（".." 全由白名单内字符构成）——DB 直插伪造 images 记录令其命中"引用"检查，
    // 验证子树越界护栏（对齐 verify-quick-log.js「DB 直插伪造 file_name 断 403」范式）。
    const fakeImages = JSON.stringify([{ field: 'f001', seq: 1, file: '..', orig_id: 'FAKE_TRAVERSAL', mime: 'image/png' }]);
    await dbRun(`UPDATE legacy_archive_rows SET images = ? WHERE id = ?`, [fakeImages, sampleRow.id]);
    // 用 rawGet（原生 http.request）而非 fetch——纯 "%2e%2e" 单段会被 WHATWG URL 解析器在客户端就
    // 折叠成 ".."+连同前一段一并丢弃（规范明文的 double-dot path segment 归一化），fetch 永远发不出
    // 这个请求；rawGet 绕开归一化，直发原始 path，交给服务端自己的 decodeURIComponent + 白名单 +
    // 子树校验逐层处理（对齐 verify-quick-log.js「DB 直插伪造 file_name 断 403」范式的服务端聚焦点）。
    r = await rawGet(`/api/legacy-archive/images/${batchId}/%2e%2e`, adminTok);
    check('图片端点：白名单合法但子树越界(伪造".."记录) → 403 ILLEGAL_FILE_PATH', r.status === 403 && r.body && r.body.code === 'ILLEGAL_FILE_PATH', JSON.stringify(r.body || r.raw));
    // 还原样本行的真实 images（后续组5/finally 会整批删除，这里其实非必需，但保持中间状态干净、
    // 不依赖"反正马上要删"的假设——防御性还原）。
    await dbRun(`UPDATE legacy_archive_rows SET images = ? WHERE id = ?`, [JSON.stringify(sampleImages), sampleRow.id]);

    // 源文件缺失 → 404 fail-closed（临时改名磁盘文件再请求，finally 语义就地还原——改名窗口内
    // 若生产观察环境恰有人点下载会撞 404，窗口毫秒级可接受）
    let srcMissRes = null;
    if (srcDiskSize > 0) {
      const srcTmpPath = srcDiskPath + '.verify-tmp';
      fs.renameSync(srcDiskPath, srcTmpPath);
      try {
        srcMissRes = await api('GET', sourceFilePath, adminTok);
      } finally {
        fs.renameSync(srcTmpPath, srcDiskPath);
      }
    }
    check('源文件缺失 → 404 SOURCE_FILE_NOT_FOUND（fail-closed，改名测试后已还原）',
      !!srcMissRes && srcMissRes.status === 404 && srcMissRes.body && srcMissRes.body.code === 'SOURCE_FILE_NOT_FOUND',
      JSON.stringify(srcMissRes && { status: srcMissRes.status, body: srcMissRes.body }));

    // ===== H2（外部 codex 07 审）：读取端防符号链接/junction 负向自证 =====
    //   在 batchDir 内放一个指向子树外的 Windows 目录联接（junction——本机测试手段选择：真符号链接
    //   在 Windows 默认需要 Developer Mode/管理员权限，junction 普通用户即可创建，更适合作为可重复
    //   跑的回归测试；两者在 Node lstat 层面走同一个 isSymbolicLink() 判定分支，测试效力等价）。
    //   命名匹配白名单字符集，DB 篡改令其命中"引用"检查，验证 H2 的 lstatSync 防线独立拦截——这条
    //   路径字符串本身就在子树内（不含 ..），上面的"within 子树"前缀检查测不出它，必须靠 lstatSync
    //   识别"这个路径节点本身是链接"才能拦，是与 within 检查互补的第二重独立防线。
    //   check() 无论 junction 创建是否成功都恰好执行一次（创建失败本身就判红，不静默跳过，保证
    //   EXPECTED_ASSERTIONS 不随本机是否支持 junction 而漂移）。
    const batchDirForJunction = path.join(ROOT, 'uploads', 'legacy-archive', String(batchId));
    const junctionName = 'ID_H2JUNCTIONTEST0000000000000000.png';
    const junctionPath = path.join(batchDirForJunction, junctionName);
    let junctionCreateError = null;
    try {
      fs.symlinkSync(ROOT, junctionPath, 'junction');
    } catch (e) {
      junctionCreateError = e;
    }
    let h2JunctionResult = null;
    if (!junctionCreateError) {
      const fakeJunctionImages = JSON.stringify([{ field: 'f001', seq: 1, file: junctionName, orig_id: 'FAKE_JUNCTION', mime: 'image/png' }]);
      await dbRun(`UPDATE legacy_archive_rows SET images = ? WHERE id = ?`, [fakeJunctionImages, sampleRow.id]);
      h2JunctionResult = await api('GET', `/api/legacy-archive/images/${batchId}/${junctionName}`, adminTok);
      await dbRun(`UPDATE legacy_archive_rows SET images = ? WHERE id = ?`, [JSON.stringify(sampleImages), sampleRow.id]);
      // 清理 junction 节点本身——rmdirSync 对纯链接节点是安全的，不会递归进目标（同 M5 处置逻辑）。
      try { fs.rmdirSync(junctionPath); } catch (e) { results.push(`  ⚠️ H2 junction 清理失败（需人工核实）：${junctionPath}（${e.message}）`); }
    }
    check('H2 负向自证：batchDir 内伪造 junction（命名匹配白名单+DB命中引用检查）→ 403 ILLEGAL_FILE_PATH',
      !junctionCreateError && h2JunctionResult && h2JunctionResult.status === 403 && h2JunctionResult.body && h2JunctionResult.body.code === 'ILLEGAL_FILE_PATH',
      junctionCreateError ? `junction 创建失败：${junctionCreateError.message}` : JSON.stringify(h2JunctionResult && h2JunctionResult.body));

    // ===== 组 5：批次 retire 后 no-active 语义 =====
    await dbRun(`UPDATE legacy_archive_batches SET status = 'retired' WHERE id = ?`, [batchId]);
    r = await api('GET', datasetsPath, adminTok);
    check('批次 retire 后：datasets → 空清单 + notice（无 active 批次语义）',
      r.status === 200 && Array.isArray(r.body.datasets) && r.body.datasets.length === 0 && r.body.notice === '暂无活动归档批次', JSON.stringify(r.body));
    r = await api('GET', rowsPath, adminTok);
    check('批次 retire 后：该 dataset 的 rows 端点随之 404（无 active 批次可解析）', r.status === 404 && r.body.code === 'LEGACY_ARCHIVE_DATASET_NOT_FOUND', JSON.stringify(r.body));
    r = await api('GET', sourceFilePath, adminTok);
    check('批次 retire 后：源文件端点随之 404（无 active 批次语义）', r.status === 404 && r.body && r.body.code === 'LEGACY_ARCHIVE_BATCH_NOT_FOUND', JSON.stringify(r.body));

  } catch (e) {
    check('e2e 执行异常', false, e.message + '\n' + (e.stack || ''));
  } finally {
    try { if (child) child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    killPort(TEST_PORT);

    // ===== 组 6：彻底清理 + 清理断言到磁盘 =====
    let cleanupInfo = { datasetIds: [], deleteErrors: [] };
    try {
      cleanupInfo = await cleanupBatch(batchId);
    } catch (e) {
      results.push(`  ⚠️ 清理批次 #${batchId} 时异常：${e.message}`);
    }
    if (batchId) {
      // M4：DELETE 语句本身有无出错——判红而非静默（见 cleanupBatch 注释）。
      check('M4 清理断言：全部 DELETE 语句无 SQL 错误', (cleanupInfo.deleteErrors || []).length === 0, JSON.stringify(cleanupInfo.deleteErrors));
      check('清理断言：uploads/legacy-archive/<batch_id>/ 目录已不存在', cleanupInfo.dirRemoved === true, cleanupInfo.dir);

      const batchLeft = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_batches WHERE id = ?`, [batchId]).catch(() => null);
      check('清理断言：legacy_archive_batches 该批次行数归零', batchLeft && batchLeft.c === 0, JSON.stringify(batchLeft));

      const datasetsLeft = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_datasets WHERE batch_id = ?`, [batchId]).catch(() => null);
      check('清理断言：legacy_archive_datasets 该批次行数归零', datasetsLeft && datasetsLeft.c === 0, JSON.stringify(datasetsLeft));

      if (cleanupInfo.datasetIds.length > 0) {
        const placeholders = cleanupInfo.datasetIds.map(() => '?').join(',');
        const rowsLeft = await dbGet(`SELECT COUNT(*) c FROM legacy_archive_rows WHERE dataset_id IN (${placeholders})`, cleanupInfo.datasetIds).catch(() => null);
        check('清理断言：legacy_archive_rows 该批次行数归零', rowsLeft && rowsLeft.c === 0, JSON.stringify(rowsLeft));
      } else {
        check('清理断言：legacy_archive_rows 该批次行数归零（datasetIds 为空，无需查询即视为归零）', true);
      }
    }

    // ===== MED1：恢复原 active 批次状态（若测试前已存在）=====
    //   本次导入批次已彻底删除（上面几条清理断言之后）；若测试前存在旧 active 批次，此刻把它的
    //   status 重新置回 active。此处对 originalActiveId 为 null（测试前本就无 active）的分支也统一
    //   跑同一条 check()，让这条断言在任何环境下都恰好执行一次——EXPECTED_ASSERTIONS 常量才能稳定，
    //   不随"当时 dev 库有没有 active 批次"这种外部状态漂移。
    let originalActiveRestoreOk = true;
    if (originalActiveId) {
      await dbRun(`UPDATE legacy_archive_batches SET status = 'active' WHERE id = ?`, [originalActiveId]);
      const restored = await dbGet(`SELECT status FROM legacy_archive_batches WHERE id = ?`, [originalActiveId]).catch(() => null);
      originalActiveRestoreOk = !!restored && restored.status === 'active';
    }
    check('MED1：原有 active 批次（如有）测试后已恢复为 active',
      originalActiveRestoreOk,
      originalActiveId ? `id=${originalActiveId}` : '（本次测试前无 active 批次，天然满足，未做任何恢复动作）');
  }

  // MED3（Opus 预筛留存）：与 verify-legacy-archive-schema.js 的 L2 修法一致——不满足于"分子分母
  // 恒等的假 N/N"，用独立硬编码的期望值与真实 check() 触发总数对拍。本文件全部 check() 调用点均为
  // 单次触发（无循环包裹，不像 schema verify 那样需要按迭代次数展开计数），EXPECTED_ASSERTIONS 直接
  // 等于静态调用点数——数值随本文件新增/删除断言需要同步手工重算，忘了同步会被下面这条自己判红。
  const EXPECTED_ASSERTIONS = 77; // 58（前轮）+ 12（排序组·含 _images asc/desc 双向）+ 7（源文件端点：401/403 + 正环3 + 缺失404 + retire 404）
  const actualAssertionCount = pass + fail; // 快照——不含本条锚点断言自己（下面 check() 还没调用）
  check('MED3：断言总数锚（实际 check() 触发次数 vs 硬编码期望值）',
    actualAssertionCount === EXPECTED_ASSERTIONS,
    `实际=${actualAssertionCount} 期望=${EXPECTED_ASSERTIONS}（可能新增/删除了断言但未同步更新 EXPECTED_ASSERTIONS 常量）`);

  console.log('─────── 历史台账归档 A3 verify e2e 结果 ───────');
  results.forEach(l => console.log(l));
  console.log(`\n总判定：${fail === 0 ? '✅ PASS' : '❌ FAIL'}（${pass} 通过 / ${fail} 失败）`);
  process.exit(fail === 0 ? 0 : 1);
})();
