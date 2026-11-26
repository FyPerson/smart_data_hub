'use strict';
// #212 第一步（C1c）生成器：逐行实施清单骨架（方案 v1.4 第一节「第一步专用范围」）。
//   输入：取证原件（del-inv-*.md 里带「标签」「流程标签」列的符号表）与仓库代码；输出：markdown（--out）。
//   只读：不改任何输入文件与仓库文件；唯一的写操作是 --out。机械分类只是初判，主会话逐行裁定。
//
// 用法：
//   node wbs-server/scripts/sysbuild-step1/build-impl-list.js --out <md> [--inv-dir <取证目录>] [--deletion-list <删除清单 md>] [--repo <仓库根>] [--registry-file <json>] [--no-check]
//   node wbs-server/scripts/sysbuild-step1/build-impl-list.js --self-test
//   退出码：反向校验不过 = 1；用法错误 = 2。
//   --registry-file 用文件里的期望清单（{ files, deletionList, tables }）代替内置的 REGISTRY（测试用）。
//
// 期望清单（HIGH-1）：内置 REGISTRY 登记「应有的 8 份取证原件 + 删除清单」（都登记 sha256）与「每张表的身份」（文件 + 所在标题 + 规范化表头 → 角色 sym / mut / nt + 理由，
//   另登记完整标题路径与所属文件，补「归属错配」自检：末级标题和表头相同、上级套件不同的表光靠身份分不开）。
//   核对：缺文件、多出未登记的 del-inv-*.md、缺表、多出未登记的表（含带标签列的表）、表的角色与按表头判出的不符、表的完整标题路径 / 所属文件与登记不符，都算问题（退出码 1）。
//   角色：sym = 本生成器逐行取的符号表（表头有名为「标签」或「流程标签」的列，且不是变异表）；mut = 变异表（归 build-test-disposition.js）；nt = 没有标签列的表（理由逐张登记，并逐张列在输出 1.5）。
//   有文件级去向的排除表（FILE_LEVEL，现有 sysbuild-history.js 整删）另生成可分派记录，输出 1.7，回读断言每条恰好一次；扫全部排除表找同类，扫到文件级表述却没登记的算问题。
//
// 取哪些表：表头里有名为「标签」或「流程标签」的列（不含「被测的流程标签」「搭数据用到的流程标签」「流程标签（机器预标）」这类带修饰的列名），
//   且不是变异表（表头含「变异名」「变异 id」「变异id」——变异归 build-test-disposition.js）。
//   每个数据行：文件 = 标题层级里离表最近的含 xxx.js / xxx.cjs / xxx.html 的标题（不跨同级章节沿用，见 inv-parse.js）；符号 = 第一列；行号 = 表头里第一个含「行」字的列；
//   说明 = 其余列（不含标签列与依据 / 备注 / 判断列）用 ' / ' 连接；判断依据 = 表头含「依据」「备注」「判断」的列原文。
//
// 机械分类（只是初判）。标签集合 = 标签单元格里全部大写标签词，括号之内的注记标签也算（「KEEP（CHG：含 'change'）」按 KEEP + CHG 计，同时在「主标签」「注记标签」两列里分开写出）。
//   保留类标签 = KEEP / INV / SETUP / RPT（RPT = 进度汇报，保留，见 inv-parse.js 头注释）；可删标签 = HIS / PRX / HND / CHG / ENT / NTC / ITEM / MLT：
//   · 解析器（inv-parse.js）报告这一行列边界定不下来（裸 | 不止一处、左右读法标签不同或行号列错位）→ 待裁定（解析歧义），保留原文与行号
//   · 括号之外有未知大写词（不论有没有已知标签）→ 待裁定（未知标签词），原文照抄，备注列写出未知词，汇总里单列
//   · 标签列取不出任何已知标签 → 待裁定（无标签）
//   · 只有保留类标签、不含可删标签 → 留（含 INV / SETUP：第二、三步）
//   · 只含可删标签（不含保留类标签）→ 删，所属提交取**最晚**的（被多个流程共用的符号要等最后一个使用者删掉才能删，方案第六节「最后删被依赖的」）：HIS→C2、PRX→C3、HND→C4、CHG→C5、ENT 与 NTC→C6、ITEM→C7、MLT→C8
//   · 其余混合 → 拆（待裁定），列出候选提交
//   明细另有一列「最早 / 最晚可删提交」，对所有带可删标签的行都写（待裁定行也写，仅供参考）。
//
// 三向反查（自动列，不替代人工反查；每一格的结果都是「命中（列位置）」「指定范围内无命中（范围）」「未覆盖（原因）」「反查失败（原因）」之一；各处输入的读取结果逐项记在输出 1.6）：
//   ① 读写方：符号里的标识符是该后端文件的导出名时，列 xref-exports.js report 里引用它的 文件:行（最多 6 处，总数另写）；范围 = xref-exports 的导出引用；
//      xref-exports 有任何文件扫描失败时，失败文件里可能有引用，「无引用」标「反查失败」（命中仍是命中）
//   ② 路由注册与路由挂载分开记：注册 = 「说明」或符号里出现 `GET|POST|PATCH|PUT|DELETE /sysbuild/...` 时，在该文件里找 router.<method>( 后跟该路径字面量的全部位置（方法调用与路径可以隔行）；
//      挂载 = index.js 里 use / mount / register 的调用（括号内可跨行，`router.use(\n  history.router\n)` 也找得到）里出现该文件的 require 或它的变量（含 `{ router: x } = require` 解构别名）；
//      index.js 读不到时挂载标「反查失败」，不写「指定范围内无命中」；同一对象的多个路由都查
//   ③ 用例夹具：在 wbs-server/scripts/lib/sysbuild-*.js 与 wbs-server/scripts/verify-sysbuild-*.js 两个目录里检索：全部导出名、全部含下划线的 snake_case 标识符（表名 / 事件类型 / 动作键，≥6 字符）、
//      全部路由路径里最后一个静态片段（排除 sysbuild 与 :动态段，≥5 字符），列「文件（命中次数）」；经中间夹具函数间接搭数据的用例不在这个范围内；
//      两个目录各自记录读取结果，任一目录没读全：没命中时标「反查失败」，有命中时命中照写并注明缺失目录未覆盖
//
// 汇总 1.1 另有一行「留（原件标拿不准）」（「留」的子集：标签单元格写着「拿不准」的行；明细备注列同样标出）；1.8 裁定清单把「留且拿不准」与「没有候选提交的待裁定」两类行带原件位置单列。
// 共享对象（分类「删」、带多个可删标签）整删时点取最晚提交，明细另有「全部候选复核提交」列，较早提交要先核对本对象对较早停用模块的依赖。
// 反向校验（--check，默认开启）：① 期望文件与期望表（见上）；② 原文围栏外每个以 | 开头的非分隔行都落在某张已解析表上（入选的表，或明确排除的两类：变异表、没有标签列的表），落不到的列为问题，原文有 | 行却一张表都没解析出来也是问题；
//   ③ 把写出的 markdown 重新解析，核对原件里每个入选表格数据行在输出里恰好出现一次（按 原件位置 + 文件 + 符号 + 行号 + 标签原文），并用原件行的标签原文与解析歧义标记重算期望，
//      逐行核输出的初判、所属提交、最早 / 最晚可删提交、全部候选复核提交，以及备注里的歧义说明是否与原件一致（不再从输出备注反推原件是否歧义）；
//   ④ 被排除的表在输出 1.5 里逐张有理由；⑤ 删除清单 v1.0 第三节列出的每个后端文件在输出的「文件总表」里都有（原件里没有逐行记录的文件标「无逐行记录」，只警告不判失败）；
//   ⑥ 文件级去向记录（1.7）每条恰好出现一次；裁定清单（1.8）与按原件标签重算的期望集合一致；⑦ 原件围栏没闭合 = 不支持的写法，判问题。
//   输出尾部写出校验结果（`--no-check` 时写「未执行反向校验」，不写「通过」）；输出开头带生成时刻、输入文件 sha256 前 12 位、仓库 HEAD。
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
const CLASSES = ['留', '删', '拆（待裁定）', '待裁定（无标签）', '待裁定（未知标签词）', '待裁定（解析歧义）'];
const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

// ── 期望清单 ───────────────────────────────────────────────────────────────────────────
// 生成时刻与来源：2026-11-19 21:5x（本机时间）从当时的取证原件（8 份 del-inv-*.md，mtime 11-19 12:45–13:25，sha256 前 12 位见生成输出头部）用 inv-parse.js 逐表解析生成一次，
//   按「文件 + 所在标题 + 规范化表头」列出 143 张表，角色（sym / mut / nt）按本文件的 roleOf 判出，nt 的理由逐张人工写成；生成后用生成器自身对原件反向核对（缺表 0、多出未登记 0、角色不符 0）才写死。
//   取证原件是冻结的证据；原件被改动（增删表、改标题或表头）时这里会报问题，需重新核对后更新本清单。
const EXPECTED_FILES = ['del-inv-backend-1.md', 'del-inv-backend-2.md', 'del-inv-backend-3.md', 'del-inv-backend-4.md', 'del-inv-guards.md', 'del-inv-tests-1.md', 'del-inv-tests-2.md', 'del-inv-tests-3.md'];
const EXPECTED_DELETION_LIST = '系统建设记录_流程简化_第一步_删除清单_20261119_v1.0.md';
const R_CASE = '用例表（被测 / 搭数据列带标签，但表头没有「标签」「流程标签」列）：不是符号表，归 build-test-disposition.js 的用例部分取行';
const R_GUARD = '守卫文件里引用停用流程标识的位置表（行号 | 引用的标识 | 这一处在做什么 | 删后怎样）：测试与守卫侧的引用登记，不是符号表，没有标签列；去向归测试去向表与守卫改造';
const R_MUT = '变异表（归 build-test-disposition.js）';
// [文件, 所在标题, 规范化表头, 角色(sym|mut|nt), 理由]；H_* 是反复出现的规范化表头
const H_SYM = '符号 | 行号 | 说明 | 标签 | 判断依据';
const H_SYMD = '符号 | 行号 | 说明 | 标签 | 依据';
const H_SYMF = '符号 | 行号 | 说明 | 流程标签 | 判断依据';
const H_FN = '函数 | 行号 | 渲染什么 / 接口 | 流程标签';
const H_HELP = '函数名 | 行号范围 | 调用的接口 / 数据来源 | 流程标签';
const H_CASE = '序 | 用例编号 / 标题 | 行号范围 | 被测的流程标签 | 搭数据用到的流程标签 | 测什么（一句话）';
const H_MUT1 = '# | 变异名 | 改的源文件 | 锚点字面量（from，截断） | 流程标签';
const H_MUT2 = '# | 变异名 | 改的源文件 | 锚点字面量（前 70 字） | 流程标签（机器预标）';
const H_MUT2B = '# | 变异 id | 改的前端文件 | 锚点字面量（前 70 字） | 命中场景（expect） | 流程标签（机器预标）';
const H_UC = '用例 | 行号 | 被测 | 搭数据 | 说明';
const H_T3 = '序号 | 标题（截短） | 行号 | 类别 | 一句话依据';
const H_G = '变异 id | 目标源文件 | 定位字面量（截前 80 字） | 守护什么';
const IMPL_TABLES = [
  ['del-inv-backend-1.md', '1.1 顶层符号（函数、常量）', H_SYM, 'sym', ''],
  ['del-inv-backend-1.md', '1.2 PROJECT_ACTION_TABLE 的每个键（225–241）', '键 | 行号 | 说明 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '1.3 OBJECT_OPS 的每个键（520–1289）', '键 | 行号 | 说明 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '1.4 OP_KIND 的每个键（1292–1380，值是项目状态类别）', '键 | 行号 | 值 | 标签', 'sym', ''],
  ['del-inv-backend-1.md', '2.1 顶层符号', H_SYMD, 'sym', ''],
  ['del-inv-backend-1.md', '2.2 ENUMS 的每个键（38–97，共 45 个）', '键 | 行号 | 取值概要 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '2.3 表（TABLES，共 42 张）', '表 | 行号 | 说明 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '2.4 索引（INDEXES，共 67 个）', '索引 | 行号 | 表 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '2.5 UPDATABLE_COLUMNS 的每一项（699–721）', '表 | 行号 | 可更新列 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '2.6 CONDITIONAL_UPDATES 的每一项（728–744）', '表.列 | 行号 | 条件片段 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '3.1 顶层符号', H_SYMD, 'sym', ''],
  ['del-inv-backend-1.md', '3.2 EVENT_TYPES 的每个事件类型', '事件类型 | 行号 | 说明 | 标签 | 依据', 'sym', ''],
  ['del-inv-backend-1.md', '4.1 顶层符号', H_SYMD, 'sym', ''],
  ['del-inv-backend-1.md', '5.1 顶层符号与挂载', H_SYMD, 'sym', ''],
  ['del-inv-backend-1.md', '6.1 顶层符号', H_SYMD, 'sym', ''],
  ['del-inv-backend-2.md', '1. entries.js（共 1049 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '2. entries-core.js（共 766 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '3. entries-routing.js（共 288 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '4. entry-forms.js（共 199 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '5. changes.js（共 332 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '6. items.js（共 493 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '7. assessment-view.js（共 38 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '8. submission-scope.js（共 229 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '9. report-core.js（共 221 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '10. report-recipients.js（共 26 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-2.md', '创建（POST /sysbuild/projects/:id/entries，entries.js:481–553）', '步骤 | 函数 / 位置 | 行号 | 说明', 'nt', '「创建一条记录」的调用链步骤表（步骤 | 函数 / 位置 | 行号 | 说明）：一次调用的叙述，没有标签列，不是逐符号表（符号表在第 1–10 节）'],
  ['del-inv-backend-3.md', '1. confirm.js（901 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '2. confirm-core.js（906 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '3. confirmation-sheet.js（683 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '4. packages.js（616 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '5. membership.js（939 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '6. membership-visibility.js（60 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '7. projects.js（558 行）', H_SYM, 'sym', ''],
  ['del-inv-backend-3.md', '确认任务的对象类型与用途（sysbuild_confirm_tasks）', 'object_type | purpose | 创建位置 | 流程标签 | 备注', 'sym', ''],
  ['del-inv-backend-4.md', '1. plan.js（890 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '2. golive.js（275 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '3. golive-core.js（653 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '4. history.js（663 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '5. notify.js（900 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '6. notify-core.js（155 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '7. notify-schedule.js（75 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '8. materials.js（152 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '9. materials-core.js（125 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '10. attachments.js（751 行，全部读完）', H_SYMF, 'sym', ''],
  ['del-inv-backend-4.md', '11. 待办接口的类别（notify.js，GET /sysbuild/my/todo，751–895 行）', '类别键 | 取数行号 | 取数来源 | 流程标签 | 说明', 'sym', ''],
  ['del-inv-backend-4.md', '12. 发送意图的用途与写入点', '用途（PURPOSES 键 / 值） | 写入点（文件:行，经哪个助手） | 发送时 notify.js 取内容的位置 | 流程标签', 'sym', ''],
  ['del-inv-guards.md', '实际读取范围', '文件 | 读了哪些行', 'nt', '「实际读取范围」：文件 | 读了哪些行，取证读取记录，没有符号与标签'],
  ['del-inv-guards.md', '2.2 引用停用流程标识的位置', '行号 | 引用的标识 | 这一处在做什么 | 删掉该流程后这一处会怎样', 'nt', R_GUARD],
  ['del-inv-guards.md', '2.3 附件 owner_type 用到情况（针对「用哪些 owner_type 挂附件」）', 'owner_type | 出现位置 | 属于停用清单', 'nt', 'owner_type 用到情况表（owner_type | 出现位置 | 属于停用清单）：附件挂载类型的盘点，没有「标签」列（用「属于停用清单」代替），不是符号表'],
  ['del-inv-guards.md', '5.4 写死的数量断言（补读范围内）', '行号 | 当前数字 | 内容', 'nt', '写死的数量断言表（行号 | 当前数字 | 内容）：守卫里的数量断言，没有标签列，归守卫改造'],
  ['del-inv-guards.md', '6.2 引用停用流程标识的位置', '行号 | 引用的标识 | 这一处在做什么 | 删掉该流程后这一处会怎样', 'nt', R_GUARD],
  ['del-inv-guards.md', '7. 汇总', '文件 | 停用流程标识引用位置条数 | 写死数量断言条数（表 / 事件 / 路由 / OBJECT_OPS 类） | 未读部分', 'nt', '「汇总」表（文件 | 引用位置条数 | 数量断言条数 | 未读部分）：计数汇总，没有符号行'],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'sym', ''],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'nt', R_CASE],
  ['del-inv-tests-1.md', '四、变异（GOLIVE_MUTATIONS，第 2660-2894 行，共 196 条）', H_MUT1, 'mut', R_MUT],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'sym', ''],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'nt', R_CASE],
  ['del-inv-tests-1.md', '四、变异（NOTIFY_MUTATIONS，第 2613-2890 行，共 239 条）', H_MUT1, 'mut', R_MUT],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'sym', ''],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'nt', R_CASE],
  ['del-inv-tests-1.md', '四、变异（CONFIRM_MUTATIONS，第 2382-2614 行，共 180 条）', H_MUT1, 'mut', R_MUT],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'sym', ''],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'nt', R_CASE],
  ['del-inv-tests-1.md', '四、变异（ENTRY_MUTATIONS，第 1971-2196 行，共 183 条）', H_MUT1, 'mut', R_MUT],
  ['del-inv-tests-1.md', '二、搭数据的共用函数', H_HELP, 'sym', ''],
  ['del-inv-tests-1.md', '三、用例', H_CASE, 'nt', R_CASE],
  ['del-inv-tests-1.md', '四、变异（MEMBERSHIP_MUTATIONS，第 1711-1801 行，共 78 条）', H_MUT1, 'mut', R_MUT],
  ['del-inv-tests-1.md', '总计', '文件 | 用例组数 | 变异数', 'nt', '「总计」表：每个套件的用例组数与变异数合计，是计数汇总'],
  ['del-inv-tests-2.md', '1.1 页签注册与路由注册', '页签键 | 显示名 | 注册位置 | 流程标签 | 说明', 'sym', ''],
  ['del-inv-tests-2.md', '1.1 页签注册与路由注册', '路由键 | 位置 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-ui.js（1-400 行，共用界面层）', '函数 / 位置 | 行号 | 渲染什么 / 调用接口 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-page.js（1-487 行）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-members.js（1-164 行）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-evidence.js（1-171 行，附件与确认单）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-entries.js（1-374 行，登记、办理、知会）', '函数 / 常量 | 行号 | 渲染什么 / 接口 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-plan.js（1-253 行，排期、收口、交接）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-confirm.js（1-205 行，确认任务页）', '函数 / 常量 | 行号 | 渲染什么 / 接口 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-content.js（1-138 行，需求条目与候选材料）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-packages.js（1-169 行，内容包与正式变更）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', 'sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口', 'nt', '疑似符号表（函数 | 行号 | 渲染什么 / 接口）：sysbuild-history.js 逐函数表，没有标签列；表上方说明「整个文件 HIS」，该文件随 S6 整删（删除清单 6.1、6.2），所以不逐行取，文件级标签 = HIS'],
  ['del-inv-tests-2.md', 'sysbuild-notify.js（1-75 行）', H_FN, 'sym', ''],
  ['del-inv-tests-2.md', '1.3 timeline 事件映射表（sysbuild-page.js:441-454）里写死的旧流程事件名', '行 | 事件名（中文标签） | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '1.4 Sys_Build.html（69 行）', '位置 | 内容 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '2.2 verify-sysbuild-e2e.js（141 行）', '断言 | 行号 | 被测 | 搭数据 | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.3 sysbuild-api-suite.js（1817 行，主套件 + 夹具）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.4 sysbuild-api-suite-plan.js（1598 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.5 sysbuild-api-suite-sheet.js（1013 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.6 sysbuild-api-suite-trace-l1.js（476 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.7 sysbuild-api-suite-trace-l2.js（804 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.8 sysbuild-api-suite-trace-l3.js（170 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.9 sysbuild-api-suite-stage8.js（449 行）与 sysbuild-api-suite-frontend.js（222 行）', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-browser-suite.js 自有场景（第 166-531 行）', '场景 | 行号 | 被测 | 搭数据（API 夹具） | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-browser-stage8.js（690 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-setup.js（262 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-forms.js（346 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-confirm.js（154 行）', '场景 | 行号 | 被测 | 搭数据 | 说明', 'nt', R_CASE],
  ['del-inv-tests-2.md', '2.12 sysbuild-frontend-static.js（424 行）：S10 / S11 前端静态守卫', '名单 | 行 | 内容 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫', '名单 | 行 | 内容 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '2.13 verify-sysbuild-static.js（958 行）：routes/sysbuild 后端写法守卫', '表.列 | 条件片段 | 变异所在行 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '2.14 verify-sysbuild-schema.js（813 行）：结构守卫', '名单 | 行 | 内容 | 流程标签', 'sym', ''],
  ['del-inv-tests-2.md', '2.14 verify-sysbuild-schema.js（813 行）：结构守卫', H_UC, 'nt', R_CASE],
  ['del-inv-tests-2.md', 'sysbuild-api-suite.js 自有变异（47 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-frontend.js（19 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-stage8.js（41 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l1.js（56 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l2.js（79 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-trace-l3.js（11 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-plan.js（94 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-api-suite-sheet.js（39 条）', H_MUT2, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-browser-suite.js 自有 FRONT_MUTATIONS（23 条）', H_MUT2B, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-browser-stage8.js（28 条）', H_MUT2B, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-setup.js（19 条）', H_MUT2B, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-forms.js（26 条）', H_MUT2B, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'sysbuild-browser-trace-confirm.js（8 条）', H_MUT2B, 'mut', R_MUT],
  ['del-inv-tests-2.md', 'verify-sysbuild-static.js 的 MUTATIONS（109 条，起于第 663 行）', '行 | 变异 id | 规则 | 涉及的 sysbuild 表 / 改的文件 | 流程标签（机器预标）', 'mut', R_MUT],
  ['del-inv-tests-2.md', 'verify-sysbuild-schema.js 的 MUTATIONS（78 条，起于第 629 行；改的都是 routes/sysbuild/schema.js 里的字面量）', '行 | 变异 id | 命中用例前缀 | 锚点字面量（前 90 字） | 流程标签（机器预标）', 'mut', R_MUT],
  ['del-inv-tests-2.md', '3.1 六个套件：组数、变异数、登记运行位置', '文件 | 文件行数 | 用例组数 | 用例起止行（首个 test 起始行 ~ 最后一个 test 的起始行） | 变异数 | 变异数组所在行 | define 登记行（sysbuild-api-suite.js） | 变异并入行（sysbuild-api-suite.js） | 文件头声明的范围（取自 sysbuild-api-suite.js 的接线注释）', 'nt', '六个套件的组数 / 变异数 / 登记行统计（套件级计数）'],
  ['del-inv-tests-2.md', '3.1 六个套件：组数、变异数、登记运行位置', '套件 | 变异改动的源文件与次数', 'nt', '六个套件的变异改动源文件分布（套件级计数）'],
  ['del-inv-tests-2.md', 'API 套件（lib/sysbuild-api-suite.js 汇总）', '子套件 | define 登记行 | 变异并入行', 'nt', 'API 套件接线登记行（子套件 | define 登记行 | 变异并入行）：行号登记表，没有符号与标签'],
  ['del-inv-tests-2.md', '浏览器套件（lib/sysbuild-browser-suite.js 汇总）', '子文件 | require 行 | 用例并入行 | 变异并入行', 'nt', '浏览器套件接线登记行（子文件 | require 行 | 用例并入行 | 变异并入行）：行号登记表'],
  ['del-inv-tests-2.md', '入口脚本与全量验证成员登记', '文件 | 行 | 登记内容', 'nt', '入口脚本与全量验证成员登记（文件 | 行 | 登记内容）：没有标签列的登记表'],
  ['del-inv-tests-3.md', '1. 用例组总表', '序号 | 标题（截短） | 行号范围 | 类别 | 一句话依据', 'nt', R_CASE],
  ['del-inv-tests-3.md', '4.1 包创建（expect 为「C3b 包创建：」或「C3b 包创建：权限」）', H_G, 'mut', R_MUT],
  ['del-inv-tests-3.md', '4.2 包版本（expect 为「C3b 包版本：…」）', H_G, 'mut', R_MUT],
  ['del-inv-tests-3.md', '4.3 snapshot（expect 为「C3b snapshot 编辑」「C3b snapshot 校验」）', H_G, 'mut', R_MUT],
  ['del-inv-tests-3.md', '4.4 读接口与 actions（目标在 packages.js / attachments.js / 包解析）', H_G, 'mut', R_MUT],
  ['del-inv-tests-3.md', '4.5 拿不准的变异（C）', '变异 id | 目标源文件 | 定位字面量（截前 80 字） | 说明', 'mut', R_MUT],
  ['del-inv-tests-3.md', '1 用例组总表', H_T3, 'nt', R_CASE],
  ['del-inv-tests-3.md', '3.1 明确守护保留规则（目标文件 entries-core.js，不在保留文件表，但守护的函数 batchLiveState 被 golive-core / submission-scope / golive.js / plan.js 使用，属保留规则；需把函数及其判据测试一起留下）', '变异 id（前缀 C5 分流：） | 目标源文件 | 定位字面量（截前 80 字） | 守护什么 | 行', 'mut', R_MUT],
  ['del-inv-tests-3.md', '3.2 C：守护「收口前置里的未结登记阻塞」，目标属保留文件 plan.js（是否保留取决于登记结论规则的去留）', '变异 id | 目标源文件 | 定位字面量（前 80 字） | 守护什么 | 行', 'mut', R_MUT],
  ['del-inv-tests-3.md', '3.3 C：守护 link_sys_issue（rules.js，保留文件）', '变异 id | 目标源文件 | 定位字面量（前 80 字） | 守护什么 | 行', 'mut', R_MUT],
  ['del-inv-tests-3.md', '1 用例组总表', '序号 | 标题（截短） | 行号 | 类 | 依据', 'nt', R_CASE],
  ['del-inv-tests-3.md', '1. 用例组总表', H_T3, 'nt', R_CASE],
  ['del-inv-tests-3.md', '3. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量（前80字） | 说明', 'mut', R_MUT],
  ['del-inv-tests-3.md', '2. 全部用例组', H_T3, 'nt', R_CASE],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量（前80字） | 守护什么 / 判断', 'mut', R_MUT],
  ['del-inv-tests-3.md', '2. 用例组总表（20 组）', H_T3, 'nt', R_CASE],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标文件 | 定位字面量（前 80 字） | 说明', 'mut', R_MUT],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标文件 | 定位字面量 | 为什么是边界', 'mut', R_MUT],
  ['del-inv-tests-3.md', '2. 用例组总表（23 组）', H_T3, 'nt', R_CASE],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', H_G.replace('截前 80 字', '前 80 字'), 'mut', R_MUT],
  ['del-inv-tests-3.md', '4. 守护保留规则的变异', '变异 id | 目标源文件 | 定位字面量 | 说明', 'mut', R_MUT],
];
// 每张登记表的「完整标题路径（各级标题用 ' › ' 连接）+ 所属文件」，与 IMPL_TABLES 逐项同序（75 MEDIUM-1：末级标题相同的表——例如各套件下的「二、搭数据的共用函数」「三、用例」——
//   光靠末级标题分不开，解析器若把表归到错误的上级章节，原件 sha256 不变、身份也对得上，只有路径与所属文件会变）。
//   2026-11-19 用 inv-parse.js 对冻结原件逐表生成，并逐项核对身份与 IMPL_TABLES 同序后写死；自检断言两个数组等长、每项 7 个元素。
const IMPL_TABLE_LOC = [
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 一、rules.js（1485 行，已读完） › 1.1 顶层符号（函数、常量）", "rules.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 一、rules.js（1485 行，已读完） › 1.2 PROJECT_ACTION_TABLE 的每个键（225–241）", "rules.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 一、rules.js（1485 行，已读完） › 1.3 OBJECT_OPS 的每个键（520–1289）", "rules.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 一、rules.js（1485 行，已读完） › 1.4 OP_KIND 的每个键（1292–1380，值是项目状态类别）", "rules.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.1 顶层符号", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.2 ENUMS 的每个键（38–97，共 45 个）", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.3 表（TABLES，共 42 张）", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.4 索引（INDEXES，共 67 个）", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.5 UPDATABLE_COLUMNS 的每一项（699–721）", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 二、schema.js（761 行，已读完） › 2.6 CONDITIONAL_UPDATES 的每一项（728–744）", "schema.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 三、events.js（73 行，已读完） › 3.1 顶层符号", "events.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 三、events.js（73 行，已读完） › 3.2 EVENT_TYPES 的每个事件类型", "events.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 四、templates.js（93 行，已读完） › 4.1 顶层符号", "templates.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 五、index.js（214 行，已读完） › 5.1 顶层符号与挂载", "index.js"],
  ["项目管理（sysbuild）后端取证表 1：rules / schema / events / templates / index / migration-schema › 六、migration-schema.js（12 行，已读完） › 6.1 顶层符号", "migration-schema.js"],
  ["sysbuild 后端取证清单（文件组 2） › 1. entries.js（共 1049 行，全部读完）", "entries.js"],
  ["sysbuild 后端取证清单（文件组 2） › 2. entries-core.js（共 766 行，全部读完）", "entries-core.js"],
  ["sysbuild 后端取证清单（文件组 2） › 3. entries-routing.js（共 288 行，全部读完）", "entries-routing.js"],
  ["sysbuild 后端取证清单（文件组 2） › 4. entry-forms.js（共 199 行，全部读完）", "entry-forms.js"],
  ["sysbuild 后端取证清单（文件组 2） › 5. changes.js（共 332 行，全部读完）", "changes.js"],
  ["sysbuild 后端取证清单（文件组 2） › 6. items.js（共 493 行，全部读完）", "items.js"],
  ["sysbuild 后端取证清单（文件组 2） › 7. assessment-view.js（共 38 行，全部读完）", "assessment-view.js"],
  ["sysbuild 后端取证清单（文件组 2） › 8. submission-scope.js（共 229 行，全部读完）", "submission-scope.js"],
  ["sysbuild 后端取证清单（文件组 2） › 9. report-core.js（共 221 行，全部读完）", "report-core.js"],
  ["sysbuild 后端取证清单（文件组 2） › 10. report-recipients.js（共 26 行，全部读完）", "report-recipients.js"],
  ["sysbuild 后端取证清单（文件组 2） › 11. 记录表 sysbuild_entries 的最小用法 › 创建（POST /sysbuild/projects/:id/entries，entries.js:481–553）", "entries.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 1. confirm.js（901 行）", "confirm.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 2. confirm-core.js（906 行）", "confirm-core.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 3. confirmation-sheet.js（683 行）", "confirmation-sheet.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 4. packages.js（616 行）", "packages.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 5. membership.js（939 行）", "membership.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 6. membership-visibility.js（60 行）", "membership-visibility.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 7. projects.js（558 行）", "projects.js"],
  ["删旧流程取证：wbs-server/routes/sysbuild 后端（第 3 份） › 确认任务的对象类型与用途（sysbuild_confirm_tasks）", ""],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 1. plan.js（890 行，全部读完）", "plan.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 2. golive.js（275 行，全部读完）", "golive.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 3. golive-core.js（653 行，全部读完）", "golive-core.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 4. history.js（663 行，全部读完）", "history.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 5. notify.js（900 行，全部读完）", "notify.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 6. notify-core.js（155 行，全部读完）", "notify-core.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 7. notify-schedule.js（75 行，全部读完）", "notify-schedule.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 8. materials.js（152 行，全部读完）", "materials.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 9. materials-core.js（125 行，全部读完）", "materials-core.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 10. attachments.js（751 行，全部读完）", "attachments.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 11. 待办接口的类别（notify.js，GET /sysbuild/my/todo，751–895 行）", "notify.js"],
  ["sysbuild 后端旧流程取证：plan / golive / golive-core / history / notify / notify-core / notify-schedule / materials / materials-core / attachments › 12. 发送意图的用途与写入点", ""],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 实际读取范围", ""],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 2. verify-sysbuild-attachments.js › 2.2 引用停用流程标识的位置", "verify-sysbuild-attachments.js"],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 2. verify-sysbuild-attachments.js › 2.3 附件 owner_type 用到情况（针对「用哪些 owner_type 挂附件」）", "verify-sysbuild-attachments.js"],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 5. verify-sysbuild-static.js（补读 440–662、843–959） › 5.4 写死的数量断言（补读范围内）", "verify-sysbuild-static.js"],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 6. verify-sysbuild-schema.js（补读 260–366、444–629） › 6.2 引用停用流程标识的位置", "verify-sysbuild-schema.js"],
  ["守卫与验证脚本取证：停用流程标识引用清单（补读） › 7. 汇总", ""],
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
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.4 读接口与 actions（目标在 packages.js / attachments.js / 包解析）", "packages.js"],
  ["sysbuild-api-suite-items.js 取证结果 › 4. 守护保留规则的变异 › 4.5 拿不准的变异（C）", "sysbuild-api-suite-items.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 1 用例组总表", "sysbuild-api-suite-routing.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.1 明确守护保留规则（目标文件 entries-core.js，不在保留文件表，但守护的函数 batchLiveState 被 golive-core / submission-scope / golive.js / plan.js 使用，属保留规则；需把函数及其判据测试一起留下）", "entries-core.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.2 C：守护「收口前置里的未结登记阻塞」，目标属保留文件 plan.js（是否保留取决于登记结论规则的去留）", "plan.js"],
  ["sysbuild-api-suite-routing.js 取证结果 › 3 守卫保留规则的变异 › 3.3 C：守护 link_sys_issue（rules.js，保留文件）", "rules.js"],
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
// ── 有文件级去向的排除表（75 HIGH-1）──────────────────────────────────────────────────
// 逐函数 / 逐行表因为没有标签列被排除，但原件在表上方（表所在标题与表头行之间）明确写了文件级去向（「整个文件 HIS」），删除清单也写了整删——
//   这种文件级去向不能只留一句排除理由（旧版：登记表、明细逐行校验、原件摘要都能通过，入口 1 却没有可按 C2 取出的整删行），必须生成一条可分派记录：
//   文件路径、原件位置、文件级标签、去向、提交；回读断言每条恰好出现一次。
// 登记 = { table: [文件, 所在标题, 规范化表头]（排除表的身份）, file, repoPath, tag, op, evidence（人工写明的依据，回读不核它）}。
//   原件上方的那一句话由生成器现场按 FILE_LEVEL_RE 扫出（原件位置 + 标签），标签必须与登记一致；扫到文件级表述、却没有登记的排除表 → 问题（扫全部排除表找同类）。
//   预筛 LOW-1（2026-11-20）：放宽为「整个文件 + 同句内任意文字 + 标签词或处置词」（标签 = 全大写词、「标签」；处置词 = 整删 / 删除 / 停用 / 保留 / 处置 / 整体），
//   原写法只认「整个文件」后紧跟大写标签，漏掉「整个文件是「…」，主标签 HIS」「整个文件全部 KEEP」「整个文件主题是…，本身整体属于停用流程」。新命中的逐条走「登记 / 排除 / sym 小节已覆盖」三选一。
const FILE_LEVEL_RE = /整个文件[^。\n]{0,200}?(?:\b([A-Z]{2,5})\b|标签|整删|删除|停用|保留|处置|整体)|整文件|文件级标签/;
const FILE_LEVEL = [
  { table: ['del-inv-tests-2.md', 'sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口'], file: 'sysbuild-history.js', repoPath: 'wbs-server/public/assets/js/sysbuild-history.js', tag: 'HIS', op: '整删', evidence: '删除清单 6.1「历史补录（sysbuild-history.js:84）删，文件整删（85 行）」与 6.2「sysbuild-history.js（85）整删，页面里的引用（Sys_Build.html:66）一起去掉」；该文件随 S6 整删' },
];
// 某张表的「表上方文字」：表所在标题行之后、表头行之前的非空、非表格行，返回 [{ line, text }]
function preTableLines(lines, t) {
  const out = [];
  if (!t.headingLine) return out;
  for (let k = t.headingLine; k < t.headerLine - 1; k += 1) if (lines[k] !== undefined && lines[k].trim() !== '' && !P.isPipeLine(lines[k])) out.push({ line: k + 1, text: lines[k] });
  return out;
}
// 取证原件与删除清单是冻结的证据：登记 sha256，改动 / 缺失都报问题（登记在 inv-parse.js 的 EVIDENCE_SHA256 / DELETION_LIST_SHA256，两个生成器共用同一份，2026-11-19 用 sha256sum 取得）
const EXPECTED_SHA256 = P.EVIDENCE_SHA256;
// 排除的文件级处置表述（78 号 MEDIUM-1）：原件里匹配 FILE_LEVEL_RE、但既不是已登记的排除表所在小节、小节里也没有逐行取的符号表的表述，逐条登记原因（原件冻结，按 文件:行号 + 文字前缀核）
const FILE_LEVEL_EXCLUDED = [
  { src: 'del-inv-backend-3.md:446', prefix: '- 整个文件头注释写', reason: '说明性文字：membership-visibility.js 的头注释专为 INV 服务，但 managerOf / memberVisible 等是 KEEP 的可见性谓词，「不能因删 INV 整文件删除」——是不整删的论据，不是整删处置' },
  { src: 'del-inv-guards.md:122', prefix: '- 要整文件删除的源文件在这两段里的出现', reason: '守卫取证的检索范围说明（整删清单里的源文件在补读范围内是否出现），不是对某个文件的处置' },
  { src: 'del-inv-tests-3.md:171', prefix: '所有这些变异的 expect 指向的用例名在本文件里，整文件删除后', reason: '整套测试文件的说明（若删该套件文件须同步改 expect）；方案已定这些套件逐用例拆、不整删（测试去向表按用例行 / 变异处置），不在实施清单入口 1 范围，主会话裁定不登记' },
  { src: 'del-inv-tests-3.md:286', prefix: '- 每条变异的 expect 字段指向本文件的用例名，整文件删除后须', reason: '同上（测试套件文件的说明，逐用例拆、不整删）' },
  { src: 'del-inv-tests-3.md:426', prefix: '整个文件主题是「开发方关键事项」', reason: '同 171 / 286（devkey 测试套件的文件级说明；逐用例拆、不整删，不在实施清单入口 1 范围；放宽正则后新命中，主会话 2026-11-20 裁定进排除登记）' },
];
const REGISTRY = { files: EXPECTED_FILES, sha256: EXPECTED_SHA256, deletionList: EXPECTED_DELETION_LIST, deletionListSha256: P.DELETION_LIST_SHA256, tables: IMPL_TABLES.map((e, i) => e.concat(IMPL_TABLE_LOC[i] || [])), fileLevel: FILE_LEVEL, fileLevelExcluded: FILE_LEVEL_EXCLUDED };

// ── 选表与取行 ─────────────────────────────────────────────────────────────────────────
const isTagHeader = (h) => /^(流程)?标签$/.test(h);
const isMutationTable = (header) => !!P.mutationTable(header); // 与测试去向表同一个识别函数（inv-parse.js mutationTable）
const roleOf = (t) => (isMutationTable(t.header) ? 'mut' : (t.header.some(isTagHeader) ? 'sym' : 'nt'));
function selectTables(tables) { return tables.filter((t) => roleOf(t) === 'sym'); }
function rowsOf(srcName, tables) {
  const out = [];
  tables.forEach((t, ti) => {
    const tagCol = t.header.findIndex(isTagHeader);
    const lineCol = t.header.findIndex((h) => /行/.test(h));
    const basisCols = t.header.map((h, i) => (/依据|备注|判断/.test(h) ? i : -1)).filter((i) => i >= 0);
    const descCols = t.header.map((h, i) => i).filter((i) => i !== 0 && i !== tagCol && i !== lineCol && !basisCols.includes(i));
    t.rows.forEach((r) => {
      const c = (i) => (i >= 0 && r.cells[i] !== undefined ? r.cells[i] : '');
      out.push({
        src: srcName + ':' + r.line, srcName, srcLine: r.line, table: ti, tableHeading: t.heading,
        file: t.file, symbol: c(0), lines: lineCol >= 0 ? c(lineCol) : '',
        desc: descCols.map(c).filter((x) => x !== '').join(' / '),
        tagText: c(tagCol), basis: basisCols.map(c).filter((x) => x !== '').join(' / '), ambiguous: !!r.ambiguous, ambReason: r.ambReason || '', candText: r.candText || '', candTags: (r.candidates || []).map((cs) => (tagCol >= 0 && cs[tagCol] !== undefined ? cs[tagCol] : '')), candComplete: !!r.candComplete, lineRange: r.line + (r.endLine !== r.line ? '–' + r.endLine : ''), raw: r.raw,
      });
    });
  });
  return out;
}

// ── 机械分类 ───────────────────────────────────────────────────────────────────────────
// ambiguous：解析器（inv-parse.js readCells）报告这一行列边界定不下来 → 待裁定（解析歧义）
// cand（78 号 MEDIUM-2，只对歧义行有意义）= { tags: [其他候选读法的标签单元格…], complete: 候选读法是否完整可枚举 }：歧义行的提交取「主读法 ∪ 全部候选读法」的并集
//   （只取主读法会让 HIS / ITEM 互有歧义的行只计进一个提交的待裁定，另一个提交收口时漏掉该对象）；candIncomplete = 歧义行但候选读法不完整 → 进 1.8 裁定清单。
function classify(tagText, ambiguous, cand) {
  const lab = P.parseLabels(tagText);
  const all = Array.from(new Set(lab.main.concat(lab.note)));
  const del = all.filter((x) => DELETABLE.includes(x));
  const stay = all.filter((x) => STAY.includes(x));
  const candTags = ambiguous && cand && Array.isArray(cand.tags) ? cand.tags : [];
  const candDel = [].concat(...candTags.map((t) => { const l = P.parseLabels(t); return Array.from(new Set(l.main.concat(l.note))).filter((x) => DELETABLE.includes(x)); }));
  const commits = Array.from(new Set(del.concat(candDel).map((x) => COMMIT_OF[x]))).sort((a, b) => a - b);
  const candIncomplete = !!ambiguous && !(cand && cand.complete);
  const earliest = commits.length ? commits[0] : null;
  const latest = commits.length ? commits[commits.length - 1] : null;
  let cls;
  let commit = '';
  if (ambiguous) cls = '待裁定（解析歧义）';
  else if (lab.unknown.length) cls = '待裁定（未知标签词）';
  else if (all.length === 0) cls = '待裁定（无标签）';
  else if (del.length === 0) cls = '留';
  // 删：多个可删标签时取最晚的提交（被多个流程共用的符号要等最后一个使用者删掉才能删；方案第六节「最后删被依赖的」）；拆：候选全列
  else if (stay.length === 0) { cls = '删'; commit = 'C' + latest; } else { cls = '拆（待裁定）'; commit = '候选 ' + commits.map((n) => 'C' + n).join('、'); }
  const span = commits.length ? 'C' + earliest + ' / C' + latest : '';
  // 共享对象（75 MEDIUM-3）：分类为「删」、却带多个可删标签的符号，整删时点取最晚提交，但较早提交（它的其他使用者在那里停用）要先核对：
  //   本对象的顶层依赖或某个分支引用了较早整删的模块时，较早提交先删就会让模块加载失败。review = 全部候选复核提交（含最晚的整删时点）
  //   歧义行（78 号 MEDIUM-2）：review = 全部候选读法的可删提交并集（保持待裁定），每个相关提交收口时都能取到它
  const review = (cls === '删' && commits.length > 1) || (ambiguous && commits.length > 0) ? commits.map((n) => 'C' + n).join('、') : '';
  return { cls, commit, span, earliest, latest, main: lab.main, note: lab.note, unknown: lab.unknown, all, del, commits, review, candIncomplete };
}

// 1.8 的「裁定原因」列（渲染与回读共用；c = classify 结果（或带 cls / commits / candIncomplete 的明细项））
const adjWhy = (c) => (c.cls === '留' ? '初判「留」，但原件标签单元格写着「拿不准」（若实际涉及待删分支，入口 1 会跳过它）' : (c.commits.length > 0 && c.candIncomplete ? '初判「' + c.cls + '」，候选读法不完整（候选集合无法完整确定），主读法 / 已知候选的可删提交 ' + c.commits.map((n) => 'C' + n).join('、') + ' 只是部分结果' : '初判「' + c.cls + '」，标签里没有可删标签，没有候选提交（入口 1 按提交取不到它）'));
// 一个原件行的分类（歧义行带候选读法：78 号 MEDIUM-2）；生成与回读共用
const classifyRow = (r) => classify(r.tagText, r.ambiguous, { tags: r.candTags || [], complete: !!r.candComplete });
// 裁定清单（1.8）：「留」但原件标拿不准；待裁定且没有候选提交；歧义行但候选读法不完整（候选集合无法完整确定）
const isAdjudicate = (r, c) => (c.cls === '留' && /拿不准/.test(r.tagText)) || (c.cls.startsWith('待裁定') && (c.commits.length === 0 || c.candIncomplete));

// ── 三向反查 ───────────────────────────────────────────────────────────────────────────
const ROUTE_RE = /\b(GET|POST|PATCH|PUT|DELETE)\s+(\/sysbuild\/[^\s`，。；、）)]+)/g;
function routesIn(text) {
  const out = [];
  for (let m = ROUTE_RE.exec(text); m !== null; m = ROUTE_RE.exec(text)) out.push({ method: m[1].toLowerCase(), path: m[2].replace(/[.,;:]+$/, '') });
  ROUTE_RE.lastIndex = 0;
  return out;
}
function staticFragment(routePath) {
  const parts = routePath.split('/').filter(Boolean).filter((s) => !s.startsWith(':'));
  const frags = parts.filter((s) => s !== 'sysbuild');
  return frags.length ? frags[frags.length - 1] : '';
}
const countOf = (text, needle) => { if (!needle) return 0; let n = 0; let i = text.indexOf(needle); while (i >= 0) { n += 1; i = text.indexOf(needle, i + needle.length); } return n; };
function countWord(text, name) {
  let n = 0;
  let i = text.indexOf(name);
  while (i >= 0) {
    const a = i === 0 ? '' : text[i - 1];
    const b = text[i + name.length] || '';
    if (!/[A-Za-z0-9_$]/.test(a) && !/[A-Za-z0-9_$]/.test(b)) n += 1;
    i = text.indexOf(name, i + name.length);
  }
  return n;
}
const idsOf = (s) => Array.from(new Set((String(s).replace(/`/g, ' ').match(/[A-Za-z_$][A-Za-z0-9_$]*/g) || [])));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOfIdx = (text, idx) => { let n = 1; for (let i = 0; i < idx; i += 1) if (text.charCodeAt(i) === 10) n += 1; return n; };

// ctx.sources = 反查各处输入的读取结果（75 MEDIUM：入口文件与两处夹具目录各自记录，缺失 / 读失败时对应格标「反查失败」，不写成「指定范围内无命中」）：
//   [{ name, rel, ok, count, error, note }]；ctx.indexOk / ctx.indexError、ctx.fixtureDirs（每个夹具目录 { rel, ok, count, error }）、ctx.xrefErrorCount 供 crossRefs 用。
function buildContext(repo) {
  const ctx = { repo, exportsByFile: new Map(), srcByFile: new Map(), indexText: '', indexOk: false, indexError: '', fixtures: [], fixtureDirs: [], sources: [], reportError: null, errorsByFile: new Map(), xrefErrorCount: 0, xrefErrorFiles: [] };
  const routesDir = path.join(repo, 'wbs-server', 'routes', 'sysbuild');
  try {
    const xref = require('./xref-exports');
    const rep = xref.buildReport(repo);
    for (const f of rep.files) {
      const base = f.file.split('/').pop();
      const m = new Map();
      for (const e of f.exports) m.set(e.name, e);
      ctx.exportsByFile.set(base, m);
    }
    for (const e of rep.errors) ctx.errorsByFile.set(e.file.split('/').pop(), e.error);
    ctx.xrefErrorCount = rep.errors.length;
    ctx.xrefErrorFiles = rep.errors.map((e) => e.file.split('/').pop());
    if (rep.errors.length) ctx.reportError = rep.errors.map((e) => e.file + ': ' + e.error).join('；');
    ctx.sources.push({ name: '导出引用报告（xref-exports）', rel: 'wbs-server/scripts/sysbuild-step1/xref-exports.js', ok: true, count: rep.scannedFileCount, note: rep.errors.length ? '其中 ' + rep.errors.length + ' 个文件扫描失败：' + ctx.xrefErrorFiles.join('、') : '', error: '' });
  } catch (e) { ctx.reportError = e.message; ctx.reportFailed = true; ctx.sources.push({ name: '导出引用报告（xref-exports）', rel: 'wbs-server/scripts/sysbuild-step1/xref-exports.js', ok: false, count: 0, note: '', error: e.message }); }
  // 78 号 MEDIUM-5：后端目录枚举、逐文件读取、入口文件读取分开记；已知后端目标（目录里列到的 .js ∪ xref-exports 导出表里的文件）读失败 / 缺失标「反查失败」，不再和「反查范围外」共用一个分支；入口文件可读就独立查挂载
  ctx.backend = { dirOk: false, enumError: '', listed: [], readErrors: new Map() };
  if (!fs.existsSync(routesDir)) ctx.backend.enumError = 'routes/sysbuild 目录不存在';
  else {
    try { ctx.backend.listed = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort(); ctx.backend.dirOk = true; } catch (e) { ctx.backend.enumError = e.message; }
    for (const f of ctx.backend.listed) { try { ctx.srcByFile.set(f, fs.readFileSync(path.join(routesDir, f), 'utf8').replace(/\r\n/g, '\n')); } catch (e) { ctx.backend.readErrors.set(f, e.message); ctx.errorsByFile.set(f, '读不到：' + e.message); } }
  }
  ctx.indexText = ctx.srcByFile.get('index.js') || '';
  ctx.indexOk = ctx.srcByFile.has('index.js');
  ctx.indexError = ctx.indexOk ? '' : (ctx.backend.readErrors.has('index.js') ? 'index.js 读取失败：' + ctx.backend.readErrors.get('index.js') : (ctx.backend.enumError ? 'routes/sysbuild 目录读不到（' + ctx.backend.enumError + '）' : 'routes/sysbuild 目录里没有 index.js'));
  ctx.knownBackend = new Set(ctx.backend.listed.concat(Array.from(ctx.exportsByFile.keys())));
  ctx.sources.push({ name: '后端目录枚举（routes/sysbuild/*.js）', rel: 'wbs-server/routes/sysbuild', ok: ctx.backend.dirOk, count: ctx.backend.listed.length, note: '', error: ctx.backend.enumError });
  ctx.sources.push({ name: '后端文件逐个读取', rel: 'wbs-server/routes/sysbuild/*.js', ok: ctx.backend.dirOk && ctx.backend.readErrors.size === 0, count: ctx.srcByFile.size, note: ctx.backend.readErrors.size ? '读取失败 ' + ctx.backend.readErrors.size + ' 个：' + Array.from(ctx.backend.readErrors.keys()).join('、') : '', error: ctx.backend.readErrors.size ? Array.from(ctx.backend.readErrors.entries()).map(([k, v]) => k + '：' + v).join('；') : (ctx.backend.dirOk ? '' : ctx.backend.enumError) });
  ctx.sources.push({ name: '挂载入口文件', rel: 'wbs-server/routes/sysbuild/index.js', ok: ctx.indexOk, count: ctx.indexOk ? 1 : 0, note: '', error: ctx.indexError });
  const libDir = path.join(repo, 'wbs-server', 'scripts', 'lib');
  const scDir = path.join(repo, 'wbs-server', 'scripts');
  const loadDir = (name, dir, relDir, re, relPrefix) => {
    const info = { rel: relDir, ok: false, count: 0, error: '' };
    const found = [];
    if (!fs.existsSync(dir)) info.error = '目录不存在';
    else {
      try { for (const f of fs.readdirSync(dir)) if (re.test(f)) found.push(relPrefix + f); info.ok = true; } catch (e) { info.error = e.message; }
    }
    const read = [];
    for (const rel of found.sort()) { try { read.push({ rel, text: fs.readFileSync(path.join(repo, rel), 'utf8').replace(/\r\n/g, '\n') }); } catch (e) { info.ok = false; info.error = (info.error ? info.error + '；' : '') + rel + ' 读不到：' + e.message; } }
    info.count = read.length;
    ctx.fixtureDirs.push(info);
    ctx.sources.push({ name: name, rel: relDir, ok: info.ok, count: info.count, note: '', error: info.error });
    return read;
  };
  const a = loadDir('用例夹具目录 1（lib/sysbuild-*.js）', libDir, 'wbs-server/scripts/lib', /^sysbuild-.*\.js$/, 'wbs-server/scripts/lib/');
  const b = loadDir('用例夹具目录 2（verify-sysbuild-*.js）', scDir, 'wbs-server/scripts', /^verify-sysbuild-.*\.js$/, 'wbs-server/scripts/');
  ctx.fixtures = a.concat(b).sort((x, y) => (x.rel < y.rel ? -1 : 1));
  return ctx;
}
function fixtureHits(ctx, needle, word) {
  const hits = [];
  for (const f of ctx.fixtures) {
    const n = word ? countWord(f.text, needle) : countOf(f.text, needle);
    if (n > 0) hits.push(f.rel.replace(/^wbs-server\/scripts\//, '') + '（' + n + '）');
  }
  return hits;
}
// 该路由在 src 里的全部登记行：router.<method>( 后跟路径字面量，括号后允许换行 / 空白；路径带不带 /sysbuild 前缀都认
function routeLines(src, method, routePath) {
  const paths = [routePath];
  if (routePath.startsWith('/sysbuild/')) paths.push(routePath.slice('/sysbuild'.length));
  const out = [];
  for (const p of paths) {
    const re = new RegExp('router\\.' + method + "\\(\\s*['\"`]" + reEsc(p) + "['\"`]", 'g');
    for (let m = re.exec(src); m !== null; m = re.exec(src)) out.push(lineOfIdx(src, m.index));
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}
// index.js 里每个 use( / mount( / register( 调用：返回 [{ line（调用起始行）, text（括号内全文，按括号配对，可跨行）}]（引号里的括号不计；最多取 800 字符，防止没配对的括号吞掉后面全文）
//   78 号 MEDIUM-6：括号配对时跳过行注释（// 到行尾）与块注释（/* */）里的字符（参数里的行注释含右括号不再让扫描提前停止）；
//   括号没配上（读到文件末尾、或超过 800 字符）的调用标 truncated: true，由 mountInfo 把「没命中」改标未覆盖，不写「指定范围内无命中」。
function mountStatements(indexText) {
  const out = [];
  const re = /\b(use|mount|register)\s*\(/g;
  for (let m = re.exec(indexText); m !== null; m = re.exec(indexText)) {
    let depth = 1;
    let q = null;
    let i = re.lastIndex;
    const startAt = re.lastIndex;
    for (; i < indexText.length && depth > 0 && i - startAt < 800; i += 1) {
      const ch = indexText[i];
      if (q) { if (ch === '\\') i += 1; else if (ch === q) q = null; continue; }
      if (ch === '/' && indexText[i + 1] === '/') { const nl = indexText.indexOf('\n', i); i = nl < 0 ? indexText.length : nl; continue; }
      if (ch === '/' && indexText[i + 1] === '*') { const e2 = indexText.indexOf('*/', i + 2); i = e2 < 0 ? indexText.length : e2 + 1; continue; }
      if (ch === "'" || ch === '"' || ch === '`') q = ch; else if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
    }
    out.push({ line: lineOfIdx(indexText, m.index), text: indexText.slice(startAt, i), truncated: depth > 0 });
  }
  return out;
}
// 该文件在 index.js 里的挂载情况（见头注释②）：{ lines（直接命中的调用起始行）, ambiguous（只靠「被多个 require 绑定的同名简写变量」命中的行，无法归属）, truncated（没配上括号的调用起始行） }。
//   模块绑定：`x = require('./文件')`；别名解构 `{ router: x } = require(...)`；简写解构 `{ router } = require(...)`（78 号 MEDIUM-6）。同名变量被多个文件的 require 绑定时（简写解构最常见），
//   凭变量名无法归属到哪个文件 → 命中记 ambiguous，不当成该文件的命中。挂载调用可以跨行：`router.use(\n  history.router\n)` 报调用起始行。
function mountInfo(ctx, file) {
  const res = { lines: [], ambiguous: [], truncated: [] };
  if (!ctx.indexText || !file.endsWith('.js')) return res;
  const text = ctx.indexText;
  const stem = reEsc(file.replace(/\.js$/, ''));
  const req = "require\\(\\s*['\"]\\./" + stem + "(?:\\.js)?['\"]\\s*\\)";
  const anyReq = "require\\(\\s*['\"]\\./([\\w.-]+?)(?:\\.js)?['\"]\\s*\\)";
  // 每个变量名被哪些文件的 require 绑定
  const bound = new Map();
  const bind = (v, f) => { if (!bound.has(v)) bound.set(v, new Set()); bound.get(v).add(f); };
  for (const m of text.matchAll(new RegExp('(\\w+)\\s*=\\s*' + anyReq, 'g'))) bind(m[1], m[2]);
  // 工厂函数绑定：`const { createXRoutes } = require('./x')`（解构出的函数名）与 `const f = require('./x')`（模块本身当函数用），
  //   之后 `const v = createXRoutes(...)` 的 v 绑定到同一文件（生产 index.js 就是这种写法：解构出 createXxxRoutes，调用得到 v，再 router.use(v.router)）
  const factoryOf = new Map();
  for (const m of text.matchAll(new RegExp('\\{([^}]*)\\}\\s*=\\s*' + anyReq, 'g'))) {
    for (const part of m[1].split(',')) {
      const mm = /^\s*(\w+)\s*(?::\s*(\w+))?\s*$/.exec(part);
      if (!mm) continue;
      if (mm[1] === 'router' || mm[2]) bind(mm[2] || mm[1], m[2]);
      factoryOf.set(mm[2] || mm[1], m[2]);
    }
  }
  for (const [v, set] of Array.from(bound)) if (set.size === 1) factoryOf.set(v, Array.from(set)[0]);
  for (const m of text.matchAll(/\b(\w+)\s*=\s*(?:await\s+)?(\w+)\s*\(/g)) if (factoryOf.has(m[2]) && m[1] !== m[2]) bind(m[1], factoryOf.get(m[2]));
  const mine = [];
  for (const [v, set] of bound) if (set.has(file.replace(/\.js$/, ''))) mine.push({ v, shared: set.size > 1 });
  for (const s of mountStatements(text)) {
    if (s.truncated) res.truncated.push(s.line);
    if (new RegExp(req).test(s.text)) { res.lines.push(s.line); continue; }
    const used = mine.filter((x) => new RegExp('\\b' + reEsc(x.v) + '\\b').test(s.text));
    if (used.some((x) => !x.shared)) res.lines.push(s.line); else if (used.length) res.ambiguous.push(s.line);
  }
  res.lines = Array.from(new Set(res.lines));
  return res;
}
// 直接命中的挂载行（兼容旧接口）
function mountLines(ctx, file) { return mountInfo(ctx, file).lines; }
const SCOPE_READERS = 'xref-exports 的导出引用';
// 各格都返回 { text, kind }，kind ∈ hit / none（指定范围内无命中）/ uncovered（未覆盖）/ failed（反查失败）；mount = 路由挂载（与 route = 路由注册分开记）
function crossRefs(ctx, row) {
  const out = { readers: { text: '', kind: 'uncovered' }, route: { text: '', kind: 'uncovered' }, mount: { text: '', kind: 'uncovered' }, fixtures: { text: '', kind: 'uncovered' } };
  const base = row.file;
  // ① 读写方
  const exp = ctx.exportsByFile.get(base);
  let names = [];
  if (ctx.reportFailed) out.readers = { text: '反查失败（xref-exports 报告没跑出来：' + ctx.reportError + '）', kind: 'failed' };
  else if (ctx.errorsByFile.has(base)) out.readers = { text: '反查失败（xref-exports 对 ' + base + ' 报错：' + ctx.errorsByFile.get(base) + '）', kind: 'failed' };
  else if (!exp) out.readers = { text: '未覆盖（' + (base || '（无文件标题）') + ' 不在 xref-exports 的后端导出表里）', kind: 'uncovered' };
  else {
    names = idsOf(row.symbol).filter((n) => exp.has(n));
    if (!names.length) out.readers = { text: '未覆盖（符号里没有该文件的导出名）', kind: 'uncovered' };
    else {
      // 78 号 MEDIUM-7：按导出名给结论。xref-exports 有文件扫描失败时（ctx.xrefErrorCount > 0），失败的文件里可能有引用：命中的导出名照写命中，
      //   零命中的导出名每个都标「反查失败」（同一行一个有引用、一个零引用时，零引用的那个不能写「指定范围内无命中」），行级 kind：有命中 = hit（明细里写明缺口）、全部零命中 = failed
      const gapText = ctx.xrefErrorCount > 0 ?'xref-exports 有 ' + ctx.xrefErrorCount + ' 个文件扫描失败（' + (ctx.xrefErrorFiles || []).slice(0, 4).join('、') + '），失败文件里可能有引用，零引用不完整' : '';
      const parts = names.slice(0, 3).map((n) => {
        const e = exp.get(n);
        const refs = e.references.map((r) => r.file.replace(/^wbs-server\//, '').replace(/^routes\/sysbuild\//, '') + ':' + r.line);
        if (e.referenceCount === 0) return n + '：' + (gapText ? '反查失败（' + gapText + '）' : '指定范围内无命中（' + SCOPE_READERS + '：无引用）');
        return n + '：' + e.referenceCount + ' 处 ' + refs.slice(0, 6).join('、') + (refs.length > 6 ? '…' : '');
      });
      const anyHit = names.some((n) => exp.get(n).referenceCount > 0);
      const unlistedZero = names.slice(3).filter((n) => exp.get(n).referenceCount === 0).length;
      const tailNote = (names.length > 3 ? '；另 ' + (names.length - 3) + ' 个导出名未列' + (gapText && unlistedZero ? '（其中零命中 ' + unlistedZero + ' 个，按扫描不完整标反查失败）' : '') : '');
      out.readers = { text: parts.join('；') + tailNote, kind: anyHit ? 'hit' : (gapText ? 'failed' : 'none') };
    }
  }
  // ② 路由注册（同一对象的多个路由都查；方法调用与路径字面量可以隔行）
  const routes = routesIn(row.symbol + ' ' + row.desc);
  const src = ctx.srcByFile.get(base);
  const knownBackend = !!(ctx.knownBackend && ctx.knownBackend.has(base));
  if (routes.length) {
    const seen = new Set();
    const parts = [];
    let anyHit = false;
    let anyFail = false;
    for (const r of routes) {
      const k = r.method + ' ' + r.path;
      if (seen.has(k)) continue;
      seen.add(k);
      let where;
      // 78 号 MEDIUM-5：已知后端目标（目录里列到的 / xref 导出表里的）读失败或缺失 = 反查失败；不是后端文件（夹具 / 前端等）= 未覆盖；后端目录整个读不到 = 反查失败
      if (!src && knownBackend) { where = '反查失败（后端文件 ' + base + ' ' + (ctx.backend && ctx.backend.readErrors.has(base) ? '读取失败：' + ctx.backend.readErrors.get(base) : '没读到') + '，无法核该文件的路由注册）'; anyFail = true; } else if (!src && ctx.srcByFile.size > 0) { where = '未覆盖（' + (base || '（无文件标题）') + ' 不是 routes/sysbuild 下的后端文件）'; } else if (!src) { where = '反查失败（读不到 routes/sysbuild 目录' + (ctx.backend && ctx.backend.enumError ? '：' + ctx.backend.enumError : '') + '，无法核 ' + (base || '（无文件标题）') + '）'; anyFail = true; } else {
        const ls = routeLines(src, r.method, r.path);
        if (ls.length) { where = base + ':' + ls.join('、'); anyHit = true; } else where = '指定范围内无命中（' + base + ' 里没找到该路由）';
      }
      parts.push(r.method.toUpperCase() + ' ' + r.path + ' → ' + where);
    }
    // 路由注册与路由挂载分开记（挂载有自己的列）：已知后端目标即使源文件没读到，只要入口文件可读，挂载仍独立检查
    const notBackend = !src && !knownBackend && ctx.srcByFile.size > 0;
    if (notBackend) { out.route = { text: parts.join('；'), kind: 'uncovered' }; out.mount = { text: '未覆盖（不是后端文件，不查挂载）', kind: 'uncovered' }; } // 夹具 / 前端等非后端文件：不查路由与挂载
    else {
      let mount;
      if (!ctx.indexOk) mount = { text: '反查失败（' + (ctx.indexError || '读不到 routes/sysbuild/index.js') + '，挂载未核）', kind: 'failed' };
      else {
        const mi = mountInfo(ctx, base);
        const trunc = mi.truncated.length ? '；index.js 里有 ' + mi.truncated.length + ' 个调用括号没配上（行 ' + mi.truncated.join('、') + '），已扫范围不完整' : '';
        if (mi.lines.length) mount = { text: 'index.js:' + mi.lines.join('、') + trunc, kind: 'hit' };
        else if (mi.ambiguous.length || mi.truncated.length) mount = { text: '未覆盖（' + (mi.ambiguous.length ? 'index.js 行 ' + mi.ambiguous.join('、') + ' 只靠被多个 require 绑定的同名变量引用本文件，无法归属' : '') + (mi.ambiguous.length && mi.truncated.length ? '；' : '') + (mi.truncated.length ? '调用括号没配上（行 ' + mi.truncated.join('、') + '），已扫范围不完整' : '') + '）', kind: 'uncovered' };
        else mount = { text: '指定范围内无命中（index.js 里没找到挂载 ' + base + ' 的 use / mount / register 调用）', kind: 'none' };
      }
      out.route = { text: parts.join('；'), kind: anyHit ? 'hit' : (anyFail ? 'failed' : 'none') };
      out.mount = mount;
    }
  } else { out.route = { text: '未覆盖（符号 / 说明里没写 METHOD /sysbuild/路径）', kind: 'uncovered' }; out.mount = { text: '未覆盖（符号 / 说明里没写路由）', kind: 'uncovered' }; }
  // ③ 用例夹具
  const needles = [];
  for (const n of names) needles.push({ label: n, needle: n, word: true });
  for (const n of idsOf(row.symbol).filter((x) => x.includes('_') && x.length >= 6 && !names.includes(x))) needles.push({ label: n, needle: n, word: true });
  const fragSeen = new Set();
  for (const r of routes) {
    const frag = staticFragment(r.path);
    if (frag.length >= 5 && !fragSeen.has(frag)) { fragSeen.add(frag); needles.push({ label: "路由片段 '" + frag + "'", needle: frag, word: false }); }
  }
  // 两处夹具目录各自记录读取结果：任一目录缺失 / 读失败，就不能把「另一目录里没命中」写成「指定范围内无命中」——没命中时标反查失败，有命中时命中照写、另注明缺失目录未覆盖
  const badDirs = (ctx.fixtureDirs || []).filter((d) => !d.ok);
  const dirNote = badDirs.map((d) => d.rel + '（' + d.error + '）').join('、');
  if (!needles.length) out.fixtures = { text: '未覆盖（符号里没有导出名 / snake_case 标识符 / 路由片段可搜）', kind: 'uncovered' };
  else if (!ctx.fixtures.length && !badDirs.length) out.fixtures = { text: '反查失败（没有读到任何夹具文件）', kind: 'failed' };
  else if (!ctx.fixtures.length) out.fixtures = { text: '反查失败（夹具目录读取失败：' + dirNote + '）', kind: 'failed' };
  else {
    const scope = '夹具 ' + ctx.fixtures.length + ' 个文件，不含经中间夹具间接搭数据';
    const parts = needles.slice(0, 8).map((x) => { const h = fixtureHits(ctx, x.needle, x.word); return x.label + '：' + (h.length ? h.join('、') : '指定范围内无命中'); });
    const anyHit = needles.some((x) => fixtureHits(ctx, x.needle, x.word).length > 0);
    if (!anyHit && badDirs.length) out.fixtures = { text: parts.join('；') + '；但夹具目录没读全：' + dirNote + '，「无命中」不完整：反查失败', kind: 'failed' };
    else out.fixtures = { text: parts.join('；') + (needles.length > 8 ? '；另 ' + (needles.length - 8) + ' 项未列' : '') + (anyHit ? '' : '（范围：' + scope + '）') + (badDirs.length ? '（注意：夹具目录没读全：' + dirNote + '，该目录未覆盖）' : ''), kind: anyHit ? 'hit' : 'none' };
  }
  return out;
}

// ── 删除清单第三节：后端文件名 ─────────────────────────────────────────────────────────
function deletionListFiles(text) {
  const lines = text.split(/\r?\n/);
  const a = lines.findIndex((l) => /^## 三、/.test(l));
  const b = lines.findIndex((l, i) => i > a && /^## 四、/.test(l));
  if (a < 0) return { files: [], error: '没找到「## 三、」' };
  const files = [];
  const add = (n) => { if (!files.includes(n)) files.push(n); };
  let inTable = false;
  for (const l of lines.slice(a, b < 0 ? undefined : b)) {
    if (l.startsWith('|')) {
      if (/^\|[\s:|-]+\|?\s*$/.test(l)) { inTable = true; continue; }
      if (!inTable) continue; // 表头
      const m = /`([A-Za-z0-9_-]+\.js)`/.exec(P.splitRow(l)[0] || '');
      if (m) add(m[1]);
    } else {
      inTable = false;
      if (/不动的|只需改/.test(l)) for (const m of l.matchAll(/`([A-Za-z0-9_-]+\.js)`/g)) add(m[1]);
    }
  }
  return { files, error: files.length ? null : '第三节里没读出任何后端文件名' };
}

// ── 生成 ───────────────────────────────────────────────────────────────────────────────
// reg = 期望清单（{ files, tables }）；缺省（自检里直接调用）不核对期望清单
function loadInput(invDir, reg) {
  const names = fs.readdirSync(invDir).filter((f) => /^del-inv-.*\.md$/.test(f)).sort();
  const rows = [];
  const tablesInfo = [];
  const hashes = [];
  const audits = [];
  const excluded = [];
  const regProblems = [];
  const fileLevel = []; // 有文件级去向的排除表生成的可分派记录（见 FILE_LEVEL）
  const shaStats = { ok: [], mismatch: [], unregistered: [], missing: [] }; // 78 号 LOW：原件摘要核对的实际结果（摘要行按它生成，不写死「九份已核」）
  const flExcludedSeen = new Set();
  const regStats = { filesWant: 0, filesGot: names.length, tablesWant: 0, tablesGot: 0, missing: 0, unregistered: 0, roleMismatch: 0, pathMismatch: 0 };
  if (reg) {
    regStats.filesWant = reg.files.length;
    for (const f of reg.files) if (!names.includes(f)) { shaStats.missing.push(f); regProblems.push(`缺文件：期望的取证原件 ${f} 不在 ${invDir}`); }
    // 目录全集与期望清单对比：多出的任何文件（不止 del-inv-*.md）都报
    for (const f of fs.readdirSync(invDir)) if (!reg.files.includes(f)) regProblems.push(`多出未登记的取证文件：${f}（目录里有、期望清单里没有）`);
    regStats.tablesWant = reg.tables.length;
  }
  for (const f of names) {
    const abs = path.join(invDir, f);
    hashes.push(f + ' ' + P.sha12(abs));
    // 冻结证据：登记了 sha256 的原件逐个核对
    if (reg && reg.files.includes(f) && reg.sha256) {
      if (!reg.sha256[f]) { shaStats.unregistered.push(f); regProblems.push(`取证原件 ${f} 没有登记 sha256`); } else if (reg.sha256[f] !== P.sha256(abs)) { shaStats.mismatch.push(f); regProblems.push(`取证原件 ${f} 的 sha256 与登记不符（登记 ${reg.sha256[f].slice(0, 12)}…，实际 ${P.sha12(abs)}…；原件被改动过？）`); } else shaStats.ok.push(f);
    } else if (reg && reg.files.includes(f)) shaStats.unregistered.push(f);
    const text = P.readText(abs);
    const allTables = P.parseTables(text);
    regStats.tablesGot += allTables.length;
    const tables = selectTables(allTables);
    const rs = rowsOf(f, tables);
    rows.push(...rs);
    tablesInfo.push({ file: f, tables: tables.length, rows: rs.length });
    // 期望表核对 + 排除表的登记理由
    const reasonOf = new Map();
    if (reg && reg.files.includes(f)) {
      const rec = P.reconcile(f, allTables, reg.tables);
      for (const t of rec.unregistered) { regStats.unregistered += 1; regProblems.push(`多出未登记的表${roleOf(t) === 'sym' ? '（含标签列）' : ''}：${P.shortTable(f, t)}`); }
      for (const e of rec.missing) { regStats.missing += 1; regProblems.push(`缺表：登记的表在原件里没找到：${P.shortEntry(e)}`); }
      for (const m of rec.matched) {
        const role = roleOf(m.table);
        if (m.entry[3] !== role) { regStats.roleMismatch += 1; regProblems.push(`表角色不符：${P.shortTable(f, m.table)} 登记为 ${m.entry[3]}，按表头判为 ${role}`); }
        reasonOf.set(m.table, m.entry[4]);
      }
      for (const mm of rec.mismatched) { regStats.pathMismatch += 1; regProblems.push(`表归属错配：${P.shortTable(f, mm.table)}：${mm.why}`); }
    } else if (reg) {
      // 不在期望文件里的取证原件：它的每张表都是「多出未登记的表」
      for (const t of allTables) { regStats.unregistered += 1; regProblems.push(`多出未登记的表${roleOf(t) === 'sym' ? '（含标签列）' : ''}：${P.shortTable(f, t)}（文件 ${f} 不在期望文件里）`); }
    }
    // 原文里围栏之外每一个以 | 开头的非分隔行（H2）：必须落在某张已解析表上；入选的表算「入选」，其余按排除原因分类（变异表 / 没有标签列的表）
    const audit = P.auditPipeLines(text, allTables);
    const cat = { selected: 0, mutation: 0, noTag: 0 };
    for (const t of allTables) {
      const n = 1 + t.rows.length; // 表头行 + 数据行
      const role = roleOf(t);
      if (role === 'sym') cat.selected += n; else if (role === 'mut') cat.mutation += n; else cat.noTag += n;
      if (role !== 'sym') excluded.push({ src: f + ':' + t.headerLine, file: f, heading: t.heading, header: P.normHeader(t.header), rows: t.rows.length, role, reason: reasonOf.get(t) || '' });
    }
    const crossedBlank = [];
    for (const t of allTables) for (const r of t.rows) if (r.crossedBlank) crossedBlank.push(f + ':' + r.line + '–' + r.endLine);
    audits.push({ file: f, total: audit.total, uncovered: audit.uncovered, parsedEmpty: audit.parsedEmpty, contPipe: audit.contPipe, unclosedFence: audit.unclosedFence, crossedBlank, ...cat, continuation: allTables.reduce((a, t) => a + t.rows.filter((r) => r.endLine !== r.line).length, 0), ambiguousRows: rs.filter((r) => r.ambiguous).length });
    // 排除表里有文件级去向的（75 HIGH-1）：已登记的生成可分派记录；扫到文件级表述却没登记的报问题
    //   78 号 MEDIUM-1：扫描原件里全部文件级处置表述（不只表前、不只第一条），每一条都要关联到：已登记的排除表（同一小节里，表前表后都算）/ 小节里有逐行取的符号表 / 登记的排除（fileLevelExcluded，写明理由）；
    //   同一小节里同一对象的显式标签相互冲突、或与登记标签不符、或标签映射不到提交都报错；每条文件级登记必须恰好匹配一张角色为 nt 的表。
    if (reg) {
      const lines = text.split(/\r?\n/);
      const fm = P.fenceMask(lines);
      const headingLineOf = (idx) => { for (let k = idx; k >= 0; k -= 1) if (!fm.mask[k] && /^#{1,6} /.test(lines[k])) return k + 1; return 0; };
      const hits = [];
      lines.forEach((l, i) => { if (!fm.mask[i] && !P.isPipeLine(l) && l.trim() !== '' && FILE_LEVEL_RE.test(l)) { const m = FILE_LEVEL_RE.exec(l); hits.push({ line: i + 1, text: l, tag: m && m[1] && (DELETABLE.includes(m[1]) || STAY.includes(m[1])) ? m[1] : '', sec: headingLineOf(i) }); } });
      const regOfTable = (t) => (reg.fileLevel || []).find((x) => x.table[0] === f && x.table[1] === t.heading && x.table[2] === P.normHeader(t.header));
      // 登记的文件级去向：匹配表数 / 角色 / 小节里的全部表述
      for (const x of reg.fileLevel || []) {
        if (x.table[0] !== f) continue;
        const mt = allTables.filter((t) => t.heading === x.table[1] && P.normHeader(t.header) === x.table[2]);
        if (mt.length !== 1) { regProblems.push(`文件级去向登记 ${x.file} 应恰好匹配 1 张排除表（${x.table[0]} / ${x.table[1]}），原件里匹配到 ${mt.length} 张`); continue; }
        const t = mt[0];
        if (roleOf(t) !== 'nt') regProblems.push(`文件级去向登记 ${x.file} 对应的表 ${P.shortTable(f, t)} 的角色是 ${roleOf(t)}，应是排除的 nt 表`);
        const own = hits.filter((h) => h.sec === t.headingLine);
        const tags = Array.from(new Set(own.map((h) => h.tag).filter(Boolean)));
        if (own.length === 0) regProblems.push(`文件级去向登记 ${x.file} 对应的小节（${f}:${t.headingLine}）里没扫到任何文件级处置表述（整个文件 <标签>）`);
        if (tags.length > 1) regProblems.push(`文件级去向登记 ${x.file} 所在小节里同一对象写了相互冲突的文件级标签：${tags.join(' / ')}（${own.map((h) => f + ':' + h.line).join('、')}）`);
        else if (tags.length === 1 && tags[0] !== x.tag) regProblems.push(`文件级去向登记 ${x.file} 的标签 ${x.tag} 与原件 ${f}:${own.find((h) => h.tag).line} 写的 ${tags[0]} 不符`);
        if (!COMMIT_OF[x.tag]) regProblems.push(`文件级去向登记 ${x.file} 的标签 ${x.tag} 映射不到提交（可删标签才有第一步提交）`);
        const first = own.find((h) => h.tag) || own[0];
        fileLevel.push({ file: x.file, repoPath: x.repoPath, src: f + ':' + t.headerLine, evidenceLine: first ? f + ':' + first.line : '', evidenceText: first ? first.text.trim() : '', tag: x.tag, op: x.op, commit: COMMIT_OF[x.tag] ? 'C' + COMMIT_OF[x.tag] : '', basis: x.evidence, reason: reasonOf.get(t) || '', heading: t.heading });
      }
      // 每一条表述都要有去处
      for (const h of hits) {
        const secTables = allTables.filter((t) => t.headingLine === h.sec);
        const exc = (reg.fileLevelExcluded || []).find((x) => x.src === f + ':' + h.line);
        if (exc) { flExcludedSeen.add(exc.src); if (!h.text.trim().startsWith(exc.prefix)) regProblems.push(`登记的排除文件级处置表述 ${exc.src} 的文字与原件对不上（登记前缀「${exc.prefix}」，原件「${h.text.trim().slice(0, 40)}」）`); continue; }
        if (secTables.some((t) => regOfTable(t))) continue; // 已登记的排除表所在小节
        if (secTables.some((t) => roleOf(t) === 'sym')) continue; // 小节里的符号表逐行取（行里已有该文件每个符号的标签）
        regProblems.push(`${f}:${h.line} 有文件级处置表述「${h.text.trim().slice(0, 50)}」，没有关联到任何登记的文件级去向（FILE_LEVEL）、小节里也没有逐行取的符号表、又不在登记的排除表述里：入口 1 可能漏掉它的整删 / 整体处置`);
      }
      // 排除表的登记理由里写了文件级关键词、却没有登记
      for (const t of allTables) if (roleOf(t) !== 'sym' && !regOfTable(t) && FILE_LEVEL_RE.test(reasonOf.get(t) || '')) regProblems.push(`排除表 ${P.shortTable(f, t)} 的登记理由里写了文件级去向表述，但没有登记文件级去向记录（FILE_LEVEL）`);
    }
  }
  if (reg) {
    for (const f of reg.files) {
      if (names.includes(f)) continue;
      const n = reg.tables.filter((e) => e[0] === f).length;
      if (n) { regStats.missing += n; regProblems.push(`缺表：文件 ${f} 不存在，登记在它名下的 ${n} 张表都没有核对`); }
    }
  }
  // 78 号 MEDIUM-1：登记的「排除的文件级处置表述」逐条核——没被原件命中的（原件变了 / 登记写错）报问题
  if (reg) for (const x of reg.fileLevelExcluded || []) if (names.includes(x.src.split(':')[0]) && !flExcludedSeen.has(x.src)) regProblems.push(`登记的排除文件级处置表述 ${x.src} 在原件里没有命中（行号 / 文字对不上：「${x.prefix}」）`);
  return { names, rows, tablesInfo, hashes, audits, excluded, regProblems, regStats, registryChecked: !!reg, fileLevel, shaStats };
}
function build(input, ctx) {
  const none = { text: '—', kind: 'uncovered' };
  const entries = input.rows.map((r) => {
    const c = classifyRow(r);
    return { ...r, ...c, x: ctx ? crossRefs(ctx, r) : { readers: none, route: none, mount: none, fixtures: none } };
  });
  const tagStats = new Map();
  const unknown = new Map();
  for (const e of entries) {
    tagStats.set(e.tagText, (tagStats.get(e.tagText) || 0) + 1);
    for (const u of e.unknown) unknown.set(u, (unknown.get(u) || 0) + 1);
  }
  const byFile = new Map();
  for (const e of entries) { const k = e.file || '(无文件标题)'; if (!byFile.has(k)) byFile.set(k, []); byFile.get(k).push(e); }
  // 裁定清单（75 MEDIUM-2）：初判不能直接用的两类行，带原件位置单列——「留」但原件标「拿不准」（标签里只有保留类，若实际涉及待删分支，入口 1 会跳过它）；
  //   待裁定、且标签里没有可删标签（没有候选提交，入口 1 按提交取不到它）。每个提交收口时由主会话把本提交相关的行落到最终去向 + 依据（两列留空）。
  //   78 号 MEDIUM-2：歧义行的候选读法不完整（amb-none / amb-cap / 边界待裁定 / 仍欠宽，候选集合无法完整确定）时，即使主读法已有候选提交也进裁定清单。
  const adjudicate = entries.filter((e) => isAdjudicate(e, e)).map((e) => ({ src: e.src, file: e.file, symbol: e.symbol, tagText: e.tagText, cls: e.cls, why: adjWhy(e) }));
  return { entries, byFile, tagStats, unknown, adjudicate, sources: ctx ? ctx.sources : null, fileLevel: input.fileLevel || [] };
}
const memoOf = (e) => [
  e.ambiguous ? '解析歧义：' + e.ambReason + '（原文：' + e.raw.slice(0, 400) + '）' + (e.candText ? '；候选读法：' + e.candText : '') : '',
  e.unknown.length ? '未知标签词：' + e.unknown.join('、') : '',
  /拿不准/.test(e.tagText) ? '原件标拿不准' : '',
  e.review && e.ambiguous ? '歧义行：按全部候选读法的可删提交 ' + e.review + ' 列复核（保持待裁定，这些提交收口时都要取到本行）' + (e.candIncomplete ? '；候选读法不完整，已进 1.8 裁定清单' : '') : '',
  e.review && !e.ambiguous ? '共享对象：整删时点取最晚的 ' + e.commit + '；' + e.review + ' 各提交要先核对本对象对较早停用模块的依赖（顶层依赖或分支引用了较早整删的文件，较早提交先删会使模块加载失败）' : '',
].filter(Boolean).join('；');
function render(g, input, meta, deletionFiles) {
  const L = [];
  const entries = g.entries;
  L.push('# #212 第一步逐行实施清单（骨架，机械初判）');
  L.push('');
  L.push('> 生成器 `wbs-server/scripts/sysbuild-step1/build-impl-list.js`；机械分类只是初判，主会话逐行裁定。');
  L.push(`> 生成时刻：${meta.generatedAt}；仓库 HEAD：${meta.head || '（取不到）'}`);
  L.push('> 输入文件 sha256 前 12 位：' + input.hashes.join('；'));
  L.push('> 取表口径：表头里有「标签」或「流程标签」列、且不是变异表的全部表；每个数据行一行。保留类标签 = KEEP / INV / SETUP / RPT（RPT = 进度汇报，保留）。');
  L.push('');
  L.push('## 一、汇总');
  L.push('');
  L.push(`共 ${entries.length} 行（取了 ${input.tablesInfo.reduce((a, x) => a + x.tables, 0)} 张表）。`);
  L.push('');
  L.push('### 1.1 按分类');
  L.push('');
  L.push('| 分类 | 行数 |');
  L.push('|---|---|');
  for (const c of CLASSES) L.push(`| ${c} | ${entries.filter((e) => e.cls === c).length} |`);
  L.push(`| 留（原件标拿不准） | ${entries.filter((e) => e.cls === '留' && /拿不准/.test(e.tagText)).length} |`);
  L.push('');
  L.push('「留（原件标拿不准）」是「留」的子集：标签单元格里写着「拿不准」的行，明细「备注」列写「原件标拿不准」，可按它筛。');
  L.push('');
  const flagged = entries.filter((e) => e.cls === '拆（待裁定）' && e.main.every((x) => STAY.includes(x)));
  L.push(`其中 ${flagged.length} 行的「拆」仅由括号里的注记标签触发（主标签都是保留类标签）；这类行在明细里「注记标签」列非空，建议优先过目。`);
  L.push('');
  L.push('### 1.2 按所属提交（分类为「删」的行按最晚可删提交；「拆」按候选提交，含该提交即计；「待裁定」按标签里含的可删标签，含该提交即计）');
  L.push('');
  L.push('| 提交 | 删（行数，所属提交 = 最晚可删提交） | 拆（候选里含该提交，行数） | 待裁定（解析歧义 / 未知标签词 / 无标签，标签里含该提交的可删标签，行数；解析歧义行取全部候选读法的并集） | 共享对象的较早复核（分类「删」、带多个可删标签、候选里含该提交但整删时点更晚，行数） | 文件级整删记录（见 1.7，行数） |');
  L.push('|---|---|---|---|---|---|');
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    L.push(`| C${n} | ${entries.filter((e) => e.cls === '删' && e.commit === 'C' + n).length} | ${entries.filter((e) => e.cls === '拆（待裁定）' && e.commits.includes(n)).length} | ${entries.filter((e) => e.cls.startsWith('待裁定') && e.commits.includes(n)).length} | ${entries.filter((e) => e.cls === '删' && e.commits.includes(n) && e.commit !== 'C' + n).length} | ${(g.fileLevel || []).filter((x) => x.commit === 'C' + n).length} |`);
  }
  const moved = entries.filter((e) => e.cls === '删' && e.earliest !== e.latest);
  const pend = entries.filter((e) => e.cls.startsWith('待裁定'));
  L.push('');
  L.push(`「删」行带多个可删标签时所属提交取最晚的（被多个流程共用的符号要等最后一个使用者删掉才能删）；因此所属提交与「取最早」口径不同的行有 ${moved.length} 行（明细「最早 / 最晚可删提交」列两端不同的「删」行）。待裁定行共 ${pend.length} 行（其中解析歧义 ${pend.filter((e) => e.cls === '待裁定（解析歧义）').length}、未知标签词 ${pend.filter((e) => e.cls === '待裁定（未知标签词）').length}、无标签 ${pend.filter((e) => e.cls === '待裁定（无标签）').length}），全部要人工定分类与提交，不参与机械分派；无任何可删标签可读的待裁定行 ${pend.filter((e) => e.commits.length === 0).length} 行，只能靠原文判断提交。`);
  L.push('');
  L.push('### 1.3 标签取值统计（标签单元格原文，按出现次数降序）');
  L.push('');
  const top = Array.from(g.tagStats.entries()).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  L.push(`共 ${top.length} 种不同的原文取值；前 40 种：`);
  L.push('');
  L.push('| 次数 | 标签原文 |');
  L.push('|---|---|');
  for (const [t, n] of top.slice(0, 40)) L.push(`| ${n} | ${esc(t.slice(0, 120))} |`);
  L.push('');
  const lab = new Map();
  for (const e of entries) for (const x of e.main) lab.set(x, (lab.get(x) || 0) + 1);
  L.push('已知标签在「主标签」里的出现行数：' + P.KNOWN_LABELS.map((k) => `${k} ${lab.get(k) || 0}`).join('；'));
  L.push('');
  L.push('未知标签词（括号之外出现的、不在已知取值里的大写词）：' + (g.unknown.size ? Array.from(g.unknown.entries()).map(([k, n]) => `${k}×${n}`).join('；') : '无') + '。含未知词的行一律「待裁定（未知标签词）」。');
  L.push('');
  L.push('### 1.4 文件总表（按文件的行数与分类；也是反向校验对照删除清单第三节的依据）');
  L.push('');
  L.push('| 文件 | 行数 | 留 | 删 | 拆 | 待裁定 | 备注 |');
  L.push('|---|---|---|---|---|---|---|');
  const fileNames = new Set(g.byFile.keys());
  for (const f of deletionFiles || []) fileNames.add(f);
  for (const x of g.fileLevel || []) fileNames.add(x.file);
  for (const f of Array.from(fileNames).sort()) {
    const es = g.byFile.get(f) || [];
    const n = (c) => es.filter((e) => e.cls === c).length;
    const notes = [];
    const fl = (g.fileLevel || []).filter((x) => x.file === f);
    if (es.length === 0 && fl.length === 0) notes.push('无逐行记录（取证原件里没有这个文件的符号表）');
    if (es.length === 0 && fl.length > 0) notes.push('无逐行记录，但有文件级去向记录（见 1.7）：' + fl.map((x) => x.op + ' ' + x.commit).join('、'));
    if ((deletionFiles || []).includes(f)) notes.push('删除清单第三节列出');
    L.push(`| ${esc(f)} | ${es.length} | ${n('留')} | ${n('删')} | ${n('拆（待裁定）')} | ${es.filter((e) => e.cls.startsWith('待裁定')).length} | ${notes.join('；')} |`);
  }
  L.push('');
  L.push('### 1.5 被排除的表（逐张列出；排除类别 nt = 没有标签列的表，mut = 变异表；每张必须有登记的理由）');
  L.push('');
  L.push('| 原件位置 | 所在标题 | 表头 | 数据行 | 排除类别 | 排除理由 |');
  L.push('|---|---|---|---|---|---|');
  for (const x of input.excluded) L.push(`| ${esc(x.src)} | ${esc(x.heading)} | ${esc(x.header)} | ${x.rows} | ${x.role} | ${esc(x.reason || '（未登记）')} |`);
  L.push('');
  const kinds = ['hit', 'none', 'uncovered', 'failed'];
  const kindName = { hit: '命中', none: '指定范围内无命中', uncovered: '未覆盖', failed: '反查失败' };
  L.push('### 1.6 三向反查结果分布（行数；「未覆盖」= 这一格对这一行不适用或没有可搜的对象，「指定范围内无命中」= 在注明的检索范围内没搜到，两者都不等于「确认没有」）');
  L.push('');
  L.push('| 反查 | ' + kinds.map((k) => kindName[k]).join(' | ') + ' |');
  L.push('|---|' + kinds.map(() => '---').join('|') + '|');
  for (const [k, label] of [['readers', '读写方'], ['route', '路由注册'], ['mount', '路由挂载（index.js）'], ['fixtures', '用例夹具']]) L.push(`| ${label} | ${kinds.map((x) => entries.filter((e) => e.x[k].kind === x).length).join(' | ')} |`);
  L.push('');
  L.push('路由注册与路由挂载分开记（75 MEDIUM）：注册 = 该文件里 router.<method>( 后跟路径字面量（可跨行）；挂载 = index.js 里 use / mount / register 的调用（括号内可跨行）里出现该文件的 require 或它的变量。「读取结果」逐项记在下面：某一处没读到时，对应格标「反查失败」，不写「指定范围内无命中」；xref-exports 有文件扫描失败时，读写方的「无引用」结论同样标「反查失败」（失败文件里可能有引用）。');
  L.push('');
  if (g.sources) {
    L.push('| 反查输入 | 路径 | 读取结果 |');
    L.push('|---|---|---|');
    for (const s of g.sources) L.push(`| ${esc(s.name)} | ${esc(s.rel)} | ${esc(s.ok ? '读到 ' + s.count + ' 个' + (s.note ? '（' + s.note + '）' : '') : '读取失败：' + s.error)} |`);
    L.push('');
  }
  L.push('### 1.7 文件级去向记录（排除表里有文件级去向的，生成可分派记录；入口 1 按提交取行时必须看到它们）');
  L.push('');
  L.push(`共 ${(g.fileLevel || []).length} 条。原件在排除表上方明确写了文件级去向、删除清单也写了整删的文件，不能只留一句排除理由；每条在这里恰好出现一次，回读核对。扫全部排除表（没有标签列的表、变异表）找同类，扫到文件级表述却没有登记的算反向校验问题。`);
  L.push('');
  L.push('| 文件路径 | 原件位置（排除表） | 原件依据行 | 文件级标签 | 去向 | 提交 | 登记依据 | 排除表登记理由 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of g.fileLevel || []) L.push(`| ${esc(x.repoPath)} | ${esc(x.src)} | ${esc(x.evidenceLine + (x.evidenceText ? '「' + x.evidenceText.slice(0, 60) + '」' : ''))} | ${x.tag} | ${x.op} | ${x.commit} | ${esc(x.basis)} | ${esc(x.reason)} |`);
  L.push('');
  L.push('### 1.8 裁定清单（初判不能直接用的行，带原件位置；「最终去向」「依据」两列留空，每个提交收口时由主会话把本提交相关的行落到这一层）');
  L.push('');
  L.push(`共 ${(g.adjudicate || []).length} 行：「留」但原件标「拿不准」${(g.adjudicate || []).filter((x) => x.cls === '留').length} 行；待裁定且没有候选提交 ${(g.adjudicate || []).filter((x) => x.cls !== '留').length} 行。`);
  L.push('');
  L.push('| 原件位置 | 文件 | 符号 | 标签原文 | 初判 | 裁定原因 | 最终去向 | 依据 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of g.adjudicate || []) L.push(`| ${esc(x.src)} | ${esc(x.file)} | ${esc(x.symbol)} | ${esc(x.tagText)} | ${esc(x.cls)} | ${esc(x.why)} | | |`);
  L.push('');
  L.push('## 二、逐行明细');
  L.push('');
  L.push('列：原件位置 = 取证原件文件名:行号；初判与提交见上文规则（「删」的所属提交取最晚可删提交，「拆」列候选）；「最早 / 最晚可删提交」对所有带可删标签的行都写；读写方 / 路由 / 夹具三列是自动反查，不替代人工反查（取值见 1.6 的四类）。');
  L.push('');
  for (const f of Array.from(g.byFile.keys()).sort()) {
    const es = g.byFile.get(f);
    L.push(`### ${f}（${es.length} 行）`);
    L.push('');
    L.push('| 原件位置 | 文件 | 符号 | 行号 | 说明 | 标签 | 主标签 | 注记标签 | 判断依据 | 初判 | 所属提交 | 读写方 | 路由注册 | 路由挂载 | 用例夹具 | 最早 / 最晚可删提交 | 全部候选复核提交 | 备注 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of es) {
      L.push(`| ${esc(e.src)} | ${esc(e.file)} | ${esc(e.symbol)} | ${esc(e.lines)} | ${esc(e.desc)} | ${esc(e.tagText)} | ${esc(e.main.join('+'))} | ${esc(e.note.join('+'))} | ${esc(e.basis)} | ${esc(e.cls)} | ${esc(e.commit)} | ${esc(e.x.readers.text)} | ${esc(e.x.route.text)} | ${esc(e.x.mount.text)} | ${esc(e.x.fixtures.text)} | ${esc(e.span)} | ${esc(e.review)} | ${esc(memoOf(e))} |`);
    }
    L.push('');
  }
  return L;
}

// ── 反向校验 ───────────────────────────────────────────────────────────────────────────
function checkOutput(outText, input, deletionFiles) {
  const problems = [];
  const warnings = [];
  for (const p of input.regProblems || []) problems.push(p);
  const allOut = P.parseTables(outText);
  const tables = allOut.filter((t) => t.header[0] === '原件位置' && t.header[1] === '文件' && t.header[2] === '符号' && t.header[3] === '行号');
  const outRows = [];
  for (const t of tables) for (const r of t.rows) outRows.push({ src: r.cells[0], file: r.cells[1], symbol: r.cells[2], lines: r.cells[3], tag: r.cells[5], cls: r.cells[9], commit: r.cells[10] || '', span: r.cells[15] || '', review: r.cells[16] || '', memo: r.cells[17] || '', line: r.line });
  // 单元格里的 | 在输出里写成 \|，重新解析会还原成 |，所以输入输出都按还原后的值比；标签原文也在键里（只核前四列会让标签错位漏过去）
  const key = (x) => [x.src, x.file, x.symbol, x.lines, x.tag].join('\u0001');
  const got = new Map();
  for (const r of outRows) { const k = key(r); got.set(k, (got.get(k) || 0) + 1); }
  const wantU = new Map();
  for (const r of input.rows) { const k = key({ src: r.src, file: r.file, symbol: r.symbol, lines: r.lines, tag: r.tagText }); wantU.set(k, (wantU.get(k) || 0) + 1); }
  for (const [k, n] of wantU) { const m = got.get(k) || 0; if (m !== n) problems.push(`原件行 ${k.split('\u0001').join(' | ')}：应出现 ${n} 次，实际 ${m} 次`); }
  for (const [k, m] of got) if (!wantU.has(k)) problems.push(`输出里多出的行（原件里没有）：${k.split('\u0001').join(' | ')}（${m} 次）`);
  const inTotal = input.rows.length;
  if (outRows.length !== inTotal) problems.push(`行数不符：原件入选 ${inTotal} 行，输出明细 ${outRows.length} 行`);
  // 75 MEDIUM：用原件行的标签原文（tagText）与解析歧义标记（ambiguous）重算期望，逐行核输出的初判、所属提交、最早 / 最晚可删提交、复核提交，并核备注里的歧义说明与原件一致
  //   （旧版从输出备注反推「原件是否歧义」：同时去掉歧义备注并把初判改成「留」就能通过；改所属提交也核不出来）
  const inByKey = new Map();
  for (const r of input.rows) { const k = key({ src: r.src, file: r.file, symbol: r.symbol, lines: r.lines, tag: r.tagText }); if (!inByKey.has(k)) inByKey.set(k, []); inByKey.get(k).push(r); }
  const usedK = new Map();
  for (const r of outRows) {
    const k = key(r);
    const i = usedK.get(k) || 0;
    usedK.set(k, i + 1);
    const inRow = (inByKey.get(k) || [])[i];
    if (!inRow) continue; // 原件里没有的行上面已报
    const c = classifyRow(inRow);
    if (c.cls !== r.cls) problems.push(`输出行 ${r.src} 的初判「${r.cls}」与按标签原文（及原件的解析歧义标记）重算的「${c.cls}」不一致`);
    if (c.commit !== r.commit) problems.push(`输出行 ${r.src} 的所属提交「${r.commit}」与按标签原文重算的「${c.commit}」不一致`);
    if (c.span !== r.span) problems.push(`输出行 ${r.src} 的最早 / 最晚可删提交「${r.span}」与按标签原文重算的「${c.span}」不一致`);
    if (c.review !== r.review) problems.push(`输出行 ${r.src} 的全部候选复核提交「${r.review}」与按标签原文重算的「${c.review}」不一致`);
    // 78 号 MEDIUM-4：对原件歧义行，按原件行核对输出备注里的歧义原因、原文与候选读法（不只看「解析歧义：」前缀——缩成前缀后裁定时就丢了原文和候选）
    const ambPart = inRow.ambiguous ? '解析歧义：' + inRow.ambReason + '（原文：' + inRow.raw.slice(0, 400) + '）' + (inRow.candText ? '；候选读法：' + inRow.candText : '') : '';
    if (inRow.ambiguous && !r.memo.includes(ambPart)) problems.push(`输出行 ${r.src} 在原件里是解析歧义行（${inRow.ambReason}），但输出备注里没有完整的解析歧义说明（原因、原文${inRow.candText ? '、候选读法' : ''}）`);
    if (!inRow.ambiguous && /解析歧义：/.test(r.memo)) problems.push(`输出行 ${r.src} 在原件里不是解析歧义行，但输出备注里写了解析歧义`);
    if (r.cls === '待裁定（解析歧义）' && !inRow.ambiguous) problems.push(`输出行 ${r.src} 的初判自带「解析歧义」标记，但原件行不是歧义行`);
  }
  // 78 号 MEDIUM-3：1.7 / 1.8 按稳定节标识（### 1.7 / ### 1.8）限定回读范围，逐字段逐条核对，行集合按多重集比较（重复、改字段、移到别的节都报）
  const outLines = outText.split(/\r?\n/);
  const subSecOf = (t) => { for (let k = t.headerLine - 1; k >= 0; k -= 1) { const m = /^### (.+)$/.exec(outLines[k] || ''); if (m) return m[1]; if (/^## /.test(outLines[k] || '')) return ''; } return ''; };
  const rowsInSub = (pred, prefix) => [].concat(...allOut.filter((t) => pred(t) && subSecOf(t).startsWith(prefix)).map((t) => t.rows.map((r) => r.cells)));
  const tup = (...xs) => xs.map((x) => String(x === undefined ? '' : x).trim()).join('\u0001');
  const multiDiff = (what, wantArr, gotArr) => {
    const cnt = (arr) => { const m = new Map(); for (const x of arr) m.set(x, (m.get(x) || 0) + 1); return m; };
    const w = cnt(wantArr);
    const g2 = cnt(gotArr);
    for (const [k, n] of w) if ((g2.get(k) || 0) !== n) problems.push(`${what}：应有 ${n} 行「${k.split('\u0001').join(' | ').slice(0, 160)}」，输出里 ${g2.get(k) || 0} 行`);
    for (const [k, n] of g2) if (!w.has(k)) problems.push(`${what}：输出里多出 ${n} 行「${k.split('\u0001').join(' | ').slice(0, 160)}」`);
  };
  // 75 HIGH-1：有文件级去向的排除表生成的可分派记录，每条恰好出现一次，且分派字段 + 原件依据行逐字段核对（文件路径 | 原件位置 | 原件依据行 | 标签 | 去向 | 提交 | 登记依据 | 排除表登记理由）
  multiDiff('1.7 文件级去向记录', (input.fileLevel || []).map((x) => tup(x.repoPath, x.src, x.evidenceLine + (x.evidenceText ? '「' + x.evidenceText.slice(0, 60) + '」' : ''), x.tag, x.op, x.commit, x.basis, x.reason)), rowsInSub((t) => t.header[0] === '文件路径' && t.header[1] === '原件位置（排除表）', '1.7').map((c) => tup(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7])));
  // 75 MEDIUM-2 / 78 MEDIUM-2：裁定清单用原件行重算期望（留且拿不准；待裁定且没有候选提交；歧义行候选读法不完整），与输出 1.8 逐字段对拍（原件位置 | 文件 | 符号 | 标签原文 | 初判 | 裁定原因 | 最终去向 | 依据）
  multiDiff('1.8 裁定清单', input.rows.map((r) => ({ r, c: classifyRow(r) })).filter((x) => isAdjudicate(x.r, x.c)).map((x) => tup(x.r.src, x.r.file, x.r.symbol, x.r.tagText, x.c.cls, adjWhy(x.c), '', '')), rowsInSub((t) => t.header[0] === '原件位置' && t.header[3] === '标签原文', '1.8').map((c) => tup(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7])));
  // H2：原文里每个以 | 开头的非分隔行都必须落在某张已解析表上（入选的表，或明确排除的两类：变异表、没有标签列的表）；落不到的列为问题
  for (const a of input.audits || []) {
    for (const cb of a.crossedBlank || []) warnings.push(`跨空行合并的断行：${cb}（单元格里的代码片段夹着空行，按上一行没凑够单元格并入；请人工看一眼）`);
    for (const ln of a.uncovered) problems.push(`原件 ${a.file}:${ln} 以 | 开头，但不在任何已解析的表里（表被切丢了）`);
    if (a.parsedEmpty) problems.push(`原件 ${a.file}：原文有以 | 开头的行，但一张表都没解析出来`);
    if (a.unclosedFence) problems.push(`原件 ${a.file}:${a.unclosedFence} 的围栏代码块到文件末尾都没有闭合（不支持的写法：后面的表会被整段跳过，解析与审计同时漏）`);
    if (a.uncovered.length === 0 && a.selected + a.mutation + a.noTag + a.contPipe !== a.total) problems.push(`原件 ${a.file}：以 | 开头的非分隔行共 ${a.total} 行，入选 ${a.selected} + 排除的变异表 ${a.mutation} + 排除的无标签列表 ${a.noTag} + 以 | 开头的断行续行 ${a.contPipe} 合计对不上`);
  }
  // 被排除的表在输出 1.5 里逐张有理由
  const exT = P.parseTables(outText).filter((t) => t.header[0] === '原件位置' && t.header[1] === '所在标题');
  const exRows = [];
  for (const t of exT) for (const r of t.rows) exRows.push(r.cells);
  if (exRows.length !== input.excluded.length) problems.push(`被排除的表：原件 ${input.excluded.length} 张，输出 1.5 列了 ${exRows.length} 张`);
  for (const x of input.excluded) {
    const o = exRows.find((c) => c[0] === x.src);
    if (!o) problems.push(`被排除的表 ${x.src} 没有出现在输出 1.5`);
    else if (input.registryChecked && x.role === 'nt' && (!o[5] || o[5] === '（未登记）')) problems.push(`被排除的表 ${x.src} 没有登记的排除理由`);
  }
  // 删除清单第三节的后端文件都要在「文件总表」里
  const totalTable = P.parseTables(outText).find((t) => t.header[0] === '文件' && t.header[1] === '行数');
  const inTotalTable = new Set(totalTable ? totalTable.rows.map((r) => r.cells[0]) : []);
  if (!totalTable) problems.push('输出里没有「文件总表」');
  for (const f of deletionFiles || []) {
    if (!inTotalTable.has(f)) problems.push(`删除清单第三节的文件 ${f} 不在输出的文件总表里`);
    else if (totalTable.rows.find((r) => r.cells[0] === f).cells[1] === '0') warnings.push(`${f}：删除清单第三节列出，但取证原件没有它的逐行记录`);
  }
  return { problems, warnings, outRows: outRows.length, inRows: inTotal };
}

function parseArgs(argv) {
  const o = { out: null, invDir: DEFAULT_INV_DIR, deletionList: null, repo: DEFAULT_REPO, registryFile: null, check: true, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--self-test') o.selfTest = true;
    else if (a === '--no-check') o.check = false;
    else if (a === '--check') o.check = true;
    else if (['--out', '--inv-dir', '--deletion-list', '--repo', '--registry-file'].includes(a)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(a + ' 需要一个参数');
      const v = argv[i + 1];
      i += 1;
      if (a === '--out') o.out = path.resolve(v); else if (a === '--inv-dir') o.invDir = path.resolve(v); else if (a === '--deletion-list') o.deletionList = path.resolve(v); else if (a === '--registry-file') o.registryFile = path.resolve(v); else o.repo = path.resolve(v);
    } else throw new Error('未知参数 ' + a);
  }
  if (!o.selfTest && !o.out) throw new Error('需要 --out <md>');
  return o;
}
function headOf(repo) { const r = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }

function generate(o) {
  const reg = o.registryFile ? JSON.parse(fs.readFileSync(o.registryFile, 'utf8')) : REGISTRY;
  const input = loadInput(o.invDir, reg);
  const ctx = buildContext(o.repo);
  const g = build(input, ctx);
  const delPath = o.deletionList || path.join(path.dirname(path.dirname(o.invDir)), reg.deletionList);
  let del = { files: [], error: null };
  const extraHashes = [];
  if (fs.existsSync(delPath)) {
    del = deletionListFiles(P.readText(delPath));
    extraHashes.push(path.basename(delPath) + ' ' + P.sha12(delPath));
    if (path.basename(delPath) !== reg.deletionList) input.regProblems.push(`删除清单文件名 ${path.basename(delPath)} 不是期望的 ${reg.deletionList}`);
    // 删除清单是冻结的证据：登记 sha256（与测试去向表生成器同一份登记）
    if (reg.deletionListSha256 && reg.deletionListSha256 !== P.sha256(delPath)) input.regProblems.push(`删除清单 ${path.basename(delPath)} 的 sha256 与登记不符（登记 ${reg.deletionListSha256.slice(0, 12)}…，实际 ${P.sha12(delPath)}…；清单被改动过？）`);
  } else del.error = '删除清单不存在：' + delPath;
  input.hashes.push(...extraHashes);
  // 78 号 LOW：输入核对摘要按实际登记与读取结果生成（缺失 / 不符 / 未登记摘要分别列出，不写死「九份已核」）
  const sh = input.shaStats;
  const delPresent = fs.existsSync(delPath);
  const delSha = !delPresent ? '缺失' : (!reg.deletionListSha256 ? '未登记摘要' : (reg.deletionListSha256 === P.sha256(delPath) ? '摘要已核' : '摘要不符'));
  const delName = !delPresent ? '缺失' : (path.basename(delPath) === reg.deletionList ? '文件名相符' : '文件名不符');
  const inputsLine = `输入核对：取证原件期望 ${reg.files.length} 份、实读 ${input.names.length} 份；摘要已核 ${sh.ok.length} 份、不符 ${sh.mismatch.length} 份${sh.mismatch.length ? '（' + sh.mismatch.join('、') + '）' : ''}、未登记摘要 ${sh.unregistered.length} 份${sh.unregistered.length ? '（' + sh.unregistered.join('、') + '）' : ''}、缺失 ${sh.missing.length} 份${sh.missing.length ? '（' + sh.missing.join('、') + '）' : ''}；删除清单：${delPresent ? delName + '、' + delSha : '缺失'}`;
  const lines = render(g, input, { generatedAt: new Date().toISOString(), head: headOf(o.repo) }, del.files);
  return { input, g, ctx, del, lines, inputsLine, delState: { present: delPresent, name: delName, sha: delSha } };
}
function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error('用法错误：' + e.message); return 2; }
  if (o.selfTest) return selfTest();
  const r = generate(o);
  let text = r.lines.join('\n') + '\n';
  let bad = false;
  if (o.check) {
    const chk = checkOutput(text, r.input, r.del.files);
    if (r.del.error) chk.problems.push(r.del.error);
    const au = (k) => r.input.audits.reduce((n, a) => n + a[k], 0);
    const rs = r.input.regStats;
    const tail = ['', '## 三、反向校验', '', `- 期望清单：期望文件 ${rs.filesWant}、实到 ${rs.filesGot}；登记表 ${rs.tablesWant}、实到 ${rs.tablesGot}；缺表 ${rs.missing}、多出未登记 ${rs.unregistered}、角色不符 ${rs.roleMismatch}、归属错配（完整标题路径 / 所属文件）${rs.pathMismatch}`, `- ${r.inputsLine}`, `- 原文围栏外以 | 开头的非分隔行 ${au('total')} 行 = 入选的表 ${au('selected')}（表头 + 数据行）+ 排除的变异表 ${au('mutation')} + 排除的没有标签列的表 ${au('noTag')} + 以 | 开头的断行续行 ${au('contPipe')}；落不到任何已解析表的 ${r.input.audits.reduce((n, a) => n + a.uncovered.length, 0)} 行；断行续行并入上一行的 ${au('continuation')} 行`, `- 原件入选 ${chk.inRows} 行，输出明细 ${chk.outRows} 行`, `- 删除清单第三节的后端文件 ${r.del.files.length} 个`, `- 问题 ${chk.problems.length} 条；警告 ${chk.warnings.length} 条`];
    for (const p of chk.problems) tail.push('  - 问题：' + p);
    for (const w of chk.warnings) tail.push('  - 警告：' + w);
    if (r.ctx.reportError) tail.push('- 读写方反查的提示：' + r.ctx.reportError);
    text += tail.join('\n') + '\n';
    bad = chk.problems.length > 0;
    console.log(`期望清单：文件 ${rs.filesWant}→${rs.filesGot}；表 ${rs.tablesWant}→${rs.tablesGot}；缺表 ${rs.missing}；多出未登记 ${rs.unregistered}；角色不符 ${rs.roleMismatch}；归属错配 ${rs.pathMismatch}`);
    console.log(`原文以 | 开头的非分隔行 ${au('total')} = 入选 ${au('selected')} + 排除变异表 ${au('mutation')} + 排除无标签列表 ${au('noTag')} + 以 | 开头的续行 ${au('contPipe')}；落不到表的 ${r.input.audits.reduce((n, a) => n + a.uncovered.length, 0)}；断行续行 ${au('continuation')}`);
    console.log(`原件入选 ${chk.inRows} 行；输出明细 ${chk.outRows} 行；问题 ${chk.problems.length}；警告 ${chk.warnings.length}`);
    for (const p of chk.problems.slice(0, 30)) console.log('  问题：' + p);
    for (const w of chk.warnings) console.log('  警告：' + w);
  } else text += '\n## 三、反向校验\n\n- 未执行反向校验（--no-check）：本文件的输入登记（原件 / 表 / 删除清单的存在与摘要）与输出回读都没有核对，不能当作已校验的结果。\n';
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  fs.writeFileSync(o.out, text);
  const cnt = (c) => r.g.entries.filter((e) => e.cls === c).length;
  console.log(`已写入 ${o.out}：共 ${r.g.entries.length} 行；` + CLASSES.map((c) => `${c} ${cnt(c)}`).join('；'));
  console.log('未知标签词：' + (r.g.unknown.size ? Array.from(r.g.unknown.entries()).map(([k, n]) => `${k}×${n}`).join('；') : '无'));
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
  // 分类
  const cl = (t) => classify(t);
  check(cl('KEEP').cls === '留', '分类：只有 KEEP → 留');
  check(cl('INV').cls === '留' && cl('INV, KEEP').cls === '留' && cl('SETUP').cls === '留', '分类：含 INV / SETUP、不含可删标签 → 留');
  const d1 = cl('HIS');
  check(d1.cls === '删' && d1.commit === 'C2', '分类：只含可删标签 HIS → 删，提交 C2');
  const d2 = cl('ENT, HND');
  check(d2.cls === '删' && d2.commit === 'C6' && d2.span === 'C4 / C6', '分类：ENT + HND → 删，所属提交取最晚的 C6（HND→C4，ENT→C6），「最早 / 最晚」写 C4 / C6');
  const d3 = cl('HIS + ITEM');
  check(d3.cls === '删' && d3.commit === 'C7' && d3.earliest === 2 && d3.latest === 7 && d3.span === 'C2 / C7', '分类：HIS + ITEM → 删，所属提交是 C7（最晚），不是 C2（最早）');
  check(cl('MLT').span === 'C8 / C8' && cl('KEEP').span === '' && cl('KEEP, CHG').span === 'C5 / C5' && cl('INV；PRX；HIS').span === 'C2 / C3', '分类：「最早 / 最晚」列：单标签两端相同；没有可删标签为空；拆的行也写');
  check(cl('NTC').commit === 'C6' && cl('ITEM').commit === 'C7' && cl('MLT').commit === 'C8' && cl('CHG').commit === 'C5' && cl('PRX').commit === 'C3', '分类：NTC→C6、ITEM→C7、MLT→C8、CHG→C5、PRX→C3');
  const m1 = cl('KEEP, CHG');
  check(m1.cls === '拆（待裁定）' && m1.commit === '候选 C5', '分类：KEEP + CHG → 拆（待裁定），候选 C5');
  const m2 = cl('INV；PRX；HIS（874–875）');
  check(m2.cls === '拆（待裁定）' && m2.commit === '候选 C2、C3', '分类：INV + PRX + HIS → 拆，候选 C2、C3（升序）');
  const m3 = cl("KEEP（CHG：含 'change'）");
  check(m3.cls === '拆（待裁定）' && m3.main.join() === 'KEEP' && m3.note.join() === 'CHG', '分类：括号里的注记标签也计入标签集合（KEEP + 注记 CHG → 拆），主标签 / 注记标签分列');
  check(cl('拿不准').cls === '待裁定（无标签）' && cl('').cls === '待裁定（无标签）', '分类：取不出已知标签 → 待裁定（无标签）');
  check(classify('KEEP', true).cls === '待裁定（解析歧义）' && classify('HIS', true).commit === '', '分类：解析器标了歧义的行 → 待裁定（解析歧义），不给提交');
  check(cl('KEEP；ZZZ 不认识').unknown.join() === 'ZZZ', '未知标签词：括号之外的未知大写词被报出');
  check(cl('KEEP（JSON 字段）').unknown.length === 0, '未知标签词：括号之内的英文标识符不报');
  // MEDIUM-6：未知词与已知标签同现 → 待裁定（未知标签词）；RPT 是已知的保留类标签
  const u1 = cl('KEEP；ZZZ 不认识');
  check(u1.cls === '待裁定（未知标签词）' && u1.commit === '' && cl('ZZZ').cls === '待裁定（未知标签词）' && cl('HIS；ZZZ').cls === '待裁定（未知标签词）' && cl('HIS；ZZZ').span === 'C2 / C2', 'M6：未知词与已知标签同现（KEEP / HIS + ZZZ）也判待裁定（未知标签词），不按已知标签下结论；可删标签的最早 / 最晚仍写出供参考');
  check(cl('RPT').cls === '留' && cl('RPT').unknown.length === 0 && cl('KEEP；RPT').cls === '留' && cl('CHG + RPT').cls === '拆（待裁定）' && cl('CHG + RPT').commit === '候选 C5' && cl('ENT、RPT').cls === '拆（待裁定）', 'M6：RPT（进度汇报，保留）是已知的保留类标签：单独 → 留；与可删标签同现 → 拆，不会被当成未知词或被忽略而整删');
  check(cl('KEEP（xxSUBMIT_PURPOSES 与 aaE_PURPOSES）').unknown.length === 0 && cl('KEEP；xxSUBMIT_PURPOSES').unknown.length === 0 && cl('KEEPE_PURPOSES').unknown.join() === 'KEEPE_PURPOSES', '未知标签词：整词识别——含小写字母的词（xxSUBMIT_PURPOSES）不算词；整词全大写的（含超过 10 个字符的 KEEPE_PURPOSES，旧版按 10 字符截断漏掉）算未知词');
  check(cl('KEEP；X').cls === '待裁定（未知标签词）' && cl('KEEP；FEATURE_FLAG_12').cls === '待裁定（未知标签词）' && cl('PRX；各用途限制见 PROXYABLE_PURPOSES').cls === '待裁定（未知标签词）' && cl('KEEP；S12 与表单有关').cls === '待裁定（未知标签词）', '74 M（实施清单一侧）：`KEEP；X`、`KEEP；FEATURE_FLAG_12`、带数字 / 超长的未知词（S12、PROXYABLE_PURPOSES）不再被漏掉：单靠 KEEP / PRX 得不到「留」/「删」');
  // 路由与片段
  const rt = routesIn('POST /sysbuild/projects/:id/entries 与 GET /sysbuild/entries/:eid');
  check(rt.length === 2 && rt[0].method === 'post' && rt[0].path === '/sysbuild/projects/:id/entries', '路由：从说明里取出 METHOD /sysbuild/... ');
  check(staticFragment('/sysbuild/projects/:id/entries') === 'entries' && staticFragment('/sysbuild/entries/:eid') === 'entries', '路由片段：取最后一个静态段（排除 sysbuild 与 :动态段）');
  // M4：多行路由、多个路由、多种挂载写法
  const rsrc = "router.post(\n  '/sysbuild/projects/:id/multi',\n  h);\nrouter.get('/sysbuild/projects/:id/multi', h);\nrouter.get('/projects/:id/short', h);\n";
  check(routeLines(rsrc, 'post', '/sysbuild/projects/:id/multi').join() === '1' && routeLines(rsrc, 'get', '/sysbuild/projects/:id/multi').join() === '4' && routeLines(rsrc, 'get', '/sysbuild/projects/:id/short').join() === '5', 'M4：路由方法调用与路径字面量隔行也认；路径不带 /sysbuild 前缀的登记也认；方法区分');
  const mctx = { indexText: "const a = require('./aa');\nconst { router: bRouter } = require('./bb.js');\nrouter.use(a.router);\nrouter.use('/x', bRouter);\nrouter.use(require('./cc').router);\napp.mount(a.router);\nconst note = a;\n" };
  check(mountLines(mctx, 'aa.js').join() === '3,6' && mountLines(mctx, 'bb.js').join() === '4' && mountLines(mctx, 'cc.js').join() === '5' && mountLines(mctx, 'dd.js').length === 0, 'M4：挂载找全：变量 + use / mount、解构别名 + use、use 里直接 require；只赋值不挂载的行不算；找不到的文件为空');
  // 合成原件与合成仓库
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-impl-'));
  try {
    const inv = path.join(dir, 'inv');
    const repo = path.join(dir, 'repo');
    const routes = path.join(repo, 'wbs-server', 'routes', 'sysbuild');
    const libDir = path.join(repo, 'wbs-server', 'scripts', 'lib');
    fs.mkdirSync(inv);
    fs.mkdirSync(routes, { recursive: true });
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(routes, 'zz.js'), "'use strict';\nfunction alpha() {}\nfunction beta() {}\nmodule.exports = { alpha, beta };\n");
    fs.writeFileSync(path.join(routes, 'yy.js'), "const { alpha } = require('./zz');\nrouter.post('/sysbuild/projects/:id/zzitems', h);\nalpha();\nmodule.exports = { gamma: 1 };\n");
    fs.writeFileSync(path.join(routes, 'index.js'), "const yy = require('./yy');\nrouter.use('/sysbuild', auth);\nrouter.use(yy.router);\n");
    fs.writeFileSync(path.join(libDir, 'sysbuild-api-suite.js'), "alpha(); alpha();\nconst x = 'sysbuild_zz_table';\napi('/projects/' + id + '/zzitems');\n");
    const invA = [
      '# 取证 A', '', '## 1. zz.js（4 行）', '',
      '| 符号 | 行号 | 说明 | 标签 | 判断依据 |', '|---|---|---|---|---|',
      '| `alpha` | 2 | 做甲 | KEEP | 保留 |',
      '| `beta` | 3 | 做乙 | HIS | 历史 |',
      '| `a\\|b` | 4 | 带竖线 | KEEP, CHG | 混合 |', '',
      '## 2. yy.js（4 行）', '',
      '| 符号 | 行号 | 说明 | 流程标签 | 判断依据 |', '|---|---|---|---|---|',
      '| `POST /sysbuild/projects/:id/zzitems` | 2 | 建东西 | ENT | 写入 |',
      '| 表 sysbuild_zz_table | 3 | 说明 | 拿不准 | 无 |', '',
      '### 没有标签列的表', '', '| 用例 | 行号 |', '|---|---|', '| 不收 | 1 |', '',
      '### 变异表', '', '| # | 变异名 | 流程标签 |', '|---|---|---|', '| 1 | m | KEEP |', '',
    ].join('\n');
    fs.writeFileSync(path.join(inv, 'del-inv-a.md'), invA);
    fs.writeFileSync(path.join(dir, '删除清单.md'), ['## 三、后端逐文件清单', '', '### 3.1 整文件删除', '', '| 文件 | 行数 |', '|---|---|', '| `zz.js` | 4 |', '| `missing.js` | 9 |', '', '### 3.2 不动', '', '不动的 2 个：`yy.js`、`dbx.js`。', '', '## 四、库结构', '', '`not-counted.js`', ''].join('\n'));
    const input = loadInput(inv);
    check(input.rows.length === 5 && input.tablesInfo[0].tables === 2, '取表：两张带标签列的表入选（5 行），没有标签列的表与变异表不收');
    check(input.rows[2].symbol === '`a|b`' && input.rows[2].file === 'zz.js', '取行：\\| 还原成 |；文件取标题层级里最近含 .js 的标题');
    const ctx = buildContext(repo);
    const g = build(input, ctx);
    const e0 = g.entries[0];
    check(e0.x.readers.text.startsWith('alpha：') && /yy\.js:1/.test(e0.x.readers.text) && e0.x.readers.kind === 'hit' && e0.x.fixtures.text.includes('lib/sysbuild-api-suite.js（2）') && e0.x.fixtures.kind === 'hit', '反查①③：导出名 alpha 的引用位置（yy.js:1）与夹具命中次数（2）；kind = hit');
    const e3 = g.entries[3];
    check(/POST \/SYSBUILD\/PROJECTS\/:ID\/ZZITEMS → yy\.js:2/i.test(e3.x.route.text) && !e3.x.route.text.includes('挂载') && e3.x.mount.text.includes('index.js:3') && e3.x.mount.kind === 'hit' && e3.x.fixtures.text.includes("路由片段 'zzitems'") && e3.x.route.kind === 'hit', '反查②：路由在文件里的行号、index.js 挂载行；路由片段夹具命中');
    check(g.entries[4].x.fixtures.text.includes('sysbuild_zz_table：lib/sysbuild-api-suite.js（1）'), '反查③：snake_case 标识符（表名）在夹具里的命中');
    // M4：四类结果
    check(e3.x.readers.kind === 'uncovered' && /^未覆盖/.test(e3.x.readers.text) && g.entries[1].x.route.kind === 'uncovered' && /^未覆盖/.test(g.entries[1].x.route.text), 'M4：符号里没有导出名 → 读写方「未覆盖」；没有路由文本 → 路由「未覆盖」');
    const noHitRow = { file: 'zz.js', symbol: 'beta', desc: '' };
    const xr = crossRefs(ctx, noHitRow);
    check(xr.readers.kind === 'none' && /指定范围内无命中/.test(xr.readers.text) && xr.fixtures.kind === 'none' && /范围：夹具 1 个文件/.test(xr.fixtures.text), 'M4：导出名在范围内没有引用 / 夹具没有命中 → 「指定范围内无命中」并注明检索范围');
    const xr2 = crossRefs({ ...ctx, reportFailed: true, reportError: '炸了' }, noHitRow);
    check(xr2.readers.kind === 'failed' && /反查失败/.test(xr2.readers.text), 'M4：xref-exports 报告没跑出来 → 「反查失败」');
    const xr3 = crossRefs(ctx, { file: 'yy.js', symbol: 'POST /sysbuild/projects/:id/zzitems', desc: 'GET /sysbuild/entries/:eid 与 POST /sysbuild/projects/:id/zzitems' });
    check(xr3.route.text.includes('POST /sysbuild/projects/:id/zzitems → yy.js:2') && xr3.route.text.includes('GET /sysbuild/entries/:eid → 指定范围内无命中') && xr3.route.kind === 'hit', 'M4：同一对象的多个路由都查，逐个给结果');
    const del = deletionListFiles(P.readText(path.join(dir, '删除清单.md')));
    check(del.files.join() === 'zz.js,missing.js,yy.js,dbx.js', '删除清单第三节：表第一列与「不动的」列表里的文件名（第四节之后的不收）');
    const lines = render(g, input, { generatedAt: 'T', head: 'H' }, del.files);
    const text = lines.join('\n') + '\n';
    const c1 = checkOutput(text, input, del.files);
    check(c1.problems.length === 0 && c1.outRows === 5, '反向校验：输出与原件逐行一一对应（含带 | 的符号）→ 0 问题');
    check(c1.warnings.length === 2 && c1.warnings.some((w) => w.startsWith('missing.js')) && c1.warnings.some((w) => w.startsWith('dbx.js')), '反向校验：删除清单列了、原件没有逐行记录的文件 → 警告');
    const lost = text.split('\n').filter((l) => !(l.startsWith('| del-inv-a.md:') && l.includes('做乙'))).join('\n');
    const c2 = checkOutput(lost, input, del.files);
    check(c2.problems.some((p) => p.includes('应出现 1 次，实际 0 次')) && c2.problems.some((p) => p.includes('行数不符')), '反向校验：输出丢一行 → 报「应出现 1 次，实际 0 次」与行数不符');
    const dupl = text.replace(/(\| del-inv-a\.md:\d+ \| zz\.js \| `alpha`[^\n]*\n)/, '$1$1');
    const c3 = checkOutput(dupl, input, del.files);
    check(c3.problems.some((p) => p.includes('应出现 1 次，实际 2 次')), '反向校验：输出重复一行 → 报「实际 2 次」');
    const noDel = checkOutput(text.replace(/\| missing\.js \|[^\n]*\n/, ''), input, del.files);
    check(noDel.problems.some((p) => p.includes('missing.js 不在输出的文件总表里')), '反向校验：删除清单的文件不在文件总表 → 问题');
    // HIGH-2 回读：标签被改（错位）或初判被改，只核前四列时会漏
    const tagShift = text.replace(/(\| del-inv-a\.md:\d+ \| zz\.js \| `beta` [^\n]*?)\| HIS \|/, '$1| KEEP |');
    check(tagShift !== text && checkOutput(tagShift, input, del.files).problems.some((p) => p.includes('应出现 1 次，实际 0 次')), 'H2 回读：输出里一行的标签原文被改（前四列不变）→ 报出（回读核到标签列）');
    const clsShift = text.replace(/(\| del-inv-a\.md:\d+ \| zz\.js \| `beta` [^\n]*\| HIS \| [^|]*\| [^|]*\| [^|]*\| )删( \|)/, '$1留$2');
    check(clsShift !== text && checkOutput(clsShift, input, del.files).problems.some((p) => p.includes('与按标签原文') && p.includes('重算的')), 'H2 回读：输出的初判与按标签原文重算的不一致 → 报出');
    check(/删 \| 1/.test(text) || text.includes('| 删 | 1 |') || text.includes('| 删 | 2 |'), '汇总：按分类计数写进输出');
    // L2：汇总 1.1 里「留（原件标拿不准）」一行；明细备注列
    check(/\| 留（原件标拿不准） \| 0 \|/.test(text), '汇总 1.1：有「留（原件标拿不准）」一行（合成原件里没有拿不准的留行 → 0）');
    // H2 / M2：断行续行、多余单元格（说明列里 / 标签文字里）、歧义、孤立的 | 行
    const inv2 = path.join(dir, 'inv2');
    fs.mkdirSync(inv2);
    fs.writeFileSync(path.join(inv2, 'del-inv-h.md'), [
      '## 1. zz.js', '',
      '| 符号 | 行号 | 说明 | 标签 | 判断依据 |', '|---|---|---|---|---|',
      '| `a` | 1 | 断行前半 {', '  续行 | KEEP（拿不准） | 依据 |',
      '| `b` | 2 | 含 | 竖线的说明 | HIS | 依据 |',
      '| `c` | 3 | 说明 | INV, PRX；建 x|y 任务 | |',
      '| `d` | 4 | 空行断行 {', '', '  尾 | ENT | 依据 |',
      '| `e` | 5 | 说明 | KEEP | HIS | 依据 |',
      '| `f` | 6 | 说明末尾| | KEEP、PRX | 解释 c|d |',
      '| `g` | 7 | `x \\| y` 与 `u | v` | KEEP | |',
      '  | `h` | 8 | 缩进行 | ENT | 依据 |',
      '| - | - | - | - | - |', '',
      '后面的普通段落', '| 孤立 | 9 |', '',
    ].join('\n'));
    const in2 = loadInput(inv2);
    const byS = (s) => in2.rows.find((r) => r.symbol === '`' + s + '`');
    check(in2.rows.length === 9 && byS('a').tagText === 'KEEP（拿不准）' && byS('a').basis === '依据' && /断行前半 \{ 续行/.test(byS('a').desc), 'H2：断行的续行并进上一行（说明列 = 「断行前半 { 续行」），标签与依据读对');
    check(byS('d').tagText === 'ENT' && /空行断行 \{ 尾/.test(byS('d').desc), 'H2：断行的单元格里夹着空行时，上一行还没凑够单元格 → 空行不算表尾，续行照并');
    check(byS('b').tagText === 'HIS' && byS('b').desc === '含|竖线的说明' && byS('b').ambiguous === true && /分派字段不同/.test(byS('b').ambReason) && /候选读法/.test(memoOf({ ...byS('b'), review: '', unknown: [] })) && classify(byS('b').tagText, byS('b').ambiguous).cls === '待裁定（解析歧义）', '74 H1（改自 M2）：多余的 | 在说明列里：左读（标签「竖线的说明」读不出）与右读（标签 HIS）的标签不同 → 待裁定（解析歧义），备注带原文与候选读法；旧版取右读说成不歧义，是在替人选读法');
    check(byS('c').tagText === 'INV, PRX；建 x' && byS('c').ambiguous === true && /分派字段不同/.test(byS('c').ambReason) && byS('c').candComplete === true && byS('c').candTags.length >= 2 && classifyRow(byS('c')).cls === '待裁定（解析歧义）' && classifyRow(byS('c')).commits.join() === '3', '76 H1（改自行尾 `| |` 的空单元格不算内容）：`INV, PRX；建 x|y 任务 | |`：弹掉行尾空单元格的读法（标签 INV + PRX）与「y 任务」「INV, PRX；建 x|y 任务」等读法的分派键不同 → 待裁定（解析歧义），候选读法完整（candComplete），可删提交取并集 C3');
    check(byS('e').ambiguous === true && /分派字段不同/.test(byS('e').ambReason) && classify(byS('e').tagText, byS('e').ambiguous).cls === '待裁定（解析歧义）', 'M2：左读 KEEP、右读 HIS 都非空且不同 → 标歧义 → 待裁定（解析歧义）');
    check(byS('f').ambiguous === true && /多余的单元格 2 个/.test(byS('f').ambReason) && /说明末尾/.test(byS('f').raw) && classify(byS('f').tagText, byS('f').ambiguous).cls === '待裁定（解析歧义）', 'H2 回归：说明末尾有裸 |、标签 KEEP、PRX，依据里还有裸 |（多余单元格 2 个）→ 待裁定（解析歧义），保留原文，不再被左读当成「留」');
    check(byS('g').ambiguous === false && byS('g').desc === '`x | y` 与 `u | v`' && byS('g').tagText === 'KEEP', 'H2：反引号行内代码里的 | 与 \\| 先按代码消化（`x \\| y`、`u | v` 都是同一格里的文字），不算多余单元格');
    check(byS('h') !== undefined && byS('h').tagText === 'ENT', 'M1：行首缩进 2 个空格的表格行也解析（与审计同口径）');
    check(in2.rows.some((r) => r.symbol === '-' && r.lines === '-'), 'M1：表体里只含 - 的占位数据行是数据行，不当分隔行丢掉');
    const a2 = in2.audits[0];
    check(a2.uncovered.length === 1 && a2.total === 11 && a2.selected + a2.noTag + a2.mutation === 10, 'H2 审计：围栏外以 | 开头的非分隔行 11 行，其中 10 行落在已解析表（表头 1 + 数据 9），孤立的 `| 孤立 | 9 |` 1 行落不到');
    const out2 = render(build(in2, null), in2, { generatedAt: 'T', head: 'H' }, []).join('\n') + '\n';
    const ck2 = checkOutput(out2, in2, []);
    check(ck2.warnings.some((w) => w.includes('跨空行合并') && w.includes('del-inv-h.md:')) && in2.audits[0].crossedBlank.length === 1, 'L-a：断行跨空行并入的行列为警告（合成原件里 `d` 那一行）');
    check(ck2.problems.some((p) => p.includes('del-inv-h.md') && p.includes('不在任何已解析的表里')), 'H2 反向校验：落不到已解析表的 | 行 → 列为问题（退出码 1）');
    // M1：原文有 | 行但一张表都没解析出来
    const inv5 = path.join(dir, 'inv5');
    fs.mkdirSync(inv5);
    fs.writeFileSync(path.join(inv5, 'del-inv-z.md'), '# 只有孤立的 | 行\n\n| a | b |\n| c | d |\n');
    const in5 = loadInput(inv5);
    check(in5.audits[0].parsedEmpty === true && in5.audits[0].uncovered.length === 2 && checkOutput(render(build(in5, null), in5, { generatedAt: 'T', head: 'H' }, []).join('\n') + '\n', in5, []).problems.some((p) => p.includes('一张表都没解析出来')), 'M1：原文有 | 行但一张表都没解析出来 → 问题');
    // M5：文件归属按标题层级，不跨同级章节沿用
    const inv6 = path.join(dir, 'inv6');
    fs.mkdirSync(inv6);
    fs.writeFileSync(path.join(inv6, 'del-inv-s.md'), ['# 总标题', '', '## 1. aa.js', '', '### 1.1 小节', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '', '## 2. 没有文件名的章节', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| y | 2 | KEEP |', ''].join('\n'));
    const in6 = loadInput(inv6);
    check(in6.rows.length === 2 && in6.rows[0].file === 'aa.js' && in6.rows[1].file === '', 'M5：「## 2」章节标题里没有文件名 → 文件为空，不沿用前一个同级章节的 aa.js；「### 1.1」沿用上级「## 1. aa.js」');
    // HIGH-1：期望清单
    const regFor = (invDirX) => ({ files: fs.readdirSync(invDirX).filter((f) => /^del-inv-.*\.md$/.test(f)).sort(), deletionList: '删除清单.md', tables: P.snapshotRegistry(invDirX, fs.readdirSync(invDirX).filter((f) => /^del-inv-.*\.md$/.test(f)).sort(), undefined, (t) => ({ role: roleOf(t), reason: roleOf(t) === 'nt' ? '测试用的理由' : '' })) });
    const regA = regFor(inv);
    const inOk = loadInput(inv, regA);
    check(inOk.regProblems.length === 0 && inOk.regStats.tablesWant === 4 && inOk.regStats.tablesGot === 4 && inOk.excluded.length === 2 && inOk.excluded.every((x) => x.reason === '测试用的理由' || x.role === 'mut'), 'H1：期望清单与原件一致 → 0 问题；被排除的表带登记的理由');
    const regMissingFile = { ...regA, files: regA.files.concat(['del-inv-gone.md']), tables: regA.tables.concat([['del-inv-gone.md', 'x', 'a | b', 'sym', '']]) };
    const pf = loadInput(inv, regMissingFile).regProblems;
    check(pf.some((p) => p.includes('缺文件') && p.includes('del-inv-gone.md')) && pf.some((p) => p.includes('缺表') && p.includes('del-inv-gone.md')), 'H1：期望文件不在目录里 → 缺文件 + 它名下的表缺表');
    fs.writeFileSync(path.join(inv, 'del-inv-extra.md'), '# 多出来的\n\n| 符号 | 标签 |\n|---|---|\n| q | KEEP |\n');
    const pe = loadInput(inv, regA);
    check(pe.regProblems.some((p) => p.includes('多出未登记的取证文件') && p.includes('del-inv-extra.md')) && pe.regProblems.some((p) => p.includes('多出未登记的表（含标签列）')), 'H1：目录里多出未登记的文件 / 含标签列的表 → 问题');
    fs.unlinkSync(path.join(inv, 'del-inv-extra.md'));
    const regMissingTable = { ...regA, tables: regA.tables.filter((e) => !(e[0] === 'del-inv-a.md' && /变异名/.test(e[2]))).concat([['del-inv-a.md', '不存在的标题', '符号 | 标签', 'sym', '']]) };
    const pt = loadInput(inv, regMissingTable).regProblems;
    check(pt.some((p) => p.startsWith('缺表')) && pt.some((p) => p.startsWith('多出未登记的表')), 'H1：登记的表原件里没有 → 缺表；原件里的表没登记 → 多出未登记的表');
    const regRole = { ...regA, tables: regA.tables.map((e) => (/变异名/.test(e[2]) ? [e[0], e[1], e[2], 'sym', ''] : e)) };
    check(loadInput(inv, regRole).regProblems.some((p) => p.includes('表角色不符') && p.includes('登记为 sym，按表头判为 mut')), 'H1：登记角色与按表头判出的不符（例：变异表被登记成符号表）→ 问题');
    const regShifted = { ...regA, tables: regA.tables.map((e) => (/用例 \| 行号/.test(e[2]) ? [e[0], e[1], '用例 | 行号 | 被测', e[3], e[4]] : e)) };
    check(loadInput(inv, regShifted).regProblems.length >= 2, 'H1：表头被换（标题不变、规范化表头不同）→ 同时报缺表与多出未登记的表（身份是 文件 + 标题 + 表头，不是行号）');
    // L1：登记 sha256 并核对；目录全集对比（多出的任何文件都报）
    const regSha = { ...regA, sha256: Object.fromEntries(regA.files.map((f) => [f, P.sha256(path.join(inv, f))])) };
    check(loadInput(inv, regSha).regProblems.length === 0, 'L1：登记了 sha256 且原件未动 → 0 问题');
    fs.writeFileSync(path.join(inv, 'del-inv-a.md'), invA + '\n多一行\n');
    check(loadInput(inv, regSha).regProblems.some((p) => p.includes('del-inv-a.md') && p.includes('sha256 与登记不符')), 'L1：原件被改动一个字 → sha256 与登记不符 → 问题');
    fs.writeFileSync(path.join(inv, 'del-inv-a.md'), invA);
    fs.writeFileSync(path.join(inv, 'notes.txt'), 'x');
    check(loadInput(inv, regA).regProblems.some((p) => p.includes('多出未登记的取证文件') && p.includes('notes.txt')), 'L1：目录里多出一个不叫 del-inv-*.md 的文件 → 也报（按目录全集对比）');
    fs.unlinkSync(path.join(inv, 'notes.txt'));
    // L4：非后端文件（夹具 / 前端）的路由反查标「未覆盖」
    const xrFx = crossRefs(ctx, { file: 'sysbuild-ui.js', symbol: 'GET /sysbuild/projects/:id/zzitems', desc: '' });
    check(xrFx.route.kind === 'uncovered' && /不是 routes\/sysbuild 下的后端文件/.test(xrFx.route.text) && !/挂载/.test(xrFx.route.text), 'L4：夹具 / 前端文件行的路由反查 → 「未覆盖（不是后端文件）」，不查挂载');
    const inChk = loadInput(inv, regA);
    const outChk = render(build(inChk, null), inChk, { generatedAt: 'T', head: 'H' }, []).join('\n') + '\n';
    const chkChk = checkOutput(outChk, inChk, []);
    if (chkChk.problems.length) console.log('    （问题：' + chkChk.problems.join('；') + '）');
    check(chkChk.problems.length === 0, 'H1：输出 1.5 逐张列出被排除的表与理由 → 校验 0 问题');
    const noReason = checkOutput(outChk.replace('测试用的理由', ''), inChk, []);
    check(noReason.problems.some((p) => p.includes('没有登记的排除理由')), 'H1：被排除的表输出里没有理由 → 问题');
    const inNoReg = loadInput(inv);
    check(inNoReg.registryChecked === false && inNoReg.regProblems.length === 0, 'H1：自检里不传期望清单 → 不核对（registryChecked = false）');
    check(IMPL_TABLES.length === 143 && EXPECTED_FILES.length === 8 && IMPL_TABLES.every((e) => e.length === 5 && ['sym', 'mut', 'nt'].includes(e[3]) && (e[3] !== 'nt' || e[4].length > 10)) && IMPL_TABLES.filter((e) => e[3] === 'sym').length === 68 && IMPL_TABLES.filter((e) => e[3] === 'mut').length === 34 && IMPL_TABLES.filter((e) => e[3] === 'nt').length === 41, 'H1：内置期望清单：8 个文件、143 张表（符号表 68、变异表 34、没有标签列的表 41），nt 的理由逐张登记（长度 > 10）');
    // ════ 75 号复审（B 部分：实施清单生成器）新增自检 ════
    const roleFnT = (t) => ({ role: roleOf(t), reason: roleOf(t) === 'nt' ? '测试用的理由' : '' });
    const meta0 = { generatedAt: 'T', head: 'H' };
    // HIGH-1：有文件级去向的排除表生成可分派记录
    const invFl = path.join(dir, 'invfl');
    fs.mkdirSync(invFl);
    fs.writeFileSync(path.join(invFl, 'del-inv-fl.md'), [
      '## 1. zz.js', '', '| 符号 | 行号 | 说明 | 标签 | 判断依据 |', '|---|---|---|---|---|', '| `alpha` | 2 | 做甲 | KEEP | 保留 |', '',
      '#### sysbuild-history.js（1-85 行）', '', '整个文件 HIS（原始凭据用到 PRX 同类字段，但标签只给 HIS）。', '', '| 函数 | 行号 | 渲染什么 / 接口 |', '|---|---|---|', '| windowAction | 17-24 | POST /projects/:id/history-window |', '',
      '#### sysbuild-other.js', '', '这个文件整文件删除后要同步改写。', '', '| 名 | 行 |', '|---|---|', '| q | 1 |', '',
    ].join('\n'));
    const flEntry = (heading, header, file, tag) => ({ table: ['del-inv-fl.md', heading, header], file, repoPath: 'wbs-server/public/assets/js/' + file, tag, op: '整删', evidence: '测试依据' });
    const regFl = { files: ['del-inv-fl.md'], deletionList: '删除清单.md', tables: P.snapshotRegistry(invFl, ['del-inv-fl.md'], undefined, roleFnT), fileLevel: [flEntry('sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口', 'sysbuild-history.js', 'HIS')] };
    const inFl = loadInput(invFl, regFl);
    check(inFl.fileLevel.length === 1 && inFl.fileLevel[0].file === 'sysbuild-history.js' && inFl.fileLevel[0].tag === 'HIS' && inFl.fileLevel[0].commit === 'C2' && inFl.fileLevel[0].op === '整删' && /^del-inv-fl\.md:\d+$/.test(inFl.fileLevel[0].src) && /^del-inv-fl\.md:\d+$/.test(inFl.fileLevel[0].evidenceLine) && inFl.regProblems.length === 1 && /这个文件整文件删除/.test(inFl.regProblems[0]) && /没有关联到任何登记的文件级去向/.test(inFl.regProblems[0]), '75 H1：排除表上方写了「整个文件 HIS」且已登记 → 生成可分派记录（文件路径、原件位置、原件依据行、文件级标签 HIS、整删、C2）；扫全部排除表找同类：另一张表上方写「整文件删除」却没登记 → 问题');
    const regFl2 = { ...regFl, fileLevel: regFl.fileLevel.concat([flEntry('sysbuild-other.js', '名 | 行', 'sysbuild-other.js', 'ENT')]) };
    const inFl2 = loadInput(invFl, regFl2);
    check(inFl2.regProblems.length === 0 && inFl2.fileLevel.length === 2 && inFl2.fileLevel[1].commit === 'C6', '75 H1：两张都登记 → 0 问题，两条记录（没有「整个文件 <标签>」写法的表，标签取登记值）');
    const gFl = build(inFl2, null);
    const outFl = render(gFl, inFl2, meta0, []).join('\n') + '\n';
    const ckFl = checkOutput(outFl, inFl2, []);
    check(/### 1\.7/.test(outFl) && /\| wbs-server\/public\/assets\/js\/sysbuild-history\.js \| del-inv-fl\.md:\d+ \| del-inv-fl\.md:\d+「整个文件 HIS[^|]*\| HIS \| 整删 \| C2 \|/.test(outFl) && /\| sysbuild-history\.js \| 0 \| 0 \| 0 \| 0 \| 0 \| 无逐行记录，但有文件级去向记录（见 1\.7）：整删 C2 \|/.test(outFl) && ckFl.problems.length === 0, '75 H1：输出 1.7 有该记录（文件路径 | 原件位置 | 原件依据行 | HIS | 整删 | C2）；文件总表里该文件标「有文件级去向记录」而不是「无逐行记录」；回读 0 问题');
    const flLine = outFl.split('\n').find((l) => l.startsWith('| wbs-server/public/assets/js/sysbuild-history.js |'));
    check(checkOutput(outFl.split('\n').filter((l) => l !== flLine).join('\n'), inFl2, []).problems.some((p) => /1\.7 文件级去向记录：应有 1 行.*输出里 0 行/.test(p)) && checkOutput(outFl.replace(flLine, flLine + '\n' + flLine), inFl2, []).problems.some((p) => /1\.7 文件级去向记录：应有 1 行.*输出里 2 行/.test(p)), '75 H1 回读：1.7 里漏掉该记录 / 重复一条 → 「应恰好出现 1 次」报出（旧版：入口 1 没有这一行，原件摘要、登记表、明细逐行校验全部通过）');
    const regFl3 = { ...regFl2, fileLevel: [flEntry('sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口', 'sysbuild-history.js', 'ENT'), flEntry('不存在的标题', '名 | 行', 'x.js', 'HIS')] };
    const pFl3 = loadInput(invFl, regFl3).regProblems;
    check(pFl3.some((p) => /标签 ENT 与原件 del-inv-fl\.md:\d+ 写的 HIS 不符/.test(p)) && pFl3.some((p) => /应恰好匹配 1 张排除表.*匹配到 0 张/.test(p)), '75 H1：登记的文件级标签与原件写的不符 → 问题；登记的排除表原件里没有 → 问题');
    // MEDIUM-1：完整标题路径 + 所属文件登记（补错配自检）
    const inv13 = path.join(dir, 'inv13');
    fs.mkdirSync(inv13);
    fs.writeFileSync(path.join(inv13, 'del-inv-m.md'), ['# 总', '', '## 1. aa.js', '', '### 三、用例', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '', '## 2. bb.js', '', '### 三、用例', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| y | 2 | KEEP |', ''].join('\n'));
    const reg13 = { files: ['del-inv-m.md'], deletionList: 'x.md', tables: P.snapshotRegistry(inv13, ['del-inv-m.md'], undefined, roleFnT) };
    check(loadInput(inv13, reg13).regProblems.length === 0 && reg13.tables.every((e) => e.length === 7) && reg13.tables[0][5] === '总 › 1. aa.js › 三、用例' && reg13.tables[1][6] === 'bb.js', '75 M1：登记带完整标题路径与所属文件；两个套件下末级标题、表头都相同的「三、用例」各登记各自的路径 → 0 问题');
    fs.writeFileSync(path.join(inv13, 'del-inv-m.md'), ['# 总', '', '## 1. aa.js', '', '### 三、用例', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '', '### 三、用例', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| y | 2 | KEEP |', ''].join('\n'));
    const rp13 = loadInput(inv13, reg13).regProblems;
    check(rp13.length === 1 && /表归属错配/.test(rp13[0]) && /完整标题路径登记为「总 › 2\. bb\.js › 三、用例」/.test(rp13[0]) && /所属文件登记为「bb\.js」，原件里解析为「aa\.js」/.test(rp13[0]), '75 M1 反例：两张末级标题、表头相同、上级套件不同的表：第二张被归到上一个套件（aa.js）名下 → 身份与摘要都对得上，只有路径 / 所属文件对不上 → 表归属错配（旧版查不出）');
    check(IMPL_TABLE_LOC.length === IMPL_TABLES.length && REGISTRY.tables.every((e) => e.length === 7 && typeof e[5] === 'string' && typeof e[6] === 'string') && P.EVIDENCE_SHA256 === REGISTRY.sha256 && Object.keys(REGISTRY.sha256).length === 8 && /^[0-9a-f]{64}$/.test(REGISTRY.deletionListSha256) && REGISTRY.fileLevel.length === 1 && IMPL_TABLES.some((e) => e[0] === REGISTRY.fileLevel[0].table[0] && e[1] === REGISTRY.fileLevel[0].table[1] && e[2] === REGISTRY.fileLevel[0].table[2] && e[3] === 'nt'), '75 M1：内置登记每张表带完整标题路径 + 所属文件（7 项），八份原件与删除清单都登记了 sha256，文件级去向登记指向一张已登记的 nt 表');
    // MEDIUM-2：裁定清单
    const inv14 = path.join(dir, 'inv14');
    fs.mkdirSync(inv14);
    fs.writeFileSync(path.join(inv14, 'del-inv-q.md'), ['## 1. zz.js', '', '| 符号 | 行号 | 说明 | 标签 | 依据 |', '|---|---|---|---|---|', '| a | 1 | x | KEEP（拿不准） | y |', '| b | 2 | x | 拿不准 | y |', '| c | 3 | x | HIS；ZZZ | y |', '| d | 4 | x | KEEP | y |', ''].join('\n'));
    const in14 = loadInput(inv14);
    const g14 = build(in14, null);
    const out14 = render(g14, in14, meta0, []).join('\n') + '\n';
    check(g14.adjudicate.map((x) => x.src.split(':')[1]).join() === '5,6' && /### 1\.8/.test(out14) && /\| del-inv-q\.md:5 \| zz\.js \| a \| KEEP（拿不准） \| 留 \| [^|]*「拿不准」[^|]*\| \| \|/.test(out14) && /\| del-inv-q\.md:6 \| zz\.js \| b \| 拿不准 \| 待裁定（无标签） \|/.test(out14) && !/\| del-inv-q\.md:7 \| zz\.js \| c \| HIS；ZZZ \| 待裁定（未知标签词） \| [^|]*\| \| \|/.test(out14) && checkOutput(out14, in14, []).problems.length === 0, '75 M2：「留」但原件标拿不准的行、没有候选提交的待裁定行输出为裁定清单（带原件位置，最终去向 / 依据两列留空）；有候选提交的待裁定行（HIS；ZZZ → C2）不在清单里；回读 0 问题');
    const dropAdj = out14.split('\n').filter((l) => !l.startsWith('| del-inv-q.md:5 | zz.js | a |')).join('\n');
    check(checkOutput(dropAdj, in14, []).problems.some((p) => /1\.8 裁定清单：应有 1 行「del-inv-q\.md:5 /.test(p)), '75 M2 回读：裁定清单丢一行 → 报出');
    // MEDIUM-3：共享对象列全部候选复核提交
    const sh = classify('HIS + ITEM');
    check(sh.cls === '删' && sh.commit === 'C7' && sh.review === 'C2、C7' && classify('HIS').review === '' && classify('KEEP, CHG').review === '' && classify('ENT, NTC').review === '', '75 M3：纯停用的共享对象（HIS + ITEM）整删时点仍是最晚的 C7，同时列全部候选复核提交 C2、C7；单一提交 / 同属 C6 的 ENT + NTC / 拆的行不列');
    fs.writeFileSync(path.join(inv14, 'del-inv-q.md'), ['## 1. zz.js', '', '| 符号 | 行号 | 说明 | 标签 | 依据 |', '|---|---|---|---|---|', '| s | 1 | 共享 | HIS + ITEM | y |', '| t | 2 | x | HIS | y |', ''].join('\n'));
    const in14b = loadInput(inv14);
    const out14b = render(build(in14b, null), in14b, meta0, []).join('\n') + '\n';
    check(/\| s \| 1 \| 共享 \| HIS \+ ITEM \| [^\n]*\| 删 \| C7 \|[^\n]*\| C2 \/ C7 \| C2、C7 \| 共享对象：整删时点取最晚的 C7；C2、C7 各提交要先核对/.test(out14b) && /\| C2 \| 1 \| 0 \| 0 \| 1 \| 0 \|/.test(out14b) && checkOutput(out14b, in14b, []).problems.length === 0, '75 M3：明细多一列「全部候选复核提交」= C2、C7，备注写明共享对象要先核对较早停用模块的依赖；1.2 的「共享对象的较早复核」列在 C2 计 1 行');
    // MEDIUM-4：回读用原件行重算期望（标签原文、歧义标记），逐行核初判、所属提交、最早 / 最晚、复核提交
    fs.writeFileSync(path.join(inv14, 'del-inv-q.md'), ['## 1. zz.js', '', '| 符号 | 行号 | 说明 | 标签 | 依据 |', '|---|---|---|---|---|', '| k | 1 | 说明 | 注 | KEEP | 依据 |', ''].join('\n'));
    const in14c = loadInput(inv14);
    const out14c = render(build(in14c, null), in14c, meta0, []).join('\n') + '\n';
    const kLine = out14c.split('\n').find((l) => l.startsWith('| del-inv-q.md:5 |') && l.includes('说明\\|注')); // 明细行（1.8 裁定清单里也有同一原件位置的行）
    const kCells = kLine.split(' | ');
    const iCls = kCells.findIndex((c) => c === '待裁定（解析歧义）');
    const kTamper = kCells.map((c, i) => (i === iCls ? '留' : (i === kCells.length - 1 ? '' : c))).join(' | ').replace(/ \|$/, ' |');
    const ckK = checkOutput(out14c.replace(kLine, kTamper), in14c, []);
    check(in14c.rows[0].ambiguous === true && in14c.rows[0].tagText === 'KEEP' && iCls > 0 && checkOutput(out14c, in14c, []).problems.length === 0 && ckK.problems.some((p) => p.includes('与按标签原文') && p.includes('待裁定（解析歧义）')) && ckK.problems.some((p) => p.includes('在原件里是解析歧义行')), '75 M4 反例：解析所得标签为 KEEP 的歧义行，同时去掉歧义备注并把初判改成「留」——旧版从输出备注反推原件是否歧义，照样通过；现在按原件行的歧义标记重算，初判与歧义说明两处都报');
    const outHis = text.split('\n').find((l) => l.startsWith('| del-inv-a.md:') && l.includes('| `beta` |') && l.includes('| 删 |'));
    const hCells = outHis.split(' | ');
    const iCommit = hCells.findIndex((c) => c === '删') + 1;
    const hTamper = hCells.map((c, i) => (i === iCommit ? 'C7' : c)).join(' | ');
    check(hCells[iCommit] === 'C2' && checkOutput(text.replace(outHis, hTamper), input, del.files).problems.some((p) => p.includes('所属提交「C7」与按标签原文重算的「C2」不一致')), '75 M4 反例：把一条 HIS 行的所属提交从 C2 改成 C7——行键和初判都不变，旧版通过；现在按原件标签重算所属提交 → 报出');
    // MEDIUM-5：三向反查——注册与挂载分开记、跨行挂载、入口文件与夹具目录各自的读取结果、xref 部分失败传到结论
    check(mountLines({ indexText: "const history = require('./history');\nrouter.use(\n  history.router\n);\nrouter.use(require(\n  './other'\n).router);\n" }, 'history.js').join() === '2' && mountLines({ indexText: "const history = require('./history');\nrouter.use(\n  history.router\n);\nrouter.use(require(\n  './other'\n).router);\n" }, 'other.js').join() === '5' && mountStatements("a.use('(', x);\nb.use(y)").length === 2, '75 M5：挂载调用可以跨行：`router.use(` 换行后再传 history.router（旧版逐行扫，漏掉）、use 里换行 require 都找到，报调用起始行；引号里的括号不干扰配对');
    const rowRoute = { file: 'yy.js', symbol: 'POST /sysbuild/projects/:id/zzitems', desc: '' };
    const xrOk = crossRefs(ctx, rowRoute);
    const xrNoIdx = crossRefs({ ...ctx, indexOk: false, indexText: '', indexError: 'routes/sysbuild 目录里没有 index.js（或读不到）' }, rowRoute);
    check(xrOk.route.kind === 'hit' && xrOk.mount.kind === 'hit' && xrNoIdx.route.kind === 'hit' && xrNoIdx.mount.kind === 'failed' && /反查失败.*挂载未核/.test(xrNoIdx.mount.text) && !xrNoIdx.route.text.includes('挂载') && !/指定范围内无命中（index\.js/.test(xrNoIdx.mount.text) && crossRefs(ctx, { file: 'zz.js', symbol: 'GET /sysbuild/entries/:eid', desc: '' }).mount.kind === 'none', '75 M5：路由注册与挂载状态分开记：index.js 缺失时挂载标「反查失败」而不是「指定范围内无命中」（注册命中照记）；index.js 读到了、却没有挂载调用时才是「指定范围内无命中」');
    check(ctx.sources.length === 6 && ctx.sources.map((s) => s.ok).every(Boolean) && ctx.fixtureDirs.length === 2 && ctx.fixtureDirs[0].count === 1 && ctx.sources.some((s) => /挂载入口文件/.test(s.name) && s.ok) && buildContext(path.join(dir, '不存在的仓库')).fixtureDirs.every((d) => !d.ok) && buildContext(path.join(dir, '不存在的仓库')).indexOk === false, '75 M5：反查输入各自记录读取结果（xref 报告、后端文件、挂载入口 index.js、两个夹具目录），缺失的目录 / 文件标不成功');
    const fxNeedle = { file: 'zz.js', symbol: 'sysbuild_never_used_table', desc: '' };
    const dirsHalf = [{ rel: 'wbs-server/scripts/lib', ok: true, count: 1, error: '' }, { rel: 'wbs-server/scripts', ok: false, count: 0, error: '目录不存在' }];
    const xrFxNo = crossRefs({ ...ctx, fixtureDirs: dirsHalf }, fxNeedle);
    const xrFxHit = crossRefs({ ...ctx, fixtureDirs: dirsHalf }, { file: 'zz.js', symbol: 'sysbuild_zz_table', desc: '' });
    check(xrFxNo.fixtures.kind === 'failed' && /夹具目录没读全/.test(xrFxNo.fixtures.text) && xrFxHit.fixtures.kind === 'hit' && /注意：夹具目录没读全/.test(xrFxHit.fixtures.text) && crossRefs(ctx, fxNeedle).fixtures.kind === 'none', '75 M5：夹具侧任一目录没读全：没命中时标「反查失败」（不是「指定范围内无命中」），有命中时命中照写并注明缺失目录未覆盖；两个目录都读到了才是「指定范围内无命中」');
    const xrPartNo = crossRefs({ ...ctx, xrefErrorCount: 1, xrefErrorFiles: ['broken.js'] }, { file: 'zz.js', symbol: 'beta', desc: '' });
    const xrPartHit = crossRefs({ ...ctx, xrefErrorCount: 1, xrefErrorFiles: ['broken.js'] }, { file: 'zz.js', symbol: 'alpha', desc: '' });
    check(xrPartNo.readers.kind === 'failed' && /xref-exports 有 1 个文件扫描失败（broken\.js）/.test(xrPartNo.readers.text) && xrPartHit.readers.kind === 'hit', '75 M5：xref-exports 有别的文件扫描失败时，目标的「零引用」可能来自不完整扫描 → 标「反查失败」（旧版只看目标文件本身在不在报错表里）；有命中的仍是命中');
    // ── 78 号 MEDIUM-1：全部文件级处置表述逐条关联 ──────────────────────────────────────────
    const invM1 = path.join(dir, 'invm1');
    fs.mkdirSync(invM1);
    const m1Text = [
      '#### sysbuild-history.js（1-85 行）', '', '整个文件 HIS（表前写这个）。', '', '| 函数 | 行号 | 渲染什么 / 接口 |', '|---|---|---|', '| windowAction | 17-24 | POST /projects/:id/history-window |', '', '表后又写：整个文件 ENT 才对。', '',
      '#### sysbuild-third.js', '', '| 名 | 行 |', '|---|---|', '| q | 1 |', '', '这个文件整文件删除，写在表后。', '',
      '#### sysbuild-fourth.js', '', '说明：整文件替换思路另议。', '',
      '#### sysbuild-sym.js', '', '整个文件 HIS。', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '',
      '#### sysbuild-dup.js', '', '整个文件 HIS。', '', '| 项 | 数 |', '|---|---|', '| q | 1 |', '', '| 项 | 数 |', '|---|---|', '| r | 2 |', '',
    ].join('\n');
    fs.writeFileSync(path.join(invM1, 'del-inv-m1.md'), m1Text);
    const m1Lines = m1Text.split('\n');
    const ln1 = (s) => m1Lines.findIndex((l) => l.includes(s)) + 1;
    const m1Entry = (heading, header, file, tag) => ({ ...flEntry(heading, header, file, tag), table: ['del-inv-m1.md', heading, header] });
    const tblM1 = P.snapshotRegistry(invM1, ['del-inv-m1.md'], undefined, roleFnT);
    const regM1 = { files: ['del-inv-m1.md'], deletionList: '删除清单.md', tables: tblM1, fileLevel: [m1Entry('sysbuild-history.js（1-85 行）', '函数 | 行号 | 渲染什么 / 接口', 'sysbuild-history.js', 'HIS'), m1Entry('sysbuild-sym.js', '符号 | 行号 | 标签', 'sysbuild-sym.js', 'HIS'), m1Entry('sysbuild-dup.js', '项 | 数', 'sysbuild-dup.js', 'HIS')] };
    const pM1 = loadInput(invM1, regM1).regProblems;
    check(pM1.some((p) => /相互冲突的文件级标签：HIS \/ ENT/.test(p)) && pM1.some((p) => p.includes('del-inv-m1.md:' + ln1('这个文件整文件删除') + ' 有文件级处置表述「这个文件整文件删除')) && pM1.some((p) => p.includes('del-inv-m1.md:' + ln1('整文件替换思路另议') + ' 有文件级处置表述')), '78 M1：原件里全部文件级处置表述都扫（不只表前、不只第一条）：同一小节表前写 HIS、表后写 ENT → 冲突报错；表后才出现的「整文件删除」、没有表的小节里的「整文件」都在没有关联到登记时报出（旧版只扫表前第一条，三种情况全部漏掉）');
    check(pM1.some((p) => /角色是 sym，应是排除的 nt 表/.test(p)) && pM1.some((p) => /应恰好匹配 1 张排除表.*匹配到 2 张/.test(p)), '78 M1：文件级登记必须恰好匹配 1 张角色为 nt 的表：登记到有标签列的符号表 → 报错；同标题同表头的两张表都匹配 → 报错（旧版取第一张）');
    const exM1 = [{ src: 'del-inv-m1.md:' + ln1('这个文件整文件删除'), prefix: '这个文件整文件删除', reason: '测试：说明性文字' }, { src: 'del-inv-m1.md:' + ln1('整文件替换思路另议'), prefix: '说明：整文件替换', reason: '测试：不是对文件的处置' }];
    const pM1b = loadInput(invM1, { ...regM1, fileLevelExcluded: exM1 }).regProblems;
    check(!pM1b.some((p) => /有文件级处置表述/.test(p)) && pM1b.some((p) => /相互冲突/.test(p)), '78 M1：登记了排除理由（文件:行号 + 文字前缀）的表述不再报没有关联；冲突仍报');
    const pM1c = loadInput(invM1, { ...regM1, fileLevelExcluded: exM1.concat([{ src: 'del-inv-m1.md:999', prefix: '不存在', reason: '登记写错行号' }]).map((x, i) => (i === 0 ? { ...x, prefix: '换了文字' } : x)) }).regProblems;
    check(pM1c.some((p) => /文字与原件对不上/.test(p)) && pM1c.some((p) => p.includes('del-inv-m1.md:999') && /没有命中/.test(p)), '78 M1 反例：排除登记的文字前缀与原件对不上 → 报；登记的行号在原件里没有表述（行号写错 / 原件变了）→ 报「没有命中」');
    check(REGISTRY.fileLevelExcluded.length === 5 && REGISTRY.fileLevelExcluded.some((x) => x.src === 'del-inv-tests-3.md:426') && REGISTRY.fileLevelExcluded.every((x) => /^del-inv-[a-z0-9-]+\.md:\d+$/.test(x.src) && x.prefix && x.reason), '78 M1：内置排除登记 5 条（含 tests-3:426），每条有 文件:行号、文字前缀、理由');
    // 预筛 LOW-1：FILE_LEVEL_RE 放宽为「整个文件 + 同句任意文字 + 标签词或处置词」；新命中走「登记 / 排除 / sym 小节已覆盖」三选一，未归类报问题
    check(['整个文件是「历史补录窗口」，主标签 HIS；各符号另注', '整个文件全部 KEEP（材料）', '整个文件为「材料与附件」，主标签 KEEP', '整个文件主题是「开发方关键事项」（dev_entry / dev_key_confirm / dev_note / deliverable / dev_key_entry_id），本身整体属于停用流程', '整个文件 HIS（原始凭据）', '整个文件 = NTC', '整文件删除后要改写'].every((t) => FILE_LEVEL_RE.test(t)) && ['整个文件不含任何旧流程分支。下一句才说 KEEP', '这是一个文件', '整个文件的行数是 200 行。'].every((t) => !FILE_LEVEL_RE.test(t)), '预筛 LOW-1：放宽后的 FILE_LEVEL_RE 命中「整个文件是…主标签 HIS」「整个文件全部 KEEP」「…本身整体属于停用流程」等写法（旧版只认「整个文件」后紧跟大写标签）；跨句（。）的标签词、没有标签 / 处置词的句子不命中');
    const invL1 = path.join(dir, 'invl1');
    fs.mkdirSync(invL1);
    const l1Text = ['## 1. aa.js', '', '#### 小节甲（逐行表）', '', '整个文件全部 KEEP（材料）。', '', '| 符号 | 行号 | 标签 |', '|---|---|---|', '| x | 1 | KEEP |', '', '#### 小节乙（无逐行表）', '', '整个文件主题是甲乙丙，本身整体属于停用流程。', '', '| 名 | 行 |', '|---|---|', '| q | 1 |', '', '#### 小节丙', '', '整个文件为「材料」，主标签 KEEP。', '', '| 名 | 行 |', '|---|---|', '| r | 2 |', ''].join('\n');
    fs.writeFileSync(path.join(invL1, 'del-inv-l1.md'), l1Text);
    const l1Lines = l1Text.split('\n');
    const ln2 = (s) => l1Lines.findIndex((l) => l.includes(s)) + 1;
    const regL1 = { files: ['del-inv-l1.md'], deletionList: 'x.md', tables: P.snapshotRegistry(invL1, ['del-inv-l1.md'], undefined, roleFnT), fileLevel: [] };
    const pL1 = loadInput(invL1, regL1).regProblems;
    const pL1b = loadInput(invL1, { ...regL1, fileLevelExcluded: [{ src: 'del-inv-l1.md:' + ln2('整个文件主题是甲乙丙'), prefix: '整个文件主题是甲乙丙', reason: '测试：说明性文字' }, { src: 'del-inv-l1.md:' + ln2('整个文件为「材料」'), prefix: '整个文件为「材料」', reason: '测试：说明性文字' }] }).regProblems;
    check(pL1.length === 2 && pL1.some((p) => p.includes('del-inv-l1.md:' + ln2('整个文件主题是甲乙丙') + ' 有文件级处置表述')) && pL1.some((p) => p.includes('del-inv-l1.md:' + ln2('整个文件为「材料」') + ' 有文件级处置表述')) && !pL1.some((p) => p.includes('del-inv-l1.md:' + ln2('整个文件全部 KEEP'))) && pL1b.length === 0, '预筛 LOW-1：小节有逐行符号表的「整个文件全部 KEEP」→ sym 小节已覆盖（不报）；无符号表小节里的两句新命中，未归类 → 各报一条（共 2 条）；两条登记排除后 → 0 问题');
    // ── 78 号 MEDIUM-2：歧义行按候选读法并集 ──────────────────────────────────────────────
    const cu = classify('HIS', true, { tags: ['ITEM'], complete: true });
    check(cu.cls === '待裁定（解析歧义）' && cu.commits.join() === '2,7' && cu.review === 'C2、C7' && cu.candIncomplete === false && isAdjudicate({ tagText: 'HIS' }, cu) === false, '78 M2：歧义行主读法 HIS、候选读法 ITEM → 复核提交取并集 C2、C7（旧版只计 C2），保持待裁定，候选完整时不进 1.8');
    const cu2 = classify('HIS', true, { tags: ['ITEM'], complete: false });
    check(cu2.candIncomplete === true && isAdjudicate({ tagText: 'HIS' }, cu2) === true && /候选读法不完整/.test(adjWhy(cu2)) && classify('HIS', true).candIncomplete === true, '78 M2：候选读法不完整（或没给候选信息）→ 进 1.8 裁定清单，原因写明候选不完整');
    const inv78a = path.join(dir, 'inv78a');
    fs.mkdirSync(inv78a);
    fs.writeFileSync(path.join(inv78a, 'del-inv-h.md'), ['## 1. zz.js', '', '| 符号 | 行号 | 说明 | 标签 | 依据 |', '|---|---|---|---|---|', '| x | 1 | 说明 | HIS | ITEM | 依据 |', ''].join('\n'));
    const in78a = loadInput(inv78a);
    const out78a = render(build(in78a, null), in78a, meta0, []).join('\n') + '\n';
    check(in78a.rows.length === 1 && in78a.rows[0].ambiguous === true && classifyRow(in78a.rows[0]).commits.join() === '2,7' && /\| C2 \| 0 \| 0 \| 1 \| 0 \| 0 \|/.test(out78a) && /\| C7 \| 0 \| 0 \| 1 \| 0 \| 0 \|/.test(out78a) && /歧义行：按全部候选读法的可删提交 C2、C7 列复核/.test(out78a) && checkOutput(out78a, in78a, []).problems.length === 0, '78 M2：真实歧义行 `| x | 1 | 说明 | HIS | ITEM | 依据 |` → 1.2 里 C2、C7 的「待裁定」都计 1 行，备注写明按候选并集列复核，回读 0 问题');
    // ── 78 号 MEDIUM-3 / MEDIUM-4：回读按节、逐字段 ────────────────────────────────────────
    const fl17 = outFl.split('\n');
    const fl17hdr = fl17.find((l) => l.startsWith('| 文件路径 | 原件位置（排除表）'));
    const fl17sep = fl17[fl17.indexOf(fl17hdr) + 1];
    const movedOut = outFl.split('\n').filter((l) => l !== flLine).join('\n') + '\n### 9.9 别处\n\n' + fl17hdr + '\n' + fl17sep + '\n' + flLine + '\n';
    check(checkOutput(movedOut, inFl2, []).problems.some((p) => /1\.7 文件级去向记录：应有 1 行.*输出里 0 行/.test(p)), '78 M3 反例：1.7 的记录移到别的小节（表头、行内容都不变）→ 按节限定后报「1.7 里 0 行」（旧版全文找同表头的表，照样通过）');
    check(flLine.includes('| HIS | 整删 | C2 |') && checkOutput(outFl.replace(flLine, flLine.replace('| HIS | 整删 | C2 |', '| HIS | 整删 | C3 |')), inFl2, []).problems.some((p) => /1\.7 文件级去向记录：应有 1 行/.test(p)),'78 M3 反例：1.7 记录里把提交 C2 改成 C3（其余字段不变）→ 逐字段核对报出');
    const adjLine = out14.split('\n').find((l) => l.startsWith('| del-inv-q.md:5 | zz.js | a | KEEP（拿不准） | 留 |'));
    const dropOnly = checkOutput(out14.split('\n').filter((l) => l !== adjLine).join('\n'), in14, []).problems;
    check(adjLine !== undefined && dropOnly.length === 1 && /1\.8 裁定清单：应有 1 行/.test(dropOnly[0]) && checkOutput(out14.replace(adjLine, adjLine.replace('| 留 |', '| 删 |')), in14, []).problems.some((p) => /1\.8 裁定清单/.test(p)), '78 M3：删 1.8 里的一行 → 只报 1.8 一条（不牵连 1.7 与明细）；把 1.8 一行的初判字段由「留」改「删」→ 逐字段核对报出');
    const memoK = kLine.slice(kLine.lastIndexOf('| 解析歧义：') + 2);
    const kShort = kLine.slice(0, kLine.lastIndexOf('| 解析歧义：') + 2) + memoK.slice(0, memoK.indexOf('（原文：')) + ' |';
    check(kLine.includes('（原文：') && kLine.includes('候选读法：') && checkOutput(out14c.replace(kLine, kShort), in14c, []).problems.some((p) => /没有完整的解析歧义说明（原因、原文、候选读法）/.test(p)), '78 M4 反例：歧义行的备注只留「解析歧义：原因」前缀、删掉原文与候选读法 → 报「没有完整的解析歧义说明」（旧版只看「解析歧义：」前缀，通过）');
    // ── 78 号 MEDIUM-5：后端目录枚举 / 逐文件读取 / 入口文件分开记 ─────────────────────────
    check(ctx.backend && ctx.backend.dirOk && ctx.backend.listed.join() === 'index.js,yy.js,zz.js' && ctx.knownBackend.has('zz.js') && ctx.sources.some((s) => /后端目录枚举/.test(s.name) && s.ok && s.count === 3) && ctx.sources.some((s) => /后端文件逐个读取/.test(s.name) && s.ok) && ctx.sources.some((s) => /挂载入口文件/.test(s.name)), '78 M5：后端目录枚举、逐文件读取、挂载入口文件各记一条读取结果');
    const srcLost = new Map(ctx.srcByFile);
    srcLost.delete('yy.js');
    const ctxRd = { ...ctx, srcByFile: srcLost, backend: { ...ctx.backend, readErrors: new Map([['yy.js', 'EACCES: 拒绝访问']]) } };
    const xrRd = crossRefs(ctxRd, { file: 'yy.js', symbol: 'POST /sysbuild/projects/:id/zzitems', desc: '' });
    check(xrRd.route.kind === 'failed' && /反查失败（后端文件 yy\.js 读取失败：EACCES/.test(xrRd.route.text) && xrRd.mount.kind === 'hit' && /index\.js:3/.test(xrRd.mount.text), '78 M5：已知后端目标（yy.js）读取失败 → 路由注册标「反查失败」并写出读取错误；入口文件可读 → 挂载仍独立查出（index.js:3）');
    const xrNb = crossRefs(ctx, { file: 'public-page.html', symbol: 'GET /sysbuild/entries/:eid', desc: '' });
    const ctxNoDir = buildContext(path.join(dir, '不存在的仓库'));
    const xrNoDir = crossRefs(ctxNoDir, { file: 'zz.js', symbol: 'GET /sysbuild/entries/:eid', desc: '' });
    check(xrNb.route.kind === 'uncovered' && xrNb.mount.kind === 'uncovered' && xrNoDir.route.kind === 'failed' && xrNoDir.mount.kind === 'failed' && /目录不存在/.test(xrNoDir.route.text), '78 M5：非后端文件 → 路由与挂载「未覆盖」；后端目录整个不存在 → 两者都「反查失败」，写明目录不存在（不与「范围外」混成一个分支）');
    // ── 78 号 MEDIUM-6：挂载扫描 ────────────────────────────────────────────────────────
    const miA = mountInfo({ indexText: "const { router } = require('./aa');\napp.use('/aa', router);\n" }, 'aa.js');
    const miB = mountInfo({ indexText: "const { router } = require('./aa');\nconst { router: bR } = require('./bb');\nconst { router } = require('./cc');\napp.use('/x', router);\napp.use('/b', bR);\n" }, 'aa.js');
    const miBb = mountInfo({ indexText: "const { router } = require('./aa');\nconst { router: bR } = require('./bb');\nconst { router } = require('./cc');\napp.use('/x', router);\napp.use('/b', bR);\n" }, 'bb.js');
    check(miA.lines.join() === '2' && miB.lines.length === 0 && miB.ambiguous.join() === '4' && miBb.lines.join() === '5', '78 M6：简写解构 `{ router } = require(\'./aa\')` 唯一绑定时命中；同名 router 被多个文件绑定 → 无法归属，记 ambiguous 不当成命中；别名解构照常命中');
    const miC = mountInfo({ indexText: "const a = require('./aa');\nrouter.use('/x', // 注释里有右括号 )\n  a.router);\nrouter.use('/y', /* 块注释 ) */ other);\n" }, 'aa.js');
    check(miC.lines.join() === '2' && miC.truncated.length === 0, '78 M6：参数里的行注释 / 块注释含右括号时括号配对跳过注释，跨行的 a.router 仍命中（旧版在注释里的 ) 处提前停止，漏掉）');
    const facText = "const { createHistoryRoutes } = require('./history');\nconst { createOtherRoutes } = require('./other');\nconst { createLoneRoutes } = require('./lone');\nconst history = createHistoryRoutes({\n  db,\n});\nrouter.use(history.router);\nconst other = createOtherRoutes();\nrouter.use('/x', other.router);\nconst lone = createLoneRoutes();\n";
    check(mountInfo({ indexText: facText }, 'history.js').lines.join() === '7' && mountInfo({ indexText: facText }, 'other.js').lines.join() === '9' && mountInfo({ indexText: facText }, 'lone.js').lines.length === 0, '78 M6（实测补充）：生产 index.js 的真实写法 `const { createXRoutes } = require(\'./x\')` → `const v = createXRoutes(...)` → `router.use(v.router)`：工厂函数绑定的变量算该文件的挂载（旧版只认 `v = require(...)` 与 `{ router: v }`，生产 93 行有路由注册的明细全部误报「挂载 指定范围内无命中」）；只创建没挂载的文件仍无命中');
    const ctxTr = { ...ctx, indexText: "const a = require('./aa');\nrouter.use('/z', (req, res) => {\n  nothing;\n", srcByFile: new Map([...ctx.srcByFile, ['aa.js', 'x']]), knownBackend: new Set(['aa.js']) };
    const xrTr = crossRefs(ctxTr, { file: 'aa.js', symbol: 'GET /sysbuild/foo/:id', desc: '' });
    check(mountInfo(ctxTr, 'aa.js').truncated.join() === '2' && xrTr.mount.kind === 'uncovered' && /括号没配上/.test(xrTr.mount.text) && !/指定范围内无命中/.test(xrTr.mount.text), '78 M6：调用括号没配上（文件被截断）→ 挂载「未覆盖」并写明，不写「指定范围内无命中」');
    const ctxAmb = { ...ctx, indexText: "const { router } = require('./aa');\nconst { router } = require('./cc');\napp.use('/x', router);\n", srcByFile: new Map([...ctx.srcByFile, ['aa.js', 'x']]), knownBackend: new Set(['aa.js']) };
    const xrAmb = crossRefs(ctxAmb, { file: 'aa.js', symbol: 'GET /sysbuild/foo/:id', desc: '' });
    check(xrAmb.mount.kind === 'uncovered' && /无法归属/.test(xrAmb.mount.text) && /\| 路由注册 \| 路由挂载 \| 用例夹具 \|/.test(text) && /\| 路由挂载 \|/.test(out14), '78 M6：只靠被多文件绑定的同名变量引用时挂载「未覆盖」；逐行明细表单设「路由挂载」列（与「路由注册」分开）');
    // ── 78 号 MEDIUM-7：xref 按导出名给结论 ──────────────────────────────────────────────
    const xrMix = crossRefs({ ...ctx, xrefErrorCount: 1, xrefErrorFiles: ['broken.js'] }, { file: 'zz.js', symbol: 'alpha beta', desc: '' });
    check(xrMix.readers.kind === 'hit' && /alpha：\d+ 处/.test(xrMix.readers.text) && /beta：反查失败（xref-exports 有 1 个文件扫描失败/.test(xrMix.readers.text) && !/beta：指定范围内无命中/.test(xrMix.readers.text), '78 M7：同一行 alpha 有引用、beta 零引用，扫描不完整：alpha 命中照写，beta 单独标「反查失败」（旧版有命中的名字把整行带成「命中」，零引用的名字没有交代缺口）');
    const mkExp = (n) => new Map([['big.js', new Map(Array.from({ length: n }, (_, i) => ['n' + (i + 1), { name: 'n' + (i + 1), references: [], referenceCount: 0 }]))]]);
    const xrBig = crossRefs({ ...ctx, exportsByFile: mkExp(5), xrefErrorCount: 1, xrefErrorFiles: ['broken.js'] }, { file: 'big.js', symbol: 'n1 n2 n3 n4 n5', desc: '' });
    const xrBigOk = crossRefs({ ...ctx, exportsByFile: mkExp(5) }, { file: 'big.js', symbol: 'n1 n2 n3 n4 n5', desc: '' });
    check(xrBig.readers.kind === 'failed' && /另 2 个导出名未列（其中零命中 2 个，按扫描不完整标反查失败）/.test(xrBig.readers.text) && xrBigOk.readers.kind === 'none' && /另 2 个导出名未列/.test(xrBigOk.readers.text) && !/按扫描不完整/.test(xrBigOk.readers.text), '78 M7：导出名多于 3 个、截断未列的部分也按名字交代：扫描不完整时写明未列的零命中名字数并标反查失败；扫描完整时才是「无命中」');
    // ── 78 号 LOW：输入核对摘要按实际读取结果生成 ───────────────────────────────────────────
    const lowOut = path.join(dir, 'low-out.md');
    const lowReg = path.join(dir, 'low-reg.json');
    fs.writeFileSync(lowReg, JSON.stringify({ ...regFor(inv), sha256: { 'del-inv-a.md': 'f'.repeat(64) }, files: regFor(inv).files.concat(['del-inv-gone.md']) }));
    spawnSync(process.execPath, [__filename, '--out', lowOut, '--inv-dir', inv, '--repo', repo, '--deletion-list', path.join(dir, '不存在的删除清单.md'), '--registry-file', lowReg], { encoding: 'utf8' });
    const lowText = fs.existsSync(lowOut) ? fs.readFileSync(lowOut, 'utf8') : '';
    check(/输入核对：取证原件期望 2 份、实读 1 份；摘要已核 0 份、不符 1 份（del-inv-a\.md）、未登记摘要 0 份、缺失 1 份（del-inv-gone\.md）；删除清单：缺失/.test(lowText) && !/九份输入/.test(lowText), '78 LOW：摘要行按实际结果生成：期望 2 份实读 1 份、摘要不符 1 份、缺失 1 份、删除清单缺失都如实写出（旧版固定写「九份输入的存在与 sha256 已核」）');
    // LOW / 删除清单摘要
    const outFile = path.join(dir, 'out.md');
    const regFile = path.join(dir, 'reg.json');
    fs.writeFileSync(regFile, JSON.stringify(regFor(inv)));
    const cli = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--repo', repo, '--deletion-list', path.join(dir, '删除清单.md'), '--registry-file', regFile], { encoding: 'utf8' });
    check(cli.status === 0 && fs.existsSync(outFile) && /结果：通过/.test(cli.stdout) && fs.readFileSync(outFile, 'utf8').includes('## 三、反向校验'), 'CLI：写出 markdown 并带反向校验段，退出码 0（缺失的文件只警告）');
    fs.writeFileSync(regFile, JSON.stringify({ ...regFor(inv), files: regA.files.concat(['del-inv-gone.md']) }));
    const cliBad = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--repo', repo, '--deletion-list', path.join(dir, '删除清单.md'), '--registry-file', regFile], { encoding: 'utf8' });
    check(cliBad.status === 1 && /缺文件/.test(cliBad.stdout), 'CLI：期望文件缺失 → 退出码 1');
    fs.writeFileSync(regFile, JSON.stringify({ ...regFor(inv), deletionListSha256: 'f'.repeat(64) }));
    const cliSha = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--repo', repo, '--deletion-list', path.join(dir, '删除清单.md'), '--registry-file', regFile], { encoding: 'utf8' });
    check(cliSha.status === 1 && /删除清单.*sha256 与登记不符/.test(cliSha.stdout), '75 CLI：删除清单的 sha256 与登记不符 → 退出码 1');
    fs.writeFileSync(regFile, JSON.stringify(regFor(inv)));
    const cliNo = spawnSync(process.execPath, [__filename, '--out', outFile, '--inv-dir', inv, '--repo', repo, '--deletion-list', path.join(dir, '删除清单.md'), '--registry-file', regFile, '--no-check'], { encoding: 'utf8' });
    check(cliNo.status === 0 && /未执行反向校验/.test(cliNo.stdout) && !/结果：通过/.test(cliNo.stdout) && /未执行反向校验/.test(fs.readFileSync(outFile, 'utf8')), '75 LOW CLI：--no-check 控制台与输出文件都标「未执行反向校验」，不再打印「结果：通过」');
    const cli2 = spawnSync(process.execPath, [__filename], { encoding: 'utf8' });
    check(cli2.status === 2, 'CLI：缺 --out 是用法错误（退出码 2）');
  } finally {
    try { removeTree(dir); } catch (e) { console.error('  [清理] 临时目录未删除（保留现场）: ' + dir + ' — ' + e.message); }
  }
  console.log(`\n${ok}/${total} 通过`);
  return ok === total ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { buildContext, crossRefs, classify, selectTables, rowsOf, routesIn, routeLines, mountLines, deletionListFiles, checkOutput, loadInput, build, render, roleOf, DELETABLE, COMMIT_OF, STAY, IMPL_TABLES, IMPL_TABLE_LOC, REGISTRY };
