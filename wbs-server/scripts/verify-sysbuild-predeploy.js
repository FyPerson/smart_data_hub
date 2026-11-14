'use strict';
// Private-fixture checks for the C9 predeploy toolkit; never invokes a deployment.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const testEnv = require('./lib/test-env');
(async () => {
    await testEnv.ready();
    try {
        const flags = process.argv.slice(2);
        if (flags.length && (flags.length !== 1 || flags[0] !== '--self-test')) throw new Error('Only --self-test is supported');
        const self = flags.includes('--self-test');
        const toolDir = path.resolve(__dirname, '../../scripts/sysbuild-predeploy');
        const root = path.resolve(__dirname, '../..');
        const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-predeploy-check-'));
        const cases = self ? [
            ['migration', 'run-migration-self-test.cjs', [], /迁移变异 (\d+)\/(\d+) 判红/],
            ['archive', 'run-archive-self-test.cjs', [], /存档变异 (\d+)\/(\d+) 判红/],
            ['readonly', 'verify-readonly.cjs', ['--self-test'], /只读变异 (\d+)\/(\d+) 判红/],
            ['deploy-guard', 'verify-deploy-migration.cjs', ['--script', path.join(root, 'scripts/deploy-ssh.ps1'), '--self-test'], /部署迁移变异 (\d+)\/(\d+) 判红/],
        ] : [
            ['migration', 'verify-schema-migration.cjs', [], /迁移准备演练 (\d+)\/(\d+)/],
            ['archive', 'verify-archive.cjs', [], /存档准备演练 (\d+)\/(\d+)/],
            ['readonly', 'verify-readonly.cjs', [], /只读准备演练 (\d+)\/(\d+)/],
            ['deploy-guard', 'verify-deploy-migration.cjs', ['--script', path.join(root, 'scripts/deploy-ssh.ps1')], /部署迁移守卫检查 (\d+)\/(\d+)/],
        ];
        const results = [];
        for (const [name, file, args, pattern] of cases) {
            const log = path.join(out, name + '.log'); const fd = fs.openSync(log, 'wx'); const started = new Date().toISOString();
            // The private migration mutation run measured about ten minutes; it is phase-only,
            // while FAMILY uses normal mode. This never changes the API suite's 420-second limit.
            const timeout = self && name === 'migration' ? 30 * 60000 : 300000;
            const result = spawnSync(process.execPath, [path.join(toolDir, file), ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...testEnv.childEnv() }, stdio: ['ignore', fd, fd], timeout });
            fs.closeSync(fd); const ended = new Date().toISOString(); const body = fs.readFileSync(log, 'utf8'); const match = pattern.exec(body);
            const passed = result.status === 0 && !result.signal && !result.error && match && Number(match[1]) > 0 && match[1] === match[2];
            results.push({ name, passed: !!passed, status: result.status, signal: result.signal, error: result.error && result.error.message, started, ended, summary: match && match[0], log });
            console.log((passed ? '  ✓ ' : '  ✗ ') + name + ' ' + (match ? match[0] : 'missing successful completion marker'));
            if (!passed) break;
        }
        const passed = results.filter((r) => r.passed).length;
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), selfTest: self, passed, total: cases.length, results }, null, 2));
        console.log('部署前工具检查 ' + passed + '/' + cases.length + '；证据 ' + out);
        process.exitCode = passed === cases.length ? 0 : 1;
    } finally { await testEnv.teardown(); }
    testEnv.finish(process.exitCode || 0);
})().catch(async (error) => {
    console.error(error.stack);
    try { await testEnv.teardown(); } catch (_) { /* retain primary failure */ }
    process.exitCode = 1;
});
