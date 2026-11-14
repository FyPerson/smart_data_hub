'use strict';
// C9 offline preparation only. No service module, network request, or source write is used.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./archive-fs.cjs');
const FORMAT = 'sysbuild-attachment-archive';
// 离线存档只使用已审版本标识，不加载或执行临时服务模块。
const READ_ONLY_SERVICE_VERSION = '0.8.0-readonly.2';
const SUPPORTED = [2, 3, 4];
const shaBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function readJson(root, rel, fingerprints) {
    const file = S.child(root, rel); if (fs.statSync(file).size > 64 * 1024 * 1024) throw S.fail('JSON_TOO_LARGE', '索引或快照超过读取上限');
    const bytes = fs.readFileSync(file); const sha = shaBytes(bytes);
    if (fingerprints.has(rel) && fingerprints.get(rel) !== sha) throw S.fail('SOURCE_CHANGED', '导出读取期间索引或快照发生变化');
    fingerprints.set(rel, sha); return JSON.parse(bytes.toString('utf8'));
}
function csvCell(value) {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
}
function validSnapshot(pkg) {
    if (!pkg || pkg.format !== 'sysbuild-project' || !SUPPORTED.includes(pkg.schemaVersion) || !pkg.project || pkg.projectId !== pkg.project.id || typeof pkg.projectId !== 'string' || typeof pkg.revision !== 'string' || !Array.isArray(pkg.project.milestones)) throw S.fail('INVALID_SNAPSHOT', '项目快照格式无效');
    return pkg;
}
async function collect(sourceDir) {
    const root = S.existing(sourceDir, 'directory');
    const inventory = S.walk(root); const byRel = new Map(inventory.map((r) => [r.rel, r]));
    const fingerprints = new Map(); const manifest = readJson(root, '工作区索引.json', fingerprints);
    if (!manifest || manifest.format !== 'sysbuild-workspace' || !SUPPORTED.includes(manifest.schemaVersion) || typeof manifest.workspaceId !== 'string' || typeof manifest.revision !== 'string' || !Array.isArray(manifest.projects)) throw S.fail('INVALID_INDEX', '工作区索引格式无效');
    const currentSnapshots = new Set(); const projectIds = new Set(); const projectFolders = new Set(); const mirrors = [];
    for (const ref of manifest.projects) {
        if (!ref || typeof ref.id !== 'string' || projectIds.has(ref.id) || typeof ref.folder !== 'string' || !/^项目\/[^/]+$/.test(ref.folder) || projectFolders.has(ref.folder) || typeof ref.snapshot !== 'string' || !/^版本记录\/[^/]+\.json$/.test(ref.snapshot)) throw S.fail('INVALID_PROJECT_REFERENCE', '工作区项目引用无效或重复');
        S.relative(ref.folder); S.relative(ref.snapshot); projectIds.add(ref.id); projectFolders.add(ref.folder);
        const rel = ref.folder + '/' + ref.snapshot; const pkg = validSnapshot(readJson(root, rel, fingerprints));
        if (pkg.projectId !== ref.id) throw S.fail('SNAPSHOT_PROJECT_MISMATCH', '索引项目与提交快照不一致');
        currentSnapshots.add(rel);
        const mirrorRel = ref.folder + '/project.json';
        if (!byRel.has(mirrorRel)) mirrors.push({ projectId: ref.id, state: 'missing' });
        else { const mirror = validSnapshot(readJson(root, mirrorRel, fingerprints)); mirrors.push({ projectId: ref.id, state: mirror.projectId === ref.id && mirror.revision === pkg.revision ? 'matches' : 'stale' }); }
    }
    const files = inventory.filter((r) => r.rel.split('/').includes('附件')).map((r) => ({ rel: r.rel, size: r.size, associations: [] }));
    const attachments = new Map(files.map((r) => [r.rel, r])); const folderOwners = new Map();
    const snapshots = inventory.filter((r) => /^(?:项目\/[^/]+|删除备份\/[^/]+\/项目文件)\/(?:版本记录\/[^/]+\.json|project\.json)$/.test(r.rel));
    for (const row of snapshots) {
        const pkg = validSnapshot(readJson(root, row.rel, fingerprints));
        const at = row.rel.lastIndexOf('/版本记录/'); const folder = at >= 0 ? row.rel.slice(0, at) : path.posix.dirname(row.rel);
        if (folderOwners.has(folder) && folderOwners.get(folder) !== pkg.projectId) throw S.fail('FOLDER_PROJECT_COLLISION', '同一目录包含不同项目的快照'); folderOwners.set(folder, pkg.projectId);
        for (const stage of pkg.project.milestones) {
            if (!stage || !Array.isArray(stage.checks)) throw S.fail('INVALID_STAGE', '阶段材料清单格式无效');
            for (const material of stage.checks) {
                if (!material || !Array.isArray(material.attachments)) throw S.fail('INVALID_MATERIAL', '材料附件清单格式无效');
                for (const att of material.attachments) {
                    if (!att || typeof att.filePath !== 'string' || !att.filePath.startsWith('附件/') || !Number.isSafeInteger(att.size) || att.size < 0 || !/^[a-f0-9]{64}$/.test(att.sha256) || typeof att.originalName !== 'string') throw S.fail('INVALID_ATTACHMENT_REFERENCE', '附件引用缺少路径、大小、文件名或摘要');
                    S.relative(att.filePath); const file = attachments.get(folder + '/' + att.filePath);
                    if (!file || file.size !== att.size) throw S.fail('ATTACHMENT_MISSING_OR_SIZE', '附件原件缺失或大小不符');
                    if (file.expectedSha && file.expectedSha !== att.sha256) throw S.fail('ATTACHMENT_HASH_CONFLICT', '不同记录对同一附件的摘要不一致'); file.expectedSha = att.sha256;
                    const association = { projectId: pkg.projectId, project: pkg.project.systemName || '', stage: stage.key + ' · ' + stage.name, material: material.name || '', originalName: att.originalName, uploadedAt: att.createdAt || null, revision: pkg.revision, current: currentSnapshots.has(row.rel) };
                    const key = JSON.stringify(association);
                    if (!file.associations.some((a) => JSON.stringify(a) === key)) file.associations.push(association);
                }
            }
        }
    }
    for (const file of files) {
        file.sha256 = await S.hash(S.child(root, file.rel));
        if (file.expectedSha && file.sha256 !== file.expectedSha) throw S.fail('ATTACHMENT_HASH_MISMATCH', '附件原件与记录的 SHA-256 不符');
        delete file.expectedSha;
        file.state = file.rel.startsWith('删除备份/') ? 'deleted_backup' : file.associations.some((a) => a.current) ? 'current' : file.associations.length ? 'historical' : 'unreferenced';
    }
    return { root, inventory, manifest, files, mirrors, fingerprints };
}
function proofHasBinding(proof) {
    return !!proof && proof.readOnly === true && typeof proof.workspaceId === 'string' && typeof proof.revision === 'string' && typeof proof.capturedAt === 'string' && typeof proof.dataDir === 'string' && path.isAbsolute(proof.dataDir) && Number.isInteger(proof.port) && proof.port >= 1 && proof.port <= 65535 && typeof proof.serviceVersion === 'string';
}
function checkProof(proof, data, servicePort) {
    if (!proofHasBinding(proof) || proof.workspaceId !== data.manifest.workspaceId || proof.revision !== data.manifest.revision) throw S.fail('READ_ONLY_PROOF_REQUIRED', '最终清单须有绑定数据目录、端口、版本及当前工作区修订的只读核对记录');
    if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) throw S.fail('SERVICE_PORT_REQUIRED', '最终清单须显式指定实际待切换服务的监听端口');
    if (proof.port !== servicePort) throw S.fail('READ_ONLY_PROOF_PORT_MISMATCH', '只读核对记录的监听端口与待切换服务不符');
    if (proof.serviceVersion !== READ_ONLY_SERVICE_VERSION) throw S.fail('READ_ONLY_PROOF_VERSION_MISMATCH', '只读核对记录不是已审只读服务版本');
    const proofRoot = fs.realpathSync(S.existing(proof.dataDir, 'directory')); const sourceRoot = fs.realpathSync(data.root);
    if (proofRoot !== sourceRoot) throw S.fail('READ_ONLY_PROOF_DATA_DIR_MISMATCH', '只读核对记录的数据目录与存档源目录实路径不符');
    const at = Date.parse(proof.capturedAt); const now = Date.now();
    const sameChinaDay = Number.isFinite(at) && Math.floor((at + 8 * 3600000) / 86400000) === Math.floor((now + 8 * 3600000) / 86400000);
    if (!sameChinaDay || at > now) throw S.fail('READ_ONLY_PROOF_STALE', '只读核对记录须在当天获取且时间有效');
    return { ...proof, dataDir: proofRoot };
}
async function exportArchive({ sourceDir, outputDir, phase, readOnlyProof, servicePort }) {
    if (!['prearchive', 'final'].includes(phase)) throw S.fail('EXPLICIT_PHASE_REQUIRED', '须明确区分预存档和最终清单');
    if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw S.fail('ABSOLUTE_PATH_REQUIRED', '须显式指定存档绝对路径');
    const data = await collect(sourceDir); const target = path.resolve(outputDir);
    const parent = S.existing(path.dirname(target), 'directory'); S.part(path.basename(target));
    if (S.within(data.root, target)) throw S.fail('OUTPUT_IN_SOURCE', '存档目录必须在源数据目录之外');
    if (fs.existsSync(target)) throw S.fail('OUTPUT_EXISTS', '存档目录已存在，拒绝覆盖');
    let boundProof = readOnlyProof;
    if (phase === 'final') boundProof = checkProof(readOnlyProof, data, servicePort);
    const staging = fs.mkdtempSync(path.join(parent, path.basename(target) + '.partial-'));
    fs.mkdirSync(path.join(staging, 'files'));
    try {
        for (const file of data.files) {
            const destination = path.join(staging, 'files', ...file.rel.split('/'));
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.copyFileSync(S.child(data.root, file.rel), destination, fs.constants.COPYFILE_EXCL);
            if (fs.statSync(destination).size !== file.size || await S.hash(destination) !== file.sha256) throw S.fail('COPY_MISMATCH', '存档附件与读取的原件不一致');
        }
        const after = await collect(data.root);
        if (JSON.stringify([...data.fingerprints]) !== JSON.stringify([...after.fingerprints]) || JSON.stringify(data.files) !== JSON.stringify(after.files) || JSON.stringify(data.inventory.map((r) => [r.rel, r.size])) !== JSON.stringify(after.inventory.map((r) => [r.rel, r.size]))) throw S.fail('SOURCE_CHANGED', '导出期间源文件集合、索引或附件发生变化；本次不作为完整存档');
        const result = { format: FORMAT, schemaVersion: 1, phase, exportedAt: new Date().toISOString(), workspaceId: data.manifest.workspaceId, revision: data.manifest.revision, sourceDataDir: phase === 'final' ? fs.realpathSync(data.root) : null, servicePort: phase === 'final' ? servicePort : null, fileCount: data.files.length, totalBytes: data.files.reduce((n, r) => n + r.size, 0), mirrorStates: data.mirrors, sourceRecordHashes: Object.fromEntries(data.fingerprints), readOnlyProof: phase === 'final' ? boundProof : null, files: data.files.map((r) => ({ ...r, archiveRel: 'files/' + r.rel })) };
        const csv = [['项目', '阶段', '材料', '原文件名', '相对路径', '大小', '上传时间', 'SHA-256', '引用状态'], ...result.files.map((r) => {
            const values = (key) => [...new Set(r.associations.map((a) => a[key]).filter(Boolean))].join('；');
            return [values('project'), values('stage'), values('material'), values('originalName'), r.rel, r.size, values('uploadedAt'), r.sha256, r.state];
        })].map((row) => row.map(csvCell).join(',')).join('\r\n');
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
        fs.writeFileSync(path.join(staging, '附件清单.csv'), '\uFEFF' + csv + '\r\n', { flag: 'wx' });
        if (fs.existsSync(target)) throw S.fail('OUTPUT_EXISTS', '发布存档前目标已存在，拒绝覆盖');
        fs.renameSync(staging, target); return { directory: target, manifest: result };
    } catch (error) { error.partialDirectory = staging; throw error; }
}
function readArchiveManifest(file) {
    const manifest = S.json(S.existing(file, 'file'));
    if (!manifest || manifest.format !== FORMAT || manifest.schemaVersion !== 1 || !['prearchive', 'final'].includes(manifest.phase) || typeof manifest.workspaceId !== 'string' || typeof manifest.revision !== 'string' || !Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length) throw S.fail('INVALID_ARCHIVE_MANIFEST', '附件存档清单格式或数量无效');
    const keys = new Set();
    for (const row of manifest.files) {
        S.relative(row.rel); S.relative(row.archiveRel);
        const key = row.rel.normalize('NFC').toLowerCase();
        if (keys.has(key) || row.archiveRel !== 'files/' + row.rel || !Number.isSafeInteger(row.size) || row.size < 0 || !/^[a-f0-9]{64}$/.test(row.sha256) || !Array.isArray(row.associations)) throw S.fail('INVALID_ARCHIVE_MANIFEST', '清单附件路径、大小或摘要无效'); keys.add(key);
    }
    if (manifest.totalBytes !== manifest.files.reduce((n, row) => n + row.size, 0)) throw S.fail('INVALID_ARCHIVE_MANIFEST', '清单附件合计大小不一致');
    if (manifest.phase === 'final' && (!proofHasBinding(manifest.readOnlyProof) || manifest.readOnlyProof.workspaceId !== manifest.workspaceId || manifest.readOnlyProof.revision !== manifest.revision || manifest.readOnlyProof.dataDir !== manifest.sourceDataDir || manifest.readOnlyProof.port !== manifest.servicePort || manifest.readOnlyProof.serviceVersion !== READ_ONLY_SERVICE_VERSION)) throw S.fail('INVALID_ARCHIVE_MANIFEST', '最终清单缺少绑定相应数据目录、端口及已审版本的只读核对记录');
    return manifest;
}
async function verifyArchive({ directory, manifestFile }) {
    const root = S.existing(directory, 'directory');
    const manifest = readArchiveManifest(manifestFile || path.join(root, 'manifest.json'));
    const actual = S.walk(S.existing(path.join(root, 'files'), 'directory')).map((r) => 'files/' + r.rel).sort();
    const expected = manifest.files.map((r) => r.archiveRel).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw S.fail('ARCHIVE_FILE_SET_MISMATCH', '存档文件集合与清单不符，不能按完整存档验收');
    for (const row of manifest.files) {
        const file = S.child(root, row.archiveRel);
        if (fs.statSync(file).size !== row.size || await S.hash(file) !== row.sha256) throw S.fail('ARCHIVE_HASH_MISMATCH', '存档附件大小或 SHA-256 与清单不符');
    }
    return { verified: true, phase: manifest.phase, workspaceId: manifest.workspaceId, revision: manifest.revision, files: expected.length, totalBytes: manifest.totalBytes };
}
function compareManifests({ beforeFile, afterFile }) {
    const before = readArchiveManifest(beforeFile); const after = readArchiveManifest(afterFile);
    if (before.workspaceId !== after.workspaceId) throw S.fail('WORKSPACE_MISMATCH', '不能对不同工作区生成补拉清单');
    const old = new Map(before.files.map((r) => [r.rel, r])); const current = new Map(after.files.map((r) => [r.rel, r]));
    const added = []; const changed = []; const unchanged = []; const removed = [];
    for (const row of after.files) {
        const prior = old.get(row.rel);
        if (!prior) added.push(row.rel);
        else if (prior.size !== row.size || prior.sha256 !== row.sha256) changed.push(row.rel);
        else unchanged.push(row.rel);
    }
    for (const row of before.files) if (!current.has(row.rel)) removed.push(row.rel);
    return { workspaceId: before.workspaceId, beforeRevision: before.revision, afterRevision: after.revision, afterPhase: after.phase, added, changed, removed, unchanged, fetch: [...added, ...changed] };
}
module.exports = { collect, exportArchive, verifyArchive, compareManifests, readArchiveManifest, csvCell, FORMAT, READ_ONLY_SERVICE_VERSION };
