// #77 C1b：验收记录 config_rev 保守回填迁移脚本（方案 v0.9 §5.2）。
//
// 模式（没有 --live）
//   --db <库文件>                          默认只读空跑：库以只读方式打开，零写入
//   --db <库文件> --apply --backup <新文件>  真正执行：先 VACUUM INTO 备份并核对，再补列、回填、写标记
//   --in-place                             只有同时带 --apply 与 --backup 时，才允许 --db 指向正式库 wbs-server/task_pool.db；
//                                          否则指向正式库一律拒绝（空跑 / 演练请先复制库文件）
//   --report <json 路径>                   输出「将变为需复验」清单与汇总；必须是不存在的新文件，且不得与正式库 / --db / --backup 相同，
//                                          所在目录须存在且可写（在任何读写之前校验）
//
// 部署用法（方案 §5.2 停服迁移）：停服 → 在 wbs-server 目录下执行
//   node scripts/migrate-model-config-rev.js --db task_pool.db --in-place --apply --backup <新文件> --report <新文件> [--revert <json> --operator <人>]
//   → 核对迁移标记 model_center_migrations(name='config_rev_backfill') → 启动新版本。
//   --revert 只能在迁移时使用；库已迁移后再带 --revert 会报错（迁移后放行需重新验收）。
//   --revert <json 路径> [--operator <名>]  用户事后确认「那次改动不涉及产出」的模型 id 清单（JSON 数组或 {"ids":[...]}）；
//                                          只允许改回「仅由推定证据触发」的模型，含确证证据的 id 整体报错、零改动
//
// 原则（方案 §5.2）：宁可多标需复验，不可漏标。证据分确证 / 推定；证据时刻「严格晚于」验收的 test_time 才触发。
// 同一事务内完成：回填 + 应用 --revert + 写迁移标记 model_center_migrations(name='config_rev_backfill')，三者同生同灭。
// 标记存在 => 幂等退出（已迁移，不做任何改动）。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite = require('sqlite3');
const { evaluateAcceptance, extractPhase } = require('../routes/model-center/acceptance');

const LIVE_DB = path.resolve(__dirname, '../task_pool.db');
const MARKER_NAME = 'config_rev_backfill';

// 与 server.js 启动补列（C1a）逐字一致
const ADD_COL_DATA_MODELS = 'ALTER TABLE data_models ADD COLUMN config_rev INTEGER NOT NULL DEFAULT 1';
const ADD_COL_TEST_RECORDS = 'ALTER TABLE model_test_records ADD COLUMN config_rev INTEGER';

// 方案 §4.1.1 A 表里 basic_info 日志可比对的字段（不含 layer：PUT 不写 layer）
const A_FIELDS = ['table_name', 'source_system', 'source_table', 'update_cycle', 'config_mode'];

const REQUIRED_SCHEMA = {
    // 末次合并审 M13：补上 readAndPlan 实际读取的 layer（data_models）与 total_rows（model_test_records）——缺列时在 checkSchema 就明确报错，而不是读取时抛 SQL 错误
    data_models: ['id', 'table_name', 'layer', 'script_saved_at', 'script_modified_at', 'is_deleted', 'deleted_at', 'companion_of'],
    model_test_records: ['id', 'model_id', 'test_time', 'overall_result', 'detail_json', 'total_rows'],
    model_change_logs: ['id', 'model_id', 'action', 'change_type', 'before_value', 'after_value', 'created_at']
};

// ---------------------------------------------------------------- 工具

/**
 * 两个路径是否指向同一文件。
 * bigint：Windows 文件 id 为 64 位，普通 number 的 ino 会丢精度。
 * 任一侧 ino 为 0n（文件系统不提供可靠 inode）时无法用 ino 判定：
 *   - 比较对象是正式库（isLive=true）：一律按「同一文件」处理（拒绝方向，宁可误拒不可漏拒）；
 *   - 其他路径：dev + size + mtimeNs + birthtimeNs 全等才判同一。
 */
function sameFile(a, b, isLive) {
    if (a.toLowerCase() === b.toLowerCase()) return true;
    if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
    const x = fs.statSync(a, { bigint: true });
    const y = fs.statSync(b, { bigint: true });
    if (x.ino === 0n || y.ino === 0n) {
        if (isLive) return true;
        return x.dev === y.dev && x.size === y.size && x.mtimeNs === y.mtimeNs && x.birthtimeNs === y.birthtimeNs;
    }
    return x.dev === y.dev && x.ino === y.ino;
}

/** 允许 --db 指向正式库的唯一条件：--in-place 且 --apply 且 --backup 三者齐备 */
function validatePath(file, opts, liveDb) {
    if (!file) throw new Error('必须显式给出 --db <离线副本路径>');
    const resolved = fs.realpathSync(path.resolve(file));
    if (!fs.statSync(resolved).isFile()) throw new Error('--db 必须是已存在的普通库文件');
    if (sameFile(resolved, liveDb, true)) {
        const o = opts || {};
        if (!(o.inPlace && o.apply && o.backup)) {
            throw new Error('拒绝指向 wbs-server/task_pool.db：原地迁移必须同时带 --in-place --apply --backup <新文件>；空跑 / 演练请把库文件复制到别处再指向它');
        }
    }
    return resolved;
}

/** 新文件路径规范化：目录必须存在（realpath 后与文件名拼回），用于与其他路径比较 */
function canonicalNewPath(p, label) {
    const abs = path.resolve(p);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) throw new Error(`${label} 所在目录不存在: ${dir}`);
    return path.join(fs.realpathSync(dir), path.basename(abs));
}

/** 校验 --backup（必须是新文件）：在任何读写之前 */
function validateBackupPath(backup, dbResolved, liveDb) {
    const target = canonicalNewPath(backup, '--backup');
    if (fs.existsSync(target)) throw new Error('--backup 必须是一个新文件: ' + target);
    if (sameFile(target, dbResolved) || sameFile(target, liveDb, true)) throw new Error('--backup 不得与库文件相同: ' + target);
    return target;
}

/** 校验 --report：新文件、不得与正式库 / --db / --backup 相同、目录存在且可写；在任何读写之前 */
function validateReportPath(report, dbResolved, backupTarget, liveDb) {
    const target = canonicalNewPath(report, '--report');
    if (sameFile(target, liveDb, true)) throw new Error('--report 不得指向正式库 wbs-server/task_pool.db: ' + target);
    if (sameFile(target, dbResolved)) throw new Error('--report 不得与 --db 相同: ' + target);
    if (backupTarget && sameFile(target, backupTarget)) throw new Error('--report 不得与 --backup 相同: ' + target);
    if (fs.existsSync(target)) throw new Error('--report 必须是一个不存在的新文件: ' + target);
    try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch (e) { throw new Error('--report 所在目录不可写: ' + path.dirname(target)); }
    return target;
}

function openDb(file, mode) {
    return new Promise((resolve, reject) => {
        const db = new sqlite.Database(file, mode, e => (e ? reject(e) : resolve(db)));
    });
}
const closeDb = db => new Promise((resolve, reject) => db.close(e => (e ? reject(e) : resolve())));
const makeAll = db => (sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => (e ? reject(e) : resolve(rows))));
const makeRun = db => (sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this); }));

/** 时间规范化：仅接受 YYYY-MM-DD HH:MM:SS（也容忍 T 分隔），且必须是真实日期时间；否则 null */
function normalizeTime(value) {
    if (typeof value !== 'string') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
    if (!m) return null;
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
    const probe = new Date(0);
    probe.setUTCFullYear(y, mo - 1, d);
    probe.setUTCHours(h, mi, s, 0);
    const ok = probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d
        && probe.getUTCHours() === h && probe.getUTCMinutes() === mi && probe.getUTCSeconds() === s;
    if (!ok) return null;
    return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}

async function tableColumns(all, table) {
    return (await all(`PRAGMA table_info(${table})`)).map(c => c.name);
}

async function checkSchema(all) {
    const present = {};
    for (const [table, columns] of Object.entries(REQUIRED_SCHEMA)) {
        const actual = await tableColumns(all, table);
        if (actual.length === 0) throw new Error('缺少必需的表: ' + table);
        for (const c of columns) if (!actual.includes(c)) throw new Error(`缺少必需的列: ${table}.${c}`);
        present[table] = actual;
    }
    return present;
}

async function readMarker(all) {
    const tbl = await all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_center_migrations'");
    if (tbl.length === 0) return null;
    const rows = await all('SELECT name, done_at, detail FROM model_center_migrations WHERE name = ?', [MARKER_NAME]);
    return rows.length > 0 ? rows[0] : null;
}

// ---------------------------------------------------------------- 证据收集

const hasKey = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 空串 / NULL / undefined 视同空；config_mode 空值视同 standard（与 server.js PUT 的 C1a 口径一致） */
function normField(field, v) {
    const e = (v === undefined || v === null || v === '') ? null : v;
    if (field === 'config_mode' && e === null) return 'standard';
    return e;
}

/** basic_info 日志：返回 'confirmed' | 'excluded' | 'presumed'（方案 §5.2 证据表第 2 行） */
function evaluateBasicInfo(beforeRaw, afterRaw) {
    let before;
    let after;
    try { before = JSON.parse(beforeRaw); } catch (_) { return 'presumed'; }
    try { after = JSON.parse(afterRaw); } catch (_) { return 'presumed'; }
    if (!isPlainObject(before) || !isPlainObject(after)) return 'presumed';
    let missing = false;
    for (const f of A_FIELDS) {
        if (hasKey(before, f) && hasKey(after, f)) {
            if (JSON.stringify(normField(f, before[f])) !== JSON.stringify(normField(f, after[f]))) return 'confirmed';
        } else {
            missing = true;
        }
    }
    return missing ? 'presumed' : 'excluded';
}

/**
 * 逐模型收集「配置改动时刻」证据。
 * 证据项：{ time: 'YYYY-MM-DD HH:MM:SS' | null, source, qualification: 'confirmed'|'presumed', note, log_id }
 * time 为 null 表示「存在改动证据但时刻无法解析」——一律降为推定，并视为晚于该模型的任何验收（宁可多标）。
 */
function collectEvidence(models, logs) {
    const byModel = new Map(models.map(m => [Number(m.id), []]));
    const stats = { unknown_model_logs: 0, basic_info_excluded: 0, note_ignored: 0 };

    const push = (modelId, rawTime, source, qualification, extra) => {
        const list = byModel.get(Number(modelId));
        if (!list) return false;
        const time = normalizeTime(rawTime);
        const item = Object.assign({ time, source, qualification, note: '' }, extra || {});
        if (time === null) {
            item.qualification = 'presumed';
            item.note = (item.note ? item.note + '；' : '') + '时间无法解析，按推定处理';
            item.raw_time = rawTime == null ? null : String(rawTime);
        }
        list.push(item);
        return true;
    };

    for (const log of logs) {
        if (!byModel.has(Number(log.model_id))) { stats.unknown_model_logs++; continue; }
        const ct = String(log.change_type == null ? '' : log.change_type).toLowerCase();
        const tokens = ct.split(/[,\s]+/).filter(Boolean);
        const action = String(log.action == null ? '' : log.action).toUpperCase();
        // action 为 NOTE 的日志一律不作证据，不论 change_type：
        //   方案 §5.2 证据表第 1 行字面写「change_type 含 dim_config」未限 action，而 §4.1.1 B 表明确「备注 NOTE 不触发」，
        //   两处措辞有张力；2026-10-01 主会话裁定取 B 表（生产有 6 条 NOTE 的 change_type 含 dim_config，备注不代表配置被改）。
        if (action === 'NOTE') { stats.note_ignored++; continue; }
        const extra = { log_id: log.id, action };
        let confirmed = null;
        let presumed = false;
        if (ct.includes('dim_config')) confirmed = 'change_log:dim_config';
        else if (tokens.includes('script_init')) confirmed = 'change_log:script_init';
        else if (tokens.includes('script_edit')) confirmed = 'change_log:script_edit';
        else if (action === 'RESTORE' || tokens.includes('restore')) confirmed = 'change_log:restore';
        if (tokens.includes('basic_info')) {
            const verdict = evaluateBasicInfo(log.before_value, log.after_value);
            if (verdict === 'confirmed' && !confirmed) confirmed = 'change_log:basic_info';
            else if (verdict === 'presumed') presumed = true;
            else if (verdict === 'excluded' && !confirmed) stats.basic_info_excluded++;
        }
        // 同一条日志只产出一条证据：确证优先于推定
        if (confirmed) push(log.model_id, log.created_at, confirmed, 'confirmed', extra);
        else if (presumed) push(log.model_id, log.created_at, 'change_log:basic_info', 'presumed', Object.assign({ note: '缺字段无法判断' }, extra));
        // 兜底（推定）：DELETE 日志（删除前的状态不可知）；change_type 为空的 UPDATE 日志（无法判断改了什么）
        else if (action === 'DELETE') push(log.model_id, log.created_at, 'change_log:delete', 'presumed', Object.assign({ note: '删除日志，删除前状态不可知' }, extra));
        else if (action === 'UPDATE' && ct.trim() === '') push(log.model_id, log.created_at, 'change_log:update_untyped', 'presumed', Object.assign({ note: 'change_type 为空，无法判断改了什么' }, extra));
    }

    for (const m of models) {
        // 只有最近一次的时间；save-scripts 不写日志且可能是重新生成同样内容 => 推定
        if (m.script_saved_at != null && String(m.script_saved_at).trim() !== '') {
            push(m.id, m.script_saved_at, 'models.script_saved_at', 'presumed');
        }
        if (m.script_modified_at != null && String(m.script_modified_at).trim() !== '') {
            push(m.id, m.script_modified_at, 'models.script_modified_at', 'presumed');
        }
        // 伴生表被删回写主表（7660，不写日志）：以 companion_of = 主表 id 且已软删的伴生行 deleted_at 为时刻 => 推定
        if (m.companion_of != null && Number(m.is_deleted) === 1) {
            push(m.companion_of, m.deleted_at, 'companion_deleted_at', 'presumed', { note: `伴生行 id=${m.id}` });
        }
    }
    return { byModel, stats };
}

// ---------------------------------------------------------------- 判定与清单

// ODS 验收 pass / warn 后前端会立刻 autoSaveOdsScripts -> save-scripts，于是 script_saved_at 紧跟验收是正常流程而非改配置。
// 生产副本实测（2026-10-01，94 个有 script_saved_at 的 ODS 模型）：与「其之前最近一条验收」的时间差全部落在 0–1 秒
// （88 个 0 秒、6 个 1 秒），没有 >1 秒的；DIM / DWD 的时间差全部 >1 小时（或之前无验收记录），说明该现象只属于 ODS。
// 窗口 W 取 10 秒：覆盖实测最大值 1 秒并留足余量，同时远小于人工改配置后再保存的正常间隔。DIM / DWD 不适用。
const AUTOSAVE_WINDOW_SECONDS = 10;

function secondsBetween(later, earlier) {
    const p = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16), +s.slice(17, 19));
    return (p(later) - p(earlier)) / 1000;
}

/**
 * 给 ODS 模型的 script_saved_at 证据标注 autosave_from：锚点 = 「test_time <= S 的最晚一条 pass / warn 验收」a，
 * 且 a <= S <= a+W 才成立（fail 记录不作锚点；窗口内有两个锚点时取晚的那个，早的锚点对应记录仍按推定置 0）。
 */
function markAutosaveEvidence(modelById, records, evidenceByModel) {
    const timesByModel = new Map();
    for (const rec of records) {
        // 锚点候选须同时满足（与判定服务同口径）：pass / warn；未作废（invalidated 非 1 / '1'）；参与判定阶段
        // （这里只服务 ODS：ODS 仅无 phase 的记录参与，带 phase 的记录——含 semantic——不作锚点）
        if (rec.overall_result !== 'pass' && rec.overall_result !== 'warn') continue;
        if (!(rec.invalidated === 0 || rec.invalidated == null || rec.invalidated === '0')) continue;
        const phase = extractPhase(rec.detail_json);
        if (phase != null && phase !== '') continue;
        const t = normalizeTime(rec.test_time);
        if (t === null) continue;
        const k = Number(rec.model_id);
        if (!timesByModel.has(k)) timesByModel.set(k, []);
        timesByModel.get(k).push(t);
    }
    for (const [modelId, list] of evidenceByModel) {
        const model = modelById.get(modelId);
        if (!model || String(model.layer == null ? '' : model.layer).toUpperCase() !== 'ODS') continue;
        const times = timesByModel.get(modelId) || [];
        for (const e of list) {
            if (e.source !== 'models.script_saved_at' || e.time === null) continue;
            const before = times.filter(a => a <= e.time).sort();
            const anchor = before.length > 0 ? before[before.length - 1] : null;
            if (anchor !== null && secondsBetween(e.time, anchor) <= AUTOSAVE_WINDOW_SECONDS) e.autosave_from = anchor;
        }
    }
}

// 伪证据：test_time 缺失 / 无法解析。qualification 记推定，但 revert_blocked=true：不允许 --revert（按「含确证」同等处理）
const PSEUDO_TEST_TIME = { time: null, source: 'record.test_time', qualification: 'presumed', revert_blocked: true, note: 'test_time 为空或无法解析，按需复验' };

function toMs(t) {
    return Date.UTC(+t.slice(0, 4), +t.slice(5, 7) - 1, +t.slice(8, 10), +t.slice(11, 13), +t.slice(14, 16), +t.slice(17, 19));
}

/**
 * 证据 e 是否「晚于」记录（test_time = t）：严格晚于 t；或无法解析时刻；
 * 或证据时刻落在 [t - execution_time_ms, t) 内（验收进行中改配置；execution_time_ms 缺失按 0，即退回「严格晚于」原规则）。
 */
function evidenceAfterRecord(e, t, execMs) {
    if (e.time === null || e.time > t) return true;
    // 下界再放宽 1 秒：证据与 test_time 都只精确到秒，取整会让真实在窗口内的证据被截在外面
    return execMs > 0 && e.time < t && toMs(e.time) >= toMs(t) - execMs - 1000;
}

/**
 * 计算：每条待回填记录的目标值（1 / 0）、触发证据；汇总出「将变为需复验」的模型清单。
 * 规则：晚于 test_time 的确证或推定时刻 => 0（严格大于；同秒不触发）；test_time 为空或无法解析 => 0。
 */
// records = 待回填记录（config_rev 为 NULL，写入计划只遍历它）；allRecords = 该库全量记录（仅供自动保存锚点选取，非 NULL 记录绝不被改写）
function computePlan(models, records, evidenceByModel, allRecords) {
    const modelById = new Map(models.map(m => [Number(m.id), m]));
    const perRecord = [];
    let orphan = 0;
    const autosaveExcluded = new Set();
    markAutosaveEvidence(modelById, allRecords || records, evidenceByModel);
    for (const rec of records) {
        const modelId = Number(rec.model_id);
        if (!modelById.has(modelId)) {
            // 不属于任何在册模型的孤儿记录（如同名重注册后旧 id 的记录）：保守置 0，不进模型清单
            perRecord.push({ id: rec.id, model_id: rec.model_id, value: 0, triggers: [], orphan: true });
            orphan++;
            continue;
        }
        const t = normalizeTime(rec.test_time);
        let triggers;
        if (t === null) {
            triggers = [PSEUDO_TEST_TIME];
        } else {
            const execRaw = Number(rec.execution_time_ms);
            const execMs = Number.isFinite(execRaw) && execRaw > 0 ? execRaw : 0;
            const raw = (evidenceByModel.get(modelId) || []).filter(e => evidenceAfterRecord(e, t, execMs));
            // 「排除·验收后自动保存」：对这条及更晚的记录，该证据不成立；对更早的记录仍按推定。
            // 只在 t <= 证据时刻 时排除：证据落在验收进行中（t 晚于证据）不属于「验收后」的自动保存，保守照常触发
            triggers = raw.filter(e => !(e.autosave_from && t >= e.autosave_from && t <= e.time));
            if (triggers.length !== raw.length) autosaveExcluded.add(modelId);
        }
        perRecord.push({ id: rec.id, model_id: rec.model_id, value: triggers.length > 0 ? 0 : 1, triggers, orphan: false });
    }

    const flagged = new Map();
    for (const pr of perRecord) {
        if (pr.orphan || pr.value !== 0) continue;
        const mid = Number(pr.model_id);
        if (!flagged.has(mid)) flagged.set(mid, { id: mid, table_name: modelById.get(mid).table_name, record_ids: [], evidence: new Set() });
        const entry = flagged.get(mid);
        entry.record_ids.push(pr.id);
        for (const e of pr.triggers) entry.evidence.add(e);
    }
    const manifest = [];
    for (const entry of flagged.values()) {
        const evidence = Array.from(entry.evidence)
            .sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || a.source.localeCompare(b.source));
        manifest.push({
            id: entry.id,
            table_name: entry.table_name,
            affected_records: entry.record_ids.length,
            presumed_only: evidence.every(e => e.qualification === 'presumed' && !e.revert_blocked),
            evidence: evidence.map(e => {
                const o = { time: e.time, source: e.source, qualification: e.qualification };
                if (e.revert_blocked) o.revert_blocked = true;
                if (e.note) o.note = e.note;
                if (e.log_id != null) o.log_id = e.log_id;
                if (e.action) o.action = e.action;
                if (e.raw_time !== undefined) o.raw_time = e.raw_time;
                return o;
            }),
            record_ids: entry.record_ids
        });
    }
    manifest.sort((a, b) => a.id - b.id);
    return { perRecord, manifest, orphan, autosaveExcludedModels: autosaveExcluded.size };
}

function parseRevertFile(file) {
    const raw = fs.readFileSync(path.resolve(file), 'utf8').replace(/^﻿/, '');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw new Error('--revert 文件不是合法 JSON: ' + e.message); }
    const list = Array.isArray(parsed) ? parsed : (isPlainObject(parsed) && Array.isArray(parsed.ids) ? parsed.ids : null);
    if (!list) throw new Error('--revert 文件必须是 id 数组，或形如 {"ids":[...]} 的对象');
    const ids = [];
    for (const v of list) {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0 || typeof v === 'boolean' || v === null || v === '') {
            throw new Error('--revert 含非法模型 id: ' + JSON.stringify(v));
        }
        if (!ids.includes(n)) ids.push(n);
    }
    return ids;
}

/** 校验 --revert：id 必须在清单里，且「仅由推定证据触发」；任一不满足整体报错 */
function validateRevert(revertIds, manifest) {
    const byId = new Map(manifest.map(m => [m.id, m]));
    const notListed = revertIds.filter(id => !byId.has(id));
    if (notListed.length > 0) {
        throw new Error('--revert 含不在「需复验清单」里的模型 id（未被本次回填置 0）: ' + notListed.join(','));
    }
    const confirmed = revertIds.filter(id => !byId.get(id).presumed_only);
    if (confirmed.length > 0) {
        throw new Error('--revert 含有确证证据（或验收时间缺失 / 无法解析，同等处理）的模型 id，不提供改回（整体不应用）: ' + confirmed.join(','));
    }
}

function summarize(plan, recordsTotal, recordsToFill) {
    // 收口批 2 LOW-5：带 --revert 放行后，被放行的模型（manifest 行 reverted: true）已不再被置 0，不能继续算进「需复验」口径的各项统计——
    //   它们另列在 models_reverted（buildReport / 迁移标记 detail）。这里所有按清单行统计的项一律只数未放行的行（`live`）；没有 --revert 时 reverted 恒为空，口径与旧版一致。
    const live = plan.manifest.filter(m => !m.reverted);
    const byEvidence = {};
    for (const m of live) {
        for (const e of m.evidence) {
            const key = `${e.source}|${e.qualification}`;
            byEvidence[key] = (byEvidence[key] || 0) + 1;
        }
    }
    const zero = plan.perRecord.filter(p => p.value === 0).length;
    return {
        models_flagged: live.length,
        models_presumed_only: live.filter(m => m.presumed_only).length,
        // 注意：models_with_confirmed = 非「仅推定」的模型，含 revert_blocked 伪证据（test_time 缺失 / 无法解析）的模型，
        // 后者另有 models_with_revert_blocked 单独计数
        models_with_confirmed: live.filter(m => !m.presumed_only).length,
        models_with_revert_blocked: live.filter(m => m.evidence.some(e => e.revert_blocked)).length,
        deleted_models_flagged: live.filter(m => m.deleted).length,
        records_total: recordsTotal,
        records_to_backfill: recordsToFill,
        records_set_zero: zero,
        records_set_one: plan.perRecord.length - zero,
        orphan_records_set_zero: plan.orphan,
        autosave_excluded_models: plan.autosaveExcludedModels,
        current_affected_models: live.filter(m => m.current_affected).length,
        current_affected_with_confirmed: live.filter(m => m.current_affected && !m.presumed_only).length,
        current_affected_presumed_only: live.filter(m => m.current_affected && m.presumed_only).length,
        flagged_old_records_only_unchanged: live.filter(m => m.current_unchanged_valid).length,
        flagged_already_not_passing: live.filter(m => !m.deleted && !m.current_affected && !m.current_unchanged_valid).length,
        evidence_triggering_by_type: byEvidence
    };
}

// ---------------------------------------------------------------- 「当前判定是否受影响」标注

const SOURCE_LABEL = {
    'change_log:dim_config': 'dim_config 变更',
    'change_log:script_init': '脚本初始化',
    'change_log:script_edit': '脚本编辑',
    'change_log:restore': '模型恢复',
    'change_log:basic_info': '基础信息变更（缺字段无法判断是否涉及配置）',
    'change_log:delete': '模型删除日志',
    'change_log:update_untyped': '未标注类型的更新日志',
    'models.script_saved_at': '脚本保存',
    'models.script_modified_at': '脚本人工修改',
    'companion_deleted_at': '伴生表被删除',
    'record.test_time': '验收时间缺失或无法解析'
};
const isPassingState = s => s === 'pass' || s === 'warn';

/**
 * 对清单里每个模型分别算「迁移前视角」（假设所有记录都属当前版本）与「迁移后」（按本次回填值）的 evaluateAcceptance，
 * 迁移前通过（pass / warn）而迁移后不通过 => current_affected = true。并写一句人话原因。清单按 current_affected 降序、id 升序。
 */
function annotateCurrentAffected(plan, models, allRecords) {
    const modelById = new Map(models.map(m => [Number(m.id), m]));
    const recsByModel = new Map();
    // 喂入该模型的全量记录：迁移前视角全部视为当前版本；迁移后视角只把本次计划回填的 NULL 记录替换为 0 / 1，已有非 NULL 记录保留原值
    for (const r of allRecords) {
        const k = Number(r.model_id);
        if (!recsByModel.has(k)) recsByModel.set(k, []);
        recsByModel.get(k).push(r);
    }
    const valueById = new Map(plan.perRecord.map(p => [p.id, p]));
    for (const entry of plan.manifest) {
        const model = modelById.get(entry.id);
        const recs = recsByModel.get(entry.id) || [];
        const base = { id: entry.id, layer: model.layer, companion_of: model.companion_of };
        const before = evaluateAcceptance(Object.assign({ config_rev: 1 }, base), recs.map(r => Object.assign({}, r, { config_rev: 1 })));
        const afterModelRev = model.config_rev != null ? model.config_rev : 1;
        const after = evaluateAcceptance(Object.assign({}, base, { config_rev: afterModelRev }), recs.map(r => (valueById.has(r.id) ? Object.assign({}, r, { config_rev: valueById.get(r.id).value }) : r)));
        // 已软删模型不参与判定（方案 §4.1.2），不标 current_affected；回填值不变，清单行带 deleted 标记
        const deleted = Number(model.is_deleted) === 1;
        const affected = !deleted && isPassingState(before.state) && !isPassingState(after.state);
        entry.state_before = before.state;
        entry.state_after = after.state;
        entry.deleted = deleted;
        entry.current_affected = affected;
        entry.current_unchanged_valid = !deleted && isPassingState(before.state) && isPassingState(after.state);
        const zeroed = entry.record_ids.map(id => valueById.get(id)).filter(Boolean);
        const times = zeroed.map(z => normalizeTime((recs.find(r => r.id === z.id) || {}).test_time)).filter(Boolean).sort();
        if (deleted) {
            entry.reason = '模型已删除（is_deleted=1），不参与验收判定，不计入当前判定影响；记录仍按规则回填';
        } else if (affected) {
            // 最近一次被置 0 的验收之后，第一个触发它的证据
            const latestRec = recs.filter(r => valueById.has(r.id) && valueById.get(r.id).value === 0 && normalizeTime(r.test_time))
                .sort((a, b) => normalizeTime(b.test_time).localeCompare(normalizeTime(a.test_time)))[0];
            const trig = latestRec ? valueById.get(latestRec.id).triggers.slice().sort((a, b) => (a.qualification === 'confirmed' ? 0 : 1) - (b.qualification === 'confirmed' ? 0 : 1) || String(a.time || '').localeCompare(String(b.time || '')))[0] : null;
            if (trig) {
                const lt = normalizeTime(latestRec.test_time);
                const when = trig.time && trig.time <= lt ? `验收进行中（${lt} 之前）` : `最近一次验收 ${lt} 之后`;
                entry.reason = `${when}有 ${SOURCE_LABEL[trig.source] || trig.source} ${trig.time || '（时间无法解析）'}（${trig.qualification === 'confirmed' ? '确证' : '推定'}）`;
            } else {
                entry.reason = '最近一次验收被置为需复验（test_time 缺失或无法解析）';
            }
        } else if (entry.current_unchanged_valid) {
            entry.reason = `仅较早的 ${zeroed.length} 条旧记录被置 0（${times[0] || '?'} 至 ${times[times.length - 1] || '?'}），当前验收仍有效`;
        } else {
            entry.reason = `迁移前判定本就不是通过（${before.state}），置 0 不改变可用性`;
        }
    }
    plan.manifest.sort((a, b) => (b.current_affected ? 1 : 0) - (a.current_affected ? 1 : 0) || a.id - b.id);
}

// ---------------------------------------------------------------- 读取 + 计算（只读）

async function readAndPlan(all, present) {
    const hasModelRevCol = present.data_models.includes('config_rev');
    const models = await all(`SELECT id, table_name, layer, script_saved_at, script_modified_at, is_deleted, deleted_at, companion_of${hasModelRevCol ? ', config_rev' : ''} FROM data_models`);
    const logs = await all('SELECT id, model_id, action, change_type, before_value, after_value, created_at FROM model_change_logs ORDER BY id');
    const hasRevCol = present.model_test_records.includes('config_rev');
    const hasInvCol = present.model_test_records.includes('invalidated');
    const hasExecCol = present.model_test_records.includes('execution_time_ms');
    const allRecords = await all(`SELECT id, model_id, test_time, overall_result, detail_json, total_rows${hasInvCol ? ', invalidated' : ''}${hasExecCol ? ', execution_time_ms' : ''}${hasRevCol ? ', config_rev' : ''} FROM model_test_records ORDER BY id`);
    // 只回填尚为 NULL 的记录：新版本写入的记录已带验收开始时的真实版本号，不得被覆盖
    const records = hasRevCol ? allRecords.filter(r => r.config_rev == null) : allRecords;
    const { byModel, stats } = collectEvidence(models, logs);
    const plan = computePlan(models, records, byModel, allRecords);
    annotateCurrentAffected(plan, models, allRecords);
    let evidenceCollected = 0;
    for (const list of byModel.values()) evidenceCollected += list.length;
    return { models, allRecords, plan, recordsTotal: allRecords.length, recordsToFill: records.length, evidenceCollected, stats };
}

/**
 * 末次合并审 M13：带 --revert 时，报告与迁移标记里的统计必须按「放行后实际写入的值」重算（旧写法用放行前的计划，records_set_zero / current_affected 等与库内实际不符）。
 * 返回 { post, beforeRevert }：
 *   post = 放行后视角的 computed 副本（被放行模型的记录值改回 1、清单行标 reverted: true / affected_records 0 / record_ids 空，再按放行后的值重跑 annotateCurrentAffected——state_after / current_affected / reason 都重算）；
 *   beforeRevert = { summary, models }：放行前的汇总与清单（另存为报告的 plan_before_revert，便于对照）。
 * 没有 --revert 时 post 就是原 computed，beforeRevert 为 null。放行规则与应用循环一致：只改「值为 0 且非孤儿」且模型在放行集合里的记录。
 */
function computeAfterRevert(computed, revertIds) {
    if (!revertIds) return { post: computed, beforeRevert: null };
    const revertSet = new Set(revertIds);
    const beforeRevert = {
        summary: summarize(computed.plan, computed.recordsTotal, computed.recordsToFill),
        models: computed.plan.manifest.map(m => Object.assign({}, m))
    };
    const flipped = p => p.value === 0 && !p.orphan && revertSet.has(Number(p.model_id));
    const perRecord = computed.plan.perRecord.map(p => (flipped(p) ? Object.assign({}, p, { value: 1 }) : p));
    const stillZero = new Set(perRecord.filter(p => p.value === 0).map(p => p.id));
    const priorReason = new Map(computed.plan.manifest.map(m => [m.id, m.reason]));
    const manifest = computed.plan.manifest.map(m => {
        const reverted = revertSet.has(m.id);
        const ids = reverted ? m.record_ids.filter(id => stillZero.has(id)) : m.record_ids;
        return Object.assign({}, m, { reverted, record_ids: ids, affected_records: ids.length });
    });
    const plan = Object.assign({}, computed.plan, { perRecord, manifest });
    const post = Object.assign({}, computed, { plan });
    annotateCurrentAffected(plan, computed.models, computed.allRecords);
    for (const m of plan.manifest) {
        if (m.reverted) m.reason = `已按 --revert 放行（用户确认改动不涉及产出，记录改回 1，不再需复验）；放行前：${priorReason.get(m.id)}`;
    }
    return { post, beforeRevert };
}

function buildReport(mode, dbFile, computed, revertIds, operator, beforeRevert) {
    const report = {
        mode,
        db: dbFile,
        generated_at: new Date().toISOString(),
        summary: Object.assign(
            summarize(computed.plan, computed.recordsTotal, computed.recordsToFill),
            { evidence_collected: computed.evidenceCollected, unknown_model_logs: computed.stats.unknown_model_logs, basic_info_excluded: computed.stats.basic_info_excluded, note_ignored: computed.stats.note_ignored },
            revertIds ? { models_reverted: computed.plan.manifest.filter(m => m.reverted).length } : {}
        ),
        revert: revertIds ? { ids: revertIds, operator: operator || null } : null,
        models: computed.plan.manifest
    };
    if (beforeRevert) report.plan_before_revert = beforeRevert;   // 放行前的汇总与清单；report.summary / report.models 是放行后的实际
    return report;
}

// ---------------------------------------------------------------- 备份

// fault 仅测试用：'integrity' 让 integrity_check 结果被替换为损坏值；'rowcount' 让备份行数多 1，用于验证两道核对都会中止 --apply
async function takeVerifiedBackup(db, all, backup, fault) {
    const target = path.resolve(backup);
    if (fs.existsSync(target)) throw new Error('--backup 必须是一个新文件: ' + target);
    if (!fs.existsSync(path.dirname(target))) throw new Error('--backup 所在目录不存在: ' + path.dirname(target));
    await new Promise((resolve, reject) => db.run('VACUUM INTO ?', [target], e => (e ? reject(e) : resolve())));
    const copy = await openDb(target, sqlite.OPEN_READONLY);
    try {
        const copyAll = makeAll(copy);
        const [realCheck] = await copyAll('PRAGMA integrity_check');
        const check = fault === 'integrity' ? { integrity_check: '故障注入：损坏' } : realCheck;
        if (!check || check.integrity_check !== 'ok') throw new Error('备份 integrity_check 未通过: ' + JSON.stringify(check));
        for (const table of Object.keys(REQUIRED_SCHEMA)) {
            const [a] = await all(`SELECT count(*) AS n FROM ${table}`);
            const [b] = await copyAll(`SELECT count(*) AS n FROM ${table}`);
            if (a.n !== b.n + (fault === 'rowcount' ? 1 : 0)) throw new Error('备份行数与源库不一致: ' + table);
        }
    } finally {
        await closeDb(copy);
    }
    return target;
}

// ---------------------------------------------------------------- 入口

/**
 * @param {object} options
 *   db        离线库文件（必填；拒绝 wbs-server/task_pool.db）
 *   apply     true 才写库（默认只读空跑）
 *   backup    --apply 必填：新文件路径，VACUUM INTO 备份
 *   report    可选：清单 JSON 输出路径
 *   revert    可选：确认清单 JSON 路径
 *   operator  --revert 且 --apply 时必填：操作人，写入迁移标记
 *   __faultBeforeMarker  仅测试用：回填与 revert 之后、写标记之前抛错，用于验证同事务回滚
 */
async function runWith(liveDb, options = {}) {
    const apply = !!options.apply;
    if (options.live) throw new Error('本脚本不提供 --live：请把 --db 指向停服后的库文件副本路径');
    if (options.backup && !apply) throw new Error('--backup 只用于 --apply');
    if (apply && !options.backup) throw new Error('--apply 必须给 --backup <新文件>');
    if (options.revert && apply && !options.operator) throw new Error('--revert 配合 --apply 时必须给 --operator <操作人>');
    // 以下全部发生在任何库读写之前：库路径（含正式库闸门）、备份路径、报告路径
    const resolved = validatePath(options.db, { inPlace: !!options.inPlace, apply, backup: options.backup }, liveDb);
    const backupTarget = apply ? validateBackupPath(options.backup, resolved, liveDb) : null;
    const reportTarget = options.report ? validateReportPath(options.report, resolved, backupTarget, liveDb) : null;
    const revertIds = options.revert ? parseRevertFile(options.revert) : null;
    const warnings = [];
    // 空跑写报告失败 => 抛错（非 0 退出，报告就是空跑的产出）；--apply 时库已提交，报告失败只进 warnings
    const writeReport = report => {
        if (!reportTarget) return;
        try {
            if (options.__faultReportWrite) throw new Error('故障注入：报告写入失败');
            fs.writeFileSync(reportTarget, JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' });
        } catch (e) {
            if (!apply) throw new Error('报告写入失败: ' + e.message);
            warnings.push('报告写入失败（库已提交，状态不受影响）: ' + e.message);
        }
    };

    // 第一步：只读探查（标记检查 + 计算 + revert 校验）。任何失败都发生在改库之前。
    const peek = await openDb(resolved, sqlite.OPEN_READONLY);
    let marker;
    let computed;
    try {
        const peekAll = makeAll(peek);
        marker = await readMarker(peekAll);
        if (marker && revertIds) throw new Error('已迁移，--revert 只能在迁移时使用；迁移后放行需重新验收');
        if (!marker) {
            const present = await checkSchema(peekAll);
            computed = await readAndPlan(peekAll, present);
            if (revertIds) validateRevert(revertIds, computed.plan.manifest);
        }
    } catch (err) {
        try { await closeDb(peek); } catch (closeErr) { err.message += `（另：关闭库失败: ${closeErr.message}）`; }
        throw err;
    }
    await closeDb(peek);

    if (marker) {
        return { status: 'already-migrated', message: `已迁移：${MARKER_NAME} 已于 ${marker.done_at} 完成，未做任何改动`, marker_done_at: marker.done_at };
    }

    if (!apply) {
        const afterDry = computeAfterRevert(computed, revertIds);   // M13：带 --revert 时统计按放行后的值算
        const report = buildReport('dry-run', resolved, afterDry.post, revertIds, options.operator, afterDry.beforeRevert);
        writeReport(report);
        return { status: 'dry-run', report, warnings };
    }

    const db = await openDb(resolved, sqlite.OPEN_READWRITE);
    const all = makeAll(db);
    const exec = makeRun(db);
    let inTxn = false;
    let primary = null;
    let committed = false;
    try {
        const backupFile = await takeVerifiedBackup(db, all, backupTarget, options.__faultBackup);

        // 补列与建表（在 BEGIN IMMEDIATE 之前执行）：已存在则跳过，重跑幂等。
        //   末次合并审 H8 措辞订正：此前注释 / 方案写的「SQLite 的 ADD COLUMN 只能在事务外执行」不符合事实——探针已证 ADD COLUMN 可以在事务内执行、随 ROLLBACK 回退（DDL 事务性）。
        //   这里在事务之前执行是现状选择（本批不移动 DDL）：补列成功而后面失败时留下「有列无标记」状态，与新版 server.js 启动自己补这两列后的状态相同，重跑会跳过已存在的列继续迁移，回退恢复 --backup 备份即可。
        const dmCols = await tableColumns(all, 'data_models');
        if (!dmCols.includes('config_rev')) await exec(ADD_COL_DATA_MODELS);
        const trCols = await tableColumns(all, 'model_test_records');
        if (!trCols.includes('config_rev')) await exec(ADD_COL_TEST_RECORDS);
        await exec('CREATE TABLE IF NOT EXISTS model_center_migrations (name TEXT PRIMARY KEY, done_at TEXT, detail TEXT)');

        await exec('BEGIN IMMEDIATE');
        inTxn = true;
        // 事务内再取一次标记与证据（权威结果；停服迁移下与只读探查一致）
        const again = await readMarker(all);
        if (again) { inTxn = false; await exec('ROLLBACK'); return { status: 'already-migrated', message: `已迁移：${MARKER_NAME} 已于 ${again.done_at} 完成，未做任何改动`, marker_done_at: again.done_at }; }
        const present = await checkSchema(all);
        const inTxnComputed = await readAndPlan(all, present);
        if (revertIds) validateRevert(revertIds, inTxnComputed.plan.manifest);

        const revertSet = new Set(revertIds || []);
        let written = 0;
        let revertedRecords = 0;
        let actualZero = 0;
        let actualOne = 0;
        for (const pr of inTxnComputed.plan.perRecord) {
            let value = pr.value;
            if (value === 0 && !pr.orphan && revertSet.has(Number(pr.model_id))) { value = 1; revertedRecords++; }
            const r = await exec('UPDATE model_test_records SET config_rev = ? WHERE id = ? AND config_rev IS NULL', [value, pr.id]);
            if (r.changes !== 1) throw new Error('回填时记录被并发修改: model_test_records#' + pr.id);
            if (value === 0) actualZero++; else actualOne++;
            written++;
        }

        if (options.__faultBeforeMarker) throw new Error('故障注入：写迁移标记之前失败');

        // M13：报告与标记里的统计按放行后实际写入的值重算；放行前的汇总 / 清单另存 plan_before_revert。事务内核对「重算结果 = 本事务实际写入的 0 / 1 条数」，不符整体回滚
        const afterRev = computeAfterRevert(inTxnComputed, revertIds);
        const summary = summarize(afterRev.post.plan, inTxnComputed.recordsTotal, inTxnComputed.recordsToFill);
        const preSummary = afterRev.beforeRevert ? afterRev.beforeRevert.summary : summary;
        if (summary.records_set_zero !== actualZero || summary.records_set_one !== actualOne) throw new Error(`报告统计与实际写入不符（重算 0/1 = ${summary.records_set_zero}/${summary.records_set_one}，实际写入 ${actualZero}/${actualOne}）`);
        const detail = {
            records_total: summary.records_total,
            records_backfilled: written,
            records_set_zero: summary.records_set_zero,
            records_set_one: summary.records_set_one,
            records_set_zero_before_revert: preSummary.records_set_zero,
            records_set_one_before_revert: preSummary.records_set_one,
            orphan_records_set_zero: summary.orphan_records_set_zero,
            models_flagged: summary.models_flagged,
            evidence_collected: inTxnComputed.evidenceCollected,
            evidence_triggering_by_type: summary.evidence_triggering_by_type,
            basic_info_excluded: inTxnComputed.stats.basic_info_excluded,
            note_ignored: inTxnComputed.stats.note_ignored,
            autosave_excluded_models: summary.autosave_excluded_models,
            current_affected_models: summary.current_affected_models,
            ...(revertIds ? { models_reverted: afterRev.post.plan.manifest.filter(m => m.reverted).length } : {}),   // 收口批 2 LOW-5：放行的模型另列，models_flagged 等不再含它们
            autosave_window_seconds: AUTOSAVE_WINDOW_SECONDS,
            revert: revertIds ? { ids: revertIds, operator: options.operator, records_reverted_to_one: revertedRecords } : null
        };
        await exec('INSERT INTO model_center_migrations (name, done_at, detail) VALUES (?, datetime(\'now\', \'localtime\'), ?)', [MARKER_NAME, JSON.stringify(detail)]);
        await exec('COMMIT');
        inTxn = false;
        committed = true;

        const report = buildReport('apply', resolved, afterRev.post, revertIds, options.operator, afterRev.beforeRevert);
        report.backup = backupFile;
        report.applied = { records_backfilled: written, records_reverted_to_one: revertedRecords };
        writeReport(report);
        return { status: 'applied', report, warnings };
    } catch (err) {
        primary = err;
        // ROLLBACK 失败不得顶替原始错误：先置 inTxn=false 防二次回滚，回滚错误附在原错误上
        if (inTxn) {
            inTxn = false;
            try { await exec('ROLLBACK'); } catch (rbErr) { err.message += `（另：ROLLBACK 失败: ${rbErr.message}）`; }
        }
        throw err;
    } finally {
        try {
            if (options.__faultClose) throw new Error('故障注入：关闭库失败');
            await closeDb(db);
        } catch (closeErr) {
            if (primary) primary.message += `（另：关闭库失败: ${closeErr.message}）`;
            else if (committed) warnings.push(`关闭库失败（COMMIT 已成功，迁移结果不受影响）: ${closeErr.message}`);
            else throw closeErr;
        }
    }
}

/**
 * 正式库路径只能通过这里注入（测试用假库）；命令行入口用模块默认的 run，不接受任何覆盖正式库路径的参数。
 */
function createRunner(config) {
    const liveDb = path.resolve(config && config.liveDb ? config.liveDb : LIVE_DB);
    return { run: options => runWith(liveDb, options), liveDb };
}
const DEFAULT_RUNNER = createRunner({ liveDb: LIVE_DB });
const run = DEFAULT_RUNNER.run;

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function parseArgs(argv) {
    const usage = '用法: --db <离线库副本> [--report <json>] [--revert <json> --operator <名>] [--apply --backup <新文件> [--in-place]]（默认只读空跑；不提供 --live；指向正式库须同时带 --in-place --apply --backup）';
    const out = {};
    const take = (i, name) => {
        if (out[name] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(usage);
        out[name] = argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply' && !out.apply) out.apply = true;
        else if (a === '--in-place' && !out.inPlace) out.inPlace = true;
        else if (a === '--live') throw new Error('本脚本不提供 --live：请把 --db 指向停服后的库文件副本路径');
        else if (['--db', '--backup', '--report', '--revert', '--operator'].includes(a)) { take(i, a.slice(2)); i++; }
        else throw new Error(usage);
    }
    return out;
}

function printResult(result) {
    for (const w of result.warnings || []) console.error('警告: ' + w);
    if (result.status === 'already-migrated') { console.log(result.message); return; }
    const r = result.report;
    console.log(`模式: ${r.mode}  目标: ${r.db}`);
    console.log('汇总: ' + JSON.stringify(r.summary, null, 2));
    if (r.applied) console.log('已应用: ' + JSON.stringify(r.applied) + '  备份: ' + r.backup);
    if (r.mode === 'dry-run') console.log('（只读空跑，库未改动；加 --apply --backup <新文件> 才会写入）');
}

if (require.main === module) {
    (async () => {
        try {
            const opts = parseArgs(process.argv.slice(2));
            const result = await run(opts);
            printResult(result);
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    })();
}

// DEFAULT_LIVE_DB：默认正式库路径（wbs-server/task_pool.db）；DEFAULT_RUNNER_LIVE_DB：模块级 run 实际使用的正式库路径，供测试核对二者一致
// DEFAULT_RUNNER 整体导出：测试断言 run === DEFAULT_RUNNER.run，锁住「命令行实际调用的 run」而不只是一个路径常量（预筛 2026-10-01 MED-1）
module.exports = { run, createRunner, DEFAULT_RUNNER, DEFAULT_LIVE_DB: LIVE_DB, DEFAULT_RUNNER_LIVE_DB: DEFAULT_RUNNER.liveDb, normalizeTime, evaluateBasicInfo, collectEvidence, computePlan, sha256File, A_FIELDS, MARKER_NAME, AUTOSAVE_WINDOW_SECONDS };
