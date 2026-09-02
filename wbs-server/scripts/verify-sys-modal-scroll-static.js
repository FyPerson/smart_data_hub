/**
 * verify-sys-modal-scroll-static.js
 *
 * 上线单管理体验优化 O2+O1（方案 20260824_v1.3 §3 O1/O2 · R-C1+R-C2+R-C3）：`.si-modal` 通用类三段
 * 固定布局（head/body/foot，仅 body 可滚）+ 内层 6 处固定高度滚动区改造（R-C1）+ head 动作位
 * `#siBatchHeadActions`「+ 新建上线单」上移改造（R-C2）+ 加单候选列表「所属系统」徽章 `.u-sys-tag`
 * （R-C3）后的结构不变量静态守卫。
 *
 * 用法：node scripts/verify-sys-modal-scroll-static.js   （纯文本源码扫描，无需启动 server，自包含）
 *
 * ⚠️ 结构锚纪律（双阶段长任务契约 20260825_v1.1 §3.3 明文·非抽象好习惯，是本任务里真实会发生的
 * 碰撞）：Phase P 已往同一个 `<style>` 块加了 `.si-wrap` 统计卡紧凑覆盖规则（:24/:61-70 一带）。
 * 本守卫全部按「CSS 选择器 / JS 函数名」定位取内容，禁止整块 <style> 文本匹配或行号锚——否则
 * P 的改动会让本守卫假红，或行号写死后未来任何改动都误报（先例：verify-sys-release-panel-static.js
 * 的 extractFunctionBody/guardConditionBefore 范式，本文件延用同一思路）。
 *
 * 分工：本脚本只读源码结构，回答"代码写没写对"；R 方案 449-M5 要求的计算样式/浏览器断言
 * （"运行时表现是否真的如愿"——外层实际不滚、body 实际可滚）留给后续 Playwright／S14 补——
 * 本 commit（R-C1）只做结构化滚动 + 内层高度改造，不起 server，派单 spec 明文允许。
 *
 * 断言清单（每条标注"实现坏成什么样会红"，详见各 check 名称与内联说明）：
 *   ① .si-modal 容器规则：display:flex ∧ flex-direction:column ∧ overflow:hidden，不含 overflow-y:auto
 *   ② .si-modal-body：flex:1 ∧ overflow-y:auto ∧ min-height:0；.si-modal-head/.si-modal-foot：flex-shrink:0
 *   ③ 四容器（#siModalBox/#siBatchBox/#siFlowGuideBox/#siDutyRosterBox）DOM 结构：
 *      前两者 head+body+foot 齐全；后两者 head+body（无 foot，方案 §2.2 已定性为设计使然非缺陷）
 *   ④ #siBatchBox 的宽高覆盖规则不得静默声明自己的 overflow（会绕开①的 flex 滚动模型）
 *   ⑤ #siFlowGuideBox 内联 display:flex;flex-direction:column（外层）与 overflow:hidden（body）
 *      仍原样保留（449 已独立复核背书"冗余但不冲突"，本条钉住这两处不被"顺手清理冗余"误删）
 *   ⑥ 内层 6 处固定高度滚动区（150/180/150/220/320/320px，按函数结构锚定位，非行号）均已改为
 *      max-height:min(<原值>px,45vh) 且带 overscroll-behavior:contain（原始 px 值方案冻结"顺序不变"）
 *   ⑦ 范围边界：2 处**不在**本 commit §5 改动点清单内的 max-height 区域
 *      （.si-tl-release-json pre 静态 CSS 规则 150px／siOpenDeleteAuditDetail 内联 240px）
 *      保持原样未被 min()/overscroll-behavior 误覆盖——防未来"批量套用"误伤范围外区域
 *   ⑧（R-C2，观察反馈优化批 R7 改写）#siBatchBox head DOM：标题→动作位顺序，head 内不再含关闭按钮；
 *      #siBatchHead 补 min-width:0+ellipsis 三件套、#siBatchHeadActions 补 flex-shrink:0
 *      （449-M3：长单号标题与视口宽度无关，1280 档同样能撑破）
 *   ⑨（R-C2）六个入口函数（siRenderBatchList/siOpenDeleteAudit/siRenderDeleteAuditListBody/
 *      siOpenDeleteAuditDetail/siOpenReleaseLog/siOpenBatchDetail）各自无条件清空
 *      #siBatchHeadActions（结构锚 + 全文总量恰 6 处）；值班排班反向排除
 *   ⑩（R-C2）「+ 新建上线单」从 foot 上移到 head 动作位，仍受 isAdmin() 门控；
 *      449-M1 空态文案「点右下角」改「点右上角」
 *   ⑪（R-C3）O1 加单候选列表所属系统徽章：`.u-sys-tag` 落页面内 `<style>`（不进共享 components.css，
 *      免 ?v= bump）、含中性 slate 三色值 + white-space:nowrap（D1/449-L1）；siModalAddToBatch 候选行
 *      模板 system_name 假值不渲染空徽章、渲染值经 esc() 转义、标题改包 `.si-chk-text`（可收缩项）
 *   ⑫（观察反馈优化批 R7，demo 三轮定稿「X 独立行版」）#siBatchBox 直接子结构由 3 段变 4 段——
 *      `.si-close-bar` 独立成第一个子元素（内含唯一 `.si-close-handle` 按钮，onclick=siCloseBatch()），
 *      head 内联的 X 移除；#siBatchOverlay 专属覆盖 `.si-modal-head` padding；siBatchFoot 7 处写入点里
 *      纯「关闭」按钮全部退场（4 处清空为 ''，2 处混合态只剥离「关闭」前缀/后缀保留其余按钮，1 处动态
 *      foot 现场核实本就无裸「关闭」）；新增 `#siBatchFoot:empty{display:none}` 防空 foot 留白横条。
 *      范围明确限定在 #siBatchOverlay——通用 `.si-modal` 小确认弹窗（#siModalBox）与
 *      #siFlowGuideBox/#siDutyRosterBox 不动。
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

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// 取单条 CSS 规则的声明体——selector 后紧跟可选空白再接 `{`，到下一个 `}` 闭合（CSS 规则不嵌套，
// 非贪婪匹配够用）。`\{` 紧邻严格匹配是关键：避免 `.si-modal` 误命中 `.si-modal.wide{}`／
// `.si-modal-head` 误命中 `.si-modal-head .si-close{}` 这类复合/后代选择器的同前缀规则。
function extractCssRule(source, selector) {
    const re = new RegExp(escapeRegex(selector) + '\\s*\\{([^}]*)\\}');
    const m = re.exec(source);
    return m ? m[1] : null;
}

// 取单个具名函数体（同 verify-sys-release-panel-static.js 既有 extractFunctionBody 范式，
// balanced-brace 提取，避免跨函数误判；async 前缀不影响匹配）。
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

// [Opus 预筛提示-5] siBatchFoot 赋值语句提取——原 `([^;]*);` 正则遇到 RHS 内**字符串字面量中的
// 分号**（例如未来某处 foot 塞进 inline style="...;..." 或复合 onclick="a();b()" 这类内部含分号的
// HTML 片段）会在第一个分号处截断，得到"看起来正常、实则被腰斩"的半截字符串——后续"不应含关闭"
// 这类否定式断言在半截字符串上极易假绿（真正的"关闭"字样恰好落在被截掉的后半段）。改成真正做
// 字符串边界感知的语句级提取：从赋值 `=` 后开始逐字符扫描，遇到未转义的引号/反引号进入/退出字符串
// 态，只有在**非字符串态**下遇到的分号才算语句结束（闭合哨兵：`nextIndex` 若跑到 body 末尾仍未见
// 真分号，调用方应从返回值判定提取失败，而非静默拿到一个跑飞的超长字符串）。
function extractFootAssignRHS(source, fromIndex) {
    const marker = "getElementById('siBatchFoot').innerHTML";
    const idx = source.indexOf(marker, fromIndex || 0);
    if (idx < 0) return null;
    const eqIdx = source.indexOf('=', idx + marker.length);
    if (eqIdx < 0) return null;
    let i = eqIdx + 1;
    while (i < source.length && /\s/.test(source[i])) i++;
    const start = i;
    let quote = null;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (quote) {
            if (ch === '\\') { i++; continue; }
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
        if (ch === ';') break;
    }
    if (i >= source.length) return null; // 闭合哨兵：未在字符串外找到真分号，提取失败，不返回跑飞结果
    return { rhs: source.slice(start, i), nextIndex: i + 1 };
}
// 同一函数体内可能有多处 siBatchFoot 赋值（如 siRenderDeleteAuditListBody 的空态/正常态两分支）——
// 从头到尾逐个找完。
function extractAllFootAssignRHS(source) {
    const out = [];
    let from = 0;
    for (;;) {
        const found = extractFootAssignRHS(source, from);
        if (!found) break;
        out.push(found.rhs);
        from = found.nextIndex;
    }
    return out;
}
// 取"锚点文本之后第一个 `{...}` 平衡块"——用于在函数体内部再定位一层子块（如
// `if (!siAuditItems.length) { ... }` 这个空态分支），复用 extractFunctionBody 同款计数闭合思路。
function extractBracedBlockAfter(source, anchorText) {
    const anchorIdx = source.indexOf(anchorText);
    if (anchorIdx < 0) return null;
    const braceStart = source.indexOf('{', anchorIdx);
    if (braceStart < 0) return null;
    let depth = 0, i = braceStart;
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') { depth--; if (depth === 0) return source.slice(braceStart, i + 1); }
    }
    return null;
}

// 取单个 DOM 块——按 id 定位起始 `<div ...id="xxx"...>` 标签，balanced `<div>`/`</div>` 计数取到
// 闭合。结构锚：不依赖行号，容器内部嵌套多少层 div 都能正确闭合（本文件四容器验证专用）。
function extractDomBlockById(source, id) {
    const openRe = new RegExp(`<div\\b[^>]*\\bid="${id}"[^>]*>`);
    const m = openRe.exec(source);
    if (!m) return null;
    const start = m.index;
    let depth = 1;
    const tokenRe = /<div\b[^>]*>|<\/div>/g;
    tokenRe.lastIndex = m.index + m[0].length;
    let tok;
    while ((tok = tokenRe.exec(source))) {
        if (tok[0].charAt(1) === '/') {
            depth--;
            if (depth === 0) return source.slice(start, tok.index + tok[0].length);
        } else {
            depth++;
        }
    }
    return null;
}

// [codex 477 回卷 MED-1，codex 477 复审 MED-2 降级措辞] 「哪些弹层比 #siBatchOverlay 高层」不满足于
// 守卫另抄一份清单去核对页面里的 JS 数组（那样就是拦截-5 同款"抄一份退化成永真守卫"），改为从真实
// CSS z-index 声明动态推导，拿页面 JS 里的枚举清单跟这份推导结果比对。
// ⚠️ [MED-2 措辞澄清] extractZIndexMap/findIdsWithClass 是**已知形态的正则哨兵**，不是完整的
// CSS/HTML 解析器——不宣称"穷举了页面里所有可能高于 #siBatchOverlay 的层叠场景"。已知不覆盖的形态
// 包括但不限于：内联 style="z-index:..."、JS 运行期动态设置的 z-index、CSS 变量间接引用
// （z-index: var(--x)）、`class` 属性用 classList.add 动态拼接而非静态字面量写在标签上。这份哨兵能
// 抓住"新增一条静态 CSS 规则的弹层却忘了登记"这一类最常见的疏漏，抓不住上述四类边缘写法——
// SI_HIGHER_OVERLAYS_THAN_BATCH 这份显式注册表（Sys_Iteration.html :7772 一带）才是 Esc 路由与本
// 守卫共同消费的唯一权威源，哨兵只是给这份注册表的"有没有跟上"上一道尽力而为的复核，不是它的替代。
function extractZIndexMap(source) {
    const re = /([.#][\w-]+(?::hover)?)\s*\{[^}]*?z-index:\s*(\d+)/g;
    const map = {};
    let m;
    while ((m = re.exec(source))) map[m[1]] = Number(m[2]);
    return map;
}
function findIdsWithClass(source, className) {
    // [codex 477 复审 MED-2 泛化] 原正则写死 <div\b...class="..."（双引号、仅 div 标签）——泛化为
    // 任意标签名（\w+）+ 单双引号属性值兼容，减少"换了个标签/换了引号风格就测不出"的窄面。
    // ⚠️ 仍不能用 `\b${className}\b` 做"整词匹配"——连字符不算 \w，"si-img-lightbox" 在
    // "si-img-lightbox-caption" 里两侧都能命中 \b（word→非 word 的字符转换即成立边界，不代表真的是
    // 独立 token），会把标题 caption 的 id 误判成"带 si-img-lightbox 类"。改为按空白切分 class
    // 属性值后做精确数组成员匹配，杜绝这类前缀误伤。
    const re = /<(\w+)\b[^>]*\bclass=(["'])([^"']*)\2[^>]*>/g;
    const ids = [];
    let m;
    while ((m = re.exec(source))) {
        const classes = m[3].split(/\s+/);
        if (!classes.includes(className)) continue;
        const idm = /\bid=(["'])([\w-]+)\1/.exec(m[0]);
        if (idm) ids.push(idm[2]);
    }
    return ids;
}
// [HIGH 收口结构锚复用，自查修正] 最初版本用"单一锚点文本 + lastIndexOf 反查监听器起点"——踩了自己的
// 坑：siCloseLightbox(null) 这类调用在全文出现不止一次（drawer 关闭时顺带关 lightbox 的旁支调用也长
// 这样），indexOf 抓到的可能是**不属于任何 keydown 监听器**的旁支调用，lastIndexOf 反查出来的是完全
// 无关的另一个监听器（如 headMenu 的），断言在错误的 body 上找不到 preventDefault 而误判红。
// 改为：扫全文所有 `document.addEventListener('keydown', ...)` 注册点，每个都取出自己的完整函数体，
// 挑出**同时包含全部指定子串**的那一个——用"这个监听器体内必须同时出现 A 和 B"的组合特征做过滤，
// 不依赖任何单一子串的"全文第一个/最后一个出现位置"这种脆弱假设。
function findKeydownHandlerMatching(source, mustIncludeAll) {
    const re = /document\.addEventListener\('keydown',/g;
    let m;
    while ((m = re.exec(source))) {
        const braceStart = source.indexOf('{', m.index);
        if (braceStart < 0) continue;
        let depth = 0, i = braceStart;
        for (; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') { depth--; if (depth === 0) break; }
        }
        const body = source.slice(braceStart, i + 1);
        if (mustIncludeAll.every((s) => body.includes(s))) return body;
    }
    return null;
}

console.log('— §① .si-modal 三段固定布局容器规则 —');
check('.si-modal 含 display:flex ∧ flex-direction:column ∧ overflow:hidden，不含 overflow-y:auto（红：忘删旧 overflow-y:auto，或漏加三属性任一）', () => {
    const rule = extractCssRule(src, '.si-modal');
    assert.ok(rule, '未找到 .si-modal 规则声明体');
    assert.ok(/display:\s*flex/.test(rule), '缺 display:flex');
    assert.ok(/flex-direction:\s*column/.test(rule), '缺 flex-direction:column');
    assert.ok(/overflow:\s*hidden/.test(rule), '缺 overflow:hidden');
    assert.ok(!/overflow-y:\s*auto/.test(rule), '不应再含 overflow-y:auto（整体滚动的旧写法必须被顶层 overflow:hidden 取代，否则外层仍可能滚动，双滚动条重现）');
});

console.log('— §② .si-modal-body/.si-modal-head/.si-modal-foot 三段角色规则 —');
check('.si-modal-body 含 flex:1 ∧ overflow-y:auto ∧ min-height:0（红：min-height:0 被漏加/删掉——flex 子项默认 min-height:auto，body 会被内容撑破容器导致滚动完全失效，是本组最关键一条）', () => {
    const rule = extractCssRule(src, '.si-modal-body');
    assert.ok(rule, '未找到 .si-modal-body 规则声明体');
    assert.ok(/flex:\s*1\b/.test(rule), '缺 flex:1');
    assert.ok(/overflow-y:\s*auto/.test(rule), '缺 overflow-y:auto');
    assert.ok(/min-height:\s*0\b/.test(rule), '缺 min-height:0');
});
check('.si-modal-head / .si-modal-foot 均含 flex-shrink:0（红：任一被漏加——不固定会被压缩，头尾撑高或裁切）', () => {
    const headRule = extractCssRule(src, '.si-modal-head');
    const footRule = extractCssRule(src, '.si-modal-foot');
    assert.ok(headRule, '未找到 .si-modal-head 规则声明体');
    assert.ok(footRule, '未找到 .si-modal-foot 规则声明体');
    assert.ok(/flex-shrink:\s*0/.test(headRule), '.si-modal-head 缺 flex-shrink:0');
    assert.ok(/flex-shrink:\s*0/.test(footRule), '.si-modal-foot 缺 flex-shrink:0');
});

console.log('— §③ 四容器 DOM 结构（head+body 齐全；foot 按方案 §2.2 既定分工存在/不存在）—');
const CONTAINERS = [
    { id: 'siModalBox', hasFoot: true },
    // [观察反馈优化批 R7] siBatchBox 专属 expected 覆盖——四段（close-bar 独立成第一个子元素）；
    //   其余三容器 DOM 未动，走下方默认的 hasFoot 推导，不受影响。
    { id: 'siBatchBox', hasFoot: true, expected: ['si-close-bar', 'si-modal-head', 'si-modal-body', 'si-modal-foot'] },
    { id: 'siFlowGuideBox', hasFoot: false },
    { id: 'siDutyRosterBox', hasFoot: false },
];
// [codex 469 MED-2] includes 子串存在性证不了"是直接子"——head/body 被包进额外容器（三段 flex 角色
//   错位）或嵌套内容里出现同名前缀时守卫照绿。升级为直接子解析：扫描容器第一层子 <div> 的 class
//   token，断言角色各恰一次且顺序 head→body(→foot)。
function directChildDivClasses(block) {
    const openEnd = block.indexOf('>') + 1;
    const tokenRe = /<div\b[^>]*>|<\/div>/g;
    tokenRe.lastIndex = openEnd;
    let depth = 1, tok;
    const out = [];
    while ((tok = tokenRe.exec(block))) {
        if (tok[0].charAt(1) === '/') { depth--; if (depth === 0) break; }
        else {
            if (depth === 1) {
                const cm = /class="([^"]*)"/.exec(tok[0]);
                out.push(cm ? cm[1].split(/\s+/) : []);
            }
            depth++;
        }
    }
    return out;
}
// ⭐ [codex 475 回卷 MED-2] 原判据用 find() 只取每个直接子的"第一个"角色 token，存在真实可构造的
//   漏检面：某个直接子同时带 si-modal-body 与 si-modal-foot 两个 class，且另有一个独立元素也正确带
//   si-modal-foot——find() 只报出该子的第一个 token（si-modal-body），序列仍与 expected 逐位相等
//   （旧判据完全看不出这个子"多余地"还带着一个不该有的 si-modal-foot），总直接子数也与 expected.length
//   吻合（3=3），两条既有断言（序列 deepStrictEqual + 总数 strictEqual）同时被绕过、双双判绿。
//   修法：逐子收集**全部**角色 token（非 find() 取一个），先断言总数、再断言每子恰带 1 个角色 token
//   （0 个=额外无角色直接子；≥2 个=双角色同元素，均在这一步直接判红，不必等到序列比对），最后才对
//   "确认每子恰一个角色"后取出的序列做 deepStrictEqual。三件套抽成独立函数，主检查与下方两组变异
//   自证复用同一份实现（防止"检查代码"与"被检查代码"各写一份、后续漂移出两套不同判据）。
// [观察反馈优化批 R7] 追加 si-close-bar——#siBatchBox 新增的第 4 段直接子角色（仅该容器有，其余
//   三容器 DOM 未变，本 token 在它们身上天然不出现，不影响既有判定）。
const ROLE_TOKENS = ['si-close-bar', 'si-modal-head', 'si-modal-body', 'si-modal-foot'];
function assertDirectChildRoles(kids, expected, label) {
    assert.strictEqual(kids.length, expected.length,
        `${label}: 直接子 div 总数应恰 ${expected.length}（全部承担三段角色），实得 ${kids.length}——多出的会成为额外 flex 子项`);
    const roles = kids.map((ts, idx) => {
        const matched = ts.filter((t) => ROLE_TOKENS.includes(t));
        assert.strictEqual(matched.length, 1,
            `${label}: 第 ${idx + 1} 个直接子应恰带 1 个三段角色 token（head/body/foot 之一），实得 ${matched.length} 个：${JSON.stringify(matched)}（该子全部 class=${JSON.stringify(ts)}）——0 个＝额外无角色直接子；≥2 个＝双角色同元素`);
        return matched[0];
    });
    assert.deepStrictEqual(roles, expected,
        `${label}: 直接子角色序列应恰为 ${JSON.stringify(expected)}，实得 ${JSON.stringify(roles)}`);
}
for (const c of CONTAINERS) {
    // [观察反馈优化批 R7] expected 优先取容器自带覆盖值（siBatchBox 专属 4 段），否则按 hasFoot 走
    // 原三/二段默认推导——其余三容器行为与改造前逐字节一致。
    const expected = c.expected || (c.hasFoot ? ['si-modal-head', 'si-modal-body', 'si-modal-foot'] : ['si-modal-head', 'si-modal-body']);
    check(`#${c.id} 直接子 div 的角色 token 各恰一次且顺序 ${expected.join('→')}（红：角色缺失/重复/双角色同元素/额外无角色直接子/被包进额外容器层/顺序错——codex 469 MED-2 起底子结构层级问题 + codex 475 回卷 MED-2 补齐"每子恰一个角色"这道更细的闸）`, () => {
        const block = extractDomBlockById(src, c.id);
        assert.ok(block, `未找到 #${c.id} 的 DOM 块`);
        const kids = directChildDivClasses(block);
        assertDirectChildRoles(kids, expected, `#${c.id}`);
        if (!c.hasFoot) assert.ok(!block.includes('si-modal-foot'), `#${c.id} 全块不应含 si-modal-foot（方案 §2.2 明确无 foot）`);
    });
}

console.log('— §③b（codex 475 回卷 MED-2）直接子角色断言变异自证——双角色同元素/额外无角色直接子 均须判红 —');
// 变异恒只在内存构造 HTML 片段喂解析函数（directChildDivClasses），不写入仓内文件——与上方主检查
// 共用同一份 assertDirectChildRoles 实现，证明的是"新判据真的能拦住这两类旧判据漏检的畸形结构"，
// 而不是另起一套自证自的假象。
check('变异①：直接子同时带 si-modal-body 与 si-modal-foot（另有一个独立元素正确带 si-modal-foot）——旧 find() 判据对此场景会静默放行（序列恰好仍等于 expected、总数也恰好相等），新判据须判红', () => {
    const htmlFragment = `<div id="fixtureDualRole">
        <div class="si-modal-head">HEAD</div>
        <div class="si-modal-body si-modal-foot">BODY 违规兼带 si-modal-foot class</div>
        <div class="si-modal-foot">真正的 FOOT</div>
    </div>`;
    const kids = directChildDivClasses(htmlFragment);
    assert.throws(() => assertDirectChildRoles(kids, ['si-modal-head', 'si-modal-body', 'si-modal-foot'], '变异①'),
        /应恰带 1 个三段角色 token/,
        '双角色同元素场景经 directChildDivClasses 解析后未被新判据拦下（红：应报"第 2 个直接子应恰带 1 个角色 token，实得 2 个"）');
});
check('变异②：head/body/foot 三个合法元素之外多一个无角色 decoy 直接子——新判据须判红', () => {
    const htmlFragment = `<div id="fixtureExtraChild">
        <div class="si-modal-head">HEAD</div>
        <div class="si-modal-body">BODY</div>
        <div class="decoy">额外无角色直接子</div>
        <div class="si-modal-foot">FOOT</div>
    </div>`;
    const kids = directChildDivClasses(htmlFragment);
    assert.throws(() => assertDirectChildRoles(kids, ['si-modal-head', 'si-modal-body', 'si-modal-foot'], '变异②'),
        /直接子 div 总数应恰/,
        '额外无角色直接子场景经 directChildDivClasses 解析后未被新判据拦下（红：应报"直接子 div 总数应恰 3，实得 4"）');
});
check('对照组：三个合法角色各恰一次、无额外直接子——新判据应正常通过（证明新判据不是"逢喂必红"，只拦真正畸形的结构）', () => {
    const htmlFragment = `<div id="fixtureWellFormed">
        <div class="si-modal-head">HEAD</div>
        <div class="si-modal-body">BODY</div>
        <div class="si-modal-foot">FOOT</div>
    </div>`;
    const kids = directChildDivClasses(htmlFragment);
    assert.doesNotThrow(() => assertDirectChildRoles(kids, ['si-modal-head', 'si-modal-body', 'si-modal-foot'], '对照组'),
        '结构良好的片段不应被新判据误判红（正例基线）');
});

console.log('— §④ #siBatchBox 尺寸覆盖规则不得静默绕开①的 flex 滚动模型 —');
check('#siBatchBox { width:...; max-height:... } 不声明自己的 overflow（红：有人往这条 id 规则里加了 overflow，会覆盖 .si-modal 的 overflow:hidden——本容器承载「上线单管理/详情/删除审计/上线日志」四大高频视图，最需要三段滚动生效）', () => {
    const rule = extractCssRule(src, '#siBatchBox');
    assert.ok(rule, '未找到 #siBatchBox 规则声明体');
    assert.ok(!/overflow/.test(rule), `#siBatchBox 规则不应声明 overflow，实际：${rule}`);
    assert.ok(/width:\s*clamp\(720px,\s*78vw,\s*1280px\)/.test(rule), '#siBatchBox 宽度覆盖值被改动——不在本 commit 范围，不应顺手改');
    assert.ok(/max-height:\s*92vh/.test(rule), '#siBatchBox max-height 覆盖值被改动——不在本 commit 范围，不应顺手改');
});

console.log('— §⑤ #siFlowGuideBox 内联样式原样保留（449 已复核背书"冗余但不冲突"）—');
check('#siFlowGuideBox 外层内联仍含 display:flex;flex-direction:column（与 class 新增值冗余但不冲突，方案明文允许保留原样）', () => {
    const block = extractDomBlockById(src, 'siFlowGuideBox');
    assert.ok(block, '未找到 #siFlowGuideBox 的 DOM 块');
    const openTagMatch = block.match(/^<div\b[^>]*>/);
    assert.ok(openTagMatch, '未取到 #siFlowGuideBox 开标签');
    const openTag = openTagMatch[0];
    assert.ok(/display:\s*flex/.test(openTag) && /flex-direction:\s*column/.test(openTag), '#siFlowGuideBox 开标签内联样式应仍含 display:flex;flex-direction:column');
});
check('#siFlowGuideBox 的 body 内联仍含 overflow:hidden（红：被误删——内联优先级更高，删掉会让 iframe 容器改走 class 新语义 overflow-y:auto，与 iframe 自身滚动机制叠加出双滚动条）', () => {
    const block = extractDomBlockById(src, 'siFlowGuideBox');
    const bodyMatch = block.match(/<div class="si-modal-body"[^>]*>/);
    assert.ok(bodyMatch, '未找到 #siFlowGuideBox 内的 .si-modal-body 开标签');
    assert.ok(/overflow:\s*hidden/.test(bodyMatch[0]), '#siFlowGuideBox 的 .si-modal-body 开标签应仍含内联 overflow:hidden');
});

console.log('— §⑥ 内层 6 处固定高度滚动区改造（按函数结构锚定位，非行号——契约 §3.3 硬约束）—');
const INNER_SCROLL_REGIONS = [
    { fn: 'siCollaboratorPickerHtml', px: 150, label: '开发成员多选（受理/建单等场景复用）' },
    { fn: 'siModalReassign', px: 180, label: '改派开发成员' },
    { fn: 'siModalCreateChat', px: 150, label: '拉群候选成员' },
    { fn: 'siOpenEtaStats', px: 220, label: '期望对表统计未达标示例' },
    { fn: 'siExecutorPickerRender', px: 320, label: '执行人选人弹窗' },
    { fn: 'siModalAddToBatch', px: 320, label: '加入上线单候选列表' },
];
for (const r of INNER_SCROLL_REGIONS) {
    check(`${r.fn}()「${r.label}」已改 max-height:min(${r.px}px,45vh) 且 overscroll-behavior:contain 在**同一 style 属性串**内（红：漏改／px 原值被动／两属性被拆到不同元素——codex 469 LOW-1：函数体内独立搜两词时"旧滚动区遗留+无关元素带 contain"会假绿，同串绑定后拆散即红）`, () => {
        const body = extractFunctionBody(src, r.fn);
        assert.ok(body, `未提取到 ${r.fn} 函数体`);
        // [S7 预筛 P6] matchAll 全匹配断言（exec 只取首个——同函数体两个同 px 滚动区只有第一个带
        //   contain 时会假绿）。
        const styleRe = new RegExp(`style="[^"]*max-height:\\s*min\\(${r.px}px\\s*,\\s*45vh\\)[^"]*"`, 'g');
        const sms = [...body.matchAll(styleRe)];
        assert.ok(sms.length >= 1, `${r.fn} 函数体内未找到含 max-height:min(${r.px}px,45vh) 的 style 属性串`);
        for (const sm of sms) {
            assert.ok(/overscroll-behavior:\s*contain/.test(sm[0]), `${r.fn} 的某个 style 串含 min(${r.px}px,45vh) 但缺 overscroll-behavior:contain（两属性必须绑在同一元素上·全部匹配逐个断言）`);
        }
    });
}

console.log('— §⑦ 范围边界：2 处不在 §5 改动点清单内的 max-height 区域保持原样未被误覆盖 —');
check('.si-tl-release-json pre（静态 CSS 选择器，非本 commit 改动点）仍是裸 max-height:150px，未被套用 min()/overscroll-behavior（红：未来若有人图省事把 45vh 处理批量套用到全文 max-height，会误伤此处）', () => {
    const rule = extractCssRule(src, '.si-tl-release-json pre');
    assert.ok(rule, '未找到 .si-tl-release-json pre 规则声明体');
    assert.ok(/max-height:\s*150px/.test(rule), '.si-tl-release-json pre 应仍是裸 max-height:150px');
    assert.ok(!/max-height:\s*min\(/.test(rule), '.si-tl-release-json pre 不应被误套用 min()（不在本 commit §5 改动点清单内）');
});
check('siOpenDeleteAuditDetail() 内联 max-height:240px（JSON pre 展示区，非本 commit 改动点）保持原样', () => {
    const body = extractFunctionBody(src, 'siOpenDeleteAuditDetail');
    assert.ok(body, '未提取到 siOpenDeleteAuditDetail 函数体');
    assert.ok(/max-height:\s*240px/.test(body), 'siOpenDeleteAuditDetail 函数体内应仍含裸 max-height:240px');
    assert.ok(!/max-height:\s*min\(240px/.test(body), 'siOpenDeleteAuditDetail 不应被误套用 min()（不在本 commit §5 改动点清单内）');
});

// ═══ [S6 预筛提示 5/6/7 补强] 总量断言 + 规则唯一性 + body 对称 contain ═══
check('总量断言：max-height:min( 全文恰 6 处（红：第 7 处清单外被批量套用——逐点清单护不住清单外·pattern_sweep 族）', () => {
    const n = (src.match(/max-height:\s*min\(/g) || []).length;
    assert.strictEqual(n, 6, `max-height:min( 应恰 6 处，实得 ${n}`);
});
check('总量断言：overscroll-behavior 全文恰 7 处（六内层 + .si-modal-body 对称收口；红：漏加或多加）', () => {
    const n = (src.match(/overscroll-behavior/g) || []).length;
    assert.strictEqual(n, 7, `overscroll-behavior 应恰 7 处，实得 ${n}`);
});
check('规则唯一性：.si-modal{ / .si-modal-body{ / #siBatchBox{ 各恰 1 条（红：后段出现第二条同名规则=双实现静默覆盖·extractCssRule 只取首个匹配拦不住）', () => {
    for (const sel of ['.si-modal ', '.si-modal-body ', '#siBatchBox ']) {
        const re = new RegExp(sel.trim().replace(/[.#]/g, '\\$&') + '\\s*\\{', 'g');
        const n = (src.match(re) || []).length;
        assert.strictEqual(n, 1, `规则 ${sel.trim()}{ 应恰 1 条，实得 ${n}`);
    }
});
check('.si-modal-body 含 overscroll-behavior:contain（对称收口：body 滚到底不穿透背后页面——本页不锁页面滚动，六内层已 contain 而外层 body 缺失=不对称）', () => {
    const rule = extractCssRule(src, '.si-modal-body');
    assert.ok(rule && /overscroll-behavior:\s*contain/.test(rule), '.si-modal-body 规则应含 overscroll-behavior:contain');
});

// ═══ [R-C2·O2 改造 2] head 动作位 #siBatchHeadActions + 「+ 新建上线单」上移 ═══
console.log('— §⑧（R-C2）#siBatchBox head DOM 新增 #siBatchHeadActions（结构锚定位，非行号）—');
check('#siBatchBox head DOM：标题 span（#siBatchHead）在动作位 span（#siBatchHeadActions）之前，且 head 内不再含任何关闭按钮（[观察反馈优化批 R7] X 已移出 head、独立成 .si-close-bar 行——红：顺序错乱，或关闭按钮被误留在 head 内造成"两个关闭入口"）', () => {
    const block = extractDomBlockById(src, 'siBatchBox');
    assert.ok(block, '未找到 #siBatchBox 的 DOM 块');
    const headMatch = block.match(/<div class="si-modal-head">([\s\S]*?)<\/div>/);
    assert.ok(headMatch, '未找到 #siBatchBox 内的 .si-modal-head 开合标签');
    const headHtml = headMatch[1];
    const titleIdx = headHtml.indexOf('id="siBatchHead"');
    const actionsIdx = headHtml.indexOf('id="siBatchHeadActions"');
    assert.ok(titleIdx >= 0, '未找到 #siBatchHead 标题 span');
    assert.ok(actionsIdx >= 0, '未找到 #siBatchHeadActions 动作位 span');
    assert.ok(titleIdx < actionsIdx, `顺序应为 标题→动作位，实际 offset：标题=${titleIdx}／动作位=${actionsIdx}`);
    assert.ok(!/si-close/.test(headHtml), `head 内不应再含任何关闭按钮（si-close/si-close-handle 字样），实际 head 内容：${headHtml}`);
});
check('[观察反馈优化批 R7] #siBatchBox 的 .si-close-bar 内恰含 1 个 .si-close-handle 按钮且 onclick=siCloseBatch()（顺序前置已由 §③ 直接子角色序列钉住，本条钉按钮内容本身——红：按钮丢失/多余/事件绑错）', () => {
    const block = extractDomBlockById(src, 'siBatchBox');
    assert.ok(block, '未找到 #siBatchBox 的 DOM 块');
    const closeBarMatch = block.match(/<div class="si-close-bar">([\s\S]*?)<\/div>/);
    assert.ok(closeBarMatch, '未找到 .si-close-bar 开合标签');
    const btnMatches = closeBarMatch[1].match(/<button\b[^>]*class="si-close-handle"[^>]*>/g) || [];
    assert.strictEqual(btnMatches.length, 1, `.si-close-bar 内应恰含 1 个 .si-close-handle 按钮，实得 ${btnMatches.length}`);
    assert.ok(/onclick="siCloseBatch\(\)"/.test(btnMatches[0]), '.si-close-handle 按钮应绑定 onclick="siCloseBatch()"');
});
check('[Opus 预筛拦截-2] .si-close-handle 按钮含 type="button" ∧ aria-label="关闭"（同页 #siMHead/#siFlowGuideBox/#siDutyRosterBox 三同类关闭按钮均有——本批删掉 6 个带文字的「关闭」按钮后，close-handle 是唯一关闭出口，无障碍名缺失=可访问性净退化）', () => {
    const block = extractDomBlockById(src, 'siBatchBox');
    assert.ok(block, '未找到 #siBatchBox 的 DOM 块');
    const closeBarMatch = block.match(/<div class="si-close-bar">([\s\S]*?)<\/div>/);
    assert.ok(closeBarMatch, '未找到 .si-close-bar 开合标签');
    const btnMatches = closeBarMatch[1].match(/<button\b[^>]*class="si-close-handle"[^>]*>/g) || [];
    assert.strictEqual(btnMatches.length, 1, '.si-close-bar 内应恰含 1 个 .si-close-handle 按钮');
    assert.ok(/\btype="button"/.test(btnMatches[0]), `.si-close-handle 按钮缺 type="button"，实际标签：${btnMatches[0]}`);
    assert.ok(/aria-label="关闭"/.test(btnMatches[0]), `.si-close-handle 按钮缺 aria-label="关闭"，实际标签：${btnMatches[0]}`);
});
check('#siBatchHead 规则含 min-width:0 ∧ overflow:hidden ∧ text-overflow:ellipsis ∧ white-space:nowrap（红：任一缺失——长单号标题 "上线单 "+release_no 会把动作位/关闭按钮一起撑出可视区，449-M3 明文与视口宽度无关，1280 档同样可复现）', () => {
    const rule = extractCssRule(src, '#siBatchHead');
    assert.ok(rule, '未找到 #siBatchHead 规则声明体');
    assert.ok(/min-width:\s*0\b/.test(rule), '缺 min-width:0');
    assert.ok(/overflow:\s*hidden/.test(rule), '缺 overflow:hidden');
    assert.ok(/text-overflow:\s*ellipsis/.test(rule), '缺 text-overflow:ellipsis');
    assert.ok(/white-space:\s*nowrap/.test(rule), '缺 white-space:nowrap');
});
check('#siBatchHeadActions 规则含 flex-shrink:0（红：动作位被压缩，按钮可能被挤出可视区或裁切——449-M3 明文"动作位 flex-shrink:0"）', () => {
    const rule = extractCssRule(src, '#siBatchHeadActions');
    assert.ok(rule, '未找到 #siBatchHeadActions 规则声明体');
    assert.ok(/flex-shrink:\s*0/.test(rule), '缺 flex-shrink:0');
});

console.log('— §⑨（R-C2）六函数各自无条件清空 #siBatchHeadActions（结构锚：extractFunctionBody 逐函数体内查字面量，非行号）—');
const HEAD_ACTIONS_CLEAR_RE = /getElementById\('siBatchHeadActions'\)\.innerHTML\s*=\s*'';/;
const HEAD_ACTIONS_OWNER_FNS = ['siRenderBatchList', 'siOpenDeleteAudit', 'siRenderDeleteAuditListBody', 'siOpenDeleteAuditDetail', 'siOpenReleaseLog', 'siOpenBatchDetail'];
for (const fn of HEAD_ACTIONS_OWNER_FNS) {
    check(`${fn}() 函数体内含无条件清空语句 getElementById('siBatchHeadActions').innerHTML=''（红：漏加——共享 DOM 槽会把上一视图的按钮残留带进本视图）`, () => {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        assert.ok(HEAD_ACTIONS_CLEAR_RE.test(body), `${fn} 函数体内未找到清空语句`);
    });
}
check('值班排班（siOpenDutyRoster/siLoadDutyRoster）不消费 #siBatchHeadActions（反向排除：方案明文"值班排班不在此列"——它渲染进 #siDutyRosterBox，不复用批次面板共享 DOM）', () => {
    for (const fn of ['siOpenDutyRoster', 'siLoadDutyRoster']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        assert.ok(!body.includes('siBatchHeadActions'), `${fn} 函数体不应引用 siBatchHeadActions`);
    }
});
check('总量断言：getElementById(\'siBatchHeadActions\').innerHTML = \'\'; 全文恰 6 处（红：第 7 处清单外新增消费者，或六函数中某一处被漏改——逐点清单护不住清单外，pattern_sweep 族同款纪律）', () => {
    const re = /getElementById\('siBatchHeadActions'\)\.innerHTML\s*=\s*'';/g;
    const n = (src.match(re) || []).length;
    assert.strictEqual(n, 6, `清空语句应恰 6 处，实得 ${n}`);
});

console.log('— §⑩（R-C2）「+ 新建上线单」从 foot 上移到 head 动作位 —');
check('siRenderBatchList：「+ 新建上线单」渲染进 #siBatchHeadActions 且受 isAdmin() 门控（红：按钮脱离 isAdmin() 判断，或未渲染进动作位——对接人不应看到会必然 403 的死按钮）', () => {
    const body = extractFunctionBody(src, 'siRenderBatchList');
    assert.ok(body, '未提取到 siRenderBatchList 函数体');
    const guardedRe = /if\s*\(\s*isAdmin\(\)\s*\)\s*document\.getElementById\('siBatchHeadActions'\)\.innerHTML\s*=\s*'<button class="u-btn-primary" onclick="siModalCreateBatch\(\)">\+ 新建上线单<\/button>';/;
    assert.ok(guardedRe.test(body), '未找到「isAdmin() 门控 + 渲染进 siBatchHeadActions」的完整语句');
});
check('siRenderBatchList：foot 渲染串不再含 siModalCreateBatch（红：按钮头尾各留一份，重复渲染）', () => {
    const body = extractFunctionBody(src, 'siRenderBatchList');
    assert.ok(body, '未提取到 siRenderBatchList 函数体');
    // [Opus 预筛提示-5] 改用字符串边界感知的 extractFootAssignRHS（原 `[^;]*` 正则遇 RHS 内字符串
    //   字面量中的分号会截断腰斩，见该函数定义处注释）。
    const found = extractFootAssignRHS(body);
    assert.ok(found, '未找到 siBatchFoot 赋值');
    assert.ok(!found.rhs.includes('siModalCreateBatch'), `foot 渲染串不应再含 siModalCreateBatch，实际：${found.rhs}`);
});
check('全文「+ 新建上线单」onclick 调用点恰 1 处（红：头尾各留一份重复渲染）', () => {
    const n = (src.match(/onclick="siModalCreateBatch\(\)"/g) || []).length;
    assert.strictEqual(n, 1, `onclick="siModalCreateBatch()" 应恰 1 处，实得 ${n}`);
});
check('449-M1：空态文案改「点右上角「新建上线单」」，旧组合文案零残留（[S7 预筛 P3] 负断言收窄为组合词——全文级"右下角"负断言会被未来无关文案假红）', () => {
    assert.ok(src.includes('点右上角「新建上线单」'), '未找到新空态文案「点右上角「新建上线单」」');
    assert.ok(!src.includes('点右下角「新建上线单」'), '旧空态组合文案「点右下角「新建上线单」」仍有残留');
});
// [S7 预筛 P1] 六函数清空必须在函数体首个 await 之前的同步段——siOpenBatchDetail 曾把清空放在
//   await 之后，列表→详情加载窗口内旧动作位滞留可点，"无条件清空"的注释与守卫措辞在该处不成立。
check('六入口函数的动作位清空语句均位于各自函数体首个 await 之前（红：清空被挪到 await 后=加载窗口内旧按钮滞留可点）', () => {
    const CLEAR = "getElementById('siBatchHeadActions').innerHTML = '';";
    for (const fn of ['siRenderBatchList', 'siOpenDeleteAudit', 'siRenderDeleteAuditListBody', 'siOpenDeleteAuditDetail', 'siOpenReleaseLog', 'siOpenBatchDetail']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        // ⚠️ 剥离先行（guard gotchas 第 7 坑·codex 470 LOW 扩展）——行注释/块注释/单双引号字符串/
        //   模板串里的"await"字样都会被 \bawait\b 误当代码命中（本断言首版就被自己的说明注释击中过）。
        //   简版词法顺序剥离（AST 不引入=守卫家族范式）；剥引号串会把清空语句里的 'siBatchHeadActions'
        //   一并挖空，故 CLEAR 定位用剥引号前的中间态、await 定位用全剥后终态，两个 index 在同一坐标系
        //   ——替换为等长占位（非删除）保持偏移不变。
        const blank = (s) => s.replace(/[^\n]/g, ' ');
        const noComments = body.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
        const codeOnly = noComments; // 同值别名保留语义命名：CLEAR 定位须在剥引号前的中间态（剥了会挖空字面量）
        const noStrings = noComments
            .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
            .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
            .replace(/`(?:[^`\\]|\\.)*`/g, blank);
        const clearIdx = codeOnly.indexOf(CLEAR);
        assert.ok(clearIdx >= 0, `${fn} 内未找到清空语句`);
        const awaitIdx = noStrings.search(/\bawait\b/);
        // [S8 预筛 P2] 应有 await 的函数写死清单——剥离误伤真 await 时 awaitIdx=-1 会让位置断言被静默
        //   跳过（假绿方向），清单让"该有却没找到"红在这里。同步函数（零 await）不在清单。
        const MUST_HAVE_AWAIT = ['siRenderBatchList', 'siOpenDeleteAuditDetail', 'siOpenReleaseLog', 'siOpenBatchDetail'];
        if (MUST_HAVE_AWAIT.includes(fn)) {
            assert.ok(awaitIdx >= 0, `${fn} 应含至少一个真 await（实测清单·剥离若误伤真 await 会在此红而非静默跳过位置断言）`);
        }
        if (awaitIdx >= 0) {
            assert.ok(clearIdx < awaitIdx, `${fn} 的清空语句（@${clearIdx}）应在首个 await（@${awaitIdx}）之前`);
        }
    }
});

// ═══ [R-C3·O1] 加单候选列表所属系统徽章 .u-sys-tag ═══
console.log('— §⑪（R-C3）O1 加单候选列表「所属系统」徽章 —');
check('.u-sys-tag 规则声明体存在于 Sys_Iteration.html 页面内 <style>，含 D1 拍板的中性 slate 三色值（background:#f1f5f9 ∧ color:#475569 ∧ border 含 #e2e8f0）∧ white-space:nowrap（红：色值被改成分系统配色，或 nowrap 被漏加导致 449-L1"客户报销平台"撑挤重现）', () => {
    const rule = extractCssRule(src, '.u-sys-tag');
    assert.ok(rule, '未找到 .u-sys-tag 规则声明体');
    assert.ok(/background:\s*#f1f5f9/.test(rule), '缺 background:#f1f5f9（D1 中性 slate 底色）');
    assert.ok(/color:\s*#475569/.test(rule), '缺 color:#475569（D1 中性 slate 字色）');
    assert.ok(/border:[^;]*#e2e8f0/.test(rule), '缺 border 含 #e2e8f0（D1 中性 slate 边色）');
    assert.ok(/white-space:\s*nowrap/.test(rule), '缺 white-space:nowrap（449-L1：长系统名「小程序-智荟人力」（现最长·7 个汉字加 1 个连字符共 8 字符）防撑挤）');
});
check('.u-sys-tag 不出现在共享 components.css（红：被误挪进共享层——O1 明文"落页面内 <style>，免 ?v= bump 与四页回归"，误挪会让本页与另三页产生非预期共享耦合）', () => {
    const componentsCssPath = path.join(__dirname, '..', 'public', 'assets', 'css', 'components.css');
    const componentsSrc = fs.readFileSync(componentsCssPath, 'utf8');
    assert.ok(!componentsSrc.includes('.u-sys-tag'), 'components.css 不应包含 .u-sys-tag（应仅存在于 Sys_Iteration.html 页面内 <style>）');
});
check('siModalAddToBatch 候选行模板：system_name 假值不渲染空徽章（红：改成恒渲染或用 `|| ""` 之类总会产出 <span> 外壳的写法——空系统名的单会显示一个空徽章）', () => {
    const body = extractFunctionBody(src, 'siModalAddToBatch');
    assert.ok(body, '未提取到 siModalAddToBatch 函数体');
    // [观察反馈优化批 R7] 七色分色变体后 class 属性多了条件片段 ${sysCls ? ' '+sysCls : ''}——
    //   条件渲染判据本体（i.system_name ? ... : ''）不变，只放宽 class 属性内部的精确匹配。
    assert.ok(/i\.system_name\s*\?\s*`?\s*<span class="u-sys-tag\$\{sysCls/.test(body), '未找到 "i.system_name ? ... <span class=\\"u-sys-tag${sysCls" 条件渲染写法');
});
check('siModalAddToBatch 候选行模板：.u-sys-tag 徽章值经 esc() 转义（红：改成裸拼接 ${i.system_name}——虽值域受后端 BIZ_SYSTEMS 七值白名单约束，前端仍不信任后端数据形态，须走既有转义惯例）', () => {
    const body = extractFunctionBody(src, 'siModalAddToBatch');
    assert.ok(body, '未提取到 siModalAddToBatch 函数体');
    assert.ok(/<span class="u-sys-tag\$\{sysCls[^}]*\}">\$\{esc\(i\.system_name\)\}<\/span>/.test(body), '未找到 "<span class=\\"u-sys-tag${sysCls...}\\">${esc(i.system_name)}</span>" 转义写法');
});

console.log('— §⑪b（观察反馈优化批 R7）所属系统徽章七色映射——demo V1 拍板值 —');
const EXPECTED_SYS_TAG_CLASSES = ['u-sys-tag-bms', 'u-sys-tag-hrd', 'u-sys-tag-esign', 'u-sys-tag-reimb', 'u-sys-tag-rpa', 'u-sys-tag-miniapp', 'u-sys-tag-other'];
// [Opus 预筛拦截-5] SI_SYS_TAG_CLASS 是前端对 BIZ_SYSTEMS 的硬编码副本——若守卫只自证"页面内这份
//   映射表内部自洽"（7 组键值、类名互不相同），对不上真正的权威源，退化成永真守卫：BIZ_SYSTEMS 改了
//   （历史已发生三次：新增「电子签」「RPA程序」「小程序-智荟人力」、移除「OA」「智数协同」），前端这份副本忘改，三套
//   守卫（本文件+RELMG-+MPPW-）全绿却漏了新系统的徽章配色。判定源同源：直接 require 后端 transitions.js
//   （纯常量模块，无 DB/Express 依赖，同 verify-sys-c11 的判定源同源纪律）取真正的 BIZ_SYSTEMS。
const { BIZ_SYSTEMS } = require(path.join(__dirname, '..', 'routes', 'sys-iteration', 'transitions'));
// [Opus 预筛提示-9] SI_SYS_TAG_CLASS 已改用 Object.freeze(...) 包裹（对齐 SI_EXEC_SUMMARY_CLS 等
//   同页同款映射表写法）——正则须跟着认 `Object.freeze({` 这一层，否则匹配不到声明体。
function extractSiSysTagClassEntries() {
    const m = src.match(/const SI_SYS_TAG_CLASS = Object\.freeze\(\{([\s\S]*?)\}\);/);
    assert.ok(m, '未找到 SI_SYS_TAG_CLASS 映射表定义（含 Object.freeze 包裹）');
    return [...m[1].matchAll(/'([^']+)':\s*'(u-sys-tag-[a-z]+)'/g)].map((e) => [e[1], e[2]]);
}
check('SI_SYS_TAG_CLASS 映射表恰含 7 组键值，映射到 7 个互不相同的 u-sys-tag-* 变体类名，且 key 集合与真正的后端 BIZ_SYSTEMS 逐一相等（红：漏配/多配/多键映射同一类名导致视觉混淆；或前端副本与 BIZ_SYSTEMS 权威源脱节——判定源同源，非自证自的另一份清单）', () => {
    const entries = extractSiSysTagClassEntries();
    assert.strictEqual(entries.length, 7, `SI_SYS_TAG_CLASS 应恰 7 组键值，实得 ${entries.length}`);
    const keys = entries.map((e) => e[0]);
    const classNames = entries.map((e) => e[1]);
    assert.strictEqual(new Set(classNames).size, 7, `7 个类名应互不相同，实得去重后 ${new Set(classNames).size} 个：${JSON.stringify(classNames)}`);
    for (const cls of EXPECTED_SYS_TAG_CLASSES) assert.ok(classNames.includes(cls), `缺少类名 ${cls}`);
    assert.ok(Array.isArray(BIZ_SYSTEMS) && BIZ_SYSTEMS.length >= 2, 'BIZ_SYSTEMS 应为非空数组（判定源同源自检——同 verify-sys-c11 A4 同款前置断言）');
    const keySet = new Set(keys), bizSet = new Set(BIZ_SYSTEMS);
    assert.strictEqual(keySet.size, bizSet.size, `SI_SYS_TAG_CLASS key 数（${keySet.size}）应与 BIZ_SYSTEMS 数（${bizSet.size}）相等——实得 SI_SYS_TAG_CLASS keys=${JSON.stringify(keys)}／BIZ_SYSTEMS=${JSON.stringify(BIZ_SYSTEMS)}`);
    for (const sys of BIZ_SYSTEMS) assert.ok(keySet.has(sys), `BIZ_SYSTEMS 的「${sys}」未在 SI_SYS_TAG_CLASS 登记（前端副本落后于后端权威源）`);
    for (const k of keys) assert.ok(bizSet.has(k), `SI_SYS_TAG_CLASS 的「${k}」不在 BIZ_SYSTEMS 内（前端多配了一个后端已不承认的系统）`);
});
// [Opus 预筛提示-4] 配对断言——上面的集合成员校验证不出"key→class 被两两对调"：把 BMS 的类名和
//   HRD 的类名互换，keys 集合仍是那 7 个、classNames 集合仍是那 7 个，两条既有断言原样通过。必须
//   逐对 deepStrictEqual 才能钉死配对本身。七对顺序取当前 demo V1 拍板的书写顺序（非 BIZ_SYSTEMS
//   数组顺序——两者本可不同序，这里只钉"页面内这份声明的书写顺序不能变"，不重复造一次顺序无关判据）。
const EXPECTED_SYS_TAG_PAIRS = [
    ['BMS', 'u-sys-tag-bms'], ['HRD', 'u-sys-tag-hrd'], ['电子签', 'u-sys-tag-esign'],
    ['客户报销平台', 'u-sys-tag-reimb'], ['RPA程序', 'u-sys-tag-rpa'], ['小程序-智荟人力', 'u-sys-tag-miniapp'], ['其他', 'u-sys-tag-other'],
];
check('SI_SYS_TAG_CLASS 七对 key→class 精确配对（红：任意两个系统的类名被对调——keys 集合和 classNames 集合各自仍然齐全，只有逐对 deepStrictEqual 才能抓出，纯集合校验对此类缺陷视而不见）', () => {
    const entries = extractSiSysTagClassEntries();
    assert.deepStrictEqual(entries, EXPECTED_SYS_TAG_PAIRS, `七对 key→class 应逐对精确匹配 ${JSON.stringify(EXPECTED_SYS_TAG_PAIRS)}，实得 ${JSON.stringify(entries)}`);
});
check('SI_SYS_TAG_CLASS 声明已用 Object.freeze 包裹（对齐同页 SI_TYPE_CLASS/SI_EXEC_SUMMARY_CLS 等同款「class 片段 gate」映射表写法，红：漏包会让本表在运行期可被意外改写）', () => {
    assert.ok(/const SI_SYS_TAG_CLASS = Object\.freeze\(\{/.test(src), '未找到 "const SI_SYS_TAG_CLASS = Object.freeze({" 声明形态');
});
check('siSysTagClass() 走同 siTypeClass 同款「class 片段 gate」范式：hasOwnProperty 命中返回映射类名，未命中 warnBadgeOnce 一次性告警后返回空串（红：未登记 system_name 会崩溃或静默吞警告——往集合加成员前必须保住既有同构写法，未登记值应降级为无变体而非炸样式）', () => {
    const body = extractFunctionBody(src, 'siSysTagClass');
    assert.ok(body, '未提取到 siSysTagClass 函数体');
    assert.ok(/hasOwnProperty\.call\(SI_SYS_TAG_CLASS,\s*sys\)/.test(body), '未找到 hasOwnProperty.call(SI_SYS_TAG_CLASS, sys) 判据');
    assert.ok(/UnifyHelpers\.warnBadgeOnce\(/.test(body), '未找到 UnifyHelpers.warnBadgeOnce(...) 告警调用');
    assert.ok(/return\s+'';/.test(body), "未找到兜底 return ''（未登记值应静默降级为无变体，非崩溃/非伪造）");
});
check('七条 .u-sys-tag-* CSS 规则各自存在且 background 色值互不相同（红：某两个系统被误配成同一色值，用户将无法用颜色区分系统）', () => {
    const rules = EXPECTED_SYS_TAG_CLASSES.map((cls) => extractCssRule(src, '.' + cls));
    rules.forEach((r, i) => assert.ok(r, `未找到 .${EXPECTED_SYS_TAG_CLASSES[i]} 规则声明体`));
    // [Opus 预筛拦截-4] 原判据直接 `(r.match(...) || [])[1]` 塞进 Set——若某条规则 background 提取
    //   失败（正则不匹配），结果为 undefined，恰好可能与"其余 6 个互不相同的真色值"凑成 size=7 而
    //   静默放行，自蔽成"7 个互不相同"（实际是 6 真值 + 1 个 undefined）。改为先逐条断言捕获成功，
    //   捕获失败必须在这里就单独判红，不允许流入 Set 计数掩盖。
    const bgs = rules.map((r, i) => {
        const m = r.match(/background:\s*(#[0-9a-fA-F]+)/);
        assert.ok(m, `.${EXPECTED_SYS_TAG_CLASSES[i]} 规则未能提取到 background 色值（正则不匹配——须先修复提取本身，非"色值恰好重复"）`);
        return m[1];
    });
    const bgSet = new Set(bgs);
    assert.strictEqual(bgSet.size, 7, `7 条规则的 background 色值应互不相同，实得去重后 ${bgSet.size} 个：${JSON.stringify(bgs)}`);
});
check('siModalAddToBatch 候选行模板：标题改包 .si-chk-text（既有 flex:1;min-width:0 范式）作为行内唯一可收缩项（红：标题退回裸文本拼接——checkbox/编号/类型标签/系统徽章均定宽 nowrap，新增系统徽章后若标题不可收缩会撑破候选行）', () => {
    const body = extractFunctionBody(src, 'siModalAddToBatch');
    assert.ok(body, '未提取到 siModalAddToBatch 函数体');
    assert.ok(/<span class="si-chk-text">\$\{esc\(i\.title\)\}<\/span>/.test(body), '未找到 "<span class=\\"si-chk-text\\">${esc(i.title)}</span>" 包裹写法');
});
check('siModalAddToBatch 候选行模板：${sysTag} 真的被插进 opts 模板段且位置早于标题（[S8 预筛 P1/P3+codex 471 LOW-2] 断言限定 const opts = 起的模板段——函数体级 indexOf 会被注释/其他字符串同名字样误判；M1=不插值·M9=顺序对调破坏方案 §3 O1 明文顺序）', () => {
    const body = extractFunctionBody(src, 'siModalAddToBatch');
    assert.ok(body, '未提取到 siModalAddToBatch 函数体');
    const optsStart = body.indexOf('const opts =');
    assert.ok(optsStart >= 0, '未找到 const opts = 模板段起点');
    const optsEnd = body.indexOf(".join('')", optsStart);
    assert.ok(optsEnd > optsStart, "未找到 opts 模板段终点 .join('')");
    const seg = body.slice(optsStart, optsEnd);
    const tagIdx = seg.indexOf('${sysTag}');
    const titleIdx = seg.indexOf('<span class="si-chk-text">');
    assert.ok(tagIdx >= 0, 'opts 模板段中未找到 ${sysTag} 插值——徽章变量算了但没插进模板=功能不生效');
    assert.ok(titleIdx >= 0 && tagIdx < titleIdx, `\${sysTag}（@${tagIdx}）应早于标题 .si-chk-text（@${titleIdx}）——方案 §3 O1 明文顺序`);
    // [codex 471 LOW-1] value 属性走 Number() 强转（输出恒数字/NaN/Infinity 三形态·零属性注入面）
    assert.ok(seg.includes('value="${Number(i.id)}"'), 'checkbox value 应为 ${Number(i.id)} 强转形态（残余属性注入面防御）');
});

// ═══ [观察反馈优化批 R7] §⑫ #siBatchOverlay head/close-bar/foot 调优——demo 三轮定稿「X 独立行版」 ═══
console.log('— §⑫（观察反馈优化批 R7）.si-close-bar/.si-close-handle CSS 值 + #siBatchOverlay head padding 覆盖 —');
check('[Opus 预筛提示-7] .si-close-bar/.si-close-handle/.si-close-handle:hover 三条规则均带 #siBatchOverlay 前缀限定，且全文各恰 1 处（红：裸类选择器脱离"只动 #siBatchOverlay 范围"的声称——未来若别处复用同名类会静默共享样式；恰 1 处防止前缀被误删后又留一条裸规则重复声明）', () => {
    assert.ok(src.includes('#siBatchOverlay .si-close-bar {'), '未找到 "#siBatchOverlay .si-close-bar {" 前缀限定形态');
    assert.ok(src.includes('#siBatchOverlay .si-close-handle {'), '未找到 "#siBatchOverlay .si-close-handle {" 前缀限定形态');
    assert.ok(src.includes('#siBatchOverlay .si-close-handle:hover {'), '未找到 "#siBatchOverlay .si-close-handle:hover {" 前缀限定形态');
    for (const sub of ['.si-close-bar {', '.si-close-handle {', '.si-close-handle:hover {']) {
        const n = (src.match(new RegExp(escapeRegex(sub), 'g')) || []).length;
        assert.strictEqual(n, 1, `子串 "${sub}"（含前缀版本的尾部）全文应恰 1 处，实得 ${n}——多出的可能是另一条裸类重复声明`);
    }
});
check('.si-close-bar 规则：display:flex ∧ justify-content:flex-end ∧ padding:8px 22px ∧ flex-shrink:0（demo 定稿值+[Opus 预筛提示-7] 补收缩防御，红：值被改动，或四段里独属 close-bar 缺 flex-shrink:0 导致被 body 内容挤压变形）', () => {
    const rule = extractCssRule(src, '#siBatchOverlay .si-close-bar');
    assert.ok(rule, '未找到 #siBatchOverlay .si-close-bar 规则声明体');
    assert.ok(/display:\s*flex/.test(rule), '缺 display:flex');
    assert.ok(/justify-content:\s*flex-end/.test(rule), '缺 justify-content:flex-end');
    assert.ok(/padding:\s*8px\s+22px/.test(rule), '缺 padding:8px 22px（demo 定稿值）');
    assert.ok(/flex-shrink:\s*0/.test(rule), '缺 flex-shrink:0（四段 close-bar/head/body/foot 里独属它此前没写，对齐 head/foot 已有的收缩防御）');
});
check('.si-close-handle 规则：32×32 可点区域 + hover 态 background:#f5f5f4/color:#57534e（demo 定稿值，红：尺寸/hover 值偏离定稿）', () => {
    const rule = extractCssRule(src, '#siBatchOverlay .si-close-handle');
    const hoverRule = extractCssRule(src, '#siBatchOverlay .si-close-handle:hover');
    assert.ok(rule, '未找到 #siBatchOverlay .si-close-handle 规则声明体');
    assert.ok(/width:\s*32px/.test(rule), '缺 width:32px');
    assert.ok(/height:\s*32px/.test(rule), '缺 height:32px');
    assert.ok(hoverRule, '未找到 #siBatchOverlay .si-close-handle:hover 规则声明体');
    assert.ok(/background:\s*#f5f5f4/.test(hoverRule), 'hover 缺 background:#f5f5f4');
    assert.ok(/color:\s*#57534e/.test(hoverRule), 'hover 缺 color:#57534e');
});
check('#siBatchOverlay .si-modal-head 规则：padding 覆盖为 14px 22px 22px 22px（demo 定稿值，红：head 不再需要为 X 让位后右侧留白值被改动）', () => {
    const rule = extractCssRule(src, '#siBatchOverlay .si-modal-head');
    assert.ok(rule, '未找到 #siBatchOverlay .si-modal-head 规则声明体');
    assert.ok(/padding:\s*14px\s+22px\s+22px\s+22px/.test(rule), '缺 padding:14px 22px 22px 22px（demo 定稿值）');
});
check('#siBatchFoot:empty{display:none} 规则存在（红：空 foot 会留一条空白横条占位——DOM 三段结构本不动，纯靠这条 CSS 隐藏空态）', () => {
    const rule = extractCssRule(src, '#siBatchFoot:empty');
    assert.ok(rule, '未找到 #siBatchFoot:empty 规则声明体');
    assert.ok(/display:\s*none/.test(rule), '#siBatchFoot:empty 应含 display:none');
});

console.log('— §⑫b（观察反馈优化批 R7）siBatchFoot 纯「关闭」按钮全部退场，X 统一收敛到独立 close-bar —');
// [Opus 预筛提示-3] 原"全文「关闭</button>」字面量恰 0 处"一条已删——过宽过脆（任何未来无关处
//   新加一个"关闭"字样的按钮都会被误伤，且与下面逐函数检查不同源：真正判断"这次改造有没有做对"
//   的判据就是下面这几条逐函数核对，全文级弱存在性检查是多余的重复面，删掉不影响覆盖率。
check('siOpenDeleteAuditDetail() foot 只保留「← 返回列表」（红：误删返回列表按钮，或误留紧跟其后的关闭按钮）', () => {
    const body = extractFunctionBody(src, 'siOpenDeleteAuditDetail');
    assert.ok(body, '未提取到 siOpenDeleteAuditDetail 函数体');
    const found = extractFootAssignRHS(body);
    assert.ok(found, '未找到 siBatchFoot 赋值');
    assert.ok(found.rhs.includes('返回列表'), 'foot 渲染串应含"← 返回列表"按钮');
    assert.ok(!found.rhs.includes('关闭'), 'foot 渲染串不应再含"关闭"字样');
});
check('siRenderDeleteAuditListBody() 两处 foot 赋值（空态恒空／正常态视 siAuditNextBeforeId 而定）均不再含「关闭」，且正常态分支保留「加载更多」（红：误留固定关闭前缀，或"加载更多"分支丢失）', () => {
    const body = extractFunctionBody(src, 'siRenderDeleteAuditListBody');
    assert.ok(body, '未提取到 siRenderDeleteAuditListBody 函数体');
    const rhss = extractAllFootAssignRHS(body);
    assert.ok(rhss.length >= 2, `siRenderDeleteAuditListBody 内应至少 2 处 siBatchFoot 赋值（空态+正常态），实得 ${rhss.length}`);
    for (const rhs of rhss) assert.ok(!rhs.includes('关闭'), `foot 渲染串不应再含"关闭"字样，实际：${rhs}`);
    assert.ok(rhss.some((rhs) => rhs.includes('加载更多')), '应有一处 foot 赋值含"加载更多"条件分支');
});
check('siOpenBatchDetail() 动态 foot（变量 foot 拼接）不含任何裸「关闭」按钮——仅含「← 返回」及各条件动作按钮（现场核实结论：该函数本就无裸关闭按钮，本条钉住不被将来误加）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(!/>关闭<\/button>/.test(body), 'siOpenBatchDetail 函数体不应含裸"关闭"按钮');
    assert.ok(body.includes('← 返回'), 'siOpenBatchDetail 的 foot 初值应仍含"← 返回"');
});
check('siOpenDeleteAudit()／siOpenReleaseLog()／siRenderDeleteAuditListBody() 空态分支 三处 foot 赋值均为空串 \'\'（红：仍留旧的关闭按钮字面量。[Opus 预筛提示-6] 标题原声称"三处"但循环只真的验了 siOpenDeleteAudit/siOpenReleaseLog 两处——siRenderDeleteAuditListBody 的空态分支从未在本条被单独核实过；补真验证使标题名副其实，而非仅仅改小标题数字）', () => {
    for (const fn of ['siOpenDeleteAudit', 'siOpenReleaseLog']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        const found = extractFootAssignRHS(body);
        assert.ok(found, `${fn} 未找到 siBatchFoot 赋值`);
        assert.strictEqual(found.rhs.trim(), "''", `${fn} 的 siBatchFoot 赋值应为空串 ''，实际：${found.rhs}`);
    }
    // 第三处：siRenderDeleteAuditListBody 的空态分支——`if (!siAuditItems.length) { ... }` 内部那一条
    // （该函数正常态分支已在上一条 check 里核实过"不含关闭"，这里专门补空态分支"恰为空串"这个更严格的判据）。
    const rdlBody = extractFunctionBody(src, 'siRenderDeleteAuditListBody');
    assert.ok(rdlBody, '未提取到 siRenderDeleteAuditListBody 函数体');
    const emptyBranch = extractBracedBlockAfter(rdlBody, 'if (!siAuditItems.length)');
    assert.ok(emptyBranch, '未找到 siRenderDeleteAuditListBody 的空态分支 if(!siAuditItems.length){...}');
    const foundEmpty = extractFootAssignRHS(emptyBranch);
    assert.ok(foundEmpty, '空态分支内未找到 siBatchFoot 赋值');
    assert.strictEqual(foundEmpty.rhs.trim(), "''", `siRenderDeleteAuditListBody 空态分支的 siBatchFoot 赋值应为空串 ''，实际：${foundEmpty.rhs}`);
});

console.log('— §⑫c（观察反馈优化批 R7，Opus 预筛提示-8）siBatchFoot 全文 7 处赋值逐处扫描——护 :empty 判据长期成立 —');
check('siBatchFoot 全文赋值恰 7 处；任何一处若是「整段就是一个裸字符串字面量」的形态且内容全为空白，必须是真正的空串 \'\'（非 \' \' 之类的空白填充）——CSS :empty 伪类要求元素零子节点（含零文本节点），哪怕只塞一个空格字符也会让 :empty 匹配失效，foot 空态"整条隐藏"的效果会静默失灵而不报任何错', () => {
    const rhss = extractAllFootAssignRHS(src);
    assert.strictEqual(rhss.length, 7, `siBatchFoot 赋值全文应恰 7 处，实得 ${rhss.length}（红：新增/删除了一个赋值点却未同步更新本清单，或某处赋值语句写法脱离了本文件识别的形态）`);
    for (const rhs of rhss) {
        const trimmed = rhs.trim();
        // 只对"整段就是一个裸字符串字面量"的形态做空白校验——foot += 拼接/三元表达式/变量名（如
        // siOpenBatchDetail 的 `foot`）等复合形态不是"声称为空却留白"的候选，不在此列。
        const litMatch = /^(['"`])([\s\S]*)\1$/.exec(trimmed);
        if (!litMatch) continue;
        const inner = litMatch[2];
        if (inner.trim() === '') {
            assert.strictEqual(inner, '', `发现纯空白非空字符串字面量 ${JSON.stringify(rhs)}——CSS :empty 会因这个空白文本节点失效，必须是真正的 ''`);
        }
    }
});

// ═══ [codex 477 三审终解] §⑬ SI_ESC_ROUTER——集中 Esc 路由器（取代两轮"分散监听器+消费协议"） ═══
console.log('— §⑬（codex 477 三审终解）SI_ESC_ROUTER 集中 Esc 路由器 —');
// [codex 477 三审/四审] 判定源同源——SI_ESC_LAYERS 是 Esc 路由与本守卫共同消费的唯一权威源，不满足
//   于守卫另抄一份清单去对照（同拦截-5/MED-1 一路的纪律）。五项固定顺序（z-index 降序）+ 三字段值级
//   校验。[codex 477 四审 HIGH 收口] siModalOverlay 从"遍历前的单独特判"改为**注册表内的阻塞层**
//   （close:null）——原因见 Sys_Iteration.html :7784 一带注释：特判版本比整个循环都靠前，一旦命中就
//   直接 return，即使 Lightbox（z-3000，比 modal 的 1200 更高）恰好也开着也会被挡在外面判断不到；
//   阻塞层现在只是数组遍历顺序里的普通一项，天然排在 Lightbox 之后，不会再挡住"理应更优先"的层。
const SI_ESC_LAYERS_EXPECTED = [
    { id: 'siImgLightbox', openClass: 'show', close: '() => siCloseLightbox(null)' },
    { id: 'siModalOverlay', openClass: 'open', close: 'null' },
    { id: 'siFlowGuideOverlay', openClass: 'open', close: 'siCloseFlowGuide' },
    { id: 'siDutyRosterOverlay', openClass: 'open', close: 'siCloseDutyRoster' },
    { id: 'siBatchOverlay', openClass: 'open', close: 'siCloseBatch' },
];
function extractSiEscLayersEntries() {
    const m = src.match(/const SI_ESC_LAYERS = \[([\s\S]*?)\n    \];/);
    assert.ok(m, '未找到 SI_ESC_LAYERS 数组声明');
    return [...m[1].matchAll(/\{\s*id:\s*'([\w-]+)',\s*openClass:\s*'(\w+)',\s*close:\s*([^}]+?)\s*\}/g)]
        .map((e) => ({ id: e[1], openClass: e[2], close: e[3].trim() }));
}
check('SI_ESC_LAYERS 数组恰含 5 项，id/openClass/close 三字段逐项精确匹配（顺序即视觉层级 z-index 降序：Lightbox→siModalOverlay(阻塞层)→FlowGuide→DutyRoster→siBatchOverlay，红：漏登记/多登记/字段写错——这份显式注册表是路由器唯一的判据来源，登记错了路由行为直接跟着错）', () => {
    const entries = extractSiEscLayersEntries();
    assert.strictEqual(entries.length, 5, `SI_ESC_LAYERS 应恰 5 项，实得 ${entries.length}：${JSON.stringify(entries)}`);
    assert.deepStrictEqual(entries, SI_ESC_LAYERS_EXPECTED, `五项应逐字段精确匹配 ${JSON.stringify(SI_ESC_LAYERS_EXPECTED)}，实得 ${JSON.stringify(entries)}`);
});
check('siModalOverlay 阻塞层的 close 字段确为字面量 null（非字符串 \'null\'、非某个函数引用）（红：若误写成字符串或函数，"if (layer.close) layer.close()" 的真值判断会走偏——字符串 \'null\' 是 truthy 会被误当函数调用而崩溃，函数引用则会让 modal 被意外关闭，两者都破坏"阻塞不关闭"的语义）', () => {
    const m = src.match(/const SI_ESC_LAYERS = \[([\s\S]*?)\n    \];/);
    assert.ok(m, '未找到 SI_ESC_LAYERS 数组声明');
    assert.ok(/\{\s*id:\s*'siModalOverlay',\s*openClass:\s*'open',\s*close:\s*null\s*\}/.test(m[1]), 'siModalOverlay 条目的 close 字段应为字面量 null（不带引号）');
});
// [结构不变量，非仅硬编码 5 项] 独立于上面"精确匹配已知 5 项"的断言之外，再从真实 CSS z-index 声明
//   动态验证数组书写顺序确实是 z 降序——防止"以后加第 6 层时插错位置"这类上面的硬编码断言测不出的
//   回归（硬编码断言那时也会因数组变成 6 项而失败，但失败原因是"项数不对"，不是"顺序不对"，两种
//   判据分开验证更精确）。siModalOverlay 与 FlowGuide/DutyRoster 同为 z-1200，三者互相之间没有严格
//   大小关系可比（只要求都 ≥ 更低层、≤ 更高层），故用非严格 >= 比较，允许同 z 相邻。
check('SI_ESC_LAYERS 数组书写顺序与五层真实 z-index 值降序一致（红：顺序与实际层叠层级不符——路由器"从上往下找第一个 open 的层"这条核心逻辑依赖数组顺序真实反映视觉层级，顺序错了会关错层/挡错层）', () => {
    const entries = extractSiEscLayersEntries();
    const zMap = extractZIndexMap(src);
    const idToSelector = { siImgLightbox: '.si-img-lightbox', siModalOverlay: '.si-modal-overlay', siFlowGuideOverlay: '.si-modal-overlay', siDutyRosterOverlay: '.si-modal-overlay', siBatchOverlay: '#siBatchOverlay' };
    const zs = entries.map((en) => {
        const sel = idToSelector[en.id];
        assert.ok(sel, `未知 id ${en.id}，本条断言的 idToSelector 映射需要同步更新`);
        const z = zMap[sel];
        assert.ok(Number.isInteger(z), `未能从源码提取 ${sel} 的 z-index 声明`);
        return z;
    });
    for (let i = 1; i < zs.length; i++) {
        assert.ok(zs[i - 1] >= zs[i], `SI_ESC_LAYERS 第 ${i}/${i + 1} 项 z-index 应降序（${entries[i - 1].id}=${zs[i - 1]} 应 ≥ ${entries[i].id}=${zs[i]}），实得升序，顺序有误`);
    }
});
// [codex 477 三审 MED-2 承接，四审后收窄] 措辞维持"已知形态哨兵"——基于静态 CSS 规则文本，不宣称穷举
//   内联 style/JS 动态 z-index/CSS 变量间接引用等边缘写法（见 extractZIndexMap 定义处注释）。
//   [codex 477 四审 HIGH 收口] siModalOverlay 现已正式登记进 SI_ESC_LAYERS（阻塞层），不再是"刻意不
//   登记的例外"——本条不再需要为它单独放行，回归"高于 #siBatchOverlay 的弹层 id 必须全部在数组里"
//   这条更简单直接的不变量。
check('已知形态哨兵：从源码静态 CSS 规则动态提取 z-index 声明——所有能被本哨兵识别到、高于 #siBatchOverlay 的弹层 id，逐一在 SI_ESC_LAYERS 里有登记（红：新增了一条静态 CSS z-index 规则的弹层却没有同步补进数组）', () => {
    const zMap = extractZIndexMap(src);
    const batchZ = zMap['#siBatchOverlay'];
    assert.ok(Number.isInteger(batchZ), '未能从源码提取 #siBatchOverlay 的 z-index 声明（结构锚自检——后续比较基准必须来自真实源码，不能写死 1100）');
    const higherIds = new Set();
    for (const [selector, z] of Object.entries(zMap)) {
        if (z <= batchZ) continue;
        if (selector.startsWith('#')) {
            higherIds.add(selector.slice(1));
        } else if (selector.startsWith('.')) {
            for (const id of findIdsWithClass(src, selector.slice(1))) {
                if (id === 'siBatchOverlay') continue; // 同 class 但有更具体的 #id 规则覆盖了它的 z-index，不算
                higherIds.add(id);
            }
        }
    }
    assert.ok(higherIds.size > 0, '未从源码解析出任何 z-index 高于 #siBatchOverlay 的弹层 id（结构锚自检——若这里意外为 0，说明上面的正则/展开逻辑本身失效了，不代表真的没有高层弹层，需要先修解析本身）');
    const enumerated = new Set(extractSiEscLayersEntries().map((en) => en.id));
    for (const id of higherIds) {
        assert.ok(enumerated.has(id), `发现 z-index 高于 #siBatchOverlay 的弹层 #${id} 未登记进 SI_ESC_LAYERS（新增高层弹层必须同步该数组）`);
    }
});
check('路由器已删除旧版"siModalOverlay 遍历前单独特判"结构（红：若仍残留独立于 for 循环之外的 siModalOverlay 判断，说明 HIGH 收口的重构不彻底，新旧两种处理方式混杂——阻塞层语义现在应完全由数组遍历本身承载）', () => {
    const body = findKeydownHandlerMatching(src, ['SI_ESC_LAYERS']);
    assert.ok(body, '未找到含 SI_ESC_LAYERS 引用的 keydown 监听器（应为路由器本体）');
    const loopIdx = body.indexOf('for (const layer of SI_ESC_LAYERS)');
    assert.ok(loopIdx >= 0, '路由器体内未找到 for (const layer of SI_ESC_LAYERS) 遍历循环');
    const preLoopSegment = body.slice(0, loopIdx);
    assert.ok(!preLoopSegment.includes('siModalOverlay'), `遍历循环之前不应再出现 siModalOverlay 字样（阻塞层应完全交给数组遍历处理，不留旧版前置特判残留），实得循环前内容：${preLoopSegment}`);
});
check('路由器遍历循环：逐项检查 el.classList.contains(layer.openClass)，命中后先 preventDefault() 再按 "if (layer.close) layer.close()" 有条件调用关闭动作（红：写死固定类名——会让 openClass:\'show\' 的 siImgLightbox 判定不到；close() 无条件调用——close:null 的阻塞层（siModalOverlay）命中时会直接崩溃 TypeError，而非"消费不关闭"）', () => {
    const body = findKeydownHandlerMatching(src, ['SI_ESC_LAYERS']);
    assert.ok(body, '未找到路由器本体');
    assert.ok(/classList\.contains\(layer\.openClass\)/.test(body), '未找到 el.classList.contains(layer.openClass) 判据（应逐项取各自的 openClass 字段）');
    assert.ok(/if\s*\(\s*layer\.close\s*\)\s*layer\.close\(\)/.test(body), '未找到 "if (layer.close) layer.close();" 有条件调用形态（阻塞层 close:null 时必须跳过调用，不能无条件 layer.close()）');
    const preventIdx = body.indexOf('e.preventDefault()');
    const condCloseIdx = body.search(/if\s*\(\s*layer\.close\s*\)/);
    assert.ok(preventIdx >= 0 && condCloseIdx >= 0 && preventIdx < condCloseIdx, `e.preventDefault()（@${preventIdx}）应在有条件关闭判断（@${condCloseIdx}）之前——阻塞层命中时同样要消费这次 Esc，即使不产生关闭副作用`);
});
// [codex 477 三审] 路由器是全文**唯一**处理"Esc 关闭弹层"逻辑的 keydown 监听器——负向断言：三个原本
//   各自处理 Esc 的高层关闭函数（siCloseFlowGuide/siCloseDutyRoster/siCloseLightbox）自己的函数体内
//   不应再出现任何 'Escape' 字样（旧监听器若只删了外层 addEventListener 包装、内部逻辑忘了清理干净，
//   或未来有人手滑在这几个函数里"顺手"加回 Escape 判断，本条会红）。
check('siCloseFlowGuide/siCloseDutyRoster/siCloseLightbox 三个关闭函数自身函数体内均不含 \'Escape\' 字样（红：Esc 处理逻辑应完全收敛进路由器，这三个函数只负责"怎么关"不该再各自判断"该不该关"）', () => {
    for (const fn of ['siCloseFlowGuide', 'siCloseDutyRoster', 'siCloseLightbox']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        assert.ok(!body.includes('Escape'), `${fn} 函数体不应再含 'Escape' 字样，实际函数体：${body}`);
    }
});
check('全文 document.addEventListener(\'keydown\', ...) 注册点恰 2 处——路由器 + headMenu 各自独立的一个（红：多于 2 处说明旧的分散监听器有残留没删干净，少于 2 处说明路由器或 headMenu 哪个被误删）', () => {
    const n = (src.match(/document\.addEventListener\('keydown',/g) || []).length;
    assert.strictEqual(n, 2, `document.addEventListener('keydown', ...) 全文应恰 2 处，实得 ${n}`);
});
check('全文不再残留旧版"分散监听器+消费协议"的标识符——SI_HIGHER_OVERLAYS_THAN_BATCH／siAnyHigherOverlayOpen／e.defaultPrevented 三者均应零出现（红：任一残留说明重构不彻底，新旧两套机制混杂）', () => {
    for (const token of ['SI_HIGHER_OVERLAYS_THAN_BATCH', 'siAnyHigherOverlayOpen', 'e.defaultPrevented']) {
        assert.ok(!src.includes(token), `全文不应再出现 "${token}"（旧协议残留）`);
    }
});
// [codex 477 四审 MED-1] FlowGuide/DutyRoster 同 z-1200 互斥——SI_ESC_LAYERS 数组顺序假设"两者结构上
//   不会同时 open"，这条假设必须由运行时机制真正保证，不能只是注释声称。两个打开函数各自显式关闭
//   对方，缺一方向仍能构造出"先开 A 再开 B，A 未被关闭"的路径。
check('siOpenFlowGuide()/siOpenDutyRoster() 各自显式关闭对方，互斥固化为运行时保证（红：任一方向缺失——理论上仍可构造出两者同时 open 的路径，SI_ESC_LAYERS 数组"同 z 互斥"的顺序假设会失真）', () => {
    const flowGuideBody = extractFunctionBody(src, 'siOpenFlowGuide');
    assert.ok(flowGuideBody, '未提取到 siOpenFlowGuide 函数体');
    assert.ok(/siCloseDutyRoster\(\)/.test(flowGuideBody), 'siOpenFlowGuide() 函数体内应调用 siCloseDutyRoster()');
    const dutyRosterBody = extractFunctionBody(src, 'siOpenDutyRoster');
    assert.ok(dutyRosterBody, '未提取到 siOpenDutyRoster 函数体');
    assert.ok(/siCloseFlowGuide\(\)/.test(dutyRosterBody), 'siOpenDutyRoster() 函数体内应调用 siCloseFlowGuide()');
});

// ═══ [codex 477 三审 MED-4] findKeydownHandlerMatching 花括号计数——已知形态哨兵登记 ═══
console.log('— §⑬b（codex 477 三审 MED-4）findKeydownHandlerMatching 花括号计数自测——已知形态哨兵，非完整词法分析 —');
check('[已知限制·登记] 候选监听器体内若有字符串字面量含裸 "{" 字符，深度计数会多算一层"未匹配的开括号"，导致提取结果**越界多吃**（跨过真正的闭合括号，吞进后续无关文本，直到遇到别处一个恰好能抵消的 "}"）——真实探测：构造用例验证具体越界内容，非仅登记结论', () => {
    const src1 = "document.addEventListener('keydown', function (e) {\n" +
        "    const s = 'a{b';\n" +
        "    MARKER_END();\n" +
        "});\n" +
        "AFTER_TAIL_MARKER;\n" +
        "function unrelated() { console.log('x'); }\n";
    const body = findKeydownHandlerMatching(src1, ['MARKER_END']);
    assert.ok(body, '提取不应返回 null');
    assert.ok(body.includes('AFTER_TAIL_MARKER'), `已知限制：字符串内裸 "{" 应导致越界多吃，提取结果应吞进本不属于该监听器的 AFTER_TAIL_MARKER，实得未吞进：${JSON.stringify(body)}`);
});
check('[已知限制·登记] 候选监听器体内若有注释含裸 "}" 字符，深度计数会提前归零，导致提取**提前截断**——截断后的候选体若因此丢失了 mustIncludeAll 要求的子串，本函数会判定"该候选不匹配"继续找下一个 keydown 监听器，最终若无其他候选命中则返回 null（真实探测：构造用例验证确实返回 null，非仅登记结论）', () => {
    const src2 = "document.addEventListener('keydown', function (e) {\n" +
        "    // comment with a stray } here\n" +
        "    MARKER_END2();\n" +
        "});\n" +
        "AFTER_TAIL_MARKER2;\n";
    const body = findKeydownHandlerMatching(src2, ['MARKER_END2']);
    assert.strictEqual(body, null, `已知限制：注释内裸 "}" 应导致提前截断丢失 MARKER_END2，findKeydownHandlerMatching 应返回 null（找不到匹配候选），实得 ${JSON.stringify(body)}`);
});
check('[登记项前提校验+简化锚点] 路由器本体用单一子串 \'SI_ESC_LAYERS\' 即可唯一定位（红：全文该子串若出现在多个 keydown 监听器体内，说明简化锚点的唯一性假设不再成立，需要恢复多子串组合过滤）——路由器收敛后消费面已缩小，不再需要旧版三高层监听器时代的多子串过滤复杂度', () => {
    const re = /document\.addEventListener\('keydown',/g;
    let m, matchCount = 0;
    while ((m = re.exec(src))) {
        const braceStart = src.indexOf('{', m.index);
        if (braceStart < 0) continue;
        let depth = 0, i = braceStart;
        for (; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) break; }
        }
        const body = src.slice(braceStart, i + 1);
        if (body.includes('SI_ESC_LAYERS')) matchCount++;
    }
    assert.strictEqual(matchCount, 1, `全文应恰 1 个 keydown 监听器体内含 'SI_ESC_LAYERS'（路由器本体），实得 ${matchCount}`);
});

// ═══ [codex 477 回卷 LOW] extractFootAssignRHS 复杂 RHS 形态——如实登记当前非 AST 实现的行为边界 ═══
console.log('— §⑫f（codex 477 回卷 LOW）extractFootAssignRHS 复杂 RHS 形态自测——如实登记当前实现行为边界（AST 长期案不做） —');
check('[已知限制·登记] RHS 内若含未剥离的注释且注释体内嵌了分号，会被误判为语句结束而提前截断（本函数不做词法层面的注释剥离——真正修复需要引入完整 JS 词法分析/AST，超出本函数定位，登记为长期项）', () => {
    const src1 = "document.getElementById('siBatchFoot').innerHTML = /* a;b */ 'real value';";
    const found = extractFootAssignRHS(src1);
    assert.ok(found, '提取不应返回 null（哨兵机制仍应找到真分号，只是内容被腰斩）');
    assert.strictEqual(found.rhs, '/* a', `已知限制：注释内的分号被误判为语句终止，实得截断为 ${JSON.stringify(found.rhs)}（非完整 RHS）——本函数今天不处理注释剥离；下方§⑫g 对已提取片段做哨兵扫描（非对原始文本的独立证明），仅登记边界`);
});
check('[已知限制·登记] RHS 内若含正则字面量且斜杠间夹了分号，同样会被误判截断（正则字面量与除法运算符在纯文本层面无法可靠区分，本函数不引入完整词法分析——登记为长期项）', () => {
    const src2 = "document.getElementById('siBatchFoot').innerHTML = /a;b/.test(x) ? 'yes' : 'no';";
    const found = extractFootAssignRHS(src2);
    assert.ok(found, '提取不应返回 null');
    assert.strictEqual(found.rhs, '/a', `已知限制：正则字面量内的分号被误判为语句终止，实得截断为 ${JSON.stringify(found.rhs)}——下方§⑫g 对已提取片段做哨兵扫描（非对原始文本的独立证明），仅登记边界`);
});
check('嵌套模板字面量插值（外层反引号内再嵌一层反引号模板）——本函数按"遇引号字符即切换引号态"处理，本例反引号总数为偶数、开闭奇偶恰好抵消，能拿到完整正确的 RHS；但这是计数奇偶巧合对齐，不是真正理解嵌套语义——不等深/不匹配数量的嵌套仍可能出错，未做穷举，登记为长期项', () => {
    const src3 = "document.getElementById('siBatchFoot').innerHTML = `outer ${arr.map(x => `inner ${x}`).join(';')} tail`;";
    const found = extractFootAssignRHS(src3);
    assert.ok(found, '提取不应返回 null');
    assert.strictEqual(found.rhs, "`outer ${arr.map(x => `inner ${x}`).join(';')} tail`", `本例应完整提取（反引号奇偶巧合对齐），实得 ${JSON.stringify(found.rhs)}`);
});
console.log('— §⑫g（codex 477 回卷 LOW，复审 MED-4 措辞降级）截取段内哨兵——不再声称"真实站点完全不暴露"的完整前提 —');
// [codex 477 复审 MED-4] 原表述"已核实 7 处真实站点均无此形态"过度承诺：这条检查扫描的是
// extractFootAssignRHS **已经处理过的输出**（rhss），不是对原始未处理文本的独立重新解析——如果提取
// 本身在真正的注释/正则标记出现**之前**就已经因为某种未知原因错误截断，rhs 里根本不会包含那个标记，
// 本条检查会对着"看起来干净"的半截字符串判绿，属于自蔽。降级为诚实措辞：本条只是对**已提取片段**
// 做的哨兵扫描，用于在提取结果本身出现可疑片段时尽早报警，不构成"原始语句绝对不含该形态"的完整证明；
// 独立重新解析原始文本需要引入完整词法分析，同 §⑫f 一样登记为长期项不在本次范围。
check('截取段内哨兵：extractAllFootAssignRHS 提取出的 7 段文本本身均不含疑似「裸注释」或「裸正则字面量」的片段（红：提取结果里出现这类片段，说明提取可能已在错误位置截断；本条不证明原始未处理文本一定干净，仅对已提取片段做尽力而为的报警）', () => {
    const rhss = extractAllFootAssignRHS(src);
    assert.strictEqual(rhss.length, 7, `siBatchFoot 赋值应恰 7 处，实得 ${rhss.length}`);
    for (const rhs of rhss) {
        assert.ok(!/\/\*/.test(rhs), `发现疑似块注释片段的 RHS，可能已被 extractFootAssignRHS 腰斩（§⑫f 已知限制形态）：${JSON.stringify(rhs)}`);
        assert.ok(!/\/\//.test(rhs), `发现疑似行注释片段的 RHS，可能已被 extractFootAssignRHS 腰斩（§⑫f 已知限制形态）：${JSON.stringify(rhs)}`);
    }
});

console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
