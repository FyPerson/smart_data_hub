/**
 * verify-sys-fastlane-panel-static.js
 *
 * S7（先行上线两步化，方案 20260813 v1.8 §6）前端静态源码断言——用法同姊妹文件
 * verify-sys-post-release-panel-static.js：node scripts/verify-sys-fastlane-panel-static.js
 * （纯文本源码扫描，无需启动 server，自包含）。
 *
 * 背景：S6 已把「待先行部署 x/N」徽章的三个派生输入列（fast_release_active_auth /
 * fast_release_exec_total_count / fast_release_exec_done_count）与详情执行人集合
 * （fast_release_executors / fast_release_exec_progress）投到后端两个端点；S7 补齐前端消费面：
 * 列表徽章 + 详情执行区 + 第 15 层 sem-fastlane token 徽章配色 + 加/移人/确认三动作。本脚本钉住
 * "代码里写没写对"这一层（结构性不变量），"真的显示出来了"那一层留给 S8 Playwright。
 *
 * 覆盖（见交付报告 + S7_六码逐码验收表_20260814.md §2 逐条对照）：
 *   ① siFastlaneFlagHtml 已定义，且已并入 renderSysIterationRows 的 flags 拼接（非孤立死函数，
 *      防 blocked 同款死分支——见 verify-sys-list-badge-fields.js 头部注释同一教训）。
 *   ② 徽章条件三件套齐全（type==='bug' / status==='待验证' / fast_release_active_auth），且渲染
 *      走第 15 层 sem-fastlane token；0/0 场景不返回空串（方案 §4-1「0/0 待配置执行人」入口）；带
 *      间距载体（class 或 style）且未直接叠加 si-flag 类（Opus 合并预筛 MED-1 修复，2026-08-14）。
 *   ③ siFastlaneExecSectionHtml 已定义，且已并入 siRenderDrawer 的 siDBody 最终拼接。
 *   ④ 执行区显隐条件 siFastlaneExecHasContent 两支析取（badgeCond ∨ executors 非空）均存在
 *      （S6 详情 DTO 是 existence-gated 语义，见该函数头部注释的显隐取舍论证）。
 *   ⑤ 「执行先行上线」按钮仅在本人在册且 exec_status==='pending' 时渲染。
 *   ⑥ 「+ 添加执行人」按钮仅 admin 可见，done_count>0 时置灰 + title 提示（非隐藏）。
 *   ⑦ 「移除」按钮仅 admin + 挂牌活跃态（isStaged）+ pending 行可见。
 *   ⑧ 三个新增动作函数（siFastlaneAddExecutorModal/siFastlaneRemoveExecutor/siFastlaneExecConfirm）
 *      均已定义，且各自调用了正确的端点路径/HTTP 方法。
 *   ⑨ 错误提示统一走 siApiErr（不新造 SI_ERR_TEXT 映射条目——与既有 siModalFastReleaseAuthorize/
 *      Revoke/PostReleaseAccept 三个端点同一措辞范式）。
 *   ⑩ components.css 第 15 层 sem-fastlane token 六值齐全 + .u-status-badge.sem-fastlane 规则存在
 *      （轻量交叉检查——主契约已在 verify-unify-static.js/verify-badge-alias.js 的 SEM_TIERS 通用
 *      机制覆盖，这里只加一道"本文件改动确实命中了那套机制"的显式证据，不重复其详尽断言）。
 *   ⑪ HTML 内联 <script> 语法有效（new Function 编译不执行，等价 node -c）。
 *
 * [值班筛选与类型卡·S2·2026-08-15 追加·SSOT=docs/local/系统迭代/
 * 任务_值班筛选与类型卡_长任务锚点_20260815.md §3 技术自决]（历史形态，S3 起已被下方「待我处理全
 * 角色卡」批次吸收改写——保留本段仅为沿革记录，⑫ 组当前真实内容见下段）：
 *   ⑫ siIsMyFastlanePending/siMatchStatFilter/siShouldRenderMyFastlaneCard 沙箱真执行、siRenderStats
 *      接线四条——独立「待我确认」值班卡形态，S3 起已被「待我处理」聚合卡吸收，siShouldRenderMyFastlane
 *      Card 已泛化改名（见下段），旧值班卡专属断言组已随之整组重写。
 *
 * [「待我处理」全角色卡·方案 20260825_v1.3 §6·Phase P Commit 4·2026-08-26 重写] ⑫ 组整组改写为
 * 「待我处理」聚合卡断言族（SSOT=docs/local/系统迭代/待我处理全角色卡_方案_20260825_v1.3.md §6）：
 *   ⑫ siIsMyPending（七身份聚合谓词，六现行+一历史兼容）/siMyPendingBreakdown（分段计次）/
 *      siShouldRenderConditionalCard（456-H1 冻结·由 siShouldRenderMyFastlaneCard 泛化改名，第三参
 *      cardKey）/siMatchStatFilter（'my_pending' 横切 key 路由）**沙箱真执行**（同 S2 先例：提取函数
 *      全文用 new Function 编译为真可调用函数，喂真实输入向量真执行断言）：
 *        · 泛化函数真值表五行（457-M1／codex 467 MED-1 承接：旧名可执行逻辑不存在／(0,'my_pending',
 *          'my_pending')=true／(0,'other','my_pending')=false／(3,'','my_pending')=true／siRenderStats
 *          以 'my_pending' 第三参调用=结构锚）。
 *        · 七身份逐个正反例（六现行+一历史兼容，各一正例+"状态对身份不对"+"身份对状态不对"反例）+
 *          codex 467 MED-2 回归（uid 桩=2**53/'not-a-number' → ⑤建单人⑦历史兼容均不命中）。
 *        · 3b「待处理」归属专项（admin 命中／开发 my_dev_pending=0 不命中／my_dev_pending=1 仍不命中
 *          =状态门拦住设计内预指派，N0-6b 增补）+ 3c 状态族单一事实源（结构锚：引用 SI_DEV_FAMILY_
 *          STATUSES 标识符本身，不含 '开发中' 字面量）+ 3d admin 归档分支覆盖「已生效」。
 *        · 并集断言：主计数（siIsMyPending 去重）恰 1 vs 分段计数（siMyPendingBreakdown 允许重叠）
 *          之和 > 1，title 固定含"（同一单可命中多个身份）"。
 *        · 值班卡已移除：'my_fastlane' 字面量在 siRenderStats/siMatchStatFilter 零出现（458-H1 判定
 *          全仓无旧键消费者，零字面量口径，无归一豁免入口）；siIsMyFastlanePending 仍定义且被
 *          siIsMyPending 原样调用（值班身份⑥分支）。
 *        · 465 LOW-2：紧凑 CSS（.si-wrap .u-stat-card 族）不外溢 components.css + 'u-stat-card' 产出点
 *          页面内恰 2 处（statsRow+typeCardsRow，防未来第三区被连带压缩无感知）。
 *   ⑫ 组补 siRenderStats 接线四条（M4-M7 四破法沿用，现改抓「待我处理」聚合卡接线）：①确实调用
 *      siIsMyPending（非内联另一份判据）②stats.unshift 确实挂在 siShouldRenderConditionalCard 条件内
 *      （非无条件插入）③卡 key 字面量与 siMatchStatFilter 路由字面量提取真实值逐字比对④计数基数确实
 *      来自 vis（同其余状态卡口径）。接线⑤a/⑤b（可点卡交互语义四件套）为通用断言，与本次改写无关，
 *      原样保留未改。
 *   [⑫前置] 提取/编译步骤（此前是裸 assert.ok/new Function，抛错会终止整个进程、不计入 check() 计数）
 *      改包进 check()；SI_STATUS_GROUPS 提取物新增键集 deepStrictEqual 核验（防括号计数被字面量骗偏
 *      导致静默截断成半个对象）。
 *   本文件此前两处各自手写的裸括号扫描器（旧的 body-only extractFunctionBody + S2 新增的
 *      extractFullFunctionText）均改为委派 scripts/lib/extract-function-body.js（S3 断言套件
 *      verify-sys-type-cards.js 已在用的同一份四轮硬化实现），不再各自维护一份扫描逻辑。
 *
 * [Opus 合并预筛 LOW-1 修复·2026-08-14] 全部断言面统一改走 bodyOf()（extractFunctionBody 结果先
 * stripComments 剥注释再扫描，照 verify-sys-list-badge-fields.js:57-59 同款范式）——本文件与
 * 姊妹文件的注释里大量出现被检查的函数名/字段名字面量（解释"为什么不该调用 X"之类），不剥注释会让
 * 否定式断言（"不应再调用 X"）被注释里同一字符串误判为红；姊妹文件 verify-sys-post-release-
 * panel-static.js 的同款既有缺口（stripComments 定义了但从未被调用）已顺手接线，非本批引入。
 *
 * [先行上线授权超时收回·S2 前端收口·2026-08-16 追加] 新增：
 *   ⑬ siFastlaneAuthWindowHtml（详情面板授权窗口/超时提示行，方案 20260816_v1.2 §6 展示面）：函数
 *      已定义 + 已并入 siRenderDrawer 的 fastlaneBlock 拼接（非孤立死函数）+ 过期/窗口内两条渲染
 *      分支存在（含醒目样式/"剩余约 N 小时"文案模式）+ 非残留场景兜底返回空串 + deadline 月日插值
 *      走 esc() 转义（既有转义纪律，同族先例见 siFastlaneAddExecutorModal 等）。
 *   ⑭ siModalFastReleaseRevoke 撤销弹窗：**现行语义见下方 [S2-fix3] 段**——单一撤销语义（reason 无条件
 *      必填+200 字校验）+响应 expired:true 并发分叉。（⚠️ 首版 ⑭ 曾按 isExpired 快照分叉设计，该分支
 *      已随用户裁定「按钮过点隐藏」整体删除，勿按旧描述理解本组断言——codex 426-LOW 清理，2026-08-16。）
 *   ⑮ 时间线三表（SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES）均已登记 fast_release_auth_expired
 *      （S1 遗留 LOW-4 收口，同 eta_auto_from_deadline 一带既有登记形态）。
 *
 * [S2-fix3·用户裁定·2026-08-16 追加] 撤销按钮"截止时间前一直存在、过了截止时间隐藏"：
 *   ⑬ siFastlaneAuthWindowHtml **不动**——过期红标是按钮隐藏后唯一剩下的 UI 痕迹，价值更高，本批零改。
 *   ⑭ 改为：撤销按钮显隐从 hasActiveAuth（残留镜像）摘出，改读 iss.fast_release_active_auth 消费投影
 *      （siRenderActions 新断言）；siModalFastReleaseRevoke 的 isExpired 快照分支（文案二选一/
 *      placeholder/reason 免必填与长度豁免）随按钮门控变更结构性不可达，已删除，回归单一撤销语义
 *      （reason 无条件必填+200字校验）；响应分叉（r.data.expired===true）保留，是并发窗口（用户开着
 *      详情跨过 8:00 提交撞到后端格4）下唯一存在理由，断言同步保留。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
// [S-fix 修复批·2026-08-15·4b] 全文函数提取统一走 scripts/lib/extract-function-body.js（406/407/408
//   四轮硬化的单点实现——有限状态词法扫描剥注释/字符串/正则字面量后再做括号深度计数，比本文件此前
//   两处各自手写的裸括号扫描器更抗"字符串/正则字面量里的假花括号"这类误判）。该模块返回**含函数签名**
//   的全文；下方 extractFunctionBody（本文件既有 body-only 契约，从首个 `{` 切）与 ⑫ 组的
//   extractFullFunctionText（S2 手写的裸括号扫描器）均改为薄包装，委派给它，不再各自维护一份扫描逻辑。
const { extractFunctionBody: extractFunctionFullText } = require('./lib/extract-function-body');

let passed = 0, failed = 0;
const failures = [];
function check(name, fn) {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (e) {
        failed++; failures.push({ name, err: e.message });
        console.log(`  ✗ ${name} — ${e.message}`);
    }
}

const htmlPath = path.join(__dirname, '..', 'public', 'Sys_Iteration.html');
const src = fs.readFileSync(htmlPath, 'utf8');
const cssPath = path.join(__dirname, '..', 'public', 'assets', 'css', 'components.css');
const css = fs.readFileSync(cssPath, 'utf8');

// [S-fix 4b] 本文件既有 body-only 契约（返回从首个 `{` 到匹配收尾 `}`，不含 "function name(...)"
//   签名文本）——全部既有 bodyOf() 调用点按此契约做 .includes()/正则匹配，故只切签名、不改其余行为，
//   对下游断言零影响。内部委派 scripts/lib/extract-function-body.js 的硬化实现，不再手写裸括号扫描器。
function extractFunctionBody(source, fnName) {
    const full = extractFunctionFullText(source, fnName);
    if (!full) return null;
    const braceIdx = full.indexOf('{');
    return braceIdx < 0 ? null : full.slice(braceIdx);
}
// [Opus 合并预筛 LOW-1 修复·2026-08-14] 剥行注释与块注释（照 verify-sys-list-badge-fields.js:57-59
// 同款范式）——本文件全部断言都在拿 extractFunctionBody 提取出的原始函数体做 .includes()/正则匹配，
// 而本文件自己的源码里到处写着"未见调用 siHasActiveFastReleaseAuth"「siFastlaneFlagHtml 未读
// fast_release_active_auth」这类**解释代码在做什么/不该做什么**的中文注释，注释原文常常原样含有
// 被检查的字面量（函数名/字段名/class 名）。若不剥注释，注释本身就能让"未见调用 X"这类否定式断言
// 误判为"看见了"（字符串确实出现在文本里，只是出现在注释而非可执行代码中）——与该守卫本身要防的
// "断言不是恒真"是同一类风险，只是载体从"HTML/前端源码"换成了"本守卫自己的被扫描对象"。
// 剥两类：块注释 `/* ... */`；行注释 `//`（用负向条件 `[^:]` 排除 `https://` 这类"冒号紧跟双斜杠"
// 场景误伤，与 list-badge-fields 同款纪律，不是本文件独立发明）。
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}
// 断言面统一入口——全部函数体提取一律走本函数（剥注释后再扫描），不直接调用 extractFunctionBody。
function bodyOf(fnName) {
    const raw = extractFunctionBody(src, fnName);
    return raw == null ? null : stripComments(raw);
}

console.log('— ① siFastlaneFlagHtml 已定义 + 并入列表行渲染 —');
check('siFastlaneFlagHtml 函数已定义', () => {
    assert.ok(bodyOf('siFastlaneFlagHtml'), '未提取到 siFastlaneFlagHtml 函数体');
});
check('renderSysIterationRows 已调用 siFastlaneFlagHtml（非孤立死函数）', () => {
    const body = bodyOf('renderSysIterationRows');
    assert.ok(body, '未提取到 renderSysIterationRows 函数体');
    assert.ok(body.includes('siFastlaneFlagHtml('), 'renderSysIterationRows 未调用 siFastlaneFlagHtml——徽章算出来了但从未拼进 flags（同 blocked 死分支同款漏法）');
});

console.log('— ② 徽章条件三件套 + 第 15 层 sem-fastlane 配色 + 0/0 场景不返回空串 —');
check('徽章条件齐全：type===bug ∧ status===待验证 ∧ fast_release_active_auth', () => {
    const body = bodyOf('siFastlaneFlagHtml');
    assert.ok(body, '未提取到 siFastlaneFlagHtml 函数体');
    assert.ok(body.includes("i.type !== 'bug'") || body.includes("i.type === 'bug'"), '未见 type===bug 判据');
    assert.ok(body.includes("i.status !== '待验证'") || body.includes("i.status === '待验证'"), '未见 status===待验证 判据');
    assert.ok(body.includes('i.fast_release_active_auth'), '未见 fast_release_active_auth 判据——徽章条件可能自拼了授权判据（禁止，S6 已算好该布尔值）');
});
check('未自拼六列授权判据（不应出现 fast_release_auth_at 等原始六列字段名——列表端点未投影这些列）', () => {
    const body = bodyOf('siFastlaneFlagHtml');
    for (const col of ['fast_release_auth_at', 'fast_release_revoked_at', 'fast_release_consumed_at', 'reopened_at']) {
        assert.ok(!body.includes(col), `siFastlaneFlagHtml 不应引用 ${col}（列表端点未投影该列，出现即说明误读了未定义字段或自拼了六列判据）`);
    }
});
check('渲染走第 15 层 sem-fastlane token（u-status-badge sem-fastlane）', () => {
    const body = bodyOf('siFastlaneFlagHtml');
    assert.ok(/class="u-status-badge sem-fastlane"/.test(body), '未见 class="u-status-badge sem-fastlane"——徽章应走新增第 15 层 token 而非临时内联色值');
});
// [Opus 合并预筛 MED-1 修复·2026-08-14] 徽章与标题/前序 flag 间需要间距载体（class 或 style），
// 防止再次退化成零间距贴靠——只查"载体存在"，不判间距数值是否恰好 6px（那是视觉细节，交给 S8
// Playwright 实测；本条只钉"根本没做任何间距处理"这类完全遗漏，同名死分支同款漏法）。同时反向锁定
// 预筛明确警告的错法：直接叠加 si-flag 类会因同特异性源序反杀覆盖徽章自身 600 字重，不只是"未做"
// 要防，"用错误方式做"同样要防。
check('徽章带间距载体（class 或 style，防与标题/前一个 flag 零间距贴靠）；未直接叠加 si-flag 类（防同特异性源序反杀覆盖徽章字重）', () => {
    const body = bodyOf('siFastlaneFlagHtml');
    const badgeTagMatch = body.match(/<span class="u-status-badge sem-fastlane"[^>]*>/);
    assert.ok(badgeTagMatch, '未找到徽章 <span> 标签本体（class="u-status-badge sem-fastlane" 开头）');
    const tag = badgeTagMatch[0];
    assert.ok(!/\bsi-flag\b/.test(tag), '徽章标签不应直接叠加 si-flag 类——.si-flag 的 font-weight:700 与 .u-status-badge 自身 600 字重同选择器特异性、源序更晚会反杀覆盖，这是预筛 MED-1 明确警告的错法');
    const hasSpacingClass = /class="[^"]*\bsi-fastlane-flag\b/.test(tag);
    const hasSpacingStyle = /style="[^"]*margin-left\s*:/.test(tag);
    assert.ok(hasSpacingClass || hasSpacingStyle, '徽章标签既无间距修饰类也无内联 style margin-left——会与标题/前序 flag 零间距贴靠（预筛 MED-1 原始缺口）');
});
check('0/0 场景（total===0）不返回空串——方案 §4-1「待配置执行人」入口须可见', () => {
    const body = bodyOf('siFastlaneFlagHtml');
    // 静态层面无法真正执行函数，退而求其次：确认代码路径里"total===0"分支落在 return 空串判断
    // 之后（即已过 badge 条件门），且该分支产出的字符串不是空串字面量。
    assert.ok(/total === 0/.test(body), '未见 total===0 的 0/0 场景专门分支处理（应产出"待配置执行人"提示，非与非 0/0 场景走同一份无区分文案）');
    assert.ok(body.includes('待配置执行人'), '0/0 场景未见"待配置执行人"提示文案（方案 §4-1 明确要求 0/0 徽章可见，作为 admin 发现入口）');
});

console.log('— ③④ siFastlaneExecSectionHtml 已定义 + 并入抽屉渲染 + 显隐两支析取 —');
check('siFastlaneExecSectionHtml 函数已定义', () => {
    assert.ok(bodyOf('siFastlaneExecSectionHtml'), '未提取到 siFastlaneExecSectionHtml 函数体');
});
check('siFastlaneExecHasContent 函数已定义（显隐判据抽出，非内联散落）', () => {
    assert.ok(bodyOf('siFastlaneExecHasContent'), '未提取到 siFastlaneExecHasContent 函数体');
});
check('siFastlaneExecHasContent 显隐条件为两支析取（badgeCond ∨ executors 非空）', () => {
    const body = bodyOf('siFastlaneExecHasContent');
    assert.ok(/badgeCond/.test(body), '未见 badgeCond 变量（挂牌态判定分支）');
    assert.ok(/executors\s*&&\s*executors\.length/.test(body), '未见 executors 非空判定分支（consumed 单部署留痕展示依赖此分支）');
    assert.ok(/badgeCond\s*\|\|/.test(body), '两支应为析取（||）关系，不应是合取（&&）——合取会漏掉 0/0 挂牌态或 consumed 留痕态其中一种场景');
});
// [Opus 预筛 S6-MED-1 修复·判官归一] 执行区显隐/挂牌态判据改读后端 DTO 布尔字段
// iss.fast_release_active_auth（详情端点已同步补齐，与列表端点同名字段同一份 isActiveFastReleaseAuth
// 判据），不再调用前端镜像谓词 siHasActiveFastReleaseAuth——避免"执行区自己读六列原始字段判断"与
// "列表已算好布尔、前端只读"两条路线并存的隐患。镜像谓词本身**未删**，授权按钮"重新"措辞
// （siRenderActions）与授权弹窗标题措辞（siModalFastReleaseAuthorize）两处语境仍在消费，故只断言
// "执行区不再引用"，不断言"全仓零引用"（那两处不消费 fast_release_executors/fast_release_exec_progress，
// 没有对应的 DTO 布尔字段可读，继续保留前端镜像判据是合理选择，非漏改）。[S2-fix3 ①·用户裁定]
// 撤销按钮显隐已从这份残留镜像判据里摘出改读消费投影（详见下方新增检查），不再属于"仍在消费"之列。
check('siFastlaneExecHasContent 改读 DTO 布尔字段 iss.fast_release_active_auth（不再调用前端镜像谓词 siHasActiveFastReleaseAuth，判官归一）', () => {
    const body = bodyOf('siFastlaneExecHasContent');
    assert.ok(body.includes('iss.fast_release_active_auth'), '未见读取 iss.fast_release_active_auth——执行区显隐判据应改读后端 DTO 布尔字段（S6-MED-1 修复）');
    assert.ok(!body.includes('siHasActiveFastReleaseAuth('), 'siFastlaneExecHasContent 不应再调用 siHasActiveFastReleaseAuth（判官归一后应统一读 DTO 布尔字段，同列表端路线）');
});
check('siFastlaneExecSectionHtml 的 isStaged 判据同样改读 iss.fast_release_active_auth（与 siFastlaneExecHasContent 同一份判据，不各写一份）', () => {
    const body = bodyOf('siFastlaneExecSectionHtml');
    assert.ok(/isStaged\s*=\s*iss\.type\s*===\s*'bug'\s*&&\s*iss\.status\s*===\s*'待验证'\s*&&\s*Number\(iss\.fast_release_active_auth\)\s*===\s*1/.test(body),
        '未见 isStaged 变量按 iss.fast_release_active_auth 判定——加/移人入口的挂牌态判据应与显隐判据同源');
    assert.ok(!body.includes('siHasActiveFastReleaseAuth('), 'siFastlaneExecSectionHtml 不应再调用 siHasActiveFastReleaseAuth');
});
check('siHasActiveFastReleaseAuth 镜像谓词仍被其余语境（授权按钮"重新"措辞、授权弹窗标题）消费，未被误删', () => {
    const actionsBody = bodyOf('siRenderActions');
    const modalBody = bodyOf('siModalFastReleaseAuthorize');
    assert.ok(actionsBody && actionsBody.includes('siHasActiveFastReleaseAuth('), 'siRenderActions 应仍调用 siHasActiveFastReleaseAuth（授权按钮"重新"措辞；S2-fix3 后撤销按钮已改口径，见下方新增检查）');
    assert.ok(modalBody && modalBody.includes('siHasActiveFastReleaseAuth('), 'siModalFastReleaseAuthorize 应仍调用 siHasActiveFastReleaseAuth（"重新授权"标题措辞）');
});
// [S2-fix3 ①·用户裁定新增] 撤销按钮显隐门控——"截止时间前一直存在、过了截止时间隐藏"，改读服务端
// 可消费投影 iss.fast_release_active_auth（8 点后自动 0，前端零自推导），不再跟随残留镜像 hasActiveAuth
// （不含时间语义，过期后仍为 true，会让按钮"过点不隐藏"，与用户裁定矛盾）。授权按钮"重新"标签措辞
// 保持不受影响（下条回归断言）。
check('[S2-fix3 ①] 撤销按钮显隐改读 iss.fast_release_active_auth 消费投影（不再跟随 hasActiveAuth 残留镜像）', () => {
    const body = bodyOf('siRenderActions');
    assert.ok(body, '未提取到 siRenderActions 函数体');
    assert.ok(/if \(Number\(iss\.fast_release_active_auth\) === 1\) \{\s*fastReleaseBtns \+= `<button class="u-btn-danger u-btn-sm" onclick="siModalFastReleaseRevoke\(siDetail\.issue\)">撤销先行上线授权<\/button>`;/.test(body), '未见撤销按钮门控 if (Number(iss.fast_release_active_auth) === 1) { ...撤销先行上线授权... }——按钮显隐应改读消费投影');
    assert.ok(!/if \(hasActiveAuth\) \{\s*fastReleaseBtns \+= `<button class="u-btn-danger/.test(body), '撤销按钮不应仍走 if (hasActiveAuth) 门控（残留镜像不含时间，过期后仍会显示，与用户裁定"过了截止时间隐藏"矛盾）');
});
check('[S2-fix3 ①回归] 授权按钮"重新"标签措辞未受牵连，仍绑 hasActiveAuth（残留语义——是否有旧授权记录会被覆盖，与是否过消费窗口无关）', () => {
    const body = bodyOf('siRenderActions');
    assert.ok(/\$\{hasActiveAuth \? '重新先行上线授权' : '先行上线授权'\}/.test(body), '未见授权按钮"重新"标签三元表达式——该措辞应仍绑定 hasActiveAuth（残留镜像），不应被撤销按钮门控切换误伤');
});
check('siRenderDrawer 已计算 fastlaneBlock 并并入 siDBody 最终拼接（非孤立死变量）', () => {
    const body = bodyOf('siRenderDrawer');
    assert.ok(body, '未提取到 siRenderDrawer 函数体');
    assert.ok(body.includes('siFastlaneExecSectionHtml('), 'siRenderDrawer 未调用 siFastlaneExecSectionHtml');
    const tail = body.slice(body.lastIndexOf("document.getElementById('siDBody').innerHTML"));
    assert.ok(tail.includes('fastlaneBlock'), 'siDBody 最终拼接未包含 fastlaneBlock——区块算出来了但从未渲染（同 blocked 死分支同款漏法）');
});

console.log('— ⑤ 「执行先行上线」按钮仅本人在册且 pending 时渲染 —');
check('myBtn 渲染条件为 myRow && myRow.exec_status===pending', () => {
    const body = bodyOf('siFastlaneExecSectionHtml');
    assert.ok(/myRow\s*&&\s*myRow\.exec_status\s*===\s*'pending'/.test(body), '未见 myRow && myRow.exec_status===\'pending\' 的按钮显隐条件');
    assert.ok(body.includes('siFastlaneExecConfirm('), '未见「执行先行上线」按钮 onclick 调用 siFastlaneExecConfirm');
});

console.log('— ⑥⑦ admin 加/移人入口权限与冻结/挂牌态门控 —');
check('「+ 添加执行人」仅 isAdminUser && isStaged 渲染，done_count>0 时置灰而非隐藏', () => {
    const body = bodyOf('siFastlaneExecSectionHtml');
    assert.ok(/isAdminUser\s*&&\s*isStaged/.test(body), '未见 isAdminUser && isStaged 的加人入口显隐条件');
    assert.ok(/doneCount > 0/.test(body), '未见 doneCount>0 的冻结判据（方案 372-H1\' 首 done 后冻结加人）');
    assert.ok(/disabled title="部署已开始不可加人/.test(body), '冻结态应为 disabled+title 提示（置灰非隐藏）——未见对应文案');
});
check('「移除」按钮仅 isAdminUser && isStaged && !isDone 时渲染', () => {
    const body = bodyOf('siFastlaneExecSectionHtml');
    assert.ok(/isAdminUser\s*&&\s*isStaged\s*&&\s*!isDone/.test(body), '未见 isAdminUser && isStaged && !isDone 的移除按钮显隐条件（已 done 行结构性移不掉，方案 §5-⑨）');
    assert.ok(body.includes('siFastlaneRemoveExecutor('), '未见「移除」按钮 onclick 调用 siFastlaneRemoveExecutor');
});

console.log('— ⑧ 三个动作函数定义 + 端点路径/方法正确 —');
check('siFastlaneAddExecutorModal 已定义，读候选清单并 POST .../fast-release-executors', () => {
    const body = bodyOf('siFastlaneAddExecutorModal');
    assert.ok(body, '未提取到 siFastlaneAddExecutorModal 函数体');
    assert.ok(body.includes('/sys-releases/executor-candidates'), '未见调用 executor-candidates 候选清单端点');
    assert.ok(body.includes('/fast-release-executors') && /method:\s*'POST'/.test(body), '未见 POST .../fast-release-executors 调用');
    assert.ok(body.includes('user_id'), '请求体未见 user_id 字段');
});
check('siFastlaneRemoveExecutor 已定义，DELETE .../fast-release-executors/:userId', () => {
    const body = bodyOf('siFastlaneRemoveExecutor');
    assert.ok(body, '未提取到 siFastlaneRemoveExecutor 函数体');
    assert.ok(body.includes('/fast-release-executors/') && /method:\s*'DELETE'/.test(body), '未见 DELETE .../fast-release-executors/:userId 调用');
    assert.ok(body.includes('confirm('), '未见二次确认（confirm()）——移除执行人是不可逆写副作用，应有确认交互');
});
check('siFastlaneExecConfirm 已定义，POST .../fast-release-exec-confirm，按 flipped 分岔文案', () => {
    const body = bodyOf('siFastlaneExecConfirm');
    assert.ok(body, '未提取到 siFastlaneExecConfirm 函数体');
    assert.ok(body.includes('/fast-release-exec-confirm') && /method:\s*'POST'/.test(body), '未见 POST .../fast-release-exec-confirm 调用');
    assert.ok(body.includes('d.flipped'), '未见按响应 flipped 字段分岔提示文案——末位确认会同时翻牌，应与非末位场景区分提示');
});

console.log('— ⑨ 错误提示统一走 siApiErr（不新造 SI_ERR_TEXT 映射条目） —');
for (const fn of ['siFastlaneAddExecutorModal', 'siFastlaneRemoveExecutor', 'siFastlaneExecConfirm']) {
    check(`${fn} 失败分支调用 siApiErr（不调用 siErrText/siNotifyErr 那套通知专用映射）`, () => {
        const body = bodyOf(fn);
        assert.ok(body.includes('siApiErr('), `${fn} 未见调用 siApiErr`);
        assert.ok(!body.includes('siErrText(') && !body.includes('siNotifyErr('), `${fn} 不应调用 siErrText/siNotifyErr（这几个端点不属通知链路，应走 siApiErr 直接透出后端 error 文案）`);
    });
}
check('未新增 FASTLANE_ROSTER_*/FAST_RELEASE_EXEC_* 系列码进 SI_ERR_TEXT（siApiErr 已直接透出后端完整中文句）', () => {
    const errTextStart = src.indexOf('const SI_ERR_TEXT = Object.freeze({');
    assert.ok(errTextStart >= 0, '未找到 SI_ERR_TEXT 常量声明');
    const errTextEnd = src.indexOf('});', errTextStart);
    const block = src.slice(errTextStart, errTextEnd);
    for (const code of ['FASTLANE_ROSTER_FROZEN', 'FASTLANE_ROSTER_NOT_STAGED', 'FASTLANE_DEPLOY_IN_PROGRESS', 'FASTLANE_ROSTER_ALREADY_ADDED', 'FAST_RELEASE_EXEC_NOT_ROSTERED', 'FAST_RELEASE_EXEC_CONFIRM_INVALID']) {
        assert.ok(!block.includes(code), `SI_ERR_TEXT 不应新增 ${code} 映射条目——本组端点统一走 siApiErr 直接透出后端文案（同既有 siModalFastReleaseAuthorize 等三端点范式），新增映射会制造与后端消息漂移的第二份翻译`);
    }
});

console.log('— ⑩ components.css 第 15 层 sem-fastlane token 交叉验证 —');
check('components.css :root 含 --sem-fastlane-* 六值', () => {
    for (const suf of ['bg', 'fg', 'bd', 'bds', 'dot', 'deco']) {
        assert.ok(css.includes(`--sem-fastlane-${suf}:`), `components.css 未见 --sem-fastlane-${suf} 定义`);
    }
});
check('components.css 含 .u-status-badge.sem-fastlane 规则，且六键均引用本层 token', () => {
    const m = css.match(/\.u-status-badge\.sem-fastlane\s*\{([^}]*)\}/);
    assert.ok(m, '未找到 .u-status-badge.sem-fastlane 规则（精确选择器）');
    const body = m[1];
    for (const suf of ['bg', 'fg', 'bd', 'bds', 'dot', 'deco']) {
        assert.ok(body.includes(`var(--sem-fastlane-${suf})`), `.u-status-badge.sem-fastlane 的 --sb-${suf} 未引用 var(--sem-fastlane-${suf})`);
    }
});

console.log('— ⑪ HTML 内联 <script> 语法有效 —');
check('Sys_Iteration.html 内联脚本可编译（new Function，不执行）', () => {
    const scripts = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(scripts.length > 0, '未找到内联 <script> 块');
    for (const s of scripts) {
        // eslint-disable-next-line no-new-func
        new Function(s);
    }
});

console.log('— ⑫ 「待我处理」聚合卡沙箱真执行（siIsMyPending/siMyPendingBreakdown/siShouldRenderConditionalCard/siMatchStatFilter） —');
{
    // 真执行范式（照 verify-sys-eta-generation.js [A1]/[R6] 先例）：静态 .includes()/正则只能证明
    //   "字符串出现过"，证不了"七身份逐一命中/不命中会不会正确翻转判定"这类行为——本组从 HTML 提取函数
    //   全文（含签名，非 bodyOf() 剥壳后的纯体，需要签名才能 new Function 后按名取出），编译为真
    //   可调用函数，喂真实输入向量真执行断言。isAdmin()/currentUser 两个全局符号用可控桩注入（沙箱内
    //   按每条用例的 isAdminVal/currentUserVal 现编译一份，不共用一个固定全局状态）。
    const extractFullFunctionText = (fnName) => extractFunctionFullText(src, fnName);
    // SI_STATUS_GROUPS 是 `const X = { ... };` 常量声明（非函数），shared 模块的 extractFunctionBody
    //   只支持 `function name(...) {` 形态，故此处仍保留本地裸括号扫描器（无共用替代品可用）；
    //   siMatchStatFilter/siIsMyPending 真执行时需要真实值——从源码提取而非在本文件手抄一份，避免
    //   两份状态组定义各自维护、后续新增状态组时漂移。[S-fix 4c] 提取物额外过键集完整性核验，防
    //   括号计数被字面量骗偏导致静默截断成半个对象却不报错。
    function extractConstObjectText(constName) {
        const startIdx = src.indexOf(`const ${constName} = {`);
        if (startIdx < 0) return null;
        const braceStart = src.indexOf('{', startIdx);
        let depth = 0, i = braceStart;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(startIdx, i + 1) + ';'; }
        }
        return null;
    }
    // [「待我处理」全角色卡 C4 新增] SI_DEV_FAMILY_STATUSES 是 `const X = [ ... ];` 数组字面量（非对象），
    //   extractConstObjectText 的花括号扫描器不适用，另写一份方括号深度扫描——3b③/3c 两条活体变异需要
    //   拿到本常量的真实文本以便在真实文件上做临时替换（见本文件外的报告：真实编辑+重跑+还原，非本
    //   文件内部字符串替换沙箱），此处只负责"提取到 + 编译出基线值"两件事。
    function extractConstArrayText(constName) {
        const startIdx = src.indexOf(`const ${constName} = [`);
        if (startIdx < 0) return null;
        const bracketStart = src.indexOf('[', startIdx);
        let depth = 0, i = bracketStart;
        for (; i < src.length; i++) {
            if (src[i] === '[') depth++;
            else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(startIdx, i + 1) + ';'; }
        }
        return null;
    }

    const fnIsMyFastlanePending = extractFullFunctionText('siIsMyFastlanePending');
    const fnIsMyPending = extractFullFunctionText('siIsMyPending');
    const fnMyPendingBreakdown = extractFullFunctionText('siMyPendingBreakdown');
    const fnShouldRenderConditionalCard = extractFullFunctionText('siShouldRenderConditionalCard');
    const fnMatchStatFilter = extractFullFunctionText('siMatchStatFilter');
    const statusGroupsText = extractConstObjectText('SI_STATUS_GROUPS');
    const devFamilyStatusesText = extractConstArrayText('SI_DEV_FAMILY_STATUSES');
    // [归属收紧 2026-08-27] 分支① 的身份门从 isAdmin() 换成 siIsPlatformAdmin()——注入**真实实现+真实
    //   常量**（不在本文件手抄第二份判据，同 :361 既有纪律），这样 currentUser.username 成为可控输入，
    //   下方 ① 组正反例测的是线上真判据。
    const fnIsPlatformAdmin = extractFullFunctionText('siIsPlatformAdmin');
    // [2026-08-27 #89 修复·codex 479 LOW-1] 建单人验收/归档半区已抽成共享 helper，谓词与 breakdown
    //   都调用它 ⇒ 沙箱必须注入**真实实现**（不手抄第二份判据，同本段既有纪律）。
    const fnIsCreatorAcceptArchivePending = extractFullFunctionText('siIsCreatorAcceptArchivePending');
    // [上线排期三态徽章·待办侧 2026-08-27] 分支⑧ 同样抽成独立函数，沙箱注入真实实现。
    //   [2026-08-27 二次拍板·去重拆除] 原「成员条件 + 动态代表 map + 谓词」三件套已并回单一谓词
    //   （siIsMyReleaseNeedsExecutor / siIsMyReleaseExecPending 直接持有全部条件，siComputeReleaseRepMap
    //   与 *Member 对已删）——本组提取随之收敛为两个谓词函数。
    const fnIsMyReleaseNeedsExecutor = extractFullFunctionText('siIsMyReleaseNeedsExecutor');
    const fnCurrentUid = extractFullFunctionText('siCurrentUid');
    const fnIsMyReleaseExecPending = extractFullFunctionText('siIsMyReleaseExecPending');
    // [未来上线日期执行闸·待办联动 2026-08-27] ⑨ 谓词新增日期条件（未到期不进卡），依赖两个日期
    //   helper——沙箱必须注入真实实现（不打桩恒 false，否则"未来日期仍进卡"这类回归测不出来）。
    const fnDateOnly = extractFullFunctionText('siDateOnly');
    const fnIsReleaseDateFuture = extractFullFunctionText('siIsReleaseDateFuture');
    const fnIsMyReleaseSchedulePending = extractFullFunctionText('siIsMyReleaseSchedulePending');   // ⑩ helper（483 LOW-1 抽出）
    const platformAdminUsernamesText = extractConstArrayText('SI_PLATFORM_ADMIN_USERNAMES');
    // [2026-09-04 #116 缺口修复] 分支④b（绑定受理人的待指派/待处理半区）同样抽成共享 helper（谓词与
    //   breakdown 两处共用）⇒ 沙箱注入**真实实现 + 真实常量**，不在本文件手抄第二份判据（同 ①b 纪律）。
    const fnIsMyIntakeAssignPending = extractFullFunctionText('siIsMyIntakeAssignPending');
    const assignPendingStatusesText = extractConstArrayText('SI_ASSIGN_PENDING_STATUSES');

    // [S-fix 4c 沿用] 提取前置全部包进 check() 计数体系——裸调用抛错会终止整个进程、其它断言不计数。
    check('[⑫前置] 六函数+三常量全部提取成功（提不到=守卫空转，不能当通过）', () => {
        assert.ok(fnIsMyFastlanePending, '未提取到 siIsMyFastlanePending 函数全文');
        assert.ok(fnIsMyPending, '未提取到 siIsMyPending 函数全文');
        assert.ok(fnMyPendingBreakdown, '未提取到 siMyPendingBreakdown 函数全文');
        assert.ok(fnShouldRenderConditionalCard, '未提取到 siShouldRenderConditionalCard 函数全文（456-H1 泛化改名后的新名）');
        assert.ok(fnMatchStatFilter, '未提取到 siMatchStatFilter 函数全文');
        assert.ok(fnIsPlatformAdmin, '未提取到 siIsPlatformAdmin 函数全文（归属收紧 2026-08-27 新增，分支① 身份门）');
        assert.ok(fnIsCreatorAcceptArchivePending, '未提取到 siIsCreatorAcceptArchivePending 函数全文（#89 修复新增，分支①b 建单人验收/归档半区——提不到则 ①b 全组空转）');
        assert.ok(fnIsMyReleaseNeedsExecutor, '未提取到 siIsMyReleaseNeedsExecutor 函数全文（分支⑧——提不到则 ⑧ 全组空转）');
        assert.ok(fnCurrentUid, '未提取到 siCurrentUid（uid 归一单点实现）');
        assert.ok(fnIsMyReleaseExecPending, '未提取到 siIsMyReleaseExecPending（⑨ 谓词——提不到则 ⑨ 全组空转）');
        assert.ok(fnDateOnly, '未提取到 siDateOnly（⑨ 日期联动依赖——提不到则日期用例整组空转）');
        assert.ok(fnIsReleaseDateFuture, '未提取到 siIsReleaseDateFuture（未来上线日期判定 helper——提不到则 ⑨ 日期联动空转）');
        assert.ok(fnIsMyReleaseSchedulePending, '未提取到 siIsMyReleaseSchedulePending（⑩ helper——提不到则 ⑩ 全组空转）');
        assert.ok(statusGroupsText, '未提取到 SI_STATUS_GROUPS 常量全文');
        assert.ok(devFamilyStatusesText, '未提取到 SI_DEV_FAMILY_STATUSES 常量全文');
        assert.ok(fnIsMyIntakeAssignPending, '未提取到 siIsMyIntakeAssignPending 函数全文（#116 修复新增，分支④b 绑定受理人的指派半区——提不到则 ④b 全组空转）');
        assert.ok(assignPendingStatusesText, '未提取到 SI_ASSIGN_PENDING_STATUSES 常量全文（分支①与④b 共用的 assign 前置态集合）');
        assert.ok(platformAdminUsernamesText, '未提取到 SI_PLATFORM_ADMIN_USERNAMES 常量全文（若被改写成 Object.freeze([...]) 形态，extractConstArrayText 会提不到 ⇒ ① 组正反例全部空转，故在此前置判红）');
    });
    check('[归属收紧 2026-08-27] SI_PLATFORM_ADMIN_USERNAMES 提取物非空且含 admin（空数组=没有任何人能看到待指派/待验证/待归档，是静默失效而非报错）', () => {
        // eslint-disable-next-line no-new-func
        const arr = new Function(`${platformAdminUsernamesText}\nreturn SI_PLATFORM_ADMIN_USERNAMES;`)();
        assert.ok(Array.isArray(arr) && arr.length > 0, `SI_PLATFORM_ADMIN_USERNAMES 应为非空数组，实得 ${JSON.stringify(arr)}`);
        assert.ok(arr.includes('admin'), `SI_PLATFORM_ADMIN_USERNAMES 应含 'admin'（生产平台管理员账号用户名）——若确要改名/换号，请连同本断言与 Sys_Iteration.html 该常量注释一起改，不要只改一头，实得 ${JSON.stringify(arr)}`);
    });
    check('[457-M1 真值表行1] 旧名 siShouldRenderMyFastlaneCard 可执行逻辑不存在（泛化改名后不应再留同名可执行函数，否则说明改名不彻底/留了兼容包袱）', () => {
        const oldFn = extractFullFunctionText('siShouldRenderMyFastlaneCard');
        assert.ok(!oldFn, `旧名函数仍可提取到可执行逻辑——456-H1 冻结的泛化改名应已删除旧名，实得非空文本（前 80 字符）：${oldFn && oldFn.slice(0, 80)}`);
    });
    check('[⑫前置] SI_STATUS_GROUPS 提取物键集完整（防提取静默截断——括号计数一旦被字面量骗偏，可能只切到半个对象却不报错，仍会 new Function 成功但少几个组）', () => {
        // eslint-disable-next-line no-new-func
        const statusGroupsObj = new Function(`${statusGroupsText}\nreturn SI_STATUS_GROUPS;`)();
        // [待我处理全角色卡 方案 v1.3 §3.2·P1] done 组拆为 pending_archive（待归档=已上线/已生效）+
        //   archived（已归档=已关闭），键集由 5 → 6。
        assert.deepStrictEqual(Object.keys(statusGroupsObj).sort(), ['acceptance', 'active', 'archived', 'paused', 'pending_archive', 'release'],
            `SI_STATUS_GROUPS 提取物键集应恰为这 6 个（排序后比对），实得 ${JSON.stringify(Object.keys(statusGroupsObj).sort())}`);
    });
    check('[⑫前置] SI_DEV_FAMILY_STATUSES 提取物基线值恰为 [开发中,处理中]（防提取静默截断；同时是 3b③/3c 两条活体变异的基线快照——变异前先证基线，变异后再证真的变了）', () => {
        // eslint-disable-next-line no-new-func
        const arr = new Function(`${devFamilyStatusesText}\nreturn SI_DEV_FAMILY_STATUSES;`)();
        assert.deepStrictEqual(arr, ['开发中', '处理中'], `SI_DEV_FAMILY_STATUSES 提取物应恰为 ['开发中','处理中']，实得 ${JSON.stringify(arr)}`);
    });
    check('[⑫前置·#116] SI_ASSIGN_PENDING_STATUSES 提取物恰为 [待指派,待处理]（防提取静默截断；同时钉住"两流对称"——出处 transitions.js 三条 assign 条目的 from 并集，漏掉 bug 流「待处理」会让 bug 单的受理人重新变成看不见）', () => {
        // eslint-disable-next-line no-new-func
        const arr = new Function(`${assignPendingStatusesText}\nreturn SI_ASSIGN_PENDING_STATUSES;`)();
        assert.deepStrictEqual(arr, ['待指派', '待处理'], `SI_ASSIGN_PENDING_STATUSES 提取物应恰为 ['待指派','待处理']，实得 ${JSON.stringify(arr)}`);
    });
    // ⭐ [codex 499 MED-1 收口] 上一条只是"前端常量 vs 守卫里手写的期望值"自比——两边都是手写字面量，
    //   后端将来给 assign 增删 from（如新增一个 assign 前置态）时，前端常量与本守卫可以**一起保持旧值
    //   全绿**，形成跨层静默漂移（守卫覆盖了自己，没覆盖真相源）。本条直接 require 后端状态机模块，
    //   按 action==='assign' 展开 from 并集与前端常量双向比对——真相源变了，本条当场判红。
    check('[#116·跨层真相源对拍] 前端 SI_ASSIGN_PENDING_STATUSES == 后端 transitions.js 全部 assign 条目的 from 并集（双向：前端多一个/少一个都红；后端改 from 而前端没跟，本条是唯一能发现的地方）', () => {
        const T = require(path.join(__dirname, '..', 'routes', 'sys-iteration', 'transitions.js')).TRANSITIONS;
        const backendFrom = [...new Set(
            Object.values(T).flat().filter((t) => t.action === 'assign').flatMap((t) => t.from || [])
        )].sort();
        assert.ok(backendFrom.length > 0, '后端 TRANSITIONS 里未找到任何 assign 条目——真相源提取失败，本条会空转，先修提取');
        // eslint-disable-next-line no-new-func
        const front = new Function(`${assignPendingStatusesText}\nreturn SI_ASSIGN_PENDING_STATUSES;`)();
        assert.deepStrictEqual([...front].sort(), backendFrom,
            `前端 assign 前置态常量与后端状态机不一致：前端=${JSON.stringify([...front].sort())} 后端=${JSON.stringify(backendFrom)}——两者必须同集合，否则受理人的待办面与他实际能做的动作错位`);
    });

    // 编译工厂——每条用例按自己的 isAdminVal/currentUserVal 现编译一份（互不干扰，非共用一份可变全局态）。
    function stubText(isAdminVal, currentUserVal) {
        return `function isAdmin() { return ${JSON.stringify(!!isAdminVal)}; }\nconst currentUser = ${currentUserVal === undefined ? 'null' : JSON.stringify(currentUserVal)};`;
    }
    function compile(returnName, extraTexts, isAdminVal, currentUserVal) {
        // [#116] assignPendingStatusesText 必须排在 fnIsMyIntakeAssignPending 之前——const 有 TDZ，
        //   虽然函数体内引用要到调用时才求值（顺序理论上无所谓），但常量统一前置是本 parts 既有排布，
        //   照旧不破例。
        const parts = [stubText(isAdminVal, currentUserVal), statusGroupsText, devFamilyStatusesText, assignPendingStatusesText, platformAdminUsernamesText, fnIsPlatformAdmin, fnIsCreatorAcceptArchivePending, fnIsMyIntakeAssignPending, fnCurrentUid, fnDateOnly, fnIsReleaseDateFuture, fnIsMyReleaseNeedsExecutor, fnIsMyReleaseExecPending, fnIsMyReleaseSchedulePending, fnIsMyFastlanePending, ...extraTexts, `return ${returnName};`];
        // eslint-disable-next-line no-new-func
        return new Function(parts.join('\n'))();
    }
    // [归属收紧 2026-08-27] 两个具名用户桩——⑫ 段全域共用。分支① 自本次起要求 role='admin' ∧ username
    //   ∈ 白名单，凡是"以 admin 身份命中分支①"的既有用例都必须带上平台管理员的 username（此前传 null
    //   即可，因为判据只看 isAdmin()）。ROLE_ADMIN_BIZ_USER 用生产真实账号形态（示例用户B demo_user_b），是本次
    //   改动的靶心反例。
    const PLATFORM_ADMIN_USER = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
    const ROLE_ADMIN_BIZ_USER = { id: 18, username: 'demo_user_b', display_name: '示例用户B', role: 'admin' };
    const isMyPendingWith = (isAdminVal, currentUserVal) => compile('siIsMyPending', [fnIsMyPending], isAdminVal, currentUserVal);
    // [2026-08-27 二次拍板·去重拆除] 谓词已是纯按行判定（无代表 map、无跨行状态），本 helper 保留
    //   「喂 list 判某一行」的调用形态——⑧⑨⑩ 既有用例的聚合断言（同批次几张命中几张）仍经它表达。
    function myPendingInList(currentUserVal, list, targetId) {
        const fn = isMyPendingWith(false, currentUserVal);
        const item = list.find(x => Number(x.id) === Number(targetId));
        assert.ok(item, `用例数据错误：list 中找不到 id=${targetId}`);
        return fn(item);
    }
    const breakdownWith = (isAdminVal, currentUserVal) => compile('siMyPendingBreakdown', [fnMyPendingBreakdown], isAdminVal, currentUserVal);
    const matchStatFilterWith = (isAdminVal, currentUserVal) => compile('siMatchStatFilter', [fnIsMyPending, fnMatchStatFilter], isAdminVal, currentUserVal);

    check('[⑫前置] siIsMyPending 可编译（默认桩 isAdmin=false/currentUser=null）', () => {
        assert.strictEqual(typeof isMyPendingWith(false, null), 'function', 'siIsMyPending 应可编译为函数');
    });
    check('[⑫前置] siMyPendingBreakdown 可编译', () => {
        assert.strictEqual(typeof breakdownWith(false, null), 'function', 'siMyPendingBreakdown 应可编译为函数');
    });
    check('[⑫前置] siShouldRenderConditionalCard 可编译（独立于上两条——真值表家族依赖本函数，不得被聚合谓词改动连坐，3ed63b9 三独立 check 纪律）', () => {
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${fnShouldRenderConditionalCard}\nreturn siShouldRenderConditionalCard;`)();
        assert.strictEqual(typeof fn, 'function', 'siShouldRenderConditionalCard 应可编译为函数');
    });
    check('[⑫前置] siMatchStatFilter 可编译（独立于上三条——拆组归属家族依赖本函数，不得被聚合卡改名连坐）', () => {
        assert.strictEqual(typeof matchStatFilterWith(false, null), 'function', 'siMatchStatFilter 应可编译为函数');
    });

    // 每条用例统一走本 helper：编译→真执行→比对，message 里带上完整输入，红了就能直接看出是哪个身份
    // /哪个字段翻了车（"实现坏成什么样这条会红"落在每条用例自身的输入设计里，非事后补一句话）。
    function assertIsMyPending(label, isAdminVal, currentUserVal, item, expected) {
        check(label, () => {
            const fn = isMyPendingWith(isAdminVal, currentUserVal);
            const actual = fn(item);
            assert.strictEqual(actual, expected,
                `siIsMyPending(${JSON.stringify(item)})（isAdmin=${isAdminVal}, currentUser=${JSON.stringify(currentUserVal)}）应为 ${expected}，实得 ${actual}`);
        });
    }

    console.log('  — siShouldRenderConditionalCard 真值表五行（457-M1／codex 467 MED-1 承接：泛化提取三参改抓 cardKey） —');
    {
        let shouldRenderCard;
        check('[前置] siShouldRenderConditionalCard 可编译（S4 预筛提示4：编译包进 check，失败红在此处而非匿名抛错）', () => {
            // eslint-disable-next-line no-new-func
            shouldRenderCard = new Function(`${fnShouldRenderConditionalCard}\nreturn siShouldRenderConditionalCard;`)();
            assert.strictEqual(typeof shouldRenderCard, 'function');
        });
        check('真值表行2：(0,\'my_pending\',\'my_pending\') === true（count=0 但激活筛选正是本卡仍渲染——堵陷阱：处理完最后一单卡不消失；若第三参被忽略/内部仍硬编码旧字面量，本条会红）', () => {
            assert.strictEqual(shouldRenderCard(0, 'my_pending', 'my_pending'), true);
        });
        check('真值表行3：(0,\'other\',\'my_pending\') === false（count=0 且激活筛选是别的卡——应隐藏；若实现退化成恒 true，本条会红）', () => {
            assert.strictEqual(shouldRenderCard(0, 'other', 'my_pending'), false);
        });
        check('真值表行4：(3,\'\',\'my_pending\') === true（count>0 天然可见，不论激活态；若第一分支被误删，本条会红）', () => {
            assert.strictEqual(shouldRenderCard(3, '', 'my_pending'), true);
        });
        check('真值表行5：siRenderStats 以字面量 \'my_pending\' 第三参调用 siShouldRenderConditionalCard（结构锚，防"只换调用对象不改内部硬编码"回归——456-H1 冻结要防的坑，若调用点漏传第三参或参数顺序错位，本条会红）', () => {
            const body = bodyOf('siRenderStats');
            assert.ok(/siShouldRenderConditionalCard\(myPendingCount,\s*siActiveStat,\s*'my_pending'\)/.test(body),
                '未见 siShouldRenderConditionalCard(myPendingCount, siActiveStat, \'my_pending\') 调用');
        });
    }

    console.log('  — siIsMyPending：七身份逐个正反例（六现行+一历史兼容，各一正例+"状态对身份不对"+"身份对状态不对"反例；若该身份的身份门/状态门任一被误删，对应反例会由 false 翻红成 true） —');
    console.log('    ①admin —');
    // [归属收紧 2026-08-27] 分支① 身份门＝role='admin' **∧** username ∈ SI_PLATFORM_ADMIN_USERNAMES。
    //   两个条件各自的反例都要有，否则"收紧"可能只是写了个恒真/恒假的壳：
    //   · isAdmin=true + username=admin        → true （平台管理员，正例）
    //   · isAdmin=true + username=demo_user_b     → false（示例用户B：role 是 admin 但不是平台管理员——本次改动的靶心）
    //   · isAdmin=false + username=admin       → false（防有人把判据写成"只看 username"而丢掉 role 门）
    //   · currentUser=null                     → false（未登录/未加载完，不得放行）
    assertIsMyPending('①平台管理员 正例：isAdmin=true + username=admin + status=待指派 → true', true, PLATFORM_ADMIN_USER, { status: '待指派' }, true);
    assertIsMyPending('①⭐归属收紧靶心：isAdmin=true 但 username=demo_user_b（示例用户B·role 是 admin 的业务方）+ status=待指派 → false（改动前恒 true，全平台待指派单都灌进他的卡）', true, ROLE_ADMIN_BIZ_USER, { status: '待指派' }, false);
    assertIsMyPending('①⭐同上·待验证：isAdmin=true + username=demo_user_b + status=待验证 → false（生产 #32/#61 是示例客服B/示例客服A建的单，不该进示例用户B的卡）', true, ROLE_ADMIN_BIZ_USER, { status: '待验证' }, false);
    assertIsMyPending('①⭐同上·待归档态：isAdmin=true + username=demo_user_b + status=已上线 → false', true, ROLE_ADMIN_BIZ_USER, { status: '已上线' }, false);
    assertIsMyPending('①⭐同上·验收 pending：isAdmin=true + username=demo_user_b + post_release_acceptance=pending → false（四个状态子条件逐个证，防只收紧了其中一条）', true, ROLE_ADMIN_BIZ_USER, { status: '已关闭', post_release_acceptance: 'pending' }, false);
    assertIsMyPending('①role 门仍在：isAdmin=false + username=admin + status=待指派 → false（防判据被写成"只看 username"而丢掉 role 门——那样一个被降权为 user 的 admin 账号仍会看到全部）', false, PLATFORM_ADMIN_USER, { status: '待指派' }, false);
    assertIsMyPending('①currentUser=null（未登录/未加载完）+ status=待指派 → false（不得因取不到用户就放行）', true, null, { status: '待指派' }, false);
    assertIsMyPending('①admin 状态对身份不对：isAdmin=false + status=待指派 → false（若身份门判据被误删，本条会翻红成 true——457-H1 冻结的最易漏点：表格把 admin 的身份写在"身份"列不是判据列）', false, null, { status: '待指派' }, false);
    assertIsMyPending('①admin 身份对状态不对：平台管理员 + status=开发中（不在 admin 任一状态子条件内）→ false', true, PLATFORM_ADMIN_USER, { status: '开发中', my_dev_pending: 0 }, false);
    console.log('    ①b 建单人验收/归档半区（2026-08-27 生产 #89 缺口修复） —');
    // 依据 transitions.js:915「验收通过：待验证 → 待上线（**建单人**）」+ 生产 timeline 实证
    //   （近 14 条 accept/close 中 13 条是建单人本人）。⭐ 首例就是把 #89 的真实形态钉进来：
    //   示例用户B role=admin 但非平台管理员，单是他自己建的、处于「待验证」等他验收。
    const OWN_BY_BIZ = { created_by: ROLE_ADMIN_BIZ_USER.id };
    assertIsMyPending('①b ⭐生产 #89 真实形态：非平台管理员 + 自己建的单 + status=待验证 → true（修复前恒 false ⇒ 示例用户B整卡不渲染，验收无入口）', true, ROLE_ADMIN_BIZ_USER, { status: '待验证', ...OWN_BY_BIZ }, true);
    assertIsMyPending('①b 待归档态（已上线）+ 自己建的单 → true（close 实证同样是建单人本人：示例客服A连关 6 单全是自己建的）', true, ROLE_ADMIN_BIZ_USER, { status: '已上线', ...OWN_BY_BIZ }, true);
    assertIsMyPending('①b 待归档态（已生效·config 流）+ 自己建的单 → true（走 SI_STATUS_GROUPS.pending_archive 常量，非硬编码"已上线"）', true, ROLE_ADMIN_BIZ_USER, { status: '已生效', ...OWN_BY_BIZ }, true);
    assertIsMyPending('①b 补验收 pending + 自己建的单 → true（先行上线后的补验收同属验收性质）', true, ROLE_ADMIN_BIZ_USER, { status: '已关闭', post_release_acceptance: 'pending', ...OWN_BY_BIZ }, true);
    // [codex 479 MED-1 收口] 本条的 currentUser 必须与 OWN_BY_BIZ 的 created_by **同一来源**——
    //   初版写死 `{ id: 18, ... }`，与 `OWN_BY_BIZ = { created_by: ROLE_ADMIN_BIZ_USER.id }` 只是
    //   "恰好都是 18"；一旦常量里的 id 改了，这条就变成"用甲的身份去看乙建的单"，语义与期望值相反
    //   （且会以假绿或假红的形式出现，取决于改成什么值）。改为从同一常量派生，耦合显式化。
    const DEMOTED_BIZ_USER = { ...ROLE_ADMIN_BIZ_USER, role: 'user' };
    assertIsMyPending('①b 非 admin 角色同样适用：role≠admin 的建单人 + 待验证 → true（半区判据不含 role 门，业务方将来若降权为 user 仍应看到自己的验收待办；用户桩与 created_by 同源自 ROLE_ADMIN_BIZ_USER，不靠"恰好同 id"）', false, DEMOTED_BIZ_USER, { status: '待验证', ...OWN_BY_BIZ }, true);
    assertIsMyPending('①b ⭐反例·别人建的单：非平台管理员 + created_by=其他人 + 待验证 → false（这正是收紧要解决的原问题，不能因开半区而回流）', true, ROLE_ADMIN_BIZ_USER, { status: '待验证', created_by: 4 }, false);
    assertIsMyPending('①b ⭐反例·有意不含待指派：自己建的单 + status=待指派 → false（assign 的责任人是 admin∨受理人，建单人对它无可执行动作，放进来即"看得到点不了"的噪音）', true, ROLE_ADMIN_BIZ_USER, { status: '待指派', ...OWN_BY_BIZ }, false);
    assertIsMyPending('①b 反例·有意不含待处理：自己建的单 + status=待处理 → false（同上，bug 流未指派态责任人是 admin）', true, ROLE_ADMIN_BIZ_USER, { status: '待处理', ...OWN_BY_BIZ }, false);
    // ⭐ [契约演进·2026-08-27 ⑩ 上线] 本条原断言「自己建的单 + 待上线 → false（等上线，建单人无
    //   动作）」——⑩ 恰恰推翻了后半句：未挂批次的待上线单，建单人的动作就是**去排期**（谁建单谁负责
    //   排期上线，用户拍板）。按「新增条款必删被推翻的旧表述」改为两条：未挂批次 → true（经 ⑩）；
    //   已挂批次且非我批次/非我执行 → false（①b 半区本身仍不含待上线，原防护意图保留在这半条里）。
    assertIsMyPending('①b→⑩ 契约演进：自己建的单 + 待上线 + 未挂批次 → true（经 ⑩ 待排期命中——原「建单人无动作」表述已被「谁建单谁排期」推翻）', true, ROLE_ADMIN_BIZ_USER, { status: '待上线', ...OWN_BY_BIZ }, true);
    assertIsMyPending('①b 反例·自己建的单 + 待上线 + **已挂别人批次** → false（①b 半区不含待上线；⑩ 因有批次退出；⑧⑨ 因非我批次/非我执行不命中——原防护意图的存续形态）', true, ROLE_ADMIN_BIZ_USER, { status: '待上线', ...OWN_BY_BIZ, release_id: 501, release_created_by: 4, release_exec_count: 2, my_release_exec_pending: 0 }, false);
    assertIsMyPending('①b 反例·currentUser=null：uid 取不到时半区不放行（uid>0 前置门，同 ⑤⑦ 同族）', true, null, { status: '待验证', ...OWN_BY_BIZ }, false);
    assertIsMyPending('①b 反例·created_by 缺失：字段为 undefined 时不得命中（Number(undefined)=NaN，NaN===uid 恒 false）', true, ROLE_ADMIN_BIZ_USER, { status: '待验证' }, false);
    assertIsMyPending('①b 平台管理员不受影响：仍能看到别人建的待验证单（①a 全局视野保留）', true, { ...PLATFORM_ADMIN_USER }, { status: '待验证', created_by: 18 }, true);
    console.log('    ⑧ 我建的上线批次待派执行人（2026-08-27 二次拍板·逐张计入不去重） —');
    // 责任人依据=生产实证 added_by 对拍 created_by 近 12 批次 12/12 同人（谁建批次谁派人）。
    //   [去重拆除] 原「按批次选代表计 1」机制已随 2026-08-27 二次拍板整体移除——谓词纯按行判定，
    //   同批次成员单逐张命中。用例仍经 myPendingInList 喂完整 list 判行，保留聚合断言表达力。
    const M = (id, over) => Object.assign({ id, status: '待上线', release_id: 501, release_created_by: ROLE_ADMIN_BIZ_USER.id, release_exec_count: 0 }, over || {});
    const BIZ = ROLE_ADMIN_BIZ_USER;
    check('⑧ 正例·我建的批次待派执行人成员单 → true', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(13539), M(13540), M(13541)], 13539), true);
    });
    check('⑧ ⭐逐张计入·同批次全部成员单都命中（2026-08-27 二次拍板推翻同日「按批次去重计 1」——待办卡展示内容不去重）', () => {
        const list = [M(13539), M(13540), M(13541)];
        const hits = list.filter(x => myPendingInList(BIZ, list, x.id)).length;
        assert.strictEqual(hits, 3, `同一批次 3 张成员单应全部命中（逐张计入），实得 ${hits}——为 1 说明代表单去重机制被重新引入，与二次拍板口径相悖`);
    });
    check('⑧ 逐张计入·任意可见子集内成员单独立命中（无代表机制 ⇒ 不存在"代表被 type tab 裁掉整批消失"的旧缺陷形态·codex 481 HIGH-2 随机制拆除自然消解）', () => {
        const visible = [M(13540), M(13541)];
        const hits = visible.filter(x => myPendingInList(BIZ, visible, x.id)).length;
        assert.strictEqual(hits, 2, `可见子集内 2 张成员单应各自命中，实得 ${hits}`);
    });
    check('⑧ ⭐[codex 481 HIGH-1] 孤儿批次（release_id 非空但 release_created_by 为 NULL）→ false（批次记录已不存在，不是没派人）', () => {
        const list = [M(13539, { release_created_by: null })];
        assert.strictEqual(myPendingInList(BIZ, list, 13539), false);
    });
    console.log('    ⑨ 我是本批次执行人且未执行（2026-08-27·与 ⑧ 构成待上线闭环） —');
    const X = (id, over) => Object.assign({ id, status: '待上线', release_id: 601, my_release_exec_pending: 1 }, over || {});
    check('⑨ 正例·我是在册执行人且 exec_status=pending → true（生产实例：示例开发A在 R-20260824-3 上 pending、批次逾期 2 天，钉钉早已 sent 但持续清单里没有他这条）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20101)], 20101), true);
    });
    check('⑨ ⭐逐张计入·同批次多张成员单全部命中（2026-08-27 二次拍板：待办卡展示内容不去重；执行仍是批次级动作，点一次后整批同时消失）', () => {
        const list = [X(20101), X(20102), X(20103)];
        const hits = list.filter(x => myPendingInList(BIZ, list, x.id)).map(x => x.id);
        assert.deepStrictEqual(hits, [20101, 20102, 20103], `同批次 3 张成员单应全部命中（逐张计入），实得 ${JSON.stringify(hits)}`);
    });
    check('⑨ 反例·我不在执行人名单（my_release_exec_pending=0）→ false', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20101, { my_release_exec_pending: 0 })], 20101), false);
    });
    check('⑨ 反例·状态不是待上线 → false（批次已发布后成员不再是待上线态）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20101, { status: '已上线' })], 20101), false);
    });
    check('⑨ 反例·currentUser=null → false', () => {
        assert.strictEqual(myPendingInList(null, [X(20101)], 20101), false);
    });
    // [未来上线日期执行闸·待办联动 2026-08-27] ⑨ 新增日期条件：计划上线日在未来 ⇒ 不进卡（后端
    //   /execute 闸拦着，进卡=挂一条按不动的待办；到期日当天自动出现）。四态用例与后端闸同口径：
    //   未来→不进 / 当日→进（`>` 严格比较）/ 逾期→进 / 空、脏值→进（fail-open）。⑧⑩ 刻意不联动
    //   （派人/排期是可提前做的准备动作）——⑧ 的未来日期反-反例一并钉住。
    const siFmtDay = (offset) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    check('⑨ ⭐日期联动·计划上线日在未来 → false（未到期不进「待我处理」，到期日当天自动出现）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20111, { release_planned_date: siFmtDay(3) })], 20111), false);
    });
    check('⑨ 日期联动·计划上线日=当日 → true（同日可执行，`>` 严格比较与后端闸同口径）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20112, { release_planned_date: siFmtDay(0) })], 20112), true);
    });
    check('⑨ 日期联动·计划上线日已逾期 → true（逾期该催执行，不是从卡里藏掉）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20113, { release_planned_date: siFmtDay(-3) })], 20113), true);
    });
    check('⑨ 日期联动·空/脏值 fail-open → true（null 与非法日期 2026-13-99 均照常进卡，与后端闸"脏值不锁死批次"同口径）', () => {
        assert.strictEqual(myPendingInList(BIZ, [X(20114, { release_planned_date: null })], 20114), true);
        assert.strictEqual(myPendingInList(BIZ, [X(20115, { release_planned_date: '2026-13-99' })], 20115), true);
    });
    check('⑧ 日期不联动反-反例：我建的批次待派执行人 + 计划日在未来 → 仍 true（派人是可提前做的准备动作，若被误加日期条件本条判红）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(20116, { release_planned_date: siFmtDay(3) })], 20116), true);
    });
    check('⑧⑨ 互斥性：⑧ 要求 exec_count=0、⑨ 要求本人在执行人名单（⇒ 至少 1 人），同一张单不可能两者都命中（并集计数下同一单恒只计 1）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(30001, { my_release_exec_pending: 1, release_exec_count: 1 })], 30001), true, '已派人 ⇒ ⑧ 不命中，应经 ⑨ 命中');
        assert.strictEqual(myPendingInList(BIZ, [M(30002)], 30002), true, 'exec_count=0 ⇒ ⑨ 不命中，应经 ⑧ 命中');
    });
    console.log('    ⑩ 我建的单待排期（2026-08-27·谁建单谁负责排期上线·逐张计入不去重） —');
    // 生产实例：#81/#87（示例客服B建·待上线·未挂批次）此前只有红「未排期」徽章不进任何人的卡（⑧⑨ 拍板
    //   时的有意留白），本分支补上。责任链闭环：⑩排期（建单人）→⑧派人（批次创建人）→⑨执行（执行人）。
    const U = (id, over) => Object.assign({ id, status: '待上线', release_id: null, created_by: ROLE_ADMIN_BIZ_USER.id }, over || {});
    check('⑩ 正例·我建的待上线单未挂批次 → true（#81/#87 形态）', () => {
        assert.strictEqual(myPendingInList(BIZ, [U(81)], 81), true);
    });
    check('⑩ ⭐逐张计入不去重（2026-08-27 二次拍板后与 ⑧⑨ 口径统一——未排期单每张独立决定进哪个批次/定什么计划日）', () => {
        const list = [U(81), U(87)];
        const hits = list.filter(x => myPendingInList(BIZ, list, x.id)).map(x => x.id);
        assert.deepStrictEqual(hits, [81, 87], `两张未排期单应**都**命中（不选代表），实得 ${JSON.stringify(hits)}`);
    });
    check('⑩ 反例·别人建的单 → false（归属=建单人，同 ①b⑤ 族判据）', () => {
        assert.strictEqual(myPendingInList(BIZ, [U(81, { created_by: 4 })], 81), false);
    });
    check('⑩ 反例·已挂批次 → false（那是 ⑧/⑨ 的领地——有批次后责任转给批次创建人/执行人，⑩ 不再重复计入）', () => {
        // 只挂批次但不满足 ⑧（创建人非我）也不满足 ⑨（我不是执行人）⇒ 整体 false，证 ⑩ 真的退出了
        assert.strictEqual(myPendingInList(BIZ, [U(81, { release_id: 501, release_created_by: 4, release_exec_count: 2, my_release_exec_pending: 0 })], 81), false);
    });
    check('⑩ 反例·状态不是待上线 → false（开发中/待验证的单还轮不到排期）', () => {
        assert.strictEqual(myPendingInList(BIZ, [U(81, { status: '开发中' })], 81), false);
    });
    check('⑩ 反例·currentUser=null → false（uid 前置门，同族纪律）', () => {
        assert.strictEqual(myPendingInList(null, [U(81)], 81), false);
    });
    check('⑩ 不判 role：role=user 的建单人同样命中（同 ①b⑧⑨ 族——降权仍应看到自己的待办）', () => {
        assert.strictEqual(myPendingInList({ ...ROLE_ADMIN_BIZ_USER, role: 'user' }, [U(81)], 81), true);
    });
    check('⑩ 谓词与 breakdown「待排期」段共用同一 helper siIsMyReleaseSchedulePending（codex 483 LOW-1 收口——原两处内联靠字面断言钉一致，现结构上消除漂移源）', () => {
        const bd = extractFullFunctionText('siMyPendingBreakdown');
        assert.ok(bd && /\['待排期', vis\.filter\(i => siIsMyReleaseSchedulePending\(i, uid\)\)\.length\]/.test(bd),
            'siMyPendingBreakdown「待排期」段应调用 siIsMyReleaseSchedulePending（不复写判据）');
        assert.ok(/\|\| siIsMyReleaseSchedulePending\(item, uid\)/.test(fnIsMyPending),
            'siIsMyPending 分支⑩ 应调用 siIsMyReleaseSchedulePending（不复写判据）');
        const helper = extractFullFunctionText('siIsMyReleaseSchedulePending');
        assert.ok(helper, '未提取到 siIsMyReleaseSchedulePending——helper 被删则 ⑩ 整组空转');
        assert.ok(/item\.status === '待上线'/.test(helper) && /item\.release_id == null/.test(helper) && /Number\(item\.created_by\) === uid/.test(helper),
            'helper 三条件（待上线/未挂批次/建单人=我）任一缺失即判红');
    });
    check('⑧ 反例·已派执行人 → false（正常在途，无人需要动作）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(13539, { release_exec_count: 2 })], 13539), false);
    });
    check('⑧ 反例·别人建的批次 → false（待办只归批次创建人，实证 12/12 同人）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(13539, { release_created_by: 4 })], 13539), false);
    });
    check('⑧ 反例·未挂批次 → false（那是未排期，责任在加单方，不是批次没派人）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(13539, { release_id: null })], 13539), false);
    });
    check('⑧ 反例·状态不符（已上线）→ false（与徽章同口径）', () => {
        assert.strictEqual(myPendingInList(BIZ, [M(13539, { status: '已上线' })], 13539), false);
    });
    check('⑧ 反例·currentUser=null → false（uid 取不到不放行，同 ⑤⑦①b 同族前置门）', () => {
        assert.strictEqual(myPendingInList(null, [M(13539)], 13539), false);
    });
    check('⑧ 不判 role：role=user 的批次创建人同样命中（业务方将来降权仍应看到自己批次的待办）', () => {
        assert.strictEqual(myPendingInList({ ...BIZ, role: 'user' }, [M(13539)], 13539), true);
    });
    check('⑧ 多批次并存：两个批次的成员单全部逐张命中', () => {
        const list = [M(13539), M(13540), M(20001, { release_id: 502 }), M(20002, { release_id: 502 })];
        const hits = list.filter(x => myPendingInList(BIZ, list, x.id)).map(x => x.id);
        assert.deepStrictEqual(hits, [13539, 13540, 20001, 20002], `两个批次共 4 张成员单应全部命中（逐张计入），实得 ${JSON.stringify(hits)}`);
    });
    check('⑧⑨ 谓词不得引用已删除的后端 rep 列或代表 map（去重机制拆除后的负向断言——重新出现即说明去重被悄悄加回）', () => {
        assert.ok(!/release_rep_issue_id|repMap/.test(fnIsMyReleaseNeedsExecutor) && !/release_rep_issue_id|repMap/.test(fnIsMyReleaseExecPending),
            'siIsMyReleaseNeedsExecutor/siIsMyReleaseExecPending 中出现 release_rep_issue_id 或 repMap——该列/机制已随 2026-08-27 二次拍板移除，谓词应纯按行判定');
    });
    console.log('    ②开发 —');
    assertIsMyPending('②开发 正例：status∈SI_DEV_FAMILY_STATUSES + my_dev_pending=1 → true', false, null, { status: '开发中', my_dev_pending: 1 }, true);
    assertIsMyPending('②开发 状态对身份不对：status=开发中 + my_dev_pending=0（未在册/非待办）→ false（若 my_dev_pending 判据被误删/改成真值判断，本条会翻红）', false, null, { status: '开发中', my_dev_pending: 0 }, false);
    assertIsMyPending('②开发 身份对状态不对：my_dev_pending=1 但 status=待验证（不在开发家族状态内）→ false（禁止 my_dev_pending 单独放行，必须叠状态门，若状态门被误删本条会翻红）', false, null, { status: '待验证', my_dev_pending: 1 }, false);
    console.log('    ③对接人（待对接测试） —');
    assertIsMyPending('③对接人 正例：status=待对接测试 + is_my_intake_liaison=1 → true', false, null, { status: '待对接测试', is_my_intake_liaison: 1 }, true);
    assertIsMyPending('③对接人 状态对身份不对：status=待对接测试 + is_my_intake_liaison=0 → false（若身份门被误删，本条会翻红）', false, null, { status: '待对接测试', is_my_intake_liaison: 0 }, false);
    assertIsMyPending('③对接人 身份对状态不对：is_my_intake_liaison=1 但 status=开发中（非待对接测试）→ false（若状态门被误删，本条会翻红）', false, null, { status: '开发中', is_my_intake_liaison: 1, my_dev_pending: 0 }, false);
    console.log('    ④受理人（待受理） —');
    assertIsMyPending('④受理人 正例：status=待受理 + is_my_intake_liaison=1 → true', false, null, { status: '待受理', is_my_intake_liaison: 1 }, true);
    assertIsMyPending('④受理人 状态对身份不对：status=待受理 + is_my_intake_liaison=0 → false（若身份门被误删，本条会翻红）', false, null, { status: '待受理', is_my_intake_liaison: 0 }, false);
    assertIsMyPending('④受理人 身份对状态不对：is_my_intake_liaison=1 但 status=开发中（非待受理）→ false（若状态门被误删，本条会翻红）', false, null, { status: '开发中', is_my_intake_liaison: 1, my_dev_pending: 0 }, false);
    console.log('    ④b 绑定受理人·指派半区（待指派/待处理·2026-09-04 生产 #116 缺口修复） —');
    // 责任人依据=transitions.js 三条 assign 条目 roleGuard='intake_liaison'（引擎 index.js:5334 判
    //   admin ∨ 绑定受理人）+ 生产实证 sys_issue_timeline 全量 assign 137 条 137/137 由绑定受理人本人操作。
    //   两流各一正例（变更流待指派 / bug 流待处理）——只写一条会让"两流对称"这个口径失去防护。
    assertIsMyPending('④b 正例·变更流：status=待指派 + is_my_intake_liaison=1 → true（生产 #116 示例开发A的形态：role=user 的绑定受理人，改动前恒 false，单子静默积压在他看不见的地方）', false, null, { status: '待指派', is_my_intake_liaison: 1 }, true);
    assertIsMyPending('④b 正例·bug 流：status=待处理 + is_my_intake_liaison=1 → true（bug 的 assign 前置态是「待处理」，若 SI_ASSIGN_PENDING_STATUSES 漏掉它，本条会红）', false, null, { status: '待处理', is_my_intake_liaison: 1 }, true);
    assertIsMyPending('④b 状态对身份不对：status=待指派 + is_my_intake_liaison=0（别人名下的单）→ false（若身份门被误删成"只看状态"，本条会翻红成 true——那等于全平台待指派单灌进每个登录用户的卡，比修复前更坏）', false, null, { status: '待指派', is_my_intake_liaison: 0 }, false);
    assertIsMyPending('④b 身份门·字段缺失：is_my_intake_liaison 未投影（undefined）→ false（Number(undefined)=NaN，NaN===1 恒 false；若判据被写成真值判断，本条会翻红）', false, null, { status: '待指派' }, false);
    assertIsMyPending('④b 身份对状态不对·待验证不是 assign 前置态：is_my_intake_liaison=1 + status=待验证 → false（若 SI_ASSIGN_PENDING_STATUSES 被误加「待验证」，本条会翻红——验收判定的责任人是平台管理员/建单人，不是受理人）', false, null, { status: '待验证', is_my_intake_liaison: 1 }, false);
    assertIsMyPending('④b ⭐有意不含 reassign 态：is_my_intake_liaison=1 + status=开发中 + my_dev_pending=0 → false（受理人在开发中/待验证虽有 reassign 权，但推进义务在开发本人；纳入即"看得到点不了"的死按钮噪音——若有人顺手把 reassign 的 from 也塞进常量，本条会翻红）', false, null, { status: '开发中', is_my_intake_liaison: 1, my_dev_pending: 0 }, false);
    assertIsMyPending('④b ⭐归属收紧不被冲垮：role=admin 的业务方（示例用户B）+ status=待指派 + 非本人受理（is_my_intake_liaison=0）→ 仍 false（2026-08-27 收紧的靶心不变量；本次是"给真责任人开半区"，不是"把闸放宽回去"——若 ④b 被写成不判身份，本条会翻红）', true, ROLE_ADMIN_BIZ_USER, { status: '待指派', is_my_intake_liaison: 0 }, false);
    check('④b 谓词与 breakdown「待指派」段共用同一 helper siIsMyIntakeAssignPending（同 ⑩ 的 483 LOW-1 收口纪律——结构上消除"注释要求同步、代码却双写"的漂移源）', () => {
        const bd = extractFullFunctionText('siMyPendingBreakdown');
        assert.ok(bd && /siIsMyIntakeAssignPending\(i\)/.test(bd),
            'siMyPendingBreakdown「待指派」段应调用 siIsMyIntakeAssignPending（不复写判据）');
        assert.ok(/\|\| siIsMyIntakeAssignPending\(item\)/.test(fnIsMyPending),
            'siIsMyPending 分支④b 应调用 siIsMyIntakeAssignPending（不复写判据）');
        const helper = extractFullFunctionText('siIsMyIntakeAssignPending');
        assert.ok(helper, '未提取到 siIsMyIntakeAssignPending——helper 被删则 ④b 整组空转');
        assert.ok(/SI_ASSIGN_PENDING_STATUSES\.includes\(item\.status\)/.test(helper) && /Number\(item\.is_my_intake_liaison\) === 1/.test(helper),
            'helper 两条件（状态 ∈ assign 前置态常量 / 绑定受理人是我）任一缺失即判红');
        assert.ok(!/'待指派'|'待处理'/.test(helper),
            'helper 内不应出现「待指派」/「待处理」字面量——应复用 SI_ASSIGN_PENDING_STATUSES 常量本身（单一事实源，同 3c 对 SI_DEV_FAMILY_STATUSES 的同款结构锚）');
    });
    check('④b 分支① 也复用同一常量（不再各写一份 assign 前置态字面量——两处漂移会让"管理员看得到、受理人看不到"或反过来）', () => {
        assert.ok(/\[\.\.\.SI_ASSIGN_PENDING_STATUSES, '待验证'\]\.includes\(item\.status\)/.test(fnIsMyPending),
            'siIsMyPending 分支① 应以 [...SI_ASSIGN_PENDING_STATUSES, \'待验证\'] 形态引用常量');
    });
    console.log('    ⑤建单人（待修改） —');
    assertIsMyPending('⑤建单人 正例：status=待修改 + created_by=uid(42) → true', false, { id: 42 }, { status: '待修改', created_by: 42 }, true);
    assertIsMyPending('⑤建单人 状态对身份不对：status=待修改 + created_by=99（非本人）→ false（若 created_by===uid 比对被误删，本条会翻红）', false, { id: 42 }, { status: '待修改', created_by: 99 }, false);
    assertIsMyPending('⑤建单人 身份对状态不对：created_by=uid(42) 但 status=开发中（非待修改）→ false（若状态门被误删，本条会翻红）', false, { id: 42 }, { status: '开发中', created_by: 42, my_dev_pending: 0 }, false);
    console.log('    ⑥值班执行人（原样调用 siIsMyFastlanePending，函数本体一字不动） —');
    assertIsMyPending('⑥值班 正例：type=bug ∧ status=待验证 ∧ fast_release_active_auth=1 ∧ fast_release_my_pending=1 → true（同时证「断言5」值班分支真命中聚合谓词，非孤立可执行但接不上线）', false, null, { type: 'bug', status: '待验证', fast_release_active_auth: 1, fast_release_my_pending: 1 }, true);
    assertIsMyPending('⑥值班 状态对身份不对：status=待验证 但 fast_release_my_pending=0（不在集合内）→ false', false, null, { type: 'bug', status: '待验证', fast_release_active_auth: 1, fast_release_my_pending: 0 }, false);
    assertIsMyPending('⑥值班 身份对状态不对：fast_release_my_pending=1 但 status=开发中（非待验证）→ false', false, null, { type: 'bug', status: '开发中', fast_release_active_auth: 1, fast_release_my_pending: 1, my_dev_pending: 0 }, false);
    console.log('    ⑦历史兼容（被指定上线开发·D-A 拍板保留，2026-08-26 存量核查全库 release_assignee_id 非空行=0）—');
    assertIsMyPending('⑦历史兼容 正例：type=bug ∧ status=待上线 ∧ release_assignee_id=uid(42) → true', false, { id: 42 }, { type: 'bug', status: '待上线', release_assignee_id: 42 }, true);
    assertIsMyPending('⑦历史兼容 反例：release_assignee_id=99（非本人）→ false（若 ===uid 比对被误删/改成真值判断，本条会翻红）', false, { id: 42 }, { type: 'bug', status: '待上线', release_assignee_id: 99 }, false);

    console.log('  — codex 467 MED-2 回归：uid 桩=2**53（非安全整数）/\'not-a-number\'（非数字）→ 归一 null，⑤建单人⑦历史兼容均不命中（即便原始字段恰好同值也不命中） —');
    // [S4 预筛提示3·label 按真实变异面改写] 2**53 两条的真实防御=Number.isSafeInteger 归一（删掉归一
    //   才翻红；只删 uid>0 时 Number(x)===null 仍 false 不翻红）；'not-a-number' 两条挡的是"归一被改成
    //   宽松转换/== 比较"类回归——注释声称的变异方向必须与实测相符（comment_is_review_input）。
    for (const badId of [2 ** 53, 'not-a-number']) {
        assertIsMyPending(`⑤建单人 uid 桩=${JSON.stringify(badId)} → uid 归一 null，created_by 恰好同值仍不命中（2**53 条：若 Number.isSafeInteger 归一被误删，本条会翻红）`,
            false, { id: badId }, { status: '待修改', created_by: badId }, false);
        assertIsMyPending(`⑦历史兼容 uid 桩=${JSON.stringify(badId)} → uid 归一 null，release_assignee_id 恰好同值仍不命中（2**53 条：若 Number.isSafeInteger 归一被误删，本条会翻红）`,
            false, { id: badId }, { type: 'bug', status: '待上线', release_assignee_id: badId }, false);
    }

    console.log('  — 3b「待处理」归属专项（本方案自查项，最易写反·N0-6b 增补） —');
    assertIsMyPending('3b① bug 单 status=待处理 + 平台管理员 → 命中（admin 待指派义务，SI_STATUS_GROUPS 之外的直接状态子条件覆盖「待处理」）', true, PLATFORM_ADMIN_USER, { status: '待处理' }, true);
    assertIsMyPending('3b② 同单 + 开发身份（非 admin）+ my_dev_pending=0 → 不命中（待处理尚未指派，无在册开发）', false, null, { status: '待处理', my_dev_pending: 0 }, false);
    assertIsMyPending('3b②b（N0-6b 增补，更强）同单 + 开发在册 my_dev_pending=1 → 仍不命中（状态门拦住设计内预指派——SI_DEV_FAMILY_STATUSES 不含「待处理」，即便 add/reassign 产生了在册 pending 行，前端谓词仍正确不命中；若状态门被误删/常量被误改，本条会翻红——见本报告附带的 3b③ 活体变异实证）', false, null, { status: '待处理', my_dev_pending: 1 }, false);

    console.log('  — 3c 状态族单一事实源（结构锚：siIsMyPending 函数体须引用 SI_DEV_FAMILY_STATUSES 标识符本身，不含 \'开发中\' 字面量） —');
    check('3c siIsMyPending 函数体（剥注释后）含 SI_DEV_FAMILY_STATUSES 标识符引用，且不含 \'开发中\' 字面量（禁止另写一份状态数组，单一事实源同 canSubmit 先例）', () => {
        const body = bodyOf('siIsMyPending');
        assert.ok(body, '未提取到 siIsMyPending 函数体');
        assert.ok(/\bSI_DEV_FAMILY_STATUSES\b/.test(body), '未见 SI_DEV_FAMILY_STATUSES 标识符引用');
        assert.ok(!body.includes("'开发中'"), '不应出现 \'开发中\' 字面量——应复用 SI_DEV_FAMILY_STATUSES 常量本身，非另写一份状态数组');
    });

    console.log('  — 3d admin 归档分支覆盖「已生效」（P1 明定·v1.0 曾漏） —');
    assertIsMyPending('3d status=已生效 + 平台管理员 → 命中（SI_STATUS_GROUPS.pending_archive 复用，非散落硬编码"已上线"）', true, PLATFORM_ADMIN_USER, { status: '已生效' }, true);

    console.log('  — 并集断言（主计数去重 vs 分段计次允许重叠·方案 §6-4） —');
    check('并集：单张单同时满足 admin(post_release_acceptance=pending) 与开发(my_dev_pending=1) 两身份 → 主计数（vis.filter(siIsMyPending).length）恰为 1（并集去重，非按命中身份数累加；若 siIsMyPending 被改成分段累加式实现，本条会翻红成 2）', () => {
        const fn = isMyPendingWith(true, { ...PLATFORM_ADMIN_USER, id: 42 });
        const item = { status: '开发中', post_release_acceptance: 'pending', my_dev_pending: 1 };
        const count = [item].filter(fn).length;
        assert.strictEqual(count, 1, `主计数应为 1（该单虽同时命中 admin 验收归档与开发待提交两个身份，但去重后仍是 1 张单），实得 ${count}`);
    });
    check('并集·方案 §6-4 字面版（S4 预筛提示6 补）：两张单各命中一个身份（admin 归档单 + 开发待提交单）→ 主计数恰为 2（与上一条"单单双身份=1"互补，两条合起来钉死"并集去重且按单计数"两个方向）', () => {
        const fn = isMyPendingWith(true, { ...PLATFORM_ADMIN_USER, id: 42 });
        const itemA = { status: '已上线', my_dev_pending: 0 };
        const itemB = { status: '开发中', my_dev_pending: 1 };
        const count = [itemA, itemB].filter(fn).length;
        assert.strictEqual(count, 2, `两张单各命中一身份应计 2，实得 ${count}`);
    });
    check('并集：同一单分段计数（siMyPendingBreakdown）之和 = 2 > 主计数 1（允许重叠，非并集去重）；title 末尾固定含"（同一单可命中多个身份）"（若分段实现互斥优先级化，本条会翻红——方案明文否决互斥优先级方案）', () => {
        const breakdown = breakdownWith(true, { ...PLATFORM_ADMIN_USER, id: 42 });
        const item = { status: '开发中', post_release_acceptance: 'pending', my_dev_pending: 1 };
        const text = breakdown([item]);
        assert.ok(/验收归档 1/.test(text), `分段文案应含"验收归档 1"，实得="${text}"`);
        assert.ok(/待我提交 1/.test(text), `分段文案应含"待我提交 1"，实得="${text}"`);
        assert.ok(text.endsWith('（同一单可命中多个身份）'), `分段文案应以固定提示收尾，实得="${text}"`);
    });
    // ⭐ [codex 499 MED-2 收口] ④b 的 breakdown 侧此前**只有结构锚**（"出现了 helper 调用"），没有行为断言：
    //   把 :3020 的 `|| siIsMyIntakeAssignPending(i)` 误改成 `&&`，结构锚照样匹配得到 helper 名，但非平台
    //   管理员的主计数=1 而 tooltip「待指派」段=0（主计数有数、悬停显示暂无的自相矛盾）。四组真执行断言
    //   把这条组合逻辑本身钉住，配套变异 M6（||→&&）在活体自证脚本里。
    console.log('  — ④b breakdown「待指派」段行为四组（codex 499 MED-2：结构锚挡不住运算符/括号错误） —');
    {
        const ASSIGN_ITEM_MINE = { id: 9001, status: '待指派', is_my_intake_liaison: 1 };
        const ASSIGN_ITEM_OTHERS = { id: 9002, status: '待指派', is_my_intake_liaison: 0 };
        const LIAISON_USER = { id: 8, username: '19900000005', display_name: '示例开发A', role: 'user' };
        check('④b-bd① 非平台管理员 + 本人受理的待指派单 → 段计 1（`||` 被误改成 `&&` 时本条红：admin=false 使整段恒 0）', () => {
            const text = breakdownWith(false, LIAISON_USER)([ASSIGN_ITEM_MINE]);
            assert.ok(/待指派 1/.test(text), `应含"待指派 1"，实得="${text}"`);
        });
        check('④b-bd② 非平台管理员 + 别人受理的待指派单 → 段计 0（计 0 的段不显示；若身份门在 breakdown 侧被漏掉，本条红）', () => {
            const text = breakdownWith(false, LIAISON_USER)([ASSIGN_ITEM_OTHERS]);
            assert.ok(!/待指派 \d/.test(text), `不应出现"待指派 N"段，实得="${text}"`);
        });
        check('④b-bd③ 平台管理员 + 非本人受理的待指派单 → 段仍计 1（admin 全量视野在本段保留，未被 ④b 的身份门收窄）', () => {
            const text = breakdownWith(true, PLATFORM_ADMIN_USER)([ASSIGN_ITEM_OTHERS]);
            assert.ok(/待指派 1/.test(text), `应含"待指派 1"，实得="${text}"`);
        });
        check('④b-bd④ 平台管理员**兼**本单受理人 → 同一张单仍只计 1（段内并集去重，非两个身份各计一次；若写成两个 filter 相加，本条红成 2）', () => {
            const text = breakdownWith(true, { ...PLATFORM_ADMIN_USER, id: 8 })([{ ...ASSIGN_ITEM_MINE }]);
            assert.ok(/待指派 1/.test(text), `应含"待指派 1"（不是 2），实得="${text}"`);
        });
    }

    console.log('  — 断言5：值班卡已移除（\'my_fastlane\' 字面量零出现）+ siIsMyFastlanePending 仍被 siIsMyPending 调用 —');
    check('siRenderStats 函数体（剥注释后）不含 \'my_fastlane\' 字面量（值班卡已吸收进「待我处理」聚合卡，横切筛选改用 my_pending；若残留旧 key，本条会翻红）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(!body.includes("'my_fastlane'"), 'siRenderStats 不应再出现 \'my_fastlane\' 字面量');
    });
    check('siMatchStatFilter 函数体（剥注释后）不含 \'my_fastlane\' 字面量（458-H1 判定全仓无旧键消费者，零字面量口径，无归一豁免入口）', () => {
        const body = bodyOf('siMatchStatFilter');
        assert.ok(!body.includes("'my_fastlane'"), 'siMatchStatFilter 不应再出现 \'my_fastlane\' 字面量');
    });
    check('siIsMyFastlanePending 函数仍定义（未被顺手删除——降级为聚合谓词⑥值班分支，函数本体保留独立可测）', () => {
        assert.ok(bodyOf('siIsMyFastlanePending'), '未提取到 siIsMyFastlanePending 函数体');
    });
    check('siIsMyPending 函数体调用 siIsMyFastlanePending(（值班身份分支原样复用，非另写一份判据；⑥组正例已沙箱真执行证明命中，本条补证接线未断）', () => {
        const body = bodyOf('siIsMyPending');
        assert.ok(body.includes('siIsMyFastlanePending('), '未见 siIsMyPending 调用 siIsMyFastlanePending——值班身份分支应原样复用该函数');
    });

    console.log('  — siMatchStatFilter：my_pending 路由（S4 预筛拦截1）+ 既有状态组 key 行为不变 + 未知/空 key 仍放行 + 拆组归属 —');
    {
        let matchStatFilter;
        check('[前置] siMatchStatFilter 编译工厂可用（S4 预筛提示4：包进 check）', () => {
            matchStatFilter = matchStatFilterWith(false, null);
            assert.strictEqual(typeof matchStatFilter, 'function');
        });
        // [S4 预筛拦截1] my_pending 路由分支的静态次序锚 + 行为真/假一对——此前两面皆空：若 :1792 的
        //   特判被挪到组查找之后，SI_STATUS_GROUPS['my_pending'] 恒 undefined 走 ': true' 兜底=点卡对
        //   全部单据放行，而守卫 118 条全绿。次序锚+行为对是同一防线的两面，缺一不可。
        check('my_pending 特判位于 SI_STATUS_GROUPS 查找之前（次序结构锚·方案 §6-2；若特判被挪后，本条会红）', () => {
            const body = bodyOf('siMatchStatFilter');
            const idxPending = body.indexOf("'my_pending'");
            const idxGroups = body.indexOf('SI_STATUS_GROUPS[');
            assert.ok(idxPending >= 0 && idxGroups >= 0, `两个锚点都应存在（my_pending@${idxPending}·组查找@${idxGroups}）`);
            assert.ok(idxPending < idxGroups, `my_pending 特判（@${idxPending}）应在 SI_STATUS_GROUPS 查找（@${idxGroups}）之前`);
        });
        check('my_pending 路由行为·真例：admin 桩 + 待指派 → true（走 siIsMyPending 而非兜底放行）', () => {
            assert.strictEqual(matchStatFilterWith(true, { ...PLATFORM_ADMIN_USER, id: 42 })({ status: '待指派' }, 'my_pending'), true);
        });
        check('my_pending 路由行为·假例：非 admin 非任何身份 + 待指派 → false（若特判失效走 ": true" 兜底，本条会翻红成 true——空转即暴露）', () => {
            assert.strictEqual(matchStatFilterWith(false, { id: 42 })({ status: '待指派' }, 'my_pending'), false);
        });
        check('既有状态组 key（active）行为不变·命中', () => {
            assert.strictEqual(matchStatFilter({ status: '开发中' }, 'active'), true);
        });
        check('既有状态组 key（active）行为不变·不命中', () => {
            assert.strictEqual(matchStatFilter({ status: '已上线' }, 'active'), false);
        });
        // [P-C1 预筛拦截①] 键集断言只证"键名对"不证"状态归属对"——两组状态数组对调后键集照样 6 个、
        //   77 断言全绿而卡计数全错。行为断言四条钉死归属方向（反向一对防对调，probe 双向证明范式）。
        check('拆组归属·已上线∈pending_archive', () => {
            assert.strictEqual(matchStatFilter({ status: '已上线' }, 'pending_archive'), true);
        });
        check('拆组归属·已生效∈pending_archive（方案 P1 明定·v1.0 曾漏）', () => {
            assert.strictEqual(matchStatFilter({ status: '已生效' }, 'pending_archive'), true);
        });
        check('拆组归属·已关闭∈archived', () => {
            assert.strictEqual(matchStatFilter({ status: '已关闭' }, 'archived'), true);
        });
        check('拆组归属·反向：已上线∉archived（防两组对调）', () => {
            assert.strictEqual(matchStatFilter({ status: '已上线' }, 'archived'), false);
        });
        // [codex 465 MED-1/LOW-1] 拆组三补强：①已关闭∉pending_archive（与"已上线∉archived"合成双向，
        //   防单状态被重复归进两组）②组全集无重复（结构化防回归：任何状态出现在两组=两张卡计数同含一单）
        //   ③排序序值组间断言——SI_STATUS_SORT_ORDER 中待归档组每个状态的序值必须整体早于已归档组
        //   （465 抓获实际缺陷：拆组时 已生效:11 仍排在 已关闭:10 之后，列表状态序与卡分组语义交错）。
        check('拆组归属·反向：已关闭∉pending_archive（防重复归组）', () => {
            assert.strictEqual(matchStatFilter({ status: '已关闭' }, 'pending_archive'), false);
        });
        check('组全集无重复（任一状态只属一组）', () => {
            // eslint-disable-next-line no-new-func
            const groupsObj = new Function(`${statusGroupsText}\nreturn SI_STATUS_GROUPS;`)();
            const flat = Object.values(groupsObj).flat();
            assert.strictEqual(flat.length, new Set(flat).size,
                `状态出现在多个组：${JSON.stringify(flat.filter((s, i) => flat.indexOf(s) !== i))}`);
        });
        check('排序序值·待归档组整体早于已归档组（列表状态序与卡分组同向·codex 465 MED-1）', () => {
            // eslint-disable-next-line no-new-func
            const groupsObj = new Function(`${statusGroupsText}\nreturn SI_STATUS_GROUPS;`)();
            const sortOrderText = extractConstObjectText('SI_STATUS_SORT_ORDER');
            assert.ok(sortOrderText, '未提取到 SI_STATUS_SORT_ORDER 常量全文');
            // eslint-disable-next-line no-new-func
            const sortOrder = new Function(`${sortOrderText}\nreturn SI_STATUS_SORT_ORDER;`)();
            groupsObj.pending_archive.concat(groupsObj.archived).forEach(s => {
                assert.ok(Number.isFinite(sortOrder[s]), `状态「${s}」未在 SI_STATUS_SORT_ORDER 登记序值`);
            });
            const maxPending = Math.max(...groupsObj.pending_archive.map(s => sortOrder[s]));
            const minArchived = Math.min(...groupsObj.archived.map(s => sortOrder[s]));
            assert.ok(maxPending < minArchived,
                `待归档组最大序值 ${maxPending} 应小于已归档组最小序值 ${minArchived}（否则列表默认排序与卡分组方向矛盾）`);
        });
        check('未知 key 仍放行（现状既有兜底语义未被本次改动破坏）', () => {
            assert.strictEqual(matchStatFilter({ status: '随便什么状态' }, 'no_such_key_xyz'), true);
        });
        check('空 filterKey 仍放行（现状既有兜底语义未被本次改动破坏）', () => {
            assert.strictEqual(matchStatFilter({ status: '随便什么状态' }, ''), true);
        });
    }

    console.log('  — 465 LOW-2：紧凑 CSS 归属核验（.si-wrap 族不外溢 components.css）+ \'u-stat-card\' 产出点恰 2 处 —');
    check('components.css 全文不含 \'.si-wrap\'（紧凑一屏覆盖应只活在 Sys_Iteration.html 页面内 <style>，不外溢共享层，否则会波及其它页面；若有人误把这批规则挪进共享层，本条会翻红）', () => {
        assert.ok(!css.includes('.si-wrap'), 'components.css 不应出现 .si-wrap 选择器');
    });
    check('页面内 <style> 确含 .si-wrap .u-stat-card 紧凑覆盖（S4 预筛提示5 正向对照——纯否定式断言在"整段紧凑 CSS 被删"时照样绿，本条补上对照组：删了会红）', () => {
        assert.ok(src.includes('.si-wrap .u-stat-card'), '页面内应存在 .si-wrap .u-stat-card 紧凑覆盖规则');
    });
    check('页面内 \'u-stat-card\' classes 数组产出点恰 2 处（statsRow 统计卡 + typeCardsRow 类型卡），防未来第三处渲染区被连带压缩无感知（若新开一个卡渲染区，本条会翻红提醒同步纳入紧凑覆盖评估）', () => {
        const strippedSrc = stripComments(src);
        const occurrences = (strippedSrc.match(/\['u-stat-card'\]/g) || []).length;
        assert.strictEqual(occurrences, 2, `'u-stat-card' classes 数组字面量应恰出现 2 处，实得 ${occurrences}`);
        const statsBody = bodyOf('siRenderStats');
        const typeBody = bodyOf('siRenderTypeCards');
        assert.ok(statsBody && /\['u-stat-card'\]/.test(statsBody), 'siRenderStats 函数体内未见 u-stat-card 产出点');
        assert.ok(typeBody && /\['u-stat-card'\]/.test(typeBody), 'siRenderTypeCards 函数体内未见 u-stat-card 产出点');
    });

    console.log('  — siRenderStats 接线四条（M4-M7 四破法沿用，现改抓「待我处理」聚合卡接线）—');
    // M4 破法：siRenderStats 计数改成内联另一份判据（不再调用 siIsMyPending）——上面沙箱真执行只验证了
    //   "siIsMyPending 这个函数自己对不对"，没验证 siRenderStats 是否真的调用了它，本条补上这个缺口。
    check('接线①：siRenderStats 内确实调用了 siIsMyPending（非内联另一份判据）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/\bsiIsMyPending\b/.test(body), '未见 siIsMyPending 调用——统计卡计数应复用唯一聚合谓词函数，不应另写一份判据（禁双实现）');
    });
    // M5 破法：stats.unshift({key:'my_pending',...}) 被挪到 siShouldRenderConditionalCard(...) 判断之外
    //   （变成无条件插入），真值表本身测得再对，接不上线也白测。
    check('接线②：stats.unshift({key:\'my_pending\',...}) 确实挂在 siShouldRenderConditionalCard(...) 条件分支内部（非无条件插入）', () => {
        const body = bodyOf('siRenderStats');
        const ifIdx = body.indexOf('if (siShouldRenderConditionalCard(');
        assert.ok(ifIdx >= 0, '未见 if (siShouldRenderConditionalCard(...)) 条件分支');
        const closeIdx = body.indexOf('\n        }', ifIdx);
        assert.ok(closeIdx > ifIdx, '未能定位该 if 分支收尾（8 空格缩进假设可能与实现不符，需人工核实）');
        const ifBlock = body.slice(ifIdx, closeIdx);
        assert.ok(/stats\.unshift\(/.test(ifBlock), `stats.unshift(...) 应在 siShouldRenderConditionalCard(...) 条件分支内部，实得该分支内容：${ifBlock}`);
    });
    // M6 破法（S2-M4 同款陷阱）：卡对象字面量 key: 'my_pending' 与 siMatchStatFilter 里路由判断的
    //   'my_pending' 分开维护，一处改了拼写另一处忘改——"两处都出现这串字符"这类存在性文本检查测不出
    //   这种漂移，必须提取两处**各自真实值**做相等比对，值不同才判红。
    check('接线③：卡 key 字面量与 siMatchStatFilter 路由到 siIsMyPending 的 key 字面量同串比对（提取两处真实值逐字比对，一处改另一处不改即判红）', () => {
        const rsBody = bodyOf('siRenderStats');
        const ifIdx = rsBody.indexOf('if (siShouldRenderConditionalCard(');
        assert.ok(ifIdx >= 0, '未见 siShouldRenderConditionalCard 条件分支（若接线②已红，此处连带红属预期，非独立缺陷）');
        const closeIdx = rsBody.indexOf('\n        }', ifIdx);
        const ifBlock = rsBody.slice(ifIdx, closeIdx > ifIdx ? closeIdx : rsBody.length);
        const cardKeyMatch = ifBlock.match(/key:\s*'([^']*)'/);
        assert.ok(cardKeyMatch, '未在该 if 分支内提取到 key: \'...\' 字面量');

        const msfBody = bodyOf('siMatchStatFilter');
        // [2026-08-27 二次拍板·去重拆除] 路由行回归单参 siIsMyPending(item)（repMap 透传链随代表机制
        //   整体移除）——仍钉住路由行形态与 key 字面量同串。
        const routeLineMatch = msfBody.match(/filterKey === '([^']*)'\)\s*return\s*siIsMyPending\(item\)/);
        assert.ok(routeLineMatch, 'siMatchStatFilter 内未提取到路由行 `filterKey === \'...\') return siIsMyPending(item)`——去重拆除后应为单参调用');

        assert.strictEqual(cardKeyMatch[1], routeLineMatch[1], `卡 key 字面量（${cardKeyMatch[1]}）应与筛选路由字面量（${routeLineMatch[1]}）逐字相同——一处改动另一处未同步会在此判红`);
    });
    // M7 破法：计数基数改用别的变量/别的过滤链（如误用已按 siActiveType 过滤过的集合），既有断言组测
    //   不到"基数变量选对了没有"，本条直接钉住字面量。
    check('接线④：「待我处理」计数基数确实来自 vis（与其余状态卡同一基数变量，非另开一份口径）', () => {
        const body = bodyOf('siRenderStats');
        // [2026-08-27 二次拍板·去重拆除] statsRepMap 快照链已随代表机制移除，计数回归单参调用。
        //   本断言的**防护意图不变**：计数基数必须仍是 vis（与其余状态卡同一基数变量，非另开一份口径）。
        assert.ok(/myPendingCount\s*=\s*vis\.filter\(\s*i\s*=>\s*siIsMyPending\(i\)\s*\)\.length/.test(body),
            '未见 myPendingCount = vis.filter(i => siIsMyPending(i)).length —— 计数基数应用与其余卡相同的 vis 变量');
        assert.ok(!/statsRepMap|siComputeReleaseRepMap/.test(body),
            'siRenderStats 内出现 statsRepMap/siComputeReleaseRepMap——代表快照机制已随去重拆除移除，不应重新引入');
    });
    // [S-fix4·codex 414/415 MED-1] 可点卡交互语义静态钉扎（真执行两态断言在 verify-sys-type-cards ⑤ 组，
    //   本文件按自身文本级定位补状态卡循环侧）——通用断言，与本次「待我处理」改写无关，原样保留未改。
    check('接线⑤a：状态卡循环对可点卡输出 role="button"+tabindex+onkeydown 三件套且与 s.key===null 静态卡互斥', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/const interactive = s\.key === null \? '' : ` role="button" tabindex="0" onkeydown="siCardKeydown\(event\)" aria-pressed=/.test(body), '未见 interactive 属性三件套的静态卡互斥三元（s.key===null 不挂）');
        assert.ok(/\$\{onClick\}\$\{interactive\}/.test(body), 'interactive 应紧随 onClick 拼进卡模板（漏拼=属性算了没上卡）');
    });
    check('接线⑤b：aria-pressed 与视觉 active class 同源（classes.includes(\'active\')·非另写一份激活判据）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/aria-pressed="\$\{classes\.includes\('active'\)\}"/.test(body), 'aria-pressed 应取 classes.includes(\'active\')——另写判据会与视觉激活态漂移');
    });
    // [观察反馈优化批 R7] 「待我处理」卡 count>0 状态强化（红点+状态色，demo V3 定稿）——同 M4-M7
    //   系列纪律：钉住"真的接在 siRenderStats 里、真的按 s.key==='my_pending' && s.n>0 门控"，
    //   不满足于"class 名字符串在全文出现过"这类弱存在性检查。count=0 时（含"筛选激活但已归零"的
    //   siShouldRenderConditionalCard 转义分支，那时 s.n===0）该 class 不应被追加。
    check('接线⑥：siRenderStats 内确实按 s.key===\'my_pending\' && s.n>0 门控追加 si-stat-alert class（红：门控条件被弱化/缺失——count=0 时不该带该 class）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/if\s*\(\s*s\.key\s*===\s*'my_pending'\s*&&\s*s\.n\s*>\s*0\s*\)\s*classes\.push\('si-stat-alert'\);/.test(body),
            '未找到 "if (s.key===\'my_pending\' && s.n>0) classes.push(\'si-stat-alert\');" 门控语句');
    });
    check('活体变异对照组：门控条件弱化为恒真（漏 && s.n>0）——上方严格正则字面匹配须判红（证明本条真的钉住 && s.n>0 这个条件，非"class 名字符串出现过"这类弱存在性检查）', () => {
        const mutated = bodyOf('siRenderStats').replace(
            "if (s.key === 'my_pending' && s.n > 0) classes.push('si-stat-alert');",
            "if (s.key === 'my_pending') classes.push('si-stat-alert');"
        );
        assert.ok(!/if\s*\(\s*s\.key\s*===\s*'my_pending'\s*&&\s*s\.n\s*>\s*0\s*\)\s*classes\.push\('si-stat-alert'\);/.test(mutated),
            '变异后的弱化门控文本不应再匹配严格正则（若仍匹配说明上方断言未真的锁死 && s.n>0 这个条件）');
    });
    check('.si-wrap .u-stat-card.si-stat-alert 规则声明体存在（红：CSS 变体规则缺失，class 加了但样式没跟上——沿用 465 LOW-2 精神，页面内 <style> 而非共享 components.css）', () => {
        assert.ok(src.includes('.si-wrap .u-stat-card.si-stat-alert'), '页面内应存在 .si-wrap .u-stat-card.si-stat-alert 规则');
        assert.ok(!css.includes('si-stat-alert'), 'components.css 不应包含 si-stat-alert（应仅存在于 Sys_Iteration.html 页面内 <style>）');
    });
    // [codex 477 回卷 MED-2] 原 border-left:3px solid 会与 components.css 基础 .u-stat-card 已有 border
    //   叠加出几何差异——count 0↔1 切换时卡片左边框从"共享 1px"变成"本层 3px"，整卡宽度跟着抖 2px。
    //   改用 inset box-shadow（不参与盒模型/布局计算，纯视觉图层，count 切换零几何影响）。
    check('.si-wrap .u-stat-card.si-stat-alert 规则用 box-shadow:inset 3px 0 0 #dc2626 表达左侧红色强调，且不再声明 border-left（红：border-left 计入盒模型，count 0↔1 切换时卡片宽度会抖 2px；box-shadow 不参与布局，是 codex 477 MED-2 裁定的零几何影响修法）', () => {
        const re = /\.si-wrap \.u-stat-card\.si-stat-alert\s*\{([^}]*)\}/;
        const m = re.exec(src);
        assert.ok(m, '页面内应存在 .si-wrap .u-stat-card.si-stat-alert 规则');
        const rule = m[1];
        assert.ok(/box-shadow:\s*inset\s+3px\s+0\s+0\s+#dc2626/.test(rule), '规则缺 box-shadow:inset 3px 0 0 #dc2626');
        assert.ok(!/border-left:/.test(rule), '规则不应再含 border-left（会引入几何抖动，须已被上面的 box-shadow 取代）');
    });
    // [codex 477 复审「顺手核实」] components.css 的 .u-stat-card:hover((0,2,0)) 声明了
    //   box-shadow:0 2px 8px rgba(217,119,6,.08)——box-shadow 不可跨规则累加，特异性更高的
    //   .si-stat-alert((0,3,0)) 若不补 :hover 组合规则，会把悬浮阴影整体顶替掉（不是消失，是被换成
    //   别的视觉），鼠标悬浮在告警态卡片上时看起来"没反应"。修法=在 :hover 组合选择器里用逗号把两条
    //   阴影合成同一声明的多值——box-shadow 唯一支持"多重效果共存"的写法。
    check('.si-wrap .u-stat-card.si-stat-alert:hover 组合规则存在，同一 box-shadow 声明内以逗号叠加悬浮阴影（0 2px 8px rgba(217,119,6,.08)）与红色内嵌线（inset 3px 0 0 #dc2626）两值（红：缺该组合规则——悬浮告警态卡片时琥珀悬浮阴影会被红色内嵌线整体顶替而非共存，用户会觉得"hover 没反应"）', () => {
        const re = /\.si-wrap \.u-stat-card\.si-stat-alert:hover\s*\{([^}]*)\}/;
        const m = re.exec(src);
        assert.ok(m, '页面内应存在 .si-wrap .u-stat-card.si-stat-alert:hover 规则');
        const rule = m[1];
        const bsMatch = /box-shadow:\s*([^;]+);/.exec(rule);
        assert.ok(bsMatch, '规则缺 box-shadow 声明');
        const value = bsMatch[1];
        assert.ok(/0\s+2px\s+8px\s+rgba\(217,\s*119,\s*6,\s*\.08\)/.test(value), `box-shadow 值应含悬浮阴影 0 2px 8px rgba(217,119,6,.08)，实际：${value}`);
        assert.ok(/inset\s+3px\s+0\s+0\s+#dc2626/.test(value), `box-shadow 值应含红色内嵌线 inset 3px 0 0 #dc2626，实际：${value}`);
        assert.ok(value.includes(','), `两个阴影值应在同一 box-shadow 声明内用逗号叠加（box-shadow 不支持跨规则累加，必须同一声明多值），实际：${value}`);
    });
    // [Opus 预筛拦截-1] .si-stat-alert(0,3,0) 特异性会盖掉共享 .u-stat-card.active(0,2,0)——点卡筛选
    //   是本卡唯一交互用途，一点就 alert+active 叠加却丢了选中视觉反馈（aria-pressed 仍为 true，视觉
    //   与 aria 漂移）。补组合选择器规则钉住：命中态恢复 active 色系（background/border-color 同
    //   components.css .u-stat-card.active 取值）。[codex 477 回卷 MED-2 更新] 红色左侧强调已改走
    //   box-shadow（独立于 border 之外），本组合规则因此不再需要覆盖 border-left-color。
    check('.si-wrap .u-stat-card.si-stat-alert.active 组合规则存在，恢复 active 色系（background:#fffbeb ∧ border-color:#d97706），且不再含（已随 MED-2 删除的）border-left-color（红：缺该组合规则——点选中「待我处理」卡时会丢失选中视觉反馈；或仍残留 border-left-color——box-shadow 已独立表达红色强调，不该再靠 border 通道叠一份）', () => {
        const re = /\.si-wrap \.u-stat-card\.si-stat-alert\.active\s*\{([^}]*)\}/;
        const m = re.exec(src);
        assert.ok(m, '页面内应存在 .si-wrap .u-stat-card.si-stat-alert.active 组合规则');
        const rule = m[1];
        assert.ok(/background:\s*#fffbeb/.test(rule), '组合规则缺 background:#fffbeb（应恢复 .u-stat-card.active 色系）');
        assert.ok(/border-color:\s*#d97706/.test(rule), '组合规则缺 border-color:#d97706（应恢复 .u-stat-card.active 色系）');
        assert.ok(!/border-left-color:/.test(rule), '组合规则不应再含 border-left-color（MED-2 后红色强调已独立走 box-shadow，不该再靠 border 通道表达，留着会是死代码/混淆信号）');
    });
}

// [S1·先行上线授权超时收回·S2 前端收口·2026-08-16] 新增：
//   ⑬ siFastlaneAuthWindowHtml（详情面板授权窗口/超时提示行）已定义 + 并入 siRenderDrawer 的
//      fastlaneBlock 拼接（非孤立死函数）+ 过期/窗口内两条渲染分支存在 + 非残留返回空串 + deadline
//      月日插值走 esc() 转义（同族既有转义纪律）。
//   ⑭ siModalFastReleaseRevoke 按 fast_release_auth_expired 分叉文案/必填校验 + 响应按
//      r.data.expired 分叉 toast 文案。
//   ⑮ 时间线三表（SI_TL_LABEL/SI_TL_CLS/SI_TL_NOTE_OWN_LABEL_CODES）均已登记 fast_release_auth_expired
//      （S1 遗留 LOW-4 收口）。
console.log('— ⑬ siFastlaneAuthWindowHtml 授权窗口/超时提示行：定义+接线+分支+转义 —');
check('siFastlaneAuthWindowHtml 函数已定义', () => {
    assert.ok(bodyOf('siFastlaneAuthWindowHtml'), '未提取到 siFastlaneAuthWindowHtml 函数体');
});
check('siRenderDrawer 已调用 siFastlaneAuthWindowHtml 并拼入 fastlaneBlock（非孤立死函数）', () => {
    const body = bodyOf('siRenderDrawer');
    assert.ok(body, '未提取到 siRenderDrawer 函数体');
    assert.ok(/const fastlaneBlock = siFastlaneAuthWindowHtml\(iss\) \+ siFastlaneExecSectionHtml\(/.test(body), 'siRenderDrawer 未见 fastlaneBlock = siFastlaneAuthWindowHtml(iss) + siFastlaneExecSectionHtml(...) 拼接——窗口提示行算出来了但可能没拼进详情 body');
});
check('过期分支：fast_release_auth_expired===1 时渲染"已超时"醒目样式文案', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(body.includes('fast_release_auth_expired'), '未见 fast_release_auth_expired 判据');
    assert.ok(body.includes('已超时'), '未见"已超时"文案');
    assert.ok(body.includes('转常规验收'), '未见"转常规验收"文案（方案 §6 展示面要求的完整措辞）');
    assert.ok(/color:\s*#dc2626/.test(body), '过期分支未见醒目红色样式（同列表页"先行上线待补验收（超48h）"同款高亮先例）');
});
// [S2-fix MED-1] 判据↔文案邻接绑定——上面两条 includes 断言只证明"两个字符串都在函数体某处出现"，
//   不证明它们在**同一分支**（若过期支的判据与窗口内支的文案错位拼接，两条 includes 仍会各自为真、
//   整组照样绿）。改用距离受限正则把"判据字符串"与"其对应文案"绑进同一段邻接文本，才真正钉住"这段
//   判据后紧跟的是它自己那句文案"。距离阈值按本函数体实测字符距离取（node 实测：expired→已超时=197
//   字符，active_auth→先行上线窗口截止=551 字符，均含判据条件本身其余部分+LOW-2/LOW-3 新增代码），
//   各留餘量（220/600）——太紧会把本次 LOW 系列合法新增内容（联判条件、底色样式）挤出窗口误判为
//   "没绑上"，太松则起不到"抓错位"的效果；两条阈值均已按本文件实际改动后的函数体重新量过，非凭感觉
//   取整。本组与上面两条 includes 断言互补，不删旧断言。
check('过期分支判据↔文案邻接绑定：fast_release_auth_expired 后 ≤220 字符内出现"已超时"（非错位拼接）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/fast_release_auth_expired[\s\S]{0,220}?已超时/.test(body), '未见 fast_release_auth_expired 判据与"已超时"文案在 220 字符内邻接——可能判据与文案被错位拼接到了不同分支');
});
check('窗口内分支：fast_release_active_auth===1 且 deadline 非空时渲染截止提示（含"剩余约 N 小时"）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(body.includes('fast_release_active_auth'), '未见 fast_release_active_auth 判据');
    assert.ok(body.includes('fast_release_auth_deadline'), '未见 fast_release_auth_deadline 读取——deadline 应来自服务端投影，不应自行推算');
    assert.ok(body.includes('先行上线窗口截止'), '未见"先行上线窗口截止"文案');
    assert.ok(/剩余约.*小时/.test(body), '未见"剩余约 N 小时"文案模式');
    assert.ok(!/new Date\(iss\.fast_release_auth_deadline\)/.test(body), '不应把 deadline 整串扔给 new Date() 解析（本文件既有 UTC/本地时区陷阱纪律，应走分量构造）');
});
check('窗口内分支判据↔文案邻接绑定：fast_release_active_auth 后 ≤600 字符内出现"先行上线窗口截止"（非错位拼接）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/fast_release_active_auth[\s\S]{0,600}?先行上线窗口截止/.test(body), '未见 fast_release_active_auth 判据与"先行上线窗口截止"文案在 600 字符内邻接——可能判据与文案被错位拼接到了不同分支');
});
check('deadline 月日插值走 esc() 转义（既有转义纪律，防未来 deadline 格式被污染时的注入面）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/\$\{esc\(mmdd\)\}/.test(body), '月日插值未见 esc(mmdd)——应走既有 esc 转义范式');
});
// [S2-fix LOW-1] 时分不再硬编码"08:00"字面量，改渲染服务端 deadline 自带的 m[4]/m[5]（时/分）——
//   规则常量（次日 8:00）只应活在后端，前端只忠实展示。
check('窗口内分支时分渲染服务端值 ${m[4]}:${m[5]}（不硬编码 08:00 字面量，规则常量只活在后端）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/\$\{esc\(m\[4\]\)\}:\$\{esc\(m\[5\]\)\}/.test(body), '未见 ${esc(m[4])}:${esc(m[5])} 时分渲染——应取服务端 deadline 自带时分而非硬编码 08:00');
    assert.ok(!/剩余约[\s\S]{0,80}?08:00|08:00[\s\S]{0,80}?剩余约/.test(body), '窗口内文案不应仍出现硬编码 "08:00" 字面量（应已改渲染 m[4]/m[5]）');
});
// [S2-fix LOW-2] 过期分支底色——.si-gate-hint 基类默认 amber 底，红字配 amber 底与"醒目红色警示"意图
//   不符，需显式覆盖背景/边框色。
check('过期分支 inline 样式含底色覆盖 background:#fef2f2;border-color:#fecaca（红字红底一致，覆盖 .si-gate-hint 默认 amber 底）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/background:\s*#fef2f2/.test(body), '过期分支未见 background:#fef2f2 底色覆盖');
    assert.ok(/border-color:\s*#fecaca/.test(body), '过期分支未见 border-color:#fecaca 边框色覆盖');
});
// [S2-fix LOW-3] 过期分支联判补 fast_release_auth_deadline——deadline 与 expired 同源残留门控，零成本
//   纵深防御：万一 expired 字段被误改成脱离残留语义的口径，deadline 仍保持"仅残留时非空"，联判可让
//   非残留单免疫误显红标。[S2-fix2 ①] 结构从扁平 `if (A && B)` 改为嵌套 `if (A) { if (B) {...} else
//   {...console.warn...} }`（联判的逻辑结果不变，仍是"两者皆真才渲染红标"；只是要在"A 真 B 假"这个
//   理论态上插入观察线索分支，扁平写法表达不了这个三态分岔，改嵌套非改判据方向——codex 424-M1 的
//   "改判据方向"部分已被主会话驳回，本条改的是控制流结构，不是驳回的那部分）。断言同步改认嵌套结构：
//   外层 `if (fast_release_auth_expired) === 1)`，内层 `if (iss.fast_release_auth_deadline)` 紧随其后。
check('过期分支判据联判 fast_release_auth_deadline（嵌套 if 结构：外层 expired===1，内层 deadline 非空才渲染红标）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/Number\(iss\.fast_release_auth_expired\)\s*===\s*1\)\s*\{[\s\S]{0,60}?if\s*\(iss\.fast_release_auth_deadline\)\s*\{/.test(body), '过期分支未见嵌套结构 "if (expired===1) { if (deadline) { ... } }"——应与 deadline 同源门控形成纵深防御');
});
check('联判不满足（expired=1 但 deadline 缺失，理论不可达态）时留 console.warn 观察线索，不渲染红标（codex 424-M1 精神部分采纳）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    assert.ok(/console\.warn\('\[siFastlane\] expired=1 但 deadline 缺失/.test(body), '未见 console.warn(\'[siFastlane] expired=1 但 deadline 缺失...\')——联判不满足的理论态应留观察线索');
    assert.ok(/console\.warn\([^)]*iss\.id\)/.test(body), 'console.warn 调用未见携带 iss.id——观察线索应能定位到具体单据');
});
check('非残留（两者皆 0/null）路径最终返回空串（不显示本条）', () => {
    const body = bodyOf('siFastlaneAuthWindowHtml');
    const trimmed = body.trim();
    assert.ok(/return\s*'';\s*\}$/.test(trimmed), '函数末尾未见兜底 return \'\'——非残留场景应不渲染任何内容');
});

console.log('— ⑭ siModalFastReleaseRevoke 撤销弹窗（S2-fix3 ②：按钮已结构性过点隐藏，isExpired 快照分支删除，回归单一撤销语义） —');
check('[S2-fix3 ②·全文件] isExpired 全文件零残留（剥注释后·防残渣落进 siRenderActions 等其它 helper 逃出函数体级断言面·预筛 LOW-1）', () => {
    assert.ok(!/isExpired/.test(stripComments(src)), '剥注释后的页面源码仍含 isExpired——快照分支残渣落在 siModalFastReleaseRevoke 之外');
});
check('[S2-fix3 ②] isExpired 快照分支已删——函数体不应再出现 isExpired 变量/判据（撤销按钮已过点隐藏，快照分叉不可达）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(body, '未提取到 siModalFastReleaseRevoke 函数体');
    assert.ok(!/isExpired/.test(body), '函数体仍出现 isExpired——S2-fix3 ② 应已删除该快照分支，回归单一撤销语义');
});
check('note 文案回归单一措辞（不再按 isExpired 二选一，"该授权已超时"分支已删）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(body.includes('撤销后开发提交将不再触发先行上线挂牌'), '未见既有"人工撤销"说明文案');
    assert.ok(!body.includes('该授权已超时，确认后将按超时收回'), '不应仍出现"该授权已超时"文案——该分支已随按钮门控变更结构性不可达，应已删除');
});
check('reason 输入框恢复无条件必填（fTextarea req 参数恒为 true，不再绑 !isExpired）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(/fTextarea\('reason', '撤销原因', '', true,/.test(body), '未见 fTextarea reason 字段 req 参数恒为 true——应恢复无条件必填');
});
check('isExpired 专属 placeholder"填写内容不会记录"已随分支一并删除', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(!body.includes('本单已超时，填写内容不会记录'), '不应仍出现该 isExpired 专属 placeholder 文案');
});
check('reason 必填 + 200 字校验无条件生效（不再收拢在 if (!isExpired) 分支内）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(/if \(!reason \|\| reason\.length > 200\) \{ showToast\('撤销原因必填（trim 1~200字）', 'error'\); return false; \}/.test(body), '未见无条件必填+200字校验——应恢复为不含 isExpired 分支保护的直接校验');
    assert.ok(!/if\s*\(!isExpired\)/.test(body), '函数体不应仍出现 if (!isExpired) 分支包裹');
});
check('body.reason 恢复无条件携带（不再收拢在 isExpired 分支内才赋值）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(/const body = \{ reason \};/.test(body), '未见 body.reason 恢复无条件携带（const body = { reason };）');
});
// [S1·S2 F2·S2-fix3 ②保留] 响应分叉是本函数唯一保留的 expired 相关逻辑——按钮已按消费投影隐藏，正常
//   点击路径不会再撞到后端格4；但存在并发窗口：用户打开详情页停留跨过次日 8:00，提交时仍可能落到后端
//   classifyFastReleaseRevokeCase 的格4（残留∧过期），返回 expired:true。该分叉存在的唯一理由就是这个
//   竞态窗口，不是常规路径。
check('响应处理仍按 r.data.expired===true 分叉 toast 文案（并发窗口下唯一保留的 expired 相关逻辑）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(/r\.data\s*&&\s*r\.data\.expired\s*===\s*true/.test(body), '未见 r.data && r.data.expired === true 判据——响应分叉是并发窗口下唯一存在理由，应保留');
    assert.ok(body.includes('已按超时收回'), '未见"已按超时收回" toast 文案');
    assert.ok(body.includes('已撤销先行上线授权'), '未见既有"已撤销先行上线授权" toast 文案（回归：常规路径 toast 不应被删除）');
});

console.log('— ⑮ 时间线三表登记 fast_release_auth_expired（S1 遗留 LOW-4 收口） —');
// [S2-fix 顺手] 三条改走 stripComments(src)（而非裸 src）——与本文件其余全部断言面统一走 bodyOf()（=
//   extractFunctionBody 结果先剥注释）同一条纪律（Opus 合并预筛 LOW-1 修复·2026-08-14 头部注释已述
//   理由）：裸 src 直接正则匹配同样可能被注释里出现的同一字面量（如解释性注释提到"'授权超时收回'
//   这个词条"）误判为"看见了"。三表是模块级常量而非函数体，不能走 bodyOf(fnName)，故就地
//   stripComments(src) 一次，非新造一条并行剥注释路径。
check('SI_TL_LABEL 含 fast_release_auth_expired: \'授权超时收回\'', () => {
    assert.ok(/fast_release_auth_expired:\s*'授权超时收回'/.test(stripComments(src)), 'SI_TL_LABEL 未见 fast_release_auth_expired: \'授权超时收回\' 词条');
});
check('SI_TL_CLS 含 fast_release_auth_expired 配色词条', () => {
    const m = stripComments(src).match(/const SI_TL_CLS = \{[\s\S]*?\n {4}\};/);
    assert.ok(m, '未定位到 SI_TL_CLS 对象字面量');
    assert.ok(/fast_release_auth_expired:\s*'si-tl-\w+'/.test(m[0]), 'SI_TL_CLS 未见 fast_release_auth_expired 配色词条');
});
check('SI_TL_NOTE_OWN_LABEL_CODES 含 fast_release_auth_expired（独立徽章，非落回通用「备注」）', () => {
    const m = stripComments(src).match(/const SI_TL_NOTE_OWN_LABEL_CODES = new Set\(\[[^\]]*\]\);/);
    assert.ok(m, '未定位到 SI_TL_NOTE_OWN_LABEL_CODES Set 字面量');
    assert.ok(m[0].includes("'fast_release_auth_expired'"), 'SI_TL_NOTE_OWN_LABEL_CODES 未见 \'fast_release_auth_expired\' 成员');
});

console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
