#!/usr/bin/env node
/**
 * #106 S4a：全目录静态守卫——测试脚本隔离（登记表 + 未迁移基线「只减不增」）。
 *
 * 动机：S4b–S4e 要分批迁移约 170 个脚本。迁移期间先挡住**新增**违规，并给每批迁移一个客观完成判据（方案 v1.3 W3「守卫与反例」：禁止新增写死端口或真实库路径；
 * 反例 1「加回写死 3000」必须判红；验收第 2 条：测试脚本里写死的 3000 与真实库路径为 0）。
 *
 * ═══ 威胁模型（修复批 2 起写在这里） ═══
 * 静态守卫是**第二道防线**；主保证是 test-env 的运行时校验（变量组校验、业务库路径拒绝、夹具 fail-closed）。守卫的目标是：**诚实开发者常见的写法必须判红**。
 * 刻意绕过——拆字符串、多层变量中转、对象属性中转、eval、动态 require(变量) 等——登记为残余，不追求覆盖。判据一律写成硬门，不加「智能放行」。
 * 已登记的残余 / 取舍（审查时不要再当新发现报）：
 *   · 字面量先赋给变量再传给 sink / require（`const S = join(…, 'server.js'); spawn('node', [S])`）、拆字符串、`spawn(process.execPath, ['.'])`、`npm start` 看不到（'.' 会误伤 git add .）；
 *     SOURCE_READERS 靠硬门补这一条：登记文件里出现 child_process 的 require / import() 或任何 sink 调用即判红 SPAWN。
 *   · 成员调用 `X.exec(…)` 只有文件里 require 了 child_process 时才算 sink（裸标识符 exec(…) 与 X.spawn / X.fork / X.execFile / X.execFileSync / X.execSync / X.spawnSync 照旧算）：
 *     所以静态分析脚本里的 `RE.exec(src)` 不会让 SOURCE_READERS 的 SPAWN 门判红；SR 文件本来就禁止 require child_process，里面不可能有真正的 cp.exec。require 了 child_process 的文件里 re.exec 被算成 sink 只会误红（安全方向）。
 *   · `'http://localhost' + ':' + 3000` 这类拼接、`const e = process.env; e.TEST_X`、`process.env[\`TEST_X\`]`（模板串键）、`require(变量)` 形态的夹具 / test-env 引用看不到。
 *   · EXEMPT_NO_READY / INFRA 条目不扫内容；INFRA 靠 INFRA_ALLOWED 常量把关。
 *   · createdAtHead / maxEntries 被手改：createdAtHead 手改是唯一还能「换入」基线条目的口子（条目必须存在于 createdAtHead 的树里且冻结集合 ⊆ 该版本的命中），靠审查看 diff。
 *   · FAMILY 成员集合真实读取失败时整守卫判红（不会静默变空）；若恒空，EXEMPT 的 verify-/test-/smoke- 前缀检查仍兜底（所以不单测「FAMILY 集合恒空」）。
 *   · dropSourceReadR3 的「对不上就一条都不滤」分支在正常源码上走不到（分析器 R3 与 serverJsLiterals 同一遍历），不补用例。
 *   · 基线文件解析失败 / 不存在时 runCli 在读文件层就判红；即使拆掉那一层，evaluate 的 MISSING / FORMAT 层仍红，所以不单测拆掉后的行为。
 *   · （修复批 3 登记）命令串识别是一条分隔符边界正则（SERVER_JS_CMD_RE），适用于 sink 实参里的全部字符串，以及 require 了 child_process 的文件里的全部字符串：宁可误红，不再按命令形态细分。
 *     代价：这类文件里说明文字带 `server.js`（提示信息、注释外的字符串）也判 T3，要么改成拼接写法，要么进基线（2 个基线文件因此多冻结了 T3）。
 *   · 不认的起进程方式：worker_threads 的 `new Worker(…)`、第三方 spawner（cross-spawn 等）；SOURCE_READERS 的 SPAWN 门同样只认 child_process 的 require / import()。
 *     cluster.fork() 计为 sink 调用（SR 的 SPAWN 门会红），但它不带入口路径实参，T3 看不到它起的进程。
 *   · 经 module.require / process.mainModule.require / createRequire 取得 child_process 后，「成员 .exec + 命令串」判绿（文件里没有被识别的 require / import()，成员 .exec 不算 sink，文件级一档也不适用）；
 *     READY 门看不到经 `await import(...)` 取得的夹具的 ready()；`process.env[\`JWT_SECRET\`]` 模板串键、`import(\`./_test-fixture.js\`)` 模板串同属看不到。
 *   · 夹具 ready() 的来源识别（collectModuleBindings）对「绑定名在整份源码里声明多于 1 次」的名字一律不认（保守），所以这种写法的基线文件在 READY 门上看不到它已调用 ready()。
 *   · finish(code) 经本地包装函数 / 具名非入口函数间接调用（`function done(c) { fx.finish(c); }`）看不到；回调（forEach 等）里的 finish 属于别的函数，不查回调之后的代码。
 *     迁移约定：helper 里的 process.exit 改成 throw，不得改成 finish（finish 不终止执行，helper 里调用后调用方还会继续往下跑）。
 *   · finish(code) 的祖先检查是硬门，不区分 try 块 / catch / finally 块：调用点到最近函数边界之间只要有带 finalizer 的 try（含 finish 写在 finally 块自己最后一条的诚实写法）或任何循环，一律 FINISH_NOT_LAST。
 *     这类脚本迁移时把 finish 放到 try 语句之后（try 里抛错且没有 catch 接住时，try 之后的代码不会跑，退出码由入口链的 .catch 兜底）。这是取舍（宁可误红），不是漏洞。
 *   · 经 instance-mode / lines 启动器取业务库路径（不出现 task_pool.db 字面量、也不读 process.env 密钥）看不到；`process['env']` 方括号取 env 对象、import(变量) 同属看不到。
 *   · 命令串里不带扩展名的入口（`node ./server`）、scripts 上级目录（wbs-server / 仓库根）本身是 junction（工作树 lstat 只查顶层 .js，以及注入 scriptsDir 时的 scripts 目录）都不认 / 不查；
 *     命令行下 scripts 目录本身是 junction 时 __dirname 已是真实路径，守卫看不到这一层。
 *   · process.env 解构只认右值恰为 process.env（含可选链）的三种语法：从 process 嵌套解构（`const { env: { JWT_SECRET } } = process`）、
 *     右值是 `process.env || {}` / `{ ...process.env }` / `[process.env]` 的数组或 for-of 解构、解构里的模板串 computed 键都看不到（收口预筛 LOW-D）。
 *   · --init-baseline 的 HEAD 树硬门按「仓库根 → 基线」的相对路径查 ls-tree，大小写敏感；命令行里敲的路径大小写与仓库不一致时（__dirname 保留所敲大小写）
 *     ls-tree 查不到、硬门放行。影响有限：基线是已提交文件，重建会在 diff 里整份变化，靠审查看见（收口预筛 LOW-A，旧 cat-file 实现同样如此）。
 *   · require.resolve 与 require / import() 一样算「sink 内」且 SOURCE_READERS 不豁免（约定：登记为 SOURCE_READERS 的文件读 server 源码时用 path.join 拼路径，不用 require.resolve）。
 *   · （S4b2b 登记）SELF_ISOLATED 的残余：（a）wrapper 只保证库被重定向（IA_TEST_DB_PATH 必填 + 三层比对；检出目录里 fail-closed），不管 .env、uploads、外呼；F2 的第一个实参若解析到检出目录（如 ROOT），起的是检出目录的代码，守卫看不到——与非 SI 文件现状相同；
 *     （b）F3 不证明种子脚本拿到的是临时目标库——靠种子脚本自己的成对规则（TARGET_DB 与 --allow-db-override 成对出现，缺一半在打印 TARGET_DB 之前就拒绝）与 G2 的 runSeedScriptSync / spawnSeedScriptAsync 里的运行时断言；
 *     （c）非 node 名单（taskkill / powershell / git）里的程序经命令行间接起 node，看不到；（d）起 node 的第一个脚本参数之后的其余参数不查（`--require` 打头判红，但跟在脚本后面的选项不管）；
 *     （e）变量间接（`const e = path.join(__dirname, 'server.js'); require(e)`、经 NODE_OPTIONS 字符串拼接预加载入口、拆字符串拼出模块名后 require(变量)）仍看不到；
 *     （f）SELF_ISOLATED 的名单没有像 INFRA_ALLOWED 那样的守卫内白名单——新增条目只改登记表，在审查 diff 里可见；条目一旦登记，上面的硬规则对它全部生效（Tier-1 零命中、sink 形态、child_process 绑定形态、过期）。
 *   · （S5 登记）ARCHIVE 门的残余：（a）只判命名与说明头，不扫内容——带说明头但正文开业务库、起服务的 _archive/ 文件不拦；
 *     （b）_archive/ 下的文件没有任何批跑器会执行：FAMILY 只 readdir 顶层的 verify-sys-*（run-verify-family.js:75），验收清单成员必须是 MIGRATED（verify-test-acceptance-batch.js:114–120）、MIGRATED 又必须在顶层扫描集合里——所以不扫内容的代价是“人手去跑它”才会出事；
 *     （c）只认精确目录名 `_archive`（`_Archive` 在大小写敏感的文件系统上不会被枚举）；（d）被 .gitignore 忽略的文件、未跟踪的嵌套仓库不枚举；（e）.mjs / .cjs 与顶层同口径，不认；
 *     （f）lib/、fixtures/ 等其他子目录本来就不在扫描面（S5 之前的口径），ARCHIVE 门没有改变这一点。
 *
 * 扫描集合：git -C <仓库根> ls-files --cached --others --exclude-standard -- wbs-server/scripts 的**顶层** .js（不递归；含未跟踪但未被忽略的新文件）。git 失败 → 判红，不回落到目录读取。
 * 扫描前提（硬门，任一不满足判红，照 verify-no-listen-zero.js 的四道）：仓库根 = 项目根；scripts/ 下无符号链接 / 子模块（索引模式 120000 / 160000，**另**对扫描集合里每个顶层 .js 做工作树 lstat，符号链接 / junction / lstat 失败都判红；scripts 目录本身的 lstat 只在注入 scriptsDir 时有效——命令行下 __dirname 已是真实路径，lstat(__dirname) 恒不是链接）；
 * 未开稀疏检出；被忽略的顶层 .js 不得以 verify- / test- / smoke- 开头（不分大小写）；
 * ARCHIVE：wbs-server/scripts/_archive/ 不在扫描集合里（只扫顶层）。测试命名（verify- / test- / smoke-）的脚本不得放进 _archive/；_archive 下（任意深度，git ls-files --cached --others --exclude-standard）的 .js 必须带说明头
 * （前 10 行含「历史工具，不再运行」）；git 失败 / 输出无法解析 / 文件读不到都判红。只拒不放行，没有豁免名单。只判命名与说明头、不扫内容，不声称能防所有躲避（残余见上方“S5 登记”）。
 * 分类（每个文件落入且只落入一类）：
 *   MIGRATED  已迁移（lib/test-isolation-registry.js）：分析器全部规则 R1–R7（EXEMPT_NO_READY 照旧）+ 收尾检查 + 叠加分析器看不到的补充写法（T1 .listen(3000)、T2 补充形态、T3 补充形态、T5）。
 *   EXEMPT    豁免（部署维护 / 演示 / 探针类，不是测试）：理由必填；名字不得以 verify- / test- / smoke- 开头；不得是 FAMILY 成员；Tier-1 零命中即判过期（豁免必须有必要）。
 *   INFRA     测试基础设施本身或隔离机制自己的测试：不扫内容；理由必填；名字必须在本文件的 INFRA_ALLOWED 常量里（新增须改常量，审查 diff 可见）。
 *   基线      lib/test-isolation-baseline.json：Tier-1 命中的规则代号集合必须**恰好等于**冻结的集合（多一条 = 迁移期间新增了违规；少一条 = 违规已消失，应从基线删除）；
 *             条目文件必须存在于 createdAtHead 的树里且冻结集合 ⊆ 该版本的命中（防「换入」）；已调用 ready() 的文件不得留在基线（防半迁移躲开 R4–R7）。
 *   其他      未登记：Tier-1 零命中才判绿。
 * Tier-1：T1 写死 3000（含 .listen(3000)）· T2 task_pool.db / dotenv / JWT_SECRET|DB_ENCRYPTION_KEY（process.env 下的点号、方括号、可选链、换行或注释分隔；右值恰为 process.env 的声明 / 赋值 / 参数默认值三种解构）/ process.loadEnvFile / 以 .env 结尾的字符串 · T3 起主服务的字符串（server.js 路径、命令串、
 *   require / require.resolve / import() 实参里的 server、sink 实参里的 'server'）· T4 用了 _test-fixture / test-env（require 或字面量 import()）但不在 MIGRATED · T5 绕过 test-env 直接读测试变量（实现见 lib/test-script-guard.js scanTier1）。
 *   T3 拆两半：位于 sink 调用（spawn / spawnSync / fork / exec / execSync / execFile / execFileSync）实参里、或 require 类实参里的，任何文件都判 T3（进程内 require 主服务入口会无条件 listen）；
 *   命令串（分隔符边界正则）在 sink 实参里、以及 require 了 child_process 的文件的全部字符串里都判 T3；其余（sink 外的路径字面量等）判 T3，除非文件登记在 SOURCE_READERS（只读 server.js 源码做静态断言的脚本）。
 *   SOURCE_READERS 是硬门：附加属性，可与 MIGRATED / 基线 / 其他并存，不能与 EXEMPT / INFRA 并存；
 *   必须至少有一处 sink 外字面量（否则 STALE）；不得 require / import() child_process（含 node: 前缀）、不得有任何 sink 调用（否则 SPAWN）。
 *   SELF_ISOLATED（S4b2b，自带隔离机制的套件：自己把源码复制到临时根、空库建 schema、经副本里的 wrapper 起服务，或只对临时 sqlite 文件跑种子脚本）是附加属性：
 *     可与 MIGRATED 并存；与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线任一并存即红 SELF_ISOLATED|CONFLICT；理由必填（REASON）、文件须在扫描集合里（STALE）。硬规则（确定性，不加智能放行）：
 *     ① 只登记 SELF_ISOLATED 的文件按「其余」口径——Tier-1 全部零命中（T1 / T2 / T5 为零，T4 也必须为零：用了 test-env 就该登记 MIGRATED）；MIGRATED + SELF_ISOLATED 按 MIGRATED 口径（分析器 R1–R7 + Tier-1 补充命中）；
 *     ② sink 形态（红码 SELF_ISOLATED|SPAWN_FORM，带行号）：exec / execSync / fork 一律红；spawn / spawnSync / execFile / execFileSync 看第一个实参——process.execPath 或字面量 node(.exe) → 起 node，第二个实参必须是数组字面量、
 *        第一个元素必须是 F1 `__filename` / F2 `path.join(<非 __dirname>, 'scripts', '_test-it-asset-ledger-server-wrapper.js')`（恰 3 个实参）/ F3 `path.join(__dirname, '_seed-*.js')`（恰 2 个实参，且该文件名在扫描集合里）之一，展开元素 / 变量 / `--require` 或 `-e` 打头 / 缺数组都红；
 *        字面量 taskkill / powershell / git（封闭名单）放行；其余（变量、模板串、名单外字面量、调用表达式）一律红；
 *     ②b child_process 绑定形态（红码 SELF_ISOLATED|BINDING，带行号）：require('child_process') 只能是 `const { spawn, spawnSync, execFile, execFileSync } = …` 的初值（const、语法简写、非计算、无默认值、非 rest），
 *        整体赋值 / 取成员 / 改名 / `spawn: spawn` / let·var / 默认值 / rest / import() 一律红；绑定出的标识符除声明处外的引用必须恰是调用的 callee（按名字判定，同名内层变量也红）；
 *        child_process 这个字符串字面量（含无表达式模板串）只许出现在合格声明的 require 实参里（module.require / createRequire / require(`…`) / 变量中转都红）；require / import() 了 worker_threads / cluster（含 node:）→ 红；
 *     ③ T3 窄豁免：只豁免「sink 外、require 类实参外、普通字符串字面量且值恰为 'server.js'」；模板串、带命令内容的串、sink / require 实参里的照旧红；MIGRATED + SELF_ISOLATED 的 R3 用同一判据过滤（dropExemptR3，与 SOURCE_READERS 同款对号方式）；
 *     ④ 过期（SELF_ISOLATED|STALE）：没有任何被豁免的 'server.js' 字面量，或没有 require child_process。
 *   DB_PATH_ASSERTERS（预留的 task_pool.db 字面量豁免名单）必须为空，非空即判红 NOT_EMPTY（首批真实登记文件出现时再与它们一起设计判据）。
 *   MIGRATED 另查 finish(code)（test-env / 夹具导入绑定上的调用，只设 process.exitCode、不终止执行）：先查祖先（调用点到最近函数边界之间有循环、或带 finalizer 的 try → 一律违规，先于所有放行形态），
 *   再看位置：必须在尾部位置（所在块的最后一条且该块逐层处在尾部，或紧跟 return、return finish(…)、箭头表达式体），否则 FINISH_NOT_LAST。
 *   MIGRATED 的 R3 / R2 之外，守卫另叠加 scanTier1 里分析器看不到的补充写法（规则代号用 T1/T2/T3/T5）；MIGRATED + SOURCE_READERS 的 R3 只滤 sink 外的字面量、MIGRATED + SELF_ISOLATED 的 R3 只滤值恰为入口名的 sink 外裸字面量（过滤写在本文件 dropExemptR3，分析器搬入段保持原样）。
 *
 * 用法：node scripts/verify-test-isolation-static.js [--init-baseline | --shrink-baseline]
 *   （无参）检查；绿 → 退出码 0 + 一行 `OK verify-test-isolation-static: …`；红 → 逐条列「文件 | 类 | 规则 | 证据」，退出码 1。git / 登记表 / 基线读取失败一律红。
 *   --init-baseline    只有基线文件不存在、且 HEAD 树里也没有基线文件（git ls-tree -z --name-only HEAD -- <基线路径>：成功且空 = 不存在、成功且恰为该路径 = 存在，其余——含非零退出码 128、输出不认识、抛错——一律判红拒绝；删文件重 init 会整体吸收新违规）时可用：把当前未登记脚本里 Tier-1 命中的文件连同命中集合生成候选基线；
 *                      git log 取不到 HEAD（head 为空）时 HEAD 树硬门被跳过，但 initBaseline 对空 head 直接拒绝（没有取到 git HEAD），不生成候选。
 *                      登记表自身有问题、出现 PARSE 或不在 T1–T5 的代号时拒绝；候选必须过 validateCandidateBaseline（完整检查：换入 / READY / MIGRATED / 扫描前提…）才写，不通过则基线文件保持不存在。
 *   --shrink-baseline  旧基线格式不合法（缺 maxEntries、非负整数、条数超 maxEntries、条目格式错）→ 拒绝；重算后只允许删条目或删规则代号；
 *                      写回的 maxEntries = min(旧 maxEntries, 新条数)；候选先过 validateCandidateBaseline，**通过才允许「写入」或「返回无变化」**，不通过拒绝（拒绝时基线文件字节不变、退出码 1）。没有任何「加条目」的命令。
 *   init / shrink / 无参检查三条路径共用同一个候选基线校验入口 validateCandidateBaseline（对候选跑 check 模式的完整 evaluate，换入检查的 blob 读取器按候选自己的 createdAtHead 构造）。
 * 自检：verify-test-isolation-static-suite.js（独立入口，已登记为 FAMILY 成员）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { analyzeScript, analyzeClosers, scanTier1, tier1Codes, TIER1_CODES, serverJsLiterals, spawnCapability, finishViolations, parseSource, selfIsolatedFacts, isSiExemptLiteral } = require('./lib/test-script-guard');

const NAME = 'verify-test-isolation-static';
const SCRIPTS_REL = 'wbs-server/scripts';
const ARCHIVE_REL = `${SCRIPTS_REL}/_archive`;
const ARCHIVE_MARK = '历史工具，不再运行';
const ARCHIVE_HEAD_LINES = 10;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(__dirname, 'lib', 'test-isolation-baseline.json');

/** INFRA 条目名白名单（S4-0 迁移配方 status === 'infra' 的 19 个 + S7 追加 verify-lines-merge.js = 20）。新增 INFRA 条目 = 改这里，审查 diff 可见 */
const INFRA_ALLOWED = Object.freeze([
    '_test-fixture.js', '_test-it-asset-ledger-server-wrapper.js', 'run-test-batch.js', 'run-verify-family.js',
    'verify-instance-config-keys.js', 'verify-instance-external.js', 'verify-instance-mode.js', 'verify-instance-startup.js',
    'verify-lines-merge.js', 'verify-lines-new-remove-suite.js', 'verify-lines-new-remove.js', 'verify-lines-run-suite.js', 'verify-lines-run.js', 'verify-lines-state.js',
    'verify-test-batch-suite.js', 'verify-test-batch.js', 'verify-test-env-suite.js', 'verify-test-env.js', 'verify-test-instance-suite.js', 'verify-test-instance.js',
]);
/** EXEMPT 条目名禁用前缀：这些前缀的脚本是测试 / 验证，不是部署维护脚本，必须走迁移，不许豁免 */
const EXEMPT_FORBIDDEN_PREFIX_RE = /^(?:verify-|test-|smoke-)/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';
const sortedUniq = (a) => Array.from(new Set(a)).sort();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * MIGRATED 文件登记为 SOURCE_READERS 时，滤掉分析器 R3 里「sink 外」的 server.js 字面量（sink 内 / require 内的不滤）；
 * 登记为 SELF_ISOLATED 时，只滤「sink 外、require 类实参外、值恰为 'server.js'」的那一种（keep 谓词：其余照旧留着）。
 * 分析器搬入段保持原样；过滤写在这里：R3 违规与 serverJsLiterals 里 legacy 的那些按同一遍历顺序一一对应（逐个核对字面量值），对不上就一条都不滤（fail-closed）。
 * keep(l) 为真的 R3 违规保留。
 */
function dropExemptR3(src, vs, keep) {
    const r3 = vs.filter((v) => v.rule === 'R3');
    if (r3.length === 0) return vs;
    let lits;
    try { lits = serverJsLiterals(parseSource(src).ast).filter((l) => l.legacy); } catch (e) { return vs; }
    if (lits.length !== r3.length || !r3.every((v, i) => v.detail.endsWith(lits[i].value))) return vs;
    let i = 0;
    return vs.filter((v) => { if (v.rule !== 'R3') return true; const l = lits[i]; i += 1; return keep(l); });
}
/** SOURCE_READERS：只留 sink 内 / require 类实参里的 */
const keepInSink = (l) => l.inSink;
/** SELF_ISOLATED：被豁免的那一种（isSiExemptLiteral：sink 外、require 类实参外、值恰为入口名的普通字符串字面量）滤掉，其余留着（lits 已按 legacy 预过滤，等价于「sink 内的留着；sink 外的只放过值恰为入口名的」） */
const keepUnlessSiExempt = (l) => !isSiExemptLiteral(l);

/** 分析器 detail 里的 `@偏移` 换算成「行号:原文前 120 字 | detail（@偏移 换成 @L行号）」 */
function lineifyDetail(src, detail) {
    let first = null;
    const d = String(detail).replace(/@(\d+)/g, (m, off) => {
        const l = src.slice(0, Number(off)).split('\n').length;
        if (first === null) first = l;
        return `@L${l}`;
    });
    if (first === null) return d.slice(0, 240);
    const text = (src.split('\n')[first - 1] || '').replace(/\r$/, '').trim().slice(0, 120);
    return `${first}:${text} | ${d}`.slice(0, 380);
}

// ---------------------------------------------------------------- 扫描集合与前提
function defaultExec(bin, args) {
    return execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
function defaultExecBuf(bin, args, input) {
    return execFileSync(bin, args, { input, maxBuffer: 512 * 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}
/** git 取扫描集合；失败 → { ok:false, error }（fail-closed，不回落到 fs.readdirSync） */
function listScanSet(opts) {
    const o = opts || {};
    const exec = o.exec || defaultExec;
    let out;
    try {
        out = exec(o.gitBin || 'git', ['-C', o.repoRoot || REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', SCRIPTS_REL]);
    } catch (e) {
        return { ok: false, error: `git ls-files 调用失败（判红，不回落到目录读取）：${String((e && e.message) || e).split('\n')[0].slice(0, 200)}` };
    }
    const names = new Set();
    for (const p of String(out).split('\0')) {
        const m = /^wbs-server\/scripts\/([^/]+\.js)$/.exec(p);
        if (m) names.add(m[1]);
    }
    if (names.size === 0) return { ok: false, error: `git ls-files 没有返回 ${SCRIPTS_REL} 顶层的任何 .js（扫描集合为空，判红）` };
    return { ok: true, names: Array.from(names).sort() };
}
/**
 * 扫描前提（硬门；照 verify-no-listen-zero.js 的四道，SYMLINK 另加工作树 lstat）。返回问题列表 [{ file:'(扫描前提)', cls:'SCAN', rule, evidence }]，空 = 全部满足。git 本身失败也判红。
 *   TOPLEVEL 仓库根 ≠ 项目根（嵌套仓库 / 子模块）· SYMLINK ① 索引里 scripts/ 下有符号链接或子模块入口（git ls-files -s 的模式 120000 / 160000），
 *     ② 工作树里扫描集合里任一顶层 .js 是符号链接 / junction（lstat；索引模式看不到未暂存的链接，readFileSync 会跟随链接读到别处的内容），lstat 失败也判红；
 *        scripts 目录本身也做 lstat，但只在注入 scriptsDir 时有意义（命令行下默认取 __dirname，已是真实路径，lstat 恒不是链接）·
 *   SPARSE 开了稀疏检出 · IGNORED 被忽略的顶层 .js 以 verify- / test- / smoke- 开头 · ARCHIVE 测试命名（verify- / test- / smoke-）的脚本不得放进 _archive/；_archive 下 .js 必须带说明头（缺说明头 / 读不到 / git 失败也判红；opts.readFile 可注入，自检用）
 * names = 扫描集合的顶层 .js 文件名（lstat 用）；opts.lstat 可注入（自检用），opts.scriptsDir 默认本文件所在目录。
 */
function checkScanPreconditions(opts, names) {
    const o = opts || {};
    const exec = o.exec || defaultExec;
    const bin = o.gitBin || 'git';
    const root = o.repoRoot || REPO_ROOT;
    const git = (args) => { try { return { out: exec(bin, ['-C', root, ...args]) }; } catch (e) { return { error: String((e && e.message) || e).split('\n')[0].slice(0, 160), status: e && e.status }; } };
    const bad = [];
    const P = (rule, evidence) => bad.push({ file: '(扫描前提)', cls: 'SCAN', rule, evidence });
    const top = git(['rev-parse', '--show-toplevel']);
    const actual = top.out !== undefined ? path.resolve(String(top.out).trim()) : null;
    if (actual === null || actual.toLowerCase() !== path.resolve(root).toLowerCase()) P('TOPLEVEL', `git 仓库根 ≠ 本项目根（非嵌套仓库 / 子模块）：${top.error || `${actual} vs ${path.resolve(root)}`}`);
    const staged = git(['ls-files', '-s', '-z', '--', SCRIPTS_REL]);
    const special = staged.out !== undefined ? String(staged.out).split('\0').filter((l) => /^(120000|160000) /.test(l)) : null;
    if (special === null || special.length > 0) P('SYMLINK', `scripts/ 下有符号链接或子模块入口（或 git 失败）：${staged.error || special.join(' ‖ ')}`);
    // 工作树：扫描集合里每个顶层 .js 做 lstat（scripts 目录本身也做，但命令行下 dir 默认是 __dirname，已是真实路径、恒不是链接；注入 scriptsDir 时才有意义）；符号链接 / junction 判红，lstat 失败判红
    const lstat = o.lstat || fs.lstatSync;
    const dir = o.scriptsDir || __dirname;
    const linked = [];
    for (const p of [dir, ...(names || []).map((nm) => path.join(dir, nm))]) {
        try { if (lstat(p).isSymbolicLink()) linked.push(`${p}（符号链接 / junction）`); } catch (e) { linked.push(`${p}（lstat 失败：${String((e && e.message) || e).split('\n')[0].slice(0, 80)}）`); }
    }
    if (linked.length > 0) P('SYMLINK', `工作树里 scripts 目录或顶层 .js 是符号链接 / junction，或 lstat 失败（${linked.length} 处）：${linked.slice(0, 3).join(' ‖ ')}`);
    const sparse = git(['config', '--get', '--bool', 'core.sparseCheckout']);
    // 只有「输出 false」或「退出码 1 = 配置项不存在」算未开启；git 本身失败（其他退出码）判红
    const sparseOff = sparse.out !== undefined ? String(sparse.out).trim() === 'false' : sparse.status === 1;
    if (!sparseOff) P('SPARSE', `开启了稀疏检出（或 git 失败）：${sparse.error || String(sparse.out).trim()}`);
    const ign = git(['ls-files', '-z', '-o', '-i', '--exclude-standard', '--', SCRIPTS_REL]);
    const ignBad = ign.out !== undefined ? String(ign.out).split('\0').filter((f) => { const m = /^wbs-server\/scripts\/([^/]+\.js)$/.exec(f); return !!m && EXEMPT_FORBIDDEN_PREFIX_RE.test(m[1]); }) : null;
    if (ignBad === null || ignBad.length > 0) P('IGNORED', `被忽略的顶层 .js 以 verify- / test- / smoke- 开头（会执行的套件被移出了扫描面，或 git 失败）：${ign.error || ignBad.join(' ‖ ')}`);
    // ARCHIVE：scripts/_archive/ 不在扫描集合里（只扫顶层），所以那里的 .js 只许是带说明头的历史归档文件；测试脚本（verify- / test- / smoke- 开头，不分大小写）躲进去逃过隔离守卫一律判红。
    // 任意深度、含未跟踪但未被忽略的文件；git 失败 / 输出无法解析 / 文件读不到都判红。只拒不放行：没有豁免名单。每个问题文件一条，证据 = 相对路径 + 原因。
    const arc = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ARCHIVE_REL]);
    if (arc.out === undefined) P('ARCHIVE', `${ARCHIVE_REL}（git ls-files 失败，判红）：${arc.error}`);
    else {
        const readFile = o.readFile || ((p) => fs.readFileSync(p, 'utf8'));
        for (const p of String(arc.out).split('\0')) {
            if (p === '') continue;
            if (!p.startsWith(`${ARCHIVE_REL}/`)) { P('ARCHIVE', `${p}（git 输出无法解析：不在 ${ARCHIVE_REL}/ 下）`); continue; }
            if (!/\.js$/i.test(p)) continue;
            if (EXEMPT_FORBIDDEN_PREFIX_RE.test(p.slice(p.lastIndexOf('/') + 1))) { P('ARCHIVE', `${p}（文件名以 verify- / test- / smoke- 开头：测试脚本不得放进 _archive/ 躲过扫描）`); continue; }
            let src;
            try { src = String(readFile(path.join(dir, p.slice(SCRIPTS_REL.length + 1)))); } catch (e) { P('ARCHIVE', `${p}（读文件失败，判红：${String((e && e.message) || e).split('\n')[0].slice(0, 80)}）`); continue; }
            if (!src.split(/\r?\n/).slice(0, ARCHIVE_HEAD_LINES).join('\n').includes(ARCHIVE_MARK)) P('ARCHIVE', `${p}（前 ${ARCHIVE_HEAD_LINES} 行没有「${ARCHIVE_MARK}」说明头）`);
        }
    }
    return bad;
}

// ---------------------------------------------------------------- 基线格式
/** 基线格式问题：[{ file, rule, evidence, fatal }]。fatal = 后面的检查无法继续（缺 entries / maxEntries 不是非负整数） */
function baselineShapeProblems(b) {
    const out = [];
    const F = (file, rule, evidence, fatal) => out.push({ file, rule, evidence, fatal: !!fatal });
    if (!isPlainObject(b)) { F('(基线)', 'FORMAT', '基线不是对象', true); return out; }
    if (!isPlainObject(b.entries)) { F('(基线)', 'FORMAT', 'entries 不是对象', true); return out; }
    if (!Number.isInteger(b.maxEntries) || b.maxEntries < 0) { F('(基线)', 'FORMAT', `maxEntries 不是非负整数：${JSON.stringify(b.maxEntries)}`, true); return out; }
    const n = Object.keys(b.entries).length;
    if (n > b.maxEntries) F('(基线)', 'MAXENTRIES', `基线条数 ${n} 超过 maxEntries=${b.maxEntries}（基线只减不增）`, false);
    for (const [f, codes] of Object.entries(b.entries)) {
        const valid = Array.isArray(codes) && codes.length > 0 && codes.every((c) => TIER1_CODES.includes(c)) && new Set(codes).size === codes.length;
        if (!valid) F(f, 'FORMAT', `基线条目必须是非空、不重复、取自 ${TIER1_CODES.join('/')} 的规则代号数组：${JSON.stringify(codes)}`, false);
    }
    return out;
}

// ---------------------------------------------------------------- 评估
/**
 * 纯评估（不碰真实文件系统 / git；全部输入经 deps 注入，自检用合成数据）。
 * deps = { files: string[]（扫描集合）, read(name): string, registry: { MIGRATED, EXEMPT_NO_READY, EXEMPT, INFRA, SOURCE_READERS, SELF_ISOLATED, DB_PATH_ASSERTERS }, baseline: 解析后的基线对象 | null, familyNames: Set<string>,
 *          infraAllowed?: string[], scanProblems?: 扫描前提问题, blobAt?(name): string | null（createdAtHead 树里该文件的内容；不存在 → null；git 失败 → 抛错；不提供则跳过「换入」检查）,
 *          makeBlobAt?(head, names): blobAt（工厂；只被 validateCandidateBaseline 用，按候选基线自己的 createdAtHead 构造 blobAt） }
 * mode：'check'（默认）| 'init'（baseline 传 null；只产出登记表层面的问题与 initEntries）。
 * 返回 { problems: [{ file, cls, rule, evidence }], counts: { scanned, migrated, exempt, infra, baseline, other, sourceReaders, selfIsolated, dbPathAsserters, baselineCodes }, initEntries }
 */
function evaluate(deps, mode) {
    const m = mode || 'check';
    const reg = deps.registry;
    const baseline = deps.baseline;
    const files = deps.files.slice().sort();
    const scan = new Set(files);
    const infraAllowed = new Set(deps.infraAllowed || INFRA_ALLOWED);
    const problems = [];
    const P = (file, cls, rule, evidence) => problems.push({ file, cls, rule, evidence: String(evidence) });
    const counts = { scanned: files.length, migrated: 0, exempt: 0, infra: 0, baseline: 0, other: 0, sourceReaders: 0, selfIsolated: 0, dbPathAsserters: 0, baselineCodes: {} };
    for (const sp of deps.scanProblems || []) P(sp.file, sp.cls, sp.rule, sp.evidence);

    for (const k of ['MIGRATED', 'EXEMPT_NO_READY', 'EXEMPT', 'INFRA', 'SOURCE_READERS', 'SELF_ISOLATED', 'DB_PATH_ASSERTERS']) {
        if (!reg || !isPlainObject(reg[k])) { P('(登记表)', 'REGISTRY', 'FORMAT', `登记表缺少对象 ${k}（lib/test-isolation-registry.js）`); return { problems, counts, initEntries: {} }; }
    }
    let entries = {};
    if (m === 'check') {
        if (!baseline) { P('(基线)', 'BASELINE', 'MISSING', '基线文件不存在或没有读到（只能用 --init-baseline 创建一次）'); return { problems, counts, initEntries: {} }; }
        const shape = baselineShapeProblems(baseline);
        for (const sp of shape) P(sp.file, 'BASELINE', sp.rule, sp.evidence);
        if (shape.some((sp) => sp.fatal)) return { problems, counts, initEntries: {} };
        entries = baseline.entries;
    }

    const mig = Object.keys(reg.MIGRATED);
    const exe = Object.keys(reg.EXEMPT);
    const inf = Object.keys(reg.INFRA);
    const bl = Object.keys(entries);
    const classesOf = (n) => [mig.includes(n) ? 'MIGRATED' : null, exe.includes(n) ? 'EXEMPT' : null, inf.includes(n) ? 'INFRA' : null, bl.includes(n) ? 'BASELINE' : null].filter(Boolean);
    const overlapped = new Set();
    for (const n of new Set([...mig, ...exe, ...inf, ...bl])) {
        const cs = classesOf(n);
        if (cs.length > 1) { overlapped.add(n); P(n, cs.join('+'), 'OVERLAP', `同一文件出现在 ${cs.join(' 与 ')}（一个文件只能落入一类）`); }
    }
    for (const [cls, list] of [['MIGRATED', mig], ['EXEMPT', exe], ['INFRA', inf], ['BASELINE', bl]]) {
        for (const n of list) if (!scan.has(n)) P(n, cls, 'STALE', '登记表 / 基线里的文件不在扫描集合（git 可见的顶层 .js）里：过期条目，须删除');
    }
    for (const n of exe) {
        if (!nonBlank(reg.EXEMPT[n])) P(n, 'EXEMPT', 'REASON', 'EXEMPT 条目缺少登记理由（必填，非空白）');
        if (EXEMPT_FORBIDDEN_PREFIX_RE.test(n)) P(n, 'EXEMPT', 'PREFIX', 'EXEMPT 条目名以 verify- / test- / smoke- 开头：这是测试脚本，必须迁移，不许豁免');
        if (deps.familyNames.has(n)) P(n, 'EXEMPT', 'FAMILY', 'EXEMPT 条目是 FAMILY 成员（run-verify-family.js 会跑它）：FAMILY 成员必须迁移，不许豁免');
    }
    for (const n of inf) {
        if (!nonBlank(reg.INFRA[n])) P(n, 'INFRA', 'REASON', 'INFRA 条目缺少登记理由（必填，非空白）');
        if (!infraAllowed.has(n)) P(n, 'INFRA', 'ALLOWLIST', 'INFRA 条目不在守卫常量 INFRA_ALLOWED 的白名单里（新增 INFRA 须改守卫常量，在审查 diff 里可见）');
    }
    for (const n of Object.keys(reg.EXEMPT_NO_READY)) {
        if (!mig.includes(n)) P(n, 'MIGRATED', 'NOREADY', 'EXEMPT_NO_READY 条目不在 MIGRATED 里');
        if (!nonBlank(reg.EXEMPT_NO_READY[n])) P(n, 'MIGRATED', 'REASON', 'EXEMPT_NO_READY 条目缺少理由');
    }
    // SOURCE_READERS：附加属性（只读 server.js 源码做静态断言），可与 MIGRATED / 基线 / 其他并存；不能与 EXEMPT / INFRA 并存（那两类不扫内容，登记它没有意义）
    const rdr = Object.keys(reg.SOURCE_READERS);
    const isReader = (n) => has(reg.SOURCE_READERS, n);
    for (const n of rdr) {
        if (!nonBlank(reg.SOURCE_READERS[n])) P(n, 'SOURCE_READERS', 'REASON', 'SOURCE_READERS 条目缺少登记理由（必填，非空白）');
        if (exe.includes(n) || inf.includes(n)) P(n, `SOURCE_READERS+${exe.includes(n) ? 'EXEMPT' : 'INFRA'}`, 'OVERLAP', 'SOURCE_READERS 不能与 EXEMPT / INFRA 并存（那两类不扫内容，登记它没有意义）');
        if (!scan.has(n)) P(n, 'SOURCE_READERS', 'STALE', 'SOURCE_READERS 里的文件不在扫描集合（git 可见的顶层 .js）里：过期条目，须删除');
    }
    // SELF_ISOLATED：附加属性（自带隔离机制的套件）。可与 MIGRATED 并存；与 EXEMPT / INFRA / SOURCE_READERS / 未迁移基线任一并存即红 SELF_ISOLATED|CONFLICT（并存的文件整个跳过 SELF_ISOLATED 的其余检查，只报这一条）
    const siNames = Object.keys(reg.SELF_ISOLATED);
    const isSelfIso = (n) => has(reg.SELF_ISOLATED, n);
    const siConflict = new Set();
    for (const n of siNames) {
        if (!nonBlank(reg.SELF_ISOLATED[n])) P(n, 'SELF_ISOLATED', 'REASON', 'SELF_ISOLATED 条目缺少登记理由（必填，非空白）');
        if (!scan.has(n)) P(n, 'SELF_ISOLATED', 'STALE', 'SELF_ISOLATED 里的文件不在扫描集合（git 可见的顶层 .js）里：过期条目，须删除');
        const clash = [exe.includes(n) ? 'EXEMPT' : null, inf.includes(n) ? 'INFRA' : null, isReader(n) ? 'SOURCE_READERS' : null, bl.includes(n) ? '未迁移基线' : null].filter(Boolean);
        if (clash.length > 0) {
            siConflict.add(n);
            P(n, 'SELF_ISOLATED', 'CONFLICT', `SELF_ISOLATED 不能与 ${clash.join(' / ')} 并存（只能与 MIGRATED 并存；那几类要么不扫内容、要么互斥）`);
        }
    }
    // DB_PATH_ASSERTERS：预留名单，必须为空（首批真实登记文件出现时再与它们一起设计判据）
    for (const n of Object.keys(reg.DB_PATH_ASSERTERS)) P(n, 'DB_PATH_ASSERTERS', 'NOT_EMPTY', 'DB_PATH_ASSERTERS 必须为空：豁免的硬门设计等第一批真实登记文件出现时与它们一起设计、送审，这里不预先放行');

    const initEntries = {};
    const baselineCodes = {};
    for (const n of files) {
        if (overlapped.has(n)) continue;
        const cs = classesOf(n);
        const cls = cs[0] || null;
        if (cls === 'INFRA') { counts.infra += 1; continue; }
        let src;
        try { src = deps.read(n); } catch (e) { P(n, cls || 'OTHER', 'READ', `读取失败：${String((e && e.message) || e).slice(0, 160)}`); continue; }
        if (cls === 'EXEMPT') {
            counts.exempt += 1;
            if (scanTier1(n, src).length === 0) P(n, 'EXEMPT', 'STALE', 'EXEMPT 条目 Tier-1 零命中：豁免必须有必要，移出登记（零命中的文件落到「其他」类照样判绿）');
            continue;
        }
        const siActive = isSelfIso(n) && !siConflict.has(n);   // SELF_ISOLATED 的窄 T3 豁免只在没有冲突时生效
        if (cls === 'MIGRATED') {
            counts.migrated += 1;
            const noReady = has(reg.EXEMPT_NO_READY, n);
            const vsRaw = analyzeScript(n, src, { exemptNoReady: noReady });
            const vs = isReader(n) ? dropExemptR3(src, vsRaw, keepInSink) : (siActive ? dropExemptR3(src, vsRaw, keepUnlessSiExempt) : vsRaw);
            for (const v of vs) P(n, 'MIGRATED', v.rule, lineifyDetail(src, v.detail));
            if (!noReady && !vs.some((v) => v.rule === 'PARSE')) {
                let c = null;
                try { c = analyzeClosers(src); } catch (e) { c = null; }
                if (c === null || !(c.teardown || c.exit)) P(n, 'MIGRATED', 'CLOSE', '没有「被 await 的 teardown()」也没有「process.exit(…)」收尾（入口函数 / 入口链成功路径 / 它们直接调用的顶层函数里不可达）');
            }
            // finish(code) 只设 process.exitCode、不终止执行：必须在尾部位置（最后一条 / 紧跟 return / 所在块逐层处在尾部），防止把「中途提前退出」的 process.exit 机械替换成 finish
            for (const v of finishViolations(src).slice(0, 3)) P(n, 'MIGRATED', 'FINISH_NOT_LAST', `${v.line}:${v.evidence}`);
            // 叠加：分析器 R1–R3 看不到的补充写法（T1 .listen(3000)、T2 补充形态、T3 补充形态、T5）。T4 对已迁移文件不适用（它们本来就该用夹具）
            // （不传 selfIsolated：被豁免的裸字面量在 scanTier1 里本来就带 analyzer = true，会被下面的过滤掉；模板串等非 Literal 的入口名不豁免，留在 extra 里判红）
            const extra = scanTier1(n, src, { sourceReader: isReader(n) }).filter((h) => !h.analyzer && h.code !== 'T4' && h.code !== 'PARSE');
            for (const code of sortedUniq(extra.map((h) => h.code))) {
                P(n, 'MIGRATED', code, extra.filter((h) => h.code === code).slice(0, 3).map((h) => `${h.line || '?'}:${h.evidence}`).join(' ‖ '));
            }
            continue;
        }
        const hits = scanTier1(n, src, { sourceReader: isReader(n), selfIsolated: siActive });
        const codes = tier1Codes(hits);
        const showHit = (code) => hits.filter((h) => h.code === code).slice(0, 3).map((h) => `${h.line || '?'}:${h.evidence}`).join(' ‖ ');
        if (cls === 'BASELINE') {
            counts.baseline += 1;
            const frozen = Array.isArray(entries[n]) ? sortedUniq(entries[n]) : [];
            for (const c of frozen) baselineCodes[c] = (baselineCodes[c] || 0) + 1;
            for (const c of codes.filter((x) => !frozen.includes(x))) P(n, 'BASELINE', c, `基线未冻结的新违规（迁移期间新增）：${showHit(c)}`);
            for (const c of frozen.filter((x) => !codes.includes(x))) P(n, 'BASELINE', `GONE-${c}`, `冻结的规则 ${c} 已不再命中（违规已消失）：从基线删除这条规则或整条（--shrink-baseline）`);
            // 半迁移不得藏在基线里：已调用 test-env / 夹具的 ready()（分析器同一套绑定识别：没有 R4 = 有 ready 调用）的文件应登记进 MIGRATED，接受 R4–R7
            const vs0 = analyzeScript(n, src, { exemptNoReady: false });
            if (!vs0.some((v) => v.rule === 'R4' || v.rule === 'PARSE')) P(n, 'BASELINE', 'READY', '基线里的文件已调用 ready()：请登记进 MIGRATED（半迁移的文件留在基线里会躲开 R4–R7）');
            // 防「换入」：条目文件必须存在于 createdAtHead 的树里，且冻结集合 ⊆ 该版本的命中
            if (deps.blobAt) {
                let blob; let blobThrew = false;
                try { blob = deps.blobAt(n); } catch (e) { blobThrew = true; P(n, 'BASELINE', 'HEADBLOB', `读取 createdAtHead 树里的文件失败（判红）：${String((e && e.message) || e).slice(0, 160)}`); }
                if (blobThrew) { /* 已判红 */ } else if (blob === null) P(n, 'BASELINE', 'NOTATHEAD', '基线条目的文件在 createdAtHead 的树里不存在（疑似手工换入）');
                else if (typeof blob === 'string') {
                    const atHead = tier1Codes(scanTier1(n, blob));
                    const notSub = frozen.filter((c) => !atHead.includes(c));
                    if (notSub.length > 0) P(n, 'BASELINE', 'SWAPPED', `冻结的规则 ${notSub.join('+')} 不是 createdAtHead 版本命中的子集（该版本命中 ${atHead.join('+') || '无'}）：疑似手工换入`);
                } else P(n, 'BASELINE', 'HEADBLOB', `blob 读取器返回值非法（判红）：既不是字符串也不是 null（${blob === undefined ? 'undefined' : typeof blob}），不再静默跳过换入检查`);
            }
            continue;
        }
        // 其他（未登记）
        counts.other += 1;
        if (m === 'init') {
            const badCode = codes.filter((c) => !TIER1_CODES.includes(c));
            if (badCode.length > 0) P(n, 'OTHER', badCode[0], `无法写入基线：出现 ${badCode.join('+')}（只有 ${TIER1_CODES.join('/')} 可以进基线；先修这个文件）：${showHit(badCode[0])}`);
            else if (codes.length > 0) initEntries[n] = codes;
            continue;
        }
        for (const c of codes) P(n, 'OTHER', c, showHit(c));
    }
    // SOURCE_READERS 硬门：必须至少有一处 sink 外的起主服务字符串（否则 STALE）；不得 require child_process、不得有任何 sink 调用（否则 SPAWN）
    for (const n of rdr) {
        if (!scan.has(n) || exe.includes(n) || inf.includes(n)) continue;
        counts.sourceReaders += 1;
        let ast = null;
        try { ast = parseSource(deps.read(n)).ast; } catch (e) { ast = null; }
        if (ast === null) continue;
        const lits = serverJsLiterals(ast);
        if (!lits.some((l) => !l.inSink)) P(n, 'SOURCE_READERS', 'STALE', '登记了 SOURCE_READERS，但没有任何 sink 外的起主服务字符串：过期条目，须删除');
        const cap = spawnCapability(ast);
        if (cap.cpRequire || cap.sinkCalls > 0) P(n, 'SOURCE_READERS', 'SPAWN', `SOURCE_READERS 文件不得起进程：require child_process=${cap.cpRequire}，sink 调用 ${cap.sinkCalls} 处（经变量 spawn 的写法靠这条拦住）`);
    }
    // SELF_ISOLATED 硬门（只对没有冲突、在扫描集合里的条目）：sink 形态（SPAWN_FORM，带行号）· child_process 绑定形态（BINDING，带行号）· 过期（STALE：没有任何被豁免的 'server.js' 字面量，或没有 require child_process）。
    //   Tier-1 零命中（只登记 SELF_ISOLATED 的文件）/ MIGRATED 口径（MIGRATED + SELF_ISOLATED 的文件）已在上面的主循环里判定，T3 只豁免 'server.js' 裸字面量一种。
    for (const n of siNames) {
        if (!scan.has(n) || siConflict.has(n)) continue;
        counts.selfIsolated += 1;
        let src; let ast = null;
        try { src = deps.read(n); ast = parseSource(src).ast; } catch (e) { ast = null; }
        if (ast === null) continue;   // 读不到 / 解析失败：主循环已按 READ / PARSE 判红
        const facts = selfIsolatedFacts(ast, scan);
        for (const f of facts.spawnForms) P(n, 'SELF_ISOLATED', 'SPAWN_FORM', lineifyDetail(src, f.detail));
        for (const f of facts.bindingForms) P(n, 'SELF_ISOLATED', 'BINDING', lineifyDetail(src, f.detail));
        const why = [];
        if (facts.exemptLiterals === 0) why.push('没有任何被豁免的入口名裸字面量（sink 外、require 类实参外、值恰为入口名的普通字符串字面量）');
        if (!facts.cpRequire) why.push('没有 require child_process');
        if (why.length > 0) P(n, 'SELF_ISOLATED', 'STALE', `登记了 SELF_ISOLATED，但${why.join('；')}：过期条目，须删除`);
    }
    counts.dbPathAsserters = Object.keys(reg.DB_PATH_ASSERTERS).length;
    if (m === 'init') { counts.other -= Object.keys(initEntries).length; counts.baseline = Object.keys(initEntries).length; }
    counts.baselineCodes = baselineCodes;
    problems.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)));
    return { problems, counts, initEntries };
}

/**
 * 候选基线的唯一校验入口（修复批 3 简化 ②）：--init-baseline 生成的候选、--shrink-baseline 缩出的候选（含「无变化」）、无参检查读到的基线，**都**经过它。
 * 做的事 = 对候选跑 check 模式的完整 evaluate（登记约束、扫描前提、读文件、MIGRATED 检查、换入检查、READY 检查、maxEntries 格式与上限）；
 * 换入检查的 blob 读取器按**候选自己的** createdAtHead 构造：deps.makeBlobAt(head, names)（真实路径由 loadRealDeps 提供；自检可直接注入 deps.blobAt，或两者都不给 = 跳过换入检查）。
 * 返回 evaluate 的结果；problems 为空才算通过。
 */
function validateCandidateBaseline(deps, candidate) {
    const d = Object.assign({}, deps, { baseline: candidate });
    if (typeof deps.makeBlobAt === 'function' && isPlainObject(candidate) && isPlainObject(candidate.entries)) {
        d.blobAt = deps.makeBlobAt(candidate.createdAtHead, Object.keys(candidate.entries).filter((n) => deps.files.includes(n)));
    }
    return evaluate(d, 'check');
}

/** 评估结果 → 输出行与退出码（绿 = 一行 OK；红 = 逐条列「文件 | 类 | 规则 | 证据」） */
function formatReport(result) {
    const c = result.counts;
    if (result.problems.length === 0) {
        const codes = TIER1_CODES.filter((k) => c.baselineCodes[k]).map((k) => `${k}×${c.baselineCodes[k]}`).join(' ');
        return { code: 0, lines: [`OK ${NAME}: scanned=${c.scanned} migrated=${c.migrated} exempt=${c.exempt} infra=${c.infra} baseline=${c.baseline}(${codes}) other=${c.other} sourceReaders=${c.sourceReaders} selfIsolated=${c.selfIsolated} dbPathAsserters=${c.dbPathAsserters}`] };
    }
    const lines = [`RED ${NAME}: ${result.problems.length} 条违规（scanned=${c.scanned} migrated=${c.migrated} exempt=${c.exempt} infra=${c.infra} baseline=${c.baseline} other=${c.other}）`, '文件 | 类 | 规则 | 证据'];
    for (const p of result.problems) lines.push(`${p.file} | ${p.cls} | ${p.rule} | ${p.evidence}`);
    return { code: 1, lines };
}

// ---------------------------------------------------------------- 基线读写
/** 读基线；文件不存在 → { exists:false }；解析失败 → { exists:true, error } */
function loadBaselineFile(file) {
    if (!fs.existsSync(file)) return { exists: false, data: null };
    try { return { exists: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (e) { return { exists: true, data: null, error: `基线解析失败：${String((e && e.message) || e).slice(0, 160)}` }; }
}
function baselineText(obj) {
    const entries = {};
    for (const k of Object.keys(obj.entries).sort()) entries[k] = sortedUniq(obj.entries[k]);
    return `${JSON.stringify({ createdAt: obj.createdAt, createdAtHead: obj.createdAtHead, maxEntries: obj.maxEntries, entries }, null, 2)}\n`;
}

/**
 * --init-baseline：基线文件已存在 → 拒绝；登记表层面有问题（含 PARSE / 不在 T1–T5 的代号）→ 拒绝；否则把「未登记且 Tier-1 命中」的文件连同命中集合生成候选基线，
 * 候选必须通过 validateCandidateBaseline（完整检查：换入 / READY / MIGRATED / 扫描前提…）才写；不通过则基线文件保持不存在。
 * （「HEAD 树里已有基线文件时拒绝」需要 git，放在 runCli 的 init 分支：headTreeHasBaseline。）
 */
function initBaseline(deps, baselinePath, head, nowIso) {
    if (fs.existsSync(baselinePath)) return { ok: false, lines: [`REFUSED ${NAME} --init-baseline: 基线文件已存在（${path.basename(baselinePath)}）；基线只许缩小（--shrink-baseline），不许重建`] };
    if (!nonBlank(head)) return { ok: false, lines: [`REFUSED ${NAME} --init-baseline: 没有取到 git HEAD`] };
    const r = evaluate(Object.assign({}, deps, { baseline: null, blobAt: undefined }), 'init');
    if (r.problems.length > 0) return { ok: false, lines: [`REFUSED ${NAME} --init-baseline: 有 ${r.problems.length} 条问题，先修（登记表问题 / 无法写入基线的代号）`, ...formatReport(r).lines.slice(1)] };
    const entries = r.initEntries;
    const obj = { createdAt: nowIso || new Date().toISOString(), createdAtHead: head, maxEntries: Object.keys(entries).length, entries };
    const full = validateCandidateBaseline(deps, obj);
    if (full.problems.length > 0) return { ok: false, lines: [`REFUSED ${NAME} --init-baseline: 候选基线跑完整检查有 ${full.problems.length} 条问题，拒绝写入（基线文件保持不存在）`, ...formatReport(full).lines.slice(1)] };
    fs.writeFileSync(baselinePath, baselineText(obj));
    return { ok: true, lines: [`INIT ${NAME}: 基线已写入 ${path.basename(baselinePath)}：entries=${obj.maxEntries} maxEntries=${obj.maxEntries} createdAtHead=${head}`] };
}

/**
 * --shrink-baseline：只许删条目 / 删规则代号。
 * 拒绝（基线文件字节不变，退出码 1）：旧基线格式不合法（缺 maxEntries、非负整数、条数超 maxEntries、条目格式错）· 重算结果里出现基线里没有的文件或冻结集合之外的规则 · 候选基线跑完整检查不通过（登记约束、文件读取、MIGRATED 检查）。
 * 被删的条目：规则全部消失的、文件已不在扫描集合的、文件已登记进 MIGRATED / EXEMPT / INFRA 的。写回的 maxEntries = min(旧 maxEntries, 新条数)。
 */
function shrinkBaseline(deps, baselinePath) {
    const loaded = loadBaselineFile(baselinePath);
    if (!loaded.exists) return { ok: false, lines: [`REFUSED ${NAME} --shrink-baseline: 基线文件不存在`] };
    if (loaded.error || !loaded.data) return { ok: false, lines: [`REFUSED ${NAME} --shrink-baseline: ${loaded.error || '基线格式不对'}`] };
    const old = loaded.data;
    const shape = baselineShapeProblems(old);
    if (shape.length > 0) return { ok: false, lines: [`REFUSED ${NAME} --shrink-baseline: 旧基线格式不合法，拒绝写入（基线文件未改动）`, ...shape.map((s) => `${s.file} | ${s.rule} | ${s.evidence}`)] };
    const reg = deps.registry;
    const registered = new Set([...Object.keys(reg.MIGRATED), ...Object.keys(reg.EXEMPT), ...Object.keys(reg.INFRA), ...Object.keys(reg.SELF_ISOLATED)]);   // SELF_ISOLATED 也算「已登记」：缩表删掉它的基线条目，候选基线再跑完整检查（登记不合格 → 整体拒绝）
    const refusals = [];
    const next = {};
    for (const n of deps.files.slice().sort()) {
        if (registered.has(n)) continue;
        let src;
        try { src = deps.read(n); } catch (e) { refusals.push(`${n}: 读取失败 ${String((e && e.message) || e).slice(0, 100)}`); continue; }
        const codes = tier1Codes(scanTier1(n, src, { sourceReader: has(reg.SOURCE_READERS, n) }));
        const frozen = Array.isArray(old.entries[n]) ? old.entries[n] : null;
        if (frozen === null) { if (codes.length > 0) refusals.push(`${n}: 基线里没有这个文件，重算却命中 ${codes.join('+')}（基线只许缩小）`); continue; }
        const extra = codes.filter((c) => !frozen.includes(c));
        if (extra.length > 0) { refusals.push(`${n}: 出现基线未冻结的规则 ${extra.join('+')}（冻结 ${frozen.join('+')}）`); continue; }
        if (codes.length > 0) next[n] = codes;
    }
    if (refusals.length > 0) return { ok: false, lines: [`REFUSED ${NAME} --shrink-baseline: 重算结果里有基线没有的文件 / 规则，拒绝写入（基线文件未改动）`, ...refusals] };
    const candidate = { createdAt: old.createdAt, createdAtHead: old.createdAtHead, maxEntries: Math.min(old.maxEntries, Object.keys(next).length), entries: next };
    // 候选基线先过完整检查（与 init、无参检查同一个入口）：通过才允许「写入」或「返回无变化」——无变化也不能绕过（15-R [2]）
    const full = validateCandidateBaseline(deps, candidate);
    if (full.problems.length > 0) return { ok: false, lines: [`REFUSED ${NAME} --shrink-baseline: 候选基线跑完整检查有 ${full.problems.length} 条问题，拒绝${baselineText(candidate) === baselineText(old) ? '返回「无变化」' : '写入'}（基线文件未改动）`, ...formatReport(full).lines.slice(1)] };
    if (baselineText(candidate) === baselineText(old)) return { ok: true, changed: false, lines: [`SHRINK ${NAME}: 无变化（基线未改动）`] };
    const removedFiles = Object.keys(old.entries).filter((n) => !(n in next)).sort();
    const removedCodes = [];
    for (const n of Object.keys(next)) for (const c of old.entries[n]) if (!next[n].includes(c)) removedCodes.push(`${n}:${c}`);
    fs.writeFileSync(baselinePath, baselineText(candidate));
    return { ok: true, changed: true, lines: [`SHRINK ${NAME}: entries ${Object.keys(old.entries).length} -> ${Object.keys(next).length}，maxEntries ${old.maxEntries} -> ${candidate.maxEntries}；删条目 ${removedFiles.length} 个${removedFiles.length ? `（${removedFiles.join(' ')}）` : ''}；删规则 ${removedCodes.length} 条${removedCodes.length ? `（${removedCodes.join(' ')}）` : ''}`] };
}

// ---------------------------------------------------------------- 命令行
/** 一次 git cat-file --batch 取 createdAtHead 树里这些文件的内容；返回 name => string | null（不存在 / 不是 blob）；git 失败抛错 */
function makeBlobReader(o, head, names) {
    if (!/^[0-9a-f]{40}$/.test(String(head))) return () => { throw new Error(`createdAtHead 不是合法的 40 位提交号：${JSON.stringify(head)}`); };
    if (names.length === 0) return () => null;
    const execBuf = o.execBuf || defaultExecBuf;
    const input = `${names.map((n) => `${head}:${SCRIPTS_REL}/${n}`).join('\n')}\n`;
    let buf;
    try { buf = execBuf(o.gitBin || 'git', ['-C', o.repoRoot || REPO_ROOT, 'cat-file', '--batch'], input); } catch (e) { const msg = String((e && e.message) || e).split('\n')[0].slice(0, 160); return () => { throw new Error(`git cat-file --batch 失败：${msg}`); }; }
    buf = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
    const map = new Map();
    let pos = 0;
    try {
        for (const n of names) {
            const nl = buf.indexOf(10, pos);
            if (nl < 0) throw new Error('输出被截断');
            const header = buf.toString('utf8', pos, nl);
            pos = nl + 1;
            if (/ missing$/.test(header)) { map.set(n, null); continue; }
            const hm = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
            if (!hm) throw new Error(`无法解析：${header.slice(0, 80)}`);
            const size = Number(hm[2]);
            map.set(n, hm[1] === 'blob' ? buf.toString('utf8', pos, pos + size) : null);
            pos += size + 1;
        }
    } catch (e) { const msg = String((e && e.message) || e); return () => { throw new Error(`git cat-file --batch 输出解析失败：${msg}`); }; }
    return (n) => (map.has(n) ? map.get(n) : null);
}

/** 组装真实依赖；任何一步失败 → { error }（调用方判红）。换入检查的 blob 读取器按候选基线的 createdAtHead 现建（deps.makeBlobAt），所以这里不需要基线数据 */
function loadRealDeps(opts) {
    const o = opts || {};
    const scan = listScanSet(o);
    if (!scan.ok) return { error: scan.error };
    let registry;
    try { registry = o.registry || require('./lib/test-isolation-registry'); } catch (e) { return { error: `登记表加载失败：${String((e && e.message) || e).slice(0, 160)}` }; }
    let familyNames;
    try {
        if (o.familyNames) familyNames = new Set(o.familyNames);
        else {
            const rv = require('./run-verify-family');
            familyNames = new Set(rv.buildFamilyMembers().members.map((x) => path.basename(x.rel)));
            for (const g of rv.GUARDS) familyNames.add(`${g}.js`);
        }
    } catch (e) { return { error: `FAMILY 成员读取失败（判红）：${String((e && e.message) || e).slice(0, 160)}` }; }
    const dir = o.scriptsDir || __dirname;
    // makeBlobAt：换入检查的 blob 读取器工厂，由 validateCandidateBaseline 按候选基线自己的 createdAtHead 调用（check / init / shrink 同一条路径）
    const deps = { files: scan.names, read: (n) => fs.readFileSync(path.join(dir, n), 'utf8'), registry, familyNames, scanProblems: checkScanPreconditions(Object.assign({}, o, { scriptsDir: dir }), scan.names), makeBlobAt: (head, names) => makeBlobReader(o, head, names) };
    return { deps };
}

/**
 * HEAD 树里是否已经有基线文件：git -C <根> ls-tree -z --name-only HEAD -- <基线相对仓库根的路径>。
 *   命令成功且输出为空 → { exists:false }；命令成功且输出恰为 `<相对路径>\0` → { exists:true }；
 *   命令成功但输出是别的内容 / 非零退出码（含 128）/ 没有退出码 / 抛错 → 一律 { error }（判红，拒绝 init）——不再按任何退出码推断「路径缺失」。
 * 基线在仓库根之外的（自检用的临时路径）不可能在 HEAD 树里，早返回 { exists:false }。
 * 用途：--init-baseline 的硬门——删掉已提交的基线文件再 init 会整体吸收新违规（预筛 L10）。
 */
function headTreeHasBaseline(o, baselinePath) {
    const root = o.repoRoot || REPO_ROOT;
    const rel = path.relative(root, baselinePath).split(path.sep).join('/');
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { exists: false };
    let out;
    try { out = (o.exec || defaultExec)(o.gitBin || 'git', ['-C', root, 'ls-tree', '-z', '--name-only', 'HEAD', '--', rel]); } catch (e) {
        return { error: `git ls-tree HEAD -- ${rel} 失败（判红，不按退出码推断路径缺失）：${String((e && e.message) || e).split('\n')[0].slice(0, 160)}` };
    }
    if (out === '') return { exists: false };
    if (out === `${rel}\0`) return { exists: true };
    return { error: `git ls-tree HEAD -- ${rel} 输出不认识（判红）：${JSON.stringify(String(out).slice(0, 120))}` };
}

function runCli(argv, opts) {
    const args = argv || process.argv.slice(2);
    const o = opts || {};
    const print = o.print || ((l) => console.log(l));
    const baselinePath = o.baselinePath || BASELINE_PATH;
    const known = ['--init-baseline', '--shrink-baseline'];
    const bad = args.filter((a) => !known.includes(a));
    if (bad.length > 0 || args.length > 1) { print(`RED ${NAME}: 不认识的参数 ${bad.join(' ') || args.join(' ')}（只接受 ${known.join(' | ')} 之一）`); return 1; }
    const loaded = loadBaselineFile(baselinePath);
    if (args[0] === '--init-baseline') {
        const real = loadRealDeps(o);
        if (real.error) { print(`RED ${NAME}: ${real.error}`); return 1; }
        let head = '';
        try { head = (o.exec || defaultExec)(o.gitBin || 'git', ['-C', o.repoRoot || REPO_ROOT, 'log', '-1', '--format=%H']).trim(); } catch (e) { head = ''; }
        // 硬门：HEAD 树里已经有基线文件时 init 拒绝（删文件重 init 会把新违规整体吸收进新基线）；git 失败也拒绝
        if (!loaded.exists && nonBlank(head)) {
            const inHead = headTreeHasBaseline(o, baselinePath);
            if (inHead.error) { print(`REFUSED ${NAME} --init-baseline: ${inHead.error}`); return 1; }
            if (inHead.exists) { print(`REFUSED ${NAME} --init-baseline: HEAD 树里已经有基线文件（${path.basename(baselinePath)}）；删掉工作树里的文件再 init 会把新违规整体吸收进新基线。基线只许缩小（--shrink-baseline），不许重建`); return 1; }
        }
        const r = initBaseline(real.deps, baselinePath, head);
        r.lines.forEach(print);
        return r.ok ? 0 : 1;
    }
    if (args[0] === '--shrink-baseline') {
        const real = loadRealDeps(o);
        if (real.error) { print(`RED ${NAME}: ${real.error}`); return 1; }
        const r = shrinkBaseline(real.deps, baselinePath);
        r.lines.forEach(print);
        return r.ok ? 0 : 1;
    }
    if (loaded.error) { print(`RED ${NAME}: ${loaded.error}`); return 1; }
    const real = loadRealDeps(o);
    if (real.error) { print(`RED ${NAME}: ${real.error}`); return 1; }
    const rep = formatReport(validateCandidateBaseline(real.deps, loaded.data));
    rep.lines.forEach(print);
    return rep.code;
}

module.exports = { evaluate, validateCandidateBaseline, headTreeHasBaseline, formatReport, initBaseline, shrinkBaseline, listScanSet, checkScanPreconditions, loadBaselineFile, baselineShapeProblems, makeBlobReader, runCli, baselineText, INFRA_ALLOWED, EXEMPT_FORBIDDEN_PREFIX_RE, BASELINE_PATH };

if (require.main === module) {
    let code = 1;
    try { code = runCli(); } catch (e) { console.log(`RED ${NAME}: 守卫自身异常：${(e && e.stack) || e}`); code = 1; }
    process.exit(code);
}
