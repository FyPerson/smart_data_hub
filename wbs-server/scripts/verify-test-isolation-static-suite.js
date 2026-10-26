/**
 * #106 S4a 自检：全目录静态守卫 verify-test-isolation-static.js（独立入口，已登记为 FAMILY 成员；守卫本体登记在 GUARDS）。
 *
 * 全部用内存里的合成文件集合 + 合成登记表跑守卫的纯评估函数 evaluate（不读真实仓库的被测脚本）。另有：
 *   · 一组对真实工作树的只读端到端（S.15）；
 *   · 基线写入类用例（--init-baseline / --shrink-baseline）与「真跑守卫核心」用例：在 os.tmpdir() 下的私有临时目录 / 临时 git 仓库里做，只用 unlink / rmdir 清理（不用 rmSync）。
 * 每条反例断言的是「命中的恰是预期的文件 + 类 + 规则代号」（整组问题签名全等），不是只断言红；表驱动的枚举项（密钥变量、测试变量、禁用前缀）逐项断言完整签名。
 *
 * 威胁模型同守卫头注释：静态守卫是第二道防线，目标是「诚实开发者常见的写法必须判红」，刻意绕过登记为残余。
 * 登记在守卫头注释、不补用例的项：FAMILY 成员集合恒空（被 EXEMPT 前缀检查兜底）、dropSourceReadR3 的「对不上就不滤」分支（正常源码走不到）、拆掉基线解析失败判红后落到 MISSING / FORMAT 层仍红。
 * 修复批 3 的覆盖：命令串两档适用范围 + 左右边界逐字符（S.30）· 真实密钥补充形态（S.31）· 字面量 import() 的 T4（S.32）· 工作树 lstat 前提含真 junction（S.33）· SR 门的 node: / import() 模块识别（S.34）·
 *   候选基线完整校验的三条路径（S.35 与 S.10）· 真实命令行接线（临时 git 仓库：S.11g–S.11o，含换入 NOTATHEAD、SPARSE、init 的 HEAD 树硬门（git ls-tree）与 fail-closed、git log 失败、lstat 接线；S.11l / S.11p 是 headTreeHasBaseline 的纯函数用例）· FINISH_NOT_LAST 的祖先检查与逐层尾部判定（S.28c–S.28g；S.28d 的五种循环样本都是「finish; return;」，不依赖尾部判定）。
 * S4b2b：SELF_ISOLATED 登记类（S.36–S.44：sink 形态 F1 / F2（恰 3 个实参）/ F3（种子脚本名须在扫描集合里）成对用例 · child_process 绑定形态 BINDING（S.44） · T3 窄豁免 · Tier-1 硬门 · 过期 / 理由 / 缺键 · 与 EXEMPT / INFRA / SOURCE_READERS / 基线互斥 · 与 MIGRATED 并存 · 缩表）
 *   与真实登记表 / 基线的全等断言（S.16f / S.16g / S.15；S4b2b 当时的数字是 MIGRATED 27、基线 126，现行值见下一行）。
 * S4c：MIGRATED 追加 31 个、基线缩表 126 → 93 后，S.16a / S.16e / S.16g / S.15 的全等值改为 MIGRATED 58（并集 125）、基线 93；SELF_ISOLATED 仍 5。
 * S4d-1：MIGRATED 追加 17 个、基线缩表 93 → 76 后，同四处改为 MIGRATED 75（并集 142）、基线 76。
 * S4d-2：MIGRATED 追加 15 个（独立写出的 S4D2 名单，不读登记表）、基线缩表 76 → 61（--shrink-baseline 删掉的恰是这 15 个）后，同四处改为 MIGRATED 90（并集 157）、基线 61。
 * S4d-3：MIGRATED 追加 11 个（独立写出的 S4D3 名单）、基线缩表 61 → 50（删掉的恰是这 11 个）后，同四处改为 MIGRATED 101（并集 168）、基线 50。
 * S4d-4：MIGRATED 追加 12 个（独立写出的 S4D4 名单）、基线缩表 50 → 38（删掉的恰是这 12 个）后，同四处改为 MIGRATED 113（并集 180）、基线 38。
 * S4d-5：MIGRATED 追加 10 个（独立写出的 S4D5 名单）、基线缩表 38 → 28（删掉的恰是这 10 个）后，同四处改为 MIGRATED 123（并集 190）、基线 28。
 * S4e-1：verify-sys-derive-numbering / verify-sys-migrate-config-release-check 两个脚本改掉写死的 3000 与业务库文件名字面量（零命中，不入任何登记类）、verify-model-impl-verify 登记 SELF_ISOLATED；基线缩表 28 → 25（独立写出的 S4E1 名单，S.16h）后，S.16f / S.16g / S.15 改为 SELF_ISOLATED 6、基线 25（MIGRATED 123 / 并集 190 不变）。
 * S4e-4：D2 六个脚本的真实库只读探针改为 `--real-db <路径>` 显式开关（默认跳过；零命中，commit-cols / fastlane-submit / fastrelease-auth / release-overdue / statistics-efficiency 不入任何登记类，readonly-leader 仍只在 SOURCE_READERS）；
 *   D5 删 3 个（attach-archive-mutations / correction-datafix-migration / test-new-dual-dialect）、改名 2 个为 probe-*（登记 EXEMPT）；基线缩表 25 → 14（独立写出的 S4E4 名单与 14 个剩余名单，S.16i）后，S.16a / S.16g / S.15 改为 EXEMPT 50（并集 192）、基线 14（MIGRATED 123 / SELF_ISOLATED 6 不变）。
 * S5（W9）：6 月数据修正搬家的 5 个一次性脚本（apply-routes-corrections / build-routes-corrections / probe-correction-external-refs / probe-correction-suspects / probe-correction-symbols）移入 scripts/_archive/（不在扫描集合），删掉它们的 EXEMPT 条目；S.16a / S.15 改为 EXEMPT 45（并集 187）、其余不变。
 * S6b：MIGRATED 追加 1 个（独立写出的 S6B 名单：verify-html-fingerprint-e2e.js，页面缓存串注入的实例级检查）；S.16a / S.16e / S.15 改为 MIGRATED 124（并集 188）、其余不变。
 * S7：INFRA 追加 1 个（verify-lines-merge.js，line merge 自检）；S.16a / S.16b / S.15 改为 INFRA 20（并集 189）、其余不变。
 * S5 修复批：扫描前提新增 ARCHIVE 门（_archive/ 下 .js 不得 verify- / test- / smoke- 命名、前 10 行须含「历史工具，不再运行」、git 失败 / 无法解析 / 读不到判红），自检 S.45a–S.45k；OK 行字段不变。
 * 收口小批：blob 读取器返回值非法（S.22h）· 只靠文件级判据的模板串命令 / 嵌套在 sink 实参子树里的命令串（S.30u / S.30v）· 环境变量解构的声明 / 赋值 / 参数默认值三种语法（S.31e / S.31f）。
 *
 * 参数：--guard-dir=<目录>（变异自证用：目录里有 verify-test-isolation-static.js 与 lib/test-script-guard.js 的副本；默认取本文件所在目录；端到端 S.15 与「自身干净」S.17 只在默认目录下跑）。
 * 输出：每条断言一行 `CHECK <编号> PASS|FAIL <标题>`；末行 `verify-test-isolation-static-suite PASS=<n> FAIL=<n>`；退出码 0 = 全绿。
 *
 * 本文件自己也是全目录守卫的扫描对象（未登记类，Tier-1 必须零命中）：所以合成源码里会触发规则的片段一律用 cat() 拼接，不在本文件里出现整串字面量。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { TEST_VAR_NAMES } = require('./lib/test-batch');

const args = process.argv.slice(2);
const argVal = (p) => { const a = args.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : null; };
const GUARD_DIR = argVal('--guard-dir=') ? path.resolve(argVal('--guard-dir=')) : path.resolve(__dirname);
const IS_REAL = GUARD_DIR === path.resolve(__dirname);
const G = require(path.join(GUARD_DIR, 'verify-test-isolation-static.js'));
const L = require(path.join(GUARD_DIR, 'lib', 'test-script-guard.js'));
const REAL_REG = require('./lib/test-isolation-registry');

let pass = 0;
let fail = 0;
function check(id, title, ok, detail) {
    if (ok) { pass += 1; console.log(`CHECK ${id} PASS ${title}`); return; }
    fail += 1;
    console.log(`CHECK ${id} FAIL ${title}`);
    if (detail !== undefined) console.log(`         ${JSON.stringify(detail).slice(0, 900)}`);
}

// ---------------------------------------------------------------- 合成源码（触发规则的片段用 cat 拼接）
const cat = (...p) => p.join('');
const join = (...l) => `${l.join('\n')}\n`;
const N3K = cat('30', '00');
const URL3K = cat('http://localhost:', N3K);
const SJS = cat('server', '.js');
const DOTENV_PATH = cat('.', 'en', 'v');
const RD_REASON = cat('只读 ', SJS, ' 源码做静态断言，不启动服务');   // SOURCE_READERS 登记理由（本文件 require 了 child_process：说明文字里不能出现整串入口名，否则 T3）
const FX_REQ_LINE = "const fx = require('./_test-fixture');\n";
const READY_LINE = '  await fx.ready();\n';
const afterReady = (src, line) => src.replace(READY_LINE, cat(READY_LINE, '  ', line, '\n'));
const afterFx = (src, line) => src.replace(FX_REQ_LINE, cat(FX_REQ_LINE, line, '\n'));
const CATCH_TAIL = '})().catch((e) => { console.error(e); process.exit(1); });';
const SRC = {
    clean: 'module.exports = 1;\n',
    t1Url: cat("const BASE = '", URL3K, "';\n"),
    t1Port: cat('const PORT = ', N3K, ';\n'),
    t1Tpl: cat('const u = `http://127.0.0.1:', N3K, '/api`;\n'),
    t2Db: cat("const p = require('path').join(__dirname, '..', 'task_pool", ".db');\n"),
    t2Env: cat("require('dot", "env').config();\n"),
    t2Jwt: cat('const s = process.env.', 'JWT_SECRET;\n'),
    t3: cat("const { spawn } = require('child_process');\nconst c = spawn('node', ['", SJS, "']);\n"),
    t3Join: cat("const p = require('path').join(__dirname, '..', '", SJS, "');\n"),
    t4Fx: "const fx = require('./_test-fixture');\n",
    t4Te: "const te = require('./lib/test-env');\n",
    t5Dot: 'const u = process.env.TEST_BASE_URL;\n',
    t5Bracket: "const d = process.env['test_db_path'];\n",
    t5Destr: 'const { TEST_JWT_SECRET: s } = process.env;\n',
    // 纯进程内脚本：只用 :memory:，3000 只作为毫秒数出现（对照组）
    memOnly: join("'use strict';", "const sqlite3 = require('sqlite3');", "const db = new sqlite3.Database(':memory:');", cat('setTimeout(() => { db.close(); }, ', N3K, ');'), cat('const T = { timeout: ', N3K, ', other: 13000 };')),
    // 已迁移形态正确的脚本（teardown + exit）与两个只有一种收尾的合法对照
    good: join("'use strict';", FX_REQ_LINE.trim(), '(async () => {', '  await fx.ready();', '  await fx.teardown();', '  process.exit(0);', CATCH_TAIL),
    goodTd: join("'use strict';", FX_REQ_LINE.trim(), '(async () => {', '  await fx.ready();', '  await fx.teardown();', CATCH_TAIL),
    goodExit: join("'use strict';", FX_REQ_LINE.trim(), '(async () => {', '  await fx.ready();', '  process.exit(0);', CATCH_TAIL),
    readyAfterSign: join("'use strict';", FX_REQ_LINE.trim(), '(async () => {', '  const t = await fx.signAs(fx.ADMIN_ID);', '  await fx.ready();', '  await fx.teardown();', '  process.exit(0);', CATCH_TAIL),
    noCloser: join("'use strict';", FX_REQ_LINE.trim(), '(async () => {', '  await fx.ready();', CATCH_TAIL),
    noReady: join("'use strict';", '(async () => {', '  process.exit(0);', CATCH_TAIL),
};
SRC.goodPlus3000 = cat(SRC.good, "const __LEGACY_BASE = '", URL3K, "';\n");
SRC.t1t2 = cat(SRC.t1Url, SRC.t2Db);
SRC.t1t3 = cat(SRC.t1Url, SRC.t3);
// T3 拆两半 / SOURCE_READERS 用：sink 内（spawn 的实参）与 sink 外（路径拼接、赋值）两种 server.js 字面量
SRC.readOut = cat("const path = require('path');\nconst p = path.join(__dirname, '..', '", SJS, "');\nmodule.exports = p;\n");
SRC.readBoth = cat(SRC.t3, "const p = require('path').join(__dirname, '..', '", SJS, "');\n");
SRC.migOut = afterFx(SRC.good, cat("const SERVER_FILE = '", SJS, "';"));
SRC.migIn = afterReady(SRC.good, cat("require('child_process').spawn('node', ['", SJS, "']);"));
SRC.migT5 = afterFx(SRC.good, 'const DIRECT = process.env.TEST_BASE_URL;');
// 起主服务的常见写法（A）：每种一份未登记样本；cmd = 命令串，tpl = 模板串，req = require 类，sinkWord = sink 实参里的 'server'
SRC.cmdExec = cat("const cp = require('child_process');\ncp.exec('node ", SJS, "', { cwd: __dirname });\n");
SRC.cmdSpawnShell = cat("const cp = require('child_process');\ncp.spawn('node ", SJS, " --port 0', { shell: true });\n");
SRC.tplSpawn = cat("const { spawn } = require('child_process');\nconst ROOT = __dirname;\nspawn(process.execPath, [`${ROOT}/", SJS, "`]);\n");
SRC.tplOut = cat('const ROOT = __dirname;\nmodule.exports = `${ROOT}/', SJS, '`;\n');
SRC.reqNoExt = "require('../server');\n";
SRC.reqJoin = "require(require('path').join(__dirname, '..', 'server'));\n";
SRC.reqResolve = "const cp = require('child_process');\ncp.fork(require.resolve('../server'));\n";
SRC.reqExt = cat("require('../", SJS, "');\n");
SRC.reqImport = "import('../server');\n";
SRC.sinkWord = "const { spawn } = require('child_process');\nspawn(process.execPath, ['server']);\n";
SRC.realC7 = "const path = require('path');\nrequire(path.join(__dirname, '..', 'server'));\n";   // test-issue-c7-notify-e2e.js:66 的形态
SRC.gitAddDot = "const { spawnSync } = require('child_process');\nspawnSync('git', ['add', '.']);\n";
// F：listen(3000)
SRC.listenLit = cat("require('http').createServer(() => {}).listen(", N3K, ');\n');
SRC.listenConst = cat('const P = ', N3K, ";\nrequire('http').createServer().listen(P);\n");
SRC.listenOk = "require('http').createServer().listen(31000);\n";
// G：T2 补充形态
SRC.loadEnvFile = 'process.loadEnvFile();\n';
SRC.envPathLit = cat("require('fs').readFileSync(require('path').join(__dirname, '..', '", DOTENV_PATH, "'), 'utf8');\n");
const secretForms = (name) => ({
    dot: cat('const s = process.env.', name, ';\n'),
    bracket: cat("const s = process.env['", name, "'];\n"),
    destr: cat('const { ', name, ' } = process.env;\n'),
    destrAlias: cat('const { ', name, ': k } = process.env;\n'),
});

// ---------------------------------------------------------------- 评估助手
const EMPTY_BASELINE = Object.freeze({ createdAt: 'x', createdAtHead: 'h', maxEntries: 0, entries: {} });
const emptyReg = () => ({ MIGRATED: {}, EXEMPT_NO_READY: {}, EXEMPT: {}, INFRA: {}, SOURCE_READERS: {}, SELF_ISOLATED: {}, DB_PATH_ASSERTERS: {} });
function ev(files, o) {
    const op = o || {};
    const reg = { MIGRATED: op.mig || {}, EXEMPT_NO_READY: op.noReady || {}, EXEMPT: op.exempt || {}, INFRA: op.infra || {}, SOURCE_READERS: op.readers || {}, SELF_ISOLATED: op.selfIso || {}, DB_PATH_ASSERTERS: op.asserters || {} };
    return G.evaluate({
        files: Object.keys(files).concat(op.extraFiles || []),
        read: (n) => { if (!Object.prototype.hasOwnProperty.call(files, n)) throw new Error(`no such file ${n}`); return files[n]; },
        registry: reg,
        baseline: op.baseline === undefined ? EMPTY_BASELINE : op.baseline,
        familyNames: new Set(op.family || []),
        infraAllowed: op.infraAllowed,
        scanProblems: op.scanProblems,
        blobAt: op.blobAt,
    }, op.mode);
}
/** 问题签名：文件|类|规则，排序后逗号连接——整组全等才算「命中的恰是预期」 */
const sig = (r) => r.problems.map((p) => `${p.file}|${p.cls}|${p.rule}`).sort().join(',');
const want = (...s) => s.slice().sort().join(',');
const bl = (entries, max) => ({ createdAt: 'T0', createdAtHead: 'H0', maxEntries: max === undefined ? Object.keys(entries).length : max, entries });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const MIG = { 'm.js': {} };
const one = (code, file) => want(`${file}|OTHER|${code}`);

function sectionCounterexamples() {
    // S.1 方案反例 1 的全目录形态：未登记的新文件写死 3000 → T1
    const r1 = ev({ 'new-a.js': SRC.t1Url, 'new-b.js': SRC.t1Port, 'new-c.js': SRC.t1Tpl });
    check('S.1', '反例：未登记的新文件写死 3000（URL 字符串 / PORT 常量 / 模板串）→ 恰判红 T1，每个文件各一条', sig(r1) === want('new-a.js|OTHER|T1', 'new-b.js|OTHER|T1', 'new-c.js|OTHER|T1'), sig(r1));
    // S.2
    const r2a = ev({ 'new-db.js': SRC.t2Db });
    const r2b = ev({ 'new-env.js': SRC.t2Env });
    const r2c = ev({ 'new-jwt.js': SRC.t2Jwt });
    check('S.2a', '反例：未登记的新文件含真实库路径字面量 → 恰判红 T2', sig(r2a) === one('T2', 'new-db.js'), sig(r2a));
    check('S.2b', '反例：未登记的新文件加载 dot-env 库 → 恰判红 T2', sig(r2b) === one('T2', 'new-env.js'), sig(r2b));
    check('S.2c', '反例：未登记的新文件读 process.env 上的 JWT 密钥变量 → 恰判红 T2', sig(r2c) === one('T2', 'new-jwt.js'), sig(r2c));
    // 文本形态：字符串字面量里写出整串 process.env.<密钥>（与分析器 R2 的文本正则同口径；AST 看不到字符串内容，只有这条文本正则兜它）
    const r2d = ['JWT_SECRET', 'DB_ENCRYPTION_KEY'].map((nm) => ({ nm, sg: sig(ev({ 'new-hint.js': cat("const HINT = 'set process.env.", nm, " first';\n") })) })).filter((x) => x.sg !== one('T2', 'new-hint.js'));
    check('S.2d', '反例：字符串字面量里写出整串 process.env.<密钥变量>（JWT_SECRET / DB_ENCRYPTION_KEY，文本形态，与分析器 R2 同口径）→ 恰判红 T2', r2d.length === 0, r2d);
    // S.3
    const r3a = ev({ 'new-spawn.js': SRC.t3 });
    const r3b = ev({ 'new-join.js': SRC.t3Join });
    check('S.3', '反例：未登记的新文件 spawn / 拼出主服务入口文件路径 → 恰判红 T3', sig(r3a) === one('T3', 'new-spawn.js') && sig(r3b) === one('T3', 'new-join.js'), { a: sig(r3a), b: sig(r3b) });
    // S.4
    const r4a = ev({ 'new-fx.js': SRC.t4Fx });
    const r4b = ev({ 'new-te.js': SRC.t4Te });
    check('S.4a', '反例：未登记的新文件 require 了夹具（不在 MIGRATED）→ 恰判红 T4', sig(r4a) === one('T4', 'new-fx.js'), sig(r4a));
    check('S.4b', '反例：未登记的新文件 require 了 ./lib/test-env（不在 MIGRATED）→ 恰判红 T4', sig(r4b) === one('T4', 'new-te.js'), sig(r4b));
    // S.5
    const r5a = ev({ 'new-v1.js': SRC.t5Dot });
    const r5b = ev({ 'new-v2.js': SRC.t5Bracket });
    const r5c = ev({ 'new-v3.js': SRC.t5Destr });
    check('S.5a', '反例：未登记的新文件直接读 process.env.TEST_BASE_URL → 恰判红 T5', sig(r5a) === one('T5', 'new-v1.js'), sig(r5a));
    check('S.5b', "反例：未登记的新文件读 process.env['test_db_path']（方括号 + 小写）→ 恰判红 T5", sig(r5b) === one('T5', 'new-v2.js'), sig(r5b));
    check('S.5c', '反例：未登记的新文件从 process.env 解构 TEST_JWT_SECRET → 恰判红 T5', sig(r5c) === one('T5', 'new-v3.js'), sig(r5c));
    // S.6
    const r6a = ev({ 'm.js': SRC.readyAfterSign }, { mig: MIG });
    const r6b = ev({ 'm.js': SRC.goodPlus3000 }, { mig: MIG });
    const r6c = ev({ 'm.js': SRC.noCloser }, { mig: MIG });
    const r6d = ev({ 'm.js': SRC.noReady }, { mig: MIG });
    check('S.6a', '反例：已迁移文件把 await fx.ready() 挪到 signAs 之后 → 恰判红 R5', sig(r6a) === want('m.js|MIGRATED|R5'), sig(r6a));
    check('S.6b', '反例：已迁移文件注入写死 3000 → 恰判红 R1', sig(r6b) === want('m.js|MIGRATED|R1'), sig(r6b));
    check('S.6c', '反例：已迁移文件没有 teardown / process.exit 收尾 → 恰判红 CLOSE', sig(r6c) === want('m.js|MIGRATED|CLOSE'), sig(r6c));
    check('S.6d', '反例：已迁移文件没有 ready() 调用（只有 process.exit 收尾）→ 完整签名恰等于 MIGRATED|R4', sig(r6d) === want('m.js|MIGRATED|R4'), sig(r6d));
    const rTd = ev({ 'm.js': SRC.goodTd }, { mig: MIG });
    const rEx = ev({ 'm.js': SRC.goodExit }, { mig: MIG });
    check('S.6e', '合法迁移对照：只有 await teardown()（没有 process.exit）判绿；只有 process.exit()（没有 teardown）判绿——两种收尾识别各自独立证明', rTd.problems.length === 0 && rEx.problems.length === 0, { td: sig(rTd), ex: sig(rEx) });
    const evid = r6a.problems[0] ? r6a.problems[0].evidence : '';
    check('S.6g', 'MIGRATED 违规证据：分析器 detail 里的 @偏移 换算成「行号:原文前 120 字」（不再出现 @数字）', /^\d+:/.test(evid) && !/@\d/.test(evid) && /@L\d+/.test(evid), evid);
    // S.7
    const r7a = ev({ 'bl.js': SRC.t1t2 }, { baseline: bl({ 'bl.js': ['T1'] }) });
    const r7b = ev({ 'bl.js': SRC.clean }, { baseline: bl({ 'bl.js': ['T1'] }) });
    const r7c = ev({ 'a.js': SRC.t1Url, 'b.js': SRC.t1Url }, { baseline: bl({ 'a.js': ['T1'], 'b.js': ['T1'] }, 1) });
    check('S.7a', '反例：基线文件多出一条规则（冻结 T1，实际 T1+T2）→ 恰判红 BASELINE/T2', sig(r7a) === want('bl.js|BASELINE|T2'), sig(r7a));
    check('S.7b', '反例：基线文件违规全部消失（冻结 T1，实际零命中）→ 恰判红 BASELINE/GONE-T1', sig(r7b) === want('bl.js|BASELINE|GONE-T1'), sig(r7b));
    check('S.7c', '反例：基线条数超过 maxEntries → 恰判红 MAXENTRIES', sig(r7c) === want('(基线)|BASELINE|MAXENTRIES'), sig(r7c));
    const goodEntries = { 'bl.js': ['T1'] };
    const r7d1 = ev({ 'bl.js': SRC.t1Url }, { baseline: { createdAt: 'T0', createdAtHead: 'H0', entries: goodEntries } });
    const r7d2 = ev({ 'bl.js': SRC.t1Url }, { baseline: { createdAt: 'T0', createdAtHead: 'H0', maxEntries: -1, entries: goodEntries } });
    const r7d3 = ev({ 'bl.js': SRC.t1Url }, { baseline: { createdAt: 'T0', createdAtHead: 'H0', maxEntries: '1', entries: goodEntries } });
    check('S.7d', '反例：maxEntries 缺失 / 负数 / 字符串 → 各恰判红 BASELINE/FORMAT（不放行增长检查）', [r7d1, r7d2, r7d3].every((r) => sig(r) === want('(基线)|BASELINE|FORMAT')), { a: sig(r7d1), b: sig(r7d2), c: sig(r7d3) });
    const r7e = ev({ 'bl.js': SRC.t1Url, 'bl2.js': SRC.t1Url, 'bl3.js': SRC.t1Url }, { baseline: bl({ 'bl.js': [], 'bl2.js': ['T9'], 'bl3.js': ['T1', 'T1'] }) });
    check('S.7e', '反例：基线条目格式错误（空数组 / 不在 T1–T5 的代号 / 重复代号）→ 各判红 BASELINE/FORMAT（另按实际命中补报 T1）', ['bl.js', 'bl2.js', 'bl3.js'].every((f) => r7e.problems.some((p) => p.file === f && p.rule === 'FORMAT')), sig(r7e));
    // S.8
    const r8a = ev({ 'x.js': SRC.t2Db }, { mig: { 'x.js': {} }, exempt: { 'x.js': 'reason' } });
    const r8b = ev({ 'ok.js': SRC.clean }, {
        mig: { 'gone1.js': {} }, exempt: { 'gone2.js': 'reason' }, infra: { 'gone3.js': 'reason' }, infraAllowed: ['gone3.js'], baseline: bl({ 'gone4.js': ['T1'] }),
    });
    check('S.8a', '反例：同一文件同时在 MIGRATED 与 EXEMPT → 恰判红 OVERLAP', sig(r8a) === want('x.js|MIGRATED+EXEMPT|OVERLAP'), sig(r8a));
    check('S.8b', '反例：MIGRATED / EXEMPT / INFRA / 基线条目指向不存在的文件 → 各判红 STALE', sig(r8b) === want('gone1.js|MIGRATED|STALE', 'gone2.js|EXEMPT|STALE', 'gone3.js|INFRA|STALE', 'gone4.js|BASELINE|STALE'), sig(r8b));
    const r8c = ev({ 'm.js': SRC.good, 'm2.js': SRC.good }, { mig: { 'm.js': {} }, noReady: { 'm.js': 'r', 'ghost.js': 'r', 'm2.js': '' } });
    check('S.8c', '反例：EXEMPT_NO_READY 的键不在 MIGRATED、理由为空 → 各判红 NOREADY / REASON（另：登记了豁免 ready 的已迁移脚本，本合成样本里自己有 ready，所以 R4 之外的违规由别处报）',
        r8c.problems.some((p) => p.file === 'ghost.js' && p.rule === 'NOREADY') && r8c.problems.some((p) => p.file === 'm2.js' && p.rule === 'REASON') && r8c.problems.some((p) => p.file === 'm2.js' && p.rule === 'NOREADY'), sig(r8c));
    // S.9：EXEMPT 条目（内容里放一处真实库路径，保证 Tier-1 有命中，不触发「零命中即过期」）
    const exNames = ['verify-x.js', 'Test-Y.js', 'smoke-x.js', 'SMOKE-Z.js', 'Verify-Mixed.js', 'fam.js', 'noreason.js', 'blank.js', 'backfill-ok.js'];
    const exFiles = {}; exNames.forEach((n) => { exFiles[n] = SRC.t2Db; });
    const r9 = ev(exFiles, { exempt: { 'verify-x.js': 'r', 'Test-Y.js': 'r', 'smoke-x.js': 'r', 'SMOKE-Z.js': 'r', 'Verify-Mixed.js': 'r', 'fam.js': 'r', 'noreason.js': '', 'blank.js': '   ', 'backfill-ok.js': 'r' }, family: ['fam.js'] });
    const prefixBad = ['verify-x.js', 'Test-Y.js', 'smoke-x.js', 'SMOKE-Z.js', 'Verify-Mixed.js'];
    check('S.9a', '反例：EXEMPT 条目名以 verify- / test- / smoke-（不分大小写、含混合大小写）开头 → 恰判红 PREFIX（对照：backfill- 开头的合法条目不报）',
        sig(r9).split(',').filter((s) => s.includes('|PREFIX')).join(',') === want(...prefixBad.map((n) => `${n}|EXEMPT|PREFIX`)) && !sig(r9).includes('backfill-ok.js'), sig(r9));
    check('S.9b', '反例：EXEMPT 条目是 FAMILY 成员 → 恰判红 FAMILY', sig(r9).split(',').filter((s) => s.includes('|FAMILY')).join(',') === want('fam.js|EXEMPT|FAMILY'), sig(r9));
    check('S.9c', '反例：EXEMPT 条目理由为空 / 全空白、禁用前缀（5 个）、FAMILY 成员——整组问题签名全等',
        sig(r9) === want(...prefixBad.map((n) => `${n}|EXEMPT|PREFIX`), 'fam.js|EXEMPT|FAMILY', 'noreason.js|EXEMPT|REASON', 'blank.js|EXEMPT|REASON'), sig(r9));
    const r9d = ev({ 'infra-new.js': SRC.clean, 'infra-blank.js': SRC.clean }, { infra: { 'infra-new.js': 'r', 'infra-blank.js': '' }, infraAllowed: ['infra-blank.js'] });
    check('S.9d', '反例：INFRA 条目不在守卫常量白名单 → 判红 ALLOWLIST；INFRA 理由为空 → 判红 REASON', sig(r9d) === want('infra-new.js|INFRA|ALLOWLIST', 'infra-blank.js|INFRA|REASON'), sig(r9d));
    // S.26 EXEMPT 零命中 = 过期
    const rSt = ev({ 'backfill-clean.js': SRC.clean, 'backfill-hit.js': SRC.t2Db }, { exempt: { 'backfill-clean.js': 'r', 'backfill-hit.js': 'r' } });
    check('S.26', '豁免必须有必要：EXEMPT 条目 Tier-1 零命中 → 判红 STALE；有命中的条目判绿', sig(rSt) === want('backfill-clean.js|EXEMPT|STALE'), sig(rSt));
}

/** 表驱动：变量名逐项（T2 两个密钥变量 × 四种写法；T5 六个测试变量 × 点号 / 方括号 / 解构），断言完整签名 */
function sectionNameTables() {
    const secrets = ['JWT_SECRET', 'DB_ENCRYPTION_KEY'];
    const t2Bad = [];
    for (const name of secrets) {
        const forms = secretForms(name);
        for (const [fk, src] of Object.entries(forms)) {
            const r = ev({ 's.js': src });
            if (sig(r) !== one('T2', 's.js')) t2Bad.push({ name, form: fk, sig: sig(r) });
        }
    }
    check('S.27a', 'T2 密钥变量逐项：JWT_SECRET / DB_ENCRYPTION_KEY × 点号 / 方括号 / 解构 / 解构别名，各自完整签名恰为 OTHER|T2', t2Bad.length === 0, t2Bad);
    const t5Bad = [];
    for (const name of TEST_VAR_NAMES) {
        const variants = { dot: cat('const u = process.env.', name, ';\n'), bracket: cat("const u = process.env['", name.toLowerCase(), "'];\n"), destr: cat('const { ', name, ' } = process.env;\n') };
        for (const [vk, src] of Object.entries(variants)) {
            const r = ev({ 's.js': src });
            if (sig(r) !== one('T5', 's.js')) t5Bad.push({ name, form: vk, sig: sig(r) });
        }
    }
    check('S.27b', `T5 测试变量逐项（名字取自 lib/test-batch.js 导出的 TEST_VAR_NAMES，共 ${TEST_VAR_NAMES.length} 个）× 点号 / 方括号小写 / 解构，各自完整签名恰为 OTHER|T5`, TEST_VAR_NAMES.length === 6 && t5Bad.length === 0, t5Bad);
    const ctl = ev({ 's.js': 'const u = process.env.TEST_SOMETHING_ELSE;\nconst v = process.env.NODE_ENV;\n' });
    check('S.27c', '对照：不在清单里的环境变量（TEST_SOMETHING_ELSE、NODE_ENV）不报', ctl.problems.length === 0, sig(ctl));
}

/** A：起主服务的常见写法（T3 补充） */
function sectionServerForms() {
    const cases = [
        ['S.21a', '命令串 exec(\'node <入口>\')', SRC.cmdExec],
        ['S.21b', 'spawn 的 shell 命令串 \'node <入口> --port 0\'', SRC.cmdSpawnShell],
        ['S.21c', '模板串 `${ROOT}/<入口>` 放进 spawn 实参', SRC.tplSpawn],
        ['S.21d', '模板串 `${ROOT}/<入口>`（sink 外）', SRC.tplOut],
        ['S.21e', "require('../server')（不带扩展名）", SRC.reqNoExt],
        ['S.21f', "require(path.join(__dirname, '..', 'server'))", SRC.reqJoin],
        ['S.21g', "fork(require.resolve('../server'))", SRC.reqResolve],
        ['S.21h', "require('../<入口>')（带扩展名，require 类视为 sink 内）", SRC.reqExt],
        ['S.21i', "import('../server')", SRC.reqImport],
        ['S.21j', "spawn(process.execPath, ['server'])（sink 实参整串等于 server）", SRC.sinkWord],
        ['S.21k', '仓库里已有的真实写法（照 test-issue-c7-notify-e2e.js:66 的形态）', SRC.realC7],
    ];
    for (const [id, label, src] of cases) {
        const r = ev({ 'n.js': src });
        check(id, `T3 补充：未登记文件里的 ${label} → 恰判红 T3`, sig(r) === one('T3', 'n.js'), sig(r));
    }
    // 登记 SOURCE_READERS 也不豁免的（sink 内 / require 类 / sink 实参里的 server）：给每份样本补一处 sink 外字面量，避免被 STALE 干扰
    const RD = { 'rd.js': RD_REASON };
    const inSinkForms ={ cmdExec: SRC.cmdExec, cmdSpawnShell: SRC.cmdSpawnShell, tplSpawn: SRC.tplSpawn, reqNoExt: SRC.reqNoExt, reqJoin: SRC.reqJoin, reqResolve: SRC.reqResolve, reqExt: SRC.reqExt, reqImport: SRC.reqImport, sinkWord: SRC.sinkWord, realC7: SRC.realC7 };
    const rdBad = [];
    for (const [k, src] of Object.entries(inSinkForms)) {
        const r = ev({ 'rd.js': cat(SRC.readOut, '{\n', src, '}\n') }, { readers: RD });   // 放进块里：样本之间的 const 重名不会变成语法错误
        const sg = sig(r);
        // child_process 的 require / sink 调用会再触发 SPAWN；只看 T3 是否还在
        if (!r.problems.some((p) => p.rule === 'T3')) rdBad.push({ k, sg });
    }
    check('S.21l', 'SOURCE_READERS 不豁免：命令串 / 模板串进 sink / require 类 / sink 实参里的 server 登记了也仍判红 T3', rdBad.length === 0, rdBad);
    const rdOutTpl = ev({ 'rd.js': SRC.tplOut }, { readers: RD });
    check('S.21m', '对照：SOURCE_READERS 文件里 sink 外的模板串 `${ROOT}/<入口>` 判绿（与普通字面量同样处理）', rdOutTpl.problems.length === 0, sig(rdOutTpl));
    // 残余对照：'.' / npm start 不报
    const resid = ev({ 'g.js': SRC.gitAddDot });
    check('S.21n', "对照（登记残余）：spawnSync('git', ['add', '.']) 不报（'.' 与 npm start 不做）", resid.problems.length === 0, sig(resid));
    const prose = ev({ 'p.js': cat("const MSG = 'see ", SJS, " for details';\nconsole.log(MSG, 'node ", SJS, " --x');\n") });
    check('S.21q', "对照：说明文字 / 断言信息里带空格的 server 入口提及（'see <入口> for details'，不在 sink 实参里）不报——命令串形态只在 sink 实参里认", prose.problems.length === 0, sig(prose));
    // MIGRATED 叠加：分析器 R3 看不到的写法
    const migForms = {
        cmd: afterReady(SRC.good, cat("require('child_process').exec('node ", SJS, "');")),
        tpl: afterReady(SRC.good, cat("require('child_process').spawn(process.execPath, [`${__dirname}/", SJS, "`]);")),
        req: afterReady(SRC.good, "require(require('path').join(__dirname, '..', 'server'));"),
        word: afterReady(SRC.good, "require('child_process').spawn(process.execPath, ['server']);"),
    };
    const migBad = [];
    for (const [k, src] of Object.entries(migForms)) { const r = ev({ 'm.js': src }, { mig: MIG }); if (sig(r) !== want('m.js|MIGRATED|T3')) migBad.push({ k, sg: sig(r) }); }
    check('S.21o', 'MIGRATED 叠加：命令串 / 模板串 / require 无扩展名 / sink 实参里的 server → 恰判红 MIGRATED/T3（分析器 R3 看不到的写法）', migBad.length === 0, migBad);
    const legacyMig = ev({ 'm.js': SRC.migIn }, { mig: MIG });
    check('S.21p', '对照：分析器 R3 本来就报的写法（sink 内的 <入口> 字面量）在 MIGRATED 里只报 R3，不重复报 T3', sig(legacyMig) === want('m.js|MIGRATED|R3'), sig(legacyMig));
    // F：listen(3000)
    const rl1 = ev({ 'l1.js': SRC.listenLit });
    const rl2 = ev({ 'l2.js': SRC.listenConst });
    const rl3 = ev({ 'l3.js': SRC.listenOk });
    check('S.24a', 'T1 补充：.listen(3000) 与 .listen(值为 3000 的 const 标识符) → 恰判红 T1；对照：.listen(31000) 判绿', sig(rl1) === one('T1', 'l1.js') && sig(rl2) === one('T1', 'l2.js') && rl3.problems.length === 0, { a: sig(rl1), b: sig(rl2), c: sig(rl3) });
    const rlm = ev({ 'm.js': afterReady(SRC.good, cat("require('http').createServer().listen(", N3K, ');')) }, { mig: MIG });
    check('S.24b', 'MIGRATED 叠加：.listen(3000) → 恰判红 MIGRATED/T1', sig(rlm) === want('m.js|MIGRATED|T1'), sig(rlm));
    // G：T2 补充
    const rg1 = ev({ 'g1.js': SRC.loadEnvFile });
    const rg2 = ev({ 'g2.js': SRC.envPathLit });
    check('S.25a', 'T2 补充：process.loadEnvFile() 调用、路径边界上以 .env 结尾的字符串字面量 → 各恰判红 T2', sig(rg1) === one('T2', 'g1.js') && sig(rg2) === one('T2', 'g2.js'), { a: sig(rg1), b: sig(rg2) });
    const mg = {
        loadEnv: afterReady(SRC.good, 'process.loadEnvFile();'),
        bracket: afterFx(SRC.good, cat("const K = process.env['", 'JWT_SECRET', "'];")),
        destr: afterFx(SRC.good, cat('const { ', 'DB_ENCRYPTION_KEY', ' } = process.env;')),
        envLit: afterFx(SRC.good, cat("const E = '", DOTENV_PATH, "';")),
    };
    const mgBad = [];
    for (const [k, src] of Object.entries(mg)) { const r = ev({ 'm.js': src }, { mig: MIG }); if (sig(r) !== want('m.js|MIGRATED|T2')) mgBad.push({ k, sg: sig(r) }); }
    check('S.25b', 'MIGRATED 叠加：process.loadEnvFile / 方括号读密钥变量 / 解构读密钥变量 / .env 路径字面量 → 各恰判红 MIGRATED/T2', mgBad.length === 0, mgBad);
}

/** B：SOURCE_READERS 硬门 + 其余登记属性 */
function sectionSourceReaders() {
    const RD = { 'rd.js': RD_REASON };
    const rBoth = ev({ 'rd.js': SRC.readBoth }, { readers: RD });
    check('S.18a', 'T3 拆两半：SOURCE_READERS 文件里 sink（spawn 实参）内的 <入口> 字面量仍判红（证据标「sink 内」），同文件 sink 外的那处不报；另因起进程判红 SPAWN；整组签名全等',
        sig(rBoth) === want('rd.js|OTHER|T3', 'rd.js|SOURCE_READERS|SPAWN') && /\[sink 内\]/.test(rBoth.problems.find((p) => p.rule === 'T3').evidence), rBoth.problems);
    const rOutNo = ev({ 'rd.js': SRC.readOut });
    check('S.18b', 'T3 拆两半：未登记文件里 sink 外的 <入口> 字面量（路径拼接）判红 T3', sig(rOutNo) === one('T3', 'rd.js'), sig(rOutNo));
    const rOutYes = ev({ 'rd.js': SRC.readOut }, { readers: RD });
    check('S.18c', '对照组：登记了 SOURCE_READERS、只有 sink 外 <入口> 字面量、不起进程的文件判绿，并计入 sourceReaders=1', rOutYes.problems.length === 0 && rOutYes.counts.sourceReaders === 1, rOutYes.problems);
    const rStale1 = ev({ 'rd.js': SRC.clean }, { readers: RD });
    check('S.18d', '登记了 SOURCE_READERS 却没有 sink 外的起主服务字符串 → 判红 STALE', sig(rStale1) === want('rd.js|SOURCE_READERS|STALE'), sig(rStale1));
    const rOvEx = ev({ 'rd.js': SRC.readOut }, { readers: RD, exempt: { 'rd.js': 'r' } });
    const rOvIn = ev({ 'rd.js': SRC.readOut }, { readers: RD, infra: { 'rd.js': 'r' }, infraAllowed: ['rd.js'] });
    check('S.18e', 'SOURCE_READERS 与 EXEMPT / INFRA 重叠 → 判红 OVERLAP（那两类不扫内容，登记它没有意义）', sig(rOvEx) === want('rd.js|SOURCE_READERS+EXEMPT|OVERLAP') && sig(rOvIn) === want('rd.js|SOURCE_READERS+INFRA|OVERLAP'), { a: sig(rOvEx), b: sig(rOvIn) });
    const rMigOutNo = ev({ 'm.js': SRC.migOut }, { mig: MIG });
    const rMigOutYes = ev({ 'm.js': SRC.migOut }, { mig: MIG, readers: { 'm.js': 'r' } });
    check('S.18f', 'MIGRATED：sink 外的 <入口> 字面量，未登记时报 R3；登记 SOURCE_READERS 后不报（分析器 R3 被守卫滤掉）', sig(rMigOutNo) === want('m.js|MIGRATED|R3') && rMigOutYes.problems.length === 0, { no: sig(rMigOutNo), yes: sig(rMigOutYes) });
    const migBoth = afterReady(SRC.migOut, cat("require('child_process').spawn('node', ['", SJS, "']);"));
    const rMigBoth = ev({ 'm.js': migBoth }, { mig: MIG, readers: { 'm.js': 'r' } });
    check('S.18g', 'MIGRATED + SOURCE_READERS：同一文件 sink 外 + sink（spawn 实参）内各一处 → 只报 sink 内那处的 R3（另因起进程判红 SPAWN）', sig(rMigBoth) === want('m.js|MIGRATED|R3', 'm.js|SOURCE_READERS|SPAWN'), sig(rMigBoth));
    const migReq = afterReady(SRC.migOut, cat("require('../", SJS, "');"));
    const rMigReq = ev({ 'm.js': migReq }, { mig: MIG, readers: { 'm.js': 'r' } });
    check('S.18g2', 'MIGRATED + SOURCE_READERS：require(\'../<入口>\') 视为 sink 内，登记了也仍报 R3（进程内 require 主服务入口会无条件 listen）', sig(rMigReq) === want('m.js|MIGRATED|R3'), sig(rMigReq));
    const X = cat('./', SJS);
    const forms = [
        ["require('child_process').spawn('node', ['" + X + "'])", true], ["const cp = require('child_process'); cp.fork('" + X + "')", true], ["const { spawn } = require('child_process'); spawn('node', ['" + X + "'])", true],
        ["const cp = require('child_process'); cp.spawnSync(process.execPath, ['" + X + "'])", true], ["const cp = require('child_process'); cp.execSync('node ' + require('path').join('.', '" + X + "'))", true],
        ["const cp = require('child_process'); cp.execFile(process.execPath, ['" + X + "'], () => {})", true], ["const cp = require('child_process'); cp.execFileSync(process.execPath, ['" + X + "'])", true],
        ["const cp = require('child_process'); cp.exec('node ' + '" + X + "')", true],
        ["require('" + X + "')", true], ["require.resolve('" + X + "')", true], ["import('" + X + "')", true],
        ["require('fs').readFileSync(require('path').join(__dirname, '" + X + "'), 'utf8')", false], ["const S = '" + X + "';", false], ["foo('" + X + "')", false], ["const o = { spawn: '" + X + "' };", false],
    ];
    const formRes = forms.map(([src, want1]) => { const l = L.serverJsLiterals(L.parseSource(src).ast); return { src: src.slice(0, 60), ok: l.length === 1 && l[0].inSink === want1 }; });
    check('S.18h', 'serverJsLiterals 的 sink 判定：spawn / fork / spawnSync / execSync / execFile / execFileSync / exec 实参、require / require.resolve / import() 实参里的字面量标 inSink；readFileSync 实参、变量赋值、普通函数实参、对象属性值标 sink 外', formRes.every((r) => r.ok), formRes.filter((r) => !r.ok));
    const rBl = ev({ 'rd.js': cat(SRC.readOut, SRC.t4Fx) }, { readers: RD, baseline: bl({ 'rd.js': ['T4'] }) });
    check('S.18i', '对照组：SOURCE_READERS 可与基线并存（冻结 T4，sink 外 <入口> 字面量不算 T3）判绿', rBl.problems.length === 0 && rBl.counts.baseline === 1 && rBl.counts.sourceReaders === 1, rBl.problems);
    // 硬门：child_process / sink 调用 / 经变量 spawn / require 主服务入口 / 正则 exec / 不存在 / 理由空
    const rCp = ev({ 'rd.js': cat(SRC.readOut, "const cp = require('child_process');\n") }, { readers: RD });
    const rVar = ev({ 'rd.js': cat("const path = require('path');\nconst { spawn } = require('child_process');\nconst S = path.join(__dirname, '..', '", SJS, "');\nspawn(process.execPath, [S]);\n") }, { readers: RD });
    const rReq = ev({ 'rd.js': cat(SRC.readOut, "require('../", SJS, "');\n") }, { readers: RD });
    const rExec = ev({ 'rd.js': cat(SRC.readOut, "const m = /a/.exec('x');\n") }, { readers: RD });
    check('S.18j', '硬门：SOURCE_READERS 文件 require child_process → 判红 SOURCE_READERS/SPAWN', sig(rCp) === want('rd.js|SOURCE_READERS|SPAWN'), sig(rCp));
    check('S.18k', '硬门：SOURCE_READERS 文件经变量 spawn（字面量在 sink 外、变量交给 spawn）→ 判红 SPAWN（拦住静态看不出的写法）', sig(rVar) === want('rd.js|SOURCE_READERS|SPAWN'), sig(rVar));
    check('S.18l', '硬门：SOURCE_READERS 文件 require(\'../<入口>\') → 仍判红 T3（require 类视为 sink 内，不豁免）', sig(rReq) === one('T3', 'rd.js'), sig(rReq));
    check('S.18m', '对照：SOURCE_READERS 文件里的正则 re.exec(…)（文件没有 require child_process）不算 sink，不触发 SPAWN', rExec.problems.length === 0, sig(rExec));
    // 成员调用 X.exec(…) 只在文件 require 了 child_process 时才算 sink（裸标识符与 X.spawn / fork / execFile / execFileSync / execSync / spawnSync 照旧算）
    const reNoCp = ev({ 'n.js': cat("const re = /a/;\nre.exec('node ", SJS, "');\n") });
    check('S.29a', 'sink 判定：没 require child_process 的文件里 re.exec(\'node <入口>\') 不算 sink（命令串形态只在 sink 实参里认）→ 判绿；同一文件里 sink 外字面量照旧另论', reNoCp.problems.length === 0, sig(reNoCp));
    const cpExec = ev({ 'n.js': cat("const cp = require('child_process');\ncp.exec('node ", SJS, "');\n") });
    const cpExecBare = ev({ 'n.js': cat("const { exec } = require('child_process');\nexec('node ", SJS, "');\n") });
    const sinkTag = (r) => r.problems.some((p) => p.rule === 'T3' && /\[sink 内\]/.test(p.evidence));
    check('S.29b', 'sink 判定：require 了 child_process 的文件里 cp.exec(\'node <入口>\') 与解构出来的 exec(…) → 各恰判红 T3，且证据标「sink 内」（成员 .exec 在文件 require 了 child_process 时算 sink；命令串另有文件级一档，所以光看签名分不出来）',
        sig(cpExec) === one('T3', 'n.js') && sig(cpExecBare) === one('T3', 'n.js') && sinkTag(cpExec) && sinkTag(cpExecBare), { a: sig(cpExec), b: sig(cpExecBare), ta: sinkTag(cpExec), tb: sinkTag(cpExecBare) });
    const srBareExec = ev({ 'rd.js': cat(SRC.readOut, "exec('ls');\n") }, { readers: RD });
    const srMemberExecSync = ev({ 'rd.js': cat(SRC.readOut, "x.execSync('ls');\n") }, { readers: RD });
    const srReExec = ev({ 'rd.js': cat(SRC.readOut, "const m = /a/.exec('x');\nconst k = RE.exec(text);\n") }, { readers: RD });
    check('S.29c', 'SR 硬门：裸标识符 exec(…)、成员调用 X.execSync(…)（即使文件没有 require child_process）仍算 sink → 判红 SPAWN', sig(srBareExec) === want('rd.js|SOURCE_READERS|SPAWN') && sig(srMemberExecSync) === want('rd.js|SOURCE_READERS|SPAWN'), { a: sig(srBareExec), b: sig(srMemberExecSync) });
    check('S.29d', 'SR 对照：SR 文件里出现多处正则 re.exec(…) 不触发 SPAWN（SR 文件本来禁止 require child_process，所以不可能有真正的 cp.exec）', srReExec.problems.length === 0, sig(srReExec));
    const rGhost = ev({ 'ok.js': SRC.clean }, { readers: { 'ghost.js': '只读' } });
    const rNoReason = ev({ 'rd.js': SRC.readOut }, { readers: { 'rd.js': '  ' } });
    check('S.18n', 'SOURCE_READERS 登记不存在的文件 → 判红 STALE；理由为空白 → 判红 REASON', sig(rGhost) === want('ghost.js|SOURCE_READERS|STALE') && sig(rNoReason) === want('rd.js|SOURCE_READERS|REASON'), { a: sig(rGhost), b: sig(rNoReason) });
    // S.19 MIGRATED 叠加 T5
    const rT5 = ev({ 'm.js': SRC.migT5 }, { mig: MIG });
    check('S.19', 'MIGRATED 叠加 T5：已迁移文件直接读 process.env.TEST_BASE_URL → 恰判红 MIGRATED/T5（对照：形态正确的 S.13 判绿）', sig(rT5) === want('m.js|MIGRATED|T5'), sig(rT5));
}

/**
 * S4b2b：SELF_ISOLATED 登记类（自带隔离机制的套件）。合成源码里所有触发规则的片段都经 cat 拼接（本文件也是被扫描对象）。
 * 每条规则成对：诚实常见写法判红 / 合法写法判绿；红灯断言完整签名（文件|类|规则 整组全等）。
 */
function sectionSelfIsolated() {
    const WRAP = '_test-it-asset-ledger-server-wrapper.js';
    const SEED = '_seed-collab-external-source.js';
    // 合法绑定：只解构 spawn / spawnSync / execFileSync（exec / execSync / fork 这几个名字不能被合法绑定，下面的 exec 系用例直接用未绑定的裸标识符，只验 sink 形态规则本身）
    const CP = "const { spawn, spawnSync, execFileSync } = require('child_process');\nconst path = require('path');\nconst copyRoot = __dirname;\n";
    const BARE = cat("const ENTRY = '", SJS, "';\n");   // sink 外、require 类实参外、值恰为入口名的普通字符串字面量（被豁免的那一种）
    const SI = { 'si.js': '自带隔离机制（测试登记理由）' };
    const siSrc = (body) => cat(CP, BARE, body, '\n');
    // F3 要求种子脚本名在扫描集合里：合成扫描集合里放一个同名的干净文件。另把下面各种「名字不合格」的近似名也放进集合——这样它们只能被名字正则拒绝，不会被「不在扫描集合里」这一条遮住（L8 加入后名字正则的判别力要靠这个保住）
    const SEED_FILES = { [SEED]: SRC.clean };
    for (const nm of ['seed-x.js', '_seed.js', '_seed-x.sh', '_seed-../x.js', 'sub/_seed-x.js', 'x_seed-y.js', '_seed-x.js.bak']) SEED_FILES[nm] = SRC.clean;
    const runSi = (body, o, extraFiles) => ev(Object.assign({ 'si.js': siSrc(body) }, extraFiles || {}), Object.assign({ selfIso: SI }, o || {}));
    const SPAWN1 = want('si.js|SELF_ISOLATED|SPAWN_FORM');
    const BIND1 = want('si.js|SELF_ISOLATED|BINDING');
    const OK_SIG = '';
    const uniqSig = (r) => Array.from(new Set(r.problems.map((p) => `${p.file}|${p.cls}|${p.rule}`))).sort().join(',');   // 同一规则可有多条违规，按「规则集合」比

    // ---- 硬门②：sink 形态。合法写法逐个判绿
    const green = {
        'F1 __filename（变异自调用）': "spawnSync(process.execPath, [__filename, '--mutation=m1'], { encoding: 'utf8' });",
        'F1 + 字面量 node': "spawnSync('node', [__filename]);",
        'F1 + 字面量 Node.EXE（不分大小写）': "spawnSync('Node.EXE', [__filename]);",
        'F1 + execFileSync': 'execFileSync(process.execPath, [__filename]);',
        'F2 path.join(…, wrapper 文件名)': `spawn(process.execPath, [path.join(copyRoot, 'scripts', '${WRAP}')], { cwd: copyRoot });`,
        'F2 第一个实参是别的表达式（member / 调用）': `spawn(process.execPath, [path.join(opts.copyRoot, 'scripts', '${WRAP}')]);\nspawn(process.execPath, [path.join(getRoot(), 'scripts', '${WRAP}')]);`,
        'F3 path.join(__dirname, _seed-*.js) + 其余参数': `spawnSync(process.execPath, [path.join(__dirname, '${SEED}'), '--apply', '--allow-db-override']);`,
        '非 node 名单 taskkill': "spawnSync('taskkill', ['/T', '/F', '/PID', '1'], { stdio: 'ignore' });",
        '非 node 名单 powershell': "execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Date']);",
        '非 node 名单 git': "spawnSync('git', ['status']);",
        '没有任何 sink 调用（只 require child_process）': 'void 0;',
        'sink 外裸字面量用于路径拼接（读 / 复制源码副本）': cat("const P = path.join(copyRoot, '", SJS, "');"),
    };
    const greenBad = Object.entries(green).map(([k, body]) => ({ k, sg: sig(runSi(body, null, SEED_FILES)) })).filter((x) => x.sg !== OK_SIG);
    check('S.36a', 'SELF_ISOLATED 合法写法判绿：F1 / F2（恰 3 个实参，第一个不是 __dirname）/ F3（种子脚本名在扫描集合里）三种起 node 的写法（含字面量 node、不分大小写）· taskkill / powershell / git 名单 · 无 sink 调用 · sink 外裸字面量拼路径', greenBad.length === 0, greenBad);

    // ---- 诚实常见的不合格写法：各恰判红 SELF_ISOLATED|SPAWN_FORM（一条 sink 调用 = 一条违规）
    const red = {
        '第一个元素是变量': 'const S = __filename;\nspawnSync(process.execPath, [S]);',
        '第一个元素是展开元素': 'const a = [__filename];\nspawnSync(process.execPath, [...a]);',
        '--require 打头': "spawnSync(process.execPath, ['--require', 'x.js', __filename]);",
        '-e 打头': "spawnSync(process.execPath, ['-e', 'process.exit(0)']);",
        '缺第二个实参（没有数组）': 'spawnSync(process.execPath);',
        '第二个实参是变量（不是数组字面量）': 'const a = [__filename];\nspawnSync(process.execPath, a);',
        '空数组': 'spawnSync(process.execPath, []);',
        '数组首位是空洞': 'spawnSync(process.execPath, [, __filename]);',
        'fork(__filename)': 'fork(__filename);',
        'fork 带 process.execPath 形态也一律红': 'fork(process.execPath, [__filename]);',
        '裸 exec 命令串': "exec('node ' + __filename);",
        'exec 即使形如起 node 的合法写法也一律红': 'exec(process.execPath, [__filename]);',
        'execSync 即使形如起 node 的合法写法也一律红': 'execSync(process.execPath, [__filename]);',
        '正则的 .exec 在 require 了 child_process 的文件里也算（宁可误红）': 'const RE = /a/;\nRE.exec(\'a\');',
        '名单外程序 python': "spawnSync('python', ['x.py']);",
        '名单外程序 cmd': "spawnSync('cmd', ['/c', 'dir']);",
        '字面量 node.js 不是 node': "execFileSync('node.js', [__filename]);",
        '字面量 git.exe 不在封闭名单（名单是精确值）': "execFileSync('git.exe', ['status']);",
        '第一个实参是变量': "const tool = 'git';\nspawnSync(tool, ['status']);",
        '第一个实参是模板串': 'spawnSync(`node`, [__filename]);',
        '第一个实参是调用表达式': "function getNode() { return 'node'; }\nspawnSync(getNode(), [__filename]);",
        '没有实参': 'spawnSync();',
        '第一个实参是展开元素': 'const argv = [];\nspawnSync(...argv);',
        'F2 最后一个实参不是 wrapper 文件名': "spawn(process.execPath, [path.join(copyRoot, 'other-wrapper.js')]);",
        'F2 最后一个实参是变量': "const nm = 'x';\nspawn(process.execPath, [path.join(copyRoot, 'scripts', nm)]);",
        'F2 最后一个实参是模板串': 'spawn(process.execPath, [path.join(copyRoot, `scripts`)]);',
        'join 解构出来的裸调用不是 path.join（三个实参的 F2 形态）': `const { join } = path;\nspawn(process.execPath, [join(copyRoot, 'scripts', '${WRAP}')]);`,
        '别的对象的 .join（p.join）不是 path.join（三个实参的 F2 形态）': `const p = path;\nspawn(process.execPath, [p.join(copyRoot, 'scripts', '${WRAP}')]);`,
        '别的对象的 .join（p.join）不是 path.join（F3 形态）': `const p = path;\nspawnSync(process.execPath, [p.join(__dirname, '${SEED}')]);`,
        'F3 三个实参': `spawnSync(process.execPath, [path.join(__dirname, 'sub', '${SEED}')]);`,
        // 19a-M1：只违反数量（文件名合法且在合成扫描集合里）——与合法两参数的 F3 用例（S.36a）配对；去掉 lib 里 F3 的 a.length === 2 后它必须失败（变异 L14b）
        "F3 只违反数量：path.join(__dirname, SEED, 'extra')（SEED 在扫描集合里）": `spawnSync(process.execPath, [path.join(__dirname, '${SEED}', 'extra')]);`,
        'F3 第一个实参不是 __dirname': `spawnSync(process.execPath, [path.join(copyRoot, '${SEED}')]);`,
        'F3 第二个实参是变量': "const nm = 'x';\nspawnSync(process.execPath, [path.join(__dirname, nm)]);",
        'F3 文件名没有 _seed- 前缀': "spawnSync(process.execPath, [path.join(__dirname, 'seed-x.js')]);",
        'F3 文件名是 _seed.js（缺连字符段）': "spawnSync(process.execPath, [path.join(__dirname, '_seed.js')]);",
        'F3 文件名不是 .js 结尾': "spawnSync(process.execPath, [path.join(__dirname, '_seed-x.sh')]);",
        'F3 文件名带路径穿越': "spawnSync(process.execPath, [path.join(__dirname, '_seed-../x.js')]);",
        'F3 文件名带路径前缀（sub/_seed-x.js）': "spawnSync(process.execPath, [path.join(__dirname, 'sub/_seed-x.js')]);",
        'F3 文件名前面多一段（x_seed-y.js）': "spawnSync(process.execPath, [path.join(__dirname, 'x_seed-y.js')]);",
        'F3 文件名后面多一段（_seed-x.js.bak）': "spawnSync(process.execPath, [path.join(__dirname, '_seed-x.js.bak')]);",
        '第一个元素是 path.resolve 而不是 path.join': `spawnSync(process.execPath, [path.resolve(__dirname, '${SEED}')]);`,
        '第一个元素是字面量路径': "spawnSync(process.execPath, ['./x.js']);",
        // M4：F2 收紧——恰 3 个实参、第 2 个字面量 'scripts'、第 3 个 wrapper 名、第 1 个不是 __dirname
        'F2 只有一个实参': `spawn(process.execPath, [path.join('${WRAP}')]);`,
        'F2 两个实参 path.join(copyRoot, wrapper)': `spawn(process.execPath, [path.join(copyRoot, '${WRAP}')]);`,
        "F2 三个实参但第一个是 __dirname：path.join(__dirname, 'scripts', wrapper)": `spawn(process.execPath, [path.join(__dirname, 'scripts', '${WRAP}')]);`,
        'F2 两个实参 path.join(__dirname, wrapper)': `spawn(process.execPath, [path.join(__dirname, '${WRAP}')]);`,
        "F2 三个实参但第二个不是 'scripts'": `spawn(process.execPath, [path.join(copyRoot, 'bin', '${WRAP}')]);`,
        'F2 三个实参且第二个是 scripts，但第三个是别的文件名': "spawn(process.execPath, [path.join(copyRoot, 'scripts', 'other-wrapper.js')]);",
        'F2 四个实参（中间对、末尾多一个）': `spawn(process.execPath, [path.join(copyRoot, 'scripts', '${WRAP}', 'extra')]);`,
        'F2 四个实参（scripts 不在第二位）': `spawn(process.execPath, [path.join(copyRoot, 'a', 'scripts', '${WRAP}')]);`,
        'F2 第二个实参是变量': `const sub = 'scripts';\nspawn(process.execPath, [path.join(copyRoot, sub, '${WRAP}')]);`,
        // L7：process.execPath 必须核对象名（cfg.execPath 不是）
        'cfg.execPath 不是 process.execPath（分不清是不是起 node）': 'const cfg = { execPath: process.execPath };\nspawnSync(cfg.execPath, [__filename]);',
        'process.argv0 不是 process.execPath（属性名也要核）': 'spawnSync(process.argv0, [__filename]);',
        // L8：F3 的种子脚本名必须在扫描集合里（合成扫描集合里没有 ghost）
        'F3 名字合法但不在扫描集合里（_seed-ghost.js）': "spawnSync(process.execPath, [path.join(__dirname, '_seed-ghost.js')]);",
    };
    const redOf = (v) => (Array.isArray(v) ? v : [v, SPAWN1]);
    const redBad = Object.entries(red).map(([k, v]) => ({ k, sg: sig(runSi(redOf(v)[0], null, SEED_FILES)), want: redOf(v)[1] })).filter((x) => x.sg !== x.want);
    check('S.36b', `SELF_ISOLATED 不合格写法各恰判红 SPAWN_FORM（${Object.keys(red).length} 种：变量 / 展开 / --require / -e / 缺数组 / 空数组 / fork / exec 系列 / 名单外程序 / cfg.execPath / 变量·模板串·调用表达式程序 / F2·F3 的各种近似写法）`, redBad.length === 0, redBad.slice(0, 5));
    // L8 成对：同一条 F3 写法，种子脚本名在扫描集合里判绿、不在判红
    const ghostBody = "spawnSync(process.execPath, [path.join(__dirname, '_seed-ghost.js')]);";
    check('S.36d', 'L8 成对：path.join(__dirname, \'_seed-ghost.js\') —— 文件在扫描集合里判绿；不在扫描集合里恰判红 SPAWN_FORM（证据点名「不在扫描集合」）',
        sig(runSi(ghostBody, null, { '_seed-ghost.js': SRC.clean })) === OK_SIG && sig(runSi(ghostBody)) === SPAWN1 && /不在扫描集合/.test(runSi(ghostBody).problems[0].evidence), { a: sig(runSi(ghostBody, null, { '_seed-ghost.js': SRC.clean })), b: sig(runSi(ghostBody)) });
    // 有 exec / fork 绑定的诚实写法：SPAWN_FORM（调用点）与 BINDING（绑定）各自成立，两条都红
    const honestExec = {
        '诚实写法 const { fork } = require(…); fork(__filename)': ["const { fork } = require('child_process');\nfork(__filename);", want('si.js|SELF_ISOLATED|BINDING', 'si.js|SELF_ISOLATED|SPAWN_FORM')],
    };
    const honestBad = Object.entries(honestExec).map(([k, [body, expect]]) => ({ k, sg: sig(runSi(body)), expect })).filter((x) => x.sg !== x.expect);
    check('S.36e', '诚实写法：额外 require 一次 child_process 且调用 fork → 绑定形态与 sink 形态各判红（两个红码都出现，不互相遮蔽）', honestBad.length === 0, honestBad);
    const cpExec = {
        'cp.exec(…) 起 node 的合法形态也红': "const cp2 = require('child_process');\ncp2.exec(process.execPath, [__filename]);",
        '成员调用 cp.exec': "const cp = require('child_process');\ncp.exec('dir');",
    };
    const cpExecBad = Object.entries(cpExec).map(([k, body]) => ({ k, rules: uniqSig(runSi(body)) })).filter((x) => x.rules !== want('si.js|SELF_ISOLATED|BINDING', 'si.js|SELF_ISOLATED|SPAWN_FORM'));
    check('S.36f', '整体赋值的 child_process 变量调用 exec：绑定形态（BINDING）与 sink 形态（SPAWN_FORM）两个红码都出现', cpExecBad.length === 0, cpExecBad);
    const rEv = runSi('const S = __filename;\nspawnSync(process.execPath, [S]);').problems.find((p) => p.rule === 'SPAWN_FORM');
    check('S.36c', 'SPAWN_FORM 证据带行号与原文：「<行号>:<该行原文> | …(@L行号)…」，不再出现 @偏移', !!rEv && /^\d+:spawnSync\(process\.execPath, \[S\]\);/.test(rEv.evidence) && /@L\d+/.test(rEv.evidence) && !/@\d{3,}/.test(rEv.evidence), rEv);

    // ---- M2：child_process 绑定形态硬门（红码 SELF_ISOLATED|BINDING）。每条文件 = <cp 声明行> + 裸字面量 + <正文>；红灯按「规则集合」全等（同一规则可有多条违规），绿灯要求零问题
    const CPD = "const { spawn, spawnSync, execFile, execFileSync } = require('child_process');";
    const bindSrc = (cpLine, body) => cat(cpLine, '\n', BARE, body, '\n');
    const runBind = (cpLine, body) => ev({ 'si.js': bindSrc(cpLine, body) }, { selfIso: SI });
    const bindRed = {
        '整体赋给变量 const cp = require(…)': ["const cp = require('child_process');", 'void cp;'],
        '整体赋给变量（node: 前缀）': ["const cp = require('node:child_process');", 'void cp;'],
        // 19a-L1：声明外围必须是 const、属性必须是语法简写（只直接调用也不行）
        'let 声明 let { spawn } = require(…)（只直接调用）': ["let { spawn } = require('child_process');", "spawn('git', ['status']);"],
        'var 声明 var { spawn } = require(…)（只直接调用）': ["var { spawn } = require('child_process');", "spawn('git', ['status']);"],
        'const { spawn: spawn }（键值同名但不是语法简写）': ["const { spawn: spawn } = require('child_process');", "spawn('git', ['status']);"],
        // N4：child_process 字符串字面量只许出现在合格声明的 require 实参里（合法声明另给，使本文件不因「没有 require」而过期）
        "N4 module.require('child_process')": [CPD, "const cp2 = module.require('child_process');"],
        "N4 createRequire(__filename)('child_process')": [CPD, "const cp2 = require('module').createRequire(__filename)('child_process');"],
        'N4 require(`child_process`)（无表达式模板串）': [CPD, 'const cp2 = require(`child_process`);'],
        "N4 变量中转 const name = 'child_process'": [CPD, "const name = 'child_process';\nvoid name;"],
        "N4 变量中转（node: 前缀）": [CPD, "const name = 'node:child_process';\nvoid name;"],
        "N4 说明文字里的 'child_process' 字符串也红（宁可误红）": [CPD, "console.log('child_process');"],
        "取成员 require('child_process').spawn": ["const sp = require('child_process').spawn;", 'void sp;'],
        '改名解构 { spawn: sp }': ["const { spawn: sp } = require('child_process');", "sp('git', ['status']);"],
        '带默认值 { spawn = null }': ["const { spawn = null } = require('child_process');", "spawn('git', ['status']);"],
        '带 rest { spawn, ...rest }': ["const { spawn, ...rest } = require('child_process');", "spawn('git', ['status']);"],
        '计算键 { [\'spawn\']: spawn }': ["const { ['spawn']: spawn } = require('child_process');", "spawn('git', ['status']);"],
        '计算键且键是同名标识符 { [spawn]: spawn }': ["const { [spawn]: spawn } = require('child_process');", "spawn('git', ['status']);"],
        '字面量键 { \'spawn\': spawn }（不是简写）': ["const { 'spawn': spawn } = require('child_process');", "spawn('git', ['status']);"],
        '计算成员 o[spawn]': [CPD, 'const o = {};\nvoid o[spawn];'],
        '嵌套模式 { spawn: { x } }': ["const { spawn: { x } } = require('child_process');", 'void x;'],
        '名字不在名单（exec）': ["const { exec } = require('child_process');", 'void 0;'],
        '名字不在名单（fork）': ["const { fork } = require('child_process');", 'void 0;'],
        '名字不在名单（execSync）': ["const { execSync } = require('child_process');", 'void 0;'],
        "import('child_process')": ['', "const p = import('child_process');"],
        "import('node:child_process')": ['', "const p = import('node:child_process');"],
        'require 不是声明初值（表达式语句）': ["void require('child_process');", 'void 0;'],
        'util.promisify(execFile)': [CPD, "const run = require('util').promisify(execFile);"],
        '再赋值 const sp = spawn': [CPD, "const sp = spawn;\nsp('git', ['status']);"],
        '作为实参传出 run(spawn)': [CPD, 'function run(f) { return f; }\nrun(spawn);'],
        '赋值覆盖 spawn = null': ["let { spawn } = require('child_process');", 'spawn = null;'],
        '简写属性 { spawn }': [CPD, 'const o = { spawn };'],
        '计算属性键 { [spawn]: 1 }（键是对 spawn 的引用）': [CPD, 'const o = { [spawn]: 1 };'],
        '序列表达式 (0, spawn)(…)': [CPD, "(0, spawn)('git', ['status']);"],
        'new spawn()': [CPD, 'new spawn();'],
        'typeof spawn': [CPD, 'void typeof spawn;'],
        'spawnSync.call(…)（取成员）': [CPD, "spawnSync.call(null, 'git', ['status']);"],
        '同名内层参数 function (spawn)（按名字判定，宁可误红）': [CPD, 'function inner(spawn) { return spawn; }'],
        "require('worker_threads')": [CPD, "require('worker_threads');"],
        "require('node:worker_threads')": [CPD, "require('node:worker_threads');"],
        "require('cluster')": [CPD, "require('cluster');"],
        "require('node:cluster')": [CPD, "require('node:cluster');"],
        "import('worker_threads')": [CPD, "import('worker_threads');"],
        "import('node:cluster')": [CPD, "import('node:cluster');"],
    };
    const bindRedBad = Object.entries(bindRed).map(([k, [cpLine, body]]) => ({ k, sg: uniqSig(runBind(cpLine, body)) })).filter((x) => x.sg !== BIND1);
    check('S.44a', `SELF_ISOLATED child_process 绑定形态各判红 BINDING（${Object.keys(bindRed).length} 种：整体赋值 / 取成员 / 改名 / 默认值 / rest / 计算键 / 嵌套 / 名单外名字 / import() / promisify / 再赋值 / 传参 / 覆盖 / 简写 / 序列 / new / typeof / call / 内层同名 / worker_threads·cluster 各形态）`, bindRedBad.length === 0, bindRedBad.slice(0, 6));
    const bindGreen = {
        '只解构 spawn 且只作被调用': ["const { spawn } = require('child_process');", "spawn('git', ['status']);"],
        '四个名字齐全（node: 前缀）都只作被调用': ["const { spawn, spawnSync, execFile, execFileSync } = require('node:child_process');", "spawn('git', ['status']);\nspawnSync('taskkill', ['/F']);\nexecFile('powershell', ['-NoProfile']);\nexecFileSync(process.execPath, [__filename]);"],
        'spawnSync 起自调用': ["const { spawnSync } = require('child_process');", 'spawnSync(process.execPath, [__filename]);'],
        '可选调用 spawn?.(…) 也是 callee': ["const { spawn } = require('child_process');", "spawn?.('git', ['status']);"],
        '空解构（不绑定任何名字）': ["const {} = require('child_process');", 'void 0;'],
        '同名只出现在非引用位置：对象字面量键 / 成员属性 / 解构源的键 / 类方法名 / 标签': ["const { spawn } = require('child_process');", "const o = { spawn: 1 };\no.spawn = 2;\nconst { spawn: other } = o;\nclass K { spawn() { return other; } }\nspawn: while (false) { break spawn; }\nspawn('git', ['status']);"],
    };
    const bindGreenBad = Object.entries(bindGreen).map(([k, [cpLine, body]]) => ({ k, sg: sig(runBind(cpLine, body)) })).filter((x) => x.sg !== OK_SIG);
    check('S.44b', 'SELF_ISOLATED child_process 合法绑定判绿：三种合法解构（含 node: 前缀、四个名字齐全）· 只作被调用（含可选调用）· 空解构 · 同名只出现在非引用位置', bindGreenBad.length === 0, bindGreenBad);
    const bindEv = runBind('const cp = require(\'child_process\');', 'void cp;').problems.find((p) => p.rule === 'BINDING');
    check('S.44c', 'BINDING 证据带行号与原文：「<行号>:<该行原文> | …(@L行号)…」，不再出现 @偏移', !!bindEv && /^1:const cp = require\('child_process'\);/.test(bindEv.evidence) && /@L1/.test(bindEv.evidence) && !/@\d{3,}/.test(bindEv.evidence), bindEv);
    // BINDING 与 MIGRATED 并存、与冲突：并存时同样执行；冲突（并存 EXEMPT 等）时不再报 BINDING
    const bindMig = ev({ 'm.js': afterFx(SRC.good, cat("const cp = require('child_process');\nconst ENTRY = '", SJS, "';")) }, { mig: MIG, selfIso: { 'm.js': '自带隔离机制' } });
    check('S.44d', 'MIGRATED + SELF_ISOLATED 并存时 BINDING 同样执行（整体赋值 child_process → 恰判红 SELF_ISOLATED|BINDING，MIGRATED 部分照常判绿）', uniqSig(bindMig) === want('m.js|SELF_ISOLATED|BINDING'), uniqSig(bindMig));
    const bindConflict = ev({ 'si.js': bindSrc("const cp = require('child_process');", 'void cp;') }, { selfIso: SI, exempt: { 'si.js': '豁免' } });
    check('S.44e', '与 EXEMPT 并存（CONFLICT）时不再报 BINDING（并存的文件只报冲突这一条）', sig(bindConflict) === want('si.js|SELF_ISOLATED|CONFLICT'), sig(bindConflict));

    // ---- 硬门③：T3 窄豁免（只豁免 sink 外、require 类实参外、普通字符串字面量且值恰为入口名）
    const t3Red = {
        '模板串 `${copyRoot}/<入口>`': cat('const T = `${copyRoot}/', SJS, '`;'),
        '无表达式的模板串 `<入口>`（不是普通字符串字面量）': cat('const T = `', SJS, '`;'),
        "命令串 'node <入口> --x'": cat("const C = 'node ", SJS, " --x';"),
        "路径形态 '../<入口>'（值不是裸入口名）": cat("const R = '../", SJS, "';"),
        "路径形态 'wbs-server/<入口>'": cat("const R = 'wbs-server/", SJS, "';"),
        'sink 实参里的裸字面量（数组第二位）': cat("spawnSync(process.execPath, [__filename, '", SJS, "']);"),
        "require 实参里的 require('<入口>')": cat("require('", SJS, "');"),
    };
    const t3Bad = Object.entries(t3Red).map(([k, body]) => ({ k, sg: sig(runSi(body)) })).filter((x) => x.sg !== one('T3', 'si.js'));
    check('S.37a', 'SELF_ISOLATED 的 T3 只豁免裸字面量一种：模板串 / 无表达式模板串 / 命令串 / 路径形态 / sink 实参里的 / require 实参里的，各恰判红 OTHER|T3', t3Bad.length === 0, t3Bad);
    const sinkFirst = sig(runSi(cat("spawnSync(process.execPath, ['", SJS, "']);")));
    check('S.37b', "sink 实参里的裸字面量同时是 T3 与 SPAWN_FORM（首元素不是 F1 / F2 / F3）：spawnSync(process.execPath, ['<入口>']) → 完整签名 T3 + SPAWN_FORM", sinkFirst === want('si.js|OTHER|T3', 'si.js|SELF_ISOLATED|SPAWN_FORM'), sinkFirst);
    // 对照：同样的裸字面量，文件没登记 SELF_ISOLATED 时照旧判红 T3（豁免是登记带来的，不是通用放行）
    const unreg = ev({ 'si.js': siSrc('void 0;') });
    check('S.37c', '对照：同一份源码没登记 SELF_ISOLATED → 裸字面量照旧判红 OTHER|T3（豁免只对登记文件）', sig(unreg) === one('T3', 'si.js'), sig(unreg));

    // ---- 硬门①：只登记 SELF_ISOLATED 的文件按「其余」口径 Tier-1 全部零命中（T4 也必须为零）
    const t1Forms = {
        T1: cat("const BASE = '", URL3K, "';"),
        T2: cat("const p = path.join(__dirname, '..', 'task_pool", ".db');"),
        T5: 'const u = process.env.TEST_BASE_URL;',
        T4: "const te = require('./lib/test-env');",
    };
    const t1Bad = Object.entries(t1Forms).map(([code, body]) => ({ code, sg: sig(runSi(body)) })).filter((x) => x.sg !== one(x.code, 'si.js'));
    check('S.38a', 'SELF_ISOLATED 硬门①：只登记 SELF_ISOLATED 的文件里 T1 写死 3000 / T2 业务库路径 / T5 直接读测试变量 / T4 用了 test-env，各恰判红 OTHER|<代号>（用了 test-env 就该登记 MIGRATED）', t1Bad.length === 0, t1Bad);

    // ---- 过期 / 理由 / 不存在
    const staleNoLit = ev({ 'si.js': cat(CP, 'spawnSync(process.execPath, [__filename]);\n') }, { selfIso: SI });
    const staleNoCp = ev({ 'si.js': cat("const ENTRY = '", SJS, "';\n") }, { selfIso: SI });
    const staleBoth = ev({ 'si.js': 'module.exports = 1;\n' }, { selfIso: SI });
    const STALE1 = want('si.js|SELF_ISOLATED|STALE');
    check('S.39a', 'SELF_ISOLATED 过期：没有任何被豁免的裸字面量（有 child_process）→ 恰判红 STALE', sig(staleNoLit) === STALE1, sig(staleNoLit));
    check('S.39b', 'SELF_ISOLATED 过期：没有 require child_process（有裸字面量）→ 恰判红 STALE', sig(staleNoCp) === STALE1, sig(staleNoCp));
    check('S.39c', 'SELF_ISOLATED 过期：两样都没有 → 一条 STALE（证据里两个原因都写）', sig(staleBoth) === STALE1 && /裸字面量/.test(staleBoth.problems[0].evidence) && /child_process/.test(staleBoth.problems[0].evidence), staleBoth.problems);
    const ghost = ev({ 'ok.js': SRC.clean }, { selfIso: { 'ghost.js': '理由' } });
    const blank = ev({ 'si.js': siSrc('void 0;') }, { selfIso: { 'si.js': '   ' } });
    check('S.39d', 'SELF_ISOLATED 登记不存在的文件 → 判红 STALE；理由为空白 → 判红 REASON', sig(ghost) === want('ghost.js|SELF_ISOLATED|STALE') && sig(blank) === want('si.js|SELF_ISOLATED|REASON'), { a: sig(ghost), b: sig(blank) });
    const noKey = G.evaluate({ files: ['a.js'], read: () => SRC.clean, registry: { MIGRATED: {}, EXEMPT_NO_READY: {}, EXEMPT: {}, INFRA: {}, SOURCE_READERS: {}, DB_PATH_ASSERTERS: {} }, baseline: EMPTY_BASELINE, familyNames: new Set() });
    check('S.39e', '登记表缺少 SELF_ISOLATED 对象 → 判红 (登记表)|REGISTRY|FORMAT（不静默当空）', sig(noKey) === want('(登记表)|REGISTRY|FORMAT'), sig(noKey));

    // ---- 互斥：与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线任一并存 → SELF_ISOLATED|CONFLICT（并存的文件只报这一条，不再跑它的 SELF_ISOLATED 硬规则）
    const body = siSrc(cat("const D = path.join(__dirname, '..', 'task_pool", ".db');\nspawnSync('python', ['x.py']);"));   // 同时带一处 T2 与一处不合格 sink：证明冲突时不再报 SPAWN_FORM / T2 以外的 SELF_ISOLATED 问题
    const cEx = ev({ 'si.js': body }, { selfIso: SI, exempt: { 'si.js': '豁免' } });
    const cInfra = ev({ 'si.js': body }, { selfIso: SI, infra: { 'si.js': '基础设施' }, infraAllowed: ['si.js'] });
    const cRdr = ev({ 'si.js': siSrc('void 0;') }, { selfIso: SI, readers: { 'si.js': RD_REASON } });
    const cBl = ev({ 'si.js': siSrc('void 0;') }, { selfIso: SI, baseline: bl({ 'si.js': ['T3'] }) });
    const CONFLICT1 = want('si.js|SELF_ISOLATED|CONFLICT');
    check('S.40a', 'SELF_ISOLATED + EXEMPT → 恰判红 CONFLICT（EXEMPT 不扫内容，不再叠加 SPAWN_FORM）', sig(cEx) === CONFLICT1, sig(cEx));
    check('S.40b', 'SELF_ISOLATED + INFRA → 恰判红 CONFLICT', sig(cInfra) === CONFLICT1, sig(cInfra));
    check('S.40c', 'SELF_ISOLATED + SOURCE_READERS → 判红 CONFLICT（另按 SOURCE_READERS 自己的硬门因 require child_process 判红 SPAWN；整组签名全等）', sig(cRdr) === want('si.js|SELF_ISOLATED|CONFLICT', 'si.js|SOURCE_READERS|SPAWN'), sig(cRdr));
    check('S.40d', 'SELF_ISOLATED + 未迁移基线 → 恰判红 CONFLICT（基线条目自己的冻结检查照常，这里冻结 T3 与实际命中相等所以无别的问题）', sig(cBl) === CONFLICT1, sig(cBl));
    check('S.40e', '冲突证据点名并存的类（EXEMPT / INFRA / SOURCE_READERS / 未迁移基线）', [cEx, cInfra, cRdr, cBl].map((r, i) => r.problems.find((p) => p.rule === 'CONFLICT' && p.evidence.includes(['EXEMPT', 'INFRA', 'SOURCE_READERS', '未迁移基线'][i]))).every(Boolean), null);
    const cAll = ev({ 'si.js': body }, { selfIso: SI, exempt: { 'si.js': '豁免' }, infra: { 'si.js': '基础设施' }, infraAllowed: ['si.js'], readers: { 'si.js': RD_REASON } });
    check('S.40f', '同时与多类并存：一个文件一条 CONFLICT，证据里把并存的类都点名', cAll.problems.filter((p) => p.rule === 'CONFLICT').length === 1 && /EXEMPT/.test(cAll.problems.find((p) => p.rule === 'CONFLICT').evidence) && /INFRA/.test(cAll.problems.find((p) => p.rule === 'CONFLICT').evidence) && /SOURCE_READERS/.test(cAll.problems.find((p) => p.rule === 'CONFLICT').evidence), cAll.problems.map((p) => `${p.cls}|${p.rule}`));

    // ---- MIGRATED + SELF_ISOLATED：按 MIGRATED 口径（分析器 R1–R7 + Tier-1 补充命中）；R3 只豁免裸字面量；与 SELF_ISOLATED 的 sink 形态 / 过期硬规则叠加
    const migBase = (extraDecl, extraStmt) => {
        let s = afterFx(SRC.good, cat("const { spawnSync } = require('child_process');\nconst ENTRY = '", SJS, "';", extraDecl ? `\n${extraDecl}` : ''));
        if (extraStmt) s = afterReady(s, extraStmt);
        return s;
    };
    const MIG_SI = { mig: MIG, selfIso: { 'm.js': '自带隔离机制' } };
    const mGreen = ev({ 'm.js': migBase(null, 'spawnSync(process.execPath, [__filename]);') }, MIG_SI);
    check('S.41a', 'MIGRATED + SELF_ISOLATED 并存合法：裸字面量不报 R3，F1 起 node 判绿，计 migrated=1 selfIsolated=1', mGreen.problems.length === 0 && mGreen.counts.migrated === 1 && mGreen.counts.selfIsolated === 1, sig(mGreen));
    const mCtl = ev({ 'm.js': migBase(null, 'spawnSync(process.execPath, [__filename]);') }, { mig: MIG });
    check('S.41b', '对照：同一份源码只登记 MIGRATED（没登记 SELF_ISOLATED）→ 裸字面量照旧判红 R3', sig(mCtl) === want('m.js|MIGRATED|R3'), sig(mCtl));
    const mRed = {
        "路径形态 'wbs-server/<入口>' 的 R3 不被豁免": [cat("const R = 'wbs-server/", SJS, "';"), null, want('m.js|MIGRATED|R3')],
        "'../<入口>' 的 R3 不被豁免": [cat("const R = '../", SJS, "';"), null, want('m.js|MIGRATED|R3')],
        '模板串 `${__dirname}/<入口>` 判红 MIGRATED/T3': [cat('const T = `${__dirname}/', SJS, '`;'), null, want('m.js|MIGRATED|T3')],
        '无表达式模板串 `<入口>` 判红 MIGRATED/T3': [cat('const T = `', SJS, '`;'), null, want('m.js|MIGRATED|T3')],
        'sink 实参里的裸字面量仍判红 R3（另因首元素不合格 SPAWN_FORM）': [null, cat("spawnSync(process.execPath, ['", SJS, "']);"), want('m.js|MIGRATED|R3', 'm.js|SELF_ISOLATED|SPAWN_FORM')],
        'sink 实参里的裸字面量（F1 之后的元素）仍判红 R3': [null, cat("spawnSync(process.execPath, [__filename, '", SJS, "']);"), want('m.js|MIGRATED|R3')],
        '不合格 sink（fork）判红 SPAWN_FORM（取成员的绑定形态另判红 BINDING）': [null, 'require(\'child_process\').fork(__filename);', want('m.js|SELF_ISOLATED|BINDING', 'm.js|SELF_ISOLATED|SPAWN_FORM')],
    };
    const mRedBad = Object.entries(mRed).map(([k, [decl, stmt, expect]]) => ({ k, sg: sig(ev({ 'm.js': migBase(decl, stmt || 'spawnSync(process.execPath, [__filename]);') }, MIG_SI)), expect })).filter((x) => x.sg !== x.expect);
    check('S.41c', 'MIGRATED + SELF_ISOLATED：R3 只豁免裸字面量——路径形态 / 模板串 / sink 实参里的各恰判红；不合格 sink 形态叠加判红（整组签名全等）', mRedBad.length === 0, mRedBad);
    const mStale = ev({ 'm.js': SRC.good }, MIG_SI);
    check('S.41d', 'MIGRATED + SELF_ISOLATED 过期：既没有裸字面量也没有 child_process → 恰判红 SELF_ISOLATED/STALE（MIGRATED 部分照常判绿）', sig(mStale) === want('m.js|SELF_ISOLATED|STALE'), sig(mStale));

    // ---- 计数 / 输出
    const okR = runSi('void 0;');
    const rep = G.formatReport(okR);
    check('S.42a', '计数与输出：合法的 SELF_ISOLATED 文件计 selfIsolated=1、归「其余」类 other=1，OK 行含 selfIsolated=1', okR.problems.length === 0 && okR.counts.selfIsolated === 1 && okR.counts.other === 1 && rep.code === 0 && / sourceReaders=0 selfIsolated=1 dbPathAsserters=0$/.test(rep.lines[0]), { c: okR.counts, line: rep.lines[0] });

    // ---- 缩表：SELF_ISOLATED 登记后，--shrink-baseline 删掉它的基线条目；登记不合格时拒绝
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-tis-si-'));
    const made = [];
    try {
        const put = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); made.push(f); return f; };
        const regSi = Object.assign(emptyReg(), { SELF_ISOLATED: { 'si.js': '自带隔离机制' } });
        const goodBody = siSrc('void 0;');
        const f1 = put('si-shrink-ok.json', G.baselineText(bl({ 'si.js': ['T3'], 'other.js': ['T1'] })));
        const s1 = G.shrinkBaseline({ files: ['si.js', 'other.js'], read: (n) => (n === 'si.js' ? goodBody : SRC.t1Url), registry: regSi, familyNames: new Set() }, f1);
        const a1 = JSON.parse(fs.readFileSync(f1, 'utf8'));
        check('S.43a', '--shrink-baseline：文件已登记 SELF_ISOLATED 且合规 → 删掉它的基线条目（si.js:T3），其余条目不动（maxEntries 降到 1）', s1.ok === true && s1.changed === true && JSON.stringify(a1.entries) === JSON.stringify({ 'other.js': ['T1'] }) && a1.maxEntries === 1, { s1, a1 });
        const f2 = put('si-shrink-bad.json', G.baselineText(bl({ 'si.js': ['T3'] })));
        const h2 = sha(f2);
        const s2 = G.shrinkBaseline({ files: ['si.js'], read: () => siSrc("spawnSync('python', ['x.py']);"), registry: regSi, familyNames: new Set() }, f2);
        check('S.43b', '--shrink-baseline：文件登记 SELF_ISOLATED 但含不合格 sink → 候选基线完整检查不过，拒绝写入，基线字节不变', s2.ok === false && sha(f2) === h2 && s2.lines.some((l) => /SELF_ISOLATED \| SPAWN_FORM/.test(l)), s2);
        const h1b = sha(f1);
        const s3 = G.shrinkBaseline({ files: ['si.js', 'other.js'], read: (n) => (n === 'si.js' ? goodBody : SRC.t1Url), registry: regSi, familyNames: new Set() }, f1);
        check('S.43c', '--shrink-baseline 幂等：再跑一次「无变化」，基线字节不变', s3.ok === true && s3.changed === false && sha(f1) === h1b, s3);
    } finally {
        for (const f of made) { try { fs.unlinkSync(f); } catch (_) { /* 已不存在 */ } }
        try { fs.rmdirSync(tmp); } catch (_) { /* 留给系统临时目录清理 */ }
    }
}

/** H：DB_PATH_ASSERTERS 必须为空 */
function sectionDbPathAsserters() {
    const AS = { 'as.js': '只读算业务库指纹，不打开' };
    const rYes = ev({ 'as.js': SRC.t2Db }, { asserters: AS });
    const rGhost = ev({ 'ok.js': SRC.clean }, { asserters: { 'ghost.js': 'r' } });
    check('S.20a', 'DB_PATH_ASSERTERS 非空即判红 NOT_EMPTY（即使文件存在、理由写全）；登记不存在的文件同样判红 NOT_EMPTY', sig(rYes).split(',').includes('as.js|DB_PATH_ASSERTERS|NOT_EMPTY') && sig(rGhost) === want('ghost.js|DB_PATH_ASSERTERS|NOT_EMPTY'), { a: sig(rYes), b: sig(rGhost) });
    const rEmpty = ev({ 'as.js': SRC.clean });
    check('S.20b', '对照：DB_PATH_ASSERTERS 为空判绿，计数 dbPathAsserters=0；未登记文件里的业务库路径字面量照旧判红 T2', rEmpty.problems.length === 0 && rEmpty.counts.dbPathAsserters === 0 && sig(ev({ 'as.js': SRC.t2Db })) === one('T2', 'as.js'), sig(rEmpty));
}

/** C / D：基线写入、格式、换入、半迁移 */
function sectionBaselineFiles() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-tis-'));
    const made = [];
    const put = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); made.push(f); return f; };
    const reserve = (name) => { const f = path.join(tmp, name); made.push(f); return f; };   // 先登记再让被测代码创建：守卫被变异成「不拒绝」时它会真的创建文件
    try {
        const reg = emptyReg();
        const mk = (files, extra) => Object.assign({ files: Object.keys(files), read: (n) => files[n], registry: reg, familyNames: new Set() }, extra || {});
        const start = bl({ 'a.js': ['T1'], 'b.js': ['T1', 'T2'] });
        const f1 = put('base1.json', G.baselineText(start));
        const h1 = sha(f1);
        const s1 = G.shrinkBaseline(mk({ 'a.js': SRC.t1t3, 'b.js': SRC.t1Url }), f1);
        check('S.10a', '--shrink-baseline：重算结果里基线文件多出规则（a.js 冻结 T1，实际 T1+T3）→ 拒绝写入，基线文件 sha256 前后相同', s1.ok === false && s1.lines.some((l) => /a\.js.*T3/.test(l)) && sha(f1) === h1, { s1, same: sha(f1) === h1 });
        const s2 = G.shrinkBaseline(mk({ 'a.js': SRC.t1Url, 'b.js': SRC.t1Url, 'c.js': SRC.t2Db }), f1);
        check('S.10b', '--shrink-baseline：重算结果里出现基线没有的文件（c.js 命中 T2）→ 在「重算」这一步就拒绝（首行点名「基线没有的文件」，不是靠后面的候选检查兜底），基线文件 sha256 前后相同', s2.ok === false && /重算结果里有基线没有的文件/.test(s2.lines[0]) && s2.lines.some((l) => /c\.js/.test(l)) && sha(f1) === h1, { s2, same: sha(f1) === h1 });
        const s3 = G.shrinkBaseline(mk({ 'a.js': SRC.clean, 'b.js': SRC.t1Url, 'c.js': SRC.clean }), f1);
        const after = JSON.parse(fs.readFileSync(f1, 'utf8'));
        check('S.10c', '对照：--shrink-baseline 在违规消失 / 少一条规则时写回缩小后的基线（删条目 a.js、删规则 b.js:T2；maxEntries 降到 1；createdAt / createdAtHead 不变）',
            s3.ok === true && s3.changed === true && JSON.stringify(after.entries) === JSON.stringify({ 'b.js': ['T1'] }) && after.maxEntries === 1 && after.createdAt === 'T0' && after.createdAtHead === 'H0' && sha(f1) !== h1, { s3, after });
        const h3 = sha(f1);
        const s4 = G.shrinkBaseline(mk({ 'a.js': SRC.clean, 'b.js': SRC.t1Url, 'c.js': SRC.clean }), f1);
        check('S.10d', '对照：再跑一次 --shrink-baseline 无变化，基线字节不变', s4.ok === true && s4.changed === false && sha(f1) === h3, s4);
        const i1 = G.initBaseline(mk({ 'a.js': SRC.t1Url }), f1, 'HEADSHA', 'NOW');
        check('S.10e', '--init-baseline：基线文件已存在 → 拒绝，基线文件 sha256 前后相同', i1.ok === false && sha(f1) === h3, i1);
        const f2 = reserve('base2.json');
        const i2 = G.initBaseline(mk({ 'z.js': SRC.t1t2, 'y.js': SRC.t4Fx, 'ok.js': SRC.clean }), f2, 'HEADSHA', 'NOW');
        const init = fs.existsSync(f2) ? JSON.parse(fs.readFileSync(f2, 'utf8')) : null;
        check('S.10f', '对照：--init-baseline 在基线不存在时写入「未登记且命中」的文件（y.js:T4、z.js:T1+T2；零命中的 ok.js 不入），maxEntries = 条数，createdAtHead 取传入的 HEAD',
            i2.ok === true && init !== null && JSON.stringify(init.entries) === JSON.stringify({ 'y.js': ['T4'], 'z.js': ['T1', 'T2'] }) && init.maxEntries === 2 && init.createdAtHead === 'HEADSHA' && Object.keys(init.entries).join(',') === 'y.js,z.js', { i2, init });
        const f3 = reserve('base3.json');
        const badReg = Object.assign(emptyReg(), { EXEMPT: { 'verify-bad.js': 'r' } });
        const i3 = G.initBaseline({ files: ['verify-bad.js'], read: () => SRC.clean, registry: badReg, familyNames: new Set() }, f3, 'HEADSHA', 'NOW');
        check('S.10g', '--init-baseline：登记表层面有问题（EXEMPT 条目 verify- 开头）→ 第一阶段拒绝（首行「有 N 条问题，先修」，与后面的候选基线完整检查是两层），不创建基线文件', i3.ok === false && !fs.existsSync(f3) && /有 \d+ 条问题，先修/.test(i3.lines[0]), i3);
        const f4 = put('base4.json', G.baselineText(bl({ 'a.js': ['T1'], 'b.js': ['T1'] })));
        const regMig = Object.assign(emptyReg(), { MIGRATED: { 'a.js': {} } });
        const s5 = G.shrinkBaseline({ files: ['a.js', 'b.js'], read: (n) => (n === 'a.js' ? SRC.good : SRC.t1Url), registry: regMig, familyNames: new Set() }, f4);
        const after5 = JSON.parse(fs.readFileSync(f4, 'utf8'));
        check('S.10h', '对照：基线里的文件已登记进 MIGRATED（迁移完成）→ --shrink-baseline 删掉它的条目', s5.ok === true && JSON.stringify(after5.entries) === JSON.stringify({ 'b.js': ['T1'] }), { s5, after5 });
        // C.1：旧基线格式不合法 → 拒绝，字节不变（手加条目不改 maxEntries / 缺 maxEntries / 字符串 / 条目格式错）
        const files2 = { 'old.js': SRC.t1Url, 'sneak.js': SRC.t1Url };
        const bad = {
            sneak: { createdAt: 'T0', createdAtHead: 'H0', maxEntries: 1, entries: { 'old.js': ['T1'], 'sneak.js': ['T1'] } },
            noMax: { createdAt: 'T0', createdAtHead: 'H0', entries: { 'old.js': ['T1'], 'sneak.js': ['T1'] } },
            strMax: { createdAt: 'T0', createdAtHead: 'H0', maxEntries: '2', entries: { 'old.js': ['T1'], 'sneak.js': ['T1'] } },
            badEntry: { createdAt: 'T0', createdAtHead: 'H0', maxEntries: 2, entries: { 'old.js': ['T1'], 'zero.js': ['T9'] } },   // zero.js 零命中：不靠别的拒绝路径，只有条目格式校验能拦住
        };
        const rej = {};
        for (const [k, obj] of Object.entries(bad)) {
            const f = put(`bad-${k}.json`, `${JSON.stringify(obj, null, 2)}\n`);
            const h = sha(f);
            const r = G.shrinkBaseline(mk(k === 'badEntry' ? { 'old.js': SRC.t1Url, 'zero.js': SRC.clean } : files2), f);
            rej[k] = r.ok === false && sha(f) === h;
        }
        check('S.10i', '--shrink-baseline：旧基线非法（手加条目但没改 maxEntries / 缺 maxEntries / maxEntries 是字符串 / 条目格式错）→ 各自拒绝写入，字节不变（不把超限的旧基线洗白）', Object.values(rej).every(Boolean), rej);
        // C.2：maxEntries = min(旧, 新条数)：旧上限大于条数时即使条目没变也降下来；不会抬高
        const f5 = put('base5.json', G.baselineText({ createdAt: 'T0', createdAtHead: 'H0', maxEntries: 5, entries: { 'old.js': ['T1'] } }));
        const s6 = G.shrinkBaseline(mk({ 'old.js': SRC.t1Url }), f5);
        const after6 = JSON.parse(fs.readFileSync(f5, 'utf8'));
        check('S.10j', '--shrink-baseline：写回的 maxEntries = min(旧上限, 新条数)——旧上限 5、条目未变时降到 1', s6.ok === true && after6.maxEntries === 1, { s6, after6 });
        // C.3：写入前用候选基线跑完整检查——登记进 MIGRATED 但迁移仍不合格 → 拒绝，字节不变
        const f6 = put('base6.json', G.baselineText(bl({ 'x.js': ['T1', 'T2', 'T4'] })));
        const h6 = sha(f6);
        const regX = Object.assign(emptyReg(), { MIGRATED: { 'x.js': {} } });
        const s7 = G.shrinkBaseline({ files: ['x.js'], read: () => SRC.readyAfterSign, registry: regX, familyNames: new Set() }, f6);
        check('S.10k', '--shrink-baseline：基线文件被登记进 MIGRATED 但迁移不合格（ready 在 signAs 之后）→ 候选基线完整检查不通过，拒绝写入，字节不变', s7.ok === false && sha(f6) === h6 && s7.lines.some((l) => /R5/.test(l)), s7);
        // C.4：init 遇到 PARSE → 拒绝，不创建
        const f7 = reserve('base7.json');
        const i4 = G.initBaseline(mk({ 'broken.js': 'const = ;\n', 'ok.js': SRC.t1Url }), f7, 'HEADSHA', 'NOW');
        check('S.10l', '--init-baseline：未登记文件解析失败（PARSE，不在 T1–T5 里）→ 第一阶段点名该文件与代号（「broken.js | OTHER | PARSE | 无法写入基线…」）并拒绝，不创建基线文件', i4.ok === false && !fs.existsSync(f7) && i4.lines.some((l) => /^broken\.js \| OTHER \| PARSE \| 无法写入基线/.test(l)), i4);
        // X11：init 要求 HEAD
        const f8 = reserve('base8.json');
        const i5 = G.initBaseline(mk({ 'ok.js': SRC.t1Url }), f8, '', 'NOW');
        check('S.10m', '--init-baseline：取不到 git HEAD（空串）→ 拒绝，不创建基线文件', i5.ok === false && !fs.existsSync(f8), i5);
        // D：换入 / 半迁移（evaluate 层，blobAt 注入）
        const bOk = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => SRC.t1Url });
        const bMissing = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => null });
        const bSwap = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => SRC.clean });
        const bThrow = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => { throw new Error('boom'); } });
        check('S.22a', '防换入：条目文件在 createdAtHead 的树里命中包含冻结集合 → 判绿（对照）', bOk.problems.length === 0, sig(bOk));
        check('S.22b', '防换入：条目文件在 createdAtHead 的树里不存在 → 判红 NOTATHEAD', sig(bMissing) === want('bl.js|BASELINE|NOTATHEAD'), sig(bMissing));
        check('S.22c', '防换入：冻结集合不是该版本命中的子集（该版本零命中）→ 判红 SWAPPED', sig(bSwap) === want('bl.js|BASELINE|SWAPPED'), sig(bSwap));
        check('S.22d', '防换入：读取 createdAtHead 树失败（git 出错）→ 判红 HEADBLOB（fail-closed）', sig(bThrow) === want('bl.js|BASELINE|HEADBLOB'), sig(bThrow));
        // blob 读取器返回值既不是字符串也不是 null（undefined / 数字 / 对象 / Buffer）：判红 HEADBLOB，不再静默跳过换入检查
        const illegal = { undefined: undefined, number: 42, object: {}, buffer: Buffer.from('x'), boolean: false };
        const illegalWrong = Object.entries(illegal).map(([k, v]) => ({ k, sg: sig(ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => v })) })).filter((x) => x.sg !== want('bl.js|BASELINE|HEADBLOB'));
        const illegalEv = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }), blobAt: () => undefined }).problems.map((p) => p.evidence).join('|');
        check('S.22h', '防换入：blob 读取器返回值非法（undefined / 数字 / 对象 / Buffer / false）→ 判红 HEADBLOB「blob 读取器返回值非法」，不再静默跳过；对照：返回字符串 / null 的语义不变（S.22a–c）', illegalWrong.length === 0 && /blob 读取器返回值非法/.test(illegalEv), { illegalWrong, illegalEv });
        const bReady = ev({ 'bl.js': SRC.noCloser }, { baseline: bl({ 'bl.js': ['T4'] }) });
        const bNoReady = ev({ 'bl.js': SRC.t4Fx }, { baseline: bl({ 'bl.js': ['T4'] }) });
        check('S.22e', '半迁移不得藏在基线里：基线文件已调用 ready() → 判红 READY（只剩 T4 也躲不开）；对照：只 require 夹具、没调 ready() 的基线文件判绿', sig(bReady) === want('bl.js|BASELINE|READY') && bNoReady.problems.length === 0, { a: sig(bReady), b: sig(bNoReady) });
        const blobs = G.makeBlobReader({ execBuf: () => Buffer.from(`${'a'.repeat(40)} blob 5\nhello\n${'b'.repeat(40)} missing\n${'c'.repeat(40)} tree 3\nxyz\n`) }, 'f'.repeat(40), ['x.js', 'y.js', 'z.js']);
        const tryGet = (fn, n) => { try { return fn(n); } catch (e) { return `THROW:${e.message}`; } };
        const got = ['x.js', 'y.js', 'z.js'].map((n) => tryGet(blobs, n));
        check('S.22f', 'git cat-file --batch 输出解析：blob 取内容、missing → null、非 blob → null', got[0] === 'hello' && got[1] === null && got[2] === null, got);
        const blobBad = G.makeBlobReader({ execBuf: () => { throw new Error('nope'); } }, 'f'.repeat(40), ['x.js']);
        const blobHead = G.makeBlobReader({ execBuf: () => Buffer.from(`${'a'.repeat(40)} blob 5\nhello\n`) }, 'not-a-sha', ['x.js']);
        let t1 = false; let t2 = false;
        try { blobBad('x.js'); } catch (e) { t1 = true; }
        try { blobHead('x.js'); } catch (e) { t2 = true; }
        check('S.22g', '读树失败（cat-file 抛错 / createdAtHead 不是 40 位提交号）→ 读取函数抛错（上层判红 HEADBLOB），不静默当作文件不存在', t1 && t2, { t1, t2 });
    } finally {
        for (const f of made) { try { fs.unlinkSync(f); } catch (_) { /* 已不存在 */ } }
        try { fs.rmdirSync(tmp); } catch (_) { /* 非空则留给操作系统临时目录清理 */ }
    }
}

/** 递归删临时目录：只用 unlink / rmdir；git 对象文件在 Windows 上只读，先改权限再删 */
function removeTree(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) removeTree(full);
        else { try { fs.unlinkSync(full); } catch (e) { fs.chmodSync(full, 0o666); fs.unlinkSync(full); } }
    }
    fs.rmdirSync(dir);
}

/** E / J.1：扫描命令与扫描前提 */
function sectionScanSet() {
    const gitThrow = G.listScanSet({ exec: () => { throw new Error('boom'); } });
    const gitMissingBin = G.listScanSet({ gitBin: path.join(os.tmpdir(), 'no-such-dir-sdh', 'no-such-git.exe'), repoRoot: os.tmpdir() });
    const gitEmpty = G.listScanSet({ exec: () => '' });
    const gitOk = G.listScanSet({ exec: () => 'wbs-server/scripts/a.js\0wbs-server/scripts/lib/b.js\0wbs-server/scripts/c.txt\0wbs-server/scripts/d.js\0' });
    const printed = [];
    const cliCode = G.runCli([], { exec: () => { throw new Error('boom'); }, print: (l) => printed.push(l), baselinePath: path.join(os.tmpdir(), 'no-such-baseline-sdh.json') });
    check('S.11a', 'git 调用失败（注入抛错的执行函数）→ listScanSet 失败，不回落到目录读取', gitThrow.ok === false && /git ls-files/.test(gitThrow.error) && gitThrow.names === undefined, gitThrow);
    check('S.11b', 'git 可执行文件不存在（真实执行）→ listScanSet 失败，不回落', gitMissingBin.ok === false && gitMissingBin.names === undefined, gitMissingBin);
    check('S.11c', '命令行入口：git 失败 → 输出 RED 且退出码 1（不回落、不放行）', cliCode === 1 && printed.length === 1 && /^RED verify-test-isolation-static: git ls-files/.test(printed[0]), { cliCode, printed });
    check('S.11d', '对照：git 输出为空 → 失败（扫描集合为空）；正常输出只取顶层 .js（不含 lib/ 下的、不含非 .js）', gitEmpty.ok === false && gitOk.ok === true && gitOk.names.join(',') === 'a.js,d.js', { gitEmpty, gitOk });
    // J.1：参数全等
    const calls = [];
    G.listScanSet({ exec: (bin, a) => { calls.push([bin, a]); return 'wbs-server/scripts/a.js\0'; }, repoRoot: 'R' });
    const expected = ['git', ['-C', 'R', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'wbs-server/scripts']];
    check('S.11e', '扫描命令参数全等：git -C <根> ls-files -z --cached --others --exclude-standard -- wbs-server/scripts（缺 --others 就扫不到未跟踪的新文件）', calls.length === 1 && JSON.stringify(calls[0]) === JSON.stringify(expected), calls);
    // init 的 HEAD 树硬门：git -C <根> ls-tree -z --name-only HEAD -- <基线相对仓库根的路径>——成功且空 = 不存在；成功且恰为「<路径>\0」= 存在；
    //   成功但输出是别的内容 / 非零退出码（含 128）/ 没有退出码 / 抛错 / 输出不是字符串 → 一律 error（判红，不按任何退出码推断路径缺失）；仓库根之外的路径不可能在 HEAD 树里
    const REL = 'wbs-server/scripts/lib/bl.json'; const BLP = `R:/repo/${REL}`;
    const hCalls = [];
    const hOk = (out) => ({ repoRoot: 'R:/repo', exec: (bin, a) => { hCalls.push([bin, a]); return out; } });
    const hThrow = (status) => ({ repoRoot: 'R:/repo', exec: (bin, a) => { hCalls.push([bin, a]); throw Object.assign(new Error('git failed'), status === null ? {} : { status }); } });
    const hAbsent = G.headTreeHasBaseline(hOk(''), BLP);
    const hPresent = G.headTreeHasBaseline(hOk(`${REL}\0`), BLP);
    const hOutside = G.headTreeHasBaseline(hOk(`${REL}\0`), 'D:/elsewhere/bl.json');
    check('S.11l', 'HEAD 树里有没有基线文件（ls-tree）：成功且输出为空 → 不存在；成功且输出恰为「<路径>\\0」→ 存在；仓库根之外的路径 → 不存在且不调 git；命令行参数恰为 git -C <根> ls-tree -z --name-only HEAD -- <相对路径>',
        hAbsent.exists === false && !hAbsent.error && hPresent.exists === true && !hPresent.error && hOutside.exists === false && hCalls.length === 2
        && JSON.stringify(hCalls[0]) === JSON.stringify(['git', ['-C', 'R:/repo', 'ls-tree', '-z', '--name-only', 'HEAD', '--', REL]]), { hAbsent, hPresent, hOutside, hCalls });
    const hBad = {
        '退出码 128（旧实现按它推断「路径缺失」）': G.headTreeHasBaseline(hThrow(128), BLP),
        '退出码 1': G.headTreeHasBaseline(hThrow(1), BLP),
        '没有退出码（抛错）': G.headTreeHasBaseline(hThrow(null), BLP),
        '成功但输出是别的路径': G.headTreeHasBaseline(hOk('wbs-server/scripts/lib/other.json\0'), BLP),
        '成功但输出带换行（不是 -z 形态）': G.headTreeHasBaseline(hOk(`${REL}\n`), BLP),
        '成功但输出多出一条': G.headTreeHasBaseline(hOk(`${REL}\0${REL}\0`), BLP),
        '成功但输出不是字符串（undefined）': G.headTreeHasBaseline(hOk(undefined), BLP),
        '成功但输出是 Buffer': G.headTreeHasBaseline(hOk(Buffer.from(`${REL}\0`)), BLP),
    };
    const hBadWrong = Object.entries(hBad).filter(([, r]) => !(typeof r.error === 'string' && r.exists === undefined)).map(([k, r]) => ({ k, r }));
    check('S.11p', 'HEAD 树检查 fail-closed：退出码 128 / 1 / 没有退出码 / 输出是别的路径 / 带换行 / 多出一条 / 不是字符串 / Buffer → 一律 error（判红），既不当「不存在」也不当「存在」', hBadWrong.length === 0, hBadWrong);
    // J.1：临时 git 仓库里真跑——未跟踪的写死 3000 的脚本必须被扫到并判红
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-tis-repo-'));
    try {
        const real = fs.realpathSync.native(tmp);
        const git = (...a) => { const r = spawnSync('git', ['-C', real, ...a], { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw new Error(`git ${a.join(' ')} 失败：${(r.stderr || '').slice(0, 200)}`); return r.stdout.trim(); };
        const scriptsDir = path.join(real, 'wbs-server', 'scripts');
        fs.mkdirSync(scriptsDir, { recursive: true });
        fs.writeFileSync(path.join(scriptsDir, 'tracked-ok.js'), SRC.clean);
        git('init', '-q');
        git('add', '.');
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
        const head = git('rev-parse', 'HEAD');
        const blPath = path.join(real, 'bl.json');
        fs.writeFileSync(blPath, G.baselineText({ createdAt: 'T0', createdAtHead: head, maxEntries: 0, entries: {} }));
        const opts = (out) => ({ repoRoot: real, scriptsDir, registry: emptyReg(), familyNames: [], baselinePath: blPath, print: (l) => out.push(l) });
        const out0 = []; const c0 = G.runCli([], opts(out0));
        fs.writeFileSync(path.join(scriptsDir, 'new-untracked.js'), SRC.t1Url);
        const out1 = []; const c1 = G.runCli([], opts(out1));
        check('S.11f', '真跑守卫核心（临时 git 仓库）：只有已跟踪的干净脚本时判绿；新增一个未跟踪的写死 3000 脚本后被扫到并判红 OTHER|T1', c0 === 0 && c1 === 1 && out1.some((l) => /^new-untracked\.js \| OTHER \| T1 \|/.test(l)), { c0, out0, c1, out1: out1.slice(0, 4) });
        // E：真实 git 上的前提——临时仓库本身满足四道前提（上面 c0 === 0 已含）；被忽略的 verify- 脚本的真实场景难以跨平台造，改用注入
        // 真实命令行接线（修复批 3，预筛 H2 W1 / W2）：换入检查的 blob 读取、扫描前提都得经 runCli 真的走到 git，不能只在注入的纯函数里成立
        fs.writeFileSync(blPath, G.baselineText({ createdAt: 'T0', createdAtHead: head, maxEntries: 1, entries: { 'new-untracked.js': ['T1'] } }));
        const out2 = []; const c2 = G.runCli([], opts(out2));
        check('S.11g', '真实接线（临时 git 仓库）：基线加一个**未跟踪**文件的条目（手工换入，冻结集合与当前命中相等）→ runCli 报 BASELINE/NOTATHEAD 且退出码 1（换入检查的 blob 读取经 loadRealDeps → makeBlobAt 真的走到 git cat-file）',
            c2 === 1 && out2.some((l) => /^new-untracked\.js \| BASELINE \| NOTATHEAD \|/.test(l)), { c2, out2: out2.slice(0, 4) });
        fs.unlinkSync(path.join(scriptsDir, 'new-untracked.js'));
        fs.writeFileSync(blPath, G.baselineText({ createdAt: 'T0', createdAtHead: head, maxEntries: 0, entries: {} }));
        git('config', 'core.sparseCheckout', 'true');
        const out3 = []; const c3 = G.runCli([], opts(out3));
        git('config', '--unset', 'core.sparseCheckout');
        check('S.11h', '真实接线（临时 git 仓库）：git config core.sparseCheckout true → runCli 报 (扫描前提)|SCAN|SPARSE 且退出码 1（扫描前提真的经 checkScanPreconditions 走到 git）；关掉后恢复判绿',
            c3 === 1 && out3.some((l) => /^\(扫描前提\) \| SCAN \| SPARSE \|/.test(l)) && G.runCli([], opts([])) === 0, { c3, out3: out3.slice(0, 4) });
        // init 的 HEAD 树硬门：基线文件已提交进 HEAD，从工作树删掉后再 init → 拒绝（否则新违规会整体被新基线吸收）
        git('add', 'bl.json');
        git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'bl');
        fs.unlinkSync(blPath);
        const out4 = []; const c4 = G.runCli(['--init-baseline'], opts(out4));
        check('S.11i', '--init-baseline 硬门：HEAD 树里已经有基线文件（已提交，工作树里删掉了）→ 拒绝，退出码 1，基线文件保持不存在（git ls-tree -z 真跑）',
            c4 === 1 && out4.some((l) => /HEAD 树里已经有基线文件/.test(l)) && !fs.existsSync(blPath), { c4, out4: out4.slice(0, 3) });
        // 对照：HEAD 树里没有的路径 → init 成功；随后 shrink 无变化
        const bl2 = path.join(real, 'bl2.json');
        const out5 = []; const c5 = G.runCli(['--init-baseline'], Object.assign(opts(out5), { baselinePath: bl2 }));
        const head2 = git('rev-parse', 'HEAD');
        const init2 = fs.existsSync(bl2) ? JSON.parse(fs.readFileSync(bl2, 'utf8')) : null;
        const out6 = []; const c6 = G.runCli(['--shrink-baseline'], Object.assign(opts(out6), { baselinePath: bl2 }));
        check('S.11j', '对照（真实 git）：HEAD 树里没有的基线路径 init 成功（entries 为空、createdAtHead = 当前 HEAD），随后 --shrink-baseline 无变化退出码 0',
            c5 === 0 && init2 !== null && init2.createdAtHead === head2 && JSON.stringify(init2.entries) === '{}' && c6 === 0 && out6.some((l) => /无变化/.test(l)), { c5, out5, init2, c6, out6 });
        // 符号链接前提的接线：注入的 lstat 经 runCli → loadRealDeps → checkScanPreconditions 带着扫描集合的文件名单真的用上（lstat 把已跟踪的 tracked-ok.js 说成链接 → 报 SYMLINK）
        const out8 = []; const c8 = G.runCli([], Object.assign(opts(out8), { baselinePath: bl2, lstat: (p) => ({ isSymbolicLink: () => /tracked-ok\.js$/.test(String(p)) }) }));
        check('S.11m', '真实接线（临时 git 仓库）：runCli 把注入的 lstat 和扫描集合文件名单交给扫描前提——lstat 说 tracked-ok.js 是链接 → 报 (扫描前提)|SCAN|SYMLINK 且退出码 1',
            c8 === 1 && out8.some((l) => /^\(扫描前提\) \| SCAN \| SYMLINK \|.*tracked-ok\.js/.test(l)), { c8, out8: out8.slice(0, 4) });
        // HEAD 树检查本身失败（cat-file 以退出码 1 失败，既不是存在也不是找不到路径）→ init 拒绝（fail-closed），不创建基线文件
        const bl4 = path.join(real, 'bl4.json');
        const realExec = (bin, a) => { const r = spawnSync(bin, a, { encoding: 'utf8', windowsHide: true }); if (r.status !== 0) throw Object.assign(new Error(String(r.stderr || 'git failed')), { status: r.status }); return r.stdout; };
        const lsFails = (status) => (bin, a) => { if (a.includes('ls-tree')) throw Object.assign(new Error('boom'), { status }); return realExec(bin, a); };
        const out9 = []; const c9 = G.runCli(['--init-baseline'], Object.assign(opts(out9), { baselinePath: bl4, exec: lsFails(1) }));
        const out9b = []; const c9b = G.runCli(['--init-baseline'], Object.assign(opts(out9b), { baselinePath: bl4, exec: lsFails(128) }));
        check('S.11n', '--init-baseline 硬门 fail-closed：HEAD 树检查本身失败（git ls-tree 退出码 1，以及 128——不再当「路径缺失」放行）→ 拒绝并点名「判红」，退出码 1，基线文件保持不存在',
            c9 === 1 && c9b === 1 && !fs.existsSync(bl4) && out9.some((l) => /^REFUSED verify-test-isolation-static --init-baseline: git ls-tree .*失败（判红/.test(l)) && out9b.some((l) => /^REFUSED verify-test-isolation-static --init-baseline: git ls-tree .*失败（判红/.test(l)), { c9, c9b, out9: out9.slice(0, 3), out9b: out9b.slice(0, 3) });
        // git log 取不到 HEAD（head 为空）：真实命令行 init 路径上，HEAD 树硬门因 head 为空被跳过，但 initBaseline 对空 head 直接拒绝（没有取到 git HEAD），基线文件不创建
        const logFails = (bin, a) => { if (a[2] === 'log') throw Object.assign(new Error('no head'), { status: 128 }); return realExec(bin, a); };
        const bl5 = path.join(real, 'bl5.json');
        const out10 = []; const c10 = G.runCli(['--init-baseline'], Object.assign(opts(out10), { baselinePath: bl5, exec: logFails }));
        check('S.11o', '--init-baseline：git log 失败（取不到 HEAD，head 为空）→ 退出码 1，输出「没有取到 git HEAD」，基线文件不创建（下游 initBaseline 拒绝，HEAD 树硬门被跳过不影响）', c10 === 1 && !fs.existsSync(bl5) && out10.some((l) => /没有取到 git HEAD/.test(l)), { c10, out10: out10.slice(0, 3) });
        // init 候选要过完整检查：未跟踪且有违规的脚本 → 候选基线含它 → NOTATHEAD → 拒绝，不创建基线文件（15-R [7]）
        fs.writeFileSync(path.join(scriptsDir, 'new-untracked2.js'), SRC.t1Url);
        const bl3 = path.join(real, 'bl3.json');
        const out7 = []; const c7 = G.runCli(['--init-baseline'], Object.assign(opts(out7), { baselinePath: bl3 }));
        check('S.11k', '--init-baseline 先过完整检查：未跟踪且有违规的脚本（候选基线含它，createdAtHead 的树里没有）→ 拒绝，退出码 1，基线文件保持不存在，输出点名 NOTATHEAD',
            c7 === 1 && !fs.existsSync(bl3) && out7.some((l) => /new-untracked2\.js \| BASELINE \| NOTATHEAD/.test(l)), { c7, out7: out7.slice(0, 4) });
    } finally { try { removeTree(tmp); } catch (_) { /* 清理失败不影响断言；留给系统临时目录 */ } }
    // E：扫描前提，注入的 exec 逐条
    const ROOT = 'C:/proj/x';
    const good = {
        'rev-parse --show-toplevel': 'C:/proj/x\n',
        'ls-files -s -z -- wbs-server/scripts': '100644 abc 0\twbs-server/scripts/a.js\0',
        'config --get --bool core.sparseCheckout': Object.assign(new Error('exit 1'), { status: 1 }),
        'ls-files -z -o -i --exclude-standard -- wbs-server/scripts': '',
        'ls-files -z --cached --others --exclude-standard -- wbs-server/scripts/_archive': '',
    };
    const mkExec = (over) => { const m = Object.assign({}, good, over || {}); return (bin, a) => { const key = a.slice(2).join(' '); if (!(key in m)) throw new Error(`unexpected ${key}`); const v = m[key]; if (v instanceof Error) throw v; return v; }; };
    const lstOk = () => ({ isSymbolicLink: () => false });
    const SCR = `${ROOT}/wbs-server/scripts`;
    const norm = (p) => String(p).replace(/\\/g, '/');
    const pre = (over, names, lstat) => G.checkScanPreconditions({ exec: mkExec(over), repoRoot: ROOT, scriptsDir: SCR, lstat: lstat || lstOk }, names || []).map((p) => p.rule).sort().join(',');
    check('S.23a', '扫描前提：四道全满足（仓库根 = 项目根、无符号链接 / 子模块、未开稀疏检出、无被忽略的 verify- 脚本）→ 无问题（对照）', pre() === '', pre());
    check('S.23b', '扫描前提：仓库根 ≠ 项目根 → TOPLEVEL；rev-parse 失败 → TOPLEVEL', pre({ 'rev-parse --show-toplevel': 'D:/other\n' }) === 'TOPLEVEL' && pre({ 'rev-parse --show-toplevel': new Error('x') }) === 'TOPLEVEL', [pre({ 'rev-parse --show-toplevel': 'D:/other\n' }), pre({ 'rev-parse --show-toplevel': new Error('x') })]);
    check('S.23c', '扫描前提：scripts/ 下有符号链接（120000）或子模块（160000）入口 → SYMLINK', pre({ 'ls-files -s -z -- wbs-server/scripts': '120000 abc 0\twbs-server/scripts/l.js\0' }) === 'SYMLINK' && pre({ 'ls-files -s -z -- wbs-server/scripts': '160000 abc 0\twbs-server/scripts/sub\0' }) === 'SYMLINK', null);
    check('S.23d', '扫描前提：开了稀疏检出（输出 true）、git 配置读取以退出码 128 失败 → SPARSE；退出码 1（配置项不存在）= 未开启，不报', pre({ 'config --get --bool core.sparseCheckout': 'true\n' }) === 'SPARSE' && pre({ 'config --get --bool core.sparseCheckout': Object.assign(new Error('x'), { status: 128 }) }) === 'SPARSE', null);
    check('S.23e', '扫描前提：被忽略的顶层 .js 以 verify- / test- / smoke- 开头（不分大小写）→ IGNORED；子目录里的、其他前缀的不报', pre({ 'ls-files -z -o -i --exclude-standard -- wbs-server/scripts': 'wbs-server/scripts/Verify-x.js\0' }) === 'IGNORED'
        && pre({ 'ls-files -z -o -i --exclude-standard -- wbs-server/scripts': 'wbs-server/scripts/lib/verify-x.js\0wbs-server/scripts/helper.js\0' }) === '', null);
    // 修复批 3（15-R [6]）：索引模式看不到未暂存的链接——对 scripts 目录本身和扫描集合里每个顶层 .js 做工作树 lstat
    const lstFile = (bad) => (p) => ({ isSymbolicLink: () => norm(p).endsWith(bad) });
    check('S.33a', '扫描前提（工作树 lstat）：扫描集合里某个顶层 .js 是符号链接 / junction（索引里仍是普通文件）→ SYMLINK；对照：同样的名字单子、lstat 全返回非链接 → 无问题',
        pre(null, ['a.js', 'b.js'], lstFile('/b.js')) === 'SYMLINK' && pre(null, ['a.js', 'b.js'], lstOk) === '', [pre(null, ['a.js', 'b.js'], lstFile('/b.js')), pre(null, ['a.js', 'b.js'], lstOk)]);
    check('S.33b', '扫描前提（工作树 lstat）：scripts 目录本身是符号链接 / junction → SYMLINK（即使名字单子为空）', pre(null, [], lstFile('wbs-server/scripts')) === 'SYMLINK', pre(null, [], lstFile('wbs-server/scripts')));
    check('S.33c', '扫描前提（工作树 lstat）：lstat 失败（文件消失 / 无权限）→ 判红 SYMLINK（fail-closed），目录与文件两处各自成立',
        pre(null, ['a.js'], (p) => { if (norm(p).endsWith('/a.js')) throw new Error('EPERM'); return { isSymbolicLink: () => false }; }) === 'SYMLINK'
        && pre(null, ['a.js'], (p) => { if (norm(p).endsWith('wbs-server/scripts')) throw new Error('ENOENT'); return { isSymbolicLink: () => false }; }) === 'SYMLINK', null);
    // 真 junction（Windows 不需要管理员权限）：用真实 fs.lstat 证明 junction 被识别为链接；建不出来时只记 NOTE（上面三条注入已覆盖判定本身）
    const jt = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-tis-junc-'));
    const jMade = [];
    try {
        const realDir = path.join(jt, 'real'); const linkDir = path.join(jt, 'link');
        fs.mkdirSync(realDir); fs.writeFileSync(path.join(realDir, 'a.js'), SRC.clean); jMade.push(path.join(realDir, 'a.js'));
        let junction = false;
        try { fs.symlinkSync(realDir, linkDir, 'junction'); junction = true; } catch (e) { console.log(`NOTE S.33d junction 建不出来（${String(e && e.code)}），跳过真实 junction 用例`); }
        const mkReal = (dir) => G.checkScanPreconditions({ exec: mkExec(), repoRoot: ROOT, scriptsDir: dir }, ['a.js']).map((p) => p.rule).join(',');
        if (junction) check('S.33d', '真实 junction：scriptsDir 是指向真实目录的 junction → SYMLINK；对照：直接用真实目录 → 无问题', mkReal(linkDir) === 'SYMLINK' && mkReal(realDir) === '', { link: mkReal(linkDir), real: mkReal(realDir) });
        if (junction) fs.rmdirSync(linkDir);
    } finally {
        for (const f of jMade) { try { fs.unlinkSync(f); } catch (_) { /* 已不存在 */ } }
        try { fs.rmdirSync(path.join(jt, 'real')); } catch (_) { /* 空目录以外不处理 */ }
        try { fs.rmdirSync(jt); } catch (_) { /* 留给系统临时目录清理 */ }
    }
    const rPre = ev({ 'ok.js': SRC.clean }, { scanProblems: [{ file: '(扫描前提)', cls: 'SCAN', rule: 'SYMLINK', evidence: 'x' }] });
    check('S.23f', '扫描前提的问题并入评估结果：整体判红，签名为 (扫描前提)|SCAN|<规则>', sig(rPre) === want('(扫描前提)|SCAN|SYMLINK'), sig(rPre));

    // S.45：ARCHIVE 前置门（S5 / W9）——scripts/_archive/ 不在扫描集合里，测试脚本不得躲进去；.js 须有「历史工具，不再运行」说明头（前 10 行内）
    const ARC_KEY = 'ls-files -z --cached --others --exclude-standard -- wbs-server/scripts/_archive';
    const HDR = '// 历史工具，不再运行（测试用说明头）\n';
    // files：键 = 相对 scripts/ 的路径，值 = 文件内容（Error 表示读失败）；返回 ARCHIVE 问题（规则 + 证据）
    const arc = (files, over) => {
        const out = Object.keys(files).map((k) => `wbs-server/scripts/${k}\0`).join('');
        const readFile = (p) => { const k = norm(p).slice(norm(SCR).length + 1); if (!(k in files)) throw new Error(`no such file ${k}`); if (files[k] instanceof Error) throw files[k]; return files[k]; };
        return G.checkScanPreconditions({ exec: mkExec(Object.assign({ [ARC_KEY]: out }, over || {})), repoRoot: ROOT, scriptsDir: SCR, lstat: lstOk, readFile }, []).filter((p) => p.rule === 'ARCHIVE');
    };
    const arcSig = (r) => r.map((p) => p.rule).join(',');
    const evHas = (r, s) => r.length === 1 && r[0].evidence.includes(s);
    const rVerify = arc({ '_archive/verify-x.js': `${HDR}module.exports = 1;\n` });
    const rTest = arc({ '_archive/test-x.js': `${HDR}module.exports = 1;\n` });
    const rSmoke = arc({ '_archive/smoke-x.js': `${HDR}module.exports = 1;\n` });
    const rDeep = arc({ '_archive/sub/verify-y.js': `${HDR}module.exports = 1;\n` });
    check('S.45a', 'ARCHIVE：_archive/verify-x.js（带说明头）→ 恰一条 ARCHIVE，证据点名相对路径与「verify- / test- / smoke-」；说明头不能洗白测试脚本命名', evHas(rVerify, 'wbs-server/scripts/_archive/verify-x.js') && rVerify[0].evidence.includes('verify- / test- / smoke-'), rVerify);
    check('S.45b', 'ARCHIVE：_archive/test-x.js、_archive/smoke-x.js（带说明头）→ 各恰一条 ARCHIVE', evHas(rTest, 'wbs-server/scripts/_archive/test-x.js') && evHas(rSmoke, 'wbs-server/scripts/_archive/smoke-x.js'), { rTest, rSmoke });
    check('S.45c', 'ARCHIVE：_archive/sub/verify-y.js（子目录）→ 判红（任意深度）；不分大小写 _archive/Verify-z.js 同样判红', evHas(rDeep, 'wbs-server/scripts/_archive/sub/verify-y.js') && arcSig(arc({ '_archive/Verify-z.js': HDR })) === 'ARCHIVE', rDeep);
    const rOk = arc({ '_archive/probe-x.js': `${HDR}module.exports = 1;\n` });
    check('S.45d', '对照组：_archive/probe-x.js 带说明头 → 无 ARCHIVE（含 CRLF 行尾写法、说明头恰在第 10 行）', rOk.length === 0
        && arc({ '_archive/probe-crlf.js': `${HDR.replace('\n', '\r\n')}x();\r\n` }).length === 0
        && arc({ '_archive/probe-l10.js': `${'// 空行\n'.repeat(9)}${HDR}x();\n` }).length === 0, { rOk, all: arcSig(arc({ '_archive/probe-l10.js': `${'// 空行\n'.repeat(9)}${HDR}x();\n` })) });
    const rNoHdr = arc({ '_archive/probe-x.js': 'module.exports = 1;\n' });
    check('S.45e', 'ARCHIVE：_archive/probe-x.js 没有说明头 → 恰一条 ARCHIVE，证据点名「说明头」', evHas(rNoHdr, 'wbs-server/scripts/_archive/probe-x.js') && rNoHdr[0].evidence.includes('说明头'), rNoHdr);
    const rL11 = arc({ '_archive/probe-x.js': `${'// 空行\n'.repeat(10)}${HDR}x();\n` });
    check('S.45f', 'ARCHIVE：说明头在第 11 行（超出前 10 行）→ 判红', evHas(rL11, 'probe-x.js'), rL11);
    const rGitFail = arc({}, { [ARC_KEY]: Object.assign(new Error('boom'), { status: 128 }) });
    check('S.45g', 'ARCHIVE：git ls-files 失败 → 判红（证据含「git ls-files 失败」，不回落到目录读取）', evHas(rGitFail, 'git ls-files 失败'), rGitFail);
    const rParse = arc({}, { [ARC_KEY]: 'wbs-server/other/stray.txt\0' });
    check('S.45h', 'ARCHIVE：git 输出无法解析（条目不在 _archive/ 下；用非 .js 名，使“读不到”判红无法顶替它）→ 判红（证据含「无法解析」）', evHas(rParse, '无法解析'), rParse);
    const rRead = arc({ '_archive/probe-x.js': new Error('EPERM') });
    check('S.45i', 'ARCHIVE：文件读不到（读文件抛错）→ 判红（证据含「读文件失败」）', evHas(rRead, '读文件失败'), rRead);
    check('S.45j', '对照组：_archive 为空 → 无 ARCHIVE；非 .js 的归档文件（如 README.md）不报；扩展名大写 _archive/probe-UP.JS 无头 → 恰一条 ARCHIVE（覆盖 .js 判据的不分大小写）；多个问题文件各一条（顺序无关）', arc({}).length === 0 && arc({ '_archive/README.md': 'x' }).length === 0
        && arcSig(arc({ '_archive/probe-UP.JS': 'x' })) === 'ARCHIVE'
        && arcSig(arc({ '_archive/verify-a.js': HDR, '_archive/probe-b.js': 'x', '_archive/probe-ok.js': HDR })) === 'ARCHIVE,ARCHIVE', null);
    // 真实仓库：5 个归档文件全部在枚举里、全部过门、ARCHIVE 0 条红（真实 git + 真实文件，不注入）
    const realRoot = path.resolve(__dirname, '..', '..');
    const lsReal = spawnSync('git', ['-C', realRoot, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'wbs-server/scripts/_archive'], { encoding: 'utf8', windowsHide: true });
    const realListed = String(lsReal.stdout || '').split('\0').filter(Boolean);
    const FIVE = ['apply-routes-corrections.js', 'build-routes-corrections.js', 'probe-correction-external-refs.js', 'probe-correction-suspects.js', 'probe-correction-symbols.js'];
    const realArc = G.checkScanPreconditions({ repoRoot: realRoot, scriptsDir: __dirname }, []).filter((p) => p.rule === 'ARCHIVE');
    check('S.45k', '真实仓库：_archive 的枚举含那 5 个归档脚本（非空转），且 ARCHIVE 0 条红（5 个都有说明头、都不是测试命名）', lsReal.status === 0 && FIVE.every((n) => realListed.includes(`wbs-server/scripts/_archive/${n}`)) && realArc.length === 0, { status: lsReal.status, listed: realListed.length, realArc });
}

function sectionControls() {
    const r12 = ev({ 'inproc.js': SRC.memOnly });
    check('S.12', '对照组：未登记的纯进程内脚本（只用 :memory:，3000 只作为毫秒数出现）判绿', r12.problems.length === 0 && r12.counts.other === 1, r12.problems);
    const r13 = ev({ 'm.js': SRC.good }, { mig: MIG });
    check('S.13', '对照组：已迁移形态正确的脚本判绿', r13.problems.length === 0 && r13.counts.migrated === 1, r13.problems);
    const r14 = ev({ 'bl.js': SRC.t1Url }, { baseline: bl({ 'bl.js': ['T1'] }) });
    const rep14 = G.formatReport(r14);
    check('S.14', '对照组：基线文件命中集合与冻结集合相等判绿（输出 OK 行带 baseline=1(T1×1)）', r14.problems.length === 0 && r14.counts.baseline === 1 && rep14.code === 0 && /^OK verify-test-isolation-static: scanned=1 migrated=0 exempt=0 infra=0 baseline=1\(T1×1\) other=0 sourceReaders=0 selfIsolated=0 dbPathAsserters=0$/.test(rep14.lines[0]), { p: r14.problems, rep14 });
    const rOk = ev({ 'backfill-ok.js': SRC.t2Db, 'infra-ok.js': SRC.t2Db }, { exempt: { 'backfill-ok.js': 'r' }, infra: { 'infra-ok.js': 'r' }, infraAllowed: ['infra-ok.js'] });
    check('S.12b', '对照组：合法登记的 EXEMPT（有命中）/ INFRA（不扫内容）条目判绿', rOk.problems.length === 0 && rOk.counts.exempt === 1 && rOk.counts.infra === 1, rOk.problems);
    const repRed = G.formatReport(ev({ 'new-a.js': SRC.t1Url }));
    check('S.12c', '输出格式：红 → 退出码 1，首行 RED，第二行表头「文件 | 类 | 规则 | 证据」，每条一行', repRed.code === 1 && /^RED verify-test-isolation-static: 1 条违规/.test(repRed.lines[0]) && repRed.lines[1] === '文件 | 类 | 规则 | 证据' && /^new-a\.js \| OTHER \| T1 \| /.test(repRed.lines[2]), repRed.lines);
    const rParse = ev({ 'broken.js': 'const = ;\n' });
    check('S.12d', '无法解析的未登记文件 fail-closed：判红 PARSE（不当成干净）', sig(rParse) === one('PARSE', 'broken.js'), sig(rParse));
    const rRead = G.evaluate({ files: ['gone.js'], read: () => { throw new Error('ENOENT'); }, registry: emptyReg(), baseline: EMPTY_BASELINE, familyNames: new Set() });
    check('S.12e', '读不到的文件 fail-closed：判红 READ', sig(rRead) === one('READ', 'gone.js'), sig(rRead));
    const argCodes = []; const argOut = [];
    argCodes.push(G.runCli(['--init-baseline', '--shrink-baseline'], { print: (l) => argOut.push(l) }));
    argCodes.push(G.runCli(['--bogus'], { print: (l) => argOut.push(l) }));
    check('S.12f', '命令行参数：同时给两个动作、或不认识的参数 → 输出 RED 且退出码 1（不执行任何动作）', argCodes.every((c) => c === 1) && argOut.length === 2 && argOut.every((l) => /^RED verify-test-isolation-static: 不认识的参数/.test(l)), { argCodes, argOut });
}

function sectionRealRepo() {
    const keys = (o) => Object.keys(o);
    check('S.16a', '真实登记表：MIGRATED 124 个（S3b 的 8 个代表 + S4b1 的 12 个 + S4b2a 的 5 个 + S4b2b 的 G2 / G3 + S4c-1 的 27 个 + S4c-2 的 4 个 + S4d-1 的 17 个 + S4d-2 的 15 个 + S4d-3 的 11 个 + S4d-4 的 12 个 + S4d-5 的 10 个 + S6b 的 1 个）、EXEMPT 45 个（S4e-4 追加 2 个 probe-*；S5 因 5 个一次性脚本归档到 _archive/ 删 5 个）、INFRA 20 个（S7 追加 verify-lines-merge.js），三类互不相交（并集 189）；EXEMPT_NO_READY 的键都在 MIGRATED 里；DB_PATH_ASSERTERS 为空',
        keys(REAL_REG.MIGRATED).length === 124 && keys(REAL_REG.EXEMPT).length === 45 && keys(REAL_REG.INFRA).length === 20
        && new Set([...keys(REAL_REG.MIGRATED), ...keys(REAL_REG.EXEMPT), ...keys(REAL_REG.INFRA)]).size === 189 && keys(REAL_REG.EXEMPT_NO_READY).every((n) => n in REAL_REG.MIGRATED) && keys(REAL_REG.DB_PATH_ASSERTERS).length === 0,
        { m: keys(REAL_REG.MIGRATED).length, e: keys(REAL_REG.EXEMPT).length, i: keys(REAL_REG.INFRA).length });
    // S3b 的 8 个代表脚本必须仍在 MIGRATED（名单取自 S3b，独立写在这里，不引用被测登记表的键集合）；S4b 批次的名单另核（含 G2 / G3，以及两个无 ready 的脚本不在）
    const S3B_REPS = ['test-codex-perm-e2e.js', 'test-requester-done-creator-visibility-playwright.js', 'test-sys-config-hide-playwright.js', 'verify-collab-attach-archive.js', 'verify-correction-creator-e2e.js', 'verify-dingtalk-file-helper.js', 'verify-issue-lite-archive-keeps-completion.js', 'verify-issue-lite-d4.js'];
    const S4B1 = ['verify-issue-lite-c1.js', 'verify-issue-lite-c2.js', 'verify-issue-lite-completed.js', 'verify-issue-lite-d3.js', 'verify-issue-lite-search.js', 'verify-issue-lite-void.js', 'verify-quick-log.js', 'test-issue-lite-c4-playwright.js', 'test-issue-lite-d5-playwright.js', 'smoke-legacy-archive-ui.js', 'test-sys-config-flow-playwright.js', 'verify-h0-metadata-e2e.js'];
    const S4B2A = ['test-model-catalog-playwright.js', 'test-model-catalog-baseline-playwright.js', 'test-model-workbench-playwright.js', 'test-model-workbench-baseline-playwright.js', 'test-sys-attachment-trace-playwright.js'];
    const S4B2B = ['verify-collab-external-source.js', 'test-collab-external-source-playwright.js'];
    const NOT_MIG = ['verify-issue-lite-void-migration.js', 'verify-periodic-push.js'];
    // S4c 两批的名单也独立写在这里（不引用被测登记表）；verify-issue-notify-v1740.js（纯函数）与 test-collab-resume.js（直接调启动器）不登记，落「其他」类
    const S4C1 = ['test-collab-archive-final-e2e.js', 'test-collab-attachment-owner-lock-e2e.js', 'test-collab-create-chat-e2e.js', 'test-collab-bypass-e2e.js', 'test-collab-friction-e2e.js', 'test-collab-multi-level-link-e2e.js', 'test-collab-template-e2e.js', 'test-collab-two-level-e2e.js', 'verify-collab-multifile-datascope.js',
        'test-collab-admin-fix-e2e.js', 'test-admin-direct-e2e.js', 'test-collab-return-to-dev-e2e.js', 'test-collab-three-level-forward-e2e.js', 'test-collab-submit-export-e2e.js', 'test-collab-viewer-exporter-e2e.js', 'test-notify-requester-done-e2e.js', 'verify-collab-admin-close-exporting.js', 'verify-collab-direct-close-no-file.js',
        'test-issue-c3-smoke.js', 'test-issue-c4-smoke.js', 'test-issue-c4a-smoke.js', 'test-issue-c5-smoke.js', 'test-issue-v1750-c4-chat-e2e.js', 'verify-issue-creator-edit.js', 'verify-issue-lite-creator-edit.js', 'verify-correction-creator-edit.js', 'test-sys-cross-phase-smoke.js'];
    const S4C2 = ['verify-correction-e2e-http.js', 'verify-correction-relay-e2e.js', 'verify-legacy-archive-api.js', 'verify-uploads-guard.js'];
    NOT_MIG.push('verify-issue-notify-v1740.js', 'test-collab-resume.js');
    // S4d-1 的 17 个 Playwright（名单独立写在这里）
    const S4D1 = ['test-unify12-sticky-playwright.js', 'test-issue-tracker-paste-playwright.js', 'test-corr-paste-playwright.js', 'test-collab-paste-playwright.js', 'test-tracker-attach-picker-playwright.js', 'test-notify-read-unify-playwright.js',
        'test-model-c3-drawer-playwright.js', 'test-model-c4-views-playwright.js', 'test-model-c8-dim-scd-playwright.js', 'test-model-c7-row-click-playwright.js', 'test-corr-upload-preview-playwright.js',
        'test-collab-direct-close-c-playwright.js', 'test-collab-terminal-notify-playwright.js', 'test-collab-data-scope-display-playwright.js', 'test-collab-template-display-playwright.js', 'test-issue-lite-paste-playwright.js', 'test-issue-lite-create-attach-playwright.js'];
    // S4d-2 的 15 个（D-C 12 个含已红 3 个 + D-D 3 个；名单独立写在这里，不从登记表读取）；c6d 同时在 SOURCE_READERS（与 MIGRATED 并存）
    const S4D2 = ['test-issue-h1-status-perm-playwright.js', 'test-issue-c6a-playwright.js', 'test-issue-c6b-playwright.js', 'test-issue-c6c-playwright.js', 'test-issue-c6d-notify-playwright.js', 'test-issue-p4-worknote-playwright.js',
        'test-issue-commit-groups-playwright.js', 'test-notify-read-hide-query-playwright.js', 'test-issue-c4-create-chat-playwright.js',
        'test-att-inline-playwright.js', 'test-issue-p2-attachment-playwright.js', 'test-issue-c2b-change-notify-playwright.js',
        'test-admin-direct-playwright.js', 'test-collab-multifile-m3-playwright.js', 'test-viewer-exporter-playwright.js'];
    // S4d-3 的 11 个（名单独立写在这里）
    const S4D3 = ['test-sys-effort-days-playwright.js', 'test-sys-fastlane-auth-badge-playwright.js', 'test-periodic-fetch-playwright.js', 'test-sys-release-c7-playwright.js',
        'test-sys-prerelease-flags-playwright.js', 'test-model-center-sort-playwright.js', 'test-notify-unify-acceptance-playwright.js', 'test-statistics-efficiency-e2e.js',
        'test-sys-eta-overrun-reason-playwright.js', 'test-sys-derive-numbering-playwright.js', 'test-sys-perdev-done-playwright.js'];
    // S4d-4 的 12 个（名单独立写在这里）
    const S4D4 = ['test-sys-paste-playwright.js', 'test-quick-log-playwright.js', 'test-sys-eta-generation-playwright.js', 'test-sys-bug-hold-frontend-playwright.js',
        'test-sys-liaison-test-frontend-playwright.js', 'test-sys-release-mgmt-playwright.js', 'test-attach-archive-frontend-playwright.js', 'test-sys-accept-evidence-playwright.js',
        'test-sys-submit-withdraw-playwright.js', 'test-sys-post-release-accept-fail-note-playwright.js', 'test-sys-my-pending-playwright.js', 'test-sys-fastlane-playwright.js'];
    // S4d-5 的 10 个（名单独立写在这里）
    const S4D5 = ['test-sys-release-panel-c2b2-playwright.js', 'test-sys-intake-liaison-playwright.js', 'test-sys-release-overdue-playwright.js', 'test-sys-submit-amend-playwright.js',
        'test-sys-release-date-change-playwright.js', 'test-sys-detail-ux-playwright.js', 'test-sys-commit-cols-playwright.js', 'test-badge-computed-playwright.js',
        'run-badge-computed-with-pf-fixture.js', 'test-unify-visual-playwright.js'];
    // S6b 的 1 个（名单独立写在这里）：页面缓存串注入的实例级检查
    const S6B = ['verify-html-fingerprint-e2e.js'];
    const ALL_MIG = [...S3B_REPS, ...S4B1, ...S4B2A, ...S4B2B, ...S4C1, ...S4C2, ...S4D1, ...S4D2, ...S4D3, ...S4D4, ...S4D5, ...S6B];
    check('S.16e', '真实登记表的 MIGRATED 成员分批精确：S3b 的 8 个代表仍在、S4b1 的 12 个、S4b2a 的 5 个、S4b2b 的 G2 / G3 两个、S4c-1 的 27 个、S4c-2 的 4 个、S4d-1 的 17 个、S4d-2 的 15 个（c6d 同时在 SOURCE_READERS）、S4d-3 的 11 个、S4d-4 的 12 个、S4d-5 的 10 个、S6b 的 1 个都在，合起来恰是 124 个；没有 ready 的 void-migration / periodic-push 与不登记的 v1740 / collab-resume 四个不在',
        S3B_REPS.length === 8 && S4B1.length === 12 && S4B2A.length === 5 && S4B2B.length === 2 && S4C1.length === 27 && S4C2.length === 4 && S4D1.length === 17 && S4D2.length === 15 && S4D3.length === 11 && S4D4.length === 12 && S4D5.length === 10 && S6B.length === 1 && new Set(ALL_MIG).size === 124
        && 'test-issue-c6d-notify-playwright.js' in REAL_REG.SOURCE_READERS
        && ALL_MIG.every((n) => n in REAL_REG.MIGRATED) && keys(REAL_REG.MIGRATED).every((n) => ALL_MIG.includes(n)) && NOT_MIG.every((n) => !(n in REAL_REG.MIGRATED)),
        { m: keys(REAL_REG.MIGRATED).filter((n) => !ALL_MIG.includes(n)), miss: ALL_MIG.filter((n) => !(n in REAL_REG.MIGRATED)) });
    // S4b2b + S4e-1：SELF_ISOLATED 恰是这 6 个（名单独立写在这里），理由非空白、文件存在；与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线不相交；G2 同时在 MIGRATED（SELF_ISOLATED 只许与 MIGRATED 并存），其余 5 个不在 MIGRATED
    const SI_EXPECT = ['verify-collab-external-source.js', 'verify-model-config-rev-http.js', 'verify-model-impl-objects.js', 'verify-model-impl-verify.js', 'verify-model-list-extras.js', 'verify-model-relations.js'];
    let realBaseline = null;
    try { realBaseline = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'test-isolation-baseline.json'), 'utf8')); } catch (e) { realBaseline = null; }
    const siNames = keys(REAL_REG.SELF_ISOLATED);
    check('S.16f', '真实登记表的 SELF_ISOLATED：恰是 6 个（G2 / H / IO / IV / LX / RL）、理由都非空白、文件存在；与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线都不相交；其中只有 G2 同时在 MIGRATED',
        siNames.length === 6 && siNames.slice().sort().join(',') === SI_EXPECT.slice().sort().join(',')
        && siNames.every((n) => typeof REAL_REG.SELF_ISOLATED[n] === 'string' && REAL_REG.SELF_ISOLATED[n].trim() !== '' && fs.existsSync(path.join(__dirname, n)) && !(n in REAL_REG.EXEMPT) && !(n in REAL_REG.INFRA) && !(n in REAL_REG.SOURCE_READERS)
            && realBaseline !== null && !(n in realBaseline.entries))
        && siNames.filter((n) => n in REAL_REG.MIGRATED).join(',') === 'verify-collab-external-source.js',
        { n: siNames, baselineRead: realBaseline !== null });
    check('S.16g', '真实基线：条目数与 maxEntries 都恰为 14（S4b2b 缩表 132 → 126；S4c 缩表删掉 33 个已登记 MIGRATED 或已零命中的文件：126 → 93；S4d-1 删 17 个：93 → 76；S4d-2 删 15 个：76 → 61；S4d-3 删 11 个：61 → 50；S4d-4 删 12 个：50 → 38；S4d-5 删 10 个：38 → 28；S4e-1 删 3 个：28 → 25；S4e-4 删 11 个：25 → 14）；S4d-2 / S4d-3 / S4d-4 / S4d-5 的成员都不在基线里',
        realBaseline !== null && Object.keys(realBaseline.entries).length === 14 && realBaseline.maxEntries === 14 && S4D2.every((n) => !(n in realBaseline.entries)) && S4D3.every((n) => !(n in realBaseline.entries)) && S4D4.every((n) => !(n in realBaseline.entries)) && S4D5.every((n) => !(n in realBaseline.entries)), realBaseline && { entries: Object.keys(realBaseline.entries).length, max: realBaseline.maxEntries });
    // S4e-1 的 3 个（名单手写在这里，不从登记表或基线派生）：impl-verify 登记 SELF_ISOLATED；另两个改掉字面量后零命中，不在任何登记类
    const S4E1 = ['verify-model-impl-verify.js', 'verify-sys-derive-numbering.js', 'verify-sys-migrate-config-release-check.js'];
    const S4E1_ZERO = ['verify-sys-derive-numbering.js', 'verify-sys-migrate-config-release-check.js'];
    const REG_CLASSES = ['MIGRATED', 'EXEMPT_NO_READY', 'EXEMPT', 'INFRA', 'SOURCE_READERS', 'SELF_ISOLATED', 'DB_PATH_ASSERTERS'];
    check('S.16h', '真实登记表与基线的 S4e-1 成员（手写名单）：三个文件都存在、都不在基线里；verify-model-impl-verify 只在 SELF_ISOLATED（其余 6 个登记类都不在）；另两个（derive-numbering / migrate-config-release-check）不在任何登记类（零命中的「其余」）',
        S4E1.length === 3 && new Set(S4E1).size === 3 && realBaseline !== null
        && S4E1.every((n) => fs.existsSync(path.join(__dirname, n)) && !(n in realBaseline.entries))
        && 'verify-model-impl-verify.js' in REAL_REG.SELF_ISOLATED
        && REG_CLASSES.length === 7 && REG_CLASSES.filter((c) => c !== 'SELF_ISOLATED').every((c) => !('verify-model-impl-verify.js' in REAL_REG[c]))
        && S4E1_ZERO.length === 2 && S4E1_ZERO.every((n) => REG_CLASSES.every((c) => !(n in REAL_REG[c]))),
        { baselineRead: realBaseline !== null, inBaseline: realBaseline ? S4E1.filter((n) => n in realBaseline.entries) : null, zeroHit: S4E1_ZERO.filter((n) => REG_CLASSES.some((c) => n in REAL_REG[c])) });
    // S4e-4（名单全部手写在这里，不从登记表或基线派生）：D5 删 3 个、改名 2 个，D2 六个脚本的真实库探针改 --real-db 开关，基线恰剩 14 个
    const S4E4_DELETED = ['verify-attach-archive-mutations.js', 'verify-correction-datafix-migration.js', 'verify-test-new-dual-dialect.js'];
    const S4E4_RENAMED_OLD = ['verify-assign-mode-history.js', 'verify-result-attachment-owner-consistency.js'];
    const S4E4_RENAMED_NEW = ['probe-assign-mode-history.js', 'probe-result-attachment-owner-consistency.js'];
    const S4E4_D2_ZERO = ['verify-sys-commit-cols.js', 'verify-sys-fastlane-submit.js', 'verify-sys-fastrelease-auth.js', 'verify-sys-release-overdue.js', 'verify-statistics-efficiency.js'];
    const S4E4_D2_READER = 'verify-readonly-leader-exporter-block.js';
    const BASELINE_LEFT = ['test-collab-failed-retention-e2e.js', 'test-collab-submit-e2e.js', 'verify-collab-delivery-extra.js', 'test-collab-mysql-smoke-e2e.js', 'test-issue-c7-notify-e2e.js', 'test-model-c5-ods-playwright.js', 'test-model-c6-ods-source-playwright.js', 'test-model-c9-downstream-copy-playwright.js',
        'verify-model-config-rev-migration.js', 'verify-model-table-comment-migration.js', 'verify-notify-read-backfill.js', 'verify-model-write-classification.js', 'verify-model-test-records-append-only.js', 'verify-preview-excel-removed.js'];
    const onDisk = new Set(fs.readdirSync(__dirname));
    const inAnyClass = (n) => REG_CLASSES.some((c) => n in REAL_REG[c]);
    check('S.16i', '真实登记表与基线的 S4e-4 成员（手写名单）：删除的 3 个不在磁盘 / 不在任何登记类 / 不在基线；改名的 2 个旧名同样哪里都没有、新名在磁盘且在 EXEMPT 且不在其余登记类 / 基线；D2 的 5 个（commit-cols / fastlane-submit / fastrelease-auth / release-overdue / statistics-efficiency）在磁盘、不在任何登记类、不在基线；readonly-leader 在磁盘、只在 SOURCE_READERS、不在基线；基线恰是手写的 14 个',
        S4E4_DELETED.length === 3 && S4E4_RENAMED_OLD.length === 2 && S4E4_RENAMED_NEW.length === 2 && S4E4_D2_ZERO.length === 5 && BASELINE_LEFT.length === 14 && new Set(BASELINE_LEFT).size === 14 && realBaseline !== null
        && [...S4E4_DELETED, ...S4E4_RENAMED_OLD].every((n) => !onDisk.has(n) && !inAnyClass(n) && !(n in realBaseline.entries))
        && S4E4_RENAMED_NEW.every((n) => onDisk.has(n) && n in REAL_REG.EXEMPT && REG_CLASSES.filter((c) => c !== 'EXEMPT').every((c) => !(n in REAL_REG[c])) && !(n in realBaseline.entries))
        && S4E4_D2_ZERO.every((n) => onDisk.has(n) && !inAnyClass(n) && !(n in realBaseline.entries))
        && onDisk.has(S4E4_D2_READER) && S4E4_D2_READER in REAL_REG.SOURCE_READERS && REG_CLASSES.filter((c) => c !== 'SOURCE_READERS').every((c) => !(S4E4_D2_READER in REAL_REG[c])) && !(S4E4_D2_READER in realBaseline.entries)
        && Object.keys(realBaseline.entries).slice().sort().join(',') === BASELINE_LEFT.slice().sort().join(','),
        { baselineRead: realBaseline !== null, deletedOnDisk: S4E4_DELETED.filter((n) => onDisk.has(n)), renamedOldLeft: S4E4_RENAMED_OLD.filter((n) => onDisk.has(n) || inAnyClass(n) || (realBaseline && n in realBaseline.entries)),
            baselineExtra: realBaseline ? Object.keys(realBaseline.entries).filter((n) => !BASELINE_LEFT.includes(n)) : null, baselineMissing: realBaseline ? BASELINE_LEFT.filter((n) => !(n in realBaseline.entries)) : null });
    const allowed = G.INFRA_ALLOWED.slice().sort();
    check('S.16b', '守卫常量 INFRA_ALLOWED 恰好是 20 个不重复的名字，且与真实登记表的 INFRA 键集合逐个相等', allowed.length === 20 && new Set(allowed).size === 20 && allowed.join(',') === keys(REAL_REG.INFRA).sort().join(','), { allowed: allowed.length });
    check('S.16d', '真实登记表的 SOURCE_READERS：理由都非空白，与 EXEMPT / INFRA 不相交，且文件存在',
        keys(REAL_REG.SOURCE_READERS).length === 24 && 'verify-server-js-growth.js' in REAL_REG.SOURCE_READERS && 'test-model-catalog-baseline-playwright.js' in REAL_REG.SOURCE_READERS && keys(REAL_REG.SOURCE_READERS).every((n) => typeof REAL_REG.SOURCE_READERS[n] === 'string' && REAL_REG.SOURCE_READERS[n].trim() !== '' && !(n in REAL_REG.EXEMPT) && !(n in REAL_REG.INFRA) && fs.existsSync(path.join(__dirname, n))), { n: keys(REAL_REG.SOURCE_READERS).length });
    // 禁用前缀用本套件自己的独立正则作期望，不引用被测守卫导出的那个
    const PREFIX_EXPECT = /^(?:verify-|test-|smoke-)/i;
    check('S.16c', '真实登记表的 EXEMPT 条目：名字都不以 verify- / test- / smoke- 开头（用套件自己的独立正则），理由都非空白', keys(REAL_REG.EXEMPT).every((n) => !PREFIX_EXPECT.test(n) && typeof REAL_REG.EXEMPT[n] === 'string' && REAL_REG.EXEMPT[n].trim() !== ''), null);
    if (!IS_REAL) { console.log('NOTE S.15 / S.17 只在默认目录（真实工作树）下跑；变异副本跳过'); return; }
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-test-isolation-static.js')], { encoding: 'utf8', timeout: 300000, windowsHide: true });
    const m = (r.stdout || '').trim().match(/^OK verify-test-isolation-static: scanned=(\d+) migrated=(\d+) exempt=(\d+) infra=(\d+) baseline=(\d+)\((.*)\) other=(\d+) sourceReaders=(\d+) selfIsolated=(\d+) dbPathAsserters=(\d+)$/);
    const n = m ? m.slice(1, 11).map((x, i) => (i === 5 ? x : Number(x))) : null;
    check('S.15', '端到端（只读真实工作树）：守卫本体退出码 0，输出 OK 行；migrated 124 / exempt 45 / infra 20 / baseline 14 / sourceReaders / selfIsolated 6 与登记表和基线条数全等；dbPathAsserters 0；scanned = migrated + exempt + infra + baseline + other',
        r.status === 0 && n !== null && n[1] === 124 && n[2] === 45 && n[3] === 20 && n[4] === 14 && n[7] === Object.keys(REAL_REG.SOURCE_READERS).length && n[8] === Object.keys(REAL_REG.SELF_ISOLATED).length && n[8] === 6 && n[9] === 0 && n[0] === n[1] + n[2] + n[3] + n[4] + n[6], { status: r.status, out: (r.stdout || '').slice(0, 300), err: (r.stderr || '').slice(0, 300) });
    const own = ['verify-test-isolation-static.js', 'verify-test-isolation-static-suite.js'].map((f) => ({ f, hits: L.scanTier1(f, fs.readFileSync(path.join(__dirname, f), 'utf8')).map((h) => `${h.code}@${h.line}`) }));
    check('S.17', '守卫本体与自检套件自己是未登记类：Tier-1 零命中（合成片段都经 cat 拼接，没有整串触发字面量）', own.every((o) => o.hits.length === 0), own);
}

/** L：finish(code) 必须在尾部位置（只设 process.exitCode、不终止执行）。合成样本里直接写 fx.finish(0) / testEnv.finish(0)，规则只看静态形态 */
function sectionFinish() {
    const FIN = (body, pre) => join("'use strict';", FX_REQ_LINE.trim(), ...(pre ? [pre] : []), '(async () => {', '  await fx.ready();', '  await fx.teardown();', ...body, CATCH_TAIL);
    const FETCH = "  await fetch('http://127.0.0.1:1/x');";
    const cond = 'process.argv.length > 5';
    const bad = {
        '后面还有一条 fetch': FIN(['  fx.finish(0);', FETCH]),
        'if 块里 finish、块后没有 return 又继续执行': FIN([`  if (${cond}) { fx.finish(1); }`, FETCH, '  fx.finish(0);']),
        'if 无花括号 finish、后面继续执行': FIN([`  if (${cond}) fx.finish(1);`, '  await later();', '  fx.finish(0);']),
        '解构出来的 finish、后面继续执行': FIN(['  finish(0);', '  await later();'], 'const { finish } = fx;'),
        '循环里的 finish': FIN([`  for (let i = 0; i < 2; i += 1) { fx.finish(1); }`, '  await later();']),
        '嵌在更大的表达式里': FIN([`  ${cond} && fx.finish(1);`, '  await later();']),
        'test-env 模块对象上的 finish、后面继续执行': join("'use strict';", "const testEnv = require('./lib/test-env');", '(async () => {', '  await testEnv.ready();', '  await testEnv.teardown();', '  testEnv.finish(0);', '  await later();', CATCH_TAIL),
    };
    const badRes = Object.entries(bad).map(([k, src]) => ({ k, sg: sig(ev({ 'm.js': src }, { mig: MIG })) }));
    check('S.28a', '反例：finish 后还有语句 / if 块后继续执行（无 return）/ 无花括号 if / 解构出来的 finish / 循环里 / 嵌在表达式里 / test-env 模块对象上的 finish → 各恰判红 MIGRATED/FINISH_NOT_LAST', badRes.every((r) => r.sg === want('m.js|MIGRATED|FINISH_NOT_LAST')), badRes.filter((r) => r.sg !== want('m.js|MIGRATED|FINISH_NOT_LAST')));
    const good = {
        'finish 是函数最后一条': FIN(['  fx.finish(0);']),
        'if 块里 finish 后紧跟 return': FIN([`  if (${cond}) { fx.finish(1); return; }`, '  await later();', '  fx.finish(0);']),
        'if 块末尾的 finish、该 if 是函数最后一条': FIN(['  await later();', `  if (${cond}) { fx.finish(1); }`]),
        'if / else 两个分支各以 finish 收尾、整个 if 是函数最后一条': FIN([`  if (${cond}) { fx.finish(1); } else { fx.finish(0); }`]),
        '无花括号 if 的 finish 紧跟 return 不成立时仍要求 if 在尾部（这里 if 是最后一条）': FIN([`  if (${cond}) fx.finish(1);`]),
        'return finish(…)': FIN([`  if (${cond}) { return fx.finish(1); }`, '  await later();', '  fx.finish(0);']),
        '解构出来的 finish 在函数末尾': FIN(['  finish(0);'], 'const { finish } = fx;'),
        '别的对象的 finish（不是 test-env / 夹具绑定）后面继续执行不报': FIN(['  const res = { finish() {} };', '  res.finish(0);', '  await later();', '  fx.finish(0);']),
    };
    const goodRes = Object.entries(good).map(([k, src]) => ({ k, sg: sig(ev({ 'm.js': src }, { mig: MIG })) }));
    check('S.28b', '对照：finish 是函数最后一条 / if 块里 finish 后紧跟 return / if 块末尾且 if 是函数最后一条 / if-else 各以 finish 收尾 / return finish(…) / 解构的 finish 在末尾 / 别的对象的 finish → 判绿', goodRes.every((r) => r.sg === ''), goodRes.filter((r) => r.sg !== ''));
    // 47R4b M1：紧跟的 return 若带调用表达式，运行时仍会继续执行 → 不放行；无返回值 / 字面量 / 标识符照旧放行
    const retCallBad = {
        'finish 后紧跟 return 调用': FIN([`  if (${cond}) { fx.finish(1); return later(); }`, '  fx.finish(0);']),
        'finish 后紧跟 return await 调用': FIN([`  if (${cond}) { fx.finish(1); return await later(); }`, '  fx.finish(0);']),
    };
    const retCallGood = {
        'finish 后紧跟 return 字面量': FIN([`  if (${cond}) { fx.finish(1); return 1; }`, '  fx.finish(0);']),
        'finish 后紧跟 return 标识符': FIN([`  if (${cond}) { fx.finish(1); return undefined; }`, '  fx.finish(0);']),
    };
    const rcBad = Object.entries(retCallBad).map(([k, src]) => ({ k, sg: sig(ev({ 'm.js': src }, { mig: MIG })) })).filter((r) => r.sg !== want('m.js|MIGRATED|FINISH_NOT_LAST'));
    const rcGood = Object.entries(retCallGood).map(([k, src]) => ({ k, sg: sig(ev({ 'm.js': src }, { mig: MIG })) })).filter((r) => r.sg !== '');
    check('S.28h', '紧跟 finish 的 return 带调用（return later() / return await later()）→ 各恰判红 MIGRATED/FINISH_NOT_LAST；对照：return 字面量 / 标识符 → 判绿（47R4b M1）', rcBad.length === 0 && rcGood.length === 0, { rcBad, rcGood });
    // ---- 修复批 3：先查祖先（循环 / 带 finalizer 的 try），再接受「紧跟 return」「return finish(…)」「箭头表达式体」（15-R [3] / [8]、预筛 M1、15T-R M1）
    const LATER = '  await later();';
    const WANT_RED = want('m.js|MIGRATED|FINISH_NOT_LAST');
    const runGroup = (group) => Object.entries(group).map(([k, src]) => ({ k, sg: sig(ev({ 'm.js': src }, { mig: MIG })) }));
    const redGroup = (group) => runGroup(group).filter((r) => r.sg !== WANT_RED);
    const greenGroup = (group) => runGroup(group).filter((r) => r.sg !== '');
    const fin = {
        'try { finish } finally { later }': FIN(['  try {', '    fx.finish(1);', '  } finally {', LATER, '  }']),
        'try { finish } finally {}（空 finally）': FIN(['  try {', '    fx.finish(1);', '  } finally {', '  }']),
        'try { finish; return } finally { later }（紧跟 return 不放行）': FIN(['  try {', '    fx.finish(0);', '    return;', '  } finally {', LATER, '  }']),
        'try { return finish } finally { later }（return finish 不放行）': FIN(['  try {', '    return fx.finish(0);', '  } finally {', LATER, '  }']),
        'try { teardown; return finish } finally { later }': FIN(['  try {', '    await later();', '    return fx.finish(0);', '  } catch (e) {', '    throw e;', '  } finally {', LATER, '  }']),
        'catch { finish } + finally { later }': FIN(['  try { void 0; } catch (e) {', '    fx.finish(1);', '  } finally {', LATER, '  }']),
        'finally 块里的 finish': FIN(['  try { void 0; } finally {', '    fx.finish(1);', '  }']),
    };
    const loops = {
        'for 循环里 finish; return': FIN(['  for (let i = 0; i < 2; i += 1) {', '    fx.finish(1);', '    return;', '  }']),
        'for-of 循环里 return finish': FIN(['  for (const x of [1, 2]) {', '    return fx.finish(x);', '  }']),
        'for-in 循环里 finish; return': FIN(['  for (const k in { a: 1 }) {', '    fx.finish(1);', '    return;', '  }']),
        'while 循环里 finish; return': FIN([`  while (${cond}) { fx.finish(1); return; }`]),
        'for-of 循环里 finish; return': FIN(['  for (const x of [1, 2]) {', '    fx.finish(x);', '    return;', '  }']),
        'do-while 循环里 finish; return': FIN(['  do {', '    fx.finish(1);', '    return;', `  } while (${cond});`]),
        'while 里的 if 块内 finish': FIN([`  while (${cond}) { if (${cond}) { fx.finish(1); return; } }`]),
    };
    const shape = {
        'if 块里独立嵌套块 { finish } 之后还有语句': FIN([`  if (${cond}) {`, '    { fx.finish(1); }', LATER, '  }']),
        '函数体里独立嵌套块 { finish } 之后还有语句': FIN(['  { fx.finish(1); }', LATER]),
        'try 块里独立嵌套块 { finish } 之后还有语句': FIN(['  try {', '    { fx.finish(1); }', LATER, '  } catch (e) { throw e; }']),
        'catch 里 finish、try 外还有语句': FIN(['  try { void 0; } catch (e) { fx.finish(1); }', LATER]),
        'try 块末尾的 finish、try 外还有语句': FIN(['  try { fx.finish(0); } catch (e) { throw e; }', LATER]),
        'switch case 末尾的 finish（贯穿到下一个 case）': FIN(['  switch (process.argv.length) { case 9: fx.finish(1); default: await later(); }']),
        'switch case 里 finish; break': FIN(['  switch (process.argv.length) { case 9: fx.finish(1); break; default: break; }', '  fx.finish(0);']),
        '内联 require(test-env).finish(…) 之后还有语句': FIN(["  require('./lib/test-env').finish(0);", LATER]),
    };
    const finBad = redGroup(fin);
    const loopBad = redGroup(loops);
    const shapeBad = redGroup(shape);
    check('S.28c', '反例：调用点祖先里有带 finalizer 的 try（finish 在 try 块 / catch / finally 里，含「紧跟 return」「return finish(…)」）→ 各恰判红 MIGRATED/FINISH_NOT_LAST', finBad.length === 0, finBad);
    check('S.28d', '反例：调用点祖先里有循环（for / for-of / for-in / while / do-while，含紧跟 return、return finish(…)、循环里 if 块内）→ 各恰判红 MIGRATED/FINISH_NOT_LAST', loopBad.length === 0, loopBad);
    check('S.28e', '反例：独立嵌套块之后还有语句（if 块里 / 函数体里 / try 块里）· catch 或 try 块收尾后 try 外还有语句 · switch case 里 · 内联 require(test-env).finish 之后还有语句 → 各恰判红', shapeBad.length === 0, shapeBad);
    const okShape = {
        'await fx.finish(0) 在函数末尾': FIN(['  await fx.finish(0);']),
        'try / catch（无 finally）各以 finish 收尾、整个 try 是函数最后一条': FIN(['  try {', '    await later();', '    fx.finish(0);', '  } catch (e) {', '    console.error(e);', '    fx.finish(1);', '  }']),
        'catch 里 finish 紧跟 return、try 之后继续执行': FIN(['  try { void 0; } catch (e) {', '    fx.finish(1);', '    return;', '  }', LATER, '  fx.finish(0);']),
        '函数末尾独立嵌套块 { finish }': FIN(['  { fx.finish(0); }']),
        '多层独立嵌套块 { { finish } } 在函数末尾': FIN(['  { { fx.finish(0); } }']),
        'if / else if / else 链各分支以 finish 收尾、整条链是函数最后一条': FIN([`  if (${cond}) { fx.finish(1); } else if (${cond}) { fx.finish(2); } else { fx.finish(0); }`]),
        'if 块里嵌套块以 finish 收尾、if 是函数最后一条': FIN([`  if (${cond}) { { fx.finish(1); } }`]),
        '内联 require(test-env).finish(…) 在函数末尾': FIN(["  require('./lib/test-env').finish(0);"]),
        '无 finalizer 的 try 里 return finish(…)': FIN(['  try {', '    await later();', '    return fx.finish(0);', '  } catch (e) {', '    throw e;', '  }']),
        '回调函数里的 finish（祖先检查止于最近的函数边界：外面的带 finalizer 的 try 不算）': FIN(['  try {', '    [1].forEach(() => { fx.finish(0); });', '  } finally {', LATER, '  }']),
    };
    const arrowSrc = join("'use strict';", FX_REQ_LINE.trim(), 'async function main() {', '  await fx.ready();', '  await fx.teardown();', '}', 'main().then(() => fx.finish(0)).catch((e) => { console.error(e); process.exit(1); });');
    const arrowAwait = join("'use strict';", FX_REQ_LINE.trim(), 'async function main() {', '  await fx.ready();', '  await fx.teardown();', '}', 'main().then(async () => await fx.finish(0)).catch((e) => { console.error(e); process.exit(1); });');
    const okBad = greenGroup(okShape);
    const arrowRes = [sig(ev({ 'm.js': arrowSrc }, { mig: MIG })), sig(ev({ 'm.js': arrowAwait }, { mig: MIG }))];
    check('S.28f', '对照：await fx.finish(0) 在末尾 · 无 finalizer 的 try / catch 尾部 · catch 里 finish 紧跟 return · 独立嵌套块在函数末尾 · if / else if / else 链 · 内联 require(test-env).finish 在末尾 · 无 finalizer 的 try 里 return finish → 判绿', okBad.length === 0, okBad);
    check('S.28g', '对照：箭头函数表达式体（.then(() => fx.finish(0))、.then(async () => await fx.finish(0))）判绿', arrowRes.every((s) => s === ''), arrowRes);
}

/** 修复批 3 · 简化 ① 命令串：一条分隔符边界正则；适用范围 = sink 实参里的全部字符串 + require / import() 了 child_process 的文件里的全部字符串 */
function sectionCmdStrings() {
    const CP = "const cp = require('child_process');\n";
    const T3 = one('T3', 'n.js');
    // 15-R [1] 列的写法，逐个进反例（未登记、文件 require 了 child_process）
    const cases = [
        ['S.30a', "exec('node ./<入口> --port 0')（路径前缀 ./ 加参数）", cat(CP, "cp.exec('node ./", SJS, " --port 0');\n")],
        ['S.30b', "'node ../<入口> > out.log'（重定向）", cat(CP, "cp.exec('node ../", SJS, " > out.log');\n")],
        ['S.30c', "'node wbs-server/<入口> --x' + shell: true", cat(CP, "cp.spawn('node wbs-server/", SJS, " --x', { shell: true });\n")],
        ['S.30d', "'node \"<入口>\"'（引号包裹）", cat(CP, "cp.exec('node \"", SJS, "\"');\n")],
        ['S.30e', '模板串 `node ${ROOT}/<入口> --port ${p}`（带参数）', cat(CP, 'const ROOT = __dirname; const p = 1;\ncp.exec(`node ${ROOT}/', SJS, ' --port ${p}`);\n')],
        ['S.30f', "'node .\\\\<入口> --x'（Windows 反斜杠）", cat(CP, "cp.execSync('node .\\\\", SJS, " --x');\n")],
        ['S.30g', "'node <入口>&'（后台符号紧贴）", cat(CP, "cp.exec('node ", SJS, "&');\n")],
        ['S.30h', "裸 exec('node ./<入口> --port 0')（文件没有 require child_process：只靠 sink 实参这一档适用范围）", cat("exec('node ./", SJS, " --port 0');\n")],
        ['S.30i', 'util.promisify(cp.exec) 起别名后 run(\'node <入口>\')（别名：靠文件级适用范围）', cat(CP, "const run = require('util').promisify(cp.exec);\nrun('node ", SJS, "');\n")],
        ['S.30j', "{ exec: run } 解构起别名后 run('node <入口>')", cat("const { exec: run } = require('child_process');\nrun('node ", SJS, "');\n")],
        ['S.30k', '文件 require 了 child_process 时，sink 外的说明文字带入口名也判红（宁可误红：要么改成拼接写法，要么进基线）', cat(CP, "console.log('see ./", SJS, " for details');\n")],
        ['S.30l', "node: 前缀的 child_process 与 cp.exec('node <入口>')", cat("const cp = require('node:child_process');\ncp.exec('node ", SJS, "');\n")],
        ['S.30m', "import('child_process') 之后的 cp.exec('node <入口>')", cat("import('child_process').then((cp) => cp.exec('node ", SJS, "'));\n")],
    ];
    for (const [id, label, src] of cases) {
        const r = ev({ 'n.js': src });
        check(id, `命令串：${label} → 恰判红 T3`, sig(r) === T3, sig(r));
    }
    // 左 / 右边界逐个分隔符（每个字符单独一条；左边界样本右侧补空格、右边界样本左侧补空格，避免被「路径边界上以入口结尾」的老规则兜住）
    const run = (lit) => sig(ev({ 'n.js': cat(CP, 'cp.exec(', JSON.stringify(lit), ');\n') }));
    const LEFT = [[' ', '空格'], ['\t', '制表符'], ['\n', '换行'], ['"', '双引号'], ["'", '单引号'], ['=', '等号'], ['\\', '反斜杠'], ['/', '斜杠']];
    const RIGHT = [[' ', '空格'], ['\t', '制表符'], ['\n', '换行'], ['"', '双引号'], ["'", '单引号'], ['&', '&'], ['|', '|'], [';', ';'], ['<', '<'], ['>', '>'], [')', '右括号']];
    const leftBad = LEFT.filter(([d]) => run(cat('a', d, SJS, ' x')) !== T3).map(([, nm]) => nm);
    const rightBad = RIGHT.filter(([d]) => run(cat('a ', SJS, d, 'b')) !== T3).map(([, nm]) => nm);
    check('S.30n', `命令串左边界逐个：空格 / 制表符 / 换行 / 双引号 / 单引号 / 等号 / 反斜杠 / 斜杠 各自命中（${LEFT.length} 条，右侧补空格）`, leftBad.length === 0, leftBad);
    check('S.30o', `命令串右边界逐个：空格 / 制表符 / 换行 / 双引号 / 单引号 / & | ; < > 右括号 各自命中（${RIGHT.length} 条，左侧补空格）`, rightBad.length === 0, rightBad);
    const tplL = sig(ev({ 'n.js': cat(CP, 'cp.exec(`a${X}', SJS, ' x`);\n') }));
    const tplR = sig(ev({ 'n.js': cat(CP, 'cp.exec(`a ', SJS, '${X}b`);\n') }));
    const startOnly = run(cat(SJS, ' --x'));
    const endOnly = run(cat('a ', SJS));
    check('S.30p', '命令串边界：模板占位在左 / 在右、串首（后接空格）、串尾（前有空格）各自命中', tplL === T3 && tplR === T3 && startOnly === T3 && endOnly === T3, { tplL, tplR, startOnly, endOnly });
    // 对照组：边界不满足的不报（sink 内与文件级都不报）
    const negs = [cat('my-', SJS), cat('node ./server', '.json'), cat('x', SJS), cat(SJS, 'x'), cat(SJS, '.map'), cat('a ', SJS, ',b'), cat('a ', SJS, ':b')];
    const negBad = negs.filter((lit) => run(lit) !== '');
    check('S.30q', '对照：入口名前后边界不满足的串（my-<入口>、server.json、x<入口>、<入口>x、<入口>.map、<入口>,b、<入口>:b）在 sink 内与文件级都判绿', negBad.length === 0, negBad);
    const proseNoCp = ev({ 'n.js': cat("const MSG = 'see ./", SJS, " for details';\nconsole.log(MSG, 'node ", SJS, " --x');\n") });
    check('S.30r', "对照：文件没有 child_process、字符串也不在 sink 里的说明文字（'see ./<入口> for details'）判绿", proseNoCp.problems.length === 0, sig(proseNoCp));
    // MIGRATED 叠加：两档适用范围各一条
    const mSink = ev({ 'm.js': afterReady(SRC.good, cat("require('child_process').exec('node ./", SJS, " --port 0');")) }, { mig: MIG });
    const mFile = ev({ 'm.js': afterFx(SRC.good, cat("const cp = require('child_process');\nconst HINT = 'run node ", SJS, " first';")) }, { mig: MIG });
    check('S.30s', 'MIGRATED 叠加：sink 实参里的命令串、require 了 child_process 的文件里的命令串（sink 外）各恰判红 MIGRATED/T3', sig(mSink) === want('m.js|MIGRATED|T3') && sig(mFile) === want('m.js|MIGRATED|T3'), { a: sig(mSink), b: sig(mFile) });
    // SOURCE_READERS 不豁免 sink 实参里的命令串；文件级命令串（sink 外）对登记文件放过——但登记文件本来就不许 require child_process，SPAWN 硬门照红
    const RD = { 'rd.js': RD_REASON };
    const rdSink = ev({ 'rd.js': cat(SRC.readOut, "exec('node ./", SJS, " --x');\n") }, { readers: RD });
    check('S.30t', 'SOURCE_READERS 登记了也不豁免 sink 实参里的命令串：恰判红 OTHER|T3 + SOURCE_READERS|SPAWN（裸 exec 是 sink 调用）', sig(rdSink) === want('rd.js|OTHER|T3', 'rd.js|SOURCE_READERS|SPAWN'), sig(rdSink));
    // [1] 只靠文件级判据才能抓到的模板串命令样本：起别名的 run 不是 sink 名，模板串静态片段以参数尾缀收尾（「以入口结尾的路径」规则兜不住）
    const tplAlias = ev({ 'n.js': cat(CP, "const run = require('util').promisify(cp.exec);\nconst ROOT = __dirname; const p = 1;\nrun(`node ${ROOT}/", SJS, " --port ${p}`);\n") });
    check('S.30u', '文件级判据抓模板串命令串：const run = util.promisify(cp.exec); run(`node ${ROOT}/<入口> --port ${p}`)（run 不是 sink 名、模板串以参数尾缀收尾）→ 完整签名恰为 OTHER|T3', sig(tplAlias) === T3, sig(tplAlias));
    // [2] 不引入 child_process、命令串嵌套在 sink 实参子树里（数组元素 / 嵌套模板串 / 字符串拼接的一段）：只查 sink 直接实参的实现会漏
    const nested = {
        '数组元素里的字符串': cat("function launch(spawn) { spawn('sh', ['-c', 'node ./", SJS, " --port 0']); }\n"),
        '数组元素里的模板串': cat("function launch(spawn, ROOT, p) { spawn('sh', ['-c', `node ${ROOT}/", SJS, " --port ${p}`]); }\n"),
        '字符串拼接的一段': cat("function launch(exec) { exec('cd .. && ' + 'node ./", SJS, " --port 0'); }\n"),
        '对象属性值里的字符串': cat("function launch(spawn) { spawn('sh', { args: ['-c', 'node ./", SJS, " --port 0'] }); }\n"),
    };
    const nestedBad = Object.entries(nested).map(([k, src]) => ({ k, sg: sig(ev({ 'n.js': src })) })).filter((x) => x.sg !== T3);
    check('S.30v', '命令串嵌套在 sink 实参子树里且文件没有 child_process（数组元素 / 嵌套模板串 / 拼接的一段 / 对象属性值）→ 各恰判红 OTHER|T3（识别要递归整棵实参子树，不只看直接实参）', nestedBad.length === 0, nestedBad);
}

/** 修复批 3 · 真实密钥 T2（15-R [4]）：process.env 下解析出的属性名统一查，不限计算属性；MIGRATED 的补充命中不被分析器过滤丢掉 */
function sectionSecretForms() {
    const names = ['JWT_SECRET', 'DB_ENCRYPTION_KEY'];
    const forms = (nm) => ({
        '可选链 process.env?.X': cat('const s = process.env?.', nm, ';\n'),
        "可选链方括号 process.env?.['X']": cat("const s = process.env?.['", nm, "'];\n"),
        '可选链 process?.env.X': cat('const s = process?.env.', nm, ';\n'),
        '换行分隔 process.env⏎.X': cat('const s = process.env\n  .', nm, ';\n'),
        '换行 + 可选链 process.env⏎?.X': cat('const s = process.env\n  ?.', nm, ';\n'),
        '块注释分隔 process.env /* c */ .X': cat('const s = process.env /* c */ .', nm, ';\n'),
        '行注释分隔 process.env // c⏎ .X': cat('const s = process.env // c\n  .', nm, ';\n'),
        '解构 process?.env': cat('const { ', nm, ' } = process?.env;\n'),
    });
    const badU = []; const badM = [];
    for (const nm of names) {
        for (const [k, src] of Object.entries(forms(nm))) {
            const r = ev({ 's.js': src });
            if (sig(r) !== one('T2', 's.js')) badU.push({ nm, k, sg: sig(r) });
            const m = ev({ 'm.js': afterFx(SRC.good, src.trim()) }, { mig: MIG });
            if (sig(m) !== want('m.js|MIGRATED|T2')) badM.push({ nm, k, sg: sig(m) });
        }
    }
    check('S.31a', 'T2 真实密钥补充形态（可选链 / 换行 / 块注释 / 行注释 / 解构 process?.env）× JWT_SECRET / DB_ENCRYPTION_KEY：未登记文件恰判红 OTHER|T2', badU.length === 0, badU);
    check('S.31b', '同样的补充形态在 MIGRATED 文件里恰判红 MIGRATED/T2（分析器 R2 的文本正则看不到，补充命中不被分析器过滤条件丢掉）', badM.length === 0, badM);
    // 点号写法分析器 R2 本来就报：MIGRATED 里只报 R2，不重复报 T2（补充命中只留给分析器看不到的）
    const dup = names.map((nm) => sig(ev({ 'm.js': afterFx(SRC.good, cat('const s = process.env.', nm, ';')) }, { mig: MIG })));
    check('S.31c', 'MIGRATED 里的点号写法 process.env.<密钥> 只报分析器 R2，不重复报 T2', dup.every((s) => s === want('m.js|MIGRATED|R2')), dup);
    const ctl = ev({ 's.js': "const a = process.env?.NODE_ENV;\nconst b = process.env\n  .PATH;\nconst { HOME } = process?.env;\nconst c = other.env?.JWT_SECRET_X;\n" });
    // [10] 环境变量解构读取：声明形态与赋值形态共用一个识别函数，T2（真实密钥名）/ T5（TEST_* 变量）× 未登记 / MIGRATED
    const destrForms = (nm) => ({
        '声明解构 const { X } = process.env': cat('const { ', nm, ' } = process.env;'),
        '赋值解构 ({ X: v } = process.env)': cat('let v;\n({ ', nm, ': v } = process.env);'),
        '赋值解构 + computed 字面量键': cat("let v;\n({ ['", nm, "']: v } = process.env);"),
        '赋值解构 + 可选链右值 process?.env': cat('let v;\n({ ', nm, ': v } = process?.env);'),
        '声明解构 + computed 字面量键': cat("const { ['", nm, "']: v } = process.env;"),
        '参数默认值 function f({ X } = process.env)': cat('function f({ ', nm, ' } = process.env) { return 0; }'),
        '箭头参数默认值 ({ X } = process.env) => 0': cat('const g = ({ ', nm, ' } = process.env) => 0;'),
    });
    const destrBad = [];
    for (const [nm, code] of [...['JWT_SECRET', 'DB_ENCRYPTION_KEY'].map((x) => [x, 'T2']), ...TEST_VAR_NAMES.map((x) => [x, 'T5'])]) {
        for (const [fk, src] of Object.entries(destrForms(nm))) {
            const u = ev({ 's.js': src });
            if (sig(u) !== one(code, 's.js')) destrBad.push({ nm, fk, where: '未登记', sg: sig(u) });
            const mg = ev({ 'm.js': afterReady(SRC.good, src) }, { mig: MIG });
            if (sig(mg) !== want(`m.js|MIGRATED|${code}`)) destrBad.push({ nm, fk, where: 'MIGRATED', sg: sig(mg) });
        }
    }
    check('S.31e', `环境变量解构（声明 / 赋值 / 参数默认值 / computed 字面量键 / 可选链右值）× T2（2 个密钥名）· T5（${TEST_VAR_NAMES.length} 个测试变量）× 未登记 / MIGRATED：各完整签名恰为 OTHER|T2·T5 或 MIGRATED|T2·T5（MIGRATED 的补充命中不被过滤）`, destrBad.length === 0 && TEST_VAR_NAMES.length === 6, destrBad.slice(0, 6));
    const destrCtl = ev({ 's.js': 'let a;\nconst { JWT_SECRET } = config;\n({ TEST_BASE_URL: a } = config.env);\n({ NODE_ENV: a } = process.env);\nconst { HOME: h } = process?.env;\nfunction g({ JWT_SECRET } = config) { return 0; }\nfunction k({ NODE_ENV } = process.env) { return 0; }\n' });
    check('S.31f', '对照：解构别的对象（config / config.env）、解构 process.env 里别的变量（NODE_ENV / HOME）判绿——赋值形态、参数默认值形态同样不误报', destrCtl.problems.length === 0, sig(destrCtl));
    check('S.31d','对照：process.env 下别的变量（NODE_ENV / PATH / HOME）、不是 process.env 的对象、名字只是前缀相同的变量不报', ctl.problems.length === 0, sig(ctl));
}

/** 修复批 3 · T4 认字面量动态导入（15-R [5]） */
function sectionImportT4() {
    const forms = {
        "import('./_test-fixture.js')（带 .js 后缀）": "(async () => { const { default: fx } = await import('./_test-fixture.js'); await fx.ready(); await fx.teardown(); })();\n",
        "import('./_test-fixture')（无后缀）": "import('./_test-fixture').then((m) => m.ready());\n",
        "import('./lib/test-env')": "import('./lib/test-env').then((te) => te.ready());\n",
        "import('./lib/test-env.js')": "import('./lib/test-env.js');\n",
    };
    const bad = Object.entries(forms).map(([k, src]) => ({ k, sg: sig(ev({ 'n.js': src })) })).filter((x) => x.sg !== one('T4', 'n.js'));
    check('S.32a', '字面量动态导入夹具 / test-env（带 .js 与无后缀）→ 未登记文件恰判红 T4（沿用 READY_MODULE_RE）', bad.length === 0, bad);
    const ctl = ev({ 'n.js': "import('./lib/other-thing').then(() => 1);\nconst name = './lib/test-env';\nimport(name);\n" });
    check('S.32b', '对照：import 别的模块判绿；import(变量) 是登记残余，不报', ctl.problems.length === 0, sig(ctl));
}

/** 修复批 3 · SR 门的模块识别（15T-R M2、预筛 H2 S1 / S2）：node: 前缀与 import() 各一条定向样本，样本里不追加别的 sink，签名恰为 SOURCE_READERS|SPAWN */
function sectionSrModules() {
    const RD = { 'rd.js': RD_REASON };
    const forms = [
        ["require('node:child_process')", "const m = require('node:child_process');\n"],
        ["import('child_process')", "import('child_process');\n"],
        ["import('node:child_process')", "import('node:child_process');\n"],
    ];
    for (const [i, [label, line]] of forms.entries()) {
        const r = ev({ 'rd.js': cat(SRC.readOut, line) }, { readers: RD });
        check(`S.34${'abc'[i]}`, `SR 硬门模块识别：${label}（样本里没有别的 sink 调用）→ 完整签名恰为 SOURCE_READERS|SPAWN`, sig(r) === want('rd.js|SOURCE_READERS|SPAWN'), sig(r));
    }
}

/** 修复批 3 · 简化 ② 候选基线完整校验：init / shrink（含「无变化」）共用 validateCandidateBaseline；换入检查的 blob 读取器按候选自己的 createdAtHead 构造 */
function sectionCandidateValidation() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-tis-cv-'));
    const made = [];
    const put = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); made.push(f); return f; };
    const reserve = (name) => { const f = path.join(tmp, name); made.push(f); return f; };
    try {
        const reg = emptyReg();
        const mk = (files, extra) => Object.assign({ files: Object.keys(files), read: (n) => files[n], registry: reg, familyNames: new Set() }, extra || {});
        // init：候选必须过完整检查（15-R [7]）
        const fA = reserve('init-ready.json');
        const iA = G.initBaseline(mk({ 'y.js': SRC.noCloser }), fA, 'HEADSHA', 'NOW');
        check('S.35a', '--init-baseline 先过完整检查：已调用夹具 ready()、未登记 MIGRATED 的脚本（T4）→ 候选基线报 READY → 拒绝，基线文件保持不存在', iA.ok === false && !fs.existsSync(fA) && iA.lines.some((l) => /y\.js \| BASELINE \| READY/.test(l)), iA);
        const seen = [];
        const nullBlobs = (h, names) => { seen.push([h, names.slice()]); return () => null; };
        const fB = reserve('init-blob.json');
        const iB = G.initBaseline(mk({ 'z.js': SRC.t1Url }, { makeBlobAt: nullBlobs }), fB, 'HEADSHA', 'NOW');
        check('S.35b', '--init-baseline：换入检查的 blob 读取器按候选自己的 createdAtHead 构造（makeBlobAt 收到 HEADSHA 与候选里的文件名）；文件在该提交的树里不存在 → NOTATHEAD → 拒绝，不创建基线文件',
            iB.ok === false && !fs.existsSync(fB) && seen.length === 1 && seen[0][0] === 'HEADSHA' && seen[0][1].join(',') === 'z.js' && iB.lines.some((l) => /z\.js \| BASELINE \| NOTATHEAD/.test(l)), { iB, seen });
        const fC = reserve('init-blob-ok.json');
        const iC = G.initBaseline(mk({ 'z.js': SRC.t1Url }, { makeBlobAt: () => () => SRC.t1Url }), fC, 'HEADSHA', 'NOW');
        check('S.35c', '对照：--init-baseline 的 blob 读取器能读到同样的内容 → 通过完整检查，写入（entries 只有 z.js:T1）', iC.ok === true && fs.existsSync(fC) && JSON.stringify(JSON.parse(fs.readFileSync(fC, 'utf8')).entries) === JSON.stringify({ 'z.js': ['T1'] }), iC);
        // shrink：无变化也必须先过完整检查（15-R [2]）
        const body = G.baselineText(bl({ 'a.js': ['T1'] }));
        const fD = put('shrink-same.json', body);
        const hD = sha(fD);
        const sBlob = G.shrinkBaseline(mk({ 'a.js': SRC.t1Url }, { makeBlobAt: nullBlobs }), fD);
        const sScan = G.shrinkBaseline(mk({ 'a.js': SRC.t1Url }, { scanProblems: [{ file: '(扫描前提)', cls: 'SCAN', rule: 'SYMLINK', evidence: 'x' }] }), fD);
        const regStale = Object.assign(emptyReg(), { EXEMPT: { 'gone-backfill.js': 'r' } });
        const sStale = G.shrinkBaseline({ files: ['a.js'], read: () => SRC.t1Url, registry: regStale, familyNames: new Set() }, fD);
        check('S.35d', '--shrink-baseline 无变化分支也先过完整检查：重算与旧基线相等，但 createdAtHead 树里没有该文件（NOTATHEAD）/ 扫描前提有问题 / 登记表有过期条目 → 各拒绝（不返回「无变化」），基线字节不变',
            [sBlob, sScan, sStale].every((s) => s.ok === false && s.changed === undefined) && sha(fD) === hD && sBlob.lines.some((l) => /NOTATHEAD/.test(l)) && sScan.lines.some((l) => /SYMLINK/.test(l)) && sStale.lines.some((l) => /gone-backfill\.js/.test(l)), { sBlob, sScan, sStale });
        const sOk = G.shrinkBaseline(mk({ 'a.js': SRC.t1Url }, { makeBlobAt: () => () => SRC.t1Url }), fD);
        check('S.35e', '对照：完整检查全部通过且重算与旧基线相等 → 「无变化」成功，字节不变', sOk.ok === true && sOk.changed === false && sha(fD) === hD, sOk);
        const seen2 = [];
        const fE = put('shrink-head.json', G.baselineText({ createdAt: 'T0', createdAtHead: 'HEAD-OLD', maxEntries: 1, entries: { 'a.js': ['T1'] } }));
        G.shrinkBaseline(mk({ 'a.js': SRC.t1Url }, { makeBlobAt: (h, names) => { seen2.push([h, names.slice()]); return () => SRC.t1Url; } }), fE);
        check('S.35f', '--shrink-baseline：换入检查的 blob 读取器按候选（沿用旧基线）的 createdAtHead 构造', seen2.length === 1 && seen2[0][0] === 'HEAD-OLD' && seen2[0][1].join(',') === 'a.js', seen2);
        // 缩表重算带 sourceReader 选项（预筛 L5）：登记 SOURCE_READERS 的基线文件，sink 外的入口字面量不算 T3
        const fF = put('shrink-sr.json', G.baselineText(bl({ 'rd.js': ['T4'] })));
        const hF = sha(fF);
        const regSr = Object.assign(emptyReg(), { SOURCE_READERS: { 'rd.js': RD_REASON } });
        const sSr = G.shrinkBaseline({ files: ['rd.js'], read: () => cat(SRC.readOut, SRC.t4Fx), registry: regSr, familyNames: new Set() }, fF);
        check('S.35g', '对照：--shrink-baseline 重算带 sourceReader 选项——登记了 SOURCE_READERS 的基线文件（冻结 T4，sink 外有入口字面量）判「无变化」，不把入口字面量算成新违规', sSr.ok === true && sSr.changed === false && sha(fF) === hF, sSr);
        // validateCandidateBaseline 的输入形态
        const vBad = G.validateCandidateBaseline(mk({ 'a.js': SRC.t1Url }), { createdAt: 'T0', createdAtHead: 'H0', entries: { 'a.js': ['T1'] } });
        check('S.35h', 'validateCandidateBaseline：候选缺 maxEntries → 完整检查报 (基线)|BASELINE|FORMAT', sig(vBad) === want('(基线)|BASELINE|FORMAT'), sig(vBad));
    } finally {
        for (const f of made) { try { fs.unlinkSync(f); } catch (_) { /* 已不存在 */ } }
        try { fs.rmdirSync(tmp); } catch (_) { /* 非空则留给操作系统临时目录清理 */ }
    }
}

function main() {
    sectionCounterexamples();
    sectionFinish();
    sectionNameTables();
    sectionServerForms();
    sectionCmdStrings();
    sectionSecretForms();
    sectionImportT4();
    sectionSourceReaders();
    sectionSrModules();
    sectionSelfIsolated();
    sectionDbPathAsserters();
    sectionControls();
    sectionScanSet();
    sectionBaselineFiles();
    sectionCandidateValidation();
    sectionRealRepo();
    console.log(`verify-test-isolation-static-suite PASS=${pass} FAIL=${fail}`);
    process.exit(fail === 0 ? 0 : 1);
}
try { main(); } catch (e) {
    console.log(`CHECK Z.0 FAIL 套件自身异常\n         ${(e && e.stack) || e}`);
    console.log(`verify-test-isolation-static-suite PASS=${pass} FAIL=${fail + 1}`);
    process.exit(1);
}
