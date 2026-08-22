/**
 * S-SEC verify e2e · /uploads 附件直连拦截 %编码绕过修复 回归验证
 *
 * 背景：server.js 的 /uploads 直连拦截早前按模块各挂一条**字面前缀**中间件
 *   `app.use('/uploads/<模块>', ...)`（issue-lite / quick-log / legacy-archive 三处）。
 *   express@4.22.1 下 app.use(prefix,...) 的挂载点前缀匹配用**未解码**的原始 req.url 做判断，而
 *   下方 express.static→send 取文件前会先 decodeURIComponent 一次——两处解码时机不一致，
 *   `/uploads/issue%2Dlite/...`（%2D=-）、`/uploads/%69ssue-lite/...`（%69=i）、
 *   `/uploads/issue-lite%2F...`（%2F=/）等编码变体均可绕过字面前缀判断，直接落到无鉴权的
 *   express.static 吐出原文。
 *
 * 修复（server.js:786 附近）：三模块合并挂在更宽的 `/uploads` 前缀下一条中间件，中间件内先
 *   decodeURIComponent(req.path) 一次再用正则 `^/(issue-lite|quick-log|legacy-archive)(\/|$)/i`
 *   判定——解码时机与 send 模块对齐，明文与全部编码变体一并堵死；decodeURIComponent 本身抛出的
 *   畸形 %序列直接 400 BAD_PATH_ENCODING。collab/issues 等其余 /uploads/* 路径不匹配三前缀正则，
 *   next() 照常走静态服务，不受影响（这三模块数据敏感收紧为鉴权唯一入口，collab/issues 老附件
 *   沿用文件名不可猜的静态服务，是有意的架构差异，不是遗漏）。
 *
 * 二次收口（codex 13 HIGH + codex 14 建议·guard 终态=realpath 容器归属）：仅 decode+正则 会陷入
 *   逐个对齐 send/Windows 路径规范化 quirk 的打地鼠——已实证漏过反斜杠分隔符、真 ./.. 横切、%2F/%5C
 *   编码变体；还有条件性风险面 8.3 短名、junction/reparse、大小写。终态改为**不做词法正则**：
 *   `path.join(UPLOAD_DIR, decode)` 解 \ 与 ./.. 词法层 → `fs.realpathSync.native` 再解 8.3/junction/
 *   大小写/尾点空格到唯一真相 → 判真实落盘是否落在三受限目录容器内（见 server.js:791 附近）。
 *   realpath 与 send 同源，故 realpath 解不到的非规范 quirk（段尾点/空格、..%20）本平台亦不泄漏。
 *
 * 本脚本覆盖（≥40 条断言）：
 *   ① 三模块前缀 %编码变体全堵（核心回归）——issue-lite / quick-log / legacy-archive 各造一个
 *      带 SECRET 标记的真实探针文件，每模块测明文 / %2D连字符编码 / 首字母编码 / %2F分隔符编码
 *      四种变体，逐条断言拦截 + 聚合断言全部响应体均不含任一探针 SECRET（无一变体泄漏原文）。
 *      %2F 变体收紧为严格 403（codex 13 MED-1：早前放宽 403/404 会让"落到 404"掩盖真绕过）。
 *   ⑤ 横切 / 文件系统别名类绕过全堵（codex 13 HIGH + codex 14 回归·核心）——每模块 9 变体分两档：
 *      strict403 档（真实受限文件可解析到）=%5C反斜杠 / collab+..\反斜杠横切 / 纯正斜杠..横切 /
 *      %2F编码..横切 / 任意前缀 x/..横切 / 大写目录名（realpath 归一 8.3/大小写）→ 严格 403；
 *      noLeak 档（本平台非规范 quirk）=段尾点 / 段尾空格 / ..%20 排序横切 → 允许 403/404 但绝不泄漏。
 *      聚合断言 27 变体全部响应体均不含 SECRET（修复前反斜杠/横切类 7 变体 200 吐原文·本轮 HIGH 回归面）。
 *   ② 畸形编码 → 400 BAD_PATH_ENCODING（decodeURIComponent 自身抛异常的兜底分支）。
 *      注（codex 13 LOW）：collab/issues 的畸形 %序列本轮起也归 400（decode 抛异常在三前缀判定之前），
 *      系有意——畸形 URL 判 400 比静默落 static 404 更正确，非误伤。
 *   ③ collab 老附件不被误伤（回归·防误拦）——collab 目录下造一个不属于三模块的探针，断言明文
 *      直连仍 200 正常返回（证明正则只拦三前缀、不误伤 /uploads 下其余路径）。
 *   ④ 可选加固：issue-lite 鉴权下载端点本身不受本次合并影响（用真实非作废附件样本只读验证；
 *      无样本时打 NOTE 不计入断言，不虚增 pass·codex 13 MED-2）。
 *
 * harness 范式对齐 scripts/verify-legacy-archive-api.js（B 套 e2e）：spawn 真实 server.js
 * （独立 TEST_PORT）+ 真库 task_pool.db（④ 只读查询，不写入不清理）+ netstat 精确杀端口 +
 * 原生 http.request 直发原始 path（不经 fetch/WHATWG URL 客户端归一化，测服务端真实解码行为）。
 *
 * 不改 server.js/任何生产代码，不 commit。finally 彻底清理全部探针文件 + 断言清理归零。
 *
 * 用法：node scripts/verify-uploads-guard.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3466;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const ADMIN_ID = fx.ADMIN_ID; // 1，admin

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; results.push(`  ✅ ${name}`); }
  else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}

// fetch/WHATWG URL 会在客户端就把部分 %编码路径段归一化（甚至拒绝发出畸形 %序列），测不出
// 服务端自己的 decodeURIComponent 解码行为——改用 Node 原生 http.request 直发原始 path 字符串。
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
          try { body = JSON.parse(raw); } catch (_) { /* 非 json（静态文件原文/空体） */ }
          resolve({ status: res.statusCode, headers: res.headers, body, raw });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// netstat 精确端口比较（findstr 子串匹配会误命中，对齐 verify-legacy-archive-api.js 范式）
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

function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE);
    // db.close() 传回调等真正关闭完成后再 resolve——不等待会在本机 Node+sqlite3 组合下留一个
    // 尚未收尾的 libuv async handle，紧跟着的 process.exit() 偶发触发原生断言崩溃
    // （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`，本脚本改前 100% 复现，改后不再复现）。
    db.get(sql, params || [], (err, row) => {
      db.close(() => { err ? reject(err) : resolve(row); });
    });
  });
}

async function waitReady(getLog, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // 探测锚：guard 中间件是纯正则判定、不依赖任何模块 schema 就绪，server.js 一旦监听端口即可用。
    // 用一个明文命中 issue-lite 前缀的探测路径（不要求文件存在——guard 在 express.static 之前
    // 短路返回 403，与文件是否存在无关）双重确认：日志出现启动文案 + 该路径真的返回 403。
    if (/Task Pool Server running/.test(getLog())) {
      try {
        const r = await fetch(`${BASE}/uploads/issue-lite/__readiness_probe__`);
        if (r.status === 403) return true;
      } catch (_) { /* ignore，继续轮询 */ }
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

// ---------------------------------------------------------------------------
// 探针 fixture 定义：三模块各一个真实文件（内容带唯一 SECRET 标记，用于断言"没泄漏原文"）+
// collab 一个不属于三模块前缀的探针（用于断言"没被误拦"）。
// ---------------------------------------------------------------------------
const PROBES = [
  {
    mod: 'issue-lite', file: 'SEC_PROBE_ISSUE_LITE.txt',
    secret: 'SECRET_ISSUE_LITE_9f8e7d3a2b1c',
    encHyphen: 'issue%2Dlite',   // %2D = '-'
    encFirst: '%69ssue-lite',    // %69 = 'i'
  },
  {
    mod: 'quick-log', file: 'SEC_PROBE_QUICK_LOG.txt',
    secret: 'SECRET_QUICK_LOG_9f8e7d3a2b1c',
    encHyphen: 'quick%2Dlog',
    encFirst: '%71uick-log',     // %71 = 'q'
  },
  {
    mod: 'legacy-archive', file: 'SEC_PROBE_LEGACY_ARCHIVE.txt',
    secret: 'SECRET_LEGACY_ARCHIVE_9f8e7d3a2b1c',
    encHyphen: 'legacy%2Darchive',
    encFirst: '%6Cegacy-archive', // %6C = 'l'
  },
];

const COLLAB_PROBE_DIR = path.join(UPLOAD_DIR, 'collab', 'SEC_PROBE_COLLAB_TEST');
const COLLAB_PROBE_FILE = path.join(COLLAB_PROBE_DIR, 'probe.txt');
const COLLAB_SECRET = 'COLLAB_PASS_THROUGH_OK_9f8e7d3a2b1c';

// ⑥a junction 探针：公开 collab 下造一个指向受限 issue-lite 目录的 junction（mklink /J·无需管理员）
const JCT_NAME = 'SEC_PROBE_JUNCTION';
const JCT_PATH = path.join(UPLOAD_DIR, 'collab', JCT_NAME);
const JCT_TARGET = path.join(UPLOAD_DIR, 'issue-lite');
let jctReady = false;
// junction 存在性用 lstat（stat 链接本身·不跟随）——existsSync 会跟随 junction，target 被删的 broken
// junction 会误判为不存在而跳过清理留残留（codex 16 建议）。
function junctionExists(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }

(async () => {
  killPort(TEST_PORT);
  let child = null;
  let log = '';
  const createdFiles = [];

  try {
    // ===== 前置：造真实探针文件 =====
    for (const p of PROBES) {
      const dir = path.join(UPLOAD_DIR, p.mod);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, p.file);
      fs.writeFileSync(filePath, p.secret, 'utf8');
      createdFiles.push(filePath);
      console.log(`[前置] 探针已造：${filePath}`);
    }
    fs.mkdirSync(COLLAB_PROBE_DIR, { recursive: true });
    fs.writeFileSync(COLLAB_PROBE_FILE, COLLAB_SECRET, 'utf8');
    createdFiles.push(COLLAB_PROBE_FILE);
    console.log(`[前置] collab 探针已造：${COLLAB_PROBE_FILE}`);

    // ⑥a junction 探针：collab\SEC_PROBE_JUNCTION → issue-lite 目录（mklink /J，无需管理员；失败则跳过⑥a）
    try {
      try { if (junctionExists(JCT_PATH)) fs.rmdirSync(JCT_PATH); } catch (_) { /* 残留清理 */ }
      execSync(`mklink /J "${JCT_PATH}" "${JCT_TARGET}"`, { shell: 'cmd.exe', stdio: 'ignore' });
      jctReady = junctionExists(JCT_PATH);
      console.log(`[前置] junction 探针已造：${JCT_PATH} → ${JCT_TARGET}（ready=${jctReady}）`);
    } catch (e) {
      jctReady = false;
      console.log(`[前置] junction 探针创建失败（跳过⑥a·非回归失败）：${e.message}`);
    }

    // ===== 启动测试服务 =====
    child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });
    const ready = await waitReady(() => log);
    check('测试服务已就绪（Task Pool Server running + guard 中间件即时可用）', ready);
    if (!ready) throw new Error('服务未就绪：' + log.slice(-2000));

    const adminTok = await fx.signAs(ADMIN_ID);
    const allRawBodies = [];

    // ===== ① 三模块前缀 %编码变体全堵（核心回归） =====
    for (const p of PROBES) {
      // 明文直连
      let r = await rawGet(`/uploads/${p.mod}/${p.file}`, adminTok);
      allRawBodies.push(r.raw);
      check(`${p.mod} 明文直连 /uploads/${p.mod}/<file> → 403 DIRECT_ACCESS_FORBIDDEN`,
        r.status === 403 && r.body && r.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(r.body || r.raw));

      // %2D 连字符编码
      r = await rawGet(`/uploads/${p.encHyphen}/${p.file}`, adminTok);
      allRawBodies.push(r.raw);
      check(`${p.mod} %2D编码(连字符 ${p.encHyphen}) → 403 DIRECT_ACCESS_FORBIDDEN`,
        r.status === 403 && r.body && r.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(r.body || r.raw));

      // 首字母编码
      r = await rawGet(`/uploads/${p.encFirst}/${p.file}`, adminTok);
      allRawBodies.push(r.raw);
      check(`${p.mod} 首字母编码(${p.encFirst}) → 403 DIRECT_ACCESS_FORBIDDEN`,
        r.status === 403 && r.body && r.body.code === 'DIRECT_ACCESS_FORBIDDEN', JSON.stringify(r.body || r.raw));

      // %2F 分隔符编码（原始洞的核心变体：字面前缀 `/uploads/<模块>/` 检查在这里失效）。
      // 修复后先 decode 再 path.posix.normalize，%2F 解码为 / 后严格命中三前缀正则 → 严格 403
      // （codex 13 MED-1：早前放宽为 403/404 会让"落到 404"掩盖真绕过，归一修复后收紧为严格 403）。
      r = await rawGet(`/uploads/${p.mod}%2F${p.file}`, adminTok);
      allRawBodies.push(r.raw);
      check(`${p.mod} %2F编码(分隔符 ${p.mod}%2F<file>) → 严格 403 DIRECT_ACCESS_FORBIDDEN 且不泄漏原文`,
        r.status === 403 && r.body && r.body.code === 'DIRECT_ACCESS_FORBIDDEN' && !r.raw.includes(p.secret),
        `status=${r.status} bodyHead=${(r.raw || '').slice(0, 200)}`);
    }

    // 聚合断言：三模块 × 四变体共 12 次响应，没有任何一条泄漏了对应探针的 SECRET 内容
    const anyLeak = PROBES.some(p => allRawBodies.some(b => b.includes(p.secret)));
    check('聚合校验：三模块×四编码变体全部响应体均不含任一探针 SECRET 标记（无一变体泄漏原文）',
      !anyLeak, anyLeak ? '发现泄漏，见上方逐条明细' : '12 次响应均无泄漏');

    // ===== ⑤ 横切 / 文件系统别名类绕过全堵（codex 13 HIGH + codex 14 建议·realpath 容器归属回归）=====
    // guard 终态=realpath 容器归属（见 server.js:791 附近）：path.join(UPLOAD_DIR, decode) 解 \ 与 ./..
    // → realpath 再解 8.3/junction/大小写/尾点空格 → 判真实落盘是否落在三受限目录内。
    // 断言分两档（安全合同=「不泄漏」，非「一律 403」）：
    //   strict403 档（能解析到真实受限文件的规范/横切/别名路径）→ 严格 403 DIRECT_ACCESS_FORBIDDEN；
    //   noLeak 档（本平台解析不到真实文件的非规范 quirk：段尾点/空格、..%20）→ 允许 403 或 404，
    //     但绝不含 SECRET（realpath 解不到 → 词法回退 → send 也 404，两侧一致不泄漏；若某平台真能解析，
    //     realpath 会同步解析到受限目录 → 反而变 403，仍不泄漏——realpath 与 send 同源是本档安全性的根据）。
    const traversalBodies = [];
    const strict403 = (label, r, secret) => check(label,
      r.status === 403 && r.body && r.body.code === 'DIRECT_ACCESS_FORBIDDEN' && !r.raw.includes(secret),
      `status=${r.status} head=${(r.raw || '').slice(0, 120)}`);
    const noLeak = (label, r, secret) => check(label,
      (r.status === 403 || r.status === 404) && !r.raw.includes(secret),
      `status=${r.status} head=${(r.raw || '').slice(0, 120)}`);
    for (const p of PROBES) {
      const MOD_UC = p.mod.toUpperCase();
      // — strict403 档：真实受限文件可经这些路径解析到 —
      let r = await rawGet(`/uploads/${p.mod}%5C${p.file}`, adminTok); traversalBodies.push(r.raw);
      strict403(`${p.mod} 反斜杠分隔符 %5C → 403`, r, p.secret);
      r = await rawGet(`/uploads/collab%5C..%5C${p.mod}%5C${p.file}`, adminTok); traversalBodies.push(r.raw);
      strict403(`${p.mod} collab+..\\ 反斜杠横切 → 403`, r, p.secret);
      r = await rawGet(`/uploads/collab/../${p.mod}/${p.file}`, adminTok); traversalBodies.push(r.raw);
      strict403(`${p.mod} 纯正斜杠 ..横切 → 403`, r, p.secret);
      r = await rawGet(`/uploads/collab%2F..%2F${p.mod}%2F${p.file}`, adminTok); traversalBodies.push(r.raw);
      strict403(`${p.mod} %2F编码 ..横切 → 403`, r, p.secret);
      r = await rawGet(`/uploads/x/../${p.mod}/${p.file}`, adminTok); traversalBodies.push(r.raw); // codex 14 MED：任意前缀
      strict403(`${p.mod} 任意前缀 ..横切(x/../${p.mod}) → 403`, r, p.secret);
      r = await rawGet(`/uploads/${MOD_UC}/${p.file}`, adminTok); traversalBodies.push(r.raw); // codex 14 MED-1：8.3/大小写→realpath 归一
      strict403(`${p.mod} 大写目录名(${MOD_UC}·NTFS 不分大小写·realpath 归一) → 403`, r, p.secret);
      // — noLeak 档：本平台解析不到真实文件的非规范 quirk（不得泄漏，403/404 皆可）—
      r = await rawGet(`/uploads/${p.mod}./${p.file}`, adminTok); traversalBodies.push(r.raw);
      noLeak(`${p.mod} 段尾点(${p.mod}./<file>) → 403/404 不泄漏`, r, p.secret);
      r = await rawGet(`/uploads/${p.mod}%20/${p.file}`, adminTok); traversalBodies.push(r.raw);
      noLeak(`${p.mod} 段尾空格(${p.mod}%20/<file>) → 403/404 不泄漏`, r, p.secret);
      r = await rawGet(`/uploads/collab/..%20/${p.mod}/${p.file}`, adminTok); traversalBodies.push(r.raw); // codex 14 HIGH 主例
      noLeak(`${p.mod} ..%20 排序横切(collab/..%20/${p.mod}) → 403/404 不泄漏`, r, p.secret);
    }
    const anyTravLeak = PROBES.some(p => traversalBodies.some(b => b.includes(p.secret)));
    check('⑤聚合：反斜杠/正斜杠/%2F/任意前缀 ..横切 + 大写 + 段尾点/空格 + ..%20 共 27 变体全部响应体均不含 SECRET（无一泄漏）',
      !anyTravLeak, anyTravLeak ? '发现横切泄漏，见上方逐条明细' : '27 次横切响应均无泄漏');

    // ===== ⑥ realpath 核心价值实证 + codex 15 加固回归 =====
    // ⑥a junction/reparse 横切（codex 15 MED-4）：在公开 collab 下造一个指向受限 issue-lite 目录的
    //    junction，请求经 junction 落到受限文件——realpath 解 reparse 到真实 issue-lite → 必 403。
    //    这是"realpath 容器归属 > 词法正则"的核心价值实证（词法看 URL 串永远看不出 junction 指向）。
    if (jctReady) {
      let r6 = await rawGet(`/uploads/collab/${JCT_NAME}/${PROBES[0].file}`, adminTok);
      check('⑥a junction 横切(collab/<junction→issue-lite>/<file>) → 403 且不泄漏（realpath 解 reparse）',
        r6.status === 403 && r6.body && r6.body.code === 'DIRECT_ACCESS_FORBIDDEN' && !r6.raw.includes(PROBES[0].secret),
        `status=${r6.status} head=${(r6.raw || '').slice(0, 120)}`);
    } else {
      console.log('  ⓘ ⑥a junction 探针未就绪（mklink /J 创建失败·可能权限/文件系统限制）——本条不计入断言');
    }
    // ⑥b NUL/控制字符（codex 15 LOW）：%00 解码为 NUL，早前会进 path.join 抛错落 500——须 400 拦下。
    let r6b = await rawGet('/uploads/collab/%00', adminTok);
    check('⑥b NUL 字符 /uploads/collab/%00 → 400 BAD_PATH_ENCODING（不落 500·不进 path.join）',
      r6b.status === 400 && r6b.body && r6b.body.code === 'BAD_PATH_ENCODING', `status=${r6b.status} body=${JSON.stringify(r6b.body || r6b.raw)}`);
    r6b = await rawGet('/uploads/issue-lite/%01x', adminTok);
    check('⑥b 控制字符 %01 → 400 BAD_PATH_ENCODING',
      r6b.status === 400 && r6b.body && r6b.body.code === 'BAD_PATH_ENCODING', `status=${r6b.status}`);

    // ===== ② 畸形编码 → 400 BAD_PATH_ENCODING =====
    let r = await rawGet('/uploads/issue-lite/%ZZ', adminTok);
    check('畸形编码 /uploads/issue-lite/%ZZ → 400 BAD_PATH_ENCODING',
      r.status === 400 && r.body && r.body.code === 'BAD_PATH_ENCODING', JSON.stringify(r.body || r.raw));

    r = await rawGet('/uploads/%/x', adminTok);
    check('畸形编码 /uploads/%/x → 400 BAD_PATH_ENCODING',
      r.status === 400 && r.body && r.body.code === 'BAD_PATH_ENCODING', JSON.stringify(r.body || r.raw));

    // ===== ③ collab 老附件不被误拦（回归·防误伤）=====
    r = await rawGet('/uploads/collab/SEC_PROBE_COLLAB_TEST/probe.txt', adminTok);
    check('collab 探针明文直连 → 200（不属于三前缀正则，未被新中间件误拦）', r.status === 200, `status=${r.status}`);
    check('collab 探针响应体与写入内容逐字节一致（非误伤成 403/404 空壳）', r.raw === COLLAB_SECRET, `raw=${(r.raw || '').slice(0, 100)}`);

    // ===== ④ 可选加固：issue-lite 鉴权下载端点本身不受合并影响（只读，用真实非作废附件样本）=====
    const attRow = await dbGet(
      `SELECT a.id, a.file_name FROM issue_lite_attachments a
         JOIN issue_lite i ON a.issue_lite_id = i.id
        WHERE i.voided_at IS NULL
        ORDER BY a.id DESC LIMIT 1`
    );
    if (attRow) {
      // requireIssueLiteSchemaReady 挂在该端点上，schema 初始化独立于 /uploads guard 中间件的
      // 就绪时机（guard 是纯正则、server.listen 后即可用；issue-lite schema 走 db 回调链异步初始化，
      // 可能稍晚才绪）——本轮实测发现 waitReady() 只探测了 guard 中间件就绪就会偶发撞上 503
      // ISSUE_LITE_SCHEMA_NOT_READY 窗口。这条断言的判定目标是"下载端点不受本次 uploads 中间件
      // 合并影响"，不是"顺带验证 schema 初始化时序"，503 属于与被测改动无关的启动竞态噪音——短重试
      // 几次让 schema 就绪窗口过去，不满足才判红。
      let dl = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        dl = await fetch(`${BASE}/api/issue-lite/attachments/${attRow.id}/download`, { headers: { Authorization: `Bearer ${adminTok}` } });
        if (dl.status !== 503) break;
        await new Promise((res) => setTimeout(res, 300));
      }
      check(`④ issue-lite 鉴权下载端点（/api/issue-lite/attachments/${attRow.id}/download）不受 uploads 中间件合并影响 → 200`,
        dl.status === 200, `status=${dl.status} file_name=${attRow.file_name}`);
    } else {
      // codex 13 MED-2：无样本时早前 check(...,true) 会把"未测"算成 pass 虚增通过数——改为仅打印
      // NOTE、不计入断言（既不算 pass 也不算 fail），如实反映"这一路径本轮未覆盖"。
      console.log('  ⓘ ④ 未找到可用的非作废 issue-lite 附件真实样本（环境限制）——本条不计入断言（不虚增 pass）');
    }

  } catch (e) {
    check('e2e 执行异常', false, e.message + '\n' + (e.stack || ''));
  } finally {
    try { if (child) child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    killPort(TEST_PORT);

    // ===== 彻底清理：先删 junction（仅删链接·绝不递归进 target·issue-lite 内容不受影响）→ 探针文件 =====
    const cleanupErrors = [];
    try {
      // fs.rmdirSync 对 junction 只移除 reparse 链接本身，不递归 target；严禁用 rmSync({recursive:true})（会顺 junction 删掉 issue-lite）
      if (jctReady && junctionExists(JCT_PATH)) fs.rmdirSync(JCT_PATH);
    } catch (e) {
      cleanupErrors.push(`${JCT_PATH}(junction): ${e.message}`);
    }
    for (const filePath of createdFiles) {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) {
        cleanupErrors.push(`${filePath}: ${e.message}`);
      }
    }
    try {
      if (fs.existsSync(COLLAB_PROBE_DIR)) fs.rmdirSync(COLLAB_PROBE_DIR);
    } catch (e) {
      cleanupErrors.push(`${COLLAB_PROBE_DIR}(目录): ${e.message}`);
    }

    check('清理：全部探针文件删除过程无异常', cleanupErrors.length === 0, JSON.stringify(cleanupErrors));

    const stillExistFiles = createdFiles.filter(p => fs.existsSync(p));
    check('清理断言：探针文件在磁盘上均已不存在', stillExistFiles.length === 0, JSON.stringify(stillExistFiles));
    check('清理断言：collab 探针目录已不存在', !fs.existsSync(COLLAB_PROBE_DIR), COLLAB_PROBE_DIR);
    if (jctReady) {
      // junction 已移除，且 target（issue-lite 目录本身）未被误删——证明用的是 rmdirSync 只删链接不删 target
      check('清理断言：junction 探针已移除', !junctionExists(JCT_PATH), JCT_PATH);
      check('清理断言：junction target（issue-lite 目录）未被误删', fs.existsSync(JCT_TARGET), JCT_TARGET);
    }
  }

  console.log('─────── S-SEC /uploads 直连拦截 %编码绕过修复 回归验证结果 ───────');
  results.forEach(l => console.log(l));
  console.log(`\n总判定：${fail === 0 ? '✅ PASS' : '❌ FAIL'}（${pass} 通过 / ${fail} 失败，共 ${pass + fail} 条断言）`);

  // 本机实测踩坑（本次新发现，Windows + Node v24.11.1）：④ 用 fetch().arrayBuffer() 拉取一个
  // 真实二进制文件（issue-lite 鉴权下载端点）之后，紧接着 child.kill('SIGKILL') 杀掉服务子进程、
  // 再立即 process.exit() —— 这套时序会偶发触发 Node 底层原生断言崩溃
  // （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76`，
  // exit code 变成非常规值而非本脚本自己的判定结果）。二分定位：去掉二进制 fetch 步骤、或在
  // 杀子进程与 process.exit() 之间插入一段短延时，两种改法均可稳定消除复现（已用独立最小复现脚本
  // 反复验证）。这是 undici/fetch 消费二进制响应体的底层 socket handle 在被"立即跟进的
  // process.exit()"打断时的收尾竞态，与本脚本的业务断言逻辑无关（崩溃发生在所有 22 条断言已经
  // PASS 且结果已完整打印之后），但会污染进程退出码，误导只看 exit code 的调用方——留一段短延时
  // 让 undici 内部 socket/handle 完成收尾，再退出。
  await new Promise((resolve) => setTimeout(resolve, 500));
  process.exit(fail === 0 ? 0 : 1);
})();
