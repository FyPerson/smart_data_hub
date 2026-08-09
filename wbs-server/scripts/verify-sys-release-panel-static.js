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
check('siOpenBatchDetail 存在且含三个上线动作按钮（C5 订正：安排上线按钮改名 siReleaseSetExecutorsModal）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    assert.ok(body.includes('siReleaseSetExecutorsModal'), '缺「安排上线」按钮（siReleaseSetExecutorsModal，C5 重写前旧名 siReleaseNotifyExecutor）');
    assert.ok(body.includes('siReleaseExecuteModal'), '缺「确认上线完成」按钮（siReleaseExecuteModal）');
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

console.log('— §⑥（C5·方案 §4.5，预筛 MED-1/L3/L9/L10 订正；决策 7 三修下限 2→1）选人弹窗组件结构（fetch/render 两段·两处复用·无群发·选不足 1 人置灰）—');
check('siExecutorPickerModal（fetch 段）存在，请求 executor-candidates + await 后补 siAuditGen/overlay 双检查（L9），交给 siExecutorPickerRender 渲染', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerModal');
    assert.ok(body, '未提取到 siExecutorPickerModal 函数体');
    assert.ok(body.includes('/sys-releases/executor-candidates'), '未请求候选端点');
    assert.ok(body.includes('siAuditGen'), 'L9：await siApi 后应补 siAuditGen 双检查（同 :4914 一带先例纪律）');
    assert.ok(body.includes('siBatchOverlay'), 'L9：await siApi 后应补 siBatchOverlay 打开态检查');
    assert.ok(body.includes('siExecutorPickerRender'), '未见调用 siExecutorPickerRender 渲染段');
});
check('siExecutorPickerRender（纯渲染段）消费 selected_by_default/skipped_defaults，不发起任何网络请求，不自动调用任何通知端点', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    assert.ok(body, '未提取到 siExecutorPickerRender 函数体');
    assert.ok(body.includes('selected_by_default'), '未消费默认候选（决策 8：排班∪固定默认执行人并集）');
    assert.ok(body.includes('skipped_defaults'), '未展示 skipped_defaults 非阻断提示（v1.4·codex 254-C LOW-3：跳过不静默）');
    const code = stripComments(body);
    assert.ok(!/siApi\(/.test(code), 'siExecutorPickerRender 是纯渲染段，不应自己发请求（候选数据须由调用方传入）');
    assert.ok(!/notify-executor|\/notify['"]/.test(code), 'siExecutorPickerRender 本体不应直接调用任何通知端点（决策 4：选人与发通知是两个独立动作）');
});
check('两处复用：siReleaseSetExecutorsModal（安排上线）经 siExecutorPickerModal、siModalHotfix（应急一键）经自己 fetch 后直调 siExecutorPickerRender——都落到同一份渲染逻辑，不各写一份', () => {
    const setExecBody = extractFunctionBody(src, 'siReleaseSetExecutorsModal');
    assert.ok(setExecBody && setExecBody.includes('siExecutorPickerModal'), 'siReleaseSetExecutorsModal 未复用选人弹窗组件（fetch 段）');
    const hotfixBody = extractFunctionBody(src, 'siModalHotfix');
    assert.ok(hotfixBody, '未提取到 siModalHotfix 函数体');
    assert.ok(hotfixBody.includes('siExecutorPickerRender'), 'siModalHotfix 未复用选人弹窗渲染段（登记清单②：executors[] 需复用同一选人弹窗 UI，MED-1+L3 订正后走渲染段直连，不再经 fetch 段重复请求）');
});
check('siReleaseSetExecutorsModal 确认后只调 PUT executors，不调用任何通知端点（v1.2 修正：确认后 PUT+notify 两步与"无群发按钮"矛盾）', () => {
    const body = extractFunctionBody(src, 'siReleaseSetExecutorsModal');
    const code = stripComments(body);
    assert.ok(/\/executors['"]/.test(code) && /method:\s*'PUT'/.test(code), '未找到 PUT .../executors 调用');
    assert.ok(!code.includes('/notify'), 'siReleaseSetExecutorsModal 不应调用任何 .../notify 端点（决策 4：选人确认绝不自动发送）');
});
check('（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订）选不足 1 人时确认按钮置灰（siExecPickerUpdateHint 操作 siMConfirm.disabled，判据 n<1，下限 2→1）', () => {
    const body = extractFunctionBody(src, 'siExecPickerUpdateHint');
    assert.ok(body, '未提取到 siExecPickerUpdateHint 函数体');
    const code = stripComments(body);
    // 红灯诊断：原判据 `n<2` 钉的是三修前的下限，非实现错——本条随决策 7 三修反转为 `n<1`
    // （[[feedback_test_assertion_self_error]]：断言过时，不是代码坏了）。
    assert.ok(/n\s*<\s*1/.test(code), '未找到"少于 1 人"判据（决策 7 三修：下限 2→1）');
    assert.ok(!/n\s*<\s*2/.test(code), '不应再出现"少于 2 人"判据残留（决策 7 三修应已整体改为 <1，若命中说明改造不完整）');
    assert.ok(code.includes('btn.disabled = true') && code.includes('btn.disabled = false'), '未找到确认按钮置灰/解禁两个分支');
    // v1.3 改口径：不写"前后端各一人"这类承诺了做不到的话术（系统不校验职能组合，决策 3 终局）。
    assert.ok(!src.includes('前后端各一人') && !src.includes('前后端各1人'), '不应出现"前后端各一人"这类过时话术（v1.3 已订正为"至少选择 1 名执行人"，决策 7 三修下限 2→1）');
});
check('312-M1（codex 合并前建议）：siExecPickerUpdateHint 的计数口径与提交收集逻辑完全一致——均先 querySelectorAll(...:checked) 再 filter(!c.disabled)，不能只数 :checked', () => {
    const hintBody = extractFunctionBody(src, 'siExecPickerUpdateHint');
    const hintCode = stripComments(hintBody);
    assert.ok(/querySelectorAll\('\.si-exec-pick-chk:checked'\)[\s\S]{0,80}filter\(c\s*=>\s*!c\.disabled\)/.test(hintCode),
        '未见 siExecPickerUpdateHint 计数处紧邻 querySelectorAll(...:checked) 的 filter(!c.disabled)——门禁判据用的计数须与提交时真正收集到的人数同源，不能各算各的');
    // 双处口径一致：siExecutorPickerRender（提交收集）与 siExecPickerUpdateHint（门禁计数）用的须是
    // 同一个过滤谓词写法（正则字面量逐字比对，防止两处各写一套语义相同但字面不同的过滤条件，日后
    // 其中一处改了过滤逻辑而另一处忘记同步）。
    const renderBody = extractFunctionBody(src, 'siExecutorPickerRender');
    const renderCode = stripComments(renderBody);
    assert.ok(renderCode.includes('filter(c => !c.disabled)') && hintCode.includes('filter(c => !c.disabled)'),
        'siExecutorPickerRender（提交收集）与 siExecPickerUpdateHint（门禁计数）应逐字使用同一过滤谓词 filter(c => !c.disabled)，双处口径锁死一致');
});
check('无资格候选人置灰展示 + 标注原因（R1b：不静默隐藏）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(code.includes('disabled_reason'), '未读取 disabled_reason');
    assert.ok(/disabled\b/.test(code), '未见 disabled 属性拼接（无资格候选应置灰而非从列表移除）');
});
check('309-M2：默认勾选联合判据 u.eligible && defaultSet.has(...)——disabled 行绝不允许同时带 checked（双重防线第一道：渲染层不产出脏 HTML）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(/u\.eligible\s*&&\s*defaultSet\.has\(/.test(code), '未见 u.eligible && defaultSet.has(...) 联合判据——默认勾选不能只看 defaultSet 单一来源，须同时要求候选本身合格');
});
check('309-M2：选人确认收集阶段叠加 !c.disabled 过滤（双重防线第二道：即便渲染层出了脏 HTML，收集这步也兜得住）', () => {
    const body = extractFunctionBody(src, 'siExecutorPickerRender');
    const code = stripComments(body);
    assert.ok(/querySelectorAll\('\.si-exec-pick-chk:checked'\)[\s\S]{0,80}!c\.disabled/.test(code), '未见收集 ids 时紧邻 querySelectorAll(...:checked) 的 !c.disabled 过滤——:checked 选择器本身不排除 disabled 元素，必须显式过滤');
});
console.log('— §⑥b（预筛 MED-1+L3）siModalHotfix 关键序：先取候选后关第 1 步弹窗，再栈外开选人弹窗 —');
check('siModalHotfix：先 await 取候选清单再关第 1 步弹窗（取失败要保留用户已填内容，不能先关弹窗再取）', () => {
    const body = extractFunctionBody(src, 'siModalHotfix');
    assert.ok(body, '未提取到 siModalHotfix 函数体');
    const fetchIdx = body.indexOf("siApi('/sys-releases/executor-candidates'");
    const closeIdx = body.indexOf('siCloseModal()');
    assert.ok(fetchIdx >= 0, '未找到候选清单请求（应先于任何弹窗关闭动作发起）');
    assert.ok(closeIdx >= 0, '未找到 siCloseModal() 调用');
    assert.ok(fetchIdx < closeIdx, `取候选清单应先于关闭第 1 步弹窗，实际候选请求 offset=${fetchIdx}、siCloseModal offset=${closeIdx}`);
});
check('siModalHotfix：关闭第 1 步弹窗后用 setTimeout 栈外打开选人弹窗（避开 siModal 包装器复位覆盖置灰状态）', () => {
    const body = extractFunctionBody(src, 'siModalHotfix');
    const closeIdx = body.indexOf('siCloseModal()');
    const timeoutIdx = body.indexOf('setTimeout(');
    const renderIdx = body.indexOf('siExecutorPickerRender(');
    assert.ok(timeoutIdx >= 0, '未找到 setTimeout 调用');
    assert.ok(closeIdx >= 0 && closeIdx < timeoutIdx, 'setTimeout 应晚于 siCloseModal() 出现');
    assert.ok(renderIdx > timeoutIdx, 'siExecutorPickerRender 应在 setTimeout 回调内部（栈外）调用，不能与 siCloseModal 同步在一个事件循环里打开下一个弹窗');
});

console.log('— §⑦（C5·方案 §4.5）多人执行人区块渲染（none 态契约·done 行防呆·无全部发送按钮）—');
check('siExecutorSectionHtml 存在，none 态显式空态引导（v1.3·M-c：不能落进未知态兜底渲染出必然 404 的按钮）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    assert.ok(body, '未提取到 siExecutorSectionHtml 函数体');
    assert.ok(/summary\s*===\s*'none'/.test(body), "未见对 'none' 态的显式判断");
    assert.ok(body.includes('尚未安排执行人'), '未见 none 态空态引导文案');
});
check('done 行不渲染发送按钮**也不渲染查已读按钮**（v1.3·M-b + 309-M1：确认完成后不再有"通知过程"这回事，固化的 read_at 徽标仍照常显示，但两个操作按钮都不再提供）——!isDone 须分别与 siExecutorRowNotify、siExecutorRowReadStatus 两个按钮调用在各自邻域内（L13：邻域判据而非全函数体裸判，防未来函数体膨胀后两者被拆到互不相关的分支）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    const code = stripComments(body);
    assert.ok(/!isDone[\s\S]{0,400}siExecutorRowNotify/.test(code), '未见 !isDone 条件与 siExecutorRowNotify 按钮调用在 400 字符邻域内——防呆条件应紧邻它守卫的那个按钮，不能隔着老远靠"反正整个函数体里出现过"这种弱判据蒙混过关');
    assert.ok(/!isDone[\s\S]{0,400}siExecutorRowReadStatus/.test(code), '309-M1：未见 !isDone 条件与 siExecutorRowReadStatus 按钮调用在 400 字符邻域内——查已读按钮同样应受 done 行防呆约束，不能只护住发通知按钮');
});
check('执行人区块不含"全部发送/批量发送/一键发送/群发"这类群发入口（决策 4：admin 想什么时候发给谁就点哪一行，行级独立）', () => {
    const body = extractFunctionBody(src, 'siExecutorSectionHtml');
    assert.ok(!body.includes('全部发送') && !body.includes('批量发送') && !body.includes('一键发送') && !body.includes('群发'), '执行人区块不应出现批量/全部/一键/群发这类群发按钮文案');
});
check('行级发通知/查已读均走行级端点（/executors/:userId/notify、/executors/:userId/read-status），不再有批次级 notify-executor 残留', () => {
    const notifyBody = extractFunctionBody(src, 'siExecutorRowNotify');
    const readBody = extractFunctionBody(src, 'siExecutorRowReadStatus');
    assert.ok(notifyBody && /\/executors\/['"]\s*\+\s*userId\s*\+\s*['"]\/notify/.test(notifyBody.replace(/\s+/g, ' ')), 'siExecutorRowNotify 未走行级 .../executors/:userId/notify 端点');
    assert.ok(readBody && /\/executors\/['"]\s*\+\s*userId\s*\+\s*['"]\/read-status/.test(readBody.replace(/\s+/g, ' ')), 'siExecutorRowReadStatus 未走行级 .../executors/:userId/read-status 端点');
});
check('执行人聚合徽标改读 executor_notify_summary（六态·方案 §4.3），批次面板三函数（不含 siOpenReleaseLog）内旧批次级单列 release_assignee_* 零残留', () => {
    // ⚠️ 全文盲扫 release_assignee_ 会误伤——sys_issues 8 列镜像（旧"上线编排"bug 单机制，2026-07-30 已
    // 单独退场，前端仍在 bug 单详情/gate 提示里合法引用其历史留痕，见 :1720/:1824-1858/:2583-2587 一带，
    // 与本批「上线单执行人多选」的批次级 sys_releases.release_assignee_* 是两套完全不同的列/机制，
    // out of C5 scope）。改为只在批次面板函数体内扫，精确对齐本批实际改动范围。
    for (const fn of ['siOpenBatchDetail', 'siRenderBatchList', 'siProbeMyReleasesEntry']) {
        const body = extractFunctionBody(src, fn);
        assert.ok(body, `未提取到 ${fn} 函数体`);
        const code = stripComments(body);
        assert.ok(!code.includes('release_assignee_'), `${fn} 函数体（代码，非注释）仍有 release_assignee_ 前缀字段引用——旧批次级单列已随 C4b H1 退场冻结，C5 应已改读子表/聚合字段`);
    }
    assert.ok(src.includes('executor_notify_summary'), '未见 executor_notify_summary 聚合字段消费');
});
check('siOpenReleaseLog 例外：release_assignee_name 允许作"历史记录"只读展示（预筛 L1 采纳）——非空显示姓名+「（历史记录）」标注，不当作实时权威态使用', () => {
    const body = extractFunctionBody(src, 'siOpenReleaseLog');
    assert.ok(body, '未提取到 siOpenReleaseLog 函数体');
    const code = stripComments(body);
    assert.ok(code.includes('b.release_assignee_name'), 'siOpenReleaseLog 应读取 b.release_assignee_name（L1：非空时按历史记录展示，而非一律隐藏）');
    assert.ok(code.includes('（历史记录）'), '未见「（历史记录）」标注文案——必须明确标注这是历史留痕而非当前权威通知态，防被误读成实时状态');
    // 反向锚点：仍不得出现"待执行"这类实时状态判定使用该字段（那类判定必须走 executor_notify_summary）。
    assert.ok(!/awaitingExec.*release_assignee/.test(code) && !/release_assignee.*awaitingExec/.test(code), 'release_assignee_name 不应被用来判定"待执行"这类实时状态（那属于 executor_notify_summary 的职责）');
});

console.log('— §⑧（C5·方案 §4.5）确认上线弹窗关键渲染条件（最后一人 + 行 id + 并发补救）—');
check('siReleaseExecuteModal 按 pending_count===1 分支最后一人文案与上线说明必填框', () => {
    const body = extractFunctionBody(src, 'siReleaseExecuteModal');
    assert.ok(body, '未提取到 siReleaseExecuteModal 函数体');
    assert.ok(body.includes('isLast'), '未见最后一人判据变量');
    assert.ok(body.includes('pendingCount === 1') || body.includes('pendingCount===1'), '未见 pending_count===1 判据');
    assert.ok(body.includes('你是最后一个确认人'), '未见最后一人二次确认文案');
});
check('execute 请求体带 executor_row_id（取自本人在册行 id，§4.1a 代次语义——不许服务端自己猜一行）', () => {
    const body = extractFunctionBody(src, 'siReleaseExecuteModal');
    const code = stripComments(body);
    assert.ok(/executor_row_id:\s*myRow\.id/.test(code), '未见 executor_row_id: myRow.id——必须显式传本人那一行的行 id，不能让服务端自己查一行（会丢代次保证）');
});
check('收到 RELEASE_NOTE_REQUIRED（并发导致误判非最后一人）时补弹专填说明弹窗重试，不报死错', () => {
    const body = extractFunctionBody(src, 'siReleaseExecuteModal');
    assert.ok(body.includes('RELEASE_NOTE_REQUIRED'), '未见 RELEASE_NOTE_REQUIRED 分支');
    assert.ok(body.includes('siReleaseExecuteRetryNoteModal'), '未见补弹重试弹窗调用');
    const retryBody = extractFunctionBody(src, 'siReleaseExecuteRetryNoteModal');
    assert.ok(retryBody, '未提取到 siReleaseExecuteRetryNoteModal 函数体');
});
check('309-L1：siReleaseExecuteRetryNoteModal 重试请求体必含 executor_row_id（补弹重试链同样要守住 §4.1a 代次语义——不能因为走的是补救分支就漏传行 id）', () => {
    const retryBody = extractFunctionBody(src, 'siReleaseExecuteRetryNoteModal');
    assert.ok(retryBody, '未提取到 siReleaseExecuteRetryNoteModal 函数体');
    const code = stripComments(retryBody);
    assert.ok(/executor_row_id:\s*executorRowId/.test(code), '未见 executor_row_id: executorRowId——补弹重试的请求体同样必须显式带上本人那一行的行 id');
});
check('cancel-schedule 收到 CONFIRM_DISCARD_DONE_REQUIRED 时补弹 done_executor_names 二次确认框，带 confirm_discard_done:true 重试', () => {
    const body = extractFunctionBody(src, 'siReleaseCancelScheduleModal');
    assert.ok(body, '未提取到 siReleaseCancelScheduleModal 函数体');
    assert.ok(body.includes('CONFIRM_DISCARD_DONE_REQUIRED'), '未见 CONFIRM_DISCARD_DONE_REQUIRED 分支');
    assert.ok(body.includes('done_executor_names'), '未见 done_executor_names 消费');
    const discardBody = extractFunctionBody(src, 'siReleaseCancelScheduleDiscardModal');
    assert.ok(discardBody && discardBody.includes('confirm_discard_done: true'), '二次确认弹窗未带 confirm_discard_done:true 重试');
});
check('309-L2：「撤销上线安排」按钮的局部渲染条件自带 planning &&（自洽冗余——即便这段代码将来被挪出外层 if(planning){...} 包裹，也不会在已发布批次上误开这个按钮）', () => {
    const body = extractFunctionBody(src, 'siOpenBatchDetail');
    assert.ok(body, '未提取到 siOpenBatchDetail 函数体');
    const cond = guardConditionBefore(body, 'onclick="siReleaseCancelScheduleModal(${id})"');
    assert.ok(/^\s*planning\s*&&/.test(cond), `「撤销上线安排」按钮局部条件应以 planning && 开头，实际条件：${cond}`);
});

console.log('— §⑨ `?release=` 深链兼容（钉钉通知点进来直达批次详情，方案 §4.5 第4条不变）—');
check('deepRelId 解析后仍调用 siGotoBatchDetail，siGotoBatchDetail 仍调用 siOpenBatchDetail（C5 只重写详情面板内部渲染，不动入口/路由）', () => {
    assert.ok(src.includes('deepRelId'), '未见 ?release= 深链解析变量');
    const gotoBody = extractFunctionBody(src, 'siGotoBatchDetail');
    assert.ok(gotoBody && gotoBody.includes('siOpenBatchDetail'), 'siGotoBatchDetail 未调用 siOpenBatchDetail');
});

console.log('— §⑩ C5 收口：[C5-TODO] 标记全清（僅剩一处历史提及，非真实待办）—');
check('全文（前端 Sys_Iteration.html + 后端 index.js）[C5-TODO] 真实标记数为 0（L12：措辞写实"全文"——原判据只扫了前端，后端也曾有过同款标记，须同扫）', () => {
    // 真实待办标记形如 `// [C5-TODO] ...`（无反引号包裹，位于注释起手处）；历史说明性提及会用反引号
    // 包裹整个词组（`` `[C5-TODO]` ``）以区别于活跃标记，本断言只拦前者。
    const liveTodoRe = /\/\/\s*\[C5-TODO\]/g;
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    const feMatches = [...src.matchAll(liveTodoRe)];
    const beMatches = [...indexJsSrc.matchAll(liveTodoRe)];
    assert.strictEqual(feMatches.length, 0, `Sys_Iteration.html 仍有 ${feMatches.length} 处未清理的活跃 [C5-TODO] 标记`);
    assert.strictEqual(beMatches.length, 0, `routes/sys-iteration/index.js 仍有 ${beMatches.length} 处未清理的活跃 [C5-TODO] 标记`);
});
check('旧死函数/变量（siReleaseNotifyExecutor/siReleaseResendExecutor/siReleaseQueryExecutorRead/siDutyPreviewHtml/siBatchDutyPreview）已整体删除', () => {
    for (const name of ['siReleaseNotifyExecutor', 'siReleaseResendExecutor', 'siReleaseQueryExecutorRead', 'siDutyPreviewHtml']) {
        assert.ok(!src.includes(`function ${name}(`), `期望 ${name} 函数定义已删除（C5 重写），实际仍在`);
    }
    assert.ok(!src.includes('siBatchDutyPreview'), '期望 siBatchDutyPreview 变量/引用已删除（C5：选人已前移到弹窗环节，值班预览机制随之退场）');
});

console.log('— §⑥ C8 风险/优先级双显（方案 v1.7 §9.2 + 2026-08-07 启动门增补）—');
check('列表列头改「优先级/风险」且排序仍绑 priority（下行不参与排序）', () => {
    assert.ok(/data-sort-by="priority">优先级\/风险</.test(src),
        '期望列头文本为「优先级/风险」且 data-sort-by 仍是 priority（双行复用同一列，排序口径不变）');
    assert.ok(!/data-sort-by="risk_level"/.test(src),
        '风险等级不应成为独立可排序列——C8 明确"不加列"（列表已 20+ 列，加列必触发横滚）');
});
check('列表单元格走 siPriRiskCellHtml 双行结构（上=u-pri 徽章 / 下=风险小字）', () => {
    assert.ok(/<td>\$\{siPriRiskCellHtml\(i\)\}<\/td>/.test(src), '列表行的优先级单元格应改调 siPriRiskCellHtml(i)');
    const fn = extractFunctionBody(src, 'siPriRiskCellHtml');
    assert.ok(fn, 'siPriRiskCellHtml 函数体应能被提取（防改名后本组静默失效）');
    // 〔断言同步·2026-08-09〕原断言写死 `class="u-pri ${esc(i.priority)}"`，被**状态徽章统一 v1.142.0**
    //   打红：那一批把三处输出点的 class 片段从 `esc(原值)` 改成白名单 map `siPriClass()`
    //   （Sys_Iteration.html:770-780 有成文理由：esc 防注入，但"产不出规则的 class"它管不着）。
    //   ⇒ 属**断言该改**不是实现错——本断言的原意「复用共享层 .u-pri，不自造样式」现在依然成立，
    //   变的只是 class 片段的来源。顺手把断言**加强**成徽章批的真实不变量：class 片段必须来自
    //   受控 map，可见文本仍是 esc(原值)（该页刻意保留显示原值，见 :772-774 的取舍说明）。
    assert.ok(/class="u-pri \$\{siPriClass\(i\.priority\)\}"/.test(fn), '上行仍是既有 .u-pri 徽章，且 class 片段走 siPriClass 白名单（不再 raw 拼 esc(原值)）');
    assert.ok(/>\$\{esc\(i\.priority\)\}</.test(fn), '可见文本仍用 esc(原值)（脏数据要能被人看见，与 class 规范化是两回事）');
    assert.ok(/si-pri-risk/.test(fn) && /si-risk-line/.test(fn), '应输出 si-pri-risk 容器 + si-risk-line 下行包裹');
    assert.ok(/\.si-pri-risk\s*\{/.test(src) && /\.si-risk-sub\s*\{/.test(src), 'si-pri-risk / si-risk-sub 样式应已定义（否则双行塌成一行）');
});
check('bug 行风险下行留空（不适用≠未定级）；feature/improvement 未定级显示灰字「未定级」', () => {
    const fn = extractFunctionBody(src, 'siPriRiskCellHtml');
    assert.ok(/i\.type === 'feature' \|\| i\.type === 'improvement'/.test(fn),
        '应按 type 门控风险下行（与详情页 risk_level kv 的既有 type 判据同口径）');
    // 不适用分支必须返回"只有徽章"的结构，且不含任何"未定级"文本
    const notApplicableBranch = /if \(!riskApplicable\) return `<div class="si-pri-risk">\$\{pri\}<\/div>`;/.test(fn);
    assert.ok(notApplicableBranch, 'bug/config 分支应只渲染优先级徽章、不追加任何风险文本（留空=结构上无该维度）');
    assert.ok(/si-risk-sub si-muted">未定级</.test(fn), 'feature/improvement 未定级应显示灰字「未定级」（与详情页 kv 逐字同口径）');
});
check('风险等级三级口径常量存在且文案逐字对齐方案 §9.2 末条', () => {
    assert.ok(/const SI_RISK_LEVEL_HELP_TEXT = /.test(src), '应定义 SI_RISK_LEVEL_HELP_TEXT 单一事实源常量');
    // 三级定义逐字断言——这段是业务判定依据，任何"顺手润色"都会让它与方案原文分岔
    const L1 = '一级＝出款相关需求、优化，或实际代码改动涉及出款部分的需求、优化。';
    const L2 = '二级＝影响关键业务流程（立项、开票、结算、领款）无法正常进行的需求。';
    const L3 = '三级＝页面显示优化调整、报表、查询等不影响主要业务流程的需求。';
    for (const [n, txt] of [['一级', L1], ['二级', L2], ['三级', L3]]) {
        assert.ok(src.includes(txt), `SI_RISK_LEVEL_HELP_TEXT 应**逐字**包含${n}定义（方案 v1.7 §9.2 末条原文）：${txt}`);
    }
});
check('问号徽章挂在唯一渲染风险等级选择的表单上（受理弹窗），范式同 SI_PRIORITY_LABEL', () => {
    assert.ok(/const SI_RISK_LEVEL_LABEL = `风险等级 <span class="si-help"[^`]*title="\$\{SI_RISK_LEVEL_HELP_TEXT\}"/.test(src),
        'SI_RISK_LEVEL_LABEL 应照搬 SI_PRIORITY_LABEL 的 si-help + title 范式');
    assert.ok(/aria-label="\$\{SI_RISK_LEVEL_HELP_TEXT\}"/.test(src), '应同时给 aria-label（屏幕阅读器/键盘，同 codex60 L-2 先例）');
    assert.ok(/<label>\$\{SI_RISK_LEVEL_LABEL\}/.test(src), '受理弹窗的风险等级 label 应改用 SI_RISK_LEVEL_LABEL');
    // 全站渲染"风险等级选择"的表单只此一处——若未来新增第二处，本断言会提醒同步挂徽章
    const selectCount = (src.match(/id="f_risk_level"/g) || []).length;
    assert.strictEqual(selectCount, 1, `全站风险等级 select 应恰 1 处（新增第 2 处时须同步挂 SI_RISK_LEVEL_LABEL 徽章），实际 ${selectCount} 处`);
});
check('列表端点 DTO 已含 risk_level 只读字段（前端双行下行的数据源）', () => {
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    assert.ok(/SELECT id, type, status, priority, risk_level, title/.test(indexJsSrc),
        'GET /sys-issues 的列表 SELECT 应含 risk_level——前端 siPriRiskCellHtml 的下行全靠它，字段被摘掉时列表会静默显示成"全部未定级"（不报错、不红，正是最难发现的一类回归）');
    // 只读扩字段：不得因此新增筛选/排序（C8 硬约束）
    assert.ok(!/addEq\('risk_level'/.test(indexJsSrc), 'C8 是纯展示扩字段，不应新增 risk_level 筛选');
});
check('详情页基本信息块补优先级 kv（与风险等级 kv 并排）', () => {
    // 〔断言同步·2026-08-09〕同上：class 片段随状态徽章统一 v1.142.0 改走 siPriClass 白名单。
    assert.ok(/<label>优先级<\/label><div class="v"><span class="u-pri \$\{siPriClass\(iss\.priority\)\}" title="\$\{SI_PRIORITY_HELP_TEXT\}"/.test(src),
        '基本信息 kv 应含优先级项，徽章复用 .u-pri（class 走 siPriClass 白名单）且 title 复用既有 SI_PRIORITY_HELP_TEXT（不新增文案副本）');
});
check('MED-4：详情页工期 kv 移出 needs_feasibility 条件，改按 type 适用面', () => {
    assert.ok(/const effortApplicableType = \(iss\.type === 'feature' \|\| iss\.type === 'improvement'\)/.test(src),
        '工期 kv 应先按 type 适用面门控（nf 两值都可能有工期：nf=1 走评估弹窗、nf=0 走估时弹窗）');
    assert.ok(/\$\{effortKv\}/.test(src), 'effortKv 应被基本信息块消费');
    // 评估块内不得再残留一份工期 kv（否则 nf=1 单会显示两遍）
    // [C8-fix K4] 切片两端 end-marker 补前提断言（照 [T1b] 范式）：`indexOf` 找不到锚点返回 -1，
    //   `slice(start, -1)` 会静默切出"到倒数第二个字符"的巨大片段——本组随之从"评估块内无残留"退化成
    //   对全文的检查（恒红），或起点也失效时切出空串（恒绿）。两种退化都让断言失去判定力，锚点必须先钉。
    const idxFeasStart = src.indexOf('let feas = \'\';');
    const idxFeasEnd = src.indexOf('// ④a §7 关联修正单号软展示');
    assert.ok(idxFeasStart > 0, 'K4 前置：评估块起点锚点「let feas = \'\';」应能定位（锚点漂移时先红，不静默切错片段）');
    assert.ok(idxFeasEnd > 0, 'K4 前置：评估块终点锚点「// ④a §7 关联修正单号软展示」应能定位（indexOf 返回 -1 会让 slice 静默切出错误片段）');
    assert.ok(idxFeasEnd > idxFeasStart, 'K4 前置：终点锚点应在起点之后（顺序颠倒会切出空串 → 断言恒真假绿）');
    const feasBlock = src.slice(idxFeasStart, idxFeasEnd);
    assert.ok(!/工期（人日）/.test(feasBlock), '评估块内不应再残留工期 kv（移动而非复制，否则 nf=1 单会重复显示两行）');
});
check('K3：详情工期 kv 三态门控（值非空→显示值 / 值空∧开发中→灰字未填 / 其余状态整行不渲染）', () => {
    const idxStart = src.indexOf('const effortApplicableType =');
    const idxEnd = src.indexOf('let feas = \'\';');
    assert.ok(idxStart > 0, 'K3 前置：effortKv 计算块起点应能定位');
    assert.ok(idxEnd > idxStart, 'K3 前置：终点应在起点之后（否则切片为空 → 下方断言恒真假绿）');
    const blk = src.slice(idxStart, idxEnd);
    // ⭐ [C8-fix2 L1'] 判据已从 `effortKvValue != null` 收紧为「非 null ∧ trim 后非空」——空白串按缺失走
    //   三态门控（与后端 normalizeSysEffortDays 的 `raw.trim()===''→value:null` 同口径），不再渲染空白格。
    assert.ok(/const effortKvHasValue = effortKvValue != null && String\(effortKvValue\)\.trim\(\) !== ''/.test(blk),
        "K3/L1'：有值判据须写成 `effortKvValue != null && String(effortKvValue).trim() !== ''`（空白串按缺失处理，与后端 normalizeSysEffortDays 同口径）");
    assert.ok(/if \(effortKvHasValue\)/.test(blk), 'K3：值非空分支应直接显示值（走 effortKvHasValue 判据）');
    // 反向：不得再把裸 `!= null` 直接当渲染门（那会让空白串渲染出一格没内容的工期）
    assert.ok(!/if \(effortKvValue != null\)/.test(blk),
        "L1'：不得回退到裸 `if (effortKvValue != null)` 作为渲染门——空白串会被判成「有值」，渲染出一个有标签无内容的空格子");
    assert.ok(/else if \(iss\.status === '开发中'\)/.test(blk),
        'K3：值为空时只有「开发中」态才渲染灰字「未填」——工期写入口（estimate/feasibility）的 W06 白名单只开这一态，其余状态用户根本没地方填');
    assert.ok(/si-muted">未填</.test(blk), 'K3：开发中态的空值应是灰字「未填」');
    // 不得存在"其余状态也显示未填"的兜底分支。
    // ⭐ [C8-fix 回卷 M3] 反向断言从"文本级 `!/\belse\s*\{/`（挖掉 if 段后不应再有 else）"**改为结构计数**：
    //   原写法有两个已被变异实证的漏洞——① `} else if (true) {` 这种"形式上是 else-if、实际是兜底"的形态
    //   带 `if` 不带裸 `{`，正则一个字都拦不住；② 它依赖一个 `.replace(/…\n {12}\}/, '')` 的挖洞步骤，
    //   缩进硬编码 12 空格，任何重排/换缩进都会让 replace 静默失配（挖不掉 → 残留 if 段里的 else-if 反而
    //   可能误红，或改成别的形状后误绿）。挖洞步骤随本次一并删除（[C8-fix 回卷 L2]：它不是"保险"，是噪音）。
    // 新判据（selectCount===1 范式，同上方风险等级 select 唯一性断言）：本块内对 status 的比较**恰 1 处**，
    //   且右值**恰为 '开发中'**。任何兜底分支想生效，都必须要么再加一个 status 比较（计数 →2，红），要么把
    //   唯一那处比较改成别的常量/恒真式（右值断言红）。这是对"三态门控"这件事本身的结构约束，不是对某种
    //   写法的文本匹配。
    const statusCmps = blk.match(/iss\.status\s*===\s*'[^']*'/g) || [];
    assert.strictEqual(statusCmps.length, 1,
        `K3：effortKv 计算块内对 iss.status 的比较应恰 1 处（多出第 2 处 = 引入了新的状态分支，须重新裁定三态门控口径），实际 ${statusCmps.length} 处：${JSON.stringify(statusCmps)}`);
    assert.strictEqual(statusCmps[0], "iss.status === '开发中'",
        `K3：唯一那处 status 比较的右值必须恰是 '开发中'（"还轮不到填"不能说成"未填"——与列表页 bug 行「留空≠未定级」是同一条判断标准），实际 ${statusCmps[0]}`);
    // 且整块只有 2 条赋值出口（值非空 / 开发中空值），不存在第 3 条 —— 兜底分支即使不比较 status（如裸 else）
    //   也必然要多一条 `effortKv = ` 赋值才能产出内容，此断言把那条路也堵死。
    const assigns = blk.match(/effortKv\s*=\s*`/g) || [];
    assert.strictEqual(assigns.length, 2,
        `K3：effortKv 的模板赋值出口应恰 2 条（值非空显示值 / 开发中空值显示未填），第 3 条即兜底渲染，实际 ${assigns.length} 条`);
    // ⭐⭐ [C8-fix2 M1'·补直接的裸 else 禁令] 上面两条结构计数各有盲区，**裸 else 能从缝里过去**：
    //   · statusCmps 只数 `iss.status === '…'`，裸 else 压根不比较 status ⇒ 计数仍是 1，过；
    //   · assigns 只数**模板字面量**赋值（`effortKv = \``），而 `} else { effortKv = SOME_CONST; }` 这种
    //     用变量/普通字符串赋值的兜底 ⇒ 计数仍是 2，也过。
    //   两条合起来仍拦不住"加一条不看状态、且不用模板串的兜底渲染"，而那恰恰会把 K3 三态门控退化成两态
    //   （"还轮不到填"被说成"未填"）。故直接对块内禁裸 else。
    //   ⚠️ 正则形态刻意用 `\}\s*else\s*\{` 而**不用** `else\s*(?!if\b)`：后者的 `\s*` 会回溯到"少吃几个空格"
    //     的位置让负向先行断言在空白处成立，是经典的假绿写法。`else` 与 `{` 之间夹着 `if (...)` 时本正则
    //     自然不匹配，无需先行断言，也就没有那个回溯陷阱。
    const bareElse = blk.match(/\}\s*else\s*\{/g) || [];
    assert.strictEqual(bareElse.length, 0,
        `K3：effortKv 计算块内**不得出现裸 else**（\`} else {\`）——那是绕过"三态门控"的兜底渲染入口，且能同时躲过 statusCmps 与 assigns 两条计数断言，实际 ${bareElse.length} 处：${JSON.stringify(bareElse)}`);
});

console.log('— §⑪ C9-fix（免上线直翻·前端消费面）—');
check('[H1] 验收弹窗直翻预告读 siDetail.dev_commits，**不是** iss.dev_commits（后者恒 undefined=死代码）', () => {
    const body = extractFunctionBody(src, 'siModalAccept');
    assert.ok(body, 'siModalAccept 函数体应能被提取（防改名后本组静默失效）');
    // ⚠️ 反向断言必须跑在 **stripComments 后的代码**上（同本文件 :145 「函数体（代码，非注释）」既有范式）：
    //   本函数的 H1 订正注释里正当地引用了 `iss.dev_commits` 这个错误写法来说明"为什么它是错的"，
    //   直接对原文匹配会把**解释性引用**误判成**实际用法**（首跑实测踩到，本组当场红）。
    const code = stripComments(body);
    // 正向：必须从 siDetail 取 dev_commits
    assert.ok(/Array\.isArray\(siDetail && siDetail\.dev_commits\)/.test(code),
        '预告判据应写成 Array.isArray(siDetail && siDetail.dev_commits)——详情响应体里 issue 与 dev_commits 是兄弟键，dev_commits 挂在 siDetail 上而不是 issue 上');
    assert.ok(/siDetail\.dev_commits\.length === 0/.test(code), '零 commit 判据同样应取自 siDetail.dev_commits');
    // ⭐ 反向（本组的核心）：代码里不得再出现 iss.dev_commits——那是恒 undefined 的死代码写法，
    //   Array.isArray(undefined) 恒 false 会让预告永不出现，且**不报任何错**（最难发现的一类回归）。
    assert.ok(!/\biss\.dev_commits\b/.test(code),
        '[H1] siModalAccept 代码（非注释）内不得出现 iss.dev_commits——issue 对象上没有这个键（恒 undefined ⇒ 预告分支永不进入，静默失效）；数据源在 siDetail.dev_commits');
    // release_id 则确实挂在 issue 上，仍应从 iss 取（防"一刀切全改 siDetail"改错方向）
    assert.ok(/!iss\.release_id/.test(code),
        '[H1] 未挂批次判据仍应读 iss.release_id（release_id 确实在 issue 对象上，与 dev_commits 不同——不要一刀切）');
});
check('[H1] 直翻结果以响应体 online_source 为准，不复用事前预告变量（真判定在服务端）', () => {
    const code = stripComments(extractFunctionBody(src, 'siModalAccept') || '');
    assert.ok(/d\.online_source === 'no_commit_acceptance'/.test(code),
        '成功回调应按响应体 online_source 判定实际结果——事前预告只是体验层提示，存在 stale 窗口（详情打开后他人补 commit）');
    // 结果分支不得复用 likelyDirect：那会把"我以为会直翻"当成"确实直翻了"
    const cbIdx = code.indexOf('siApi(');
    assert.ok(cbIdx > 0, '应能定位 siApi 调用（锚点漂移时先红，不静默切错片段）');
    assert.ok(!/likelyDirect/.test(code.slice(cbIdx)),
        '[H1] siApi 调用之后的结果处理段不得引用 likelyDirect——预告与结果必须各判各的，复用等于把客户端快照当成服务端裁决');
});
check('[C9-fix2 M3] 验收弹窗直翻预告改**条件式**文案（不再是"验收通过后将 X"的承诺句式）', () => {
    // codex 316 M3 实证：原文案「验收通过后将直接标记为「已上线」」是承诺句式，而同处注释却声称
    //   "措辞用『将』而非承诺"——声称与实现相反。真正的问题不在措辞强弱，而在**它会说错话**：
    //   详情打开后、点确认前若他人补了 commit/挂了批次，后端会落「待上线」，提示与结果对不上。
    //   修法=把前提与另一种结局都写进句子，使这句话在两个分支下都为真。
    const code = stripComments(extractFunctionBody(src, 'siModalAccept') || '');
    assert.ok(code, 'siModalAccept 函数体应能被提取（防改名后本组静默失效）');
    // ① 必须出现条件前提（"若…仍无…"）——这是条件式与承诺式的分水岭
    assert.ok(/若确认时该单仍无在案 commit/.test(code),
        '[M3] 预告文案须显式写出前提「若确认时该单仍无在案 commit 且未挂 active 上线批次」——没有前提的"验收通过后将直接上线"是承诺句式，stale 窗口里会说错话');
    // ② 必须写出另一种结局（否则用户只被告知一半）
    assert.ok(/否则/.test(code) && /待上线/.test(code),
        '[M3] 预告文案须同时写出另一种结局（否则照常进入「待上线」）——只说一个分支等于把可能性说成必然');
    // ③ 必须点明最终以服务端为准（真判定永远在服务端，297-M1）
    assert.ok(/最终以服务端判定为准/.test(code),
        '[M3] 预告文案须点明「最终以服务端判定为准」（前端判据只是快照，真判定在写事务内）');
    // ④ 反向（**顺序**约束，不是存在性约束）：承诺分句"验收通过后将…"必须出现在条件前提**之后**。
    //   ⚠️ 首版把这条写成"不得含承诺分句"——那是**断言写错**：条件式文案本身就包含那半句（"若…，验收通过后
    //     将…；否则…"），存在性检查必然误红。真正要防的回归是**前提被删掉、只剩承诺**，那等价于
    //     "条件出现的位置早于承诺"这条顺序关系被破坏（前提没了 ⇒ indexOf 返 -1 ⇒ 本条红）。
    const condIdx = code.indexOf('若确认时该单仍无在案 commit');
    const promiseIdx = code.indexOf('验收通过后将');
    assert.ok(promiseIdx >= 0, '[M3] 预告文案应仍含"验收通过后将…"这一结果分句（本条只约束它的位置，不是要删掉它）');
    assert.ok(condIdx >= 0 && condIdx < promiseIdx,
        `[M3] 承诺分句必须位于条件前提之后（前提被删只剩承诺=回退到原句式），前提位置=${condIdx} 承诺位置=${promiseIdx}`);
});
check('[M3] 详情页「上线方式」kv：三分支字典 + 仅已上线单渲染 + 前端不自行判定来源', () => {
    // ① 字典常量存在且三个 key/文案逐字对齐后端 deriveOnlineSourceKind 的三分支
    assert.ok(/const SI_ONLINE_SOURCE_LABEL = \{/.test(src), '应定义 SI_ONLINE_SOURCE_LABEL 单一事实源字典');
    for (const [k, label] of [['release_publish', '批次发布'], ['no_commit_acceptance', '免上线直翻'], ['unknown_legacy', '历史存量']]) {
        assert.ok(new RegExp(`${k}:\\s*'${label}'`).test(src), `SI_ONLINE_SOURCE_LABEL 应含 ${k} → 「${label}」（key 与后端 deriveOnlineSourceKind 三分支逐字对齐）`);
    }
    const dictMatch = src.match(/const SI_ONLINE_SOURCE_LABEL = \{([^}]*)\}/);
    assert.ok(dictMatch, 'SI_ONLINE_SOURCE_LABEL 字典字面量应能被切出（锚点漂移时先红，不静默按 0 个分支判定）');
    const dictKeys = dictMatch[1].split(',').filter(s => s.trim()).length;
    assert.strictEqual(dictKeys, 3, `SI_ONLINE_SOURCE_LABEL 应恰 3 个分支（与后端三分支一一对应；多出第 4 个说明后端加了分支而两边未对账），实际 ${dictKeys}`);
    // ② kv 渲染：以 online_source_kind 非空为门（后端对非已上线单恒返 null ⇒ 等价于"仅已上线单渲染"）
    assert.ok(/\$\{iss\.online_source_kind \? `<div class="u-kv-item"><label>上线方式<\/label>/.test(src),
        '「上线方式」kv 应由 iss.online_source_kind 非空门控——不适用时整行不渲染（同工期 kv K3 三态门控 / 列表页 bug 行「留空≠未定级」同一判断标准）');
    assert.ok(/SI_ONLINE_SOURCE_LABEL\[iss\.online_source_kind\] \|\| iss\.online_source_kind/.test(src),
        '未知 kind 应兜底显示原始 key（宁可露出英文标识让人发现漏改，也不静默显示空白/错误分类）');
    // ③ ⭐ 前端**不得自行判定来源**：全站不得出现读原始 online_source 列或重算三分支的写法
    //    （判定权威唯一在后端 deriveOnlineSourceKind，两份判据必然漂移——297-M6 已裁定）。
    //    注意排除 siModalAccept 里对 **accept 响应体** d.online_source 的消费：那是端点返回值不是 issue DTO 列。
    const acceptBody = extractFunctionBody(src, 'siModalAccept') || '';
    const srcSansAccept = src.replace(acceptBody, '');
    assert.ok(!/\biss\.online_source\b/.test(srcSansAccept),
        '[M3] 前端不得读 issue 的原始 online_source 列（那是后端派生的输入，不是展示字段）——只认后端给的 online_source_kind');
    // ④ 纯展示扩字段：不得因此新增来源筛选（同 C8 risk_level 的既定口径）
    assert.ok(!/online_source_kind[^\n]*(filter|筛选|addEq)/.test(src) && !/\?online_source=/.test(src),
        '[M3] C9 是纯展示扩字段，不应新增按上线来源筛选（加筛选属独立需求，须另行立项）');
});
check('[M3] 后端契约：deriveOnlineSourceKind 对非「已上线」单恒返 null（前端 kv 门控的前提）', () => {
    const indexJsPath = path.join(__dirname, '..', 'routes', 'sys-iteration', 'index.js');
    const indexJsSrc = fs.readFileSync(indexJsPath, 'utf8');
    // 前端只判 online_source_kind 非空、不另判 status，其正确性完全依赖后端这一行——跨文件钉死，
    //   否则后端哪天去掉这个 early return，前端会给「待验证」单也渲染出一行「上线方式」。
    assert.ok(/function deriveOnlineSourceKind\(row\) \{\s*\n\s*if \(!row \|\| row\.status !== SYS_ONLINE_STATUS\) return null;/.test(indexJsSrc),
        '[M3] deriveOnlineSourceKind 首行须对非「已上线」单 return null——前端「上线方式」kv 只判该字段非空、不另判 status，这一行就是"仅已上线单渲染"的唯一保证');
    assert.ok(/online_source_kind/.test(indexJsSrc), '[M3] 后端须以 online_source_kind 键名下发（前端按此键读取）');
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
