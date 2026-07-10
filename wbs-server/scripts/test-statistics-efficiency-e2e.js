/**
 * test-statistics-efficiency-e2e.js — 统计中心效率统计 Playwright 交互自验（收尾 commit）
 *
 * 覆盖（方案 §五 + 任务书要求 + 用户执行中追加口径·四卡片 UI 改版 + 三段仅完结单口径）：
 *   1. 页面加载渲染两区块（四模块效率卡片/趋势折线）——卡片：四卡渲染 / 堆叠条三段宽度和=100%±1 /
 *      主数字与 API totalStats.avg 一致 / 副行计数 / 点卡片下钻
 *   2. 下钻明细表出现且排序、分页可用（模块 tab 切换 + 三段统一表头）
 *   3. 两个新端点返回 200 且结构符合预期：byType 细分 + 三段标签 开发响应/处理中/验收归档 +
 *      ⭐聚合可加性（Σ stageStats.avg ≈ totalStats.avg，round1 容差 0.21）+ 三段 count 统一（无在途混入）
 *   4. 0 console error（滤 favicon 噪声，按 URL 过滤）
 *   5. 聚合数字与明细行数逻辑自洽：done+inflight+aborted=总数；detail rows.length===该模块 total；
 *      本地库四模块均有真实数据（对齐任务书给出的 修正14/开发8/协作51/迭代18）
 *   6. 类型筛选 + 按类型细分小表可用（用户追加口径②）
 *
 * 只读浏览：不提交任何表单、不触碰生产数据，纯 GET + 前端交互观察。
 * 直连本机已在跑的 3000 端口（真实 task_pool.db，非 fixture 隔离——本脚本全程只读）。
 *
 * 用法：node scripts/test-statistics-efficiency-e2e.js
 */
'use strict';

const path = require('path');
const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.PORT || '3000';
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
const CHROME_PATH = 'C:/Users/FY/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

let pass = 0;
let fail = 0;
const failures = [];
function check(cond, label, detail) {
    if (cond) {
        pass++;
        console.log(`  [OK] ${label}`);
    } else {
        fail++;
        failures.push({ label, detail });
        console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
    }
}

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
});

function httpGetJson(p, token) {
    return new Promise((resolve, reject) => {
        http.get({ host: 'localhost', port: PORT, path: p, headers: { Authorization: 'Bearer ' + token } }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }); }
                catch (e) { resolve({ status: res.statusCode, body: null, raw: d }); }
            });
        }).on('error', reject);
    });
}

async function signAsAdmin() {
    const user = await dbGet("SELECT id, username, display_name, role FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
    if (!user) throw new Error('db 中找不到 admin 用户，无法签发 JWT');
    const token = jwt.sign(
        { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
        JWT_SECRET,
        { expiresIn: '2h' }
    );
    return token;
}

async function main() {
    console.log('=== 统计中心效率统计 Playwright 交互自验 ===\n');

    console.log('--- 0. 前置：探测 server / 签发 admin JWT ---');
    const versionRes = await httpGetJson('/api/version', 'no-token-needed').catch(() => null);
    check(!!versionRes, '本机 server 在 3000 端口响应', versionRes ? '' : '请先手动起 server（node server.js）');
    const token = await signAsAdmin();
    check(!!token, 'admin JWT 签发成功');
    console.log('');

    // ============================================================
    // 1. API 层：两端点 200 + 结构 + 聚合/明细自洽
    // ============================================================
    console.log('--- 1. API 层：/api/statistics/efficiency + /detail ---');
    const agg = await httpGetJson('/api/statistics/efficiency?days=all', token);
    check(agg.status === 200, 'GET /api/statistics/efficiency?days=all → 200', `实际 ${agg.status}`);
    check(Array.isArray(agg.body && agg.body.modules) && agg.body.modules.length === 4,
        '聚合响应含 4 个模块', agg.body ? `实际 ${(agg.body.modules || []).length} 个` : '响应体为空');

    const EXPECTED_TOTAL = { correction: 14, issue: 8, collab: 51, sys: 18 };
    const moduleByKey = {};
    (agg.body.modules || []).forEach((m) => { moduleByKey[m.module] = m; });

    for (const key of ['correction', 'issue', 'collab', 'sys']) {
        const m = moduleByKey[key];
        check(!!m, `聚合响应含模块 ${key}`, m ? '' : '缺失');
        if (!m) continue;
        const sum = m.counts.done + m.counts.inflight + m.counts.aborted;
        check(sum === m.counts.total, `${m.label}：done+inflight+aborted=total（${m.counts.done}+${m.counts.inflight}+${m.counts.aborted}=${m.counts.total}）`,
            sum === m.counts.total ? '' : `实际相加 ${sum} ≠ total ${m.counts.total}`);
        check(m.counts.total === EXPECTED_TOTAL[key], `${m.label}：total 与本地库真实数据一致（期望 ${EXPECTED_TOTAL[key]}）`,
            m.counts.total === EXPECTED_TOTAL[key] ? '' : `实际 ${m.counts.total}`);
        check(m.counts.total > 0, `${m.label}：本地库有真实数据（total>0）`);
    }

    const detailByModule = {};
    for (const key of ['correction', 'issue', 'collab', 'sys']) {
        const d = await httpGetJson(`/api/statistics/efficiency/detail?module=${key}&days=all`, token);
        check(d.status === 200, `GET /api/statistics/efficiency/detail?module=${key} → 200`, `实际 ${d.status}`);
        detailByModule[key] = d.body;
        const expectedTotal = moduleByKey[key] ? moduleByKey[key].counts.total : null;
        check(d.body && Array.isArray(d.body.rows) && d.body.rows.length === expectedTotal,
            `明细 module=${key}：rows.length 与聚合 total 一致（${expectedTotal}）`,
            d.body ? `实际 ${(d.body.rows || []).length}` : '响应体为空');
    }
    // 三段统一口径（四模块同构：开发响应/处理中/验收归档）
    for (const key of ['correction', 'issue', 'collab', 'sys']) {
        const d = detailByModule[key];
        check(d && JSON.stringify(d.stages) === JSON.stringify(['开发响应', '处理中', '验收归档']),
            `明细 module=${key}：三段统一标签 开发响应/处理中/验收归档`, d ? `实际 ${JSON.stringify(d.stages)}` : '响应体为空');
    }

    // ⭐聚合可加性不变量（仅完结单口径修正的核心验证——主会话实测抓到旧口径 Σ519.7≠272.3）：
    //   Σ(stageStats.avg) ≈ totalStats.avg（round1 后容差 0.21）+ 三段 count 与 total.count 统一
    for (const key of ['correction', 'issue', 'collab', 'sys']) {
        const m = moduleByKey[key];
        if (!m) continue;
        if (m.totalStats.count === 0) {
            check(m.stageStats.every((st) => st.avg === null), `${m.label}：0 完结单 → 三段 avg 全 null`);
            continue;
        }
        const sum = m.stageStats.reduce((acc, st) => acc + (st.avg || 0), 0);
        check(Math.abs(sum - m.totalStats.avg) <= 0.21,
            `${m.label}：⭐Σ(stageStats.avg)=${Math.round(sum * 10) / 10} ≈ totalStats.avg=${m.totalStats.avg}（容差 0.21）`,
            `差 ${Math.abs(sum - m.totalStats.avg)}`);
        check(m.stageStats.every((st) => st.count === m.totalStats.count),
            `${m.label}：三段样本数统一 = ${m.totalStats.count}（无在途混入）`,
            `实际 [${m.stageStats.map((st) => st.count).join(',')}]`);
    }

    // 用户口径②：byType 存在且每模块至少 1 个类型分组，counts 精确等于该模块 total
    for (const key of ['correction', 'issue', 'collab', 'sys']) {
        const m = moduleByKey[key];
        check(m && Array.isArray(m.byType) && m.byType.length > 0, `${key}：byType 至少含 1 个类型分组`,
            m ? `实际 ${(m.byType || []).length} 组` : '模块缺失');
        if (m && m.byType) {
            const sumByType = m.byType.reduce((acc, t) => acc + t.counts.total, 0);
            check(sumByType === m.counts.total, `${key}：byType 各组 total 相加 = 模块 total（${sumByType}=${m.counts.total}）`,
                sumByType === m.counts.total ? '' : `实际相加 ${sumByType} ≠ ${m.counts.total}`);
        }
    }
    check(detailByModule.correction && detailByModule.correction.rows.every((r) => r.type !== undefined),
        '数据修正明细：每行含 type 字段');
    check(detailByModule.collab && detailByModule.collab.rows.every((r) => r.type !== undefined),
        '数据协作明细：每行含 type 字段');

    const invalidModule = await httpGetJson('/api/statistics/efficiency/detail?module=bogus', token);
    check(invalidModule.status === 400, '非法 module 参数 → 400', `实际 ${invalidModule.status}`);

    const noAuth = await new Promise((resolve) => {
        http.get({ host: 'localhost', port: PORT, path: '/api/statistics/efficiency' }, (res) => resolve(res.statusCode)).on('error', () => resolve(0));
    });
    check(noAuth === 401, '无 token 访问 → 401', `实际 ${noAuth}`);
    console.log('');

    // ============================================================
    // 2. 浏览器交互层
    // ============================================================
    console.log('--- 2. 浏览器交互层（Playwright headless chromium） ---');
    const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
    const consoleErrors = [];
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('console', (msg) => {
            if (msg.type() !== 'error') return;
            // Chromium 资源加载失败的 console error 文本本身不含 URL（"Failed to load resource:
            // the server responded with a status of 404..."），URL 只在 msg.location().url——
            // 必须连 URL 一起记录才能按 favicon 噪声过滤（对齐任务书"滤 favicon 404"要求，
            // 早期版本只按 msg.text() 过滤导致漏判，见 verify 报告）。
            const loc = msg.location && msg.location();
            consoleErrors.push({ text: msg.text(), url: (loc && loc.url) || '' });
        });
        page.on('pageerror', (err) => consoleErrors.push({ text: err.message, url: '' }));

        // JWT 注入：login.html 中继跳转（鉴权页直接 goto 会被 checkAuth 销毁 context）
        await page.goto(`${BASE_URL}/login.html`);
        await page.evaluate((tk) => localStorage.setItem('token', tk), token);

        await page.goto(`${BASE_URL}/Statistics.html`, { waitUntil: 'networkidle', timeout: 20000 });

        // ① 四模块效率卡片（UI 改版）：四卡渲染 / 主数字与 API 一致 / 堆叠条三段宽度和 ≈ 100%
        await page.waitForSelector('#moduleCards .eff-module-card', { timeout: 10000 });
        const moduleCardCount = await page.locator('#moduleCards .eff-module-card').count();
        check(moduleCardCount === 4, '① 四模块效率卡片渲染 4 张', `实际 ${moduleCardCount} 张`);

        // 主数字与 API totalStats.avg 一致（data-avg-total 属性直存 API 值，逐模块比对）
        for (const key of ['correction', 'issue', 'collab', 'sys']) {
            const m = moduleByKey[key];
            if (!m) continue;
            const attr = await page.locator(`#moduleCards .eff-module-card[data-module="${key}"] .eff-card-num`).getAttribute('data-avg-total');
            const expected = m.totalStats.avg === null ? '' : String(m.totalStats.avg);
            check(attr === expected, `① ${m.label} 卡片主数字 = API totalStats.avg（${expected || 'null'}）`, `实际 data-avg-total="${attr}"`);
        }

        // 堆叠条：对有完结单的模块，三段 div 宽度和 = 100% ± 1
        for (const key of ['correction', 'issue', 'collab', 'sys']) {
            const m = moduleByKey[key];
            if (!m || m.totalStats.count === 0) continue;
            const segSum = m.stageStats.reduce((acc, st) => acc + (st.avg || 0), 0);
            if (segSum <= 0) {
                // 完结单全零耗时（如同秒建单归档的测试数据），无占比可分——跳过宽度断言，验证空态提示存在
                const emptyHint = await page.locator(`#moduleCards .eff-module-card[data-module="${key}"] .eff-card-empty`).count();
                check(emptyHint === 1, `① ${m.label}：段和为 0 → 显示空态提示（无假占比条）`, `实际 ${emptyHint}`);
                continue;
            }
            const segs = page.locator(`#moduleCards .eff-module-card[data-module="${key}"] .eff-card-bar .eff-seg`);
            const segCount = await segs.count();
            check(segCount === 3, `① ${m.label} 堆叠条渲染 3 段`, `实际 ${segCount} 段`);
            let widthSum = 0;
            for (let i = 0; i < segCount; i++) {
                const w = await segs.nth(i).evaluate((el) => parseFloat(el.style.width) || 0);
                widthSum += w;
            }
            check(Math.abs(widthSum - 100) <= 1, `① ${m.label} 堆叠条三段宽度和 = ${Math.round(widthSum * 100) / 100}%（100%±1）`, `实际 ${widthSum}`);
        }

        // 卡片副行含完结/在途/终止计数
        const corrSub = await page.locator('#moduleCards .eff-module-card[data-module="correction"] .eff-card-sub').textContent();
        check(/完结 \d+ 单 · 在途 \d+ · 终止 \d+/.test(corrSub || ''), '① 卡片副行含「完结 M 单 · 在途 X · 终止 Y」', `实际 "${corrSub}"`);

        // ② 趋势折线：echarts 渲染出 canvas
        await page.waitForTimeout(500); // echarts 异步渲染缓冲
        const trendCanvas = await page.locator('#trendLineChart canvas').count();
        check(trendCanvas > 0, '② 趋势折线图渲染出 canvas', `实际 ${trendCanvas}`);

        // ④ 下钻明细表：默认模块（数据修正）
        await page.waitForSelector('#detailTableBody tr', { timeout: 10000 });
        const initialRowCount = await page.locator('#detailTableBody tr').count();
        check(initialRowCount > 0, '④ 明细表默认渲染出数据行（数据修正模块）', `实际 ${initialRowCount} 行`);
        const theadColCount = await page.locator('#detailTableHead th').count();
        check(theadColCount === 9, '④ 明细表头 9 列（ID/标题/类型/创建时间/状态/三段/总时长）', `实际 ${theadColCount} 列`);

        // 三段表头文案（前端由后端 stages 驱动，动态渲染）
        const stage1HeaderText = await page.locator('#detailTableHead th[data-sort-by="stage0"]').textContent();
        check((stage1HeaderText || '').includes('开发响应'), '④ 阶段①表头显示"开发响应"', `实际 "${stage1HeaderText}"`);
        const stage3HeaderText = await page.locator('#detailTableHead th[data-sort-by="stage2"]').textContent();
        check((stage3HeaderText || '').includes('验收归档'), '④ 阶段③表头显示"验收归档"', `实际 "${stage3HeaderText}"`);

        // 按类型细分小表：数据修正应渲染出 single/batch 两行（或至少 1 行，视当前库真实分布）
        await page.waitForSelector('#typeBreakdownBody tr', { timeout: 10000 });
        const typeBreakdownRowCount = await page.locator('#typeBreakdownBody tr').count();
        check(typeBreakdownRowCount > 0, '④ 按类型细分小表渲染出至少 1 行', `实际 ${typeBreakdownRowCount} 行`);

        // 类型筛选下拉：选项数应等于按类型细分小表行数 + 1（"全部类型"）
        const typeFilterOptionCount = await page.locator('#typeFilter option').count();
        check(typeFilterOptionCount === typeBreakdownRowCount + 1,
            '④ 类型筛选下拉选项数 = 按类型细分行数 + 1（含"全部类型"）',
            `实际下拉 ${typeFilterOptionCount} 项，细分表 ${typeBreakdownRowCount} 行`);

        // 类型筛选可用：选一个非空类型，断言行数变化（或至少不报错、表格仍渲染）
        const firstTypeValue = await page.locator('#typeFilter option').nth(1).getAttribute('value');
        if (firstTypeValue) {
            const beforeFilterRowCount = await page.locator('#detailTableBody tr').count();
            await page.selectOption('#typeFilter', firstTypeValue);
            await page.waitForTimeout(200);
            const afterFilterRowCount = await page.locator('#detailTableBody tr').count();
            check(afterFilterRowCount > 0, '④ 类型筛选后表格仍渲染出数据（未筛空/未报错）', `筛选前 ${beforeFilterRowCount} 行，筛选后 ${afterFilterRowCount} 行`);
            check(afterFilterRowCount <= beforeFilterRowCount, '④ 类型筛选后行数 <= 筛选前（子集关系成立）',
                `筛选前 ${beforeFilterRowCount}，筛选后 ${afterFilterRowCount}`);
            // 还原为"全部类型"
            await page.selectOption('#typeFilter', '');
            await page.waitForTimeout(200);
        }

        // 点击按类型细分小表某行：应同步类型筛选下拉值 + 高亮 active
        const firstBreakdownRow = page.locator('#typeBreakdownBody tr').first();
        const firstBreakdownType = await firstBreakdownRow.getAttribute('data-type');
        await firstBreakdownRow.click();
        await page.waitForTimeout(200);
        const filterValueAfterRowClick = await page.locator('#typeFilter').inputValue();
        check(filterValueAfterRowClick === firstBreakdownType, '④ 点击按类型细分小表行 → 类型筛选下拉同步该类型',
            `期望 "${firstBreakdownType}"，实际 "${filterValueAfterRowClick}"`);
        const rowActiveAfterClick = await firstBreakdownRow.evaluate((el) => el.classList.contains('active'));
        check(rowActiveAfterClick, '④ 点击后该行呈 active 高亮');
        // 还原
        await firstBreakdownRow.click();
        await page.waitForTimeout(200);

        // 排序：默认态本就是 id desc（defaultSort），第一次点 id 表头只是显式落定同方向（无视觉变化，
        // attachTableSort 三态循环 null→desc→asc→null 的设计使然）；第二次点才切到 asc 出现变化——
        // 断言点第二下之后首行变化，不误判"点第一下不变=排序失效"。
        const beforeSortFirstId = await page.locator('#detailTableBody tr').first().locator('td').first().textContent();
        await page.click('#detailTableHead th[data-sort-by="id"]'); // 第一下：null→desc，同当前显示，无变化预期
        await page.waitForTimeout(150);
        await page.click('#detailTableHead th[data-sort-by="id"]'); // 第二下：desc→asc，应变化
        await page.waitForTimeout(150);
        const afterSortFirstId = await page.locator('#detailTableBody tr').first().locator('td').first().textContent();
        check(beforeSortFirstId !== afterSortFirstId, '④ 排序可用：点击 ID 表头两次（desc→asc）后首行变化', `点前 ${beforeSortFirstId} → 点后 ${afterSortFirstId}`);

        // 切到数据协作模块（51 条，超过分页 25/页；改点效率卡片验证"点卡下钻"通路）
        await page.click('#moduleCards .eff-module-card[data-module="collab"]');
        await page.waitForTimeout(400);
        const collabTheadColCount = await page.locator('#detailTableHead th').count();
        check(collabTheadColCount === 9, '④ 切到数据协作后表头仍 9 列（三段统一，不再多 1 段）', `实际 ${collabTheadColCount} 列`);
        const collabTabActive = await page.locator('#moduleTabs .eff-tab[data-module="collab"]').evaluate((el) => el.classList.contains('active'));
        check(collabTabActive, '④ 点数据协作卡片 → 明细 tab 同步 active（点卡下钻通路）');
        const collabCardActive = await page.locator('#moduleCards .eff-module-card[data-module="collab"]').evaluate((el) => el.classList.contains('active'));
        check(collabCardActive, '① 数据协作卡片自身呈 active');
        // 切模块后类型筛选应重置为"全部类型"（不同模块类型集不同）
        const typeFilterAfterModuleSwitch = await page.locator('#typeFilter').inputValue();
        check(typeFilterAfterModuleSwitch === '', '④ 切模块后类型筛选重置为"全部类型"', `实际 "${typeFilterAfterModuleSwitch}"`);

        // 分页：51 条 / 25 每页 = 3 页，断言页码条显示"共 51 条"且下一页按钮可点
        const pageInfoText = await page.locator('#detailPagination .u-page-info').textContent().catch(() => '');
        check(/共\s*51\s*条/.test(pageInfoText || ''), '④ 分页条显示"共 51 条"', `实际："${pageInfoText}"`);
        const beforePageFirstId = await page.locator('#detailTableBody tr').first().locator('td').first().textContent();
        const nextBtn = page.locator('#detailPagination [data-page-nav="next"]');
        const nextDisabled = await nextBtn.getAttribute('disabled');
        check(nextDisabled === null, '④ 分页"下一页"按钮可点（未 disabled）', `disabled=${nextDisabled}`);
        if (nextDisabled === null) {
            await nextBtn.click();
            await page.waitForTimeout(200);
            const afterPageFirstId = await page.locator('#detailTableBody tr').first().locator('td').first().textContent();
            check(beforePageFirstId !== afterPageFirstId, '④ 分页可用：翻页后首行变化', `翻页前 ${beforePageFirstId} → 翻页后 ${afterPageFirstId}`);
        }

        // 时间范围切换：30 天（不崩、四卡重渲染 + 副行样本口径跟随）
        await page.selectOption('#timeRange', '30');
        await page.waitForTimeout(500);
        const cardCountAfterRangeChange = await page.locator('#moduleCards .eff-module-card').count();
        check(cardCountAfterRangeChange === 4, '时间范围切换到 30 天后四卡仍渲染（不崩）', `实际 ${cardCountAfterRangeChange}`);
        const subAfterRangeChange = await page.locator('#moduleCards .eff-module-card[data-module="correction"] .eff-card-sub').textContent();
        check((subAfterRangeChange || '').includes('近 30 天'), '① 副行样本口径跟随时间范围（近 30 天）', `实际 "${subAfterRangeChange}"`);

        // console error 过滤（favicon 噪声——按 URL 过滤，非按文本：Chromium 资源加载失败的
        // console error 文本本身不含 URL，早期版本按 msg.text() 过滤漏判，见 commit 记录修正）
        const realErrors = consoleErrors.filter((e) => !/favicon/i.test(e.url || '') && !/favicon/i.test(e.text || ''));
        check(realErrors.length === 0, '0 console error（已滤 favicon 噪声）',
            realErrors.length ? `${realErrors.length} 条：${realErrors.slice(0, 3).map((e) => `${e.text}${e.url ? ' @ ' + e.url : ''}`).join(' | ')}` : '');
    } finally {
        await browser.close();
    }
    console.log('');

    console.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
    if (fail > 0) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    }
    db.close();
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('e2e 脚本异常：', err);
    process.exit(1);
});
