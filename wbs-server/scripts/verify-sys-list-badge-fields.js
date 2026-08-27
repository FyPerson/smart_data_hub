/**
 * 系统迭代·列表徽章字段契约守卫（2026-08-12 新增）
 *
 * 缺口来源：`blocked`（受阻）徽章在列表页是**永不触发的死分支**——前端 renderSysIterationRows 有完整
 *   渲染分支 + CSS 配色，但列表端点 GET /sys-issues 的**显式列投影**里从来没有这一列，`i.blocked`
 *   恒 undefined。同族第三例（另两例是"后端给了前端没接"，这例反过来），三例都靠人工/用户撞见发现。
 *
 * 本守卫做的事：**自动**从前端列表行渲染代码里提取被消费的 `i.<字段>`，与后端列表 SELECT 的列集合
 *   对拍——前端消费了但 SELECT 没给的字段一律判红。新增徽章时若忘了补列，这里会当场红，不必再靠
 *   人工逐列核对（codex 340 号 MED 采纳项）。
 *
 * ⚠️ 边界（如实写明，不夸大覆盖面）：
 *   1. 只覆盖**列表行**渲染路径（renderSysIterationRows 函数体 + 它调用的徽章 helper），不覆盖详情/抽屉
 *      （那边走详情端点，列投影不同，另有其契约）。
 *   2. 只查"字段有没有被 SELECT 出来"，**不查值对不对**、也不查前端渲染逻辑是否正确。
 *   3. 前端自算的派生字段（如 siLoadList 逐行补的 dev_roster_sort）走白名单显式豁免，白名单每项带理由。
 */
const fs = require('fs');
const path = require('path');
const { findOuterBoundary } = require('./lib/sql-select-boundary');
const { extractFunctionBody } = require('./lib/extract-function-body');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'Sys_Iteration.html'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m) => { fail++; console.log(`  [FAIL] ${m}`); };
const must = (cond, m) => cond ? ok(m) : bad(m);

// 派生字段：不出现在 SELECT 列集里，但随响应体供给前端（前端自算 or 后端逐行 computed），逐项带理由。
//   守卫口径="前端读的字段必须真到得了前端"，SELECT 列与派生字段都算供给，此白名单收后者。
const FRONTEND_DERIVED = {
  dev_roster_sort: 'siLoadList 拉完列表后逐行补的排序派生值（共享排序层只读 item[field]，非后端字段）',
  // [组 B·SB3 预筛 MED 修] 后端列表端点逐行 computed（index.js:6618 `r.online_source_kind = deriveOnlineSourceKind(r)`）——
  //   非 SELECT 列但随响应体下发；徽章 siPostAcceptFlagHtml 改读它（不再原始 online_source 值比较·两份判据必漂移）。
  //   原始 online_source 列仍在 SELECT（见下方 BADGE_FIELDS）=deriveOnlineSourceKind 的计算输入，两者并存不冲突。
  online_source_kind: '后端列表端点逐行 deriveOnlineSourceKind(r) 派生（index.js:6618），随响应下发；徽章展示 kind 只认此派生列',
  // [追加批·M2] 48h 圈红判据收归后端——同 online_source_kind 一样是列表端点逐行 computed（非 SELECT
  //   原始列），随响应体下发；前端 siPostAcceptFlagHtml 改读此字段，不再自算浏览器本地时区。
  post_release_accept_overdue: '后端列表端点逐行 isPostReleaseAcceptOverdue(r) 派生，随响应下发；48h 圈红判据权威在后端（与写入 released_at 同进程同时区，避免前端跨时区误判）',
};

// ── 取前端列表行渲染路径消费的字段 ──────────────────────────────
// 口径：renderSysIterationRows 函数体（含 flags 拼接块与整行模板），加上它调用的两个徽章 helper
//   （siTechLeadNotifyBadgeHtml / siHeldDaysHtml 的形参就是列表行对象/其字段）。
// [S13 收口 LOW 追-6] extractFunctionBody 抽到 scripts/lib/extract-function-body.js 单点实现（与
//   verify-sys-derive-numbering.js DN8 段/verify-sys-derive-display.js 共用同一份，不再三处逐字维护）。

// 剥行注释与块注释（防注释里的 i.xxx 被当成真消费；guard gotchas「文本扫描剥注释先行」）
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}

// [S13·派生单子编号批实测撞见] SQL 文本用 `--` 作行注释（非 JS `//`）——列表 SELECT 是 SQL 模板串，
//   若不剥离，形如 `derive_root_id, derive_seq,   -- ← [S12-b...]` 这种"末尾带同行 SQL 注释"的列会
//   被注释文本一路合并进下一个逗号之前的 item（本函数下方的顶层逗号扫描器不识别 SQL 注释边界），拼出
//   不匹配裸列名正则的畸形 item——derive_root_id 因此被误判"不在 SELECT 里"（前端刚开始消费它就撞见）。
//   ⚠️ 只用于 SQL 文本，不能套用到上面 stripComments 处理 JS 函数体那条路径——JS 侧存在
//   `var(--sem-xxx-fg)` 这类以 `--` 开头的 CSS 变量名字面量，粗暴按 `--` 截断会把这些字符串腰斩。
function stripSqlLineComments(s) {
  return s.replace(/--.*$/gm, '');
}

const rowBody = extractFunctionBody(HTML, 'renderSysIterationRows');
const tlBody = extractFunctionBody(HTML, 'siTechLeadNotifyBadgeHtml');
// [待上线可见性 20260812] 新徽章 helper 必须**同时**进扫描面——否则它消费的新字段（has_release_remove
//   等）对本守卫不可见，守卫照常全绿却什么也没覆盖（正是本守卫要防的 blocked 死分支的同款漏法）。
const preBody = extractFunctionBody(HTML, 'siPrereleaseFlagHtml');
// [组 B·SB3·补验收闭环 20260813] 同上理由——「先行上线待补验收」徽章 helper 消费 online_source/
//   post_release_acceptance/released_at/post_derive_issue_id 四字段（末者为追加批 failed_derived
//   分支新引入），必须同批进扫描面。
const paBody = extractFunctionBody(HTML, 'siPostAcceptFlagHtml');
// [S7·先行上线两步化 方案 v1.8 §6] 同上理由——「待先行部署 x/N」徽章 helper 消费 type/status/
//   fast_release_active_auth/fast_release_exec_total_count/fast_release_exec_done_count 五字段，
//   必须同批进扫描面，否则它消费的两个新 S6 列（total/done count）对本守卫不可见（正是本守卫要防
//   的 blocked 死分支同款漏法——新 helper 不进扫描面=守卫对它视而不见，照样全绿）。
const flBody = extractFunctionBody(HTML, 'siFastlaneFlagHtml');
must(!!rowBody, 'renderSysIterationRows 函数体可提取（提不到=守卫空转，不能当通过）');
must(!!tlBody, 'siTechLeadNotifyBadgeHtml 函数体可提取');
must(!!preBody, 'siPrereleaseFlagHtml 函数体可提取（待上线两 flag 的唯一判定出口）');
must(!!paBody, 'siPostAcceptFlagHtml 函数体可提取（先行上线待补验收徽章的唯一判定出口）');
must(!!flBody, 'siFastlaneFlagHtml 函数体可提取（待先行部署 x/N 徽章的唯一判定出口）');
if (!rowBody || !tlBody || !preBody || !paBody || !flBody) { console.log('\n=== FAIL：扫描面缺失 ==='); process.exit(1); }

const consumeSrc = stripComments(rowBody + '\n' + tlBody + '\n' + preBody + '\n' + paBody + '\n' + flBody);
const consumed = new Set();
for (const m of consumeSrc.matchAll(/\bi\.([a-z_][a-z0-9_]*)\b/g)) consumed.add(m[1]);
must(consumed.size >= 15, `前端消费字段实抓 ${consumed.size} 个（过少=正则失配，扫描面须非空）`);

// ── 取后端列表 SELECT 的列集合 ──────────────────────────────────
// 定位 GET /sys-issues 端点内那条列表查询（唯一一条：其余 SELECT 均为 WHERE id=? 的单行查询）
const listSelStart = ROUTES.indexOf('`SELECT id, type, status, priority, risk_level, title, system_name');
must(listSelStart > 0, '列表 SELECT 可定位（唯一列表供数查询）');
// [S13-b·B1 实测撞见] 裸 `ROUTES.indexOf('FROM sys_issues', listSelStart)` 找外层 FROM 的写法会被"列表内
//   自身含相关子查询"骗到——B1 新增的 post_derive_root_id/post_derive_seq 两条标量子查询形如
//   `(SELECT d.derive_root_id FROM sys_issues d WHERE d.id = ...)`，子查询里那句 "FROM sys_issues" 字面
//   量比外层真正的 FROM 更早出现，裸 indexOf 会在子查询内部截断，把外层真正 FROM 之前几十个列全部漏扫
//   （release_assignee_id 起十余列判"消失"）——本质与已修的「SQL 行注释吞列」同一类"字符串扫描器被合法
//   SQL 结构骗过"问题（guard gotchas 家族新增实例）。改为**括号深度感知**扫描：跳过子查询内部文本，只认
//   深度=0 时出现的第一个 "FROM sys_issues" 才是外层列表的真正终点。扫描前先在一个足够宽裕的上界内剥掉
//   SQL 行注释（先剥注释再找边界——防注释文本本身巧合含 "FROM sys_issues" 字样干扰判定，虽本 SELECT
//   当前注释里没有这个巧合，但纪律上应遵循「文本扫描剥注释先行」）。
// [实测订正] 本 SELECT 列多、注释重（含 commit 聚合两条 JSON 子查询），真正的外层 `FROM sys_issues`
//   落在距 listSelStart 约 22KB 原文处——早先按"约 60 列 ~5-6KB"估的 12000 上界偏小，命中过又一个"看似找到但其实截断"的假阳性
//   ⚠️ [「待我处理」全角色卡·方案 §6 断言 5·457-H2 冻结] 查询构建抽成 buildSysIssuesListSelect/
//   buildSysIssuesListQuery 两个纯函数后，`FROM sys_issues` 已不再与 `${where...}` 动态 WHERE 拼接同处
//   一个模板字符串——FROM 留在 buildSysIssuesListSelect 收尾（selectSql 的一部分），WHERE/ORDER BY 挪到
//   buildSysIssuesListQuery 里单独拼接（见 index.js 该处"badge-fields 守卫兼容"注释）。下方紧邻性断言
//   的指纹文本已同步改为 buildSysIssuesListSelect 收尾处的 `return { selectSql, selectParams }`。
//   （findOuterBoundary 在过窄的窗口内返回 -1，若不做 -1 判断会让下方 `.slice(0, -1)` 悄悄吃掉最后
//   一个字符却不报错——已用显式 `< 0` 早退 + must() 断言堵死这条河）。上界调宽到 60000（对这一个 SELECT
//   语句块而言仍是安全上界，不会误吞下一个端点的内容——真正终点 FROM 之后立即 return，不继续扫描）。
// [S13 收口 MED-2] 深度感知扫描本身抽到 scripts/lib/sql-select-boundary.js 单点实现（与
//   verify-sys-prerelease-flags.js 共用同一份，逐字重复维护改成两文件各自 require）——顺带补上原实现
//   缺的 fail-closed：窗口内括号计数一旦变负立即判红，不再信任"变负之后又凑巧归零"的假 top-level 命中
//   （否则将来某处 SQL 字面量里落了个不配对的单括号，扫描可能悄悄跳到别的端点/语句块的同名 FROM 上，
//   选出一个混了别处内容的超集列集合却不报错，见 sql-select-boundary.js 模块头注）。
const SELECT_SCAN_UPPER_BOUND = 60000;
const strippedForBoundary = stripComments(stripSqlLineComments(ROUTES.slice(listSelStart, listSelStart + SELECT_SCAN_UPPER_BOUND)));
const boundaryResult = findOuterBoundary(strippedForBoundary, 'FROM sys_issues');
must(!boundaryResult.wentNegative, '边界扫描括号深度全程非负（fail-closed：一旦变负说明括号计数已不自洽，不信任后续任何"恰好归零"的命中，防止静默选中混了别处内容的超集范围）');
const outerFromIdxInStripped = boundaryResult.index;
must(outerFromIdxInStripped > 0, '外层 FROM sys_issues 边界可定位（深度感知扫描，不被子查询内的同字面量截断）');
const selectBlock = outerFromIdxInStripped > 0 ? strippedForBoundary.slice(0, outerFromIdxInStripped) : '';
// 边界正确性断言（MED-2 新增，457-H2 收口后指纹改版）：命中点紧随其后应能看到本条列表 SELECT 自己的
//   收尾特征——查询构建抽成 buildSysIssuesListSelect 后，FROM sys_issues 是该函数 selectSql 的收尾行，
//   紧接着就是 `return { selectSql, selectParams };`（index.js 该处逐字如此）——证明这次真落在"这条
//   列表查询自己的外层 FROM"，不是巧合命中了别处同名字面量后又凑巧深度为 0（全仓 `FROM sys_issues`
//   字面量出现在几十处子查询/详情端点里，这条指纹断言是防止误中它们的唯一保险）。
const afterBoundary = outerFromIdxInStripped > 0 ? strippedForBoundary.slice(outerFromIdxInStripped, outerFromIdxInStripped + 120) : '';
must(afterBoundary.includes('return { selectSql, selectParams }'), `外层边界后文应含本条 SELECT 自己的收尾特征 "return { selectSql, selectParams }"（证明命中点确是 buildSysIssuesListSelect 收尾处的 FROM，非误中别处），命中点后 120 字符原文：${JSON.stringify(afterBoundary)}`);

const selected = new Set();
// ① 顶层裸列名：逐字符扫，只收括号深度为 0 的逗号分隔项里形如 `foo` 的整项
{
  const body = selectBlock.replace(/^`SELECT/, '');
  let depth = 0, cur = '';
  const items = [];
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur); cur = ''; } else cur += ch;
  }
  items.push(cur);
  for (const raw of items) {
    const t = raw.trim().replace(/\s+/g, ' ');
    if (/^[a-z_][a-z0-9_]*$/i.test(t)) selected.add(t);            // 裸列
    const asM = t.match(/\bAS\s+([a-z_][a-z0-9_]*)\s*$/i);          // 子查询/表达式别名
    if (asM) selected.add(asM[1]);
  }
}
must(selected.size >= 25, `列表 SELECT 列集合实抓 ${selected.size} 个（过少=解析失败）`);

// [值班筛选与类型卡 S1·S-fix 3a·先行上线授权超时收回 S1 起改判恰 2] selectBlock（WHERE 子句之前的
//   列表部分）恰含 2 个 ? 占位符——① fast_release_active_auth CASE 改判"可消费"新增的 nowStr 占位符
//   （文本顺序更早出现）② fast_release_my_pending 子查询的 uid 占位符（原恰 1 个的唯一占位符，S1 前
//   特意排在 params 数组最前；S1 起两段参数改分离声明+按 SQL 段文本顺序拼接，见 index.js 该处
//   "绑定协议结构化"注释）。若未来有人在 SELECT 列表里再加一个 ? 却忘了同步调整 selectParams 数组，
//   全部可见性筛选/addEq 参数都会集体错位一位——本条把"selectBlock 里恒是这两个 ?"钉成显式不变量，
//   不再只靠运行时行为侧面推断。
// ⚠️ [先行上线授权超时收回 S1 实测订正·S1-fix MED-3 泛化] fast_release_active_auth 的 nowStr 占位符
//   **不是**selectBlock 自身文本里的裸 `?`——它藏在具名常量 `FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL`
//   的**定义体**里（CASE 处只有 `${FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL}` 这个引用，源码文本层面
//   看不到 `?`）。本守卫是纯文本扫描（不评估 JS 模板字符串插值），故裸 `.match(/\?/g)` 只能数到
//   my_pending 那 1 个（首版在此踩了一次坑：以为 selectBlock 源码里恒有 2 个裸 `?`，实测仍是 1，落地
//   即红）。改为**推导式计数**：单独定位常量的定义体、数出它自身内嵌几个 `?`，乘以本 selectBlock 内
//   引用该常量的次数，与裸 `?` 计数相加，才是运行期真正展开后的占位符总数——推导逻辑本身也失败即
//   must() 判红，不静默降级为裸计数（否则本守卫会退化回"只测得到 1"的旧行为，对新占位符视而不见）。
//   [MED-3 泛化] 首版只认 `FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL` 这一个硬编码常量名——若未来 SELECT
//   列表里再引用别的具名常量（同样携带内嵌 `?`），首版会静默漏数（新常量的引用会被裸 `.match(/\?/g)`
//   忽略，同一坑复现）。现改为**通用扫描**：selectBlock 内出现的**全部**裸标识符引用 `${IDENT}`
//   （`[A-Za-z_][A-Za-z0-9_]*` 词法，含括号的函数调用形态如 `${sysFastReleaseExecActiveWhere(...)}`
//   因内容含 `(` 不匹配本正则，天然排除在外——⚠️ 排除的依据是**当前投影区三处该类调用均传
//   correlateTo**（相关子查询等值关联，不产生占位符），不是该类表达式的普遍性质：0 参形态会产出
//   1 个 `?`（index.js SYS_FAST_RELEASE_EXEC_ACTIVE_WHERE_SQL 正是 0 参调用的产物），未来若 0 参/
//   其它带占位符的函数调用形态进入投影区，须同步扩本守卫的计数面，本正则会静默漏算它们）都会被收集为候选，逐个去定位其 `const IDENT = ...`
//   定义体、数出内嵌 `?` 数——**任一候选定位失败即 must() 判红**，不允许"找不到就当 0"这类静默降级
//   （那等于把"新常量忘了同步这条守卫"这个真实漏洞伪装成"没有新占位符"）。
const identPlaceholderCountCache = {};
function identPlaceholderCount(identName) {
  if (Object.prototype.hasOwnProperty.call(identPlaceholderCountCache, identName)) return identPlaceholderCountCache[identName];
  const defRe = new RegExp('const ' + identName + ' =\\s*\\n?\\s*`([^`]*)`;');
  const m = ROUTES.match(defRe);
  must(!!m, `列表 SELECT 引用的具名常量 ${identName} 定义体可定位（供推导其自身内嵌占位符数，纯文本扫描看不进模板插值；MED-3 泛化扫描发现的引用，非硬编码单一常量名）`);
  const count = m ? (m[1].match(/\?/g) || []).length : -1;
  identPlaceholderCountCache[identName] = count;
  return count;
}
function countSelectPlaceholders(block) {
  const raw = (block.match(/\?/g) || []).length;
  const identRefs = block.match(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [];
  const uniqueIdents = [...new Set(identRefs.map(s => s.slice(2, -1)))];
  let extra = 0;
  for (const ident of uniqueIdents) {
    const perOcc = identPlaceholderCount(ident);
    const occCount = identRefs.filter(r => r === '${' + ident + '}').length;
    extra += perOcc * occCount;
  }
  return raw + extra;
}
const selectBlockQMarks = countSelectPlaceholders(selectBlock);
// [「待我处理」全角色卡·方案 §3.1 selectParams 冻结口径·唯一权威口径] 恰 4 个（此前恰 2 个）——新增两列
//   my_dev_pending（裸 ? 绑 uid）/ is_my_intake_liaison（裸 ? 绑 uid）各带 1 个占位符，插在
//   fast_release_my_pending 之后（index.js 该处投影区文本顺序）。
must(selectBlockQMarks === 4, `列表 SELECT 列表部分（WHERE 之前）应恰含 4 个 ? 占位符（fast_release_active_auth 经 FAST_RELEASE_CONSUMABLE_AUTH_WHERE_SQL 引用内嵌的 nowStr + fast_release_my_pending 裸 ? 的 uid + my_dev_pending 裸 ? 的 uid + is_my_intake_liaison 裸 ? 的 uid），实得 ${selectBlockQMarks}——多出/缺失的 ? 会与 selectParams 数组顺序错位`);
// 对照组（[S-fix2] 管线级重写·预筛三轮 S-fix LOW-1：原「selectBlock 副本拼接后 (N+1)!==1」是构造上的
//   恒真式且不经被测管线——对照组槽位上出现"断言永远成立"正是 guard-gotchas 要防的形态）：把带 ? 的
//   注入体前置到 ROUTES 切片副本后**重跑同一条提取管线**（stripSqlLineComments→stripComments→
//   findOuterBoundary→切块→推导式计数），断言得 5（基线 4 + 注入 1 个裸 ?）——同时注入体里另藏一个
//   **注释内的 ?**（/* ? */），若管线的注释剥离失效会计得 6 同样判红，一组对照双向证明
//   "计数经真实管线且注释不计入"。
{
  const mutatedSlice = '/* ? */ (?) ' + ROUTES.slice(listSelStart, listSelStart + SELECT_SCAN_UPPER_BOUND);
  const stripped2 = stripComments(stripSqlLineComments(mutatedSlice));
  const boundary2 = findOuterBoundary(stripped2, 'FROM sys_issues');
  must(!boundary2.wentNegative && boundary2.index > 0, '★对照组前置：注入后管线边界扫描仍应可定位且深度非负（注入体 (?) 括号自平衡）');
  const block2 = stripped2.slice(0, boundary2.index);
  const fakeQMarks = countSelectPlaceholders(block2);
  must(fakeQMarks === 5, `★对照组（管线级）：注入 1 个真裸 ?（注释内另藏 1 个假 ?）后重跑同一条提取管线（含常量引用推导）应恰计 5 个（基线 4 + 注入 1），实得 ${fakeQMarks}——≠5 说明判据恒真、管线未被经过、或注释剥离失效`);
}

// ── 对拍 ────────────────────────────────────────────────────────
const missing = [...consumed].filter(f => !selected.has(f) && !FRONTEND_DERIVED[f]);
must(missing.length === 0,
  `前端列表行消费的字段全部由列表 SELECT 供给${missing.length ? `——缺 ${missing.length} 个：${missing.join(', ')}（前端会读到 undefined，对应渲染分支永不触发）` : `（消费 ${consumed.size} 个 / 供给 ${selected.size} 个）`}`);

// 徽章关键字段逐个点名（清单腐化时给出可读定位，不只报总数）
const BADGE_FIELDS = [
  ['scope_changed', '范围变更'], ['return_count', '打回×N'], ['reopen_count', '返工×N'],
  ['blocked', '受阻'], ['tech_lead_id', '技术负责人通知'], ['tech_lead_notify_status', '待发送/发送失败'],
  ['has_current_tech_lead_comment', '通知徽章收口判定'], ['last_held_at', '已暂缓 N 天'],
  ['origin_issue_id', '血缘 🔁基于#N'], ['risk_level', '风险等级'], ['priority', '优先级'], ['status', '状态徽章'],
  // [待上线可见性 20260812] 两 flag 的判定与悬停三要素
  ['release_id', '已移出/未排期（批次归属判定）'], ['has_release_remove', '已移出 vs 未排期 的区分依据'],
  ['last_release_remove_summary', '已移出·悬停原因'], ['last_release_remove_by', '已移出·悬停操作人'],
  ['last_release_remove_at', '已移出·悬停时刻'],
  // [组 B·SB3·补验收闭环 20260813] 「先行上线待补验收」徽章 + 48h 圈红判据。
  //   ⚠️ [追加批·M2 订正] online_source/released_at 两列**前端不再直接读**——前端徽章改读后端逐行
  //   computed 的 online_source_kind/post_release_accept_overdue（见上方 FRONTEND_DERIVED 白名单）；
  //   这两列仍须留在 SELECT，是**后端** deriveOnlineSourceKind(r)/isPostReleaseAcceptOverdue(r) 两个
  //   计算的输入（供数链路：SELECT 列 → 后端 JS 计算 → 派生字段 → 前端读派生字段），故仍点名钉住，
  //   只是理由从"前端徽章直接依赖"改为"供后端计算依赖"。post_release_acceptance 是唯一前端直接读的
  //   原始列（pending 门控判断）。
  ['online_source', '「已上线」来源派生 deriveOnlineSourceKind(r) 的计算输入（供 online_source_kind）'],
  ['post_release_acceptance', '先行上线待补验收（pending 门控·前端直接读）'],
  ['released_at', '48h 圈红判据 isPostReleaseAcceptOverdue(r) 的计算输入（供 post_release_accept_overdue）'],
  // [追加批·2026-08-13·用户实测拍板] 「补验收未通过」终态徽章——failed_derived 门控 + title 内嵌
  //   "已派生 #N"链接文案的取数列，此前列表 SELECT 从未投影过（只有详情端点 `SELECT sys_issues.*`
  //   隐式带上），是本批新补的列，本条目即为该补列动作的守卫锚点。
  ['post_derive_issue_id', '补验收未通过·悬停"已派生 #N"'],
  // [S7·先行上线两步化 方案 v1.8 §6] 「待先行部署 x/N」徽章依赖字段（S6 列表投影新增三列）——
  //   type/status 是既有列，未在此重复点名（BADGE_FIELDS 只登记"因本徽章才需要"的新列，两者
  //   已被其余徽章条目间接覆盖）。
  ['fast_release_active_auth', '待先行部署 x/N·徽章条件（活跃授权布尔）'],
  ['fast_release_exec_total_count', '待先行部署 x/N·分母（当前代次执行人集合总数）'],
  ['fast_release_exec_done_count', '待先行部署 x/N·分子（已确认执行人数）'],
  // [S13·§15.3 矩阵行1/2·MED-1 后续] 派生单子编号「#根_序」——单号列（siIssueDisplayNo(i) 直接消费）+
  //   血缘徽章（i.derive_root_id 用于悬停 title 拼链根，derive_seq 经 siIssueDisplayNo 内部消费不出现
  //   为字面量 `i.derive_seq`，故不会被本文件 `\bi\.` 扫描器直接抓到，但仍是渲染分支的真实依赖，点名
  //   钉住防未来漏投影——同 online_source/released_at 两条"供后端/helper 计算依赖"先例）。derive_root_id
  //   本条正是「S13 前端刚开始消费即撞见 SQL 行注释吞列」缺口的锚点（stripSqlLineComments 修复所指）。
  ['derive_root_id', '单号列子编号（siIssueDisplayNo）+ 血缘徽章链根悬停 title'],
  ['derive_seq', '单号列子编号（siIssueDisplayNo 内部消费，非字面量 i.derive_seq，故本文件扫描器抓不到——点名登记防漏投影）'],
  // [S13-b·B1] 「补验收未通过」徽章"已派生 #N"改子编号——目标派生单的 root/seq 挪进 SELECT 标量子查询
  //   （不再仅靠前端 siList 内查找兜底），两列均是字面量 `i.post_derive_root_id`/`i.post_derive_seq`
  //   会被本文件扫描器直接抓到（与 derive_seq 那条"抓不到"不同，点名仍保留是为了对齐既有登记惯例 + 给
  //   出可读定位）。
  ['post_derive_root_id', '补验收未通过·已派生子编号——目标派生单 derive_root_id 标量子查询投影'],
  ['post_derive_seq', '补验收未通过·已派生子编号——目标派生单 derive_seq 标量子查询投影'],
  // [值班筛选与类型卡 S1/S2·S-fix 3b·「待我处理」全角色卡 C4 措辞同步] fast_release_my_pending——
  //   同 derive_seq 先例：本列被 siIsMyFastlanePending(i)（Sys_Iteration.html 内定义，非本文件五个
  //   扫描函数体 renderSysIterationRows/siTechLeadNotifyBadgeHtml/siPrereleaseFlagHtml/
  //   siPostAcceptFlagHtml/siFastlaneFlagHtml 之一——聚合卡/筛选路径在"列表行渲染"之外，超出本守卫
  //   头部注释明写的"只覆盖列表行渲染路径"扫描面）以 i.fast_release_my_pending 字面量消费，本文件的
  //   \bi\. 扫描器天然抓不到这条消费。若不点名登记，后端未来一旦漏投影/误删该列，本守卫会全绿放过——
  //   「待我处理」聚合卡的值班身份分支（siIsMyPending 内 ⑥ 值班执行人一支，原样调用
  //   siIsMyFastlanePending，独立「待我确认」值班卡已随该批吸收移除）会静默恒读到 undefined（该
  //   身份分支恒不命中），却没有任何断言会报红。
  ['fast_release_my_pending', '「待我处理」聚合卡·值班执行人身份分支计数（siIsMyFastlanePending 消费，经 siIsMyPending 聚合调用，本守卫扫描面之外，点名登记兜底）'],
];
for (const [f, label] of BADGE_FIELDS) {
  must(selected.has(f), `徽章「${label}」依赖字段 ${f} 在列表 SELECT 中`);
}

// ── 对照组：证明判据真能判红（guard gotchas「对照组证明」）──────
{
  const fakeSelected = new Set([...selected]); fakeSelected.delete('blocked');
  const fakeMissing = [...consumed].filter(f => !fakeSelected.has(f) && !FRONTEND_DERIVED[f]);
  must(fakeMissing.includes('blocked'),
    `★对照组：从供给集合里抽掉 blocked → 判据必须报缺（实得 ${JSON.stringify(fakeMissing)}），证明这条断言不是恒真`);
  const fakeConsumed = new Set([...consumed]); fakeConsumed.delete('blocked');
  must(![...fakeConsumed].includes('blocked'),
    '★对照组：前端不消费某字段时不应误报（判据只对"消费了但没供给"发难）');
}

console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
if (fail === 0) {
  console.log(`覆盖：前端列表行消费 ${consumed.size} 字段 ⊆ 列表 SELECT 供给 ${selected.size} 字段（+ ${Object.keys(FRONTEND_DERIVED).length} 个前端派生豁免）`);
}
process.exit(fail === 0 ? 0 : 1);
