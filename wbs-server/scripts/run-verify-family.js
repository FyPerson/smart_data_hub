#!/usr/bin/env node
// 全家 verify sweep 驱动脚本——把「cd wbs-server && for 循环逐套件跑」固化为单条 node 命令。
// 动机（2026-08-14）：复合 shell 命令（cd&&for）无法被权限层静态分析，无人值守段每次亲跑都会
//   触发人工确认弹窗；本脚本让主会话/agent 恒以 `node wbs-server/scripts/run-verify-family.js`
//   单命令跑全量（静态可分析·可白名单），同时保持退出码校验制（任一套件红 ⇒ 本脚本 exit 1，
//   杜绝管道 |tail 吞退出码类事故——见 13354ac 沉淀）。
// 行为契约：
//   - 扫描面 = scripts/verify-sys-*.js 全部 + 台账矩阵/对账两个专项成员 + #95 两个成员（端口助手自检 verify-listen-safe-port、禁系统分配端口守卫 verify-no-listen-zero，均计入 PASS）+ #77 C1a 三个成员（验收判定 verify-model-acceptance、脚本比较 verify-model-script-compare、模型恢复 verify-model-restore-api，均计入 PASS）+ #77 C1c 三个成员（写入点分类守卫 verify-model-write-classification 基线与 --self-test 各一次、config_rev HTTP 级性质断言 verify-model-config-rev-http，均计入 PASS；后者自起隔离实例，约 1 分钟）+ 静态守卫（见文件内 GUARDS 数组——数量与具体名单
//     以该数组为准，不在本注释里重复罗列/计数，避免像 R5〔12a-L1〕之前那样"三静态守卫"这句话
//     随数组扩容悄悄过期失真）；新增 verify-sys-* 套件零配置自动纳入。
//   - 成功套件静默只计数；失败套件立即打印其完整输出（stdout+stderr）便于定位。
//   - 工作目录由脚本自身位置推导（chdir 到 wbs-server 根），与调用方 cwd 无关。
//   - 汇总行格式固定：`FAMILY PASS=<n> FAIL=<n>` + 每守卫一行 `GUARD <name> OK|RED`，供上层 grep。
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');
process.chdir(serverRoot);

function runOne(rel, args = []) {
  const r = spawnSync(process.execPath, [rel, ...args], { cwd: serverRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, status: r.status };
}

const familyFiles = fs.readdirSync(path.join(serverRoot, 'scripts'))
  .filter((f) => /^verify-sys-.*\.js$/.test(f))
  .sort()
  .map((f) => path.join('scripts', f));

let pass = 0;
const failed = [];
for (const f of familyFiles) {
  const r = runOne(f);
  if (r.ok) { pass++; continue; }
  failed.push(f);
  console.log(`\n===== RED ${f} (exit=${r.status}) =====`);
  console.log(r.out);
}
// C12: all ledger invariants/actions share one explicitly registered FAMILY member.
const ledgerMember = runOne(path.join('scripts', 'verify-it-ledger.js'), ['--matrix']);
if (ledgerMember.ok) pass++;
else { failed.push('verify-it-ledger --matrix'); console.log(ledgerMember.out); }
const reconcileMember = runOne(path.join('scripts', 'verify-it-reconcile.js'));
if (reconcileMember.ok) pass++;
else { failed.push('verify-it-reconcile'); console.log(reconcileMember.out); }
// #95: loopback fixtures must bind through scripts/lib/listen-safe-port.js (helper self-check + static no-listen(0) guard).
for (const name of ['verify-listen-safe-port', 'verify-no-listen-zero']) {
  const member = runOne(path.join('scripts', `${name}.js`));
  if (member.ok) pass++;
  else { failed.push(name); console.log(member.out); }
}
// #77 C1a: 验收判定统一服务 + 脚本比较 + 恢复 API（config_rev 记账）——显式登记为 FAMILY 成员（纯 node，不起服务）。
// #77 C1b: 迁移脚本（config_rev 保守回填）同样登记在此，夹具库自建自删，纯 node。
for (const name of ['verify-model-acceptance', 'verify-model-script-compare', 'verify-model-restore-api', 'verify-model-config-rev-migration']) {
  const member = runOne(path.join('scripts', `${name}.js`));
  if (member.ok) pass++;
  else { failed.push(name); console.log(member.out); }
}
// #77 C1c: data_models 写入点分类守卫（基线 + --self-test 变异自证各跑一次）与 config_rev HTTP 级性质断言（自起隔离实例，含两例变异自证）。
for (const [label, rel, args] of [
  ['verify-model-write-classification', 'verify-model-write-classification.js', []],
  ['verify-model-write-classification --self-test', 'verify-model-write-classification.js', ['--self-test']],
  // #77 C1 对抗审 R3：model_test_records 只追加、失效单向（confirm 归档条件写的失效计数条件依赖它）——守卫 + 变异自证
  ['verify-model-test-records-append-only', 'verify-model-test-records-append-only.js', []],
  ['verify-model-test-records-append-only --self-test', 'verify-model-test-records-append-only.js', ['--self-test']],
  ['verify-model-config-rev-http', 'verify-model-config-rev-http.js', []],
  // #77 C2a：table_comment 拆分迁移脚本（建议规则 / apply / 幂等 / revert / 真实库拒绝），夹具库自建自删，自起隔离实例
  ['verify-model-table-comment-migration', 'verify-model-table-comment-migration.js', []],
  // #77 C2a 修复：Model_Center.html「实现说明」前端绑定最小静态契约（输入框 / 编辑回填 / 新建清空 / 提交载荷）+ 内存变异自证
  ['verify-model-impl-note-ui-static', 'verify-model-impl-note-ui-static.js', []],
  ['verify-model-impl-note-ui-static --self-test', 'verify-model-impl-note-ui-static.js', ['--self-test']],
  // #77 C2b-1：实现对象两表 + API + 校验 + 权限 + 请求体上限 + 整组替换（自起隔离实例，夹具库自建自删，约 1–2 分钟）
  ['verify-model-impl-objects', 'verify-model-impl-objects.js', []],
  // #77 C2b-2：norm_v1 规范化 + 三端核验（落库三态 / 参数化 / 徽章降级 / 记账 / 调度）+ C2b-1 审查遗留三项；进程内夹具库 + 桩读取器，不连任何 SQL Server
  ['verify-model-impl-verify', 'verify-model-impl-verify.js', []],
  ['verify-model-impl-verify --self-test', 'verify-model-impl-verify.js', ['--self-test']],
  // #77 C2b-3：/relations 关系接口 + 列表 rel 计数 + findDownstreamCandidates 改前改后对拍 + 上游两端一致性对拍（自起隔离实例，约 1 分钟；--self-test 逐个变异起实例，约 12 分钟）
  ['verify-model-relations', 'verify-model-relations.js', []],
  ['verify-model-relations --self-test', 'verify-model-relations.js', ['--self-test']],
  // #77 C4-api：列表追加字段（stages / prevResult / impl_obj_names）+ 同源对拍 + 出错路径 + SQL 条数（自起隔离实例；--self-test 逐个变异起实例）
  ['verify-model-list-extras', 'verify-model-list-extras.js', []],
  ['verify-model-list-extras --self-test', 'verify-model-list-extras.js', ['--self-test']],
  // #77 C3a-0：脚本生成器全文基线（vm 零 DOM 加载页面里的生成器，夹具 × 输出类型全文逐字相等；对拍全绿后接着做判别力自测：对生成器源码做 3 个诚实变异，各自必须判红）。纯 node，不起服务
  ['verify-model-script-gen-golden', 'verify-model-script-gen-golden.js', []],
  // #77 C3a：脚本生成器单一源静态守卫（页面引用共享库 + 页面不再定义库导出名 + 解构名 ⊆ 库导出）+ 三个诚实变异自证
  ['verify-model-script-gen-single-source', 'verify-model-script-gen-single-source.js', []],
  ['verify-model-script-gen-single-source --self-test', 'verify-model-script-gen-single-source.js', ['--self-test']],
  // #77 C3b：目录页 / 配置台两页各留一份的共用函数同源断言（SAME：userCanEditModel / copyToClipboard / loadRegDomainOptions / 行号高亮家族，acorn token 序列逐个相等，忽略空白与注释）+ #77 C4a 的 ⑥ catalog 标签存在 / 位置 / 属性、⑦ catalog 顶层名与内联 / app.js 不撞名 + 变异自证
  ['verify-model-page-shared-functions', 'verify-model-page-shared-functions.js', []],
  ['verify-model-page-shared-functions --self-test', 'verify-model-page-shared-functions.js', ['--self-test']],
  // #77 C4a P22：权限判断 ID 类型混用真值表（两页 userCanEditModel / 目录页 userCanValidateModel）+ 静态接线 + 变异自证
  ['verify-model-permission-id-types', 'verify-model-permission-id-types.js', []],
  ['verify-model-permission-id-types --self-test', 'verify-model-permission-id-types.js', ['--self-test']],
  // #77 C4b-1：目录纯函数核心 model-catalog-core.js（分组 / 命中 / 排序 / 按组分页 / §3.4 事件函数 + 上游名与后端同源 + 两端加载一致 + 搬入件逐字）+ 变异自证（子进程带超时）。纯 node，不起服务
  ['verify-model-catalog-core', 'verify-model-catalog-core.js', []],
  ['verify-model-catalog-core --self-test', 'verify-model-catalog-core.js', ['--self-test']],
  // #77 C4c-0a：目录纯函数核心扩展件（扩展排序键 / 新筛选 / railCounts / listFailed / 显示映射）手写期望 + 12 个变异自证（子进程）。纯 node，不起服务
  ['verify-model-catalog-core-ext', 'verify-model-catalog-core-ext.js', []],
  ['verify-model-catalog-core-ext --self-test', 'verify-model-catalog-core-ext.js', ['--self-test']],
  // #77 C3c：16 页导航 +「模型配置台」项（含配置台自身）的静态守卫：页面集合双向清单 / 紧跟「模型中心」 / 逐字相等 / 高亮归属 + 变异自证（git ls-files 取文件集合）
  ['verify-model-workbench-nav-static', 'verify-model-workbench-nav-static.js', []],
  ['verify-model-workbench-nav-static --self-test', 'verify-model-workbench-nav-static.js', ['--self-test']],
  // #77 末次合并审（codex 46 / 48 / 49 / 50）：内联事件处理器语法守卫（静态 HTML 属性与 JS 字面量里拼出的处理器按所在字面量类型读取；标签模板按语法树 ∪ 词法判定）+ 变异自证。纯 node，不起服务（§9 P50 ⑬：S末 接入 FAMILY）
  ['verify-inline-handler-syntax', 'verify-inline-handler-syntax.js', []],
  ['verify-inline-handler-syntax --self-test', 'verify-inline-handler-syntax.js', ['--self-test']],
]) {
  const member = runOne(path.join('scripts', rel), args);
  if (member.ok) pass++;
  else { failed.push(label); console.log(member.out); }
}
console.log(`FAMILY PASS=${pass} FAIL=${failed.length}${failed.length ? ' FAILED: ' + failed.join(' ') : ''}`);

const GUARDS = ['verify-unify-static', 'verify-badge-alias', 'verify-shared-css-cache-bust', 'verify-collab-validation-status-coverage', 'verify-db-connections-writers', 'verify-it-ledger-panel-static'];
let guardRed = 0;
for (const g of GUARDS) {
  const r = runOne(path.join('scripts', `${g}.js`));
  if (r.ok) { console.log(`GUARD ${g} OK`); continue; }
  guardRed++;
  console.log(`GUARD ${g} RED (exit=${r.status})`);
  console.log(r.out);
}

process.exit(failed.length === 0 && guardRed === 0 ? 0 : 1);
