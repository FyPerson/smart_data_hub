/**
 * 上线执行人多选+多人双确认 C6 收口·Playwright 冒烟——整体重写（309 号预筛 LOW-3 判定："本文件夹具
 * 全靠直接 SQL 写批次级旧列 release_assignee_* 模拟状态，那批列已随 C4b 冻结退场，继续这样造态代表性
 * 归零"）。
 *
 * 【文件名历史沿革】文件名 `test-sys-release-panel-c2b2-playwright.js` 沿用旧名不改——本次是内容整体
 * 重写非新建文件，改名会让 git blame/历史 codex 审查记录（引用本文件名的归档条目）连带失效；文件名里
 * 的 "c2b2" 字样是 2026-07 上线体统一重构 C2b 阶段命名残留，与当前 C5/C6 覆盖内容不再对应，仅作历史
 * 标识保留，不代表当前范围。
 *
 * 【旧版用例接管清单】（MED-3③ 由散文改 file:line 明细表，旧版指本次改写前的版本，行号为改写前坐标）：
 *
 * | 旧用例 | 旧文件位置 | 处置 | 新落点 |
 * |---|---|---|---|
 * | T1 安排上线按钮可见性 + 改期全链路（浏览器点击） | :193-258 | 登记接受：改期本身通过 `setPlannedDate()` 直调 API 覆盖（夹具用途），UI 点击链路不再单独测——`update-planned-date` 端点行为由 `verify-sys-release.js` 覆盖 | 无独立浏览器版 |
 * | T1 撤销上线安排全链路（liaison 真实点击） | :261-279 | 登记接受：`cancel-schedule` 端点全链路由 `verify-sys-release-executors.js`/`verify-sys-executor-remove.js` API 级覆盖 | 无独立浏览器版 |
 * | T1 旧「发布批次（旧流程）」按钮已删断言 | :208 | 不再需要：断言的是一次性历史事实（旧按钮已删），非持续回归风险点 | 已省略 |
 * | T2 执行上线按钮权限显隐 + 全链路执行 | :284-339 | 接管：新执行链路（多人/最后一人）覆盖同等权限显隐语义 | G3 |
 * | T2 release_published timeline 折叠渲染 | :424-453 | **补回**（MED-3①，无等价后端 verify，纯前端渲染逻辑） | G3 尾段 |
 * | T3 「应急上线」独立按钮 + 弹窗新文案 | :344-382 | 接管：按钮存在性由新 hotfix 流程覆盖；弹窗文案细节断言不再单独测（文案本身非本次改造对象） | G2 |
 * | T3 bug 旧「执行上线」死按钮已移除 / 「指定上线开发」按钮已隐藏 | :368-378 | 不再需要：断言的是一次性历史退场事实（C3/C9 时代），与本次 C5/C6 改造对象无关，无持续回归风险 | 已省略 |
 * | T3b 「前往上线单」按钮权限镜像 | :389-421 | **补回**（MED-3①，codex 206-MED-2 闭合件，纯前端权限镜像渲染，无等价后端 verify） | G5（子表流夹具重建，覆盖面按 2026-07-31「执行人入口批」新权限集扩展） |
 * | 排班维护：区间批量设置全链路（UI 点击+confirm 对话框+表格断言） | :458-511 | **登记接受**（MED-3②）：写路径本身（`POST /sys-duty-roster`/`-batch`）由 `verify-sys-duty-roster.js` 完整覆盖；本文件 G1 仍通过真实 API 调用该端点做只读预览式验证（供选人默认值夹具用），只是不再单独测批量设置的 UI 交互（表格合并展示/区间输入/浏览器原生 confirm 对话框） | 无独立浏览器版（G1 API 级覆盖） |
 *
 * 新覆盖（C6 指令四点 + G5/timeline 补回）：
 *   ① 选人弹窗打开 + 默认值预勾（排班来源）+ 置灰项展示（admin/viewer 两类不合格候选）+ 人数闸置灰
 *      + 失效默认配置人数判定（309 场景②：固定默认执行人配置里混入不合格 id，跳过后正确预勾计数）
 *   ② 多人列表渲染：徽标/按钮矩阵（not_sent→sent 转换 + 重新通知/查询已读 real click）
 *   ③ 最后一人确认文案（"确认后还差 N 人" vs "你是最后一个确认人"）+ 上线说明必填框（客户端拦截空提交）
 *   ④ 309 四场景：
 *      - hotfix 候选加载失败保留输入（page.route 注入 500，断言弹窗不关、已填内容原样保留）
 *      - 失效默认配置人数判定（同①，合并测）
 *      - done 行按钮矩阵（done 行无「发通知/重新通知/重试」也无「查询已读」，对照未 done 行仍有）
 *      - RELEASE_NOTE_REQUIRED 补弹重试（真实构造前端"我不是最后一人"陈旧快照 + 事务外用 API 抢先让另
 *        两人确认，制造后端判定"你其实是最后一人"的判序差——不是猜时序的真竞态，是确定性事件排序）
 *   ⑤（MED-3① 补回）release_published timeline 折叠渲染 + 「前往上线单」按钮权限镜像（G5，覆盖面已
 *      随 2026-07-31「执行人入口批」扩展到子表在册执行人）
 * *   ⑥（312-L1·codex 合并前建议·G6 补回）单人批次里唯一执行人确认时同样弹出「最后一人」文案 +
 *      上线说明必填框（决策 7 三修后单人=天然最后一人这条渲染路径的浏览器级验证，低成本追加，
 *      与 G3 的多人版验证互补·非重复）
 *
 * 用法：本地 server（3000）已重启到最新分支代码后：node scripts/test-sys-release-panel-c2b2-playwright.js
 * JWT 注入范式复用项目既有先例（goto login.html → localStorage token → goto 业务页）——鉴权页直接 goto
 * 业务页会被 checkAuth 销毁 context。
 *
 * ⚠️ LOW-6（C6 预筛回卷）并发边界：本文件与项目里其它任何会写 task_pool.db 的 Playwright 套件
 * （如 test-sys-release-c7-playwright.js / test-sys-intake-liaison-playwright.js 等）**禁止同时对同一个
 * 本地 db 并发运行**——多个套件各自建各自的测试夹具、各自在 finally 里清理，交叉运行时一个套件的
 * DELETE 可能命中另一个套件正在使用的行 id（尤其 sys_issue_timeline 等无强隔离的表），产生互相踩踏的
 * 假失败或数据错乱。一次只跑一个写 db 的 Playwright 套件。
 *
 * ⚠️ 钉钉安全边界（实测确认，写进完成报告）：
 *   - 行级通知端点（POST /sys-releases/:id/executors/:userId/notify）与批次级前身不同，本身受
 *     system_configs.sys_notify_dry_run 开关闸——本次实测前**已读取确认该开关当前值='on'**（未被本脚本
 *     改动，恒不动清单含设置该开关的脚本，本文件只读不写）：dry_run=true 时完整走 CAS+留痕，唯独跳过
 *     真实 sendIssueDingtalkRaw 外呼（见 index.js :10061-10063）。故本文件对「📣 发通知」「查询已读」两个
 *     按钮做**真实点击**（旧文件对等价场景需要绕开真实外呼、改用直接 SQL 模拟"已通知"态，本文件不需要
 *     这层绕行——这正是重写想要的"更高代表性"）。
 *   - execute / cancel-schedule / update-planned-date / PUT executors / hotfix-publish 建单阶段均已读
 *     代码确认零外呼（execute 发布后 dispatchSysNotify 走 isAutoNotifyEnabled() 硬编码 return false 早
 *     返回；其余端点代码里根本没有外呼调用）——本文件对这些端点同样做真实点击全链路验证，安全。
 *   - 查已读端点对 dry-run 产生的 message_key（'dryrun-' 前缀）在读钉钉配置/外呼之前短路返回
 *     read_status:'dry_run'（index.js :10404），点击查询同样不触发真实外呼。
 */
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_key_change_me';
// LOW-6（C6 预筛回卷）：原硬编码路径含某一次会话的 scratchpad UUID——那是本次编写脚本时所在的临时会话
// 目录，换一个新会话/新机器跑本文件，这个目录大概率不存在，会让失败截图静默丢失（screenshot 调用本身
// 包在 try/catch 里吞掉了）。改用 os.tmpdir() 在运行时现算一个与仓库无关的固定子目录，目录不存在就建。
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'sys-release-panel-c2b2-playwright-screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
// server.js:2696 逐字复刻——system_configs 值一律走这套 AES-256-CBC 加密约定，本文件仅用它写测试专用的
// sys_release_default_executor_ids 键（写前已查证该键当前无行，不覆盖任何真实配置；不触碰 sys_notify_dry_run）。
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || 'change_me_with_random_32bytes_!!';

const ADMIN_ID = 1;       // 管理员
const LIAISON_ID = 13;    // 示例对接人（对接人白名单，排班写权限用）
const EXEC_A_ID = 8;      // 示例开发A（active·role=user，有上线执行资格）
const EXEC_B_ID = 9;      // 示例开发B（active·role=user，有上线执行资格）
const EXEC_C_ID = 12;     // 示例开发D（active·role=user，有上线执行资格）
const VIEWER_ID = 2;      // 示例客服A（active·role=viewer，无上线执行资格，供置灰断言用）

const db = new sqlite3.Database(DB_PATH);
const dbGet = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const dbRun = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this); }));
const dbAll = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

function encryptConfigValue(value) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(value, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

async function signAs(userId) {
    const user = await dbGet('SELECT id, username, display_name, role FROM users WHERE id=?', [userId]);
    if (!user) throw new Error(`user id=${userId} not found`);
    return jwt.sign({ id: user.id, username: user.username, display_name: user.display_name, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
}
// 直接 fetch 调用（供夹具搭建 + 「事务外抢先」制造判序差用，不经浏览器）。
async function api(token, method, p, body) {
    const r = await fetch(`${BASE_URL}${p}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = null; try { j = await r.json(); } catch (_) { /* 无 body */ }
    return { status: r.status, body: j };
}

let pass = 0, fail = 0;
const failShots = [];
function must(cond, msg) { if (cond) { console.log('  ✅ ' + msg); pass++; } else { console.log('  ❌ ' + msg); fail++; } return cond; }
async function shotOnFail(page, cond, name, msg) {
    if (!must(cond, msg)) {
        const p = path.join(SCREENSHOT_DIR, `c6-relexec-fail-${name}.png`);
        try { await page.screenshot({ path: p }); failShots.push(p); console.log(`     📸 失败截图: ${p}`); } catch (_) { /* 截图本身失败不影响主流程 */ }
    }
}

async function loginPage(browser, token) {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text() + (m.location() && m.location().url ? ' @' + m.location().url : '')); });
    page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));
    page.on('dialog', d => d.accept());   // confirm() 自动接受（「发通知」按钮走 confirm() 二次确认）
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => { localStorage.setItem('token', t); }, token);
    page._consoleErrors = consoleErrors;
    return page;
}
// 既有噪音（与本次改造无关）：DOMContentLoaded 对任意登录用户无条件调用 siLoadIntakeLiaisons()
// （admin-only 端点），非 admin 必 403——见既有 playwright 套件同款处理先例。
function unexpectedConsoleErrors(errs) {
    return (errs || []).filter(e => !(/\/api\/sys-issues\/intake-liaisons/.test(e) && (/403/.test(e) || /Failed to load resource/i.test(e))));
}
// 供 G2/G4 两处「本测试自己故意注入的失败」调用后使用——把该次故意失败产生的浏览器 console error
// 从记录里摘掉，不让它污染该页面后续的「全程无意外 JS 报错」断言（这不是要掩盖真实报错：两处都已在
// 紧邻位置对该失败本身做过精确断言——G2 断言 toast 文案+弹窗未关+输入保留，G4 断言补弹重试弹窗正确
// 弹出——这里摘掉的只是"该失败在浏览器网络层也会打一行 Failed to load resource"这个必然伴生的噪音，
// 与故意场景外的任何其它报错互不影响）。
// HIGH-1（C6 预筛回卷）：原实现 `page._consoleErrors = arr.filter(...)` 会重新赋一个新数组给
// `page._consoleErrors`，但 loginPage() 里 `page.on('console', ...)` 监听器闭包捕获的是**原数组**
// （`consoleErrors` 局部变量），赋值只改了 `page._consoleErrors` 这个引用指向谁，监听器后续 push 仍
// 落在旧数组上——等于本次调用之后，这条页面上再出现任何真实报错都不会被后面的「全程无意外 JS 报错」
// 断言看见（该断言读的是新数组，永远不会再被监听器写入），断言从此对后续真实报错完全失明。改用原地
// mutate（length 清零后原样式 push 回保留项）维持同一数组对象，监听器与 `page._consoleErrors` 全程
// 指向同一个引用。
function dismissExpectedNoise(page, urlPattern, statusPattern) {
    const arr = page._consoleErrors || [];
    const kept = arr.filter(e => !(urlPattern.test(e) && statusPattern.test(e)));
    arr.length = 0;
    arr.push(...kept);
}
async function gotoRelease(page, releaseId) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html?release=${releaseId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
}
async function gotoIssue(page, issueId) {
    await page.goto(`${BASE_URL}/Sys_Iteration.html?issue=${issueId}`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);
}
async function lastToastText(page) {
    return page.evaluate(() => {
        const nodes = document.querySelectorAll('#toast-container > div');
        return nodes.length ? nodes[nodes.length - 1].textContent.trim() : '';
    });
}
// LOW-6（C6 预筛回卷）：项目既有 gotchas 范式（playwright_suite_gotchas.md 第4条）——本套件契约=
// 外部已启动的 dev server:3000，脚本自己不拉起服务；跑前用端口 Listen 探测代替"直接 goto 然后让
// Playwright 自己超时"，前者给出的错误信息精确（"server 未起"），后者会含糊地卡在某个具体断言上，
// 定位耗时更久。
function ensureServerListening(port = 3000, host = '127.0.0.1', timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        const sock = net.createConnection({ port, host });
        const timer = setTimeout(() => { sock.destroy(); reject(new Error(`端口 ${port} 探测超时（${timeoutMs}ms）——server 未就绪或响应异常`)); }, timeoutMs);
        sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(); });
        sock.once('error', (e) => { clearTimeout(timer); reject(new Error(`端口 ${port} 未监听（${e.message}）——请先启动 node server.js 再跑本文件`)); });
    });
}

async function main() {
    await ensureServerListening();
    console.log('  ✅ 端口 3000 Listen 探测通过（server 已就绪）');
    const adminTok = await signAs(ADMIN_ID);
    const liaisonTok = await signAs(LIAISON_ID);
    const execATok = await signAs(EXEC_A_ID);
    const execBTok = await signAs(EXEC_B_ID);
    const execCTok = await signAs(EXEC_C_ID);
    console.log('\n══════ 上线执行人多选+多人双确认 C6 收口 Playwright 冒烟 ══════');
    console.log(`  actors: admin=${ADMIN_ID} / liaison=${LIAISON_ID}(示例对接人) / execA=${EXEC_A_ID}(示例开发A) / execB=${EXEC_B_ID}(示例开发B) / execC=${EXEC_C_ID}(示例开发D)`);

    // ── 恒不动纪律核验（不写，只读）：sys_notify_dry_run 当前须为 'on'，否则本文件对「发通知/查询已读」
    //   的真实点击会造成真实外呼——发现非 'on' 立即中止，不静默继续。──
    {
        const row = await dbGet(`SELECT config_value_encrypted FROM system_configs WHERE config_key='sys_notify_dry_run'`);
        let val = null;
        if (row && row.config_value_encrypted) {
            try {
                const [ivHex, dataHex] = String(row.config_value_encrypted).split(':');
                const iv = Buffer.from(ivHex, 'hex');
                const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
                val = decipher.update(dataHex, 'hex', 'utf8') + decipher.final('utf8');
            } catch (_) { val = '(解密失败)'; }
        }
        if (val !== 'on') {
            console.error(`\n🚫 安全中止：system_configs.sys_notify_dry_run 当前值="${val}"（非 'on'）——继续跑会对「发通知/查询已读」按钮做真实外呼，脚本拒绝继续。`);
            db.close();
            process.exit(1);
        }
        console.log('  ✅ 前置安全核验：sys_notify_dry_run="on"（本文件全程只读该配置，未做任何写入）');
    }

    // ── 夹具 helper ──
    const createdIssueIds = [];
    const createdReleaseIds = [];
    const dutyDates = [];
    // MED-2（C6 预筛回卷）：只有本脚本自己真正写入过排班/配置行，收尾才允许删——防止「本地 db 已经
    // 被真实部署写过 sys_release_default_executor_ids 真配置（如生产要求人工写入的 23=示例开发L）之后，
    // 再在本地跑本测试，因为前置核验软告警但不中止，最终收尾把真配置也删掉」这类事故。
    let insertedDuty = false, insertedConfig = false;
    const mkIssue = async (type, title) => {
        const r = await api(adminTok, 'POST', '/api/sys-issues', {
            type, title, system_name: '智数协同', source: '内部', intake_contract_version: 2,
            description: title, intake_liaison_id: 13,
        });
        if (r.status !== 201) throw new Error(`建单失败: ${JSON.stringify(r.body)}`);
        const id = r.body.id;
        await dbRun(`UPDATE sys_issues SET status='待上线' WHERE id=?`, [id]);
        createdIssueIds.push(id);
        return id;
    };
    // RELEASE 中心守卫（_publishReleaseCoreInTxn）要求批次内每个成员单自己的开发在册名单非空且全员非
    // pending——真实走到发布的用例需要先给成员单补一条完成态 dev_assignee 行（同 verify-sys-release-executors.js
    // 既有 mkCompleteRoster 范式，逐字复刻，已在本任务 [10] 组实测验证过可用）。
    const mkCompleteRoster = async (issueId, userId = 5, userName = '开发甲') => {
        await dbRun(
            `INSERT INTO sys_issue_dev_assignees (issue_id, user_id, user_name, is_primary, dev_status, resolved_at)
             VALUES (?, ?, ?, 1, 'no_code', datetime('now'))`,
            [issueId, userId, userName]
        );
    };
    const mkBatch = async (title) => {
        const r = await api(adminTok, 'POST', '/api/sys-releases', { title });
        if (r.status !== 201) throw new Error(`建批次失败: ${JSON.stringify(r.body)}`);
        createdReleaseIds.push(r.body.id);
        return r.body.id;
    };
    const addIssueTo = async (relId, issueId) => {
        const r = await api(adminTok, 'POST', `/api/sys-releases/${relId}/add-issues`, { issue_ids: [issueId] });
        if (r.status !== 200) throw new Error(`加单失败: ${JSON.stringify(r.body)}`);
    };
    const setPlannedDate = async (relId, date) => {
        const r = await api(adminTok, 'POST', `/api/sys-releases/${relId}/update-planned-date`, { planned_date: date });
        if (r.status !== 200) throw new Error(`改期失败: ${JSON.stringify(r.body)}`);
    };
    const putExecutors = async (relId, userIds) => {
        const r = await api(adminTok, 'PUT', `/api/sys-releases/${relId}/executors`, { user_ids: userIds });
        if (r.status !== 200) throw new Error(`PUT executors 失败: ${JSON.stringify(r.body)}`);
        return r.body.executors;
    };
    const notifyRow = async (relId, userId) => {
        const r = await api(adminTok, 'POST', `/api/sys-releases/${relId}/executors/${userId}/notify`);
        if (r.status !== 200) throw new Error(`行级通知失败(user=${userId}): ${JSON.stringify(r.body)}`);
        return r.body;
    };
    const executeRow = async (relId, token, executorRowId, extra = {}) => {
        return api(token, 'POST', `/api/sys-releases/${relId}/execute`, { executor_row_id: executorRowId, ...extra });
    };

    const browser = await chromium.launch();
    const openPages = [];
    const newPage = async (tok) => { const p = await loginPage(browser, tok); openPages.push(p); return p; };

    try {
        // ═══════════════════════════════════════════════════════════════
        // G1：选人弹窗打开 + 默认值预勾（排班来源）+ 置灰项展示 + 人数闸置灰 + 失效默认配置人数判定（309②）
        // ═══════════════════════════════════════════════════════════════
        let batchG1, issueG1;
        {
            console.log('\n── G1：选人弹窗（默认值预勾/置灰项/人数闸/失效配置判定） ──');
            issueG1 = await mkIssue('feature', 'C6-PW-G1选人弹窗');
            await mkCompleteRoster(issueG1);
            batchG1 = await mkBatch('C6-PW-G1选人弹窗批次');
            await addIssueTo(batchG1, issueG1);
            await setPlannedDate(batchG1, '2032-04-07');   // 固定未来日期，避免与真实排班/其余测试日期碰撞

            // 排班默认值来源①：2032-04-07 排班给示例开发A（合法候选，应被预勾）。
            // MED-2（C6 预筛回卷）：软告警（must()记一次失败继续跑）改硬中止——若这个固定测试日期真的
            // 已有在册排班（比如未来这一天恰好被真实业务用到），继续跑会让 POST /sys-duty-roster 的
            // 后端 softDelete-and-replace 逻辑覆盖掉真实数据，且收尾清理会把它永久删除、无法恢复。
            const dutyExisting = await dbGet(`SELECT id, user_name FROM sys_release_duty_roster WHERE duty_date='2032-04-07' AND removed_at IS NULL`);
            if (dutyExisting) {
                throw new Error(`G1 前置核验失败：2032-04-07 已存在在册排班（id=${dutyExisting.id}，user_name=${dutyExisting.user_name}）——测试固定日期与真实数据碰撞，拒绝继续（继续会覆盖并可能永久丢失这条真实排班）`);
            }
            console.log('  ✅ G1 前置核验：2032-04-07 当前无在册排班（测试用固定未来日期未与既有数据碰撞）'); pass++;
            const dutyR = await api(liaisonTok, 'POST', '/api/sys-duty-roster', { duty_date: '2032-04-07', user_id: EXEC_A_ID });
            if (dutyR.status !== 201) throw new Error(`G1 夹具：排班写入失败（实得 ${dutyR.status} ${JSON.stringify(dutyR.body)}）`);
            console.log(`  ✅ G1 夹具：排班 2032-04-07→示例开发A 写入成功（实得 ${dutyR.status} id=${dutyR.body.id}）`); pass++;
            dutyDates.push('2032-04-07');
            insertedDuty = true;

            // 默认值来源②：固定默认执行人配置混入两个不合格 id（309②失效默认配置人数判定核心夹具）——
            // "1"=管理员（角色不合格）、"999999"=不存在的用户，两者都应被跳过且不计入预勾数。
            // MED-2 同款硬中止：若该配置键已存在真实值（如部署要求人工写入的 23=示例开发L固定默认执行人），
            // 继续跑会用测试值覆盖它，收尾还会把它删掉——必须在写之前就拒绝，而不是"警告一下继续跑"。
            const configExisting = await dbGet(`SELECT config_key FROM system_configs WHERE config_key='sys_release_default_executor_ids'`);
            if (configExisting) {
                throw new Error(`G1 前置核验失败：system_configs.sys_release_default_executor_ids 已存在真实配置行——拒绝覆盖/拒绝继续（继续会用测试值覆盖真配置，且收尾会把它删除）`);
            }
            console.log('  ✅ G1 前置核验：sys_release_default_executor_ids 当前无行（写入不会覆盖任何真实配置）'); pass++;
            await dbRun(
                `INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name, updated_at)
                 VALUES ('sys_release_default_executor_ids', ?, NULL, 'test-sys-release-panel-c2b2-playwright.js', datetime('now','localtime'))`,
                [encryptConfigValue('1,999999')]
            );
            insertedConfig = true;

            const page = await newPage(adminTok);
            await gotoRelease(page, batchG1);
            await shotOnFail(page, (await page.locator('#siBatchFoot button:has-text("📣 安排上线")').count()) > 0, 'g1-notify-btn-visible', 'G1「📣 安排上线」按钮可见（execSummary=none·issues 非空）');
            await page.click('#siBatchFoot button:has-text("📣 安排上线")');
            await page.waitForTimeout(500);

            const modalHead = (await page.textContent('#siMHead') || '').trim();
            await shotOnFail(page, modalHead === '选择上线执行人', 'g1-modal-title', `G1 选人弹窗标题正确（实得："${modalHead}"）`);

            const modalBody = (await page.textContent('#siMBody') || '');
            // LOW-2（C6 预筛回卷）：断言从裸子串"管理员角色无上线执行资格"改为带 `固定默认执行人「管理员」`
            // 完整前缀的那句——裸子串同时也会被"管理员"候选行自己的 disabled_reason（无该前缀，任何情况下
            // 都会渲染，与本次配置无关）覆盖到，原断言即便 skipped_defaults 渲染逻辑整个失效也照样通过，
            // 没有真正验证到"失效配置 token①→skipped_defaults 提示"这条链路本身。
            await shotOnFail(page, modalBody.includes('用户 ID=999999 不存在'), 'g1-skip-nonexist', 'G1 弹窗提示含"用户 ID=999999 不存在"（失效配置 token②·309② 核心断言）');
            await shotOnFail(page, modalBody.includes('固定默认执行人「管理员」管理员角色无上线执行资格'), 'g1-skip-admin', 'G1 弹窗提示含完整前缀"固定默认执行人「管理员」管理员角色无上线执行资格"（失效配置 token①，与候选行自身 disabled_reason 裸文本可辨）');

            // 置灰项展示：admin(1) 与 viewer(2) 两类不合格候选行应 disabled + 各自理由。
            const adminRow = page.locator('.si-exec-pick-row:has-text("管理员")');
            await shotOnFail(page, (await adminRow.locator('input[type=checkbox]').isDisabled()), 'g1-admin-disabled', 'G1 候选清单「管理员」行 checkbox 已 disabled（admin 角色无上线执行资格）');
            const viewerRow = page.locator('.si-exec-pick-row:has-text("示例客服A")');
            await shotOnFail(page, (await viewerRow.locator('input[type=checkbox]').isDisabled()), 'g1-viewer-disabled', 'G1 候选清单「示例客服A」行 checkbox 已 disabled（viewer 角色无上线执行资格）');
            const viewerText = (await viewerRow.textContent()) || '';
            await shotOnFail(page, viewerText.includes('查看者角色无上线执行资格'), 'g1-viewer-reason', 'G1「示例客服A」行展示准确的置灰理由（查看者角色无上线执行资格）');

            // 默认值预勾 + 失效配置人数判定：尽管配置写了 2 个 id，两个都不合格被跳过，实际预勾数=1（仅排班来源的示例开发A）。
            const checkedCount1 = await page.locator('.si-exec-pick-chk:checked').count();
            await shotOnFail(page, checkedCount1 === 1, 'g1-default-checked-count', `G1 默认预勾数=1（仅排班来源示例开发A；固定配置 2 个 id 均不合格已跳过，未虚增预勾数），实得 ${checkedCount1}`);
            const liuRow = page.locator('.si-exec-pick-row:has-text("示例开发A")');
            await shotOnFail(page, (await liuRow.locator('input[type=checkbox]').isChecked()), 'g1-liu-checked', 'G1「示例开发A」行确为被预勾的那一个（排班来源）');

            // 人数闸段（反转·用户拍板决策 7 第三次修正，方案 v1.7 二订：下限 2→1）：原断言"预勾 1 人<2 应
            // disabled，补选到 2 人才 enabled"钉的是三修前的旧下限，随之过时（红灯诊断=断言过时非实现
            // 错，[[feedback_test_assertion_self_error]]）。反转为"0 人 disabled → 1 人 enabled"：
            // ① 默认预勾的 1 人（示例开发A）本身已满足新下限——此刻确认按钮应已是 enabled，非 disabled。
            const hint1 = (await page.textContent('#siExecPickHint') || '').trim();
            await shotOnFail(page, hint1 === '已选 1 人', 'g1-hint-1-person-enabled', `G1 默认预勾 1 人时人数提示精确等于「已选 1 人」（不带警告文案，实得："${hint1}"）`);
            await shotOnFail(page, !(await page.locator('#siMConfirm').isDisabled()), 'g1-confirm-enabled-at-1', 'G1 默认预勾 1 人（=新下限）时确认按钮已是 enabled（决策 7 三修：单人即可，无需再补选）');

            // ② 取消勾选降到 0 人——这才是三修后真正触发置灰的边界，用它来验证"置灰"这个 UI 行为本身仍然存在
            // （只是触发门槛从 1 变成了 0），不是"人数闸整个消失了"。
            await liuRow.locator('input[type=checkbox]').uncheck();
            await page.waitForTimeout(150);
            const hint0 = (await page.textContent('#siExecPickHint') || '').trim();
            await shotOnFail(page, hint0 === '已选 0 人——至少选择 1 名执行人', 'g1-hint-0-disabled', `G1 取消勾选降到 0 人时提示精确正确（实得："${hint0}"）`);
            await shotOnFail(page, (await page.locator('#siMConfirm').isDisabled()), 'g1-confirm-disabled-at-0', 'G1 降到 0 人时确认按钮 disabled（人数闸置灰依然存在，只是新阈值是 0→1 而非旧的 1→2）');

            // ③ 重新勾回示例开发A（回到 1 人）+ 补选示例开发B（到 2 人）——闸门随之解除并保持解除，为下方
            // PUT executors 提交 2 人（供 G3 沿用同一批次做多人矩阵/最后一人确认测试）铺垫。
            await liuRow.locator('input[type=checkbox]').check();
            await page.locator('.si-exec-pick-row:has-text("示例开发B") input[type=checkbox]').check();
            await page.waitForTimeout(150);
            const hint2 = (await page.textContent('#siExecPickHint') || '').trim();
            await shotOnFail(page, hint2 === '已选 2 人', 'g1-hint-2', `G1 补选后人数提示精确正确（实得："${hint2}"）`);
            await shotOnFail(page, !(await page.locator('#siMConfirm').isDisabled()), 'g1-confirm-enabled-at-2', 'G1 已选 2 人时确认按钮 enabled');

            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            const toastG1 = await lastToastText(page);
            await shotOnFail(page, toastG1.includes('已设置执行人，请到下方逐人发送通知'), 'g1-set-toast', `G1 PUT executors 成功 toast 正确（实得："${toastG1}"）`);

            const bodyAfter = (await page.textContent('#siBatchBody') || '');
            await shotOnFail(page, bodyAfter.includes('执行人（2）'), 'g1-exec-section-count', 'G1 设置后「执行人（2）」区块标题正确');
            await shotOnFail(page, bodyAfter.includes('示例开发A') && bodyAfter.includes('示例开发B'), 'g1-exec-names', 'G1 执行人区块含示例开发A与示例开发B两行');
            { const errs = unexpectedConsoleErrors(page._consoleErrors); await shotOnFail(page, errs.length === 0, 'g1-console-clean', `G1 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`); }
        }

        // ═══════════════════════════════════════════════════════════════
        // G2：hotfix 候选加载失败保留输入（309①）+ 应急上线选人建单 happy path
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── G2：应急上线——候选加载失败保留输入（309①）+ 建单 happy path ──');
            // MED-1（C6 预筛回卷）：认领新批次 id 前先记录本组开始前的 max(id)，供下方替换掉的
            // `ORDER BY id DESC LIMIT 1` 猜测式取法留一个可独立复核的下界（新 id 必须 > 这个值）。
            const maxRelIdBeforeG2 = (await dbGet(`SELECT MAX(id) AS m FROM sys_releases`)).m || 0;
            const issueG2 = await mkIssue('bug', 'C6-PW-G2应急上线候选加载失败');
            const page = await newPage(adminTok);
            await gotoIssue(page, issueG2);

            const hotfixBtn = page.locator('#siDActions button:has-text("应急上线")');
            await shotOnFail(page, (await hotfixBtn.count()) > 0, 'g2-hotfix-btn-present', 'G2「应急上线」按钮存在（bug·待上线·无 release_id·admin 可见）');
            await hotfixBtn.click();
            await page.waitForTimeout(200);
            const noteText = 'G2-候选加载失败保留输入测试';
            await page.fill('#f_release_note', noteText);

            // 注入第一次候选清单请求失败（500），第二次起放行——不需要真的存在网络竞态，用 route 精确控制。
            let candCallCount = 0;
            await page.route('**/api/sys-releases/executor-candidates', async (route) => {
                candCallCount++;
                if (candCallCount === 1) {
                    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'G2注入-候选清单加载失败（Playwright 冒烟模拟）' }) });
                } else {
                    await route.continue();
                }
            });

            await page.click('#siMConfirm');
            await page.waitForTimeout(400);
            const toastFail = await lastToastText(page);
            await shotOnFail(page, toastFail.includes('G2注入-候选清单加载失败'), 'g2-fail-toast', `G2 候选加载失败 toast 展示后端错误文案（实得："${toastFail}"）`);
            await shotOnFail(page, (await page.locator('#siModalOverlay.open').count()) === 1, 'g2-modal-still-open', 'G2 候选加载失败后第 1 步弹窗仍开着（未被静默关闭）');
            const noteAfterFail = await page.inputValue('#f_release_note');
            await shotOnFail(page, noteAfterFail === noteText, `g2-note-preserved`, `G2 候选加载失败后已填的上线说明原样保留（实得："${noteAfterFail}"）`);
            // 本次故意注入的 500 必然在浏览器网络层打一条 Failed to load resource——已用上面三条断言
            // 精确核实过这次失败的前端处理正确，这里摘掉这条必然伴生噪音，不让它污染本页面末尾的
            // 「全程无意外 JS 报错」总断言（同 unexpectedConsoleErrors 既有噪音过滤范式，非掩盖真实报错）。
            dismissExpectedNoise(page, /\/api\/sys-releases\/executor-candidates/, /500/);

            // 第二次点击：候选清单请求放行，进入选人弹窗。
            await page.click('#siMConfirm');
            await page.waitForTimeout(500);
            await page.unroute('**/api/sys-releases/executor-candidates');
            const modalHead2 = (await page.textContent('#siMHead') || '').trim();
            await shotOnFail(page, modalHead2 === '选择上线执行人', 'g2-picker-opened', `G2 第二次点击成功进入选人弹窗（实得标题："${modalHead2}"）`);

            await page.locator('.si-exec-pick-row:has-text("示例开发B") input[type=checkbox]').check();
            await page.locator('.si-exec-pick-row:has-text("示例开发D") input[type=checkbox]').check();
            await page.waitForTimeout(150);
            // MED-1（C6 预筛回卷）：认领新批次 id 改确定性——直接从 hotfix-publish 创建请求的响应体拿
            // `release_id`（后端权威返回值，见 index.js siModalHotfix 前端消费点 `d.release_id`），
            // 弃用「造完之后猜哪一行是最新」的 `ORDER BY id DESC LIMIT 1`（若测试期间有其它并发写入，
            // 或本组前面任何一步失败重试过，这个猜法可能认领到错误的行）。
            const [hotfixResp] = await Promise.all([
                page.waitForResponse(r => /\/api\/sys-issues\/\d+\/hotfix-publish$/.test(r.url()) && r.request().method() === 'POST'),
                page.click('#siMConfirm'),
            ]);
            await page.waitForTimeout(600);
            const toastCreated = await lastToastText(page);
            await shotOnFail(page, toastCreated.includes('已建应急上线单') && toastCreated.includes('请到批次详情逐人发送通知'), 'g2-created-toast', `G2 建单成功 toast 正确（实得："${toastCreated}"）`);

            let hotfixBody = null;
            try { hotfixBody = await hotfixResp.json(); } catch (_) { hotfixBody = null; }
            const newRelId = hotfixBody && Number.isSafeInteger(hotfixBody.release_id) ? hotfixBody.release_id : null;
            // 换真判据：不再是"查到了随便一行就算过"的恒真断言，而是"响应体给的 id 合法 且 严格大于
            // G2 开始前的 max(id)"——后者证明这确实是一行新建的、真实由本次 hotfix-publish 产生的行，
            // 不是巧合命中了某个既有行。
            must(!!newRelId && newRelId > maxRelIdBeforeG2, `G2 hotfix-publish 响应体含合法 release_id 且 > G2 前 max(id)=${maxRelIdBeforeG2}（实得 release_id=${JSON.stringify(hotfixBody && hotfixBody.release_id)}）`);
            if (newRelId) {
                createdReleaseIds.push(newRelId);
                const rows = await dbAll(`SELECT user_id, notify_status, exec_status FROM sys_release_executors WHERE release_id=? AND removed_at IS NULL ORDER BY user_id`, [newRelId]);
                must(rows.length === 2 && rows.every(r => r.notify_status === 'not_sent' && r.exec_status === 'pending'), `G2 新批次执行人子表=2 行 not_sent/pending（实得 ${JSON.stringify(rows)}）`);
                await page.waitForTimeout(300);
                await shotOnFail(page, ((await page.textContent('#siBatchBody')) || '').includes('执行人（2）'), 'g2-detail-shows-2', 'G2 建单后自动深链跳转到批次详情，展示「执行人（2）」');
            }
            { const errs = unexpectedConsoleErrors(page._consoleErrors); await shotOnFail(page, errs.length === 0, 'g2-console-clean', `G2 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`); }
        }

        // ═══════════════════════════════════════════════════════════════
        // G3：多人列表渲染（not_sent→sent 徽标/按钮矩阵真实点击）+ 最后一人确认文案 + 上线说明必填框
        //   续用 G1 批次（batchG1，已 PUT executors=[示例开发A,示例开发B]）。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── G3：徽标/按钮矩阵真实点击 + 最后一人确认文案 + 上线说明必填框 ──');
            const pageAdmin = await newPage(adminTok);
            await gotoRelease(pageAdmin, batchG1);

            // not_sent → 点「📣 发通知」（真实点击，dry-run 安全）→ sent（含 dry_run 文案）。
            const liuItem = pageAdmin.locator('.si-att-item:has-text("示例开发A")');
            await shotOnFail(pageAdmin, (await liuItem.locator('button:has-text("📣 发通知")').count()) > 0, 'g3-liu-notsent-btn', 'G3 示例开发A行 not_sent 态显示「📣 发通知」按钮');
            await liuItem.locator('button:has-text("📣 发通知")').click();
            await pageAdmin.waitForTimeout(500);
            const toastNotify1 = await lastToastText(pageAdmin);
            await shotOnFail(pageAdmin, toastNotify1.includes('已通知') && toastNotify1.includes('演练模式，未真实外呼'), 'g3-notify-toast', `G3 示例开发A行发通知成功 toast 含演练标注（实得："${toastNotify1}"）`);
            const liuItem2 = pageAdmin.locator('.si-att-item:has-text("示例开发A")');
            await shotOnFail(pageAdmin, (await liuItem2.locator('.si-release-badge:has-text("已通知")').count()) > 0, 'g3-liu-sent-badge', 'G3 示例开发A行发通知后徽标变为「已通知」');
            await shotOnFail(pageAdmin, (await liuItem2.locator('button:has-text("📣 重新通知")').count()) > 0, 'g3-liu-resend-btn', 'G3 示例开发A行发通知后按钮变为「📣 重新通知」');
            await shotOnFail(pageAdmin, (await liuItem2.locator('button:has-text("查询已读")').count()) > 0, 'g3-liu-readbtn', 'G3 示例开发A行发通知后出现「查询已读」按钮');

            // 查询已读（真实点击，dry-run message_key 短路，安全）。
            await liuItem2.locator('button:has-text("查询已读")').click();
            await pageAdmin.waitForTimeout(400);
            const toastRead1 = await lastToastText(pageAdmin);
            await shotOnFail(pageAdmin, toastRead1.includes('该消息是演练发送，不可查真实已读'), 'g3-read-dryrun-toast', `G3 查询已读命中 dry_run 短路分支 toast 正确（实得："${toastRead1}"）`);

            // 示例开发B行同款发通知（供后续 execute 全链路用）。
            const zhangItem = pageAdmin.locator('.si-att-item:has-text("示例开发B")');
            await zhangItem.locator('button:has-text("📣 发通知")').click();
            await pageAdmin.waitForTimeout(500);
            const toastNotify2 = await lastToastText(pageAdmin);
            await shotOnFail(pageAdmin, toastNotify2.includes('已通知'), 'g3-zhang-notify-toast', `G3 示例开发B行发通知成功（实得："${toastNotify2}"）`);

            // 示例开发A本人视角：确认上线完成（非最后一人）——文案"确认后还差 1 人"，不含上线说明字段。
            const pageA = await newPage(execATok);
            await gotoRelease(pageA, batchG1);
            await shotOnFail(pageA, (await pageA.locator('#siBatchFoot button:has-text("确认上线完成")').count()) > 0, 'g3-execA-btn-visible', 'G3 示例开发A本人视角「确认上线完成」按钮可见');
            await pageA.click('#siBatchFoot button:has-text("确认上线完成")');
            await pageA.waitForTimeout(300);
            const noteA = (await pageA.textContent('#siMBody') || '');
            await shotOnFail(pageA, noteA.includes('确认后还差 1 人'), 'g3-execA-not-last-text', `G3 示例开发A（非最后一人，pendingCount=2）弹窗文案正确（实得含："${noteA.slice(0, 60)}"）`);
            await shotOnFail(pageA, (await pageA.locator('#f_release_note').count()) === 0, 'g3-execA-no-note-field', 'G3 非最后一人弹窗不渲染上线说明字段');
            await pageA.click('#siMConfirm');
            await pageA.waitForTimeout(500);
            const toastExecA = await lastToastText(pageA);
            await shotOnFail(pageA, toastExecA.includes('已确认，还差 1 人'), 'g3-execA-toast', `G3 示例开发A确认成功 toast 正确（实得："${toastExecA}"）`);
            await shotOnFail(pageA, (await pageA.locator('#siBatchFoot button:has-text("确认上线完成")').count()) === 0, 'g3-execA-btn-gone', 'G3 示例开发A确认后自己的「确认上线完成」按钮消失');

            // 示例开发B本人视角：真正的最后一人——文案"你是最后一个确认人"，上线说明必填（客户端拦截空提交）。
            const pageB = await newPage(execBTok);
            await gotoRelease(pageB, batchG1);
            await pageB.click('#siBatchFoot button:has-text("确认上线完成")');
            await pageB.waitForTimeout(300);
            const noteB = (await pageB.textContent('#siMBody') || '');
            await shotOnFail(pageB, noteB.includes('你是最后一个确认人，点击后批次将翻「已上线」'), 'g3-execB-last-text', `G3 示例开发B（真最后一人，pendingCount=1）弹窗文案正确（实得含："${noteB.slice(0, 60)}"）`);
            await shotOnFail(pageB, (await pageB.locator('#f_release_note').count()) === 1, 'g3-execB-note-field', 'G3 最后一人弹窗渲染上线说明必填框');

            // 空提交：客户端拦截，不发请求，不关弹窗。
            await pageB.click('#siMConfirm');
            await pageB.waitForTimeout(300);
            const toastEmpty = await lastToastText(pageB);
            await shotOnFail(pageB, toastEmpty.includes('上线说明必填'), 'g3-execB-empty-blocked', `G3 示例开发B空提交客户端拦截 toast 正确（实得："${toastEmpty}"）`);
            await shotOnFail(pageB, (await pageB.locator('#siModalOverlay.open').count()) === 1, 'g3-execB-modal-still-open', 'G3 空提交后弹窗仍开着（未被静默提交/关闭）');
            const preRow = await dbGet(`SELECT exec_status FROM sys_release_executors WHERE release_id=? AND user_id=?`, [batchG1, EXEC_B_ID]);
            must(preRow && preRow.exec_status === 'pending', 'G3 空提交未触发任何服务端写入（示例开发B子表行仍 pending）');

            // 补填后提交：真正触发发布。
            await pageB.fill('#f_release_note', 'G3-最后一人确认测试');
            await pageB.fill('#f_version_tag', 'v-g3-test');
            await pageB.click('#siMConfirm');
            await pageB.waitForTimeout(700);
            const toastPub = await lastToastText(pageB);
            // LOW-3（C6 预筛回卷）：`.includes('1')` 是弱判据（"已上线 11 单"/"已上线 10 单"等都会误判通过），
            // 本组批次只挂 1 张成员单，精确知道 count 必为 1，改用整串等值。
            await shotOnFail(pageB, toastPub === '已上线 1 单', 'g3-execB-published-toast', `G3 示例开发B最后确认触发发布 toast 精确等于「已上线 1 单」（实得："${toastPub}"）`);
            const relAfter = await dbGet(`SELECT status, release_note, version_tag FROM sys_releases WHERE id=?`, [batchG1]);
            must(relAfter && relAfter.status === '已发布' && relAfter.release_note === 'G3-最后一人确认测试' && relAfter.version_tag === 'v-g3-test',
                `G3 批次落库已发布 + 上线说明/版本号正确写入（实得 ${JSON.stringify(relAfter)}）`);
            const issueAfter = await dbGet(`SELECT status FROM sys_issues WHERE id=?`, [issueG1]);
            must(issueAfter && issueAfter.status === '已上线', `G3 成员单 #${issueG1} status 真实转为「已上线」（实得 ${issueAfter && issueAfter.status}）`);

            // MED-3①（C6 预筛回卷）补回：release_published timeline 折叠渲染——旧文件 T2 尾段的浏览器级
            // 用例，无等价后端 verify 覆盖（这是纯前端 DOM 折叠/标签渲染逻辑），子表流改造未触碰这段代码，
            // 但仍需一次真实浏览器验证防回归。issueG1 已在上面真实走完发布链路，直接复用，不必另起夹具。
            console.log('  · G3 附加：release_published timeline 折叠渲染（issueG1 详情抽屉，复用刚发布的真实数据）');
            const pageTl = await newPage(adminTok);
            await gotoIssue(pageTl, issueG1);
            const hasFilterToggle = await pageTl.locator('label:has-text("隐藏上线单调整记录")').count();
            await shotOnFail(pageTl, hasFilterToggle > 0, 'g3-tl-filter-toggle', 'G3 timeline 区出现「隐藏上线单调整记录」过滤开关（本单确有 release_add/release_published 事件）');
            const evtLabels = await pageTl.$$eval('.si-tl-evt', els => els.map(e => e.textContent.trim()));
            await shotOnFail(pageTl, evtLabels.some(t => t.includes('发布留痕')), 'g3-tl-published-label', `G3 release_published 事件显示独立标签「发布留痕」，实得标签集: ${JSON.stringify(evtLabels)}`);
            await shotOnFail(pageTl, evtLabels.some(t => t.includes('加入上线单')), 'g3-tl-add-label', 'G3 release_add 事件显示独立标签「加入上线单」');
            const detailsInfo = await pageTl.$$eval('.si-tl-item details', els => els.map(d => ({ open: d.open, summary: d.querySelector('summary') ? d.querySelector('summary').textContent : '' })));
            await shotOnFail(pageTl, detailsInfo.length > 0, 'g3-tl-details-present', `G3 release_published 行含 <details> 折叠元素（找到 ${detailsInfo.length} 个）`);
            await shotOnFail(pageTl, detailsInfo.length > 0 && detailsInfo.every(d => d.open === false), 'g3-tl-details-closed', 'G3 release_published 的 <details> 默认收起（未展开）');
            await shotOnFail(pageTl, detailsInfo.length > 0 && /C6-PW-G1选人弹窗.*\d+\s*条\s*commit/.test(detailsInfo[0].summary), 'g3-tl-summary-format', `G3 <summary> 摘要格式正确（类型·标题·commit数），实得："${detailsInfo[0] && detailsInfo[0].summary}"`);
            const releaseScopeCountBefore = await pageTl.locator('.si-tl-release-scope').count();
            await pageTl.check('label:has-text("隐藏上线单调整记录") input[type="checkbox"]');
            await pageTl.waitForTimeout(200);
            const visibleAfterHide = await pageTl.$$eval('.si-tl-release-scope', els => els.filter(e => getComputedStyle(e).display !== 'none').length);
            await shotOnFail(pageTl, releaseScopeCountBefore > 0 && visibleAfterHide === 0, 'g3-tl-filter-hides-rows', `G3 勾选过滤开关后 ${releaseScopeCountBefore} 条上线单调整记录全部隐藏（实际仍可见 ${visibleAfterHide} 条）`);

            for (const p of [pageAdmin, pageA, pageB, pageTl]) {
                const errs = unexpectedConsoleErrors(p._consoleErrors);
                must(errs.length === 0, `G3 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // G4：done 行按钮矩阵（含 done 行无发送无查已读，对照未 done 行仍有）+ RELEASE_NOTE_REQUIRED 补弹重试（309④）
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── G4：done 行按钮矩阵 + RELEASE_NOTE_REQUIRED 补弹重试（309④） ──');
            const issueG4 = await mkIssue('feature', 'C6-PW-G4三人补弹重试');
            await mkCompleteRoster(issueG4);
            const batchG4 = await mkBatch('C6-PW-G4三人补弹重试批次');
            await addIssueTo(batchG4, issueG4);
            const execRows = await putExecutors(batchG4, [EXEC_A_ID, EXEC_B_ID, EXEC_C_ID]);
            const rowA = execRows.find(r => r.user_id === EXEC_A_ID);
            const rowB = execRows.find(r => r.user_id === EXEC_B_ID);
            const rowC = execRows.find(r => r.user_id === EXEC_C_ID);
            must(rowA && rowB && rowC, 'G4 夹具：PUT executors 三人成功返回三行');
            await notifyRow(batchG4, EXEC_A_ID);
            await notifyRow(batchG4, EXEC_B_ID);
            await notifyRow(batchG4, EXEC_C_ID);

            // 示例开发D（EXEC_C）先打开确认弹窗——此刻 pendingCount=3（三人皆 pending），前端快照"还差 2 人"（非最后一人）。
            // 弹窗打开后**不提交**，刻意让这个快照变陈旧，制造判序差（步骤见下）。
            const pageC = await newPage(execCTok);
            await gotoRelease(pageC, batchG4);
            await pageC.click('#siBatchFoot button:has-text("确认上线完成")');
            await pageC.waitForTimeout(300);
            const noteC0 = (await pageC.textContent('#siMBody') || '');
            await shotOnFail(pageC, noteC0.includes('确认后还差 2 人'), 'g4-execC-stale-snapshot', `G4 示例开发D弹窗打开时前端快照文案（陈旧，此刻真实 pendingCount=3）（实得含："${noteC0.slice(0, 60)}"）`);

            // 事务外用 API 让示例开发A、示例开发B确认（不经浏览器，示例开发D页面上已打开的弹窗不会感知这两次变化）。
            const execAr = await executeRow(batchG4, execATok, rowA.id);
            must(execAr.status === 200 && execAr.body.released === false, `G4 示例开发A（API 直调）确认成功，released=false（实得 ${execAr.status} ${JSON.stringify(execAr.body)}）`);
            const execBr = await executeRow(batchG4, execBTok, rowB.id);
            must(execBr.status === 200 && execBr.body.released === false, `G4 示例开发B（API 直调）确认成功，released=false（实得 ${execBr.status} ${JSON.stringify(execBr.body)}）`);

            // done 行按钮矩阵：另开 admin 页查看——示例开发A/示例开发B（done）行不该有任何操作按钮，示例开发D（仍 pending+sent）行应保留。
            const pageAdmin2 = await newPage(adminTok);
            await gotoRelease(pageAdmin2, batchG4);
            const execSection = pageAdmin2.locator('.u-detail-section:has(h3:has-text("执行人"))');
            const liuDoneItem = execSection.locator('.si-att-item:has-text("示例开发A")');
            await shotOnFail(pageAdmin2, (await liuDoneItem.locator('.si-release-badge:has-text("已确认")').count()) > 0, 'g4-liu-done-badge', 'G4 示例开发A（done）行显示「已确认」徽标');
            await shotOnFail(pageAdmin2, (await liuDoneItem.locator('button').count()) === 0, 'g4-liu-done-no-btns', 'G4 示例开发A（done）行不渲染任何按钮（无发通知/无重新通知/无查询已读）');
            const zhangDoneItem = execSection.locator('.si-att-item:has-text("示例开发B")');
            await shotOnFail(pageAdmin2, (await zhangDoneItem.locator('.si-release-badge:has-text("已确认")').count()) > 0, 'g4-zhang-done-badge', 'G4 示例开发B（done）行显示「已确认」徽标');
            await shotOnFail(pageAdmin2, (await zhangDoneItem.locator('button').count()) === 0, 'g4-zhang-done-no-btns', 'G4 示例开发B（done）行不渲染任何按钮（对照组同上）');
            const raoPendingItem = execSection.locator('.si-att-item:has-text("示例开发D")');
            await shotOnFail(pageAdmin2, (await raoPendingItem.locator('button:has-text("📣 重新通知")').count()) > 0, 'g4-rao-pending-notify-btn', 'G4 示例开发D（仍 pending，对照组）行保留「📣 重新通知」按钮——证明矩阵差异确由 isDone 门控，非批次态整体关闭');
            await shotOnFail(pageAdmin2, (await raoPendingItem.locator('button:has-text("查询已读")').count()) > 0, 'g4-rao-pending-read-btn', 'G4 示例开发D（仍 pending）行保留「查询已读」按钮');

            // 回到示例开发D页面：提交陈旧快照——服务端判序差：真实已是最后一人（rGateSatisfied=true）但请求体不含
            // release_note（前端按"非最后一人"分支收集字段）→ 400 RELEASE_NOTE_REQUIRED → 前端补弹重试弹窗。
            await pageC.click('#siMConfirm');
            await pageC.waitForTimeout(500);
            const retryHead = (await pageC.textContent('#siMHead') || '').trim();
            await shotOnFail(pageC, retryHead === '填写上线说明（你已成为最后一个确认人）', `g4-retry-modal-title`, `G4 RELEASE_NOTE_REQUIRED 触发补弹重试弹窗，标题正确（实得："${retryHead}"）`);
            await shotOnFail(pageC, (await pageC.locator('#f_release_note').count()) === 1, 'g4-retry-note-field', 'G4 补弹重试弹窗含上线说明必填框');
            await shotOnFail(pageC, (await pageC.locator('#f_version_tag').count()) === 1, 'g4-retry-version-field', 'G4 补弹重试弹窗含版本号选填框');
            // 陈旧快照提交必然触发一次 400 RELEASE_NOTE_REQUIRED，浏览器网络层随之打一条 Failed to load
            // resource——这正是本组要验证的场景本身（上面标题/字段断言已核实前端处理正确），摘掉这条
            // 必然伴生噪音，不让它污染本页面末尾的「全程无意外 JS 报错」总断言。
            dismissExpectedNoise(pageC, /\/api\/sys-releases\/\d+\/execute/, /400/);
            const rowCAfterFail = await dbGet(`SELECT exec_status FROM sys_release_executors WHERE id=?`, [rowC.id]);
            must(rowCAfterFail && rowCAfterFail.exec_status === 'pending', 'G4 首次陈旧提交因 RELEASE_NOTE_REQUIRED 整体回滚——示例开发D子表行仍 pending（CAS 已随事务撤销，非半截态）');

            // 补弹重试弹窗同样有客户端空值拦截。
            await pageC.click('#siMConfirm');
            await pageC.waitForTimeout(300);
            const toastRetryEmpty = await lastToastText(pageC);
            await shotOnFail(pageC, toastRetryEmpty.includes('上线说明必填'), 'g4-retry-empty-blocked', `G4 补弹重试弹窗空提交客户端拦截（实得："${toastRetryEmpty}"）`);

            await pageC.fill('#f_release_note', 'G4-补弹重试测试');
            await pageC.fill('#f_version_tag', 'v-race-test');
            await pageC.click('#siMConfirm');
            await pageC.waitForTimeout(700);
            const toastRetryOk = await lastToastText(pageC);
            // LOW-3 同款：改整串等值（本组批次同样只挂 1 张成员单）。
            await shotOnFail(pageC, toastRetryOk === '已上线 1 单', 'g4-retry-published-toast', `G4 补填后重试真正触发发布，toast 精确等于「已上线 1 单」（实得："${toastRetryOk}"）`);
            const relG4After = await dbGet(`SELECT status, release_note, version_tag FROM sys_releases WHERE id=?`, [batchG4]);
            must(relG4After && relG4After.status === '已发布' && relG4After.release_note === 'G4-补弹重试测试' && relG4After.version_tag === 'v-race-test',
                `G4 批次最终落库已发布 + 补填的上线说明/版本号正确写入（实得 ${JSON.stringify(relG4After)}）`);

            for (const p of [pageC, pageAdmin2]) {
                const errs = unexpectedConsoleErrors(p._consoleErrors);
                must(errs.length === 0, `G4 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // G5：「前往上线单」按钮权限镜像（MED-3① 补回，codex 206-MED-2 闭合件·子表流夹具下重建）——
        //   旧文件 T3b 用 issue 级 assigned_to 判"看得见单据但看不见按钮"，本次改为反映当前真实机制
        //   （2026-07-31「执行人入口批」：canSeeReleaseBrief = admin ∨ 对接人 ∨ 子表在册执行人，"数据即
        //   权限"，见 index.js GET /sys-issues/:id 注释）：四方对比——admin/对接人/子表在册执行人三者
        //   都应看得见按钮，仅凭 isAssignee 之外无其它资格的普通用户看得见单据本身但看不见按钮。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── G5：「前往上线单」按钮权限镜像（admin/对接人/子表执行人 vs 仅 isAssignee） ──');
            const issueG5 = await mkIssue('bug', 'C6-PW-G5前往上线单权限镜像');
            const batchG5 = await mkBatch('C6-PW-G5前往上线单权限镜像批次');
            await addIssueTo(batchG5, issueG5);   // 加单后 issueG5.release_id 非空
            await putExecutors(batchG5, [EXEC_A_ID, EXEC_B_ID]);   // 示例开发A进子表在册执行人
            // 仅 isAssignee、非 admin/对接人/子表执行人的第四方——用户 10（示例开发C，active·role=user）。
            const ASSIGNEE_ONLY_ID = 10, ASSIGNEE_ONLY_NAME = '示例开发C';
            await dbRun(`UPDATE sys_issues SET assigned_to=?, assigned_to_name=? WHERE id=?`, [ASSIGNEE_ONLY_ID, ASSIGNEE_ONLY_NAME, issueG5]);
            const assigneeOnlyTok = await signAs(ASSIGNEE_ONLY_ID);

            const orchSel = '.u-detail-section:has(h3:has-text("上线编排"))';
            const goBtnSel = `${orchSel} button:has-text("前往上线单")`;

            const pageAdminG5 = await newPage(adminTok);
            await gotoIssue(pageAdminG5, issueG5);
            await shotOnFail(pageAdminG5, (await pageAdminG5.locator(goBtnSel).count()) > 0, 'g5-admin-btn-visible', 'G5 admin 视角「前往上线单」按钮可见');

            const pageLiaisonG5 = await newPage(liaisonTok);
            await gotoIssue(pageLiaisonG5, issueG5);
            await shotOnFail(pageLiaisonG5, (await pageLiaisonG5.locator(goBtnSel).count()) > 0, 'g5-liaison-btn-visible', 'G5 对接人(示例对接人)视角「前往上线单」按钮可见');

            // 子表在册执行人（示例开发A）——2026-07-31「执行人入口批」后新增的可见性分支，是本组相对旧文件
            // T3b 的真实新增覆盖点（旧机制里执行人不在 release_brief 放行集内）。
            const pageExecG5 = await newPage(execATok);
            await gotoIssue(pageExecG5, issueG5);
            await shotOnFail(pageExecG5, (await pageExecG5.locator(goBtnSel).count()) > 0, 'g5-executor-btn-visible', 'G5 子表在册执行人（示例开发A）视角「前往上线单」按钮可见（release_brief 三放行分支之一）');

            // 仅 isAssignee（示例开发C）——能看到单据本身（否则 goto 会被 403 拦住整页），但看不到按钮，进度文案仍在。
            const pageOtherG5 = await newPage(assigneeOnlyTok);
            await gotoIssue(pageOtherG5, issueG5);
            await shotOnFail(pageOtherG5, (await pageOtherG5.locator(orchSel).count()) > 0, 'g5-other-can-view', 'G5 仅 isAssignee 的用户（示例开发C）仍能看到单据详情本身（前置条件：不是整页 403）');
            await shotOnFail(pageOtherG5, (await pageOtherG5.locator(goBtnSel).count()) === 0, 'g5-other-btn-hidden', 'G5 仅 isAssignee（非 admin/对接人/子表执行人）「前往上线单」按钮不可见（release_brief=null，点击必 403 故不显示）');
            const otherOrchText = (await pageOtherG5.locator(orchSel).textContent()) || '';
            await shotOnFail(pageOtherG5, otherOrchText.includes('已建应急上线单'), 'g5-other-progress-text-kept', 'G5 仅 isAssignee 用户仍能看到「已建应急上线单」进度文案（按钮隐藏≠信息也隐藏）');

            for (const p of [pageAdminG5, pageLiaisonG5, pageExecG5, pageOtherG5]) {
                const errs = unexpectedConsoleErrors(p._consoleErrors);
                must(errs.length === 0, `G5 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`);
            }
        }

        // ═══════════════════════════════════════════════════════════════
        // G6（312-L1·codex 合并前建议）单人批次里唯一执行人确认时弹出「你是最后一个确认人」文案 +
        //   上线说明必填框——低成本追加：直接复用 G3 已验证过的 isLast 判定逻辑（pendingCount===1）
        //   与渲染断言写法，只是这次批次里只有这一个人，天然满足"最后一人"，不需要额外构造两人序列。
        // ═══════════════════════════════════════════════════════════════
        {
            console.log('\n── G6：单人批次唯一执行人确认弹出「最后一人」文案 + 上线说明必填框（312-L1） ──');
            const issueG6 = await mkIssue('feature', 'C6-PW-G6单人最后一人文案');
            await mkCompleteRoster(issueG6);
            const batchG6 = await mkBatch('C6-PW-G6单人最后一人文案批次');
            await addIssueTo(batchG6, issueG6);
            await putExecutors(batchG6, [EXEC_A_ID]);
            await notifyRow(batchG6, EXEC_A_ID);

            const pageG6 = await newPage(execATok);
            await gotoRelease(pageG6, batchG6);
            await shotOnFail(pageG6, (await pageG6.locator('#siBatchFoot button:has-text("确认上线完成")').count()) > 0, 'g6-btn-visible', 'G6 单人批次唯一执行人（示例开发A）「确认上线完成」按钮可见');
            await pageG6.click('#siBatchFoot button:has-text("确认上线完成")');
            await pageG6.waitForTimeout(300);
            const noteG6 = (await pageG6.textContent('#siMBody') || '');
            await shotOnFail(pageG6, noteG6.includes('你是最后一个确认人，点击后批次将翻「已上线」'), 'g6-last-text', `G6 单人批次唯一执行人弹窗文案正确（天然满足最后一人，pendingCount=1，实得含："${noteG6.slice(0, 60)}"）`);
            await shotOnFail(pageG6, (await pageG6.locator('#f_release_note').count()) === 1, 'g6-note-field', 'G6 单人批次唯一执行人弹窗渲染上线说明必填框（与多人批次最后一人同一渲染分支，非单人专属特殊逻辑）');
            { const errs = unexpectedConsoleErrors(pageG6._consoleErrors); await shotOnFail(pageG6, errs.length === 0, 'g6-console-clean', `G6 页面全程无意外 JS 报错（实得=${errs.length}${errs.length ? ': ' + errs.slice(0, 2).join(' | ') : ''}）`); }
        }

    } finally {
        for (const p of openPages) { try { await p.close(); } catch (_) { /* ignore */ } }
        await browser.close();
        // ── 清理测试夹具 + 断言清理结果（无论通过与否都执行）──
        // LOW-5（C6 预筛回卷）：`ref_id` 列在 sys_issue_timeline 里不是「release 专属」语义——不同
        // action_code 家族可能把它当不同的外键使用（issue_id 本身因为是本测试新建的全新自增 id，不存在
        // 这层歧义，唯独 ref_id 存在"巧合撞上其它特性用同一数值当别的意思"的风险）。收窄到本文件真实
        // 可能写出的、release 语义明确的 action_code 集合（与 Sys_Iteration.html SI_TL_RELEASE_SCOPE_LABEL
        // 权威映射表逐字同源），而不是"ref_id 数值撞上了就删"。
        const RELEASE_SCOPE_ACTION_CODES = [
            'release_add', 'release_remove', 'release_date_change', 'release_schedule_cancel',
            'release_published', 'release_executors_set', 'release_executor_notify',
            'release_executor_done', 'release_hotfix_create',
        ];
        try {
            if (createdReleaseIds.length) {
                const ph = createdReleaseIds.map(() => '?').join(',');
                await dbRun(`DELETE FROM sys_release_executors WHERE release_id IN (${ph})`, createdReleaseIds);
                await dbRun(`DELETE FROM sys_issue_release_commit_snapshots WHERE release_id IN (${ph})`, createdReleaseIds);
                const phCodes = RELEASE_SCOPE_ACTION_CODES.map(() => '?').join(',');
                await dbRun(
                    `DELETE FROM sys_issue_timeline WHERE ref_id IN (${ph}) AND action_code IN (${phCodes})`,
                    [...createdReleaseIds, ...RELEASE_SCOPE_ACTION_CODES]
                );
            }
            if (createdIssueIds.length) {
                const phI = createdIssueIds.map(() => '?').join(',');
                // issue_id 是本测试新建单据自己的自增主键，不存在跨 action_code 歧义（该 id 之前不曾
                // 存在，任何指向它的 timeline 行必然是本测试自己产生的），不需要同款 action_code 收窄。
                await dbRun(`DELETE FROM sys_issue_timeline WHERE issue_id IN (${phI})`, createdIssueIds);
                await dbRun(`DELETE FROM sys_issue_dev_assignees WHERE issue_id IN (${phI})`, createdIssueIds);
                await dbRun(`DELETE FROM sys_issues WHERE id IN (${phI})`, createdIssueIds);
            }
            if (createdReleaseIds.length) {
                const ph = createdReleaseIds.map(() => '?').join(',');
                await dbRun(`DELETE FROM sys_releases WHERE id IN (${ph})`, createdReleaseIds);
            }
            // MED-2：只删自己插入过的行——insertedDuty/insertedConfig 为 false 时说明 G1 前置核验已经
            // throw 硬中止（dutyDates 为空数组 / config 从未被本脚本写过），不该去删任何东西。
            if (insertedDuty) { for (const d of dutyDates) await dbRun(`DELETE FROM sys_release_duty_roster WHERE duty_date=?`, [d]); }
            if (insertedConfig) { await dbRun(`DELETE FROM system_configs WHERE config_key='sys_release_default_executor_ids'`); }

            const leftIssues = createdIssueIds.length ? await dbAll(`SELECT id FROM sys_issues WHERE id IN (${createdIssueIds.map(() => '?').join(',')})`, createdIssueIds) : [];
            const leftReleases = createdReleaseIds.length ? await dbAll(`SELECT id FROM sys_releases WHERE id IN (${createdReleaseIds.map(() => '?').join(',')})`, createdReleaseIds) : [];
            const leftDuty = (insertedDuty && dutyDates.length) ? await dbAll(`SELECT id FROM sys_release_duty_roster WHERE duty_date IN (${dutyDates.map(() => '?').join(',')})`, dutyDates) : [];
            const leftConfig = insertedConfig ? await dbGet(`SELECT config_key FROM system_configs WHERE config_key='sys_release_default_executor_ids'`) : null;
            must(leftIssues.length === 0, `清理断言：${createdIssueIds.length} 个测试单据全部删除（残留 ${leftIssues.length}）`);
            must(leftReleases.length === 0, `清理断言：${createdReleaseIds.length} 个测试批次全部删除（残留 ${leftReleases.length}）`);
            must(leftDuty.length === 0, `清理断言：${insertedDuty ? dutyDates.length : 0} 条本脚本自己写入的测试排班全部删除（残留 ${leftDuty.length}）`);
            must(!leftConfig, `清理断言：${insertedConfig ? '本脚本写入的测试用 sys_release_default_executor_ids 配置行已删除' : '本脚本从未写过该配置（前置核验中止或未到该步），无需删除'}`);
            console.log(`\n  🧹 测试夹具已清理并断言核验：issues=[${createdIssueIds.join(',')}] releases=[${createdReleaseIds.join(',')}] duty(自己插入=${insertedDuty})=[${dutyDates.join(',')}] config(自己插入=${insertedConfig})`);
        } catch (cleanErr) {
            fail++;
            console.error('  ⚠️ 清理夹具时出错（需人工核查残留）:', cleanErr.message);
        }
        db.close();
    }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    if (failShots.length) console.log('  失败截图：\n    ' + failShots.join('\n    '));
    console.log(fail === 0 ? '  🎉 C6 收口 Playwright 冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('实测脚本异常:', e && e.stack || e); process.exit(1); });
