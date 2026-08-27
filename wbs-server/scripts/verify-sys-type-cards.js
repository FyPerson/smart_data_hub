/**
 * verify-sys-type-cards.js
 *
 * 值班筛选与类型卡·S3（前端·类型卡第二排 + 与类型下拉联动）沙箱真执行断言。
 * SSOT = docs/local/系统迭代/任务_值班筛选与类型卡_长任务锚点_20260815.md §3。
 * 用法：node scripts/verify-sys-type-cards.js（纯文本源码提取 + new Function 真执行，无需启动 server，自包含）。
 *
 * 背景：S3 在 Sys_Iteration.html 新增 siRenderTypeCards()（类型卡第二排，按 siTypeKeys() 派生渲染）+
 *   siSetTypeFilter()（点卡 toggle）+ 改造 siSetType()（下拉/卡片共用的单一事实源 setter，新增下拉 DOM
 *   同步）+ siRenderStats() 末尾钩子调用 siRenderTypeCards()。本文件不是静态 .includes() 文本匹配套件
 *   （那证不了"toggle 逻辑对不对""计数基数是否偷偷自指"这类行为），全部核心断言走真执行：从源码提取
 *   函数体，用 new Function 编译为真可调用函数，喂受控输入观察真实输出。函数体提取统一走
 *   scripts/lib/extract-function-body.js（406/407/408 四轮硬化的单点实现——有限状态词法扫描剥注释/
 *   字符串/正则字面量后再做括号深度计数，比裸括号扫描器更抗"字面量里的假花括号"这类误判，S2 预筛
 *   MED-2 明确要求新断言禁再手写一份裸扫描器），不自建提取逻辑。
 *
 * 覆盖：
 *   ① siSetTypeFilter toggle 逻辑真执行：同 key 再点→'all'（取消回全部）／异 key→切到该 key；顺带验证
 *      siSetType 内的下拉 DOM 同步（siFType 的 value 跟着 siActiveType 走，不止内部变量变了但下拉视觉
 *      没跟上这种写读不同源）。
 *   ② siRenderTypeCards 计数基数真执行三性质：不随 siActiveType 收缩（自指陷阱的直接反证——用同一份
 *      siList/siActiveStat，siActiveType 从 'all' 切到 'bug' 两次运行，非当前类型的卡计数应逐字不变）；
 *      已作废行不计入；siMatchSearch/siMatchStatFilter 逐行真被调用（wiring spy，非重新验证这两个函数
 *      自身的正确性——那部分已有 S1[59]/S2[⑫]覆盖，这里只证"siRenderTypeCards 确实把它们接上了"）。
 *      另加一条静态基数表达式文本核对（不含 siActiveType/siVisibleTypeList 字面量）作为双保险——即使
 *      某个真执行用例的期望值恰好算对了，字面量层面仍不该出现这两个自指来源。
 *   ③ 接线四条：siRenderStats 末尾确实调用了 siRenderTypeCards（且在主渲染赋值之后，不是随手插在中间
 *      被后续代码路径绕过）；卡 onclick 与下拉 onchange 收敛到同一个函数名 siSetType（siSetTypeFilter
 *      内部转调 siSetType，非另起一套重渲染序列）；卡 key 来源于 siTypeKeys() 真执行验证（S2 预筛 M4
 *      教训——"key typo 断言全绿"的破法：只查"onclick 调用了 siSetTypeFilter"这类存在性文本永远测不出
 *      硬编码错位的 key，本组改成让 3 张卡各自数值化核对"这张卡的 onclick 参数是不是就是渲染它自己的
 *      那个 type"，硬编码/错位 key 会被逐卡精确命中）；容器 id 在 HTML 与渲染函数间一致（HTML 静态
 *      grep + 真执行沙箱同一字符串双重印证，字符串不一致时沙箱会因 getElementById 返回 null 提前 return
 *      而自然报红，非只查"两处都出现这串字符"）。
 *   ④ typeFlows 派生：mock siTypeKeys() 返回 3 键→渲染 3 张卡，返回 4 键（含预留位 config 激活后的形态）
 *      →渲染 4 张卡——证明卡数由 siTypeKeys() 决定，非硬编码固定三类。
 *
 * mutation 自证（本文件不内置，跑在外层——见交付报告 mutation 红点编号）：①临时删除 siRenderStats 末尾
 *   的 siRenderTypeCards() 调用 → 组③接线①断言应红；②临时改坏 siSetTypeFilter 的 toggle 逻辑（恒定
 *   切到 t，不判断 siActiveType===t）→ 组①断言应红。两处改完复原，确认套件回到全绿。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { extractFunctionBody } = require('./lib/extract-function-body');

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

function bodyOf(fnName) {
    const body = extractFunctionBody(src, fnName);
    assert.ok(body, `未提取到 ${fnName} 函数体（提不到=守卫空转，不能当通过）`);
    return body;
}

// ══════════════════════════ ① siSetTypeFilter toggle 逻辑真执行 + 下拉 DOM 同步 ══════════════════════════
console.log('— ① siSetTypeFilter toggle 逻辑真执行（同 key→\'all\' / 异 key→该 key）+ 下拉 DOM 同步 —');
{
    const fnSetType = bodyOf('siSetType');
    const fnSetTypeFilter = bodyOf('siSetTypeFilter');

    // 受控沙箱：document.getElementById('siFType') 返回可读写 .value 的假元素（观察下拉 DOM 是否被同步）；
    //   siRenderStats/siRenderTable 打桩为纯计数（不关心它们内部行为，只证"确实被调用了"，避免真执行
    //   整棵渲染树引入无关依赖）；siActiveType 用 let 声明，初值由每个用例注入，siSetType/siSetTypeFilter
    //   两函数体在同一份编译文本里按源码原样拼入（真代码，非复述）。
    function run(initialActiveType, callArg) {
        const selEl = { value: null };
        const src2 = `
            let siActiveType = ${JSON.stringify(initialActiveType)};
            let __renderStatsCalls = 0, __renderTableCalls = 0;
            function siRenderStats() { __renderStatsCalls++; }
            function siRenderTable() { __renderTableCalls++; }
            const __selEl = { value: null };
            const document = { getElementById: (id) => id === 'siFType' ? __selEl : null };
            ${fnSetType}
            ${fnSetTypeFilter}
            siSetTypeFilter(${JSON.stringify(callArg)});
            return { activeType: siActiveType, selValue: __selEl.value, renderStatsCalls: __renderStatsCalls, renderTableCalls: __renderTableCalls };
        `;
        // eslint-disable-next-line no-new-func
        return new Function(src2)();
    }

    check('[①前置] siSetType/siSetTypeFilter 提取物可编译执行（不抛错）', () => {
        const r = run('all', 'bug');
        assert.ok(r && typeof r === 'object', '沙箱执行应返回观察对象');
    });
    check('异 key：siActiveType=\'all\' 时点「bug」卡 → 切到 \'bug\'（非取消）', () => {
        const r = run('all', 'bug');
        assert.strictEqual(r.activeType, 'bug', `异 key 应切到该 key，实得 ${r.activeType}`);
    });
    check('同 key：siActiveType=\'bug\' 时再点「bug」卡 → toggle 回 \'all\'（取消，非停留在 bug）', () => {
        const r = run('bug', 'bug');
        assert.strictEqual(r.activeType, 'all', `同 key 再点应 toggle 回 all，实得 ${r.activeType}`);
    });
    check('异 key 切换：siActiveType=\'bug\' 时点「feature」卡 → 切到 \'feature\'（非 toggle 到 all）', () => {
        const r = run('bug', 'feature');
        assert.strictEqual(r.activeType, 'feature', `不同 key 应直接切换，实得 ${r.activeType}`);
    });
    check('下拉 DOM 同步：调用后 siFType 的 value 与新 siActiveType 一致（写读同源，非只改内部变量）', () => {
        const r1 = run('all', 'bug');
        assert.strictEqual(r1.selValue, 'bug', `下拉 value 应同步为 bug，实得 ${r1.selValue}`);
        const r2 = run('bug', 'bug');
        assert.strictEqual(r2.selValue, 'all', `toggle 回全部时下拉 value 应同步为 all，实得 ${r2.selValue}`);
    });
    check('siSetType 内部确实调用了 siRenderStats + siRenderTable（各恰一次，重渲染链未被绕过）', () => {
        const r = run('all', 'bug');
        assert.strictEqual(r.renderStatsCalls, 1, `siRenderStats 应恰调用 1 次，实得 ${r.renderStatsCalls}`);
        assert.strictEqual(r.renderTableCalls, 1, `siRenderTable 应恰调用 1 次，实得 ${r.renderTableCalls}`);
    });
}

// ══════════════════════════ ② siRenderTypeCards 计数基数真执行三性质 ══════════════════════════
console.log('— ② siRenderTypeCards 计数基数真执行：不随 siActiveType 收缩 / 已作废排除 / 搜索与状态组接线 —');

// 沙箱工厂：真提取 siRenderTypeCards 函数体，注入受控 siList/siActiveType/siActiveStat/siTypeKeys/
//   siMatchSearch/siMatchStatFilter（后两者可设为恒真桩或计数 spy），执行后返回容器 innerHTML 供解析。
//   SI_TYPE_CARD_COLOR/esc/siTypeLabel 打桩为最简实现——本组不关心颜色/文案，只关心计数与 key 传递。
function runTypeCardsSandbox({ siList, siActiveType, siActiveStat, typeKeys, matchSearchImpl, matchStatFilterImpl, currentUid }) {
    const fnRenderTypeCards = bodyOf('siRenderTypeCards');
    const fnEsc = bodyOf('esc');                    // [S-fix3·codex 414 MED-3] 生产实现原样拼入，不再恒等打桩
    const fnJsAttr = bodyOf('siJsStringAttr');
    // [codex 481 三轮 MED-1] ⑧⑨ 代表快照三件套注入**真实实现**（不打桩成空 Map，否则类型卡路径上
    //   "漏传参数/传错基数"永远测不出来）。bodyOf 自带提取失败即判红，不会静默空转。
    const fnComputeReleaseRepMap = bodyOf('siComputeReleaseRepMap');
    const fnIsReleaseNeedsExecutorMember = bodyOf('siIsReleaseNeedsExecutorMember');
    const fnIsReleaseExecPendingMember = bodyOf('siIsReleaseExecPendingMember');
    const src2 = `
        let siActiveType = ${JSON.stringify(siActiveType)};
        let siActiveStat = ${JSON.stringify(siActiveStat)};
        const siList = ${JSON.stringify(siList)};
        const SI_TYPE_CARD_COLOR = { __default__: { bg: '#fff', fg: '#000' } };
        // [S-fix3·codex 414 MED-3] esc/siJsStringAttr 用**生产实现**原样拼入（不再恒等打桩）：恒等桩
        //   产出 siSetTypeFilter("bug") 这种真实 HTML 属性里不成立的嵌套引号文本——桩与生产形态不同构
        //   ⇒ 转义链（JSON.stringify→esc 实体编码→浏览器解码）任一环失效套件仍假绿。现沙箱产物与
        //   浏览器看到的属性文本逐字同形（&quot; 实体形态），解码执行见 parseAllCards。
        ${fnEsc}
        ${fnJsAttr}
        function siTypeLabel(t) { return t; }
        function siTypeKeys() { return ${JSON.stringify(typeKeys)}; }
        let __searchCalls = 0, __statCalls = [];
        function siMatchSearch(i) { __searchCalls++; return (${matchSearchImpl}).call(null, i); }
        function siMatchStatFilter(i, k, repMap) { __statCalls.push(k); return (${matchStatFilterImpl}).call(null, i, k, repMap); }
        // [上线排期待办 ⑧⑨·2026-08-27] siRenderTypeCards 现会**按 type 桶各自**算代表快照传给
        //   siMatchStatFilter（codex 481 三轮 HIGH-2：类型卡按桶分组计数，用全量算一份共用代表会让
        //   混类型批次的某个桶漏计，出现"卡上 0、点进去 1"）。
        //   ⚠️ [codex 481 三轮 MED-1] 这里**注入真实实现**，不再用返回空 Map 的打桩——空 Map 会让
        //   ⑧⑨ 在类型卡路径上恒 false，于是"漏传参数/传错基数"这类缺陷在本套件里永远测不出来
        //   （审查方原话：即使类型卡漏传参数、传错基数，现有动态测试仍可能全部通过）。
        //   uid 桩返回 null：本套件的夹具不含 ⑧⑨ 场景，null 让代表 map 恒空但**路径真实走过**；
        //   若将来要在此验 ⑧⑨ 命中，把 uid 桩改成真实 id 并补夹具即可，实现本身无需再动。
        function siCurrentUid() { return ${JSON.stringify(currentUid === undefined ? null : currentUid)}; }
        ${fnComputeReleaseRepMap}
        ${fnIsReleaseNeedsExecutorMember}
        ${fnIsReleaseExecPendingMember}
        const __box = { innerHTML: null, style: {} };   // [S-fix2] style 补桩——LOW-2 空键集隐藏容器写 box.style.display
        const document = { getElementById: (id) => id === 'siTypeCardsRow' ? __box : null };
        ${fnRenderTypeCards}
        siRenderTypeCards();
        return { html: __box.innerHTML, searchCalls: __searchCalls, statCalls: __statCalls };
    `;
    // eslint-disable-next-line no-new-func
    return new Function(src2)();
}
// 从渲染结果 HTML 里逐卡解析出 onclick 实参/计数/label 三元组（label 文本即 type 字面量，本组桩函数令
//   siTypeLabel 恒等映射）。[S-fix3·codex 414 MED-3] onclickArg 不再用正则从文本里"猜"实参——按浏览器
//   真实链路取得：①属性值须为 esc 实体编码形态（每卡断言含 &quot;，JSON.stringify 恒产双引号 ⇒ 转义链
//   活着的铁证）②HTML 实体解码（浏览器 HTML parser 的等价步骤）③解码产物作为事件处理器源码真执行，
//   以 spy 捕获 siSetTypeFilter 实参——转义/解码/调用任一环坏，这里就地红。
function decodeHtmlEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function parseAllCards(html) {
    // [S-fix4] onclick 后跟交互语义属性（role/tabindex/onkeydown/aria-pressed）——`[^>]*` 吸收
    const re = /onclick="([^"]*)"[^>]*><div class="u-stat-icon"[^>]*>[\s\S]*?<div class="u-stat-num">(\d+)<\/div><div class="u-stat-label">([^<]*)<\/div>/g;
    const out = [];
    let m;
    while ((m = re.exec(html))) {
        const attrSource = m[1];
        assert.ok(attrSource.includes('&quot;'), `onclick 属性应为实体编码形态（含 &quot;·生产转义链产物），实得 ${JSON.stringify(attrSource)}——无实体=esc 链未生效（恒等桩回潮或实现绕过 siJsStringAttr）`);
        let calledWith = null, calls = 0;
        // eslint-disable-next-line no-new-func
        new Function('siSetTypeFilter', decodeHtmlEntities(attrSource))(function (arg) { calls++; calledWith = arg; });
        assert.strictEqual(calls, 1, `解码后的 onclick 源码执行应恰调用 siSetTypeFilter 1 次，实得 ${calls}`);
        out.push({ onclickArg: calledWith, n: Number(m[2]), label: m[3] });
    }
    return out;
}

{
    const FIXTURE = [
        { type: 'bug', status: '处理中' },
        { type: 'feature', status: '处理中' },
        { type: 'feature', status: '处理中' },
        { type: 'feature', status: '已作废' },   // 已作废——不应计入任何类型卡
    ];
    check('计数基数不随 siActiveType 收缩：siActiveType=\'all\' 与 \'bug\' 两次运行，bug/feature 计数逐字相同', () => {
        const rAll = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const rBug = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'bug', siActiveStat: '', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const cardsAll = parseAllCards(rAll.html);
        const cardsBug = parseAllCards(rBug.html);
        const bugAll = cardsAll.find(c => c.label === 'bug').n;
        const featureAll = cardsAll.find(c => c.label === 'feature').n;
        const bugBug = cardsBug.find(c => c.label === 'bug').n;
        const featureBug = cardsBug.find(c => c.label === 'feature').n;
        assert.strictEqual(featureBug, featureAll, `自指陷阱：siActiveType='bug' 时 feature 卡计数不应收缩（若用了 siVisibleTypeList 会腰斩为 0），实得 all=${featureAll} bug=${featureBug}`);
        assert.strictEqual(bugBug, bugAll, `bug 卡自身计数也不应因 siActiveType 而变化，实得 all=${bugAll} bug=${bugBug}`);
        assert.strictEqual(featureAll, 2, `前置：夹具 feature 未作废行应恰 2（1 条已作废不计），实得 ${featureAll}`);
    });
    check('已作废行不计入类型卡计数', () => {
        const r = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'all', siActiveStat: '', typeKeys: ['feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const feature = parseAllCards(r.html).find(c => c.label === 'feature').n;
        assert.strictEqual(feature, 2, `已作废那条 feature 不应计入，实得 ${feature}（夹具含 1 已作废+2 处理中，应恰 2）`);
    });
    check('siMatchSearch 逐行真被调用（wiring）：调用次数=已作废排除后的行数（3，非全 4 行、非 0）', () => {
        const r = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        assert.strictEqual(r.searchCalls, 3, `siMatchSearch 调用次数应为已作废排除后的 3 行，实得 ${r.searchCalls}`);
    });
    check('siMatchStatFilter 逐行真被调用且第二实参=当前 siActiveStat（wiring，非重测其自身逻辑）', () => {
        const r = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'all', siActiveStat: 'acceptance', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        assert.strictEqual(r.statCalls.length, 3, `siMatchStatFilter 调用次数应为 3，实得 ${r.statCalls.length}`);
        assert.ok(r.statCalls.every((k) => k === 'acceptance'), `每次调用第二实参都应是当前 siActiveStat('acceptance')，实得 ${JSON.stringify(r.statCalls)}`);
    });
    check('siMatchStatFilter 返回 false 时该行不计入任何类型卡（AND 语义真生效，非仅接线不生效）', () => {
        const r = runTypeCardsSandbox({
            siList: FIXTURE, siActiveType: 'all', siActiveStat: 'x', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return false;}',
        });
        const cards = parseAllCards(r.html);
        assert.ok(cards.every((c) => c.n === 0), `siMatchStatFilter 恒 false 时全部类型卡计数应为 0，实得 ${JSON.stringify(cards)}`);
    });
    // 静态双保险（belt）：即便某个真执行用例恰好算对，字面量层面也不该出现这两个自指来源——精确定位到
    //   `const base = ...;` 这一句本身，不对整个函数体做黑名单扫描（函数体其余处如 active 高亮判断合法
    //   使用 siActiveType，整体扫描会把那处合法使用也判红，见该处代码与注释）。
    // [codex 481 四轮 MED] 混类型批次的**动态**证明——三轮 HIGH-2 的反例场景直接做成用例：
    //   同一 release(501) 含 feature(#10) + improvement(#11) 两成员、创建人=我、执行人 0
    //   ⇒ feature 卡与 improvement 卡应**各计 1**（各自桶内选出自己的代表），与"切到该 tab 后
    //   列表在子集内重选代表"的行为逐字一致。旧实现（全量共用一份 map）在此得 feature=1、
    //   improvement=0——正是"卡上 0、点进去 1"的分叉，本用例对它必判红。
    check('[四轮 MED] 混类型批次动态证明：同 release 含 feature+improvement 各一成员（我建的批次·执行人 0）→ 两卡各计 1（旧全量共用 map 实现在此 improvement=0 必判红）', () => {
        const mixedList = [
            { id: 10, type: 'feature', status: '待上线', release_id: 501, release_created_by: 77, release_exec_count: 0 },
            { id: 11, type: 'improvement', status: '待上线', release_id: 501, release_created_by: 77, release_exec_count: 0 },
        ];
        const r = runTypeCardsSandbox({
            siList: mixedList, siActiveType: 'all', siActiveStat: 'my_pending',
            typeKeys: ['feature', 'improvement'],
            matchSearchImpl: '(i) => true',
            // 真实 siMatchStatFilter 需要 siIsMyPending 全家族，本沙箱按既有纪律只注入 ⑧⑨ 判据链：
            //   my_pending 路由直接走 siIsMyReleaseNeedsExecutor 等价判定（成员条件 ∧ 桶内代表）。
            matchStatFilterImpl: '(i, k, repMap) => k === "my_pending" ? (siIsReleaseNeedsExecutorMember(i, 77) && repMap && repMap.get(Number(i.release_id)) === Number(i.id)) : true',
            currentUid: 77,
        });
        const cards = parseAllCards(r.html);
        const fCard = cards.find(c => c.label === 'feature');
        const iCard = cards.find(c => c.label === 'improvement');
        assert.ok(fCard && iCard, `应渲染 feature 与 improvement 两张卡，实得 ${JSON.stringify(cards.map(c => c.label))}`);
        assert.strictEqual(fCard.n, 1, `feature 卡应计 1（桶内代表 #10），实得 ${fCard.n}`);
        assert.strictEqual(iCard.n, 1, `improvement 卡应计 1（桶内代表 #11）——旧全量共用 map 实现在此得 0（全量最小 id 是 feature 的 #10），实得 ${iCard.n}`);
    });
    check('静态核对：桶内计数基数（const tList = ... / const n = ...）不含 siActiveType / siVisibleTypeList', () => {
        // [codex 481 三轮 HIGH-2 收口] 实现由"全量算一份 base 再按 type 分桶"改为"每个 type 桶各自
        //   取子集 + 桶内选代表"，原先那个 `const base = ...` 变量已不存在。**防护意图逐条保留**：
        //   基数仍必须来自 siList 按参数 t 过滤（而不是 siActiveType / siVisibleTypeList 这类"已按当前
        //   选中类型过滤过"的来源——那是自指陷阱：用已过滤集合去算各类型计数，非选中类型恒为 0）。
        const body = bodyOf('siRenderTypeCards');
        const mList = body.match(/const tList = ([\s\S]*?);/);
        assert.ok(mList, '未定位到 const tList = ... 语句（桶内基数，提取边界可能与实现不符）');
        const mCount = body.match(/const n = ([\s\S]*?)\.length;/);
        assert.ok(mCount, '未定位到 const n = ....length 语句（桶内计数）');
        const expr = mList[1] + '\n' + mCount[1];
        assert.ok(!/siActiveType/.test(expr), `桶内计数基数不应引用 siActiveType（自指：用当前选中类型过滤过的集合去算各类型计数，非选中类型恒 0），实得片段：${expr}`);
        assert.ok(!/siVisibleTypeList/.test(expr), `桶内计数基数不应调用 siVisibleTypeList（该函数已按 siActiveType 过滤过，等价自指），实得片段：${expr}`);
        assert.ok(/siList\.filter\(i => i\.type === t\)/.test(mList[1]), '桶内基数应为 siList 按**参数 t** 过滤（每个桶取自己那部分，与切到该 tab 后 siVisibleTypeList 同源）');
        // [codex 481 四轮 LOW] 计数链必须**从 tList 起链**——只查"tList 定义对、tRepMap 对"拦不住
        //   "n 改回从 siList/别的集合算"的回归（三件各自正确但没接在一起）。
        assert.ok(/^\s*tList\s*\.filter/.test(mCount[1]) || /=\s*tList\s*$/.test(mCount[1].split('.filter')[0] + ''),
            `const n = ... 的计数链应从 tList 起链（实得起点片段：${mCount[1].slice(0, 60)}）——从 siList 或其它集合起链即回归到"全量算再分桶"`);
        assert.ok(/已作废/.test(expr), '桶内计数应含已作废排除');
        assert.ok(/siMatchSearch/.test(expr), '桶内计数应叠加 siMatchSearch');
        assert.ok(/siMatchStatFilter/.test(expr), '桶内计数应叠加 siMatchStatFilter（AND 状态组筛选）');
        // [codex 481 三轮 HIGH-2] 代表必须**按桶算**：若这里退回共用一份全量 map，混类型批次会出现
        //   "卡上 0、点进去 1"的口径分叉（审查方给出的反例）。
        assert.ok(/const tRepMap = siComputeReleaseRepMap\(tList,/.test(body),
            '未见桶内代表快照 `const tRepMap = siComputeReleaseRepMap(tList, ...)`——代表必须在该 type 桶内选，不能用全量 siList 算一份共用');
        assert.ok(/siMatchStatFilter\(i, siActiveStat, tRepMap\)/.test(body),
            '桶内 siMatchStatFilter 应传本桶的 tRepMap（传别的 map 等于没按桶选代表）');
    });
}

// ══════════════════════════ ③ 接线四条 ══════════════════════════
console.log('— ③ 接线四条：siRenderStats 末尾调用 / 卡与下拉同一 setter / key 来源真执行核对 / 容器 id 一致 —');
{
    check('接线①：siRenderStats 末尾（主渲染赋值之后）确实调用了 siRenderTypeCards()', () => {
        const body = bodyOf('siRenderStats');
        const mainRenderIdx = body.indexOf("document.getElementById('siStatsRow').innerHTML");
        const hookIdx = body.indexOf('siRenderTypeCards()');
        assert.ok(mainRenderIdx >= 0, '未定位到 siStatsRow 主渲染赋值语句');
        assert.ok(hookIdx >= 0, 'siRenderStats 函数体未见调用 siRenderTypeCards()——两排卡会失步');
        assert.ok(hookIdx > mainRenderIdx, `siRenderTypeCards() 调用应在主渲染赋值之后（末尾钩子形状），实得 hookIdx=${hookIdx} <= mainRenderIdx=${mainRenderIdx}`);
    });
    check('接线②：卡 onclick 与下拉 onchange 收敛到同一个函数名 siSetType（siSetTypeFilter 内部转调，非另起一套重渲染序列）', () => {
        const selectTag = src.match(/<select id="siFType"[^>]*>/);
        assert.ok(selectTag, '未找到 siFType 下拉元素');
        assert.ok(/onchange="siSetType\(this\.value\)"/.test(selectTag[0]), `下拉 onchange 应直接调用 siSetType，实得 ${selectTag[0]}`);
        const filterBody = bodyOf('siSetTypeFilter');
        assert.ok(/\bsiSetType\(/.test(filterBody), 'siSetTypeFilter 函数体应调用 siSetType（同一 setter，禁另写一套 siActiveType=.../siRenderStats()/siRenderTable() 重渲染序列）');
        assert.ok(!/siRenderStats\(\)/.test(filterBody) && !/siRenderTable\(\)/.test(filterBody), 'siSetTypeFilter 不应自己直接调用 siRenderStats/siRenderTable（那是 siSetType 的职责，直接调用=另起了一套重渲染序列）');
    });
    check('接线③：卡 key 真执行核对——3 张卡各自的 onclick 实参精确等于渲染它自己的那个 type（非硬编码/错位，S2-M4 同款陷阱防线）', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }, { type: 'feature', status: '处理中' }, { type: 'improvement', status: '处理中' }],
            siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature', 'improvement'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const cards = parseAllCards(r.html);
        assert.strictEqual(cards.length, 3, `应恰渲染 3 张卡，实得 ${cards.length}`);
        for (const key of ['bug', 'feature', 'improvement']) {
            const card = cards.find((c) => c.label === key);
            assert.ok(card, `未找到 label=${key} 的卡`);
            assert.strictEqual(card.onclickArg, key, `label=${key} 的卡 onclick 实参应等于自身 type（${key}），实得 ${card.onclickArg}——硬编码/错位 key 会在此被精确命中`);
        }
    });
    check('接线④：容器 id 在 HTML 与渲染函数间一致（siTypeCardsRow）——HTML 静态含该 id + 真执行沙箱同一字符串双重印证', () => {
        assert.ok(/id="siTypeCardsRow"/.test(src), 'HTML 未见 id="siTypeCardsRow" 容器');
        assert.ok(/getElementById\('siTypeCardsRow'\)/.test(bodyOf('siRenderTypeCards')), 'siRenderTypeCards 未见 getElementById(\'siTypeCardsRow\')');
        // 双重印证——上面两条字符串各自匹配即便两串"恰好各自输错成同一个错字符串"也会被误判一致；真执行
        //   沙箱按这同一个字符串接线（见 runTypeCardsSandbox 的 document.getElementById 桩），若字符串不
        //   一致，siRenderTypeCards 内 `if (!box) return;` 会提前退出，__box.innerHTML 恒为 null——本组
        //   ②④两组全部真执行断言事实上已持续验证这条，此处再加一条显式独立断言。
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'all', siActiveStat: '', typeKeys: ['bug'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        assert.ok(r.html !== null && r.html !== undefined, '容器 id 一致时沙箱应能取到非空 innerHTML（id 不一致会因 box 为 null 提前 return，innerHTML 保持初值 null）');
    });
}

// ══════════════════════════ ④ typeFlows 派生：卡数由 siTypeKeys() 决定，非硬编码三类 ══════════════════════════
console.log('— ④ typeFlows 派生：mock siTypeKeys() 三键→三卡 / 四键（含预留位 config）→四卡 —');
{
    check('mock siTypeKeys() 返回 3 键（bug/feature/improvement）→ 渲染恰 3 张卡', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature', 'improvement'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        assert.strictEqual(parseAllCards(r.html).length, 3, `3 键应渲染 3 张卡，实得 ${parseAllCards(r.html).length}`);
    });
    check('mock siTypeKeys() 返回 4 键（含预留位 config 激活后的形态）→ 渲染恰 4 张卡（非硬编码卡死三类）', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature', 'improvement', 'config'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const cards = parseAllCards(r.html);
        assert.strictEqual(cards.length, 4, `4 键应渲染 4 张卡，实得 ${cards.length}`);
        assert.ok(cards.some((c) => c.label === 'config'), '第四张卡应对应新键 config');
    });
    check('mock siTypeKeys() 返回空数组 → 容器清空为空串（既不报错也不残留旧内容）', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'all', siActiveStat: '', typeKeys: [],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        assert.strictEqual(r.html, '', `空 typeKeys 应清空容器为空串，实得 ${JSON.stringify(r.html)}`);
    });
}

// ══════════════════════════ ⑤ [S-fix4·codex 414/415 MED-1] 可点卡交互语义四件 ══════════════════════════
console.log('— ⑤ a11y：role/tabindex/键盘触发/aria-pressed（415 裁断采纳·循环级统一）—');
{
    check('每张类型卡带 role="button" tabindex="0" onkeydown="siCardKeydown(event)" 三件套', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'all', siActiveStat: '', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const cardCount = (r.html.match(/u-stat-card/g) || []).length;
        for (const attr of ['role="button"', 'tabindex="0"', 'onkeydown="siCardKeydown(event)"']) {
            const hit = (r.html.split(attr).length - 1);
            assert.strictEqual(hit, cardCount, `属性 ${attr} 出现次数应等于卡数 ${cardCount}（每卡一份），实得 ${hit}`);
        }
    });
    check('aria-pressed 两态与激活判据同源：siActiveType=bug 时 bug 卡 true、其余 false', () => {
        const r = runTypeCardsSandbox({
            siList: [{ type: 'bug', status: '处理中' }], siActiveType: 'bug', siActiveStat: '', typeKeys: ['bug', 'feature'],
            matchSearchImpl: 'function(i){return true;}', matchStatFilterImpl: 'function(i,k){return true;}',
        });
        const pressedTrue = (r.html.match(/aria-pressed="true"/g) || []).length;
        const pressedFalse = (r.html.match(/aria-pressed="false"/g) || []).length;
        assert.strictEqual(pressedTrue, 1, `激活卡应恰 1 张 aria-pressed="true"，实得 ${pressedTrue}`);
        assert.strictEqual(pressedFalse, 1, `未激活卡应恰 1 张 aria-pressed="false"，实得 ${pressedFalse}`);
        assert.ok(/aria-pressed="true"[^>]*><div class="u-stat-icon"[\s\S]*?<div class="u-stat-label">bug</.test(r.html) || /onclick="[^"]*bug[^"]*"[^>]*aria-pressed="true"/.test(r.html), 'aria-pressed="true" 应落在 bug 卡上（与 active class 判据 siActiveType===t 同源）');
    });
    check('siCardKeydown 真执行：Enter/Space 触发 currentTarget.click()+preventDefault，其余键不拦', () => {
        const fnKeydown = bodyOf('siCardKeydown');
        // eslint-disable-next-line no-new-func
        const probe = new Function(`${fnKeydown}; return function(key){ let clicked=0, prevented=0; siCardKeydown({ key, preventDefault(){ prevented++; }, currentTarget: { click(){ clicked++; } } }); return { clicked, prevented }; };`)();
        assert.deepStrictEqual(probe('Enter'), { clicked: 1, prevented: 1 }, 'Enter 应触发 click+preventDefault');
        assert.deepStrictEqual(probe(' '), { clicked: 1, prevented: 1 }, 'Space 应触发 click+preventDefault');
        assert.deepStrictEqual(probe('a'), { clicked: 0, prevented: 0 }, '普通键不应触发也不应吞默认行为');
        assert.deepStrictEqual(probe('Tab'), { clicked: 0, prevented: 0 }, 'Tab 不得被拦（否则键盘焦点被困在卡上）');
    });
}

console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
