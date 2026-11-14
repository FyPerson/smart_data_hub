'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mutations = [
    { id: '明确只读配置被忽略', file: 'server.cjs', from: "const readOnly=options.readOnly===undefined?envReadOnly!=='0':options.readOnly;", to: 'const readOnly=false;', expect: '只读启动和读取' },
    { id: '缺省环境变量恢复成可写', file: 'server.cjs', from: "envReadOnly!=='0'", to: "envReadOnly==='1'", expect: '缺省与显式1均只读' },
    { id: '显式0不能受控恢复写入', file: 'server.cjs', from: "envReadOnly!=='0'", to: 'true', expect: '普通模式仍可' },
    { id: 'PM2未固化只读变量', file: 'ecosystem.config.cjs', from: "SYSBUILD_READ_ONLY: '1'", to: "SYSBUILD_READ_ONLY: '0'", expect: '缺省与显式1均只读' },
    { id: '包版本与健康版本不符', file: 'package.json', from: '0.8.0-readonly.2', to: '0.8.0-readonly.1', expect: '缺省与显式1均只读' },
    { id: '只读HTTP方法闸门放开', file: 'server.cjs', from: "if(readOnly&&!['GET','HEAD','OPTIONS'].includes(req.method))", to: "if(false&&readOnly&&!['GET','HEAD','OPTIONS'].includes(req.method))", expect: '所有非读取方法' },
    { id: '存储层只读闸门放开', file: 'server.cjs', from: 'const assertWritable=()=>{if(readOnly)throw', to: 'const assertWritable=()=>{if(false)throw', expect: '所有非读取方法' },
    { id: '只读读取仍恢复删除', file: 'server.cjs', from: 'if(!readOnly)await recoverDeletes();return load();', to: 'await recoverDeletes();return load();', expect: '只读启动和读取' },
    { id: '只读启动仍走初始化恢复', file: 'server.cjs', from: 'if(readOnly)return serial(async()=>', to: 'if(false)return serial(async()=>', expect: '只读启动和读取' },
    { id: '页面缺少只读身份', file: 'server.cjs', from: '<body data-readonly="true">', to: '<body>', expect: '只读页面展示' },
    { id: '未开启只读也生成最终证明', file: 'server.cjs', from: "if(!readOnly)throw fail('尚未开启只读，不能生成最终存档核对记录',409);", to: '', expect: '普通模式仍可' },
    { id: '证明响应泄露完整业务记录', file: 'server.cjs', from: 'readOnly:true,workspaceId:value.manifest.workspaceId', to: 'readOnly:true,data:value.data,workspaceId:value.manifest.workspaceId', expect: '只读启动和读取' },
    { id: '证明未绑定真实数据目录', file: 'server.cjs', from: 'dataDir:await fsp.realpath(store.root)', to: "dataDir:path.dirname(store.root)", expect: '只读启动和读取' },
    { id: '证明以固定3002冒充实际监听端口', file: 'server.cjs', from: 'port:server.address().port,serviceVersion:VERSION', to: 'port:3002,serviceVersion:VERSION', expect: '只读启动和读取' },
    { id: '证明返回旧只读服务版本', file: 'server.cjs', from: 'port:server.address().port,serviceVersion:VERSION', to: "port:server.address().port,serviceVersion:'0.8.0-readonly.1'", expect: '只读启动和读取' },
    { id: '取证不核URL预期端口', file: 'cli.cjs', from: 'if (urlPort !== expectedPort)', to: 'if (false)', expect: '取证拒绝URL或响应' },
    { id: '取证不核响应实际端口', file: 'cli.cjs', from: "proof.port !== expectedPort || proof.serviceVersion !== o['expected-version']", to: "proof.serviceVersion !== o['expected-version']", expect: '取证拒绝URL或响应' },
    { id: '取证不核显式预期版本', file: 'cli.cjs', from: "proof.serviceVersion !== o['expected-version'] ||", to: '', expect: '取证拒绝URL或响应' },
    { id: '取证允许未审旧服务版本', file: 'cli.cjs', from: ' || proof.serviceVersion !== archive.READ_ONLY_SERVICE_VERSION', to: '', expect: '取证拒绝URL或响应' },
    { id: '取证接受缺数据目录的旧证明', file: 'cli.cjs', from: "typeof proof.dataDir !== 'string' || !path.isAbsolute(proof.dataDir)", to: 'false', expect: '取证拒绝URL或响应' },
    { id: '配置接受字符串假布尔值', file: 'server.cjs', from: "typeof options.readOnly!=='boolean'", to: 'false', expect: '只读不初始化' },
    { id: '客户端把写请求发给只读服务器', file: 'server-client.js', from: "if(READONLY&&!['GET','HEAD','OPTIONS'].includes(method))throw", to: "if(false&&READONLY&&!['GET','HEAD','OPTIONS'].includes(method))throw", expect: '只读页面展示' },
];
async function run({ childEnv, appDir }) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sysbuild-3002-ro-mut-'));
    const test = path.join(__dirname, 'verify-readonly.cjs'); const root = path.resolve(__dirname, '../..');
    function execute(name, args) {
        const result = spawnSync(process.execPath, [test, ...args], { cwd: root, windowsHide: true, env: { ...process.env, ...childEnv }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 120000 });
        const log = (result.stdout || '') + (result.stderr || ''); fs.writeFileSync(path.join(out, name + '.log'), log, { flag: 'wx' });
        const match = /只读准备演练 \d+\/\d+；证据 ([^\r\n]+)/.exec(log);
        return { status: result.status, signal: result.signal, error: result.error && result.error.message, summary: match ? JSON.parse(fs.readFileSync(path.join(match[1], 'results.json'), 'utf8')) : null, evidence: match && match[1] };
    }
    const baseline = execute('baseline', []);
    if (baseline.status !== 0 || !baseline.summary || baseline.summary.passed !== baseline.summary.total) throw new Error('Readonly baseline failed; evidence ' + out);
    console.log('只读未变异基线 ' + baseline.summary.passed + '/' + baseline.summary.total);
    const results = [];
    for (const [index, mutation] of mutations.entries()) {
        const candidate = path.join(out, 'candidate-' + index); fs.mkdirSync(candidate);
        for (const file of ['server.cjs', 'server-client.js', 'offline.html', 'package.json', 'ecosystem.config.cjs']) fs.copyFileSync(path.join(appDir, file), path.join(candidate, file), fs.constants.COPYFILE_EXCL);
        for (const file of ['cli.cjs', 'archive-core.cjs', 'archive-fs.cjs']) fs.copyFileSync(path.join(__dirname, file), path.join(candidate, file), fs.constants.COPYFILE_EXCL);
        const source = fs.readFileSync(path.join(candidate, mutation.file), 'utf8').replace(/\r\n/g, '\n');
        const count = source.split(mutation.from).length - 1;
        if (count !== 1) { results.push({ id: mutation.id, red: false, error: 'anchor count ' + count }); console.log('锚点失败 ' + mutation.id); continue; }
        fs.writeFileSync(path.join(candidate, mutation.file), source.replace(mutation.from, () => mutation.to));
        const result = execute('mutation-' + index, ['--app-dir', candidate]);
        const failed = result.summary ? result.summary.results.filter((r) => !r.passed).map((r) => r.name) : [];
        const red = result.status === 1 && !result.signal && !result.error && result.summary && result.summary.total === baseline.summary.total && failed.some((name) => name.startsWith(mutation.expect));
        results.push({ id: mutation.id, red: !!red, status: result.status, failed, evidence: result.evidence, error: result.error }); console.log((red ? '变异判红 ' : '变异未检出 ') + mutation.id);
    }
    const red = results.filter((r) => r.red).length;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), scope: 'C9 draft, private service and data only', baseline: baseline.evidence, red, total: results.length, results }, null, 2));
    console.log('只读变异 ' + red + '/' + results.length + ' 判红；证据 ' + out); return red === results.length ? 0 : 1;
}
module.exports = { run };
