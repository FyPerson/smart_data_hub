'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { spawnSync } = require('child_process');
const mutations = require('./schema-migration-mutations.cjs');
const root = path.resolve(__dirname, '../..');
const test = path.join(__dirname, 'verify-schema-migration.cjs');
const testEnv = Module.createRequire(path.join(root, 'wbs-server/server.js'))('./scripts/lib/test-env');
let out, childEnv, finished = false;
function run(name, args) {
    const result = spawnSync(process.execPath, [test, ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...childEnv }, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
    const log = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(path.join(out, name + '.log'), log, { flag: 'wx' });
    const match = /迁移准备演练 \d+\/\d+；证据 ([^\r\n]+)/.exec(log);
    const summary = match ? JSON.parse(fs.readFileSync(path.join(match[1], 'results.json'), 'utf8')) : null;
    return { status: result.status, signal: result.signal, error: result.error && result.error.message, summary, evidence: match && match[1] };
}
(async () => {
await testEnv.ready();
out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-migration-mut-')); childEnv = testEnv.childEnv();
try {
const baseline = run('baseline', []);
if (baseline.status !== 0 || !baseline.summary || baseline.summary.passed !== baseline.summary.total) throw new Error('Unmutated migration baseline failed; evidence ' + out);
console.log('迁移未变异基线 ' + baseline.summary.passed + '/' + baseline.summary.total);
const results = [];
for (const [index, mutation] of mutations.entries()) {
    const source = fs.readFileSync(path.join(__dirname, mutation.file || 'schema-migration-core.cjs'), 'utf8').replace(/\r\n/g, '\n');
    const count = source.split(mutation.from).length - 1;
    if (count !== 1) { results.push({ id: mutation.id, red: false, error: 'anchor count ' + count }); console.log('锚点失败 ' + mutation.id); continue; }
    const file = path.join(out, 'candidate-' + index + '.cjs');
    fs.writeFileSync(file, source.replace(mutation.from, () => mutation.to), { flag: 'wx' });
    const candidateFlag = mutation.file === 'cli.cjs' ? '--candidate-cli' : mutation.file === 'deploy-prestart.cjs' ? '--candidate-step' : '--candidate';
    const result = run('mutation-' + index, [candidateFlag, file]);
    const failed = result.summary ? result.summary.results.filter((r) => !r.passed).map((r) => r.name) : [];
    const red = result.status === 1 && !result.signal && !result.error && result.summary && result.summary.total === baseline.summary.total && failed.some((name) => name.startsWith(mutation.expect));
    results.push({ id: mutation.id, red: !!red, status: result.status, failed, evidence: result.evidence, error: result.error });
    console.log((red ? '变异判红 ' : '变异未检出 ') + mutation.id);
}
const red = results.filter((r) => r.red).length;
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'C9 draft, private fixtures only', baseline: { passed: baseline.summary.passed, total: baseline.summary.total, evidence: baseline.evidence }, red, total: results.length, results }, null, 2));
console.log('迁移变异 ' + red + '/' + results.length + ' 判红；证据 ' + out);
process.exitCode = red === results.length ? 0 : 1;
} catch (error) { process.exitCode = 1; throw error; }
finally { await testEnv.teardown(); testEnv.finish(process.exitCode || 0); finished = true; }
})().catch((error) => { console.error(error.stack); if (!finished) process.exitCode = 1; });
