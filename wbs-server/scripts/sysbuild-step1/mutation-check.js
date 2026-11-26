'use strict';
// #212 第一步（C1b）只读工具：变异登记核对。
//   方案 5.4：对全部变异逐条报告三项——目标文件存在、定位字面量在目标文件里唯一命中、所属用例名仍登记；
//   另做「登记不丢」：与基线名单对比，少掉的每一条都要在去向表里有记录。
//   只读：不改被检文件、不跑任何用例、不起服务、不开库；--out / --emit-ids 只写调用方指定的输出文件。
//   威胁模型（用户 P-THREAT = A，89 / 94 号之后）：诚实的单用户，防遗漏与疏忽，不防有意构造输入的规避；需要有意构造输入才能绕过的意见按 MEDIUM 处理，只用低成本硬门收口——
//   本脚本的两道：自检钩子（<S> 时登记的替换）不是命令行参数、读取器漂移须人工声明（--s-registry-attest）；详见 effective-list.js 头注释「威胁模型」。
//
// 用法：
//   node wbs-server/scripts/sysbuild-step1/mutation-check.js [--groups api,browser,...] [--out <报告 json>] [--verbose]
//   node wbs-server/scripts/sysbuild-step1/mutation-check.js --emit-ids <out.json>            写出当前全部变异清单（按组、按登记顺序）
//   node wbs-server/scripts/sysbuild-step1/mutation-check.js --query-baseline <json> [--dispositions <json>] [--groups …]
//        独立查询入口（不是提交闸门，不核生效清单与 <S> 时登记）：基线有、现在没有的 id 必须在 disposition（[{ group, id, 去向 }]，去向须是非空字符串）里登记，否则失败；现在有、基线没有的只列出（--disposition 同义）。
//        退出码 1 的情形（94 号 LOW，与 main 的查询分支一致）：① 基线里消失的编号没有去向（缺去向 / 去向为空）；② 登记里有条目核对不通过（目标文件不存在 / 定位字面量不是恰好命中 1 次 / 用例名不在清单里等）；
//        ③ 组内有重复 id；④ 十组登记读取失败（含登记里的展开项）。用法错误 = 2。
//        --query-baseline 收 --emit-ids 写出的数组，也直接收 build-mutation-baseline.js 生成的机器基线（fixtures/sysbuild-step1/mutation-baseline.json，取 entries）。
//   每个提交的固定命令序列（codex 79 HIGH-2；84 号 MEDIUM；<FIX> = wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json，<S> = 完整 40 位提交号：正式闸门下只许是 HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（三步在提交之后补跑；96 号 HIGH-1），<DISP> = 累计去向表 json）：
//     ① node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective <EFF>             编号不丢（提交闸门；本脚本只核编号，不比较失败位置）
//        node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective-none "<理由>"   没有生效变异的提交（只许改工具 / 文档）；<理由> 就是 --effective-none 的参数本身，没有别的传递方式
//        --baseline 是闸门：必须给 --changed-since 与 --effective / --effective-none 二选一（两个都不给 = 拒绝，用法错误），不能与 --groups 同用；不要生效清单的独立查询用 --query-baseline。
//        <S> 的共用校验（94 号 HIGH-2，effective-list.js validateSinceCommit，三步与文件模式 / 无清单模式同口径）：完整 40 位小写十六进制、git cat-file -t 为 commit（树 / 标签对象拒）、是 HEAD 的祖先；
//        96 号 HIGH-1：正式闸门（第 ①②③ 步）另要求 <S> = HEAD 本身或 HEAD 的第一父提交（opts.gate），更早的祖先拒（前一提交新增、本次删除的编号两端都不存在，清单会漏掉本次退役）；累计查询（build-mutation-baseline.js --affected … --cumulative、不带清单的 --affected）保留任意祖先。
//        预筛 MED-1：<S> = HEAD 的第一父提交（提交之后补跑）时另要求工作区干净——扣掉复验目录 / --dispositions / --report 这些声明的补写产物后，不许再有未提交 / 未跟踪的路径，有就是用法错误
//        （「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」；effective-list.js postCommitDirtyProblem，三步共用一处，自检钩子 skipCleanCheck 才跳过）；<S> = HEAD 时不核；--effective / 基线若被 HEAD 跟踪，工作区与暂存区内容都须与 HEAD 一致才豁免（没被 HEAD 跟踪的独立输入照旧豁免）。
//        96 号 MEDIUM（降级项）：运行的脚本必须位于 --repo 内（effective-list.js foreignToolProblem；跨检出调用 = 用法错误，自检钩子 allowForeignTool 才放行）。
//        本工具的流程约束：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick；每个提交（含工具、文档提交）都留第 ② 步复验目录（空计划也留），每份留档只覆盖一个提交。
//        98 号 HIGH（线性历史）：C1–C9 保持线性历史，线分支同步 main 用 rebase 且只在 C9 之后；正式闸门（effective-list.js validateSinceCommit，三步共用）拒绝进行中的合并（MERGE_HEAD 存在）、HEAD 是合并提交（多个父提交；<S> = HEAD 或 HEAD 的第一父提交两种都拒）、<S> 本身是合并提交（补跑 <S> = HEAD^ = M、HEAD 为 M 之后的单父提交）；更早的合并提交闸门看不到，只能由 C9 链核对拦。
//        98 号 MEDIUM：补跑（<S> = HEAD 的第一父提交）时，基线与生效清单若被 HEAD 跟踪，工作区与暂存区内容都须与 HEAD 一致才从干净检查里豁免（没被 HEAD 跟踪的独立输入照旧豁免；去向表 / 报告是声明的补写产物，照旧整体豁免）。
//        自检钩子（94 号 HIGH-1）：<S> 时登记的替换（--s-registry-file）不是命令行参数，只有自检内部调用 main(argv, hooks) 才能注入；命令行给 --s-registry-file、或把 --self-test 与任何正式参数同给，都是用法错误（退出码 2）。
//        读取器漂移硬门（94 号 HIGH-3）：改动集（<S>..HEAD + 未提交 + 未跟踪）含读取器链路的文件（只有读 <S> 时从当前检出加载的：mutation-check.js、effective-list.js、各层 package.json / package-lock.json，名单见 effective-list.js READER_CHAIN）时（只改套件 / 驱动 / sysbuild-mut-record.js / 产品文件不触发，它们从 <S> 的临时树加载；只有改了工具读取器或依赖清单的提交需要 --s-registry-attest），
//        <S> 时登记不可自动信任；不给 --s-registry-attest = 本步骤拒绝（提示须人工核对）。给了 --s-registry-attest "<理由>"（参数解析时统一 trim、空白 = 用法错误，之后全用这一个值；95 号 MEDIUM）时，
//        工具自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only，在 registryAtCommit 落盘的临时树里以子进程运行）读一遍 <S> 时登记（96 号 HIGH-3，effective-list.js resolveSRegistry）：
//          两份编号集合全等 → 记录理由继续；不同、或新版读取器读不了 → 增删核对以旧版读取器读出的编号集合为准（新版结果只打印对照）；<S> 树没有可用的 --ids-only 入口（旧版读取器读不了）→ 无法自动复核，
//          或新旧读取器都读不了 → 一律拒绝（「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」）。
//          依赖漂移的限度：只改依赖清单时，<S> 树的读取器与当前读取器共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住。所用编号摘要（sha256 / 条数 / 来源）打印在输出里，第 ②③ 步写进 meta / rerun.json / empty-plan.json 并核同一份。其余硬门照跑。
//        字段校验时点（89 号 MEDIUM-2）：本步骤对 equivalent 只核编号、类别、承接关系（现行编号）与已有依据（等价业务错误）；「承接命中证据」要对当次复验日志，第 ③ 步才强制，本步骤不核。
//        去向表口径（94 号 MEDIUM；协调方更正；96 号 MEDIUM）：<DISP> 是一份跨提交累计的文件（C2、C3… 逐提交追加），不是每提交一份；每一行（含普通三字段行；--effective-none 分支同样核，effective-list.js dispositionTableProblems）
//        必带非空字段「提交」（如 "C2"，与该提交生效清单的 commit 对应）；独立查询（--query-baseline）保留旧表兼容。
//        退役类核对（本步骤与第 ③ 步）：只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等，其他提交的退役行忽略（不报「多余类别」），带「处置类别」却没有「提交」的行报错；
//        「变了 / 需人工复核」的三字段登记（第 ③ 步）两条规则（与 --help 同文）：① 可以引用任何提交的行，命中证据必须与当次运行的失败对得上——前序提交登记过、本次失败没再变化的沿用旧行即过，失败再次变化的必须补新行，旧行证据对不上就拒；
//        ② 本提交新增 / 改挂的编号只接受「提交」= 本次的行；其余编号沿用历史行，以该编号最后一条退役行（带「处置类别」，按表内顺序）为界，其前的行属于旧一代、不算（95 号 MEDIUM 编号复用）。
//        <EFF> = 本提交的生效清单 json（schema 见 effective-list.js 头注释）。编号增删按 <S> 时登记核对（84 号 MEDIUM-2 / 85 号 HIGH-2；registryAtCommit 在 <S> 提交的内容上真跑登记读取函数，不 checkout）：
//        清单过 schema 校验、retire 的编号确已从登记里消失且 <S> 时已登记、<S> 时登记里消失的编号都在 retire 里、by / remount 新编号确已登记、当前登记 − <S> 时登记 = added ∪ 全部 remount newId（新增的变异必须声明）、
//        去向表里 retire 的每个旧编号恰好一行且带对应处置类别（stop-only / remount / equivalent）与该类别要求的字段；固定基线只打印累计差异供对照，不再参与增删全等。
//        --effective-none 时 <S> 时登记必须 = 当前登记，且改动集全部落在工具 / 文档白名单内（effective-list.js NONE_MODE_ALLOW：wbs-server/scripts/sysbuild-step1/**、docs/**、仓库根目录的 *.md；mustRun / retire / added 全空的清单必须带非空 reason 字段，
//        且只许用于改动集不含产品 / 测试路径（PRODUCT_TEST_PATHS）的提交——产品或测试路径下的全空清单一律拒，须至少一条经人确认的清单条目）。
//        承接 / 新增变异是否真被执行、真被抓住由第 ②③ 步核（本脚本不跑用例）。
//        --ids-only <输出 json>：内部入口（registryAtCommit 在 <S> 的内容上起子进程用），只读十组登记的编号（不能与其他输出 / 对比参数同用）。
//     ② node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --affected <FIX> --changed-since <S> [--affected-out <目录>]    先列受影响的条目（全部受影响 / 其中需人工复核 两类计数；不加 --effective / --effective-none 时只列自动范围，加了按来源列完整复验集合）
//        node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective <EFF> --dispositions <DISP> [--report <报告>]    再由本工具真跑（手工跑驱动、旧日志过不了闸门）：
//        node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective-none "<理由>" --dispositions <DISP> [--report <报告>]      没有生效清单的提交
//        （--dispositions 传与第 ③ 步相同的累计去向表路径；--report 单列可选；仓库内的补写路径必须第 ② 步预声明）
//        复验集合 = 自动范围 ∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号 ∪ added（当前登记有、<S> 时登记没有的全部编号）；--effective 与 --effective-none "<理由>" 二选一，两个都不给 = 拒绝；
//        api 用 `--mutation-ids` 只跑复验集合里的编号；其余各组驱动没有按编号只跑的参数，只能整组跑；每组写 <组>.meta.json（起始 HEAD、改动文件 sha256 与暂存区 / 工作区内容指纹、生效清单 sha256 与按来源列出的复验集合、排除项记录、被忽略的运行输入摘要等）
//        --raw-dir 在仓库里只许落在 tmp/ 下（或仓库之外）；第 ② 步的 --dispositions / --report 只用来声明「复验之后才补写的产物路径」（不读取），第 ③ 步只认这份记录（89 号 HIGH-1）。
//     ③ node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective <EFF>
//        node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective-none "<理由>"      没有生效清单的提交（理由与第 ② 步一致）
//        第 ③ 步要求改动集里每个路径在暂存区与工作区内容一致（先 git add 或撤销暂存），且与第 ② 步记录的内容一致：放行的就是将要提交的内容（89 号 HIGH-2；95 号：暂存 blob 与第 ② 步记的工作区 blob 比，不论第 ② 步时是否已暂存）；
//        非空复验的 rerun.json 结束记录须在且匹配、<S> 时登记的编号摘要须与第 ② 步一致（95 号 MEDIUM / 96 号 HIGH-3）。
//   十组全量失败位置比较只在 C1 与 C9 各跑一次。本脚本 --help 同文。
//   node wbs-server/scripts/sysbuild-step1/mutation-check.js --self-test
//   --repo <仓库根> 可改根（默认本检出）。退出码：任一检查失败 = 1；用法错误 = 2。
//
// 十组登记与读取办法（读取优先级：require 已导出的数据 → 静态抽取字面量）：
//   api         lib/sysbuild-api-suite.js 的 MUTATIONS（require；用例名 listCaseNames() 在不跑用例体的前提下调用 defineCases）
//   browser     lib/sysbuild-browser-suite.js 的 FRONT_MUTATIONS（require；场景名在 run() 里现建，只能静态扫描「[名字, 函数]」数组）
//   static      verify-sysbuild-static.js 的 MUTATIONS / RULES（require；require.main 守卫后只读导出）
//   schema / db / attachments  对应 verify-sysbuild-*.js 的 MUTATIONS（require；schema 用例名取其 CASE_NAMES 导出）
//   migration   scripts/sysbuild-predeploy/schema-migration-mutations.cjs（纯数据，require；用例名静态扫描 verify-schema-migration.cjs 的 test('名字')）
//   deploy      scripts/sysbuild-predeploy/verify-deploy-migration.cjs 顶层会执行（要参数、会起 PowerShell），不能 require：静态抽取，
//               `from` 是常量表达式（String.raw 模板、字符串相加、.replace）时由受限求值器还原；求不出的记为 <非字面量>
//   archive / readonly  run-archive-self-test.cjs / run-readonly-self-test.cjs 的 mutations（require；archive 顶层执行已包进 require.main 守卫）
//
// 定位字面量的计数口径与各组自己的自检驱动一致：除 deploy 外先把目标文件的 CRLF 换成 LF 再 split(from).length - 1；
//   deploy 驱动读原文不归一（deploy-ssh.ps1 必须 CRLF），这里同样不归一。
//   同一目标文件的多个 edit 按驱动顺序口径模拟：依次在「已应用前面 edit 的文本」上计数并替换（与 sysbuild-api-suite.js 变异副本准备一致）。
//   另核：edits 为空 → 不通过；create / remove 只有 static 组放行；api 组 edit 的 file 必须在 COPIED_MODULE_FILES 内；
//   attachments 组只认登记项自带的 file、且须在 routes/sysbuild 下 *.js（排除 index.js）内；
//   browser expectFailure / deploy 失败标签不在本脚本核对：标签多为运行时拼接，静态核不出；由 C1c 机器基线记录的失败信息原文在 C9 全量对比时兜住。
//   经动态用例名模式（'V' + 动态 + '…'，动态段只吃 1–16 个非空白字符，前缀 expect 须伸进后面的静态片段）放行的条数在汇总里单列。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const acorn = require('acorn');
const effList = require('./effective-list');

const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');
const ALL_GROUPS = ['api', 'browser', 'static', 'schema', 'db', 'attachments', 'migration', 'deploy', 'archive', 'readonly'];
// 2026-11-26：以 B7.4 补修前已验收的 1,401 条为下限，替代旧的 2,000 条门槛。
const MIN_REAL_REGISTRY_SIZE = 1401;
const ROUTES = 'wbs-server/routes/sysbuild';
const PREDEPLOY = 'scripts/sysbuild-predeploy';
const TEMP_SERVICE = PREDEPLOY + '/temp-service';
const TEMP_SERVICE_FILES = new Set(['server.cjs', 'server-client.js', 'offline.html', 'package.json', 'ecosystem.config.cjs']);
const NON = Symbol('non-literal');
const NON_TEXT = '<非字面量>';

const P = (repo, rel) => path.join(repo, ...rel.split('/'));
const clip = (s, n) => { const t = String(s).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 3) + '...' : t; };

// require 时把 process.argv 换成最小形态：被 require 的验证脚本顶层会读 --self-test / --root / --module-dir 这类参数，不能被本工具的参数干扰。
function requireQuiet(file) {
    const saved = process.argv;
    process.argv = [saved[0], file];
    try { return require(file); } finally { process.argv = saved; }
}

// ── 受限常量求值器（只给「静态抽取」用）────────────────────────────────────────────────
function evalNode(n, env, seen) {
    if (!n) return NON;
    switch (n.type) {
        case 'Literal': return n.regex ? NON : n.value;
        case 'TemplateLiteral': {
            let s = '';
            for (let i = 0; i < n.quasis.length; i += 1) {
                const q = n.quasis[i];
                s += q.value.cooked !== null && q.value.cooked !== undefined ? q.value.cooked : q.value.raw;
                if (i < n.expressions.length) { const v = evalNode(n.expressions[i], env, seen); if (v === NON) return NON; s += String(v); }
            }
            return s;
        }
        case 'TaggedTemplateExpression': {
            const tag = n.tag;
            if (!(tag.type === 'MemberExpression' && !tag.computed && tag.object.type === 'Identifier' && tag.object.name === 'String' && tag.property.name === 'raw')) return NON;
            let s = '';
            for (let i = 0; i < n.quasi.quasis.length; i += 1) {
                s += n.quasi.quasis[i].value.raw;
                if (i < n.quasi.expressions.length) { const v = evalNode(n.quasi.expressions[i], env, seen); if (v === NON) return NON; s += String(v); }
            }
            return s;
        }
        case 'BinaryExpression': {
            if (n.operator !== '+') return NON;
            const l = evalNode(n.left, env, seen);
            const r = evalNode(n.right, env, seen);
            if (l === NON || r === NON) return NON;
            if ((typeof l === 'string' || typeof l === 'number') && (typeof r === 'string' || typeof r === 'number')) return l + r;
            return NON;
        }
        case 'Identifier': {
            if (!env.has(n.name) || seen.has(n.name)) return NON;
            seen.add(n.name);
            const v = evalNode(env.get(n.name), env, seen);
            seen.delete(n.name);
            return v;
        }
        case 'CallExpression': {
            const c = n.callee;
            if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'replace' && n.arguments.length === 2) {
                const recv = evalNode(c.object, env, seen);
                const a = evalNode(n.arguments[0], env, seen);
                const b = evalNode(n.arguments[1], env, seen);
                if (typeof recv === 'string' && typeof a === 'string' && typeof b === 'string') return recv.replace(a, b);
            }
            return NON;
        }
        case 'ArrayExpression': return n.elements.map((e) => (e && e.type === 'SpreadElement' ? { __spread: true } : evalNode(e, env, seen)));
        case 'ObjectExpression': {
            const o = {};
            for (const p of n.properties) {
                if (p.type === 'SpreadElement') { o.__spread = true; continue; }
                const key = p.computed ? (p.key.type === 'Literal' ? String(p.key.value) : null) : (p.key.type === 'Identifier' ? p.key.name : String(p.key.value));
                if (key === null) { o.__computed = true; continue; }
                o[key] = evalNode(p.value, env, seen);
            }
            return o;
        }
        default: return NON;
    }
}
// 从源码顶层取 `const NAME = [ ... ]` 并求值；同文件顶层 `const X = <表达式>` 作为求值环境。
function extractRegistry(srcText, varName) {
    const ast = acorn.parse(srcText.replace(/\r\n/g, '\n'), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
    const env = new Map();
    let target = null;
    for (const st of ast.body) {
        if (st.type !== 'VariableDeclaration') continue;
        for (const d of st.declarations) {
            if (d.id.type !== 'Identifier' || !d.init) continue;
            env.set(d.id.name, d.init);
            if (d.id.name === varName) target = d.init;
        }
    }
    if (!target || target.type !== 'ArrayExpression') throw new Error('顶层找不到数组字面量 ' + varName);
    return evalNode(target, env, new Set());
}

// ── 用例名静态扫描 ─────────────────────────────────────────────────────────────────────
function walkAst(node, visit) {
    if (!node || typeof node.type !== 'string') return;
    visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        const v = node[key];
        if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit); } else if (v && typeof v.type === 'string') walkAst(v, visit);
    }
}
const strOf = (n) => (n && n.type === 'Literal' && typeof n.value === 'string' ? n.value : (n && n.type === 'TemplateLiteral' && n.expressions.length === 0 ? n.quasis[0].value.cooked : null));
// 用例名首参不全是字面量时（如 'V' + version.version + ' 历史指纹…'）拆成片段：字符串 = 静态片段，null = 动态片段（匹配任意文本）。
// consts：同文件顶层 `const NAME = '字符串'`（浏览器场景表里的名字常常是 [FLOW, async (page) => …] 这种常量）
function nameFragments(n, consts) {
    const s = strOf(n);
    if (s !== null) return [s];
    if (n && n.type === 'Identifier' && consts && consts.has(n.name)) return [consts.get(n.name)];
    if (n && n.type === 'BinaryExpression' && n.operator === '+') return nameFragments(n.left, consts).concat(nameFragments(n.right, consts));
    if (n && n.type === 'TemplateLiteral') {
        const out = [];
        n.quasis.forEach((q, i) => { out.push(q.value.cooked); if (i < n.expressions.length) out.push(null); });
        return out;
    }
    return [null];
}
function mergeFragments(frags) {
    const out = [];
    for (const f of frags) {
        const last = out.length - 1;
        if (f === '') continue;
        if (last >= 0 && typeof f === 'string' && typeof out[last] === 'string') out[last] += f;
        else if (last >= 0 && f === null && out[last] === null) continue;
        else out.push(f);
    }
    return out;
}
// 是否存在属于该片段模式的名字 S，使 expect 是 S 的前缀（full=false）或 S 全等于 expect（full=true）。
//   动态片段只吃 1–16 个非空白字符（'V' + version.version 这种短取值）；
//   前缀口径下，expect 必须「落在静态片段里」：expect 在动态片段内结束、而模式在该动态片段之后还有静态片段时判不匹配
//   （例如 expect = 'V1'，模式 'V' + 动态 + ' 历史指纹…'：没伸进后面的静态片段，不算登记）。
function patternMatch(frags, ex, full) {
    const rec = (i, pos) => {
        if (i === frags.length) return pos === ex.length;
        const f = frags[i];
        if (f === null) {
            if (pos === ex.length) return false; // 动态片段至少吃 1 个字符（expect 恰在前一个静态片段末尾结束的情形，上面的静态分支已判过）
            const last = i === frags.length - 1;
            for (let len = 1; len <= 16 && pos + len <= ex.length; len += 1) {
                if (/\s/.test(ex[pos + len - 1])) break;
                const p = pos + len;
                if (p === ex.length) { if (last) return true; continue; } // expect 在动态段内结束且后面还有静态片段 → 不算
                if (rec(i + 1, p)) return true;
            }
            return false;
        }
        if (pos === ex.length) return !full; // expect 恰在静态片段边界结束：前缀口径通过，全等口径不通过
        if (ex.startsWith(f, pos)) {
            const np = pos + f.length;
            if (np === ex.length && !full) return true; // expect 恰好结束在这个静态片段末尾
            return rec(i + 1, np);
        }
        return !full && f.startsWith(ex.slice(pos));
    };
    return rec(0, 0);
}
function nameMatch(name, ex, match) {
    if (typeof name === 'string') return match === 'prefix' ? name.startsWith(ex) : name === ex;
    return patternMatch(name.pattern, ex, match !== 'prefix');
}
// callName：形如 test('名字', …) 的调用；pairs：形如 ['名字', 函数] 的数组元素（浏览器场景表）
// 返回名字数组：纯字面量是字符串，含动态片段的是 { pattern: [...] }；完全取不出静态片段的首参不收（skipped 计数）。
function scanCaseNames(srcText, opts) {
    const ast = acorn.parse(srcText.replace(/\r\n/g, '\n'), { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
    const names = [];
    names.skipped = 0;
    const consts = new Map();
    for (const st of ast.body) {
        if (st.type !== 'VariableDeclaration') continue;
        for (const d of st.declarations) if (d.id.type === 'Identifier' && strOf(d.init) !== null) consts.set(d.id.name, strOf(d.init));
    }
    walkAst(ast, (n) => {
        if (opts.callName && n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === opts.callName && n.arguments.length > 0) {
            const frags = mergeFragments(nameFragments(n.arguments[0], consts));
            if (frags.length === 1 && typeof frags[0] === 'string') names.push(frags[0]);
            else if (frags.some((f) => typeof f === 'string')) names.push({ pattern: frags, text: frags.map((f) => (f === null ? '<动态>' : f)).join('') });
            else names.skipped += 1;
        }
        if (opts.pairs && n.type === 'ArrayExpression' && n.elements.length >= 2 && n.elements[0] && n.elements[1] && (n.elements[1].type === 'ArrowFunctionExpression' || n.elements[1].type === 'FunctionExpression')) {
            const frags = mergeFragments(nameFragments(n.elements[0], consts));
            if (frags.length === 1 && typeof frags[0] === 'string') names.push(frags[0]);
            else names.skipped += 1;
        }
    });
    return names;
}
function scanFiles(repo, rels, opts) {
    const names = [];
    names.skipped = 0;
    for (const rel of rels) { const part = scanCaseNames(fs.readFileSync(P(repo, rel), 'utf8'), opts); names.push(...part); names.skipped += part.skipped; }
    return names;
}

// ── 十组：登记读取与规范化 ─────────────────────────────────────────────────────────────
// 规范化条目：{ group, index, id, edits: [{ op: 'replace'|'create'|'remove', file: 仓库相对路径, from }], expect: string[]|null, expectNote? }
const nv = (v) => (v === NON || v === undefined || v === null ? NON : v);
// entryFileOnly：驱动只认登记项自带的 file、忽略 edit 自带的 file（attachments 组的口径）
function mkEdits(base, defaultFile, raw, entryFileOnly) {
    const list = Array.isArray(raw.edits) ? raw.edits : [raw];
    return list.map((e) => {
        if (e.create !== undefined) return { op: 'create', file: base + '/' + e.create, from: null };
        if (e.remove !== undefined) return { op: 'remove', file: base + '/' + e.remove, from: null };
        const f = entryFileOnly ? (raw.file !== undefined ? raw.file : defaultFile) : (e.file !== undefined ? e.file : (raw.file !== undefined ? raw.file : defaultFile));
        return { op: 'replace', file: f === undefined || f === null || f === NON ? NON : base + '/' + f, from: nv(e.from), to: nv(e.to) };
    });
}
const asArr = (v) => (v === undefined || v === NON ? null : (Array.isArray(v) ? v : [v]));

const GROUP_DEFS = {
    api: { match: 'prefix', expectRequired: true, normalize: (r) => ({ edits: mkEdits(ROUTES, null, r), expect: asArr(r.expect) }) },
    // browser 的 expectFailure 不在本脚本核对：标签多为运行时拼接，静态核不出；由 C1c 机器基线记录的失败信息原文在 C9 全量对比时兜住
    browser: { match: 'exact', expectRequired: true, normalize: (r) => ({ edits: mkEdits('wbs-server/public/assets/js', null, r), expect: asArr(r.expect) }) },
    static: { match: 'rule', expectRequired: true, normalize: (r) => ({ edits: mkEdits(ROUTES, null, r), expect: [r.rule].concat(Array.isArray(r.also) ? r.also : []) }) },
    schema: { match: 'prefix', expectRequired: true, normalize: (r) => ({ edits: mkEdits(ROUTES, 'schema.js', r), expect: asArr(r.expect) }) },
    db: { match: 'none', expectRequired: false, normalize: (r) => ({ edits: mkEdits(ROUTES, 'db.js', r), expect: null }) },
    // attachments 驱动只复制 routes/sysbuild 下的 *.js（排除 index.js），且只认登记项自带的 file（忽略 edit 里的 file）
    attachments: { match: 'none', expectRequired: false, entryFileOnly: true, normalize: (r) => ({ edits: mkEdits(ROUTES, null, r, true), expect: null }) },
    migration: { match: 'prefix', expectRequired: true, normalize: (r) => ({ edits: mkEdits(PREDEPLOY, 'schema-migration-core.cjs', r), expect: asArr(r.expect) }) },
    // deploy 的 expect 是 PowerShell 夹具生成的失败标签（flow:real_fail 之类），不是用例名：不在本脚本核对
    //   （标签多为运行时拼接，静态核不出；由 C1c 机器基线记录的失败信息原文在 C9 全量对比时兜住）
    deploy: { match: 'none', expectRequired: false, raw: true, normalize: (r) => ({ edits: [{ op: 'replace', file: 'scripts/deploy-ssh.ps1', from: nv(r.from), to: nv(r.to) }], expect: null }) },
    archive: { match: 'prefix', expectRequired: true, normalize: (r) => ({ edits: mkEdits(PREDEPLOY, 'archive-core.cjs', r), expect: asArr(r.expect) }) },
    readonly: {
        match: 'prefix',
        expectRequired: true,
        normalize: (r) => {
            const f = r.file;
            const base = typeof f === 'string' && TEMP_SERVICE_FILES.has(f) ? TEMP_SERVICE : PREDEPLOY; // 与 run-readonly-self-test.cjs 的候选目录拷贝口径一致
            return { edits: [{ op: 'replace', file: f === undefined || f === NON ? NON : base + '/' + f, from: nv(r.from), to: nv(r.to) }], expect: asArr(r.expect) };
        },
    },
};

function loadRegistry(group, repo) {
    switch (group) {
        case 'api': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/lib/sysbuild-api-suite.js')).MUTATIONS, source: 'require' };
        case 'browser': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/lib/sysbuild-browser-suite.js')).FRONT_MUTATIONS, source: 'require' };
        case 'static': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-static.js')).MUTATIONS, source: 'require' };
        case 'schema': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-schema.js')).MUTATIONS, source: 'require' };
        case 'db': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-db.js')).MUTATIONS, source: 'require' };
        case 'attachments': return { raw: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-attachments.js')).MUTATIONS, source: 'require' };
        case 'migration': return { raw: requireQuiet(P(repo, PREDEPLOY + '/schema-migration-mutations.cjs')), source: 'require' };
        case 'deploy': return { raw: extractRegistry(fs.readFileSync(P(repo, PREDEPLOY + '/verify-deploy-migration.cjs'), 'utf8'), 'mutations'), source: 'static-extract' };
        case 'archive': return { raw: requireQuiet(P(repo, PREDEPLOY + '/run-archive-self-test.cjs')).mutations, source: 'require' };
        case 'readonly': return { raw: requireQuiet(P(repo, PREDEPLOY + '/run-readonly-self-test.cjs')).mutations, source: 'require' };
        default: throw new Error('未知组 ' + group);
    }
}
function normalizeGroup(group, rawList) {
    if (!Array.isArray(rawList)) throw new Error('登记不是数组');
    const def = GROUP_DEFS[group];
    return rawList.map((r, index) => {
        if (r && r.__spread) return { group, index, id: NON_TEXT + '（展开项，取不到）', edits: [], expect: null, spread: true };
        const n = def.normalize(r);
        return { group, index, id: typeof r.id === 'string' ? r.id : NON, edits: n.edits, expect: n.expect, expectNote: n.expectNote || null };
    });
}
// 用例名清单：mode = 取法（require / static-scan / rules / none），names = 名单，match = 匹配方式
function loadCases(group, repo) {
    const def = GROUP_DEFS[group];
    const lib = (f) => 'wbs-server/scripts/lib/' + f;
    switch (group) {
        case 'api': {
            try {
                const names = requireQuiet(P(repo, lib('sysbuild-api-suite.js'))).listCaseNames();
                if (!Array.isArray(names) || names.length === 0) throw new Error('listCaseNames 返回空');
                return { mode: 'require', names, match: def.match };
            } catch (e) {
                const dir = P(repo, 'wbs-server/scripts/lib');
                const files = fs.readdirSync(dir).filter((f) => /^sysbuild-api-suite(-[a-z0-9-]+)?\.js$/.test(f)).map((f) => lib(f));
                return { mode: 'static-scan', names: scanFiles(repo, files, { callName: 'test' }), match: def.match, note: 'listCaseNames 不可用（' + e.message + '），退回静态扫描' };
            }
        }
        case 'browser': {
            const suiteFiles = ['suite', 'stage8', 'trace-setup', 'trace-forms', 'trace-confirm',
                'step3', 'step4', 'step5', 'step6', 'step7'].map((name) => lib('sysbuild-browser-' + name + '.js'));
            return { mode: 'static-scan', names: scanFiles(repo, suiteFiles, { pairs: true }), match: def.match, note: '场景表在 run() 里现建，只能静态扫描 [名字, 函数] 数组' };
        }
        case 'static': return { mode: 'rules', names: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-static.js')).RULES.map((r) => r[0]), match: def.match };
        case 'schema': return { mode: 'require', names: requireQuiet(P(repo, 'wbs-server/scripts/verify-sysbuild-schema.js')).CASE_NAMES, match: def.match };
        case 'migration': return { mode: 'static-scan', names: scanFiles(repo, [PREDEPLOY + '/verify-schema-migration.cjs'], { callName: 'test' }), match: def.match };
        case 'archive': return { mode: 'static-scan', names: scanFiles(repo, [PREDEPLOY + '/verify-archive.cjs'], { callName: 'test' }), match: def.match };
        case 'readonly': return { mode: 'static-scan', names: scanFiles(repo, [PREDEPLOY + '/verify-readonly.cjs'], { callName: 'test' }), match: def.match };
        default: return { mode: 'none', names: [], match: 'none' };
    }
}

// ── 单条核对 ───────────────────────────────────────────────────────────────────────────
function checkEntry(entry, ctx) {
    const def = GROUP_DEFS[entry.group];
    const res = { group: entry.group, index: entry.index, id: entry.id === NON ? NON_TEXT : entry.id, files: [], edits: [], caseCheck: null, problems: [] };
    if (entry.spread) { res.problems.push('登记里有展开项（...），元素取不到'); res.ok = false; return res; }
    if (entry.id === NON) res.problems.push('id 不是字面量');
    if (entry.edits.length === 0) res.problems.push('登记项没有任何 edit（变异没有内容）');
    // 同一目标文件的多个 edit 按驱动的顺序口径模拟：依次在「已应用前面 edit 的文本」上计数并替换（与 sysbuild-api-suite.js 的变异副本准备一致）
    const working = new Map();
    for (const e of entry.edits) {
        const er = { op: e.op, file: e.file === NON ? NON_TEXT : e.file, from: e.from === null ? null : (e.from === NON ? NON_TEXT : clip(e.from, 60)), hits: null, ok: true, problem: null };
        const bad = (msg) => { er.ok = false; er.problem = er.problem || msg; res.problems.push(msg); res.edits.push(er); };
        if (e.file === NON) { bad('目标文件不是字面量'); continue; }
        if ((e.op === 'create' || e.op === 'remove') && entry.group !== 'static') { bad(`${e.op} 类编辑只有 static 组的驱动支持，${entry.group} 组出现 → 变异不会生效：${e.file}`); continue; }
        const file = ctx.readFile(e.file, !!def.raw);
        if (e.op === 'create') { er.note = '合成文件，没有定位字面量'; res.edits.push(er); continue; }
        if (res.files.indexOf(e.file) < 0) res.files.push(e.file);
        if (!file.exists) { bad('目标文件不存在：' + e.file); continue; }
        // 驱动只会把这些文件复制进变异副本：api = COPIED_MODULE_FILES 清单；attachments = routes/sysbuild 下的 *.js 且排除 index.js
        const inRoutes = e.file.startsWith(ROUTES + '/') ? e.file.slice(ROUTES.length + 1) : null;
        if (entry.group === 'api' && ctx.copyLists && ctx.copyLists.api && !(inRoutes !== null && ctx.copyLists.api.includes(inRoutes))) { bad(`目标文件不在 api 驱动复制进变异副本的模块清单（COPIED_MODULE_FILES）里，edit 不会生效：${e.file}`); continue; }
        if (entry.group === 'attachments' && ctx.copyLists && ctx.copyLists.attachments && !(inRoutes !== null && ctx.copyLists.attachments.includes(inRoutes))) { bad(`目标文件不在 attachments 驱动复制的范围（routes/sysbuild 下 *.js 且排除 index.js）里，edit 不会生效：${e.file}`); continue; }
        if (e.op === 'remove') { er.note = '目标文件存在'; res.edits.push(er); continue; }
        if (e.from === NON || typeof e.from !== 'string' || e.from === '') { bad((e.from === NON ? '定位字面量不是字面量' : '定位字面量为空') + '：' + e.file); continue; }
        const text = working.has(e.file) ? working.get(e.file) : file.text;
        er.hits = text.split(e.from).length - 1;
        if (er.hits !== 1) { bad('定位字面量命中 ' + er.hits + ' 次（应恰好 1 次）：' + e.file + ' ' + JSON.stringify(clip(e.from, 40))); er.problem = '定位字面量命中 ' + er.hits + ' 次（应恰好 1 次）'; continue; }
        if (typeof e.to === 'string') working.set(e.file, text.replace(e.from, () => e.to)); else er.note = 'to 不是字面量，后续同文件 edit 按未应用本条计';
        res.edits.push(er);
    }
    // 用例是否仍登记
    const cs = ctx.cases[entry.group] || { mode: 'none', names: [], match: 'none' };
    const cc = { mode: cs.mode, match: cs.match, expect: entry.expect, results: [], ok: true };
    if (def.match === 'none') { cc.ok = true; cc.mode = 'n/a'; if (entry.expectNote) cc.note = entry.expectNote; } else if (!entry.expect || entry.expect.length === 0 || entry.expect.some((x) => typeof x !== 'string' || x.trim() === '')) {
        cc.ok = false;
        res.problems.push('没有登记 expect（或不是非空字符串）');
    } else {
        for (const ex of entry.expect) {
            const hit = cs.names.filter((n) => nameMatch(n, ex, cs.match));
            const matched = hit.length;
            const viaPattern = hit.filter((n) => typeof n !== 'string').length;
            cc.results.push(viaPattern > 0 ? { expect: ex, matched, viaPattern } : { expect: ex, matched });
            if (matched === 0) { cc.ok = false; res.problems.push((cs.match === 'rule' ? '规则不在清单里：' : '用例名未登记（' + (cs.match === 'exact' ? '精确' : '前缀') + '匹配 0 条）：') + ex); }
        }
    }
    res.caseCheck = cc;
    res.ok = res.problems.length === 0 && res.edits.every((x) => x.ok) && cc.ok;
    return res;
}
// extra：{ copyLists: { api: [文件名…]|null, attachments: [文件名…]|null } }；缺省不做对应核对
function makeCtx(repo, cases, extra) {
    const cache = new Map();
    return {
        repo,
        cases,
        copyLists: (extra && extra.copyLists) || null,
        readFile(rel, raw) {
            const key = rel + (raw ? '#raw' : '');
            if (cache.has(key)) return cache.get(key);
            const abs = P(repo, rel);
            let out;
            try {
                const st = fs.statSync(abs);
                if (!st.isFile()) out = { exists: false, text: '' };
                else { const t = fs.readFileSync(abs, 'utf8'); out = { exists: true, text: raw ? t : t.replace(/\r\n/g, '\n') }; }
            } catch (e) { out = { exists: false, text: '' }; }
            cache.set(key, out);
            return out;
        },
    };
}
function findDuplicates(entries) {
    const seen = new Map();
    for (const e of entries) { if (e.id === NON) continue; const k = e.group + '\u0000' + e.id; seen.set(k, (seen.get(k) || []).concat(e.index)); }
    return Array.from(seen.entries()).filter(([, idx]) => idx.length > 1).map(([k, idx]) => ({ group: k.split('\u0000')[0], id: k.split('\u0000')[1], indexes: idx }));
}
const toIdList = (entries) => entries.map((e) => ({ group: e.group, id: e.id === NON ? NON_TEXT : e.id, files: Array.from(new Set(e.edits.filter((x) => x.op !== 'create' && x.file !== NON).map((x) => x.file))), expect: e.expect }));

// ── 基线对比 ───────────────────────────────────────────────────────────────────────────
function compareBaseline(current, baseline, dispositions) {
    const key = (x) => x.group + '\u0000' + x.id;
    const count = (list) => { const m = new Map(); for (const x of list) m.set(key(x), (m.get(key(x)) || 0) + 1); return m; };
    const cur = count(current);
    const base = count(baseline);
    const split = (k) => { const i = k.indexOf('\u0000'); return { group: k.slice(0, i), id: k.slice(i + 1) }; };
    const missing = [];
    const added = [];
    for (const [k, n] of base) for (let i = (cur.get(k) || 0); i < n; i += 1) missing.push(split(k));
    for (const [k, n] of cur) for (let i = (base.get(k) || 0); i < n; i += 1) added.push(split(k));
    const disp = new Map();
    for (const d of dispositions || []) { if (!disp.get(key(d))) disp.set(key(d), effList.destOf(d)); } // 只认非空字符串，null / 数字 / 对象当空（不做 String() 转换）；累计去向表同一编号可有多行，任一行有非空去向即算有
    const disposed = [];
    const undisposed = [];
    for (const m of missing) { const d = disp.get(key(m)); if (d) disposed.push({ ...m, 去向: d }); else undisposed.push({ ...m, reason: disp.has(key(m)) ? '去向为空' : '没有去向记录' }); }
    const missingKeys = new Set(missing.map(key));
    const unusedDispositions = (dispositions || []).filter((d) => !missingKeys.has(key(d))).map((d) => ({ group: d.group, id: d.id }));
    return { missing, added, disposed, undisposed, unusedDispositions, ok: undisposed.length === 0 };
}

// 第 ① 步（闸门）带 --effective 时（R1，codex 81 HIGH-2；84 MEDIUM / 85 HIGH-2 改按 <S> 时登记）：生效清单过 schema 校验（编号须在 <S> 时登记 / 当前登记里、类别枚举、by 非空且不含被删编号自身、重复编号拒绝），
//   并核：retire 的编号确已从当前登记里消失、by / remount 新编号确已登记、<S> 时登记里消失的编号都在 retire 里、当前登记 − <S> 时登记 = added ∪ remount newId、去向表里 retire 的每个旧编号恰好一行且带对应处置类别与字段。
//   sList / cur：[{ group, id, … }]（<S> 时登记 / 当前登记）；返回 { problems, summary }。承接变异是否真被执行、真被抓住由 build-mutation-baseline.js 的第 ②③ 步核（本脚本不跑用例）。
function effectiveProblems(effRead, sList, cur, dispositions, groups, repo, since, changedInfo) {
    const keyOf = (x) => x.group + '\u0000' + x.id;
    const v = effList.validateEffective(effRead.doc, { groups, sKeys: new Set(sList.map(keyOf)), currentKeys: new Set(cur.map(keyOf)) });
    if (!v.eff) return { problems: v.problems, summary: '清单没有通过校验' };
    // 全空清单（只靠 reason）的适用范围：改动集含产品 / 测试路径 → 拒（effective-list.js emptyListScopeProblems）。只有全空清单才需要读改动集（changedInfo = { list, error }，main 已读好；没给就这里读）
    const emptyList = !v.eff.mustRun.length && !v.eff.retire.length && !v.eff.added.length;
    let scope = [];
    if (emptyList) {
        const ci = changedInfo || (() => { try { return { list: Array.from(effList.changedPathsSince(repo, since)), error: null }; } catch (e) { return { list: null, error: e.message }; } })();
        scope = ci.list === null ? ['全空清单的适用范围核对读不到改动集：' + ci.error] : effList.emptyListScopeProblems(v.eff, ci.list);
    }
    const cat = (c) => v.eff.retire.filter((r) => r.category === c).length;
    // 第 ① 步不核「承接命中证据」（还没有当次复验日志）：requireEvidence = false；第 ③ 步强制（build-mutation-baseline.js effectiveGateProblems）
    return { problems: [...effList.retireDispositionProblems(v.eff, dispositions, { requireEvidence: false }), ...scope], summary: `commit ${v.eff.commit}；mustRun ${v.eff.mustRun.length}、retire ${v.eff.retire.length}（stop-only ${cat('stop-only')} / remount ${cat('remount')} / equivalent ${cat('equivalent')}）${v.eff.reason ? `；reason ${JSON.stringify(v.eff.reason)}` : ''}` };
}
// 第 ① 步带 --effective-none 时：<S> 时登记 = 当前登记（没有增删），改动集全部在 --effective-none 白名单内（effective-list.js noneModeProblems）。changedPaths：改动路径数组。
function noneProblems(sList, cur, changedPaths) {
    const keyOf = (x) => x.group + '\u0000' + x.id;
    return effList.noneModeProblems(new Set(sList.map(keyOf)), new Set(cur.map(keyOf)), changedPaths);
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────────────
function run(repo, groups) {
    const all = [];
    const groupInfo = {};
    const loadErrors = [];
    const cases = {};
    for (const g of groups) {
        try {
            const reg = loadRegistry(g, repo);
            const entries = normalizeGroup(g, reg.raw);
            all.push(...entries);
            groupInfo[g] = { count: entries.length, source: reg.source };
        } catch (e) { loadErrors.push({ group: g, error: e.message }); groupInfo[g] = { count: 0, source: null, error: e.message }; }
        try {
            cases[g] = loadCases(g, repo);
            const dyn = cases[g].names.filter((n) => typeof n !== 'string').length;
            groupInfo[g].caseNames = { mode: cases[g].mode, count: cases[g].names.length, dynamicPatterns: dyn, unresolvedCalls: cases[g].names.skipped || 0, note: cases[g].note || null };
        } catch (e) {
            loadErrors.push({ group: g, error: '用例名清单读取失败：' + e.message });
            cases[g] = { mode: 'none', names: [], match: GROUP_DEFS[g].match };
        }
    }
    // 驱动复制范围（读不到就不核对应项，记读取失败）
    const extra = { copyLists: { api: null, attachments: null } };
    const tryLoad = (label, fn) => { try { fn(); } catch (e) { loadErrors.push({ group: label, error: '核对辅助信息读取失败：' + e.message }); } };
    if (groups.includes('api')) tryLoad('api', () => { extra.copyLists.api = requireQuiet(P(repo, 'wbs-server/scripts/lib/sysbuild-api-suite.js')).COPIED_MODULE_FILES; if (!Array.isArray(extra.copyLists.api)) throw new Error('COPIED_MODULE_FILES 不是数组'); });
    if (groups.includes('attachments')) tryLoad('attachments', () => { extra.copyLists.attachments = fs.readdirSync(P(repo, ROUTES), { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.js') && d.name !== 'index.js').map((d) => d.name); });
    const ctx = makeCtx(repo, cases, extra);
    const results = all.map((e) => checkEntry(e, ctx));
    const dups = findDuplicates(all);
    return { entries: all, results, groupInfo, loadErrors, dups, cases };
}
// 只读十组登记的编号（不核目标文件 / 用例名）：<S> 时登记（effective-list.js registryAtCommit）在 <S> 提交的内容上跑本函数。
//   任一组读不到、id 不是字面量、展开项、组内重复 id 都记问题——调用方（--ids-only）有问题就不写输出，绝不返回残缺登记。
function idsOfRegistry(repo) {
    const ids = [];
    const problems = [];
    const seen = new Set();
    for (const g of ALL_GROUPS) {
        try {
            const reg = loadRegistry(g, repo);
            for (const e of normalizeGroup(g, reg.raw)) {
                if (e.spread) { problems.push(`[${g}#${e.index}] 登记里有展开项（...），元素取不到`); continue; }
                if (e.id === NON) { problems.push(`[${g}#${e.index}] id 不是字面量`); continue; }
                const k = g + '\u0000' + e.id;
                if (seen.has(k)) { problems.push(`[${g}] 重复 id ${JSON.stringify(e.id)}`); continue; }
                seen.add(k);
                ids.push({ group: g, id: e.id });
            }
        } catch (e) { problems.push(`[${g}] 读取失败：${e.message}`); }
    }
    return { ids, problems };
}
function summarize(runResult) {
    const per = {};
    for (const g of Object.keys(runResult.groupInfo)) per[g] = { count: runResult.groupInfo[g].count, failed: 0, viaPattern: 0 };
    for (const r of runResult.results) {
        if (!r.ok) per[r.group].failed += 1;
        // 经动态名模式（'V' + 动态 + '…'）放行的条数：这种放行是宽松匹配，单列出来供人看
        if (r.caseCheck && r.caseCheck.results.some((x) => x.viaPattern > 0)) per[r.group].viaPattern += 1;
    }
    return per;
}
function printSummary(rr, verbose, out) {
    const per = summarize(rr);
    let total = 0;
    let failed = 0;
    let via = 0;
    for (const g of Object.keys(per)) {
        const gi = rr.groupInfo[g];
        total += per[g].count;
        failed += per[g].failed;
        via += per[g].viaPattern;
        out(`组 ${g.padEnd(11)} ${String(per[g].count).padStart(4)} 条；不通过 ${per[g].failed}；经动态名模式放行 ${per[g].viaPattern}；登记来源 ${gi.source || '失败'}；用例名取法 ${gi.caseNames ? gi.caseNames.mode + '（' + gi.caseNames.count + ' 个' + (GROUP_DEFS[g].match === 'rule' ? '规则' : '名字') + (gi.caseNames.dynamicPatterns ? '，其中含动态片段的 ' + gi.caseNames.dynamicPatterns + ' 个' : '') + (gi.caseNames.unresolvedCalls ? '，首参取不出静态片段而未收 ' + gi.caseNames.unresolvedCalls + ' 处' : '') + '）' : 'n/a'}${gi.caseNames && gi.caseNames.note ? '；' + gi.caseNames.note : ''}`);
    }
    out(`合计 ${total} 条；不通过 ${failed}；经动态名模式放行（宽松匹配，供人复核）${via} 条；组内重复 id ${rr.dups.length}；读取失败 ${rr.loadErrors.length}`);
    for (const e of rr.loadErrors) out(`  读取失败 [${e.group}] ${e.error}`);
    for (const d of rr.dups) out(`  重复 id [${d.group}] ${JSON.stringify(d.id)}（登记下标 ${d.indexes.join(',')}）`);
    for (const r of rr.results) {
        if (!r.ok) out(`  不通过 [${r.group}#${r.index}] ${r.id} — ${r.problems.join('；') || '见明细'}`);
        else if (verbose) out(`  通过   [${r.group}#${r.index}] ${r.id} — 文件 ${r.files.join(',') || '(无)'}；命中 ${r.edits.map((x) => (x.hits === null ? x.op : x.hits)).join('/')}；用例 ${r.caseCheck.mode}`);
    }
    return { total, failed };
}
function printBaseline(cmp, out) {
    out(`基线对比：基线有、现在没有 ${cmp.missing.length}（已登记去向 ${cmp.disposed.length}，未登记 ${cmp.undisposed.length}）；现在有、基线没有 ${cmp.added.length}；去向表里没用上的登记 ${cmp.unusedDispositions.length}`);
    for (const m of cmp.undisposed) out(`  缺失且无去向 [${m.group}] ${JSON.stringify(m.id)}（${m.reason}）`);
    for (const m of cmp.disposed) out(`  缺失已登记 [${m.group}] ${JSON.stringify(m.id)} → ${m.去向}`);
    for (const m of cmp.added) out(`  新增 [${m.group}] ${JSON.stringify(m.id)}`);
    for (const m of cmp.unusedDispositions) out(`  去向表里的登记没对上任何缺失项（可能该变异仍在）[${m.group}] ${JSON.stringify(m.id)}`);
}

const HELP_TEXT = [
    '#212 变异登记核对（C1b，只读）。每个提交的固定命令序列（<FIX> = wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json；<S> = 完整 40 位提交号，正式闸门下只许是 HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（三步在提交之后补跑）；<DISP> = 累计去向表 json）：',
    '  ① node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective <EFF>      编号不丢（提交闸门；只核编号，不比较失败位置；--baseline 直接收机器基线）',
    '     node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective-none "<理由>"      没有生效变异的提交（只许改工具 / 文档）；<理由> 就是 --effective-none 的参数本身',
    '     --baseline 是闸门：必须同时给 --changed-since <S>，且 --effective 与 --effective-none 二选一（两个都不给 = 拒绝）；不能与 --groups 同用（集合级核对要十组全看）。',
    '     <S> 的校验（三步同口径）：完整 40 位小写十六进制、git cat-file -t 为 commit（树对象 / 非提交拒）、是 HEAD 的祖先，且正式闸门下必须是 HEAD 本身或 HEAD 的第一父提交（更早的祖先拒：前一提交新增、本次删除的编号两端都不存在，清单会漏掉本次退役）；累计查询（build-mutation-baseline.js --affected … --cumulative、不带清单的 --affected）仍收任意祖先。',
    '     运行的脚本必须位于 --repo 内（三步命令在本线仓库根运行；从另一个检出里的脚本去审 --repo 指定的仓库 = 用法错误，读取器与依赖来自别处，名单核对不到）。',
    '     自检钩子不是命令行参数：--s-registry-file 命令行给了就是用法错误（退出码 2），--self-test 与任何正式参数同给也是用法错误；<S> 时登记一律由 registryAtCommit 在 <S> 的内容上读。',
    '     读取器漂移硬门：改动集（<S>..HEAD + 未提交 + 未跟踪）含读取器链路的文件（mutation-check.js、effective-list.js、各层 package.json / package-lock.json：读 <S> 时从当前检出加载的）时，<S> 时登记不可自动信任；不给 --s-registry-attest = 拒绝；只改套件 / 驱动 / 产品文件不触发（只有改了工具读取器或依赖清单的提交需要 attest）。',
    '        给了 --s-registry-attest "<理由>"（解析时统一 trim、空白 = 用法错误；三步同一份理由）：工具自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only）读一遍 <S> 时登记——',
    '        两份编号集合全等 → 记录理由继续；不同、或新版读取器读不了 → 增删核对以旧版读取器读出的编号集合为准（新版结果只打印对照）；<S> 树没有可用的 --ids-only 入口（旧版读取器读不了），或新旧读取器都读不了 → 一律拒绝（「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」）。',
    '        依赖漂移的限度：只改依赖清单时，<S> 树的读取器与当前读取器共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住。',
    '     C1–C9 保持线性历史：线分支同步 main 用 rebase 且只在 C9 之后；正式闸门拒绝进行中的合并（MERGE_HEAD 存在）、HEAD 是合并提交（有多个父提交；<S> = HEAD 与 <S> = HEAD 的第一父提交都拒）、<S> 本身是合并提交（补跑 <S> = HEAD^ = M、HEAD 为 M 之后的单父提交）；更早的合并提交闸门看不到，只能由 C9 链核对拦；三步共用一处。',
    '     <S> = HEAD 的第一父提交（提交之后补跑）时另要求工作区干净：扣掉复验目录 / --dispositions / --report 这些声明的补写产物后，不许再有未提交 / 未跟踪的路径，有就是用法错误（「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」；三步共用一处）；--effective / 基线若被 HEAD 跟踪，工作区与暂存区内容都须与 HEAD 一致才豁免（没被 HEAD 跟踪的独立输入照旧豁免）。',
    '        所用编号摘要（sha256 / 条数 / 来源）打印在输出里，第 ②③ 步写进 meta / rerun.json / empty-plan.json 并核同一份。',
    '     去向表口径：<DISP> 是一份跨提交累计的文件（C2、C3… 逐提交追加；本提交的行带在表里），每一行（含普通三字段行；--effective-none 分支同样核）必带非空「提交」字段（如 "C2"，与该提交生效清单的 commit 对应）。退役类核对只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等，其他提交的退役行忽略；',
    '        「变了 / 需人工复核」的三字段登记（第 ③ 步）可引用任何提交的行，命中证据必须与当次失败对得上：前序提交登记过、本次失败没再变化的沿用旧行，失败再次变化的须补新行（旧行证据对不上就拒）；本提交新增 / 改挂的编号只接受「提交」= 本次的行，其余沿用历史行以该编号最后一条退役行为界。独立查询（--query-baseline）保留旧表兼容。',
    '     第 ① 步对 equivalent 只核编号、类别、承接关系与已有依据（等价业务错误）；「承接命中证据」要对当次复验日志，第 ③ 步才强制，第 ① 步不核。',
    '     <EFF> = 本提交的生效清单 json（mustRun / retire / added；retire 的每条带处置类别 stop-only / remount / equivalent；added = 本提交新增、<S> 时没有的变异；schema 见 effective-list.js 头注释）。',
    '     编号增删按 <S> 时登记核对（在 <S> 提交的内容上真跑登记读取函数，不 checkout；十组全看，不能与 --groups 同用）：<S> 时登记 − 当前登记 = retire；当前登记 − <S> 时登记 = added ∪ 全部 remount newId（多一条少一条都拒）；',
    '     再核 by / remount 新编号确已登记、去向表里 retire 的每个旧编号恰好一行且带对应处置类别与字段。一个新编号同时是 remount 的 newId 与 equivalent 的 by 时，只在改挂项里声明（不要再写进 added），by 照常引用。',
    '     --effective-none 时 <S> 时登记必须 = 当前登记，且改动集（<S>..HEAD + 未提交 + 未跟踪）全部落在工具 / 文档白名单内（wbs-server/scripts/sysbuild-step1/**、docs/**、仓库根目录的 *.md）；产品代码、测试驱动与套件、fixtures 的改动不许用它，须给生效清单。',
    '     mustRun / retire / added 全空的清单必须带非空 "reason" 字段（例如只改 .gitignore 的提交），且只许用于改动集不含产品 / 测试路径的提交（PRODUCT_TEST_PATHS：routes / public / utils / server.js / wbs-server 根级文件与依赖清单 / verify-*.js / scripts/lib / sysbuild-predeploy / scripts/lines / deploy-ssh.ps1 / _test-fixture.js / fixtures）：涉及这些路径的提交——产品或测试路径下的全空清单一律拒，须至少一条经人确认的清单条目（mustRun / retire / added）。',
    '     固定基线只用于失败位置对比与需人工复核分类，不再参与增删全等；本步骤只打印基线累计差异供对照。',
    '     --query-baseline <FIX> [--dispositions <DISP>] [--groups …]：独立查询入口（不是提交闸门，不核生效清单与 <S> 时登记）：基线里有、现在没有的编号必须在去向表里登记，否则退出码 1。退出码 1 的情形：① 基线里消失的编号没有去向（缺去向 / 去向为空）；② 登记里有条目核对不通过（目标文件不存在 / 定位字面量不是恰好命中 1 次 / 用例名不在清单里等）；③ 组内有重复 id；④ 十组登记读取失败（含登记里的展开项与用例名清单读取失败）。用法错误 = 2。',
    '  ② node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --affected <FIX> --changed-since <S> [--affected-out <目录>]      先列受影响的条目（全部 / 其中需人工复核）；不加 --effective / --effective-none 时只列自动范围，加了按来源列完整复验集合',
    '     node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective <EFF> --dispositions <DISP> [--report <报告>]   再由本工具真跑（日志与 meta 都由它写，旧日志过不了闸门）：',
    '     node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective-none "<理由>" --dispositions <DISP> [--report <报告>]   没有生效清单的提交',
    '       复验集合 = 自动范围 ∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号 ∪ added（当前登记有、<S> 时登记没有的全部编号）；--effective 与 --effective-none "<理由>" 二选一，两个都不给 = 拒绝。',
    '       api 用 --mutation-ids 只跑复验集合里的编号（过滤模式）；其余各组驱动没有按编号只跑的参数，只能整组跑。',
    '       --raw-dir 在仓库里只许落在 tmp/ 下（或仓库之外）；第 ② 步传的 --dispositions（与第 ③ 步是同一个累计去向表路径）/ --report 只声明「复验之后才补写的产物路径」（不读取），第 ③ 步只认这份记录——仓库内的补写路径须第 ② 步预声明，没声明的仓库内产物在第 ③ 步被当作新增改动拒绝；--report 可选，不给就不能在仓库里写报告。',
    '       复验结束后按第 ③ 步同口径解析各组日志，把实际出现结果行的登记编号写进 rerun.json（format sysbuild-rerun/3：plannedIds 计划 / ranIds 实跑 / outOfPlanIds 整组实跑跑出的计划外编号），并带结束记录（complete、ignoredInputsEnd）；本工具的流程约束：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick，每个提交（含工具、文档提交）都要留第 ② 步复验目录（空计划也留），每份留档只覆盖一个提交。',
    '  ③ node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective <EFF>',
    '     node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective-none "<理由>"   没有生效清单的提交（理由与第 ② 步一致）',
    '     第 ③ 步要求改动集里每个路径在暂存区与工作区内容一致（先 git add 或撤销暂存），且与第 ② 步记录一致（放行的就是将要提交的内容）；非空复验的 rerun.json 结束记录必须在且匹配；<S> 时登记的编号摘要与第 ② 步记录一致。',
    '  十组全量失败位置比较只在 C1 与 C9 各跑一次（C9 累计范围用 build-mutation-baseline.js --affected … --cumulative，见其头注释）。其他参数见脚本头注释。',
].join('\n');
function parseArgs(argv) {
    const o = { help: false, repo: DEFAULT_REPO, groups: ALL_GROUPS.slice(), out: null, emitIds: null, baseline: null, queryBaseline: null, disposition: null, effective: null, effectiveNone: null, changedSince: null, sRegistryFile: null, sRegistryAttest: null, idsOnly: null, verbose: false, selfTest: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--self-test') o.selfTest = true;
        else if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--verbose') o.verbose = true;
        else if (['--repo', '--groups', '--out', '--emit-ids', '--baseline', '--query-baseline', '--disposition', '--dispositions', '--effective', '--effective-none', '--changed-since', '--s-registry-file', '--s-registry-attest', '--ids-only'].includes(a)) {
            if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(a + ' 需要一个参数');
            const v = argv[i + 1];
            i += 1;
            if (a === '--repo') o.repo = path.resolve(v);
            else if (a === '--groups') { o.groupsGiven = true; o.groups = v.split(',').map((s) => s.trim()).filter(Boolean); const bad = o.groups.filter((g) => !ALL_GROUPS.includes(g)); if (bad.length || o.groups.length === 0) throw new Error('--groups 含未知组：' + (bad.join(',') || '(空)') + '；可选 ' + ALL_GROUPS.join(',')); } else if (a === '--out') o.out = path.resolve(v);
            else if (a === '--emit-ids') o.emitIds = path.resolve(v);
            else if (a === '--baseline') o.baseline = path.resolve(v);
            else if (a === '--query-baseline') o.queryBaseline = path.resolve(v);
            else if (a === '--effective') o.effective = path.resolve(v);
            else if (a === '--effective-none') o.effectiveNone = v;
            else if (a === '--changed-since') o.changedSince = v;
            else if (a === '--s-registry-file') o.sRegistryFile = path.resolve(v);
            else if (a === '--s-registry-attest') o.sRegistryAttest = v.trim(); // 95 号 MEDIUM：参数解析时统一 trim，之后显示 / 持久化 / 比较全用这一个值（第 ②③ 步同）
            else if (a === '--ids-only') o.idsOnly = path.resolve(v);
            else o.disposition = path.resolve(v);
        } else throw new Error('未知参数 ' + a);
    }
    // 94 号 HIGH-1：<S> 时登记的替换是自检钩子，不是命令行参数——命令行给了一律拒（正式闸门的 <S> 时登记只由 registryAtCommit 在 <S> 的内容上读）；自检由 main(argv, hooks) 内部注入
    if (o.sRegistryFile) throw new Error('--s-registry-file 是自检钩子，不是命令行参数：只有 --self-test 内部调用 main(argv, hooks) 才能注入 <S> 时登记；正式闸门的 <S> 时登记一律由 registryAtCommit 在 <S> 的内容上读');
    // 94 号 HIGH-1：--self-test 不能与任何正式参数同给（旧版主流程在自检分支提前返回，正式闸门参数被悄悄忽略）
    if (o.selfTest && (o.baseline || o.queryBaseline || o.disposition || o.effective || o.effectiveNone !== null || o.changedSince || o.sRegistryAttest !== null || o.idsOnly || o.emitIds || o.out || o.groupsGiven)) throw new Error('--self-test 不能与正式参数（--baseline / --query-baseline / --dispositions / --effective / --effective-none / --changed-since / --s-registry-attest / --ids-only / --emit-ids / --out / --groups）同给');
    if (o.baseline && o.queryBaseline) throw new Error('--baseline（提交闸门）与 --query-baseline（独立查询）不能同时给');
    if (o.disposition && !o.baseline && !o.queryBaseline) throw new Error('--disposition / --dispositions 只能与 --baseline 或 --query-baseline 一起用');
    // 第 ① 步的闸门参数只属于 --baseline（84 号 MEDIUM-1）：--baseline 必须带 --changed-since 与 --effective / --effective-none 二选一；不加清单的独立查询入口改用 --query-baseline，不带闸门含义
    if ((o.effective || o.effectiveNone !== null || o.changedSince || o.sRegistryAttest !== null) && !o.baseline) throw new Error('--effective / --effective-none / --changed-since / --s-registry-attest 只能与 --baseline 一起用');
    if (o.sRegistryAttest !== null && o.sRegistryAttest === '') throw new Error('--s-registry-attest 的理由不能是空白');
    if (o.baseline) {
        if (!o.changedSince) throw new Error('--baseline（提交闸门）必须同时给 --changed-since <S>（上一提交的完整 40 位提交号；编号增删按 <S> 时登记核对）；不要生效清单的独立查询请用 --query-baseline');
        if (!/^[0-9a-f]{40}$/.test(o.changedSince)) throw new Error('--changed-since 只收完整 40 位小写十六进制提交号');
        if (o.effective && o.effectiveNone !== null) throw new Error('--effective 与 --effective-none 只能给一个');
        if (o.effectiveNone !== null && o.effectiveNone.trim() === '') throw new Error('--effective-none 的理由不能是空白');
        if (!o.effective && o.effectiveNone === null) throw new Error('--baseline（提交闸门）必须给 --effective <生效清单 json>，没有生效清单的提交给 --effective-none "<理由>"（两个都不给 = 拒绝）');
        // LOW-1：生效清单要对「<S> 时登记里消失的编号 = retire」「当前登记里新增的编号 = added ∪ newId」做集合级核对，只看部分组会漏掉别的组里的删除 / 新增，所以闸门一律十组全核
        if (o.groupsGiven) throw new Error('--baseline（提交闸门）要对十组全部核（<S> 时登记里消失 / 当前登记里新增的编号都要与生效清单全等，只看部分组会漏掉别的组里的删除与新增），不能与 --groups 同用');
    }
    if (o.idsOnly && (o.baseline || o.queryBaseline || o.emitIds || o.out)) throw new Error('--ids-only 是内部入口（读 <S> 时登记用），不能与其他输出 / 对比参数同用');
    return o;
}
// --baseline 既收 --emit-ids 写出的 [{ group, id, … }] 数组，也直接收 build-mutation-baseline.js 生成的机器基线（{ format: 'sysbuild-mutation-baseline/…', entries: [{ group, id, … }] }，取 entries）：
// 每个提交的固定命令序列第 ① 步直接对 fixtures 里的基线用（codex 79 HIGH-2）。其他形态原样返回，由调用方报用法错误。
function baselineIdList(x) {
    if (x && !Array.isArray(x) && typeof x.format === 'string' && /^sysbuild-mutation-baseline\//.test(x.format) && Array.isArray(x.entries)) return x.entries.map((e) => ({ group: e.group, id: e.id, files: e.files, expect: e.expect }));
    return x;
}
function readJson(file, what) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(what + ' 无法读取或不是 JSON：' + e.message); }
}
// hooks（只给自检内部用，命令行入口永远不传）：{ sRegistryList: [{ group, id }] } = 直接给 <S> 时登记（跳过 registryAtCommit 与读取器漂移硬门，那两项正是它替代的东西）。
function main(argv, hooks) {
    const hk = hooks || {};
    let o;
    try { o = parseArgs(argv); } catch (e) { console.error('用法错误：' + e.message); return 2; }
    if (o.help) { console.log(HELP_TEXT); return 0; }
    if (o.selfTest) return selfTest();
    if (o.idsOnly) {
        // 内部入口：effective-list.js registryAtCommit 在 <S> 提交的内容上起子进程跑它，只读十组登记的编号；有任何问题不写输出文件（不返回残缺登记）
        const r = idsOfRegistry(o.repo);
        if (r.problems.length) { for (const p of r.problems) console.error('读登记失败：' + p); return 1; }
        // loaded：本进程 require.cache 里的非 node_modules 模块（绝对路径）——registryAtCommit 据此报告「读 <S> 时从临时树之外加载了哪些文件」，自检拿它核对 READER_CHAIN 名单
        const loaded = Object.keys(require.cache).filter((k) => !/[\\/]node_modules[\\/]/.test(k));
        fs.writeFileSync(o.idsOnly, JSON.stringify({ format: 'sysbuild-registry-ids/1', ids: r.ids, loaded }, null, 2) + '\n');
        console.log(`登记编号 ${r.ids.length} 条已写入 ${o.idsOnly}`);
        return 0;
    }
    let baseline = null;
    let dispositions = [];
    let effRead = null;
    let sFileList = null;
    try {
        if (o.effective) effRead = effList.readEffectiveFile(o.effective);
        const bFile = o.baseline || o.queryBaseline;
        if (bFile) {
            baseline = baselineIdList(readJson(bFile, o.baseline ? '--baseline' : '--query-baseline'));
            if (!Array.isArray(baseline) || baseline.some((x) => !x || typeof x.group !== 'string' || typeof x.id !== 'string')) throw new Error((o.baseline ? '--baseline' : '--query-baseline') + ' 须为 [{ group, id, ... }] 数组');
            if (o.disposition) {
                dispositions = readJson(o.disposition, '--disposition');
                if (!Array.isArray(dispositions) || dispositions.some((x) => !x || typeof x.group !== 'string' || typeof x.id !== 'string')) throw new Error('--disposition 须为 [{ group, id, 去向 }] 数组');
            }
        }
        if (hk.sRegistryList !== undefined) {
            sFileList = hk.sRegistryList;
            if (!Array.isArray(sFileList) || sFileList.some((x) => !x || typeof x.group !== 'string' || typeof x.id !== 'string')) throw new Error('自检钩子 sRegistryList 须为 [{ group, id }] 数组');
        }
    } catch (e) { console.error('用法错误：' + e.message); return 2; }
    // 94 号 HIGH-2：<S> 的共用校验（文件模式 / 无清单模式都先过它；错误当用法错误，不继续核对）
    //   96 号 HIGH-1：正式闸门的 <S> 必须 = HEAD（提交之前跑）或 HEAD 的第一父提交（提交之后补跑）；96 号 MEDIUM：运行的脚本必须在 --repo 内（自检钩子 allowForeignTool 才放行跨检出）
    if (o.baseline) {
        try { effList.validateSinceCommit(o.repo, o.changedSince, undefined, { gate: true }); } catch (e) { console.error('用法错误：' + e.message); return 2; }
        const foreign = hk.allowForeignTool ? null : effList.foreignToolProblem(__dirname, o.repo);
        if (foreign) { console.error('用法错误：' + foreign); return 2; }
        // 预筛 MED-1：<S> = HEAD 的第一父提交（提交后补跑）时工作区须干净（去向表是声明的补写产物、整体豁免；生效清单与基线走 inputs：被 HEAD 跟踪时须与 HEAD 一致才豁免）；三步共用 effective-list.js postCommitDirtyProblem（自检钩子 skipCleanCheck 才放行）
        if (!hk.skipCleanCheck) {
            let dirty = null;
            // 98 号 MEDIUM：去向表是声明的补写产物（整体豁免）；基线与生效清单是决定「复验什么」的输入——被 HEAD 跟踪时须与 HEAD 一致才豁免（inputs）
            try { dirty = effList.postCommitDirtyProblem(o.repo, o.changedSince, { files: [o.disposition].map((f) => effList.repoRelPath(o.repo, f)).filter(Boolean), inputs: [o.effective, o.baseline].map((f) => effList.repoRelPath(o.repo, f)).filter(Boolean) }); } catch (e) { dirty = '读不到工作区状态：' + e.message; }
            if (dirty) { console.error('用法错误：' + dirty); return 2; }
        }
    }
    const rr = run(o.repo, o.groups);
    const line = (s) => console.log(s);
    const { failed } = printSummary(rr, o.verbose, line);
    let bad = failed > 0 || rr.dups.length > 0 || rr.loadErrors.length > 0;
    let cmp = null;
    if (baseline && o.queryBaseline) {
        // 独立查询入口：不是提交闸门（不核生效清单与 <S> 时登记）。退出码 1 的情形（94 号 LOW；bad 在上面按 failed / dups / loadErrors 置位，这里再加去向）：
        //   ① 基线里消失的编号没有去向（缺去向 / 去向为空，cmp.ok = false）；② 登记里有条目核对不通过（目标文件不存在 / 定位字面量不是恰好命中 1 次 / 用例名不在清单里等，failed > 0）；
        //   ③ 组内有重复 id（dups）；④ 十组登记读取失败，含登记里的展开项与用例名清单读取失败（loadErrors）。用法错误 = 2（parseArgs 抛错）。
        const cur = toIdList(rr.entries);
        line('独立查询（--query-baseline：不是提交闸门，不核生效清单与 <S> 时登记）：');
        cmp = compareBaseline(cur, baseline.filter((x) => o.groups.includes(x.group)), dispositions.filter((x) => o.groups.includes(x.group)));
        printBaseline(cmp, line);
        if (!cmp.ok) bad = true;
    } else if (baseline) {
        // 提交闸门（--baseline）：编号增删按 <S> 时登记核对；固定基线只打印累计差异供对照
        const cur = toIdList(rr.entries);
        const keyOf = (x) => x.group + '\u0000' + x.id;
        const bk = new Set(baseline.map(keyOf));
        const ck = new Set(cur.map(keyOf));
        line(`与固定基线的累计差异（只供对照，不判定；增删以 <S> 时登记为准）：基线有、现在没有 ${Array.from(bk).filter((k) => !ck.has(k)).length} 条；现在有、基线没有 ${Array.from(ck).filter((k) => !bk.has(k)).length} 条`);
        // 改动集只读一次（读取器漂移硬门、全空清单适用范围、--effective-none 白名单共用）；读不到 = 闸门不放行。
        //   自检钩子直接给登记且清单非空时不需要改动集（自检在干净检出里也能把 <S> 设成 HEAD）：那种情况不读
        const needChanged = !sFileList || !effRead || (!effRead.doc || !Array.isArray(effRead.doc.mustRun) || !Array.isArray(effRead.doc.retire) || (effRead.doc.mustRun.length === 0 && effRead.doc.retire.length === 0 && (!Array.isArray(effRead.doc.added) || effRead.doc.added.length === 0)));
        let changedInfo = { list: null, error: null };
        if (needChanged) {
            try { changedInfo = { list: Array.from(effList.changedPathsSince(o.repo, o.changedSince, { gate: true })), error: null }; } catch (e) { changedInfo = { list: null, error: e.message }; line('  改动集读取失败：' + e.message); bad = true; }
        }
        // <S> 时登记（94 号 HIGH-3 / 96 号 HIGH-3）：正式路径 = effective-list.js resolveSRegistry——读取器链路不在改动集里用当前读取器读；在改动集里且给了 --s-registry-attest 时，
        //   工具再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only）读一遍：两份全等 → 记录理由继续；不同 / 新版读不了 → 以旧版读取器的编号集合做增删核对，摘要（sha256 + 来源）打印，第 ②③ 步核同一份；
        //   自检钩子直接给登记，不经读取器。读不到改动集时没法判断读取器是否在改动里，闸门不放行（bad 已置位），只读当前读取器供其余核对继续打印
        let s = null;
        try {
            if (sFileList) s = { list: sFileList, source: '自检钩子（内部注入）', digest: effList.digestRecord(sFileList, '自检钩子（内部注入）') };
            else {
                const rs = effList.resolveSRegistry(o.repo, o.changedSince, { changedPaths: changedInfo.list || [], attest: o.sRegistryAttest });
                for (const p of rs.problems) line('  登记读取器漂移：' + p);
                if (rs.note) line('登记读取器漂移（人工声明）：' + rs.note);
                for (const l of rs.printed) line('  ' + l);
                if (rs.problems.length) bad = true;
                if (rs.list) s = { list: rs.list, source: `git ${o.changedSince}（${rs.fileCount} 个文件落地后读登记；跳过 docs/ ${rs.skipped.docs} 个、符号链接 ${rs.skipped.links.length} 个、子模块 ${rs.skipped.submodules.length} 个）`, digest: rs.digest };
            }
        } catch (e) { line('  <S> 时登记读取失败：' + e.message); s = null; bad = true; }
        if (s) line(`<S> 时登记摘要：sha256 ${s.digest.sha256}；${s.digest.count} 条；来源 ${s.digest.source}（第 ②③ 步核同一份摘要）`);
        // 96 号 MEDIUM：累计去向表每一行都须带非空「提交」（正式闸门两种清单模式共用；独立查询保留旧表兼容）
        for (const p of effList.dispositionTableProblems(dispositions, { skipRetireRows: !!effRead })) { line('  去向表不通过：' + p); bad = true; }
        if (s) {
            const sk = new Set(s.list.map(keyOf));
            line(`<S> 时登记：${s.list.length} 条（来源 ${s.source}）；当前登记 ${cur.length} 条；<S> 有、现在没有 ${s.list.filter((x) => !ck.has(keyOf(x))).length} 条；现在有、<S> 没有 ${cur.filter((x) => !sk.has(keyOf(x))).length} 条`);
            if (effRead) {
                const ep = effectiveProblems(effRead, s.list, cur, dispositions, ALL_GROUPS, o.repo, o.changedSince, changedInfo);
                line(`生效清单（R1）：sha256 ${effRead.sha256}；${ep.summary}；问题 ${ep.problems.length} 条`);
                for (const p of ep.problems) line('  生效清单不通过：' + p);
                if (ep.problems.length) bad = true;
            } else {
                const changed = changedInfo.list;
                const np = changed === null ? [] : noneProblems(s.list, cur, changed);
                line(`生效清单（R1）：--effective-none ${JSON.stringify(o.effectiveNone)}；改动路径 ${changed === null ? '读不到' : changed.length + ' 个'}；问题 ${np.length} 条`);
                for (const p of np) line('  生效清单不通过：' + p);
                if (np.length) bad = true;
            }
        }
    }
    if (o.emitIds) fs.writeFileSync(o.emitIds, JSON.stringify(toIdList(rr.entries), null, 2) + '\n');
    if (o.out) fs.writeFileSync(o.out, JSON.stringify({ repo: o.repo.replace(/\\/g, '/'), groups: rr.groupInfo, perGroup: summarize(rr), duplicates: rr.dups, loadErrors: rr.loadErrors, baseline: cmp, results: rr.results }, null, 2) + '\n');
    console.log(bad ? '结果：有不通过项' : '结果：全部通过');
    return bad ? 1 : 0;
}

// ── 自检 ───────────────────────────────────────────────────────────────────────────────
function removeTree(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory() && !e.isSymbolicLink()) removeTree(p); else fs.unlinkSync(p);
    }
    fs.rmdirSync(dir);
}
// 自检里起 node 子进程跑本脚本的统一入口：自检钩子（<S> 时登记）不走命令行，由这里把 args 里的 --s-registry-file <json> 摘出来，
//   改成「node -e 载入本脚本并调用 main(argv, hooks)」注入（94 号 HIGH-1）；没有钩子的调用原样走命令行。命令行入口本身永远收不到钩子。
const HOOK_RUNNER = "const fs=require('fs');const m=require(process.argv[1]);const h={allowForeignTool:true,skipCleanCheck:process.env.SYSBUILD_SELFTEST_CLEAN_CHECK!=='1'};if(process.argv[2]!=='-')h.sRegistryList=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));Promise.resolve(m.main(process.argv.slice(3),h)).then((c)=>{process.exitCode=c;});";
function selfSpawn(realSpawn, args, opts) {
    const rest = [];
    let sFile = null;
    let cleanCheck = false;
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--s-registry-file') { sFile = args[i + 1]; i += 1; } else if (args[i] === '--force-clean-check') cleanCheck = true; /* 自检专用记号：让钩子路径也核「提交后补跑要求工作区干净」（默认自检跳过，临时仓库里要造工作区改动） */ else rest.push(args[i]);
    }
    if (cleanCheck) opts = { ...(opts || {}), env: { ...process.env, SYSBUILD_SELFTEST_CLEAN_CHECK: '1' } };
    // 自检用 --repo 指向临时仓库而脚本在主检出里跑：这是跨检出调用，正式闸门会拒（96 号 MEDIUM）；自检里统一经钩子 allowForeignTool 放行（命令行没有这个参数），专门测跨检出拒绝的用例直接用真 spawnSync
    if (sFile === null && !rest.includes('--repo')) return realSpawn(process.execPath, [__filename, ...rest], opts);
    // 登记很大（十组 2000+ 条），经文件传给子进程（命令行长度有上限）；子进程里只是把它当 hooks.sRegistryList 交给 main，不是命令行参数
    return realSpawn(process.execPath, ['-e', HOOK_RUNNER, __filename, sFile === null ? '-' : sFile, ...rest], opts);
}
const realSpawnSync = spawnSync; // 模块级的真 spawnSync（selfTest 里同名的局部 spawnSync 会遮住它）
function selfTest() {
    // 自检内部的 spawnSync：「node + 本脚本」的调用经 selfSpawn（钩子注入），其余（git 等）原样
    const spawnSync = (cmd, args, opts) => (cmd === process.execPath && Array.isArray(args) && args[0] === __filename ? selfSpawn(realSpawnSync, args.slice(1), opts) : realSpawnSync(cmd, args, opts));
    let total = 0;
    let ok = 0;
    const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-mutcheck-'));
    try {
        const put = (rel, text) => { const abs = P(dir, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
        put(ROUTES + '/x.js', 'ANCHOR_ONE here\nDUP_ANCHOR a\nDUP_ANCHOR b\nline1\r\nline2\r\ntail\n');
        put(ROUTES + '/crlf.js', 'one\r\ntwo\r\n');
        put(ROUTES + '/index.js', 'ANCHOR_ONE in index\n');
        put('scripts/deploy-ssh.ps1', 'Write-Host one\r\nWrite-Host two\r\nUNIQ_PS\r\n');
        const cases = {
            api: { mode: 'require', names: ['用例甲：x', '用例乙：y'], match: 'prefix' },
            browser: { mode: 'static-scan', names: ['场景一', '场景二'], match: 'exact' },
            static: { mode: 'rules', names: ['S0', 'S1', 'S2'], match: 'rule' },
            db: { mode: 'none', names: [], match: 'none' },
            deploy: { mode: 'none', names: [], match: 'none' },
        };
        const ctx = makeCtx(dir, cases);
        const ent = (group, id, edits, expect, extra) => ({ group, index: 0, id, edits, expect, ...(extra || {}) });
        const rep = (file, from) => ({ op: 'replace', file: ROUTES + '/' + file, from });
        const chk = (e) => checkEntry(e, ctx);

        const good = chk(ent('api', '正例', [rep('x.js', 'ANCHOR_ONE')], ['用例甲']));
        check(good.ok && good.edits[0].hits === 1 && good.caseCheck.results[0].matched === 1 && good.files[0] === ROUTES + '/x.js', '正例：目标文件在、定位字面量恰好命中 1 次、用例前缀命中 1 条 → 通过');
        const noFile = chk(ent('api', '缺文件', [rep('nope.js', 'ANCHOR_ONE')], ['用例甲']));
        check(!noFile.ok && /^目标文件不存在/.test(noFile.edits[0].problem) && noFile.edits[0].hits === null, '目标文件缺失 → 不通过，且不报命中数');
        const zero = chk(ent('api', '零次', [rep('x.js', 'NOT_THERE')], ['用例甲']));
        check(!zero.ok && zero.edits[0].hits === 0 && /命中 0 次/.test(zero.problems.join('')), '定位字面量命中 0 次 → 不通过');
        const two = chk(ent('api', '两次', [rep('x.js', 'DUP_ANCHOR')], ['用例甲']));
        check(!two.ok && two.edits[0].hits === 2 && /命中 2 次/.test(two.problems.join('')), '定位字面量命中 2 次 → 不通过');
        const noCase = chk(ent('api', '用例没了', [rep('x.js', 'ANCHOR_ONE')], ['用例丙']));
        check(!noCase.ok && noCase.edits[0].ok && noCase.caseCheck.ok === false && noCase.caseCheck.results[0].matched === 0, '用例名不在清单里 → 不通过（锚点本身仍是 1 次）');
        const partial = chk(ent('api', '前缀其一缺', [rep('x.js', 'ANCHOR_ONE')], ['用例甲', '用例丙']));
        check(!partial.ok && partial.caseCheck.results[0].matched === 1 && partial.caseCheck.results[1].matched === 0, 'expect 多个前缀时每个都要命中，缺一个即不通过');
        const multi = chk(ent('api', '多处编辑一处坏', [rep('x.js', 'ANCHOR_ONE'), rep('x.js', 'DUP_ANCHOR')], ['用例甲']));
        check(!multi.ok && multi.edits[0].ok && !multi.edits[1].ok, '多处编辑：每处单独核对，一处命中 2 次整条不通过');
        const crlf = chk(ent('api', 'CRLF 归一', [rep('x.js', 'line1\nline2')], ['用例甲']));
        check(crlf.ok && crlf.edits[0].hits === 1, 'CRLF 文件按 LF 归一后计数（锚点里写 \\n 能命中 \\r\\n 的文件）');
        const dep = chk(ent('deploy', 'deploy 原文', [{ op: 'replace', file: 'scripts/deploy-ssh.ps1', from: 'UNIQ_PS' }], null));
        check(dep.ok && dep.edits[0].hits === 1 && dep.caseCheck.mode === 'n/a', 'deploy 组：没有 expect 的记 n/a，唯一命中通过');
        const depCrlf = chk(ent('deploy', 'deploy 不归一', [{ op: 'replace', file: 'scripts/deploy-ssh.ps1', from: 'Write-Host one\nWrite-Host two' }], null));
        check(!depCrlf.ok && depCrlf.edits[0].hits === 0, 'deploy 组不归一 CRLF（与 deploy 驱动口径一致）：锚点写 \\n 命中 0 次');
        const create = chk(ent('static', '合成文件', [{ op: 'create', file: ROUTES + '/zz.js', from: null }], ['S1']));
        check(create.ok && create.edits[0].note === '合成文件，没有定位字面量' && create.files.length === 0, 'create 类编辑（static 组）是合成文件：不核定位字面量，也不算目标文件');
        const rmGood = chk(ent('static', '删文件', [{ op: 'remove', file: ROUTES + '/x.js', from: null }], ['S1']));
        const rmBad = chk(ent('static', '删不存在的文件', [{ op: 'remove', file: ROUTES + '/zz_none.js', from: null }], ['S1']));
        check(rmGood.ok && !rmBad.ok, 'remove 类编辑（static 组）：目标文件在则通过、不在则不通过');
        // L-4(c)：create / remove 只有 static 组的驱动支持
        const cNon = chk(ent('api', 'api 组出现 create', [{ op: 'create', file: ROUTES + '/zz.js', from: null }], ['用例甲']));
        const rNon = chk(ent('schema', 'schema 组出现 remove', [{ op: 'remove', file: ROUTES + '/x.js', from: null }], ['用例甲']));
        check(!cNon.ok && !rNon.ok && /只有 static 组的驱动支持/.test(cNon.problems.join('') + rNon.problems.join('')), 'create / remove 出现在 static 以外的组 → 不通过（驱动不支持，变异不会生效）');
        // L-5：edits 为空
        const emptyEdits = chk(ent('api', '没有 edit', [], ['用例甲']));
        check(!emptyEdits.ok && /没有任何 edit/.test(emptyEdits.problems.join('')), '登记项 edits 为空 → 不通过（L-5）');
        // L-3：同一目标文件的多个 edit 按驱动顺序口径模拟（依次在已应用前面 edit 的文本上计数并替换）
        const seqMake = chk(ent('api', '前一个 edit 造出后一个锚点', [{ op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE', to: 'MADE_BY_FIRST' }, { op: 'replace', file: ROUTES + '/x.js', from: 'MADE_BY_FIRST', to: 'x' }], ['用例甲']));
        check(seqMake.ok && seqMake.edits[1].hits === 1, 'L-3：前一个 edit 造出后一个锚点（原文里没有）→ 按驱动顺序口径命中 1 次，通过');
        const seqKill = chk(ent('api', '前一个 edit 消掉后一个锚点的重复', [{ op: 'replace', file: ROUTES + '/x.js', from: 'DUP_ANCHOR a', to: 'REPLACED a' }, { op: 'replace', file: ROUTES + '/x.js', from: 'DUP_ANCHOR', to: 'y' }], ['用例甲']));
        check(seqKill.ok && seqKill.edits[1].hits === 1, 'L-3：前一个 edit 消掉后一个锚点的重复（原文里 DUP_ANCHOR 出现 2 次，应用第一条后剩 1 次）→ 通过');
        const seqGone = chk(ent('api', '前一个 edit 消掉后一个锚点', [{ op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE', to: 'gone' }, { op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE', to: 'y' }], ['用例甲']));
        check(!seqGone.ok && seqGone.edits[1].hits === 0, 'L-3：前一个 edit 把后一个锚点消掉 → 后一个命中 0 次，不通过（按原文计数会误判通过）');
        // L-4(a)：api 组 edit 的 file 必须在驱动复制的模块清单内
        const actx = makeCtx(dir, cases, { copyLists: { api: ['x.js'], attachments: ['x.js', 'crlf.js'] } });
        const apiIn = checkEntry(ent('api', '清单内', [rep('x.js', 'ANCHOR_ONE')], ['用例甲']), actx);
        const apiOut = checkEntry(ent('api', '清单外', [rep('crlf.js', 'one')], ['用例甲']), actx);
        check(apiIn.ok && !apiOut.ok && /COPIED_MODULE_FILES/.test(apiOut.problems.join('')), 'L-4(a)：api 组 edit 的 file 不在驱动复制的模块清单（COPIED_MODULE_FILES）→ 不通过');
        // L-4(b)：attachments 组只认登记项自带的 file（edit 里的 file 被忽略），且目标须在「routes/sysbuild 下 *.js 且排除 index.js」里
        const attOk = checkEntry(ent('attachments', 'att 清单内', [rep('x.js', 'ANCHOR_ONE')], null), actx);
        const attOut = checkEntry(ent('attachments', 'att 清单外（index.js）', [rep('index.js', 'ANCHOR_ONE')], null), actx);
        check(attOk.ok && !attOut.ok && /attachments 驱动复制的范围/.test(attOut.problems.join('')), 'L-4(b)：attachments 组目标不在「*.js 且排除 index.js」范围 → 不通过');
        const attNorm = normalizeGroup('attachments', [{ id: 'a', file: 'x.js', edits: [{ file: 'crlf.js', from: 'one', to: 'z' }] }]);
        check(attNorm[0].edits[0].file === ROUTES + '/x.js', 'L-4(b)：attachments 组忽略 edit 自带的 file（按登记项自带的 file 取目标），与驱动口径一致');
        const non = chk(ent('api', '非字面量', [rep('x.js', NON)], ['用例甲']));
        check(!non.ok && /不是字面量/.test(non.problems.join('')), '定位字面量是 <非字面量> → 不通过并列出该条');
        const noExpect = chk(ent('api', '没 expect', [rep('x.js', 'ANCHOR_ONE')], null));
        check(!noExpect.ok && /没有登记 expect/.test(noExpect.problems.join('')), 'api 组没有 expect → 不通过');
        const exact1 = chk(ent('browser', '浏览器精确', [rep('x.js', 'ANCHOR_ONE')], ['场景一']));
        const exact2 = chk(ent('browser', '浏览器只给前缀', [rep('x.js', 'ANCHOR_ONE')], ['场景']));
        check(exact1.ok && !exact2.ok, 'browser 组：场景名精确匹配（只写前缀「场景」不算登记）');
        const rule1 = chk(ent('static', '规则在', [rep('x.js', 'ANCHOR_ONE')], ['S1', 'S2']));
        const rule2 = chk(ent('static', '规则不在', [rep('x.js', 'ANCHOR_ONE')], ['S99']));
        check(rule1.ok && !rule2.ok && /规则不在清单里/.test(rule2.problems.join('')), 'static 组：rule（含 also）必须在规则清单里');
        const dbOk = chk(ent('db', 'db 无 expect', [rep('x.js', 'ANCHOR_ONE')], null));
        check(dbOk.ok && dbOk.caseCheck.mode === 'n/a', 'db 组：没有 expect 的记 n/a');

        // 组内重复 id
        const dupList = [ent('api', 'A', [], null), { ...ent('api', 'A', [], null), index: 1 }, ent('browser', 'A', [], null), ent('api', NON, [], null)];
        const dups = findDuplicates(dupList);
        check(dups.length === 1 && dups[0].group === 'api' && dups[0].id === 'A' && dups[0].indexes.join() === '0,1', '组内重复 id → 报出（跨组同名、非字面量 id 不算重复）');

        // 清单输出
        const ids = toIdList([ent('api', 'A', [rep('x.js', 'ANCHOR_ONE'), { op: 'create', file: ROUTES + '/zz.js', from: null }], ['用例甲'])]);
        check(JSON.stringify(ids) === JSON.stringify([{ group: 'api', id: 'A', files: [ROUTES + '/x.js'], expect: ['用例甲'] }]), '--emit-ids 清单：{ group, id, files（不含合成文件）, expect }');

        // 基线对比
        const base = [{ group: 'api', id: 'A' }, { group: 'api', id: 'B' }, { group: 'db', id: 'C' }];
        const cur = [{ group: 'api', id: 'A' }, { group: 'db', id: 'C' }, { group: 'db', id: 'D' }];
        const c1 = compareBaseline(cur, base, [{ group: 'api', id: 'B', 去向: '随旧流程删除，C3 提交' }]);
        check(c1.ok && c1.missing.length === 1 && c1.disposed.length === 1 && c1.disposed[0].去向 === '随旧流程删除，C3 提交' && c1.added.length === 1 && c1.added[0].id === 'D', '基线缺失但在去向表里 → 通过；现在有基线没有的只列出');
        const c2 = compareBaseline(cur, base, []);
        check(!c2.ok && c2.undisposed.length === 1 && c2.undisposed[0].id === 'B' && c2.undisposed[0].reason === '没有去向记录', '基线缺失且不在去向表里 → 不通过');
        const c3 = compareBaseline(cur, base, [{ group: 'api', id: 'B', 去向: '  ' }]);
        check(!c3.ok && c3.undisposed[0].reason === '去向为空', '去向表里登记了但去向为空 → 仍不通过');
        const c4 = compareBaseline(cur, base, [{ group: 'api', id: 'B', 去向: 'x' }, { group: 'api', id: 'A', 去向: '误登' }]);
        check(c4.ok && c4.unusedDispositions.length === 1 && c4.unusedDispositions[0].id === 'A', '去向表里没对上任何缺失项的登记（A 其实还在）→ 单列提示');
        const c5 = compareBaseline([{ group: 'api', id: 'A' }], [{ group: 'api', id: 'A' }, { group: 'api', id: 'A' }], []);
        check(!c5.ok && c5.missing.length === 1, '基线里同 id 出现两次、现在只剩一次 → 按次数算缺失');

        // 静态抽取与受限求值
        const regSrc = [
            "const pat = String.raw`\\r?\\n\\z`;",
            "const mutations = [",
            "  { id: 'a', from: 'x' + 'y', to: `t${pat}` },",
            "  { id: 'b', from: pat.replace(String.raw`\\r?\\n\\z`, String.raw`\\r?\\n?\\z`), to: 'z', expect: 'e', file: 'f.js' },",
            "  { id: 'c', from: dynamicThing(), to: 'q', edits: [{ from: 'k', to: 'l' }] },",
            "  ...others,",
            "];",
        ].join('\n');
        const reg = extractRegistry(regSrc, 'mutations');
        check(reg[0].id === 'a' && reg[0].from === 'xy' && reg[0].to === 't\\r?\\n\\z', '静态抽取：字符串相加、String.raw 模板与模板插值常量还原');
        check(reg[1].from === '\\r?\\n?\\z' && reg[1].expect === 'e' && reg[1].file === 'f.js', '静态抽取：.replace 常量表达式按原调用求值');
        check(reg[2].from === NON && reg[2].edits[0].from === 'k', '静态抽取：函数调用等求不出的值记为 <非字面量>，其余字段不受影响');
        check(reg[3].__spread === true, '静态抽取：展开项（...others）记为展开标记');
        const norm = normalizeGroup('deploy', reg.slice(0, 3));
        check(norm[0].edits[0].from === 'xy' && norm[2].edits[0].from === NON && norm[1].expect === null, '规范化：deploy 组的 expect 不当用例名核对（expect 为 null），非字面量保留');
        const names = scanCaseNames("test('甲：一', async () => {});\n(async () => { await test(`乙：二`, () => {}); })();\nother('丙', () => {});\nconst x = ['丁', async (page) => {}];\nconst y = ['戊', {}, '己'];", { callName: 'test' });
        const pairs = scanCaseNames("const x = ['丁', async (page) => {}];\nconst y = ['戊', {}, '己'];\nconst z = ['庚', function () {}];", { pairs: true });
        check(JSON.stringify(names) === JSON.stringify(['甲：一', '乙：二']) && JSON.stringify(pairs) === JSON.stringify(['丁', '庚']), '用例名静态扫描：test(...) 首参字面量；[名字, 函数] 数组对（第二项是对象的不算）');
        const cpairs = scanCaseNames("const FLOW = '流程名';\nfunction f() { return [[FLOW, async (page) => {}], ['直接', async () => {}], [unknownVar, async () => {}]]; }", { pairs: true });
        check(JSON.stringify(cpairs) === JSON.stringify(['流程名', '直接']) && cpairs.skipped === 1, '场景名静态扫描：[常量名, 函数] 里的常量按同文件顶层 const 字符串还原；解析不出的计入 skipped');
        const dyn = scanCaseNames("for (const v of list) test('V' + v.version + ' 历史指纹、空结构', async () => {});\ntest(`W${n} 模板名`, () => {});\ntest(someVar, () => {});", { callName: 'test' });
        check(dyn.length === 2 && dyn[0].pattern.length === 3 && dyn[0].text === 'V<动态> 历史指纹、空结构' && dyn[1].text === 'W<动态> 模板名' && dyn.skipped === 1, '用例名静态扫描：首参含动态片段（字符串相加 / 模板插值）记为模式，完全取不出静态片段的计入 skipped 而不收');
        const dctx = makeCtx(dir, { migration: { mode: 'static-scan', names: dyn, match: 'prefix' } });
        const dynOk = checkEntry(ent('migration', '动态名前缀', [{ op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE' }], ['V1 历史指纹']), dctx);
        const dynBad = checkEntry(ent('migration', '动态名前缀错', [{ op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE' }], ['X1 历史指纹']), dctx);
        check(dynOk.ok && dynOk.caseCheck.results[0].viaPattern === 1 && !dynBad.ok, '动态名前缀匹配：V1 历史指纹 能被 \'V\'+动态+\' 历史指纹…\' 接住（标注 viaPattern）；首字不同的不通过（动态片段按「任意文本」宽松匹配，是这种取法的固有近似）');
        check(patternMatch(['W', null, ' 模板名'], 'W9 模板名', true) && !patternMatch(['W', null, ' 模板名'], 'W9 模板', true) && patternMatch(['W', null, ' 模板名'], 'W9 模板', false), '模式匹配：全等 / 前缀两种口径各自成立');
        // M-4：动态段只吃 1–16 个非空白字符；前缀 expect 必须伸进动态段之后的静态片段
        const vPat = ['V', null, ' 历史指纹、空结构'];
        check(patternMatch(vPat, 'V1 历史指纹', false) && patternMatch(vPat, 'V12 历史指纹、空', false), 'M-4：V1 历史指纹 / V12 历史指纹、空 这类真实形态（动态段 + 伸进后面静态片段）→ 通过');
        check(!patternMatch(vPat, 'V1', false) && !patternMatch(vPat, 'V123', false) && !patternMatch(vPat, 'Vabc', false), 'M-4：V 开头但没伸进后面静态片段（V1 / V123 / Vabc 在动态段内结束）→ 不通过');
        check(!patternMatch(vPat, 'V1 2 3 历史指纹', false) && !patternMatch(vPat, 'V12345678901234567 历史指纹', false), 'M-4：动态段含空白、或超过 16 个字符 → 不通过');
        check(patternMatch(vPat, 'V', false) && patternMatch(['W', null], 'W99', true) && !patternMatch(['W', null], 'W', true), 'M-4：expect 恰在静态片段末尾结束（V）前缀口径通过；末尾动态段全等口径至少吃 1 个字符');
        const viaCtx = makeCtx(dir, { migration: { mode: 'static-scan', names: [{ pattern: vPat, text: 'V<动态> 历史指纹、空结构' }, '普通名：甲'], match: 'prefix' } });
        const viaRows = ['V1 历史指纹', '普通名：甲'].map((ex) => checkEntry(ent('migration', ex, [{ op: 'replace', file: ROUTES + '/x.js', from: 'ANCHOR_ONE' }], [ex]), viaCtx));
        check(viaRows[0].ok && viaRows[0].caseCheck.results[0].viaPattern === 1 && viaRows[1].ok && viaRows[1].caseCheck.results[0].viaPattern === undefined, 'M-4：经模式放行的条目标 viaPattern，字面量名放行的不标（汇总里据此单列）');
        const sumFake = summarize({ groupInfo: { migration: { count: 2 } }, results: viaRows });
        check(sumFake.migration.viaPattern === 1 && sumFake.migration.count === 2, 'M-4：summarize 单列经动态名模式放行的条数');

        // browser expectFailure / deploy 失败标签不在本脚本核对（MED-1）：规范化后不带这两个字段
        const bNorm = normalizeGroup('browser', [{ id: 'b', file: 'f.js', from: 'a', to: 'b', expect: '场景一', expectFailure: '[x]' }]);
        const dNorm = normalizeGroup('deploy', [{ id: 'd', from: 'a', to: 'b', expect: 'flow:x' }]);
        check(bNorm[0].failureText === undefined && dNorm[0].failureLabel === undefined && bNorm[0].expect[0] === '场景一', 'browser 的 expectFailure、deploy 的失败标签不进核对（规范化不带这两个字段；场景名 expect 照核）');

        // 命令行（真实仓库，只取最轻的 migration 组；断言只看相对关系，不依赖真实仓库是否全绿）
        const cli = (args) => spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 120000 });
        const idsFile = path.join(dir, 'ids.json');
        const r1 = cli(['--groups', 'migration', '--emit-ids', idsFile]);
        const emitted = fs.existsSync(idsFile) ? JSON.parse(fs.readFileSync(idsFile, 'utf8')) : [];
        check(Array.isArray(emitted) && emitted.length > 0 && emitted.every((x) => x.group === 'migration' && typeof x.id === 'string' && Array.isArray(x.files)) && /组 migration/.test(r1.stdout), 'CLI --emit-ids：写出清单，每项带 group / id / files');
        const withFake = emitted.concat([{ group: 'migration', id: '不存在的变异-自检用' }]);
        const baseFile = path.join(dir, 'base.json');
        fs.writeFileSync(baseFile, JSON.stringify(withFake));
        // 84 号 MEDIUM-1：不带清单的独立查询入口改名 --query-baseline（不是提交闸门）；--baseline 变成必须带 --changed-since 与 --effective / --effective-none 的闸门
        const r2 = cli(['--groups', 'migration', '--query-baseline', baseFile]);
        check(r2.status === 1 && /独立查询（--query-baseline：不是提交闸门/.test(r2.stdout) && /缺失且无去向 \[migration\] "不存在的变异-自检用"/.test(r2.stdout), 'CLI --query-baseline（独立查询，不是提交闸门）：基线里多出的 id 未登记去向 → 退出码 1 并列出该 id');
        const dispFile = path.join(dir, 'disp.json');
        fs.writeFileSync(dispFile, JSON.stringify([{ group: 'migration', id: '不存在的变异-自检用', 去向: '自检用' }]));
        const r3 = cli(['--groups', 'migration', '--query-baseline', baseFile, '--disposition', dispFile]);
        check(/缺失已登记 \[migration\] "不存在的变异-自检用" → 自检用/.test(r3.stdout) && !/缺失且无去向/.test(r3.stdout), 'CLI --disposition：登记过去向的缺失项不再计入失败');
        const r4 = cli(['--query-baseline']);
        check(r4.status === 2, 'CLI：--query-baseline 缺参数是用法错误（退出码 2）');
        // codex 79 HIGH-2：--query-baseline / --baseline 直接收机器基线（{ format, entries }），--dispositions 与 --disposition 同义，--help 打印固定命令序列
        const machineFile = path.join(dir, 'machine-baseline.json');
        fs.writeFileSync(machineFile, JSON.stringify({ format: 'sysbuild-mutation-baseline/2', entries: withFake.map((x) => ({ ...x, verdict: '判红', failures: [] })) }));
        const m1 = cli(['--groups', 'migration', '--query-baseline', machineFile]);
        const m2 = cli(['--groups', 'migration', '--query-baseline', machineFile, '--dispositions', dispFile]);
        check(m1.status === 1 && /缺失且无去向 \[migration\] "不存在的变异-自检用"/.test(m1.stdout) && m2.status === 0 && /缺失已登记 \[migration\] "不存在的变异-自检用" → 自检用/.test(m2.stdout), 'CLI --query-baseline 收机器基线（{ format, entries }，取 entries）：缺失编号无去向 → 退出码 1；--dispositions 登记后 → 0');
        // 去向字段只认非空字符串（84 号 LOW-2）：null / 数字 / 对象不再被 String() 转成「非空」
        const dispBadTypes = [null, 7, { x: 1 }, ['a']].map((v) => compareBaseline([{ group: 'api', id: 'A' }], [{ group: 'api', id: 'A' }, { group: 'api', id: 'B' }], [{ group: 'api', id: 'B', 去向: v }]));
        check(dispBadTypes.every((c) => !c.ok && c.undisposed.length === 1 && c.undisposed[0].reason === '去向为空'), '去向字段（独立查询）只认非空字符串：null / 数字 / 对象 / 数组都当空（不做 String() 转换）→ 仍不通过');
        const h1 = cli(['--help']);
        check(h1.status === 0 && /--baseline <FIX> --changed-since <S> --dispositions <DISP> --effective <EFF>/.test(h1.stdout) && /--baseline <FIX> --changed-since <S> --dispositions <DISP> --effective-none "<理由>"/.test(h1.stdout) && /--rerun --raw-dir <tmp\/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective-none "<理由>" --dispositions <DISP> \[--report <报告>\]/.test(h1.stdout) && !/本次去向表/.test(h1.stdout) && /累计去向表 json/.test(h1.stdout) && /退出码 1 的情形：① 基线里消失的编号没有去向[^\n]*③ 组内有重复 id；④ 十组登记读取失败/.test(h1.stdout) && /产品或测试路径下的全空清单一律拒/.test(h1.stdout) && /共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住/.test(h1.stdout) && !/不退回/.test(h1.stdout) && /提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD/.test(h1.stdout) && /--mutation-ids 只跑复验集合里的编号/.test(h1.stdout) && /--require-review-dispositions --changed-since <S> --effective <EFF>/.test(h1.stdout) && /--parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP>/.test(h1.stdout) && /--effective-none "<理由>"/.test(h1.stdout), 'CLI --help：三步固定命令序列都带去向表参数（①②③，①③ 带 --dispositions <DISP> 与 --effective <EFF>；没有生效清单用 --effective-none）');
        check(/mustRun \/ retire \/ added/.test(h1.stdout) && /不加 --effective \/ --effective-none 时只列自动范围/.test(h1.stdout) && !/不含生效清单/.test(h1.stdout) && /∪ added（当前登记有、<S> 时登记没有的全部编号）/.test(h1.stdout) && /当前登记 − <S> 时登记 = added ∪ 全部 remount newId/.test(h1.stdout) && /--query-baseline <FIX> \[--dispositions <DISP>\] \[--groups …\]：独立查询入口（不是提交闸门/.test(h1.stdout) && /只在改挂项里声明/.test(h1.stdout) && /工具 \/ 文档白名单/.test(h1.stdout) && /固定基线只用于失败位置对比与需人工复核分类，不再参与增删全等/.test(h1.stdout), 'CLI --help（LOW-2 / 84 号）：生效清单含 added、--affected 句只列自动范围、复验集合补 added（以 <S> 时登记为准）、集合核对写明、独立查询入口说明、改挂 newId 与承接的声明规则、--effective-none 白名单、固定基线只用于失败位置对比');

        // R1（codex 81 HIGH-2）：第 ① 步带 --effective——清单 schema、retire 的编号确已从登记里消失、基线里消失的编号都在 retire 里、by / remount 新编号确已登记、去向行带处置类别
        // LOW-1：带 --effective 不能与 --groups 同用，所以这一段对十组全跑：基线 = 当前十组全部登记 + 一个假编号（migration 组）
        const allIdsFile = path.join(dir, 'ids-all.json');
        const rAll = cli(['--emit-ids', allIdsFile]);
        const emittedAll = fs.existsSync(allIdsFile) ? JSON.parse(fs.readFileSync(allIdsFile, 'utf8')) : [];
        const FAKE = '不存在的变异-自检用';
        const baseAllFile = path.join(dir, 'base-all.json');
        fs.writeFileSync(baseAllFile, JSON.stringify(emittedAll.concat([{ group: 'migration', id: FAKE }])));
        check(emittedAll.length > 10 && new Set(emittedAll.map((x) => x.group)).size === ALL_GROUPS.length && rAll.status !== null, 'R1 CLI 准备：不带 --groups 写出十组全部登记（含十个组），作为 --effective 自检的基线');
        const refA = { group: emittedAll[0].group, id: emittedAll[0].id };
        const refB = { group: emittedAll[1].group, id: emittedAll[1].id };
        const refC = { group: emittedAll[2].group, id: emittedAll[2].id };
        const realB = refB.id;
        const EF = (over) => ({ format: 'sysbuild-effective-list/1', commit: 'C2', mustRun: [refA], retire: [{ group: 'migration', id: FAKE, category: 'stop-only' }], ...(over || {}) });
        const wrEff = (name, d) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(d)); return f; };
        const dispStop = path.join(dir, 'disp-stop.json');
        fs.writeFileSync(dispStop, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '自检用', 处置类别: 'stop-only', 删除依据: '自检用的假编号' }]));
        // 84 号 MEDIUM：--baseline 是提交闸门——必须带 --changed-since <S> 与 --effective / --effective-none；编号增删按 <S> 时登记核对。自检钩子 --s-registry-file 直接给 <S> 时登记（这里 = 基线文件：当前十组登记 + 假编号）
        const headSha = spawnSync('git', ['-C', DEFAULT_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        const prevSha = spawnSync('git', ['-C', DEFAULT_REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
        const gateCli = (sFile, extra) => cli(['--baseline', baseAllFile, '--changed-since', headSha, '--s-registry-file', sFile, ...extra]); // 这里的 cli 是 selfTest 里的 spawnSync 包装：--s-registry-file 由 selfSpawn 摘出、经 main(argv, hooks) 注入，不是真的命令行参数
        const e1 = gateCli(baseAllFile, ['--disposition', dispStop, '--effective', wrEff('eff1.json', EF())]);
        check(e1.status === 0 && /生效清单（R1）：sha256 [0-9a-f]{64}；commit C2；mustRun 1、retire 1（stop-only 1 \/ remount 0 \/ equivalent 0）；问题 0 条/.test(e1.stdout) && /与固定基线的累计差异（只供对照，不判定；增删以 <S> 时登记为准）：基线有、现在没有 1 条；现在有、基线没有 0 条/.test(e1.stdout) && /<S> 时登记：\d+ 条（来源 自检钩子（内部注入）/.test(e1.stdout), 'R1 CLI --effective 正例：清单合法、假编号 <S> 时有、现在已从登记里消失且在 retire 里、去向行带处置类别与删除依据 → 退出码 0；打印基线累计差异与 <S> 时登记摘要');
        const e2 = gateCli(baseAllFile, ['--disposition', dispFile, '--effective', wrEff('eff2.json', EF())]);
        check(e2.status === 1 && /生效清单不通过：retire \[migration\] "不存在的变异-自检用"（stop-only）：去向表里没有「提交」= "C2" 的登记行/.test(e2.stdout) && cli(['--baseline', baseAllFile, '--changed-since', headSha, '--s-registry-file', baseAllFile, '--disposition', (() => { const f = path.join(dir, 'disp-nocat.json'); fs.writeFileSync(f, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '自检用' }])); return f; })(), '--effective', wrEff('eff2b.json', EF())]).stdout.includes('登记行的「处置类别」是 undefined，生效清单里是 "stop-only"'), 'R1 CLI --effective 拒绝：retire 的旧编号去向行没带处置类别（只有「去向」）→ 退出码 1');
        const e3 = gateCli(baseAllFile, ['--disposition', dispStop, '--effective', wrEff('eff3.json', EF({ mustRun: [refA], retire: [{ group: 'migration', id: FAKE, category: 'stop-only' }, { ...refB, category: 'stop-only' }] }))]);
        check(e3.status === 1 && new RegExp('生效清单不通过：retire\\[1\\] \\[' + refB.group + '\\] ' + JSON.stringify(realB).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '：还在当前登记里').test(e3.stdout), 'R1 CLI --effective 拒绝：retire 里写了一个仍在当前登记里的编号（说删了其实没删）→ 退出码 1');
        const e4 = gateCli(baseAllFile, ['--disposition', dispStop, '--effective', wrEff('eff4.json', EF({ retire: [] }))]);
        check(e4.status === 1 && /生效清单不通过：<S> 时登记里有、当前登记里没有的编号 \[migration\] "不存在的变异-自检用" 不在 retire 里/.test(e4.stdout), 'R1 CLI --effective 拒绝：<S> 时登记里消失的编号（假编号）没写进 retire（删除绕过处置类别）→ 退出码 1');
        const e5 = gateCli(baseAllFile, ['--disposition', dispStop, '--effective', wrEff('eff5.json', EF({ retire: [{ group: 'migration', id: FAKE, category: 'equivalent', by: [{ group: 'migration', id: 'zzz-没有登记的承接编号' }] }] }))]);
        check(e5.status === 1 && /生效清单不通过：retire\[0\]\.by\[0\] \[migration\] "zzz-没有登记的承接编号"：不在当前登记里（承接变异必须仍已登记）/.test(e5.stdout), 'R1 CLI --effective 拒绝：equivalent 的承接编号没有登记 → 退出码 1');
        const dispEq = path.join(dir, 'disp-eq.json');
        fs.writeFileSync(dispEq, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '由已有变异承接', 处置类别: 'equivalent', 现行编号: [refB], 等价业务错误: '自检用', 承接命中证据: '自检用' }]));
        const e6 = gateCli(baseAllFile, ['--disposition', dispEq, '--effective', wrEff('eff6.json', EF({ retire: [{ group: 'migration', id: FAKE, category: 'equivalent', by: [refB] }] }))]);
        check(e6.status === 0 && /retire 1（stop-only 0 \/ remount 0 \/ equivalent 1）；问题 0 条/.test(e6.stdout), 'R1 CLI --effective 正例：equivalent 的承接编号是 <S> 时已有、当前仍登记的变异（如 1297 / 1298 这种）→ 通过');
        // 89 号 MEDIUM-2 / 94 号：第 ① 步对 equivalent 只核编号、类别、承接关系与已有依据（等价业务错误）；「承接命中证据」要对当次复验日志，第 ③ 步才强制——第 ① 步不核
        const dispEqNoEv = path.join(dir, 'disp-eq-noev.json');
        fs.writeFileSync(dispEqNoEv, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '由已有变异承接', 处置类别: 'equivalent', 现行编号: [refB], 等价业务错误: '自检用' }]));
        const dispEqNoBiz = path.join(dir, 'disp-eq-nobiz.json');
        fs.writeFileSync(dispEqNoBiz, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '由已有变异承接', 处置类别: 'equivalent', 现行编号: [refB], 承接命中证据: '自检用' }]));
        const effEq = wrEff('eff6b.json', EF({ retire: [{ group: 'migration', id: FAKE, category: 'equivalent', by: [refB] }] }));
        const e6b = gateCli(baseAllFile, ['--disposition', dispEqNoEv, '--effective', effEq]);
        const e6c = gateCli(baseAllFile, ['--disposition', dispEqNoBiz, '--effective', effEq]);
        check(e6b.status === 0 && /问题 0 条/.test(e6b.stdout) && e6c.status === 1 && /缺「等价业务错误」/.test(e6c.stdout), '89 MEDIUM-2：第 ① 步 equivalent 的去向行没有「承接命中证据」（还没有当次复验日志）→ 通过；缺「等价业务错误」（已有依据）→ 仍拒；承接命中证据留给第 ③ 步强制');
        // 94 号 MEDIUM：正式闸门只收「本次」去向表——累计表里带处置类别、但编号不在本次 retire 里的行（上一提交留下的）→ 拒
        const dispCumul = path.join(dir, 'disp-cumulative.json');
        // 协调方更正：去向表是跨提交累计的一份文件，每行带「提交」；退役类核对只看「提交」= 本次清单 commit 的行，其他提交的退役行忽略
        const refCRe = JSON.stringify(refC.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const dispCumOk = path.join(dir, 'disp-cumulative-ok.json');
        fs.writeFileSync(dispCumOk, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '自检用', 处置类别: 'stop-only', 删除依据: '自检用的假编号' }, { 提交: 'C1', group: refC.group, id: refC.id, 去向: '上一提交的处置行', 处置类别: 'stop-only', 删除依据: '上一提交删的' }]));
        fs.writeFileSync(dispCumul, JSON.stringify([{ 提交: 'C2', group: 'migration', id: FAKE, 去向: '自检用', 处置类别: 'stop-only', 删除依据: '自检用的假编号' }, { 提交: 'C2', group: refC.group, id: refC.id, 去向: '本次提交里多出的处置行', 处置类别: 'stop-only', 删除依据: '不在本次 retire 里' }]));
        const dispNoCommit = path.join(dir, 'disp-nocommit.json');
        fs.writeFileSync(dispNoCommit, JSON.stringify([{ group: 'migration', id: FAKE, 去向: '自检用', 处置类别: 'stop-only', 删除依据: '自检用的假编号' }]));
        const dispOtherCommit = path.join(dir, 'disp-othercommit.json');
        fs.writeFileSync(dispOtherCommit, JSON.stringify([{ 提交: 'C1', group: 'migration', id: FAKE, 去向: '自检用', 处置类别: 'stop-only', 删除依据: '自检用的假编号' }]));
        const e6d = gateCli(baseAllFile, ['--disposition', dispCumOk, '--effective', wrEff('eff6d.json', EF())]);
        const e6e = gateCli(baseAllFile, ['--disposition', dispCumul, '--effective', wrEff('eff6e.json', EF())]);
        const e6f = gateCli(baseAllFile, ['--disposition', dispNoCommit, '--effective', wrEff('eff6f.json', EF())]);
        const e6g = gateCli(baseAllFile, ['--disposition', dispOtherCommit, '--effective', wrEff('eff6g.json', EF())]);
        check(e6d.status === 0 && /问题 0 条/.test(e6d.stdout), '去向表是跨提交累计的文件（协调方更正）：表里有 C1 提交的别的退役行（refC），本次 C2 清单的 retire 只有 FAKE 且有 C2 行 → 过（其他提交的退役行忽略，不报「多余类别」）');
        check(e6e.status === 1 && new RegExp('去向表 \\[' + refC.group + '\\] ' + refCRe + '：「提交」= "C2"、带「处置类别」，但该编号不在生效清单的 retire 里').test(e6e.stdout), '去向表：「提交」= 本次清单 commit 的行里带「处置类别」、编号却不在本次 retire 里 → 拒');
        check(e6f.status === 1 && /带「处置类别」却没有「提交」字段/.test(e6f.stdout) && e6g.status === 1 && /retire \[migration\] "不存在的变异-自检用"（stop-only）：去向表里没有「提交」= "C2" 的登记行（别的提交的行不算）/.test(e6g.stdout), '去向表：退役行没有「提交」字段 → 拒；本次 retire 只有别的提交（C1）的行、缺本次（C2）行 → 拒');
        const e7 = cli(['--effective', wrEff('eff7.json', EF())]);
        const e8 = gateCli(baseAllFile, ['--effective', path.join(dir, '不存在.json')]);
        check(e7.status === 2 && /--effective \/ --effective-none \/ --changed-since \/ --s-registry-attest 只能与 --baseline 一起用/.test(e7.stderr) && e8.status === 2 && /--effective 无法读取/.test(e8.stderr), 'R1 CLI 用法错误（退出码 2）：--effective 没有 --baseline / 清单文件读不到');
        // LOW-1：闸门不能与 --groups 同用
        const e9 = cli(['--groups', 'migration', '--baseline', baseAllFile, '--changed-since', headSha, '--disposition', dispStop, '--effective', wrEff('eff9.json', EF())]);
        check(e9.status === 2 && /--baseline（提交闸门）要对十组全部核.*不能与 --groups 同用/.test(e9.stderr), 'R1 CLI 用法错误（退出码 2，LOW-1）：--baseline 闸门与 --groups 同用 → 拒（只看部分组会漏掉别的组里的删除与新增）');
        // 预筛 HIGH-1：当前登记 − <S> 时登记 = added ∪ newId。<S> 时登记里去掉 refC，它就是「新增」：不声明 → 拒；声明在 added 里 → 通过；added 写了 <S> 时已有的编号 → 拒
        const baseMinusC = path.join(dir, 'base-minus-c.json');
        fs.writeFileSync(baseMinusC, JSON.stringify(emittedAll.filter((x) => !(x.group === refC.group && x.id === refC.id)).concat([{ group: 'migration', id: FAKE }])));
        const e10 = gateCli(baseMinusC, ['--disposition', dispStop, '--effective', wrEff('eff10.json', EF())]);
        check(e10.status === 1 && new RegExp('生效清单不通过：当前登记里有、<S> 时登记里没有的编号 \\[' + refC.group + '\\] ' + JSON.stringify(refC.id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' 既不在 added 里也不是 remount 的 newId').test(e10.stdout), 'R1 CLI --effective 拒绝（预筛 HIGH-1）：当前登记里新增了一个编号，清单没有在 added 里声明（也不是 remount newId）→ 退出码 1');
        const e11 = gateCli(baseMinusC, ['--disposition', dispStop, '--effective', wrEff('eff11.json', EF({ added: [{ ...refC, note: '自检用的新增变异' }] }))]);
        check(e11.status === 0 && /问题 0 条/.test(e11.stdout), 'R1 CLI --effective 正例（预筛 HIGH-1）：新增的编号声明在 added 里 → 通过');
        const e12 = gateCli(baseAllFile, ['--disposition', dispStop, '--effective', wrEff('eff12.json', EF({ added: [refC] }))]);
        check(e12.status === 1 && /生效清单不通过：added\[0\] \[[a-z]+\] ".*"：已在 <S> 时登记里/.test(e12.stdout), 'R1 CLI --effective 拒绝（预筛 HIGH-1）：added 里写了 <S> 时已有的编号 → 退出码 1');

        // 84 号 MEDIUM（核心设计，85 号 HIGH-2）：增删按 <S> 时登记核对，不按固定基线。模拟 C2 已删 / 已增之后的 C3：固定基线仍是 C1（含假编号 FAKE、不含 refC）；<S> 时登记 = C2 之后的登记
        const sAfterC2 = path.join(dir, 's-after-c2.json'); // <S> = C2：登记里没有 FAKE（C2 已删）、有 refC（C2 新增）——即当前真实登记
        fs.writeFileSync(sAfterC2, JSON.stringify(emittedAll));
        const baselineC1 = path.join(dir, 'baseline-c1.json'); // 固定 C1 基线：有 FAKE、没有 refC
        fs.writeFileSync(baselineC1, JSON.stringify(emittedAll.filter((x) => !(x.group === refC.group && x.id === refC.id)).concat([{ group: 'migration', id: FAKE }])));
        const gateC3 = (extra) => cli(['--baseline', baselineC1, '--changed-since', prevSha, '--s-registry-file', sAfterC2, ...extra]);
        // C3 有一个真实的生效清单、没有增删（mustRun refC：它是 C2 新增、不在固定基线里的编号）→ 过（按固定基线会被要求重新声明 FAKE 的 retire 与 refC 的 added）
        const c3a = gateC3(['--effective', wrEff('eff-c3a.json', { format: 'sysbuild-effective-list/1', commit: 'C3', mustRun: [refC], retire: [] })]);
        check(c3a.status === 0 && /基线有、现在没有 1 条；现在有、基线没有 1 条/.test(c3a.stdout) && /<S> 有、现在没有 0 条；现在有、<S> 没有 0 条/.test(c3a.stdout) && /问题 0 条/.test(c3a.stdout), '84 MEDIUM-2：C2 已删 FAKE / 已增 refC 之后，C3 的清单没有增删也能过（固定基线累计差异 1 + 1 只打印对照，不判定；mustRun 可以是 C2 新增、不在固定基线里的编号）');
        // C3 用 --effective-none（无增删）：登记增删部分通过，不再因 C2 留下的登记差异被拒；其余问题只可能来自改动路径白名单（取决于当前改动集，这里只断言没有登记增删类问题）
        const c3n = gateC3(['--effective-none', '无增删的 C3 自检']);
        check(!/<S> 时登记里有、当前登记里没有，但本次给的是 --effective-none/.test(c3n.stdout) && !/当前登记里有、<S> 时登记里没有，但本次给的是 --effective-none/.test(c3n.stdout) && /生效清单（R1）：--effective-none "无增删的 C3 自检"；改动路径/.test(c3n.stdout), '84 MEDIUM-2：C3 用 --effective-none（登记相对 <S> 没有增删）→ 登记增删部分不报问题（旧口径会因 C2 的差异拒）；输出写明理由与改动路径数');
        // C3 删掉一个 C2 新增的编号（refC）：<S> 时登记有它、当前登记没有 → 必须在 C3 清单的 retire 里声明；固定基线里没有它，旧口径看不见这次删除
        const sWithC3Gone = path.join(dir, 's-c3-gone.json'); // 当前登记 = 真实登记；构造「C3 删了 refC」= <S> 时登记里多了一个当前没有的编号 Z（C2 新增的）
        fs.writeFileSync(sWithC3Gone, JSON.stringify(emittedAll.concat([{ group: 'migration', id: 'C2 新增、C3 删掉的编号-自检用' }])));
        const c3del0 = cli(['--baseline', baselineC1, '--changed-since', headSha, '--s-registry-file', sWithC3Gone, '--effective', wrEff('eff-c3del0.json', { format: 'sysbuild-effective-list/1', commit: 'C3', mustRun: [refC], retire: [] })]);
        check(c3del0.status === 1 && /生效清单不通过：<S> 时登记里有、当前登记里没有的编号 \[migration\] "C2 新增、C3 删掉的编号-自检用" 不在 retire 里/.test(c3del0.stdout), '84 MEDIUM-2：C3 删掉一个 C2 新增（不在固定基线里）的编号而不声明 → 拒（<S> 时登记有它、当前登记没有）');
        const dispC3 = path.join(dir, 'disp-c3.json');
        fs.writeFileSync(dispC3, JSON.stringify([{ 提交: 'C3', group: 'migration', id: 'C2 新增、C3 删掉的编号-自检用', 去向: 'C3 删除', 处置类别: 'stop-only', 删除依据: '自检用' }]));
        const c3del1 = cli(['--baseline', baselineC1, '--changed-since', headSha, '--s-registry-file', sWithC3Gone, '--disposition', dispC3, '--effective', wrEff('eff-c3del1.json', { format: 'sysbuild-effective-list/1', commit: 'C3', mustRun: [refC], retire: [{ group: 'migration', id: 'C2 新增、C3 删掉的编号-自检用', category: 'stop-only' }] })]);
        check(c3del1.status === 0 && /问题 0 条/.test(c3del1.stdout), '84 MEDIUM-2：C3 在 retire 里声明删掉的 C2 新增编号（stop-only，去向行齐全）→ 过');
        // --effective-none 但 <S> 时登记与当前登记不同 → 拒（删除 / 新增变异必须给生效清单）
        const nDel = cli(['--baseline', baselineC1, '--changed-since', prevSha, '--s-registry-file', sWithC3Gone, '--effective-none', '无']);
        check(nDel.status === 1 && /<S> 时登记里有、当前登记里没有，但本次给的是 --effective-none/.test(nDel.stdout), '84 MEDIUM：--effective-none 而 <S> 时登记里有编号已从当前登记消失 → 退出码 1');
        // 硬门：--baseline 不带清单 / 不带 --changed-since / 两个都给 / 理由空白 → 用法错误；--query-baseline 带闸门参数 → 用法错误
        const g1 = cli(['--baseline', baselineC1, '--changed-since', headSha]);
        const g2 = cli(['--baseline', baselineC1, '--effective', wrEff('eff-g2.json', EF())]);
        const g3 = cli(['--baseline', baselineC1, '--changed-since', headSha, '--effective', wrEff('eff-g3.json', EF()), '--effective-none', 'x']);
        const g4 = cli(['--baseline', baselineC1, '--changed-since', headSha, '--effective-none', '   ']);
        const g5 = cli(['--query-baseline', baselineC1, '--effective', wrEff('eff-g5.json', EF())]);
        const g6 = cli(['--baseline', baselineC1, '--query-baseline', baselineC1, '--changed-since', headSha, '--effective-none', 'x']);
        const g7 = cli(['--baseline', baselineC1, '--changed-since', 'abc123', '--effective-none', 'x']);
        check(g1.status === 2 && /--baseline（提交闸门）必须给 --effective <生效清单 json>.*两个都不给 = 拒绝/.test(g1.stderr) && g2.status === 2 && /--baseline（提交闸门）必须同时给 --changed-since <S>/.test(g2.stderr) && g3.status === 2 && /--effective 与 --effective-none 只能给一个/.test(g3.stderr) && g4.status === 2 && /理由不能是空白/.test(g4.stderr) && g5.status === 2 && /只能与 --baseline 一起用/.test(g5.stderr) && g6.status === 2 && /不能同时给/.test(g6.stderr) && g7.status === 2 && /完整 40 位小写十六进制/.test(g7.stderr), '84 MEDIUM-1：--baseline 闸门缺 --effective / --effective-none（二选一）、缺 --changed-since、两个都给、理由空白、--changed-since 不是 40 位提交号 → 用法错误（退出码 2）；--query-baseline 不收闸门参数；两个入口不能同给');
        // 重复对象键：生效清单里同名字段出现两次 → 用法错误（JSON.parse 会悄悄保留最后一个值，前一处的编号在结构校验之前就消失）
        const dupTop = path.join(dir, 'eff-dup-top.json');
        fs.writeFileSync(dupTop, '{"format":"sysbuild-effective-list/1","commit":"C2","mustRun":[{"group":"api","id":"X1"}],"mustRun":[],"retire":[]}');
        const dupNested = path.join(dir, 'eff-dup-nested.json');
        fs.writeFileSync(dupNested, '{"format":"sysbuild-effective-list/1","commit":"C2","mustRun":[{"group":"api","id":"X1","id":"X2"}],"retire":[]}');
        const dd1 = gateCli(baseAllFile, ['--effective', dupTop]);
        const dd2 = gateCli(baseAllFile, ['--effective', dupNested]);
        check(dd1.status === 2 && /--effective 里有重复的对象键.*\$\.mustRun/.test(dd1.stderr) && dd2.status === 2 && /--effective 里有重复的对象键.*\$\.mustRun\[0\]\.id/.test(dd2.stderr), '84 MEDIUM：生效清单里顶层 mustRun 写了两处、嵌套的 { group, id } 里 id 写了两处 → 用法错误（退出码 2），指出重复键的路径');

        // <S> 时登记：在 <S> 提交的内容上真跑登记读取函数（临时 git 仓库里放十组最小登记，两个提交，第二个提交改了登记）；--ids-only 与 --emit-ids 对同一份内容一致
        const fk = path.join(dir, 'fake-s');
        const fputIn = (root, rel, text) => { const abs = P(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); };
        const fput = (rel, text) => fputIn(fk, rel, text);
        const fakeTree = (ids, root) => {
            const rt = root || fk;
            const fp = (rel, text) => fputIn(rt, rel, text);
            const m = (g) => ids[g].map((id) => `{ id: ${JSON.stringify(id)}, from: 'a', to: 'b', expect: 'x' }`).join(', ');
            fp('wbs-server/scripts/lib/sysbuild-api-suite.js', `module.exports = { MUTATIONS: [${m('api')}], listCaseNames: () => ['x'], COPIED_MODULE_FILES: [] };\n`);
            fp('wbs-server/scripts/lib/sysbuild-browser-suite.js', `module.exports = { FRONT_MUTATIONS: [${m('browser')}] };\n`);
            fp('wbs-server/scripts/verify-sysbuild-static.js', `module.exports = { MUTATIONS: [${m('static')}], RULES: [['x']] };\n`);
            fp('wbs-server/scripts/verify-sysbuild-schema.js', `module.exports = { MUTATIONS: [${m('schema')}], CASE_NAMES: ['x'] };\n`);
            fp('wbs-server/scripts/verify-sysbuild-db.js', `module.exports = { MUTATIONS: [${m('db')}] };\n`);
            fp('wbs-server/scripts/verify-sysbuild-attachments.js', `module.exports = { MUTATIONS: [${m('attachments')}] };\n`);
            fp('scripts/sysbuild-predeploy/schema-migration-mutations.cjs', `module.exports = [${m('migration')}];\n`);
            fp('scripts/sysbuild-predeploy/verify-deploy-migration.cjs', `const mutations = [${m('deploy')}];\n`);
            fp('scripts/sysbuild-predeploy/run-archive-self-test.cjs', `module.exports = { mutations: [${m('archive')}] };\n`);
            fp('scripts/sysbuild-predeploy/run-readonly-self-test.cjs', `module.exports = { mutations: [${m('readonly')}] };\n`);
            fp('docs/不落地.md', '# docs 不落地\n');
        };
        const fids1 = { api: ['A1', 'A2'], browser: ['B1'], static: ['S1'], schema: ['C1'], db: ['D1'], attachments: ['T1'], migration: ['M1'], deploy: ['P1'], archive: ['R1'], readonly: ['O1'] };
        const fids2 = { ...fids1, api: ['A1', 'A3'], migration: ['M1', 'M2'] };
        const fgit = (args) => spawnSync('git', ['-C', fk, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
        fs.mkdirSync(fk, { recursive: true });
        fgit(['init', '-q']);
        fakeTree(fids1);
        fgit(['add', '-A']);
        fgit(['commit', '-q', '-m', 's1']);
        const s1 = fgit(['rev-parse', 'HEAD']).stdout.trim();
        fakeTree(fids2);
        fgit(['add', '-A']);
        fgit(['commit', '-q', '-m', 's2']);
        const s2 = fgit(['rev-parse', 'HEAD']).stdout.trim();
        const flat = (ids) => Object.keys(ids).flatMap((g) => ids[g].map((id) => g + '|' + id)).sort().join();
        const reg1 = effList.registryAtCommit(fk, s1);
        const reg2 = effList.registryAtCommit(fk, s2);
        check(reg1.list.map((x) => x.group + '|' + x.id).sort().join() === flat(fids1) && reg2.list.map((x) => x.group + '|' + x.id).sort().join() === flat(fids2) && reg1.keys.size === 11 && reg2.keys.has('api\u0000A3') && !reg1.keys.has('api\u0000A3') && reg1.fileCount === 10, '<S> 时登记（registryAtCommit）：在临时 git 仓库的两个提交内容上真跑登记读取函数，各自返回该提交时点的十组编号（S1 = 11 条、S2 把 api A2→A3、加 migration M2）；docs/ 不落地，与工作区当前内容无关');
        fput('wbs-server/scripts/lib/sysbuild-api-suite.js', 'module.exports = { MUTATIONS: [{ id: "只在工作区里" }], listCaseNames: () => ["x"], COPIED_MODULE_FILES: [] };\n');
        const reg2b = effList.registryAtCommit(fk, s2);
        check(reg2b.keys.has('api\u0000A3') && !reg2b.keys.has('api\u0000只在工作区里'), '<S> 时登记：只读提交里的内容，不看工作区的改动（工作区里改了 api 登记也不影响 <S> 时登记）');
        const bad = (label, mutate) => { fput('wbs-server/scripts/lib/sysbuild-api-suite.js', 'module.exports = { MUTATIONS: [{ id: "A1" }], listCaseNames: () => ["x"], COPIED_MODULE_FILES: [] };\n'); mutate(); fgit(['add', '-A']); fgit(['commit', '-q', '-m', label]); const sha = fgit(['rev-parse', 'HEAD']).stdout.trim(); try { effList.registryAtCommit(fk, sha); return null; } catch (e) { return e.message; } };
        const badDup = bad('dup', () => fput('wbs-server/scripts/lib/sysbuild-api-suite.js', 'module.exports = { MUTATIONS: [{ id: "A1" }, { id: "A1" }], listCaseNames: () => ["x"], COPIED_MODULE_FILES: [] };\n'));
        const badNon = bad('non', () => fput('scripts/sysbuild-predeploy/verify-deploy-migration.cjs', 'const mutations = [{ id: someCall(), from: "a", to: "b" }];\n'));
        const badLoad = bad('load', () => fput('wbs-server/scripts/lib/sysbuild-api-suite.js', 'throw new Error("读不了");\n'));
        check(/重复 id/.test(String(badDup)) && /id 不是字面量/.test(String(badNon)) && /在 [0-9a-f]{40} 的内容上读十组登记失败/.test(String(badLoad)), '<S> 时登记：组内重复 id / 静态抽取到非字面量 id（deploy 组）/ 任一组读不到，都整体抛错，不返回残缺登记');
        const idsOnlyFile = path.join(dir, 'ids-only.json');
        const io = cli(['--ids-only', idsOnlyFile]);
        const idsOnly = fs.existsSync(idsOnlyFile) ? JSON.parse(fs.readFileSync(idsOnlyFile, 'utf8')) : null;
        check(io.status === 0 && idsOnly && idsOnly.format === 'sysbuild-registry-ids/1' && JSON.stringify(idsOnly.ids.map((x) => x.group + '|' + x.id)) === JSON.stringify(emittedAll.map((x) => x.group + '|' + x.id)), '--ids-only（内部入口）：对当前仓库写出的十组编号与 --emit-ids 写出的逐条一致（同序）');

        // ── 89 / 94 号新增 ──────────────────────────────────────────────────────────────────
        const realCli = (args) => realSpawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 120000 });
        // 94 HIGH-1：自检钩子不是命令行参数；--self-test 不与正式参数同给
        const hk1 = realCli(['--baseline', baseAllFile, '--changed-since', headSha, '--s-registry-file', baseAllFile, '--effective-none', 'x']);
        const hk2 = realCli(['--self-test', '--baseline', baseAllFile, '--changed-since', headSha, '--effective-none', 'x']);
        const hk3 = realCli(['--self-test', '--s-registry-attest', '理由']);
        check(hk1.status === 2 && /--s-registry-file 是自检钩子，不是命令行参数/.test(hk1.stderr), '94 HIGH-1：命令行给 --s-registry-file（正式闸门参数一起）→ 用法错误（2）；钩子只能经 main(argv, hooks) 内部注入');
        check(hk2.status === 2 && /--self-test 不能与正式参数/.test(hk2.stderr) && hk3.status === 2 && /--self-test 不能与正式参数/.test(hk3.stderr), '94 HIGH-1：--self-test 与 --baseline / --effective-none / --s-registry-attest 同给 → 用法错误（2）');
        const hk4 = cli(['--baseline', baseAllFile, '--changed-since', headSha, '--s-registry-file', baseAllFile, '--disposition', dispStop, '--effective', wrEff('eff-hk4.json', EF())]);
        check(hk4.status === 0 && /（来源 自检钩子（内部注入））/.test(hk4.stdout), '94 HIGH-1 对照：自检内部注入（main(argv, hooks)）仍可用——同样的 <S> 时登记经钩子给入 → 通过，输出来源写明「自检钩子（内部注入）」');
        // 94 HIGH-2 / HIGH-3：独立的假仓库（S1 → S2 → S3，S3 改了登记读取链路文件）
        const fk2 = path.join(dir, 'fake-s2');
        fs.mkdirSync(fk2, { recursive: true });
        const fgit2 = (args) => spawnSync('git', ['-C', fk2, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
        fgit2(['init', '-q']);
        fakeTree(fids1, fk2);
        fgit2(['add', '-A']);
        fgit2(['commit', '-q', '-m', 'k1']);
        const k1 = fgit2(['rev-parse', 'HEAD']).stdout.trim();
        fakeTree(fids2, fk2);
        fgit2(['add', '-A']);
        fgit2(['commit', '-q', '-m', 'k2']);
        const k2 = fgit2(['rev-parse', 'HEAD']).stdout.trim();
        const k2Tree = fgit2(['rev-parse', 'HEAD^{tree}']).stdout.trim();
        const kOrphan = fgit2(['commit-tree', k2Tree, '-m', 'orphan']).stdout.trim();
        const effK = wrEff('eff-k.json', EF({ mustRun: [], retire: [], reason: '只为跑 <S> 校验' }));
        const sKinds = [['树对象', k2Tree, /是 tree，不是提交/], ['不是 HEAD 祖先的提交', kOrphan, /不是 HEAD 的祖先/]];
        const sCli = [];
        const sFn = [];
        for (const [, sha, re] of sKinds) {
            const rNone = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', sha, '--effective-none', 'x']); // cli = 经自检钩子 allowForeignTool 放行跨检出（脚本在主检出、--repo 是临时仓库），这样拒绝的原因才是 <S> 校验本身
            const rFile = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', sha, '--effective', effK]);
            let fnErr = null;
            try { effList.registryAtCommit(fk2, sha); } catch (e) { fnErr = e.message; }
            let chErr = null;
            try { effList.changedPathsSince(fk2, sha); } catch (e) { chErr = e.message; }
            sCli.push(rNone.status === 2 && re.test(rNone.stderr) && rFile.status === 2 && re.test(rFile.stderr));
            sFn.push(re.test(String(fnErr)) && re.test(String(chErr)));
        }
        check(sCli[0] && sCli[1], '94 HIGH-2：<S> 是树对象 / 不是 HEAD 祖先的提交 → 无清单模式、文件模式一律用法错误（2；主流程在读登记与改动集之前就过 validateSinceCommit）');
        check(sFn[0], '94 HIGH-2：<S> 是树对象 → registryAtCommit、changedPathsSince 各自抛错（函数级也过 validateSinceCommit：git cat-file -t 必须是 commit）');
        check(sFn[1], '94 HIGH-2：<S> 是不在 HEAD 祖先链上的提交 → registryAtCommit、changedPathsSince 各自抛错（merge-base --is-ancestor）');
        check(effList.validateSinceCommit(fk2, k1) === k1 && effList.validateSinceCommit(fk2, k2) === k2 && ['abc', 'A'.repeat(40), k1.slice(0, 39)].every((bad) => { try { effList.validateSinceCommit(fk2, bad); return false; } catch (e) { return /完整 40 位小写十六进制/.test(e.message); } }), '94 HIGH-2：<S> 校验的正例（HEAD 的祖先提交、HEAD 自己）与形态反例（太短 / 大写 / 非十六进制）');
        // 94 HIGH-3：S3 改了登记读取链路的文件 → 读取器漂移硬门
        fputIn(fk2, 'wbs-server/package.json', '{ "name": "fake", "dependencies": { "acorn": "1" } }\n'); // 依赖清单变了（读取器链路）
        fgit2(['add', '-A']);
        fgit2(['commit', '-q', '-m', 'k3']);
        const driftNone = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', k2, '--effective-none', 'x']);
        const driftAttest = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', k2, '--effective-none', 'x', '--s-registry-attest', '已用旧版读取器在 k2 内容上核对十组登记，逐条一致']);
        check(driftNone.status === 1 && /登记读取器漂移：登记读取逻辑在本次改动内（1 个路径：wbs-server\/package\.json）[^\n]*须人工核对 <S> 时登记/.test(driftNone.stdout) && !/登记读取器漂移（人工声明）/.test(driftNone.stdout) && driftAttest.status === 1 && !/登记读取器漂移：登记读取逻辑在本次改动内/.test(driftAttest.stdout) && /登记读取器漂移：<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理/.test(driftAttest.stdout) && /登记读取器漂移（人工声明）：[^\n]*--s-registry-attest "已用旧版读取器在 k2 内容上核对十组登记，逐条一致"/.test(driftAttest.stdout), '94 HIGH-3：改动集含读取器链路文件（依赖清单 wbs-server/package.json）→ 第 ① 步拒绝自动判定并提示须人工核对 <S> 时登记；加 --s-registry-attest "<理由>" → 不再报漂移、输出人工声明与理由（其余硬门照跑：本例假仓库缺用例名清单等，别的问题仍在，退出码仍 1）');
        const dr = (paths, attest) => effList.sRegistryDriftProblems(paths, attest);
        check(dr(['docs/a.md', 'wbs-server/routes/sysbuild/rules.js']).problems.length === 0 && dr(['wbs-server/scripts/sysbuild-step1/effective-list.js']).problems.length === 1 && dr(['WBS-SERVER/scripts/sysbuild-step1/Mutation-Check.js']).problems.length === 1 && dr(['wbs-server/package-lock.json']).problems.length === 1 && dr(['wbs-server/scripts/lib/other.js']).problems.length === 0 && dr(['wbs-server/package.json'], '  ').problems.length === 1 && dr(['wbs-server/package.json'], '核对过').problems.length === 0 && /核对过/.test(dr(['wbs-server/package.json'], '核对过').note), '94 HIGH-3（纯函数）：读取器链路名单——读取器本体（含大小写别名）/ 依赖清单命中；无关路径不命中；理由空白不算声明');
        // 预筛 HIGH-1 反例：只改 api 套件（含拆分件）+ verify 驱动 + sysbuild-mut-record + 预置驱动 + 产品文件的假设改动列表 → 漂移门不触发（它们从 <S> 的临时树加载，不是读取器链路）
        const suiteOnly = ['wbs-server/scripts/lib/sysbuild-api-suite.js', 'wbs-server/scripts/lib/sysbuild-api-suite-notify.js', 'wbs-server/scripts/lib/sysbuild-browser-suite.js', 'wbs-server/scripts/lib/sysbuild-browser-trace-forms.js', 'wbs-server/scripts/lib/sysbuild-mut-record.js', 'wbs-server/scripts/verify-sysbuild-api.js', 'wbs-server/scripts/verify-sysbuild-static.js', 'scripts/sysbuild-predeploy/schema-migration-mutations.cjs', 'scripts/sysbuild-predeploy/verify-deploy-migration.cjs', 'wbs-server/routes/sysbuild/rules.js', 'wbs-server/public/assets/js/a.js'];
        check(dr(suiteOnly).problems.length === 0 && dr(suiteOnly).note === null && dr([...suiteOnly, 'wbs-server/scripts/sysbuild-step1/effective-list.js']).problems.length === 1 && effList.readerChainHits(suiteOnly).length === 0, '预筛 HIGH-1 反例（纯函数）：只改 api 套件 + 拆分件 + verify 驱动 + sysbuild-mut-record + predeploy 登记文件 + 产品文件 → 漂移门不触发；同一列表再加读取器本体（effective-list.js）→ 触发');
        // 真实数据（预筛 HIGH-1）：registryAtCommit 在真实仓库的 HEAD 上读 <S> 时，子进程里「位于临时树之外、但在仓库内」的非 node_modules 模块 = 从当前检出加载的读取器与它的依赖，必须全在 READER_CHAIN 名单里；
        //   进程内读当前登记时加载的其余仓库内模块（套件 / 驱动 / mut-record 等）必须在 TREE_INPUTS（它们读 <S> 时从临时树加载，不进漂移门）；名单里的具体文件在真实仓库里都存在
        const headNow = realSpawnSync('git', ['-C', DEFAULT_REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        const realReg = effList.registryAtCommit(DEFAULT_REPO, headNow);
        const repoNorm = (p) => path.relative(DEFAULT_REPO, p).replace(/\\/g, '/');
        const outsideRel = realReg.loadedOutsideTree.map(repoNorm).filter((p) => !p.startsWith('..') && !path.isAbsolute(p));
        const outsideNotChain = outsideRel.filter((p) => !effList.isReaderChainPath(p));
        // 既不在临时树、也不在仓库内、又不是 node_modules 的已加载模块（子进程已滤掉 node_modules）：非空就直接报出来，不过滤丢弃
        const strayOutside = realReg.loadedOutsideTree.filter((p) => { const r = repoNorm(p); return r.startsWith('..') || path.isAbsolute(r); });
        const realIds = idsOfRegistry(DEFAULT_REPO);
        // 真实仓库核数量和组别，测试仓库仍逐条比对明确编号。
        const completeRealRegistry = (entries) => {
            const groups = new Set(entries.map((entry) => entry.group));
            return entries.length >= MIN_REAL_REGISTRY_SIZE && ALL_GROUPS.every((group) => groups.has(group));
        };
        const loadedRepo = Object.keys(require.cache).filter((k) => !k.includes('node_modules')).map(repoNorm).filter((p) => !p.startsWith('..') && !path.isAbsolute(p));
        const loadedNotAny = loadedRepo.filter((p) => !effList.isReaderChainPath(p) && !effList.isTreeInputPath(p));
        const missingLists = [...effList.READER_CHAIN.files, ...effList.TREE_INPUTS.files].filter((f) => !/^(?:package(?:-lock)?\.json)$/.test(f) && !fs.existsSync(P(DEFAULT_REPO, f)));
        const mustLoaded = ['wbs-server/scripts/lib/sysbuild-api-suite.js', 'wbs-server/scripts/lib/sysbuild-browser-suite.js', 'wbs-server/scripts/verify-sysbuild-static.js', 'wbs-server/scripts/verify-sysbuild-schema.js', 'wbs-server/scripts/verify-sysbuild-db.js', 'wbs-server/scripts/verify-sysbuild-attachments.js', 'scripts/sysbuild-predeploy/schema-migration-mutations.cjs', 'scripts/sysbuild-predeploy/run-archive-self-test.cjs', 'scripts/sysbuild-predeploy/run-readonly-self-test.cjs', 'wbs-server/scripts/lib/sysbuild-mut-record.js'];
        check(outsideRel.includes('wbs-server/scripts/sysbuild-step1/mutation-check.js') && outsideRel.includes('wbs-server/scripts/sysbuild-step1/effective-list.js') && outsideNotChain.length === 0 && strayOutside.length === 0 && completeRealRegistry(realReg.list), `预筛 HIGH-1（真实数据；LOW-b：临时树之外又不在仓库内的非 node_modules 模块 ${strayOutside.length} 个${strayOutside.length ? '：' + strayOutside.join('、') : ''}，非空直接红）：registryAtCommit 在真实仓库 HEAD 上读 <S>，子进程里位于临时树之外的仓库内模块 ${outsideRel.length} 个（${outsideRel.join('、')}）都在 READER_CHAIN 名单里（漏列 ${outsideNotChain.length} 个${outsideNotChain.length ? '：' + outsideNotChain.join('、') : ''}）`);
        check(realIds.problems.length === 0 && completeRealRegistry(realIds.ids) && mustLoaded.every((f) => loadedRepo.includes(f)) && loadedNotAny.length === 0 && missingLists.length === 0 && effList.isTreeInputPath('scripts/sysbuild-predeploy/verify-deploy-migration.cjs') && !effList.isReaderChainPath('wbs-server/scripts/lib/sysbuild-mut-record.js'), `94 HIGH-3（真实数据）：进程内读当前十组登记（${realIds.ids.length} 条）加载的仓库内模块 ${loadedRepo.length} 个，要么在 READER_CHAIN（读取器）要么在 TREE_INPUTS（套件 / 驱动 / mut-record，读 <S> 时从临时树加载）（两边都漏 ${loadedNotAny.length} 个${loadedNotAny.length ? '：' + loadedNotAny.join('、') : ''}）；deploy 组靠静态抽取读 verify-deploy-migration.cjs 也在 TREE_INPUTS；两份名单里的具体文件在仓库里都存在（缺 ${missingLists.length} 个）`);
        // 96 HIGH-3（真实数据）：真实仓库 HEAD 作 <S>，改动集含读取器本体 + 人工声明——<S> 树自带的读取器（mutation-check.js --ids-only，f57f6a57 起就有）与当前读取器读出同一份十组登记 → 记录理由继续，摘要 = HEAD 时登记的编号摘要
        const rsReal = effList.resolveSRegistry(DEFAULT_REPO, headNow, { changedPaths: ['wbs-server/scripts/sysbuild-step1/mutation-check.js'], attest: '真实仓库自检：新旧读取器核对' });
        check(rsReal.problems.length === 0 && rsReal.list && completeRealRegistry(rsReal.list) && rsReal.list.length === realReg.list.length && /新旧读取器结果全等/.test(rsReal.digest.source) && rsReal.digest.sha256 === effList.keysDigestOf(realReg.list) && rsReal.digest.count === realReg.keys.size, `96 HIGH-3（真实数据）：真实仓库 ${headNow.slice(0, 8)} 作 <S>、改动集含读取器本体 + 人工声明 → <S> 树自带的旧版读取器与当前读取器读出同一份十组登记（${rsReal.list ? rsReal.list.length : '读取失败'} 条），来源「新旧读取器结果全等」，摘要与 registryAtCommit 读出的一致`);
        // 94 MEDIUM：registryAtCommit 的落盘硬化——符号链接 / 子模块 / docs 落在读取链路里报错；大小写别名拒；路径无损映射；残留清理继续
        const fk3 = path.join(dir, 'fake-s3');
        fs.mkdirSync(fk3, { recursive: true });
        const fgit3 = (args, input) => spawnSync('git', ['-C', fk3, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'core.ignorecase=false', ...args], { encoding: 'utf8', input });
        fgit3(['init', '-q']);
        fakeTree(fids1, fk3);
        fgit3(['add', '-A']);
        const blobOf = (text) => fgit3(['hash-object', '-w', '--stdin'], text).stdout.trim();
        const commitWith = (label, entries) => { // entries: [{ mode, path, text }]：在 fk3 当前索引上再加这些条目后提交，返回提交号；之后用 reset 索引回到基础树
            for (const e of entries) fgit3(['update-index', '--add', '--cacheinfo', `${e.mode},${blobOf(e.text)},${e.path}`]);
            fgit3(['commit', '-q', '-m', label]);
            const sha = fgit3(['rev-parse', 'HEAD']).stdout.trim();
            return sha;
        };
        fgit3(['commit', '-q', '-m', 'base']);
        const registryErr = (sha) => { try { return { ok: effList.registryAtCommit(fk3, sha) }; } catch (e) { return { err: e.message }; } };
        const cLink = commitWith('link-in-chain', [{ mode: '120000', path: 'wbs-server/scripts/lib/sysbuild-api-suite-extra.js', text: 'target.js' }]);
        const eLink = registryErr(cLink);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        const cLinkOut = commitWith('link-outside-chain', [{ mode: '120000', path: 'README-link', text: 'x' }]);
        const eLinkOut = registryErr(cLinkOut);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        const cCase = commitWith('case-alias', [{ mode: '100644', path: 'wbs-server/scripts/lib/Alias.js', text: '1' }, { mode: '100644', path: 'wbs-server/scripts/lib/alias.js', text: '2' }]);
        const eCase = registryErr(cCase);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        const cDocsDep = commitWith('docs-dep', [{ mode: '100644', path: 'docs/dep.js', text: 'module.exports = [];\n' }, { mode: '100644', path: 'wbs-server/scripts/lib/sysbuild-api-suite.js', text: 'module.exports = { MUTATIONS: require("../../../docs/dep.js"), listCaseNames: () => ["x"], COPIED_MODULE_FILES: [] };\n' }]);
        const eDocs = registryErr(cDocsDep);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        check(/登记读取链路里有被跳过的项[^\n]*sysbuild-api-suite-extra\.js/.test(String(eLink.err)) && eLinkOut.ok && eLinkOut.ok.skipped.links.join() === 'README-link' && eLinkOut.ok.skipped.docs === 1 && eLinkOut.ok.fileCount === 10, '94 MEDIUM：符号链接落在登记读取链路里（api 套件拆分件）→ 报错；链路外的符号链接只记进 skipped.links（README-link），docs/ 跳过数记 skipped.docs');
        check(/只差大小写/.test(String(eCase.err)) && /读十组登记失败/.test(String(eDocs.err)), '94 MEDIUM：只差大小写的两个路径（Alias.js / alias.js）→ 拒绝落地；登记文件 require 了被跳过的 docs/ 文件 → 读取失败直接报错（不会读空）');
        const lp = effList.landingPathProblem;
        check(lp('a/b.js') === null && lp('wbs-server/scripts/lib/with space 中.js') === null && ['a\\b.js', 'a:b.js', 'a/CON.js', 'a/nul', 'a/b./c.js', 'a/b /c.js', 'a//b.js', '../x.js', 'a/./b.js', '/abs.js', 'C:x.js', 'a/b\u0001.js', 'a/b?.js'].every((p) => lp(p) !== null), '94 MEDIUM：路径无损映射（landingPathProblem）：反斜杠 / 冒号 / 保留设备名 / 尾部点或空格 / 空段 / .. / 绝对路径 / 控制字符 / Windows 不允许的字符都拒；含空格与中文的正常路径放行');
        // ── 96 号（R6b）新增：落盘硬化二期、<S> 起点、旧版读取器、累计表整表、跨检出 ─────────────────────────────────────
        // MEDIUM（落盘）：根级 ..notes 合法（旧版 startsWith('..') 误拒）；两个目录只差大小写、文件名互不重复也拒；跳过项（子模块 / 符号链接）顶替了登记输入的祖先目录 → 报错
        const cDotdot = commitWith('dotdot', [{ mode: '100644', path: '..notes', text: 'x' }]);
        const eDotdot = registryErr(cDotdot);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        const cDirAlias = commitWith('dir-alias', [{ mode: '100644', path: 'wbs-server/scripts/Lib2/a.js', text: '1' }, { mode: '100644', path: 'wbs-server/scripts/lib2/b.js', text: '2' }]);
        const eDirAlias = registryErr(cDirAlias);
        fgit3(['reset', '-q', '--hard', 'HEAD~1']);
        const baseSha3 = fgit3(['rev-parse', 'HEAD']).stdout.trim();
        const gitlinkOver = (label, p) => { fgit3(['update-index', '--add', '--replace', '--cacheinfo', `160000,${baseSha3},${p}`]); fgit3(['commit', '-q', '-m', label]); const sha = fgit3(['rev-parse', 'HEAD']).stdout.trim(); const r = registryErr(sha); fgit3(['reset', '-q', '--hard', 'HEAD~1']); return r; };
        const eAnc = gitlinkOver('gitlink-over-predeploy', 'scripts/sysbuild-predeploy');
        const eAncLib = gitlinkOver('gitlink-over-lib', 'wbs-server/scripts/lib');
        const eAncOut = gitlinkOver('gitlink-over-other', 'wbs-server/routes');
        const cov = effList.coversReadChain;
        let lossErr = null;
        try { effList.losslessPaths(['docs\\说明.txt']); } catch (e) { lossErr = e.message; }
        const lossKeep = effList.losslessPaths(['docs/Readme.md', 'DOCS/readme.md', 'wbs-server/a b/中.js']);
        check(eDotdot.ok && !eDotdot.err && effList.landingPathProblem('..notes') === null, '96 MEDIUM（落盘）：根级 ..notes 合法（按完整路径段判断越界，旧版 startsWith("..") 误拒）');
        check(/目录[^\n]*(?:Lib2[^\n]*lib2|lib2[^\n]*Lib2)[^\n]*只差大小写/.test(String(eDirAlias.err)), '96 MEDIUM（落盘）：wbs-server/scripts/Lib2/ 与 lib2/（文件名互不重复，整条路径小写值不同）→ 按目录段拒（临时树里会合并成一个目录）');
        check(/登记读取链路里有被跳过的项[^\n]*scripts\/sysbuild-predeploy/.test(String(eAnc.err)) && /登记读取链路里有被跳过的项[^\n]*wbs-server\/scripts\/lib/.test(String(eAncLib.err)) && eAncOut.ok && eAncOut.ok.skipped.submodules.join() === 'wbs-server/routes' && cov('wbs-server/scripts') && cov('scripts/sysbuild-predeploy') && cov('wbs-server/scripts/lib') && cov('wbs-server/scripts/lib/sysbuild-api-suite-extra.js') && cov('wbs-server/package.json') && !cov('README-link') && !cov('wbs-server/routes') && !cov('docs/x.md') && effList.TREE_INPUTS.patterns.every((re) => effList.TREE_INPUTS.patternDirs.some((d) => re.test(d + 'sysbuild-api-suite-x.js') || re.test(d + 'sysbuild-browser-x.js'))), '96 MEDIUM（落盘）：子模块顶替了 scripts/sysbuild-predeploy / wbs-server/scripts/lib（登记输入的祖先目录）→ 报「登记读取链路里有被跳过的项」；顶替链路之外的 wbs-server/routes 只记进 skipped.submodules；coversReadChain 对祖先目录 / 文件 / pattern 目录成立、对无关路径不成立；patterns 的样例都落在 patternDirs 里');
        check(/无法无损处理的路径/.test(String(lossErr)) && lossKeep.size === 3 && lossKeep.has('DOCS/readme.md') && lossKeep.has('docs/Readme.md'), '96 MEDIUM（Git 路径原值）：changedPathsSince 的路径集合不改写 Git 路径——只差大小写的两个路径各自保留（不折叠）；含反斜杠的路径无法无损处理 → 明确报错（旧版把反斜杠换成正斜杠，docs\\说明.txt 会被归进 docs/）');
        // HIGH-1：正式闸门 <S> 只许 HEAD 或 HEAD 的第一父提交（fk2：k1 → k2 → k3 = HEAD）
        const k3 = fgit2(['rev-parse', 'HEAD']).stdout.trim();
        const gS = (since) => cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', since, '--effective-none', 'x']);
        const gsOld = gS(k1);
        const gsPar = gS(k2);
        const gsHead = gS(k3);
        let gsFn = null;
        try { effList.validateSinceCommit(fk2, k1, undefined, { gate: true }); } catch (e) { gsFn = e.message; }
        check(gsOld.status === 2 && /既不是 HEAD[^\n]*也不是 HEAD 的第一父提交/.test(gsOld.stderr) && gsPar.status !== 2 && gsHead.status !== 2 && /既不是 HEAD/.test(String(gsFn)) && effList.validateSinceCommit(fk2, k2, undefined, { gate: true }) === k2 && effList.validateSinceCommit(fk2, k3, undefined, { gate: true }) === k3 && effList.validateSinceCommit(fk2, k1) === k1, '96 HIGH-1：正式闸门 <S> = 更早的祖先（k1，HEAD 是 k3）→ 用法错误（2）；<S> = HEAD 的第一父提交（k2，提交后补跑）/ HEAD（提交前）→ 不是用法错误；不带 gate 的函数级校验（累计查询用）仍收任意祖先');
        // 预筛 MED-1：<S> = HEAD 的第一父提交（提交后补跑）+ 工作区有未提交 / 未跟踪的改动 → 用法错误；工作区干净 → 过；<S> = HEAD + 改动 → 不拒（还没提交的改动就是改动集）；扣掉工具输入后无剩余 → 过
        const dirtyFile = P(fk2, 'zz-dirty-after-commit.txt');
        const gClean = (since) => cli(['--force-clean-check', '--repo', fk2, '--baseline', baseAllFile, '--changed-since', since, '--effective-none', 'x']);
        const dc0 = gClean(k2);
        fs.writeFileSync(dirtyFile, 'x\n');
        const dc1 = gClean(k2);
        const dc2 = gClean(k3);
        const dcFn = effList.postCommitDirtyProblem(fk2, k2, null);
        const dcIgn = effList.postCommitDirtyProblem(fk2, k2, { files: ['zz-dirty-after-commit.txt'] });
        fs.unlinkSync(dirtyFile);
        check(dc0.status !== 2 && dc1.status === 2 && /提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD/.test(dc1.stderr) && /zz-dirty-after-commit\.txt/.test(dc1.stderr) && dc2.status !== 2 && /要求工作区干净/.test(String(dcFn)) && dcIgn === null && effList.postCommitDirtyProblem(fk2, k2, null) === null && effList.postCommitDirtyProblem(fk2, k3, null) === null, '预筛 MED-1（第 ① 步）：<S> = HEAD^ 而工作区有未跟踪文件 → 用法错误（2，提示「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」）；<S> = HEAD^ 且工作区干净 → 不是用法错误；<S> = HEAD + 工作区改动 → 不拒；扣掉工具输入路径后无剩余 → 过');
        // 98 号 HIGH（线性历史）：进行中的合并 / HEAD 是合并提交 → 第 ① 步（本入口）拒；函数级（三步共用的 validateSinceCommit）同样拒，不带 gate 的累计查询口径不受影响
        const fkm = path.join(dir, 'fake-merge');
        fs.mkdirSync(fkm, { recursive: true });
        const fgitM = (args) => spawnSync('git', ['-C', fkm, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
        fgitM(['init', '-q']);
        fakeTree(fids1, fkm);
        fgitM(['add', '-A']);
        fgitM(['commit', '-q', '-m', 'm1']);
        fgitM(['checkout', '-q', '-b', 'side']);
        fputIn(fkm, 'side.txt', 's\n');
        fgitM(['add', '-A']);
        fgitM(['commit', '-q', '-m', 'side']);
        fgitM(['checkout', '-q', '-']);
        fputIn(fkm, 'main.txt', 'm\n');
        fgitM(['add', '-A']);
        fgitM(['commit', '-q', '-m', 'm2']);
        const mFirst = fgitM(['rev-parse', 'HEAD']).stdout.trim();
        fgitM(['merge', '-q', '--no-ff', '--no-commit', 'side']); // 合并进行中：MERGE_HEAD 存在
        const mProg = cli(['--repo', fkm, '--baseline', baseAllFile, '--changed-since', mFirst, '--effective-none', 'x']);
        let mProgFn = null;
        try { effList.validateSinceCommit(fkm, mFirst, undefined, { gate: true }); } catch (e) { mProgFn = e.message; }
        const mProgNoGate = effList.validateSinceCommit(fkm, mFirst);
        fgitM(['commit', '-q', '-m', 'M']); // 合并完成：HEAD 是合并提交
        const mMerge = fgitM(['rev-parse', 'HEAD']).stdout.trim();
        const mPost = cli(['--repo', fkm, '--baseline', baseAllFile, '--changed-since', mFirst, '--effective-none', 'x']); // 补跑模式：<S> = HEAD 的第一父提交
        const mHead = cli(['--repo', fkm, '--baseline', baseAllFile, '--changed-since', mMerge, '--effective-none', 'x']); // <S> = HEAD，HEAD 本身是合并提交
        let mPostFn = null;
        try { effList.validateSinceCommit(fkm, mFirst, undefined, { gate: true }); } catch (e) { mPostFn = e.message; }
        check(mProg.status === 2 && /仓库里有进行中的合并（MERGE_HEAD 存在）[^\n]*线性历史/.test(mProg.stderr) && /MERGE_HEAD/.test(String(mProgFn)) && mProgNoGate === mFirst, '98 HIGH（线性历史）：进行中的合并（MERGE_HEAD 存在，HEAD 还是普通提交）→ 第 ① 步用法错误（2，提示线性历史 / rebase 只在 C9 之后）；函数级 gate 同样抛错，不带 gate 的累计口径仍收');
        check(mPost.status === 2 && /是合并提交（2 个父提交）[^\n]*线性历史/.test(mPost.stderr) && mHead.status === 2 && /是合并提交（2 个父提交）/.test(mHead.stderr) && /是合并提交/.test(String(mPostFn)) && effList.validateSinceCommit(fkm, mFirst) === mFirst, '98 HIGH（线性历史）：HEAD 是合并提交——补跑模式（<S> = HEAD 的第一父提交，旧版放行）与 <S> = HEAD 都拒（用法错误 2）；不带 gate 的函数级校验仍收（累计查询用）');
        // 98 号 HIGH（线性历史，<S> 是合并提交）：合并提交 M 之后又提交了单父提交 X；补跑 <S> = HEAD^ = M 时 MERGE_HEAD 与「HEAD 是合并提交」都不成立，<S> 自己的父提交数要拦
        fputIn(fkm, 'x.txt', 'x\n');
        fgitM(['add', '-A']);
        fgitM(['commit', '-q', '-m', 'X']);
        const mSAfter = cli(['--repo', fkm, '--baseline', baseAllFile, '--changed-since', mMerge, '--effective-none', 'x']);
        let mSFn = null;
        try { effList.validateSinceCommit(fkm, mMerge, undefined, { gate: true }); } catch (e) { mSFn = e.message; }
        check(mSAfter.status === 2 && /<S>（[0-9a-f]{12}）本身是合并提交（2 个父提交）[^\n]*线性历史/.test(mSAfter.stderr) && /本身是合并提交/.test(String(mSFn)) && effList.validateSinceCommit(fkm, mMerge) === mMerge, '98 HIGH（<S> 是合并提交）：合并提交 M 之后又有单父提交 X，补跑 <S> = M（= HEAD 的第一父提交，MERGE_HEAD 与 HEAD 多父都不成立）→ 第 ① 步用法错误（2），函数级 gate 同样抛错；不带 gate 的累计查询仍收');
        // 98 号 MEDIUM：补跑时已被 HEAD 跟踪的基线 / 生效清单必须与 HEAD 一致才豁免（工作区与暂存区都算）；未跟踪的独立输入照旧豁免；去向表 / 报告（files）照旧整体豁免
        const fk6 = path.join(dir, 'fake-tracked-input');
        fs.mkdirSync(fk6, { recursive: true });
        const fgit6 = (args) => spawnSync('git', ['-C', fk6, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
        fgit6(['init', '-q']);
        fakeTree(fids1, fk6);
        const baseText6 = fs.readFileSync(baseAllFile, 'utf8');
        fputIn(fk6, 'base-track.json', baseText6);
        fgit6(['add', '-A']);
        fgit6(['commit', '-q', '-m', 'n1']);
        const n1 = fgit6(['rev-parse', 'HEAD']).stdout.trim();
        fputIn(fk6, 'docs/n2.md', 'n2\n');
        fgit6(['add', '-A']);
        fgit6(['commit', '-q', '-m', 'n2']);
        const tr = (ign) => effList.postCommitDirtyProblem(fk6, n1, ign);
        const trInputs = { inputs: ['base-track.json'] };
        const trClean = tr(trInputs);
        fputIn(fk6, 'base-track.json', baseText6 + '\n');
        fgit6(['add', 'base-track.json']); // 补跑前已暂存的修改（工作区 = 暂存区 ≠ HEAD）
        const trStaged = tr(trInputs);
        const trStagedCli = cli(['--force-clean-check', '--repo', fk6, '--baseline', P(fk6, 'base-track.json'), '--changed-since', n1, '--effective-none', 'x']);
        const trAsFiles = tr({ files: ['base-track.json'] }); // 对照：旧口径（整体豁免）——只给 files 的产物路径仍整体豁免
        fgit6(['restore', '--staged', 'base-track.json']); // 只有工作区改动
        const trWorktree = tr(trInputs);
        fgit6(['checkout', '--', 'base-track.json']);
        const trBack = tr(trInputs);
        fputIn(fk6, 'eff-new.json', '{}\n'); // 未被 HEAD 跟踪的独立输入
        const trUntracked = tr({ inputs: ['eff-new.json'] });
        const trUntrackedOther = tr({ inputs: ['base-track.json'] });
        fs.unlinkSync(P(fk6, 'eff-new.json'));
        check(trClean === null && /要求工作区干净/.test(String(trStaged)) && /base-track\.json/.test(String(trStaged)) && /被 HEAD 跟踪的基线 \/ 生效清单/.test(String(trStaged)) && trStagedCli.status === 2 && /base-track\.json/.test(trStagedCli.stderr) && /要求工作区干净/.test(String(trWorktree)) && trBack === null, '98 MEDIUM：补跑时已被 HEAD 跟踪的基线 / 生效清单——暂存区被修改（工作区 = 暂存区 ≠ HEAD）→ 拒（函数级与第 ① 步 CLI 都拒）；只改工作区 → 拒；改回与 HEAD 一致 → 过');
        check(trAsFiles === null && trUntracked === null && /eff-new\.json/.test(String(trUntrackedOther)) && /要求工作区干净/.test(String(trUntrackedOther)), '98 MEDIUM（对照）：声明的补写产物（files，如去向表 / 报告）照旧整体豁免；没被 HEAD 跟踪的独立输入（inputs）照旧豁免；未跟踪文件不在 inputs 里 → 仍算脏');
        // MEDIUM（降级项）：运行的脚本必须位于 --repo 内
        const foreignRun = realCli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', k2, '--effective-none', 'x']);
        check(foreignRun.status === 2 && /运行的脚本在 [^\n]*不在 --repo/.test(foreignRun.stderr) && effList.foreignToolProblem(__dirname, fk2) !== null && effList.foreignToolProblem(path.join(fk2, 'wbs-server', 'scripts', 'sysbuild-step1'), fk2) === null && effList.foreignToolProblem(__dirname, DEFAULT_REPO) === null, '96 MEDIUM（降级项）：从本检出的脚本去审另一个仓库（--repo 指向临时仓库）→ 用法错误（2，跨检出调用）；脚本在 --repo 内 / 默认仓库 → 通过');
        // HIGH-3：读取器漂移时的人工声明通路——用 <S> 树自带的旧版读取器（假的：读树里的 fake-old-ids.json）再读一遍
        const fk5 = path.join(dir, 'fake-attest');
        fs.mkdirSync(fk5, { recursive: true });
        const fgit5 = (args) => spawnSync('git', ['-C', fk5, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
        fgit5(['init', '-q']);
        const OLD_READER = "const fs=require('fs');const path=require('path');const a=process.argv;const out=a[a.indexOf('--ids-only')+1];const repo=a[a.indexOf('--repo')+1];const f=path.join(repo,'fake-old-ids.json');if(!fs.existsSync(f)){console.error('no old ids');process.exit(3);}fs.writeFileSync(out,JSON.stringify({format:'sysbuild-registry-ids/1',ids:JSON.parse(fs.readFileSync(f,'utf8')),loaded:[]}));\n";
        const idsList = (ids) => Object.keys(ids).flatMap((g) => ids[g].map((id) => ({ group: g, id })));
        const attestCase = (label, o5) => { // 提交一个 <S>：新版读取器读它的登记（假套件）；旧版读取器 = 树里的假脚本（o5.oldReader）读 fake-old-ids.json（o5.oldIds）
            for (const f of ['wbs-server/scripts/sysbuild-step1/mutation-check.js', 'fake-old-ids.json']) { try { fs.unlinkSync(P(fk5, f)); } catch (_) { /* 没有就算了 */ } }
            fakeTree(fids1, fk5);
            if (o5.breakNew) fputIn(fk5, 'wbs-server/scripts/lib/sysbuild-api-suite.js', 'throw new Error("读不了");\n');
            if (o5.oldReader) fputIn(fk5, 'wbs-server/scripts/sysbuild-step1/mutation-check.js', OLD_READER);
            if (o5.oldIds) fputIn(fk5, 'fake-old-ids.json', JSON.stringify(o5.oldIds));
            fgit5(['add', '-A']);
            fgit5(['commit', '-q', '-m', label]);
            return fgit5(['rev-parse', 'HEAD']).stdout.trim();
        };
        const sA = attestCase('A', { oldReader: true, oldIds: idsList(fids1) });
        fputIn(fk5, 'wbs-server/package.json', '{ "name": "fake" }\n'); // 本提交改了依赖清单（读取器链路）：HEAD = T，HEAD^ = sA
        fgit5(['add', '-A']);
        fgit5(['commit', '-q', '-m', 'T']);
        const attCli = (extra) => cli(['--repo', fk5, '--baseline', baseAllFile, '--changed-since', sA, '--effective-none', 'x', ...extra]);
        const att0 = attCli([]);
        const att1 = attCli(['--s-registry-attest', '  已用旧版读取器核对  ']);
        const att2 = attCli(['--s-registry-attest', '   ']);
        const RC = ['wbs-server/package.json'];
        const rsA = effList.resolveSRegistry(fk5, sA, { changedPaths: RC, attest: '核对过' });
        const rsNone = effList.resolveSRegistry(fk5, sA, { changedPaths: RC, attest: null });
        const rsClean = effList.resolveSRegistry(fk5, sA, { changedPaths: ['docs/a.md'], attest: null });
        const sB = attestCase('B', { oldReader: true, oldIds: [...idsList(fids1), { group: 'api', id: '只有旧版读出' }] });
        const rsB = effList.resolveSRegistry(fk5, sB, { changedPaths: RC, attest: '核对过' });
        const sC = attestCase('C', { oldReader: true }); // 旧版读取器脚本在，但读不出（退出码 3）
        const rsC = effList.resolveSRegistry(fk5, sC, { changedPaths: RC, attest: '核对过' });
        const sC2 = attestCase('C2', {}); // <S> 树里根本没有旧版读取器脚本
        const rsC2 = effList.resolveSRegistry(fk5, sC2, { changedPaths: RC, attest: '核对过' });
        const sD = attestCase('D', { oldReader: true, oldIds: idsList(fids1), breakNew: true }); // 新版读取器读不了这棵树，旧版读得出
        const rsD = effList.resolveSRegistry(fk5, sD, { changedPaths: RC, attest: '核对过' });
        const sE = attestCase('E', { oldReader: true, breakNew: true }); // 两个读取器都读不出
        const rsE = effList.resolveSRegistry(fk5, sE, { changedPaths: RC, attest: '核对过' });
        const digestFids1 = effList.keysDigestOf(idsList(fids1));
        check(att0.status === 1 && /登记读取器漂移：登记读取逻辑在本次改动内/.test(att0.stdout) && !/<S> 时登记摘要/.test(att0.stdout), '96 HIGH-3：没有 --s-registry-attest 时读取器漂移门照旧拒绝（不读 <S> 时登记）');
        check(/<S> 时登记摘要：sha256 [0-9a-f]{64}；11 条；来源 新旧读取器结果全等/.test(att1.stdout) && /--s-registry-attest "已用旧版读取器核对"/.test(att1.stdout) && !/--s-registry-attest "  /.test(att1.stdout) && att2.status === 2 && /--s-registry-attest 的理由不能是空白/.test(att2.stderr), '96 HIGH-3 + 95 MEDIUM（第 ① 步）：给了理由 → 工具自动再用 <S> 树自带的读取器读一遍，两份编号集合全等 → 记录理由继续、输出摘要（sha256 / 条数 / 来源）；理由在参数解析时统一 trim（输出里是 trim 后的值）、空白理由 → 用法错误');
        check(rsA.problems.length === 0 && rsA.list.length === 11 && /新旧读取器结果全等/.test(rsA.digest.source) && rsA.digest.sha256 === digestFids1 && rsA.drift === true && rsNone.list === null && rsNone.problems.length === 1 && /须人工核对 <S> 时登记/.test(rsNone.problems[0]) && rsClean.problems.length === 0 && rsClean.drift === false && /当前读取器/.test(rsClean.digest.source) && rsClean.digest.sha256 === digestFids1, '96 HIGH-3（resolveSRegistry）：新旧读取器全等 → 采信、来源「新旧读取器结果全等」、摘要 = 编号集合的 sha256；没有声明 → 拒绝且不读；读取器链路不在改动里 → 用当前读取器、不需声明（来源「当前读取器」）');
        check(rsB.problems.length === 0 && rsB.list.length === 12 && rsB.list.some((x) => x.id === '只有旧版读出') && /旧版读取器（<S> 树自带/.test(rsB.digest.source) && rsB.digest.sha256 !== digestFids1 && rsB.printed.some((l) => /不同[^\n]*只有旧版读出 1 条/.test(l)), '96 HIGH-3（resolveSRegistry）：新旧读取器读出的编号集合不同 → 增删核对以旧版读取器读出的为准（12 条，含只有旧版读出的那条），摘要对应旧版结果、来源「旧版读取器」，新版结果只作对照打印');
        check(rsC.list === null && rsC.digest === null && rsC.problems.length === 1 && /<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理/.test(rsC.problems[0]) && rsC2.list === null && rsC2.digest === null && rsC2.problems.length === 1 && /<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理/.test(rsC2.problems[0]) && /读取器脚本不存在/.test(rsC2.problems[0]), 'U1 裁定（resolveSRegistry）：<S> 树自带的旧版读取器不可用（假仓库 <S> 树里脚本在但退出码 3 / 脚本根本不在，即没有 --ids-only 入口）→ 一律拒绝并提示「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」（新版读得出也拒）');
        check(rsD.problems.length === 0 && rsD.list.length === 11 && /旧版读取器（<S> 树自带/.test(rsD.digest.source) && rsD.printed.some((l) => /新版读取器读不了/.test(l)) && rsE.list === null && rsE.problems.length === 1 && /<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败）[^\n]*新版读取器也读不了/.test(rsE.problems[0]), '96 HIGH-3（resolveSRegistry）：新版读取器读不了这棵树、旧版读得出 → 以旧版结果继续（填理由后有出路）；两个读取器都读不出 → 拒绝');
        // 98 号 MEDIUM（runReader 逐项校验）：新版读取器输出里有非法元素（null / 缺 group 或 id / 空串 / 重复）→ ok:false 走回退分支，不抛异常；旧版读取器正常 → 采信旧版（newReaderScript 是只给自检用的库函数参数）
        const badReaders = {
            nullEl: '{"format":"sysbuild-registry-ids/1","ids":[null,{"group":"api","id":"A1"}],"loaded":[]}',
            noId: '{"format":"sysbuild-registry-ids/1","ids":[{"group":"api"}],"loaded":[]}',
            emptyId: '{"format":"sysbuild-registry-ids/1","ids":[{"group":"api","id":""}],"loaded":[]}',
            dup: '{"format":"sysbuild-registry-ids/1","ids":[{"group":"api","id":"A1"},{"group":"api","id":"A1"}],"loaded":[]}',
            arrEl: '{"format":"sysbuild-registry-ids/1","ids":[["api","A1"]],"loaded":[]}',
        };
        const readerRes = {};
        for (const [name, body] of Object.entries(badReaders)) {
            const script = path.join(dir, 'bad-reader-' + name + '.js');
            fs.writeFileSync(script, "const a=process.argv;require('fs').writeFileSync(a[a.indexOf('--ids-only')+1], " + JSON.stringify(body) + ');\n');
            let withOwn = null;
            let withOwnErr = null;
            let noOwnErr = null;
            try { withOwn = effList.registryAtCommit(fk5, sA, { ownReader: true, newReaderScript: script }); } catch (e) { withOwnErr = e; }
            try { effList.registryAtCommit(fk5, sA, { newReaderScript: script }); } catch (e) { noOwnErr = e; }
            readerRes[name] = { withOwn, withOwnErr, noOwnErr };
        }
        const rd = (n) => readerRes[n];
        check(Object.keys(badReaders).every((n) => rd(n).withOwnErr === null && rd(n).withOwn && rd(n).withOwn.keys === null && rd(n).withOwn.ownReader && rd(n).withOwn.ownReader.ok === true && rd(n).withOwn.ownReader.keys.size === 11 && !(rd(n).noOwnErr instanceof TypeError) && rd(n).noOwnErr !== null) && /第 1 个元素不是 \{ group, id \}/.test(readerRes.nullEl.withOwn.newReaderError) && /第 1 个元素不是 \{ group, id \}/.test(readerRes.noId.withOwn.newReaderError) && /第 1 个元素不是 \{ group, id \}/.test(readerRes.emptyId.withOwn.newReaderError) && /第 1 个元素不是 \{ group, id \}/.test(readerRes.arrEl.withOwn.newReaderError) && /重复出现/.test(readerRes.dup.withOwn.newReaderError), '98 MEDIUM（runReader 逐项校验）：新版读取器输出含 null / 缺 id / 空串 id / 数组元素 / 重复编号 → 不抛异常（旧版 .map 直接 TypeError，旧版读取器也不运行）、新版 keys = null 并报具体原因，旧版读取器照常读出 11 条（回退分支可用）；不带旧版读取器时按「读十组登记失败」报错而非 TypeError');
        const rdFall = effList.resolveSRegistry(fk5, sA, { changedPaths: RC, attest: '核对过' });
        check(rdFall.problems.length === 0 && rdFall.list.length === 11, '98 MEDIUM（对照）：新旧读取器都正常时 resolveSRegistry 照旧采信（11 条），逐项校验不误拒真实输出');
        // MEDIUM：累计去向表整表——正式闸门每一行都须带非空「提交」（含 --effective-none 分支）；独立查询保留旧表兼容
        const dispNoC = path.join(dir, 'disp-nocommit.json');
        fs.writeFileSync(dispNoC, JSON.stringify([{ group: 'api', id: 'A1', 去向: '旧表，没有提交字段' }]));
        const dispWithC = path.join(dir, 'disp-withcommit.json');
        fs.writeFileSync(dispWithC, JSON.stringify([{ 提交: 'C2', group: 'api', id: 'A1', 去向: '带提交' }]));
        const tb0 = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', k2, '--effective-none', 'x', '--dispositions', dispNoC]);
        const tb1 = cli(['--repo', fk2, '--baseline', baseAllFile, '--changed-since', k2, '--effective-none', 'x', '--dispositions', dispWithC]);
        const tbq = cli(['--query-baseline', baseAllFile, '--dispositions', dispNoC]);
        const dtp = (rows, o6) => effList.dispositionTableProblems(rows, o6);
        const rows4 = [{ group: 'a', id: '1' }, { group: 'a', id: '2', 提交: ' ' }, { group: 'a', id: '3', 提交: 'C2', 处置类别: 'x' }, { group: 'a', id: '4', 处置类别: 'stop-only' }];
        check(/去向表不通过：累计去向表第 1 行[^\n]*缺非空的「提交」/.test(tb0.stdout) && tb0.status === 1 && !/去向表不通过/.test(tb1.stdout) && !/去向表不通过/.test(tbq.stdout) && dtp(rows4).length === 3 && dtp(rows4, { skipRetireRows: true }).length === 2 && dtp([]).length === 0, '96 MEDIUM：--effective-none 分支也核累计去向表整表——有一行没有「提交」→ 退出码 1 并指出行号；全部带提交 → 不报；独立查询（--query-baseline）收旧表、不报；纯函数：缺 / 空白提交各报一条，skipRetireRows 跳过带「处置类别」的行（文件模式由 retireDispositionProblems 报）');
        // 94 LOW：清理遇到占用继续清其余文件并汇总（模拟其中一个文件删不掉）
        const rmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-rmbe-'));
        fs.mkdirSync(path.join(rmRoot, 'd'), { recursive: true });
        for (const f of ['a.txt', 'd/b.txt', 'd/locked.txt', 'd/c.txt']) fs.writeFileSync(path.join(rmRoot, ...f.split('/')), f);
        const realUnlink = fs.unlinkSync;
        fs.unlinkSync = (p) => { if (String(p).endsWith('locked.txt')) { const e = new Error('EBUSY: resource busy or locked'); e.code = 'EBUSY'; throw e; } return realUnlink(p); };
        let rmResidue;
        try { rmResidue = effList.removeTreeBestEffort(rmRoot); } catch (e) { rmResidue = []; } finally { fs.unlinkSync = realUnlink; }
        const leftNow = [path.join(rmRoot, 'd', 'locked.txt'), path.join(rmRoot, 'a.txt'), path.join(rmRoot, 'd', 'b.txt'), path.join(rmRoot, 'd', 'c.txt')].map((f) => fs.existsSync(f));
        try { removeTree(rmRoot); } catch (e) { /* 收尾 */ }
        check(rmResidue.some((x) => /locked\.txt$/.test(x.path) && x.error === 'EBUSY') && leftNow.join() === 'true,false,false,false', '94 LOW：清理时 locked.txt 删不掉（EBUSY）→ 不终止遍历：其余文件（a / b / c）都已删，残留只有 locked.txt，汇总进返回值');
    } finally {
        try { removeTree(dir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + dir + ' — ' + e.message); }
    }
    console.log(`\n${ok}/${total} 通过`);
    return ok === total ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { extractRegistry, scanCaseNames, normalizeGroup, checkEntry, makeCtx, findDuplicates, toIdList, compareBaseline, idsOfRegistry, run, main, GROUP_DEFS, ALL_GROUPS };
