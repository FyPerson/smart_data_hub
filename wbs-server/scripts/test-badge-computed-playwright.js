/**
 * 状态徽章统一 S2 · computed style 抽样验收 harness
 *
 * 用途（方案 v1.2 §2.2 复审 M-1 的验收手段）：
 *   静态守卫（verify-badge-alias.js）只能证明"页内写了别名规则、没留 direct 声明"，
 *   证明不了"浏览器真的按 token 渲染"。中间隔着级联——外链 components.css 与页内 <style>
 *   谁赢、:root 变量有没有被别处覆盖、别名有没有被更高特异性的规则压过，只有 computed style
 *   能给出终局答案。本脚本每页取 1 个真实列表徽章，断言其 computed 值等于目标语义层的 token 值，
 *   并反向断言**旧 direct 色不再命中**（防"看似接入实际无效"）。
 *
 * 用法：
 *   PORT=3000 node scripts/test-badge-computed-playwright.js
 *     （默认 3000；server 需**先手动起好**——本脚本有意不自己 spawn server，
 *       避免与主会话/生产端口纪律打架。探测不到监听直接退出并提示。）
 *
 * ⚠️ 只读浏览：只 goto 列表页读 computed style，不点任何按钮、不提交表单、不写库。
 * ⚠️ 依赖库内有数据：某页列表若一条徽章都没有，该页记 SKIP 而不是 FAIL
 *    （空库不代表接线坏；真要覆盖需先造数，那属于 S5b 视觉基线重拍的范围）。
 * ⚠️ 纯新增脚本资产：不改 public/ 下任何业务页面。
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
const JWT_SECRET = process.env.JWT_SECRET;
const DB_PATH = process.env.BADGE_DB_PATH || path.join(__dirname, '..', 'task_pool.db');

// ── 14 层语义色板期望值（与 components.css :root 同源；改色值需同步这里）──────────
// rgb() 形态用于与 getComputedStyle 返回值直接比对（浏览器统一把 hex 归一化成 rgb()）。
const SEM = {
    wait: { bg: '#f8fafc', fg: '#64748b', bd: '#e2e8f0', bds: 'solid', dot: '#94a3b8', deco: 'none' },
    intake: { bg: '#eef2ff', fg: '#4338ca', bd: '#c7d2fe', bds: 'solid', dot: '#6366f1', deco: 'none' },
    active: { bg: '#eff6ff', fg: '#1d4ed8', bd: '#bfdbfe', bds: 'solid', dot: '#3b82f6', deco: 'none' },
    review: { bg: '#fffbeb', fg: '#b45309', bd: '#fde68a', bds: 'solid', dot: '#f59e0b', deco: 'none' },
    special: { bg: '#f5f3ff', fg: '#6d28d9', bd: '#ddd6fe', bds: 'solid', dot: '#8b5cf6', deco: 'none' },
    staging: { bg: '#f0fdfa', fg: '#0f766e', bd: '#99f6e4', bds: 'solid', dot: '#14b8a6', deco: 'none' },
    // 第 14 层（待上线可见性 20260812 v1.0·D1b）：「待上线」专属橙色相，与 staging 分层不改它
    prerelease: { bg: '#fff7ed', fg: '#c2410c', bd: '#fdba74', bds: 'solid', dot: '#f97316', deco: 'none' },
    done: { bg: '#f0fdf4', fg: '#15803d', bd: '#bbf7d0', bds: 'solid', dot: '#22c55e', deco: 'none' },
    hold: { bg: '#fefce8', fg: '#854d0e', bd: '#fef08a', bds: 'solid', dot: '#eab308', deco: 'none' },
    rejected: { bg: '#fef2f2', fg: '#991b1b', bd: '#fecaca', bds: 'solid', dot: '#ef4444', deco: 'none' },
    failed: { bg: '#fef2f2', fg: '#b91c1c', bd: '#fca5a5', bds: 'solid', dot: '#dc2626', deco: 'none' },
    archived: { bg: '#f0fdf4', fg: '#15803d', bd: '#86efac', bds: 'dashed', dot: '#4ade80', deco: 'none' },
    voided: { bg: '#f8fafc', fg: '#9ca3af', bd: '#e5e7eb', bds: 'solid', dot: '#d1d5db', deco: 'line-through' },
    legacy: { bg: '#f8fafc', fg: '#94a3b8', bd: '#e2e8f0', bds: 'solid', dot: '#cbd5e1', deco: 'none' },
};

// S4 两页的旧 direct 底色（style.css 遗留徽章族 + app.js 两处内联色）。
//   ⚠️ badge-open / badge-claimed / TRANSFERRING 三处旧观感是**线性渐变**，渐变落在
//   background-image 上、backgroundColor 报 transparent，这张表抓不到它们——
//   那一半由 `background-image === 'none'` 的断言负责，两条合起来才覆盖完整。
const TASK_LEGACY_DIRECT = [
    'rgb(217, 119, 6)',     // --color-accent（旧 .badge-done 与抽屉段 base 的底色）
    'rgb(229, 62, 62)',     // 旧 .badge-hold
    'rgb(203, 213, 224)',   // 旧 ARCHIVED 卡片内联色 #cbd5e0
];

// ── 逐页抽样配置（与 verify-badge-alias.js 的 PAGE_ALIAS_SPECS 同一份映射真相）──────────
//   classToTier：徽章修饰类 → 期望语义层。脚本会取页面上**第一个**能识别修饰类的徽章做断言，
//   所以不依赖库里必须有某个特定状态的单（有什么测什么，覆盖率写进报告）。
const PAGES = [
    {
        key: 'Data_Correction',
        file: 'Data_Correction.html',
        listSelector: '.u-corr-table tbody tr',
        badgeSelector: '.u-corr-table tbody .u-status-badge',
        classToTier: {
            's-PENDING_ASSIGN': 'wait', 's-ASSIGNED_PENDING_ESTIMATE': 'intake', 's-IN_PROGRESS': 'active',
            's-SUSPENDED': 'hold',   // 暂缓方案 v1.1（与 verify-badge-alias PAGE_ALIAS_SPECS 同源，B13 互校）
            's-FIXED': 'done', 's-REFIXED': 'done', 's-ARCHIVED': 'archived',
            's-REJECTED': 'rejected', 's-VOIDED': 'voided',
        },
        legacyDirect: ['rgb(243, 244, 246)', 'rgb(224, 231, 255)', 'rgb(219, 234, 254)', 'rgb(254, 243, 199)', 'rgb(204, 251, 241)', 'rgb(209, 250, 229)', 'rgb(229, 231, 235)'],
    },
    {
        key: 'Statistics',
        file: 'Statistics.html',
        listSelector: '.u-corr-table tbody tr',
        badgeSelector: '.u-corr-table tbody .u-status-badge',
        // aborted 映射 wait 层（S2 提案 1 主会话裁定：统计归并标签要看得清，不继承 voided 的弱化档）
        classToTier: { 's-done': 'done', 's-inflight': 'active', 's-aborted': 'wait' },
        legacyDirect: ['rgb(209, 250, 229)', 'rgb(219, 234, 254)', 'rgb(243, 244, 246)'],
    },
    {
        key: 'Issue_Lite',
        file: 'Issue_Lite.html',
        listSelector: '.u-corr-table tbody tr',
        badgeSelector: '.u-corr-table tbody .u-status-badge',
        classToTier: { 's-待处理': 'wait', 's-处理中': 'active', 's-已完成': 'done', 's-已归档': 'archived', 's-已作废': 'voided' },
        legacyDirect: ['rgb(243, 244, 246)', 'rgb(219, 234, 254)', 'rgb(209, 250, 229)', 'rgb(237, 233, 254)', 'rgb(254, 226, 226)'],
    },
    {
        key: 'Issue_Tracker',
        file: 'Issue_Tracker.html',
        listSelector: '.u-corr-table tbody tr',
        badgeSelector: '.u-corr-table tbody .u-status-badge',
        classToTier: { 's-待处理': 'wait', 's-处理中': 'active', 's-待验证': 'review', 's-已关闭': 'done', 's-已暂缓': 'hold', 's-已拒绝': 'rejected' },
        legacyDirect: ['rgb(243, 244, 246)', 'rgb(219, 234, 254)', 'rgb(254, 243, 199)', 'rgb(209, 250, 229)', 'rgb(254, 249, 195)'],
    },
    {
        key: 'Sys_Iteration',
        file: 'Sys_Iteration.html',
        listSelector: '.u-corr-table tbody tr',
        badgeSelector: '.u-corr-table tbody .u-status-badge',
        classToTier: {
            'si-s-pending': 'wait', 'si-s-scheduled': 'legacy', 'si-s-intake': 'intake', 'si-s-revision': 'review',
            // [待上线可见性 20260812·D1b] si-s-prerelease 期望层由 staging 改为第 14 层 prerelease（橙）
            'si-s-dev': 'active', 'si-s-liaisontest': 'special', 'si-s-review': 'review', 'si-s-prerelease': 'prerelease',
            'si-s-released': 'done', 'si-s-closed': 'archived', 'si-s-hold': 'hold', 'si-s-rejected': 'rejected',
            'si-s-void': 'voided',
        },
        legacyDirect: ['rgb(243, 244, 246)', 'rgb(224, 231, 255)', 'rgb(254, 243, 199)', 'rgb(219, 234, 254)', 'rgb(237, 233, 254)', 'rgb(204, 251, 241)', 'rgb(209, 250, 229)', 'rgb(226, 232, 240)', 'rgb(254, 249, 195)', 'rgb(229, 231, 235)'],
    },
    {
        key: 'Data_Collab',
        file: 'Data_Collab.html',
        // ⚠️ 本页列表表格用的是 `.data-table.u-table-compact#collabListTable`，**不是** .u-corr-table——
        //    S2 首版照抄了其余五页的选择器，导致本页抽不到元素、被记成 SKIP 而不是真跑（H-1）。
        listSelector: '#collabListTable tbody tr',
        badgeSelector: '#collabListTable tbody .u-status-badge',
        // A-M2：PENDING「待开发」→ wait（server.js 实证无开发方受理门，指派直接置 PENDING）
        classToTier: {
            'status-PENDING_ASSIGN': 'wait', 'status-PENDING': 'wait', 'status-EXPORTING': 'staging',
            'status-SUBMITTED': 'review', 'status-DONE': 'done', 'status-ARCHIVED': 'archived',
            'status-CONFIRMED': 'legacy', 'status-CLAIMED': 'legacy',
        },
        legacyDirect: ['rgb(243, 244, 246)', 'rgb(219, 234, 254)', 'rgb(204, 251, 241)', 'rgb(254, 243, 199)', 'rgb(221, 214, 254)', 'rgb(209, 250, 229)', 'rgb(229, 231, 235)'],
    },

    // ══ S3 收编的两页（sem 模式：类名是 sem-<层>，与层名一一对应）══════════════════
    {
        key: 'Periodic_Fetch',
        file: 'Periodic_Fetch.html',
        // ⚠️ 首屏任务卡**不渲染徽章**：`pfRenderTaskCard` 的「上次运行」区在 runs 未加载时显示
        //    "点击展开查看"，徽章要等展开卡片（pfToggleCard 拉取运行历史）后才出现。
        //    故加 openFn 点开第一张卡——这不是"造数"，是走用户本来就要走的那一步交互。
        //    ⚠️ listSelector 用 `.pf-card .pf-head` 而不是 `.pf-card`：无任务时页面渲染的是一张
        //    **空态占位卡**（`<div class="pf-card"><div class="pf-empty">暂无周期任务…`），它也匹配
        //    `.pf-card`，会给出"有 1 行数据"的假信号，把本该是 EMPTY_TABLE 的情况误判成红。
        //    真实任务卡才有 .pf-head（点击展开的表头区）。
        listSelector: '#pfTaskList .pf-card .pf-head',
        badgeSelector: '#pfTaskList .u-status-badge',
        openFn: async (page, ctx) => {
            const head = await page.$('#pfTaskList .pf-card .pf-head');
            if (!head) return 'no-target';        // 库里没任务 → 交给下游 rows 判定走 EMPTY_TABLE
            // 〔23B·B-M1〕留住**被点击的那张卡**的句柄：下面三条 DOM 文案证据只在这张卡
            //   （含它自己的历史容器——子面板就在同一张 .pf-card 内）里取。
            //   原实现扫整个 #pfTaskList：多张卡时，A 卡渲染坏成零徽章、B 卡恰好是"尚未跑过"，
            //   B 卡的空态文案就替 A 卡的故障背了书（证据串用），豁免照发。
            const cardHandle = await head.evaluateHandle((el) => el.closest('.pf-card'));
            await head.click();
            await page.waitForSelector('#pfTaskList .u-status-badge', { timeout: 10000 }).catch(() => null);
            // 切到「跑数 · 历史」子页，否则历史区可能还没渲染，"历史为空"就成了假证据
            const runsTab = await page.$('#pfTaskList .pf-subtab:has-text("跑数")').catch(() => null);
            if (runsTab) { await runsTab.click().catch(() => {}); await page.waitForTimeout(600); }
            await page.waitForTimeout(400);
            if ((await page.$$('#pfTaskList .u-status-badge')).length > 0) return true;

            // ── H2：零徽章想走 NO_BADGE_LEGIT，必须**四证据齐备**才算"业务合法态"。
            //    少任何一条都说明这可能是渲染坏 / 选择器错 / 类被误删的**真故障**，
            //    那种情况绝不能被豁免掉——"没测到"必须表现为红灯而不是一行 SKIP。
            const ev = await cardHandle.evaluate((card) => {
                const txt = card ? card.textContent : '';
                return {
                    // ① 明确的"从未运行"空态文案（pfRenderTaskCard 在 runs 为空数组时输出）
                    neverRan: /尚未跑过/.test(txt),
                    // ② 该任务卡不是 disabled 态（disabled 会渲染「已禁用」徽章，此时零徽章就是异常）
                    notDisabled: !/已禁用/.test(txt),
                    // ③ 运行历史区为空（pfRenderRunsTable 的空态文案；该区就在本卡的子面板内）
                    emptyHistory: /暂无执行历史/.test(txt),
                    cardExists: !!card,
                };
            });
            // ④ 采集期间无失败请求（接口 4xx/5xx 或请求失败会让页面渲染不出东西，
            //    那是环境/后端问题，同样不该被当成"业务合法态"）
            //    ⚠️ B-M1：ctx 的监听窗口已由调用方拉长到「goto → 抽样完成」全程，
            //       不再只覆盖 openFn 内部——首屏加载阶段的失败请求同样会让卡片渲染不出东西。
            const noBadRequests = !ctx || (ctx.failedRequests.length === 0 && ctx.badResponses.length === 0);

            const missing = [];
            if (!ev.cardExists) missing.push('取不到被点击的任务卡（closest(.pf-card) 落空，DOM 结构变了）');
            if (!ev.neverRan) missing.push('本卡无「尚未跑过」空态文案');
            if (!ev.notDisabled) missing.push('本卡出现「已禁用」字样（该态本应有徽章）');
            if (!ev.emptyHistory) missing.push('本卡无「暂无执行历史」空态文案');
            if (!noBadRequests) missing.push(`采集期间有失败请求（failed ${ctx.failedRequests.length} / 4xx+ ${ctx.badResponses.length}）`);
            if (missing.length) return { verdict: 'fail', why: `零徽章但业务合法态四证据不齐：${missing.join('；')}` };
            return 'no-badge-legit';
        },
        classToTier: {
            'sem-done': 'done', 'sem-failed': 'failed', 'sem-active': 'active',
            'sem-wait': 'wait', 'sem-review': 'review', 'sem-voided': 'voided',
        },
        legacyDirect: ['rgb(209, 250, 229)', 'rgb(254, 226, 226)', 'rgb(254, 243, 199)', 'rgb(219, 234, 254)', 'rgb(241, 245, 249)'],
    },
    {
        key: 'Model_Center',
        file: 'Model_Center.html',
        // ⚠️ 本页状态徽章**只在详情抽屉里**（列表页状态列是纯文字，方案 §2.5「列表页纯文字维持现状」），
        //    故需先点开第一行抽屉。openFn 照抄 test-model-c3-drawer-playwright.js 的打开范式。
        listSelector: '#modelListBody tr',
        badgeSelector: '#modelDrawerBody .u-status-badge',
        openFn: async (page) => {
            const btn = await page.$('#modelListBody tr[data-id] button, #modelListBody tr[data-id]');
            if (!btn) return 'no-target';   // 库里没有模型 → 交下游 rows 判定（对齐三态契约）
            await btn.click();
            await page.waitForSelector('#modelDrawerBody .kv', { timeout: 10000 });
            await page.waitForTimeout(400);
            return true;
        },
        classToTier: {
            'sem-wait': 'wait', 'sem-active': 'active', 'sem-review': 'review',
            'sem-done': 'done', 'sem-archived': 'archived',
        },
        legacyDirect: ['rgb(209, 250, 229)', 'rgb(241, 245, 249)'],
    },

    // ══ S4 收编的两页（遗留渐变层 → sem 模式）══════════════════════════════════
    //   两页的徽章全部来自共享的 app.js（Task_Pool 页面自身零徽章代码）。
    //   旧观感是 style.css 的**渐变**徽章族——渐变走 background-image，computed 的
    //   backgroundColor 会是透明，legacyDirect 那套"旧底色不再命中"根本抓不到它；
    //   故另加一条全页通用的 background-image === 'none' 断言（见下方抽样断言段）。
    {
        key: 'Task_Pool',
        file: 'Task_Pool.html',
        // 卡片区三个 .task-grid（存疑 / 进行中 / 待确认）。OPEN 与 ARCHIVED 在本页走表格，
        //   不产出卡片徽章，故它们的覆盖靠抽屉（本地库 44 条 ARCHIVED 都在归档表里）。
        listSelector: '.task-grid .task-card',
        // 卡片徽章 + 抽屉徽章一起抽：ARCHIVED 在本页走归档表格（不产出卡片徽章），
        //   不把抽屉那一层纳进来，本机库里数量最多的状态反而永远零覆盖。
        badgeSelector: '.task-grid .task-card .u-status-badge, #drawerStatus .u-status-badge',
        openFn: async (page, ctx) => {
            // 〔B11〕no-target（"库里就是没有对象"）必须携带网络证据才许发放——与 23-H2 四证据同源。
            //   没有这条，一次接口 500 导致列表空白，会被读成"数据依赖"而记 SKIP，
            //   真故障就此被一行灰字盖过去。有失败请求 → 判红并列出来。
            // 〔B11·S4-fix3〕ctx 或其数组缺失**一律 fail**，不再当成"网络干净"。
            //   ⚠️〔24D 残余·登记接受〕仍有一个够不着的角落：监听器 `page.on(...)` 注册本身失败时，
            //   数组是初始化好的空数组，形态检查过得去、内容也确实是空 —— 这种情况下"网络干净"
            //   是个没有来源的结论。要堵得引入"监听器确实挂上了"的正向证据（如每页至少观测到
            //   1 个 response 事件）。当前不修：本 harness 每页都要 goto，零 response 事件本身
            //   就会让页面加载失败进而在别处红，剩余风险很薄。
            //   `!ctx || …` 那种写法把"没有证据"读成了"证据显示没问题"——恰恰是本项目一路在防的
            //   「没看见 ≠ 没问题」。取不到网络快照时我们对这一页的健康一无所知，只能判红。
            const noTargetVerdict = (where) => {
                if (!ctx || !Array.isArray(ctx.failedRequests) || !Array.isArray(ctx.badResponses)) {
                    return { verdict: 'fail', why: `${where}为空，且**拿不到网络快照**（ctx 缺失或结构变了）——无证据可依，不发放 no-target 豁免` };
                }
                if (ctx.failedRequests.length || ctx.badResponses.length) {
                    return { verdict: 'fail', why: `${where}为空，但采集期间有失败请求（failed ${ctx.failedRequests.length} / 4xx+ ${ctx.badResponses.length}：${[...ctx.failedRequests, ...ctx.badResponses].slice(0, 2).join(' | ')}）——空列表更可能是接口坏了而不是库里没数据` };
                }
                return 'no-target';
            };
            // 本页四个标签页（待认领/进行中/已提交/已归档）默认停在「待认领」，卡片区在别的标签下
            //   **在 DOM 里但不可见**——直接 click 会因 actionability 超时，然后被 catch 吞掉，
            //   openFn 照样返回 true = 一次静默的空动作。故先点标签页把目标切出来，再点行。
            const clickTab = async (tab) => {
                const btn = await page.$(`.tab-btn[onclick*="'${tab}'"]`);
                if (!btn) return false;
                await btn.click();
                await page.waitForTimeout(400);
                return true;
            };
            // 优先打开一条**已归档**任务的抽屉：ARCHIVED 在本页走归档表格不产出卡片徽章，
            //   不走这一步，本机库里数量最多的状态永远零覆盖。
            if (await clickTab('archived')) {
                const row = await page.$('#archivedTableBody tr');
                if (row) {
                    await row.click();
                    await page.waitForSelector('#drawerStatus .u-status-badge', { timeout: 8000 });
                    await page.waitForTimeout(300);
                    return true;
                }
            }
            // 归档表为空 → 退到「进行中」标签点卡片标题开抽屉（同一个抽屉，状态随卡片）
            await clickTab('claimed');
            const cardTitle = await page.$('#claimedTasks .task-card .task-title');
            if (!cardTitle) return noTargetVerdict('归档表与卡片区都');   // 交下游 rows 判定（须网络干净）
            await cardTitle.click();
            await page.waitForSelector('#drawerStatus .u-status-badge', { timeout: 8000 });
            await page.waitForTimeout(300);
            return true;
        },
        classToTier: {
            'sem-wait': 'wait', 'sem-active': 'active', 'sem-hold': 'hold',
            'sem-staging': 'staging', 'sem-review': 'review', 'sem-archived': 'archived',
        },
        legacyDirect: TASK_LEGACY_DIRECT,
        checkOverflow: true,
        // 〔B12·S4-fix3〕页级宿主选择器**显式登记**（实测得来）：卡片徽章的约束容器是任务卡本身，
        //   抽屉徽章的是抽屉正文区。通用祖先探测降级为诊断输出——它是"猜"，登记的才是判据。
        overflowHosts: ['.task-card', '.drawer-body'],
    },
    {
        key: 'My_Workspace',
        file: 'My_Workspace.html',
        // 本页列表状态是纯文字，徽章**只在详情抽屉里**（页内那份抽屉副本，乙3）。
        listSelector: '.task-item',
        badgeSelector: '#drawerStatus .u-status-badge',
        openFn: async (page, ctx) => {
            const title = await page.$('.task-item .task-title');
            if (!title) {
                // 〔B11〕同 Task_Pool：no-target 必须有网络证据支撑；证据本身取不到也判红
                if (!ctx || !Array.isArray(ctx.failedRequests) || !Array.isArray(ctx.badResponses)) {
                    return { verdict: 'fail', why: '任务列表为空，且拿不到网络快照（ctx 缺失或结构变了）——无证据可依，不发放 no-target 豁免' };
                }
                if (ctx.failedRequests.length || ctx.badResponses.length) {
                    return { verdict: 'fail', why: `任务列表为空，但采集期间有失败请求（failed ${ctx.failedRequests.length} / 4xx+ ${ctx.badResponses.length}）——空列表更可能是接口坏了` };
                }
                return 'no-target';
            }
            await title.click();
            await page.waitForSelector('#drawerStatus .u-status-badge', { timeout: 10000 });
            await page.waitForTimeout(300);
            return true;
        },
        classToTier: {
            'sem-wait': 'wait', 'sem-active': 'active', 'sem-hold': 'hold',
            'sem-staging': 'staging', 'sem-review': 'review', 'sem-archived': 'archived',
        },
        legacyDirect: TASK_LEGACY_DIRECT,
        checkOverflow: true,
        overflowHosts: ['.drawer-body'],   // 本页徽章只在详情抽屉里
    },
];

// ============================================================
// 允许 SKIP 的页面白名单：key → 为什么这一页此刻抽不到徽章是可接受的。
//   空表 = 六页都必须真跑出断言。SKIP 是"没验到"不是"验过了"——S2 首版 Data_Collab 因选择器写错
//   被静默记成 SKIP，报告里看着只是"一条跳过"，实际是整页零覆盖（H-1）。故收尾硬断言：
//   任何未登记的 SKIP 直接红灯，逼人要么修选择器、要么显式写下"这页为什么可以不验"。
// B-M10 结构化：pageKey → 允许的**原因码集合**。只有 'EMPTY_TABLE'（表体真的一行都没有）
//   算数据依赖，可以登记豁免；其余原因码（有行却抽不到徽章 / 抽到的徽章全是未登记类）都是
//   选择器写错或页面变了，必须红。**有意留空**——当前六页全部真跑。
const SKIP_ALLOWED = Object.freeze({
    // 理由：本机 task_pool.db 里 periodic_tasks / periodic_task_runs **两表均为 0 行**（已直连库核实），
    //   页面只渲染"暂无周期任务"空态卡，没有任何徽章可测。这是纯数据依赖，不是接线问题——
    //   静态守卫（verify-badge-alias.js 的 sem 模式断言）已覆盖 PF 的 map/gate/旧类残留，
    //   computed 侧的实测覆盖待生产库或造数后补（S5b 视觉基线重拍时一并了结）。
    //   ⚠️ 这条登记是**有条件的**，两个原因码各有明确失效条件，都不会掩盖真问题：
    //     · EMPTY_TABLE —— 一旦库里有了周期任务，rows>0 就不再走这条；届时若仍抽不到徽章会照常判红。
    //     · NO_BADGE_LEGIT —— 〔H2 收紧〕仅当卡片点得开、且**四条证据同时成立**才发放：
    //         ① 页面含「尚未跑过」空态文案　② 不含「已禁用」字样（该态本应有徽章）
    //         ③ 含「暂无执行历史」空态文案　④ 采集期间零失败请求（无 requestfailed、无 4xx/5xx）
    //       四证据缺任何一条 → 直接判红并列出缺哪条，**不再发放豁免**。
    //       这条收紧针对的正是"渲染坏 / 选择器写错 / 类被误删"——它们同样表现为零徽章，
    //       但四证据必然不齐（要么没有空态文案、要么伴随失败请求），从而被红灯拦住。
    Periodic_Fetch: ['EMPTY_TABLE', 'NO_BADGE_LEGIT'],
});
//   NO_BADGE_LEGIT：容器打开了但零徽章，且该状态在业务上合法（PF：任务从未运行且未禁用 ⇒
//   「上次运行」区显示"尚未跑过"、无历史行、也没有已禁用标）。与 EMPTY_TABLE 分开是为了让报告
//   能区分"库里没对象"和"有对象但没产生过可显示状态"——两者的补测路径不同。
const SKIP_REASON_ALLOWED_CODES = Object.freeze(['EMPTY_TABLE', 'NO_BADGE_LEGIT']);

let pass = 0;
let fail = 0;
const failures = [];
const skips = [];

function check(cond, label, detail) {
    if (cond) { pass++; console.log(`  [OK] ${label}`); }
    else { fail++; failures.push({ label, detail }); console.log(`  [FAIL] ${label}${detail ? ' — ' + detail : ''}`); }
}
function skipped(pageKey, code, label, reason) {
    skips.push({ pageKey, code, label, reason });
    console.log(`  [SKIP:${code}] ${label} — ${reason}`);
}

function hexToRgb(hex) {
    const h = hex.replace('#', '');
    return `rgb(${parseInt(h.substr(0, 2), 16)}, ${parseInt(h.substr(2, 2), 16)}, ${parseInt(h.substr(4, 2), 16)})`;
}

function probeServer() {
    return new Promise((resolve) => {
        const req = http.get({ host: 'localhost', port: PORT, path: '/login.html', timeout: 3000 }, (res) => {
            res.resume();
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
    });
}

function dbGet(db, sql) {
    return new Promise((resolve, reject) => db.get(sql, (e, r) => (e ? reject(e) : resolve(r))));
}

async function signAsAdmin() {
    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
    try {
        const user = await dbGet(db, "SELECT id, username, display_name, role FROM users WHERE role='admin' ORDER BY id ASC LIMIT 1");
        if (!user) throw new Error(`${DB_PATH} 里找不到 admin 用户，无法签发 JWT`);
        return jwt.sign(
            { id: user.id, username: user.username, display_name: user.display_name, role: user.role },
            JWT_SECRET,
            { expiresIn: '2h' }
        );
    } finally {
        db.close();
    }
}

(async function main() {
    console.log('=== 状态徽章统一 S2 · computed style 抽样验收 ===\n');

    if (!JWT_SECRET) {
        console.log('FAIL：.env 里没有 JWT_SECRET，无法签发 token。');
        process.exit(1);
    }
    const up = await probeServer();
    if (!up) {
        console.log(`未探测到 ${BASE_URL} 上的 server。`);
        console.log('本脚本有意不自行 spawn server（端口纪律）——请先手动起好再跑：');
        console.log(`  cd wbs-server && PORT=${PORT} node server.js`);
        process.exit(2);
    }
    console.log(`1. server 探测到（${BASE_URL}）`);

    const token = await signAsAdmin();
    const browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));

    console.log('2. JWT 注入登录（login.html 中继跳转）...');
    await page.goto(`${BASE_URL}/login.html`);
    await page.evaluate((t) => localStorage.setItem('token', t), token);

    for (const pc of PAGES) {
        console.log(`\n--- ${pc.key} ---`);
        // 〔23B·B-M1〕网络健康快照的**监听窗口覆盖「goto → 抽样完成」全程**，try/finally 保证摘除。
        //   原实现只在 openFn 前后挂/摘：首屏 goto 阶段的 4xx/请求失败完全不在快照里，
        //   而"列表压根没加载出来"恰恰发生在那一段——零徽章的四证据第④条因此可能拿着一份
        //   干净的空快照放行真故障。监听器进 finally 摘除，continue/异常都不会漏。
        const ctx = { failedRequests: [], badResponses: [] };
        const onFailed = (req) => ctx.failedRequests.push(req.url());
        const onResp = (res) => { if (res.status() >= 400) ctx.badResponses.push(`${res.status()} ${res.url()}`); };
        page.on('requestfailed', onFailed);
        page.on('response', onResp);
        try {
            await page.goto(`${BASE_URL}/${pc.file}`, { waitUntil: 'networkidle', timeout: 20000 });
            await page.waitForSelector(pc.listSelector, { timeout: 10000 }).catch(() => null);
            await page.waitForTimeout(300);

            // 徽章不在列表上、需要先打开某个容器（如 Model_Center 的详情抽屉）时的前置动作。
            //   打不开就直接判红而不是 SKIP——"点不开"是实现/环境问题，不是数据依赖。
            //   三态返回：true=打开成功；'no-target'=库里根本没有可打开的对象（数据依赖，
            //   交给下游 rows 判定走 EMPTY_TABLE）；false=有对象但打不开（实现/环境问题，判红）。
            if (pc.openFn) {
                // ctx（本页采集期间的网络健康快照）已在页循环开头挂好，供 H2 四证据里的第④条判定
                let opened = false;
                try { opened = await pc.openFn(page, ctx); } catch (e) { opened = false; }

                if (opened && opened.verdict === 'fail') {
                    check(false, `${pc.key}：零徽章时的业务合法态取证`, opened.why);
                    continue;
                }
                if (opened === 'no-badge-legit') {
                    // 容器打开了、但确实一枚徽章都没有，且这是业务上的合法态
                    //   （PF：任务从未运行且未禁用）。与 EMPTY_TABLE 分开记，报告里能看清是哪种缺口。
                    skipped(pc.key, 'NO_BADGE_LEGIT', `${pc.key}：列表徽章抽样`,
                        '容器已打开但零徽章——业务合法态（如周期任务从未运行且未禁用），非接线问题');
                    continue;
                }
                if (opened !== 'no-target') {
                    check(opened === true, `${pc.key}：徽章所在容器可打开（抽屉/展开区）`,
                        opened === true ? '' : '前置打开动作失败——徽章不可达，本页无法验证');
                    if (opened !== true) continue;
                }
            }

            // 抓页面上全部徽章的 computed style + 修饰类 + ::before 色点 + 表体行数
            const probe = await page.evaluate((cfg) => {
                const out = [];
                for (const el of document.querySelectorAll(cfg.badgeSel)) {
                    const cs = getComputedStyle(el);
                    const before = getComputedStyle(el, '::before');
                    out.push({
                        classes: [...el.classList],
                        bg: cs.backgroundColor,
                        fg: cs.color,
                        bd: cs.borderTopColor,
                        bds: cs.borderTopStyle,
                        // B-M9 盒模型：四边 width + style 都取，单看 top 挡不住"只改了左边框"这类
                        bw: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
                        bstyles: [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle],
                        deco: cs.textDecorationLine,
                        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft],
                        // B-M9 伪元素：只比背景色不够——content:none / display:none / 宽高塌成 0
                        //   都会让色点根本不显示，而 backgroundColor 照样报得出值
                        dot: before.backgroundColor,
                        dotContent: before.content,
                        dotDisplay: before.display,
                        dotW: before.width,
                        dotH: before.height,
                        // C-M2：display 之外还有两条独立的"看不见"通道——visibility:hidden 与 opacity:0。
                        //   三者机制不同（不生成盒 / 生成盒但不绘 / 绘了但全透明），任一条都能让色点消失，
                        //   而 backgroundColor、width、height 全都照常报值。
                        //   clip/clip-path/mask/transform 缩放同样能藏，但**登记接受不检**：页面侧无任何
                        //   此类样式源（六页 <style> 与共享层均无 clip/mask/transform 作用于 ::before），
                        //   加进来只增噪音；若将来引入需回来补。
                        dotVisibility: before.visibility,
                        dotOpacity: before.opacity,
                        // S4：旧遗留层用**线性渐变**做底（background-image），此时 backgroundColor
                        //   报 transparent，"旧底色不再命中"那条完全抓不到。故直接断言无背景图。
                        bgImage: cs.backgroundImage,
                        text: (el.textContent || '').trim(),
                        // D4 横向空间〔B12·S4-fix3〕：宿主由**页级登记的选择器**决定（closest 命中），
                        //   通用祖先探测降级为诊断输出。理由：通用探测是启发式（"overflow 非 visible 或
                        //   有宽度约束"），它挑中哪个祖先取决于页面结构，换个布局就换个判定对象——
                        //   拿一个会自己漂移的对象做验收判据，绿了也说明不了什么。登记的选择器是**声明**：
                        //   "这一页的徽章就该待在这个容器里"，容器换了要人来改登记，而不是探测悄悄跟着变。
                        overflow: (() => {
                            const r = el.getBoundingClientRect();
                            const declared = (cfg.hosts || []).map((sel) => el.closest(sel)).filter(Boolean)[0] || null;
                            const measure = (host, reason) => {
                                const hr = host.getBoundingClientRect();
                                return {
                                    hostTag: host.tagName.toLowerCase() + (typeof host.className === 'string' && host.className ? '.' + host.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
                                    hostReason: reason,
                                    badgeOut: r.right > hr.right + 1 || r.left < hr.left - 1,
                                    hostScrollOut: host.scrollWidth - host.clientWidth,
                                };
                            };
                            // 诊断用：通用祖先探测（只打印，不作判据）
                            let probe = null;
                            let anc = el.parentElement;
                            let hops = 0;
                            while (anc && hops < 12 && !probe) {
                                const hs = getComputedStyle(anc);
                                const clips = hs.overflowX !== 'visible' || hs.overflowY !== 'visible';
                                const hasExplicitWidth = hs.display === 'table-cell'
                                    || (hs.maxWidth && hs.maxWidth !== 'none')
                                    || (hs.flexBasis && hs.flexBasis !== 'auto' && hs.flexBasis !== 'content');
                                if (clips || hasExplicitWidth) probe = anc.tagName.toLowerCase() + (typeof anc.className === 'string' && anc.className ? '.' + anc.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
                                anc = anc.parentElement;
                                hops++;
                            }
                            if (!declared) {
                                return { hostTag: '(登记宿主未命中)', hostReason: 'missing-declared-host', badgeOut: false, hostScrollOut: 0, probeHost: probe, declaredMissing: true, clippedBy: [], transformSkipped: [] };
                            }
                            // 〔S4-fix4·B12〕登记宿主装得下，不等于路上没被切。
                            //   徽章与宿主之间任何一层 overflow 是 hidden/clip/scroll/auto 的祖先，
                            //   只要它的矩形没完整包住徽章，用户看到的就是被裁掉一截的徽章 ——
                            //   而只比"宿主边缘"的话，这一整类中间裁剪完全测不到。
                            const clippedBy = [];
                            const transformSkipped = [];
                            let mid = el.parentElement;
                            let guard = 0;
                            while (mid && mid !== declared && guard < 20) {
                                const ms = getComputedStyle(mid);
                                const clipsX = /^(hidden|clip|scroll|auto)$/.test(ms.overflowX);
                                const clipsY = /^(hidden|clip|scroll|auto)$/.test(ms.overflowY);
                                // 〔S4-fix6〕祖先带 transform / zoom 时，裁剪几何不再等于布局矩形
                                //   （变换后的可视区与 clientLeft/clientWidth 那套推导对不上）。本判定**不支持**
                                //   这种情形，故只输出诊断、不判红 —— 明示"这里没测"，好过用一条错的边界
                                //   算出一个像模像样的结论。兜底＝S5b 视觉基线重拍的像素差。
                                const transformed = (ms.transform && ms.transform !== 'none')
                                    || (ms.zoom && ms.zoom !== '1' && ms.zoom !== 'normal');
                                if ((clipsX || clipsY) && transformed) {
                                    transformSkipped.push(mid.tagName.toLowerCase() + `(transform=${ms.transform}/zoom=${ms.zoom})`);
                                    mid = mid.parentElement;
                                    guard++;
                                    continue;
                                }
                                if (clipsX || clipsY) {
                                    // 〔S4-fix5·B12-M〕比的是**内侧裁剪区**，不是 border-box。
                                    //   getBoundingClientRect() 含 border（还含滚动条槽），拿它当裁剪边界会偏大：
                                    //   徽章其实已经被边框/滚动条切掉一截，却因为还在 border-box 内而被判"没越界"。
                                    //   内侧区 = rect 左上 + clientLeft/clientTop（border 宽），尺寸取 clientWidth/clientHeight。
                                    const mr = mid.getBoundingClientRect();
                                    const inLeft = mr.left + mid.clientLeft;
                                    const inTop = mr.top + mid.clientTop;
                                    const inRight = inLeft + mid.clientWidth;
                                    const inBottom = inTop + mid.clientHeight;
                                    const contains = r.left >= inLeft - 1 && r.right <= inRight + 1
                                        && r.top >= inTop - 1 && r.bottom <= inBottom + 1;
                                    if (!contains) {
                                        clippedBy.push(mid.tagName.toLowerCase()
                                            + (typeof mid.className === 'string' && mid.className ? '.' + mid.className.trim().split(/\s+/).slice(0, 2).join('.') : '')
                                            + `(overflow=${ms.overflowX}/${ms.overflowY})`);
                                    }
                                }
                                mid = mid.parentElement;
                                guard++;
                            }
                            return Object.assign(measure(declared, 'declared'), { probeHost: probe, declaredMissing: false, clippedBy, transformSkipped });
                        })(),
                    });
                }
                return {
                    samples: out,
                    rows: document.querySelectorAll(cfg.listSel).length,
                    // 页面级横向溢出（D4 验收项：色点+描边让徽章增宽 ~10px，不该把页面撑出横向滚动条）
                    docOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                };
            }, { badgeSel: pc.badgeSelector, listSel: pc.listSelector, hosts: pc.overflowHosts || [] });

            const samples = probe.samples;

            // B-M10：SKIP 只有"表体真无行"一种合法原因；有行却抽不到徽章 = 选择器错/页面变了 → 红
            if (!samples.length) {
                if (probe.rows === 0) {
                    skipped(pc.key, 'EMPTY_TABLE', `${pc.key}：列表徽章抽样`, `表体 0 行（库内该模块无数据）`);
                } else {
                    check(false, `${pc.key}：列表有 ${probe.rows} 行却抽不到徽章`,
                        `选择器 \`${pc.badgeSelector}\` 命中 0 个元素——有数据却抽不到，是选择器写错或 DOM 结构变了，不是数据依赖`);
                }
                continue;
            }

            // B-H8 全类覆盖：把页面上出现的修饰类全收集起来
            const presentMods = new Set();
            const unknownMods = new Set();
            for (const s of samples) {
                const mods = s.classes.filter((c) => c !== 'u-status-badge');
                if (!mods.length) { unknownMods.add('(无修饰类)'); continue; }
                for (const m of mods) {
                    if (Object.prototype.hasOwnProperty.call(pc.classToTier, m)) presentMods.add(m);
                    else unknownMods.add(m);
                }
            }

            // 未登记修饰类 = 红（页面渲染出了配置表不认识的东西，可能是漏接线也可能是配置过期）
            check(unknownMods.size === 0, `${pc.key}：页面上无未登记的徽章修饰类`,
                unknownMods.size ? `${unknownMods.size} 个未登记：${[...unknownMods].join(' | ')} —— 要么页面新增了状态没接线，要么 classToTier 配置过期` : '');

            const registered = Object.keys(pc.classToTier);
            const uncovered = registered.filter((m) => !presentMods.has(m));
            console.log(`  覆盖 ${presentMods.size}/${registered.length} 类（页面共 ${samples.length} 个徽章，${probe.rows} 行）`);
            console.log(`    已覆盖：${[...presentMods].join(' ') || '(无)'}`);
            if (uncovered.length) console.log(`    未覆盖（库中无此状态数据·不判红）：${uncovered.join(' ')}`);

            // B-H8：**每个已登记且页面上存在的类**各抽 1 个样本跑全套断言（不再只测第一个）
            for (const mod of presentMods) {
                const s = samples.find((x) => x.classes.includes(mod));
                const tier = pc.classToTier[mod];
                const want = SEM[tier];
                const wantDeco = want.deco;

                check(s.bg === hexToRgb(want.bg), `${pc.key}.${mod}：background = ${want.bg}（${tier} 层）`, `实际 ${s.bg}`);
                check(s.fg === hexToRgb(want.fg), `${pc.key}.${mod}：color = ${want.fg}`, `实际 ${s.fg}`);
                check(s.bd === hexToRgb(want.bd), `${pc.key}.${mod}：border-color = ${want.bd}`, `实际 ${s.bd}`);
                check(s.bstyles.every((v) => v === want.bds), `${pc.key}.${mod}：border-style 四边均为 ${want.bds}`, `实际 ${s.bstyles.join('/')}`);
                check(s.bw.every((v) => v === '1px'), `${pc.key}.${mod}：border-width 四边均 1px`, `实际 ${s.bw.join('/')}`);
                check(s.padding.join(' ') === '2px 9px 2px 9px', `${pc.key}.${mod}：padding 四边 = 2px 9px 2px 9px`, `实际 ${s.padding.join(' ')}`);
                check(s.deco.includes(wantDeco) || (wantDeco === 'none' && (s.deco === 'none' || s.deco === '')),
                    `${pc.key}.${mod}：text-decoration-line = ${wantDeco}`, `实际 ${s.deco}`);
                // 色点四问：色 + content 非 none + display 非 none + 宽高 6px
                check(s.dot === hexToRgb(want.dot), `${pc.key}.${mod}：色点背景 = ${want.dot}`, `实际 ${s.dot}`);
                const dotVisible = s.dotContent !== 'none' && s.dotDisplay !== 'none'
                    && s.dotW === '6px' && s.dotH === '6px'
                    && s.dotVisibility !== 'hidden' && parseFloat(s.dotOpacity) > 0;
                check(dotVisible,
                    `${pc.key}.${mod}：色点真实可见（content≠none·display≠none·6×6px·visibility≠hidden·opacity>0）`,
                    `content=${s.dotContent} display=${s.dotDisplay} w=${s.dotW} h=${s.dotH} visibility=${s.dotVisibility} opacity=${s.dotOpacity} —— 只比背景色的话，色点被 content:none / display:none / 塌成 0 尺寸 / visibility:hidden / opacity:0 藏起来时照样"通过"`);
            }

            // HIGH-1 回归防线：base 的 ::before 已经画了色点，文案里再拼一个 ● 就是双点。
            //   Model_Center 曾有 `text: '● ' + stText`，S3-fix 已去掉；这条断言把它钉住防回归。
            //   对全部页统一生效（任何页在文案里塞圆点字符都是同一个错）。
            const dotChars = samples.filter((x) => /[●○•·]/.test(x.text));
            check(dotChars.length === 0, `${pc.key}：徽章文案不含圆点字符（●/○/•/·）——色点由 ::before 提供`,
                dotChars.length
                    ? `${dotChars.length} 个徽章文案带圆点：${[...new Set(dotChars.map((x) => JSON.stringify(x.text)))].slice(0, 4).join(' | ')} —— 与 base 的 ::before 色点叠成双点`
                    : '');

            // 反向：旧 direct 底色不得在**任何**徽章上命中（防双存/漏改）
            const stillLegacy = samples.filter((x) => pc.legacyDirect.includes(x.bg));
            check(stillLegacy.length === 0, `${pc.key}：全部 ${samples.length} 个徽章均不再命中旧 direct 底色`,
                stillLegacy.length ? `${stillLegacy.length} 个仍是旧色：${[...new Set(stillLegacy.map((x) => x.bg + ' @ .' + x.classes.join('.')))].join(' | ')}` : '');

            // 反向之二（S4）：徽章不得有 background-image。旧遗留层的渐变底就藏在这里，
            //   而 backgroundColor 对渐变报 transparent —— 只查底色的话，一个原样保留的
            //   `.badge-open` 渐变规则可以一路绿到底。
            const gradientLeft = samples.filter((x) => x.bgImage && x.bgImage !== 'none');
            check(gradientLeft.length === 0, `${pc.key}：全部徽章无 background-image（旧渐变层零残留）`,
                gradientLeft.length ? `${gradientLeft.length} 个仍带背景图：${[...new Set(gradientLeft.map((x) => x.bgImage.slice(0, 60) + ' @ .' + x.classes.join('.')))].join(' | ')}` : '');

            // D4 横向空间验收（方案 §3 D4）：只对显式开启的页面跑，避免把别处的历史布局问题
            //   当成本次改动的回归。两项：徽章不越出容器 + 页面无横向溢出。
            if (pc.checkOverflow) {
                const noHost = samples.filter((x) => x.overflow && x.overflow.declaredMissing);
                check(noHost.length === 0, `${pc.key}：每个徽章都落在**登记的宿主容器**内（${(pc.overflowHosts || []).join(' / ')}）`,
                    noHost.length ? `${noHost.length} 个徽章的祖先里找不到任何登记宿主 —— 要么 DOM 结构变了，要么登记表过期，两种都得人来看（通用探测给的参考：${[...new Set(noHost.map((x) => x.overflow.probeHost || '无'))].join(' | ')}）` : '');
                const midClipped = samples.filter((x) => x.overflow && (x.overflow.clippedBy || []).length);
                // ⚠️ 断言口径 = **轴对齐矩形**裁剪。border-radius 造成的圆角裁剪**不保证覆盖**：
                //   圆角只切掉四角的一小块，矩形包含判定看不出来。登记接受——徽章是胶囊形（radius 12px）
                //   本就贴着圆角设计，真出问题会在 S5b 视觉基线重拍时以像素差的形式暴露。
                check(midClipped.length === 0, `${pc.key}：徽章到登记宿主之间无中间祖先做**轴对齐矩形**裁剪（D4·B12·圆角裁剪不保证）`,
                    midClipped.length ? `${midClipped.length} 个被中间层裁剪：${[...new Set(midClipped.map((x) => `.${x.classes.join('.')}「${x.text}」← ${x.overflow.clippedBy.join(' / ')}`))].join(' | ')}` : '');
                const clipped = samples.filter((x) => x.overflow && (x.overflow.badgeOut || x.overflow.hostScrollOut > 1));
                const hostsSeen = [...new Set(samples.map((x) => `${x.overflow.hostTag}(${x.overflow.hostReason})`))];
                const tSkipped = [...new Set(samples.flatMap((x) => (x.overflow.transformSkipped || [])))];
                if (tSkipped.length) {
                    console.log(`  [INFO] D4 跳过 ${tSkipped.length} 个带 transform/zoom 的裁剪祖先（几何不支持·只诊断不判红）：${tSkipped.join(' | ')}`);
                }
                const probesSeen = [...new Set(samples.map((x) => x.overflow.probeHost || '无'))];
                console.log(`  D4 宿主判定（登记）：${hostsSeen.join(' | ')}　｜通用探测（仅诊断）：${probesSeen.join(' | ')}`);
                check(clipped.length === 0, `${pc.key}：徽章未越出**首个有约束的祖先**，且该祖先无内容溢出（D4 横向空间）`,
                    clipped.length
                        ? `${clipped.length} 个越界：${[...new Set(clipped.map((x) => `.${x.classes.join('.')}「${x.text}」@ ${x.overflow.hostTag}(${x.overflow.hostReason})·越出=${x.overflow.badgeOut}·宿主溢出=${x.overflow.hostScrollOut}px`))].join(' | ')} —— 色点+描边让徽章增宽约 10px，需调列宽/容器而不是砍徽章`
                        : '');
                check(probe.docOverflowPx <= 0, `${pc.key}：页面无横向溢出（D4）`,
                    `document 横向溢出 ${probe.docOverflowPx}px`);
            }
        } catch (err) {
            check(false, `${pc.key}：页面可加载并抽样`, err.message);
        } finally {
            page.off('requestfailed', onFailed);
            page.off('response', onResp);
        }
    }

    console.log('\n--- 收尾断言 ---');

    // 〔B13〕跨脚本一致性：本 harness 的 classToTier 与静态守卫 spec 的映射必须对得上。
    //   两份表分别住在两个脚本里，各自演进的话会出现"守卫按 A 判、harness 按 B 测"，
    //   两边都绿而实际映射早就分叉了。这里以 verify-badge-alias.js 的 PAGE_ALIAS_SPECS 为源做互校。
    try {
        const { PAGE_ALIAS_SPECS } = require('./verify-badge-alias.js');
        const diffs = [];
        // 〔B13·S4-fix3〕先做**页集合双向相等**：只逐页比映射的话，
        //   一边悄悄加了页（或删了页）另一边不知道，两边各自全绿而覆盖面早就对不上了。
        // 〔S4-fix4·B13〕先各自查唯一性再比集合：两边都用 Set 比的话，
        //   一侧混进重复 file（复制粘贴 spec 时最常见）会被 Set 悄悄吞掉，集合照样相等。
        const specFileList = PAGE_ALIAS_SPECS.map((x) => x.file);
        const pageFileList = PAGES.map((x) => x.file);
        const dupOf = (arr) => [...new Set(arr.filter((f, i) => arr.indexOf(f) !== i))];
        const dupSpec = dupOf(specFileList);
        const dupPage = dupOf(pageFileList);
        check(dupSpec.length === 0 && dupPage.length === 0,
            `两侧页清单内部无重复 file（spec ${specFileList.length} 项 / harness ${pageFileList.length} 项）`,
            [
                dupSpec.length ? `PAGE_ALIAS_SPECS 重复：${dupSpec.join(' | ')}` : '',
                dupPage.length ? `PAGES 重复：${dupPage.join(' | ')}` : '',
            ].filter(Boolean).join('；') + ' —— 重复项会让"逐页断言"对同一页跑两遍，而另一页悄悄没人管');
        const specFiles = new Set(specFileList);
        const pageFiles = new Set(pageFileList);
        const onlySpec = [...specFiles].filter((f) => !pageFiles.has(f));
        const onlyHarness = [...pageFiles].filter((f) => !specFiles.has(f));
        check(onlySpec.length === 0 && onlyHarness.length === 0,
            `静态守卫 spec 页集合与 computed harness 页集合双向相等（各 ${specFiles.size} / ${pageFiles.size} 页）`,
            [
                onlySpec.length ? `只在守卫里有、harness 没测：${onlySpec.join(' | ')}` : '',
                onlyHarness.length ? `只在 harness 里有、守卫没管：${onlyHarness.join(' | ')}` : '',
            ].filter(Boolean).join('；'));
        for (const pc of PAGES) {
            const spec = PAGE_ALIAS_SPECS.find((s) => s.file === pc.file);
            if (!spec) { diffs.push(`${pc.key}：静态守卫里找不到同名 spec`); continue; }
            const expected = spec.mode === 'sem'
                // sem 模式：修饰类就是 sem-<层>，层名即类名去前缀
                ? Object.fromEntries(Object.values(spec.expectStatuses).map((c) => [c, c.replace(/^sem-/, '')]))
                // 别名模式：修饰类 = selector 去掉根类前缀，层名取 spec.tiers
                : Object.fromEntries(Object.keys(spec.tiers).map((k) => [
                    spec.selector(k).replace(/^\.u-status-badge\./, '').replace(/^\./, ''), spec.tiers[k],
                ]));
            for (const [cls, tier] of Object.entries(expected)) {
                if (!(cls in pc.classToTier)) diffs.push(`${pc.key}.classToTier 缺 ${cls}`);
                else if (pc.classToTier[cls] !== tier) diffs.push(`${pc.key}.classToTier['${cls}']=${pc.classToTier[cls]}（spec 为 ${tier}）`);
            }
            for (const cls of Object.keys(pc.classToTier)) {
                if (!(cls in expected)) diffs.push(`${pc.key}.classToTier 多出 ${cls}（spec 里没有）`);
            }
        }
        check(diffs.length === 0, `harness 的 classToTier 与静态守卫 PAGE_ALIAS_SPECS 逐条一致（${PAGES.length} 页）`,
            diffs.length ? `${diffs.length} 处分叉：${diffs.slice(0, 6).join('；')}${diffs.length > 6 ? ' …' : ''} —— 两份表必须同步改，否则守卫与实测各测各的` : '');
    } catch (e) {
        check(false, 'harness 的 classToTier 与静态守卫 PAGE_ALIAS_SPECS 逐条一致', `无法加载 verify-badge-alias.js：${e.message}`);
    }

    // SKIP 治理（H-1）：SKIP 是"没验到"不是"验过了"。未在 SKIP_ALLOWED 登记的一律红灯。
    const unregistered = skips.filter((s) => {
        const codes = SKIP_ALLOWED[s.pageKey];
        return !Array.isArray(codes) || !codes.includes(s.code);
    });
    check(unregistered.length === 0, `${PAGES.length} 页均有实测覆盖（未登记原因码的 SKIP 一律判失败）`,
        unregistered.length
            ? `${unregistered.length} 处未登记：${unregistered.map((s) => `${s.pageKey}[${s.code}]（${s.reason}）`).join('；')}`
            : '');
    const badCode = skips.filter((s) => !SKIP_REASON_ALLOWED_CODES.includes(s.code));
    check(badCode.length === 0, `SKIP 原因码均在允许集合内（${SKIP_REASON_ALLOWED_CODES.join('/')}）`,
        badCode.length ? `${badCode.length} 处非法原因码：${badCode.map((s) => `${s.pageKey}[${s.code}]`).join('；')} —— 只有"表体真无行"算数据依赖，其余都是实现/配置问题` : '');
    for (const s of skips.filter((x) => !unregistered.includes(x))) {
        console.log(`  [已登记 SKIP] ${s.pageKey}[${s.code}]`);
    }

    check(consoleErrors.length === 0, `${PAGES.length} 页浏览全程无 console error`,
        consoleErrors.length ? `${consoleErrors.length} 条：${consoleErrors.slice(0, 3).join(' | ')}` : '');

    await browser.close();

    console.log(`\n=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 / ${skips.length} 项跳过（其中未登记 ${unregistered.length}）===`);
    if (fail > 0) {
        console.log('\n失败明细：');
        failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
    }
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('脚本异常：', e);
    process.exit(1);
});
