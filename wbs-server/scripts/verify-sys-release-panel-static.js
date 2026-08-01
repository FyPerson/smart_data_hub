/**
 * verify-sys-release-panel-static.js
 *
 * 上线体统一重构 C7（方案 v3.4 §6.7 明文）：静态源码断言，锁定
 * 「admin 界面必须始终暴露「安排上线」操作，否则应急场景会卡住」这条前端不变量。
 *
 * 用法：node scripts/verify-sys-release-panel-static.js   （纯文本源码扫描，无需启动 server，自包含）
 *
 * 背景：C2b 已把「上线单管理」入口（siOpenBatch）与 META_OK 解耦（若 /sys-issues/meta 加载失败，
 * 应急上线通道不能被连坐锁死），siOpenBatchDetail 内的「安排上线」（siReleaseNotifyExecutor）/
 * 「执行上线」（siReleaseExecuteModal）/「撤销上线安排」（siReleaseCancelScheduleModal）三个动作
 * 同样刻意不挂 META_OK 门。这条不变量此前只在代码注释里承诺，从未有断言钉住——本脚本补上：
 *   ① 「上线单管理」入口按钮的可见性条件不得包含 META_OK
 *   ② siOpenBatchDetail 函数体（含「安排上线」/「执行上线」/「撤销上线安排」三个动作按钮）整体
 *      不得引用 META_OK
 *   ③ 「值班排班」入口同样不挂 META_OK（§6.15 明文"登录即可见"，与①②同一条不变量的另一实例）
 *   ④ 反向边界：META_OK 异常态下**应该**降级的入口（新建迭代单 / 删除审计 / 流程说明；「上线编排」
 *      legacy 面板已于 2026-07-30 随旧家族封禁整体删除，从降级清单转入"删干净"断言组）仍正确挂着
 *      META_OK 门——防止未来有人"为了让①②过"而把 META_OK 从整个文件删掉，那样①②会假绿。
 *   ⑤ HTML 内联 <script> 语法有效（new Function 编译不执行，等价 node -c）
 *
 * 与 Playwright 层分工：本脚本只读源码结构、不起浏览器，验证的是"代码写没写对"；
 * test-sys-release-panel-c2b2-playwright.js（C7 扩展）验证的是"META_OK=false 时页面运行时表现
 * 是否真的如愿"（真浏览器、真 fetch 失败模拟）。两层互补，不是重复覆盖。
 *
 * 【META_OK 异常态边界（本脚本④固化，供人工核对）】
 *   /sys-issues/meta 加载失败（META_OK=false）时：
 *   - 仍可用：「上线单管理」（含内部安排上线/执行上线/撤销上线安排/改期/加单）、「值班排班」、
 *     单据详情页的只读展示区（§1922 附近 `if (!META_OK) box.innerHTML='只读模式…'` 分支——单据的
 *     状态流转动作按钮才降级，不影响上线单体系）
 *   - 降级/隐藏：「+ 新建迭代单」（依赖 typeFlows 判断可建类型）、「🗑️ 删除审计」「📜 上线日志」
 *     （2026-07-31 新增，与删除审计同门槛——均为纯查询功能，非应急路径，容忍随 meta 一起降级）、
 *     「📖 流程说明」（静态说明文档，随 meta 降级不影响写操作）
 *   - 已删除（非降级）：「🚀 上线编排」legacy 面板（2026-07-30 随旧家族 4 端点封禁整体删除）
 *
 * 【2026-07-31 变更】原"四入口"（新建迭代单/删除审计/上线编排[已删]/流程说明）反向降级断言组扩为
 * 五入口，新增「上线日志」与「删除审计」同门槛同断言写法（见下方 §④ 新增 check）。
 *
 * 【2026-08-02 变更·用户裁定二】筛选栏右侧改「[⚙️ 管理▾][+ 新建迭代单]」——上线单管理/值班排班/
 * 上线日志/删除审计/流程说明五个入口从平铺按钮收进「⚙️ 管理」下拉菜单；新建迭代单仍是独立主按钮。
 * ①②③④ 五组断言的 marker 匹配（onclick="siOpenXxx()" 标记文本 + 就近 if 条件）**无需改动就依旧
 * 成立**——onclick 属性值本身逐字保留（下拉的"点菜单项后自动收起"用事件委托实现，不在每个 onclick
 * 里追加 siCloseHeadMenu()，故标记文本没变），各按钮自己的 if 块仍是紧邻自身 marker 的最近 if（哪怕
 * 五个块在函数体内被重新排过序，guardConditionBefore 只认"某个 marker 前最近一个 if"，块内部顺序
 * 互换不影响各自配对关系）。即便如此，新增 §③ 三条**结构性**断言把"这五个入口真的挂在下拉菜单里、
 * 新建迭代单真的没被挪进去、下拉本体真的有'至少一个菜单项才渲染'的门控"这三条 2026-08-02 新增的
 * 结构不变量也钉住——防止未来有人把某个入口从 .u-head-menu-item 挪回裸按钮（或反之）却没人发现。
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

// 取单个具名函数体（从 `function name(...) {` 到与之匹配的右括号）——同 verify-collab-terminal-notify.js
// 既有范式（extractFunctionBody），balanced-brace 提取，避免跨函数误判。
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

// 剥离 // 行注释与 /* */ 块注释（不做完整 JS 词法分析，够用即可——本文件内 META_OK 不会出现在字符串
// 字面量里，注释里提"本区块不挂 META_OK 门"这类说明性文字很常见，必须先剥注释再判"代码里有没有用它"，
// 否则会把"说它没用"误判成"用了它"）。
function stripComments(code) {
    return code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// 找到 marker 之前最近一个 `if (` 的守卫条件文本（从该 `if (` 到与之配对的 `)`，括号深度平衡）。
// 用于精确定位"这个按钮到底被哪个 if 条件控制"，而不是笼统扫整个函数体（那样会把不相关按钮的
// 条件误判为目标按钮的条件，尤其本文件多个按钮共享同一个大函数体）。
function guardConditionBefore(body, marker) {
    const mi = body.indexOf(marker);
    assert.ok(mi >= 0, `未找到标记文本 "${marker}"`);
    const ifIdx = body.lastIndexOf('if (', mi);
    assert.ok(ifIdx >= 0, `"${marker}" 之前未找到 if (`);
    let depth = 0, i = ifIdx + 3; // 指向 '('
    const start = i;
    for (; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')') {
            depth--;
            if (depth === 0) return body.slice(start + 1, i);
        }
    }
    throw new Error(`"${marker}" 的 if 条件未闭合`);
}

console.log('— §① 「上线单管理」入口不挂 META_OK（§6.7）—');
check('siRenderHeadActions 存在', () => {
    assert.ok(src.includes('function siRenderHeadActions()'), '缺 siRenderHeadActions 定义');
});
check('「上线单管理」按钮（siOpenBatch）守卫条件不含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    assert.ok(body, '未提取到 siRenderHeadActions 函数体');
    const cond = guardConditionBefore(body, 'onclick="siOpenBatch()"');
    assert.ok(!cond.includes('META_OK'), `守卫条件含 META_OK：${cond}`);
    // 正向锚点：条件应仍是 admin∨对接人（防止未来把整个 if 删掉变成"无条件可见"这种过度放开，
    // 那不是本条不变量的本意——本意是"不因 meta 加载失败而锁死"，不是"零权限门"）。
    assert.ok(cond.includes('isAdmin()') && cond.includes('isSiIntakeLiaison'), `守卫条件应仍含 admin/对接人判断，实际：${cond}`);
});
check('「值班排班」入口（siOpenDutyRoster）守卫条件不含 META_OK（§6.15 登录即可见，同一不变量另一实例）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenDutyRoster()"');
    assert.ok(!cond.includes('META_OK'), `守卫条件含 META_OK：${cond}`);
});

console.log('— §② siOpenBatchDetail（安排上线/执行上线/撤销上线安排）整体不引用 META_OK —');
check('siOpenBatchDetail 存在且含三个上线动作按钮', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(body.includes('siReleaseNotifyExecutor'), '缺「安排上线」按钮（siReleaseNotifyExecutor）');
    assert.ok(body.includes('siReleaseExecuteModal'), '缺「执行上线」按钮（siReleaseExecuteModal）');
    assert.ok(body.includes('siReleaseCancelScheduleModal'), '缺「撤销上线安排」按钮（siReleaseCancelScheduleModal）');
});
check('siOpenBatchDetail 函数体（剥注释后）不含 META_OK（三个动作按钮及其外层容器函数整体不受 meta 加载成败影响）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    const code = stripComments(body);
    assert.ok(!code.includes('META_OK'), 'siOpenBatchDetail 函数体（代码，非注释）内出现了 META_OK，§6.7 不变量被破坏');
});

console.log('— §③（2026-08-02 用户裁定二新增）「⚙️ 管理」下拉结构不变量 —');
check('五个入口（上线单管理/值班排班/上线日志/删除审计/流程说明）的 onclick 标记均落在 .u-head-menu-item 菜单项模板内', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const markers = ['onclick="siOpenBatch()"', 'onclick="siOpenDutyRoster()"', 'onclick="siOpenReleaseLog()"', 'onclick="siOpenDeleteAudit()"', 'onclick="siOpenFlowGuide()"'];
    for (const marker of markers) {
        const mi = body.indexOf(marker);
        assert.ok(mi >= 0, `未找到标记 "${marker}"`);
        // 就近往前找 u-head-menu-item 类名——五个入口的模板串写法均为
        // `<button ... class="u-head-menu-item" ... onclick="siOpenXxx()">`，class 在 onclick 之前
        // 同一开始标签内，lastIndexOf 能命中同一标签内的类名，不会跨到别的无关标签。
        const classIdx = body.lastIndexOf('u-head-menu-item', mi);
        assert.ok(classIdx >= 0 && mi - classIdx < 120, `"${marker}" 未挂在 .u-head-menu-item 菜单项模板内（疑似被移出下拉菜单）`);
    }
});
check('「+ 新建迭代单」（siOpenCreate）不带 u-head-menu-item 菜单项类名——保持独立主按钮，不进下拉', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const mi = body.indexOf('onclick="siOpenCreate()"');
    assert.ok(mi >= 0, '未找到「新建迭代单」标记');
    const nearBefore = body.slice(Math.max(0, mi - 200), mi);
    assert.ok(!nearBefore.includes('u-head-menu-item'), '「新建迭代单」标记附近出现 u-head-menu-item，疑似被误挪进下拉菜单');
});
check('下拉本体（触发按钮 u-head-menu-trigger + 面板 u-head-menu-list）仅在 menuItems 非空时才拼进 html（"至少一个菜单项可见才渲染"）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const code = stripComments(body);
    assert.ok(/if\s*\(\s*menuItems\s*\)\s*\{/.test(code), '未找到 `if (menuItems) {` 门控——下拉本体应仅在至少一个菜单项存在时才拼进 html');
    assert.ok(code.includes('u-head-menu-trigger') && code.includes('u-head-menu-list'), '下拉触发按钮/面板结构缺失');
});

console.log('— §④ 反向边界：META_OK 异常态下应该降级的入口仍正确挂着门（防守卫被连带误删）—');
check('「+ 新建迭代单」（siOpenCreate）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenCreate()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});
check('「删除审计」（siOpenDeleteAudit）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenDeleteAudit()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});
check('「上线日志」（siOpenReleaseLog，2026-07-31 新增）守卫条件含 META_OK（与「删除审计」同门槛）', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenReleaseLog()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
    assert.ok(cond.includes('isAdmin()'), `期望仍挂 isAdmin() 门，实际条件：${cond}`);
});
// ⭐ [C7 裁定·2026-07-29 → 2026-07-30 终局] C7 曾"隐藏入口保留代码"过渡；2026-07-30 用户裁定旧上线编排
//   家族 4 端点全封（assign-release-dev/reassign-release-dev/notify-release-executor(-batch)），前端面板/
//   弹窗/通知按钮代码整体删除。以下断言锁定"删干净且不被误恢复"——匹配模式取"function 定义/onclick/
//   siApi 调用点"三种形态，注释里的历史提及不误伤。
check('「上线编排」legacy 面板入口不再渲染（onclick 调用点全文零残留）', () => {
    assert.ok(!src.includes('onclick="siOpenReleaseOrch()"'),
        '期望「上线编排」入口已删除（2026-07-30 家族封禁），实际仍在渲染');
});
check('旧编排面板/弹窗/通知按钮函数定义已整体删除', () => {
    for (const fn of ['siOpenReleaseOrch', 'siRenderReleaseOrchPanel', 'siReleaseOrchState',
        'siModalBatchAssignReleaseDev', 'siBatchNotifyReleaseExecutor', 'siModalAssignReleaseDev',
        'siNotifyReleaseExecutorClick']) {
        assert.ok(!src.includes(`function ${fn}(`), `期望 ${fn} 函数定义已删除（2026-07-30 家族封禁），实际仍在`);
    }
});
check('4 个被封端点的前端调用点零残留', () => {
    for (const ep of ["siApi('/sys-issues/assign-release-dev'", "siApi('/sys-issues/reassign-release-dev'",
        "siApi('/sys-issues/notify-release-executor-batch'", "siNotifyManual('notify-release-executor'"]) {
        assert.ok(!src.includes(ep), `期望前端调用点已删（2026-07-30 家族封禁）：${ep}`);
    }
});
check('去注释源码中被封端点路径字面量零残留（防别名/fetch/模板串重新接线，codex 208 LOW-2）', () => {
    // 剥掉 // 与 /* */ 注释后扫描端点路径字面量——上一条只锁 siApi/siNotifyManual 两种既有调用形态，
    // 本条兜"换个包装函数重新接线"的形态（任何可执行调用都绕不开路径字符串本身）。
    // 注意 '/sys-issues/notify-release-executor' 同时覆盖 -batch 前缀；notify-read-status 是另一条路径不受影响。
    const code = stripComments(src);
    for (const lit of ['/sys-issues/assign-release-dev', '/sys-issues/reassign-release-dev', '/sys-issues/notify-release-executor']) {
        assert.ok(!code.includes(lit), `期望去注释源码不含被封端点路径字面量 ${lit}（2026-07-30 家族封禁）`);
    }
    // 复审 risk-1 采纳：单条通知端点路径含 :id 段（/sys-issues/${id}/notify-release-executor），模板串形态
    // 不含上面的连续字面量——补裸 token 扫描兜住。assign/reassign 是无 :id 的固定路径，字面量已覆盖；
    // 且裸 'assign-release-dev' 在通用循环抑制行（meta 条目保留的既定决策）里合法存在，不能同样裸扫。
    assert.ok(!code.includes('notify-release-executor'),
        '期望去注释源码不含裸 token notify-release-executor（含模板串 :id 路径形态，2026-07-30 家族封禁）');
});
check('「流程说明」（siOpenFlowGuide）守卫条件含 META_OK', () => {
    const body = extractFunctionBody(src, 'siRenderHeadActions');
    const cond = guardConditionBefore(body, 'onclick="siOpenFlowGuide()"');
    assert.ok(cond.includes('META_OK'), `期望仍挂 META_OK 门，实际条件：${cond}`);
});

console.log('— §⑤ HTML 内联 <script> 语法有效 —');
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
