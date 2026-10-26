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
 *   ④ 可选加固：issue-lite 鉴权下载端点本身不受本次合并影响。
 *      [#106 S4c-C] 原先读真实库找「真实非作废附件样本」并只读验证（无样本时打 NOTE 不计入断言）；隔离实例里没有真实附件文件，
 *      改为脚本自己经 API 造样本：admin 建一张 issue-lite 登记单 → 上传一个带唯一标记的小文本附件 → 经鉴权下载端点取回，
 *      断言 200 且响应体与上传内容逐字节一致（比原先「只判 200」更强），样本在清理阶段经 API / 实例库删除并断言已不存在。
 *      [#106 S4c-2] 加 ④b：直连 `/uploads/<服务端 multer 实际写出的相对路径>` 断言 403 DIRECT_ACCESS_FORBIDDEN 且响应体不含样本内容（覆盖服务端真实命名写出的文件）。
 *      原「无样本 → NOTE」分支随之取消：样本由本脚本自造，造不出来就是失败（计 ④a 失败），不再静默跳过。
 *
 * harness 范式对齐 scripts/verify-legacy-archive-api.js（B 套 e2e）：
 * [#106 S4c-C] 不再自 spawn server.js（独立 TEST_PORT 3466）、不再读写真实库 task_pool.db、不再往检出里的 uploads 写探针文件、
 * 不再 netstat 杀端口：入口第一条副作用语句 `await testEnv.ready()` 自起临时隔离实例（或核对 TEST_* 变量组），
 * 探针文件 / junction 全部建在 **实例数据根下的 uploads**（<dataDir>/uploads，server.js 隔离模式的 UPLOAD_DIR）里，
 * 并在写入前核对每个路径都落在实例数据根之下（assertUnderDataDir）；原生 http.request 直发原始 path（不经 fetch/WHATWG URL 客户端归一化，测服务端真实解码行为）的做法不变，
 * 主机 / 端口取实例 baseUrl。
 *
 * 批跑须 exclusive：junction 探针建在 uploads 下的公开 collab 目录、指向受限 issue-lite 目录，变量组形态下实例被多个脚本共用时，
 * 不得与其他读写 uploads 的套件并行。
 *
 * 不改 server.js/任何生产代码，不 commit。finally 彻底清理全部探针文件 + 断言清理归零。
 *
 * 用法：node scripts/verify-uploads-guard.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const sqlite3 = require('sqlite3');
const testEnv = require('./lib/test-env');

const ADMIN_ID = 1; // admin

// 以下在 ready() 之后的入口里赋值（读 env() 在 ready 之前会抛 TE_NOT_READY）
let BASE = null;          // 实例 baseUrl（http://127.0.0.1:<port>）
let TARGET = null;        // new URL(BASE)
let DATA_DIR = null;      // 实例数据根
let DB_PATH = null;       // 实例库
let UPLOAD_DIR = null;    // <DATA_DIR>/uploads
let COLLAB_PROBE_DIR = null;
let COLLAB_PROBE_FILE = null;
let JCT_PATH = null;
let JCT_TARGET = null;

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
      { hostname: TARGET.hostname, port: Number(TARGET.port), path: rawPath, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} },
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

// 以 OPEN_READWRITE（不带 OPEN_CREATE）打开实例库做一条语句：等 close 回调再落定（关库错误不丢，语句错误优先）
// [#106 S4c 收口] 两个助手都带打开回调、不带 OPEN_CREATE（dbGet 用 OPEN_READONLY），与 _test-fixture.js 的 openInstanceDb 同源写法（本脚本只用 testEnv、不经 fx）
function dbRun(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE, (oe) => {
      if (oe) return reject(oe);
      db.configure('busyTimeout', 5000);
      db.run(sql, params || [], function onRun(err) {
        const changes = this && this.changes;
        db.close((ce) => { const e = err || ce; e ? reject(e) : resolve({ changes }); });
      });
    });
  });
}
function dbGet(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (oe) => {
      if (oe) return reject(oe);
      db.get(sql, params || [], (err, row) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(row); }); });
    });
  });
}
function dbAll(sql, params) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (oe) => {
      if (oe) return reject(oe);
      db.all(sql, params || [], (err, rows) => { db.close((ce) => { const e = err || ce; e ? reject(e) : resolve(rows); }); });
    });
  });
}

// 路径必须落在实例数据根之下（词法核对；这些路径都由 DATA_DIR 拼出，这里是写入前的硬门）：探针文件 / junction 绝不写到数据根之外
function assertUnderDataDir(p, what) {
  const rel = path.relative(path.resolve(DATA_DIR), path.resolve(p));
  const outside = rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel);
  if (outside) throw new Error(`${what}（${p}）不在实例数据根（${DATA_DIR}）之下，拒绝写入`);
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

const COLLAB_SECRET = 'COLLAB_PASS_THROUGH_OK_9f8e7d3a2b1c';

// ⑥a junction 探针：公开 collab 下造一个指向受限 issue-lite 目录的 junction（fs.symlinkSync 'junction'·无需管理员；原 mklink /J 同类型）
const JCT_NAME = 'SEC_PROBE_JUNCTION';
let jctReady = false;
// junction 存在性用 lstat（stat 链接本身·不跟随）——existsSync 会跟随 junction，target 被删的 broken
// junction 会误判为不存在而跳过清理留残留（codex 16 建议）。
function junctionExists(p) { try { fs.lstatSync(p); return true; } catch (_) { return false; } }

// ④ 自造样本（经 API 建单 + 上传）的句柄：清理阶段据此删除
const SAMPLE_CONTENT = 'UPLOADS_GUARD_SAMPLE_ATTACHMENT_9f8e7d3a2b1c';
const SAMPLE_NAME = 'SEC_PROBE_SAMPLE_ATTACHMENT.txt';
const sample = { issueId: null, attId: null, relFile: null };

// 返回失败项数（不在 helper 里 process.exit：由入口在 teardown 之后 finish）
async function main() {
  const createdFiles = [];

  try {
    // ===== 前置：造真实探针文件（全部在实例数据根下的 uploads 里）=====
    for (const p of PROBES) {
      const dir = path.join(UPLOAD_DIR, p.mod);
      assertUnderDataDir(dir, `探针目录 ${p.mod}`);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, p.file);
      assertUnderDataDir(filePath, `探针文件 ${p.file}`);
      fs.writeFileSync(filePath, p.secret, 'utf8');
      createdFiles.push(filePath);
      console.log(`[前置] 探针已造：${filePath}`);
    }
    assertUnderDataDir(COLLAB_PROBE_DIR, 'collab 探针目录');
    fs.mkdirSync(COLLAB_PROBE_DIR, { recursive: true });
    assertUnderDataDir(COLLAB_PROBE_FILE, 'collab 探针文件');
    fs.writeFileSync(COLLAB_PROBE_FILE, COLLAB_SECRET, 'utf8');
    createdFiles.push(COLLAB_PROBE_FILE);
    console.log(`[前置] collab 探针已造：${COLLAB_PROBE_FILE}`);

    // ⑥a junction 探针：collab\SEC_PROBE_JUNCTION → issue-lite 目录（junction，无需管理员；失败则跳过⑥a）
    try {
      assertUnderDataDir(JCT_PATH, 'junction 探针位置');
      assertUnderDataDir(JCT_TARGET, 'junction 探针目标');
      try { if (junctionExists(JCT_PATH)) fs.rmdirSync(JCT_PATH); } catch (_) { /* 残留清理（rmdirSync 对 junction 只删链接本身） */ }
      fs.symlinkSync(JCT_TARGET, JCT_PATH, 'junction');
      jctReady = junctionExists(JCT_PATH);
      console.log(`[前置] junction 探针已造：${JCT_PATH} → ${JCT_TARGET}（ready=${jctReady}）`);
    } catch (e) {
      jctReady = false;
      console.log(`[前置] junction 探针创建失败（跳过⑥a·非回归失败）：${e.message}`);
    }

    // ===== 测试服务就绪确认（服务由入口 ready() 起好；这里确认 guard 中间件即时可用）=====
    // 探测锚：guard 中间件是纯正则判定、不依赖任何模块 schema 就绪。用一个明文命中 issue-lite 前缀的探测路径
    // （不要求文件存在——guard 在 express.static 之前短路返回 403，与文件是否存在无关）双重确认：
    // 实例日志出现 `[instance] mode=isolated instance=<本实例身份> ` 启动行 + 该路径真的返回 403。
    // [#106 S4c-2] 原先读 info 级的 "Task Pool Server running"，会被检出 .env 的 LOG_LEVEL 压掉；`[instance]` 行是 server.js:22782 的 console.log，
    // 不受 LOG_LEVEL 影响，并且带本实例身份，顺带证明读的就是本实例的日志。
    const instanceId = testEnv.env().instance;
    let logHasInstanceLine = false;
    try {
      const logText = fs.readFileSync(path.join(DATA_DIR, 'server.log'), 'utf8');
      logHasInstanceLine = !!instanceId && logText.includes(`[instance] mode=isolated instance=${instanceId} `);
    } catch (_) { /* 读不到日志 → 就绪断言判红 */ }
    let probeStatus = null;
    try { probeStatus = (await fetch(`${BASE}/uploads/issue-lite/__readiness_probe__`)).status; } catch (_) { /* 判红 */ }
    const ready = logHasInstanceLine && probeStatus === 403;
    check('测试服务已就绪（[instance] 启动行 + guard 中间件即时可用）', ready, `logHasInstanceLine=${logHasInstanceLine} instance=${instanceId} probeStatus=${probeStatus}`);
    if (!ready) throw new Error('服务未就绪（日志无本实例的 [instance] 启动行或 guard 探测不是 403）');

    const adminTok = await testEnv.signToken(ADMIN_ID);
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
      console.log('  ⓘ ⑥a junction 探针未就绪（junction 创建失败·可能权限/文件系统限制）——本条不计入断言');
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

    // ===== ④ 可选加固：issue-lite 鉴权下载端点本身不受合并影响（自造样本：建单 + 上传，再经鉴权端点下载）=====
    // 原先读真实库找「真实非作废附件样本」；隔离实例里没有真实附件文件，改为本脚本自造样本（见文件头 ④ 说明）。
    // 样本建在 uploads/issue-lite（受限目录）里，正是被 guard 拦直连、只允许鉴权端点读取的那类文件。
    const mk = await fetch(`${BASE}/api/issue-lite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminTok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'uploads-guard 自造样本单（测后清理）', requester_name: 'UG样本', requester_dept: '信息技术部', requester_phone: '13800000000' }),
    });
    const mkBody = await mk.json().catch(() => null);
    sample.issueId = mkBody && mkBody.issue && Number.isInteger(mkBody.issue.id) ? mkBody.issue.id : null;
    let upStatus = null;
    if (sample.issueId) {
      const fd = new FormData();
      fd.append('files', new Blob([Buffer.from(SAMPLE_CONTENT, 'utf8')], { type: 'text/plain' }), SAMPLE_NAME);
      const up = await fetch(`${BASE}/api/issue-lite/${sample.issueId}/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${adminTok}` }, body: fd });
      upStatus = up.status;
      const upBody = await up.json().catch(() => null);
      sample.attId = upBody && upBody.attachment && Number.isInteger(upBody.attachment.id) ? upBody.attachment.id : null;
    }
    check('④a 自造样本：建 issue-lite 登记单 + 上传附件成功（取得单 id 与附件 id）',
      !!sample.issueId && !!sample.attId, `建单 status=${mk.status} issueId=${sample.issueId} 上传 status=${upStatus} attId=${sample.attId}`);
    if (sample.attId) {
      const att = await dbGet('SELECT file_name FROM issue_lite_attachments WHERE id = ?', [sample.attId]);
      sample.relFile = att && att.file_name ? att.file_name : null;   // 形如 issue-lite/<id>_<ts>_<rand>_<name>，清理阶段据此核对物理文件已删
      const dl = await fetch(`${BASE}/api/issue-lite/attachments/${sample.attId}/download`, { headers: { Authorization: `Bearer ${adminTok}` } });
      const dlText = Buffer.from(await dl.arrayBuffer()).toString('utf8');
      check(`④ issue-lite 鉴权下载端点（/api/issue-lite/attachments/${sample.attId}/download）不受 uploads 中间件合并影响 → 200 且响应体与上传内容逐字节一致`,
        dl.status === 200 && dlText === SAMPLE_CONTENT, `status=${dl.status} bodyHead=${dlText.slice(0, 80)}`);
      // ④b 直连自造样本（服务端 multer 实际写出的相对路径，覆盖「服务端真实命名写出的文件」，而不只是脚本手造的探针文件）：guard 必须拦成 403 且不吐原文
      const rd = sample.relFile ? await rawGet(`/uploads/${sample.relFile}`, adminTok) : null;
      check(`④b 直连服务端真实写出的样本文件 /uploads/${sample.relFile} → 403 DIRECT_ACCESS_FORBIDDEN 且响应体不含样本内容`,
        !!rd && rd.status === 403 && !!rd.body && rd.body.code === 'DIRECT_ACCESS_FORBIDDEN' && !rd.raw.includes(SAMPLE_CONTENT),
        rd ? `status=${rd.status} head=${(rd.raw || '').slice(0, 120)}` : '库里取不到附件的 file_name（relFile 为空），无法直连');
    }

  } catch (e) {
    check('e2e 执行异常', false, e.message + '\n' + (e.stack || ''));
  } finally {
    // ===== 彻底清理：先删 junction（仅删链接·绝不递归进 target·issue-lite 内容不受影响）→ 探针文件 → 自造样本 =====
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
    // ④ 自造样本清理（[#106 S4c-2 收口] 按 issueId 查该单**全部**附件的 id 与 file_name，逐个经 API 删并核物理文件，不再只认 sample.attId / sample.relFile：
    //   上传已落库落盘但响应读取失败时 attId / relFile 为空，旧写法会直接删附件行、丢掉文件清理依据，物理文件成孤儿且断言照样通过）。
    //   顺序：先查（失败 → 计清理失败，且不删任何行）→ 逐个 API 删附件 → 核每个物理文件不存在 → 全部确定后才删附件行 / 编辑日志 / 登记单行；
    //   任一步没做到都计入清理失败，行留着作为现场依据。物理文件检查必须明确通过：physOk 只有「每个附件的路径都确定且文件都已不存在」才为 true，null / 未检查一律不算通过。
    const sampleResult = { queried: false, atts: [], undetermined: [], apiFailed: [], filesLeft: [], rowsLeft: null, issueLeft: null, physOk: null };
    if (sample.issueId || sample.attId || sample.relFile) {
      try {
        if (!sample.issueId) throw new Error(`已知附件 #${sample.attId} / ${sample.relFile} 但不知道所属登记单 id，无法按单查全部附件，需人工核实实例 uploads/issue-lite`);
        const rows = await dbAll('SELECT id, file_name FROM issue_lite_attachments WHERE issue_lite_id = ?', [sample.issueId]);
        sampleResult.queried = true;
        const tok = await testEnv.signToken(ADMIN_ID);
        const filePaths = [];   // 待核对不存在的物理文件（绝对路径）
        for (const a of rows) {
          if (!a.file_name || typeof a.file_name !== 'string') { sampleResult.undetermined.push(a.id); continue; }   // 无法确定文件路径：计失败
          const full = path.join(UPLOAD_DIR, a.file_name);
          assertUnderDataDir(full, `附件 #${a.id} 的物理文件`);
          filePaths.push({ id: a.id, full });
          const del = await fetch(`${BASE}/api/issue-lite/attachments/${a.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
          if (del.status !== 200) sampleResult.apiFailed.push(`#${a.id}→${del.status}`);
        }
        // 已知但不在行里的 relFile（行已被别处删掉的异常形态）也核一遍
        if (sample.relFile && !filePaths.some((p) => p.full === path.join(UPLOAD_DIR, sample.relFile))) {
          const full = path.join(UPLOAD_DIR, sample.relFile);
          assertUnderDataDir(full, '样本物理文件 relFile');
          filePaths.push({ id: null, full });
        }
        sampleResult.atts = filePaths;
        sampleResult.filesLeft = filePaths.filter((p) => fs.existsSync(p.full)).map((p) => p.full);
        sampleResult.physOk = sampleResult.undetermined.length === 0 && sampleResult.apiFailed.length === 0 && sampleResult.filesLeft.length === 0;
        if (sampleResult.physOk) {
          // 清理依据齐全且文件都确认不存在了，才删行（编辑日志 → 附件行 → 登记单）
          await dbRun('DELETE FROM issue_lite_edit_logs WHERE issue_lite_id = ?', [sample.issueId]);
          await dbRun('DELETE FROM issue_lite_attachments WHERE issue_lite_id = ?', [sample.issueId]);
          await dbRun('DELETE FROM issue_lite WHERE id = ?', [sample.issueId]);
        } else {
          cleanupErrors.push(`自造样本清理未完成（行保留作现场依据）：无法确定路径的附件 ${JSON.stringify(sampleResult.undetermined)}；API 删除失败 ${JSON.stringify(sampleResult.apiFailed)}；仍存在的物理文件 ${JSON.stringify(sampleResult.filesLeft)}`);
        }
      } catch (e) {
        cleanupErrors.push(`自造样本清理: ${e.message}`);
      }
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
    if (sample.issueId || sample.attId || sample.relFile) {
      // 行残留：按单查剩余附件行数与登记单行（查询失败 → 不是明确通过）；物理文件：sampleResult.physOk 必须严格为 true（null 不算通过）
      try {
        const left = sample.issueId ? await dbGet('SELECT COUNT(*) AS c FROM issue_lite_attachments WHERE issue_lite_id = ?', [sample.issueId]) : null;
        const iss = sample.issueId ? await dbGet('SELECT id FROM issue_lite WHERE id = ?', [sample.issueId]) : null;
        sampleResult.rowsLeft = left ? left.c : null;
        sampleResult.issueLeft = sample.issueId ? !!iss : null;
      } catch (e) { sampleResult.rowsLeft = `查询失败：${e.message}`; }
      check('清理断言：④ 自造样本（该单全部附件行 / 登记单行 / 物理文件）均已不存在，且路径均已确定、API 删除成功',
        sampleResult.queried === true && sampleResult.physOk === true && sampleResult.rowsLeft === 0 && sampleResult.issueLeft === false,
        JSON.stringify({ queried: sampleResult.queried, physOk: sampleResult.physOk, rowsLeft: sampleResult.rowsLeft, issueLeft: sampleResult.issueLeft, undetermined: sampleResult.undetermined, apiFailed: sampleResult.apiFailed, filesLeft: sampleResult.filesLeft }));
    }
  }

  console.log('─────── S-SEC /uploads 直连拦截 %编码绕过修复 回归验证结果 ───────');
  results.forEach(l => console.log(l));
  console.log(`\n总判定：${fail === 0 ? '✅ PASS' : '❌ FAIL'}（${pass} 通过 / ${fail} 失败，共 ${pass + fail} 条断言）`);
  // 原先这里有一段 500ms 延时：④ 用 fetch().arrayBuffer() 拉二进制后紧接 kill 子进程 + process.exit() 会偶发触发
  // Node 底层原生断言崩溃（libuv UV_HANDLE_CLOSING，Windows + Node v24）。现在收尾改走入口的 teardown → finish(code)
  // （只设退出码、不立刻 process.exit，见 lib/test-env.js finish），不再需要手写延时。
  return fail;
}

(async () => {
  // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
  // 就绪断言读的是不受 LOG_LEVEL 影响的 `[instance]` 启动行，本文件没有其它依赖 info 级日志的断言，所以不传 extraEnv.LOG_LEVEL
  await testEnv.ready();   // 先于任何写文件 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
  let code = 1;
  try {
    const e = testEnv.env();
    BASE = e.baseUrl;
    TARGET = new URL(BASE);
    DB_PATH = e.dbPath;
    DATA_DIR = e.dataDir;
    if (!DATA_DIR) throw new Error('取不到实例数据根（env().dataDir 为 null）：无法确定实例的 uploads 目录，探针文件无处安全落盘，拒绝继续');
    UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
    COLLAB_PROBE_DIR = path.join(UPLOAD_DIR, 'collab', 'SEC_PROBE_COLLAB_TEST');
    COLLAB_PROBE_FILE = path.join(COLLAB_PROBE_DIR, 'probe.txt');
    JCT_PATH = path.join(UPLOAD_DIR, 'collab', JCT_NAME);
    JCT_TARGET = path.join(UPLOAD_DIR, 'issue-lite');
    const nFailed = await main();
    code = nFailed > 0 ? 1 : 0;
  } catch (e) {
    console.error('uploads-guard verify 异常：', e && e.stack || e);
  } finally {
    try { await testEnv.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
  }
  testEnv.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
  console.error('uploads-guard verify 启动失败：', e && e.stack || e);
  try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
  process.exit(1);
});
