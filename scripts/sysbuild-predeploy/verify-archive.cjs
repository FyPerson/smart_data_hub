'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const flags = process.argv.slice(2);
if (flags.length && !(flags.length === 2 && flags[0] === '--candidate' && path.isAbsolute(flags[1]))) throw new Error('Only an absolute --candidate path is accepted');
const A = require(flags.length ? flags[1] : './archive-core.cjs');
const S = require('./archive-fs.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-archive-'));
let serial = 0;
const write = (base, rel, value) => { const file = path.join(base, ...rel.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value, null, 2) : value); return file; };
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
    const dir = fs.mkdtempSync(path.join(root, '中文源-' + (++serial) + '-'));
    const folder = '项目/客户平台__p1'; const deleted = '删除备份/d1/项目文件';
    function snapshot(base, projectId, revision, fileName, bytes, originalName) {
        const att = { id: 'a-' + revision, filePath: '附件/' + fileName, size: Buffer.byteLength(bytes), sha256: sha(bytes), originalName, createdAt: '2020-01-02T03:04:05.000Z' };
        write(dir, base + '/' + att.filePath, bytes);
        const pkg = { format: 'sysbuild-project', schemaVersion: 4, projectId, revision, project: { id: projectId, systemName: projectId === 'p1' ? '客户服务平台' : '已删除项目', goal: '不要存档这段项目过程正文-SENTINEL', milestones: [{ key: 'G0', name: '立项', checks: [{ id: 'c1', name: '立项原件', content: '不要存档这段材料正文-SENTINEL', attachments: [att] }] }] } };
        write(dir, base + '/版本记录/' + revision + '.json', pkg); return pkg;
    }
    snapshot(folder, 'p1', 'old-revision', '历史原件.bin', '旧版本原始内容', '旧原名.bin');
    const current = snapshot(folder, 'p1', 'current-revision', '当前原件.bin', '当前版本原始内容', '=需要保留原名.bin');
    write(dir, folder + '/project.json', current);
    const gone = snapshot(deleted, 'p2', 'deleted-revision', '删除前原件.bin', '删除备份原始内容', '已删除项目原名.bin');
    write(dir, deleted + '/project.json', gone); write(dir, '删除备份/d1/删除记录.json', { status: 'prepared', projectId: 'p2' });
    write(dir, folder + '/附件/未引用原件.bin', '保留未被当前记录引用的原件');
    const index = { format: 'sysbuild-workspace', schemaVersion: 4, workspaceId: 'w1', revision: 'workspace-after-delete', projects: [{ id: 'p1', folder, snapshot: '版本记录/current-revision.json' }] };
    write(dir, '工作区索引.json', index);
    // 本套件只测离线文件合约；真实临时监听端口的取证/存档闭环由verify-readonly覆盖。
    const servicePort = 43000 + serial;
    return { dir, folder, current, index, output: path.join(root, '存档-' + serial), servicePort, proof: { readOnly: true, workspaceId: index.workspaceId, revision: index.revision, capturedAt: new Date().toISOString(), dataDir: fs.realpathSync(dir), port: servicePort, serviceVersion: A.READ_ONLY_SERVICE_VERSION } };
}
async function sourceFingerprint(dir) { return Promise.all(S.walk(dir).map(async (r) => [r.rel, await S.hash(r.file)])); }
(async () => {
    const results = [];
    const test = async (name, body) => { try { await body(); results.push({ name, passed: true }); console.log('  ✓ ' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('  ✗ ' + name + ': ' + error.stack); } };
    await test('中文路径全部物理原件、来源元数据、CSV安全与不复制业务正文', async () => {
        const f = fixture(); const before = await sourceFingerprint(f.dir);
        const result = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' });
        assert.strictEqual(result.manifest.fileCount, 4); assert.deepStrictEqual(result.manifest.files.map((r) => r.state).sort(), ['current', 'deleted_backup', 'historical', 'unreferenced']);
        const current = result.manifest.files.find((r) => r.state === 'current');
        assert.strictEqual(current.associations.find((r) => r.current).project, '客户服务平台');
        assert.strictEqual(current.associations.find((r) => r.current).uploadedAt, '2020-01-02T03:04:05.000Z');
        assert.strictEqual(current.associations.find((r) => r.current).originalName, '=需要保留原名.bin');
        assert.ok(fs.readFileSync(path.join(f.output, '附件清单.csv'), 'utf8').includes("'=需要保留原名.bin"));
        assert.ok(!JSON.stringify(result.manifest).includes('SENTINEL'));
        assert.deepStrictEqual(await sourceFingerprint(f.dir), before, '导出不修改、恢复或删除源记录');
        assert.strictEqual((await A.verifyArchive({ directory: f.output })).verified, true);
    });
    await test('最终清单要求同工作区、同修订的当天只读核对记录', async () => {
        const f = fixture();
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort }), { code: 'READ_ONLY_PROOF_REQUIRED' });
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort, readOnlyProof: { ...f.proof, revision: '旧修订' } }), { code: 'READ_ONLY_PROOF_REQUIRED' });
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort, readOnlyProof: { ...f.proof, capturedAt: '2000-01-01T00:00:00.000Z' } }), { code: 'READ_ONLY_PROOF_STALE' });
        const result = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort, readOnlyProof: f.proof });
        assert.strictEqual(result.manifest.phase, 'final'); assert.strictEqual((await A.verifyArchive({ directory: f.output })).phase, 'final');
    });
    await test('最终存档拒绝同工作区修订的错目录错端口错版本和旧缺字段证明', async () => {
        const f = fixture(); const other = fixture();
        const run = (proof, port = f.servicePort) => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', readOnlyProof: proof, servicePort: port });
        assert.strictEqual(other.index.workspaceId, f.index.workspaceId); assert.strictEqual(other.index.revision, f.index.revision);
        const before = await sourceFingerprint(f.dir);
        await assert.rejects(() => run({ ...f.proof, dataDir: other.proof.dataDir }), { code: 'READ_ONLY_PROOF_DATA_DIR_MISMATCH' });
        await assert.rejects(() => run({ ...f.proof, port: f.servicePort + 1 }), { code: 'READ_ONLY_PROOF_PORT_MISMATCH' });
        await assert.rejects(() => run({ ...f.proof, serviceVersion: '0.8.0-readonly.1' }), { code: 'READ_ONLY_PROOF_VERSION_MISMATCH' });
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', readOnlyProof: f.proof }), { code: 'SERVICE_PORT_REQUIRED' });
        for (const field of ['dataDir', 'port', 'serviceVersion']) {
            const legacy = { ...f.proof }; delete legacy[field];
            await assert.rejects(() => run(legacy), { code: 'READ_ONLY_PROOF_REQUIRED' });
        }
        assert.strictEqual(fs.existsSync(f.output), false); assert.deepStrictEqual(await sourceFingerprint(f.dir), before);
        const result = await run({ ...f.proof, dataDir: path.join(f.dir, '..', path.basename(f.dir)) });
        assert.strictEqual(result.manifest.sourceDataDir, fs.realpathSync(f.dir)); assert.strictEqual(result.manifest.readOnlyProof.dataDir, fs.realpathSync(f.dir)); assert.strictEqual(result.manifest.servicePort, f.servicePort);
        assert.strictEqual((await A.verifyArchive({ directory: f.output })).verified, true);
    });
    await test('长期核验仍拒绝旧缺字段证明及清单目录端口版本不一致', async () => {
        const f = fixture(); const result = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort, readOnlyProof: f.proof });
        const invalid = [];
        for (const field of ['dataDir', 'port', 'serviceVersion']) { const proof = { ...result.manifest.readOnlyProof }; delete proof[field]; invalid.push({ ...result.manifest, readOnlyProof: proof }); }
        invalid.push({ ...result.manifest, sourceDataDir: root }, { ...result.manifest, servicePort: f.servicePort + 1 }, { ...result.manifest, readOnlyProof: { ...f.proof, serviceVersion: '0.8.0-readonly.1' } });
        for (const manifest of invalid) { write(f.output, 'manifest.json', manifest); await assert.rejects(() => A.verifyArchive({ directory: f.output }), { code: 'INVALID_ARCHIVE_MANIFEST' }); }
        write(f.output, 'manifest.json', result.manifest); assert.strictEqual((await A.verifyArchive({ directory: f.output })).verified, true);
    });
    await test('只读证明按北京时间日界拒绝昨日和未来，旧最终存档仍可长期核验', async () => {
        const f = fixture(); const originalNow = Date.now;
        try {
            Date.now = () => Date.parse('2026-11-10T00:01:00+08:00');
            const exportWith = (capturedAt) => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'final', servicePort: f.servicePort, readOnlyProof: { ...f.proof, capturedAt } });
            await assert.rejects(() => exportWith('2026-11-09T23:59:00+08:00'), { code: 'READ_ONLY_PROOF_STALE' });
            await assert.rejects(() => exportWith('2026-11-10T00:02:00+08:00'), { code: 'READ_ONLY_PROOF_STALE' });
            await exportWith('2026-11-10T00:00:00+08:00');
            Date.now = () => Date.parse('2026-11-12T12:00:00+08:00');
            assert.strictEqual((await A.verifyArchive({ directory: f.output })).verified, true);
        } finally { Date.now = originalNow; }
    });
    await test('镜像落后时仍按索引提交快照标记当前引用，并明确报告镜像落后', async () => {
        const f = fixture(); write(f.dir, f.folder + '/project.json', S.json(path.join(f.dir, ...f.folder.split('/'), '版本记录', 'old-revision.json')));
        const result = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' });
        assert.deepStrictEqual(result.manifest.mirrorStates, [{ projectId: 'p1', state: 'stale' }]);
        assert.ok(result.manifest.files.find((r) => r.rel.endsWith('/当前原件.bin')).associations.some((a) => a.current));
    });
    await test('原件hash不符即拒绝，不生成完整清单', async () => {
        const f = fixture(); const file = f.folder + '/版本记录/current-revision.json';
        f.current.project.milestones[0].checks[0].attachments[0].sha256 = '0'.repeat(64); write(f.dir, file, f.current); write(f.dir, f.folder + '/project.json', f.current);
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' }), { code: 'ATTACHMENT_HASH_MISMATCH' });
        assert.strictEqual(fs.existsSync(f.output), false);
    });
    await test('源目录之外输出、拒绝覆盖和跨目录引用', async () => {
        const f = fixture();
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: path.join(f.dir, '不能写入源目录'), phase: 'prearchive' }), { code: 'OUTPUT_IN_SOURCE' });
        await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' });
        const before = await sourceFingerprint(f.output);
        await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' }), { code: 'OUTPUT_EXISTS' });
        assert.deepStrictEqual(await sourceFingerprint(f.output), before);
        f.index.projects[0].folder = '../其他项目'; write(f.dir, '工作区索引.json', f.index);
        await assert.rejects(() => A.collect(f.dir), { code: 'INVALID_PROJECT_REFERENCE' });
    });
    await test('源目录junction与hardlink均拒绝读取', async () => {
        const f = fixture(); const outside = fs.mkdtempSync(path.join(root, '外部-')); write(outside, '原件.bin', '不应沿链接读取');
        const link = path.join(f.dir, '外部目录链接'); fs.symlinkSync(outside, link, 'junction');
        await assert.rejects(() => A.collect(f.dir), { code: 'LINK_PATH' }); fs.rmdirSync(link);
        fs.linkSync(path.join(outside, '原件.bin'), path.join(f.dir, '原件别名.bin'));
        await assert.rejects(() => A.collect(f.dir), { code: 'UNSAFE_FILE_TYPE' });
    });
    await test('复制期间源索引变化只保留partial，不发布最终目录', async () => {
        const f = fixture(); const original = fs.copyFileSync; let changed = false;
        fs.copyFileSync = function () { const result = original.apply(this, arguments); if (!changed) { changed = true; f.index.revision = '并发保存的新修订'; write(f.dir, '工作区索引.json', f.index); } return result; };
        try { await assert.rejects(() => A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' }), { code: 'SOURCE_CHANGED' }); }
        finally { fs.copyFileSync = original; }
        assert.strictEqual(changed, true); assert.strictEqual(fs.existsSync(f.output), false);
    });
    await test('按清单核验拒绝额外文件、缺失文件与等长篡改', async () => {
        const f = fixture(); const result = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' });
        const extra = write(f.output, 'files/额外文件.bin', '多出的内容');
        await assert.rejects(() => A.verifyArchive({ directory: f.output }), { code: 'ARCHIVE_FILE_SET_MISMATCH' }); fs.unlinkSync(extra);
        const first = result.manifest.files[0]; const file = path.join(f.output, ...first.archiveRel.split('/')); const bytes = fs.readFileSync(file);
        fs.writeFileSync(file, Buffer.alloc(bytes.length, 65));
        await assert.rejects(() => A.verifyArchive({ directory: f.output }), { code: 'ARCHIVE_HASH_MISMATCH' }); fs.unlinkSync(file);
        await assert.rejects(() => A.verifyArchive({ directory: f.output }), { code: 'ARCHIVE_FILE_SET_MISMATCH' });
    });
    await test('最终清单差异精确区分新增、变化、移除与无需补拉', async () => {
        const f = fixture(); const transient = write(f.dir, f.folder + '/附件/待删除游离.bin', '预存档时存在');
        const before = await A.exportArchive({ sourceDir: f.dir, outputDir: f.output, phase: 'prearchive' });
        write(f.dir, f.folder + '/附件/未引用原件.bin', '最终发生变化的游离原件'); write(f.dir, f.folder + '/附件/新增游离.bin', '新增原件'); fs.unlinkSync(transient);
        f.index.revision = '最终工作区修订'; write(f.dir, '工作区索引.json', f.index);
        const finalDir = f.output + '-最终'; const proof = { ...f.proof, revision: f.index.revision, capturedAt: new Date().toISOString() };
        await A.exportArchive({ sourceDir: f.dir, outputDir: finalDir, phase: 'final', servicePort: f.servicePort, readOnlyProof: proof });
        const diff = A.compareManifests({ beforeFile: path.join(before.directory, 'manifest.json'), afterFile: path.join(finalDir, 'manifest.json') });
        assert.deepStrictEqual(diff.added, [f.folder + '/附件/新增游离.bin']); assert.deepStrictEqual(diff.changed, [f.folder + '/附件/未引用原件.bin']); assert.deepStrictEqual(diff.removed, [f.folder + '/附件/待删除游离.bin']); assert.strictEqual(diff.unchanged.length, 3); assert.strictEqual(diff.fetch.length, 2);
        assert.strictEqual((await A.verifyArchive({ directory: finalDir })).files, 5);
    });
    const passed = results.filter((r) => r.passed).length;
    fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'private filesystem fixtures, no database or network', passed, total: results.length, results }, null, 2));
    console.log('存档准备演练 ' + passed + '/' + results.length + '；证据 ' + root); process.exitCode = passed === results.length ? 0 : 1;
})().catch((error) => { console.error(error.stack); process.exitCode = 1; });
