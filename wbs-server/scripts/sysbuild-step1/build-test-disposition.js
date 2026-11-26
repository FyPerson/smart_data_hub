'use strict';
// #212 第一步（C1c）生成器：测试去向表初稿骨架（方案 v1.4 5.2）。
//   输入：取证原件（del-inv-tests-1/2/3.md 的用例表与变异表）、仓库代码（真实用例名单、全量变异清单与每条变异的全部编辑）、删除清单 v1.0；输出：markdown（--out）。
//   只读：不改任何输入文件与仓库文件；唯一的写操作是 --out。机械初判只是初稿，「受影响的保留断言」「去向」「等价依据」「首次可运行的提交」四列留空待主会话填。
//
// 用法：
//   node wbs-server/scripts/sysbuild-step1/build-test-disposition.js --out <md> [--inv-dir <取证目录>] [--deletion-list <删除清单 md>] [--repo <仓库根>] [--ids-file <json>] [--names-file <json>] [--registry-file <json>] [--no-check]
//        --ids-file   用文件里的变异清单（[{ group, id, files, expect, edits? }]）代替现场读取；--names-file 用 { api: [...], browser: [...], schema: [...] } 代替现场读取真实用例名单；
//        --registry-file 用文件里的期望清单（{ files, deletionList, tables }）代替内置 REGISTRY（都是测试用）
//   node wbs-server/scripts/sysbuild-step1/build-test-disposition.js --self-test
//   退出码：反向校验不过 = 1；用法错误 = 2。
//
// 期望清单（HIGH-1）：内置 REGISTRY 登记「应有的 3 份测试取证原件 + 删除清单」与「每张表的身份」（文件 + 所在标题 + 规范化表头 → 角色 case / mut / oth + 理由）。
//   核对：缺文件、多出未登记的 del-inv-tests-*.md、缺表、多出未登记的表、角色与按表头判出的不符，都算问题（退出码 1）。被排除的「其他表」（oth）逐张登记理由，
//   表头含「变异」「用例」「场景」「标题」「断言」之一的 oth 表没有理由也算问题（核的是 文件 + 标题 + 表头，不是文件名 + 行号）。
// 一、用例部分
//   取表：表头里有「用例名列」（用例 / 场景 / 断言 / 标题（含「用例编号 / 标题」「标题（截短）」））与「行号列」（行号 / 行号范围），并且有「被测」列或「类别 / 类」列的表；变异表不收。
//   三种来源：tests-1「用例」表（被测的流程标签、搭数据用到的流程标签）；tests-3 的 A / B / C 分类表（只有原件分类，没有标签）；tests-2 其余套件与浏览器场景表（被测、搭数据）。
//   每行：文件（标题层级里离表最近的、标题里含套件文件名 sysbuild-*.js / verify-sysbuild-*.js 的标题，不跨同级章节沿用）、用例名、行号范围、被测标签、搭数据标签、原件分类、机械初判、三个提交列、真实用例名匹配。
//   标签取法同 inv-parse.js（括号里的注记标签也计入；RPT = 进度汇报，保留，算保留类）。
//   提交（HIGH-3）：分开记两个提交：
//     被测行为删除提交 = 被测标签里全部可删标签的提交（HIS→C2、PRX→C3、HND→C4、CHG→C5、ENT 与 NTC→C6、ITEM→C7、MLT→C8，升序全列）；
//     夹具最早失效提交 = 搭数据标签里可删标签的最早提交（决定所属提交）；夹具失效提交 = 搭数据标签里全部可删标签的提交（升序全列）。
//     所属提交 = 这条用例最早要动手的提交（见下表）；全部受影响提交 = 被测行为删除提交 ∪ 全部夹具失效提交（代码并入全部夹具失效提交，不只是最早的一个；HIGH-4），去向表按它取行（见「按提交取行」一节）。
//   机械初判（先 a 后 b…，取第一个命中的）：
//     0 解析歧义 → 待裁定（解析歧义）；被测 / 搭数据单元格括号之外有未知大写词 → 待裁定（未知标签词）
//     a 被测只有可删标签（不含保留类标签 KEEP / INV / SETUP / RPT）：被测行为删除提交不止一个 → 要拆（跨提交）；只有一个：夹具最早失效提交早于它（被测在那之前仍保留，夹具先失效）→ 保留但需改夹具，所属提交 = 夹具最早失效提交；否则 → 整删，所属提交 = 被测行为删除提交
//     b 被测同时含可删标签和保留类标签 → 要拆（所属提交 = 两个提交列里最早的）
//     c 被测含 INV 或 SETUP（不含可删标签）：搭数据含可删标签 → 第一步不动但需改夹具（所属提交 = 夹具最早失效提交）；否则 → 第一步不动
//     d 被测只有 KEEP / RPT：搭数据含可删标签 → 保留但需改夹具（所属提交 = 夹具最早失效提交）；否则 → 不受影响
//     e 没有被测标签（tests-3）：按原件分类——A → 整删（原件 A 类＝只测停用流程）、B → 要拆（含保留规则断言）、C → 待裁定（拿不准）；其他 → 待裁定。没有标签就没有提交 → 进「待分派」
//   用例名对账：api 套件类文件（sysbuild-api-suite*.js）按 lib/sysbuild-api-suite.js 的 listCaseNames()；浏览器场景类文件（sysbuild-browser-*.js）按五个浏览器场景文件里 [名字, 函数] 数组的静态扫描；
//   verify-sysbuild-schema.js 按 CASE_NAMES；其余文件没有名单，记「无名单」；名单读取失败的整组记「未对账」。真实名单每项带定义文件（74 HIGH-5）：api 用例的定义文件由 listCaseNames() 的名字
//   对 lib/sysbuild-api-suite*.js 逐个静态扫描 test( 的首参来补，扫不到的 files = []（归属不明）。原件里的用例名（多为截短标题，末尾的 … 先去掉）先限定在「原件行所在套件文件定义的用例」里，再按前缀匹配：
//   恰好 1 个 → 对上；0 个 → 再试「包含」匹配，恰好 1 个记「仅包含匹配」；仍是 0 → 对不上；≥2 个 → 匹配多个。同文件里一个都没有时才退到归属不明的候选，那种命中 fileOk = false，只算候选，
//   不用于确认变异「不受影响」。对不上、匹配多个、未对账单独列出；「仅包含匹配」与「无名单」里受本步影响（有受影响提交）的行另列在「需人工复核的对账行」。
// 二、变异部分
//   主表 = mutation-check.js 的全量清单（每条一行：组、id、目标文件、所属用例 expect、全部编辑）。每条主表变异一个编号 M0001…（登记顺序）。
//   原件变异表（表头有「变异名」或「变异 id」）按「组 + id」匹配主表：原件行的组由它所在的套件文件名定（sysbuild-api-suite*.js → api、sysbuild-browser-*.js → browser、verify-sysbuild-static.js → static、verify-sysbuild-schema.js → schema），
//   取不出组的（如表不在任何套件标题下）算「组未定」，可匹配任何组并在备注里写明；id 相同但组不同的不算证据。同一变异的全部证据（全部匹配的原件行）先汇总再分类（HIGH-5）：
//   · 证据里任一行来自「守护保留规则」小节（按标题层级，含上级标题）→ 守保留规则（改挂）优先；
//   · 守护 / KEEP 证据与「只测停用」证据（标签只含可删标签、且编辑全落在整删文件或删除段）同时存在 → 待裁定（证据冲突），备注列出两边来源；
//   · 其余：任一证据解析歧义 → 待裁定（解析歧义）；任一证据主标签含未知词 → 待裁定（未知标签词）；有 KEEP / RPT 标签 → 守保留规则（改挂）；有只测停用证据 → 只测停用（删）；
//     标签只含可删标签、但编辑状态没核完 / 落在 INV 或归属不明的删除段（不能当第一步的删除）→ 待裁定（编辑未核实）；否则 → 待定。
//   原件里没有证据的标「原件无」；同一原件行被两条以上不同的（组, id）主表变异当证据时报「重复归属」（问题；同一（组, id）在主表里出现两次共用同一原件行只记警告）。
//   受控模糊匹配（同组内；只对没有精确证据的主表变异、只用还没被精确匹配用掉的原件行；原件 id 少于 6 字符不参与）：主表 id = 前缀「：」+ 原件 id、= 原件 id +「（…）」、两者并存，或原件 id 被截断（「（」没闭合）而主表 id 以它开头；
//   还须原件行的「目标源文件」与主表变异的目标文件一致（没有目标源文件列的表取表标题点名的文件）——不一致 / 没有目标依据 / 原件行组未定的候选不自动挂接，列在输出 5.2b 人工挂接。
//   主表一侧只命中 1 个原件 id、原件一侧（按原件位置 + 组计）只被 1 条主表变异命中才采用，备注标「模糊匹配」，全部列在输出 5.2；不唯一的不采用，候选写进备注。
//   前缀继承绑定父节实例（按父标题行号区分）：同一父节只声明过一种前缀、且本表排在第一张声明表之后，没写前缀的兄弟表才沿用；声明过不止一种前缀、或本表排在声明表之前 → 前缀继承待裁定，不替人选。
//   出自守护保留规则小节、仍对不上主表的原件行（占位行「（无明确条目）」除外）= 反向校验问题（退出码 1），列在输出 5.1 待人工挂接。
//   本表标题自身标明 C / 拿不准（或 A / 倾向 A）的守护小节行不当明确守护证据：初判「待裁定（原件 C 类）」（A 同理），守护标记保留在证据里。
//   初判以「待裁定」开头的用例 / 变异一律同时列入待分派（即使已有受影响提交）。守护 / 保留证据与「只含可删标签」的证据并存、但编辑没全落删除段（不算只测停用证据）时，不改判，备注里写「证据冲突备注」。
//   「不受影响」（变异）：expect 在真实名单里命中的全部真实用例（名单项，按身份对，不按名字文本）都要有承接用例行、承接行都对上（不含「仅包含匹配」）、与真实用例的定义文件对得上（fileOk）且都不受影响；
//   缺的按「承接用例 k/m 个未对上原件行」进待分派。
//   编辑逐个核（74 HIGH-3，editsOf / coverOf）：每个编辑都有状态，不再静默跳过非 replace 操作——replace：完整仓库相对路径（wbs-server/routes/sysbuild/<文件>）、定位字面量在目标文件里恰好出现 1 次、
//   完整覆盖区间（起止行）；create = 驱动在变异副本里新建仓库里不存在的合成文件（依据 mutation-check.js:342–351 与 :246–247，只有 static 组出现），状态 synthetic、整条豁免；create 的路径已存在 = 未核实；
//   remove = 删真实存在的文件，不是合成操作、不豁免（整删文件 → 覆盖；保留文件 → 不在删除范围；读不到 = 未核实）；未识别的操作 = 未核实。覆盖判断先核编辑状态、再核落点：
//   状态不 ok（整删文件里字面量找不到也一样）= bad；状态 ok 的：整删文件 = whole；整个区间落在同一个删除段且该段有可推断提交 = range；落在只含 INV（第一步不动）或「删什么」里没有关键词的段 = unowned
//   （归属不明确，不能当第一步的删除）；跨段边界 = cross；不在任何删除范围 = none。bad / unowned / cross 都是未核实 → 整条不判「只测停用（删）」。
//   已知受影响提交（HIGH-4）= 原件标签里可删标签的提交 ∪ 目标文件是整删文件时的删除提交（3.1「属于」列 S1–S9 → 第二节的标签 → 提交；编辑状态没核实也带）∪ 编辑所在删除段的提交
//   （3.3「删什么」里按关键词推断，只供参考：授权 / 邀请 / 提议 → INV（不在第一步）、历史 → HIS、代录 / 无账号 → PRX、交接 → HND、变更 / 评估 → CHG、办理 / 结论 / 裁定 / 异议 / 认可 / 拆分 / 承诺 / 风险 / 仅供参考 / 未办结 → ENT、知会异议 → NTC、条目 / 模块 / 提出人 → ITEM、批次 / 转出 / 被替代 → MLT）
//   ∪ 承接它的用例（expect 与真实用例名对上的原件用例行）的全部受影响提交。
//   未核完事项另记（open，不混进受影响提交）：初判待裁定、未核实编辑 / 归属不明的删除段、承接用例待分派、承接覆盖不足（未对上原件行、仅包含匹配、定义文件没确认、名单读取失败）。
//   有任何未核完事项的变异：同时列入待分派并标来源，即使已有受影响提交（它在对应提交的取行里照常出现，并标「仍有未核完事项」，裁定后要据结果重建受影响提交）；
//   没有未核完事项时：有受影响提交 → 已分派；有承接用例且承接用例都不受影响 → 不受影响；其余 → 待分派（列在「待分派」一节）。
//   仅凭标签（标签全是保留类标签）而找不到承接用例的，不判不受影响，进待分派，原因写「仅凭标签、未找到承接用例」。
// 解析：断行的表格行并回上一行；单元格数多于表头的行按 inv-parse.js 的规则读（反引号代码里的 | 先消化；多余单元格不止一个、左右读法标签不同或行号列错位 → 标「解析歧义」，用例初判「待裁定（解析歧义）」、变异初判「待裁定（解析歧义）」）。
// 三、反向校验（--check，默认开启）：① 期望文件与期望表；② 原文围栏外每个以 | 开头的非分隔行都落在某张已解析表上（用例表、变异表，或明确排除的「其他表」），落不到的列为问题，原文有 | 行却一张表都没解析出来也是问题；
//   ③ 重新解析写出的 markdown：原件每个用例表数据行恰好出现一次（按原件位置 + 文件 + 用例名 + 行号 + 被测 + 搭数据）；主表每条变异（组 + id）恰好一行；原件变异表里对不上主表的行单独列出，核对它们与主表匹配的行合计等于原件变异表数据行总数；
//   ④ 原件变异行重复归属；⑤ 「按提交取行」一节与两张明细表里每行的受影响提交列逐提交对拍（C2–C8，用例与变异编号集合必须一致）；
//   ⑥ 回读按 原件位置 + 组 + 编号 逐键对拍 build 的结果：变异的原件来源 / 机械初判 / 受影响提交、第五节对不上主表的原件行（原件位置 | 文件 | 变异名）、5.1 / 5.2 / 5.2b 的行、
//   第六节每个提交的用例 / 变异列（含「仍有未核完事项」两列）、第七节待分派的用例 / 变异行集合与变异的未核完事项来源；⑦ 原件围栏没闭合 = 不支持的写法，判问题；
//   ⑧ 九份输入（8 份取证原件 + 删除清单）的存在与 sha256 在两个生成器里各核一遍；登记表带完整标题路径与所属文件，路径 / 所属文件对不上 = 表归属错配；
//   删除清单的每条整删记录要有可解析的归属（S 编号 → 标签 → 提交），每条逐段记录要有可解析的行区间。
//   输出开头带生成时刻、输入文件 sha256 前 12 位、仓库 HEAD；`--no-check` 时输出与控制台标「未执行反向校验」，不写「通过」。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('./inv-parse');

const DEFAULT_REPO = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_INV_DIR = 'E:/数据开发与治理规范手册/docs/local/系统建设记录/送审准备/删除清单取证_20261119';
const DELETABLE = ['HIS', 'PRX', 'HND', 'CHG', 'ENT', 'NTC', 'ITEM', 'MLT'];
const COMMIT_OF = { HIS: 2, PRX: 3, HND: 4, CHG: 5, ENT: 6, NTC: 6, ITEM: 7, MLT: 8 };
const STAY = ['KEEP', 'INV', 'SETUP', 'RPT'];
const KEEPISH = ['KEEP', 'RPT'];
const COMMITS = [2, 3, 4, 5, 6, 7, 8];
const ROUTES_PREFIX = 'wbs-server/routes/sysbuild/';
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const normName = (s) => String(s === undefined || s === null ? '' : s).replace(/`/g, '').replace(/\s+/g, ' ').trim();
const uniqSorted = (a) => Array.from(new Set(a)).sort((x, y) => x - y);
const cText = (cs) => (cs.length ? cs.map((n) => 'C' + n).join('、') : '');
const DISP_PARSE = { fileFilter: (n) => /^(sysbuild-|verify-sysbuild-|Sys_Build)/.test(n) };

// ── 期望清单 ───────────────────────────────────────────────────────────────────────────
// 生成时刻与来源：2026-11-19 21:5x（本机时间）从当时的取证原件（del-inv-tests-1/2/3.md，mtime 11-19 12:50–13:25，sha256 前 12 位见生成输出头部）用 inv-parse.js（fileFilter = 套件文件名）逐表解析生成一次，
//   按「文件 + 所在标题 + 规范化表头」列出 91 张表，角色（case / mut / oth）按本文件的 roleOf 判出，oth 的理由逐张人工写成；生成后用生成器自身对原件反向核对（缺表 0、多出未登记 0、角色不符 0）才写死。
//   取证原件是冻结的证据；原件被改动（增删表、改标题或表头）时这里会报问题，需重新核对后更新本清单。
const EXPECTED_FILES = ['del-inv-tests-1.md', 'del-inv-tests-2.md', 'del-inv-tests-3.md'];
const EXPECTED_DELETION_LIST = '系统建设记录_流程简化_第一步_删除清单_20261119_v1.0.md';
const R_FN = '函数 / 位置登记表（带「流程标签」列但没有用例名 / 被测 / 变异 id）：前端函数、名单或夹具函数登记，归 build-impl-list.js 的符号取行';
// [文件, 所在标题, 规范化表头, 角色(case|mut|oth), 理由（oth 必填）]；H_* 是反复出现的规范化表头
const H_CASE = '序 | 用例编号 / 标题 | 行号范围 | 被测的流程标签 | 搭数据用到的流程标签 | 测什么（一句话）';
const H_HELP = '函数名 | 行号范围 | 调用的接口 / 数据来源 | 流程标签';
const H_MUT1 = '# | 变异名 | 改的源文件 | 锚点字面量（from，截断） | 流程标签';
const H_MUT2 = '# | 变异名 | 改的源文件 | 锚点字面量（前 70 字） | 流程标签（机器预标）';
const H_MUT2B = '# | 变异 id | 改的前端文件 | 锚点字面量（前 70 字） | 命中场景（expect） | 流程标签（机器预标）';
const H_FN = '函数 | 行号 | 渲染什么 / 接口 | 流程标签';
const H_UC = '用例 | 行号 | 被测 | 搭数据 | 说明';
const H_T3 = '序号 | 标题（截短） | 行号 | 类别 | 一句话依据';
const H_G = '变异 id | 目标源文件 | 定位字面量（截前 80 字） | 守护什么';
const DISP_TABLES = [
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'oth', R_FN],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'case', ''],
  ['del-inv-tests-1.md', '四、变异（GOLIVE_MUTATIONS，第 2660-2894 行，共 196 条）', H_MUT1, 'mut', ''],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'oth', R_FN],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'case', ''],
  ['del-inv-tests-1.md', '四、变异（NOTIFY_MUTATIONS，第 2613-2890 行，共 239 条）', H_MUT1, 'mut', ''],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'oth', R_FN],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'case', ''],
  ['del-inv-tests-1.md', '四、变异（CONFIRM_MUTATIONS，第 2382-2614 行，共 180 条）', H_MUT1, 'mut', ''],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'oth', R_FN],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'case', ''],
  ['del-inv-tests-1.md', '四、变异（ENTRY_MUTATIONS，第 1971-2196 行，共 183 条）', H_MUT1, 'mut', ''],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'oth', R_FN],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'case', ''],
  ['del-inv-tests-1.md', '四、变异（MEMBERSHIP_MUTATIONS，第 1711-1801 行，共 78 条）', H_MUT1, 'mut', ''],
  ['del-inv-tests-1.md', '总计', '文件 | 用例组数 | 变异数', 'oth', '「总计」表：每个套件的用例组数与变异数的合计（文件 | 用例组数 | 变异数），是对前面各套件表的计数汇总，不是用例行也不是变异行'],
  ['del-inv-tests-2.md', '1.1 页签注册与路由注册', '页签键 | 显示名 | 注册位置 | 流程标签 | 说明', 'oth', R_FN],
  ['del-inv-tests-2.md', '1.1 页签注册与路由注册', '路由键 | 位置 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-ui.js（1-400 行，共用界面层）', '函数 / 位置 | 行号 | 渲染什么 / 调用接口 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-page.js（1-487 行）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-members.js（1-164 行）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-evidence.js（1-171 行，附件与确认单）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-entries.js（1-374 行，登记、办理、知会）', '函数 / 常量 | 行号 | 渲染什么 / 接口 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-plan.js（1-253 行，排期、收口、交接）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-confirm.js（1-205 行，确认任务页）', '函数 / 常量 | 行号 | 渲染什么 / 接口 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-content.js（1-138 行，需求条目与候选材料）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-packages.js（1-169 行，内容包与正式变更）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口', 'oth', R_FN],
  ['del-inv-tests-2.md', 'sysbuild-notify.js（1-75 行）', H_FN, 'oth', R_FN],
  ['del-inv-tests-2.md', '1.3 timeline 事件映射表（sysbuild-page.js:441-454）里写死的旧流程事件名', '行 | 事件名（中文标签） | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', '1.4 Sys_Build.html（69 行）', '位置 | 内容 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', '2.2 verify-sysbuild-e2e.js（141 行）', '断言 | 行号 | 被测 | 搭数据 | 说明', 'case', ''],
  ['del-inv-tests-2.md', '2.3 sysbuild-api-suite.js（1817 行，主套件 + 夹具）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.4 sysbuild-api-suite-plan.js（1598 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.5 sysbuild-api-suite-sheet.js（1013 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.6 sysbuild-api-suite-trace-l1.js（476 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.7 sysbuild-api-suite-trace-l2.js（804 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.8 sysbuild-api-suite-trace-l3.js（170 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', '2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）', H_UC, 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-suite.js 自有场景（第 166-531 行）', '场景 | 行号 | 被测 | 搭数据（API 夹具） | 说明', 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-stage8.js（690 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-setup.js（262 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-forms.js（346 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-confirm.js（154 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'case', ''],
  ['del-inv-tests-2.md', '2.12 sysbuild-frontend-static.js（424 行）：S10 / S11 前端静态守卫', '名单 | 行 | 内容 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', '2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫', '名单 | 行 | 内容 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', '2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫', '表.列 | 条件片段 | 变异所在行 | 流程标签', 'oth', 'S2 变异点名的条件更新登记（表.列 | 条件片段 | 变异所在行 | 流程标签）：列的是 SQL 的（表.列, 条件）与变异所在的行区间，没有变异 id / 名，只是静态守卫自检的背景资料'],
  ['del-inv-tests-2.md', '2.14 verify-sysbuild-schema.js（813 行）：结构守卫', '名单 | 行 | 内容 | 流程标签', 'oth', R_FN],
  ['del-inv-tests-2.md', '2.14 verify-sysbuild-schema.js（813 行）：结构守卫', H_UC, 'case', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite.js 自有变异（47 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-frontend.js（19 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-stage8.js（41 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l1.js（56 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l2.js（79 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l3.js（11 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-plan.js（94 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-sheet.js（39 条）', H_MUT2, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-suite.js 自有 FRONT_MUTATIONS（23 条）', H_MUT2B, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-stage8.js（28 条）', H_MUT2B, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-setup.js（19 条）', H_MUT2B, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-forms.js（26 条）', H_MUT2B, 'mut', ''],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-confirm.js（8 条）', H_MUT2B, 'mut', ''],
  ['del-inv-tests-2.md', 'verify-sysbuild-static.js 的 MUTATIONS（109 条，起于第 663 行）', '行 | 变异 id | 规则 | 涉及的 sysbuild 表 / 改的文件 | 流程标签（机器预标）', 'mut', ''],
  ['del-inv-tests-2.md', 'verify-sysbuild-schema.js 的 MUTATIONS（78 条，起于第 629 行；改的都是 routes/sysbuild/schema.js 里的字面量）', '行 | 变异 id | 命中用例前缀 | 锚点字面量（前 90 字） | 流程标签（机器预标）', 'mut', ''],
  ['del-inv-tests-2.md', '3.1 六个套件：组数、变异数、登记运行位置', '文件 | 文件行数 | 用例组数 | 用例起止行（首个 test 起始行 ~ 最后一个 test 的起始行） | 变异数 | 变异数组所在行 | define 登记行（sysbuild-api-suite.js） | 变异并入行（sysbuild-api-suite.js） | 文件头声明的范围（取自 sysbuild-api-suite.js 的接线注释）', 'oth', '六个套件的组数 / 变异数 / 数组所在行 / 登记行统计（文件 | 文件行数 | 用例组数 | …），是套件级计数，没有逐条变异或用例'],
  ['del-inv-tests-2.md', '3.1 六个套件：组数、变异数、登记运行位置', '套件 | 变异改动的源文件与次数', 'oth', '六个套件的变异改动的源文件分布（套件 | 变异改动的源文件与次数），按源文件计次的分布表，没有逐条变异'],
  ['del-inv-tests-2.md', 'API 套件（lib/sysbuild-api-suite.js 汇总）', '子套件 | define 登记行 | 变异并入行', 'oth', 'API 套件接线登记行（子套件 | define 登记行 | 变异并入行），是 sysbuild-api-suite.js 里 define / 并入语句的行号，没有变异 id / 用例名'],
  ['del-inv-tests-2.md', '浏览器套件（lib/sysbuild-browser-suite.js 汇总）', '子文件 | require 行 | 用例并入行 | 变异并入行', 'oth', '浏览器套件接线登记行（子文件 | require 行 | 用例并入行 | 变异并入行），同上，行号登记表'],
  ['del-inv-tests-2.md', '入口脚本与全量验证成员登记', '文件 | 行 | 登记内容', 'oth', '入口脚本与全量验证成员登记（文件 | 行 | 登记内容），登记表，没有用例名 / 被测 / 变异 id'],
  ['del-inv-tests-3.md', '1. 用例组总表', '序号 | 标题（截短） | 行号范围 | 类别 | 一句话依据', 'case', ''],
  ['del-inv-tests-3.md', '4.1 包创建（expect 为「C3b 包创建：」或「C3b 包创建：权限」）', H_G, 'mut', ''],
  ['del-inv-tests-3.md', '4.2 包版本（expect 为「C3b 包版本：…」）', H_G, 'mut', ''],
  ['del-inv-tests-3.md', '4.3 snapshot（expect 为「C3b snapshot 编辑」「C3b snapshot 校验」）', H_G, 'mut', ''],
  ['del-inv-tests-3.md', '4.4 读接口与 actions（目标在 packages.js / attachments.js / 包解析）', H_G, 'mut', ''],
  ['del-inv-tests-3.md', '4.5 拿不准的变异（C）', '变异 id | 目标源文件 | 定位字面量（截前 80 字） | 说明', 'mut', ''],
  ['del-inv-tests-3.md', '1 用例组总表', H_T3, 'case', ''],
  ['del-inv-tests-3.md', '3.1 明确守护保留规则（目标文件 entries-core.js，不在保留文件表，但守护的函数 batchLiveState 被 golive-core / submission-scope / golive.js / plan.js 使用，属保留规则；需把函数及其判据测试一起留下）', '变异 id（前缀 C5 分流：） | 目标源文件 | 定位字面量（截前 80 字） | 守护什么 | 行', 'mut', ''],
  ['del-inv-tests-3.md', '3.2 C：守护「收口前置里的未结登记阻塞」，目标属保留文件 plan.js（是否保留取决于登记结论规则的去留）', '变异 id | 目标源文件 | 定位字面量（前 80 字） | 守护什么 | 行', 'mut', ''],
  ['del-inv-tests-3.md', '3.3 C：守护 link_sys_issue（rules.js，保留文件）', '变异 id | 目标源文件 | 定位字面量（前 80 字） | 守护什么 | 行', 'mut', ''],
  ['del-inv-tests-3.md', '1 用例组总表', '序号 | 标题（截短） | 行号 | 类 | 依据', 'case', ''],
  ['del-inv-tests-3.md', '1. 用例组总表', H_T3, 'case', ''],
  ['del-inv-tests-3.md', '3. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量（前80字） | 说明', 'mut', ''],
  ['del-inv-tests-3.md', '2. 全部用例组', H_T3, 'case', ''],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量（前80字） | 守护什么 / 判断', 'mut', ''],
  ['del-inv-tests-3.md', '2. 用例组总表（20 组）', H_T3, 'case', ''],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标文件 | 定位字面量（前 80 字） | 说明', 'mut', ''],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标文件 | 定位字面量 | 为什么是边界', 'mut', ''],
  ['del-inv-tests-3.md', '2. 用例组总表（23 组）', H_T3, 'case', ''],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', H_G.replace('截前 80 字', '前 80 字'), 'mut', ''],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量 | 说明', 'mut', ''],
];
// 每张登记表的「完整标题路径（各级标题用 ' › ' 连接）+ 所属文件（按 DISP_PARSE 解析出的套件文件名）」，与 DISP_TABLES 逐项同序（74 MEDIUM：登记原来只有末级标题，
//   末级标题与表头相同、上级套件不同的表光靠身份分不开，解析器把表归到错误的上级章节时原件 sha256 与身份都对得上，只有路径与所属文件会变）。
//   2026-11-19 用 inv-parse.js 对冻结原件逐表生成，并逐项核对身份与 DISP_TABLES 同序后写死；自检断言两个数组等长、每项 7 个元素。
const DISP_TABLE_LOC = [
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 1. sysbuild-api-suite-golive.js › 二、搭数据的共用函数", "sysbuild-api-suite-golive.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 1. sysbuild-api-suite-golive.js › 三、用例", "sysbuild-api-suite-golive.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 1. sysbuild-api-suite-golive.js › 四、变异（GOLIVE_MUTATIONS，第 2660-2894 行，共 196 条）", "sysbuild-api-suite-golive.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 2. sysbuild-api-suite-notify.js › 二、搭数据的共用函数", "sysbuild-api-suite-notify.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 2. sysbuild-api-suite-notify.js › 三、用例", "sysbuild-api-suite-notify.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 2. sysbuild-api-suite-notify.js › 四、变异（NOTIFY_MUTATIONS，第 2613-2890 行，共 239 条）", "sysbuild-api-suite-notify.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 3. sysbuild-api-suite-confirm.js › 二、搭数据的共用函数", "sysbuild-api-suite-confirm.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 3. sysbuild-api-suite-confirm.js › 三、用例", "sysbuild-api-suite-confirm.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 3. sysbuild-api-suite-confirm.js › 四、变异（CONFIRM_MUTATIONS，第 2382-2614 行，共 180 条）", "sysbuild-api-suite-confirm.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 4. sysbuild-api-suite-entries.js › 二、搭数据的共用函数", "sysbuild-api-suite-entries.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 4. sysbuild-api-suite-entries.js › 三、用例", "sysbuild-api-suite-entries.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 4. sysbuild-api-suite-entries.js › 四、变异（ENTRY_MUTATIONS，第 1971-2196 行，共 183 条）", "sysbuild-api-suite-entries.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 5. sysbuild-api-suite-membership.js › 二、搭数据的共用函数", "sysbuild-api-suite-membership.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 5. sysbuild-api-suite-membership.js › 三、用例", "sysbuild-api-suite-membership.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 5. sysbuild-api-suite-membership.js › 四、变异（MEMBERSHIP_MUTATIONS，第 1711-1801 行，共 78 条）", "sysbuild-api-suite-membership.js"],
  ["删旧流程取证：套件文件 1（golive / notify / confirm / entries / membership） › 总计", ""],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.1 页签注册与路由注册", ""],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.1 页签注册与路由注册", ""],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-ui.js（1-400 行，共用界面层）", "sysbuild-ui.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-page.js（1-487 行）", "sysbuild-page.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-members.js（1-164 行）", "sysbuild-members.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-evidence.js（1-171 行，附件与确认单）", "sysbuild-evidence.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-entries.js（1-374 行，登记、办理、知会）", "sysbuild-entries.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-plan.js（1-253 行，排期、收口、交接）", "sysbuild-plan.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-confirm.js（1-205 行，确认任务页）", "sysbuild-confirm.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-content.js（1-138 行，需求条目与候选材料）", "sysbuild-content.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-packages.js（1-169 行，内容包与正式变更）", "sysbuild-packages.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-history.js（1-85 行）", "sysbuild-history.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.2 逐文件函数表 › sysbuild-notify.js（1-75 行）", "sysbuild-notify.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.3 timeline 事件映射表（sysbuild-page.js:441-454）里写死的旧流程事件名", "sysbuild-page.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 一、前端 › 1.4 Sys_Build.html（69 行）", "Sys_Build.html"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.2 verify-sysbuild-e2e.js（141 行）", "verify-sysbuild-e2e.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.3 sysbuild-api-suite.js（1817 行，主套件 + 夹具）", "sysbuild-api-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.4 sysbuild-api-suite-plan.js（1598 行）", "sysbuild-api-suite-plan.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.5 sysbuild-api-suite-sheet.js（1013 行）", "sysbuild-api-suite-sheet.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.6 sysbuild-api-suite-trace-l1.js（476 行）", "sysbuild-api-suite-trace-l1.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.7 sysbuild-api-suite-trace-l2.js（804 行）", "sysbuild-api-suite-trace-l2.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.8 sysbuild-api-suite-trace-l3.js（170 行）", "sysbuild-api-suite-trace-l3.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）", "sysbuild-api-suite-stage8.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）", "sysbuild-api-suite-frontend.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.10 浏览器套件（共 37 个场景） › sysbuild-browser-suite.js 自有场景（第 166-531 行）", "sysbuild-browser-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.10 浏览器套件（共 37 个场景） › sysbuild-browser-stage8.js（690 行）", "sysbuild-browser-stage8.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.10 浏览器套件（共 37 个场景） › sysbuild-browser-trace-setup.js（262 行）", "sysbuild-browser-trace-setup.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.10 浏览器套件（共 37 个场景） › sysbuild-browser-trace-forms.js（346 行）", "sysbuild-browser-trace-forms.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.10 浏览器套件（共 37 个场景） › sysbuild-browser-trace-confirm.js（154 行）", "sysbuild-browser-trace-confirm.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.12 sysbuild-frontend-static.js（424 行）：S10 / S11 前端静态守卫", "sysbuild-frontend-static.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫", "verify-sysbuild-static.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫", "verify-sysbuild-static.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.14 verify-sysbuild-schema.js（813 行）：结构守卫", "verify-sysbuild-schema.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 二、测试 › 2.14 verify-sysbuild-schema.js（813 行）：结构守卫", "verify-sysbuild-schema.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.1 sysbuild-api-suite.js 自有变异 › sysbuild-api-suite.js 自有变异（47 条）", "sysbuild-api-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-frontend.js（19 条）", "sysbuild-api-suite-frontend.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-stage8.js（41 条）", "sysbuild-api-suite-stage8.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-trace-l1.js（56 条）", "sysbuild-api-suite-trace-l1.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-trace-l2.js（79 条）", "sysbuild-api-suite-trace-l2.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-trace-l3.js（11 条）", "sysbuild-api-suite-trace-l3.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-plan.js（94 条）", "sysbuild-api-suite-plan.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.2 其他 API 子套件的变异（frontend、stage8、trace-l1、trace-l2、trace-l3、plan、sheet） › sysbuild-api-suite-sheet.js（39 条）", "sysbuild-api-suite-sheet.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.3 浏览器套件变异（合计 104 条） › sysbuild-browser-suite.js 自有 FRONT_MUTATIONS（23 条）", "sysbuild-browser-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.3 浏览器套件变异（合计 104 条） › sysbuild-browser-stage8.js（28 条）", "sysbuild-browser-stage8.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.3 浏览器套件变异（合计 104 条） › sysbuild-browser-trace-setup.js（19 条）", "sysbuild-browser-trace-setup.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.3 浏览器套件变异（合计 104 条） › sysbuild-browser-trace-forms.js（26 条）", "sysbuild-browser-trace-forms.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.3 浏览器套件变异（合计 104 条） › sysbuild-browser-trace-confirm.js（8 条）", "sysbuild-browser-trace-confirm.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.4 verify-sysbuild-static.js 变异 › verify-sysbuild-static.js 的 MUTATIONS（109 条，起于第 663 行）", "verify-sysbuild-static.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 2.M 变异清单 › 2.M.5 verify-sysbuild-schema.js 变异 › verify-sysbuild-schema.js 的 MUTATIONS（78 条，起于第 629 行；改的都是 routes/sysbuild/schema.js 里的字面量）", "verify-sysbuild-schema.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 三、6 个整套属于旧流程的套件，以及全部套件的汇总登记位置 › 3.1 六个套件：组数、变异数、登记运行位置", ""],
  ["旧流程删除前取证：前端与测试（第 2 份） › 三、6 个整套属于旧流程的套件，以及全部套件的汇总登记位置 › 3.1 六个套件：组数、变异数、登记运行位置", ""],
  ["旧流程删除前取证：前端与测试（第 2 份） › 三、6 个整套属于旧流程的套件，以及全部套件的汇总登记位置 › 3.2 全部测试套件在哪里被汇总登记 › API 套件（lib/sysbuild-api-suite.js 汇总）", "sysbuild-api-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 三、6 个整套属于旧流程的套件，以及全部套件的汇总登记位置 › 3.2 全部测试套件在哪里被汇总登记 › 浏览器套件（lib/sysbuild-browser-suite.js 汇总）", "sysbuild-browser-suite.js"],
  ["旧流程删除前取证：前端与测试（第 2 份） › 三、6 个整套属于旧流程的套件，以及全部套件的汇总登记位置 › 3.2 全部测试套件在哪里被汇总登记 › 入口脚本与全量验证成员登记", ""],
  ["sysbuild-api-suite-items.js 取证结果 › 1. 用例组总表", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.1 包创建（expect 为「C3b 包创建：」或「C3b 包创建：权限」）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.2 包版本（expect 为「C3b 包版本：…」）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.3 snapshot（expect 为「C3b snapshot 编辑」「C3b snapshot 校验」）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.4 读接口与 actions（目标在 packages.js / attachments.js / 包解析）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.5 拿不准的变异（C）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 1 用例组总表", "sysbuild-api-suite-routing.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.1 明确守护保留规则（目标文件 entries-core.js，不在保留文件表，但守护的函数 batchLiveState 被 golive-core / submission-scope / golive.js / plan.js 使用，属保留规则；需把函数及其判据测试一起留下）", "sysbuild-api-suite-routing.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.2 C：守护「收口前置里的未结登记阻塞」，目标属保留文件 plan.js（是否保留取决于登记结论规则的去留）", "sysbuild-api-suite-routing.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.3 C：守护 link_sys_issue（rules.js，保留文件）", "sysbuild-api-suite-routing.js"],
  ["sysbuild-api-suite-devkey.js 取证结果 › 1 用例组总表", "sysbuild-api-suite-devkey.js"],
  ["sysbuild-api-suite-history.js 取证结果 › 1. 用例组总表", "sysbuild-api-suite-history.js"],
  ["sysbuild-api-suite-history.js 取证结果 › 3. 守护保留规则的变异", "sysbuild-api-suite-history.js"],
  ["sysbuild-api-suite-changes.js 取证结果 › 2. 全部用例组", "sysbuild-api-suite-changes.js"],
  ["sysbuild-api-suite-changes.js 取证结果 › 4. 守护保留规则的变异", "sysbuild-api-suite-changes.js"],
  ["sysbuild-api-suite-proxy.js 取证结果 › 2. 用例组总表（20 组）", "sysbuild-api-suite-proxy.js"],
  ["sysbuild-api-suite-proxy.js 取证结果 › 4. 守护保留规则的变异", "sysbuild-api-suite-proxy.js"],
  ["sysbuild-api-suite-proxy.js 取证结果 › 4. 守护保留规则的变异", "sysbuild-api-suite-proxy.js"],
  ["sysbuild-api-suite-trace-l1.js 取证结果 › 2. 用例组总表（23 组）", "sysbuild-api-suite-trace-l1.js"],
  ["sysbuild-api-suite-trace-l1.js 取证结果 › 4. 守护保留规则的变异", "sysbuild-api-suite-trace-l1.js"],
  ["sysbuild-api-suite-trace-l1.js 取证结果 › 4. 守护保留规则的变异", "sysbuild-api-suite-trace-l1.js"],
];
// 每张登记表的表头物理行号（与 DISP_TABLES 同序；76 号 MEDIUM-2：登记按物理位置配对，完整路径 + 所属文件 + 表头都相同的重复节不再靠出现顺序配对）。
//   2026-11-19 对冻结原件生成，并用一份不依赖 inv-parse 的朴素扫描（以 | 开头、下一行是分隔行）逐文件独立核对表头行集合一致（tmp/c1c-gen5/gen-lines.js）、再逐项核对身份；
//   冻结原件内完整路径 + 所属文件 + 表头都相同的表对数为 0（evidence-r3.txt），位置项是防日后原件增删重复节时的错位。
const DISP_TABLE_LINE = [
  25, 45, 89, 310, 325, 365, 629, 651, 703, 910,
  924, 954, 1164, 1172, 1201, 1292, 33, 50, 65, 75,
  105, 127, 139, 159, 176, 194, 206, 222, 234, 244,
  266, 295, 311, 342, 381, 409, 440, 486, 498, 514,
  529, 552, 565, 577, 587, 601, 617, 636, 651, 664,
  703, 760, 784, 831, 898, 988, 1005, 1112, 1163, 1193,
  1226, 1250, 1281, 1297, 1414, 1504, 1515, 1535, 1561, 1570,
  29, 175, 193, 214, 238, 261, 301, 373, 382, 394,
  431, 535, 590, 622, 723, 751, 830, 836, 867, 938,
  947,
];
// 同批取证目录里不归本生成器读、但属于期望的其他取证原件（build-impl-list.js 读）：目录全集对比时不报「多出」，但存在与 sha256 在本生成器里同样要核
const SIBLING_FILES = ['del-inv-backend-1.md', 'del-inv-backend-2.md', 'del-inv-backend-3.md', 'del-inv-backend-4.md', 'del-inv-guards.md'];
// 取证原件与删除清单是冻结的证据：登记 sha256，改动 / 缺失都报问题（登记在 inv-parse.js 的 EVIDENCE_SHA256 / DELETION_LIST_SHA256，两个生成器共用同一份，2026-11-19 用 sha256sum 取得）；
//   本生成器读 3 份测试原件，另外 5 份（SIBLING_FILES）只核存在与摘要，九份输入（8 份原件 + 删除清单）在两个生成器里各核一遍。
const EXPECTED_SHA256 = P.EVIDENCE_SHA256;
// 删除清单 3.3「逐段删的文件」里没有行区间、只有文字描述的两条记录（2026-11-19 冻结清单）：schema.js「见第四节」（库结构的表 / 列 / 取值，不是行区间）、index.js「三个整删文件的挂载；传给各路由的依赖」。
//   主会话裁定：schema.js 按方案第三节第 1 条（库结构只在 C8 改）计已归属、所属提交 C8；index.js 的挂载按流程分到不同提交，编辑状态 ok 也按 unowned 处理（进人工）；不在这个登记里的无区间记录都是问题。
const DELETION_NO_RANGE = ['schema.js', 'index.js'];
const REGISTRY = { files: EXPECTED_FILES, siblings: SIBLING_FILES, sha256: EXPECTED_SHA256, deletionList: EXPECTED_DELETION_LIST, deletionListSha256: P.DELETION_LIST_SHA256, deletionNoRange: DELETION_NO_RANGE, tables: DISP_TABLES.map((e, i) => e.concat(DISP_TABLE_LOC[i] || [], [DISP_TABLE_LINE[i]])) };

// ── 用例表 ─────────────────────────────────────────────────────────────────────────────
const nameColOf = (h) => h.findIndex((x) => /^(用例编号 \/ 标题|标题|用例|场景|断言)/.test(x));
function caseTableCols(header) {
  if (P.mutationTable(header) || header.some((h) => /变异/.test(h))) return null;
  const name = nameColOf(header);
  const line = header.findIndex((h) => /^行号/.test(h));
  const tested = header.findIndex((h) => /被测/.test(h));
  const setup = header.findIndex((h) => /搭数据/.test(h));
  const cat = header.findIndex((h) => /^(类别|类)$/.test(h));
  if (name < 0 || line < 0 || (tested < 0 && cat < 0)) return null;
  const why = header.findIndex((h) => /依据|说明|测什么/.test(h));
  return { name, line, tested, setup, cat, why };
}
// 表的角色：case / mut / oth
const roleOf = (t) => (caseTableCols(t.header) ? 'case' : (P.mutationTable(t.header) ? 'mut' : 'oth'));
function caseRows(srcName, tables) {
  const out = [];
  for (const t of tables) {
    const cols = caseTableCols(t.header);
    if (!cols) continue;
    for (const r of t.rows) {
      const c = (i) => (i >= 0 && r.cells[i] !== undefined ? r.cells[i] : '');
      out.push({
        src: srcName + ':' + r.line, file: t.file, name: c(cols.name), lines: c(cols.line),
        testedText: c(cols.tested), setupText: c(cols.setup), origCat: c(cols.cat), why: c(cols.why), heading: t.heading, ambiguous: !!r.ambiguous, ambReason: r.ambReason || '', candText: r.candText || '', rawLine: r.raw || '', lineRange: r.line + (r.endLine !== r.line ? '–' + r.endLine : ''),
      });
    }
  }
  return out;
}
function labelsOf(text) { const l = P.parseLabels(text); return Array.from(new Set(l.main.concat(l.note))); }
const unknownOf = (text) => P.parseLabels(text).unknown;
// 用例初判与三个提交列（见头注释「提交（HIGH-3）」）
function judgeCase(r) {
  const T = labelsOf(r.testedText);
  const S = labelsOf(r.setupText);
  const unk = unknownOf(r.testedText).concat(unknownOf(r.setupText));
  const td = T.filter((x) => DELETABLE.includes(x));
  const ts = T.filter((x) => STAY.includes(x));
  const sd = S.filter((x) => DELETABLE.includes(x));
  const beh = uniqSorted(td.map((x) => COMMIT_OF[x])); // 被测行为删除提交
  const fx = uniqSorted(sd.map((x) => COMMIT_OF[x])); // 夹具失效提交
  const behMin = beh.length ? beh[0] : null;
  const behMax = beh.length ? beh[beh.length - 1] : null;
  const fxMin = fx.length ? fx[0] : null;
  let verdict;
  let owner = null;
  if (r.ambiguous) verdict = '待裁定（解析歧义）'; // 被测 / 类别单元格列边界定不下来（inv-parse.js readCells）
  else if (unk.length) verdict = '待裁定（未知标签词）';
  else if (T.length === 0) {
    const c = String(r.origCat || '').trim().charAt(0).toUpperCase();
    verdict = c === 'A' ? '整删' : (c === 'B' ? '要拆' : '待裁定');
    owner = fxMin;
  } else if (td.length > 0 && ts.length === 0) {
    // J1：被测只有可删标签；跨多个提交不能在任何一个提交里整条删 → 要拆（跨提交）；单一提交：夹具先于被测失效 → 先要改夹具（保留但需改夹具），否则整删
    if (beh.length > 1) { verdict = '要拆（跨提交）'; owner = fxMin !== null ? Math.min(behMin, fxMin) : behMin; } else if (fxMin !== null && fxMin < behMin) { verdict = '保留但需改夹具'; owner = fxMin; } else { verdict = '整删'; owner = behMin; }
  } else if (td.length > 0) { verdict = '要拆'; owner = fxMin !== null ? Math.min(behMin, fxMin) : behMin; } else if (T.includes('INV') || T.includes('SETUP')) { verdict = sd.length ? '第一步不动但需改夹具' : '第一步不动'; owner = fxMin; } else if (sd.length) { verdict = '保留但需改夹具'; owner = fxMin; } else verdict = '不受影响';
  const affected = uniqSorted(beh.concat(fx));
  // 所属提交：「要拆（跨提交）」写「最早–最晚」，其余写一个提交
  const commit = owner === null ? '' : (verdict === '要拆（跨提交）' ? 'C' + owner + '–C' + behMax : 'C' + owner);
  return { verdict, commit, owner, beh, fx, fxMin, affected, tested: T, setup: S, unknown: unk };
}
// 真实用例名单的一项：{ name, files }。files = 定义这个用例的文件（basename）；[] = 归属不明（静态扫描没找到它是哪个文件定义的）；定义在不止一个文件里的带全部文件。
//   纯字符串项（旧格式 / 自检里直接给的名单）按 files = [] 处理，也就是「归属不明」。
const nameEntry = (n) => ((n && typeof n === 'object' && 'name' in n && Array.isArray(n.files)) ? n : { name: String(n && typeof n === 'object' ? n.name : n), files: n && typeof n === 'object' ? (Array.isArray(n.files) ? n.files : (n.file ? [n.file] : [])) : [] });
const normNameList = (list) => (Array.isArray(list) ? list.map(nameEntry) : null);
// 真实用例名匹配（74 HIGH-5）：原件里的用例名多为截短标题，必须在「原件行所在套件文件定义的用例」里找（file = 原件行的文件，缺省不限定文件）；
//   在同文件候选里按前缀（恰好 1 个 → 对上；≥2 → 匹配多个）→ 包含（恰好 1 个 → 仅包含匹配）依次找；同文件里一个都没有时才退到「归属不明」的候选（files = []），
//   命中也只算候选：fileOk = false，不用于确认「不受影响」。不指定文件（file 缺省）时在整份名单里找，fileOk 恒为 false。
//   返回 { status, hits: [名字…], entries: [名单项…], fileOk }。
function matchName(orig, names, file) {
  const o = normName(orig).replace(/[…]+$|\.{3}$/, '').trim();
  const list = normNameList(names);
  const mk = (status, es, fileOk) => ({ status, hits: es.map((e) => e.name), entries: es, fileOk });
  if (!list) return mk('无名单', [], false);
  if (!o) return mk('对不上', [], false);
  const run = (cands) => {
    const pre = cands.filter((e) => normName(e.name).startsWith(o));
    if (pre.length === 1) return ['对上', pre];
    if (pre.length > 1) return ['匹配多个', pre];
    const inc = cands.filter((e) => normName(e.name).includes(o));
    if (inc.length === 1) return ['仅包含匹配', inc];
    if (inc.length > 1) return ['匹配多个', inc];
    return ['对不上', []];
  };
  if (!file) { const [s, es] = run(list); return mk(s, es, false); }
  const [s1, es1] = run(list.filter((e) => e.files.includes(file)));
  if (s1 !== '对不上') return mk(s1, es1, true);
  const [s2, es2] = run(list.filter((e) => e.files.length === 0));
  return mk(s2, es2, false);
}
// 文件 → 名单类别（api / browser / schema / null = 没有名单）
function nameKindOf(file) {
  if (/^sysbuild-api-suite.*\.js$/.test(file)) return 'api';
  if (/^sysbuild-browser-.*\.js$/.test(file)) return 'browser';
  if (file === 'verify-sysbuild-schema.js') return 'schema';
  return null;
}
function namesFor(file, names) { const k = nameKindOf(file); return k ? (names[k] || null) : null; }
// 名单读取失败的整组记「未对账」（不用部分名单），没有名单的文件记「无名单」
function matchCase(file, orig, names) {
  const k = nameKindOf(file);
  if (!k) return { status: '无名单', hits: [], entries: [], fileOk: false };
  if (!names[k]) return { status: '未对账', hits: [], entries: [], fileOk: false };
  return matchName(orig, names[k], file);
}

// ── 变异表 ─────────────────────────────────────────────────────────────────────────────
// 与 impl 清单同一个识别函数（inv-parse.js mutationTable）；prefix = 表头括号里写的「前缀 X」，读 id 时补在每个 id 前面
// target = 「目标源文件」列（改的源文件 / 改的前端文件 / 目标源文件 / 目标文件 / 涉及的 … 改的文件）：模糊匹配要核它与主表目标文件是否一致（74 HIGH-6）；没有这一列为 -1
function mutTableCols(header) {
  const m = P.mutationTable(header);
  const target = header.findIndex((h, i) => i !== (m && m.nameCol) && /文件/.test(h) && !/锚点|定位|用例|场景|守护|说明|expect/.test(h));
  return m ? { name: m.nameCol, label: m.labelCol, prefix: m.prefix, target } : null;
}
const baseNamesOf = (text) => Array.from(new Set(Array.from(String(text || '').matchAll(P.FILE_RE)).map((x) => x[0])));
// 原件所在套件文件名 → 变异组（取不出为 ''）
function groupOfFile(file) {
  if (/^sysbuild-browser-/.test(file)) return 'browser';
  if (file === 'verify-sysbuild-static.js') return 'static';
  if (file === 'verify-sysbuild-schema.js') return 'schema';
  if (/^sysbuild-api-suite/.test(file)) return 'api';
  return '';
}
// 本表标题自身标明的原件分类：C / 拿不准 → 'C'；倾向 A / A → 'A'；没有标明为 ''（上级标题的标记不算）
function origClassOf(heading) {
  const h = String(heading);
  if (/拿不准/.test(h)) return 'C';
  if (/倾向\s*A/.test(h)) return 'A';
  if (/^\d+(?:\.\d+)*\s*C[：:（(]|[（(]C[）)]/.test(h)) return 'C';
  if (/^\d+(?:\.\d+)*\s*A[：:（(]|[（(]A[）)]/.test(h)) return 'A';
  return '';
}
// 占位行：原件写「（无明确条目）」这类没有具体变异的行
const isPlaceholderId = (id) => /^[（(]无[^）)]*[）)]$/.test(String(id).trim());
// 前缀继承（74 MEDIUM）：同一父节实例（按父标题在原文里的行号区分，不按标题文字）里，没写前缀的兄弟表沿用该父节里声明的前缀——
//   只在「该父节只声明过一种前缀、且本表排在第一张声明表之后」时沿用；该父节声明过不止一种前缀（新增的显式前缀不会替换首个前缀，后面未声明的兄弟表归哪个定不下来），
//   或本表排在声明表之前（表的顺序一变就不再继承），都不替人选：本表的行标 ambiguous（前缀继承待裁定），id 不带前缀。
function mutRows(srcName, tables) {
  const out = [];
  const parentOf = (t) => srcName + ':' + (t.headingLines || []).slice(0, -1).join(',');
  const decl = new Map(); // 父节实例 → { prefixes: Set, first: 第一张声明前缀的表在 tables 里的序号 }
  tables.forEach((t, ti) => {
    const cols = mutTableCols(t.header);
    if (!cols || !cols.prefix) return;
    const k = parentOf(t);
    if (!decl.has(k)) decl.set(k, { prefixes: new Set(), first: ti });
    decl.get(k).prefixes.add(cols.prefix);
  });
  tables.forEach((t, ti) => {
    const cols = mutTableCols(t.header);
    if (!cols) return;
    const d = decl.get(parentOf(t));
    let prefix = cols.prefix;
    let inherited = false;
    let prefixAmb = '';
    if (!prefix && d) {
      if (d.prefixes.size === 1 && ti > d.first) { prefix = Array.from(d.prefixes)[0]; inherited = true; } else if (d.prefixes.size > 1) prefixAmb = '前缀继承待裁定：同一父节声明了 ' + d.prefixes.size + ' 种前缀（' + Array.from(d.prefixes).join(' / ') + '），本表没写前缀，不替人选';
      else prefixAmb = '前缀继承待裁定：本表排在声明前缀「' + Array.from(d.prefixes)[0] + '」的表之前，是否沿用定不下来';
    }
    // 守护保留规则小节：本表标题、上级标题（headingPath）或表头里写着「守护 / 守卫保留规则」
    const guard = (t.headingPath || [t.heading]).some((h) => /守[护卫]保留规则/.test(h)) || /守[护卫]保留规则/.test(t.header.join(' '));
    const origClass = origClassOf(t.heading); // 本表标题自身标明 C / 拿不准 / A 时覆盖从上级标题继承的守护标记（MED-1）
    const heads = baseNamesOf((cols.target >= 0 ? '' : t.headingPath ? t.headingPath.slice(-1)[0] : t.heading));
    for (const r of t.rows) {
      const c = (i) => (i >= 0 && r.cells[i] !== undefined ? r.cells[i] : '');
      const labelText = cols.label >= 0 ? c(cols.label) : '';
      const rawId = c(cols.name);
      // 原件行的目标文件：目标源文件列里的文件名；没有这一列的表取本表标题里点名的文件名（只用于模糊匹配时核目标一致）
      const targets = cols.target >= 0 ? baseNamesOf(c(cols.target)) : heads;
      out.push({ src: srcName + ':' + r.line, file: t.file, group: groupOfFile(t.file), id: normName(prefix + rawId), labelText, labels: labelsOf(labelText), unknown: unknownOf(labelText), guard, origClass, prefixInherited: inherited, placeholder: isPlaceholderId(rawId), heading: t.heading, targets, ambiguous: !!r.ambiguous || !!prefixAmb, ambReason: [r.ambReason || '', prefixAmb].filter(Boolean).join('；'), candText: r.candText || '', rawLine: r.raw || '', lineRange: r.line + (r.endLine !== r.line ? '–' + r.endLine : '') });
    }
  });
  return out;
}
// 受控模糊匹配（同组内，主表 id vs 原件 id）：
//   ① 主表 id = 某前缀「：」/「:」+ 原件 id；② 主表 id = 原件 id + 「（…）」；①② 可同时（前缀「：」+ 原件 id +「（…）」）；
//   ③ 原件 id 自己带没闭合的「（」（被截断），主表 id 以它（去掉行尾的 \）开头。原件 id 少于 6 个字符不参与。
function fuzzyHow(masterId, origId) {
  const o = String(origId).replace(/\\+$/, '').trim();
  const m = String(masterId);
  if (o.length < 6 || m === origId || m === o) return null;
  if ((o.match(/（/g) || []).length > (o.match(/）/g) || []).length && m.startsWith(o)) return '原件 id 被截断（「（」没闭合）';
  const idx = m.indexOf(o);
  if (idx < 0) return null;
  const pre = m.slice(0, idx);
  const post = m.slice(idx + o.length);
  const okPre = pre === '' || /[：:]\s*$/.test(pre);
  const okPost = post === '' || /^[（(]/.test(post);
  if (!okPre || !okPost || (pre === '' && post === '')) return null;
  return [pre ? '前缀：+原件 id' : '', post ? '原件 id +（…）' : ''].filter(Boolean).join(' ');
}
const MVERDICTS = ['只测停用（删）', '守保留规则（改挂）', '待定', '待裁定（解析歧义）', '待裁定（证据冲突）', '待裁定（未知标签词）', '待裁定（原件 C 类）', '待裁定（原件 A 类）', '待裁定（编辑未核实）', '待裁定（混合区间）'];
const lineOfIndex = (text, idx) => { let n = 1; for (let i = 0; i < idx; i += 1) if (text.charCodeAt(i) === 10) n += 1; return n; };

// ── 删除清单 ───────────────────────────────────────────────────────────────────────────
// 「删什么」里的关键词 → 标签（只用于推断删除段属于哪个提交，见头注释）
const SEG_KEYWORDS = [
  ['INV', /授权|邀请|提议/], ['HIS', /历史/], ['PRX', /代录|无账号/], ['HND', /交接/], ['CHG', /变更|评估/],
  ['ENT', /办理|结论|裁定|异议|认可|拆分|承诺|风险|仅供参考|未办结/], ['NTC', /知会异议/], ['ITEM', /条目|模块|提出人/], ['MLT', /批次|转出|被替代/],
];
function segLabels(text) { return SEG_KEYWORDS.filter(([, re]) => re.test(text)).map(([l]) => l); }
// 混合区间（主会话 11-20 裁定，77 号 H2）：「删什么」块里出现保留类表述（词表如下），或推出非第一步标签（INV、SETUP、KEEP：没有第一步提交的标签），
//   说明这个删除段里夹着保留规则的分支或第二 / 三步的内容，编辑落在里面不能推出「只测停用（删）」。块内只有第一步可删标签（多个也可以，如 ENT+MLT）的照旧。
const KEEP_PHRASES = /保留|不删|不动|第二步|第三步|\bINV\b|\bSETUP\b|\bKEEP\b/;
// 部分删除的限定词（预筛 HIGH-1，主会话 2026-11-20 裁定）：来源 = 冻结删除清单 3.3 里「只删这个范围的一部分」的写法，例如
//   entries.js `办理动作（除更正、作废外的全部分支，:618–817 的大部分）`、entries-core.js `状态推导里的办理部分（:158–212 的大部分）`、confirm.js `撤回里的变更分支（…的相应部分）`。
//   块文本出现任一限定词，说明区间内夹着保留的部分（更正 / 作废分支等），编辑落在区间里不能推出「只测停用」。
const PARTIAL_PHRASES = /除[^，；。]{0,30}外|大部分|部分|相应|对应|只剩|其余|以外/;
function mixedWhyOf(text, labels) {
  const why = [];
  const m = KEEP_PHRASES.exec(text);
  if (m) why.push('含保留类表述「' + m[0] + '」');
  const pm = PARTIAL_PHRASES.exec(text);
  if (pm) why.push('含部分删除的限定词「' + pm[0] + '」');
  const non = labels.filter((l) => !COMMIT_OF[l]);
  if (non.length) why.push('含非第一步标签 ' + non.join('、'));
  return why.join('；');
}
// 一条「删什么」文字 → 行区间段 [{ from, to, labels, commits }]；按括号外的 ；，；,、 切块，块里的区间用块里的关键词；括号里的区间并入所在块；
//   只含区间（没有别的文字）的块沿用前一个有文字的块的标签（例：`授权与邀请 :337–347、:365–370` 的第二个区间）；有文字但没有关键词的块标签为空（提交未知）
function segmentsOf(text) {
  const chunks = [];
  let depth = 0;
  let cur = '';
  for (const ch of String(text)) {
    if (ch === '（' || ch === '(') depth += 1; else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[；，;,、]/.test(ch)) { chunks.push(cur); cur = ''; } else cur += ch;
  }
  chunks.push(cur);
  const out = [];
  let lastLabels = [];
  let lastText = '';
  let lastMixed = '';
  for (const c of chunks) {
    const rangeOnly = c.replace(/:(\d+)(?:[–-](\d+))?/g, '').replace(/[`\s]/g, '') === '';
    const labels = rangeOnly ? lastLabels : segLabels(c);
    if (!rangeOnly) { lastLabels = labels; lastText = c.trim(); lastMixed = mixedWhyOf(c, labels); }
    const commits = uniqSorted(labels.filter((l) => COMMIT_OF[l]).map((l) => COMMIT_OF[l]));
    for (const m of c.matchAll(/:(\d+)(?:[–-](\d+))?/g)) out.push({ from: Number(m[1]), to: Number(m[2] || m[1]), labels, commits, text: rangeOnly ? lastText : c.trim(), mixed: rangeOnly ? lastMixed : mixedWhyOf(c, labels) });
  }
  return out;
}
function deletionInfo(text) {
  const lines = text.split(/\r?\n/);
  const sLabel = new Map(); // 'S6' → 'HIS'（第二节判定口径表）
  const a2 = lines.findIndex((l) => /^## 二、/.test(l));
  const b2 = lines.findIndex((l, i) => i > a2 && /^## 三、/.test(l));
  if (a2 >= 0) {
    for (const l of lines.slice(a2, b2 < 0 ? undefined : b2)) {
      if (!l.startsWith('|')) continue;
      const c = P.splitRow(l);
      const m = /^(S\d+)\b/.exec(c[0] || '');
      const lab = /^[A-Z]{2,5}$/.exec((c[1] || '').trim());
      if (m && lab) sLabel.set(m[1], lab[0]);
    }
  }
  const a = lines.findIndex((l) => /^## 三、/.test(l));
  const b = lines.findIndex((l, i) => i > a && /^## 四、/.test(l));
  const whole = [];
  const wholeCommit = new Map();
  const ranges = new Map();
  const segments = new Map();
  const problems = []; // 74 MEDIUM：每条整删记录要有可解析的归属，每条逐段记录要有可解析的行区间；读不出来的在这里报，不静默跳过
  const noRange = []; // 3.3 里读不出行区间的逐段记录 [{ file, text }]（2026-11-19 冻结清单里有两条：schema.js「见第四节」、index.js 的挂载文字描述——登记在 DELETION_NO_RANGE，其余的都是问题）
  let sec = '';
  let inTable = false;
  let segRows = 0;
  for (const l of lines.slice(a < 0 ? 0 : a, b < 0 ? undefined : b)) {
    if (/^### 3\.(\d)/.test(l)) { sec = RegExp.$1; inTable = false; continue; }
    if (!l.startsWith('|')) { inTable = false; continue; }
    if (/^\|[\s:|-]+\|?\s*$/.test(l)) { inTable = true; continue; }
    if (!inTable) continue;
    const cells = P.splitRow(l);
    const m = /`([A-Za-z0-9_-]+\.js)`/.exec(cells[0] || '');
    if (!m) {
      if (sec === '1' || sec === '3') problems.push(`删除清单 3.${sec} 里一条记录读不出文件名（第一列没有 \`xxx.js\`）：${l.slice(0, 80)}`);
      continue;
    }
    if (sec === '1') {
      whole.push(m[1]);
      const s = /\bS\d+\b/.exec(cells[2] || '');
      const lab = s ? sLabel.get(s[0]) : null;
      wholeCommit.set(m[1], lab && COMMIT_OF[lab] ? COMMIT_OF[lab] : null);
      if (!s) problems.push(`删除清单 3.1 整删记录 ${m[1]} 的「属于」列没有 S 编号（读到「${(cells[2] || '').slice(0, 30)}」）`);
      else if (!lab) problems.push(`删除清单 3.1 整删记录 ${m[1]} 的 ${s[0]} 在第二节判定口径表里找不到标签`);
      else if (!COMMIT_OF[lab]) problems.push(`删除清单 3.1 整删记录 ${m[1]} 的归属标签 ${lab} 没有对应的第一步提交`);
    } else if (sec === '3') {
      segRows += 1;
      const segs = cells[1] !== undefined ? segmentsOf(cells[1]) : [];
      if (segs.length === 0) noRange.push({ file: m[1], text: String(cells[1] === undefined ? '（缺这一列）' : cells[1]).slice(0, 60) }); // 只有文字描述、没有行区间的逐段记录：generate 对照登记的预期清单核，不在登记里的报问题
      ranges.set(m[1], (ranges.get(m[1]) || []).concat(segs.map((s) => [s.from, s.to])));
      segments.set(m[1], (segments.get(m[1]) || []).concat(segs));
    }
  }
  // 77 号 LOW：ranges 也登记只有文字描述的文件（区间数组为空），按「区间数组非空」统计抽出行区间的文件 / 区间数；无区间文件另列 noRange
  const rangeFiles = Array.from(ranges.entries()).filter(([, v]) => v.length > 0).map(([k]) => k);
  const rangeCount = Array.from(ranges.values()).reduce((s, v) => s + v.length, 0);
  return { whole, wholeCommit, ranges, segments, sLabels: sLabel.size, problems, segRows, noRange, rangeFiles, rangeCount };
}

// ── 变异：主表读取、编辑核对、初判 ─────────────────────────────────────────────────────
// 编辑 → 完整覆盖区间核对：返回 [{ file, op, status, line, endLine, ... }]，每个编辑都有一条（74 HIGH-3：不再静默跳过非 replace 操作）。
//   操作逐类处理（依据 mutation-check.js:342–351 与 :246–247 的编辑规范化：只有 static 组出现 create / remove）：
//   · replace（op 缺省也按 replace）：核目标文件、定位字面量恰好 1 次，给出起止行；
//   · create = 驱动在变异副本里新建一个仓库里并不存在的合成文件（zz_*.js 之类）：目标路径在仓库里确实不存在才算合成，status = synthetic，整条豁免（不参与覆盖判断，也不挡「只测停用」）；
//     路径在仓库里已存在则是「合成文件路径在仓库里已存在」，按未核实；
//   · remove = 驱动在变异副本里删掉一个真实存在的文件：不是合成操作，不豁免——目标文件存在则 status = ok（无行号），按「目标是不是整删文件」判覆盖，不存在按未核实；
//   · 其他操作名：status = 未识别的编辑操作，未核实。
function editsOf(repo, m, cache) {
  const list = Array.isArray(m.edits) ? m.edits : (m.firstEdits || []).map((e) => ({ op: 'replace', file: e.file, from: e.from }));
  const out = [];
  const exists = (file) => { try { return fs.existsSync(path.join(repo, file)); } catch (_) { return false; } };
  for (const e of list) {
    const op = e.op === undefined ? 'replace' : e.op;
    if (typeof e.file !== 'string') { out.push({ file: '?', op, status: '目标文件取不到' }); continue; }
    if (op === 'create') { out.push({ file: e.file, op, status: exists(e.file) ? '合成文件路径在仓库里已存在' : 'synthetic' }); continue; }
    if (op === 'remove') { out.push({ file: e.file, op, status: exists(e.file) ? 'ok' : '目标文件读不到' }); continue; }
    if (op !== 'replace') { out.push({ file: e.file, op, status: '未识别的编辑操作 ' + String(op) }); continue; }
    if (typeof e.from !== 'string') { out.push({ file: e.file, op, status: '定位字面量取不到' }); continue; }
    let text = cache.get(e.file);
    if (text === undefined) {
      try { text = fs.readFileSync(path.join(repo, e.file), 'utf8').replace(/\r\n/g, '\n'); } catch (_) { text = null; }
      cache.set(e.file, text);
    }
    if (text === null) { out.push({ file: e.file, op, status: '目标文件读不到' }); continue; }
    const idx = text.indexOf(e.from);
    if (idx < 0) { out.push({ file: e.file, op, status: '定位字面量找不到' }); continue; }
    if (text.indexOf(e.from, idx + 1) >= 0) { out.push({ file: e.file, op, status: '定位字面量重复', line: lineOfIndex(text, idx) }); continue; }
    out.push({ file: e.file, op, status: 'ok', line: lineOfIndex(text, idx), endLine: lineOfIndex(text, idx + e.from.length - (e.from.endsWith('\n') ? 1 : 0)) });
  }
  return out;
}
const fullOf = (name) => ROUTES_PREFIX + name;
// 每个编辑对删除清单的覆盖（74 HIGH-3：先核编辑自身的状态，再核是不是落在「明确属于第一步」的删除范围）：
//   synthetic（合成文件，整条豁免）/ bad（编辑状态未核实：目标读不到、字面量找不到 / 重复 / 取不到、路径已存在、操作未识别——整删文件也不例外，状态检查先于整删文件命中）/
//   whole（状态 ok、目标是整删文件）/ range（状态 ok、整个区间落在同一个删除段、且每个落入的删除段都有可推断的第一步提交）/
//   unowned（状态 ok、整个区间落在删除段里，但落入的段只含 INV（第二、三步，第一步不动）或「删什么」里没有可推断提交的关键词：归属不明确，不能当第一步的删除）/
//   cross（跨删除段边界）/ none（不在任何删除范围）。wholeFile：目标是整删文件（bad 的编辑也带，已知受影响提交仍取它的删除提交）。
function coverOf(del, edits) {
  const wholeFull = new Map(del.whole.map((n) => [fullOf(n), n]));
  const segFull = new Map();
  for (const [n, segs] of del.segments) segFull.set(fullOf(n), segs);
  const wholeCommits = (file) => (del.wholeCommit.get(wholeFull.get(file)) ? [del.wholeCommit.get(wholeFull.get(file))] : []);
  return edits.map((e) => {
    const wholeFile = wholeFull.has(e.file);
    if (e.status === 'synthetic') return { ...e, cover: 'synthetic', commits: [], segKnown: true, wholeFile: false };
    if (e.status !== 'ok') return { ...e, cover: 'bad', commits: wholeFile ? wholeCommits(e.file) : [], segKnown: false, wholeFile };
    if (wholeFile) return { ...e, cover: 'whole', commits: wholeCommits(e.file), segKnown: true, wholeFile };
    // 预筛 LOW-2：remove 的目标是 schema.js / index.js（3.3 里只有文字描述的两个文件）时与替换编辑同口径——schema.js → structural（C8，不推删），index.js → unowned；其余保留文件的 remove 仍是「删的是保留文件」（none）
    const isNoRangeFile = (e.file === fullOf('schema.js') || e.file === fullOf('index.js')) && (del.noRange || []).some((x) => fullOf(x.file) === e.file) && !(segFull.get(e.file) || []).length;
    if (e.op === 'remove' && !isNoRangeFile) return { ...e, cover: 'none', commits: [], segKnown: true, wholeFile: false }; // 删的是保留文件
    // 3.3 里这个文件只有文字描述、没有行区间：落点是否在删除范围内凭清单定不下来 → unowned（不当「不在删除范围」）
    // 主会话裁定（更正）：schema.js 在 C8 是「修改」（删表与保留约束混在同一文件），不是整段删除：状态 ok 的编辑只用来确定受影响提交 = C8（cover = structural），
    //   不得据此推出「只测停用（删）」（judgeMutation 判只测停用时不认它，等同于编辑未落在删除段），也不进「编辑未核实」；备注写「schema.js 修改，C8 逐条裁定」。index.js 的挂载按流程分到不同提交，维持 unowned 进人工
    if (!(segFull.get(e.file) || []).length && e.file === fullOf('schema.js') && (del.noRange || []).some((x) => x.file === 'schema.js')) return { ...e, cover: 'structural', commits: [8], segKnown: true, wholeFile: false };
    if ((del.noRange || []).some((x) => fullOf(x.file) === e.file) && !(segFull.get(e.file) || []).length) return { ...e, cover: 'unowned', why: '删除清单 3.3 对该文件的删除只有文字描述、没有行区间，编辑落点是否在删除范围内定不下来', commits: [], segKnown: false, wholeFile: false };
    const segs = segFull.get(e.file) || [];
    const inside = segs.filter((s) => e.line >= s.from && e.endLine <= s.to);
    if (inside.length) {
      // 混合区间：落入的删除段里有「删什么」块含保留类表述 / 非第一步标签 → 不当第一步的删除，进待裁定（commits 仍并入受影响提交，同 unowned）
      const mixedSegs = inside.filter((s) => s.mixed);
      if (mixedSegs.length && inside.every((s) => s.commits.length > 0)) return { ...e, cover: 'mixed', why: '落在含保留类表述 / 非第一步标签的混合删除段（清单 3.3 区间 ' + mixedSegs.map((s) => ':' + s.from + '–' + s.to + '「' + String(s.text).slice(0, 80) + '」：' + s.mixed).join('；') + '）', commits: uniqSorted([].concat(...inside.map((s) => s.commits))), segKnown: false, wholeFile: false };
      if (inside.every((s) => s.commits.length > 0)) return { ...e, cover: 'range', commits: uniqSorted([].concat(...inside.map((s) => s.commits))), segKnown: true, wholeFile: false };
      const only = inside.filter((s) => s.commits.length === 0);
      const why = only.every((s) => s.labels.length > 0 && s.labels.every((l) => !COMMIT_OF[l])) ? '落在只含 ' + Array.from(new Set([].concat(...only.map((s) => s.labels)))).join('、') + ' 的删除段（不在第一步）' : '落在没有可推断提交的删除段（「删什么」里没有关键词）';
      return { ...e, cover: 'unowned', why, commits: uniqSorted([].concat(...inside.map((s) => s.commits))), segKnown: false, wholeFile: false };
    }
    // 77 号 MEDIUM-8：跨界 / 重叠时，编辑区间与某个有可推断提交的删除段相交，那个段的删除提交就是已能独立确认的受影响提交（编辑改的行在被删区间里），照常汇总；
    //   完整覆盖仍要人工裁定（cross 仍是未核实）。unowned 同理：它已把落入的已归属段的提交放在 commits 里，汇总不再丢掉。
    const over = segs.filter((s) => e.line <= s.to && e.endLine >= s.from);
    return { ...e, cover: over.length ? 'cross' : 'none', commits: over.length ? uniqSorted([].concat(...over.map((s) => s.commits))) : [], segKnown: true, wholeFile: false };
  });
}
function judgeMutation(m, evs, del, edits) {
  const cov = coverOf(del, edits);
  const real = cov.filter((c) => c.cover !== 'synthetic'); // 合成文件的编辑整条豁免，不参与覆盖判断
  const inWhole = real.length > 0 && real.every((c) => c.cover === 'whole');
  const inRanges = real.length > 0 && real.every((c) => c.cover === 'range');
  const allCovered = real.length > 0 && real.every((c) => c.cover === 'whole' || c.cover === 'range');
  const unverified = real.filter((c) => c.cover === 'bad' || c.cover === 'cross' || c.cover === 'unowned');
  const mixed = real.filter((c) => c.cover === 'mixed'); // 混合区间只在判「只测停用」的变异上成为待裁定理由（verdict = 待裁定（混合区间））；守保留等其他判定下不另起未核实事项
  const labels = Array.from(new Set([].concat(...evs.map((e) => e.labels))));
  const onlyDelRow = (e) => e.labels.length > 0 && e.labels.every((x) => DELETABLE.includes(x));
  const delRows = evs.filter((e) => onlyDelRow(e) && allCovered);
  // 本表标题自身标明 C / 拿不准 / A 的守护小节行（origClass）不当明确守护证据（MED-1）
  const guardRows = evs.filter((e) => e.guard && !e.origClass);
  const classRows = evs.filter((e) => e.origClass);
  const keepRows = evs.filter((e) => (e.guard && !e.origClass) || e.labels.some((x) => KEEPISH.includes(x)));
  // L5：守护 / 保留证据与「只含可删标签」的证据并存，但编辑没全落删除段（不算只测停用证据）→ 不改判，只在备注里写冲突
  const softDel = evs.filter((e) => onlyDelRow(e) && !allCovered);
  const softConflict = keepRows.length && softDel.length && !delRows.length ? { keep: keepRows.map((e) => e.src), del: softDel.map((e) => e.src + '（只含可删标签：' + e.labels.join('+') + '）') } : null;
  let verdict;
  let conflict = null;
  if (keepRows.length && delRows.length) { verdict = '待裁定（证据冲突）'; conflict = { keep: keepRows.map((e) => e.src + (e.guard ? '（守护保留规则小节）' : '（标签含 KEEP / RPT）')), del: delRows.map((e) => e.src + '（只含可删标签：' + e.labels.join('+') + '）') }; } else if (guardRows.length) verdict = '守保留规则（改挂）';
  else if (classRows.length) verdict = '待裁定（原件 ' + (classRows.some((e) => e.origClass === 'C') ? 'C' : 'A') + ' 类）'; // 原件本表标题标明 C（拿不准）/ A：不凭守护小节改挂，交主会话裁定
  else if (evs.some((e) => e.ambiguous)) verdict = '待裁定（解析歧义）'; // 原件表格行列边界定不下来（inv-parse.js readCells）：不凭标签初判
  else if (evs.some((e) => e.unknown.length)) verdict = '待裁定（未知标签词）';
  else if (keepRows.length) verdict = '守保留规则（改挂）';
  else if (delRows.length) verdict = '只测停用（删）';
  else if (evs.some(onlyDelRow) && mixed.length) verdict = '待裁定（混合区间）'; // 编辑落在含保留类表述 / 非第一步标签的删除段：不推出删除（77 号 H2）
  else if (evs.some(onlyDelRow) && unverified.length) verdict = '待裁定（编辑未核实）'; // 标签只含可删标签，但编辑状态没核完 / 落在 INV 或归属不明的删除段：不判删，交主会话裁定
  else verdict = '待定';
  // 预筛 LOW-3：守护 / 保留证据与「编辑全落在整删文件 / 已归属删除段」并存、又没有只含可删标签的证据（那种情况是证据冲突）→ 初判仍按守护 / 保留，但备注写冲突（改挂的目标可能落在要删的代码里）
  const editConflict = keepRows.length && allCovered && !delRows.length ? { keep: keepRows.map((e) => e.src), where: real.map((c) => (c.file || '').split('/').pop() + (c.cover === 'whole' ? '（整删文件，提交 ' + cText(c.commits) + '）' : '（已归属删除段' + (c.line ? ' :' + c.line + (c.endLine && c.endLine !== c.line ? '–' + c.endLine : '') : '') + '，提交 ' + cText(c.commits) + '）')) } : null;
  return { verdict, labels, inWhole, inRanges, cov, unverified, mixed, conflict, softConflict, editConflict };
}
function loadMasterIds(repo) {
  const mc = require('./mutation-check');
  const rr = mc.run(repo, mc.ALL_GROUPS);
  if (rr.loadErrors.length) throw new Error('mutation-check 读取登记失败：' + rr.loadErrors.map((e) => e.group + ' ' + e.error).join('；'));
  const ids = mc.toIdList(rr.entries);
  // 全部编辑（op / file / from）：「锚点全落删除段」按每个编辑的完整覆盖区间核对
  rr.entries.forEach((e, i) => { ids[i].edits = e.edits.map((x) => ({ op: x.op, file: x.file, from: typeof x.from === 'string' ? x.from : null })); });
  return ids;
}

// ── 输入读取 ───────────────────────────────────────────────────────────────────────────
const OTHER_KEYWORD_RE = /变异|用例|场景|标题|断言/;
function loadInput(invDir, reg) {
  const names = fs.readdirSync(invDir).filter((f) => /^del-inv-tests-.*\.md$/.test(f)).sort();
  const hashes = [];
  const cases = [];
  const muts = [];
  let caseTables = 0;
  let mutTables = 0;
  const audits = [];
  const regProblems = [];
  const regStats = { filesWant: 0, filesGot: names.length, tablesWant: 0, tablesGot: 0, missing: 0, unregistered: 0, roleMismatch: 0, pathMismatch: 0 };
  if (reg) {
    regStats.filesWant = reg.files.length;
    for (const f of reg.files) if (!names.includes(f)) regProblems.push(`缺文件：期望的取证原件 ${f} 不在 ${invDir}`);
    // 目录全集与期望清单（含同批其他取证原件 siblings）对比：多出的任何文件（不止 del-inv-tests-*.md）都报
    const known = new Set(reg.files.concat(reg.siblings || []));
    for (const f of fs.readdirSync(invDir)) if (!known.has(f)) regProblems.push(`多出未登记的取证文件：${f}（目录里有、期望清单里没有）`);
    // 74 MEDIUM：不归本生成器读的其他取证原件（siblings）也要在、也要核摘要（九份输入在两个生成器里各核一遍）
    const dirFiles = new Set(fs.readdirSync(invDir));
    for (const f of reg.siblings || []) {
      if (!dirFiles.has(f)) { regProblems.push(`缺文件：期望的同批取证原件 ${f} 不在 ${invDir}`); continue; }
      if (reg.sha256) {
        if (!reg.sha256[f]) regProblems.push(`同批取证原件 ${f} 没有登记 sha256`);
        else if (reg.sha256[f] !== P.sha256(path.join(invDir, f))) regProblems.push(`同批取证原件 ${f} 的 sha256 与登记不符（登记 ${reg.sha256[f].slice(0, 12)}…，实际 ${P.sha12(path.join(invDir, f))}…；原件被改动过？）`);
      }
    }
    regStats.tablesWant = reg.tables.length;
  }
  for (const f of names) {
    const abs = path.join(invDir, f);
    hashes.push(f + ' ' + P.sha12(abs));
    // 冻结证据：登记了 sha256 的原件逐个核对
    if (reg && reg.files.includes(f) && reg.sha256) {
      if (!reg.sha256[f]) regProblems.push(`取证原件 ${f} 没有登记 sha256`);
      else if (reg.sha256[f] !== P.sha256(abs)) regProblems.push(`取证原件 ${f} 的 sha256 与登记不符（登记 ${reg.sha256[f].slice(0, 12)}…，实际 ${P.sha12(abs)}…；原件被改动过？）`);
    }
    const text = P.readText(abs);
    const tables = P.parseTables(text, DISP_PARSE);
    regStats.tablesGot += tables.length;
    const reasonOf = new Map();
    if (reg && reg.files.includes(f)) {
      const rec = P.reconcile(f, tables, reg.tables);
      for (const t of rec.unregistered) { regStats.unregistered += 1; regProblems.push(`多出未登记的表：${P.shortTable(f, t)}`); }
      for (const e of rec.missing) { regStats.missing += 1; regProblems.push(`缺表：登记的表在原件里没找到：${P.shortEntry(e)}`); }
      for (const m of rec.matched) {
        const role = roleOf(m.table);
        if (m.entry[3] !== role) { regStats.roleMismatch += 1; regProblems.push(`表角色不符：${P.shortTable(f, m.table)} 登记为 ${m.entry[3]}，按表头判为 ${role}`); }
        reasonOf.set(m.table, m.entry[4]);
      }
      for (const mm of rec.mismatched) { regStats.pathMismatch += 1; regProblems.push(`表归属错配：${P.shortTable(f, mm.table)}：${mm.why}`); }
    } else if (reg) {
      // 不在期望文件里的取证原件：它的每张表都是「多出未登记的表」
      for (const t of tables) { regStats.unregistered += 1; regProblems.push(`多出未登记的表：${P.shortTable(f, t)}（文件 ${f} 不在期望文件里）`); }
    }
    const caseTs = tables.filter((t) => roleOf(t) === 'case');
    const mutTs = tables.filter((t) => roleOf(t) === 'mut');
    const cr = caseRows(f, caseTs);
    cases.push(...cr);
    caseTables += caseTs.length;
    const mr = mutRows(f, mutTs);
    muts.push(...mr);
    mutTables += mutTs.length;
    // 原文里围栏之外每一个以 | 开头的非分隔行（H2）：必须落在某张已解析表上；按类别记：用例表 / 变异表 / 明确排除的其他表（既没有用例名 + 行号 + 被测或类别列、也没有变异名列的表）
    const audit = P.auditPipeLines(text, tables);
    const cat = { caseT: 0, mutT: 0, other: 0 };
    const suspectOther = []; // 被排除的「其他表」里表头含「变异」「用例」「场景」「标题」「断言」任一词、又没有登记理由的（视为表被误排除，反向校验报问题）
    const whitelisted = [];
    const others = []; // 全部「其他表」（逐张列出理由）
    const crossedBlank = [];
    for (const t of tables) {
      const n = 1 + t.rows.length; // 表头行 + 数据行
      const role = roleOf(t);
      if (role === 'case') cat.caseT += n; else if (role === 'mut') cat.mutT += n; else {
        cat.other += n;
        others.push({ key: f + ':' + t.headerLine, heading: t.heading, header: P.normHeader(t.header), rows: t.rows.length, reason: reasonOf.get(t) || '' });
        if (OTHER_KEYWORD_RE.test(t.header.join(' '))) {
          const id = f + ':' + t.headerLine + '（标题「' + t.heading + '」；表头「' + P.normHeader(t.header) + '」）';
          const reason = reasonOf.get(t);
          if (reason) whitelisted.push({ key: f + ':' + t.headerLine, header: t.header.join(' | '), reason }); else suspectOther.push(id);
        }
      }
      for (const r of t.rows) if (r.crossedBlank) crossedBlank.push(f + ':' + r.line + '–' + r.endLine);
    }
    audits.push({ file: f, total: audit.total, uncovered: audit.uncovered, parsedEmpty: audit.parsedEmpty, contPipe: audit.contPipe, unclosedFence: audit.unclosedFence, deepFenceAroundTable: audit.deepFenceAroundTable, suspectOther, whitelisted, others, crossedBlank, ...cat, continuation: tables.reduce((a, t) => a + t.rows.filter((r) => r.endLine !== r.line).length, 0), mutRows: mr.length, caseRows: cr.length, ambiguousRows: [...cr, ...mr].filter((r) => r.ambiguous).length });
  }
  if (reg) {
    for (const f of reg.files) {
      if (names.includes(f)) continue;
      const n = reg.tables.filter((e) => e[0] === f).length;
      if (n) { regStats.missing += n; regProblems.push(`缺表：文件 ${f} 不存在，登记在它名下的 ${n} 张表都没有核对`); }
    }
  }
  return { names, hashes, cases, muts, caseTables, mutTables, audits, regProblems, regStats, registryChecked: !!reg };
}
function requireQuiet(file) {
  const saved = process.argv;
  process.argv = [saved[0], file];
  try { return require(file); } finally { process.argv = saved; }
}
// 静态扫描出的名字（字符串或 { pattern: [片段 | null…] }）是否等于这个真实用例名
const scannedNameIs = (x, real) => (typeof x === 'string' ? x === real : !!(x && Array.isArray(x.pattern) && new RegExp('^' + x.pattern.map((f) => (f === null ? '[\\s\\S]*' : String(f).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$').test(real)));
// 名单读取：一组读到一半出错就整组放弃（不留部分名单），记 xxxError。每项 { name, files }（74 HIGH-5：带定义文件）：
//   api = lib/sysbuild-api-suite.js 的 listCaseNames()（只有名字，拿不到定义文件）+ 对 lib/sysbuild-api-suite*.js 逐个静态扫描 test( 的首参，哪个文件的扫描结果里有这个名字，files 就带哪个文件
//   （在多个文件里都有则全带；一个文件都没扫到的 files = []，归属不明，匹配时只算候选、不用于确认「不受影响」）；单个文件扫描失败记 apiScanError，该文件里的用例因此可能 files = []；
//   browser = 五个浏览器场景文件各自的 [名字, 函数] 数组静态扫描（每项 files = [所在文件]）；schema = CASE_NAMES（files = [verify-sysbuild-schema.js]）。
function loadRealNames(repo) {
  const mc = require('./mutation-check');
  const names = { api: null, browser: null, schema: null };
  try {
    const real = requireQuiet(path.join(repo, 'wbs-server/scripts/lib/sysbuild-api-suite.js')).listCaseNames();
    const libDir = path.join(repo, 'wbs-server/scripts/lib');
    const files = fs.readdirSync(libDir).filter((f) => /^sysbuild-api-suite(-[a-z0-9-]+)?\.js$/.test(f)).sort();
    const scanned = new Map();
    const scanErrors = [];
    for (const f of files) { try { scanned.set(f, mc.scanCaseNames(fs.readFileSync(path.join(libDir, f), 'utf8'), { callName: 'test' })); } catch (e) { scanErrors.push(f + '：' + e.message); } }
    names.api = real.map((n) => ({ name: n, files: files.filter((f) => (scanned.get(f) || []).some((x) => scannedNameIs(x, n))) }));
    if (scanErrors.length) names.apiScanError = scanErrors.join('；');
  } catch (e) { names.apiError = e.message; }
  try {
    const files = ['sysbuild-browser-suite.js', 'sysbuild-browser-stage8.js', 'sysbuild-browser-trace-setup.js', 'sysbuild-browser-trace-forms.js', 'sysbuild-browser-trace-confirm.js'];
    const all = [];
    for (const f of files) all.push(...mc.scanCaseNames(fs.readFileSync(path.join(repo, 'wbs-server/scripts/lib', f), 'utf8'), { pairs: true }).filter((x) => typeof x === 'string').map((n) => ({ name: n, files: [f] })));
    names.browser = all;
  } catch (e) { names.browserError = e.message; }
  try { names.schema = requireQuiet(path.join(repo, 'wbs-server/scripts/verify-sysbuild-schema.js')).CASE_NAMES.map((n) => ({ name: n, files: ['verify-sysbuild-schema.js'] })); } catch (e) { names.schemaError = e.message; }
  return names;
}

// ── 生成 ───────────────────────────────────────────────────────────────────────────────
const mid = (i) => 'M' + String(i + 1).padStart(4, '0');
function build(input, master, namesIn, del, repo) {
  const names = { ...namesIn, api: normNameList(namesIn.api), browser: normNameList(namesIn.browser), schema: normNameList(namesIn.schema) }; // 名单项归一一次，后面按项的身份（不是按名字文本）对账
  const caseRowsOut = input.cases.map((r) => {
    const j = judgeCase(r);
    return { ...r, ...j, match: matchCase(r.file, r.name, names) };
  });
  // 真实用例（名单项）→ 原件用例行（承接用例反查：变异的 expect 对得上哪些名单项，哪些原件行承接它；74 HIGH-5：原件行只在自己文件定义的用例里找承接）
  const hostPool = { api: [], browser: [], schema: [] };
  for (const c of caseRowsOut) {
    const k = nameKindOf(c.file);
    if (k && (c.match.status === '对上' || c.match.status === '仅包含匹配')) hostPool[k].push({ entry: c.match.entries[0], real: normName(c.match.hits[0]), row: c });
  }
  // 原件变异表按 id 建索引；原件行的组由套件文件名定（取不出为 ''）
  const byId = new Map();
  for (const r of input.muts) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
  const claims = new Map(); // 原件行（位置 + id）→ [主表键…]
  const cache = new Map();
  // 第一遍：精确匹配（同组或组未定的同 id 原件行）
  const pre = master.map((m) => {
    const key = m.group + '\u0001' + normName(m.id);
    const cands = byId.get(normName(m.id)) || [];
    const evs = cands.filter((c) => c.group === m.group || c.group === '');
    const otherGroup = cands.filter((c) => !(c.group === m.group || c.group === ''));
    for (const e of evs) { const k = e.src + '\u0001' + e.id; if (!claims.has(k)) claims.set(k, []); claims.get(k).push(key); }
    return { key, evs, otherGroup, fuzzy: [], fuzzyCands: [] };
  });
  // 第二遍：对没有精确证据的主表变异，在「同组、还没被精确匹配用掉」的原件行里做受控模糊匹配（HIGH-2）。
  //   74 HIGH-6：必须原件行的「目标源文件」与主表变异的目标文件一致（没有目标源文件列的表取表标题点名的文件）才算候选；原件没有目标依据、或目标不一致的，保留为候选列「人工挂接」（5.2b），不自动挂；
  //   组未定（group = ''）的原件行不参与模糊匹配（它能和任何组匹配，单一候选也可能是误挂），同样列人工挂接。
  //   主表一侧：候选的原件 id 只有 1 个才算匹配；原件一侧（按原件位置 + 组计，不按 id 文字）：这一行只被 1 条主表变异模糊命中才算匹配；否则都不匹配，只把候选写进备注。
  const free = input.muts.filter((r) => !claims.has(r.src + '\u0001' + r.id) && !r.placeholder);
  const rowKey = (r) => r.src + '\u0001' + r.group;
  const baseOf = (f) => String(f).split('/').pop();
  const targetsOf = (r) => r.targets || [];
  const targetAgrees = (r, m) => { const mb = (m.files || []).map(baseOf); return targetsOf(r).length > 0 && targetsOf(r).some((t) => mb.includes(t)); };
  const manualFuzzy = []; // { no, id, src, origId, why }：不自动挂接、列人工挂接的模糊候选
  const fz = pre.map((p, i) => {
    if (p.evs.length) return null;
    const m = master[i];
    const sameGroup = free.filter((r) => r.group !== '' && r.group === m.group && fuzzyHow(normName(m.id), r.id));
    for (const r of free.filter((x) => x.group === '' && fuzzyHow(normName(m.id), x.id))) manualFuzzy.push({ no: mid(i), id: m.id, src: r.src, origId: r.id, why: '原件行的组未定，不参与自动模糊匹配' });
    for (const r of sameGroup.filter((x) => !targetAgrees(x, m))) manualFuzzy.push({ no: mid(i), id: m.id, src: r.src, origId: r.id, why: targetsOf(r).length ? '原件目标文件（' + targetsOf(r).join('、') + '）与主表目标文件（' + ((m.files || []).map(baseOf).join('、') || '无') + '）不一致' : '原件没有目标文件依据' });
    const hit = sameGroup.filter((r) => targetAgrees(r, m));
    const ids = Array.from(new Set(hit.map((r) => r.id)));
    return { hit, ids };
  });
  const masterOfOrig = new Map(); // 原件位置 + 组 → 模糊命中它的主表变异下标集合
  fz.forEach((f, i) => { if (f) for (const r of f.hit) { const k = rowKey(r); if (!masterOfOrig.has(k)) masterOfOrig.set(k, new Set()); masterOfOrig.get(k).add(i); } });
  const fuzzyPairs = [];
  fz.forEach((f, i) => {
    if (!f || !f.ids.length) return;
    if (f.ids.length === 1 && f.hit.every((r) => masterOfOrig.get(rowKey(r)).size === 1)) {
      pre[i].fuzzy = f.hit.map((r) => ({ ...r, fuzzy: fuzzyHow(normName(master[i].id), r.id) }));
      pre[i].evs = pre[i].fuzzy;
      for (const r of f.hit) { const k = r.src + '\u0001' + r.id; if (!claims.has(k)) claims.set(k, []); claims.get(k).push(pre[i].key); fuzzyPairs.push({ no: mid(i), id: master[i].id, src: r.src, origId: r.id, how: fuzzyHow(normName(master[i].id), r.id), origTargets: targetsOf(r), masterTargets: (master[i].files || []).map(baseOf) }); }
    } else pre[i].fuzzyCands = f.hit.map((r) => r.src + '「' + r.id.slice(0, 30) + '」');
  });
  const mutOut = master.map((m, i) => {
    const key = pre[i].key;
    const { evs, otherGroup } = pre[i];
    const edits = editsOf(repo, m, cache);
    const j = judgeMutation(m, evs, del, edits);
    // 全部受影响提交 = 已知受影响提交（下面四个来源的并集）；未核完的事项另记在 open 里，不混进这个并集（74 HIGH-4：「已有受影响提交」不再抢在未核完事项之前把变异标成已分派）
    const fromLabels = uniqSorted([].concat(...j.labels.filter((x) => DELETABLE.includes(x)).map((x) => [COMMIT_OF[x]])));
    const fromFiles = uniqSorted([].concat(...j.cov.filter((c) => c.wholeFile && (c.cover === 'whole' || c.cover === 'bad')).map((c) => c.commits))); // 目标是整删文件：删除提交（编辑状态没核实也带，另记未核实）
    const fromSegs = uniqSorted([].concat(...j.cov.filter((c) => c.cover === 'range' || c.cover === 'structural' || c.cover === 'unowned' || c.cover === 'cross' || c.cover === 'mixed').map((c) => c.commits)));
    const expects = Array.isArray(m.expect) ? m.expect.map(normName).filter(Boolean) : [];
    // HIGH-1：expect 在真实名单里命中的全部真实用例（名单项），每个都要有承接行；缺的算「未对上原件行」。名单读不出来时无法核，也不判不受影响
    const kind = ['api', 'browser', 'schema'].includes(m.group) ? m.group : null;
    const realList = kind && names[kind] ? names[kind] : null;
    const realHit = realList ? realList.filter((e) => (kind === 'browser' ? expects.includes(normName(e.name)) : expects.some((x) => normName(e.name).startsWith(x)))) : [];
    // 承接用例 = 原件里与这些真实用例对上的用例行（按名单项的身份对，不按名字文本：另一个文件里同前缀的用例不算）
    const hosts = (hostPool[m.group] || []).filter((h) => realHit.includes(h.entry));
    const fromHosts = uniqSorted([].concat(...hosts.map((h) => h.row.affected)));
    const affected = uniqSorted(fromLabels.concat(fromFiles, fromSegs, fromHosts));
    const labelsStayOnly = j.labels.length > 0 && j.labels.every((x) => STAY.includes(x));
    const hostEntries = new Set(hosts.map((h) => h.entry));
    const hostK = realHit.filter((e) => !hostEntries.has(e)).length; // 真实用例命中了、却没有承接行的个数
    const hostM = realHit.length;
    const namesFail = !!kind && !realList && expects.length > 0;
    const hostPartial = hosts.some((h) => h.row.match.status === '仅包含匹配');
    const hostUnconfirmed = hosts.some((h) => !h.row.match.fileOk); // 承接行与真实用例的定义文件没有对上 / 归属不明：不用于确认「不受影响」（HIGH-5）
    const hostsPending = hosts.filter((h) => caseAssign(h.row) === 'unassigned');
    const hostsAllUnaffected = hosts.length > 0 && hosts.every((h) => caseAssign(h.row) === 'unaffected');
    // 未核完事项（来源分类 + 原因）：有任何一项，变异同时列入待分派，即使已有已知受影响提交
    const open = [];
    if (j.verdict.startsWith('待裁定')) open.push({ k: '初判待裁定', t: '初判「' + j.verdict + '」，证据定不下来' });
    if (j.unverified.length) open.push({ k: '未核实编辑', t: '含未核实编辑 / 归属不明的删除段（' + j.unverified.map((u) => (u.file || '').split('/').pop() + ' ' + (u.cover === 'cross' ? '跨删除段边界' : (u.cover === 'unowned' ? u.why : u.status))).join('、') + '）' });
    if (j.verdict === '待裁定（混合区间）') open.push({ k: '混合区间', t: '编辑落在含保留类表述 / 非第一步标签的删除段，不推出删除：' + j.mixed.map((u) => (u.file || '').split('/').pop() + ' ' + u.why).join('、') });
    if (hostsPending.length) open.push({ k: '承接用例待分派', t: '承接它的用例自己还待分派：' + hostsPending.slice(0, 3).map((h) => h.row.src).join('、') });
    const gaps = [hostK > 0 ? '承接用例 ' + hostK + '/' + hostM + ' 个未对上原件行' : '', hostPartial ? '承接用例里含「仅包含匹配」（用例名没有精确对上）' : '', hostUnconfirmed ? '承接用例的定义文件没有确认（真实用例所在文件与原件行所在文件对不上或归属不明）' : '', namesFail ? '真实用例名单读取失败，无法核承接用例' : ''].filter(Boolean);
    if (gaps.length) open.push({ k: '承接覆盖不足', t: gaps.join('；') });
    let assign;
    let pendingWhy = '';
    if (open.length) {
      assign = 'unassigned';
      pendingWhy = open.map((o) => o.t).join('；') + (affected.length ? '（已有受影响提交 ' + cText(affected) + '，仍须先核完；裁定后要据结果重建受影响提交）' : (hostsAllUnaffected ? '，不判不受影响' : ''));
    } else if (affected.length) assign = 'assigned';
    else if (hostsAllUnaffected) assign = 'unaffected';
    else if (labelsStayOnly && hosts.length === 0) { assign = 'unassigned'; pendingWhy = '仅凭标签、未找到承接用例（原件标签全是保留类标签，但 expect 对不上任何已对上真实名的用例行，无法核承接用例是否受影响）'; } else { assign = 'unassigned'; pendingWhy = evs.length === 0 ? '原件无证据、也没有承接用例、目标文件不在删除清单里' : '没有可删标签、目标不在删除清单里、也找不到承接用例'; }
    return { no: mid(i), group: m.group, id: m.id, files: m.files || [], expect: m.expect, evs, nEv: evs.length, otherGroup, fuzzyCands: pre[i].fuzzyCands, ...j, affected, assign, pendingWhy, open, hosts: hosts.length, hostK, hostM, sources: { labels: fromLabels, files: fromFiles, segs: fromSegs, hosts: fromHosts } };
  });
  // 原件变异表里没被主表用作证据的行
  const unmatchedOrig = input.muts.filter((r) => !claims.has(r.src + '\u0001' + r.id));
  // 出自守护保留规则小节、仍对不上主表的原件行（占位行除外）：待人工挂接，反向校验判问题
  const guardUnmatched = unmatchedOrig.filter((r) => r.guard && !r.placeholder);
  // 重复归属：同一原件行被两条以上不同的（组, id）当证据 = 问题；同一（组, id）重复 = 警告
  const dupClaims = [];
  for (const [k, ms] of claims) {
    const distinct = Array.from(new Set(ms));
    if (distinct.length > 1) dupClaims.push({ key: k, keys: distinct, same: false });
    else if (ms.length > 1) dupClaims.push({ key: k, keys: distinct, same: true });
  }
  return { caseRowsOut, mutOut, unmatchedOrig, dupClaims, guardUnmatched, fuzzyPairs, manualFuzzy };
}
const expectText = (e) => (Array.isArray(e) ? e.join(' ｜ ') : '');
const assignText = (affected, assign) => (affected.length ? cText(affected) : (assign === 'unaffected' ? '不受影响' : '待分派'));
// 明细表「受影响提交」列：已知受影响提交；另有未核完事项（待分派）的同时带标记，复核人不会只看到提交、漏看待分派（74 HIGH-4）
const assignCell = (affected, assign) => assignText(affected, assign) + (assign === 'unassigned' && affected.length ? '（另有未核完事项，见第七节）' : '');
// 77 号 MEDIUM-10：歧义行的原文完整输出（不压平空白、不截断；单元格里的换行才改成空格，物理行范围另写）
const clipRaw = (s) => String(s || '').replace(/\r?\n/g, ' ');
// 第七节 7.1 的「原因」列（渲染与回读共用）
const reason71 = (r) => (r.verdict.startsWith('待裁定') ? (r.affected.length ? '初判待裁定（已有受影响提交 ' + cText(r.affected) + '，仍须先裁定）' : '标签读不出 / 定不下来，没有可用的提交') + (r.ambiguous ? '；解析歧义：' + ambNote(r) : '') : '没有任何可删标签（无被测 / 搭数据标签可用）');
const ambNote = (e) => e.src + '（物理行 ' + e.lineRange + '；' + e.ambReason + '；原文：' + clipRaw(e.rawLine) + (e.candText ? '；候选读法：' + e.candText : '') + '）';
// 初判以「待裁定」开头的一律算待分派（即使已有受影响提交，也要先裁定；MED-3）
function caseAssign(r) { if (r.verdict.startsWith('待裁定')) return 'unassigned'; return r.affected.length ? 'assigned' : ((r.verdict === '不受影响' || r.verdict === '第一步不动') ? 'unaffected' : 'unassigned'); }
function render(g, input, meta, del) {
  const L = [];
  const cs = g.caseRowsOut;
  const ms = g.mutOut;
  L.push('# #212 第一步测试去向表（初稿骨架，机械初判）');
  L.push('');
  L.push('> 生成器 `wbs-server/scripts/sysbuild-step1/build-test-disposition.js`；机械初判只是初稿，「受影响的保留断言」「去向」「等价依据」「首次可运行的提交」四列留空待主会话填。');
  L.push(`> 生成时刻：${meta.generatedAt}；仓库 HEAD：${meta.head || '（取不到）'}`);
  L.push('> 输入文件 sha256 前 12 位：' + input.hashes.join('；'));
  L.push('');
  L.push('## 一、汇总');
  L.push('');
  L.push(`用例：原件 ${input.caseTables} 张用例表、共 ${cs.length} 行；变异：主表 ${ms.length} 条，原件 ${input.mutTables} 张变异表、共 ${input.muts.length} 行。`);
  L.push('');
  L.push('### 1.1 用例按机械初判');
  L.push('');
  L.push('| 初判 | 行数 |');
  L.push('|---|---|');
  const verdicts = ['整删', '要拆', '要拆（跨提交）', '保留但需改夹具', '不受影响', '第一步不动', '第一步不动但需改夹具', '待裁定', '待裁定（解析歧义）', '待裁定（未知标签词）'];
  for (const v of verdicts) L.push(`| ${v} | ${cs.filter((r) => r.verdict === v).length} |`);
  L.push('');
  L.push('### 1.2 用例按提交（所属提交 = 最早要动手的提交；受影响 = 被测行为删除提交 ∪ 夹具失效提交，含该提交即计）');
  L.push('');
  L.push('| 提交 | 所属提交的行数 | 其中整删 | 其中要拆 | 其中要拆（跨提交） | 其中保留但需改夹具 | 其中第一步不动但需改夹具 | 全部受影响的行数 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const n of COMMITS) {
    const rs = cs.filter((r) => r.owner === n);
    L.push(`| C${n} | ${rs.length} | ${rs.filter((r) => r.verdict === '整删').length} | ${rs.filter((r) => r.verdict === '要拆').length} | ${rs.filter((r) => r.verdict === '要拆（跨提交）').length} | ${rs.filter((r) => r.verdict === '保留但需改夹具').length} | ${rs.filter((r) => r.verdict === '第一步不动但需改夹具').length} | ${cs.filter((r) => r.affected.includes(n)).length} |`);
  }
  L.push(`| （无提交） | ${cs.filter((r) => r.owner === null).length} | | | | | | |`);
  L.push('');
  L.push('### 1.3 用例名与真实套件对账');
  L.push('');
  L.push('| 结果 | 行数 |');
  L.push('|---|---|');
  for (const s of ['对上', '仅包含匹配', '匹配多个', '对不上', '无名单', '未对账']) L.push(`| ${s} | ${cs.filter((r) => r.match.status === s).length} |`);
  L.push(`| 其中「对上 / 仅包含匹配」但定义文件没有确认（不用于确认变异「不受影响」） | ${cs.filter((r) => (r.match.status === '对上' || r.match.status === '仅包含匹配') && !r.match.fileOk).length} |`);
  L.push('');
  L.push('对账按「原件行所在套件文件」限定真实用例（真实名单带定义文件）：同文件里找不到才退到定义文件不明的候选，那种命中只算候选。');
  L.push('');
  const mverd = MVERDICTS;
  L.push('### 1.4 变异按组与机械初判');
  L.push('');
  L.push('| 组 | 合计 | ' + mverd.join(' | ') + ' | 其中原件无 |');
  L.push('|---|---|' + mverd.map(() => '---').join('|') + '|---|');
  const groups = Array.from(new Set(ms.map((m) => m.group)));
  for (const gr of groups) {
    const xs = ms.filter((m) => m.group === gr);
    L.push(`| ${gr} | ${xs.length} | ${mverd.map((v) => xs.filter((m) => m.verdict === v).length).join(' | ')} | ${xs.filter((m) => m.nEv === 0).length} |`);
  }
  L.push(`| 合计 | ${ms.length} | ${mverd.map((v) => ms.filter((m) => m.verdict === v).length).join(' | ')} | ${ms.filter((m) => m.nEv === 0).length} |`);
  L.push('');
  L.push('### 1.5 变异与用例的提交分派');
  L.push('');
  L.push('| 提交 | 受影响的变异数 | 受影响的用例数 |');
  L.push('|---|---|---|');
  for (const n of COMMITS) L.push(`| C${n} | ${ms.filter((m) => m.affected.includes(n)).length} | ${cs.filter((r) => r.affected.includes(n)).length} |`);
  L.push(`| 不受影响 | ${ms.filter((m) => m.assign === 'unaffected').length} | ${cs.filter((r) => caseAssign(r) === 'unaffected').length} |`);
  L.push(`| 其中待分派（变异：仅凭标签、未找到承接用例） | ${ms.filter((m) => m.assign === 'unassigned' && /^仅凭标签、未找到承接用例/.test(m.pendingWhy)).length} | |`);
  L.push(`| 待分派 | ${ms.filter((m) => m.assign === 'unassigned').length} | ${cs.filter((r) => caseAssign(r) === 'unassigned').length} |`);
  L.push(`| 其中已有已知受影响提交、但另有未核完事项（同时在对应提交的取行里与第七节出现） | ${ms.filter((m) => m.assign === 'unassigned' && m.affected.length > 0).length} | ${cs.filter((r) => caseAssign(r) === 'unassigned' && r.affected.length > 0).length} |`);
  L.push('');
  L.push('「已知受影响提交」与「未核完事项」分开记（74 HIGH-4）：变异的已知受影响提交 = 标签 ∪ 整删文件 ∪ 删除段（整条编辑状态 ok、落在有可推断提交的段里）∪ 承接用例；未核完事项 = 初判待裁定、未核实编辑、归属不明的删除段（只含 INV 或没有关键词）、承接用例待分派、承接覆盖不足（含文件归属没确认）。有未核完事项的变异即使已有受影响提交也列入待分派并标来源，裁定后须据结果重建受影响提交。');
  L.push('');
  L.push(`原件变异行重复归属：${g.dupClaims.filter((d) => !d.same).length} 处（问题）、${g.dupClaims.filter((d) => d.same).length} 处（同一组 + id 在主表里重复，警告）；证据冲突 ${ms.filter((m) => m.verdict === '待裁定（证据冲突）').length} 条；组未定的原件变异行 ${input.muts.filter((r) => r.group === '').length} 行。`);
  L.push('');
  L.push(`删除清单 3.1 整删后端文件：${del.whole.join('、') || '（无）'}；3.3 逐段删的文件里抽出行区间的有 ${del.rangeFiles.length} 个（区间 ${del.rangeCount} 段）；只有文字描述、没有行区间的登记记录 ${(del.noRange || []).length} 个（${(del.noRange || []).map((x) => x.file).join('、') || '无'}；schema.js 编辑按 structural 计 C8、index.js 按 unowned 进人工）。删除段所属提交按「删什么」里的关键词推断，仅供参考。`);
  L.push('');
  L.push('已知局限（codex 77 号 HIGH-3，主会话 2026-11-20 接受）：真实用例名单里有一部分用例名只靠 `test(` 首参的模板通配命中定义文件（2026-11-19 冻结数据的实测：api 名 485 个，其中 265 个只靠模板通配、220 个字面量等值命中；每个名字恰好命中一个文件、没有命中多个、没有扫描失败）。定义文件依据的强度是「静态片段恰好命中一次」，不是字面量等值；该数写在这里供读者知悉，不随输入重算。');
  L.push('');
  L.push('混合区间（codex 77 号 HIGH-2，主会话 2026-11-20 裁定）：编辑所落删除区间的「删什么」块含保留类表述（保留 / 不删 / 不动 / 第二步 / 第三步 / INV / SETUP / KEEP）或推出非第一步标签（INV）时，不推出「只测停用（删）」，初判「待裁定（混合区间）」并进待分派，原因里写区间原文位置；块内只有第一步可删标签的（可以多个，如 ENT+MLT）照旧。');
  L.push('');
  L.push('## 二、用例（按原件文件）');
  L.push('');
  const byFile = new Map();
  for (const r of cs) { const k = r.file || '(无文件标题)'; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(r); }
  for (const f of Array.from(byFile.keys()).sort()) {
    const rs = byFile.get(f);
    L.push(`### ${f}（${rs.length} 行）`);
    L.push('');
    L.push('| 原件位置 | 用例名 | 文件 | 行号范围 | 被测标签 | 搭数据标签 | 原件分类 | 机械初判 | 被测行为删除提交 | 夹具最早失效提交 | 所属提交 | 全部受影响提交 | 真实用例名匹配 | 受影响的保留断言 | 去向 | 等价依据 | 首次可运行的提交 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rs) {
      const mt = r.match.status + (r.match.hits.length === 1 ? '：' + r.match.hits[0] : (r.match.hits.length > 1 ? '：' + r.match.hits.length + ' 个' : ''));
      L.push(`| ${esc(r.src)} | ${esc(r.name)} | ${esc(r.file)} | ${esc(r.lines)} | ${esc(r.testedText)} | ${esc(r.setupText)} | ${esc(r.origCat)} | ${r.verdict} | ${cText(r.beh)} | ${r.fxMin === null ? '' : 'C' + r.fxMin} | ${r.commit} | ${assignCell(r.affected, caseAssign(r))} | ${esc(mt)} | | | | |`);
    }
    L.push('');
  }
  const bad = cs.filter((r) => ['对不上', '匹配多个', '未对账'].includes(r.match.status));
  L.push('## 三、用例名与真实套件对不上、匹配多个或未对账的行');
  L.push('');
  L.push(`共 ${bad.length} 行。`);
  L.push('');
  L.push('| 原件位置 | 文件 | 用例名 | 结果 | 候选（至多 5 个） |');
  L.push('|---|---|---|---|---|');
  for (const r of bad) L.push(`| ${esc(r.src)} | ${esc(r.file)} | ${esc(r.name)} | ${r.match.status} | ${esc(r.match.hits.slice(0, 5).join(' ｜ '))} |`);
  L.push('');
  const review = cs.filter((r) => (r.match.status === '仅包含匹配' || r.match.status === '无名单') && r.affected.length > 0);
  L.push('### 3.1 需人工复核的对账行（「仅包含匹配」与「无名单」里有受影响提交的行）');
  L.push('');
  L.push(`共 ${review.length} 行。「仅包含匹配」只证明用例名被某个真实名包含；「无名单」没有可对的名单（verify-sysbuild-e2e.js 等）。对账已按原件行所在套件文件限定真实用例（真实名单带定义文件）；定义文件没有确认的命中见 1.3 的专列。`);
  L.push('');
  L.push('| 原件位置 | 文件 | 用例名 | 结果 | 全部受影响提交 |');
  L.push('|---|---|---|---|---|');
  for (const r of review) L.push(`| ${esc(r.src)} | ${esc(r.file)} | ${esc(r.name)} | ${r.match.status} | ${cText(r.affected)} |`);
  L.push('');
  L.push('## 四、变异（主表 = mutation-check 全量清单）');
  L.push('');
  L.push('列：编号 = 主表登记顺序 M0001…；原件标签与来源取自取证原件里匹配的全部变异行（多个用「；」分开）；「锚点行」是每个 replace 编辑的定位字面量在目标文件里的起止行（多个编辑用「、」分开，重复 / 找不到标 ?）；受影响提交见头注释；「去向」等两列留空。');
  L.push('');
  for (const gr of groups) {
    const xs = ms.filter((m) => m.group === gr);
    L.push(`### ${gr}（${xs.length} 条）`);
    L.push('');
    L.push('| 组 | id | 编号 | 目标文件 | 所属用例 | 原件流程标签 | 原件来源 | 锚点行 | 机械初判 | 受影响提交 | 备注 | 去向 | 等价依据 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const m of xs) {
      const notes = [];
      if (m.nEv === 0) notes.push('原件无');
      if (m.nEv > 1) notes.push(`原件里同 id 出现 ${m.nEv} 次（证据已汇总）`);
      if (m.evs.some((e) => e.group === '')) notes.push('含组未定的原件行');
      if (m.otherGroup.length) notes.push('同 id 在其他组：' + Array.from(new Set(m.otherGroup.map((e) => e.group || '?'))).join('、') + '（不算证据）');
      if (m.inWhole) notes.push('目标文件全属整删文件');
      if (m.inRanges) notes.push('编辑全落在删除段');
      if (m.unverified.length) notes.push('未核实编辑：' + m.unverified.map((u) => (u.file || '').split('/').pop() + ' ' + (u.cover === 'cross' ? '跨删除段边界' : (u.cover === 'unowned' ? u.why : u.status))).join('、'));
      if (m.verdict === '待裁定（混合区间）') notes.push('混合区间：' + m.mixed.map((u) => (u.file || '').split('/').pop() + ' ' + u.why).join('、'));
      if (m.cov.some((c) => c.cover === 'structural')) notes.push('schema.js 修改，C8 逐条裁定（库结构在 C8 改：删表与保留约束混在同一文件，编辑只用来确定受影响提交，不据此判只测停用）');
      if (m.cov.some((c) => c.cover === 'synthetic')) notes.push('含合成文件编辑 ' + m.cov.filter((c) => c.cover === 'synthetic').length + ' 个（驱动新建仓库里不存在的文件，整条豁免）');
      if (m.conflict) notes.push('证据冲突：守护 / 保留方 ' + m.conflict.keep.join('、') + '；只测停用方 ' + m.conflict.del.join('、'));
      if (m.evs.some((e) => e.ambiguous)) notes.push('解析歧义：' + m.evs.filter((e) => e.ambiguous).map(ambNote).join('、'));
      if (m.evs.some((e) => e.unknown.length)) notes.push('未知标签词：' + Array.from(new Set([].concat(...m.evs.map((e) => e.unknown)))).join('、'));
      if (m.evs.some((e) => e.fuzzy)) notes.push('模糊匹配：' + m.evs.filter((e) => e.fuzzy).map((e) => e.src + '「' + e.id.slice(0, 24) + '」（' + e.fuzzy + '）').join('、'));
      if (m.fuzzyCands.length) notes.push('模糊候选（不唯一，未采用）：' + m.fuzzyCands.slice(0, 4).join('、'));
      if (m.editConflict) notes.push('证据冲突备注（守护 / 保留证据 ' + m.editConflict.keep.join('、') + ' 与编辑落点冲突：编辑全落在 ' + m.editConflict.where.join('、') + '，初判按守护 / 保留，请核对改挂目标是否在要删的代码里）');
      if (m.softConflict) notes.push('证据冲突备注（守护 / 保留证据 ' + m.softConflict.keep.join('、') + '；只含可删标签的证据 ' + m.softConflict.del.join('、') + '，但编辑没全落删除段，未改判）');
      if (m.assign === 'unassigned') notes.push('待分派：' + m.pendingWhy);
      if (m.assign === 'unaffected') notes.push('不受影响的依据：承接用例 ' + m.hosts + ' 个都不受影响');
      const srcs = { labels: '标签', files: '整删文件', segs: '删除段（关键词推断）', hosts: '承接用例' };
      const why = Object.keys(srcs).filter((k) => m.sources[k].length).map((k) => srcs[k] + ' ' + cText(m.sources[k])).join('；');
      if (why) notes.push('受影响来源：' + why);
      const lines = m.cov.map((a) => a.file.split('/').pop() + ':' + (a.status === 'ok' ? (a.line === undefined ? '（整个文件）' : a.line + (a.endLine !== a.line ? '–' + a.endLine : '')) : (a.status === 'synthetic' ? '（合成）' : (a.line ? a.line + '?' : '?')))).join('、');
      L.push(`| ${esc(m.group)} | ${esc(m.id)} | ${m.no} | ${esc(m.files.join('、'))} | ${esc(expectText(m.expect))} | ${esc(m.evs.map((e) => e.labelText).filter(Boolean).join('；'))} | ${esc(m.evs.map((e) => e.src).join('；'))} | ${esc(lines)} | ${m.verdict} | ${assignCell(m.affected, m.assign)} | ${esc(notes.join('；'))} | | |`);
    }
    L.push('');
  }
  L.push('## 五、原件变异表里对不上主表的行');
  L.push('');
  L.push(`共 ${g.unmatchedOrig.length} 行（原件变异表数据行总数 ${input.muts.length} − 与主表对上的 ${input.muts.length - g.unmatchedOrig.length}）。`);
  L.push('');
  L.push('| 原件位置 | 文件 | 变异名 | 原件流程标签 | 所在节 | 原件物理行 | 解析歧义原因 | 原文 | 候选读法 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of g.unmatchedOrig) L.push(`| ${esc(r.src)} | ${esc(r.file)} | ${esc(r.id)} | ${esc(r.labelText)} | ${esc(r.heading)} | ${esc(r.lineRange)} | ${esc(r.ambiguous ? r.ambReason : '')} | ${esc(r.ambiguous ? clipRaw(r.rawLine) : '')} | ${esc(r.ambiguous ? r.candText : '')} |`);
  L.push('');
  L.push('### 5.1 出自守护保留规则小节、仍对不上主表的原件行（待人工挂接；每一行都是反向校验问题）');
  L.push('');
  L.push(`共 ${g.guardUnmatched.length} 行；另有占位行（原件写「（无明确条目）」这类）${g.unmatchedOrig.filter((r) => r.placeholder).length} 行不算。`);
  L.push('');
  L.push('| 待挂接原件位置 | 文件 | 守护小节原件 id | 所在节 | 原件物理行 | 解析歧义原因 | 原文 | 候选读法 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of g.guardUnmatched) L.push(`| ${esc(r.src)} | ${esc(r.file)} | ${esc(r.id)} | ${esc(r.heading)} | ${esc(r.lineRange)} | ${esc(r.ambiguous ? r.ambReason : '')} | ${esc(r.ambiguous ? clipRaw(r.rawLine) : '')} | ${esc(r.ambiguous ? r.candText : '')} |`);
  L.push('');
  L.push('### 5.2 模糊匹配清单（同组内受控模糊匹配，主表 id 与原件 id 不同、但唯一对应；请人工抽核）');
  L.push('');
  L.push(`共 ${g.fuzzyPairs.length} 对。规则：① 主表 id = 前缀「：」+ 原件 id；② 主表 id = 原件 id +「（…）」；③ 原件 id 被截断（「（」没闭合），主表 id 以它开头；另须原件行的目标源文件与主表变异的目标文件一致（没有目标源文件列的表取表标题点名的文件）。同一原件行（按原件位置 + 组计）被多条主表变异命中、或一条主表变异命中多个原件 id 的不采用（候选写在变异备注里）。`);
  L.push('');
  L.push('| 主表编号 | 主表 id | 原件位置 | 原件 id | 匹配方式 | 原件目标文件 | 主表目标文件 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const p of g.fuzzyPairs) L.push(`| ${p.no} | ${esc(p.id)} | ${esc(p.src)} | ${esc(p.origId)} | ${p.how} | ${esc(p.origTargets.join('、'))} | ${esc(p.masterTargets.join('、'))} |`);
  L.push('');
  L.push('### 5.2b 不自动挂接、列人工挂接的模糊候选（原件行的组未定、没有目标文件依据、或目标文件与主表不一致）');
  L.push('');
  L.push(`共 ${g.manualFuzzy.length} 条。这些候选按 id 的写法对得上，但缺少「同组 + 目标文件一致」的依据，不自动挂接，也不当证据；需要时由主会话人工挂接。`);
  L.push('');
  L.push('| 主表编号 | 主表 id | 原件位置 | 原件 id | 未自动挂接的原因 |');
  L.push('|---|---|---|---|---|');
  for (const p of g.manualFuzzy) L.push(`| ${p.no} | ${esc(p.id)} | ${esc(p.src)} | ${esc(p.origId)} | ${esc(p.why)} |`);
  L.push('');
  L.push('### 5.3 被排除的「其他表」（逐张列出理由）');
  L.push('');
  L.push('| 原件位置 | 所在标题 | 表头 | 数据行 | 排除理由 |');
  L.push('|---|---|---|---|---|');
  for (const a of input.audits) for (const o of a.others) L.push(`| ${esc(o.key)} | ${esc(o.heading)} | ${esc(o.header)} | ${o.rows} | ${esc(o.reason || '（未登记）')} |`);
  L.push('');
  L.push('## 六、按提交取行（动手前按提交取行：C2–C8 每个提交，受影响提交含它的全部用例与变异）');
  L.push('');
  L.push('用例用原件位置，变异用编号 M0001…（见第四节）。一条用例 / 变异受影响的提交不止一个时，在每个提交里都出现。「其中仍有未核完事项」列出的行同时在第七节待分派里：它们在这里的提交是已知受影响提交，裁定后要据结果重建本表。');
  L.push('');
  L.push('| 提交 | 用例（原件位置） | 变异（编号） | 用例数 | 变异数 | 其中仍有未核完事项的用例 | 其中仍有未核完事项的变异 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const n of COMMITS) {
    const a = cs.filter((r) => r.affected.includes(n));
    const b = ms.filter((m) => m.affected.includes(n));
    L.push(`| C${n} | ${a.map((r) => r.src).join('、')} | ${b.map((m) => m.no).join('、')} | ${a.length} | ${b.length} | ${a.filter((r) => caseAssign(r) === 'unassigned').map((r) => r.src).join('、')} | ${b.filter((m) => m.assign === 'unassigned').map((m) => m.no).join('、')} |`);
  }
  L.push('');
  const pc = cs.filter((r) => caseAssign(r) === 'unassigned');
  const pm = ms.filter((m) => m.assign === 'unassigned');
  L.push('## 七、待分派 / 待裁定（没有可用的提交、又不是「不受影响」的行，以及已有已知受影响提交、但另有未核完事项或初判待裁定的行；C2 开工前由主会话逐行裁定）');
  L.push('');
  L.push(`用例 ${pc.length} 行（其中已有已知受影响提交 ${pc.filter((r) => r.affected.length > 0).length} 行）；变异 ${pm.length} 条（其中已有已知受影响提交 ${pm.filter((m) => m.affected.length > 0).length} 条）。`);
  L.push('');
  L.push('### 7.1 用例');
  L.push('');
  L.push('| 原件位置 | 用例名 | 机械初判 | 已知受影响提交 | 原因 |');
  L.push('|---|---|---|---|---|');
  for (const r of pc) L.push(`| ${esc(r.src)} | ${esc(r.name)} | ${r.verdict} | ${cText(r.affected)} | ${esc(reason71(r))} |`);
  L.push('');
  L.push('### 7.2 变异');
  L.push('');
  L.push('| 编号 | 组 | id | 机械初判 | 已知受影响提交 | 未核完事项来源 | 原因 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const m of pm) L.push(`| ${m.no} | ${esc(m.group)} | ${esc(m.id)} | ${m.verdict} | ${cText(m.affected)} | ${esc(m.open.map((o) => o.k).join('、'))} | ${esc(m.pendingWhy)} |`);
  L.push('');
  return L;
}

// ── 反向校验 ───────────────────────────────────────────────────────────────────────────
const commitsIn = (s) => uniqSorted(Array.from(String(s || '').matchAll(/C(\d)/g)).map((m) => Number(m[1])));
function checkOutput(outText, input, master, built) {
  const problems = [];
  for (const p of input.regProblems || []) problems.push(p);
  const tables = P.parseTables(outText);
  const caseT = tables.filter((t) => t.header[0] === '原件位置' && t.header[1] === '用例名' && t.header[2] === '文件');
  const mutT = tables.filter((t) => t.header[0] === '组' && t.header[1] === 'id' && t.header[2] === '编号');
  const unmT = tables.filter((t) => t.header[0] === '原件位置' && t.header[2] === '变异名');
  const commitT = tables.filter((t) => t.header[0] === '提交' && t.header[1] === '用例（原件位置）');
  const key = (a) => a.join('\u0001');
  const want = new Map();
  for (const r of input.cases) { const k = key([r.src, r.file, r.name, r.lines, r.testedText, r.setupText]); want.set(k, (want.get(k) || 0) + 1); }
  const got = new Map();
  let nCase = 0;
  const outCases = [];
  for (const t of caseT) {
    const ia = t.header.indexOf('全部受影响提交');
    const ih = t.header.indexOf('机械初判');
    const io = t.header.indexOf('所属提交');
    for (const r of t.rows) {
      nCase += 1;
      const k = key([r.cells[0], r.cells[2], r.cells[1], r.cells[3], r.cells[4], r.cells[5]]);
      got.set(k, (got.get(k) || 0) + 1);
      outCases.push({ src: r.cells[0], affected: commitsIn(r.cells[ia]) });
      // 按输出的被测 / 搭数据 / 原件分类重算初判与提交列，与输出对拍（只核前几列会让标签错位漏过去）
      const j = judgeCase({ testedText: r.cells[4], setupText: r.cells[5], origCat: r.cells[6], ambiguous: r.cells[ih] === '待裁定（解析歧义）' });
      if (j.verdict !== r.cells[ih]) problems.push(`输出行 ${r.cells[0]} 的初判「${r.cells[ih]}」与按被测 / 搭数据 / 原件分类重算的「${j.verdict}」不一致`);
      else if (j.commit !== r.cells[io] || cText(j.affected) !== cText(commitsIn(r.cells[ia]))) problems.push(`输出行 ${r.cells[0]} 的所属提交「${r.cells[io]}」/ 全部受影响提交「${r.cells[ia]}」与按标签重算的「${j.commit}」/「${cText(j.affected)}」不一致`);
    }
  }
  for (const [k, n] of want) { const m = got.get(k) || 0; if (m !== n) problems.push(`用例行 ${k.split('\u0001').join(' | ')}：应出现 ${n} 次，实际 ${m} 次`); }
  for (const [k, m] of got) if (!want.has(k)) problems.push(`输出里多出的用例行：${k.split('\u0001').join(' | ')}（${m} 次）`);
  if (nCase !== input.cases.length) problems.push(`用例行数不符：原件 ${input.cases.length} 行，输出 ${nCase} 行`);
  // H2：原文里每个以 | 开头的非分隔行都必须落在某张已解析表上（用例表、变异表，或明确排除的「其他表」：既不是用例表也不是变异表）；落不到的列为问题
  const warnings = [];
  for (const a of input.audits || []) {
    for (const s of a.suspectOther || []) problems.push(`被排除的「其他表」表头含「变异」「用例」「场景」「标题」「断言」之一、又没有登记理由（可能误排除了用例表 / 变异表）：${s}`);
    for (const cb of a.crossedBlank || []) warnings.push(`跨空行合并的断行：${cb}（单元格里的代码片段夹着空行，按上一行没凑够单元格并入；请人工看一眼）`);
    for (const ln of a.uncovered) problems.push(`原件 ${a.file}:${ln} 以 | 开头，但不在任何已解析的表里（表被切丢了）`);
    if (a.parsedEmpty) problems.push(`原件 ${a.file}：原文有以 | 开头的行，但一张表都没解析出来`);
    for (const d of a.deepFenceAroundTable || []) problems.push(`原件 ${a.file}:${d.open}–${d.close} 有缩进 ≥ 4 空格的围栏标记成对夹着表（顶层围栏只认 0–3 空格缩进，这些标记不当围栏；若它们其实是列表里的围栏，里面的表不该被解析：请人工看原件位置）`);
    if (a.unclosedFence) problems.push(`原件 ${a.file}:${a.unclosedFence} 的围栏代码块到文件末尾都没有闭合（不支持的写法：后面的表会被整段跳过，解析与审计同时漏）`);
    if (a.uncovered.length === 0 && a.caseT + a.mutT + a.other + a.contPipe !== a.total) problems.push(`原件 ${a.file}：以 | 开头的非分隔行共 ${a.total} 行，用例表 ${a.caseT} + 变异表 ${a.mutT} + 排除的其他表 ${a.other} + 以 | 开头的断行续行 ${a.contPipe} 合计对不上`);
  }
  const wantM = new Map();
  for (const m of master) { const k = key([m.group, m.id]); wantM.set(k, (wantM.get(k) || 0) + 1); }
  const gotM = new Map();
  let nMut = 0;
  const outMuts = [];
  for (const t of mutT) {
    const ia = t.header.indexOf('受影响提交');
    for (const r of t.rows) { nMut += 1; const k = key([r.cells[0], r.cells[1]]); gotM.set(k, (gotM.get(k) || 0) + 1); outMuts.push({ no: r.cells[2], affected: commitsIn(r.cells[ia]) }); }
  }
  for (const [k, n] of wantM) { const m = gotM.get(k) || 0; if (m !== n) problems.push(`变异 ${k.split('\u0001').join(' | ')}：主表 ${n} 条，输出 ${m} 行`); }
  for (const [k, m] of gotM) if (!wantM.has(k)) problems.push(`输出里多出的变异行：${k.split('\u0001').join(' | ')}（${m} 次）`);
  if (nMut !== master.length) problems.push(`变异行数不符：主表 ${master.length} 条，输出 ${nMut} 行`);
  const nUn = unmT.reduce((a, t) => a + t.rows.length, 0);
  const matched = input.muts.length - nUn;
  const used = outText.match(/（原件变异表数据行总数 (\d+) − 与主表对上的 (\d+)）/);
  if (!used || Number(used[1]) !== input.muts.length || Number(used[2]) !== matched) problems.push('「对不上主表的行」一节的合计与原件变异表数据行总数核不上');
  if (matched < 0) problems.push(`与主表对上的原件行数 ${matched} 小于 0`);
  // 按提交取行 ↔ 两张明细表的受影响提交列（C2–C8 逐提交对拍）
  if (commitT.length !== 1) problems.push(`输出里「按提交取行」表有 ${commitT.length} 张（应为 1 张）`);
  else {
    for (const n of COMMITS) {
      const row = commitT[0].rows.find((r) => r.cells[0] === 'C' + n);
      if (!row) { problems.push(`「按提交取行」里没有 C${n} 一行`); continue; }
      const sec = (s) => s.split('、').map((x) => x.trim()).filter(Boolean).sort().join('、');
      const wantC = sec(outCases.filter((c) => c.affected.includes(n)).map((c) => c.src).join('、'));
      const wantMu = sec(outMuts.filter((c) => c.affected.includes(n)).map((c) => c.no).join('、'));
      if (sec(row.cells[1]) !== wantC) problems.push(`「按提交取行」C${n} 的用例列与明细表里受影响提交含 C${n} 的用例不一致`);
      if (sec(row.cells[2]) !== wantMu) problems.push(`「按提交取行」C${n} 的变异列与明细表里受影响提交含 C${n} 的变异不一致`);
    }
  }
  // 74 MEDIUM：按 原件位置 + 组 + 编号 逐键回读，对拍 build 的结果（来源、未匹配行、提交集合、待分派、第六节）；只核总数 / 只与输出自己对拍会让「换一行保持总数」「清掉来源」「同时漏写同一提交」「第七节整行丢失」都通过
  if (built) {
    const setDiff = (what, wantSet, gotSet) => {
      for (const k of wantSet) if (!gotSet.has(k)) problems.push(`${what}：应有「${k}」，输出里没有`);
      for (const k of gotSet) if (!wantSet.has(k)) problems.push(`${what}：输出里多出「${k}」`);
    };
    const hdr = (t, name) => t.header.indexOf(name);
    const byNo = new Map();
    for (const t of mutT) for (const r of t.rows) byNo.set(r.cells[2], { t, r });
    for (const m of built.mutOut) {
      const o = byNo.get(m.no);
      if (!o) { problems.push(`变异 ${m.no}（${m.group} | ${m.id}）在输出明细里找不到这个编号`); continue; }
      const c = (name) => o.r.cells[hdr(o.t, name)];
      if (o.r.cells[0] !== m.group || o.r.cells[1] !== m.id) problems.push(`变异编号 ${m.no} 的 组 | id 与主表不一致：输出「${o.r.cells[0]} | ${o.r.cells[1]}」，主表「${m.group} | ${m.id}」`);
      const wantSrc = m.evs.map((e) => e.src).join('；');
      if (c('原件来源') !== wantSrc) problems.push(`变异 ${m.no} 的原件来源与匹配结果不一致：输出「${c('原件来源')}」，应为「${wantSrc}」`);
      if (c('机械初判') !== m.verdict) problems.push(`变异 ${m.no} 的机械初判与计算结果不一致：输出「${c('机械初判')}」，应为「${m.verdict}」`);
      if (cText(commitsIn(c('受影响提交'))) !== cText(m.affected)) problems.push(`变异 ${m.no} 的受影响提交与计算结果不一致：输出「${c('受影响提交')}」，应为「${cText(m.affected)}」`);
      if (m.assign === 'unassigned' && !/待分派|另有未核完事项/.test(c('受影响提交') + c('备注'))) problems.push(`变异 ${m.no} 是待分派，但输出明细里没有任何待分派标记`);
    }
    // 77 号 MEDIUM-9：按所在章节定位表格（表头相同的表放到别的章节不算），逐行逐字段核对，行集合按多重集比较（重复一行、改任一字段、移到别的章节都报）
    const outLines = outText.split(/\r?\n/);
    const secOf = (t) => { for (let k = t.headerLine - 1; k >= 0; k -= 1) { const m = /^## (.+)$/.exec(outLines[k] || ''); if (m) return m[1]; } return ''; };
    const inSec = (t, prefix) => secOf(t).startsWith(prefix);
    const multiDiff = (what, wantArr, gotArr) => {
      const cnt = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
      const w = cnt(wantArr);
      const g2 = cnt(gotArr);
      for (const [k, n] of w) if ((g2.get(k) || 0) !== n) problems.push(`${what}：应有 ${n} 行「${k.split('\u0001').join(' | ').slice(0, 160)}」，输出里 ${g2.get(k) || 0} 行`);
      for (const [k, n] of g2) if (!w.has(k)) problems.push(`${what}：输出里多出 ${n} 行「${k.split('\u0001').join(' | ').slice(0, 160)}」`);
    };
    const rowsOfSec = (pred, prefix) => [].concat(...tables.filter((t) => pred(t) && inSec(t, prefix)).map((t) => t.rows.map((r) => r.cells)));
    const tuple = (...xs) => xs.map((x) => String(x === undefined ? '' : x).trim()).join('\u0001');
    // 第五节：对不上主表的原件行（含歧义原因 / 原文 / 候选读法，77 号 MEDIUM-10）、5.1、5.2（含目标文件两列）、5.2b
    multiDiff('第五节对不上主表的原件行', built.unmatchedOrig.map((r) => tuple(r.src, r.file, r.id, r.labelText, r.heading, r.lineRange, r.ambiguous ? r.ambReason : '', r.ambiguous ? clipRaw(r.rawLine) : '', r.ambiguous ? r.candText : '')), rowsOfSec((t) => t.header[0] === '原件位置' && t.header[2] === '变异名', '五、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8])));
    multiDiff('5.1 待人工挂接的守护小节原件行', (built.guardUnmatched || []).map((r) => tuple(r.src, r.file, r.id, r.heading, r.lineRange, r.ambiguous ? r.ambReason : '', r.ambiguous ? clipRaw(r.rawLine) : '', r.ambiguous ? r.candText : '')), rowsOfSec((t) => t.header[0] === '待挂接原件位置', '五、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7])));
    multiDiff('5.2 模糊匹配清单（含原件目标 / 主表目标）', built.fuzzyPairs.map((p) => tuple(p.no, p.id, p.src, p.origId, p.how, p.origTargets.join('、'), p.masterTargets.join('、'))), rowsOfSec((t) => t.header[0] === '主表编号' && t.header[4] === '匹配方式', '五、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4], c[5], c[6])));
    multiDiff('5.2b 人工挂接的模糊候选', (built.manualFuzzy || []).map((p) => tuple(p.no, p.id, p.src, p.origId, p.why)), rowsOfSec((t) => t.header[0] === '主表编号' && t.header[4] === '未自动挂接的原因', '五、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4])));
    // 第七节待分派：用例（原件位置 | 用例名 | 机械初判 | 已知受影响提交 | 原因）与变异（编号 | 组 | id | 机械初判 | 已知受影响提交 | 未核完事项来源 | 原因）逐字段核对
    const wantPm = built.mutOut.filter((m) => m.assign === 'unassigned');
    multiDiff('第七节 7.1 待分派用例', built.caseRowsOut.filter((r) => caseAssign(r) === 'unassigned').map((r) => tuple(r.src, r.name, r.verdict, cText(r.affected), reason71(r))), rowsOfSec((t) => t.header[0] === '原件位置' && t.header[1] === '用例名' && t.header[2] === '机械初判', '七、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4])));
    multiDiff('第七节 7.2 待分派变异', wantPm.map((m) => tuple(m.no, m.group, m.id, m.verdict, cText(m.affected), m.open.map((o) => o.k).join('、'), m.pendingWhy)), rowsOfSec((t) => t.header[0] === '编号' && t.header[1] === '组' && t.header[2] === 'id', '七、').map((c) => tuple(c[0], c[1], c[2], c[3], c[4], c[5], c[6])));
    // 第六节与 build 的结果（不是只与输出自己的明细对拍）逐提交对拍
    if (commitT.length === 1) {
      const sec = (a) => a.slice().sort().join('、');
      for (const n of COMMITS) {
        const nRow = commitT[0].rows.filter((r) => r.cells[0] === 'C' + n).length;
        if (nRow !== 1) problems.push(`第六节 C${n} 应恰好出现 1 行，输出 ${nRow} 行`);
        const row = commitT[0].rows.find((r) => r.cells[0] === 'C' + n);
        if (!row) continue;
        const cs6 =built.caseRowsOut.filter((r) => r.affected.includes(n));
        const ms6 = built.mutOut.filter((m) => m.affected.includes(n));
        const split = (s) => String(s || '').split('、').map((x) => x.trim()).filter(Boolean);
        if (sec(split(row.cells[1])) !== sec(cs6.map((r) => r.src))) problems.push(`第六节 C${n} 的用例列与计算结果不一致`);
        if (sec(split(row.cells[2])) !== sec(ms6.map((m) => m.no))) problems.push(`第六节 C${n} 的变异列与计算结果不一致`);
        if (sec(split(row.cells[5])) !== sec(cs6.filter((r) => caseAssign(r) === 'unassigned').map((r) => r.src))) problems.push(`第六节 C${n} 的「仍有未核完事项的用例」列与计算结果不一致`);
        if (sec(split(row.cells[6])) !== sec(ms6.filter((m) => m.assign === 'unassigned').map((m) => m.no))) problems.push(`第六节 C${n} 的「仍有未核完事项的变异」列与计算结果不一致`);
      }
    }
  }
  // 原件变异行重复归属
  if (built) for (const r of built.guardUnmatched || []) problems.push(`守护保留规则小节的原件行 ${r.src}「${r.id.slice(0, 40)}」对不上主表（待人工挂接）`);
  // 被排除的其他表在输出 5.3 逐张有理由
  if (input.registryChecked) {
    const oT = tables.filter((t) => t.header[0] === '原件位置' && t.header[1] === '所在标题' && t.header[2] === '表头');
    const oRows = [];
    for (const t of oT) for (const r of t.rows) oRows.push(r.cells);
    const want = input.audits.reduce((n, a) => n + a.others.length, 0);
    if (oRows.length !== want) problems.push(`被排除的其他表：原件 ${want} 张，输出 5.3 列了 ${oRows.length} 张`);
    for (const r of oRows) if (!r[4] || r[4] === '（未登记）') problems.push(`被排除的其他表 ${r[0]} 没有登记的排除理由`);
  }
  if (built) for (const d of built.dupClaims) { const txt = `原件变异行 ${d.key.split('\u0001').join(' / ')} 被 ${d.keys.length} 条主表变异（${d.keys.map((k) => k.split('\u0001').join(':')).join('、')}）当证据`; if (!d.same) problems.push('重复归属：' + txt); else warnings.push('同一（组, id）在主表里重复，共用同一原件行：' + txt); }
  return { problems, warnings, nCase, nMut, nUn };
}

function parseArgs(argv) {
  const o = { out: null, invDir: DEFAULT_INV_DIR, deletionList: null, repo: DEFAULT_REPO, idsFile: null, namesFile: null, registryFile: null, check: true, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--no-check') o.check = false;
    else if (a === '--check') o.check = true;
    else if (['--out', '--inv-dir', '--deletion-list', '--repo', '--ids-file', '--names-file', '--registry-file'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(a + ' 需要一个参数');
      const v = path.resolve(argv[i + 1]);
      i += 1;
      if (a === '--out') o.out = v; else if (a === '--inv-dir') o.invDir = v; else if (a === '--deletion-list') o.deletionList = v; else if (a === '--repo') o.repo = v; else if (a === '--ids-file') o.idsFile = v; else if (a === '--registry-file') o.registryFile = v; else o.namesFile = v;
    } else throw new Error('未知参数 ' + a);
  }
  if (!o.selfTest && !o.out) throw new Error('需要 --out <md>');
  return o;
}
function headOf(repo) { const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }

function generate(o) {
  const reg = o.registryFile ? JSON.parse(fs.readFileSync(o.registryFile, 'utf8')) : REGISTRY;
  const input = loadInput(o.invDir, reg);
  const master = o.idsFile ? JSON.parse(fs.readFileSync(o.idsFile, 'utf8')) : loadMasterIds(o.repo);
  const names = o.namesFile ? JSON.parse(fs.readFileSync(o.namesFile, 'utf8')) : loadRealNames(o.repo);
  const delPath = o.deletionList || path.join(path.dirname(path.dirname(o.invDir)), reg.deletionList);
  let del = { whole: [], wholeCommit: new Map(), ranges: new Map(), segments: new Map(), sLabels: 0, problems: [], segRows: 0, noRange: [], rangeFiles: [], rangeCount: 0 };
  let delError = null;
  if (fs.existsSync(delPath)) {
    del = deletionInfo(P.readText(delPath));
    input.hashes.push(path.basename(delPath) + ' ' + P.sha12(delPath));
    if (path.basename(delPath) !== reg.deletionList) input.regProblems.push(`删除清单文件名 ${path.basename(delPath)} 不是期望的 ${reg.deletionList}`);
    if (del.whole.length === 0 || del.rangeFiles.length === 0 || del.rangeCount === 0 || del.sLabels === 0) input.regProblems.push(`删除清单没读出期望的内容：整删文件 ${del.whole.length} 个、抽出行区间的逐段删文件 ${del.rangeFiles.length} 个（区间 ${del.rangeCount} 段）、第二节标签 ${del.sLabels} 个（任一为 0 都不对）`);
    // 74 MEDIUM：删除清单是冻结的证据，登记 sha256；每条整删 / 逐段记录都要有可解析的归属 / 行区间（只核「三类统计非零」会让同名清单少一条整删记录或少一段范围后仍通过）
    if (reg.deletionListSha256 && reg.deletionListSha256 !== P.sha256(delPath)) input.regProblems.push(`删除清单 ${path.basename(delPath)} 的 sha256 与登记不符（登记 ${reg.deletionListSha256.slice(0, 12)}…，实际 ${P.sha12(delPath)}…；清单被改动过？）`);
    for (const p of del.problems || []) input.regProblems.push(p);
    // 无行区间的逐段记录对照登记的预期清单：多出的 / 少了的都报（预期清单随登记走，自检里传 reg 不带 deletionNoRange 时不核）
    if (reg.deletionNoRange) {
      const got = (del.noRange || []).map((x) => x.file);
      for (const x of del.noRange || []) if (!reg.deletionNoRange.includes(x.file)) input.regProblems.push(`删除清单 3.3 逐段记录 ${x.file} 读不出任何行区间（「删什么」：${x.text}），也不在登记的无区间记录里（${reg.deletionNoRange.join('、')}）`);
      for (const f of reg.deletionNoRange) if (!got.includes(f)) input.regProblems.push(`登记的无区间逐段记录 ${f} 在删除清单 3.3 里没找到（或已写出行区间）：登记要同步更新`);
    }
  } else delError = '删除清单不存在：' + delPath;
  if (o.idsFile) input.hashes.push(path.basename(o.idsFile) + ' ' + P.sha12(o.idsFile));
  const g = build(input, master, names, del, o.repo);
  const lines = render(g, input, { generatedAt: new Date().toISOString(), head: headOf(o.repo) }, del);
  return { input, master, names, del, delError, g, lines };
}
function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error('用法错误：' + e.message); return 2; }
  if (o.selfTest) return selfTest();
  const r = generate(o);
  let text = r.lines.join('\n') + '\n';
  let bad = false;
  if (o.check) {
    const chk = checkOutput(text, r.input, r.master, r.g);
    if (r.delError) chk.problems.push(r.delError);
    const au = (k) => r.input.audits.reduce((n, a) => n + a[k], 0);
    const rs = r.input.regStats;
    const tail = ['## 八、反向校验', '', `- 期望清单：期望文件 ${rs.filesWant}、实到 ${rs.filesGot}；登记表 ${rs.tablesWant}、实到 ${rs.tablesGot}；缺表 ${rs.missing}、多出未登记 ${rs.unregistered}、角色不符 ${rs.roleMismatch}、归属错配（完整标题路径 / 所属文件）${rs.pathMismatch}；九份输入（8 份取证原件 + 删除清单）的存在与 sha256 已核`, `- 原文围栏外以 | 开头的非分隔行 ${au('total')} 行 = 用例表 ${au('caseT')} + 变异表 ${au('mutT')} + 排除的其他表（既不是用例表也不是变异表）${au('other')} + 以 | 开头的断行续行 ${au('contPipe')}；落不到任何已解析表的 ${r.input.audits.reduce((n, a) => n + a.uncovered.length, 0)} 行；断行续行并入上一行的 ${au('continuation')} 行；标了解析歧义的原件行 ${au('ambiguousRows')} 行`, `- 原件用例表数据行 ${r.input.cases.length}，输出 ${chk.nCase}`, `- 主表变异 ${r.master.length}，输出 ${chk.nMut}`, `- 原件变异表数据行 ${r.input.muts.length}，其中对不上主表 ${chk.nUn}`, `- 按提交取行：C2–C8 每个提交的用例列与变异列已与明细表的受影响提交列逐提交对拍`, `- 问题 ${chk.problems.length} 条；警告 ${chk.warnings.length} 条`];
    for (const p of chk.problems) tail.push('  - 问题：' + p);
    for (const w of chk.warnings) tail.push('  - 警告：' + w);
    tail.push(`- 排除的「其他表」登记理由（表头含变异 / 用例 / 场景 / 标题 / 断言之一、经核不是用例表或变异表）${r.input.audits.reduce((n, a) => n + a.whitelisted.length, 0)} 张：`);
    for (const a of r.input.audits) for (const w of a.whitelisted) tail.push(`  - ${w.key}（${w.header}）：${w.reason}`);
    for (const k of ['apiError', 'browserError', 'schemaError']) if (r.names[k]) tail.push(`- 真实用例名读取失败（${k}），对应整组用例记「未对账」：${r.names[k]}`);
    if (r.names.apiScanError) tail.push(`- 部分 API 套件文件静态扫描失败（${r.names.apiScanError}）：这些文件里的用例可能没带定义文件，只算候选`);
    for (const k of ['api', 'browser', 'schema']) if (Array.isArray(r.names[k])) { const es = normNameList(r.names[k]); tail.push(`- 真实用例名单 ${k}：${es.length} 个，其中定义文件已确认 ${es.filter((e) => e.files.length === 1).length}、定义在多个文件 ${es.filter((e) => e.files.length > 1).length}、归属不明 ${es.filter((e) => e.files.length === 0).length}`); }
    text += '\n' + tail.join('\n') + '\n';
    bad = chk.problems.length > 0;
    console.log(`期望清单：文件 ${rs.filesWant}→${rs.filesGot}；表 ${rs.tablesWant}→${rs.tablesGot}；缺表 ${rs.missing}；多出未登记 ${rs.unregistered}；角色不符 ${rs.roleMismatch}；归属错配 ${rs.pathMismatch}`);
    console.log(`原文以 | 开头的非分隔行 ${au('total')} = 用例表 ${au('caseT')} + 变异表 ${au('mutT')} + 排除其他表 ${au('other')} + 以 | 开头的续行 ${au('contPipe')}；落不到表的 ${r.input.audits.reduce((n, a) => n + a.uncovered.length, 0)}；断行续行 ${au('continuation')}；解析歧义 ${au('ambiguousRows')}`);
    for (const a of r.input.audits) console.log(`  ${a.file}：用例行 ${a.caseRows}；变异表行 ${a.mutRows}；断行续行 ${a.continuation}`);
    console.log(`用例 ${r.input.cases.length}→${chk.nCase}；变异 主表 ${r.master.length}→${chk.nMut}；原件变异行 ${r.input.muts.length}（对不上 ${chk.nUn}）；问题 ${chk.problems.length}`);
    for (const p of chk.problems.slice(0, 30)) console.log('  问题：' + p);
    for (const w of chk.warnings) console.log('  警告：' + w);
    console.log(`排除的其他表登记理由 ${r.input.audits.reduce((n, a) => n + a.whitelisted.length, 0)} 张；表头含关键词却没有登记理由的 ${r.input.audits.reduce((n, a) => n + a.suspectOther.length, 0)} 张`);
  } else text += '\n## 八、反向校验\n\n- 未执行反向校验（--no-check）：本文件的输入登记（原件 / 表 / 删除清单的存在与摘要）与输出回读都没有核对，不能当作已校验的结果。\n';
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, text);
  const cs = r.g.caseRowsOut;
  const cnt = (v) => cs.filter((x) => x.verdict === v).length;
  console.log(`已写入 ${o.out}：用例 ${cs.length} 行（` + ['整删', '要拆', '要拆（跨提交）', '保留但需改夹具', '不受影响', '第一步不动', '第一步不动但需改夹具', '待裁定', '待裁定（解析歧义）', '待裁定（未知标签词）'].map((v) => `${v} ${cnt(v)}`).join('；') + '）');
  const sc = (s) => cs.filter((x) => x.match.status === s).length;
  console.log(`用例名对账：对上 ${sc('对上')}；仅包含匹配 ${sc('仅包含匹配')}；匹配多个 ${sc('匹配多个')}；对不上 ${sc('对不上')}；无名单 ${sc('无名单')}；未对账 ${sc('未对账')}`);
  const mc = (v) => r.g.mutOut.filter((x) => x.verdict === v).length;
  console.log(`变异 ${r.g.mutOut.length} 条：` + MVERDICTS.map((v) => `${v} ${mc(v)}`).join('；') + `；其中原件无 ${r.g.mutOut.filter((x) => x.nEv === 0).length}`);
  console.log(`对不上主表的原件变异行 ${r.g.unmatchedOrig.length}（其中守护小节 ${r.g.guardUnmatched.length}、占位行 ${r.g.unmatchedOrig.filter((x) => x.placeholder).length}）；模糊匹配 ${r.g.fuzzyPairs.length} 对`);
  console.log(`待分派：用例 ${cs.filter((x) => caseAssign(x) === 'unassigned').length}；变异 ${r.g.mutOut.filter((x) => x.assign === 'unassigned').length}；不受影响：用例 ${cs.filter((x) => caseAssign(x) === 'unaffected').length}；变异 ${r.g.mutOut.filter((x) => x.assign === 'unaffected').length}`);
  console.log(!o.check ? '结果：未执行反向校验（--no-check），不能当作输入登记与回读已核对' : (bad ? '结果：反向校验不通过' : '结果：通过'));
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
function selfTest() {
  let total = 0;
  let ok = 0;
  const check = (pass, label) => { total += 1; if (pass) ok += 1; console.log(`  ${pass ? '✓' : '✗'} ${label}`); };
  const jc = (tested, setup, cat) => judgeCase({ testedText: tested, setupText: setup || '', origCat: cat || '' });
  check(jc('HIS').verdict === '整删' && jc('HIS').commit === 'C2' && jc('ENT、NTC').verdict === '整删' && jc('ENT、NTC').commit === 'C6', '用例初判：被测只有可删标签、且都落在同一个提交（HIS→C2；ENT 与 NTC 同属 C6）→ 整删');
  const jx = jc('ENT、HND', 'KEEP');
  check(jx.verdict === '要拆（跨提交）' && jx.commit === 'C4–C6' && jx.beh.join() === '4,6' && jx.affected.join() === '4,6', 'J1：被测只有可删标签、但跨多个提交（HND→C4、ENT→C6）→ 要拆（跨提交），所属提交写「最早–最晚」C4–C6');
  // HIGH-3：被测行为删除提交与夹具最早失效提交分开记
  const h3a = jc('INV', 'HIS');
  check(h3a.verdict === '第一步不动但需改夹具' && h3a.commit === 'C2' && h3a.beh.length === 0 && h3a.fxMin === 2 && h3a.affected.join() === '2', 'H3 回归：被测 INV、搭数据 HIS → 第一步不动但需改夹具，所属提交 = 夹具最早失效提交 C2（不再是「第一步不动」）');
  const h3b = jc('ITEM', 'HIS');
  check(h3b.verdict === '保留但需改夹具' && h3b.commit === 'C2' && h3b.beh.join() === '7' && h3b.fxMin === 2 && h3b.affected.join() === '2,7', 'H3 回归：被测 ITEM（C7 才停用）、搭数据 HIS（C2 起失效）→ 保留但需改夹具，所属提交 C2，被测行为删除提交 C7 另列（不再是 C2 整删）');
  const h3c = jc('HIS', 'ITEM');
  check(h3c.verdict === '整删' && h3c.commit === 'C2' && h3c.beh.join() === '2' && h3c.fxMin === 7 && h3c.affected.join() === '2,7', 'H3：被测 HIS（C2）、搭数据 ITEM（C7）：夹具晚于被测失效 → 仍整删 C2，两个提交列分开记，受影响 C2、C7');
  check(jc('HIS', 'HIS').verdict === '整删' && jc('HIS', 'HIS').commit === 'C2', 'H3：被测与夹具同一提交 → 整删');
  check(jc('KEEP', 'ITEM、HIS').verdict === '保留但需改夹具' && jc('KEEP', 'ITEM、HIS').commit === 'C2' && jc('KEEP', 'ITEM、HIS').fx.join() === '2,7', 'H3：只有 KEEP 搭数据含可删标签 → 保留但需改夹具，所属提交取夹具最早失效提交 C2，夹具失效提交 C2、C7 都计入受影响');
  check(jc('KEEP、CHG').verdict === '要拆' && jc('INV、ENT').verdict === '要拆' && jc('KEEP、CHG', 'HIS').commit === 'C2', '用例初判：被测同时含可删标签与 KEEP / INV → 要拆；所属提交取两个提交列里最早的');
  check(jc('INV').verdict === '第一步不动' && jc('SETUP').verdict === '第一步不动' && jc('KEEP + INV（参与方）').verdict === '第一步不动' && jc('INV', 'KEEP').commit === '', '用例初判：被测含 INV / SETUP、不含可删标签、夹具无可删标签 → 第一步不动');
  const f1 = jc('KEEP', 'KEEP、ITEM');
  check(f1.verdict === '保留但需改夹具' && f1.commit === 'C7', '用例初判：只有 KEEP 但搭数据含可删标签 → 保留但需改夹具，提交取搭数据里最早的（ITEM→C7）');
  check(jc('KEEP', '—').verdict === '不受影响' && jc('KEEP', 'KEEP').commit === '' && jc('RPT', 'KEEP').verdict === '不受影响', '用例初判：只有 KEEP / RPT 且搭数据无可删标签 → 不受影响，提交为空');
  check(jc('', '', 'A').verdict === '整删' && jc('', '', 'B').verdict === '要拆' && jc('', '', 'C').verdict === '待裁定' && jc('', '', '').verdict === '待裁定' && jc('', '', 'A').commit === '' && jc('', '', 'A').affected.length === 0, '用例初判：没有被测标签时按原件分类 A → 整删、B → 要拆、C / 其他 → 待裁定；没有标签就没有提交');
  check(jc("KEEP + 动作表里各旧流程动作格（正文命中 HIS 4 次、ENT 3 次）").verdict === '要拆', '用例初判：括号里的注记标签也计入（KEEP + 注记 HIS / ENT → 要拆）');
  check(jc('KEEP；ZZZ 不认识').verdict === '待裁定（未知标签词）' && jc('KEEP', 'WWW').verdict === '待裁定（未知标签词）' && jc('RPT').verdict === '不受影响' && jc('CHG、RPT').verdict === '要拆', 'M6：被测 / 搭数据里的未知标签词 → 待裁定（未知标签词）；RPT 是已知保留类标签（单独 → 不受影响，与 CHG 同现 → 要拆）');
  // 名字匹配
  const nm = ['C6a 上线：统一上线判据——说明一', 'C6a 上线：生产路径复验——说明二', 'C6a 上线：交接集合', 'C6a 上线：交接确认——说明', '重复前缀甲', '重复前缀乙'];
  check(matchName('C6a 上线：统一上线判据', nm).status === '对上', '名字匹配：截短标题按前缀匹配到唯一真实名 → 对上');
  check(matchName('C6a 上线：统一上线判据…', nm).status === '对上', '名字匹配：末尾的 … 先去掉');
  check(matchName('重复前缀', nm).status === '匹配多个', '名字匹配：前缀命中多个 → 匹配多个');
  check(matchName('生产路径复验', nm).status === '仅包含匹配', '名字匹配：前缀 0 个、包含恰好 1 个 → 仅包含匹配');
  check(matchName('完全不存在', nm).status === '对不上' && matchName('x', null).status === '无名单', '名字匹配：都不命中 → 对不上；没有名单 → 无名单');
  check(namesFor('sysbuild-api-suite-plan.js', { api: ['a'] }).join() === 'a' && namesFor('sysbuild-browser-stage8.js', { browser: ['b'] }).join() === 'b' && namesFor('verify-sysbuild-e2e.js', { api: ['a'] }) === null, '名单归属：api 套件文件 → api 名单、浏览器文件 → 浏览器名单、其余无名单');
  check(matchCase('sysbuild-browser-suite.js', '文字', { browser: null, browserError: '炸' }).status === '未对账' && matchCase('verify-sysbuild-e2e.js', 'x', { api: ['a'] }).status === '无名单' && matchCase('sysbuild-api-suite.js', 'a', { api: ['a'] }).status === '对上', 'M5：名单读取失败的整组 → 未对账（不用部分名单）；没有名单的文件 → 无名单');
  // 删除清单与变异初判
  const delText = [
    '## 二、判定口径', '', '| 停用项 | 标签 | 判为删除的范围 |', '|---|---|---|', '| S1 正式变更 | CHG | x |', '| S4 记录的旧办理规则 | ENT | y |', '| S6 历史补录 | HIS | z |', '',
    '## 三、后端逐文件清单', '', '### 3.1 整文件删除（2 个）', '', '| 文件 | 行数 | 属于 | 谁在引用 |', '|---|---|---|---|', '| `history.js` | 663 | S6 | x |', '| `changes.js` | 332 | S1 | y |', '',
    '### 3.3 逐段删的文件', '', '| 文件（行数） | 删什么 | 留什么 | 约删 |', '|---|---|---|---|',
    '| `rules.js`（1485） | 常量与判定函数：授权与邀请 `:337–347`、`:365–370`，历史窗口 `:355–364`；记录办理 `:456–505`，知会异议 `:518–519`，代录文案 `:350`；保留规则里的分支：变更包（`:120–127` 的 `\'change\'` 成员、`:712–740`）、单行 `:550` | 其余 | 10 |', '',
    '## 四、库结构', '',
  ].join('\n');
  const del = deletionInfo(delText);
  check(del.whole.join() === 'history.js,changes.js' && JSON.stringify(del.ranges.get('rules.js')) === '[[337,347],[365,370],[355,364],[456,505],[518,519],[350,350],[120,127],[712,740],[550,550]]', '删除清单：3.1 的整删文件与 3.3 的行区间（`:a–b` / `:a`）机械抽出');
  check(del.wholeCommit.get('history.js') === 2 && del.wholeCommit.get('changes.js') === 5 && del.sLabels === 3, '删除清单：3.1「属于」列 S6 / S1 → 第二节的标签 HIS / CHG → 提交 C2 / C5');
  const sg = (a) => del.segments.get('rules.js').find((s) => s.from === a);
  check(sg(337).commits.length === 0 && sg(337).labels.join() === 'INV' && sg(365).labels.join() === 'INV' && sg(355).commits.join() === '2' && sg(456).commits.join() === '6' && sg(518).commits.join() === '6' && sg(350).commits.join() === '3' && sg(120).commits.join() === '5' && sg(712).commits.join() === '5' && sg(550).labels.length === 0, '删除段提交：按「删什么」块里的关键词推断（授权与邀请 → INV 无提交，只含区间的 `:365–370` 沿用前一块；历史 → C2、记录办理 / 知会异议 → C6、代录 → C3、括号里的变更包区间并入同一块 → C5；「单行」这种有文字但没有关键词的块标签为空）');
  const R = 'wbs-server/routes/sysbuild/';
  const ev = (labelText, extra) => ({ src: 'x:1', labelText, labels: labelsOf(labelText), unknown: unknownOf(labelText), guard: false, ambiguous: false, ambReason: '', group: 'api', ...(extra || {}) });
  const ed = (file, line, endLine, status) => ({ file: R + file, status: status || 'ok', line, endLine: endLine === undefined ? line : endLine });
  const mj = (evs, edits) => judgeMutation({ group: 'api' }, evs, del, edits || []);
  check(mj([ev('HIS')], [ed('history.js', 5)]).verdict === '只测停用（删）', '变异初判：标签只含可删标签 + 目标文件全属整删文件 → 只测停用（删）');
  check(mj([ev('ENT')], [ed('rules.js', 460, 470)]).verdict === '只测停用（删）' && mj([ev('ENT')], [ed('rules.js', 460, 470)]).inRanges === true, '变异初判：标签只含可删标签 + 编辑整个落在删除段 → 只测停用（删）');
  check(mj([ev('ENT')], [ed('rules.js', 900)]).verdict === '待定', '变异初判：标签只含可删标签但编辑不在删除段、也不是整删文件 → 待定');
  check(mj([ev('KEEP')], [ed('history.js', 5)]).verdict === '守保留规则（改挂）' && mj([ev('KEEP、HIS')], [ed('history.js', 5)]).verdict === '守保留规则（改挂）', '变异初判：标签含 KEEP → 守保留规则（改挂），即使目标文件是整删文件');
  check(mj([ev('', { guard: true })], [ed('packages.js', 1)]).verdict === '守保留规则（改挂）' && mj([]).verdict === '待定', '变异初判：来源是守护保留规则小节 → 改挂；没有证据 → 待定');
  // MEDIUM-2：每个编辑的完整覆盖区间与完整仓库相对路径
  check(mj([ev('ENT')], [ed('rules.js', 460, 470), ed('rules.js', 900)]).verdict === '待定' && mj([ev('ENT')], [ed('rules.js', 460, 470), ed('rules.js', 458, 460)]).verdict === '只测停用（删）', 'M2：多个编辑里有一个落在删除段外 → 不判全落删除段（待定）；全部落在删除段 → 只测停用');
  const cr = mj([ev('ENT')], [ed('rules.js', 500, 520)]);
  check(cr.verdict === '待裁定（编辑未核实）' && cr.unverified.length === 1 && cr.cov[0].cover === 'cross', 'M2：区间跨越删除段边界（500–520 越过 456–505）→ 跨界，未核实 → 标签只含可删标签却不判删，待裁定（编辑未核实）（旧版落到「待定」，没有明确的待裁定标记）');
  check(mj([ev('ENT')], [ed('rules.js', 460, 470, '定位字面量重复')]).verdict === '待裁定（编辑未核实）' && mj([ev('ENT')], [{ file: R + 'rules.js', op: 'replace', status: '定位字面量取不到' }]).verdict === '待裁定（编辑未核实）', 'M2：锚点重复 / 字面量取不到 → 未核实编辑 → 待裁定（编辑未核实）');
  check(mj([ev('ENT')], [{ file: 'wbs-server/other/rules.js', op: 'replace', status: 'ok', line: 460, endLine: 460 }]).verdict === '待定', 'M2：完整仓库相对路径核对：同名文件在别的目录（wbs-server/other/rules.js）不算 routes/sysbuild/rules.js 的删除段');
  check(mj([ev('HIS')], [ed('history.js', 5), ed('rules.js', 360)]).verdict === '只测停用（删）' && mj([ev('HIS')], [ed('history.js', 5), ed('rules.js', 900)]).verdict === '待定', 'M2：整删文件与删除段混合：每个编辑各自被整删文件或删除段覆盖 → 才算全覆盖');
  // HIGH-5：同一变异的全部证据先汇总再分类
  const guardEv = ev('', { guard: true, src: 'g:1' });
  const delEv = ev('HIS', { src: 'd:1' });
  const hj = mj([guardEv, delEv], [ed('history.js', 5)]);
  check(hj.verdict === '待裁定（证据冲突）' && hj.conflict.keep[0].startsWith('g:1') && hj.conflict.del[0].startsWith('d:1'), 'H5 回归：守护保留规则小节证据 + 只测停用证据（HIS、目标整删文件）同时存在 → 待裁定（证据冲突），列出两边来源');
  check(mj([guardEv], [ed('history.js', 5)]).verdict === '守保留规则（改挂）' && mj([guardEv, ev('HIS', { src: 'd:1' })], [ed('packages.js', 1)]).verdict === '守保留规则（改挂）', 'H5：守护小节证据 + 标签是只含可删标签、但编辑不全落删除段（不算只测停用证据）→ 改挂；单独的守护证据 + 整删文件 → 改挂，不再被「只测停用」抢先');
  const l5 = mj([guardEv, ev('HIS', { src: 'd:1' })], [ed('packages.js', 1)]);
  check(l5.verdict === '守保留规则（改挂）' && l5.softConflict && l5.softConflict.keep.join() === 'g:1' && l5.softConflict.del[0].startsWith('d:1') && mj([guardEv], [ed('history.js', 5)]).softConflict === null, 'L5：守护证据与「只含可删标签」的证据并存、编辑没全落删除段 → 初判仍是改挂，但带 softConflict（备注里写冲突）；没有只含可删标签的证据时没有');
  // MED-1：本表标题自身标明 C / 拿不准 / A 时覆盖上级标题继承的守护标记
  const ocC = mj([ev('', { guard: true, origClass: 'C', src: 'c:1' })], []);
  check(ocC.verdict === '待裁定（原件 C 类）' && mj([ev('', { guard: true, origClass: 'A', src: 'a:1' })], []).verdict === '待裁定（原件 A 类）' && mj([ev('', { guard: true, origClass: 'C' }), guardEv], []).verdict === '守保留规则（改挂）', 'MED-1：守护小节里本表标题标明 C（拿不准）的行 → 待裁定（原件 C 类）、标明 A → 待裁定（原件 A 类），不凭上级标题改挂；同 id 另有明确守护行时改挂优先');
  check(origClassOf('4.5 拿不准的变异（C）') === 'C' && origClassOf('3.2 C：守护「收口前置里的未结登记阻塞」，目标属保留文件 plan.js') === 'C' && origClassOf('组 16（920–972）C（倾向 A）') === 'A' && origClassOf('3.5 A（不算）') === 'A' && origClassOf('4. 守护保留规则的变异') === '' && origClassOf('3.1 明确守护保留规则（目标文件 entries-core.js）') === '', 'MED-1：origClassOf：只看本表标题自身的 C / 拿不准 / 倾向 A / A 标注，上级标题与普通标题不算');
  const caseU = judgeCase({ testedText: 'CHG；ZZZ', setupText: '', origCat: '' });
  check(caseU.verdict === '待裁定（未知标签词）' && caseU.affected.join() === '5' && caseAssign(caseU) === 'unassigned' && caseAssign({ verdict: '整删', affected: [3] }) === 'assigned', 'MED-3：初判以「待裁定」开头的用例，即使已有受影响提交也一律算待分派');
  check(fuzzyHow('C4b Q-S2：包类型表漏需求确认节点', '包类型表漏需求确认节点') === '前缀：+原件 id' && fuzzyHow('C6a parent 不对结项包填写（结项包…）', 'C6a parent 不对结项包填写') === '原件 id +（…）' && fuzzyHow('C4b Q-S2：K1：包类型表把需求确认节点指向立项包（对拍）', 'K1：包类型表把需求确认节点指向立项包') === '前缀：+原件 id 原件 id +（…）' && fuzzyHow("C2-0 S0 登记片段字面量含 =（status = 'a=b'）", 'C2-0 S0 登记片段字面量含 =（status = \\') === '原件 id 被截断（「（」没闭合）' && fuzzyHow('完全不相干的主表 id', '包类型表漏需求确认节点') === null && fuzzyHow('X：太短的id', '太短的id') === null && fuzzyHow('甲乙丙丁戊己庚辛', '乙丙丁戊己庚') === null, 'H2：fuzzyHow：前缀「：」+ 原件 id、原件 id +「（…）」、两者并存、截断的原件 id 都认；少于 6 个字符、前后不是「：」/「（」的子串不认');
  check(mj([delEv, ev('KEEP', { src: 'k:1' })], [ed('history.js', 5)]).verdict === '待裁定（证据冲突）' && mj([ev('', { ambiguous: true, ambReason: '多余的单元格 2 个' }), guardEv], []).verdict === '守保留规则（改挂）' && mj([ev('', { ambiguous: true })], []).verdict === '待裁定（解析歧义）', 'H5：同 id 另一行标 KEEP 也与只测停用证据冲突；守护证据优先于歧义证据；仅歧义 → 待裁定（解析歧义）');
  check(mj([ev('KEEP；ZZZ')], []).verdict === '待裁定（未知标签词）' && mj([ev('RPT')], []).verdict === '守保留规则（改挂）', 'M6：主标签含未知词的证据 → 待裁定（未知标签词）；RPT 算保留类 → 改挂');
  // 合成原件
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-disp-'));
  try {
    const inv = path.join(dir, 'inv');
    fs.mkdirSync(inv);
    fs.writeFileSync(path.join(inv, 'del-inv-tests-1.md'), [
      '## 1. sysbuild-api-suite-golive.js', '', '### 三、用例', '',
      '| 序 | 用例编号 / 标题 | 行号范围 | 被测的流程标签 | 搭数据用到的流程标签 | 测什么（一句话） |', '|---|---|---|---|---|---|',
      '| 1 | C6a 上线：统一上线判据 | 207-268 | KEEP、CHG | KEEP | x |',
      '| 2 | C6a 上线：交接集合 | 510-569 | HND、ENT | ENT | y |',
      '| 3 | 不存在的用例 | 600-610 | KEEP | KEEP | z |', '',
      '### 四、变异', '', '| # | 变异名 | 改的源文件 | 锚点字面量（from，截断） | 流程标签 |', '|---|---|---|---|---|',
      '| 1 | 变异甲 | history.js | x | HIS |', '| 2 | 变异乙 | rules.js | y | KEEP |', '| 3 | 只在原件里有的变异 | rules.js | z | ENT |', '',
    ].join('\n'));
    fs.writeFileSync(path.join(inv, 'del-inv-tests-2.md'), [
      '#### sysbuild-browser-suite.js 自有场景', '', '| 场景 | 行号 | 被测 | 搭数据（API 夹具） | 说明 |', '|---|---|---|---|---|',
      '| 文字按原文显示 | 10-20 | KEEP | — | |', '| 邀请窄范围入口 | 21-30 | INV | INV | |', '',
      '#### sysbuild-browser-suite.js 自有 FRONT_MUTATIONS（2 条）', '', '| # | 变异 id | 改的前端文件 | 锚点 | 命中场景（expect） | 流程标签（机器预标） |', '|---|---|---|---|---|---|',
      '| 1 | text-sink | sysbuild-ui.js | n.textContent | 文字按原文显示 | KEEP |', '',
    ].join('\n'));
    fs.writeFileSync(path.join(inv, 'del-inv-tests-3.md'), [
      '# sysbuild-api-suite-items.js 取证结果', '', '## 1. 用例组总表', '',
      '| 序号 | 标题（截短） | 行号范围 | 类别 | 一句话依据 |', '|---|---|---|---|---|', '| 1 | 条目创建：编号 | 171-193 | A | 只测条目编号 |', '| 2 | 条目新版本：沿用附件 | 457-517 | C | 夹带 |', '',
      '## 4. 守护保留规则的变异', '', '### 4.4 读接口（目标在 packages.js）', '', '| 变异 id | 目标源文件 | 定位字面量（截前 80 字） | 守护什么 |', '|---|---|---|---|',
      '| 守护乙 | packages.js | x | 包唯一性 |', '',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, '删除清单.md'), delText);
    // 合成仓库：变异的编辑要能在目标文件里找到定位字面量（74 HIGH-3：编辑状态先于「整删文件命中」核实，目标文件读不到的编辑不再被整删文件覆盖）
    fs.mkdirSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'history.js'), 'x\n');
    fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'rules.js'), 'y\n');
    const input = loadInput(inv);
    check(input.cases.length === 7 && input.caseTables === 3 && input.mutTables === 3 && input.muts.length === 5, '取表：用例表 3 张（7 行）、变异表 3 张（5 行）；变异表不当用例表');
    check(input.cases[0].file === 'sysbuild-api-suite-golive.js' && input.cases[3].file === 'sysbuild-browser-suite.js' && input.cases[5].file === 'sysbuild-api-suite-items.js' && input.cases[5].origCat === 'A', '取行：文件取标题层级里最近的套件文件名；tests-3 的类别列取原件分类');
    const gd = input.muts.find((r) => r.id === '守护乙');
    check(gd.guard === true && gd.group === 'api' && gd.file === 'sysbuild-api-suite-items.js' && input.muts.find((r) => r.id === 'text-sink').group === 'browser' && input.muts.find((r) => r.id === '变异甲').group === 'api', 'M5：标题「4.4 … packages.js」里的目标文件不当套件文件（文件取上级「# sysbuild-api-suite-items.js」）；上级标题「4. 守护保留规则的变异」带出 guard；组由套件文件名定');
    const master = [
      { group: 'api', id: '变异甲', files: [R + 'history.js'], expect: ['C6a 上线：统一上线判据'], edits: [{ op: 'replace', file: R + 'history.js', from: 'x' }] },
      { group: 'api', id: '变异乙', files: [R + 'rules.js'], expect: ['C6a 上线：交接集合'], edits: [{ op: 'replace', file: R + 'rules.js', from: 'y' }] },
      { group: 'api', id: '守护乙', files: [R + 'packages.js'], expect: ['条目创建'], edits: [] },
      { group: 'api', id: '主表独有的变异', files: [R + 'rules.js'], expect: ['x'], edits: [] },
      { group: 'browser', id: 'text-sink', files: ['wbs-server/public/assets/js/sysbuild-ui.js'], expect: ['文字按原文显示'], edits: [] },
    ];
    const GF = 'sysbuild-api-suite-golive.js';
    const IF = 'sysbuild-api-suite-items.js';
    const names = { api: [{ name: 'C6a 上线：统一上线判据——a', files: [GF] }, { name: 'C6a 上线：交接集合——b', files: [GF] }, { name: '条目创建：编号 R-01', files: [IF] }, { name: '条目新版本：沿用附件——c', files: [IF] }], browser: [{ name: '文字按原文显示', files: ['sysbuild-browser-suite.js'] }, { name: '邀请窄范围入口', files: ['sysbuild-browser-suite.js'] }], schema: [] };
    const g = build(input, master, names, del, dir);
    check(g.caseRowsOut.map((r) => r.verdict).join() === '要拆,要拆（跨提交）,不受影响,不受影响,第一步不动,整删,待裁定', '用例初判：七行逐行结果（第 2 行 HND、ENT 跨 C4 / C6 → 要拆（跨提交））');
    check(g.caseRowsOut[0].match.status === '对上' && g.caseRowsOut[2].match.status === '对不上' && g.caseRowsOut[3].match.status === '对上', '用例名对账：真实名单里有的对上，没有的对不上');
    const mv = g.mutOut.map((m) => m.verdict + '|' + (m.nEv ? 'o' : '-')).join();
    check(mv === '只测停用（删）|o,守保留规则（改挂）|o,守保留规则（改挂）|o,待定|-,守保留规则（改挂）|o', '变异初判：甲=只测停用、乙与守护乙与 text-sink=改挂、主表独有=待定且标「原件无」');
    check(g.mutOut[0].affected.join() === '2,5' && g.mutOut[0].sources.labels.join() === '2' && g.mutOut[0].sources.files.join() === '2' && g.mutOut[0].sources.hosts.join() === '5', 'H4：变异甲的受影响提交 = 标签 HIS（C2）∪ 整删文件 history.js（C2）∪ 承接用例（统一上线判据，KEEP+CHG → C5）= C2、C5；跨来源去重');
    check(g.mutOut[1].affected.join() === '4,6' && g.mutOut[1].sources.hosts.join() === '4,6' && g.mutOut[1].assign === 'assigned', 'H4：变异乙标 KEEP（改挂）、承接用例是「交接集合」（HND、ENT 跨提交）→ 受影响 C4、C6');
    check(g.mutOut[2].assign === 'unassigned' && g.mutOut[2].hosts === 1 && /承接它的用例自己还待分派/.test(g.mutOut[2].pendingWhy), 'H4：守护乙的承接用例是 tests-3 的 A 类（没有标签、没有提交，自己待分派）→ 守护乙不判不受影响，进待分派并写明原因');
    check(g.mutOut[3].assign === 'unassigned' && /原件无证据/.test(g.mutOut[3].pendingWhy) && g.mutOut[4].assign === 'unaffected' && g.mutOut[4].affected.length === 0, 'H4：主表独有的变异（无证据、无承接）→ 待分派；text-sink 的承接场景「文字按原文显示」不受影响 → 不受影响');
    const gNoHost = build(input, [{ group: 'api', id: '变异乙', files: [R + 'rules.js'], expect: ['无此用例'], edits: [] }], names, del, dir);
    check(gNoHost.mutOut[0].hosts === 0 && gNoHost.mutOut[0].labels.join() === 'KEEP' && gNoHost.mutOut[0].affected.length === 0 && gNoHost.mutOut[0].assign === 'unassigned' && /^仅凭标签、未找到承接用例/.test(gNoHost.mutOut[0].pendingWhy) && g.mutOut[4].assign === 'unaffected', 'H4（裁定）：原件标签全是保留类（KEEP）、但 expect 找不到承接用例 → 不判不受影响，进待分派，原因「仅凭标签、未找到承接用例」；有承接用例且都不受影响的（text-sink）仍是不受影响');
    check(g.unmatchedOrig.length === 1 && g.unmatchedOrig[0].id === '只在原件里有的变异' && g.dupClaims.length === 0, '对不上主表的原件变异行：只有「只在原件里有的变异」；没有重复归属');
    const lines = render(g, input, { generatedAt: 'T', head: 'H' }, del);
    const text = lines.join('\n') + '\n';
    const c1 = checkOutput(text, input, master, g);
    check(c1.problems.length === 0 && c1.nCase === 7 && c1.nMut === 5 && c1.nUn === 1, '反向校验：用例逐行对应、主表每条变异恰好一行、对不上的原件行合计核得上、按提交取行与明细一致 → 0 问题');
    check(/## 六、按提交取行/.test(text) && /\| C5 \| [^|]*del-inv-tests-1\.md:\d+[^|]* \| [^|]*M0001[^|]* \|/.test(text), 'H4：输出有「按提交取行」一节，C5 行列出受影响含 C5 的用例（原件位置）与变异（编号）');
    check(/## 七、待分派/.test(text) && /\| M0004 \| api \| 主表独有的变异 \|/.test(text), 'H4：输出有「待分派」一节，列出无法分派的变异（M0004）');
    const lostCase = text.split('\n').filter((l) => !(l.startsWith('| del-inv-tests-1.md:') && l.includes('交接集合') && l.includes('HND'))).join('\n');
    check(checkOutput(lostCase, input, master, g).problems.some((p) => p.includes('应出现 1 次，实际 0 次')), '反向校验：输出丢一个用例行 → 报出');
    const lostMut = text.split('\n').filter((l) => !(l.startsWith('| api | 变异甲 |'))).join('\n');
    check(checkOutput(lostMut, input, master, g).problems.some((p) => p.includes('变异 api | 变异甲：主表 1 条，输出 0 行')), '反向校验：输出丢一条变异行 → 报出');
    const dupMut = text.replace(/(\| api \| 变异乙 \|[^\n]*\n)/, '$1$1');
    check(checkOutput(dupMut, input, master, g).problems.some((p) => p.includes('变异 api | 变异乙：主表 1 条，输出 2 行')), '反向校验：输出重复一条变异行 → 报出');
    const lostUn = text.replace(/\| del-inv-tests-1\.md:\d+ \| sysbuild-api-suite-golive\.js \| 只在原件里有的变异[^\n]*\n/, '');
    check(checkOutput(lostUn, input, master, g).problems.some((p) => p.includes('合计与原件变异表数据行总数核不上')), '反向校验：「对不上主表的行」一节丢一行 → 合计核不上');
    const i6 = text.indexOf('## 六、按提交取行');
    const tamper = text.slice(0, i6) + text.slice(i6).replace(/(\| C5 \| )([^|]*)(\|)/, (m0, a, b, c) => a + b.replace(/del-inv-tests-1\.md:\d+/, 'del-inv-tests-1.md:999') + c);
    check(tamper !== text && checkOutput(tamper, input, master, g).problems.some((p) => p.includes('「按提交取行」C5 的用例列')), 'H4 回读：「按提交取行」里 C5 的用例被改 → 与明细表对不上 → 问题');
    const tamper2 = text.replace(/(\| api \| 变异甲 \|[^\n]*\| )C2、C5( \|)/, '$1C2$2');
    check(tamper2 !== text && checkOutput(tamper2, input, master, g).problems.some((p) => p.includes('「按提交取行」C5 的变异列')), 'H4 回读：变异明细行的受影响提交被改（少 C5）→ 与「按提交取行」对不上 → 问题');
    const tamper3 = text.replace(/(\| del-inv-tests-1\.md:\d+ \| C6a 上线：统一上线判据 \| [^\n]*?\| )要拆( \|)/, '$1整删$2');
    check(tamper3 !== text && checkOutput(tamper3, input, master, g).problems.some((p) => p.includes('与按被测 / 搭数据 / 原件分类重算的')), 'H3 回读：用例明细的初判被改（要拆 → 整删）→ 与按标签重算的对不上 → 问题');
    const tamper4 = text.replace(/(\| del-inv-tests-1\.md:\d+ \| 不存在的用例 \| [^\n]*?\| KEEP \| )KEEP( \|)/, '$1HIS$2');
    check(tamper4 !== text && checkOutput(tamper4, input, master, g).problems.some((p) => p.includes('应出现 1 次，实际 0 次')) && checkOutput(tamper4, input, master, g).problems.some((p) => p.includes('重算')), 'H3 回读：用例明细里搭数据标签被改（KEEP → HIS）→ 回读键对不上，且按标签重算的初判也对不上');
    // MEDIUM-3：重复归属
    const dupInput = { ...input, muts: input.muts.concat([{ ...input.muts[0], src: 'del-inv-tests-1.md:777' }]) };
    const dupMaster = master.concat([{ group: 'api', id: '变异甲', files: [R + 'history.js'], expect: ['x'], edits: [] }]);
    const gDup = build(dupInput, dupMaster, names, del, dir);
    check(gDup.dupClaims.length === 2 && gDup.dupClaims.every((d) => d.same) && gDup.mutOut[5].nEv === 2 && gDup.mutOut[0].nEv === 2 && checkOutput(render(gDup, dupInput, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', dupInput, dupMaster, gDup).problems.length === 0, 'M3：同一（组, id）在主表里出现两次、原件里也有两行 → 两条主表变异都用两行当证据，每个原件行被同一键重复使用（只记警告，不算跨键重复归属）');
    const crossInput = { ...input, muts: input.muts.concat([{ ...input.muts.find((r) => r.id === '变异甲'), file: 'foo.js', group: '' }]) };
    const crossMaster = master.concat([{ group: 'static', id: '变异甲', files: [], expect: [], edits: [] }]);
    const gCross = build(crossInput, crossMaster, names, del, dir);
    check(gCross.dupClaims.some((d) => !d.same) === true && /重复归属/.test(checkOutput(render(gCross, crossInput, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', crossInput, crossMaster, gCross).problems.join('；')), 'M3：组未定的原件行被两个不同的组（api、static）的同 id 主表变异同时当证据 → 重复归属（问题）');
    check(g.mutOut[0].otherGroup.length === 0 && build({ ...input, muts: input.muts.map((r) => (r.id === '变异乙' ? { ...r, group: 'static' } : r)) }, master, names, del, dir).mutOut[1].nEv === 0, 'M3：原件行的组（static）与主表变异的组（api）不符 → 不当证据（原件无），并在备注里写出「同 id 在其他组」');
    // HIGH-1：expect 在真实名单里命中的全部真实用例名，每个都要有承接行
    const hostCase = { src: 'x:1', file: 'sysbuild-api-suite-golive.js', name: '新鲜用例：甲', lines: '1', testedText: 'KEEP', setupText: 'KEEP', origCat: '', why: '', heading: '', ambiguous: false, ambReason: '' };
    const keepMut = { src: 'x:2', file: 'sysbuild-api-suite-golive.js', group: 'api', id: '某KEEP变异', labelText: 'KEEP', labels: ['KEEP'], unknown: [], guard: false, origClass: '', placeholder: false, heading: '', ambiguous: false, ambReason: '' };
    const hostInput = { ...input, cases: input.cases.concat([hostCase]), muts: input.muts.concat([keepMut]) };
    const hostMaster = [{ group: 'api', id: '某KEEP变异', files: [R + 'rules.js'], expect: ['新鲜用例'], edits: [] }];
    const names2 = { ...names, api: names.api.concat([{ name: '新鲜用例：甲', files: [GF] }, { name: '新鲜用例：乙', files: [GF] }]) };
    const gH = build(hostInput, hostMaster, names2, del, dir);
    check(gH.mutOut[0].hostM === 2 && gH.mutOut[0].hostK === 1 && gH.mutOut[0].hosts === 1 && gH.mutOut[0].assign === 'unassigned' && /承接用例 1\/2 个未对上原件行/.test(gH.mutOut[0].pendingWhy), 'H1（预筛）：expect 命中 2 个真实用例名、只有 1 个有承接行（原件行）→ 待分派，原因「承接用例 1/2 个未对上原件行」，不判不受影响');
    const gH2 = build({ ...hostInput, cases: hostInput.cases.concat([{ ...hostCase, src: 'x:3', name: '新鲜用例：乙' }]) }, hostMaster, names2, del, dir);
    check(gH2.mutOut[0].hostK === 0 && gH2.mutOut[0].hostM === 2 && gH2.mutOut[0].assign === 'unaffected', 'H1（预筛）：两个真实用例名都有承接行、且都不受影响 → 不受影响');
    const gH3 = build({ ...hostInput, cases: input.cases.concat([{ ...hostCase, name: '鲜用例：甲' }]) }, hostMaster, { ...names, api: names.api.concat([{ name: '新鲜用例：甲', files: [GF] }]) }, del, dir);
    check(gH3.caseRowsOut[gH3.caseRowsOut.length - 1].match.status === '仅包含匹配' && gH3.mutOut[0].hostK === 0 && gH3.mutOut[0].assign === 'unassigned' && /仅包含匹配/.test(gH3.mutOut[0].pendingWhy), 'H1（预筛）：承接用例是「仅包含匹配」（用例名没精确对上）→ 不判不受影响，进待分派');
    const gH4 = build(hostInput, hostMaster, { ...names2, api: null, apiError: '炸' }, del, dir);
    check(gH4.mutOut[0].assign === 'unassigned' && gH4.caseRowsOut[gH4.caseRowsOut.length - 1].match.status === '未对账', 'H1（预筛）：真实名单读取失败 → 承接用例都是未对账，不判不受影响');
    // HIGH-2：受控模糊匹配、兄弟表继承前缀、守护小节仍对不上主表 → 问题
    const mkO = (src, id, extra) => ({ src, file: 'sysbuild-api-suite-routing.js', group: 'api', id, labelText: '', labels: [], unknown: [], guard: true, origClass: '', placeholder: false, prefixInherited: false, heading: '3.2', targets: ['rules.js'], ambiguous: false, ambReason: '', ...extra });
    const fInput = { ...input, muts: [mkO('f:1', '包类型表漏需求确认节点'), mkO('f:2', 'C6a parent 不对结项包填写'), mkO('f:3', "C2-0 S0 登记片段字面量含 =（status = \\", { guard: false }), mkO('f:4', '太短的id'), mkO('f:5', '共同的原件说明文字'), mkO('f:6', '（无明确条目）', { placeholder: true }), mkO('f:7', '完全没有对应的守护行')] };
    const RF = [R + 'rules.js'];
    const fMaster = [
      { group: 'api', id: 'C4b Q-S2：包类型表漏需求确认节点（说明）', files: RF, expect: [], edits: [] },
      { group: 'api', id: 'C6a parent 不对结项包填写（结项包引用…）', files: RF, expect: [], edits: [] },
      { group: 'api', id: "C2-0 S0 登记片段字面量含 =（status = 'a=b'）", files: RF, expect: [], edits: [] },
      { group: 'api', id: 'X：太短的id', files: RF, expect: [], edits: [] },
      { group: 'api', id: '甲：共同的原件说明文字', files: RF, expect: [], edits: [] },
      { group: 'api', id: '乙：共同的原件说明文字', files: RF, expect: [], edits: [] },
    ];
    const gF = build(fInput, fMaster, names, del, dir);
    check(gF.mutOut.slice(0, 3).every((m) => m.nEv === 1 && m.evs[0].fuzzy) && gF.mutOut[0].verdict === '守保留规则（改挂）' && gF.fuzzyPairs.length === 3, 'H2（预筛）：前缀+后缀并存、原件 id +（…）、原件 id 被截断三种模糊匹配都唯一命中 → 带上原件证据（守护小节的带守护证据，改挂），标「模糊匹配」，进模糊匹配清单');
    check(gF.mutOut[3].nEv === 0 && gF.mutOut[4].nEv === 0 && gF.mutOut[5].nEv === 0 && gF.mutOut[4].fuzzyCands.length === 1 && gF.mutOut[5].fuzzyCands.length === 1, 'H2（预筛）：原件 id 太短不参与；同一原件 id 被两条主表变异命中 → 都不采用，候选写进备注');
    check(gF.guardUnmatched.map((r) => r.src).join() === 'f:4,f:5,f:7' && gF.unmatchedOrig.some((r) => r.placeholder), 'H2（预筛）：守护小节里仍对不上主表的原件行（占位行除外）进 guardUnmatched');
    const ckF = checkOutput(render(gF, fInput, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', fInput, fMaster, gF);
    check(ckF.problems.filter((p) => p.includes('对不上主表（待人工挂接）')).length === 3, 'H2（预筛）：守护小节仍对不上主表的原件行 → 反向校验问题（退出码 1），占位行不算');
    const inv9 = path.join(dir, 'inv9');
    fs.mkdirSync(inv9);
    fs.writeFileSync(path.join(inv9, 'del-inv-tests-7.md'), ['# sysbuild-api-suite-routing.js 取证结果', '', '## 3 守卫保留规则的变异', '', '### 3.1 明确守护保留规则（目标文件 entries-core.js）', '', '| 变异 id（前缀 C5 分流：） | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|', '| 甲 | a.js | x | y | 1 |', '', '### 3.2 C：守护「某某」，目标属保留文件 plan.js', '', '| 变异 id | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|', '| 乙 | a.js | x | y | 2 |', ''].join('\n'));
    const in9 = loadInput(inv9);
    check(in9.muts.length === 2 && in9.muts[0].id === 'C5 分流：甲' && in9.muts[1].id === 'C5 分流：乙' && in9.muts[1].prefixInherited === true && in9.muts[0].origClass === '' && in9.muts[1].origClass === 'C' && in9.muts[1].guard === true, 'H2（预筛）：同一父小节里没写前缀的兄弟表沿用首表表头声明的前缀（3.2 → C5 分流：乙）；MED-1：3.2 标题标明 C → origClass = C，仍带守护标记');
    // MED-3：待裁定的变异，即使已有受影响提交也列入待分派
    const cMut = { ...keepMut, src: 'x:9', id: '待裁定变异', labelText: 'HIS', labels: ['HIS'], guard: true, origClass: 'C' };
    const gC = build({ ...input, muts: input.muts.concat([cMut]) }, [{ group: 'api', id: '待裁定变异', files: [R + 'history.js'], expect: [], edits: [{ op: 'replace', file: R + 'history.js', from: 'x' }] }], names, del, dir);
    check(gC.mutOut[0].verdict === '待裁定（原件 C 类）' && gC.mutOut[0].affected.join() === '2' && gC.mutOut[0].assign === 'unassigned' && /已有受影响提交 C2/.test(gC.mutOut[0].pendingWhy), 'MED-3：初判待裁定（原件 C 类）的变异，即使已有受影响提交（C2）也算待分派，原因里写出已有的受影响提交');
    // H2 / M2：断行的变异行并回上一行；多余的 | 在最后一列 / 在说明列；其他表算明确排除；孤立的 | 行落不到表 → 问题；歧义行 → 待裁定（解析歧义）
    const inv3 = path.join(dir, 'inv3');
    fs.mkdirSync(inv3);
    fs.writeFileSync(path.join(inv3, 'del-inv-tests-9.md'), [
      '#### sysbuild-api-suite-x.js', '',
      '| # | 变异名 | 改的源文件 | 锚点 | 流程标签 |', '|---|---|---|---|---|',
      '| 1 | 变异断 | rules.js | function f() {', '  return 1 | CHG |',
      '| 2 | 变异管 | rules.js | a || b | KEEP |', '',
      '| 序号 | 名 |', '|---|---|', '| 1 | 无关的表 |', '',
      '| 序号 | 标题 | 行号范围 | 被测 | 搭数据 | 说明 |', '|---|---|---|---|---|---|',
      '| 1 | 用例甲 | 1-2 | KEEP | HIS | 含 | 竖线 |', '| 2 | 用例乙 | 3-4 | KEEP | HIS | x |', '| 3 | 用例丙 | 5|6 | KEEP | HIS | x |', '',
      '孤立在表外的一行', '| 孤立 | 行 |', '',
    ].join('\n'));
    const in3 = loadInput(inv3);
    check(in3.muts.length === 2 && in3.muts[0].id === '变异断' && in3.muts[0].labels.join() === 'CHG' && in3.muts[1].labels.join() === 'KEEP', 'H2：断行的变异行并回上一行（标签 CHG 读对）；锚点里的 || 多出的单元格并回锚点列（标签 KEEP 读对）');
    check(in3.cases.length === 3 && in3.cases[2].lines === '5|6' && in3.cases[2].testedText === 'KEEP' && in3.cases[2].setupText === 'HIS' && in3.cases[2].ambiguous === true && /分派字段不同/.test(in3.cases[2].ambReason) && judgeCase(in3.cases[2]).verdict === '待裁定（解析歧义）', '74 H1（改自 M2）：多余的 | 在行号范围列里：右读（行号「5|6」、被测 KEEP、搭数据 HIS）与左读（行号「5」、被测「6」、搭数据 KEEP）的被测 / 搭数据 / 行号都不同 → 待裁定（解析歧义）；旧版靠「一边读得出标签」取右读，是在猜');
    check(in3.cases[0].ambiguous === true && judgeCase(in3.cases[0]).verdict === '待裁定（解析歧义）' && in3.cases[1].ambiguous === false, 'M2：多余的 | 在说明列里、被测 KEEP（左读）与右读的 HIS 都非空且不同 → 标歧义 → 用例初判「待裁定（解析歧义）」');
    const au3 = in3.audits[0];
    check(au3.uncovered.length === 1 && au3.caseT === 4 && au3.mutT === 3 && au3.other === 2 && au3.total === 10 && au3.continuation === 1, 'H2 审计：围栏外以 | 开头的非分隔行 10 行 = 用例表 4 + 变异表 3 + 排除的其他表 2 + 孤立 1；断行续行 1');
    const gB = build(in3, [], { api: null, browser: null, schema: null }, del, dir);
    const out3 = render(gB, in3, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    const ck3 = checkOutput(out3, in3, [], gB);
    check(ck3.problems.some((p) => p.includes('del-inv-tests-9.md') && p.includes('不在任何已解析的表里')) && ck3.problems.length === 1, 'H2 反向校验：落不到已解析表的 | 行 → 列为问题（退出码 1），其余对得上');
    // N1 / L-a：变异表表头带括号说明与「前缀 X」→ 读 id 补前缀；紧接着的另一张表不被吞进上一张；被排除的「其他表」表头含关键词又没有登记理由 → 问题
    const inv4 = path.join(dir, 'inv4');
    fs.mkdirSync(inv4);
    fs.writeFileSync(path.join(inv4, 'del-inv-tests-8.md'), [
      '### 3.1 明确守护保留规则（目标文件 entries-core.js）',
      '| 变异 id（前缀 C5 分流：） | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|',
      '| 撤销上线的批次仍算已上线 | entries-core.js | x | y | 1663 |', '| 上线事件取最早一条 | entries-core.js | x | y | 1665 |',
      '| 序 | 名 |', '|---|---|', '| 1 | a |', '',
      '| 统计 | 用例数 |', '|---|---|', '| 一 | 2 |', '',
    ].join('\n'));
    const in4 = loadInput(inv4);
    check(in4.muts.length === 2 && in4.muts[0].id === 'C5 分流：撤销上线的批次仍算已上线' && in4.muts[1].id === 'C5 分流：上线事件取最早一条' && in4.muts.every((m) => m.guard === true), 'N1：变异表表头 `变异 id（前缀 C5 分流：）`（带括号说明）也认作变异表，读 id 时补上前缀；标题含「守护保留规则」→ guard');
    check(in4.audits[0].uncovered.length === 0 && in4.audits[0].mutT === 3 && in4.audits[0].other === 4, 'L-a：变异表后紧接着的另一张表（无空行）不被吞进上一行，表头行照常识别；审计没有落不到表的行');
    const ck4 = checkOutput(render(build(in4, [], { api: null, browser: null, schema: null }, del, dir), in4, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', in4, [], null);
    check(ck4.problems.some((p) => p.includes('del-inv-tests-8.md:') && p.includes('统计 | 用例数') && p.includes('没有登记理由')) && !ck4.problems.some((p) => p.includes('序 | 名')), 'N1：被排除的「其他表」表头含「用例」又没有登记理由 → 问题；表头不含关键词的其他表不报');
    // HIGH-1：期望清单
    const filesOf = (d) => fs.readdirSync(d).filter((f) => /^del-inv-tests-.*\.md$/.test(f)).sort();
    const regFor = (d) => ({ files: filesOf(d), deletionList: '删除清单.md', tables: P.snapshotRegistry(d, filesOf(d), DISP_PARSE, (t) => ({ role: roleOf(t), reason: roleOf(t) === 'oth' ? '测试用的理由' : '' })) });
    const regA = regFor(inv);
    check(loadInput(inv, regA).regProblems.length === 0 && loadInput(inv, regA).regStats.tablesWant === 6 && loadInput(inv, regA).regStats.tablesGot === 6, 'H1：期望清单与原件一致 → 0 问题');
    // L1：登记 sha256 并核对；目录全集对比（多出的任何文件、含非 del-inv-tests-*.md 都报）；siblings 不报
    const regSha = { ...regA, sha256: Object.fromEntries(regA.files.map((f) => [f, P.sha256(path.join(inv, f))])) };
    check(loadInput(inv, regSha).regProblems.length === 0, 'L1：登记了 sha256 且原件未动 → 0 问题');
    const t1 = fs.readFileSync(path.join(inv, 'del-inv-tests-1.md'), 'utf8');
    fs.writeFileSync(path.join(inv, 'del-inv-tests-1.md'), t1 + '\n多一行\n');
    check(loadInput(inv, regSha).regProblems.some((p) => p.includes('del-inv-tests-1.md') && p.includes('sha256 与登记不符')), 'L1：原件被改动 → sha256 与登记不符 → 问题');
    fs.writeFileSync(path.join(inv, 'del-inv-tests-1.md'), t1);
    fs.writeFileSync(path.join(inv, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(inv, 'del-inv-backend-1.md'), 'x');
    check(loadInput(inv, regA).regProblems.some((p) => p.includes('多出未登记的取证文件') && p.includes('notes.txt')) && loadInput(inv, regA).regProblems.some((p) => p.includes('del-inv-backend-1.md')) && !loadInput(inv, { ...regA, siblings: ['del-inv-backend-1.md'] }).regProblems.some((p) => p.includes('del-inv-backend-1.md')), 'L1：目录里多出一个不叫 del-inv-tests-*.md 的文件 → 也报；同批其他原件（siblings）不报');
    fs.unlinkSync(path.join(inv, 'notes.txt'));
    fs.unlinkSync(path.join(inv, 'del-inv-backend-1.md'));
    // L3：输出 5.3 逐张列出全部「其他表」的理由
    const reg3 = regFor(inv3);
    const in3r = loadInput(inv3, reg3);
    const g3r = build(in3r, [], { api: null, browser: null, schema: null }, del, dir);
    const out3r = render(g3r, in3r, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(/### 5\.3 被排除的「其他表」/.test(out3r) && /\| del-inv-tests-9\.md:\d+ \| [^|]*\| 序号 \\\| 名 \| 1 \| 测试用的理由 \|/.test(out3r) && !checkOutput(out3r, in3r, [], g3r).problems.some((p) => p.includes('其他表')), 'L3：输出 5.3 逐张列出全部其他表（含表头不含关键词的 `序号 | 名`）与理由，校验通过');
    check(checkOutput(out3r.replace('| 测试用的理由 |', '|  |'), in3r, [], g3r).problems.some((p) => p.includes('没有登记的排除理由')), 'L3：5.3 里某张其他表没有理由 → 问题');
    const regGone = { ...regA, files: regA.files.concat(['del-inv-tests-0.md']), tables: regA.tables.concat([['del-inv-tests-0.md', 'x', '用例 | 行号', 'case', '']]) };
    const pf = loadInput(inv, regGone).regProblems;
    check(pf.some((p) => p.includes('缺文件') && p.includes('del-inv-tests-0.md')) && pf.some((p) => p.includes('缺表') && p.includes('del-inv-tests-0.md')), 'H1：期望文件不在目录里 → 缺文件 + 它名下的表缺表');
    fs.writeFileSync(path.join(inv, 'del-inv-tests-4.md'), '# sysbuild-api-suite-q.js\n\n| 用例 | 行号 | 被测 | 搭数据 | 说明 |\n|---|---|---|---|---|\n| q | 1 | KEEP | KEEP | |\n');
    const pe = loadInput(inv, regA).regProblems;
    check(pe.some((p) => p.includes('多出未登记的取证文件') && p.includes('del-inv-tests-4.md')) && pe.some((p) => p.includes('多出未登记的表')), 'H1：目录里多出未登记的文件 / 表 → 问题');
    fs.unlinkSync(path.join(inv, 'del-inv-tests-4.md'));
    const regMiss = { ...regA, tables: regA.tables.filter((e) => !/变异 id/.test(e[2])).concat([['del-inv-tests-3.md', '不存在的标题', '用例 | 行号', 'case', '']]) };
    const pt = loadInput(inv, regMiss).regProblems;
    check(pt.some((p) => p.startsWith('缺表')) && pt.some((p) => p.startsWith('多出未登记的表')), 'H1：登记的表原件里没有 → 缺表；原件里的表没登记 → 多出未登记的表');
    const regRole = { ...regA, tables: regA.tables.map((e) => (/变异 id/.test(e[2]) ? [e[0], e[1], e[2], 'oth', 'x'] : e)) };
    check(loadInput(inv, regRole).regProblems.some((p) => p.includes('表角色不符') && p.includes('登记为 oth，按表头判为 mut')), 'H1：登记角色与按表头判出的不符（变异表被登记成 oth）→ 问题');
    const regHeader = { ...regA, tables: regA.tables.map((e) => (/场景 \| 行号/.test(e[2]) ? [e[0], e[1], e[2] + ' | 多一列', e[3], e[4]] : e)) };
    check(loadInput(inv, regHeader).regProblems.length >= 2, 'H1：表头被换（标题不变、规范化表头不同）→ 同时报缺表与多出未登记的表（身份是 文件 + 标题 + 表头，不是行号）');
    // 原件里把已登记的 oth 表换成一张表头未满足用例表识别条件的「用例表」：旧白名单按文件名 + 行号沿用理由，新的按标题 + 表头核
    const inv7 = path.join(dir, 'inv7');
    fs.mkdirSync(inv7);
    const t9 = ['### 总计', '', '| 统计 | 用例数 |', '|---|---|', '| 一 | 2 |', ''];
    fs.writeFileSync(path.join(inv7, 'del-inv-tests-5.md'), t9.join('\n'));
    const reg7 = { files: ['del-inv-tests-5.md'], deletionList: 'x.md', tables: P.snapshotRegistry(inv7, ['del-inv-tests-5.md'], DISP_PARSE, () => ({ role: 'oth', reason: '统计表' })) };
    check(loadInput(inv7, reg7).audits[0].suspectOther.length === 0 && loadInput(inv7, reg7).audits[0].whitelisted.length === 1, 'H1：登记过理由的其他表（表头含「用例」）→ 不报');
    fs.writeFileSync(path.join(inv7, 'del-inv-tests-5.md'), ['### 总计', '', '| 用例名 | 行号 | 说明 |', '|---|---|---|', '| 一 | 2 | x |', ''].join('\n'));
    const r7 = loadInput(inv7, reg7);
    check(r7.regProblems.length >= 2 && r7.audits[0].suspectOther.length === 1, 'H1：同一个标题下表头换成「用例名 | 行号 | 说明」（没有被测 / 类别列，不满足用例表条件）→ 缺表 + 多出未登记的表，且旧理由不沿用（按行号沿用的旧白名单会漏）');
    check(DISP_TABLES.length === 91 && EXPECTED_FILES.length === 3 && DISP_TABLES.every((e) => e.length === 5 && ['case', 'mut', 'oth'].includes(e[3]) && (e[3] !== 'oth' || e[4].length > 10)), 'H1：内置期望清单：3 个文件、91 张表，oth 的理由逐张登记（长度 > 10）');
    check(DISP_TABLES.filter((e) => e[3] === 'oth' && OTHER_KEYWORD_RE.test(e[2])).length === 6, 'H1：表头含关键词的 oth 表 6 张（tests-1 总计、tests-2 条件更新登记 / 套件统计 / 源文件分布 / API 接线 / 浏览器接线）各有登记理由');
    // ════ 74 号复审（A 部分：解析器与去向表生成器）新增自检 ════
    const empty3 = { api: null, browser: null, schema: null };
    const caseHdr = ['| 用例 | 行号 | 被测 | 搭数据 | 说明 |', '|---|---|---|---|---|'];
    // HIGH-1：多余单元格，候选读法会改变分派字段 → 待裁定（解析歧义），不替人选读法
    const inv10 = path.join(dir, 'inv10');
    fs.mkdirSync(inv10);
    fs.writeFileSync(path.join(inv10, 'del-inv-tests-a.md'), ['#### sysbuild-api-suite-x.js', '', ...caseHdr, '| 原话反例 | 12 | KEEP | 分支说明 | HIS | 说明 |', '| 断在 KEEP | 20 | KEEP', '  | 紧随的完整行 | 30 | HIS | HIS | 说明 |', '| 普通行 | 40 | KEEP | KEEP | x |', '', '#### verify-sysbuild-schema.js 的 MUTATIONS（改的都是 routes/sysbuild/schema.js 里的字面量）', '', '| 行 | 变异 id | 命中用例前缀 | 锚点字面量（前 90 字） | 流程标签（机器预标） |', '|---|---|---|---|---|', '| 1 | 某结构变异 | 前缀 | lit | KEEP |', ''].join('\n'));
    const in10 = loadInput(inv10);
    check(in10.cases[0].name === '原话反例' && in10.cases[0].ambiguous === true && judgeCase(in10.cases[0]).verdict === '待裁定（解析歧义）' && /KEEP/.test(in10.cases[0].candText) && /HIS/.test(in10.cases[0].candText) && in10.audits[0].ambiguousRows >= 1, '74 H1（原话反例，经 loadInput）：被测 `KEEP | 分支说明` + 搭数据 HIS → 待裁定（解析歧义），不再取左读判「不受影响」；原文与两种读法保留（candText）');
    // HIGH-2：缩进的 | 行 + 欠宽的上一行 → 两条物理行都保留，边界待裁定
    check(in10.cases.length === 4 && in10.cases[1].name === '断在 KEEP' && in10.cases[1].ambiguous === true && in10.cases[2].name === '紧随的完整行' && in10.cases[2].ambiguous === true && /边界待裁定/.test(in10.cases[2].ambReason) && in10.cases[3].ambiguous === false && in10.cases[1].src !== in10.cases[2].src && judgeCase(in10.cases[2]).verdict === '待裁定（解析歧义）', '74 H2（经 loadInput）：断在 KEEP 的欠宽行与紧随其后的完整行各是一条用例行、各有自己的原件位置，两条都待裁定（解析歧义）；旧版把后者吞成续行，审计算覆盖、去向表里没有它的位置');
    const g10 = build(in10, [], empty3, del, dir);
    const out10 = render(g10, in10, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(in10.audits[0].uncovered.length === 0 && in10.audits[0].contPipe === 0 && /边界待裁定/.test(out10) && /原文：/.test(out10) && /候选读法：读法 1/.test(out10) && checkOutput(out10, in10, [], g10).problems.length === 0, '74 H2 / H1：第七节 7.1 对歧义用例输出原文、行号位置、候选读法；审计全覆盖、回读 0 问题');
    // HIGH-6 准备：没有「目标源文件」列的变异表，目标文件取表标题点名的文件名
    const sm = in10.muts.find((r) => r.id === '某结构变异');
    check(sm && sm.group === 'schema' && sm.targets.includes('schema.js'), '74 H6：没有目标源文件列的表（structure 变异表）取标题里点名的 routes/sysbuild/schema.js 作原件行的目标文件');
    // 未知词（整词识别）
    check(judgeCase({ testedText: 'KEEP；X', setupText: '', origCat: '' }).verdict === '待裁定（未知标签词）' && judgeCase({ testedText: 'KEEP', setupText: 'FEATURE_FLAG_12', origCat: '' }).verdict === '待裁定（未知标签词）' && judgeCase({ testedText: 'KEEP；S12 说明', setupText: '', origCat: '' }).verdict === '待裁定（未知标签词）', '74 M：被测 / 搭数据里的单字母词（X）、带数字的词（S12、FEATURE_FLAG_12）也算未知词 → 待裁定（未知标签词），单靠 KEEP 不得结论');
    // HIGH-3：编辑状态先于整删文件命中；非 replace 操作逐类处理；INV / 归属不明的删除段不当第一步删除范围
    const eo = editsOf(dir, { edits: [{ op: 'replace', file: R + 'history.js', from: 'x' }, { op: 'weird', file: R + 'history.js', from: null }, { op: 'create', file: R + 'zz_new.js', from: null }, { op: 'create', file: R + 'rules.js', from: null }, { op: 'remove', file: R + 'history.js', from: null }, { op: 'remove', file: R + 'gone.js', from: null }] }, new Map());
    check(eo.map((e) => e.status).join('|') === 'ok|未识别的编辑操作 weird|synthetic|合成文件路径在仓库里已存在|ok|目标文件读不到', '74 H3：editsOf 逐个编辑给状态（不再静默跳过非 replace）：replace ok；未识别操作；create 新建仓库里不存在的文件 = 合成（豁免）；create 的路径已存在 = 未核实；remove 真实存在的文件 ok；remove 不存在的 = 读不到');
    const wk = { file: R + 'history.js', op: 'replace', status: '定位字面量找不到' };
    const h3a = mj([ev('HIS')], [wk]);
    check(h3a.verdict === '待裁定（编辑未核实）' && h3a.cov[0].cover === 'bad' && h3a.cov[0].wholeFile === true && h3a.cov[0].commits.join() === '2' && h3a.unverified.length === 1, '74 H3 原话反例：整删文件里找不到定位字面量的替换——旧版整删文件命中先于编辑状态检查而判「只测停用（删）」；现在 bad 先行，待裁定（编辑未核实），仍记下整删文件的删除提交 C2');
    check(mj([ev('HIS')], [ed('history.js', 5), { file: R + 'history.js', op: 'weird', status: '未识别的编辑操作 weird' }]).verdict === '待裁定（编辑未核实）' && mj([ev('HIS')], [ed('history.js', 5), { file: R + 'zz_new.js', op: 'create', status: 'synthetic' }]).verdict === '只测停用（删）' && mj([ev('HIS')], [{ file: R + 'zz_new.js', op: 'create', status: 'synthetic' }]).verdict === '待定', '74 H3 原话反例：已覆盖的替换 + 一个未核实的其他操作 → 不判删（旧版跳过非 replace，照样判删）；合成文件的 create 整条豁免，不挡「只测停用」，只有 create 也不凑成「全覆盖」');
    const h3c = mj([ev('HIS')], [ed('rules.js', 340)]);
    check(h3c.verdict === '待裁定（编辑未核实）' && h3c.cov[0].cover === 'unowned' && /INV/.test(h3c.cov[0].why) && h3c.unverified.length === 1 && mj([ev('HIS')], [ed('rules.js', 550)]).cov[0].cover === 'unowned' && /没有可推断提交/.test(mj([ev('HIS')], [ed('rules.js', 550)]).cov[0].why), '74 H3 原话反例：落在 rules.js 337–347（只含 INV、第一步无删除提交）的编辑，旧版仍算 range，配上原件标签 HIS 即判删并排到 C2；现在 unowned（只含 INV / 删什么里没有关键词的段）→ 待裁定（编辑未核实）');
    check(mj([ev('HIS')], [{ file: R + 'history.js', op: 'remove', status: 'ok' }]).verdict === '只测停用（删）' && mj([ev('HIS')], [{ file: R + 'rules.js', op: 'remove', status: 'ok' }]).verdict === '待定' && mj([ev('HIS')], [{ file: R + 'gone.js', op: 'remove', status: '目标文件读不到' }]).verdict === '待裁定（编辑未核实）', '74 H3：remove 是真实文件的删除不是合成操作：整删文件 → 只测停用；保留文件 → 待定（删的是保留文件）；读不到 → 未核实');
    // 77 号 H2（主会话 11-20 裁定）：编辑所落删除区间的「删什么」块含保留类表述 / 非第一步标签（INV、SETUP、KEEP）→ 不推出删除，判待裁定（混合区间）；块内只有第一步可删标签的照旧（期望手写）
    const delMx = deletionInfo(['## 三、后端逐文件清单', '', '### 3.3 逐段删的文件', '', '| 文件（行数） | 删什么 | 留什么 | 约删 |', '|---|---|---|---|',
      '| `notify.js`（900） | 待办接口 14 类里的 7 类（待接受的邀请与授权、可提异议的改期知会、未办结记录、知会异议、评估未知） `:760–900` | 其余 | 140 |',
      '| `entries.js`（1200） | 知会异议端点 `:973–1044` | 其余 | 70 |',
      '| `plan.js`（600） | 完成阶段前置里的未办结记录 `:194–201` 与已转出批次 `:181–182` | 其余 | 10 |',
      '| `entries.js`（1200） | 办理动作（除更正、作废外的全部分支，`:618–817` 的大部分） | 更正、作废 | 150 |',
      '| `confirm.js`（500） | 撤回里的变更分支（`:374–377`、`:388–390`、`:401–412`、`:459–486` 的相应部分） | 其余 | 40 |', '', '## 四、库结构', ''].join('\n'));
    const mjx = (evs, edits) => judgeMutation({ group: 'api' }, evs, delMx, edits);
    const mxA = mjx([ev('ENT')], [ed('notify.js', 780, 790)]);
    check(mxA.verdict === '待裁定（混合区间）' && mxA.cov[0].cover === 'mixed' && mxA.cov[0].commits.join() === '5,6' && mxA.unverified.length === 0 && mxA.mixed.length === 1 && mxA.inRanges === false && /含非第一步标签 INV/.test(mxA.cov[0].why) && /:760–900「待办接口 14 类里的 7 类/.test(mxA.cov[0].why), '77 H2 INV+CHG+ENT+NTC 型：notify.js 780–790 落在「待办接口 …（授权邀请、可提异议、未办结、知会异议、评估）」块（标签 INV+CHG+ENT+NTC，含非第一步标签 INV）→ cover = mixed、提交 C5、C6 仍记下、verdict = 待裁定（混合区间）（旧版 range → 只测停用（删）），原因里写清区间原文位置');
    const mxD = mjx([ev('CHG')], [ed('rules.js', 122, 125)]);
    const mxDd = judgeMutation({ group: 'api' }, [ev('CHG')], del, [ed('rules.js', 122, 125)]);
    check(mxDd.verdict === '待裁定（混合区间）' && mxDd.cov[0].cover === 'mixed' && mxDd.cov[0].commits.join() === '5' && /含保留类表述「保留」/.test(mxDd.cov[0].why) && /:120–127「保留规则里的分支：变更包/.test(mxDd.cov[0].why) && mxD.verdict === '待定', '77 H2 M2014 型：编辑落在「保留规则里的分支：变更包（:120–127 …）」块（含「保留」）→ 待裁定（混合区间），提交 C5 仍记下；该文件不在 delMx 里则仍是待定');
    const mxB = mjx([ev('ENT')], [ed('entries.js', 980, 990)]);
    const mxC = mjx([ev('ENT')], [ed('plan.js', 195, 196)]);
    check(mxB.verdict === '只测停用（删）' && mxB.cov[0].cover === 'range' && mxB.cov[0].commits.join() === '6' && mxC.verdict === '只测停用（删）' && mxC.cov[0].cover === 'range' && mxC.cov[0].commits.join() === '6,8', '77 H2 对照组：块内只有第一步可删标签（ENT+NTC；ENT+MLT）的照旧判只测停用（删），不误伤');
    // 预筛 HIGH-1（2026-11-20）：「部分保留」写法——块文本含 除…外 / 大部分 / 部分 / 相应 / 对应 / 只剩 / 其余 / 以外 即混合区间（原型 = 冻结清单 entries.js :618–817、confirm.js 撤回里的变更分支）
    const mxE = mjx([ev('ENT')], [ed('entries.js', 740, 745)]);
    const mxF = mjx([ev('CHG')], [ed('confirm.js', 401, 405)]);
    check(mxE.verdict === '待裁定（混合区间）' && mxE.cov[0].cover === 'mixed' && mxE.cov[0].commits.join() === '6' && /含部分删除的限定词「除更正、作废外」/.test(mxE.cov[0].why) && /:618–817「办理动作（除更正、作废外的全部分支/.test(mxE.cov[0].why) && mxF.verdict === '待裁定（混合区间）' && mxF.cov[0].cover === 'mixed' && mxF.cov[0].commits.join() === '5' && /含部分删除的限定词「部分」|含部分删除的限定词「相应」/.test(mxF.cov[0].why), '预筛 HIGH-1：entries.js :618–817「办理动作（除更正、作废外的全部分支，… 的大部分）」块原文：编辑落在 740（作废分支所在位置）→ 待裁定（混合区间）、提交 C6 仍记下；confirm.js「撤回里的变更分支（… 的相应部分）」401–405 → 待裁定（混合区间）、提交 C5（旧版都是 range → 只测停用（删））');
    check(['除更正、作废外的全部分支', '的大部分', '里的办理部分', '的相应部分', '里的对应分支', '缩成只剩内容包确认', '其余', '除内容包外的对象类型', '以外的'].every((t) => /含部分删除的限定词/.test(mixedWhyOf(t, []))) && ['知会异议端点', '完成阶段前置里的未办结记录', '历史窗口', '办理动作'].every((t) => mixedWhyOf(t, []) === ''), '预筛 HIGH-1：限定词表 除…外 / 大部分 / 部分 / 相应 / 对应 / 只剩 / 其余 / 以外 各命中一次；纯删除块的写法（知会异议端点、未办结记录、历史窗口、办理动作）不命中');
    check(mjx([ev('KEEP')], [ed('notify.js', 780, 790)]).verdict === '守保留规则（改挂）' && mjx([ev('ENT')], [ed('notify.js', 780, 790), ed('entries.js', 980, 990)]).verdict === '待裁定（混合区间）' && mjx([ev('ENT')], [ed('entries.js', 980, 990), ed('plan.js', 195)]).verdict === '只测停用（删）' && mixedWhyOf('授权与邀请', ['INV']) !== '' && mixedWhyOf('完成阶段前置里的未办结记录', ['ENT']) === '' && /不删/.test(mixedWhyOf('这段不删', [])) && /第二步/.test(mixedWhyOf('第二步再说', [])), '77 H2：保留证据照旧优先判守保留规则；多个编辑里有一个混合区间 → 整条混合区间；混合词表：保留 / 不删 / 第二步 / 第三步 / 不动 / INV / SETUP / KEEP，无词则空');
    fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'notify.js'), '\n'.repeat(779) + 'MARKMIX\n');
    const gMx = build({ ...input, muts: [{ ...input.muts[0], id: '混合甲', labelText: 'ENT', labels: ['ENT'] }] }, [{ group: 'api', id: '混合甲', files: [R + 'notify.js'], expect: [], edits: [{ op: 'replace', file: R + 'notify.js', from: 'MARKMIX' }] }], names, delMx, dir).mutOut[0];
    check(gMx.verdict === '待裁定（混合区间）' && gMx.affected.join() === '5,6' && gMx.assign === 'unassigned' && gMx.open.some((o) => o.k === '混合区间') && /混合删除段/.test(gMx.pendingWhy) && gMx.open.some((o) => o.k === '初判待裁定') && !gMx.open.some((o) => o.k === '未核实编辑') && judgeMutation({ group: 'api' }, [ev('KEEP')], delMx, [ed('notify.js', 780, 790)]).mixed.length === 1, '77 H2（build）：混合区间的变异：已知受影响提交 C5、C6（取区间段的提交）、进待分派、来源「混合区间」与「初判待裁定」（不借「未核实编辑」），原因写「混合删除段」；其他判定（守保留）下混合区间只记录、不另起待裁定事项');
    const mH3 = [{ group: 'api', id: '变异甲', files: [R + 'history.js'], expect: ['C6a 上线：统一上线判据'], edits: [{ op: 'replace', file: R + 'history.js', from: 'NOT_THERE' }] }];
    const gH3x = build(input, mH3, names, del, dir);
    check(gH3x.mutOut[0].verdict === '待裁定（编辑未核实）' && gH3x.mutOut[0].affected.join() === '2,5' && gH3x.mutOut[0].assign === 'unassigned' && gH3x.mutOut[0].open.some((o) => o.k === '未核实编辑') && /已有受影响提交 C2、C5/.test(gH3x.mutOut[0].pendingWhy), '74 H3 / H4（build）：整删文件里字面量找不到 + 标签 HIS：已知受影响提交仍是 C2（整删文件）、C5（承接用例），但另有未核实编辑 → 同时在待分派里，来源「未核实编辑」');
    // HIGH-4：已知受影响提交 与 未核完事项 分开记；有未核完事项的变异同时进待分派并标来源，不被「已有受影响提交」抢先标成已分派
    const hisMut = { ...keepMut, src: 'x:5', id: '某HIS变异', labelText: 'HIS', labels: ['HIS'], targets: ['history.js'] };
    const hisInput = { ...hostInput, muts: [hisMut] };
    const hisMaster = [{ group: 'api', id: '某HIS变异', files: [R + 'history.js'], expect: ['新鲜用例'], edits: [{ op: 'replace', file: R + 'history.js', from: 'x' }] }];
    const gH4x = build(hisInput, hisMaster, names2, del, dir);
    const out4x = render(gH4x, hisInput, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(gH4x.mutOut[0].verdict === '只测停用（删）' && gH4x.mutOut[0].affected.join() === '2' && gH4x.mutOut[0].assign === 'unassigned' && gH4x.mutOut[0].hostK === 1 && gH4x.mutOut[0].open.map((o) => o.k).join() === '承接覆盖不足', '74 H4 原话反例：变异从 HIS 得到 C2（已知受影响提交），但承接它的用例 1/2 个没有对上原件行 → 仍 assigned 的旧结果会让它只进 C2 取行表、无须在第七节处理；现在同时待分派，来源「承接覆盖不足」');
    const ck4x = checkOutput(out4x, hisInput, hisMaster, gH4x);
    if (ck4x.problems.length) console.log('    （问题：' + ck4x.problems.join('；') + '）');
    check(/\| M0001 \| api \| 某HIS变异 \| 只测停用（删） \| C2 \| 承接覆盖不足 \|/.test(out4x) && /\| C2 \| [^|]*\| M0001 \| [^|]*\| 1 \| [^|]*\| M0001 \|/.test(out4x) && ck4x.problems.length === 0,'74 H4：第七节 7.2 列出该变异（已知受影响提交 C2、来源承接覆盖不足）；第六节 C2 行同时列出它并在「仍有未核完事项的变异」列标出；回读 0 问题');
    const dropped72 = out4x.split('\n').filter((l) => !l.startsWith('| M0001 | api | 某HIS变异 |')).join('\n');
    check(checkOutput(dropped72, hisInput, hisMaster, gH4x).problems.some((p) => p.includes('第七节 7.2 待分派变异')), '74 M 回读：第七节整行丢失 → 与计算结果对不上 → 问题（旧版没有对应校验）');
    // HIGH-5：真实用例带定义文件；按文件限定候选；归属不明的命中只算候选，不用于确认「不受影响」
    const nmF = [{ name: '短标题：乙套件用例', files: ['sysbuild-api-suite-b.js'] }, { name: '另一个：未知归属', files: [] }];
    check(matchName('短标题', nmF, 'sysbuild-api-suite-a.js').status === '对不上' && matchName('短标题', nmF).status === '对上' && matchName('短标题', nmF).fileOk === false && matchName('短标题', nmF, 'sysbuild-api-suite-b.js').fileOk === true && matchName('另一个', nmF, 'sysbuild-api-suite-a.js').status === '对上' && matchName('另一个', nmF, 'sysbuild-api-suite-a.js').fileOk === false, '74 H5：matchName 按原件行所在文件限定候选：甲套件的短标题在甲套件定义的用例里找不到 → 对不上（旧版在整份名单里找到乙套件的用例）；不限定文件 / 只在归属不明的候选里命中 → fileOk = false，只算候选');
    const hostA = { src: 'x:1', file: 'sysbuild-api-suite-a.js', name: '短标题', lines: '1', testedText: 'KEEP', setupText: 'KEEP', origCat: '', why: '', heading: '', ambiguous: false, ambReason: '' };
    const keepM2 = { ...keepMut, src: 'x:2', file: 'sysbuild-api-suite-a.js', id: '某KEEP变异2' };
    const inA = { ...input, cases: [hostA], muts: [keepM2] };
    const mA = [{ group: 'api', id: '某KEEP变异2', files: [R + 'rules.js'], expect: ['短标题'], edits: [] }];
    const gA1 = build(inA, mA, { ...empty3, api: [{ name: '短标题：乙套件用例', files: ['sysbuild-api-suite-b.js'] }] }, del, dir);
    check(gA1.caseRowsOut[0].match.status === '对不上' && gA1.mutOut[0].hosts === 0 && gA1.mutOut[0].hostK === 1 && gA1.mutOut[0].assign === 'unassigned', '74 H5 原话反例：甲套件有一条标 KEEP 的旧短标题，真实名单里只有乙套件的用例以它开头——旧版把甲套件的原件行当成乙套件用例的承接、判「承接齐全 + 不受影响」；现在甲套件行与乙套件用例对不上，变异 expect 命中的乙套件用例没有承接行 → 待分派');
    const gA2 = build(inA, mA, { ...empty3, api: [{ name: '短标题：乙套件用例', files: [] }] }, del, dir);
    const gA3 = build(inA, mA, { ...empty3, api: [{ name: '短标题：乙套件用例', files: ['sysbuild-api-suite-a.js'] }] }, del, dir);
    check(gA2.mutOut[0].hosts === 1 && gA2.mutOut[0].assign === 'unassigned' && /定义文件没有确认/.test(gA2.mutOut[0].pendingWhy) && gA3.mutOut[0].assign === 'unaffected', '74 H5：真实用例定义文件归属不明（files = []）→ 承接行只算候选，不用于确认「不受影响」，待分派、原因写明文件没确认；定义文件确认是甲套件、承接齐全且不受影响 → 不受影响');
    // HIGH-6：模糊匹配要求原件目标源文件与主表目标文件一致；无组记录不参与；反向计数按 原件位置 + 组
    const mkF = (src, id, extra) => ({ ...mkO(src, id, {}), guard: false, ...extra });
    const fz6Input = { ...input, muts: [mkF('t:1', '目标源文件不同的守护 id 甲', { targets: ['packages.js'] }), mkF('t:2', '无组的守护 id 乙', { group: '', targets: ['rules.js'] }), mkF('t:3', '目标一致的守护 id 丙', { targets: ['rules.js'] }), mkF('t:4', '没有目标依据的守护 id 丁', { targets: [] })] };
    const fz6Master = ['目标源文件不同的守护 id 甲', '无组的守护 id 乙', '目标一致的守护 id 丙', '没有目标依据的守护 id 丁'].map((s, i) => ({ group: 'api', id: 'C1：' + s, files: [R + (i === 0 ? 'attachments.js' : 'rules.js')], expect: [], edits: [] }));
    const gF6 = build(fz6Input, fz6Master, empty3, del, dir);
    check(gF6.mutOut[0].nEv === 0 && gF6.mutOut[1].nEv === 0 && gF6.mutOut[2].nEv === 1 && gF6.mutOut[3].nEv === 0 && gF6.fuzzyPairs.length === 1 && gF6.fuzzyPairs[0].origTargets.join() === 'rules.js' && gF6.manualFuzzy.length === 3 && /目标文件.*不一致/.test(gF6.manualFuzzy.find((x) => x.no === 'M0001').why) && /组未定/.test(gF6.manualFuzzy.find((x) => x.no === 'M0002').why) && /没有目标文件依据/.test(gF6.manualFuzzy.find((x) => x.no === 'M0004').why), '74 H6 原话反例：原件更新后一条针对 packages.js 的旧守护短编号，旧版只命中同组 attachments.js 变异就自动挂过去；现在目标文件不一致 / 没有目标依据 / 组未定都不自动挂接，列入 5.2b 人工挂接，只有目标一致的（M0003）采用');
    const out6 = render(gF6, fz6Input, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(/### 5\.2b/.test(out6) && /\| M0001 \| C1：目标源文件不同的守护 id 甲 \| t:1 \|/.test(out6) && checkOutput(out6, fz6Input, fz6Master, gF6).problems.filter((p) => /5\.2b|5\.2 /.test(p)).length === 0, '74 H6：输出 5.2b 列出人工挂接候选；回读按（主表编号 | 原件位置 | 原件 id）对拍 5.2 / 5.2b');
    const rcInput = { ...input, muts: [mkF('r:1', '同名原件标题丙丁', { targets: ['rules.js'] }), mkF('r:2', '同名原件标题丙丁', { group: 'browser', file: 'sysbuild-browser-x.js', targets: ['rules.js'] })] };
    const rcMaster = [{ group: 'api', id: 'C9：同名原件标题丙丁', files: [R + 'rules.js'], expect: [], edits: [] }, { group: 'browser', id: 'C9：同名原件标题丙丁', files: [R + 'rules.js'], expect: [], edits: [] }];
    check(build(rcInput, rcMaster, empty3, del, dir).fuzzyPairs.length === 2, '74 M：模糊匹配的反向计数按原件位置 + 组，不按 id 文字：两个不同组各自唯一的同名原件不再互相阻断（旧版按 id 计数，两条都不采用）');
    // MEDIUM：前缀继承绑定父节实例，冲突 / 顺序不明待裁定
    const hdrM = ['| 变异 id（前缀 甲前缀：） | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|'];
    const hdrM2 = ['| 变异 id（前缀 乙前缀：） | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|'];
    const hdrN = ['| 变异 id | 目标源文件 | 定位字面量 | 守护什么 | 行 |', '|---|---|---|---|---|'];
    const inv11 = path.join(dir, 'inv11');
    fs.mkdirSync(inv11);
    fs.writeFileSync(path.join(inv11, 'del-inv-tests-b.md'), ['# sysbuild-api-suite-p.js', '', '## 3 守护', '', '### 3.1 声明甲', '', ...hdrM, '| a1 | a.js | x | y | 1 |', '', '### 3.2 声明乙', '', ...hdrM2, '| b1 | a.js | x | y | 2 |', '', '### 3.3 没声明的兄弟', '', ...hdrN, '| c1 | a.js | x | y | 3 |', ''].join('\n'));
    const in11 = loadInput(inv11);
    check(in11.muts[0].id === '甲前缀：a1' && in11.muts[1].id === '乙前缀：b1' && in11.muts[2].id === 'c1' && in11.muts[2].ambiguous === true && /前缀继承待裁定/.test(in11.muts[2].ambReason) && /2 种前缀/.test(in11.muts[2].ambReason) && in11.muts[0].ambiguous === false, '74 M：同一父节声明了两种前缀（新增的显式前缀不替换首个前缀），后面未声明的兄弟表（c1）归哪个定不下来 → 前缀继承待裁定（旧版一直冠首个前缀「甲前缀：」）');
    fs.writeFileSync(path.join(inv11, 'del-inv-tests-b.md'), ['# sysbuild-api-suite-p.js', '', '## 3 守护', '', '### 3.1 先出现的未声明表', '', ...hdrN, '| c0 | a.js | x | y | 1 |', '', '### 3.2 声明甲', '', ...hdrM, '| a1 | a.js | x | y | 2 |', ''].join('\n'));
    const in11b = loadInput(inv11);
    check(in11b.muts[0].id === 'c0' && in11b.muts[0].ambiguous === true && /排在声明前缀/.test(in11b.muts[0].ambReason) && in11b.muts[1].id === '甲前缀：a1', '74 M：未声明的表排在声明前缀的表之前（表的顺序一变就不再继承）→ 前缀继承待裁定，不替人选');
    fs.writeFileSync(path.join(inv11, 'del-inv-tests-b.md'), ['# sysbuild-api-suite-p.js', '', '## 3 守护', '', '### 3.1 声明', '', ...hdrM, '| a1 | a.js | x | y | 1 |', '', '### 3.2 兄弟', '', ...hdrN, '| b1 | a.js | x | y | 2 |', '', '## 3 守护', '', '### 3.1 声明', '', ...hdrM2, '| a2 | a.js | x | y | 3 |', '', '### 3.2 兄弟', '', ...hdrN, '| b2 | a.js | x | y | 4 |', ''].join('\n'));
    const in11c = loadInput(inv11);
    check(in11c.muts.map((m) => m.id).join() === '甲前缀：a1,甲前缀：b1,乙前缀：a2,乙前缀：b2' && in11c.muts.every((m) => !m.ambiguous), '74 M：前缀继承绑定实际父节实例：两个标题文字相同的「## 3 守护」各自声明、各自继承（旧版按标题文字分组，第二个「## 3 守护」下的兄弟表错借第一个的前缀「甲前缀：」）');
    // MEDIUM：围栏按开启符的类型与长度闭合；未闭合的围栏报问题
    const inv12 = path.join(dir, 'inv12');
    fs.mkdirSync(inv12);
    fs.writeFileSync(path.join(inv12, 'del-inv-tests-c.md'), ['````', '```', ...caseHdr, '| 围栏里 | 1 | KEEP | KEEP | x |', '````', '', '#### sysbuild-api-suite-f.js', '', ...caseHdr, '| 围栏外 | 2 | KEEP | KEEP | y |', ''].join('\n'));
    const in12 = loadInput(inv12);
    check(in12.cases.length === 1 && in12.cases[0].name === '围栏外' && in12.audits[0].uncovered.length === 0 && in12.audits[0].unclosedFence === null, '74 M：四反引号围栏里的三反引号行不闭合它：围栏外的用例表照常解析（旧版把外层闭合后的表一起吞掉），审计也不漏');
    fs.writeFileSync(path.join(inv12, 'del-inv-tests-c.md'), ['```', ...caseHdr, '| 围栏里 | 1 | KEEP | KEEP | x |', ''].join('\n'));
    const in12b = loadInput(inv12);
    const g12b = build(in12b, [], empty3, del, dir);
    check(in12b.audits[0].unclosedFence === 1 && checkOutput(render(g12b, in12b, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', in12b, [], g12b).problems.some((p) => p.includes('没有闭合')), '74 M：围栏没闭合 → 不支持的写法，反向校验报问题（不静默吞掉后面的表）');
    // MEDIUM：删除清单每条整删 / 逐段记录要有可解析的归属 / 行区间
    const dlBad = deletionInfo(['## 二、判定口径', '', '| 停用项 | 标签 | 判为删除的范围 |', '|---|---|---|', '| S6 历史补录 | HIS | z |', '', '## 三、后端逐文件清单', '', '### 3.1 整文件删除', '', '| 文件 | 行数 | 属于 | 谁在引用 |', '|---|---|---|---|', '| `history.js` | 663 | S6 | x |', '| `noowner.js` | 1 | S9 | x |', '| `nos.js` | 1 | | x |', '', '### 3.3 逐段删的文件', '', '| 文件（行数） | 删什么 | 留什么 | 约删 |', '|---|---|---|---|', '| `rules.js`（1） | 授权 `:337–347` | 其余 | 10 |', '| `noseg.js`（1） | 整体重写（没写行号） | 其余 | 5 |', '', '## 四、库结构', ''].join('\n'));
    check(dlBad.problems.length === 2 && dlBad.problems.some((p) => /noowner\.js.*找不到标签/.test(p)) && dlBad.problems.some((p) => /nos\.js.*没有 S 编号/.test(p)) && dlBad.noRange.length === 1 && dlBad.noRange[0].file === 'noseg.js' && dlBad.whole.length === 3 && del.problems.length === 0 && del.noRange.length === 0, '74 M：删除清单 3.1 整删记录没有可解析归属（找不到 S 编号 / 标签）→ 各报一条问题；3.3 逐段记录读不出行区间的列在 noRange（generate 对照登记的预期清单核，不在登记里的报问题）');
    const delNR = { ...del, noRange: [{ file: 'schema.js', text: '见第四节' }, { file: 'index.js', text: '挂载' }] };
    const sc8 = judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [ed('schema.js', 5)]);
    const ixm = judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [ed('index.js', 5)]);
    // 预筛 LOW-2：remove 编辑与替换编辑同口径：schema.js → structural（C8，不推删、不进编辑未核实）；index.js → unowned（待裁定（编辑未核实））；其他保留文件的 remove 仍是 none（待定）
    const rmS = judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [{ file: R + 'schema.js', op: 'remove', status: 'ok' }]);
    const rmI = judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [{ file: R + 'index.js', op: 'remove', status: 'ok' }]);
    const rmD = judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [{ file: R + 'db.js', op: 'remove', status: 'ok' }]);
    check(rmS.verdict === '待定' && rmS.cov[0].cover === 'structural' && rmS.cov[0].commits.join() === '8' && rmS.unverified.length === 0 && rmI.verdict === '待裁定（编辑未核实）' && rmI.cov[0].cover === 'unowned' && rmD.verdict === '待定' && rmD.cov[0].cover === 'none' && judgeMutation({ group: 'api' }, [ev('ENT')], del, [{ file: R + 'schema.js', op: 'remove', status: 'ok' }]).cov[0].cover === 'none', '预筛 LOW-2：schema.js 的 remove → structural（C8，不推删）；index.js 的 remove → unowned（待裁定（编辑未核实））；db.js 这类其他保留文件的 remove 仍 none；清单里没有无区间记录时 schema.js 的 remove 仍 none（旧版 remove 一律 none，M2314 型之外的 schema / index 删除被当成「删保留文件」）');
    // 预筛 LOW-3：守护 / 保留证据与整删文件 / 已归属删除段并存 → 初判不变，备注写冲突
    const ecG = judgeMutation({ group: 'api' }, [ev('', { guard: true, src: 'g:9' })], del, [ed('history.js', 5)]);
    const ecK = judgeMutation({ group: 'api' }, [ev('KEEP', { src: 'k:9' })], del, [ed('rules.js', 460, 470)]);
    check(ecG.verdict === '守保留规则（改挂）' && ecG.editConflict && ecG.editConflict.keep.join() === 'g:9' && /history\.js（整删文件，提交 C2）/.test(ecG.editConflict.where[0]) && ecK.verdict === '守保留规则（改挂）' && ecK.editConflict && /rules\.js（已归属删除段 :460–470，提交 C6）/.test(ecK.editConflict.where[0]) && judgeMutation({ group: 'api' }, [ev('', { guard: true, src: 'g:9' })], del, [ed('history.js', 5), ed('packages.js', 1)]).editConflict === null && judgeMutation({ group: 'api' }, [ev('KEEP', { src: 'k:9' }), ev('HIS', { src: 'd:9' })], del, [ed('history.js', 5)]).editConflict === null, '预筛 LOW-3：守护 / KEEP 证据 + 编辑全落在整删文件 history.js（C2）/ 已归属删除段 rules.js 460–470（C6）→ 初判仍守保留规则（改挂），editConflict 写出证据来源与落点；有编辑不在删除范围 → 不写；已有只含可删标签的证据 → 是证据冲突，不重复写');
    check(sc8.verdict === '待定' && sc8.cov[0].cover === 'structural' && sc8.cov[0].commits.join() === '8' && sc8.unverified.length === 0 && judgeMutation({ group: 'api' }, [ev('ENT')], delNR, [ed('schema.js', 5), ed('rules.js', 460, 470)]).verdict === '待定' && (() => { fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'schema.js'), 'y\n'); const gS = build({ ...input, muts: [{ ...input.muts[0], id: '结构甲', labelText: 'ENT', labels: ['ENT'] }] }, [{ group: 'api', id: '结构甲', files: [R + 'schema.js'], expect: [], edits: [{ op: 'replace', file: R + 'schema.js', from: 'y' }] }], names, delNR, dir).mutOut[0]; return gS.verdict === '待定' && gS.affected.join() === '6,8' && !gS.open.some((o) => o.k === '未核实编辑'); })() && ixm.verdict === '待裁定（编辑未核实）' && ixm.cov[0].cover === 'unowned' && /只有文字描述/.test(ixm.cov[0].why) && judgeMutation({ group: 'api' }, [ev('ENT')], del, [ed('schema.js', 5)]).verdict === '待定', '74 H3（主会话裁定，已更正）：删除清单 3.3 对 schema.js 只有文字描述、没有行区间，库结构在 C8 是修改（删表与保留约束混在同一文件）→ schema.js 上状态 ok 的编辑只确定受影响提交 C8（structural），不判只测停用（判待定）、不判编辑未核实；index.js 的挂载按流程分到不同提交，仍 unowned（待裁定（编辑未核实））；清单里没有无区间记录时仍是「不在删除范围 → 待定」');
    // MEDIUM：登记的完整标题路径 / 所属文件错配；同批其他原件的存在与摘要
    const regPath = { ...regA, tables: regA.tables.map((e, i) => (i === 0 ? e.slice(0, 5).concat(['别的章节 › 假路径', e[6]]) : (i === 1 ? e.slice(0, 6).concat(['other.js']) : e))) };
    const rpm = loadInput(inv, regPath).regProblems;
    check(regA.tables.every((e) => e.length === 7) && rpm.filter((p) => p.startsWith('表归属错配')).length === 2 && rpm.some((p) => /完整标题路径登记为「别的章节 › 假路径」/.test(p)) && rpm.some((p) => /所属文件登记为「other\.js」/.test(p)) && loadInput(inv, regA).regStats.pathMismatch === 0, '74 M：登记带完整标题路径与所属文件，路径 / 所属文件对不上 → 表归属错配（身份与摘要都对得上时只有这里能发现）');
    const regSib = { ...regA, siblings: ['del-inv-backend-1.md'], sha256: { 'del-inv-backend-1.md': 'a'.repeat(64) } };
    check(loadInput(inv, regSib).regProblems.some((p) => p.includes('缺文件') && p.includes('del-inv-backend-1.md') && p.includes('同批')), '74 M：不归本生成器读的同批原件缺失 → 报缺文件（旧版只把它们当「允许出现」的名单）');
    fs.writeFileSync(path.join(inv, 'del-inv-backend-1.md'), 'x');
    check(loadInput(inv, regSib).regProblems.some((p) => p.includes('同批取证原件 del-inv-backend-1.md 的 sha256 与登记不符')), '74 M：同批其他原件摘要与登记不符 → 报问题（九份输入两个生成器各核一遍）');
    fs.unlinkSync(path.join(inv, 'del-inv-backend-1.md'));
    // MEDIUM：回读按 原件位置 + 组 + 编号 对拍来源 / 未匹配行 / 提交集合 / 第六节
    const swapUn = text.replace('| 只在原件里有的变异 |', '| 被换成的另一行 |');
    check(swapUn !== text && checkOutput(swapUn, input, master, g).problems.some((p) => p.includes('第五节对不上主表的原件行')), '74 M 回读：把「对不上主表」里的一行换成另一行、总数不变 → 按（原件位置 | 文件 | 变异名）对拍发现（旧版只核总数）');
    const lnA = text.split('\n').find((l) => l.startsWith('| api | 变异甲 | M0001 |'));
    const noSrc = text.replace(lnA, lnA.split(' | ').map((c, i) => (i === 6 ? '' : c)).join(' | '));
    check(noSrc !== text && checkOutput(noSrc, input, master, g).problems.some((p) => p.includes('变异 M0001 的原件来源与匹配结果不一致')), '74 M 回读：清掉变异明细里的原件来源 → 与匹配结果对不上 → 问题（旧版通过）');
    const t6 = text.split('\n');
    const i6c5 = t6.findIndex((l, i) => i > t6.findIndex((x) => x.startsWith('## 六、')) && l.startsWith('| C5 |'));
    t6[i6c5] = t6[i6c5].split(' | ').map((c, i) => (i === 2 ? '' : c)).join(' | ');
    const noC5 = t6.join('\n').replace(lnA, lnA.replace('C2、C5', 'C2'));
    const ckC5 = checkOutput(noC5, input, master, g).problems;
    check(noC5 !== text && ckC5.some((p) => p.includes('第六节 C5 的变异列与计算结果不一致')) && ckC5.some((p) => p.includes('变异 M0001 的受影响提交与计算结果不一致')), '74 M 回读：第六节与变异明细同时漏写同一提交 C5（两边互相对得上）→ 与计算结果对拍发现（旧版只让两者互相对拍，通过）');
    // 74 LOW / 75 LOW：头注释与第七节标题；--no-check 不再打印「通过」
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    check(/## 七、待分派 \/ 待裁定（[^）]*已有已知受影响提交/.test(text) && selfSrc.includes('并入全部夹具失效' + '提交') && !selfSrc.includes('「夹具最早失效' + '提交」之并集'), '74 LOW：第七节标题说明已有提交但仍有待裁定事项的行也在此节；头注释写「被测删除提交 ∪ 全部夹具失效提交」（代码并入全部夹具失效提交），不再写成与「夹具最早失效提交」的并集');
    check(DISP_TABLE_LOC.length === DISP_TABLES.length && DISP_TABLE_LINE.length === DISP_TABLES.length && REGISTRY.tables.every((e) => e.length === 8 && typeof e[5] === 'string' && typeof e[6] === 'string' && Number.isInteger(e[7]) && e[7] > 0) && P.EVIDENCE_SHA256 === REGISTRY.sha256 && REGISTRY.siblings.every((f) => !!REGISTRY.sha256[f]) && /^[0-9a-f]{64}$/.test(REGISTRY.deletionListSha256), '74 M：内置登记：每张表带完整标题路径 + 所属文件（7 项），八份原件（含 5 份同批）与删除清单都登记了 sha256');
    // ════ 76 号（74 号复审 A1）与 77 号（A2）的补充自检 ════
    // 76 MEDIUM-3：承接覆盖齐全（hostK = 0、承接行与真实用例定义文件对上），但承接用例自己 B 类去向未定 → 变异同时保留已知提交 C2 并列出该用例原件位置；裁定为 C7 后重建，C7 取行表补入该变异
    const bCase = { src: 'x:7', file: IF, name: '条目创建：编号', lines: '1', testedText: '', setupText: '', origCat: 'B', why: '', heading: '', ambiguous: false, ambReason: '' };
    const hisB = { ...keepMut, src: 'x:9', id: '某HIS变异B', labelText: 'HIS', labels: ['HIS'], targets: ['history.js'] };
    const namesB = { api: [{ name: '条目创建：编号 R-01', files: [IF] }], browser: null, schema: null };
    const masterB = [{ group: 'api', id: '某HIS变异B', files: [R + 'history.js'], expect: ['条目创建'], edits: [{ op: 'replace', file: R + 'history.js', from: 'x' }] }];
    const gBc = build({ ...input, cases: [bCase], muts: [hisB] }, masterB, namesB, del, dir);
    const outB = render(gBc, { ...input, cases: [bCase], muts: [hisB] }, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(gBc.mutOut[0].hostK === 0 && gBc.mutOut[0].hosts === 1 && gBc.caseRowsOut[0].match.fileOk === true && gBc.mutOut[0].affected.join() === '2' && gBc.mutOut[0].assign === 'unassigned' && gBc.mutOut[0].open.map((o) => o.k).join() === '承接用例待分派' && /x:7/.test(gBc.mutOut[0].pendingWhy) && /\| M0001 \| api \| 某HIS变异B \| 只测停用（删） \| C2 \| 承接用例待分派 \| [^|]*x:7/.test(outB), '76 M3（74 H4 原话路径）：承接用例已匹配成功（hostK = 0、定义文件对上），但它自己 B 类去向未定（原件位置 x:7）——变异同时保留已知提交 C2 并进待分派，来源「承接用例待分派」、原因列出该用例原件位置 x:7');
    const bCaseC7 = { ...bCase, origCat: '', testedText: 'ITEM' };
    const gB7 = build({ ...input, cases: [bCaseC7], muts: [hisB] }, masterB, namesB, del, dir);
    const outB7 = render(gB7, { ...input, cases: [bCaseC7], muts: [hisB] }, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(gB7.mutOut[0].affected.join() === '2,7' && gB7.mutOut[0].assign === 'assigned' && /\| C7 \| [^|]*\| M0001 \|/.test(outB7) && checkOutput(outB7, { ...input, cases: [bCaseC7], muts: [hisB] }, masterB, gB7).problems.length === 0, '76 M3：承接用例裁定为 C7（被测 ITEM）后重建：变异的受影响提交变为 C2、C7，第六节 C7 取行表补入该变异，不再待分派，回读 0 问题');
    // 76 MEDIUM-4：守护证据跨文件挂接的拒绝用例从真实守护小节经 loadInput 进入（先断言 guard === true、目标提取正确）
    const inv15 = path.join(dir, 'inv15');
    fs.mkdirSync(inv15);
    const gHdr = ['| 变异 id | 目标源文件 | 定位字面量 | 守护什么 |', '|---|---|---|---|'];
    fs.writeFileSync(path.join(inv15, 'del-inv-tests-g.md'), ['# sysbuild-api-suite-guard.js 取证结果', '', '## 4. 守护保留规则的变异', '', ...gHdr, '| 错文件的守护 id 甲 | packages.js | x | y |', '| 没有目标依据的守护 id 丁 |  | x | y |', '| 目标一致的守护 id 丙 | rules.js | x | y |', ''].join('\n'));
    fs.writeFileSync(path.join(inv15, 'del-inv-tests-h.md'), ['# 没有套件标题的取证', '', '## 守护保留规则的变异', '', ...gHdr, '| 无组的守护 id 乙 | rules.js | x | y |', ''].join('\n'));
    const in15 = loadInput(inv15);
    const byId = (s) => in15.muts.find((r) => r.id === s);
    check(in15.muts.length === 4 && in15.muts.every((r) => r.guard === true) && byId('错文件的守护 id 甲').targets.join() === 'packages.js' && byId('没有目标依据的守护 id 丁').targets.length === 0 && byId('目标一致的守护 id 丙').targets.join() === 'rules.js' && byId('无组的守护 id 乙').group === '' && byId('错文件的守护 id 甲').group === 'api', '76 M4 前置：四条守护行经 loadInput 从真实守护小节进入：guard === true、目标源文件提取正确（packages.js / 空 / rules.js）、无套件标题的一条组未定');
    const m15 = ['错文件的守护 id 甲', '无组的守护 id 乙', '目标一致的守护 id 丙', '没有目标依据的守护 id 丁'].map((s, i) => ({ group: 'api', id: 'C1：' + s, files: [R + (i === 0 ? 'attachments.js' : 'rules.js')], expect: [], edits: [] }));
    const g15 = build(in15, m15, empty3, del, dir);
    const out15 = render(g15, in15, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    check(g15.mutOut.map((m) => m.nEv).join() === '0,0,1,0' && g15.manualFuzzy.length === 3 && g15.guardUnmatched.map((r) => r.id).sort().join() === ['无组的守护 id 乙', '没有目标依据的守护 id 丁', '错文件的守护 id 甲'].sort().join() && g15.fuzzyPairs.length === 1 && /### 5\.1/.test(out15) && /\| M0001 \| C1：错文件的守护 id 甲 \|/.test(out15), '76 M4：守护行（guard === true）目标文件不一致 / 组未定 / 没有目标依据 → 都不自动挂接（旧自检用 guard = false 的构造器，只在非守护分支放宽跨文件挂接时仍通过）；它们留在 5.2b 人工挂接与 5.1 未挂接清单，只有目标一致的一条采用');
    // 76 LOW：头注释检查限定在文件头注释范围；夹具提交并集另用不同提交失效的多个夹具断言
    const headComment = selfSrc.split('\n').slice(0, selfSrc.split('\n').findIndex((l, i) => i > 0 && !/^\/\//.test(l) && l.trim() !== "'use strict';")).join('\n');
    check(headComment.length > 500 && headComment.includes('并入全部夹具失效' + '提交') && !headComment.includes('「夹具最早失效' + '提交」之并集') && !headComment.includes('检查限定在文件头注释范围'), '76 LOW：源码文本检查限定在文件头注释范围（不会从自身自检说明里命中正向短语）：头注释写了「并入全部夹具失效提交」');
    check(jc('HIS', 'ITEM、ENT').affected.join() === '2,6,7' && jc('KEEP', 'ITEM、ENT、HIS').affected.join() === '2,6,7' && jc('KEEP', 'ITEM、ENT、HIS').commit === 'C2', '76 LOW：提交并集用不同提交失效的多个夹具断言：被测 HIS（C2）+ 夹具 ITEM（C7）、ENT（C6）→ 受影响 C2、C6、C7；只有夹具失效时也全并入，所属提交取最早');
    // 77 MEDIUM-8：unowned / cross 把已确认的提交带进汇总
    const delMix = deletionInfo(['## 二、判定口径', '', '| 停用项 | 标签 | 判为删除的范围 |', '|---|---|---|', '| S6 历史补录 | HIS | z |', '', '## 三、后端逐文件清单', '', '### 3.3 逐段删的文件', '', '| 文件（行数） | 删什么 | 留什么 | 约删 |', '|---|---|---|---|', '| `r2.js`（120） | 授权保留 `:100–120`；历史删除 `:110–115` | 其余 | 1 |', '', '## 四、库结构', ''].join('\n'));
    fs.writeFileSync(path.join(dir, 'wbs-server', 'routes', 'sysbuild', 'r2.js'), Array.from({ length: 120 }, (_, i) => (i === 110 ? 'UNIQ111' : 'l' + (i + 1))).join('\n') + '\n');
    const gMix = build({ ...input, muts: [] }, [{ group: 'api', id: '混合段变异', files: [R + 'r2.js'], expect: [], edits: [{ op: 'replace', file: R + 'r2.js', from: 'UNIQ111' }] }], empty3, delMix, dir);
    const crossCov = coverOf(del, [ed('rules.js', 500, 520)])[0];
    check(gMix.mutOut[0].cov[0].cover === 'unowned' && gMix.mutOut[0].cov[0].commits.join() === '2' && gMix.mutOut[0].affected.join() === '2' && gMix.mutOut[0].open.some((o) => o.k === '未核实编辑') && crossCov.cover === 'cross' && crossCov.commits.join() === '6' && /落在没有可推断提交的删除段|只含 INV/.test(gMix.mutOut[0].cov[0].why), '77 M8：一条编辑同时落进「授权保留」（INV 段）与「历史删除」（HIS 段、C2）两个重叠区间 → unowned，但已归属段的提交 C2 汇总进受影响提交（没有其他 C2 来源时旧版漏出第六节的 C2），仍要人工裁定；跨界（500–520 越过 456–505 的 C6 段）同理带出 C6');
    // 77 MEDIUM-9：第七节 / 5.2 回读按章节与字段逐行核对
    const row72 = out4x.split('\n').find((l) => l.startsWith('| M0001 | api | 某HIS变异 |'));
    const tamp = (fn) => checkOutput(fn(out4x), hisInput, hisMaster, gH4x).problems;
    const c72 = row72.split(' | ');
    check(tamp((t) => t.replace(row72, row72.replace('| api |', '| static |'))).some((p) => p.includes('第七节 7.2')) && tamp((t) => t.replace(row72, row72 + '\n' + row72)).some((p) => p.includes('第七节 7.2')) && tamp((t) => t.replace(row72, row72.replace('| 只测停用（删） |', '| 守保留规则（改挂） |'))).some((p) => p.includes('第七节 7.2')) && tamp((t) => t.replace(row72, row72.replace(/ \| C2 \| 承接覆盖不足/, ' | C3 | 承接覆盖不足'))).some((p) => p.includes('第七节 7.2')) && tamp((t) => t.replace(row72, c72.slice(0, 6).join(' | ') + ' | 把原因改成了别的文字 |')).some((p) => p.includes('第七节 7.2')) && tamp((t) => t.replace('## 七、待分派', '## 九、待分派')).some((p) => p.includes('第七节 7.2')), '77 M9：第七节 7.2 逐字段核对：改组、重复一行、改机械初判、改已知受影响提交、改原因、把整节标题改成别的章节，都报（旧版只核编号集合与来源类别，保留 M0001 与来源就能通过）');
    const i6x = out4x.split('\n').findIndex((l) => l.startsWith('## 六、'));
    const row6 = out4x.split('\n').find((l, i) => i > i6x && /^\| C3 \|/.test(l)); // 第六节的 C3 行（1.2 汇总表里也有「| C3 |」开头的行）
    check(tamp((t) => t.split('\n').filter((l) => l !== row6).join('\n')).some((p) => p.includes('第六节 C3 应恰好出现 1 行')) && tamp((t) => t.replace(row6, row6 + '\n' + row6)).some((p) => p.includes('第六节 C3 应恰好出现 1 行')), '77 M9：第六节 C2–C8 每个提交要恰好一行：丢一行 / 重复一行都报');
    const row52 = out6.split('\n').find((l) => l.startsWith('| M0003 |') && /\| t:3 \|/.test(l));
    check(!!row52 && !checkOutput(out6, fz6Input, fz6Master, gF6).problems.some((p) => p.includes('5.2 模糊匹配清单')) && checkOutput(out6.replace(row52, row52.replace('rules.js', 'plan.js')), fz6Input, fz6Master, gF6).problems.some((p) => p.includes('5.2 模糊匹配清单')), '77 M9：5.2 的原件目标 / 主表目标两列纳入回读：把某对的目标文件改掉 → 报');
    // 77 MEDIUM-10：未挂接的歧义变异行进第五节，带物理行范围、歧义原因、原文、候选读法；回读核这些列
    const inv16 = path.join(dir, 'inv16');
    fs.mkdirSync(inv16);
    fs.writeFileSync(path.join(inv16, 'del-inv-tests-z.md'), ['#### sysbuild-api-suite-z.js', '', '| # | 变异名 | 改的源文件 | 锚点字面量 | 流程标签 |', '|---|---|---|---|---|', '| 1 | 歧义变异 | rules.js | a | HIS | KEEP |', ''].join('\n'));
    const in16 = loadInput(inv16);
    const g16 = build(in16, [], empty3, del, dir);
    const out16 = render(g16, in16, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n';
    const row16 = out16.split('\n').find((l) => l.startsWith('| del-inv-tests-z.md:5 |') && l.includes('歧义变异'));
    check(in16.muts[0].ambiguous === true && g16.unmatchedOrig.length === 1 && row16.includes('| 5 | 多余的单元格 1 个') && row16.includes('\\| 1 \\| 歧义变异 \\| rules.js \\| a \\| HIS \\| KEEP \\|') && row16.includes('| 读法 1（合上缝 3）') && checkOutput(out16, in16, [], g16).problems.length === 0 && checkOutput(out16.replace(row16, row16.split(' | ').map((c, i) => (i === 6 ? '' : c)).join(' | ')), in16, [], g16).problems.some((p) => p.includes('第五节对不上主表的原件行')), '77 M10：未挂接的歧义变异行进第五节：物理行 5、歧义原因、完整原文、候选读法一并输出，回读按这些列逐字段核对（清掉歧义原因 → 报）');
    // 77 LOW：区间文件计数只数区间数组非空的文件；无区间文件另列
    check(dlBad.rangeFiles.join() === 'rules.js' && dlBad.rangeCount === 1 && dlBad.ranges.has('noseg.js') && dlBad.ranges.size === 2 && del.rangeFiles.join() === 'rules.js' && del.rangeCount === 9 && /抽出行区间的有 1 个（区间 9 段）；只有文字描述、没有行区间的登记记录 0 个/.test(render(g, input, { generatedAt: 'T', head: 'H' }, del).join('\n')), '77 LOW：ranges 也登记只有文字描述的文件（ranges.size = 2），统计与非零校验改按区间数组非空的文件 / 区间数（rangeFiles = 1、rangeCount）；输出分别写区间文件数与无区间登记记录数');
    // 76 MEDIUM-1（生成器侧）：成对深缩进围栏标记夹着表 → 反向校验报原件位置
    const inv18 = path.join(dir, 'inv18');
    fs.mkdirSync(inv18);
    fs.writeFileSync(path.join(inv18, 'del-inv-tests-d.md'), ['#### sysbuild-api-suite-d.js', '', '    ~~~', '', ...caseHdr, '| 夹着的用例 | 1 | KEEP | KEEP | x |', '', '    ~~~', ''].join('\n'));
    const in18 = loadInput(inv18);
    const g18 = build(in18, [], empty3, del, dir);
    check(in18.cases.length === 1 && in18.cases[0].name === '夹着的用例' && checkOutput(render(g18, in18, { generatedAt: 'T', head: 'H' }, del).join('\n') + '\n', in18, [], g18).problems.some((p) => /del-inv-tests-d\.md:3–9 有缩进 ≥ 4/.test(p)), '76 M1（生成器）：成对缩进四格的围栏标记夹着一张顶层用例表：表照常解析（旧版整表被遮），反向校验报原件位置 3–9');
    // 76 MEDIUM-2（生成器侧）：登记带物理位置，原件里重复节错位 → 缺表 + 多出未登记的表
    const inv17 = path.join(dir, 'inv17');
    fs.mkdirSync(inv17);
    const posDoc = (gap) => ['# 总', '', '## 1. a.js', '', '### 三、说明', '', '| x | y |', '|---|---|', '| 1 | 2 |', '', '### 三、说明', '', gap + '| x | y |', '|---|---|', '| 3 | 4 |', ''].join('\n');
    fs.writeFileSync(path.join(inv17, 'del-inv-tests-p.md'), posDoc(''));
    const pp = '总 › 1. a.js › 三、说明';
    const regP = { files: ['del-inv-tests-p.md'], deletionList: 'x.md', tables: [['del-inv-tests-p.md', '三、说明', 'x | y', 'oth', '重复节的第一张', pp, '', 7], ['del-inv-tests-p.md', '三、说明', 'x | y', 'oth', '重复节的第二张', pp, '', 13]] };
    const okP = loadInput(inv17, regP);
    fs.writeFileSync(path.join(inv17, 'del-inv-tests-p.md'), posDoc('\n'));
    const badP = loadInput(inv17, regP).regProblems;
    check(okP.regProblems.length === 0 && okP.audits[0].others.map((o) => o.reason).join() === '重复节的第一张,重复节的第二张' && badP.some((p) => p.startsWith('多出未登记的表')) && badP.some((p) => p.startsWith('缺表')), '76 M2（生成器）：登记带表头行号（手写 7 / 13），重复节各按位置配上各自的理由；第二张表前多一行后位置对不上 → 多出未登记的表 + 缺表');
    const idsFile = path.join(dir, 'ids.json');
    const namesFile = path.join(dir, 'names.json');
    fs.writeFileSync(idsFile, JSON.stringify(master));
    fs.writeFileSync(namesFile, JSON.stringify(names));
    const regFile = path.join(dir, 'reg.json');
    fs.writeFileSync(regFile, JSON.stringify(regFor(inv)));
    const outFile = path.join(dir, 'out.md');
    const cli = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--deletion-list', path.join(dir, '删除清单.md'), '--ids-file', idsFile, '--names-file', namesFile, '--registry-file', regFile, '--repo', dir], { encoding: 'utf8' });
    check(cli.status === 0 && /结果：通过/.test(cli.stdout) && fs.readFileSync(outFile, 'utf8').includes('## 八、反向校验'), 'CLI：写出 markdown 并带反向校验段，退出码 0');
    fs.writeFileSync(regFile, JSON.stringify({ ...regFor(inv), files: regFor(inv).files.concat(['del-inv-tests-0.md']) }));
    const cliBad = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--deletion-list', path.join(dir, '删除清单.md'), '--ids-file', idsFile, '--names-file', namesFile, '--registry-file', regFile, '--repo', dir], { encoding: 'utf8' });
    check(cliBad.status === 1 && /缺文件/.test(cliBad.stdout), 'CLI：期望文件缺失 → 退出码 1');
    fs.writeFileSync(regFile, JSON.stringify({ ...regFor(inv), deletionListSha256: 'f'.repeat(64) }));
    const cliSha = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--deletion-list', path.join(dir, '删除清单.md'), '--ids-file', idsFile, '--names-file', namesFile, '--registry-file', regFile, '--repo', dir], { encoding: 'utf8' });
    check(cliSha.status === 1 && /删除清单.*sha256 与登记不符/.test(cliSha.stdout), '74 M CLI：删除清单的 sha256 与登记不符 → 退出码 1');
    fs.writeFileSync(regFile, JSON.stringify({ ...regFor(inv), deletionNoRange: ['登记了却不存在.js'] }));
    const cliNR = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--deletion-list', path.join(dir, '删除清单.md'), '--ids-file', idsFile, '--names-file', namesFile, '--registry-file', regFile, '--repo', dir], { encoding: 'utf8' });
    check(cliNR.status === 1 && /登记的无区间逐段记录 登记了却不存在\.js 在删除清单 3\.3 里没找到/.test(cliNR.stdout), '74 M CLI：登记的无区间逐段记录在删除清单里找不到 → 退出码 1（预期清单要同步更新）');
    fs.writeFileSync(regFile, JSON.stringify(regFor(inv)));
    const cliNo = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--deletion-list', path.join(dir, '删除清单.md'), '--ids-file', idsFile, '--names-file', namesFile, '--registry-file', regFile, '--repo', dir, '--no-check'], { encoding: 'utf8' });
    check(cliNo.status === 0 && /未执行反向校验/.test(cliNo.stdout) && !/结果：通过/.test(cliNo.stdout) && /未执行反向校验/.test(fs.readFileSync(outFile, 'utf8')), '75 LOW CLI：--no-check 控制台与输出文件都标「未执行反向校验」，不再打印「结果：通过」');
    check(spawnSync(process.execPath, [__filename], { encoding: 'utf8' }).status === 2, 'CLI：缺 --out 是用法错误（退出码 2）');
  } finally {
    try { removeTree(dir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + dir + ' — ' + e.message); }
  }
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = {
  mixedWhyOf, judgeCase, matchName, matchCase, namesFor, deletionInfo, segmentsOf, judgeMutation, coverOf, caseRows, mutRows, loadInput, build, render, checkOutput, roleOf, groupOfFile, DISP_TABLES, DISP_TABLE_LOC, DISP_TABLE_LINE, REGISTRY };
