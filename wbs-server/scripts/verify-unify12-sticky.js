/**
 * verify-unify12-sticky.js
 *
 * 前端统一 #12（2026-07-23）静态哨兵：抽屉按钮移顶 + 跨模块吸顶操作栏
 *
 * 用法：node scripts/verify-unify12-sticky.js   （自包含，无需启动 server）
 *
 * 断言范围：
 *   1. components.css：.u-action-bar-sticky 定义（sticky/top:-20px/z-index/背景）
 *   2. 挂类：Data_Correction / Sys_Iteration / Issue_Lite / Issue_Tracker / Data_Collab 五页抽屉
 *      顶部 action-bar 均挂 u-action-bar-sticky
 *   3. Sys_Iteration 页内 top:-18px 条件覆盖（si-drawer-body padding-top=18px 差值对齐）
 *   4. 缓存串：6 个引用页 components.css?v= 已 bump 到 v1.123.0_unify12
 *   5. Data_Collab footer 清除：无 u-drawer-footer DOM/CSS 规则/detailFooterLeft 功能引用；
 *      renderDetail 组装 actionBarHtml 在 taskInfoHtml 之前；decideFooterButtons 仍被调用
 *   6. 各页内联 script 语法有效（new Function 编译不执行）
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

const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const css = pub('assets/css/components.css');
const pages = {
    'Data_Correction.html': pub('Data_Correction.html'),
    'Sys_Iteration.html': pub('Sys_Iteration.html'),
    'Issue_Lite.html': pub('Issue_Lite.html'),
    'Issue_Tracker.html': pub('Issue_Tracker.html'),
    'Data_Collab.html': pub('Data_Collab.html'),
    'Statistics.html': pub('Statistics.html'),
};

console.log('— 1. 共享层定义 —');
check('components.css：.u-action-bar-sticky 定义齐全（top:0 零位移 + ::before 遮布）', () => {
    const m = css.match(/\.u-action-bar-sticky\s*\{([^}]+)\}/);
    assert.ok(m, '缺 .u-action-bar-sticky 规则');
    const body = m[1];
    assert.ok(body.includes('position: sticky'), '缺 position:sticky');
    assert.ok(body.includes('top: 0'), '缺 top:0（初始即吸附阈值·滚动零位移，用户实测修正）');
    assert.ok(body.includes('z-index'), '缺 z-index');
    assert.ok(body.includes('background'), '缺 background（吸顶遮内容）');
    const before = css.match(/\.u-action-bar-sticky::before\s*\{([^}]+)\}/);
    assert.ok(before, '缺 ::before 遮布规则');
    assert.ok(before[1].includes('top: -20px') && before[1].includes('height: 20px'), '::before 应遮 20px padding 缝');
    assert.ok(before[1].includes('left: -24px') && before[1].includes('right: -24px'), '::before 应左右扩到 padding 边缘');
});
check('components.css：.u-action-bar-sticky:empty 隐藏兜底（codex 117 L-1）', () => {
    assert.ok(/\.u-action-bar-sticky:empty\s*\{\s*display:\s*none;?\s*\}/.test(css), '缺 :empty 兜底');
});

console.log('— 2. 五页挂类 —');
check('Data_Correction：抽屉 action-bar 挂 sticky 类', () => {
    assert.ok(pages['Data_Correction.html'].includes('class="u-action-bar u-action-bar-sticky"'), '未挂类');
});
check('Sys_Iteration：siDActions 挂 sticky 类', () => {
    assert.ok(pages['Sys_Iteration.html'].includes('class="u-action-bar u-action-bar-sticky" id="siDActions"'), '未挂类');
});
check('Issue_Lite：抽屉 action-bar 挂 sticky 类', () => {
    assert.ok(pages['Issue_Lite.html'].includes('u-action-bar u-action-bar-sticky'), '未挂类');
});
check('Issue_Tracker：抽屉 action-bar 挂 sticky 类（用户拍板顺手挂）', () => {
    assert.ok(pages['Issue_Tracker.html'].includes('u-action-bar u-action-bar-sticky'), '未挂类');
});
check('Data_Collab：renderDetail 组装 u-action-bar u-action-bar-sticky', () => {
    assert.ok(pages['Data_Collab.html'].includes('class="u-action-bar u-action-bar-sticky"'), '未挂类');
});
check('区块内嵌 action-bar 未被误挂（系统迭代上线编排区保持原样）', () => {
    assert.ok(pages['Sys_Iteration.html'].includes('<div class="u-action-bar" style="margin-bottom:0">'), '上线编排区 action-bar 应保持无 sticky');
});

console.log('— 3. Sys_Iteration 遮布差值覆盖 —');
check('Sys_Iteration：si-drawer-body > .u-action-bar-sticky::before 尺寸覆盖存在（18px/22px）', () => {
    assert.ok(/\.unified-page \.si-drawer-body > \.u-action-bar-sticky::before \{ top: -18px; height: 18px; left: -22px; right: -22px; \}/.test(pages['Sys_Iteration.html']), '缺页内 ::before 尺寸覆盖');
});

console.log('— 4. 缓存串 —');
for (const [name, src] of Object.entries(pages)) {
    check(`${name}：components.css?v=v1.123.1_unify12b`, () => {
        assert.ok(src.includes('components.css?v=v1.123.1_unify12b'), '缓存串未 bump');
        assert.ok(!/components\.css\?v=v1\.1(10\.4_unify|23\.0_unify12)"/.test(src), '旧缓存串残留');
    });
}

console.log('— 5. Data_Collab footer 清除 —');
const collab = pages['Data_Collab.html'];
check('无 u-drawer-footer DOM/CSS 规则（仅注释历史提及允许）', () => {
    assert.ok(!collab.includes('<div class="u-drawer-footer"'), 'footer DOM 残留');
    assert.ok(!/\.u-drawer-footer\s*\{/.test(collab), 'footer CSS 规则残留');
});
check('无 detailFooterLeft 功能引用（getElementById/id= 均不得出现）', () => {
    assert.ok(!collab.includes("getElementById('detailFooterLeft')"), 'JS 引用残留');
    assert.ok(!collab.includes('id="detailFooterLeft"'), 'DOM id 残留');
});
check('renderDetail：actionBarHtml 组装在 taskInfoHtml 之前（按钮区置顶）', () => {
    const i1 = collab.indexOf('actionBarHtml\n                + taskInfoHtml');
    assert.ok(i1 >= 0, 'innerHTML 组装顺序不是 actionBarHtml 开头');
});
check('decideFooterButtons 矩阵 helper 仍被调用（按钮集逻辑未丢）', () => {
    assert.ok(collab.includes('decideFooterButtons(d, Number(getCurrentUserId()), isAdminUser)'), '调用点丢失');
    assert.ok(collab.includes('function decideFooterButtons('), '函数定义丢失');
});

console.log('— 6. 内联 script 语法 —');
for (const [name, src] of Object.entries(pages)) {
    check(`${name}：内联 <script> 可编译`, () => {
        const scripts = [...src.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
        assert.ok(scripts.length > 0, '未找到内联 script');
        for (const s of scripts) new Function(s);
    });
}

console.log(`\n=== verify-unify12-sticky: ${passed} passed / ${failed} failed ===`);
if (failed > 0) {
    failures.forEach(f => console.error(`FAIL: ${f.name} — ${f.err}`));
    process.exit(1);
}
