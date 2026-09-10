/**
 * verify-sys-submit-amend-static.js
 *
 * C4（提交修正与config指派OA守卫 方案 v1.5 §B 前端段）前端静态源码断言——纯文本源码扫描，无需启动
 * server，自包含。范式照 scripts/verify-sys-fastlane-panel-static.js：extractFunctionBody（委派
 * scripts/lib/extract-function-body.js 的硬化实现）+ stripComments（防"未见调用 X"这类否定式断言
 * 被自己注释里的同一字面量误判为真）+ check() 计数收尾。
 *
 * 覆盖：
 *   ① SI_AMEND_STATUSES **含**「待对接测试」，且=SI_DEV_FAMILY_STATUSES ∪ {'待验证','待对接测试'}
 *      （D-L1·2026-09-10 决策记录，推翻 v1.5 原「不含待对接测试」已决点）——SI_DEV_FAMILY_STATUSES
 *      本身对拍后端 status-families.js 的 SYS_DEV_STATUSES 并集真相源（require 真实模块，非凭印象
 *      抄一份字面量）。变异两向：加「待上线」判红 + 去掉「待对接测试」判红。
 *   ② canAmendSubmission 判据结构锚（本人在册∧dev_status∈{code_submitted,no_code}∧主状态∈
 *      SI_AMEND_STATUSES）——去注释后正则匹配。
 *   ③ siModalAccept 的 accept 请求体携带 expected_delivery_rev 结构锚。
 *   ④ 版本锁两步采用：存在「加载最新交付」与「已查看以上交付，采用此版本」两处文案 + 提交回调开头
 *      含弹层冲突态守卫（!myFlow.candidateAdopted 才允许提交）。
 *   ⑤ 修正徽标已删除（用户 2026-09-10 拍板）：siRenderDevMemberChips 不再含「已修正 ×」文案，时间
 *      显示回退"最新提交时刻"（amended_at || first_submitted_at）——徽标删除与版本锁两步采用是两件
 *      独立的事，两步采用维持 D-L1 决策记录原样不变。
 *
 * 每条断言额外配一条"变异证红"自测——在**内存**里对源码字符串做定向破坏（不写盘、不改真实文件），
 * 验证同一套断言逻辑对着被破坏的文本确实会判红（判别力证据），再验证原始未改动文件仍是绿的。
 *
 * 用法：node scripts/verify-sys-submit-amend-static.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
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

// 同 verify-sys-fastlane-panel-static.js 契约：extractFunctionBody 返回"从首个 `{` 到匹配收尾 `}`"
// 的 body-only 文本（不含 "function name(...)" 签名）。
function extractFunctionBody(source, fnName) {
    const full = extractFunctionFullText(source, fnName);
    if (!full) return null;
    const braceIdx = full.indexOf('{');
    return braceIdx < 0 ? null : full.slice(braceIdx);
}
function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
}
// 断言面统一入口——可传任意源文本（供"变异证红"自测复用同一套逻辑，而不必另起一份判断代码）。
function bodyOfIn(srcText, fnName) {
    const raw = extractFunctionBody(srcText, fnName);
    return raw == null ? null : stripComments(raw);
}
const bodyOf = (fnName) => bodyOfIn(src, fnName);

// ══════════════════════════════════════════════════════════════════════
// ① SI_AMEND_STATUSES 不含「待对接测试」，且=DEV 族 ∪ {待验证}（对拍后端真相源）
// ══════════════════════════════════════════════════════════════════════
function assert1(srcText) {
    const SF = require(path.join(__dirname, '..', 'routes', 'sys-iteration', 'status-families.js'));
    const backendDevUnion = new Set();
    for (const t of Object.keys(SF.SYS_DEV_STATUSES)) for (const s of SF.SYS_DEV_STATUSES[t]) backendDevUnion.add(s);
    const stripped = stripComments(srcText);
    const m1 = stripped.match(/const SI_DEV_FAMILY_STATUSES = (\[[^\]]*\]);/);
    assert.ok(m1, '未定位到 SI_DEV_FAMILY_STATUSES 字面量');
    const feDevArr = JSON.parse(m1[1].replace(/'/g, '"'));
    assert.deepStrictEqual(new Set(feDevArr), backendDevUnion, `SI_DEV_FAMILY_STATUSES 与后端 SYS_DEV_STATUSES 并集不一致：前端=${JSON.stringify(feDevArr)}，后端=${JSON.stringify([...backendDevUnion])}`);
    const m2 = stripped.match(/const SI_AMEND_STATUSES = (\[[^\]]*\]);/);
    assert.ok(m2, '未定位到 SI_AMEND_STATUSES 字面量');
    // [C4c·codex 538 M4] 原实现只对字面量原文做 .includes() 子串匹配——能查出"含不该有的词"，但查不出
    // "多混进一个不认识的状态值"这类形状（子串匹配对未列举的新增元素毫无反应）。改为**真求值**：把
    // SI_DEV_FAMILY_STATUSES 的真实值注入，用 `new Function` 对捕获到的数组字面量原文求值（保留展开
    // 运算符语义，不用正则拆解），拿到 SI_AMEND_STATUSES 的真实运行期数组，再与"后端 DEV 族并集 ∪
    // {待验证}"逐元素集合比较（deepStrictEqual 两个 Set）——任何多余/缺失/替换元素都会被判红，不只是
    // "含不含某个已知的坏词"。
    let amendArr;
    try { amendArr = new Function('SI_DEV_FAMILY_STATUSES', 'return ' + m2[1] + ';')(feDevArr); }
    catch (e) { assert.fail(`SI_AMEND_STATUSES 字面量无法求值（${e.message}）——实得=${m2[1]}`); }
    assert.ok(Array.isArray(amendArr), `SI_AMEND_STATUSES 求值结果应为数组，实得=${JSON.stringify(amendArr)}`);
    const expectedSet = new Set([...backendDevUnion, '待验证', '待对接测试']);
    assert.deepStrictEqual(new Set(amendArr), expectedSet, `SI_AMEND_STATUSES 应严格等于「DEV 族 ∪ {待验证,待对接测试}」：实得=${JSON.stringify(amendArr)}，期望=${JSON.stringify([...expectedSet])}`);
    assert.strictEqual(amendArr.length, expectedSet.size, `SI_AMEND_STATUSES 不应含重复元素，实得长度=${amendArr.length}，去重后应为=${expectedSet.size}`);
}
console.log('— ① SI_AMEND_STATUSES = DEV族∪{待验证,待对接测试}（对拍后端 status-families 真相源，D-L1 决策记录） —');
check('① SI_AMEND_STATUSES 结构与后端 SYS_DEV_STATUSES 并集一致，且含"待对接测试"', () => assert1(src));
check('① 变异证红：混入"待上线"后应被判红（多余元素）', () => {
    const anchor = "const SI_AMEND_STATUSES = [...SI_DEV_FAMILY_STATUSES, '待验证', '待对接测试'];";
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移，需先核实变异证红用例仍对应真实代码');
    const mutated = src.replace(anchor, "const SI_AMEND_STATUSES = [...SI_DEV_FAMILY_STATUSES, '待验证', '待对接测试', '待上线'];");
    assert.throws(() => assert1(mutated), /应严格等于/, '变异后（混入"待上线"）assert1 应抛出，但未抛出——判别力不足（说明旧的 .includes() 式子串匹配查不出未登记在案的多余元素）');
});
check('① 变异证红：去掉"待对接测试"后应被判红（缺失元素，防集合收窄回 v1.5 无人盯）', () => {
    const anchor = "const SI_AMEND_STATUSES = [...SI_DEV_FAMILY_STATUSES, '待验证', '待对接测试'];";
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移，需先核实变异证红用例仍对应真实代码');
    const mutated = src.replace(anchor, "const SI_AMEND_STATUSES = [...SI_DEV_FAMILY_STATUSES, '待验证'];");
    assert.throws(() => assert1(mutated), /应严格等于/, '变异后（去掉"待对接测试"）assert1 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ② canAmendSubmission 判据结构锚
// ══════════════════════════════════════════════════════════════════════
function assert2(srcText) {
    const b = bodyOfIn(srcText, 'siComputeCaps');
    assert.ok(b, '未提取到 siComputeCaps 函数体');
    assert.ok(
        /canAmendSubmission:\s*!!\(myRow\s*&&\s*\['code_submitted',\s*'no_code'\]\.includes\(myRow\.dev_status\)\s*&&\s*SI_AMEND_STATUSES\.includes\(iss\.status\)\)/.test(b),
        '未见 canAmendSubmission 判据结构锚（本人在册∧dev_status∈{code_submitted,no_code}∧主状态∈SI_AMEND_STATUSES）'
    );
}
console.log('— ② canAmendSubmission 判据结构锚 —');
check('② siComputeCaps 含 canAmendSubmission 三条件判据', () => assert2(src));
check('② 变异证红：判据被裁剪（去掉 dev_status 分支）后应被判红', () => {
    const anchor = "canAmendSubmission: !!(myRow && ['code_submitted', 'no_code'].includes(myRow.dev_status) && SI_AMEND_STATUSES.includes(iss.status)),";
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移');
    const mutated = src.replace(anchor, "canAmendSubmission: !!(myRow && SI_AMEND_STATUSES.includes(iss.status)),");
    assert.throws(() => assert2(mutated), null, '变异后（裁剪 dev_status 分支）assert2 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ③ accept 请求体携带 expected_delivery_rev 结构锚
// ══════════════════════════════════════════════════════════════════════
function assert3(srcText) {
    const b = bodyOfIn(srcText, 'siModalAccept');
    assert.ok(b, '未提取到 siModalAccept 函数体');
    // [codex 542·M1] 无条件携带（不再是 if(myFlow.baselineRev) 条件式——fail-closed 守卫已在更早的
    // baselineValid 检查处理，走到这里 baselineRev 必已确认合法，见 ⑥ 组断言）。
    assert.ok(/body\.expected_delivery_rev\s*=\s*myFlow\.baselineRev;/.test(b) && !/if\s*\(myFlow\.baselineRev\)\s*body\.expected_delivery_rev/.test(b), '未见 accept 请求体无条件携带 expected_delivery_rev 结构锚');
}
console.log('— ③ accept 请求体携带 expected_delivery_rev —');
check('③ siModalAccept 请求体含 body.expected_delivery_rev = myFlow.baselineRev;（无条件）', () => assert3(src));
check('③ 变异证红：去掉该行后应被判红', () => {
    // accept 与 liaison_test_pass 两处字面量相同，用 extractFunctionFullText 限定在 siModalAccept
    // 函数全文内替换，避免误伤另一处（同 ⑤/⑥ 组同款纪律）。
    const fnFull = extractFunctionFullText(src, 'siModalAccept');
    assert.ok(fnFull, '未提取到 siModalAccept 函数全文（原始，含签名）');
    const anchor = 'body.expected_delivery_rev = myFlow.baselineRev;';
    const occurrences = fnFull.split(anchor).length - 1;
    assert.strictEqual(occurrences, 1, `锚点在 siModalAccept 函数体内应恰 1 处，实得 ${occurrences} 处——源码可能已漂移`);
    const fnMutated = fnFull.replace(anchor, '');
    const mutatedSrc = src.replace(fnFull, fnMutated);
    assert.notStrictEqual(mutatedSrc, src, '整页替换未生效');
    assert.throws(() => assert3(mutatedSrc), null, '变异后（删除携带行）assert3 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ④ 版本锁两步采用——文案 + 提交回调弹层态守卫
// ══════════════════════════════════════════════════════════════════════
function assert4(srcText) {
    const b = bodyOfIn(srcText, 'siModalAccept');
    assert.ok(b, '未提取到 siModalAccept 函数体');
    assert.ok(b.includes('加载最新交付'), '未见"加载最新交付"文案');
    assert.ok(b.includes('已查看以上交付，采用此版本'), '未见"已查看以上交付，采用此版本"文案');
    // [D-L1] 锚点同步改为 myFlow.candidateAdopted（版本锁状态机抽成共享构造后，弹层态改由 myFlow
    // 只读属性暴露，不再是裸闭包变量）。
    assert.ok(/if\s*\(!myFlow\.candidateAdopted\)\s*\{/.test(b), '提交回调未见弹层态守卫 if (!myFlow.candidateAdopted) {（应在附件上传检查之前——提交回调先于附件上传检查弹层态）');
    // 顺位核验：!myFlow.candidateAdopted 守卫必须出现在附件上传逻辑（siPickerFiles 调用）之前——「提交
    // 回调先于附件上传检查弹层态」不是只要求守卫存在，还要求它在附件上传代码之前拦截。
    const guardIdx = b.search(/if\s*\(!myFlow\.candidateAdopted\)\s*\{/);
    const uploadIdx = b.indexOf('siPickerFiles(evidenceKey)');
    assert.ok(guardIdx >= 0 && uploadIdx >= 0 && guardIdx < uploadIdx, `弹层态守卫应在附件上传逻辑之前——guardIdx=${guardIdx}, uploadIdx=${uploadIdx}`);
}
console.log('— ④ 版本锁两步采用：文案 + 提交回调弹层态守卫顺位 —');
check('④ siModalAccept 含两步采用文案 + !myFlow.candidateAdopted 守卫先于附件上传', () => assert4(src));
check('④ 变异证红：把"采用此版本"文案改写后应被判红', () => {
    const anchor = '已查看以上交付，采用此版本';
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移');
    const mutated = src.replace(anchor, '知道了');
    assert.throws(() => assert4(mutated), null, '变异后（改写采用按钮文案）assert4 应抛出，但未抛出——判别力不足');
});
check('④ 变异证红：守卫挪到附件上传之后应被判红（顺位不满足）', () => {
    // 按行锚点在**原始**函数全文（含注释/原始缩进，非剥注释版）里定位"if (!myFlow.candidateAdopted) {"到
    // "if (myFlow.acceptLoading)"那一行结束的区间，整体挪到"if (files.length > 0) {"那一行之后——不手抄
    // 多行字面量（对空白/换行极脆弱，源码任何一次格式化都会让锚点悄悄失配），全程按 indexOf 行边界切片。
    const fnFull = extractFunctionFullText(src, 'siModalAccept');
    assert.ok(fnFull, '未提取到 siModalAccept 函数全文（原始，含签名）');
    const guardStartInFn = fnFull.indexOf('if (!myFlow.candidateAdopted) {');
    assert.ok(guardStartInFn >= 0, '原始函数全文中未定位到 if (!myFlow.candidateAdopted) {');
    const acceptLoadingLineEnd = (() => {
        const idx = fnFull.indexOf('if (myFlow.acceptLoading)', guardStartInFn);
        assert.ok(idx >= 0, '原始函数全文中未定位到 if (myFlow.acceptLoading)');
        return fnFull.indexOf('\n', idx) + 1;
    })();
    const guardOriginal = fnFull.slice(guardStartInFn, acceptLoadingLineEnd);
    const fnWithoutGuard = fnFull.slice(0, guardStartInFn) + fnFull.slice(acceptLoadingLineEnd);
    const uploadAnchorIdx = fnWithoutGuard.indexOf('if (files.length > 0) {');
    assert.ok(uploadAnchorIdx >= 0, '未定位到附件上传分支起点 if (files.length > 0) {');
    const uploadLineEnd = fnWithoutGuard.indexOf('\n', uploadAnchorIdx) + 1;
    const fnMutated = fnWithoutGuard.slice(0, uploadLineEnd) + guardOriginal + fnWithoutGuard.slice(uploadLineEnd);
    assert.notStrictEqual(fnMutated, fnFull, '变异未产生实际差异——锚点定位逻辑有误');
    const mutatedSrc = src.replace(fnFull, fnMutated);
    assert.notStrictEqual(mutatedSrc, src, '整页替换未生效');
    assert.throws(() => assert4(mutatedSrc), /之前/, '变异后（守卫挪到附件上传之后）assert4 应因顺位断言抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ⑤ 修正徽标已删除（用户 2026-09-10 拍板）——chip 不再渲染「已修正 ×N」，时间显示改回"最新提交时刻"
//    （amended_at || first_submitted_at，无需新增后端字段）。
// ══════════════════════════════════════════════════════════════════════
function assert5(srcText) {
    const b = bodyOfIn(srcText, 'siRenderDevMemberChips');
    assert.ok(b, '未提取到 siRenderDevMemberChips 函数体');
    assert.ok(!b.includes('已修正 ×'), '不应再出现"已修正 ×"徽标文案（用户拍板已去掉，若命中说明旧句未删干净）');
    assert.ok(/d\.amended_at\s*\|\|\s*d\.first_submitted_at/.test(b), '未见时间显示回退到"最新提交时刻"的结构锚（amended_at || first_submitted_at）');
}
console.log('— ⑤ 修正徽标已删除 + 时间显示回退"最新提交时刻" —');
check('⑤ siRenderDevMemberChips 不含"已修正 ×"徽标，时间显示用 amended_at || first_submitted_at', () => assert5(src));
check('⑤ 变异证红：徽标文案被误加回应被判红', () => {
    const fnFull = extractFunctionFullText(src, 'siRenderDevMemberChips');
    assert.ok(fnFull, '未提取到 siRenderDevMemberChips 函数全文（原始，含签名）');
    const anchor = 'const latestSubmitAt = d.amended_at || d.first_submitted_at;';
    assert.ok(fnFull.includes(anchor), '锚点未命中——源码可能已漂移');
    const fnMutated = fnFull.replace(anchor, anchor + "\n                const amendSpanMutationProbe = Number(d.amend_no) > 0 ? '已修正 ×' + Number(d.amend_no) : '';");
    assert.notStrictEqual(fnMutated, fnFull, '变异未产生实际差异');
    const mutated = src.replace(fnFull, fnMutated);
    assert.notStrictEqual(mutated, src, '整页替换未生效');
    assert.throws(() => assert5(mutated), null, '变异后（重新混入"已修正 ×"文案）assert5 应抛出，但未抛出——判别力不足');
});
check('⑤ 变异证红：latestSubmitAt 回退链被裁剪（去掉 first_submitted_at 兜底）应被判红', () => {
    const anchor = 'const latestSubmitAt = d.amended_at || d.first_submitted_at;';
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移');
    const mutated = src.replace(anchor, 'const latestSubmitAt = d.amended_at;');
    assert.throws(() => assert5(mutated), null, '变异后（裁剪 first_submitted_at 兜底）assert5 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ⑥（codex 542·M1）版本锁 fail-closed——baselineValid 不合法时拦截提交，合法时无条件携带
//    expected_delivery_rev（不再用 `if (myFlow.baselineRev)` 这种"真值才带"的写法）。
// ══════════════════════════════════════════════════════════════════════
function assert6(srcText) {
    const bAccept = bodyOfIn(srcText, 'siModalAccept');
    assert.ok(bAccept, '未提取到 siModalAccept 函数体');
    assert.ok(/if\s*\(!myFlow\.baselineValid\)\s*\{/.test(bAccept), 'siModalAccept 未见 baselineValid fail-closed 守卫');
    assert.ok(/body\.expected_delivery_rev\s*=\s*myFlow\.baselineRev;/.test(bAccept) && !/if\s*\(myFlow\.baselineRev\)\s*body\.expected_delivery_rev/.test(bAccept),
        'siModalAccept 应无条件携带 expected_delivery_rev（不应再是 if(myFlow.baselineRev) 条件式）');
    const bPass = bodyOfIn(srcText, 'siModalLiaisonTestPass');
    assert.ok(bPass, '未提取到 siModalLiaisonTestPass 函数体');
    assert.ok(/if\s*\(!myFlow\.baselineValid\)\s*\{/.test(bPass), 'siModalLiaisonTestPass 未见 baselineValid fail-closed 守卫');
    assert.ok(/body\.expected_delivery_rev\s*=\s*myFlow\.baselineRev;/.test(bPass) && !/if\s*\(myFlow\.baselineRev\)\s*body\.expected_delivery_rev/.test(bPass),
        'siModalLiaisonTestPass 应无条件携带 expected_delivery_rev（不应再是 if(myFlow.baselineRev) 条件式）');
}
console.log('— ⑥ 版本锁 fail-closed：baselineValid 拦截 + 无条件携带 —');
check('⑥ accept/liaison_test_pass 两处均有 baselineValid 守卫 + 无条件携带 expected_delivery_rev', () => assert6(src));
check('⑥ 变异证红：改回 if(myFlow.baselineRev) 条件式携带应被判红', () => {
    const anchor = 'body.expected_delivery_rev = myFlow.baselineRev;';
    const occurrences = src.split(anchor).length - 1;
    assert.strictEqual(occurrences, 2, `锚点应恰 2 处（accept/liaison_test_pass 各一），实得 ${occurrences} 处——源码可能已漂移`);
    const mutated = src.split(anchor).join('if (myFlow.baselineRev) body.expected_delivery_rev = myFlow.baselineRev;');
    assert.throws(() => assert6(mutated), null, '变异后（改回条件式携带）assert6 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// ⑦（codex 542·第4条）候选视图去掉「已修正 ×N」次数字样，只留改动清单。
// ══════════════════════════════════════════════════════════════════════
function assert7(srcText) {
    const b = bodyOfIn(srcText, 'siRenderAcceptCandidateHtml');
    assert.ok(b, '未提取到 siRenderAcceptCandidateHtml 函数体');
    assert.ok(!b.includes('已修正 ×'), '候选视图不应再出现"已修正 ×"次数字样（用户拍板已去掉，若命中说明旧句未删干净）');
    assert.ok(b.includes('本次修正改动：'), '候选视图未见"本次修正改动："改动清单文案');
}
console.log('— ⑦ 候选视图去次数：只留改动清单 —');
check('⑦ siRenderAcceptCandidateHtml 不含"已修正 ×"，含"本次修正改动："', () => assert7(src));
check('⑦ 变异证红：改回"已修正 ×N"文案应被判红', () => {
    const anchor = "`<div>本次修正改动：${esc(d.changed.join('、'))}</div>`";
    assert.ok(src.includes(anchor), '锚点未命中——源码可能已漂移');
    const mutated = src.replace(anchor, "`<div>已修正 ×${Number(d.amend_no)}（改动：${esc(d.changed.join('、'))}）</div>`");
    assert.throws(() => assert7(mutated), null, '变异后（改回已修正 ×N 文案）assert7 应抛出，但未抛出——判别力不足');
});

// ══════════════════════════════════════════════════════════════════════
// 附加：HTML 内联 <script> 语法有效性（等价 node -c，new Function 编译不执行）
// ══════════════════════════════════════════════════════════════════════
console.log('— 附加：内联 <script> 语法有效性 —');
check('内联 <script> 块可被 new Function 编译（语法有效）', () => {
    const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 1, '未找到任何 <script> 块');
    for (let i = 0; i < blocks.length; i++) {
        try { new Function(blocks[i]); } catch (e) { assert.fail(`第 ${i + 1} 个 <script> 块编译失败：${e.message}`); }
    }
});

console.log(`\n${failed === 0 ? '[全部通过]' : '[失败]'} ${passed}/${passed + failed} 项断言${failed ? `，${failed} 项失败` : ''}`);
if (failed) {
    console.log('失败详情：');
    for (const f of failures) console.log(`  - ${f.name}: ${f.err}`);
    process.exit(1);
}
