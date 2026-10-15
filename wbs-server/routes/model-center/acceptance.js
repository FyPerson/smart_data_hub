'use strict';

/**
 * 验收判定统一服务（方案 v0.9 §4.1.2）。
 *
 * evaluateAcceptance 是纯函数：只看传入的模型行与该模型的验收记录行，不访问数据库。
 * 取数助手 fetchRecordsByModelIds / fetchRecordsByModelId 单独导出，供 server.js 调用。
 *
 * 返回 { state, gatePass, at, rows, reason }
 *   state    : companion | pass | warn | fail | partial | stale | none（互斥）
 *   gatePass : state ∈ {pass, warn}（恒等）；归档门禁只认这个字段
 *   at       : 决定 state 的那条（些）记录里最新的 test_time；stale 时为最近一条旧版本通过记录的时间；无则 null
 *   rows     : DIM/DWD 取 data 阶段决定记录的 total_rows（无则取最新决定记录）；ODS 取最新候选；无则 null
 *   decisiveRecordId : 决定 state 的那条记录 id（ODS 最新候选；DIM/DWD 决定记录中最新者；stale 为最近一条旧版本通过记录；无则 null）
 *   prevResult : 仅 stale 附带，= 决定 stale 的那条旧版本通过记录（即 decisiveRecordId 那条，与 at 同一条）的 overall_result，取值 pass | warn
 *   stages   : 仅 DIM/DWD 候选非空时附带 { structure, data }（各阶段最新候选的 overall_result，缺失为 null），供门禁选文案；其余情形无此字段
 *   stageDetail : 同上条件，{ structure, data } 各为 { result, test_time, test_user } 或 null（展示用）
 *   reason   : 人读说明（门禁拒绝时可回显），通过时为 ''
 */

const PASSING = new Set(['pass', 'warn']);
const PHASES_DIM_DWD = new Set(['structure', 'data', 'all']);

const SAME_SECOND_REASON = '验收时间与任务创建时间在同一秒，请重新验收';
const MISSING_TASK_TIME_REASON = '任务缺少创建时间，无法判定验收是否晚于任务';
const EARLIER_THAN_TASK_REASON = '当前版本的验收记录早于任务创建时间，请重新验收';

// 时区一致性门禁（原 G1）已迁到 server.js 的 evaluateModelAcceptance 包装层（C1 23-R3 N3）：本文件保持无全局状态的纯函数，单测不受进程级状态影响。

function isPassing(result) {
    return PASSING.has(result);
}

/** 从 detail_json 取 phase；解析失败时退回正则（与旧 LIKE 口径同源），都没有则 null */
function extractPhase(detailJson) {
    if (detailJson == null || detailJson === '') return null;
    if (typeof detailJson === 'object') {
        return detailJson.phase == null ? null : String(detailJson.phase);
    }
    try {
        const parsed = JSON.parse(detailJson);
        if (parsed && typeof parsed === 'object' && parsed.phase != null) return String(parsed.phase);
        return null;
    } catch (_) {
        const m = /"phase"\s*:\s*"([^"]*)"/.exec(String(detailJson));
        return m ? m[1] : null;
    }
}

function isNotInvalidated(rec) {
    return rec.invalidated === 0 || rec.invalidated == null || rec.invalidated === '0';
}

function timeOf(rec) {
    return rec.test_time == null ? '' : String(rec.test_time);
}

/** test_time DESC, id DESC（同秒以 id 大者为新） */
function compareNewestFirst(a, b) {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta < tb ? 1 : -1;
    return Number(b.id) - Number(a.id);
}

function newest(list) {
    if (list.length === 0) return null;
    return list.slice().sort(compareNewestFirst)[0];
}

function revEquals(recRev, modelRev) {
    if (recRev == null || modelRev == null) return false;
    return Number(recRev) === Number(modelRev);
}

/** 记录的 phase 是否参与该分支判定：ODS 为无 phase；DIM/DWD 限 structure / data / all；semantic 恒不参与 */
function phaseParticipates(isOds, rec) {
    const phase = extractPhase(rec.detail_json);
    return isOds ? phase == null || phase === '' : PHASES_DIM_DWD.has(phase);
}

/**
 * 「最近一条参与阶段记录」（不分版本、排除 invalidated=1、排除 semantic）——
 * 供 validation-status 旧字段 status / test_time / test_user 保持原语义；无记录或分层不参与返回 null。
 */
function latestParticipatingRecord(model, records) {
    const layer = String(model && model.layer != null ? model.layer : '').toUpperCase();
    const isOds = layer === 'ODS';
    if (!isOds && layer !== 'DIM' && layer !== 'DWD') return null;
    return newest((Array.isArray(records) ? records : []).filter(rec => isNotInvalidated(rec) && phaseParticipates(isOds, rec)));
}

function makeResult(state, extra) {
    return Object.assign(
        { state, gatePass: state === 'pass' || state === 'warn', at: null, decisiveRecordId: null, rows: null, reason: '' },
        extra || {}
    );
}

/**
 * @param {object} model   至少含 id, layer, config_rev, companion_of
 * @param {Array}  records 该模型的验收记录行（id, test_time, overall_result, invalidated, config_rev, total_rows, detail_json）
 * @param {object} [opts]  opts.task（含 created_at）存在时，候选再加 test_time > task.created_at（严格大于）
 */
function evaluateAcceptance(model, records, opts) {
    const m = model || {};
    const recs = Array.isArray(records) ? records : [];
    const task = opts && opts.task ? opts.task : null;

    // 规则 5 / 7.1：伴生表不独立判定
    if (m.companion_of != null && m.companion_of !== '') {
        return makeResult('companion', { reason: '伴生表不独立验收' });
    }

    // 规则 0：按 layer 分支，其他分层一律 none
    const layer = String(m.layer == null ? '' : m.layer).toUpperCase();
    const isOds = layer === 'ODS';
    const isDimDwd = layer === 'DIM' || layer === 'DWD';
    if (!isOds && !isDimDwd) {
        return makeResult('none', { reason: '该分层暂无验收判定规则' });
    }

    // 门禁调用（opts.task 存在）但任务缺少创建时间：无法判定「验收是否晚于任务」，fail-closed
    if (task && (task.created_at == null || String(task.created_at).trim() === '')) {
        return makeResult('none', { reason: MISSING_TASK_TIME_REASON });
    }

    // 参与判定的阶段：ODS 为无 phase 的记录；DIM/DWD 限 structure / data / all；semantic 不进候选
    const participating = recs.filter(rec => isNotInvalidated(rec) && phaseParticipates(isOds, rec));

    const currentVersion = participating.filter(rec => revEquals(rec.config_rev, m.config_rev));
    const taskCreatedAt = task && task.created_at != null ? String(task.created_at) : null;
    const candidates = taskCreatedAt == null
        ? currentVersion
        : currentVersion.filter(rec => timeOf(rec) > taskCreatedAt);

    const decided = decide(isOds, candidates);
    if (decided) {
        if (!decided.gatePass && taskCreatedAt != null) {
            // 同秒被拒：不含时间条件时本可通过，且存在与任务创建时间同一秒的候选
            const untimed = decide(isOds, currentVersion);
            const sameSecond = currentVersion.some(rec => timeOf(rec) === taskCreatedAt);
            if (untimed && untimed.gatePass && sameSecond) {
                decided.reason = SAME_SECOND_REASON;
            }
        }
        return decided;
    }

    // 候选为空：规则 7 第 5 / 6 行
    let reason = '';
    if (taskCreatedAt != null && currentVersion.length > 0) {
        // 当前版本有记录但都不晚于任务创建时间
        const untimed = decide(isOds, currentVersion);
        const sameSecond = currentVersion.some(rec => timeOf(rec) === taskCreatedAt);
        if (untimed && untimed.gatePass && sameSecond) reason = SAME_SECOND_REASON;
        else reason = EARLIER_THAN_TASK_REASON;
    }
    // 「更早版本」= config_rev 低于当前版本，或为 NULL（迁移前遗留）；高于当前版本的记录（回滚 / 脏数据）既不当候选也不当旧版本，忽略
    const isEarlierVersion = rec => rec.config_rev == null
        || (m.config_rev != null && Number(rec.config_rev) < Number(m.config_rev));
    const older = participating.filter(rec => !revEquals(rec.config_rev, m.config_rev) && isEarlierVersion(rec) && isPassing(rec.overall_result));
    const olderNewest = newest(older);
    if (olderNewest) {
        return makeResult('stale', {
            at: timeOf(olderNewest) || null,
            decisiveRecordId: olderNewest.id,
            reason: reason || '模型配置在最近一次验收之后已变更，请重新验收',
            prevResult: olderNewest.overall_result
        });
    }
    return makeResult('none', { reason: reason || '尚无验收记录' });
}

/** 候选非空时给出判定结果；候选为空返回 null */
function decide(isOds, candidates) {
    if (candidates.length === 0) return null;

    if (isOds) {
        const latest = newest(candidates);
        const res = latest.overall_result;
        if (isPassing(res)) {
            return makeResult(res, { at: timeOf(latest) || null, rows: rowsOf(latest), decisiveRecordId: latest.id });
        }
        return makeResult('fail', {
            at: timeOf(latest) || null,
            decisiveRecordId: latest.id,
            rows: rowsOf(latest),
            reason: '最近一次验收未通过'
        });
    }

    // DIM / DWD：structure 取 phase ∈ {structure, all}，data 取 phase ∈ {data, all}
    const phaseOf = rec => extractPhase(rec.detail_json);
    const structureRec = newest(candidates.filter(r => ['structure', 'all'].includes(phaseOf(r))));
    const dataRec = newest(candidates.filter(r => ['data', 'all'].includes(phaseOf(r))));
    const present = [structureRec, dataRec].filter(Boolean);
    const decisive = newest(present);
    const at = decisive ? (timeOf(decisive) || null) : null;
    const decisiveRecordId = decisive ? decisive.id : null;
    const rows = dataRec ? rowsOf(dataRec) : (decisive ? rowsOf(decisive) : null);

    // 各阶段结果（仅 DIM/DWD；门禁据此选择「结构 / 数据验收尚未通过」文案；缺失为 null）
    const stages = {
        structure: structureRec ? structureRec.overall_result : null,
        data: dataRec ? dataRec.overall_result : null
    };
    // 各阶段自己那条决定记录的明细（展示用：时间 / 执行人取该阶段自己的记录，不共用 at）
    const detailOf = rec => (rec ? { id: rec.id, result: rec.overall_result, test_time: timeOf(rec) || null, test_user: rec.test_user == null ? null : rec.test_user } : null);
    const stageDetail = { structure: detailOf(structureRec), data: detailOf(dataRec) };

    // 失败优先于缺失
    if (present.some(r => !isPassing(r.overall_result))) {
        return makeResult('fail', { at, decisiveRecordId, rows, stages, stageDetail, reason: '最近一次验收未通过' });
    }
    if (present.length < 2) {
        return makeResult('partial', {
            at,
            decisiveRecordId,
            rows,
            stages,
            stageDetail,
            reason: structureRec ? '缺少数据阶段验收' : '缺少结构阶段验收'
        });
    }
    const state = present.some(r => r.overall_result === 'warn') ? 'warn' : 'pass';
    return makeResult(state, { at, decisiveRecordId, rows, stages, stageDetail });
}

function rowsOf(rec) {
    return rec && rec.total_rows != null ? Number(rec.total_rows) : null;
}

// ==================== 取数助手 ====================

const RECORD_COLUMNS = 'id, model_id, test_time, test_user, overall_result, invalidated, config_rev, total_rows, detail_json';
const CHUNK = 400;

function dbAll(db, sql, params) {
    return new Promise((resolve, reject) => {
        db.all(sql, params || [], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
}

/** 按 model id 批量取验收记录，返回 Map<modelId, record[]>（无记录的 id 也有空数组） */
async function fetchRecordsByModelIds(db, modelIds) {
    // 非法 id（null / 空串 / 非整数 / 非正数）一律丢弃；重复 id 去重
    const ids = Array.from(new Set((modelIds || [])
        .filter(v => v !== null && v !== undefined && v !== '')
        .map(Number)
        .filter(n => Number.isInteger(n) && n > 0)));
    const map = new Map(ids.map(id => [id, []]));
    for (let i = 0; i < ids.length; i += CHUNK) {
        const part = ids.slice(i, i + CHUNK);
        const rows = await dbAll(
            db,
            `SELECT ${RECORD_COLUMNS} FROM model_test_records WHERE model_id IN (${part.map(() => '?').join(',')})`,
            part
        );
        for (const row of rows) {
            const key = Number(row.model_id);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(row);
        }
    }
    return map;
}

/** 按单个 model id 取验收记录 */
function fetchRecordsByModelId(db, modelId) {
    return dbAll(db, `SELECT ${RECORD_COLUMNS} FROM model_test_records WHERE model_id = ?`, [modelId]);
}

module.exports = {
    evaluateAcceptance,
    fetchRecordsByModelIds,
    fetchRecordsByModelId,
    latestParticipatingRecord,
    SAME_SECOND_REASON,
    MISSING_TASK_TIME_REASON,
    EARLIER_THAN_TASK_REASON,
    extractPhase
};
