'use strict';

/**
 * 模型配置版本号（config_rev）记账助手（方案 v0.9 §4.1.1「统一递增助手」）。
 *
 * 两种形态，除此之外不允许在别处手写 config_rev 自增：
 *   1. bumpConfigRev(db, modelIds)：独立一条 UPDATE；助手本身不开事务（调用方不开事务时自动提交）。
 *      impl-objects 模块在自己的事务内调用它，使递增与关系变更同提交同回滚；
 *   2. CONFIG_REV_BUMP_SQL：SQL 片段，供需要与字段写入并入同一条 UPDATE 的写入点拼接
 *      （PUT 两条 SET、utils/model-restore.js 的恢复 UPDATE）。
 *
 * 片段约定：`config_rev = config_rev + ?`，调用方传入 0 或 1（PUT 由 JS 判定 A 类字段是否变化；恢复恒传 1）。
 */

const CONFIG_REV_BUMP_SQL = 'config_rev = config_rev + ?';

function normalizeIds(modelIds) {
    const list = Array.isArray(modelIds) ? modelIds : [modelIds];
    const out = [];
    for (const v of list) {
        const n = Number(v);
        if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    }
    return out;
}

/**
 * 单条 UPDATE 递增一批模型的 config_rev。返回 Promise<{ changes }>。
 * 不开事务（平台只有一个共享 sqlite 连接，显式事务会卷入其他模块的语句）。
 */
function bumpConfigRev(db, modelIds) {
    const ids = normalizeIds(modelIds);
    if (ids.length === 0) return Promise.resolve({ changes: 0 });
    const placeholders = ids.map(() => '?').join(',');
    return new Promise((resolve, reject) => {
        // mc-write: bump-helper
        db.run(
            `UPDATE data_models SET config_rev = config_rev + 1 WHERE id IN (${placeholders})`,
            ids,
            function (err) {
                if (err) return reject(err);
                resolve({ changes: this && typeof this.changes === 'number' ? this.changes : 0 });
            }
        );
    });
}

module.exports = { bumpConfigRev, CONFIG_REV_BUMP_SQL };
