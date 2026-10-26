#!/usr/bin/env node
/**
 * 通用批跑入口（#106 S3c）：按参数或清单文件跑任意脚本集合，共享 scripts/lib/test-batch.js 的批跑核心
 * （需服务的成员共用一个按需起的临时实例；独占成员各起一个；所有成员的子进程环境先剔除继承来的测试变量）。
 *
 * 用法：
 *   node scripts/run-test-batch.js --manifest=<成员表.json> [选项]
 *   node scripts/run-test-batch.js [--service] [--exclusive] [--resources=a,b] [--timeout-ms=N] [选项] <脚本> [<脚本> ...]
 * 清单文件：JSON 数组，或 { "members": [...] }；成员字段见 scripts/lib/test-batch.js 头注释（label 缺省取 rel；rel 相对 wbs-server 根，也可以是绝对路径）。
 * 参数形态：所有位置参数各成一个成员，共用 --service / --exclusive / --resources / --timeout-ms；成员不带命令行参数（要带参数用清单文件）。
 * 选项：
 *   --timeout-ms=N                 需服务成员的缺省截止（毫秒，默认 20 分钟）；参数形态下同时作为各成员的 timeoutMs
 *   --instance-options-file=<json>  传给启动器的实例选项（默认空 = 启动器的默认来源：本检出的库与 .env）。只接受 sourceDbPath / sourceEncryptionKey（只能是 null）/ serverJs / resourceRoot /
 *                                   readyTimeoutMs / startupRaceRetries / modules / waitFor；resources 由成员声明，不能写在这里
 *   --test-batch-core=<绝对路径>    测试接缝（只给自检用，把变异过的批跑核心接进来；正常使用不传）
 *   --help                          打印本说明
 * 输出：每个成员一行 `PASS|FAIL <label> (<毫秒>ms)`，失败的紧接着打印其输出；末行 `BATCH PASS=<n> FAIL=<n>[ FAILED: ...]`；起过实例时再一行 `TEST_INSTANCES ...`。
 * 退出码：全部通过 0，否则 1（含参数错误、清单不合法、实例停止失败）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { runBatch } = require('./lib/test-batch');

const WBS_DIR = path.resolve(__dirname, '..');
const INSTANCE_OPTION_KEYS = ['sourceDbPath', 'sourceEncryptionKey', 'serverJs', 'resourceRoot', 'readyTimeoutMs', 'startupRaceRetries', 'modules', 'waitFor'];

const USAGE = [
    '用法：',
    '  node scripts/run-test-batch.js --manifest=<成员表.json> [--instance-options-file=<json>] [--timeout-ms=N]',
    '  node scripts/run-test-batch.js [--service] [--exclusive] [--resources=a,b] [--timeout-ms=N] [--instance-options-file=<json>] <脚本> [<脚本> ...]',
    '清单文件是 JSON 数组或 { "members": [...] }；成员字段 label / rel / args / needsService / resources / exclusive / timeoutMs（见 scripts/lib/test-batch.js）。',
].join('\n');

class UsageError extends Error {}

function readJsonFile(file, what) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new UsageError(`读取${what} ${file} 失败：${e && e.code ? e.code : e && e.message}`); }
    try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new UsageError(`${what} ${file} 不是合法 JSON：${e.message}`); }
}

function parseArgs(argv) {
    const o = { manifest: null, instanceOptionsFile: null, testBatchCore: null, timeoutMs: null, service: false, exclusive: false, resources: null, positional: [], help: false };
    for (const a of argv) {
        if (a === '--help' || a === '-h') o.help = true;
        else if (a === '--service') o.service = true;
        else if (a === '--exclusive') o.exclusive = true;
        else if (a.startsWith('--manifest=')) o.manifest = a.slice('--manifest='.length);
        else if (a.startsWith('--instance-options-file=')) o.instanceOptionsFile = a.slice('--instance-options-file='.length);
        else if (a.startsWith('--test-batch-core=')) o.testBatchCore = a.slice('--test-batch-core='.length);
        else if (a.startsWith('--resources=')) o.resources = a.slice('--resources='.length).split(',').map((s) => s.trim()).filter(Boolean);
        else if (a.startsWith('--timeout-ms=')) {
            const n = Number(a.slice('--timeout-ms='.length));
            if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`--timeout-ms 必须是正整数：${a}`);
            o.timeoutMs = n;
        } else if (a.startsWith('--')) throw new UsageError(`未知选项 ${a}`);
        else o.positional.push(a);
    }
    return o;
}

function buildMembers(o) {
    if (o.manifest !== null) {
        if (o.positional.length || o.service || o.exclusive || o.resources !== null) throw new UsageError('--manifest 不能与位置参数、--service / --exclusive / --resources 同用');
        const raw = readJsonFile(o.manifest, '清单文件');
        const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.members) ? raw.members : null);
        if (list === null) throw new UsageError('清单文件必须是 JSON 数组或 { "members": [...] }');
        return list.map((m) => (m && typeof m === 'object' && !Array.isArray(m) && m.label === undefined && typeof m.rel === 'string' ? Object.assign({ label: m.rel }, m) : m));
    }
    if (o.positional.length === 0) throw new UsageError('没有给任何脚本（位置参数）或清单文件');
    if (o.resources !== null && !o.service && !o.exclusive) throw new UsageError('--resources 需要同时给 --service 或 --exclusive');
    return o.positional.map((rel) => {
        const m = { label: rel, rel };
        if (o.service || o.exclusive) m.needsService = true;
        if (o.exclusive) m.exclusive = true;
        if (o.resources !== null) m.resources = o.resources;
        if (o.timeoutMs !== null && (o.service || o.exclusive)) m.timeoutMs = o.timeoutMs;
        return m;
    });
}

function loadInstanceOptions(file) {
    if (file === null) return {};
    const raw = readJsonFile(file, '实例选项文件');
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError('实例选项文件必须是 JSON 对象');
    for (const k of Object.keys(raw)) {
        if (!INSTANCE_OPTION_KEYS.includes(k)) throw new UsageError(`实例选项文件里有不接受的键 ${JSON.stringify(k)}（接受：${INSTANCE_OPTION_KEYS.join(' / ')}）`);
    }
    if (raw.sourceEncryptionKey !== undefined && raw.sourceEncryptionKey !== null) throw new UsageError('实例选项文件里的 sourceEncryptionKey 只能是 null（不把密钥写进文件）');
    return raw;
}

async function main() {
    const o = parseArgs(process.argv.slice(2));
    if (o.help) { console.log(USAGE); return 0; }
    const members = buildMembers(o);
    const instanceOptions = loadInstanceOptions(o.instanceOptionsFile);
    const batchOptions = { instanceOptions, cwd: WBS_DIR };
    if (o.timeoutMs !== null) batchOptions.defaultTimeoutMs = o.timeoutMs;
    batchOptions.onResult = (r) => {
        console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.label} (${r.ms}ms)`);
        if (!r.ok) {
            for (const n of r.notes) console.log(`  [批跑] ${n}`);
            console.log(r.out);
        }
    };
    // 测试接缝：--test-batch-core=<绝对路径> 只给自检用（把变异过的批跑核心接进来），正常使用不传
    const run = o.testBatchCore !== null ? require(path.resolve(o.testBatchCore)).runBatch : runBatch;
    const batch = await run(members, batchOptions);
    const failed = batch.failed.slice();
    for (const e of batch.errors) failed.push(`test-batch(${e.split('：')[0]})`);
    console.log(`BATCH PASS=${batch.pass} FAIL=${failed.length}${failed.length ? ' FAILED: ' + failed.join(' ') : ''}`);
    if (batch.instancesLine !== null) console.log(batch.instancesLine);
    for (const e of batch.errors) console.log(`[批跑] ${e}`);
    return failed.length === 0 ? 0 : 1;
}

main().then((code) => { process.exitCode = code; }, (e) => {
    if (e instanceof UsageError) console.error(`${e.message}\n${USAGE}`);
    else console.error(`批跑异常：${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
}).then(() => {
    // 兜底：所有实例都已显式 stop()，事件循环本应自然排空；万一有残留句柄，10 秒后按已定的退出码退出（unref：不自己延长进程寿命）
    setTimeout(() => process.exit(process.exitCode === undefined ? 1 : process.exitCode), 10000).unref();
});
