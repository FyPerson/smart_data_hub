/**
 * verify-statistics-efficiency.js — 统计中心·效率统计 独立验证脚本
 *
 * 方案：docs/local/统计中心/统计中心效率统计_方案_20260710_v1.0.md §五 + 用户执行中追加口径
 * （三段边界模型 + 聚合层仅完结单 + 平均可加性不变量）。
 *
 * 覆盖：
 *   Part 1  纯数学 helper（median/average/hoursBetween raw）
 *   Part 2  三段边界纯函数（fillSkippedBoundaries / normalizeBoundaries / computeThreeStageRecord）
 *           —— 含 fallback 链、边界逆序护栏、在途 frontier、异常终止 frontier 场景
 *   Part 3  correction/issue 历史表边界提取（extractHistoryBoundaries）+ 四类边界场景
 *           （正常完结/在途/REFIXED 返工折入收尾/异常终止）
 *   Part 4  聚合（computeStatsForRecords + summarizeModule + buildTrend + byType）——
 *           ⭐ 聚合级可加性不变量：Σ stageStats[i].avg ≈ totalStats.avg（每模块 + 每 byType 组）；
 *           在途单不进聚合样本（仅 counts.inflight）
 *   Part 5  DB 集成（sqlite3 :memory: 合成数据）—— 四 loader SQL + type + 响应动作时刻查询 +
 *           ⭐ 每张完结单 raw stage1+stage2+stage3 === totalHours（容差 1e-6）
 *   Part 6  真实 db 双验（../task_pool.db READONLY，存在才跑）—— 全量记录逐单可加性不变量 +
 *           每模块/每 byType 组聚合可加性（round1 后容差 0.21 = 4 次四舍五入误差上界）
 *
 * 用法：node scripts/verify-statistics-efficiency.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const eff = require('../utils/efficiency-stats');

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

function assertDeepEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    check(a === e, label, a === e ? '' : `期望 ${e}，实得 ${a}`);
}

function assertClose(actual, expected, tol, label) {
    const ok = actual !== null && expected !== null && Math.abs(actual - expected) <= tol;
    check(ok, label, ok ? '' : `期望 ${expected}±${tol}，实得 ${actual}`);
}

// 逐单可加性不变量（完结单：raw 三段之和 === total，容差 1e-6）
function assertRecordAdditivity(records, moduleLabel) {
    const doneRecords = records.filter((r) => r.statusGroup === 'done' && r.totalHours != null);
    let bad = null;
    for (const r of doneRecords) {
        const s = r.stageHours;
        if (s.some((v) => v === null || v === undefined)) { bad = { id: r.id, reason: `完结单存在 null 段：${JSON.stringify(s)}` }; break; }
        const sum = s[0] + s[1] + s[2];
        if (Math.abs(sum - r.totalHours) > 1e-6) { bad = { id: r.id, reason: `Σ段=${sum} ≠ total=${r.totalHours}` }; break; }
    }
    check(bad === null, `${moduleLabel}：全部完结单 raw stage1+stage2+stage3 === total（1e-6 容差，${doneRecords.length} 单）`,
        bad ? `#${bad.id} ${bad.reason}` : '');
}

// 聚合级可加性不变量（round1 后：|Σ stageStats.avg - totalStats.avg| ≤ 0.21 = 4 次舍入误差上界）
function assertAggregateAdditivity(stats, label) {
    if (stats.totalStats.count === 0) {
        check(stats.stageStats.every((st) => st.count === 0 && st.avg === null),
            `${label}：0 完结单 → 三段 avg 全 null（不混在途样本）`);
        return;
    }
    const sum = stats.stageStats.reduce((acc, st) => acc + (st.avg || 0), 0);
    assertClose(sum, stats.totalStats.avg, 0.21, `${label}：Σ(stageStats.avg)=${Math.round(sum * 10) / 10} ≈ totalStats.avg=${stats.totalStats.avg}`);
    const counts = stats.stageStats.map((st) => st.count);
    check(counts.every((c) => c === stats.totalStats.count),
        `${label}：三段样本数与总样本数一致（全 ${stats.totalStats.count}，无在途混入）`,
        `实际 [${counts.join(',')}] vs total.count=${stats.totalStats.count}`);
}

// ============================================================
// Part 1：纯数学 helper
// ============================================================
console.log('=== Part 1：纯数学 helper（median/average/hoursBetween raw）===\n');

assertDeepEqual(eff.median([]), null, 'median([]) = null');
assertDeepEqual(eff.median([1, 3, 2]), 2, 'median([1,3,2]) = 2');
assertDeepEqual(eff.average([]), null, 'average([]) = null');
assertDeepEqual(eff.average([1, 2, 3]), 2, 'average([1,2,3]) = 2');
assertDeepEqual(eff.round1(1.25 * 1), 1.3, 'round1(1.25) = 1.3');
assertDeepEqual(eff.hoursBetween('2026-01-01 00:00:00', '2026-01-01 02:00:00'), 2, 'hoursBetween 2 小时差 = 2');
assertDeepEqual(eff.hoursBetween('2026-01-01 00:00:00', '2026-01-01 00:20:00'), 1 / 3, 'hoursBetween 返回 raw 浮点（20 分钟 = 1/3，不四舍五入）');
assertDeepEqual(eff.hoursBetween(null, '2026-01-01 00:00:00'), null, 'hoursBetween(null,x) = null');
console.log('');

// ============================================================
// Part 2：三段边界纯函数
// ============================================================
console.log('=== Part 2：三段边界纯函数（fill / normalize / computeThreeStageRecord）===\n');

assertDeepEqual(eff.THREE_STAGE_LABELS, ['开发响应', '处理中', '验收归档'], '三段统一标签 = 开发响应/处理中/验收归档（四模块同构）');

// fillSkippedBoundaries
assertDeepEqual(eff.fillSkippedBoundaries(['00', '01', '02', '03']), ['00', '01', '02', '03'], 'fill：无缺口原样返回');
assertDeepEqual(eff.fillSkippedBoundaries(['00', null, '02', '03']), ['00', '02', '02', '03'], 'fill：中间缺口用右侧最近非空值填平（跳过步骤耗时归零）');
assertDeepEqual(eff.fillSkippedBoundaries(['00', null, null, '03']), ['00', '03', '03', '03'], 'fill：连续缺口一路吸收到归档终态（用户口径"没有就用实际完成时刻"）');
assertDeepEqual(eff.fillSkippedBoundaries(['00', '01', null, null]), ['00', '01', null, null], 'fill：末尾真缺口保持 null（在途，交给 frontierEnd）');

// normalizeBoundaries（逆序护栏）
assertDeepEqual(eff.normalizeBoundaries(['00', '02', '01', '03']), ['00', '02', '02', '03'], 'normalize：逆序边界推平到前一边界（该段归零防负数）');
assertDeepEqual(eff.normalizeBoundaries(['00', '01', '02', '03']), ['00', '01', '02', '03'], 'normalize：正序不动');

// computeThreeStageRecord 场景
{
    const r = eff.computeThreeStageRecord('2026-02-01 00:00:00', '2026-02-01 01:00:00', '2026-02-01 04:00:00', '2026-02-02 06:00:00', null);
    assertDeepEqual(r.stageHours, [1, 3, 26], 'record：done 全齐全 [1,3,26]');
    assertDeepEqual(r.totalHours, 30, 'record：done total = 30');
    assertClose(r.stageHours[0] + r.stageHours[1] + r.stageHours[2], r.totalHours, 1e-9, 'record：⭐可加性 1+3+26 === 30');
}
{
    const r = eff.computeThreeStageRecord('2026-02-01 00:00:00', null, '2026-02-01 02:00:00', '2026-02-01 05:00:00', null);
    assertDeepEqual(r.stageHours, [2, 0, 3], 'record：响应缺失 → 响应段吸收到提交时刻、开发段=0（[2,0,3]）');
    assertClose(r.stageHours[0] + r.stageHours[1] + r.stageHours[2], r.totalHours, 1e-9, 'record：⭐fallback 后可加性仍成立');
}
{
    const r = eff.computeThreeStageRecord('2026-02-01 00:00:00', null, null, '2026-02-01 05:00:00', null);
    assertDeepEqual(r.stageHours, [5, 0, 0], 'record：响应+提交全缺失 → 全吸收到归档终态（[5,0,0]，行政闭环类）');
    assertDeepEqual(r.totalHours, 5, 'record：total = 5');
}
{
    const r = eff.computeThreeStageRecord('2026-02-01 00:00:00', '2026-02-01 00:30:00', null, null, '2026-02-01 05:30:00');
    assertDeepEqual(r.stageHours, [0.5, 5, null], 'record：在途单前沿段累计到 now、更深段留空（[0.5,5,null]）');
    assertDeepEqual(r.totalHours, 5.5, 'record：在途 total 累计到 now = 5.5');
}
{
    const r = eff.computeThreeStageRecord('2026-02-01 00:00:00', null, null, null, '2026-02-01 03:00:00');
    assertDeepEqual(r.stageHours, [3, null, null], 'record：异常终止累计到终止时刻（[3,null,null]）');
    assertDeepEqual(r.totalHours, 3, 'record：异常终止 total = 3');
}
console.log('');

// ============================================================
// Part 3：correction/issue 历史表边界提取 + 四类边界场景
// ============================================================
console.log('=== Part 3：历史表边界提取（extractHistoryBoundaries）+ 四类边界场景 ===\n');

// 场景 A：正常完结单
{
    const rows = [
        { to_status: 'PENDING_ASSIGN', created_at: '2026-01-01 00:00:00' },
        { to_status: 'ASSIGNED_PENDING_ESTIMATE', created_at: '2026-01-01 02:00:00' },
        { to_status: 'IN_PROGRESS', created_at: '2026-01-01 04:00:00' },
        { to_status: 'FIXED', created_at: '2026-01-02 04:00:00' },
        { to_status: 'ARCHIVED', created_at: '2026-01-02 10:00:00' },
    ];
    const { t1, t2, last } = eff.extractHistoryBoundaries(rows, 'IN_PROGRESS', 'FIXED');
    assertDeepEqual(t1, '2026-01-01 04:00:00', '场景A：t1 = 首次进入 IN_PROGRESS（响应=回复预计动作时刻）');
    assertDeepEqual(t2, '2026-01-02 04:00:00', '场景A：t2 = 首次进入 FIXED（提交）');
    const r = eff.computeThreeStageRecord('2026-01-01 00:00:00', t1, t2, last.created_at, null);
    assertDeepEqual(r.stageHours, [4, 24, 6], '场景A 正常完结单：[4,24,6]');
    assertDeepEqual(r.totalHours, 34, '场景A：total = 34');
    assertClose(r.stageHours[0] + r.stageHours[1] + r.stageHours[2], 34, 1e-9, '场景A：⭐可加性 4+24+6 === 34');
}

// 场景 B：REFIXED 返工单（返工时间折入"验收归档"段——三段简化口径的有意语义）
{
    const rows = [
        { to_status: 'PENDING_ASSIGN', created_at: '2026-01-01 00:00:00' },
        { to_status: 'ASSIGNED_PENDING_ESTIMATE', created_at: '2026-01-01 01:00:00' },
        { to_status: 'IN_PROGRESS', created_at: '2026-01-01 02:00:00' },
        { to_status: 'FIXED', created_at: '2026-01-01 05:00:00' },
        { to_status: 'REFIXED', created_at: '2026-01-01 08:00:00' },
        { to_status: 'FIXED', created_at: '2026-01-01 12:00:00' },
        { to_status: 'ARCHIVED', created_at: '2026-01-01 14:00:00' },
    ];
    const { t1, t2, last } = eff.extractHistoryBoundaries(rows, 'IN_PROGRESS', 'FIXED');
    assertDeepEqual(t2, '2026-01-01 05:00:00', '场景B：t2 = 首次 FIXED（返工后二次 FIXED 不覆盖）');
    const r = eff.computeThreeStageRecord('2026-01-01 00:00:00', t1, t2, last.created_at, null);
    assertDeepEqual(r.stageHours, [2, 3, 9], '场景B 返工单：[2,3,9]（返工 9h 折入验收归档段）');
    assertClose(r.stageHours[0] + r.stageHours[1] + r.stageHours[2], r.totalHours, 1e-9, '场景B：⭐返工单可加性成立（旧区间桶模型此处会断）');
}

// 场景 C：在途单
{
    const rows = [
        { to_status: 'PENDING_ASSIGN', created_at: '2026-01-01 00:00:00' },
        { to_status: 'ASSIGNED_PENDING_ESTIMATE', created_at: '2026-01-01 01:00:00' },
        { to_status: 'IN_PROGRESS', created_at: '2026-01-01 03:00:00' },
    ];
    const { t1, t2 } = eff.extractHistoryBoundaries(rows, 'IN_PROGRESS', 'FIXED');
    const r = eff.computeThreeStageRecord('2026-01-01 00:00:00', t1, t2, null, '2026-01-01 09:00:00');
    assertDeepEqual(r.stageHours, [3, 6, null], '场景C 在途单：[3,6,null]（阶段3 未到达留空非 0）');
    assertDeepEqual(r.totalHours, 9, '场景C：total 累计到 now = 9');
}

// 场景 D：异常终止单（PENDING_ASSIGN 直接 VOIDED）
{
    const rows = [
        { to_status: 'PENDING_ASSIGN', created_at: '2026-01-01 00:00:00' },
        { to_status: 'VOIDED', created_at: '2026-01-01 05:00:00' },
    ];
    const { t1, t2, last } = eff.extractHistoryBoundaries(rows, 'IN_PROGRESS', 'FIXED');
    const r = eff.computeThreeStageRecord('2026-01-01 00:00:00', t1, t2, null, last.created_at);
    assertDeepEqual(r.stageHours, [5, null, null], '场景D 异常终止单：[5,null,null]（截至 VOIDED 时刻）');
    assertDeepEqual(r.totalHours, 5, '场景D：total = 5');
}
console.log('');

// ============================================================
// Part 4：聚合（仅完结单 + 可加性不变量 + byType）
// ============================================================
console.log('=== Part 4：聚合（computeStatsForRecords 仅完结单 + ⭐可加性不变量 + byType）===\n');

{
    const records = [
        { id: 1, type: 'single', statusGroup: 'done', stageHours: [4, 24, 6], totalHours: 34, terminalAt: '2026-01-02 10:00:00' },
        { id: 2, type: 'single', statusGroup: 'inflight', stageHours: [3, 6, null], totalHours: 9, terminalAt: null },
        { id: 3, type: 'batch', statusGroup: 'done', stageHours: [2, 3, 9], totalHours: 14, terminalAt: '2026-01-01 14:00:00' },
        { id: 4, type: 'single', statusGroup: 'aborted', stageHours: [5, null, null], totalHours: 5, terminalAt: null },
    ];
    const summary = eff.summarizeModule('correction', records);

    assertDeepEqual(summary.counts, { done: 2, inflight: 1, aborted: 1, total: 4 }, '计数：{done:2,inflight:1,aborted:1,total:4}（在途/终止保留在计数）');
    // 仅完结单：stage1=[4,2] avg=3 / stage2=[24,3] avg=13.5 / stage3=[6,9] avg=7.5 / total=[34,14] avg=24
    assertDeepEqual(summary.stageStats.map((s) => s.avg), [3, 13.5, 7.5], '三段 avg = [3,13.5,7.5]（在途单 #2 完全不进样本——修正 1 核心）');
    assertDeepEqual(summary.stageStats.map((s) => s.count), [2, 2, 2], '三段 count 全 = 2（同批完结样本，不再 3/1/2 各不同）');
    assertDeepEqual(summary.totalStats.avg, 24, 'totalStats.avg = 24');
    assertClose(3 + 13.5 + 7.5, 24, 1e-9, '⭐聚合可加性：Σ段avg 3+13.5+7.5 === 24');
    assertAggregateAdditivity(summary, '合成模块');

    const singleGroup = summary.byType.find((t) => t.type === 'single');
    const batchGroup = summary.byType.find((t) => t.type === 'batch');
    assertDeepEqual(singleGroup.counts, { done: 1, inflight: 1, aborted: 1, total: 3 }, 'byType.single 计数：{done:1,inflight:1,aborted:1,total:3}');
    assertDeepEqual(singleGroup.stageStats.map((s) => s.avg), [4, 24, 6], 'byType.single 三段 avg = [4,24,6]（组内同样仅完结单）');
    assertAggregateAdditivity(singleGroup, 'byType.single');
    assertAggregateAdditivity(batchGroup, 'byType.batch');

    const inflightOnly = eff.computeStatsForRecords(eff.THREE_STAGE_LABELS, [
        { statusGroup: 'inflight', stageHours: [1, null, null], totalHours: 1 },
    ]);
    assertAggregateAdditivity(inflightOnly, '纯在途组');

    const trend = eff.buildTrend({ correction: records, issue: [], collab: [], sys: [] }, ['correction', 'issue', 'collab', 'sys']);
    assertDeepEqual(trend, [{ month: '2026-01', correction: 24, issue: null, collab: null, sys: null }],
        '月度趋势：仅 done 单，2026-01 中位(34,14) = 24（原口径保留不动）');
}
console.log('');

// ============================================================
// Part 5：DB 集成（sqlite3 :memory: 合成数据）
// ============================================================
console.log('=== Part 5：DB 集成（in-memory sqlite，四 loader + ⭐逐单可加性）===\n');

async function runDbIntegration() {
    const db = new sqlite3.Database(':memory:');
    const dbRunAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (err) { (err ? reject(err) : resolve(this)); });
    });
    const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

    await dbRunAsync(`CREATE TABLE correction_requests (id INTEGER PRIMARY KEY, location_info TEXT, created_at TEXT, status TEXT, correction_type TEXT)`);
    await dbRunAsync(`CREATE TABLE correction_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, correction_request_id INTEGER, to_status TEXT, created_at TEXT)`);
    await dbRunAsync(`CREATE TABLE issues (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, status TEXT, type TEXT)`);
    await dbRunAsync(`CREATE TABLE issue_status_history (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, to_status TEXT, created_at TEXT)`);
    await dbRunAsync(`CREATE TABLE collab_requests (id INTEGER PRIMARY KEY, description TEXT, created_at TEXT, status TEXT, request_type TEXT,
        submitted_at TEXT, done_at TEXT, archived_at TEXT, archived_final_at TEXT)`);
    await dbRunAsync(`CREATE TABLE collab_operation_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, collab_request_id INTEGER, operation_type TEXT, operator_id INTEGER, operator TEXT, reason TEXT, created_at TEXT)`);
    await dbRunAsync(`CREATE TABLE sys_issues (id INTEGER PRIMARY KEY, title TEXT, created_at TEXT, status TEXT, type TEXT, updated_at TEXT,
        first_submitted_at TEXT, released_at TEXT, closed_at TEXT)`);
    await dbRunAsync(`CREATE TABLE sys_issue_timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, issue_id INTEGER, event_type TEXT, created_at TEXT)`);

    // ---- 数据修正（正常完结/在途/返工/异常终止 四类） ----
    await dbRunAsync(`INSERT INTO correction_requests (id, location_info, created_at, status, correction_type) VALUES
        (1, '正常完结单', '2026-01-01 00:00:00', 'ARCHIVED', 'single'),
        (2, '在途单', '2026-01-01 00:00:00', 'IN_PROGRESS', 'single'),
        (3, 'REFIXED返工单', '2026-01-01 00:00:00', 'ARCHIVED', 'batch'),
        (4, '异常终止单', '2026-01-01 00:00:00', 'VOIDED', 'single')`);
    const corrHistory = [
        [1, 'PENDING_ASSIGN', '2026-01-01 00:00:00'], [1, 'ASSIGNED_PENDING_ESTIMATE', '2026-01-01 02:00:00'],
        [1, 'IN_PROGRESS', '2026-01-01 04:00:00'], [1, 'FIXED', '2026-01-02 04:00:00'], [1, 'ARCHIVED', '2026-01-02 10:00:00'],
        [2, 'PENDING_ASSIGN', '2026-01-01 00:00:00'], [2, 'ASSIGNED_PENDING_ESTIMATE', '2026-01-01 01:00:00'], [2, 'IN_PROGRESS', '2026-01-01 03:00:00'],
        [3, 'PENDING_ASSIGN', '2026-01-01 00:00:00'], [3, 'ASSIGNED_PENDING_ESTIMATE', '2026-01-01 01:00:00'], [3, 'IN_PROGRESS', '2026-01-01 02:00:00'],
        [3, 'FIXED', '2026-01-01 05:00:00'], [3, 'REFIXED', '2026-01-01 08:00:00'], [3, 'FIXED', '2026-01-01 12:00:00'], [3, 'ARCHIVED', '2026-01-01 14:00:00'],
        [4, 'PENDING_ASSIGN', '2026-01-01 00:00:00'], [4, 'VOIDED', '2026-01-01 05:00:00'],
    ];
    for (const [pid, st, ts] of corrHistory) {
        await dbRunAsync(`INSERT INTO correction_status_history (correction_request_id, to_status, created_at) VALUES (?,?,?)`, [pid, st, ts]);
    }
    const corrNow = '2026-01-01 09:00:00';
    const corrRecords = await eff.EFFICIENCY_LOADERS.correction(dbAllAsync, null, null, corrNow);
    const byId = Object.fromEntries(corrRecords.map((r) => [r.id, r]));
    assertDeepEqual(byId[1].stageHours, [4, 24, 6], 'DB/修正 #1 正常完结：[4,24,6]');
    assertDeepEqual(byId[2].stageHours, [3, 6, null], 'DB/修正 #2 在途：[3,6,null]');
    assertDeepEqual(byId[3].stageHours, [2, 3, 9], 'DB/修正 #3 返工：[2,3,9]（返工折入验收归档段）');
    assertDeepEqual(byId[4].stageHours, [5, null, null], 'DB/修正 #4 异常终止：[5,null,null]');
    assertRecordAdditivity(corrRecords, 'DB/修正');
    const corrSummary = eff.summarizeModule('correction', corrRecords);
    assertDeepEqual(corrSummary.counts, { done: 2, inflight: 1, aborted: 1, total: 4 }, 'DB/修正 计数 = {2,1,1,4}');
    assertAggregateAdditivity(corrSummary, 'DB/修正 聚合');

    // ---- 数据开发 ----
    await dbRunAsync(`INSERT INTO issues (id, title, created_at, status, type) VALUES (1, '需求单A', '2026-01-05 00:00:00', '已关闭', '数据质量')`);
    const issueHistory = [
        [1, '待处理', '2026-01-05 00:00:00'], [1, '处理中', '2026-01-05 01:00:00'],
        [1, '待验证', '2026-01-05 03:00:00'], [1, '已关闭', '2026-01-05 04:00:00'],
    ];
    for (const [pid, st, ts] of issueHistory) {
        await dbRunAsync(`INSERT INTO issue_status_history (issue_id, to_status, created_at) VALUES (?,?,?)`, [pid, st, ts]);
    }
    const issueRecords = await eff.EFFICIENCY_LOADERS.issue(dbAllAsync, null, null, corrNow);
    assertDeepEqual(issueRecords[0].stageHours, [1, 2, 1], 'DB/开发 #1：[1,2,1]');
    assertDeepEqual(issueRecords[0].type, '数据质量', 'DB/开发 #1：type 透传');
    assertRecordAdditivity(issueRecords, 'DB/开发');

    // ---- 数据协作（有回填/撤销/有回填短链/无回填 fallback） ----
    await dbRunAsync(`INSERT INTO collab_requests
        (id, description, created_at, status, request_type, submitted_at, done_at, archived_at, archived_final_at) VALUES
        (101, '协作A-归档锁定', '2026-02-01 00:00:00', 'ARCHIVED', 'ONE_OFF_EXPORT', '2026-02-01 04:00:00', '2026-02-01 06:00:00', NULL, '2026-02-02 06:00:00'),
        (103, '协作C-撤销', '2026-02-01 00:00:00', 'PENDING_ASSIGN', 'ONE_OFF_EXPORT', NULL, NULL, '2026-02-01 03:00:00', NULL),
        (104, '协作D-有回填', '2026-02-01 00:00:00', 'DONE', 'ONE_OFF_EXPORT', '2026-02-01 03:00:00', '2026-02-01 05:00:00', NULL, NULL),
        (105, '协作E-无回填fallback', '2026-02-01 00:00:00', 'DONE', 'ONE_OFF_EXPORT', '2026-02-01 02:00:00', '2026-02-01 02:00:00', NULL, NULL)`);
    await dbRunAsync(`INSERT INTO collab_operation_logs (collab_request_id, operation_type, operator_id, operator, created_at) VALUES
        (101, 'dev_estimate_reply', 1, 'tester', '2026-02-01 01:00:00'),
        (104, 'dev_estimate_reply', 1, 'tester', '2026-02-01 01:00:00')`);
    const collabRecords = await eff.EFFICIENCY_LOADERS.collab(dbAllAsync, null, null, '2026-02-01 05:30:00');
    const byCid = Object.fromEntries(collabRecords.map((r) => [r.id, r]));
    assertDeepEqual(byCid[101].stageHours, [1, 3, 26], 'DB/协作 #101 归档锁定：[1,3,26]（t3=archived_final_at）');
    assertDeepEqual(byCid[101].totalHours, 30, 'DB/协作 #101：total = 30');
    assertDeepEqual(byCid[103].stageHours, [3, null, null], 'DB/协作 #103 撤销：累计到 archived_at 撤销时刻');
    assertDeepEqual(byCid[103].statusGroup, 'aborted', 'DB/协作 #103：aborted（archived_at 非空判定）');
    assertDeepEqual(byCid[104].stageHours, [1, 2, 2], 'DB/协作 #104 有回填：[1,2,2]（t3 回落 done_at）');
    assertDeepEqual(byCid[105].stageHours, [2, 0, 0], 'DB/协作 #105 无回填：[2,0,0]（fallback 吸收到提交，开发段=0）');
    assertRecordAdditivity(collabRecords, 'DB/协作');
    assertAggregateAdditivity(eff.summarizeModule('collab', collabRecords), 'DB/协作 聚合');

    // ---- 系统迭代（estimate 命中/作废/feasibility 命中/双缺失 fallback） ----
    await dbRunAsync(`INSERT INTO sys_issues
        (id, title, created_at, status, type, updated_at, first_submitted_at, released_at, closed_at) VALUES
        (201, '迭代X-已上线', '2026-03-01 00:00:00', '已上线', 'feature', '2026-03-01 03:10:00', '2026-03-01 01:30:00', '2026-03-01 03:00:00', NULL),
        (203, '迭代Z-作废', '2026-03-01 00:00:00', '已作废', 'feature', '2026-03-01 01:15:00', NULL, NULL, NULL),
        (204, '迭代-可行性评估路径', '2026-03-01 00:00:00', '已上线', 'improvement', NULL, '2026-03-01 02:00:00', '2026-03-01 03:00:00', NULL),
        (205, '迭代-跳过预计', '2026-03-01 00:00:00', '已上线', 'feature', NULL, '2026-03-01 01:00:00', '2026-03-01 02:00:00', NULL)`);
    await dbRunAsync(`INSERT INTO sys_issue_timeline (issue_id, event_type, created_at) VALUES
        (201, 'estimate', '2026-03-01 01:00:00'),
        (204, 'feasibility', '2026-03-01 00:30:00')`);
    const sysRecords = await eff.EFFICIENCY_LOADERS.sys(dbAllAsync, null, null, '2026-03-01 04:20:00');
    const bySid = Object.fromEntries(sysRecords.map((r) => [r.id, r]));
    assertDeepEqual(bySid[201].stageHours, [1, 0.5, 1.5], 'DB/迭代 #201：[1,0.5,1.5]（estimate 事件命中）');
    assertDeepEqual(bySid[203].stageHours, [1.25, null, null], 'DB/迭代 #203 作废：raw 1.25（updated_at 兜底终止时刻，内部不预 round）');
    assertDeepEqual(bySid[204].stageHours, [0.5, 1.5, 1], 'DB/迭代 #204：[0.5,1.5,1]（feasibility 事件命中——核实遗漏修正验证）');
    assertDeepEqual(bySid[205].stageHours, [1, 0, 1], 'DB/迭代 #205 跳过预计：[1,0,1]（fallback 到 first_submitted_at）');
    assertRecordAdditivity(sysRecords, 'DB/迭代');
    const sysSummary = eff.summarizeModule('sys', sysRecords);
    assertAggregateAdditivity(sysSummary, 'DB/迭代 聚合');
    check(sysSummary.byType.some((t) => t.type === 'feature') && sysSummary.byType.some((t) => t.type === 'improvement'),
        'DB/迭代：byType 含 feature/improvement 两组');
    for (const g of sysSummary.byType) assertAggregateAdditivity(g, `DB/迭代 byType.${g.type}`);

    db.close();
}

// ============================================================
// Part 6：真实 db 双验（存在才跑；只读）
// ============================================================
async function runRealDbValidation() {
    const REAL_DB = path.join(__dirname, '..', 'task_pool.db');
    console.log('=== Part 6：真实 db 双验（task_pool.db READONLY，逐单+聚合可加性不变量）===\n');
    if (!fs.existsSync(REAL_DB)) {
        console.log('  [SKIP] task_pool.db 不存在（非本机环境），跳过真实 db 双验\n');
        return;
    }
    const db = new sqlite3.Database(REAL_DB, sqlite3.OPEN_READONLY);
    const dbAllAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
    const dbGetAsync = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
    const nowIso = await eff.getDbNowLocal(dbGetAsync);
    for (const key of Object.keys(eff.EFFICIENCY_MODULES)) {
        const records = await eff.EFFICIENCY_LOADERS[key](dbAllAsync, null, null, nowIso);
        const label = eff.EFFICIENCY_MODULES[key].label;
        check(records.length > 0, `真实db/${label}：有记录（${records.length} 条）`);
        assertRecordAdditivity(records, `真实db/${label}`);
        const summary = eff.summarizeModule(key, records);
        assertAggregateAdditivity(summary, `真实db/${label} 聚合`);
        for (const g of summary.byType) assertAggregateAdditivity(g, `真实db/${label} byType.${g.type}`);
    }
    db.close();
    console.log('');
}

runDbIntegration()
    .then(() => { console.log(''); return runRealDbValidation(); })
    .then(() => {
        console.log(`=== ${fail === 0 ? 'PASS' : 'FAIL'}：${pass} 项通过 / ${fail} 项失败 ===`);
        if (fail > 0) {
            console.log('\n失败明细：');
            failures.forEach((f, i) => console.log(`  ${i + 1}. ${f.label}${f.detail ? ' — ' + f.detail : ''}`));
        }
        process.exit(fail === 0 ? 0 : 1);
    })
    .catch((err) => {
        console.error('DB 集成测试异常：', err);
        process.exit(1);
    });
