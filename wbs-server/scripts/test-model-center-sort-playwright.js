/**
 * 模型中心列表页「点击表头排序」Playwright 视觉冒烟测试
 *
 * 用法：node scripts/test-model-center-sort-playwright.js
 * [#106 S4d-3] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；`--port=` 参数、PORT 环境变量、写死 3300 与业务库 / .env 均已删除。
 *   截图目录：默认是 os.tmpdir() 下用 mkdtemp 原子创建的本次运行独占目录 sdh-model-center-sort-<随机后缀>，收尾用 removeTreeChecked 删并确认（删失败计失败）；
 *   显式设了 SCREENSHOT_DIR 环境变量时写到那里并保留（原有用法，不删用户指定的目录）。原默认值是写死的另一次会话 scratchpad 绝对路径。
 *   依赖：隔离实例是本检出本地库的快照，模型中心列表要有足够多的条目（排序 / 分页断言，首跑核对）。
 *
 * 范围：
 *   - 移植自 Data_Collab.html v1.72.1 客户端排序范式，验证 Model_Center.html 新加的可排序表头
 *   - 断言：① 点表头行顺序按该字段升/降变化 ② sort-icon + active 高亮同步
 *          ③ 第三次点同列恢复默认序（且与原始顺序完全一致，非巧合重排）
 *          ④ 与搜索筛选叠加不冲突（筛选后仍保持排序）
 *          ⑤ 排序切换后分页重置到第 1 页 ⑥ 0 console error
 *
 * ⚠️ 校验用「行 data-id 顺序 + allModelsData 原始字段值」而非渲染文本——
 *    渲染的「表名」列会在伴生表/custom 模式前插入「●」视觉标记字符，直接比较渲染文本
 *    会被这个前缀字符污染 locale 排序断言（首次实测踩坑，已改用原始字段值校验）。
 * C4b 改写（目录列表按「组」分页、前端搜索）：
 *   - 排序断言作用于「主模型序列」：伴生表（allModelsData 里 companion_of 指向列表内主模型的行）紧跟其主模型，不按自己的字段值散落；
 *     主模型不在列表里的落单伴生当主模型。因此「按行单调」改为「主模型序列单调 + 每个伴生紧跟其主模型」。
 *   - 搜索「dwd」改为输入即过滤（不再要求回车 / 重载）：①每个可见组至少有一个成员按本用例自己手写的字段谓词命中 ②所有表名含 dwd 的行都可见 ③主模型按 updated_at 降序仍保持；
 *     保留一次回车，证明它不发请求。
 * C4c-2 改写（目录列表由 tr 表格改为双行卡片）：条目 = #modelListBody 里的 [data-id]（组包装只带 data-group）；排序控件 = button[data-sort-by]（列头条 5 个 + 排序条 3 个，本用例用其中 table_name / status / updated_at / tech_owner）；
 *   激活态仍是该按钮的 .active 类与 .sort-icon 文本（⇅ / ↓ / ↑）；组语义断言（主模型序列单调 + 伴生紧跟主模型）不动。
 * ⚠️ 只读点击，不产生任何写操作（不点击注册/编辑/删除/ETL/DDL/验收等按钮）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;         // [#106 S4d-3] ready() 之后赋值：testEnv.env().baseUrl
let SCREENSHOT_DIR = null;   // [#106 S4d-3] ready() 之后赋值（顶层 path.join / Date.now 会被守卫 R6 判红）
let OWN_SCREENSHOT_DIR = false;   // true = 本脚本自建的临时目录，收尾要删；SCREENSHOT_DIR 环境变量指定的目录不删

const ADMIN_ID = 1;

// [#106 S4d-3] 令牌由 test-env 用实例密钥签（读实例库 users 行）；不再自读 .env / 业务库
async function signAs(userId) {
    return testEnv.signToken(userId);
}

/** 删目录树：逐项 lstat，链接只删链接本身不进入，文件 unlink、目录递归后 rmdir（不用 fs.rmSync：Node v24 对含中文路径静默不删）；目录不存在视为已清；删后 lstat 确认，仍存在则抛错（调用方计失败）。写法同 verify-collab-multifile-datascope.js 的 removeTreeChecked */
function removeTreeChecked(dir) {
    let st;
    try { st = fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) {
        try { fs.unlinkSync(dir); } catch (e) { if (e && (e.code === 'EPERM' || e.code === 'EISDIR')) fs.rmdirSync(dir); else throw e; }
        return;
    }
    if (st.isDirectory()) {
        for (const name of fs.readdirSync(dir)) removeTreeChecked(path.join(dir, name));
        fs.rmdirSync(dir);
    } else {
        fs.unlinkSync(dir);
    }
    try { fs.lstatSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
    throw new Error(`删除后仍存在：${dir}`);
}

let assertCount = 0;
function expect(condition, message) {
    assertCount++;
    if (!condition) throw new Error(`Assert #${assertCount} FAILED: ${message}`);
    console.log(`  [OK] ${message}`);
}

// 中文 locale 字符串比较（与前端 sortByField 的 string 分支保持一致）
function isMonotonicString(arr, mult) {
    for (let i = 1; i < arr.length; i++) {
        const cmp = String(arr[i - 1]).localeCompare(String(arr[i]), 'zh-Hans-CN') * mult;
        if (cmp > 0) return false;
    }
    return true;
}

function isMonotonicDate(arr, mult) {
    for (let i = 1; i < arr.length; i++) {
        const ta = new Date(String(arr[i - 1]).replace(' ', 'T')).getTime();
        const tb = new Date(String(arr[i]).replace(' ', 'T')).getTime();
        if ((ta - tb) * mult > 0) return false;
    }
    return true;
}

/** 当前页渲染行 → { ids, primaries, adjacent }：伴生（companion_of 指向列表里存在且自身不是伴生的主模型）必须紧跟其主模型（或同组前一个伴生）；主模型不在列表里的伴生当主模型 */
const GROUP_ROWS_FN = (override) => {
    const byId = new Map(allModelsData.map((m) => [String(m.id), m]));
    const ids = override || Array.from(document.querySelectorAll('#modelListBody [data-id]')).map((r) => Number(r.dataset.id));
    const primaries = [];
    let adjacent = true, lastPrimary = null;
    for (const id of ids) {
        const m = byId.get(String(id));
        const parent = m && m.companion_of != null ? byId.get(String(m.companion_of)) : null;
        const isComp = !!parent && parent.companion_of == null;
        if (!isComp) { primaries.push(id); lastPrimary = id; } else if (String(m.companion_of) !== String(lastPrimary)) adjacent = false;
    }
    return { ids, primaries, adjacent };
};

(async () => {
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    console.log('=== 模型中心列表页 点击表头排序 Playwright 视觉冒烟测试 ===\n');

    const consoleErrors = [];
    let exitCode = 0;
    let browser = null;

    try {
        if (process.env.SCREENSHOT_DIR) {
            SCREENSHOT_DIR = process.env.SCREENSHOT_DIR;
            fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        } else {
            // [#106 S4d-3 codex 23b-L1] mkdtemp 原子创建本次运行独占的目录（多个工作树同时跑时不会共用、不会互删）；创建成功后才标记为自建
            SCREENSHOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-model-center-sort-'));
            OWN_SCREENSHOT_DIR = true;
        }
        browser = await chromium.launch({ headless: true });
        const adminToken = await signAs(ADMIN_ID);
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') { consoleErrors.push(msg.text()); console.log(`  [browser-err] ${msg.text()}`); }
        });
        page.on('pageerror', (err) => { consoleErrors.push(err.message); console.log(`  [page-error] ${err.message}`); });

        console.log('1. JWT 注入登录 admin，打开模型中心页...');
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((token) => localStorage.setItem('token', token), adminToken);
        await page.goto(`${BASE_URL}/Model_Center.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForSelector('#modelListBody [data-id]', { timeout: 10000 });
        await page.waitForTimeout(300);

        expect(await page.isVisible('#modelListBody'), '模型列表渲染（C4c-2：卡片列表容器 #modelListBody 可见；旧：表格 #modelListTable）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-01-initial.png') });

        // 当前渲染行的 data-id 顺序（反映 renderModelsPage 实际渲染顺序）
        const getRowIdOrder = async () => page.$$eval(
            '#modelListBody [data-id]',
            (els) => els.map((el) => el.getAttribute('data-id'))
        );
        // allModelsData 原始字段快照（id -> model），用于按真实字段值校验排序（避开渲染文本里的「●」等视觉前缀污染）
        const getModelMap = async () => page.evaluate(
            () => Object.fromEntries(allModelsData.map((m) => [String(m.id), m]))
        );

        const groupRows = () => page.evaluate(GROUP_ROWS_FN, null);
        // 邻接判据（L9）：被检页必须至少有 1 个伴生，否则恒为真——不满足时改用 getCatalogView().orderedIds（全部页）做全量检查
        const adjacent = async (what, g) => {
            let gg = g, where = '当前页';
            if (g.ids.length === g.primaries.length) {
                const all = await page.evaluate(() => getCatalogView().orderedIds);
                gg = await page.evaluate(GROUP_ROWS_FN, all); where = '全量（当前页没有伴生）';
            }
            expect(gg.ids.length > gg.primaries.length, what + '：被检范围（' + where + '）至少有 1 个伴生，邻接判据不是恒真');
            expect(gg.adjacent, what);
        };
        // C6a：单调性判据对空 / 单元素序列恒真——被检主模型序列须至少 2 个（与 adjacent 的「至少 1 个伴生」同类前置）
        const needTwo = (what, g) => expect(g.primaries.length >= 2, what + '：被检主模型序列至少 2 个（单调性判据不是对空 / 单元素序列恒真），实际 ' + g.primaries.length);
        let apiModelsRequests = 0;   // 输入即过滤：搜索期间不得有 GET /api/models
        page.on('request', (r) => { try { const u = new URL(r.url()); if (u.pathname === '/api/models' && r.method() === 'GET') apiModelsRequests++; } catch (_) { /* ignore */ } });
        const originalIdOrder = await getRowIdOrder();
        expect(originalIdOrder.length > 0, `默认渲染出至少 1 行数据（实际 ${originalIdOrder.length} 行）`);
        let modelMap = await getModelMap();
        console.log(`  初始渲染 ${originalIdOrder.length} 行，总数据 ${Object.keys(modelMap).length} 条`);

        // ============================================================
        // 步骤 2：点「表名」表头 → 第1次 desc
        // ============================================================
        console.log('\n2. 点击「表名」表头（第1次，应为 desc）...');
        await page.click('button[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const activeAfterFirstClick = await page.$eval(
            'button[data-sort-by="table_name"]',
            (th) => th.classList.contains('active')
        );
        const iconAfterFirstClick = await page.$eval(
            'button[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(activeAfterFirstClick, '第1次点击后「表名」表头获得 active 高亮');
        expect(iconAfterFirstClick === '↓', `第1次点击后图标为 ↓（实际:${iconAfterFirstClick}）`);

        const idOrderDesc = await getRowIdOrder();
        const gDesc = await groupRows();
        needTwo('第1次点击后「表名」', gDesc);
        const rawNamesDesc = gDesc.primaries.map((id) => modelMap[String(id)].table_name);
        expect(isMonotonicString(rawNamesDesc, -1), '第1次点击后「表名」主模型序列按降序排列');
        await adjacent('第1次点击后每个伴生紧跟其主模型', gDesc);
        expect(JSON.stringify(idOrderDesc) !== JSON.stringify(originalIdOrder), '排序后行顺序与初始顺序不同（确认排序确实生效）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-02-desc.png') });

        // ============================================================
        // 步骤 3：再点一次「表名」 → asc
        // ============================================================
        console.log('\n3. 再次点击「表名」表头（第2次，应为 asc）...');
        await page.click('button[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const iconAfterSecondClick = await page.$eval(
            'button[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(iconAfterSecondClick === '↑', `第2次点击后图标为 ↑（实际:${iconAfterSecondClick}）`);

        const gAsc = await groupRows();
        needTwo('第2次点击后「表名」', gAsc);
        const rawNamesAsc = gAsc.primaries.map((id) => modelMap[String(id)].table_name);
        expect(isMonotonicString(rawNamesAsc, 1), '第2次点击后「表名」主模型序列按升序排列');
        await adjacent('第2次点击后每个伴生紧跟其主模型', gAsc);
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-03-asc.png') });

        // ============================================================
        // 步骤 4：第三次点击「表名」 → 清排序，恢复默认原始顺序
        // ============================================================
        console.log('\n4. 第三次点击「表名」表头（应清排序，恢复默认顺序）...');
        await page.click('button[data-sort-by="table_name"]');
        await page.waitForTimeout(200);

        const activeAfterThirdClick = await page.$eval(
            'button[data-sort-by="table_name"]',
            (th) => th.classList.contains('active')
        );
        const iconAfterThirdClick = await page.$eval(
            'button[data-sort-by="table_name"] .sort-icon',
            (el) => el.textContent
        );
        expect(!activeAfterThirdClick, '第3次点击后「表名」表头失去 active 高亮');
        expect(iconAfterThirdClick === '⇅', `第3次点击后图标恢复为 ⇅（实际:${iconAfterThirdClick}）`);

        const idOrderReset = await getRowIdOrder();
        expect(JSON.stringify(idOrderReset) === JSON.stringify(originalIdOrder), '第3次点击后行顺序与初始默认顺序完全一致（非巧合重排）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-04-reset.png') });

        // ============================================================
        // 步骤 5：状态列（statusOrder 自定义优先级）+ 最后更新（date 类型）排序
        // ============================================================
        console.log('\n5. 点击「状态」表头（statusOrder 自定义优先级类型）...');
        await page.click('button[data-sort-by="status"]');
        await page.waitForTimeout(200);
        const STATUS_SORT_ORDER = { CREATED: 0, DEVELOPING: 1, REVIEWING: 2, ONLINE: 3, OFFLINE: 4 };
        const gStatus = await groupRows();
        needTwo('「状态」排序后', gStatus);
        await adjacent('「状态」排序后每个伴生紧跟其主模型', gStatus);
        const statusRankDesc = gStatus.primaries.map((id) => {
            const s = modelMap[String(id)].status;
            return STATUS_SORT_ORDER[s] !== undefined ? STATUS_SORT_ORDER[s] : 99;
        });
        let statusMonotonic = true;
        for (let i = 1; i < statusRankDesc.length; i++) {
            if (statusRankDesc[i - 1] - statusRankDesc[i] < 0) { statusMonotonic = false; break; }
        }
        expect(statusMonotonic, '「状态」列第1次点击后主模型序列按业务优先级降序排列（statusOrder 类型分派生效）');
        // 清排序，回默认，避免影响后续步骤
        await page.click('button[data-sort-by="status"]');
        await page.click('button[data-sort-by="status"]');

        console.log('\n6. 点击「最后更新」表头（date 类型），验证日期列排序...');
        await page.click('button[data-sort-by="updated_at"]');
        await page.waitForTimeout(200);
        const gUpdated = await groupRows();
        needTwo('「最后更新」排序后', gUpdated);
        const rawUpdatedDesc = gUpdated.primaries.map((id) => modelMap[String(id)].updated_at);
        expect(isMonotonicDate(rawUpdatedDesc, -1), '「最后更新」列第1次点击后主模型序列按日期降序排列（date 类型分派生效）');
        await adjacent('「最后更新」排序后每个伴生紧跟其主模型', gUpdated);

        // ============================================================
        // 步骤 7：与搜索筛选叠加 —— 保持当前排序（updated_at desc）下搜索
        // ============================================================
        console.log('\n7. 输入搜索关键字「dwd」（输入即过滤，不发请求），验证排序与筛选叠加...');
        const reqsBeforeSearch = apiModelsRequests;
        await page.fill('#searchKeyword', 'dwd');
        await page.waitForTimeout(400);
        const gFiltered = await groupRows();
        // C6a：needTwo 在这里揭出——「dwd」在测试库副本上只命中 1 个主模型（#52 + 伴生 #53），下面的 ③ 对单元素序列恒真；本步骤的断言原样保留，③ 的判别力由后面的 7b（关键词「dim_」，命中 ≥2 个主模型）补上
        expect(gFiltered.primaries.length >= 1, '搜索「dwd」后至少有 1 个主模型组（实际 ' + gFiltered.primaries.length + '）');
        expect(gFiltered.ids.length > 0, '搜索「dwd」后仍有匹配数据');
        // ①每个可见组（当前页）至少有一个成员按本用例自己手写的字段谓词命中 dwd：表名 / 中文短名 / 实现说明 / 源表 / 源系统 / 上游名（ModelDetailKit 自算）/ 对象名 / ID
        const checkGroups = await page.evaluate(() => {
            const q = 'dwd';
            const lo = (v) => String(v == null ? '' : v).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
            const parse = (raw) => { if (raw == null || raw === '') return null; if (typeof raw === 'object') return raw; try { let v = JSON.parse(raw); if (typeof v === 'string') v = JSON.parse(v); return v; } catch (e) { return null; } };
            const ups = (m) => {
                if (String(m.layer || '').toUpperCase() === 'ODS') return [m.source_system, m.source_table].map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
                const d = ModelDetailKit.normalizeModelDetail({ layer: m.layer, config_mode: m.config_mode, companion_of: m.companion_of, dim_config: parse(m.dim_config) });
                return d.sources.map((x) => x.name).filter(Boolean);
            };
            const hit = (m) => [m.table_name, m.table_comment, m.impl_note, m.source_table, m.source_system].concat(ups(m), Array.isArray(m.impl_obj_names) ? m.impl_obj_names : []).some((v) => v != null && lo(v).indexOf(q) !== -1) || String(m.id) === q;
            const byId = new Map(allModelsData.map((m) => [String(m.id), m]));
            const view = getCatalogView();   // 仅用于 ②（全部页的可见 id）；① 读 DOM 行（L9：不读实现自己的视图）
            const domIds = Array.from(document.querySelectorAll('#modelListBody [data-id]')).map((r) => Number(r.dataset.id));
            const domGroups = [];
            for (const id of domIds) {
                const m = byId.get(String(id));
                const parent = m && m.companion_of != null ? byId.get(String(m.companion_of)) : null;
                const isComp = !!parent && parent.companion_of == null;
                if (isComp && domGroups.length) domGroups[domGroups.length - 1].push(id); else domGroups.push([id]);
            }
            const groupsOk = domGroups.length > 0 && domGroups.every((g) => g.some((id) => hit(byId.get(String(id)))));
            const allDwd = allModelsData.filter((m) => lo(m.table_name).indexOf(q) !== -1).map((m) => m.id);
            const visibleAll = new Set(view.orderedIds.map(String));
            return { groupsOk, groups: domGroups.length, missing: allDwd.filter((id) => !visibleAll.has(String(id))) };
        });
        expect(checkGroups.groups > 0 && checkGroups.groupsOk, '①每个可见组（读 DOM 行分组）至少有一个成员按手写字段谓词命中「dwd」（筛选生效）');
        expect(checkGroups.missing.length === 0, '②所有表名含「dwd」的行都可见（不漏）' + (checkGroups.missing.length ? '：缺 ' + checkGroups.missing.join(',') : ''));
        const filteredUpdatedRaw = gFiltered.primaries.map((id) => modelMap[String(id)].updated_at);
        expect(isMonotonicDate(filteredUpdatedRaw, -1), '③筛选后主模型仍保持「最后更新」降序（排序未被搜索重置，叠加生效）');
        await adjacent('筛选后每个伴生仍紧跟其主模型', gFiltered);
        await page.press('#searchKeyword', 'Enter');   // 回车不再必需（输入即过滤），保留一次证明它不发请求
        await page.waitForTimeout(400);
        expect(apiModelsRequests === reqsBeforeSearch, '输入即过滤 + 回车：期间不发 GET /api/models 请求（实际 +' + (apiModelsRequests - reqsBeforeSearch) + '）');
        await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'model-center-sort-05-filter-plus-sort.png') });

        // 7b（C6a）：关键词「dim_」命中多个主模型（测试库副本上是 4 个 DIM、无伴生），排序仍是步骤 6 的 updated_at 降序——重做 ③，判据不再对单元素序列恒真
        await page.fill('#searchKeyword', 'dim_');
        await page.waitForTimeout(400);
        const gDim = await groupRows();
        needTwo('搜索「dim_」后', gDim);
        expect(gDim.ids.length > 0 && gDim.ids.length < originalIdOrder.length, '7b 搜索「dim_」后列表确实被筛小（实际 ' + gDim.ids.length + ' 行，初始第 1 页 ' + originalIdOrder.length + ' 行）');
        const dimUpdatedRaw = gDim.primaries.map((id) => modelMap[String(id)].updated_at);
        expect(isMonotonicDate(dimUpdatedRaw, -1), '③b 搜索「dim_」后主模型仍保持「最后更新」降序（排序未被搜索重置；命中 ≥2 个主模型，判据不是单元素恒真）');

        // 清空搜索，恢复全量，避免影响后续步骤
        await page.fill('#searchKeyword', '');
        await page.waitForTimeout(400);

        // ============================================================
        // 步骤 8：分页交互 —— 先跳到第 2 页，再点排序表头，验证重置回第 1 页
        // ============================================================
        console.log('\n8. 验证排序切换后分页重置到第 1 页...');
        const paginationInfoText = await page.textContent('#paginationInfo');
        console.log(`  分页信息: ${paginationInfoText}`);

        const scaffoldOk = await page.evaluate(() => typeof goToPage === 'function' && typeof currentPage !== 'undefined');
        expect(scaffoldOk, 'goToPage / currentPage 全局可访问（验证分页脚手架未被破坏）');

        await page.evaluate(() => { if (typeof goToPage === 'function') goToPage(2); });
        await page.waitForTimeout(200);
        const pageAfterGoTo2 = await page.evaluate(() => currentPage);
        console.log(`  goToPage(2) 后 currentPage = ${pageAfterGoTo2}`);

        await page.click('button[data-sort-by="tech_owner"]');
        await page.waitForTimeout(200);
        const pageAfterSortClick = await page.evaluate(() => currentPage);
        expect(pageAfterSortClick === 1, `点击排序表头后 currentPage 重置为 1（实际:${pageAfterSortClick}）`);

        // 清排序，回到原始态收尾
        await page.click('button[data-sort-by="tech_owner"]'); // asc
        await page.click('button[data-sort-by="tech_owner"]'); // reset
        await page.click('button[data-sort-by="updated_at"]'); // updated_at 由 desc -> asc
        await page.click('button[data-sort-by="updated_at"]'); // -> reset

        // ============================================================
        // 收尾：console error 断言
        // ============================================================
        console.log('\n9. 校验全程 0 console error...');
        expect(consoleErrors.length === 0, `全程 0 console error（实际:${consoleErrors.length}）`);

        console.log(`\n=== 全部 ${assertCount} 项断言通过 ===`);
    } catch (err) {
        console.error('\n测试失败:', err.message);
        exitCode = 1;
    } finally {
        // [#106 S4d-3] 两个收尾动作各自 try / catch：浏览器关闭失败不跳过截图目录清理；任一失败都计失败（退出码 1）
        if (browser) { try { await browser.close(); } catch (e) { console.error(`❌ 浏览器关闭失败：${e && e.message}`); exitCode = 1; } }
        if (OWN_SCREENSHOT_DIR && SCREENSHOT_DIR) {
            try { removeTreeChecked(SCREENSHOT_DIR); } catch (e) { console.error(`❌ 清理截图目录失败 ${SCREENSHOT_DIR}：${e && e.message}`); exitCode = 1; }
        }
    }
    try { await testEnv.teardown(); } catch (e) { console.error(`❌ teardown（收掉自起实例）失败：${e && e.message}`); exitCode = 1; }
    testEnv.finish(exitCode);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('测试异常:', e && e.stack || e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
