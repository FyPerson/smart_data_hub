/**
 * 模型中心 C8 · 高级 SQL 分段修复 + DIM SCD 策略段 Playwright 实测（2026-07-24）
 *
 * 用法：node scripts/test-model-c8-dim-scd-playwright.js
 * 前置：本地 server 已启动；依赖生产同构数据 #55 dim_org（type=CTE）/ #50 dim_official_customer（APPLY+CTE）
 * 背景：旧实现 mdcRenderLogicSection 只读 advancedSql.applyContent —— dim_org(type=CTE) 的 432 字符递归 CTE
 *       整段不显示，dim_official_customer 也丢了 cteContent 段。这是用户报「DIM 表似乎没什么信息展示」的直接原因之一。
 * 覆盖：
 *   D1 #55 dim_org：加工逻辑出现 CTE 段 + 段标签 + 说明文案（bug 回归断言）
 *   D2 #50 dim_official_customer：CTE 与 APPLY **两段都在**，且顺序为 CTE→APPLY
 *   D3 SCD 策略段：dim_org 的 ETL 策略/调度/审计表/12 个监控字段/四开关
 *   D4 SCD 策略段：dim_official_customer 的状态过滤/生效日期表达式/附加索引数/四开关全开
 *   D5 版本键（versionKey）在 kv 区显示
 *   D6 DWD（#52）不出现 SCD 策略段；type=NONE 不出现高级 SQL 段
 *   D7 空配置 DIM（如 #62 dim_weather）不因加厚而报错/出空壳段
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
    await page.waitForFunction(i => { const s = document.getElementById('modelDrawerSub'); return s && new RegExp('#' + i + '(?!\\d)').test(s.textContent); }, id);
    await page.waitForFunction(() => document.querySelector('#modelDrawerBody .sec'), {}, { timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll('#modelDrawerBody details').forEach(d => { d.open = true; }));
    await page.waitForTimeout(200);
}
async function closeDrawer(page) {
    await page.evaluate(() => closeModelDrawer());
    await page.waitForFunction(() => !document.getElementById('modelDetailDrawer').classList.contains('open'));
}
// 按 sec-title 取整段文本
const secText = (page, title) => page.evaluate(t => {
    const secs = Array.from(document.querySelectorAll('#modelDrawerBody .sec'));
    const s = secs.find(x => (x.querySelector('.sec-title') || {}).textContent === t
        || ((x.querySelector('.sec-title') || {}).textContent || '').indexOf(t) === 0);
    return s ? s.textContent : null;
}, title);
// 审 16 L-3：限定在「加工逻辑」段内查询，不受 SCD 段同类标签干扰
// （SCD 段的子标签已改用 .scd-sub-label，此处再加一层 section 限定作双保险）
const inLogicSec = (page, sel) => page.evaluate(s => {
    const secs = Array.from(document.querySelectorAll('#modelDrawerBody .sec'));
    const sec = secs.find(x => ((x.querySelector('.sec-title') || {}).textContent || '').indexOf('加工逻辑') === 0);
    if (!sec) { return []; }
    return Array.from(sec.querySelectorAll(s)).map(e => e.textContent.trim());
}, sel);
const sqlPartLabels = (page) => inLogicSec(page, '.sql-part-label');
const sqlBlocks = (page) => inLogicSec(page, '.sql-block');

(async () => {
    console.log('=== 模型中心 C8 高级 SQL 分段 + DIM SCD 策略 实测 ===\n');
    const browser = await chromium.launch({ headless: true });
    const consoleErrors = [];
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const page = await context.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

    try {
        const token = await fx.signAs(fx.ADMIN_ID);
        await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
        await page.evaluate(t => localStorage.setItem('token', t), token);
        await page.goto(`${BASE}/Model_Center.html`, { waitUntil: 'load' });
        await page.waitForSelector('#modelListBody tr[data-id]');

        // ===== D1 dim_org 的 CTE 段（bug 回归）=====
        console.log('D1. #55 dim_org type=CTE 段显示（旧实现整段丢失）');
        await openDrawerById(page, 55);
        const logic55 = await secText(page, '加工逻辑');
        expect(!!logic55, '加工逻辑段存在');
        const labels55 = await sqlPartLabels(page);
        expect(labels55.includes('CTE'), 'CTE 段标签出现（旧实现只读 applyContent → 无此段）', labels55);
        const blocks55 = await sqlBlocks(page);
        expect(blocks55.some(b => /org_tree\s+AS/i.test(b)), 'CTE 代码块含 org_tree AS（真实递归 CTE 内容）', blocks55.map(b => b.slice(0, 40)));
        expect(/递归CTE构建组织名称路径/.test(logic55 || ''), 'advancedSql.description 说明文案显示');
        // summary 应含 CTE 字样
        const summary55 = await page.$$eval('#modelDrawerBody details summary', els => els.map(e => e.textContent));
        expect(summary55.some(s => /CTE/.test(s)), '折叠标题含 CTE', summary55);

        // ===== D3 dim_org 的 SCD 策略段 =====
        console.log('D3. #55 SCD 策略段内容');
        const scd55 = await secText(page, 'SCD 策略');
        expect(!!scd55, 'SCD 策略段存在');
        expect(/TRUNCATE_INSERT/.test(scd55 || ''), 'ETL 策略 TRUNCATE_INSERT 显示');
        expect(/T\+1 每日/.test(scd55 || ''), '调度 T+1 每日 显示');
        expect(/dw_audit_log/.test(scd55 || ''), '审计表 dw_audit_log 显示');
        expect(/变更监控字段（12）/.test(scd55 || ''), '监控字段计数 12 显示', (scd55 || '').match(/变更监控字段（\d+）/));
        expect(/org_full_name/.test(scd55 || ''), '监控字段内容（org_full_name）显示');
        const flags55 = await page.$$eval('#modelDrawerBody .scd-flag', els => els.map(e => ({ t: e.textContent.trim(), on: e.className.includes('on') })));
        expect(flags55.length === 4, '四个检测开关全部呈现（开/关都显示）', flags55.length);
        const onNames55 = flags55.filter(f => f.on).map(f => f.t);
        expect(onNames55.some(t => /修改检测/.test(t)) && onNames55.some(t => /审计日志/.test(t)), 'dim_org 开启项=修改检测+审计日志', onNames55);
        expect(!flags55.find(f => /删除检测/.test(f.t)).on, 'dim_org 删除检测为关闭态（不误判为开）');
        await closeDrawer(page);

        // ===== D2 + D4 + D5 dim_official_customer =====
        console.log('D2. #50 dim_official_customer APPLY + CTE 两段都在');
        await openDrawerById(page, 50);
        const labels50 = await sqlPartLabels(page);
        expect(labels50.includes('CTE') && labels50.includes('APPLY'), '两段标签都出现（旧实现丢 CTE 段）', labels50);
        expect(labels50.indexOf('CTE') < labels50.indexOf('APPLY'), '顺序 CTE→APPLY（对齐 SQL 阅读顺序）', labels50);
        const blocks50 = await sqlBlocks(page);
        expect(blocks50.length >= 2, '两个 SQL 代码块', blocks50.length);
        expect(blocks50.some(b => /OUTER APPLY/i.test(b)), 'APPLY 块含 OUTER APPLY');

        console.log('D4. #50 SCD 策略段内容');
        const scd50 = await secText(page, 'SCD 策略');
        expect(/c\.State = 3/.test(scd50 || ''), '状态过滤 c.State = 3 显示');
        expect(/COALESCE/.test(scd50 || ''), '生效日期表达式（COALESCE...）显示');
        expect(/附加索引/.test(scd50 || '') && /5 个/.test(scd50 || ''), '附加索引 5 个 显示', (scd50 || '').match(/附加索引[\s\S]{0,10}/));
        const flags50 = await page.$$eval('#modelDrawerBody .scd-flag', els => els.filter(e => e.className.includes('on')).length);
        expect(flags50 === 4, 'dim_official_customer 四项检测全开', flags50);

        console.log('D5. 版本键 kv 显示');
        const kv50 = await page.$$eval('#modelDrawerBody .kv .k', els => els.map(e => e.textContent.trim()));
        expect(kv50.includes('版本键'), 'kv 区出现「版本键」', kv50);
        const vk = await page.evaluate(() => {
            const ks = Array.from(document.querySelectorAll('#modelDrawerBody .kv .k'));
            const hit = ks.find(el => el.textContent.trim() === '版本键');
            return hit && hit.nextElementSibling ? hit.nextElementSibling.textContent.trim() : null;
        });
        expect(vk === 'ChangeID', '版本键值 = ChangeID', vk);
        await closeDrawer(page);

        // ===== D6 DWD 无 SCD 段 / type=NONE 无高级 SQL =====
        console.log('D6. #52 DWD 不出现 SCD 策略段 + type=NONE 无高级 SQL');
        await openDrawerById(page, 52);
        const scd52 = await secText(page, 'SCD 策略');
        expect(scd52 === null, 'DWD 不渲染 SCD 策略段', scd52 && scd52.slice(0, 30));
        const labels52 = await sqlPartLabels(page);
        expect(labels52.length === 0, 'type=NONE → 无 SQL 分段标签', labels52);
        await closeDrawer(page);

        // ===== D7 空配置 DIM 不炸 =====
        console.log('D7. 空配置 DIM（scdConfig 存在但 options/字段全空）');
        await openDrawerById(page, 62); // dim_weather：fieldMappings=0 / sourceTables=[] / businessKey=''
        const scd62 = await secText(page, 'SCD 策略');
        // 判据（审 16 M-2 定稿）：该模型 options 只剩平台默认 auditLog=true（表单 scdOptAudit 默认 checked），
        // 等价于「没配过 SCD 策略」→ 整段不渲染，避免伪装成存在明确的表级策略配置。基础 SCD 类型仍在 kv 区展示。
        expect(scd62 === null, '审16 M-2 仅剩平台默认 auditLog 的 DIM 不渲染 SCD 段', scd62 && scd62.slice(0, 50));
        const bodyText62b = await page.$eval('#modelDrawerBody', el => el.textContent);
        expect(/SCD 类型/.test(bodyText62b), '空配置 DIM 仍显示基础 SCD 类型（未被误伤）');
        const bodyText62 = await page.$eval('#modelDrawerBody', el => el.textContent);
        expect(/SCD 类型|字段/.test(bodyText62), '空配置 DIM 仍正常渲染基础信息（未白屏）');
        await closeDrawer(page);

        // ===== D8 SCD 段渲染门槛的四种形态（审 17 M-1：不能只靠生产样本，会假通过）=====
        console.log('D8. SCD 段门槛：options 缺失 / auditLog 缺失 / 显式关闭');
        const patchOpts = async (mutate) => {
            await page.unroute('**/api/models/62').catch(() => {});
            await page.route('**/api/models/62', async (route) => {
                const resp = await route.fetch();
                const json = await resp.json();
                let cfg = json.dim_config;
                if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg); } catch (e) { cfg = null; } }
                if (cfg && cfg.scdConfig) { mutate(cfg.scdConfig); }
                json.dim_config = cfg;
                await route.fulfill({ response: resp, body: JSON.stringify(json) });
            });
        };
        const scdSecAfterOpen = async () => { await openDrawerById(page, 62); const t = await secText(page, 'SCD 策略'); await closeDrawer(page); return t; };

        await patchOpts(scd => { delete scd.options; });
        expect((await scdSecAfterOpen()) === null, '① options 整个缺失 → 不渲染 SCD 段（曾因归一成 false 被误判为「显式关闭」）');

        await patchOpts(scd => { scd.options = {}; });
        expect((await scdSecAfterOpen()) === null, '② options={} → 不渲染');

        await patchOpts(scd => { scd.options = { deleteDetection: false }; });
        expect((await scdSecAfterOpen()) === null, '③ options 有但 auditLog 缺失 → 补默认 true → 不渲染');

        await patchOpts(scd => { scd.options = { auditLog: false }; });
        const offSec = await scdSecAfterOpen();
        expect(offSec !== null, '④ auditLog 显式关闭 → 渲染（数仓审计缺失是要紧信息）');
        expect(/审计日志已关闭/.test(offSec || ''), '④ summary 写「审计日志已关闭」而非「0 项检测开启」', (offSec || '').slice(0, 40));

        await patchOpts(scd => { scd.options = { modifyDetection: true }; });
        const onSec = await scdSecAfterOpen();
        // 计数是「生效开启数」：modifyDetection(显式开) + auditLog(缺失→补平台默认 true) = 2
        expect(onSec !== null && /2 项检测开启/.test(onSec), '⑤ 非默认开关开启 → 渲染且 summary 按生效值计数（含默认开的审计日志）', (onSec || '').slice(0, 40));
        await page.unroute('**/api/models/62');

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
