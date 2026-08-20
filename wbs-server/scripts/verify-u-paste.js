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

    // S2·第三缺陷修复语义反转（拍板出处 memory paste_defect_leads.md 2026-08-20 用户决策之二·双通道
    //   投递）：原断言标题"放行(不拦截)"描述的是旧版行为口径——shouldIntercept=false 在旧实现下等价于
    //   "图片被浏览器原生粘贴直接吞掉，无任何投递尝试"（第三缺陷"图文混合静默丢图"）。S2 起 shouldIntercept
    //   的布尔返回值本身不变（仍是 false——不拦截事件本身），但其含义已反转：真相源是 deliveryMode，
    //   该场景下必须是 'dual'——图片会在同一事件期内同步投递到目标区，不再是"丢图换文本"的旧取舍。
    const mixedPlain = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }, { kind: 'string', type: 'text/plain' }]);
    expect(UPaste.shouldIntercept(mixedPlain, true) === false, 'T2 等价：图片+text/plain+可编辑焦点 → shouldIntercept=false（不拦截事件本身，文本照常进输入框）');
    expect(UPaste.deliveryMode(mixedPlain, true) === 'dual',
        'T2 等价·S2 语义反转：图片+text/plain+可编辑焦点 → deliveryMode=\'dual\'（双通道：文本进框+图片同步投递；若实现退化回旧版"不拦截=不投递"，这条会红）');
    expect(UPaste.shouldIntercept(mixedPlain, false) === true, '图片+text/plain+焦点不可编辑 → 仍拦截');
    expect(UPaste.deliveryMode(mixedPlain, false) === 'intercept',
        '图片+text/plain+焦点不可编辑 → deliveryMode=\'intercept\'（焦点不可编辑不满足 dual 前提，走既有拦截+归属链，零变化；若实现误判成 dual，这条会红）');

    // codex 220 M-1 等价场景：仅 text/html（无 text/plain）也算"有文本"，不因 MIME 子类型漏判——
    //   S2 同步核语义：本场景同 T2，deliveryMode 也应为 'dual'，不因文本 MIME 子类型不同而分叉判定。
    const mixedHtml = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }, { kind: 'string', type: 'text/html' }]);
    expect(UPaste.shouldIntercept(mixedHtml, true) === false, 'T7 等价：图片+仅text/html+可编辑焦点 → shouldIntercept=false（不拦截事件本身）');
    expect(UPaste.deliveryMode(mixedHtml, true) === 'dual',
        'T7 等价·S2 语义反转：图片+仅text/html+可编辑焦点 → deliveryMode=\'dual\'（若实现漏判 text/html 也算"有文本"、误落回 intercept，这条会红）');

    const neither = UPaste.classifyClipboardItems([]);
    expect(UPaste.shouldIntercept(neither, false) === false, '空剪贴板 → 不拦截');

    expect(UPaste.isEditableFocus({ tagName: 'INPUT' }) === true, 'isEditableFocus: INPUT → true');
    expect(UPaste.isEditableFocus({ tagName: 'TEXTAREA' }) === true, 'isEditableFocus: TEXTAREA → true');
    expect(UPaste.isEditableFocus({ tagName: 'DIV', isContentEditable: true }) === true, 'isEditableFocus: contentEditable DIV → true');
    expect(UPaste.isEditableFocus({ tagName: 'DIV', isContentEditable: false }) === false, 'isEditableFocus: 普通 DIV → false');
    expect(UPaste.isEditableFocus(null) === false, 'isEditableFocus: null → false');
}

// ---------- F3c：deliveryMode 完整三分支矩阵（S2 第三缺陷"图文混合静默丢图"修复，拍板出处
//   memory paste_defect_leads.md 2026-08-20 用户决策之二·双通道投递）----------
console.log('\nF3c. deliveryMode 完整矩阵（S2 双通道投递：none/dual/intercept 正反例）');
{
    const noImage = UPaste.classifyClipboardItems([{ kind: 'string', type: 'text/plain' }]);
    const emptyClip = UPaste.classifyClipboardItems([]);
    const pureImg = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }]);
    const imgPlusText = UPaste.classifyClipboardItems([{ kind: 'file', type: 'image/png' }, { kind: 'string', type: 'text/plain' }]);

    // ① 无图片 → 'none'，无论 editableFocus 是什么、无论文本存不存在——若实现让 hasText 干扰这一档，会红。
    expect(UPaste.deliveryMode(noImage, true) === 'none', 'deliveryMode①：纯文本(有文本无图) + 可编辑焦点 → \'none\'');
    expect(UPaste.deliveryMode(noImage, false) === 'none', 'deliveryMode①：纯文本 + 焦点不可编辑 → \'none\'');
    expect(UPaste.deliveryMode(emptyClip, true) === 'none', 'deliveryMode①：空剪贴板 → \'none\'（若实现对空输入抛异常或误判非 none，这条会红）');

    // ② 纯图片（无文本）→ 恒 'intercept'，无论焦点是否可编辑——没有文本可放行，dual 的前提"hasText"不成立。
    expect(UPaste.deliveryMode(pureImg, true) === 'intercept', 'deliveryMode②：纯图片(无文本) + 可编辑焦点 → \'intercept\'（若实现误判 hasText 缺失也能进 dual，这条会红）');
    expect(UPaste.deliveryMode(pureImg, false) === 'intercept', 'deliveryMode②：纯图片(无文本) + 焦点不可编辑 → \'intercept\'');

    // ③ 图+文，核心分叉点：唯有"图+文+可编辑焦点"三条件同时成立才是 'dual'，其余（图+文+不可编辑焦点）
    //   仍是 'intercept'——若实现把 editableFocus 判断漏掉（恒进 dual）或颠倒（恒不进 dual），下面两条
    //   分别会红。
    expect(UPaste.deliveryMode(imgPlusText, true) === 'dual', 'deliveryMode③：图+文 + 可编辑焦点 → \'dual\'（S2 核心修复目标场景）');
    expect(UPaste.deliveryMode(imgPlusText, false) === 'intercept', 'deliveryMode③：图+文 + 焦点不可编辑 → \'intercept\'（不满足 dual 前提，走既有拦截链，非本次改造范围）');

    // ④ 防御性输入：classified 为 null/undefined 时不应抛异常，应按"无图片"处理 → 'none'。
    expect(UPaste.deliveryMode(null, true) === 'none', 'deliveryMode④：classified=null → \'none\'（防御性兜底，不抛异常）');
    expect(UPaste.deliveryMode(undefined, false) === 'none', 'deliveryMode④：classified=undefined → \'none\'');

    // ⑤ shouldIntercept 与 deliveryMode 的一致性契约：shouldIntercept 已改由 deliveryMode 派生，
    //   两者对同一输入不应出现矛盾结论（=== 'intercept' 与 shouldIntercept() 的布尔值必须同步）——
    //   若未来有人各自维护两条判定逻辑导致语义分叉，这组断言会抓到。
    [
        [noImage, true], [noImage, false], [pureImg, true], [pureImg, false],
        [imgPlusText, true], [imgPlusText, false],
    ].forEach(([classified, focus], idx) => {
        const mode = UPaste.deliveryMode(classified, focus);
        const intercepted = UPaste.shouldIntercept(classified, focus);
        expect(intercepted === (mode === 'intercept'),
            `deliveryMode⑤-${idx}：shouldIntercept() 与 deliveryMode()==='intercept' 结论一致（mode="${mode}"，intercepted=${intercepted}）`);
    });
}

// ---------- S1c·L3 预筛修复：MSG_NO_CANDIDATE / MSG_MULTI_NO_MEMORY 非空且有实质长度——六套
//   Playwright 断言全靠 `toast.includes(UPaste.MSG_*)` 同源引用，若常量意外被改成 ''（includes('')
//   对任意字符串恒 true），六套的 toast 断言会集体假绿，测的其实是"toast 元素存在"而非"文案对不对"。
//   这条堵住这个恒真风险的源头。----------
console.log('\nF3b. 拒绝文案常量非空且有实质长度（防 includes(\'\') 恒真风险）');
{
    expect(typeof UPaste.MSG_NO_CANDIDATE === 'string' && UPaste.MSG_NO_CANDIDATE.length >= 6,
        `MSG_NO_CANDIDATE 非空字符串且 length>=6（实得 length=${UPaste.MSG_NO_CANDIDATE.length}）`, UPaste.MSG_NO_CANDIDATE);
    expect(typeof UPaste.MSG_MULTI_NO_MEMORY === 'string' && UPaste.MSG_MULTI_NO_MEMORY.length >= 6,
        `MSG_MULTI_NO_MEMORY 非空字符串且 length>=6（实得 length=${UPaste.MSG_MULTI_NO_MEMORY.length}）`, UPaste.MSG_MULTI_NO_MEMORY);
    // S2b·R1 新增常量同步纳入本组非空检查。
    expect(typeof UPaste.MSG_DUAL_NOT_DELIVERED === 'string' && UPaste.MSG_DUAL_NOT_DELIVERED.length >= 6,
        `MSG_DUAL_NOT_DELIVERED 非空字符串且 length>=6（实得 length=${UPaste.MSG_DUAL_NOT_DELIVERED.length}）`, UPaste.MSG_DUAL_NOT_DELIVERED);
    expect(typeof UPaste.dualDeliveredMsg === 'function' && UPaste.dualDeliveredMsg(1).length >= 6,
        `dualDeliveredMsg 是函数且 dualDeliveredMsg(1) 非空有实质长度（实得="${UPaste.dualDeliveredMsg(1)}"）`, UPaste.dualDeliveredMsg(1));
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
    // S1c·L1 预筛修复：clickScopeOf 此前漏了负例一条（R1 新增字段，"每个字段一条"的声称当时不成立）。
    expectThrows({ clickScopeOf: 'not-a-function' }, 'clickScopeOf', 'clickScopeOf 传字符串');
    // 合法可选值（function/string 或干脆不传）不应抛——五个可选字段全传合法类型（含 clickScopeOf）。
    let okThrew = false, okUnregister = null;
    try {
        okUnregister = UPaste.register(Object.assign(base(), {
            scopeResolver: () => null, keyOf: (el) => el.id, isImageArea: () => true, namePrefix: '前缀_',
            clickScopeOf: (el) => el.parentElement,
        }));
    } catch (e) { okThrew = true; }
    expect(okThrew === false, '五个可选字段全传合法类型（含 clickScopeOf） → 不抛异常');
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

// ---------- F7：chooseCandidate（S6·A1 点击记忆归属，纯函数矩阵正反例）----------
console.log('\nF7. chooseCandidate（A1 点击记忆归属）');
{
    const c1 = { reg: {}, el: {}, key: 'k1' };
    const c2 = { reg: {}, el: {}, key: 'k2' };

    // 单候选：恒选中，无视 lastKey——若实现让 lastKey 干扰单候选路径（比如误判"lastKey 非空但不匹配
    // 就返回 null"），下面两条中至少一条会红：
    expect(UPaste.chooseCandidate([c1], null) === c1, '单候选 + lastKey=null → 选中该唯一候选');
    expect(UPaste.chooseCandidate([c1], 'k2') === c1,
        '单候选 + lastKey 指向别的 key(k2) → 仍选中该唯一候选（单候选零变化的反例证明：若实现让不匹配的' +
        ' lastKey 拒绝单候选，这条会红）');

    // 双候选 + lastKey 命中：若实现漏了匹配分支或匹配错元素，这条会红。
    expect(UPaste.chooseCandidate([c1, c2], 'k2') === c2, '双候选 + lastKey 匹配第二个(k2) → 选中第二个');
    expect(UPaste.chooseCandidate([c1, c2], 'k1') === c1, '双候选 + lastKey 匹配第一个(k1) → 选中第一个');

    // 双候选 + 无记忆：若实现在 lastKey 为空时误兜底选第一个（而非拒绝），这条会红。
    expect(UPaste.chooseCandidate([c1, c2], null) === null, '双候选 + lastKey=null → null（无记忆，不猜）');

    // 双候选 + lastKey 不在候选中：若实现只判"非空即选中"而不做成员校验，这条会红。
    expect(UPaste.chooseCandidate([c1, c2], 'k999') === null, '双候选 + lastKey 不在候选中(k999) → null');

    // 空候选：无论 lastKey 是什么，恒 null——若实现在 lastKey 非空时对空数组做了越界访问返回非 null，这条会红。
    expect(UPaste.chooseCandidate([], null) === null, '空候选 + lastKey=null → null');
    expect(UPaste.chooseCandidate([], 'k1') === null, '空候选 + lastKey 非空(k1) → null（不会凭空造出候选）');

    // S1b·R5 预筛修复：重复 key 契约——candidates 内出现重复 key 时取数组顺序第一个同 key 项，不去重/
    //   不报错。若实现改成匹配最后一个或抛异常，这条会红。
    const c1dup = { reg: {}, el: {}, key: 'k1', tag: 'first' };
    const c1dup2 = { reg: {}, el: {}, key: 'k1', tag: 'second' };
    expect(UPaste.chooseCandidate([c1dup, c1dup2, c2], 'k1') === c1dup,
        '重复 key(k1) 候选池 + lastKey=k1 → 取数组顺序第一个同 key 项（不是第二个/最后一个）');
}

// ---------- F8/F9/F10：R1 点击命中面扩展 + S1c·M1 candidateHost 三级回落 + R3 接线可断言 +
//   R4 resetSeq 生命周期收紧（candidateHost/resolveCandidatesRaw 未单独导出，走公开 API 组合验证；
//   全部共用同一个 click handler——_attachClickListener 有模块级防重复挂载标志，进程内只有第一次
//   真实调用会成功挂载，之后的调用静默 no-op，所以只在这里挂载一次，后续断言全部复用这同一个 handler）----------
console.log('\nF8/F9/F10. R1 点击命中面扩展 + M1 candidateHost 三级回落 + R3 接线可断言 + R4 resetSeq 生命周期收紧');
{
    // 构造最小可用的伪元素/伪宿主/伪 doc/伪 win——不依赖真实浏览器 DOM，只实现本次断言需要的接口面：
    //   伪宿主：{ contains(target) } —— 用于 candidateHost 命中判定（经 clickScopeOf 显式注入，
    //   不依赖 parentElement 真实存在，对齐 R1"点击命中面从候选元素扩到宿主"的契约本身）；
    //   伪元素：{ id }（不需要 getClientRects，click 路径已改走 resolveCandidatesRaw 不判可见性）；
    //   伪 doc：{ querySelectorAll(sel), addEventListener(type, handler) }（捕获 handler 供本脚本直调）。
    function makeHost(matchSet) { return { contains: (t) => matchSet.indexOf(t) >= 0 }; }

    const targetA = { name: 'targetA' };         // F8：独立宿主 hostA 唯一命中
    const targetB = { name: 'targetB' };         // F8：独立宿主 hostB 唯一命中
    const targetAmbiguous = { name: 'targetAmbiguous' };   // F8：共宿主，两候选同时命中
    const targetOutside = { name: 'targetOutside' };       // F8：不命中任何宿主
    const targetOa = { name: 'targetOa' };        // F9：paste 消费链路专用
    const targetX = { name: 'targetX' };          // F10：resetSeq 生命周期专用

    const hostA = makeHost([targetA]);
    const hostB = makeHost([targetB]);
    const sharedHost = makeHost([targetAmbiguous]);   // 两个候选共享同一宿主（模拟"共宿主"歧义场景）
    const hostOa = makeHost([targetOa]);
    const hostX = makeHost([targetX]);

    const elA = { id: 'f8-a' };
    const elB = { id: 'f8-b' };
    const elShared1 = { id: 'f8-s1' };
    const elShared2 = { id: 'f8-s2' };
    const elOa = { id: 'f9-oa' };
    const elX = { id: 'f10-x' };

    // S1c·M1 预筛修复新增：candidateHost 三级回落的第二级（clickScopeOf 未命中时应落 el.parentElement）
    // 此前零覆盖——用带真实 parentElement 引用的伪元素构造。
    const targetM1a = { name: 'targetM1a' };   // M1①：clickScopeOf 显式返回 null
    const targetM1b = { name: 'targetM1b' };   // M1②：不传 clickScopeOf（六页现用真实路径）
    const hostM1a = makeHost([targetM1a]);
    const hostM1b = makeHost([targetM1b]);
    const elM1a = { id: 'm1-a', parentElement: hostM1a };
    const elM1b = { id: 'm1-b', parentElement: hostM1b };

    // 独立宿主分组（elA/elB），各自 clickScopeOf 返回专属宿主，互不重叠。
    const distinctScope = { querySelectorAll: () => [elA, elB] };
    const unregDistinct = UPaste.register({
        selector: '[data-f8-distinct]', scopeResolver: () => distinctScope, keyOf: (el) => el.id,
        clickScopeOf: (el) => (el === elA ? hostA : el === elB ? hostB : null), collect: () => {},
    });
    // 共宿主分组（elShared1/elShared2），clickScopeOf 无视传入 el、恒返回同一个 sharedHost。
    const sharedScope = { querySelectorAll: () => [elShared1, elShared2] };
    const unregShared = UPaste.register({
        selector: '[data-f8-shared]', scopeResolver: () => sharedScope, keyOf: (el) => el.id,
        clickScopeOf: () => sharedHost, collect: () => {},
    });
    // M1①：clickScopeOf 存在但显式返回 null——必须回落 el.parentElement（M1 修复目标场景：旧实现的
    //   三元短路会让这种情况直接落到候选元素自身，因候选元素无 contains 方法而永远命中不了）。
    const m1aScope = { querySelectorAll: () => [elM1a] };
    const unregM1a = UPaste.register({
        selector: '[data-m1-a]', scopeResolver: () => m1aScope, keyOf: (el) => el.id,
        clickScopeOf: () => null, collect: () => {},
    });
    // M1②：完全不传 clickScopeOf 字段——六页现用真实路径（六页 register() 均未传本字段），验证缺省
    //   回落 el.parentElement 确实生效。
    const m1bScope = { querySelectorAll: () => [elM1b] };
    const unregM1b = UPaste.register({
        selector: '[data-m1-b]', scopeResolver: () => m1bScope, keyOf: (el) => el.id,
        collect: () => {},
    });
    // F9 专用候选（paste 消费链路）。
    const oaScope = { querySelectorAll: () => [elOa] };
    const unregOa = UPaste.register({
        selector: '[data-f9-oa]', scopeResolver: () => oaScope, keyOf: (el) => el.id,
        clickScopeOf: () => hostOa, collect: () => {},
    });
    // F10 专用候选（resetSeq 生命周期）。
    const xScope = { querySelectorAll: () => [elX] };
    const unregX = UPaste.register({
        selector: '[data-f10-x]', scopeResolver: () => xScope, keyOf: (el) => el.id,
        clickScopeOf: () => hostX, collect: () => {},
    });

    let capturedClickHandler = null;
    const fakeDoc = {
        activeElement: null,
        addEventListener: (type, handler) => { if (type === 'click') capturedClickHandler = handler; },
        // 本 doc 自身不直接被 querySelectorAll（四条注册都走各自 scopeResolver 返回专属 scope），
        // 留空实现仅为满足"若有遗漏注册回落 document"时不炸——不应被调用到。
        querySelectorAll: () => [],
    };
    UPaste._attachClickListener({}, fakeDoc);
    expect(typeof capturedClickHandler === 'function', '_attachClickListener(fakeWin, fakeDoc) 成功挂载并可捕获 handler', typeof capturedClickHandler);

    if (capturedClickHandler) {
        // ===== F8：R1 点击命中面扩展 + 歧义守卫 =====
        capturedClickHandler({ target: targetA });
        expect(UPaste._getLastClickedKey() === 'f8-a', 'F8：点击命中唯一宿主(hostA) → lastClickedKey 写入 f8-a', UPaste._getLastClickedKey());

        capturedClickHandler({ target: targetB });
        expect(UPaste._getLastClickedKey() === 'f8-b', 'F8：再点击唯一宿主(hostB) → lastClickedKey 覆盖为 f8-b（最后一次点击语义）', UPaste._getLastClickedKey());

        capturedClickHandler({ target: targetOutside });
        expect(UPaste._getLastClickedKey() === 'f8-b', 'F8：点击落在候选宿主之外 → lastClickedKey 不清空，仍为 f8-b', UPaste._getLastClickedKey());

        // 命中数=2（elShared1/elShared2 共宿主，同一次点击两个候选的 hostEl.contains 都为 true）→
        //   歧义守卫生效，不写，仍**保留旧值**（f8-b，S2c·R3 语义明确化：歧义点击不产生新归属信息，
        //   但更早的有效点击仍然算数，不因这次歧义而清空）——若实现漏了歧义守卫、误写成其中一个 key，
        //   或误改成"歧义即清空"（清成 null），这条都会红。
        capturedClickHandler({ target: targetAmbiguous });
        expect(UPaste._getLastClickedKey() === 'f8-b', 'F8：命中数=2（共宿主歧义）→ 不写记忆，保留旧值 f8-b（歧义守卫生效，语义=保留非清空）', UPaste._getLastClickedKey());

        // ===== M1：candidateHost 三级回落——clickScopeOf 未命中时应落 el.parentElement =====
        capturedClickHandler({ target: targetM1a });
        expect(UPaste._getLastClickedKey() === 'm1-a',
            'M1①：clickScopeOf 显式返回 null → 回落 el.parentElement 命中（若实现退化为只认候选元素自身——旧三元短路的坏法——这条会红）',
            UPaste._getLastClickedKey());

        capturedClickHandler({ target: targetM1b });
        expect(UPaste._getLastClickedKey() === 'm1-b',
            'M1②：不传 clickScopeOf（六页现用真实路径，Node 层此前零覆盖）→ 回落 el.parentElement 命中',
            UPaste._getLastClickedKey());

        // ===== F9：R3 接线可断言——点击写入的记忆真正流向 paste 分支消费的 chooseCandidate 链路 =====
        capturedClickHandler({ target: targetOa });
        expect(UPaste._getLastClickedKey() === 'f9-oa', 'F9：点击 hostOa 后 _getLastClickedKey() = f9-oa', UPaste._getLastClickedKey());
        const candidatesOaErr = [{ reg: {}, el: elOa, key: 'f9-oa' }, { reg: {}, el: {}, key: 'f9-other' }];
        expect(UPaste.chooseCandidate(candidatesOaErr, UPaste._getLastClickedKey()) === candidatesOaErr[0],
            'F9：paste 分支消费链路——chooseCandidate(候选池, _getLastClickedKey()) 归属到点击记住的候选（f9-oa）');

        // ===== F10：R4 resetSeq 收紧点击记忆生命周期（先写入 f10-x，再验证清除语义）=====
        capturedClickHandler({ target: targetX });
        expect(UPaste._getLastClickedKey() === 'f10-x', 'F10：点击写入 f10-x（为 resetSeq 断言做前置）', UPaste._getLastClickedKey());

        UPaste.resetSeq('f10-x__not_the_same_key__');
        expect(UPaste._getLastClickedKey() === 'f10-x', 'F10：resetSeq(异 key) 不影响当前点击记忆，仍为 f10-x', UPaste._getLastClickedKey());

        UPaste.resetSeq('f10-x');
        expect(UPaste._getLastClickedKey() === null, 'F10：resetSeq(同 key) 清空点击记忆为 null', UPaste._getLastClickedKey());
    }

    unregDistinct();
    unregShared();
    unregM1a();
    unregM1b();
    unregOa();
    unregX();
}

// ---------- F11：S2b·R3 决策核心点断言网——dual/intercept 反馈分叉双向断言组（fakeDoc 谐振腔模式，
//   同 F8 的 click 版：_attachDocumentListener 有模块级防重复挂载标志，进程内只有第一次真实调用会
//   成功挂载——本脚本此前从未调用过 _attachDocumentListener，这里是首次也是唯一一次）----------
console.log('\nF11. S2b·R3 dual/intercept 反馈分叉决策核心点断言网');
{
    // 伪剪贴板 item：kind/type/getAsFile 三字段（getAsFile 返回的对象只需 .type 可读，供
    // buildFileName/File 构造消费，不需要真实二进制内容）。
    function makeImageItem(type) {
        return { kind: 'file', type: type || 'image/png', getAsFile: () => ({ type: type || 'image/png' }) };
    }
    function makeTextItem() { return { kind: 'string', type: 'text/plain' }; }
    // 伪 activeElement：isEditableFocus 只读 tagName/isContentEditable 两个字段——TEXTAREA 天然可编辑，
    // DIV（isContentEditable 未显式 true）不可编辑，二者切换即控制 dual vs intercept 分叉。
    const fakeTextarea = { tagName: 'TEXTAREA' };
    const fakeDiv = { tagName: 'DIV', isContentEditable: false };
    // 伪 paste 事件：只需 clipboardData.items + 一个不抛异常的 preventDefault（intercept 分支会真调用它）。
    function fakePasteEvent(items) { return { clipboardData: { items: items }, preventDefault: () => {} }; }

    // showToast spy：记录每次调用的 (message, type)，配 reset，供逐条断言"恰好调了几次、传了什么"。
    let toastCalls = [];
    function toastSpy(message, type) { toastCalls.push({ message: message, type: type }); }
    function resetToastSpy() { toastCalls = []; }

    const fakeWin = { showToast: toastSpy };
    let capturedPasteHandler = null;
    const fakeDoc = {
        activeElement: fakeDiv,
        addEventListener: (type, handler) => { if (type === 'paste') capturedPasteHandler = handler; },
        // 本 doc 自身不直接被 querySelectorAll（各注册都走各自 scopeResolver 返回专属 scope），
        // 留空实现仅为满足"若有遗漏注册回落 document"时不炸——不应被调用到。
        querySelectorAll: () => [],
    };
    UPaste._attachDocumentListener(fakeWin, fakeDoc);
    expect(typeof capturedPasteHandler === 'function', 'F11：_attachDocumentListener(fakeWin, fakeDoc) 成功挂载并可捕获 paste handler', typeof capturedPasteHandler);

    if (capturedPasteHandler) {
        // ===== ①②：0 候选场景（有注册但候选池为空，非"零注册 fail-safe"那个更早的分支）=====
        const emptyScope = { querySelectorAll: () => [] };
        const unregEmpty = UPaste.register({
            selector: '[data-f11-empty]', scopeResolver: () => emptyScope, keyOf: (el) => el.id, collect: () => {},
        });

        // ①：0 候选 + 图文混合 + activeElement=TEXTAREA（可编辑，dual）→ showToast 调用 0 次（静默不投）。
        //   坏成什么样会红：若 dual 路径的 0 候选分支误弹了任何提示（哪怕文案对但级别错），toastCalls.length
        //   不再是 0，这条会红。
        fakeDoc.activeElement = fakeTextarea;
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        expect(toastCalls.length === 0, 'F11①：0 候选+图文混合+dual(TEXTAREA 焦点) → showToast 调用 0 次（静默不投）', toastCalls);

        // ②：同场景，activeElement=DIV（不可编辑，intercept）→ showToast 恰好 1 次，MSG_NO_CANDIDATE/error。
        //   坏成什么样会红：若 intercept 路径的 0 候选分支被 R1 改造误连累成静默（比如 mode 参数传递
        //   写反），toastCalls.length 会变成 0 而不是 1，这条会红；若文案/级别退化用错常量或错级别，
        //   第二个条件会红。
        fakeDoc.activeElement = fakeDiv;
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.MSG_NO_CANDIDATE && toastCalls[0].type === 'error',
            'F11②：0 候选+图文混合+intercept(DIV 焦点) → showToast 恰好 1 次，文案=MSG_NO_CANDIDATE，级别=error', toastCalls);
        unregEmpty();

        // ===== ③④：≥2 候选无记忆场景 =====
        // 注：F11 的候选元素要经过真实 paste 路径的 resolveCandidates（非 F8/F9/F10 用的 click 路径
        // resolveCandidatesRaw），后者判可见性——伪元素须带 getClientRects() 返回非空数组才会被
        // isVisible() 判定可见，否则会被静默过滤出候选池（本组断言初版曾在此踩坑：忘加这个字段导致
        // ③④⑤⑥b 全部误判为 0 候选，见 F11 小节整体注释）。
        const elA = { id: 'f11-a', getClientRects: () => [1] }, elB = { id: 'f11-b', getClientRects: () => [1] };
        const multiScope = { querySelectorAll: () => [elA, elB] };
        const unregMulti = UPaste.register({
            selector: '[data-f11-multi]', scopeResolver: () => multiScope, keyOf: (el) => el.id, collect: () => {},
        });

        // ③：≥2 候选无记忆 + dual → info 级 MSG_DUAL_NOT_DELIVERED。
        //   坏成什么样会红：若实现在 dual 分支仍沿用 MSG_MULTI_NO_MEMORY/error（R1 改造前的旧行为，
        //   即预筛 M1/M2 指出的"红色+预设贴图意图"问题原样保留），这条会红。
        fakeDoc.activeElement = fakeTextarea;
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.MSG_DUAL_NOT_DELIVERED && toastCalls[0].type === 'info',
            'F11③：≥2 候选无记忆 + dual → showToast 恰好 1 次，文案=MSG_DUAL_NOT_DELIVERED，级别=info', toastCalls);

        // ④：同款候选池，intercept（纯图片，无文本——deliveryMode 恒 intercept，不受焦点影响）→
        //   MSG_MULTI_NO_MEMORY/error 不变。坏成什么样会红：若 R1 的 dual 反馈改造连累了 intercept
        //   路径（比如两条分支共用了 isDual 判断但条件写反），intercept 路径的文案/级别会被误改成
        //   dual 那套，这条会红——这是本组"回归防护"的核心断言，防止反馈分叉改造污染既有行为。
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem()]));
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.MSG_MULTI_NO_MEMORY && toastCalls[0].type === 'error',
            'F11④：≥2 候选无记忆 + intercept(纯图片) → showToast 恰好 1 次，文案=MSG_MULTI_NO_MEMORY，级别=error（回归防护）', toastCalls);
        unregMulti();

        // ===== ⑤：成功投递 + dual → info 成功文案 + collect 真被调 =====
        let collectCalls = [];
        const elReal = { id: 'f11-real', getClientRects: () => [1] };
        const realScope = { querySelectorAll: () => [elReal] };
        const unregReal = UPaste.register({
            selector: '[data-f11-real]', scopeResolver: () => realScope, keyOf: (el) => el.id,
            collect: (key, files) => { collectCalls.push({ key: key, files: files }); },
        });
        fakeDoc.activeElement = fakeTextarea;
        collectCalls = [];
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        // 坏成什么样会红：若 dual 路径的投递本身退化（R1 改造误伤了 S2 的核心投递逻辑），collectCalls
        // 仍会是 0——这条兼做"R1 没有破坏 S2 投递功能"的回归防护。
        expect(collectCalls.length === 1 && collectCalls[0].key === 'f11-real', 'F11⑤：单候选 + dual → collect 真被调用（key=f11-real）', collectCalls);
        // 坏成什么样会红：若实现漏加成功反馈（R1 新增的这半条），或数量算错（比如恒传 1 不管实际粘贴几张），
        // 这条会红。
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.dualDeliveredMsg(1) && toastCalls[0].type === 'info',
            'F11⑤：单候选 + dual 成功投递 → showToast 恰好 1 次，文案=dualDeliveredMsg(1)，级别=info', toastCalls);
        unregReal();

        // ===== ⑥：allowDual:false 区——dual 路径被剔除（单候选降级为 0 候选→静默不投）；
        //          intercept 路径不剔除（照常归属）=====
        let noDualCalls = [];
        const elNoDual = { id: 'f11-nodual', getClientRects: () => [1] };
        const noDualScope = { querySelectorAll: () => [elNoDual] };
        const unregNoDual = UPaste.register({
            selector: '[data-f11-nodual]', scopeResolver: () => noDualScope, keyOf: (el) => el.id,
            allowDual: false,
            collect: (key, files) => { noDualCalls.push({ key: key, files: files }); },
        });

        fakeDoc.activeElement = fakeTextarea;
        noDualCalls = [];
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        // 坏成什么样会红：若 R2 的 allowDual 过滤没接线（剔除逻辑没生效，或没在 chooseCandidate 之前做），
        // collect 会被调用（candidates 里仍有这个候选，单候选零记忆自动选中），这条会红。
        expect(noDualCalls.length === 0, 'F11⑥a：allowDual:false 候选在 dual 路径被剔除 → collect 不被调（单候选降级为 0 候选）', noDualCalls);
        expect(toastCalls.length === 0, 'F11⑥a：allowDual:false 候选剔除后 → 0 候选静默不投，showToast 调用 0 次', toastCalls);

        noDualCalls = [];
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem()]));
        // 坏成什么样会红：若 allowDual 过滤被误套用到 intercept 路径（R2 明确要求"intercept 路径不受
        // 影响"），collect 不会被调用，这条会红——这是防止 R2 过滤逻辑越界到 intercept 的回归防护。
        expect(noDualCalls.length === 1 && noDualCalls[0].key === 'f11-nodual',
            'F11⑥b：allowDual:false 候选在 intercept 路径不被剔除 → collect 正常被调（回归防护：过滤不越界）', noDualCalls);
        unregNoDual();

        // ===== ⑦：S2c·R1 collect 返回契约（accepted 数值 vs undefined 向后兼容）=====
        // ⑦a：collect 返回 0（模拟页面闸门已把本次贴图全部拒收，但未抛异常——页面自己已经 showToast
        //   过拒收原因）→ dual 路径不应再叠加"已粘贴成功"的谎报提示。
        const elAcceptZero = { id: 'f11-accept0', getClientRects: () => [1] };
        const acceptZeroScope = { querySelectorAll: () => [elAcceptZero] };
        const unregAcceptZero = UPaste.register({
            selector: '[data-f11-accept0]', scopeResolver: () => acceptZeroScope, keyOf: (el) => el.id,
            collect: () => 0,
        });
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeTextItem()]));
        // 坏成什么样会红：若实现仍按 named.length（这里是 1）报"已粘贴成功"而不看 accepted===0，这条会红
        // ——这正是预筛描述的"谎报成功"bug 本体。
        expect(toastCalls.length === 0, 'F11⑦a：collect 返回 0（页面闸门已拒收但未抛异常）→ dual 无成功 toast（静默，不叠加噪音）', toastCalls);
        unregAcceptZero();

        // ⑦b：collect 返回 2（本次贴 3 张图，模拟部分被拒收）→ 按实数"已粘贴 2 张"提示，不是
        //   named.length=3。
        const elAcceptTwo = { id: 'f11-accept2', getClientRects: () => [1] };
        const acceptTwoScope = { querySelectorAll: () => [elAcceptTwo] };
        const unregAcceptTwo = UPaste.register({
            selector: '[data-f11-accept2]', scopeResolver: () => acceptTwoScope, keyOf: (el) => el.id,
            collect: () => 2,
        });
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeImageItem(), makeImageItem(), makeTextItem()]));
        // 坏成什么样会红：若实现忽略 collect 的数值返回值、仍照抄 named.length=3 报"已粘贴 3 张"，这条会红。
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.dualDeliveredMsg(2) && toastCalls[0].type === 'info',
            'F11⑦b：collect 返回 2（3 张贴图场景，模拟部分拒收）→ 按实数提示"已粘贴 2 张"（非 named.length=3）', toastCalls);
        unregAcceptTwo();

        // ⑦c：collect 不返回（undefined，未按 S2c·R1 契约改造的页面）→ 向后兼容旧行为，按
        //   named.length 提示（2 张场景）。
        const elAcceptUndef = { id: 'f11-acceptundef', getClientRects: () => [1] };
        const acceptUndefScope = { querySelectorAll: () => [elAcceptUndef] };
        const unregAcceptUndef = UPaste.register({
            selector: '[data-f11-acceptundef]', scopeResolver: () => acceptUndefScope, keyOf: (el) => el.id,
            collect: () => {},   // 显式不返回，等价"未改造页面"
        });
        resetToastSpy();
        capturedPasteHandler(fakePasteEvent([makeImageItem(), makeImageItem(), makeTextItem()]));
        // 坏成什么样会红：若实现把 undefined 误判成"接收 0"（typeof 判断写反）而静默，这条会红——这是
        // 向后兼容性的回归防护，防止 R1 收紧契约误伤未改造页面（如 Issue_Tracker/Issue_Lite 的纯追加
        // 候选区，undefined 就是为它们设计的默认语义）。
        expect(toastCalls.length === 1 && toastCalls[0].message === UPaste.dualDeliveredMsg(2) && toastCalls[0].type === 'info',
            'F11⑦c：collect 不返回（undefined）→ 向后兼容旧行为，按 named.length=2 提示', toastCalls);
        unregAcceptUndef();

        // ⑦d-g：S2d·R1（codex 445 M1 采纳）collect 返回非法值——NaN/Infinity/浮点/越界四种坏形态，
        //   均应 console.error 留痕 + 按未返回处理回退到 named.length 提示（不是静默、也不是误报"已
        //   粘贴成功"的错误张数）。共用一个 2 张图场景（named.length=2），逐条替换 collect 返回值。
        function makeIllegalAcceptedCase(idLabel, badValue) {
            const el = { id: 'f11-illegal-' + idLabel, getClientRects: () => [1] };
            const scope = { querySelectorAll: () => [el] };
            const unreg = UPaste.register({
                selector: '[data-f11-illegal-' + idLabel + ']', scopeResolver: () => scope, keyOf: (e) => e.id,
                collect: () => badValue,
            });
            const originalConsoleError = console.error;
            const errorCalls = [];
            console.error = function () { errorCalls.push(Array.prototype.slice.call(arguments)); };
            resetToastSpy();
            try {
                capturedPasteHandler(fakePasteEvent([makeImageItem(), makeImageItem(), makeTextItem()]));
            } finally {
                console.error = originalConsoleError;
            }
            unreg();
            return { errorCalls: errorCalls, toastCalls: toastCalls.slice() };
        }

        // ⑦d：collect 返回 NaN——坏成什么样会红：若实现仍是旧版 typeof==='number'+accepted>0 判断，
        //   NaN>0 恒 false，会被静默吞掉（既不 console.error 留痕，也不回退提示），toastCalls.length
        //   会是 0 而不是 1，第一条断言就会红。
        {
            const r = makeIllegalAcceptedCase('nan', NaN);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦d：collect 返回 NaN → console.error 留痕（含"collect 返回值非法"）', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦d：collect 返回 NaN → 按未返回处理回退，提示 named.length=2（不是静默，也不是 NaN 张）', r.toastCalls);
        }

        // ⑦e：collect 返回 Infinity——坏成什么样会红：若实现只判 typeof==='number'+accepted>0 而无
        //   上界校验，Infinity>0 为 true 会被当合法正数，报出"已粘贴 Infinity 张图片"这种荒谬提示，
        //   第二条断言（消息应为 dualDeliveredMsg(2) 而非 dualDeliveredMsg(Infinity)）会红。
        {
            const r = makeIllegalAcceptedCase('inf', Infinity);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦e：collect 返回 Infinity → console.error 留痕', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦e：collect 返回 Infinity → 按未返回处理回退，提示 named.length=2（不是"已粘贴 Infinity 张"）', r.toastCalls);
        }

        // ⑦f：collect 返回 1.5（浮点，非整数）——坏成什么样会红：若实现漏了 Number.isInteger 校验，
        //   1.5>0 为 true 且 1.5<=named.length(2) 也成立，会被误判合法，报出"已粘贴 1.5 张图片"，
        //   第二条断言会红。
        {
            const r = makeIllegalAcceptedCase('float', 1.5);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦f：collect 返回 1.5（浮点）→ console.error 留痕', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦f：collect 返回 1.5（浮点）→ 按未返回处理回退，提示 named.length=2（不是"已粘贴 1.5 张"）', r.toastCalls);
        }

        // ⑦g：collect 返回 named.length+1（越界，超过本次实际投递张数）——坏成什么样会红：若实现漏了
        //   <=named.length 上界校验，3>0 为 true 会被误判合法，报出比实际投递还多的张数，第二条断言会红。
        {
            const r = makeIllegalAcceptedCase('overflow', 3);   // named.length=2，3 越界
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦g：collect 返回 named.length+1(3，越界) → console.error 留痕', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦g：collect 返回越界值(3) → 按未返回处理回退，提示 named.length=2（不是越界的 3）', r.toastCalls);
        }

        // ⑦h：负数（-1）——覆盖"负数"这一枚举项（浮点/NaN/Infinity/越界已覆盖，负数单独补一条，
        //   Number.isInteger(-1)===true 但 accepted>=0 应判非法）。坏成什么样会红：若实现漏了 >=0
        //   下界校验，-1 会被当合法值直接落进"合法且非正数"分支——原实现语义是 accepted>0 才提示、
        //   否则静默；若新校验只查 Number.isInteger 不查 >=0，-1 会被判"合法但不 >0"从而静默，
        //   toastCalls.length 会是 0 而非 1，且不会有 console.error 留痕，两条断言都会红。
        {
            const r = makeIllegalAcceptedCase('negative', -1);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦h：collect 返回 -1（负数）→ console.error 留痕（不是被当"合法但不 >0"静默处理）', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦h：collect 返回 -1（负数）→ 按未返回处理回退，提示 named.length=2', r.toastCalls);
        }

        // ⑦i-k：S2e（codex 446 M 采纳）非 undefined 的非数字返回值——null/false/'1'（字符串数字）。
        //   坏成什么样会红：若实现仍是"typeof accepted === 'number' 才校验、其余全走 undefined 兼容
        //   分支"的两段式（S2d 版），这三种值会被静默当成"未返回"回退提示而【零 console.error 留痕】，
        //   第一条断言（errorCalls 含"collect 返回值非法"）会红——实现比契约注释（"应为 0..N 整数或
        //   undefined"）更宽松正是 446 轮指出的缺口；三段式（undefined 显式判等）修复后仅 undefined
        //   走兼容分支不留痕。
        {
            const r = makeIllegalAcceptedCase('null', null);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦i：collect 返回 null → console.error 留痕（非数字非法值不得静默溜进兼容分支）', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦i：collect 返回 null → 按未返回处理回退，提示 named.length=2', r.toastCalls);
        }
        {
            const r = makeIllegalAcceptedCase('false', false);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦j：collect 返回 false → console.error 留痕', r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦j：collect 返回 false → 按未返回处理回退，提示 named.length=2', r.toastCalls);
        }
        {
            const r = makeIllegalAcceptedCase('strnum', '1');
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                "F11⑦k：collect 返回 '1'（字符串数字）→ console.error 留痕（不得被隐式当作数字 1 提示）", r.errorCalls);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                "F11⑦k：collect 返回 '1' → 按未返回处理回退，提示 named.length=2（不是'已粘贴 1 张'）", r.toastCalls);
        }

        // ⑦l：S2f（codex 447 LOW 吸收）对象坏值（含自定义 toString 抛错的极端体）——坏成什么样会红：
        //   若留痕日志用 'xxx' + String(accepted) 拼接形式，toString 抛错的对象会让留痕语句自身抛
        //   TypeError 落进 collect 的 catch（错记为"collect 回调异常"且回退提示丢失），本条两断言
        //   （error 留痕含"返回值非法"字样 + 回退提示照常）都会红；两参 console.error 形式对任意坏值安全。
        {
            const evil = { toString: function () { throw new TypeError('boom'); } };
            const r = makeIllegalAcceptedCase('objevil', evil);
            expect(r.errorCalls.length >= 1 && r.errorCalls.some(a => typeof a[0] === 'string' && a[0].indexOf('collect 返回值非法') >= 0),
                'F11⑦l：collect 返回 toString 抛错的对象 → 留痕逻辑自身不炸且 console.error 正常留痕', r.errorCalls.length);
            expect(r.toastCalls.length === 1 && r.toastCalls[0].message === UPaste.dualDeliveredMsg(2) && r.toastCalls[0].type === 'info',
                'F11⑦l：collect 返回坏对象 → 回退提示照常（named.length=2）', r.toastCalls);
        }
    }
}

// ---------- F12：S2c·R2 候选池重复 key 运行时防护（console.error 留痕，不改归属行为）----------
console.log('\nF12. S2c·R2 候选池重复 key 运行时防护');
{
    const originalConsoleError = console.error;
    const errorCalls = [];
    console.error = function () { errorCalls.push(Array.prototype.slice.call(arguments)); };
    try {
        // 故意让两个候选元素解出同一个 key（keyOf 违反"按实例唯一派生"契约的模拟场景）。
        const elDupA = { id: 'f12-dup', getClientRects: () => [1] };
        const elDupB = { id: 'f12-dup', getClientRects: () => [1] };
        const dupScope = { querySelectorAll: () => [elDupA, elDupB] };
        const unregDup = UPaste.register({
            selector: '[data-f12-dup]', scopeResolver: () => dupScope, keyOf: (el) => el.id, collect: () => {},
        });
        const candidates = UPaste._resolveCandidates(dupScope);
        // 坏成什么样会红：若实现漏了重复 key 检测（R2 没接线），errorCalls 里找不到匹配的留痕，这条会红。
        expect(errorCalls.length >= 1 && errorCalls.some(function (args) {
            return typeof args[0] === 'string' && args[0].indexOf('候选池存在重复 key') >= 0 && args[0].indexOf('f12-dup') >= 0;
        }), 'F12：候选池出现重复 key 时 console.error 留痕（含"候选池存在重复 key"+具体 key 名）', errorCalls);
        // 坏成什么样会红：若实现把"留痕"误做成"去重剔除"（改变了归属行为，违反 codex L1 的"仅留痕不改
        // 行为"裁定），候选池会从 2 降到 1，这条会红——这是防止检测逻辑越界成行为变更的回归防护。
        expect(candidates.length === 2, 'F12：留痕不改变候选收集结果，重复 key 的两个候选仍都在池里（不做去重剔除）', candidates.length);
        unregDup();
    } finally {
        console.error = originalConsoleError;
    }
}

// ---------- F12b：S2d·R2（codex 445 L1 采纳）原型污染漏报修复——两候选 key 均为 '__proto__' ----------
console.log('\nF12b. S2d·R2 seenKeys 原型污染漏报修复（key=\'__proto__\'）');
{
    const originalConsoleError = console.error;
    const errorCalls = [];
    console.error = function () { errorCalls.push(Array.prototype.slice.call(arguments)); };
    try {
        // 两个候选元素的 keyOf 都解出字面量字符串 '__proto__'——普通对象字面量 {} 做集合时，
        // seenKeys['__proto__'] = true 会触发继承自 Object.prototype 的 __proto__ accessor setter
        // 而非创建自有属性，hasOwnProperty.call(seenKeys, '__proto__') 永远查不到，第二个同 key 候选
        // 不会被判定为"已见过"，重复 key 检测漏报。坏成什么样会红：若实现仍用 `var seenKeys = {}`
        // （未改 Object.create(null)），errorCalls 里找不到匹配的留痕，第一条断言会红。
        const elProtoA = { id: 'f12b-a', getClientRects: () => [1] };
        const elProtoB = { id: 'f12b-b', getClientRects: () => [1] };
        const protoScope = { querySelectorAll: () => [elProtoA, elProtoB] };
        const unregProto = UPaste.register({
            selector: '[data-f12b-proto]', scopeResolver: () => protoScope, keyOf: () => '__proto__', collect: () => {},
        });
        const candidates = UPaste._resolveCandidates(protoScope);
        expect(errorCalls.length >= 1 && errorCalls.some(function (args) {
            return typeof args[0] === 'string' && args[0].indexOf('候选池存在重复 key') >= 0 && args[0].indexOf('__proto__') >= 0;
        }), 'F12b：两候选 key 均为 \'__proto__\' → console.error 重复 key 留痕正常触发（漏报形态下这条会红）', errorCalls);
        // 顺带核实候选收集本身未因 __proto__ 这个特殊 key 名而异常（两个候选都还在池里，行为不变）。
        expect(candidates.length === 2, 'F12b：key=\'__proto__\' 不影响候选收集结果（两个候选仍都在池里）', candidates.length);
        unregProto();
    } finally {
        console.error = originalConsoleError;
    }
}

console.log(`\n合计 ${pass} PASS / ${fail} FAIL`);
if (fail > 0) { console.log('❌ u-paste.js 静态断言存在失败项'); process.exit(1); }
console.log('🎉 u-paste.js 静态断言全部通过');
