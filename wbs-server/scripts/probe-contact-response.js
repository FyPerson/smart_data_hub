/**
 * 对接人环节响应情况探针（一次性，跑完可删）
 *
 * 背景：2026-09-04 讨论收敛到「建单人 → 第一个对接人」这个甲乙方交接点。
 *      用户指出「有些任务单的对接人就是示例开发A」，而诊断显示他的钉钉已读率最低（45%）。
 *      本探针查清：谁在当对接人、对接人环节的通知送达与响应时效如何。
 *
 * 两个模块的对接人机制不同：
 *   - 数据协作 collab_requests：contact_person_id 建单时必填，有 contact_notified_at（证据链完整）
 *   - 系统迭代 sys_issues：intake_liaison_id 绑定受理人，缺 intake_notified_at（证据链有缺口）
 *
 * 口径提醒：read_at 空值是二义的（未读 或 从没人去查），本脚本只把它当参考列，
 *          真实已读看 probe-notify-read-diagnosis.js --live。
 *          响应时效用状态流转时间算，那是我方系统内事实，不依赖钉钉。
 *
 * 只读。用法：node scripts/probe-contact-response.js [天数，默认60]
 */

'use strict';

const path = require('path');
const sqlite3 = require('sqlite3');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db');
const DAYS = Number(process.argv[2] || '60');
const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const cols = async (t) => (await all('PRAGMA table_info("' + t + '")')).map(c => c.name);

const hours = (a, b) => {
    if (!a || !b) return null;
    const t1 = new Date(String(a).replace(' ', 'T')).getTime();
    const t2 = new Date(String(b).replace(' ', 'T')).getTime();
    if (isNaN(t1) || isNaN(t2)) return null;
    const h = (t2 - t1) / 3600000;
    return h >= 0 ? h : null;
};
const fmt = h => h === null || h === undefined ? '-' : (h < 1 ? Math.round(h * 60) + 'min' : h.toFixed(1) + 'h');
const pct = (arr, q) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};

(async () => {
    // ---------- 数据协作：对接人环节 ----------
    const cc = await cols('collab_requests');
    const has = n => cc.includes(n);
    console.log('=== 数据协作 collab_requests · 对接人环节（近 ' + DAYS + ' 天）===');
    if (!has('contact_person_name')) {
        console.log('（本库无 contact_person_name 列，跳过）');
    } else {
        const rows = await all(
            'SELECT contact_person_name AS nm, contact_notified_at AS sent, contact_read_at AS rd, status, created_at' +
            (has('assigned_at') ? ', assigned_at' : '') +
            ' FROM collab_requests WHERE julianday(\'now\',\'localtime\') - julianday(created_at) <= ? ' +
            'ORDER BY created_at', [DAYS]);

        const byPerson = new Map();
        for (const r of rows) {
            const k = r.nm || '(未填)';
            const v = byPerson.get(k) || { 对接人: k, 建单数: 0, 已通知: 0, 已读固化: 0, 响应h: [] };
            v.建单数++;
            if (r.sent) v.已通知++;
            if (r.rd) v.已读固化++;
            const resp = hours(r.sent, r.assigned_at);
            if (resp !== null) v.响应h.push(resp);
            byPerson.set(k, v);
        }
        const table = [...byPerson.values()].map(v => ({
            对接人: v.对接人,
            建单数: v.建单数,
            已通知: v.已通知,
            已读固化: v.已读固化,
            'p50响应': fmt(pct(v.响应h, 0.5)),
            'p90响应': fmt(pct(v.响应h, 0.9)),
            响应样本: v.响应h.length
        })).sort((a, b) => b.建单数 - a.建单数);
        console.table(table);
        console.log('响应 = contact_notified_at → assigned_at（对接人把单指派出去），是我方系统内事实，不依赖钉钉。');

        // 当前仍卡在对接人手上的单
        const stuck = rows.filter(r => r.sent && !(r.assigned_at))
            .map(r => ({
                对接人: r.nm || '(未填)',
                通知时间: r.sent,
                当前状态: r.status,
                已过小时: fmt(hours(r.sent, new Date().toISOString().slice(0, 19).replace('T', ' '))),
                'read_at(仅参考)': r.rd ? '有' : '空'
            }))
            .sort((a, b) => String(b.通知时间).localeCompare(String(a.通知时间)));
        if (stuck.length) {
            console.log('\n仍未指派出去的单（卡在对接人环节）：');
            console.table(stuck.slice(0, 20));
        } else {
            console.log('\n无卡在对接人环节的单。');
        }
    }

    // ---------- 系统迭代：受理人环节 ----------
    console.log('\n=== 系统迭代 sys_issues · 受理人环节（近 ' + DAYS + ' 天）===');
    const sc = await cols('sys_issues');
    if (!sc.includes('intake_liaison_id')) {
        console.log('（本库无 intake_liaison_id 列，跳过）');
    } else {
        const rows = await all(
            'SELECT i.intake_liaison_id AS lid, u.display_name AS nm, i.intake_notify_status AS st, ' +
            'i.intake_read_at AS rd, i.status, i.created_at ' +
            'FROM sys_issues i LEFT JOIN users u ON u.id = i.intake_liaison_id ' +
            'WHERE julianday(\'now\',\'localtime\') - julianday(i.created_at) <= ? ORDER BY i.created_at', [DAYS]);
        const byL = new Map();
        for (const r of rows) {
            const k = r.nm || (r.lid ? 'id=' + r.lid : '(未绑定)');
            const v = byL.get(k) || { 受理人: k, 单数: 0, 已通知: 0, 已读固化: 0 };
            v.单数++;
            if (r.st === 'sent') v.已通知++;
            if (r.rd) v.已读固化++;
            byL.set(k, v);
        }
        console.table([...byL.values()].sort((a, b) => b.单数 - a.单数));
        console.log('注意：sys_issues 无 intake_notified_at 列，此环节算不出响应时效——这正是证据链缺口。');

        // 缺 intake_notified_at 就绕一下：从时间线取受理动作时刻，用「建单 → 受理」代替「通知 → 受理」。
        // 口径偏保守（把「等着被通知」的时间也算进去了），但足以看出谁在拖。
        const acc = await all(
            'SELECT t.issue_id, t.operator_name AS who, t.created_at AS acc_at, i.created_at AS born_at, i.type ' +
            '  FROM sys_issue_timeline t JOIN sys_issues i ON i.id = t.issue_id ' +
            ' WHERE t.action_code = \'intake_accept\' ' +
            '   AND julianday(\'now\',\'localtime\') - julianday(i.created_at) <= ? ' +
            ' ORDER BY t.created_at', [DAYS]);
        if (!acc.length) {
            console.log('\n（时间线里没有 action_code=intake_accept 记录，无法反推受理时效）');
        } else {
            const byWho = new Map();
            for (const r of acc) {
                const k = r.who || '(未知)';
                const v = byWho.get(k) || { 受理人: k, 受理单数: 0, 时长h: [] };
                v.受理单数++;
                const h = hours(r.born_at, r.acc_at);
                if (h !== null) v.时长h.push(h);
                byWho.set(k, v);
            }
            console.log('\n=== 受理时效（建单 → 受理，n=' + acc.length + '）===');
            console.table([...byWho.values()].map(v => ({
                受理人: v.受理人,
                受理单数: v.受理单数,
                p50: fmt(pct(v.时长h, 0.5)),
                p90: fmt(pct(v.时长h, 0.9)),
                最长: fmt(v.时长h.length ? Math.max(...v.时长h) : null)
            })).sort((a, b) => b.受理单数 - a.受理单数));

            // 当前仍未受理的单（真正该关心的）
            const accepted = new Set(acc.map(r => r.issue_id));
            const pend = await all(
                'SELECT i.id, i.created_at, i.status, i.intake_notify_status AS st, u.display_name AS liaison ' +
                '  FROM sys_issues i LEFT JOIN users u ON u.id = i.intake_liaison_id ' +
                ' WHERE julianday(\'now\',\'localtime\') - julianday(i.created_at) <= ? ' +
                ' ORDER BY i.created_at DESC', [DAYS]);
            const nowStr = new Date().toISOString().slice(0, 19).replace('T', ' ');
            const stuck = pend.filter(r => !accepted.has(r.id) && r.st === 'sent')
                .map(r => ({ 单号: r.id, 绑定受理人: r.liaison || '(未绑定)', 建单: r.created_at, 当前状态: r.status, 已过: fmt(hours(r.created_at, nowStr)) }));
            console.log('\n=== 已通知但时间线里查不到受理动作的单 ===');
            if (stuck.length) console.table(stuck.slice(0, 20));
            else console.log('无。');
        }
    }
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
