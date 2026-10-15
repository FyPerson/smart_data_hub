// #77 C1b：config_rev 保守回填迁移脚本（scripts/migrate-model-config-rev.js）验证。纯 node：
// 在临时目录里自建 sqlite 夹具库（不碰 task_pool.db、不起服务），跑完删除自建文件。
// 可选 --tmp <目录> 指定临时根目录（默认系统临时目录）。
//
// 边界（写明）：证据时刻「严格晚于」验收 test_time 才触发；同秒（证据时刻 = test_time）不算晚于，不触发。
'use strict';
const fs = require('fs');
const { spawnSync } = require('child_process');
const os = require('os');
const path = require('path');
const sqlite = require('sqlite3');
const migrate = require('./migrate-model-config-rev');
const { evaluateAcceptance, fetchRecordsByModelId } = require('../routes/model-center/acceptance');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
    if (cond) { pass++; return; }
    fail++;
    console.log(`FAIL: ${name}${detail === undefined ? '' : ' — ' + detail}`);
}
const j = v => JSON.stringify(v);

const tmpArg = process.argv.indexOf('--tmp');
const tmpRoot = tmpArg > -1 ? process.argv[tmpArg + 1] : os.tmpdir();
const workDir = fs.mkdtempSync(path.join(tmpRoot, 'mc77-c1b-verify-'));
let seq = 0;
const fresh = name => path.join(workDir, `${++seq}-${name}`);

function open(file, mode) {
    return new Promise((resolve, reject) => { const db = new sqlite.Database(file, mode || sqlite.OPEN_READWRITE | sqlite.OPEN_CREATE, e => (e ? reject(e) : resolve(db))); });
}
const runSql = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (e) { e ? reject(e) : resolve(this); }));
const allSql = (db, sql, args = []) => new Promise((resolve, reject) => db.all(sql, args, (e, rows) => (e ? reject(e) : resolve(rows))));
const closeDb = db => new Promise((resolve, reject) => db.close(e => (e ? reject(e) : resolve())));

const T_TEST = '2026-09-10 12:00:00'; // 除特别说明外所有验收记录的 test_time
const T_LATE = '2026-09-10 13:00:00';
const T_EARLY = '2026-09-10 11:00:00';

const FIVE = { table_name: 't', source_system: 'S', source_table: 'src', update_cycle: 'daily', config_mode: 'standard' };

/** 建夹具库。withRevCols=true 时两张表已带 config_rev 列（覆盖「列已存在则跳过」）。 */
async function buildFixture(file, withRevCols) {
    const db = await open(file);
    try { await fillFixture(db, withRevCols); } finally { await closeDb(db); }
}

async function fillFixture(db, withRevCols) {
    const revModels = withRevCols ? ', config_rev INTEGER NOT NULL DEFAULT 1' : '';
    const revRecords = withRevCols ? ', config_rev INTEGER' : '';
    await runSql(db, `CREATE TABLE data_models (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, layer TEXT, companion_of INTEGER, is_deleted INTEGER DEFAULT 0, deleted_at DATETIME, script_saved_at DATETIME, script_modified_at DATETIME${revModels})`);
    await runSql(db, `CREATE TABLE model_test_records (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER, table_name TEXT, test_time DATETIME, test_user TEXT, overall_result TEXT, total_rows INTEGER, detail_json TEXT, invalidated INTEGER DEFAULT 0, execution_time_ms INTEGER${revRecords})`);
    await runSql(db, 'CREATE TABLE model_change_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER, model_name TEXT, action TEXT NOT NULL, change_type TEXT, before_value TEXT, after_value TEXT, change_summary TEXT, operator_id INTEGER, operator_name TEXT, created_at DATETIME)');

    const model = (id, layer, extra) => runSql(db,
        'INSERT INTO data_models (id, table_name, layer, companion_of, is_deleted, deleted_at, script_saved_at, script_modified_at) VALUES (?,?,?,?,?,?,?,?)',
        [id, 't' + id, layer, extra.companion_of || null, extra.is_deleted || 0, extra.deleted_at || null, extra.saved || null, extra.modified || null]);
    const rec = (id, modelId, time, result, phase, execMs, invalidated) => runSql(db,
        'INSERT INTO model_test_records (id, model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, execution_time_ms, invalidated) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [id, modelId, 't' + modelId, time, 'u', result, 10, phase ? j({ phase }) : '{}', execMs === undefined ? null : execMs, invalidated || 0]);
    const log = (modelId, action, changeType, created, before, after) => runSql(db,
        'INSERT INTO model_change_logs (model_id, model_name, action, change_type, before_value, after_value, created_at) VALUES (?,?,?,?,?,?,?)',
        [modelId, 't' + modelId, action, changeType, before == null ? null : j(before), after == null ? null : j(after), created]);

    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
        await model(id, 'ODS', {
            saved: { 7: T_LATE, 9: '2026-09-10 11:30:00', 10: T_TEST }[id],
        });
    }
    await model(81, 'DWD', { companion_of: 8, is_deleted: 1, deleted_at: T_LATE }); // M8 的伴生行，已软删
    await model(16, 'DWD', {});
    await model(17, 'DWD', { saved: '2026-09-10 12:00:30' });
    // 验收后自动保存窗口（W = 10 秒，含边界）与 NOTE 不作证据
    await model(18, 'ODS', { saved: '2026-09-10 12:00:02' });  // 窗口内
    await model(19, 'ODS', { saved: '2026-09-10 12:00:03' });  // 窗口内，但对更早的记录仍推定
    await model(20, 'ODS', { saved: '2026-09-10 12:00:11' });  // 11 秒：窗口外
    await model(21, 'ODS', { saved: '2026-09-10 12:00:10' });  // 恰好 10 秒：窗口内（含边界）
    await model(22, 'DWD', { saved: '2026-09-10 12:00:02' });  // DWD 不适用该规则
    await model(23, 'ODS', {});                                // 只有 NOTE + dim_config 的日志
    await model(24, 'ODS', {});                                // 迁移前本就是 fail：置 0 不改变可用性
    await model(25, 'ODS', { modified: T_LATE });              // 只有晚于验收的 script_modified_at => 推定
    await model(26, 'ODS', { saved: '2026-09-10 12:00:08' });  // 窗口内两个锚点（12:00:00 与 12:00:05）：取晚的
    await model(27, 'ODS', { saved: '2026-09-10 12:00:02' });  // 最近一条是 fail：不作锚点
    await model(28, 'ODS', {});                                // DELETE 日志 => 推定
    await model(29, 'ODS', {});                                // change_type 为空的 UPDATE 日志 => 推定
    await model(30, 'ODS', {});                                // 证据落在验收进行中 [test_time - execution_time_ms, test_time)
    await model(31, 'ODS', {});                                // 证据在验收进行窗口之外
    await model(32, 'ODS', {});                                // execution_time_ms 缺失：退回严格晚于
    await model(33, 'ODS', { saved: '2026-09-10 12:00:02' }); // 自动保存排除只管验收后；验收进行中的保存照常触发
    await model(34, 'ODS', { saved: T_LATE });                 // 混合证据：确证 dim_config + 推定 script_saved_at 都晚于验收
    await model(35, 'ODS', { is_deleted: 1 });                 // 已软删模型：回填照常，但不标 current_affected
    await model(36, 'ODS', {});                                // 验收进行窗口下界（含放宽的 1 秒）恰在下界
    // ---- codex 21 / 21T：每个模型都「无其他证据兜底」，期望手写
    await model(37, 'ODS', { saved: '2026-09-10 12:00:02' });  // S1：作废的 pass 不作锚点
    await model(38, 'ODS', {});                                // T1：仅 script_init 确证
    await model(39, 'ODS', {});                                // T2：仅 action=RESTORE（change_type NULL）
    await model(40, 'ODS', {});                                // T2：仅 action=RESTORE（change_type 无关值）
    await model(41, 'ODS', {});                                // T2：仅 change_type=restore（action=UPDATE）
    await model(42, 'ODS', {});                                // T3：同一条日志 basic_info,dim_config 且缺字段
    await model(43, 'ODS', {});                                // T4：test_time 无法解析且无其他证据
    await model(44, 'ODS', { saved: '2026-09-10 12:00:10' });  // T6：warn 锚点，恰 10 秒
    await model(45, 'ODS', { saved: '2026-09-10 12:00:11' });  // T6：warn，11 秒对照
    await model(46, 'ODS', { modified: T_LATE });              // T7：两条置 0 记录的仅推定模型
    await model(47, 'DWD', { saved: '2026-09-10 12:00:02' }); // S1：DWD 的 semantic pass 不作锚点（且 DWD 不适用窗口）
    await model(48, 'ODS', { saved: '2026-09-10 12:00:02' });  // S1：ODS 上带 phase 的 pass 不作锚点

    // 验收记录（id = 模型 id * 10 + k）
    await rec(10, 1, T_TEST, 'pass');
    await rec(20, 2, T_TEST, 'pass');
    await rec(30, 3, T_TEST, 'pass');
    await rec(40, 4, T_TEST, 'pass');
    await rec(50, 5, T_TEST, 'pass');
    await rec(60, 6, T_TEST, 'pass');
    await rec(70, 7, T_TEST, 'pass');
    await rec(80, 8, T_TEST, 'pass');
    await rec(90, 9, T_TEST, 'pass');
    await rec(100, 10, T_TEST, 'pass');
    await rec(110, 11, T_TEST, 'pass');
    await rec(120, 12, null, 'pass');                 // test_time 为空
    await rec(130, 13, T_TEST, 'pass');
    await rec(140, 14, T_TEST, 'pass');               // 早于证据
    await rec(141, 14, '2026-09-10 14:00:00', 'pass'); // 晚于证据
    await rec(160, 16, '2026-09-10 12:00:00', 'pass', 'structure');
    await rec(161, 16, '2026-09-10 12:01:00', 'pass', 'data');
    await rec(170, 17, '2026-09-10 12:00:00', 'pass', 'structure'); // 早于 12:00:30 的 script_saved_at
    await rec(171, 17, '2026-09-10 12:01:00', 'pass', 'data');      // 晚于
    await rec(180, 18, T_TEST, 'pass');
    await rec(190, 19, '2026-09-10 11:00:00', 'pass'); // 更早的记录
    await rec(191, 19, T_TEST, 'pass');                // 自动保存锚点
    await rec(200, 20, T_TEST, 'pass');
    await rec(210, 21, T_TEST, 'pass');
    await rec(220, 22, '2026-09-10 12:00:00', 'pass', 'structure');
    await rec(221, 22, '2026-09-10 12:00:01', 'pass', 'data');
    await rec(230, 23, T_TEST, 'pass');
    await rec(240, 24, T_TEST, 'fail');
    await rec(250, 25, T_TEST, 'pass');
    await rec(260, 26, '2026-09-10 12:00:00', 'pass');
    await rec(261, 26, '2026-09-10 12:00:05', 'pass');
    await rec(270, 27, '2026-09-10 12:00:00', 'fail');
    await rec(280, 28, T_TEST, 'pass');
    await rec(290, 29, T_TEST, 'pass');
    await rec(300, 30, '2026-09-10 12:00:10', 'pass', null, 5000);
    await rec(310, 31, '2026-09-10 12:00:10', 'pass', null, 5000);
    await rec(320, 32, '2026-09-10 12:00:10', 'pass');
    await rec(330, 33, '2026-09-10 12:00:00', 'pass');
    await rec(331, 33, '2026-09-10 12:00:06', 'pass', null, 5000);
    await rec(340, 34, T_TEST, 'pass');
    await rec(370, 37, '2026-09-10 12:00:00', 'pass', null, undefined, 1); // invalidated=1
    await rec(380, 38, T_TEST, 'pass');
    await rec(390, 39, T_TEST, 'pass');
    await rec(400, 40, T_TEST, 'pass');
    await rec(410, 41, T_TEST, 'pass');
    await rec(420, 42, T_TEST, 'pass');
    await rec(430, 43, 'not-a-time', 'pass');
    await rec(440, 44, '2026-09-10 12:00:00', 'warn');
    await rec(450, 45, '2026-09-10 12:00:00', 'warn');
    await rec(460, 46, T_EARLY, 'pass');
    await rec(461, 46, T_TEST, 'pass');
    await rec(470, 47, '2026-09-10 12:00:00', 'pass', 'semantic');
    await rec(471, 47, '2026-09-10 11:00:00', 'pass', 'structure');
    await rec(472, 47, '2026-09-10 11:00:01', 'pass', 'data');
    await rec(480, 48, '2026-09-10 12:00:00', 'pass', 'structure');
    await rec(350, 35, T_TEST, 'pass');
    await rec(360, 36, '2026-09-10 12:00:10', 'pass', null, 5000);
    await rec(9990, 999, T_TEST, 'pass');             // 孤儿记录：model_id 不在 data_models

    // 变更日志
    await log(1, 'UPDATE', 'dim_config', T_LATE);
    await log(2, 'UPDATE', 'script_edit', T_LATE);
    await log(3, 'RESTORE', 'restore', T_LATE);
    await log(4, 'UPDATE', 'basic_info', T_LATE, { ...FIVE, source_table: 'A' }, { source_system: 'S', source_table: 'B' }); // source_table 变了 => 确证
    await log(5, 'UPDATE', 'basic_info', T_LATE, { ...FIVE, update_cycle: null }, { ...FIVE, update_cycle: '' });            // 五字段两边都含且未变（空 = NULL）=> 排除
    await log(6, 'UPDATE', 'basic_info', T_LATE, { ...FIVE }, { source_system: 'S', source_table: 'src' });                   // after 缺字段 => 推定
    await log(9, 'UPDATE', 'dim_config', T_EARLY);
    await log(10, 'UPDATE', 'dim_config', T_TEST);      // 同秒
    await log(11, 'UPDATE', 'dim_config', 'not-a-time'); // 无法解析
    await log(14, 'UPDATE', 'dim_config', T_LATE);
    await log(24, 'UPDATE', 'dim_config', T_LATE);
    await log(28, 'DELETE', 'full_delete', T_LATE);
    await log(29, 'UPDATE', null, T_LATE);
    await log(30, 'UPDATE', 'dim_config', '2026-09-10 12:00:07');
    // 窗口 = [test_time - execution_time_ms - 1s, test_time)：M30/M31/M36 的 test_time=12:00:10、exec=5000ms => 下界 12:00:04
    await log(31, 'UPDATE', 'dim_config', '2026-09-10 12:00:03');   // 下界外 1 秒：不触发
    await log(36, 'UPDATE', 'dim_config', '2026-09-10 12:00:04');   // 恰在下界：触发
    await log(35, 'UPDATE', 'dim_config', T_LATE);
    await log(38, 'CREATE', 'script_init', T_LATE);
    await log(39, 'RESTORE', null, T_LATE);
    await log(40, 'RESTORE', 'unrelated', T_LATE);
    await log(41, 'UPDATE', 'restore', T_LATE);
    await log(42, 'UPDATE', 'basic_info,dim_config', T_LATE, { ...FIVE }, { source_system: 'S' }); // after 缺字段：basic_info 单看只能推定，但 dim_config 命中 => 确证
    await log(32, 'UPDATE', 'dim_config', '2026-09-10 12:00:09');
    await log(34, 'UPDATE', 'dim_config', T_LATE);
    await log(23, 'NOTE', 'dim_config', T_LATE);        // NOTE 不论 change_type 一律不是证据（方案 B 表：备注不触发）
    await log(13, 'NOTE', 'manual_note', T_LATE);       // 备注不是证据
    await log(13, 'STATUS_CHANGE', 'status', T_LATE);   // 状态变更不是证据
    await log(999, 'UPDATE', 'dim_config', T_LATE);     // 不在册模型的日志：忽略
}

// 手写期望：记录 id -> 迁移后 config_rev
const EXPECT_REV = {
    10: 0, 20: 0, 30: 0, 40: 0, 50: 1, 60: 0, 70: 0, 80: 0, 90: 1, 100: 1, 110: 0, 120: 0, 130: 1,
    140: 0, 141: 1, 160: 1, 161: 1, 170: 0, 171: 1, 9990: 0,
    180: 1, 190: 0, 191: 1, 200: 0, 210: 1, 220: 0, 221: 0, 230: 1, 240: 0,
    250: 0, 260: 0, 261: 1, 270: 0, 280: 0, 290: 0, 300: 0, 310: 1, 320: 1, 330: 1, 331: 0, 340: 0, 350: 0, 360: 0,
    370: 0, 380: 0, 390: 0, 400: 0, 410: 0, 420: 0, 430: 0, 440: 1, 450: 0, 460: 0, 461: 0, 470: 0, 471: 0, 472: 0, 480: 0
};
const RECORD_TOTAL = Object.keys(EXPECT_REV).length;
const ZERO_TOTAL = Object.values(EXPECT_REV).filter(v => v === 0).length;
// 手写期望：迁移后各模型的判定 state（模型 config_rev 全为 1）
const EXPECT_STATE = {
    1: 'stale', 2: 'stale', 3: 'stale', 4: 'stale', 5: 'pass', 6: 'stale', 7: 'stale', 8: 'stale', 9: 'pass',
    10: 'pass', 11: 'stale', 12: 'stale', 13: 'pass', 14: 'pass', 15: 'none', 16: 'pass', 17: 'partial', 81: 'companion',
    18: 'pass', 19: 'pass', 20: 'stale', 21: 'pass', 22: 'stale', 23: 'pass', 24: 'none',
    25: 'stale', 26: 'pass', 27: 'none', 28: 'stale', 29: 'stale', 30: 'stale', 31: 'pass', 32: 'pass', 33: 'pass', 34: 'stale', 36: 'stale',
    37: 'none', 38: 'stale', 39: 'stale', 40: 'stale', 41: 'stale', 42: 'stale', 43: 'stale', 44: 'warn', 45: 'stale', 46: 'stale', 47: 'stale', 48: 'none'
};
// 手写期望：清单里的模型与「仅推定」标记（M12 的 test_time 缺失属伪证据，不允许 revert，按含确证同等处理；M34 混合证据）
const EXPECT_FLAGGED_CONFIRMED = [1, 2, 3, 4, 12, 14, 24, 30, 34, 35, 36, 38, 39, 40, 41, 42, 43];
// 手写期望：current_affected（迁移前通过、迁移后不通过；已软删的 M35 不计）
const EXPECT_AFFECTED = [1, 2, 3, 4, 6, 7, 8, 11, 12, 17, 20, 22, 25, 28, 29, 30, 34, 36, 38, 39, 40, 41, 42, 43, 45, 46, 47];
const EXPECT_AFFECTED_CONFIRMED = [1, 2, 3, 4, 12, 30, 34, 36, 38, 39, 40, 41, 42, 43];
const EXPECT_FLAGGED_PRESUMED_ONLY = [6, 7, 8, 11, 17, 19, 20, 22, 25, 26, 27, 28, 29, 33, 37, 45, 46, 47, 48];

const sha = f => migrate.sha256File(f);
const sortNum = a => a.slice().sort((x, y) => x - y);

async function readRevs(file) {
    const db = await open(file, sqlite.OPEN_READONLY);
    try {
        const rows = await allSql(db, 'SELECT id, config_rev FROM model_test_records ORDER BY id');
        return Object.fromEntries(rows.map(r => [r.id, r.config_rev]));
    } finally { await closeDb(db); }
}

async function evaluateAll(file) {
    const db = await open(file, sqlite.OPEN_READONLY);
    try {
        const models = await allSql(db, 'SELECT id, layer, config_rev, companion_of FROM data_models WHERE is_deleted = 0 OR is_deleted IS NULL OR id = 81');
        const out = {};
        for (const m of models) {
            const records = await fetchRecordsByModelId(db, m.id);
            out[m.id] = evaluateAcceptance(m, records);
        }
        return out;
    } finally { await closeDb(db); }
}

async function expectReject(name, fn, pattern) {
    try { await fn(); } catch (e) {
        check(name, pattern ? pattern.test(e.message) : true, e.message);
        return e;
    }
    check(name, false, '应当报错却成功了');
    return null;
}

// 真实正式库指纹（只读 stat + 字节哈希，不以 sqlite 打开）：整个验证脚本运行前后必须不变
const REAL_LIVE_DB = path.resolve(__dirname, '../task_pool.db');
function realLiveFingerprint() {
    if (!fs.existsSync(REAL_LIVE_DB)) return 'absent';
    const st = fs.statSync(REAL_LIVE_DB);
    return `${st.size}|${st.mtimeMs}|${migrate.sha256File(REAL_LIVE_DB)}`;
}
const realLiveBefore = realLiveFingerprint();

(async () => {
    try {
        // ---- 0. normalizeTime 与 basic_info 判定的单元断言
        check('normalizeTime 规范格式', migrate.normalizeTime('2026-09-10 12:00:00') === '2026-09-10 12:00:00');
        check('normalizeTime T 分隔', migrate.normalizeTime('2026-09-10T12:00:00') === '2026-09-10 12:00:00');
        check('normalizeTime 非法日期', migrate.normalizeTime('2026-02-30 12:00:00') === null);
        check('normalizeTime 垃圾串', migrate.normalizeTime('not-a-time') === null);
        check('normalizeTime 带时区后缀不认', migrate.normalizeTime('2026-09-10T12:00:00Z') === null);
        check('normalizeTime 非字符串', migrate.normalizeTime(null) === null && migrate.normalizeTime(20260910) === null);
        check('basic_info 五字段未变=排除', migrate.evaluateBasicInfo(j(FIVE), j(FIVE)) === 'excluded');
        check('basic_info 有变化=确证', migrate.evaluateBasicInfo(j(FIVE), j({ ...FIVE, update_cycle: 'weekly' })) === 'confirmed');
        check('basic_info 缺字段=推定', migrate.evaluateBasicInfo(j(FIVE), j({ source_system: 'S' })) === 'presumed');
        check('basic_info 缺字段但可比字段已变=确证', migrate.evaluateBasicInfo(j(FIVE), j({ source_system: 'X' })) === 'confirmed');
        check('basic_info JSON 损坏=推定', migrate.evaluateBasicInfo('{bad', j(FIVE)) === 'presumed' && migrate.evaluateBasicInfo(null, null) === 'presumed');
        check('basic_info layer 不参与', migrate.evaluateBasicInfo(j({ ...FIVE, layer: 'ODS' }), j({ ...FIVE, layer: 'DWD' })) === 'excluded');
        // A 表五字段各一条：只有该字段变化、其余四个都在且相等 => 确证（字段名写字面量，不引用 migrate.A_FIELDS，否则变异测不出）
        const CHANGED = { table_name: 't-renamed', source_system: 'S2', source_table: 'src2', update_cycle: 'weekly', config_mode: 'custom' };
        for (const f of ['table_name', 'source_system', 'source_table', 'update_cycle', 'config_mode']) {
            check(`basic_info 只有 ${f} 变化 => 确证`, migrate.evaluateBasicInfo(j(FIVE), j({ ...FIVE, [f]: CHANGED[f] })) === 'confirmed');
        }
        check('config_mode：null 与 standard 视同相等 => 排除', migrate.evaluateBasicInfo(j({ ...FIVE, config_mode: null }), j(FIVE)) === 'excluded');
        check('config_mode：空串与 standard 视同相等 => 排除', migrate.evaluateBasicInfo(j({ ...FIVE, config_mode: '' }), j({ ...FIVE, config_mode: null })) === 'excluded');

        // ---- 1. 空跑：零写入 + 清单对拍
        const fxDry = fresh('dry.db');
        await buildFixture(fxDry, false);
        const before = sha(fxDry);
        const reportFile = fresh('report.json');
        const dry = await migrate.run({ db: fxDry, report: reportFile });
        check('空跑状态', dry.status === 'dry-run', dry.status);
        check('空跑零写入（sha256 相等）', sha(fxDry) === before);
        const manifest = dry.report.models;
        const flaggedConfirmed = sortNum(manifest.filter(m => !m.presumed_only).map(m => m.id));
        const flaggedPresumed = sortNum(manifest.filter(m => m.presumed_only).map(m => m.id));
        check('清单：含确证的模型集合', j(flaggedConfirmed) === j(EXPECT_FLAGGED_CONFIRMED), j(flaggedConfirmed));
        check('清单：仅推定的模型集合', j(flaggedPresumed) === j(EXPECT_FLAGGED_PRESUMED_ONLY), j(flaggedPresumed));
        const byId = Object.fromEntries(manifest.map(m => [m.id, m]));
        check('清单：M14 只有早于证据的一条记录被置 0', byId[14] && j(byId[14].record_ids) === '[140]' && byId[14].affected_records === 1);
        check('清单：M4 证据来源为 basic_info 确证', byId[4] && byId[4].evidence[0].source === 'change_log:basic_info' && byId[4].evidence[0].qualification === 'confirmed');
        check('清单：M6 证据为 basic_info 推定', byId[6] && byId[6].evidence[0].qualification === 'presumed' && byId[6].evidence[0].source === 'change_log:basic_info');
        check('清单：M3 证据来源 RESTORE', byId[3] && byId[3].evidence[0].source === 'change_log:restore');
        check('清单：M8 证据来自伴生行 deleted_at', byId[8] && byId[8].evidence[0].source === 'companion_deleted_at');
        check('清单：M11 无法解析时间按推定并带原始值', byId[11] && byId[11].evidence[0].qualification === 'presumed' && byId[11].evidence[0].raw_time === 'not-a-time');
        check('清单：M12 test_time 为空进清单', byId[12] && byId[12].evidence[0].source === 'record.test_time');
        check('清单：M5（排除）/ M9（早于）/ M10（同秒）/ M13 不在清单', [5, 9, 10, 13, 15, 16, 18, 21, 23].every(id => !byId[id]));
        check('NOTE + dim_config 晚于验收：不触发（M23 不在清单）', !byId[23] && dry.report.summary.note_ignored === 2, String(dry.report.summary.note_ignored));
        check('自动保存窗口内（M18 / M21 含边界 10 秒）不触发', !byId[18] && !byId[21]);
        check('窗口外 11 秒仍按推定（M20）', byId[20] && byId[20].presumed_only && byId[20].evidence[0].source === 'models.script_saved_at');
        check('窗口内但对更早记录仍推定（M19 只有 190 被置 0）', byId[19] && j(byId[19].record_ids) === '[190]' && byId[19].presumed_only);
        check('DWD 不适用自动保存窗口（M22 两条记录都被置 0）', byId[22] && j(byId[22].record_ids) === '[220,221]');
        // 混合证据 / script_modified_at / 锚点 / DELETE / 验收进行中 / 空 change_type
        check('混合证据（M34 确证 dim_config + 推定 script_saved_at）presumed_only=false',
            byId[34] && byId[34].presumed_only === false
            && byId[34].evidence.some(e => e.qualification === 'confirmed') && byId[34].evidence.some(e => e.qualification === 'presumed'), j(byId[34]));
        check('只有晚于验收的 script_modified_at（M25）置 0 且仅推定',
            byId[25] && j(byId[25].record_ids) === '[250]' && byId[25].presumed_only && byId[25].evidence[0].source === 'models.script_modified_at');
        check('窗口内两个锚点（M26）：早的 260 置 0、晚的 261 不置 0', byId[26] && j(byId[26].record_ids) === '[260]' && byId[26].presumed_only);
        check('fail 记录不作锚点（M27）：270 置 0', byId[27] && j(byId[27].record_ids) === '[270]' && byId[27].evidence[0].source === 'models.script_saved_at');
        check('DELETE 日志算推定证据（M28）', byId[28] && byId[28].presumed_only && byId[28].evidence[0].source === 'change_log:delete');
        check('change_type 为空的 UPDATE 日志算推定证据（M29）', byId[29] && byId[29].presumed_only && byId[29].evidence[0].source === 'change_log:update_untyped');
        check('证据落在验收进行中（M30，12:00:07 ∈ [12:00:05, 12:00:10)）视为晚于该记录', byId[30] && j(byId[30].record_ids) === '[300]' && !byId[30].presumed_only, j(byId[30]));
        check('验收进行窗口之外（M31）/ execution_time_ms 缺失（M32）不触发', !byId[31] && !byId[32]);
        check('验收进行中的保存不属「验收后自动保存」（M33：330 被排除、331 照常置 0）', byId[33] && j(byId[33].record_ids) === '[331]' && byId[33].presumed_only, j(byId[33]));
        check('M30 原因写明验收进行中', /验收进行中/.test(byId[30].reason), byId[30].reason);
        check('M12 的 test_time 伪证据带 revert_blocked', byId[12].evidence[0].revert_blocked === true && byId[12].presumed_only === false);
        // current_affected：迁移前通过、迁移后不通过
        const affectedIds = sortNum(manifest.filter(m => m.current_affected).map(m => m.id));
        check('current_affected 集合（手写期望）', j(affectedIds) === j(EXPECT_AFFECTED), j(affectedIds));
        check('M14 / M19（旧记录置 0、最新验收晚于全部证据）current_affected=false 且判定不变',
            [14, 19].every(id => byId[id].current_affected === false && byId[id].state_before === 'pass' && byId[id].state_after === 'pass'));
        check('M14 原因写明仅旧记录被置 0', /仅较早的 1 条旧记录被置 0/.test(byId[14].reason) && /当前验收仍有效/.test(byId[14].reason), byId[14].reason);
        check('M1（最新验收被置 0）current_affected=true，原因含证据', byId[1].current_affected === true && /之后有 dim_config 变更 2026-09-10 13:00:00（确证）/.test(byId[1].reason), byId[1].reason);
        check('M17（DWD 只剩 data 阶段）迁移前 pass、迁移后 partial，受影响', byId[17].state_before === 'pass' && byId[17].state_after === 'partial' && byId[17].current_affected === true);
        check('M12（test_time 为空）受影响且原因写明', byId[12].current_affected === true && /缺失/.test(byId[12].reason), byId[12].reason);
        check('M24 迁移前本就是 fail：不受影响也不算「判定不变」', byId[24].current_affected === false && byId[24].state_before === 'fail' && /本就不是通过/.test(byId[24].reason), byId[24].reason);
        check('清单按 current_affected 降序（受影响的在前），组内 id 升序',
            j(manifest.map(m => m.current_affected)) === j(manifest.map(m => m.current_affected).slice().sort((a, b) => (b ? 1 : 0) - (a ? 1 : 0)))
            && j(manifest.filter(m => m.current_affected).map(m => m.id)) === j(EXPECT_AFFECTED));
        const sm = dry.report.summary;
        check('汇总：current_affected 构成', sm.current_affected_models === EXPECT_AFFECTED.length && sm.current_affected_with_confirmed === EXPECT_AFFECTED_CONFIRMED.length && sm.current_affected_presumed_only === 13
            && sm.flagged_old_records_only_unchanged === 4 && sm.flagged_already_not_passing === 4, j(sm));
        check('汇总：含 revert_blocked 伪证据的模型数（M12 / M43）与已删模型数（M35）', sm.models_with_revert_blocked === 2 && sm.deleted_models_flagged === 1, j(sm));
        check('M35（已软删）：回填照常、deleted=true、不标 current_affected', byId[35] && byId[35].deleted === true && byId[35].current_affected === false && j(byId[35].record_ids) === '[350]' && /已删除/.test(byId[35].reason), j(byId[35]));
        check('验收进行窗口：恰在下界（M36，含放宽的 1 秒）触发、下界外 1 秒（M31）不触发', byId[36] && j(byId[36].record_ids) === '[360]' && !byId[31]);
        // ---- codex 21 / 21T：每个模型都「无其他证据兜底」
        check('S1 作废的 pass 不作锚点（M37）：370 置 0', byId[37] && j(byId[37].record_ids) === '[370]' && byId[37].evidence[0].source === 'models.script_saved_at', j(byId[37]));
        check('S1 DWD 的 semantic pass 不作锚点（M47）：三条记录都置 0', byId[47] && j(byId[47].record_ids) === '[470,471,472]', j(byId[47]));
        check('S1 ODS 上带 phase 的 pass 不作锚点（M48）：480 置 0', byId[48] && j(byId[48].record_ids) === '[480]', j(byId[48]));
        check('T1 仅 script_init（M38）：置 0、确证', byId[38] && j(byId[38].record_ids) === '[380]' && byId[38].presumed_only === false
            && byId[38].evidence.length === 1 && byId[38].evidence[0].source === 'change_log:script_init' && byId[38].evidence[0].qualification === 'confirmed', j(byId[38]));
        check('T2 仅 action=RESTORE 且 change_type 为 NULL（M39）：来源 change_log:restore、确证', byId[39] && byId[39].evidence.length === 1 && byId[39].evidence[0].source === 'change_log:restore' && byId[39].evidence[0].qualification === 'confirmed', j(byId[39]));
        check('T2 仅 action=RESTORE 且 change_type 无关（M40）', byId[40] && byId[40].evidence.length === 1 && byId[40].evidence[0].source === 'change_log:restore', j(byId[40]));
        check('T2 仅 change_type 命中 restore（M41，action=UPDATE）', byId[41] && byId[41].evidence.length === 1 && byId[41].evidence[0].source === 'change_log:restore', j(byId[41]));
        check('T3 同一条日志 basic_info,dim_config 且缺字段（M42）：仍确证、只有一条证据', byId[42] && j(byId[42].record_ids) === '[420]' && byId[42].presumed_only === false
            && byId[42].evidence.length === 1 && byId[42].evidence[0].source === 'change_log:dim_config' && byId[42].evidence[0].qualification === 'confirmed', j(byId[42]));
        check('T4 test_time 无法解析且无其他证据（M43）：置 0、record.test_time、revert_blocked', byId[43] && j(byId[43].record_ids) === '[430]'
            && byId[43].evidence.length === 1 && byId[43].evidence[0].source === 'record.test_time' && byId[43].evidence[0].revert_blocked === true && byId[43].presumed_only === false, j(byId[43]));
        check('T6 warn 锚点：10 秒内保存（M44 含恰 10 秒）记录保持 1、不进清单', !byId[44]);
        check('T6 warn 11 秒对照（M45）置 0', byId[45] && j(byId[45].record_ids) === '[450]' && byId[45].presumed_only === true, j(byId[45]));
        check('T7 M46 两条记录置 0 且仅推定', byId[46] && j(byId[46].record_ids) === '[460,461]' && byId[46].presumed_only === true, j(byId[46]));
        check('汇总：自动保存排除的模型数（M18 / M19 / M21 / M26 / M33 / M44）', dry.report.summary.autosave_excluded_models === 6, String(dry.report.summary.autosave_excluded_models));
        check('清单：孤儿记录不进模型清单', !byId[999]);
        check('汇总：排除计数 1、不在册日志 1', dry.report.summary.basic_info_excluded === 1 && dry.report.summary.unknown_model_logs === 1, j(dry.report.summary));
        check('汇总：置 0 的记录数', dry.report.summary.records_set_zero === Object.values(EXPECT_REV).filter(v => v === 0).length, String(dry.report.summary.records_set_zero));
        check('汇总：孤儿记录置 0 计数', dry.report.summary.orphan_records_set_zero === 1);
        const fileReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
        check('--report 输出文件与返回一致', fileReport.models.length === manifest.length && fileReport.summary.models_flagged === manifest.length);

        // ---- 2. 应用：逐记录对拍 + 判定服务联动
        const fxApply = fresh('apply.db');
        await buildFixture(fxApply, false);
        const bk1 = fresh('backup1.db');
        const applied = await migrate.run({ db: fxApply, apply: true, backup: bk1 });
        check('应用状态', applied.status === 'applied', applied.status);
        check('备份文件存在', fs.existsSync(bk1));
        const revs = await readRevs(fxApply);
        for (const [id, want] of Object.entries(EXPECT_REV)) check(`记录 ${id} 的 config_rev`, revs[id] === want, `期望 ${want} 实得 ${revs[id]}`);
        check('无残留 NULL', Object.values(revs).every(v => v !== null));
        const chk = await open(fxApply, sqlite.OPEN_READONLY);
        const modelRevs = await allSql(chk, 'SELECT DISTINCT config_rev AS r FROM data_models');
        check('补列后所有模型 config_rev = 1', j(modelRevs) === '[{"r":1}]', j(modelRevs));
        const markers = await allSql(chk, "SELECT name, done_at, detail FROM model_center_migrations WHERE name = 'config_rev_backfill'");
        check('写入迁移标记', markers.length === 1 && markers[0].done_at);
        const detail = markers.length ? JSON.parse(markers[0].detail) : {};
        check('标记 detail：记录数与置 0 数', detail.records_total === RECORD_TOTAL && detail.records_set_zero_before_revert === ZERO_TOTAL, j(detail));
        check('标记 detail：各证据类型计数', detail.evidence_triggering_by_type && detail.evidence_triggering_by_type['change_log:dim_config|confirmed'] === 8, j(detail.evidence_triggering_by_type));
        await closeDb(chk);
        const states = await evaluateAll(fxApply);
        for (const [id, want] of Object.entries(EXPECT_STATE)) check(`判定服务：模型 ${id} state`, states[id] && states[id].state === want, `期望 ${want} 实得 ${states[id] && states[id].state}`);
        check('判定服务：被置 0 的记录所属模型 gatePass=false', [1, 2, 3, 4, 6, 7, 8, 11, 12, 20, 22, 25, 28, 29, 30, 34, 36, 37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48].every(id => states[id].gatePass === false));
        check('判定服务：未置 0 的通过记录所属模型 gatePass=true', [5, 9, 10, 13, 14, 16, 18, 19, 21, 23, 26, 31, 32, 33, 44].every(id => states[id].gatePass === true));

        // ---- 3. 幂等：第二次 --apply
        const shaAfter = sha(fxApply);
        const bk2 = fresh('backup2.db');
        const second = await migrate.run({ db: fxApply, apply: true, backup: bk2 });
        check('第二次 apply 输出已迁移', second.status === 'already-migrated' && /已迁移/.test(second.message), j(second));
        check('第二次 apply 库文件不变', sha(fxApply) === shaAfter);
        check('第二次 apply 不产生备份', !fs.existsSync(bk2));
        const secondDry = await migrate.run({ db: fxApply });
        check('已迁移库的空跑也报已迁移', secondDry.status === 'already-migrated');

        // ---- 4. 同事务：写标记前注入失败 => 回填全部回滚
        const fxFault = fresh('fault.db');
        await buildFixture(fxFault, false);
        await expectReject('注入故障后 run 报错', () => migrate.run({ db: fxFault, apply: true, backup: fresh('backup-fault.db'), __faultBeforeMarker: true }), /故障注入/);
        const faultRevs = await readRevs(fxFault);
        check('回滚：所有记录仍为 NULL', Object.values(faultRevs).length === RECORD_TOTAL && Object.values(faultRevs).every(v => v === null), j(faultRevs));
        const chkF = await open(fxFault, sqlite.OPEN_READONLY);
        const mk = await allSql(chkF, "SELECT COUNT(*) AS n FROM model_center_migrations WHERE name = 'config_rev_backfill'");
        check('回滚：无迁移标记', mk[0].n === 0);
        await closeDb(chkF);
        // 未迁移（缺标记且记录全 NULL）时判定服务 fail-closed
        const statesF = await evaluateAll(fxFault);
        check('未迁移：有通过记录的模型一律 stale 且 gatePass=false',
            [1, 5, 9, 10, 13, 14, 16, 17].every(id => statesF[id].state === 'stale' && statesF[id].gatePass === false),
            j(Object.fromEntries([1, 5, 9, 13, 14, 16, 17].map(id => [id, statesF[id].state]))));
        // 故障后可重试成功（补列与建表幂等）
        const retry = await migrate.run({ db: fxFault, apply: true, backup: fresh('backup-retry.db') });
        check('故障后重试成功', retry.status === 'applied');
        const retryRevs = await readRevs(fxFault);
        check('故障后重试结果与期望一致', Object.entries(EXPECT_REV).every(([id, v]) => retryRevs[id] === v));

        // ---- 5. --revert
        const fxRev = fresh('revert.db');
        await buildFixture(fxRev, false);
        const revertOk = fresh('revert-ok.json');
        fs.writeFileSync(revertOk, j({ ids: [6, 8] }));
        const revertOkRun = await migrate.run({ db: fxRev, apply: true, backup: fresh('backup-rev.db'), revert: revertOk, operator: 'tester' });
        check('revert：应用成功', revertOkRun.status === 'applied');
        const revRevs = await readRevs(fxRev);
        check('revert：仅推定触发的 M6 / M8 记录改回 1', revRevs[60] === 1 && revRevs[80] === 1, j({ 60: revRevs[60], 80: revRevs[80] }));
        check('revert：其他被置 0 的记录不动', [10, 20, 30, 40, 70, 110, 120, 140, 170, 190, 200, 220, 221, 240, 250, 260, 270, 280, 290, 300, 331, 340, 350, 360, 9990].every(id => revRevs[id] === 0));
        const chkR = await open(fxRev, sqlite.OPEN_READONLY);
        const mr = await allSql(chkR, "SELECT detail FROM model_center_migrations WHERE name = 'config_rev_backfill'");
        const dr = JSON.parse(mr[0].detail);
        check('revert：标记里记 id 与操作人', j(dr.revert.ids) === '[6,8]' && dr.revert.operator === 'tester' && dr.revert.records_reverted_to_one === 2, j(dr.revert));
        await closeDb(chkR);
        const revStates = await evaluateAll(fxRev);
        check('revert：M6 改回后 pass', revStates[6].state === 'pass');

        // ---- 5b. M13（末次合并审）：带 --revert 的 apply——报告与标记里的统计按「放行后实际写入的值」重算，与库内实际一致；放行前清单另存 plan_before_revert
        {
          const actualZero = Object.values(revRevs).filter(v => v === 0).length;
          const actualOne = Object.values(revRevs).filter(v => v === 1).length;
          const rs = revertOkRun.report.summary;
          check('M13 revert 的 apply：report.summary.records_set_zero / records_set_one 等于库里 config_rev 为 0 / 1 的实际条数（手写期望 = 放行前 ' + ZERO_TOTAL + ' 条置 0 减去改回 1 的 2 条）',
            actualZero === ZERO_TOTAL - 2 && actualOne === (RECORD_TOTAL - ZERO_TOTAL) + 2 && rs.records_set_zero === actualZero && rs.records_set_one === actualOne, j({ rs0: rs.records_set_zero, rs1: rs.records_set_one, actualZero, actualOne }));
          check('M13 revert 的 apply：迁移标记 detail 的 records_set_zero / records_set_one 同为实际值，*_before_revert 保留放行前的 ' + ZERO_TOTAL,
            dr.records_set_zero === actualZero && dr.records_set_one === actualOne && dr.records_set_zero_before_revert === ZERO_TOTAL && dr.records_set_one_before_revert === RECORD_TOTAL - ZERO_TOTAL, j(dr));
          const rm = revertOkRun.report.models;
          const byIdR = Object.fromEntries(rm.map(m => [m.id, m]));
          check('M13 revert 的 apply：被放行的 M6 / M8 在清单里标 reverted: true、affected_records = 0、record_ids 为空、current_affected = false；其余清单行 reverted: false',
            [6, 8].every(id => byIdR[id] && byIdR[id].reverted === true && byIdR[id].affected_records === 0 && byIdR[id].record_ids.length === 0 && byIdR[id].current_affected === false && /已按 --revert 放行/.test(byIdR[id].reason))
            && rm.filter(m => ![6, 8].includes(m.id)).every(m => m.reverted === false), j([6, 8].map(id => byIdR[id])));
          check('M13 revert 的 apply：清单行的 state_after 与迁移后库里的真实判定一致（M6 改回后 pass）；summary.current_affected_models = 清单里 current_affected 的个数，且不含被放行的模型',
            rm.every(m => m.deleted || (revStates[m.id] && m.state_after === revStates[m.id].state)) && rs.current_affected_models === rm.filter(m => m.current_affected).length && !rm.some(m => m.reverted && m.current_affected) && byIdR[6].state_after === 'pass', j({ cam: rs.current_affected_models, n: rm.filter(m => m.current_affected).length }));
          const pb = revertOkRun.report.plan_before_revert;
          check('M13 revert 的 apply：report.plan_before_revert 保存放行前的汇总与清单（records_set_zero = ' + ZERO_TOTAL + '，清单含 M6 / M8 且它们此时仍是需复验）；没有 --revert 时不带该字段',
            !!pb && pb.summary.records_set_zero === ZERO_TOTAL && [6, 8].every(id => (pb.models.find(m => m.id === id) || {}).affected_records > 0) && rs.models_reverted === 2 && !('plan_before_revert' in applied.report), j(pb && pb.summary));
          // 收口批 2 LOW-5：放行的模型已不再被置 0，summary 里按清单行统计的各项（models_flagged / models_presumed_only / evidence_triggering_by_type / flagged_old_records_only_unchanged 等）不得再数它们；
          //   放行的模型另列在 models_reverted（报告 summary 与迁移标记 detail 同口径）。期望值 = 同一份夹具不带 --revert 的 apply 汇总（s0）减去被放行的 M6 / M8 的贡献（手写推导，不取自被测的 summarize）
          {
            const s0 = applied.report.summary;
            const m0 = Object.fromEntries(applied.report.models.map(m => [m.id, m]));
            const live = rm.filter(m => !m.reverted);
            const gone = rm.filter(m => m.reverted);
            const evCount = (ms) => { const o = {}; for (const m of ms) for (const e of m.evidence) { const k = `${e.source}|${e.qualification}`; o[k] = (o[k] || 0) + 1; } return o; };
            const ev0 = s0.evidence_triggering_by_type, evGone = evCount(gone);
            const evExpect = {}; for (const k of Object.keys(ev0)) { const v = ev0[k] - (evGone[k] || 0); if (v > 0) evExpect[k] = v; }
            const sortedJ = (o) => j(Object.entries(o).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
            const unchangedGone = [6, 8].filter(id => m0[id] && m0[id].current_unchanged_valid).length;
            check('LOW-5 前提：被放行的 M6 / M8 在放行后视角里「前后都是 pass」（current_unchanged_valid 为真）——旧写法会把它们算进 flagged_old_records_only_unchanged；它们仅由推定证据触发（presumed_only）',
              gone.length === 2 && gone.every(m => m.current_unchanged_valid === true && m.presumed_only === true), j(gone.map(m => [m.id, m.current_unchanged_valid, m.presumed_only])));
            check('LOW-5 revert 的 apply：summary.models_flagged / models_presumed_only 剔除被放行的 2 个模型（= 不带 --revert 的汇总减 2），另列 models_reverted = 2',
              rs.models_flagged === s0.models_flagged - 2 && rs.models_flagged === live.length && rs.models_presumed_only === s0.models_presumed_only - 2 && rs.models_with_confirmed === s0.models_with_confirmed && rs.models_reverted === 2,
              j({ rs: [rs.models_flagged, rs.models_presumed_only, rs.models_with_confirmed, rs.models_reverted], s0: [s0.models_flagged, s0.models_presumed_only, s0.models_with_confirmed] }));
            check('LOW-5 revert 的 apply：summary.evidence_triggering_by_type = 不带 --revert 的各类型计数减去被放行模型的证据（手写推导），也等于未放行清单行重数的结果',
              sortedJ(rs.evidence_triggering_by_type) === sortedJ(evExpect) && sortedJ(rs.evidence_triggering_by_type) === sortedJ(evCount(live)), j({ rs: rs.evidence_triggering_by_type, expect: evExpect }));
            check('LOW-5 revert 的 apply：summary.flagged_old_records_only_unchanged 不含被放行模型（= 不带 --revert 的汇总减去其中本来就算「仅较早旧记录」的放行模型数），也等于未放行清单行重数的结果',
              rs.flagged_old_records_only_unchanged === s0.flagged_old_records_only_unchanged - unchangedGone && rs.flagged_old_records_only_unchanged === live.filter(m => m.current_unchanged_valid).length, j({ rs: rs.flagged_old_records_only_unchanged, s0: s0.flagged_old_records_only_unchanged, unchangedGone }));
            check('LOW-5 revert 的 apply：迁移标记 detail 同口径——models_flagged 剔除放行模型（= summary.models_flagged）、另列 models_reverted = 2、evidence_triggering_by_type 与 summary 一致',
              dr.models_flagged === rs.models_flagged && dr.models_flagged === s0.models_flagged - 2 && dr.models_reverted === 2 && sortedJ(dr.evidence_triggering_by_type) === sortedJ(rs.evidence_triggering_by_type), j({ dr: [dr.models_flagged, dr.models_reverted], rs: rs.models_flagged }));
          }
          // 同口径：空跑带 --revert 的报告也按放行后算（空跑不写库，统计就是「如果执行会写入的」）
          const fxRevDry = fresh('revert-dry.db');
          await buildFixture(fxRevDry, false);
          const dryRev = await migrate.run({ db: fxRevDry, revert: revertOk });
          check('M13 revert 的空跑：report.summary.records_set_zero = ' + (ZERO_TOTAL - 2) + '（放行后），plan_before_revert.summary.records_set_zero = ' + ZERO_TOTAL, dryRev.status === 'dry-run' && dryRev.report.summary.records_set_zero === ZERO_TOTAL - 2 && dryRev.report.plan_before_revert.summary.records_set_zero === ZERO_TOTAL, j(dryRev.report.summary));
          check('LOW-5 revert 的空跑：summary.models_flagged 同样剔除被放行的 2 个模型（= 不带 --revert 的汇总减 2），models_reverted = 2，plan_before_revert.summary 仍是放行前的完整口径（models_flagged 不变）',
            dryRev.report.summary.models_flagged === applied.report.summary.models_flagged - 2 && dryRev.report.summary.models_reverted === 2 && dryRev.report.plan_before_revert.summary.models_flagged === applied.report.summary.models_flagged, j([dryRev.report.summary.models_flagged, dryRev.report.summary.models_reverted, dryRev.report.plan_before_revert.summary.models_flagged]));
        }
        // REQUIRED_SCHEMA 补 data_models.layer / model_test_records.total_rows：缺列时在 checkSchema 明确报错（而不是读取时抛 SQL 错误）
        for (const [table, col] of [['data_models', 'layer'], ['model_test_records', 'total_rows']]) {
          const fxMiss = fresh(`miss-${table}-${col}.db`);
          await buildFixture(fxMiss, false);
          const wr = await open(fxMiss);
          try { await runSql(wr, `ALTER TABLE ${table} DROP COLUMN ${col}`); } finally { await closeDb(wr); }
          await expectReject(`M13 缺 ${table}.${col}：空跑在 checkSchema 明确报「缺少必需的列」`, () => migrate.run({ db: fxMiss }), new RegExp(`缺少必需的列: ${table}\\.${col}`));
        }

        const fxRevBad = fresh('revert-bad.db');
        await buildFixture(fxRevBad, false);
        const shaBad = sha(fxRevBad);
        const badConfirmed = fresh('revert-bad-confirmed.json');
        fs.writeFileSync(badConfirmed, j([6, 1])); // M1 含确证证据
        const bkBad = fresh('backup-bad.db');
        await expectReject('revert 含确证 id：整体报错', () => migrate.run({ db: fxRevBad, apply: true, backup: bkBad, revert: badConfirmed, operator: 'tester' }), /确证/);
        check('revert 含确证 id：库文件零改动', sha(fxRevBad) === shaBad);
        check('revert 含确证 id：不产生备份', !fs.existsSync(bkBad));
        const notListed = fresh('revert-not-listed.json');
        fs.writeFileSync(notListed, j([9])); // M9 不在清单
        await expectReject('revert 含不在清单的 id：报错', () => migrate.run({ db: fxRevBad, apply: true, backup: fresh('b.db'), revert: notListed, operator: 'tester' }), /不在「需复验清单」/);
        check('revert 不在清单：库文件零改动', sha(fxRevBad) === shaBad);
        await expectReject('revert 配合 apply 缺 operator：报错', () => migrate.run({ db: fxRevBad, apply: true, backup: fresh('b2.db'), revert: badConfirmed }), /operator/);
        const dryBad = await expectReject('空跑带含确证 id 的 revert 同样报错', () => migrate.run({ db: fxRevBad, revert: badConfirmed }), /确证/);
        void dryBad;
        check('空跑 revert 校验：库文件零改动', sha(fxRevBad) === shaBad);

        // ---- 6. 列已存在：只回填 NULL，不覆盖新版本已写的真实版本号
        const fxCols = fresh('cols.db');
        await buildFixture(fxCols, true);
        const dbc = await open(fxCols);
        await runSql(dbc, 'INSERT INTO model_test_records (id, model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, config_rev) VALUES (?,?,?,?,?,?,?,?,?)', [5000, 13, 't13', '2026-09-11 08:00:00', 'u', 'pass', 1, '{}', 7]);
        await closeDb(dbc);
        const colsRun = await migrate.run({ db: fxCols, apply: true, backup: fresh('backup-cols.db') });
        check('列已存在：应用成功', colsRun.status === 'applied');
        const colsRevs = await readRevs(fxCols);
        check('列已存在：非 NULL 的真实版本号不被覆盖', colsRevs[5000] === 7, String(colsRevs[5000]));
        check('列已存在：NULL 记录照常回填', Object.entries(EXPECT_REV).every(([id, v]) => colsRevs[id] === v));

        // ---- 7. 拒绝 live
        await expectReject('不提供 --live', () => migrate.run({ db: fxDry, live: true }), /--live/);
        // 所有「指向正式库」的反向用例只指向 workDir 里注入的假正式库（createRunner({ liveDb })），绝不触碰真实 wbs-server/task_pool.db
        const liveDb = fresh('task_pool.db');
        await buildFixture(liveDb, false);
        const runL = migrate.createRunner({ liveDb }).run;
        const shaFake = sha(liveDb);
        await expectReject('拒绝指向（假）正式库', () => runL({ db: liveDb }), /task_pool\.db/);
        check('假正式库 sha 不变', sha(liveDb) === shaFake);
        const fxNoBackup = fresh('nobackup.db');
        await buildFixture(fxNoBackup, false);
        const shaNb = sha(fxNoBackup);
        await expectReject('--apply 必须给 --backup', () => migrate.run({ db: fxNoBackup, apply: true }), /--backup/);
        check('缺 --backup：库文件零改动', sha(fxNoBackup) === shaNb);
        await expectReject('--backup 必须是新文件', () => migrate.run({ db: fxNoBackup, apply: true, backup: fxDry }), /新文件/);
        check('备份文件已存在：库文件零改动', sha(fxNoBackup) === shaNb);

        // ---- 8. --report 路径闸门（任何读写之前）
        const fxRep = fresh('report-gate.db');
        await buildFixture(fxRep, false);
        const shaRep = sha(fxRep);
        const bkRep = fresh('backup-report-gate.db');
        const shaLive = sha(liveDb);
        await expectReject('--report 指向（假）正式库：拒绝', () => runL({ db: fxRep, report: liveDb }), /--report/);
        check('--report 指向正式库：正式库与夹具库 sha 不变', sha(liveDb) === shaLive && sha(fxRep) === shaRep);
        await expectReject('--report 指向 --db：拒绝', () => migrate.run({ db: fxRep, report: fxRep }), /--report 不得与 --db 相同/);
        check('--report 指向 --db：库 sha 不变', sha(fxRep) === shaRep);
        await expectReject('--report 指向 --backup：拒绝', () => migrate.run({ db: fxRep, apply: true, backup: bkRep, report: bkRep }), /--report 不得与 --backup 相同/);
        check('--report 指向 --backup：库零改动且未产生备份', sha(fxRep) === shaRep && !fs.existsSync(bkRep));
        const existingReport = fresh('existing-report.json');
        fs.writeFileSync(existingReport, 'KEEP');
        await expectReject('--report 指向已存在文件：拒绝', () => migrate.run({ db: fxRep, report: existingReport }), /不存在的新文件/);
        check('--report 已存在文件：内容不变、库不变', fs.readFileSync(existingReport, 'utf8') === 'KEEP' && sha(fxRep) === shaRep);
        await expectReject('--report 目录不存在：拒绝', () => migrate.run({ db: fxRep, report: path.join(workDir, 'no-such-dir', 'r.json') }), /目录不存在/);
        check('--report 目录不存在：库不变', sha(fxRep) === shaRep);
        await expectReject('--apply 时 --report 非法：库零改动、不产生备份', () => migrate.run({ db: fxRep, apply: true, backup: bkRep, report: existingReport }), /不存在的新文件/);
        check('--apply 时 --report 非法：库不变、无备份', sha(fxRep) === shaRep && !fs.existsSync(bkRep));

        // ---- 9. --in-place：只有 --apply + --backup 齐备才允许指向正式库（只做负向；绝不对正式库真的执行）
        const bkLive = fresh('backup-live.db');
        await expectReject('指向正式库：不带 --in-place 拒绝（即便 --apply --backup 齐备）', () => runL({ db: liveDb, apply: true, backup: bkLive }), /--in-place/);
        await expectReject('指向正式库：--in-place 缺 --backup 拒绝', () => runL({ db: liveDb, inPlace: true, apply: true }), /--backup/);
        await expectReject('指向正式库：--in-place 缺 --apply 拒绝', () => runL({ db: liveDb, inPlace: true }), /--in-place|拒绝/);
        await expectReject('指向正式库：--in-place 带 --backup 缺 --apply 拒绝', () => runL({ db: liveDb, inPlace: true, backup: bkLive }), /--apply/);
        await expectReject('指向正式库：空跑拒绝', () => runL({ db: liveDb }), /task_pool\.db/);
        check('（假）正式库 sha 不变、无备份文件产生', sha(liveDb) === shaLive && !fs.existsSync(bkLive));
        // ino 为 0n（文件系统不给可靠 inode）时，与正式库比较一律按同一文件处理：硬链接到正式库 + 桩 statSync，空跑与 --apply --backup 都必须被拒
        const hardLink = path.join(workDir, 'live-hardlink.db');
        fs.linkSync(liveDb, hardLink);
        const origStat = fs.statSync;
        fs.statSync = (p, o) => {
            const s = origStat.call(fs, p, o);
            return o && o.bigint ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { ino: 0n }) : s;
        };
        try {
            await expectReject('ino=0n + 硬链接指向正式库：空跑被拒', () => runL({ db: hardLink }), /task_pool\.db/);
            await expectReject('ino=0n + 硬链接指向正式库：--apply --backup 被拒', () => runL({ db: hardLink, apply: true, backup: fresh('backup-hardlink.db') }), /--in-place/);
        } finally { fs.statSync = origStat; }
        await expectReject('（无桩）硬链接指向正式库：同样被拒', () => runL({ db: hardLink }), /task_pool\.db/);
        check('硬链接用例后（假）正式库 sha 不变', sha(liveDb) === shaLive);
        // 命令行入口不接受任何覆盖正式库路径的参数
        const cli = spawnSync(process.execPath, [path.join(__dirname, 'migrate-model-config-rev.js'), '--live-db', liveDb, '--db', fxRep], { encoding: 'utf8' });
        check('命令行入口拒绝 --live-db 之类覆盖参数', cli.status !== 0 && /用法/.test(`${cli.stdout}${cli.stderr}`), `${cli.status} ${cli.stderr}`);
        check('命令行入口拒绝覆盖参数：库不变', sha(fxRep) === shaRep);

        // ---- 9b. COMMIT 之后关闭库失败 / 写报告失败
        const fxClose = fresh('close-fault.db');
        await buildFixture(fxClose, false);
        const closeRun = await migrate.run({ db: fxClose, apply: true, backup: fresh('bk-close.db'), __faultClose: true });
        check('COMMIT 后关闭库失败：结果仍为 applied，仅进 warnings', closeRun.status === 'applied' && closeRun.warnings.some(w => /关闭库失败/.test(w)), j(closeRun.warnings));
        const closeRevs = await readRevs(fxClose);
        check('COMMIT 后关闭库失败：回填结果已落库', Object.entries(EXPECT_REV).every(([id, v]) => closeRevs[id] === v));
        const fxRepFault = fresh('report-fault.db');
        await buildFixture(fxRepFault, false);
        const shaRf = sha(fxRepFault);
        await expectReject('空跑写报告失败：以错误退出', () => migrate.run({ db: fxRepFault, report: fresh('rf1.json'), __faultReportWrite: true }), /报告写入失败/);
        check('空跑写报告失败：库不变', sha(fxRepFault) === shaRf);
        const applyRepFault = await migrate.run({ db: fxRepFault, apply: true, backup: fresh('bk-rf.db'), report: fresh('rf2.json'), __faultReportWrite: true });
        check('--apply 写报告失败：库已提交，结果 applied，仅进 warnings', applyRepFault.status === 'applied' && applyRepFault.warnings.some(w => /报告写入失败/.test(w)), j(applyRepFault.warnings));
        // --in-place 对非正式库只是无害标志：正常应用
        const fxInPlace = fresh('in-place.db');
        await buildFixture(fxInPlace, false);
        const inPlaceRun = await migrate.run({ db: fxInPlace, inPlace: true, apply: true, backup: fresh('backup-in-place.db') });
        check('--in-place 对非正式库无害：正常应用', inPlaceRun.status === 'applied');

        // ---- 10. --revert 补充：混合证据 / 伪证据 / 已迁移
        const fxRev2 = fresh('revert2.db');
        await buildFixture(fxRev2, false);
        const shaRev2 = sha(fxRev2);
        const revMixed = fresh('revert-mixed.json');
        fs.writeFileSync(revMixed, j([34]));
        const bkRev2 = fresh('backup-rev2.db');
        await expectReject('--revert 混合证据模型（M34）：报含确证', () => migrate.run({ db: fxRev2, apply: true, backup: bkRev2, revert: revMixed, operator: 'tester' }), /确证/);
        check('--revert 混合证据：库零改动、无备份', sha(fxRev2) === shaRev2 && !fs.existsSync(bkRev2));
        const revPseudo = fresh('revert-pseudo.json');
        fs.writeFileSync(revPseudo, j([12]));
        await expectReject('--revert test_time 缺失的模型（M12）：按含确证处理报错', () => migrate.run({ db: fxRev2, apply: true, backup: fresh('b-p.db'), revert: revPseudo, operator: 'tester' }), /确证/);
        check('--revert 伪证据：库零改动', sha(fxRev2) === shaRev2);
        const shaApplied = sha(fxApply);
        await expectReject('库已迁移时带 --revert：明确报错', () => migrate.run({ db: fxApply, revert: revMixed }), /已迁移，--revert 只能在迁移时使用/);
        await expectReject('库已迁移时 --apply 带 --revert：同样报错', () => migrate.run({ db: fxApply, apply: true, backup: fresh('b-m.db'), revert: revMixed, operator: 'tester' }), /已迁移，--revert 只能在迁移时使用/);
        check('已迁移 + --revert：库不变', sha(fxApply) === shaApplied);

        // ---- 11. 备份核对故障注入：--apply 必须中止、库零改动
        for (const [fault, pattern] of [['rowcount', /行数/], ['integrity', /integrity_check/]]) {
            const fxB = fresh(`backup-fault-${fault}.db`);
            await buildFixture(fxB, false);
            const shaB = sha(fxB);
            await expectReject(`备份核对故障注入（${fault}）：--apply 中止`, () => migrate.run({ db: fxB, apply: true, backup: fresh(`bk-${fault}.db`), __faultBackup: fault }), pattern);
            check(`备份核对故障注入（${fault}）：库零改动`, sha(fxB) === shaB);
        }

        // ---- 12. codex 21T：--revert 对确证 / 混合 / 伪证据专用模型一律拒绝（无其他证据兜底）
        for (const [id, label] of [[38, 'T1 script_init 确证'], [42, 'T3 basic_info,dim_config 缺字段'], [43, 'T4 test_time 无法解析']]) {
            const revFile = fresh(`revert-${id}.json`);
            fs.writeFileSync(revFile, j([id]));
            await expectReject(`--revert ${label}（M${id}）：整体报错`, () => migrate.run({ db: fxRev2, apply: true, backup: fresh(`b-${id}.db`), revert: revFile, operator: 'tester' }), /确证/);
            check(`--revert ${label}（M${id}）：库零改动`, sha(fxRev2) === shaRev2);
        }

        // ---- 13. T5：默认正式库路径锁定（不以 sqlite 打开真实库）
        check('T5 默认正式库路径 = wbs-server 相对位置的 task_pool.db', path.resolve(migrate.DEFAULT_LIVE_DB) === path.resolve(__dirname, '../task_pool.db'), migrate.DEFAULT_LIVE_DB);
        check('T5 模块级 run 使用的正是该默认路径', path.resolve(migrate.DEFAULT_RUNNER_LIVE_DB) === path.resolve(__dirname, '../task_pool.db'), migrate.DEFAULT_RUNNER_LIVE_DB);
        // 预筛 MED-1：锁「命令行实际调用的 run」本身——run 若被改绑到别的 runner，上一条仍会通过
        check('T5 模块级 run 即 DEFAULT_RUNNER.run（同一函数引用）', typeof migrate.run === 'function' && migrate.DEFAULT_RUNNER && migrate.run === migrate.DEFAULT_RUNNER.run);
        check('T5 DEFAULT_RUNNER.liveDb 等于默认路径', !!migrate.DEFAULT_RUNNER && path.resolve(migrate.DEFAULT_RUNNER.liveDb) === path.resolve(__dirname, '../task_pool.db'));

        // ---- 14. T7：--revert 选有两条置 0 记录的仅推定模型 => 两条都恢复为 1；同输入配写标记前故障 => 全部回滚、可重试
        const revTwo = fresh('revert-46.json');
        fs.writeFileSync(revTwo, j([46]));
        const fxT7 = fresh('t7.db');
        await buildFixture(fxT7, false);
        const t7 = await migrate.run({ db: fxT7, apply: true, backup: fresh('bk-t7.db'), revert: revTwo, operator: 'tester' });
        const t7Revs = await readRevs(fxT7);
        check('T7 revert M46：两条置 0 记录都恢复为 1，其他置 0 记录不动', t7.status === 'applied' && t7Revs[460] === 1 && t7Revs[461] === 1 && t7Revs[450] === 0 && t7Revs[60] === 0, j({ 460: t7Revs[460], 461: t7Revs[461] }));
        check('T7 revert M46：标记里 records_reverted_to_one = 2', t7.report.applied.records_reverted_to_one === 2);
        const fxT7f = fresh('t7f.db');
        await buildFixture(fxT7f, false);
        await expectReject('T7 revert + 写标记前故障：报错', () => migrate.run({ db: fxT7f, apply: true, backup: fresh('bk-t7f.db'), revert: revTwo, operator: 'tester', __faultBeforeMarker: true }), /故障注入/);
        const t7fRevs = await readRevs(fxT7f);
        check('T7 故障：全部记录仍为 NULL', Object.values(t7fRevs).length === RECORD_TOTAL && Object.values(t7fRevs).every(v => v === null));
        const t7fDb = await open(fxT7f, sqlite.OPEN_READONLY);
        let t7fMarkers;
        try { t7fMarkers = await allSql(t7fDb, "SELECT COUNT(*) AS n FROM model_center_migrations WHERE name = 'config_rev_backfill'"); } finally { await closeDb(t7fDb); }
        check('T7 故障：无迁移标记', t7fMarkers[0].n === 0);
        const t7Retry = await migrate.run({ db: fxT7f, apply: true, backup: fresh('bk-t7r.db'), revert: revTwo, operator: 'tester' });
        const t7rRevs = await readRevs(fxT7f);
        check('T7 故障后同一 revert 输入可重试成功', t7Retry.status === 'applied' && t7rRevs[460] === 1 && t7rRevs[461] === 1);

        // ---- 15. T8：备份生成于补列之前（备份不含 config_rev 列与 model_center_migrations 表，行数与源库一致）
        const fxT8 = fresh('t8.db');
        await buildFixture(fxT8, false);
        const srcCounts = {};
        const t8Src = await open(fxT8, sqlite.OPEN_READONLY);
        try {
            for (const t of ['data_models', 'model_test_records', 'model_change_logs']) srcCounts[t] = (await allSql(t8Src, `SELECT COUNT(*) AS n FROM ${t}`))[0].n;
        } finally { await closeDb(t8Src); }
        const bkT8 = fresh('bk-t8.db');
        const t8 = await migrate.run({ db: fxT8, apply: true, backup: bkT8 });
        check('T8 应用成功', t8.status === 'applied');
        const t8Bk = await open(bkT8, sqlite.OPEN_READONLY);
        try {
            const dmCols = (await allSql(t8Bk, 'PRAGMA table_info(data_models)')).map(c => c.name);
            const trCols = (await allSql(t8Bk, 'PRAGMA table_info(model_test_records)')).map(c => c.name);
            const mig = await allSql(t8Bk, "SELECT name FROM sqlite_master WHERE name = 'model_center_migrations'");
            check('T8 备份不含本次新增的 config_rev 列（data_models / model_test_records）', !dmCols.includes('config_rev') && !trCols.includes('config_rev'), j({ dmCols, trCols }));
            check('T8 备份不含 model_center_migrations 表', mig.length === 0);
            for (const t of Object.keys(srcCounts)) {
                const n = (await allSql(t8Bk, `SELECT COUNT(*) AS n FROM ${t}`))[0].n;
                check(`T8 备份 ${t} 行数与迁移前源库一致`, n === srcCounts[t], `${n} vs ${srcCounts[t]}`);
            }
        } finally { await closeDb(t8Bk); }

        // ---- 16. T9：原地迁移正向用例（对注入的假正式库带齐 --in-place --apply --backup）
        const fakeLive2 = fresh('task_pool.db');
        await buildFixture(fakeLive2, false);
        const runL2 = migrate.createRunner({ liveDb: fakeLive2 }).run;
        const t9a = await runL2({ db: fakeLive2, inPlace: true, apply: true, backup: fresh('bk-t9a.db') });
        check('T9 原地迁移（假正式库，三条件齐备）：applied', t9a.status === 'applied', t9a.status);
        const t9Revs = await readRevs(fakeLive2);
        check('T9 原地迁移：回填结果与期望一致', Object.entries(EXPECT_REV).every(([id, v]) => t9Revs[id] === v));
        const t9b = await runL2({ db: fakeLive2, inPlace: true, apply: true, backup: fresh('bk-t9b.db') });
        check('T9 原地迁移再跑一次：已迁移', t9b.status === 'already-migrated');

        // ---- 17. S2：current_affected 喂入全量记录（跨阶段：一个阶段记录已非 NULL、另一阶段待回填）
        const fxS2 = fresh('s2.db');
        await buildFixture(fxS2, true);
        const s2Db = await open(fxS2);
        try { await runSql(s2Db, 'UPDATE model_test_records SET config_rev = 1 WHERE id = 171'); } finally { await closeDb(s2Db); }
        const s2 = await migrate.run({ db: fxS2 });
        const s2m = s2.report.models.find(m => m.id === 17);
        // ---- 18. 21-R：自动保存锚点从「全量记录」选（含 config_rev 已非 NULL 的记录），写入计划仍只含 NULL 记录
        const fxMix = fresh('mixed-anchor.db');
        await buildFixture(fxMix, true);
        const mixDb = await open(fxMix);
        try {
            for (const id of [49, 50]) await runSql(mixDb, 'INSERT INTO data_models (id, table_name, layer, script_saved_at) VALUES (?,?,?,?)', [id, 't' + id, 'ODS', '2026-09-10 12:00:10']);
            const mixRec = (id, modelId, time, rev) => runSql(mixDb, 'INSERT INTO model_test_records (id, model_id, table_name, test_time, test_user, overall_result, total_rows, detail_json, config_rev) VALUES (?,?,?,?,?,?,?,?,?)',
                [id, modelId, 't' + modelId, time, 'u', 'pass', 10, '{}', rev]);
            await mixRec(490, 49, '2026-09-10 12:00:00', null);  // 旧记录，待回填
            await mixRec(491, 49, '2026-09-10 12:00:09', 1);     // 更晚的非 NULL pass：真实最晚锚点
            await mixRec(500, 50, '2026-09-10 12:00:00', null);
            await mixRec(501, 50, '2026-09-10 12:00:09', 5);     // 较新记录的版本号与模型当前版本（1）不一致
        } finally { await closeDb(mixDb); }
        const mixDry = await migrate.run({ db: fxMix });
        const mixBy = Object.fromEntries(mixDry.report.models.map(m => [m.id, m]));
        check('21-R 混合版本（M49）：旧 NULL 记录 490 被置 0（锚点是更晚的非 NULL 记录 491）、不进写入计划的 491 不在清单', mixBy[49] && j(mixBy[49].record_ids) === '[490]', j(mixBy[49]));
        check('21-R 较新记录版本号与模型当前版本不一致（M50）：旧记录 500 同样置 0', mixBy[50] && j(mixBy[50].record_ids) === '[500]', j(mixBy[50]));
        const mixApply = await migrate.run({ db: fxMix, apply: true, backup: fresh('bk-mix.db') });
        const mixRevs = await readRevs(fxMix);
        check('21-R 应用后：490 / 500 置 0；非 NULL 的 491 / 501 保持原值 1 / 5', mixApply.status === 'applied' && mixRevs[490] === 0 && mixRevs[500] === 0 && mixRevs[491] === 1 && mixRevs[501] === 5, j({ 490: mixRevs[490], 491: mixRevs[491], 500: mixRevs[500], 501: mixRevs[501] }));
        check('S2 M17（data 阶段记录 171 已非 NULL=1、structure 阶段 170 待回填置 0）：迁移前 pass、迁移后 partial、受影响',
            s2m && j(s2m.record_ids) === '[170]' && s2m.state_before === 'pass' && s2m.state_after === 'partial' && s2m.current_affected === true, j(s2m));
    } catch (e) {
        fail++;
        console.log('FAIL: 验证脚本自身异常 — ' + (e && e.stack ? e.stack : e));
    }
    check('整个验证脚本运行前后：真实 wbs-server/task_pool.db 的大小 / mtime / sha256 不变', realLiveFingerprint() === realLiveBefore);
    // 汇总行在清理之前打印；清理失败只告警，不影响结果
    console.log(`verify-model-config-rev-migration: PASS=${pass} FAIL=${fail}`);
    try {
        fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (e) {
        console.log('WARN: 临时目录清理失败（' + workDir + '）: ' + e.message);
    }
    process.exit(fail === 0 ? 0 : 1);
})();
