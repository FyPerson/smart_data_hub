'use strict';
// Reads source, executes only allowlisted pure helpers and mocked AST blocks.
// Never executes deploy-ssh.ps1 main, ssh/scp/git, or the displayed process probe.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const flags = process.argv.slice(2); const settings = {};
for (let i = 0; i < flags.length; i += 1) {
    const key = flags[i];
    if (!['--script', '--self-test'].includes(key) || settings[key] !== undefined) throw new Error('Invalid or duplicate argument');
    settings[key] = key === '--self-test' ? true : flags[++i];
}
if (!settings['--script'] || !path.isAbsolute(settings['--script'])) throw new Error('Absolute --script is required');
const scriptFile = settings['--script']; const source = fs.readFileSync(scriptFile, 'utf8');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-deploy-guard-'));
const reportPath = 'E:\\Task_Pool_deploy_tmp\\sysbuild_migration_unit.json';
const digest = 'b354be11ba53a480dbbf73a587ad351dbc3b3e37506550e46c019ae0610f47e7';
const payload = (extra) => ({ fromVersion: 1, toVersion: 6, applied: true, outcome: 'committed', compatibilityIssues: 0, contractSha256: digest, report: reportPath, reportSha256: 'b'.repeat(64), backup: { verified: true, path: 'E:\\Task_Pool_deploy_tmp\\sysbuild-migrate-unit\\before.sqlite', sha256: 'a'.repeat(64) }, ...extra });
const proc = (data, tag, extra) => ({ ExitCode: tag === 'SYSBUILD_MIGRATION_FAIL' || tag === 'SYSBUILD_MIGRATION_UNKNOWN' ? 1 : 0, Stdout: (tag || 'SYSBUILD_MIGRATION_OK') + ' ' + JSON.stringify(data) + '\n', Stderr: '', StartError: null, TimedOut: false, ...extra });
const protocolCases = [
    ['source-zero', payload({ fromVersion: 0 }), null, null, 'OK', 0],
    ['source-one', payload(), null, null, 'OK', 1],
    ['current-register', payload({ fromVersion: 6 }), null, null, 'OK', 6],
    ['current-noop', payload({ fromVersion: 6, applied: false, outcome: 'noop', backup: null }), null, null, 'OK', 6],
    ['known-fail', payload({ applied: false, outcome: 'rolled_back' }), 'SYSBUILD_MIGRATION_FAIL', null, 'FAIL', 1],
    ['committed-report-fail', payload(), 'SYSBUILD_MIGRATION_FAIL', null, 'FAIL', 1],
    ['uncertain', payload({ applied: null, outcome: 'unknown' }), 'SYSBUILD_MIGRATION_UNKNOWN', null, 'UNKNOWN', 1],
    ['no-protocol', null, null, { Stdout: 'ordinary output\n' }, 'UNKNOWN', 1],
    ['no-final-newline', null, null, { Stdout: 'SYSBUILD_MIGRATION_OK ' + JSON.stringify(payload()) }, 'UNKNOWN', 1],
    ['broken-json', null, null, { Stdout: 'SYSBUILD_MIGRATION_OK {\n' }, 'UNKNOWN', 1],
    ['array-json', null, null, { Stdout: 'SYSBUILD_MIGRATION_OK []\n' }, 'UNKNOWN', 1],
    ['ok-exit-one', payload(), null, { ExitCode: 1 }, 'UNKNOWN', 1],
    ['wrong-source', payload({ fromVersion: 2 }), null, null, 'UNKNOWN', 1],
    ['wrong-target', payload({ toVersion: 7 }), null, null, 'UNKNOWN', 1],
    ['wrong-report', payload({ report: reportPath + '.old' }), null, null, 'UNKNOWN', 1],
    ['wrong-contract', payload({ contractSha256: '0'.repeat(64) }), null, null, 'UNKNOWN', 1],
    ['bad-snapshot', payload({ compatibilityIssues: 1 }), null, null, 'UNKNOWN', 1],
    ['unverified-backup', payload({ backup: { verified: false, path: 'x', sha256: 'a'.repeat(64) } }), null, null, 'UNKNOWN', 1],
    ['missing-backup', payload({ backup: null }), null, null, 'UNKNOWN', 1],
    ['string-applied', payload({ applied: 'true' }), null, null, 'UNKNOWN', 1],
    ['string-version', payload({ fromVersion: '1' }), null, null, 'UNKNOWN', 1],
    ['fail-exit-zero', payload({ applied: false, outcome: 'rolled_back' }), 'SYSBUILD_MIGRATION_FAIL', { ExitCode: 0 }, 'UNKNOWN', 1],
    ['timeout', payload(), null, { TimedOut: true }, 'UNKNOWN', 1],
    ['start-error', payload(), null, { StartError: 'private fixture failure' }, 'UNKNOWN', 1],
    ['noop-wrong-source', payload({ applied: false, outcome: 'noop', backup: null }), null, null, 'UNKNOWN', 1],
    ['missing-report-sha', payload({ reportSha256: null }), null, null, 'UNKNOWN', 1],
    ['crlf', null, null, { Stdout: 'SYSBUILD_MIGRATION_OK ' + JSON.stringify(payload()) + '\r\n' }, 'OK', 1],
].map(([name, data, tag, extra, expected, from]) => ({ name, proc: proc(data || payload(), tag, extra), expected, from, report: reportPath }));
const unitFile = path.join(out, 'unit.ps1');
const unitProgram = fs.readFileSync(path.join(__dirname, 'deploy-guard-unit.ps1.txt'), 'utf8');
fs.writeFileSync(unitFile, '\uFEFF' + unitProgram.replace(/\r?\n/g, '\r\n'));
const casesFile = path.join(out, 'cases.json'); fs.writeFileSync(casesFile, JSON.stringify(protocolCases));
const moduleListingPattern = String.raw`\A100(?:644|755) blob [0-9a-f]{40}\twbs-server/routes/sysbuild/schema[.]js\r?\n\z`;
const mutations = [
    { id: 'success-nonzero-exit', from: 'if (-not (Test-Ok $Res)) { return $unknown }', to: 'if ($false) { return $unknown }' },
    { id: 'wrong-source-scope', from: '$j.fromVersion -ne $ExpectedFromVersion -or ', to: '' },
    { id: 'wrong-target-scope', from: '$j.toVersion -ne 6 -or ', to: '' },
    { id: 'compatibility-not-zero', from: '-or $j.compatibilityIssues -ne 0)', to: ')' },
    { id: 'backup-unverified', from: '-or -not $j.backup.verified -or ', to: '-or ' },
    { id: 'failure-continues-start', from: "if ($migrationOutcome.Outcome -ne 'OK') {", to: 'if ($false) {' },
    { id: 'missing-tool-continues', from: 'if (-not (Test-Ok $migrationTool)) {', to: 'if ($false) {' },
    { id: 'real-result-overwritten-by-dryrun', from: 'if ($migrationRes.DryRun) {', to: 'if ($true) {', expect: 'flow:real_fail' },
    { id: 'migration-wrong-database', from: '--db `"$RemoteDb`"', to: '--db `"E:\\wrong.sqlite`"', expect: 'flow:real_ok' },
    { id: 'migration-wrong-backup-directory', from: '--backup-dir `"$RemoteTmpDir`"', to: '--backup-dir `"E:\\wrong-backup`"', expect: 'flow:real_ok' },
    { id: 'migration-missing-maintenance-confirmation', from: '--report `"$migrationReport`" --maintenance-confirmed"', to: '--report `"$migrationReport`""', expect: 'flow:real_ok' },
    { id: 'first-deploy-missing-flag-allowed', from: "if ($ledgerState -eq 'absent' -and -not $script:SysbuildMigrationRequested)", to: 'if ($false)', expect: 'ledger:absent_no_flag' },
    { id: 'ledger-read-failure-treated-as-present', from: "if (-not (Test-Ok $Res) -or -not ([string]$Res.Stdout).EndsWith(\"`n\")) { return 'unknown' }", to: "if ($false) { return 'unknown' }", expect: 'ledger:failed_query' },
    { id: 'module-query-failure-treated-as-absent', from: "if (-not (Test-Ok $Res) -or $Res.Stdout -isnot [string]) { return 'unknown' }", to: "if (-not (Test-Ok $Res) -or $Res.Stdout -isnot [string]) { return 'absent' }", expect: 'module:query_fail_empty' },
    { id: 'module-stdout-type-check-removed', from: ' -or $Res.Stdout -isnot [string]', to: '', expect: 'module:null_stdout' },
    { id: 'module-absent-treated-as-present', from: "if ($listing -ceq '') { return 'absent' }", to: "if ($listing -ceq '') { return 'present' }", expect: 'module:absent' },
    { id: 'module-invalid-listing-treated-as-present', from: "$listing -cmatch '" + moduleListingPattern + "'", to: '$true', expect: 'module:bad_mode' },
    { id: 'module-present-treated-as-absent', from: "if ($listing -cmatch '" + moduleListingPattern + "') { return 'present' }", to: "if ($listing -cmatch '" + moduleListingPattern + "') { return 'absent' }", expect: 'module:present_lf' },
    { id: 'module-unknown-continues', from: "if ($moduleState -eq 'unknown') { Stop-BeforeStop", to: 'if ($false) { Stop-BeforeStop', expect: 'module:query_fail_valid' },
    { id: 'module-probe-wrong-path', from: "@('ls-tree', '--full-tree', $script:NewCommit, '--', 'wbs-server/routes/sysbuild/schema.js')", to: "@('ls-tree', '--full-tree', $script:NewCommit, '--', 'wbs-server/routes/sysbuild/schema-old.js')", expect: 'module:command:present_lf' },
    { id: 'module-probe-wrong-subcommand', from: "@('ls-tree', '--full-tree', $script:NewCommit,", to: "@('cat-file', '--full-tree', $script:NewCommit,", expect: 'module:command:present_lf' },
    { id: 'module-probe-missing-newline-accepted', from: moduleListingPattern, to: moduleListingPattern.replace(String.raw`\r?\n\z`, String.raw`\r?\n?\z`), expect: 'module:missing_newline' },
    { id: 'module-probe-nonregular-mode-accepted', from: moduleListingPattern, to: moduleListingPattern.replace('100(?:644|755)', '[0-9]{6}'), expect: 'module:bad_mode' },
];
function executeCandidate(file, label) {
    const dir = path.join(out, label); fs.mkdirSync(dir); const guard = path.join(dir, 'guard.ps1');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', unitFile, '-Source', file, '-InputFile', casesFile, '-GuardFile', guard], { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    fs.writeFileSync(path.join(dir, 'unit.log'), (result.stdout || '') + (result.stderr || ''));
    if (result.status !== 0 || result.error || result.signal) throw new Error('Unit harness failed: ' + label + ' / ' + (result.stderr || result.error));
    const data = JSON.parse(result.stdout.trim()); const failures = [];
    const moduleNames = ['present_lf', 'present_crlf', 'present_executable_lf', 'present_executable_crlf', 'absent', 'null_stdout', 'nonstring_stdout', 'query_fail_empty', 'query_fail_valid', 'query_fail_one', 'timeout', 'start_error', 'missing_newline', 'truncated', 'bad_mode', 'bad_type', 'bad_path', 'bad_hash_case', 'junk', 'prefixed_junk', 'extra_entry', 'trailing_junk'];
    if (!Array.isArray(data.modules) || data.modules.length !== moduleNames.length || moduleNames.some((name) => data.modules.filter((row) => row.name === name).length !== 1)) throw new Error('Module probe fixture matrix is incomplete');
    const expectedModuleCommand = 'GIT ls-tree --full-tree ' + 'a'.repeat(40) + ' -- wbs-server/routes/sysbuild/schema.js TIMEOUT 30';
    for (const row of data.modules) {
        const expectedState = row.name.startsWith('present_') ? 'present' : row.name === 'absent' ? 'absent' : 'unknown';
        const reads = row.tape.filter((entry) => entry.startsWith('READ '));
        const writes = row.tape.filter((entry) => entry.startsWith('COMMAND '));
        if (row.tape[0] !== expectedModuleCommand || row.tape.filter((entry) => entry.startsWith('GIT ')).length !== 1) failures.push('module:command:' + row.name);
        const badState = row.expectedState !== expectedState || row.state !== expectedState;
        if (expectedState === 'unknown') {
            if (badState || row.exitCode !== 1 || !row.tape.includes('BEFORE_STOP') || reads.length !== 0 || writes.length !== 0) failures.push('module:' + row.name);
        } else if (expectedState === 'absent') {
            if (badState || row.exitCode !== null || row.tape.includes('BEFORE_STOP') || reads.length !== 0 || writes.length !== 0) failures.push('module:' + row.name);
        } else if (badState || row.exitCode !== null || row.tape.includes('BEFORE_STOP') || reads.length !== 1 || writes.length !== 0) failures.push('module:' + row.name);
    }
    for (const row of data.protocols) if (row.actual !== row.expected) failures.push('protocol:' + row.name);
    const getFlow = (name) => data.flows.find((row) => row.name === name);
    if (getFlow('off').tape.length !== 0 || getFlow('off').exitCode !== null) failures.push('flow:off');
    for (const name of ['ok','real_ok','real_noop']) {
        const from=name==='real_noop'?6:0;
        const expected='COMMAND cd /d "E:\\fixture repo" && node scripts\\sysbuild-predeploy\\deploy-prestart.cjs --db "E:\\fixture db\\module.sqlite" --backup-dir "E:\\fixture tmp" --from-version '+from+' --to-version 6 --report "E:\\fixture tmp\\sysbuild_migration_unit.json" --maintenance-confirmed';
        if (getFlow(name).exitCode !== null || !getFlow(name).tape.includes(expected) || !getFlow(name).tape.includes('STAGE code_updated')) failures.push('flow:'+name);
    }
    for (const name of ['sysbuild_migration_fail', 'sysbuild_migration_unknown','real_fail','real_unknown','real_missing','real_committed_failure']) if (getFlow(name).exitCode !== 1 || !getFlow(name).tape.includes('MANUAL_RECOVERY') || getFlow(name).tape.includes('STAGE code_updated')) failures.push('flow:' + name);
    for (const row of data.ledger) {
        if (row.exitCode !== row.expectedExit) failures.push('ledger:'+row.name);
        if (row.tape[0] !== expectedModuleCommand) failures.push('ledger:module-command:' + row.name);
        const read=row.tape.find(x=>x.startsWith('READ '));
        if (!row.name.startsWith('fake_') && (!read || !read.includes('sqlite3.OPEN_READONLY') || !read.includes("E:/fixture db/module.sqlite") || !read.includes('sysbuild_schema_migrations'))) failures.push('ledger:readonly-command:'+row.name);
    }
    for (const row of data.preflights) if (row.exists ? row.exitCode !== null : row.exitCode !== 1 || !row.tape.includes('BEFORE_STOP')) failures.push('preflight:' + row.exists);
    if (!data.probe.includes('Get-CimInstance') || !data.probe.includes('deploy-prestart[.]cjs') || !data.probe.includes('SYSBUILD_MIGRATION_PROCESS_SCAN_OK count=') || !data.probe.includes('-ErrorAction Stop')) failures.push('recovery:process-probe');
    const guards = [
        ['off', [], 0, false], ['zero', ['-SysbuildMigrationFromVersion', '0'], 0, true], ['six', ['-SysbuildMigrationFromVersion', '6'], 0, true],
        ['out-of-range', ['-SysbuildMigrationFromVersion', '7'], 2], ['fraction', ['-SysbuildMigrationFromVersion', '1.5'], 2], ['spaces', ['-SysbuildMigrationFromVersion', ' 1'], 2],
        ['simulation-without-scope', ['-DryRun', '-DryRunFailAt', 'sysbuild_migration_fail'], 2],
    ];
    for (const [name, args, status, requested] of guards) {
        const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', guard, ...args], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
        if (child.status !== status || child.error) failures.push('parameter:' + name);
        else if (status === 0 && JSON.parse(child.stdout.trim()).requested !== requested) failures.push('parameter:' + name);
    }
    const total=protocolCases.length+data.flows.length+data.modules.length+data.ledger.length+data.preflights.length+guards.length+1;
    return { passed: total - failures.length, total, failures, directory: dir };
}
const baseline = executeCandidate(scriptFile, 'baseline');
console.log('部署迁移守卫检查 ' + baseline.passed + '/' + baseline.total + '；证据 ' + out);
if (baseline.failures.length) { console.log(JSON.stringify(baseline.failures)); process.exitCode = 1; }
else if (settings['--self-test']) {
    const results = [];
    for (const [index, mutation] of mutations.entries()) {
        const count = source.split(mutation.from).length - 1;
        if (count !== 1) { results.push({ id: mutation.id, red: false, error: 'anchor count ' + count }); continue; }
        const file = path.join(out, 'candidate-' + index + '.ps1'); fs.writeFileSync(file, source.replace(mutation.from, () => mutation.to));
        const result = executeCandidate(file, 'mutation-' + index); const red = mutation.expect ? result.failures.includes(mutation.expect) : result.failures.length > 0;
        results.push({ id: mutation.id, red, failures: result.failures, directory: result.directory }); console.log((red ? '变异判红 ' : '变异未检出 ') + mutation.id);
    }
    const red = results.filter((r) => r.red).length; fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), baseline, red, total: results.length, results }, null, 2));
    console.log('部署迁移变异 ' + red + '/' + results.length + ' 判红；证据 ' + out); process.exitCode = red === results.length ? 0 : 1;
} else fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), baseline }, null, 2));
