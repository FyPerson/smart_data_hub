/**
 * u-paste.js 共享层 · 纯函数面静态断言（不起浏览器/不起 server）
 *
 * 范围：只测试不依赖真实 DOM 布局引擎的纯逻辑面——MIME 映射、文件名合成（含序号/前缀参数化）、
 * 文本粘贴保护判定链（classifyClipboardItems/shouldIntercept/isEditableFocus）、register() 入参校验、
 * KIT_VERSION 与引用页缓存串是否同步。isVisible()/resolveCandidates()/真实 paste 事件驱动的浏览器行为
 * 由 test-sys-paste-playwright.js（33 组）与 test-quick-log-playwright.js（贴图直通用例）覆盖，不重复。
 *
 * 用法：node scripts/verify-u-paste.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const UPaste = require('../public/assets/js/u-paste.js');

let pass = 0, fail = 0;
function expect(cond, msg, detail) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}${detail !== undefined ? '  got=' + JSON.stringify(detail) : ''}`); fail++; }
}

console.log('=== u-paste.js 共享层纯函数面验证 ===\n');

// ---------- MIME → 扩展名映射 ----------
console.log('F1. extFromMime');
{
    expect(UPaste.extFromMime('image/jpeg') === 'jpg', 'image/jpeg → jpg');
    expect(UPaste.extFromMime('image/webp') === 'webp', 'image/webp → webp');
    expect(UPaste.extFromMime('image/gif') === 'gif', 'image/gif → gif');
    expect(UPaste.extFromMime('image/bmp') === 'bmp', 'image/bmp → bmp');
    expect(UPaste.extFromMime('image/png') === 'png', 'image/png → png');
    expect(UPaste.extFromMime('image/svg+xml') === 'png', '未知图片类型兜底 → png', UPaste.extFromMime('image/svg+xml'));
    expect(UPaste.extFromMime('') === 'png', '空字符串兜底 → png');
    expect(UPaste.extFromMime(undefined) === 'png', 'undefined 兜底 → png');
}

// ---------- 文件名合成 ----------
console.log('\nF2. buildFileName');
{
    UPaste.resetSeq('f2key');
    const n1 = UPaste.buildFileName('f2key', 'image/png');
    expect(/^粘贴截图_\d{8}_\d{6}_\d{3}_1\.png$/.test(n1), `默认前缀+序号=1 格式正确（实得="${n1}"）`, n1);
    const n2 = UPaste.buildFileName('f2key', 'image/jpeg');
    expect(/^粘贴截图_\d{8}_\d{6}_\d{3}_2\.jpg$/.test(n2), `同 key 第二次调用序号递增至 2 + 扩展名随 MIME（实得="${n2}"）`, n2);
    UPaste.resetSeq('f2key');
    const n3 = UPaste.buildFileName('f2key', 'image/png');
    expect(/_1\.png$/.test(n3), `resetSeq 后同 key 序号回到 1（实得="${n3}"）`, n3);
    const n4 = UPaste.buildFileName('otherkey', 'image/png');
    expect(/_1\.png$/.test(n4), `不同 key 序号互相独立（新 key 从 1 起，实得="${n4}"）`, n4);
    const n5 = UPaste.buildFileName('f2key-custom', 'image/png', '自定义前缀_');
    expect(n5.startsWith('自定义前缀_'), `前缀参数化：传入自定义前缀生效（实得="${n5}"）`, n5);
    const n6 = UPaste.buildFileName('f2key-custom2', 'image/png', '');
    expect(n6.startsWith('粘贴截图_'), `前缀参数化：空字符串前缀回落默认值（实得="${n6}"）`, n6);
}

// ---------- 文本粘贴保护判定链（对齐 test-sys-paste-playwright.js T1-T3/T7 的场景矩阵，纯逻辑版）----------
console.log('\nF3. classifyClipboardItems + shouldIntercept + isEditableFocus');
{
    const pureImage = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }]);
    expect(pureImage.hasImage === true && pureImage.hasText === false, '纯图片：hasImage=true, hasText=false', pureImage);
    expect(UPaste.shouldIntercept(pureImage, false) === true, 'T1 等价：纯图片(焦点不可编辑) → 拦截');
    expect(UPaste.shouldIntercept(pureImage, true) === true, '纯图片(焦点可编辑) → 仍拦截（无文本可放行）');

    const pureText = UPaste.classifyClipboardItems([{ kind: 'string', type: 'text/plain' }]);
    expect(pureText.hasImage === false, 'T3 等价：纯文本 hasImage=false');
    expect(UPaste.shouldIntercept(pureText, false) === false, 'T3 等价：纯文本 → 永不拦截');

    const mixedPlain = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }, { kind: 'string', type: 'text/plain' }]);
    expect(UPaste.shouldIntercept(mixedPlain, true) === false, 'T2 等价：图片+text/plain+可编辑焦点 → 放行(不拦截)');
    expect(UPaste.shouldIntercept(mixedPlain, false) === true, '图片+text/plain+焦点不可编辑 → 仍拦截');

    // codex 220 M-1 等价场景：仅 text/html（无 text/plain）也算"有文本"，不因 MIME 子类型漏判
    const mixedHtml = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }, { kind: 'string', type: 'text/html' }]);
    expect(UPaste.shouldIntercept(mixedHtml, true) === false, 'T7 等价：图片+仅text/html+可编辑焦点 → 放行(不拦截)');

    const neither = UPaste.classifyClipboardItems([]);
    expect(UPaste.shouldIntercept(neither, false) === false, '空剪贴板 → 不拦截');

    expect(UPaste.isEditableFocus({ tagName: 'INPUT' }) === true, 'isEditableFocus: INPUT → true');
    expect(UPaste.isEditableFocus({ tagName: 'TEXTAREA' }) === true, 'isEditableFocus: TEXTAREA → true');
    expect(UPaste.isEditableFocus({ tagName: 'DIV', isContentEditable: true }) === true, 'isEditableFocus: contentEditable DIV → true');
    expect(UPaste.isEditableFocus({ tagName: 'DIV', isContentEditable: false }) === false, 'isEditableFocus: 普通 DIV → false');
    expect(UPaste.isEditableFocus(null) === false, 'isEditableFocus: null → false');
}

// ---------- register() 入参校验 ----------
console.log('\nF4. register() 参数校验');
{
    let threw = false;
    try { UPaste.register({}); } catch (e) { threw = true; }
    expect(threw === true, '缺 selector/collect → 抛异常');
    let unregister = null;
    try { unregister = UPaste.register({ selector: '[id^="testPreview_"]', collect: () => {} }); } catch (e) { /* ignore */ }
    expect(typeof unregister === 'function', 'register() 成功时返回 unregister 函数');
    if (unregister) unregister();   // 清理，不污染后续（本脚本无浏览器场景会用到候选池，纯防御）
}

// ---------- register() 入参可选字段类型校验（codex S3 复审 L1 采纳）----------
console.log('\nF4b. register() 可选入参类型校验负例（每个字段一条）');
{
    const base = () => ({ selector: '[id^="testPreview2_"]', collect: () => {} });
    function expectThrows(extra, field, label) {
        let threw = false, msg = '';
        try { UPaste.register(Object.assign(base(), extra)); } catch (e) { threw = true; msg = e.message; }
        expect(threw === true && msg.indexOf(field) >= 0, `${label} → 抛异常且异常信息含字段名 "${field}"`, msg || '(未抛异常)');
    }
    expectThrows({ scopeResolver: 'not-a-function' }, 'scopeResolver', 'scopeResolver 传字符串');
    expectThrows({ keyOf: 123 }, 'keyOf', 'keyOf 传数字');
    expectThrows({ isImageArea: {} }, 'isImageArea', 'isImageArea 传对象');
    expectThrows({ namePrefix: 456 }, 'namePrefix', 'namePrefix 传数字');
    // 合法可选值（function/string 或干脆不传）不应抛
    let okThrew = false, okUnregister = null;
    try {
        okUnregister = UPaste.register(Object.assign(base(), {
            scopeResolver: () => null, keyOf: (el) => el.id, isImageArea: () => true, namePrefix: '前缀_',
        }));
    } catch (e) { okThrew = true; }
    expect(okThrew === false, '四个可选字段全传合法类型 → 不抛异常');
    if (okUnregister) okUnregister();
}

// ---------- M2：零注册状态可达性（真实 paste 事件的 preventDefault 行为需要 DOM ClipboardEvent，
//   留给 test-sys-paste-playwright.js / test-quick-log-playwright.js 的浏览器环境覆盖——两套里
//   Sys_Iteration 在 DOMContentLoaded 就完成 register()，注册后的行为不受本次改动影响，已跑绿即
//   为回归证据。本脚本只证明"没调用过 register() 时确实是 0 注册"这个前置状态本身成立）----------
console.log('\nF4c. M2 零注册前置状态（纯状态断言，不可测的 DOM 行为面见上方说明）');
{
    // 注：本脚本运行到这里之前 F4/F4b 已经 register()+unregister() 过若干次，可能有清理不到位的残留——
    // 用一个全新的场景验证"unregister 后确实归零"，作为"0 注册"状态可达的证据（而非要求进程全程为 0）。
    const cleanUnregister = UPaste.register({ selector: '[id^="testPreview3_"]', collect: () => {} });
    cleanUnregister();
    expect(UPaste._registrationCount() === 0, 'unregister 后 _registrationCount()=0（0 注册态可达，paste 处理器 M2 分支的前置条件成立）', UPaste._registrationCount());
}

// ---------- KIT_VERSION 与引用页缓存串同步核查（codex S3 复审 L3 采纳：改为扫描 public 下所有引用
//   u-paste.js 的 HTML，S4/S5 接入新页自动纳入覆盖，不必维护一份页面清单）----------
console.log('\nF5. KIT_VERSION 与所有引用页缓存串/版本比对常量同步（扫描 public/*.html）');
{
    const publicDir = path.join(__dirname, '..', 'public');
    const htmlFiles = fs.readdirSync(publicDir).filter(f => f.toLowerCase().endsWith('.html'));
    const referencing = [];
    for (const f of htmlFiles) {
        const full = path.join(publicDir, f);
        const html = fs.readFileSync(full, 'utf8');
        if (/u-paste\.js\?v=/.test(html)) referencing.push({ file: f, html });
    }
    expect(referencing.length >= 1, `至少 1 个页面引用 u-paste.js（实得=${referencing.length}：${referencing.map(r => r.file).join(',')}）`, referencing.length);
    for (const { file, html } of referencing) {
        const srcMatch = /u-paste\.js\?v=v[\d.]+_([a-zA-Z0-9]+)"/.exec(html);
        expect(!!srcMatch, `${file}：含 u-paste.js?v=..._<tag> 引用`, srcMatch);
        if (srcMatch) {
            expect(srcMatch[1] === UPaste.KIT_VERSION, `${file}：<script src> 缓存串尾部 tag 与 KIT_VERSION 一致（实得="${srcMatch[1]}"，期望="${UPaste.KIT_VERSION}"）`, srcMatch[1]);
        }
        // 页面比对常量命名约定：以 _UPASTE_KIT_EXPECTED 结尾（Sys_Iteration 用 SI_UPASTE_KIT_EXPECTED，
        // 未来页面各自前缀不同但须遵循同一后缀，本断言不依赖具体页面前缀，S4/S5 接入新页零维护成本）。
        const expectMatch = /[A-Z0-9_]*_UPASTE_KIT_EXPECTED\s*=\s*'([^']+)'/.exec(html);
        expect(!!expectMatch, `${file}：含 *_UPASTE_KIT_EXPECTED 版本比对常量`, expectMatch);
        if (expectMatch) {
            expect(expectMatch[1] === UPaste.KIT_VERSION, `${file}：*_UPASTE_KIT_EXPECTED 与 KIT_VERSION 一致（实得="${expectMatch[1]}"）`, expectMatch[1]);
        }
    }
}

// ---------- M1：scopeResolver 契约——mock resolver 返回显式空作用域对象时不回落 document ----------
console.log('\nF6. M1 scopeResolver 契约：显式空作用域 ≠ 回落 document');
{
    // 构造一个 fake document：根节点 querySelectorAll 若被调用会返回"命中"（证明发生了回落），
    // 用它验证"resolver 返回带 querySelectorAll 的空作用域对象"时，_resolveCandidates 不会去调用
    // fake document 自己的 querySelectorAll（即没有回落），候选数应为 0（因为空作用域本身就返回 []）。
    let fakeDocQueried = false;
    const emptyScope = { querySelectorAll: () => [] };
    const fakeDoc = {
        activeElement: null,
        querySelectorAll: () => { fakeDocQueried = true; return [{ id: 'siPreview_shouldNotBeFound', getClientRects: () => [1] }]; },
    };
    const unregister = UPaste.register({
        selector: '[id^="siPreview_"]',
        scopeResolver: () => emptyScope,   // 显式空作用域哨兵（M1 契约：不应回落 document）
        collect: () => {},
    });
    const candidates = UPaste._resolveCandidates(fakeDoc);
    unregister();
    expect(fakeDocQueried === false, 'resolver 返回显式空作用域对象时，未调用 fakeDoc.querySelectorAll（未回落 document）', fakeDocQueried);
    expect(candidates.length === 0, 'resolver 返回显式空作用域对象 → 候选数=0（不因回落 document 命中 fakeDoc 里的伪造候选）', candidates.length);

    // 对照组：resolver 返回 null 时应该回落 document（fakeDoc），这里用一个真正可见的候选验证回落确实发生
    fakeDocQueried = false;
    const unregister2 = UPaste.register({
        selector: '[id^="siPreview_"]',
        scopeResolver: () => null,   // null：回落 document（语义不变）
        collect: () => {},
    });
    const candidates2 = UPaste._resolveCandidates(fakeDoc);
    unregister2();
    expect(fakeDocQueried === true, '对照组：resolver 返回 null 时确实回落到 document（fakeDoc.querySelectorAll 被调用）', fakeDocQueried);
    expect(candidates2.length === 1, '对照组：回落 document 后命中 fakeDoc 里的候选（候选数=1）', candidates2.length);
}

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
if (fail > 0) { console.log('❌ u-paste.js 静态断言存在失败项'); process.exit(1); }
console.log('🎉 u-paste.js 静态断言全部通过');
