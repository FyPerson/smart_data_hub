/**
 * 钉钉通知触达诊断探针（只读，无副作用）
 *
 * 背景：2026-09-04 讨论「怎么让漏消息的人注意到」。加强提醒之前先诊断病因，
 *      避免给本来就不是瓶颈的环节加强度。
 *
 * 两种模式：
 *   1) inventory（默认，纯库内 SELECT，零外呼零风险）
 *        node scripts/probe-notify-read-diagnosis.js --db <path>
 *      产出：通知量分布 / 已读固化率 / 已读延迟分位数 / 人均消息密度
 *
 *   2) live（追加 readStatus 外呼，只查窗口内的消息；只读 API，不发消息不写库）
 *        DB_ENCRYPTION_KEY=xxx node scripts/probe-notify-read-diagnosis.js --db <path> --live
 *      产出：inventory 全部 + 窗口内消息的真实已读/未读，并顺带实测 readStatus 回溯窗口
 *      ⚠️ 窗口是 **7 天**不是 24h（2026-09-04 生产实测·见下方 FRESH_HOURS 注释）；
 *         DB_ENCRYPTION_KEY 必须显式带，本脚本无默认回退值
 *
 * 设计约束（对应项目既有教训）：
 *   - 通知列用「模式扫描」自动发现（扫全库 *message_key 列），不手工枚举——手工清单必漏
 *   - read_at 语义二义：空值 = 未读 或 从没查过。本脚本把两者分开统计，不合并
 *     （依据 routes/corrections.js:3552「首查到 READ 固化自身行」）
 *   - 全程只 SELECT + GET，不 UPDATE、不发消息
 *   - 外呼串行 + 间隔，撞限流即停止并报告已完成部分
 */

'use strict';

const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');

// live 模式要解密 system_configs 里的钉钉凭证，密钥在 wbs-server/.env。
// 从 .env 读而不是从命令行传——避免密钥出现在命令历史 / SSH 日志里。
try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }); } catch (_) { /* 无 dotenv 时靠外部 env */ }

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DB_PATH = argOf('--db', process.env.DB_PATH || path.resolve(__dirname, '..', 'task_pool.db'));
const LIVE = argv.includes('--live');
const LIMIT = Number(argOf('--limit', '80'));            // live 模式最多外呼多少条
const GAP_MS = Number(argOf('--gap-ms', '350'));         // 外呼间隔
const DENSITY_DAYS = Number(argOf('--density-days', '30'));
// readStatus 可回溯窗口：2026-09-04 生产实测约 7 天（0-7.0 天可查，7.0 天起返回空列表），
// 不是 utils/dingtalk-notify.js:395 注释声称的 24h。默认取 156h（6.5 天）留边界余量——
// 过期不报错而是静默返回空列表，取太满会把「查不到」混进「未读」。
const FRESH_HOURS = Number(argOf('--fresh-hours', '156'));
const OUT = argOf('--out', '');
const ENCRYPTION_KEY = process.env.DB_ENCRYPTION_KEY || '';   // 不留默认回退值（2026-08-26 凭证泄露闭环·与 server.js 同 fail-closed 口径）

const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);
const all = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const get = (sql, p = []) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));

// ---------- 通知列自动发现 ----------
// 命名约定：<prefix>message_key 配 <stem>notified_at / <stem>read_at / <stem>notified_user_name
async function discoverNotifyColumns() {
    const tables = (await all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")).map(t => t.name);
    const found = [];
    for (const t of tables) {
        let cols;
        try { cols = await all('PRAGMA table_info("' + t + '")'); } catch (_) { continue; }
        const names = cols.map(c => c.name);
        for (const kc of names.filter(n => /message_key$/.test(n))) {
            const prefix = kc.replace(/message_key$/, '');           // 如 requester_notify_
            const stem = prefix.replace(/notify_$/, '');             // 如 requester_
            // 关键：只在 stem 为空（即本列就是通用 notify_message_key）时才允许匹配无前缀的通用列。
            // 否则 intake_notify_message_key 这种会 fallback 到别的通道的 notified_at，
            // 把 136 条 intake 通知算进错误的时间列（2026-09-04 生产实测抓到）。
            const pick = (...cands) => cands
                .filter(c => c !== null)
                .find(c => names.includes(c)) || null;
            const generic = s => (stem === '' ? s : null);
            found.push({
                table: t,
                keyCol: kc,
                sentCol: pick(stem + 'notified_at', stem + 'notify_at', prefix + 'at', generic('notified_at')),
                readCol: pick(stem + 'read_at', prefix + 'read_at', generic('read_at')),
                nameCol: pick(stem + 'notified_user_name', stem + 'user_name', generic('notified_user_name'), generic('user_name')),
                label: t + '.' + kc
            });
        }
    }
    return found;
}

function pct(arr, p) {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}
const fmtH = v => v === null ? '-' : (v < 1 ? Math.round(v * 60) + 'min' : v.toFixed(1) + 'h');

// ---------- 主流程 ----------
(async () => {
    const report = { db: DB_PATH, generatedAt: new Date().toISOString(), mode: LIVE ? 'live' : 'inventory' };
    const chans = await discoverNotifyColumns();

    // ---- 1. 各通知通道盘点 ----
    const rows = [];
    const delaysAll = [];
    const skipped = [];                                               // 扫描面自证：被跳过的列必须显式报出来，不能静默漏
    for (const c of chans) {
        if (!c.sentCol) {
            // 有 message_key 但配不出发送时间列——可能是命名不合约定，需人工确认是否漏统计
            const n = await get('SELECT COUNT(*) AS n FROM "' + c.table + '" WHERE "' + c.keyCol + '" IS NOT NULL AND "' + c.keyCol + '" != \'\'');
            skipped.push({ 通道: c.label, 有数据条数: (n && n.n) || 0, 原因: '未找到配对的发送时间列' });
            continue;
        }
        const readExpr = c.readCol ? '"' + c.readCol + '" IS NOT NULL' : '0';
        const q = await get(
            'SELECT COUNT(*) AS sent, SUM(CASE WHEN ' + readExpr + ' THEN 1 ELSE 0 END) AS read_fixed ' +
            'FROM "' + c.table + '" WHERE "' + c.sentCol + '" IS NOT NULL ' +
            'AND "' + c.keyCol + '" IS NOT NULL AND "' + c.keyCol + '" != \'\'');
        if (!q || !q.sent) {
            // message_key 有值但发送时间列为空 → 也是漏统计，同样报出来（数据质量信号）
            const n = await get('SELECT COUNT(*) AS n FROM "' + c.table + '" WHERE "' + c.keyCol + '" IS NOT NULL AND "' + c.keyCol + '" != \'\'');
            if (n && n.n > 0) skipped.push({ 通道: c.label, 有数据条数: n.n, 原因: '发送时间列 ' + c.sentCol + ' 为空' });
            continue;
        }
        let delays = [];
        let delayDropped = 0;                                          // 被排除的样本数（负值/超 30 天/时间列为空）
        if (c.readCol) {
            const d = await all(
                'SELECT (julianday("' + c.readCol + '") - julianday("' + c.sentCol + '")) * 24 AS h ' +
                'FROM "' + c.table + '" WHERE "' + c.readCol + '" IS NOT NULL');
            const usable = d.map(r => r.h).filter(h => h !== null && h >= 0 && h < 24 * 30);
            delayDropped = d.length - usable.length;                   // read_at 有值但算不出延迟的
            delays = usable;
            delaysAll.push(...delays);
        }
        rows.push({
            通道: c.label,
            已发送: q.sent,
            已固化已读: q.read_fixed || 0,
            '固化率%': q.sent ? Math.round((q.read_fixed || 0) / q.sent * 100) : 0,
            p50延迟: fmtH(pct(delays, 0.5)),
            p90延迟: fmtH(pct(delays, 0.9)),
            延迟样本: delays.length + (delayDropped ? '(弃' + delayDropped + ')' : '')
        });
    }
    rows.sort((a, b) => b.已发送 - a.已发送);
    report.channels = rows;

    console.log('\n=== 通知通道盘点（DB: ' + DB_PATH + '）===');
    console.log('发现 ' + chans.length + ' 个通知列，其中 ' + rows.length + ' 个有实发数据\n');
    console.table(rows);

    const totalSent = rows.reduce((s, r) => s + r.已发送, 0);
    const totalFixed = rows.reduce((s, r) => s + r.已固化已读, 0);
    console.log('\n合计已发送 ' + totalSent + ' 条；其中 ' + totalFixed + ' 条被查证已读（' +
        (totalSent ? Math.round(totalFixed / totalSent * 100) : 0) + '%）');
    console.log('注意：剩余 ' + (totalSent - totalFixed) + ' 条是「未读」和「从没人去查」的混合体，纯库内分不开。');
    console.log('已读延迟（全通道合并，仅已固化样本 n=' + delaysAll.length + '）：p50=' + fmtH(pct(delaysAll, 0.5)) +
        '  p75=' + fmtH(pct(delaysAll, 0.75)) + '  p90=' + fmtH(pct(delaysAll, 0.9)));
    report.delayOverall = { p50: pct(delaysAll, 0.5), p75: pct(delaysAll, 0.75), p90: pct(delaysAll, 0.9), n: delaysAll.length };

    // 扫描面自证：跳过的列里若有实发数据，说明统计面不完整，必须人工补
    const skippedWithData = skipped.filter(s => s.有数据条数 > 0);
    report.skipped = skipped;
    if (skippedWithData.length) {
        console.log('\n[扫描面告警] 以下通知列有实发数据但未纳入统计（命名不合约定，需人工确认）：');
        console.table(skippedWithData);
    } else if (skipped.length) {
        console.log('\n（' + skipped.length + ' 个通知列无发送时间列且零数据，已跳过——不影响统计完整性）');
    }

    // ---- 2. 消息密度（病因 C：消息太多导致免疫）----
    const perName = new Map();
    for (const c of chans) {
        if (!c.sentCol || !c.nameCol) continue;
        const d = await all(
            'SELECT "' + c.nameCol + '" AS nm, COUNT(*) AS n FROM "' + c.table + '" ' +
            'WHERE "' + c.sentCol + '" IS NOT NULL AND "' + c.nameCol + '" IS NOT NULL AND "' + c.nameCol + '" != \'\' ' +
            'AND julianday(\'now\',\'localtime\') - julianday("' + c.sentCol + '") <= ' + DENSITY_DAYS + ' ' +
            'GROUP BY "' + c.nameCol + '"');
        for (const r of d) perName.set(r.nm, (perName.get(r.nm) || 0) + r.n);
    }
    const densityKey = '近' + DENSITY_DAYS + '天条数';
    const density = [...perName.entries()]
        .map(([nm, n]) => ({ 收件人: nm, [densityKey]: n, 日均: (n / DENSITY_DAYS).toFixed(1) }))
        .sort((a, b) => b[densityKey] - a[densityKey]);
    report.density = density;
    if (density.length) {
        console.log('\n=== 收件人消息密度（近 ' + DENSITY_DAYS + ' 天，仅统计带收件人姓名列的通道）===');
        console.table(density.slice(0, 15));
    } else {
        console.log('\n（无带收件人姓名列的通道，密度统计跳过——收件人只能从钉钉 readStatus 返回里拿）');
    }

    // ---- 3. 24h 窗口内待查清单 ----
    const fresh = [];
    for (const c of chans) {
        if (!c.sentCol) continue;
        const d = await all(
            'SELECT rowid AS rid, "' + c.keyCol + '" AS mk, "' + c.sentCol + '" AS sent_at' +
            (c.readCol ? ', "' + c.readCol + '" AS read_at' : '') +
            ' FROM "' + c.table + '" WHERE "' + c.keyCol + '" IS NOT NULL AND "' + c.keyCol + '" != \'\' ' +
            'AND "' + c.sentCol + '" IS NOT NULL ' +
            'AND (julianday(\'now\',\'localtime\') - julianday("' + c.sentCol + '")) * 24 < ' + FRESH_HOURS + ' ' +
            'ORDER BY "' + c.sentCol + '" DESC');
        for (const r of d) fresh.push(Object.assign({}, r, { channel: c.label }));
    }
    console.log('\n=== 可回溯窗口（' + FRESH_HOURS + 'h）内待查消息：' + fresh.length + ' 条 ===');
    report.freshCount = fresh.length;

    if (!LIVE) {
        console.log('（inventory 模式结束。加 --live 可对上面这批做真实已读查询）');
        if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(report, null, 2));
        db.close();
        return;
    }

    // ---- 4. live：真实查已读 + 顺带实测回溯窗口 ----
    const dingtalk = require(path.resolve(__dirname, '..', 'utils', 'dingtalk-notify.js'));
    const decrypt = (enc) => {
        if (Buffer.byteLength(ENCRYPTION_KEY, 'utf8') < 32) {
            console.error('[ABORT] 未设 DB_ENCRYPTION_KEY 或不足 32 字节。本脚本不提供默认回退值'
                + '（2026-08-26 凭证泄露闭环后与 server.js 同口径 fail-closed）。'
                + '请带与目标库一致的密钥执行：DB_ENCRYPTION_KEY=xxx node scripts/probe-notify-read-diagnosis.js --live');
            process.exit(2);
        }
        const parts = enc.split(':');
        const dec = crypto.createDecipheriv('aes-256-cbc',
            Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), Buffer.from(parts[0], 'hex'));
        return dec.update(parts[1], 'hex', 'utf8') + dec.final('utf8');
    };
    const cfg = {};
    for (const k of ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code']) {
        const row = await get('SELECT config_value_encrypted FROM system_configs WHERE config_key = ?', [k]);
        try {
            cfg[k] = row && row.config_value_encrypted ? decrypt(row.config_value_encrypted) : null;
        } catch (_) { cfg[k] = null; }
    }
    if (!cfg.dingtalk_app_key || !cfg.dingtalk_app_secret || !cfg.dingtalk_robot_code) {
        console.error('[ABORT] 钉钉凭证读取失败（多半是 DB_ENCRYPTION_KEY 与本库不匹配）。live 模式必须在凭证所属环境执行。');
        db.close();
        process.exit(2);
    }
    const token = await dingtalk.getAccessToken(cfg.dingtalk_app_key, cfg.dingtalk_app_secret);

    const targets = fresh.slice(0, LIMIT);
    console.log('\n开始查询 ' + targets.length + ' 条（间隔 ' + GAP_MS + 'ms，只读 API）…');
    const perPerson = new Map();
    const perPair = new Map();                                        // (收件人 × 通道) 交叉：区分「人不看」和「某类消息不值得看」
    const arrivals = [];                                              // 全部送达时刻 + 是否已读：验证「到达时不在工位」假设必须带对照组，
                                                                      // 否则「未读多在非工位时段」可能只是因为消息本来就多发在非工位时段
    const details = [];
    for (const t of targets) {
        try {
            const r = await dingtalk.getReadStatus(token, cfg.dingtalk_robot_code, t.mk);
            if (r.raw && r.raw.errcode && r.raw.errcode !== 0) {
                details.push(Object.assign({}, t, { ok: false, err: r.raw.errcode + ' ' + (r.raw.errmsg || '') }));
            } else {
                const list = r.readDetails || [];
                for (const it of list) {
                    const k = it.name || it.userId;
                    const cur = perPerson.get(k) || { 收件人: k, 收到: 0, 已读: 0, 延迟h: [] };
                    cur.收到++;
                    if (it.readStatus === 'READ') {
                        cur.已读++;
                        if (it.readTimestamp && t.sent_at) {
                            // 单位兼容归一，与 server.js:12777（codex 12 M-3「不凭印象 *1000」）同源
                            const ts = Number(it.readTimestamp) || 0;
                            const ms = ts > 1e12 ? ts : (ts > 1e9 ? ts * 1000 : 0);
                            if (ms) {
                                const h = (ms - new Date(String(t.sent_at).replace(' ', 'T')).getTime()) / 3600000;
                                if (h >= 0 && h < 48) cur.延迟h.push(h);
                            }
                        }
                    }
                    perPerson.set(k, cur);

                    const pk = k + ' | ' + t.channel;
                    const pv = perPair.get(pk) || { 收件人: k, 通道: t.channel, 收到: 0, 未读: 0 };
                    pv.收到++;
                    if (it.readStatus !== 'READ') pv.未读++;
                    perPair.set(pk, pv);
                    // 送达时刻 + 已读与否：用来验证「消息到达时人不在工位 ⇒ 提醒被浪费 ⇒ 回工位后沉底漏看」
                    arrivals.push({ 收件人: k, 通道: t.channel, 送达: t.sent_at, 已读: it.readStatus === 'READ' });
                }
                details.push(Object.assign({}, t, { ok: true, n: list.length, read: list.filter(x => x.readStatus === 'READ').length }));
            }
        } catch (e) {
            details.push(Object.assign({}, t, { ok: false, err: e.message }));
            if (/rate|限流|90018/i.test(e.message)) { console.error('撞限流，提前结束'); break; }
        }
        if (GAP_MS) await new Promise(r => setTimeout(r, GAP_MS));
    }

    const live = [...perPerson.values()].map(v => ({
        收件人: v.收件人,
        收到: v.收到,
        已读: v.已读,
        '已读率%': v.收到 ? Math.round(v.已读 / v.收到 * 100) : 0,
        p50延迟: fmtH(pct(v.延迟h, 0.5)),
        p90延迟: fmtH(pct(v.延迟h, 0.9))
    })).sort((a, b) => a['已读率%'] - b['已读率%']);
    console.log('\n=== 窗口内真实已读情况（按已读率升序，最上面的最该关注）===');
    console.table(live);
    const fails = details.filter(d => !d.ok);
    // 空列表 ≠ 未读：超过回溯窗口的消息钉钉不报错，静默返回空 messageReadInfoList。
    // 这批必须从统计里摘出来单独报，混进「未读」会直接把结论带偏。
    const empties = details.filter(d => d.ok && d.n === 0);
    report.live = { perPerson: live, failures: fails, emptyCount: empties.length, queried: details.length };
    if (empties.length) {
        console.log('\n[窗口外] ' + empties.length + '/' + details.length +
            ' 条返回空收件人列表（= 超出可回溯窗口，不是未读），已排除出上表统计。');
    }

    // 未读明细按 (人 × 通道) 拆开：全通道都不看 = 人的问题；只某通道不看 = 那类消息的问题
    const unreadPairs = [...perPair.values()].filter(p => p.未读 > 0)
        .sort((a, b) => b.未读 - a.未读 || a.收件人.localeCompare(b.收件人));
    report.live.unreadByPair = unreadPairs;
    if (unreadPairs.length) {
        console.log('\n=== 未读明细（收件人 × 通道）===');
        console.table(unreadPairs);
    } else {
        console.log('\n窗口内零未读。');
    }

    // ---- 送达时刻 × 是否已读（带对照组）----
    // 业务前提（2026-09-04 用户确认）：只在 PC 端处理，不在工位允许不处理。
    // 于是「消息到达时人在不在工位」就是可检验的机制假设——钉钉只在到达那一刻提醒一次，
    // 错过就沉底不再提醒；待办是状态，回工位仍可见。
    const WORK_START = Number(argOf('--work-start', '8.5'));           // 默认 8:30
    const WORK_END = Number(argOf('--work-end', '17.5'));              // 默认 17:30
    const inWork = (s) => {
        const d = new Date(String(s).replace(' ', 'T'));
        if (isNaN(d)) return null;
        const dow = d.getDay();
        if (dow === 0 || dow === 6) return false;                      // 周末
        const h = d.getHours() + d.getMinutes() / 60;
        return h >= WORK_START && h < WORK_END;
    };
    const tagged = arrivals.map(a => ({ ...a, 工位时段: inWork(a.送达) }));
    const grp = (list) => {
        const valid = list.filter(x => x.工位时段 !== null);
        const off = valid.filter(x => !x.工位时段).length;
        return { n: valid.length, off, pct: valid.length ? Math.round(off / valid.length * 100) : 0 };
    };
    const gRead = grp(tagged.filter(x => x.已读));
    const gUnread = grp(tagged.filter(x => !x.已读));
    console.log('\n=== 送达时刻检验（工位时段 ' + WORK_START + '–' + WORK_END + '，周末计为非工位）===');
    console.table([
        { 分组: '已读消息', 样本: gRead.n, 非工位时段送达: gRead.off, '占比%': gRead.pct },
        { 分组: '未读消息', 样本: gUnread.n, 非工位时段送达: gUnread.off, '占比%': gUnread.pct }
    ]);
    console.log('读法：未读组的「非工位时段送达占比」显著高于已读组 ⇒ 支持「到达时不在工位就漏掉」的机制；');
    console.log('      两组占比接近 ⇒ 漏看与送达时刻无关，得另找原因。');
    report.arrivalCheck = { workStart: WORK_START, workEnd: WORK_END, read: gRead, unread: gUnread };
    const unreadList = tagged.filter(x => !x.已读)
        .map(x => ({ 收件人: x.收件人, 通道: x.通道.split('.')[0], 送达: x.送达, 工位时段: x.工位时段 ? '是' : '否' }));
    if (unreadList.length) {
        console.log('\n未读消息逐条送达时刻：');
        console.table(unreadList);
    }
    if (fails.length) {
        console.log('\n失败 ' + fails.length + ' 条（含回溯窗口证据）：');
        console.table(fails.slice(0, 10).map(f => ({ 通道: f.channel, 发送时间: f.sent_at, 错误: f.err })));
    }

    // ---- 5. 回溯窗口实测（--probe-window）----
    // utils/dingtalk-notify.js:395 注释声称「钉钉端约定消息发出后 24h 内可查」。
    // 那是文档声称，不是实测结论；而它直接决定「历史能不能回溯诊断」和「升级阶梯的判定时限」，
    // 所以按年龄分桶各取几条真查一次，用返回码把边界钉死。
    if (argv.includes('--probe-window')) {
        const buckets = [
            { name: '<24h', lo: 0, hi: 1 },
            { name: '24-48h', lo: 1, hi: 2 },
            { name: '2-7天', lo: 2, hi: 7 },
            { name: '7-30天', lo: 7, hi: 30 },
            { name: '>30天', lo: 30, hi: 3650 }
        ];
        const perBucket = Number(argOf('--window-samples', '3'));
        const winRows = [];
        for (const b of buckets) {
            const samples = [];
            for (const c of chans) {
                if (!c.sentCol || samples.length >= perBucket) continue;
                const d = await all(
                    'SELECT "' + c.keyCol + '" AS mk, "' + c.sentCol + '" AS sent_at, ' +
                    '(julianday(\'now\',\'localtime\') - julianday("' + c.sentCol + '")) AS age_d ' +
                    'FROM "' + c.table + '" WHERE "' + c.keyCol + '" IS NOT NULL AND "' + c.keyCol + '" != \'\' ' +
                    'AND "' + c.sentCol + '" IS NOT NULL ' +
                    'AND (julianday(\'now\',\'localtime\') - julianday("' + c.sentCol + '")) >= ' + b.lo + ' ' +
                    'AND (julianday(\'now\',\'localtime\') - julianday("' + c.sentCol + '")) < ' + b.hi + ' ' +
                    'ORDER BY "' + c.sentCol + '" DESC LIMIT ' + (perBucket - samples.length));
                for (const r of d) samples.push(Object.assign({}, r, { channel: c.label }));
            }
            for (const s of samples) {
                let verdict;
                try {
                    const r = await dingtalk.getReadStatus(token, cfg.dingtalk_robot_code, s.mk);
                    if (r.raw && r.raw.errcode && r.raw.errcode !== 0) verdict = '错误 ' + r.raw.errcode + ' ' + (r.raw.errmsg || '');
                    else if ((r.readDetails || []).length) verdict = '可查（' + r.readDetails.length + ' 收件人）';
                    else verdict = '响应正常但收件人列表为空';
                } catch (e) { verdict = '异常 ' + e.message; }
                winRows.push({ 年龄段: b.name, 实际天数: Number(s.age_d).toFixed(1), 通道: s.channel, 结果: verdict });
                if (GAP_MS) await new Promise(r => setTimeout(r, GAP_MS));
            }
            if (!samples.length) winRows.push({ 年龄段: b.name, 实际天数: '-', 通道: '-', 结果: '无样本' });
        }
        console.log('\n=== readStatus 回溯窗口实测 ===');
        console.table(winRows);
        report.window = winRows;
    }

    if (OUT) require('fs').writeFileSync(OUT, JSON.stringify(report, null, 2));
    db.close();
})().catch(e => { console.error('ERR', (e && e.stack) || e); process.exit(1); });
