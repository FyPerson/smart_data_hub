'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const Module = require('module');
const root = path.resolve(__dirname, '../..');
const fromServer = Module.createRequire(path.join(root, 'wbs-server/server.js'));
const sqlite3 = fromServer('sqlite3');
const schema = fromServer('./routes/sysbuild/schema');
const normalizeSql = fromServer('./routes/sysbuild/db').normalizeSchemaSql;
const materialReader = fromServer('./routes/sysbuild/materials-core');
const testEnv = fromServer('./scripts/lib/test-env');
const flags = process.argv.slice(2);
if (flags.length && (flags.length !== 2 || !['--candidate', '--candidate-cli', '--candidate-step'].includes(flags[0]) || !path.isAbsolute(flags[1]))) throw new Error('Only an absolute candidate path is accepted');
let cli;
if (flags[0] === '--candidate-cli') {
    const filename = path.join(__dirname, 'cli.cjs'); const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
    loaded._compile(fs.readFileSync(flags[1], 'utf8'), filename); cli = loaded.exports;
} else cli = require('./cli.cjs');
let core;
if (flags[0] === '--candidate') {
    // Resolve the module-owned ledger definition exactly as the real toolkit does.
    const filename = path.join(__dirname, 'schema-migration-core.cjs'); const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
    loaded._compile(fs.readFileSync(flags[1], 'utf8'), filename); core = loaded.exports;
} else core = require('./schema-migration-core.cjs');
let prestart;
if (flags[0] === '--candidate-step') {
    const filename = path.join(__dirname, 'deploy-prestart.cjs'); const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
    loaded._compile(fs.readFileSync(flags[1], 'utf8'), filename); prestart = loaded.exports;
} else prestart = require('./deploy-prestart.cjs');
const migrator = core.createMigrator({ sqlite3, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader });
const connect = (file) => new Promise((resolve, reject) => { const db = new sqlite3.Database(file, (error) => error ? reject(error) : resolve(db)); });
const run = (db, statement, values) => new Promise((resolve, reject) => db.run(statement, values || [], (error) => error ? reject(error) : resolve()));
const all = (db, statement, values) => new Promise((resolve, reject) => db.all(statement, values || [], (error, rows) => error ? reject(error) : resolve(rows)));
const close = (db) => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const history = new Map();
const historyFixture = require('./fixtures/schema-v1-v6.json');
function schemaAt(commit) {
    if (!history.has(commit)) {
        assert.strictEqual(historyFixture.format, 'sysbuild-schema-history-fixture'); assert.strictEqual(historyFixture.schemaVersion, 1);
        assert.strictEqual(historyFixture.versions.length, core.KNOWN.length);
        const known=core.KNOWN.find(v=>v.commit===commit), entry=historyFixture.versions.find(v=>v.knownCommit===commit);
        assert.ok(known && entry && entry.version===known.version && /^[a-f0-9]{40}$/.test(entry.commit) && entry.commit.startsWith(commit), '完整历史来源必须匹配登记版本');
        assert.match(entry.schemaBlobSha1, /^[a-f0-9]{40}$/); assert.match(entry.schemaSourceSha256, /^[a-f0-9]{64}$/);
        const objects=entry.objectRefs.map(i=>{assert.ok(Number.isSafeInteger(i) && i>=0 && i<historyFixture.objects.length); return Object.freeze({...historyFixture.objects[i]});});
        assert.strictEqual(new Set(objects.map(o=>o.name)).size, objects.length);
        const actual=crypto.createHash('sha256').update(JSON.stringify(objects.map(o=>({name:o.name,type:o.type,sql:normalizeSql(o.sql)})).sort((a,b)=>a.name.localeCompare(b.name,'en')))).digest('hex');
        assert.strictEqual(actual, known.digest, '历史夹具必须保持原始完整合约，不能回落当前结构'); assert.strictEqual(entry.digest, known.digest);
        assert.strictEqual(objects.length, entry.objectCount); assert.strictEqual(objects.filter(o=>o.type==='table').length, entry.tableCount);
        history.set(commit, Object.freeze(objects));
    }
    return history.get(commit);
}
async function query(file, statement, values) { const db = await connect(file); try { return await all(db, statement, values); } finally { await close(db); } }
async function packageFixture(snapshot, status) {
    const f = await fixture(schema.SCHEMA_OBJECTS, true); const state = status || 'draft';
    const db = await connect(f.file);
    try {
        await run(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, display_name TEXT)');
        await run(db, "INSERT INTO users VALUES (1, 'private-test-user', '私有演练用户')");
        await run(db, "INSERT INTO sysbuild_nodes (project_id, name, sort_order) VALUES (1, '兼容材料节点', 10)");
        await run(db, "INSERT INTO sysbuild_materials (node_id, material_key, name) VALUES (1, 'compatibility', '兼容材料')");
        await run(db, "INSERT INTO sysbuild_material_versions (material_id, version_no, body, created_by) VALUES (1, 1, '只用于私有演练', 1)");
        await run(db, "INSERT INTO sysbuild_packages (project_id, type, created_by) VALUES (1, 'initiation', 1)");
        await run(db, 'INSERT INTO sysbuild_package_versions (package_id, version_no, status, effective_at, snapshot_json, created_by) VALUES (1, 1, ?, ?, ?, 1)', [state, state === 'effective' ? '2020-01-02 00:00:00' : null, JSON.stringify(snapshot)]);
    } finally { await close(db); }
    return f;
}
let out, finished = false;
let serial = 0;
async function fixture(objects, populated) {
    const dir = fs.mkdtempSync(path.join(out, '中文演练-' + (++serial) + '-'));
    const file = path.join(dir, '隔离库.sqlite');
    const db = await connect(file);
    try {
        await run(db, "CREATE TABLE platform_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        await run(db, "INSERT INTO platform_sentinel VALUES (1, '平台既有数据必须保留')");
        for (const object of objects) await run(db, object.sql);
        if (populated) await run(db, "INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, created_by) VALUES ('已有业务项目', 'inhouse', 1, 1)");
    } finally { await close(db); }
    return { file, dir, apply: { dbPath: file, backupDir: dir, maintenanceConfirmed: true } };
}
function faultDriver(onRun) {
    return { ...sqlite3, Database: function (file, flags, callback) {
        const db = new sqlite3.Database(file, flags, callback); const original = db.run;
        db.run = function (statement, params, done) { return onRun({ db, original, file, statement, params, done }) || original.call(db, statement, params, done); };
        return db;
    } };
}
(async () => {
    await testEnv.ready();
    const results = [];
    try {
        out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-migration-'));
        const test = async (name, body) => {
            try { await body(); results.push({ name, passed: true }); console.log('  ✓ ' + name); }
            catch (error) { results.push({ name, passed: false, error: error.stack }); console.error('  ✗ ' + name + ': ' + error.stack); }
        };
        for (const version of core.KNOWN) await test('V' + version.version + ' 历史指纹、空结构升级、备份、幂等和平台表保留', async () => {
            const f = await fixture(schemaAt(version.commit));
            const hashBefore = digest(f.file);
            const before = await migrator.inspect({ dbPath: f.file });
            assert.strictEqual(before.sourceVersion, version.version); assert.strictEqual(before.digest, version.digest);
            assert.strictEqual(digest(f.file), hashBefore, '只读检查不改源文件');
            const receipt = await migrator.apply({ ...f.apply, expectedVersion: version.version });
            assert.strictEqual(receipt.applied, true); assert.strictEqual(receipt.contractSha256, core.KNOWN[5].digest);
            assert.strictEqual(digest(receipt.backup.path), receipt.backup.sha256);
            assert.strictEqual((await migrator.inspect({ dbPath: receipt.backup.path })).sourceVersion, version.version);
            const after = await migrator.inspect({ dbPath: f.file });
            assert.strictEqual(after.sourceVersion, 6); assert.strictEqual(after.tables.length, 42); assert.strictEqual(after.objects, 109); assert.strictEqual(after.action, 'none');
            assert.deepStrictEqual(await query(f.file, 'SELECT * FROM platform_sentinel'), [{ id: 1, value: '平台既有数据必须保留' }]);
            const stable = digest(f.file);
            assert.strictEqual((await migrator.apply({ ...f.apply, expectedVersion: 6 })).applied, false);
            assert.strictEqual(digest(f.file), stable, '第二次执行不写入也不追加账本');
        });
        await test('尚无模块结构的库初始化 V6，保留其他模块数据', async () => {
            const f = await fixture([]); assert.strictEqual((await migrator.inspect({ dbPath: f.file })).sourceVersion, 0);
            await migrator.apply({ ...f.apply, expectedVersion: 0 });
            assert.strictEqual((await migrator.inspect({ dbPath: f.file })).sourceVersion, 6);
            assert.strictEqual((await query(f.file, 'SELECT COUNT(*) AS n FROM platform_sentinel'))[0].n, 1);
        });
        await test('当前结构只登记版本，已有业务行逐字保留', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS, true);
            const before = await query(f.file, 'SELECT * FROM sysbuild_projects');
            const result = await migrator.apply({ ...f.apply, expectedVersion: 6 });
            assert.strictEqual(result.businessCountsBefore.sysbuild_projects, 1);
            assert.deepStrictEqual(await query(f.file, 'SELECT * FROM sysbuild_projects'), before);
        });
        await test('非空旧结构拒绝推断转换，不产生备份或改动', async () => {
            const f = await fixture(schemaAt(core.KNOWN[0].commit), true);
            const before = digest(f.file);
            const report = await migrator.inspect({ dbPath: f.file });
            assert.deepStrictEqual(report.blocked, ['NONEMPTY_LEGACY_REQUIRES_MAPPING']);
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 1 }), (error) => {
                assert.strictEqual(error.code, 'MIGRATION_BLOCKED'); assert.strictEqual(error.applied, false); assert.strictEqual(error.outcome, 'not_started'); return true;
            });
            assert.strictEqual(digest(f.file), before); assert.deepStrictEqual(fs.readdirSync(f.dir), ['隔离库.sqlite']);
        });
        await test('未知结构 / 额外触发器拒绝，不放宽旧结构识别', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await query(f.file, 'CREATE TRIGGER surprise AFTER INSERT ON sysbuild_projects BEGIN SELECT 1; END');
            const before = digest(f.file);
            assert.deepStrictEqual((await migrator.inspect({ dbPath: f.file })).blocked, ['UNKNOWN_SCHEMA']);
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 6 }), { code: 'MIGRATION_BLOCKED' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('错误预期版本、未确认维护和相对路径都在写入前拒绝', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); const before = digest(f.file);
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 1 }), (error) => {
                assert.strictEqual(error.code, 'SOURCE_VERSION_MISMATCH'); assert.strictEqual(error.applied, false); assert.strictEqual(error.outcome, 'not_started'); return true;
            });
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 6, maintenanceConfirmed: false }), { code: 'MAINTENANCE_CONFIRMATION_REQUIRED' });
            await assert.rejects(() => migrator.inspect({ dbPath: 'task_pool.db' }), { code: 'EXPLICIT_ABSOLUTE_PATH_REQUIRED' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('SQLite 日志旁文件、hardlink 与 junction 路径拒绝', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            const journal = f.file + '-journal'; fs.writeFileSync(journal, '未确认正常关闭的日志', { flag: 'wx' });
            await assert.rejects(() => migrator.inspect({ dbPath: f.file }), { code: 'DATABASE_NOT_OFFLINE' }); fs.unlinkSync(journal);
            const alias = path.join(f.dir, '别名.sqlite'); fs.linkSync(f.file, alias);
            await assert.rejects(() => migrator.inspect({ dbPath: alias }), { code: 'UNSAFE_PATH' }); fs.unlinkSync(alias);
            const link = path.join(out, '目录链接-' + serial); fs.symlinkSync(f.dir, link, 'junction');
            await assert.rejects(() => migrator.inspect({ dbPath: path.join(link, '隔离库.sqlite') }), { code: 'LINK_PATH' });
        });
        await test('版本账本定义不符拒绝，现有结构不被重写', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await query(f.file, 'CREATE TABLE sysbuild_schema_migrations (id INTEGER PRIMARY KEY)');
            const before = digest(f.file);
            await assert.rejects(() => migrator.inspect({ dbPath: f.file }), { code: 'LEDGER_SCHEMA_MISMATCH' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('已关闭且没有旁文件的 WAL 库在 SQLite 打开前拒绝，读取不生成旁文件', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await query(f.file, 'PRAGMA journal_mode = WAL');
            const before = fs.readdirSync(f.dir); const checksum = digest(f.file);
            assert.deepStrictEqual(before, ['隔离库.sqlite']);
            await assert.rejects(() => migrator.inspect({ dbPath: f.file }), { code: 'DATABASE_NOT_OFFLINE' });
            assert.deepStrictEqual(fs.readdirSync(f.dir), before); assert.strictEqual(digest(f.file), checksum);
        });
        await test('账本声称旧版而实际是新版时拒绝，不以账本代替实际合约', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await migrator.apply({ ...f.apply, expectedVersion: 6 });
            await query(f.file, 'UPDATE sysbuild_schema_migrations SET to_version = 5, contract_sha256 = ?', [core.KNOWN[4].digest]);
            assert.deepStrictEqual((await migrator.inspect({ dbPath: f.file })).blocked, ['LEDGER_VERSION_MISMATCH']);
            const before = digest(f.file);
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 6 }), { code: 'MIGRATION_BLOCKED' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('迁移链断裂时拒绝，即使最后一条伪称当前版本', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await migrator.apply({ ...f.apply, expectedVersion: 6 });
            await query(f.file, 'INSERT INTO sysbuild_schema_migrations (from_version, to_version, contract_sha256, backup_sha256) VALUES (1, 6, ?, ?)', [core.KNOWN[5].digest, '0'.repeat(64)]);
            const before = digest(f.file);
            await assert.rejects(() => migrator.inspect({ dbPath: f.file }), { code: 'LEDGER_CHAIN_MISMATCH' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('账本首条必须从未登记版本0起步，不能缺少迁移链起点', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS);
            await migrator.apply({ ...f.apply, expectedVersion: 6 });
            await query(f.file, 'UPDATE sysbuild_schema_migrations SET from_version = 1');
            const before = digest(f.file);
            await assert.rejects(() => migrator.inspect({ dbPath: f.file }), { code: 'LEDGER_CHAIN_MISMATCH' });
            assert.strictEqual(digest(f.file), before);
        });
        await test('备份与独占事务之间的平台写入被检出，拒绝用过时备份迁移', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); let injected = false;
            const driver = faultDriver(({ db, original, file, statement, params, done }) => {
                if (injected || statement !== 'VACUUM INTO ?') return false;
                injected = true;
                return original.call(db, statement, params, function (error) {
                    const context = this;
                    if (error) return done.call(context, error);
                    query(file, "UPDATE platform_sentinel SET value = '备份后的并发写入'").then(() => done.call(context, null), (e) => done.call(context, e));
                });
            });
            const probe = core.createMigrator({ sqlite3: driver, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader });
            await assert.rejects(() => probe.apply({ ...f.apply, expectedVersion: 6 }), { code: 'SOURCE_CHANGED_AFTER_BACKUP' });
            assert.strictEqual(injected, true); assert.strictEqual((await migrator.inspect({ dbPath: f.file })).ledger.length, 0);
            assert.strictEqual((await query(f.file, 'SELECT value FROM platform_sentinel'))[0].value, '备份后的并发写入');
        });
        await test('重建中途 DDL 失败整笔回滚，旧结构与平台数据均保留', async () => {
            const f = await fixture(schemaAt(core.KNOWN[0].commit)); const before = await migrator.inspect({ dbPath: f.file }); let dropped = false;
            const driver = faultDriver(({ db, statement, done }) => {
                if (statement.startsWith('DROP TABLE ')) { dropped = true; return false; }
                if (dropped && /^CREATE TABLE IF NOT EXISTS sysbuild_/.test(statement)) { queueMicrotask(() => done.call({}, new Error('演练：重建中途失败'))); return db; }
                return false;
            });
            const probe = core.createMigrator({ sqlite3: driver, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader });
            await assert.rejects(() => probe.apply({ ...f.apply, expectedVersion: 1 }), (error) => {
                assert.match(error.message, /演练：重建中途失败/); assert.strictEqual(error.applied, false); assert.strictEqual(error.outcome, 'rolled_back'); return true;
            });
            assert.strictEqual(dropped, true); assert.deepStrictEqual(await migrator.inspect({ dbPath: f.file }), before);
            assert.strictEqual((await query(f.file, 'SELECT value FROM platform_sentinel'))[0].value, '平台既有数据必须保留');
        });
        await test('CLI拒绝未知重复或缺失参数，报告已存在时先拒绝再迁移', async () => {
            assert.throws(() => cli.parse(['schema-inspect', '--db', 'x', '--db', 'y']), { code: 'INVALID_ARGUMENT' });
            assert.throws(() => cli.parse(['schema-inspect', '--unknown', 'x']), { code: 'INVALID_ARGUMENT' });
            assert.throws(() => cli.parse(['schema-apply', '--db', 'x']), { code: 'MISSING_ARGUMENT' });
            const f = await fixture(schema.SCHEMA_OBJECTS); const before = digest(f.file);
            await assert.rejects(() => cli.main(['schema-apply', '--db', f.file, '--backup-dir', f.dir, '--expected-version', '6', '--maintenance-confirmed', '--report', f.file]), { code: 'REPORT_EXISTS' });
            assert.strictEqual(digest(f.file), before); assert.deepStrictEqual(fs.readdirSync(f.dir), ['隔离库.sqlite']);
        });
        await test('CLI真实迁移已提交而外部报告失败时明确标记applied并保留备份', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); const report = path.join(f.dir, '模拟不可写报告.json');
            const original = fs.writeFileSync; let observed;
            fs.writeFileSync = function (file) { if (file === report) throw new Error('演练：外部报告写入失败'); return original.apply(this, arguments); };
            try { await cli.main(['schema-apply', '--db', f.file, '--backup-dir', f.dir, '--expected-version', '6', '--maintenance-confirmed', '--report', report]); }
            catch (error) { observed = error; }
            finally { fs.writeFileSync = original; }
            assert.ok(observed); assert.strictEqual(observed.applied, true); assert.ok(observed.backup && fs.existsSync(observed.backup.path));
            assert.strictEqual((await migrator.inspect({ dbPath: f.file })).sourceVersion, 6); assert.strictEqual((await migrator.inspect({ dbPath: f.file })).ledger.length, 1);
        });
        await test('C8旧快照预留字段不兼容时阻塞，原文不写进报告也不改写', async () => {
            const f = await packageFixture({ text: '私有正文-SENTINEL', material_version_ids: '旧系统自定义值-SENTINEL' });
            const before = digest(f.file); const report = await migrator.inspect({ dbPath: f.file });
            assert.deepStrictEqual(report.blocked, ['C8_SNAPSHOT_COMPATIBILITY']); assert.strictEqual(report.compatibility.checkedVersions, 1);
            assert.deepStrictEqual(report.compatibility.issues.map((r) => [r.packageVersionId, r.field]), [[1, 'material_version_ids']]);
            assert.ok(!JSON.stringify(report).includes('SENTINEL'));
            await assert.rejects(() => migrator.apply({ ...f.apply, expectedVersion: 6 }), { code: 'MIGRATION_BLOCKED' }); assert.strictEqual(digest(f.file), before);
        });
        await test('C8材料与内容包冻结检查同源，合法遮蔽历史保留，缺冻结阻塞', async () => {
            const f = await packageFixture({ material_version_ids: [1] });
            await query(f.file, "INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (1, 'sysbuild/1/private.txt', '私有原件.txt', 'text/plain', 3, ?, 0, 1)", ['a'.repeat(64)]);
            await query(f.file, "INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (1, 'material_version', 1, 1)");
            await query(f.file, "INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES ('material_version', 1, 1, ?)", ['a'.repeat(64)]);
            assert.deepStrictEqual((await migrator.inspect({ dbPath: f.file })).blocked, [], '草稿不预先要求包冻结');
            await query(f.file, "UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = 1");
            assert.deepStrictEqual((await migrator.inspect({ dbPath: f.file })).blocked, ['C8_SNAPSHOT_COMPATIBILITY']);
            await query(f.file, "INSERT INTO sysbuild_frozen_attachments (object_type, object_version_id, attachment_id, sha256) VALUES ('package_version', 1, 1, ?)", ['a'.repeat(64)]);
            await query(f.file, "UPDATE sysbuild_attachments SET masked_at = '2020-01-03 10:00:00', masked_by = 1, mask_reason = '私有演练遮蔽' WHERE id = 1");
            const report = await migrator.inspect({ dbPath: f.file }); assert.deepStrictEqual(report.blocked, []); assert.strictEqual(report.compatibility.checkedVersions, 1);
            const before = await query(f.file, 'SELECT snapshot_json FROM sysbuild_package_versions WHERE id = 1');
            const applied = await migrator.apply({ ...f.apply, expectedVersion: 6 }); assert.strictEqual(applied.compatibility.checkedVersions, 1);
            assert.deepStrictEqual(await query(f.file, 'SELECT snapshot_json FROM sysbuild_package_versions WHERE id = 1'), before);
        });
        await test('兼容读取助手在读写迁移连接上也不能执行写SQL', async () => {
            const f = await packageFixture({}); const before = digest(f.file);
            const badReader = { selectedMaterials: async (q) => q.all("UPDATE platform_sentinel SET value = '不得写入'"), assertMaterialFreezes: async () => [] };
            const probe = core.createMigrator({ sqlite3, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader: badReader });
            await assert.rejects(() => probe.apply({ ...f.apply, expectedVersion: 6 }), { code: 'MIGRATION_BLOCKED' }); assert.strictEqual(digest(f.file), before);
            assert.strictEqual((await probe.inspect({ dbPath: f.file })).compatibility.issues[0].code, 'READ_ONLY_QUERY_REQUIRED');
        });
        await test('备份检出未知结构时先阻塞，来源不迁移，备份明确标未验证', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); const before = digest(f.file); let injected = false;
            const driver = faultDriver(({ db, original, statement, params, done }) => {
                if (injected || statement !== 'VACUUM INTO ?') return false; injected = true;
                return original.call(db, statement, params, function (error) {
                    const context = this; if (error) return done.call(context, error);
                    query(params[0], 'CREATE TRIGGER unexpected_backup AFTER INSERT ON sysbuild_projects BEGIN SELECT 1; END').then(() => done.call(context, null), (e) => done.call(context, e));
                });
            });
            const probe = core.createMigrator({ sqlite3: driver, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader }); let observed;
            try { await probe.apply({ ...f.apply, expectedVersion: 6 }); } catch (error) { observed = error; }
            assert.strictEqual(observed && observed.code, 'BACKUP_VALIDATION_MISMATCH'); assert.strictEqual(observed.backup.verified, false); assert.strictEqual(digest(f.file), before);
        });
        await test('提交确认丢失且回滚不明时报告unknown，实际账本可核对，备份保留', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); let injected = false;
            const driver = faultDriver(({ db, original, statement, params, done }) => {
                if (statement !== 'COMMIT' || injected) return false; injected = true;
                return original.call(db, statement, params, function (error) { done.call(this, error || new Error('演练：提交已执行但确认丢失')); });
            });
            const probe = core.createMigrator({ sqlite3: driver, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader }); let observed;
            try { await probe.apply({ ...f.apply, expectedVersion: 6 }); } catch (error) { observed = error; }
            assert.strictEqual(observed && observed.code, 'ROLLBACK_FAILED'); assert.strictEqual(observed.applied, null); assert.strictEqual(observed.outcome, 'unknown');
            assert.strictEqual(observed.backup.verified, true); assert.ok(fs.existsSync(observed.backup.path));
            assert.strictEqual((await migrator.inspect({ dbPath: f.file })).ledger.length, 1, '实际已提交，不能误称未执行');
        });
        await test('提交后关闭失败仍报告committed，不把已提交迁移当未执行', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); let committed = false;
            const driver = faultDriver(({ statement }) => { if (statement === 'COMMIT') committed = true; return false; });
            const WrappedDatabase = driver.Database;
            driver.Database = function (file, flags, callback) {
                const db = new WrappedDatabase(file, flags, callback); const original = db.close;
                db.close = function (done) { return original.call(db, (error) => done(error || (file === f.file && committed ? new Error('演练：关闭确认失败') : null))); };
                return db;
            };
            const probe = core.createMigrator({ sqlite3: driver, schemaObjects: schema.SCHEMA_OBJECTS, normalizeSql, materialReader }); let observed;
            try { await probe.apply({ ...f.apply, expectedVersion: 6 }); } catch (error) { observed = error; }
            assert.strictEqual(observed && observed.code, 'CONNECTION_CLOSE_FAILED'); assert.strictEqual(observed.applied, true); assert.strictEqual(observed.outcome, 'committed');
            assert.strictEqual(observed.backup.verified, true); assert.strictEqual((await migrator.inspect({ dbPath: f.file })).ledger.length, 1);
        });
        await test('部署前步骤：显式来源迁移、回执hash、复核和幂等noop', async () => {
            const f = await fixture(schemaAt(core.KNOWN[0].commit)); const reportPath = path.join(f.dir, 'prestart-first.json');
            const first = await prestart.execute({ dbPath: f.file, backupDir: f.dir, fromVersion: 1, toVersion: 6, reportPath, maintenanceConfirmed: true });
            assert.strictEqual(first.fromVersion, 1); assert.strictEqual(first.toVersion, 6); assert.strictEqual(first.applied, true); assert.strictEqual(first.outcome, 'committed'); assert.strictEqual(first.reportSha256, digest(reportPath));
            const before = digest(f.file);
            const second = await prestart.execute({ dbPath: f.file, backupDir: f.dir, fromVersion: 6, toVersion: 6, reportPath: path.join(f.dir, 'prestart-second.json'), maintenanceConfirmed: true });
            assert.strictEqual(second.applied, false); assert.strictEqual(second.outcome, 'noop'); assert.strictEqual(second.backup, null); assert.strictEqual(digest(f.file), before);
        });
        await test('部署前步骤：未批准目标或维护状态在任何迁移前拒绝', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); const before = digest(f.file); const options = { dbPath: f.file, backupDir: f.dir, fromVersion: 6, toVersion: 6, reportPath: path.join(f.dir, 'prestart.json'), maintenanceConfirmed: true };
            let observed;
            try { await prestart.execute({ ...options, toVersion: 7 }); } catch (error) { observed = error; }
            assert.strictEqual(observed && observed.code, 'UNSUPPORTED_MIGRATION_SCOPE'); assert.strictEqual(observed.applied, false); assert.strictEqual(observed.outcome, 'not_started'); assert.strictEqual(digest(f.file), before);
            await assert.rejects(() => prestart.execute({ ...options, maintenanceConfirmed: false }), { code: 'UNSUPPORTED_MIGRATION_SCOPE' }); assert.strictEqual(digest(f.file), before);
            assert.throws(() => prestart.parse([]), { code: 'MISSING_ARGUMENT' });
        });
        await test('部署前步骤：迁移后复核失败不出成功回执，明确已提交状态', async () => {
            const f = await fixture(schema.SCHEMA_OBJECTS); const baseCore = require('./schema-migration-core.cjs'); const factory = baseCore.createMigrator; let observed;
            baseCore.createMigrator = function (dependencies) { const actual = factory(dependencies); return { apply: actual.apply, inspect: async (options) => ({ ...await actual.inspect(options), action: 'blocked', blocked: ['PRIVATE_POSTCHECK_FAULT'] }) }; };
            const reportPath = path.join(f.dir, 'prestart-postcheck.json');
            try { await prestart.execute({ dbPath: f.file, backupDir: f.dir, fromVersion: 6, toVersion: 6, reportPath, maintenanceConfirmed: true }); }
            catch (error) { observed = error; }
            finally { baseCore.createMigrator = factory; }
            assert.strictEqual(observed && observed.code, 'POSTCHECK_FAILED'); assert.strictEqual(observed.applied, true); assert.strictEqual(observed.outcome, 'committed'); assert.strictEqual(fs.existsSync(reportPath), false);
            assert.strictEqual(prestart.failureRecord(observed, { fromVersion: 6, toVersion: 6, reportPath }).kind, 'SYSBUILD_MIGRATION_FAIL');
        });
        const passed = results.filter((r) => r.passed).length;
        fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'C9 draft / private SQLite fixtures only', passed, total: results.length, results }, null, 2));
        console.log('迁移准备演练 ' + passed + '/' + results.length + '；证据 ' + out);
        process.exitCode = passed === results.length ? 0 : 1;
    } catch (error) { process.exitCode = 1; throw error; }
    finally { await testEnv.teardown(); testEnv.finish(process.exitCode || 0); finished = true; }
})().catch((error) => { console.error(error.stack); if (!finished) process.exitCode = 1; });
