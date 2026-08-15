/**
 * test-sys-derive-numbering-playwright.js — 系统迭代·派生单子编号「#根_序」真实 DOM 断言
 *   （S13-c·C3，方案 20260813_v1.8 §15.3/§15.4·矩阵仅真实浏览器渲染能证明的面）
 *
 * 循 test-sys-detail-ux-playwright.js 套件范式（外部 server:3000 已运行的真实 task_pool.db +
 * JWT 注入 + login.html 中继跳转 + 直接 SQL 造夹具 + must() 断言计数 + finally 段清理 + 非零退出码）。
 * 与该文件同款契约：本脚本**不**自带端口探测/自启动逻辑——依赖调用方在跑本脚本前已把 server 跑在
 * localhost:3000（含本次改动的最新代码），server 未起时 page.goto/fetch 会失败并落入顶层 catch。
 *
 * 用法：本地 server（3000）已重启到含本文件覆盖改动的代码后：
 *   node scripts/test-sys-derive-numbering-playwright.js
 *
 * 夹具设计（direct SQL 造态，同 test-sys-detail-ux-playwright.js mkMember 同款"给定后端字段测前端
 * 渲染"哲学——derive_root_id/derive_seq 的取号正确性已由 verify-sys-derive-numbering.js DN 组真实
 * HTTP 覆盖，本文件不重复验证取号逻辑，只验证"给定已正确的字段，前端画得对不对"）：
 *   root（已上线，属 done 统计组）
 *     └ childA（derive_root_id=root, derive_seq=1，待受理，属 active 统计组）
 *         └ childB（origin_issue_id=childA, derive_root_id 展平=root, derive_seq=2，待受理）
 *   root2（已上线）+ 27 个子单（derive_seq=1..27，待受理）——超大族独占页夹具（[T6]）
 *
 * 覆盖：
 *   [T1] 列表树形——族相邻 + 子行缩进树枝（.si-row-child/.si-row-last）+ 红色子编号标签文本 #root_seq
 *   [T2] 灰显 context 根行——切到「进行中」统计组过滤（client-side，root 的「已上线」被筛掉但
 *        childA/childB「待受理」仍可见）→ root 应仍渲染（灰显 .si-row-context）保持树形完整
 *   [T3] 搜索子编号命中——整族带出 + 命中行高亮（.si-row-search-hit）
 *   [T4] 详情派生链区块——成员全子编号 + 当前单高亮（.cur）
 *   [T5] 弹窗标题——任抽 2 处（编辑内容/删除任务）含子编号
 *   [T6] 翻页无重复遗漏——默认 pageSize=25，超大族（28 行）独占页 + 全量翻页收集 id 集合核对
 *   [T7] 全程无 console error
 *
 * ⚠️ [S13 收口 LOW 追-8·登记不修] 本文件直写 task_pool.db（同 db 连接跑夹具造数 + finally 段清理），
 *   与 server 进程各自独立打开同一个 SQLite 文件，理论上存在 SQLITE_BUSY 竞态窗口——这是 Windows 环境
 *   下本项目已知的 flaky 档（见 worklog session_20260814 §I4c/I5 子进程临时 db EBUSY 解锁竞态记录），
 *   沿用既有范式登记为已知抖动点，不在本文件单独造锁重试机制（重跑即绿，非本次批次的处置范围）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const ENV_JWT_SECRET = process.env.JWT_SECRET || null;   // .env 里的真实值——server 从 wbs-server 目录正常启动时用它
const FALLBACK_JWT_SECRET = 'default_secret_key_change_me';   // server.js:45 源码字面量兜底值

const db = new sqlite3.Database(DB_PATH);
const run = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

// 〔现场探针实测发现，2026-08-15〕本次外部 server:3000 实际以 cwd=仓库根启动
// （`"C:\...\node.exe" wbs-server/server.js`），server.js:31 `require('dotenv').config()`
// 不带 path 参数、按 **process.cwd()** 解析 .env——仓库根无 .env 文件，dotenv 静默 no-op，
// 该进程的 JWT_SECRET 因此落回源码字面量兜底值 FALLBACK_JWT_SECRET，而非 wbs-server/.env
// 里配置的真实值。本文件加载 wbs-server/.env（同 test-sys-detail-ux-playwright.js 既有注释
// "必须加载 .env"）对"从 wbs-server 目录正常启动"的 server 才是对的——那是这条既定规则的
// 适用前提，这次现场实例的启动方式是例外，不代表规则错。两边硬编码其一都会在另一种启动方式下
// 失配，故做成"实测优先"：对候选 secret 各签一枚短时效 token，真打一次 /api/auth/me 探活，
// 谁验证通过就用谁——不猜、不改 server 端启动方式（任务明确不许重启/杀 server），也兼容未来
// server 改用正常启动方式后 .env 值重新生效的情况。
// [S13 收口 MED 追-2①] 探针 token 改签**真实**查出来的 admin 行（adminRow 由调用方传入，来自
// `SELECT ... FROM users WHERE role='admin' AND status='active'` 的真实结果）——若继续硬编码
// `{id:1,username:'admin'}`，一旦库里 id=1 这个用户不是 active admin（如被停用/角色变了），即便
// secret 完全猜对，`/auth/me` 里 authenticateToken 的"实时校验用户状态"那一步（server.js:4048-4052）
// 也会因账号本身不合法返回 403——探针会把这种"账号问题"误诊成"secret 问题"，排查方向从一开始就错。
async function resolveWorkingJwtSecret(candidates, adminRow) {
    const tried = [];
    for (const secret of candidates) {
        if (!secret) continue;
        const probeTok = jwt.sign({ id: adminRow.id, username: adminRow.username, display_name: adminRow.display_name, role: adminRow.role }, secret, { expiresIn: '5m' });
        try {
            const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${probeTok}` } });
            tried.push(`${secret === ENV_JWT_SECRET ? '.env值' : '兜底字面量'}→HTTP${res.status}`);
            if (res.ok) return secret;
        } catch (e) {
            tried.push(`${secret === ENV_JWT_SECRET ? '.env值' : '兜底字面量'}→探活请求异常:${e && e.message}`);
        }
    }
    throw new Error(`两个候选 JWT_SECRET 均无法通过 /api/auth/me 探活（${tried.join('；')}）——server:3000 是否在跑，或用了第三种 secret？`);
}
// [S13 收口 MED 追-2②] 反向探针（探针双向证明纪律）：只测"两个候选之一能通过"不够——万一 server
// 端点本身从不校验签名（例如中间件被绕过/降级成只信 payload 不验签名），任何 token 都会 200，
// 上面的正向探针会"碰巧"选出一个能用的 secret，却完全没证明 `/api/auth/me` 真的在验签。故意用一个
// 明摆着错的 secret 签 token 打一次，断言**必须非 200**——只有这条负例成立，正向探针挑出来的 secret
// 才有"确实是它、不是随便一个都行"的证明力。
async function probeWrongSecretRejected(adminRow) {
    const badTok = jwt.sign({ id: adminRow.id, username: adminRow.username, display_name: adminRow.display_name, role: adminRow.role }, '__definitely_wrong__', { expiresIn: '5m' });
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${badTok}` } });
    return res.status;
}

let passed = 0, failed = 0;
let fatalError = null;
function must(cond, msg) {
    if (cond) { passed++; console.log('  ✅ ' + msg); return true; }
    failed++; console.log('  ❌ ' + msg); return false;
}

async function loginPage(browser, token) {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}

const RUN_TAG = Date.now();
const createdIssueIds = [];
const FIXTURE_SYSTEM = 'BMS';

async function mkIssue(title, status, extra = {}) {
    const cols = ['type', 'status', 'title', 'system_name', 'source', 'created_by', 'created_by_name', 'intake_required'];
    const vals = ['bug', status, title, FIXTURE_SYSTEM, '内部', 1, '管理员', 1];
    for (const [k, v] of Object.entries(extra)) { cols.push(k); vals.push(v); }
    const ph = cols.map(() => '?').join(',');
    const r = await run(`INSERT INTO sys_issues (${cols.join(',')}) VALUES (${ph})`, vals);
    createdIssueIds.push(r.lastID);
    return r.lastID;
}

(async () => {
    let browser;
    try {
        const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
        if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
        const JWT_SECRET = await resolveWorkingJwtSecret([ENV_JWT_SECRET, FALLBACK_JWT_SECRET], admin);
        // [S13 收口 MED 追-2②] 反向探针：明摆着错的 secret 必须被拒（非 200），证明 /api/auth/me 真的在
        // 验签——不是随便什么 token 都放行，让上面挑出来的 JWT_SECRET 真正有"确实是它"的证明力。
        const wrongSecretStatus = await probeWrongSecretRejected(admin);
        must(wrongSecretStatus !== 200, `[前置] 错误 secret 签的 token 应被 /api/auth/me 拒绝（非 200），实得 HTTP ${wrongSecretStatus}——若这里是 200，说明该端点没有真的在验签，上面探针挑出的 JWT_SECRET 无法确认是"必须是它"还是"随便什么都行"`);
        const adminTok = jwt.sign({ id: admin.id, username: admin.username, display_name: admin.display_name, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });

        // ── 夹具 B：超大族（root2 + 27 子单=28 行）——[T6] 独占页例。**先造**：默认块序=maxId 降序，
        //   先造的族 id 更小、maxId 更小，会排在后面（page 2+），把 id 更大（后造）的小族留在 page 1，
        //   T1/T2 才能在初始页面直接找到——族本身跨页与否不受"谁先造"影响（各自 28/3 行不拆页是
        //   siPackFamilyPages 的不变量，与创建顺序无关，仅影响它们落在第几页，调整顺序不改变被测行为）。
        const root2 = await mkIssue(`SDN-大族根-${RUN_TAG}`, '已上线', { released_at: '2026-08-15 09:00:00' });
        const bigFamilyIds = [root2];
        for (let seq = 1; seq <= 27; seq++) {
            const cid = await mkIssue(`SDN-大族子${seq}-${RUN_TAG}`, '待受理', {
                origin_issue_id: root2, derive_root_id: root2, derive_seq: seq, derive_reason: `S13-c 大族探针 seq${seq}`,
            });
            bigFamilyIds.push(cid);
        }
        await run(`UPDATE sys_issues SET derive_seq_alloc = 27 WHERE id = ?`, [root2]);

        // ── 夹具 A：两级真实派生链 root → childA(seq1) → childB(seq2，展平到 root) ─────────────────
        const root = await mkIssue(`SDN-根单-${RUN_TAG}`, '已上线', { released_at: '2026-08-15 09:00:00' });
        const childA = await mkIssue(`SDN-子单A-${RUN_TAG}`, '待受理', {
            origin_issue_id: root, derive_root_id: root, derive_seq: 1, derive_reason: 'S13-c 测试派生原因A',
        });
        const childB = await mkIssue(`SDN-子单B-${RUN_TAG}`, '待受理', {
            origin_issue_id: childA, derive_root_id: root, derive_seq: 2, derive_reason: 'S13-c 测试派生原因B',
        });
        await run(`UPDATE sys_issues SET derive_seq_alloc = 2 WHERE id = ?`, [root]);   // 保持 alloc 不变量一致（本文件不测取号，仅为不变量整洁）

        browser = await chromium.launch();
        const page = await loginPage(browser, adminTok);
        await page.goto(`${BASE_URL}/Sys_Iteration.html`);
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800);

        // ═══ [T1] 列表树形：族相邻 + 子行缩进树枝 + 红色子编号标签文本 #root_seq ═══════════════════
        console.log('\n── [T1] 列表树形聚类：族相邻 + 缩进树枝 + 红色子编号标签 ──');
        const rowsProbe1 = await page.evaluate(() => {
            const trs = [...document.querySelectorAll('#sysIterationListTable tbody tr')];
            return trs.map((tr, idx) => {
                const idCell = tr.querySelector('td:first-child');
                const numEl = idCell ? idCell.querySelector('.si-derive-num') : null;
                return {
                    idx,
                    text: idCell ? idCell.textContent.trim() : '',
                    hasChildClass: tr.classList.contains('si-row-child'),
                    hasLastClass: tr.classList.contains('si-row-last'),
                    numText: numEl ? numEl.textContent.trim() : null,
                    title: (tr.querySelector('td:nth-child(5)') || {}).textContent || '',
                };
            });
        });
        const rowA = rowsProbe1.find((r) => r.title.includes(`SDN-子单A-${RUN_TAG}`));
        const rowB = rowsProbe1.find((r) => r.title.includes(`SDN-子单B-${RUN_TAG}`));
        const rowRoot = rowsProbe1.find((r) => r.title.includes(`SDN-根单-${RUN_TAG}`));
        must(!!rowRoot && !!rowA && !!rowB, `[T1] 前置：应能在列表 DOM 内按标题定位到 root/childA/childB 三行，实得 root=${!!rowRoot} A=${!!rowA} B=${!!rowB}`);
        if (rowRoot && rowA && rowB) {
            must(Math.abs(rowA.idx - rowRoot.idx) === 1 && Math.abs(rowB.idx - rowA.idx) === 1,
                `[T1] ⭐ 族相邻：root(${rowRoot.idx})/childA(${rowA.idx})/childB(${rowB.idx}) 应连续排列，实得间距 ${rowA.idx - rowRoot.idx}/${rowB.idx - rowA.idx}`);
            must(rowA.hasChildClass === true && rowB.hasChildClass === true,
                `[T1] ⭐ childA/childB 行应带 .si-row-child（缩进树枝），实得 A=${rowA.hasChildClass} B=${rowB.hasChildClass}`);
            must(rowRoot.hasChildClass === false, '[T1] root 行不应带 .si-row-child（根行不缩进）');
            must(rowA.hasLastClass === false && rowB.hasLastClass === true,
                `[T1] ⭐ 族内最后一个子行（childB）应带 .si-row-last（└ 收尾），childA 不应带，实得 A=${rowA.hasLastClass} B=${rowB.hasLastClass}`);
            must(rowA.numText === `#${root}_1`, `[T1] ⭐ childA 红色子编号标签文本应精确等于 #${root}_1，实得 "${rowA.numText}"`);
            must(rowB.numText === `#${root}_2`, `[T1] ⭐ childB 红色子编号标签文本应精确等于 #${root}_2（展平到顶层根，非中间单 childA 的 id），实得 "${rowB.numText}"`);
            must(rowRoot.numText === null, `[T1] root 行不应含 .si-derive-num（根单展示真实 #id，非红色子编号），实得 "${rowRoot.numText}"`);
        }

        // ═══ [T2] 灰显 context 根行（造筛选态：进行中统计组过滤掉「已上线」的 root，childA/B「待受理」仍可见）══
        console.log('\n── [T2] 灰显 context 根行（进行中统计组过滤）──');
        // 〔改用真实 DOM 点击，不 evaluate 直调内部函数〕点顶部统计卡「进行中」（siRenderStats 渲染的
        // `.u-stat-card` 上挂 `onclick="siSetStatFilter('active')"`，见 Sys_Iteration.html:1794/1806）——
        // 比裸调用页面顶层函数更贴近真实用户操作路径，也不必依赖对该函数声明形态/挂载位置的假设。
        await page.click('.u-stat-card:has-text("进行中")');
        await page.waitForTimeout(300);
        const rowsProbe2 = await page.evaluate(() => {
            const trs = [...document.querySelectorAll('#sysIterationListTable tbody tr')];
            return trs.map((tr) => ({
                title: (tr.querySelector('td:nth-child(5)') || {}).textContent || '',
                hasContext: tr.classList.contains('si-row-context'),
            }));
        });
        const rowRoot2 = rowsProbe2.find((r) => r.title.includes(`SDN-根单-${RUN_TAG}`));
        const rowA2 = rowsProbe2.find((r) => r.title.includes(`SDN-子单A-${RUN_TAG}`));
        must(!!rowA2, '[T2] 前置：「进行中」筛选下 childA（待受理）应仍可见');
        must(!!rowRoot2, `[T2] ⭐ root（已上线，本不属于「进行中」组）应仍补显（灰显树根），实得 ${!!rowRoot2}——若此断言落空，说明缺根降级把整族拆散平铺，树形完整性丢失`);
        must(!!rowRoot2 && rowRoot2.hasContext === true, `[T2] ⭐ 补显的 root 行应带 .si-row-context（灰显样式），实得 ${rowRoot2 && rowRoot2.hasContext}`);
        must(!!rowA2 && rowA2.hasContext !== true, '[T2] childA（真实通过筛选，非补显）不应带 .si-row-context');
        // 点「全部」卡复位筛选（同款真实点击，非 evaluate 直调）。
        await page.click('.u-stat-card:has-text("全部")');
        await page.waitForTimeout(300);

        // ═══ [T3] 搜索子编号命中：整族带出 + 命中行高亮 ═══════════════════════════════════════════
        console.log('\n── [T3] 搜索子编号命中——整族带出 + 命中行高亮 ──');
        await page.fill('#siFSearch', `#${root}_1`);
        await page.waitForTimeout(500);
        const rowsProbe3 = await page.evaluate(() => {
            const trs = [...document.querySelectorAll('#sysIterationListTable tbody tr')];
            return trs.map((tr) => ({
                title: (tr.querySelector('td:nth-child(5)') || {}).textContent || '',
                hasHit: tr.classList.contains('si-row-search-hit'),
            }));
        });
        const hitRoot = rowsProbe3.find((r) => r.title.includes(`SDN-根单-${RUN_TAG}`));
        const hitA = rowsProbe3.find((r) => r.title.includes(`SDN-子单A-${RUN_TAG}`));
        const hitB = rowsProbe3.find((r) => r.title.includes(`SDN-子单B-${RUN_TAG}`));
        must(!!hitRoot && !!hitA && !!hitB, `[T3] ⭐ 搜索 "#${root}_1"（仅精确命中 childA）应整族带出 root/childA/childB 三行，实得 root=${!!hitRoot} A=${!!hitA} B=${!!hitB}`);
        must(!!hitA && hitA.hasHit === true, `[T3] ⭐ 精确命中行（childA）应带 .si-row-search-hit 高亮，实得 ${hitA && hitA.hasHit}`);
        // [S13 收口 LOW 追-5] 原文案"高亮=精确匹配"与实现不符——高亮 class（.si-row-search-hit）的真实
        // 驱动源是 siMatchSearch（renderSysIterationRows 的 `siActiveSearch && siMatchSearch(i)`），
        // 该函数含标题/系统名子串等**模糊**匹配分支，不是只认 siIsExactSearchMatch 的精确等值。本用例的
        // 搜索词 "#${root}_1" 恰好只命中 childA（root/childB 的标题、系统名、真实 id 都不含这个子串），
        // 高亮结果与精确命中在这个特定搜索词下巧合重合，不代表实现真把"高亮"和"精确匹配"划了等号。
        must(!!hitRoot && hitRoot.hasHit !== true, '[T3] 家族广播带出的非命中行（root）不应带 .si-row-search-hit（本用例搜索词恰好只命中 childA，故 root 无论按模糊还是精确口径都不该高亮）');
        must(!!hitB && hitB.hasHit !== true, '[T3] 家族广播带出的非命中行（childB）不应带 .si-row-search-hit');
        await page.fill('#siFSearch', '');
        await page.waitForTimeout(500);

        // ═══ [T4] 详情派生链区块：成员全子编号 + 当前单高亮 ══════════════════════════════════════
        console.log('\n── [T4] 详情派生链区块——成员全子编号 + 当前单高亮 ──');
        // [S13 收口 LOW 追-4] 去掉 `window.X && window.X()` 静默短路——siOpenDrawer 是真实全局函数
        // （Sys_Iteration.html:2614 `async function siOpenDrawer`），函数没暴露时应该 ReferenceError
        // 直红，不该被 `&&` 悄悄吞成"区块 0 行"这类看似渲染问题的假象，误导排查方向。
        await page.evaluate((id) => siOpenDrawer(id), childA);
        await page.waitForTimeout(600);
        const chainProbe = await page.evaluate(() => {
            const rows = [...document.querySelectorAll('.si-chain-row')];
            return rows.map((r) => ({
                text: r.textContent,
                isCur: r.classList.contains('cur'),
                numText: (r.querySelector('.si-derive-num, b') || {}).textContent || '',
            }));
        });
        must(chainProbe.length === 3, `[T4] 前置：派生链区块应恰渲染 3 行（root+childA+childB），实得 ${chainProbe.length}`);
        const chainA = chainProbe.find((r) => r.isCur);
        must(!!chainA && chainA.text.includes(`#${root}_1`), `[T4] ⭐ 当前单（childA）所在行应高亮（.cur）且含子编号 #${root}_1，实得 ${JSON.stringify(chainA)}`);
        must(chainProbe.filter((r) => r.isCur).length === 1, '[T4] 应恰 1 行带 .cur（当前单唯一高亮，非多行误标）');
        must(chainProbe.some((r) => r.text.includes(`#${root}_2`)), `[T4] ⭐ 派生链区块应含 childB 子编号 #${root}_2，实得 ${JSON.stringify(chainProbe.map((r) => r.text))}`);
        must(chainProbe.some((r) => r.text.includes('原单')), '[T4] 派生链区块应含"原单" role pill（root 行）');

        // ═══ [T5] 弹窗标题：任抽 2 处含子编号 ═══════════════════════════════════════════════════
        console.log('\n── [T5] 弹窗标题——任抽 2 处（编辑内容/删除任务）含子编号 ──');
        // 抽样①：编辑内容（当前抽屉仍是 childA）
        await page.evaluate(() => { siModalEditInRevision(siDetail.issue); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const editTitle = await page.evaluate(() => document.getElementById('siMHead').textContent);
        must(editTitle === `编辑内容 #${root}_1`, `[T5] ⭐ 编辑内容弹窗标题应精确等于 "编辑内容 #${root}_1"，实得 "${editTitle}"`);
        await page.evaluate(() => { siCloseModal(); });
        await page.waitForTimeout(200);
        // 抽样②：删除任务（切到 childB，真叶子单，无派生子单可删）
        await page.evaluate((id) => siOpenDrawer(id), childB);
        await page.waitForTimeout(600);
        await page.evaluate(() => { siDeleteIssue(); });
        await page.waitForSelector('#siModalOverlay.open', { timeout: 5000 });
        const delTitle = await page.evaluate(() => document.getElementById('siMHead').textContent);
        must(delTitle === `删除任务 #${root}_2`, `[T5] ⭐ 删除任务弹窗标题应精确等于 "删除任务 #${root}_2"，实得 "${delTitle}"`);
        await page.evaluate(() => { siCloseModal(); siCloseDrawer(); });
        await page.waitForTimeout(200);

        // ═══ [T6] 翻页无重复遗漏：默认 pageSize=25，超大族（28 行）独占页 + 全量翻页核对 ══════════
        console.log('\n── [T6] 翻页无重复遗漏——超大族独占页 + 全量翻页收集 id 集合核对 ──');
        await page.reload();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(800);
        const collected = [];   // { title, page }
        let pageCount = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            pageCount++;
            const pageRows = await page.evaluate(() => [...document.querySelectorAll('#sysIterationListTable tbody tr td:nth-child(5)')].map((td) => td.textContent));
            for (const t of pageRows) collected.push({ title: t, page: pageCount });
            const nextBtn = await page.$('#sysIterationPagination [data-page-nav="next"]:not([disabled])');
            if (!nextBtn) break;
            await nextBtn.click();
            await page.waitForTimeout(300);
            if (pageCount > 50) throw new Error('[T6] 翻页超过 50 页仍未到底，疑似死循环，中止（防真实 bug 时脚本挂死）');
        }
        must(pageCount >= 2, `[T6] ⭐ 默认页大小(25) + 本次夹具（28 行大族+3 行小族+已有数据）应产出 ≥2 页，实得 ${pageCount} 页`);
        // 大族（root2 + 27 子单，共 28 行）任一成员出现的页码集合应只有 1 个值（独占页，未被拆到两页）。
        const bigFamilyTitlesSet = new Set([`SDN-大族根-${RUN_TAG}`, ...Array.from({ length: 27 }, (_, i) => `SDN-大族子${i + 1}-${RUN_TAG}`)]);
        const bigFamilyPages = new Set(collected.filter((c) => [...bigFamilyTitlesSet].some((t) => c.title.includes(t))).map((c) => c.page));
        must(bigFamilyPages.size === 1, `[T6] ⭐ 超大族 28 行应独占同一页（不被翻页边界拆开），实得跨 ${bigFamilyPages.size} 页：${JSON.stringify([...bigFamilyPages])}`);
        const bigFamilyFoundCount = collected.filter((c) => [...bigFamilyTitlesSet].some((t) => c.title.includes(t))).length;
        must(bigFamilyFoundCount === 28, `[T6] ⭐ 全量翻页应收集到大族全部 28 行（无遗漏），实得 ${bigFamilyFoundCount}`);
        // 无重复：collected 里大族任一行标题只应出现一次（跨全部页面）。
        const bigFamilyRows = collected.filter((c) => [...bigFamilyTitlesSet].some((t) => c.title.includes(t)));
        const dupCheck = new Map();
        for (const r of bigFamilyRows) dupCheck.set(r.title, (dupCheck.get(r.title) || 0) + 1);
        const dupTitles = [...dupCheck.entries()].filter(([, c]) => c > 1);
        must(dupTitles.length === 0, `[T6] ⭐ 大族各行在全量翻页结果中应恰出现 1 次（无重复渲染），实得重复项：${JSON.stringify(dupTitles)}`);
        // 小族（root/childA/childB）同样应整族出现在同一页（族不拆页，非仅超大族才适用）。
        const smallFamilyTitles = [`SDN-根单-${RUN_TAG}`, `SDN-子单A-${RUN_TAG}`, `SDN-子单B-${RUN_TAG}`];
        const smallFamilyPages = new Set(collected.filter((c) => smallFamilyTitles.some((t) => c.title.includes(t))).map((c) => c.page));
        must(smallFamilyPages.size === 1, `[T6] 小族（3 行）也应独占同一页，实得跨 ${smallFamilyPages.size} 页`);

        // ═══ [T7] 全程无 console error ═══════════════════════════════════════════════════════════
        const t7Errs = page._consoleErrors || [];
        must(t7Errs.length === 0, `[T7] 全程无 console error，实得：${JSON.stringify(t7Errs.slice(0, 5))}`);

    } catch (e) {
        failed++;
        fatalError = e;
        console.error('\n[异常] 套件中途抛出未捕获异常（完整堆栈，非仅 message）：\n', e && (e.stack || e));
    } finally {
        const cleanupErrs = [];
        if (browser) {
            try { await browser.close(); } catch (e) { cleanupErrs.push({ step: 'browser.close', message: e && e.message }); }
        }
        const safeDelete = async (sql, params, step) => {
            try { await run(sql, params); } catch (e) { cleanupErrs.push({ step, message: e && e.message }); }
        };
        for (const id of createdIssueIds) {
            await safeDelete('DELETE FROM sys_issue_dev_events WHERE issue_id = ?', [id], `dev_events#${id}`);
            await safeDelete('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id], `dev_commits#${id}`);
            await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id], `dev_assignees#${id}`);
            await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id], `timeline#${id}`);
            await safeDelete('DELETE FROM sys_issues WHERE id = ?', [id], `issues#${id}`);
        }
        const left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE ?`, [`SDN-%-${RUN_TAG}`]);
        console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0，共造 ${createdIssueIds.length} 条）`);
        must(cleanupErrs.length === 0, `夹具清理 SQL 全部无错误，实得 errs=${JSON.stringify(cleanupErrs)}`);
        must(!!left && left.c === 0, `夹具清理后 sys_issues 残留应为 0，实得 ${left ? left.c : '(查询失败)'}`);
        db.close();
        console.log(`\n  合计 ${passed} PASS / ${failed} FAIL${fatalError ? '  ⚠️ FATAL：套件中途抛出未捕获异常，见上方完整堆栈（此次结果不可信赖为"仅这些用例失败"）' : ''}`);
        process.exit(failed === 0 && !fatalError ? 0 : 1);
    }
})().catch(e => {
    console.error('[顶层兜底] finally 段或未捕获 rejection：\n', e && (e.stack || e));
    process.exit(1);
});
