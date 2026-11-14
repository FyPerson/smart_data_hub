'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const source = fs.readFileSync(path.join(__dirname, 'archive-core.cjs'), 'utf8').replace(/\r\n/g, '\n');
const mutations = [
    { id: '只存档当前引用原件', expect: '中文路径全部物理', from: 'return { root, inventory, manifest, files, mirrors, fingerprints };', to: "return { root, inventory, manifest, files: files.filter((r) => r.state === 'current'), mirrors, fingerprints };" },
    { id: '当前提交快照未标记', expect: '中文路径全部物理', from: 'currentSnapshots.add(rel);', to: 'void rel;' },
    { id: '忽略原件与记录摘要不一致', expect: '原件hash不符', from: 'if (file.expectedSha && file.sha256 !== file.expectedSha)', to: 'if (false)' },
    { id: '最终清单无需只读证明', expect: '最终清单要求', from: "if (phase === 'final') boundProof = checkProof(readOnlyProof, data, servicePort);", to: 'void readOnlyProof;' },
    { id: '最终证明不核源目录实路径', expect: '最终存档拒绝同工作区', from: 'if (proofRoot !== sourceRoot)', to: 'if (false)' },
    { id: '最终证明不核预期监听端口', expect: '最终存档拒绝同工作区', from: 'if (proof.port !== servicePort)', to: 'if (false)' },
    { id: '最终证明接受未审旧版本', expect: '最终存档拒绝同工作区', from: 'if (proof.serviceVersion !== READ_ONLY_SERVICE_VERSION)', to: 'if (false)' },
    { id: '最终存档端口可以省略', expect: '最终存档拒绝同工作区', from: "if (!Number.isInteger(servicePort) || servicePort < 1 || servicePort > 65535) throw S.fail('SERVICE_PORT_REQUIRED', '最终清单须显式指定实际待切换服务的监听端口');", to: 'if (servicePort === undefined) servicePort = proof.port;' },
    { id: '长期核验忽略证明数据目录', expect: '长期核验仍拒绝', from: ' || manifest.readOnlyProof.dataDir !== manifest.sourceDataDir', to: '' },
    { id: '长期核验忽略证明监听端口', expect: '长期核验仍拒绝', from: ' || manifest.readOnlyProof.port !== manifest.servicePort', to: '' },
    { id: '长期核验接受未审服务版本', expect: '长期核验仍拒绝', from: ' || manifest.readOnlyProof.serviceVersion !== READ_ONLY_SERVICE_VERSION', to: '' },
    { id: '过期只读证明也接受', expect: '最终清单要求', from: "throw S.fail('READ_ONLY_PROOF_STALE', '只读核对记录须在当天获取且时间有效');", to: 'void 0;' },
    { id: '以24小时冒充北京时间当天', expect: '只读证明按北京时间日界', from: 'const sameChinaDay = Number.isFinite(at) && Math.floor((at + 8 * 3600000) / 86400000) === Math.floor((now + 8 * 3600000) / 86400000);', to: 'const sameChinaDay = Number.isFinite(at) && now - at <= 86400000;' },
    { id: 'CSV公式未经保护', expect: '中文路径全部物理', from: "text = \"'\" + text;", to: 'void text;' },
    { id: '导出泄露原业务正文', expect: '中文路径全部物理', from: 'sourceRecordHashes: Object.fromEntries(data.fingerprints),', to: "businessRecord: fs.readFileSync(S.child(data.root, [...data.fingerprints.keys()].find((r) => r.endsWith('/project.json'))), 'utf8'), sourceRecordHashes: Object.fromEntries(data.fingerprints)," },
    { id: '源变化仍发布完整存档', expect: '复制期间源索引变化', from: "throw S.fail('SOURCE_CHANGED', '导出期间源文件集合、索引或附件发生变化；本次不作为完整存档');", to: 'void 0;' },
    { id: '存档额外文件不报错', expect: '按清单核验拒绝', from: "throw S.fail('ARCHIVE_FILE_SET_MISMATCH', '存档文件集合与清单不符，不能按完整存档验收');", to: 'void 0;' },
    { id: '存档篡改不报错', expect: '按清单核验拒绝', from: "throw S.fail('ARCHIVE_HASH_MISMATCH', '存档附件大小或 SHA-256 与清单不符');", to: 'void 0;' },
    { id: '变化附件被判为未变', expect: '最终清单差异', from: 'else if (prior.size !== row.size || prior.sha256 !== row.sha256)', to: 'else if (false)' },
    { id: '补拉清单漏掉变化附件', expect: '最终清单差异', from: 'fetch: [...added, ...changed]', to: 'fetch: [...added]' },
    { id: '镜像落后不提示', expect: '镜像落后时', from: "mirror.projectId === ref.id && mirror.revision === pkg.revision ? 'matches' : 'stale'", to: "true ? 'matches' : 'stale'" },
];
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-archive-mut-'));
function execute(name, args) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-archive.cjs'), ...args], { cwd: path.resolve(__dirname, '../..'), windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 30000 });
    const log = (r.stdout || '') + (r.stderr || ''); fs.writeFileSync(path.join(out, name + '.log'), log, { flag: 'wx' });
    const m = /存档准备演练 \d+\/\d+；证据 ([^\r\n]+)/.exec(log);
    return { status: r.status, signal: r.signal, error: r.error && r.error.message, summary: m ? JSON.parse(fs.readFileSync(path.join(m[1], 'results.json'), 'utf8')) : null, evidence: m && m[1] };
}
const baseline = execute('baseline', []);
if (baseline.status !== 0 || !baseline.summary || baseline.summary.passed !== baseline.summary.total) throw new Error('Archive baseline failed; evidence ' + out);
console.log('存档未变异基线 ' + baseline.summary.passed + '/' + baseline.summary.total);
const results = [];
for (const [index, mutation] of mutations.entries()) {
    const count = source.split(mutation.from).length - 1;
    if (count !== 1) { results.push({ id: mutation.id, red: false, error: 'anchor count ' + count }); console.log('锚点失败 ' + mutation.id); continue; }
    const candidate = path.join(out, 'candidate-' + index); fs.mkdirSync(candidate);
    fs.copyFileSync(path.join(__dirname, 'archive-fs.cjs'), path.join(candidate, 'archive-fs.cjs'), fs.constants.COPYFILE_EXCL);
    const file = path.join(candidate, 'archive-core.cjs'); fs.writeFileSync(file, source.replace(mutation.from, () => mutation.to), { flag: 'wx' });
    const r = execute('mutation-' + index, ['--candidate', file]); const failed = r.summary ? r.summary.results.filter((item) => !item.passed).map((item) => item.name) : [];
    const red = r.status === 1 && !r.signal && !r.error && r.summary && r.summary.total === baseline.summary.total && failed.some((name) => name.startsWith(mutation.expect));
    results.push({ id: mutation.id, red: !!red, failed, status: r.status, evidence: r.evidence, error: r.error }); console.log((red ? '变异判红 ' : '变异未检出 ') + mutation.id);
}
const red = results.filter((r) => r.red).length;
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'C9 draft, private filesystem only', baseline: baseline.evidence, red, total: results.length, results }, null, 2));
console.log('存档变异 ' + red + '/' + results.length + ' 判红；证据 ' + out); process.exitCode = red === results.length ? 0 : 1;
