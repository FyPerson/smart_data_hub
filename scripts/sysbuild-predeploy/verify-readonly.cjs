'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const Module = require('module');
const repo = path.resolve(__dirname, '../..');
const localRequire = Module.createRequire(path.join(repo, 'wbs-server/server.js'));
const testEnv = localRequire('./scripts/lib/test-env');
const { chromium } = localRequire('playwright');
const { listenOnSafePort } = localRequire('./scripts/lib/listen-safe-port');
const flags = process.argv.slice(2);
if (flags.length && !(flags.length === 1 && flags[0] === '--self-test') && !(flags.length === 2 && flags[0] === '--app-dir' && path.isAbsolute(flags[1]))) throw new Error('Only --self-test or absolute --app-dir is supported');
const appDir = flags[0] === '--app-dir' ? flags[1] : path.join(__dirname, 'temp-service');
const serviceModule = require(path.join(appDir, 'server.cjs'));
const S = require('./archive-fs.cjs');
const cli = require(fs.existsSync(path.join(appDir, 'cli.cjs')) ? path.join(appDir, 'cli.cjs') : './cli.cjs');
const archive = require('./archive-core.cjs');
const servicePackage = require(path.join(appDir, 'package.json'));
const serviceConfig = require(path.join(appDir, 'ecosystem.config.cjs'));
let out, dataDir, finished = false;
const snapshot = async () => Promise.all(S.walk(dataDir).map(async (r) => [r.rel, await S.hash(r.file)]));
async function request(base, method, route, body) {
    const res = await fetch(base + route, { method, headers: { Origin: base, 'X-Sysbuild-Request': '1', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const contentType = res.headers.get('content-type') || '';
    return { status: res.status, body: contentType.includes('application/json') ? await res.json() : await res.text() };
}
(async () => {
    await testEnv.ready();
    if (flags[0] === '--self-test') {
        try { process.exitCode = await require('./run-readonly-self-test.cjs').run({ childEnv: testEnv.childEnv(), appDir }); }
        catch (error) { process.exitCode = 1; throw error; }
        finally { await testEnv.teardown(); testEnv.finish(process.exitCode || 0); finished = true; }
        return;
    }
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-3002-readonly-')); dataDir = path.join(out, '中文工作区');
    const results = []; let service; let browser;
    const test = async (name, work) => { try { await work(); results.push({ name, passed: true }); console.log('  ✓ ' + name); } catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('  ✗ ' + name + ': ' + error.stack); } };
    try {
        // 建立私有夹具后再测显式0；变异不得因缺索引而在断言前终止整套。
        service = await serviceModule.createService({ appDir, dataDir, readOnly: false }); await service.close(); service = null;
        const initialReadOnly = process.env.SYSBUILD_READ_ONLY; process.env.SYSBUILD_READ_ONLY = '0';
        try { service = await serviceModule.createService({ appDir, dataDir }); }
        finally { if (initialReadOnly === undefined) delete process.env.SYSBUILD_READ_ONLY; else process.env.SYSBUILD_READ_ONLY = initialReadOnly; }
        await listenOnSafePort(service.server, '127.0.0.1'); let address = service.server.address(); let base = 'http://127.0.0.1:' + address.port;
        await test('普通模式仍可按修订保存，只读证明在开启前拒绝生成', async () => {
            assert.strictEqual((await request(base, 'GET', '/health')).body.readOnly, false);
            assert.strictEqual((await request(base, 'GET', '/api/archive-proof')).status, 409);
            const before = (await request(base, 'GET', '/api/workspace')).body;
            before.data.projects[0].goal = '只在私有演练中保存的目标';
            before.data.projects[0].isDemo = false; before.data.projects[0].systemName = '私有演练业务项目';
            const saved = await request(base, 'POST', '/api/workspace', { expectedRevision: before.manifest.revision, requestId: crypto.randomUUID(), data: before.data });
            assert.strictEqual(saved.status, 200); assert.notStrictEqual(saved.body.manifest.revision, before.manifest.revision);
        });
        await service.close(); service = null;
        await test('缺省与显式1均只读，包版本和健康版本一致且PM2固化只读', async () => {
            assert.strictEqual(servicePackage.version, serviceModule.VERSION); assert.strictEqual(serviceModule.VERSION, archive.READ_ONLY_SERVICE_VERSION);
            const configured = serviceConfig.apps.find((app) => app.name === 'sysbuild-pm-temp');
            assert.ok(configured); assert.strictEqual(configured.env.SYSBUILD_READ_ONLY, '1'); assert.strictEqual(configured.env.PORT, '3002');
            const previous = process.env.SYSBUILD_READ_ONLY; const before = await snapshot();
            try {
                for (const setting of [undefined, '1']) {
                    if (setting === undefined) delete process.env.SYSBUILD_READ_ONLY; else process.env.SYSBUILD_READ_ONLY = setting;
                    service = await serviceModule.createService({ appDir, dataDir }); await listenOnSafePort(service.server, '127.0.0.1');
                    const readonlyBase = 'http://127.0.0.1:' + service.server.address().port;
                    const health = (await request(readonlyBase, 'GET', '/health')).body;
                    assert.strictEqual(health.readOnly, true); assert.strictEqual(health.version, servicePackage.version);
                    assert.strictEqual((await request(readonlyBase, 'POST', '/api/workspace', '{')).status, 403);
                    await assert.rejects(() => service.store.save({}), { status: 403 });
                    await service.close(); service = null;
                }
                assert.deepStrictEqual(await snapshot(), before);
            } finally {
                if (service) { await service.close(); service = null; }
                if (previous === undefined) delete process.env.SYSBUILD_READ_ONLY; else process.env.SYSBUILD_READ_ONLY = previous;
            }
        });
        const index = S.json(path.join(dataDir, '工作区索引.json')); const ref = index.projects[0]; const deletionId = crypto.randomUUID();
        const receiptDir = path.join(dataDir, '删除备份', deletionId); fs.mkdirSync(receiptDir, { recursive: true });
        fs.writeFileSync(path.join(receiptDir, '删除记录.json'), JSON.stringify({ status: 'prepared', workspaceId: index.workspaceId, deletionId, projectId: ref.id, sourceFolder: ref.folder, backupFolder: '删除备份/' + deletionId + '/项目文件' }));
        const beforeReadOnly = await snapshot();
        service = await serviceModule.createService({ appDir, dataDir, readOnly: true }); await listenOnSafePort(service.server, '127.0.0.1'); address = service.server.address(); base = 'http://127.0.0.1:' + address.port;
        await test('只读启动和读取不恢复删除、不改索引或回执', async () => {
            assert.strictEqual((await request(base, 'GET', '/health')).body.readOnly, true);
            const workspace = (await request(base, 'GET', '/api/workspace')).body;
            assert.strictEqual(workspace.readOnly, true); assert.strictEqual(workspace.data.projects[0].systemName, '私有演练业务项目'); assert.strictEqual(workspace.data.projects[0].isDemo, false);
            const proof = await request(base, 'GET', '/api/archive-proof'); assert.strictEqual(proof.status, 200);
            assert.deepStrictEqual(Object.keys(proof.body).sort(), ['capturedAt', 'dataDir', 'port', 'readOnly', 'revision', 'serviceVersion', 'workspaceId']);
            assert.strictEqual(proof.body.revision, index.revision); assert.strictEqual(proof.body.readOnly, true);
            assert.strictEqual(proof.body.dataDir, fs.realpathSync(dataDir)); assert.strictEqual(proof.body.port, address.port); assert.strictEqual(proof.body.serviceVersion, servicePackage.version);
            assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('所有非读取方法及上传替换删除入口均在解析或保存前403', async () => {
            for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) for (const route of ['/api/workspace', '/api/projects/delete', '/api/attachments/upload', '/api/attachments/replace', '/api/attachments/delete', '/api/unknown']) {
                const denied = await request(base, method, route, '{'); assert.strictEqual(denied.status, 403, method + ' ' + route); assert.match(denied.body.message, /已切换到平台，只读/);
            }
            await assert.rejects(() => service.store.save({}), { status: 403 }); await assert.rejects(() => service.store.deleteProject({}), { status: 403 });
            assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('真实只读证明经CLI捕获后可生成并核验最终存档', async () => {
            const proofFile = path.join(out, '只读核对.json');
            const captureArgs = ['capture-proof', '--base-url', base, '--expected-port', String(address.port), '--expected-version', archive.READ_ONLY_SERVICE_VERSION];
            const proof = await cli.main([...captureArgs, '--report', proofFile]);
            assert.strictEqual(proof.readOnly, true); assert.deepStrictEqual(S.json(proofFile), proof);
            assert.ok(!fs.readFileSync(proofFile, 'utf8').includes('projects'));
            const exported = await cli.main(['archive', '--source', dataDir, '--out', path.join(out, '最终存档'), '--phase', 'final', '--read-only-proof', proofFile, '--service-port', String(address.port)]);
            assert.strictEqual(exported.manifest.revision, index.revision);
            assert.strictEqual(exported.manifest.sourceDataDir, fs.realpathSync(dataDir)); assert.strictEqual(exported.manifest.servicePort, address.port);
            assert.strictEqual((await archive.verifyArchive({ directory: exported.directory })).verified, true);
            await assert.rejects(() => cli.main([...captureArgs, '--report', proofFile]), { code: 'REPORT_EXISTS' });
            assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('取证拒绝URL或响应错端口、错版本、旧证明及缺省预期参数', async () => {
            const wrongPort = address.port === 65535 ? 65534 : address.port + 1;
            const target = path.join(out, '不应生成的证明.json');
            const args = ['capture-proof', '--base-url', base, '--expected-port', String(address.port), '--expected-version', archive.READ_ONLY_SERVICE_VERSION, '--report', target];
            assert.throws(() => cli.parse(['capture-proof', '--base-url', base, '--report', target]), { code: 'MISSING_ARGUMENT' });
            assert.throws(() => cli.parse(['archive', '--source', dataDir, '--out', path.join(out, '缺少端口'), '--phase', 'final', '--read-only-proof', target]), { code: 'MISSING_ARGUMENT' });
            await assert.rejects(() => cli.main(args.map((value, i) => i === 4 ? String(wrongPort) : value)), { code: 'PROOF_URL_PORT_MISMATCH' });
            await assert.rejects(() => cli.main(args.map((value, i) => i === 6 ? '0.8.0-readonly.1' : value)), { code: 'PROOF_SERVICE_MISMATCH' });
            await assert.rejects(() => cli.main(args.map((value, i) => i === 4 ? '0' : value)), { code: 'INVALID_PORT' });
            const proof = (await request(base, 'GET', '/api/archive-proof')).body; const originalFetch = global.fetch;
            try {
                for (const forged of [{ ...proof, port: wrongPort }, { ...proof, serviceVersion: '0.8.0-readonly.1' }]) {
                    global.fetch = async () => ({ ok: true, json: async () => forged });
                    await assert.rejects(() => cli.main(args), { code: 'PROOF_SERVICE_MISMATCH' });
                }
                global.fetch = async () => ({ ok: true, json: async () => ({ ...proof, serviceVersion: '0.8.0-readonly.1' }) });
                await assert.rejects(() => cli.main(args.map((value, i) => i === 6 ? '0.8.0-readonly.1' : value)), { code: 'PROOF_SERVICE_MISMATCH' });
                for (const field of ['dataDir', 'port', 'serviceVersion']) {
                    const legacy = { ...proof }; delete legacy[field];
                    global.fetch = async () => ({ ok: true, json: async () => legacy });
                    await assert.rejects(() => cli.main(args), { code: 'INVALID_PROOF' });
                }
            } finally { global.fetch = originalFetch; }
            assert.strictEqual(fs.existsSync(target), false); assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('同目录同修订的另一只读端口不能冒充待切换服务', async () => {
            const other = await serviceModule.createService({ appDir, dataDir, readOnly: true });
            try {
                await listenOnSafePort(other.server, '127.0.0.1'); const otherPort = other.server.address().port;
                assert.notStrictEqual(otherPort, address.port);
                const proof = await cli.main(['capture-proof', '--base-url', 'http://127.0.0.1:' + otherPort, '--expected-port', String(otherPort), '--expected-version', archive.READ_ONLY_SERVICE_VERSION, '--report', path.join(out, '另一端口证明.json')]);
                assert.strictEqual(proof.workspaceId, index.workspaceId); assert.strictEqual(proof.revision, index.revision);
                await assert.rejects(() => archive.exportArchive({ sourceDir: dataDir, outputDir: path.join(out, '另一端口不应存档'), phase: 'final', readOnlyProof: proof, servicePort: address.port }), { code: 'READ_ONLY_PROOF_PORT_MISMATCH' });
            } finally { await other.close(); }
            assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('只读页面展示切换提示、隐藏新建，并保留查看与重新读取', async () => {
            browser = await chromium.launch(fs.existsSync(chromium.executablePath()) ? { headless: true } : { headless: true, channel: 'chrome' });
            const page = await browser.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
            await page.goto(base, { waitUntil: 'networkidle' });
            await page.locator('#serverReadOnlyBanner').waitFor();
            assert.ok((await page.locator('#main').innerText()).includes('私有演练业务项目'), '读取已有工作区，不用静态虚拟种子替换实际记录');
            assert.match(await page.locator('#serverReadOnlyBanner').textContent(), /已切换到平台，只读/);
            assert.strictEqual(await page.locator('body').getAttribute('data-readonly'), 'true'); assert.strictEqual(await page.locator('#newProject').isVisible(), false);
            await page.getByRole('button', { name: '重新读取服务器记录', exact: true }).waitFor();
            assert.ok((await page.locator('#saveState').textContent()).includes('只读')); assert.deepStrictEqual(errors, []);
            const posts = []; page.on('request', (req) => { if (req.method() === 'POST') posts.push(req.url()); });
            const denied = await page.evaluate(async () => { try { await remoteCall('POST', {}); return false; } catch (error) { return error.message.includes('只读'); } });
            assert.strictEqual(denied, true); assert.deepStrictEqual(posts, [], '客户端先拒绝旧保存动作，不发送写请求');
            await page.screenshot({ path: path.join(out, 'readonly-page.png'), fullPage: true });
            await browser.close(); browser = null;
            assert.deepStrictEqual(await snapshot(), beforeReadOnly);
        });
        await test('只读不初始化不存在的数据目录，不接受非布尔配置', async () => {
            const empty = path.join(out, '不应创建的新目录');
            await assert.rejects(() => serviceModule.createService({ appDir, dataDir: empty, readOnly: true })); assert.strictEqual(fs.existsSync(empty), false);
            await assert.rejects(() => serviceModule.createService({ appDir, dataDir: empty, readOnly: 'false' }), /must be 0 or 1/);
            const previous = process.env.SYSBUILD_READ_ONLY;
            try { for (const invalid of ['true', 'false', '', '2', ' 0', '0 ']) { process.env.SYSBUILD_READ_ONLY = invalid; await assert.rejects(() => serviceModule.createService({ appDir, dataDir: empty }), /must be 0 or 1/); } }
            finally { if (previous === undefined) delete process.env.SYSBUILD_READ_ONLY; else process.env.SYSBUILD_READ_ONLY = previous; }
        });
        const passed = results.filter((r) => r.passed).length;
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'private service + private data + ephemeral loopback port', passed, total: results.length, results }, null, 2));
        console.log('只读准备演练 ' + passed + '/' + results.length + '；证据 ' + out); process.exitCode = passed === results.length ? 0 : 1;
    } catch (error) { process.exitCode = 1; throw error; }
    finally { if (browser) await browser.close(); if (service) await service.close(); await testEnv.teardown(); testEnv.finish(process.exitCode || 0); finished = true; }
})().catch((error) => { console.error(error.stack); if (!finished) process.exitCode = 1; });
