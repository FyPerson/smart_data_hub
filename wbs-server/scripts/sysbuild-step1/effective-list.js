'use strict';
// #212 第一步（R1，codex 81 号 HIGH-1 / HIGH-2；84 号 HIGH-3 / MEDIUM；85 号 HIGH-2；89 / 94 号）：「生效清单」机读输入的读取、schema 校验与去向表核对。
//   本模块的校验函数都是纯函数，不跑用例、不读仓库其他文件；build-mutation-baseline.js（--rerun / 闸门第 ③ 步）与 mutation-check.js（第 ① 步）共用，
//   两处用同一份校验，不各抄一份。例外是读 git / 起子进程 / 读文件的函数：validateSinceCommit（<S> 的共用校验）、statusEntriesZ 与 changedPathsSince（<S>..HEAD + 工作区 + 未跟踪的改动路径集合）、
//   registryAtCommit（<S> 提交时点的变异登记，见下）、resolveSRegistry（读 <S> 时登记并决定采信新旧读取器的哪份，96 号 HIGH-3）、foreignToolProblem（运行的脚本须在 --repo 内）、readEffectiveFile（读文件）。自检在 build-mutation-baseline.js 的 --self-test 与 mutation-check.js 的 --self-test 里（本文件没有自己的入口）。
//
// 威胁模型（用户 P-THREAT = A，89 / 94 号后裁定）：诚实的单用户，防遗漏与疏忽，不防有意构造输入的规避。
//   需要有意构造输入才能绕过的意见（89 H1 / H3、94 H1 一类）按 MEDIUM 处理，本轮只用两道低成本硬门收口，不再追加更复杂的防规避设计：
//   ① 排除项门：--raw-dir 在仓库里只许落在 tmp/ 下（或仓库之外）；复验之后才允许生成 / 补写的产物（复验目录、去向表登记 json、--report）由第 ② 步记录，第 ③ 步只认这份记录，
//      当次新增的、或与源码 / 驱动 / 登记 / 基线 / 清单重叠的排除项一律拒绝（build-mutation-baseline.js exclusionsOf / exclusionProblems；重叠判据 = 本文件 protectedPathHit）。
//   ② 自检钩子门：--registry-file / --s-registry-file / --allow-no-provenance / --no-provenance 不是命令行参数，只有自检内部调用 main(argv, hooks) 时才能注入；
//      命令行给它们、或把 --self-test 与任何正式参数同给，都是用法错误（退出码 2）。
//   路径名单的大小写口径：匹配 NONE_MODE_ALLOW / PRODUCT_TEST_PATHS / READER_CHAIN 名单时路径一律转小写再比（Windows 文件系统不区分大小写，别名路径同样落在名单内）；
//   文件定位、读取与哈希用路径原值（git 给出的拼写）。
//
// 为什么要有它：每个提交的「生效清单」（P 5.2：按实际依赖认定的受影响变异）原来只是人写的文字，工具的复验范围（文件交集 / 组测试侧 / 产品侧组级触发 / 兜底）不认它。
//   HIGH-1：共用助手已返回（不在失败栈）、其文件又已是别的变异目标（不触发零目标兜底）时，清单认定受影响的变异可以从 ① 到 ③ 都通过而从未复验。
//   HIGH-2：「由等价变异承接」只要去向行存在就过 ①；承接它的编号若不在自动复验范围，可能从未执行。
//   所以生效清单变成机读输入：复验集合 = 工具自动范围 ∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号；第 ③ 步逐条核对。
//
// 「本提交的增删」按 <S> 时点的登记核对（84 号 MEDIUM-2 / 85 号 HIGH-2）：
//   <S> = --changed-since 给的上一提交。<S> 时登记 = 在 <S> 提交的内容上跑登记读取函数得到的全部 group / id（registryAtCommit：git ls-tree + cat-file 把 <S> 的文件树
//   原样落进私有临时目录，起子进程跑 mutation-check.js --ids-only 读十组登记；不用 git checkout / stash / worktree；静态抽取不可靠——api 2140 条与 browser 104 条是代码生成的，
//   所以只能真跑读取函数）。retire 必须 = <S> 时登记有、当前登记没有；added ∪ remount newId 必须 = 当前登记有、<S> 时登记没有。
//   固定 C1 基线（mutation-baseline.json）只用于失败位置对比、需人工复核分类与受影响范围，不再参与增删全等——所以 C2 删过 / 加过的编号不会让 C3 的清单被迫重新声明。
//   mustRun 只收「<S> 时已登记、当前仍登记」的变异（可以是 C2 新增、不在固定基线里的编号；它们没有基线失败位置，闸门里按「现在有基线没有」要登记，见 build-mutation-baseline.js）。
//
// 生效清单 JSON（format 固定为 sysbuild-effective-list/1；多一个字段、少一个字段都拒绝；任何层级的重复对象键都拒绝——JSON.parse 会悄悄保留最后一个值，见 readEffectiveFile）：
//   {
//     "format": "sysbuild-effective-list/1",
//     "commit": "C2",                                                       所属提交名（非空）
//     "mustRun": [ { "group": "api", "id": "<编号>" } ],                      清单认定受影响、必须复验的变异；必须是 <S> 时已登记且当前仍登记的编号
//     "retire": [                                                           本提交删除的变异；必须是 <S> 时已登记、当前已不在登记里的编号
//       { "group": "api", "id": "<旧编号>", "category": "stop-only" },                                       只测停用行为：不需要承接，删除依据由审查确认
//       { "group": "api", "id": "<旧编号>", "category": "remount", "newId": { "group": "api", "id": "<新编号>" } },   改挂：新编号必须已登记、<S> 时没有、不等于任何被删编号、不与另一条改挂的 newId 重复（94 号 MEDIUM：逐条改挂；多条旧变异由同一个新变异承接请改用 equivalent）
//       { "group": "api", "id": "<旧编号>", "category": "equivalent", "by": [ { "group": "api", "id": "<承接编号>" } ] }   等价变异承接：by 非空、不含被删编号自身、不含被删编号、必须已登记
//     ],                                                                     承接编号可以是 <S> 时已有的；也可以是新增的——新增的承接编号写进下面的 added；若它同时是某条 remount 的 newId，只在那条改挂项里声明、不要再写进 added（added 与 newId 重复会被拒），by 照常引用它
//     "added": [ { "group": "api", "id": "<新增变异编号>", "note": "<可选说明>" } ]      可省略（= 空）。声明本提交新增、<S> 时没有的变异：必须在当前登记里、<S> 时没有、不与 newId 重复；by 可以引用这里的编号
//   }
//   可选顶层字段 "reason"（非空字符串）：mustRun、retire、added 全空时必须带它说明为什么没有生效变异（例如只改 .gitignore 的提交：改动在 none 白名单之外，但没有任何变异受影响）；
//   带 reason 的空清单只许用于改动集不含产品 / 测试路径的提交（PRODUCT_TEST_PATHS：routes / public / utils / server.js / wbs-server 根级文件与依赖清单 / verify-*.js / scripts/lib / sysbuild-predeploy / scripts/lines / deploy-ssh.ps1 / _test-fixture.js / fixtures；
//   emptyListScopeProblems，第 ①②③ 步共用）——涉及这些路径的提交必须有至少一条经人确认的清单条目。94 号 HIGH-4：旧名单漏了 wbs-server/schema.js 一类根级产品文件与影响测试运行的依赖清单、共用夹具；
//   schema.js 在本仓库的实际位置是 wbs-server/routes/sysbuild/schema.js（已被 routes/ 前缀覆盖，自检点名断言），wbs-server/schema.js 这个根级路径与 wbs-server 根级 *.js / *.cjs / *.mjs / *.json 也一并入名单；
//   名单与「测试运行实际加载的文件」的覆盖关系有真实数据自检（build-mutation-baseline.js --self-test：SHARED_TEST_SIDE / GROUP_TEST_SIDE / PRODUCT_GROUP_TRIGGER / EXTRA_TEST_FILES / 真实仓库 listTestFiles 的每个路径都必须落在本名单或闸门工具目录里）；
//   带 reason 的空清单照常过第 ①②③ 步——自动范围与全部硬门（合格结果、<S> 时登记增删全等、改动路径核对等）一样跑；reason 写进 meta、empty-plan 记录与输出。没有 reason 的全空清单拒绝。
//   只改工具 / 文档的提交仍可以用 --effective-none "<理由>"；同一编号在 mustRun / retire 里各只许出现一次，且不能同时在两处。
//   集合级硬门（R1 修复批，预筛 HIGH-1；84 号 MEDIUM-2 改按 <S> 时登记）：<S> 时登记 − 当前登记 必须与 retire 全等；当前登记 − <S> 时登记 必须与 added ∪ 全部 remount 的 newId 全等，多一条少一条都拒；
//   --effective-none 时两者都必须为空。复验集合另自动并入「当前登记有、<S> 时没有」的全部编号（来源记 added）。
//
// --effective-none 的适用范围（84 号 HIGH-3）：改动集（<S>..HEAD + 未提交 + 未跟踪，与 changedFilesSince 同口径）只许落在下面的白名单内，第 ②③ 步与 --affected 共用 noneModeProblems：
//   NONE_MODE_ALLOW = wbs-server/scripts/sysbuild-step1/**（闸门工具目录自身）、docs/**、仓库根目录的 *.md（其余位置的 .md 走清单）。
//   闸门工具目录自身在 none 白名单内：改工具的提交可以用 --effective-none，由 codex 审工具兜底（工具改动不经自己复验）。
//   产品代码（wbs-server/routes/**、wbs-server/public/**、wbs-server/server.js、wbs-server/routes/sysbuild/schema.js 等）、测试驱动与套件（wbs-server/scripts/verify-*.js、wbs-server/scripts/lib/**、scripts/sysbuild-predeploy/**）、
//   固定基线与来源清单（wbs-server/scripts/fixtures/**，改它们必须走清单）都不在白名单里，一律不许用 --effective-none；涉及产品或测试行为的改动必须给生效清单，由人确认受影响的变异（P-TEST 对依赖关系的人工判断）。
//   registryAtCommit 用「当前版本」的 mutation-check.js 与当前 node_modules 去读 <S> 时登记的文件：<S> 之后改过读取逻辑（loadRegistry / normalizeGroup）或依赖时，读出的 <S> 时登记口径随当前工具走，不是 <S> 当时的工具口径——这正是读取器漂移硬门要拦的情形，人工声明时由 resolveSRegistry 再用 <S> 树自带的旧版读取器读一遍核对（见下）。
//
// 读取器漂移硬门（94 号 HIGH-3；预筛 HIGH-1 收窄）：改动集（同口径：<S>..HEAD + 未提交 + 未跟踪）里只要含「读取器链路」的文件（READER_CHAIN：mutation-check.js、effective-list.js、
//   各层 package.json / package-lock.json——只有读 <S> 时从**当前检出**加载的文件：读取器本体与经 NODE_PATH 进来的依赖），registryAtCommit 的结果就不可自动信任（读取规则 / 依赖变了，历史与当前登记同时套新规则，旧编号的真实增删会从差集里消失）。
//   只有改了工具读取器或依赖清单的提交需要 --s-registry-attest；十组登记所在的套件 / 驱动 / sysbuild-mut-record.js 等都从 <S> 的临时树加载（是 <S> 当时的版本），改它们（连同产品文件）不触发漂移门：
//   第 ①②③ 步一律拒绝自动判定，提示「登记读取逻辑在本次改动内，须人工核对 <S> 时登记」。显式通路 = --s-registry-attest "<理由>"（96 号 HIGH-3 改版；理由在参数解析时统一 trim、空白 = 用法错误，之后全用这一个值）：
//   带了理由时，resolveSRegistry 自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only，在 registryAtCommit 落盘的同一份临时树里以子进程运行）读一遍 <S> 时登记：
//     新旧两份读出的编号集合全等 → 记录理由继续；不同、或新版读取器读不了 → 增删核对以旧版读取器读出的编号集合为准，新版结果只打印对照；
//     <S> 树没有可用的 --ids-only 入口（旧版读取器读不了），或新旧读取器都读不了 → 一律拒绝（提示「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」）。
//   依赖漂移的限度：只改依赖清单时，<S> 树的读取器与当前读取器共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住。
//   所用编号摘要（keysDigestOf：去重排序后的 group\0id 全集的 sha256，连同条数与来源）写进第 ① 步输出、第 ② 步 meta / rerun.json / empty-plan.json，第 ③ 步现算后核同一份；理由同样写进这些记录，第 ③ 步要求与第 ② 步一致；其余硬门照常跑。
//   没有声明时漂移门照旧拒绝（sRegistryDriftProblems）。
//   名单与「读 <S> 时真实从临时树之外加载了哪些仓库内文件」有真实数据自检（mutation-check.js --self-test：registryAtCommit 的子进程报告 require.cache，位于临时树之外、在仓库内的非 node_modules 模块必须全在名单里）；
//   另有反例自检：只改 api 套件 + verify 驱动 + 产品文件的改动列表 → 漂移门不触发。
//
// <S> 的共用校验（94 号 HIGH-2，validateSinceCommit）：<S> 必须是完整 40 位小写十六进制、git cat-file -t 为 commit（树 / blob / 标签对象一律拒）、且是 HEAD 的祖先（merge-base --is-ancestor）；
//   文件模式、无清单模式、registryAtCommit、changedPathsSince 都先过它，三步同口径。正式闸门（opts.gate）另要求 <S> = HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（提交之后补跑）（96 号 HIGH-1）：
//   更早的祖先会让前一提交新增、本次删除的编号两端都不存在，清单漏掉本次退役；累计查询（--affected … --cumulative、不带清单的 --affected）不传 gate，保留任意祖先。
//   98 号 HIGH（线性历史）：正式闸门另拒绝三种形态——① 仓库里有进行中的合并（git rev-parse -q --verify MERGE_HEAD 成功）；② HEAD 有多个父提交（<S> = HEAD 的第一父提交的补跑模式，以及 <S> = HEAD 而 HEAD 本身是合并提交）；
//   ③ <S> 本身有多个父提交（git rev-list --parents -n 1 <S>：补跑 <S> = HEAD^ 恰是合并提交 M、HEAD 是 M 之后的单父提交 X 时，①② 都不成立，③ 拦住）。更早的合并提交（<S> 之前历史里的）闸门看不到，只能由 C9 的链核对（--ancestry-path 序列里含合并提交即拒）拦。
//   C1–C9 保持线性历史：线分支同步 main 用 rebase，且只在 C9 之后做；含合并提交的链到 C9 才会被拒绝、届时补不回有效留档，所以三步入口（都走本函数）当场拦。
//   <S> = HEAD 的第一父提交（提交之后补跑）时另要求工作区干净（postCommitDirtyProblem，三步共用一处）：扣掉复验目录 / --dispositions / --report 这些声明的补写产物之后，不许再有未提交 / 未跟踪的路径（--effective / 基线不是直接豁免：见下一句），
//   有就是用法错误（「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」）。98 号补充（MEDIUM）：基线与生效清单（ignore.inputs）若被 HEAD 跟踪，只有工作区与暂存区内容都与 HEAD 一致时才豁免
//   （补跑读到的必须是 HEAD 里的那份，不是补跑前已暂存的修改）；没有被 HEAD 跟踪的（独立准备的）输入照旧豁免；--dispositions / --report 是声明的补写产物，照旧整体豁免。
// registryAtCommit 的落盘（94 / 96 号 MEDIUM）：路径无损映射（git ls-tree -z 的路径必须是合法 UTF-8、不含反斜杠 / 冒号 / 控制字符 / 空段 / .. / 尾部点或空格 / Windows 保留设备名）、
//   落地目标必须留在私有临时树内（按完整路径段判断越界：根级 ..notes 合法）、文件别名（整条路径小写值相同）、目录别名（逐段记录原始目录名，两个目录只差大小写即拒，文件名互不重复也一样）与文件 / 目录冲突一律拒绝；
//   跳过 docs/、符号链接、子模块（它们不进临时树），其中任何一个「等于登记读取输入」或「覆盖其祖先目录」（coversReadChain：TREE_INPUTS 十组登记文件与被它们加载的助手、含 patternDirs；或 READER_CHAIN）直接报错，
//   链路之外的被跳过项数量与清单写进返回值 skipped；清理时某个文件删除失败（Windows 文件占用）不终止遍历，其余照删，最后汇总残留路径（返回值 residue 与标准错误提示）。
// changedPathsSince 返回 Git 给出的路径原值（96 号 MEDIUM；losslessPaths：原值去重，不把反斜杠改成正斜杠，含反斜杠 / 以 ./ 开头的路径无法无损处理 → 明确报错）；名单匹配（matchKey）各自归一，不改写 Git 路径。
//
// 去向表（--dispositions / --disposition）里 retire 的每个旧编号恰好一行，除原有的「去向」外必带（字段值一律按字符串直接校验为非空，不做 String() 转换，null / 对象 / 数字都当缺失）：
//   处置类别       = 生效清单里该编号的 category（stop-only / remount / equivalent）
//   stop-only      删除依据（非空字符串）
//   remount        现行编号（= 生效清单里的 newId：字符串编号，或 { group, id }，或它们的数组）
//   equivalent     现行编号（= by 的全集）、等价业务错误（非空字符串）、承接命中证据（非空字符串；第 ③ 步要能对上每个承接编号当次运行里一个可作证据的失败）
//   字段校验的时点（89 号 MEDIUM-2 / 94 号）：第 ① 步（还没有当次复验日志）只核编号、处置类别、承接关系（现行编号全等）与已有依据（删除依据 / 等价业务错误）；
//   「承接命中证据」第 ① 步不核（retireDispositionProblems 的 requireEvidence = false），第 ②③ 步之间人看完复验日志才补写，第 ③ 步强制非空并与当次日志里承接编号的失败核对。
// 去向表口径（94 号 MEDIUM；协调方更正；96 号 MEDIUM）：累计去向表登记 json 是一份跨提交累计的文件（C2、C3… 逐提交追加），不是每提交一份；每一行（含普通三字段行）必带非空字段「提交」（如 "C2"），值与该提交生效清单的 commit 对应；
//   正式闸门（第 ①③ 步，含 --effective-none 分支）用 dispositionTableProblems 核整表，独立查询（--query-baseline）保留旧表兼容。两种核对范围不同：
//   ① 退役类核对（retireDispositionProblems，第 ①③ 步）：只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等（每个 retire 恰好一行、本次提交里带「处置类别」的行都在 retire 里）；其他提交的退役行忽略，不报「多余类别」；
//      带「处置类别」却没有「提交」的行报错。
//   ② 「变了 / 需人工复核」的三字段登记（reviewGate，第 ③ 步）：可以引用任何提交的行；同一编号可有多行（旧提交的、本次的），命中证据必须与当次运行的失败对得上——前序提交登记过、本次失败没再变化的条目沿用旧行即过；
//      失败再次变化的必须补新行，旧行证据对不上就拒。95 号 MEDIUM（编号复用）：本提交新增 / 改挂的编号只接受「提交」= 本次的三字段行；其余沿用历史行，以该编号最后一条退役行（带「处置类别」，按表内顺序）为界，其前的行属于旧一代、不算
//      （build-mutation-baseline.js reviewGate）。
// 本工具的流程约束：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick（提交号变了，C9 的留档链接不上）；每个提交（含工具、文档提交）都留第 ② 步复验目录（空计划也留），每份留档只覆盖一个提交。
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FORMAT = 'sysbuild-effective-list/1';
const CATEGORIES = Object.freeze(['stop-only', 'remount', 'equivalent']);
const TOP_KEYS = Object.freeze(['format', 'commit', 'mustRun', 'retire', 'added', 'reason']);
const REQUIRED_TOP_KEYS = Object.freeze(['format', 'commit', 'mustRun', 'retire']); // added 可省略（= 空）
const S_LABEL = '<S> 时登记';
// --effective-none 白名单（84 号 HIGH-3）：路径前缀 / 正则；不在里面的改动一律不许用 --effective-none
const NONE_MODE_ALLOW = Object.freeze({ prefixes: Object.freeze(['wbs-server/scripts/sysbuild-step1/', 'docs/']), patterns: Object.freeze([/^[^/]+\.md$/i]) }); // 仓库根目录的 *.md；其余位置的 .md 走清单
// 「产品 / 测试路径」反向名单（none 白名单的反面，写成一个常量）：改动集里只要有这些路径，提交就必须有至少一条经人确认的清单条目（mustRun / retire / added 非空），
//   不许用 --effective-none，也不许用只靠 reason 的全空清单（emptyListScopeProblems）。
const PRODUCT_TEST_PATHS = Object.freeze({
  prefixes: Object.freeze(['wbs-server/routes/', 'wbs-server/public/', 'wbs-server/utils/', 'wbs-server/scripts/lib/', 'scripts/sysbuild-predeploy/', 'wbs-server/scripts/fixtures/', 'scripts/lines/']),
  files: Object.freeze(['wbs-server/server.js', 'wbs-server/schema.js', 'wbs-server/package.json', 'wbs-server/package-lock.json', 'package.json', 'package-lock.json', 'scripts/deploy-ssh.ps1', 'wbs-server/scripts/_test-fixture.js']),
  patterns: Object.freeze([/^wbs-server\/scripts\/verify-[^/]*\.js$/, /^wbs-server\/[^/]+\.(?:js|cjs|mjs|json)$/]),
});
// 登记读取器链路（94 号 HIGH-3；预筛 HIGH-1 收窄）：只含读 <S> 时登记时「从当前检出加载」的文件——读取器本体（mutation-check.js、effective-list.js）与各层依赖清单（依赖经 NODE_PATH 从当前检出进来）。
//   改动集含其中任何一个，registryAtCommit 的结果不可自动信任（见头注释「读取器漂移硬门」）。套件、驱动、sysbuild-mut-record.js 等登记文件及其依赖都从 <S> 的临时树加载，是 <S> 当时的版本，改它们不需要 attest。
//   名单与「读 <S> 时真实从临时树之外加载了哪些仓库内文件」有真实数据自检（mutation-check.js --self-test：子进程报告 require.cache 里位于临时树之外、但在仓库内的非 node_modules 模块，必须全在本名单里）。
const READER_CHAIN = Object.freeze({
  files: Object.freeze([
    'wbs-server/scripts/sysbuild-step1/mutation-check.js', 'wbs-server/scripts/sysbuild-step1/effective-list.js',
    'wbs-server/package.json', 'wbs-server/package-lock.json', 'package.json', 'package-lock.json',
  ]),
  patterns: Object.freeze([]),
});
// 临时树里「读登记的输入」（registryAtCommit 落盘时 docs/、符号链接、子模块不进临时树；其中任何一个落在这份名单里直接报错，不会读空）：逐组 loadRegistry 所在文件、api / browser 套件拆分件、被它们 require 的助手。
//   与 READER_CHAIN 不同：这些文件是从 <S> 的临时树读的，只用于「跳过项不能是登记输入」的检查，不触发漂移门。
const TREE_INPUTS = Object.freeze({
  files: Object.freeze([
    'wbs-server/scripts/lib/sysbuild-mut-record.js', 'wbs-server/scripts/lib/listen-safe-port.js', 'wbs-server/scripts/lib/sysbuild-frontend-static.js',
    'wbs-server/scripts/lib/sysbuild-api-suite.js', 'wbs-server/scripts/lib/sysbuild-browser-suite.js',
    'wbs-server/scripts/verify-sysbuild-static.js', 'wbs-server/scripts/verify-sysbuild-schema.js', 'wbs-server/scripts/verify-sysbuild-db.js', 'wbs-server/scripts/verify-sysbuild-attachments.js',
    'scripts/sysbuild-predeploy/schema-migration-mutations.cjs', 'scripts/sysbuild-predeploy/verify-deploy-migration.cjs', 'scripts/sysbuild-predeploy/run-archive-self-test.cjs', 'scripts/sysbuild-predeploy/run-readonly-self-test.cjs',
  ]),
  patterns: Object.freeze([/^wbs-server\/scripts\/lib\/sysbuild-api-suite-[a-z0-9-]+\.js$/, /^wbs-server\/scripts\/lib\/sysbuild-browser-[a-z0-9-]+\.js$/]),
  patternDirs: Object.freeze(['wbs-server/scripts/lib/']), // patterns 里的文件所在目录（自检核对：每个 pattern 的样例路径都在其中一个目录下）；「跳过项覆盖登记输入的祖先目录」用它判断 pattern 一侧
});
const TOOL_DIR = 'wbs-server/scripts/sysbuild-step1/'; // 闸门工具目录自身（NONE_MODE_ALLOW 的第一个前缀；排除项也不许与它重叠）
const key = (g, id) => g + '\u0000' + id;
const keyOf = (x) => key(x.group, x.id);
const show = (x) => `[${x.group}] ${JSON.stringify(x.id)}`;
const showKey = (k) => { const i = k.indexOf('\u0000'); return show({ group: k.slice(0, i), id: k.slice(i + 1) }); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonEmpty = (s) => typeof s === 'string' && s.trim() !== '';
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
// 名单匹配用的路径键：正斜杠 + 小写（Windows 不区分大小写）。名单常量本身都是小写。
const matchKey = (p) => normPath(p).toLowerCase();
const isProductTestPath = (p) => { const k = matchKey(p); return PRODUCT_TEST_PATHS.prefixes.some((x) => k.startsWith(x)) || PRODUCT_TEST_PATHS.files.includes(k) || PRODUCT_TEST_PATHS.patterns.some((re) => re.test(k)); };
const isNoneAllowedPath = (p) => { const k = matchKey(p); return NONE_MODE_ALLOW.prefixes.some((x) => k.startsWith(x)) || NONE_MODE_ALLOW.patterns.some((re) => re.test(k)); };
const isReaderChainPath = (p) => { const k = matchKey(p); return READER_CHAIN.files.includes(k) || READER_CHAIN.patterns.some((re) => re.test(k)); };
const isTreeInputPath = (p) => { const k = matchKey(p); return TREE_INPUTS.files.includes(k) || TREE_INPUTS.patterns.some((re) => re.test(k)); };
// 96 号 MEDIUM：被跳过的项（符号链接 / 子模块 / docs）「等于登记输入」或「覆盖其祖先目录」——条目本身是读取链路文件，或条目路径是某个读取链路文件（含 pattern 目录）的祖先目录。
//   符号链接 / 子模块在 git ls-tree 里是一个条目：它若落在 wbs-server/scripts 这类祖先位置，下面的登记文件就不会落进临时树。
function coversReadChain(p) {
  const k = matchKey(p);
  if (isTreeInputPath(k) || isReaderChainPath(k)) return true;
  const d = k.endsWith('/') ? k : k + '/';
  return [...TREE_INPUTS.files, ...READER_CHAIN.files].some((x) => x.startsWith(d)) || TREE_INPUTS.patternDirs.some((x) => x.startsWith(d));
}
// 改动路径里命中登记读取链路的（排序、去重；输出用路径原值）。
function readerChainHits(changedPaths) { return Array.from(new Set(Array.from(changedPaths || []).map(normPath).filter(isReaderChainPath))).sort(); }
// 读取器漂移硬门（94 号 HIGH-3）：返回 { problems, note }。改动集含登记读取链路的文件时，没有人工声明（attest 非空字符串）→ problems 一条；有声明 → 只给 note（调用方打印 / 写进 meta）。
function sRegistryDriftProblems(changedPaths, attest) {
  const hits = readerChainHits(changedPaths);
  if (!hits.length) return { problems: [], note: null };
  const list = hits.slice(0, 12).join('、') + (hits.length > 12 ? ' …' : '');
  if (nonEmpty(attest)) return { problems: [], note: `登记读取逻辑在本次改动内（${hits.length} 个路径：${list}）；<S> 时登记已按人工声明继续（--s-registry-attest ${JSON.stringify(String(attest).trim())}）` };
  return { problems: [`登记读取逻辑在本次改动内（${hits.length} 个路径：${list}）：registryAtCommit 用当前版本的读取器读 <S> 时登记，读取规则 / 依赖变了之后它的结果不可自动信任——须人工核对 <S> 时登记（用旧版读取器在 <S> 的内容上读十组登记，与本工具读出的逐条核对），核对完再加 --s-registry-attest "<理由>" 重跑；不给理由不放行`], note: null };
}
// 排除项（复验之后才允许后补的产物）与「源码 / 驱动 / 登记 / 基线 / 清单」重叠判据（89 号 HIGH-1）：file / dir 是仓库相对路径（dir 带结尾 /）。
//   重叠 = 产品 / 测试路径名单（isProductTestPath）、闸门工具目录、登记读取链路，或 extra（调用方给的具体输入文件：基线、生效清单、去向表以外的输入）里的路径相同；dir 排除还不许是这些路径的祖先目录（排除 wbs-server/ 等于整片放行）。返回命中的说明或 null。
function protectedPathHit(rel, isDir, extra) {
  const k = matchKey(rel);
  const ex = (extra || []).map(matchKey);
  if (!isDir) {
    if (isProductTestPath(k) || k.startsWith(TOOL_DIR) || isReaderChainPath(k) || isTreeInputPath(k)) return '与源码 / 驱动 / 登记 / 工具目录重叠';
    if (ex.includes(k)) return '与本次的基线 / 生效清单 / 登记输入文件相同';
    return null;
  }
  const d = k.endsWith('/') ? k : k + '/';
  const protectedPrefixes = [...PRODUCT_TEST_PATHS.prefixes, TOOL_DIR];
  const protectedFiles = [...PRODUCT_TEST_PATHS.files, ...READER_CHAIN.files, ...TREE_INPUTS.files, ...ex];
  if (d === '/' || d === './') return '是仓库根目录（等于整仓库放行）';
  if (protectedPrefixes.some((x) => d.startsWith(x) || x.startsWith(d))) return '与源码 / 驱动 / 登记 / 工具目录重叠（目录相同、在其内或是其祖先）';
  if (protectedFiles.some((x) => x.startsWith(d))) return '是源码 / 登记 / 依赖清单 / 输入文件的祖先目录';
  if (PRODUCT_TEST_PATHS.patterns.some((re) => re.test(d.slice(0, -1) + '/x.js')) || READER_CHAIN.patterns.some((re) => re.test(d.slice(0, -1) + '/x.js')) || TREE_INPUTS.patterns.some((re) => re.test(d.slice(0, -1) + '/x.js'))) return '目录下的文件落在源码 / 驱动 / 登记名单内';
  return null;
}

// 重复对象键检测（84 号 MEDIUM）：JSON.parse 对同名字段保留最后一个值，前一处的内容在结构校验之前就消失了。
//   对原始文本做一遍轻量扫描（文本须已是合法 JSON）：每个对象里同一个键出现两次就记一条，路径形如 $.mustRun[1].group。返回路径数组。
function duplicateKeys(text) {
  const dups = [];
  const n = text.length;
  let i = 0;
  const ws = () => { while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\r' || text[i] === '\n')) i += 1; };
  const str = () => { const s = i; i += 1; while (i < n && text[i] !== '"') { if (text[i] === '\\') i += 1; i += 1; } i += 1; return JSON.parse(text.slice(s, i)); };
  const val = (where) => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const seen = new Set();
      ws();
      if (text[i] === '}') { i += 1; return; }
      for (;;) {
        ws();
        const k = str();
        if (seen.has(k)) dups.push(where + '.' + k);
        seen.add(k);
        ws();
        i += 1; // ':'
        val(where + '.' + k);
        ws();
        if (text[i] === ',') { i += 1; continue; }
        i += 1; // '}'
        return;
      }
    } else if (c === '[') {
      i += 1;
      ws();
      if (text[i] === ']') { i += 1; return; }
      for (let idx = 0; ; idx += 1) {
        val(where + '[' + idx + ']');
        ws();
        if (text[i] === ',') { i += 1; continue; }
        i += 1; // ']'
        return;
      }
    } else if (c === '"') str();
    else while (i < n && !/[,\]}\s]/.test(text[i])) i += 1;
  };
  val('$');
  return dups;
}

// 读生效清单：返回 { doc, sha256, bytes }；读不到 / 不是 JSON / 有重复对象键抛错（调用方报用法错误）。sha256 取原始字节。
function readEffectiveFile(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw new Error('--effective 无法读取：' + e.message); }
  const text = buf.toString('utf8');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error('--effective 不是 JSON：' + e.message); }
  const dups = duplicateKeys(text);
  if (dups.length) throw new Error('--effective 里有重复的对象键（JSON.parse 会悄悄保留最后一个值，前一处的内容就消失了）：' + dups.join('、'));
  return { doc, sha256: sha256Of(buf), bytes: buf.length };
}

// 一个 { group, id } 引用的形态核对；返回规整后的 { group, id } 或 null（问题写进 problems）。
function refOf(x, where, groups, problems) {
  if (!isObj(x)) { problems.push(where + '：须是 { group, id } 对象'); return null; }
  const extra = Object.keys(x).filter((k) => k !== 'group' && k !== 'id');
  if (extra.length) problems.push(where + '：有未知字段 ' + extra.map((k) => JSON.stringify(k)).join('、'));
  if (typeof x.group !== 'string' || !groups.includes(x.group)) { problems.push(where + '：group ' + JSON.stringify(x.group) + ' 不在可用的组里（' + groups.join(' / ') + '）'); return null; }
  if (!nonEmpty(x.id)) { problems.push(where + '：id 须是非空字符串'); return null; }
  return { group: x.group, id: x.id };
}

// schema 校验。ctx = { groups: 已知组名数组, sKeys: Set | null（<S> 时登记里的 group\0id；null = 不核 <S> 相关项，只给自检的纯 schema 用例用）,
//   currentKeys: Set | null（当前登记；null = 不核当前登记相关项）}。
//   返回 { problems: string[], eff: 规整结果 | null }。eff = { commit, mustRun: [{group,id}], retire: [{group,id,category,newId?,by?}],
//   added: [{group,id}], required: [{group,id,source}]（source = mustRun / by / remount / added：复验集合里非自动范围的部分，按文件顺序）, retiredKeys: Set }。
function validateEffective(doc, ctx) {
  const problems = [];
  const groups = ctx.groups;
  const sKeys = ctx.sKeys || null;
  const currentKeys = ctx.currentKeys || null;
  if (!isObj(doc)) return { problems: ['生效清单须是 JSON 对象'], eff: null };
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k)) problems.push('顶层有未知字段 ' + JSON.stringify(k));
  for (const k of REQUIRED_TOP_KEYS) if (!(k in doc)) problems.push('顶层缺字段 ' + JSON.stringify(k));
  if (doc.format !== FORMAT) problems.push('format 是 ' + JSON.stringify(doc.format) + '，只认 ' + FORMAT);
  if (!nonEmpty(doc.commit)) problems.push('commit（所属提交名）须是非空字符串');
  if (!Array.isArray(doc.mustRun)) problems.push('mustRun 须是数组');
  if (!Array.isArray(doc.retire)) problems.push('retire 须是数组');
  if ('added' in doc && !Array.isArray(doc.added)) problems.push('added 须是数组');
  if ('reason' in doc && !nonEmpty(doc.reason)) problems.push('reason 须是非空字符串');
  if (problems.length) return { problems, eff: null };
  const addedRaw = 'added' in doc ? doc.added : [];
  // mustRun / retire / added 全空：只有带非空 reason 才许（例如只改 .gitignore 的提交：没有生效变异、但改了 none 白名单外的文件）；闸门照常跑自动范围与全部硬门。没有 reason 的空清单拒绝。
  if (doc.mustRun.length === 0 && doc.retire.length === 0 && addedRaw.length === 0 && !nonEmpty(doc.reason)) return { problems: ['mustRun、retire、added 都是空：全空的清单必须带非空的 "reason" 字段说明为什么没有生效变异（只改工具 / 文档的提交可以改用 --effective-none "<理由>"）'], eff: null };

  const mustRun = [];
  const seenMust = new Set();
  doc.mustRun.forEach((x, i) => {
    const r = refOf(x, `mustRun[${i}]`, groups, problems);
    if (!r) return;
    if (seenMust.has(keyOf(r))) { problems.push(`mustRun[${i}] ${show(r)}：重复`); return; }
    seenMust.add(keyOf(r));
    if (sKeys && !sKeys.has(keyOf(r))) problems.push(`mustRun[${i}] ${show(r)}：不在 ${S_LABEL}里（mustRun 只收 <S> 时已登记且当前仍登记的变异；本提交新增的变异经 by / newId / added 进复验集合）`);
    if (currentKeys && !currentKeys.has(keyOf(r))) problems.push(`mustRun[${i}] ${show(r)}：不在当前登记里（没有东西可复验；已删除的变异写进 retire）`);
    mustRun.push(r);
  });

  const retire = [];
  const seenRetire = new Set();
  const seenNewId = new Map(); // 94 号 MEDIUM：remount 的 newId 只许有一个来源（逐条改挂）；多条旧编号共用同一个承接编号请用 equivalent 的 by
  doc.retire.forEach((x, i) => {
    const where = `retire[${i}]`;
    if (!isObj(x)) { problems.push(where + '：须是对象'); return; }
    const allowed = ['group', 'id', 'category', ...(x.category === 'remount' ? ['newId'] : []), ...(x.category === 'equivalent' ? ['by'] : [])];
    const extra = Object.keys(x).filter((k) => !allowed.includes(k));
    if (extra.length) problems.push(where + '：有未知字段或与类别不符的字段 ' + extra.map((k) => JSON.stringify(k)).join('、') + '（stop-only 只有 group / id / category；remount 另有 newId；equivalent 另有 by）');
    const r = refOf({ group: x.group, id: x.id }, where, groups, problems);
    if (!CATEGORIES.includes(x.category)) { problems.push(where + '：category ' + JSON.stringify(x.category) + ' 不在 ' + CATEGORIES.join(' / ') + ' 里'); return; }
    if (!r) return;
    if (seenRetire.has(keyOf(r))) { problems.push(`${where} ${show(r)}：重复`); return; }
    seenRetire.add(keyOf(r));
    if (sKeys && !sKeys.has(keyOf(r))) problems.push(`${where} ${show(r)}：不在 ${S_LABEL}里（只能删除 <S> 时已登记的变异）`);
    if (currentKeys && currentKeys.has(keyOf(r))) problems.push(`${where} ${show(r)}：还在当前登记里（说它被删除了，登记里却还有）`);
    const item = { group: r.group, id: r.id, category: x.category };
    if (x.category === 'remount') {
      const n = refOf(x.newId, where + '.newId', groups, problems);
      if (n) {
        if (keyOf(n) === keyOf(r)) problems.push(`${where} ${show(r)}：newId 不能等于被删编号自身`);
        if (sKeys && sKeys.has(keyOf(n))) problems.push(`${where} ${show(r)}：newId ${show(n)} 已在 ${S_LABEL}里（改挂要给新编号；承接 <S> 时已有的变异请用 equivalent）`);
        if (currentKeys && !currentKeys.has(keyOf(n))) problems.push(`${where} ${show(r)}：newId ${show(n)} 不在当前登记里`);
        if (seenNewId.has(keyOf(n))) problems.push(`${where} ${show(r)}：newId ${show(n)} 与 ${seenNewId.get(keyOf(n))} 重复（同一个新编号只有一个来源：改挂逐条对应；多条旧变异由同一个新变异承接时，改用 equivalent 的 by，并逐条核对承接关系）`);
        else seenNewId.set(keyOf(n), where + ' ' + show(r));
        item.newId = n;
      }
    } else if (x.category === 'equivalent') {
      if (!Array.isArray(x.by) || x.by.length === 0) problems.push(`${where} ${show(r)}：equivalent 的 by 须是非空数组`);
      else {
        const by = [];
        const seenBy = new Set();
        x.by.forEach((b, j) => {
          const n = refOf(b, `${where}.by[${j}]`, groups, problems);
          if (!n) return;
          if (seenBy.has(keyOf(n))) { problems.push(`${where}.by[${j}] ${show(n)}：重复`); return; }
          seenBy.add(keyOf(n));
          if (keyOf(n) === keyOf(r)) problems.push(`${where}.by[${j}] ${show(n)}：承接编号不能是被删编号自身`);
          if (currentKeys && !currentKeys.has(keyOf(n))) problems.push(`${where}.by[${j}] ${show(n)}：不在当前登记里（承接变异必须仍已登记）`);
          by.push(n);
        });
        item.by = by;
      }
    }
    retire.push(item);
  });

  // added：本提交新增、<S> 时没有的变异（预筛 HIGH-1）
  const added = [];
  const seenAdded = new Set();
  addedRaw.forEach((x, i) => {
    const where = `added[${i}]`;
    if (isObj(x) && 'note' in x && typeof x.note !== 'string') problems.push(where + '：note 须是字符串');
    const r = isObj(x) ? refOf({ group: x.group, id: x.id }, where, groups, problems) : refOf(x, where, groups, problems);
    if (isObj(x)) { const extra = Object.keys(x).filter((k) => k !== 'group' && k !== 'id' && k !== 'note'); if (extra.length) problems.push(where + '：有未知字段 ' + extra.map((k) => JSON.stringify(k)).join('、')); }
    if (!r) return;
    if (seenAdded.has(keyOf(r))) { problems.push(`${where} ${show(r)}：重复`); return; }
    seenAdded.add(keyOf(r));
    if (sKeys && sKeys.has(keyOf(r))) problems.push(`${where} ${show(r)}：已在 ${S_LABEL}里（added 只声明 <S> 时没有的新增变异）`);
    if (currentKeys && !currentKeys.has(keyOf(r))) problems.push(`${where} ${show(r)}：不在当前登记里（声明新增，登记里却没有）`);
    added.push(r);
  });
  // added 不得与 remount 的 newId 重复（同一个新编号只有一个来源；它再被某条 equivalent 的 by 引用是允许的，只在改挂项里声明）
  for (const r of retire) if (r.newId && seenAdded.has(keyOf(r.newId))) problems.push(`added ${show(r.newId)}：同时是 retire ${show(r)} 的 newId（改挂的新编号不用再写进 added；若它同时是某条 equivalent 的承接编号，只在改挂项里声明，by 照常引用）`);

  // 跨项核对：被删编号不得同时是 mustRun；被删编号不得充当任何承接 / 改挂目标
  const retiredKeys = new Set(retire.map(keyOf));
  for (const m of mustRun) if (retiredKeys.has(keyOf(m))) problems.push(`mustRun ${show(m)}：同时在 retire 里（已删除的变异不能要求复验）`);
  for (const r of retire) {
    for (const b of r.by || []) if (retiredKeys.has(keyOf(b))) problems.push(`retire ${show(r)} 的 by ${show(b)}：承接编号本身也在 retire 里`);
    if (r.newId && retiredKeys.has(keyOf(r.newId))) problems.push(`retire ${show(r)} 的 newId ${show(r.newId)}：改挂目标本身也在 retire 里`);
  }
  // 集合级核对：<S> 时登记里有、当前登记里没有的编号，必须与 retire 全等（删除而不在 retire 里，等于绕过处置类别）
  if (sKeys && currentKeys) {
    const missing = Array.from(sKeys).filter((k) => !currentKeys.has(k));
    for (const k of missing) if (!retiredKeys.has(k)) problems.push(`${S_LABEL}里有、当前登记里没有的编号 ${showKey(k)} 不在 retire 里（删除的变异必须逐条登记处置类别）`);
  }
  // 集合级核对（预筛 HIGH-1）：当前登记 − <S> 时登记 必须与 added ∪ 全部 remount 的 newId 全等。登记里多出来的新编号没声明 → 拒；
  //   声明了却不在登记里的（added / newId）已在上面逐条拒。新增的变异不声明就不会被要求复验，所以不许悄悄放过。
  if (sKeys && currentKeys) {
    const declared = new Set([...seenAdded, ...retire.filter((r) => r.newId).map((r) => keyOf(r.newId))]);
    for (const k of currentKeys) if (!sKeys.has(k) && !declared.has(k)) problems.push(`当前登记里有、${S_LABEL}里没有的编号 ${showKey(k)} 既不在 added 里也不是 remount 的 newId（新增的变异必须声明）`);
  }
  if (problems.length) return { problems, eff: null };

  const required = [];
  for (const m of mustRun) required.push({ group: m.group, id: m.id, source: 'mustRun' });
  for (const r of retire) for (const b of r.by || []) required.push({ group: b.group, id: b.id, source: 'by' });
  for (const r of retire) if (r.newId) required.push({ group: r.newId.group, id: r.newId.id, source: 'remount' });
  for (const a of added) required.push({ group: a.group, id: a.id, source: 'added' });
  return { problems, eff: { commit: doc.commit, reason: nonEmpty(doc.reason) ? doc.reason : null, mustRun, retire, added, required, retiredKeys } };
}

// --effective-none 适用范围核对（84 号 HIGH-3）：changedPaths（<S>..HEAD + 未提交 + 未跟踪的改动路径，与 changedFilesSince 同口径）必须全部落在 NONE_MODE_ALLOW 白名单内。返回问题数组。
function noneScopeProblems(changedPaths) {
  const bad = Array.from(changedPaths || []).map(normPath).filter((p) => !isNoneAllowedPath(p)).sort();
  if (!bad.length) return [];
  return [`--effective-none 只适用于改动集全部落在工具 / 文档白名单内的提交（${NONE_MODE_ALLOW.prefixes.map((x) => x + '**').join('、')}、仓库根目录的 *.md）；这 ${bad.length} 个改动路径不在白名单里：${bad.slice(0, 12).join('、')}${bad.length > 12 ? ' …' : ''}（涉及产品或测试行为的改动要给 --effective 生效清单，由人确认受影响的变异）`];
}

// 带 reason 的全空清单（mustRun / retire / added 都空）的适用范围：改动集（changedPathsSince 同口径）含 PRODUCT_TEST_PATHS 里的任何路径 → 拒；
//   涉及这些路径的提交必须有至少一条经人确认的清单条目。只改 .gitignore 这类不在名单里的路径仍可用。返回问题数组。
function emptyListScopeProblems(eff, changedPaths) {
  if (!eff || eff.mustRun.length || eff.retire.length || eff.added.length) return [];
  const hit = Array.from(changedPaths || []).map(normPath).filter(isProductTestPath).sort();
  if (!hit.length) return [];
  return [`mustRun / retire / added 全空的清单（只靠 reason）不能用于改了产品或测试路径的提交；这 ${hit.length} 个改动路径涉及产品 / 测试代码：${hit.slice(0, 12).join('、')}${hit.length > 12 ? ' …' : ''}（涉及这些路径的提交必须有至少一条经人确认的清单条目：mustRun / retire / added）`];
}

// 不给生效清单时（--effective-none）：<S> 时登记里有、当前登记里没有的编号必须为空——删了变异就得有生效清单；当前登记里有、<S> 时没有的编号也必须为空——新增变异要在生效清单的 added 里声明；
//   改动集必须在 NONE_MODE_ALLOW 白名单内（noneScopeProblems）。返回问题数组。
function noneModeProblems(sKeys, currentKeys, changedPaths) {
  const out = [];
  for (const k of currentKeys) if (!sKeys.has(k)) out.push(`${showKey(k)}：当前登记里有、${S_LABEL}里没有，但本次给的是 --effective-none（新增变异必须给生效清单并在 added 里声明）`);
  for (const k of sKeys) if (!currentKeys.has(k)) out.push(`${showKey(k)}：${S_LABEL}里有、当前登记里没有，但本次给的是 --effective-none（删除变异必须给生效清单并登记处置类别）`);
  out.push(...noneScopeProblems(changedPaths));
  return out;
}

// 去向表里的编号引用：字符串（同组）/ { group, id } / 它们的数组 → 规整成 { group, id } 数组；形态不对返回 null。
function refListOf(v, defGroup) {
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    if (typeof x === 'string' && x.trim() !== '') out.push({ group: defGroup, id: x });
    else if (isObj(x) && typeof x.group === 'string' && nonEmpty(x.id)) out.push({ group: x.group, id: x.id });
    else return null;
  }
  return out;
}
const sameRefSet = (a, b) => a.length === b.length && new Set(a.map(keyOf)).size === a.length && b.every((x) => a.some((y) => keyOf(y) === keyOf(x)));
// 去向表一行的「去向」（兼容别名 destination）：只认非空字符串，其余形态（null / 数字 / 对象）一律当空，不做 String() 转换（84 号 LOW-2）。
const destOf = (d) => { const v = d['去向'] !== undefined ? d['去向'] : d.destination; return typeof v === 'string' ? v.trim() : ''; };

// retire 的每个旧编号在去向表里恰好一行，带对应处置类别与该类别要求的字段。返回问题数组。承接命中证据与当次运行的比对在 build-mutation-baseline.js 第 ③ 步做。
//   opts.requireEvidence（缺省 true）：false = 第 ① 步口径——不核「承接命中证据」（那时还没有当次复验日志，证据是看完日志才补写的）；第 ③ 步（effectiveGateProblems）一律 true。
//   去向表是一份跨提交累计的文件（C2、C3… 逐提交追加），每行带必填字段「提交」（如 "C2"，值与该提交生效清单的 commit 对应）。退役类核对只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等；
//   其他提交的退役行忽略（不报多余类别）；带「处置类别」却没有「提交」字段的行一律报（累计表每行须带提交名）。
function retireDispositionProblems(eff, dispositions, opts) {
  const requireEvidence = !opts || opts.requireEvidence !== false;
  const problems = [];
  const all = dispositions || [];
  for (const d of all) if (d['处置类别'] !== undefined && !nonEmpty(d['提交'])) problems.push(`去向表 ${show(d)}：带「处置类别」却没有「提交」字段（累计去向表每行须带提交名，如 "C2"，与生效清单的 commit 对应）`);
  const mine = all.filter((d) => d['提交'] === eff.commit);
  const rows = new Map();
  for (const d of mine) { const k = keyOf(d); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(d); }
  for (const r of eff.retire) {
    const tag = `retire ${show(r)}（${r.category}）`;
    const rs = rows.get(keyOf(r)) || [];
    if (rs.length === 0) { problems.push(tag + `：去向表里没有「提交」= ${JSON.stringify(eff.commit)} 的登记行（别的提交的行不算）`); continue; }
    if (rs.length > 1) { problems.push(tag + `：去向表里「提交」= ${JSON.stringify(eff.commit)} 的行有 ${rs.length} 行（应恰好一行）`); continue; }
    const d = rs[0];
    if (d['处置类别'] !== r.category) { problems.push(tag + '：登记行的「处置类别」是 ' + JSON.stringify(d['处置类别']) + '，生效清单里是 ' + JSON.stringify(r.category)); continue; }
    if (destOf(d) === '') problems.push(tag + '：登记行的「去向」为空（须是非空字符串）');
    if (r.category === 'stop-only') {
      if (!nonEmpty(d['删除依据'])) problems.push(tag + '：登记行缺「删除依据」（须是非空字符串）');
    } else {
      const want = r.category === 'remount' ? [r.newId] : r.by;
      const got = d['现行编号'] === undefined ? null : refListOf(d['现行编号'], r.group);
      if (got === null) problems.push(tag + '：登记行缺「现行编号」或形态不对（字符串 / { group, id } / 数组）');
      else if (!sameRefSet(got, want)) problems.push(tag + '：登记行的「现行编号」' + JSON.stringify(got.map((x) => x.id)) + ' 与生效清单里的 ' + JSON.stringify(want.map((x) => x.id)) + ' 不全等');
      if (r.category === 'equivalent') {
        if (!nonEmpty(d['等价业务错误'])) problems.push(tag + '：登记行缺「等价业务错误」（须是非空字符串）');
        if (requireEvidence && !nonEmpty(d['承接命中证据'])) problems.push(tag + '：登记行缺「承接命中证据」（须是非空字符串）');
      }
    }
  }
  // 反向：本次提交的行里带「处置类别」的，编号必须在 retire 里（其他提交的行忽略）
  for (const d of mine) if (d['处置类别'] !== undefined && !eff.retiredKeys.has(keyOf(d))) problems.push(`去向表 ${show(d)}：「提交」= ${JSON.stringify(eff.commit)}、带「处置类别」，但该编号不在生效清单的 retire 里`);
  return problems;
}

// ── git 读取：改动路径集合与 <S> 时点的登记 ──────────────────────────────────────────────
function gitRaw(repo, args, input) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { maxBuffer: 1024 * 1024 * 1024, input });
  return r.status === 0 ? r.stdout : null;
}
const gitText = (repo, args) => { const b = gitRaw(repo, args); return b === null ? null : b.toString('utf8'); };
// git status --porcelain 的文本行 → 路径列表（改名 / 复制取两端；去掉 git 给特殊字符路径加的引号；统一正斜杠）。
//   只用于来源快照（build-mutation-baseline.js 的 snapshotInputs / strayDirtyPaths，C1 基线生成那条路径，文本行里含 " -> " 的带引号路径会被拆开，已登记为快照限度）；
//   闸门用的改动集一律走 statusEntriesZ（-z，按记录消费，不解析文本行）。
function porcelainPaths(lines) {
  const out = [];
  for (const l of lines || []) {
    if (l.length < 4) continue;
    const rest = l.slice(3);
    const renamed = /[RC]/.test(l.slice(0, 2)) && rest.includes(' -> ');
    for (const part of renamed ? rest.split(' -> ') : [rest]) out.push(part.replace(/^"(.*)"$/, '$1').replace(/\\/g, '/'));
  }
  return out;
}
// git 输出的字节 → 文本；路径不是合法 UTF-8（往返不相等）就抛错，不悄悄换成替换字符。
function utf8Strict(buf, what) {
  const text = buf.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buf)) throw new Error(what + '里有不是合法 UTF-8 的路径，无法无损处理');
  return text;
}
// <S> 的共用校验（94 号 HIGH-2；文件模式、无清单模式、registryAtCommit、changedPathsSince 都先过它）：
//   完整 40 位小写十六进制；git cat-file -t 必须是 commit（树 / blob / 标签一律拒，registryAtCommit 的 ls-tree 能读树对象，不校验类型会拿错起点）；必须是 HEAD 的祖先（别的分支上的提交算不出「自上一提交以来的改动」）。
//   opts.gate（96 号 HIGH-1，正式闸门第 ①②③ 步用）：<S> 还必须是 HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（三步在提交之后补跑）——误填更早的祖先时，前一提交新增、本次删除的编号两端都不存在，
//   清单会漏掉本次退役；累计查询（--affected --cumulative、不带清单的 --affected）不传 opts.gate，保留任意祖先。
function validateSinceCommit(repo, since, label, opts) {
  const tag = label || '--changed-since';
  if (!/^[0-9a-f]{40}$/.test(String(since))) throw new Error(tag + ' 只收完整 40 位小写十六进制提交号');
  const kind = gitText(repo, ['cat-file', '-t', since]);
  if (kind === null) throw new Error(tag + ' 的提交 ' + since + ' 不在本仓库里');
  if (kind.trim() !== 'commit') throw new Error(tag + ' 的对象 ' + since + ' 是 ' + kind.trim() + '，不是提交（<S> 必须是上一提交的提交号）');
  if (gitText(repo, ['merge-base', '--is-ancestor', since, 'HEAD']) === null) throw new Error(tag + ' 的提交 ' + since + ' 不是 HEAD 的祖先');
  if (opts && opts.gate) {
    const head = (gitText(repo, ['rev-parse', 'HEAD']) || '').trim();
    const parent = (gitText(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^']) || '').trim();
    if (since !== head && since !== parent) throw new Error(tag + ' 的提交 ' + since + ' 既不是 HEAD（' + head.slice(0, 12) + '，三步在提交之前跑）也不是 HEAD 的第一父提交（' + (parent ? parent.slice(0, 12) : '无') + '，三步在提交之后补跑）：正式闸门的 <S> 只许这两种（更早的祖先会让前一提交新增、本次删除的编号两端都不存在，清单漏掉本次退役）；要看任意祖先以来的累计范围用 --affected … --cumulative');
    // 98 号 HIGH：C1–C9 保持线性历史——进行中的合并、合并提交（多个父提交）一律拒；线分支同步 main 用 rebase 且只在 C9 之后
    if (gitRaw(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']) !== null) throw new Error(tag + '：仓库里有进行中的合并（MERGE_HEAD 存在）：C1–C9 保持线性历史，线分支同步 main 用 rebase 且只在 C9 之后；先 git merge --abort（或完成合并后改用 rebase 重做），再跑本步');
    const parentCount = ((gitText(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']) || '').trim().split(/\s+/).filter(Boolean).length) - 1;
    if (parentCount > 1) throw new Error(tag + '：HEAD（' + head.slice(0, 12) + '）是合并提交（' + parentCount + ' 个父提交）：C1–C9 保持线性历史，线分支同步 main 用 rebase 且只在 C9 之后；含合并提交的链补不回有效留档（<S> = HEAD 的第一父提交的补跑、<S> = HEAD 都拒）');
    // <S> 本身是合并提交（补跑 <S> = HEAD^ = M、HEAD = M 之后的单父提交 X：上面两道都不成立）同样拒
    const sinceParents = ((gitText(repo, ['rev-list', '--parents', '-n', '1', since]) || '').trim().split(/\s+/).filter(Boolean).length) - 1;
    if (sinceParents > 1) throw new Error(tag + '：<S>（' + since.slice(0, 12) + '）本身是合并提交（' + sinceParents + ' 个父提交）：C1–C9 保持线性历史，线分支同步 main 用 rebase 且只在 C9 之后；<S> 是合并提交时它第二父提交上的改动没有任何留档能覆盖');
  }
  return since;
}
// 工作区状态记录（89 / 94 号 MEDIUM）：git status --porcelain=v1 -z --untracked-files=all，按记录消费——「XY 路径」，改名 / 复制是「XY 新路径」后跟一条「旧路径」，两端都收。
//   返回 [{ xy, path, orig }]（path / orig 是 git 给出的原值，不带引号转义；orig 仅改名 / 复制有）；读不到抛错。
function statusEntriesZ(repo) {
  const raw = gitRaw(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (raw === null) throw new Error('读不到 git status');
  return parseStatusZ(utf8Strict(raw, 'git status'));
}
// git status --porcelain=v1 -z 的输出文本 → [{ xy, path, orig }]（纯函数，自检用合成文本验证）。
function parseStatusZ(text) {
  const toks = text.split('\0');
  const out = [];
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (!t) continue;
    if (t.length < 4 || t[2] !== ' ') throw new Error('读不懂 git status -z 的一条记录：' + JSON.stringify(t.slice(0, 80)));
    const xy = t.slice(0, 2);
    const entry = { xy, path: t.slice(3), orig: null };
    if (/[RC]/.test(xy)) { i += 1; if (!toks[i]) throw new Error('git status -z 的改名 / 复制记录缺少另一端：' + JSON.stringify(t.slice(0, 80))); entry.orig = toks[i]; }
    out.push(entry);
  }
  return out;
}
// <since>..HEAD 的改动 + 工作区改动（含未跟踪、改名两端）；读不到就抛错（闸门不放行）。build-mutation-baseline.js 的 changedFilesSince 与第 ① 步的适用范围 / 读取器漂移核对共用本函数。
// Git 给出的路径一律按原值返回、原值去重（96 号 MEDIUM：旧版返回前把反斜杠换成正斜杠，在允许文件名含反斜杠的系统上根级 `docs\说明.txt` 会被归进 `docs/`、两个不同的 Git 路径也可能折叠成一个）。
//   名单匹配（matchKey / isXxxPath）各自归一，不改写这里的路径。本工具按 Windows 文件系统工作，路径要用 '/' 切段去定位文件：含反斜杠或开头是 ./ 的路径没法无损处理（切段会错位），明确报错而不是悄悄改写。
function losslessPaths(list) {
  const bad = list.filter((p) => p.includes('\\') || p.startsWith('./') || p === '.');
  if (bad.length) throw new Error('改动集里有无法无损处理的路径（含反斜杠或以 ./ 开头；本工具按「正斜杠分段的 Git 路径 + Windows 文件系统」工作，不改写 Git 路径）：' + bad.slice(0, 5).map((p) => JSON.stringify(p)).join('、') + (bad.length > 5 ? ' …' : ''));
  return new Set(list);
}
// opts.gate：见 validateSinceCommit（正式闸门第 ①②③ 步传 { gate: true }；累计查询不传）。
function changedPathsSince(repo, since, opts) {
  validateSinceCommit(repo, since, undefined, opts);
  // -z：路径逐个以 NUL 结尾、不带 git 的引号转义（含空格 / 特殊字符的路径原样）；工作区状态同样用 -z（statusEntriesZ）
  const dRaw = gitRaw(repo, ['diff', '--name-only', '--no-renames', '-z', since, 'HEAD']);
  if (dRaw === null) throw new Error('读不到 git diff');
  const st = statusEntriesZ(repo);
  const out = losslessPaths([...utf8Strict(dRaw, 'git diff').split('\0').filter(Boolean), ...st.flatMap((e) => (e.orig === null ? [e.path] : [e.path, e.orig]))]);
  const head = gitText(repo, ['rev-parse', 'HEAD']);
  if (head !== null && head.trim() === since && out.size === 0) throw new Error('--changed-since 就是 HEAD 且工作区干净：没有任何改动，无需复验，拒绝（给上一提交的提交号）');
  return out;
}

// 尽力清理（94 号 LOW）：某个文件 / 目录删除失败（Windows 文件占用）不终止遍历，其余照删；每个失败项短暂重试 3 次（有限，每次约 80 毫秒）；返回残留路径与原因 [{ path, error }]，调用方汇总。
const sleepMs = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 取不到就不等 */ } };
function removeTreeBestEffort(dir) {
  const residue = [];
  const attempt = (fn, p) => {
    let lastErr = null;
    for (let i = 0; i < 3; i += 1) { try { fn(p); return true; } catch (e) { lastErr = e; sleepMs(80); } }
    residue.push({ path: p, error: lastErr && lastErr.code ? lastErr.code : String(lastErr) });
    return false;
  };
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { residue.push({ path: d, error: e && e.code ? e.code : String(e) }); return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p); else attempt(fs.unlinkSync, p);
    }
    attempt(fs.rmdirSync, d);
  };
  walk(dir);
  return residue;
}

// <S> 提交时点的变异登记（84 号 MEDIUM-2 / 85 号 HIGH-2）：把 <S> 的文件树（除 docs/ 外的全部 blob）原样落进私有临时目录，起子进程在那份内容上跑 mutation-check.js --ids-only 读十组登记
//   （require 登记数据 / 静态抽取，与读当前登记同一套 loadRegistry + normalizeGroup）。不用 checkout / stash / worktree，不碰当前工作区；临时目录用完逐个 unlink / rmdir 删除。
//   子进程的 NODE_PATH 指向本仓库的 wbs-server/node_modules 与 node_modules（临时目录里没有依赖）。读取失败（任一组读不到、id 不是字面量、组内重复 id）整体抛错，不返回残缺登记。
//   返回 { keys: Set（group\0id）, list: [{ group, id }], fileCount, skipped: { docs, links: [路径], submodules: [路径] }, residue: [{ path, error }], loadedOutsideTree, newReaderError, ownReader }。
//   opts.ownReader（96 号 HIGH-3；resolveSRegistry 在读取器漂移且人工声明时传）：另用 <S> 树自带的 mutation-check.js --ids-only 在同一份临时树上再读一次，结果放进 ownReader { ok, list, keys, error }；
//   这时新版读取器读不了也不抛错（keys / list 为 null、原因在 newReaderError），由 resolveSRegistry 按两份结果的关系决定用哪份；不传 opts.ownReader 时新版读不了照旧抛错。
//   落盘硬化与「跳过项落在登记读取链路里就报错」见头注释（94 号 MEDIUM）；调用前先过 validateSinceCommit（94 号 HIGH-2）。读取器漂移（94 号 HIGH-3）由调用方用 sRegistryDriftProblems 另核，不在本函数里。
const WIN_RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function landingPathProblem(rel) {
  if (rel === '' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return '是绝对路径或带盘符';
  if (/[\\:\u0000-\u001f<>"|?*]/.test(rel)) return '含反斜杠 / 冒号 / 控制字符 / Windows 不允许的字符，落到 Windows 目录会改变含义';
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return '含空段 / . / ..';
    if (/[. ]$/.test(seg)) return '某一段以点或空格结尾（Windows 会悄悄去掉）';
    if (WIN_RESERVED_RE.test(seg)) return '某一段是 Windows 保留设备名';
  }
  return null;
}
function registryAtCommit(repo, since, opts) {
  validateSinceCommit(repo, since, '<S>');
  const ls = gitRaw(repo, ['ls-tree', '-r', '-z', '--full-tree', since]);
  if (ls === null) throw new Error('<S> 时登记：git ls-tree ' + since + ' 失败（提交不在本仓库里？）');
  const files = [];
  const skipped = { docs: 0, links: [], submodules: [] };
  const lcSeen = new Map(); // 小写路径 → 原路径（大小写别名 / 冲突检测）
  const lcDirs = new Set();
  const lcDirOrig = new Map(); // 小写目录路径 → 原始拼写（目录别名检测）
  const skippedChain = [];
  for (const rec of utf8Strict(ls, 'git ls-tree').split('\0').filter(Boolean)) {
    const m = /^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(rec);
    if (!m) throw new Error('<S> 时登记：读不懂 git ls-tree 的一行：' + rec.slice(0, 80));
    const rel = m[4]; // 路径原值（不做反斜杠换算：含反斜杠的 git 路径落到 Windows 会改变含义，下面直接拒）
    if (m[2] === 'commit' || m[1] === '160000') { skipped.submodules.push(rel); if (coversReadChain(rel)) skippedChain.push(rel); continue; } // 子模块不落地
    if (m[1] === '120000') { skipped.links.push(rel); if (coversReadChain(rel)) skippedChain.push(rel); continue; } // 符号链接不落地
    if (m[2] !== 'blob' || (m[1] !== '100644' && m[1] !== '100755')) throw new Error('<S> 时登记：git ls-tree 里有不认识的条目类型 ' + m[1] + ' ' + m[2] + '：' + JSON.stringify(rel));
    if (rel.toLowerCase().startsWith('docs/')) { skipped.docs += 1; if (coversReadChain(rel)) skippedChain.push(rel); continue; } // docs/ 不落地（大小写别名同样跳过）
    const bad = landingPathProblem(rel);
    if (bad) throw new Error('<S> 时登记：路径 ' + JSON.stringify(rel) + ' 不能无损落到临时树：' + bad);
    const lk = rel.toLowerCase();
    if (lcSeen.has(lk)) throw new Error('<S> 时登记：路径 ' + JSON.stringify(rel) + ' 与 ' + JSON.stringify(lcSeen.get(lk)) + ' 只差大小写，落到 Windows 目录会互相覆盖');
    lcSeen.set(lk, rel);
    const segs = lk.split('/');
    const osegs = rel.split('/');
    // 96 号 MEDIUM：逐段记录目录名的原始拼写——两个目录只差大小写、里面的文件名互不重复时，整条路径的小写值不相等，但落到 Windows 临时树里会合并成一个目录
    for (let i = 1; i < segs.length; i += 1) {
      const dl = segs.slice(0, i).join('/');
      const dor = osegs.slice(0, i).join('/');
      if (lcDirs.has(dl) && lcDirOrig.get(dl) !== dor) throw new Error('<S> 时登记：目录 ' + JSON.stringify(dor) + ' 与 ' + JSON.stringify(lcDirOrig.get(dl)) + ' 只差大小写，落到 Windows 临时树会合并成一个目录');
      lcDirs.add(dl);
      lcDirOrig.set(dl, dor);
    }
    files.push({ rel, sha: m[3] });
  }
  for (const f of files) if (lcDirs.has(f.rel.toLowerCase())) throw new Error('<S> 时登记：路径 ' + JSON.stringify(f.rel) + ' 在大小写别名下既是文件又是目录，无法落地');
  if (skippedChain.length) throw new Error('<S> 时登记：登记读取链路里有被跳过的项（docs/ / 符号链接 / 子模块不落进临时树，读取会读空或读歪）：' + skippedChain.slice(0, 8).join('、'));
  if (files.length === 0) throw new Error('<S> 时登记：提交 ' + since + ' 里没有可落地的文件');
  const batch = gitRaw(repo, ['cat-file', '--batch'], Buffer.from(files.map((f) => f.sha).join('\n') + '\n'));
  if (batch === null) throw new Error('<S> 时登记：git cat-file --batch 失败');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-sreg-'));
  let result = null;
  try {
    const tree = path.join(root, 'tree');
    let pos = 0;
    for (const f of files) {
      const nl = batch.indexOf(0x0a, pos);
      const head = nl < 0 ? '' : batch.toString('utf8', pos, nl);
      const m = /^([0-9a-f]{40}) blob (\d+)$/.exec(head);
      if (!m || m[1] !== f.sha) throw new Error('<S> 时登记：git cat-file 的输出与请求对不上（' + f.rel + '）：' + head.slice(0, 80));
      const size = Number(m[2]);
      const body = batch.subarray(nl + 1, nl + 1 + size);
      if (body.length !== size) throw new Error('<S> 时登记：git cat-file 的输出被截断（' + f.rel + '）');
      const abs = path.join(tree, ...f.rel.split('/'));
      const back = path.relative(tree, abs);
      // 96 号 MEDIUM：「跑到临时树之外」按完整路径段判断（根级文件 ..notes 合法；只有第一段恰好是 .. 才是越界）
      if (back === '' || back.split(/[\\/]/)[0] === '..' || path.isAbsolute(back)) throw new Error('<S> 时登记：路径 ' + JSON.stringify(f.rel) + ' 的落地位置跑到了临时树之外');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      pos = nl + 1 + size + 1;
    }
    const np = [path.join(repo, 'wbs-server', 'node_modules'), path.join(repo, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
    // 跑一份读取器脚本（--ids-only 入口）：返回 { ok, list, loaded, error }；脚本不存在 / 没有 --ids-only 入口 / 退出码非 0 / 输出不是 { ids } 都是 ok:false，不抛错
    const runReader = (script, outFile) => {
      if (!fs.existsSync(script)) return { ok: false, list: null, loaded: [], error: '读取器脚本不存在：' + script };
      const r = spawnSync(process.execPath, [script, '--ids-only', outFile, '--repo', tree], { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_PATH: np } });
      if (r.status !== 0 || !fs.existsSync(outFile)) return { ok: false, list: null, loaded: [], error: '读十组登记失败（退出码 ' + r.status + '）：' + String(r.stderr || r.stdout || r.error || '').trim().slice(0, 600) };
      let doc = null;
      try { doc = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (e) { return { ok: false, list: null, loaded: [], error: '输出不是 JSON：' + e.message }; }
      if (!doc || !Array.isArray(doc.ids)) return { ok: false, list: null, loaded: [], error: '子进程输出不是 { ids: [...] }' };
      // 98 号 MEDIUM：逐项校验记录形状（对象、group / id 都是非空字符串、组内无重复）；非法统一返回 ok:false，交给调用方的回退分支（新版非法、旧版正常 → 采信旧版），不抛异常
      const list = [];
      const seenIds = new Set();
      for (let i = 0; i < doc.ids.length; i += 1) {
        const x = doc.ids[i];
        if (!isObj(x) || typeof x.group !== 'string' || x.group === '' || typeof x.id !== 'string' || x.id === '') return { ok: false, list: null, loaded: [], error: `子进程输出的第 ${i + 1} 个元素不是 { group, id }（两者都须是非空字符串）：${JSON.stringify(x === undefined ? null : x).slice(0, 80)}` };
        const k = keyOf(x);
        if (seenIds.has(k)) return { ok: false, list: null, loaded: [], error: `子进程输出里 ${show(x)} 重复出现（第 ${i + 1} 个元素）` };
        seenIds.add(k);
        list.push({ group: x.group, id: x.id });
      }
      return { ok: true, list, loaded: Array.isArray(doc.loaded) ? doc.loaded : [], error: null };
    };
    // 新版读取器 = 本文件所在目录的 mutation-check.js（当前检出）；旧版读取器 = <S> 树自带的同名脚本（96 号 HIGH-3：读取器在本次改动内时，人工核对要用它）
    //   opts.newReaderScript：只给自检用的库函数参数（代替当前检出的读取器脚本，验证新版输出非法时走回退分支）；命令行不可达，正式调用都不传
    const cur = runReader((opts && opts.newReaderScript) || path.join(__dirname, 'mutation-check.js'), path.join(root, 'ids.json'));
    let own = null;
    if (opts && opts.ownReader) own = runReader(path.join(tree, 'wbs-server', 'scripts', 'sysbuild-step1', 'mutation-check.js'), path.join(root, 'ids-own.json'));
    if (!cur.ok && !(opts && opts.ownReader)) throw new Error('<S> 时登记：在 ' + since + ' 的内容上' + cur.error);
    // 读 <S> 时子进程里加载的模块中，位于临时树之外的（= 从当前检出加载的读取器与它的非 node_modules 依赖；绝对路径）；自检据此核对 READER_CHAIN
    //   前缀比较用 realpath（临时目录可能是 8.3 短名 / 联接，子进程 require.cache 里是真实路径）；模块路径不存在时退回 path.resolve
    const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
    const treeNorm = real(tree).toLowerCase();
    const loadedOutsideTree = cur.loaded.filter((p) => typeof p === 'string' && !real(p).toLowerCase().startsWith(treeNorm + path.sep));
    result = { keys: cur.ok ? new Set(cur.list.map(keyOf)) : null, list: cur.ok ? cur.list : null, newReaderError: cur.ok ? null : cur.error, ownReader: own ? { ok: own.ok, list: own.list, keys: own.ok ? new Set(own.list.map(keyOf)) : null, error: own.error } : null, fileCount: files.length, skipped, residue: [], loadedOutsideTree };
    return result;
  } finally {
    const residue = removeTreeBestEffort(root);
    if (result) result.residue = residue;
    if (residue.length) console.error(`  [清理] <S> 时登记的临时目录 ${root} 有 ${residue.length} 个路径没删掉（其余已清；多半是 Windows 文件占用，保留现场供手工清理）：${residue.slice(0, 5).map((x) => x.path + '（' + x.error + '）').join('、')}${residue.length > 5 ? ' …' : ''}`);
  }
}

// <S> 时登记的编号摘要（96 号 HIGH-3：第 ①②③ 步核同一份）：对去重、排序后的 group\0id 全集取 sha256。
const keysDigestOf = (list) => sha256Of(Buffer.from(JSON.stringify(Array.from(new Set((list || []).map(keyOf))).sort()), 'utf8'));
const digestRecord = (list, source) => ({ sha256: keysDigestOf(list), count: new Set((list || []).map(keyOf)).size, source });
// 读取 <S> 时登记并决定采信哪份（正式闸门第 ①②③ 步共用；96 号 HIGH-3）。changedPaths：改动集；attest：人工声明（调用方已 trim、非空时才算声明）。
//   · 读取器链路不在改动集里 → 用当前读取器读（registryAtCommit），不需要声明；
//   · 在改动集里、没有声明 → problems 一条（拒绝，沿用 sRegistryDriftProblems 的口径）；
//   · 在改动集里、有声明 → 工具自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only）读一遍：
//       两份读出的编号集合全等 → 记录理由继续（采信这份，来源「新旧读取器全等」）；
//       不同、或新版读不了 → 以旧版读取器读出的编号集合做增删核对（新版结果只在 printed 里对照）；
//       <S> 树没有可用的 --ids-only 入口（旧版读取器读不了），或新旧读取器都读不了 → problems（一律拒绝）。
//   返回 { list, keys, digest: { sha256, count, source } | null, note, printed: [行], problems: [], drift: 是否命中读取器链路, fileCount, skipped, residue }。
function resolveSRegistry(repo, since, { changedPaths, attest }) {
  const hits = readerChainHits(changedPaths);
  const drift = hits.length > 0;
  const guard = sRegistryDriftProblems(changedPaths, attest);
  const out = { list: null, keys: null, digest: null, note: guard.note, printed: [], problems: [...guard.problems], drift, fileCount: 0, skipped: { docs: 0, links: [], submodules: [] }, residue: [] };
  if (out.problems.length) return out;
  const r = registryAtCommit(repo, since, { ownReader: drift });
  out.fileCount = r.fileCount; out.skipped = r.skipped; out.residue = r.residue;
  const sameSet = (a, b) => a.size === b.size && Array.from(a).every((k) => b.has(k));
  const diffText = (a, b) => { const onlyA = Array.from(a).filter((k) => !b.has(k)); const onlyB = Array.from(b).filter((k) => !a.has(k)); return `只有新版读出 ${onlyA.length} 条${onlyA.length ? '（' + onlyA.slice(0, 3).map(showKey).join('、') + (onlyA.length > 3 ? ' …' : '') + '）' : ''}；只有旧版读出 ${onlyB.length} 条${onlyB.length ? '（' + onlyB.slice(0, 3).map(showKey).join('、') + (onlyB.length > 3 ? ' …' : '') + '）' : ''}`; };
  let chosen;
  let source;
  if (!drift) { chosen = r.list; source = '当前读取器（读取器链路不在本次改动内）'; } else {
    const own = r.ownReader;
    if (r.keys && own && own.ok && sameSet(r.keys, own.keys)) { chosen = r.list; source = '新旧读取器结果全等（<S> 树自带的读取器与当前读取器读出同一份，记录人工理由后继续）'; out.printed.push(`<S> 时登记：新版读取器与 <S> 树自带的旧版读取器读出的编号集合全等（${r.keys.size} 条）`); }
    else if (own && own.ok) {
      chosen = own.list; source = '旧版读取器（<S> 树自带的 mutation-check.js --ids-only）';
      out.printed.push(r.keys ? `<S> 时登记：新版读取器与旧版读取器读出的编号集合不同（新版 ${r.keys.size} 条、旧版 ${own.keys.size} 条；${diffText(r.keys, own.keys)}）：增删核对以旧版读取器读出的为准，新版结果只作对照` : `<S> 时登记：新版读取器读不了（${r.newReaderError}）：增删核对以旧版读取器读出的 ${own.keys.size} 条为准`);
    } else {
      // U1 裁定：<S> 树没有可用的 --ids-only 入口（旧版读取器读不了），或新旧读取器都读不了 → 一律拒绝（C2 起所有 <S> 都有该入口，这条路只会在异常情况下被走到，硬门不留放行口）
      out.problems.push('<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理：' + String(own && own.error || '未运行').slice(0, 200) + (r.keys ? '' : '；新版读取器也读不了（' + r.newReaderError + '）') + '，无法读出可核对的 <S> 时登记');
      return out;
    }
  }
  out.list = chosen;
  out.keys = new Set(chosen.map(keyOf));
  out.digest = digestRecord(chosen, source);
  return out;
}
// 96 号 MEDIUM（主会话降级项）：正式闸门核对「运行的脚本位于 --repo 内」。从另一个检出里的脚本去审 --repo 指定的仓库时，读取器 / 依赖来自别处，名单无命中也可能读歪。返回问题文字或 null。
function foreignToolProblem(toolDir, repo) {
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return path.resolve(p); } };
  const t = real(toolDir).toLowerCase();
  const r = real(repo).toLowerCase();
  if (t === r || t.startsWith(r + path.sep)) return null;
  return `运行的脚本在 ${real(toolDir)}，不在 --repo ${real(repo)} 里（跨检出调用：读取器与依赖来自别的检出，名单核对不到；三步命令在本线仓库根运行，用 --repo 内的 wbs-server/scripts/sysbuild-step1/ 下的脚本）`;
}
// 提交后补跑要求工作区干净（预筛 MED-1；三步共用这一处）：正式闸门下 <S> = HEAD 的第一父提交（提交之后补跑）时，改动集（<S>..HEAD 是已提交的那一个提交）之外不许再有未提交 / 未跟踪的路径——
//   否则「HEAD 之后的工作区改动」会混进以 HEAD^ 为 <S> 的改动集，复验对象不是单个提交。扣掉第 ②③ 步声明的补写产物（ignore：{ files: [仓库相对路径], dirs: [仓库相对目录，带结尾 /] }，如复验目录、--dispositions、--report）；--effective / 基线走 ignore.inputs（被 HEAD 跟踪时须与 HEAD 一致才豁免，见下）。
//   <S> = HEAD 时不核（还没提交的改动就是改动集）。返回问题文字或 null；状态读不到抛错。
//   98 号 MEDIUM：ignore.inputs（基线、生效清单这类决定「复验什么」的输入）若被 HEAD 跟踪，只有工作区与暂存区内容都与 HEAD 一致才豁免——补跑读到的必须是 HEAD 里的那份；
//   没被 HEAD 跟踪（独立准备的未跟踪输入）照旧豁免。ignore.files / dirs（--dispositions / --report / 复验目录：声明的补写产物）照旧整体豁免。
//   实现：git status 里只要有这条路径的任何记录（XY 不是 ??），就是工作区或暂存区与 HEAD 不同（被 HEAD 跟踪时）。
function postCommitDirtyProblem(repo, since, ignore) {
  const head = (gitText(repo, ['rev-parse', 'HEAD']) || '').trim();
  if (since === head) return null;
  const files = ((ignore && ignore.files) || []).map(normPath);
  const dirs = ((ignore && ignore.dirs) || []).map(normPath).map((d) => (d.endsWith('/') ? d : d + '/'));
  const inputs = ((ignore && ignore.inputs) || []).map(normPath);
  const trackedInputs = new Set(inputs.filter((p) => gitRaw(repo, ['cat-file', '-e', 'HEAD:' + p]) !== null));
  const left = Array.from(new Set(statusEntriesZ(repo).flatMap((e) => (e.orig === null ? [e.path] : [e.path, e.orig])))).filter((p) => !files.includes(p) && !dirs.some((d) => p.startsWith(d)) && !(inputs.includes(p) && !trackedInputs.has(p))).sort();
  if (!left.length) return null;
  const strict = left.filter((p) => trackedInputs.has(p));
  return `提交后补跑（<S> = HEAD 的第一父提交）要求工作区干净：这 ${left.length} 个路径还有未提交 / 未跟踪的改动：${left.slice(0, 8).join('、')}${left.length > 8 ? ' …' : ''}${strict.length ? `（其中 ${strict.join('、')} 是被 HEAD 跟踪的基线 / 生效清单：补跑时它们的工作区与暂存区内容必须与 HEAD 一致，不能带着补跑前已暂存或改过的修改）` : ''}。提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD`;
}
// 把绝对路径换成「仓库相对、正斜杠」；在仓库之外 / 空 → null（git 看不到，不用扣）。
function repoRelPath(repo, f) {
  if (!f) return null;
  const r = path.relative(repo, f);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? normPath(r) : null;
}
// 累计去向表整表核对（96 号 MEDIUM；正式闸门第 ①③ 步，含 --effective-none 分支）：每一行都必须有非空的「提交」。独立查询（--query-baseline）保留旧表兼容、不调用本函数。
//   opts.skipRetireRows：文件模式下带「处置类别」的行已由 retireDispositionProblems 报过，这里跳过避免重复。
function dispositionTableProblems(rows, opts) {
  const skip = !!(opts && opts.skipRetireRows);
  const out = [];
  (rows || []).forEach((d, i) => {
    if (skip && d['处置类别'] !== undefined) return;
    if (!nonEmpty(d['提交'])) out.push(`累计去向表第 ${i + 1} 行 ${show(d)}：缺非空的「提交」字段（正式闸门下累计去向表每一行都须带提交名，如 "C2"）`);
  });
  return out;
}

module.exports = { FORMAT, foreignToolProblem, postCommitDirtyProblem, repoRelPath, resolveSRegistry, keysDigestOf, digestRecord, dispositionTableProblems, losslessPaths, coversReadChain, CATEGORIES, NONE_MODE_ALLOW, PRODUCT_TEST_PATHS, READER_CHAIN, TREE_INPUTS, isTreeInputPath, TOOL_DIR, emptyListScopeProblems, readEffectiveFile, duplicateKeys, validateEffective, noneModeProblems, noneScopeProblems, retireDispositionProblems, refListOf, destOf, sha256Of, porcelainPaths, utf8Strict, parseStatusZ, statusEntriesZ, validateSinceCommit, changedPathsSince, registryAtCommit, removeTreeBestEffort, landingPathProblem, isProductTestPath, isNoneAllowedPath, isReaderChainPath, readerChainHits, sRegistryDriftProblems, protectedPathHit, normPath };
