/**
 * test-sys-derive-numbering-playwright.js — 系统迭代·派生单子编号「#根_序」真实 DOM 断言
 *   （S13-c·C3，方案 20260813_v1.8 §15.3/§15.4·矩阵仅真实浏览器渲染能证明的面）
 *
 * 循 test-sys-detail-ux-playwright.js 套件范式（JWT 注入 + login.html 中继跳转 + 直接 SQL 造夹具 +
 * must() 断言计数 + finally 段清理 + 非零退出码）。
 * [#106 S4d-3] 被测服务 / 库 / 令牌密钥改由 scripts/lib/test-env.js 提供（自起临时隔离实例，或 TEST_* 变量组指向已起好的隔离实例）；
 *   不再依赖外部 server:3000 与真实 task_pool.db / .env；前置的令牌探针改为「合法 token 必过 + 篡改签名段必拒」（见下方探针函数注释）。
 *   造数标题 SDN-*-<时间戳>，唯一；清理每个 id 各自 try、2 轮、遗留计失败。
 *
 * 用法：node scripts/test-sys-derive-numbering-playwright.js
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
const sqlite3 = require('sqlite3');
const { chromium } = require('playwright');
const testEnv = require('./lib/test-env');

let BASE_URL = null;   // [#106 S4d-3] ready() 之后赋值：testEnv.env().baseUrl
let DB_PATH = null;    // [#106 S4d-3] ready() 之后赋值：testEnv.env().dbPath（实例库）

// [#106 S4d-3] 打开实例库：只读写已存在的实例库（OPEN_READWRITE，不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库），带打开回调转 Promise。
//   与 _test-fixture.js 的 openInstanceDb 同源，S4c 提交后可改用夹具导出
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const d = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(d)));
    });
}
// 模块顶层不再 new Database(业务库)：改为 ready() 之后打开，收尾等 close 回调
let db = null;
const closeDb = () => new Promise((res, rej) => { if (!db) return res(); const d = db; db = null; d.close((e) => (e ? rej(e) : res())); });
const run =(sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

// [#106 S4d-3] 令牌探针改写：被测服务的密钥来自隔离实例（test-env），脚本不再自己拿 JWT_SECRET，也就不存在「server 与脚本最终生效密钥不一致」要探活的问题
//   （原来的候选密钥探活 + 用另一把密钥签 token 的反向探针整段删除）。保留「探针双向证明」纪律，改成：
//   ① 正向探针：用 testEnv.signToken(合法 admin 行) 签的 token 打 /api/auth/me，必须 200（令牌 + 账号 + 服务三者都对得上）；
//   ② 反向探针：取这枚**合法** token，只篡改签名段（第三段）的首字符（整段签名的 6 个比特全变，不是只改填充位），其余两段原样，必须被拒（非 200）——
//      证明 /api/auth/me 真的在验签，而不是任何形态的 token 都放行，让 ① 的 200 有「确实是验过签」的证明力（不再用另一把密钥签）。
//   探针 token 签的是**真实**查出来的 admin 行（adminRow.id 来自 `SELECT ... FROM users WHERE role='admin' AND status='active'`），避免把账号问题误诊成签名问题。
async function probeValidTokenAccepted(adminRow) {
    const tok = await testEnv.signToken(adminRow.id);
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${tok}` } });
    if (!res.ok) throw new Error(`合法 token 打 /api/auth/me 得到 HTTP ${res.status}——隔离实例是否在跑？admin 账号（id=${adminRow.id}）在实例库里是否 active？`);
    return tok;
}
async function probeTamperedSignatureRejected(validToken) {
    const parts = String(validToken).split('.');
    if (parts.length !== 3 || !parts[2]) throw new Error('合法 token 不是 header.payload.signature 三段形态，无法构造篡改探针');
    const sig = parts[2];
    const tamperedSig = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);   // 首字符换成另一个 base64url 字符：签名字节必变，其余两段原样
    const tampered = `${parts[0]}.${parts[1]}.${tamperedSig}`;
    const res = await fetch(`${BASE_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${tampered}` } });
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

let RUN_TAG = null;   // [#106 S4d-3] ready() 之后赋值（顶层 Date.now() 会被守卫 R6 判红）
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
    await testEnv.ready();   // 入口第一条有副作用的语句：自起隔离实例（或核对 TEST_* 变量组）
    BASE_URL = testEnv.env().baseUrl;
    DB_PATH = testEnv.env().dbPath;
    RUN_TAG = Date.now();
    let browser;
    try {
        db = await openInstanceDb(DB_PATH);
        const admin = await get(`SELECT id, username, display_name, role FROM users WHERE role = 'admin' AND status = 'active' ORDER BY id LIMIT 1`);
        if (!admin) throw new Error('库中无 active admin 用户，无法造 token');
        // [#106 S4d-3] 正向探针：testEnv.signToken 签的合法 token 必须被 /api/auth/me 接受（原：对候选 .env 密钥探活）
        const adminTok = await probeValidTokenAccepted(admin);
        // [S13 收口 MED 追-2②] 反向探针：取这枚合法 token 篡改签名段，必须被拒（非 200），证明 /api/auth/me 真的在验签
        // ——不是随便什么 token 都放行，让上面正向探针的 200 有「确实验过签」的证明力。（[#106 S4d-3] 原：另一把密钥签的 token）
        const tamperedStatus = await probeTamperedSignatureRejected(adminTok);
        must(tamperedStatus !== 200, `[前置] 篡改了签名段的合法 token 应被 /api/auth/me 拒绝（非 200），实得 HTTP ${tamperedStatus}——若这里是 200，说明该端点没有真的在验签，上面正向探针的 200 无法确认是"验过签"还是"什么 token 都放行"`);

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
        // [#106 S4d-3] 浏览器关闭失败计失败且不跳过清理；5 条 DELETE 每个 id 各自 try，有失败 / 残留则整体再试一轮（共 2 轮，间隔 200ms）；回查失败也计失败
        let cleanupErrs = [];
        if (browser) {
            try { await browser.close(); } catch (e) { cleanupErrs.push({ step: 'browser.close', message: e && e.message }); }
        }
        const safeDelete = async (sql, params, step) => {
            try { await run(sql, params); } catch (e) { cleanupErrs.push({ step, message: e && e.message }); }
        };
        let left = null;
        if (db) {
            const browserErrs = cleanupErrs.filter((x) => x.step === 'browser.close');   // 浏览器关闭失败不因重试清空而丢
            for (let round = 0; round < 2; round++) {
                if (round > 0) await new Promise((r) => setTimeout(r, 200));
                cleanupErrs = browserErrs.slice();
                for (const id of createdIssueIds) {
                    await safeDelete('DELETE FROM sys_issue_dev_events WHERE issue_id = ?', [id], `dev_events#${id}`);
                    await safeDelete('DELETE FROM sys_issue_dev_commits WHERE issue_id = ?', [id], `dev_commits#${id}`);
                    await safeDelete('DELETE FROM sys_issue_dev_assignees WHERE issue_id = ?', [id], `dev_assignees#${id}`);
                    await safeDelete('DELETE FROM sys_issue_timeline WHERE issue_id = ?', [id], `timeline#${id}`);
                    await safeDelete('DELETE FROM sys_issues WHERE id = ?', [id], `issues#${id}`);
                }
                try { left = await get(`SELECT COUNT(*) AS c FROM sys_issues WHERE title LIKE ?`, [`SDN-%-${RUN_TAG}`]); } catch (e) { cleanupErrs.push({ step: 'left-count', message: e && e.message }); left = null; }
                if (cleanupErrs.length === browserErrs.length && left && left.c === 0) break;
            }
        } else if (createdIssueIds.length > 0) {
            cleanupErrs.push({ step: 'db-not-open', message: '实例库未打开，夹具无法清理' });
        }
        console.log(`\n  🧹 夹具已清理（残留 issue ${left ? left.c : '?'} 条，应为 0，共造 ${createdIssueIds.length} 条）`);
        must(cleanupErrs.length === 0, `夹具清理 SQL 全部无错误，实得 errs=${JSON.stringify(cleanupErrs)}`);
        must(!!left && left.c === 0, `夹具清理后 sys_issues 残留应为 0，实得 ${left ? left.c : '(查询失败)'}`);
        try { await closeDb(); } catch (e) { must(false, `关闭实例库失败：${e && e.message}`); }
    }
    try { await testEnv.teardown(); } catch (e) { must(false, `teardown（收掉自起实例）：${e && e.message}`); }
    console.log(`\n  合计 ${passed} PASS / ${failed} FAIL${fatalError ? '  ⚠️ FATAL：套件中途抛出未捕获异常，见上方完整堆栈（此次结果不可信赖为"仅这些用例失败"）' : ''}`);
    testEnv.finish(failed === 0 && !fatalError ? 0 : 1);   // 收尾：teardown 之后设退出码 + unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('[顶层兜底] finally 段或未捕获 rejection：\n', e && (e.stack || e));
    try { await closeDb(); } catch (_) { /* 已在报错路径 */ }
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
