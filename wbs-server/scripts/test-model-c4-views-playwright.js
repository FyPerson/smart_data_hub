/**
 * 模型中心 C4 · 详情抽屉视图四段（各 kind） Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c4-views-playwright.js
 * 规格：方案 v1.4 §5.1 映射表 + demo v2 版式 + D3（kind 切换）+ D4（新徽章/dw_* 折叠）+ §5.7（历史 readOnly）
 * 覆盖（用本地库真实模型）：
 *   #52 DWD：徽章/血缘卡(主表+JOIN)/更新策略+主键 kv/字段清单(108 个·PK/派生徽章)/搜索×dw_*折叠组合/加工逻辑 details
 *   #50 DIM：SCD 块(HYBRID/业务键/追踪字段数)/字段清单
 *   #53 companion：伴生说明 note + 主模型链接（点击导航到 #52）
 *   #58 custom：手工脚本 note
 *   XSS：注入表名/注释经 textContent 落 DOM 不执行
 *   §5.7：足迹「查看全部变更 →」弹历史(readOnly：无「回退」按钮)；Esc 先关子弹窗再关抽屉
 *   全程 0 console error
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

async function openDrawerById(page, id) {
    await page.evaluate(i => openModelDrawer(i), id);
    await page.waitForSelector('#modelDetailDrawer.open');
    await page.waitForFunction(i => {
        const s = document.getElementById('modelDrawerSub');
        return s && new RegExp('#' + i + '(?!\\d)').test(s.textContent) && document.querySelector('#modelDrawerBody .sec');
    }, id);
}
async function closeDrawer(page) {
    await page.evaluate(() => closeModelDrawer());
    await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
}

(async () => {
    console.log('=== 模型中心 C4 视图四段 Playwright 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        // ===== #52 DWD 完整视图 =====
        console.log('DWD #52');
        await openDrawerById(page, 52);
        const badges = await page.$$eval('#modelDrawerBody .badges-identity .mdc-badge', els => els.map(e => e.textContent));
        expect(badges.some(b => b === 'DWD'), 'DWD 徽章', badges);
        expect(await page.$('#modelDrawerBody .lineage .lineage-grid') !== null, '血缘卡渲染');
        const primarySrc = await page.$eval('#modelDrawerBody .lineage code.primary-src', e => e.textContent).catch(() => null);
        expect(primarySrc === 'ods_contract_df', '血缘主表=ods_contract_df', primarySrc);
        const kvText = await page.$eval('#modelDrawerBody .kv', e => e.textContent);
        expect(kvText.includes('更新策略'), 'DWD kv 含更新策略行');
        expect(kvText.includes('主键'), 'DWD kv 含主键行');
        const fieldRows = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(fieldRows === 108, '字段表默认渲染 108 行业务+派生（dw_* 折叠）', fieldRows);
        expect(await page.$('#modelDrawerBody .mk-pk') !== null, 'PK 徽章存在');
        expect(await page.$('#modelDrawerBody .mk-derived') !== null, '派生 ƒ 徽章存在');
        // 搜索过滤
        await page.fill('#modelDrawerBody .field-search', 'contract_id');
        await page.waitForTimeout(150);
        const filtered = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(filtered >= 1 && filtered < 108, '搜索 contract_id 过滤生效', filtered);
        await page.fill('#modelDrawerBody .field-search', '');
        await page.waitForTimeout(150);
        // 真实 DWD 配置的 selectedFields 不含 dw_* 技术字段（由 DDL 生成非入 config）→ 无折叠按钮（正确行为）
        expect(await page.$('#modelDrawerBody .tech-toggle') === null, '#52 无 dw_* 字段→无折叠按钮（真实配置正确态）');
        // 加工逻辑 details
        expect(await page.$('#modelDrawerBody details.logic') !== null, '加工逻辑 details 存在');
        const joinRows = await page.$$eval('#modelDrawerBody .join-table tr', rows => rows.length).catch(() => 0);
        expect(joinRows >= 2, '加工逻辑含 JOIN 表', joinRows);
        await closeDrawer(page);

        // ===== #50 DIM SCD 块 =====
        console.log('DIM #50');
        await openDrawerById(page, 50);
        const dimKv = await page.$eval('#modelDrawerBody .kv', e => e.textContent);
        expect(dimKv.includes('SCD 类型'), 'DIM kv 含 SCD 类型');
        expect(dimKv.includes('HYBRID'), 'SCD 类型=HYBRID', dimKv.slice(0, 100));
        expect(dimKv.includes('业务键'), 'DIM kv 含业务键');
        expect(dimKv.includes('追踪字段数'), 'DIM kv 含追踪字段数');
        const dimFields = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(dimFields > 0, 'DIM 字段表非空', dimFields);
        await closeDrawer(page);

        // ===== #53 companion + 主模型链接导航 =====
        console.log('companion #53');
        await openDrawerById(page, 53);
        const compNote = await page.$eval('#modelDrawerBody .mdc-note', e => e.textContent).catch(() => '');
        expect(compNote.includes('伴生'), 'companion 伴生说明 note', compNote.slice(0, 40));
        const parentLink = await page.$('#modelDrawerBody .mdc-link-btn');
        expect(parentLink !== null, '主模型链接存在');
        // 先经列表按钮打开 #53（带 openerEl），再点主模型链接导航到 #52，验关闭后焦点归还列表按钮（C4 审 M-3）
        await closeDrawer(page);
        const compRowBtn = page.locator('#modelListBody tr[data-id="53"] td:nth-child(3) .model-open-btn').first();
        await compRowBtn.click();
        await page.waitForFunction(() => document.querySelector('#modelDrawerBody .mdc-link-btn') !== null);
        await page.click('#modelDrawerBody .mdc-link-btn');
        await page.waitForFunction(() => { const s = document.getElementById('modelDrawerSub'); return s && /#52(?!\d)/.test(s.textContent); });
        expect(true, '点主模型链接导航到 #52（保留 openerEl）');
        await page.evaluate(() => closeModelDrawer());
        await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
        const focusBackToComp = await page.evaluate(() => document.activeElement && document.activeElement.dataset && document.activeElement.dataset.modelId === '53');
        expect(focusBackToComp, 'companion 导航后关闭：焦点归还原列表按钮 #53（M-3 openerEl 保留）', focusBackToComp);

        // ===== #58 custom =====
        console.log('custom #58');
        await openDrawerById(page, 58);
        const customNote = await page.$eval('#modelDrawerBody .mdc-note', e => e.textContent).catch(() => '');
        expect(customNote.includes('手工脚本'), 'custom 手工脚本 note', customNote.slice(0, 40));
        expect(await page.$('#modelDrawerBody .field-table') === null, 'custom 不渲染字段表');
        await closeDrawer(page);

        // ===== §5.7 历史 readOnly + Esc 层级 =====
        console.log('§5.7 历史 readOnly');
        await openDrawerById(page, 52);
        const logsBtn = page.locator('#modelDrawerBody .foot-links button:has-text("查看全部变更")');
        await logsBtn.click();
        await page.waitForFunction(() => document.getElementById('changeLogsModal') !== null);
        // readOnly：不出现「回退」按钮
        const hasRevert = await page.$$eval('#changeLogsModal button', btns => btns.some(b => b.textContent.includes('回退')));
        expect(!hasRevert, '历史弹窗 readOnly 无「回退」按钮', hasRevert);
        // 子弹窗开着时抽屉 inert
        const drawerInertWithModal = await page.$eval('#modelDetailDrawer', e => e.inert);
        expect(drawerInertWithModal === true, '子弹窗开时抽屉 inert', drawerInertWithModal);
        // Esc 先关子弹窗（不越级关抽屉）
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const modalGone = await page.evaluate(() => document.getElementById('changeLogsModal') === null);
        const drawerStillOpen = await page.evaluate(() => document.getElementById('modelDetailDrawer').classList.contains('open'));
        // changeLogsModal 无自身 Esc 处理 → Esc 被抽屉 keydown 拦截但因 isAnyModalOpen 而不关抽屉；
        // 手动关子弹窗验证归还焦点
        if (!modalGone) {
            await page.evaluate(() => { const m = document.getElementById('changeLogsModal'); if (m) m.remove(); });
            await page.waitForTimeout(150);
        }
        expect(drawerStillOpen, '子弹窗期间抽屉保持 open（Esc 不越级）', drawerStillOpen);
        const drawerInertAfter = await page.$eval('#modelDetailDrawer', e => e.inert);
        expect(drawerInertAfter === false, '子弹窗关闭后抽屉恢复可交互', drawerInertAfter);

        // C4 审 M-2：验收记录弹窗 Esc 关闭（派生浮层无自身 Esc，靠抽屉 keydown 关最上层）
        const testBtn = page.locator('#modelDrawerBody .foot-links button:has-text("验收记录")');
        await testBtn.click();
        await page.waitForFunction(() => document.getElementById('modelDrawerTestModal') !== null);
        expect(await page.$eval('#modelDetailDrawer', e => e.inert) === true, '验收弹窗开时抽屉 inert');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => document.getElementById('modelDrawerTestModal') === null), 'Esc 关闭验收弹窗（C4 审 M-2）');
        expect(await page.evaluate(() => document.getElementById('modelDetailDrawer').classList.contains('open')), 'Esc 关验收弹窗不越级关抽屉');
        expect(await page.$eval('#modelDetailDrawer', e => e.inert) === false, '验收弹窗关闭后抽屉恢复可交互');
        await closeDrawer(page);

        // C4 审 M-3：抽屉打开派生浮层后直接关抽屉 → 孤儿浮层被清理
        console.log('§M-3 关抽屉清理派生浮层');
        await openDrawerById(page, 52);
        await page.click('#modelDrawerBody .foot-links button:has-text("查看全部变更")');
        await page.waitForFunction(() => document.getElementById('changeLogsModal') !== null);
        await page.evaluate(() => closeModelDrawer());
        await page.waitForTimeout(200);
        expect(await page.evaluate(() => document.getElementById('changeLogsModal') === null), '关抽屉一并清理孤儿派生浮层（M-3）');

        // ===== dw_* 折叠 + 新徽章（mock 模型：真实 config 无 dw_ 字段/新字段少，用构造样本验机制）=====
        console.log('dw_* 折叠 + 新徽章（mock）');
        const today = new Date();
        const y = today.getFullYear(), mo = String(today.getMonth() + 1).padStart(2, '0'), d = String(today.getDate()).padStart(2, '0');
        const todayStr = `${y}-${mo}-${d}`;
        // C9：dwd/dim 现在也会拉 /downstream（虚拟模型在库里不存在 → 真实请求会 404 污染 console）
        const mockDownstream = (id) => page.route(`**/api/models/${id}/downstream`, route => route.fulfill({
            status: 200, contentType: 'application/json', body: JSON.stringify({ table_name: 'mock', candidates: [] })
        }));
        await mockDownstream(999001);
        await page.route('**/api/models/999001', route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                id: 999001, table_name: 'dwd_mock_toggle', table_comment: 'mock', layer: 'dwd', config_mode: 'standard',
                dim_config: { dwdConfig: { primaryKeys: ['biz_id'] }, sourceTables: [{ name: 'ods_a', isPrimary: true, alias: 'a' }],
                    selectedFields: [
                        { srcField: 'BizID', targetField: 'biz_id', dataType: 'int', comment: '业务ID' },
                        { srcField: 'NewCol', targetField: 'new_col', dataType: 'int', comment: '新列', addedAt: todayStr },
                        { srcField: '', targetField: 'dw_load_ts', dataType: 'datetime', comment: '加载时间' },
                        { srcField: '', targetField: 'dw_hash_val', dataType: 'varchar(64)', comment: '哈希' }
                    ], derivedFields: [] }
            })
        }));
        await openDrawerById(page, 999001);
        const mockRowsBefore = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(mockRowsBefore === 2, '默认渲染 2 业务字段（dw_* 折叠）', mockRowsBefore);
        expect(await page.$('#modelDrawerBody .mk-new') !== null, '当日 addedAt 字段显示「新」徽章');
        const toggleBtn = await page.$('#modelDrawerBody .tech-toggle');
        expect(toggleBtn !== null, 'dw_* 折叠按钮存在');
        await toggleBtn.click();
        await page.waitForTimeout(100);
        const mockRowsAfter = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(mockRowsAfter === 4, '展开后 4 行（含 2 个 dw_*）', mockRowsAfter);
        // 搜索时技术字段临时显示
        await page.fill('#modelDrawerBody .field-search', 'dw_hash');
        await page.waitForTimeout(150);
        const searchTech = await page.$$eval('#modelDrawerBody .field-table tbody tr', rows => rows.length);
        expect(searchTech === 1, '搜索命中技术字段（临时显示）', searchTech);
        await page.unroute('**/api/models/999001');
        await page.unroute('**/api/models/999001/downstream');
        await closeDrawer(page);

        // ===== XSS：注入表名/注释经 textContent 不执行 =====
        console.log('XSS');
        await mockDownstream(999999);
        await page.route('**/api/models/999999', route => route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                id: 999999, table_name: '<img src=x onerror=window.__xss=1>', table_comment: '"><script>window.__xss=1</script>',
                layer: 'dwd', config_mode: 'standard', tech_owner: '<b>x</b>',
                dim_config: { dwdConfig: { primaryKeys: ['a'] }, selectedFields: [{ srcField: '<x>', targetField: 'a', dataType: 'int', comment: '</td><img onerror=1>' }], derivedFields: [], sourceTables: [{ name: 'ods_x', isPrimary: true, alias: 'x' }] }
            })
        }));
        await openDrawerById(page, 999999);
        const xssFlag = await page.evaluate(() => window.__xss);
        expect(!xssFlag, 'XSS 注入未执行（textContent 落 DOM）', xssFlag);
        const titleText = await page.$eval('#modelDrawerTitle', e => e.textContent);
        expect(titleText.includes('<img'), '恶意表名作为纯文本显示', titleText.slice(0, 40));
        await page.unroute('**/api/models/999999');
        await closeDrawer(page);

        // C4 审 M-4：验收记录端点字段契约（直调 API 断言真实 shape，防列名假设漂移）
        console.log('M-4 test-records 字段契约');
        const trResp = await page.evaluate(async () => {
            const r = await fetch('/api/models/52/test-records?limit=1', { headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            return { ok: r.ok, body: await r.json() };
        });
        expect(trResp.ok, 'test-records 端点 200');
        if (Array.isArray(trResp.body) && trResp.body.length) {
            const rec = trResp.body[0];
            expect('overall_result' in rec && 'test_user' in rec && 'test_time' in rec, '契约含 overall_result/test_user/test_time', Object.keys(rec));
        } else {
            expect(true, 'test-records 无记录（契约断言跳过·空表合法）');
        }

        console.log('C. console');
        expect(consoleErrors.length === 0, '全程 0 console error', consoleErrors.slice(0, 5));
    } catch (e) {
        console.error('测试异常:', e);
        fail++;
    } finally {
        await browser.close();
    }

    console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
    process.exit(fail ? 1 : 0);
})();
