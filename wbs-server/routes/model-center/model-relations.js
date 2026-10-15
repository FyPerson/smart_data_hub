'use strict';

/**
 * 模型关系（#77 C2b-3，方案 v0.9 §4.5 / §6.1 C2b ⑥）。
 *
 * 纯函数（无 IO，验证脚本直接断言）：
 *   · findDownstreamCandidates(modelRow, allModels)：下游候选匹配，从 GET /api/models/:id/downstream 的内联 SQL 抽出，
 *     /downstream、/relations、列表 rel.down 三处同源。语义与原 SQL 逐项相等：
 *       WHERE id != ? AND (is_deleted IS NULL OR is_deleted = 0) AND dim_config LIKE '%<转义后的 table_name>%' ESCAPE '\'
 *       ORDER BY layer, table_name
 *     即：dim_config 原始文本里含 table_name 的子串（% _ \ 按字面量；SQLite LIKE 仅对 ASCII 字母不区分大小写），
 *     排序为 BINARY 比较（UTF-8 字节序，NULL 在前）。
 *     已知例外：dim_config 原文含 NUL（U+0000）时，SQLite 的 LIKE 会在 NUL 处截断文本、JS 不会，两者结果可能不同；
 *     平台写入 dim_config 一律经 JSON.stringify（NUL 会被写成 \u0000 转义序列），实际触发不到。
 *   · upstreamOfModel(model)：DIM / DWD 经前端 UMD 模块 model-detail-normalize.js 的 normalizeModelDetail().sources
 *     （即抽屉血缘卡所用的 extractSources，元素键为 name）；ODS 取 source_system · source_table。服务端 require 同一份文件，不复制逻辑。
 *   · decideObjectState(model, objectCount)：objectState 判定。
 *
 * 工厂 createModelRelations(deps)：GET /api/models/:id/relations 与列表接口的 rel 三计数（attachRelCounts）。
 */

const express = require('express');
const kit = require('../../public/assets/js/model-detail-normalize.js');

const SLOW_MS = 300;   // 列表总耗时超过它记日志（同 /downstream 的做法，作为日后需要缓存的观察信号；不加缓存）

const DOWNSTREAM_FIELDS = ['id', 'table_name', 'table_comment', 'layer', 'status', 'config_mode'];

/** 仅 ASCII 字母转小写（SQLite 默认 LIKE 的大小写规则；不用 toLowerCase，它会改动非 ASCII 字符） */
const asciiLower = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** ORDER BY 的 BINARY 比较：NULL 在前，文本按 UTF-8 字节序 */
function cmpBinary(a, b) {
    if (a == null && b == null) return 0;
    if (a == null) return -1;
    if (b == null) return 1;
    return Buffer.compare(Buffer.from(String(a), 'utf8'), Buffer.from(String(b), 'utf8'));
}

const lowerConfigCache = new WeakMap();   // 每个模型行只小写一次（列表对 145 行各做一次匹配，不重复小写全量 dim_config）
function lowerConfigOf(m) {
    let v = lowerConfigCache.get(m);
    if (v === undefined) {
        v = m.dim_config == null ? null : asciiLower(String(m.dim_config));
        lowerConfigCache.set(m, v);
    }
    return v;
}

function findDownstreamCandidates(modelRow, allModels) {
    const tn = String((modelRow && modelRow.table_name) || '');
    if (!tn) return [];
    const needle = asciiLower(tn);
    const selfId = modelRow.id;
    const hits = [];
    for (const m of allModels) {
        if (m.id === selfId) continue;
        if (m.is_deleted != null && m.is_deleted !== 0) continue;
        const text = lowerConfigOf(m);
        if (text === null || !text.includes(needle)) continue;
        hits.push(m);
    }
    hits.sort((x, y) => cmpBinary(x.layer, y.layer) || cmpBinary(x.table_name, y.table_name) || (x.id - y.id));
    return hits.map((m) => {
        const o = {};
        for (const k of DOWNSTREAM_FIELDS) o[k] = m[k];
        return o;
    });
}

/** dim_config 文本 → 对象（兼容双重 JSON 编码）；不可解析一律 null（与 GET /api/models/:id 同口径） */
function parseDimConfig(raw) {
    if (raw == null || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
        let v = JSON.parse(raw);
        if (typeof v === 'string') v = JSON.parse(v);
        return v;
    } catch (e) { return null; }
}

const trimOrNull = (v) => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
};

function upstreamOfModel(model) {
    const layer = String((model && model.layer) || '').toUpperCase();
    if (layer === 'ODS') {
        const source_system = trimOrNull(model.source_system);
        const source_table = trimOrNull(model.source_table);
        return (source_system === null && source_table === null) ? [] : [{ source_system, source_table }];
    }
    // DIM / DWD：与抽屉同源。伴生表 / 自定义脚本 / 其他分层在抽屉里本就不解析来源，这里一致返回空
    return kit.normalizeModelDetail({
        layer: model.layer, config_mode: model.config_mode, companion_of: model.companion_of,
        dim_config: parseDimConfig(model.dim_config),
    }).sources;
}

/**
 * objectState（方案 §4.5 原句：「listed（有对象）/ companion（伴生表，对象登记在主模型下）/ standard（标准配置，实现对象只有目标表本身）/
 *   pending（custom 且无对象 = 未接入登记）」），按此顺序取第一个成立的：
 *   1 有有效对象 → listed；2 伴生表（companion_of 非空，与 §4.1.2 规则 5 同一判据）→ companion；
 *   3 标准配置（config_mode 为空或 standard——平台处处把空值视同 standard）→ standard；4 config_mode = custom（此处必无对象）→ pending。
 *   其余未知 config_mode 值兜底归 standard（不显示成待登记的工作项）。
 */
function decideObjectState(model, objectCount) {
    if (objectCount > 0) return 'listed';
    if (model.companion_of != null) return 'companion';
    if (!model.config_mode || model.config_mode === 'standard') return 'standard';
    if (model.config_mode === 'custom') return 'pending';
    return 'standard';
}

const SQL_ALL_MODELS = 'SELECT id, table_name, table_comment, layer, status, config_mode, dim_config, is_deleted FROM data_models';

function createModelRelations(deps) {
    const { db, logger, authenticateToken, implObjects } = deps;
    const now = deps.now || Date.now;
    for (const [k, v] of Object.entries({ db, logger, authenticateToken, implObjects })) {
        if (!v) throw new Error(`model-relations：缺少依赖 ${k}`);
    }
    const all = (sql, params = []) => new Promise((resolve, reject) => { db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))); });
    const get = (sql, params = []) => new Promise((resolve, reject) => { db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row))); });

    /** 给列表行追加 rel: { obj, up, down }。startedAt 为列表请求的起点；总耗时超过 300ms 记 warn */
    async function attachRelCounts(rows, opts) {
        const startedAt = opts && Number.isFinite(opts.startedAt) ? opts.startedAt : now();
        const objCounts = await implObjects.countObjectsByModel();
        const allModels = await all(SQL_ALL_MODELS);
        for (const r of rows) {
            r.rel = {
                obj: objCounts.get(Number(r.id)) || 0,
                up: upstreamOfModel(r).length,
                down: findDownstreamCandidates(r, allModels).length,
            };
        }
        const elapsed = now() - startedAt;
        if (elapsed > SLOW_MS) logger.warn(`[models-list] 列表关系计数总耗时 ${elapsed}ms（${rows.length} 行，超过 ${SLOW_MS}ms）`);
    }

    const router = express.Router();
    router.get('/models/:id/relations', authenticateToken, async (req, res) => {
        try {
            // 找不到 → 404；已删除的模型与 GET /api/models/:id 一样照常返回（其对象关系按「模型已删」被过滤，为空）
            const model = await get('SELECT * FROM data_models WHERE id = ?', [req.params.id]);
            if (!model) return res.status(404).json({ error: '模型不存在' });
            const objects = await implObjects.listModelObjects(model.id);
            const allModels = await all(SQL_ALL_MODELS);
            res.json({
                upstream: upstreamOfModel(model),
                downstream: findDownstreamCandidates(model, allModels),
                objects,
                objectState: decideObjectState(model, objects.length),
            });
        } catch (err) {
            logger.error('Get relations error:', err.message);
            res.status(500).json({ error: '关系查询失败' });   // 不外溢 SQL / 驱动内部信息（同 /downstream）
        }
    });

    return { router, attachRelCounts, SQL_ALL_MODELS };
}

module.exports = createModelRelations;
module.exports.findDownstreamCandidates = findDownstreamCandidates;
module.exports.upstreamOfModel = upstreamOfModel;
module.exports.decideObjectState = decideObjectState;
module.exports.parseDimConfig = parseDimConfig;
module.exports.SLOW_MS = SLOW_MS;
module.exports.SQL_ALL_MODELS = SQL_ALL_MODELS;
