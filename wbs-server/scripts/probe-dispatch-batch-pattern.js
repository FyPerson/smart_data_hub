/**
 * 派单批次特征探针（一次性，跑完可删）
 *
 * 目的：诊断证伪了「到达时不在工位」的假设（12 条未读全部工位时段送达）。
 *      逐条时刻表里出现 11:23:24 / 11:23:25 相差 1 秒的记录，怀疑未读集中在
 *      「一次批量派多单」的场景——若成立，方案应是合并通知，而不是加强提醒。
 *
 * 输出：近 N 天 sys_issue_dev_assignees 的通知逐条明细 + 按送达秒级聚类的批次视图。
 * 只读。
 *
 * 用法：node scripts/probe-dispatch-batch-pattern.js [天数，默认7]
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const DAYS = Number(process.argv[2] || '7');
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));

(async () => {
    const rows = await all(
        `SELECT a.issue_id, a.user_name, a.notified_at, a.read_at, a.is_primary, a.round_no,
                a.dev_status, a.resolved_at, a.removed_at, i.title, i.type
           FROM sys_issue_dev_assignees a
           LEFT JOIN sys_issues i ON i.id = a.issue_id
          WHERE a.notified_at IS NOT NULL
            AND julianday('now','localtime') - julianday(a.notified_at) <= ?
          ORDER BY a.notified_at`, [DAYS]);

    // 处理时长 = 派单送达 → 开发在平台上把这一行推进到有 dev_status/resolved_at。
    // 注意 read_at 不能当「已读」判据（它只在有人主动查已读时才固化，空值是二义的），
    // 这里只用它做参考列，真实已读看 probe-notify-read-diagnosis.js --live。
    const hoursBetween = (a, b) => {
        const t1 = new Date(String(a).replace(' ', 'T')).getTime();
        const t2 = new Date(String(b).replace(' ', 'T')).getTime();
        if (isNaN(t1) || isNaN(t2)) return null;
        return (t2 - t1) / 3600000;
    };
    const fmt = h => h === null ? '-' : (h < 1 ? Math.round(h * 60) + 'min' : h.toFixed(1) + 'h');

    console.log(`近 ${DAYS} 天派单通知共 ${rows.length} 条\n`);
    console.table(rows.map(r => ({
        送达: r.notified_at,
        开发: r.user_name,
        单号: r.issue_id,
        开发态: r.dev_status || '(未处理)',
        处理耗时: fmt(r.resolved_at ? hoursBetween(r.notified_at, r.resolved_at) : null),
        'read_at(仅参考)': r.read_at ? '有' : '空',
        主办: r.is_primary ? '是' : '否',
        已移除: r.removed_at ? '是' : '否'
    })));

    // 核心对照：派单通知没被点开，事到底有没有被做
    const done = rows.filter(r => r.dev_status && r.dev_status !== 'pending');
    const undone = rows.filter(r => !r.dev_status || r.dev_status === 'pending');
    const durations = rows.map(r => r.resolved_at ? hoursBetween(r.notified_at, r.resolved_at) : null)
        .filter(h => h !== null && h >= 0);
    durations.sort((a, b) => a - b);
    const p = q => durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * q))] : null;
    console.log('\n=== 派单是否真被处理（这才是业务结果，未读只是过程指标）===');
    console.table([
        { 口径: '已推进(dev_status 有值)', 条数: done.length, '占比%': Math.round(done.length / rows.length * 100) },
        { 口径: '未推进', 条数: undone.length, '占比%': Math.round(undone.length / rows.length * 100) }
    ]);
    console.log('处理耗时（派单送达 → resolved_at，n=' + durations.length + '）：p50=' + fmt(p(0.5)) + '  p90=' + fmt(p(0.9)));
    const byStatus = {};
    for (const r of rows) byStatus[r.dev_status || '(未处理)'] = (byStatus[r.dev_status || '(未处理)'] || 0) + 1;
    console.log('dev_status 分布：' + JSON.stringify(byStatus));

    // 按送达时刻聚类：60 秒内视为同一次批量操作
    const clusters = [];
    for (const r of rows) {
        const t = new Date(String(r.notified_at).replace(' ', 'T')).getTime();
        const last = clusters[clusters.length - 1];
        if (last && t - last.endTs <= 60000) {
            last.items.push(r);
            last.endTs = t;
        } else {
            clusters.push({ startAt: r.notified_at, endTs: t, items: [r] });
        }
    }

    console.log('\n=== 按批次聚类（60 秒内算同一次操作）===');
    console.table(clusters.map(c => {
        const unread = c.items.filter(x => !x.read_at).length;
        return {
            批次起始: c.startAt,
            条数: c.items.length,
            未读: unread,
            '未读率%': Math.round(unread / c.items.length * 100),
            涉及单号: [...new Set(c.items.map(x => x.issue_id))].join(','),
            收件人: [...new Set(c.items.map(x => x.user_name))].join(',')
        };
    }));

    const single = clusters.filter(c => c.items.length === 1);
    const multi = clusters.filter(c => c.items.length > 1);
    const rate = list => {
        const tot = list.reduce((s, c) => s + c.items.length, 0);
        const un = list.reduce((s, c) => s + c.items.filter(x => !x.read_at).length, 0);
        return { 批次数: list.length, 消息数: tot, 未读: un, '未读率%': tot ? Math.round(un / tot * 100) : 0 };
    };
    console.log('\n=== 单条派单 vs 批量派单 对照 ===');
    console.table([
        { 类型: '单条送达', ...rate(single) },
        { 类型: '批量送达(≥2条/分钟)', ...rate(multi) }
    ]);
    console.log('读法：批量组未读率显著高于单条组 ⇒ 支持「一次来多条只看一条」，方案应合并通知；');
    console.log('      两组接近 ⇒ 与批量无关，另找原因。');
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
