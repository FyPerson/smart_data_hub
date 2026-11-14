'use strict';
// Explicit C9 maintenance toolkit. Normal application startup never invokes a migration.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const VERSION = 6;
const LEDGER = 'sysbuild_schema_migrations';
const KNOWN = Object.freeze([
    { version: 1, commit: '204bb3e6', digest: 'f38f94bc8bb9c6b82105b5b2fe87b64580c4a1c22df9bc287b8fe53ee681b598' },
    { version: 2, commit: '2822af79', digest: '95537c016da55079608085e942c866bd4da4caeea63dd34656f4f2d421ef0980' },
    { version: 3, commit: '5a988b8c', digest: 'e25f10b47025e8184f9903c5e5c4f99de079ade904734fea623d68785a55f7de' },
    { version: 4, commit: '66831372', digest: '1ab09f7baf3da294d4e6d859015579037987fde747b1c85db37e36bedab37731' },
    { version: 5, commit: '1c590228', digest: 'ee74d8f6bfd8bd494738b117c149ce2b810a6f3b729f3bf87d9982e348f8cd6a' },
    { version: 6, commit: '8bbc6e78', digest: 'b354be11ba53a480dbbf73a587ad351dbc3b3e37506550e46c019ae0610f47e7' },
]);
const { LEDGER_SQL } = require(path.resolve(__dirname, '../../wbs-server/routes/sysbuild/migration-schema.js'));
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function plainPath(value, directory) {
    if (typeof value !== 'string' || !value || !path.isAbsolute(value)) throw failure('EXPLICIT_ABSOLUTE_PATH_REQUIRED', '须显式指定绝对路径');
    const absolute = path.resolve(value);
    const parsed = path.parse(absolute);
    let current = parsed.root;
    for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
        if (process.platform === 'win32' && (/[. ]$/.test(part) || part.includes(':'))) throw failure('UNSAFE_PATH', '路径含 Win32 别名或数据流');
        current = path.join(current, part);
        if (fs.lstatSync(current).isSymbolicLink()) throw failure('LINK_PATH', '迁移路径不能经过链接或 junction');
    }
    const stat = fs.lstatSync(absolute);
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) throw failure('UNSAFE_PATH', '须使用独立普通文件或目录');
    return absolute;
}
function noJournal(dbFile) {
    for (const suffix of ['-wal', '-shm', '-journal']) if (fs.existsSync(dbFile + suffix)) throw failure('DATABASE_NOT_OFFLINE', '存在 SQLite 日志旁文件，须先在维护窗口正常关闭服务');
    const header = Buffer.alloc(20); const fd = fs.openSync(dbFile, 'r'); let read;
    try { read = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
    if (read !== 20 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0') throw failure('INVALID_SQLITE_HEADER', '数据库文件头无效');
    // A closed WAL database can have no side files; merely opening it for reads can recreate them.
    if (header[18] !== 1 || header[19] !== 1) throw failure('DATABASE_NOT_OFFLINE', '数据库仍采用 WAL 或未知格式，请在维护窗口正常切回回滚日志模式');
}
function identifier(name) {
    if (!/^sysbuild_[a-z0-9_]+$/.test(name)) throw failure('UNKNOWN_IDENTIFIER', '发现未登记的结构名称');
    return '"' + name + '"';
}
function createMigrator({ sqlite3, schemaObjects, normalizeSql, materialReader }) {
    if (!materialReader || typeof materialReader.selectedMaterials !== 'function' || typeof materialReader.assertMaterialFreezes !== 'function') throw failure('COMPATIBILITY_READER_REQUIRED', '须使用本版本的材料引用与冻结读取助手');
    const hash = (objects) => crypto.createHash('sha256').update(JSON.stringify(objects.map((o) => ({ name: o.name, type: o.type, sql: normalizeSql(o.sql) })).sort((a, b) => a.name.localeCompare(b.name, 'en')))).digest('hex');
    if (hash(schemaObjects) !== KNOWN[VERSION - 1].digest) throw failure('UNREGISTERED_TARGET', '目标结构已变化，须先登记新的结构版本和迁移规则');
    const open = (file, writable) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(file, writable ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, (err) => err ? reject(err) : resolve(db));
    });
    const all = (db, sql, values) => new Promise((resolve, reject) => db.all(sql, values || [], (err, rows) => err ? reject(err) : resolve(rows)));
    const run = (db, sql, values) => new Promise((resolve, reject) => db.run(sql, values || [], function (err) { return err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID }); }));
    const close = (db) => new Promise((resolve, reject) => db.close((err) => err ? reject(err) : resolve()));
    const dataVersion = async (db) => (await all(db, 'PRAGMA data_version'))[0].data_version;
    async function compatibilityOf(db) {
        const versions = await all(db, 'SELECT v.id, v.status, v.snapshot_json, p.project_id FROM sysbuild_package_versions v JOIN sysbuild_packages p ON p.id = v.package_id ORDER BY v.id');
        const read = (sql, values) => {
            if (!/^\s*SELECT\b/i.test(sql)) throw failure('READ_ONLY_QUERY_REQUIRED', '兼容检查只接受SELECT');
            return all(db, sql, values);
        };
        const q = Object.freeze({ all: read, get: async (sql, values) => (await read(sql, values))[0] });
        const issues = [];
        for (const version of versions) {
            try {
                await materialReader.selectedMaterials(q, version.project_id, version.snapshot_json, { usable: false });
                if (version.status !== 'draft') await materialReader.assertMaterialFreezes(q, version.project_id, version);
            } catch (error) { issues.push({ packageVersionId: version.id, code: error.code || 'SNAPSHOT_COMPATIBILITY_FAILED', field: error.field || null }); }
        }
        return { checkedVersions: versions.length, issues };
    }
    async function inspectOn(db) {
        const integrity = await all(db, 'PRAGMA integrity_check');
        if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') throw failure('INTEGRITY_FAILED', 'SQLite 完整性检查未通过');
        const rows = await all(db, "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'");
        const ledger = rows.find((r) => r.name === LEDGER);
        if (ledger && (ledger.type !== 'table' || normalizeSql(ledger.sql) !== normalizeSql(LEDGER_SQL))) throw failure('LEDGER_SCHEMA_MISMATCH', '版本账本自身的结构不符');
        const owned = rows.filter((r) => r.name !== LEDGER && (r.tbl_name.startsWith('sysbuild_') || /\bsysbuild_[a-z0-9_]+\b/i.test(r.sql)));
        const digest = hash(owned);
        const known = owned.length ? KNOWN.find((r) => r.digest === digest) : { version: 0 };
        const tables = owned.filter((o) => o.type === 'table').map((o) => o.name).sort();
        const counts = {};
        for (const name of tables) counts[name] = (await all(db, 'SELECT COUNT(*) AS n FROM ' + identifier(name)))[0].n;
        const blocked = [];
        if (!known) blocked.push('UNKNOWN_SCHEMA');
        const totalRows = Object.values(counts).reduce((sum, n) => sum + n, 0);
        if (known && known.version > 0 && known.version < VERSION && totalRows > 0) blocked.push('NONEMPTY_LEGACY_REQUIRES_MAPPING');
        const records = ledger ? await all(db, 'SELECT id, from_version, to_version, contract_sha256, backup_sha256, applied_at FROM sysbuild_schema_migrations ORDER BY id') : [];
        let previous;
        for (const record of records) {
            const target = KNOWN.find((r) => r.version === record.to_version);
            if (!target || record.to_version <= record.from_version || (!previous && record.from_version !== 0) || (previous && record.from_version !== previous.to_version) || record.contract_sha256 !== target.digest || !/^[a-f0-9]{64}$/.test(record.backup_sha256)) throw failure('LEDGER_CHAIN_MISMATCH', '版本账本的迁移链不完整');
            previous = record;
        }
        if (records.length && (!known || previous.to_version !== known.version)) blocked.push('LEDGER_VERSION_MISMATCH');
        if (!owned.length && ledger) blocked.push('LEDGER_WITHOUT_BUSINESS_SCHEMA');
        const compatibility = known && known.version === VERSION && !blocked.length ? await compatibilityOf(db) : { checkedVersions: 0, issues: [] };
        if (compatibility.issues.length) blocked.push('C8_SNAPSHOT_COMPATIBILITY');
        const action = blocked.length ? 'blocked' : known.version === VERSION ? records.length ? 'none' : 'register_current' : known.version === 0 ? 'initialize' : 'rebuild_empty_legacy';
        return { sourceVersion: known ? known.version : null, targetVersion: VERSION, digest, action, blocked, counts, totalRows, objects: owned.length, tables, ledger: records, compatibility };
    }
    async function inspect({ dbPath }) {
        const file = plainPath(dbPath, false); noJournal(file);
        const db = await open(file, false);
        try { await run(db, 'PRAGMA query_only = ON'); await run(db, 'BEGIN'); const report = await inspectOn(db); await run(db, 'ROLLBACK'); return report; }
        finally { await close(db); }
    }
    async function apply({ dbPath, backupDir, expectedVersion, maintenanceConfirmed }) {
        if (maintenanceConfirmed !== true) throw failure('MAINTENANCE_CONFIRMATION_REQUIRED', '仅在已停服的维护窗口显式执行迁移');
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > VERSION) throw failure('EXPECTED_VERSION_REQUIRED', '须显式指定预期来源版本');
        const file = plainPath(dbPath, false); const backupRoot = plainPath(backupDir, true); noJournal(file);
        const db = await open(file, true);
        let transaction = false;
        let backup;
        let applied = false, outcome = 'not_started', primaryError = null;
        try {
            await run(db, 'PRAGMA busy_timeout = 5000');
            const before = await inspectOn(db);
            if (before.blocked.length) throw failure('MIGRATION_BLOCKED', before.blocked.join(', '));
            if (before.sourceVersion !== expectedVersion) throw failure('SOURCE_VERSION_MISMATCH', '来源结构版本与显式预期不符');
            if (before.action === 'none') return { applied: false, report: before };
            const version = await dataVersion(db);
            const dir = fs.mkdtempSync(path.join(backupRoot, 'sysbuild-migrate-'));
            const backupPath = path.join(dir, 'before.sqlite');
            backup = { path: backupPath, verified: false };
            await run(db, 'VACUUM INTO ?', [backupPath]);
            const backupDb = await open(backupPath, false);
            try {
                const copied = await inspectOn(backupDb);
                if (copied.blocked.length || copied.digest !== before.digest || JSON.stringify(copied.counts) !== JSON.stringify(before.counts)) throw failure('BACKUP_VALIDATION_MISMATCH', '备份结构、数量或兼容检查与来源不符，本次不迁移');
            } finally { await close(backupDb); }
            const backupSha = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
            backup = { path: backupPath, sha256: backupSha, verified: true };
            await run(db, 'BEGIN EXCLUSIVE'); transaction = true; outcome = 'in_transaction';
            const locked = await inspectOn(db);
            if (await dataVersion(db) !== version || JSON.stringify(locked) !== JSON.stringify(before)) throw failure('SOURCE_CHANGED_AFTER_BACKUP', '备份期间来源发生变化，本次不迁移');
            if (before.action === 'rebuild_empty_legacy') {
                if (locked.totalRows !== 0) throw failure('NONEMPTY_LEGACY', '旧结构已有业务记录，不允许空库重建');
                for (const name of before.tables) await run(db, 'DROP TABLE ' + identifier(name));
            }
            if (before.action === 'initialize' || before.action === 'rebuild_empty_legacy') for (const object of schemaObjects) await run(db, object.sql);
            await run(db, LEDGER_SQL);
            const recordedVersion = before.ledger.length ? before.ledger[before.ledger.length - 1].to_version : 0;
            await run(db, 'INSERT INTO sysbuild_schema_migrations (from_version, to_version, contract_sha256, backup_sha256) VALUES (?, ?, ?, ?)', [recordedVersion, VERSION, KNOWN[VERSION - 1].digest, backupSha]);
            const after = await inspectOn(db);
            if (after.action !== 'none' || after.digest !== KNOWN[VERSION - 1].digest) throw failure('POST_MIGRATION_CONTRACT_FAILED', '迁移后的结构与版本账本核对失败');
            await run(db, 'COMMIT'); transaction = false; applied = true; outcome = 'committed';
            const receipt = { applied: true, at: new Date().toISOString(), sourceVersion: before.sourceVersion, targetVersion: VERSION, contractSha256: after.digest, backup, businessCountsBefore: before.counts, businessCountsAfter: after.counts, compatibility: after.compatibility };
            try { fs.writeFileSync(path.join(dir, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' }); }
            catch (_) { throw Object.assign(failure('APPLIED_RECEIPT_WRITE_FAILED', '迁移已提交，但回执文件写入失败；须按版本账本与备份核对，不得按未迁移处理'), { applied: true }); }
            return receipt;
        } catch (error) {
            if (transaction) {
                try { await run(db, 'ROLLBACK'); transaction = false; applied = false; outcome = 'rolled_back'; }
                catch (rollback) {
                    applied = null; outcome = 'unknown';
                    primaryError = Object.assign(failure('ROLLBACK_FAILED', '迁移失败且回滚未确认，须保留备份并核对实际状态'), { applied, outcome, backup });
                    throw primaryError;
                }
            }
            error.applied = applied; error.outcome = outcome;
            if (backup) error.backup = backup;
            primaryError = error;
            throw error;
        } finally {
            try { await close(db); }
            catch (error) {
                if (primaryError) primaryError.closeError = error.code || 'CONNECTION_CLOSE_FAILED';
                else throw Object.assign(failure('CONNECTION_CLOSE_FAILED', '数据库连接关闭未确认，请按账本和回执核对'), { applied, outcome, backup });
            }
        }
    }
    return { inspect, apply };
}
module.exports = { createMigrator, KNOWN, VERSION, LEDGER_SQL };
