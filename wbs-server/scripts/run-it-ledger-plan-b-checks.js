'use strict';
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const suites = {
    ui: 'verify-it-ledger-plan-b-browser.js',
    rack: 'verify-it-ledger-c8-browser.js',
    manual: 'verify-it-ledger-manual-observation.js',
    multi: 'verify-it-ledger-photo-collections.js',
    batch: 'verify-it-ledger-photo-batch-feedback.js',
    sheets: 'verify-it-ledger-inspection-sheets.js',
    photos: 'verify-it-ledger-inspection-photos.js',
    collect: 'verify-it-ledger-inspection-collect.js',
    form: 'verify-it-ledger-inspection-sheet-form-browser.js',
    photoBrowser: 'verify-it-ledger-inspection-photo-browser.js',
    matrix: 'verify-it-ledger-matrix.js',
    e2e: 'verify-it-ledger-e2e.js',
    redesignList: 'verify-it-ledger-inspection-redesign-browser.js',
    redesignForm: 'verify-it-ledger-inspection-redesign-form-browser.js',
    redesignDetail: 'verify-it-ledger-inspection-redesign-detail-browser.js',
    panel: 'verify-it-ledger-panel-static.js',
    cache: 'verify-shared-css-cache-bust.js'
};
const selected = process.argv.slice(2), names = selected.length ? selected : Object.keys(suites);
const dir = path.resolve(__dirname, '../../_temp/plan-b-verification');
fs.mkdirSync(dir, { recursive: true });
const results = [];
for (const name of names) {
    if (!Object.hasOwn(suites, name)) throw Error('Unknown suite ' + name);
    const start = Date.now();
    const r = spawnSync(process.execPath, [path.join(__dirname, suites[name])], {
        cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true,
        timeout: name === 'e2e' ? 900000 : 300000, maxBuffer: 32 * 1024 * 1024
    });
    const stdout = String(r.stdout || ''), out = stdout + String(r.stderr || '');
    const log = path.join(dir, name + '.log');
    fs.writeFileSync(log, out);
    const cacheResult = name === 'cache' && stdout.match(/=== PASS：(\d+) 项通过 \/ 0 项失败 ===/);
    const summary = [...stdout.matchAll(/^.*PASS=\d+ FAIL=\d+.*$/gm)].at(-1)?.[0]
        || (cacheResult ? 'CACHE PASS=' + cacheResult[1] + ' FAIL=0' : '');
    const ok = r.status === 0 && !r.error && !r.signal && /PASS=[1-9]\d* FAIL=0/.test(summary);
    const result = { name, script: suites[name], status: r.status, ok, summary, seconds: Math.round((Date.now() - start) / 1000), log };
    results.push(result);
    fs.writeFileSync(path.join(dir, name + '-result.json'), JSON.stringify(result, null, 2));
    console.log((ok ? 'PASS ' : 'FAIL ') + name + ' ' + summary + ' exit=' + r.status);
    if (!ok) console.log(out.slice(-2200));
}
let previous = {};
const file = path.join(dir, 'checks.json');
try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* First run has no aggregate. */ }
for (const result of results) previous[result.name] = result;
fs.writeFileSync(file, JSON.stringify(previous, null, 2));
console.log('REPORT=' + file);
if (results.some(r => !r.ok)) process.exitCode = 1;
