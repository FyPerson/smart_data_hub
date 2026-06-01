/**
 * v1.74.0 C5 — 列表筛选 + webhook 适配 冒烟 e2e（方案 §2.5 T5 / §2.6 T8）
 *
 * 用法：本地 server 已启动后 node scripts/test-issue-c5-smoke.js
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
 */
'use strict';
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fx = require('./_test-fixture');

const DB_PATH = path.join(__dirname, '..', 'task_pool.db');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'issue_tracker_webhook_key';

function dbGet(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.get(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => { const db = new sqlite3.Database(DB_PATH); db.all(sql, params, (e, r) => { db.close(); e ? reject(e) : resolve(r); }); });
}
let pass = 0, fail = 0;
async function check(name, fn) { try { await fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + ' — ' + e.message); fail++; } }
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
// webhook 走 x-webhook-secret（非 JWT）
async function webhook(body, secret) {
    const r = await fetch(`${fx.BASE}/api/issues/webhook/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': secret ?? WEBHOOK_SECRET },
        body: JSON.stringify(body),
    });
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

const created = [];   // 普通工单（API 删）
const webhookIds = []; // webhook 工单（API 删，admin 有权）
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

    await check('W1 webhook 创建调度异常 → 200 + NOT NULL 适配（系统自动/FDL系统）', async () => {
        const r = await webhook({ table_name: 'ods_test_c5', error_message: 'C5 测试调度失败', run_id: `C5RUN_${Date.now()}_W1` });
        must(r.status === 200 && r.body.id, `HTTP ${r.status} ${JSON.stringify(r.body)}`);
        webhookIds.push(r.body.id);
        const issue = await dbGet('SELECT requester_dept, requester_name, source, type, priority FROM issues WHERE id=?', [r.body.id]);
        must(issue.requester_dept === '系统自动', `requester_dept 应=系统自动，实际 ${issue.requester_dept}`);
        must(issue.requester_name === 'FDL系统', `requester_name 应=FDL系统，实际 ${issue.requester_name}`);
        must(issue.source === 'FDL自动' && issue.type === '调度异常', 'source/type 正确');
    });

    await check('W2 webhook 落 issue_status_history 首行（from=NULL, to=待处理, FDL系统）', async () => {
        const id = webhookIds[0];
        const hist = await dbAll('SELECT * FROM issue_status_history WHERE issue_id=?', [id]);
        must(hist.length === 1, `应落 1 行首行，实际 ${hist.length}`);
        must(hist[0].from_status === null && hist[0].to_status === '待处理', `首行 NULL→待处理，实际 ${hist[0].from_status}→${hist[0].to_status}`);
        must(Number(hist[0].operator_id) === 0 && hist[0].operator_name === 'FDL系统', `operator 应 0/FDL系统，实际 ${hist[0].operator_id}/${hist[0].operator_name}`);
    });

    await check('W3 webhook run_id 去重（同 run_id 第二次返已存在 id）', async () => {
        const runId = `C5RUN_${Date.now()}_W3`;
        const r1 = await webhook({ table_name: 'ods_dup', error_message: 'first', run_id: runId });
        must(r1.status === 200 && r1.body.id, `首次 HTTP ${r1.status}`);
        webhookIds.push(r1.body.id);
        const r2 = await webhook({ table_name: 'ods_dup', error_message: 'second', run_id: runId });
        must(r2.status === 200 && r2.body.id === r1.body.id, `同 run_id 应返同 id，r1=${r1.body.id} r2=${r2.body.id}`);
        must(r2.body.message && r2.body.message.includes('跳过'), '应标"已存在跳过"');
    });

    await check('W4 webhook 不同 run_id 各自独立创建（L-3）', async () => {
        const r1 = await webhook({ table_name: 'ods_a', run_id: `C5RUN_${Date.now()}_W4A` });
        const r2 = await webhook({ table_name: 'ods_b', run_id: `C5RUN_${Date.now()}_W4B` });
        must(r1.body.id !== r2.body.id, '不同 run_id 应各自创建不同 id');
        webhookIds.push(r1.body.id, r2.body.id);
    });

    await check('W5 webhook 无效 secret → 401', async () => {
        const r = await webhook({ table_name: 'ods_x' }, 'wrong_secret');
        must(r.status === 401, `HTTP ${r.status}`);
    });

    await check('W6 webhook 缺 table_name+node_name → 400', async () => {
        const r = await webhook({ error_message: 'no target' });
        must(r.status === 400, `HTTP ${r.status}`);
    });

    await check('W7 系统自动工单可按 requester_dept=系统自动 筛出（与 F1 闭环）', async () => {
        const r = await listIssues(adminToken, { requester_dept: '系统自动' });
        must(r.status === 200, `HTTP ${r.status}`);
        must(r.body.some(i => webhookIds.includes(i.id)), '应筛出 webhook 工单');
        must(r.body.every(i => i.requester_dept === '系统自动'), '应只含系统自动');
    });

    await check('W8 codex M-1：run_id 含 % 通配符不误判已存在（LIKE 转义）', async () => {
        // 两个 run_id：'C5PCT_50%_A' 与 'C5PCT_50X_A'——未转义时 '50%' 的 % 会匹配 '50X'，转义后各自独立
        const tag = `C5PCT_${Date.now()}`;
        const r1 = await webhook({ table_name: 'ods_pct', run_id: `${tag}_50%_A` });
        must(r1.status === 200 && r1.body.id && !r1.body.message, `首个 %run_id 应新建，HTTP ${r1.status} ${JSON.stringify(r1.body)}`);
        webhookIds.push(r1.body.id);
        const r2 = await webhook({ table_name: 'ods_pct', run_id: `${tag}_50X_A` });
        must(r2.status === 200 && r2.body.id !== r1.body.id && !r2.body.message,
            `% 不应作通配符误匹配，r2 应独立新建。r1=${r1.body.id} r2=${JSON.stringify(r2.body)}`);
        webhookIds.push(r2.body.id);
    });

    await check('W9 codex M-2：非法 body 字段（对象/数组）归一不污染', async () => {
        // table_name 传对象/数组：归一为空 → 与 node_name 都空 → 400（不会变 [object Object] 落库）
        const r = await webhook({ table_name: { evil: 1 }, node_name: ['a', 'b'] });
        // node_name 数组归一为空，table_name 对象归一为空 → 两者皆空 → 400
        must(r.status === 400, `对象/数组 body 应归一为空触发 400，HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    await check('W10 codex M-3：无效 secret → 401（secret 优先于 schema 守卫）', async () => {
        // schema 已就绪时此用例只验 401；核心是 secret 中间件在 schema 之前，未授权先被拦
        const r = await webhook({ table_name: 'ods_y' }, 'wrong_secret_m3');
        must(r.status === 401, `无效 secret 应 401（不应 503/其他），HTTP ${r.status} ${JSON.stringify(r.body)}`);
    });

    // 清理（webhook 工单 + 普通工单都走 admin DELETE）
    for (const id of [...created, ...webhookIds]) await fx.apiCall('DELETE', `/api/issues/${id}`, adminToken);

    console.log(`\n  合计 ${pass} PASS / ${fail} FAIL`);
    console.log(fail === 0 ? '  🎉 C5 列表筛选 + webhook 适配冒烟全部通过\n' : '  🚫 存在失败项\n');
    process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error('冒烟脚本异常:', e); process.exit(1); });
