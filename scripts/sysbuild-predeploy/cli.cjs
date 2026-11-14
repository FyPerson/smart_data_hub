'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const archive = require('./archive-core.cjs');
const safe = require('./archive-fs.cjs');
const HELP = `sysbuild 部署前准备工具（默认不写源数据）

schema-inspect --db <绝对路径> [--report <新JSON文件>]
schema-apply --db <绝对路径> --backup-dir <既有目录> --expected-version <0..6> --maintenance-confirmed [--report <新JSON文件>]
archive --source <既有3002数据目录> --out <新存档目录> --phase <prearchive|final> [--read-only-proof <JSON文件> --service-port <实际待切换端口>]
verify --archive <存档目录> [--manifest <指定最终清单>] [--report <新JSON文件>]
diff --before <预存档清单> --after <最终清单> --report <新差异JSON>
capture-proof --base-url <明确地址> --expected-port <实际待切换端口> --expected-version <已审服务版本> --report <新JSON文件>

final 必须同时提供 --read-only-proof 和 --service-port；已审服务版本为 ${archive.READ_ONLY_SERVICE_VERSION}。
capture-proof 同时核对URL端口、响应的实际监听端口与显式预期版本；旧缺字段证明拒绝。

生产与真实3002的执行须另按用户在场的部署/切换流程进行。
本工具没有业务库、源目录、端口或凭证的默认值。`;
const SPECS = {
    'schema-inspect': { allowed: ['db', 'report'], required: ['db'] },
    'schema-apply': { allowed: ['db', 'backup-dir', 'expected-version', 'maintenance-confirmed', 'report'], required: ['db', 'backup-dir', 'expected-version', 'maintenance-confirmed'] },
    archive: { allowed: ['source', 'out', 'phase', 'read-only-proof', 'service-port'], required: ['source', 'out', 'phase'] },
    verify: { allowed: ['archive', 'manifest', 'report'], required: ['archive'] },
    diff: { allowed: ['before', 'after', 'report'], required: ['before', 'after', 'report'] },
    'capture-proof': { allowed: ['base-url', 'expected-port', 'expected-version', 'report'], required: ['base-url', 'expected-port', 'expected-version', 'report'] },
};
function parse(args) {
    const [command, ...tokens] = args; const spec = SPECS[command];
    if (!spec) throw safe.fail('INVALID_COMMAND', '未知命令；使用 --help 查看用法');
    const options = {};
    for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (!/^--[a-z-]+$/.test(token)) throw safe.fail('INVALID_ARGUMENT', '参数须使用 --name value，不能省略名称');
        const key = token.slice(2);
        if (!spec.allowed.includes(key) || Object.prototype.hasOwnProperty.call(options, key)) throw safe.fail('INVALID_ARGUMENT', '不支持或重复的参数：' + token);
        if (key === 'maintenance-confirmed') options[key] = true;
        else { const value = tokens[++i]; if (!value || value.startsWith('--')) throw safe.fail('MISSING_VALUE', '参数缺值：' + token); options[key] = value; }
    }
    for (const key of spec.required) if (!Object.prototype.hasOwnProperty.call(options, key)) throw safe.fail('MISSING_ARGUMENT', '缺少必填参数：--' + key);
    if (command === 'archive' && options.phase === 'final') for (const key of ['read-only-proof', 'service-port']) if (!Object.prototype.hasOwnProperty.call(options, key)) throw safe.fail('MISSING_ARGUMENT', '最终清单缺少必填参数：--' + key);
    return { command, options };
}
function checkReportTarget(file) {
    if (!path.isAbsolute(file)) throw safe.fail('ABSOLUTE_PATH_REQUIRED', '报告必须是绝对路径');
    safe.existing(path.dirname(file), 'directory'); safe.part(path.basename(file));
    try { fs.lstatSync(file); throw safe.fail('REPORT_EXISTS', '报告已存在，拒绝覆盖'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function writeReport(file, value) {
    checkReportTarget(file);
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });
}
function portNumber(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > 65535) throw safe.fail('INVALID_PORT', '端口必须是1到65535的显式整数');
    return Number(value);
}
async function main(args) {
    if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
    const { command, options: o } = parse(args); let result;
    if (o.report) checkReportTarget(o.report);
    if (command.startsWith('schema-')) {
        const fromServer = Module.createRequire(path.join(path.resolve(__dirname, '../..'), 'wbs-server/server.js'));
        const migrator = require('./schema-migration-core.cjs').createMigrator({ sqlite3: fromServer('sqlite3'), schemaObjects: fromServer('./routes/sysbuild/schema').SCHEMA_OBJECTS, normalizeSql: fromServer('./routes/sysbuild/db').normalizeSchemaSql, materialReader: fromServer('./routes/sysbuild/materials-core') });
        if (command === 'schema-inspect') result = await migrator.inspect({ dbPath: o.db });
        else {
            if (!/^[0-6]$/.test(o['expected-version'])) throw safe.fail('INVALID_VERSION', '来源版本必须是0到6的整数');
            result = await migrator.apply({ dbPath: o.db, backupDir: o['backup-dir'], expectedVersion: Number(o['expected-version']), maintenanceConfirmed: o['maintenance-confirmed'] });
        }
    } else if (command === 'archive') result = await archive.exportArchive({ sourceDir: o.source, outputDir: o.out, phase: o.phase, servicePort: o['service-port'] === undefined ? undefined : portNumber(o['service-port']), readOnlyProof: o['read-only-proof'] ? safe.json(safe.existing(o['read-only-proof'], 'file')) : undefined });
    else if (command === 'verify') result = await archive.verifyArchive({ directory: o.archive, manifestFile: o.manifest });
    else if (command === 'diff') result = archive.compareManifests({ beforeFile: o.before, afterFile: o.after });
    else if (command === 'capture-proof') {
        const base = new URL(o['base-url']);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw safe.fail('INVALID_BASE_URL', '地址须为不带凭证、路径、查询或片段的HTTP服务根地址');
        const expectedPort = portNumber(o['expected-port']);
        const urlPort = Number(base.port || (base.protocol === 'https:' ? 443 : 80));
        if (urlPort !== expectedPort) throw safe.fail('PROOF_URL_PORT_MISMATCH', '取证URL端口与显式预期监听端口不符');
        const response = await fetch(new URL('/api/archive-proof', base), { signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw safe.fail('PROOF_REQUEST_FAILED', '只读核对端点拒绝请求，HTTP ' + response.status);
        const proof = await response.json();
        if (!proof || proof.readOnly !== true || typeof proof.workspaceId !== 'string' || typeof proof.revision !== 'string' || typeof proof.capturedAt !== 'string' || typeof proof.dataDir !== 'string' || !path.isAbsolute(proof.dataDir) || !Number.isInteger(proof.port) || proof.port < 1 || proof.port > 65535 || typeof proof.serviceVersion !== 'string') throw safe.fail('INVALID_PROOF', '服务器未返回绑定数据目录、端口及版本的有效只读核对记录');
        if (proof.port !== expectedPort || proof.serviceVersion !== o['expected-version'] || proof.serviceVersion !== archive.READ_ONLY_SERVICE_VERSION) throw safe.fail('PROOF_SERVICE_MISMATCH', '服务器实际监听端口或版本与预期已审服务不符');
        result = { readOnly: true, workspaceId: proof.workspaceId, revision: proof.revision, capturedAt: proof.capturedAt, dataDir: proof.dataDir, port: proof.port, serviceVersion: proof.serviceVersion };
    }
    if (o.report) {
        try { writeReport(o.report, result); }
        catch (error) { error.applied = result && result.applied === true; if (result && result.backup) error.backup = result.backup; throw error; }
    }
    console.log(JSON.stringify(result, null, 2)); return result;
}
if (require.main === module) main(process.argv.slice(2)).then((result) => { if (result && result.action === 'blocked') process.exitCode = 2; }).catch((error) => { console.error(JSON.stringify({ error: error.code || 'PREPARATION_FAILED', message: error.message, applied: error.applied === null ? null : error.applied === true, outcome: error.outcome || 'failed', backup: error.backup, closeError: error.closeError, partialDirectory: error.partialDirectory })); process.exitCode = 1; });
module.exports = { main, parse, writeReport, checkReportTarget };
