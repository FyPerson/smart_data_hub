/**
 * 模型中心 C7 · 整条目点击打开详情抽屉 Playwright 实测（2026-07-24 初版；C4c-2 子批 2c 按新卡片结构重写 R1–R10）
 *
 * 用法：node scripts/test-model-c7-row-click-playwright.js
 * 前置：本地 server 已启动（TEST_BASE_URL，默认 localhost:3000）
 * 新结构（C4c-2）：条目 = #modelListBody [data-id]（首行 .catalog-row1 / 第二行 .catalog-row2）；操作区 .model-row-actions（验收 + ⋯，菜单是条目内的 [role=menu]）；
 *   点击委托：MC 的 C7 委托（initModelDrawer）+ CAT 的列表委托（catalogBindList，data-act / data-entry 分发）。
 * 覆盖：
 *   R1  点条目首行 / 第二行的非交互区 → 打开抽屉且 id 对应该条目
 *   R2  点 ⋯ 触发按钮、菜单项、验收（直接按钮 / 阶段菜单 + 菜单项）、设计说明按钮、分页按钮 → **不**开抽屉（抽屉 open 类 + openModelDrawer 调用次数 0）
 *   R2b 点 .model-row-actions 的空隙 / 内边距 → 不开抽屉
 *   R3  设计说明气泡：点 ⓘ → 不开抽屉，气泡出现
 *   R4  .model-open-btn 原路径不回归
 *   R5  §5.5 焦点归还：整条目点击打开 → 关闭 → 焦点落在该条目的 .model-open-btn
 *   R6  拖选文本后松开鼠标 → 不开抽屉；R6b 别处残留选区不误挡条目点击
 *   R7  .selected-row（P30：条目内任意点击都选中该条目——含 ⋯、菜单项、设计说明；清掉其它、重复点击保持、全表至多一个）
 *   R8  菜单项（⋯ 菜单与验收阶段菜单各验一次，含点菜单内边距）不同时开抽屉；12 个处理函数全部打桩（只记录，不弹窗）
 *   R9  抽屉「迭代历史 →」：归档任务数 > 0 → 链接调用 viewIterationHistory(id)；为 0 → 灰色「暂无迭代历史」、无按钮
 *   R10 列表重渲染替换 opener 后关抽屉，焦点仍回到该条目表名按钮（N3）；悬停读计算样式（卡片边框色或阴影悬停前后有变化，不锁颜色值）；.model-open-btn:hover 无下划线
 *   R11 展开面板（C4c-3 3a）：点展开按钮不开抽屉；点面板空白处（面板自己的内边距，命中元素就是 .pane）不开抽屉（C7 委托排除 .pane）
 *   R11b 面板里的模型链接（button[data-open-model]，Q14）：点击打开「那个模型」的抽屉（openModelDrawer 调用序列恰为 [目标 id]，不是所在条目的 id），抽屉副标题匹配目标 id
 *   R12 normalize.js 版本印记与缓存串一致
 *   全程 0 console error
 * 同步性（DOM 契约 14）：菜单开关 / 委托分发 / renderModelsPage 都是同步完成的，所以「抽屉没开」在 click 返回后立即读（再过两帧作为帧边界，不用 sleep 猜时序）。
 * 页内变异自证（C7_MUT=<名>，拦截 Model_Center.html 文档做锚点替换，锚点必须恰好出现 1 次，否则直接报错退出；期望判红，下列「红」是实测）：
 *   no-actions-exclude（C7 委托的排除选择器去掉 .model-row-actions）→ R2b（点操作区空白 / gap 会开抽屉）判红；
 *   no-container-exclude（排除选择器同时去掉 [role="menu"], [role="menuitem"] 与 .model-row-actions）→ R2b（点操作区空白 / gap）与 R8（点菜单上沿）都判红。
 *   （单独去掉 [role="menu"], [role="menuitem"] 是等价变异：菜单渲染在 .model-row-actions 里面，仍被后者排除，所以不单列。）
 *   no-select-guard（C7 委托去掉「有选区不打开」守卫）→ R6（拖选后抽屉被打开）判红；
 *   wrong-id（C7 委托打开 id+1）→ R1 判红；wrong-id-btn（表名按钮路径打开 id+1）→ R4 判红（2e：R1 / R4 先 resetCounters 并断言 openModelDrawer 调用序列全等于 [该条目 id]，再等抽屉副标题匹配 #<id>）。
 *   —— 39 B1-1 新增 6 个（拦截 assets/js/model-catalog.js 做锚点替换，锚点同样必须恰好出现 1 次；改的是 catalogDispatchAct 里三个菜单项的分发，页内探针确认生效）：
 *   dispatch-direct-fn（直接验收按钮改调 viewModelChangeLogs）/ dispatch-direct-layer（直接验收按钮第 4 参数 'ODS' 改 'DWD'）→ R2 验收直接按钮判红；
 *   dispatch-editinfo-fn（edit-info 改调 openDwdConfigViewModal）/ dispatch-editinfo-arg（edit-info 传 id 数字而不是行对象）→ R8 ⋯ 菜单判红；
 *   dispatch-valdata-fn（validate-data 改调 viewModelChangeLogs）/ dispatch-valdata-phase（validate-data 的阶段 'data' 改 'semantic'）→ R8 验收阶段菜单判红。
 *   这些变异下 `__calls.length === 1` 都成立（只数次数的旧断言全绿），所以必须核函数名与参数。
 *   —— 39 B3 新增 3 个：select-skip-menuitem（列表委托对 [role=menu] 内的点击不再选中条目）→ R7 两个菜单项场景判红（点触发按钮已选中目标，旧 R7 不判红）；
 *   dispatch-valdata-layer-hardcode（validate-data 层级写死 'DWD'）→ R8 验收阶段菜单判红（DIM 条目）；dispatch-direct-arg2（直接验收第 2 参数传 table_comment）→ R2 验收直接按钮判红。
 *   B3-2：分发断言核完整参数向量，期望由 allModelsData 里该条目的行手写（层级：DIM → 'DIM'，否则 'DWD'），不调用被测分发函数或 catalogRowCopy。
 *   —— C4c-3 3a 新增 2 个：no-pane-exclude（C7 委托的排除选择器只去掉 .pane）→ R11（点面板空白处会开抽屉）判红；
 *   pane-link-wrong-id（面板模型链接的打开改成 id+1，拦截 model-catalog.js 的 catalogOpenModel）→ R11b 判红（调用序列 [target+1] ≠ [target]）；
 *   pane-link-no-opener（面板模型链接的打开不传 opener 元素）→ R11b 判红（完整参数向量：2 个参数、第 2 个是被点击的链接节点）。
 *   —— C4c-3 3d 新增 1 个：pane-link-first-node（面板模型链接的打开用 document.querySelector 按 data-open-model 取节点作 opener，取到文档里第一个同目标链接）→ R11c 判红（两个展开面板指向同一目标、点第二个面板里的链接，opener 须 === 被点的那个节点；R11b 单面板场景下 querySelector 取到的就是同一个节点，区分不了）。
 * 数据：列表请求由路由改写：API 返回的 rows[0] 注入设计说明与归档任务数 3，rows[1] 归档任务数 0（真实库副本不一定有这些数据；R9 / R3 需要确定的前提）。
 *   渲染出的首个 / 第二个条目是否就是这两行，由前提断言查 allModelsData 确认（2e：头部说明与实作一致，不靠「第 N 个条目」的口头约定）。
 */
'use strict';

const { chromium } = require('playwright');
const fx = require('./_test-fixture');

let pass = 0, fail = 0;
function expect(cond, msg, detail) {
    if (cond) { console.log(`  ✓ ${msg}`); pass++; }
    else { console.log(`  ✗ ${msg}${detail !== undefined ? '  got=' + JSON.stringify(detail) : ''}`); fail++; }
}
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
const WAIT = 8000;
const C7_MUTS = {
    'no-actions-exclude': [['[role="menu"], [role="menuitem"], .pane, .model-row-actions\')) { return; }', '[role="menu"], [role="menuitem"], .pane\')) { return; }']],
    'no-container-exclude': [['label, [role="menu"], [role="menuitem"], .pane, .model-row-actions', 'label, .pane']],
    'no-pane-exclude': [['[role="menuitem"], .pane, .model-row-actions', '[role="menuitem"], .model-row-actions']],
    'no-select-guard': [["if (sel && !sel.isCollapsed && sel.toString().trim()) { return; }", '']],
    'wrong-id': [["openModelDrawer(id, tr.querySelector('.model-open-btn') || null);", "openModelDrawer(id + 1, tr.querySelector('.model-open-btn') || null);"]],
    'wrong-id-btn': [['if (Number.isInteger(id) && id > 0) { openModelDrawer(id, btn); }', 'if (Number.isInteger(id) && id > 0) { openModelDrawer(id + 1, btn); }']],
};
// 39 B1-1：改 model-catalog.js 的分发（data-act → 处理函数）；probe = 页面装载后在 catalogDispatchAct 源码里必须为真的片段
const C7_CAT_MUTS = {
    'dispatch-direct-fn': { edits: [["case 'validate': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'ODS']); break;", "case 'validate': catalogCall('viewModelChangeLogs', [m.id]); break;"]], probe: "case 'validate': catalogCall('viewModelChangeLogs'" },
    'dispatch-direct-layer': { edits: [["case 'validate': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'ODS']); break;", "case 'validate': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'DWD']); break;"]], probe: "m.status, 'DWD']); break;" },
    'dispatch-editinfo-fn': { edits: [["case 'edit-info': catalogCall('openEditModal', [catalogRowCopy(m)]); break;", "case 'edit-info': catalogCall('openDwdConfigViewModal', [m.id]); break;"]], probe: "case 'edit-info': catalogCall('openDwdConfigViewModal'" },
    'dispatch-editinfo-arg': { edits: [["case 'edit-info': catalogCall('openEditModal', [catalogRowCopy(m)]); break;", "case 'edit-info': catalogCall('openEditModal', [m.id]); break;"]], probe: "case 'edit-info': catalogCall('openEditModal', [m.id]); break;" },
    'dispatch-valdata-fn': { edits: [["case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'data']); break;", "case 'validate-data': catalogCall('viewModelChangeLogs', [m.id]); break;"]], probe: "case 'validate-data': catalogCall('viewModelChangeLogs'" },
    'select-skip-menuitem': { fn: 'catalogBindList', edits: [["if (entry && list.contains(entry)) catalogSelectEntry(entry);", "if (entry && list.contains(entry) && !t.closest('[role=\"menu\"]')) catalogSelectEntry(entry);"]], probe: "!t.closest('[role=\"menu\"]')) catalogSelectEntry(entry)" },
    'dispatch-valdata-layer-hardcode': { edits: [["case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'data']); break;", "case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'DWD', 'data']); break;"]], probe: "case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'DWD', 'data'])" },
    'dispatch-direct-arg2': { edits: [["case 'validate': catalogCall('openValidationModal', [m.id, m.table_name, m.status, 'ODS']); break;", "case 'validate': catalogCall('openValidationModal', [m.id, m.table_comment, m.status, 'ODS']); break;"]], probe: "case 'validate': catalogCall('openValidationModal', [m.id, m.table_comment, m.status, 'ODS'])" },
    'pane-link-wrong-id': { fn: 'catalogOpenModel', edits: [["openModelDrawer(id, btn);", "openModelDrawer(id + 1, btn);"]], probe: "openModelDrawer(id + 1, btn)" },
    'pane-link-no-opener': { fn: 'catalogOpenModel', edits: [["openModelDrawer(id, btn);", "openModelDrawer(id);"]], probe: "openModelDrawer(id);" },
    'pane-link-first-node': { fn: 'catalogOpenModel', edits: [["openModelDrawer(id, btn);", "openModelDrawer(id, document.querySelector('[data-open-model=\"' + id + '\"]'));"]], probe: "document.querySelector('[data-open-model=\"' + id + '\"]')" },
    'dispatch-valdata-phase': { edits: [["case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'data']); break;", "case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'semantic']); break;"]], probe: "case 'validate-data': catalogCall('openValidationModal', [m.id, m.table_name, m.status, isDIM ? 'DIM' : 'DWD', 'semantic'])" },
};
const C7_MUT = process.env.C7_MUT || '';
if (C7_MUT && !C7_MUTS[C7_MUT] && !C7_CAT_MUTS[C7_MUT]) { console.error('未知的 C7_MUT：' + C7_MUT); process.exit(2); }

const drawerOpen = (page) => page.evaluate(() => document.getElementById('modelDetailDrawer').classList.contains('open'));
/** 抽屉副标题（#modelDrawerSub）只在详情异步加载后由 renderModelDrawer 写入，openModelDrawer / closeModelDrawer 都不清它：
 *  点击前先在页内清空，点击后用有界 waitForFunction 等它匹配 #<id>（后面不能跟数字），超时返回 false（2e M1：旧写法点击后立刻读，会读到上一次的值或 null） */
const clearDrawerSub = (page) => page.evaluate(() => { const s = document.getElementById('modelDrawerSub'); if (s) { s.textContent = ''; } });
const drawerShowsId = (page, id) => page.waitForFunction((i) => { const s = document.getElementById('modelDrawerSub'); return !!s && new RegExp('#' + i + '(?!\\d)').test(s.textContent); }, id, { timeout: WAIT }).then(() => true, () => false);
/** 帧边界：两个 rAF 之后再读（事件驱动，不是 sleep）；委托本身是同步的，这里只是确保浏览器已处理完该次点击引起的全部同步工作 */
const settle = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const omdCalls = (page) => page.evaluate(() => window.__omd.slice());
const resetCounters = (page) => page.evaluate(() => { window.__omd = []; window.__calls = []; window.__iter = []; });
// 清掉本脚本操作可能弹出的浮层（菜单、设计说明气泡、抽屉）
async function cleanup(page) {
    await page.evaluate(() => {
        document.body.click();   // 关菜单 / 气泡（文档级 click 监听）
        const p = document.getElementById('designNotesPopover'); if (p) p.remove();
    });
}
async function closeIfOpen(page) {
    if (await drawerOpen(page)) {
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT });
    }
}
/** 滚到视口中央再取 boundingBox（boundingBox 是视口坐标，元素在视口外时 mouse.click 点的是空气——R2b 曾因分页滚动把条目滚出视口而空转，2c 修复） */
async function boxInView(loc) { await loc.evaluate((e) => e.scrollIntoView({ block: 'center' })); return loc.boundingBox(); }
/** 点击坐标处的命中元素必须就是 loc 本身（不是按钮 / 子元素 / 空气），否则「点空白处」的用例是空转 */
const hitsItself = (loc, x, y) => loc.evaluate((el, p) => document.elementFromPoint(p[0], p[1]) === el, [x, y]);
const HANDLERS = ['openWorkbench', 'openDimDDLModal', 'openDimETLModal', 'openDwdDDLModal', 'openDwdScriptModal', 'openEditModal', 'openDimConfigViewModal', 'openDwdConfigViewModal', 'viewModelChangeLogs', 'deleteModel', 'openDDLModal', 'openValidationModal'];

(async () => {
    console.log('=== 模型中心 C7 整条目点击 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1700, height: 950 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.dismiss().catch(() => {}));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        // 路由改写：第 1 个条目注入设计说明 + 归档任务数 3，第 2 个条目归档任务数 0
        await page.route((u) => u.pathname === '/api/models', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            const resp = await route.fetch(); const rows = await resp.json();
            if (Array.isArray(rows) && rows.length > 1) {
                rows[0] = Object.assign({}, rows[0], { design_notes: 'c7 注入的设计说明', archived_task_count: 3 });
                rows[1] = Object.assign({}, rows[1], { archived_task_count: 0 });
            }
            await route.fulfill({ response: resp, body: JSON.stringify(rows) });
        });
        if (C7_MUTS[C7_MUT]) {
            await page.route((u) => u.pathname === '/Model_Center.html', async (route) => {
                const resp = await route.fetch(); let body = await resp.text();
                for (const [a, b] of C7_MUTS[C7_MUT]) {
                    const n = body.split(a).length - 1;
                    if (n !== 1) { console.error('C7 变异 ' + C7_MUT + '：锚点出现 ' + n + ' 次（必须恰好 1 次）：' + a); process.exit(2); }
                    body = body.split(a).join(b);
                }
                console.log('  [C7_MUT] ' + C7_MUT + '：已对 Model_Center.html 完成 ' + C7_MUTS[C7_MUT].length + ' 处锚点替换');
                await route.fulfill({ response: resp, body });
            });
        }
        if (C7_CAT_MUTS[C7_MUT]) {
            await page.route((u) => u.pathname === '/assets/js/model-catalog.js', async (route) => {
                const resp = await route.fetch(); let body = await resp.text();
                for (const [a, b] of C7_CAT_MUTS[C7_MUT].edits) {
                    const n = body.split(a).length - 1;
                    if (n !== 1) { console.error('C7 变异 ' + C7_MUT + '：锚点在 model-catalog.js 里出现 ' + n + ' 次（必须恰好 1 次）：' + a); process.exit(2); }
                    body = body.split(a).join(b);
                }
                console.log('  [C7_MUT] ' + C7_MUT + '：已对 model-catalog.js 完成 ' + C7_CAT_MUTS[C7_MUT].edits.length + ' 处锚点替换');
                await route.fulfill({ response: resp, body });
            });
        }
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody [data-id]', { timeout: WAIT });
        await page.waitForLoadState('networkidle', { timeout: WAIT });
        if (C7_CAT_MUTS[C7_MUT]) {   // B1-1：CAT 变异生效探针（catalogDispatchAct 的源码里必须有变异后的片段）
            const liveCat = await page.evaluate(([fn, p]) => window[fn].toString().includes(p), [C7_CAT_MUTS[C7_MUT].fn || 'catalogDispatchAct', C7_CAT_MUTS[C7_MUT].probe]);
            console.log('  [C7_MUT] 页内 ' + (C7_CAT_MUTS[C7_MUT].fn || 'catalogDispatchAct') + ' 含变异片段=' + liveCat);
            if (!liveCat) throw new Error('C7 变异 ' + C7_MUT + ' 没有在页内生效（探针不成立）');
        } else if (C7_MUT) {   // 变异生效探针：页内 C7 委托的源码里排除选择器确实被改
            const live = await page.evaluate(() => { const src = initModelDrawer.toString(); return { actions: src.includes('.pane, .model-row-actions'), menu: src.includes('[role="menu"], [role="menuitem"]'), offRow: src.includes('openModelDrawer(id + 1, tr.querySelector'), offBtn: src.includes('openModelDrawer(id + 1, btn)'), selGuard: src.includes('sel.isCollapsed'), paneEx: src.includes('.pane, '), menuThenActions: src.includes('[role="menuitem"], .model-row-actions') }; });
            console.log('  [C7_MUT] 页内 initModelDrawer 仍含 .model-row-actions 排除=' + live.actions + '，仍含菜单排除=' + live.menu + '，整条目路径 id+1=' + live.offRow + '，表名按钮路径 id+1=' + live.offBtn);
            const want = C7_MUT === 'no-actions-exclude' ? !live.actions : C7_MUT === 'no-container-exclude' ? (!live.actions && !live.menu) : C7_MUT === 'wrong-id' ? (live.offRow && !live.offBtn) : C7_MUT === 'no-select-guard' ? !live.selGuard : C7_MUT === 'no-pane-exclude' ? (!live.paneEx && live.menuThenActions) : (live.offBtn && !live.offRow);
            if (!want) throw new Error('C7 变异 ' + C7_MUT + ' 没有在页内生效（探针不成立）');
        }
        // 打桩：openModelDrawer 计数（调用原函数）；12 个处理函数 + viewIterationHistory 只记录
        await page.evaluate((names) => {
            window.__omd = []; window.__calls = []; window.__iter = [];
            const orig = window.openModelDrawer;
            window.openModelDrawer = function (id) { window.__omd.push(id); return orig.apply(this, arguments); };
            names.forEach((n) => { window[n] = function () { window.__calls.push({ fn: n, args: Array.prototype.slice.call(arguments) }); }; });
            window.viewIterationHistory = function (id) { window.__iter.push(id); };
        }, HANDLERS);

        const ents = page.locator('#modelListBody [data-id]');
        const E = (id) => page.locator(`#modelListBody [data-id="${id}"]`);
        const pick = await page.evaluate(() => {
            const es = Array.from(document.querySelectorAll('#modelListBody [data-id]')); const idOf = (e) => Number(e.getAttribute('data-id'));
            const w = (sel) => { const e = es.find((x) => x.querySelector(sel)); return e ? idOf(e) : null; };
            return { first: idOf(es[0]), second: idOf(es[1]), more: w('[data-menu="more"]'), val: w('[data-menu="validate"]'), notes: w('[data-entry="design-notes"]'), direct: w('.model-row-actions > [data-act="validate"]:not([disabled])'), n: es.length };
        });
        const rowId = pick.first;
        expect(Number.isInteger(rowId) && rowId > 0, `首个条目 data-id 可用（#${rowId}）`, rowId);
        expect(pick.more === rowId && pick.notes === rowId && pick.val !== null, `前提：首个条目有 ⋯ 与注入的设计说明按钮（#${pick.more}/#${pick.notes}），页上有带验收阶段菜单的条目 #${pick.val}`, pick);
        const first = E(rowId);
        // B3-2：期望值的数据来源——页面 allModelsData 里该条目的行（只读事实），向量由测试手写，不调用 catalogDispatchAct / catalogRowCopy
        const rowFacts = (id) => page.evaluate((i) => { const m = allModelsData.find((x) => x.id == i); return m ? { id: m.id, table_name: m.table_name, status: m.status, layer: m.layer, companion_of: m.companion_of, config_mode: m.config_mode } : null; }, id);
        const layerWant = (f) => (String(f.layer === null || f.layer === undefined ? '' : f.layer).toUpperCase() === 'DIM' ? 'DIM' : 'DWD');   // catalogDispatchAct 现口径：DIM → 'DIM'，其余 → 'DWD'
        const argsSameRef = (id) => page.evaluate((i) => { const c = window.__calls; return c.length === 1 && c[0].args[0] === allModelsData.find((x) => x.id == i); }, id);   // 实参是否就是 allModelsData 里的那个对象
        // 前提（2e）：路由改写按 API 返回的 rows[0] / rows[1] 注入，渲染出的首个 / 第二个条目必须就是这两行，R3 / R9 才有确定的数据
        const inj = await page.evaluate((ids) => ids.map((i) => { const m = allModelsData.find((x) => x.id == i); return m ? { id: m.id, notes: m.design_notes || null, n: m.archived_task_count } : null; }), [rowId, pick.second]);
        expect(!!inj[0] && inj[0].notes === 'c7 注入的设计说明' && inj[0].n === 3, `前提：首个条目（#${rowId}）就是注入了设计说明且归档任务数 3 的那一行`, inj[0]);
        expect(!!inj[1] && inj[1].n === 0, `前提：第二个条目（#${pick.second}）就是归档任务数 0 的那一行`, inj[1]);

        // ===== R1 点非交互区打开 =====
        console.log('R1. 点条目首行 / 第二行的非交互区打开抽屉');
        for (const [label, sel] of [['首行：分层徽章（span）', '.catalog-row1 .catalog-layer'], ['首行：负责人格', '.catalog-row1 .catalog-owner'], ['第二行：#id', '.catalog-row2 .catalog-id'], ['第二行：关系计数', '.catalog-row2 .catalog-rel']]) {
            await resetCounters(page);   // 2e M1：先清计数，再点；调用序列同步、确定，是主断言
            await clearDrawerSub(page);
            await first.locator(sel).first().click();
            await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
            expect(await drawerOpen(page) && J(await omdCalls(page)) === J([rowId]), `点${label} → 抽屉打开，openModelDrawer 调用序列恰为 [${rowId}]`, { open: await drawerOpen(page), omd: await omdCalls(page) });
            expect(await drawerShowsId(page, rowId), `点${label} → 抽屉副标题随详情加载匹配 #${rowId}`, { want: rowId });
            await closeIfOpen(page);
        }

        // ===== R2 点操作类元素不打开 =====
        console.log('R2. 点 ⋯ / 菜单项 / 验收 / 设计说明 / 分页不打开抽屉');
        const noDrawer = async (label) => { await settle(page); expect(!(await drawerOpen(page)) && (await omdCalls(page)).length === 0, `${label} → 抽屉未打开、openModelDrawer 调用 0 次`, { open: await drawerOpen(page), omd: await omdCalls(page) }); };
        await resetCounters(page);
        await first.locator('[data-menu="more"]').click();
        await noDrawer('点 ⋯ 触发按钮');
        await first.locator('[role="menuitem"][data-act="history"]').click();
        await settle(page);
        const hc = await page.evaluate(() => window.__calls);
        expect(hc.length === 1 && hc[0].fn === 'viewModelChangeLogs' && hc[0].args[0] === rowId, '点菜单项「变更历史」→ viewModelChangeLogs(该条目 id) 恰 1 次（本职功能仍在，排除「双关」假通过）', hc);
        await noDrawer('点菜单项「变更历史」');
        await cleanup(page);
        // 验收：阶段菜单 + 菜单项
        await resetCounters(page);
        await E(pick.val).locator('[data-menu="validate"]').click();
        await noDrawer(`点验收阶段菜单触发按钮（#${pick.val}）`);
        await E(pick.val).locator('[role="menuitem"][data-act="validate-structure"]').click();
        await settle(page);
        const vc = await page.evaluate(() => window.__calls);
        const vf = await rowFacts(pick.val);
        expect(vc.length === 1 && vc[0].fn === 'openValidationModal' && J(vc[0].args) === J([vf.id, vf.table_name, vf.status, layerWant(vf), 'structure']), `点验收菜单项「结构验收」→ openValidationModal 恰 1 次、完整参数向量 [id, 表名, 状态, ${layerWant(vf)}, 'structure']（期望由页面数据手写）`, { calls: vc, facts: vf });
        await noDrawer('点验收菜单项');
        await cleanup(page);
        if (pick.direct !== null) {
            await resetCounters(page);
            await E(pick.direct).locator('.model-row-actions > [data-act="validate"]').click();
            await settle(page);
            const dc = await page.evaluate(() => window.__calls);   // 39 B1-1：核函数名与参数（catalogDispatchAct 'validate' 分支 4 参数：id / 表名 / 状态 / 'ODS'）
            const df = await rowFacts(pick.direct);
            expect(dc.length === 1 && dc[0].fn === 'openValidationModal' && J(dc[0].args) === J([df.id, df.table_name, df.status, 'ODS']), `点验收直接按钮（#${pick.direct}）→ openValidationModal 恰 1 次、完整参数向量 [id, 表名, 状态, 'ODS']（期望由页面数据手写）`, { calls: dc, facts: df });
            await noDrawer('点验收直接按钮');
        } else {
            expect(false, '页上没有可用的验收直接按钮（ODS 条目）→ 该路径回归无法验证（需保证列表含至少 1 条有验收权限的 ODS）');
        }
        await resetCounters(page);
        await first.locator('[data-entry="design-notes"]').click();
        await noDrawer('点设计说明按钮');
        await cleanup(page);
        const totalPages = await page.evaluate(() => getCatalogView().totalPages);
        expect(totalPages > 1, '前提：列表不止一页（需要分页按钮）', totalPages);
        // 注：#paginationControls 不在 #modelListBody 内，对 C7 委托（挂在 #modelListBody 上）没有判别力——这一步只证明「别的监听没有因分页点击打开抽屉」
        const nextBtn = page.locator('#paginationControls button', { hasText: '下一页' });
        const nextN = await nextBtn.count();
        const preCp = await page.evaluate(() => currentPage);
        const nextOk = nextN === 1 && preCp === 1 && (await nextBtn.isEnabled());
        expect(nextOk, '前提：当前在第 1 页，且「下一页」按钮恰 1 个、未禁用（不成立则不点，直接判失败）', { nextN, preCp });
        if (nextOk) {
            const page1First = await page.evaluate(() => { const e = document.querySelector('#modelListBody [data-id]'); return e ? Number(e.getAttribute('data-id')) : null; });
            await resetCounters(page);
            await nextBtn.click();
            const moved = await page.waitForFunction(() => currentPage === 2, null, { timeout: WAIT }).then(() => true, () => false);
            expect(moved, '点「下一页」后 currentPage 变为 2（分页点击确实生效，不是空转）', await page.evaluate(() => currentPage));
            await noDrawer('点分页「下一页」');
            await page.evaluate(() => goToPage(1));
            // 回第 1 页后等列表渲染完成：等待信号绑在列表上（就绪标记 + 首个条目 id 等于回页前记录的第 1 页首条）
            const back = await page.waitForFunction((want) => { const l = document.getElementById('modelListBody'); const e = l && l.querySelector('[data-id]'); return currentPage === 1 && !!l && l.getAttribute('data-catalog-state') === 'ready' && !!e && Number(e.getAttribute('data-id')) === want; }, page1First, { timeout: WAIT }).then(() => true, () => false);
            expect(back, `回第 1 页后列表渲染完成（data-catalog-state=ready 且首个条目是 #${page1First}）`, page1First);
        }
        await cleanup(page);

        // ===== R2b 操作区空隙 / 内边距不打开 =====
        console.log('R2b. 操作区空隙与内边距不打开抽屉');
        const actions = first.locator('.model-row-actions');
        expect(await actions.count() > 0, '条目带 .model-row-actions 标记');
        if (await actions.count() > 0) {
            await resetCounters(page);
            const ab = await boxInView(actions);
            expect(await hitsItself(actions, ab.x + 3, ab.y + ab.height / 2), '前提：点击点（操作区左端）的命中元素就是 .model-row-actions 本身', ab);
            await page.mouse.click(ab.x + 3, ab.y + ab.height / 2);   // 操作区左端的空白（flex-end 对齐，按钮在右侧）
            await noDrawer('点操作区左端空白');
            await closeIfOpen(page);   // 判红时抽屉已被打开，关掉它，免得后面的点击点被遮罩盖住而连带误报
            const kids = first.locator('.model-row-actions > *');
            if (await kids.count() >= 2) {
                const b1 = await kids.nth(0).boundingBox(); const b2 = await kids.nth(1).boundingBox();
                expect(await hitsItself(actions, (b1.x + b1.width + b2.x) / 2, b1.y + b1.height / 2), '前提：点击点（两个控件之间）的命中元素就是 .model-row-actions 本身', { b1, b2 });
                await page.mouse.click((b1.x + b1.width + b2.x) / 2, b1.y + b1.height / 2);
                await noDrawer('点操作区内两个控件之间的 gap');
            } else {
                expect(false, '操作区内不足两个控件 → gap 回归无法验证');
            }
            await cleanup(page);
        }
        await closeIfOpen(page);

        // ===== R3 设计说明气泡 =====
        console.log('R3. 点「设计说明」图标：不开抽屉、气泡出现');
        await resetCounters(page);
        await first.locator('[data-entry="design-notes"]').click();
        await settle(page);
        const pop = await page.evaluate(() => { const p = document.getElementById('designNotesPopover'); return p ? p.innerText : null; });
        expect(pop !== null && pop.includes('c7 注入的设计说明'), '气泡出现且内容是该条目的设计说明', pop);
        await noDrawer('点设计说明图标');
        await cleanup(page);

        // ===== R4 表名按钮 =====
        console.log('R4. 表名按钮原路径');
        await resetCounters(page);   // 2e M1：先清计数；调用序列全等于 [rowId] 同时证明「id 对」与「恰 1 次」
        await clearDrawerSub(page);
        await first.locator('.model-open-btn').first().click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        expect(J(await omdCalls(page)) === J([rowId]), `点表名按钮 → openModelDrawer 调用序列恰为 [${rowId}]（id 对、恰 1 次；CAT 的列表委托不重复处理 .model-open-btn）`, await omdCalls(page));
        expect(await drawerShowsId(page, rowId), `点表名按钮 → 抽屉副标题随详情加载匹配 #${rowId}`, { want: rowId });
        await closeIfOpen(page);

        // ===== R5 焦点归还 =====
        console.log('R5. 整条目点击后关闭 → 焦点归还表名按钮');
        await first.locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT });
        const focusInfo = await page.evaluate((id) => {
            const el = document.activeElement;
            const row = document.querySelector(`#modelListBody [data-id="${id}"]`);
            const target = row ? row.querySelector('.model-open-btn') : null;
            return { isOpenBtn: !!el && el === target, cls: el ? el.className : null };
        }, rowId);
        expect(focusInfo.isOpenBtn, '焦点归还到该条目 .model-open-btn（条目根不可聚焦，需代理）', focusInfo);

        // ===== R6 拖选文本不打开 =====
        console.log('R6. 拖选文本后松开不打开抽屉');
        // 2e：拖选一段更长的文本节点（第二行 .catalog-impl：有实现说明就是说明，没有就是「（未填写实现说明）」，恒非空）；拖不出选区 = 前提失败，不再静默计 PASS
        const dragCell = first.locator('.catalog-row2 .catalog-impl');
        const box = await boxInView(dragCell);
        expect(!!box, '前提：第二行 .catalog-impl 可见且有位置（拖选用）', box);
        if (box) {
            await resetCounters(page);
            // 选区文本在 click 的捕获阶段（先于列表委托）记下来：守卫被去掉时抽屉打开会清掉选区，松开之后再读就是空串，前提断言会红在错的地方
            await page.evaluate(() => { window.__selAtClick = null; document.addEventListener('click', () => { window.__selAtClick = (window.getSelection() || '').toString().trim(); }, { capture: true, once: true }); });
            await page.mouse.move(box.x + 2, box.y + box.height / 2);
            await page.mouse.down();
            await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 });
            await page.mouse.up();
            await settle(page);
            const selText = await page.evaluate(() => window.__selAtClick || '');
            const opened = await drawerOpen(page);
            expect(!!selText, `前提：拖选形成了非空选区（「${selText.slice(0, 12)}」）`, { selText, box });
            if (selText) {
                expect(!opened && (await omdCalls(page)).length === 0, `拖出选区「${selText.slice(0, 12)}」→ 抽屉未打开、openModelDrawer 调用 0 次`, { selText, opened, omd: await omdCalls(page) });
            }
            await page.evaluate(() => { const s = window.getSelection(); if (s) s.removeAllRanges(); });
        }
        await closeIfOpen(page);

        // ===== R6b 残留选区不误挡 =====
        console.log('R6b. 别处残留选区不误挡条目点击');
        const leftover = await page.evaluate(() => {
            const host = Array.from(document.querySelectorAll('h1, h2, h3, label, .card-title, .section-title')).find(el => (el.textContent || '').trim().length > 1);
            if (!host) { return null; }
            const r = document.createRange(); r.selectNodeContents(host);
            const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
            return s.toString().trim();
        });
        expect(!!leftover, `在条目外构造残留选区「${(leftover || '').slice(0, 12)}」`, leftover);
        if (leftover) {
            await first.locator('.catalog-row2 .catalog-id').click();
            await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
            expect(await drawerOpen(page), '残留选区存在时单击条目仍能打开（mousedown 已清旧选区，守卫不误挡）');
            await closeIfOpen(page);
        }

        // ===== R7 选中高亮（P30）=====
        console.log('R7. .selected-row：条目内任意点击都选中（P30）');
        const selected = () => page.evaluate(() => Array.from(document.querySelectorAll('#modelListBody .selected-row')).map((e) => Number(e.getAttribute('data-id'))));
        const second = pick.second;
        await first.locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        expect(J(await selected()) === J([rowId]), '点条目第二行 → 该条目 .selected-row（且全表只有它）', await selected());
        await closeIfOpen(page);
        await first.locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        expect(J(await selected()) === J([rowId]), '重复点击同一条目：保持选中（不是切换）', await selected());
        await closeIfOpen(page);
        await resetCounters(page);
        await E(second).locator('[data-menu="more"]').click();
        expect(J(await selected()) === J([second]), `点另一个条目（#${second}）的 ⋯ → 选中移到它、清掉旧的（P30：⋯ 也算条目内点击）`, await selected());
        await E(second).locator('[role="menuitem"][data-act="history"]').click();
        expect(J(await selected()) === J([second]), '点它的菜单项 → 仍选中它', await selected());
        await first.locator('[data-entry="design-notes"]').click();
        expect(J(await selected()) === J([rowId]), '点首个条目的设计说明按钮 → 选中首个条目（P30：设计说明也算）', await selected());
        await cleanup(page);
        // 39 B1-5 / B3-1：验收直接按钮 / 验收阶段菜单项 / ⋯ 菜单里的另一项（edit-info）。每种先把选中落到「另一个条目」再点目标，选中必须只剩目标、旧条目被清除（处理函数已打桩，不弹窗）。
        //   两个菜单项场景（B3-1）：点触发按钮本身就会选中目标条目，会掩盖「点菜单项不选中」的回归——所以展开菜单之后、点菜单项之前，在页内直接把 .selected-row 重设到 decoy
        //   （只增删 class，不碰菜单，菜单保持展开），断言此刻只有 decoy 被选中、菜单仍可见，再点菜单项，选中必须回到目标。
        const decoyFor = (t) => (t === rowId ? second : rowId);
        const setSelectedInPage = (id) => page.evaluate((i) => {
            document.querySelectorAll('#modelListBody .selected-row').forEach((e) => e.classList.remove('selected-row'));
            const d = document.querySelector('#modelListBody [data-id="' + i + '"]'); if (d) d.classList.add('selected-row');
        }, id);
        for (const [label, target, openMenu, clickItem, act] of [
            ['验收直接按钮', pick.direct, null, async (t) => { await E(t).locator('.model-row-actions > [data-act="validate"]').click(); }, null],
            ['验收阶段菜单项（结构验收）', pick.val, async (t) => { await E(t).locator('[data-menu="validate"]').click(); }, async (t) => { await E(t).locator('[role="menuitem"][data-act="validate-structure"]').click(); }, 'validate-structure'],
            ['⋯ 菜单里的另一项（编辑信息）', pick.more, async (t) => { await E(t).locator('[data-menu="more"]').click(); }, async (t) => { await E(t).locator('[role="menuitem"][data-act="edit-info"]').click(); }, 'edit-info'],
        ]) {
            if (target === null) { expect(false, `R7 ${label}：页上没有可点的目标条目 → 该路径的选中无法验证`); continue; }
            await cleanup(page);
            await resetCounters(page);
            const dec = decoyFor(target);
            await E(dec).locator('[data-menu="more"]').click();
            expect(J(await selected()) === J([dec]), `前提（${label}）：先选中另一个条目 #${dec}，全表只有它`, await selected());
            await cleanup(page);
            if (openMenu) {
                await openMenu(target);
                const menuLoc = E(target).locator('[role="menu"]:not([hidden])');
                await menuLoc.waitFor({ state: 'visible', timeout: WAIT });
                await setSelectedInPage(dec);
                expect(J(await selected()) === J([dec]) && (await menuLoc.isVisible()), `前提（${label}）：菜单展开后把选中重设到 #${dec}（只改 class，不关菜单）：此刻全表只有 #${dec} 被选中，菜单仍可见`, { selected: await selected(), menuVisible: await menuLoc.isVisible() });
            }
            await clickItem(target);
            await settle(page);
            const calls7 = await page.evaluate(() => window.__calls);
            expect(J(await selected()) === J([target]) && (await omdCalls(page)).length === 0, `点${label}（#${target}）→ 选中恰为 #${target}（唯一，旧条目 #${dec} 被清除），且没有打开抽屉`, { selected: await selected(), omd: await omdCalls(page) });
            if (act === 'validate-structure') {
                const tf = await rowFacts(target);
                expect(calls7.length === 1 && calls7[0].fn === 'openValidationModal' && J(calls7[0].args) === J([tf.id, tf.table_name, tf.status, layerWant(tf), 'structure']), `点${label}（#${target}）→ openValidationModal 恰 1 次、完整参数向量 [id, 表名, 状态, ${layerWant(tf)}, 'structure']（期望由页面数据手写）`, { calls: calls7, facts: tf });
            }
            if (act === 'edit-info') {
                expect(calls7.length === 1 && calls7[0].fn === 'openEditModal', `点${label}（#${target}）→ openEditModal 恰 1 次`, calls7);
            }
        }
        await cleanup(page);
        await closeIfOpen(page);

        // ===== R8 菜单项不双开 =====
        console.log('R8. ⋯ 菜单与验收阶段菜单的菜单项不同时开抽屉');
        // 39 B1-1 / B3-2：期望由页面数据（allModelsData 里该条目的行）手写，不调用被测分发函数或 catalogRowCopy：
        //   edit-info → openEditModal 的唯一实参：id / table_name / layer / companion_of / config_mode 与该行相等，且不是 allModelsData 里那个对象本身；
        //   validate-data → openValidationModal(id, 表名, 状态, 层级（DIM → 'DIM'，否则 'DWD'）, 'data') 完整向量。
        const R8_WANT = {
            'edit-info': (c, f, same) => c.length === 1 && c[0].fn === 'openEditModal' && c[0].args.length === 1 && !!c[0].args[0] && typeof c[0].args[0] === 'object' && c[0].args[0].id === f.id && c[0].args[0].table_name === f.table_name && c[0].args[0].layer === f.layer && c[0].args[0].companion_of === f.companion_of && c[0].args[0].config_mode === f.config_mode && same === false,
            'validate-data': (c, f) => c.length === 1 && c[0].fn === 'openValidationModal' && J(c[0].args) === J([f.id, f.table_name, f.status, layerWant(f), 'data']),
        };
        for (const [label, id, kind, itemSel, act] of [['⋯ 菜单', pick.more, 'more', '[role="menuitem"][data-act="edit-info"]', 'edit-info'], ['验收阶段菜单', pick.val, 'validate', '[role="menuitem"][data-act="validate-data"]', 'validate-data']]) {
            await resetCounters(page);
            // C4d-a（带入项 ②，对布局敏感）：点触发按钮前先把它滚到固定导航栏下方的可见区，并用 elementFromPoint 确认点击点命中的就是触发按钮自身（不被导航栏或其他元素遮挡）；前提不成立判失败（不改页面行为）
            const trig8 = E(id).locator(`[data-menu="${kind}"]`);
            const tb8 = await boxInView(trig8);
            const navBottom8 = await page.evaluate(() => { const n = document.querySelector('.navbar'); return n ? n.getBoundingClientRect().bottom : 0; });
            const posOk8 = !!tb8 && tb8.y >= navBottom8;
            expect(posOk8, `前提：${label}触发按钮（#${id}）已滚到固定导航栏下方（按钮上沿 y ≥ 导航栏下沿）`, { tb8, navBottom8 });
            const hitOk8 = !!tb8 && await hitsItself(trig8, tb8.x + tb8.width / 2, tb8.y + tb8.height / 2);
            expect(hitOk8, `前提：点击点（${label}触发按钮中心）命中的元素就是该触发按钮自身（不被导航栏或其他元素遮挡）`, tb8);
            // codex 42Tc 建议：前提不成立（盒子 / 导航栏下沿 / 命中自身）= 已记失败，跳过本次点击与后续菜单步骤，不等 trig8.click() 的点击超时
            if (!(posOk8 && hitOk8)) { console.log(`  （R8：${label}触发按钮的点击前提不成立，已跳过本次点击与后续菜单步骤）`); await cleanup(page); continue; }
            await trig8.click();
            const menu = E(id).locator('[role="menu"]:not([hidden])');
            const mb = await boxInView(menu);
            expect(!!mb, `${label}（#${id}）已展开`);
            if (mb) {
                expect(await hitsItself(menu, mb.x + mb.width - 2, mb.y + 1), `前提：点击点（${label}上沿）的命中元素就是该 [role=menu] 本身`, mb);
                await page.mouse.click(mb.x + mb.width - 2, mb.y + 1);   // 菜单上沿（边框 / 内边距）——既非 button 也非菜单项
                await noDrawer(`点${label}内边距`);
            }
            if (!(await menu.isVisible())) {   // 39 B1-2：按可见性判断（count 只数 DOM 里有没有，hidden 菜单也可能还在）；不可见就重新点触发按钮并有界等到菜单可见
                await E(id).locator(`[data-menu="${kind}"]`).click();
                await menu.waitFor({ state: 'visible', timeout: WAIT });
            }
            await resetCounters(page);
            const f8 = await rowFacts(id);
            await E(id).locator(itemSel).click();
            await settle(page);
            const c8 = await page.evaluate(() => window.__calls);
            const same8 = await argsSameRef(id);
            expect(R8_WANT[act](c8, f8, same8), `点${label}菜单项（${act}）→ 恰调用 1 次且函数与完整参数全对（期望由页面数据手写${act === 'edit-info' ? '；实参的 id / table_name / layer / companion_of / config_mode 与该行相等，且不是 allModelsData 里的那个对象' : ''}）`, { calls: c8, facts: f8, sameRef: same8 });
            await noDrawer(`点${label}菜单项`);
            await cleanup(page);
        }
        await closeIfOpen(page);

        // ===== R9 抽屉「迭代历史 →」 =====
        console.log('R9. 抽屉「迭代历史 →」显示规则与调用');
        await resetCounters(page);
        await first.locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        await page.waitForSelector('#modelDrawerBody .foot-links', { timeout: WAIT });
        const links1 = await page.$$eval('#modelDrawerBody .foot-links button', (b) => b.map((x) => x.textContent));
        expect(links1.includes('迭代历史 →'), `归档任务数 3 的条目（#${rowId}）：抽屉有「迭代历史 →」`, links1);
        await page.locator('#modelDrawerBody .foot-links button', { hasText: '迭代历史 →' }).click();
        expect(J(await page.evaluate(() => window.__iter)) === J([rowId]), '点它 → viewIterationHistory(该条目 id) 恰 1 次（桩记录）', await page.evaluate(() => window.__iter));
        await closeIfOpen(page);
        await E(second).locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        await page.waitForSelector('#modelDrawerBody .foot-links', { timeout: WAIT });
        const links2 = await page.$$eval('#modelDrawerBody .foot-links button', (b) => b.map((x) => x.textContent));
        const none2 = await page.$eval('#modelDrawerBody .foot-links .foot-none', (e) => e.textContent).catch(() => null);
        expect(!links2.includes('迭代历史 →') && none2 === '暂无迭代历史', `归档任务数 0 的条目（#${second}）：灰色「暂无迭代历史」、没有「迭代历史 →」按钮`, { links2, none2 });
        await closeIfOpen(page);

        // ===== R11 / R11b 展开面板（C4c-3 3a）=====
        console.log('R11. 点展开按钮 / 面板空白处不开抽屉；R11b. 点面板里的模型链接打开那个模型的抽屉');
        // 关系响应由路由手写（真实库副本里该条目的下游不确定）：下游只有第二个条目，链接 [data-open-model="<second>"]
        await page.route((u) => /^\/api\/models\/\d+\/relations$/.test(u.pathname), async (route) => {
            const body = { upstream: [], downstream: [{ id: pick.second, table_name: 'c7_down_link', table_comment: 'c7 下游', layer: 'dwd', status: 'ONLINE', config_mode: 'standard' }], objects: [], objectState: 'standard' };
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        });
        await resetCounters(page);
        await first.locator('[data-expand-toggle]').click();
        const paneUp = await page.waitForSelector(`#modelListBody [data-id="${rowId}"] > .pane.catalog-pane-loaded`, { timeout: WAIT }).then(() => true, () => false);
        expect(paneUp, `前提：点首个条目（#${rowId}）的展开按钮后面板 loaded`);
        await noDrawer('点展开按钮');
        const pane = first.locator('.pane');
        const pb = await boxInView(pane);
        expect(!!pb, '前提：面板可见且有位置', pb);
        if (pb) {
            const px = pb.x + 6, py = pb.y + pb.height / 2;   // 面板左内边距（38px）里的一点：命中元素就是 .pane 本身
            expect(await hitsItself(pane, px, py), '前提：点击点（面板左内边距）的命中元素就是 .pane 本身', pb);
            await resetCounters(page);
            await page.mouse.click(px, py);
            await noDrawer('R11 点面板空白处（内边距）');
            await closeIfOpen(page);   // 判红时抽屉已被打开，关掉它，免得后面的点击被遮罩盖住而连带误报
        }
        // R11b：点面板里指向第二个条目的链接
        const link = first.locator(`.pane button[data-open-model="${pick.second}"]`);
        expect(await link.count() === 1 && (await link.textContent()) === 'c7_down_link', `前提：面板里恰有 1 个指向 #${pick.second} 的链接 button[data-open-model]，文字 c7_down_link`, await link.count());
        const linkAttrs = await link.evaluate((b) => ({ cls: b.classList.contains('model-open-btn'), entry: b.hasAttribute('data-entry'), act: b.hasAttribute('data-act') }));
        expect(linkAttrs.cls === false && linkAttrs.entry === false && linkAttrs.act === false, '面板链接不是 .model-open-btn，也不带 data-entry / data-act（DOM 契约 2）', linkAttrs);
        await resetCounters(page);
        await clearDrawerSub(page);
        // 完整参数向量：旁听器记下 openModelDrawer 的参数个数、目标 id、第 2 个参数（opener 元素）是否就是被点击的链接（data-open-model 等于目标 id、标签 BUTTON）
        await page.evaluate(() => { window.__omdFull = []; const o = window.openModelDrawer; window.openModelDrawer = function (id, el) { window.__omdFull.push({ n: arguments.length, id: id, openerAttr: el && el.getAttribute ? el.getAttribute('data-open-model') : null, openerTag: el ? el.tagName : null, same: el === window.__linkNode }); return o.apply(this, arguments); }; });
        await link.evaluate((b) => { window.__linkNode = b; });   // 3d（40Tc-M1）：存下要点的链接节点，旁听器比较传入的 opener 是不是它（节点身份）
        await link.click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT }).catch(() => {});
        expect(J(await omdCalls(page)) === J([pick.second]), `点面板链接 → openModelDrawer 调用序列恰为 [${pick.second}]（目标模型的 id，不是所在条目 #${rowId}，也不是重复调用）`, await omdCalls(page));
        expect(J(await page.evaluate(() => window.__omdFull)) === J([{ n: 2, id: pick.second, openerAttr: String(pick.second), openerTag: 'BUTTON', same: true }]), `点面板链接 → openModelDrawer 完整参数向量恰为 [{2 个参数, id=${pick.second}, opener=data-open-model 为 ${pick.second} 的 BUTTON 且 === 被点击的那个链接节点}]（期望手写）`, await page.evaluate(() => window.__omdFull));
        expect(await drawerShowsId(page, pick.second), `点面板链接 → 抽屉副标题随详情加载匹配 #${pick.second}（打开的是目标模型的抽屉）`, { want: pick.second });
        await closeIfOpen(page);
        await first.locator('[data-expand-toggle]').click();   // 收起，免得面板影响后面的用例
        expect((await first.locator('.pane').count()) === 0, '收起：面板撤掉');

        // R11c（3d，40Tc-M1）：两个展开面板指向同一目标模型——点第二个面板里的链接，传给 openModelDrawer 的 opener 必须是被点的那个节点（不是第一个面板里指向同一目标的链接；处理函数用 document.querySelector 取节点会取到第一个）
        const third = await page.evaluate(() => Number(document.querySelectorAll('#modelListBody [data-id]')[2].getAttribute('data-id')));
        await first.locator('[data-expand-toggle]').click();
        await E(third).locator('[data-expand-toggle]').click();
        const loadedSel = (id) => `#modelListBody [data-id="${id}"] > .pane.catalog-pane-loaded`;
        const bothUp = (await page.waitForSelector(loadedSel(rowId), { timeout: WAIT }).then(() => true, () => false)) && (await page.waitForSelector(loadedSel(third), { timeout: WAIT }).then(() => true, () => false));
        expect(bothUp, `前提：#${rowId} 与 #${third} 两个面板都 loaded`);
        const linkA = first.locator(`.pane button[data-open-model="${pick.second}"]`);
        const linkC = E(third).locator(`.pane button[data-open-model="${pick.second}"]`);
        const nA = await linkA.count(); const nC = await linkC.count();
        expect(nA === 1 && nC === 1 && third !== rowId && third !== pick.second, `前提：两个面板（#${rowId}、#${third}）各有 1 个指向 #${pick.second} 的链接，第三个条目不是前两个`, { third, nA, nC });
        if (nC === 1) {
            await resetCounters(page);
            await page.evaluate(() => { window.__omdFull = []; });
            await linkC.evaluate((b) => { window.__linkNode = b; });
            await clearDrawerSub(page);
            await linkC.click();
            await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT }).catch(() => {});
            expect(J(await page.evaluate(() => window.__omdFull)) === J([{ n: 2, id: pick.second, openerAttr: String(pick.second), openerTag: 'BUTTON', same: true }]), `点第二个面板（#${third}）里的链接 → openModelDrawer 的 opener 就是被点击的那个链接节点（不是第一个面板 #${rowId} 里指向同一目标的链接）`, await page.evaluate(() => window.__omdFull));
            await closeIfOpen(page);
        }
        await first.locator('[data-expand-toggle]').click();
        await E(third).locator('[data-expand-toggle]').click();
        expect((await page.locator('#modelListBody .pane').count()) === 0, '收起两个面板：面板全部撤掉');

        // ===== R10 重渲染后焦点兜底 + 悬停样式 =====
        console.log('R10. 重渲染替换 opener 后焦点仍归还；悬停样式；表名无下划线');
        const openerHandle = await first.locator('.model-open-btn').first().elementHandle();
        await first.locator('.catalog-row2 .catalog-id').click();
        await page.waitForSelector('#modelDetailDrawer.open', { timeout: WAIT });
        await page.evaluate(() => renderModelsPage());   // 抽屉打开期间强制重渲染 → 原 opener 节点被替换
        const openerDetached = await openerHandle.evaluate(el => !document.contains(el)).catch(() => null);
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'), null, { timeout: WAIT });
        const fb = await page.evaluate((id) => {
            const el = document.activeElement;
            const row = document.querySelector(`#modelListBody [data-id="${id}"]`);
            const target = row ? row.querySelector('.model-open-btn') : null;
            return { ok: !!el && el === target, tag: el ? el.tagName : null };
        }, rowId);
        expect(openerDetached === true, '重渲染确实使原 opener 脱离 DOM（兜底分支被真正触发）', openerDetached);
        expect(fb.ok, '重渲染后焦点仍归还到该条目表名按钮（未掉到 body）', { openerDetached, ...fb });
        // 悬停样式：读卡片（.catalog-group）的计算边框色 / 阴影；过渡（0.15s）期间的值不算数，每次都等连续 3 帧不变再取（事件驱动，不用 sleep）
        const settledCard = () => page.evaluate((id) => new Promise((resolve) => {
            const g = document.querySelector('#modelListBody [data-id="' + id + '"]').closest('.catalog-group');
            let last = null, same = 0, n = 0;
            const tick = () => { const cs = getComputedStyle(g); const cur = cs.borderTopColor + '|' + cs.boxShadow; same = cur === last ? same + 1 : 0; last = cur; if (same >= 3 || ++n > 90) return resolve({ border: cs.borderTopColor, shadow: cs.boxShadow }); requestAnimationFrame(tick); };
            tick();
        }), rowId);
        await page.mouse.move(2, 2);
        const before = await settledCard();
        await first.locator('.catalog-row2 .catalog-id').hover();
        const afterHover = await settledCard();
        const changed = afterHover.border !== before.border || afterHover.shadow !== before.shadow;
        expect(changed, '悬停条目：卡片边框色或阴影相对悬停前有变化（读计算样式，不锁颜色值）', { before, afterHover });
        await first.locator('.model-open-btn').first().hover();
        const decos = await page.$$eval('#modelListBody .model-open-btn', els => els.slice(0, 4).map(e => getComputedStyle(e).textDecorationLine));
        expect(decos.length > 0, '前提：取到至少 1 个表名按钮（下面的 .every 不是对空集合成立）', decos.length);
        expect(decos.every(d => d === 'none'), '表名按钮无下划线（含悬停态）', decos);
        const underlineRule = await page.evaluate(() => {
            for (const sheet of document.styleSheets) {
                let list; try { list = sheet.cssRules; } catch (e) { continue; }
                for (const r of list) {
                    if (r.selectorText && /\.model-open-btn:hover/.test(r.selectorText)) { return r.cssText; }
                }
            }
            return null;
        });
        expect(underlineRule === null, '.model-open-btn:hover 下划线规则不存在', underlineRule);

        // ===== R12 normalize.js 版本守卫 =====
        console.log('R12. normalize.js 版本印记与缓存串一致');
        const kitCheck = await page.evaluate(() => {
            const src = Array.from(document.querySelectorAll('script[src*="model-detail-normalize"]')).map(s => s.getAttribute('src'))[0] || '';
            return { kitVersion: window.ModelDetailKit && window.ModelDetailKit.KIT_VERSION, src };
        });
        expect(!!kitCheck.kitVersion, 'normalize.js 暴露 KIT_VERSION', kitCheck);
        expect(kitCheck.src.includes(kitCheck.kitVersion), 'HTML 缓存串包含 KIT_VERSION（两处已同步 bump）', kitCheck);
        const warnFired = await page.evaluate(() => {
            const real = window.ModelDetailKit.KIT_VERSION;
            let msg = null;
            const origErr = console.error;
            console.error = (...a) => { msg = a.join(' '); };
            try {
                window.ModelDetailKit.KIT_VERSION = 'stale_old';
                mdcCheckKitVersion();
            } finally {
                window.ModelDetailKit.KIT_VERSION = real;
                console.error = origErr;
            }
            return msg;
        });
        expect(/版本不匹配/.test(warnFired || ''), '版本不匹配时 console 明确报错（不再静默显示「—」）', warnFired && warnFired.slice(0, 50));

        console.log('C. console');
        expect(consoleErrors.length === 0, '全程 0 console error', consoleErrors.slice(0, 3));
    } catch (e) {
        console.error('\n脚本异常:', e.message);
        fail++;
    } finally {
        await browser.close();
    }

    console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
function J(v) { return JSON.stringify(v); }
