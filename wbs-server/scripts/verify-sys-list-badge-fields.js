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
function extractFunctionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0, end = -1;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  return end < 0 ? null : src.slice(start, end + 1);
}

// 剥行注释与块注释（防注释里的 i.xxx 被当成真消费；guard gotchas「文本扫描剥注释先行」）
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
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
must(!!rowBody, 'renderSysIterationRows 函数体可提取（提不到=守卫空转，不能当通过）');
must(!!tlBody, 'siTechLeadNotifyBadgeHtml 函数体可提取');
must(!!preBody, 'siPrereleaseFlagHtml 函数体可提取（待上线两 flag 的唯一判定出口）');
must(!!paBody, 'siPostAcceptFlagHtml 函数体可提取（先行上线待补验收徽章的唯一判定出口）');
if (!rowBody || !tlBody || !preBody || !paBody) { console.log('\n=== FAIL：扫描面缺失 ==='); process.exit(1); }

const consumeSrc = stripComments(rowBody + '\n' + tlBody + '\n' + preBody + '\n' + paBody);
const consumed = new Set();
for (const m of consumeSrc.matchAll(/\bi\.([a-z_][a-z0-9_]*)\b/g)) consumed.add(m[1]);
must(consumed.size >= 15, `前端消费字段实抓 ${consumed.size} 个（过少=正则失配，扫描面须非空）`);

// ── 取后端列表 SELECT 的列集合 ──────────────────────────────────
// 定位 GET /sys-issues 端点内那条列表查询（唯一一条：其余 SELECT 均为 WHERE id=? 的单行查询）
const listSelStart = ROUTES.indexOf('`SELECT id, type, status, priority, risk_level, title, system_name');
must(listSelStart > 0, '列表 SELECT 可定位（唯一列表供数查询）');
const fromIdx = ROUTES.indexOf('FROM sys_issues', listSelStart);
const selectBlock = stripComments(ROUTES.slice(listSelStart, fromIdx));

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
