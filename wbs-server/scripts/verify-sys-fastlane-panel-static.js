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
 * 任务_值班筛选与类型卡_长任务锚点_20260815.md §3 技术自决] 新增：
 *   ⑫ siIsMyFastlanePending/siMatchStatFilter/siShouldRenderMyFastlaneCard **沙箱真执行**（非静态
 *      文本匹配——照 verify-sys-eta-generation.js [A1]/[R6] 先例，提取函数全文用 new Function 编译为
 *      真可调用函数，喂真实输入向量真执行断言，能证明"四条件逐一翻转会不会正确翻转判定"这类行为，
 *      纯文本 .includes()/正则做不到）：谓词四条件逐一翻转→false + 全真→true（反向一对）；
 *      siMatchStatFilter 的 'my_fastlane' 横切 key 路由到谓词（真/假各一）+ 既有状态组 key 行为不变
 *      + 未知 key 仍放行（现状兜底语义未被改坏）；siShouldRenderMyFastlaneCard 卡渲染条件三态
 *      （count>0 渲染／count=0 非激活不渲染／count=0 但激活仍渲染）。
 *
 * [S-fix 修复批·2026-08-15 追加] 预筛两轮意见收口：
 *   ⑫ 组补 siRenderStats 接线四条（预筛 M4-M7 四破法各对一条，②③两条依赖同一段 if 分支文本提取，
 *      互不替代——②证"push 真在条件内"，③证"分支内的 key 与筛选路由的 key 逐字相同"）：①确实调用
 *      siIsMyFastlanePending（非内联另一份判据）②stats.push 确实挂在 siShouldRenderMyFastlaneCard
 *      条件内（非无条件 push）③卡 key 字面量与 siMatchStatFilter 路由字面量提取真实值逐字比对（S2-M4
 *      同款陷阱：存在性文本检查测不出"两处各自拼错但都存在"这种漂移）④计数基数确实来自 vis（同其余
 *      状态卡口径，非另开一份）。
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

console.log('— ⑫ [值班筛选与类型卡·S2] siIsMyFastlanePending/siMatchStatFilter/siShouldRenderMyFastlaneCard 沙箱真执行 —');
{
    // 真执行范式（照 verify-sys-eta-generation.js [A1]/[R6] 先例）：静态 .includes()/正则只能证明
    //   "字符串出现过"，证不了"四条件逐一翻转会不会正确翻转判定"这类行为——本组从 HTML 提取函数
    //   全文（含签名，非 bodyOf() 剥壳后的纯体，需要签名才能 new Function 后按名取出），编译为真
    //   可调用函数，喂真实输入向量真执行断言。
    // [S-fix 4b] 单参数写法委派模块顶部已引入的 extractFunctionFullText（隐式绑定 src）——保持下方
    //   调用点 extractFullFunctionText('fnName') 的既有书写形态不变，不再手写裸括号扫描器。
    const extractFullFunctionText = (fnName) => extractFunctionFullText(src, fnName);
    // SI_STATUS_GROUPS 是 `const X = { ... };` 常量声明（非函数），shared 模块的 extractFunctionBody
    //   只支持 `function name(...) {` 形态，故此处仍保留本地裸括号扫描器（无共用替代品可用）；
    //   siMatchStatFilter 真执行时需要真实值——从源码提取而非在本文件手抄一份，避免两份状态组定义
    //   各自维护、后续新增状态组时漂移。[S-fix 4c] 提取物额外过键集完整性核验（见下方 check），防
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

    const fnIsMyFastlanePending = extractFullFunctionText('siIsMyFastlanePending');
    const fnShouldRenderCard = extractFullFunctionText('siShouldRenderMyFastlaneCard');
    const fnMatchStatFilter = extractFullFunctionText('siMatchStatFilter');
    const statusGroupsText = extractConstObjectText('SI_STATUS_GROUPS');

    // [S-fix 4c] 提取前置全部包进 check() 计数体系——此前 4 条 assert.ok 与下方 3 个 new Function 编译
    //   调用均是裸调用，提取失败/编译失败会抛出未捕获异常直接终止整个进程（该组之前/之后的全部断言
    //   都不会被计数，只留一条与本组无关的堆栈），而非像其余断言一样被记成一条可读的红色失败行。
    check('[⑫前置] 三函数+一常量全部提取成功（提不到=守卫空转，不能当通过）', () => {
        assert.ok(fnIsMyFastlanePending, '未提取到 siIsMyFastlanePending 函数全文');
        assert.ok(fnShouldRenderCard, '未提取到 siShouldRenderMyFastlaneCard 函数全文');
        assert.ok(fnMatchStatFilter, '未提取到 siMatchStatFilter 函数全文');
        assert.ok(statusGroupsText, '未提取到 SI_STATUS_GROUPS 常量全文');
    });
    check('[⑫前置] SI_STATUS_GROUPS 提取物键集完整（防提取静默截断——括号计数一旦被字面量骗偏，可能只切到半个对象却不报错，仍会 new Function 成功但少几个组）', () => {
        // eslint-disable-next-line no-new-func
        const statusGroupsObj = new Function(`${statusGroupsText}\nreturn SI_STATUS_GROUPS;`)();
        assert.deepStrictEqual(Object.keys(statusGroupsObj).sort(), ['acceptance', 'active', 'done', 'paused', 'release'],
            `SI_STATUS_GROUPS 提取物键集应恰为这 5 个（排序后比对），实得 ${JSON.stringify(Object.keys(statusGroupsObj).sort())}`);
    });

    let isMyFastlanePending, shouldRenderCard, matchStatFilter;
    check('[⑫前置] 三函数提取物均可编译为可调用函数', () => {
        // eslint-disable-next-line no-new-func
        isMyFastlanePending = new Function(`${fnIsMyFastlanePending}\nreturn siIsMyFastlanePending;`)();
        // eslint-disable-next-line no-new-func
        shouldRenderCard = new Function(`${fnShouldRenderCard}\nreturn siShouldRenderMyFastlaneCard;`)();
        // siMatchStatFilter 依赖 SI_STATUS_GROUPS 常量与 siIsMyFastlanePending 函数两个外部符号——一并
        //   注入同一份编译文本（函数声明具名提升，siMatchStatFilter 体内可直接引用），同 [A1] 组
        //   "siDeadlineToLocalInput 依赖 siToLocalInput，两函数体一并注入"同一手法。
        // eslint-disable-next-line no-new-func
        matchStatFilter = new Function(`${statusGroupsText}\n${fnIsMyFastlanePending}\n${fnMatchStatFilter}\nreturn siMatchStatFilter;`)();
        assert.strictEqual(typeof isMyFastlanePending, 'function', 'siIsMyFastlanePending 应可编译为函数');
        assert.strictEqual(typeof shouldRenderCard, 'function', 'siShouldRenderMyFastlaneCard 应可编译为函数');
        assert.strictEqual(typeof matchStatFilter, 'function', 'siMatchStatFilter 应可编译为函数');
    });

    console.log('  — siIsMyFastlanePending：四条件逐一翻转 + 全真（反向一对） —');
    const BASE = { type: 'bug', status: '待验证', fast_release_active_auth: 1, fast_release_my_pending: 1 };
    check('全真 ⇒ true（实现坏成什么样这条会红：任一条件判据被误删会立即由下面四条反例现形）', () => {
        assert.strictEqual(isMyFastlanePending(BASE), true, '四条件全真应判 true');
    });
    check('type 翻转（非 bug）⇒ false', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, type: 'feature' }), false);
    });
    check('status 翻转（非待验证）⇒ false', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, status: '处理中' }), false);
    });
    check('fast_release_active_auth 翻转（0）⇒ false（原始信号不掺闸的消费端必须真的 AND 了它）', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, fast_release_active_auth: 0 }), false);
    });
    check('fast_release_my_pending 翻转（0）⇒ false', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, fast_release_my_pending: 0 }), false);
    });
    check('字符串型合法值（\'1\'）经 Number() 强制转换仍判 true（防止用严格 === 裸比较误杀后端下发的合法数值）', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, fast_release_active_auth: '1', fast_release_my_pending: '1' }), true);
    });
    check('字符串脏值（\'0\'）经 Number() 转换判 false（防真值判断把非空字符串 \'0\' 误判为真，与 siFastlaneFlagHtml 既有惯例同源）', () => {
        assert.strictEqual(isMyFastlanePending({ ...BASE, fast_release_my_pending: '0' }), false);
    });

    console.log('  — siMatchStatFilter：my_fastlane 横切 key 路由 + 既有状态组 key 行为不变 + 未知 key 仍放行 —');
    check('my_fastlane 路由到谓词·真例', () => {
        assert.strictEqual(matchStatFilter(BASE, 'my_fastlane'), true);
    });
    check('my_fastlane 路由到谓词·假例', () => {
        assert.strictEqual(matchStatFilter({ ...BASE, fast_release_my_pending: 0 }, 'my_fastlane'), false);
    });
    check('既有状态组 key（active）行为不变·命中', () => {
        assert.strictEqual(matchStatFilter({ status: '开发中' }, 'active'), true);
    });
    check('既有状态组 key（active）行为不变·不命中', () => {
        assert.strictEqual(matchStatFilter({ status: '已上线' }, 'active'), false);
    });
    check('未知 key 仍放行（现状既有兜底语义未被本次改动破坏）', () => {
        assert.strictEqual(matchStatFilter({ status: '随便什么状态' }, 'no_such_key_xyz'), true);
    });
    check('空 filterKey 仍放行（现状既有兜底语义未被本次改动破坏）', () => {
        assert.strictEqual(matchStatFilter({ status: '随便什么状态' }, ''), true);
    });

    console.log('  — siShouldRenderMyFastlaneCard：卡渲染条件三态 —');
    check('count>0 时渲染（不论是否激活）', () => {
        assert.strictEqual(shouldRenderCard(3, ''), true);
    });
    check('count=0 且非激活不渲染（若实现退化成恒 true，本条会红）', () => {
        assert.strictEqual(shouldRenderCard(0, ''), false);
    });
    check('count=0 但 siActiveStat===my_fastlane 仍渲染（堵陷阱：筛选激活时确认完最后一单，卡若消失用户被困在空筛选里出不来）', () => {
        assert.strictEqual(shouldRenderCard(0, 'my_fastlane'), true);
    });

    console.log('  — siRenderStats 接线四条（S-fix 4a，预筛 M4-M7 四破法各对一条）—');
    // M4 破法：siRenderStats 计数改成内联另一份判据（不再调用 siIsMyFastlanePending）——上面①-⑪的沙箱
    //   真执行只验证了"siIsMyFastlanePending 这个函数自己对不对"，没验证 siRenderStats 是否真的调用了
    //   它，这条正是补上这个缺口。
    check('接线①：siRenderStats 内确实调用了 siIsMyFastlanePending（非内联另一份判据）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/\bsiIsMyFastlanePending\b/.test(body), '未见 siIsMyFastlanePending 调用——统计卡计数应复用唯一谓词函数，不应另写一份判据（禁双实现）');
    });
    // M5 破法：stats.push(key: my_fastlane, ...) 被挪到 siShouldRenderMyFastlaneCard(...) 判断之外
    //   （变成无条件 push），三态渲染函数本身测得再对，接不上线也白测。
    check('接线②：stats.push(key:\'my_fastlane\',...) 确实挂在 siShouldRenderMyFastlaneCard(...) 条件分支内部（非无条件 push）', () => {
        const body = bodyOf('siRenderStats');
        const ifIdx = body.indexOf('if (siShouldRenderMyFastlaneCard(');
        assert.ok(ifIdx >= 0, '未见 if (siShouldRenderMyFastlaneCard(...)) 条件分支');
        const closeIdx = body.indexOf('\n        }', ifIdx);
        assert.ok(closeIdx > ifIdx, '未能定位该 if 分支收尾（8 空格缩进假设可能与实现不符，需人工核实）');
        const ifBlock = body.slice(ifIdx, closeIdx);
        assert.ok(/stats\.push\(/.test(ifBlock), `stats.push(...) 应在 siShouldRenderMyFastlaneCard(...) 条件分支内部，实得该分支内容：${ifBlock}`);
    });
    // M6 破法（S2-M4 同款陷阱）：卡对象字面量 key: 'my_fastlane' 与 siMatchStatFilter 里路由判断的
    //   'my_fastlane' 分开维护，一处改了拼写另一处忘改——"两处都出现这串字符"这类存在性文本检查测不出
    //   这种漂移（改错的那一处照样"存在一个字符串"），必须提取两处**各自真实值**做相等比对，值不同才
    //   判红（非"匹配不到预设的固定字面量"这种弱信号）。
    check('接线③：卡 key 字面量与 siMatchStatFilter 路由到 siIsMyFastlanePending 的 key 字面量同串比对（提取两处真实值逐字比对，一处改另一处不改即判红）', () => {
        const rsBody = bodyOf('siRenderStats');
        const ifIdx = rsBody.indexOf('if (siShouldRenderMyFastlaneCard(');
        assert.ok(ifIdx >= 0, '未见 siShouldRenderMyFastlaneCard 条件分支（若接线②已红，此处连带红属预期，非独立缺陷）');
        const closeIdx = rsBody.indexOf('\n        }', ifIdx);
        const ifBlock = rsBody.slice(ifIdx, closeIdx > ifIdx ? closeIdx : rsBody.length);
        const cardKeyMatch = ifBlock.match(/key:\s*'([^']*)'/);
        assert.ok(cardKeyMatch, '未在该 if 分支内提取到 key: \'...\' 字面量');

        const msfBody = bodyOf('siMatchStatFilter');
        const routeLineMatch = msfBody.match(/filterKey === '([^']*)'\)\s*return\s*siIsMyFastlanePending\(item\)/);
        assert.ok(routeLineMatch, 'siMatchStatFilter 内未提取到路由到 siIsMyFastlanePending 的 filterKey === \'...\' 判断行');

        assert.strictEqual(cardKeyMatch[1], routeLineMatch[1], `卡 key 字面量（${cardKeyMatch[1]}）应与筛选路由字面量（${routeLineMatch[1]}）逐字相同——一处改动另一处未同步会在此判红`);
    });
    // M7 破法：计数基数改用别的变量/别的过滤链（如误用已按 siActiveType 过滤过的集合），既有断言组
    //   （S2 遗留的四条件真执行断言）测不到"基数变量选对了没有"，本条直接钉住字面量。
    check('接线④：「待我确认」计数基数确实来自 vis（与其余状态卡同一基数变量，非另开一份口径）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/myFastlaneCount\s*=\s*vis\.filter\(/.test(body), '未见 myFastlaneCount = vis.filter(...) —— 计数基数应用与其余卡相同的 vis 变量');
    });
    // [S-fix4·codex 414/415 MED-1] 可点卡交互语义静态钉扎（真执行两态断言在 verify-sys-type-cards ⑤ 组，
    //   本文件按自身文本级定位补状态卡循环侧）：
    check('接线⑤a：状态卡循环对可点卡输出 role="button"+tabindex+onkeydown 三件套且与 s.key===null 静态卡互斥', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/const interactive = s\.key === null \? '' : ` role="button" tabindex="0" onkeydown="siCardKeydown\(event\)" aria-pressed=/.test(body), '未见 interactive 属性三件套的静态卡互斥三元（s.key===null 不挂）');
        assert.ok(/\$\{onClick\}\$\{interactive\}/.test(body), 'interactive 应紧随 onClick 拼进卡模板（漏拼=属性算了没上卡）');
    });
    check('接线⑤b：aria-pressed 与视觉 active class 同源（classes.includes(\'active\')·非另写一份激活判据）', () => {
        const body = bodyOf('siRenderStats');
        assert.ok(/aria-pressed="\$\{classes\.includes\('active'\)\}"/.test(body), 'aria-pressed 应取 classes.includes(\'active\')——另写判据会与视觉激活态漂移');
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
