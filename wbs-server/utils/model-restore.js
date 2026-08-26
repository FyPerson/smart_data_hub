'use strict';

class ModelRestoreError extends Error {
    constructor(code, message, status) {
        super(message);
        this.name = 'ModelRestoreError';
        this.code = code;
        this.status = status;
    }
}

/**
 * 原位恢复一条软删除模型记录，并在同一事务内写入 RESTORE 审计。
 * 调用方负责身份认证；本函数只处理数据不变量和事务。
 */
async function restoreModelRecord({ modelId, operatorId, operatorName, dbRunAsync, dbGetAsync }) {
    let transactionActive = false;

    try {
        await dbRunAsync('BEGIN IMMEDIATE TRANSACTION');
        transactionActive = true;

        const model = await dbGetAsync('SELECT * FROM data_models WHERE id = ?', [modelId]);
        if (!model) {
            throw new ModelRestoreError('MODEL_NOT_FOUND', '模型不存在', 404);
        }

        if (Number(model.is_deleted) !== 1) {
            await dbRunAsync('COMMIT');
            transactionActive = false;
            return { model, alreadyRestored: true };
        }

        const conflict = await dbGetAsync(
            `SELECT id FROM data_models
             WHERE table_name = ? AND id != ?
               AND (is_deleted = 0 OR is_deleted IS NULL)
             LIMIT 1`,
            [model.table_name, modelId]
        );
        if (conflict) {
            throw new ModelRestoreError(
                'MODEL_NAME_CONFLICT',
                `同名活跃模型已存在（ID ${conflict.id}），无法恢复`,
                409
            );
        }

        const beforeValue = { ...model };
        const updateResult = await dbRunAsync(
            `UPDATE data_models
                SET is_deleted = 0,
                    deleted_at = NULL,
                    deleted_by = NULL,
                    delete_reason = NULL,
                    updated_at = datetime('now', 'localtime')
              WHERE id = ? AND is_deleted = 1`,
            [modelId]
        );
        if (!updateResult || updateResult.changes !== 1) {
            throw new ModelRestoreError('MODEL_RESTORE_CONFLICT', '模型状态已变化，请刷新后重试', 409);
        }

        const restoredModel = await dbGetAsync('SELECT * FROM data_models WHERE id = ?', [modelId]);
        await dbRunAsync(
            `INSERT INTO model_change_logs
             (model_id, model_name, action, change_type, before_value, after_value,
              change_summary, operator_id, operator_name)
             VALUES (?, ?, 'RESTORE', 'restore', ?, ?, ?, ?, ?)`,
            [
                modelId,
                model.table_name,
                JSON.stringify(beforeValue),
                JSON.stringify(restoredModel),
                '恢复软删除模型（保留原ID）',
                operatorId,
                operatorName
            ]
        );

        await dbRunAsync('COMMIT');
        transactionActive = false;
        return { model: restoredModel, alreadyRestored: false };
    } catch (err) {
        if (transactionActive) {
            try { await dbRunAsync('ROLLBACK'); } catch (_) { /* 保留原始错误 */ }
        }
        throw err;
    }
}

module.exports = { restoreModelRecord, ModelRestoreError };
