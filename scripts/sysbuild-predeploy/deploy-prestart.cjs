'use strict';
// Explicitly invoked maintenance step; no database, directory, or migration-version defaults.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const core = require('./schema-migration-core.cjs');
const cli = require('./cli.cjs');
const fail = (code, message) => Object.assign(new Error(message), { code });
function parse(args) {
    const allowed = ['db', 'backup-dir', 'from-version', 'to-version', 'report', 'maintenance-confirmed']; const values = {};
    for (let i = 0; i < args.length; i += 1) {
        const key = args[i].startsWith('--') ? args[i].slice(2) : '';
        if (!allowed.includes(key) || Object.prototype.hasOwnProperty.call(values, key)) throw fail('INVALID_ARGUMENT', '迁移步骤含未知或重复参数');
        if (key === 'maintenance-confirmed') values[key] = true;
        else { const value = args[++i]; if (!value || value.startsWith('--')) throw fail('MISSING_VALUE', '迁移参数缺值'); values[key] = value; }
    }
    if (allowed.some((key) => !Object.prototype.hasOwnProperty.call(values, key))) throw fail('MISSING_ARGUMENT', '数据库、备份目录、来源版本、目标版本、报告及维护确认均须显式提供');
    if (!/^\d+$/.test(values['from-version']) || !/^\d+$/.test(values['to-version'])) throw fail('INVALID_VERSION', '迁移版本须为整数');
    return { dbPath: values.db, backupDir: values['backup-dir'], fromVersion: Number(values['from-version']), toVersion: Number(values['to-version']), reportPath: values.report, maintenanceConfirmed: values['maintenance-confirmed'] };
}
async function execute(options) {
    let started = false; let result;
    try {
        if (!Number.isSafeInteger(options.fromVersion) || options.fromVersion < 0 || options.fromVersion > core.VERSION || options.toVersion !== core.VERSION || options.maintenanceConfirmed !== true) throw fail('UNSUPPORTED_MIGRATION_SCOPE', '来源、目标或维护确认与本工具版本不符');
        cli.checkReportTarget(options.reportPath);
        const localRequire = Module.createRequire(path.join(path.resolve(__dirname, '../..'), 'wbs-server/server.js'));
        const migrator = core.createMigrator({ sqlite3: localRequire('sqlite3'), schemaObjects: localRequire('./routes/sysbuild/schema').SCHEMA_OBJECTS, normalizeSql: localRequire('./routes/sysbuild/db').normalizeSchemaSql, materialReader: localRequire('./routes/sysbuild/materials-core') });
        started = true;
        result = await migrator.apply({ dbPath: options.dbPath, backupDir: options.backupDir, expectedVersion: options.fromVersion, maintenanceConfirmed: options.maintenanceConfirmed });
        const verified = await migrator.inspect({ dbPath: options.dbPath });
        if (verified.sourceVersion !== options.toVersion || verified.action !== 'none' || verified.blocked.length || verified.compatibility.issues.length || verified.digest !== core.KNOWN.find((row) => row.version === options.toVersion).digest) throw fail('POSTCHECK_FAILED', '迁移后复核未通过');
        if (result.applied !== true && result.applied !== false) throw fail('INVALID_MIGRATION_RECEIPT', '迁移回执没有确定执行状态');
        if (result.applied && (!result.backup || result.backup.verified !== true)) throw fail('INVALID_MIGRATION_RECEIPT', '已执行迁移缺少已验证备份');
        cli.writeReport(options.reportPath, { at: new Date().toISOString(), migration: result, verified });
        return { fromVersion: options.fromVersion, toVersion: options.toVersion, applied: result.applied, outcome: result.applied ? 'committed' : 'noop', contractSha256: verified.digest, compatibilityIssues: 0, backup: result.backup || null, report: path.resolve(options.reportPath), reportSha256: crypto.createHash('sha256').update(fs.readFileSync(options.reportPath)).digest('hex') };
    } catch (error) {
        if (result) { error.applied = result.applied; error.outcome = result.applied ? 'committed' : 'noop'; if (result.backup) error.backup = result.backup; }
        else if (![true, false, null].includes(error.applied)) { error.applied = started ? null : false; error.outcome = started ? 'unknown' : 'not_started'; }
        throw error;
    }
}
function failureRecord(error, options) {
    const applied = [true, false, null].includes(error.applied) ? error.applied : null;
    const outcome = error.outcome || (applied === null ? 'unknown' : applied ? 'committed' : 'not_started');
    return { kind: applied === null || outcome === 'unknown' ? 'SYSBUILD_MIGRATION_UNKNOWN' : 'SYSBUILD_MIGRATION_FAIL', payload: { fromVersion: options && options.fromVersion, toVersion: options && options.toVersion, applied, outcome, error: error.code || 'MIGRATION_STEP_FAILED', message: error.message, backup: error.backup || null, report: options && options.reportPath } };
}
async function main(args) {
    let options;
    try {
        try { options = parse(args); } catch (error) { error.applied = false; error.outcome = 'not_started'; throw error; }
        const result = await execute(options); process.stdout.write('SYSBUILD_MIGRATION_OK ' + JSON.stringify(result) + '\n'); return 0;
    } catch (error) {
        const result = failureRecord(error, options); process.stdout.write(result.kind + ' ' + JSON.stringify(result.payload) + '\n'); return 1;
    }
}
if (require.main === module) main(process.argv.slice(2)).then((status) => { process.exitCode = status; });
module.exports = { parse, execute, failureRecord, main };
