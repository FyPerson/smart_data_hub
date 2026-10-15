// verify-model-write-classification.js — 静态守卫：data_models 写入点分类（#77 C1c，方案 v0.9 §4.1.1「写入点分类守卫」）
//
// 做什么：扫描「所有写 data_models 的 SQL」与「所有写 model_test_records 的 INSERT」，强制每一处都登记在
//   下方 REGISTRY（A = 触发 config_rev + 1 / B = 不触发，逐条带理由）。新增了 data_models 写入点却忘了分类 → 判红。
//
// ┌──────────────────────────── 覆盖声明表（守卫证明什么 / 不证明什么）────────────────────────────┐
// │ 证明（硬门）                                                                                    │
// │  ① 双向相等：扫描面里每一处 data_models 写语句都在 REGISTRY 里；REGISTRY 每一条都能在源码里找到。  │
// │     登记键 = 文件相对路径 + 所在路由「方法 + 路径」（非路由写入 = 语句上方 `// mc-write: 标签`）   │
// │     + 规范化 SQL 哈希（去 JS / SQL 注释、压缩空白、占位符 ? :x @x $1 统一；`${…}` 插值保留原文）。│
// │     不用行号、不用函数名。                                                                       │
// │  ② 只证：A 类写点所在最内层函数内，引用了绑定正确的递增常量（inline：本字面量某插值恰为该标识符）     │
// │     或助手调用（call）。不证插值在 SQL 中的有效位置（可能被放进 SQL 注释 / 字符串，或同一模板的另一条 │
// │     语句）、不证单语句归属——是否真的递增由 verify-model-config-rev-http.js 对每个 A 类写点发真实请求、 │
// │     断言 config_rev 恰好 +1 来保证（见 ③⁺）。判定细则（绑定级，AST + 作用域分析，注释 / 字符串里的    │
// │     同名文字不算）：路由写点的作用域 = 包含该字面量的最内层函数，且该函数须位于路由注册调用之内（同一   │
// │     路由的兄弟中间件里的递增调用不算）；带标签写点同为最内层函数体。                                   │
// │     · call = 作用域内有调用 `bumpConfigRev(...)`，且      │
// │       callee 是裸标识符 bumpConfigRev（或 `x.bumpConfigRev`，x 为整个模块的命名空间绑定），该标识符   │
// │       的词法绑定是文件顶层 `const` 对 `require('<config-rev 模块>')` 的解构 / 赋值（require 路径按     │
// │       本文件相对路径解析后须等于 wbs-server/routes/model-center/config-rev）。`obj.bumpConfigRev(...)`、│
// │       被局部同名变量 / 函数 / 形参遮蔽、来自别的模块、同名被重复声明 → 都不算。                       │
// │     · inline = 本字面量（整个模板，不区分其中哪条语句）里，某个插值表达式的 AST 恰为 Identifier(CONFIG_REV_BUMP_SQL)，│
// │       且绑定同上（来自 config-rev 模块对 CONFIG_REV_BUMP_SQL 的导出）。`${CONFIG_REV_BUMP_SQL && ''}`、 │
// │       `${String(CONFIG_REV_BUMP_SQL).slice(0,0)}`、局部同名遮蔽 → 都不算。                            │
// │     （递增助手自身单设 MECH 类机制豁免，只允许登记 config-rev.js 的 bump-helper 一条，不归 A / B。）    │
// │  ③ 每一处 `INSERT [OR x] INTO model_test_records` 的列清单必须含 config_rev（无列清单也判红）。表名   │
// │     匹配统一：可选 schema 前缀（裸词或 "x" / `x` / [x] / 'x'）+ 可选空白 + `.` + 可选空白 + 表名     │
// │     （裸词或 "x" / `x` / [x] / 'x'），故 "main"."data_models"、`main`.`model_test_records`、         │
// │     [main].[data_models]、main . "data_models" 等同样被识别。                                        │
// │  ③⁺ A 类覆盖契约（结构硬门）：读取 wbs-server/scripts/fixtures/model-gate-contract/a-class-coverage.json， │
// │     登记表里 A 类条目的 (file, route, hash) 多重集必须与其 entries 全等，缺一条或多一条都判红并打印差异； │
// │     文件不存在 / 解析失败 / entries 为空 / 条目缺字段 → 判红（前提硬门）。HTTP 套件另断言契约每条都被  │
// │     真实请求用例覆盖，新增 / 删除 A 类写点须登记表、契约文件、HTTP 用例三处同改。                       │
// │  ④ 扫描面自检（坑 10）：在整条字面量里全局搜「写动词 + 上述表名形态」                                  │
// │     （动词：UPDATE[ OR x] / INSERT[ OR x] INTO / REPLACE INTO / DELETE FROM）                        │
// │     （model_test_records 同理，只取 INSERT / REPLACE 两形态），凡命中却未被五类主模式在同一位置命中的 │
// │     （带别名、WITH 前缀、多语句里的后一条…）判 SCAN_HOLE；匹配用字符串**求值后的值**（Literal.value /   │
// │     TemplateElement.cooked），源码原文只用于哈希，二者不一致（含 \n 转义、行续接、\uXXXX）且该字面量    │
// │     是写点时判 SCAN_HOLE；孤立的 mc-write 标签判红；标签重名判红；                                     │
// │     扫描面必须非空且含 server.js，文件必须可被 acorn 解析（解析失败 = 判红，不静默跳过）。          │
// │  ⑤ 扫描面 = git 可见集合（已跟踪 + 未跟踪未忽略，坑 32），git 取不到判红，不回退磁盘全扫。          │
// │     前提「未开启稀疏检出」只在以下两种情形才算通过：`git config --get --bool core.sparseCheckout`     │
// │     退出 0 且输出 false；或退出码恰为 1、stderr 为空、无 spawn 异常、且 `git rev-parse                │
// │     --is-inside-work-tree` 输出 true（= 配置项不存在）。其他（有 stderr、异常、非 0/1 状态、输出 true   │
// │     或其他值）一律判红；自证 S1–S7 用合成 git 结果覆盖。                                              │
// │  ⑥ 有意的保守判红：写 data_models / model_test_records 的字符串字面量若含转义（`\'`、`\n`、`\u`     │
// │     等）或行续接，一律判 SCAN_HOLE（对应 ④ 的「求值后值 ≠ 源码原文」）。遇到时请改写语句（换引号 /  │
// │     模板字面量 / 去掉续接），不要改守卫去放行；自证用例 H3 / H4 / H5 / H6 覆盖 \n、续接、\u、\'。  │
// │ 不证明                                                                                          │
// │  · 第二道硬门只证明「处理器引用了助手」，不证明每条控制流分支都执行了它——分支覆盖由运行时性质      │
// │    断言 verify-model-config-rev-http.js 负责（方案 §4.1.1 边界声明）。                            │
// │  · 不证明「递增条件判得对」（哪些字段变了才 +1）——同样由 HTTP 套件逐字段证明。                     │
// │  · 只认字符串字面量 / 模板字面量里的静态 SQL；跨多个字面量用 + 拼出来的语句、动态表名、            │
// │    `UPDATE data_models AS m` 这类别名写法（由④兜底判红而非放行）看不到前者；本仓 SQL 均为静态      │
// │    字符串（方案 §4.1.1 核实）。不引入 AST 之上的 SQL 解析 / trace。                              │
// │  · 不覆盖扫描面以外的文件（scripts/ 下测试夹具、public/、其他 routes/ 目录）：方案规定忽略它们；   │
// │    routes/ 其他模块目前不写 data_models（N0 核实），若将来写，需把目录加进 SCAN_PATTERNS。        │
// │  · 门②的 A 类判定是「存在性」：处理器里同时有 B 类写点时，不区分 bump 是为哪条语句服务。            │
// │  · 绑定解析是保守的简化作用域分析（Program / 函数 / 块 / for / catch / switch 作用域；只认顶层 const  │
// │    的 require 解构或整体赋值；不处理 `require` 自身被遮蔽、eval / with、赋值改写绑定、解构里的计算键）。│
// │    不核对 config-rev 模块真的导出了这两个名字——那由 verify-model-config-rev-http.js 运行时证明。      │
// └─────────────────────────────────────────────────────────────────────────────────────────────────┘
//
// 用法：node scripts/verify-model-write-classification.js            基线（必须全绿）
//       node scripts/verify-model-write-classification.js --self-test 变异自证（内存改源码文本，不写磁盘；
//                                                                     六个必答变异 + 若干加固变异，任一例「跳过」= 失败）
//       node scripts/verify-model-write-classification.js --list      打印扫描到的全部写入点（维护登记表用）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const acorn = require('acorn');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 扫描面（相对仓库根，正斜杠）。`wbs-server/scripts/migrate-*.js` 只取迁移脚本，不含测试夹具。
const SCAN_PATTERNS = [
  /^wbs-server\/server\.js$/,
  /^wbs-server\/utils\/.+\.js$/,
  /^wbs-server\/routes\/model-center\/.+\.js$/,
  /^wbs-server\/scripts\/migrate-[^/]*\.js$/,
];

// ───────────────────────────── 登记表 ─────────────────────────────
// where：'METHOD /path'（路由）或 'tag:<mc-write 标签>'。hash：规范化 SQL 的 sha1 前 12 位（--list 打印）。
// A 类「递增形态」：inline = 递增并入该语句（SQL 含 ${CONFIG_REV_BUMP_SQL}，哈希已锁住）；call = 处理器内另有 bumpConfigRev( 调用。
const SRV = 'wbs-server/server.js';
// 理由末尾括号里的数字是 N0 复核（2026-10-01）时的 server.js 行号，仅供对账，不参与任何判定。
const REGISTRY = [
  { cls: 'MECH', file: "wbs-server/routes/model-center/config-rev.js", where: "tag:bump-helper", hash: '6eabcf2e0670', why: "机制豁免：递增助手 bumpConfigRev 本身（递增机制的实现，不是业务写入点，也不是「不触发」的 B 类；调用它的处理器才是 A 类）" },
  { cls: 'B', file: SRV, where: "POST /api/claim", hash: '924e299e84ca', why: "任务联动改 status（领取 → DEVELOPING），生命周期字段不计版本（附录 A 4968）" },
  { cls: 'B', file: SRV, where: "POST /api/submit2", hash: 'fe848ee402ae', why: "任务联动改 status（提交 → REVIEWING），同上（5166）" },
  { cls: 'B', file: SRV, where: "POST /api/unclaim", hash: '600ddfe809e1', why: "任务联动改 status（取消领取 → CREATED），同上（5281）" },
  { cls: 'B', file: SRV, where: "POST /api/withdraw", hash: '5adba08f2ca1', why: "任务联动改 status（撤回 → DEVELOPING），同上（5363）；验收记录失效由同处理器另行置位" },
  { cls: 'B', file: SRV, where: "POST /api/confirm", hash: 'fbacfeeabb9d', why: "归档确认改主模型 status，若计入会让刚用于归档的验收立即失效（5727）" },
  { cls: 'B', file: SRV, where: "POST /api/confirm", hash: 'd56b7e9e737e', why: "归档确认批量改伴生表 status，伴生表不独立验收（5733）" },
  { cls: 'B', file: SRV, where: "POST /api/delete", hash: 'bd95aa6d309e', why: "删除任务时回退模型 status，生命周期字段（5844）" },
  { cls: 'B', file: SRV, where: "POST /api/reopen", hash: '924e299e84ca', why: "重开任务（DONE → CLAIMED）回退 status（5917）" },
  { cls: 'B', file: SRV, where: "POST /api/reopen", hash: '10fa781dd8b6', why: "重开任务（ARCHIVED → OPEN/CLAIMED）回退 status；验收失效由同处理器先于本句置位（6024）" },
  { cls: 'B', file: SRV, where: "POST /api/models", hash: 'a0d81d24c139', why: "同名重注册物理删除旧记录，随后以新 id 插入，旧 id 的验收记录不再关联在册模型（7448）" },
  { cls: 'B', file: SRV, where: "POST /api/models", hash: '7c1c0f6bc7e0', why: "注册新模型，config_rev 取列默认 1，无既有验收（7471）" },
  { cls: 'B', file: SRV, where: "POST /api/models/:id/quick-submit", hash: 'fe1f11037ed1', why: "快捷提交把 status 推到 REVIEWING，生命周期字段（7576）" },
  { cls: 'B', file: SRV, where: "DELETE /api/models/:id", hash: 'f97a7d62d1b9', why: "软删除主模型（is_deleted），已删除模型不参与判定，恢复时由 restore 递增（7639）" },
  { cls: 'B', file: SRV, where: "DELETE /api/models/:id", hash: '11c1ba02a3dd', why: "级联软删除伴生表，伴生表不独立验收（7647）" },
  { cls: 'A', file: SRV, where: "DELETE /api/models/:id", hash: '964a6ce5f613', why: "删除伴生表时回写主表 changeTracking.enabled=false：主表 ETL 不再写伴生表 = 产出变化；回写与递增并入同一条 UPDATE（7660）", form: 'inline' },
  { cls: 'A', file: SRV, where: "PUT /api/models/:id", hash: '1a0c224d4a5f', why: "PUT 带 dim_config：A 类字段变化时 config_rev 并入同一条 UPDATE 递增（7864 分支；末次合并审 H2 起 WHERE 带 config_rev 版本条件，哈希随之更新）", form: 'inline' },
  { cls: 'A', file: SRV, where: "PUT /api/models/:id", hash: '02567da9f1c1', why: "PUT 不带 dim_config：A 类字段变化时 config_rev 并入同一条 UPDATE 递增（7881 分支；末次合并审 H2 起 WHERE 带 config_rev 版本条件，哈希随之更新）", form: 'inline' },
  { cls: 'B', file: SRV, where: "PUT /api/models/:id/comment-split", hash: 'a5195bd7c422', why: "表注释拆分迁移专用原子条件写：只改 table_comment / impl_note（描述字段，不影响产出）与 updated_at，旧值 / 未删除 / 伴生归属 / 父行（parent_only）/ 可选版本（expected_config_rev）条件并入同一条 UPDATE，不递增 config_rev（C2a 修复 F1 / 修复 3 X1）" },
  { cls: 'B', file: SRV, where: "tag:companion-restore", hash: '7811a3637589', why: "同步伴生表：恢复已删除的伴生表行；伴生表不独立验收，主表 dim_config 变化已触发递增（7971）" },
  { cls: 'B', file: SRV, where: "tag:companion-link-existing", hash: '0f2ac8834f55', why: "同步伴生表：已存在独立模型按表名转为伴生，判定上 companion_of 非空即 companion（7981）" },
  { cls: 'B', file: SRV, where: "tag:companion-insert", hash: 'ea5f9863e268', why: "同步伴生表：创建伴生表行，新行 config_rev 取默认 1（7987）" },
  { cls: 'B', file: SRV, where: "tag:companion-cancel-tracking-softdelete", hash: '035d425fea07', why: "取消变更追踪：软删伴生表；主表 dim_config 变化已触发递增（8004，v0.9 补登记）" },
  { cls: 'B', file: SRV, where: "tag:companion-sync-meta", hash: '98bcc9be9ff3', why: "同步伴生表元数据（注释 / 负责人 / 域），只改伴生行（8021）" },
  { cls: 'B', file: SRV, where: "tag:companion-link-by-name", hash: '08e870062c1e', why: "按表名补充伴生从属关系，同 companion-link-existing（8034）" },
  { cls: 'B', file: SRV, where: "tag:companion-id-writeback", hash: '21964e5b9227', why: "updateCompanionModelId：伴生表 id 簿记写回主表 dim_config，不改产出（8076）；PUT 侧比较时剔除该簿记字段" },
  { cls: 'B', file: SRV, where: "POST /api/models/batch", hash: 'b4fa3578b6d3', why: "批量导入新模型，config_rev 取默认 1，无既有验收（8277）" },
  { cls: 'A', file: SRV, where: "POST /api/models/:id/save-scripts", hash: '2fc5964e2400', why: "保存脚本：内容实质变化时处理器先调 bumpConfigRev 再写文件；本句只更新 script_path 等簿记字段（10053）", form: 'call' },
  { cls: 'B', file: SRV, where: "PUT /api/models/:id/script-modified", hash: '08d8e0c2caa2', why: "仅「脚本被人工改过」标记置 1，内容变化由 edit-script 记账（10139）" },
  { cls: 'B', file: SRV, where: "PUT /api/models/:id/script-modified", hash: '2759613a7adf', why: "仅「脚本被人工改过」标记清 0（10144）" },
  { cls: 'A', file: SRV, where: "PUT /api/models/:id/edit-script", hash: '6874f3fcf2f0', why: "编辑脚本：首次建目录更新 script_path；递增不挂在本句上，由 contentChanged 为真后单独的 bumpConfigRev 承担（10186）", form: 'call' },
  { cls: 'A', file: SRV, where: "PUT /api/models/:id/edit-script", hash: '08d8e0c2caa2', why: "编辑脚本：人工编辑已有文件时置 script_modified；递增由同处理器内 bumpConfigRev 承担（10223）", form: 'call' },
  { cls: 'A', file: "wbs-server/utils/model-restore.js", where: "tag:model-restore", hash: '6abbcd6737d0', why: "恢复软删除模型：删除期间的状态不可知，恒递增；与恢复并入同一条 UPDATE（CONFIG_REV_BUMP_SQL，参数恒 1）", form: 'inline' },
];

// ───────────────────────────── 分析核心（纯函数，自证复用）─────────────────────────────
// 表名匹配：可选 schema 前缀（裸词或 "x" / `x` / [x] / 'x'）+ 可选空白 + `.` + 可选空白 + 表名（同四种形态）。全部用非捕获组。
const SCH = '(?:[A-Za-z_]\\w*|"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|\'[^\']+\')';
const tblRe = (n) => `(?:${SCH}\\s*\\.\\s*)?(?:${n}(?![\\w])|"${n}"|\`${n}\`|\\[${n}\\]|'${n}')`;
const TBL = tblRe('data_models');
const TEST_TBL = tblRe('model_test_records');
const WRITE_PATTERNS = [
  ['UPDATE', new RegExp(`\\bUPDATE\\s+(?:OR\\s+\\w+\\s+)?${TBL}\\s+SET\\b`, 'gi')],
  ['INSERT', new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${TBL}`, 'gi')],
  ['REPLACE', new RegExp(`\\bREPLACE\\s+INTO\\s+${TBL}`, 'gi')],
  ['DELETE', new RegExp(`\\bDELETE\\s+FROM\\s+${TBL}`, 'gi')],
];
const UPSERT_RE = /\bON\s+CONFLICT\b[\s\S]*?\bDO\s+UPDATE\b/i;
// 扫描面兜底（④）：整条字面量里全局搜「写动词 + data_models」——命中却未被上面五类主模式在同一位置命中的，判 SCAN_HOLE
// （带别名 / WITH 前缀 / 多语句里的后一条等）。model_test_records 同理，只取 INSERT / REPLACE 两种形态（它的 UPDATE 是合法的失效置位）。
const HOLE_DM_RE = new RegExp(`\\b(UPDATE(?:\\s+OR\\s+\\w+)?|INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|DELETE\\s+FROM)\\s+${TBL}`, 'gi');
const HOLE_TR_RE = new RegExp(`\\b(INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO)\\s+${TEST_TBL}`, 'gi');
function findHoles(sql, holeRe, strictRes) {
  const strictAt = new Set();
  for (const re of strictRes) { re.lastIndex = 0; let m; while ((m = re.exec(sql))) strictAt.add(m.index); }
  const holes = [];
  holeRe.lastIndex = 0;
  let m;
  while ((m = holeRe.exec(sql))) if (!strictAt.has(m.index)) holes.push(sql.slice(m.index, m.index + 100).replace(/\s+/g, ' '));
  return holes;
}
const TEST_INSERT_RE = new RegExp(`\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO)\\s+${TEST_TBL}\\s*(?:\\(([^)]*)\\))?`, 'gi');
const TAG_RE = /^\s*mc-write:\s*(\S.*?)\s*$/;
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch']);
const ROUTE_OBJECTS = new Set(['app', 'router']);

function buildLineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function parseSource(src) {
  const comments = [];
  const opts = { ecmaVersion: 'latest', allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, onComment: (block, text, start, end) => comments.push({ block, text, start, end }) };
  let ast;
  try { ast = acorn.parse(src, { ...opts, sourceType: 'script' }); }
  catch (e1) {
    comments.length = 0;
    try { ast = acorn.parse(src, { ...opts, sourceType: 'module' }); }
    catch (_e2) { return { error: e1.message }; }
  }
  // 注释等长掩码成空格（保留换行）——SQL 里的 `--` 不是 JS 注释，不受影响
  const chars = src.split('');
  for (const c of comments) for (let i = c.start; i < c.end; i++) if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  return { ast, comments, masked: chars.join('') };
}

// ── 绑定级作用域分析：只为回答「这个标识符的词法绑定是不是 config-rev 模块的某个导出」──
const CONFIG_REV_MODULE = 'wbs-server/routes/model-center/config-rev';
function buildScopes(ast, rel) {
  const scopes = [];
  const mk = (kind, node, parent) => { const s = { kind, start: node.start, end: node.end, parent, decls: new Map() }; scopes.push(s); return s; };
  const declare = (scope, name, cfg) => { let a = scope.decls.get(name); if (!a) { a = []; scope.decls.set(name, a); } a.push({ cfg }); };
  const fnScope = (s) => { while (s.kind === 'block') s = s.parent; return s; };
  const patNames = (p, out) => {
    if (!p) return out;
    switch (p.type) {
      case 'Identifier': out.push(p.name); break;
      case 'ObjectPattern': for (const q of p.properties) patNames(q.type === 'RestElement' ? q.argument : q.value, out); break;
      case 'ArrayPattern': for (const q of p.elements) patNames(q, out); break;
      case 'AssignmentPattern': patNames(p.left, out); break;
      case 'RestElement': patNames(p.argument, out); break;
      default:
    }
    return out;
  };
  const isConfigRevRequire = (init) => {
    if (!init || init.type !== 'CallExpression' || init.callee.type !== 'Identifier' || init.callee.name !== 'require') return false;
    const a0 = init.arguments[0];
    if (init.arguments.length !== 1 || !a0 || a0.type !== 'Literal' || typeof a0.value !== 'string') return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), a0.value)).replace(/\.js$/, '');
    return resolved === CONFIG_REV_MODULE;
  };
  // 顶层 const 的 require(config-rev) 解构 / 整体赋值 → 每个局部名 → { exp: 导出名 | '*'（整个模块命名空间） }
  const cfgMap = (d) => {
    const m = new Map();
    if (!isConfigRevRequire(d.init)) return m;
    if (d.id.type === 'Identifier') m.set(d.id.name, { exp: '*' });
    else if (d.id.type === 'ObjectPattern') {
      for (const q of d.id.properties) {
        if (q.type !== 'Property' || q.computed || q.value.type !== 'Identifier') continue;
        const exp = q.key.type === 'Identifier' ? q.key.name : (q.key.type === 'Literal' ? String(q.key.value) : null);
        if (exp !== null) m.set(q.value.name, { exp });
      }
    }
    return m;
  };
  const walk = (n, scope) => {
    if (!n || typeof n.type !== 'string') return;
    let next = scope;
    switch (n.type) {
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': {
        if (n.type === 'FunctionDeclaration' && n.id) declare(scope, n.id.name, null);
        next = mk('function', n, scope);
        if (n.type === 'FunctionExpression' && n.id) declare(next, n.id.name, null);
        for (const p of n.params) { for (const nm of patNames(p, [])) declare(next, nm, null); walk(p, next); }
        if (n.body && n.body.type === 'BlockStatement') for (const s of n.body.body) walk(s, next); else walk(n.body, next);
        return;
      }
      case 'BlockStatement': case 'ForStatement': case 'ForInStatement': case 'ForOfStatement': case 'SwitchStatement':
        next = mk('block', n, scope); break;
      case 'CatchClause':
        next = mk('block', n, scope);
        if (n.param) for (const nm of patNames(n.param, [])) declare(next, nm, null);
        break;
      case 'ClassDeclaration': if (n.id) declare(scope, n.id.name, null); break;
      case 'ImportDeclaration': for (const sp of n.specifiers) declare(scope, sp.local.name, null); return;
      case 'VariableDeclaration': {
        const target = n.kind === 'var' ? fnScope(scope) : scope;
        for (const d of n.declarations) {
          const cm = (scope.kind === 'program' && n.kind === 'const') ? cfgMap(d) : new Map();
          for (const nm of patNames(d.id, [])) declare(target, nm, cm.get(nm) || null);
          walk(d.id, scope); walk(d.init, scope);
        }
        return;
      }
      default:
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) walk(c, next); }
      else if (v && typeof v.type === 'string') walk(v, next);
    }
  };
  const root = mk('program', ast, null);
  walk(ast, root);
  // 解析：pos 处名为 name 的标识符 → 最近声明；恰好一条声明且带 cfg 才返回 cfg，否则 null（遮蔽 / 重复声明 / 未绑定 / 非 config-rev 来源）
  return (name, pos) => {
    let best = null;
    for (const s of scopes) if (s.start <= pos && pos < s.end && (!best || s.start > best.start || (s.start === best.start && s.end < best.end))) best = s;
    for (let s = best; s; s = s.parent) {
      const a = s.decls.get(name);
      if (a) return a.length === 1 ? a[0].cfg : null;
    }
    return null;
  };
}

function collectNodes(ast, masked, rel) {
  const literals = [], routes = [], functions = [], bumpCalls = [];
  const resolve = buildScopes(ast, rel);
  const stack = [ast];
  while (stack.length) {
    const n = stack.pop();
    if (!n || typeof n.type !== 'string') continue;
    switch (n.type) {
      case 'Literal':
        // pieces = 源码原文（只用于哈希）；vpieces = 求值后的字符串值（用于匹配）。二者不一致 = 含转义 / 行续接（见 analyze 的 escaped 判红）
        if (typeof n.value === 'string') literals.push({ start: n.start, end: n.end, pieces: [masked.slice(n.start + 1, n.end - 1)], vpieces: [n.value], exprs: [], inlineBump: false });
        break;
      case 'TemplateLiteral':
        literals.push({
          start: n.start, end: n.end,
          pieces: n.quasis.map(q => q.value.raw),
          vpieces: n.quasis.map(q => (q.value.cooked == null ? q.value.raw : q.value.cooked)),
          exprs: n.expressions.map(e => masked.slice(e.start, e.end)),
          // inline 递增（绑定级）：某个插值表达式的 AST 恰为 Identifier(CONFIG_REV_BUMP_SQL)，且绑定来自 config-rev 模块的同名导出
          inlineBump: n.expressions.some(e => {
            if (e.type !== 'Identifier' || e.name !== 'CONFIG_REV_BUMP_SQL') return false;
            const b = resolve(e.name, e.start);
            return !!b && b.exp === 'CONFIG_REV_BUMP_SQL';
          }),
        });
        break;
      case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression':
        functions.push({ start: n.start, end: n.end });
        break;
      case 'CallExpression': {
        const c = n.callee;
        // call 递增（绑定级）：裸标识符 bumpConfigRev 绑定到 config-rev 的同名导出；或 x.bumpConfigRev，x 绑定到整个模块（命名空间）
        if (c && c.type === 'Identifier' && c.name === 'bumpConfigRev') {
          const b = resolve(c.name, c.start);
          if (b && b.exp === 'bumpConfigRev') bumpCalls.push({ start: n.start, end: n.end });
        } else if (c && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.property.name === 'bumpConfigRev') {
          const b = resolve(c.object.name, c.object.start);
          if (b && b.exp === '*') bumpCalls.push({ start: n.start, end: n.end });
        }
        if (c && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier'
          && ROUTE_OBJECTS.has(c.object.name) && ROUTE_METHODS.has(c.property.name)) {
          const a0 = n.arguments[0];
          let routePath = null;
          if (a0 && a0.type === 'Literal' && typeof a0.value === 'string') routePath = a0.value;
          else if (a0 && a0.type === 'TemplateLiteral' && a0.expressions.length === 0) routePath = a0.quasis[0].value.cooked;
          if (routePath !== null) routes.push({ start: n.start, end: n.end, key: `${c.property.name.toUpperCase()} ${routePath}` });
        }
        break;
      }
      default:
    }
    for (const k of Object.keys(n)) {
      if (k === 'type' || k === 'start' || k === 'end') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') stack.push(c); }
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  return { literals, routes, functions, bumpCalls };
}

// SQL 注释剥离：单引号字符串内的 `--` `/*` 不算注释
function stripSqlComments(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) { if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; } j++; }
      out += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (ch === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; out += ' '; continue; }
    out += ch; i++;
  }
  return out;
}

function unifyPlaceholders(s) {
  return s.replace(/(?<![\w'])[:@][A-Za-z_]\w*/g, '?').replace(/\$\d+(?![\w])/g, '?');
}

// 匹配用：插值表达式换成中性占位；哈希用：插值保留表达式原文（空白压缩）
function sqlForMatch(lit) {
  let s = '';
  lit.vpieces.forEach((p, i) => { s += stripSqlComments(p); if (i < lit.exprs.length) s += ' \u0001 '; });
  return s;
}
function normalizedSql(lit) {
  let s = '';
  lit.pieces.forEach((p, i) => {
    s += unifyPlaceholders(stripSqlComments(p));
    if (i < lit.exprs.length) s += '${' + lit.exprs[i].replace(/\s+/g, ' ').trim() + '}';
  });
  return s.replace(/\s+/g, ' ').trim();
}
function hashOf(norm) { return crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12); }

function smallestEnclosing(list, pos) {
  let best = null;
  for (const r of list) if (r.start <= pos && pos < r.end && (!best || r.start > best.start)) best = r;
  return best;
}
function largestEnclosing(list, pos) {
  let best = null;
  for (const r of list) if (r.start <= pos && pos < r.end && (!best || r.end - r.start > best.end - best.start)) best = r;
  return best;
}
const inRange = (list, r) => list.some(x => x.start >= r.start && x.end <= r.end);

/**
 * files: Map<relPath, text>；registry 默认用本文件 REGISTRY。
 * 返回 { issues:[{code,msg,key?}], hits:[{file,line,kind,where,hash,cls,scope,sqlHead}], testInserts, stats }
 */
function analyze(files, registry = REGISTRY, coverage = loadCoverage()) {
  const issues = [];
  const hits = [];
  const testInserts = [];
  const relList = [...files.keys()];
  if (relList.length < 1) issues.push({ code: 'SCAN_FACE', msg: '扫描面为空' });
  if (!files.has(SRV)) issues.push({ code: 'SCAN_FACE', msg: `扫描面缺少 ${SRV}` });

  for (const rel of relList) {
    const src = files.get(rel);
    const p = parseSource(src);
    if (p.error) { issues.push({ code: 'PARSE', msg: `${rel} 无法解析（不静默跳过）：${p.error}` }); continue; }
    const nodes = collectNodes(p.ast, p.masked, rel);
    const lineOf = buildLineIndex(src);
    const tags = p.comments
      .filter(c => !c.block)
      .map(c => { const m = TAG_RE.exec(c.text); return m ? { label: m[1], start: c.start, line: lineOf(c.start), used: false } : null; })
      .filter(Boolean);
    const labelSeen = new Set();
    for (const t of tags) {
      if (labelSeen.has(t.label)) issues.push({ code: 'TAG_DUP', msg: `${rel}:${t.line} mc-write 标签重名：${t.label}` });
      labelSeen.add(t.label);
    }

    const fileHits = [];
    for (const lit of nodes.literals) {
      const sql = sqlForMatch(lit);

      // model_test_records INSERT 列清单
      TEST_INSERT_RE.lastIndex = 0;
      let tm;
      while ((tm = TEST_INSERT_RE.exec(sql))) {
        const cols = tm[1] === undefined ? null : tm[1].split(',').map(s => s.trim().replace(/["'`\[\]]/g, '').toLowerCase());
        testInserts.push({ file: rel, line: lineOf(lit.start), hasConfigRev: !!cols && cols.includes('config_rev'), noList: cols === null });
      }

      // data_models 写语句
      const kinds = [];
      for (const [kind, re] of WRITE_PATTERNS) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(sql))) kinds.push(kind);
      }
      if (kinds.length === 0 && /\bdata_models\b/i.test(sql) && UPSERT_RE.test(sql)) kinds.push('UPSERT');
      // ④ 兜底：写动词 + data_models 命中、却不在五类主模式的同一位置 → 扫描面有洞（别名 / WITH 前缀 / 多语句等）
      const holes = findHoles(sql, HOLE_DM_RE, WRITE_PATTERNS.map(x => x[1]))
        .concat(findHoles(sql, HOLE_TR_RE, [TEST_INSERT_RE]));
      for (const snippet of holes) {
        issues.push({ code: 'SCAN_HOLE', msg: `${rel}:${lineOf(lit.start)} 写动词 + data_models / model_test_records 出现在五类匹配模式之外（如带别名 / WITH 前缀 / 多语句）——扫描面有洞，须改写或扩充模式：${snippet}` });
      }
      // ④ 求值后的字符串值用于匹配、源码原文只用于哈希；二者不一致（含转义 / 行续接）且该字面量是写点 → 判红（原文哈希与真实语句脱钩）
      const lit_is_write = kinds.length > 0 || holes.length > 0 || testInserts.some(t => t.file === rel && t.line === lineOf(lit.start));
      if (lit_is_write && lit.pieces.join('\u0000') !== lit.vpieces.join('\u0000')) {
        issues.push({ code: 'SCAN_HOLE', msg: `${rel}:${lineOf(lit.start)} 写 data_models / model_test_records 的字符串字面量含转义或行续接（求值后与源码原文不一致，登记哈希与真实语句脱钩）——须改写成无转义形式：${sql.trim().slice(0, 80).replace(/\s+/g, ' ')}` });
      }
      if (kinds.length === 0) continue;
      const norm = normalizedSql(lit);
      const hash = hashOf(norm);
      for (const kind of kinds) fileHits.push({ file: rel, lit, kind, hash, norm, line: lineOf(lit.start) });
    }

    // 标签关联：每个写点取「其上方、上一个写点之后、8 行以内」最近的一条未用标签
    fileHits.sort((a, b) => a.lit.start - b.lit.start);
    let prevStart = -1;
    for (const h of fileHits) {
      const route = smallestEnclosing(nodes.routes, h.lit.start);
      let tag = null;
      for (const t of tags) if (!t.used && t.start < h.lit.start && t.start > prevStart && h.line - t.line <= 8) tag = t;
      if (tag) tag.used = true;
      prevStart = Math.max(prevStart, h.lit.start);
      let where, scope;
      if (route) {
        // 作用域 = 包含该字面量的最内层函数（与带标签写点一致），且该函数须位于路由注册调用之内；
        // 找不到这样的函数 → 空作用域（A 类必判红），不退回「整个路由调用」（那会让兄弟中间件里的递增调用放行本处理器）
        where = route.key;
        const fn = smallestEnclosing(nodes.functions, h.lit.start);
        scope = (fn && fn.start >= route.start && fn.end <= route.end) ? { start: fn.start, end: fn.end } : { start: route.start, end: route.start };
      }
      else if (tag) {
        where = `tag:${tag.label}`;
        const fn = smallestEnclosing(nodes.functions, h.lit.start);   // 最内层函数（方案：带标签写点「所在函数体」）
        scope = fn ? { start: fn.start, end: fn.end } : { start: 0, end: src.length };
      } else {
        where = null; scope = null;
      }
      hits.push({ file: rel, line: h.line, kind: h.kind, where, hash: h.hash, scope, sqlHead: h.norm.slice(0, 90), inlineBump: h.lit.inlineBump, litStart: h.lit.start, litEnd: h.lit.end, nodes });
    }
    for (const t of tags) if (!t.used) issues.push({ code: 'ORPHAN_TAG', msg: `${rel}:${t.line} mc-write 标签「${t.label}」没有对应的写点（其下 8 行内无 data_models 写语句，或已被更近的标签占用）` });
  }

  // ① 双向相等（多重集）
  const pool = registry.map((e, i) => ({ e, i, used: false }));
  for (const h of hits) {
    if (h.where === null) {
      h.entry = null;
      issues.push({ code: 'UNREGISTERED', key: `${h.file}|<无路由无标签>|${h.hash}`, msg: `${h.file}:${h.line} ${h.kind} data_models 写入点既不在路由处理器内、上方也没有 \`// mc-write: <标签>\` 注释，无法登记（hash=${h.hash}）：${h.sqlHead}` });
      continue;
    }
    const slot = pool.find(s => !s.used && s.e.file === h.file && s.e.where === h.where && s.e.hash === h.hash);
    if (!slot) {
      h.entry = null;
      issues.push({ code: 'UNREGISTERED', key: `${h.file}|${h.where}|${h.hash}`, msg: `${h.file}:${h.line} 未登记的 ${h.kind} data_models 写入点 [${h.where}] hash=${h.hash}：${h.sqlHead}` });
      continue;
    }
    slot.used = true; h.entry = slot.e;
  }
  for (const s of pool) {
    if (!s.used) issues.push({ code: 'REGISTRY_STALE', key: `${s.e.file}|${s.e.where}|${s.e.hash}`, msg: `登记表第 ${s.i + 1} 条在源码中找不到：${s.e.file} [${s.e.where}] hash=${s.e.hash}（${s.e.why}）` });
  }
  for (const s of pool) {
    if (!['A', 'B', 'MECH'].includes(s.e.cls)) issues.push({ code: 'REGISTRY_BAD', msg: `登记表第 ${s.i + 1} 条分类必须是 A / B / MECH` });
    // MECH（机制豁免）只留给递增助手自己，且至多 1 条：防止把任意写点标成 MECH 绕过 A 类门②
    if (s.e.cls === 'MECH' && !(s.e.file === 'wbs-server/routes/model-center/config-rev.js' && s.e.where === 'tag:bump-helper')) issues.push({ code: 'REGISTRY_BAD', msg: `登记表第 ${s.i + 1} 条：MECH 只允许登记 config-rev.js 的 tag:bump-helper` });
    if (!s.e.why || !String(s.e.why).trim()) issues.push({ code: 'REGISTRY_BAD', msg: `登记表第 ${s.i + 1} 条缺理由` });
  }

  // ② A 类：作用域内必须出现 bumpConfigRev( 调用或 CONFIG_REV_BUMP_SQL 引用
  for (const h of hits) {
    if (!h.entry || h.entry.cls !== 'A') continue;
    // 递增形态（绑定级）：inline = 本语句模板字面量的某个插值恰为 Identifier(CONFIG_REV_BUMP_SQL) 且绑定来自 config-rev 模块；
    // call = 处理器内有 callee 绑定到 config-rev 模块导出的 bumpConfigRev( 调用
    const form = h.entry.form;
    let ok, need;
    if (form === 'inline') { ok = h.inlineBump === true; need = '本语句内插入 ${CONFIG_REV_BUMP_SQL}（插值恰为该标识符，且绑定来自 config-rev 模块的 require / 解构）'; }
    else if (form === 'call') { ok = inRange(h.nodes.bumpCalls, h.scope); need = 'bumpConfigRev( 调用（裸标识符，绑定来自 config-rev 模块的 require / 解构；成员调用 / 局部同名 / 遮蔽不算）'; }
    else { ok = false; need = '登记 form（inline / call）'; }
    h.bumped = ok;
    if (!ok) issues.push({ code: 'A_NO_BUMP', key: `${h.file}|${h.where}`, msg: `${h.file}:${h.line} A 类写入点 [${h.where}]（form=${form}）所在处理器 / 函数体内缺少：${need}` });
  }

  // ③ model_test_records INSERT 必须写 config_rev
  for (const t of testInserts) {
    if (!t.hasConfigRev) issues.push({ code: 'TEST_RECORD_NO_REV', msg: `${t.file}:${t.line} INSERT INTO model_test_records ${t.noList ? '没有列清单' : '的列清单不含 config_rev'}` });
  }

  // ③⁺ A 类覆盖契约：登记表 A 类 (file, route, hash) 多重集与契约文件 entries 全等（缺一条或多一条都判红）
  if (coverage.error) issues.push({ code: 'A_COVERAGE', msg: `A 类覆盖契约文件不可用（前提硬门）：${coverage.error}` });
  else {
    const count = (arr) => { const m = new Map(); for (const k of arr) m.set(k, (m.get(k) || 0) + 1); return m; };
    const reg = count(registry.filter(e => e.cls === 'A').map(e => `${e.file}|${e.where}|${e.hash}`));
    const cov = count(coverage.entries.map(e => `${e.file}|${e.route}|${e.hash}`));
    const onlyReg = [], onlyCov = [];
    for (const [k, n] of reg) for (let i = 0; i < n - (cov.get(k) || 0); i++) onlyReg.push(k);
    for (const [k, n] of cov) for (let i = 0; i < n - (reg.get(k) || 0); i++) onlyCov.push(k);
    if (onlyReg.length) issues.push({ code: 'A_COVERAGE', msg: `登记表有 A 类条目但覆盖契约（a-class-coverage.json）没有（须同步补契约与 HTTP 用例）：${onlyReg.join('；')}` });
    if (onlyCov.length) issues.push({ code: 'A_COVERAGE', msg: `覆盖契约（a-class-coverage.json）有条目但登记表没有对应 A 类条目：${onlyCov.join('；')}` });
  }

  for (const h of hits) delete h.nodes;
  return { issues, hits, testInserts };
}

// A 类覆盖契约文件（②/③⁺）：缺失 / 解析失败 / entries 为空 → error（前提硬门）
const COVERAGE_REL = 'wbs-server/scripts/fixtures/model-gate-contract/a-class-coverage.json';
let coverageCache = null;
function loadCoverage() {
  if (coverageCache) return coverageCache;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, COVERAGE_REL), 'utf8'));
    if (!j || !Array.isArray(j.entries) || j.entries.length === 0) coverageCache = { error: `${COVERAGE_REL} 的 entries 缺失或为空` };
    else if (!j.entries.every(e => e && typeof e.file === 'string' && typeof e.route === 'string' && typeof e.hash === 'string')) coverageCache = { error: `${COVERAGE_REL} 有 entries 条目缺 file / route / hash` };
    else coverageCache = { entries: j.entries };
  } catch (e) { coverageCache = { error: `${COVERAGE_REL} 读取或解析失败：${e.message}` }; }
  return coverageCache;
}

// ───────────────────────────── 读取 git 可见集合 ─────────────────────────────
// 返回 { status, out, stderr, spawnError, error }：status 为进程退出码（异常 / 被信号终止时为 null）；error 非空 = 调用没有成功
function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const stderr = typeof r.stderr === 'string' ? r.stderr : '';
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  const res = { status: r.status, out, stderr, spawnError: r.error ? r.error.message : null };
  if (r.error) res.error = r.error.message;
  else if (r.status !== 0) res.error = `git ${args.join(' ')} 退出码 ${r.status}${stderr ? '：' + stderr.trim() : ''}`;
  return res;
}
// 稀疏检出前提（纯函数，自证复用）：仅两种情形算「未开启」——
//   ① config 退出 0 且输出 false；② config 退出码恰为 1、stderr 为空、无 spawn 异常（= 配置项不存在），且确认在工作树内。
function judgeSparseOff(cfg, inside) {
  if (cfg.spawnError) return { ok: false, detail: `git config 调用异常：${cfg.spawnError}` };
  if (cfg.status === 0) {
    const v = (cfg.out || '').trim();
    return { ok: v === 'false', detail: `core.sparseCheckout=${v}` };
  }
  if (cfg.status === 1) {
    if ((cfg.stderr || '').trim() !== '') return { ok: false, detail: `git config 退出码 1 但有 stderr：${cfg.stderr.trim()}` };
    const insideOk = !!inside && !inside.spawnError && inside.status === 0 && (inside.out || '').trim() === 'true';
    return { ok: insideOk, detail: insideOk ? '配置项不存在（退出码 1、stderr 为空、在工作树内）' : 'git config 退出码 1 但无法确认在工作树内（rev-parse --is-inside-work-tree 非 true）' };
  }
  return { ok: false, detail: `git config 退出码 ${cfg.status}（非 0 / 1）：${(cfg.stderr || '').trim()}` };
}
function loadScanFace() {
  const pre = [];
  const top = git(['rev-parse', '--show-toplevel']);
  const actual = top.out ? path.resolve(top.out.trim()) : null;
  pre.push({ label: '前提：git 仓库根 = 本项目根', ok: !!actual && actual.toLowerCase() === REPO_ROOT.toLowerCase(), detail: top.error || `${actual} vs ${REPO_ROOT}` });
  const sparse = git(['config', '--get', '--bool', 'core.sparseCheckout']);
  const inside = git(['rev-parse', '--is-inside-work-tree']);
  const sj = judgeSparseOff(sparse, inside);
  pre.push({ label: '前提：未开启稀疏检出（仅「退出 0 输出 false」或「退出 1 + stderr 空 + 在工作树内」算通过）', ok: sj.ok, detail: sj.detail });
  const ls = git(['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', 'wbs-server']);
  if (ls.error) return { pre, error: `git ls-files 失败：${ls.error}` };
  const files = new Map();
  for (const rel of ls.out.split('\0')) {
    if (!rel || !SCAN_PATTERNS.some(re => re.test(rel))) continue;
    const full = path.join(REPO_ROOT, rel);
    if (!fs.existsSync(full)) continue; // 已跟踪但工作区已删
    files.set(rel, fs.readFileSync(full, 'utf8'));
  }
  return { pre, files };
}

// ───────────────────────────── 变异自证 ─────────────────────────────
const MUT_ROUTE = "app.get('/__mc_selftest__', (req, res) => { %BODY% });";
function appendRoute(files, body) {
  const m = new Map(files);
  m.set(SRV, files.get(SRV) + '\n' + MUT_ROUTE.replace('%BODY%', body) + '\n');
  return m;
}
function runSelfTest(faceFiles, baseline) {
  const results = [];
  const record = (name, expectCode, filesMut, extra) => {
    let r;
    try { r = analyze(filesMut); } catch (e) { results.push({ name, ok: false, detail: `分析抛异常：${e.message}` }); return; }
    const hit = r.issues.filter(i => i.code === expectCode && (!extra || extra(i)));
    results.push({ name, ok: hit.length > 0, detail: hit.length ? hit[0].msg.slice(0, 160) : `未出现预期的 ${expectCode} 判红；实际 issues=${JSON.stringify(r.issues.map(i => i.code))}` });
  };
  const selfKey = i => (i.key || '').includes('__mc_selftest__') || i.msg.includes('__mc_selftest__') || /hash=/.test(i.msg);

  // 六个必答变异
  record('M1 新增未登记的单行 UPDATE data_models SET', 'UNREGISTERED', appendRoute(faceFiles, "db.run(\"UPDATE data_models SET domain = 'x' WHERE id = 1\");"), i => i.key && i.key.includes('__mc_selftest__'));
  record('M2 新增未登记的跨行 UPDATE data_models SET', 'UNREGISTERED', appendRoute(faceFiles, 'db.run(`UPDATE\n      data_models\n      SET domain = ?\n      WHERE id = ?`, [1, 2]);'), i => i.key && i.key.includes('__mc_selftest__'));
  record('M3 新增未登记的 INSERT INTO data_models', 'UNREGISTERED', appendRoute(faceFiles, "db.run(\"INSERT INTO data_models (table_name) VALUES ('x')\");"), i => i.key && i.key.includes('__mc_selftest__'));
  record('M4 新增未登记的 DELETE FROM data_models', 'UNREGISTERED', appendRoute(faceFiles, "db.run('DELETE FROM data_models WHERE id = 1');"), i => i.key && i.key.includes('__mc_selftest__'));

  // M5：删掉某 A 类（call 形态）处理器里的 bumpConfigRev( 调用
  {
    const target = baseline.hits.find(h => h.entry && h.entry.cls === 'A' && h.entry.form === 'call');
    if (!target) results.push({ name: 'M5 删掉 A 类处理器里的 bumpConfigRev( 调用', ok: false, detail: '跳过：登记表里没有 call 形态的 A 类条目（跳过 = 失败）' });
    else {
      const src = faceFiles.get(target.file);
      const seg = src.slice(target.scope.start, target.scope.end);
      const mutSeg = seg.replace(/\bbumpConfigRev\s*\(/g, 'bumpConfigRevRemoved(');
      if (mutSeg === seg) results.push({ name: 'M5 删掉 A 类处理器里的 bumpConfigRev( 调用', ok: false, detail: `跳过：目标处理器 [${target.where}] 内没有可替换的调用（跳过 = 失败）` });
      else {
        const m = new Map(faceFiles);
        m.set(target.file, src.slice(0, target.scope.start) + mutSeg + src.slice(target.scope.end));
        record(`M5 删掉 A 类处理器 [${target.where}] 里的 bumpConfigRev( 调用`, 'A_NO_BUMP', m, i => (i.key || '').includes(target.where));
      }
    }
  }
  // M6：某个 model_test_records INSERT 去掉 config_rev 列
  {
    const src = faceFiles.get(SRV);
    const re = new RegExp(`(\\bINSERT\\s+INTO\\s+${TEST_TBL}\\s*\\()([^)]*)(\\))`, 'i');
    const mm = re.exec(src);
    if (!mm) results.push({ name: 'M6 model_test_records INSERT 去掉 config_rev', ok: false, detail: '跳过：源码里找不到 INSERT INTO model_test_records（跳过 = 失败）' });
    else {
      const cols = mm[2].split(',').map(s => s.trim()).filter(s => s.toLowerCase() !== 'config_rev');
      if (cols.length === mm[2].split(',').length) results.push({ name: 'M6 model_test_records INSERT 去掉 config_rev', ok: false, detail: '跳过：首个 INSERT 列清单本来就没有 config_rev（跳过 = 失败）' });
      else {
        const m = new Map(faceFiles);
        m.set(SRV, src.slice(0, mm.index) + mm[1] + cols.join(', ') + mm[3] + src.slice(mm.index + mm[0].length));
        record('M6 model_test_records INSERT 去掉 config_rev 列', 'TEST_RECORD_NO_REV', m);
      }
    }
  }

  // 加固变异
  record('X1 UPSERT（ON CONFLICT … DO UPDATE）写 data_models', 'UNREGISTERED', appendRoute(faceFiles, "db.run(\"INSERT INTO data_models (id, domain) VALUES (1, 'x') ON CONFLICT(id) DO UPDATE SET domain = 'y'\");"), i => i.key && i.key.includes('__mc_selftest__'));
  record('X2 REPLACE INTO data_models', 'UNREGISTERED', appendRoute(faceFiles, "db.run(\"REPLACE INTO data_models (id, domain) VALUES (1, 'x')\");"), i => i.key && i.key.includes('__mc_selftest__'));
  record('X3 带别名的 UPDATE data_models AS m SET（扫描面洞 → 判红而非放行）', 'SCAN_HOLE', appendRoute(faceFiles, "db.run(\"UPDATE data_models AS m SET domain = 'x' WHERE m.id = 1\");"));
  record('X4 写点在路由之外且没有 mc-write 标签', 'UNREGISTERED', (() => { const m = new Map(faceFiles); m.set(SRV, faceFiles.get(SRV) + "\nfunction __mcSelfTestHelper() { db.run(\"UPDATE data_models SET domain = 'x'\"); }\n"); return m; })(), i => /无路由无标签/.test(i.key || ''));
  record('X5 孤立的 mc-write 标签', 'ORPHAN_TAG', (() => { const m = new Map(faceFiles); m.set(SRV, faceFiles.get(SRV) + '\n// mc-write: orphan-selftest\n'); return m; })());
  record('X6 model_test_records INSERT 没有列清单', 'TEST_RECORD_NO_REV', appendRoute(faceFiles, "db.run('INSERT INTO model_test_records SELECT * FROM model_test_records');"));
  // X7 反向对照：注释里的写语句必须被忽略——问题数不得增加（剥注释先行，坑 9）
  {
    const m = new Map(faceFiles);
    m.set(SRV, faceFiles.get(SRV) + '\n// db.run("UPDATE data_models SET domain = \'x\'")\n/* INSERT INTO data_models (a) VALUES (1) */\n');
    const r = analyze(m);
    results.push({ name: 'X7 注释里的写语句被忽略（对照：问题数不增）', ok: r.issues.length === baseline.issues.length, detail: `issues ${baseline.issues.length} -> ${r.issues.length}` });
  }
  // X8：登记表某条对应的源码消失（改路由路径）→ 登记表过期 + 新路径未登记
  {
    const src = faceFiles.get(SRV);
    const from = "app.put('/api/models/:id/script-modified'";
    if (!src.includes(from)) results.push({ name: 'X8 路由改名 → 登记表过期', ok: false, detail: '跳过：锚点 script-modified 路由不存在（跳过 = 失败）' });
    else {
      const m = new Map(faceFiles); m.set(SRV, src.replace(from, () => "app.put('/api/models/:id/script-modified-renamed'"));
      record('X8 路由改名 → 登记表「在源码中找不到」判红', 'REGISTRY_STALE', m);
    }
  }
  // X9：扫描面缺 server.js / 文件无法解析 / 改 SQL 文字（哈希变化）
  { const m = new Map(faceFiles); m.delete(SRV); record('X9 扫描面缺 server.js', 'SCAN_FACE', m); }
  { const m = new Map(faceFiles); m.set('wbs-server/utils/model-restore.js', faceFiles.get('wbs-server/utils/model-restore.js') + '\n}}}{{{ syntax error'); record('X10 文件无法解析', 'PARSE', m); }
  {
    const src = faceFiles.get(SRV);
    const from = "SET status = 'DEVELOPING', updated_at";
    if (!src.includes(from)) results.push({ name: 'X11 改 SQL 文字 → 哈希变化', ok: false, detail: '跳过：锚点 SQL 不存在（跳过 = 失败）' });
    else { const m = new Map(faceFiles); m.set(SRV, src.replace(from, () => "SET status = 'DEVELOPING', domain = 'z', updated_at")); record('X11 改已登记写语句的 SQL 文字（哈希变化）→ 未登记', 'UNREGISTERED', m); }
  }
  // X12：登记表把 call 形态条目改成 inline（源码本句里没有 CONFIG_REV_BUMP_SQL 插值）→ 形态校验判红（改的是登记表，不是源码）
  {
    const reg = REGISTRY.map(e => (e.form === 'call' ? Object.assign({}, e, { form: 'inline' }) : e));
    let r;
    try { r = analyze(faceFiles, reg); } catch (e) { r = { issues: [], err: e.message }; }
    const hit = r.issues.filter(i => i.code === 'A_NO_BUMP');
    results.push({ name: 'X12 A 类递增形态与源码不符（call 改登记为 inline）', ok: hit.length >= 1, detail: hit.length ? hit[0].msg.slice(0, 160) : '未出现 A_NO_BUMP' });
  }
  // X13：MECH 只留给递增助手——把一条 A 类登记改成 MECH 必须判红（防止用 MECH 绕过门②）
  {
    let swapped = false;
    const reg = REGISTRY.map(e => { if (!swapped && e.cls === 'A') { swapped = true; return Object.assign({}, e, { cls: 'MECH' }); } return e; });
    const r = analyze(faceFiles, reg);
    const hit = r.issues.filter(i => i.code === 'REGISTRY_BAD' && /MECH/.test(i.msg));
    results.push({ name: 'X13 把 A 类登记改成 MECH（机制豁免只留给递增助手）', ok: swapped && hit.length >= 1, detail: hit.length ? hit[0].msg.slice(0, 160) : '未出现 REGISTRY_BAD(MECH)' });
  }
  // 预筛修复批新增：④兜底的全局搜索（别名 / WITH 前缀 / 多语句）与「求值后匹配」（转义 / 行续接 / \u 转义）
  const holeCase = (name, body, re) => record(name, 'SCAN_HOLE', appendRoute(faceFiles, body), i => re.test(i.msg));
  holeCase('H1 WITH 前缀的 UPDATE data_models AS m SET', 'db.run("WITH x AS (SELECT 1) UPDATE data_models AS m SET domain = \'x\' WHERE m.id = 1");', /UPDATE data_models AS m SET domain = 'x' WHERE m.id/);
  holeCase('H2 多语句字面量里的后一条 UPDATE data_models AS m SET（db.exec）', 'db.exec("SELECT 1; UPDATE data_models AS m SET domain = \'x\'");', /UPDATE data_models AS m SET domain = 'x'$/);
  holeCase('H3 \\n 转义把 UPDATE 与表名隔开（求值后是写语句，原文不是）', 'db.run("UPDATE\\ndata_models SET domain = \'x\'");', /转义/);
  holeCase('H4 反斜杠 + 换行的行续接拆开表名（data_\\<换行>models）', 'db.run("UPDATE data_\\\nmodels SET domain = \'x\'");', /转义/);
  holeCase('H5 \\u005f 转义拼出表名（data\\u005fmodels）', 'db.run("UPDATE data\\u005fmodels SET domain = \'x\'");', /转义/);
  holeCase('H6 \\\' 转义引号（单引号字符串里的 \\\'x\\\'，求值后与原文不一致——有意保守判红）', "db.run('UPDATE data_models SET domain = \\'x\\'');", /转义/);

  // codex 22G 修复：带引号 / 带 schema 限定 / 点号两侧空白的表名（主模式与④兜底都要识别）
  const selfRoute = i => i.key && i.key.includes('__mc_selftest__');
  record('Q1 UPDATE "main"."data_models" SET（双引号 schema + 表名）', 'UNREGISTERED', appendRoute(faceFiles, "db.run(`UPDATE \"main\".\"data_models\" SET domain = 'x' WHERE id = 1`);"), selfRoute);
  record('Q2 INSERT INTO `main`.`data_models`（反引号）', 'UNREGISTERED', appendRoute(faceFiles, "db.run(\"INSERT INTO `main`.`data_models` (table_name) VALUES ('x')\");"), selfRoute);
  record('Q3 DELETE FROM [main].[data_models]（方括号）', 'UNREGISTERED', appendRoute(faceFiles, "db.run('DELETE FROM [main].[data_models] WHERE id = 1');"), selfRoute);
  record('Q4 REPLACE INTO main . "data_models"（点号两侧空白 + 裸 schema）', 'UNREGISTERED', appendRoute(faceFiles, "db.run('REPLACE INTO main . \"data_models\" (id) VALUES (1)');"), selfRoute);
  record('Q5 UPDATE "main"."data_models" AS m SET（带引号 + 别名 → 扫描面洞）', 'SCAN_HOLE', appendRoute(faceFiles, "db.run(`UPDATE \"main\".\"data_models\" AS m SET domain = 'x'`);"), i => /"data_models" AS m SET/.test(i.msg));
  record('Q6 INSERT INTO `main`.`model_test_records` 缺 config_rev 列', 'TEST_RECORD_NO_REV', appendRoute(faceFiles, "db.run(\"INSERT INTO `main`.`model_test_records` (model_id, status) VALUES (1, 'x')\");"), i => /列清单不含 config_rev/.test(i.msg));
  record('Q7 INSERT INTO "main" . "model_test_records" 无列清单', 'TEST_RECORD_NO_REV', appendRoute(faceFiles, "db.run('INSERT INTO \"main\" . \"model_test_records\" SELECT * FROM model_test_records');"), i => /没有列清单/.test(i.msg));

  // codex 22G 修复：递增绑定级（inline / call）。先取真实代码里的 A 类目标，再对「同一处」做变异。
  {
    const inlineTarget = baseline.hits.find(h => h.entry && h.entry.cls === 'A' && h.entry.form === 'inline');
    const callTarget = baseline.hits.find(h => h.entry && h.entry.cls === 'A' && h.entry.form === 'call');
    const skip = (name, why) => results.push({ name, ok: false, detail: `跳过：${why}（跳过 = 失败）` });
    // 写点所在处理器 / 函数体：取 scope 内最大的函数节点，返回其 BlockStatement body 起点 + 1（在体首插声明，遮蔽体内全部引用）
    const handlerBodyStart = (src, scope) => {
      const p = parseSource(src);
      if (p.error) return -1;
      let best = null;
      const st = [p.ast];
      while (st.length) {
        const n = st.pop();
        if (!n || typeof n.type !== 'string') continue;
        if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression')
          && n.start >= scope.start && n.end <= scope.end && n.body.type === 'BlockStatement' && (!best || n.end - n.start > best.end - best.start)) best = n;
        for (const k of Object.keys(n)) {
          if (k === 'type' || k === 'start' || k === 'end') continue;
          const v = n[k];
          if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') st.push(c); }
          else if (v && typeof v.type === 'string') st.push(v);
        }
      }
      return best ? best.body.start + 1 : -1;
    };
    // 改了字面量内文本 → 哈希变化；先取新哈希重登记，再断言 A_NO_BUMP（否则只会报 UNREGISTERED，看不到绑定判定）
    const rehashRecord = (name, filesMut, target) => {
      const r1 = analyze(filesMut);
      const un = r1.issues.find(i => i.code === 'UNREGISTERED' && i.key && i.key.startsWith(`${target.file}|${target.where}|`));
      if (!un) { results.push({ name, ok: false, detail: `变异后哈希未变化，无法重登记：${JSON.stringify(r1.issues.map(i => i.code))}` }); return; }
      const newHash = un.key.split('|').pop();
      const reg = REGISTRY.map(e => (e.file === target.file && e.where === target.where && e.hash === target.hash ? Object.assign({}, e, { hash: newHash }) : e));
      const r2 = analyze(filesMut, reg);
      const hit = r2.issues.filter(i => i.code === 'A_NO_BUMP' && (i.key || '').includes(target.where));
      results.push({ name, ok: hit.length > 0, detail: hit.length ? hit[0].msg.slice(0, 160) : `未出现 A_NO_BUMP；实际 issues=${JSON.stringify(r2.issues.map(i => i.code))}` });
    };
    if (!inlineTarget) skip('I1–I3 inline 绑定级变异', '登记表里没有 inline 形态的 A 类条目');
    else {
      const src = faceFiles.get(inlineTarget.file);
      const seg = src.slice(inlineTarget.litStart, inlineTarget.litEnd);
      const from = '${CONFIG_REV_BUMP_SQL}';
      const variants = [
        ['I1 inline：插值改成 `${CONFIG_REV_BUMP_SQL && \'\'}`（非恰为标识符）', "${CONFIG_REV_BUMP_SQL && ''}"],
        ['I2 inline：插值改成 `${String(CONFIG_REV_BUMP_SQL).slice(0,0)}`', '${String(CONFIG_REV_BUMP_SQL).slice(0,0)}'],
      ];
      for (const [name, to] of variants) {
        if (!seg.includes(from)) { skip(name, `目标写点 [${inlineTarget.where}] 字面量里没有 ${from}`); continue; }
        const m = new Map(faceFiles);
        m.set(inlineTarget.file, src.slice(0, inlineTarget.litStart) + seg.replace(from, () => to) + src.slice(inlineTarget.litEnd));
        rehashRecord(name, m, inlineTarget);
      }
      const at = handlerBodyStart(src, inlineTarget.scope);
      if (at < 0) skip('I3 inline：局部 const CONFIG_REV_BUMP_SQL 遮蔽', `找不到目标处理器 [${inlineTarget.where}] 的函数体`);
      else {
        const m = new Map(faceFiles);
        m.set(inlineTarget.file, src.slice(0, at) + " const CONFIG_REV_BUMP_SQL = ''; " + src.slice(at));
        record('I3 inline：处理器体内局部 `const CONFIG_REV_BUMP_SQL = \'\'` 遮蔽（表达式文字不变，仍须判红）', 'A_NO_BUMP', m, i => (i.key || '').includes(inlineTarget.where));
      }
    }
    if (!callTarget) skip('C1–C2 call 绑定级变异', '登记表里没有 call 形态的 A 类条目');
    else {
      const src = faceFiles.get(callTarget.file);
      const seg = src.slice(callTarget.scope.start, callTarget.scope.end);
      const memberSeg = seg.replace(/(?<![.\w])bumpConfigRev\s*\(/g, 'db.bumpConfigRev(');
      if (memberSeg === seg) skip('C1 call：成员调用 db.bumpConfigRev(', `目标处理器 [${callTarget.where}] 内没有可替换的裸调用`);
      else {
        const m = new Map(faceFiles);
        m.set(callTarget.file, src.slice(0, callTarget.scope.start) + memberSeg + src.slice(callTarget.scope.end));
        record(`C1 call：处理器 [${callTarget.where}] 内的调用改成成员调用 db.bumpConfigRev(`, 'A_NO_BUMP', m, i => (i.key || '').includes(callTarget.where));
      }
      const at = handlerBodyStart(src, callTarget.scope);
      if (at < 0) skip('C2 call：局部同名函数遮蔽', `找不到目标处理器 [${callTarget.where}] 的函数体`);
      else {
        const m = new Map(faceFiles);
        m.set(callTarget.file, src.slice(0, at) + ' function bumpConfigRev() {} ' + src.slice(at));
        record('C2 call：处理器体内局部同名 `function bumpConfigRev() {}` 遮蔽（调用文字不变，仍须判红）', 'A_NO_BUMP', m, i => (i.key || '').includes(callTarget.where));
      }
    }
    // 绑定来源：require 路径改成别的模块 / 改成非 require 的对象字面量 → 全部 A 类判红
    {
      const src = faceFiles.get(SRV);
      const reqFrom = "require('./routes/model-center/config-rev')";
      if (!src.includes(reqFrom)) skip('B1/B2 绑定来源变异', `server.js 里找不到 ${reqFrom}`);
      else {
        const m1 = new Map(faceFiles); m1.set(SRV, src.replace(reqFrom, () => "require('./routes/model-center/config-rev-other')"));
        record('B1 server.js 的 config-rev require 路径改成别的模块 → A 类递增不被认可', 'A_NO_BUMP', m1);
        const m2 = new Map(faceFiles); m2.set(SRV, src.replace(reqFrom, () => '{}'));
        record('B2 server.js 的 config-rev require 换成对象字面量（绑定不来自 require）→ A 类递增不被认可', 'A_NO_BUMP', m2);
      }
    }
  }

  // codex 22R-G：A 类覆盖契约（③⁺）与路由写点作用域收窄
  {
    const cov = loadCoverage();
    const firstA = REGISTRY.find(e => e.cls === 'A');
    const addCase = (name, r, re) => {
      const hit = r.issues.filter(i => i.code === 'A_COVERAGE' && re.test(i.msg));
      results.push({ name, ok: hit.length > 0, detail: hit.length ? hit[0].msg.slice(0, 200) : `未出现预期的 A_COVERAGE；实际 issues=${JSON.stringify(r.issues.map(i => i.code))}` });
    };
    if (cov.error || !firstA) results.push({ name: 'V1/V2 覆盖契约变异', ok: false, detail: `跳过：${cov.error || '登记表没有 A 类条目'}（跳过 = 失败）` });
    else {
      // V1：登记表新增一条 A 类（覆盖契约里没有）
      addCase('V1 登记表新增一条 A 类（覆盖契约没有）→ 判红', analyze(faceFiles, REGISTRY.concat([Object.assign({}, firstA, { hash: 'ffffffffffff' })])), /登记表有 A 类条目但覆盖契约.*ffffffffffff/);
      // V2：覆盖契约多一条不存在的
      addCase('V2 覆盖契约多一条登记表里没有的 → 判红', analyze(faceFiles, REGISTRY, { entries: cov.entries.concat([{ file: firstA.file, route: 'GET /__nonexistent__', hash: 'eeeeeeeeeeee' }]) }), /覆盖契约.*有条目但登记表没有.*eeeeeeeeeeee/);
      // V3：覆盖契约少一条
      addCase('V3 覆盖契约少一条 → 判红', analyze(faceFiles, REGISTRY, { entries: cov.entries.slice(1) }), /登记表有 A 类条目但覆盖契约/);
      // V4：契约文件不可用（前提硬门）
      addCase('V4 覆盖契约文件不可用 / entries 为空 → 判红', analyze(faceFiles, REGISTRY, { error: '合成：entries 为空' }), /前提硬门/);
    }
    // W：同一路由的兄弟中间件里有 bumpConfigRev、写点所在处理器没有 → 判红；对照：递增调用在写点所在处理器里 → 不判红
    {
      const sibWhere = 'POST /__mc_sib__';
      const mk = (mw, handler) => {
        const m = new Map(faceFiles);
        m.set(SRV, faceFiles.get(SRV) + `\napp.post('/__mc_sib__', async (req, res, next) => { ${mw} next(); }, async (req, res) => { ${handler} db.run("UPDATE data_models SET domain = 'x' WHERE id = 1"); });\n`);
        return m;
      };
      const regFor = (m) => {
        const un = analyze(m).issues.find(i => i.code === 'UNREGISTERED' && (i.key || '').includes('__mc_sib__'));
        if (!un) return null;
        return REGISTRY.concat([{ cls: 'A', file: SRV, where: sibWhere, hash: un.key.split('|').pop(), why: '自证合成条目', form: 'call' }]);
      };
      const bad = mk('await bumpConfigRev(db, [1]);', '');
      const regBad = regFor(bad);
      if (!regBad) results.push({ name: 'W1 兄弟中间件里的 bumpConfigRev 不能让写点所在处理器通过', ok: false, detail: '跳过：合成路由未被扫到（跳过 = 失败）' });
      else {
        const r = analyze(bad, regBad);
        const hit = r.issues.filter(i => i.code === 'A_NO_BUMP' && (i.key || '').includes('__mc_sib__'));
        results.push({ name: 'W1 同一路由的兄弟中间件里有 bumpConfigRev、写点所在处理器没有 → 判红', ok: hit.length > 0, detail: hit.length ? hit[0].msg.slice(0, 200) : `未出现 A_NO_BUMP；实际 issues=${JSON.stringify(r.issues.map(i => i.code))}` });
      }
      const good = mk('', 'await bumpConfigRev(db, [1]);');
      const regGood = regFor(good);
      if (!regGood) results.push({ name: 'W2 对照：递增调用在写点所在处理器内 → 不判红', ok: false, detail: '跳过：合成路由未被扫到（跳过 = 失败）' });
      else {
        const r = analyze(good, regGood);
        const hit = r.issues.filter(i => i.code === 'A_NO_BUMP' && (i.key || '').includes('__mc_sib__'));
        results.push({ name: 'W2 对照：递增调用在写点所在处理器内 → 不判红', ok: hit.length === 0, detail: hit.length ? hit[0].msg.slice(0, 200) : '无 A_NO_BUMP（符合预期）' });
      }
    }
  }

  // codex 22G 修复：稀疏检出前提判定（合成 git 结果，不动真实 git 配置）
  {
    const inT = { status: 0, out: 'true\n', stderr: '' };
    const sp = (name, cfg, inside, wantOk) => {
      const j = judgeSparseOff(cfg, inside);
      results.push({ name, ok: j.ok === wantOk, detail: `${j.ok ? '通过' : '判红'}：${j.detail}` });
    };
    sp('S1 退出 0 且输出 false → 未开启（通过）', { status: 0, out: 'false\n', stderr: '' }, inT, true);
    sp('S2 退出 1 + stderr 空 + 在工作树内（配置项不存在）→ 通过', { status: 1, out: '', stderr: '' }, inT, true);
    sp('S3 退出 0 且输出 true → 判红', { status: 0, out: 'true\n', stderr: '' }, inT, false);
    sp('S4 退出 1 但有 stderr → 判红', { status: 1, out: '', stderr: 'error: bad config\n' }, inT, false);
    sp('S5 退出 128（非 0 / 1）→ 判红', { status: 128, out: '', stderr: 'fatal: not a git repository\n' }, inT, false);
    sp('S6 spawn 异常（status=null）→ 判红', { status: null, out: '', stderr: '', spawnError: 'spawn git ENOENT' }, inT, false);
    sp('S7 退出 1 + stderr 空 但不在工作树内 → 判红', { status: 1, out: '', stderr: '' }, { status: 0, out: 'false\n', stderr: '' }, false);
  }
  return results;
}

// ───────────────────────────── 主流程 ─────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const face = loadScanFace();
  let pass = 0, fail = 0;
  const check = (label, cond, detail) => {
    if (cond) { pass++; return; }
    fail++;
    console.log(`FAIL ${label}${detail === undefined ? '' : '\n' + detail}`);
  };
  for (const p of face.pre) check(p.label, p.ok, p.detail);
  check('git 可见文件列表可取', !face.error, face.error);
  if (face.error) { console.log(`verify-model-write-classification PASS=${pass} FAIL=${fail}`); process.exit(1); }

  check('扫描面非空且含 server.js（硬门）', face.files.size >= 1 && face.files.has(SRV), `files=${face.files.size}`);
  const base = analyze(face.files);

  if (argv.includes('--list')) {
    for (const h of base.hits) console.log(`${h.file}\t${h.where}\t${h.kind}\t${h.hash}\tL${h.line}\t${h.entry ? h.entry.cls : '-'}\t${h.sqlHead}`);
    console.log(`writes=${base.hits.length} testInserts=${base.testInserts.length} issues=${base.issues.length}`);
    for (const i of base.issues) console.log(`ISSUE ${i.code} ${i.msg}`);
    return;
  }

  const nA = REGISTRY.filter(e => e.cls === 'A').length, nB = REGISTRY.filter(e => e.cls === 'B').length, nM = REGISTRY.filter(e => e.cls === 'MECH').length;
  check(`登记表结构：A=${nA} B=${nB} MECH=${nM}，总数 = 扫描到的写入点数 ${base.hits.length}`, REGISTRY.length === base.hits.length, `registry=${REGISTRY.length} hits=${base.hits.length}`);
  for (const i of base.issues) check(`${i.code}`, false, i.msg);
  check('model_test_records INSERT 全部带 config_rev（且至少扫到 1 处，防扫描面落空）', base.testInserts.length >= 1 && base.testInserts.every(t => t.hasConfigRev), `testInserts=${base.testInserts.length}`);
  check('A 类条目全部判定为「处理器内有递增助手」', base.hits.filter(h => h.entry && h.entry.cls === 'A').every(h => h.bumped === true));

  if (argv.includes('--self-test')) {
    if (base.issues.length) { check('自证前提：基线必须全绿（否则变异判红无意义）', false, `基线 issues=${base.issues.length}`); }
    else {
      const results = runSelfTest(face.files, base);
      for (const r of results) {
        check(`变异自证 ${r.name} → 判红`, r.ok, r.detail);
        if (argv.includes('--verbose')) console.log(`  [${r.ok ? 'RED-OK' : 'NOT-RED'}] ${r.name} :: ${r.detail}`);
      }
      check(`变异自证共 ${results.length} 例，六个必答 M1–M6 均已执行`, ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'].every(p => results.some(r => r.name.startsWith(p + ' '))), results.map(r => r.name.slice(0, 3)).join(','));
    }
  }
  console.log(`verify-model-write-classification files=${face.files.size} writes=${base.hits.length} A=${nA} B=${nB} MECH=${nM} PASS=${pass} FAIL=${fail}${argv.includes('--self-test') ? ' (self-test)' : ''}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

if (require.main === module) main();
module.exports = { analyze, REGISTRY };
