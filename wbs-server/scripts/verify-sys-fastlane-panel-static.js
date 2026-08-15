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
 * [Opus 合并预筛 LOW-1 修复·2026-08-14] 全部断言面统一改走 bodyOf()（extractFunctionBody 结果先
 * stripComments 剥注释再扫描，照 verify-sys-list-badge-fields.js:57-59 同款范式）——本文件与
 * 姊妹文件的注释里大量出现被检查的函数名/字段名字面量（解释"为什么不该调用 X"之类），不剥注释会让
 * 否定式断言（"不应再调用 X"）被注释里同一字符串误判为红；姊妹文件 verify-sys-post-release-
 * panel-static.js 的同款既有缺口（stripComments 定义了但从未被调用）已顺手接线，非本批引入。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// 同姊妹文件 verify-sys-post-release-panel-static.js 的 balanced-brace 函数体提取范式。
function extractFunctionBody(source, fnName) {
    const startRe = new RegExp(`function\\s+${fnName}\\s*\\([^)]*\\)\\s*\\{`);
    const m = startRe.exec(source);
    if (!m) return null;
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.slice(start, i + 1);
        }
    }
    return null;
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
// "列表已算好布尔、前端只读"两条路线并存的隐患。镜像谓词本身**未删**，授权/撤销按钮（siRenderActions）
// 与授权弹窗标题措辞（siModalFastReleaseAuthorize）两处语境仍在消费，故只断言"执行区不再引用"，
// 不断言"全仓零引用"（那两处不消费 fast_release_executors/fast_release_exec_progress，没有对应的
// DTO 布尔字段可读，继续保留前端镜像判据是合理选择，非漏改）。
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
check('siHasActiveFastReleaseAuth 镜像谓词仍被其余语境（授权/撤销按钮、授权弹窗标题）消费，未被误删', () => {
    const actionsBody = bodyOf('siRenderActions');
    const modalBody = bodyOf('siModalFastReleaseAuthorize');
    assert.ok(actionsBody && actionsBody.includes('siHasActiveFastReleaseAuth('), 'siRenderActions 应仍调用 siHasActiveFastReleaseAuth（授权/撤销按钮显隐，未消费 DTO 布尔字段的语境不应被牵连改动）');
    assert.ok(modalBody && modalBody.includes('siHasActiveFastReleaseAuth('), 'siModalFastReleaseAuthorize 应仍调用 siHasActiveFastReleaseAuth（"重新授权"标题措辞）');
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

console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
