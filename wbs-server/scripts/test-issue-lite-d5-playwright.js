/**
 * D5 UI 冒烟（Playwright）· 数据开发换壳 Issue_Lite.html v0.2
 * 换壳 v0.2 · D5 / docs/local/HANDOFF.md 附录 A
 *
 * 验证（纯 UI；后端逻辑由 D2/D3/D4 + void/search/completed verify 覆盖）：建单全字段→列表两列→状态流转→
 *   完成弹窗→附件→【Commit E 扩展】拆列/文案统一/完成时间列表=详情/组合搜索+重置/请求竞态拦截(旧成功+旧失败)/
 *   重开清空+再次完成/作废弹窗全流程/admin 含已作废只读详情(无写按钮)/重置连清含已作废→无 console error→viewer。
 * ⚠️ 不点通知/拉群按钮（避免真钉钉）。自启 PORT=3399·跑完按端口精确杀 + 清理测试单/附件。
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const SHOT = path.join(process.env.TEMP || '/tmp', 'issue-lite-d5.png');
const TITLE_PREFIX = '[D5UI]';

let pass = 0, fail = 0;
function ok(n, c, d) { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}  ${d || ''}`); } }
// codex 15 C-1 范式（F 收口 sweep）：netstat 本地地址列精确端口比较（findstr :3399 子串匹配会误命中 33990-33999）
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(line => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) {} });
    } catch (_) {}
}
function cleanupRows() {
    return new Promise((res) => { const db = new sqlite3.Database(DB_FILE); db.serialize(() => { db.run(`DELETE FROM issue_lite_attachments WHERE issue_lite_id IN (SELECT id FROM issue_lite WHERE title LIKE ?)`, [TITLE_PREFIX + '%'], () => {}); db.run(`DELETE FROM issue_lite WHERE title LIKE ?`, [TITLE_PREFIX + '%'], () => { db.close(); res(); }); }); });
}
async function loginAs(ctx, token) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });
    await page.evaluate(t => localStorage.setItem('token', t), token);
    await page.goto(`${BASE}/Issue_Lite.html`, { waitUntil: 'load' });
    return page;
}

(async () => {
    killPort(TEST_PORT); await cleanupRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); }); child.stderr.on('data', d => { log += d.toString(); });
    const deadline = Date.now() + 12000; let ready = false;
    while (Date.now() < deadline) { if (/数据开发换壳 C1] ✅ issue_lite 表就绪/.test(log)) { try { const r = await fetch(`${BASE}/api/issue-lite`); if (r.status === 401) { ready = true; break; } } catch (_) {} } await new Promise(r => setTimeout(r, 400)); }
    ok('服务就绪', ready);

    const browser = await chromium.launch();
    try {
        const adminTok = await fx.signAs(fx.ADMIN_ID);
        const viewerTok = await fx.signAs(fx.VIEWER_ID);
        const ctx = await browser.newContext();
        const errors = [];
        const page = await loginAs(ctx, adminTok);
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
        page.on('dialog', d => d.accept());
        await page.waitForTimeout(1000);

        ok('标题正确', (await page.title()).includes('数据开发'));
        ok('新建登记按钮可见(非 viewer)', await page.locator('#btnNew').isVisible());

        // 建单全字段
        await page.click('#btnNew'); await page.waitForTimeout(300);
        ok('建单弹窗打开', await page.locator('#createModal.open').isVisible());
        const createModalText = await page.locator('#createModal').innerText();
        ok('建单弹窗统一为期望完成时间', createModalText.includes('期望完成时间') && !createModalText.includes('需求完成时间'));
        const t = TITLE_PREFIX + '合同取数';
        await page.fill('#fTitle', t);
        await page.fill('#fReqName', '赵六');
        await page.selectOption('#fReqDept', '市场营销部'); // Commit D：部门改共享下拉（fill→selectOption）
        await page.fill('#fReqPhone', '13811112222');
        await page.fill('#fReqDate', '2026-08-18');
        await page.fill('#fOa', '364265');
        await page.selectOption('#fNotifyTarget', '10');
        await page.fill('#fDesc', 'D5 UI 描述');
        await page.click('#btnSubmitCreate');
        await page.waitForTimeout(900);
        ok('建单后详情抽屉打开', await page.locator('#drawer.open').isVisible());
        // 列表：需求方列 + ID 带 # + 无附件/群列
        await page.click('#drawerOverlay'); await page.waitForTimeout(300);
        const rowHtml = await page.locator(`#ilTableBody tr:has-text("${t}")`).innerHTML().catch(() => '');
        ok('列表出现新单 + 需求方列(市场营销部 赵六)', rowHtml.includes('市场营销部') && rowHtml.includes('赵六'), rowHtml.slice(0, 80));
        ok('列表 ID 带 # 前缀', rowHtml.includes('#'));
        const heads = await page.locator('#issueLiteTable thead').innerText();
        ok('列表表头统一为期望完成时间', heads.includes('期望完成时间') && !heads.includes('需求完成时间'), heads.replace(/\n/g, '|'));
        ok('列表表头有 预计完成时间 + 无 附件/群', heads.includes('预计完成时间') && heads.includes('创建时间') && !heads.includes('附件') && !heads.includes('群'), heads.replace(/\n/g, '|'));

        // 打开详情：顶部操作栏进入预计完成弹窗 → 自动进处理中（对齐数据修正范式）
        await page.click(`#ilTableBody tr:has-text("${t}")`); await page.waitForTimeout(500);
        const beforeEta = await page.locator('#drawerBody').innerText();
        const detailCreatedAt = await page.locator('.il-detail-item:has(> label:text-is("创建时间")) .val').innerText();
        ok('详情显示期望完成时间且无旧文案', beforeEta.includes('期望完成时间') && beforeEta.includes('2026-08-18') && !beforeEta.includes('需求完成时间'));
        ok('详情显示非空创建时间值', /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(detailCreatedAt.trim()), detailCreatedAt);
        ok('预计回填入口位于顶部操作栏且无独立编辑区', (await page.locator('#drawerBody > .u-action-bar button:has-text("回复预计完成")').count()) === 1 && (await page.locator('#drawerBody > .u-detail-section h3:has-text("预计完成时间")').count()) === 0);
        // 单据仍在待处理态时，非开发非管理员不能看到回填入口（验证 can_estimate 前后端契约，不靠终态隐藏）。
        const ctx3 = await browser.newContext();
        const page3 = await loginAs(ctx3, await fx.signAs(fx.CONTACT_ID)); await page3.waitForTimeout(800);
        await page3.goto(`${BASE}/Issue_Lite.html?id=${await page.evaluate(() => currentDrawerId)}`, { waitUntil: 'load' }); await page3.waitForTimeout(700);
        ok('待处理态非开发非管理员不显示预计回填入口', (await page3.locator('#drawerBody button:has-text("预计完成")').count()) === 0);
        await ctx3.close();
        await page.click('#drawerBody > .u-action-bar button:has-text("回复预计完成")');
        ok('预计完成弹窗打开', await page.locator('#estimateModal.open').isVisible());
        await page.fill('#ilEtaInput', '2026-08-20');
        await page.click('#btnSubmitEstimate'); await page.waitForTimeout(800);
        const afterEta = await page.locator('#drawerBody').innerText();
        ok('回填预计 → 自动进处理中 + 显示预计时间', afterEta.includes('处理中') && afterEta.includes('2026-08-20'));
        ok('通知区有「通知业务方·预计」行', afterEta.includes('通知业务方·预计'));

        // 标记完成弹窗
        await page.click('#drawerBody button:has-text("标记完成")'); await page.waitForTimeout(300);
        ok('完成弹窗打开', await page.locator('#completeModal.open').isVisible());
        await page.fill('#cNote', '已完成取数并交付Excel文件一份');
        await page.fill('#cBoard', 'https://bi.example.com/board/9');
        await page.click('#btnSubmitComplete'); await page.waitForTimeout(800);
        const dbody = await page.locator('#drawerBody').innerText();
        ok('完成后渲染完成说明 + 已完成态', dbody.includes('已完成') && dbody.includes('已完成取数并交付Excel文件一份'));
        // 通知区（照数据修正范式）：通知 section + 业务方通知行显人名 + 发送通知按钮
        ok('详情有「通知」区 + 业务方行显需求人名 + 发送通知按钮',
            dbody.includes('通知') && dbody.includes('赵六') && (await page.locator('#drawerBody button:has-text("发送通知")').count()) > 0);
        ok('详情有「讨论群」区 + 拉群按钮', dbody.includes('讨论群') && (await page.locator('#drawerBody button:has-text("拉群讨论")').count()) > 0);

        // 附件上传
        const newId = await page.evaluate(() => currentDrawerId);
        await page.evaluate(id => { document.getElementById('attachInput').dataset.issueId = id; }, newId);
        await page.setInputFiles('#attachInput', { name: '交付说明.txt', mimeType: 'text/plain', buffer: Buffer.from('hello d5') });
        await page.waitForTimeout(900);
        ok('附件上传后出现在附件区', (await page.locator('#attList').innerText()).includes('交付说明.txt'));
        // 删除附件
        await page.click('#attList .del'); await page.waitForTimeout(700);
        ok('附件删除后消失', (await page.locator('#attList').innerText()).includes('暂无附件'));

        // ===== Commit E：拆列 + 文案统一 + 完成时间列表=详情 =====
        const heads2 = await page.locator('#issueLiteTable thead').innerText();
        ok('E: 表头业务部门/业务方两列且无旧「需求方」', heads2.includes('业务部门') && heads2.includes('业务方') && !heads2.includes('需求方'), heads2.replace(/\n/g, '|'));
        ok('E: 表头含 OA 单号列（用户拍板新增）', heads2.includes('OA 单号'));
        const detText = await page.locator('#drawerBody').innerText();
        ok('E: 详情文案=业务方/业务方手机号（无需求人）', detText.includes('业务方手机号') && !detText.includes('需求人手机号'));
        const detDone = (await page.locator('.il-detail-item:has(> label:text-is("实际完成时间")) .val').innerText()).trim();
        await page.click('#drawerOverlay'); await page.waitForTimeout(300);
        const rowCells = (await page.locator(`#ilTableBody tr:has-text("${t}") td`).allInnerTexts()).map(c => c.trim());
        ok('E: 列表业务部门/业务方独立两列', rowCells.includes('市场营销部') && rowCells.includes('赵六'), rowCells.join('|'));
        const headCells = (await page.locator('#issueLiteTable thead th').allInnerTexts()).map(s => s.trim());
        const oaIdx = headCells.findIndex(h => h.startsWith('OA 单号'));
        ok('E: OA 值位于 OA 单号列（按表头索引定位·非整行模糊匹配）', oaIdx > -1 && rowCells[oaIdx] === '364265', `idx=${oaIdx} val=${rowCells[oaIdx]}`);
        // 用户拍板（2026-07-22）：OA 单号列位于 ID 右侧（第 2 列）；「标题」列头改称「需求描述」（数据仍为 title 字段）
        ok('E: OA 单号列位于 ID 右侧第 2 列 + 列头「需求描述」在其右', oaIdx === 1 && headCells[2] && headCells[2].startsWith('需求描述'), headCells.join('|'));
        ok('E: 列表实际完成时间 = 详情值', /^\d{4}/.test(detDone) && rowCells.includes(detDone), `detail=${detDone} row=${rowCells.join('|')}`);

        // ===== E: 组合搜索 + 重置 =====
        await page.fill('#filterSearch', '合同取数'); await page.waitForTimeout(800);
        ok('E: 关键词搜索命中', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 1);
        await page.selectOption('#filterDept', '人事行政部'); await page.waitForTimeout(800);
        ok('E: 换业务部门后不命中', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 0);
        // 重置按钮经用户拍板取消——各筛选项逐个清
        await page.selectOption('#filterDept', ''); await page.fill('#filterSearch', ''); await page.waitForTimeout(800);
        ok('E: 逐项清空筛选后恢复', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 1);

        // ===== E: 请求竞态（codex 16 D-M-3：拦截延迟旧响应·旧成功 + 旧失败两态被 loadSeq 丢弃）=====
        // codex 17 E-H-1：RACEERR 用 fulfill 200+非法 JSON（res.json() 异常=旧失败路径）而非 abort/500——
        //   零浏览器网络噪音，「0 console error」门槛保持严格无过滤
        await page.route('**/api/issue-lite?*', async route => {
            const url = route.request().url();
            if (url.includes('RACEOK')) { await new Promise(r => setTimeout(r, 1500)); return route.continue(); }
            if (url.includes('RACEERR')) { await new Promise(r => setTimeout(r, 1500)); return route.fulfill({ status: 200, contentType: 'application/json', body: '{broken-json' }); }
            return route.continue();
        });
        await page.fill('#filterSearch', 'RACEOK'); await page.waitForTimeout(450); // 防抖后旧慢请求已发出（将延迟 1.5s 返回空结果）
        await page.fill('#filterSearch', ''); await page.waitForTimeout(2400); // 清空触发新快请求先回·旧响应后到应被丢弃
        ok('E: 旧慢成功响应被丢弃（列表仍为清空后全量）', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 1);
        await page.fill('#filterSearch', 'RACEERR'); await page.waitForTimeout(450);
        await page.fill('#filterSearch', ''); await page.waitForTimeout(2400);
        ok('E: 旧慢失败响应被丢弃（不显示加载失败）', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 1 && !(await page.locator('#emptyState').isVisible()));
        await page.unroute('**/api/issue-lite?*');

        // ===== E: 重开清空 + 再次完成刷新（UI 层·后端已由 completed verify 钉住）=====
        await page.click(`#ilTableBody tr:has-text("${t}")`); await page.waitForTimeout(600);
        await page.click('#drawerBody button:has-text("重新打开")'); await page.waitForTimeout(800);
        const reopenDone = (await page.locator('.il-detail-item:has(> label:text-is("实际完成时间")) .val').innerText()).trim();
        ok('E: 重开后详情实际完成时间清空为 —', reopenDone === '—', reopenDone);
        await page.click('#drawerBody button:has-text("标记完成")'); await page.waitForTimeout(300);
        await page.fill('#cNote', '第二次完成：修订后重新交付看板E2E');
        await page.click('#btnSubmitComplete'); await page.waitForTimeout(800);
        const secondDone = (await page.locator('.il-detail-item:has(> label:text-is("实际完成时间")) .val').innerText()).trim();
        ok('E: 再次完成后实际完成时间刷新为新值', /^\d{4}/.test(secondDone), secondDone);

        // ===== E: 作废弹窗全流程（建单人=admin）=====
        ok('E: 详情有作废危险按钮', (await page.locator('#drawerBody button:has-text("作废")').count()) === 1);
        await page.click('#drawerBody button:has-text("作废")'); await page.waitForTimeout(300);
        ok('E: 作废弹窗打开且含不可恢复提示', await page.locator('#voidModal.open').isVisible() && (await page.locator('#voidModal').innerText()).includes('不可恢复'));
        await page.click('#btnSubmitVoid'); await page.waitForTimeout(300);
        ok('E: 空原因被前端拦截', await page.locator('#voidErr').isVisible());
        await page.fill('#vReason', 'E2E 作废：业务方撤回需求');
        await page.click('#btnSubmitVoid'); await page.waitForTimeout(900);
        ok('E: 作废成功后抽屉关闭 + 默认列表消失', !(await page.locator('#drawer.open').isVisible()) && (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 0);

        // ===== E: admin 含已作废只读详情 =====
        ok('E: 含已作废筛选对 admin 可见', await page.locator('#voidedFilterWrap').isVisible());
        await page.check('#filterVoided'); await page.waitForTimeout(800);
        const vrow = page.locator(`#ilTableBody tr:has-text("${t}")`);
        ok('E: 含已作废后行回归且状态列显已作废', (await vrow.count()) === 1 && (await vrow.innerText()).includes('已作废'));
        await vrow.click(); await page.waitForTimeout(700);
        const vbody = await page.locator('#drawerBody').innerText();
        ok('E: 已作废详情=徽章+原状态+原因+作废人时间', vbody.includes('已作废') && vbody.includes('原状态') && vbody.includes('E2E 作废：业务方撤回需求'));
        // codex 17 E-M-2：零按钮白名单式断言（任何 button 出现即违规·比逐类黑名单枚举更强）——
        //   查已读/流转/作废/拉群/附件传/后补对象全封；附件删除入口是 span.del 单独断
        ok('E: 已作废详情零按钮 + 无操作栏 + 无附件删除入口',
            (await page.locator('#drawerBody button').count()) === 0
            && (await page.locator('#drawerBody .u-action-bar').count()) === 0
            && (await page.locator('#attList .del').count()) === 0);
        ok('E: 已作废保留完成说明留痕', vbody.includes('第二次完成：修订后重新交付看板E2E'));
        // 末次审 M-4：通知区锁定文案——不出现「可重试/需先XX」类暗示仍可写入的提示
        ok('E: 已作废通知区锁定文案（无可重试/需先XX 误导）', vbody.includes('已作废，不可发送') && !vbody.includes('可重试') && !vbody.includes('需先'));
        await page.click('#drawerOverlay'); await page.waitForTimeout(300);
        // codex 17 E-M-5：含已作废模式点状态列排序不炸（已作废行按原状态参与排序·口径固化）
        await page.click('#issueLiteTable th[data-sort-by="status"]'); await page.waitForTimeout(500);
        ok('E: 含已作废模式状态列排序不炸且行仍在', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 1);
        await page.uncheck('#filterVoided'); await page.waitForTimeout(600);
        ok('E: 取消含已作废后作废行消失', (await page.locator(`#ilTableBody tr:has-text("${t}")`).count()) === 0);

        // ===== E: 后补通知对象最小闭环（codex 17 E-M-4）=====
        // 示例用户A建单不选通知对象 → 示例开发C(非建单人普通用户)无按钮 → 示例用户A弹窗排除本人 → 补选示例开发C → 出现发送入口
        const ctxF = await browser.newContext();
        const pageF = await loginAs(ctxF, await fx.signAs(fx.CONTACT_ID)); await pageF.waitForTimeout(800);
        pageF.on('dialog', d => d.accept());
        pageF.on('console', m => { if (m.type() === 'error') errors.push('[pageF] ' + m.text()); }); // 复E-M-2：新页面纳入零 error 门槛
        const t2 = TITLE_PREFIX + '后补对象单';
        await pageF.click('#btnNew'); await pageF.waitForTimeout(300);
        await pageF.fill('#fTitle', t2);
        await pageF.fill('#fReqName', '钱七');
        await pageF.selectOption('#fReqDept', '财务管理部');
        await pageF.fill('#fReqPhone', '13822223333');
        await pageF.click('#btnSubmitCreate'); await pageF.waitForTimeout(900);
        const ntBody = await pageF.locator('#drawerBody').innerText();
        ok('E: 未选通知对象→详情显示空缺行+选择按钮(建单人)', ntBody.includes('建单时未选择通知对象') && (await pageF.locator('#drawerBody button:has-text("选择通知对象")').count()) === 1);
        const t2id = await pageF.evaluate(() => currentDrawerId);
        ok('E: 留空 OA 详情显示完整 datadev-{自身id} 占位号（触发器原子补全）', ntBody.includes(`datadev-${t2id}`), `t2id=${t2id}`);
        // 示例开发C(10·非建单人普通用户)：无后补按钮
        const ctxJ = await browser.newContext();
        const pageJ = await loginAs(ctxJ, await fx.signAs(10)); await pageJ.waitForTimeout(600);
        pageJ.on('console', m => { if (m.type() === 'error') errors.push('[pageJ] ' + m.text()); }); // 复E-M-2
        await pageJ.goto(`${BASE}/Issue_Lite.html?id=${t2id}`, { waitUntil: 'load' }); await pageJ.waitForTimeout(700);
        ok('E: 非建单人普通用户无选择通知对象按钮', (await pageJ.locator('#drawerBody button:has-text("选择通知对象")').count()) === 0);
        await ctxJ.close();
        // 示例用户A弹窗：候选排除本人（仅 请选择+示例开发C 两项）→ 补选 → 出现通知对方发送入口
        await pageF.click('#drawerBody button:has-text("选择通知对象")'); await pageF.waitForTimeout(300);
        const optTexts = (await pageF.locator('#tTarget option').allInnerTexts()).map(s => s.trim());
        ok('E: 后补弹窗候选排除本人(示例用户A)', optTexts.length === 2 && !optTexts.some(o => o.includes('示例用户A')), optTexts.join('|'));
        await pageF.selectOption('#tTarget', '10');
        await pageF.click('#btnSubmitTarget'); await pageF.waitForTimeout(900);
        const ntBody2 = await pageF.locator('#drawerBody').innerText();
        ok('E: 补选后出现通知对方行+发送入口(发送仍手动)', ntBody2.includes('通知对方') && !ntBody2.includes('建单时未选择通知对象') && (await pageF.locator('#drawerBody button:has-text("发送通知")').count()) >= 1);
        // 复E-L-1：断言持久化对象确为所选示例开发C（详情 API 读回 notify_target_id=10，防错存其他合法对象）
        const t2Detail = await pageF.evaluate(async (id) => { const r = await authFetch('/api/issue-lite/' + id); return r.ok ? await r.json() : null; }, t2id);
        ok('E: 持久化通知对象=示例开发C(10)', !!t2Detail && Number(t2Detail.notify_target_id) === 10 && ntBody2.includes('示例开发C'), JSON.stringify(t2Detail && t2Detail.notify_target_id));
        await ctxF.close();

        await page.screenshot({ path: SHOT, fullPage: true });
        ok('截图已保存', true, SHOT);
        ok('无 console error（严格零过滤·codex 17 E-H-1）', errors.length === 0, errors.slice(0, 3).join(' | '));
        await ctx.close();

        // viewer：建单按钮隐藏
        const ctx2 = await browser.newContext();
        const page2 = await loginAs(ctx2, viewerTok); await page2.waitForTimeout(800);
        ok('viewer 建单按钮隐藏', !(await page2.locator('#btnNew').isVisible()));
        await ctx2.close();
    } catch (e) { ok('UI 冒烟执行', false, e.message); }
    finally { await browser.close(); try { child.kill('SIGKILL'); } catch (_) {} killPort(TEST_PORT); await cleanupRows(); }

    console.log(`\n总判定：${fail === 0 ? '✅ D5 UI PASS' : '❌ D5 UI FAIL'}（${pass} 通过 / ${fail} 失败）·截图 ${SHOT}`);
    process.exit(fail === 0 ? 0 : 1);
})();
