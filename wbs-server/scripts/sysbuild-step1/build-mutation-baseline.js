'use strict';
// #212 第一步（C1c）工具：变异机器基线生成与对比。
//   方案 5.4「失败位置基线」：未改动的产品代码上，十组变异自检每条变异一行——组、id、目标文件、所属用例、判定、失败明细
//   （失败的用例名 / 错误类名 / 失败信息首行 / 抛出位置 / 浏览器与部署的失败标签原文）。之后每个提交与 C9 拿它做对比，
//   发现「变异还在、还判红，但失败已经从业务断言挪到了搭数据阶段」。
//   本脚本不改被测代码；唯一的写操作是 --raw-dir 下的原始日志与 --out 指定的基线文件。跑自检要起子进程（各驱动自己起临时实例，不碰 3000，不写业务库与线库）。
//
// 用法：
//   node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js [--groups a,b] [--raw-dir <目录>] [--out <基线 json>]
//        依次跑所选组（默认十组）的自检命令，子进程环境带 SYSBUILD_MUT_RECORD=1，原始输出逐组存 <raw-dir>/<组>.log（旁边 <组>.meta.json 记命令、退出码、起止时间），
//        再解析 @@MUT 行、与 mutation-check 的清单反向对账，写出基线。不带 --raw-dir 时原始日志写 <仓库>/tmp/c1c/raw-<YYYYMMDDHHmmss>/（已存在则报错，不覆盖）；
//        不带 --out 不写基线（只在 stdout 报结果）。任一驱动的退出码非 0 也判不通过（读 <组>.meta.json，没有 meta 的目录不查）。
//        给了 --out 时同时写来源清单 <基线同目录>/<基线文件名去 .json>.provenance.json（--provenance <路径> 可改文件名，但必须与基线同目录，否则用法错误；自检钩子 noProvenance 不写，命令行没有这个参数），并把它的 sha256 存进基线顶层 provenanceSha256。
//        来源清单的内容与「拒绝生成」条件见下面「来源清单（HIGH-2）」一节。
//        --parallel-browser：浏览器组单独一路、其余组按顺序一路，两路同时跑（同一个 raw-dir 与来源快照；十组顺序跑约 1.9 小时，两路约 1 小时）；新生成的来源清单里记 parallelBrowser。
//   --parse-only <raw-dir>                     只解析已有的原始日志，不跑
//   --compare <基线 json> [--disposition <json>] [--report <json>]
//        用当前一次运行（或 --parse-only）与基线逐条比；分「相同 / 变了且已登记 / 变了且没登记」三类，没登记的出现即退出码 1。
//        disposition = [{ group, id, 去向 }]，与 mutation-check 的 --disposition 同格式。
//        「相同」里再单列「需人工复核」（MED-3 / 71 号 HIGH-3 后半句：判等键分不出来的三类，不能自动判同）：同一抛出行有多个断言（按行内 assert 调用次数 ≥ 2 判）；
//        frames[1]（直接调用方）≠ caseSite（caseSite 非 null 且不是抛出行本身）；caseSite 为 null（不含守卫类）。判等键本身不变。「需人工复核」只是提示，不改变退出码；
//        普通对比（不带 --require-review-dispositions）只用于 C9 全量对比：这里「需人工复核」只是提示，是否在去向表里登记处置由 C9 按方案做（--disposition 里给 group / id / 去向，登记过的会带上「去向」），本模式不强制；输出会单列计数、分布与清单。
//        每个提交都走下面的三步闸门（含 --effective / --effective-none），闸门（--require-review-dispositions）下才强制登记与生效清单核对，不要拿普通对比当提交闸门。
//        守卫类失败（errorClass = GuardFail，static / deploy，没有栈、caseSite 恒为 null）单列一类 guardNoStack，不算 caseSiteNull、不进需人工复核：它们靠「规则 + 文件 + 信息」识别（信息里带 FAIL [Sx] 文件:行 或失败标签原文，已在判等键里），输出里分开计数。
//        --compare 默认要求基线带来源清单（MED-1）：没有清单直接不通过，只有自检钩子 allowNoProvenance（命令行没有这个参数）才放行，且只放行 provenanceFile 与 provenanceSha256 都为 null 的基线（只剥掉其中一个的仍拒）；基线顶层汇总（各组 total / red / …）从 entries 重算后逐项比对，
//        headCommit / headCommitAtRunStart / runAt / workingTreeDirty / env / 各组登记数与 id 序列哈希与清单里的值逐项比对，任一不一致即不通过。输出会打印清单的 mode（run / parse-only）。
//   --affected <基线 json> --changed-since <S> [--affected-out <目录>]    只读基线：按现行受影响范围口径列出全部受影响条目（其中需人工复核的另计一类），并给出自动范围的复验命令；不看日志、不跑驱动。
//        现行口径 = 文件交集（目标文件 / 失败用例定义文件 / 失败栈帧文件与 <S>..HEAD + 工作区改动相交）∪ 组测试侧改动（该组全部条目）∪ 产品侧组级触发（routes/sysbuild 的 index.js / db.js / schema.js / migration-schema.js、server.js、wbs-server/utils/**）
//        ∪ 零目标兜底（routes/sysbuild/** 或 public/** 下没有任何变异以它为目标的改动文件 → api + browser 整组）。不给 --effective / --effective-none 时只列这一部分（整份基线）。
//        给了 --effective <EFF> 或 --effective-none "<理由>"（MED-1）：直接调用 rerunPlan，按来源（自动范围 / mustRun / by / remount / added）分开打印与 --rerun 同口径的完整复验集合，自动范围为空时也打印；
//        这时「兜底触发」按「基线 ∩ 当前登记」（去掉已不在登记里的编号：本提交 retire 的与以前提交删掉的）计算（只被已删变异当目标的文件，删除之后没有变异保护它，走兜底），自动范围里也不含它们。--rerun 的复验集合 = 自动范围 ∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号 ∪ added（当前登记有、<S> 时登记没有的全部编号），去重。
//   --affected <基线 json> --changed-since <C1 提交> --cumulative --rerun-dir <C2 复验目录> --rerun-dir <C3 复验目录> … --effective <C2 清单> --effective <C3 清单> …（文件模式留档必带，none 模式不带）   C9 累计范围（84 号 MEDIUM；89 号 MEDIUM 重写）：
//        读各提交第 ② 步留档的 <复验目录>/rerun.json（format sysbuild-rerun/3：提交名、生效清单模式 / sha256、该提交的 retire / added、每组复验计划 auto / mustRun / by / remount / added / runIds（plannedIds）、
//        实跑编号 ranIds（复验结束后按第 ③ 步同口径从各组日志解析：日志里实际有结果行的仍登记编号；非 api 组整组跑出的计划外编号另列 outOfPlanIds，来源标「整组实跑」；空计划写空集合）、结束记录 complete / ignoredInputsEnd、各组驱动退出码）
//        按实跑编号还原每个提交实际复验过的编号（含自动范围纳入的与整组实跑跑出的；95 号 HIGH-2），
//        按提交顺序逐份列出、逐编号输出命中来源（<提交名>:<来源>）；再与「净改动自动累计范围」（基线 ∩ 当前登记，按 <C1 提交>..HEAD + 工作区的改动算，加 C1 之后新增的现行编号）取并集。旧口径只用净改动 + 各清单必跑编号：一条含糊变异在 C3 因目标文件改动被自动纳入、C5 又把文件改回去、
//        历次清单也没列为必跑，净改动里它「从未受影响」，C9 会漏掉对它曾登记过的三字段的复核。需留档的文件：每个提交第 ② 步的 <复验目录>/rerun.json（必须；其余文件不参与本命令）。--rerun-dir 0 份 = 拒绝（用法错误）；目录里没有 rerun.json / 不是 sysbuild-rerun/3 格式（旧版本留档一律拒收，不兼容旧格式：C2 之前没有正式留档）/ 没有结束记录（complete）= 拒绝（退出码 1）；
//        --effective（95 号 MEDIUM；97 预筛 M2 起文件模式必带）：留档里只要有文件模式（非 none）的记录，就必须按留档顺序为每份文件模式留档各带一份 --effective（个数 = 文件模式留档数，不足即拒：「C9 必须为每份文件模式留档按顺序带 --effective；漏带时无法识别同一父提交下清单改过的前一轮」，因为生效清单多是被忽略 / 仓库外的输入、树指纹不覆盖它）；无清单模式 --effective-none 的留档没有清单文件，跳过、不占位；核对 rerun.json 记的清单 sha256 是同一份；多余也拒。追溯按提交顺序逐支：某提交复验过的编号 X，从下一个提交起逐个看各提交的 retire——remount 追到 newId、equivalent 追到 by 的每一支、stop-only 记「已无承接」；
//        每一支单独走到底、单独输出（仍在当前登记 / 已无承接 / 已不在当前登记且各留档里没有 retire 记录），不因另一支仍在就省略已断的支；编号复用（先 retire、后又作新增 / newId 登记）时旧编号的证据在被 retire 的提交就结束、不串到新编号，工具输出警告要求人工核对。
//        提交链核对（预筛 MED-1，cumulativeChainProblems）：各份 rerun.json 按链衔接——第 1 份的 changedSince = --changed-since（C1 提交）；第 i 份的 changedSince 必须是第 i−1 份 context.startHead 本身或它的直接子提交；最后一份的 startHead 是 HEAD 本身或 HEAD 的直接父提交；
//        95 号 HIGH-1：每份留档自身只许覆盖一个提交（提交前跑：startHead = changedSince；提交后补跑：startHead 是 changedSince 的直接子提交；误把 C1→C4 的一次补跑当唯一留档，首尾都对得上也拒），
//        再把每份映射到一个实际提交（提交前跑 = startHead 之后的下一个提交，startHead = HEAD 时是还没提交的工作区、只许最后一份；提交后补跑 = startHead 本身），沿 <C1>→HEAD 的提交序列（git rev-list --reverse --ancestry-path，含合并提交则拒）逐个核对，报告首个缺份或重复的提交。
//        断链 / 重叠 / 一份跨多个提交 / 漏传中间一份 / 尾部漏份（列出最后一份之后到 HEAD 之间没有留档的提交）一律拒（退出码 1）。前提：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick（提交号变了接不上链）；每个提交（含工具、文档提交）都须留第 ② 步复验目录（空计划也留）；C1–C9 保持线性历史（98 号 HIGH：正式闸门拒绝进行中的合并、HEAD 是合并提交、<S> 本身是合并提交；更早的合并提交闸门看不到，只能由本命令的链核对拦；线分支同步 main 用 rebase 且只在 C9 之后）。
//        97 号 HIGH（留档绑定内容）：第 ③ 步全部通过时在复验目录写通过凭据 gate-pass.json（待提交树指纹 + rerun.json 的 sha256 + <S> + 清单 sha256 / none 理由；writeGatePass）；链核对通过后 C9 对每份留档核凭据（cumulativeGatePassProblems / gatePassProblems）：
//        凭据必须在、rerun.json 的 sha256 一致、<S> / 起始 HEAD / 提交名 / 清单口径与 rerun.json 一致，凭据里的树指纹（改动集里每个路径的 [路径, git 文件模式, blob 号]，排除项不算）与映射到的实际提交的树逐项相同、该提交的改动集路径与凭据一致；末尾映射到还没提交的工作区的那份与当前暂存区比。
//        同一父提交下跑过两轮、都过了第 ③ 步而只有后一轮入库时，传前一轮的目录 = 拒。97 号 MEDIUM：留档结构（plannedIds / ranIds / outOfPlanIds / results 的组键、去重后的字符串数组）由 rerunStructureProblems 与第 ③ 步共用；计划编号缺结果行 = 该留档不完整，拒（退出码 1），不再只打警告。
//        本命令不核各复验目录对应提交的第 ③ 步里的三字段登记等人工项：命中的逐条核对各提交留档的三字段登记在最终代码上是否仍适用。
//        C9 用法：只有「各提交实际复验过的编号」与「净改动自动累计范围」两边都没命中的需人工复核条目，才可按「从未受影响」处理；命中的逐条核对各提交留档的三字段登记在最终代码上是否仍适用；已无承接 / 留档不全 / 编号复用三类输出都要人工核对。不带 --cumulative 的 --effective 只许给一份。
//        <S> 时登记（84 号 MEDIUM-2 / 85 号 HIGH-2）：编号增删（retire / added / newId）按 <S> 提交时点的登记核对，不再按固定 C1 基线——固定基线只用于失败位置对比、需人工复核分类与受影响范围。<S> 时登记由 effective-list.js registryAtCommit 在 <S> 的内容上真跑登记读取函数得到（不 checkout）。
//   --compare … --dispositions <累计去向表 json> --require-review-dispositions --changed-since <S>   受影响子集登记闸门（codex 79 号 HIGH-2；口径见「受影响子集登记闸门」一节，--help 同文）
//        --dispositions 与 --disposition 同义。闸门下比较范围 = 日志里实际有记录的变异（api 过滤子集 / 其余各组按组全跑）。
//   每个提交的固定命令序列（主会话抄进方案；<EFF> = 本提交的生效清单 json，格式见 effective-list.js 头注释；没有生效清单的提交用 --effective-none "<理由>" 代替 --effective <EFF>）：
//     ① node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <fixtures 里的基线 json> --changed-since <S> --dispositions <累计去向表> --effective <EFF>            编号不丢（提交闸门：--changed-since 与 --effective / --effective-none 二选一都必须给）；
//        <S>（96 号 HIGH-1）：正式闸门（第 ①②③ 步，含 --affected 带清单）只许是 HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（三步在提交之后补跑），更早的祖先 = 用法错误；累计查询（--affected … --cumulative、不带清单的 --affected）保留任意祖先。
//        运行的脚本必须位于 --repo 内（96 号 MEDIUM 降级项；跨检出调用 = 用法错误）。本工具的流程约束：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick；每个提交（含工具、文档提交）都留第 ② 步复验目录（空计划也留），每份留档只覆盖一个提交。
//        按 <S> 时登记核对：retire 的编号确已从登记里消失且 <S> 时有、added ∪ remount newId = 当前登记 − <S> 时登记、by / remount 新编号确已登记、retire 的去向行带对应处置类别；没有生效变异的提交把 --effective <EFF> 换成 --effective-none "<理由>"（适用范围见下）。
//        不带清单的独立查询入口是 mutation-check.js --query-baseline <基线> [--dispositions <累计去向表>]，不是提交闸门。
//     ② node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --affected <基线> --changed-since <S> [--affected-out <目录>]   先列受影响条目（全部受影响 / 其中需人工复核 两类计数）与每组复验命令（只列自动范围，不含生效清单）；
//        node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <基线> --changed-since <S> --effective <EFF> --dispositions <累计去向表> [--report <报告>]   由本工具真跑（H1：手工跑驱动、旧日志都过不了闸门）：
//        没有生效清单的提交：… --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <基线> --changed-since <S> --effective-none "<理由>" --dispositions <累计去向表> [--report <报告>]。（--dispositions 传与第 ③ 步相同的累计去向表路径；--report 单列可选；仓库内的补写路径必须第 ② 步预声明）
//        <新目录>（--raw-dir）在仓库里只许落在 tmp/ 下（或放到仓库之外），在仓库里其他位置 = 用法错误（89 号 HIGH-1：否则整个目录前缀从改动集里剔除，复验目录指到产品目录就藏住了那里的改动）；--dispositions / --report 在第 ② 步只声明「复验之后才补写的产物路径」（不读取），
//        连同 <新目录> 记进每组 meta.exclusions（与源码 / 驱动 / 登记 / 基线 / 清单路径重叠的拒绝）；第 ③ 步只认这份记录，当次新增的排除项一律拒绝。每组 meta 另记：改动集里每个路径的工作区 / 暂存区内容指纹（changedStage）、被忽略的运行输入摘要
//        （.sdh-instance 内容 sha256、线库 sha256、.env 白名单键存在性——子集复验也采集；跑完再取一次，复验期间变了本次不可信，退出码 1）、读取器漂移的人工声明（--s-registry-attest，解析时统一 trim）与 <S> 时登记的编号摘要（sRegistry：sha256 / 条数 / 来源，96 号 HIGH-3，第 ③ 步核同一份）。
//        rerun.json（format sysbuild-rerun/3）记提交名 / retire / added / 每组复验计划（plannedIds）/ 实跑编号（ranIds，复验结束后按第 ③ 步同口径从日志解析；计划外的整组实跑编号另列 outOfPlanIds；空计划写空集合）/ 驱动退出码 / 运行上下文 / 结束记录（complete、ignoredInputsEnd）（C9 累计范围读它）。
//        复验集合 = 自动范围（不含已不在登记里的编号）∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号 ∪ added（当前登记有、<S> 时登记没有的全部编号，来源记 added）（R1，codex 81 HIGH-1 / HIGH-2 与预筛 HIGH-1）；meta 记生效清单 sha256 与按来源列出的并集；
//        复验集合为空时也写复验目录：rerun.json + empty-plan.json（绑定 HEAD、改动文件集合 sha256、生效清单 sha256 或 none 理由、起始时刻），第 ③ 步重算后放行（MED-2）；写空计划之前目录里已有任何组日志 / meta / api.ids.json / 计划文件都拒绝（84 号 LOW-1）；
//        --effective 与 --effective-none 二选一，两个都不给 = 拒绝（硬门，不放行）；清单本身先过 schema 校验（编号须在 <S> 时登记 / 当前登记里、类别枚举、equivalent 的 by 非空且不含被删编号自身、重复编号与重复对象键拒绝、<S> 时登记里有而当前登记里没有的编号必须全在 retire 里），不过就不跑；
//        --effective-none 适用范围（84 号 HIGH-3，第 ②③ 步与 --affected 共用 effective-list.js noneModeProblems）：改动集（<S>..HEAD + 未提交 + 未跟踪，与 changedFilesSince 同口径）只许落在 wbs-server/scripts/sysbuild-step1/**（闸门工具目录自身，改工具的提交由 codex 审工具兜底）、docs/**、仓库根目录的 *.md 里（其余位置的 .md、fixtures 走清单）；全空清单必须带非空 reason 字段（见 effective-list.js）；registryAtCommit 用当前版本的 mutation-check 与当前 node_modules 读 <S> 时登记文件；
//        产品代码（routes / public / server.js / wbs-server/routes/sysbuild/schema.js）、测试驱动与套件（verify-*.js、scripts/lib、sysbuild-predeploy）一律不许用 --effective-none，涉及产品或测试行为的改动要给生效清单，由人确认受影响的变异；
//        api 用 `--mutation-ids` 只跑受影响编号（驱动支持按编号只跑，过滤模式）；其余各组驱动没有按编号只跑的参数（核过 browser / static / schema / db / attachments / migration / deploy / archive / readonly 的参数表），只能整组跑；
//        每组写 <组>.meta.json：起始 HEAD、工作区状态、改动集里每个文件的 sha256、起止时刻、命令（SYSBUILD_MUT_RECORD=1 与 NODE_OPTIONS=--stack-trace-limit=80 由工具设置）
//        受影响（H2）= 条目的目标文件 / 失败用例定义文件 / 失败栈帧文件与改动集有交集（守卫类同样按文件交集算），或所在组的测试侧文件有改动（该组全部条目）；不限需人工复核，「需人工复核」只决定要不要三字段登记。
//     ③ node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <基线> --dispositions <累计去向表> --require-review-dispositions --changed-since <S> --effective <EFF>
//        没有生效清单的提交：… --parse-only <第 ② 步的 --raw-dir> --compare <基线> --dispositions <累计去向表> --require-review-dispositions --changed-since <S> --effective-none "<理由>"（理由与第 ② 步一致）；人工声明过读取器漂移的再加 --s-registry-attest "<同一份理由>"。
//        暂存区门（89 号 HIGH-2；95 号 MEDIUM）：改动集里每个路径在暂存区与工作区内容必须一致（先 git add，或撤销暂存让两边回到同一份），且暂存 blob 与第 ② 步记录的工作区 blob 一致——不论第 ② 步时该路径是否已暂存（没暂存是正常流程，
//        Git 清理过滤结果变了时原始字节相同也不能证明待提交的 blob 就是复验时的；是否已暂存只影响提示语；git 文件 mode 变化也算）——放行的就是将要提交的内容；符号链接 / 子模块遇到时明确报「不支持的文件类型」；第 ② 步之后路径从改动集消失 / 新出现 / 内容变了、
//        暂存内容与复验过的内容不同，都拒（路径比较用 Map，空计划与非空计划共用 compareChangeSnapshot）。被忽略的运行输入摘要（.sdh-instance / 线库 / .env 键）与第 ② 步记录不一致 → 拒。排除项只认第 ② 步记录的（见上）。
//        非空复验（目录里有 <组>.log）的 rerun.json 结束记录（rerunJsonEndProblems）：必须可读、format sysbuild-rerun/3、complete = true、与本次运行匹配（--changed-since / 起始 HEAD / 提交名或 none 理由 / 组集合）、ignoredInputsEnd 与各组 meta 里复验开始时的摘要一致、ranIds 与第 ③ 步从日志现算的一致，缺失 / 不可读 / 不匹配 → 拒；
//        <S> 时登记的编号摘要（96 号 HIGH-3）与第 ② 步记录一致；累计去向表每一行都须有非空「提交」（96 号 MEDIUM，含 --effective-none 分支）；本提交新增 / 改挂的编号只接受「提交」= 本次的三字段行，其余沿用历史行以该编号最后一条退役行为界（95 号 MEDIUM）。
//        第 ③ 步的受影响总数与范围外缺项统一从第 ② 步的复验计划（plan.aff）取数，当次日志把受影响范围扩大了的另报「补充命中」（95 号 LOW）。
//        同一编号既有合格命中（可作证据的失败）又有装载异常（SyntaxError / 模块装载失败）→ 单列拒绝（mixedLoadExceptionProblem；errorClass 为空的运行器超时不算装载异常）；承接编号同样。
//        第 ③ 步的 --effective <EFF>（或 --effective-none "<理由>"，理由写进输出与 meta）必须给，与第 ② 步用同一份；两个都不给 = 拒绝。带 --effective 时逐条核对（R1）：
//          mustRun / by / remount 新编号必须出现在本次复验——meta.effective.runIds（meta 绑定的编号）里有、日志里有结果行，缺一条拒绝；
//          生效清单文件 sha256 必须与 meta.effective.sha256 一致（防换清单），meta 记的复验集合 = 现算的并集；
//          equivalent 的每个承接编号：该组驱动日志里的未变异基线行存在且全绿（未变异通过）、当次运行判红且有可作证据的失败（变异后被抓住）、登记行的「承接命中证据」对得上它的一个失败；
//          去向表是跨提交累计的一份文件（C2、C3… 逐提交追加），每行必带「提交」字段（值 = 该提交生效清单的 commit）；退役类核对只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等，其他提交的退役行忽略；
//          「变了 / 需人工复核」的三字段登记可引用任何提交的行，同一编号可有多行，命中证据必须与当次失败对得上（前序登记过、本次失败没再变化的沿用旧行；失败再次变化的须补新行，旧行证据对不上就拒）；
//          retire 的每个旧编号在去向表里恰好一行，带对应的「处置类别」与该类别要求的字段（stop-only 删除依据；remount 现行编号；equivalent 现行编号 / 等价业务错误 / 承接命中证据）；
//          <S> 时登记里有、当前登记里没有的编号必须与 retire 全等；当前登记里有、<S> 时登记里没有的编号必须与 added ∪ 全部 remount newId 全等（--effective-none 时两者都必须为空，且改动集在 none 白名单内）；
//          新增变异（added / remount 新编号）每条都要在 runIds、日志有结果行、当次判红且失败不是夹具失败 / 装载异常，并按通用闸门做三字段登记与命中证据核对；
//          日志里有结果行的每个仍登记编号——自动范围、一般 mustRun、by、added、newId 全部都算，非 api 组整组跑时复验集合之外的条目也算（S1 裁定，qualifiedResultProblems）——都要有合格结果：日志有结果行、所在组驱动日志里的未变异对照行全绿、当次判红、失败不是夹具失败 / 装载异常；
//          存活（未判红）或只有夹具失败 / 装载异常 → 拒，不能靠去向表登记放行；确实要放弃守护的变异必须进 retire；「变了」只允许是判红但失败位置或信息变化（仍须三字段登记）（方案 v1.6 5.4 第 ③ 步）；
//          C1 之后新增的编号（当前登记有、固定基线没有）在后续提交里也进自动范围（不靠人写 mustRun）：用登记里的目标文件（各 edit 的文件，即定位字面量所在文件）参与文件交集，组级触发与零目标兜底同样适用（它们的目标文件也算「有变异保护」）；
//          它们没有基线失败位置，所以不分「需人工复核」、也不参与失败位置对比，第 ③ 步按「现在有基线没有」要求去向表三字段登记；
//          生效清单必跑编号（mustRun / by / newId / added）里基线属于「需人工复核」的条目并入三字段登记目标（业务步骤、未变异通过证据、变异后命中证据；84 号 HIGH-1），不论自动范围有没有命中它；
//          equivalent 的被删编号在基线里的失败与承接编号当次的失败并排打印（只供人工核对，不改判定）；
//          目录里没有任何 <组>.log：直接拒绝（用法错误，退出码 2）；唯一例外是 --rerun 写的空计划记录 empty-plan.json——重算计划确实为空且绑定一致才放行。
//        闸门逐组核对 meta：有 meta.json；起始 HEAD = 当前 HEAD；meta 记的完整改动路径集合与每个文件的 sha256 = 当前工作区——第 ② 步之后改动集里新出现的任何路径（含只被 mustRun / by 依赖、自动范围看不到的共用文件）、
//        记过的路径内容变了 / 又消失，一律不通过，须重跑第 ②③ 步（84 号 HIGH-2）；起始时刻可解析且晚于 <S>..HEAD 最晚提交时间。
//        复验之后才允许生成 / 补写的产物用显式排除名单（exclusionsOf），不计入改动集：① --raw-dir 复验目录（仓库里只许 tmp/ 下）② --dispositions 去向表登记 json（看完复验日志才补写命中证据）③ --report 报告；仅当它们落在仓库里才有意义（git 看不到仓库外的文件）。
//        第 ② 步声明并记录，第 ③ 步只认记录（exclusionsSubsetProblems）；与源码 / 驱动 / 登记 / 基线 / 清单路径重叠的排除项拒绝（exclusionProblems / effective-list.js protectedPathHit）。
//        其余路径都在核对范围内——生效清单本身也不在排除名单（第 ② 步必须已存在，内容另由 meta.effective.sha256 绑定）。工作区状态用 git status --porcelain=v1 -z（改名 / 复制两端都纳入）取；路径名单匹配不区分大小写（Windows），文件定位与哈希用路径原值。
//        --changed-since 必须是 HEAD 的祖先；就是 HEAD 且工作区干净时拒绝；S 写进闸门输出。顺序：先跑第 ③ 步（闸门过了），再提交——提交之后 HEAD 变了，meta 的起始 HEAD 就对不上当前 HEAD。
//        meta 与日志、组绑定（MED-1）：meta.group = 本组、meta.rerun = true、meta.argv 的脚本等于本组驱动、meta.log 的 sha256 / 字节数与当前日志一致；api 另核 api.ids.json 的 sha256 与内容（= 按 S 现算的复验集合：自动范围 ∪ 生效清单的 api 编号，有序去重）。
//        受影响还含产品侧组级触发与兜底触发（MED-2；名单与代价见 PRODUCT_GROUP_TRIGGER 的注释）。
//        证据核对（命中证据含失败用例名、信息首行前 60 字、caseSiteText#ord 或 siteText#ord）只证明「这条失败存在、指出了哪一步」，不证明它是业务断言——业务步骤由人核对，本工具不判。
//   十组全量复验只在 C1 与 C9 各跑一次。
//   --diff-runs <第二次的 raw-dir>             与 --parse-only / --raw-dir 给的第一次逐条对比，列出两次不一致的字段原文（归一规则的实验依据）；有判定 / 失败信息的差异 = 退出码 1
//   自检钩子（89 号 HIGH-3；用户 P-THREAT = A：诚实单用户，防遗漏与疏忽，不防有意构造输入的规避——规避类意见按 MEDIUM 处理，本轮只用两道低成本硬门收口，不再追加更复杂的防规避设计）：
//     --registry-file <json>（用文件里的 [{group,id,files,expect}] 代替 mutation-check 的清单；只给它、没给 sRegistryFile 时 <S> 时登记 = 基线编号）、--s-registry-file <json>（用文件里的 [{group,id}] 当 <S> 时登记）、
//     --allow-no-provenance（放行没有来源清单的基线）、--no-provenance（不写来源清单）——这四项不是命令行参数：命令行给了一律用法错误（退出码 2），--self-test 与任何别的参数同给也是用法错误；
//     只有自检内部调用 main(argv, hooks) 才能注入（selfSpawn 把自检里的这四项摘出来、用 node -e 载入本脚本调用 main）。正式运行的 <S> 时登记一律由 registryAtCommit 在 <S> 的内容上读。
//   --s-registry-attest "<理由>"                读取器漂移的人工声明（第 ②③ 步与 --affected 带清单时；见 effective-list.js 头注释「读取器漂移硬门」）：改动集含读取器链路文件（mutation-check.js、effective-list.js、依赖清单；只改套件 / 驱动 / 产品文件不触发）时 <S> 时登记不可自动信任，须给理由（解析时统一 trim、空白 = 用法错误）；给了理由时工具自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only）读一遍：两份全等 → 记录理由继续；
//                                              不同或新版读不了 → 增删核对以旧版读取器的编号集合为准（新版结果只打印对照）；<S> 树没有 --ids-only 入口、或新旧读取器都读不了 → 一律拒绝（「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」）。
//                                              依赖漂移的限度：只改依赖清单时，<S> 树的读取器与当前读取器共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住。
//                                              <S> = HEAD 的第一父提交（提交之后补跑）时另要求工作区干净（effective-list.js postCommitDirtyProblem，三步与 --affected 带清单共用；预筛 MED-1）：扣掉复验目录 / --dispositions / --report（声明的补写产物）后，不许再有未提交 / 未跟踪的路径，有就是用法错误；<S> = HEAD 时不核；--effective / 基线若被 HEAD 跟踪，工作区与暂存区内容都须与 HEAD 一致才豁免（98 号 MEDIUM；没被 HEAD 跟踪的独立输入照旧豁免）。
//                                              --rerun 必须给 --dispositions（预筛 LOW-3）；第 ② 步结束的「下一步」命令用 <DISP>，漂移时把同一份理由带出；第 ③ 步 rerun.json 结束记录另核记的生效清单（sha256 + commit / none 理由）与本次一致（预筛 LOW-2）。理由与所用编号摘要（sha256 + 来源）写进 meta / rerun.json / empty-plan.json，第 ③ 步要求与第 ② 步一致。
//   --rerun-dir <复验目录>                      C9 累计范围用（--affected … --cumulative，可重复，按提交顺序）
//   --self-test（只能单独给）
//   --repo <仓库根>                            可改根（默认本检出）。退出码：对账不过 / 有组没跑完 / 有未登记的变化 = 1；用法错误 = 2。
//
// 各组的自检命令（与 mutation-check 的十组登记一一对应）：
//   api         node wbs-server/scripts/verify-sysbuild-api.js --self-test                 过滤模式（不加 --full）
//   browser     node wbs-server/scripts/verify-sysbuild-browser.js --self-test
//   static / schema / db / attachments   node wbs-server/scripts/verify-sysbuild-<组>.js --self-test
//   migration   node scripts/sysbuild-predeploy/run-migration-self-test.cjs
//   deploy      node scripts/sysbuild-predeploy/verify-deploy-migration.cjs --script <仓库>/scripts/deploy-ssh.ps1 --self-test
//   archive     node scripts/sysbuild-predeploy/run-archive-self-test.cjs
//   readonly    node scripts/sysbuild-predeploy/verify-readonly.cjs --self-test           （run-readonly-self-test.cjs 只导出 run()，由 verify-readonly.cjs 提供临时实例环境后调用）
//
// 原始输出里的两种行（由 wbs-server/scripts/lib/sysbuild-mut-record.js 在 SYSBUILD_MUT_RECORD=1 时输出）：
//   @@MUT {group, id, verdict, failures:[{case, errorClass, message, site, label}], note?}   每条变异一行（父进程）；子进程里的 @@CASE 行由各驱动自己消化，不会出现在这里
//   verdict：判红 / 未判红 / 异常 / 锚点失败（驱动自己的结论，原样转录）
//
// 对比时的归一规则（只作用于 failures[].message；基线文件里存原文，规则在比较时才套用）。规则是做了「两次运行」实验后定的：
//   api、static、schema、db、attachments 五组各跑两次，凡两次不一致的字段才写成规则；每条规则的依据（两次的差异原文）见 C1c 报告。规则表就是下面的 NORMALIZERS，每条带一个例子，--self-test 逐条验。
//   failures 按 case + errorClass + 归一后的 message + label + siteText + siteOrd 比（order-insensitive，按多重集比较）。siteOrd = 这段文本在该文件里从头数是第几次出现（数到 site 那一行为止），
//   用来区分同一文件里文本相同的多条断言；siteText 与 siteOrd 都存进基线文件，--compare 时基线一侧用存下来的值，只对当前运行读源码。
//   已知残留（登记，不判定；不收列号、不重跑驱动）：同一行源码里有多个断言时（一行里连写好几个 assert），失败在它们之间挪动，siteText 与 siteOrd 都不变，判为相同；
//   这类失败（行内 assert 调用 ≥ 2 次）的条数不在注释里写死：以已提交基线的 --compare 输出为准（「需人工复核」按类计数里的「同一抛出行有多个断言」，已提交基线上是 63 条，来源 智数协同:docs/local/系统建设记录/送审准备/第一步C1证据_20261119/baseline-evidence/cmp-committed.out:27；口径是条目数，不是失败数 / site 数）——这批在 --compare 里另列为「需人工复核」（仍算相同、不改退出码；只是提示，登记由各提交按方案做）。
//   另：key 里不含文件路径，不同文件里「文本与序号都相同」的失败区分不开（汇总里「key 对应多个 site 的组数」就是数这个）。
//   【C1c 修订·HIGH-3 调用点】断言写在共用助手里（expectErr 里的 assert.strictEqual(r.status, …)、搭数据助手）时，site 记的是助手那一行，
//   调用方标签重复、或搭数据与目标操作走同一个助手时，失败从业务断言挪到搭数据阶段会被判「相同」。所以每条失败再记 frames（落目录的全部帧，由内到外，最多 12 个）
//   与 caseSite（用例体里发起失败调用的那一帧；认定办法与各驱动的运行器帧表见 lib/sysbuild-mut-record.js 头注释），判等键再加 caseSiteText#caseSiteOrd
//   （与 siteText 同口径：该行源码去空白、该文件里这段文本第几次出现）。caseSite 与 site 是同一行时记为 '='（只算一次）；caseSite 为 null（守卫类 / 运行器自己抛的 / 异常记录）记 null。
//   基线里存 frames、caseSite、caseSiteText、caseSiteOrd、runnerSeen，--compare 时基线一侧用存值。汇总里「key 相同但 caseSite 不同的组数」应为 0。
//   siteText = site（文件:行）那一行当前的源码文本（去首尾空白），
//   所以抛出位置的「行号」不参与判等（删代码时行号会移动），但「抛出的是哪一行代码」参与：失败从业务断言挪到搭数据那一行，siteText 会变。site 为 null 的组（static、deploy）siteText 为 null。
//   读不到文件或行号越界记 '<unreadable>'，在汇总里计数。siteText 在解析时按当前仓库读取，所以 --parse-only 对比的前提是被测套件文件在原始日志生成之后没有改过。
//
// 来源清单（HIGH-2）：基线只说「失败长这样」，不说「在什么代码上、怎么跑出来的」。--out 时同时写 <基线>.provenance.json。
//   拒绝生成的条件是集合级硬门（不按路径逐个放行；C1c 修订二，预筛 HIGH-2）：基线运行实际加载的不止 routes / public / server.js 与各驱动，还有 wbs-server/utils/*、lib/test-instance.js、
//   lib/listen-safe-port.js、scripts/lines/{line-proc,line-common,line-new}.js、wbs-server/package.json、temp-service/offline.html（见 listTestFiles）——这些都并入下面的 testFiles 逐个记哈希。
//   productTree   HEAD^{tree}（整棵树）、HEAD:wbs-server/routes/sysbuild、HEAD:wbs-server/public、HEAD:wbs-server/routes 的树对象号、HEAD:wbs-server/server.js 的 blob 号，
//                 以及 git status --porcelain -- wbs-server/routes wbs-server/public wbs-server/server.js 是否为空；非空一律拒绝生成（跑之前查一次，跑完再查一次）。
//   工作区硬门    跑之前与跑完之后各取一次 git status --porcelain --untracked-files=all：tmp/ 以外、且不在 testFiles 已记哈希集合里的脏路径或未跟踪路径一律拒绝（snapshotProblems / strayDirtyPaths）。
//   HEAD 硬门     跑完 HEAD 与跑前不同时，git diff --name-only --no-renames <前> <后> 里出现「不加载白名单」（NOT_LOADED_WHITELIST，四个明确列出的文件）以外的任何路径即拒绝；
//                 读不到这份差异也拒绝。产品树对象号（routes/sysbuild、public、routes、server.js）前后必须一致。
//   testFiles     各组驱动 / 套件 / 守卫 / 迁移工具与上面那批被加载文件（wbs-server/scripts/verify-sysbuild-*.js、wbs-server/scripts/lib/sysbuild-*.js、scripts/sysbuild-predeploy/**/*.{js,cjs,txt,json}、
//                 wbs-server/scripts/sysbuild-step1/*.js、wbs-server/utils/**、EXTRA_TEST_FILES 里的间接依赖）运行时的 git hash-object 值与 sha256；
//                 提交后可逐个对照已提交 blob（git rev-parse <提交>:<路径>）。跑之前与跑完各取一次，不一致（有人在跑的时候改了测试文件）拒绝生成；
//                 例外只有「不加载白名单」：build-impl-list.js、build-test-disposition.js、inv-parse.js、xref-exports.js 变了只记进 testFilesChangedDuringRun.notLoadedByRun，不拒绝
//                 （第一次全量跑就因为 C1e 的并行任务在运行期间改了它们被拒）。白名单是显式列表，不是「除某几个以外都放行」的负向前瞻；运行结束时再断言白名单里的文件都不在本进程 require.cache 里（真被加载了就拒绝）。
//                 每个文件带 loadedByRun 标记。
//   workingTree   git status --porcelain --untracked-files=all 全文（跑前、跑后各一份）。
//   固有残留（登记，不判定）：跑之前与跑完各取一次快照，运行中「改了又改回」的文件两次哈希一致，看不出来；这是两点式快照的固有限度，不收窄。
//   固有残留（登记）：被 git 忽略的运行输入（wbs-server/.env、wbs-server/.sdh-instance、wbs-server/task_pool.db）不在「工作区硬门」与「testFiles 哈希」这两道门内（git status 看不见被忽略的文件）。
//                 新生成的清单增记 ignoredInputs（跑前 / 跑后各一份）：.sdh-instance 的 sha256；task_pool.db 的 sha256 与字节数（前后不一致即拒绝生成）；.env 只记 LINE_ENV_WHITELIST 里各键是否存在
//                 （键名 + 存在与否），不记任何值、不记值的哈希。已提交的旧清单没有这些字段，--compare 不核它们（缺了不报错）。
//   固有残留（登记）：require.cache 断言只管构建进程本身；各驱动拉起的子进程是否加载白名单文件，靠 grep 核过（sysbuild-step1 下四个白名单文件没有被任何驱动 / 套件 / 间接依赖 require），不是运行时断言。
//   固有残留（登记）：caseSite 同一行里既有搭数据调用、又有业务调用，且走同一个断言助手时，失败在两者之间挪动，判等键分不开；现无实例（已提交基线上没有这种行）。
//   固有残留（登记）：基线顶层 workingTreeDirty 取值时刻（写基线时）与来源清单里的工作区快照时刻（跑完后）不同，期间工作区变动会让 --compare 的核对误拒（宁可误拒，不放行）。
//   groups        每组实际执行的命令行与参数、模式（api = 过滤模式，不加 --full）、起止时刻、退出码、原始日志文件名 / 大小 / sha256、驱动报告的未变异基线结果原文
//                 （没有这一行或不是全绿 → 拒绝生成）、驱动收尾行原文、@@MUT 记录数与登记数、登记 id 清单与实际 id 清单的 sha256。
//   runtime       node 版本、操作系统、传给驱动的环境变量（SYSBUILD_MUT_RECORD、NODE_OPTIONS=--stack-trace-limit=…；默认栈深 10 会把外层帧截掉）。
//   attachmentsFix 附件组 7 条过期变异的修复前后证据（--fix-before-log / --fix-after-log 给两份自检日志；--fix-commit 默认 b4cf6527）。
//   entriesSha256 基线 entries 的 sha256（基线顶层存清单的 sha256，清单里存 entries 的 sha256，互相对得上又不成环）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const rec = require('../lib/sysbuild-mut-record');
const effList = require('./effective-list');

const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');
const ALL_GROUPS = ['api', 'browser', 'static', 'schema', 'db', 'attachments', 'migration', 'deploy', 'archive', 'readonly'];
const FORMAT = 'sysbuild-mutation-baseline/2';
const PROVENANCE_FORMAT = 'sysbuild-mutation-provenance/1';
const STACK_LIMIT_OPTION = '--stack-trace-limit=' + rec.STACK_LIMIT;
const ATTACHMENTS_FIX = Object.freeze({
  commit: 'b4cf6527', // test(sysbuild): #212 C1 fix 7 stale attachment mutations
  ids: Object.freeze([
    'C4b D1 代录确认凭据（confirmation）可软删除',
    'C4b D1 历史导入凭据（history_import）可软删除',
    'C4b D1 改期证据（schedule_record）可软删除',
    'C4b Q-S2 窗口凭据（event）可软删除',
    '冻结不查同项目',
    '冻结不校验 ownerId（L7）',
    '冻结不校验 objectVersionId（L7）',
  ]),
});
const VERDICTS = Object.values(rec.VERDICT);
// 每个提交的固定命令序列（codex 79 HIGH-2；--help 打印，头注释同文）。FIX = wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json，<S> = 上一提交的完整 40 位提交号。
const HELP_TEXT = [
  '#212 变异机器基线工具（C1c）：生成 / 对比失败位置基线；每个提交的固定命令序列如下（共三步，缺一步不算放行）。<FIX> = wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json；<S> = 完整 40 位提交号，正式闸门下只许是 HEAD 本身（三步在提交之前跑）或 HEAD 的第一父提交（三步在提交之后补跑）；累计去向表 = 跨提交累计的一份去向表 json（下称 <DISP>）：',
  '',
  '  ① 编号不丢（只读，不跑用例；提交闸门）：',
  '     node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective <EFF>',
  '     node wbs-server/scripts/sysbuild-step1/mutation-check.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective-none "<理由>"      没有生效变异的提交（只许改工具 / 文档）；<理由> 就是 --effective-none 的参数本身，没有别的传递方式',
  '        --baseline 是闸门：必须给 --changed-since <S>，且 --effective 与 --effective-none 二选一（两个都不给 = 拒绝）；--baseline 直接收本工具生成的基线。不带清单的独立查询入口是 mutation-check.js --query-baseline <FIX> [--dispositions <DISP>]，不是提交闸门。',
  '        <S> 的校验（三步与文件模式 / 无清单模式同口径）：完整 40 位小写十六进制、git cat-file -t 为 commit（树对象拒）、是 HEAD 的祖先，且正式闸门下必须是 HEAD 本身或 HEAD 的第一父提交（更早的祖先拒：前一提交新增、本次删除的编号两端都不存在，清单会漏掉本次退役）；累计查询（--affected … --cumulative、不带清单的 --affected）仍收任意祖先。',
  '        运行的脚本必须位于 --repo 内（三步命令在本线仓库根运行；跨检出调用 = 用法错误）。',
  '        累计去向表口径：<DISP> 是一份跨提交累计的文件（C2、C3… 逐提交追加），每一行（含普通三字段行；--effective-none 分支同样核）必带非空「提交」字段（如 "C2"，与该提交生效清单的 commit 对应）；',
  '        退役类核对（第 ①③ 步）只拿「提交」= 本次清单 commit 的行与本次 retire 做双向全等，其他提交的退役行忽略；「变了 / 需人工复核」的三字段登记（第 ③ 步）可引用任何提交的行，命中证据必须与当次失败对得上（前序登记过、本次失败没再变化的沿用旧行；再次变化的须补新行，旧行证据对不上就拒）；本提交新增 / 改挂的编号只接受「提交」= 本次的行，其余沿用历史行以该编号最后一条退役行为界。第 ① 步对 equivalent 只核编号、类别、承接关系与已有依据（等价业务错误），「承接命中证据」第 ③ 步才强制（要对当次复验日志）。',
  '        读取器漂移硬门：改动集含读取器链路的文件（只有读 <S> 时从当前检出加载的：mutation-check.js、effective-list.js、各层 package.json / package-lock.json）时，<S> 时登记不可自动信任，三步一律拒绝；只改套件 / 驱动 / sysbuild-mut-record.js / 产品文件不触发（它们从 <S> 的临时树加载）——只有改了工具读取器或依赖清单的提交需要 --s-registry-attest。',
  '        给了 --s-registry-attest "<理由>"（解析时统一 trim、空白 = 用法错误；三步同一份理由）：工具自动再用 <S> 树自带的读取器（<S> 时的 mutation-check.js --ids-only）读一遍：两份编号集合全等 → 记录理由继续；不同、或新版读取器读不了 → 增删核对以旧版读取器读出的编号集合为准（新版结果只打印对照）；<S> 树没有可用的 --ids-only 入口、或新旧读取器都读不了 → 一律拒绝（「<S> 树自带的读取器不可用（<S> 早于 f57f6a57 或读取失败），不能用 attest 通路，须人工另行处理」）。',
  '        依赖漂移的限度：只改依赖清单时，<S> 树的读取器与当前读取器共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住。',
  '        C1–C9 保持线性历史：线分支同步 main 用 rebase 且只在 C9 之后；正式闸门拒绝进行中的合并（MERGE_HEAD 存在）、HEAD 是合并提交（有多个父提交；<S> = HEAD 与 <S> = HEAD 的第一父提交都拒）、<S> 本身是合并提交（补跑 <S> = HEAD^ = M、HEAD 为 M 之后的单父提交）；更早的合并提交闸门看不到，只能由 C9 链核对拦；三步与 --affected 带清单共用一处。',
  '        <S> = HEAD 的第一父提交（提交之后补跑）时另要求工作区干净：扣掉复验目录 / --dispositions / --report 这些声明的补写产物后，不许再有未提交 / 未跟踪的路径，有就是用法错误（「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」；三步与 --affected 带清单共用一处）；--effective / 基线若被 HEAD 跟踪，工作区与暂存区内容都须与 HEAD 一致才豁免（没被 HEAD 跟踪的独立输入照旧豁免）。',
  '        --rerun 必须给 --dispositions（与第 ③ 步同一个累计去向表路径，只声明补写产物路径、不读取）；第 ② 步结束打印的「下一步」命令用 <DISP>，读取器漂移时把同一份 --s-registry-attest 理由一并带出。',
  '        所用编号摘要（sha256 / 条数 / 来源）写进 meta / rerun.json / empty-plan.json，三步核同一份。',
  '        自检钩子（--registry-file / --s-registry-file / --allow-no-provenance / --no-provenance）不是命令行参数：命令行给了是用法错误（2），--self-test 与任何别的参数同给也是用法错误；钩子只经自检内部调用 main(argv, hooks) 注入。',
  '        <EFF> = 本提交的生效清单 json（schema 见 wbs-server/scripts/sysbuild-step1/effective-list.js 头注释：mustRun / retire / added，retire 的每条带处置类别 stop-only / remount / equivalent；added = 本提交新增、<S> 时没有的变异；新增的承接编号写进 added，若它同时是某条 remount 的 newId 则只在改挂项里声明）。',
  '        编号增删按 <S> 时登记核对（在 <S> 提交的内容上真跑登记读取函数，不 checkout；十组全看，不能与 --groups 同用）：retire 的编号确已从登记里消失且 <S> 时已登记、<S> 时登记里消失的编号都在 retire 里、by / remount 新编号确已登记、当前登记 − <S> 时登记 = added ∪ 全部 remount newId（多一条少一条都拒）、去向表里 retire 的每个旧编号恰好一行且带对应处置类别与字段。固定基线不再参与增删全等，只用于失败位置对比与需人工复核分类。',
  '        --effective-none 时 <S> 时登记必须 = 当前登记，且改动集（<S>..HEAD + 未提交 + 未跟踪）全部落在白名单内（wbs-server/scripts/sysbuild-step1/**、docs/**、仓库根目录的 *.md）；产品代码、测试驱动与套件、fixtures 的改动不许用它，须给生效清单。mustRun / retire / added 全空的清单必须带非空 "reason" 字段（例如只改 .gitignore 的提交），闸门照常跑自动范围与全部硬门；带 reason 的全空清单只许用于改动集不含产品 / 测试路径（PRODUCT_TEST_PATHS）的提交，涉及这些路径的提交须至少一条清单条目。',
  '  ② 受影响条目实际复验——由本工具执行，日志与 meta 都由它写（手工跑驱动、旧日志都过不了第 ③ 步的闸门）：',
  '     先列：node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --affected <FIX> --changed-since <S> [--affected-out <目录>]',
  '        --affected 也可加 --effective <EFF> 或 --effective-none "<理由>"：按来源分开打印与 --rerun 同口径的完整复验集合（兜底按「基线 ∩ 当前登记」算；这时 <S> 同样按正式闸门口径）；不加只列自动范围（任意祖先）。',
  '        C9 累计范围：--affected <FIX> --changed-since <C1 提交> --cumulative --rerun-dir <C2 复验目录> --rerun-dir <C3 复验目录> … --effective <C2 清单> --effective <C3 清单> …（文件模式留档必带，none 模式不带）：读各提交第 ② 步留档的 <复验目录>/rerun.json（format sysbuild-rerun/3，含自动纳入的编号与实跑编号），按提交顺序逐份列出、逐编号输出命中来源；',
  '        提交链核对：每份留档自身只覆盖一个提交（提交前跑：startHead = changedSince；提交后补跑：startHead 是 changedSince 的直接子），再把每份映射到一个实际提交、沿 <C1>→HEAD 的提交序列逐个核对（报告首个缺份或重复的提交）；第 1 份 changedSince = --changed-since；第 i 份 changedSince 是第 i−1 份 startHead 本身或其直接子提交；最后一份 startHead 是 HEAD 本身或 HEAD 的直接父提交；断链 / 重叠 / 一份跨多个提交 / 中间或尾部漏份即拒（尾部漏份会列出没有留档的提交）。',
  '        本工具的流程约束：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick（提交号变了接不上链），也不得出现合并提交（C1–C9 保持线性历史）；每个提交（含工具、文档提交）都须留第 ② 步复验目录（空计划也留）。',
  '        第 ③ 步通过凭据（97 号 HIGH）：第 ③ 步全部通过时在复验目录写 gate-pass.json（sysbuild-gate-pass/1：待提交内容的树指纹 = 改动集里每个路径在暂存区的 [路径, git 文件模式, blob 号]（排除项不算）逐项 + sha256，rerun.json 的 sha256，<S>，生效清单 sha256 / commit 或 none 理由）。C9 对每份留档：凭据必须在、rerun.json 的 sha256 一致、凭据与 rerun.json 的 <S> / 起始 HEAD / 提交名 / 清单口径一致，',
  '        且凭据里的树指纹与映射到的实际提交 X 的树（同一批路径、同口径）逐项相同、X 的改动集（X 与其父提交之差，扣掉同一份排除项）与凭据的路径集合一致；末尾映射到还没提交的工作区的那份，与当前暂存区比。同一父提交下跑过两轮、都过了第 ③ 步而只有后一轮入库时，传前一轮的目录 = 拒。留档的 plannedIds / ranIds / outOfPlanIds / results 结构（组键与计划组一致、编号是去重后的字符串数组）与第 ③ 步共用一处校验；计划编号缺结果行 = 该留档不完整，拒（退出码 1）。',
  '        0 份复验目录 = 拒绝；旧版本留档（sysbuild-rerun/2）一律拒收；文件模式（非 none）的留档必须按留档顺序各带一份 --effective（个数 = 文件模式留档数；缺少 / 多余 = 拒：C9 必须为每份文件模式留档按顺序带 --effective，漏带时无法识别同一父提交下清单改过的前一轮），无清单模式的留档不需要、不占位，核 sha256；后来被删 / 改挂的按提交顺序逐支追到当前编号（每一支单独保留：仍在 / 已无承接 / 留档不全），编号复用输出警告不串；净改动自动范围含 C1 之后新增的现行编号（复用编号按现行登记的目标算）；只有「各提交实际复验过的编号」与「净改动自动累计范围」两边都没命中的需人工复核条目才可按「从未受影响」处理。',
  '        受影响 = 条目的目标文件 / 失败用例定义文件 / 失败栈帧文件与 <S>..HEAD + 工作区改动有交集（标「文件交集」，守卫类也算），或所在组的测试侧文件（驱动 + 套件 / 助手 + 被测文件；共用件 → 所有组）有改动（该组全部条目，标「组测试侧改动」）；',
  '        不限需人工复核；输出分「全部受影响」与「其中需人工复核」两类计数。不加 --effective / --effective-none 时只列自动范围（不含生效清单与新增变异）。',
  '     再跑：node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective <EFF> --dispositions <DISP> [--report <报告>]',
  '        没有生效清单的提交：… --rerun --raw-dir <tmp/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective-none "<理由>" --dispositions <DISP> [--report <报告>]。--raw-dir 在仓库里只许落在 tmp/ 下（或放到仓库之外），否则用法错误；',
  '        第 ② 步传的 --dispositions（与第 ③ 步是同一个累计去向表路径）/ --report 只声明「复验之后才补写的产物路径」（不读取；--report 单列可选），连同 --raw-dir 一起记进每组 meta.exclusions；仓库内的补写路径必须第 ② 步预声明，第 ③ 步只认这份记录，当次新增的、与源码 / 驱动 / 登记 / 基线 / 清单重叠的排除项一律拒绝（用法错误）。',
  '        每组 meta 还记：改动集里每个路径的工作区 / 暂存区内容指纹（changedStage，含 git 文件 mode）、被忽略的运行输入摘要（.sdh-instance 内容 sha256、线库 sha256、.env 白名单键存在性；子集复验也采集，复验期间变了本次不可信）、<S> 时登记的编号摘要、读取器漂移的人工声明；',
  '        rerun.json（format sysbuild-rerun/3）记提交名 / retire / 每组复验计划（plannedIds）/ 实跑编号（ranIds：复验结束后按第 ③ 步同口径从各组日志解析，非 api 组整组跑出的计划外编号另列 outOfPlanIds，来源「整组实跑」；空计划写空集合）/ 驱动退出码 / 结束记录（complete、ignoredInputsEnd），C9 累计范围读它。',
  '        复验集合 = 自动范围（不含已不在登记里的编号）∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号 ∪ added（当前登记有、<S> 时登记没有的全部编号；codex 81 HIGH-1 / HIGH-2、预筛 HIGH-1）。复验集合为空时写 empty-plan.json（目录里已有任何组日志 / meta / 计划文件则拒绝），第 ③ 步重算后放行。--effective <EFF> 与 --effective-none "<理由>" 二选一，两个都不给 = 拒绝；',
  '        没有生效变异的提交（只改工具 / 文档：改动集全部落在 wbs-server/scripts/sysbuild-step1/**、docs/**、仓库根目录的 *.md 里）用 --effective-none "<理由>"，理由写进输出与 meta；改了产品或测试代码的提交不许用，须给生效清单。清单先过 schema 校验（含重复对象键），不过就不跑。',
  '        api 用 --mutation-ids 只跑复验集合里的编号（过滤模式，与基线同口径）；其余各组驱动没有按编号只跑的参数，只能整组跑（static / deploy 也一样）。',
  '        每组写 <组>.meta.json：起始 HEAD、工作区状态、改动文件的 sha256、起止时刻、命令、生效清单的 sha256 与按来源（自动 / mustRun / by / remount / added）列出的复验集合。',
  '  ③ 对比并过闸门：',
  '     node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective <EFF>',
  '        没有生效清单的提交：… --parse-only <第 ② 步的 --raw-dir> --compare <FIX> --dispositions <DISP> --require-review-dispositions --changed-since <S> --effective-none "<理由>"（理由与第 ② 步一致）；人工声明过读取器漂移的再加 --s-registry-attest "<同一份理由>"。',
  '        暂存区门：改动集里每个路径在暂存区与工作区内容必须一致（先 git add 或撤销暂存），且暂存 blob 与第 ② 步记录的工作区 blob 一致（第 ② 步时还没暂存的路径同样比，是否已暂存只影响提示语；git 文件 mode 变化也算）——放行的就是将要提交的内容；符号链接 / 子模块遇到时报「不支持的文件类型」；复验之后路径从改动集消失 / 新出现 / 内容变了都拒；被忽略的运行输入摘要与第 ② 步记录一致。',
  '        非空复验的 rerun.json 结束记录必须可读、是本次运行写的且完整（complete、ignoredInputsEnd 与复验开始时一致、实跑编号与日志现算的一致），缺失 / 不可读 / 不匹配 → 拒；<S> 时登记的编号摘要与第 ② 步记录一致。累计去向表每一行都须有非空「提交」。',
  '        --effective <EFF>（或 --effective-none "<理由>"）必须给，与第 ② 步同一份；两个都不给 = 拒绝。生效清单 sha256 必须与 meta 一致（防换清单）；mustRun / by / remount / added 新编号必须出现在 meta 绑定的复验编号里、日志里有结果行；新增变异（added 与 remount 新编号）还须当次判红且失败不能只是夹具失败 / 装载异常；',
  '        日志里有结果行的每个仍登记编号（自动范围、一般 mustRun、by、added、newId 全部都算，非 api 组整组跑时复验集合之外的条目也算）都要有合格结果：日志有结果行、所在组未变异对照全绿、当次判红、失败不是夹具失败 / 装载异常；存活或只有夹具失败 → 拒，不能靠去向表登记放行，确实要放弃守护的变异必须进 retire；「变了」只允许是判红但失败位置或信息变化（仍须三字段登记）。',
  '        同一编号既有合格命中（可作证据的失败）又有装载异常（SyntaxError / 模块装载失败）→ 拒（单列检查，承接编号同样；errorClass 为空的运行器超时不算装载异常）。',
  '        C1 之后新增的编号（当前登记有、固定基线没有）在后续提交里也进自动范围，不靠人写 mustRun：登记里的目标文件（定位字面量所在文件）参与文件交集，组级触发与零目标兜底同样适用；它们没有基线失败位置，第 ③ 步按「现在有基线没有」要求三字段登记。',
  '        生效清单必跑编号里基线属于「需人工复核」的条目，同样要在去向表里做三字段登记（业务步骤、未变异通过证据、变异后命中证据），不论自动范围有没有命中它（84 号 HIGH-1）。',
  '        空计划放行条件：目录里没有任何 <组>.log、只有 --rerun 写的 empty-plan.json（不能与 --groups 同用）时，按当前 HEAD / 改动集 / 清单重算计划确实为空、绑定的 HEAD / 改动文件集合 sha256 / 清单 sha256 或 none 理由 / 起始时刻全部一致才放行；同目录的 rerun.json 也必须在、完整（complete）、emptyPlan = true、与 empty-plan.json 属于同一轮（<S> / 起始 HEAD / 改动文件集合 / 清单口径一致）、计划与实跑都为空（只留 empty-plan.json = 第 ② 步写到一半中断或归档漏了文件，拒）；没有任何记录的目录直接拒绝。',
  '        equivalent 的承接编号：该组驱动日志里的未变异基线行全绿、当次运行判红且有可作证据的失败、「承接命中证据」对得上；retire 的每个旧编号在去向表里恰好一行、带对应处置类别与字段；<S> 时登记里消失的编号与 retire 全等。',
  '        退出码 1 的情形：每组须有 meta.json 且 meta 的 HEAD = 当前 HEAD、完整改动路径集合与每个文件的 sha256 = 当前工作区（第 ② 步之后新出现 / 变了 / 又消失的路径都拒；复验目录、去向表登记 json、--report 在显式排除名单里不计）、起始时刻可解析且晚于 <S>..HEAD 最晚提交；失败位置变了且没登记；受影响条目没有复验记录；',
  '        需复核的受影响条目与「变了」的条目登记缺 业务步骤 / 未变异通过证据 / 变异后命中证据 任一；命中证据对不上当前运行里的失败（用例名、信息首行、caseSiteText#ord 或 siteText#ord）；',
  '        失败只有装载异常 / 夹具失败（不得当命中证据）。需人工复核本身不改退出码。--changed-since 必须是 HEAD 的祖先；就是 HEAD 且工作区干净时拒绝。',
  '        证据核对只证明「这条失败存在、指出了哪一步」，不证明它是业务断言——业务步骤由人核对。',
  '        第 ③ 步的受影响总数与范围外缺项从第 ② 步的复验计划（plan.aff）取数；当次日志的失败位置把受影响范围扩大了的，另报「补充命中」。',
  '        meta 还要与日志、组绑定：meta.group = 本组、meta.rerun = true、argv 的脚本等于本组驱动、日志 sha256 / 字节数与 meta 一致；api 另核 api.ids.json 与按 <S> 现算的复验集合（自动范围 ∪ 生效清单的 api 编号 ∪ added：当前登记有、<S> 时登记没有的 api 编号）全等。',
  '        受影响还含「产品侧组级触发」（routes/sysbuild 的 index.js / db.js / schema.js / migration-schema.js、server.js、wbs-server/utils/** 改动 → api / browser / db / attachments / schema 整组）与「兜底触发」',
  '        （routes/sysbuild/** 或 public/** 下没有任何变异以它为目标、也不在任何触发名单的文件 → api + browser 整组）；代价：api 整组约 28 分钟、browser 整组约 28 分钟。',
  '  顺序：先跑第 ③ 步（闸门过了），再提交——提交之后 HEAD 变了，meta 的起始 HEAD 就对不上当前 HEAD（提交之后补跑三步时 <S> = HEAD 的第一父提交，同样要三步都在 HEAD 不再变的情况下完成）。',
  '  十组全量复验只在 C1 与 C9 各跑一次（node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --out <基线> …，约 1–2.7 小时）。',
  '',
  '其他：--compare 默认要求基线带来源清单（放行无清单基线只有自检钩子，命令行没有这个参数）；--self-test 跑本工具自检（只能单独给）；完整参数见脚本头注释。',
].join('\n');

// ── 各组的命令与「跑完」标志 ───────────────────────────────────────────────────────────
function commandOf(group, repo) {
  const w = (f) => path.join(repo, 'wbs-server', 'scripts', f);
  const p = (f) => path.join(repo, 'scripts', 'sysbuild-predeploy', f);
  switch (group) {
    case 'api': return [w('verify-sysbuild-api.js'), '--self-test'];
    case 'browser': return [w('verify-sysbuild-browser.js'), '--self-test'];
    case 'static': case 'schema': case 'db': case 'attachments': return [w('verify-sysbuild-' + group + '.js'), '--self-test'];
    case 'migration': return [p('run-migration-self-test.cjs')];
    case 'deploy': return [p('verify-deploy-migration.cjs'), '--script', path.join(repo, 'scripts', 'deploy-ssh.ps1'), '--self-test'];
    case 'archive': return [p('run-archive-self-test.cjs')];
    case 'readonly': return [p('verify-readonly.cjs'), '--self-test'];
    default: throw new Error('未知组 ' + group);
  }
}
// 驱动打印的收尾行：没有它说明驱动中途退出（浏览器驱动一条变异异常就中止整个循环就是这种情形）。
const FINISH_RE = {
  api: /^变异自检：\d+\/\d+ 判红/m,
  browser: /^浏览器变异 \d+\/\d+ 判红/m,
  static: /^\d+\/\d+ 通过\s*$/m,
  schema: /^变异自检：\d+\/\d+ 判红/m,
  db: /^变异自检：\d+\/\d+ 判红/m,
  attachments: /^变异自检：\d+\/\d+ 判红/m,
  migration: /^迁移变异 \d+\/\d+ 判红/m,
  deploy: /^部署迁移变异 \d+\/\d+ 判红/m,
  archive: /^存档变异 \d+\/\d+ 判红/m,
  readonly: /^只读变异 \d+\/\d+ 判红/m,
};

// ── 归一规则 ───────────────────────────────────────────────────────────────────────────
// 每条：{ name, re, to（字符串或 (匹配数组, ctx) => 字符串）, groups?（只对这些组生效）, example: { in, out, ref?, group? } }。按顺序对 message 逐条替换。ctx = { group, ref }，ref = 这条记录所属那次运行的日期（Date 或 null）。
//   规则的依据（C1c 两次运行实验，api / attachments 两组有差异，static / schema / db 两次逐字一致、不需要规则；两次的差异原文见 C1c 报告第 2 节）：
//     ① 时间戳：api 与 attachments 的失败信息里带库行的 created_at / staged_at、确认单的录入时间（`2026-11-19 18:27:33`、`2026-11-19 19:05`），两次相差二十分钟到一小时。
//        只归一与运行日期同一天或前后一天的时间戳（运行日期：基线取 generatedAt，当前运行取当次时刻）；夹具里写死的日期（如 `2026-10-30 10:00:00`）不归一，因为它们是稳定的、变了就是真变化。
//     ② 临时目录随机后缀：attachments 的 ENOENT 信息里 `C:\Users\...\Temp\sysbuild-att-cjkAAg\uploads\...`，每次 mkdtemp 都不同；后面必须紧跟路径分隔符，`sysbuild-api-suite-notify.js` 这类文件名不动
//     ③ 上传文件名里的毫秒时间戳与随机串：`1795084149007_026679c68ddfa3700a7ee0ab_a-orig.txt`
//     ④ static 组的 `FAIL [Sx] <文件>:<行号>`：行号是变异副本里的行号，会随副本内容移动，归一成 <L>；`:0`（文件级）保留。其他组不套这条。
//   L8 说明：只有 api、attachments 两组实际观察到差异，规则也只在这两组 + static（④，按组限定）上验证过；static / schema / db 没有观察到差异。
//   规则只放宽、不收紧；没有做两次实验的组（browser、migration、deploy、archive、readonly）没有专属规则，易变字段即使存在也只会让对比多报「变了」（误差方向是多报，不会漏报）。
const dayDiff = (a, b) => Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
const NORMALIZERS = [
  {
    name: '时间戳（运行日期前后一天内）',
    re: /\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?/g,
    to: (m, ctx) => {
      if (!ctx || !ctx.ref) return '<TS>';
      const d = new Date(m[0].slice(0, 10) + 'T00:00:00');
      return Number.isNaN(d.getTime()) || Math.abs(dayDiff(d, ctx.ref)) > 1 ? m[0] : '<TS>';
    },
    example: { in: '{"staged_at":"2026-11-19 18:27:33"} 录入时间 2026-11-19 19:05 夹具 2026-10-30 10:00:00', out: '{"staged_at":"<TS>"} 录入时间 <TS> 夹具 2026-10-30 10:00:00', ref: '2026-11-19T12:00:00' },
  },
  { name: '临时目录随机后缀', re: /(sysbuild-[a-z]+(?:-[a-z]+)*-)[A-Za-z0-9]{6}(?=[\\/])/g, to: '$1<RAND>', example: { in: 'open C:\\Users\\x\\Temp\\sysbuild-att-cjkAAg\\uploads\\a.txt 与 lib\\sysbuild-api-suite-notify.js:9', out: 'open C:\\Users\\x\\Temp\\sysbuild-att-<RAND>\\uploads\\a.txt 与 lib\\sysbuild-api-suite-notify.js:9' } },
  { name: '上传文件名的毫秒时间戳与随机串', re: /\d{13}_[0-9a-f]{24}_/g, to: '<MS>_<HEX24>_', example: { in: '1795084149007_026679c68ddfa3700a7ee0ab_a-orig.txt', out: '<MS>_<HEX24>_a-orig.txt' } },
  { name: 'static 组 FAIL 行的行号', groups: ['static'], re: /(FAIL \[S\d+\] \S+?):([1-9]\d*)(?=\s|$)/g, to: '$1:<L>', example: { in: 'FAIL [S2] zz_mut.js:3 x；FAIL [S0] schema.js:0 y', out: 'FAIL [S2] zz_mut.js:<L> x；FAIL [S0] schema.js:0 y', group: 'static' } },
];

function normalizeMessage(msg, ctx) {
  let s = String(msg === undefined || msg === null ? '' : msg);
  for (const r of NORMALIZERS) {
    if (r.groups && !(ctx && r.groups.includes(ctx.group))) continue;
    s = s.replace(r.re, typeof r.to === 'function' ? (...a) => r.to(a, ctx) : r.to);
  }
  return s;
}
// failureKey = case + errorClass + 归一后的 message + label + siteText + siteOrd + caseSiteKey（抛出位置那一行的源码文本与序号；site 为 null 的组为 null；caseSiteKey 见下）。行号本身不参与判等。
// caseSiteKey：caseSite 为 null → null；caseSite 与 site 是同一行 → '='（只算一次）；否则 `caseSiteText#caseSiteOrd`（与 siteText 同口径）。
const caseSiteKeyOf = (f) => (f.caseSite === undefined || f.caseSite === null ? null : (f.caseSite === f.site ? '=' : (f.caseSiteText === undefined ? null : f.caseSiteText) + '#' + (f.caseSiteOrd === undefined ? null : f.caseSiteOrd)));
const failureKey = (f, ctx) => JSON.stringify([f.case === undefined ? null : f.case, f.errorClass === undefined ? null : f.errorClass, normalizeMessage(f.message, ctx), f.label === undefined ? null : f.label, f.siteText === undefined ? null : f.siteText, f.siteOrd === undefined ? null : f.siteOrd, caseSiteKeyOf(f)]);
const failureKeys = (failures, ctx) => (failures || []).map((f) => failureKey(f, ctx)).sort();
// 抛出位置 `文件:行` → { siteText: 该行源码（去首尾空白）, siteOrd: 这段文本在该文件里从头数是第几次出现（数到该行为止，含该行，从 1 起） }。
//   序号用来区分同一文件里文本相同的多条断言（例如好几处 `assert.strictEqual(res.status, 200, ...)`）。读不到文件或行号越界 → { siteText: '<unreadable>', siteOrd: null }（调用方计数）。
//   site 为 null → 两个字段都是 null。两个字段都会写进基线文件：以后改了测试文件就不能再从原始日志重读源码了，--compare 时基线一侧用存下来的值，只对当前运行读源码。
//   已知残留（登记，不判定）：同一行源码里有多个断言时（例如一行里连写好几个 assert），失败在这几个断言之间挪动，siteText 与序号都不变，判键区分不开；这类失败（行内 assert 调用 ≥ 2 次）的条数不写死，以已提交基线的 --compare 输出为准（「同一抛出行有多个断言」63 条，来源 智数协同:docs/local/系统建设记录/送审准备/第一步C1证据_20261119/baseline-evidence/cmp-committed.out:27，口径是条目数）；不收列号，也不重跑驱动去取，--compare 把它们归入「需人工复核」。
function siteInfoOf(repo, site, cache) {
  if (!site) return { siteText: null, siteOrd: null };
  const i = site.lastIndexOf(':');
  const rel = site.slice(0, i);
  const line = Number(site.slice(i + 1));
  let lines = cache.get(rel);
  if (lines === undefined) {
    try { lines = fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8').replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()); } catch (_) { lines = null; }
    cache.set(rel, lines);
  }
  if (!lines || !Number.isInteger(line) || line < 1 || line > lines.length) return { siteText: '<unreadable>', siteOrd: null };
  const text = lines[line - 1];
  let ord = 0;
  for (let k = 0; k < line; k += 1) if (lines[k] === text) ord += 1;
  return { siteText: text, siteOrd: ord };
}
// 「key 对应多个 site」：失败键（组 + case + errorClass + 归一后 message + label + siteText [+ 序号]）下出现了不止一个不同的 site（文件:行）——
//   也就是首行（case / class / message / label）不能区分、siteText（含序号）也区分不开的失败。返回键列表（每项带它对应的 site 集合），供调用方计数与列出。
function multiSiteKeys(entries, withOrd) {
  const m = new Map();
  for (const e of entries) {
    for (const f of e.failures || []) {
      if (!f.site) continue;
      const k = JSON.stringify([e.group, f.case, f.errorClass, normalizeMessage(f.message, { group: e.group, ref: null }), f.label, f.siteText === undefined ? null : f.siteText, withOrd ? (f.siteOrd === undefined ? null : f.siteOrd) : null]);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(f.site);
    }
  }
  return Array.from(m.entries()).filter(([, s]) => s.size > 1).map(([k, s]) => ({ key: JSON.parse(k), sites: Array.from(s).sort() }));
}
// 「key 相同但 caseSite 不同」（HIGH-3，应为 0）：withCaseSite = true 时按完整失败键（含 caseSiteKey）分组，键下出现不止一个不同的 caseSite（文件:行）——
//   即文本与序号都相同、却落在不同文件里的用例体调用点，判等区分不开；withCaseSite = false 时按「不含 caseSite 的旧键」分组、数其下不同 caseSiteKey 的个数，
//   这是新键比旧键多区分出来的组数（旧键判相同、新键判不同）。caseSite 与 site 都是 null 的失败（守卫类 / 异常记录）不参与。
function caseSiteSplitKeys(entries, withCaseSite) {
  const m = new Map();
  for (const e of entries) {
    for (const f of e.failures || []) {
      if (f.caseSite === undefined || f.caseSite === null) continue;
      const base = [e.group, f.case, f.errorClass, normalizeMessage(f.message, { group: e.group, ref: null }), f.label, f.siteText === undefined ? null : f.siteText, f.siteOrd === undefined ? null : f.siteOrd];
      const k = JSON.stringify(withCaseSite ? base.concat([caseSiteKeyOf(f)]) : base);
      if (!m.has(k)) m.set(k, new Set());
      m.get(k).add(withCaseSite ? f.caseSite : caseSiteKeyOf(f));
    }
  }
  return Array.from(m.entries()).filter(([, s]) => s.size > 1).map(([k, s]) => ({ key: JSON.parse(k), caseSites: Array.from(s).sort() }));
}
// 各组 caseSite / 栈情况统计：failures 总数、caseSite 为 null 的条数（其中 GuardFail、异常记录 errorClass 为 null、其余）、runnerSeen=false 的条数、frames 为空的条数。
function callSiteStats(entries) {
  const out = {};
  for (const e of entries) {
    const s = out[e.group] || (out[e.group] = { failures: 0, caseSiteNull: 0, nullGuardFail: 0, nullNoClass: 0, nullOther: 0, runnerNotSeen: 0, framesEmpty: 0 });
    for (const f of e.failures || []) {
      s.failures += 1;
      if (f.caseSite === undefined || f.caseSite === null) {
        s.caseSiteNull += 1;
        if (f.errorClass === 'GuardFail') s.nullGuardFail += 1; else if (f.errorClass === null || f.errorClass === undefined) s.nullNoClass += 1; else s.nullOther += 1;
      }
      if (f.runnerSeen === false) s.runnerNotSeen += 1;
      if (!Array.isArray(f.frames) || f.frames.length === 0) s.framesEmpty += 1;
    }
  }
  return out;
}
// 失败签名相同的组数：同一组里失败键（可选带 siteText / 可选归一）的多重集完全相同的变异归成一类，统计成员数 ≥ 2 的类数与其中的变异数。
function signatureClasses(entries, { site, norm }) {
  const byKey = new Map();
  for (const e of entries) {
    const ks = (e.failures || []).map((f) => JSON.stringify([f.case, f.errorClass, norm ? normalizeMessage(f.message, { group: e.group, ref: null }) : f.message, f.label, site ? (f.siteText === undefined ? null : f.siteText) : null, site ? (f.siteOrd === undefined ? null : f.siteOrd) : null])).sort();
    const k = e.group + '\u0000' + JSON.stringify(ks);
    byKey.set(k, (byKey.get(k) || 0) + 1);
  }
  let classes = 0;
  let members = 0;
  for (const n of byKey.values()) if (n >= 2) { classes += 1; members += n; }
  return { classes, members, distinct: byKey.size };
}

// ── 解析与对账 ─────────────────────────────────────────────────────────────────────────
function parseRaw(text) {
  const records = [];
  const bad = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const r = rec.parseMutLine(line);
    if (r === null) continue;
    if (r.bad !== undefined) bad.push(r.bad.slice(0, 200)); else records.push(r.rec);
  }
  return { records, bad };
}
// registered：[{group,id,files,expect}]（登记顺序）；records：该组的 @@MUT 记录（输出顺序）。
function reconcile(group, registered, records) {
  const regCount = new Map();
  for (const r of registered) regCount.set(r.id, (regCount.get(r.id) || 0) + 1);
  const recCount = new Map();
  for (const r of records) recCount.set(r.id, (recCount.get(r.id) || 0) + 1);
  const missing = [];
  const extra = [];
  const duplicates = [];
  for (const [id, n] of regCount) if (!recCount.has(id)) missing.push(id);
  for (const [id] of recCount) if (!regCount.has(id)) extra.push(id);
  for (const [id, n] of recCount) if (regCount.has(id) && n > 1) duplicates.push({ id, count: n });
  const dupRegistered = Array.from(regCount.entries()).filter(([, n]) => n > 1).map(([id]) => id);
  return { group, missing, extra, duplicates, dupRegistered, ok: missing.length === 0 && extra.length === 0 && duplicates.length === 0 && dupRegistered.length === 0 };
}
function summarize(entries, total) {
  const s = { total, red: 0, weak: 0, abnormal: 0, anchor: 0 };
  for (const e of entries) {
    if (e.verdict === rec.VERDICT.RED) s.red += 1;
    else if (e.verdict === rec.VERDICT.WEAK) s.weak += 1;
    else if (e.verdict === rec.VERDICT.ABNORMAL) s.abnormal += 1;
    else if (e.verdict === rec.VERDICT.ANCHOR) s.anchor += 1;
  }
  return s;
}
// groupsData：{ <组>: { registered, text（原始日志，没有则 null）, meta } }；返回 { groups, entries, reconciles, unfinished, bad }
//   opts.repo：给了就为每条失败按 site 读出源码行文本 siteText（H1）；读不到记 '<unreadable>' 并在 groups[g].siteUnreadable 里计数。
function assemble(groupsData, order, opts) {
  const groups = {};
  const entries = [];
  const reconciles = [];
  const unfinished = [];
  const bad = [];
  const siteCache = new Map();
  for (const g of order) {
    const d = groupsData[g];
    const parsed = parseRaw(d.text);
    for (const b of parsed.bad) bad.push({ group: g, line: b });
    const rc = reconcile(g, d.registered, parsed.records.filter((r) => r.group === g));
    const foreign = parsed.records.filter((r) => r.group !== g);
    if (foreign.length) rc.extra.push(...foreign.map((r) => r.group + '/' + r.id));
    rc.ok = rc.ok && foreign.length === 0;
    reconciles.push(rc);
    const finished = d.text === null || d.text === undefined ? false : FINISH_RE[g].test(d.text);
    if (!finished) unfinished.push(g);
    const byId = new Map();
    for (const r of parsed.records) if (r.group === g && !byId.has(r.id)) byId.set(r.id, r);
    const gEntries = [];
    let siteUnreadable = 0;
    for (const reg of d.registered) {
      const r = byId.get(reg.id);
      if (!r) continue;
      const failures = opts && opts.repo ? r.failures.map((f) => {
        const si = siteInfoOf(opts.repo, f.site, siteCache);
        const ci = f.caseSite === f.site ? si : siteInfoOf(opts.repo, f.caseSite, siteCache);
        if (si.siteText === '<unreadable>' || ci.siteText === '<unreadable>') siteUnreadable += 1;
        return { ...f, siteText: si.siteText, siteOrd: si.siteOrd, caseSiteText: ci.siteText, caseSiteOrd: ci.siteOrd };
      }) : r.failures;
      const e = { group: g, id: reg.id, files: reg.files || [], expect: reg.expect === undefined ? null : reg.expect, verdict: r.verdict, failures };
      if (r.note) e.note = r.note;
      gEntries.push(e);
    }
    entries.push(...gEntries);
    groups[g] = { ...summarize(gEntries, d.registered.length), missing: rc.missing.length, finished, siteUnreadable, meta: d.meta || null };
  }
  return { groups, entries, reconciles, unfinished, bad };
}

// ── 对比 ───────────────────────────────────────────────────────────────────────────────
const keyOf = (x) => x.group + '\u0000' + x.id;
// 「相同但需人工复核」（MED-3 / 71 号 HIGH-3 后半句）：判等键分不出来的三类失败。判等键本身不变（不改已提交基线），只是这三类判相同时不能自动当「没问题」。
//   multiAssert       抛出行（siteText）里有 ≥ 2 次 assert 调用：失败在同一行的几个断言之间挪动，siteText 与序号都不变
//   callerNotCaseSite caseSite 非 null 且不是抛出行本身，但 frames[1]（直接调用方）≠ caseSite：共用助手 / 中间函数，调用方标签相同时分不清（预筛实测 166 条失败：api 72、browser 22、schema 72）
//   caseSiteNull      caseSite 为 null（运行器自己抛的 / 异常记录；不含守卫类）：没有用例体调用点可比
//   guardNoStack      守卫类失败（errorClass = GuardFail，static / deploy）：没有栈、caseSite 恒为 null，靠「规则 + 文件 + 信息」识别（信息已在判等键里）；单列计数，不算 caseSiteNull、不进需人工复核
const ASSERT_CALL_RE = /\bassert(?:\.[A-Za-z]+)?\s*\(/g;
const REVIEW_KINDS = Object.freeze({ multiAssert: '同一抛出行有多个断言', callerNotCaseSite: '直接调用方不是用例体调用点', caseSiteNull: 'caseSite 为 null' });
const GUARD_GROUPS = new Set(['static', 'deploy']); // 只有这两组的驱动产出 GuardFail（verify-sysbuild-static.js、verify-deploy-migration.cjs）
function reviewReasons(failures, group) {
  const r = new Set();
  for (const f of failures || []) {
    if (typeof f.siteText === 'string' && (f.siteText.match(ASSERT_CALL_RE) || []).length >= 2) r.add('multiAssert');
    if (f.caseSite === undefined || f.caseSite === null) r.add(f.errorClass === 'GuardFail' && GUARD_GROUPS.has(group) ? 'guardNoStack' : 'caseSiteNull');
    else if (f.caseSite !== f.site && Array.isArray(f.frames) && f.frames.length > 1 && f.frames[1] !== f.caseSite) r.add('callerNotCaseSite');
  }
  return Array.from(r).sort();
}
// base / cur：基线与当前的 entries；dispositions：[{group,id,去向}]；opts.baseRef / opts.curRef：两侧所属运行的日期（Date，时间戳归一用；缺省 = 全部归一）
//   返回的 same 是全部「失败键相同」的条目；其中带上面前三类之一的另列在 needReview（same 的子集，每项 { group, id, reasons, 去向? }），不算失败；带 guardNoStack 的另列在 guardNoStack（只计数）；
//   去向表里给这些条目登记过处置的，needReview 项带 去向，并且不进 unusedDispositions。
function compareBaselines(base, cur, dispositions, opts) {
  const baseRef = (opts && opts.baseRef) || null;
  const curRef = (opts && opts.curRef) || null;
  const bm = new Map(base.map((e) => [keyOf(e), e]));
  const cm = new Map(cur.map((e) => [keyOf(e), e]));
  const disp = new Map();
  for (const d of dispositions || []) { const dest = effList.destOf(d); if (!disp.get(keyOf(d))) disp.set(keyOf(d), dest); } // 只认非空字符串，null / 数字 / 对象当空（84 号 LOW-2：不做 String() 转换）；累计去向表里同一编号可有多行，任一行有非空去向即算有
  const same = [];
  const needReview = [];
  const guardNoStack = [];
  const changed = [];
  const unregistered = [];
  const note = (kind, b, c, detail) => {
    const k = keyOf(b || c);
    const d = disp.get(k);
    const item = { kind, group: (b || c).group, id: (b || c).id, detail };
    if (d) changed.push({ ...item, 去向: d }); else unregistered.push({ ...item, reason: disp.has(k) ? '去向为空' : '没有去向记录' });
  };
  for (const [k, b] of bm) {
    const c = cm.get(k);
    if (!c) { note('基线有现在没有', b, null, '变异已不在当前清单里'); continue; }
    if (b.verdict !== c.verdict) { note('判定变化', b, c, b.verdict + ' → ' + c.verdict); continue; }
    const bk = failureKeys(b.failures, { group: b.group, ref: baseRef });
    const ck = failureKeys(c.failures, { group: c.group, ref: curRef });
    if (JSON.stringify(bk) !== JSON.stringify(ck)) {
      const only = (a, z) => a.filter((x) => !z.includes(x)).map((x) => JSON.parse(x));
      note('失败位置变化', b, c, { 基线独有: only(bk, ck), 现在独有: only(ck, bk) });
      continue;
    }
    same.push({ group: b.group, id: b.id });
    const allReasons = Array.from(new Set([...reviewReasons(b.failures, b.group), ...reviewReasons(c.failures, c.group)])).sort();
    if (allReasons.includes('guardNoStack')) guardNoStack.push({ group: b.group, id: b.id });
    const reasons = allReasons.filter((r) => r !== 'guardNoStack');
    if (reasons.length) {
      const item = { group: b.group, id: b.id, reasons };
      const d = disp.get(k);
      if (d) item['去向'] = d;
      needReview.push(item);
    }
  }
  for (const [k, c] of cm) if (!bm.has(k)) note('现在有基线没有', null, c, '当前清单里的新变异');
  const used = new Set([...changed, ...unregistered, ...needReview.filter((x) => x['去向'])].map((x) => keyOf(x)));
  const unusedDispositions = (dispositions || []).filter((d) => !used.has(keyOf(d))).map((d) => ({ group: d.group, id: d.id }));
  const reviewCounts = { multiAssert: 0, callerNotCaseSite: 0, caseSiteNull: 0 };
  for (const x of needReview) for (const r of x.reasons) reviewCounts[r] += 1;
  return { same, needReview, reviewCounts, guardNoStack, changed, unregistered, unusedDispositions, ok: unregistered.length === 0 };
}

// ── 受影响子集登记闸门（codex 79 号 HIGH-2）─────────────────────────────────────────────
// 「需人工复核」不改退出码；闸门把它变成每个提交的硬要求：--compare 加 --require-review-dispositions --changed-since <40 位提交号>。
//   受影响（H2）= 下面三类文件与「<since>..HEAD 的改动 + 工作区改动（含未跟踪）」有交集的**全部条目**（不限需人工复核；守卫类同样按文件交集算——static / deploy 只能整组跑，照跑）：
//     ① 变异的目标文件（基线 entries[].files）；② 失败用例的定义文件（用例体调用点 caseSite 所在文件）；③ 失败记录 site / caseSite / frames 里出现的任一文件
//     （共用夹具 / 助手改了，只要它在失败栈上就被覆盖）。基线一侧与当前运行一侧的失败记录取并集。「需人工复核」只决定要不要额外三字段登记，不决定复验范围。
//   栈帧限度与保守规则：栈帧只记失败那一刻在调用栈上的文件；用例体里先调用、已经返回的搭数据助手不在栈上，它所在的文件改了不会被上面的文件交集捕获。
//   所以另加一条（codex 79 号裁定）：某组的「测试侧文件」（GROUP_TEST_SIDE：该组驱动 + 它加载的套件 / 助手 + predeploy 四组驱动直接加载的被测文件；SHARED_TEST_SIDE：test-env / test-instance / _test-fixture /
//   sysbuild-mut-record / listen-safe-port / scripts/lines 的 line-proc、line-common、line-new、state，共用件改动 → 所有组）有改动，该组全部条目都算受影响。
//   名单与驱动实际加载链逐项核对（M1，testSideConsistency：静态读 require 链，--self-test 里多 / 少都判红），来源见各组驱动的 require 与已提交来源清单里的被加载文件；routes / public / server.js 等产品文件不在名单里，走文件交集。
//   --affected 与闸门输出里每条受影响条目标明是「文件交集」还是「组测试侧改动」（或两者）。
//   「变了」的条目（判定 / 失败位置变化、现在有基线没有）本来就要在去向表登记；闸门下，「需人工复核的受影响条目」与「变了的条目」一起，登记项必须带三个非空字段：
//   业务步骤、未变异通过证据、变异后命中证据；缺任一即列出并退出 1。命中证据必须能对上当前运行里该条目一个「可作证据」的失败（失败用例名 + 失败信息首行前 60 个字 + 位置键 caseSiteText#ord 或 siteText#ord）；
//   装载异常（只看结构化字段：errorClass 为空 / SyntaxError、case 为空；不套 message / label 文字正则，见 isLoadOrFixtureFailure）不得充当命中证据——全是这类失败的条目直接判不通过。
//   证据核对只证明「这条失败存在、指出了哪一步」，不证明它是业务断言——业务步骤由人核对，本工具不判。
//   闸门下，本次原始日志里没有复验记录的受影响条目（全部受影响条目，不限需复核）判不通过（比较范围 = 日志里实际有记录的变异：api 过滤子集、其余各组整组）；
//   每组还要有 meta.json 并过 rerunMetaProblems 的核对（H1，见 --rerun）。
const GATE_FIELDS = Object.freeze(['业务步骤', '未变异通过证据', '变异后命中证据']);
const normPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const fileOfSite = (s) => { if (typeof s !== 'string' || !s) return null; const m = /^(.*):\d+$/.exec(s); return normPath(m ? m[1] : s); };
// 条目涉及的全部文件：目标文件 + 失败记录里 site / caseSite / frames 的文件（可传多个条目：基线一侧、当前一侧）。
function entryFileSet(...entries) {
  const out = new Set();
  for (const e of entries) {
    if (!e) continue;
    for (const f of e.files || []) out.add(normPath(f));
    for (const f of e.failures || []) for (const s of [f.site, f.caseSite, ...(Array.isArray(f.frames) ? f.frames : [])]) { const x = fileOfSite(s); if (x) out.add(x); }
  }
  return out;
}
// 复验之后才允许生成或补写的产物的显式排除名单（84 号 HIGH-2）：这些路径若落在仓库里（未跟踪或被跟踪），不计入「复验用的完整改动路径集合」——
//   ① --raw-dir 复验目录（日志 / meta / api.ids.json / 空计划记录）② --dispositions 去向表登记 json（人在看完复验日志之后才补写命中证据）③ --report 报告。
//   其余任何路径——含生效清单本身（第 ② 步必须已存在，它的内容另由 meta.effective.sha256 绑定）——都在核对范围内：第 ② 步之后改动集里新出现 / 内容变了 / 又消失的路径，第 ③ 步一律拒绝。
//   excl = { files: [仓库相对路径], dirs: [仓库相对目录（带结尾 /）] }；不在仓库里的路径不用排除（git 看不到）。
function exclusionsOf(repo, { rawDir, dispositions, report }) {
  const rel = (f) => { if (!f) return null; const r = path.relative(repo, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? normPath(r) : null; };
  return { files: [rel(dispositions), rel(report)].filter(Boolean), dirs: [rel(rawDir)].filter(Boolean).map((d) => d + '/') };
}
const isExcludedBy = (excl, p) => !!excl && (excl.files.includes(p) || excl.dirs.some((d) => p.startsWith(d)));
// <since>..HEAD 的改动 + 工作区改动（含未跟踪、改名两端）；读不到就抛错（闸门不放行）。实现在 effective-list.js changedPathsSince（第 ① 步的 --effective-none 适用范围核对共用）；excl 见上，缺省 = 不排除。
//   opts.gate = true：正式闸门（--rerun / 第 ③ 步 / --affected 带清单）——<S> 必须是 HEAD 或 HEAD 的第一父提交（96 号 HIGH-1）；累计查询与不带清单的 --affected 不传，保留任意祖先。
function changedFilesSince(repo, since, excl, opts) {
  const all = effList.changedPathsSince(repo, since, opts);
  return excl ? new Set(Array.from(all).filter((p) => !isExcludedBy(excl, p))) : all;
}
// 预筛 MED-1（三步与 --affected 带清单共用一处）：<S> = HEAD 的第一父提交（提交后补跑）时工作区须干净——扣掉排除项（复验目录 / --dispositions / --report）与本步的输入文件后不许再有未提交 / 未跟踪的路径；
//   有 → 抛错（调用方当用法错误，退出码 2）。<S> = HEAD 时不核。自检钩子 skipCleanCheck 才跳过。
//   98 号 MEDIUM：inputFiles（基线、生效清单）若被 HEAD 跟踪，只有工作区与暂存区内容都与 HEAD 一致才豁免（effective-list.js postCommitDirtyProblem 的 inputs）；没被 HEAD 跟踪的独立输入照旧豁免；
//   excl.files（--dispositions / --report）与 excl.dirs（复验目录）是声明的补写产物，照旧整体豁免。
function postCommitCleanCheck(o, excl, inputFiles) {
  if (o.skipCleanCheck) return;
  const files = [...(excl ? excl.files : [])];
  const inputs = (inputFiles || []).map((f) => effList.repoRelPath(o.repo, f)).filter(Boolean);
  let problem = null;
  try { problem = effList.postCommitDirtyProblem(o.repo, o.changedSince, { files, dirs: excl ? excl.dirs : [], inputs }); } catch (e) { problem = '读不到工作区状态：' + e.message; }
  if (problem) throw new Error(problem);
}
// 排除项的两道硬门（89 号 HIGH-1；用户 P-THREAT = A 之下的低成本收口）：
//   ① 位置门：--raw-dir（--parse-only 的目录同理）在仓库里只许落在 tmp/ 下，在仓库里的其他位置 = 用法错误（否则整个目录前缀从改动集里剔除，复验目录指到产品目录就把那里的改动藏起来了）；仓库之外不受限（git 看不到）。
//   ② 记录门：复验之后才允许生成 / 补写的产物（复验目录、去向表登记 json、--report）由第 ② 步（--rerun，可加 --dispositions / --report 声明，只声明不读取）记进每组 meta.exclusions；
//      第 ③ 步只认这份记录——当次新增的排除项、与源码 / 驱动 / 登记 / 基线 / 清单路径重叠的排除项（effective-list.js protectedPathHit）一律拒绝（用法错误）。
function rawDirLocationProblem(repo, dir, label) {
  if (!dir) return null;
  const r = path.relative(repo, dir);
  if (r.startsWith('..') || path.isAbsolute(r)) return null; // 仓库之外：git 看不到，不受限
  const rel = normPath(r).toLowerCase();
  if (rel === 'tmp' || rel.startsWith('tmp/')) return null;
  return `${label} ${dir} 在仓库里、但不在 ${normPath(path.join(repo, 'tmp'))}/ 下：复验目录在仓库里只许落在 <仓库>/tmp/ 下（或放到仓库之外）——否则它的内容会被当作排除项从改动集里整体剔除（89 号 HIGH-1）`;
}
// 排除项自身的合规：dir 必须在 tmp/ 下；file / dir 都不许与源码 / 驱动 / 登记 / 工具目录 / 本次的输入文件（基线、生效清单等，inputFiles 是绝对路径）重叠。返回问题数组。
function exclusionProblems(repo, excl, inputFiles) {
  const out = [];
  const extra = (inputFiles || []).filter(Boolean).map((f) => path.relative(repo, f)).filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r)).map(normPath);
  for (const f of excl.files) { const hit = effList.protectedPathHit(f, false, extra); if (hit) out.push(`排除项（文件）${f}：${hit}`); }
  for (const d of excl.dirs) {
    if (!(d.toLowerCase() === 'tmp/' || d.toLowerCase().startsWith('tmp/'))) out.push(`排除项（目录）${d}：不在 tmp/ 下`);
    const hit = effList.protectedPathHit(d, true, extra);
    if (hit) out.push(`排除项（目录）${d}：${hit}`);
  }
  return out;
}
const normExcl = (x) => ({ files: Array.from((x && x.files) || []).map(normPath).sort(), dirs: Array.from((x && x.dirs) || []).map(normPath).sort() });
// 第 ③ 步的排除项必须是第 ② 步记录的子集（recorded = 第 ② 步记进 meta / empty-plan.json 的 exclusions；null = 没有记录，等于空）。返回问题数组。
function exclusionsSubsetProblems(candidate, recorded) {
  const rec = normExcl(recorded);
  const cand = normExcl(candidate);
  const out = [];
  for (const f of cand.files) if (!rec.files.includes(f)) out.push(`排除项（文件）${f} 不在第 ② 步的记录里（第 ③ 步只认第 ② 步记录的排除项；要用它，第 ② 步 --rerun 时用同一路径给 --dispositions / --report 声明）`);
  for (const d of cand.dirs) if (!rec.dirs.includes(d)) out.push(`排除项（目录）${d} 不在第 ② 步的记录里（第 ③ 步只认第 ② 步记录的排除项；复验目录必须与第 ② 步的 --raw-dir 一致）`);
  return out;
}
// 第 ② 步记录的排除项：优先读各组 meta.exclusions（各组须一致，不一致由 rerunMetaProblems 报），没有 meta 时读 empty-plan.json；都没有 = null（没有记录）。
function readRecordedExclusions(rawDir) {
  const tryJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')); } catch (_) { return null; } };
  for (const g of ALL_GROUPS) { const m = tryJson(g + '.meta.json'); if (m && m.exclusions) return m.exclusions; }
  const e = tryJson('empty-plan.json');
  return e && e.exclusions ? e.exclusions : null;
}

// ── 改动集内容指纹（89 号 HIGH-2 / MEDIUM）──────────────────────────────────────────────
//   第 ② 步对改动集里每个路径同时记工作区与暂存区的内容：sha256（工作区原始字节）、blob（工作区内容经 git 的换行 / 属性过滤后的 git blob 号，与提交后的 blob 对得上）、index（暂存区 stage 0 的 blob 号；不在暂存区 = null）。
//   第 ③ 步要求：暂存区与工作区一致（index = blob：先 git add 或撤销暂存），且暂存内容 = 第 ② 步复验时的内容（index = 第 ② 步记的 blob）——放行的就是将要提交的内容，不是只在工作区里复验过的版本。
//   路径映射一律用 Map（不用普通对象与 `in`：仓库根目录出现名为 constructor 的文件不能被当成已记录路径）。空计划与非空计划共用 compareChangeSnapshot（89 号 MEDIUM-1）。
function gitIndexMap(repo) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'ls-files', '-s', '-z'], { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('读不到 git ls-files -s');
  const out = new Map();
  for (const rec of effList.utf8Strict(r.stdout, 'git ls-files').split('\0').filter(Boolean)) {
    const m = /^(\d+) ([0-9a-f]{40}) (\d)\t(.*)$/s.exec(rec);
    if (!m) throw new Error('读不懂 git ls-files -s 的一行：' + rec.slice(0, 80));
    const p = normPath(m[4]);
    const prev = out.get(p);
    if (!prev || Number(m[3]) === 0) out.set(p, { mode: m[1], oid: m[2], stage: Number(m[3]) });
  }
  return out;
}
function worktreeBlobs(repo, paths) {
  const files = paths.filter((p) => { try { return fs.statSync(path.join(repo, ...p.split('/'))).isFile(); } catch (_) { return false; } });
  const out = new Map();
  if (files.length === 0) return out;
  if (files.some((p) => p.includes('\n'))) throw new Error('改动集里有路径含换行，无法取 git blob 号');
  const r = spawnSync('git', ['-C', repo, 'hash-object', '--stdin-paths'], { input: files.join('\n') + '\n', encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const lines = r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (lines.length !== files.length) throw new Error('git hash-object --stdin-paths 返回 ' + lines.length + ' 行，应为 ' + files.length);
  files.forEach((p, i) => out.set(p, lines[i]));
  return out;
}
// paths：改动路径（已剔除排除项）。返回 Map<路径, { sha256, blob, index, mode }>；mode = 暂存区里该路径的 git 文件模式（不在暂存区 = null；100644 / 100755）。
//   95 号 MEDIUM：快照保留 git 文件 mode（同一 blob 的可执行位变化也算变）；本工具只支持普通文件——符号链接（暂存区 mode 120000 或工作区里是符号链接）、子模块（160000 或工作区里是目录）遇到时直接报「不支持的类型」，
//   不让后面落成「请 git add」这类误导的诊断。
function unsupportedTypeProblems(repo, paths, idx) {
  const out = [];
  for (const p of paths) {
    const ix = idx.get(p);
    if (ix && ix.mode === '120000') out.push(`${p}（暂存区里是符号链接 120000）`);
    else if (ix && ix.mode === '160000') out.push(`${p}（暂存区里是子模块 160000）`);
    else {
      let st = null;
      try { st = fs.lstatSync(path.join(repo, ...p.split('/'))); } catch (_) { /* 不在工作区：删除，不是类型问题 */ }
      if (st && st.isSymbolicLink()) out.push(`${p}（工作区里是符号链接）`);
      else if (st && st.isDirectory()) out.push(`${p}（工作区里是目录 / 子模块）`);
    }
  }
  return out;
}
function changeSnapshot(repo, paths) {
  const list = Array.from(paths).map(normPath).sort();
  const idx = gitIndexMap(repo);
  const unsup = unsupportedTypeProblems(repo, list, idx);
  if (unsup.length) throw new Error('改动集里有不支持的文件类型（本工具只支持普通文件：符号链接 / 子模块无法按内容指纹核对复验与提交的一致性）：' + unsup.slice(0, 8).join('、') + (unsup.length > 8 ? ' …共 ' + unsup.length + ' 个' : ''));
  const blobs = worktreeBlobs(repo, list);
  const out = new Map();
  for (const p of list) {
    const ix = idx.get(p);
    out.set(p, { sha256: sha256OrNull(repo, p), blob: blobs.has(p) ? blobs.get(p) : null, index: ix ? (ix.stage === 0 ? ix.oid : 'conflict:' + ix.stage) : null, mode: ix && ix.stage === 0 ? ix.mode : null });
  }
  return out;
}
// 写进 meta 的对象用无原型对象（路径叫 __proto__ / constructor 也只是普通键）
const snapshotFilesOf = (snap) => { const o = Object.create(null); for (const [p, v] of snap) o[p] = v.sha256; return o; };
const snapshotStageOf = (snap) => { const o = Object.create(null); for (const [p, v] of snap) o[p] = { blob: v.blob, index: v.index, mode: v.mode === undefined ? null : v.mode }; return o; };
// 记录一侧读回 Map（JSON.parse 出来的普通对象；用 Object.entries 取自有属性，constructor / __proto__ 这类键名也当普通路径）
const mapOfRecord = (obj) => (obj && typeof obj === 'object' ? new Map(Object.entries(obj)) : null);
// 共用比较：recordedFiles（Map<路径, sha256|null>）、recordedStage（Map<路径, { blob, index }> 或 null = 记录里没有暂存区指纹）、current（changeSnapshot 的结果）、excl（排除名单）。
//   返回 { gone: 记过现在不在改动集, fresh: 现在在改动集记里没有, stale: 两边都有但内容变了, stageBad: [{ path, why }] 暂存区与工作区不一致, stageDrift: [路径] 暂存内容与第 ② 步复验时的内容不同, noStageRecord }。
function compareChangeSnapshot({ recordedFiles, recordedStage, current, excl }) {
  const ex = (p) => isExcludedBy(excl, p);
  const recKeys = Array.from(recordedFiles.keys()).filter((p) => !ex(p));
  const curKeys = Array.from(current.keys()).filter((p) => !ex(p));
  const recSet = new Set(recKeys);
  const curSet = new Set(curKeys);
  const gone = recKeys.filter((p) => !curSet.has(p)).sort();
  const fresh = curKeys.filter((p) => !recSet.has(p)).sort();
  const stale = recKeys.filter((p) => curSet.has(p) && current.get(p).sha256 !== recordedFiles.get(p)).sort();
  const stageBad = [];
  for (const p of curKeys.slice().sort()) {
    const c = current.get(p);
    if (c.index === c.blob) continue;
    const why = c.index === null ? '暂存区里没有（新文件或改动没 git add）' : c.blob === null ? '工作区里没有、暂存区还有（删除没暂存）' : String(c.index).startsWith('conflict:') ? '暂存区有未解决的冲突' : '暂存区与工作区内容不一致';
    stageBad.push({ path: p, why });
  }
  const stageDrift = [];
  // 95 号 MEDIUM：只要第 ② 步记了该路径的 blob（复验时的工作区内容经 git 过滤后的对象号），就拿「当前暂存 blob」去比——不管第 ② 步时它有没有暂存（没暂存是正常流程，第 ③ 步前才 git add；
  //   Git 清理过滤结果变了，原始字节相同也不能证明待提交的 blob 就是复验时的）。第 ② 步是否已暂存只影响提示语。当前没暂存 / 有冲突的由 stageBad 报，这里不重复。mode 两边都有时也比（可执行位变化）。
  if (recordedStage) {
    for (const p of recKeys.slice().sort()) {
      if (!curSet.has(p)) continue;
      const rs = recordedStage.get(p);
      if (!rs) { stageDrift.push(p + '（第 ② 步没有记它的暂存区指纹）'); continue; }
      const c = current.get(p);
      if (c.index === null || String(c.index).startsWith('conflict:')) continue;
      if (c.index !== rs.blob) stageDrift.push(p + (rs.index === rs.blob ? '（第 ② 步时已暂存，之后暂存区被改过）' : '（第 ② 步时还没暂存：现在暂存的内容与第 ② 步复验的工作区内容不同）'));
      else if (rs.mode !== undefined && rs.mode !== null && c.mode !== undefined && c.mode !== null && rs.mode !== c.mode) stageDrift.push(p + `（git 文件模式 ${rs.mode} → ${c.mode}）`);
    }
  }
  return { gone, fresh, stale, stageBad, stageDrift, noStageRecord: recordedStage === null };
}
// 比较结果 → 问题文字（prefix 形如 `[api] ` 或 `空计划记录：`；freshNote(路径数组) 给「新出现的路径」补一句影响说明）。
function changeSnapshotMessages(res, prefix, freshNote) {
  const out = [];
  if (res.stale.length) out.push(`${prefix}复验之后这些改动文件的内容又变了（与 meta 记的 sha256 不一致）：${res.stale.join('、')}`);
  if (res.fresh.length) out.push(`${prefix}复验之后改动集里新出现了这些路径（不在 meta.changedFiles 里：第 ② 步之后才改动的文件，复验记录对它不作数，须重跑第 ②③ 步）：${res.fresh.join('、')}${freshNote ? freshNote(res.fresh) : ''}`);
  if (res.gone.length) out.push(`${prefix}复验之后这些路径从改动集里消失了（第 ② 步记录里有、现在不再属于改动集：撤销暂存 / 改回 HEAD / 删除都算；复验记录对不上当前要提交的内容，须重跑第 ②③ 步）：${res.gone.join('、')}`);
  if (res.stageBad.length) out.push(`${prefix}暂存区与工作区的内容不一致，第 ③ 步要求改动集里每个路径两边一致（放行的必须就是将要提交的内容；先 git add 这些路径，或撤销暂存让两边回到同一份）：${res.stageBad.slice(0, 20).map((x) => x.path + '（' + x.why + '）').join('、')}${res.stageBad.length > 20 ? ' …共 ' + res.stageBad.length + ' 个' : ''}`);
  if (res.noStageRecord) out.push(`${prefix}第 ② 步没有记暂存区指纹（changedStage；旧格式记录）：无法确认暂存内容就是复验过的内容，须重跑第 ②③ 步`);
  else if (res.stageDrift.length) out.push(`${prefix}暂存区里这些路径的内容与第 ② 步复验时的内容不一致（复验之后暂存区被改过）：${res.stageDrift.join('、')}`);
  return out;
}
// 「组测试侧文件」（codex 79 号裁定的保守规则）：某组的测试侧文件有改动 → 该组全部需人工复核条目（不含守卫类）都算受影响，补上栈帧规则的限度（先调用、已返回的搭数据助手不在栈上）。
//   名单取自来源清单里各组被加载的文件（已提交清单的 62 个 testFiles）：驱动文件 + 它加载的套件 / 助手文件；各组共用件改动 → 所有组。
//   M1：predeploy 四组（migration / archive / readonly / deploy）的驱动直接加载 schema-migration-core / cli / deploy-prestart / archive-core / archive-fs / temp-service / deploy-ssh.ps1，这些并入对应组的组级触发；
//   routes / public / server.js 这类产品文件不在名单里（驱动不加载它们的源码做测试侧用途），走文件交集。名单与加载链的核对见 testSideConsistency。
//   字符串 = 精确路径，正则 = 路径模式（api：lib/sysbuild-api-suite*.js；browser：lib/sysbuild-browser-*.js 即 suite / stage8 / trace-* 各件，与 verify-sysbuild-browser.js）。
const SHARED_TEST_SIDE = Object.freeze([
  'wbs-server/scripts/lib/test-env.js', 'wbs-server/scripts/lib/test-instance.js', 'wbs-server/scripts/_test-fixture.js', 'wbs-server/scripts/lib/sysbuild-mut-record.js',
  // M1（codex 79 号预筛）：test-env / test-instance 加载的起实例助手
  'wbs-server/scripts/lib/listen-safe-port.js', 'scripts/lines/line-proc.js', 'scripts/lines/line-common.js', 'scripts/lines/line-new.js', 'scripts/lines/state.js',
]);
const GROUP_TEST_SIDE = Object.freeze({
  api: Object.freeze([/^wbs-server\/scripts\/lib\/sysbuild-api-suite[^/]*\.js$/, 'wbs-server/scripts/verify-sysbuild-api.js']),
  browser: Object.freeze([/^wbs-server\/scripts\/lib\/sysbuild-browser-[^/]*\.js$/, 'wbs-server/scripts/verify-sysbuild-browser.js']),
  static: Object.freeze(['wbs-server/scripts/verify-sysbuild-static.js', 'wbs-server/scripts/lib/sysbuild-frontend-static.js']),
  schema: Object.freeze(['wbs-server/scripts/verify-sysbuild-schema.js']),
  db: Object.freeze(['wbs-server/scripts/verify-sysbuild-db.js']),
  attachments: Object.freeze(['wbs-server/scripts/verify-sysbuild-attachments.js']),
  // predeploy 四组：驱动直接加载的被测文件也并入「组级触发」（它们一改，该组全部条目都要复验；M1）
  migration: Object.freeze(['scripts/sysbuild-predeploy/run-migration-self-test.cjs', 'scripts/sysbuild-predeploy/verify-schema-migration.cjs', 'scripts/sysbuild-predeploy/schema-migration-mutations.cjs', 'scripts/sysbuild-predeploy/fixtures/schema-v1-v6.json', 'scripts/sysbuild-predeploy/schema-migration-core.cjs', 'scripts/sysbuild-predeploy/cli.cjs', 'scripts/sysbuild-predeploy/deploy-prestart.cjs', 'scripts/sysbuild-predeploy/archive-core.cjs', 'scripts/sysbuild-predeploy/archive-fs.cjs']),
  deploy: Object.freeze(['scripts/sysbuild-predeploy/verify-deploy-migration.cjs', 'scripts/sysbuild-predeploy/deploy-guard-unit.ps1.txt', 'scripts/deploy-ssh.ps1']),
  archive: Object.freeze(['scripts/sysbuild-predeploy/run-archive-self-test.cjs', 'scripts/sysbuild-predeploy/verify-archive.cjs', 'scripts/sysbuild-predeploy/archive-core.cjs', 'scripts/sysbuild-predeploy/archive-fs.cjs']),
  readonly: Object.freeze(['scripts/sysbuild-predeploy/run-readonly-self-test.cjs', 'scripts/sysbuild-predeploy/verify-readonly.cjs', 'scripts/sysbuild-predeploy/archive-core.cjs', 'scripts/sysbuild-predeploy/archive-fs.cjs', 'scripts/sysbuild-predeploy/cli.cjs', 'scripts/sysbuild-predeploy/schema-migration-core.cjs', /^scripts\/sysbuild-predeploy\/temp-service\//]),
});
// 改动文件里属于该组测试侧的（含共用件）；排序。
function testSideHit(group, changed) {
  const pats = [...SHARED_TEST_SIDE, ...(GROUP_TEST_SIDE[group] || [])];
  return Array.from(changed).filter((f) => pats.some((p) => (typeof p === 'string' ? p === f : p.test(f)))).sort();
}
// MED-2：产品侧组级触发。这些产品文件被各组驱动起的实例 / 夹具整体加载，改动影响组内几乎全部用例，不能只靠「哪个变异以它为目标」判受影响。
//   名单来源：routes/sysbuild 下被所有接口共用的入口与库层文件（index.js 挂载全部子路由，db.js / schema.js / migration-schema.js 是建表与连接层）、server.js（起实例）、wbs-server/utils/**（server.js 与 test-env 加载的工具，
//   即已提交来源清单里并入被加载文件的那批）。触发的组 = 起真实实例或开真实库跑用例的五组（api / browser / db / attachments / schema）；predeploy 四组按其已有的被测名单（GROUP_TEST_SIDE）。
//   代价：改这些文件时 api 整组要复验（约 28 分钟，基线实测）、browser 整组约 28 分钟，db / attachments / schema 各几分钟；兜底触发同样是 api + browser 整组。
//   残留（登记，不修）：被许多流程用到、但以它为目标的变异很少的产品文件（如 events.js 6 条、templates.js 3 条、materials-core.js 5 条），改动时 api 组只复验那几条；
//   非 api 组只要有一条受影响就整组跑，不受此影响。routes/sysbuild 以外的路由、package.json / package-lock.json 不在名单：它们出错时起实例即失败，不会悄悄漏过。
const PRODUCT_GROUP_TRIGGER = Object.freeze({
  files: Object.freeze(['wbs-server/routes/sysbuild/index.js', 'wbs-server/routes/sysbuild/db.js', 'wbs-server/routes/sysbuild/schema.js', 'wbs-server/routes/sysbuild/migration-schema.js', 'wbs-server/server.js']),
  patterns: Object.freeze([/^wbs-server\/utils\//]),
  groups: Object.freeze(['api', 'browser', 'db', 'attachments', 'schema']),
});
const FALLBACK_GROUPS = Object.freeze(['api', 'browser']);
const isProductTriggerFile = (f) => PRODUCT_GROUP_TRIGGER.files.includes(f) || PRODUCT_GROUP_TRIGGER.patterns.some((p) => p.test(f));
function productTriggerHit(group, changed) {
  return PRODUCT_GROUP_TRIGGER.groups.includes(group) ? Array.from(changed).filter(isProductTriggerFile).sort() : [];
}
// 兜底：routes/sysbuild/** 或 public/** 下、没有任何变异以它为目标（targets）、也不在任何触发名单里的改动文件。
function fallbackFilesOf(changed, targets) {
  const inAnyList = (f) => isProductTriggerFile(f) || SHARED_TEST_SIDE.includes(f) || Object.values(GROUP_TEST_SIDE).some((l) => l.some((p) => (typeof p === 'string' ? p === f : p.test(f))));
  return Array.from(changed).filter((f) => (f.startsWith('wbs-server/routes/sysbuild/') || f.startsWith('wbs-server/public/')) && !targets.has(f) && !inAnyList(f)).sort();
}
// 名单与驱动实际加载链核对（M1）：静态读各组驱动（commandOf 的脚本与指向仓库内文件的参数）的 require 链，递归到 wbs-server/scripts 与 scripts/ 下的本地文件
//   （只认字面量路径：require(…) / path.join(…) / path.resolve(…) 调用参数里的相对路径与仓库相对路径字符串、path.join(__dirname, …) 拼出的路径、predeploy 数据文件里的裸 .cjs / .json 文件名；
//   动态拼接路径（变量、表达式）加载的文件静态看不到，必须手工补进名单，自检不会替你发现；指到目录的 path.join(__dirname, …) 取目录下除 .md 外的全部文件；
//   不进 sysbuild-step1 工具目录；wbs-server/routes、utils 等产品侧不在这两个根下，不追）。
//   名单（SHARED_TEST_SIDE + 该组 GROUP_TEST_SIDE）与链逐项核对：链里有、名单没有 = 少；该组名单里有、链里没有 = 多；共用件一个组的链里都没出现 = 多。--self-test 对本仓库跑一遍，多 / 少都判红。
const CHAIN_ROOTS = ['wbs-server/scripts/', 'scripts/'];
const CHAIN_SKIP_RE = /^wbs-server\/scripts\/sysbuild-step1\//;
const statOf = (repo, rel) => { try { return fs.statSync(path.join(repo, ...rel.split('/'))); } catch (_) { return null; } };
const inChainRoots = (rel) => CHAIN_ROOTS.some((r) => rel.startsWith(r)) && !CHAIN_SKIP_RE.test(rel) && !rel.includes('node_modules/') && !rel.startsWith('../');
function listFilesUnder(repo, rel, out) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(repo, ...rel.split('/')), { withFileTypes: true }); } catch (_) { return out; }
  for (const e of ents) {
    const p = rel + '/' + e.name;
    if (e.isDirectory() && !e.isSymbolicLink()) { if (e.name !== 'node_modules') listFilesUnder(repo, p, out); } else if (e.isFile() && !/\.md$/.test(e.name)) out.push(p);
  }
  return out;
}
function chainCandidates(rel, text) {
  const dir = path.posix.dirname(rel);
  const out = [];
  for (const m of text.matchAll(/path\.join\(\s*__dirname\s*,\s*((?:(['"`])[^'"`\n]*\2\s*,?\s*)+)\)/g)) {
    const lits = Array.from(m[1].matchAll(/(['"`])([^'"`\n]*)\1/g)).map((x) => x[2]);
    out.push({ p: path.posix.join(dir, ...lits), dirOk: true });
  }
  const predeploy = rel.startsWith('scripts/sysbuild-predeploy/');
  // 只看 require(…) / path.join(…) / path.resolve(…) 调用参数里的字符串字面量（别处的字符串，例如帮助文字里提到的文件名，不算加载）
  for (const call of text.matchAll(/\b(?:require|path\.join|path\.resolve)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    for (const m of call[1].matchAll(/(['"`])([^'"`\n]{1,200})\1/g)) {
      const s = m[2];
      if (/^\.{1,2}\//.test(s)) out.push({ p: path.posix.join(dir, s), dirOk: false });
      else if (/^(?:wbs-server\/scripts|scripts)\//.test(s)) out.push({ p: path.posix.normalize(s), dirOk: false });
    }
  }
  // predeploy 目录里的驱动按变量取文件名（mutation.file、run(…) 的候选文件）：数据文件里写的裸文件名字面量也算（例如 schema-migration-mutations.cjs 里的 file: 'cli.cjs'）
  if (predeploy) for (const m of text.matchAll(/(['"`])([\w-]+\.(?:cjs|json))\1/g)) out.push({ p: path.posix.join(dir, m[2]), dirOk: false });
  return out;
}
function requireChain(repo, seeds) {
  const seen = new Set();
  const queue = seeds.slice();
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel) || !inChainRoots(rel)) continue;
    const st = statOf(repo, rel);
    if (!st || !st.isFile()) continue;
    seen.add(rel);
    if (!/\.(?:js|cjs)$/.test(rel)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8'); } catch (_) { continue; }
    for (const c of chainCandidates(rel, text)) {
      for (const ext of ['', '.js', '.cjs', '.json', '/index.js']) {
        const p = c.p + ext;
        const s = statOf(repo, p);
        if (s && s.isFile()) { queue.push(p); break; }
        if (s && s.isDirectory() && c.dirOk && ext === '') { queue.push(...listFilesUnder(repo, p, [])); break; }
      }
    }
  }
  return seen;
}
function groupSeeds(repo, group) {
  const out = [];
  for (const a of commandOf(group, repo)) {
    if (!path.isAbsolute(a)) continue;
    const rel = path.relative(repo, a).replace(/\\/g, '/');
    if (!rel.startsWith('../') && statOf(repo, rel)) out.push(rel);
  }
  return out;
}
function groupNameFiles(repo, group, groupLists) {
  const names = new Set();
  const all = [...CHAIN_ROOTS.flatMap((r) => listFilesUnder(repo, r.replace(/\/$/, ''), []))].filter(inChainRoots);
  for (const p of (groupLists || GROUP_TEST_SIDE)[group] || []) {
    if (typeof p === 'string') { if (statOf(repo, p)) names.add(p); } else for (const f of all) if (p.test(f)) names.add(f);
  }
  return names;
}
// 返回 { <组>: { missing, extra }, sharedNotLoadedByAnyGroup }；全空 = 名单与加载链一致。
function testSideConsistency(repo, lists) {
  const shared = new Set((lists ? lists.shared : SHARED_TEST_SIDE).filter((f) => statOf(repo, f)));
  const sharedSeen = new Set();
  const out = {};
  for (const g of ALL_GROUPS) {
    const chain = requireChain(repo, groupSeeds(repo, g));
    const names = groupNameFiles(repo, g, lists ? lists.groups : null);
    for (const f of chain) if (shared.has(f)) sharedSeen.add(f);
    out[g] = { missing: Array.from(chain).filter((f) => !names.has(f) && !shared.has(f)).sort(), extra: Array.from(names).filter((f) => !chain.has(f)).sort() };
  }
  return { groups: out, sharedNotLoadedByAnyGroup: Array.from(shared).filter((f) => !sharedSeen.has(f)).sort() };
}
// 受影响的条目（H2：文件交集或组测试侧改动命中的全部条目，不限需人工复核，守卫类同样按文件交集算）：[{ group, id, reasons, needReview, hitFiles（文件交集）, testSideFiles（组测试侧改动）, via }]，
//   via = ['文件交集'] / ['组测试侧改动'] / 两者；needReview = 是不是需人工复核（只决定要不要三字段登记；复验范围不看它）。base / cur：entries（cur 可为 null = 只看基线，--affected 用）。
//   MED-2（产品侧组级触发）：PRODUCT_GROUP_TRIGGER 里的产品文件（routes/sysbuild 的 index.js / db.js / schema.js / migration-schema.js、server.js、wbs-server/utils/**）改动 → api、browser、db、attachments、schema 整组受影响
//   （标「产品侧组级触发」）；另加兜底：改动集里任何 wbs-server/routes/sysbuild/** 或 wbs-server/public/** 文件，若没有任何变异以它为目标、也不在任何触发名单里，按 api + browser 整组受影响（标「兜底触发」），不会输出「无需复验」。
//   opts.targetsFrom：算「有没有变异以它为目标」用的完整基线 entries（闸门里 base 只是日志范围内的子集时要给；缺省 = base）。
function affectedOf(base, cur, changed, opts) {
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  const targets = new Set();
  for (const e of (opts && opts.targetsFrom) || base) for (const f of e.files || []) targets.add(normPath(f));
  const fallback = fallbackFilesOf(changed, targets);
  const out = [];
  for (const b of base) {
    const c = cm.get(keyOf(b)) || null;
    const reasons = Array.from(new Set([...reviewReasons(b.failures, b.group), ...reviewReasons(c ? c.failures : [], b.group)])).filter((r) => r !== 'guardNoStack').sort();
    const hit = Array.from(entryFileSet(b, c)).filter((f) => changed.has(f)).sort();
    const side = testSideHit(b.group, changed);
    const prod = productTriggerHit(b.group, changed);
    const fb = FALLBACK_GROUPS.includes(b.group) ? fallback : [];
    if (hit.length || side.length || prod.length || fb.length) out.push({ group: b.group, id: b.id, reasons, needReview: reasons.length > 0, hitFiles: hit, testSideFiles: side, productFiles: prod, fallbackFiles: fb, via: [...(hit.length ? ['文件交集'] : []), ...(side.length ? ['组测试侧改动'] : []), ...(prod.length ? ['产品侧组级触发'] : []), ...(fb.length ? ['兜底触发'] : [])] });
  }
  return out;
}
const viaText = (a) => [...(a.hitFiles.length ? ['文件交集：' + a.hitFiles.join('、')] : []), ...(a.testSideFiles.length ? ['组测试侧改动：' + a.testSideFiles.join('、')] : []), ...((a.productFiles || []).length ? ['产品侧组级触发：' + a.productFiles.join('、')] : []), ...((a.fallbackFiles || []).length ? ['兜底触发：' + a.fallbackFiles.join('、')] : [])].join('；');
// 复验计划（R1，codex 81 号 HIGH-1 / HIGH-2）：复验集合 = 自动范围（affectedOf；retire 的编号除外——它们已不在登记里，没有东西可复验）∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号。
//   effList = effective-list.js validateEffective 返回的 eff（null = 没有生效清单：只有自动范围，与改造前一致）。
//   有生效清单时，算「有没有变异以它为目标」（兜底触发）也按去掉 retire 之后的基线：只被已删变异当目标的文件，删除之后没有变异保护它，要走兜底。
//   返回 { live（去掉 retire 之后的基线 entries）, aff（自动范围的条目）, groups: Map<组, { auto, mustRun, by, remount, runIds }> }；组按 ALL_GROUPS 顺序，只含有编号要复验的组；
//   runIds = 去重后的有序并集：自动范围（基线顺序）、mustRun、by、remount（按生效清单里的顺序）。--rerun 与闸门第 ③ 步用同一个函数，所以两边的编号集合与顺序一定一致。
//   R1 修复批（预筛 HIGH-1）：currentKeys（当前登记里全部 group\0id，按登记顺序）给了，就把「当前登记有、<S> 时登记没有」的全部编号自动并入复验集合，来源记 added（不论生效清单声没声明）；
//   不给（只有纯函数自检用）则 added 只含生效清单里声明的。runIds 顺序：自动范围、mustRun、by、remount、added。
//   84 号 MEDIUM-2：「<S> 时登记」= sKeys（<S> 提交时点的登记，effective-list.js registryAtCommit）；不给时退回基线编号集合（只有纯函数自检与 --registry-file 测试钩子用）。
//   「活的基线」live = 基线条目里当前仍登记的（currentKeys 给了时）——C2 删掉的编号在 C3 不再被复验；没有 currentKeys 时只去掉本提交 retire 的。
//   S1 裁定 3：C1 之后新增的编号（当前登记有、固定基线没有）在后续提交里也进自动范围，不靠人写 mustRun——currentEntries（当前登记的条目 { group, id, files }，files = 登记里各 edit 的目标文件，
//   即定位字面量所在文件）给了，就为这类编号造「无基线失败位置」的条目（failures 为空、verdict 为 null），并进 live 一起走 affectedOf：目标文件参与文件交集，组级触发（组测试侧 / 产品侧）与零目标兜底
//   （它们的目标文件也算「有变异保护」）同样适用。它们没有基线失败位置，所以不分「需人工复核」；第 ③ 步对它们按「现在有基线没有」要求去向表三字段登记。
function rerunPlan(baseEntries, changed, effList, currentKeys, sKeys, currentEntries) {
  const baseKeySet = new Set(baseEntries.map(keyOf));
  const newcomers = (currentEntries || []).filter((e) => !baseKeySet.has(keyOf(e))).map((e) => ({ group: e.group, id: e.id, files: Array.isArray(e.files) ? e.files : [], verdict: null, failures: [], noBaselineLocation: true }));
  const live = [...baseEntries.filter((e) => (currentKeys ? currentKeys.has(keyOf(e)) : !(effList && effList.retiredKeys.has(keyOf(e))))), ...newcomers];
  const aff = affectedOf(live, null, changed);
  const per = new Map();
  const slot = (g) => { if (!per.has(g)) per.set(g, { auto: [], mustRun: [], by: [], remount: [], added: [], runIds: [] }); return per.get(g); };
  for (const x of aff) slot(x.group).auto.push(x.id);
  if (currentKeys) {
    const bk = sKeys || new Set(baseEntries.map(keyOf));
    for (const k of currentKeys) if (!bk.has(k)) { const i = k.indexOf('\u0000'); slot(k.slice(0, i)).added.push(k.slice(i + 1)); }
  }
  if (effList) {
    for (const r of effList.required) {
      const s = slot(r.group);
      if (r.source === 'added') { if (!s.added.includes(r.id)) s.added.push(r.id); } else s[r.source].push(r.id);
    }
  }
  const groups = new Map();
  for (const g of ALL_GROUPS) {
    if (!per.has(g)) continue;
    const s = per.get(g);
    s.runIds = Array.from(new Set([...s.auto, ...s.mustRun, ...s.by, ...s.remount, ...s.added]));
    groups.set(g, s);
  }
  return { live, aff, groups };
}
// 写进每组 meta 的生效清单记录：none = 只记理由；file = 清单文件名 / sha256 / 提交名 / 按来源列出的复验集合 / 并集。effCtx = { mode, reason?, sha256?, name?, eff? }。
const effSourcesOf = (slot) => ({ auto: slot.auto, mustRun: slot.mustRun, by: slot.by, remount: slot.remount, added: slot.added });
function effMetaOf(effCtx, slot) {
  if (!effCtx) return null;
  if (effCtx.mode === 'none') return { mode: 'none', reason: effCtx.reason };
  return { mode: 'file', file: effCtx.name, sha256: effCtx.sha256, commit: effCtx.eff.commit, ...(effCtx.eff.reason ? { reason: effCtx.eff.reason } : {}), sources: effSourcesOf(slot), runIds: slot.runIds };
}
// 生效清单上下文（--rerun、--affected 与闸门共用）：none 模式核「<S> 时登记 = 当前登记（没有增删）」与「改动集全部在 --effective-none 白名单内」（84 号 HIGH-3，第 ②③ 步同一个校验）；
//   file 模式读清单（读不到 / 有重复键抛错，调用方报用法错误）并过 schema 校验（编号增删按 <S> 时登记核对）。
//   返回 { ctx: { mode, reason | sha256 / name / eff } | null（校验没过时 file 模式为 null）, problems }。sKeys = <S> 时登记里全部 group\0id；currentKeys = 当前登记里全部 group\0id；changed = 改动路径集合（Set，与 changedFilesSince 同口径）。
function buildEffCtx(o, sKeys, currentKeys, changed, read) {
  if (o.effectiveNone !== null) return { ctx: { mode: 'none', reason: o.effectiveNone }, problems: effList.noneModeProblems(sKeys, currentKeys, Array.from(changed)) };
  const f = read || effList.readEffectiveFile(o.effective);
  const v = effList.validateEffective(f.doc, { groups: ALL_GROUPS, sKeys, currentKeys });
  return { ctx: v.eff ? { mode: 'file', sha256: f.sha256, name: path.basename(o.effective), eff: v.eff } : null, problems: [...v.problems, ...(v.eff ? effList.emptyListScopeProblems(v.eff, Array.from(changed)) : [])] };
}
// <S> 时登记的编号集合（--rerun、--affected 带生效清单、闸门第 ③ 步共用）：
//   正式路径 = effective-list.js registryAtCommit（在 <S> 提交的内容上真跑登记读取函数）；--s-registry-file <json>（[{group,id}]，测试钩子）直接给；
//   只给了 --registry-file（测试钩子，替换了当前登记）没给 --s-registry-file 时，<S> 时登记 = 基线编号（临时仓库没有登记代码可读）。返回 Set（group\0id）。
//   96 号 HIGH-1：正式闸门（第 ②③ 步与 --affected 带清单）的 <S> 必须 = HEAD 或 HEAD 的第一父提交（validateSinceCommit 的 gate 口径）。
//   96 号 HIGH-3：返回 { keys, digest: { sha256, count, source }, problems, note, drift, printed }——正式路径经 effective-list.js resolveSRegistry（读取器漂移时用 <S> 树自带的旧版读取器核对，摘要三步同一份）；
//   自检钩子（registryFile / sRegistryFile）直接给登记，不经读取器（摘要来源标「自检钩子」）。problems 非空时 keys 可能为 null（正式路径在读取器漂移且没有人工声明时不读登记）。
function loadSRegistry(o, baseEntries, changed) {
  effList.validateSinceCommit(o.repo, o.changedSince, undefined, { gate: true });
  if (o.sRegistryFile || o.registryFile) {
    let list;
    if (o.sRegistryFile) {
      list = readJson(o.sRegistryFile, '自检钩子 sRegistryFile');
      if (!Array.isArray(list) || list.some((x) => !x || typeof x.group !== 'string' || typeof x.id !== 'string')) throw new Error('自检钩子 sRegistryFile 须为 [{ group, id }] 数组');
    } else list = baseEntries.map((e) => ({ group: e.group, id: e.id }));
    const guard = sRegistryGuard(o, changed);
    return { keys: new Set(list.map(keyOf)), digest: effList.digestRecord(list, '自检钩子（内部注入）'), problems: guard.problems, note: guard.note, drift: guard.drift, printed: [] };
  }
  const rs = effList.resolveSRegistry(o.repo, o.changedSince, { changedPaths: Array.from(changed), attest: o.sRegistryAttest });
  return { keys: rs.keys, digest: rs.digest, problems: rs.problems, note: rs.note, drift: rs.drift, printed: rs.printed };
}
// 读取器漂移硬门（94 号 HIGH-3；第 ②③ 步与 --affected 带清单时共用）：只在 <S> 时登记由 registryAtCommit 读（当前读取器）时有意义；自检钩子（registryFile / sRegistryFile）直接给登记，不经读取器，跳过。
//   changed = 改动路径集合（已剔除排除项）。返回 { problems, note, drift: 是否命中链路 }。
function sRegistryGuard(o, changed) {
  if ((o.sRegistryFile || o.registryFile) && !o.forceDriftGuard) return { problems: [], note: null, drift: false }; // forceDriftGuard：自检钩子，让带登记钩子的自检也走这道门（只有 main(argv, hooks) 能设）
  const r = effList.sRegistryDriftProblems(Array.from(changed), o.sRegistryAttest);
  return { ...r, drift: effList.readerChainHits(Array.from(changed)).length > 0 };
}
// 闸门第 ③ 步对生效清单的逐条核对（file 模式；none 模式没有可核的清单，只靠 meta 的模式 / 理由绑定与 noneModeProblems）。
//   metas：{ 组: meta | null }；scopeKeys：日志里有结果行的变异；cur：当次运行的 entries；texts：{ 组: 原始日志文本 }；dispositions：去向表全部登记。返回问题数组。
//   ⓪ 全部复验编号（含自动范围）的「合格结果」在 qualifiedResultProblems 里统一核对（日志有结果行、所在组未变异对照全绿、当次判红、失败不是夹具失败 / 装载异常；存活或只有夹具失败 → 拒，不能靠去向表放行，要放弃守护的变异进 retire）。
//   ① mustRun / by / remount 新编号：该组要有复验日志与 meta；meta.effective.runIds（meta 绑定的编号）里要有；日志里要有结果行——缺一条拒绝（81 HIGH-1 / HIGH-2：「清单认定要复验」必须真复验过）。
//   ② retire 的每个旧编号在去向表里恰好一行，带对应处置类别与该类别要求的字段（effective-list.js retireDispositionProblems）。
//   ③ equivalent 的每个承接编号（81 HIGH-2 的两步复验）：先证明未变异时通过（该组驱动日志里的未变异基线行存在且全绿），再证明变异后被抓住（当次运行判红、有可作证据的失败，
//      装载异常 / 夹具失败不算），且登记行的「承接命中证据」对得上它的一个失败（用例名 + 信息首行前 60 字 + 位置键，与 reviewGate 同口径）。
//      证据核对只证明「这条失败存在」，等价业务错误是否真是被删变异原来要抓的那个，由人在登记行里写、审查确认，本工具不判。
function effectiveGateProblems({ eff, metas, scopeKeys, cur, texts, dispositions }) {
  const problems = [];
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  for (const r of eff.required) {
    const tag = `[${r.group}] ${JSON.stringify(r.id)}（生效清单 ${r.source}）`;
    const m = metas[r.group];
    if (!m) { problems.push(tag + '：这一组没有复验日志与 meta，该编号没有被复验'); continue; }
    if (!m.effective || m.effective.mode !== 'file' || !Array.isArray(m.effective.runIds) || !m.effective.runIds.includes(r.id)) problems.push(tag + '：不在 meta 绑定的复验编号里（meta.effective.runIds）');
    if (!scopeKeys.has(keyOf(r))) problems.push(tag + '：本次原始日志里没有这条变异的结果行');
  }
  // 预筛 HIGH-1：新增的变异（added 与 remount 的新编号 = 当前登记 − 基线）光「执行过」不够，当次必须判红，且失败不能只是夹具失败 / 装载异常；
  //   三字段登记与命中证据由通用闸门（reviewGate：现在有基线没有 → 要登记）核对。
  //   「合格结果」（方案 v1.6 5.4 第 ③ 步，S1 裁定）已扩到全部复验编号（含自动范围），在 qualifiedResultProblems 里统一核对，这里不再重复。
  problems.push(...effList.retireDispositionProblems(eff, dispositions));
  for (const r of eff.retire) {
    if (r.category !== 'equivalent') continue;
    const row = (dispositions || []).find((d) => keyOf(d) === keyOf(r) && d['提交'] === eff.commit); // 累计去向表：只看本次提交的行
    for (const b of r.by) {
      const tag = `retire [${r.group}] ${JSON.stringify(r.id)} 的承接 [${b.group}] ${JSON.stringify(b.id)}`;
      const c = cm.get(keyOf(b));
      if (!c) { problems.push(tag + '：当次运行里没有它的结果（承接变异没有执行）'); continue; }
      const baseLine = lineOf(texts[b.group], BASELINE_RE[b.group], false);
      if (!baselineGreen(baseLine)) problems.push(tag + '：该组驱动日志里的未变异基线行缺失或不是全绿（承接变异要先证明未变异时通过）：' + JSON.stringify(baseLine));
      const valid = c.verdict === rec.VERDICT.RED ? (c.failures || []).filter((f) => !isLoadOrFixtureFailure(f)) : [];
      const mixedBy = mixedLoadExceptionProblem(c, tag); // 89 号 MEDIUM：承接编号同样——合格命中 + 装载异常并存 → 拒
      if (mixedBy) problems.push(mixedBy);
      if (valid.length === 0) { problems.push(tag + '：当次运行判定 ' + c.verdict + '，没有可作命中证据的失败（承接变异必须被抓住；失败都是装载异常 / 夹具失败或没有失败）'); continue; }
      const ev = row && typeof row['承接命中证据'] === 'string' ? row['承接命中证据'] : '';
      if (ev.trim() !== '' && !valid.some((f) => evidenceMatches(ev, f, b.group))) problems.push(tag + '：登记行的「承接命中证据」对不上它当次运行里的失败（应含失败用例名、信息首行前 60 字与位置键，例如 ' + JSON.stringify(valid[0].case) + ' / ' + JSON.stringify(String(valid[0].message || '').slice(0, 60)) + ' / ' + JSON.stringify(locationKeysOf(valid[0])) + '）');
    }
  }
  return problems;
}
// 「合格结果」（方案 v1.6 5.4 第 ③ 步，S1 裁定）：日志里有结果行的每个仍登记编号——复验集合（plan.groups 里每组的 runIds：自动范围 ∪ mustRun ∪ by ∪ remount ∪ added，含 C1 之后新增编号的自动范围）
//   以及非 api 组整组跑时集合之外的条目（S1 再裁定）——都要：所在组驱动日志里的未变异对照行全绿（按组报一次）、当次判红、失败不是夹具失败 / 装载异常。存活（未判红）或只有夹具失败 / 装载异常 → 拒，去向表登记放不过；
//   确实要放弃守护的变异必须进 retire。「变了」只允许是判红但失败位置或信息变化（仍须三字段登记，由 reviewGate / compareBaselines 核）。没有结果行的编号由别处报（自动范围 → 「没有复验记录」，清单必跑 → effectiveGateProblems）。
//   equivalent 的 by 已在 effectiveGateProblems 的承接逐条核对里做同样三项，这里跳过只来自 by 的编号。eff 为 null（--effective-none）时只有自动范围。返回问题数组。
function qualifiedResultProblems({ plan, eff, cur, texts }) {
  const problems = [];
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  const srcOf = new Map();
  for (const r of (eff ? eff.required : [])) { const k = keyOf(r); if (!srcOf.has(k)) srcOf.set(k, []); srcOf.get(k).push(r.source); }
  const inPlan = new Set();
  for (const [g, s] of plan.groups) for (const id of s.runIds) inPlan.add(g + '\u0000' + id);
  const baselineBadGroups = new Set();
  // S1 再裁定：范围 = 日志里有结果行的每个仍登记编号（cur），含非 api 组整组跑时复验集合之外的条目——整组跑出的存活就是真实的守护丢失或不稳定，不靠登记放行
  for (const c of (cur || [])) {
    const g = c.group;
    const id = c.id;
    const k = keyOf(c);
    const srcs = srcOf.get(k) || [];
    if (srcs.length && srcs.every((x) => x === 'by')) continue;
    if (!baselineBadGroups.has(g)) {
      baselineBadGroups.add(g);
      const baseLine = lineOf(texts[g], BASELINE_RE[g], false);
      if (!baselineGreen(baseLine)) problems.push(`[${g}] 该组驱动日志里的未变异对照行缺失或不是全绿（日志里有结果行的编号要先证明未变异时通过；去向表登记放不过）：` + JSON.stringify(baseLine));
    }
    const valid = c.verdict === rec.VERDICT.RED ? (c.failures || []).filter((f) => !isLoadOrFixtureFailure(f)) : [];
    const labels = srcs.filter((x) => x !== 'by');
    const tagOf = (lab) => `[${g}] ${JSON.stringify(id)}（${lab ? '生效清单 ' + lab : (inPlan.has(k) ? '复验集合：自动范围' : '日志结果：复验集合之外（整组跑出）')}）`;
    const mixed = mixedLoadExceptionProblem(c, tagOf(labels[0] || null)); // 89 号 MEDIUM：合格命中 + 装载异常并存 → 单列拒绝
    if (mixed) problems.push(mixed);
    if (valid.length) continue;
    if (labels.length === 0) problems.push(`${tagOf(null)}：当次判定 ${c.verdict}，没有可作命中证据的失败（日志里有结果行的仍登记变异必须判红且失败不是夹具失败 / 装载异常；存活的变异不能靠去向表登记放行，确实要放弃守护的进 retire）`);
    for (const lab of labels) problems.push(lab === 'mustRun'
      ? `${tagOf(lab)}：当次判定 ${c.verdict}，没有可作命中证据的失败（仍登记的复验编号必须判红且失败不是夹具失败 / 装载异常；存活的变异不能靠去向表登记放行，确实要放弃守护的进 retire）`
      : `${tagOf(lab)}：新增变异当次判定 ${c.verdict}，没有可作命中证据的失败（新增的变异必须判红，且失败不是夹具失败 / 装载异常）`);
  }
  return problems;
}
// R1 修复批（建议项）：第 ③ 步对每条 equivalent，把被删编号在基线里的失败与承接编号当次的失败并排打印（用例名 | 位置键 | 信息首行前 60 字），供人工核对「等价业务错误」；只打印，不改判定。
function equivalentSideBySide(eff, baseEntries, cur) {
  const bm = new Map((baseEntries || []).map((e) => [keyOf(e), e]));
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  const fmt = (f) => `${f.case} | ${locationKeysOf(f).join(' ; ') || '(无位置键)'} | ${String(f.message === undefined || f.message === null ? '' : f.message).split(/\r?\n/)[0].slice(0, 60)}`;
  const side = (label, e) => (!e ? [`    ${label}：（没有这条记录）`] : (e.failures || []).length === 0 ? [`    ${label}：判定 ${e.verdict}，没有失败`] : (e.failures || []).slice(0, 5).map((f) => `    ${label}：${fmt(f)}`).concat((e.failures || []).length > 5 ? [`    ${label}：…另有 ${(e.failures || []).length - 5} 条失败未列`] : []));
  const out = [];
  for (const r of eff.retire) {
    if (r.category !== 'equivalent') continue;
    for (const b of r.by) out.push(`  承接对照 retire ${`[${r.group}] ${JSON.stringify(r.id)}`} ← 承接 ${`[${b.group}] ${JSON.stringify(b.id)}`}`, ...side('基线（被删编号）', bm.get(keyOf(r))), ...side('当次（承接编号）', cm.get(keyOf(b))));
  }
  return out;
}
// R1 修复批（MED-2 零复验提交）：--rerun 在复验集合为空时写 empty-plan.json（绑定 HEAD、改动文件集合 sha256、生效清单 sha256 或 none 理由、起始时刻）；第 ③ 步在目录里没有任何 <组>.log、只有这份记录时，
//   用当前 HEAD / 改动集 / 生效清单重算复验计划，确实为空且绑定字段全部一致才放行；任一不符拒绝。
const EMPTY_PLAN_FORMAT = 'sysbuild-empty-rerun/1';
// 版本 3（95 号 HIGH-2）：在 2 的基础上分列「计划编号 plannedIds」与「实跑编号 ranIds」（复验结束后按第 ③ 步同口径从各组日志解析：日志里实际有结果行的仍登记编号；非 api 组整组跑，会跑出计划外的编号，
//   单列在 outOfPlanIds，来源标「整组实跑」），并带结束记录（complete / ignoredInputsEnd）；C9 用实跑编号追溯，拒收旧版本留档（C2 之前没有正式留档，不兼容）。
const RERUN_FORMAT = 'sysbuild-rerun/3'; // <复验目录>/rerun.json 的格式（第 ② 步写；C9 累计范围读）
// 路径 → sha256 的指纹（按路径排序；Map 或自有属性对象都收，不用 `in` / 原型链）
const changedShaOf = (m) => { const entries = m instanceof Map ? Array.from(m.entries()) : Object.entries(m || {}); return sha256Of(Buffer.from(JSON.stringify(entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))), 'utf8')); };
// 先写临时文件、再 rename 替换（98 号 MEDIUM：rerun.json / empty-plan.json / gate-pass.json 都不留写到一半的文件；Windows 下 rename 覆盖已有文件）
function writeFileAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (_) { /* 没有临时文件 */ } throw e; }
}
const commitNameOf = (effCtx) => (effCtx.mode === 'file' ? effCtx.eff.commit : 'none:' + effCtx.reason.slice(0, 40));
// 97 号 MEDIUM：sysbuild-rerun/3 留档的结构校验（第 ③ 步 rerunJsonEndProblems、空计划路径 emptyRerunJsonProblems 与 C9 cumulativeAffected 共用；不合法统一返回问题，不抛异常）：
//   groups / plannedIds / ranIds / outOfPlanIds / results 都是对象，且后四者的组键与计划组（groups 的键）一致；三组编号的每个值是去重后的非空字符串数组；plannedIds[g] 与 groups[g].runIds 同一份；
//   results[g].exitCode 是整数或 null（被信号终止）。空计划 = 全部是空对象。
function rerunStructureProblems(rj) {
  const out = [];
  const plain = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
  if (!plain(rj)) return ['rerun.json 不是对象'];
  if (!plain(rj.groups)) return ['groups 不是对象'];
  const gk = Object.keys(rj.groups).sort();
  for (const g of gk) if (!ALL_GROUPS.includes(g)) out.push(`groups 里有不认识的组 ${JSON.stringify(g)}`);
  for (const name of ['plannedIds', 'ranIds', 'outOfPlanIds', 'results']) {
    const m = rj[name];
    if (!plain(m)) { out.push(`${name} 不是对象（缺失或类型不对）`); continue; }
    const keys = Object.keys(m).sort();
    if (keys.join(',') !== gk.join(',')) out.push(`${name} 的组 ${JSON.stringify(keys)} 与计划组 ${JSON.stringify(gk)} 不一致`);
    for (const g of keys) {
      const v = m[g];
      if (name === 'results') {
        if (!plain(v) || !(v.exitCode === null || Number.isInteger(v.exitCode))) out.push(`results[${g}] 不是 { exitCode: 整数或 null } 形态的退出状态`);
        continue;
      }
      if (!Array.isArray(v)) { out.push(`${name}[${g}] 不是数组（是 ${v === null ? 'null' : typeof v}）`); continue; }
      const badAt = v.findIndex((x) => typeof x !== 'string' || x === '');
      if (badAt >= 0) out.push(`${name}[${g}] 的第 ${badAt + 1} 个元素不是非空字符串`);
      else if (new Set(v).size !== v.length) out.push(`${name}[${g}] 有重复编号`);
    }
  }
  for (const g of gk) {
    const s = rj.groups[g];
    if (!plain(s) || !Array.isArray(s.runIds)) { out.push(`groups[${g}].runIds 不是数组`); continue; }
    if (plain(rj.plannedIds) && Array.isArray(rj.plannedIds[g]) && JSON.stringify(rj.plannedIds[g]) !== JSON.stringify(s.runIds)) out.push(`plannedIds[${g}] 与 groups[${g}].runIds 不是同一份计划`);
  }
  return out;
}
// 空计划路径的 rerun.json 核对（97 号 MEDIUM）：第 ② 步先写 empty-plan.json、再写 rerun.json，两次写入之间中断、或归档时漏掉 rerun.json，C9 才会拒；所以第 ③ 步在空计划路径也必须读并校验 rerun.json——
//   存在、可读、sysbuild-rerun/3、complete、emptyPlan = true、与 empty-plan.json 属于同一轮（<S> / 起始 HEAD / 改动文件集合摘要 / 清单口径一致，且与本次一致）、结构合法且计划与实跑都为空。返回问题数组（前缀「rerun.json：」）。
function emptyRerunJsonProblems({ rawDir, since, head, effCtx }) {
  const out = [];
  const P = (s) => out.push('rerun.json：' + s);
  let rj = null;
  try { rj = JSON.parse(fs.readFileSync(path.join(rawDir, 'rerun.json'), 'utf8')); } catch (e) { P('读不到或不是 JSON（' + e.message + '）：空计划目录也必须有第 ② 步写的 rerun.json（C9 累计范围靠它；只留 empty-plan.json 说明第 ② 步写到一半中断，或归档时漏了它），拒；须重跑第 ②③ 步'); return out; }
  if (!rj || rj.format !== RERUN_FORMAT) { P('format 不是 ' + RERUN_FORMAT + '（旧格式留档不收）'); return out; }
  if (rj.complete !== true) P('没有结束记录（complete 不是 true）：第 ② 步没有写完（中断？）');
  if (rj.emptyPlan !== true) P('emptyPlan 不是 true：目录里是空计划记录，rerun.json 却说本次复验不是空计划（不是同一轮的记录）');
  if (rj.changedSince !== since) P(`记的 --changed-since ${rj.changedSince} 与本次 ${since} 不同`);
  if (!rj.context || rj.context.startHead !== head) P(`记的起始 HEAD ${rj.context && rj.context.startHead} 不是当前 HEAD ${head}`);
  const wantCommit = effCtx ? commitNameOf(effCtx) : null;
  if (wantCommit !== null && rj.commit !== wantCommit) P(`记的提交名 ${JSON.stringify(rj.commit)} 与本次 ${JSON.stringify(wantCommit)} 不同`);
  if (effCtx) {
    const rje = rj.effective;
    if (effCtx.mode === 'file') { if (!rje || rje.mode !== 'file' || rje.sha256 !== effCtx.sha256 || rje.commit !== effCtx.eff.commit) P(`记的生效清单 ${JSON.stringify(rje || null)} 与本次（file，sha256 ${effCtx.sha256}，commit ${JSON.stringify(effCtx.eff.commit)}）不一致`); }
    else if (!rje || rje.mode !== 'none' || rje.reason !== effCtx.reason) P(`记的生效清单 ${JSON.stringify(rje || null)} 与本次（--effective-none ${JSON.stringify(effCtx.reason)}）不一致`);
  }
  // 与 empty-plan.json 同一轮：起始 HEAD / <S> / 改动文件集合摘要
  let ep = null;
  try { ep = JSON.parse(fs.readFileSync(path.join(rawDir, 'empty-plan.json'), 'utf8')); } catch (_) { ep = null; }
  if (ep) {
    if (rj.context && ep.startHead !== rj.context.startHead) P(`起始 HEAD ${rj.context.startHead} 与 empty-plan.json 记的 ${ep.startHead} 不同（不是同一轮的两份记录）`);
    if (ep.changedSince !== rj.changedSince) P(`--changed-since ${rj.changedSince} 与 empty-plan.json 记的 ${ep.changedSince} 不同（不是同一轮的两份记录）`);
    if (rj.context && rj.context.changedFiles && typeof rj.context.changedFiles === 'object' && ep.changedFilesSha256 !== changedShaOf(rj.context.changedFiles)) P('改动文件集合与 empty-plan.json 记的 changedFilesSha256 对不上（不是同一轮的两份记录）');
  }
  const sp = rerunStructureProblems(rj);
  if (sp.length) for (const s of sp) P('结构不合法：' + s);
  else if (Object.keys(rj.groups).length !== 0) P(`空计划的 rerun.json 里复验组不是空的（${Object.keys(rj.groups).join('、')}）：计划与实跑都应为空集合`);
  return out;
}
// 97 号 HIGH：第 ③ 步通过凭据 gate-pass.json（第 ③ 步成功时写进复验目录；C9 对每份留档核）。凭据绑定三样东西：这份留档的 rerun.json（sha256）、第 ③ 步核过的待提交内容（树指纹）、<S> 与生效清单口径（清单 sha256 / commit，或 none 理由）。
//   树指纹 = 改动集（剔除声明的排除项：复验目录 / --dispositions / --report）里每个路径在「暂存区」（第 ③ 步时；暂存区 = 工作区 = 第 ② 步复验过的内容）的 [路径, git 文件模式, blob 号]（不在树里 = [路径, null, null]），按路径排序，对整个数组取 sha256；
//   凭据里同时存完整 entries。C9 把它映射到的提交 X 的树上、同一批路径取同一口径的 [路径, 模式, blob 号]，必须逐项相同，且 X 自己的改动集（X 与其父提交之差，扣掉同一份排除项）的路径集合必须与凭据一致；
//   末尾映射到还没提交的工作区的那份，改与当前暂存区比。这样同一个父提交下跑过两轮、都过了第 ③ 步而只有后一轮入库时，误传前一轮的目录会因树指纹对不上被拒。
const GATE_PASS_FORMAT = 'sysbuild-gate-pass/1';
const GATE_PASS_FILE = 'gate-pass.json';
const gateEntriesDigest = (entries) => sha256Of(Buffer.from(JSON.stringify(entries), 'utf8'));
const sortedPaths = (paths) => Array.from(paths).map(normPath).sort();
function gateTreeEntriesFromIndex(repo, paths) {
  const idx = gitIndexMap(repo);
  return sortedPaths(paths).map((p) => { const ix = idx.get(p); return ix && ix.stage === 0 ? [p, ix.mode, ix.oid] : [p, null, null]; });
}
function gateTreeEntriesFromCommit(repo, commit, paths) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'ls-tree', '-r', '-z', '--full-tree', commit], { maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error('读不到 git ls-tree ' + commit);
  const m = new Map();
  for (const rec of effList.utf8Strict(r.stdout, 'git ls-tree').split('\0').filter(Boolean)) {
    const x = /^(\d+) (\w+) ([0-9a-f]{40})\t(.*)$/s.exec(rec);
    if (!x) throw new Error('读不懂 git ls-tree 的一行：' + rec.slice(0, 80));
    m.set(normPath(x[4]), [x[1], x[3]]);
  }
  return sortedPaths(paths).map((p) => (m.has(p) ? [p, m.get(p)[0], m.get(p)[1]] : [p, null, null]));
}
const effectiveBriefOf = (effCtx) => (effCtx.mode === 'file' ? { mode: 'file', sha256: effCtx.sha256, commit: effCtx.eff.commit } : { mode: 'none', reason: effCtx.reason });
const effectiveBriefMatches = (a, b) => !!a && !!b && a.mode === b.mode && (a.mode === 'file' ? a.sha256 === b.sha256 && a.commit === b.commit : a.reason === b.reason);
function buildGatePass({ since, head, commit, effective, rerunSha256, exclusions, entries }) {
  return { format: GATE_PASS_FORMAT, passedAt: new Date().toISOString(), changedSince: since, startHead: head, commit, effective, rerunJsonSha256: rerunSha256, exclusions: normExcl(exclusions || { files: [], dirs: [] }), treeFingerprint: { sha256: gateEntriesDigest(entries), entries } };
}
// 第 ③ 步全部通过后写凭据（rawDir 里的 rerun.json 此时已被第 ③ 步读过并核过；空计划与非空计划都有 rerun.json）。返回写出的文件路径与树指纹摘要。
function writeGatePass({ rawDir, repo, since, effCtx, changedSet, exclusions }) {
  const rjBytes = fs.readFileSync(path.join(rawDir, 'rerun.json'));
  const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
  const entries = gateTreeEntriesFromIndex(repo, changedSet);
  const doc = buildGatePass({ since, head, commit: commitNameOf(effCtx), effective: effectiveBriefOf(effCtx), rerunSha256: sha256Of(rjBytes), exclusions, entries });
  const file = path.join(rawDir, GATE_PASS_FILE);
  writeFileAtomic(file, JSON.stringify(doc, null, 2) + '\n');
  return { file, sha256: doc.treeFingerprint.sha256, count: entries.length };
}
// C9 对一份留档核凭据（c：{ dir, name, changedSince, startHead, rerunSha256, effective, exclusions, mappedCommit }；mappedCommit = 链核对映射到的实际提交，null = 还没提交的工作区）。返回问题数组。
function gatePassProblems(repo, c) {
  const tag = `${c.dir}（${c.name}）`;
  let gp = null;
  try { gp = JSON.parse(fs.readFileSync(path.join(c.dir, GATE_PASS_FILE), 'utf8')); } catch (e) { return [`${tag}：没有第 ③ 步通过凭据 ${GATE_PASS_FILE}（${e.message}）：这份留档的第 ③ 步没通过、没在这个目录里跑过，或凭据被删——C9 无法确认它对应的提交内容`]; }
  if (!gp || gp.format !== GATE_PASS_FORMAT) return [`${tag}：${GATE_PASS_FILE} 的 format 不是 ${GATE_PASS_FORMAT}`];
  const out = [];
  const P = (s) => out.push(`${tag}：${s}`);
  if (gp.rerunJsonSha256 !== c.rerunSha256) P(`rerun.json 的 sha256（${c.rerunSha256.slice(0, 16)}…）与凭据记的（${String(gp.rerunJsonSha256).slice(0, 16)}…）不一致：留档在第 ③ 步通过之后被改过，或凭据来自别的复验目录`);
  if (gp.changedSince !== c.changedSince) P(`凭据记的 <S> ${gp.changedSince} 与 rerun.json 的 ${c.changedSince} 不同`);
  if (gp.startHead !== c.startHead) P(`凭据记的起始 HEAD ${gp.startHead} 与 rerun.json 的 ${c.startHead} 不同`);
  if (gp.commit !== c.name) P(`凭据记的提交名 ${JSON.stringify(gp.commit)} 与 rerun.json 的 ${JSON.stringify(c.name)} 不同`);
  if (!effectiveBriefMatches(gp.effective, c.effective)) P(`凭据记的生效清单口径 ${JSON.stringify(gp.effective || null)} 与 rerun.json 记的 ${JSON.stringify(c.effective || null)} 不一致（清单 sha256 / commit 或 none 理由）`);
  const tf = gp.treeFingerprint;
  const shapeOk = tf && Array.isArray(tf.entries) && tf.entries.every((e) => Array.isArray(e) && e.length === 3 && typeof e[0] === 'string' && (e[1] === null || typeof e[1] === 'string') && (e[2] === null || typeof e[2] === 'string'));
  if (!shapeOk) { P('treeFingerprint.entries 不是 [路径, 模式, blob 号] 的数组（凭据损坏）'); return out; }
  const paths = tf.entries.map((e) => e[0]);
  if (tf.sha256 !== gateEntriesDigest(tf.entries)) P('树指纹 sha256 与凭据自己记的 entries 对不上（凭据被改过）');
  if (new Set(paths).size !== paths.length || paths.some((p, i) => i > 0 && !(paths[i - 1] < p))) P('树指纹的路径不是按路径排序且互不重复的（凭据损坏）');
  const excl = normExcl(c.exclusions);
  let want;
  let actual;
  let label;
  try {
    if (c.mappedCommit) {
      label = '提交 ' + c.mappedCommit.slice(0, 12);
      want = gateTreeEntriesFromCommit(repo, c.mappedCommit, paths);
      const par = (gitOut(repo, ['rev-parse', '--verify', '--quiet', c.mappedCommit + '^']) || '').trim();
      if (!par) throw new Error('提交 ' + c.mappedCommit.slice(0, 12) + ' 没有父提交，取不到它的改动集');
      const d = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', par, c.mappedCommit], { maxBuffer: 1024 * 1024 * 1024 });
      if (d.status !== 0) throw new Error('读不到 git diff ' + par.slice(0, 12) + ' ' + c.mappedCommit.slice(0, 12));
      actual = effList.utf8Strict(d.stdout, 'git diff').split('\0').filter(Boolean).map(normPath);
    } else {
      label = '当前暂存区（末份留档对应还没提交的工作区）';
      want = gateTreeEntriesFromIndex(repo, paths);
      actual = Array.from(effList.changedPathsSince(repo, c.changedSince)).map(normPath);
    }
  } catch (e) { P('取不到提交内容 / 改动集，无法核对树指纹：' + e.message); return out; }
  actual = Array.from(new Set(actual.filter((p) => !isExcludedBy(excl, p)))).sort();
  const extra = actual.filter((p) => !paths.includes(p));
  const missing = paths.filter((p) => !actual.includes(p));
  if (extra.length || missing.length) P(`改动集对不上：「${label}」的改动路径（扣掉声明的排除项）比凭据多 ${extra.length} 个${extra.length ? '（' + extra.slice(0, 5).join('、') + '）' : ''}、少 ${missing.length} 个${missing.length ? '（' + missing.slice(0, 5).join('、') + '）' : ''}：这份留档的第 ③ 步放行的不是最终入库的内容（同一父提交下较早一轮的目录？）`);
  const diffs = tf.entries.filter((e, i) => JSON.stringify(e) !== JSON.stringify(want[i]));
  if (diffs.length) P(`凭据里的待提交树指纹与「${label}」的实际内容对不上（${diffs.length} 个路径：${diffs.slice(0, 5).map((e) => e[0]).join('、')}${diffs.length > 5 ? ' …' : ''}）：这份留档是同一父提交下较早一轮（或别的内容）的第 ③ 步通过记录，不是最终入库的内容`);
  return out;
}
function cumulativeGatePassProblems(repo, commits) {
  const out = [];
  for (const c of commits) {
    if (c.mappedCommit === undefined) { out.push(`${c.dir}（${c.name}）：链核对没有给出这份留档对应的提交，无法核对第 ③ 步通过凭据`); continue; }
    out.push(...gatePassProblems(repo, c));
  }
  return out;
}
function emptyPlanRecord(ctx, effCtx) {
  const effective = effCtx.mode === 'file' ? { mode: 'file', file: effCtx.name, sha256: effCtx.sha256, commit: effCtx.eff.commit, ...(effCtx.eff.reason ? { reason: effCtx.eff.reason } : {}) } : { mode: 'none', reason: effCtx.reason };
  return { format: EMPTY_PLAN_FORMAT, startHead: ctx.startHead, changedSince: ctx.changedSince, changedFiles: ctx.changedFiles, changedFilesSha256: changedShaOf(ctx.changedFiles), changedStage: ctx.changedStage, exclusions: ctx.exclusions, ignoredInputs: ctx.ignoredInputs, sRegistryAttest: ctx.sRegistryAttest, sRegistry: ctx.sRegistry, effective, startedAt: new Date().toISOString(), groups: [] };
}
// <复验目录>/rerun.json（第 ② 步写；C9 累计范围读，format sysbuild-rerun/3）：提交名、生效清单模式 / sha256、该提交的 retire / added、每组的复验计划（auto / mustRun / by / remount / added / runIds）与计划编号 plannedIds、
//   实跑编号 ranIds、计划外的整组实跑编号 outOfPlanIds、各组驱动退出码（results）、运行上下文、结束记录（complete）。
//   ran：{ <组>: [实际有结果行的仍登记编号] }（ranIdsFromLogs 的结果；空计划 = {}）；ignoredInputsEnd：复验结束时再取的被忽略运行输入摘要（空计划不跑驱动，不记）。
function rerunRecord({ o, ctx, effCtx, aff, plan, results, emptyPlan, ran, ignoredInputsEnd }) {
  const effective = effCtx.mode === 'file' ? { mode: 'file', file: path.basename(o.effective), sha256: effCtx.sha256, commit: effCtx.eff.commit, ...(effCtx.eff.reason ? { reason: effCtx.eff.reason } : {}) } : { mode: 'none', reason: effCtx.reason };
  const ranIds = {};
  const plannedIds = {};
  const outOfPlanIds = {};
  for (const [g, s] of plan.groups) plannedIds[g] = s.runIds.slice();
  for (const g of ALL_GROUPS) {
    if (!ran || !Object.prototype.hasOwnProperty.call(ran, g)) continue;
    ranIds[g] = ran[g].slice();
    const planned = new Set(plannedIds[g] || []);
    outOfPlanIds[g] = ran[g].filter((id) => !planned.has(id));
  }
  return { format: RERUN_FORMAT, commit: effCtx.mode === 'file' ? effCtx.eff.commit : 'none:' + effCtx.reason.slice(0, 40), changedSince: o.changedSince, context: ctx, effective, retire: effCtx.mode === 'file' ? effCtx.eff.retire : [], added: effCtx.mode === 'file' ? effCtx.eff.added : [], affected: aff, groups: Object.fromEntries(Array.from(plan.groups.entries())), plannedIds, ranIds, outOfPlanIds, results, emptyPlan, exclusions: ctx.exclusions, ...(ignoredInputsEnd ? { ignoredInputsEnd } : {}), complete: true };
}
// 复验结束后各组日志里「实际有结果行的仍登记编号」（95 号 HIGH-2）：与第 ③ 步 scopeKeys 同口径——@@MUT 记录里本组的编号，且在当前登记里（registered[g] = 当前登记里本组的条目）；按日志顺序去重。
function ranIdsFromLogs(rawDir, groups, registered) {
  const out = {};
  for (const g of groups) {
    const t = readGroupText(rawDir, g).text;
    const reg = new Set((registered[g] || []).map((r) => r.id));
    const seen = new Set();
    const ids = [];
    for (const r of parseRaw(t).records) { if (r.group !== g || !reg.has(r.id) || seen.has(r.id)) continue; seen.add(r.id); ids.push(r.id); }
    out[g] = ids;
  }
  return out;
}
// 每组 meta 与空计划记录共用的「运行上下文」核对（89 号 MEDIUM）：被忽略的运行输入摘要（.sdh-instance sha256、线库 sha256、.env 白名单键存在性）与当前一致；排除项记录与各组一致；人工声明（读取器漂移）一致。
//   rec = meta 或 empty-plan.json 的内容；now = { ignored: ignoredInputsState(repo), attestNow: 本次 --s-registry-attest | null, drift: 本次改动集是否命中读取器链路 }（缺省 = 不核该项，单元自检用）。
function runInputsProblems(rec0, now, prefix) {
  const out = [];
  if (!now) return out;
  if (now.ignored !== undefined) {
    if (!rec0.ignoredInputs) out.push(`${prefix}没有记被忽略的运行输入摘要（ignoredInputs；旧格式记录）：无法确认复验之后 .sdh-instance / 线库 / .env 没变，须重跑第 ②③ 步`);
    else {
      const a = rec0.ignoredInputs;
      const b = now.ignored;
      if (JSON.stringify(a.sdhInstance) !== JSON.stringify(b.sdhInstance)) out.push(`${prefix}.sdh-instance 的内容摘要与第 ② 步记录不一致（记 ${JSON.stringify(a.sdhInstance)}，现在 ${JSON.stringify(b.sdhInstance)}）：复验之后实例身份文件变了`);
      if (JSON.stringify(a.taskPoolDb) !== JSON.stringify(b.taskPoolDb)) out.push(`${prefix}线库 task_pool.db 的 sha256 / 字节数与第 ② 步记录不一致（记 ${JSON.stringify(a.taskPoolDb)}，现在 ${JSON.stringify(b.taskPoolDb)}）：复验之后线库变了`);
      if (JSON.stringify(a.envKeys) !== JSON.stringify(b.envKeys)) out.push(`${prefix}.env 白名单键的存在性与第 ② 步记录不一致（只比键名与存在与否，不比值）：复验之后线配置变了`);
    }
  }
  // 96 号 HIGH-3：<S> 时登记的编号摘要三步同一份（第 ② 步记进 meta / empty-plan.json / rerun.json，第 ③ 步现算后比）
  if (now.sRegistry) {
    if (!rec0.sRegistry || typeof rec0.sRegistry.sha256 !== 'string') out.push(`${prefix}没有记 <S> 时登记的编号摘要（sRegistry；旧格式记录）：无法确认第 ②③ 步读到的是同一份 <S> 时登记，须重跑第 ②③ 步`);
    else if (rec0.sRegistry.sha256 !== now.sRegistry.sha256) out.push(`${prefix}<S> 时登记的编号摘要与第 ② 步记录不一致（记 ${rec0.sRegistry.sha256.slice(0, 16)}…（${rec0.sRegistry.count} 条；${rec0.sRegistry.source}），现在 ${now.sRegistry.sha256.slice(0, 16)}…（${now.sRegistry.count} 条；${now.sRegistry.source}））：三步必须核同一份`);
  }
  if (now.drift) {
    if (now.attestNow === null || now.attestNow === undefined) out.push(`${prefix}改动集含登记读取链路文件，第 ③ 步没有给 --s-registry-attest`);
    else if (rec0.sRegistryAttest !== now.attestNow) out.push(`${prefix}第 ③ 步的 --s-registry-attest ${JSON.stringify(now.attestNow)} 与第 ② 步记录的 ${JSON.stringify(rec0.sRegistryAttest === undefined ? null : rec0.sRegistryAttest)} 不一致（人工声明三步必须同一份）`);
  }
  return out;
}
//   excl：复验之后才允许生成 / 补写的产物排除名单（exclusionsOf）；记录一侧与当前一侧都剔除后再比，避免去向表登记 json 这类后补产物让合法的空计划被拒。
//   curSnap：当前改动集的内容指纹（changeSnapshot；缺省时按 curChanged 现算）；now：runInputsProblems 的 now。空计划与非空计划共用 compareChangeSnapshot（89 号 MEDIUM-1）。
function emptyPlanProblems({ repo, rawDir, since, plan, effCtx, curChanged, excl, curSnap, now }) {
  let d = null;
  try { d = JSON.parse(fs.readFileSync(path.join(rawDir, 'empty-plan.json'), 'utf8')); } catch (e) { return ['empty-plan.json 读不到或不是 JSON：' + e.message]; }
  const problems = [];
  const P = (s) => problems.push('空计划记录：' + s);
  if (!d || d.format !== EMPTY_PLAN_FORMAT) { P('format 不是 ' + EMPTY_PLAN_FORMAT); return problems; }
  const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
  if (d.startHead !== head) P(`记的 HEAD ${d.startHead} 不是当前 HEAD ${head}：记录之后又提交过`);
  if (d.changedSince !== since) P(`记的 --changed-since ${d.changedSince} 与本次 ${since} 不同`);
  if (!d.changedFiles || typeof d.changedFiles !== 'object' || d.changedFilesSha256 !== changedShaOf(d.changedFiles)) P('改动文件集合与它自己记的 sha256 对不上（记录被改过）');
  else {
    const snap = curSnap || changeSnapshot(repo, Array.from(curChanged).filter((x) => !isExcludedBy(excl, x)));
    const cmpE = compareChangeSnapshot({ recordedFiles: mapOfRecord(d.changedFiles), recordedStage: mapOfRecord(d.changedStage), current: snap, excl });
    for (const m of changeSnapshotMessages(cmpE, '空计划记录：')) problems.push(m);
  }
  for (const m of runInputsProblems(d, now, '空计划记录：')) problems.push(m);
  const e = d.effective;
  if (effCtx.mode === 'none') { if (!e || e.mode !== 'none' || e.reason !== effCtx.reason) P(`生效清单口径与本次不同（记 ${JSON.stringify(e || null)}，本次 --effective-none ${JSON.stringify(effCtx.reason)}）`); } else if (!e || e.mode !== 'file' || e.sha256 !== effCtx.sha256 || e.commit !== effCtx.eff.commit) P(`生效清单 sha256 / commit 与本次不一致（记 ${JSON.stringify(e || null)}，本次 sha256 ${effCtx.sha256}）：记录之后换过生效清单`);
  const ct = (gitOut(repo, ['log', '-1', '--format=%ct', since + '..HEAD']) || '').trim();
  const started = Date.parse(d.startedAt);
  // 84 号 LOW-1：起始时刻始终要能解析；有提交时间参照时（<S>..HEAD 里有提交）再比下限——<S> 就是 HEAD、工作区有改动时没有参照，不能因此跳过可解析性校验
  if (!Number.isFinite(started)) P(`起始时刻 ${JSON.stringify(d.startedAt)} 不是可解析的时间`);
  else if (ct && started < Number(ct) * 1000) P(`起始时刻 ${d.startedAt} 早于 ${since}..HEAD 最晚提交时间：这是改动提交之前的旧记录`);
  if (plan.groups.size !== 0) P('按当前 HEAD / 改动集 / 生效清单重算，复验集合不是空的（' + Array.from(plan.groups.entries()).map(([g, s]) => g + ' ' + s.runIds.length + ' 个').join('、') + '）：该有的复验日志没有');
  return problems;
}
// 装载异常 / 脚本级失败：不能当「变异后命中」的证据。只看驱动记录的结构化字段，不套 message / label 的文字正则——
//   预筛实测：旧的 /夹具|加载失败|Cannot find module|fixture/ 正则会把已提交基线里 static 的「schema 加载失败」业务守卫和 api 带「夹具：」前缀的业务断言（共 21 条变异）判成不合格，C2 会被卡死。
//   结构化口径：errorClass 为空（运行器 / 子进程自己抛的、父进程判不了类别）或 SyntaxError（被测脚本装载失败）、case 为空（没有用例名）→ 不算命中证据；
//   GuardFail（static / deploy 的守卫类失败）不套任何 message 规则，只看 case 非空。唯一的 message 锚定规则：errorClass 不是 GuardFail 且 message 以「Cannot find module」开头或含 MODULE_NOT_FOUND（Node 模块装载失败）→ 装载异常。驱动本身不区分「搭数据失败」与「目标断言失败」（记录里没有这个字段），
//   所以「夹具：」前缀的失败工具层不当失败，是否真是搭数据阶段失败由逐用例人工核（P-TEST 口径），不在工具里一刀切。
function isLoadOrFixtureFailure(f) {
  if (f.errorClass === undefined || f.errorClass === null || f.errorClass === '' || f.errorClass === 'SyntaxError') return true;
  if (f.case === undefined || f.case === null || f.case === '') return true;
  return isLoadException(f);
}
// 结构化的「装载异常」（89 号 MEDIUM：判红的编号同时记了目标断言失败与装载异常 → 单列拒绝，见 mixedLoadExceptionProblem）：errorClass 是 SyntaxError（被测脚本装载失败），
//   或 errorClass 不是 GuardFail 且 message 以「Cannot find module」开头 / 含 MODULE_NOT_FOUND（Node 的模块装载失败；只认这两个锚定写法，不套宽泛的文字正则）。
//   errorClass 为空的失败（运行器 / 子进程自己抛的，如 Playwright 超时）不算装载异常：已提交基线里有 1 条（readonly「明确只读配置被忽略」）同时有目标断言失败与这类超时记录，按装载异常拒会误伤真实基线。
function isLoadException(f) {
  if (f.errorClass === 'SyntaxError') return true;
  const msg = String(f.message === undefined || f.message === null ? '' : f.message);
  return f.errorClass !== 'GuardFail' && f.errorClass !== undefined && f.errorClass !== null && f.errorClass !== '' && (msg.startsWith('Cannot find module') || msg.includes('MODULE_NOT_FOUND'));
}
// 同一编号既有合格命中（可作证据的失败）、又有装载异常：拒绝（89 号 MEDIUM；单列检查，不能因为目标证据有效就放过：装载异常说明被测脚本曾装载失败，判红可能来自装载副作用，命中证据不可全信）。无则返回 null。
function mixedLoadExceptionProblem(c, tag) {
  if (!c || c.verdict !== rec.VERDICT.RED) return null;
  const fs_ = c.failures || [];
  const load = fs_.filter(isLoadException);
  if (load.length === 0 || fs_.every(isLoadOrFixtureFailure)) return null; // 全是装载类的由「没有可作命中证据的失败」报，不重复
  return `${tag}：同一编号既有可作命中证据的失败、又记了装载异常（${load.slice(0, 2).map((f) => `${f.errorClass || '(无类)'}：${String(f.message || '').split(/\r?\n/)[0].slice(0, 50)}`).join('；')}${load.length > 2 ? ' …共 ' + load.length + ' 条' : ''}）：拒绝（被测脚本曾装载失败，命中证据不可全信；须先修好装载问题再复验）`;
}
// 失败的位置键（M2）：用例体调用点 `caseSiteText#ord`（caseSite 非空且不是抛出行本身时）与抛出行 `siteText#ord`；没有位置（守卫类、读不到源码行）的失败返回空数组。
function locationKeysOf(f) {
  const k = [];
  if (f.caseSite && f.caseSite !== f.site && f.caseSiteText !== undefined && f.caseSiteText !== null && f.caseSiteOrd !== undefined && f.caseSiteOrd !== null) k.push(`${f.caseSiteText}#${f.caseSiteOrd}`);
  if (f.site && f.siteText !== undefined && f.siteText !== null && f.siteOrd !== undefined && f.siteOrd !== null) k.push(`${f.siteText}#${f.siteOrd}`);
  return k;
}
// 登记里写的命中证据（文本）是否对得上这条失败：含失败用例名，含失败信息首行前 60 个字（原文或归一后任一；信息为空时只核用例名），
//   并含该失败的位置键 `caseSiteText#ord` 或 `siteText#ord` 之一（失败有位置时；M2）。
//   证据核对只证明「这条失败存在、指出了哪一步」，不证明它是业务断言——业务步骤由人核对，不由本工具判。
function evidenceMatches(text, f, group) {
  const t = String(text);
  if (!t.includes(String(f.case))) return false;
  const lk = locationKeysOf(f);
  if (lk.length && !lk.some((k) => t.includes(k))) return false;
  const msg = String(f.message === undefined || f.message === null ? '' : f.message).trim();
  if (!msg) return true;
  const p1 = msg.slice(0, 60);
  const p2 = normalizeMessage(msg, { group, ref: null }).slice(0, 60);
  return t.includes(p1) || t.includes(p2);
}
// 生效清单里必须复验的编号（mustRun / by / remount 新编号 / added）中，基线里属于「需人工复核」的条目（84 号 HIGH-1）：它们是靠清单、不是靠自动范围进的复验集合，
//   若不另外并进三字段登记目标，同键含糊的失败可以在没有业务步骤、未变异通过与变异后命中证据的情况下过闸门。基线里没有的编号（新增变异）不在这里——它们本来就是「现在有基线没有」，照旧要登记。
//   required：effList.validateEffective 的 eff.required；baseEntries / cur：基线与当次运行的 entries。返回 [{ group, id, source, reasons }]（同一编号只列一次，来源取第一个）。
function requiredReviewTargets(required, baseEntries, cur) {
  const bm = new Map((baseEntries || []).map((e) => [keyOf(e), e]));
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  const out = [];
  const seen = new Set();
  for (const r of required || []) {
    const k = keyOf(r);
    if (seen.has(k)) continue;
    const b = bm.get(k);
    if (!b) continue;
    const c = cm.get(k);
    const reasons = Array.from(new Set([...reviewReasons(b.failures, b.group), ...reviewReasons(c ? c.failures : [], b.group)])).filter((x) => x !== 'guardNoStack').sort();
    if (reasons.length) { seen.add(k); out.push({ group: r.group, id: r.id, source: r.source, reasons }); }
  }
  return out;
}
// 闸门判定。affected：affectedOf 的结果；cmp：compareBaselines 的结果；cur：当前 entries；dispositions：去向表登记；extraReview：requiredReviewTargets 的结果（生效清单必跑编号里需人工复核的）。返回 { targets, problems }。
//   95 号 MEDIUM（编号复用）：thisNew = 本提交新增的编号（added ∪ remount 新编号）的 group\0id 集合、commit = 本次清单的提交名——这些编号只接受「提交」= 本次的三字段行（退役后重新登记的同名编号，
//   旧一代的行恰好对得上同样的用例名 / 信息 / 位置键时不能被沿用）；其余编号沿用历史行，但以「最近一次退役」为边界：累计去向表按提交顺序逐提交追加，该编号最后一条退役行（带「处置类别」）在表里的位置之前的行属于旧一代，不接受。
function reviewGate({ affected, cmp, cur, dispositions, extraReview, thisNew, commit }) {
  const problems = [];
  // 累计去向表里同一编号可有多行（旧提交的、本次的）：三字段登记可以引用任何提交的行，命中证据必须与当次失败对得上——任一行齐全且对得上即过；都不过时报最后一行（最新的）的问题
  const dm = new Map();
  const lastRetireAt = new Map(); // 编号 → 该编号最后一条退役行在表里的下标
  (dispositions || []).forEach((d, i) => { const k0 = keyOf(d); if (!dm.has(k0)) dm.set(k0, []); dm.get(k0).push({ d, i }); if (d['处置类别'] !== undefined) lastRetireAt.set(k0, i); });
  const rowsOf = (k0) => {
    const all = dm.get(k0) || [];
    if (thisNew && thisNew.has(k0)) return { rows: all.filter((x) => x.d['提交'] === commit).map((x) => x.d), note: `本提交（${JSON.stringify(commit)}）新增 / 改挂的编号只接受「提交」= ${JSON.stringify(commit)} 的行（别的提交的行 ${all.filter((x) => x.d['提交'] !== commit).length} 行不算）` };
    const cut = lastRetireAt.has(k0) ? lastRetireAt.get(k0) : -1;
    return { rows: all.filter((x) => x.i > cut).map((x) => x.d), note: cut >= 0 ? `该编号在累计去向表第 ${cut + 1} 行有退役记录，其前的行属于旧一代、不算（${all.filter((x) => x.i <= cut).length} 行）` : '' };
  };
  const cm = new Map((cur || []).map((e) => [keyOf(e), e]));
  const targets = new Map();
  for (const a of affected) if (a.needReview) targets.set(keyOf(a), { group: a.group, id: a.id, why: '受影响（' + viaText(a) + '）', checkEvidence: true });
  for (const x of extraReview || []) if (!targets.has(keyOf(x))) targets.set(keyOf(x), { group: x.group, id: x.id, why: '生效清单 ' + x.source + '，需人工复核：' + x.reasons.map((r) => REVIEW_KINDS[r]).join('、'), checkEvidence: true });
  for (const x of cmp.changed) if (x.kind !== '基线有现在没有') { if (!targets.has(keyOf(x))) targets.set(keyOf(x), { group: x.group, id: x.id, why: '变了（' + x.kind + '）', checkEvidence: true }); }
  for (const [k, t] of targets) {
    const rr = rowsOf(k);
    const rows = rr.rows;
    const tag = `[${t.group}] ${JSON.stringify(t.id)}（${t.why}）`;
    if (!rows || !rows.length) { problems.push(tag + '：去向表里没有登记' + (rr.note ? '（' + rr.note + '）' : '')); continue; }
    const c = cm.get(k);
    const valid = c && c.verdict === rec.VERDICT.RED ? (c.failures || []).filter((f) => !isLoadOrFixtureFailure(f)) : [];
    // 逐行核对（三字段齐全；t.checkEvidence 时命中证据对得上当次失败）；返回该行的问题数组
    const rowProblems = (d) => {
      const out = [];
      const missing = GATE_FIELDS.filter((f) => typeof d[f] !== 'string' || d[f].trim() === '');
      if (missing.length) out.push('登记缺字段 ' + missing.join(' / '));
      if (!c || !t.checkEvidence || typeof d['变异后命中证据'] !== 'string' || d['变异后命中证据'].trim() === '') return out;
      if (valid.length === 0) { out.push('当前运行里没有可作命中证据的失败（判定 ' + c.verdict + '；失败都是装载异常 / 夹具失败或没有失败）'); return out; }
      if (!valid.some((f) => evidenceMatches(d['变异后命中证据'], f, t.group))) out.push('变异后命中证据对不上当前运行里的失败（应含失败用例名、信息首行前 60 字与位置键 caseSiteText#ord 或 siteText#ord，例如 ' + JSON.stringify(valid[0].case) + ' / ' + JSON.stringify(String(valid[0].message || '').slice(0, 60)) + ' / ' + JSON.stringify(locationKeysOf(valid[0])) + '；累计去向表里失败再次变化的条目须补新行，旧行证据对不上就拒）');
      return out;
    };
    const per = rows.map(rowProblems);
    if (per.some((p) => p.length === 0)) continue; // 有一行齐全且对得上 → 过（前序提交登记过、本次失败没再变化的条目沿用旧行）
    for (const m of per[per.length - 1]) problems.push(tag + '：' + m);
  }
  return { targets: Array.from(targets.values()), problems };
}
// 受影响条目 → 实际复验的命令（api 过滤模式按编号只跑受影响的；其余各组驱动没有按编号只跑的参数，只能按组全跑）。写 <outDir>/<组>.ids.json（api）与 affected.json。
function affectedCommands(affected, outDir, repo) {
  const byGroup = new Map();
  for (const a of affected) { if (!byGroup.has(a.group)) byGroup.set(a.group, []); byGroup.get(a.group).push(a.id); }
  const lines = [];
  if (outDir) { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'affected.json'), JSON.stringify(affected, null, 2) + '\n'); }
  for (const g of ALL_GROUPS) {
    if (!byGroup.has(g)) continue;
    const ids = byGroup.get(g);
    const rel = (a) => (path.isAbsolute(a) ? path.relative(repo, a).replace(/\\/g, '/') : a);
    if (g === 'api') {
      const f = outDir ? path.join(outDir, 'api.ids.json') : '<api.ids.json>';
      if (outDir) fs.writeFileSync(f, JSON.stringify(ids, null, 2) + '\n');
      lines.push(`  [api] ${ids.length} 条：node wbs-server/scripts/verify-sysbuild-api.js --self-test --mutation-ids ${f}   （过滤模式，只跑这些变异；与基线同口径）`);
    } else {
      lines.push(`  [${g}] ${ids.length} 条：驱动没有按编号只跑的参数，只能按组全跑：${['node', ...commandOf(g, repo).map(rel)].join(' ')}`);
    }
  }
  return lines;
}

// ── 运行 ───────────────────────────────────────────────────────────────────────────────
function loadRegistered(repo, groups, registryFile) {
  const out = {};
  for (const g of groups) out[g] = [];
  if (registryFile) {
    for (const x of JSON.parse(fs.readFileSync(registryFile, 'utf8'))) if (out[x.group]) out[x.group].push(x);
    return out;
  }
  const mc = require('./mutation-check');
  const rr = mc.run(repo, groups);
  if (rr.loadErrors.length) throw new Error('mutation-check 读取登记失败：' + rr.loadErrors.map((e) => e.group + ' ' + e.error).join('；'));
  for (const x of mc.toIdList(rr.entries)) out[x.group].push(x);
  return out;
}
// 一次运行的上下文（H1）：起始 HEAD、工作区状态（不含 tmp/）、给了 since 时「<since>..HEAD + 工作区」改动集里每个文件当前的 sha256（文件不在 = null）。
//   写进每组 <组>.meta.json；闸门（--require-review-dispositions）逐组核对它，防止拿旧日志 + 机械登记过关。
const sha256OrNull = (repo, rel) => { try { const f = path.join(repo, ...rel.split('/')); return fs.statSync(f).isFile() ? sha256File(f) : null; } catch (_) { return null; } };
const notTmpPath = (p) => !(p === 'tmp' || p.startsWith('tmp/'));
//   89 / 94 号补充（给了 since 时）：changedStage（改动集里每个路径的工作区 / 暂存区 blob 号）、exclusions（第 ② 步记录的排除项）、ignoredInputs（.sdh-instance 内容摘要、线库 sha256、.env 白名单键存在性）、
//   sRegistryAttest（读取器漂移的人工声明）；工作区状态改用 git status --porcelain=v1 -z（改名 / 复制两端都纳入，路径不经文本行解析）。opts = { attest }。
function runContext(repo, since, excl, opts) {
  const head = gitOut(repo, ['rev-parse', 'HEAD']);
  let wt = null;
  try { wt = effList.statusEntriesZ(repo).filter((e) => notTmpPath(normPath(e.path)) && (e.orig === null || notTmpPath(normPath(e.orig)))).map((e) => e.xy + ' ' + normPath(e.path) + (e.orig === null ? '' : ' <- ' + normPath(e.orig))); } catch (_) { wt = null; }
  const ctx = { startHead: head === null ? null : head.trim(), workingTree: wt, changedSince: since || null, changedFiles: null };
  if (since) {
    const snap = changeSnapshot(repo, changedFilesSince(repo, since, excl));
    ctx.changedFiles = snapshotFilesOf(snap);
    ctx.changedStage = snapshotStageOf(snap);
    ctx.exclusions = normExcl(excl || { files: [], dirs: [] });
    ctx.ignoredInputs = ignoredInputsState(repo);
    ctx.sRegistryAttest = opts && opts.attest ? String(opts.attest).trim() : null;
    ctx.sRegistry = opts && opts.sRegistry ? opts.sRegistry : null; // <S> 时登记的编号摘要（96 号 HIGH-3）
  }
  return ctx;
}
// 闸门核对一次复验日志的 meta（H1）。metas：{ <组>: meta | null }；curChanged：当前的改动集（Set，已剔除 excl）；baseEntries：基线 entries。返回问题清单。
//   每组须：有 meta 且带 startHead / changedSince / changedFiles；startHead = 当前 HEAD；changedSince = 本次 --changed-since；meta 记的每个改动文件当前 sha256 与之相同；
//   84 号 HIGH-2：核对的是复验所用的「完整改动路径集合与内容哈希」，不只自动范围相关的路径——第 ② 步之后改动集里新出现的任何路径（例如只被 mustRun 依赖的共用文件，自动范围看不到它）、
//   meta 里记过的路径内容变了 / 又消失，一律不通过，复验记录对它不作数、重跑第 ②③ 步。复验之后才允许生成 / 补写的产物（--raw-dir、--dispositions、--report）按 excl 排除（exclusionsOf）。
//   起始时刻不早于 <S>..HEAD 最晚提交时间。sKeys = <S> 时登记（rerunPlan 的 added 以它为准）。
//   MED-1：meta 还要与日志、与组绑定——meta.group = 本组、meta.rerun = true、meta.argv 的脚本与参数等于 commandOf(本组)、meta.log 的文件名 / 字节数 / sha256 与当前日志一致；
//   api 组另核 api.ids.json 的 sha256 与 meta.idsFile 一致、内容与按 S 现算的受影响 api 编号全等（防止真 meta 配上别的日志、全组旧日志冒充子集复验、meta 复制给另一组）。
//   R1：effCtx（{ mode: 'file' | 'none', … }，buildEffCtx 的 ctx；校验没过 / 单元自检里不给 = null，不核生效清单）给了就再核：每组 meta.effective 的模式与 sha256（file）/ 理由（none）与本次一致（防换清单、防换口径），
//   file 模式下 meta 记的复验集合（按来源列出的并集）等于按本次生效清单与改动集现算的；api.ids.json 的内容 = 现算的复验集合（自动范围 ∪ 生效清单的 api 编号）。
function rerunMetaProblems({ repo, rawDir, since, metas, curChanged, baseEntries, effCtx, currentKeys, sKeys, excl, currentEntries, curSnap, now }) {
  const problems = [];
  const plan = rerunPlan(baseEntries, curChanged, effCtx && effCtx.mode === 'file' ? effCtx.eff : null, currentKeys || null, sKeys || null, currentEntries || null);
  const snap = curSnap || changeSnapshot(repo, Array.from(curChanged).filter((f) => !isExcludedBy(excl, f))); // 当前改动集的内容指纹（工作区 + 暂存区）；闸门主流程现算一次传进来
  const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
  const ct = (gitOut(repo, ['log', '-1', '--format=%ct', since + '..HEAD']) || '').trim();
  for (const g of Object.keys(metas)) {
    const m = metas[g];
    if (!m) { problems.push(`[${g}] 没有 ${g}.meta.json：看不出这份日志是不是这次改动之后复验出来的（旧日志不能过闸门）；复验要用 --rerun 由本工具跑`); continue; }
    if (!/^[0-9a-f]{40}$/.test(String(m.startHead)) || typeof m.changedSince !== 'string' || !m.changedFiles || typeof m.changedFiles !== 'object') { problems.push(`[${g}] ${g}.meta.json 没有 startHead / changedSince / changedFiles（旧格式或不是 --rerun 跑的）`); continue; }
    if (m.group !== g) problems.push(`[${g}] meta.group 是 ${JSON.stringify(m.group)}，不是 ${g}：这份 meta 不是这一组的`);
    if (m.rerun !== true) problems.push(`[${g}] meta.rerun 不是 true：不是由本工具（--rerun）写出的`);
    {
      const rel = (a) => (path.isAbsolute(a) ? path.relative(repo, a).replace(/\\/g, '/') : a);
      const want = commandOf(g, repo).map(rel);
      const argv = Array.isArray(m.argv) ? m.argv : [];
      const prefixOk = want.every((x, i) => argv[i] === x);
      const tailOk = g === 'api' ? (argv.length === want.length || (argv.length === want.length + 2 && argv[want.length] === '--mutation-ids')) : argv.length === want.length;
      if (!prefixOk || !tailOk) problems.push(`[${g}] meta.argv ${JSON.stringify(argv)} 不是本组的驱动命令 ${JSON.stringify(want)}${g === 'api' ? '（可加 --mutation-ids <文件>）' : ''}`);
      const lf = path.join(rawDir, g + '.log');
      let lb = null;
      try { lb = fs.readFileSync(lf); } catch (_) { /* 下面报 */ }
      if (lb === null) problems.push(`[${g}] 日志 ${g}.log 读不到`);
      else if (!m.log || m.log.file !== g + '.log' || m.log.bytes !== lb.length || m.log.sha256 !== sha256Of(lb)) problems.push(`[${g}] ${g}.log 与 meta 记的日志（文件名 / 字节数 / sha256）对不上：日志在 meta 写出之后被换过，或 meta 配错了日志`);
      if (g === 'api') {
        const ip = path.join(rawDir, 'api.ids.json');
        let ids = null;
        let idsSha = null;
        try { const b = fs.readFileSync(ip); idsSha = sha256Of(b); ids = JSON.parse(b.toString('utf8')); } catch (_) { /* 全组跑没有 ids 文件 */ }
        const wantIds = plan.groups.has('api') ? plan.groups.get('api').runIds : [];
        if (argv.includes('--mutation-ids')) {
          if (!m.idsFile || ids === null || m.idsFile.sha256 !== idsSha) problems.push('[api] api.ids.json 缺失，或与 meta.idsFile 的 sha256 不一致');
          else if (JSON.stringify(ids) !== JSON.stringify(wantIds)) problems.push(`[api] api.ids.json（${ids.length} 个编号）与按 ${since} 现算的复验集合（自动范围${effCtx && effCtx.mode === 'file' ? ' ∪ 生效清单' : ''}，${wantIds.length} 个）不全等：复验的不是这次该复验的那批`);
        }
      }
    }
    if (effCtx) {
      const e = m.effective;
      if (effCtx.mode === 'none') {
        if (!e || e.mode !== 'none' || e.reason !== effCtx.reason) problems.push(`[${g}] meta.effective 不是 --effective-none 或理由与本次不同（meta 记 ${JSON.stringify(e || null)}，本次理由 ${JSON.stringify(effCtx.reason)}）：复验与对比必须用同一种生效清单口径`);
      } else if (!e || e.mode !== 'file') problems.push(`[${g}] meta.effective 缺失或不是生效清单模式（meta 记 ${JSON.stringify(e || null)}）：复验时没有给 --effective`);
      else {
        if (e.sha256 !== effCtx.sha256) problems.push(`[${g}] 生效清单 sha256 ${effCtx.sha256} 与 meta 记的 ${e.sha256} 不一致：复验之后换过生效清单（或复验用的不是这一份）`);
        if (e.commit !== effCtx.eff.commit) problems.push(`[${g}] 生效清单的 commit ${JSON.stringify(effCtx.eff.commit)} 与 meta 记的 ${JSON.stringify(e.commit)} 不一致`);
        if (plan.groups.has(g)) {
          const want = plan.groups.get(g);
          if (JSON.stringify({ sources: e.sources, runIds: e.runIds }) !== JSON.stringify({ sources: effSourcesOf(want), runIds: want.runIds })) problems.push(`[${g}] meta 记的复验集合（按来源 + 并集）与按本次生效清单和改动集现算的不全等：复验的不是这次该复验的那批`);
        }
      }
    }
    if (m.startHead !== head) problems.push(`[${g}] 复验起始 HEAD ${m.startHead} 不是当前 HEAD ${head}：复验之后又提交过`);
    if (m.changedSince !== since) problems.push(`[${g}] 复验时的 --changed-since ${m.changedSince} 与本次 ${since} 不同`);
    // 84 号 HIGH-2：完整改动路径集合 + 内容哈希，不只自动范围相关的路径（排除名单 excl 内的后补产物除外）。
    //   89 号 HIGH-2 / MEDIUM-1：路径集合双向比（新出现 / 消失 / 内容变了）与暂存区指纹（暂存区 = 工作区 = 第 ② 步复验的内容）走 compareChangeSnapshot，与空计划共用；路径映射用 Map
    const cmpM = compareChangeSnapshot({ recordedFiles: mapOfRecord(m.changedFiles), recordedStage: mapOfRecord(m.changedStage), current: snap, excl });
    const freshNote = (fresh) => {
      const freshAffecting = affectedOf(plan.live, null, new Set(fresh)).filter((x) => x.group === g);
      return freshAffecting.length ? `；其中会影响该组 ${freshAffecting.length} 条的有：${Array.from(new Set(freshAffecting.flatMap((x) => [...x.hitFiles, ...x.testSideFiles, ...(x.productFiles || []), ...(x.fallbackFiles || [])]))).join('、')}` : '（按自动范围看不出影响哪一条：只被 mustRun / by 依赖的共用文件也算）';
    };
    for (const msg of changeSnapshotMessages(cmpM, `[${g}] `, freshNote)) problems.push(msg);
    // 89 / 94 号：排除项记录各组一致；被忽略的运行输入摘要与当前一致（子集复验也绑定）；读取器漂移的人工声明三步一致
    if (now && !m.exclusions) problems.push(`[${g}] ${g}.meta.json 没有 exclusions（第 ② 步记录的排除项；旧格式记录）`);
    else if (now) for (const msg of exclusionsSubsetProblems(excl || { files: [], dirs: [] }, m.exclusions)) problems.push(`[${g}] ${msg}`);
    for (const msg of runInputsProblems(m, now, `[${g}] `)) problems.push(msg);
    const started = Date.parse(m.startedAt);
    // 84 号 LOW-1：起始时刻始终要能解析；有提交时间参照时再比下限
    if (!Number.isFinite(started)) problems.push(`[${g}] 复验起始时刻 ${JSON.stringify(m.startedAt)} 不是可解析的时间`);
    else if (ct && started < Number(ct) * 1000) problems.push(`[${g}] 复验起始时刻 ${m.startedAt} 早于 ${since}..HEAD 最晚提交时间 ${new Date(Number(ct) * 1000).toISOString()}：这是改动提交之前的旧日志`);
  }
  return problems;
}
// 第 ③ 步对非空复验的 rerun.json 结束记录的核对（95 号 MEDIUM）：必须可读、格式 sysbuild-rerun/3、complete = true、不是空计划、与本次运行匹配（changedSince / 起始 HEAD / 提交名或 none 理由 / 组集合），
//   带复验结束时的被忽略运行输入摘要 ignoredInputsEnd 且等于各组 meta 里复验开始时记的（复验期间运行输入变过 = 本次不可信），并且实跑编号 ranIds 与第 ③ 步从日志现算的一致。返回问题数组（前缀「rerun.json：」）。
//   data：{ 组: { meta, text } }；ranNow：{ 组: [编号] }（第 ③ 步从日志现算）。
function rerunJsonEndProblems({ rawDir, groups, data, since, head, effCtx, ranNow }) {
  const out = [];
  const P = (s) => out.push('rerun.json：' + s);
  let rj = null;
  try { rj = JSON.parse(fs.readFileSync(path.join(rawDir, 'rerun.json'), 'utf8')); } catch (e) { P('读不到或不是 JSON（' + e.message + '）：非空复验必须有第 ② 步写的结束记录，缺失 / 损坏时复验期间运行输入的变化没有依据，拒；须重跑第 ②③ 步'); return out; }
  if (!rj || rj.format !== RERUN_FORMAT) { P('format 不是 ' + RERUN_FORMAT + '（旧格式留档不收）'); return out; }
  if (rj.complete !== true) P('没有结束记录（complete 不是 true）：第 ② 步没有写完（中断？）');
  if (rj.emptyPlan !== false) P('emptyPlan 不是 false：这份记录说本次复验是空计划，目录里却有复验日志');
  if (rj.changedSince !== since) P(`记的 --changed-since ${rj.changedSince} 与本次 ${since} 不同`);
  if (!rj.context || rj.context.startHead !== head) P(`记的起始 HEAD ${rj.context && rj.context.startHead} 不是当前 HEAD ${head}`);
  const wantCommit = effCtx ? (effCtx.mode === 'file' ? effCtx.eff.commit : 'none:' + effCtx.reason.slice(0, 40)) : null;
  if (wantCommit !== null && rj.commit !== wantCommit) P(`记的提交名 ${JSON.stringify(rj.commit)} 与本次 ${JSON.stringify(wantCommit)} 不同`);
  // 预筛 LOW-2：记的生效清单（file：sha256 + commit；none：理由）必须与本次的一致
  if (effCtx) {
    const rje = rj.effective;
    if (effCtx.mode === 'file') { if (!rje || rje.mode !== 'file' || rje.sha256 !== effCtx.sha256 || rje.commit !== effCtx.eff.commit) P(`记的生效清单 ${JSON.stringify(rje || null)} 与本次（file，sha256 ${effCtx.sha256}，commit ${JSON.stringify(effCtx.eff.commit)}）不一致`); }
    else if (!rje || rje.mode !== 'none' || rje.reason !== effCtx.reason) P(`记的生效清单 ${JSON.stringify(rje || null)} 与本次（--effective-none ${JSON.stringify(effCtx.reason)}）不一致`);
  }
  const gk = rj.groups && typeof rj.groups === 'object' ? Object.keys(rj.groups).sort().join(',') : null;
  if (gk !== groups.slice().sort().join(',')) P(`记的复验组 ${JSON.stringify(gk)} 与目录里有日志的组 ${JSON.stringify(groups.slice().sort().join(','))} 不同`);
  if (!rj.ignoredInputsEnd) P('没有 ignoredInputsEnd（复验结束时再取的 .sdh-instance / 线库 / .env 键摘要）：无法确认复验期间运行输入没变');
  else for (const g of groups) { const m = data[g] && data[g].meta; if (m && m.ignoredInputs && JSON.stringify(m.ignoredInputs) !== JSON.stringify(rj.ignoredInputsEnd)) { P('记的复验结束时被忽略的运行输入摘要（ignoredInputsEnd）与复验开始时（meta）不一致：复验期间 .sdh-instance / 线库 / .env 键变过，这次复验不可信，须重跑第 ②③ 步'); break; } }
  // 97 号 MEDIUM：结构校验与 C9 共用（rerunStructureProblems）——组值类型不合法时统一报问题，不再在下面的 slice().sort() 上抛异常
  const sp = rerunStructureProblems(rj);
  if (sp.length) { for (const s of sp) P('结构不合法（plannedIds / ranIds / outOfPlanIds / results 的组键须与计划组一致，编号列表须是去重后的字符串数组）：' + s); }
  else for (const g of groups) { const a = JSON.stringify((rj.ranIds[g] || []).slice().sort()); const b = JSON.stringify((ranNow[g] || []).slice().sort()); if (a !== b) P(`[${g}] 记的实跑编号 ${(rj.ranIds[g] || []).length} 个与第 ③ 步从日志现算的 ${(ranNow[g] || []).length} 个不一致（日志被换过？）`); }
  return out;
}
function runGroup(group, repo, rawDir, extra) {
  return new Promise((resolve) => {
    const [script, ...rest0] = commandOf(group, repo);
    const rest = [...rest0, ...((extra && extra.args) || [])];
    const logFile = path.join(rawDir, group + '.log');
    const fd = fs.openSync(logFile, 'w');
    const startedAt = new Date();
    // NODE_OPTIONS 追加 --stack-trace-limit：默认栈深 10 会把外层帧截掉，caseSite 取不到；驱动的子进程（api 子进程、迁移 / 存档 / 只读的测试子进程、浏览器驱动拉起的 node）都继承它。
    const nodeOptions = [process.env.NODE_OPTIONS, STACK_LIMIT_OPTION].filter(Boolean).join(' ');
    const child = spawn(process.execPath, [script, ...rest], { cwd: repo, env: { ...process.env, SYSBUILD_MUT_RECORD: '1', NODE_OPTIONS: nodeOptions }, stdio: ['ignore', fd, fd], windowsHide: true });
    const done = (code, signal, error) => {
      try { fs.closeSync(fd); } catch (_) { /* 已关 */ }
      const endedAt = new Date();
      const relArg = (a) => (path.isAbsolute(a) ? path.relative(repo, a).replace(/\\/g, '/') : a);
      const meta = { command: ['node', path.relative(repo, script).replace(/\\/g, '/'), ...rest.map(relArg)].join(' '), argv: [path.relative(repo, script).replace(/\\/g, '/'), ...rest.map(relArg)], env: { SYSBUILD_MUT_RECORD: '1', NODE_OPTIONS: nodeOptions }, exitCode: code, signal: signal || null, error: error || null, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), seconds: Math.round((endedAt - startedAt) / 1000), ...((extra && extra.meta) || {}) };
      // MED-1：meta 与日志绑定——组名、「本工具跑的」标记、日志文件名 + sha256 + 字节数；api 子集复验另记 ids 文件的 sha256。闸门逐组核对，防止把 meta 配上别的日志 / 别的组
      meta.group = group;
      meta.rerun = true;
      try { const lb = fs.readFileSync(logFile); meta.log = { file: path.basename(logFile), sha256: sha256Of(lb), bytes: lb.length }; } catch (_) { meta.log = null; }
      if (extra && extra.idsFile) { try { meta.idsFile = { file: path.basename(extra.idsFile), sha256: sha256File(extra.idsFile) }; } catch (_) { meta.idsFile = null; } }
      fs.writeFileSync(path.join(rawDir, group + '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
      resolve(meta);
    };
    child.on('error', (e) => done(null, null, e.message));
    child.on('close', (code, signal) => done(code, signal, null));
  });
}
function readGroupText(rawDir, group) {
  const f = path.join(rawDir, group + '.log');
  const m = path.join(rawDir, group + '.meta.json');
  return {
    text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null,
    meta: fs.existsSync(m) ? JSON.parse(fs.readFileSync(m, 'utf8')) : null,
  };
}
function headCommit(repo) {
  const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
// 工作区有没有未提交的改动（git status --porcelain 非空）；git 不可用 / 不是仓库为 null
function workingTreeDirty(repo) {
  const r = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() !== '' : null;
}

// ── 来源清单（HIGH-2）──────────────────────────────────────────────────────────────────
const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha256File = (f) => sha256Of(fs.readFileSync(f));
function gitOut(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
const PRODUCT_STATUS_PATHS = ['wbs-server/routes', 'wbs-server/public', 'wbs-server/server.js'];
// 基线运行实际加载、但不在驱动 / 套件目录里的间接依赖（预筛 HIGH-2 逐条读 server.js:15-73、lib/test-env.js:70-73、lib/test-instance.js:69-76、lib/sysbuild-api-suite-notify.js:63 得出；wbs-server/utils/* 另按目录整体并入）。
const EXTRA_TEST_FILES = [
  'wbs-server/scripts/_test-fixture.js', 'wbs-server/scripts/lib/test-env.js', 'scripts/deploy-ssh.ps1',
  'wbs-server/scripts/lib/test-instance.js', 'wbs-server/scripts/lib/listen-safe-port.js',
  'scripts/lines/line-proc.js', 'scripts/lines/line-common.js', 'scripts/lines/line-new.js',
  'wbs-server/package.json', 'scripts/sysbuild-predeploy/temp-service/offline.html',
];
// 产品源码快照：HEAD^{tree}（整棵树）+ HEAD 里几处的树 / blob 对象号 + 产品目录的工作区状态（必须为空，否则不许生成基线：基线描述的是已提交的产品代码）。
function productTreeState(repo) {
  const rp = (spec) => { const o = gitOut(repo, ['rev-parse', spec]); return o === null ? null : o.trim(); };
  const st = gitOut(repo, ['status', '--porcelain', '--', ...PRODUCT_STATUS_PATHS]);
  const s = { head: rp('HEAD'), headTree: rp('HEAD^{tree}'), routesSysbuildTree: rp('HEAD:wbs-server/routes/sysbuild'), publicTree: rp('HEAD:wbs-server/public'), routesTree: rp('HEAD:wbs-server/routes'), serverJsBlob: rp('HEAD:wbs-server/server.js'), statusPaths: PRODUCT_STATUS_PATHS, statusPorcelain: st === null ? null : st.split(/\r?\n/).filter(Boolean) };
  s.clean = s.head !== null && s.headTree !== null && s.routesSysbuildTree !== null && s.publicTree !== null && st !== null && st.trim() === '';
  return s;
}
// 测试 / 驱动 / 守卫 / 迁移工具 / 被加载的间接依赖文件清单（仓库相对路径，排序）。
function listTestFiles(repo) {
  const out = [];
  const rd = (rel) => { try { return fs.readdirSync(path.join(repo, ...rel.split('/')), { withFileTypes: true }); } catch (_) { return []; } };
  const addDir = (rel, re) => { for (const e of rd(rel)) if (e.isFile() && re.test(e.name)) out.push(rel + '/' + e.name); };
  addDir('wbs-server/scripts', /^verify-sysbuild-.*\.js$/);
  addDir('wbs-server/scripts/lib', /^sysbuild-.*\.js$/);
  addDir('wbs-server/scripts/sysbuild-step1', /\.js$/);
  const walk = (rel) => { for (const e of rd(rel)) { if (e.isDirectory() && !e.isSymbolicLink() && e.name !== 'node_modules') walk(rel + '/' + e.name); else if (e.isFile() && /\.(?:js|cjs|txt|json)$/.test(e.name)) out.push(rel + '/' + e.name); } };
  walk('scripts/sysbuild-predeploy');
  walk('wbs-server/utils');
  for (const x of EXTRA_TEST_FILES) if (fs.existsSync(path.join(repo, ...x.split('/')))) out.push(x);
  return Array.from(new Set(out)).sort();
}
// git status --porcelain 的行 → 路径列表（改名 / 复制取两端；去掉 git 给特殊字符路径加的引号；统一正斜杠）。实现在 effective-list.js（第 ① 步的 --effective-none 适用范围核对共用）。
const porcelainPaths = effList.porcelainPaths;
// 工作区硬门：tmp/ 以外、且不在 testFiles 已记哈希集合里的脏路径 / 未跟踪路径（一律拒绝）。已记哈希的文件脏着没关系——它的哈希进了清单，运行前后还要比对。
function strayDirtyPaths(snap) {
  const hashed = new Set((snap.testFiles || []).map((x) => x.path));
  const out = [];
  for (const p of porcelainPaths(snap.workingTree)) {
    if (p === 'tmp' || p.startsWith('tmp/')) continue;
    if (hashed.has(p)) continue;
    out.push(p);
  }
  return Array.from(new Set(out)).sort();
}
// 被 git 忽略的运行输入（git status 与 testFiles 哈希都看不到）：.sdh-instance 的 sha256；task_pool.db 的 sha256 与字节数；.env 只记 LINE_ENV_WHITELIST 里各键是否存在
// （键名 + 存在与否；不记任何值、不记值的哈希，.env 的整体哈希也不记）。读不到 / 不存在记 exists:false。
const IGNORED_INPUTS = Object.freeze({ env: 'wbs-server/.env', instance: 'wbs-server/.sdh-instance', db: 'wbs-server/task_pool.db' });
function lineEnvWhitelistKeys() {
  const w = require(path.join(DEFAULT_REPO, 'scripts', 'lines', 'line-new.js')).LINE_ENV_WHITELIST;
  if (!Array.isArray(w) || w.length === 0) throw new Error('读不到 LINE_ENV_WHITELIST');
  return w.map((x) => x.key);
}
function ignoredInputsState(repo) {
  const abs = (rel) => path.join(repo, ...rel.split('/'));
  // 只有「文件不存在」记为 exists:false；其他读取错误（被锁、权限）抛出，由调用方拒绝生成——否则前后两次都读失败会被当成「一致」放行。
  const rd = (rel) => { try { return fs.readFileSync(abs(rel)); } catch (e) { if (e && e.code === 'ENOENT') return null; throw new Error(`读不到被忽略的运行输入 ${rel}：${e && e.code ? e.code : e}`); } };
  const inst = rd(IGNORED_INPUTS.instance);
  const db = rd(IGNORED_INPUTS.db);
  const env = rd(IGNORED_INPUTS.env);
  const keys = lineEnvWhitelistKeys();
  const present = env === null ? null : new Set(env.toString('utf8').split(/\r?\n/).map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)).filter(Boolean).map((m) => m[1]));
  return {
    sdhInstance: inst === null ? { exists: false } : { exists: true, sha256: sha256Of(inst) },
    taskPoolDb: db === null ? { exists: false } : { exists: true, bytes: db.length, sha256: sha256Of(db) },
    envKeys: { exists: env !== null, keys: keys.map((k) => ({ key: k, present: present === null ? false : present.has(k) })) },
  };
}
// 一次快照的拒绝理由（跑之前 / 跑完之后各调一次）。
function snapshotProblems(snap, when) {
  const problems = [];
  if (!snap.product.clean) problems.push('产品源码（' + PRODUCT_STATUS_PATHS.join('、') + '）有未提交改动，或读不到 git（' + when + '）：' + JSON.stringify(snap.product.statusPorcelain));
  if (snap.workingTree === null || snap.workingTree === undefined) problems.push('读不到 git status（' + when + '）');
  else {
    const stray = strayDirtyPaths(snap);
    if (stray.length) problems.push('工作区有 tmp/ 以外、又不在已记哈希集合里的脏路径或未跟踪路径（' + when + '）：' + stray.join('、'));
  }
  return problems;
}
// HEAD 前后两个提交之间改了哪些路径；读不到 → null；没动 → []。
function headMovePaths(repo, from, to) {
  if (!from || !to || from === to) return [];
  const o = gitOut(repo, ['diff', '--name-only', '--no-renames', from, to]);
  return o === null ? null : o.split(/\r?\n/).filter(Boolean);
}
// 每个文件当前的 git hash-object（按路径属性做换行转换后的 blob 号，与提交后的 blob 对得上）与原始字节的 sha256。
function hashFiles(repo, files) {
  const blobs = [];
  for (let i = 0; i < files.length; i += 40) {
    const chunk = files.slice(i, i + 40);
    const o = gitOut(repo, ['hash-object', '--', ...chunk]);
    const lines = o === null ? [] : o.split(/\r?\n/).filter(Boolean);
    if (lines.length !== chunk.length) throw new Error('git hash-object 返回 ' + lines.length + ' 行，应为 ' + chunk.length + '（' + chunk[0] + ' 起）');
    blobs.push(...lines);
  }
  return files.map((f, i) => ({ path: f, loadedByRun: !isNotLoadedByRun(f), gitHashObject: blobs[i], sha256: sha256File(path.join(repo, ...f.split('/'))) }));
}
// 「运行时不加载」白名单（MED-2：显式列表，不是「除某几个以外都放行」的负向前瞻——后者对新加进 sysbuild-step1 的文件默认放行）。
//   sysbuild-step1 下跑基线时真正被加载的只有 build-mutation-baseline.js（跑的人）与 mutation-check.js（读登记）；这四个（实施清单 / 测试去向 / 解析与交叉引用工具）与变异自检互不相干，
//   别的任务在运行期间改它们不影响基线——运行前后哈希不一致、或 HEAD 前后的差异里出现它们时只记录不拒绝；白名单以外的任何路径变了一律拒绝。
//   运行结束时再断言这四个文件都不在本进程的 require.cache 里（whitelistLoadedInProcess）。
const NOT_LOADED_WHITELIST = Object.freeze([
  'wbs-server/scripts/sysbuild-step1/build-impl-list.js',
  'wbs-server/scripts/sysbuild-step1/build-test-disposition.js',
  'wbs-server/scripts/sysbuild-step1/inv-parse.js',
  'wbs-server/scripts/sysbuild-step1/xref-exports.js',
]);
const isNotLoadedByRun = (p) => NOT_LOADED_WHITELIST.includes(p);
// 白名单里的文件有没有出现在 require.cache（repo 与本脚本所在仓库两处都查；Windows 下路径不分大小写）。返回命中的仓库相对路径。
function whitelistLoadedInProcess(repo, cache) {
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const want = new Map();
  for (const root of new Set([repo, DEFAULT_REPO])) for (const rel of NOT_LOADED_WHITELIST) want.set(norm(path.join(root, ...rel.split('/'))), rel);
  const hit = [];
  for (const k of Object.keys(cache || {})) { const rel = want.get(norm(k)); if (rel) hit.push(rel); }
  return Array.from(new Set(hit)).sort();
}
// 运行前后哈希不一致（或增删）的文件，按「运行时被加载 / 不被加载」分开：{ loadedByRun: [路径], notLoadedByRun: [{ path, sha256Before, sha256After }] }。
function changedFiles(preFiles, postFiles) {
  const bef = new Map(preFiles.map((x) => [x.path, x]));
  const aft = new Map(postFiles.map((x) => [x.path, x]));
  const out = { loadedByRun: [], notLoadedByRun: [] };
  for (const p of Array.from(new Set([...bef.keys(), ...aft.keys()])).sort()) {
    const b = bef.get(p);
    const z = aft.get(p);
    if (b && z && b.sha256 === z.sha256) continue;
    if (isNotLoadedByRun(p)) out.notLoadedByRun.push({ path: p, sha256Before: b ? b.sha256 : null, sha256After: z ? z.sha256 : null }); else out.loadedByRun.push(p);
  }
  return out;
}
function snapshotInputs(repo) {
  const wt = gitOut(repo, ['status', '--porcelain', '--untracked-files=all']);
  return { at: new Date().toISOString(), product: productTreeState(repo), testFiles: hashFiles(repo, listTestFiles(repo)), workingTree: wt === null ? null : wt.split(/\r?\n/).filter(Boolean), ignoredInputs: ignoredInputsState(repo) };
}
const BASELINE_RE = {
  api: /^\s*[✓✗] 未变异基线/,
  browser: /^浏览器检查 \d+\/\d+ 通过/,
  static: /^\s*[✓✗] 未变异基线/,
  schema: /^\s*[✓✗] 未变异基线/,
  db: /^\s*[✓✗] 未变异基线/,
  attachments: /^\s*[✓✗] 未变异基线/,
  migration: /^迁移未变异基线 \d+\/\d+/,
  deploy: /^部署迁移守卫检查 \d+\/\d+/,
  archive: /^存档未变异基线 \d+\/\d+/,
  readonly: /^只读未变异基线 \d+\/\d+/,
};
const lineOf = (text, re, last) => {
  const r = new RegExp(re.source, re.flags.replace('m', ''));
  const hit = String(text || '').split(/\r?\n/).filter((l) => r.test(l));
  return hit.length ? (last ? hit[hit.length - 1] : hit[0]) : null;
};
const relOrAbs = (repo, f) => { const r = path.relative(repo, f); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replace(/\\/g, '/') : f; };
function fileEvidence(repo, f) { const b = fs.readFileSync(f); return { file: relOrAbs(repo, f), bytes: b.length, sha256: sha256Of(b) }; }
// 驱动报告的「未变异基线」那一行（原样）与是否全绿：行首不是 ✗，且 N/M 里 N = M > 0。
function baselineGreen(line) {
  if (!line || /^\s*✗/.test(line)) return false;
  const m = /(\d+)\/(\d+)/.exec(line);
  return !!m && m[1] === m[2] && Number(m[2]) > 0;
}
const idsSha = (ids) => sha256Of(JSON.stringify(ids));
function attachmentsFixEvidence(repo, beforeLog, afterLog, commit) {
  const problems = [];
  const one = (file, want) => {
    const ev = fileEvidence(repo, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const per = ATTACHMENTS_FIX.ids.map((id) => ({ id, lines: lines.filter((l) => l.includes('[' + id + ']')) }));
    for (const p of per) {
      if (p.lines.length !== 1) problems.push(ev.file + '：「' + p.id + '」应恰好出现 1 行，实际 ' + p.lines.length);
      else if (!new RegExp('^\\s*' + want).test(p.lines[0])) problems.push(ev.file + '：「' + p.id + '」应以 ' + want + ' 开头：' + p.lines[0]);
    }
    return { ...ev, summaryLine: lines.filter((l) => /^变异自检：/.test(l)).pop() || null, mutations: per };
  };
  const rev = gitOut(repo, ['rev-parse', '--verify', commit + '^{commit}']);
  const doc = { fixCommit: rev === null ? null : rev.trim(), fixCommitGiven: commit, before: one(beforeLog, '✗'), after: one(afterLog, '✓') };
  if (doc.fixCommit === null) problems.push('修复提交 ' + commit + ' 不在本仓库里');
  return { doc, problems };
}
// 来源清单正文 + 拒绝生成的理由。pre / post：snapshotInputs 的结果（--parse-only 时 post = null；run 模式下 post.headMovePaths 由调用方按 pre / post 的 HEAD 填）。
//   requireCache：测试用，缺省取本进程的 require.cache。
function buildProvenance({ repo, o, a, rawDir, data, pre, post, requireCache }) {
  const problems = [];
  const mode = o.parseOnly ? 'parse-only' : 'run';
  problems.push(...snapshotProblems(pre, '跑之前'));
  if (post) {
    problems.push(...snapshotProblems(post, '跑完之后'));
    // 产品源码的树 / blob 对象号 + 工作区状态前后必须一致；HEAD 提交号允许变（别的任务在运行期间提交了无关文件，第二次全量跑就遇到了），但变了就要过下面的 HEAD 硬门，前后各记一份
    const prodKey = (p) => JSON.stringify({ routesSysbuildTree: p.routesSysbuildTree, publicTree: p.publicTree, routesTree: p.routesTree, serverJsBlob: p.serverJsBlob, clean: p.clean, statusPorcelain: p.statusPorcelain });
    if (prodKey(pre.product) !== prodKey(post.product)) problems.push('产品源码快照在运行期间变了（树 / blob 对象号或工作区状态不一致）');
    if (post.product.head !== pre.product.head) {
      const mv = post.headMovePaths;
      if (!Array.isArray(mv)) problems.push('运行期间 HEAD 变了（' + pre.product.head + ' → ' + post.product.head + '），但读不到两个提交之间改动的路径');
      else {
        const outside = mv.filter((p) => !isNotLoadedByRun(p));
        if (outside.length) problems.push('运行期间 HEAD 变了，两个提交之间改动了「不加载白名单」以外的路径：' + outside.join('、'));
      }
    }
    const changed = changedFiles(pre.testFiles, post.testFiles);
    if (changed.loadedByRun.length) problems.push('测试 / 驱动文件在运行期间变了：' + changed.loadedByRun.join('、'));
    // 被忽略的运行输入：task_pool.db 的字节数与哈希前后必须一致（.sdh-instance、.env 键存在性只记录）
    if (pre.ignoredInputs && post.ignoredInputs) {
      const a1 = pre.ignoredInputs.taskPoolDb;
      const b1 = post.ignoredInputs.taskPoolDb;
      if (JSON.stringify(a1) !== JSON.stringify(b1)) problems.push('wbs-server/task_pool.db 在运行期间变了（字节数或 sha256 前后不一致）：跑前 ' + JSON.stringify(a1) + '，跑后 ' + JSON.stringify(b1));
    }
  }
  const inCache = whitelistLoadedInProcess(repo, requireCache || require.cache);
  if (inCache.length) problems.push('「不加载白名单」里的文件出现在本进程的 require.cache 里（说明它们被加载过，运行期间改动不能放行）：' + inCache.join('、'));
  const groups = {};
  for (const g of o.groups) {
    const d = data[g];
    const meta = d.meta || null;
    const recs = parseRaw(d.text).records.filter((r) => r.group === g);
    const logFile = path.join(rawDir, g + '.log');
    const baseLine = lineOf(d.text, BASELINE_RE[g], false);
    const finish = lineOf(d.text, FINISH_RE[g], true);
    if (!baselineGreen(baseLine)) problems.push('组 ' + g + '：驱动的未变异基线行缺失或不是全绿：' + JSON.stringify(baseLine));
    if (!meta) problems.push('组 ' + g + '：没有 meta（命令、起止时间、退出码取不到）');
    const regIds = d.registered.map((x) => x.id);
    const ranIds = recs.map((r) => r.id);
    groups[g] = {
      command: meta ? meta.command : null,
      argv: meta ? meta.argv || null : null,
      env: meta ? meta.env || null : null,
      mode: g === 'api' ? '过滤模式（不加 --full）' : '--self-test 全量',
      startedAt: meta ? meta.startedAt : null,
      endedAt: meta ? meta.endedAt : null,
      seconds: meta ? meta.seconds : null,
      exitCode: meta ? meta.exitCode : null,
      signal: meta ? meta.signal : null,
      rawLog: fs.existsSync(logFile) ? fileEvidence(repo, logFile) : null,
      rawMeta: fs.existsSync(path.join(rawDir, g + '.meta.json')) ? fileEvidence(repo, path.join(rawDir, g + '.meta.json')) : null,
      driverBaselineLine: baseLine,
      driverBaselineGreen: baselineGreen(baseLine),
      driverFinishLine: finish,
      registered: regIds.length,
      mutRecords: recs.length,
      registeredIdsSha256: idsSha(regIds),
      ranIdsSha256: idsSha(ranIds),
      ranIdsEqualRegisteredInOrder: JSON.stringify(regIds) === JSON.stringify(ranIds),
      ranIdsEqualRegisteredAsSet: JSON.stringify(regIds.slice().sort()) === JSON.stringify(ranIds.slice().sort()),
    };
  }
  let attachmentsFix = null;
  if (o.fixBeforeLog) { const r = attachmentsFixEvidence(repo, o.fixBeforeLog, o.fixAfterLog, o.fixCommit || ATTACHMENTS_FIX.commit); attachmentsFix = r.doc; problems.push(...r.problems); } else problems.push('没有给 --fix-before-log / --fix-after-log：来源清单缺附件 7 条修复的前后证据');
  const doc = {
    format: PROVENANCE_FORMAT,
    generatedAt: new Date().toISOString(),
    mode,
    modeNote: mode === 'parse-only' ? '只解析已有原始日志：下面的文件哈希与产品源码快照是取证时刻的，不是运行时的' : '文件哈希与产品源码快照在运行前后各取一次，两次一致才生成',
    repoHead: pre.product.head,
    repoHeadAfterRun: post ? post.product.head : null,
    repoHeadMovedDuringRun: post ? post.product.head !== pre.product.head : null,
    repoHeadMovePaths: post && post.product.head !== pre.product.head && Array.isArray(post.headMovePaths) ? post.headMovePaths : null,
    parallelBrowser: o.parseOnly ? null : !!o.parallelBrowser,
    notLoadedWhitelist: NOT_LOADED_WHITELIST,
    whitelistInRequireCache: inCache,
    ignoredInputs: { before: pre.ignoredInputs || null, after: post ? post.ignoredInputs || null : null },
    productTree: { ...pre.product, afterRun: post ? { head: post.product.head, headTree: post.product.headTree, routesSysbuildTree: post.product.routesSysbuildTree, publicTree: post.product.publicTree, routesTree: post.product.routesTree, serverJsBlob: post.product.serverJsBlob, clean: post.product.clean, statusPorcelain: post.product.statusPorcelain } : null },
    testFiles: pre.testFiles,
    testFilesCount: pre.testFiles.length,
    testFilesChangedDuringRun: post ? changedFiles(pre.testFiles, post.testFiles) : null,
    workingTree: { before: pre.workingTree, after: post ? post.workingTree : null, same: post ? JSON.stringify(pre.workingTree) === JSON.stringify(post.workingTree) : null, snapshotAt: pre.at, afterAt: post ? post.at : null },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), generator: 'wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js', stackLimitOption: STACK_LIMIT_OPTION },
    groups,
    reconcile: a.reconciles.map((rc) => ({ group: rc.group, missing: rc.missing.length, extra: rc.extra.length, duplicates: rc.duplicates.length, dupRegistered: rc.dupRegistered.length, ok: rc.ok })),
    attachmentsFix,
    entriesSha256: sha256Of(JSON.stringify(a.entries)),
  };
  return { doc, problems };
}

// 基线顶层（不看来源清单也能核的部分）：字段集合、format 之外的固定值、各组汇总从 entries 重算后与顶层逐项比对（MED-1：顶层汇总不绑哈希，只能靠重算）。返回问题清单。
const BASELINE_TOP_KEYS = Object.freeze(['format', 'generatedAt', 'runAt', 'headCommit', 'headCommitAtRunStart', 'workingTreeDirty', 'mode', 'env', 'groups', 'provenanceFile', 'provenanceSha256', 'entries']);
function baselineTopLevelProblems(baseline) {
  const problems = [];
  const keys = Object.keys(baseline);
  for (const k of keys) if (!BASELINE_TOP_KEYS.includes(k)) problems.push('基线顶层有未知字段 ' + JSON.stringify(k));
  for (const k of BASELINE_TOP_KEYS) if (!keys.includes(k)) problems.push('基线顶层缺字段 ' + JSON.stringify(k));
  if (baseline.mode !== 'filtered') problems.push('基线 mode 应为 "filtered"，实际 ' + JSON.stringify(baseline.mode));
  const seen = new Set();
  for (const e of baseline.entries) { const k = keyOf(e); if (seen.has(k)) problems.push('entries 里 (组, id) 重复：' + e.group + ' / ' + e.id); seen.add(k); }
  const byGroup = new Map();
  for (const e of baseline.entries) { if (!byGroup.has(e.group)) byGroup.set(e.group, []); byGroup.get(e.group).push(e); }
  const gs = baseline.groups && typeof baseline.groups === 'object' ? baseline.groups : {};
  for (const g of Array.from(new Set([...Object.keys(gs), ...byGroup.keys()])).sort()) {
    if (!byGroup.has(g)) { problems.push('顶层汇总里有组 ' + g + '，entries 里没有这个组'); continue; }
    if (!gs[g]) { problems.push('entries 里有组 ' + g + '，顶层汇总里没有'); continue; }
    const want = summarize(byGroup.get(g), byGroup.get(g).length);
    for (const f of ['total', 'red', 'weak', 'abnormal', 'anchor']) if (gs[g][f] !== want[f]) problems.push('顶层汇总与 entries 重算不一致：组 ' + g + ' ' + f + ' 顶层 ' + JSON.stringify(gs[g][f]) + '，重算 ' + want[f]);
  }
  return problems;
}
// 基线顶层字段与来源清单里的值逐项比对（HEAD、运行起点、工作区状态、node 版本、各组登记数 / 记录数 / id 序列哈希 / 退出码、对账结果）。返回问题清单。
function baselineProvenanceProblems(baseline, doc) {
  const problems = [];
  const eq = (what, a, b) => { if (a !== b) problems.push(what + ' 与来源清单不一致：基线 ' + JSON.stringify(a) + '，清单 ' + JSON.stringify(b)); };
  if (doc.format !== PROVENANCE_FORMAT) problems.push('来源清单格式应为 ' + PROVENANCE_FORMAT + '，实际 ' + JSON.stringify(doc.format));
  eq('headCommit', baseline.headCommit, doc.repoHeadAfterRun || doc.repoHead);
  eq('headCommitAtRunStart', baseline.headCommitAtRunStart, doc.repoHead);
  const gdoc = doc.groups && typeof doc.groups === 'object' ? doc.groups : {};
  const starts = Object.values(gdoc).map((x) => x && x.startedAt).filter(Boolean).sort();
  eq('runAt', baseline.runAt, starts.length ? starts[0] : null);
  const wt = doc.workingTree ? (doc.workingTree.after || doc.workingTree.before) : null;
  if (baseline.workingTreeDirty !== null && Array.isArray(wt)) eq('workingTreeDirty', baseline.workingTreeDirty, wt.length > 0);
  eq('env.node', baseline.env && baseline.env.node, doc.runtime && doc.runtime.node);
  if (typeof baseline.generatedAt !== 'string' || typeof doc.generatedAt !== 'string' || baseline.generatedAt < doc.generatedAt) problems.push('基线 generatedAt（' + JSON.stringify(baseline.generatedAt) + '）不应早于来源清单 generatedAt（' + JSON.stringify(doc.generatedAt) + '）');
  const bg = baseline.groups && typeof baseline.groups === 'object' ? baseline.groups : {};
  const gk = (o) => Object.keys(o).sort().join(',');
  if (gk(bg) !== gk(gdoc)) problems.push('基线各组（' + gk(bg) + '）与来源清单各组（' + gk(gdoc) + '）不一致');
  for (const g of Object.keys(bg)) {
    const d = gdoc[g];
    if (!d) continue;
    eq('组 ' + g + ' 登记数', bg[g].total, d.registered);
    eq('组 ' + g + ' 记录数', bg[g].total, d.mutRecords);
    eq('组 ' + g + ' 驱动退出码', 0, d.exitCode);
    eq('组 ' + g + ' id 序列哈希', idsSha(baseline.entries.filter((e) => e.group === g).map((e) => e.id)), d.registeredIdsSha256);
  }
  for (const rc of Array.isArray(doc.reconcile) ? doc.reconcile : []) if (!rc.ok) problems.push('来源清单里组 ' + rc.group + ' 的对账结果不是 ok');
  return problems;
}
// 基线 ↔ 来源清单互相对得上：清单文件的 sha256 = 基线顶层 provenanceSha256，清单里的 entriesSha256 = 基线 entries 的 sha256，再加上面两组顶层核对。
//   基线没有 provenanceFile：默认不通过（MED-1）；opts.allowNone（--allow-no-provenance，自检用）才放行（顶层汇总仍然重算核对）。返回 { ok, text, mode }（mode = 清单的 mode，没有清单为 null）。
function provenanceLink(baseline, baselineFile, opts) {
  const allowNone = !!(opts && opts.allowNone);
  const top = baselineTopLevelProblems(baseline);
  if (!baseline.provenanceFile) {
    if (!allowNone) top.push('基线没有来源清单（provenanceFile 为空）；--compare 默认拒绝，只有自检内部经钩子 allowNoProvenance 放行（命令行没有这个参数）');
    else if (baseline.provenanceSha256 !== null && baseline.provenanceSha256 !== undefined) top.push('--allow-no-provenance 只放行 provenanceFile 与 provenanceSha256 都为 null 的基线；这份只剥掉了 provenanceFile、provenanceSha256 还在（疑似清单被摘掉）');
    return { ok: top.length === 0, mode: null, text: top.length ? top.join('；') : '基线没有来源清单（--allow-no-provenance：只有自检 / 实验会这样）；顶层汇总已从 entries 重算核对' };
  }
  if (baseline.provenanceFile !== path.basename(baseline.provenanceFile)) return { ok: false, mode: null, text: '基线登记的来源清单名 ' + JSON.stringify(baseline.provenanceFile) + ' 带路径，只认基线同目录下的文件名' };
  const f = path.join(path.dirname(baselineFile), baseline.provenanceFile);
  if (!fs.existsSync(f)) return { ok: false, mode: null, text: '基线登记的来源清单 ' + baseline.provenanceFile + ' 不在基线同目录' };
  const buf = fs.readFileSync(f);
  if (sha256Of(buf) !== baseline.provenanceSha256) return { ok: false, mode: null, text: '来源清单 sha256 与基线顶层 provenanceSha256 不一致' };
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch (e) { return { ok: false, mode: null, text: '来源清单不是 JSON：' + e.message }; }
  if (doc.entriesSha256 !== sha256Of(JSON.stringify(baseline.entries))) return { ok: false, mode: doc.mode === undefined ? null : doc.mode, text: '来源清单里的 entriesSha256 与基线 entries 不一致' };
  const problems = [...top, ...baselineProvenanceProblems(baseline, doc)];
  const mode = doc.mode === undefined ? null : doc.mode;
  if (problems.length) return { ok: false, mode, text: '基线顶层与来源清单对不上：' + problems.join('；') };
  return { ok: true, mode, text: '一致（来源清单 sha256 ' + baseline.provenanceSha256 + '；entriesSha256 对得上；顶层汇总、HEAD、运行起点、各组登记数与 id 序列哈希逐项核对一致；清单生成于 ' + doc.generatedAt + '）' };
}

// 两次运行的原始日志逐条对比（归一规则的实验依据）：同一条变异两次的判定 / 失败（case、errorClass、message、label、site）有任何不同就列出原文。
function diffRuns(dirA, dirB, groups) {
  const out = [];
  let same = 0;
  let total = 0;
  let rawOnly = 0; // 原文不同、套归一规则后相同的条数（规则表能解释的差异）
  for (const g of groups) {
    const ga = readGroupText(dirA, g);
    const gb = readGroupText(dirB, g);
    const a = ga.text;
    const b = gb.text;
    const refA = ga.meta && ga.meta.startedAt ? new Date(ga.meta.startedAt) : new Date();
    const refB = gb.meta && gb.meta.startedAt ? new Date(gb.meta.startedAt) : new Date();
    if (a === null || b === null) { out.push({ group: g, id: '(整组)', kind: '缺原始日志', a: a === null ? '缺' : '有', b: b === null ? '缺' : '有' }); continue; }
    const ma = new Map(parseRaw(a).records.map((r) => [r.id, r]));
    const mb = new Map(parseRaw(b).records.map((r) => [r.id, r]));
    for (const [id, ra] of ma) {
      total += 1;
      const rb = mb.get(id);
      if (!rb) { out.push({ group: g, id, kind: '第二次没有这条' }); continue; }
      const strip = (r, norm, ref) => JSON.stringify({ verdict: r.verdict, failures: r.failures.map((f) => ({ case: f.case, errorClass: f.errorClass, message: norm ? normalizeMessage(f.message, { group: g, ref }) : f.message, label: f.label })) });
      if (strip(ra, true, refA) !== strip(rb, true, refB)) { out.push({ group: g, id, kind: '判定或失败信息不同（归一后仍不同）', a: ra, b: rb }); continue; }
      if (strip(ra, false, null) !== strip(rb, false, null)) { rawOnly += 1; continue; }
      const sites = (r) => JSON.stringify(r.failures.map((f) => f.site));
      if (sites(ra) !== sites(rb)) { out.push({ group: g, id, kind: '只有抛出位置不同', a: sites(ra), b: sites(rb) }); continue; }
      same += 1;
    }
    for (const id of mb.keys()) if (!ma.has(id)) out.push({ group: g, id, kind: '第一次没有这条' });
  }
  return { same, rawOnly, total, diffs: out };
}

// 自检钩子（89 号 HIGH-3，用户 P-THREAT = A 下的低成本硬门）：这四项不是命令行参数，只有自检内部调用 main(argv, hooks) 时才能注入；命令行给了一律用法错误。
//   96 号 MEDIUM（降级项）另有自检专用的 allowForeignTool（selfSpawn 在自检用 --repo 指向临时仓库时注入，放行「脚本在主检出、--repo 是临时仓库」的跨检出调用；命令行没有这个参数，真实命令行的跨检出调用 = 用法错误）：
//   registryFile（代替 mutation-check 的清单）、sRegistryFile（直接给 <S> 时登记：正式运行的 <S> 时登记一律由 registryAtCommit 在 <S> 的内容上读）、allowNoProvenance（放行没有来源清单的基线）、noProvenance（不写来源清单）；
//   另有自检专用的 driftGuard（让带登记钩子的自检也走读取器漂移硬门；selfSpawn 里用 --force-drift-guard 记号摘成钩子，命令行不认这个记号）。
const HOOK_FLAGS = Object.freeze(['--registry-file', '--s-registry-file', '--allow-no-provenance', '--no-provenance']);
function parseArgs(argv, hooks) {
  const hk = hooks || {};
  const o = { rerun: false, affectedFrom: null, help: false, groupsGiven: false, requireReview: false, changedSince: null, affected: null, affectedOut: null, repo: DEFAULT_REPO, groups: ALL_GROUPS.slice(), rawDir: null, out: null, parseOnly: null, compare: null, disposition: null, report: null, registryFile: hk.registryFile || null, sRegistryFile: hk.sRegistryFile || null, diffRuns: null, selfTest: false, provenance: null, noProvenance: !!hk.noProvenance, forceDriftGuard: !!hk.driftGuard, allowForeignTool: !!hk.allowForeignTool, skipCleanCheck: !!hk.skipCleanCheck, fixBeforeLog: null, fixAfterLog: null, fixCommit: null, parallelBrowser: false, allowNoProvenance: !!hk.allowNoProvenance, effective: null, effectiveAll: [], cumulative: false, effectiveNone: null, sRegistryAttest: null, rerunDirs: [] };
  const need = ['--effective', '--effective-none','--repo', '--groups', '--raw-dir', '--out', '--parse-only', '--compare', '--disposition', '--dispositions', '--report', '--diff-runs', '--provenance', '--fix-before-log', '--fix-after-log', '--fix-commit', '--changed-since', '--affected', '--affected-out', '--affected-from', '--s-registry-attest', '--rerun-dir', ...HOOK_FLAGS.filter((f) => f === '--registry-file' || f === '--s-registry-file')];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') { o.selfTest = true; continue; }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--require-review-dispositions') { o.requireReview = true; continue; }
    if (a === '--rerun') { o.rerun = true; continue; }
    if (a === '--no-provenance' || a === '--allow-no-provenance') throw new Error(a + ' 是自检钩子，不是命令行参数：只有 --self-test 内部调用 main(argv, hooks) 才能注入（89 号 HIGH-3）');
    if (a === '--parallel-browser') { o.parallelBrowser = true; continue; }
    if (a === '--cumulative') { o.cumulative = true; continue; }
    if (!need.includes(a)) throw new Error('未知参数 ' + a);
    if (a === '--registry-file' || a === '--s-registry-file') throw new Error(a + ' 是自检钩子，不是命令行参数：只有 --self-test 内部调用 main(argv, hooks) 才能注入；正式运行的登记由 mutation-check 读，<S> 时登记由 registryAtCommit 在 <S> 的内容上读（89 号 HIGH-3）');
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(a + ' 需要一个参数');
    const v = argv[i + 1];
    i += 1;
    if (a === '--repo') o.repo = path.resolve(v);
    else if (a === '--changed-since') o.changedSince = v;
    else if (a === '--effective') { o.effective = path.resolve(v); o.effectiveAll.push(o.effective); }
    else if (a === '--effective-none') o.effectiveNone = v;
    else if (a === '--s-registry-attest') o.sRegistryAttest = v.trim(); // 95 号 MEDIUM：参数解析时统一 trim（空串在下面拒绝），之后校验 / 显示 / 持久化 / 比较全用这一个值；第 ① 步同
    else if (a === '--rerun-dir') o.rerunDirs.push(path.resolve(v));
    else if (a === '--affected') o.affected = path.resolve(v);
    else if (a === '--affected-out') o.affectedOut = path.resolve(v);
    else if (a === '--affected-from') o.affectedFrom = path.resolve(v);
    else if (a === '--groups') { o.groupsGiven = true; o.groups = v.split(',').map((s) => s.trim()).filter(Boolean); const bad = o.groups.filter((g) => !ALL_GROUPS.includes(g)); if (bad.length || o.groups.length === 0) throw new Error('--groups 含未知组：' + (bad.join(',') || '(空)') + '；可选 ' + ALL_GROUPS.join(',')); }
    else if (a === '--raw-dir') o.rawDir = path.resolve(v);
    else if (a === '--out') o.out = path.resolve(v);
    else if (a === '--parse-only') o.parseOnly = path.resolve(v);
    else if (a === '--compare') o.compare = path.resolve(v);
    else if (a === '--disposition' || a === '--dispositions') o.disposition = path.resolve(v);
    else if (a === '--report') o.report = path.resolve(v);
    else if (a === '--diff-runs') o.diffRuns = path.resolve(v);
    else if (a === '--provenance') o.provenance = path.resolve(v);
    else if (a === '--fix-before-log') o.fixBeforeLog = path.resolve(v);
    else if (a === '--fix-after-log') o.fixAfterLog = path.resolve(v);
    else if (a === '--fix-commit') o.fixCommit = v;
  }
  // 89 号 HIGH-3：--self-test 不能与任何正式参数同给（自检不读它们，悄悄忽略会让人以为闸门跑过）
  if (o.selfTest && (argv.length > 1 || (argv.length === 1 && argv[0] !== '--self-test'))) throw new Error('--self-test 不能与其他参数同给（正式闸门参数一律不收；自检所需的钩子由自检内部注入）');
  if (o.noProvenance && o.provenance) throw new Error('--no-provenance 与 --provenance 不能同时给');
  if (!!o.fixBeforeLog !== !!o.fixAfterLog) throw new Error('--fix-before-log 与 --fix-after-log 要一起给');
  // 第 ② 步（--rerun）可以给 --dispositions / --report：只声明「复验之后才补写的产物路径」（89 号 HIGH-1），不读取；其余场合 --dispositions 只能与 --compare 一起用
  if (o.disposition && !o.compare && !o.rerun) throw new Error('--disposition / --dispositions 只能与 --compare 一起用（第 ② 步 --rerun 可用它声明补写产物路径）');
  if (o.report && !o.compare && !o.rerun) throw new Error('--report 只能与 --compare 一起用（第 ② 步 --rerun 可用它声明补写产物路径）');
  if (o.sRegistryAttest !== null && o.sRegistryAttest === '') throw new Error('--s-registry-attest 的理由不能是空白');
  if (o.sRegistryAttest !== null && !(o.rerun || (o.compare && o.requireReview) || o.affected)) throw new Error('--s-registry-attest 只能与 --rerun、--affected（带生效清单）、或 --compare … --require-review-dispositions 一起用');
  if (o.rerunDirs.length && !o.cumulative) throw new Error('--rerun-dir 只能与 --affected … --cumulative 一起用（C9 累计范围：各提交留档的复验目录）');
  // codex 79 HIGH-2：受影响子集闸门
  if (o.requireReview && !o.compare) throw new Error('--require-review-dispositions 只能与 --compare 一起用');
  if (o.requireReview && !o.changedSince) throw new Error('--require-review-dispositions 必须同时给 --changed-since <40 位提交号>（受影响条目靠它判定）');
  if (o.requireReview && !o.disposition) throw new Error('--require-review-dispositions 必须同时给 --dispositions <去向表登记 json>');
  if (o.changedSince && !o.requireReview && !o.affected && !o.rerun) throw new Error('--changed-since 只能与 --require-review-dispositions（--compare 下）、--affected 或 --rerun 一起用');
  // H1：第 ② 步由本工具执行（--rerun），日志与 meta 都由它写；闸门核对 meta
  if (o.rerun && (!o.rawDir || !o.affectedFrom || !o.changedSince)) throw new Error('--rerun 必须同时给 --raw-dir <目录>、--affected-from <基线 json>、--changed-since <40 位提交号>');
  // 预筛 LOW-3：--rerun 必须给 --dispositions（累计去向表路径，与第 ③ 步同一个）：它声明「复验之后才补写的产物路径」，不给则仓库内的去向表在第 ③ 步被当作新增改动拒绝
  if (o.rerun && !o.disposition) throw new Error('--rerun 必须给 --dispositions <累计去向表 json>（与第 ③ 步同一个路径；只声明复验之后才补写的产物路径，不读取）');
  if (o.rerun && (o.compare || o.out || o.parseOnly || o.affected || o.requireReview)) throw new Error('--rerun 不能与 --compare / --out / --parse-only / --affected / --require-review-dispositions 同用（复验和对比是两步）；--dispositions / --report 在 --rerun 下只声明补写产物的路径，不读取');
  if (o.affectedFrom && !o.rerun) throw new Error('--affected-from 只能与 --rerun 一起用');
  // R1（codex 81 HIGH-1 / HIGH-2）：生效清单。--rerun 与闸门（--compare … --require-review-dispositions）下必须给 --effective <json> 或 --effective-none "<理由>" 二选一，两个都不给 = 拒绝（硬门，不放行）。
  if (o.effective !== null && o.effectiveNone !== null) throw new Error('--effective 与 --effective-none 只能给一个');
  // 84 号 MEDIUM（C9 累计范围）：--affected … --cumulative 才许给多个 --effective（各提交留档的生效清单取并集）；其余场合 --effective 只能给一份
  if (o.cumulative && !o.affected) throw new Error('--cumulative 只能与 --affected 一起用（C9 累计范围：各提交留档的复验记录 + 净改动自动累计范围）');
  if (o.cumulative && o.effectiveNone !== null) throw new Error('--cumulative 不能与 --effective-none 同用（累计范围读各提交留档的 --rerun-dir，--effective 只用来核对）');
  if (o.effectiveAll.length > 1 && !o.cumulative) throw new Error('--effective 只能给一份（多份 --effective 只用于 --affected … --cumulative 的 C9 累计范围）');
  if (o.cumulative && o.rerunDirs.length === 0) throw new Error('--cumulative 必须给至少一份 --rerun-dir <复验目录>（各提交第 ② 步留档的 rerun.json；0 份 = 拒绝：没有留档就还原不出各提交实际复验过的编号）');
  // 95 号 MEDIUM：--cumulative 下 --effective 的份数不再要求等于 --rerun-dir 的份数——无清单模式（--effective-none）的留档没有清单文件；按留档顺序只给文件模式的留档消费一份 --effective，读完后拒绝缺少或多余（cumulativeAffected）
  if (o.effectiveNone !== null && o.effectiveNone.trim() === '') throw new Error('--effective-none 的理由不能是空白');
  const effOk = o.rerun || (o.compare && o.requireReview);
  // --affected 接受 --effective / --effective-none（可选：给了就按与 --rerun 同口径打印完整复验集合，不给只列自动范围）
  if ((o.effective !== null || o.effectiveNone !== null) && !effOk && !o.affected) throw new Error('--effective / --effective-none 只能与 --rerun、--affected、或 --compare … --require-review-dispositions 一起用');
  if (effOk && o.effective === null && o.effectiveNone === null) throw new Error((o.rerun ? '--rerun' : '--require-review-dispositions') + ' 必须给 --effective <生效清单 json>，没有生效清单的提交给 --effective-none "<理由>"（两个都不给 = 拒绝）');
  if (o.affected && (!o.changedSince || o.compare || o.out || o.parseOnly || o.rawDir || o.disposition)) throw new Error('--affected <基线 json> 必须与 --changed-since 一起用，且不能与 --compare / --out / --parse-only / --raw-dir / --dispositions 同用（它只读基线，不看日志）');
  if (o.affectedOut && !o.affected) throw new Error('--affected-out 只能与 --affected 一起用');
  if (o.allowNoProvenance && !o.compare) throw new Error('--allow-no-provenance 只能与 --compare 一起用');
  // L4：来源清单只许放在基线同目录（--compare 按基线里存的文件名在基线同目录找清单，别处的清单永远对不上）
  if (o.provenance && !o.out) throw new Error('--provenance 只能与 --out 一起用');
  if (o.provenance && o.out && path.dirname(o.provenance) !== path.dirname(o.out)) throw new Error('--provenance 必须与基线（--out）在同一个目录：' + path.dirname(o.provenance) + ' ≠ ' + path.dirname(o.out));
  if (o.parseOnly && o.rawDir) throw new Error('--parse-only 与 --raw-dir 不能同时给（--parse-only 的目录就是原始日志目录）');
  return o;
}
const readJson = (f, what) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { throw new Error(what + ' 无法读取或不是 JSON：' + e.message); } };

// C9 累计范围（84 号 MEDIUM，85 号 MEDIUM-5；89 号 MEDIUM 重写）：--affected <基线> --changed-since <C1 提交> --cumulative --rerun-dir <C2 复验目录> --rerun-dir <C3 复验目录> … --effective <C2 清单> --effective <C3 清单> …（文件模式留档必带，none 模式不带）。
//   旧口径（净改动自动范围 ∪ 各清单必跑编号）的漏洞：一条含糊变异在 C3 因目标文件改动被自动纳入复验、C5 又把该文件改回去，而且历次清单都没把它列为必跑——净改动里它「从未受影响」，C9 会把这条曾经复验并登记过三字段的变异归为不用复核。
//   新口径：用各提交留档的复验记录（第 ② 步 --rerun 写在 <复验目录>/rerun.json，format sysbuild-rerun/2）还原每个提交实际复验过的编号——含自动范围纳入的（rerun.json 的 groups 里每组有 auto / mustRun / by / remount / added 与去重后的 runIds）、
//   该提交的 retire 记录（category / newId / by）、各组驱动退出码；按提交顺序逐份列出，每个编号逐条输出命中来源（<提交名>:<来源>）。需留档的文件：每个提交第 ② 步的 <复验目录>/rerun.json（必须；其他文件 <组>.meta.json / <组>.log / empty-plan.json 不参与本命令）；
//   --effective：文件模式（非 none）的留档必须按留档顺序各带一份（个数 = 文件模式留档数；none 模式的留档不需要），用来核对 rerun.json 记的清单 sha256 与它是同一份——漏带无法识别同一父提交下清单改过的前一轮。0 份复验目录 = 拒绝（用法错误）；复验目录里没有 rerun.json / 格式不对 = 拒绝。
//   追溯（按提交顺序逐支）：某提交复验过的编号 X，从下一个提交起逐个看各提交的 retire：X 被 retire → remount 追到 newId、equivalent 追到 by 的每一支、stop-only 记「已无承接」；每一支单独走到底，
//   每一支的结果都单独保留并输出（仍在当前登记 / 已无承接 / 已不在当前登记且各留档里没有 retire 记录），不因为另一支仍在就省略已断的那一支。编号复用（某编号先被 retire、后又作为新增 / newId 登记）：
//   旧编号的证据在被 retire 的那个提交就结束，不会串到后来同名的新编号；工具层识别出复用时输出警告并要求人工核对复用之后该编号的三字段登记。
//   只有「各提交实际复验过的编号（含自动纳入的）」与「净改动自动累计范围」两边都没命中的需人工复核条目，才可按从未受影响处理；命中的逐条核对各提交留档的三字段登记在最终代码上是否仍适用。
//   commits：[{ name, retire: [{ group, id, category, newId?, by? }], groups: { <组>: { auto, mustRun, by, remount, added, runIds } }, results? }]（按提交顺序）；currentKeys：当前登记；changed：<C1>..HEAD 的净改动路径。
//   返回 { live, aff, perCommit: [{ name, groups: Map<组, [{ id, sources }]> }], hits: Map<最终编号键, 命中来源[]>, traced: [{ group, id, commit, sources, branches: [{ kind: 'final'|'dead'|'unknown', group?, id?, note }] }], reuse: [警告文字], groups: Map<组, { net, archive, union }> }。
//   95 号 HIGH-2：各提交「实际复验过的编号」取 rerun.json（sysbuild-rerun/3）的 ranIds（复验结束后按第 ③ 步同口径从日志解析：实际有结果行的仍登记编号）——非 api 组整组跑，会跑出计划外的编号，
//   它们在 outOfPlanIds 里、来源标「<提交名>:整组实跑」；计划里有、日志里没有结果行的编号（第 ③ 步本会拒）进 perCommit[i].plannedNotRan（本函数只如实返回；cumulativeAffected 见到非空就按「留档不完整」拒，退出码 1）。commits[i] 需带 ranIds（缺 = 空）。
//   95 号 MEDIUM：净改动自动累计范围（live → aff）纳入 C1 之后新增的现行编号（currentEntries：当前登记的条目 { group, id, files }，与第 ② 步 rerunPlan 构造活动条目同一口径：登记里的目标文件参与文件交集）；
//   留档识别出的复用编号（先 retire、后又新增 / 改挂，工具层 reuse）按现行登记的目标文件算（旧基线里同名条目的失败位置与目标文件属于旧一代，不用）。
function cumulativeScope({ baseEntries, changed, commits, currentKeys, currentEntries }) {
  const SRC = ['auto', 'mustRun', 'by', 'remount', 'added'];
  // 编号复用：先被 retire、后又作为新增（added）或改挂目标（newId）登记
  const reuse = [];
  const reusedKeys = new Set();
  const lastDeath = new Map();
  commits.forEach((c) => {
    for (const r of c.retire || []) lastDeath.set(keyOf(r), c.name);
    const births = [...(c.added || []), ...(c.retire || []).filter((r) => r.newId).map((r) => r.newId)];
    for (const x of births) { const k = keyOf(x); if (lastDeath.has(k) && lastDeath.get(k) !== c.name) { reuse.push(`编号 [${x.group}] ${JSON.stringify(x.id)} 先在 ${lastDeath.get(k)} 被 retire、又在 ${c.name} 作为新增登记（编号复用）：工具按提交顺序分开追溯，旧编号的证据不会串到新编号；请人工核对 ${c.name} 之后该编号的三字段登记`); reusedKeys.add(k); } }
  });
  const baseKeySet = new Set(baseEntries.map(keyOf));
  const newcomers = (currentEntries || []).filter((e) => !baseKeySet.has(keyOf(e)) || reusedKeys.has(keyOf(e))).map((e) => ({ group: e.group, id: e.id, files: Array.isArray(e.files) ? e.files : [], verdict: null, failures: [], noBaselineLocation: true }));
  const live = [...baseEntries.filter((e) => currentKeys.has(keyOf(e)) && !reusedKeys.has(keyOf(e))), ...newcomers];
  const aff = affectedOf(live, null, changed);
  const retireAt = commits.map((c) => { const m = new Map(); for (const r of c.retire || []) m.set(keyOf(r), r); return m; });
  // 逐提交的复验编号及来源（实跑编号；计划外的标「整组实跑」）
  const perCommit = commits.map((c) => {
    const groups = new Map();
    const plannedNotRan = [];
    for (const g of ALL_GROUPS) {
      const s = (c.groups && c.groups[g]) || null;
      const ran = c.ranIds && Array.isArray(c.ranIds[g]) ? c.ranIds[g] : [];
      const planned = s && Array.isArray(s.runIds) ? s.runIds : [];
      const ids = [];
      for (const id of ran) { const src = s ? SRC.filter((x) => Array.isArray(s[x]) && s[x].includes(id)).map((x) => c.name + ':' + x) : []; ids.push({ id, sources: src.length ? src : [c.name + ':整组实跑'] }); }
      for (const id of planned) if (!ran.includes(id)) plannedNotRan.push({ group: g, id });
      if (ids.length) groups.set(g, ids);
    }
    return { name: c.name, groups, plannedNotRan };
  });
  // 从提交 i 的编号 k0 出发，逐支向后追：每一支 { key, note } 在后续提交里被 retire 就按类别换成新支，走到最后一个提交后判定
  const traceFrom = (i, k0) => {
    let branches = [{ key: k0, dead: null }];
    for (let j = i + 1; j < commits.length; j += 1) {
      const next = [];
      for (const b of branches) {
        if (b.dead) { next.push(b); continue; }
        const r = retireAt[j].get(b.key);
        if (!r) { next.push(b); continue; }
        if (r.category === 'remount') next.push({ key: keyOf(r.newId), dead: null, via: `${commits[j].name}:remount` });
        else if (r.category === 'equivalent') for (const x of r.by) next.push({ key: keyOf(x), dead: null, via: `${commits[j].name}:equivalent` });
        else next.push({ key: b.key, dead: `${commits[j].name}:stop-only 删除（没有承接）` });
      }
      branches = next;
    }
    return branches.map((b) => {
      const i0 = b.key.indexOf('\u0000');
      const ref = { group: b.key.slice(0, i0), id: b.key.slice(i0 + 1) };
      if (b.dead) return { kind: 'dead', ...ref, note: b.dead };
      if (currentKeys.has(b.key)) return { kind: 'final', ...ref, note: b.via ? '经 ' + b.via + ' 承接' : '' };
      return { kind: 'unknown', ...ref, note: '已不在当前登记里、各留档里也没有它的 retire 记录（留档不全，或这个编号在留档之外被删）' };
    });
  };
  const hits = new Map();
  const traced = [];
  const hit = (key, srcs) => { if (!hits.has(key)) hits.set(key, []); for (const s of srcs) if (!hits.get(key).includes(s)) hits.get(key).push(s); };
  commits.forEach((c, i) => {
    for (const [g, ids] of perCommit[i].groups) {
      for (const { id, sources } of ids) {
        const br = traceFrom(i, g + '\u0000' + id);
        const finals = br.filter((b) => b.kind === 'final');
        const direct = br.length === 1 && br[0].kind === 'final' && br[0].group === g && br[0].id === id && !br[0].note;
        if (direct) { hit(g + '\u0000' + id, sources); continue; }
        for (const f of finals) hit(f.group + '\u0000' + f.id, sources.map((s) => s + '（经追溯）'));
        traced.push({ group: g, id, commit: c.name, sources, branches: br });
      }
    }
  });
  const per = new Map();
  const slot = (g) => { if (!per.has(g)) per.set(g, { net: [], archive: [], union: [] }); return per.get(g); };
  for (const x of aff) slot(x.group).net.push(x.id);
  for (const k of hits.keys()) { const i0 = k.indexOf('\u0000'); slot(k.slice(0, i0)).archive.push(k.slice(i0 + 1)); }
  const groups = new Map();
  for (const g of ALL_GROUPS) { if (!per.has(g)) continue; const s = per.get(g); s.union = Array.from(new Set([...s.net, ...s.archive])); groups.set(g, s); }
  return { live, aff, perCommit, hits, traced, reuse, groups };
}
// C9 留档链式核对（预筛 MED-1）：各份 rerun.json 按「提交链」衔接，漏传中间一份 / 重叠 / 断链即拒。工具已记录的字段：rerun.json 的 changedSince（= 该提交的 <S>）与 context.startHead（第 ② 步时的 HEAD）。
//   最严且可实现的判定：① 第 1 份的 changedSince = --changed-since（C1 提交）；② 第 i 份的 changedSince 必须是第 i−1 份 startHead 本身（第 ② 步在提交之后补跑的情形），
//   或第 i−1 份 startHead 的直接子提交（第 ② 步在提交前跑、HEAD = <S>，随后提交的就是这一个提交：S_i 的父提交 = 第 i−1 份 startHead）——两者之间不许有未覆盖的提交（多一个提交就是漏了一份），也不许 S_i 落在 startHead 之前（重叠）；
//   ③ 最后一份的 startHead 必须是 HEAD 本身或 HEAD 的直接父提交（C8 提交后、C9 改动还没提交时跑：HEAD = C8 提交，最后一份是 C8 的第 ② 步，startHead = C8 的 <S> = HEAD 的父提交）；
//      否则拒，并列出最后一份之后到 HEAD 之间没有留档的提交（尾部漏份）。
//   前提：C1 收口到 C9 之间不得对线分支 rebase / amend / cherry-pick（提交号变了就接不上链）；每个提交（含工具、文档提交）都须留第 ② 步复验目录（复验集合为空的空计划也留：--rerun 写 rerun.json）。返回问题数组。commits 按提交顺序，每项带 changedSince / startHead / name / dir。
function cumulativeChainProblems(repo, since, commits) {
  const out = [];
  const par = (sha) => (gitOut(repo, ['rev-parse', '--verify', '--quiet', sha + '^']) || '').trim();
  commits.forEach((c, i) => {
    const tag = `第 ${i + 1} 份（${c.name}，${c.dir}）`;
    if (!/^[0-9a-f]{40}$/.test(String(c.changedSince)) || !/^[0-9a-f]{40}$/.test(String(c.startHead))) { out.push(`${tag}：rerun.json 缺完整的 changedSince / context.startHead，无法核对提交链`); return; }
    if (i === 0) { if (c.changedSince !== since) out.push(`${tag}：changedSince ${c.changedSince} 不等于 --changed-since ${since}（第 1 份必须从 C1 提交接起）`); return; }
    const prev = commits[i - 1];
    if (!/^[0-9a-f]{40}$/.test(String(prev.startHead))) return; // 上一份缺字段已报
    if (c.changedSince === prev.changedSince) { out.push(`${tag}：changedSince 与上一份（${prev.name}）相同（${c.changedSince}）——重叠：同一个提交的复验留档传了两次`); return; }
    if (c.changedSince === prev.startHead || par(c.changedSince) === prev.startHead) return;
    out.push(`${tag}：changedSince ${c.changedSince} 与上一份（${prev.name}）的 startHead ${prev.startHead} 对不上——既不是它本身、也不是它的直接子提交（断链 / 重叠 / 中间漏了一份或几份留档）`);
  });
  const last = commits[commits.length - 1];
  if (last && /^[0-9a-f]{40}$/.test(String(last.startHead))) {
    const head = (gitOut(repo, ['rev-parse', 'HEAD']) || '').trim();
    if (last.startHead !== head && par('HEAD') !== last.startHead) {
      if (gitOut(repo, ['merge-base', '--is-ancestor', last.startHead, 'HEAD']) === null) out.push(`最后一份（${last.name}）的 startHead ${last.startHead} 不是 HEAD 的祖先`);
      else {
        const gap = (gitOut(repo, ['rev-list', '--reverse', last.startHead + '..HEAD']) || '').split(/\r?\n/).filter(Boolean);
        out.push(`最后一份（${last.name}）的 startHead ${last.startHead} 既不是 HEAD 本身、也不是 HEAD 的直接父提交：最后一份之后到 HEAD 之间有 ${gap.length} 个提交没有对应的复验留档（漏传最后一份或几份）：${gap.slice(0, 8).map((x) => x.slice(0, 12)).join('、')}${gap.length > 8 ? ' …' : ''}`);
      }
    }
  }
  // 95 号 HIGH-1：每份留档自身只许覆盖一个提交，再把每份映射到一个实际提交、沿 <C1>→HEAD 的提交序列逐个核对。
  //   提交前跑（startHead = changedSince）：该份覆盖的是 startHead 之后的下一个提交（startHead = HEAD 时是还没提交的工作区，只许是最后一份）；
  //   提交后补跑（startHead 是 changedSince 的直接子提交）：该份覆盖的就是 startHead 这个提交。其余形态（例如误把 C1→C4 的一次补跑当唯一留档：首尾都对得上、中间各提交的自动命中与退役记录全漏）一律拒。
  const full = (x) => /^[0-9a-f]{40}$/.test(String(x));
  const kinds = commits.map((c) => {
    if (!full(c.changedSince) || !full(c.startHead)) return null; // 缺字段上面已报
    if (c.startHead === c.changedSince) return 'pre';
    if (par(c.startHead) === c.changedSince) return 'post';
    out.push(`第 ${commits.indexOf(c) + 1} 份（${c.name}，${c.dir}）：这份留档自己就跨了不止一个提交——startHead ${c.startHead} 既不等于 changedSince ${c.changedSince}（提交前跑），也不是它的直接子提交（提交后补跑）；一份留档只许覆盖一个提交（疑似把一次跨多个提交的补跑当成了单份留档）`);
    return null;
  });
  if (out.length === 0 && kinds.every((k) => k !== null) && commits.length) {
    const seq = (gitOut(repo, ['rev-list', '--reverse', '--ancestry-path', since + '..HEAD']) || '').split(/\r?\n/).filter(Boolean);
    const merges = (gitOut(repo, ['rev-list', '--merges', since + '..HEAD']) || '').split(/\r?\n/).filter(Boolean);
    if (merges.length) out.push(`${since.slice(0, 12)}..HEAD 里有 ${merges.length} 个合并提交（${merges.slice(0, 3).map((x) => x.slice(0, 12)).join('、')}）：无法按线性提交序列逐个映射留档（C1 收口到 C9 之间要保持线性历史）`);
    else {
      const mapped = commits.map((c, i) => {
        if (kinds[i] === 'post') return c.startHead;
        if (c.startHead === since) return seq[0] || null;
        const k = seq.indexOf(c.startHead);
        return k >= 0 ? (seq[k + 1] || null) : undefined;
      });
      let first = null;
      for (let i = 0; i < commits.length && !first; i += 1) {
        if (mapped[i] === undefined || (mapped[i] !== null && !seq.includes(mapped[i]))) first = `第 ${i + 1} 份（${commits[i].name}，${commits[i].dir}）的 startHead ${commits[i].startHead} 不在 ${since.slice(0, 12)}..HEAD 的提交序列上`;
        else if (mapped[i] === null && !(kinds[i] === 'pre' && i === commits.length - 1)) first = `第 ${i + 1} 份（${commits[i].name}，${commits[i].dir}）对应不到任何提交（提交前跑的留档只有最后一份可以对应还没提交的工作区）`;
        else if (mapped[i] !== null && mapped.indexOf(mapped[i]) !== i) first = `提交 ${mapped[i].slice(0, 12)} 被第 ${mapped.indexOf(mapped[i]) + 1} 份与第 ${i + 1} 份留档重复对应（同一个提交的复验留档传了两次）`;
      }
      if (!first) {
        const cover = mapped.filter((x) => x !== null);
        const miss = seq.findIndex((x, k) => cover[k] !== x);
        if (miss >= 0) first = `提交 ${seq[miss].slice(0, 12)}（${since.slice(0, 12)}..HEAD 序列第 ${miss + 1} 个）没有对应的复验留档（缺份；该提交的自动命中与退役记录会漏算）`;
      }
      if (first) out.push(first);
      else commits.forEach((c, i) => { c.mappedCommit = mapped[i]; }); // 97 号 HIGH：链核对通过时把每份留档映射到的实际提交（null = 还没提交的工作区）交给 cumulativeGatePassProblems 核第 ③ 步通过凭据
    }
  }
  return out;
}
// --affected … --cumulative 的入口：读各份 --rerun-dir 的 rerun.json（和可选的 --effective）、读当前登记、打印累计范围。退出码 1 = 留档对不上 / 读不到登记。
function cumulativeAffected(o, b, ch) {
  const commits = [];
  const bad = [];
  let effUsed = 0; // 已消费的 --effective 份数：按留档顺序只给文件模式的留档消费一份，无清单模式（--effective-none）的留档跳过（95 号 MEDIUM）
  o.rerunDirs.forEach((dir) => {
    let rr = null;
    let rrBytes = null;
    try { rrBytes = fs.readFileSync(path.join(dir, 'rerun.json')); rr = JSON.parse(rrBytes.toString('utf8')); } catch (e) { bad.push(`${dir}：读不到 rerun.json 或不是 JSON（${e.message}）`); return; }
    if (!rr || rr.format !== RERUN_FORMAT || !rr.groups || typeof rr.groups !== 'object' || !rr.ranIds || typeof rr.ranIds !== 'object' || !Array.isArray(rr.retire) || !rr.effective || typeof rr.commit !== 'string') { bad.push(`${dir}：rerun.json 不是 ${RERUN_FORMAT} 格式（须带 format / commit / effective / retire / groups / ranIds；旧格式留档不能用于累计范围，不兼容旧格式）`); return; }
    if (rr.complete !== true) { bad.push(`${dir}：rerun.json 没有结束记录（complete 不是 true）：这份留档没写完`); return; }
    // 97 号 MEDIUM：结构校验与第 ③ 步共用（组键与计划组一致、编号列表是去重后的字符串数组、退出状态形态）；不合法 → 报这份留档并拒，不当空集合处理、不抛异常
    const spC9 = rerunStructureProblems(rr);
    if (spC9.length) { bad.push(`${dir}：rerun.json 结构不合法（${spC9.join('；')}）`); return; }
    // 97 预筛 M2：文件模式（非 none）的留档必须按顺序带 --effective（个数 = 文件模式留档数）——生效清单通常是被忽略 / 仓库外的输入，树指纹不覆盖它；漏带就无法识别「同一父提交下清单改过、前一轮留档」；none 模式不需要
    if (rr.effective.mode === 'file') {
      const f = o.effectiveAll[effUsed];
      effUsed += 1;
      if (f === undefined) { bad.push(`${dir}：这份留档是文件模式（有生效清单），但 --effective 已经用完了（给了 ${o.effectiveAll.length} 份）：缺少这份留档的清单。C9 必须为每份文件模式留档按顺序带 --effective；漏带时无法识别同一父提交下清单改过的前一轮（无清单模式的留档不占位）`); return; }
      let r = null;
      try { r = effList.readEffectiveFile(f); } catch (e) { bad.push(`${f}：${e.message}`); return; }
      if (rr.effective.sha256 !== r.sha256) { bad.push(`${path.basename(f)} 的 sha256 与 ${dir}/rerun.json 记的生效清单（${JSON.stringify(rr.effective)}）对不上：--effective 按留档顺序只对应文件模式的留档，必须是同一份`); return; }
    }
    commits.push({ name: rr.commit, dir, sha256: rr.effective.sha256 || null, mode: rr.effective.mode, retire: rr.retire, added: rr.added || [], groups: rr.groups, ranIds: rr.ranIds, outOfPlanIds: rr.outOfPlanIds || {}, results: rr.results || {}, emptyPlan: !!rr.emptyPlan, startHead: rr.context && rr.context.startHead ? rr.context.startHead : null, changedSince: typeof rr.changedSince === 'string' ? rr.changedSince : null, rerunSha256: sha256Of(rrBytes), effective: rr.effective, exclusions: rr.exclusions || (rr.context && rr.context.exclusions) || null });
  });
  if (!bad.length && effUsed < o.effectiveAll.length) bad.push(`--effective 多给了 ${o.effectiveAll.length - effUsed} 份（只有文件模式的留档各消费一份，共消费 ${effUsed} 份，给了 ${o.effectiveAll.length} 份）`);
  if (!bad.length) bad.push(...cumulativeChainProblems(o.repo, o.changedSince, commits));
  // 97 号 HIGH：链核对通过后，每份留档必须带第 ③ 步通过凭据，且凭据绑定的树指纹与映射到的实际提交（或末尾还没提交的暂存区）内容一致——只凭 startHead 映射会把同一父提交下较早一轮的留档认作最终提交的证据
  if (!bad.length) bad.push(...cumulativeGatePassProblems(o.repo, commits));
  if (bad.length) { for (const p of bad) console.error('留档不通过：' + p); return 1; }
  let regs;
  try { regs = loadRegistered(o.repo, ALL_GROUPS, o.registryFile); } catch (e) { console.error('读取变异登记失败：' + e.message); return 1; }
  const curKeys = new Set();
  for (const g of ALL_GROUPS) for (const x of regs[g]) curKeys.add(keyOf(x));
  const curEntries = ALL_GROUPS.flatMap((g) => regs[g]);
  const s = cumulativeScope({ baseEntries: b.entries, changed: ch, commits, currentKeys: curKeys, currentEntries: curEntries });
  // 97 号 MEDIUM：计划里有、日志里没有结果行的编号 = 这份留档不完整（第 ③ 步本会拒）——不再只打警告，报该留档并以非 0 退出，不输出可被当作完整的累计范围
  const incompleteC9 = [];
  s.perCommit.forEach((pc, i) => { if (pc.plannedNotRan.length) incompleteC9.push(`${commits[i].dir}（${commits[i].name}）：留档不完整——计划里有、日志里没有结果行的编号 ${pc.plannedNotRan.length} 个：${pc.plannedNotRan.slice(0, 8).map((x) => `[${x.group}] ${JSON.stringify(x.id)}`).join('、')}${pc.plannedNotRan.length > 8 ? ' …' : ''}（第 ③ 步对这类编号拒绝放行；这份留档对应的提交没有真的过闸门，或留档被改过）`); });
  if (incompleteC9.length) { for (const p of incompleteC9) console.error('留档不通过：' + p); return 1; }
  let unionTotal = 0;
  for (const [, v] of s.groups) unionTotal += v.union.length;
  const nNew = s.live.filter((x) => x.noBaselineLocation).length;
  console.log(`C9 累计范围（--cumulative；${o.changedSince}..HEAD + 工作区，改动文件 ${ch.size} 个）：净改动自动累计范围 ${s.aff.length} 条（基线 ∩ 当前登记加 C1 之后新增 / 复用的现行编号共 ${s.live.length} 条里算，其中新增 / 复用编号 ${nNew} 条按现行登记的目标文件算；其中需人工复核 ${s.aff.filter((x) => x.needReview).length} 条）；各提交留档的复验记录 ${commits.length} 份；各提交实际复验过的编号（实跑编号 ranIds）追到当前登记 ${s.hits.size} 个；并集 ${unionTotal} 条`);
  s.perCommit.forEach((pc, i) => {
    const c = commits[i];
    let n = 0;
    for (const [, ids] of pc.groups) n += ids.length;
    const exits = Object.entries(c.results).map(([g, r]) => `${g} 退出码 ${r.exitCode}${r.signal ? '，信号 ' + r.signal : ''}`).join('、');
    const nOut = Object.values(c.outOfPlanIds || {}).reduce((m, l) => m + (Array.isArray(l) ? l.length : 0), 0);
    console.log(`  提交 ${i + 1}/${commits.length} ${c.name}（复验目录 ${c.dir}；${c.mode === 'file' ? '生效清单 sha256 ' + c.sha256 : '--effective-none'}${c.startHead ? '；复验时 HEAD ' + c.startHead : ''}）：实跑编号 ${n} 个（其中计划外的整组实跑 ${nOut} 个）${c.emptyPlan ? '（空计划：没有要复验的编号）' : ''}；驱动${exits ? '：' + exits : '：无记录'}；retire ${c.retire.length} 条`);
    for (const r of c.results ? Object.values(c.results) : []) if (r && r.exitCode !== 0) console.log(`    警告：该提交有驱动退出码非 0（${r.command || ''}）`);
    for (const [g, ids] of pc.groups) {
      console.log(`    [${g}] ${ids.length} 个`);
      for (const x of ids) console.log(`      [${g}] ${JSON.stringify(x.id)} ← ${x.sources.join('、') || '(无来源记录)'}`);
    }
  });
  for (const [g, v] of s.groups) console.log(`  [${g}] 并集 ${v.union.length} 条：净改动自动累计范围 ${v.net.length}、各提交复验过并追到当前登记的 ${v.archive.length}`);
  for (const [k, srcs] of s.hits) { const i0 = k.indexOf('\u0000'); console.log(`  命中 [${k.slice(0, i0)}] ${JSON.stringify(k.slice(i0 + 1))}（当前登记里）：${srcs.join('、')}`); }
  for (const t of s.traced) {
    console.log(`  追溯 [${t.group}] ${JSON.stringify(t.id)}（${t.sources.join('、')}）：${t.branches.map((x) => (x.kind === 'final' ? `→ [${x.group}] ${JSON.stringify(x.id)}（仍在当前登记${x.note ? '；' + x.note : ''}）` : x.kind === 'dead' ? `→ 已无承接（${x.note}）` : `→ [${x.group}] ${JSON.stringify(x.id)}（${x.note}）`)).join('；')}`);
  }
  for (const w of s.reuse) console.log('  警告（编号复用）：' + w);
  const nUnknown = s.traced.reduce((n, t) => n + t.branches.filter((x) => x.kind === 'unknown').length, 0);
  const nDead = s.traced.reduce((n, t) => n + t.branches.filter((x) => x.kind === 'dead').length, 0);
  console.log(`  追溯小结：已无承接的分支 ${nDead} 条、留档不全的分支 ${nUnknown} 条、编号复用警告 ${s.reuse.length} 条；这三类都要人工核对。`);
  console.log('  用法：只有「各提交实际复验过的编号（含自动纳入的）」与「净改动自动累计范围」两边都没命中的需人工复核条目，才可按从未受影响处理；命中的，逐条核对各提交留档的三字段登记在最终代码上是否仍适用。');
  return 0;
}

// hooks（只给自检内部用，命令行入口永远不传）：{ registryFile, sRegistryFile, allowNoProvenance, noProvenance }，见 HOOK_FLAGS 处的说明。
async function main(argv, hooks) {
  let o;
  try { o = parseArgs(argv, hooks); } catch (e) { console.error('用法错误：' + e.message); return 2; }
  if (o.help) { console.log(HELP_TEXT); return 0; }
  if (o.selfTest) return selfTest();
  // 96 号 MEDIUM（主会话降级项）：正式闸门（第 ②③ 步与 --affected 带清单）核对运行的脚本位于 --repo 内；跨检出调用 → 用法错误（自检钩子 allowForeignTool 才放行）
  if ((o.rerun || o.requireReview || (o.affected && !o.cumulative && (o.effective !== null || o.effectiveNone !== null))) && !o.allowForeignTool) {
    const foreign = effList.foreignToolProblem(__dirname, o.repo);
    if (foreign) { console.error('用法错误：' + foreign); return 2; }
  }
  // 89 号 HIGH-1 位置门：复验目录（--raw-dir / --parse-only 的目录）在仓库里只许落在 tmp/ 下
  for (const [d, label] of [[o.rawDir, '--raw-dir'], [o.parseOnly, '--parse-only 的目录']]) { const bad = rawDirLocationProblem(o.repo, d, label); if (bad) { console.error('用法错误：' + bad); return 2; } }
  let baseline = null;
  let dispositions = [];
  let changedSet = null;
  let effRead = null; // 闸门下读到的生效清单（{ doc, sha256, bytes }）；--effective-none 时为 null
  let exclG = null; // 闸门下复验之后才允许生成 / 补写的产物排除名单（exclusionsOf）
  try {
    if (o.affected) {
      // --affected：只读基线，按 <since>..HEAD + 工作区改动列出受影响的需人工复核条目，并给出复验命令；不看日志、不跑驱动
      const b = readJson(o.affected, '--affected');
      if (!b || !Array.isArray(b.entries) || b.format !== FORMAT) throw new Error('--affected 须是本脚本生成的基线（format ' + FORMAT + '，含 entries 数组）');
      // 96 号 HIGH-1：累计查询（--cumulative）与不带清单的 --affected 保留任意祖先；带清单的 --affected 与 --rerun 同口径（<S> = HEAD 或 HEAD 的第一父提交）
      if (!o.cumulative && (o.effective !== null || o.effectiveNone !== null)) { effList.validateSinceCommit(o.repo, o.changedSince, undefined, { gate: true }); postCommitCleanCheck(o, null, [o.affected, o.effective]); }
      const ch = changedFilesSince(o.repo, o.changedSince, null, { gate: !o.cumulative && (o.effective !== null || o.effectiveNone !== null) });
      if (o.cumulative) return cumulativeAffected(o, b, ch);
      // R1 修复批（MED-1）：给了 --effective / --effective-none 就用 rerunPlan 按来源分开打印完整复验集合（与第 ② 步同口径；兜底按去掉 retire 之后的基线计算）；
      //   没给只列自动范围（整份基线，不含生效清单、不含新增变异）
      let effPlan = null;
      let effCtxA = null;
      if (o.effective !== null || o.effectiveNone !== null) {
        const effReadA = o.effective !== null ? effList.readEffectiveFile(o.effective) : null;
        let regsA;
        try { regsA = loadRegistered(o.repo, ALL_GROUPS, o.registryFile); } catch (e) { console.error('读取变异登记失败：' + e.message); return 1; }
        const keysA = new Set();
        for (const g of ALL_GROUPS) for (const x of regsA[g]) keysA.add(keyOf(x));
        let sregA;
        try { sregA = loadSRegistry(o, b.entries, ch); } catch (e) { console.error('读取 <S> 时登记失败：' + e.message); return 1; } // 94 号 HIGH-3 / 96 号 HIGH-3：读取器漂移硬门 + 旧版读取器核对
        if (sregA.problems.length) { for (const p of sregA.problems) console.error('拒绝：' + p); return 1; }
        if (sregA.note) console.log('登记读取器漂移（人工声明）：' + sregA.note);
        for (const l of sregA.printed) console.log(l);
        const sKeysA = sregA.keys;
        console.log(`<S> 时登记摘要：sha256 ${sregA.digest.sha256}；${sregA.digest.count} 条；来源 ${sregA.digest.source}`);
        const builtA = buildEffCtx(o, sKeysA, keysA, ch, effReadA);
        if (builtA.problems.length) { for (const p of builtA.problems) console.error('生效清单不通过：' + p); return 1; }
        effCtxA = builtA.ctx;
        effPlan = rerunPlan(b.entries, ch, effCtxA.mode === 'file' ? effCtxA.eff : null, keysA, sKeysA, ALL_GROUPS.flatMap((g) => regsA[g]));
      }
      const aff = effPlan ? effPlan.aff : affectedOf(b.entries, null, ch);
      const bg = {};
      for (const x of aff) bg[x.group] = (bg[x.group] || 0) + 1;
      console.log(`改动文件（${o.changedSince}..HEAD + 工作区）${ch.size} 个；受影响的条目 ${aff.length} 条（其中需人工复核 ${aff.filter((x) => x.needReview).length} 条）；按组 ${Object.keys(bg).sort().map((g) => g + ' ' + bg[g]).join('、') || '无'}`);
      const viaCount = { 文件交集: 0, 组测试侧改动: 0, 产品侧组级触发: 0, 兜底触发: 0 };
      for (const x of aff) for (const v of x.via) viaCount[v] += 1;
      if (aff.length) console.log(`  受影响来源：文件交集 ${viaCount['文件交集']} 条；组测试侧改动 ${viaCount['组测试侧改动']} 条；产品侧组级触发 ${viaCount['产品侧组级触发']} 条；兜底触发 ${viaCount['兜底触发']} 条（一条可兼有多种）`);
      for (const x of aff) console.log(`  受影响 [${x.group}] ${JSON.stringify(x.id)}：${x.needReview ? '需人工复核（' + x.reasons.map((r) => REVIEW_KINDS[r]).join('、') + '）' : '不需复核'}；${viaText(x)}`);
      if (effPlan) {
        const modeText = effCtxA.mode === 'file' ? `生效清单 commit ${effCtxA.eff.commit}（sha256 ${effCtxA.sha256}）` : `--effective-none ${JSON.stringify(effCtxA.reason)}`;
        if (effPlan.groups.size === 0) console.log(`复验集合（与 --rerun 同口径；${modeText}）：空——自动范围 ${aff.length} 条、生效清单必跑 0 个、新增变异 0 个；--rerun 将写空计划记录（empty-plan.json）`);
        else {
          console.log(`复验集合（与 --rerun 同口径；${modeText}；自动范围按「基线 ∩ 当前登记」再加 C1 之后新增的现行编号算——这些新增编号用登记里的目标文件参与文件交集）：${effPlan.groups.size} 组；自动范围 ${effPlan.aff.length} 条、复验编号合计 ${Array.from(effPlan.groups.values()).reduce((n, s) => n + s.runIds.length, 0)} 个（去重后）`);
          for (const [g, s] of effPlan.groups) {
            console.log(`  [${g}] ${s.runIds.length} 条（去重后）：自动范围 ${s.auto.length}、mustRun ${s.mustRun.length}、by ${s.by.length}、remount ${s.remount.length}、added ${s.added.length}`);
            for (const src of ['auto', 'mustRun', 'by', 'remount', 'added']) if (s[src].length) console.log(`    ${src}：${JSON.stringify(s[src])}`);
          }
        }
      } else console.log('未给 --effective / --effective-none：只列自动范围（整份基线，不含生效清单，也不含当前登记里新增的变异）；完整复验集合加 --effective <生效清单> 或 --effective-none "<理由>" 再列');
      const cmdList = effPlan ? Array.from(effPlan.groups.entries()).flatMap(([g, s]) => s.runIds.map((id) => ({ group: g, id }))) : aff;
      for (const l of affectedCommands(cmdList, o.affectedOut, o.repo)) console.log(l);
      if (cmdList.length) console.log('  复验由本工具执行（日志与 meta 都由它写，旧日志过不了闸门）：node wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js --rerun --raw-dir <新目录> --affected-from <基线 json> --changed-since ' + o.changedSince + ' --effective <生效清单 json>（没有生效清单：--effective-none "<理由>"）；复验集合 = 上面列的自动范围 ∪ 生效清单的 mustRun / by / remount 新编号 ∪ added（当前登记有、基线没有的全部编号）；之后用 --parse-only <该目录> --compare … --dispositions … --require-review-dispositions --changed-since ' + o.changedSince + ' --effective <同一份> 收口。');
      return 0;
    }
    if (o.rerun) {
      // --rerun：第 ② 步由本工具执行。复验集合 = 自动范围（受影响条目，retire 的除外）∪ 生效清单的 mustRun / by / remount 新编号：api 用 --mutation-ids 只跑这些编号，其余组整组跑；
      //   每组 meta.json 带起始 HEAD / 改动文件 sha256 / 生效清单 sha256 与按来源列出的并集等
      const b = readJson(o.affectedFrom, '--affected-from');
      if (!b || !Array.isArray(b.entries) || b.format !== FORMAT) throw new Error('--affected-from 须是本脚本生成的基线（format ' + FORMAT + '，含 entries 数组）');
      // 89 号 HIGH-1：复验之后才允许补写的产物（复验目录；--dispositions / --report 只声明路径、不读取）记进 meta；与源码 / 驱动 / 登记 / 基线 / 清单重叠的拒绝
      const exclR = exclusionsOf(o.repo, { rawDir: o.rawDir, dispositions: o.disposition, report: o.report });
      const exclRProblems = exclusionProblems(o.repo, exclR, [o.affectedFrom, o.effective]);
      if (exclRProblems.length) throw new Error('排除项不合规：' + exclRProblems.join('；'));
      effList.validateSinceCommit(o.repo, o.changedSince, undefined, { gate: true });
      postCommitCleanCheck(o, exclR, [o.affectedFrom, o.effective]); // 预筛 MED-1
      const ch = changedFilesSince(o.repo, o.changedSince, exclR, { gate: true });
      // R1：先读生效清单、对 <S> 时登记与当前登记过 schema 校验；不过就拒绝，不跑任何驱动
      const effRead = o.effective !== null ? effList.readEffectiveFile(o.effective) : null;
      let curRegs;
      try { curRegs = loadRegistered(o.repo, ALL_GROUPS, o.registryFile); } catch (e) { console.error('读取变异登记失败：' + e.message); return 1; }
      const curKeys = new Set();
      for (const g of ALL_GROUPS) for (const x of curRegs[g]) curKeys.add(keyOf(x));
      let sregR;
      try { sregR = loadSRegistry(o, b.entries, ch); } catch (e) { console.error('读取 <S> 时登记失败：' + e.message); return 1; } // 94 号 HIGH-3 / 96 号 HIGH-3：读取器漂移硬门 + 旧版读取器核对
      const guardR = sregR; // guardR.problems / note / drift
      if (guardR.problems.length) { for (const p of guardR.problems) console.error('拒绝复验：' + p); return 1; }
      if (guardR.note) console.log('登记读取器漂移（人工声明）：' + guardR.note);
      for (const l of sregR.printed) console.log(l);
      console.log(`<S> 时登记摘要（记进 meta / rerun.json / empty-plan.json，第 ③ 步核同一份）：sha256 ${sregR.digest.sha256}；${sregR.digest.count} 条；来源 ${sregR.digest.source}`);
      const sKeysR = sregR.keys;
      const built = buildEffCtx(o, sKeysR, curKeys, ch, effRead);
      if (built.problems.length) { for (const p of built.problems) console.error('拒绝复验：生效清单：' + p); return 1; }
      const effCtx = built.ctx;
      const plan = rerunPlan(b.entries, ch, effCtx.mode === 'file' ? effCtx.eff : null, curKeys, sKeysR, ALL_GROUPS.flatMap((g) => curRegs[g]));
      const aff = plan.aff;
      const reqCount = effCtx.mode === 'file' ? effCtx.eff.required.length : 0;
      const planTotal = Array.from(plan.groups.values()).reduce((n, s) => n + s.runIds.length, 0); // 范围预览 / 计数标签 / 第 ③ 步组内统计都从这一份复验计划取数（89 号 LOW）
      console.log(`改动文件（${o.changedSince}..HEAD + 工作区）${ch.size} 个；自动范围受影响的条目 ${aff.length} 条（其中需人工复核 ${aff.filter((x) => x.needReview).length} 条；基线 ∩ 当前登记，加上 C1 之后新增的现行编号）；${effCtx.mode === 'file' ? `生效清单 ${path.basename(o.effective)}（commit ${effCtx.eff.commit}，sha256 ${effCtx.sha256}）：mustRun ${effCtx.eff.mustRun.length} 条、retire ${effCtx.eff.retire.length} 条、必跑的 mustRun / by / remount / added 共 ${reqCount} 个编号${effCtx.eff.reason ? `；reason ${JSON.stringify(effCtx.eff.reason)}` : ''}` : `--effective-none：${JSON.stringify(effCtx.reason)}`}；复验编号合计 ${planTotal} 个（去重后）`);
      console.log(`提醒：第 ③ 步要求改动集里每个路径在暂存区与工作区内容一致，且与本步记录的内容一致——复验之后不要再改这些文件；提交前先 git add，再跑第 ③ 步。`);
      if (plan.groups.size === 0) {
        // R1 修复批（MED-2）：复验集合为空也写复验目录——rerun.json + 空计划记录 empty-plan.json（绑定 HEAD / 改动文件集合 sha256 / 生效清单 sha256 或 none 理由 / 起始时刻）；
        //   第 ③ 步看到这份记录时用当前 HEAD / 改动集 / 清单重算复验计划，确实为空且绑定字段一致才放行。没有任何记录的目录第 ③ 步仍直接拒绝。
        fs.mkdirSync(o.rawDir, { recursive: true });
        // 84 号 LOW-1：写空计划之前统一查目录里已有的复验记录——两份计划文件、任何组日志 / meta / api.ids.json（空计划记录与复验日志不能同目录，否则写成功之后第 ③ 步才拒）
        const existing = ['rerun.json', 'empty-plan.json', 'api.ids.json', ...ALL_GROUPS.flatMap((g) => [g + '.log', g + '.meta.json'])].filter((f) => fs.existsSync(path.join(o.rawDir, f)));
        if (existing.length) throw new Error('--raw-dir 里已有 ' + existing.join('、') + '（不覆盖；空计划记录不能与复验日志 / meta / 计划文件同目录，给一个新目录）');
        let ctx0;
        try { ctx0 = runContext(o.repo, o.changedSince, exclR, { attest: guardR.drift ? o.sRegistryAttest : null, sRegistry: sregR.digest }); } catch (e) { console.error('拒绝复验：' + e.message); return 1; }
        const rec0 = emptyPlanRecord(ctx0, effCtx);
        // 97 号 MEDIUM：两份文件都先写临时文件再 rename 替换（不留写到一半的记录）；第 ③ 步在空计划路径同样读并校验 rerun.json（emptyRerunJsonProblems）
        writeFileAtomic(path.join(o.rawDir, 'empty-plan.json'), JSON.stringify(rec0, null, 2) + '\n');
        writeFileAtomic(path.join(o.rawDir, 'rerun.json'), JSON.stringify(rerunRecord({ o, ctx: ctx0, effCtx, aff, plan, results: {}, emptyPlan: true, ran: {} }), null, 2) + '\n'); // 空计划：计划与实跑都是空集合（显式记录，不是缺字段）
        console.log(`没有要复验的编号（自动范围、生效清单必跑编号、当前登记里新增的变异都空）：已写空计划记录 ${path.join(o.rawDir, 'empty-plan.json')}（绑定 HEAD ${rec0.startHead}、改动文件集合 sha256 ${rec0.changedFilesSha256}）；第 ③ 步会按当前状态重算后放行`);
        return 0;
      }
      const idsByGroup = new Map();
      for (const [g, s] of plan.groups) idsByGroup.set(g, s.runIds);
      const rerunGroups = ALL_GROUPS.filter((g) => idsByGroup.has(g));
      fs.mkdirSync(o.rawDir, { recursive: true });
      for (const g of rerunGroups) if (fs.existsSync(path.join(o.rawDir, g + '.log'))) throw new Error('--raw-dir 里已有 ' + g + '.log（不覆盖；给一个新目录）');
      if (fs.existsSync(path.join(o.rawDir, 'empty-plan.json'))) throw new Error('--raw-dir 里已有 empty-plan.json（空计划记录与复验日志不能同目录；给一个新目录）');
      let ctx;
      try { ctx = runContext(o.repo, o.changedSince, exclR, { attest: guardR.drift ? o.sRegistryAttest : null, sRegistry: sregR.digest }); } catch (e) { console.error('拒绝复验：' + e.message); return 1; }
      const extraOf = (g) => {
        const args = [];
        if (g === 'api') { const f = path.join(o.rawDir, 'api.ids.json'); fs.writeFileSync(f, JSON.stringify(idsByGroup.get('api'), null, 2) + '\n'); args.push('--mutation-ids', f); }
        return { args, idsFile: g === 'api' ? path.join(o.rawDir, 'api.ids.json') : null, meta: { ...ctx, affectedIds: idsByGroup.get(g).length, effective: effMetaOf(effCtx, plan.groups.get(g)) } };
      };
      const results = {};
      const runOne = async (g) => {
        const sl = plan.groups.get(g);
        console.log(`[${new Date().toISOString()}] 开始 ${g}（复验集合 ${sl.runIds.length} 条：自动范围 ${sl.auto.length}、mustRun ${sl.mustRun.length}、by ${sl.by.length}、remount ${sl.remount.length}、added ${sl.added.length}，去重后${g === 'api' ? '；--mutation-ids 只跑这些编号' : '；整组跑'}）`);
        const meta = await runGroup(g, o.repo, o.rawDir, extraOf(g));
        results[g] = { exitCode: meta.exitCode, signal: meta.signal, seconds: meta.seconds, command: meta.command };
        console.log(`[${new Date().toISOString()}] 结束 ${g}：退出码 ${meta.exitCode}${meta.signal ? '，信号 ' + meta.signal : ''}${meta.error ? '，错误 ' + meta.error : ''}，${meta.seconds} 秒`);
      };
      const lanes = o.parallelBrowser && rerunGroups.includes('browser') ? [['browser'], rerunGroups.filter((g) => g !== 'browser')] : [rerunGroups];
      await Promise.all(lanes.map(async (lane) => { for (const g of lane) await runOne(g); }));
      // 89 号 MEDIUM：子集复验也绑定被忽略的运行输入——复验期间 .sdh-instance / 线库 / .env 键不许变（跑完再取一次摘要，与跑前比）
      const ignoredEnd = ignoredInputsState(o.repo);
      const ignoredMoved = JSON.stringify(ctx.ignoredInputs) !== JSON.stringify(ignoredEnd);
      if (ignoredMoved) console.log(`警告：复验期间被忽略的运行输入变了（.sdh-instance / 线库 / .env 键之一；跑前 ${JSON.stringify(ctx.ignoredInputs)}，跑后 ${JSON.stringify(ignoredEnd)}）：本次复验不可信，第 ③ 步会拒绝，须重跑`);
      // 95 号 HIGH-2：复验结束后按第 ③ 步同口径解析各组日志，把实际有结果行的仍登记编号写进 rerun.json（计划 plannedIds 与实跑 ranIds 分列，计划外的整组实跑编号另列 outOfPlanIds）
      const ranNow = ranIdsFromLogs(o.rawDir, rerunGroups, curRegs);
      const outOfPlan = rerunGroups.map((g) => ({ g, n: ranNow[g].filter((id) => !new Set(idsByGroup.get(g)).has(id)).length })).filter((x) => x.n > 0);
      if (outOfPlan.length) console.log(`实跑编号里有计划之外的（整组跑出的）：${outOfPlan.map((x) => x.g + ' ' + x.n + ' 个').join('、')}；已记进 rerun.json 的 outOfPlanIds（来源「整组实跑」）`);
      writeFileAtomic(path.join(o.rawDir, 'rerun.json'), JSON.stringify(rerunRecord({ o, ctx, effCtx, aff, plan, results, emptyPlan: false, ran: ranNow, ignoredInputsEnd: ignoredEnd }), null, 2) + '\n');
      const badRun = ignoredMoved || Object.values(results).some((r) => r.exitCode !== 0);
      console.log(`复验完成：${rerunGroups.length} 组；${badRun ? '有驱动退出码非 0（见上）' : '驱动退出码都是 0'}；下一步：--parse-only ${o.rawDir} --compare ${o.affectedFrom} --dispositions <DISP> --require-review-dispositions --changed-since ${o.changedSince} ${effCtx.mode === 'file' ? '--effective ' + o.effective : '--effective-none ' + JSON.stringify(effCtx.reason)}${guardR.drift && o.sRegistryAttest ? ' --s-registry-attest ' + JSON.stringify(o.sRegistryAttest) : ''}（<DISP> = 第 ② 步传的累计去向表 ${o.disposition}）`);
      return badRun ? 1 : 0;
    }
    if (o.compare) {
      baseline = readJson(o.compare, '--compare');
      if (!baseline || !Array.isArray(baseline.entries)) throw new Error('--compare 须是本脚本生成的基线（含 entries 数组）');
      if (baseline.format !== FORMAT) throw new Error('--compare 的基线格式是 ' + JSON.stringify(baseline.format) + '，本脚本只认 ' + FORMAT + '（没有 caseSite 的旧格式不能参与对比，须重新生成）');
      if (o.disposition) {
        dispositions = readJson(o.disposition, '--disposition');
        if (!Array.isArray(dispositions) || dispositions.some((x) => !x || typeof x.group !== 'string' || typeof x.id !== 'string')) throw new Error('--disposition 须为 [{ group, id, 去向 }] 数组');
      }
      if (o.requireReview) {
        // 复验之后才允许生成 / 补写的产物（复验目录、去向表登记 json、--report）不计入改动集（exclusionsOf：头注释「复验之后改动集的核对」）
        exclG = exclusionsOf(o.repo, { rawDir: o.parseOnly || o.rawDir, dispositions: o.disposition, report: o.report });
        // 89 号 HIGH-1：第 ③ 步只认第 ② 步记录的排除项；当次新增的、与源码 / 驱动 / 登记 / 基线 / 清单重叠的一律拒绝（用法错误）
        const exProblems = [...exclusionProblems(o.repo, exclG, [o.compare, o.effective]), ...exclusionsSubsetProblems(exclG, readRecordedExclusions(o.parseOnly || o.rawDir))];
        if (exProblems.length) throw new Error('排除项不合规：' + exProblems.join('；'));
        effList.validateSinceCommit(o.repo, o.changedSince, undefined, { gate: true });
        postCommitCleanCheck(o, exclG, [o.compare, o.effective]); // 预筛 MED-1
        changedSet = changedFilesSince(o.repo, o.changedSince, exclG, { gate: true }); // 96 号 HIGH-1：<S> = HEAD（提交前）或 HEAD 的第一父提交（提交后补跑）
        if (o.effective !== null) effRead = effList.readEffectiveFile(o.effective);
      }
    }
  } catch (e) { console.error('用法错误：' + e.message); return 2; }
  // L7：不带 --raw-dir 跑驱动时，原始日志写 <仓库>/tmp/c1c/raw-<YYYYMMDDHHmmss>/，不覆盖已有目录；--parse-only 的目录就是原始日志目录。
  const pad2 = (n) => String(n).padStart(2, '0');
  const nowD = new Date();
  const stamp = `${nowD.getFullYear()}${pad2(nowD.getMonth() + 1)}${pad2(nowD.getDate())}${pad2(nowD.getHours())}${pad2(nowD.getMinutes())}${pad2(nowD.getSeconds())}`;
  const rawDir = o.parseOnly || o.rawDir || path.join(o.repo, 'tmp', 'c1c', 'raw-' + stamp);
  if (!o.parseOnly && !o.rawDir && fs.existsSync(rawDir)) { console.error('用法错误：默认原始日志目录已存在（不覆盖）：' + rawDir); return 2; }
  // 闸门下 --parse-only 不给 --groups：比较范围 = 目录里有 <组>.log 的组（api 子集复验只有 api.log）
  // R1 预筛复看 LOW-1：目录里有 empty-plan.json（--rerun 在复验集合为空时写的空计划记录）时不能再给 --groups——空计划没有任何 <组>.log，给了 --groups 只会得到「没有 <组>.log」这类误导的报错
  if (o.requireReview && o.parseOnly && o.groupsGiven && fs.existsSync(path.join(rawDir, 'empty-plan.json'))) { console.error('用法错误：' + rawDir + ' 里有 empty-plan.json（--rerun 在复验集合为空时写的空计划记录），第 ③ 步不能与 --groups 同用：空计划没有 <组>.log，比较范围由记录与当前状态重算'); return 2; }
  if (o.requireReview && o.parseOnly && !o.groupsGiven) {
    o.groups = ALL_GROUPS.filter((g) => fs.existsSync(path.join(rawDir, g + '.log')));
    // 目录里没有任何 <组>.log：没有复验记录，闸门直接拒绝（用法错误，退出码 2；R1 裁定：不放宽这道硬门）。
    //   唯一例外（MED-2）：目录里有 --rerun 在复验集合为空时写的 empty-plan.json——下面的闸门会按当前状态重算计划，确实为空且绑定一致才放行
    if (o.groups.length === 0 && !fs.existsSync(path.join(rawDir, 'empty-plan.json'))) { console.error('用法错误：' + rawDir + ' 里没有任何 <组>.log'); return 2; }
  }
  if (o.diffRuns) {
    // --diff-runs <第二次的 raw-dir>：与 --parse-only / --raw-dir 给的第一次对比，列出两次不一致的字段原文
    const d = diffRuns(rawDir, o.diffRuns, o.groups);
    console.log(`两次运行对比：${d.total} 条里完全一致 ${d.same} 条；原文不同但套归一规则后相同 ${d.rawOnly} 条；有差异 ${d.diffs.length} 条（含只有抛出位置不同的）`);
    for (const x of d.diffs) console.log(`  [${x.group}] ${JSON.stringify(x.id)} ${x.kind}\n    第一次：${JSON.stringify(x.a)}\n    第二次：${JSON.stringify(x.b)}`);
    return d.diffs.some((x) => x.kind !== '只有抛出位置不同') ? 1 : 0;
  }
  const outFile = o.out; // L7：不带 --out 不写基线（只在 stdout 报结果）
  let registered;
  let regAll = null;
  try {
    if (o.requireReview) {
      // 闸门：生效清单要对「当前登记的全部变异」核（<S> 时登记里消失的编号与 retire 全等、by / remount 新编号已登记），所以十组登记都读一遍，再取本次比较的各组
      regAll = loadRegistered(o.repo, ALL_GROUPS, o.registryFile);
      registered = {};
      for (const g of o.groups) registered[g] = regAll[g];
    } else registered = loadRegistered(o.repo, o.groups, o.registryFile);
  } catch (e) { console.error('读取变异登记失败：' + e.message); return 1; }
  // R1：闸门下的生效清单上下文与复验计划（--compare 不带 --parse-only 时也在跑驱动之前就算好，清单不过 schema 校验就不跑）
  let effCtx = null;
  let effProblems = [];
  let plan = null;
  let curKeys = null;
  let sKeysG = null;
  let sregG = null;
  let guardG = { problems: [], note: null, drift: false };
  if (o.requireReview) {
    curKeys = new Set();
    for (const g of ALL_GROUPS) for (const x of regAll[g]) curKeys.add(keyOf(x));
    try { sregG = loadSRegistry(o, baseline.entries, changedSet); } catch (e) { console.error('读取 <S> 时登记失败：' + e.message); return 1; }
    guardG = { problems: sregG.problems, note: sregG.note, drift: sregG.drift }; // 94 号 HIGH-3：读取器漂移硬门（第 ③ 步同口径；人工声明须与第 ② 步记录一致，见 runInputsProblems）
    // 96 号 HIGH-3：读取器漂移且没有人工声明时没有 <S> 时登记可核（不读）——直接按闸门不通过结束，不拿别的登记继续
    if (!sregG.keys) { for (const p of sregG.problems) console.log('  闸门不通过：读取器漂移：' + p); console.log('结果：有不通过项'); return 1; }
    sKeysG = sregG.keys;
    for (const l of sregG.printed) console.log(l);
    console.log(`<S> 时登记摘要：sha256 ${sregG.digest.sha256}；${sregG.digest.count} 条；来源 ${sregG.digest.source}（与第 ② 步记录的摘要核对）`);
    const built = buildEffCtx(o, sKeysG, curKeys, changedSet, effRead);
    effCtx = built.ctx;
    effProblems = built.problems;
    plan = rerunPlan(baseline.entries, changedSet, effCtx && effCtx.mode === 'file' ? effCtx.eff : null, curKeys, sKeysG, ALL_GROUPS.flatMap((g) => regAll[g]));
    if (!o.parseOnly && effProblems.length) { for (const p of effProblems) console.error('拒绝：生效清单：' + p); return 1; }
  }
  const started = Date.now();
  // HIGH-2：写基线时同时写来源清单；产品源码有未提交改动 → 跑之前就拒绝（不浪费一小时），跑完再取一次快照核对
  const wantProvenance = !!outFile && !baseline && !o.noProvenance;
  let pre = null;
  let post = null;
  if (wantProvenance) {
    try { pre = snapshotInputs(o.repo); } catch (e) { console.error('拒绝生成：取来源快照失败：' + e.message); return 1; }
    const early = snapshotProblems(pre, '跑之前');
    if (early.length) { for (const p of early) console.error('拒绝生成：' + p); return 1; }
  }
  if (!o.parseOnly) {
    fs.mkdirSync(rawDir, { recursive: true });
    let runCtx;
    try { runCtx = runContext(o.repo, o.requireReview ? o.changedSince : null, exclG, o.requireReview ? { attest: guardG.drift ? o.sRegistryAttest : null, sRegistry: sregG.digest } : undefined); } catch (e) { console.error('拒绝：' + e.message); return 1; } // H1：meta 带起始 HEAD / 工作区 /（闸门下）改动文件 sha256
    const runOne = async (g) => {
      console.log(`[${new Date().toISOString()}] 开始 ${g}：${['node', ...commandOf(g, o.repo).map((a) => (path.isAbsolute(a) ? path.relative(o.repo, a).replace(/\\/g, '/') : a))].join(' ')}`);
      const meta = await runGroup(g, o.repo, rawDir, { meta: o.requireReview ? { ...runCtx, effective: effMetaOf(effCtx, (plan.groups.get(g)) || { auto: [], mustRun: [], by: [], remount: [], added: [], runIds: [] }) } : runCtx });
      console.log(`[${new Date().toISOString()}] 结束 ${g}：退出码 ${meta.exitCode}${meta.signal ? '，信号 ' + meta.signal : ''}${meta.error ? '，错误 ' + meta.error : ''}，${meta.seconds} 秒`);
    };
    // --parallel-browser：浏览器组单独一路、其余各组按顺序一路，两路同时跑（单进程、同一个 raw-dir、同一份运行前后快照；不带时全部顺序跑）
    const lanes = o.parallelBrowser && o.groups.includes('browser') ? [['browser'], o.groups.filter((g) => g !== 'browser')] : [o.groups];
    await Promise.all(lanes.map(async (lane) => { for (const g of lane) await runOne(g); }));
    if (wantProvenance) {
      try { post = snapshotInputs(o.repo); } catch (e) { console.error('拒绝生成：跑完后取来源快照失败：' + e.message); return 1; }
      post.headMovePaths = headMovePaths(o.repo, pre.product.head, post.product.head);
    }
  }
  const data = {};
  // 闸门：比较范围 = 日志里实际有记录的变异（api 过滤子集 / 其余各组按组全跑）；对账只对范围内的登记项（日志没截断由「驱动收尾行」兜），范围外的受影响条目下面单独判不通过
  const scopeKeys = new Set();
  if (o.requireReview) {
    for (const g of o.groups) {
      const t = readGroupText(rawDir, g).text;
      const ids = new Set(parseRaw(t).records.filter((r) => r.group === g).map((r) => r.id));
      registered[g] = registered[g].filter((r) => ids.has(r.id));
      for (const id of ids) scopeKeys.add(g + '\u0000' + id);
    }
  }
  for (const g of o.groups) data[g] = { registered: registered[g], ...readGroupText(rawDir, g) };
  const a = assemble(data, o.groups, { repo: o.repo });
  let bad = false;
  let gateRec = null; // 第 ③ 步（--parse-only + 闸门）通过时写 gate-pass.json 所需（97 号 HIGH）
  for (const g of o.groups) {
    const s = a.groups[g];
    const exitBad = s.meta && s.meta.exitCode !== 0; // L6：驱动退出码非 0 也不通过（没有 meta 的 --parse-only 目录不查）
    if (exitBad) bad = true;
    console.log(`组 ${g.padEnd(11)} total ${String(s.total).padStart(4)}；判红 ${s.red}；未判红 ${s.weak}；异常 ${s.abnormal}；锚点失败 ${s.anchor}；缺记录 ${s.missing}；site 行读不到 ${s.siteUnreadable}；驱动${s.finished ? '跑完' : '没有打印收尾行（中止或没跑）'}${s.meta ? '；退出码 ' + s.meta.exitCode + (s.meta.signal ? '，信号 ' + s.meta.signal : '') + (exitBad ? '（非 0，不通过）' : '') : '；没有 meta（退出码未核）'}`);
  }
  for (const rc of a.reconciles) {
    for (const id of rc.missing) { bad = true; console.log(`  对账：缺记录 [${rc.group}] ${JSON.stringify(id)}`); }
    for (const id of rc.extra) { bad = true; console.log(`  对账：多出的记录（清单里没有）[${rc.group}] ${JSON.stringify(id)}`); }
    for (const d of rc.duplicates) { bad = true; console.log(`  对账：重复记录 [${rc.group}] ${JSON.stringify(d.id)} ×${d.count}`); }
    for (const id of rc.dupRegistered) { bad = true; console.log(`  对账：登记里 id 重复（硬停机）[${rc.group}] ${JSON.stringify(id)}`); }
  }
  for (const b of a.bad) { bad = true; console.log(`  无法解析的 @@MUT 行 [${b.group}] ${b.line}`); }
  for (const g of a.unfinished) { bad = true; console.log(`  驱动没有打印收尾行 [${g}]：中止或没跑完，该组的记录不完整`); }
  const total = Object.values(a.groups).reduce((n, s) => n + s.total, 0);
  const sum = (k) => Object.values(a.groups).reduce((n, s) => n + s[k], 0);
  console.log(`合计 total ${total}；判红 ${sum('red')}；未判红 ${sum('weak')}；异常 ${sum('abnormal')}；锚点失败 ${sum('anchor')}；缺记录 ${sum('missing')}；site 行读不到 ${sum('siteUnreadable')}`);
  // 失败签名相同的组数（同一组里失败键完全相同的变异归一类，成员 ≥ 2 的类数 / 其中的变异数）：加 siteText 之前与之后各报一次，原文与归一后各报一次
  const sc = (site, norm) => signatureClasses(a.entries, { site, norm });
  const sig = (x) => `${x.classes} 类 / ${x.members} 条（共 ${x.distinct} 种签名）`;
  console.log(`失败签名相同的组数：原文无 siteText ${sig(sc(false, false))}；原文加 siteText ${sig(sc(true, false))}；归一无 siteText ${sig(sc(false, true))}；归一加 siteText ${sig(sc(true, true))}`);
  const ms0 = multiSiteKeys(a.entries, false);
  const ms1 = multiSiteKeys(a.entries, true);
  console.log(`首行（case / class / message / label）不能区分的失败里，key 对应多个 site 的组数：siteText 不含序号 ${ms0.length}；含序号 ${ms1.length}`);
  for (const x of ms1) console.log(`  含序号仍对应多个 site：[${x.key[0]}] ${JSON.stringify(x.key[1])} 行文本 ${JSON.stringify(x.key[5])}#${x.key[6]} → ${x.sites.join('、')}`);
  // HIGH-3：caseSite（用例体调用点）
  const csWith = caseSiteSplitKeys(a.entries, true);
  const csWithout = caseSiteSplitKeys(a.entries, false);
  console.log(`key 相同但 caseSite 不同的组数（含 caseSite 的完整键下出现不止一个 caseSite 文件:行，应为 0）：${csWith.length}；不含 caseSite 的旧键下被 caseSite 拆成多个的组数（新键比旧键多区分出来的）：${csWithout.length}`);
  for (const x of csWith) console.log(`  完整键下多个 caseSite：[${x.key[0]}] ${JSON.stringify(x.key[1])} → ${x.caseSites.join('、')}`);
  const cst = callSiteStats(a.entries);
  for (const g of o.groups) { const s = cst[g]; if (s) console.log(`  caseSite [${g.padEnd(11)}] 失败 ${String(s.failures).padStart(4)} 条；caseSite 为 null ${s.caseSiteNull}（GuardFail ${s.nullGuardFail}；无异常类的异常记录 ${s.nullNoClass}；其他 ${s.nullOther}）；栈里没有运行器帧 ${s.runnerNotSeen}；frames 为空 ${s.framesEmpty}`); }
  // 时间戳归一的运行日期：这批原始日志里最早的驱动起始时刻（有 meta 时），否则当次时刻
  const starts = o.groups.map((g) => a.groups[g].meta && a.groups[g].meta.startedAt).filter(Boolean).sort();
  const runAt = starts.length ? starts[0] : null;
  if (baseline) {
    const baseScoped = baseline.entries.filter((e) => o.groups.includes(e.group) && (!o.requireReview || scopeKeys.has(keyOf(e))));
    const cmp = compareBaselines(baseScoped, a.entries, dispositions.filter((x) => o.groups.includes(x.group)), { baseRef: new Date(baseline.runAt || baseline.generatedAt), curRef: runAt ? new Date(runAt) : new Date() });
    console.log(`对比：相同 ${cmp.same.length}（其中需人工复核 ${cmp.needReview.length}；守卫类无栈 ${cmp.guardNoStack.length}，不需复核）；变了且已登记 ${cmp.changed.length}；变了且没登记 ${cmp.unregistered.length}；去向表里没用上的登记 ${cmp.unusedDispositions.length}`);
    if (cmp.guardNoStack.length) {
      const gg = {};
      for (const x of cmp.guardNoStack) gg[x.group] = (gg[x.group] || 0) + 1;
      console.log(`  守卫类无栈（GuardFail，靠规则 + 文件 + 信息识别，不计入 caseSite 为 null）：${cmp.guardNoStack.length} 条；按组 ${Object.keys(gg).sort().map((g) => g + ' ' + gg[g]).join('、')}`);
    }
    if (cmp.needReview.length) {
      const handled = cmp.needReview.filter((x) => x['去向']).length;
      const byGroup = {};
      for (const x of cmp.needReview) byGroup[x.group] = (byGroup[x.group] || 0) + 1;
      console.log(`  需人工复核（判等键分不出来，不能自动判同；不算失败）：按类 ${Object.keys(REVIEW_KINDS).map((k) => REVIEW_KINDS[k] + ' ' + cmp.reviewCounts[k]).join('；')}（一条可属于多类）；按组 ${Object.keys(byGroup).sort().map((g) => g + ' ' + byGroup[g]).join('、')}；去向表里已登记处置 ${handled} / ${cmp.needReview.length}`);
      console.log('  提示：「需人工复核」只是提示，不改变退出码；是否在去向表里登记处置，由各提交按方案做（--disposition 里给 group / id / 去向，登记过的上面会带「已登记」）。每个提交走三步闸门（--require-review-dispositions，强制登记）；普通对比只用于 C9 全量对比。');
      for (const x of cmp.needReview) console.log(`  需复核 [${x.group}] ${JSON.stringify(x.id)}：${x.reasons.map((r) => REVIEW_KINDS[r]).join('、')}${x['去向'] ? ' → 已登记：' + x['去向'] : ''}`);
    }
    for (const x of cmp.changed) console.log(`  已登记 [${x.group}] ${JSON.stringify(x.id)} ${x.kind} → ${x.去向}`);
    for (const x of cmp.unregistered) console.log(`  未登记 [${x.group}] ${JSON.stringify(x.id)} ${x.kind}（${x.reason}）${typeof x.detail === 'string' ? ' ' + x.detail : ' ' + JSON.stringify(x.detail)}`);
    for (const x of cmp.unusedDispositions) console.log(`  去向表里的登记没对上任何变化 [${x.group}] ${JSON.stringify(x.id)}`);
    if (o.requireReview) {
      // 受影响子集登记闸门（codex 79 HIGH-2）：口径见「受影响子集登记闸门」一节
      // R1：自动范围按去掉 retire 之后的基线算（plan.live；没有生效清单时 = 整份基线，与改造前一致）；retire 的编号已不在登记里，没有复验记录是正常的
      // 89 号 LOW：范围内的受影响条目从复验计划 plan.live（基线 ∩ 当前登记 + C1 之后新增的现行编号）取数，与第 ② 步的复验计划 / 范围预览同一份——旧口径从固定基线条目出发，漏计已有结果的 C1 后新增编号
      const liveInScope = plan.live.filter((e) => scopeKeys.has(keyOf(e)));
      const affIn = affectedOf(liveInScope, a.entries, changedSet, { targetsFrom: plan.live });
      const affNoRerun = plan.aff.filter((x) => !scopeKeys.has(keyOf(x)));
      // 89 号 HIGH-2 / MEDIUM：当前改动集的内容指纹（工作区 + 暂存区）与被忽略的运行输入摘要，主流程现算一次，各组 meta / 空计划记录共用
      let curSnap;
      try { curSnap = changeSnapshot(o.repo, changedSet); } catch (e) { console.log('  闸门不通过：' + e.message); console.log('结果：有不通过项'); return 1; } // 95 号 MEDIUM：符号链接 / 子模块 → 明确报「不支持的文件类型」
      const nowRun = { ignored: ignoredInputsState(o.repo), attestNow: o.sRegistryAttest, drift: guardG.drift, sRegistry: sregG.digest };
      // 95 号 MEDIUM：非空复验（目录里有 <组>.log）的 rerun.json 结束记录必须可读、是本次运行写的、完整（含 ignoredInputsEnd）；缺失 / 不可读 / 不匹配 → 拒（旧版吞掉读取与解析错误，复验期间运行输入变了、之后又恢复时会漏判）
      const ranNow = o.groups.length ? ranIdsFromLogs(rawDir, o.groups, registered) : {};
      const rerunJsonProblems = o.groups.length ? rerunJsonEndProblems({ rawDir, groups: o.groups, data, since: o.changedSince, head: (gitOut(o.repo, ['rev-parse', 'HEAD']) || '').trim(), effCtx, ranNow }) : [];
      // 84 号 HIGH-1：生效清单必跑编号（mustRun / by / newId / added）里基线属于「需人工复核」的条目并入三字段登记目标——自动范围没命中它们也要登记
      const extraReview = effCtx && effCtx.mode === 'file' ? requiredReviewTargets(effCtx.eff.required, baseline.entries, a.entries) : [];
      // 95 号 MEDIUM（编号复用）：本提交新增的编号（当前登记 − <S> 时登记 = added ∪ remount 新编号）只接受「提交」= 本次的三字段行；其余编号以最近一次退役行为边界沿用历史行（reviewGate）
      const thisNew = new Set(Array.from(curKeys).filter((k) => !sKeysG.has(k)));
      const gate = reviewGate({ affected: affIn, cmp, cur: a.entries, dispositions, extraReview, thisNew, commit: effCtx && effCtx.mode === 'file' ? effCtx.eff.commit : null });
      const metas = {};
      const texts = {};
      for (const g of o.groups) { metas[g] = data[g].meta || null; texts[g] = data[g].text; }
      const metaProblems = rerunMetaProblems({ repo: o.repo, rawDir, since: o.changedSince, metas, curChanged: changedSet, baseEntries: baseline.entries, effCtx, currentKeys: curKeys, sKeys: sKeysG, excl: exclG, currentEntries: ALL_GROUPS.flatMap((g) => regAll[g]), curSnap, now: nowRun });
      const effGate = effCtx && effCtx.mode === 'file' ? effectiveGateProblems({ eff: effCtx.eff, metas, scopeKeys, cur: a.entries, texts, dispositions }) : [];
      // S1 裁定：全部复验编号（含自动范围、--effective-none 下的自动范围）都要合格结果
      const qualified = qualifiedResultProblems({ plan, eff: effCtx && effCtx.mode === 'file' ? effCtx.eff : null, cur: a.entries, texts });
      // MED-2：没有任何 <组>.log、只有空计划记录 → 重算计划，确实为空且绑定一致才放行；有日志的目录里不许同时有空计划记录
      const hasEmptyPlan = fs.existsSync(path.join(rawDir, 'empty-plan.json'));
      const emptyProblems = [];
      if (hasEmptyPlan && o.groups.length > 0) emptyProblems.push('空计划记录：目录里既有复验日志又有 empty-plan.json（复验集合为空时 --rerun 只写空计划记录；有日志说明不是同一次复验）');
      if (hasEmptyPlan && o.groups.length === 0) {
        if (effCtx) {
          emptyProblems.push(...emptyPlanProblems({ repo: o.repo, rawDir, since: o.changedSince, plan, effCtx, curChanged: changedSet, excl: exclG, curSnap, now: nowRun }));
          // 97 号 MEDIUM：空计划路径同样读并校验 rerun.json（存在、完整、与 empty-plan.json 同一轮、计划与实跑都为空）
          emptyProblems.push(...emptyRerunJsonProblems({ rawDir, since: o.changedSince, head: (gitOut(o.repo, ['rev-parse', 'HEAD']) || '').trim(), effCtx }));
        } else emptyProblems.push('空计划记录：生效清单没有通过校验，无法重算计划');
      }
      if (o.parseOnly) gateRec = { changedSet, effCtx, exclusions: exclG };
      const effLine = effCtx ? (effCtx.mode === 'file' ? `生效清单 commit ${effCtx.eff.commit}（sha256 ${effCtx.sha256}）：mustRun ${effCtx.eff.mustRun.length}、retire ${effCtx.eff.retire.length}（stop-only ${effCtx.eff.retire.filter((r) => r.category === 'stop-only').length} / remount ${effCtx.eff.retire.filter((r) => r.category === 'remount').length} / equivalent ${effCtx.eff.retire.filter((r) => r.category === 'equivalent').length}）、必跑编号 ${effCtx.eff.required.length}${effCtx.eff.reason ? `；reason ${JSON.stringify(effCtx.eff.reason)}` : ''}` : `--effective-none：${JSON.stringify(effCtx.reason)}`) : '生效清单没有通过校验（见下）';
      console.log('生效清单（R1）：' + effLine);
      if (guardG.note) console.log('登记读取器漂移（人工声明）：' + guardG.note);
      // 96 号 MEDIUM：累计去向表每一行都须有非空「提交」（第 ① 步同；两种清单模式共用）
      const tableProblems = effList.dispositionTableProblems(dispositions, { skipRetireRows: !!(effCtx && effCtx.mode === 'file') }).map((p) => '去向表：' + p);
      const gp = [...effProblems.map((p) => '生效清单：' + p), ...guardG.problems.map((p) => '读取器漂移：' + p), ...tableProblems, ...rerunJsonProblems, ...emptyProblems, ...metaProblems, ...effGate, ...qualified, ...affNoRerun.map((x) => `[${x.group}] ${JSON.stringify(x.id)}（受影响：${viaText(x)}）：本次原始日志里没有这条变异的复验记录`), ...gate.problems];
      // 95 号 LOW：受影响总数与缺项统一从第 ② 步的复验计划 plan.aff 取数；当次日志的失败位置把受影响范围扩大了的（affIn 里有、plan.aff 里没有的），另报「补充命中」
      const planAffKeys = new Set(plan.aff.map(keyOf));
      const supplement = affIn.filter((x) => !planAffKeys.has(keyOf(x)));
      const ag = {};
      for (const x of plan.aff.filter((x) => scopeKeys.has(keyOf(x)))) ag[x.group] = (ag[x.group] || 0) + 1;
      console.log(`受影响子集闸门：--changed-since ${o.changedSince}；改动文件（..HEAD + 工作区）${changedSet.size} 个；比较范围 ${scopeKeys.size} 条变异；受影响的条目 ${plan.aff.length} 条（其中需人工复核 ${plan.aff.filter((x) => x.needReview).length} 条；第 ② 步复验计划口径；范围内 ${plan.aff.length - affNoRerun.length}${plan.aff.length - affNoRerun.length ? '：' + Object.keys(ag).sort().map((g) => g + ' ' + ag[g]).join('、') : ''}；范围外没有复验记录 ${affNoRerun.length}）${supplement.length ? `；当次日志扩大了人工复核范围，补充命中 ${supplement.length} 条（需人工复核 ${supplement.filter((x) => x.needReview).length} 条，不在复验计划里：${supplement.slice(0, 5).map((x) => `[${x.group}] ${JSON.stringify(x.id)}`).join('、')}${supplement.length > 5 ? ' …' : ''}）` : ''}；要三字段登记的条目（需复核的受影响 + 变了 + 生效清单必跑里需复核的）${gate.targets.length} 条；闸门问题 ${gp.length} 条`);
      for (const x of affIn) console.log(`  受影响 [${x.group}] ${JSON.stringify(x.id)}：${x.needReview ? '需人工复核（' + x.reasons.map((r) => REVIEW_KINDS[r]).join('、') + '）' : '不需复核'}；${viaText(x)}`);
      for (const p of gp) console.log('  闸门不通过：' + p);
      if (hasEmptyPlan && o.groups.length === 0 && emptyProblems.length === 0) console.log('空计划记录：用当前 HEAD / 改动集 / 生效清单重算，复验集合确实为空，绑定字段全部一致（放行）');
      // 建议项：equivalent 的被删编号在基线里的失败与承接编号当次的失败并排打印（供人工核对，不改判定）
      if (effCtx && effCtx.mode === 'file') { const sbs = equivalentSideBySide(effCtx.eff, baseline.entries, a.entries); if (sbs.length) { console.log('承接对照（被删编号在基线里的失败 与 承接编号当次的失败；只供人工核对「等价业务错误」，不改判定）：'); for (const l of sbs) console.log(l); } }
      if (gp.length) bad = true;
    }
    if (o.report) fs.writeFileSync(o.report, JSON.stringify(cmp, null, 2) + '\n');
    if (!cmp.ok) bad = true;
    const pl = provenanceLink(baseline, o.compare, { allowNone: o.allowNoProvenance });
    console.log(`基线来源清单核对：${pl.text}`);
    if (pl.mode !== null) console.log(`基线来源清单 mode：${pl.mode}${pl.mode === 'parse-only' ? '（只解析已有原始日志生成：清单里的文件哈希与产品源码快照是取证时刻的，不是运行时的）' : '（运行前后各取一次快照）'}`);
    if (!pl.ok) bad = true;
  } else if (!outFile) {
    console.log('没有 --out：不写基线（只报上面的结果）');
  } else {
    // generatedAt = 生成本文件的时刻；runAt = 这批原始日志的驱动起始时刻（--parse-only 重新生成时与 generatedAt 不同；时间戳归一以 runAt 为准，没有 meta 时退回 generatedAt）
    let prov = null;
    // L3：完整键下出现「key 相同但 caseSite 不同」——判等键区分不开的两条失败——不许生成基线
    if (csWith.length) { bad = true; console.log(`  拒绝生成：key 相同但 caseSite 不同的组数为 ${csWith.length}（应为 0）：判等键区分不开这些失败，基线不能建立在这样的记录上（上面已列出）`); }
    if (wantProvenance) {
      const r = buildProvenance({ repo: o.repo, o, a, rawDir, data, pre, post });
      if (r.problems.length) { bad = true; for (const p of r.problems) console.log(`  来源清单：拒绝生成：${p}`); } else prov = r.doc;
    }
    if (bad) {
      console.log('不写基线：上面有不通过项（基线不能建立在没跑完 / 对不上账 / 来源不明的运行上）');
    } else {
      const doc = { format: FORMAT, generatedAt: new Date().toISOString(), runAt, headCommit: headCommit(o.repo), headCommitAtRunStart: pre ? pre.product.head : null, workingTreeDirty: workingTreeDirty(o.repo), mode: 'filtered', env: { node: process.version }, groups: {}, provenanceFile: null, provenanceSha256: null, entries: a.entries };
      for (const g of o.groups) { const s = a.groups[g]; doc.groups[g] = { total: s.total, red: s.red, weak: s.weak, abnormal: s.abnormal, anchor: s.anchor }; }
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      if (prov) {
        const provFile = o.provenance || (outFile.replace(/\.json$/, '') + '.provenance.json');
        const provText = JSON.stringify(prov, null, 2) + '\n';
        fs.mkdirSync(path.dirname(provFile), { recursive: true });
        fs.writeFileSync(provFile, provText);
        doc.provenanceFile = path.basename(provFile);
        doc.provenanceSha256 = sha256Of(Buffer.from(provText, 'utf8'));
        console.log(`来源清单已写入 ${provFile}（sha256 ${doc.provenanceSha256}；测试文件 ${prov.testFilesCount} 个；产品树 sysbuild ${prov.productTree.routesSysbuildTree} / public ${prov.productTree.publicTree}）`);
      }
      fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + '\n');
      console.log(`基线已写入 ${outFile}（${a.entries.length} 条；用时 ${Math.round((Date.now() - started) / 1000)} 秒）`);
    }
  }
  // 97 号 HIGH：第 ③ 步全部通过 → 在复验目录写通过凭据 gate-pass.json（待提交树指纹 + rerun.json 的 sha256 + <S> + 清单 sha256 / none 理由；先写临时文件再 rename）；C9 凭它核每份留档对应的提交内容
  if (!bad && gateRec && gateRec.effCtx) {
    try {
      const gpw = writeGatePass({ rawDir, repo: o.repo, since: o.changedSince, effCtx: gateRec.effCtx, changedSet: gateRec.changedSet, exclusions: gateRec.exclusions });
      console.log(`第 ③ 步通过凭据已写入 ${gpw.file}（树指纹 sha256 ${gpw.sha256}；改动集 ${gpw.count} 个路径；C9 靠它核这份留档对应的提交内容，提交时不要再改这些文件）`);
    } catch (e) { console.error('拒绝：写第 ③ 步通过凭据失败：' + e.message); return 1; }
  }
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
// 自检里起 node 子进程跑本脚本的统一入口（89 号 HIGH-3）：自检钩子（--registry-file / --s-registry-file / --allow-no-provenance / --no-provenance）不走命令行——
//   由这里把 args 里的这四项摘出来，改成「node -e 载入本脚本并调用 main(argv, hooks)」注入；没有钩子的调用原样走命令行。命令行入口本身永远收不到钩子（parseArgs 拒绝）。
const realSpawnSync = spawnSync; // 模块级的真 spawnSync（selfTest 里同名的局部 spawnSync 会遮住它）
const HOOK_RUNNER = 'const m=require(process.argv[1]);const h=JSON.parse(process.argv[2]);Promise.resolve(m.main(process.argv.slice(3),h)).then((c)=>{process.exitCode=c;},(e)=>{console.error(e&&e.stack);process.exitCode=1;});';
function selfSpawn(real, args, opts) {
  const rest = [];
  const hooks = {};
  let cleanCheck = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--registry-file') { hooks.registryFile = path.resolve(args[i + 1]); i += 1; } else if (a === '--s-registry-file') { hooks.sRegistryFile = path.resolve(args[i + 1]); i += 1; } else if (a === '--allow-no-provenance') hooks.allowNoProvenance = true;
    else if (a === '--no-provenance') hooks.noProvenance = true;
    else if (a === '--force-drift-guard') hooks.driftGuard = true; // 自检专用记号：不是真参数，只在这里被摘成钩子
    else if (a === '--force-clean-check') cleanCheck = true; // 自检专用记号：让钩子路径也核「提交后补跑要求工作区干净」（默认自检跳过，临时仓库里要造工作区改动）
    else rest.push(a);
  }
  // 自检用 --repo 指向临时仓库、脚本在主检出里跑 = 跨检出调用，正式闸门会拒（96 号 MEDIUM）；自检统一经钩子 allowForeignTool 放行（命令行没有这个参数）；专门测跨检出拒绝的用例直接用真 spawnSync
  if (rest.includes('--repo')) { hooks.allowForeignTool = true; if (!cleanCheck) hooks.skipCleanCheck = true; }
  // 预筛 LOW-3：--rerun 必须给 --dispositions；自检里没给的调用自动补一个仓库之外的占位路径（第 ② 步只声明路径、不读取）；专门测「必填」的用例直接用真 spawnSync
  if (rest.includes('--rerun') && !rest.includes('--dispositions') && !rest.includes('--disposition')) rest.push('--dispositions', path.join(os.tmpdir(), 'sysbuild-selftest-auto-disp.json'));
  if (Object.keys(hooks).length === 0) return real(process.execPath, [__filename, ...rest], opts);
  return real(process.execPath, ['-e', HOOK_RUNNER, __filename, JSON.stringify(hooks), ...rest], opts);
}
function selfTest() {
  // 自检内部的 spawnSync：「node + 本脚本」的调用经 selfSpawn（钩子注入），其余（git 等）原样
  const spawnSync = (cmd, args, opts) => (cmd === process.execPath && Array.isArray(args) && args[0] === __filename ? selfSpawn(realSpawnSync, args.slice(1), opts) : realSpawnSync(cmd, args, opts));
  let total = 0;
  let ok = 0;
  const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); };
  const F = (c, e, m, label) => ({ case: c, errorClass: e, message: m, site: null, label: label === undefined ? null : label });
  const mut = (group, id, verdict, failures, note) => rec.mutLine(group, id, verdict, failures, note);
  const R = (group, id) => ({ group, id, files: ['x.js'], expect: null });
  const reg = { api: [R('api', 'A1'), R('api', 'A2'), R('api', 'A3')], static: [R('static', 'S1')] };
  const finishApi = '变异自检：3/3 判红（挑选 3 / 共 3；过滤模式）';
  const finishStatic = '\n1/1 通过';
  const run = (apiLines, staticLines, regOverride) => assemble({
    api: { registered: (regOverride || reg).api, text: apiLines.join('\n') + '\n' + finishApi + '\n', meta: null },
    static: { registered: (regOverride || reg).static, text: staticLines.join('\n') + '\n' + finishStatic + '\n', meta: null },
  }, ['api', 'static']);
  const apiOk = [mut('api', 'A1', '判红', [F('用例甲', 'AssertionError', '期望 1')]), mut('api', 'A2', '判红', [F('用例乙', 'TypeError', 'x is not a function')]), mut('api', 'A3', '判红', [F('用例丙', 'AssertionError', '期望 3')])];
  const staticOk = [mut('static', 'S1', '判红', [F('S2', 'GuardFail', 'FAIL [S2] zz.js:3 x')])];

  const good = run(apiOk, staticOk);
  check(good.reconciles.every((r) => r.ok) && good.unfinished.length === 0 && good.groups.api.red === 3 && good.groups.static.total === 1 && good.entries.length === 4, '正例：每条已登记变异恰好一条记录、驱动打印了收尾行 → 对账通过，组汇总 total / red 正确');
  const miss = run(apiOk.slice(0, 2), staticOk);
  check(!miss.reconciles[0].ok && miss.reconciles[0].missing.length === 1 && miss.reconciles[0].missing[0] === 'A3' && miss.groups.api.missing === 1, '缺记录：少一条 → 列出缺的 id（A3）并对账不通过');
  const extra = run(apiOk.concat([mut('api', 'A9', '判红', [])]), staticOk);
  check(!extra.reconciles[0].ok && extra.reconciles[0].extra.length === 1 && extra.reconciles[0].extra[0] === 'A9', '多记录：清单里没有的 id → 列出并对账不通过');
  const dup = run(apiOk.concat([apiOk[0]]), staticOk);
  check(!dup.reconciles[0].ok && dup.reconciles[0].duplicates.length === 1 && dup.reconciles[0].duplicates[0].id === 'A1' && dup.reconciles[0].duplicates[0].count === 2, '重复记录：同一 id 两条 → 列出并对账不通过');
  const foreign = run(apiOk.concat([mut('static', 'S1', '判红', [])]), staticOk);
  check(!foreign.reconciles[0].ok && foreign.reconciles[0].extra[0] === 'static/S1', '串组：api 的日志里出现 static 的记录 → 当作多出的记录');
  const dupReg = run(apiOk, staticOk, { api: [R('api', 'A1'), R('api', 'A1'), R('api', 'A2'), R('api', 'A3')], static: reg.static });
  check(!dupReg.reconciles[0].ok && dupReg.reconciles[0].dupRegistered[0] === 'A1', '登记里 id 重复：硬停机（对账不通过）');
  const garbled = assemble({ api: { registered: reg.api, text: apiOk.join('\n') + '\n@@MUT {不是 json\n' + finishApi + '\n', meta: null }, static: { registered: reg.static, text: staticOk.join('\n') + finishStatic + '\n', meta: null } }, ['api', 'static']);
  check(garbled.bad.length === 1 && garbled.bad[0].group === 'api', '坏行：@@MUT 行解析不了 → 单列（调用方判不通过）');
  const noFinish = assemble({ api: { registered: reg.api, text: apiOk.join('\n') + '\n', meta: null }, static: { registered: reg.static, text: staticOk.join('\n') + finishStatic + '\n', meta: null } }, ['api', 'static']);
  check(noFinish.unfinished.length === 1 && noFinish.unfinished[0] === 'api', '中止：驱动没有打印收尾行（如浏览器驱动一条异常即中止）→ 该组标为没跑完');
  const kinds = assemble({ api: { registered: reg.api, text: [mut('api', 'A1', '未判红', []), mut('api', 'A2', '异常', [{ case: null, errorClass: null, message: '被信号终止' }]), mut('api', 'A3', '锚点失败', [], 'x')].join('\n') + '\n' + finishApi + '\n', meta: null }, static: { registered: reg.static, text: staticOk.join('\n') + finishStatic + '\n', meta: null } }, ['api', 'static']);
  check(kinds.groups.api.weak === 1 && kinds.groups.api.abnormal === 1 && kinds.groups.api.anchor === 1 && kinds.groups.api.red === 0, '汇总：未判红 / 异常 / 锚点失败各自计数');

  // 对比
  const base = good.entries;
  const sameCmp = compareBaselines(base, good.entries, []);
  check(sameCmp.ok && sameCmp.same.length === 4 && sameCmp.changed.length === 0 && sameCmp.unregistered.length === 0, '对比：完全相同 → 4 条都是「相同」');
  const verdictChanged = run([mut('api', 'A1', '未判红', []), apiOk[1], apiOk[2]], staticOk);
  const c1 = compareBaselines(base, verdictChanged.entries, []);
  check(!c1.ok && c1.unregistered.length === 1 && c1.unregistered[0].kind === '判定变化' && c1.unregistered[0].detail === '判红 → 未判红', '对比：判定变化且没登记 → 未登记（退出码 1）');
  const movedFailure = run([mut('api', 'A1', '判红', [F('搭数据用例', 'TypeError', 'cannot read property of undefined')]), apiOk[1], apiOk[2]], staticOk);
  const c2 = compareBaselines(base, movedFailure.entries, []);
  check(!c2.ok && c2.unregistered.length === 1 && c2.unregistered[0].kind === '失败位置变化' && c2.unregistered[0].detail.基线独有.length === 1 && c2.unregistered[0].detail.现在独有.length === 1, '对比：失败位置变化（失败的用例 / 错误类 / 信息都变了）且没登记 → 未登记，并列出两侧独有的失败');
  const c3 = compareBaselines(base, movedFailure.entries, [{ group: 'api', id: 'A1', 去向: '改挂到 xx 用例，C5 审过' }]);
  check(c3.ok && c3.changed.length === 1 && c3.changed[0].去向.startsWith('改挂') && c3.unregistered.length === 0, '对比：失败位置变化但去向表里登记过 → 「变了且已登记」，不算失败');
  const emptyDisp = compareBaselines(base, movedFailure.entries, [{ group: 'api', id: 'A1', 去向: '  ' }]);
  check(!emptyDisp.ok && emptyDisp.unregistered[0].reason === '去向为空', '对比：去向写成空白 → 仍按未登记');
  const siteOnly = run([mut('api', 'A1', '判红', [{ ...F('用例甲', 'AssertionError', '期望 1'), site: 'wbs-server/scripts/lib/x.js:999' }]), apiOk[1], apiOk[2]], staticOk);
  const c4 = compareBaselines(base, siteOnly.entries, []);
  check(c4.ok && c4.same.length === 4, '对比：只有抛出位置（行号）变了 → 不参与判等，仍算相同');
  const reordered = run([mut('api', 'A1', '判红', [F('用例甲', 'AssertionError', '期望 1'), F('用例甲2', 'Error', 'e2')]), apiOk[1], apiOk[2]], staticOk);
  const reorderedBase = run([mut('api', 'A1', '判红', [F('用例甲2', 'Error', 'e2'), F('用例甲', 'AssertionError', '期望 1')]), apiOk[1], apiOk[2]], staticOk);
  check(compareBaselines(reorderedBase.entries, reordered.entries, []).ok, '对比：同一条变异的失败列表顺序不同 → 按多重集比较，仍算相同');
  const gone = compareBaselines(base, base.slice(1), []);
  check(!gone.ok && gone.unregistered[0].kind === '基线有现在没有', '对比：基线有现在没有 → 未登记即失败');
  const added = compareBaselines(base.slice(1), base, []);
  check(!added.ok && added.unregistered[0].kind === '现在有基线没有', '对比：现在有基线没有 → 未登记即失败');
  const noFailures = base.map((e) => ({ ...e, failures: [] })); // 没有失败 = 没有需复核的条目：登记给它的去向才是「没用上」（登记给需复核条目的在下面的「需人工复核」段验）
  const unused = compareBaselines(noFailures, noFailures, [{ group: 'api', id: 'A1', 去向: '没用上' }]);
  check(unused.ok && unused.unusedDispositions.length === 1 && unused.needReview.length === 0, '对比：去向表里登记了、但那条变异没变（也不需复核）→ 单列「没用上」');
  // MED-3 / 71 号 HIGH-3 后半句：判等键分不出来的三类，判「相同」但单列「需人工复核」
  {
    const site = 'wbs-server/scripts/lib/h.js:5';
    const cs = 'wbs-server/scripts/lib/p.js:9';
    const FF = (over) => ({ case: 'c', errorClass: 'E', message: 'm', label: null, site, siteText: 'assert.strictEqual(a, 1);', siteOrd: 1, caseSite: cs, caseSiteText: 'await act();', caseSiteOrd: 1, frames: [site, cs, 'wbs-server/scripts/lib/s.js:99'], runnerSeen: true, ...over });
    const EE = (id, failures) => ({ group: 'api', id, files: [], expect: null, verdict: '判红', failures });
    const ents = [
      EE('clean', [FF()]),
      EE('multi', [FF({ siteText: 'assert.ok(a); assert.ok(b);' })]),
      EE('caller', [FF({ frames: [site, 'wbs-server/scripts/lib/p.js:7', 'wbs-server/scripts/lib/s.js:99'] })]),
      EE('nullcs', [FF({ caseSite: null, caseSiteText: null, caseSiteOrd: null, frames: [site] })]),
      EE('selfsite', [FF({ caseSite: site, caseSiteText: undefined, caseSiteOrd: undefined, frames: [site, 'wbs-server/scripts/lib/r.js:1'] })]),
      EE('multi-and-caller', [FF({ siteText: 'assert.ok(a); assert.ok(b);', frames: [site, 'wbs-server/scripts/lib/p.js:7'] })]),
      { ...EE('guard', [FF({ errorClass: 'GuardFail', site: null, siteText: null, siteOrd: null, caseSite: null, caseSiteText: null, caseSiteOrd: null, frames: [], runnerSeen: null })]), group: 'static' },
    ];
    const rv = compareBaselines(ents, ents, []);
    const reasonsOf = (id) => (rv.needReview.find((x) => x.id === id) || {}).reasons;
    check(rv.ok && rv.same.length === 7 && rv.changed.length === 0 && rv.unregistered.length === 0, '需人工复核：判等键相同 → 仍在 same 里、不算失败（ok）');
    check(JSON.stringify(rv.needReview.map((x) => x.id)) === JSON.stringify(['multi', 'caller', 'nullcs', 'multi-and-caller']) && JSON.stringify(reasonsOf('multi')) === '["multiAssert"]' && JSON.stringify(reasonsOf('caller')) === '["callerNotCaseSite"]' && JSON.stringify(reasonsOf('nullcs')) === '["caseSiteNull"]' && JSON.stringify(reasonsOf('multi-and-caller')) === '["callerNotCaseSite","multiAssert"]', '需人工复核：同一抛出行多个断言 / frames[1] ≠ caseSite / caseSite 为 null 各自单列；对照组（干净的、caseSite 与抛出行同一行的）不进清单');
    check(rv.reviewCounts.multiAssert === 2 && rv.reviewCounts.callerNotCaseSite === 2 && rv.reviewCounts.caseSiteNull === 1, '需人工复核：按类计数（一条可属于多类）');
    check(JSON.stringify(rv.guardNoStack) === '[{"group":"static","id":"guard"}]' && !rv.needReview.some((x) => x.id === 'guard') && reviewReasons([FF({ errorClass: 'GuardFail', caseSite: null })], 'deploy').join() === 'guardNoStack' && reviewReasons([FF({ errorClass: 'GuardFail', caseSite: null })], 'api').join() === 'caseSiteNull' && reviewReasons([FF({ errorClass: 'E', caseSite: null, frames: [site] })], 'static').join() === 'caseSiteNull','guardNoStack：守卫类失败（GuardFail、无栈、caseSite 为 null）单列计数，不算 caseSiteNull、不进需人工复核；非守卫类的 caseSite 为 null 仍是 caseSiteNull');
    const rvd = compareBaselines(ents, ents, [{ group: 'api', id: 'multi', 去向: '已逐条复核：assert 次序没变' }, { group: 'api', id: 'clean', 去向: '没用上' }]);
    check(rvd.ok && rvd.needReview.find((x) => x.id === 'multi')['去向'] === '已逐条复核：assert 次序没变' && rvd.needReview.filter((x) => x['去向']).length === 1 && rvd.unusedDispositions.length === 1 && rvd.unusedDispositions[0].id === 'clean', '需人工复核：去向表里登记过处置的条目带「去向」且不算「没用上」；登记给干净条目的仍单列「没用上」');
    const rvMoved = compareBaselines(ents, ents.map((e) => (e.id === 'multi' ? { ...e, failures: [FF({ siteText: 'assert.ok(a); assert.ok(b);', message: '换了' })] } : e)), []);
    check(!rvMoved.ok && rvMoved.unregistered.length === 1 && rvMoved.needReview.every((x) => x.id !== 'multi'), '需人工复核：真有变化的条目走「变了」分支，不进复核清单');
  }
  // codex 79 HIGH-2：受影响子集登记闸门（纯函数部分；整条 CLI 在后面的命令行段）
  {
    const H = 'wbs-server/scripts/lib/h.js';
    const MID = 'wbs-server/scripts/lib/mid.js';
    const PBODY = 'wbs-server/scripts/lib/p.js';
    const GF = (over) => ({ case: '用例甲', errorClass: 'AssertionError', message: '状态码应为 409，实际 200', label: null, site: H + ':5', siteText: 'assert.strictEqual(a, 1);', siteOrd: 1, caseSite: PBODY + ':9', caseSiteText: 'await act();', caseSiteOrd: 1, frames: [H + ':5', MID + ':3', PBODY + ':9'], runnerSeen: true, ...over });
    const GE = (id, files, failures, extra) => ({ group: 'api', id, files, expect: null, verdict: '判红', failures, ...(extra || {}) });
    const T1 = GE('T1', ['wbs-server/routes/sysbuild/rules.js'], [GF()]);
    const T2 = GE('T2', ['wbs-server/routes/sysbuild/other.js'], [GF()]);
    const GUARD = GE('GUARD', ['wbs-server/routes/sysbuild/rules.js'], [GF({ errorClass: 'GuardFail', site: null, siteText: null, siteOrd: null, caseSite: null, caseSiteText: null, caseSiteOrd: null, frames: [], runnerSeen: null })], { group: 'static' });
    const CLEAN = GE('CLEAN', ['wbs-server/routes/sysbuild/rules.js'], [GF({ frames: [H + ':5', PBODY + ':9'] })]);
    const base = [T1, T2, GUARD, CLEAN];
    const ids = (x) => x.map((y) => y.id).join();
    const aTarget = affectedOf(base, base, new Set(['wbs-server/routes/sysbuild/rules.js']));
    check(ids(aTarget) === 'T1,GUARD,CLEAN' && aTarget.map((x) => x.needReview).join() === 'true,false,false' && JSON.stringify(aTarget[0].hitFiles) === '["wbs-server/routes/sysbuild/rules.js"]', '受影响判定（H2）：变异目标文件（rules.js）改了 → 目标文件相同的全部条目受影响——需复核的 T1、守卫类 GUARD、不需复核的 CLEAN；needReview 只有 T1 为 true（只决定要不要三字段登记）');
    const aHelper = affectedOf(base, base, new Set([MID]));
    check(ids(aHelper) === 'T1,T2' && aHelper.every((x) => x.hitFiles.join() === MID), '受影响判定：只有助手文件（mid.js）改了，它不是任何变异的目标文件、只出现在失败栈帧里 → 靠 frames 命中，T1、T2 都受影响');
    const aCase = affectedOf(base, base, new Set([PBODY]));
    check(ids(aCase) === 'T1,T2,CLEAN', '受影响判定：失败用例体所在文件（caseSite 的文件）改了 → 受影响（含不需复核的 CLEAN）');
    check(affectedOf(base, base, new Set(['docs/unrelated.md', 'wbs-server/scripts/lib/zzz-unrelated.js'])).length === 0, '受影响判定：无关文件改了 → 没有受影响条目');
    // 当前运行一侧的栈帧也算（基线一侧没有、当前一侧才经过的文件）
    const curMoved = [GE('T2', T2.files, [GF({ frames: [H + ':5', 'wbs-server/scripts/lib/newhelper.js:2', PBODY + ':9'] })])];
    check(ids(affectedOf([T2], curMoved, new Set(['wbs-server/scripts/lib/newhelper.js']))) === 'T2', '受影响判定：基线一侧与当前运行一侧的失败记录取并集（当前一侧新经过的助手文件也算）');
    // 保守规则：组测试侧文件改动 → 该组全部需人工复核条目（不含守卫类）受影响；共用件 → 所有组；产品文件只走文件交集
    const TB = GE('TB', ['wbs-server/routes/sysbuild/other.js'], [GF()], { group: 'browser' });
    const base2 = [...base, TB];
    const aSuite = affectedOf(base2, base2, new Set(['wbs-server/scripts/lib/sysbuild-api-suite-plan.js']));
    check(ids(aSuite) === 'T1,T2,CLEAN' && aSuite.every((x) => x.via.join() === '组测试侧改动' && x.hitFiles.length === 0 && x.testSideFiles.join() === 'wbs-server/scripts/lib/sysbuild-api-suite-plan.js'), '保守规则：api 套件文件（lib/sysbuild-api-suite-plan.js）改了 → api 组全部条目（T1、T2、CLEAN）受影响，标「组测试侧改动」；browser、static 组的不算');
    const aBrowserDrv = affectedOf(base2, base2, new Set(['wbs-server/scripts/verify-sysbuild-browser.js']));
    const aBrowserStage = affectedOf(base2, base2, new Set(['wbs-server/scripts/lib/sysbuild-browser-stage8.js']));
    check(ids(aBrowserDrv) === 'TB' && ids(aBrowserStage) === 'TB' && affectedOf(base2, base2, new Set(['wbs-server/scripts/verify-sysbuild-db.js'])).length === 0, '保守规则：browser 驱动 / lib/sysbuild-browser-*.js 改了 → 只有 browser 组受影响；别组的驱动（db）改了，这几条不受影响');
    const aShared = affectedOf(base2, base2, new Set(['wbs-server/scripts/lib/test-env.js']));
    check(ids(aShared) === 'T1,T2,GUARD,CLEAN,TB' && aShared.every((x) => x.via.join() === '组测试侧改动'), '保守规则：共用件（lib/test-env.js）改了 → 所有组的全部条目都受影响（含守卫类、不需复核的）');
    const sharedAll = ['wbs-server/scripts/lib/test-instance.js', 'wbs-server/scripts/_test-fixture.js', 'wbs-server/scripts/lib/sysbuild-mut-record.js', 'wbs-server/scripts/lib/listen-safe-port.js', 'scripts/lines/line-proc.js', 'scripts/lines/line-common.js', 'scripts/lines/line-new.js', 'scripts/lines/state.js'];
    check(sharedAll.every((s) => ids(affectedOf(base2, base2, new Set([s]))) === 'T1,T2,GUARD,CLEAN,TB'), 'M1 保守规则：共用件（test-instance / _test-fixture / sysbuild-mut-record / listen-safe-port / scripts/lines 的 line-proc、line-common、line-new、state）改了 → 所有组受影响');
    const aProduct = affectedOf(base2, base2, new Set(['wbs-server/routes/sysbuild/rules.js']));
    check(ids(aProduct) === 'T1,GUARD,CLEAN' && aProduct.every((x) => x.via.join() === '文件交集' && x.testSideFiles.length === 0 && x.productFiles.length === 0 && x.fallbackFiles.length === 0), '保守规则：只改有变异以它为目标的产品文件（routes/sysbuild/rules.js）→ 只走文件交集（守卫类同样按文件交集算），不触发组测试侧、产品侧组级触发、兜底');
    // MED-2：产品侧组级触发与兜底
    const PE = (g, id) => GE(id, ['wbs-server/routes/sysbuild/rules.js'], [GF()], { group: g });
    const prodBase = ['api', 'browser', 'db', 'attachments', 'schema', 'static', 'migration', 'deploy'].map((g) => PE(g, 'P-' + g));
    const pids = (changed) => ids(affectedOf(prodBase, prodBase, new Set(changed)));
    check(pids(['wbs-server/routes/sysbuild/index.js']) === 'P-api,P-browser,P-db,P-attachments,P-schema', 'MED-2：只改 routes/sysbuild/index.js（没有任何变异以它为目标）→ api、browser、db、attachments、schema 整组受影响；static 与 predeploy 各组不受影响');
    check(['wbs-server/routes/sysbuild/db.js', 'wbs-server/routes/sysbuild/schema.js', 'wbs-server/routes/sysbuild/migration-schema.js', 'wbs-server/server.js', 'wbs-server/utils/aes-password.js'].every((f) => pids([f]) === 'P-api,P-browser,P-db,P-attachments,P-schema'), 'MED-2：db.js / schema.js / migration-schema.js / server.js / wbs-server/utils/** 任一改动 → 同样五组整组受影响');
    const idxHit = affectedOf(prodBase, prodBase, new Set(['wbs-server/routes/sysbuild/index.js']));
    check(idxHit.length === 5 && idxHit.every((x) => x.via.join() === '产品侧组级触发' && x.productFiles.join() === 'wbs-server/routes/sysbuild/index.js' && x.fallbackFiles.length === 0) && /产品侧组级触发：wbs-server\/routes\/sysbuild\/index\.js/.test(viaText(idxHit[0])), 'MED-2：来源标「产品侧组级触发」（index.js 在触发名单里，不走兜底）');
    const fbPub = affectedOf(prodBase, prodBase, new Set(['wbs-server/public/assets/js/zero-target.js']));
    check(ids(fbPub) === 'P-api,P-browser' && fbPub.length === 2 && fbPub.every((x) => x.via.join() === '兜底触发' && x.fallbackFiles.join() === 'wbs-server/public/assets/js/zero-target.js') && /兜底触发：/.test(viaText(fbPub[0])), 'MED-2 兜底：改一个没有任何变异以它为目标、也不在任何触发名单的 public 文件 → 不得「无需复验」，按 api + browser 整组受影响，标「兜底触发」');
    check(ids(affectedOf(prodBase, prodBase, new Set(['wbs-server/routes/sysbuild/newmod.js']))) === 'P-api,P-browser', 'MED-2 兜底：routes/sysbuild 下新文件（没有变异以它为目标）同样兜底');
    const tgtPub = [GE('PT', ['wbs-server/public/assets/js/has-target.js'], [GF()])];
    check(affectedOf(tgtPub, tgtPub, new Set(['wbs-server/public/assets/js/has-target.js'])).every((x) => x.via.join() === '文件交集' && x.fallbackFiles.length === 0) && affectedOf(prodBase, prodBase, new Set(['docs/x.md'])).length === 0, 'MED-2：有变异以它为目标的 public 文件只走文件交集（不兜底）；routes / public 以外的无关文件不触发');
    const subBase = [prodBase[0]]; // 闸门里 base 只是日志范围内的子集：「有没有变异以它为目标」要按完整基线算
    check(affectedOf(subBase, subBase, new Set(['wbs-server/routes/sysbuild/other-target.js']), { targetsFrom: [...prodBase, GE('OT', ['wbs-server/routes/sysbuild/other-target.js'], [GF()])] }).length === 0 && affectedOf(subBase, subBase, new Set(['wbs-server/routes/sysbuild/other-target.js'])).length === 1, 'MED-2：targetsFrom 给完整基线时，别的变异以它为目标的文件不兜底；不给时按传入的 base 算');
    const aBoth = affectedOf(base2, base2, new Set(['wbs-server/routes/sysbuild/rules.js', 'wbs-server/scripts/lib/sysbuild-api-suite.js']));
    check(ids(aBoth) === 'T1,T2,GUARD,CLEAN' && aBoth.find((x) => x.id === 'T1').via.join() === '文件交集,组测试侧改动' && aBoth.find((x) => x.id === 'T2').via.join() === '组测试侧改动' && aBoth.find((x) => x.id === 'GUARD').via.join() === '文件交集' && /文件交集：.*；组测试侧改动：/.test(viaText(aBoth[0])), '保守规则：目标文件与套件文件都改了 → T1、CLEAN 两种来源兼有、T2 只有组测试侧、GUARD（static 组）只有文件交集；viaText 把两种分开写');
    check(Object.keys(GROUP_TEST_SIDE).sort().join() === ALL_GROUPS.slice().sort().join() && SHARED_TEST_SIDE.length === 9, '保守规则：组测试侧名单覆盖十组，共用件恰是九个');
    // M1：predeploy 四组驱动直接加载的被测文件是组级触发
    const PD = (g, id) => GE(id, ['scripts/sysbuild-predeploy/x.cjs'], [GF()], { group: g });
    const pdBase = [PD('migration', 'PM'), PD('archive', 'PA'), PD('readonly', 'PR'), PD('deploy', 'PD')];
    const pdHit = (f) => ids(affectedOf(pdBase, pdBase, new Set([f])));
    check(pdHit('scripts/sysbuild-predeploy/schema-migration-core.cjs') === 'PM,PR' && pdHit('scripts/sysbuild-predeploy/cli.cjs') === 'PM,PR' && pdHit('scripts/sysbuild-predeploy/deploy-prestart.cjs') === 'PM' && pdHit('scripts/sysbuild-predeploy/archive-core.cjs') === 'PM,PA,PR' && pdHit('scripts/sysbuild-predeploy/archive-fs.cjs') === 'PM,PA,PR' && pdHit('scripts/sysbuild-predeploy/temp-service/server.cjs') === 'PR' && pdHit('scripts/deploy-ssh.ps1') === 'PD', 'M1：predeploy 四组驱动直接加载的被测文件（schema-migration-core / cli / deploy-prestart / archive-core / archive-fs / temp-service / deploy-ssh.ps1）改了 → 加载它的组全部条目受影响');
    // M1：名单与驱动加载链逐项核对（本仓库）；多 / 少都报
    const cons = testSideConsistency(DEFAULT_REPO);
    const consBad = Object.entries(cons.groups).filter(([, v]) => v.missing.length || v.extra.length).map(([g, v]) => g + ' 少 ' + v.missing.join(',') + ' 多 ' + v.extra.join(','));
    check(consBad.length === 0 && cons.sharedNotLoadedByAnyGroup.length === 0, 'M1：测试侧名单与各组驱动的静态 require 链逐项一致（本仓库）' + (consBad.length ? '：' + consBad.join('；') : '') + (cons.sharedNotLoadedByAnyGroup.length ? '；共用件没被任何组加载：' + cons.sharedNotLoadedByAnyGroup.join(',') : ''));
    {
      const T = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-chain-'));
      const wrT = (rel, t) => { const f = path.join(T, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
      wrT('wbs-server/scripts/verify-sysbuild-api.js', "require('./lib/a-suite');\nconst x = 'lib/not-a-require.js'; // 只是字符串，不算加载\n");
      wrT('wbs-server/scripts/lib/a-suite.js', "const h = require('./helper');\nrequire(path.join(__dirname, 'data', 'cfg.json'));\n");
      wrT('wbs-server/scripts/lib/helper.js', '// h\n');
      wrT('wbs-server/scripts/lib/data/cfg.json', '{}\n');
      wrT('wbs-server/scripts/lib/not-a-require.js', '// n\n');
      wrT('wbs-server/scripts/lib/extra.js', '// 名单里有、链里没有\n');
      wrT('wbs-server/scripts/lib/orphan-shared.js', '// 共用件，没有任何组加载\n');
      try {
        const chain = Array.from(requireChain(T, ['wbs-server/scripts/verify-sysbuild-api.js'])).sort();
        check(JSON.stringify(chain) === JSON.stringify(['wbs-server/scripts/lib/a-suite.js', 'wbs-server/scripts/lib/data/cfg.json', 'wbs-server/scripts/lib/helper.js', 'wbs-server/scripts/verify-sysbuild-api.js']), 'M1 requireChain：只跟 require(…) / path.join(__dirname, …) 里的本地文件（无扩展名要探测；不跟随字符串字面量里提到的文件名）');
        const lists = { shared: ['wbs-server/scripts/lib/orphan-shared.js'], groups: { api: ['wbs-server/scripts/verify-sysbuild-api.js', 'wbs-server/scripts/lib/a-suite.js', 'wbs-server/scripts/lib/data/cfg.json', 'wbs-server/scripts/lib/extra.js'] } };
        const bad = testSideConsistency(T, lists);
        check(JSON.stringify(bad.groups.api.missing) === '["wbs-server/scripts/lib/helper.js"]' && JSON.stringify(bad.groups.api.extra) === '["wbs-server/scripts/lib/extra.js"]' && JSON.stringify(bad.sharedNotLoadedByAnyGroup) === '["wbs-server/scripts/lib/orphan-shared.js"]', 'M1：加载链里有、名单没有（helper.js）报「少」；名单里有、链里没有（extra.js）报「多」；共用件没被任何组加载（orphan-shared.js）报「多」');
      } finally { try { removeTree(T); } catch (e) { console.error('  [清理] ' + T + ' ' + e.message); } }
    }
    const LOCK = '（await act();#1）';
    const D = (id, over) => ({ group: 'api', id, 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 2/2 全绿', 变异后命中证据: '用例甲：状态码应为 409，实际 200' + LOCK, ...(over || {}) });
    const gateOf = (curEntries, disps, changedSet) => { const cmp = compareBaselines(base, curEntries, disps); return reviewGate({ affected: affectedOf(base, curEntries, changedSet), cmp, cur: curEntries, dispositions: disps }); };
    const ch1 = new Set(['wbs-server/routes/sysbuild/rules.js']);
    const gOk = gateOf(base, [D('T1')], ch1);
    check(gOk.problems.length === 0 && gOk.targets.length === 1, '闸门：受影响条目登记齐全（三字段非空）、命中证据含失败用例名与信息首行 → 通过');
    const gNone = gateOf(base, [], ch1);
    check(gNone.problems.length === 1 && gNone.problems[0].includes('"T1"') && gNone.problems[0].includes('去向表里没有登记'), '闸门：受影响且需复核的条目（T1）在去向表里没有登记 → 不通过；同样受影响但不需复核的（GUARD、CLEAN）不要求三字段登记');
    const gMiss = gateOf(base, [D('T1', { 业务步骤: '  ', 变异后命中证据: undefined })], ch1);
    check(gMiss.problems.length === 1 && /登记缺字段 业务步骤 \/ 变异后命中证据/.test(gMiss.problems[0]), '闸门：三字段缺任一（空白 / 缺失）→ 列出缺的字段名，不通过');
    const gMiss2 = gateOf(base, [D('T1', { 未变异通过证据: '' })], ch1);
    check(gMiss2.problems.length === 1 && /登记缺字段 未变异通过证据/.test(gMiss2.problems[0]), '闸门：缺「未变异通过证据」→ 不通过');
    const gWrong = gateOf(base, [D('T1', { 变异后命中证据: '随便写一句话' })], ch1);
    check(gWrong.problems.length === 1 && /命中证据对不上当前运行里的失败/.test(gWrong.problems[0]), '闸门：命中证据对不上当前运行里的失败用例名与信息首行 → 不通过');
    const gWrongMsg = gateOf(base, [D('T1', { 变异后命中证据: '用例甲：别的信息' })], ch1);
    check(gWrongMsg.problems.length === 1 && /命中证据对不上/.test(gWrongMsg.problems[0]), '闸门：只对上用例名、信息首行对不上 → 不通过');
    // 装载异常 / 夹具失败不得充当命中证据（「变了」的条目：当前运行里失败变成了装载异常）
    const loadFail = (over) => [GE('T1', T1.files, [{ case: '用例甲', errorClass: null, message: '被测模块加载失败（不计为用例失败）: Cannot find module x', site: null, frames: [], caseSite: null, runnerSeen: null, label: null, ...(over || {}) }], { verdict: '异常' })];
    const gLoad = gateOf(loadFail(), [D('T1', { 变异后命中证据: '用例甲：被测模块加载失败（不计为用例失败）: Cannot find module x', 去向: '改挂' })], ch1);
    check(gLoad.problems.some((p) => /没有可作命中证据的失败/.test(p)), '闸门：失败是装载异常（errorClass 为空、判定「异常」）→ 即使证据文字抄了它的用例名与信息也不通过');
    // 预筛 HIGH（自伤）：判装载异常只看结构化字段，不套 message / label 文字正则——「夹具：」前缀的业务断言、「schema 加载失败」业务守卫不被误拒
    const redFixture = [GE('T1', T1.files, [GF({ label: '夹具失败：搭数据', message: '夹具：建项失败' })])];
    const gFix = gateOf(redFixture, [D('T1', { 变异后命中证据: '用例甲：夹具：建项失败' + LOCK, 去向: '改挂' })], ch1);
    check(!gFix.problems.some((p) => /没有可作命中证据的失败/.test(p)) && !isLoadOrFixtureFailure(GF({ message: '夹具：建项失败' })) && !isLoadOrFixtureFailure(GF({ label: '夹具失败：搭数据' })) && !isLoadOrFixtureFailure({ case: 'schema 加载失败', errorClass: 'GuardFail', message: 'FAIL [S3] schema 加载失败', label: null }) && !isLoadOrFixtureFailure(GF({ errorClass: 'Error', message: '业务断言里提到 Cannot find module 字样' })) && !isLoadOrFixtureFailure({ case: 'c', errorClass: 'GuardFail', message: 'Cannot find module 守卫说明', label: null }), '闸门（预筛 HIGH）：message / label 里带「夹具」「加载失败」字样、或只是中间提到 Cannot find module、但 errorClass 与 case 正常的失败（业务断言 / GuardFail）不被当装载异常，可作命中证据；工具层不一刀切，是否真是搭数据阶段失败由逐用例人工核');
    // 锚定规则：errorClass 不是 GuardFail 且 message 以 Cannot find module 开头或含 MODULE_NOT_FOUND → 装载异常
    check(isLoadOrFixtureFailure(GF({ errorClass: 'Error', message: "Cannot find module '../routes/sysbuild/x'\nRequire stack:" })) && isLoadOrFixtureFailure(GF({ errorClass: 'Error', message: "加载被测脚本失败 code: 'MODULE_NOT_FOUND'" })) && !isLoadOrFixtureFailure(GF({ errorClass: 'GuardFail', message: "Cannot find module '守卫里的字样'" })) && !isLoadOrFixtureFailure(GF({ errorClass: 'AssertionError', message: '状态码应为 409，实际 200' })), '装载异常锚定规则：errorClass 非 GuardFail 且 message 以「Cannot find module」开头 / 含 MODULE_NOT_FOUND → 装载异常；GuardFail 同样的字样不判；普通业务断言不判');
    const syntaxFail = [GE('T1', T1.files, [GF({ errorClass: 'SyntaxError', message: 'Unexpected token' })])];
    check(gateOf(syntaxFail, [D('T1', { 变异后命中证据: '用例甲：Unexpected token', 去向: '改挂' })], ch1).problems.some((p) => /没有可作命中证据的失败/.test(p)), '闸门：SyntaxError 也算装载异常，不能当命中证据');
    // 「变了」的条目本来就要登记；闸门下还要三字段与命中证据
    const movedMsg = [GE('T1', T1.files, [GF({ message: '状态码应为 403，实际 200' })])];
    const gChanged = gateOf(movedMsg, [{ group: 'api', id: 'T1', 去向: '改挂到 xx 用例' }], new Set(['docs/none.md']));
    check(gChanged.targets.length === 1 && /变了/.test(gChanged.targets[0].why) && /登记缺字段 业务步骤 \/ 未变异通过证据 \/ 变异后命中证据/.test(gChanged.problems.join()), '闸门：「变了」且已登记的条目（没有文件交集）也要三字段，缺则不通过');
    const gChangedOk = gateOf(movedMsg, [D('T1', { 去向: '改挂', 变异后命中证据: '用例甲：状态码应为 403，实际 200' + LOCK })], new Set(['docs/none.md']));
    check(gChangedOk.problems.length === 0, '闸门：「变了」的条目三字段齐全、命中证据对上当前失败 → 通过');
    const removed = compareBaselines(base, base.filter((e) => e.id !== 'T1'), [{ group: 'api', id: 'T1', 去向: '变异随旧流程删除' }]);
    check(reviewGate({ affected: [], cmp: removed, cur: base.filter((e) => e.id !== 'T1'), dispositions: [{ group: 'api', id: 'T1', 去向: '变异随旧流程删除' }] }).problems.length === 0, '闸门：基线有、现在没有（变异已删除）只要去向，不要求命中证据');
    check(evidenceMatches('用例甲：状态码应为 409，实际 200' + LOCK, GF(), 'api') && !evidenceMatches('用例乙：状态码应为 409，实际 200' + LOCK, GF(), 'api') && isLoadOrFixtureFailure({ case: 'c', errorClass: null, message: 'm' }) && !isLoadOrFixtureFailure(GF()), 'evidenceMatches / isLoadOrFixtureFailure：基本判定');
    // M2：命中证据还要写失败的位置键 caseSiteText#ord 或 siteText#ord，并核与当前失败一致
    check(!evidenceMatches('用例甲：状态码应为 409，实际 200', GF(), 'api') && evidenceMatches('用例甲：状态码应为 409，实际 200 assert.strictEqual(a, 1);#1', GF(), 'api') && !evidenceMatches('用例甲：状态码应为 409，实际 200 await act();#2', GF(), 'api') && evidenceMatches('用例甲：状态码应为 409，实际 200', GF({ site: null, siteText: null, siteOrd: null, caseSite: null, caseSiteText: null, caseSiteOrd: null }), 'api'), 'M2 evidenceMatches：没写位置键 → 不匹配；写抛出行 siteText#ord 也行；序号不对（#2）→ 不匹配；失败没有位置（守卫类）时不要求位置键');
    const gNoLoc = gateOf(base, [D('T1', { 变异后命中证据: '用例甲：状态码应为 409，实际 200' })], ch1);
    check(gNoLoc.problems.length === 1 && /位置键/.test(gNoLoc.problems[0]), 'M2 闸门：命中证据只有用例名与信息、没有 caseSiteText#ord / siteText#ord → 不通过，并提示应写的位置键');
  }

  // 归一规则：每条带一个例子；规则表为空时这一组也要过（逐条验证 + 空表不改写）
  const exCtx = (r) => ({ group: r.example.group || 'api', ref: r.example.ref ? new Date(r.example.ref) : null });
  for (const r of NORMALIZERS) check(normalizeMessage(r.example.in, exCtx(r)) === r.example.out, `归一规则 [${r.name}]：${JSON.stringify(r.example.in)} → ${JSON.stringify(r.example.out)}`);
  check(normalizeMessage('普通信息 1 != 2', { group: 'api', ref: null }) === '普通信息 1 != 2', '归一：不含规则命中内容的信息原样不变');
  // L3：时间戳只在运行日期前后一天内归一；夹具写死的日期不动；没有运行日期（null）时全部归一
  const refD = new Date('2026-11-19T12:00:00');
  check(normalizeMessage('a 2026-11-18 23:59:59 b 2026-11-20 00:00:01 c 2026-11-21 10:00 d 2026-10-30 10:00:00', { group: 'api', ref: refD }) === 'a <TS> b <TS> c 2026-11-21 10:00 d 2026-10-30 10:00:00', '归一 L3：运行日期前后一天内的时间戳归一，再远的（夹具固定日期）原样保留');
  check(normalizeMessage('x 2026-10-30 10:00:00', { group: 'api', ref: null }) === 'x <TS>', '归一 L3：没有运行日期时全部归一（自检 / 实验用）');
  // L4：临时目录规则要求随机后缀后紧跟路径分隔符；文件名不被误伤
  check(normalizeMessage('lib/sysbuild-api-suite-notify.js:9 与 sysbuild-db-mutXY1234.js', { group: 'api', ref: null }) === 'lib/sysbuild-api-suite-notify.js:9 与 sysbuild-db-mutXY1234.js' && normalizeMessage('Temp\\sysbuild-db-AbC123\\db.js', { group: 'api', ref: null }) === 'Temp\\sysbuild-db-<RAND>\\db.js', '归一 L4：`sysbuild-api-suite-notify.js` 这类文件名不被归一，真正的 mkdtemp 目录（后跟分隔符）照常归一');
  // M1：static 组的 FAIL 行号归一只对 static 组生效；:0 保留
  check(normalizeMessage('FAIL [S2] zz.js:3 x', { group: 'static', ref: null }) === 'FAIL [S2] zz.js:<L> x' && normalizeMessage('FAIL [S2] zz.js:3 x', { group: 'api', ref: null }) === 'FAIL [S2] zz.js:3 x' && normalizeMessage('FAIL [S0] schema.js:0 x', { group: 'static', ref: null }) === 'FAIL [S0] schema.js:0 x', '归一 M1：static 组 FAIL 行号 → <L>，:0 保留，别的组不套');
  // 归一机制本身：规则表可能是空的（两次运行没有易变字段时），所以临时装一条合成规则验证「套规则 → 比较判相同；没套规则 → 判不同」，验完拆掉
  const nBefore = NORMALIZERS.length;
  NORMALIZERS.push({ name: '合成：易变数字', re: /zz易变-\d+/g, to: 'zz易变-<N>', example: { in: '连不上 zz易变-41234', out: '连不上 zz易变-<N>' } });
  try {
    check(normalizeMessage('连不上 zz易变-41234') === '连不上 zz易变-<N>', '归一机制：合成规则把易变数字替换成占位符');
    const m1 = run([mut('api', 'A1', '判红', [F('用例甲', 'Error', '连不上 zz易变-41234')]), apiOk[1], apiOk[2]], staticOk);
    const m2 = run([mut('api', 'A1', '判红', [F('用例甲', 'Error', '连不上 zz易变-45678')]), apiOk[1], apiOk[2]], staticOk);
    check(compareBaselines(m1.entries, m2.entries, []).ok, '对比：套了归一规则——只有易变数字不同的两条信息判相同');
    const m3 = run([mut('api', 'A1', '判红', [F('用例甲', 'Error', '连不上 zz易变-41234，且换了说法')]), apiOk[1], apiOk[2]], staticOk);
    check(!compareBaselines(m1.entries, m3.entries, []).ok, '对比：套了归一规则后，实质内容不同的信息仍判不同');
  } finally { NORMALIZERS.pop(); }
  const m4 = run([mut('api', 'A1', '判红', [F('用例甲', 'Error', '连不上 zz易变-41234')]), apiOk[1], apiOk[2]], staticOk);
  const m5 = run([mut('api', 'A1', '判红', [F('用例甲', 'Error', '连不上 zz易变-45678')]), apiOk[1], apiOk[2]], staticOk);
  check(NORMALIZERS.length === nBefore && !compareBaselines(m4.entries, m5.entries, []).ok, '归一机制：规则拆掉之后同样的两条信息判不同（规则表是唯一的放宽口子）');

  // H1：siteText（抛出位置那一行的源码文本）参与判等；只有行号变、文本相同不算变
  const tmpRepos = [];
  const mkRepo = (lines) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-site-')); tmpRepos.push(d); fs.mkdirSync(path.join(d, 'wbs-server', 'scripts'), { recursive: true }); fs.writeFileSync(path.join(d, 'wbs-server', 'scripts', 'x.js'), lines.join('\r\n')); return d; };
  try {
    const SITE = (n) => ({ ...F('用例甲', 'AssertionError', '期望 1'), site: 'wbs-server/scripts/x.js:' + n });
    const asm = (repo, n) => assemble({ api: { registered: [R('api', 'A1')], text: mut('api', 'A1', '判红', [SITE(n)]) + '\n' + finishApi + '\n', meta: null } }, ['api'], { repo });
    const repoA = mkRepo(['a', '  assert.strictEqual(res.status, 200); // 业务断言', 'c']);
    const repoShift = mkRepo(['a', 'b', 'b2', 'b3', '  assert.strictEqual(res.status, 200); // 业务断言', 'c']);
    const repoOther = mkRepo(['a', '  await setupFixture(res); // 搭数据', 'c']);
    const eA = asm(repoA, 2);
    check(eA.entries[0].failures[0].siteText === 'assert.strictEqual(res.status, 200); // 业务断言', 'siteText：按 site 读出该行源码，去首尾空白（CRLF 文件也一样）');
    check(compareBaselines(eA.entries, asm(repoShift, 5).entries, []).ok, 'siteText：只有行号变（2 → 5）、该行文本相同 → 判相同');
    const cOther = compareBaselines(eA.entries, asm(repoOther, 2).entries, []);
    check(!cOther.ok && cOther.unregistered[0].kind === '失败位置变化', 'siteText：case / class / message 都相同、该行文本不同（断言行变成搭数据行）→ 判不同');
    const eBad = assemble({ api: { registered: [R('api', 'A1'), R('api', 'A2')], text: [mut('api', 'A1', '判红', [{ ...F('c', 'Error', 'm'), site: 'wbs-server/scripts/none.js:3' }]), mut('api', 'A2', '判红', [SITE(99)])].join('\n') + '\n' + finishApi + '\n', meta: null } }, ['api'], { repo: repoA });
    // M1'：序号——同一文件里文本相同的两行，靠「文本#序号」区分；基线里存下来的值用于 --compare（不再重读源码）
    const repoDup = mkRepo(['assert.ok(x)', 'b', 'assert.ok(x)']);
    const dA = asm(repoDup, 1);
    const dB = asm(repoDup, 3);
    check(dA.entries[0].failures[0].siteText === 'assert.ok(x)' && dA.entries[0].failures[0].siteOrd === 1 && dB.entries[0].failures[0].siteOrd === 2, "siteOrd：同一文件里文本相同的两行，第 1 行序号 1、第 3 行序号 2（数到该行为止）");
    const cDup = compareBaselines(dA.entries, dB.entries, []);
    check(!cDup.ok && cDup.unregistered[0].kind === '失败位置变化', "siteOrd：case / class / message / 行文本都相同，只是落在文本相同的另一行（序号 1 → 2）→ 判不同");
    const stored = JSON.parse(JSON.stringify(dA.entries));
    check(stored[0].failures[0].siteText === 'assert.ok(x)' && stored[0].failures[0].siteOrd === 1 && compareBaselines(stored, asm(repoDup, 1).entries, []).ok, 'siteOrd：基线 JSON 里存了 siteText 与 siteOrd；--compare 时基线一侧用存下来的值，当前一侧读源码，位置没变 → 判相同');
    const msk = multiSiteKeys([{ group: 'api', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, site: 'wbs-server/scripts/a.js:5', siteText: 't', siteOrd: 1 }] }, { group: 'api', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, site: 'wbs-server/scripts/b.js:9', siteText: 't', siteOrd: 1 }, { case: 'c', errorClass: 'E', message: 'm', label: null, site: 'wbs-server/scripts/a.js:8', siteText: 't', siteOrd: 2 }] }], true);
    check(msk.length === 1 && msk[0].sites.join() === 'wbs-server/scripts/a.js:5,wbs-server/scripts/b.js:9' && multiSiteKeys([{ group: 'api', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, site: 'wbs-server/scripts/a.js:5', siteText: 't', siteOrd: 1 }, { case: 'c', errorClass: 'E', message: 'm', label: null, site: 'wbs-server/scripts/a.js:8', siteText: 't', siteOrd: 2 }] }], true).length === 0, "key 对应多个 site：不同文件里文本与序号都相同的失败 → 1 个键对应 2 个 site；同文件文本相同但序号不同 → 不算");
    check(eBad.entries.every((e) => e.failures[0].siteText === '<unreadable>') && eBad.groups.api.siteUnreadable === 2, 'siteText：文件不存在或行号越界 → <unreadable>，汇总里计数（2）');
    check(good.entries.every((e) => e.failures.every((f) => f.siteText === undefined)) && !('siteText' in (good.entries[0].failures[0] || {})), 'siteText：不给 repo 时不读源码（自检里的合成记录不受影响）');
    const sigEntries = [{ group: 'api', id: 'a', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, siteText: 'x' }] }, { group: 'api', id: 'b', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, siteText: 'y' }] }, { group: 'api', id: 'c', failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, siteText: 'x' }] }];
    const s1 = signatureClasses(sigEntries, { site: false, norm: false });
    const s2 = signatureClasses(sigEntries, { site: true, norm: false });
    check(s1.classes === 1 && s1.members === 3 && s2.classes === 1 && s2.members === 2 && s2.distinct === 2, '失败签名相同的组数：不带 siteText 时 3 条同签名（1 类），带 siteText 后 a、c 一类、b 单独（1 类 / 2 条）');
  } finally { for (const d of tmpRepos) { try { removeTree(d); } catch (e) { console.error('  [清理] ' + d + ' ' + e.message); } } }

  // HIGH-3：caseSite（用例体调用点）参与判等
  const tmpRepos2 = []; // 下面三段自检建的临时目录，最后一起清理
  {
    const helper = 'wbs-server/scripts/lib/sysbuild-api-suite.js:332';
    const FC = (caseSiteLine, extra) => ({ ...F('用例甲', 'AssertionError', '状态码应为 409，实际 400'), site: helper, caseSite: caseSiteLine === null ? null : 'wbs-server/scripts/lib/sysbuild-api-suite-plan.js:' + caseSiteLine, frames: [helper, 'wbs-server/scripts/lib/sysbuild-api-suite-plan.js:' + caseSiteLine], runnerSeen: true, ...(extra || {}) });
    const repoC = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-casesite-'));
    tmpRepos2.push(repoC);
    fs.mkdirSync(path.join(repoC, 'wbs-server', 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repoC, 'wbs-server', 'scripts', 'lib', 'sysbuild-api-suite.js'), Array.from({ length: 340 }, (_, i) => (i + 1 === 332 ? '  assert.strictEqual(r.status, status, label);' : '// pad ' + i)).join('\n'));
    const planLines = ['// pad', '  await expectErr(setup(), 400, "搭数据");', '  // 空', '  await expectErr(act(), 409, "业务动作");', '  await expectErr(act(), 409, "业务动作");'];
    fs.writeFileSync(path.join(repoC, 'wbs-server', 'scripts', 'lib', 'sysbuild-api-suite-plan.js'), planLines.join('\r\n'));
    const asmC = (n, repo) => assemble({ api: { registered: [R('api', 'A1')], text: mut('api', 'A1', '判红', [FC(n)]) + '\n' + finishApi + '\n', meta: null } }, ['api'], { repo: repo || repoC });
    const eSetup = asmC(2);
    const eAct = asmC(4);
    const eAct2 = asmC(5);
    check(eSetup.entries[0].failures[0].caseSiteText === 'await expectErr(setup(), 400, "搭数据");' && eSetup.entries[0].failures[0].caseSiteOrd === 1 && eAct2.entries[0].failures[0].caseSiteOrd === 2, 'caseSite：按 caseSite 读出用例体那一行源码与序号（与 siteText 同口径；CRLF 文件也一样）');
    const cHelper = compareBaselines(eAct.entries, eSetup.entries, []);
    check(!cHelper.ok && cHelper.unregistered[0].kind === '失败位置变化', 'caseSite：site 是同一个助手行、case / class / message 都相同，失败从「业务动作」调用点挪到「搭数据」调用点 → 判不同（HIGH-3 的核心）');
    const cOrd = compareBaselines(eAct.entries, eAct2.entries, []);
    check(!cOrd.ok, 'caseSite：两处用例体文本相同的调用（序号 1 → 2）→ 判不同');
    const repoShiftC = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-casesite-'));
    tmpRepos2.push(repoShiftC);
    fs.mkdirSync(path.join(repoShiftC, 'wbs-server', 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(repoShiftC, 'wbs-server', 'scripts', 'lib', 'sysbuild-api-suite.js'), fs.readFileSync(path.join(repoC, 'wbs-server', 'scripts', 'lib', 'sysbuild-api-suite.js')));
    fs.writeFileSync(path.join(repoShiftC, 'wbs-server', 'scripts', 'lib', 'sysbuild-api-suite-plan.js'), ['// pad', '// pad2', '// pad3', '// pad4'].concat(planLines.slice(1)).join('\n'));
    const eShift = asmC(5, repoShiftC);
    check(eShift.entries[0].failures[0].caseSiteText === 'await expectErr(setup(), 400, "搭数据");' && compareBaselines(eSetup.entries, eShift.entries, []).ok, 'caseSite：只有行号变（2 → 5）、该行文本与序号都没变 → 判相同');
    const eNull = assemble({ api: { registered: [R('api', 'A1')], text: mut('api', 'A1', '判红', [FC(null)]) + '\n' + finishApi + '\n', meta: null } }, ['api'], { repo: repoC });
    check(eNull.entries[0].failures[0].caseSite === null && eNull.entries[0].failures[0].caseSiteText === null && !compareBaselines(eNull.entries, eAct.entries, []).ok, 'caseSite：为 null（运行器自己抛 / 守卫类）与有值的失败判不同');
    const same = (x) => ({ ...FC(4), site: x, caseSite: x });
    const eSame = assemble({ api: { registered: [R('api', 'A1')], text: mut('api', 'A1', '判红', [same('wbs-server/scripts/lib/sysbuild-api-suite-plan.js:4')]) + '\n' + finishApi + '\n', meta: null } }, ['api'], { repo: repoC });
    check(JSON.parse(failureKey(eSame.entries[0].failures[0], { group: 'api', ref: null }))[6] === '=' && JSON.parse(failureKey(eAct.entries[0].failures[0], { group: 'api', ref: null }))[6] === 'await expectErr(act(), 409, "业务动作");#1', 'caseSite：与 site 是同一行 → key 里只记 "="（不重复算一次）；不同行 → 文本#序号');
    // 「key 相同但 caseSite 不同」与「旧键被拆开」两个计数
    const mk = (id, cs, ct, co) => ({ group: 'api', id, failures: [{ case: 'c', errorClass: 'E', message: 'm', label: null, site: helper, siteText: 'h', siteOrd: 1, caseSite: cs, caseSiteText: ct, caseSiteOrd: co }] });
    const split = caseSiteSplitKeys([mk('a', 'wbs-server/scripts/lib/p.js:2', 'x', 1), mk('b', 'wbs-server/scripts/lib/p.js:9', 'y', 1)], false);
    const noSplit = caseSiteSplitKeys([mk('a', 'wbs-server/scripts/lib/p.js:2', 'x', 1), mk('b', 'wbs-server/scripts/lib/p.js:9', 'y', 1)], true);
    const collide = caseSiteSplitKeys([mk('a', 'wbs-server/scripts/lib/p.js:2', 'x', 1), mk('b', 'wbs-server/scripts/lib/q.js:8', 'x', 1)], true);
    check(split.length === 1 && split[0].caseSites.length === 2 && noSplit.length === 0 && collide.length === 1 && collide[0].caseSites.length === 2, 'caseSiteSplitKeys：同一旧键下两个不同 caseSite → 旧键拆开 1 组、完整键拆不出重名（0）；不同文件里文本与序号都相同的两个 caseSite → 完整键下重名 1 组');
    const stats = callSiteStats([{ group: 'api', failures: [{ errorClass: 'E', caseSite: 'a:1', frames: ['a:1'], runnerSeen: true }, { errorClass: 'E', caseSite: null, frames: ['a:1'], runnerSeen: true }, { errorClass: 'E', caseSite: 'a:2', frames: ['a:2'], runnerSeen: false }] }, { group: 'static', failures: [{ errorClass: 'GuardFail', caseSite: null, frames: [], runnerSeen: null }, { errorClass: null, caseSite: null, frames: [], runnerSeen: null }] }]);
    check(stats.api.failures === 3 && stats.api.caseSiteNull === 1 && stats.api.nullOther === 1 && stats.api.runnerNotSeen === 1 && stats.static.nullGuardFail === 1 && stats.static.nullNoClass === 1 && stats.static.framesEmpty === 2, 'callSiteStats：按组统计 caseSite 为 null（GuardFail / 无异常类 / 其他）、没有运行器帧、frames 为空');
  }

  // callSites：栈文本 → site / frames / caseSite / runnerSeen（运行器帧表见 lib/sysbuild-mut-record.js）
  {
    const W = 'E:\\wt\\';
    const st = (...fr) => 'AssertionError [ERR_ASSERTION]: x\n' + fr.map((f) => '    at ' + f).join('\n');
    const api = rec.callSites(st('expectErr (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite.js:332:12)', 'async Object.fn (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite-plan.js:827:9)', 'async runAll (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite.js:1297:19)', 'async main (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite.js:1800:3)'));
    check(api.site === 'wbs-server/scripts/lib/sysbuild-api-suite.js:332' && api.caseSite === 'wbs-server/scripts/lib/sysbuild-api-suite-plan.js:827' && api.runnerSeen === true && api.frames.length === 4 && api.frames[0] === api.site, 'callSites：api 形态（助手 → 用例体 → runAll → main）→ site = 助手行，caseSite = runAll 里面那一帧（用例体），runnerSeen');
    const mig = rec.callSites(st('Object.fn (' + W + 'scripts\\sysbuild-predeploy\\verify-schema-migration.cjs:106:20)', 'test (' + W + 'scripts\\sysbuild-predeploy\\verify-schema-migration.cjs:99:19)', 'async ' + W + 'scripts\\sysbuild-predeploy\\verify-schema-migration.cjs:102:62'));
    check(mig.caseSite === 'scripts/sysbuild-predeploy/verify-schema-migration.cjs:106' && mig.runnerSeen === true, 'callSites：迁移 / 存档 / 只读形态（用例体 → test → 匿名 async 主函数）→ caseSite 取 test 里面那一帧（不是主函数的 await test( 那一行）');
    const dbNoRunner = rec.callSites(st('Object.<anonymous> (' + W + 'wbs-server\\scripts\\verify-sysbuild-db.js:700:10)', 'async Object.fn (' + W + 'wbs-server\\scripts\\verify-sysbuild-db.js:710:5)'));
    check(dbNoRunner.caseSite === 'wbs-server/scripts/verify-sysbuild-db.js:710' && dbNoRunner.runnerSeen === false, 'callSites：栈里没有任何运行器帧（新驱动 / 没登记进运行器帧表的文件）→ runnerSeen=false，caseSite 兜底取最外层的帧（已提交基线里 db / attachments 的栈都有运行器帧，这条只验兜底分支）');
    const dbTimeout = rec.callSites(st('Timeout.<anonymous> (' + W + 'wbs-server\\scripts\\verify-sysbuild-db.js:61:30)', 'listOnTimeout (node:internal/timers:581:17)'));
    const dbTimeoutOld = rec.callSites(st('Timeout._onTimeout (' + W + 'wbs-server\\scripts\\verify-sysbuild-attachments.js:54:30)'));
    check(dbTimeout.caseSite === null && dbTimeout.runnerSeen === true && dbTimeout.site === 'wbs-server/scripts/verify-sysbuild-db.js:61' && dbTimeoutOld.caseSite === null && dbTimeoutOld.runnerSeen === true, 'callSites：超时失败（栈里只有 withTimeout 的定时器回调，Node 24 里叫 Timeout.<anonymous>，旧写法 Timeout._onTimeout 也认）→ 它是运行器帧，caseSite = null');
    const browser = rec.callSites(st('async ' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:520:25', 'async run (' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:544:19)'));
    const browserObj = rec.callSites(st('assertion (' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:307:5)', 'async target (' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:18:3)', 'async ' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:306:5', 'async Object.run (' + W + 'wbs-server\\scripts\\lib\\sysbuild-browser-suite.js:544:19)', 'async ' + W + 'wbs-server\\scripts\\verify-sysbuild-browser.js:26:30'));
    check(browser.caseSite === 'wbs-server/scripts/lib/sysbuild-browser-suite.js:520' && browser.runnerSeen === true && browserObj.runnerSeen === true && browserObj.caseSite === 'wbs-server/scripts/lib/sysbuild-browser-suite.js:306', 'callSites：浏览器形态（场景匿名函数 → run；驱动以 suite.run() 方法调用，栈里写成 Object.run，两种都认）→ caseSite 取运行器里面那一帧（第一次全量跑时只认 run，104 条全落到驱动主函数那一行）');
    const nested = rec.callSites(st('a (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite.js:5:1)', ...Array.from({ length: 14 }, (_, i) => 'b' + i + ' (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite-plan.js:' + (100 + i) + ':1)'), 'runAll (' + W + 'wbs-server\\scripts\\lib\\sysbuild-api-suite.js:1297:19)'));
    check(nested.frames.length === rec.FRAME_LIMIT && nested.frames[0].endsWith(':5') && nested.caseSite === 'wbs-server/scripts/lib/sysbuild-api-suite-plan.js:113', `callSites：frames 最多 ${rec.FRAME_LIMIT} 个（由内到外），caseSite 仍取到第 12 个之后的最外层用例体帧`);
    const none = rec.callSites('Error: x\n    at Object.<anonymous> (node:internal/x:1:1)');
    check(none.site === null && none.frames.length === 0 && none.caseSite === null && none.runnerSeen === false && rec.callSites(undefined).caseSite === null, 'callSites：栈里没有落目录的帧 / 没有栈 → site、caseSite 为 null，frames 为空');
    const fe = rec.failureOfError('用例', Object.assign(new Error('boom'), { stack: st('f (' + W + 'wbs-server\\scripts\\verify-sysbuild-schema.js:10:1)', 'async runAll (' + W + 'wbs-server\\scripts\\verify-sysbuild-schema.js:596:7)') }));
    const parsedLine = rec.parseMutLine(rec.mutLine('schema', 'M', '判红', [fe]));
    check(fe.caseSite === 'wbs-server/scripts/verify-sysbuild-schema.js:10' && parsedLine.rec.failures[0].caseSite === fe.caseSite && parsedLine.rec.failures[0].frames.length === 2 && parsedLine.rec.failures[0].runnerSeen === true, 'failureOfError → mutLine → parseMutLine：frames / caseSite / runnerSeen 原样走一圈');
    const guard = rec.parseMutLine(rec.mutLine('static', 'M', '判红', [{ case: 'S2', errorClass: 'GuardFail', message: 'x', site: null, label: null }]));
    check(guard.rec.failures[0].caseSite === null && guard.rec.failures[0].frames.length === 0 && guard.rec.failures[0].runnerSeen === null, '守卫类失败（没有栈）：frames = []、caseSite = null、runnerSeen = null');
    const sum = rec.failuresOfSummary({ results: [{ name: 'n', passed: false, error: st('body (' + W + 'scripts\\sysbuild-predeploy\\verify-archive.cjs:50:1)', 'test (' + W + 'scripts\\sysbuild-predeploy\\verify-archive.cjs:39:40)') }, { name: 'ok', passed: true }] });
    check(sum.length === 1 && sum[0].caseSite === 'scripts/sysbuild-predeploy/verify-archive.cjs:50' && sum[0].errorClass === 'AssertionError', 'failuresOfSummary：results.json 里的栈文本同样得到 caseSite');
    const missing = rec.RUNNER_FRAMES.filter((r) => !fs.existsSync(path.join(DEFAULT_REPO, ...r.file.split('/'))));
    check(missing.length === 0, '运行器帧表里的文件都在本仓库里' + (missing.length ? '：缺 ' + missing.map((r) => r.file).join('、') : ''));
    const srcOf = (r) => fs.readFileSync(path.join(DEFAULT_REPO, ...r.file.split('/')), 'utf8');
    const noDefInFile = rec.RUNNER_FRAMES.filter((r) => !r.defs || r.defs.length === 0 || !r.defs.every((d) => d.test(srcOf(r))) || !r.fn.test(r.src));
    check(noDefInFile.length === 0, '运行器帧表里每个文件的源码里都匹配到表里写的运行器「定义形态」（defs：async function runAll( / const test = async ( 这类写法，不是只搜到一个词），且 fn 的写法认得 src' + (noDefInFile.length ? '：对不上 ' + noDefInFile.map((r) => r.file).join('、') : ''));
    // L2 的对照：只在注释 / 调用里出现 run / test 这个词、没有定义形态的源码，不能让这条自检放行
    const wordOnly = '// 这里提到 runAll 和 test\nconst x = runAll();\nawait test("a", () => {});\n';
    check(rec.RUNNER_FRAMES.every((r) => !r.defs.every((d) => d.test(wordOnly))), '运行器帧表自检 L2 对照：只有 runAll / test 这个词（注释与调用）、没有定义形态的源码 → 每个 defs 都匹配不上（不会被放行）');
  }

  // 来源清单（HIGH-2）：临时 git 仓库里做
  {
    const git = (cwd, args) => spawnSync('git', ['-C', cwd, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
    const P = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-prov-'));
    tmpRepos2.push(P);
    const put = (rel, text) => { const f = path.join(P, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
    put('wbs-server/routes/sysbuild/a.js', 'module.exports = 1;\n');
    put('wbs-server/routes/other.js', 'module.exports = 2;\n');
    put('wbs-server/public/x.html', '<p>x</p>\n');
    put('wbs-server/server.js', '// server\n');
    put('wbs-server/scripts/verify-sysbuild-x.js', '// v\n');
    put('wbs-server/scripts/verify-other.js', '// 不在清单里\n');
    put('wbs-server/scripts/lib/sysbuild-y.js', '// y\n');
    put('wbs-server/scripts/lib/other.js', '// 不在清单里\n');
    put('wbs-server/scripts/sysbuild-step1/w.js', '// w\n');
    put('wbs-server/scripts/_test-fixture.js', '// f\n');
    put('scripts/sysbuild-predeploy/z.cjs', '// z\n');
    put('scripts/sysbuild-predeploy/fixtures/s.json', '{}\n');
    put('scripts/sysbuild-predeploy/README.md', '# 不在清单里\n');
    put('scripts/sysbuild-predeploy/node_modules/m/i.js', '// 不在清单里\n');
    put('scripts/deploy-ssh.ps1', '# d\n');
    // 预筛 HIGH-2：基线运行实际加载的间接依赖（utils / test-instance / listen-safe-port / scripts/lines 三个 / wbs-server/package.json / offline.html）也进清单；清单外的同类文件不进
    put('wbs-server/utils/u.js', '// u\n');
    put('wbs-server/utils/README.md', '# 不在清单里\n');
    put('wbs-server/scripts/lib/test-instance.js', '// ti\n');
    put('wbs-server/scripts/lib/listen-safe-port.js', '// lsp\n');
    put('scripts/lines/line-proc.js', '// lp\n');
    put('scripts/lines/line-common.js', '// lc\n');
    put('scripts/lines/line-new.js', '// ln\n');
    put('scripts/lines/line-other.js', '// 不在清单里\n');
    put('wbs-server/package.json', '{}\n');
    put('scripts/sysbuild-predeploy/temp-service/offline.html', '<p>offline</p>\n');
    put('.gitignore', 'wbs-server/.env\nwbs-server/.sdh-instance\nwbs-server/task_pool.db\n');
    git(P, ['init', '-q']);
    git(P, ['add', '-A']);
    const cm = git(P, ['commit', '-q', '-m', 'init']);
    const listed = listTestFiles(P);
    const expectedList = ['scripts/deploy-ssh.ps1', 'scripts/lines/line-common.js', 'scripts/lines/line-new.js', 'scripts/lines/line-proc.js', 'scripts/sysbuild-predeploy/fixtures/s.json', 'scripts/sysbuild-predeploy/temp-service/offline.html', 'scripts/sysbuild-predeploy/z.cjs', 'wbs-server/package.json', 'wbs-server/scripts/_test-fixture.js', 'wbs-server/scripts/lib/listen-safe-port.js', 'wbs-server/scripts/lib/sysbuild-y.js', 'wbs-server/scripts/lib/test-instance.js', 'wbs-server/scripts/sysbuild-step1/w.js', 'wbs-server/scripts/verify-sysbuild-x.js', 'wbs-server/utils/u.js'];
    check(cm.status === 0 && JSON.stringify(listed) === JSON.stringify(expectedList), '来源清单：测试文件清单 = verify-sysbuild-* + lib/sysbuild-* + predeploy 下 js/cjs/txt/json（不含 node_modules / md）+ sysbuild-step1/*.js + wbs-server/utils/** + 间接依赖（_test-fixture / test-env / deploy-ssh / test-instance / listen-safe-port / scripts/lines 三个 / wbs-server/package.json / offline.html；清单外的同类文件不进）');
    // 被 git 忽略的运行输入（.env / .sdh-instance / task_pool.db）：提交之后才造，git status 看不见；.env 里放一个会泄漏的假值，验证清单里没有值也没有哈希
    const ENV_SECRET = 'TOPSECRET-value-9f3a';
    const envText = 'SYS_FASTLANE_ENABLE=1\nJWT_SECRET=' + ENV_SECRET + '\nNODE_ENV=\nexport OTHER_KEY=x\n';
    put('wbs-server/.env', envText);
    put('wbs-server/.sdh-instance', 'sbslim\n');
    put('wbs-server/task_pool.db', 'fake-db-bytes');
    const snap = snapshotInputs(P);
    const blobOf = (rel) => git(P, ['rev-parse', 'HEAD:' + rel]).stdout.trim();
    check(snap.product.clean && snap.testFiles.length === expectedList.length && snap.testFiles.every((x) => x.gitHashObject === blobOf(x.path) && /^[0-9a-f]{64}$/.test(x.sha256)) && snap.product.routesSysbuildTree === blobOf('wbs-server/routes/sysbuild') && snap.product.publicTree === blobOf('wbs-server/public') && snap.workingTree.length === 0, '来源清单：产品树干净；每个测试文件的 git hash-object = 提交里的 blob 号；产品树对象号取自 HEAD；工作区状态为空');
    const ign = snap.ignoredInputs;
    const ignJson = JSON.stringify(ign);
    check(ign.sdhInstance.sha256 === sha256Of(Buffer.from('sbslim\n')) && ign.taskPoolDb.bytes === 13 && ign.taskPoolDb.sha256 === sha256Of(Buffer.from('fake-db-bytes')) && ign.envKeys.exists === true && JSON.stringify(ign.envKeys.keys) === JSON.stringify([{ key: 'SYS_FASTLANE_ENABLE', present: true }, { key: 'LOG_LEVEL', present: false }, { key: 'NODE_ENV', present: true }]) && !ignJson.includes(ENV_SECRET) && !ignJson.includes(sha256Of(Buffer.from(envText))) && !ignJson.includes('JWT_SECRET') && !ignJson.includes('OTHER_KEY'), '被忽略的运行输入：.sdh-instance 记 sha256、task_pool.db 记字节数与 sha256、.env 只记白名单各键是否存在（键名 + 存在与否）；不含任何值、不含 .env 的哈希、不含白名单以外的键名');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-ign-'));
    tmpRepos2.push(emptyDir);
    const ignNone = ignoredInputsState(emptyDir);
    check(ignNone.sdhInstance.exists === false && ignNone.taskPoolDb.exists === false && ignNone.envKeys.exists === false && ignNone.envKeys.keys.length === 3 && ignNone.envKeys.keys.every((k) => k.present === false), '被忽略的运行输入：三个文件都不存在 → exists:false，各键 present:false，不抛');
    check(snap.product.headTree === git(P, ['rev-parse', 'HEAD^{tree}']).stdout.trim() && /^[0-9a-f]{40}$/.test(snap.product.headTree) && snapshotProblems(snap, '测试').length === 0, '来源清单 (c)：产品快照记 HEAD^{tree}（整棵树）；干净的快照没有拒绝理由');
    put('wbs-server/routes/sysbuild/a.js', 'module.exports = 3;\n');
    const dirty = snapshotInputs(P);
    check(!dirty.product.clean && dirty.product.statusPorcelain.length === 1 && /a\.js/.test(dirty.product.statusPorcelain[0]) && dirty.workingTree.length === 1, '来源清单：产品源码有未提交改动 → clean = false，列出改动；工作区状态记下来');
    put('wbs-server/routes/sysbuild/a.js', 'module.exports = 1;\n');
    put('wbs-server/routes/new-file.js', '// 未跟踪\n');
    check(!snapshotInputs(P).product.clean, '来源清单：产品源码目录里有未跟踪文件 → 同样不干净');
    fs.unlinkSync(path.join(P, 'wbs-server', 'routes', 'new-file.js'));
    check(snapshotInputs(P).product.clean, '来源清单：恢复后又干净（对照组）');
    // 整条 CLI：--parse-only + 合成日志 + 临时 git 仓库
    // 工作区硬门：临时仓库里的产物（原始日志、基线、清单、登记文件）放 tmp/ 下——tmp/ 以外的未跟踪文件会被拒绝
    const raw = path.join(P, 'tmp', 'raw');
    const outDir = path.join(P, 'tmp', 'out');
    fs.mkdirSync(raw, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    const fixB = path.join(raw, 'fix-before.log');
    const fixA = path.join(raw, 'fix-after.log');
    fs.writeFileSync(fixB, ATTACHMENTS_FIX.ids.map((id) => '  ✗ [' + id + '] 变异锚点出现 0 次（应恰好 1 次）').concat(['变异自检：88/95 判红']).join('\n') + '\n');
    fs.writeFileSync(fixA, ATTACHMENTS_FIX.ids.map((id) => '  ✓ [' + id + '] 判红（50/51）').concat(['变异自检：95/95 判红']).join('\n') + '\n');
    fs.writeFileSync(path.join(raw, 'api.log'), '  ✓ 未变异基线（进程内）9/9 全绿\n' + apiOk.join('\n') + '\n' + finishApi + '\n');
    fs.writeFileSync(path.join(raw, 'static.log'), '  ✓ 未变异基线（真实 routes/sysbuild/）4/4 全绿\n' + staticOk.join('\n') + finishStatic + '\n');
    for (const g of ['api', 'static']) fs.writeFileSync(path.join(raw, g + '.meta.json'), JSON.stringify({ command: 'node x ' + g, argv: ['x', g], env: { SYSBUILD_MUT_RECORD: '1', NODE_OPTIONS: STACK_LIMIT_OPTION }, exitCode: 0, signal: null, error: null, startedAt: '2026-11-19T12:00:00.000Z', endedAt: '2026-11-19T12:05:00.000Z', seconds: 300 }));
    const regF = path.join(P, 'tmp', 'reg.json');
    fs.writeFileSync(regF, JSON.stringify([...reg.api, ...reg.static]));
    const outF = path.join(outDir, 'mutation-baseline.json');
    const cli2 = (args) => spawnSync(process.execPath, [__filename, '--repo', P, '--groups', 'api,static', '--registry-file', regF, ...args], { encoding: 'utf8' });
    const head = git(P, ['rev-parse', 'HEAD']).stdout.trim();
    const w1 = cli2(['--parse-only', raw, '--out', outF, '--fix-before-log', fixB, '--fix-after-log', fixA, '--fix-commit', head]);
    const provF = path.join(outDir, 'mutation-baseline.provenance.json');
    let b1 = null; let p1 = null;
    try { b1 = JSON.parse(fs.readFileSync(outF, 'utf8')); p1 = JSON.parse(fs.readFileSync(provF, 'utf8')); } catch (_) { /* 下面判 */ }
    check(w1.status === 0 && b1 && p1 && b1.format === FORMAT && b1.provenanceFile === 'mutation-baseline.provenance.json' && b1.provenanceSha256 === sha256Of(fs.readFileSync(provF)) && p1.format === PROVENANCE_FORMAT && p1.entriesSha256 === sha256Of(JSON.stringify(b1.entries)) && p1.mode === 'parse-only' && p1.productTree.clean === true && p1.testFilesCount === expectedList.length && p1.productTree.headTree === snap.product.headTree && p1.parallelBrowser === null && Array.isArray(p1.notLoadedWhitelist) && p1.notLoadedWhitelist.length === 4 && p1.groups.api.driverBaselineGreen === true && p1.groups.api.rawLog.sha256 === sha256Of(fs.readFileSync(path.join(raw, 'api.log'))) && p1.groups.api.mutRecords === 3 && p1.groups.api.registered === 3 && p1.groups.static.exitCode === 0 && p1.attachmentsFix.fixCommit === head && p1.attachmentsFix.before.mutations.length === 7 && p1.attachmentsFix.after.summaryLine === '变异自检：95/95 判红', '来源清单 CLI：写出基线 + 来源清单，基线顶层存清单 sha256，清单存 entries sha256、产品树、测试文件、原始日志 sha256、驱动基线行、附件修复前后证据');
    const l1 = cli2(['--parse-only', raw, '--compare', outF]);
    check(l1.status === 0 && /基线来源清单核对：一致/.test(l1.stdout), '来源清单 CLI：--compare 核对基线与清单互相对得上');
    // L6：--compare 打印清单 mode，parse-only 生成的要标明
    check(/基线来源清单 mode：parse-only（只解析已有原始日志生成/.test(l1.stdout), 'L6：--compare 打印清单 mode；mode=parse-only 时标明「文件哈希与产品快照是取证时刻的」');
    check(p1 && p1.ignoredInputs && p1.ignoredInputs.after === null && p1.ignoredInputs.before.taskPoolDb.bytes === 13 && p1.ignoredInputs.before.envKeys.keys.length === 3 && !fs.readFileSync(provF, 'utf8').includes(ENV_SECRET) && !fs.readFileSync(provF, 'utf8').includes(sha256Of(Buffer.from(envText))), '来源清单 CLI：新生成的清单带 ignoredInputs（parse-only 只有跑前一份）；清单全文里没有 .env 的值、也没有 .env 的哈希');
    // MED-1：基线顶层字段不绑哈希，靠重算 / 与清单逐项比对——改任何一个都不通过
    {
      const baseText = fs.readFileSync(outF, 'utf8');
      const tamperRun = (name, fn) => { const d = JSON.parse(baseText); fn(d); const f = path.join(outDir, name); fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n'); return cli2(['--parse-only', raw, '--compare', f]); };
      const tamperRunAllow = (name, fn) => { const d = JSON.parse(baseText); fn(d); const f = path.join(outDir, name); fs.writeFileSync(f, JSON.stringify(d, null, 2) + '\n'); return cli2(['--parse-only', raw, '--compare', f, '--allow-no-provenance']); };
      const t1 = tamperRun('tamper-groups.json', (d) => { d.groups.api.red = 2; });
      check(t1.status === 1 && /顶层汇总与 entries 重算不一致：组 api red 顶层 2，重算 3/.test(t1.stdout), 'MED-1：改顶层汇总一个数（api.red 3 → 2）→ 从 entries 重算后对不上，--compare 不通过');
      const t2 = tamperRun('tamper-head.json', (d) => { d.headCommit = 'a'.repeat(40); });
      check(t2.status === 1 && /headCommit 与来源清单不一致/.test(t2.stdout), 'MED-1：改顶层 headCommit → 与清单里的 HEAD 对不上，不通过');
      const t3 = tamperRun('tamper-runat.json', (d) => { d.runAt = '2026-01-01T00:00:00.000Z'; });
      check(t3.status === 1 && /runAt 与来源清单不一致/.test(t3.stdout), 'MED-1：改顶层 runAt → 与清单里各组最早起始时刻对不上，不通过');
      const t4 = tamperRun('tamper-dirty.json', (d) => { d.workingTreeDirty = !d.workingTreeDirty; });
      check(t4.status === 1 && /workingTreeDirty 与来源清单不一致/.test(t4.stdout), 'MED-1：改顶层 workingTreeDirty → 与清单里的工作区状态对不上，不通过');
      const t5 = tamperRun('tamper-key.json', (d) => { d.note = '多出来的顶层字段'; });
      check(t5.status === 1 && /基线顶层有未知字段 "note"/.test(t5.stdout), 'MED-1：顶层多一个未登记的字段 → 不通过');
      const t6 = tamperRun('tamper-ids.json', (d) => { const k = d.entries.findIndex((e) => e.group === 'api'); const x = d.entries[k]; d.entries[k] = d.entries[k + 1]; d.entries[k + 1] = x; });
      check(t6.status === 1 && /entriesSha256 与基线 entries 不一致/.test(t6.stdout), 'MED-1：entries 被改动（顺序对调）→ 清单里的 entriesSha256 对不上，不通过（对照：原有的绑定仍在）');
      // 没有来源清单：默认拒绝，显式 --allow-no-provenance 才放行（自检用）
      const noProv = path.join(outDir, 'noprov.json');
      const nw = cli2(['--parse-only', raw, '--out', noProv, '--no-provenance']);
      const n1 = cli2(['--parse-only', raw, '--compare', noProv]);
      const n2 = cli2(['--parse-only', raw, '--compare', noProv, '--allow-no-provenance']);
      check(nw.status === 0 && n1.status === 1 && /基线没有来源清单（provenanceFile 为空）；--compare 默认拒绝/.test(n1.stdout) && n2.status === 0 && /基线来源清单核对：基线没有来源清单（--allow-no-provenance/.test(n2.stdout) && /对比：相同 4（其中需人工复核 3；守卫类无栈 1，不需复核）/.test(n2.stdout), 'MED-1：基线没有来源清单 → --compare 默认不通过；加 --allow-no-provenance 才放行（且仍重算顶层汇总、仍列需人工复核）');
      // L1：--allow-no-provenance 只放行 provenanceFile 与 provenanceSha256 都为 null 的基线；只剥掉 provenanceFile、sha 还在的仍拒
      const stripped = tamperRunAllow('tamper-stripped.json', (d) => { d.provenanceFile = null; });
      const strippedBoth = tamperRunAllow('tamper-stripped-both.json', (d) => { d.provenanceFile = null; d.provenanceSha256 = null; });
      check(stripped.status === 1 && /这份只剥掉了 provenanceFile、provenanceSha256 还在/.test(stripped.stdout) && strippedBoth.status === 0, 'L1：--allow-no-provenance 下，只剥掉 provenanceFile（sha 还在）→ 拒绝；两个都为 null → 放行');
      const n3 = cli2(['--parse-only', raw, '--allow-no-provenance']);
      check(n3.status === 2, 'MED-1：--allow-no-provenance 没有 --compare → 用法错误（退出码 2）');
      // L4：--provenance 必须与基线同目录
      const l4 = cli2(['--parse-only', raw, '--out', path.join(outDir, 'l4.json'), '--provenance', path.join(P, 'tmp', 'elsewhere', 'x.provenance.json')]);
      const l4b = cli2(['--parse-only', raw, '--provenance', path.join(outDir, 'x.provenance.json')]);
      check(l4.status === 2 && /--provenance 必须与基线（--out）在同一个目录/.test(l4.stderr) && l4b.status === 2 && /--provenance 只能与 --out 一起用/.test(l4b.stderr) && !fs.existsSync(path.join(outDir, 'l4.json')), 'L4：--provenance 与基线不在同一目录 / 没有 --out → 用法错误（退出码 2），什么都不写');
      // (b) 工作区硬门，整条 CLI：tmp/ 以外的未跟踪文件 → 拒绝生成，基线不写
      put('docs/stray.md', '# 未跟踪\n');
      const strayOut = path.join(outDir, 'stray.json');
      const ws = cli2(['--parse-only', raw, '--out', strayOut, '--fix-before-log', fixB, '--fix-after-log', fixA, '--fix-commit', head]);
      fs.unlinkSync(path.join(P, 'docs', 'stray.md'));
      fs.rmdirSync(path.join(P, 'docs'));
      check(ws.status === 1 && /拒绝生成：工作区有 tmp\/ 以外、又不在已记哈希集合里的脏路径或未跟踪路径（跑之前）：docs\/stray\.md/.test(ws.stderr) && !fs.existsSync(strayOut), '来源清单 (b) CLI：tmp/ 以外的未跟踪文件 → 拒绝生成（退出码 1），基线与清单都不写');
    }
    fs.writeFileSync(provF, fs.readFileSync(provF, 'utf8').replace('"mode": "parse-only"', '"mode": "run"'));
    const l2 = cli2(['--parse-only', raw, '--compare', outF]);
    check(l2.status === 1 && /来源清单 sha256 与基线顶层 provenanceSha256 不一致/.test(l2.stdout), '来源清单 CLI：清单被改动（sha256 对不上）→ --compare 判不通过');
    const outG = path.join(outDir, 'refused.json');
    put('wbs-server/routes/sysbuild/a.js', 'module.exports = 9;\n');
    const w2 = cli2(['--parse-only', raw, '--out', outG, '--fix-before-log', fixB, '--fix-after-log', fixA, '--fix-commit', head]);
    check(w2.status === 1 && /拒绝生成：产品源码/.test(w2.stderr) && !fs.existsSync(outG) && !fs.existsSync(path.join(outDir, 'refused.provenance.json')), '来源清单 CLI：产品源码有未提交改动 → 拒绝生成（退出码 1，基线与清单都不写）');
    put('wbs-server/routes/sysbuild/a.js', 'module.exports = 1;\n');
    fs.writeFileSync(path.join(raw, 'api.log'), apiOk.join('\n') + '\n' + finishApi + '\n');
    const w3 = cli2(['--parse-only', raw, '--out', outG, '--fix-before-log', fixB, '--fix-after-log', fixA, '--fix-commit', head]);
    check(w3.status === 1 && /驱动的未变异基线行缺失或不是全绿/.test(w3.stdout) && !fs.existsSync(outG), '来源清单 CLI：驱动日志里没有未变异基线行 → 拒绝生成，基线不写');
    fs.writeFileSync(path.join(raw, 'api.log'), '  ✓ 未变异基线（进程内）9/9 全绿\n' + apiOk.join('\n') + '\n' + finishApi + '\n');
    const w4 = cli2(['--parse-only', raw, '--out', outG]);
    check(w4.status === 1 && /没有给 --fix-before-log/.test(w4.stdout) && !fs.existsSync(outG), '来源清单 CLI：没给附件修复前后日志 → 拒绝生成');
    fs.writeFileSync(fixB, fs.readFileSync(fixB, 'utf8').replace(/^ {2}✗ \[冻结不查同项目\].*\n/m, ''));
    const w5 = cli2(['--parse-only', raw, '--out', outG, '--fix-before-log', fixB, '--fix-after-log', fixA, '--fix-commit', head]);
    check(w5.status === 1 && /「冻结不查同项目」应恰好出现 1 行，实际 0/.test(w5.stdout), '来源清单：附件修复前日志里少一条 → 拒绝生成');
    // 运行期间测试文件变了 → 拒绝（直接调 buildProvenance：pre / post 不一致）
    const a2 = assemble({ api: { registered: reg.api, text: '  ✓ 未变异基线 9/9 全绿\n' + apiOk.join('\n') + '\n' + finishApi + '\n', meta: { command: 'x', exitCode: 0 } } }, ['api']);
    const dataC = { api: { registered: reg.api, text: '  ✓ 未变异基线 9/9 全绿\n' + apiOk.join('\n') + '\n' + finishApi + '\n', meta: { command: 'x', exitCode: 0 } } };
    const preS = snapshotInputs(P);
    const postS = { ...preS, testFiles: preS.testFiles.map((x, i) => (i === 0 ? { ...x, sha256: 'f'.repeat(64) } : x)) };
    const bp = buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null }, a: a2, rawDir: raw, data: dataC, pre: preS, post: postS });
    check(bp.problems.some((x) => /测试 \/ 驱动文件在运行期间变了：scripts\/deploy-ssh\.ps1/.test(x)), '来源清单：运行前后测试文件哈希不一致 → 拒绝生成，并点名是哪个文件');
    // 运行期间别的任务提交了无关文件（HEAD 变了、产品树没变）→ 不拒绝、两个 HEAD 都记；产品树对象号变了 → 拒绝
    const bpHead = buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null }, a: a2, rawDir: raw, data: dataC, pre: preS, post: { ...preS, product: { ...preS.product, head: 'f'.repeat(40) } } });
    const bpTree = buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null }, a: a2, rawDir: raw, data: dataC, pre: preS, post: { ...preS, product: { ...preS.product, routesSysbuildTree: 'e'.repeat(40) } } });
    check(!bpHead.problems.some((x) => /产品源码快照在运行期间变了/.test(x)) && bpHead.doc.repoHeadMovedDuringRun === true && bpHead.doc.repoHeadAfterRun === 'f'.repeat(40) && bpHead.doc.repoHead === preS.product.head && bpTree.problems.some((x) => /产品源码快照在运行期间变了/.test(x)), '来源清单：运行期间 HEAD 变了但产品树没变 → 不拒绝，前后 HEAD 都记；routes/sysbuild 树对象号变了 → 拒绝');
    // 运行期间别的任务改了 sysbuild-step1 里运行时不加载的工具 → 只记录不拒绝；改了 build-mutation-baseline.js / mutation-check.js（被加载的）→ 拒绝
    const stepFile = (name, sha) => ({ path: 'wbs-server/scripts/sysbuild-step1/' + name, loadedByRun: !isNotLoadedByRun('wbs-server/scripts/sysbuild-step1/' + name), gitHashObject: 'x', sha256: sha.repeat(64) });
    const pre2 = { ...preS, testFiles: [stepFile('build-impl-list.js', 'a'), stepFile('build-mutation-baseline.js', 'b'), stepFile('inv-parse.js', 'c')] };
    const post2 = { ...preS, testFiles: [stepFile('build-impl-list.js', 'd'), stepFile('build-mutation-baseline.js', 'b'), stepFile('inv-parse.js', 'c')] };
    const bp2 = buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null }, a: a2, rawDir: raw, data: dataC, pre: pre2, post: post2 });
    const post3 = { ...preS, testFiles: [stepFile('build-impl-list.js', 'a'), stepFile('build-mutation-baseline.js', 'e'), stepFile('inv-parse.js', 'c')] };
    const bp3 = buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null }, a: a2, rawDir: raw, data: dataC, pre: pre2, post: post3 });
    check(!bp2.problems.some((x) => /运行期间变了/.test(x)) && bp2.doc.testFilesChangedDuringRun.notLoadedByRun.length === 1 && bp2.doc.testFilesChangedDuringRun.notLoadedByRun[0].path.endsWith('build-impl-list.js') && bp2.doc.testFilesChangedDuringRun.notLoadedByRun[0].sha256Before === 'a'.repeat(64) && bp2.doc.testFilesChangedDuringRun.loadedByRun.length === 0 && bp3.problems.some((x) => /运行期间变了：wbs-server\/scripts\/sysbuild-step1\/build-mutation-baseline\.js/.test(x)), '来源清单：sysbuild-step1 里运行时不加载的工具（build-impl-list.js）运行期间变了 → 只记录（前后哈希）不拒绝；build-mutation-baseline.js 变了 → 拒绝');

    // ── C1c 修订二（预筛 HIGH-2 / MED-2）：集合级硬门 ─────────────────────────────────────
    const callBp = (x) => buildProvenance({ repo: P, o: { groups: ['api'], parseOnly: null, fixBeforeLog: null, ...(x.o || {}) }, a: a2, rawDir: raw, data: dataC, pre: x.pre || preS, post: x.post === undefined ? null : x.post, requireCache: x.cache || {} });
    const postHead = (paths) => ({ ...preS, product: { ...preS.product, head: 'f'.repeat(40) }, headMovePaths: paths });
    const headProblem = (r, re) => r.problems.find((x) => re.test(x));
    // (a) HEAD 前后不同：差异里出现「不加载白名单」以外的任何路径即拒绝
    const mvBad = callBp({ post: postHead(['wbs-server/utils/x.js', 'wbs-server/scripts/sysbuild-step1/inv-parse.js']) });
    const mvBadMsg = headProblem(mvBad, /两个提交之间改动了「不加载白名单」以外的路径：/);
    check(!!mvBadMsg && mvBadMsg.includes('wbs-server/utils/x.js') && !mvBadMsg.includes('inv-parse'), '来源清单 (a)：运行期间 HEAD 变了、差异里有白名单以外的路径（wbs-server/utils/x.js）→ 拒绝，并点名它；白名单内的 inv-parse.js 不算');
    const mvNew = callBp({ post: postHead(['wbs-server/scripts/sysbuild-step1/new-tool.js']) });
    check(!!headProblem(mvNew, /不加载白名单」以外的路径：wbs-server\/scripts\/sysbuild-step1\/new-tool\.js/), '来源清单 (a) / MED-2：sysbuild-step1 里新加的、不在白名单上的文件出现在 HEAD 差异里 → 拒绝（白名单是显式列表，不是「除两个以外默认放行」）');
    const mvOk = callBp({ post: postHead(NOT_LOADED_WHITELIST.slice()) });
    check(!headProblem(mvOk, /HEAD 变了/) && mvOk.doc.repoHeadMovedDuringRun === true && JSON.stringify(mvOk.doc.repoHeadMovePaths) === JSON.stringify(NOT_LOADED_WHITELIST), '来源清单 (a) 对照：HEAD 变了、差异只含白名单里的四个文件 → 不拒绝，差异路径记进清单');
    const mvUnknown = callBp({ post: postHead(null) });
    check(!!headProblem(mvUnknown, /读不到两个提交之间改动的路径/), '来源清单 (a)：HEAD 变了但读不到两个提交之间的差异 → 拒绝（不放行）');
    const mvStill = callBp({ post: { ...preS } });
    check(!headProblem(mvStill, /HEAD 变了/) && mvStill.doc.repoHeadMovedDuringRun === false && mvStill.doc.repoHeadMovePaths === null, '来源清单 (a) 对照：HEAD 没动 → 不查差异');
    // (b) 工作区硬门
    const stPre = callBp({ pre: { ...preS, workingTree: [' M docs/x.md'] } });
    check(!!headProblem(stPre, /（跑之前）：docs\/x\.md/), '来源清单 (b)：跑之前 tmp/ 以外的脏路径（docs/x.md）→ 拒绝');
    const stPost = callBp({ post: { ...preS, workingTree: ['?? notes/a.txt'] } });
    check(!!headProblem(stPost, /（跑完之后）：notes\/a\.txt/), '来源清单 (b)：跑完之后出现 tmp/ 以外的未跟踪路径（notes/a.txt）→ 拒绝');
    const stOk = { ...preS, workingTree: ['?? tmp/a.log', ' M wbs-server/utils/u.js', 'A  tmp/b'] };
    check(strayDirtyPaths(stOk).length === 0 && !callBp({ pre: stOk }).problems.some((x) => /工作区有 tmp\//.test(x)), '来源清单 (b) 对照：tmp/ 下的路径、已记哈希集合里的脏文件（wbs-server/utils/u.js）→ 不算');
    check(JSON.stringify(strayDirtyPaths({ ...preS, workingTree: ['R  wbs-server/utils/u.js -> docs/moved.md', '?? "tmpx/q"', ' D wbs-server/utils/gone.js'] })) === JSON.stringify(['docs/moved.md', 'tmpx/q', 'wbs-server/utils/gone.js']), '来源清单 (b)：改名行取两端、去引号；tmpx/ 不是 tmp/；已删除且不在哈希集合里的文件也算');
    // (c) 脏的被加载文件：已记哈希（脏着不拒绝），但运行前后哈希变了就拒绝
    put('wbs-server/utils/u.js', '// u2\n');
    const dirtyU = snapshotInputs(P);
    const uRec = dirtyU.testFiles.find((x) => x.path === 'wbs-server/utils/u.js');
    check(!!uRec && uRec.gitHashObject !== blobOf('wbs-server/utils/u.js') && uRec.gitHashObject === git(P, ['hash-object', '--', 'wbs-server/utils/u.js']).stdout.trim() && snapshotProblems(dirtyU, '测试').length === 0, '来源清单 (c)：脏着的被加载文件（wbs-server/utils/u.js 有未提交改动）→ 进清单并记下当前哈希（与已提交 blob 不同），不因为「脏」拒绝');
    put('wbs-server/utils/u.js', '// u\n');
    const uChanged = callBp({ post: { ...preS, testFiles: preS.testFiles.map((x) => (x.path === 'wbs-server/utils/u.js' ? { ...x, sha256: 'f'.repeat(64) } : x)) } });
    check(!!headProblem(uChanged, /测试 \/ 驱动文件在运行期间变了：wbs-server\/utils\/u\.js/), '来源清单 (c)：被加载的 wbs-server/utils/u.js 运行前后哈希不一致 → 拒绝，并点名');
    const newTool = callBp({ pre: { ...preS, testFiles: [stepFile('new-tool.js', 'a')] }, post: { ...preS, testFiles: [stepFile('new-tool.js', 'b')] } });
    check(!!headProblem(newTool, /运行期间变了：wbs-server\/scripts\/sysbuild-step1\/new-tool\.js/) && newTool.doc.testFilesChangedDuringRun.notLoadedByRun.length === 0, '来源清单 MED-2：sysbuild-step1 里不在白名单的新文件运行期间变了 → 当作被加载的文件拒绝（不是只记录）');
    // MED-2：白名单文件进了 require.cache → 拒绝
    const cacheHit = callBp({ post: { ...preS }, cache: { [path.join(P, 'wbs-server', 'scripts', 'sysbuild-step1', 'inv-parse.js')]: {} } });
    const cacheHitDefault = callBp({ post: { ...preS }, cache: { [path.join(DEFAULT_REPO, 'wbs-server', 'scripts', 'sysbuild-step1', 'xref-exports.js')]: {} } });
    const cacheNone = callBp({ post: { ...preS }, cache: { [path.join(P, 'wbs-server', 'scripts', 'sysbuild-step1', 'w.js')]: {} } });
    check(!!headProblem(cacheHit, /require\.cache.*wbs-server\/scripts\/sysbuild-step1\/inv-parse\.js/) && !!headProblem(cacheHitDefault, /require\.cache.*wbs-server\/scripts\/sysbuild-step1\/xref-exports\.js/) && !headProblem(cacheNone, /require\.cache/) && cacheNone.doc.whitelistInRequireCache.length === 0, '来源清单 MED-2：白名单里的文件（inv-parse.js / xref-exports.js）出现在构建进程的 require.cache 里（本仓库或脚本所在仓库的路径）→ 拒绝；不在白名单的文件 / 空缓存不触发');
    check(JSON.stringify(NOT_LOADED_WHITELIST) === JSON.stringify(['wbs-server/scripts/sysbuild-step1/build-impl-list.js', 'wbs-server/scripts/sysbuild-step1/build-test-disposition.js', 'wbs-server/scripts/sysbuild-step1/inv-parse.js', 'wbs-server/scripts/sysbuild-step1/xref-exports.js']) && !isNotLoadedByRun('wbs-server/scripts/sysbuild-step1/new-tool.js') && !isNotLoadedByRun('wbs-server/scripts/sysbuild-step1/mutation-check.js') && !isNotLoadedByRun('wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js'), 'MED-2：「运行时不加载」白名单恰是四个明确列出的文件；mutation-check.js / build-mutation-baseline.js / 新文件都不在其中');
    // 被忽略的运行输入：task_pool.db 前后不一致 → 拒绝；.sdh-instance 只记录；旧清单 / 旧快照没有这个字段时不报错
    const dbChanged = callBp({ post: { ...preS, ignoredInputs: { ...preS.ignoredInputs, taskPoolDb: { exists: true, bytes: 14, sha256: 'f'.repeat(64) } } } });
    const instChanged = callBp({ post: { ...preS, ignoredInputs: { ...preS.ignoredInputs, sdhInstance: { exists: true, sha256: 'e'.repeat(64) } } } });
    const dbSame = callBp({ post: { ...preS } });
    const legacyPre = callBp({ pre: { ...preS, ignoredInputs: undefined }, post: { ...preS } });
    check(!!headProblem(dbChanged, /wbs-server\/task_pool\.db 在运行期间变了/) && !headProblem(instChanged, /task_pool\.db/) && !headProblem(dbSame, /task_pool\.db/) && !headProblem(legacyPre, /task_pool\.db/) && dbSame.doc.ignoredInputs.before.taskPoolDb.sha256 === sha256Of(Buffer.from('fake-db-bytes')) && dbSame.doc.ignoredInputs.after.sdhInstance.exists === true && legacyPre.doc.ignoredInputs.before === null, '被忽略的运行输入：task_pool.db 字节数 / sha256 运行前后不一致 → 拒绝；.sdh-instance 变了只记录；没变 / 旧快照没有这个字段 → 不拒绝，清单里记跑前跑后各一份');
    // L6：--parallel-browser 写进新生成的清单
    const pbRun = callBp({ post: { ...preS }, o: { parallelBrowser: true } });
    const pbParse = callBp({ post: null, o: { parseOnly: raw, parallelBrowser: true } });
    check(pbRun.doc.parallelBrowser === true && pbParse.doc.parallelBrowser === null && callBp({ post: { ...preS } }).doc.parallelBrowser === false, 'L6：--parallel-browser 写进新生成的来源清单（run 模式 true / 没给 false；parse-only 记 null，因为不是这次跑的）');
    // (a) 的真实 git 差异：HEAD 往前走了两个提交
    const head0 = git(P, ['rev-parse', 'HEAD']).stdout.trim();
    put('wbs-server/scripts/lib/other.js', '// o2\n');
    put('wbs-server/scripts/sysbuild-step1/inv-parse.js', '// ip\n');
    git(P, ['add', 'wbs-server/scripts/lib/other.js', 'wbs-server/scripts/sysbuild-step1/inv-parse.js']);
    git(P, ['commit', '-q', '-m', 'second']);
    check(JSON.stringify(headMovePaths(P, head0, 'HEAD')) === JSON.stringify(['wbs-server/scripts/lib/other.js', 'wbs-server/scripts/sysbuild-step1/inv-parse.js']) && headMovePaths(P, head0, head0).length === 0 && headMovePaths(P, '0'.repeat(40), 'HEAD') === null, '来源清单 (a)：headMovePaths 用 git diff --name-only 取两个提交之间改动的路径；HEAD 没动 → []；提交号不存在 → null');
  }
  for (const d of tmpRepos2) { try { removeTree(d); } catch (e) { console.error('  [清理] ' + d + ' ' + e.message); } }

  // R1（codex 81 号 HIGH-1 / HIGH-2）：生效清单——schema 校验、去向表核对、复验计划（纯函数部分；整条 CLI 在后面的闸门段）
  {
    const K = (id, g) => (g || 'api') + '\u0000' + id;
    // 84 号 MEDIUM-2：增删按 <S> 时登记核对（sKeys），不再按固定基线；纯函数自检里 <S> 时登记 = A1..A5 + B1
    const baseK = new Set([K('A1'), K('A2'), K('A3'), K('A4'), K('A5'), K('B1', 'static')]);
    const curK = new Set([K('A1'), K('A2'), K('N1'), K('N2'), K('B1', 'static')]);
    const ctxV = { groups: ALL_GROUPS, sKeys: baseK, currentKeys: curK };
    const Rf = (id, g) => ({ group: g || 'api', id });
    const doc = (over) => ({ format: effList.FORMAT, commit: 'C2', mustRun: [Rf('A2')], retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('N1')] }, { ...Rf('A4'), category: 'stop-only' }, { ...Rf('A5'), category: 'remount', newId: Rf('N2') }], added: [{ ...Rf('N1'), note: '承接 A3 的新增接口变异' }], ...(over || {}) });
    const good = effList.validateEffective(doc(), ctxV);
    check(good.problems.length === 0 && !!good.eff && good.eff.required.map((r) => r.source + ':' + r.id).join() === 'mustRun:A2,by:N1,remount:N2,added:N1' && good.eff.retire.length === 3 && good.eff.added.length === 1 && good.eff.retiredKeys.size === 3 && good.eff.commit === 'C2', '生效清单 schema 正例（含 added）：mustRun 1 条 + retire 三类各一条（等价承接 / 只测停用 / 改挂）+ added 1 条（新增的承接变异 N1，同时被 by 引用——C2 的 N4 承接 M721 就是这种组合）→ 通过；required 按 mustRun、by、remount、added 的顺序列出');
    const noAdded = { format: effList.FORMAT, commit: 'C2', mustRun: [Rf('A2')], retire: [{ ...Rf('A3'), category: 'stop-only' }, { ...Rf('A4'), category: 'stop-only' }, { ...Rf('A5'), category: 'remount', newId: Rf('N2') }] };
    check(effList.validateEffective(noAdded, { ...ctxV, currentKeys: new Set([K('A1'), K('A2'), K('N2'), K('B1', 'static')]) }).eff !== null, '生效清单 schema：added 可省略（= 空）——当前登记里新增的编号只有 remount 的 newId（N2）时通过');
    const badV = (label, d, re, ctx) => { const v = effList.validateEffective(d, ctx || ctxV); check(v.eff === null && v.problems.some((p) => re.test(p)), `生效清单 schema 拒绝：${label}`); };
    const dropKey = (k) => { const d = doc(); delete d[k]; return d; };
    badV('顶层不是对象', [], /须是 JSON 对象/);
    badV('缺顶层字段 retire', dropKey('retire'), /顶层缺字段 "retire"/);
    badV('顶层有未知字段', doc({ extra: 1 }), /顶层有未知字段 "extra"/);
    badV('format 不对', doc({ format: 'x/9' }), /format 是 "x\/9"/);
    badV('commit 是空白', doc({ commit: '  ' }), /commit（所属提交名）须是非空字符串/);
    badV('mustRun 不是数组', doc({ mustRun: 'A2' }), /mustRun 须是数组/);
    badV('mustRun、retire、added 都是空（没有生效的变异要用 --effective-none）', doc({ mustRun: [], retire: [], added: [] }), /mustRun、retire、added 都是空/);
    badV('added 不是数组', doc({ added: 'N1' }), /added 须是数组/);
    badV('added 里写了 <S> 时已有的编号（A2）', doc({ added: [Rf('N1'), Rf('A2')] }), /added\[1\] \[api\] "A2"：已在 <S> 时登记里/);
    badV('added 的编号不在当前登记里（N9）', doc({ added: [Rf('N1'), Rf('N9')] }), /added\[1\] \[api\] "N9"：不在当前登记里/);
    badV('added 里同一编号出现两次', doc({ added: [Rf('N1'), Rf('N1')] }), /added\[1\] \[api\] "N1"：重复/);
    badV('added 条目有未知字段', doc({ added: [{ ...Rf('N1'), why: 'x' }] }), /added\[0\]：有未知字段 "why"/);
    badV('added 的 note 不是字符串', doc({ added: [{ ...Rf('N1'), note: 5 }] }), /added\[0\]：note 须是字符串/);
    badV('added 与 remount 的 newId 重复（N2）', doc({ added: [Rf('N1'), Rf('N2')] }), /added \[api\] "N2"：同时是 retire \[api\] "A5" 的 newId/);
    badV('当前登记里新增了编号 N1，added 里没有声明（预筛 HIGH-1：新增的变异从未执行也放行）', doc({ added: [] }), /当前登记里有、<S> 时登记里没有的编号 \[api\] "N1" 既不在 added 里也不是 remount 的 newId/);
    badV('group 不在可用的组里', doc({ mustRun: [{ group: 'zzz', id: 'A2' }] }), /group "zzz" 不在可用的组里/);
    badV('id 是空白', doc({ mustRun: [{ group: 'api', id: ' ' }] }), /id 须是非空字符串/);
    badV('编号引用里有多余字段', doc({ mustRun: [{ group: 'api', id: 'A2', note: 'x' }] }), /有未知字段 "note"/);
    badV('mustRun 里同一编号出现两次', doc({ mustRun: [Rf('A2'), Rf('A2')] }), /mustRun\[1\] \[api\] "A2"：重复/);
    badV('mustRun 的编号不在 <S> 时登记里', doc({ mustRun: [Rf('ZZ')] }), /mustRun\[0\] \[api\] "ZZ"：不在 <S> 时登记里（mustRun 只收 <S> 时已登记且当前仍登记的变异/);
    badV('mustRun 的编号不在当前登记里（A3 <S> 时有、已删，应写进 retire）', doc({ mustRun: [Rf('A2'), Rf('A3')] }), /mustRun\[1\] \[api\] "A3"：不在当前登记里（没有东西可复验/);
    badV('retire 的 category 不在枚举里', doc({ retire: [{ ...Rf('A4'), category: 'delete' }] }), /category "delete" 不在 stop-only \/ remount \/ equivalent 里/);
    badV('retire 里同一编号出现两次', doc({ retire: [{ ...Rf('A4'), category: 'stop-only' }, { ...Rf('A4'), category: 'stop-only' }] }), /retire\[1\] \[api\] "A4"：重复/);
    badV('retire 的编号不在 <S> 时登记里', doc({ retire: [{ ...Rf('ZZ'), category: 'stop-only' }] }), /retire\[0\] \[api\] "ZZ"：不在 <S> 时登记里（只能删除 <S> 时已登记的变异）/);
    badV('retire 的编号还在当前登记里', doc({ retire: [{ ...Rf('A1'), category: 'stop-only' }] }), /retire\[0\] \[api\] "A1"：还在当前登记里/);
    badV('retire 条目有与类别不符的字段（stop-only 带 newId）', doc({ retire: [{ ...Rf('A4'), category: 'stop-only', newId: Rf('N2') }] }), /有未知字段或与类别不符的字段 "newId"/);
    badV('remount 缺 newId', doc({ retire: [{ ...Rf('A5'), category: 'remount' }] }), /retire\[0\]\.newId：须是 \{ group, id \} 对象/);
    badV('remount 的 newId 等于被删编号自身', doc({ retire: [{ ...Rf('A5'), category: 'remount', newId: Rf('A5') }] }), /newId 不能等于被删编号自身/);
    badV('remount 的 newId 已在 <S> 时登记里（要用 equivalent）', doc({ retire: [{ ...Rf('A5'), category: 'remount', newId: Rf('A2') }] }), /newId \[api\] "A2" 已在 <S> 时登记里/);
    badV('remount 的 newId 不在当前登记里', doc({ retire: [{ ...Rf('A5'), category: 'remount', newId: Rf('N9') }] }), /newId \[api\] "N9" 不在当前登记里/);
    badV('remount 带 by', doc({ retire: [{ ...Rf('A5'), category: 'remount', newId: Rf('N2'), by: [Rf('N1')] }] }), /有未知字段或与类别不符的字段 "by"/);
    badV('equivalent 的 by 是空数组', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [] }] }), /equivalent 的 by 须是非空数组/);
    badV('equivalent 缺 by', doc({ retire: [{ ...Rf('A3'), category: 'equivalent' }] }), /equivalent 的 by 须是非空数组/);
    badV('equivalent 的 by 含被删编号自身', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('A3')] }] }), /by\[0\] \[api\] "A3"：承接编号不能是被删编号自身/);
    badV('equivalent 的 by 里同一编号出现两次', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('N1'), Rf('N1')] }] }), /by\[1\] \[api\] "N1"：重复/);
    badV('equivalent 的 by 不在当前登记里', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('N9')] }] }), /by\[0\] \[api\] "N9"：不在当前登记里（承接变异必须仍已登记）/);
    badV('equivalent 的 by 本身也在 retire 里', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('A4')] }, { ...Rf('A4'), category: 'stop-only' }, { ...Rf('A5'), category: 'stop-only' }] }), /承接编号本身也在 retire 里/);
    badV('mustRun 的编号同时在 retire 里', doc({ mustRun: [Rf('A4')] }), /mustRun \[api\] "A4"：同时在 retire 里/);
    badV('<S> 时登记里消失的编号（A5）不在 retire 里（删除而不登记处置类别）', doc({ retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('N1')] }, { ...Rf('A4'), category: 'stop-only' }] }), /<S> 时登记里有、当前登记里没有的编号 \[api\] "A5" 不在 retire 里/);
    check(effList.validateEffective(doc({ retire: [{ ...Rf('A1'), category: 'stop-only' }] }), { ...ctxV, currentKeys: null }).eff !== null, '生效清单 schema 对照：不给当前登记（currentKeys = null）时不核登记相关项，只核 schema 与 <S> 时登记');
    // 84 号 MEDIUM-2：<S> 时登记与固定基线分开——C2 新增（不在固定基线里）、C3 里仍登记的编号可以做 mustRun；C3 删掉 C2 新增的编号必须在 retire 里声明
    const sC3 = new Set([K('A1'), K('A2'), K('NEW2'), K('B1', 'static')]); // <S> = C2 之后：A3..A5 已删（固定基线里有、<S> 里没有）、NEW2 是 C2 新增（固定基线里没有）
    const curC3 = new Set([K('A1'), K('A2'), K('B1', 'static')]); // 当前（C3）：C3 又删了 NEW2
    const c3Eff = (over) => ({ format: effList.FORMAT, commit: 'C3', mustRun: [Rf('A2')], retire: [], ...(over || {}) });
    check(effList.validateEffective(c3Eff({ mustRun: [Rf('A2'), Rf('A1')] }), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: new Set([K('A1'), K('A2'), K('NEW2'), K('B1', 'static')]) }).eff !== null, '84 MEDIUM-2：C3 没有增删（登记与 <S> 时登记一致）→ 清单过；固定基线里已被 C2 删掉的 A3..A5 不会被要求重新声明');
    check(effList.validateEffective(c3Eff({ mustRun: [Rf('NEW2')] }), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: new Set([K('A1'), K('A2'), K('NEW2'), K('B1', 'static')]) }).eff !== null, '84 MEDIUM-2：mustRun 可以是 C2 新增、不在固定基线里的编号（NEW2：<S> 时已登记、当前仍登记）');
    const c3del = effList.validateEffective(c3Eff(), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: curC3 });
    check(c3del.eff === null && c3del.problems.some((p) => /<S> 时登记里有、当前登记里没有的编号 \[api\] "NEW2" 不在 retire 里/.test(p)), '84 MEDIUM-2：C3 删掉 C2 新增的编号 NEW2 而清单没声明 → 拒（按固定基线看不见这次删除）');
    check(effList.validateEffective(c3Eff({ retire: [{ ...Rf('NEW2'), category: 'stop-only' }] }), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: curC3 }).eff !== null, '84 MEDIUM-2：C3 在 retire 里声明删掉 NEW2（<S> 时有、当前没有）→ 过');
    const c3add = effList.validateEffective(c3Eff(), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: new Set([K('A1'), K('A2'), K('NEW2'), K('B1', 'static'), K('NEW3')]) });
    check(c3add.eff === null && c3add.problems.some((p) => /当前登记里有、<S> 时登记里没有的编号 \[api\] "NEW3" 既不在 added 里也不是 remount 的 newId/.test(p)), '84 MEDIUM-2：C3 新增 NEW3 而不声明 → 拒；声明在 added 里则过');
    check(effList.validateEffective(c3Eff({ added: [Rf('NEW3')] }), { groups: ALL_GROUPS, sKeys: sC3, currentKeys: new Set([K('A1'), K('A2'), K('NEW2'), K('B1', 'static'), K('NEW3')]) }).eff !== null, '84 MEDIUM-2：新增的 NEW3 声明在 added 里 → 过');
    // 84 号 LOW-2：一个新编号同时是 remount 的 newId 与 equivalent 的 by —— 允许，只在改挂项里声明；再写进 added 被拒
    const sLow = new Set([K('A1'), K('A3'), K('A5')]);
    const curLow = new Set([K('A1'), K('N2')]);
    const lowDoc = (added) => ({ format: effList.FORMAT, commit: 'C2', mustRun: [Rf('A1')], retire: [{ ...Rf('A3'), category: 'equivalent', by: [Rf('N2')] }, { ...Rf('A5'), category: 'remount', newId: Rf('N2') }], ...(added ? { added } : {}) });
    const lowOk = effList.validateEffective(lowDoc(), { groups: ALL_GROUPS, sKeys: sLow, currentKeys: curLow });
    const lowDup = effList.validateEffective(lowDoc([Rf('N2')]), { groups: ALL_GROUPS, sKeys: sLow, currentKeys: curLow });
    check(lowOk.eff !== null && lowOk.eff.required.map((r) => r.source + ':' + r.id).join() === 'mustRun:A1,by:N2,remount:N2' && lowDup.eff === null && lowDup.problems.some((p) => /added \[api\] "N2"：同时是 retire \[api\] "A5" 的 newId[^\n]*只在改挂项里声明/.test(p)), '84 LOW-2：新编号 N2 同时是 remount 的 newId 与另一条 equivalent 的 by → 允许，只在改挂项里声明（required 里 by 与 remount 各列一次）；再写进 added → 拒，提示只在改挂项里声明');
    const noneP = (b, c, paths) => effList.noneModeProblems(new Set(b.map((x) => K(x))), new Set(c.map((x) => K(x))), paths || []);
    check(noneP(['A1', 'A2'], ['A1', 'A2']).length === 0 && noneP(['A1', 'A2'], ['A1']).length === 1 && /\[api\] "A2"：<S> 时登记里有、当前登记里没有，但本次给的是 --effective-none/.test(noneP(['A1', 'A2'], ['A1'])[0]), '--effective-none 模式：登记与 <S> 时登记完全一致 → 通过；有编号消失 → 拒绝并点名（删除变异必须给生效清单）');
    check(noneP(['A1', 'A2'], ['A1', 'A2', 'N1']).length === 1 && /\[api\] "N1"：当前登记里有、<S> 时登记里没有，但本次给的是 --effective-none（新增变异必须给生效清单并在 added 里声明）/.test(noneP(['A1', 'A2'], ['A1', 'A2', 'N1'])[0]), '--effective-none 模式（预筛 HIGH-1）：当前登记里多出 <S> 时没有的编号（新增变异）→ 拒绝并点名');
    // 84 号 HIGH-3：--effective-none 适用范围——改动集只许落在工具 / 文档白名单内
    const okPaths = ['wbs-server/scripts/sysbuild-step1/build-mutation-baseline.js', 'wbs-server/scripts/sysbuild-step1/effective-list.js', 'docs/local/a/b.md', 'docs/x.html', 'README.md', 'CLAUDE.md'];
    const badPaths = ['wbs-server/routes/README.md', 'wbs-server/scripts/lib/NOTES.md', 'scripts/sysbuild-predeploy/README.md', '.gitignore','wbs-server/routes/sysbuild/rules.js', 'wbs-server/public/assets/js/a.js', 'wbs-server/server.js', 'wbs-server/routes/sysbuild/schema.js', 'wbs-server/scripts/verify-sysbuild-api.js', 'wbs-server/scripts/lib/sysbuild-api-suite.js', 'scripts/sysbuild-predeploy/cli.cjs', 'wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json', 'wbs-server/scripts/sysbuild-step1x/evil.js', 'docs_extra/x.js'];
    check(effList.noneScopeProblems(okPaths).length === 0 && effList.noneScopeProblems([]).length === 0 && noneP(['A1'], ['A1'], okPaths).length === 0, '84 HIGH-3 正例：改动集全在 wbs-server/scripts/sysbuild-step1/**、docs/**、*.md 里（含 docs 下的 .html、仓库根目录的 .md）→ --effective-none 放行');
    const scopeBad = badPaths.map((p) => effList.noneScopeProblems(['docs/a.md', p]));
    check(scopeBad.every((r, i) => r.length === 1 && r[0].includes(badPaths[i]) && !r[0].includes('docs/a.md') && /--effective-none 只适用于改动集全部落在工具 \/ 文档白名单内/.test(r[0])) && noneP(['A1'], ['A1'], ['docs/a.md', 'wbs-server/routes/sysbuild/rules.js']).length === 1, '84 HIGH-3 反例：产品代码（routes / public / server.js / schema.js）、测试驱动与套件（verify-*.js / scripts/lib / sysbuild-predeploy）、固定基线、前缀相似的路径（sysbuild-step1x/、docs_extra/）各夹在合法路径里 → 都被点名拒绝；noneModeProblems 把它并进问题清单');
    check(noneP(['A1', 'A2'], ['A1'], ['wbs-server/routes/sysbuild/rules.js']).length === 2, '84 HIGH-3：登记有增删 + 改动路径越界，两类问题都报');
    // 预筛复看 1：带 reason 的全空清单不能用于改了产品 / 测试路径的提交（PRODUCT_TEST_PATHS，none 白名单的反面）
    const emptyEff = effList.validateEffective({ format: effList.FORMAT, commit: 'C9', reason: '说明', mustRun: [], retire: [] }, { groups: ALL_GROUPS, sKeys: curK, currentKeys: curK }).eff;
    const fullEff = effList.validateEffective(doc(), ctxV).eff;
    const ptSamples = ['wbs-server/routes/sysbuild/rules.js', 'wbs-server/public/assets/js/a.js', 'wbs-server/server.js', 'wbs-server/utils/x.js', 'wbs-server/scripts/verify-sysbuild-api.js', 'wbs-server/scripts/lib/sysbuild-api-suite.js', 'scripts/sysbuild-predeploy/cli.cjs', 'wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json',
      // 94 号 HIGH-4：schema.js（本仓库实际位置 routes/sysbuild/schema.js，在 routes/ 前缀下；wbs-server/schema.js 与根级文件一并入名单）、依赖清单、共用夹具、scripts/lines、deploy-ssh.ps1、大小写别名
      'wbs-server/routes/sysbuild/schema.js', 'wbs-server/schema.js', 'wbs-server/package.json', 'wbs-server/package-lock.json', 'package.json', 'wbs-server/scripts/_test-fixture.js', 'scripts/lines/line-new.js', 'scripts/deploy-ssh.ps1', 'wbs-server/other-root.js', 'WBS-Server/Routes/Sysbuild/Schema.js'];
    check(!!emptyEff && ptSamples.every((p) => effList.emptyListScopeProblems(emptyEff, ['.gitignore', p]).length === 1 && effList.emptyListScopeProblems(emptyEff, ['.gitignore', p])[0].includes(p) && effList.noneScopeProblems([p]).length === 1) && effList.emptyListScopeProblems(emptyEff, ['.gitignore']).length === 0 && effList.emptyListScopeProblems(emptyEff, ['docs/a.md', 'README.md', 'wbs-server/scripts/sysbuild-step1/effective-list.js']).length === 0 && effList.emptyListScopeProblems(emptyEff, []).length === 0 && effList.emptyListScopeProblems(fullEff, ['wbs-server/routes/sysbuild/rules.js']).length === 0 && /必须有至少一条经人确认的清单条目/.test(effList.emptyListScopeProblems(emptyEff, ['wbs-server/routes/sysbuild/rules.js'])[0]) && effList.PRODUCT_TEST_PATHS.prefixes.length === 7 && effList.emptyListScopeProblems(emptyEff, ['.gitignore', '.github/workflows/x.yml', 'wbs-server/API.md']).length === 0, '预筛复看 1 + 94 号 HIGH-4：全空清单（只靠 reason）+ 改动集含产品 / 测试路径（routes / public / server.js / utils / verify-*.js / scripts/lib / sysbuild-predeploy / fixtures 各一）→ 拒，且这些路径同样不在 none 白名单里；只改 .gitignore / 文档 / 工具目录 → 过；非空清单不受此限');
    // 预筛 LOW：白名单里 *.md 收窄为仓库根目录；fixtures 不进白名单；.gitignore 等走清单
    check(effList.noneScopeProblems(['README.md']).length === 0 && effList.noneScopeProblems(['wbs-server/routes/README.md']).length === 1 && effList.noneScopeProblems(['wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json']).length === 1 && effList.noneScopeProblems(['.gitignore']).length === 1 && effList.noneScopeProblems(['docs/a/b/c.md']).length === 0, '预筛 LOW：none 白名单的 .md 只认仓库根目录（README.md 放行；routes/README.md 拒）；fixtures（改基线）与 .gitignore 不在白名单里，必须走清单');
    // 预筛 MED：mustRun / retire / added 全空的清单必须带非空 reason；带 reason 照常过，reason 写进 eff
    const emptyDoc = (over) => ({ format: effList.FORMAT, commit: 'C9', mustRun: [], retire: [], ...(over || {}) });
    const emptyNo = effList.validateEffective(emptyDoc(), ctxV);
    const emptyBlank = effList.validateEffective(emptyDoc({ reason: '  ' }), ctxV);
    const emptyNum = effList.validateEffective(emptyDoc({ reason: 5 }), ctxV);
    const emptyOk = effList.validateEffective(emptyDoc({ reason: '只改 .gitignore' }), { groups: ALL_GROUPS, sKeys: curK, currentKeys: curK });
    const emptyDel = effList.validateEffective(emptyDoc({ reason: '只改 .gitignore' }), ctxV);
    const reasonOnFull = effList.validateEffective(doc({ reason: '附带说明' }), ctxV);
    check(emptyNo.eff === null && /全空的清单必须带非空的 "reason" 字段/.test(emptyNo.problems.join()) && emptyBlank.eff === null && /reason 须是非空字符串/.test(emptyBlank.problems.join()) && emptyNum.eff === null && /reason 须是非空字符串/.test(emptyNum.problems.join()) && emptyOk.eff !== null && emptyOk.eff.reason === '只改 .gitignore' && emptyOk.eff.required.length === 0 && emptyOk.eff.retiredKeys.size === 0 && emptyDel.eff === null && /<S> 时登记里有、当前登记里没有的编号/.test(emptyDel.problems.join()) && reasonOnFull.eff !== null && reasonOnFull.eff.reason === '附带说明' && good.eff.reason === null, '预筛 MED：全空清单无 reason / reason 空白 / 不是字符串 → 拒；带非空 reason 且登记无增删 → 过（reason 进 eff）；带 reason 但 <S> 时登记里有编号消失 → 照拒（硬门照跑）；非空清单可选带 reason');
    // 84 号 MEDIUM：重复对象键（顶层与嵌套）从原始 JSON 文本检测
    const dupT = (text) => effList.duplicateKeys(text);
    check(dupT('{"a":1,"b":{"c":1,"d":2},"e":[{"x":1},{"y":2}]}').length === 0 && dupT('{"mustRun":[],"mustRun":[]}').join() === '$.mustRun' && dupT('{"retire":[{"group":"api","id":"A","id":"B"}]}').join() === '$.retire[0].id' && dupT('{"a":{"b":1,"b":2},"a":3}').join() === '$.a.b,$.a' && dupT('{"s":"含 \\" 引号与 \\\\ 反斜杠","s2":"x","s":"y"}').join() === '$.s' && dupT('[{"k":1},{"k":2}]').length === 0, '重复对象键检测：无重复 → 空；顶层 mustRun 写两处、嵌套 { group, id } 里 id 写两处、不同层级的同名键各自计、字符串里带引号 / 反斜杠不误判、数组里不同对象的同名键不算重复');
    const dupFile = path.join(os.tmpdir(), 'sysbuild-dupkey-' + process.pid + '.json');
    fs.writeFileSync(dupFile, '{"format":"sysbuild-effective-list/1","commit":"C2","mustRun":[{"group":"api","id":"X1"}],"mustRun":[],"retire":[]}');
    let dupErr = null;
    try { effList.readEffectiveFile(dupFile); } catch (e) { dupErr = e.message; }
    fs.writeFileSync(dupFile, '{"format":"sysbuild-effective-list/1","commit":"C2","mustRun":[{"group":"api","id":"X1"}],"retire":[]}');
    const okRead = effList.readEffectiveFile(dupFile);
    fs.unlinkSync(dupFile);
    check(/重复的对象键.*\$\.mustRun/.test(String(dupErr)) && okRead.doc.mustRun[0].id === 'X1' && /^[0-9a-f]{64}$/.test(okRead.sha256), '读生效清单（readEffectiveFile）：重复对象键 → 抛错并点名路径（而不是静默保留最后一个值）；无重复 → 正常读，sha256 取原始字节');
    // 84 号 LOW-2：去向字段只认非空字符串，不做 String() 转换
    check(effList.destOf({ 去向: ' x ' }) === 'x' && effList.destOf({ destination: 'y' }) === 'y' && [null, 7, {}, ['a'], true].every((v) => effList.destOf({ 去向: v }) === '') && effList.destOf({}) === '', '去向字段（destOf）：只认非空字符串（去首尾空白）；null / 数字 / 对象 / 数组 / 布尔都当空');

    // 去向表：retire 的每个旧编号恰好一行，带对应处置类别与字段
    const eff = good.eff;
    const dGood = [
      { 提交: 'C2', group: 'api', id: 'A3', 去向: '由 N1 承接', 处置类别: 'equivalent', 现行编号: ['N1'], 等价业务错误: '停用后仍可建项应返回 409', 承接命中证据: 'ev' },
      { 提交: 'C2', group: 'api', id: 'A4', 去向: '删除', 处置类别: 'stop-only', 删除依据: '只测旧流程停用行为' },
      { 提交: 'C2', group: 'api', id: 'A5', 去向: '改挂 N2', 处置类别: 'remount', 现行编号: 'N2' },
    ];
    const dp = (list) => effList.retireDispositionProblems(eff, list);
    const dMod = (id, over) => dGood.map((d) => (d.id === id ? { ...d, ...over } : d));
    const dDrop = (id) => dGood.filter((d) => d.id !== id);
    check(dp(dGood).length === 0 && dp(dMod('A3', { 现行编号: 'N1' })).length === 0 && dp(dMod('A3', { 现行编号: [{ group: 'api', id: 'N1' }] })).length === 0 && dp(dMod('A5', { 现行编号: { group: 'api', id: 'N2' } })).length === 0, '去向表正例：三类登记行齐全 → 无问题；现行编号写字符串 / 数组 / { group, id } 都认');
    const dBad = (label, list, re) => { const p = dp(list); check(p.length > 0 && p.some((x) => re.test(x)), `去向表拒绝：${label}`); };
    dBad('retire 的旧编号没有登记行（A4）', dDrop('A4'), /retire \[api\] "A4"（stop-only）：去向表里没有「提交」= "C2" 的登记行/);
    dBad('同一旧编号两行', [...dGood, dGood[1]], /retire \[api\] "A4"（stop-only）：去向表里「提交」= "C2" 的行有 2 行（应恰好一行）/);
    dBad('处置类别与生效清单不符（A5 是 remount，登记成 stop-only）', dMod('A5', { 处置类别: 'stop-only' }), /retire \[api\] "A5"（remount）：登记行的「处置类别」是 "stop-only"，生效清单里是 "remount"/);
    dBad('登记行没有处置类别', dMod('A4', { 处置类别: undefined }), /retire \[api\] "A4"（stop-only）：登记行的「处置类别」是 undefined/);
    dBad('「去向」为空', dMod('A4', { 去向: '  ' }), /retire \[api\] "A4"（stop-only）：登记行的「去向」为空/);
    dBad('stop-only 缺删除依据', dMod('A4', { 删除依据: '' }), /retire \[api\] "A4"（stop-only）：登记行缺「删除依据」/);
    dBad('remount 缺现行编号', dMod('A5', { 现行编号: undefined }), /retire \[api\] "A5"（remount）：登记行缺「现行编号」/);
    dBad('remount 的现行编号与 newId 不符', dMod('A5', { 现行编号: 'N9' }), /retire \[api\] "A5"（remount）：登记行的「现行编号」\["N9"\] 与生效清单里的 \["N2"\] 不全等/);
    dBad('equivalent 的现行编号只写了一部分 / 多写了别的', dMod('A3', { 现行编号: ['N1', 'N2'] }), /retire \[api\] "A3"（equivalent）：登记行的「现行编号」\["N1","N2"\] 与生效清单里的 \["N1"\] 不全等/);
    dBad('equivalent 缺等价业务错误', dMod('A3', { 等价业务错误: ' ' }), /retire \[api\] "A3"（equivalent）：登记行缺「等价业务错误」/);
    dBad('equivalent 缺承接命中证据', dMod('A3', { 承接命中证据: undefined }), /retire \[api\] "A3"（equivalent）：登记行缺「承接命中证据」/);
    dBad('本次提交的行里带处置类别、编号却不在 retire 里', [...dGood, { 提交: 'C2', group: 'api', id: 'A1', 去向: 'x', 处置类别: 'stop-only', 删除依据: 'y' }], /去向表 \[api\] "A1"：「提交」= "C2"、带「处置类别」，但该编号不在生效清单的 retire 里/);
    // 去向表是跨提交累计的文件（协调方更正）：每行带「提交」；退役类核对只看「提交」= 本次清单 commit 的行；其他提交的退役行忽略
    const eff3 = effList.validateEffective({ format: effList.FORMAT, commit: 'C3', mustRun: [Rf('A1')], retire: [] }, { groups: ALL_GROUPS, sKeys: null, currentKeys: null }).eff;
    const cumTable = [...dGood, { 提交: 'C2', group: 'api', id: 'A1', 去向: 'C2 里变了', 业务步骤: 'a', 未变异通过证据: 'b', 变异后命中证据: 'c' }];
    check(!!eff3 && effList.retireDispositionProblems(eff3, cumTable).length === 0 && effList.retireDispositionProblems(eff3, cumTable, { requireEvidence: false }).length === 0, '累计去向表（C3 场景）：表里有 C2 的三条退役行与 C2 的「变了」行，C3 清单无增删 → 过（其他提交的退役行忽略，不报「多余类别」）');
    const eff3b = effList.validateEffective({ format: effList.FORMAT, commit: 'C3', mustRun: [], retire: [{ ...Rf('A3'), category: 'stop-only' }] }, { groups: ALL_GROUPS, sKeys: null, currentKeys: null }).eff;
    const p3b = effList.retireDispositionProblems(eff3b, cumTable);
    const p3c = effList.retireDispositionProblems(eff, [...dGood, { group: 'api', id: 'A9', 去向: 'x', 处置类别: 'stop-only', 删除依据: 'y' }]);
    check(p3b.length === 1 && /retire \[api\] "A3"（stop-only）：去向表里没有「提交」= "C3" 的登记行（别的提交的行不算）/.test(p3b[0]) && p3c.length === 1 && /去向表 \[api\] "A9"：带「处置类别」却没有「提交」字段/.test(p3c[0]), '累计去向表：本次 retire 缺本次「提交」行（只有 C2 的行）→ 拒；带「处置类别」却没有「提交」字段的行 → 拒');

    // 复验计划：自动范围 ∪ mustRun ∪ by ∪ remount 新编号（HIGH-1 / HIGH-2 的核心）
    const PE = (g, id, files) => ({ group: g, id, files, expect: null, verdict: '判红', failures: [] });
    const RULES = 'wbs-server/routes/sysbuild/rules.js';
    const OTHER = 'wbs-server/routes/sysbuild/other.js';
    const pBase = [PE('api', 'T1', [RULES]), PE('api', 'T2', [OTHER]), PE('browser', 'TB', [OTHER]), PE('api', 'T3', [OTHER])];
    const mkEff = (d, k) => effList.validateEffective(d, { groups: ALL_GROUPS, baselineKeys: new Set(pBase.map((e) => e.group + '\u0000' + e.id)), currentKeys: k }).eff;
    const effRun = mkEff({ format: effList.FORMAT, commit: 'C2', mustRun: [Rf('T2')], retire: [{ ...Rf('T3'), category: 'equivalent', by: [Rf('N1')] }], added: [Rf('N1')] }, new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000N1']));
    const p0 = rerunPlan(pBase, new Set([RULES]), null);
    const p1 = rerunPlan(pBase, new Set([RULES]), effRun);
    check(!!effRun && JSON.stringify(p0.groups.get('api')) === JSON.stringify({ auto: ['T1'], mustRun: [], by: [], remount: [], added: [], runIds: ['T1'] }) && p0.groups.size === 1, '复验计划：没有生效清单 → 只有自动范围（与改造前一致：只改 rules.js，只复验目标是 rules.js 的 T1）');
    check(JSON.stringify(p1.groups.get('api')) === JSON.stringify({ auto: ['T1'], mustRun: ['T2'], by: ['N1'], remount: [], added: ['N1'], runIds: ['T1', 'T2', 'N1'] }), '复验计划（81 HIGH-1 / HIGH-2）：T2 不在自动范围（目标文件 other.js 没改）、N1 是新增的承接变异（不在基线）——生效清单把它们并进复验集合，来源分别记 mustRun / by / added；retire 的 T3 不在集合里');
    // 预筛 HIGH-1：给了当前登记（currentKeys）时，「当前登记有、基线没有」的编号自动并入复验集合（来源 added），不论生效清单声没声明
    const curK3 = new Set(['api\u0000T1', 'api\u0000T2', 'api\u0000T3', 'browser\u0000TB', 'api\u0000N3', 'browser\u0000NB']);
    const p3 = rerunPlan(pBase, new Set(['docs/x.md']), null, curK3);
    check(JSON.stringify(p3.groups.get('api')) === JSON.stringify({ auto: [], mustRun: [], by: [], remount: [], added: ['N3'], runIds: ['N3'] }) && JSON.stringify(p3.groups.get('browser').added) === '["NB"]' && p3.groups.size === 2, '复验计划（预筛 HIGH-1）：登记里新增了 N3（api）与 NB（browser），没有生效清单声明、也没有文件改动 → 仍自动并入复验集合（来源 added）');
    const p4 = rerunPlan(pBase, new Set(['docs/x.md']), effRun, new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000N1', 'api\u0000N7']));
    check(JSON.stringify(p4.groups.get('api').added) === '["N1","N7"]' && p4.groups.get('api').runIds.join() === 'T2,N1,N7', '复验计划（预筛 HIGH-1）：登记里多出的 N7 没在 added 里声明 → 计划仍并入它（added 先列登记里新增的、再补清单里声明的，去重）；runIds 与来源并集一致');
    const effDup = mkEff({ format: effList.FORMAT, commit: 'C2', mustRun: [Rf('T1')], retire: [{ ...Rf('T3'), category: 'equivalent', by: [Rf('T1')] }] }, new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB']));
    check(JSON.stringify(rerunPlan(pBase, new Set([RULES]), effDup).groups.get('api')) === JSON.stringify({ auto: ['T1'], mustRun: ['T1'], by: ['T1'], remount: [], added: [], runIds: ['T1'] }), '复验计划：同一编号既在自动范围又在 mustRun / by 里 → runIds 里只出现一次，三个来源各自如实列出');
    const effRetire = mkEff({ format: effList.FORMAT, commit: 'C2', mustRun: [Rf('T2')], retire: [{ ...Rf('T1'), category: 'stop-only' }] }, new Set(['api\u0000T2', 'browser\u0000TB', 'api\u0000T3']));
    const p2 = rerunPlan(pBase, new Set([RULES]), effRetire);
    check(p2.live.length === 3 && p2.live.every((e) => e.id !== 'T1') && JSON.stringify(p2.groups.get('api').auto) === JSON.stringify(['T2', 'T3']) && JSON.stringify(p2.groups.get('browser').auto) === JSON.stringify(['TB']) && JSON.stringify(p2.groups.get('api').runIds) === JSON.stringify(['T2', 'T3']), '复验计划：retire 的 T1 不进复验集合（已不在登记里）；它原是 rules.js 唯一的变异目标，删除之后 rules.js 没有变异保护——按去掉 retire 之后的基线算，兜底触发 api + browser 整组（T2、T3、TB）');
    check(JSON.stringify(Array.from(rerunPlan(pBase, new Set(['docs/x.md']), effRun).groups.keys())) === '["api"]' && rerunPlan(pBase, new Set(['docs/x.md']), effRun).groups.get('api').runIds.join() === 'T2,N1', '复验计划：改动与基线无交集时，仍复验生效清单里的 mustRun 与 by（T2、N1）');
    // 84 MEDIUM-2：「活的基线」= 基线 ∩ 当前登记——C2 删掉的编号在 C3 不再进自动范围；added 以 <S> 时登记为准（C2 新增的编号 C3 不再被自动并入复验集合）
    const curC3p = new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000N1']); // T3 已被 C2 删除（不在登记里）；N1 是 C2 新增
    const pc3 = rerunPlan(pBase, new Set([OTHER]), null, curC3p, new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000N1']));
    check(pc3.live.map((e) => e.id).join() === 'T1,T2,TB' && JSON.stringify(pc3.groups.get('api')) === JSON.stringify({ auto: ['T2'], mustRun: [], by: [], remount: [], added: [], runIds: ['T2'] }) && JSON.stringify(pc3.groups.get('browser').auto) === '["TB"]', '复验计划（84 MEDIUM-2）：C3 没有清单、<S> 时登记 = 当前登记——已被 C2 删掉的 T3 不进自动范围（旧口径会把它列进 api.ids.json），C2 新增的 N1 不再被自动并入 added（它对 <S> 不是新增）');
    const pc3b = rerunPlan(pBase, new Set(['docs/x.md']), null, new Set(['api\u0000T1', 'api\u0000T2', 'api\u0000N1', 'api\u0000N9']), new Set(['api\u0000T1', 'api\u0000T2', 'api\u0000N1']));
    check(JSON.stringify(pc3b.groups.get('api').added) === '["N9"]', '复验计划（84 MEDIUM-2）：当前登记比 <S> 时登记多出的 N9 才是 added');
    // S1 裁定 3：C1 之后新增的编号（当前登记有、固定基线没有）在后续提交里也进自动范围——用登记里的目标文件参与文件交集，组级触发与零目标兜底同样适用
    const NEWONLY = 'wbs-server/routes/sysbuild/newonly.js';
    const curN = new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000T3', 'api\u0000N1']);
    const regN = [{ group: 'api', id: 'T1', files: [RULES] }, { group: 'api', id: 'T2', files: [OTHER] }, { group: 'browser', id: 'TB', files: [OTHER] }, { group: 'api', id: 'T3', files: [OTHER] }, { group: 'api', id: 'N1', files: [NEWONLY] }, { group: 'api', id: 'N5', files: [RULES, OTHER] }].filter((e) => curN.has(e.group + '\u0000' + e.id));
    const regN5 = [...regN, { group: 'api', id: 'N5', files: [RULES, OTHER] }];
    const curN5 = new Set([...curN, 'api\u0000N5']);
    const pn1 = rerunPlan(pBase, new Set([NEWONLY]), null, curN, curN, regN);
    const pn1b = rerunPlan(pBase, new Set([NEWONLY]), null, curN, curN, null);
    check(JSON.stringify(pn1.groups.get('api')) === JSON.stringify({ auto: ['N1'], mustRun: [], by: [], remount: [], added: [], runIds: ['N1'] }) && pn1.groups.size === 1 && JSON.stringify(pn1b.groups.get('api').auto) === '["T1","T2","T3"]', '复验计划（S1 裁定 3）：C2 新增的 N1（目标 newonly.js）在 C3 改 newonly.js、清单不写 N1 → N1 进自动范围，且因为 newonly.js 有 N1 保护，不触发零目标兜底（只复验 N1）；对照：不给登记条目时 newonly.js 没有变异以它为目标 → 兜底触发 api + browser 整组');
    const pn2 = rerunPlan(pBase, new Set([RULES]), null, curN5, curN5, regN5);
    check(pn2.groups.get('api').auto.join() === 'T1,N5' && pn2.groups.get('api').added.length === 0, '复验计划（S1 裁定 3）：C2 新增的 N5（目标含 rules.js 与 other.js）在 C3 改 rules.js、清单不写 N5 → 与基线里的 T1 一起进自动范围（定位字面量所在的每个 edit 文件都参与文件交集）');
    const pn3 = rerunPlan(pBase, new Set(['wbs-server/utils/x.js']), null, curN, curN, regN);
    check(pn3.groups.get('api').auto.join() === 'T1,T2,T3,N1' && pn3.groups.get('browser').auto.join() === 'TB', '复验计划（S1 裁定 3）：产品侧组级触发（wbs-server/utils/**）→ api / browser 整组，新增的 N1 也在里面');
    const pn4 = rerunPlan(pBase, new Set(['wbs-server/routes/sysbuild/lonely.js']), null, curN, curN, regN);
    check(pn4.groups.get('api').auto.join() === 'T1,T2,T3,N1' && pn4.groups.get('browser').auto.join() === 'TB', '复验计划（S1 裁定 3）：零目标兜底（lonely.js 没有任何变异以它为目标）→ api + browser 整组，新增的 N1 也在里面');
    const pn5 = rerunPlan(pBase, new Set(['wbs-server/scripts/verify-sysbuild-api.js']), null, curN, curN, regN);
    check(pn5.groups.get('api').auto.join() === 'T1,T2,T3,N1' && !pn5.groups.has('browser'), '复验计划（S1 裁定 3）：组测试侧文件（api 驱动）改动 → api 整组（含新增的 N1），不波及别的组');
    // S1 裁定 2：合格结果覆盖全部复验编号（纯函数）；--effective-none（eff = null）下只有自动范围，同样核
    const qCur = (id, verdict, failures) => ({ group: 'api', id, verdict, failures });
    const qPlan = { groups: new Map([['api', { auto: ['Q1', 'Q2'], mustRun: [], by: [], remount: [], added: [], runIds: ['Q1', 'Q2', 'Q3'] }]]) };
    const qFail = [{ case: '用例甲', errorClass: 'AssertionError', message: 'm' }];
    const qGreen = { api: '  ✓ 未变异基线（进程内）9/9 全绿\n' };
    const qOk = qualifiedResultProblems({ plan: qPlan, eff: null, cur: [qCur('Q1', '判红', qFail), qCur('Q2', '判红', qFail), qCur('Q3', '判红', qFail)], texts: qGreen });
    const qBad = qualifiedResultProblems({ plan: qPlan, eff: null, cur: [qCur('Q1', '未判红', []), qCur('Q2', '判红', [{ ...qFail[0], errorClass: '' }]), qCur('Q3', '判红', qFail)], texts: { api: '  ✗ 未变异基线（进程内）8/9 有失败\n' } });
    const qMiss = qualifiedResultProblems({ plan: qPlan, eff: null, cur: [qCur('Q1', '判红', qFail)], texts: qGreen });
    check(qOk.length === 0 && qBad.length === 3 && /\[api\] 该组驱动日志里的未变异对照行缺失或不是全绿/.test(qBad[0]) && /\[api\] "Q1"（复验集合：自动范围）：当次判定 未判红/.test(qBad[1]) && /\[api\] "Q2"（复验集合：自动范围）：当次判定 判红，没有可作命中证据的失败/.test(qBad[2]) && qMiss.length === 0, '合格结果（纯函数，无生效清单也核）：全部判红且对照全绿 → 无问题；对照 ✗（按组只报一次）/ 存活 / 只有装载异常失败 → 各报；没有结果行的编号不在这里报（别处报「没有复验记录」）');
    const qEff = { required: [{ group: 'api', id: 'Q1', source: 'by' }, { group: 'api', id: 'Q2', source: 'mustRun' }] };
    const qBy = qualifiedResultProblems({ plan: qPlan, eff: qEff, cur: [qCur('Q1', '未判红', []), qCur('Q2', '未判红', []), qCur('Q3', '判红', qFail)], texts: qGreen });
    check(qBy.length === 1 && /\[api\] "Q2"（生效清单 mustRun）/.test(qBy[0]), '合格结果：只来自 by 的编号（Q1）交给承接逐条核对，这里不重复报；mustRun（Q2）照报');
    // 89 号 MEDIUM：同一编号既有合格命中、又有装载异常（SyntaxError / 模块装载失败）→ 单列拒绝；errorClass 为空的运行器超时不算装载异常（真实基线有这样的条目）
    const mixFail = [{ case: '用例甲', errorClass: 'AssertionError', message: '状态码不对' }, { case: '用例乙', errorClass: 'SyntaxError', message: 'Unexpected token' }];
    const mixMod = [{ case: '用例甲', errorClass: 'AssertionError', message: 'x' }, { case: '用例丙', errorClass: 'Error', message: "Cannot find module './x'" }];
    const mixTimeout = [{ case: '用例甲', errorClass: 'AssertionError', message: 'x' }, { case: '用例丁', errorClass: null, message: 'locator.waitFor: Timeout 30000ms exceeded.' }];
    const mixPlan = { groups: new Map([['api', { auto: ['M1', 'M2', 'M3', 'M4'], mustRun: [], by: [], remount: [], added: [], runIds: ['M1', 'M2', 'M3', 'M4'] }]]) };
    const mixP = qualifiedResultProblems({ plan: mixPlan, eff: null, cur: [qCur('M1', '判红', mixFail), qCur('M2', '判红', mixMod), qCur('M3', '判红', mixTimeout), qCur('M4', '判红', qFail)], texts: qGreen });
    check(mixP.length === 2 && /\[api\] "M1"（复验集合：自动范围）：同一编号既有可作命中证据的失败、又记了装载异常（SyntaxError：Unexpected token）/.test(mixP[0]) && /\[api\] "M2"[^\n]*同一编号既有可作命中证据的失败、又记了装载异常（Error：Cannot find module/.test(mixP[1]) && isLoadException(mixFail[1]) && isLoadException(mixMod[1]) && !isLoadException(mixTimeout[1]) && !isLoadException({ errorClass: 'GuardFail', message: 'Cannot find module x' }), '89 MEDIUM：判红的编号同时记了目标断言失败与装载异常（SyntaxError / Cannot find module）→ 单列拒绝（目标证据有效也不放过）；errorClass 为空的 Playwright 超时（真实基线 readonly「明确只读配置被忽略」就是这样）与 GuardFail 不算装载异常');
    const mixEff = { commit: 'CM', required: [{ group: 'api', id: 'M1', source: 'by' }], retire: [{ group: 'api', id: 'OLD', category: 'equivalent', by: [{ group: 'api', id: 'M1' }] }], retiredKeys: new Set(['api\u0000OLD']) };
    const mixGate = effectiveGateProblems({ eff: mixEff, metas: { api: { effective: { mode: 'file', runIds: ['M1'] } } }, scopeKeys: new Set(['api\u0000M1']), cur: [qCur('M1', '判红', mixFail)], texts: qGreen, dispositions: [{ 提交: 'CM', group: 'api', id: 'OLD', 去向: '由 M1 承接', 处置类别: 'equivalent', 现行编号: ['M1'], 等价业务错误: 'e', 承接命中证据: '用例甲：状态码不对' }] });
    check(mixGate.length === 1 && /retire \[api\] "OLD" 的承接 \[api\] "M1"：同一编号既有可作命中证据的失败、又记了装载异常/.test(mixGate[0]), '89 MEDIUM：equivalent 的承接编号同样——合格命中与装载异常并存 → 拒（承接逐条核对里单列）');
    // 预筛 LOW-2：累计去向表里同一编号在 C2 与 C3 各有一行承接证据——第 ③ 步核承接命中证据时取「提交」= 本次清单 commit 的那一行（C3 行对得上 → 过；换成 C2 清单只看 C2 行，证据对不上 → 拒）
    const b29Rows = [{ 提交: 'C2', group: 'api', id: 'OLD', 去向: 'x', 处置类别: 'equivalent', 现行编号: ['M1'], 等价业务错误: 'e', 承接命中证据: '用例乙：别的失败' }, { 提交: 'C3', group: 'api', id: 'OLD', 去向: 'x', 处置类别: 'equivalent', 现行编号: ['M1'], 等价业务错误: 'e', 承接命中证据: '用例甲：m' }];
    const b29Args = (commit) => ({ eff: { commit, required: [{ group: 'api', id: 'M1', source: 'by' }], retire: [{ group: 'api', id: 'OLD', category: 'equivalent', by: [{ group: 'api', id: 'M1' }] }], retiredKeys: new Set(['api\u0000OLD']) }, metas: { api: { effective: { mode: 'file', runIds: ['M1'] } } }, scopeKeys: new Set(['api\u0000M1']), cur: [qCur('M1', '判红', qFail)], texts: qGreen, dispositions: b29Rows });
    const b29C3 = effectiveGateProblems(b29Args('C3'));
    const b29C2 = effectiveGateProblems(b29Args('C2'));
    check(b29C3.length === 0 && b29C2.length === 1 && /承接命中证据」对不上它当次运行里的失败/.test(b29C2[0]), '预筛 LOW-2：累计去向表里同一编号 C2、C3 各有一行承接证据——第 ③ 步取「提交」= 本次清单 commit 的行：C3 清单 → 取 C3 行（对得上）→ 过；C2 清单 → 取 C2 行（证据对不上当次失败）→ 拒');
    // 94 号 MEDIUM：两条 remount 指向同一 newId → 拒；多条旧变异共用同一个承接编号用 equivalent 的 by（不拒）
    const dupCur = new Set(['api\u0000A1', 'api\u0000N1', 'api\u0000N2']);
    const dupS = new Set(['api\u0000A1', 'api\u0000O1', 'api\u0000O2']);
    const dupMount = effList.validateEffective({ format: effList.FORMAT, commit: 'C2', mustRun: [], retire: [{ ...Rf('O1'), category: 'remount', newId: Rf('N1') }, { ...Rf('O2'), category: 'remount', newId: Rf('N1') }], added: [Rf('N2')] }, { groups: ALL_GROUPS, sKeys: dupS, currentKeys: dupCur });
    const dupBy = effList.validateEffective({ format: effList.FORMAT, commit: 'C2', mustRun: [], retire: [{ ...Rf('O1'), category: 'equivalent', by: [Rf('N1')] }, { ...Rf('O2'), category: 'equivalent', by: [Rf('N1')] }], added: [Rf('N1'), Rf('N2')] }, { groups: ALL_GROUPS, sKeys: dupS, currentKeys: dupCur });
    check(dupMount.eff === null && dupMount.problems.some((p) => /retire\[1\] \[api\] "O2"：newId \[api\] "N1" 与 retire\[0\] \[api\] "O1" 重复（同一个新编号只有一个来源/.test(p)) && dupBy.eff !== null, '94 MEDIUM：两条 remount 指向同一 newId → 拒（逐条改挂）；多条旧变异由同一个新变异承接改用 equivalent 的 by → 不拒');
    // 94 / 89 号：承接命中证据的校验时点——第 ① 步（requireEvidence = false）不核，第 ③ 步（缺省 / true）强制
    const evRows = [{ 提交: 'C2', group: 'api', id: 'A3', 去向: '由 N1 承接', 处置类别: 'equivalent', 现行编号: ['N1'], 等价业务错误: '停用后仍可建项应返回 409' }];
    check(effList.retireDispositionProblems(eff, evRows.concat([{ 提交: 'C2', group: 'api', id: 'A4', 去向: '删除', 处置类别: 'stop-only', 删除依据: 'x' }, { 提交: 'C2', group: 'api', id: 'A5', 去向: '改挂', 处置类别: 'remount', 现行编号: 'N2' }]), { requireEvidence: false }).length === 0 && effList.retireDispositionProblems(eff, evRows.concat([{ 提交: 'C2', group: 'api', id: 'A4', 去向: '删除', 处置类别: 'stop-only', 删除依据: 'x' }, { 提交: 'C2', group: 'api', id: 'A5', 去向: '改挂', 处置类别: 'remount', 现行编号: 'N2' }])).some((p) => /缺「承接命中证据」/.test(p)) && effList.retireDispositionProblems(eff, [{ ...evRows[0], 等价业务错误: '' }, { 提交: 'C2', group: 'api', id: 'A4', 去向: '删除', 处置类别: 'stop-only', 删除依据: 'x' }, { 提交: 'C2', group: 'api', id: 'A5', 去向: '改挂', 处置类别: 'remount', 现行编号: 'N2' }], { requireEvidence: false }).some((p) => /缺「等价业务错误」/.test(p)), '89 MEDIUM-2：第 ① 步口径（requireEvidence = false）对 equivalent 不核「承接命中证据」（还没有当次复验日志）、仍核等价业务错误与现行编号；第 ③ 步口径强制承接命中证据');
    // 94 号 HIGH-4（真实数据）：「测试运行实际会加载的文件」都在 PRODUCT_TEST_PATHS 或闸门工具目录里——共用 / 各组测试侧名单、产品触发名单、间接依赖清单与真实仓库 listTestFiles 的每个路径
    const coverStr = (l) => l.filter((x) => typeof x === 'string');
    const coverFiles = Array.from(new Set([...SHARED_TEST_SIDE, ...Object.values(GROUP_TEST_SIDE).flatMap(coverStr), ...PRODUCT_GROUP_TRIGGER.files, ...EXTRA_TEST_FILES, ...listTestFiles(DEFAULT_REPO)]));
    const uncovered = coverFiles.filter((f) => !effList.isProductTestPath(f) && !f.toLowerCase().startsWith(effList.TOOL_DIR));
    const patSamples = [];
    for (const l of Object.values(GROUP_TEST_SIDE)) for (const p of l) if (typeof p !== 'string') patSamples.push(p === GROUP_TEST_SIDE.api[0] ? 'wbs-server/scripts/lib/sysbuild-api-suite-x.js' : p === GROUP_TEST_SIDE.browser[0] ? 'wbs-server/scripts/lib/sysbuild-browser-x.js' : 'scripts/sysbuild-predeploy/temp-service/server.cjs');
    check(coverFiles.length >= 60 && uncovered.length === 0 && patSamples.every((p) => effList.isProductTestPath(p)), `94 HIGH-4（真实数据）：共用 / 各组测试侧名单、产品触发名单、间接依赖清单与真实仓库 listTestFiles 共 ${coverFiles.length} 个路径，每个都落在 PRODUCT_TEST_PATHS 或闸门工具目录里（漏 ${uncovered.length} 个${uncovered.length ? '：' + uncovered.slice(0, 6).join('、') : ''}）；测试侧名单里的正则样本同样落在名单内`);
    // 预筛 HIGH（自伤）回归：已提交基线的全部条目当作「当次结果」交给合格结果判定，必须 0 问题；其中 message / label 带「夹具」「加载失败」字样的真实失败（旧正则会误判）单独点数，必须 > 0 才说明回归有牙
    const committedBase = JSON.parse(fs.readFileSync(path.join(DEFAULT_REPO, 'wbs-server', 'scripts', 'fixtures', 'sysbuild-step1', 'mutation-baseline.json'), 'utf8')).entries;
    const greenOf = { api: '  ✓ 未变异基线（进程内）9/9 全绿', browser: '浏览器检查 9/9 通过', static: '  ✓ 未变异基线 9/9 全绿', schema: '  ✓ 未变异基线 9/9 全绿', db: '  ✓ 未变异基线 9/9 全绿', attachments: '  ✓ 未变异基线 9/9 全绿', migration: '迁移未变异基线 9/9', deploy: '部署迁移守卫检查 9/9', archive: '存档未变异基线 9/9', readonly: '只读未变异基线 9/9' };
    const allPlan = { groups: new Map(ALL_GROUPS.map((g) => [g, { auto: [], mustRun: [], by: [], remount: [], added: [], runIds: committedBase.filter((e) => e.group === g).map((e) => e.id) }])) };
    const committedQ = qualifiedResultProblems({ plan: allPlan, eff: null, cur: committedBase, texts: greenOf });
    const OLD_RE = /夹具|加载失败|Cannot find module|MODULE_NOT_FOUND|fixture/i;
    const oldFlagged = committedBase.filter((e) => (e.failures || []).some((f) => OLD_RE.test(String(f.label || '')) || OLD_RE.test(String(f.message || ''))));
    check(committedBase.length === 2646 && committedQ.length === 0 && committedBase.every((e) => e.verdict === '判红' && e.failures.some((f) => !isLoadOrFixtureFailure(f))) && oldFlagged.length >= 21 && oldFlagged.some((e) => e.group === 'static') && oldFlagged.some((e) => e.group === 'api') && ['static', 'api'].every((g) => { const e = oldFlagged.find((x) => x.group === g); return qualifiedResultProblems({ plan: { groups: new Map([[g, { auto: [e.id], mustRun: [], by: [], remount: [], added: [], runIds: [e.id] }]]) }, eff: { required: [{ group: g, id: e.id, source: 'mustRun' }] }, cur: [e], texts: greenOf }).length === 0; }), '回归（预筛 HIGH；含真实基线失败信息的样本，不只合成的 m）：已提交基线 2646 条全部当作当次结果交给 qualifiedResultProblems 与证据合格判定 → 0 问题（每条至少一个可作命中证据的失败）；message / label 带「夹具」「加载失败」字样的真实失败（static 与 api 都有）不被误判');
    // 84 号 HIGH-1：生效清单必跑编号里基线「需人工复核」的条目并入三字段登记目标（纯函数）
    const FZp = () => ({ case: '用例甲', errorClass: 'AssertionError', message: 'm', site: 'h.js:1', caseSite: 'p.js:1', frames: ['h.js:1', 'mid.js:1', 'p.js:1'], siteText: 'x();' });
    const RV = (id, over) => ({ group: 'api', id, files: [OTHER], expect: null, verdict: '判红', failures: [FZp()], ...(over || {}) });
    const rtBase = [RV('M1'), RV('M2', { failures: [{ ...FZp(), caseSite: 'h.js:1', frames: ['h.js:1', 'p.js:1'] }] }), RV('M3')];
    const rtReq = [{ group: 'api', id: 'M1', source: 'mustRun' }, { group: 'api', id: 'M2', source: 'by' }, { group: 'api', id: 'NEW', source: 'added' }, { group: 'api', id: 'M1', source: 'by' }, { group: 'api', id: 'M3', source: 'remount' }];
    const rt = requiredReviewTargets(rtReq, rtBase, rtBase);
    check(rt.map((x) => x.id + ':' + x.source).join() === 'M1:mustRun,M3:remount' && rt[0].reasons.join() === 'callerNotCaseSite' && !rt.some((x) => x.id === 'M2') && !rt.some((x) => x.id === 'NEW'), '必跑编号里需人工复核的条目（requiredReviewTargets）：M1 / M3 基线失败的直接调用方 ≠ 用例体调用点 → 需复核（同一编号只列一次，来源取第一个）；M2 调用方就是用例体调用点 → 不需；NEW 不在基线里（新增变异，照旧走「现在有基线没有」）→ 不在这里');
    const rgOk = (extra, disp) => reviewGate({ affected: [], cmp: { changed: [] }, cur: rtBase, dispositions: disp || [], extraReview: extra });
    const dRow = (id, over) => ({ group: 'api', id, 业务步骤: '建项', 未变异通过证据: 'x', 变异后命中证据: '用例甲：m（x();#1）', ...(over || {}) });
    const rgMiss = rgOk(rt, []);
    const rgField = rgOk(rt, [dRow('M1', { 业务步骤: '' }), dRow('M3')]);
    const rgFull = rgOk(rt, [dRow('M1'), dRow('M3')]);
    const rgNone = rgOk([], []);
    check(rgMiss.problems.length === 2 && /\[api\] "M1"（生效清单 mustRun，需人工复核：直接调用方不是用例体调用点）：去向表里没有登记/.test(rgMiss.problems[0]) && rgField.problems.length === 1 && /\[api\] "M1".*登记缺字段 业务步骤/.test(rgField.problems[0]) && rgFull.problems.length === 0 && rgFull.targets.length === 2 && rgNone.problems.length === 0 && rgNone.targets.length === 0, '闸门纯函数（84 HIGH-1）：同键需复核、自动范围没命中、缺登记 → 每条各报；缺字段 → 报；补齐 → 过；没有 extraReview 时与旧口径一致（不加目标）');
    // 累计去向表（协调方更正）：三字段登记可引用任何提交的行；命中证据必须与当次失败对得上——旧行沿用 / 失败再变须新行
    const oldRowM1 = dRow('M1', { 提交: 'C2', 变异后命中证据: '用例乙：C2 时的旧失败（x();#1）' });
    const rgKeep = rgOk(rt, [dRow('M1', { 提交: 'C2' }), dRow('M3', { 提交: 'C2' })]); // C2 登记过、C3 失败没再变化 → 沿用旧行
    const rgChanged = rgOk(rt, [oldRowM1, dRow('M3', { 提交: 'C2' })]); // C2 的「变了」条目在 C3 失败又变（旧行证据对不上当次失败）且没有新行 → 拒
    const rgNewRow = rgOk(rt, [oldRowM1, dRow('M1', { 提交: 'C3' }), dRow('M3', { 提交: 'C2' })]); // 补了 C3 新行 → 过
    check(rgKeep.problems.length === 0 && rgChanged.problems.length === 1 && /\[api\] "M1"[^\n]*：变异后命中证据对不上当前运行里的失败[^\n]*失败再次变化的条目须补新行/.test(rgChanged.problems[0]) && rgNewRow.problems.length === 0, '累计去向表（C3 场景）：C2 登记过、本次失败没再变化的条目沿用旧行 → 过；C2 的「变了」条目在 C3 失败又变、旧行证据对不上 → 拒（提示须补新行）；补了 C3 新行 → 过');
    // 84 号 HIGH-2：复验之后才允许生成 / 补写的产物的显式排除名单（仓库内才有意义）
    const exR = exclusionsOf(path.join(os.tmpdir(), 'repoX'), { rawDir: path.join(os.tmpdir(), 'repoX', 'out', 'raw1'), dispositions: path.join(os.tmpdir(), 'repoX', 'docs', 'd.json'), report: path.join(os.tmpdir(), 'elsewhere', 'rep.json') });
    check(exR.files.join() === 'docs/d.json' && exR.dirs.join() === 'out/raw1/' && isExcludedBy(exR, 'docs/d.json') && isExcludedBy(exR, 'out/raw1/api.log') && !isExcludedBy(exR, 'out/raw10/api.log') && !isExcludedBy(exR, 'docs/d.json.bak') && !isExcludedBy(exR, 'wbs-server/routes/sysbuild/rules.js') && !isExcludedBy(null, 'docs/d.json'), '排除名单（exclusionsOf / isExcludedBy）：只含仓库内的 --raw-dir（目录前缀，带结尾 /）、--dispositions、--report；仓库外的路径不进名单；前缀相近的 out/raw10/、docs/d.json.bak 不被误排除；不给名单 = 不排除');
    // 84 号 MEDIUM（C9）+ 89 号 MEDIUM 重写：累计范围读各提交留档的复验计划（含自动纳入的编号），按提交逐份列出、逐编号保留命中来源；后来被删 / 改挂的按提交顺序逐支追到当前编号；编号复用不串
    const slotOf = (x) => ({ auto: [], mustRun: [], by: [], remount: [], added: [], runIds: [], ...x });
    // 95 号 HIGH-2：留档按实跑编号 ranIds 追溯（rerun.json sysbuild-rerun/3）；这里默认实跑 = 计划（runIds），整组实跑的计划外编号用 ran 参数另给
    const CD = (name, groups, retire, added, ran) => ({ name, retire: retire || [], added: added || [], groups, ranIds: ran || Object.fromEntries(Object.entries(groups).map(([g, s]) => [g, s.runIds])), results: {} });
    const cumCommits = [
      CD('C2', { api: slotOf({ auto: ['T2'], mustRun: ['T6'], by: ['N1'], remount: ['N2'], added: ['N1'], runIds: ['T2', 'T6', 'N1', 'N2'] }) }, [{ ...Rf('T3'), category: 'equivalent', by: [Rf('N1')] }, { ...Rf('T4'), category: 'remount', newId: Rf('N2') }], [Rf('N1')]),
      CD('C3', { api: slotOf({ remount: ['N3'], runIds: ['N3'] }) }, [{ ...Rf('N2'), category: 'remount', newId: Rf('N3') }, { ...Rf('T6'), category: 'stop-only' }], []),
      CD('C4', { api: slotOf({ added: ['T6'], runIds: ['T6'] }) }, [], [Rf('T6')]),
    ];
    const curCum = new Set(['api\u0000T1', 'api\u0000T2', 'browser\u0000TB', 'api\u0000N1', 'api\u0000N3', 'api\u0000T6']);
    const cs = cumulativeScope({ baseEntries: pBase, changed: new Set(), commits: cumCommits, currentKeys: curCum });
    const csHit = (g, id) => (cs.hits.get(g + '\u0000' + id) || []).join('|');
    check(cs.aff.length === 0 && cs.groups.get('api').net.length === 0 && csHit('api', 'T2') === 'C2:auto' && csHit('api', 'N1') === 'C2:by|C2:added' && csHit('api', 'N3').includes('C3:remount') && csHit('api', 'N3').includes('C2:remount（经追溯）') && cs.perCommit.length === 3 && cs.perCommit[0].name === 'C2' && cs.perCommit[0].groups.get('api').map((x) => x.id + '=' + x.sources.join('+')).join() === 'T2=C2:auto,T6=C2:mustRun,N1=C2:by+C2:added,N2=C2:remount', '累计范围（89 MEDIUM）：净改动为空（旧口径看不到任何受影响），但 C2 复验计划里自动纳入的 T2 仍命中（来源 C2:auto）；N1 的来源 by + added 逐项保留；C2 的 N2 沿 C3 的 remount 追到 N3（经追溯）；每个提交逐份、逐编号带来源');
    const trN2 = cs.traced.find((t) => t.id === 'N2');
    const trT6 = cs.traced.find((t) => t.id === 'T6' && t.commit === 'C2');
    check(trN2 && trN2.branches.length === 1 && trN2.branches[0].kind === 'final' && trN2.branches[0].id === 'N3' && trT6 && trT6.branches.length === 1 && trT6.branches[0].kind === 'dead' && /C3:stop-only/.test(trT6.branches[0].note), '累计范围追溯：C2 的 N2 → C3 改挂到 N3（final）；C2 的 mustRun T6 在 C3 被 stop-only 删掉 → 已无承接（dead，写明 C3）');
    check(csHit('api', 'T6') === 'C4:added' && cs.reuse.length === 1 && /\[api\] "T6" 先在 C3 被 retire、又在 C4 作为新增登记（编号复用）/.test(cs.reuse[0]), '累计范围（89 MEDIUM）：T6 先在 C3 被删、C4 又新增同名编号——C2 的旧 T6 证据在 C3 就结束，不串到新 T6（新 T6 只有 C4:added 一个来源）；工具识别出复用，输出警告要求人工核对');
    const cumB = cumulativeScope({ baseEntries: [], changed: new Set(), commits: [CD('C2', { api: slotOf({ mustRun: ['X', 'Z'], runIds: ['X', 'Z'] }) }, []), CD('C3', {}, [{ ...Rf('X'), category: 'equivalent', by: [Rf('Y1'), Rf('Y2')] }]), CD('C4', {}, [{ ...Rf('Y2'), category: 'stop-only' }])], currentKeys: new Set(['api\u0000Y1']) });
    const trX = cumB.traced.find((t) => t.id === 'X');
    const trZ = cumB.traced.find((t) => t.id === 'Z');
    check(trX && trX.branches.map((b) => b.kind + ':' + b.id).join() === 'final:Y1,dead:Y2' && /C4:stop-only/.test(trX.branches[1].note) && trZ && trZ.branches.length === 1 && trZ.branches[0].kind === 'unknown' && cumB.hits.has('api\u0000Y1') && cumB.hits.get('api\u0000Y1')[0] === 'C2:mustRun（经追溯）', '累计范围（89 MEDIUM）：一次等价承接分成两支（by Y1 / Y2）、Y2 后来被停用——两支都单独保留输出（Y1 仍在、Y2 已无承接），不因另一支仍在就省略已断的那一支；既不在当前登记、各留档也没有 retire 记录的编号（Z）标 unknown（留档不全）');
    // 闸门：某一组完全没有复验日志 / meta（整组没跑）→ 该组的必跑编号（mustRun / by / remount）各报「没有被复验」
    const effGate0 = effectiveGateProblems({ eff, metas: {}, scopeKeys: new Set(), cur: [], texts: {}, dispositions: dGood });
    check(effGate0.some((p) => /\[api\] "N1"（生效清单 added）：这一组没有复验日志与 meta/.test(p)), '闸门（纯函数）：新增变异（added 里声明的 N1）所在的组没有复验日志与 meta → 报「没有被复验」');
    check(effGate0.some((p) => /\[api\] "A2"（生效清单 mustRun）：这一组没有复验日志与 meta，该编号没有被复验/.test(p)) && effGate0.some((p) => /\[api\] "N1"（生效清单 by）：这一组没有复验日志与 meta/.test(p)) && effGate0.some((p) => /\[api\] "N2"（生效清单 remount）：这一组没有复验日志与 meta/.test(p)), '闸门（纯函数）：必跑编号所在的组没有复验日志与 meta（整组没跑）→ mustRun / by / remount 各报「没有被复验」');
    // ── 95 / 96 号（R6a / R6b）新增（纯函数 / 小仓库）：留档实跑编号、累计范围新增与复用、快照比较与类型、结束记录、复用编号的去向行、attest 归一 ──
    // 95 HIGH-2：rerun.json 分列计划编号（plannedIds）与实跑编号（ranIds，复验结束后按第 ③ 步同口径从日志解析），计划外的整组实跑编号另列 outOfPlanIds；空计划写空集合
    const ranDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-ran-'));
    let ranNow;
    try {
      fs.writeFileSync(path.join(ranDir, 'static.log'), [mut('static', 'S1', '判红', [F('S2', 'GuardFail', 'FAIL [S2] a.js:1 x')]), mut('static', 'S2', '判红', [F('S3', 'GuardFail', 'FAIL [S3] a.js:2 y')]), mut('static', 'SX', '判红', [])].join('\n') + '\n1/1 通过\n');
      ranNow = ranIdsFromLogs(ranDir, ['static'], { static: [R('static', 'S1'), R('static', 'S2')] }); // SX 日志里有、当前登记里没有：不算
    } finally { removeTree(ranDir); }
    const planRan = { groups: new Map([['static', { auto: ['S1'], mustRun: [], by: [], remount: [], added: [], runIds: ['S1'] }]]) };
    const rrBase = { o: { changedSince: 'a'.repeat(40), effective: null }, ctx: { exclusions: null }, effCtx: { mode: 'none', reason: '无' }, aff: [], results: {} };
    const rrRec = rerunRecord({ ...rrBase, plan: planRan, emptyPlan: false, ran: ranNow, ignoredInputsEnd: { x: 1 } });
    const rrEmpty = rerunRecord({ ...rrBase, plan: { groups: new Map() }, emptyPlan: true, ran: {} });
    check(RERUN_FORMAT === 'sysbuild-rerun/3' && ranNow.static.join() === 'S1,S2' && rrRec.format === RERUN_FORMAT && rrRec.plannedIds.static.join() === 'S1' && rrRec.ranIds.static.join() === 'S1,S2' && rrRec.outOfPlanIds.static.join() === 'S2' && rrRec.complete === true && rrRec.ignoredInputsEnd.x === 1 && JSON.stringify(rrEmpty.plannedIds) === '{}' && JSON.stringify(rrEmpty.ranIds) === '{}' && JSON.stringify(rrEmpty.outOfPlanIds) === '{}' && rrEmpty.complete === true, '95 HIGH-2：rerun.json（sysbuild-rerun/3）分列计划编号与实跑编号——计划只有 S1，整组跑出日志里还有登记过的 S2（日志里的 SX 不在当前登记，不算）→ ranIds [S1, S2]、outOfPlanIds [S2]；空计划显式写空集合；带结束记录（complete / ignoredInputsEnd）');
    // C9 用实跑编号追溯：C3 整组实跑跑出计划外的 S2，C5 把相关改动回退（净改动为空）——净改动与计划两侧都看不到 S2，只有实跑编号能追到
    const csRan = cumulativeScope({ baseEntries: [{ group: 'static', id: 'S2', files: ['x.js'], verdict: '判红', failures: [] }], changed: new Set(), commits: [CD('C3', { static: slotOf({ auto: ['S1'], runIds: ['S1'] }) }, [], [], { static: ['S1', 'S2'] })], currentKeys: new Set(['static\u0000S1', 'static\u0000S2']) });
    const csPnr = cumulativeScope({ baseEntries: [], changed: new Set(), commits: [CD('C3', { static: slotOf({ auto: ['S1', 'S5'], runIds: ['S1', 'S5'] }) }, [], [], { static: ['S1'] })], currentKeys: new Set(['static\u0000S1']) });
    check(csRan.aff.length === 0 && (csRan.hits.get('static\u0000S2') || []).join() === 'C3:整组实跑' && (csRan.hits.get('static\u0000S1') || []).join() === 'C3:auto' && csRan.perCommit[0].plannedNotRan.length === 0 && csPnr.perCommit[0].plannedNotRan.map((x) => x.id).join() === 'S5' && !csPnr.hits.has('static\u0000S5'), '95 HIGH-2（C9）：累计范围按实跑编号追溯——C3 整组实跑跑出计划外的 S2（来源「C3:整组实跑」），净改动为空也命中；计划里有、日志里没有结果行的 S5 不当作复验过（单列 plannedNotRan 供人工核对）');
    // 95 MEDIUM：净改动自动累计范围纳入 C1 后新增的现行编号（按登记里的目标文件算）；复用编号按现行登记的目标算，不用旧基线里同名条目的目标
    const bEnt = (id, files) => ({ group: 'api', id, files, verdict: '判红', failures: [] });
    const csNew = cumulativeScope({ baseEntries: [], changed: new Set(['new.js']), commits: [CD('C2', {})], currentKeys: new Set(['api\u0000N9']), currentEntries: [{ group: 'api', id: 'N9', files: ['new.js'] }] });
    const csNoNew = cumulativeScope({ baseEntries: [], changed: new Set(['new.js']), commits: [CD('C2', {})], currentKeys: new Set(['api\u0000N9']) });
    const reuseCommits = [CD('C3', {}, [{ ...Rf('T6'), category: 'stop-only' }]), CD('C4', {}, [], [Rf('T6')])];
    const csReuseNew = cumulativeScope({ baseEntries: [bEnt('T6', ['old.js'])], changed: new Set(['new.js']), commits: reuseCommits, currentKeys: new Set(['api\u0000T6']), currentEntries: [{ group: 'api', id: 'T6', files: ['new.js'] }] });
    const csReuseOld = cumulativeScope({ baseEntries: [bEnt('T6', ['old.js'])], changed: new Set(['old.js']), commits: reuseCommits, currentKeys: new Set(['api\u0000T6']), currentEntries: [{ group: 'api', id: 'T6', files: ['new.js'] }] });
    check(csNew.aff.map((x) => x.id).join() === 'N9' && csNew.live.length === 1 && csNew.live[0].noBaselineLocation === true && csNoNew.aff.length === 0, '95 MEDIUM（C9）：C1 之后新增的现行编号 N9 按登记里的目标文件 new.js 进净改动自动范围（不给当前登记时看不到）');
    check(csReuseNew.aff.map((x) => x.id).join() === 'T6' && csReuseOld.aff.length === 0 && csReuseNew.reuse.length === 1, '95 MEDIUM（C9）：复用编号 T6（C3 退役、C4 重登）按现行登记的目标 new.js 算：改 new.js 命中、改旧目标 old.js 不命中（旧基线里同名条目的目标属于旧一代）');
    // 95 MEDIUM：第 ② 步没暂存的路径，第 ③ 步仍比较「当前暂存 blob」与第 ② 步记的工作区 blob（Git 过滤结果漂移时原始字节相同也不能证明）；mode 变化也算；是否已暂存只影响提示语
    const mk3 = (o3) => new Map(Object.entries(o3));
    const snR = (st) => compareChangeSnapshot({ recordedFiles: new Map([['a.js', 's1']]), recordedStage: mk3({ 'a.js': st.rec }), current: mk3({ 'a.js': st.cur }), excl: null });
    const sd1 = snR({ rec: { blob: 'b1', index: null, mode: null }, cur: { sha256: 's1', blob: 'b9', index: 'b9', mode: '100644' } }); // 第 ② 步没暂存；现在暂存了与复验时不同的 blob（工作区字节没变，过滤结果变了）
    const sd2 = snR({ rec: { blob: 'b1', index: null, mode: null }, cur: { sha256: 's1', blob: 'b1', index: 'b1', mode: '100644' } }); // 先复验后 git add，暂存内容 = 复验内容
    const sd3 = snR({ rec: { blob: 'b1', index: 'b1', mode: '100644' }, cur: { sha256: 's1', blob: 'b1', index: 'b1', mode: '100755' } }); // 同一个 blob，可执行位变了
    const sd4 = snR({ rec: { blob: 'b1', index: 'b1', mode: '100644' }, cur: { sha256: 's1', blob: 'b1', index: 'b7', mode: '100644' } }); // 第 ② 步已暂存，之后暂存区被改过
    check(sd1.stageDrift.length === 1 && /第 ② 步时还没暂存/.test(sd1.stageDrift[0]) && sd2.stageDrift.length === 0 && sd2.stageBad.length === 0, '95 MEDIUM：第 ② 步时没暂存的路径——第 ③ 步暂存了与第 ② 步复验的工作区 blob 不同的内容 → stageDrift（旧版因第 ② 步没暂存而跳过）；先复验后 git add 同一内容 → 过');
    check(sd3.stageDrift.length === 1 && /git 文件模式 100644 → 100755/.test(sd3.stageDrift[0]), '95 MEDIUM：同一个 blob 的 git 文件 mode 变化（可执行位）→ 报');
    check(sd4.stageDrift.length === 1 && /第 ② 步时已暂存，之后暂存区被改过/.test(sd4.stageDrift[0]), '95 MEDIUM：第 ② 步已暂存、之后又改过暂存区 → 报（提示语区分）');
    // 95 MEDIUM：符号链接 / 子模块 → 明确报「不支持的文件类型」；快照记 git 文件 mode
    const US = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-unsup-'));
    let unsupErr = null;
    let modeSnap = null;
    let plainSnap = null;
    try {
      const gU = (args, input) => spawnSync('git', ['-C', US, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', input });
      gU(['init', '-q']);
      fs.writeFileSync(path.join(US, 'f.txt'), 'x\n');
      gU(['add', '-A']);
      gU(['commit', '-q', '-m', 'u1']);
      const blobU = gU(['hash-object', '-w', '--stdin'], 'target').stdout.trim();
      const headU = gU(['rev-parse', 'HEAD']).stdout.trim();
      plainSnap = changeSnapshot(US, ['f.txt']);
      gU(['update-index', '--chmod=+x', 'f.txt']);
      modeSnap = changeSnapshot(US, ['f.txt']);
      gU(['update-index', '--add', '--cacheinfo', `120000,${blobU},lnk`]);
      gU(['update-index', '--add', '--cacheinfo', `160000,${headU},sub`]);
      try { changeSnapshot(US, ['f.txt', 'lnk', 'sub']); } catch (e) { unsupErr = e.message; }
    } finally { try { removeTree(US); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + US + ' — ' + e.message); } }
    check(plainSnap.get('f.txt').mode === '100644' && modeSnap.get('f.txt').mode === '100755' && /不支持的文件类型/.test(String(unsupErr)) && /lnk（暂存区里是符号链接 120000）/.test(String(unsupErr)) && /sub（暂存区里是子模块 160000）/.test(String(unsupErr)) && !/git add/.test(String(unsupErr)), '95 MEDIUM：改动快照记 git 文件模式（100644 → 加可执行位 → 100755）；改动集里有符号链接（120000）/ 子模块（160000）→ 明确报「不支持的文件类型」并点名路径，不落成「请 git add」类误导提示');
    // 95 MEDIUM：非空复验的 rerun.json 结束记录——缺失 / 不可读 / 未写完 / 缺 ignoredInputsEnd / 与复验开始时不一致 / 与本次运行不匹配 / 实跑编号对不上 → 各拒
    const endDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-endrec-'));
    let endRes;
    try {
      const S0 = 'a'.repeat(40);
      const H0 = 'b'.repeat(40);
      const goodRj = { format: RERUN_FORMAT, complete: true, emptyPlan: false, changedSince: S0, context: { startHead: H0 }, commit: 'C2', effective: { mode: 'file', sha256: 'sha-ok', commit: 'C2' }, groups: { api: { runIds: ['A1'] } }, plannedIds: { api: ['A1'] }, ranIds: { api: ['A1'] }, outOfPlanIds: { api: [] }, results: { api: { exitCode: 0 } }, ignoredInputsEnd: { a: 1 } };
      const endRun = (rj, over) => { const f = path.join(endDir, 'rerun.json'); if (rj === null) { try { fs.unlinkSync(f); } catch (_) { /* 没有 */ } } else fs.writeFileSync(f, typeof rj === 'string' ? rj : JSON.stringify(rj)); return rerunJsonEndProblems({ rawDir: endDir, groups: ['api'], data: { api: { meta: { ignoredInputs: { a: 1 } } } }, since: S0, head: H0, effCtx: { mode: 'file', sha256: 'sha-ok', eff: { commit: 'C2' } }, ranNow: { api: ['A1'] }, ...(over || {}) }); };
      endRes = { good: endRun(goodRj), missing: endRun(null), garbage: endRun('{不是 json'), inc: endRun({ ...goodRj, complete: false }), noEnd: endRun({ ...goodRj, ignoredInputsEnd: undefined }), moved: endRun({ ...goodRj, ignoredInputsEnd: { a: 2 } }), ranDiff: endRun(goodRj, { ranNow: { api: ['A1', 'A9'] } }), oldFmt: endRun({ ...goodRj, format: 'sysbuild-rerun/2' }), head: endRun({ ...goodRj, context: { startHead: 'c'.repeat(40) } }), since: endRun({ ...goodRj, changedSince: 'd'.repeat(40) }), emptyFlag: endRun({ ...goodRj, emptyPlan: true }), commit: endRun({ ...goodRj, commit: 'C9' }), groups: endRun({ ...goodRj, groups: { api: {}, static: {} } }), effSha: endRun({ ...goodRj, effective: { mode: 'file', sha256: 'sha-other', commit: 'C2' } }), effNone: endRun({ ...goodRj, effective: { mode: 'none', reason: '无' } }), effNoneOk: endRun({ ...goodRj, commit: 'none:无', effective: { mode: 'none', reason: '无' } }, { effCtx: { mode: 'none', reason: '无' } }), effNoneDiff: endRun({ ...goodRj, commit: 'none:无', effective: { mode: 'none', reason: '别的' } }, { effCtx: { mode: 'none', reason: '无' } }) };
    } finally { try { removeTree(endDir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + endDir + ' — ' + e.message); } }
    const hasP = (k, re) => endRes[k].some((p) => re.test(p));
    check(endRes.good.length === 0 && hasP('missing', /rerun\.json：读不到或不是 JSON/) && hasP('garbage', /rerun\.json：读不到或不是 JSON/) && hasP('inc', /没有结束记录（complete 不是 true）/) && hasP('noEnd', /没有 ignoredInputsEnd/) && hasP('moved', /ignoredInputsEnd）与复验开始时（meta）不一致/) && hasP('ranDiff', /\[api\] 记的实跑编号 1 个与第 ③ 步从日志现算的 2 个不一致/) && hasP('oldFmt', /旧格式留档不收/) && hasP('head', /起始 HEAD/) && hasP('since', /--changed-since/) && hasP('emptyFlag', /emptyPlan 不是 false/) && hasP('commit', /提交名/) && hasP('groups', /记的复验组/), '95 MEDIUM（第 ③ 步 rerun.json 结束记录，纯函数）：完整记录 → 过；读不到 / 不是 JSON / 没写完（complete）/ 缺 ignoredInputsEnd / 结束摘要与复验开始时不一致 / 实跑编号与日志对不上 / 旧格式 / 起始 HEAD、--changed-since、提交名、组集合与本次不匹配 / 标成空计划 → 各拒');
    check(hasP('effSha', /记的生效清单[^\n]*与本次（file，sha256 sha-ok/) && hasP('effNone', /记的生效清单[^\n]*与本次（file/) && endRes.effNoneOk.length === 0 && hasP('effNoneDiff', /记的生效清单[^\n]*与本次（--effective-none "无"）不一致/), '预筛 LOW-2：rerun.json 记的生效清单必须与本次一致——文件模式核 sha256 与 commit（sha256 不同 / 记的是 none 模式 → 拒）；none 模式核理由（一致 → 过，理由不同 → 拒）');
    // 95 MEDIUM（编号复用）：本提交新增 / 改挂的编号只接受「提交」= 本次的三字段行；其余编号沿用历史行，但以该编号最后一条退役行为边界（累计去向表按提交顺序逐提交追加）
    const rgN = (disp, thisNew) => reviewGate({ affected: [], cmp: { changed: [] }, cur: rtBase, dispositions: disp, extraReview: rt, thisNew, commit: 'C5' });
    const retireRowM1 = { 提交: 'C3', group: 'api', id: 'M1', 去向: '删', 处置类别: 'stop-only', 删除依据: '旧流程停用' };
    const nOld = rgN([dRow('M1', { 提交: 'C2' }), dRow('M3', { 提交: 'C5' })], new Set(['api\u0000M1']));
    const nNew = rgN([dRow('M1', { 提交: 'C2' }), dRow('M1', { 提交: 'C5' }), dRow('M3', { 提交: 'C5' })], new Set(['api\u0000M1']));
    const bOld = rgN([dRow('M1', { 提交: 'C2' }), retireRowM1, dRow('M3', { 提交: 'C2' })], new Set());
    const bNew = rgN([dRow('M1', { 提交: 'C2' }), retireRowM1, dRow('M1', { 提交: 'C4' }), dRow('M3', { 提交: 'C2' })], new Set());
    check(nOld.problems.length === 1 && /\[api\] "M1"[^\n]*去向表里没有登记[^\n]*只接受「提交」= "C5" 的行/.test(nOld.problems[0]) && nNew.problems.length === 0, '95 MEDIUM（编号复用）：本提交（C5）新增的 M1 只有 C2 的三字段行（旧一代，恰好对得上同样的用例名 / 信息 / 位置键）→ 拒；补了 C5 行 → 过');
    check(bOld.problems.length === 1 && /\[api\] "M1"[^\n]*去向表里没有登记[^\n]*退役记录[^\n]*旧一代/.test(bOld.problems[0]) && bNew.problems.length === 0 && rgOk(rt, [dRow('M1', { 提交: 'C2' }), dRow('M3', { 提交: 'C2' })]).problems.length === 0, '95 MEDIUM（编号复用）：非本提交新增的 M1 在表里有退役行（第 2 行）→ 其前的旧行不算、退役行之后补新行才过；不传 thisNew 时与旧口径一致');
    // 95 MEDIUM：--s-registry-attest 在参数解析时统一 trim、拒绝空串
    const paBase = ['--rerun', '--raw-dir', 'x', '--affected-from', 'y', '--changed-since', 'a'.repeat(40), '--effective-none', 'e', '--dispositions', 'd'];
    let paErr = null;
    try { parseArgs([...paBase, '--s-registry-attest', '   ']); } catch (e) { paErr = e.message; }
    check(parseArgs([...paBase, '--s-registry-attest', '  理由  ']).sRegistryAttest === '理由' && /不能是空白/.test(String(paErr)), '95 MEDIUM：--s-registry-attest 在参数解析时 trim（带首尾空格的理由与第 ② 步写进 meta 的值一致，第 ③ 步不再误报不一致）；空白理由 → 用法错误');
    // 95 HIGH-1（提交序列映射）：每份留档自身的边界、相邻衔接、尾部都对得上，但 <C1>..HEAD 里有合并提交（第二父提交的改动没有任何留档覆盖）→ 拒（无法按线性提交序列逐个映射）
    const MR = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-chain-'));
    let chainMerge = null;
    try {
      const gM = (args) => spawnSync('git', ['-C', MR, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
      const headM = () => gM(['rev-parse', 'HEAD']).stdout.trim();
      gM(['init', '-q']);
      fs.writeFileSync(path.join(MR, 'f.txt'), '1\n');
      gM(['add', '-A']);
      gM(['commit', '-q', '-m', 'c1']);
      const mC1 = headM();
      gM(['checkout', '-q', '-b', 'side']);
      fs.writeFileSync(path.join(MR, 's.txt'), 's\n');
      gM(['add', '-A']);
      gM(['commit', '-q', '-m', 's']);
      gM(['checkout', '-q', '-']);
      fs.writeFileSync(path.join(MR, 'a.txt'), 'a\n');
      gM(['add', '-A']);
      gM(['commit', '-q', '-m', 'a']);
      const mA = headM();
      gM(['merge', '-q', '--no-ff', '-m', 'M', 'side']);
      chainMerge = cumulativeChainProblems(MR, mC1, [{ name: 'C2', dir: 'd1', changedSince: mC1, startHead: mC1 }, { name: 'C3', dir: 'd2', changedSince: mA, startHead: mA }]);
    } finally { try { removeTree(MR); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + MR + ' — ' + e.message); } }
    check(chainMerge && chainMerge.length === 1 && /里有 1 个合并提交[^\n]*无法按线性提交序列逐个映射留档/.test(chainMerge[0]), '95 HIGH-1（C9 提交序列映射）：每份留档的边界 / 相邻衔接 / 尾部都对得上，但 <C1>..HEAD 里有合并提交（第二父提交没有任何留档覆盖）→ 拒，不能按线性序列逐个映射');
  }

  // 命令行：合成原始日志目录 + 合成登记文件
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-mutbase-'));
  try {
    const dA = path.join(dir, 'runA');
    const dB = path.join(dir, 'runB');
    fs.mkdirSync(dA);
    fs.mkdirSync(dB);
    fs.writeFileSync(path.join(dA, 'api.log'), [apiOk[0], apiOk[1], mut('api', 'A3', '判红', [{ ...F('用例丙', 'AssertionError', '端口 41234'), site: 'wbs-server/scripts/lib/x.js:10' }])].join('\n') + '\n');
    fs.writeFileSync(path.join(dB, 'api.log'), [apiOk[0], mut('api', 'A2', '判红', [F('用例乙', 'TypeError', '换了')]), mut('api', 'A3', '判红', [{ ...F('用例丙', 'AssertionError', '端口 41234'), site: 'wbs-server/scripts/lib/x.js:99' }])].join('\n') + '\n');
    fs.writeFileSync(path.join(dA, 'static.log'), mut('static', 'S1', '判红', [F('S2', 'GuardFail', 'FAIL [S2] a.js:1 x，时间 2026-11-19 18:27:33')]) + '\n');
    fs.writeFileSync(path.join(dB, 'static.log'), mut('static', 'S1', '判红', [F('S2', 'GuardFail', 'FAIL [S2] a.js:1 x，时间 2026-11-19 19:48:02')]) + '\n');
    for (const d of [dA, dB]) for (const g of ['api', 'static']) fs.writeFileSync(path.join(d, g + '.meta.json'), JSON.stringify({ command: 'x', exitCode: 0, startedAt: '2026-11-19T12:00:00' }));
    const dd = diffRuns(dA, dB, ['api', 'static']);
    check(dd.total === 4 && dd.same === 1 && dd.rawOnly === 1 && dd.diffs.length === 2 && dd.diffs.some((x) => x.id === 'A2' && x.kind === '判定或失败信息不同（归一后仍不同）') && dd.diffs.some((x) => x.id === 'A3' && x.kind === '只有抛出位置不同'), '两次运行对比：一致 1 条；S1 只差时间戳（归一后相同）计入 rawOnly；A2 的失败信息不同、A3 只有抛出位置不同，分别列出');
    const dc = spawnSync(process.execPath, [__filename, '--raw-dir', dA, '--diff-runs', dB, '--groups', 'api,static'], { encoding: 'utf8' });
    check(dc.status === 1 && /两次运行对比：4 条里完全一致 1 条；原文不同但套归一规则后相同 1 条；有差异 2 条/.test(dc.stdout) && /第一次：/.test(dc.stdout), 'CLI --diff-runs：打印两次的原文，有判定或信息差异时退出码 1');
    const rawDir = path.join(dir, 'raw');
    fs.mkdirSync(rawDir);
    fs.writeFileSync(path.join(rawDir, 'api.log'), apiOk.join('\n') + '\n' + finishApi + '\n');
    fs.writeFileSync(path.join(rawDir, 'static.log'), staticOk.join('\n') + finishStatic + '\n');
    const regFile = path.join(dir, 'reg.json');
    fs.writeFileSync(regFile, JSON.stringify([...reg.api, ...reg.static]));
    const outFile = path.join(dir, 'baseline.json');
    const cli = (args) => spawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8' });
    const r1 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--out', outFile, '--no-provenance']);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch (_) { /* 下面判 */ }
    check(r1.status === 0 && doc && doc.format === FORMAT && doc.mode === 'filtered' && doc.entries.length === 4 && doc.groups.api.total === 3 && doc.groups.api.red === 3 && typeof doc.generatedAt === 'string' && doc.env.node === process.version && Object.prototype.hasOwnProperty.call(doc, 'headCommit'), 'CLI --parse-only：解析合成日志、写出基线（format / mode / env / groups / entries 齐全）');
    const r2 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--compare', outFile, '--allow-no-provenance']);
    check(r2.status === 0 && /对比：相同 4（其中需人工复核 3；守卫类无栈 1，不需复核）；变了且已登记 0；变了且没登记 0/.test(r2.stdout) && /需人工复核（判等键分不出来，不能自动判同；不算失败）：按类/.test(r2.stdout) && /守卫类无栈（GuardFail，靠规则 \+ 文件 \+ 信息识别，不计入 caseSite 为 null）：1 条；按组 static 1/.test(r2.stdout) && /「需人工复核」只是提示，不改变退出码；是否在去向表里登记处置，由各提交按方案做/.test(r2.stdout) && !/必须对这批条目逐条登记/.test(r2.stdout), 'CLI --compare：与刚写出的基线比 → 全部相同，退出码 0；合成记录里 api 三条没有 caseSite → 需人工复核 3，static 的守卫类失败单列 1（不进复核）；提示如实写「只是提示、登记由各提交按方案做」');
    const r2b = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--compare', outFile]);
    check(r2b.status === 1 && /基线没有来源清单（provenanceFile 为空）；--compare 默认拒绝/.test(r2b.stdout), 'CLI --compare：没带 --allow-no-provenance、基线又没有来源清单 → 退出码 1');
    fs.writeFileSync(path.join(rawDir, 'api.log'), apiOk.slice(0, 2).join('\n') + '\n' + finishApi + '\n');
    const r3 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--out', path.join(dir, 'b2.json'), '--no-provenance']);
    check(r3.status === 1 && /对账：缺记录 \[api\] "A3"/.test(r3.stdout), 'CLI：缺一条记录 → 列出缺的 id 并以退出码 1 结束');
    // L6：驱动退出码非 0 → 不通过；L7：不带 --out 不写基线
    fs.writeFileSync(path.join(rawDir, 'api.log'), apiOk.join('\n') + '\n' + finishApi + '\n');
    fs.writeFileSync(path.join(rawDir, 'api.meta.json'), JSON.stringify({ command: 'x', exitCode: 3, signal: null, startedAt: '2026-11-19T12:00:00' }));
    const r6 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--out', path.join(dir, 'b3.json'), '--no-provenance']);
    check(r6.status === 1 && /退出码 3（非 0，不通过）/.test(r6.stdout), 'CLI L6：驱动退出码非 0 → 即使记录全齐也判不通过（退出码 1）');
    fs.writeFileSync(path.join(rawDir, 'api.meta.json'), JSON.stringify({ command: 'x', exitCode: 0, signal: null, startedAt: '2026-11-19T12:00:00' }));
    const r7 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile]);
    check(r7.status === 0 && /没有 --out：不写基线/.test(r7.stdout) && !fs.existsSync(path.join(rawDir, 'mutation-baseline.json')), 'CLI L7：不带 --out 不写基线（只在 stdout 报结果）');
    const r8 = cli(['--parse-only', rawDir, '--groups', 'api,static', '--registry-file', regFile, '--out', path.join(dir, 'b4.json'), '--no-provenance']);
    let doc4 = null;
    try { doc4 = JSON.parse(fs.readFileSync(path.join(dir, 'b4.json'), 'utf8')); } catch (_) { /* 下面判 */ }
    check(r8.status === 0 && doc4 && (doc4.workingTreeDirty === true || doc4.workingTreeDirty === false || doc4.workingTreeDirty === null) && doc4.runAt === '2026-11-19T12:00:00', 'CLI L7：基线带 workingTreeDirty（git status --porcelain 是否非空）与 runAt（原始日志的驱动起始时刻）');
    const r4 = cli(['--parse-only', rawDir, '--groups', 'nope']);
    check(r4.status === 2, 'CLI：未知组是用法错误（退出码 2）');
    const r5 = cli(['--disposition', outFile]);
    check(r5.status === 2, 'CLI：--disposition 没有 --compare 是用法错误（退出码 2）');
    // L3：--out 模式下「key 相同但 caseSite 不同」> 0 → 拒绝生成（两条失败的 case / class / message / 抛出行 / 用例体调用点的文本与序号都相同，只是落在不同文件里）
    {
      const l3 = path.join(dir, 'l3');
      const repoL3 = path.join(l3, 'repo');
      const rawL3 = path.join(l3, 'raw');
      fs.mkdirSync(path.join(repoL3, 'wbs-server', 'scripts', 'lib'), { recursive: true });
      fs.mkdirSync(rawL3, { recursive: true });
      const wr = (f, t) => fs.writeFileSync(path.join(repoL3, 'wbs-server', 'scripts', 'lib', f), t);
      wr('h.js', 'assert.strictEqual(r.status, 200);\n');
      wr('p.js', 'await act();\n');
      wr('q.js', 'await act();\n');
      const FX = (csFile) => ({ ...F('用例甲', 'AssertionError', '状态码不对'), site: 'wbs-server/scripts/lib/h.js:1', caseSite: 'wbs-server/scripts/lib/' + csFile + ':1', frames: ['wbs-server/scripts/lib/h.js:1', 'wbs-server/scripts/lib/' + csFile + ':1'], runnerSeen: true });
      fs.writeFileSync(path.join(rawL3, 'api.log'), [mut('api', 'A1', '判红', [FX('p.js')]), mut('api', 'A2', '判红', [FX('q.js')])].join('\n') + '\n变异自检：2/2 判红（挑选 2 / 共 2；过滤模式）\n');
      const regL3 = path.join(l3, 'reg.json');
      fs.writeFileSync(regL3, JSON.stringify([R('api', 'A1'), R('api', 'A2')]));
      const outL3 = path.join(l3, 'out.json');
      const gen = () => spawnSync(process.execPath, [__filename, '--repo', repoL3, '--groups', 'api', '--registry-file', regL3, '--parse-only', rawL3, '--out', outL3, '--no-provenance'], { encoding: 'utf8' });
      const g1 = gen();
      check(g1.status === 1 && /拒绝生成：key 相同但 caseSite 不同的组数为 1（应为 0）/.test(g1.stdout) && /完整键下多个 caseSite：/.test(g1.stdout) && !fs.existsSync(outL3), 'L3：--out 模式下 key 相同但 caseSite 不同（p.js:1 与 q.js:1 的文本与序号都相同）> 0 → 拒绝生成（退出码 1），基线不写');
      wr('q.js', 'await actOther();\n'); // 对照：用例体那一行的文本不同 → 键能区分 → 可以生成
      const g2 = gen();
      check(g2.status === 0 && fs.existsSync(outL3) && /key 相同但 caseSite 不同的组数（[^）]*）：0/.test(g2.stdout), 'L3 对照：两处用例体调用点文本不同（键能区分）→ 组数 0，正常生成');
    }
    // codex 79 HIGH-2：受影响子集登记闸门，整条 CLI（临时 git 仓库：c1 → c2 只改 rules.js；基线与日志放仓库外，工作区保持干净）
    {
      const gd = path.join(dir, 'gate');
      const G = path.join(gd, 'repo');
      fs.mkdirSync(G, { recursive: true });
      const gg = (args) => spawnSync('git', ['-C', G, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
      const wrG = (rel, t) => { const f = path.join(G, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
      wrG('wbs-server/scripts/lib/h.js', 'assert.strictEqual(r.status, 200);\n');
      wrG('wbs-server/scripts/lib/p.js', 'await act();\n');
      wrG('wbs-server/scripts/lib/mid.js', 'mid();\n');
      wrG('wbs-server/routes/sysbuild/rules.js', '// r1\n');
      wrG('wbs-server/routes/sysbuild/other.js', '// o1\n');
      const FZ = () => ({ ...F('用例甲', 'AssertionError', '状态码不对'), site: 'wbs-server/scripts/lib/h.js:1', caseSite: 'wbs-server/scripts/lib/p.js:1', frames: ['wbs-server/scripts/lib/h.js:1', 'wbs-server/scripts/lib/mid.js:1', 'wbs-server/scripts/lib/p.js:1'], runnerSeen: true });
      // 假的 api 驱动：只认 --mutation-ids <文件>，按名单输出 @@MUT 行与收尾行（--rerun 真起子进程跑它）
      wrG('wbs-server/scripts/verify-sysbuild-api.js', [
        "'use strict';",
        "const fs = require('fs');",
        'const LINES = ' + JSON.stringify({ A1: mut('api', 'A1', '判红', [FZ()]), A2: mut('api', 'A2', '判红', [FZ()]), N1: mut('api', 'N1', '判红', [FZ()]), N2: mut('api', 'N2', '判红', [FZ()]), N3: mut('api', 'N3', '判红', [FZ()]) }) + ';',
        'const a = process.argv.slice(2);',
        "const i = a.indexOf('--mutation-ids');",
        "const ids = i >= 0 ? JSON.parse(fs.readFileSync(a[i + 1], 'utf8')) : ['A1', 'A2'];",
        "console.log('  ✓ 未变异基线（进程内）9/9 全绿');",
        "for (const id of ids) console.log(LINES[id]);",
        "console.log('变异自检：' + ids.length + '/' + ids.length + ' 判红（挑选 ' + ids.length + ' / 共 2；过滤模式）');",
      ].join('\n') + '\n');
      gg(['init', '-q']);
      gg(['add', '-A']);
      gg(['commit', '-q', '-m', 'c1']);
      const c1 = gg(['rev-parse', 'HEAD']).stdout.trim();
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      wrG('wbs-server/scripts/lib/with space 中.js', '// s\n'); // 路径含空格与中文：--changed-since 的 diff 用 -z，路径原样
      gg(['add', '-A']);
      gg(['commit', '-q', '-m', 'c2']);
      const mkRaw = (name, idsToLog, finish) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'api.log'), idsToLog.map((id) => mut('api', id, '判红', [FZ()])).join('\n') + '\n' + finish + '\n'); return d; };
      const rawAll = mkRaw('raw-all', ['A1', 'A2'], '变异自检：2/2 判红（挑选 2 / 共 2；过滤模式）');
      const rawA1 = mkRaw('raw-a1', ['A1'], '变异自检：1/1 判红（挑选 1 / 共 2；过滤模式）');
      const rawA2 = mkRaw('raw-a2', ['A2'], '变异自检：1/1 判红（挑选 1 / 共 2；过滤模式）');
      const regG = path.join(gd, 'reg.json');
      fs.writeFileSync(regG, JSON.stringify([{ group: 'api', id: 'A1', files: ['wbs-server/routes/sysbuild/rules.js'], expect: null }, { group: 'api', id: 'A2', files: ['wbs-server/routes/sysbuild/other.js'], expect: null }]));
      const baseG = path.join(gd, 'base.json');
      const cliG = (args) => spawnSync(process.execPath, [__filename, '--repo', G, '--groups', 'api', ...args], { encoding: 'utf8' });
      const gen = cliG(['--registry-file', regG, '--parse-only', rawAll, '--out', baseG, '--no-provenance']);
      const emptyD = path.join(gd, 'disp-empty.json');
      fs.writeFileSync(emptyD, '[]');
      const goodD = path.join(gd, 'disp-good.json');
      const EVID = '用例甲：状态码不对（await act();#1）';
      fs.writeFileSync(goodD, JSON.stringify([{ 提交: 'CG', group: 'api', id: 'A1', 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 2/2 全绿', 变异后命中证据: EVID }])); // 96 号：累计去向表每一行都带非空「提交」
      const noLocD = path.join(gd, 'disp-noloc.json');
      fs.writeFileSync(noLocD, JSON.stringify([{ 提交: 'CG', group: 'api', id: 'A1', 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 2/2 全绿', 变异后命中证据: '用例甲：状态码不对' }]));
      const siteLocD = path.join(gd, 'disp-siteloc.json');
      fs.writeFileSync(siteLocD, JSON.stringify([{ 提交: 'CG', group: 'api', id: 'A1', 业务步骤: '建项', 未变异通过证据: 'x', 变异后命中证据: '用例甲：状态码不对（assert.strictEqual(r.status, 200);#1）' }]));
      const missD = path.join(gd, 'disp-miss.json');
      fs.writeFileSync(missD, JSON.stringify([{ 提交: 'CG', group: 'api', id: 'A1', 业务步骤: '建项', 未变异通过证据: '', 变异后命中证据: EVID }]));
      const wrongD = path.join(gd, 'disp-wrong.json');
      fs.writeFileSync(wrongD, JSON.stringify([{ 提交: 'CG', group: 'api', id: 'A1', 业务步骤: '建项', 未变异通过证据: 'x', 变异后命中证据: '用例乙：别的信息' }]));
      const NONE_REASON = '无生效清单的测试提交';
      // 84 号 HIGH-3：改了产品文件（routes/sysbuild/rules.js 等）的提交不许用 --effective-none；这条主流程改用最小的生效清单（mustRun A1，= 自动范围里那条；没有增删）
      const effG = path.join(gd, 'eff-g.json');
      fs.writeFileSync(effG, JSON.stringify({ format: effList.FORMAT, commit: 'CG', mustRun: [{ group: 'api', id: 'A1' }], retire: [] }));
      let gateSince = c1; // c3 提交之后改成 HEAD（见 cS）
      const gate = (raw, disp, since) => cliG(['--registry-file', regG, '--parse-only', raw, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', since || gateSince, '--dispositions', disp, '--effective', effG]);
      const affOut = path.join(gd, 'aff');
      const af = cliG(['--affected', baseG, '--changed-since', c1, '--affected-out', affOut]);
      const idsJson = fs.existsSync(path.join(affOut, 'api.ids.json')) ? JSON.parse(fs.readFileSync(path.join(affOut, 'api.ids.json'), 'utf8')) : null;
      check(gen.status === 0 && af.status === 0 && /受影响的条目 1 条（其中需人工复核 1 条）；按组 api 1/.test(af.stdout) && /受影响 \[api\] "A1"/.test(af.stdout) && !/受影响 \[api\] "A2"/.test(af.stdout) && /受影响来源：文件交集 1 条；组测试侧改动 0 条；产品侧组级触发 0 条；兜底触发 0 条/.test(af.stdout) && /文件交集：wbs-server\/routes\/sysbuild\/rules\.js/.test(af.stdout) && /verify-sysbuild-api\.js --self-test --mutation-ids .*api\.ids\.json/.test(af.stdout) && JSON.stringify(idsJson) === '["A1"]', '闸门 CLI --affected：只读基线，列出受影响条目（A1：目标文件 rules.js 在 c1..HEAD 里改了；A2 不受影响），给出 api 的 --mutation-ids 复验命令并写 api.ids.json');
      // H1：第 ② 步由本工具执行（--rerun，真起（假的）api 驱动子进程）；闸门只认这样写出来的 meta
      const rerunDir = path.join(gd, 'rerun');
      const rr = cliG(['--rerun', '--raw-dir', rerunDir, '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG]);
      const rrMeta = fs.existsSync(path.join(rerunDir, 'api.meta.json')) ? JSON.parse(fs.readFileSync(path.join(rerunDir, 'api.meta.json'), 'utf8')) : null;
      const rrLog = fs.existsSync(path.join(rerunDir, 'api.log')) ? fs.readFileSync(path.join(rerunDir, 'api.log'), 'utf8') : '';
      const headG = gg(['rev-parse', 'HEAD']).stdout.trim();
      check(rr.status === 0 && rrMeta && rrMeta.startHead === headG && rrMeta.changedSince === c1 && rrMeta.exitCode === 0 && /--mutation-ids/.test(rrMeta.command) && Object.keys(rrMeta.changedFiles).sort().join('|') === 'wbs-server/routes/sysbuild/rules.js|wbs-server/scripts/lib/with space 中.js' && /^[0-9a-f]{64}$/.test(rrMeta.changedFiles['wbs-server/routes/sysbuild/rules.js']) && Array.isArray(rrMeta.workingTree) && /"A1"|\bA1\b/.test(rrLog) && !/"id":"A2"/.test(rrLog) && JSON.parse(fs.readFileSync(path.join(rerunDir, 'api.ids.json'), 'utf8')).join() === 'A1', 'H1 --rerun：由本工具跑——api 用 --mutation-ids 只跑受影响编号（A1），meta 记起始 HEAD、--changed-since、改动集里每个文件的 sha256（含路径带空格与中文的文件）、工作区状态、命令、退出码');
      const g0 = gate(rerunDir, emptyD);
      check(g0.status === 1 && /闸门不通过：\[api\] "A1"（受影响（文件交集：wbs-server\/routes\/sysbuild\/rules\.js））：去向表里没有登记/.test(g0.stdout) && /受影响子集闸门：--changed-since [0-9a-f]{40}；.*受影响的条目 1 条（其中需人工复核 1 条/.test(g0.stdout), '闸门 CLI：受影响条目没有登记 → 退出码 1，并点名条目与命中文件；S 写进闸门输出');
      const g1 = gate(rerunDir, missD);
      const g2 = gate(rerunDir, wrongD);
      const g3 = gate(rerunDir, goodD);
      const g3b = gate(rerunDir, siteLocD);
      const g3c = gate(rerunDir, noLocD);
      check(g1.status === 1 && /登记缺字段 未变异通过证据/.test(g1.stdout) && g2.status === 1 && /命中证据对不上当前运行里的失败/.test(g2.stdout) && g3.status === 0 && /闸门问题 0 条/.test(g3.stdout), '闸门 CLI：缺字段 → 1；命中证据对不上 → 1；齐全且对得上 → 0');
      check(g3b.status === 0 && g3c.status === 1 && /命中证据对不上[^\n]*位置键/.test(g3c.stdout), 'M2：命中证据写 siteText#ord（抛出行）也算；只写用例名与信息、没写 caseSiteText#ord 或 siteText#ord → 不通过');
      // H1：旧日志 + 机械登记过不了闸门
      // 95 号 MEDIUM：非空复验的目录必须带第 ② 步写的 rerun.json 结束记录；复制 / 改写目录的助手把它一起带上，并按改写后的 api.log 重算 ranIds（只让这里要测的那一处缺陷成立）
      const copyRj = (srcDir, dstDir, regFile) => {
        const f = path.join(srcDir, 'rerun.json');
        if (!fs.existsSync(f)) return;
        const rj = JSON.parse(fs.readFileSync(f, 'utf8'));
        const regIds = new Set(JSON.parse(fs.readFileSync(regFile, 'utf8')).filter((x) => x.group === 'api').map((x) => x.id));
        const seen = [];
        for (const r of parseRaw(fs.readFileSync(path.join(dstDir, 'api.log'), 'utf8')).records) if (r.group === 'api' && regIds.has(r.id) && !seen.includes(r.id)) seen.push(r.id);
        rj.ranIds = { ...(rj.ranIds || {}), api: seen };
        fs.writeFileSync(path.join(dstDir, 'rerun.json'), JSON.stringify(rj));
      };
      const metaOf = (name, fn) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(rerunDir, 'api.log'), path.join(d, 'api.log')); fs.copyFileSync(path.join(rerunDir, 'api.ids.json'), path.join(d, 'api.ids.json')); const m = JSON.parse(JSON.stringify(rrMeta)); fn(m, d); fs.writeFileSync(path.join(d, 'api.meta.json'), JSON.stringify(m, null, 2)); copyRj(rerunDir, d, regG); return d; };
      const s1 = gate(rawAll, goodD); // 旧日志：没有 meta
      const oldMetaDir = path.join(gd, 'old-meta'); fs.mkdirSync(oldMetaDir, { recursive: true }); fs.copyFileSync(path.join(rawAll, 'api.log'), path.join(oldMetaDir, 'api.log')); fs.writeFileSync(path.join(oldMetaDir, 'api.meta.json'), JSON.stringify({ command: 'node x', exitCode: 0, startedAt: '2026-01-01T00:00:00.000Z' }));
      const s1b = gate(oldMetaDir, goodD); // 旧格式 meta：没有 startHead 等
      const s2 = gate(metaOf('meta-head', (m) => { m.startHead = c1; }), goodD);
      const s3 = gate(metaOf('meta-time', (m) => { m.startedAt = '2000-01-01T00:00:00.000Z'; }), goodD);
      const s4 = gate(metaOf('meta-since', (m) => { m.changedSince = '0'.repeat(40); }), goodD);
      check(s1.status === 1 && /\[api\] 没有 api\.meta\.json[^\n]*旧日志不能过闸门/.test(s1.stdout) && s1b.status === 1 && /api\.meta\.json 没有 startHead \/ changedSince \/ changedFiles/.test(s1b.stdout) && s2.status === 1 && /复验起始 HEAD [0-9a-f]{40} 不是当前 HEAD/.test(s2.stdout) && s3.status === 1 && /早于 [0-9a-f]{40}\.\.HEAD 最晚提交时间|早于 .+\.\.HEAD 最晚提交时间/.test(s3.stdout) && s4.status === 1 && /--changed-since 0{40} 与本次/.test(s4.stdout), 'H1：旧日志 + 机械登记 → 拒：没有 meta / 旧格式 meta / meta 的 HEAD 不是当前 HEAD / 起始时刻早于最晚提交 / meta 的 --changed-since 不同，各一条');
      // MED-1：meta 与日志 / 组 / ids 绑定
      const b1 = gate(metaOf('swap-log', (m, d) => { fs.copyFileSync(path.join(rawAll, 'api.log'), path.join(d, 'api.log')); }), goodD); // 只复验了 A1，日志却换成全组旧日志（A1、A2）
      const b2 = gate(metaOf('ids-tamper', (m, d) => { fs.writeFileSync(path.join(d, 'api.ids.json'), JSON.stringify(['A1', 'A2'])); }), goodD); // ids 文件改了、meta 没跟着改
      const b3 = gate(metaOf('ids-forged', (m, d) => { const f = path.join(d, 'api.ids.json'); fs.writeFileSync(f, JSON.stringify(['A2'])); m.idsFile.sha256 = sha256File(f); }), goodD); // 连 meta 里的 ids 哈希一起改成对得上，但内容不是现算的受影响编号
      const b4 = gate(metaOf('not-rerun', (m) => { m.rerun = false; }), goodD);
      const b5 = gate(metaOf('wrong-argv', (m) => { m.argv = ['wbs-server/scripts/verify-sysbuild-static.js', '--self-test']; }), goodD);
      check(b1.status === 1 && /api\.log 与 meta 记的日志（文件名 \/ 字节数 \/ sha256）对不上/.test(b1.stdout) && b2.status === 1 && /api\.ids\.json 缺失，或与 meta\.idsFile 的 sha256 不一致/.test(b2.stdout) && b3.status === 1 && /api\.ids\.json（1 个编号）与按 [0-9a-f]{40} 现算的复验集合（自动范围 ∪ 生效清单，1 个）不全等/.test(b3.stdout) && b4.status === 1 && /meta\.rerun 不是 true/.test(b4.stdout) && b5.status === 1 && /meta\.argv .* 不是本组的驱动命令/.test(b5.stdout), 'MED-1：只复验一组却换成全组旧日志 → 日志与 meta 的 sha256 对不上；ids 文件被改 / ids 哈希连带伪造但内容不是现算的受影响编号 / meta.rerun 不是 true / meta.argv 的脚本不是本组的驱动 → 各拒');
      // ── 95 号新增：rerun.json 结束记录、<S> 时登记摘要、累计去向表整表（HEAD = c2，S = c1 = HEAD 的第一父提交）──
      const readRj = (d) => JSON.parse(fs.readFileSync(path.join(d, 'rerun.json'), 'utf8'));
      const writeRj = (d, fn) => { const j = readRj(d); fn(j); fs.writeFileSync(path.join(d, 'rerun.json'), JSON.stringify(j)); };
      const noRjDir = metaOf('no-rj', () => {});
      fs.unlinkSync(path.join(noRjDir, 'rerun.json'));
      const brokenRjDir = metaOf('broken-rj', () => {});
      fs.writeFileSync(path.join(brokenRjDir, 'rerun.json'), '{不是 json');
      const incRjDir = metaOf('inc-rj', () => {});
      writeRj(incRjDir, (j) => { j.complete = false; });
      const noEndRjDir = metaOf('noend-rj', () => {});
      writeRj(noEndRjDir, (j) => { delete j.ignoredInputsEnd; });
      const ranRjDir = metaOf('ran-rj', () => {});
      writeRj(ranRjDir, (j) => { j.ranIds.api = ['A1', 'A2']; }); // 记的实跑编号比日志里多一个
      const gNoRj = gate(noRjDir, goodD);
      const gBrokenRj = gate(brokenRjDir, goodD);
      const gIncRj = gate(incRjDir, goodD);
      const gNoEndRj = gate(noEndRjDir, goodD);
      const gRanRj = gate(ranRjDir, goodD);
      check(gNoRj.status === 1 && /rerun\.json：读不到或不是 JSON/.test(gNoRj.stdout) && gBrokenRj.status === 1 && /rerun\.json：读不到或不是 JSON/.test(gBrokenRj.stdout) && gIncRj.status === 1 && /rerun\.json：没有结束记录（complete 不是 true）/.test(gIncRj.stdout) && gNoEndRj.status === 1 && /rerun\.json：没有 ignoredInputsEnd/.test(gNoEndRj.stdout) && gRanRj.status === 1 && /rerun\.json：\[api\] 记的实跑编号 2 个与第 ③ 步从日志现算的 1 个不一致/.test(gRanRj.stdout), '95 MEDIUM（整条 CLI）：非空复验的目录里 rerun.json 缺失 / 不是 JSON / 没有结束记录（complete）/ 缺 ignoredInputsEnd / 实跑编号与日志不一致 → 第 ③ 步各拒（旧版吞掉读取与解析错误，复验期间运行输入变了又恢复时漏判）');
      const sregTamper = metaOf('sreg-tamper', (m) => { m.sRegistry = { ...m.sRegistry, sha256: '0'.repeat(64) }; });
      const sregNone = metaOf('sreg-none', (m) => { delete m.sRegistry; });
      const gSregT = gate(sregTamper, goodD);
      const gSregN = gate(sregNone, goodD);
      check(rrMeta.sRegistry && /^[0-9a-f]{64}$/.test(rrMeta.sRegistry.sha256) && rrMeta.sRegistry.count === 2 && /自检钩子/.test(rrMeta.sRegistry.source) && readRj(rerunDir).context.sRegistry.sha256 === rrMeta.sRegistry.sha256 && readRj(rerunDir).format === 'sysbuild-rerun/3' && gSregT.status === 1 && /<S> 时登记的编号摘要与第 ② 步记录不一致/.test(gSregT.stdout) && gSregN.status === 1 && /没有记 <S> 时登记的编号摘要/.test(gSregN.stdout), '96 HIGH-3（第 ②③ 步）：第 ② 步把 <S> 时登记的编号摘要（sha256 / 条数 / 来源）写进 meta 与 rerun.json；第 ③ 步现算后核同一份——摘要被改 → 拒；旧格式（没有摘要）→ 拒');
      const noCommitD = path.join(gd, 'disp-nocommit.json');
      fs.writeFileSync(noCommitD, JSON.stringify([{ group: 'api', id: 'A1', 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 2/2 全绿', 变异后命中证据: EVID }]));
      const gNoC = gate(rerunDir, noCommitD);
      check(gNoC.status === 1 && /闸门不通过：去向表：累计去向表第 1 行[^\n]*缺非空的「提交」/.test(gNoC.stdout), '96 MEDIUM（第 ③ 步）：累计去向表有一行没有「提交」→ 拒（含普通三字段行，不只带「处置类别」的退役行）');
      const metaCopyDir = path.join(gd, 'meta-copy'); fs.mkdirSync(metaCopyDir, { recursive: true }); fs.copyFileSync(path.join(rerunDir, 'api.log'), path.join(metaCopyDir, 'browser.log'));
      const copied = rerunMetaProblems({ repo: G, rawDir: metaCopyDir, since: c1, metas: { browser: rrMeta }, curChanged: changedFilesSince(G, c1), baseEntries: JSON.parse(fs.readFileSync(baseG, 'utf8')).entries });
      check(copied.some((p) => /meta\.group 是 "api"，不是 browser/.test(p)) && copied.some((p) => /meta\.argv/.test(p)) && copied.some((p) => /browser\.log 与 meta 记的日志/.test(p)), 'MED-1：把 api 的真 meta 复制给另一组（browser）→ meta.group、meta.argv、日志文件名各对不上，拒');
      // 复验之后工作区又变：改动文件内容变了 → 拒；新出现的任何改动路径 → 拒（84 号 HIGH-2：完整改动路径集合，不只自动范围相关的路径）
      wrG('wbs-server/routes/sysbuild/rules.js', '// r3\n');
      const s5 = gate(rerunDir, goodD);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      wrG('wbs-server/routes/sysbuild/other.js', '// o2\n');
      const s6 = gate(rerunDir, goodD);
      wrG('wbs-server/routes/sysbuild/other.js', '// o1\n');
      // 84 号 HIGH-2：只被 mustRun（A1）依赖、自动范围看不到的共用文件（不是任何条目的目标 / 失败栈帧 / 测试侧名单文件）在第 ② 步之后首次改动 → 旧口径放行，新口径拒
      wrG('wbs-server/scripts/lib/shared-dep.js', '// 第 ② 步之后才第一次改动的共用文件\n');
      const s7 = gate(rerunDir, goodD);
      fs.unlinkSync(path.join(G, 'wbs-server', 'scripts', 'lib', 'shared-dep.js'));
      wrG('docs/note.md', '# 与条目无关的文档\n');
      const s7b = gate(rerunDir, goodD);
      fs.unlinkSync(path.join(G, 'docs', 'note.md'));
      fs.rmdirSync(path.join(G, 'docs'));
      const s8 = gate(rerunDir, goodD);
      check(s5.status === 1 && /复验之后这些改动文件的内容又变了[^\n]*rules\.js/.test(s5.stdout) && s6.status === 1 && /复验之后改动集里新出现了这些路径[^\n]*other\.js[^\n]*其中会影响该组 \d+ 条的有[^\n]*other\.js/.test(s6.stdout), 'H1：复验之后改动文件内容又变 → 拒；新出现的改动文件会影响该组条目（other.js 是 A2 的目标文件）→ 拒');
      check(s7.status === 1 && /复验之后改动集里新出现了这些路径[^\n]*wbs-server\/scripts\/lib\/shared-dep\.js[^\n]*按自动范围看不出影响哪一条/.test(s7.stdout) && s7b.status === 1 && /新出现了这些路径[^\n]*docs\/note\.md/.test(s7b.stdout) && s8.status === 0, '84 HIGH-2：第 ② 步之后首次改动一个自动范围看不出影响谁的共用文件（只被 mustRun 依赖）→ 第 ③ 步拒（旧口径只看会影响条目的路径，会放行）；新出现的无关文档也拒；恢复之后 → 过');
      // 复验之后才允许生成 / 补写的产物（显式排除名单；89 号 HIGH-1）：第 ② 步 --rerun 用 --dispositions / --report 声明、复验目录在 tmp/ 下，记进 meta.exclusions；第 ③ 步只认这份记录
      const dispIn = path.join(G, 'disp-in-repo.json');
      const repIn = path.join(G, 'report-in-repo.json');
      const rrDecl = path.join(G, 'tmp', 'rr-decl');
      const rDecl = cliG(['--rerun', '--raw-dir', rrDecl, '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG, '--dispositions', dispIn, '--report', repIn]);
      const declMeta = fs.existsSync(path.join(rrDecl, 'api.meta.json')) ? JSON.parse(fs.readFileSync(path.join(rrDecl, 'api.meta.json'), 'utf8')) : null;
      fs.copyFileSync(goodD, dispIn);
      const x1 = gate(rrDecl, dispIn);
      fs.unlinkSync(dispIn);
      const x2 = cliG(['--registry-file', regG, '--parse-only', rrDecl, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective', effG, '--report', repIn]);
      const x3 = cliG(['--registry-file', regG, '--parse-only', rrDecl, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective', effG, '--report', repIn]);
      fs.unlinkSync(repIn);
      const dispOther = path.join(G, 'disp-other.json');
      fs.copyFileSync(goodD, dispOther);
      const x5 = gate(rrDecl, goodD); // 仓库里多了一个没有作为 --dispositions 传入的 json → 不在排除名单里
      fs.unlinkSync(dispOther);
      check(rDecl.status === 0 && declMeta && JSON.stringify(declMeta.exclusions) === JSON.stringify({ files: ['disp-in-repo.json', 'report-in-repo.json'], dirs: ['tmp/rr-decl/'] }) && x1.status === 0 && x2.status === 0 && x3.status === 0 && x5.status === 1 && /新出现了这些路径[^\n]*disp-other\.json/.test(x5.stdout), '84 HIGH-2 + 89 HIGH-1 排除名单：第 ② 步声明并记录（meta.exclusions = 去向表 json、报告、tmp/ 下的复验目录）→ 第 ③ 步在仓库里的去向表 json、--report 报告（第二次运行时它已存在）、复验目录都不计入改动集 → 过；仓库里别的未跟踪文件（没作为 --dispositions 传入）不在排除名单里 → 拒');
      // 89 HIGH-1：当次新增的排除项 → 拒（第 ② 步没声明）；复验目录在仓库里 tmp/ 以外 → 用法错误；排除项与源码 / 驱动 / 登记重叠 → 拒
      const dispNew = path.join(G, 'disp-new.json');
      fs.copyFileSync(goodD, dispNew);
      const y1 = gate(rerunDir, dispNew); // rerunDir 的 meta.exclusions 是空：当次新增的排除项
      fs.unlinkSync(dispNew);
      const y2 = cliG(['--rerun', '--raw-dir', path.join(G, 'rr-bad'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG]);
      const y3 = gate(path.join(G, 'rr-bad2'), goodD);
      const y4 = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-ovl'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG, '--dispositions', path.join(G, 'wbs-server', 'routes', 'sysbuild', 'other.js')]);
      const y5 = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-ovl2'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG, '--report', path.join(G, 'wbs-server', 'scripts', 'fixtures', 'sysbuild-step1', 'mutation-baseline.json')]);
      check(y1.status === 2 && /排除项（文件）disp-new\.json 不在第 ② 步的记录里（第 ③ 步只认第 ② 步记录的排除项/.test(y1.stderr), '89 HIGH-1：第 ③ 步的排除项（去向表 json 在仓库里）第 ② 步没记录 → 用法错误（2）');
      check(y2.status === 2 && /--raw-dir [^\n]*rr-bad 在仓库里、但不在 [^\n]*tmp\/ 下/.test(y2.stderr) && !fs.existsSync(path.join(G, 'rr-bad')) && y3.status === 2 && /--parse-only 的目录 [^\n]*rr-bad2 在仓库里、但不在[^\n]*tmp\/ 下/.test(y3.stderr), '89 HIGH-1：--raw-dir / --parse-only 目录在仓库里 tmp/ 以外 → 用法错误（2，不创建目录）');
      check(y4.status === 2 && /排除项不合规：排除项（文件）wbs-server\/routes\/sysbuild\/other\.js：与源码 \/ 驱动 \/ 登记 \/ 工具目录重叠/.test(y4.stderr) && !fs.existsSync(path.join(gd, 'x-ovl', 'api.log')) && y5.status === 2 && /排除项（文件）wbs-server\/scripts\/fixtures\/sysbuild-step1\/mutation-baseline\.json：与源码/.test(y5.stderr), '89 HIGH-1：--dispositions / --report 与源码（routes/sysbuild/other.js）、基线 fixtures 重叠 → 用法错误（2，什么都不跑）');
      const exu = (e, extra) => exclusionProblems(G, e, extra);
      check(exu({ files: ['docs/d.json'], dirs: ['tmp/x/'] }).length === 0 && exu({ files: [], dirs: ['wbs-server/'] }).length >= 1 && exu({ files: [], dirs: ['wbs-server/routes/sysbuild/'] }).length >= 1 && exu({ files: [], dirs: ['./'] }).length >= 1 && exu({ files: [], dirs: ['docs/'] }).some((p) => /不在 tmp\/ 下/.test(p)) && exu({ files: ['WBS-Server/Scripts/verify-sysbuild-api.js'], dirs: [] }).length === 1 && exu({ files: ['wbs-server/scripts/sysbuild-step1/effective-list.js'], dirs: [] }).length === 1 && exu({ files: ['out/eff.json'], dirs: [] }, [path.join(G, 'out', 'eff.json')]).length === 1 && exu({ files: [], dirs: ['tmp/'] }).length === 0, '89 HIGH-1（纯函数 exclusionProblems）：docs/ 下的文件、tmp/ 下的目录放行；整个 wbs-server/ / routes/sysbuild/ / 仓库根 / 非 tmp 目录 / 大小写别名的驱动文件 / 工具目录文件 / 本次输入文件重叠一律拒');
      check(exclusionsSubsetProblems({ files: ['a.json'], dirs: ['tmp/r/'] }, { files: ['a.json', 'b.json'], dirs: ['tmp/r/'] }).length === 0 && exclusionsSubsetProblems({ files: ['c.json'], dirs: [] }, null).length === 1 && exclusionsSubsetProblems({ files: [], dirs: ['tmp/other/'] }, { files: [], dirs: ['tmp/r/'] }).length === 1, '89 HIGH-1（纯函数 exclusionsSubsetProblems）：第 ③ 步的排除项只能是第 ② 步记录的子集（没有记录 = 空集；目录必须与记录的一致）');
      check(rawDirLocationProblem(G, path.join(G, 'tmp', 'x'), '--raw-dir') === null && rawDirLocationProblem(G, path.join(G, 'TMP', 'x'), '--raw-dir') === null && rawDirLocationProblem(G, path.join(G, 'src'), '--raw-dir') !== null && rawDirLocationProblem(G, G, '--raw-dir') !== null && rawDirLocationProblem(G, path.join(gd, 'outside'), '--raw-dir') === null, '89 HIGH-1（纯函数 rawDirLocationProblem）：raw-dir 位置门——tmp/（含大小写别名）与仓库之外放行，仓库里其他位置与仓库根拒');
      removeTree(path.join(G, 'tmp')); // 上面的复验目录（tmp/rr-decl）用完了；留着会是仓库里的未跟踪文件，进后面各 ③ 的改动集
      // 89 HIGH-2：暂存区指纹——放行的必须是将要提交的内容。rerunDir 是 HEAD（c2）干净状态下复验的：暂存区 = 工作区 = HEAD
      const RULES_G = 'wbs-server/routes/sysbuild/rules.js';
      wrG(RULES_G, '// r3\n');
      gg(['add', RULES_G]);
      wrG(RULES_G, '// r2\n'); // 工作区回到第 ② 步复验的内容，暂存区里是 r3：工作区版本完好、暂存版本被改
      const st1 = gate(rerunDir, goodD);
      gg(['reset', '-q', '--', RULES_G]);
      const st2 = gate(rerunDir, goodD); // 对照：暂存区回到 HEAD → 过
      wrG(RULES_G, '// r3\n');
      gg(['add', RULES_G]); // 暂存区 = 工作区、但都不是第 ② 步复验的内容
      const st3 = gate(rerunDir, goodD);
      wrG(RULES_G, '// r2\n');
      gg(['add', RULES_G]);
      const st4 = gate(rerunDir, goodD); // 对照：都回到 r2 → 过
      check(st1.status === 1 && /暂存区与工作区的内容不一致[^\n]*wbs-server\/routes\/sysbuild\/rules\.js（暂存区与工作区内容不一致）/.test(st1.stdout) && !/复验之后这些改动文件的内容又变了/.test(st1.stdout), '89 HIGH-2：同一路径暂存版本（r3）与工作区（r2，= 第 ② 步复验的内容）不同 → 拒（旧口径只看工作区，放行的却是没复验过的暂存版本）');
      check(/暂存区里这些路径的内容与第 ② 步复验时的内容不一致[^\n]*rules\.js/.test(st1.stdout), '89 HIGH-2：暂存内容（r3）与第 ② 步复验的内容（r2）不一致 → 单独点名（第 ② 步之后只改暂存）');
      check(st2.status === 0 && st3.status === 1 && /复验之后这些改动文件的内容又变了[^\n]*rules\.js/.test(st3.stdout) && st4.status === 0, '89 HIGH-2 对照：暂存区回到 HEAD → 过；暂存区与工作区一致但都不是复验过的内容 → 拒（内容又变了）；都回到复验过的内容 → 过');
      // 89 HIGH-2 / MEDIUM-1：第 ② 步时已在改动集里的未跟踪文件——先复验、后 git add（暂存内容 = 复验内容）放行；没暂存 → 拒；撤销暂存又删掉（路径从改动集消失）→ 拒；仓库根目录出现名为 constructor 的新文件 → 当作新路径报，不当成已记录
      const note2 = path.join(G, 'docs', 'note2.md');
      wrG('docs/note2.md', '# 第 ② 步时已在改动集里的未跟踪文件\n');
      const rrGone = path.join(G, 'tmp', 'rr-gone');
      const rGone = cliG(['--rerun', '--raw-dir', rrGone, '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG]);
      const gneUnstaged = gate(rrGone, goodD);
      gg(['add', 'docs/note2.md']);
      const gneStaged = gate(rrGone, goodD);
      gg(['reset', '-q', '--', 'docs/note2.md']);
      fs.unlinkSync(note2);
      fs.rmdirSync(path.join(G, 'docs'));
      const gneGone = gate(rrGone, goodD);
      wrG('constructor', 'x\n');
      const gneCtor = gate(rerunDir, goodD);
      fs.unlinkSync(path.join(G, 'constructor'));
      check(rGone.status === 0 && gneUnstaged.status === 1 && /暂存区与工作区的内容不一致[^\n]*docs\/note2\.md（暂存区里没有/.test(gneUnstaged.stdout) && !/暂存区里这些路径的内容与第 ② 步复验时的内容不一致/.test(gneUnstaged.stdout) && gneStaged.status === 0, '预筛 LOW-1 + 89 HIGH-2（第 ② 步时就没暂存的路径，第 ③ 步只报「暂存区与工作区不一致」、不报「复验之后暂存区被改过」）：第 ② 步时已在改动集里的未跟踪文件——没 git add → 拒；先复验后 git add（暂存内容 = 复验内容）→ 过');
      check(gneGone.status === 1 && /复验之后这些路径从改动集里消失了[^\n]*docs\/note2\.md/.test(gneGone.stdout), '89 MEDIUM-1：撤销暂存并删掉（已记录的路径从改动集消失）→ 拒（旧口径只查新出现的路径、不查记录里的路径是否还在）');
      check(gneCtor.status === 1 && /新出现了这些路径[^\n]*constructor/.test(gneCtor.stdout), '89 MEDIUM-1：仓库根目录新增名为 constructor 的文件 → 按新出现的路径报（旧口径用 in 判断，会误认成已记录）');
      removeTree(path.join(G, 'tmp'));
      // 共用比较函数（空计划与非空计划同一份；路径映射用 Map，__proto__ / constructor 键名也是普通路径）
      const snapMk = (pairs) => new Map(pairs.map(([p, v]) => [p, v]));
      const rec1 = new Map([['a.js', 's1'], ['__proto__', 's2']]);
      const cur1 = snapMk([['a.js', { sha256: 's1', blob: 'b1', index: 'b1' }], ['__proto__', { sha256: 's2', blob: 'b2', index: 'b2' }], ['constructor', { sha256: 's3', blob: 'b3', index: 'b3' }]]);
      const c1r = compareChangeSnapshot({ recordedFiles: rec1, recordedStage: snapMk([['a.js', { blob: 'b1', index: 'b1' }], ['__proto__', { blob: 'b2', index: 'b2' }]]), current: cur1, excl: null });
      const c2r = compareChangeSnapshot({ recordedFiles: rec1, recordedStage: null, current: snapMk([['a.js', { sha256: 's9', blob: 'b9', index: 'bX' }]]), excl: null });
      const c3r = compareChangeSnapshot({ recordedFiles: new Map([['a.js', 's1'], ['out/log.txt', 's5']]), recordedStage: snapMk([['a.js', { blob: 'b1', index: 'b1' }]]), current: snapMk([['a.js', { sha256: 's1', blob: 'b1', index: 'b1' }]]), excl: { files: [], dirs: ['out/'] } });
      check(c1r.fresh.join() === 'constructor' && c1r.gone.length === 0 && c1r.stale.length === 0 && c1r.stageBad.length === 0 && c1r.stageDrift.length === 0 && c2r.gone.join() === '__proto__' && c2r.stale.join() === 'a.js' && c2r.stageBad.length === 1 && c2r.noStageRecord === true && changeSnapshotMessages(c2r, 'P ').some((m) => /没有记暂存区指纹/.test(m)) && c3r.gone.length === 0 && c3r.fresh.length === 0 && c3r.stageBad.length === 0, '改动快照比较（compareChangeSnapshot，空计划与非空计划共用）：路径映射用 Map——__proto__ 是普通键、constructor 是新路径；双向比（新出现 / 消失 / 内容变了）；暂存区与工作区不一致；旧记录没有暂存区指纹 → 报；排除名单内的路径不参与');
      // 94 MEDIUM：工作区状态按 git status --porcelain=v1 -z 的记录消费——改名 / 复制两端都收；带 " -> "、引号、反斜杠的路径原样，不被文本行解析拆开
      const pz = effList.parseStatusZ('R  new -> name.js\0old "q".js\0?? x\\y.js\0 M a b.js\0C  c2.js\0c1.js\0');
      const textLine = effList.porcelainPaths(['R  "new -> name.js" -> "old.js"']);
      gg(['mv', 'wbs-server/scripts/lib/mid.js', 'wbs-server/scripts/lib/mid-renamed.js']);
      const renSet = changedFilesSince(G, c1);
      gg(['mv', 'wbs-server/scripts/lib/mid-renamed.js', 'wbs-server/scripts/lib/mid.js']);
      check(JSON.stringify(pz.map((e) => [e.xy, e.path, e.orig])) === JSON.stringify([['R ', 'new -> name.js', 'old "q".js'], ['??', 'x\\y.js', null], [' M', 'a b.js', null], ['C ', 'c2.js', 'c1.js']]) && textLine.length === 3 && renSet.has('wbs-server/scripts/lib/mid.js') && renSet.has('wbs-server/scripts/lib/mid-renamed.js') && (() => { try { effList.parseStatusZ('R  only-one-end\0'); return false; } catch (e) { return /缺少另一端/.test(e.message); } })(), '94 MEDIUM：git status -z 按记录解析——改名 / 复制（R / C）取新旧两端，路径含 " -> "、引号、反斜杠原样（旧的文本行解析会把 "new -> name.js" 拆成两段）；缺另一端的改名记录 → 抛错；真实 git mv 改名的两端都进改动集');
      const g5 = gate(metaOf('meta-a2', () => {}), goodD);
      fs.writeFileSync(path.join(gd, 'meta-a2', 'api.log'), mut('api', 'A2', '判红', [FZ()]) + '\n变异自检：1/1 判红（挑选 1 / 共 2；过滤模式）\n');
      const g5b = gate(path.join(gd, 'meta-a2'), goodD);
      check(g5.status === 0 && g5b.status === 1 && /闸门不通过：\[api\] "A1".*本次原始日志里没有这条变异的复验记录/.test(g5b.stdout), '闸门 CLI：日志里只有复验过的子集 → 比较范围 = 日志里有记录的变异，不报缺记录；子集漏了受影响的 A1（日志只有 A2）→ 1');
      // M3：--changed-since 须是 HEAD 的祖先；就是 HEAD 且工作区干净时拒绝；工作区有改动时 S = HEAD 可以
      const orphan = gg(['commit-tree', gg(['rev-parse', 'HEAD^{tree}']).stdout.trim(), '-m', 'orphan']).stdout.trim();
      const m1 = cliG(['--affected', baseG, '--changed-since', orphan]);
      const m2 = cliG(['--affected', baseG, '--changed-since', headG]);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r4\n');
      const m3 = cliG(['--affected', baseG, '--changed-since', headG]);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      const spacePath = changedFilesSince(G, c1);
      check(m1.status === 2 && /不是 HEAD 的祖先/.test(m1.stderr) && m2.status === 2 && /就是 HEAD 且工作区干净/.test(m2.stderr) && m3.status === 0 && /受影响 \[api\] "A1"/.test(m3.stdout) && spacePath.has('wbs-server/scripts/lib/with space 中.js') && spacePath.has('wbs-server/routes/sysbuild/rules.js'), 'M3：--changed-since 不是 HEAD 的祖先 → 拒（2）；就是 HEAD 且工作区干净 → 拒（2）；工作区有改动时 S = HEAD 可用；diff 路径用 -z，含空格 / 中文的路径原样');
      const u1 = cliG(['--parse-only', rawAll, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--dispositions', goodD]);
      const u2 = cliG(['--parse-only', rawAll, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', 'abc123', '--dispositions', goodD, '--effective-none', NONE_REASON]);
      const u3 = cliG(['--parse-only', rawAll, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', '0'.repeat(40), '--dispositions', goodD, '--effective-none', NONE_REASON]);
      const u4 = cliG(['--parse-only', rawAll, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1]);
      const u5 = cliG(['--parse-only', rawAll, '--compare', baseG, '--allow-no-provenance', '--changed-since', c1]);
      check(u1.status === 2 && /必须同时给 --changed-since/.test(u1.stderr) && u2.status === 2 && /完整 40 位小写十六进制/.test(u2.stderr) && u3.status === 2 && /不在本仓库里/.test(u3.stderr) && u4.status === 2 && /必须同时给 --dispositions/.test(u4.stderr) && u5.status === 2 && /--changed-since 只能与/.test(u5.stderr), '闸门 CLI 用法错误（退出码 2）：缺 --changed-since / 不是 40 位提交号 / 提交不存在 / 缺 --dispositions / --changed-since 没有闸门或 --affected');
      // 闸门模式下复验目录里没有任何 <组>.log（不给 --groups）→ 直接拒绝（用法错误，退出码 2）；不因「也许没有受影响条目」放行
      const emptyRaw = path.join(gd, 'raw-empty');
      fs.mkdirSync(emptyRaw, { recursive: true });
      const noLog = spawnSync(process.execPath, [__filename, '--repo', G, '--registry-file', regG, '--parse-only', emptyRaw, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective-none', NONE_REASON], { encoding: 'utf8' });
      check(noLog.status === 2 && /用法错误：.*里没有任何 <组>\.log/.test(noLog.stderr), '闸门模式无日志：复验目录里没有任何 <组>.log（不给 --groups）→ 直接拒绝（用法错误，退出码 2），不提示后继续');
      const h = spawnSync(process.execPath, [__filename, '--help'], { encoding: 'utf8' });
      check(h.status === 0 && /--affected <FIX> --changed-since <S>/.test(h.stdout) && /--rerun --raw-dir <tmp\/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S>/.test(h.stdout) && /--mutation-ids 只跑复验集合里的编号/.test(h.stdout) && /--dispositions <DISP> --require-review-dispositions --changed-since <S>/.test(h.stdout) && /只能整组跑/.test(h.stdout) && /证据核对只证明/.test(h.stdout) && /HEAD 的祖先/.test(h.stdout) && /先跑第 ③ 步（闸门过了），再提交/.test(h.stdout) && /产品侧组级触发/.test(h.stdout) && /meta 还要与日志、组绑定/.test(h.stdout), '--help：打印每个提交的固定命令序列（①编号不丢 ②先列再由 --rerun 真跑 ③对比过闸门），说明 api 能按编号只跑、其余各组整组跑、meta 核对、证据核对的边界、S 的限制');
      check(cliG(['--rerun', '--raw-dir', path.join(gd, 'x')]).status === 2 && cliG(['--affected-from', baseG]).status === 2 && cliG(['--rerun', '--raw-dir', path.join(gd, 'x'), '--affected-from', baseG, '--changed-since', c1, '--compare', baseG]).status === 2, 'H1 用法错误（退出码 2）：--rerun 缺 --affected-from / --changed-since；--affected-from 没有 --rerun；--rerun 与 --compare 同用');

      // ── R1（codex 81 号 HIGH-1 / HIGH-2）：生效清单，整条 CLI ─────────────────────────────
      const wrJson = (name, v) => { const f = path.join(gd, name); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); return f; };
      const readTxt = (f) => fs.readFileSync(f, 'utf8');
      const outOf = (r) => String(r.stdout || '') + String(r.stderr || '');
      // 主流程用生效清单（file 模式）：meta.effective 记清单；复验与对比必须同口径
      wrJson('eff-any.json', { format: effList.FORMAT, commit: 'C2', mustRun: [{ group: 'api', id: 'A1' }], retire: [] });
      check(rrMeta && rrMeta.effective && rrMeta.effective.mode === 'file' && rrMeta.effective.commit === 'CG' && rrMeta.effective.file === 'eff-g.json' && rr.stdout.includes('生效清单 eff-g.json（commit CG') && /生效清单（R1）：生效清单 commit CG（sha256 [0-9a-f]{64}）：mustRun 1、retire 0/.test(g3.stdout), '主流程用生效清单（mustRun A1，无增删）：清单名 / commit / sha256 写进 --rerun 的输出、每组 meta.effective 与闸门第 ③ 步的输出');
      const gNoneOnFile = cliG(['--registry-file', regG, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective-none', '换了一个理由']);
      const gOtherEff = cliG(['--registry-file', regG, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective', path.join(gd, 'eff-any.json')]);
      check(gNoneOnFile.status === 1 && /meta\.effective 不是 --effective-none 或理由与本次不同/.test(outOf(gNoneOnFile)) && gOtherEff.status === 1 && /生效清单 sha256 [0-9a-f]{64} 与 meta 记的 [0-9a-f]{64} 不一致/.test(outOf(gOtherEff)), '复验与对比必须同口径：生效清单复验之后，对比改给 --effective-none → 拒；对比换另一份清单 → 拒');
      // 84 HIGH-3：改了产品 / 测试文件的提交不许用 --effective-none——第 ② 步（--rerun）、第 ③ 步（闸门）、--affected 共用同一个适用范围校验；rules.js 与 scripts/lib 下的文件都不在白名单里
      const noneScopeRerun = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-none-scope'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective-none', NONE_REASON]);
      const noneScopeGate = cliG(['--registry-file', regG, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD, '--effective-none', NONE_REASON]);
      const noneScopeAff = cliG(['--affected', baseG, '--changed-since', c1, '--registry-file', regG, '--effective-none', NONE_REASON]);
      check(noneScopeRerun.status === 1 && /拒绝复验：生效清单：--effective-none 只适用于改动集全部落在工具 \/ 文档白名单内[^\n]*wbs-server\/routes\/sysbuild\/rules\.js[^\n]*wbs-server\/scripts\/lib\/with space 中\.js/.test(noneScopeRerun.stderr) && !fs.existsSync(path.join(gd, 'x-none-scope', 'api.log')) && noneScopeGate.status === 1 && /生效清单：--effective-none 只适用于改动集全部落在工具 \/ 文档白名单内/.test(outOf(noneScopeGate)) && noneScopeAff.status === 1 && /生效清单不通过：--effective-none 只适用于/.test(noneScopeAff.stderr), '84 HIGH-3：改了产品文件（routes/sysbuild/rules.js）与测试助手（scripts/lib/…）的提交用 --effective-none → --rerun 拒绝（不跑任何驱动）、第 ③ 步拒绝、--affected 拒绝（三处同一个校验）');
      // 硬门：两个都不给 → 拒绝（用法错误）；两个都给 → 拒；理由空白 → 拒；不在复验 / 闸门下给 → 拒
      const noEffRerun = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-noeff'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG]);
      const noEffGate = cliG(['--registry-file', regG, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', goodD]);
      check(noEffRerun.status === 2 && /--rerun 必须给 --effective <生效清单 json>.*两个都不给 = 拒绝/.test(noEffRerun.stderr) && !fs.existsSync(path.join(gd, 'x-noeff', 'api.log')) && noEffGate.status === 2 && /--require-review-dispositions 必须给 --effective <生效清单 json>.*两个都不给 = 拒绝/.test(noEffGate.stderr), '硬门：--rerun 与闸门（第 ③ 步）下 --effective 与 --effective-none 两个都不给 → 用法错误（退出码 2），--rerun 什么都不跑');
      const bothEff = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-both'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', path.join(gd, 'eff-any.json'), '--effective-none', 'x']);
      const blankNone = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-blank'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective-none', '   ']);
      const effOnParse = cliG(['--parse-only', rawAll, '--effective-none', 'x']);
      check(bothEff.status === 2 && /--effective 与 --effective-none 只能给一个/.test(bothEff.stderr) && blankNone.status === 2 && /--effective-none 的理由不能是空白/.test(blankNone.stderr) && effOnParse.status === 2 && /只能与 --rerun、--affected、或 --compare … --require-review-dispositions 一起用/.test(effOnParse.stderr), '用法错误（退出码 2）：两个参数同给 / --effective-none 理由是空白 / 在 --parse-only 这类不需要的地方给（--rerun、--affected、闸门下才收）');

      // 基线：A1（rules.js）、A2（other.js），加三条后来被 C2 删除的 A3（等价承接）/ A4（只测停用）/ A5（改挂）
      const rawE5 = path.join(gd, 'raw-e5');
      fs.mkdirSync(rawE5, { recursive: true });
      fs.writeFileSync(path.join(rawE5, 'api.log'), ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => mut('api', id, '判红', [FZ()])).join('\n') + '\n变异自检：5/5 判红（挑选 5 / 共 5；过滤模式）\n');
      const reg5 = wrJson('reg-e5.json', ['A1', 'A2', 'A3', 'A4', 'A5'].map((id) => ({ group: 'api', id, files: [id === 'A1' ? 'wbs-server/routes/sysbuild/rules.js' : 'wbs-server/routes/sysbuild/other.js'], expect: null })));
      const baseE = path.join(gd, 'base-e.json');
      const genE = cliG(['--registry-file', reg5, '--parse-only', rawE5, '--out', baseE, '--no-provenance']);
      // 当前登记（C2 之后）：A1、A2 还在，A3 / A4 / A5 已删，新增 N1（承接 A3）与 N2（A5 改挂）
      const regCur = wrJson('reg-cur.json', ['A1', 'A2', 'N1', 'N2'].map((id) => ({ group: 'api', id, files: [id === 'A1' ? 'wbs-server/routes/sysbuild/rules.js' : 'wbs-server/routes/sysbuild/other.js'], expect: null })));
      const Rg = (id) => ({ group: 'api', id });
      const EFF = (over) => ({ format: effList.FORMAT, commit: 'C2', mustRun: [Rg('A2')], retire: [{ ...Rg('A3'), category: 'equivalent', by: [Rg('N1')] }, { ...Rg('A4'), category: 'stop-only' }, { ...Rg('A5'), category: 'remount', newId: Rg('N2') }], added: [Rg('N1')], ...(over || {}) });
      const effOk = wrJson('eff-ok.json', EFF());
      const rrE = path.join(gd, 'rerun-e');
      const re = cliG(['--rerun', '--raw-dir', rrE, '--affected-from', baseE, '--changed-since', c1, '--effective', effOk, '--registry-file', regCur]);
      const readM = (d) => JSON.parse(readTxt(path.join(d, 'api.meta.json')));
      const reMeta = fs.existsSync(path.join(rrE, 'api.meta.json')) ? readM(rrE) : null;
      const reIds = fs.existsSync(path.join(rrE, 'api.ids.json')) ? JSON.parse(readTxt(path.join(rrE, 'api.ids.json'))) : null;
      const reLog = fs.existsSync(path.join(rrE, 'api.log')) ? readTxt(path.join(rrE, 'api.log')) : '';
      check(genE.status === 0 && re.status === 0 && JSON.stringify(reIds) === '["A1","A2","N1","N2"]' && ['A1', 'A2', 'N1', 'N2'].every((id) => reLog.includes('"id":"' + id + '"')) && reMeta && reMeta.effective.mode === 'file' && reMeta.effective.sha256 === sha256File(effOk) && reMeta.effective.commit === 'C2' && reMeta.effective.file === 'eff-ok.json' && JSON.stringify(reMeta.effective.sources) === '{"auto":["A1"],"mustRun":["A2"],"by":["N1"],"remount":["N2"],"added":["N1","N2"]}' && reMeta.effective.runIds.join() === 'A1,A2,N1,N2' && reMeta.argv.includes('--mutation-ids') && /复验集合 4 条：自动范围 1、mustRun 1、by 1、remount 1/.test(re.stdout), 'R1 --rerun（HIGH-1 / HIGH-2）：复验集合 = 自动范围 A1 ∪ mustRun A2（它的目标文件没改，不在自动范围）∪ by N1（新增的承接变异）∪ remount N2；api 的 --mutation-ids 文件与日志都含这四个编号；meta 记生效清单 sha256 / commit / 按来源列出的并集');
      const EID = '用例甲：状态码不对（await act();#1）';
      const rowOf = (id, over) => ({ 提交: 'C2', group: 'api', id, 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 5/5 全绿', 变异后命中证据: EID, 去向: '登记', ...(over || {}) });
      // 84 HIGH-1：A2 是 mustRun（目标文件没改，自动范围没命中它），基线里属于「需人工复核」（callerNotCaseSite）——也要三字段登记
      const dispOk = [
        rowOf('A1'), rowOf('A2', { 去向: '清单必跑：不需改挂' }), rowOf('N1', { 去向: '新增：承接 A3' }), rowOf('N2', { 去向: '新增：A5 改挂' }),
        { 提交: 'C2', group: 'api', id: 'A3', 去向: '由 N1 承接', 处置类别: 'equivalent', 现行编号: ['N1'], 等价业务错误: '停用后仍可建项应返回 409', 承接命中证据: EID },
        { 提交: 'C2', group: 'api', id: 'A4', 去向: '删除', 处置类别: 'stop-only', 删除依据: '只测旧流程停用行为，审查确认' },
        { 提交: 'C2', group: 'api', id: 'A5', 去向: '改挂 N2', 处置类别: 'remount', 现行编号: 'N2' },
      ];
      const dispOkF = wrJson('disp-e-ok.json', dispOk);
      const gateE = (raw, disp, effArgs, reg) => cliG(['--registry-file', reg || regCur, '--parse-only', raw, '--compare', baseE, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', disp, ...(effArgs || ['--effective', effOk])]);
      const gE0 = gateE(rrE, dispOkF);
      // 84 号 HIGH-1：同键（需人工复核）、自动范围没命中、仅因 mustRun 进复验集合的 A2——缺三字段登记 → 拒；缺其中一个字段 → 拒；补齐（上面 gE0）→ 过
      const gA2Miss = gateE(rrE, wrJson('disp-e-noa2.json', dispOk.filter((d) => d.id !== 'A2')));
      const gA2Field = gateE(rrE, wrJson('disp-e-a2field.json', dispOk.map((d) => (d.id === 'A2' ? { ...d, 业务步骤: '' } : d))));
      const gA2Ev = gateE(rrE, wrJson('disp-e-a2ev.json', dispOk.map((d) => (d.id === 'A2' ? { ...d, 变异后命中证据: '用例乙：别的信息' } : d))));
      check(gA2Miss.status === 1 && /闸门不通过：\[api\] "A2"（生效清单 mustRun，需人工复核：直接调用方不是用例体调用点）：去向表里没有登记/.test(gA2Miss.stdout) && gA2Field.status === 1 && /\[api\] "A2"（生效清单 mustRun，需人工复核[^\n]*）：登记缺字段 业务步骤/.test(gA2Field.stdout) && gA2Ev.status === 1 && /\[api\] "A2"（生效清单 mustRun，需人工复核[^\n]*）：变异后命中证据对不上当前运行里的失败/.test(gA2Ev.stdout) && gE0.status === 0 && /要三字段登记的条目（需复核的受影响 \+ 变了 \+ 生效清单必跑里需复核的）\d+ 条/.test(gE0.stdout), '84 HIGH-1：生效清单 mustRun 里基线属于「需人工复核」的 A2（目标文件没改、自动范围没命中、同键含糊）也要三字段登记——缺登记行 / 缺业务步骤 / 命中证据对不上 → 拒；补齐 → 过');
      check(gE0.status === 0 && /闸门问题 0 条/.test(gE0.stdout) && /生效清单（R1）：生效清单 commit C2（sha256 [0-9a-f]{64}）：mustRun 1、retire 3（stop-only 1 \/ remount 1 \/ equivalent 1）、必跑编号 4/.test(gE0.stdout), 'R1 闸门正例：mustRun / by / remount 都在 meta 绑定的复验编号里、日志有结果行；equivalent 的承接 N1 未变异基线全绿且判红、命中证据对上；retire 三条登记行齐全 → 通过');
      // 日志 / meta 改写助手：只动一处缺陷，日志 sha256 随改写重算（别的绑定都保持成立，断言只看这一处的专属信息）
      const copyRun = (name, fnLog, fnMeta, src, regFile) => {
        const d = path.join(gd, name);
        fs.mkdirSync(d, { recursive: true });
        const s = src || rrE;
        let text = readTxt(path.join(s, 'api.log'));
        if (fnLog) text = fnLog(text);
        fs.writeFileSync(path.join(d, 'api.log'), text);
        fs.copyFileSync(path.join(s, 'api.ids.json'), path.join(d, 'api.ids.json'));
        const m = JSON.parse(JSON.stringify(readM(s)));
        const lb = fs.readFileSync(path.join(d, 'api.log'));
        m.log = { file: 'api.log', sha256: sha256Of(lb), bytes: lb.length };
        if (fnMeta) fnMeta(m, d);
        fs.writeFileSync(path.join(d, 'api.meta.json'), JSON.stringify(m, null, 2));
        copyRj(s, d, regFile || regCur);
        return d;
      };
      const mutIdOf = (l) => { const r = rec.parseMutLine(l); return r && r.rec ? r.rec.id : null; };
      const dropMut = (id) => (t) => t.split('\n').filter((l) => mutIdOf(l) !== id).join('\n');
      const swapMut = (id, line) => (t) => t.split('\n').map((l) => (mutIdOf(l) === id ? line : l)).join('\n');
      const dropMatching = (re2) => (t) => t.split('\n').filter((l) => !re2.test(l)).join('\n');
      // ① HIGH-1：mustRun 的编号不在复验里
      const gMeta = gateE(copyRun('e-meta-ids', null, (m) => { m.effective.runIds = m.effective.runIds.filter((x) => x !== 'A2'); }), dispOkF);
      check(gMeta.status === 1 && /\[api\] "A2"（生效清单 mustRun）：不在 meta 绑定的复验编号里/.test(outOf(gMeta)), 'R1 闸门拒绝（HIGH-1）：mustRun 的 A2 不在 meta 绑定的复验编号里（meta.effective.runIds 被删掉）→ 拒');
      const gLog = gateE(copyRun('e-log-a2', dropMut('A2')), dispOkF);
      check(gLog.status === 1 && /\[api\] "A2"（生效清单 mustRun）：本次原始日志里没有这条变异的结果行/.test(outOf(gLog)), 'R1 闸门拒绝（HIGH-1）：mustRun 的 A2 在日志里没有结果行（meta 绑定的编号里有、实际没跑）→ 拒');
      const effNoMust = wrJson('eff-nomust.json', EFF({ mustRun: [] }));
      const rrE2 = path.join(gd, 'rerun-e2');
      const re2 = cliG(['--rerun', '--raw-dir', rrE2, '--affected-from', baseE, '--changed-since', c1, '--effective', effNoMust, '--registry-file', regCur]);
      const gSwap = gateE(rrE2, dispOkF);
      check(re2.status === 0 && JSON.parse(readTxt(path.join(rrE2, 'api.ids.json'))).join() === 'A1,N1,N2' && gSwap.status === 1 && /\[api\] "A2"（生效清单 mustRun）：不在 meta 绑定的复验编号里/.test(outOf(gSwap)) && /\[api\] "A2"（生效清单 mustRun）：本次原始日志里没有这条变异的结果行/.test(outOf(gSwap)), 'R1 闸门拒绝（HIGH-1 端到端）：复验时的清单没有 mustRun A2（A2 没复验），对比时换成含 mustRun A2 的清单 → A2 从未复验，拒');
      // ③ 换清单：sha256 与 meta 不一致（内容语义相同、只是多一个空行也不行）
      const effSame2 = wrJson('eff-ok-reformatted.json', JSON.stringify(EFF()) + '\n\n');
      const gSha = gateE(rrE, dispOkF, ['--effective', effSame2]);
      check(gSha.status === 1 && /生效清单 sha256 [0-9a-f]{64} 与 meta 记的 [0-9a-f]{64} 不一致：复验之后换过生效清单/.test(outOf(gSha)), 'R1 闸门拒绝：对比用的生效清单与复验时的 sha256 不一致（语义相同、只是格式不同也拒；防换清单）');
      const effOther = wrJson('eff-ok-c3.json', EFF({ commit: 'C3' }));
      const gCommit = gateE(rrE, dispOkF, ['--effective', effOther]);
      check(gCommit.status === 1 && /生效清单的 commit "C3" 与 meta 记的 "C2" 不一致/.test(outOf(gCommit)), 'R1 闸门拒绝：生效清单的 commit 与 meta 记的不同（连带 sha256 对不上）→ 拒');
      // meta 里的并集被改动（来源与现算的不同）
      const gSrc = gateE(copyRun('e-meta-src', null, (m) => { m.effective.sources.by = []; }), dispOkF);
      check(gSrc.status === 1 && /\[api\] meta 记的复验集合（按来源 \+ 并集）与按本次生效清单和改动集现算的不全等/.test(outOf(gSrc)), 'R1 闸门拒绝：meta 记的按来源并集与现算的不全等（by 被改空）→ 拒');
      // api.ids.json 被伪造成只含自动范围（连 meta 里的 ids 哈希一起改对）：内容必须 = 现算的复验集合（含 mustRun / by / remount）
      const gIds = gateE(copyRun('e-ids-forged', null, (m, d) => { const f = path.join(d, 'api.ids.json'); fs.writeFileSync(f, JSON.stringify(['A1'])); m.idsFile.sha256 = sha256File(f); }), dispOkF);
      check(gIds.status === 1 && /api\.ids\.json（1 个编号）与按 [0-9a-f]{40} 现算的复验集合（自动范围 ∪ 生效清单，4 个）不全等/.test(outOf(gIds)), 'R1 闸门拒绝：api.ids.json 被伪造成只含自动范围的 A1（哈希连带改对）→ 与现算的复验集合（A1、A2、N1、N2）不全等，拒');
      // ② HIGH-2：承接变异
      const gNotRed = gateE(copyRun('e-by-notred', swapMut('N1', mut('api', 'N1', '未判红', []))), dispOkF);
      check(gNotRed.status === 1 && /retire \[api\] "A3" 的承接 \[api\] "N1"：当次运行判定 未判红，没有可作命中证据的失败（承接变异必须被抓住/.test(outOf(gNotRed)), 'R1 闸门拒绝（HIGH-2）：equivalent 的承接变异 N1 当次未判红 → 拒');
      const gFixture = gateE(copyRun('e-by-fixture', swapMut('N1', mut('api', 'N1', '判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }]))), dispOkF);
      check(gFixture.status === 1 && /承接 \[api\] "N1"：当次运行判定 判红，没有可作命中证据的失败/.test(outOf(gFixture)), 'R1 闸门拒绝（HIGH-2）：N1 判红但失败只是夹具失败（搭数据退化，不是业务断言）→ 拒');
      const gNoBase = gateE(copyRun('e-by-nobase', dropMatching(/未变异基线/)), dispOkF);
      check(gNoBase.status === 1 && /承接 \[api\] "N1"：该组驱动日志里的未变异基线行缺失或不是全绿（承接变异要先证明未变异时通过）：null/.test(outOf(gNoBase)), 'R1 闸门拒绝（HIGH-2 两步复验的第一步）：该组驱动日志里没有未变异基线行 → 承接变异没有先证明未变异时通过 → 拒');
      const gRedBase = gateE(copyRun('e-by-redbase', (t) => t.replace('✓ 未变异基线（进程内）9/9 全绿', '✗ 未变异基线（进程内）8/9 有失败')), dispOkF);
      check(gRedBase.status === 1 && /承接 \[api\] "N1"：该组驱动日志里的未变异基线行缺失或不是全绿/.test(outOf(gRedBase)), 'R1 闸门拒绝（HIGH-2 两步复验的第一步）：未变异基线行不是全绿（✗ 8/9）→ 拒');
      const gEv = gateE(rrE, wrJson('disp-e-badev.json', dispOk.map((d) => (d.id === 'A3' ? { ...d, 承接命中证据: '用例乙：别的信息' } : d))));
      check(gEv.status === 1 && /承接 \[api\] "N1"：登记行的「承接命中证据」对不上它当次运行里的失败/.test(outOf(gEv)), 'R1 闸门拒绝（HIGH-2）：登记行的「承接命中证据」对不上承接变异当次的失败（用例名 / 信息 / 位置键）→ 拒');
      // ② retire 的去向登记
      const gNoRow = gateE(rrE, wrJson('disp-e-norow.json', dispOk.filter((d) => d.id !== 'A4')));
      const gCat = gateE(rrE, wrJson('disp-e-badcat.json', dispOk.map((d) => (d.id === 'A5' ? { ...d, 处置类别: 'stop-only', 删除依据: 'x' } : d))));
      const gField = gateE(rrE, wrJson('disp-e-nofield.json', dispOk.map((d) => (d.id === 'A3' ? { ...d, 等价业务错误: '' } : d))));
      check(gNoRow.status === 1 && /retire \[api\] "A4"（stop-only）：去向表里没有「提交」= "C2" 的登记行/.test(outOf(gNoRow)) && gCat.status === 1 && /retire \[api\] "A5"（remount）：登记行的「处置类别」是 "stop-only"，生效清单里是 "remount"/.test(outOf(gCat)) && gField.status === 1 && /retire \[api\] "A3"（equivalent）：登记行缺「等价业务错误」/.test(outOf(gField)), 'R1 闸门拒绝：retire 的旧编号缺登记行 / 处置类别与生效清单不符 / 该类别要求的字段缺失 → 各拒');
      // 新增编号（N1 / N2）与基线里没有的变异一样要三字段登记
      const gNewRow = gateE(rrE, wrJson('disp-e-nonew.json', dispOk.filter((d) => d.id !== 'N2')));
      check(gNewRow.status === 1 && /未登记 \[api\] "N2" 现在有基线没有（没有去向记录）/.test(outOf(gNewRow)), 'R1 闸门：新增的改挂目标 N2 本身没有登记行 → 拒（新增变异照旧要去向与三字段登记）');
      // 基线里消失的编号必须与 retire 全等
      const gNoneDel = gateE(rrE, dispOkF, ['--effective-none', '无']);
      check(gNoneDel.status === 1 && /\[api\] "A3"：<S> 时登记里有、当前登记里没有，但本次给的是 --effective-none/.test(outOf(gNoneDel)) && /meta\.effective 不是 --effective-none 或理由与本次不同/.test(outOf(gNoneDel)), 'R1 闸门拒绝：A3 / A4 / A5 已从登记里消失，对比却给 --effective-none → 拒（删除变异必须给生效清单）');
      // --rerun 的拒绝：清单不过 schema / 与登记对不上 → 不跑任何驱动
      const rrBad = (name, d, re3) => { const dd = path.join(gd, name); const r = cliG(['--rerun', '--raw-dir', dd, '--affected-from', baseE, '--changed-since', c1, '--effective', wrJson(name + '.json', d), '--registry-file', regCur]); return r.status === 1 && re3.test(r.stderr) && !fs.existsSync(path.join(dd, 'api.log')) && !fs.existsSync(path.join(dd, 'api.meta.json')); };
      check(rrBad('x-bad-must', EFF({ mustRun: [Rg('ZZ')] }), /拒绝复验：生效清单：mustRun\[0\] \[api\] "ZZ"：不在 <S> 时登记里/), 'R1 --rerun 拒绝：mustRun 的编号不在 <S> 时登记里 → 退出码 1，不跑任何驱动（没有日志也没有 meta）');
      check(rrBad('x-bad-missing', EFF({ retire: [{ ...Rg('A3'), category: 'equivalent', by: [Rg('N1')] }, { ...Rg('A4'), category: 'stop-only' }] }), /拒绝复验：生效清单：<S> 时登记里有、当前登记里没有的编号 \[api\] "A5" 不在 retire 里/), 'R1 --rerun 拒绝：A5 已从登记里消失却没写进 retire（删除变异绕过处置类别）→ 拒');
      check(rrBad('x-bad-by', EFF({ retire: [{ ...Rg('A3'), category: 'equivalent', by: [Rg('N9')] }, { ...Rg('A4'), category: 'stop-only' }, { ...Rg('A5'), category: 'remount', newId: Rg('N2') }] }), /拒绝复验：生效清单：retire\[0\]\.by\[0\] \[api\] "N9"：不在当前登记里（承接变异必须仍已登记）/), 'R1 --rerun 拒绝：承接编号 N9 没有登记 → 拒（承接变异必须仍已登记）');
      const rrNoneDel = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-none-del'), '--affected-from', baseE, '--changed-since', c1, '--registry-file', regCur, '--effective-none', '无']);
      check(rrNoneDel.status === 1 && /拒绝复验：生效清单：\[api\] "A3"：<S> 时登记里有、当前登记里没有，但本次给的是 --effective-none/.test(rrNoneDel.stderr) && !fs.existsSync(path.join(gd, 'x-none-del', 'api.log')), 'R1 --rerun 拒绝：--effective-none 但基线里有编号已从登记里消失 → 拒');
      const effBadJson = wrJson('eff-bad-json.json', '{ 不是 json');
      const rrJson = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-badjson'), '--affected-from', baseE, '--changed-since', c1, '--registry-file', regCur, '--effective', effBadJson]);
      check(rrJson.status === 2 && /--effective 不是 JSON/.test(rrJson.stderr), 'R1：--effective 文件不是 JSON → 用法错误（退出码 2）');
      // --help 文字
      const hE = spawnSync(process.execPath, [__filename, '--help'], { encoding: 'utf8' });
      check(hE.status === 0 && /--rerun --raw-dir <tmp\/ 下的新目录或仓库外的新目录> --affected-from <FIX> --changed-since <S> --effective <EFF>/.test(hE.stdout) && /--require-review-dispositions --changed-since <S> --effective <EFF>/.test(hE.stdout) && /--effective-none "<理由>"/.test(hE.stdout) && /两个都不给 = 拒绝/.test(hE.stdout) && /自动范围（不含已不在登记里的编号）∪ mustRun ∪ 全部 by ∪ 全部 remount 新编号/.test(hE.stdout) && /mutation-check\.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective <EFF>/.test(hE.stdout) && /mutation-check\.js --baseline <FIX> --changed-since <S> --dispositions <DISP> --effective-none "<理由>"/.test(hE.stdout) && !/本次去向表/.test(hE.stdout) && !/不退回/.test(hE.stdout) && /共用当前 node_modules，自动复核发现不了依赖差异；依赖一致性由 line check-deps（阶段边界硬停机）与线内禁装包守住/.test(hE.stdout) && /提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD/.test(hE.stdout) && /--rerun 必须给 --dispositions/.test(hE.stdout) && /累计去向表/.test(hE.stdout) && /--dispositions <DISP> \[--report <报告>\]/.test(hE.stdout), '--help：三步命令示例都带去向表参数与 --effective <EFF>（第 ① 步带 --changed-since），说明复验集合 = 自动范围 ∪ mustRun ∪ by ∪ remount、--effective-none 与「两个都不给 = 拒绝」');

      // 帮助文字与现行实现同步（预筛复看 LOW-2）：生效清单含 added 与集合核对、--affected 不加 --effective 才只列自动范围（旧句已删）、meta 来源含 added、必跑编号与空计划放行条件
      check(/mustRun \/ retire \/ added/.test(hE.stdout) && /新增的承接编号写进 added，若它同时是某条 remount 的 newId 则只在改挂项里声明/.test(hE.stdout) && /当前登记 − <S> 时登记 = added ∪ 全部 remount newId（多一条少一条都拒）/.test(hE.stdout) && /固定基线不再参与增删全等，只用于失败位置对比与需人工复核分类/.test(hE.stdout) && /--effective-none 时 <S> 时登记必须 = 当前登记，且改动集（<S>\.\.HEAD \+ 未提交 \+ 未跟踪）全部落在白名单内/.test(hE.stdout) && /--cumulative --rerun-dir <C2 复验目录> --rerun-dir <C3 复验目录> … --effective <C2 清单> --effective <C3 清单> …（文件模式留档必带，none 模式不带）/.test(hE.stdout) && /0 份复验目录 = 拒绝/.test(hE.stdout) && /显式排除名单|复验目录、去向表登记 json、--report 在显式排除名单里不计/.test(hE.stdout) && /生效清单必跑编号里基线属于「需人工复核」的条目，同样要在去向表里做三字段登记/.test(hE.stdout) && /不加 --effective \/ --effective-none 时只列自动范围（不含生效清单与新增变异）/.test(hE.stdout) && !/只列自动范围，不含生效清单。/.test(hE.stdout) && /按来源（自动 \/ mustRun \/ by \/ remount \/ added）列出的复验集合/.test(hE.stdout) && /mustRun \/ by \/ remount \/ added 新编号必须出现在 meta 绑定的复验编号里/.test(hE.stdout) && /新增变异（added 与 remount 新编号）还须当次判红且失败不能只是夹具失败 \/ 装载异常/.test(hE.stdout) && /空计划放行条件：目录里没有任何 <组>\.log、只有 --rerun 写的 empty-plan\.json（不能与 --groups 同用）/.test(hE.stdout) && /自动范围 ∪ 生效清单的 api 编号 ∪ added/.test(hE.stdout), '--help（LOW-2 / 84 号）：清单写上 added 与「当前登记 − <S> 时登记 = added ∪ remount newId」核对、新编号同时是 newId 与 by 的声明规则、固定基线只用于失败位置对比、--effective-none 白名单、C9 --cumulative、复验之后产物的排除名单、必跑编号里需复核的三字段登记；--affected 句改为「不加 --effective 时只列自动范围」且旧句已删；meta 来源补 added；必跑编号补新增变异须判红且不能只是夹具失败；补空计划放行条件；api.ids.json 说明补 added');
      // ── R1 修复批 ────────────────────────────────────────────────────────────────────
      // 建议项：equivalent 的被删编号在基线里的失败与承接编号当次的失败并排打印（只打印，不改判定）
      check(/承接对照 retire \[api\] "A3" ← 承接 \[api\] "N1"\n    基线（被删编号）：用例甲 \| await act\(\);#1 ; assert\.strictEqual\(r\.status, 200\);#1 \| 状态码不对\n    当次（承接编号）：用例甲 \| await act\(\);#1 ; assert\.strictEqual\(r\.status, 200\);#1 \| 状态码不对/.test(gE0.stdout), '建议项：闸门第 ③ 步对 equivalent（A3 ← N1）把被删编号在基线里的失败与承接编号当次的失败并排打印（用例名 | 位置键 | 信息首行），供人工核对');
      // 预筛 HIGH-1：当前登记里新增的变异（N3）从未执行也放行——两层硬门
      const regCur3 = wrJson('reg-cur3.json', ['A1', 'A2', 'N1', 'N2', 'N3'].map((id) => ({ group: 'api', id, files: [id === 'A1' ? 'wbs-server/routes/sysbuild/rules.js' : 'wbs-server/routes/sysbuild/other.js'], expect: null })));
      const rrN3a = path.join(gd, 'x-n3-undeclared');
      const n3a = cliG(['--rerun', '--raw-dir', rrN3a, '--affected-from', baseE, '--changed-since', c1, '--effective', effOk, '--registry-file', regCur3]);
      const gN3a = gateE(rrE, dispOkF, null, regCur3);
      check(n3a.status === 1 && /拒绝复验：生效清单：当前登记里有、<S> 时登记里没有的编号 \[api\] "N3" 既不在 added 里也不是 remount 的 newId/.test(n3a.stderr) && !fs.existsSync(path.join(rrN3a, 'api.log')) && gN3a.status === 1 && /生效清单：当前登记里有、<S> 时登记里没有的编号 \[api\] "N3" 既不在 added 里也不是 remount 的 newId/.test(outOf(gN3a)) && /api\.ids\.json（4 个编号）与按 [0-9a-f]{40} 现算的复验集合（自动范围，4 个）不全等/.test(outOf(gN3a)), '预筛 HIGH-1 复现（第一层，集合级硬门）：登记里新增 N3，清单既没在 added 里声明、也不是 newId → --rerun 拒绝（不跑）；用没有 N3 的旧复验去过第 ③ 步 → 同样拒绝，且 api.ids.json 与现算的复验集合（含自动并入的 N3）对不上');
      const nNone = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-n3-none'), '--affected-from', baseE, '--changed-since', c1, '--registry-file', regCur3, '--effective-none', '无']);
      check(nNone.status === 1 && /拒绝复验：生效清单：\[api\] "N3"：当前登记里有、<S> 时登记里没有，但本次给的是 --effective-none/.test(nNone.stderr), '预筛 HIGH-1：--effective-none 时当前登记 − <S> 时登记 必须为空——登记里有新增的 N3 → --rerun 拒绝');
      check(rrBad('x-added-base', EFF({ added: [Rg('N1'), Rg('A2')] }), /拒绝复验：生效清单：added\[1\] \[api\] "A2"：已在 <S> 时登记里（added 只声明 <S> 时没有的新增变异）/), '预筛 HIGH-1 自检：added 里写了 <S> 时已有的编号（A2）→ --rerun 拒绝');
      const effN3 = wrJson('eff-n3.json', EFF({ added: [Rg('N1'), { ...Rg('N3'), note: '自检：第二个新增变异' }] }));
      const rrE3 = path.join(gd, 'rerun-e3');
      const re3 = cliG(['--rerun', '--raw-dir', rrE3, '--affected-from', baseE, '--changed-since', c1, '--effective', effN3, '--registry-file', regCur3]);
      const dispN3 = wrJson('disp-e-n3.json', [...dispOk, rowOf('N3', { 去向: '新增：第二个新增变异' })]);
      const gN3 = gateE(rrE3, dispN3, ['--effective', effN3], regCur3);
      check(re3.status === 0 && JSON.parse(readTxt(path.join(rrE3, 'api.ids.json'))).join() === 'A1,A2,N1,N2,N3' && gN3.status === 0 && /必跑编号 5/.test(gN3.stdout) && /闸门问题 0 条/.test(gN3.stdout), '预筛 HIGH-1 正例：N3 声明在 added 里（by 引用的 N1 也在 added 里）→ 复验集合含 N3，闸门通过（N3 判红、有三字段登记与命中证据）');
      const gN3Red = gateE(copyRun('e3-n3-notred', swapMut('N3', mut('api', 'N3', '未判红', [])), null, rrE3), dispN3, ['--effective', effN3], regCur3);
      const gN3Fix = gateE(copyRun('e3-n3-fixture', swapMut('N3', mut('api', 'N3', '判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }])), null, rrE3), dispN3, ['--effective', effN3], regCur3);
      const gN3Miss = gateE(copyRun('e3-n3-nolog', dropMut('N3'), null, rrE3), dispN3, ['--effective', effN3], regCur3);
      const gN3Meta = gateE(copyRun('e3-n3-nometa', null, (m) => { m.effective.runIds = m.effective.runIds.filter((x) => x !== 'N3'); }, rrE3), dispN3, ['--effective', effN3], regCur3);
      const gN2Fix = gateE(copyRun('e3-n2-fixture', swapMut('N2', mut('api', 'N2', '判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }])), null, rrE3), dispN3, ['--effective', effN3], regCur3);
      check(gN3Red.status === 1 && /\[api\] "N3"（生效清单 added）：新增变异当次判定 未判红，没有可作命中证据的失败（新增的变异必须判红/.test(outOf(gN3Red)), '预筛 HIGH-1 自检（第二层）：N3 声明在 added 里但当次未判红 → 拒');
      check(gN3Fix.status === 1 && /\[api\] "N3"（生效清单 added）：新增变异当次判定 判红，没有可作命中证据的失败/.test(outOf(gN3Fix)), '预筛 HIGH-1 自检（第二层）：N3 判红但失败只是夹具失败 → 拒');
      check(gN3Miss.status === 1 && /\[api\] "N3"（生效清单 added）：本次原始日志里没有这条变异的结果行/.test(outOf(gN3Miss)) && gN3Meta.status === 1 && /\[api\] "N3"（生效清单 added）：不在 meta 绑定的复验编号里/.test(outOf(gN3Meta)), '预筛 HIGH-1 自检（第二层）：N3 日志里没有结果行 / 不在 meta 绑定的复验编号里 → 拒（新增的变异必须真执行）');
      check(gN2Fix.status === 1 && /\[api\] "N2"（生效清单 remount）：新增变异当次判定 判红，没有可作命中证据的失败/.test(outOf(gN2Fix)), '预筛 HIGH-1 自检：remount 的新编号 N2 判红但只是夹具失败 → 拒（改挂目标同样是新增变异）');
      // S1 追加（方案 v1.6 5.4 第 ③ 步）：仍登记的每个复验编号——一般 mustRun（A2）也要合格结果；去向表里有 A2 的三字段登记（dispOkF）也放行不了
      const gMrSurv = gateE(copyRun('e-mr-surv', swapMut('A2', mut('api', 'A2', '未判红', []))), dispOkF);
      const gMrFix = gateE(copyRun('e-mr-fix', swapMut('A2', mut('api', 'A2', '判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }]))), dispOkF);
      const gMrBase = gateE(copyRun('e-mr-base', (t) => t.replace('✓ 未变异基线（进程内）9/9 全绿', '✗ 未变异基线（进程内）8/9 有失败')), dispOkF);
      check(gMrSurv.status === 1 && /\[api\] "A2"（生效清单 mustRun）：当次判定 未判红，没有可作命中证据的失败（仍登记的复验编号必须判红且失败不是夹具失败 \/ 装载异常；存活的变异不能靠去向表登记放行，确实要放弃守护的进 retire）/.test(outOf(gMrSurv)) && gMrFix.status === 1 && /\[api\] "A2"（生效清单 mustRun）：当次判定 判红，没有可作命中证据的失败/.test(outOf(gMrFix)) && gMrBase.status === 1 && /\[api\] 该组驱动日志里的未变异对照行缺失或不是全绿（日志里有结果行的编号要先证明未变异时通过；去向表登记放不过）/.test(outOf(gMrBase)) && gE0.status === 0, 'S1 追加：一般 mustRun（A2）存活 / 只有夹具失败 / 所在组未变异对照不是全绿 → 各拒（去向表里有 A2 的登记行也放行不了）；合格结果（gE0）→ 过');
      // S1 裁定 2：合格结果扩到全部复验编号（含自动范围）——A1 只在自动范围里（不在 mustRun / by / newId / added），存活 / 只有夹具失败 → 拒，去向表里有 A1 的三字段登记也放不过
      const gAutoSurv = gateE(copyRun('e-auto-surv', swapMut('A1', mut('api', 'A1', '未判红', []))), dispOkF);
      const gAutoFix = gateE(copyRun('e-auto-fix', swapMut('A1', mut('api', 'A1', '判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }]))), dispOkF);
      const gAutoLoc = gateE(copyRun('e-auto-loc', swapMut('A1', mut('api', 'A1', '判红', [{ ...FZ(), site: 'wbs-server/scripts/lib/h.js:2', message: '状态码变了' }]))), wrJson('disp-e-autoloc.json', dispOk.map((d) => (d.id === 'A1' ? { ...d, 变异后命中证据: '用例甲：状态码变了（await act();#1）' } : d))));
      check(gAutoSurv.status === 1 && /\[api\] "A1"（复验集合：自动范围）：当次判定 未判红，没有可作命中证据的失败（日志里有结果行的仍登记变异必须判红且失败不是夹具失败 \/ 装载异常；存活的变异不能靠去向表登记放行，确实要放弃守护的进 retire）/.test(outOf(gAutoSurv)) && gAutoFix.status === 1 && /\[api\] "A1"（复验集合：自动范围）：当次判定 判红，没有可作命中证据的失败/.test(outOf(gAutoFix)) && gE0.status === 0, 'S1 裁定 2：自动范围里的 A1 存活 / 只有夹具失败 → 拒（去向表里有 A1 的登记行也放不过）；合格结果 → 过');
      // S1 再裁定：日志里有结果行的每个仍登记编号都核，含复验集合之外的（X9：<S> 时已登记、当前仍登记、基线里没有、目标文件没改 → 不在复验集合里，但日志里有结果行；整组跑的非 api 组就是这种情形）
      const regX = wrJson('reg-x9.json', [...JSON.parse(readTxt(regCur)), { group: 'api', id: 'X9', files: ['wbs-server/routes/sysbuild/other.js'], expect: null }]);
      const sX = wrJson('s-x9.json', [...['A1', 'A2', 'A3', 'A4', 'A5', 'X9'].map((id) => ({ group: 'api', id }))]);
      const effX = ['--effective', effOk, '--s-registry-file', sX];
      const dispX = (over) => wrJson('disp-x9.json', [...dispOk, rowOf('X9', { 去向: '整组跑出的集合外条目', ...(over || {}) })]);
      const addX = (v, failures) => (t) => t.replace('变异自检：', mut('api', 'X9', v, failures) + '\n变异自检：');
      // 这组用例的 <S> 时登记经 --s-registry-file sX 给（含 X9），第 ② 步（rrE）记的摘要是另一份：改写 meta 里的 <S> 时登记摘要，只让这里要测的那一处成立（96 号 HIGH-3 的摘要核对）
      const sXdig = effList.digestRecord(['A1', 'A2', 'A3', 'A4', 'A5', 'X9'].map((id) => ({ group: 'api', id })), '自检钩子（内部注入）');
      const fixSreg = (m) => { m.sRegistry = sXdig; };
      const gXok = gateE(copyRun('e-x9-ok', addX('判红', [FZ()]), fixSreg, null, regX), dispX(), effX, regX);
      const gXsurv = gateE(copyRun('e-x9-surv', addX('未判红', []), fixSreg, null, regX), dispX(), effX, regX);
      const gXfix = gateE(copyRun('e-x9-fix', addX('判红', [{ ...FZ(), errorClass: 'SyntaxError', message: '被测脚本语法错误（装载异常）' }]), fixSreg, null, regX), dispX(), effX, regX);
      check(gXok.status === 0 && gXsurv.status === 1 && /\[api\] "X9"（日志结果：复验集合之外（整组跑出））：当次判定 未判红，没有可作命中证据的失败（日志里有结果行的仍登记变异必须判红且失败不是夹具失败 \/ 装载异常；存活的变异不能靠去向表登记放行/.test(outOf(gXsurv)) && gXfix.status === 1 && /\[api\] "X9"（日志结果：复验集合之外（整组跑出））：当次判定 判红，没有可作命中证据的失败/.test(outOf(gXfix)), 'S1 再裁定：日志里有结果行、但不在复验集合里的仍登记编号（X9，整组跑出）存活 / 只有夹具失败 → 拒（去向表里有 X9 的三字段登记行也放不过）；判红 → 过');
      check(gAutoLoc.status === 0 && /已登记 \[api\] "A1" 失败位置变化/.test(gAutoLoc.stdout) && !/当次判定/.test(outOf(gAutoLoc)), 'S1 裁定 2：「变了」只允许是判红但失败位置 / 信息变化（A1 判红、失败信息变了，三字段登记齐全、命中证据对上新失败）→ 不被合格结果拦，过');

      // MED-1：--affected 接受 --effective / --effective-none，按来源分开打印完整复验集合；没给只列自动范围
      const aff1 = cliG(['--affected', baseE, '--changed-since', c1, '--effective', effN3, '--registry-file', regCur3]);
      check(aff1.status === 0 && /复验集合（与 --rerun 同口径；生效清单 commit C2（sha256 [0-9a-f]{64}）；自动范围按「基线 ∩ 当前登记」再加 C1 之后新增的现行编号算[^\n]*）：1 组；自动范围 1 条、复验编号合计 5 个（去重后）/.test(aff1.stdout) && /\[api\] 5 条（去重后）：自动范围 1、mustRun 1、by 1、remount 1、added 3/.test(aff1.stdout) && /    auto：\["A1"\]/.test(aff1.stdout) && /    mustRun：\["A2"\]/.test(aff1.stdout) && /    by：\["N1"\]/.test(aff1.stdout) && /    remount：\["N2"\]/.test(aff1.stdout) && /    added：\["N1","N2","N3"\]/.test(aff1.stdout) && /api\.ids\.json|--mutation-ids/.test(aff1.stdout), 'MED-1：--affected --effective 按来源分开打印完整复验集合（与 --rerun 同口径：自动范围 A1、mustRun A2、by N1、remount N2、added N1 N2 N3）');
      const aff2 = cliG(['--affected', baseE, '--changed-since', c1, '--effective', effOk, '--registry-file', regCur3]);
      check(aff2.status === 1 && /生效清单不通过：当前登记里有、<S> 时登记里没有的编号 \[api\] "N3"/.test(aff2.stderr), 'MED-1：--affected --effective 对清单同样过 schema / 登记校验（登记里有未声明的 N3 → 退出码 1）');
      check(af.status === 0 && /未给 --effective \/ --effective-none：只列自动范围（整份基线，不含生效清单，也不含当前登记里新增的变异）/.test(af.stdout), 'MED-1：--affected 不给 --effective / --effective-none 时明说只列自动范围（不含生效清单与新增变异）');

      // MED-2：有日志的目录里不许同时有空计划记录
      const mixedDir = copyRun('e-mixed', null, null, rrE);
      fs.writeFileSync(path.join(mixedDir, 'empty-plan.json'), '{}\n');
      const gMixed = spawnSync(process.execPath, [__filename, '--repo', G, '--registry-file', regCur, '--parse-only', mixedDir, '--compare', baseE, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', c1, '--dispositions', dispOkF, '--effective', effOk], { encoding: 'utf8' });
      check(gMixed.status === 1 && /空计划记录：目录里既有复验日志又有 empty-plan\.json/.test(outOf(gMixed)), 'MED-2：目录里既有复验日志又有 empty-plan.json → 拒');
      // MED-2：零复验提交——一个只改文档的提交（c3，docs/x.md），清单只有 retire A2（stop-only）、登记里 A2 已删
      wrG('docs/x.md', '# 无关文档\n');
      gg(['add', '-A']);
      gg(['commit', '-q', '-m', 'c3']);
      // 96 号 HIGH-1：此后正式闸门的 <S> 只能是 HEAD（c3）或 HEAD 的第一父提交（c2 = headG）；c1 已是更早的祖先。下面依赖「c1..HEAD 里改过 rules.js」的用例改用 cS = HEAD（这时改动集 = 工作区里的改动，用例按需把 rules.js 改一下）
      const cS = gg(['rev-parse', 'HEAD']).stdout.trim();
      gateSince = cS;
      const regZ = wrJson('reg-z.json', [{ group: 'api', id: 'A1', files: ['wbs-server/routes/sysbuild/rules.js'], expect: null }]);
      const effZ = wrJson('eff-z.json', { format: effList.FORMAT, commit: 'C3', mustRun: [], retire: [{ ...Rg('A2'), category: 'stop-only' }] });
      const dispZ = wrJson('disp-z.json', [{ 提交: 'C3', group: 'api', id: 'A2', 去向: '删除', 处置类别: 'stop-only', 删除依据: '只测旧流程停用行为' }]);
      const rrZ = path.join(gd, 'rerun-z');
      const rz = cliG(['--rerun', '--raw-dir', rrZ, '--affected-from', baseG, '--changed-since', headG, '--effective', effZ, '--registry-file', regZ]);
      const zPlan = fs.existsSync(path.join(rrZ, 'empty-plan.json')) ? JSON.parse(readTxt(path.join(rrZ, 'empty-plan.json'))) : null;
      check(rz.status === 0 && /已写空计划记录/.test(rz.stdout) && zPlan && zPlan.format === 'sysbuild-empty-rerun/1' && zPlan.startHead === gg(['rev-parse', 'HEAD']).stdout.trim() && zPlan.changedSince === headG && Object.keys(zPlan.changedFiles).join() === 'docs/x.md' && /^[0-9a-f]{64}$/.test(zPlan.changedFilesSha256) && zPlan.effective.sha256 === sha256File(effZ) && zPlan.effective.commit === 'C3' && !!Date.parse(zPlan.startedAt) && fs.existsSync(path.join(rrZ, 'rerun.json')) && !fs.existsSync(path.join(rrZ, 'api.log')), 'MED-2：--rerun 复验集合为空（只改文档、清单只有 retire stop-only）→ 也写复验目录：rerun.json + empty-plan.json（绑定 HEAD、改动文件集合 sha256、生效清单 sha256 / commit、起始时刻），不跑任何驱动');
      const affZ = cliG(['--affected', baseG, '--changed-since', headG, '--effective', effZ, '--registry-file', regZ]);
      check(affZ.status === 0 && /复验集合（与 --rerun 同口径；生效清单 commit C3（sha256 [0-9a-f]{64}））：空——自动范围 0 条、生效清单必跑 0 个、新增变异 0 个/.test(affZ.stdout), 'MED-1：自动范围为空时 --affected --effective 也打印（复验集合为空）');
      // ── 96 号新增：正式闸门的 <S> 起点（HEAD = c3；c1 是更早的祖先，headG = c2 是 HEAD 的第一父提交）与跨检出调用 ──
      const xo1 = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-old-s'), '--affected-from', baseG, '--changed-since', c1, '--registry-file', regG, '--effective', effG]);
      const xo2 = gate(rerunDir, goodD, c1);
      const xo3 = cliG(['--affected', baseG, '--changed-since', c1, '--effective', effG, '--registry-file', regG]);
      const xo4 = cliG(['--affected', baseG, '--changed-since', c1, '--registry-file', regG]); // 不带清单的 --affected 是累计查询类入口：保留任意祖先
      const xo5 = cliG(['--affected', baseG, '--changed-since', headG, '--effective', effZ, '--registry-file', regZ]); // HEAD 的第一父提交：允许
      check(xo1.status === 2 && /既不是 HEAD[^\n]*也不是 HEAD 的第一父提交/.test(xo1.stderr) && !fs.existsSync(path.join(gd, 'x-old-s', 'api.log')) && xo2.status === 2 && /既不是 HEAD/.test(xo2.stderr) && xo3.status === 2 && xo4.status === 0 && xo5.status === 0, '96 HIGH-1：第 ② 步 / 第 ③ 步 / --affected 带清单的 <S> 是更早的祖先（c1，HEAD 是 c3）→ 用法错误（2），不跑驱动；不带清单的 --affected 仍收任意祖先；<S> = HEAD 的第一父提交 → 允许');
      const fr = realSpawnSync(process.execPath, [__filename, '--repo', G, '--rerun', '--raw-dir', path.join(gd, 'x-foreign'), '--affected-from', baseG, '--changed-since', headG, '--effective', effZ, '--dispositions', goodD], { encoding: 'utf8' });
      const fr3 = realSpawnSync(process.execPath, [__filename, '--repo', G, '--parse-only', rerunDir, '--compare', baseG, '--require-review-dispositions', '--changed-since', headG, '--dispositions', goodD, '--effective', effZ], { encoding: 'utf8' });
      check(fr.status === 2 && /运行的脚本在 [^\n]*不在 --repo/.test(fr.stderr) && fr3.status === 2 && /不在 --repo/.test(fr3.stderr) && !fs.existsSync(path.join(gd, 'x-foreign', 'api.log')), '96 MEDIUM（降级项）：从本检出的脚本去审另一个仓库（--repo 指向临时仓库）→ 第 ② 步 / 第 ③ 步都是用法错误（2，跨检出调用）');
      // ── 预筛 MED-1：<S> = HEAD 的第一父提交（headG = c2，HEAD = c3）+ 工作区有未提交 / 未跟踪的改动 → 三步与 --affected 带清单都是用法错误；干净 / <S> = HEAD → 不拒 ──
      const dirtyG = path.join(G, 'wbs-server', 'scripts', 'lib', 'zz-dirty-after-commit.js');
      const ckC = (extra) => cliG(['--force-clean-check', ...extra]);
      const dkAff = ['--affected', baseG, '--changed-since', headG, '--effective', effZ, '--registry-file', regZ];
      const dkRerun = ['--rerun', '--raw-dir', path.join(gd, 'x-dirty'), '--affected-from', baseG, '--changed-since', headG, '--effective', effZ, '--registry-file', regZ, '--dispositions', goodD];
      const dkGate = ['--registry-file', regZ, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', headG, '--dispositions', goodD, '--effective', effZ];
      const dkClean = ckC(dkAff);
      fs.writeFileSync(dirtyG, '// 提交后补跑时还没提交的改动\n');
      const dk1 = ckC(dkAff);
      const dk2 = ckC(dkRerun);
      const dk3 = ckC(dkGate);
      const dk4 = ckC(['--affected', baseG, '--changed-since', cS, '--effective', effZ, '--registry-file', regZ]); // <S> = HEAD：还没提交的改动就是改动集，不核
      fs.unlinkSync(dirtyG);
      check(dkClean.status !== 2 && [dk1, dk2, dk3].every((r) => r.status === 2 && /提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD/.test(r.stderr) && /zz-dirty-after-commit\.js/.test(r.stderr)) && !fs.existsSync(path.join(gd, 'x-dirty', 'api.log')) && dk4.status !== 2, '预筛 MED-1：<S> = HEAD^ 而工作区有未跟踪文件 → 第 ② 步（--rerun，不跑驱动）/ 第 ③ 步 / --affected 带清单一律用法错误（2，提示「提交后补跑要求工作区干净；还没提交的改动用 <S> = HEAD」）；工作区干净 → 不是用法错误；<S> = HEAD + 工作区改动 → 不拒');
      const rdReq = realSpawnSync(process.execPath, [__filename, '--rerun', '--raw-dir', path.join(gd, 'x-nodisp'), '--affected-from', baseG, '--changed-since', headG, '--effective', effZ], { encoding: 'utf8' });
      check(rdReq.status === 2 && /--rerun 必须给 --dispositions <累计去向表 json>/.test(rdReq.stderr), '预筛 LOW-3：--rerun 不给 --dispositions → 用法错误（2）');
      const gateZ = (d, effArgs, disp) => spawnSync(process.execPath, [__filename, '--repo', G, '--registry-file', regZ, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', headG, '--dispositions', disp || dispZ, ...(effArgs || ['--effective', effZ])], { encoding: 'utf8' });
      const gz0 = gateZ(rrZ);
      check(gz0.status === 0 && /空计划记录：用当前 HEAD \/ 改动集 \/ 生效清单重算，复验集合确实为空，绑定字段全部一致（放行）/.test(gz0.stdout) && /闸门问题 0 条/.test(gz0.stdout), 'MED-2 正例：第 ③ 步目录里只有空计划记录 → 用当前 HEAD / 改动集 / 清单重算，复验集合确实为空、绑定字段一致 → 放行');
      const gzGroups = cliG(['--registry-file', regZ, '--parse-only', rrZ, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', headG, '--dispositions', dispZ, '--effective', effZ]); // cliG 自带 --groups api
      check(gzGroups.status === 2 && /用法错误：.*里有 empty-plan\.json.*第 ③ 步不能与 --groups 同用/.test(gzGroups.stderr), 'MED-2（预筛复看 LOW-1）：目录里只有 empty-plan.json、却给了 --groups api → 用法错误（退出码 2），提示「空计划记录不能与 --groups 同用」，而不是误导的「没有 api.log」');
      const copyZ = (name, fn) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); const p = JSON.parse(readTxt(path.join(rrZ, 'empty-plan.json'))); fn(p); fs.writeFileSync(path.join(d, 'empty-plan.json'), JSON.stringify(p, null, 2)); return d; };
      const gzHead = gateZ(copyZ('z-head', (p) => { p.startHead = c1; }));
      const gzSelf = gateZ(copyZ('z-self', (p) => { p.changedFiles = {}; }));
      const gzEff = gateZ(copyZ('z-eff', (p) => { p.effective.sha256 = 'f'.repeat(64); }));
      const gzOld = gateZ(copyZ('z-old', (p) => { p.startedAt = '2000-01-01T00:00:00.000Z'; }));
      check(gzHead.status === 1 && /空计划记录：记的 HEAD [0-9a-f]{40} 不是当前 HEAD/.test(outOf(gzHead)) && gzSelf.status === 1 && /空计划记录：改动文件集合与它自己记的 sha256 对不上/.test(outOf(gzSelf)) && gzEff.status === 1 && /空计划记录：生效清单 sha256 \/ commit 与本次不一致/.test(outOf(gzEff)) && gzOld.status === 1 && /空计划记录：起始时刻 2000-01-01T00:00:00\.000Z 早于 .* 最晚提交时间/.test(outOf(gzOld)), 'MED-2 拒绝：记的 HEAD 不是当前 HEAD / 改动文件集合与自己的 sha256 对不上 / 生效清单 sha256 不一致 / 起始时刻早于最晚提交 → 各拒');
      wrG('docs/y.md', '# 记录之后新增的改动文件\n');
      const gzFiles = gateZ(rrZ);
      fs.unlinkSync(path.join(G, 'docs', 'y.md'));
      check(gzFiles.status === 1 && /空计划记录：复验之后改动集里新出现了这些路径[^\n]*docs\/y\.md/.test(outOf(gzFiles)), 'MED-2 拒绝：记录之后工作区多了一个改动文件（docs/y.md）→ 改动文件集合对不上，拒');
      const effZ2 = wrJson('eff-z2.json', { format: effList.FORMAT, commit: 'C3', mustRun: [Rg('A1')], retire: [{ ...Rg('A2'), category: 'stop-only' }] });
      const gzPlan = gateZ(rrZ, ['--effective', effZ2]);
      check(gzPlan.status === 1 && /空计划记录：按当前 HEAD \/ 改动集 \/ 生效清单重算，复验集合不是空的（api 1 个）/.test(outOf(gzPlan)) && /\[api\] "A1"（生效清单 mustRun）：这一组没有复验日志与 meta/.test(outOf(gzPlan)), 'MED-2 拒绝：用含 mustRun A1 的清单重算，复验集合不是空的（A1 必须复验、目录里却只有空计划）→ 拒');
      const gzNone = gateZ(rrZ, ['--effective-none', '无']);
      check(gzNone.status === 1 && /空计划记录：生效清单口径与本次不同/.test(outOf(gzNone)), 'MED-2 拒绝：空计划记录绑定的是生效清单，第 ③ 步改给 --effective-none → 拒');

      // 84 HIGH-3 正例：只改文档的提交（c3：docs/x.md）、<S> 时登记 = 当前登记 → --effective-none 放行（--rerun 写空计划，第 ③ 步重算后放行）
      const NONE_DOC = '只改文档的 C3';
      const rrNone = path.join(gd, 'rerun-none');
      const rnone = cliG(['--rerun', '--raw-dir', rrNone, '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective-none', NONE_DOC]);
      const nonePlan = fs.existsSync(path.join(rrNone, 'empty-plan.json')) ? JSON.parse(readTxt(path.join(rrNone, 'empty-plan.json'))) : null;
      const gateNone = (d, since, extra) => spawnSync(process.execPath, [__filename, '--repo', G, '--registry-file', regG, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', since, '--dispositions', dispZ, '--effective-none', NONE_DOC, ...(extra || [])], { encoding: 'utf8' });
      const gnone = gateNone(rrNone, headG);
      check(rnone.status === 0 && nonePlan && nonePlan.effective.mode === 'none' && nonePlan.effective.reason === NONE_DOC && Object.keys(nonePlan.changedFiles).join() === 'docs/x.md' && gnone.status === 0 && /空计划记录：用当前 HEAD \/ 改动集 \/ 生效清单重算，复验集合确实为空，绑定字段全部一致（放行）/.test(gnone.stdout) && /生效清单（R1）：--effective-none：/.test(gnone.stdout), '84 HIGH-3 正例：只改文档（docs/x.md）、登记没有增删 → --effective-none 放行（--rerun 写空计划记录，第 ③ 步放行；理由写进记录与输出）');
      // 84 LOW-1：写空计划之前，目录里已有任何组日志 / meta / ids / 计划文件都拒绝
      const rrNoneBad = path.join(gd, 'rerun-none-bad');
      fs.mkdirSync(rrNoneBad, { recursive: true });
      fs.writeFileSync(path.join(rrNoneBad, 'api.log'), '残留的组日志\n');
      const rnoneBad = cliG(['--rerun', '--raw-dir', rrNoneBad, '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective-none', NONE_DOC]);
      check(rnoneBad.status === 2 && /--raw-dir 里已有 api\.log（不覆盖；空计划记录不能与复验日志 \/ meta \/ 计划文件同目录/.test(rnoneBad.stderr) && !fs.existsSync(path.join(rrNoneBad, 'empty-plan.json')), '84 LOW-1：空计划写入前统一查目录——已有组日志（api.log）→ 拒绝（用法错误），不写 empty-plan.json（旧版写成功之后第 ③ 步才拒）');
      // 84 LOW-1：<S> 就是 HEAD、工作区有改动时没有「<S>..HEAD 最晚提交」参照，起始时刻仍要能解析
      wrG('docs/w.md', '# <S> 就是 HEAD 时的改动\n');
      gg(['add', 'docs/w.md']); // 第 ③ 步要求改动集在暂存区与工作区一致（89 号 HIGH-2）
      const headC3 = gg(['rev-parse', 'HEAD']).stdout.trim();
      const rrNone3 = path.join(gd, 'rerun-none-head');
      const rnone3 = cliG(['--rerun', '--raw-dir', rrNone3, '--affected-from', baseG, '--changed-since', headC3, '--registry-file', regG, '--effective-none', NONE_DOC]);
      const gnone3 = gateNone(rrNone3, headC3);
      const planNone3 = JSON.parse(readTxt(path.join(rrNone3, 'empty-plan.json')));
      const tamperDir = path.join(gd, 'none3-tamper');
      fs.mkdirSync(tamperDir, { recursive: true });
      fs.writeFileSync(path.join(tamperDir, 'empty-plan.json'), JSON.stringify({ ...planNone3, startedAt: '不是时间' }, null, 2));
      const gnone3b = gateNone(tamperDir, headC3);
      gg(['rm', '-q', '--cached', 'docs/w.md']);
      fs.unlinkSync(path.join(G, 'docs', 'w.md'));
      check(rnone3.status === 0 && gnone3.status === 0 && gnone3b.status === 1 && /空计划记录：起始时刻 "不是时间" 不是可解析的时间/.test(outOf(gnone3b)), '84 LOW-1：<S> 就是 HEAD（没有 <S>..HEAD 提交时间参照）时，空计划记录的起始时刻仍校验可解析：正常记录 → 放行；起始时刻改成不可解析 → 拒（旧版跳过校验）');
      // 84 号 HIGH-3 / 空计划：none 模式下，记录之后改了产品文件（越界）→ 第 ③ 步拒（适用范围校验在第 ③ 步照样做）
      wrG('wbs-server/routes/sysbuild/rules.js', '// 记录之后越界改动\n');
      const gnone4 = gateNone(rrNone, headG);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      check(gnone4.status === 1 && /生效清单：--effective-none 只适用于改动集全部落在工具 \/ 文档白名单内[^\n]*wbs-server\/routes\/sysbuild\/rules\.js/.test(outOf(gnone4)), '84 HIGH-3：none 模式空计划记录之后，改动集里多了产品文件（rules.js）→ 第 ③ 步拒（适用范围校验第 ② 步与第 ③ 步共用）');

      // 预筛 MED：只改 .gitignore 的提交——改动在 none 白名单之外，用带 reason 的空清单（mustRun / retire / added 全空）过；空清单无 reason 拒；闸门照常跑（这里自动范围为空 → 空计划记录，第 ③ 步放行）
      wrG('.gitignore', 'tmp/\n');
      gg(['add', '.gitignore']); // 第 ③ 步要求改动集在暂存区与工作区一致（89 号 HIGH-2）
      const effReason = wrJson('eff-reason.json', { format: effList.FORMAT, commit: 'C3', reason: '只改 .gitignore：没有任何变异受影响', mustRun: [], retire: [] });
      const effNoReason = wrJson('eff-noreason.json', { format: effList.FORMAT, commit: 'C3', mustRun: [], retire: [] });
      const rrReason = path.join(gd, 'rerun-reason');
      const rReason = cliG(['--rerun', '--raw-dir', rrReason, '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective', effReason]);
      const rNoReason = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-noreason'), '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective', effNoReason]);
      const rNoneGi = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-none-gi'), '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective-none', NONE_DOC]);
      const reasonPlan = fs.existsSync(path.join(rrReason, 'empty-plan.json')) ? JSON.parse(readTxt(path.join(rrReason, 'empty-plan.json'))) : null;
      const gReason = spawnSync(process.execPath, [__filename, '--repo', G, '--registry-file', regG, '--parse-only', rrReason, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', headG, '--dispositions', emptyD, '--effective', effReason], { encoding: 'utf8' });
      gg(['rm', '-q', '--cached', '.gitignore']);
      fs.unlinkSync(path.join(G, '.gitignore'));
      check(rReason.status === 0 && reasonPlan && reasonPlan.effective.mode === 'file' && reasonPlan.effective.reason === '只改 .gitignore：没有任何变异受影响' && Object.keys(reasonPlan.changedFiles).sort().join() === '.gitignore,docs/x.md' && rReason.stdout.includes('reason "只改 .gitignore') && gReason.status === 0 && /生效清单（R1）：生效清单 commit C3（sha256 [0-9a-f]{64}）：mustRun 0、retire 0（stop-only 0 \/ remount 0 \/ equivalent 0）、必跑编号 0；reason "只改 \.gitignore/.test(gReason.stdout) && /空计划记录：用当前 HEAD \/ 改动集 \/ 生效清单重算，复验集合确实为空，绑定字段全部一致（放行）/.test(gReason.stdout), '预筛 MED：只改 .gitignore 的提交用带 reason 的空清单 → --rerun 通过（reason 写进空计划记录与输出）、第 ③ 步放行（输出带 reason）');
      check(rNoReason.status === 1 && /拒绝复验：生效清单：mustRun、retire、added 都是空：全空的清单必须带非空的 "reason" 字段/.test(rNoReason.stderr) && rNoneGi.status === 1 && /拒绝复验：生效清单：--effective-none 只适用于[^\n]*\.gitignore/.test(rNoneGi.stderr), '预筛 MED / LOW：全空清单无 reason → --rerun 拒绝；同一个只改 .gitignore 的提交用 --effective-none → 拒（.gitignore 不在 none 白名单里）');

      // 预筛复看 1（CLI）：只改 rules.js（产品文件）+ 全空清单带 reason → 拒（不跑任何驱动）；预筛复看 3：rerun.json 也写入 reason（空计划与非空计划两种）
      wrG('wbs-server/routes/sysbuild/rules.js', '// 越界改动\n');
      const rReasonProd = cliG(['--rerun', '--raw-dir', path.join(gd, 'x-reason-prod'), '--affected-from', baseG, '--changed-since', headG, '--registry-file', regG, '--effective', effReason]);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      const effRj = wrJson('eff-rj.json', { format: effList.FORMAT, commit: 'CJ', reason: '清单附带说明', mustRun: [Rg('A1')], retire: [] });
      const rrRj = path.join(gd, 'rerun-rj');
      wrG('wbs-server/routes/sysbuild/rules.js', '// r9 工作区里的改动（S = HEAD 时改动集不能为空）\n');
      const rRj = cliG(['--rerun', '--raw-dir', rrRj, '--affected-from', baseG, '--changed-since', cS, '--registry-file', regG, '--effective', effRj]);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      const rjJson = fs.existsSync(path.join(rrRj, 'rerun.json')) ? JSON.parse(readTxt(path.join(rrRj, 'rerun.json'))) : null;
      const rjEmpty = JSON.parse(readTxt(path.join(rrReason, 'rerun.json')));
      check(rReasonProd.status === 1 && /拒绝复验：生效清单：mustRun \/ retire \/ added 全空的清单（只靠 reason）不能用于改了产品或测试路径的提交[^\n]*wbs-server\/routes\/sysbuild\/rules\.js/.test(rReasonProd.stderr) && !fs.existsSync(path.join(gd, 'x-reason-prod', 'api.log')) && rRj.status === 0 && rjJson && rjJson.effective.reason === '清单附带说明' && rjJson.effective.commit === 'CJ' && rjEmpty.effective.reason === '只改 .gitignore：没有任何变异受影响', '预筛复看 1：只改 rules.js + 全空清单带 reason → --rerun 拒绝（不跑驱动）；预筛复看 3：rerun.json 的 effective 也带 reason（非空计划、空计划两种）');

      // S1 裁定 3（端到端）：C2 新增 N1（目标 rules.js，<S> = C2 之后的登记里已有它），C3 改 rules.js 且清单不写 N1 → N1 仍进复验集合（来源 auto）
      const regC3 = wrJson('reg-c3.json', [{ group: 'api', id: 'A1', files: ['wbs-server/routes/sysbuild/rules.js'], expect: null }, { group: 'api', id: 'A2', files: ['wbs-server/routes/sysbuild/other.js'], expect: null }, { group: 'api', id: 'N1', files: ['wbs-server/routes/sysbuild/rules.js'], expect: null }]);
      const sC2 = wrJson('s-c2.json', [{ group: 'api', id: 'A1' }, { group: 'api', id: 'A2' }, { group: 'api', id: 'N1' }]);
      const effC3n = wrJson('eff-c3n.json', { format: effList.FORMAT, commit: 'C3', mustRun: [Rg('A2')], retire: [] });
      wrG('wbs-server/routes/sysbuild/rules.js', '// r9 工作区里的改动\n'); // S = HEAD 时改动集 = 工作区改动：rules.js 改一下，N1 / A1（目标 rules.js）进自动范围
      const affN1 = cliG(['--affected', baseE, '--changed-since', cS, '--effective', effC3n, '--registry-file', regC3, '--s-registry-file', sC2]);
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      check(affN1.status === 0 && /\[api\] 3 条（去重后）：自动范围 2、mustRun 1、by 0、remount 0、added 0/.test(affN1.stdout) && /    auto：\["A1","N1"\]/.test(affN1.stdout) && /    mustRun：\["A2"\]/.test(affN1.stdout), 'S1 裁定 3：C2 新增的 N1（目标 rules.js，不在固定基线里）在 C3 改 rules.js、清单只写 mustRun A2 → N1 仍进自动范围（auto A1、N1），不靠人写 mustRun');
      // 84 MEDIUM（C9 累计范围）：--affected … --cumulative 取「自动累计范围 ∪ 各提交生效清单（mustRun / by / newId / added）」
      // 84 MEDIUM + 89 MEDIUM（C9 累计范围，整条 CLI）：--affected … --cumulative --rerun-dir <各提交第 ② 步的复验目录>——读各提交留档的 rerun.json，按提交逐份列出、逐编号输出命中来源
      const rrJ1 = JSON.parse(readTxt(path.join(rrE, 'rerun.json')));
      // cum1 / cum3 用 rrE 的派生目录 cum-rerun-e（startHead 改成当前 HEAD：最后一份 startHead 须是 HEAD 本身或其直接父提交）；rrE 本身是更早时刻跑的，startHead 不再满足这一条
      // 提交链（预筛 MED-1）：由 rrE 的 rerun.json 派生一条合法链（S = c1 → x1 → x2：每份 changedSince 是上一份 startHead 本身或其直接子提交）与几种断链
      const gCommits = gg(['rev-list', '--reverse', c1 + '..HEAD']).stdout.trim().split(/\r?\n/).filter(Boolean);
      // 97 号 HIGH：手工拼的留档目录补第 ③ 步通过凭据（gate-pass.json）——按 startHead / changedSince 映射到实际提交（提交前跑 = startHead 之后的下一个提交，提交后补跑 = startHead 本身），
      //   在该提交的树上按生产同口径（buildGatePass / gateTreeEntriesFromCommit）算树指纹；映射不出来的（造出来专测链断裂的假 startHead）不写，那些用例在链核对就拒、走不到凭据
      const gpFix = (d) => {
        const jb = fs.readFileSync(path.join(d, 'rerun.json'));
        const j = JSON.parse(jb.toString('utf8'));
        const S = j.changedSince;
        const sh = j.context.startHead;
        if (!/^[0-9a-f]{40}$/.test(S) || !/^[0-9a-f]{40}$/.test(sh)) return;
        let X = sh;
        if (sh === S) { const nx = gg(['rev-list', '--reverse', '--ancestry-path', sh + '..HEAD']); if (nx.status !== 0) return; X = nx.stdout.split(/\r?\n/).filter(Boolean)[0] || null; }
        if (X === null) return;
        const par = gg(['rev-parse', '--verify', '--quiet', X + '^']);
        if (par.status !== 0) return;
        const excl = normExcl(j.exclusions);
        const paths = gg(['diff', '--name-only', '--no-renames', '-z', par.stdout.trim(), X]).stdout.split('\0').filter(Boolean).map(normPath).filter((p) => !isExcludedBy(excl, p));
        fs.writeFileSync(path.join(d, GATE_PASS_FILE), JSON.stringify(buildGatePass({ since: S, head: sh, commit: j.commit, effective: j.effective, rerunSha256: sha256Of(jb), exclusions: j.exclusions, entries: gateTreeEntriesFromCommit(G, X, paths) }), null, 2));
      };
      const chainDir = (name, S, sh, commit) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); const j = JSON.parse(readTxt(path.join(rrE, 'rerun.json'))); j.changedSince = S; j.context.startHead = sh; j.commit = commit; fs.writeFileSync(path.join(d, 'rerun.json'), JSON.stringify(j)); gpFix(d); return d; };
      const chA = chainDir('cum-chA', c1, c1, 'C2'); // 第 ② 步在提交前跑：HEAD = <S> = c1
      const chB = chainDir('cum-chB', gCommits[0], gCommits[0], 'C3'); // 下一个提交 x1（父提交 = chA 的 startHead）
      const chSkip = chainDir('cum-chSkip', gCommits[1], gCommits[1], 'C4'); // x2：父提交是 x1，不是 chA 的 startHead → 漏了 x1 那份
      const chDup = chainDir('cum-chDup', c1, c1, 'C2b'); // 与 chA 同一个提交的留档传了两次
      const chFuture = chainDir('cum-chFuture', gCommits[0], '0'.repeat(39) + '1', 'C3x'); // 最后一份 startHead 不在 HEAD 祖先链上
      const chOld = chainDir('cum-chOld', '1'.repeat(40), '1'.repeat(40), 'C1x'); // 第 1 份 changedSince 不是 --changed-since
      // 97 预筛 M2：C9 对文件模式（非 none）的留档必须按顺序带 --effective；这里的 helper 按留档的实际模式替每份文件模式留档补一份 effOk（夹具留档都派生自 rrE，清单 sha256 就是 effOk 的）
      const effArgsFor = (dirs, effFile) => dirs.filter((d) => JSON.parse(readTxt(path.join(d, 'rerun.json'))).effective.mode === 'file').flatMap(() => ['--effective', effFile || effOk]);
      const cumChain = (dirs) => cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', ...dirs.flatMap((d) => ['--rerun-dir', d]), ...effArgsFor(dirs), '--registry-file', regCur]);
      // 整条合法链：第 1 份（S = c1 = startHead）+ 每个后续提交一份（S = startHead = 前一个提交），最后一份 startHead = HEAD 的直接父提交（C8 提交后、C9 改动未提交时的形态）
      const fullChain = [chA, ...gCommits.slice(0, -1).map((x, k) => chainDir('cum-chFull' + k, x, x, 'C' + (k + 3)))];
      const mChain = fullChain.length;
      const headG2 = gg(['rev-parse', 'HEAD']).stdout.trim();
      // 95 号 HIGH-1：每份留档只许覆盖一个提交——cum1 / cum3 用「HEAD 的第一父提交」作 --changed-since，单份留档在 HEAD 之前跑（startHead = changedSince = HEAD^，覆盖 HEAD 这一个提交）
      const parentG2 = gg(['rev-parse', 'HEAD^']).stdout.trim();
      const cumE = chainDir('cum-rerun-e', parentG2, parentG2, 'C2');
      const cumCli = (extra) => cliG(['--affected', baseE, '--changed-since', parentG2, '--cumulative', ...extra, ...(extra.includes('--effective') ? [] : effArgsFor(extra.filter((a, i) => extra[i - 1] === '--rerun-dir'))), '--registry-file', regCur]);
      const cum1 = cumCli(['--rerun-dir', cumE, '--effective', effOk]);
      const cum2 = cumChain(fullChain);
      const cum3 = cumCli(['--rerun-dir', cumE]);
      const cTail = cumChain(fullChain.slice(0, -1)); // 漏传最后一份
      const cTailGap = gCommits.length >= 2 ? gCommits.slice(-2) : [];
      const planIds = rrJ1.groups.api.runIds;
      const ranApi = rrJ1.ranIds.api;
      check(rrJ1.format === RERUN_FORMAT && rrJ1.commit === 'C2' && Array.isArray(rrJ1.retire) && rrJ1.retire.length === 3 && Array.isArray(rrJ1.added) && planIds.length > 0 && JSON.stringify(rrJ1.plannedIds.api) === JSON.stringify(planIds) && ranApi.length > 0 && rrJ1.complete === true && rrJ1.ignoredInputsEnd && cum1.status === 0 && new RegExp('提交 1/1 C2（复验目录 [^\\n]*rerun-e；生效清单 sha256 [0-9a-f]{64}[^\\n]*）：实跑编号 ' + ranApi.length + ' 个').test(cum1.stdout) && ranApi.every((id) => new RegExp('\\[api\\] "' + id + '" ← C2:').test(cum1.stdout)) && /命中 \[api\] "N1"（当前登记里）：C2:/.test(cum1.stdout) && /追溯小结：已无承接的分支 0 条、留档不全的分支 0 条、编号复用警告 0 条/.test(cum1.stdout) && cum3.status === 0 && /各提交留档的复验记录 1 份/.test(cum3.stdout), '89 MEDIUM + 95 HIGH-2（C9）：第 ② 步写 format sysbuild-rerun/3 的 rerun.json（commit / retire / added / 每组 auto·mustRun·by·remount·added·runIds / plannedIds / ranIds / outOfPlanIds / complete / ignoredInputsEnd）；--cumulative --rerun-dir 按提交逐份列出实跑编号并逐编号输出命中来源（C2:auto / C2:mustRun / …）；--effective 按顺序为每份文件模式留档必带（核 sha256）');
      check(cum2.status === 0 && mChain >= 2 && new RegExp('提交 1/' + mChain + ' C2').test(cum2.stdout) && new RegExp('提交 ' + mChain + '/' + mChain + ' C' + (mChain + 1)).test(cum2.stdout) && new RegExp('各提交留档的复验记录 ' + mChain + ' 份').test(cum2.stdout), '89 MEDIUM（C9）：整条衔接的复验目录（S = c1 → 逐个提交，最后一份 startHead = HEAD 的直接父提交）按提交顺序逐份列出（各自的复验编号与来源）');
      check(cTail.status === 1 && /最后一份（C\d+）的 startHead [0-9a-f]{40} 既不是 HEAD 本身、也不是 HEAD 的直接父提交：最后一份之后到 HEAD 之间有 \d+ 个提交没有对应的复验留档/.test(cTail.stderr) && cTailGap.length === 2 && cTail.stderr.includes(cTailGap[0].slice(0, 12)), '预筛 MED（C9 尾部漏份）：漏传最后一份 → 拒，并列出最后一份之后到 HEAD 之间没有留档的提交（含 HEAD 的父提交）；对照：整条链（最后一份 startHead = HEAD 的父提交，C8 提交后 C9 改动未提交的形态）与单份 startHead = HEAD 都过');
      const cSkip = cumChain([chA, chSkip]);
      const cDup = cumChain([chA, chDup]);
      const cFut = cumChain([chA, chFuture]);
      const cOld = cumChain([chOld]);
      check(gCommits.length >= 2 && cSkip.status === 1 && /留档不通过：第 2 份（C4[^\n]*）：changedSince [0-9a-f]{40} 与上一份（C2）的 startHead [0-9a-f]{40} 对不上[^\n]*漏了一份或几份留档/.test(cSkip.stderr), '预筛 MED-1（C9 提交链）：漏传中间一份（链上 c1 → x1 → x2，只传第 1 份与 x2 那份）→ 拒（断链）');
      check(cDup.status === 1 && /重叠：同一个提交的复验留档传了两次/.test(cDup.stderr), '预筛 MED-1（C9 提交链）：同一提交的留档传两次 → 拒（重叠）');
      check(cOld.status === 1 && /不等于 --changed-since[^\n]*第 1 份必须从 C1 提交接起/.test(cOld.stderr), '预筛 MED-1（C9 提交链）：第 1 份 changedSince 不是 --changed-since → 拒');
      check(cFut.status === 1 && /startHead [0-9a-f]{40} 不是 HEAD 的祖先/.test(cFut.stderr), '预筛 MED-1（C9 提交链）：最后一份 startHead 不是 HEAD 祖先 → 拒');
      const cumBad0 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--registry-file', regCur]);
      const cumBad1 = cliG(['--affected', baseE, '--changed-since', c1, '--effective', effOk, '--effective', effN3, '--registry-file', regCur]);
      const cumBad2 = cliG(['--cumulative', '--parse-only', rawAll]);
      const cumBad3 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--effective-none', 'x', '--registry-file', regCur]);
      const cumBad4 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--rerun-dir', rrE, '--effective', effN3, '--registry-file', regCur]); // rerun.json 记的清单 sha256 与 --effective 不是同一份
      const cumBad5 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--rerun-dir', rawAll, '--registry-file', regCur]); // 没有 rerun.json
      const oldFmt = path.join(gd, 'cum-oldfmt');
      fs.mkdirSync(oldFmt, { recursive: true });
      fs.writeFileSync(path.join(oldFmt, 'rerun.json'), JSON.stringify({ changedSince: c1, groups: {}, results: {} }));
      const cumBad6 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--rerun-dir', oldFmt, '--registry-file', regCur]);
      const cumBad7 = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', '--rerun-dir', rrE, '--effective', effOk, '--effective', effN3, '--registry-file', regCur]);
      check(cumBad0.status === 2 && /--cumulative 必须给至少一份 --rerun-dir/.test(cumBad0.stderr), '89 MEDIUM（C9）：0 份复验目录（清单 0 份）→ 拒绝（用法错误 2）');
      check(cumBad1.status === 2 && /--effective 只能给一份（多份 --effective 只用于 --affected … --cumulative/.test(cumBad1.stderr) && cumBad2.status === 2 && /--cumulative 只能与 --affected 一起用/.test(cumBad2.stderr) && cumBad3.status === 2 && /--cumulative 不能与 --effective-none 同用/.test(cumBad3.stderr), '89 MEDIUM（C9）用法错误：不带 --cumulative 给多份 --effective / --cumulative 没有 --affected / 与 --effective-none 同用 → 2');
      check(cumBad4.status === 1 && /留档不通过：[^\n]*eff-n3\.json 的 sha256 与 [^\n]*rerun\.json 记的生效清单[^\n]*对不上/.test(cumBad4.stderr), '89 MEDIUM（C9）：--effective 与 rerun.json 记的清单 sha256 对不上 → 拒绝（退出码 1）');
      check(cumBad5.status === 1 && /留档不通过：[^\n]*读不到 rerun\.json/.test(cumBad5.stderr) && cumBad6.status === 1 && /不是 sysbuild-rerun\/3 格式/.test(cumBad6.stderr), '89 MEDIUM（C9）：目录里没有 rerun.json / 旧格式 → 拒绝（退出码 1）');
      check(cumBad7.status === 1 && /--effective 多给了 1 份/.test(cumBad7.stderr), '95 MEDIUM（C9）：--effective 多给（只有文件模式的留档各消费一份）→ 拒绝（退出码 1）');
      // ── 95 号新增：C9 每份留档只许覆盖一个提交；--effective 与无清单模式的留档混合 ──
      const chSpan = chainDir('cum-chSpan', c1, headG2, 'C2'); // 首份 changedSince = c1、末份 startHead = HEAD：首尾都对得上，但这一份跨了 c1 → HEAD 的全部提交
      const cSpan = cumChain([chSpan]);
      const postChain = gCommits.map((x, k) => chainDir('cum-chPost' + k, k === 0 ? c1 : gCommits[k - 1], x, 'C' + (k + 2))); // 每个提交都是提交之后补跑：changedSince = 前一提交、startHead = 该提交本身
      const cPost = cumChain(postChain);
      const mixChain = [chA, ...gCommits.slice(0, -1).map((x, k) => chainDir('cum-chMix' + k, x, k % 2 === 0 ? gCommits[k + 1] : x, 'C' + (k + 3)))]; // 提交前跑与提交后补跑交替
      const cMix = cumChain(mixChain);
      check(gCommits.length >= 2 && cSpan.status === 1 && /这份留档自己就跨了不止一个提交/.test(cSpan.stderr) && cPost.status === 0 && new RegExp('各提交留档的复验记录 ' + gCommits.length + ' 份').test(cPost.stdout) && cMix.status === 0, '95 HIGH-1（C9）：一份留档自己跨了多个提交（--changed-since = c1、唯一一份 startHead = HEAD，首尾都对得上）→ 拒；每个提交都在提交之后补跑（startHead 是 changedSince 的直接子）的整条链 → 过；提交前跑与提交后补跑交替的链 → 过');
      const mixDirs = fullChain.map((d, k) => { const nd = d + '-mix'; fs.mkdirSync(nd, { recursive: true }); const j = JSON.parse(readTxt(path.join(d, 'rerun.json'))); if (k > 0) j.effective = { mode: 'none', reason: '只改文档' }; fs.writeFileSync(path.join(nd, 'rerun.json'), JSON.stringify(j)); gpFix(nd); return nd; });
      const cumMix = (effs) => cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', ...mixDirs.flatMap((d) => ['--rerun-dir', d]), ...effs.flatMap((e) => ['--effective', e]), '--registry-file', regCur]);
      const cmOk = cumMix([effOk]); // 第 1 份是文件模式（消费一份 --effective），其余是无清单模式（不占位）
      const cmExtra = cumMix([effOk, effOk]);
      const cmLack = cliG(['--affected', baseE, '--changed-since', c1, '--cumulative', ...fullChain.flatMap((d) => ['--rerun-dir', d]), '--effective', effOk, '--registry-file', regCur]); // 全是文件模式、只给一份清单
      check(fullChain.length >= 2 && cmOk.status === 0 && cmExtra.status === 1 && /--effective 多给了 1 份/.test(cmExtra.stderr) && cmLack.status === 1 && /这份留档是文件模式[^\n]*缺少这份留档的清单/.test(cmLack.stderr), '95 MEDIUM（C9）：--effective 与无清单模式的留档混合——按留档顺序只给文件模式的留档消费一份，无清单模式跳过 → 过；多给 → 拒；文件模式的留档缺清单 → 拒（旧版只要给了任一 --effective 就要求份数与留档数相等）');

      // ── 97 / 98 号新增：第 ③ 步通过凭据、空计划 rerun.json、结构共用校验、线性历史、补跑时已跟踪的输入（独立块作用域：名字不与上下文的同名助手混）──
      {
      // 97 号 HIGH：第 ③ 步通过凭据（gate-pass.json）绑定内容——同一父提交下跑两轮，C9 误传前一轮必须拒
      const GP = path.join(gd, 'gp-repo');
      fs.mkdirSync(GP, { recursive: true });
      const gq = (args) => spawnSync('git', ['-C', GP, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
      const wrP = (rel, t) => { const f = path.join(GP, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
      for (const rel of ['wbs-server/scripts/lib/h.js', 'wbs-server/scripts/lib/p.js', 'wbs-server/scripts/lib/mid.js', 'wbs-server/routes/sysbuild/other.js', 'wbs-server/scripts/verify-sysbuild-api.js']) wrP(rel, readTxt(path.join(G, ...rel.split('/'))));
      wrP('wbs-server/routes/sysbuild/rules.js', '// r1\n');
      gq(['init', '-q']);
      gq(['add', '-A']);
      gq(['commit', '-q', '-m', 'gp-c1']);
      const gpC1 = gq(['rev-parse', 'HEAD']).stdout.trim();
      const cliP = (args) => spawnSync(process.execPath, [__filename, '--repo', GP, '--groups', 'api', ...args], { encoding: 'utf8' });
      const stepsP = (name, since) => { // 同一个 <S> 下的第 ② 步 + 第 ③ 步（假 api 驱动；目录在仓库之外）
        const d = path.join(gd, name);
        const s2 = cliP(['--rerun', '--raw-dir', d, '--affected-from', baseG, '--changed-since', since, '--registry-file', regG, '--effective', effG]);
        const s3 = cliP(['--registry-file', regG, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', since, '--dispositions', goodD, '--effective', effG]);
        return { dir: d, s2, s3 };
      };
      wrP('wbs-server/routes/sysbuild/rules.js', '// r2 第一轮\n');
      gq(['add', '-A']);
      const gpR1 = stepsP('gp-r1', gpC1);
      wrP('wbs-server/routes/sysbuild/rules.js', '// r3 第二轮（同一个父提交，又改了一次再跑）\n');
      gq(['add', '-A']);
      const gpR2 = stepsP('gp-r2', gpC1);
      const gpOf = (d) => (fs.existsSync(path.join(d, GATE_PASS_FILE)) ? JSON.parse(readTxt(path.join(d, GATE_PASS_FILE))) : null);
      const gp1 = gpOf(gpR1.dir);
      const gp2 = gpOf(gpR2.dir);
      const cumP = (dirs, since, effFile) => cliP(['--affected', baseG, '--changed-since', since || gpC1, '--cumulative', ...dirs.flatMap((d) => ['--rerun-dir', d]), ...effArgsFor(dirs, effFile || effG), '--registry-file', regG]);
      check(gpR1.s2.status === 0 && gpR1.s3.status === 0 && gpR2.s2.status === 0 && gpR2.s3.status === 0 && gp1 && gp2 && gp1.format === GATE_PASS_FORMAT && gp1.changedSince === gpC1 && gp1.startHead === gpC1 && gp1.commit === 'CG' && gp1.effective.mode === 'file' && /^[0-9a-f]{64}$/.test(gp1.effective.sha256) && gp1.rerunJsonSha256 === sha256Of(fs.readFileSync(path.join(gpR1.dir, 'rerun.json'))) && gp1.treeFingerprint.entries.length === 1 && gp1.treeFingerprint.entries[0][0] === 'wbs-server/routes/sysbuild/rules.js' && gp1.treeFingerprint.entries[0][1] === '100644' && gp1.treeFingerprint.sha256 === gateEntriesDigest(gp1.treeFingerprint.entries) && gp1.treeFingerprint.sha256 !== gp2.treeFingerprint.sha256 && /第 ③ 步通过凭据已写入/.test(gpR2.s3.stdout), '97 HIGH：第 ③ 步全部通过时写 gate-pass.json——记 <S>、起始 HEAD、提交名、清单 sha256、rerun.json 的 sha256、待提交树指纹（改动路径的 [路径, 模式, blob 号] + sha256）；同一父提交下跑两轮（改了一个文件再跑）两轮都过、凭据的树指纹不同');
      const gpPre2 = cumP([gpR2.dir]);
      const gpPre1 = cumP([gpR1.dir]);
      check(gpPre2.status === 0 && /各提交留档的复验记录 1 份/.test(gpPre2.stdout) && gpPre1.status === 1 && /留档不通过：[^\n]*gp-r1[^\n]*凭据里的待提交树指纹与「当前暂存区（末份留档对应还没提交的工作区）」的实际内容对不上/.test(gpPre1.stderr), '97 HIGH（末份对应还没提交的工作区）：C9 传最后一轮的目录 → 过；误传同一父提交下较早一轮的目录 → 拒，说明哪份目录、与当前暂存区对不上');
      gq(['commit', '-q', '-m', 'gp-c2']);
      const gpX = gq(['rev-parse', 'HEAD']).stdout.trim();
      const gpPost2 = cumP([gpR2.dir]);
      const gpPost1 = cumP([gpR1.dir]);
      check(gpPost2.status === 0 && gpPost1.status === 1 && new RegExp('留档不通过：[^\\n]*gp-r1[^\\n]*凭据里的待提交树指纹与「提交 ' + gpX.slice(0, 12) + '」的实际内容对不上').test(gpPost1.stderr) && /不是最终入库的内容/.test(gpPost1.stderr), '97 HIGH（映射到实际提交）：同一父提交下两轮都过了第 ③ 步、只有第二轮入库（提交 X）→ C9 传第二轮目录 → 过；传第一轮目录（旧版只凭 startHead 映射也会通过链检查）→ 拒，点名目录与提交');
      const cpGp = (name, fn) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); const rjB = readTxt(path.join(gpR2.dir, 'rerun.json')); const gpj = JSON.parse(readTxt(path.join(gpR2.dir, GATE_PASS_FILE))); const out = fn({ rj: rjB, gp: gpj }) || { rj: rjB, gp: gpj }; if (out.rj !== null) fs.writeFileSync(path.join(d, 'rerun.json'), out.rj); if (out.gp !== null) fs.writeFileSync(path.join(d, GATE_PASS_FILE), JSON.stringify(out.gp, null, 2)); return d; };
      const gpNo = cumP([cpGp('gp-nogp', (x) => ({ rj: x.rj, gp: null }))]);
      const gpEdit = cumP([cpGp('gp-edit', (x) => ({ rj: x.rj + ' ', gp: x.gp }))]);
      const gpEff = cumP([cpGp('gp-eff', (x) => { x.gp.effective.sha256 = 'f'.repeat(64); return x; })]);
      const gpFp = cumP([cpGp('gp-fp', (x) => { x.gp.treeFingerprint.entries[0][2] = '0'.repeat(40); return x; })]);
      const gpPaths = cumP([cpGp('gp-paths', (x) => { const e = [['wbs-server/routes/sysbuild/other.js', '100644', '1'.repeat(40)], ...x.gp.treeFingerprint.entries].sort((a, b) => (a[0] < b[0] ? -1 : 1)); x.gp.treeFingerprint = { sha256: gateEntriesDigest(e), entries: e }; return x; })]);
      check(gpNo.status === 1 && /gp-nogp[^\n]*没有第 ③ 步通过凭据 gate-pass\.json/.test(gpNo.stderr) && gpEdit.status === 1 && /gp-edit[^\n]*rerun\.json 的 sha256[^\n]*与凭据记的[^\n]*不一致/.test(gpEdit.stderr) && gpEff.status === 1 && /gp-eff[^\n]*凭据记的生效清单口径/.test(gpEff.stderr), '97 HIGH：留档目录没有凭据 → 拒；rerun.json 在第 ③ 步之后被改（sha256 对不上）→ 拒；凭据记的清单 sha256 与 rerun.json 的不同 → 拒');
      check(gpFp.status === 1 && /gp-fp[^\n]*树指纹 sha256 与凭据自己记的 entries 对不上（凭据被改过）/.test(gpFp.stderr) && /gp-fp[^\n]*凭据里的待提交树指纹与「提交 [0-9a-f]{12}」的实际内容对不上/.test(gpFp.stderr) && gpPaths.status === 1 && /gp-paths[^\n]*改动集对不上：「提交 [0-9a-f]{12}」的改动路径[^\n]*比凭据多 0 个、少 1 个（wbs-server\/routes\/sysbuild\/other\.js）/.test(gpPaths.stderr), '97 HIGH：凭据里的 blob 号被改 → 拒（与 entries 自己的 sha256 对不上、与提交的树也对不上）；凭据（摘要自洽）多记了一个提交没有改动的路径 → 拒（改动集路径对不上）');
      // 97 号 MEDIUM（空计划路径）：只改文档的提交 → --effective-none 空计划；第 ③ 步在空计划路径也读并校验 rerun.json；末份还没提交的工作区与暂存区比
      wrP('docs/e.md', '# 只改文档\n');
      gq(['add', 'docs/e.md']);
      const NONE_GP = '只改文档的提交';
      const dirE = path.join(gd, 'gp-e');
      const gpE2 = cliP(['--rerun', '--raw-dir', dirE, '--affected-from', baseG, '--changed-since', gpX, '--registry-file', regG, '--effective-none', NONE_GP]);
      const gateE = (d, extra) => spawnSync(process.execPath, [__filename, '--repo', GP, '--registry-file', regG, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', gpX, '--dispositions', emptyD, '--effective-none', NONE_GP, ...(extra || [])], { encoding: 'utf8' });
      const gpE3 = gateE(dirE);
      const cpE = (name, fn) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); const ep = readTxt(path.join(dirE, 'empty-plan.json')); const rj = JSON.parse(readTxt(path.join(dirE, 'rerun.json'))); fs.writeFileSync(path.join(d, 'empty-plan.json'), ep); const r = fn(rj); if (r !== null) fs.writeFileSync(path.join(d, 'rerun.json'), JSON.stringify(rj, null, 2)); return d; };
      const eOnly = gateE(cpE('gp-e-only', () => null)); // 只留 empty-plan.json（第 ② 步写到一半中断 / 归档漏了 rerun.json）
      const eInc = gateE(cpE('gp-e-inc', (rj) => { rj.complete = false; }));
      const eFlag = gateE(cpE('gp-e-flag', (rj) => { rj.emptyPlan = false; }));
      const eHead = gateE(cpE('gp-e-head', (rj) => { rj.context.startHead = gpC1; }));
      const eCommit = gateE(cpE('gp-e-commit', (rj) => { rj.commit = 'none:别的提交'; }));
      const eFiles = gateE(cpE('gp-e-files', (rj) => { rj.context.changedFiles = { 'docs/other.md': 'f'.repeat(64) }; }));
      const ePlan = gateE(cpE('gp-e-plan', (rj) => { rj.groups = { api: { runIds: ['A1'] } }; rj.plannedIds = { api: ['A1'] }; rj.ranIds = { api: [] }; rj.outOfPlanIds = { api: [] }; rj.results = { api: { exitCode: 0 } }; }));
      const eAtomic = fs.readdirSync(dirE).sort();
      check(gpE2.status === 0 && gpE3.status === 0 && /空计划记录：用当前 HEAD \/ 改动集 \/ 生效清单重算，复验集合确实为空，绑定字段全部一致（放行）/.test(gpE3.stdout) && gpOf(dirE) && gpOf(dirE).effective.mode === 'none' && gpOf(dirE).treeFingerprint.entries.length === 1 && gpOf(dirE).treeFingerprint.entries[0][0] === 'docs/e.md' && eAtomic.join() === 'empty-plan.json,gate-pass.json,rerun.json', '97 MEDIUM 正例：空计划目录（empty-plan.json + rerun.json）→ 第 ③ 步放行并写凭据（none 口径、树指纹 = docs/e.md）；两份记录与凭据都是 rename 落盘，目录里没有残留的临时文件');
      check(eOnly.status === 1 && /rerun\.json：读不到或不是 JSON[^\n]*空计划目录也必须有第 ② 步写的 rerun\.json/.test(outOf(eOnly)), '97 MEDIUM：只留 empty-plan.json、删掉 rerun.json → 第 ③ 步拒（旧版因空计划路径不读 rerun.json 而放行，要到 C9 才被拒）');
      check(eInc.status === 1 && /rerun\.json：没有结束记录（complete 不是 true）/.test(outOf(eInc)) && eFlag.status === 1 && /rerun\.json：emptyPlan 不是 true/.test(outOf(eFlag)) && eHead.status === 1 && /rerun\.json：记的起始 HEAD/.test(outOf(eHead)) && eCommit.status === 1 && /rerun\.json：记的提交名/.test(outOf(eCommit)) && eFiles.status === 1 && /rerun\.json：改动文件集合与 empty-plan\.json 记的 changedFilesSha256 对不上/.test(outOf(eFiles)) && ePlan.status === 1 && /rerun\.json：空计划的 rerun\.json 里复验组不是空的（api）/.test(outOf(ePlan)), '97 MEDIUM：空计划路径的 rerun.json 没写完 / 标成非空计划 / 起始 HEAD 或提交名与本次不同 / 与 empty-plan.json 不是同一轮（改动文件集合对不上）/ 计划不为空 → 各拒');
      const cumE2 = cumP([gpR2.dir, dirE]); // 第 2 份对应还没提交的工作区（docs/e.md 已暂存）：与当前暂存区比
      wrP('docs/e.md', '# 只改文档，凭据之后又改了\n');
      gq(['add', 'docs/e.md']);
      const cumE3 = cumP([gpR2.dir, dirE]);
      gq(['rm', '-q', '--cached', 'docs/e.md']);
      fs.unlinkSync(path.join(GP, 'docs', 'e.md'));
      check(cumE2.status === 0 && /各提交留档的复验记录 2 份/.test(cumE2.stdout) && cumE3.status === 1 && /留档不通过：[^\n]*gp-e[^\n]*凭据里的待提交树指纹与「当前暂存区（末份留档对应还没提交的工作区）」的实际内容对不上/.test(cumE3.stderr), '97 HIGH（含空计划留档）：两份留档（第 1 份 = 已入库的提交 X，第 2 份 = 末尾还没提交的空计划）→ C9 过；第 ③ 步之后又改了暂存内容（docs/e.md）→ 拒');
      // 97 预筛 M2（同一父提交下清单改过的两轮）：两轮代码相同、第一轮清单 v1（mustRun A1），第二轮改成 v2（A1 + A2），清单是仓库外的输入、树指纹不覆盖它；两轮都过第 ③ 步，只有后一轮入库——C9 必须为文件模式留档带 --effective，漏带不能放行第一轮
      const effV = path.join(gd, 'eff-gp-v.json');
      const dispV = path.join(gd, 'disp-gp-v.json');
      fs.writeFileSync(dispV, JSON.stringify(['A1', 'A2'].map((id) => ({ 提交: 'CG', group: 'api', id, 业务步骤: '建项：只读账号被拒', 未变异通过证据: '子集基线 2/2 全绿', 变异后命中证据: EVID }))));
      const effVWrite = (ids) => fs.writeFileSync(effV, JSON.stringify({ format: effList.FORMAT, commit: 'CG', mustRun: ids.map((id) => ({ group: 'api', id })), retire: [] }));
      wrP('wbs-server/routes/sysbuild/rules.js', '// r4 清单版本\n');
      gq(['add', '-A']);
      const stepsV = (name) => {
        const d = path.join(gd, name);
        const s2 = cliP(['--rerun', '--raw-dir', d, '--affected-from', baseG, '--changed-since', gpX, '--registry-file', regG, '--effective', effV]);
        const s3 = cliP(['--registry-file', regG, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', gpX, '--dispositions', dispV, '--effective', effV]);
        return { dir: d, s2, s3 };
      };
      effVWrite(['A1']);
      const gpV1 = stepsV('gp-v1');
      effVWrite(['A1', 'A2']);
      const gpV2 = stepsV('gp-v2');
      gq(['commit', '-q', '-m', 'gp-c3']);
      const cumV = (dirs, withEff) => cliP(['--affected', baseG, '--changed-since', gpX, '--cumulative', ...dirs.flatMap((d) => ['--rerun-dir', d]), ...(withEff ? ['--effective', effV] : []), '--registry-file', regG]);
      const v1NoEff = cumV([gpV1.dir], false);
      const v1Eff = cumV([gpV1.dir], true);
      const v2Eff = cumV([gpV2.dir], true);
      const v2NoEff = cumV([gpV2.dir], false);
      check(gpV1.s2.status === 0 && gpV1.s3.status === 0 && gpV2.s2.status === 0 && gpV2.s3.status === 0 && v2Eff.status === 0 && /各提交留档的复验记录 1 份/.test(v2Eff.stdout), '97 预筛 M2（正例）：同一父提交下清单改过的两轮都过第 ③ 步、后一轮入库；C9 带最终清单（--effective）传后一轮目录 → 过');
      check(v1NoEff.status === 1 && /留档不通过：[^\n]*gp-v1[^\n]*这份留档是文件模式[^\n]*缺少这份留档的清单[^\n]*C9 必须为每份文件模式留档按顺序带 --effective；漏带时无法识别同一父提交下清单改过的前一轮/.test(v1NoEff.stderr) && v2NoEff.status === 1 && /gp-v2[^\n]*缺少这份留档的清单/.test(v2NoEff.stderr) && v1Eff.status === 1 && /留档不通过：[^\n]*的 sha256 与 [^\n]*gp-v1[^\n]*rerun\.json 记的生效清单[^\n]*对不上/.test(v1Eff.stderr), '97 预筛 M2：C9 误传第一轮且不带 --effective → 拒（提示必须为每份文件模式留档按顺序带 --effective；旧版可选，两轮树指纹相同、旧版放行）；任何文件模式留档不带 --effective 都拒；带最终清单传第一轮 → 清单 sha256 对不上被拒');
      // 97 预筛 L2（提交后补跑真实路径）：临时仓库 core.autocrlf=true，<S> = HEAD^、工作区干净；第 ② ③ 步真实写凭据（不用 gpFix），两个提交各补跑一次 → C9 链核对 → 每份映射到各自的提交，过
      const PC = path.join(gd, 'pc-repo');
      fs.mkdirSync(PC, { recursive: true });
      const gpc = (args) => spawnSync('git', ['-C', PC, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
      const wrC = (rel, t) => { const f = path.join(PC, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
      gpc(['init', '-q']);
      gpc(['config', 'core.autocrlf', 'true']);
      for (const rel of ['wbs-server/scripts/lib/h.js', 'wbs-server/scripts/lib/p.js', 'wbs-server/scripts/lib/mid.js', 'wbs-server/routes/sysbuild/other.js', 'wbs-server/scripts/verify-sysbuild-api.js']) wrC(rel, readTxt(path.join(G, ...rel.split('/'))));
      wrC('wbs-server/routes/sysbuild/rules.js', '// r1\r\n');
      gpc(['add', '-A']);
      gpc(['commit', '-q', '-m', 'pc-c1']);
      const pcC1 = gpc(['rev-parse', 'HEAD']).stdout.trim();
      const cliC = (args) => spawnSync(process.execPath, [__filename, '--force-clean-check', '--repo', PC, '--groups', 'api', ...args], { encoding: 'utf8' });
      const postSteps = (name, since) => { // 提交之后补跑：<S> = HEAD^，--force-clean-check 让工作区干净检查真生效
        const d = path.join(gd, name);
        const s2 = cliC(['--rerun', '--raw-dir', d, '--affected-from', baseG, '--changed-since', since, '--registry-file', regG, '--effective', effG]);
        const s3 = cliC(['--registry-file', regG, '--parse-only', d, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', since, '--dispositions', goodD, '--effective', effG]);
        return { dir: d, s2, s3 };
      };
      wrC('wbs-server/routes/sysbuild/rules.js', '// r2\r\n');
      gpc(['add', '-A']);
      gpc(['commit', '-q', '-m', 'pc-x1']);
      const pcX1 = gpc(['rev-parse', 'HEAD']).stdout.trim();
      const pcA = postSteps('pc-a', pcC1);
      wrC('wbs-server/routes/sysbuild/rules.js', '// r3\r\n');
      gpc(['add', '-A']);
      gpc(['commit', '-q', '-m', 'pc-x2']);
      const pcX2 = gpc(['rev-parse', 'HEAD']).stdout.trim();
      const pcB = postSteps('pc-b', pcX1);
      const pcCum = cliC(['--affected', baseG, '--changed-since', pcC1, '--cumulative', '--rerun-dir', pcA.dir, '--rerun-dir', pcB.dir, '--effective', effG, '--effective', effG, '--registry-file', regG]);
      const pcGpA = gpOf(pcA.dir);
      const pcGpB = gpOf(pcB.dir);
      const rulesOid = (c) => gpc(['rev-parse', c + ':wbs-server/routes/sysbuild/rules.js']).stdout.trim();
      check(gpc(['config', 'core.autocrlf']).stdout.trim() === 'true' && pcA.s2.status === 0 && pcA.s3.status === 0 && pcB.s2.status === 0 && pcB.s3.status === 0 && pcGpA && pcGpB && pcGpA.startHead === pcX1 && pcGpA.changedSince === pcC1 && pcGpB.startHead === pcX2 && pcGpB.changedSince === pcX1 && pcGpA.treeFingerprint.entries.length === 1 && pcGpA.treeFingerprint.entries[0][2] === rulesOid(pcX1) && pcGpB.treeFingerprint.entries[0][2] === rulesOid(pcX2) && pcGpA.treeFingerprint.entries[0][2] !== pcGpB.treeFingerprint.entries[0][2], '97 预筛 L2（凭据写入口径，提交后补跑）：core.autocrlf=true 的临时仓库，<S> = HEAD^、工作区干净（--force-clean-check）；两个提交各补跑一次，第 ③ 步真实写出凭据，起始 HEAD / <S> / 树指纹里的 blob 号与各自提交里的一致');
      check(pcCum.status === 0 && /各提交留档的复验记录 2 份/.test(pcCum.stdout), '97 预筛 L2：提交后补跑的两份真实凭据 → C9 链核对 → 各映射到自己的提交（X1、X2）→ 树指纹逐项一致 → 过（不经 gpFix 造的凭据）');
      const wfa = path.join(gd, 'atomic-write.json');
      fs.writeFileSync(wfa, '旧内容');
      writeFileAtomic(wfa, '新内容');
      let wfaErr = null;
      try { writeFileAtomic(path.join(gd, 'no-such-dir', 'x.json'), 'x'); } catch (e) { wfaErr = e; }
      check(readTxt(wfa) === '新内容' && fs.readdirSync(gd).every((f) => !/\.tmp-/.test(f)) && wfaErr !== null, '97 MEDIUM：writeFileAtomic 先写临时文件再 rename 覆盖已有文件；目标目录不存在时抛错、不留临时文件');
      // 97 号 MEDIUM（结构共用校验）：第 ③ 步（rerunJsonEndProblems）与 C9 对 plannedIds / ranIds / outOfPlanIds / results 的组键、组值类型用同一处校验；不合法统一报问题、不抛异常
      const stDir = path.join(gd, 'struct-end');
      fs.mkdirSync(stDir, { recursive: true });
      const stGood = JSON.parse(readTxt(path.join(gpR2.dir, 'rerun.json')));
      const stBadCases = {
        ranString: (j) => { j.ranIds.api = 'A1'; },
        ranNull: (j) => { j.ranIds.api = null; },
        ranNumber: (j) => { j.ranIds.api = 7; },
        ranDup: (j) => { j.ranIds.api = ['A1', 'A1']; },
        ranNonString: (j) => { j.ranIds.api = [1]; },
        ranEmptyId: (j) => { j.ranIds.api = ['']; },
        plannedString: (j) => { j.plannedIds.api = 'A1'; },
        outString: (j) => { j.outOfPlanIds.api = 'A1'; },
        ranMissingGroup: (j) => { delete j.ranIds.api; },
        ranExtraGroup: (j) => { j.ranIds.static = []; },
        resultsBad: (j) => { j.results.api = 'x'; },
        plannedMismatch: (j) => { j.plannedIds.api = ['ZZ']; },
      };
      const stRes = {};
      for (const [name, fn] of Object.entries(stBadCases)) {
        const j = JSON.parse(JSON.stringify(stGood));
        fn(j);
        fs.writeFileSync(path.join(stDir, 'rerun.json'), JSON.stringify(j));
        try { stRes[name] = { probs: rerunJsonEndProblems({ rawDir: stDir, groups: ['api'], data: { api: { meta: { ignoredInputs: j.ignoredInputsEnd } } }, since: j.changedSince, head: j.context.startHead, effCtx: null, ranNow: { api: stGood.ranIds.api } }), shared: rerunStructureProblems(j) }; } catch (e) { stRes[name] = { threw: e.message }; }
      }
      fs.writeFileSync(path.join(stDir, 'rerun.json'), JSON.stringify(stGood));
      const stOk = rerunJsonEndProblems({ rawDir: stDir, groups: ['api'], data: { api: { meta: { ignoredInputs: stGood.ignoredInputsEnd } } }, since: stGood.changedSince, head: stGood.context.startHead, effCtx: null, ranNow: { api: stGood.ranIds.api } });
      check(Object.values(stRes).every((r) => !r.threw && r.probs.some((p) => /结构不合法/.test(p)) && r.shared.length > 0) && stOk.length === 0 && rerunStructureProblems(stGood).length === 0, '97 MEDIUM（第 ③ 步侧）：ranIds / plannedIds / outOfPlanIds 的组值是字符串 / null / 数字 / 重复 / 非字符串元素 / 空串、组键缺失或多出、results 形态不对、plannedIds 与 groups 的计划不一致 → rerunJsonEndProblems 报「结构不合法」、不抛异常（旧版对字符串 / 数字组值 slice().sort() 直接 TypeError）；真实留档 → 无问题');
      const cumStruct = (name, fn) => { const d = path.join(gd, name); fs.mkdirSync(d, { recursive: true }); const j = JSON.parse(readTxt(path.join(cumE, 'rerun.json'))); fn(j); fs.writeFileSync(path.join(d, 'rerun.json'), JSON.stringify(j)); gpFix(d); return d; };
      const cuStr = cumCli(['--rerun-dir', cumStruct('cum-st-str', (j) => { j.ranIds.api = 'A1'; })]);
      const cuNull = cumCli(['--rerun-dir', cumStruct('cum-st-null', (j) => { j.ranIds.api = null; })]);
      const cuDup = cumCli(['--rerun-dir', cumStruct('cum-st-dup', (j) => { j.ranIds.api = ['A1', 'A1']; })]);
      const cuOk = cumCli(['--rerun-dir', cumStruct('cum-st-ok', () => {})]);
      check([cuStr, cuNull, cuDup].every((r) => r.status === 1 && /留档不通过：[^\n]*rerun\.json 结构不合法（[^\n]*ranIds\[api\]/.test(r.stderr) && !/TypeError|at .*\.js:\d+/.test(r.stderr)) && cuOk.status === 0, '97 MEDIUM（C9 侧）：同样的组值字符串 / null / 重复编号 → C9 报该留档「结构不合法」并退出码 1（旧版把非数组组值当空集合，累计范围照常输出），不抛异常；对照：未改的留档 → 过');
      const cuInc = cumCli(['--rerun-dir', cumStruct('cum-st-inc', (j) => { j.ranIds.api = []; j.outOfPlanIds.api = []; })]); // 计划编号缺结果行（ranIds 为空而计划非空）
      check(cuInc.status === 1 && /留档不通过：[^\n]*cum-st-inc[^\n]*留档不完整——计划里有、日志里没有结果行的编号 \d+ 个/.test(cuInc.stderr) && !/C9 累计范围（/.test(cuInc.stdout), '97 MEDIUM：C9 遇计划编号缺结果行 → 报该留档不完整并以退出码 1 结束，不再只打警告、也不输出可被当作完整的累计范围');
      // 98 号 HIGH（线性历史）：进行中的合并 / 合并提交 → 第 ② 步、第 ③ 步、--affected 带清单都是用法错误（三步共用 validateSinceCommit）
      const MG = path.join(gd, 'mg-repo');
      fs.mkdirSync(MG, { recursive: true });
      const gmg = (args) => spawnSync('git', ['-C', MG, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
      fs.writeFileSync(path.join(MG, 'a.txt'), '1\n');
      gmg(['init', '-q']);
      gmg(['add', '-A']);
      gmg(['commit', '-q', '-m', 'm1']);
      gmg(['checkout', '-q', '-b', 'side']);
      fs.writeFileSync(path.join(MG, 's.txt'), 's\n');
      gmg(['add', '-A']);
      gmg(['commit', '-q', '-m', 's']);
      gmg(['checkout', '-q', '-']);
      fs.writeFileSync(path.join(MG, 'm.txt'), 'm\n');
      gmg(['add', '-A']);
      gmg(['commit', '-q', '-m', 'm2']);
      const mgFirst = gmg(['rev-parse', 'HEAD']).stdout.trim();
      const mgSteps = (tag, since) => ({
        s2: spawnSync(process.execPath, [__filename, '--repo', MG, '--rerun', '--raw-dir', path.join(gd, 'x-mg-' + tag), '--affected-from', baseG, '--changed-since', since, '--effective-none', 'x', '--dispositions', emptyD], { encoding: 'utf8' }),
        s3: spawnSync(process.execPath, [__filename, '--repo', MG, '--parse-only', path.join(gd, 'x-mg3-' + tag), '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', since, '--dispositions', emptyD, '--effective-none', 'x'], { encoding: 'utf8' }),
        s1a: spawnSync(process.execPath, [__filename, '--repo', MG, '--affected', baseG, '--changed-since', since, '--effective-none', 'x'], { encoding: 'utf8' }),
      });
      gmg(['merge', '-q', '--no-ff', '--no-commit', 'side']); // 合并进行中：MERGE_HEAD 存在
      const mgProg = mgSteps('prog', mgFirst);
      gmg(['commit', '-q', '-m', 'M']);
      const mgMerge = gmg(['rev-parse', 'HEAD']).stdout.trim();
      const mgPost = mgSteps('post', mgFirst); // 补跑模式：<S> = HEAD 的第一父提交，HEAD 是合并提交
      const mgHead = mgSteps('head', mgMerge); // <S> = HEAD，HEAD 本身是合并提交
      check(Object.values(mgProg).every((r) => r.status === 2 && /仓库里有进行中的合并（MERGE_HEAD 存在）[^\n]*线性历史/.test(r.stderr)), '98 HIGH：进行中的合并（MERGE_HEAD 存在）→ 第 ② 步（--rerun）/ 第 ③ 步（--parse-only 闸门）/ --affected 带清单都是用法错误（2），提示线性历史、rebase 只在 C9 之后（三步共用 validateSinceCommit）');
      check(Object.values(mgPost).every((r) => r.status === 2 && /是合并提交（2 个父提交）[^\n]*线性历史/.test(r.stderr)) && Object.values(mgHead).every((r) => r.status === 2 && /是合并提交（2 个父提交）/.test(r.stderr)) && !fs.existsSync(path.join(gd, 'x-mg-post')) && !fs.existsSync(path.join(gd, 'x-mg-head')), '98 HIGH：HEAD 是合并提交——补跑模式（<S> = HEAD 的第一父提交，旧版放行）与 <S> = HEAD 都拒（三步各一例）；第 ② 步被拒时不建复验目录');
      // 98 号 HIGH（<S> 是合并提交）：M 之后又提交了单父提交 X，补跑 <S> = M（= HEAD^）：MERGE_HEAD 与「HEAD 是合并提交」都不成立，<S> 自己的父提交数要拦（三步各一例）
      fs.writeFileSync(path.join(MG, 'x.txt'), 'x\n');
      gmg(['add', '-A']);
      gmg(['commit', '-q', '-m', 'X']);
      const mgSm = mgSteps('sm', mgMerge);
      check(Object.values(mgSm).every((r) => r.status === 2 && /<S>（[0-9a-f]{12}）本身是合并提交（2 个父提交）[^\n]*线性历史/.test(r.stderr)) && !fs.existsSync(path.join(gd, 'x-mg-sm')), '98 HIGH：<S> 本身是合并提交（M 之后又有单父提交 X，补跑 <S> = M）→ 第 ② 步 / 第 ③ 步 / --affected 带清单各一例用法错误（2）；第 ② 步被拒时不建复验目录');
      // 98 号 MEDIUM：补跑时已被 HEAD 跟踪的基线必须与 HEAD 一致才豁免（暂存区被修改 → 第 ② 步 / 第 ③ 步 / --affected 带清单都拒；改回 → 不再因此拒）
      const TR = path.join(gd, 'tr-repo');
      fs.mkdirSync(TR, { recursive: true });
      const gtr = (args) => spawnSync('git', ['-C', TR, '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8' });
      const baseTxtTR = readTxt(baseG);
      fs.mkdirSync(path.join(TR, 'fix'), { recursive: true });
      fs.writeFileSync(path.join(TR, 'fix', 'base.json'), baseTxtTR);
      fs.writeFileSync(path.join(TR, 'a.txt'), '1\n');
      gtr(['init', '-q']);
      gtr(['add', '-A']);
      gtr(['commit', '-q', '-m', 't1']);
      const trC1 = gtr(['rev-parse', 'HEAD']).stdout.trim();
      fs.writeFileSync(path.join(TR, 'a.txt'), '2\n');
      gtr(['add', '-A']);
      gtr(['commit', '-q', '-m', 't2']);
      const trBase = path.join(TR, 'fix', 'base.json');
      const trSteps = () => ({
        s2: spawnSync(process.execPath, [__filename, '--force-clean-check', '--repo', TR, '--rerun', '--raw-dir', path.join(gd, 'x-tr2'), '--affected-from', trBase, '--changed-since', trC1, '--effective-none', 'x', '--dispositions', emptyD], { encoding: 'utf8' }),
        s3: spawnSync(process.execPath, [__filename, '--force-clean-check', '--repo', TR, '--parse-only', path.join(gd, 'x-tr3'), '--compare', trBase, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', trC1, '--dispositions', emptyD, '--effective-none', 'x'], { encoding: 'utf8' }),
        s1a: spawnSync(process.execPath, [__filename, '--force-clean-check', '--repo', TR, '--affected', trBase, '--changed-since', trC1, '--effective-none', 'x'], { encoding: 'utf8' }),
      });
      const trClean0 = trSteps();
      fs.writeFileSync(trBase, baseTxtTR + '\n');
      gtr(['add', 'fix/base.json']);
      const trDirty = trSteps();
      gtr(['restore', '--staged', 'fix/base.json']);
      gtr(['checkout', '--', 'fix/base.json']);
      const trBack = trSteps();
      const trMsg = /提交后补跑（<S> = HEAD 的第一父提交）要求工作区干净[^\n]*fix\/base\.json[^\n]*被 HEAD 跟踪的基线 \/ 生效清单/;
      check(Object.values(trDirty).every((r) => r.status === 2 && trMsg.test(r.stderr)) && Object.values(trClean0).every((r) => !/要求工作区干净/.test(r.stderr)) && Object.values(trBack).every((r) => !/要求工作区干净/.test(r.stderr)), '98 MEDIUM：补跑（<S> = HEAD^）时已被 HEAD 跟踪的基线（fix/base.json）暂存区被修改 → 第 ② 步 / 第 ③ 步 / --affected 带清单都是用法错误（2，点名该文件）；干净 / 改回与 HEAD 一致 → 不因此拒（旧版把输入文件整体豁免，补跑会读到暂存的修改）');
      }

      // ── 89 / 94 号新增（续）：自检钩子门、<S> 共用校验、读取器漂移（②③）、被忽略的运行输入（子集复验）、真实仓库状态 ──────────────────────────
      const realRun = (args) => realSpawnSync(process.execPath, [__filename, ...args], { encoding: 'utf8', timeout: 120000 });
      const hookFlags = [['--registry-file', regG], ['--s-registry-file', regG], ['--allow-no-provenance'], ['--no-provenance']];
      const hkRes = hookFlags.map((fl) => realRun(['--repo', G, '--affected', baseG, '--changed-since', c1, ...fl]));
      const hkSelf1 = realRun(['--self-test', '--repo', G]);
      const hkSelf2 = realRun(['--self-test', '--effective-none', 'x', '--require-review-dispositions']);
      check(hkRes.every((r, i) => r.status === 2 && r.stderr.includes(hookFlags[i][0] + ' 是自检钩子，不是命令行参数')), '89 HIGH-3：--registry-file / --s-registry-file / --allow-no-provenance / --no-provenance 命令行给了 → 用法错误（2；自检钩子只经 main(argv, hooks) 注入，上面所有 CLI 自检就是这样跑的）');
      check(hkSelf1.status === 2 && /--self-test 不能与其他参数同给/.test(hkSelf1.stderr) && hkSelf2.status === 2 && /--self-test 不能与其他参数同给/.test(hkSelf2.stderr), '89 HIGH-3：--self-test 与任何别的参数同给 → 用法错误（2）');
      // 94 HIGH-2：<S> 是树对象 → 第 ② 步 / 第 ③ 步 / --affected 都拒（用法错误 2），什么都不跑
      const treeG = gg(['rev-parse', 'HEAD^{tree}']).stdout.trim();
      const tS = [cliG(['--affected', baseG, '--changed-since', treeG]), cliG(['--rerun', '--raw-dir', path.join(gd, 'x-tree'), '--affected-from', baseG, '--changed-since', treeG, '--registry-file', regG, '--effective', effG]), cliG(['--registry-file', regG, '--parse-only', rerunDir, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', treeG, '--dispositions', goodD, '--effective', effG]), cliG(['--affected', baseG, '--changed-since', treeG, '--registry-file', regG, '--effective-none', NONE_REASON])];
      check(tS.every((r) => r.status === 2 && /是 tree，不是提交/.test(r.stderr)) && !fs.existsSync(path.join(gd, 'x-tree', 'api.log')), '94 HIGH-2：<S> 是树对象 → 第 ② 步（--rerun）/ 第 ③ 步（闸门）/ --affected（含带清单）一律用法错误（2），不跑驱动（三步共用 validateSinceCommit）');
      // 94 HIGH-3（第 ②③ 步）：改动集含登记读取链路文件（依赖清单 wbs-server/package.json）→ ② 拒绝；--s-registry-attest 声明后放行并记进 meta；③ 要求声明与 ② 一致。自检钩子默认不走读取器、所以不触发这道门；用自检专用记号 --force-drift-guard（经 selfSpawn 摘成 hooks.driftGuard）让它也走
      wrG('wbs-server/package.json', '{ "name": "g" }\n');
      gg(['add', 'wbs-server/package.json']);
      const rrDrift = path.join(G, 'tmp', 'rr-drift');
      const ATT = '已用旧版读取器核对 c1 时登记，与本工具读出的逐条一致';
      const drArgs = ['--force-drift-guard', '--rerun', '--raw-dir', rrDrift, '--affected-from', baseG, '--changed-since', cS, '--registry-file', regG, '--effective', effG];
      const dr0 = cliG(drArgs);
      const dr0Aff = cliG(['--force-drift-guard', '--affected', baseG, '--changed-since', cS, '--registry-file', regG, '--effective', effG]);
      const dr1 = cliG([...drArgs, '--s-registry-attest', ATT]);
      const drMeta = fs.existsSync(path.join(rrDrift, 'api.meta.json')) ? JSON.parse(readTxt(path.join(rrDrift, 'api.meta.json'))) : null;
      const gateD = (extra) => cliG(['--force-drift-guard', '--registry-file', regG, '--parse-only', rrDrift, '--compare', baseG, '--allow-no-provenance', '--require-review-dispositions', '--changed-since', cS, '--dispositions', goodD, '--effective', effG, ...(extra || [])]);
      const dg0 = gateD();
      const dg1 = gateD(['--s-registry-attest', ATT + '（改过）']);
      const dg2 = gateD(['--s-registry-attest', ATT]);
      const dg3 = gate(rrDrift, goodD); // 不带 --force-drift-guard（钩子给了登记、不经读取器）→ 不触发漂移硬门
      gg(['rm', '-q', '--cached', 'wbs-server/package.json']);
      fs.unlinkSync(path.join(G, 'wbs-server', 'package.json'));
      removeTree(path.join(G, 'tmp'));
      check(dr0.status === 1 && /拒绝复验：登记读取逻辑在本次改动内（1 个路径：wbs-server\/package\.json）[^\n]*须人工核对 <S> 时登记/.test(dr0.stderr) && !fs.existsSync(path.join(G, 'tmp', 'rr-drift', 'api.log')), '94 HIGH-3：改动集含登记读取链路文件（wbs-server/package.json）→ 第 ② 步 --rerun 拒绝（不跑驱动），提示须人工核对 <S> 时登记');
      check(dr0Aff.status === 1 && /拒绝：登记读取逻辑在本次改动内/.test(dr0Aff.stderr), '94 HIGH-3：--affected 带清单同样拒绝');
      check(dg0.status === 1 && /闸门不通过：读取器漂移：登记读取逻辑在本次改动内/.test(dg0.stdout), '94 HIGH-3：第 ③ 步改动集含登记读取链路文件 → 拒（读取器漂移）');
      check(dg0.status === 1 && /改动集含登记读取链路文件，第 ③ 步没有给 --s-registry-attest/.test(dg0.stdout), '94 HIGH-3：第 ③ 步没有给 --s-registry-attest → 拒');
      check(dg1.status === 1 && /第 ③ 步的 --s-registry-attest "[^"]*（改过）" 与第 ② 步记录的 "[^"]*" 不一致（人工声明三步必须同一份）/.test(dg1.stdout), '94 HIGH-3：第 ③ 步的声明与第 ② 步记录不一致 → 拒');
      check(dr1.status === 0 && /登记读取器漂移（人工声明）：[^\n]*--s-registry-attest "已用旧版读取器核对/.test(dr1.stdout) && drMeta && drMeta.sRegistryAttest === ATT && dg2.status === 0 && /登记读取器漂移（人工声明）/.test(dg2.stdout) && dg3.status === 0,'94 HIGH-3：--s-registry-attest 声明后第 ② 步放行、理由记进 meta.sRegistryAttest；第 ③ 步不给声明 → 拒、声明与第 ② 步不一致 → 拒、一致 → 过（输出人工声明）；钩子给登记时（常规自检路径）不触发漂移门');
      check(/下一步：--parse-only [^\n]*--dispositions <DISP> --require-review-dispositions[^\n]*--s-registry-attest "已用旧版读取器核对[^\n]*"（<DISP> = 第 ② 步传的累计去向表/.test(dr1.stdout) && /下一步：--parse-only [^\n]*--dispositions <DISP> --require-review-dispositions/.test(rr.stdout) && !/下一步：[^\n]*--s-registry-attest/.test(rr.stdout), '预筛 LOW-3：第 ② 步结束打印的「下一步」命令用 <DISP>；读取器漂移（带了 --s-registry-attest）时把同一份理由一并带出，没有漂移时不带');
      // 89 MEDIUM：子集复验也绑定被忽略的运行输入——.sdh-instance 内容摘要、线库 sha256、.env 白名单键存在性（只比键名与存在与否，不比值）；复验之后变了 → 第 ③ 步拒
      fs.appendFileSync(path.join(G, '.git', 'info', 'exclude'), 'wbs-server/.env\nwbs-server/.sdh-instance\nwbs-server/task_pool.db\n');
      wrG('wbs-server/.sdh-instance', 'line-a\n');
      wrG('wbs-server/.env', 'SYS_FASTLANE_ENABLE=1\n');
      wrG('wbs-server/task_pool.db', 'db-1');
      wrG('wbs-server/routes/sysbuild/rules.js', '// r9 工作区里的改动（S = HEAD 时改动集不能为空）\n');
      gg(['add', 'wbs-server/routes/sysbuild/rules.js']);
      const rrIgn = path.join(G, 'tmp', 'rr-ign');
      const ig0 = cliG(['--rerun', '--raw-dir', rrIgn, '--affected-from', baseG, '--changed-since', cS, '--registry-file', regG, '--effective', effG]);
      const igMeta = fs.existsSync(path.join(rrIgn, 'api.meta.json')) ? JSON.parse(readTxt(path.join(rrIgn, 'api.meta.json'))) : null;
      const igOk = gate(rrIgn, goodD);
      wrG('wbs-server/.sdh-instance', 'line-b\n');
      const ig1 = gate(rrIgn, goodD);
      wrG('wbs-server/.sdh-instance', 'line-a\n');
      wrG('wbs-server/task_pool.db', 'db-2');
      const ig2 = gate(rrIgn, goodD);
      wrG('wbs-server/task_pool.db', 'db-1');
      wrG('wbs-server/.env', 'SYS_FASTLANE_ENABLE=1\nNODE_ENV=x\n');
      const ig3 = gate(rrIgn, goodD);
      wrG('wbs-server/.env', 'SYS_FASTLANE_ENABLE=0\n'); // 值变了、键集合没变 → 不比值
      const ig4 = gate(rrIgn, goodD);
      wrG('wbs-server/.env', 'SYS_FASTLANE_ENABLE=1\n');
      const rjIgn = JSON.parse(readTxt(path.join(rrIgn, 'rerun.json')));
      const rjIgnOrig = readTxt(path.join(rrIgn, 'rerun.json'));
      rjIgn.ignoredInputsEnd.taskPoolDb.sha256 = 'f'.repeat(64);
      fs.writeFileSync(path.join(rrIgn, 'rerun.json'), JSON.stringify(rjIgn));
      const ig5 = gate(rrIgn, goodD);
      fs.writeFileSync(path.join(rrIgn, 'rerun.json'), rjIgnOrig);
      const mOld = JSON.parse(readTxt(path.join(rrIgn, 'api.meta.json')));
      delete mOld.ignoredInputs;
      fs.writeFileSync(path.join(rrIgn, 'api.meta.json'), JSON.stringify(mOld));
      const ig6 = gate(rrIgn, goodD);
      for (const f of ['.sdh-instance', '.env', 'task_pool.db']) fs.unlinkSync(path.join(G, 'wbs-server', f));
      removeTree(path.join(G, 'tmp'));
      wrG('wbs-server/routes/sysbuild/rules.js', '// r2\n');
      gg(['add', 'wbs-server/routes/sysbuild/rules.js']);
      check(ig0.status === 0 && igMeta && igMeta.ignoredInputs.sdhInstance.sha256 === sha256Of(Buffer.from('line-a\n')) && igMeta.ignoredInputs.taskPoolDb.sha256 === sha256Of(Buffer.from('db-1')) && igMeta.ignoredInputs.envKeys.keys.find((k) => k.key === 'SYS_FASTLANE_ENABLE').present === true && !JSON.stringify(igMeta).includes('SYS_FASTLANE_ENABLE=') && igOk.status === 0, '89 MEDIUM：第 ② 步（子集复验）的每组 meta 记 ignoredInputs（.sdh-instance sha256、线库 sha256 与字节数、.env 白名单键存在性，不含 .env 的值）；没变 → 第 ③ 步过');
      check(ig1.status === 1 && /\.sdh-instance 的内容摘要与第 ② 步记录不一致/.test(ig1.stdout) && ig2.status === 1 && /线库 task_pool\.db 的 sha256 \/ 字节数与第 ② 步记录不一致/.test(ig2.stdout) && ig3.status === 1 && /\.env 白名单键的存在性与第 ② 步记录不一致/.test(ig3.stdout) && ig4.status === 0 && ig5.status === 1 && /rerun\.json：记的复验结束时被忽略的运行输入摘要（ignoredInputsEnd）与复验开始时（meta）不一致/.test(ig5.stdout) && ig6.status === 1 && /没有记被忽略的运行输入摘要（ignoredInputs；旧格式记录）/.test(ig6.stdout), '89 MEDIUM：复验之后 .sdh-instance 内容 / 线库内容 / .env 白名单键集合变了 → 第 ③ 步各拒一条；只改 .env 的值不拒（不比值）；rerun.json 的复验后摘要与复验前不同（复验期间变过）→ 拒；旧格式 meta（没有 ignoredInputs）→ 拒');
      // 真实仓库状态（89 号 HIGH-2 / MEDIUM + 94 号 MEDIUM；本检出是 git 按 core.autocrlf 检出的真实工作区，不是合成样本）：
      //   ① 真实仓库里 git status 认为干净的已跟踪文件（均匀抽样 ≤ 400 个，含中文路径）：工作区内容经 git 过滤后的 blob 号必须 = 暂存区 blob 号（暂存区与工作区一致判据对真实换行转换成立），sha256 取得到
      const realTracked = realSpawnSync('git', ['-C', DEFAULT_REPO, '-c', 'core.quotePath=false', 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.split('\0').filter(Boolean).map(normPath);
      const dirtyNow = new Set(effList.statusEntriesZ(DEFAULT_REPO).flatMap((e) => [e.path, e.orig].filter(Boolean)).map(normPath));
      const cleanTracked = realTracked.filter((p) => !dirtyNow.has(p));
      const stepN = Math.max(1, Math.floor(cleanTracked.length / 400));
      const sampleReal = cleanTracked.filter((_, i) => i % stepN === 0).slice(0, 400);
      const realSnap = changeSnapshot(DEFAULT_REPO, sampleReal);
      const badReal = sampleReal.filter((p) => { const v = realSnap.get(p); return !(v && v.sha256 && v.blob && v.index === v.blob); });
      //   ② 真实仓库上取改动集（-z 状态记录，不解析文本行）：不抛、是 Set、每个路径都是仓库相对路径
      const headMinus1 = realSpawnSync('git', ['-C', DEFAULT_REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();
      let realChanged = null;
      try { realChanged = effList.changedPathsSince(DEFAULT_REPO, headMinus1); } catch (e) { realChanged = e; }
      //   ③ registryAtCommit 在真实仓库的真实提交上读（落盘硬化对整棵真实文件树成立：无损映射、无大小写冲突、无残留），读出的十组编号 = 已提交基线的编号
      const fixCommit = realSpawnSync('git', ['-C', DEFAULT_REPO, 'log', '-1', '--format=%H', '--', 'wbs-server/scripts/fixtures/sysbuild-step1/mutation-baseline.json'], { encoding: 'utf8' }).stdout.trim();
      let regReal = null;
      try { regReal = effList.registryAtCommit(DEFAULT_REPO, fixCommit); } catch (e) { regReal = e; }
      const baseKeysReal = new Set(JSON.parse(fs.readFileSync(path.join(DEFAULT_REPO, 'wbs-server', 'scripts', 'fixtures', 'sysbuild-step1', 'mutation-baseline.json'), 'utf8')).entries.map(keyOf));
      check(sampleReal.length >= 100 && badReal.length === 0 && realChanged instanceof Set && Array.from(realChanged).every((p) => typeof p === 'string' && !p.startsWith('/') && !p.includes('\\')) && regReal && !(regReal instanceof Error) && regReal.residue.length === 0 && regReal.fileCount > 500 && regReal.keys.size === baseKeysReal.size && Array.from(regReal.keys).every((k) => baseKeysReal.has(k)), `真实仓库状态：git 认为干净的已跟踪文件抽样 ${sampleReal.length} 个，工作区 blob 号 = 暂存区 blob 号（不一致 ${badReal.length} 个${badReal.length ? '：' + badReal.slice(0, 3).join('、') : ''}）；HEAD~1..HEAD + 工作区的改动集（-z）可取（${realChanged instanceof Set ? realChanged.size + ' 个路径' : String(realChanged && realChanged.message)}）；registryAtCommit 在提交 ${fixCommit.slice(0, 8)} 的真实文件树上读出 ${regReal && regReal.keys ? regReal.keys.size : '失败：' + String(regReal && regReal.message)} 条，与已提交基线的 ${baseKeysReal.size} 条逐条一致（落地 ${regReal && regReal.fileCount} 个文件，无残留）`);
    }
  } finally {
    try { removeTree(dir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + dir + ' — ' + e.message); }
  }
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e && e.stack); process.exitCode = 1; });
module.exports = { main, testSideConsistency, requireChain, affectedOf, reviewGate, changedFilesSince, evidenceMatches, isLoadOrFixtureFailure, GATE_FIELDS, parseRaw, reconcile, assemble, compareBaselines, reviewReasons, normalizeMessage, NORMALIZERS, ALL_GROUPS, commandOf, FINISH_RE, failureKey, caseSiteSplitKeys, callSiteStats, productTreeState, listTestFiles, hashFiles, snapshotInputs, snapshotProblems, ignoredInputsState, strayDirtyPaths, headMovePaths, whitelistLoadedInProcess, NOT_LOADED_WHITELIST, buildProvenance, provenanceLink };
