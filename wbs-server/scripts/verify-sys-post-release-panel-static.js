/**
 * verify-sys-post-release-panel-static.js
 *
 * 组 B·SB3（bug 先行上线补验收闭环，方案 v1.3 §3.1/§3.3）前端静态源码断言——用法同姊妹文件
 * verify-sys-release-panel-static.js：node scripts/verify-sys-post-release-panel-static.js
 * （纯文本源码扫描，无需启动 server，自包含）。
 *
 * 背景：SB1/SB2 只做了后端三个端点（fast-release-authorize/-revoke/submit direct_release，后者已随
 * 两步化方案 §4-2 拆除，见 [组B·S2] 订正），前端 UI 全部留到 SB3 补齐。本脚本钉住"代码里写没写对"这一层
 * （结构性不变量）；"真的显示出来了"那一层交给四条 Playwright 冒烟套件（test-sys-prerelease-flags/
 * test-sys-detail-ux/test-sys-commit-cols/test-sys-bug-hold-frontend 四套件回归，本轮已全部跑过，见任务
 * 报告 E 节），两层互补不重复。
 *
 * 覆盖：
 *   ① siHasActiveFastReleaseAuth 是唯一权威判据，被 siRenderActions（授权按钮"重新"措辞）引用——防
 *      详情页多处各写一份判据漂移（同后端 isActiveFastReleaseAuth 唯一实现先例）。[组B·S2 订正]
 *      原第二消费点 siModalSubmit（direct_release 勾选框显隐 + 提交收集条件）已随该勾选框整块拆除
 *      （方案 §4-2「整体替代」拍板），本组新增反向断言：siModalSubmit 函数体不应再出现
 *      siHasActiveFastReleaseAuth 引用（证明拆除干净，非"删了显示但漏删收集逻辑"这类半吊子拆除）。
 *      [S2-fix3 ①订正] 撤销按钮显隐已从该镜像判据摘出，改读服务端消费投影 fast_release_active_auth
 *      （用户裁定"截止时间前一直存在、过了截止时间隐藏"），不再是本条判据的消费点，见 ② 更新说明。
 *   ② siRenderActions 的 fastReleaseBtns 块：三个新增动作（授权/撤销/补验收）均只在 isAdminUser 下
 *      渲染；[S2-fix3 ①订正] 撤销按钮改在 Number(iss.fast_release_active_auth)===1 时出现（消费投影，
 *      不再跟随 hasActiveAuth 残留镜像）；补验收按钮只在 pending 时出现。
 *   ③ 三个新增弹窗函数（siModalFastReleaseAuthorize/siModalFastReleaseRevoke/siModalPostReleaseAccept）
 *      均已定义，且分别调用了正确的端点路径。
 *   ④ 详情页 postAcceptKv 三态分支（pending/passed/failed_derived）均存在且各自显式处理，兜底分支
 *      不静默吞值域外值。
 *   ⑤ 列表徽章 siPostAcceptFlagHtml 与 48h 判据 siIsPostAcceptOverdue 均已定义，且徽章函数确实调用
 *      了判据函数（非各写一份）。
 *   ⑥ [S2-fix3 ②订正] 撤销弹窗 reason 字段已回归恒必填（fTextarea req 参数恒为 true）——按钮已按 ②
 *      的消费投影门控结构性过点隐藏，isExpired 快照分叉（曾经的 !isExpired 必填豁免）已无触发路径，
 *      随之删除；请求体 body.reason 同步恢复无条件携带。
 *   ⑦ HTML 内联 <script> 语法有效（new Function 编译不执行，等价 node -c）。
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

// 同姊妹文件 verify-sys-release-panel-static.js 的 balanced-brace 函数体提取范式。
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
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}
// [Opus 合并预筛 LOW-1 顺手修·2026-08-14·非本批引入] stripComments 定义了却从未被调用——本文件全部
// 断言此前直接拿 extractFunctionBody 的原始（含注释）函数体做 .includes()/正则匹配，与
// verify-sys-fastlane-panel-static.js 同批修复的缺口逐字同款（本文件的注释同样会提到被检查的函数名/
// 字段名字面量，"未见调用 X"这类否定式断言可能被注释里的同一字符串误判）。顺手接线：断言面统一改走
// 本函数（剥注释后再扫描），不直接调用 extractFunctionBody。
function bodyOf(fnName) {
    const raw = extractFunctionBody(src, fnName);
    return raw == null ? null : stripComments(raw);
}

console.log('— ① siHasActiveFastReleaseAuth 唯一判据·两处引用 —');
check('siHasActiveFastReleaseAuth 函数已定义', () => {
    assert.ok(bodyOf('siHasActiveFastReleaseAuth'), '未提取到 siHasActiveFastReleaseAuth 函数体');
});
check('siRenderActions 引用 siHasActiveFastReleaseAuth（授权/撤销按钮显隐同一判据）', () => {
    const body = bodyOf('siRenderActions');
    assert.ok(body, '未提取到 siRenderActions 函数体');
    assert.ok(body.includes('siHasActiveFastReleaseAuth('), 'siRenderActions 未调用 siHasActiveFastReleaseAuth——授权/撤销按钮显隐可能各写了一份判据');
});
check('[组B·S2 订正] siModalSubmit 不应再引用 siHasActiveFastReleaseAuth（direct_release 勾选框已随两步化拆除）', () => {
    const body = bodyOf('siModalSubmit');
    assert.ok(body, '未提取到 siModalSubmit 函数体');
    const hits = (body.match(/siHasActiveFastReleaseAuth\(/g) || []).length;
    // 若拆除不干净（只删了渲染那一半、漏删提交收集那一半，或反过来），本条会红——用严格等于 0 而非
    // "<2"这种宽松上界，才能真正钉住"零残留"，不是仅仅"少了一处"。
    assert.strictEqual(hits, 0, `siModalSubmit 不应再出现 siHasActiveFastReleaseAuth 引用（勾选框已整块拆除），实得 ${hits} 处残留`);
});
check('[组B·S2 订正] Sys_Iteration.html 全文不应再出现 siSubmitDirectRelease 元素 id（勾选框 DOM 已整块拆除）', () => {
    assert.ok(!/siSubmitDirectRelease/.test(src), 'siSubmitDirectRelease 不应再出现在源码任何位置（HTML id 或 JS 读取）');
});

console.log('— ② siRenderActions fastReleaseBtns 块：三动作显隐条件 —');
check('fastReleaseBtns 块整体挂 isAdminUser 门（前端非授权源，仅体验层镜像后端 requireAdmin）', () => {
    const body = bodyOf('siRenderActions');
    const idx = body.indexOf('fastReleaseBtns');
    assert.ok(idx >= 0, 'siRenderActions 函数体未找到 fastReleaseBtns 变量');
    const block = body.slice(idx, idx + 1600);
    assert.ok(/isAdminUser\s*&&\s*iss\.type\s*===\s*'bug'/.test(block), 'fastReleaseBtns 块起手判断应为 isAdminUser && iss.type===\'bug\'（未见该条件组合）');
});
check('[S2-fix3 ①] 撤销按钮仅在 Number(iss.fast_release_active_auth)===1 时渲染（消费投影，非 hasActiveAuth 残留镜像）', () => {
    const body = bodyOf('siRenderActions');
    const idx = body.indexOf('fastReleaseBtns');
    const block = body.slice(idx, idx + 1600);
    assert.ok(/if \(Number\(iss\.fast_release_active_auth\) === 1\) \{[\s\S]*?siModalFastReleaseRevoke/.test(block), '撤销按钮未见挂在 Number(iss.fast_release_active_auth) === 1 条件分支内');
    assert.ok(!/if \(hasActiveAuth\) \{[\s\S]*?siModalFastReleaseRevoke/.test(block), '撤销按钮不应仍挂在 hasActiveAuth（残留镜像）条件分支内——过期后仍为 true，会与"过了截止时间隐藏"矛盾');
});
check('补验收按钮仅在 online_source_kind===authorized_fastlane 且 post_release_acceptance===pending 时渲染', () => {
    const body = bodyOf('siRenderActions');
    const idx = body.indexOf('fastReleaseBtns');
    const block = body.slice(idx, idx + 1600);
    assert.ok(block.includes("iss.online_source_kind === 'authorized_fastlane'") && block.includes("iss.post_release_acceptance === 'pending'"),
        '补验收按钮显隐条件未见 online_source_kind===authorized_fastlane 与 post_release_acceptance===pending 同时出现');
    assert.ok(/siModalPostReleaseAccept/.test(block), '未见补验收按钮 onclick 调用 siModalPostReleaseAccept');
});
check('fastReleaseBtns 已并入 box.innerHTML 最终拼接（非孤立死变量）', () => {
    const body = bodyOf('siRenderActions');
    const tail = body.slice(body.lastIndexOf('box.innerHTML'));
    assert.ok(tail.includes('fastReleaseBtns'), 'box.innerHTML 最终拼接未包含 fastReleaseBtns（渲染出的按钮永远不会显示——同 blocked 死分支同款漏法）');
});

console.log('— ③ 三个弹窗函数定义 + 端点路径正确 —');
check('siModalFastReleaseAuthorize 已定义且调用 POST .../fast-release-authorize', () => {
    const body = bodyOf('siModalFastReleaseAuthorize');
    assert.ok(body, '未提取到 siModalFastReleaseAuthorize 函数体');
    assert.ok(body.includes('/fast-release-authorize'), '未见调用 fast-release-authorize 端点');
});
check('siModalFastReleaseRevoke 已定义且调用 POST .../fast-release-revoke，body.reason 无条件携带', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    assert.ok(body, '未提取到 siModalFastReleaseRevoke 函数体');
    assert.ok(body.includes('/fast-release-revoke'), '未见调用 fast-release-revoke 端点');
    // [S2-fix3 ②订正] 撤销按钮已按 ② 的消费投影门控结构性过点隐藏，S2/S2-fix/S2-fix2 期间存在过的
    //   isExpired 快照分叉（reason 有值才携带/收拢在 if (!isExpired) 分支内）已随之删除，回归无条件
    //   携带 body.reason（详见姊妹文件 verify-sys-fastlane-panel-static.js ⑭ 组的完整覆盖）。
    assert.ok(/const body = \{ reason \};/.test(body), '未见 body.reason 无条件携带（const body = { reason };）');
    assert.ok(!/isExpired/.test(body), 'siModalFastReleaseRevoke 不应再出现 isExpired——快照分叉应已随按钮门控变更删除');
});
check('siModalPostReleaseAccept 已定义且调用 POST .../post-release-accept，body 含 verdict', () => {
    const body = bodyOf('siModalPostReleaseAccept');
    assert.ok(body, '未提取到 siModalPostReleaseAccept 函数体');
    assert.ok(body.includes('/post-release-accept'), '未见调用 post-release-accept 端点');
    assert.ok(body.includes('verdict'), '请求体未见 verdict 字段');
});
check('[S2-fix3 ②订正] 撤销弹窗 reason 字段必填标记恢复恒为 true（isExpired 分叉已删，回归无条件必填）', () => {
    const body = bodyOf('siModalFastReleaseRevoke');
    // [先行上线授权超时收回·S2 F2 订正] 曾把恒为字面量 true 改成按 !isExpired 分叉——S2-fix3 起撤销
    //   按钮已按消费投影门控结构性过点隐藏，isExpired 快照分叉不可达，已删除，reason 必填标记回归恒
    //   为字面量 true，不再是表达式。
    assert.ok(/fTextarea\('reason',\s*'撤销原因',\s*'',\s*true,/.test(body), '撤销原因字段未见 fTextarea(...,true,...) 恒必填标记');
});

console.log('— ④ 详情页补验收 kv 三态分支 —');
check('postAcceptKv 三态（pending/passed/failed_derived）均显式处理 + 值域外兜底不静默', () => {
    const idx = src.indexOf('let postAcceptKv');
    assert.ok(idx >= 0, '未找到 postAcceptKv 变量声明');
    const block = src.slice(idx, idx + 2200);
    assert.ok(block.includes("pa === 'pending'"), 'postAcceptKv 未见 pending 分支');
    assert.ok(block.includes("pa === 'passed'"), 'postAcceptKv 未见 passed 分支');
    assert.ok(block.includes("pa === 'failed_derived'"), 'postAcceptKv 未见 failed_derived 分支');
    assert.ok(/\} else \{[\s\S]{0,120}esc\(String\(pa\)\)/.test(block), '未见值域外兜底分支（应 esc(String(pa)) 原样露出，不静默吞成空/—）');
});
check('postAcceptKv 已并入 info 模板（非孤立死变量，渲染面真的会显示）', () => {
    const infoIdx = src.indexOf('const info = `<div class="u-detail-section"><h3>基本信息</h3>');
    assert.ok(infoIdx >= 0, '未找到 info 模板声明起点');
    const infoBlock = src.slice(infoIdx, infoIdx + 4000);
    assert.ok(infoBlock.includes('${postAcceptKv}'), 'info 模板未插值 ${postAcceptKv}——kv 算出来了但从未渲染（同 blocked 死分支同款漏法）');
});
check('failed_derived 分支含派生单可点击链接（siOpenDrawer）', () => {
    const idx = src.indexOf('let postAcceptKv');
    const block = src.slice(idx, idx + 2200);
    assert.ok(/failed_derived[\s\S]{0,400}siOpenDrawer\(/.test(block), 'failed_derived 分支未见 siOpenDrawer 派生单跳转链接');
});
check('[追加批·L2] postAcceptKv 三态基础文案均读 SI_POST_ACCEPTANCE_LABEL 字典（非硬编码中文字面量，字典与展示不再是两份并行映射）', () => {
    const idx = src.indexOf('let postAcceptKv');
    const block = src.slice(idx, idx + 2200);
    assert.ok(block.includes('SI_POST_ACCEPTANCE_LABEL.pending'), 'pending 分支未见读 SI_POST_ACCEPTANCE_LABEL.pending');
    assert.ok(block.includes('SI_POST_ACCEPTANCE_LABEL.passed'), 'passed 分支未见读 SI_POST_ACCEPTANCE_LABEL.passed');
    assert.ok(block.includes('SI_POST_ACCEPTANCE_LABEL.failed_derived'), 'failed_derived 分支未见读 SI_POST_ACCEPTANCE_LABEL.failed_derived');
});
check('[追加批·M2] postAcceptKv 的 48h 判据改读后端派生字段 iss.post_release_accept_overdue（不再前端自算）', () => {
    const idx = src.indexOf('let postAcceptKv');
    const block = src.slice(idx, idx + 2200);
    assert.ok(block.includes('iss.post_release_accept_overdue'), 'pending 分支未见读 iss.post_release_accept_overdue（后端权威 48h 判据）');
    assert.ok(!block.includes('siIsPostAcceptOverdue('), 'postAcceptKv 不应再调用前端 siIsPostAcceptOverdue（该函数已随 M2 修正删除，前端不再自算 48h）');
});

console.log('— ⑤ 列表徽章 + 48h 判据（[追加批·M2] 判据权威已收归后端，前端只读派生字段） —');
check('siPostAcceptFlagHtml 已定义且读后端派生字段 post_release_accept_overdue（不再前端自算 48h，判据同源）', () => {
    const body = bodyOf('siPostAcceptFlagHtml');
    assert.ok(body, '未提取到 siPostAcceptFlagHtml 函数体');
    assert.ok(body.includes('i.post_release_accept_overdue'), 'siPostAcceptFlagHtml 未读 i.post_release_accept_overdue——48h 判据可能仍在前端自算或被内联重写');
});
check('前端 siIsPostAcceptOverdue 函数已删除（M2 修正：判据权威收归后端 isPostReleaseAcceptOverdue，不留一份可能与后端漂移的前端副本）', () => {
    assert.ok(!bodyOf('siIsPostAcceptOverdue'), '仍能提取到 siIsPostAcceptOverdue 函数体——M2 修正要求删除该前端自算函数，不应仍存在（两份判据必然漂移）');
});
check('siPostAcceptFlagHtml 已并入 renderSysIterationRows 的 flags 拼接（非孤立死函数）', () => {
    const body = bodyOf('renderSysIterationRows');
    assert.ok(body, '未提取到 renderSysIterationRows 函数体');
    assert.ok(body.includes('siPostAcceptFlagHtml('), 'renderSysIterationRows 未调用 siPostAcceptFlagHtml——列表徽章算出来了但从未拼进 flags（同 blocked 死分支同款漏法）');
});

console.log('— ⑥ 撤销弹窗必填与后端拍板对齐（交叉核对） —');
check('前端撤销原因长度上限（200 字）与后端 FAST_RELEASE_REVOKE_REASON_TOO_LONG 校验口径一致', () => {
    const modalBody = bodyOf('siModalFastReleaseRevoke');
    assert.ok(/reason\.length > 200/.test(modalBody), '前端未见 reason.length > 200 的超长校验（应与后端 200 字上限对齐，早拦一道给及时反馈）');
});

console.log('— ⑦ HTML 内联 <script> 语法有效 —');
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
