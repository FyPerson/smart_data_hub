// 迁移脚本：sys_issues 受控重建——移除表级 CHECK (type <> 'config' OR release_id IS NULL)
//   真相源：docs/local/系统迭代/config流激活_方案_20260907_v1.0.md §5（六步 + 状态表 + 保存点探针）
//   铁律例外：项目记忆 sys_issues_rebuild_exception（用户 2026-09-07 授权，一次性、仅这一条 CHECK）
//   补丁 Y（Opus 预筛 3H/5M/8L）+ 补丁 Z（codex 507 审查 1C/1H/3M）+ 补丁 AA（codex 508 审查 1H/4M）+
//   补丁 AB（codex 509 审查 1H/4M）均已并入，详见文件内 [Y*]/[Z*]/[AA*]/[AB*] 标记。
//
// 用法：
//   node scripts/migrate-sys-issues-drop-config-release-check.js --db <path> [--apply] [--dry-run]
//        [--confirm-db <绝对路径>] [--stop-window-ack] [--register-fresh] [--report <path>]
//   默认 --dry-run（不带 --apply 即 dry-run：六步照跑，末尾 ROLLBACK，报告落盘）。
//
// ⚠️ 铁律（本文件与调用方共同遵守，见 S1b 派单 spec §0 / 补丁 Y/Z spec）：
//   - 目标库必须显式 --db；生产路径字面量（IP / 生产目录）永不出现在本文件或其输出里。
//   - [Y1/Z5] apply 于任何 basename 恰为 task_pool.db 的库（大小写不敏感、Windows 下先解析符号链接
//     再取 basename）须**双旗标**：`--confirm-db <绝对路径>`（须与 `--db` 解析后归一化路径一致，大小写
//     不敏感）+ `--stop-window-ack`；缺任一 → 抛错并列出缺哪个，不写库。`--dry-run` 免确认。
//   - [Z1] `--report` 与 `--db`/`<db>-journal`/`<db>-wal`/`<db>-shm`（大小写别名/同一文件身份）冲突 → 抛错
//     且**不打开数据库**；报告文件排他创建（`wx`），已存在即拒绝覆盖；报告目录不存在直接失败，不递归建。
//   - [Z2] COMMIT 成功后任何后续异常绝不导致 ROLLBACK 或误报"失败"；报告写入失败单独走 exitCode=3。
//   - apply 模式必须显式传 --report（不再有默认兜底路径）；dry-run 未传则落 `<db 同级目录>/migrate-report-<ts>.json`。
//   - 迁移脚本自己开一条专用连接（不复用 server 连接，J16），BEGIN IMMEDIATE 抢不到写锁 = 有其他写者 → 中止。
//
// 设计（对齐方案 §5 六步 / spec §1-1，补丁 Z 订正结构一致性判据）：
//   （标记 × 结构）状态表——sys_schema_migrations key=sys_issues_drop_config_release_check：
//     无标记∧CHECK存在 → 执行迁移（六步）
//     有标记∧CHECK不存在 → [Z3] 重算结构指纹与持久化指纹比对，不等→阻断 exit 2 并列差异；相等→退出 0
//     无标记∧CHECK不存在 → [Z3] 默认不登记（需 --register-fresh 显式登记指纹基线），无旗标输出"未登记"退出0不写库
//     有标记∧CHECK存在 → 标记与结构矛盾，阻断 exit 2，不作任何改动
//   六步（单事务，BEGIN IMMEDIATE 内）：
//     1 预检（integrity_check / foreign_key_check 基线 / 活库 DDL / 索引触发器动态捕获 / seq / 行数 / 列 /
//       逐行哈希 / [Y9] 视图盲区探测 / [Y10] sys_schema_migrations 存在性前移 / [Y11] journal_mode 记录）
//     2 DDL 手术（[Z4] 统一词法扫描器识别 CHECK 关键字与括号平衡，只在"普通代码"状态匹配——字符串/
//       分隔标识符内容与注释均不参与匹配；仅删目标 CHECK 子句 + 其相邻一个逗号，移除内容校验按
//       "去注释/去字符串噪音后的等效文本"比对，断言其余 CHECK 集合不变）
//     3 重建（CREATE __new → 列序断言 → INSERT SELECT 拷数据 → DROP → RENAME → 重建索引/触发器 → 恢复自增高水位）
//     4 探针（SAVEPOINT probe：夹具批次 + config+release_id 插入成功 → ROLLBACK TO probe + RELEASE probe）
//     5 后检（行数/列/索引触发器集合/CHECK集合/逐行哈希/序列(sys_issues+sys_releases 双表)/完整性/
//       FK([Y12] 多重集对拍) 全部与预检对拍）
//     6 [Z3] 计算结构指纹（PRAGMA table_info 全列属性 + 索引/触发器 sql 集合 + 其余 CHECK 文本集合，
//       稳定序列化后 sha256 + 明文结构对象）→ 若 sys_schema_migrations 无 structure_fingerprint 列则幂等
//       ALTER 加列 → 登记标记同一行（COMMIT 由 apply 决定，dry-run 则 ROLLBACK）
//   已迁移 / 新库两分支：[Y4] 探针前后各取一次快照（行数五表 + sys_issues/sys_releases 双 seq + sys_issues
//     逐行哈希）并断言相等；已迁移分支额外 [Z3] 结构指纹比对（不再只凭对象名集合+探针宣布"结构一致"）。
//
//   __testHooks：导出默认钩子对象，供 scripts/verify-sys-migrate-config-release-check.js 注入变异
//   （保留 CHECK / 删错约束 / 漏建索引 / 漏建触发器 / 序列回退 / 复制中断 / 保留CHECK+跳过探针 /
//   误删另一条表级CHECK / 探针不回滚 / [Z2] 模拟 COMMIT 失败 / 模拟报告写入失败），验证每种变异都被
//   结构断言判红且失败后事务整体回滚（库回到迁移前哈希）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

const MIGRATION_KEY = 'sys_issues_drop_config_release_check';
const TARGET_CHECK_CANONICAL = "CHECK (type <> 'config' OR release_id IS NULL)";
const CHILD_TABLES = ['sys_issue_timeline', 'sys_issue_attachments', 'sys_issue_dev_assignees', 'sys_issue_delete_audit'];
const RELEASES_TABLE = 'sys_releases';
const DEV_DB_BASENAME = 'task_pool.db';
const FINGERPRINT_COLUMN = 'structure_fingerprint';

// ══════════════════════════════════════════════════════════════════════════
// [Z4] 统一小型词法扫描器：普通代码 / 单引号字符串 / 双引号或反引号或方括号分隔标识符 / 行注释 / 块注释。
//   替代补丁 Y 版本"只认单引号+注释"的裸文本扫描——那一版对"逗号与目标 CHECK 之间夹注释"的场景会
//   把注释原文一并计入"移除内容"校验，导致规范化比对失败（补丁 Y 曾因此把 fixture 里的注释挪开
//   绕过，而不是修好算法本身；补丁 Z 要求把这条用例真正跑通，见 surgeryRemoveClause）。
// ══════════════════════════════════════════════════════════════════════════
function tokenizeSql(sql) {
  const segments = [];
  const n = sql.length;
  let i = 0;
  let curStart = 0;
  let curKind = 'code'; // code | string | ident_dq | ident_bt | ident_br | comment_line | comment_block
  function flush(end) {
    if (end > curStart) segments.push({ kind: curKind, start: curStart, end });
  }
  while (i < n) {
    const c = sql[i];
    if (curKind === 'code') {
      if (c === "'") { flush(i); curKind = 'string'; curStart = i; i++; continue; }
      if (c === '"') { flush(i); curKind = 'ident_dq'; curStart = i; i++; continue; }
      if (c === '`') { flush(i); curKind = 'ident_bt'; curStart = i; i++; continue; }
      if (c === '[') { flush(i); curKind = 'ident_br'; curStart = i; i++; continue; }
      if (c === '-' && sql[i + 1] === '-') { flush(i); curKind = 'comment_line'; curStart = i; i += 2; continue; }
      if (c === '/' && sql[i + 1] === '*') { flush(i); curKind = 'comment_block'; curStart = i; i += 2; continue; }
      i++; continue;
    }
    if (curKind === 'string') {
      if (c === "'") {
        if (sql[i + 1] === "'") { i += 2; continue; } // '' 转义
        i++; flush(i); curKind = 'code'; curStart = i; continue;
      }
      i++; continue;
    }
    if (curKind === 'ident_dq') {
      if (c === '"') {
        if (sql[i + 1] === '"') { i += 2; continue; } // "" 转义
        i++; flush(i); curKind = 'code'; curStart = i; continue;
      }
      i++; continue;
    }
    if (curKind === 'ident_bt') {
      if (c === '`') { i++; flush(i); curKind = 'code'; curStart = i; continue; }
      i++; continue;
    }
    if (curKind === 'ident_br') {
      if (c === ']') { i++; flush(i); curKind = 'code'; curStart = i; continue; }
      i++; continue;
    }
    if (curKind === 'comment_line') {
      if (c === '\n') { flush(i); curKind = 'code'; curStart = i; continue; }
      i++; continue;
    }
    if (curKind === 'comment_block') {
      if (c === '*' && sql[i + 1] === '/') { i += 2; flush(i); curKind = 'code'; curStart = i; continue; }
      i++; continue;
    }
    i++;
  }
  flush(n);
  return segments;
}

// 产出一份与原文本**同长度**的"扫描安全视图"：注释 → 等长空白（保留换行）；字符串/分隔标识符
// （含定界符本身）→ 等长 'x' 填充（既不是空白也不含括号/关键字，既不会被逗号邻接扫描误当空白跳过，
// 也不会让内部的 `)`/`CHECK(` 字面量污染括号平衡或关键字识别）；普通代码原样保留。
// 供 extractAllCheckClauses（括号平衡+CHECK识别）与 surgeryRemoveClause（逗号邻接扫描+移除内容校验）
// 共用同一份视图。
function blankOutComments(sql) {
  const segments = tokenizeSql(sql);
  let out = '';
  for (const seg of segments) {
    const text = sql.slice(seg.start, seg.end);
    if (seg.kind === 'comment_line' || seg.kind === 'comment_block') {
      out += text.replace(/[^\n]/g, ' ');
    } else if (seg.kind === 'string' || seg.kind === 'ident_dq' || seg.kind === 'ident_bt' || seg.kind === 'ident_br') {
      out += text.replace(/[^\n]/g, 'x');
    } else {
      out += text;
    }
  }
  return out;
}

function normWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// [AB1/AB2 · 509-H/509-M1] 目标表达式比较改为**词法 token 序列**比较，取代补丁 AA 的"整句 toLowerCase
//   后按字符串比较"（那一版会把字符串字面量也一并转小写：'CONFIG' 被折叠成 'config'，导致只有大写
//   字面量的约束 CHECK (type <> 'CONFIG' OR release_id IS NULL) 被误判为目标而删除——509-H high）。
//   规则：关键字/非引号标识符大小写不敏感（按小写归一比较）；字符串字面量与分隔标识符**精确比较**
//   （保留原始大小写，含定界符）；token 之间的空白与注释一律忽略（不产生 token）——因此无空格
//   （CHECK(type<>'config'...)）、多空格（CHECK  (  type  <>  ...)）、注释紧邻操作符
//   （type <>/*c*/'config'）均能正确命中（509-M1），块注释仍以首个 */ 结束、注释内的引号不赋予
//   任何转义语义（tokenizeSql 既有行为，未变更，见对应用例）。
function tokenizeForCompare(text) {
  const segments = tokenizeSql(text);
  const tokens = [];
  const wordRe = /[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g;
  for (const seg of segments) {
    const raw = text.slice(seg.start, seg.end);
    if (seg.kind === 'comment_line' || seg.kind === 'comment_block') continue; // 注释不产生 token
    if (seg.kind === 'string') { tokens.push('S:' + raw); continue; } // 含定界符，精确比较（大小写敏感）
    if (seg.kind === 'ident_dq' || seg.kind === 'ident_bt' || seg.kind === 'ident_br') { tokens.push('Q:' + raw); continue; } // 分隔标识符同样精确比较
    wordRe.lastIndex = 0;
    let m;
    while ((m = wordRe.exec(raw))) {
      const t = m[0];
      tokens.push(/^[A-Za-z0-9_]+$/.test(t) ? 'W:' + t.toLowerCase() : 'P:' + t);
    }
  }
  return tokens;
}

function tokensEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 提取 DDL 中全部顶层 CHECK(...) 子句（balanced-paren，正确跳过 typeof(x) 这类嵌套括号，且字符串/
// 标识符内的括号/关键字字面量已在 blanked 视图里被中性化，不会误判——补丁 Z·Z4）。
// [AA3/508-M2] 关键字识别改大小写不敏感 + 词边界（/\bcheck\b/i）：此前的 /CHECK\s*\(/ 只认大写，
//   小写/混合大小写的真实历史 DDL（人工改库、旧版本脚本生成）会漏检，导致这些子句既不参与
//   assertOtherChecksUnchanged 的前后集合对拍，也不会被误当作目标——是静默漏检而非误报。
function extractAllCheckClauses(blanked, original) {
  const clauses = [];
  const re = /\bcheck\b\s*\(/gi;
  let m;
  while ((m = re.exec(blanked))) {
    const openParenIdx = m.index + m[0].length - 1;
    let depth = 0;
    let j = openParenIdx;
    for (; j < blanked.length; j++) {
      if (blanked[j] === '(') depth++;
      else if (blanked[j] === ')') { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) throw new Error('extractAllCheckClauses：CHECK 子句括号不平衡，DDL 解析失败（阻断）');
    const end = j + 1;
    clauses.push({ start: m.index, end, text: original.slice(m.index, end) });
    re.lastIndex = end;
  }
  return clauses;
}

// [AB1/AB2 · 509-H/509-M1] 目标表达式比对改用 tokenizeForCompare 的 token 序列比较——目标 CHECK 内部
//   夹注释（如 CHECK (type <> 'config' /* 注 */ OR release_id IS NULL)）、多余/缺失空白、关键字大小写
//   差异（check/CHECK/Check）均能命中；但字符串字面量精确比较，CHECK (type <> 'CONFIG' OR ...) 这种
//   仅大写字面量不同的约束**不会**被误判为目标（509-H 修复点，取代补丁 AA 版本的整句 toLowerCase）。
function locateTargetCheck(originalDdl) {
  const blanked = blankOutComments(originalDdl);
  const clauses = extractAllCheckClauses(blanked, originalDdl);
  const canonicalTokens = tokenizeForCompare(TARGET_CHECK_CANONICAL);
  const matches = clauses.filter((c) => tokensEqual(tokenizeForCompare(c.text), canonicalTokens));
  if (matches.length === 0) return { found: false, clauses, blanked };
  if (matches.length > 1) throw new Error(`locateTargetCheck：目标 CHECK 子句在活库 DDL 中出现 ${matches.length} 次，无法唯一定位，阻断`);
  return { found: true, clause: matches[0], clauses, blanked };
}

// [AA3/508-M2] 在 (originalDdl, commentSegs) 上从 boundaryPos 沿 direction（-1=向前找前导逗号，
//   +1=向后找后随逗号）扫描：真实空白直接跳过；落在注释区间内则把整段注释当作一个不透明单元跳过
//   （既不当扫描噪音物理删除，也不在注释文本内误判逗号）；遇到真实逗号字符返回其位置；遇到其他任何
//   非空白/非注释内容说明这个方向没有相邻逗号，返回 -1。
function findAdjacentComma(text, commentSegs, boundaryPos, direction) {
  let i = direction === -1 ? boundaryPos - 1 : boundaryPos;
  while (i >= 0 && i < text.length) {
    const seg = commentSegs.find((s) => i >= s.start && i < s.end);
    if (seg) { i = direction === -1 ? seg.start - 1 : seg.end; continue; }
    const ch = text[i];
    if (/\s/.test(ch)) { i += direction; continue; }
    if (ch === ',') return i;
    return -1;
  }
  return -1;
}

// 移除目标子句 + 其相邻一个逗号（前导优先，找不到前导逗号才找后随逗号；均无则视为唯一表项，仅删子句本身）。
// [AA3/508-M2] 重写为"两段不相连删除区间"而非"一段连续删除区间"：逗号与目标 CHECK 之间若夹着行/块
//   注释（真实历史场景），旧版本（补丁 Z）会把逗号到子句之间的全部字符（含注释原文）当作一整段一并
//   物理删除，导致注释被误删（未满足"保留非目标注释"的原始建议）。新算法只精确删除【逗号字符本身】
//   与【子句字符本身】两个不相连的小区间，中间的注释与其周边空白原样保留在输出 DDL 中；findAdjacentComma
//   在寻找逗号时会跳过整段注释（不被其内容干扰、也不误删它），删除区间按起始位置降序依次应用于
//   originalDdl（降序保证已应用的删除不改变尚未处理的、位置更靠前的删除区间的下标含义）。
function surgeryRemoveClause(originalDdl, clause) {
  const commentSegs = tokenizeSql(originalDdl).filter((s) => s.kind === 'comment_line' || s.kind === 'comment_block');
  let mode;
  let deletions;
  const leadingCommaPos = findAdjacentComma(originalDdl, commentSegs, clause.start, -1);
  if (leadingCommaPos >= 0) {
    if (originalDdl[leadingCommaPos] !== ',') throw new Error('surgeryRemoveClause：内部错误，leadingCommaPos 未指向逗号，阻断');
    mode = 'leading-comma';
    deletions = [
      { start: leadingCommaPos, end: leadingCommaPos + 1 },
      { start: clause.start, end: clause.end },
    ];
  } else {
    const trailingCommaPos = findAdjacentComma(originalDdl, commentSegs, clause.end, +1);
    if (trailingCommaPos >= 0) {
      if (originalDdl[trailingCommaPos] !== ',') throw new Error('surgeryRemoveClause：内部错误，trailingCommaPos 未指向逗号，阻断');
      mode = 'trailing-comma';
      deletions = [
        { start: clause.start, end: clause.end },
        { start: trailingCommaPos, end: trailingCommaPos + 1 },
      ];
    } else {
      mode = 'no-comma';
      deletions = [{ start: clause.start, end: clause.end }];
    }
  }
  const orderedAsc = [...deletions].sort((a, b) => a.start - b.start);
  const removedText = orderedAsc.map((d) => originalDdl.slice(d.start, d.end)).join('');
  let surgeried = originalDdl;
  const orderedDesc = [...deletions].sort((a, b) => b.start - a.start);
  for (const d of orderedDesc) {
    surgeried = surgeried.slice(0, d.start) + surgeried.slice(d.end);
  }
  return { surgeried, mode, removedText };
}

function assertOtherChecksUnchanged(originalDdl, surgeriedDdl, targetClauseNorm) {
  const origClauses = extractAllCheckClauses(blankOutComments(originalDdl), originalDdl).map((c) => normWs(c.text));
  const newClauses = extractAllCheckClauses(blankOutComments(surgeriedDdl), surgeriedDdl).map((c) => normWs(c.text));
  if (origClauses.length - newClauses.length !== 1) {
    throw new Error(`assertOtherChecksUnchanged：CHECK 子句数量差异不为 1（原 ${origClauses.length} → 新 ${newClauses.length}），阻断`);
  }
  const origOthers = origClauses.filter((t) => t !== targetClauseNorm).sort();
  const newSorted = [...newClauses].sort();
  if (JSON.stringify(origOthers) !== JSON.stringify(newSorted)) {
    throw new Error('assertOtherChecksUnchanged：DDL 手术后其余 CHECK 子句集合发生变化，阻断');
  }
}

function renameCreateTableHeader(ddl, toName) {
  const re = /^CREATE TABLE(?:\s+IF NOT EXISTS)?\s+sys_issues\s*\(/;
  if (!re.test(ddl)) throw new Error('renameCreateTableHeader：无法定位 CREATE TABLE sys_issues 表头，阻断');
  return ddl.replace(re, `CREATE TABLE ${toName} (`);
}

// ══════════════════════════════════════════════════════════════════════════
// [Z1/Z5] 路径安全工具：--report 与 --db 及其伴生文件的冲突检测；basename 大小写/符号链接归一。
// ══════════════════════════════════════════════════════════════════════════

// 已存在的路径走 fs.realpathSync.native（解析符号链接/大小写归一到磁盘真实形态）；不存在的路径
// 退化为"父目录 realpath（若父目录也不存在则原样 resolve）+ 字面 basename"——仍保留大小写信息，
// 交给调用方按平台决定是否再 toLowerCase()。
function realpathOrResolve(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch (_e) {
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    try {
      const realDir = fs.realpathSync.native(dir);
      return path.join(realDir, base);
    } catch (_e2) {
      return abs;
    }
  }
}

// [AA4/508-M3] 平台相关的大小写归一抽成可注入 platform 参数的纯函数（默认 process.platform，测试可显式
//   传 'win32'/'linux' 两值，不依赖运行测试时机器的真实操作系统）——runMigration 内四处 basename/路径
//   大小写比较统一改调用 lowerIfWin32，避免各处各写一遍 `isWin ? x.toLowerCase() : x` 各自漂移。
function lowerIfWin32(s, platform = process.platform) {
  return platform === 'win32' ? String(s).toLowerCase() : String(s);
}

function normalizeForCompare(p, platform = process.platform) {
  const real = realpathOrResolve(p);
  return lowerIfWin32(real, platform);
}

// 两路径是否指向同一底层文件：优先 stat 的 dev+ino（两者都存在时最可靠，覆盖硬链接/junction 等
// realpath 未必能揭穿的形态）；任一不存在则退化为归一化路径字符串比较（覆盖"报告文件尚未创建，
// 但字面/大小写等价于 db 路径"的常见场景）。
function sameFileIdentity(a, b) {
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
    return false; // 两者都存在但确系不同文件——不必再退化到路径字符串比较（那样反而可能误判用途不同的同名文件不在同一目录的情形其实不冲突）
  } catch (_e) { /* 至少一个不存在，退化到路径比较 */ }
  return normalizeForCompare(a) === normalizeForCompare(b);
}

// [Z1] 打开数据库之前必须先调用：--report 不得与 --db 本身或其 -journal/-wal/-shm 伴生文件冲突
// （含大小写别名/同一文件身份），冲突 → 抛错，调用方保证此函数之后才 new sqlite3.Database(...)。
function assertReportPathSafe(dbAbsPath, reportPath) {
  const companions = [dbAbsPath, `${dbAbsPath}-journal`, `${dbAbsPath}-wal`, `${dbAbsPath}-shm`];
  for (const comp of companions) {
    if (sameFileIdentity(reportPath, comp)) {
      throw new Error(`--report 路径与 --db 或其伴生文件（本身/-journal/-wal/-shm）指向同一文件：「${reportPath}」≡「${comp}」，中止（不打开数据库）`);
    }
  }
}

// ── 数据库读写工具（专用连接，J16）────────────────────────────────────────────

// [AB3/509-M2] 打开数据库连接改用 Promise 包装的异步回调（此前 `new sqlite3.Database(absPath, mode)`
//   不传回调，预检通过后若发生删除/权限变化等竞态，异步打开失败没有任何东西在等它——不经过外层同步
//   try/catch，可能成为未处理的 'error' 事件，跳过预期的失败报告与返回值流程）。这里显式等待"打开成功"
//   这一事件后才返回 db 对象，供调用方继续 PRAGMA/占位；另给 db 挂一个 error 监听——即便只是为了让
//   EventEmitter 认为"该事件已被处理"（不这么做时，无监听的 'error' 事件会被 Node 当作未捕获异常抛出）。
//   `defaultHooks.openDatabase` 可被测试注入替换，覆盖"预检成功但打开失败"这类不易用真实文件复现的场景。
function openDatabaseDefault(absPath, mode) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const db = new sqlite3.Database(absPath, mode, (err) => {
      if (settled) return;
      settled = true;
      if (err) { reject(err); return; }
      resolve(db);
    });
    db.on('error', (err) => {
      if (settled) {
        // 打开已成功之后才触发的异步 error（例如运行期间的连接层异常）——Promise 早已 resolve，
        // 这里只做尽力记录，不重新抛出；监听器本身的存在已经避免了 Node 对无监听 'error' 事件的
        // 默认抛出行为。
        try { console.error(`[迁移脚本] 数据库连接 error 事件（打开已成功后触发）：${err.message}`); } catch (_e) { /* best-effort */ }
        return;
      }
      settled = true;
      reject(err);
    });
  });
}

function promisify(db) {
  const run = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
  const all = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
  const get = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
  return { run, all, get };
}

async function integrityOk(get) {
  const r = await get(`PRAGMA integrity_check`);
  return !!r && r.integrity_check === 'ok';
}

async function fkCheckRows(all) {
  const rows = await all(`PRAGMA foreign_key_check`);
  return rows.map((r) => JSON.stringify(r));
}

function multisetCounts(arr) {
  const m = new Map();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

function fkNewViolationsMultiset(preRows, postRows) {
  const preCounts = multisetCounts(preRows);
  const postCounts = multisetCounts(postRows);
  const newOnes = [];
  for (const [shape, postCount] of postCounts) {
    const preCount = preCounts.get(shape) || 0;
    if (postCount > preCount) {
      for (let k = 0; k < postCount - preCount; k++) newOnes.push(shape);
    }
  }
  return newOnes;
}

async function captureIndexTriggerRows(all) {
  return all(`SELECT type, name, sql FROM sqlite_master WHERE tbl_name='sys_issues' AND type IN ('index','trigger') ORDER BY type, name`);
}

async function captureUnknownTypes(all) {
  return all(`SELECT type, name FROM sqlite_master WHERE tbl_name='sys_issues' AND type NOT IN ('table','index','trigger')`);
}

async function checkNoDependentViews(all) {
  const rows = await all(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='view' AND sql LIKE '%sys_issues%'`);
  return rows && rows[0] ? rows[0].c : 0;
}

async function tableInfo(all, tableName) {
  return all(`PRAGMA table_info(${tableName})`);
}

function columnNameSeq(rows) {
  return rows.map((r) => r.name);
}

async function getSeq(get, name) {
  const row = await get(`SELECT seq FROM sqlite_sequence WHERE name=?`, [name]);
  return row ? row.seq : null;
}

async function getCounts(get) {
  const names = ['sys_issues', ...CHILD_TABLES, RELEASES_TABLE];
  const out = {};
  for (const n of names) {
    const r = await get(`SELECT COUNT(*) AS c FROM ${n}`);
    out[n] = r.c;
  }
  return out;
}

// [AA5/508-M4] tableName 泛化（默认 sys_issues，向后兼容既有单参调用）：按主键排序后逐行 JSON→sha256
//   汇总，行数只能证明"数量没少"，篡改单元格内容而不改行数不会被行数断言捕捉——四张子表同样复用本函数。
async function computeRowHash(all, tableName = 'sys_issues') {
  const cols = (await tableInfo(all, tableName)).map((c) => c.name);
  const rows = await all(`SELECT * FROM ${tableName} ORDER BY id`);
  const perRowHashes = rows.map((r) => crypto.createHash('sha256').update(JSON.stringify(cols.map((c) => r[c]))).digest('hex'));
  const agg = crypto.createHash('sha256').update(perRowHashes.join('\n')).digest('hex');
  return { agg, rowCount: rows.length };
}

// [AA5/508-M4] 四张子表各自的行内容哈希（不只是行数），供 snapshotProbeState 与 executeMigration
//   前/后检共用——子表在迁移六步中从未被直接写入（只有 sys_issues 被重建），理论上不该变化，
//   本函数让"理论上不该变化"变成一条可判红的显式断言，而不是隐式信任。
async function computeChildTableHashes(all) {
  const out = {};
  for (const t of CHILD_TABLES) {
    const h = await computeRowHash(all, t);
    out[t] = h.agg;
  }
  return out;
}

async function snapshotProbeState({ get, all }) {
  const counts = await getCounts(get);
  const seqIssues = await getSeq(get, 'sys_issues');
  const seqReleases = await getSeq(get, RELEASES_TABLE);
  const hash = await computeRowHash(all);
  const childHashes = await computeChildTableHashes(all);
  return { counts, seqIssues, seqReleases, rowHash: hash.agg, rowCount: hash.rowCount, childHashes };
}

function assertProbeSnapshotEqual(before, after, label) {
  const b = JSON.stringify(before);
  const a = JSON.stringify(after);
  if (b !== a) {
    throw new Error(`${label}：探针前后快照不一致（探针副作用未被完全撤销）。前=${b} 后=${a}，阻断`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// [Z3] 结构指纹：PRAGMA table_info 全列属性 + 索引/触发器 sql 集合 + 其余 CHECK 文本集合，
//   稳定序列化（排序 + JSON.stringify）后 sha256；明文结构对象一并返回，供持久化 json+diff。
// ══════════════════════════════════════════════════════════════════════════
async function computeStructureFingerprint(all) {
  const columns = (await tableInfo(all, 'sys_issues')).map((c) => ({
    name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }));
  const objectRows = await captureIndexTriggerRows(all);
  // [AA6/508 备注·510-L2 订正] 排序改 **UTF-16 码元序**（JS 字符串 `<`/`>` 比较的实际语义）而非
  //   localeCompare——localeCompare 依赖运行时 ICU/区域设置，同一份对象名集合在不同运行时/locale 下可能
  //   产生不同排序结果，进而让"同一结构"算出不同的稳定序列化 JSON、不同的 sha256（指纹跨机器/跨 Node
  //   版本不可比）。verify 脚本 [AA6] 组的三次重算只证明**新算法自洽**（逐字一致），不证明与旧算法结果
  //   一致——结构指纹列随本批（2026-09-07 S1b）首次引入、生产尚未迁移，**无旧指纹兼容要求**。码元序在任何
  //   运行时/locale 下都保证确定性，未来出现非 ASCII 对象名也不会漂移。
  const objects = objectRows
    .map((o) => ({ type: o.type, name: o.name, sql: normWs(o.sql || '') }))
    .sort((a, b) => {
      const ka = a.type + ':' + a.name;
      const kb = b.type + ':' + b.name;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const tableRows = await all(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
  const ddl = tableRows && tableRows[0] ? tableRows[0].sql : null;
  const otherChecks = ddl
    ? extractAllCheckClauses(blankOutComments(ddl), ddl).map((c) => normWs(c.text)).sort()
    : [];
  const stableObj = { columns, objects, otherChecks };
  const json = JSON.stringify(stableObj);
  const sha256 = crypto.createHash('sha256').update(json).digest('hex');
  return { sha256, stableObj };
}

async function ensureFingerprintColumn(all, run) {
  const cols = await tableInfo(all, 'sys_schema_migrations');
  const hasCol = cols.some((c) => c.name === FINGERPRINT_COLUMN);
  if (!hasCol) {
    await run(`ALTER TABLE sys_schema_migrations ADD COLUMN ${FINGERPRINT_COLUMN} TEXT`);
  }
  return hasCol;
}

function diffStructure(persisted, current) {
  const diffs = [];
  const persistedCols = new Map((persisted.columns || []).map((c) => [c.name, c]));
  const currentCols = new Map((current.columns || []).map((c) => [c.name, c]));
  for (const [name, pc] of persistedCols) {
    const cc = currentCols.get(name);
    if (!cc) { diffs.push(`缺列：${name}`); continue; }
    if (JSON.stringify(pc) !== JSON.stringify(cc)) diffs.push(`列属性变化：${name}（原=${JSON.stringify(pc)} 现=${JSON.stringify(cc)}）`);
  }
  for (const name of currentCols.keys()) {
    if (!persistedCols.has(name)) diffs.push(`新增列：${name}`);
  }
  const persistedObjMap = new Map((persisted.objects || []).map((o) => [`${o.type}:${o.name}`, o.sql]));
  const currentObjMap = new Map((current.objects || []).map((o) => [`${o.type}:${o.name}`, o.sql]));
  for (const [key, psql] of persistedObjMap) {
    if (!currentObjMap.has(key)) { diffs.push(`缺对象：${key}`); continue; }
    const csql = currentObjMap.get(key);
    if (csql !== psql) diffs.push(`对象定义变化：${key}`);
  }
  for (const key of currentObjMap.keys()) {
    if (!persistedObjMap.has(key)) diffs.push(`新增对象：${key}`);
  }
  const persistedChecks = new Set(persisted.otherChecks || []);
  const currentChecks = new Set(current.otherChecks || []);
  for (const c of persistedChecks) if (!currentChecks.has(c)) diffs.push(`缺 CHECK：${c}`);
  for (const c of currentChecks) if (!persistedChecks.has(c)) diffs.push(`新增 CHECK：${c}`);
  return diffs;
}

// ── 探针（503-H1）：SAVEPOINT 内插入 config+release_id，证明结构确已放行，随即撤销全部副作用 ──────
async function runProbe({ run, get }, hooks) {
  const shouldRollback = hooks && typeof hooks.shouldRollbackProbe === 'function' ? hooks.shouldRollbackProbe() : true;
  const releaseNo = `__migration_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  await run(`SAVEPOINT probe`);
  try {
    const relResult = await run(
      `INSERT INTO sys_releases (release_no, created_by, created_by_name) VALUES (?, 0, '__migration_probe__')`,
      [releaseNo]
    );
    const fixtureReleaseId = relResult.lastID;
    const issueResult = await run(
      `INSERT INTO sys_issues (type, status, title, system_name, created_by, created_by_name, intake_required, release_id)
       VALUES ('config', '__migration_probe_status__', '__migration_probe__', '__migration_probe__', 0, '__migration_probe__', 1, ?)`,
      [fixtureReleaseId]
    );
    const probeIssueId = issueResult.lastID;
    const check = await get(`SELECT type, release_id FROM sys_issues WHERE id=?`, [probeIssueId]);
    if (!check || check.type !== 'config' || check.release_id !== fixtureReleaseId) {
      throw new Error(`runProbe：探针插入后回读不一致 ${JSON.stringify(check)}`);
    }
  } finally {
    if (shouldRollback) {
      await run(`ROLLBACK TO probe`);
    }
    await run(`RELEASE probe`);
  }
}

async function verifyStructureConsistent({ run, all, get }, hooks) {
  const ok1 = await integrityOk(get);
  if (!ok1) throw new Error('verifyStructureConsistent：integrity_check 非 ok，阻断');
  const unknown = await captureUnknownTypes(all);
  if (unknown.length) throw new Error(`verifyStructureConsistent：sys_issues 关联对象存在未知类型 ${JSON.stringify(unknown)}，阻断`);

  const before = await snapshotProbeState({ get, all });
  await runProbe({ run, get }, hooks);
  const after = await snapshotProbeState({ get, all });
  assertProbeSnapshotEqual(before, after, 'verifyStructureConsistent 探针对拍');

  return { integrityOk: ok1, probeSnapshot: after };
}

// ── 默认钩子（变异注入点，测试专用；生产路径下恒等于直通默认值）─────────────────────────────
const defaultHooks = {
  chooseNewTableDdl: (ctx) => ctx.surgeriedDdl,
  chooseCopyStatement: (ctx) => ctx.defaultSql,
  chooseRebuildStatements: (ctx) => ctx.statements,
  chooseSeqRestoreValue: (ctx) => ctx.computedSeq,
  shouldRunProbe: () => true,
  shouldRollbackProbe: () => true,
  // [Z2] 测试专用：COMMIT 前抛错（走 ROLLBACK 分支）/ 报告写入模拟失败（committed 已为 true 后触发）。
  simulateCommitFailure: () => false,
  simulateReportWriteFailure: () => false,
  // [AA5/508-M4] 测试专用：重建完成后（探针前）对某张子表做一次篡改，默认无操作——生产路径下迁移
  //   六步从不直接写子表，本钩子仅用于验证"子表内容哈希"这道新增后检真的会判红（而非只是摆设）。
  mutateChildTableAfterRebuild: async () => {},
  // [AB3/509-M2] 打开数据库连接的工厂，默认即真实实现；测试可整体替换以模拟"预检通过但打开失败"
  //   （不易用真实文件系统复现的场景，如竞态删除/权限中途变化）。
  openDatabase: (absPath, mode) => openDatabaseDefault(absPath, mode),
};

// ── 六步执行（单事务内；抛错即整体回滚由外层 catch 处理）─────────────────────────────────────
async function executeMigration({ run, all, get, hooks, originalDdl, locateResult, stepLog, migTableExists }) {
  // ---- 1 预检 ----
  if (!migTableExists) {
    throw new Error('1-预检：sys_schema_migrations 表不存在，无法登记标记，提前阻断（不做无谓的后续步骤）');
  }
  const preIntegrity = await integrityOk(get);
  if (!preIntegrity) throw new Error('1-预检：integrity_check 非 ok，阻断，不执行迁移');
  const preFk = await fkCheckRows(all);
  const unknownTypes = await captureUnknownTypes(all);
  if (unknownTypes.length) throw new Error(`1-预检：sys_issues 关联对象存在未知类型 ${JSON.stringify(unknownTypes)}，阻断`);
  const viewCount = await checkNoDependentViews(all);
  if (viewCount > 0) throw new Error(`1-预检：检测到 ${viewCount} 个引用 sys_issues 的视图，DROP 前阻断（视图会在 RENAME 后失效，需先处理）`);
  const journalModeRow = await get(`PRAGMA journal_mode`);
  const journalMode = journalModeRow ? journalModeRow.journal_mode : null;
  const preObjRows = await captureIndexTriggerRows(all);
  const preSeq = await getSeq(get, 'sys_issues');
  const preSeqReleases = await getSeq(get, RELEASES_TABLE);
  const preMaxIdRow = await get(`SELECT MAX(id) AS m FROM sys_issues`);
  const preMaxId = preMaxIdRow ? preMaxIdRow.m : null;
  const preCounts = await getCounts(get);
  const preColumns = await tableInfo(all, 'sys_issues');
  const preColNames = columnNameSeq(preColumns);
  const preHash = await computeRowHash(all);
  const preChildHashes = await computeChildTableHashes(all); // [AA5/508-M4]
  stepLog('1-precheck', null, {
    preIntegrity, viewCount, journalMode, preFkCount: preFk.length, preObjCount: preObjRows.length, preObjNames: preObjRows.map((r) => `${r.type}:${r.name}`),
    preSeq, preSeqReleases, preMaxId, preCounts, preColCount: preColNames.length, preRowHash: preHash.agg, preRowCount: preHash.rowCount, preChildHashes,
  }, '预检完成（integrity/FK基线/DDL对象动态捕获/视图盲区/journal_mode/序列双表/行数/列序/逐行哈希（含四子表内容哈希）/迁移标记表存在性）');

  // ---- 2 DDL 手术 ----
  const target = locateResult.clause;
  const surgery = surgeryRemoveClause(originalDdl, target);
  const targetNorm = normWs(target.text);
  assertOtherChecksUnchanged(originalDdl, surgery.surgeried, targetNorm);
  const newTableDdlDefault = renameCreateTableHeader(surgery.surgeried, 'sys_issues__new');
  stepLog('2-ddl-surgery', { mode: surgery.mode, removed: surgery.removedText }, { newTableDdlLen: newTableDdlDefault.length }, 'DDL 手术（词法扫描器）：仅移除目标 CHECK 子句（+相邻单个逗号），断言其余 CHECK 集合不变，表头改名 __new');

  const ddlForCreate = hooks.chooseNewTableDdl({
    originalDdl, surgeriedDdl: newTableDdlDefault, targetClauseText: target.text, allChecksBefore: preObjRows,
  });

  // ---- 3 重建：CREATE __new → 列序断言 → 拷数据 → DROP → RENAME → 重建索引/触发器 → 恢复自增高水位 ----
  await run(ddlForCreate);
  const newColumns = await tableInfo(all, 'sys_issues__new');
  const newColNames = columnNameSeq(newColumns);
  if (JSON.stringify(newColNames) !== JSON.stringify(preColNames)) {
    throw new Error(`3-重建：新表 sys_issues__new 列名序列与原表不一致：原=${JSON.stringify(preColNames)} 新=${JSON.stringify(newColNames)}，阻断`);
  }

  const copySql = hooks.chooseCopyStatement({ defaultSql: `INSERT INTO sys_issues__new SELECT * FROM sys_issues ORDER BY id` });
  await run(copySql);
  const copiedCount = (await get(`SELECT COUNT(*) AS c FROM sys_issues__new`)).c;

  await run(`DROP TABLE sys_issues`);
  await run(`ALTER TABLE sys_issues__new RENAME TO sys_issues`);

  const rebuildStatements = hooks.chooseRebuildStatements({ statements: preObjRows.slice() });
  for (const stmt of rebuildStatements) {
    if (stmt.sql == null) continue;
    await run(stmt.sql);
  }

  const computedSeqRestore = Math.max(preSeq || 0, preMaxId || 0);
  const seqRestoreValue = hooks.chooseSeqRestoreValue({ originalSeq: preSeq, maxId: preMaxId, computedSeq: computedSeqRestore });
  const existingSeqRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_issues'`);
  if (existingSeqRow) {
    await run(`UPDATE sqlite_sequence SET seq=? WHERE name='sys_issues'`, [seqRestoreValue]);
  } else {
    await run(`INSERT INTO sqlite_sequence (name, seq) VALUES ('sys_issues', ?)`, [seqRestoreValue]);
  }
  stepLog('3-rebuild', { copiedCount, computedSeqRestore, seqRestoreValueUsed: seqRestoreValue, rebuiltObjCount: rebuildStatements.filter(s => s.sql != null).length },
    null, '重建表（CREATE __new→INSERT SELECT→DROP→RENAME）+ 按预检捕获的 sql 逐条重建索引/触发器 + 恢复自增高水位 seq=max(原seq,max(id))');

  // [AA5/508-M4] 测试专用注入点：默认无操作，仅测试可注入子表篡改，验证下方"5-后检"的子表内容哈希
  //   真的会判红（篡改发生在同一事务内，后检失败后整体 ROLLBACK 会一并撤销）。
  await hooks.mutateChildTableAfterRebuild({ run, get, all });

  // ---- 4 探针 ----
  const runProbeThisTime = hooks && typeof hooks.shouldRunProbe === 'function' ? hooks.shouldRunProbe() : true;
  if (runProbeThisTime) {
    await runProbe({ run, get }, hooks);
    stepLog('4-probe', null, null, '保存点探针：夹具批次 + config+release_id 插入成功 → ROLLBACK TO probe + RELEASE probe（撤销全部副作用）');
  } else {
    stepLog('4-probe-skipped', null, null, '[钩子注入] shouldRunProbe=false，本次跳过探针（仅测试用，验证后检独立判红能力）');
  }

  // ---- 5 后检（保存点释放后）----
  const postCounts = await getCounts(get);
  for (const k of Object.keys(preCounts)) {
    if (postCounts[k] !== preCounts[k]) throw new Error(`5-后检：表 ${k} 行数不一致，前=${preCounts[k]} 后=${postCounts[k]}，阻断`);
  }
  const postColumns = await tableInfo(all, 'sys_issues');
  if (JSON.stringify(postColumns) !== JSON.stringify(preColumns)) {
    throw new Error('5-后检：table_info 逐列不一致，阻断');
  }
  const postObjRows = await captureIndexTriggerRows(all);
  const normObjSet = (rows) => rows.map((r) => `${r.type}:${r.name}:${normWs(r.sql || '')}`).sort();
  const preObjSetStr = JSON.stringify(normObjSet(preObjRows));
  const postObjSetStr = JSON.stringify(normObjSet(postObjRows));
  if (postObjSetStr !== preObjSetStr) {
    throw new Error(`5-后检：索引/触发器集合与预检不一致。前=${preObjSetStr} 后=${postObjSetStr}，阻断`);
  }
  const postTableRow = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
  if (!postTableRow || !postTableRow.sql) throw new Error('5-后检：sqlite_master 中找不到重建后的 sys_issues 表，阻断');
  const postLocate = locateTargetCheck(postTableRow.sql);
  if (postLocate.found) throw new Error('5-后检：目标 CHECK 仍存在于重建后 sys_issues DDL 中，阻断');
  assertOtherChecksUnchanged(originalDdl, postTableRow.sql, targetNorm);
  const postHash = await computeRowHash(all);
  if (postHash.agg !== preHash.agg) throw new Error(`5-后检：逐行哈希不一致，前=${preHash.agg} 后=${postHash.agg}，阻断`);
  // [AA5/508-M4] 子表内容哈希：行数相等不代表内容未变（单元格被篡改、行数不变时行数断言无法察觉），
  //   逐张子表按主键排序后比对内容哈希，弥补这个盲区。
  const postChildHashes = await computeChildTableHashes(all);
  for (const t of CHILD_TABLES) {
    if (postChildHashes[t] !== preChildHashes[t]) {
      throw new Error(`5-后检：子表 ${t} 内容哈希不一致（行数可能相同但内容被篡改），前=${preChildHashes[t]} 后=${postChildHashes[t]}，阻断`);
    }
  }
  const postSeqRow = await get(`SELECT seq FROM sqlite_sequence WHERE name='sys_issues'`);
  const expectedSeq = Math.max(preSeq || 0, preMaxId || 0);
  if (!postSeqRow || postSeqRow.seq !== expectedSeq) {
    throw new Error(`5-后检：sqlite_sequence.seq(sys_issues)=${postSeqRow ? postSeqRow.seq : null}，期望 max(原seq,max(id))=${expectedSeq}，阻断`);
  }
  const postSeqReleases = await getSeq(get, RELEASES_TABLE);
  if (postSeqReleases !== preSeqReleases) {
    throw new Error(`5-后检：sqlite_sequence.seq(sys_releases) 不一致，前=${preSeqReleases} 后=${postSeqReleases}，阻断（探针在 sys_releases 上的插入应已随 ROLLBACK TO probe 撤销）`);
  }
  const postIntegrity = await integrityOk(get);
  if (!postIntegrity) throw new Error('5-后检：integrity_check 非 ok，阻断');
  const postFk = await fkCheckRows(all);
  const newViolations = fkNewViolationsMultiset(preFk, postFk);
  if (newViolations.length) throw new Error(`5-后检：foreign_key_check 出现新增违规（多重集比对）${JSON.stringify(newViolations)}，阻断`);
  stepLog('5-postcheck', null, {
    postIntegrity, postFkNewViolations: newViolations.length, postRowHash: postHash.agg, postChildHashes, postSeq: postSeqRow.seq, postSeqReleases, postObjCount: postObjRows.length,
  }, '后检：行数/列/索引触发器集合/CHECK集合(真实DDL文本二次核)/逐行哈希(含四子表内容哈希)/序列(双表)/完整性/FK(多重集) 全部与预检对拍通过');

  // ---- 6 [Z3] 计算结构指纹 + 幂等补列 + 登记标记（COMMIT/ROLLBACK 由外层依据 apply 决定）----
  const hadFpCol = await ensureFingerprintColumn(all, run);
  const fp = await computeStructureFingerprint(all);
  await run(
    `INSERT INTO sys_schema_migrations (migration_key, applied_at, ${FINGERPRINT_COLUMN}) VALUES (?, datetime('now','localtime'), ?)`,
    [MIGRATION_KEY, JSON.stringify({ sha256: fp.sha256, structure: fp.stableObj })]
  );
  stepLog('6-register-mark', { fingerprintColumnPreexisting: hadFpCol }, { migrationKey: MIGRATION_KEY, structureFingerprintSha256: fp.sha256 },
    hadFpCol ? '登记迁移标记 + 结构指纹（列已存在）' : `登记迁移标记 + 结构指纹（幂等 ALTER TABLE sys_schema_migrations ADD COLUMN ${FINGERPRINT_COLUMN} TEXT 新增该列）`);

  return { mode: 'executed', message: '迁移六步全部通过（预检/DDL手术/重建/探针/后检/登记标记+结构指纹）' };
}

async function runInsideTxn({ run, all, get, hooks, stepLog, registerFresh }) {
  const migTableRow = await get(`SELECT name FROM sqlite_master WHERE type='table' AND name='sys_schema_migrations'`);
  const migTableExists = !!migTableRow;
  let markRow = null;
  if (migTableExists) {
    const cols = await tableInfo(all, 'sys_schema_migrations');
    const hasFpCol = cols.some((c) => c.name === FINGERPRINT_COLUMN);
    markRow = await get(
      hasFpCol
        ? `SELECT migration_key, applied_at, ${FINGERPRINT_COLUMN} FROM sys_schema_migrations WHERE migration_key=?`
        : `SELECT migration_key, applied_at FROM sys_schema_migrations WHERE migration_key=?`,
      [MIGRATION_KEY]
    );
  }
  const hasMark = !!markRow;

  const tableRow = await get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='sys_issues'`);
  if (!tableRow || !tableRow.sql) throw new Error('sqlite_master 中找不到 sys_issues 表，阻断');
  const originalDdl = tableRow.sql;
  const locate = locateTargetCheck(originalDdl);
  const checkExists = locate.found;

  stepLog('0-state-table-lookup', { hasMark, appliedAt: markRow ? markRow.applied_at : null, migTableExists }, { checkExists },
    '标记 × 结构状态表读取（sys_schema_migrations key=' + MIGRATION_KEY + '）');

  if (hasMark && checkExists) {
    return { abortCode: 2, mode: 'contradiction', message: '标记存在但目标 CHECK 仍在活库 DDL 中——标记与结构矛盾，阻断（不作任何改动）' };
  }
  if (hasMark && !checkExists) {
    // [Z3] 已迁移分支：不再只凭探针+对象名集合宣布"结构验证一致"——重算结构指纹，与登记时持久化
    //   的指纹逐字比对，不等 → 阻断 exit 2 并列出差异（缺触发器/缺索引/列属性变化各自可读）。
    const r = await verifyStructureConsistent({ run, all, get }, hooks);
    const currentFp = await computeStructureFingerprint(all);
    const persistedRaw = markRow[FINGERPRINT_COLUMN];
    if (!persistedRaw) {
      return {
        abortCode: 2, mode: 'contradiction',
        message: '已迁移分支：登记行缺持久化结构指纹（可能由不含 Z3 的旧版本脚本登记），无法核对结构一致性，阻断——需人工核实后重新登记',
      };
    }
    let persisted;
    try { persisted = JSON.parse(persistedRaw); } catch (e) {
      return { abortCode: 2, mode: 'contradiction', message: `已迁移分支：持久化结构指纹 JSON 解析失败（${e.message}），阻断` };
    }
    if (persisted.sha256 !== currentFp.sha256) {
      const diffs = diffStructure(persisted.structure, currentFp.stableObj);
      return {
        abortCode: 2, mode: 'contradiction',
        message: `已迁移分支：结构指纹不匹配（结构漂移，${diffs.length} 项差异）：${diffs.join('；') || '（无法枚举具体差异，仅哈希不同）'}`,
      };
    }
    stepLog('verify-already-migrated', null, { ...r, fingerprintSha256: currentFp.sha256, fingerprintMatched: true },
      '已迁移分支：integrity_check + 探针插入验证通过（含探针前后快照对拍）+ 结构指纹比对一致，无需变更');
    return { mode: 'already-migrated', message: '标记存在且目标 CHECK 已不在，结构验证一致（探针通过 + 结构指纹比对一致），无需变更' };
  }
  if (!hasMark && !checkExists) {
    // [Z3] 新库分支：默认不自动登记——除非显式 --register-fresh，且把当时指纹持久化。
    const r = await verifyStructureConsistent({ run, all, get }, hooks);
    if (!registerFresh) {
      stepLog('verify-fresh-db-unregistered', null, r, '新库分支：integrity_check + 探针插入验证通过，但未带 --register-fresh，不登记标记（结构未核对基线，需人工确认后显式登记）');
      return { mode: 'fresh-db-unregistered', message: '结构未核对·未登记（新库需显式 --register-fresh 才登记标记+指纹基线）', forceRollback: true };
    }
    if (!migTableExists) throw new Error('新库分支：sys_schema_migrations 表不存在，无法登记标记，阻断');
    const hadFpCol = await ensureFingerprintColumn(all, run);
    const fp = await computeStructureFingerprint(all);
    await run(
      `INSERT INTO sys_schema_migrations (migration_key, applied_at, ${FINGERPRINT_COLUMN}) VALUES (?, datetime('now','localtime'), ?)`,
      [MIGRATION_KEY, JSON.stringify({ sha256: fp.sha256, structure: fp.stableObj })]
    );
    stepLog('verify-fresh-db-registered', { fingerprintColumnPreexisting: hadFpCol }, { ...r, fingerprintSha256: fp.sha256 },
      '新库分支：--register-fresh 已带，结构验证一致，登记迁移标记 + 结构指纹基线');
    return { mode: 'fresh-db-register', message: '新库（未带该 CHECK）结构验证一致，登记迁移标记 + 结构指纹基线' };
  }

  // hasMark===false && checkExists===true → 执行迁移
  return executeMigration({ run, all, get, hooks, originalDdl, locateResult: locate, stepLog, migTableExists });
}

async function runMigration(opts) {
  const {
    dbPath,
    apply = false,
    reportPath,
    hooks: userHooks = {},
    confirmDb = null,
    stopWindowAck = false,
    registerFresh = false,
  } = opts || {};
  if (!dbPath) throw new Error('runMigration：缺少 dbPath');
  const hooks = Object.assign({}, defaultHooks, userHooks);

  const absPath = path.resolve(dbPath);

  // [AA1/508-H] --db 预检：必须先于任何报告占位/数据库打开发生——否则 sqlite3 默认（OPEN_CREATE）会在
  //   路径不存在时静默建出一个空库文件，报告占位也会跟着落地成一个没有真正诊断价值的孤立文件。目录/
  //   不存在/无权限访问统一归为同一错误文案（对操作员而言处置动作相同：先核实路径），不建任何文件。
  let dbStat;
  try {
    dbStat = fs.statSync(absPath);
  } catch (_e) {
    throw new Error(`目标库不存在或非普通文件：${absPath}`);
  }
  if (!dbStat.isFile()) {
    throw new Error(`目标库不存在或非普通文件：${absPath}`);
  }

  // [Z5/AA4] Windows 下先解析符号链接再取 basename，大小写不敏感比较；大小写归一统一走 lowerIfWin32
  //   （可注入 platform 参数的纯函数，见 _internals 导出与 verify 脚本平台无关单测）。
  const absPathReal = realpathOrResolve(absPath);
  const baseName = path.basename(absPathReal);
  const baseNameCmp = lowerIfWin32(baseName);
  const devBaseNameCmp = lowerIfWin32(DEV_DB_BASENAME);

  // [Y1/Z5] apply 于 basename=task_pool.db（大小写不敏感）的库须双旗标。
  if (apply && baseNameCmp === devBaseNameCmp) {
    const missing = [];
    if (!confirmDb) missing.push('--confirm-db <绝对路径>');
    if (!stopWindowAck) missing.push('--stop-window-ack');
    if (missing.length) {
      throw new Error(`目标库文件名为 ${DEV_DB_BASENAME}：apply 需要双旗标确认，缺：${missing.join('、')}——不写库`);
    }
    const confirmReal = realpathOrResolve(path.resolve(confirmDb));
    const confirmCmp = lowerIfWin32(confirmReal);
    const absCmp = lowerIfWin32(absPathReal);
    if (confirmCmp !== absCmp) {
      throw new Error(`--confirm-db 与 --db 解析后的绝对路径不一致：--db 解析为「${absPathReal}」，--confirm-db 解析为「${confirmReal}」——不写库`);
    }
  }
  if (apply && !reportPath) {
    throw new Error('apply 模式必须显式传 --report <path>（无默认路径兜底）');
  }

  // [Z1] --report 冲突校验：必须在打开数据库连接之前完成（纯路径比较，无 I/O 创建副作用）。
  const finalReportPath = reportPath || path.join(path.dirname(absPath), `migrate-report-${Date.now()}.json`);
  assertReportPathSafe(absPath, finalReportPath);

  // [AA1/508-H] 报告排他创建（wx）改到"数据库连接确认可用之后"再占位（仍在 BEGIN 之前完成，满足 Z1
  //   「排他创建报告在 BEGIN 之前」的要求）——而不是像先前版本那样在打开数据库连接之前就占位。二选一
  //   取这种：若预检通过后连接仍然失败（如权限被拒），报告文件此时还未被创建，不会遗留一个"占位但
  //   内容为空"的孤儿文件；真正需要诊断信息时（如目标文件是普通文件但不是合法 sqlite 库），claimReportFd
  //   会在下方"报告写入"阶段兜底占位并如实写入失败原因，不丢失可诊断性。
  let reportFd = null;
  function claimReportFd() {
    if (reportFd !== null) return reportFd;
    try {
      reportFd = fs.openSync(finalReportPath, 'wx');
    } catch (e) {
      throw new Error(`报告文件排他创建失败（可能已存在，或所在目录不存在——不递归建目录）：${finalReportPath}：${e.message}`);
    }
    return reportFd;
  }

  const report = {
    dbBaseName: baseName,
    startedAt: new Date().toISOString(),
    apply: !!apply,
    steps: [],
    result: null,
    committed: false,
    reportPath: finalReportPath,
  };
  const stepLog = (name, before, after, note) => {
    report.steps.push({ name, before, after, note, at: new Date().toISOString() });
  };

  // [Z2] 三阶段分离：提交结果（committed 一旦为 true 永不回退）/ 连接关闭（独立 finally，失败只记 stderr）/
  //   报告写入（committed 后失败走独立 exitCode=3，不递归重调本函数）。
  let db = null;
  let committed = false;
  let outcome = null;
  let txnOrConnError = null;

  try {
    // [AA1/508-H] 只用 OPEN_READWRITE，不带 OPEN_CREATE——双保险：即便预检和实际打开之间发生竞态
    //   （文件被删除/替换），sqlite3 也不会静默建出一个新的空库文件，而是直接报"无法打开"错误。
    // [AB3/509-M2] 经 hooks.openDatabase（默认 openDatabaseDefault）打开——Promise 化等待打开成功，
    //   失败会在这里被 await 抛出，走下方统一的 catch(connErr) 分支，不会成为未处理的 error 事件。
    db = await hooks.openDatabase(absPath, sqlite3.OPEN_READWRITE);
    const { run, all, get } = promisify(db);
    await run(`PRAGMA busy_timeout=5000`);
    // foreign_keys 必须在事务外设置（SQLite：事务内该 PRAGMA 是 no-op）。
    await run(`PRAGMA foreign_keys=OFF`);
    const fkState = await get(`PRAGMA foreign_keys`);
    if (!fkState || Number(fkState.foreign_keys) !== 0) {
      throw new Error(`PRAGMA foreign_keys=OFF 设置后校验失败，当前值=${JSON.stringify(fkState)}`);
    }
    stepLog('pragma-foreign-keys-off', null, fkState, '设置并校验 foreign_keys=OFF（BEGIN 之前）');

    // [AA1/Z1] 报告占位放到这里：连接与基础 pragma 均已确认可用，且仍在 BEGIN 之前完成排他创建。
    claimReportFd();

    try {
      await run(`BEGIN IMMEDIATE`);
    } catch (e) {
      // [主会话 AA-③ 演练订正] SQLITE_NOTADB（--db 是普通文件但不是 SQLite 库）与「写锁被占」是两种根因，
      //   原统一前缀「疑似另一连接持有写锁」对前者是误导——按 err.code 分类，操作员一眼可辨。
      if (e && e.code === 'SQLITE_NOTADB') {
        throw new Error(`目标文件不是 SQLite 数据库（${e.message}）——请核对 --db 路径`);
      }
      throw new Error(`BEGIN IMMEDIATE 失败（疑似另一连接持有写锁，未断言到独占写权限）：${e.message}`);
    }

    try {
      outcome = await runInsideTxn({ run, all, get, hooks, stepLog, registerFresh });
      if (outcome.abortCode !== undefined || outcome.forceRollback) {
        await run(`ROLLBACK`);
      } else if (apply) {
        // [Z2] COMMIT-FAIL 测试钩子：模拟 COMMIT 本身失败——必须走 catch（ROLLBACK），committed 绝不置 true。
        if (hooks.simulateCommitFailure && hooks.simulateCommitFailure()) {
          throw new Error('模拟 COMMIT 失败（测试注入，补丁Z·Z2 COMMIT-FAIL 用例）');
        }
        await run(`COMMIT`);
        committed = true; // ⚠️ 之后任何异常都不得再把这个改回 false / 不得再 ROLLBACK
      } else {
        await run(`ROLLBACK`);
      }
    } catch (txErr) {
      if (!committed) {
        try { await run(`ROLLBACK`); } catch (_e) { /* 尽力回滚 */ }
      }
      txnOrConnError = txErr;
    }
  } catch (connErr) {
    txnOrConnError = connErr;
  }

  // ── 连接关闭：独立 finally 语义，失败只记 stderr，绝不改变已确定的提交结果 ──────────
  if (db) {
    try {
      await new Promise((res) => db.close((closeErr) => {
        if (closeErr) {
          try { console.error(`[迁移脚本] 数据库连接关闭异常（不影响迁移结果，committed=${committed}）：${closeErr.message}`); } catch (_e) { /* best-effort */ }
        }
        res();
      }));
    } catch (e) {
      try { console.error(`[迁移脚本] 数据库连接关闭异常（不影响迁移结果，committed=${committed}）：${e.message}`); } catch (_e) { /* best-effort */ }
    }
  }

  // ── 结果确定：committed 一旦为 true，结果恒为成功，不受后续任何环节影响 ──────────
  let finalResult;
  if (committed) {
    finalResult = { ok: true, mode: outcome.mode, message: outcome.message, exitCode: 0 };
  } else if (txnOrConnError) {
    finalResult = { ok: false, mode: 'error', message: txnOrConnError.message, exitCode: 1 };
  } else if (outcome && outcome.abortCode !== undefined) {
    finalResult = { ok: false, mode: outcome.mode, message: outcome.message, exitCode: outcome.abortCode };
  } else if (outcome) {
    // dry-run 成功 / forceRollback（fresh 未登记）—— 均是"未提交但符合预期"的正常结束
    finalResult = { ok: true, mode: outcome.mode, message: outcome.message, exitCode: 0 };
  } else {
    finalResult = { ok: false, mode: 'fatal', message: '未知状态：既无 outcome 也无错误', exitCode: 1 };
  }

  // ── 报告写入：单次尝试，不递归重调本函数；committed 后失败走独立 exitCode=3 ──────────
  report.result = finalResult;
  report.committed = committed;
  report.exitCode = finalResult.exitCode;
  report.finishedAt = new Date().toISOString();

  let reportWriteErr = null;
  const simulateFail = hooks.simulateReportWriteFailure && hooks.simulateReportWriteFailure();
  if (simulateFail) {
    reportWriteErr = new Error('模拟报告写入失败（测试注入，补丁Z·Z2 REPORT-FAIL-AFTER-COMMIT 用例）');
    // 模拟路径仍需要一个真实 fd 才能验证收尾行为（关闭等）；正常主路径下 claimReportFd 早已在 BEGIN 前
    // 占位过，这里只是兜底（占位失败不影响"模拟写入失败"这条路径本身要验证的行为）。
    try { claimReportFd(); } catch (_e) { /* best-effort */ }
  } else {
    // [AA1] 兜底占位：早期连接失败等路径可能从未走到 BEGIN 前的 claimReportFd 调用点，这里补占位，
    //   紧接着立刻写入内容——不存在"占位后长期为空"的窗口。
    try {
      claimReportFd();
      fs.writeSync(reportFd, JSON.stringify(report, null, 2));
    } catch (e) {
      reportWriteErr = e;
    }
  }
  if (reportFd !== null) {
    try { fs.closeSync(reportFd); } catch (_e) { /* best-effort */ }
  }

  if (committed && reportWriteErr) {
    try { console.error(`迁移已提交，报告保存失败：${reportWriteErr.message}`); } catch (_e) { /* best-effort */ }
    return {
      ...finalResult, reportPath: finalReportPath, steps: report.steps,
      committed: true, reportWriteFailed: true, reportWriteError: reportWriteErr.message, exitCode: 3,
    };
  }
  if (reportWriteErr && !committed) {
    // 未提交时报告也写不出——没有"迁移已提交需要独立退出码"的诉求，直接作为普通失败上抛。
    throw new Error(`报告写入失败：${reportWriteErr.message}`);
  }
  return { ...finalResult, reportPath: finalReportPath, steps: report.steps, committed };
}

// ── CLI ────────────────────────────────────────────────────────────────────
const HELP_TEXT = `用法：
  node scripts/migrate-sys-issues-drop-config-release-check.js --db <path> [--apply] [--dry-run]
       [--confirm-db <绝对路径>] [--stop-window-ack] [--register-fresh] [--report <path>]

  --db <path>          必需。目标 sqlite 文件路径。
  --apply              真提交（默认 dry-run，六步照跑后 ROLLBACK）。与 --dry-run 互斥。
  --dry-run            显式声明 dry-run（与默认行为等价，可用于消除歧义）。
  --confirm-db <path>  仅当 --apply 且 --db 的文件名（大小写不敏感）恰为 task_pool.db 时必需：须与
                        --db 解析后的绝对路径一致（大小写不敏感，先解析符号链接）。
  --stop-window-ack    仅当 --apply 且 --db 的文件名恰为 task_pool.db 时必需：声明服务已停、
                        带主题名的手工备份已做（方案 §5-8 停服窗口）。
  --register-fresh     仅对"新库（无标记∧无目标CHECK）"分支生效：显式登记迁移标记 + 结构指纹基线。
                        不带此旗标时新库分支不写库、退出 0、报告"结构未核对·未登记"。
  --report <path>      报告 JSON 落盘路径（排他创建，已存在即拒绝覆盖；不得与 --db 或其
                        -journal/-wal/-shm 伴生文件冲突）。apply 模式必需；dry-run 省略则落
                        <db 同级目录>/migrate-report-<ts>.json。

  已废弃：--i-know-this-is-the-dev-db（不再识别，见补丁 Y）。

  退出码（命令行退出码如下；报告**成功写出**时其顶层 exitCode 与 result.exitCode 与本表一致；退出码 3 或报告生成前失败时**不保证存在有效报告**——先核库再决定是否重跑）：
    0   成功——dry-run 正常回滚 / 首次迁移已提交 / 已迁移分支结构验证一致 / 新库分支
        （登记或未登记 --register-fresh 均属正常结束）。
    1   事务或连接/参数错误——库未被修改：要么从未开始写，要么已 ROLLBACK。
    2   结构矛盾——迁移标记与实际结构不一致（标记存在但目标 CHECK 仍在活库 DDL 中／
        已迁移分支结构指纹比对不一致，报告列出具体差异）。
    3   已提交但报告写入失败——迁移本身已成功提交（库已迁移），仅报告 JSON 落盘失败。
        勿重跑 --apply；先核实库当前状态（可用 --dry-run 核对是否已处于「已迁移」分支），
        再排查 --report 路径/权限问题后重新落盘诊断信息。`;

function parseArgs(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { help: true };
  }
  const out = {
    dbPath: null, apply: false, dryRunExplicit: false, reportPath: null,
    confirmDb: null, stopWindowAck: false, registerFresh: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') { out.dbPath = argv[++i]; }
    else if (a.startsWith('--db=')) { out.dbPath = a.slice(5); }
    else if (a === '--apply') { out.apply = true; }
    else if (a === '--dry-run') { out.dryRunExplicit = true; }
    else if (a === '--confirm-db') { out.confirmDb = argv[++i]; }
    else if (a.startsWith('--confirm-db=')) { out.confirmDb = a.slice(13); }
    else if (a === '--stop-window-ack') { out.stopWindowAck = true; }
    else if (a === '--register-fresh') { out.registerFresh = true; }
    else if (a === '--report') { out.reportPath = argv[++i]; }
    else if (a.startsWith('--report=')) { out.reportPath = a.slice(9); }
    else { throw new Error(`未知参数：${a}（--i-know-this-is-the-dev-db 已废弃，见补丁 Y；--help 查看用法）`); }
  }
  if (!out.dbPath) throw new Error('缺少必需参数 --db <path>');
  if (out.apply && out.dryRunExplicit) throw new Error('--apply 与 --dry-run 不能同时传入');
  return out;
}

if (require.main === module) {
  (async () => {
    let args;
    try {
      args = parseArgs(process.argv.slice(2));
    } catch (e) {
      console.error('参数错误：' + e.message);
      process.exit(1);
      return;
    }
    if (args.help) {
      console.log(HELP_TEXT);
      process.exit(0);
      return;
    }
    let result;
    try {
      result = await runMigration({
        dbPath: args.dbPath,
        apply: args.apply,
        confirmDb: args.confirmDb,
        stopWindowAck: args.stopWindowAck,
        registerFresh: args.registerFresh,
        reportPath: args.reportPath,
      });
    } catch (e) {
      console.error('迁移脚本致命错误：' + e.message);
      process.exit(1);
      return;
    }
    console.log(JSON.stringify({ ok: result.ok, mode: result.mode, message: result.message, reportPath: result.reportPath, committed: result.committed }, null, 2));
    process.exit(result.exitCode !== undefined ? result.exitCode : (result.ok ? 0 : 1));
  })();
}

module.exports = {
  runMigration,
  __testHooks: defaultHooks,
  MIGRATION_KEY,
  TARGET_CHECK_CANONICAL,
  DEV_DB_BASENAME,
  FINGERPRINT_COLUMN,
  HELP_TEXT,
  _internals: {
    tokenizeSql, blankOutComments, tokenizeForCompare, tokensEqual, normWs, extractAllCheckClauses, locateTargetCheck,
    findAdjacentComma, surgeryRemoveClause,
    assertOtherChecksUnchanged, renameCreateTableHeader, computeRowHash, computeChildTableHashes, getSeq, promisify,
    integrityOk, fkCheckRows, fkNewViolationsMultiset, multisetCounts, captureIndexTriggerRows,
    captureUnknownTypes, checkNoDependentViews, tableInfo, columnNameSeq, getCounts,
    snapshotProbeState, computeStructureFingerprint, ensureFingerprintColumn, diffStructure,
    realpathOrResolve, normalizeForCompare, lowerIfWin32, sameFileIdentity, assertReportPathSafe,
    openDatabaseDefault,
  },
};
