/**
 * v1.74.0 C5 — 列表筛选 + webhook 适配 冒烟 e2e（方案 §2.5 T5 / §2.6 T8）
 *
 * 用法：node scripts/test-issue-c5-smoke.js（入口 ready() 自起隔离实例，或核对批跑器给的 TEST_* 变量组，四个必须同时给）
 * 复用 _test-fixture signAs（admin=1）+ apiCall（JSON）；webhook 走 x-webhook-secret header（非 JWT）。
 *
 * 用例：
 *   F1  requester_dept 筛选（精确匹配，不混入其他部门）
 *   F2  data_domain 筛选（v1.1 §4.5 报表按域预过滤）
 *   F3  search 参数仍可用（M-6 保留 search 命名，命中 title/description/related_table）
 *   F4  sort=progress 不报 500（C5 bug 修复：删死引用 progress，回落默认排序）
 *   F5  type/status/priority 组合筛选
 *   W1  webhook 创建调度异常 → 200 + NOT NULL 适配（requester_dept='系统自动' requester_name='FDL系统'）
 *   W2  webhook 落 issue_status_history 首行（from=NULL, to=待处理, operator=0/FDL系统）
 *   W3  webhook run_id 去重（同 run_id 第二次 → 返已存在 id 不重复创建）
 *   W4  webhook 不同 run_id 各自独立创建（L-3）
 *   W5  webhook 无效 secret → 401
 *   W6  webhook 缺 table_name+node_name → 400
 *   W7  系统自动工单可被 requester_dept='系统自动' 筛出（与 F1 闭环）
 *   W8-W10 run_id LIKE 转义 / 非法 body 归一 / secret 先于 schema 守卫（codex M-1 / M-2 / M-3）
 *
 * [#106 S4c-B] 迁移到 test-env 隔离实例后的口径（锚点 §9 #9，沿用 verify-h0-metadata-e2e.js 的 SKIP 先例）：
 *   · F1–F8（列表筛选 / 排序，共 8 条）照常执行。
 *   · W0（前提断言，1 条，计入 PASS / FAIL）：发合法 body + 空 x-webhook-secret 头，必须 503 且实例库没有按 run_id 标记新建的工单
 *     （「未配置即 503、空密钥头不放行」，server.js:14183-14186，是隔离实例上唯一能测的 webhook 安全性质）。
 *   · W1–W10（共 10 条 webhook 用例）显式 SKIP：W0 通过才记 SKIP（不计入通过数，汇总行单列 SKIP 数）；W0 不通过则 W1–W10 各计失败（用例体仍不执行）。
 *     原因：隔离实例的 WEBHOOK_SECRET 恒为空（test-instance 启动器有意置空），webhook 入口一律 503，这 10 条在隔离实例上无法成立；
 *     需要真实 webhook 核对时人工处理。用例体保留在下面的 WEBHOOK_CASES（不执行），只作断言职责记录。
 *   · SKIP 数大于 0 不改变退出码：退出码按 F 段 + W0 的失败数判定（W0 失败时 W1–W10 也计失败）。
 */
'use strict';
const fx = require('./_test-fixture');

// [#106 S4c-B] 实例库来自 test-env：fx.DB_PATH 在 ready() 之前读会抛 FX_NOT_READY，故改为 ready() 之后在入口里赋值，不再指向业务库 task_pool.db。
//   原 `process.env.WEBHOOK_SECRET` 一行已删：隔离实例里 webhook 密钥恒为空，脚本也不再读真实环境变量。
let DB_PATH = null;

// 以下两个 helper：等 close 回调再落定，关库错误不丢，resolve 时句柄已关闭（语句错误优先）
async function dbGet(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => { db.get(sql, params, (e, r) => { db.close((ce) => { const err = e || ce; err ? reject(err) : resolve(r); }); }); });
}
async function dbAll(sql, params) {
    const db = await fx.openInstanceDb(DB_PATH);
    return new Promise((resolve, reject) => { db.all(sql, params, (e, r) => { db.close((ce) => { const err = e || ce; err ? reject(err) : resolve(r); }); }); });
}
let pass = 0, fail = 0, skip = 0;
async function check(name, fn) { try { await fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
// 显式 SKIP：不执行用例体、不计入通过数，汇总行单列
function skipCase(name) { skip++; console.log(`  SKIP ${name}：隔离实例 WEBHOOK_SECRET 恒为空，webhook 入口一律 503，需真实 webhook 环境人工核对`); }
function must(cond, msg) { if (!cond) throw new Error(msg); }

const VALID = { title: 'C5 筛选需求', type: '数据质量', requester_dept: '市场营销部', requester_name: '张三', description: 'x' };

async function createIssue(token, overrides) {
    const r = await fx.apiCall('POST', '/api/issues', token, { ...VALID, ...overrides });
    if (r.status !== 200) throw new Error('创建失败 ' + JSON.stringify(r.body));
    return r.body.id;
}
async function listIssues(token, query) {
    const qs = new URLSearchParams(query).toString();
    return fx.apiCall('GET', `/api/issues?${qs}`, token);
}
// webhook 走 x-webhook-secret（非 JWT）。W1–W10 现为显式 SKIP（见文件头），本 helper 仅供 WEBHOOK_CASES 保留的用例体引用，当前不被执行；
//   原默认密钥取自 process.env.WEBHOOK_SECRET，已随迁移删除（隔离实例密钥恒为空），恢复这些用例时需在真实 webhook 环境另行提供。
async function webhook(body, secret) {
    const r = await fetch(`${fx.BASE}/api/issues/webhook/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret ?? '' },
        body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

const created = [];   // 普通工单（API 删）
const webhookIds = []; // webhook 工单（API 删，admin 有权）
// [#106 S4c 送审前小修] 清理模块级 created / webhookIds：逐个 try/catch 并核对状态码（200 / 404 才算清掉），清掉的才移出两个追踪数组；两轮之间等 200ms；返回仍遗留的编号。
//   main 末尾调用一次；main 中途抛错（如造数第 2 张单失败）时由入口 finally 对剩余编号再调用一次。
async function cleanupIssues(adminToken) {
    for (let round = 0; round < 2 && (created.length + webhookIds.length) > 0; round++) {
        if (round > 0) await new Promise((r) => setTimeout(r, 200));   // 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
        for (const arr of [created, webhookIds]) {
            for (const id of arr.slice()) {
                try {
                    const r = await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);
                    if (r.status === 200 || r.status === 404) arr.splice(arr.indexOf(id), 1);
                    else console.log(`  清理 #${id} 失败（第 ${round + 1} 轮）：HTTP ${r.status} ${JSON.stringify(r.body)}`);
                } catch (e) { console.log(`  清理 #${id} 异常（第 ${round + 1} 轮）：${e.message}`); }
            }
        }
    }
    return [...created, ...webhookIds];
}
async function main() {
    const adminToken = await fx.signAs(fx.ADMIN_ID);
    console.log('\n══════ v1.74.0 C5 列表筛选 + webhook 适配冒烟 ══════');

    // 造测试数据：不同部门 + 不同 data_domain
    const idMkt = await createIssue(adminToken, { requester_dept: '市场营销部', data_domain: '合同', title: 'C5市场合同需求' }); created.push(idMkt);
    const idFin = await createIssue(adminToken, { requester_dept: '财务管理部', data_domain: '客户', title: 'C5财务客户需求' }); created.push(idFin);
    const idSearch = await createIssue(adminToken, { requester_dept: '市场营销部', title: 'C5特殊关键词UNIQUEKW需求', related_table: 'dwd_special_kw' }); created.push(idSearch);

    await check('F1 requester_dept 筛选（精确，不混其他部门）', async () => {
        const r = await listIssues(adminToken, { requester_dept: '财务管理部' });
        must(r.status === 200, `HTTP ${r.status}`);
        must(r.body.every(i => i.requester_dept === '财务管理部'), '应只含财务管理部');
        must(r.body.some(i => i.id === idFin), '应含财务测试单');
        must(!r.body.some(i => i.id === idMkt), '不应含市场测试单');
    });

    await check('F2 data_domain 筛选（v1.1 报表按域预过滤）', async () => {
        const r = await listIssues(adminToken, { data_domain: '合同' });
        must(r.status === 200, `HTTP ${r.status}`);
        must(r.body.some(i => i.id === idMkt), '应含合同域测试单');
        must(r.body.every(i => i.data_domain === '合同'), '应只含合同域');
    });

    await check('F3 search 参数仍可用（M-6 保留命名，命中 title/related_table）', async () => {
        const r1 = await listIssues(adminToken, { search: 'UNIQUEKW' });
        must(r1.status === 200 && r1.body.some(i => i.id === idSearch), 'search 命中 title');
        const r2 = await listIssues(adminToken, { search: 'dwd_special_kw' });
        must(r2.body.some(i => i.id === idSearch), 'search 命中 related_table');
    });

    await check('F4 sort=progress 不报 500（C5 bug 修复：死引用删除回落默认）', async () => {
        const r = await listIssues(adminToken, { sort: 'progress' });
        must(r.status === 200, `progress 排序不应 500，HTTP ${r.status} ${JSON.stringify(r.body)}`);
        must(Array.isArray(r.body), '应返回数组');
    });

    await check('F5 type/status/priority 组合筛选', async () => {
        const r = await listIssues(adminToken, { type: '数据质量', status: '待处理', priority: 'P2' });
        must(r.status === 200, `HTTP ${r.status}`);
        must(r.body.every(i => i.type === '数据质量' && i.status === '待处理' && i.priority === 'P2'), '组合筛选应全满足');
    });

    // ════════ C7 补漏：T5 CASE 业务排序 + search description 分支 ════════
    await check('F6 sort=priority → 业务序 P0→P1→P3（CASE 排序 + 升降序反转）', async () => {
        // priority 枚举 P0-P3 字典序与 CASE 序恰好同序，故本用例验"CASE 排序生效（结果正确 + ASC/DESC 反转）"，
        // 真正证伪"误用字典序"的是 F7（status 字典序 ≠ 业务序）。
        const tag = `SORTPRI${Date.now()}`;
        const idP3 = await createIssue(adminToken, { title: tag, priority: 'P3' }); created.push(idP3);
        const idP0 = await createIssue(adminToken, { title: tag, priority: 'P0' }); created.push(idP0);
        const idP1 = await createIssue(adminToken, { title: tag, priority: 'P1' }); created.push(idP1);
        const r = await listIssues(adminToken, { search: tag, sort: 'priority', order: 'ASC' });
        must(r.status === 200, `HTTP ${r.status}`);
        const mine = r.body.filter(i => [idP0, idP1, idP3].includes(i.id));
        must(mine.length === 3, `应含 3 单，实际 ${mine.length}`);
        must(mine[0].priority === 'P0' && mine[1].priority === 'P1' && mine[2].priority === 'P3',
            `ASC 应 P0→P1→P3，实际 ${mine.map(i => i.priority).join('→')}`);
        const rDesc = await listIssues(adminToken, { search: tag, sort: 'priority', order: 'DESC' });
        const mineDesc = rDesc.body.filter(i => [idP0, idP1, idP3].includes(i.id));
        must(mineDesc[0].priority === 'P3' && mineDesc[2].priority === 'P0', `DESC 应 P3→...→P0，实际 ${mineDesc.map(i => i.priority).join('→')}`);
    });

    await check('F7 sort=status → CASE 业务序 待处理→处理中→待验证（证伪字典序）', async () => {
        // 关键：status 中文字典序（Unicode 码点）≠ 业务优先级序，唯有 CASE 0/1/2/3 才能保证业务序。
        // 造 待处理/处理中/待验证 三态，验 ASC 严格得 待处理→处理中→待验证（若误用字典序则顺序会乱）。
        const tag = `SORTST${Date.now()}`;
        const idA = await createIssue(adminToken, { title: tag }); created.push(idA); // 待处理
        const idB = await createIssue(adminToken, { title: tag }); created.push(idB);
        const idC = await createIssue(adminToken, { title: tag }); created.push(idC);
        // 推进 idB→处理中，idC→处理中→待验证
        await fx.apiCall('PUT', `/api/issues/${idB}/status`, adminToken, { status: '处理中' });
        await fx.apiCall('PUT', `/api/issues/${idC}/status`, adminToken, { status: '处理中' });
        await fx.apiCall('PUT', `/api/issues/${idC}/status`, adminToken, { status: '待验证' });
        const r = await listIssues(adminToken, { search: tag, sort: 'status', order: 'ASC' });
        const mine = r.body.filter(i => [idA, idB, idC].includes(i.id));
        must(mine.length === 3, `应含 3 单，实际 ${mine.length}`);
        must(mine[0].status === '待处理' && mine[1].status === '处理中' && mine[2].status === '待验证',
            `ASC 业务序应 待处理→处理中→待验证，实际 ${mine.map(i => i.status).join('→')}`);
    });

    await check('F8 search 命中 description 分支（c5 原只测 title/related_table）', async () => {
        const kw = `DESCKW${Date.now()}`;
        const id = await createIssue(adminToken, { title: 'C5描述搜索测试', description: `详细描述含 ${kw} 关键词` }); created.push(id);
        const r = await listIssues(adminToken, { search: kw });
        must(r.status === 200, `HTTP ${r.status}`);
        must(r.body.some(i => i.id === id), `search 应命中 description 分支，未找到 id=${id}`);
    });

    // [#106 S4c-B] W1–W10 显式 SKIP（锚点 §9 #9）：用例体保留在数组里但不执行；原因与条数见文件头。
    const WEBHOOK_CASES = [
        { name: 'W1 webhook 创建调度异常 → 200 + NOT NULL 适配（系统自动/FDL系统）', fn: async () => {
            const r = await webhook({ table_name: 'ods_test_c5', error_message: 'C5 测试调度失败', run_id: `C5RUN_${Date.now()}_W1` });
            must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
            webhookIds.push(r.body.id);
            const issue = await dbGet('SELECT requester_dept, requester_name, source, type, priority FROM issues WHERE id=?', [r.body.id]);
            must(issue.requester_dept === '系统自动', `requester_dept 应=系统自动，实际 ${issue.requester_dept}`);
            must(issue.requester_name === 'FDL系统', `requester_name 应=FDL系统，实际 ${issue.requester_name}`);
            must(issue.source === 'FDL自动' && issue.type === '调度异常', 'source/type 正确');
        } },

        { name: 'W2 webhook 落 issue_status_history 首行（from=NULL, to=待处理, FDL系统）', fn: async () => {
            const id = webhookIds[0];
            const hist = await dbAll('SELECT * FROM issue_status_history WHERE issue_id=?', [id]);
            must(hist.length === 1, `应落 1 行首行，实际 ${hist.length}`);
            must(hist[0].from_status === null && hist[0].to_status === '待处理', `首行 NULL→待处理，实际 ${hist[0].from_status}→${hist[0].to_status}`);
            must(Number(hist[0].operator_id) === 0 && hist[0].operator_name === 'FDL系统', `operator 应 0/FDL系统，实际 ${hist[0].operator_id}/${hist[0].operator_name}`);
        } },

        { name: 'W3 webhook run_id 去重（同 run_id 第二次返已存在 id）', fn: async () => {
            const runId = `C5RUN_${Date.now()}_W3`;
            const r1 = await webhook({ table_name: 'ods_dup', error_message: 'first', run_id: runId });
            must(r1.status === 200 && r1.body.id, `首次 HTTP ${r1.status}`);
            webhookIds.push(r1.body.id);
            const r2 = await webhook({ table_name: 'ods_dup', error_message: 'second', run_id: runId });
            must(r2.status === 200 && r2.body.id === r1.body.id, `同 run_id 应返同 id，r1=${r1.body.id} r2=${r2.body.id}`);
            must(r2.body.message && r2.body.message.includes('跳过'), '应标"已存在跳过"');
        } },

        { name: 'W4 webhook 不同 run_id 各自独立创建（L-3）', fn: async () => {
            const r1 = await webhook({ table_name: 'ods_a', run_id: `C5RUN_${Date.now()}_W4A` });
            const r2 = await webhook({ table_name: 'ods_b', run_id: `C5RUN_${Date.now()}_W4B` });
            must(r1.body.id !== r2.body.id, '不同 run_id 应各自创建不同 id');
            webhookIds.push(r1.body.id, r2.body.id);
        } },

        { name: 'W5 webhook 无效 secret → 401', fn: async () => {
            const r = await webhook({ table_name: 'ods_x' }, 'wrong_secret');
            must(r.status === 401, `HTTP ${r.status}`);
        } },

        { name: 'W6 webhook 缺 table_name+node_name → 400', fn: async () => {
            const r = await webhook({ error_message: 'no target' });
            must(r.status === 400, `HTTP ${r.status}`);
        } },

        { name: 'W7 系统自动工单可按 requester_dept=系统自动 筛出（与 F1 闭环）', fn: async () => {
            const r = await listIssues(adminToken, { requester_dept: '系统自动' });
            must(r.status === 200, `HTTP ${r.status}`);
            must(r.body.some(i => webhookIds.includes(i.id)), '应筛出 webhook 工单');
            must(r.body.every(i => i.requester_dept === '系统自动'), '应只含系统自动');
        } },

        { name: 'W8 codex M-1：run_id 含 % 通配符不误判已存在（LIKE 转义）', fn: async () => {
            // 两个 run_id：'C5PCT_50%_A' 与 'C5PCT_50X_A'——未转义时 '50%' 的 % 会匹配 '50X'，转义后各自独立
            const tag = `C5PCT_${Date.now()}`;
            const r1 = await webhook({ table_name: 'ods_pct', run_id: `${tag}_50%_A` });
            must(r1.status === 200 && r1.body.id && !r1.body.message, `首个 %run_id 应新建，HTTP ${r1.status} ${JSON.stringify(r1.body)}`);
            webhookIds.push(r1.body.id);
            const r2 = await webhook({ table_name: 'ods_pct', run_id: `${tag}_50X_A` });
            must(r2.status === 200 && r2.body.id !== r1.body.id && !r2.body.message,
                `% 不应作通配符误匹配，r2 应独立新建。r1=${r1.body.id} r2=${JSON.stringify(r2.body)}`);
            webhookIds.push(r2.body.id);
        } },

        { name: 'W9 codex M-2：非法 body 字段（对象/数组）归一不污染', fn: async () => {
            // table_name 传对象/数组：归一为空 → 与 node_name 都空 → 400（不会变 [object Object] 落库）
            const r = await webhook({ table_name: { evil: 1 }, node_name: ['a', 'b'] });
            // node_name 数组归一为空，table_name 对象归一为空 → 两者皆空 → 400
            must(r.status === 400, `对象/数组 body 应归一为空触发 400，HTTP ${r.status} ${JSON.stringify(r.body)}`);
        } },

        { name: 'W10 codex M-3：无效 secret → 401（secret 优先于 schema 守卫）', fn: async () => {
            // schema 已就绪时此用例只验 401；核心是 secret 中间件在 schema 之前，未授权先被拦
            const r = await webhook({ table_name: 'ods_y' }, 'wrong_secret_m3');
            must(r.status === 401, `无效 secret 应 401（不应 503/其他），HTTP ${r.status} ${JSON.stringify(r.body)}`);
        } },
    ];
    // [#106 S4c-1 修复批 1·S1-M1] 先核前提再 SKIP（同 verify-h0-metadata-e2e.js：核得上才 SKIP，核不上不当成正常 SKIP）。
    //   W0 = 隔离实例上唯一能测的 webhook 安全性质：「密钥未配置 → 一律 503，空密钥头不放行」（server.js:14183-14186 requireWebhookSecret）。
    //   发合法 body + 空 x-webhook-secret 头：必须 503，且按 body 里的唯一 run_id 标记查实例库没有新建工单（description 含 `run_id: <标记>`，server.js:14224-14227）。
    //   W0 通过 → W1–W10 记 SKIP；不通过 → W1–W10 各计失败（用例体仍不执行：前提不成立，无法判断它们该是什么结果）。
    let w0Passed = false;
    await check('W0 前提：WEBHOOK_SECRET 未配置 → 空密钥头请求 503 且不新建工单（空串不得放行）', async () => {
        const marker = `C5W0_${Date.now()}`;
        const r = await webhook({ table_name: 'ods_c5_w0', error_message: 'C5 W0 前提探针', run_id: marker }, '');
        const row = await dbGet('SELECT id FROM issues WHERE description LIKE ?', [`%run_id: ${marker}%`]);
        if (row) webhookIds.push(row.id);   // 若真被放行建了单，留给下面的清理循环删掉
        must(r.status === 503, `空密钥头应 503（入口未配置），实得 HTTP ${r.status} ${JSON.stringify(r.body)}`);
        must(!row, `503 之后实例库不应出现带 run_id 标记 ${marker} 的工单，实得 id=${row && row.id}`);
        w0Passed = true;
    });
    if (w0Passed) {
        for (const c of WEBHOOK_CASES) skipCase(c.name);
    } else {
        for (const c of WEBHOOK_CASES) { fail++; console.log(`  ❌ ${c.name} — W0 前提未通过，不能记 SKIP（计失败，用例体未执行）`); }
    }

    // 清理（webhook 工单 + 普通工单都走 admin DELETE）
    // [#106 S4c 收口] 逐个 try/catch 并核对状态码（200 / 404 才算清掉），清掉的才移出待清理列表；剩余编号再试一轮；仍遗留的计入失败（fail），不中断后续清理
    const leftover = await cleanupIssues(adminToken);
    if (leftover.length > 0) { console.log(`  ❌ 测试单清理失败，遗留 id=${leftover.join(',')}`); fail += leftover.length; }

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL / ${skip} SKIP（SKIP 不计入通过数：W1–W10 webhook 用例在隔离实例无法成立，需真实 webhook 环境人工核对；W0 前提断言计入 PASS / FAIL）`);
    console.log(fail === 0 ? '  🎉 C5 列表筛选冒烟 F 段 + W0 前提全部通过（webhook W1–W10 已 SKIP）\n' : '  🚫 存在失败项\n');
    return fail;   // 退出码按 F 段 + W0 失败数判定（SKIP 不影响；W0 不通过时 W1–W10 也计失败）；不在 helper 里 process.exit：由入口在 teardown 之后 finish
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出）
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    let code = 1;
    try {
        DB_PATH = fx.DB_PATH;
        const nFailed = await main();
        code = nFailed > 0 ? 1 : 0;
    } catch (e) {
        console.error('冒烟脚本异常:', e);
    } finally {
        // [#106 S4c 送审前小修] main 中途抛错（造数失败等）时它自己的清理没走到，或清理后仍有遗留：对模块级 created / webhookIds 再清一轮，仍遗留计失败（code = 1），不跳过 teardown
        if (created.length + webhookIds.length > 0) {
            try {
                const left = await cleanupIssues(await fx.signAs(fx.ADMIN_ID));
                if (left.length > 0) { console.error(`入口清理后仍遗留测试单 id=${left.join(',')}`); code = 1; }
            } catch (e) { console.error(`入口清理异常：${e.message}`); code = 1; }
        }
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); code = 1; }
    }
    fx.finish(code);   // teardown 已落定；只设退出码（见 lib/test-env.js finish），不在 finally 里调
})().catch(async (e) => {
    console.error('issue-c5 smoke 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
