/**
 * #106 S1a 运行模式判定 / 库内身份 / AES 纯函数 / server.js 接入点静态核对（纯单测：不起服务、不碰业务库、不占端口）。
 *
 * 覆盖：
 *   A. resolveInstanceConfig 判定表四条 + 隔离类变量在正常模式出现即拒绝（4 个变量各一例）+ 各拒绝码 + 默认值；
 *   B. 正常模式取值与改造前逐字相同（含 collab-submit-helpers / periodic-fetch runner 的目录来源）；
 *   C. utils/aes-password.js 与 server.js 原 encryptPassword / decryptPassword 逐字节同口径；
 *   D. utils/instance-db.js：_internal.writeInstanceIdentity（不再公开导出，测试夹具用；同事务替换、失败回滚）与 checkInstanceIdentity（只读、空表 / 多行 / 缺表 / 不一致都拒）；
 *   E. server.js 接入点静态核对（含正常模式 DB_ENCRYPTION_KEY fail-closed 的 vm 执行证明）。
 *
 * 运行：node scripts/verify-instance-mode.js   （退出码 0 = 全部通过）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

// 本脚本不得受外部环境里的 SDH_* 影响
for (const k of Object.keys(process.env)) { if (/^sdh_/i.test(k)) delete process.env[k]; }   // 不分大小写（win32 上变量名不分大小写）

const WBS = path.resolve(__dirname, '..');
const mode = require('../utils/instance-mode');
const instanceDb = require('../utils/instance-db');
const aes = require('../utils/aes-password');

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------- A. 纯判定
const CK = path.join(os.tmpdir(), 'sdh-fake-checkout', 'wbs-server'); // 假检出目录：readFile 全走内存映射，磁盘上不存在
const ABS = (...p) => path.join(os.tmpdir(), 'sdh-fake-abs', ...p);
const IDF = path.join(CK, '.sdh-instance');

function mkRead(files) {
    return (p) => {
        if (Object.prototype.hasOwnProperty.call(files, p)) {
            const v = files[p];
            if (v instanceof Error) throw v;
            return v;
        }
        const e = new Error(`ENOENT: ${p}`);
        e.code = 'ENOENT';
        throw e;
    };
}
function resolveWith(env, files) {
    return mode.resolveInstanceConfig({ env, checkoutDir: CK, readFile: mkRead(files || {}) });
}
// 清单里 dir 字段写占位符 __DIR__，manifestFor 替换成该清单所在目录（清单 dir 必须等于 SDH_DATA_DIR）
function manifestFor(dir, obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj).split('__DIR__').join(JSON.stringify(dir).slice(1, -1));
    return { [path.join(dir, 'sdh-instance.json')]: text };
}
const goodManifest = (inst, extra) => Object.assign({ instance: inst, parent: 'main', pid: 4242, createdAt: '2026-10-16T00:00:00.000Z', dir: '__DIR__' }, extra || {});
function expectRefuse(label, r, code) {
    must(r && r.refuse === true && r.code === code, `${label} → 拒绝 ${code}`, JSON.stringify(r));
}

section('A1 判定表第 1 条：不设 SDH_INSTANCE');
{
    const r = resolveWith({}, {});
    must(r.mode === 'normal' && r.kind === 'normal' && r.instance === null, '无检出身份 → 正常模式', JSON.stringify(r));
    must(r.dbFile === path.join(CK, 'task_pool.db') && r.dataRoot === CK, '正常模式 dbFile / dataRoot 等于改造前取值');
    must(r.uploadDir === path.join(CK, 'uploads') && r.archiveDir === path.join(CK, 'archive') && r.periodicResultsDir === path.join(CK, 'periodic-results'), '正常模式 uploads / archive / periodic-results 路径同改造前');
    must(r.external === 'real' && r.background === 'on', '正常模式 external=real background=on');
    must(r.itReconcileDir === null && r.itInspectionSheetDir === null, '正常模式不给 it-ledger 注入目录（null）');
    must(r.checkoutIdentity === null && r.parentIdentity === null, '正常模式无检出身份 / 无父身份');

    const l = resolveWith({}, { [IDF]: 'line-a\n' });
    must(l.mode === 'isolated' && l.kind === 'line' && l.instance === 'line-a' && l.checkoutIdentity === 'line-a', '有检出身份 → 线服务，运行身份 = 检出身份', JSON.stringify(l));
    must(l.external === 'stub' && l.background === 'off', '线服务默认 external=stub background=off');
    must(l.dbFile === path.join(CK, 'task_pool.db') && l.dataRoot === CK, '线服务缺省库 / 数据根 = 本检出');
    must(l.itReconcileDir === path.join(CK, 'it-reconcile') && l.itInspectionSheetDir === path.join(CK, 'private', 'it-inspection-sheets'), '隔离模式 it-ledger 两个目录取自数据根');
    must(l.parentIdentity === null, '线服务 parentIdentity 为 null');

    const b = resolveWith({}, { [IDF]: '\uFEFF  line-a  \r\n' });
    must(b.instance === 'line-a', '检出身份去 BOM 与首尾空白');
}

section('A2 判定表第 2 条：SDH_INSTANCE 等于检出身份');
{
    const r = resolveWith({ SDH_INSTANCE: 'line-a' }, { [IDF]: 'line-a' });
    must(r.mode === 'isolated' && r.kind === 'line' && r.instance === 'line-a', '显式传同名身份 → 线服务', JSON.stringify(r));
    const e = resolveWith({ SDH_INSTANCE: '' }, { [IDF]: 'line-a' });
    must(e.kind === 'line', '空串 SDH_INSTANCE 视同未设');
}

section('A3 判定表第 3 条：test- 派生测试实例');
{
    const dir = ABS('data-1');
    const env = { SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir, SDH_DB_FILE: ABS('data-1', 'x.db') };
    const r1 = resolveWith(env, Object.assign({ [IDF]: 'line-a' }, manifestFor(dir, goodManifest('test-abc123', { parent: 'line-a' }))));
    must(r1.mode === 'isolated' && r1.kind === 'test' && r1.instance === 'test-abc123', '有检出身份 + test- → 派生测试实例', JSON.stringify(r1));
    must(r1.parentIdentity === 'line-a' && r1.checkoutIdentity === 'line-a', '父检出身份 = 检出身份');
    must(r1.dbFile === ABS('data-1', 'x.db') && r1.dataRoot === dir, 'dbFile / dataRoot 取自 SDH_DB_FILE / SDH_DATA_DIR');
    must(r1.uploadDir === path.join(dir, 'uploads') && r1.archiveDir === path.join(dir, 'archive') && r1.periodicResultsDir === path.join(dir, 'periodic-results'), 'uploads / archive / periodic-results 从数据根派生');
    must(r1.itReconcileDir === path.join(dir, 'it-reconcile') && r1.itInspectionSheetDir === path.join(dir, 'private', 'it-inspection-sheets'), 'it-ledger 对账 / 巡检单目录从数据根派生');
    must(r1.external === 'stub' && r1.background === 'off', '测试实例默认 stub / off');

    const r2 = resolveWith(env, manifestFor(dir, goodManifest('test-abc123')));
    must(r2.kind === 'test' && r2.checkoutIdentity === null && r2.parentIdentity === 'main', '无检出身份（主工作区）→ 父检出身份记 main', JSON.stringify(r2));

    const r3 = resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, goodManifest('test-abc123')));
    must(r3.dbFile === path.join(CK, 'task_pool.db'), '缺省 SDH_DB_FILE → 本检出 task_pool.db（身份核对靠库内表兜底）');

    // 数据根必须是专属临时目录（codex 06-M1）：真实路径位于 tmpdir 之内，且与检出目录互不包含
    {
        const tmpRoot = ABS('tmp-root');
        const mk = (dataDir, extra) => mode.resolveInstanceConfig(Object.assign({
            env: { SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dataDir }, checkoutDir: CK, tmpdir: tmpRoot,
            readFile: mkRead(manifestFor(dataDir, goodManifest('test-abc123'))),
        }, extra || {}));
        const okDir = path.join(tmpRoot, 'inst-1');
        const okR = mk(okDir);
        must(okR.mode === 'isolated' && okR.kind === 'test' && okR.dataRoot === okDir, '数据根在 tmpdir 之内的专属子目录 → 通过', JSON.stringify(okR));
        expectRefuse('数据根 = 检出目录', mk(CK), 'TEST_DATA_DIR_OVERLAPS_CHECKOUT');
        expectRefuse('数据根 = 检出目录的子目录', mk(path.join(CK, 'sub')), 'TEST_DATA_DIR_OVERLAPS_CHECKOUT');
        // 名字以 `..` 开头的普通子目录（如 `..data`）不是越出父目录：只有完整的 `..` 路径段才算（codex 06-R）
        expectRefuse('数据根 = 检出目录内的 `..data` 子目录 → 仍判重叠', mk(path.join(CK, '..data')), 'TEST_DATA_DIR_OVERLAPS_CHECKOUT');
        const dotDataOk = mk(path.join(tmpRoot, '..data'));
        must(dotDataOk.mode === 'isolated' && dotDataOk.kind === 'test', 'tmpdir 内、检出目录外的 `..data` 目录 → 接受（不会被误判成 tmpdir 之外）', JSON.stringify(dotDataOk));
        expectRefuse('数据根 = 包含检出目录的上级', mk(path.dirname(CK)), 'TEST_DATA_DIR_OVERLAPS_CHECKOUT');
        expectRefuse('数据根不在 tmpdir 之内', mk(ABS('elsewhere')), 'TEST_DATA_DIR_NOT_TEMP');
        expectRefuse('数据根 = tmpdir 本身（不是专属子目录）', mk(tmpRoot), 'TEST_DATA_DIR_NOT_TEMP');
        expectRefuse('数据根 = tmpdir 的上级', mk(path.dirname(tmpRoot)), 'TEST_DATA_DIR_NOT_TEMP');
        // 线服务的数据根不受此限（缺省就是检出目录）
        const lineR = mode.resolveInstanceConfig({ env: {}, checkoutDir: CK, tmpdir: tmpRoot, readFile: mkRead({ [IDF]: 'line-a' }) });
        must(lineR.mode === 'isolated' && lineR.kind === 'line' && lineR.dataRoot === CK, '线服务数据根缺省 = 检出目录，不受 tmpdir 限制');
    }
    expectRefuse('test- 缺 SDH_DATA_DIR', resolveWith({ SDH_INSTANCE: 'test-abc123' }, {}), 'TEST_DATA_DIR_REQUIRED');
    expectRefuse('test- 缺实例清单', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, {}), 'TEST_MANIFEST_MISSING');
    expectRefuse('test- 清单身份不符', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, goodManifest('test-other'))), 'TEST_MANIFEST_MISMATCH');
    expectRefuse('test- 清单 dir 与 SDH_DATA_DIR 不是同一目录', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, goodManifest('test-abc123', { dir: ABS('data-other') }))), 'TEST_MANIFEST_DIR_MISMATCH');
    expectRefuse('test- 清单缺 pid', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, { instance: 'test-abc123', parent: 'main', createdAt: 'x', dir: 'x' })), 'TEST_MANIFEST_INVALID');
    expectRefuse('test- 清单缺 dir', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, { instance: 'test-abc123', parent: 'main', pid: 1, createdAt: 'x' })), 'TEST_MANIFEST_INVALID');
    expectRefuse('test- 清单不是 JSON', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, '{not json')), 'TEST_MANIFEST_INVALID');
    expectRefuse('test- 清单是数组', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, manifestFor(dir, '[]')), 'TEST_MANIFEST_INVALID');
    expectRefuse('test- 清单读取出错（非 ENOENT）', resolveWith({ SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: dir }, { [path.join(dir, 'sdh-instance.json')]: Object.assign(new Error('EACCES'), { code: 'EACCES' }) }), 'TEST_MANIFEST_UNREADABLE');
    expectRefuse('test- 名字不合法', resolveWith({ SDH_INSTANCE: 'test-', SDH_DATA_DIR: dir }, manifestFor(dir, goodManifest('test-'))), 'INVALID_INSTANCE_NAME');
    expectRefuse('test- 名字含路径字符', resolveWith({ SDH_INSTANCE: 'test-../x', SDH_DATA_DIR: dir }, {}), 'INVALID_INSTANCE_NAME');
}

section('A4 判定表第 4 条：其他一切拒绝');
{
    expectRefuse('冒用别的线名', resolveWith({ SDH_INSTANCE: 'line-b' }, { [IDF]: 'line-a' }), 'INSTANCE_IMPERSONATION');
    expectRefuse('冒用 main', resolveWith({ SDH_INSTANCE: 'main' }, { [IDF]: 'line-a' }), 'INSTANCE_IMPERSONATION');
    expectRefuse('主工作区设非 test- 身份', resolveWith({ SDH_INSTANCE: 'line-a' }, {}), 'INSTANCE_WITHOUT_CHECKOUT_IDENTITY');
    expectRefuse('主工作区设 main', resolveWith({ SDH_INSTANCE: 'main' }, {}), 'INSTANCE_WITHOUT_CHECKOUT_IDENTITY');
    expectRefuse('主工作区设 Test-（大小写不同）', resolveWith({ SDH_INSTANCE: 'Test-abc' }, {}), 'INSTANCE_WITHOUT_CHECKOUT_IDENTITY');
}

section('A5 隔离类变量在正常模式出现即拒绝（4 个变量各一例）');
{
    expectRefuse('正常模式 + SDH_DB_FILE', resolveWith({ SDH_DB_FILE: ABS('a.db') }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    expectRefuse('正常模式 + SDH_DATA_DIR', resolveWith({ SDH_DATA_DIR: ABS('d') }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    expectRefuse('正常模式 + SDH_EXTERNAL=stub', resolveWith({ SDH_EXTERNAL: 'stub' }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    expectRefuse('正常模式 + SDH_BACKGROUND_JOBS=off', resolveWith({ SDH_BACKGROUND_JOBS: 'off' }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    must(resolveWith({ SDH_EXTERNAL: '', SDH_BACKGROUND_JOBS: '  ' }, {}).mode === 'normal', '空值的隔离类变量视同未设（不误拒）');
    const r = resolveWith({ SDH_DB_FILE: ABS('a.db'), SDH_EXTERNAL: 'stub' }, {});
    must(/SDH_DB_FILE/.test(r.message) && /SDH_EXTERNAL/.test(r.message), '拒绝信息列出全部出现的变量', r.message);
}

section('A6 隔离模式变量校验与默认值');
{
    const files = { [IDF]: 'line-a' };
    expectRefuse('隔离模式 SDH_EXTERNAL=real', resolveWith({ SDH_EXTERNAL: 'real' }, files), 'EXTERNAL_NOT_ALLOWED');
    expectRefuse('隔离模式 SDH_EXTERNAL=anything', resolveWith({ SDH_EXTERNAL: 'anything' }, files), 'EXTERNAL_NOT_ALLOWED');
    must(resolveWith({ SDH_EXTERNAL: 'stub' }, files).external === 'stub', '隔离模式 SDH_EXTERNAL=stub 接受');
    must(resolveWith({ SDH_BACKGROUND_JOBS: 'on' }, files).background === 'on', 'SDH_BACKGROUND_JOBS=on 显式开启周期任务');
    must(resolveWith({ SDH_BACKGROUND_JOBS: 'off' }, files).background === 'off', 'SDH_BACKGROUND_JOBS=off');
    expectRefuse('SDH_BACKGROUND_JOBS=maybe', resolveWith({ SDH_BACKGROUND_JOBS: 'maybe' }, files), 'BACKGROUND_JOBS_INVALID');
    expectRefuse('SDH_DB_FILE 相对路径', resolveWith({ SDH_DB_FILE: 'rel/a.db' }, files), 'PATH_NOT_ABSOLUTE');
    expectRefuse('SDH_DATA_DIR 相对路径', resolveWith({ SDH_DATA_DIR: 'rel' }, files), 'PATH_NOT_ABSOLUTE');
    const r = resolveWith({ SDH_DB_FILE: ABS('line.db'), SDH_DATA_DIR: ABS('root') }, files);
    must(r.dbFile === ABS('line.db') && r.dataRoot === ABS('root') && r.uploadDir === ABS('root', 'uploads'), '线服务可显式指定库与数据根');
}

section('A7 检出身份文件本身的校验');
{
    expectRefuse('标识文件为空', resolveWith({}, { [IDF]: '  \n' }), 'IDENTITY_FILE_EMPTY');
    expectRefuse('标识文件线名以 test- 开头', resolveWith({}, { [IDF]: 'test-x' }), 'INVALID_CHECKOUT_IDENTITY');
    expectRefuse('标识文件线名为 main', resolveWith({}, { [IDF]: 'main' }), 'INVALID_CHECKOUT_IDENTITY');
    expectRefuse('标识文件线名含空格', resolveWith({}, { [IDF]: 'a b' }), 'INVALID_CHECKOUT_IDENTITY');
    expectRefuse('标识文件多行', resolveWith({}, { [IDF]: 'a\nb' }), 'INVALID_CHECKOUT_IDENTITY');
    expectRefuse('标识文件读取出错（非 ENOENT）', resolveWith({}, { [IDF]: Object.assign(new Error('EACCES'), { code: 'EACCES' }) }), 'IDENTITY_FILE_UNREADABLE');
    expectRefuse('缺 checkoutDir', mode.resolveInstanceConfig({ env: {}, readFile: mkRead({}) }), 'CHECKOUT_DIR_REQUIRED');
}

section('A8 .env 里的 SDH_* 并入判定（进程变量优先，等价 dotenv 不覆盖已有变量）');
{
    const ENVF = path.join(CK, '.env');
    expectRefuse('.env 写 SDH_EXTERNAL=stub、无标识文件 → 正常模式出现隔离类变量', resolveWith({}, { [ENVF]: 'SDH_EXTERNAL=stub\n' }), 'ISOLATION_VAR_IN_NORMAL_MODE');
    expectRefuse('.env 写 SDH_DB_FILE → 同样拒绝', resolveWith({}, { [ENVF]: `SDH_DB_FILE=${ABS('a.db')}\n` }), 'ISOLATION_VAR_IN_NORMAL_MODE');
    let r = resolveWith({}, { [IDF]: 'line-a', [ENVF]: 'SDH_BACKGROUND_JOBS=on\nJWT_SECRET=whatever\n' });
    must(r.mode === 'isolated' && r.background === 'on', '.env 里的 SDH_BACKGROUND_JOBS=on 在线检出生效', JSON.stringify(r));
    r = resolveWith({ SDH_BACKGROUND_JOBS: 'off' }, { [IDF]: 'line-a', [ENVF]: 'SDH_BACKGROUND_JOBS=on\n' });
    must(r.background === 'off', '同名变量：进程变量优先于 .env', JSON.stringify(r));
    r = resolveWith({ SDH_EXTERNAL: '' }, { [ENVF]: 'SDH_EXTERNAL=stub\n' });
    must(r.mode === 'normal', '进程里显式置空的同名变量挡住 .env（dotenv 语义：key 已存在就不覆盖）', JSON.stringify(r));
    expectRefuse('.env 写 SDH_INSTANCE=line-b、检出身份 line-a → 冒用', resolveWith({}, { [IDF]: 'line-a', [ENVF]: 'SDH_INSTANCE=line-b\n' }), 'INSTANCE_IMPERSONATION');
    expectRefuse('.env 写 SDH_EXTERNAL=real、线检出 → 拒绝', resolveWith({}, { [IDF]: 'line-a', [ENVF]: 'SDH_EXTERNAL=real\n' }), 'EXTERNAL_NOT_ALLOWED');
    must(resolveWith({}, { [ENVF]: 'JWT_SECRET=x\nPORT=3000\n' }).mode === 'normal', '.env 里非 SDH_* 变量不参与判定');
    must(resolveWith({}, { [ENVF]: Object.assign(new Error('EACCES'), { code: 'EACCES' }) }).mode === 'normal', '.env 读不了 → 按空处理（与 dotenv 静默忽略一致）');
    must(resolveWith({}, { [ENVF]: '\u0000\u0001 not a dotenv file ===' }).mode === 'normal', '.env 内容乱码 → 不含 SDH_* 即正常模式');

    // 清单 dir 与 SDH_DATA_DIR 的同目录比较走真实路径：目录联接 / 符号链接两种写法算同一目录
    const rtmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s1a-real-'));
    try {
        const realDir = path.join(rtmp, 'real');
        const linkDir = path.join(rtmp, 'link');
        fs.mkdirSync(realDir);
        fs.symlinkSync(realDir, linkDir, 'junction');
        const man = JSON.stringify({ instance: 'test-abc123', parent: 'main', pid: 4242, createdAt: 'x', dir: realDir });
        fs.writeFileSync(path.join(realDir, 'sdh-instance.json'), man);
        const viaLink = mode.resolveInstanceConfig({ env: { SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: linkDir }, checkoutDir: CK, readFile: (p) => { if (p.startsWith(CK)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(p, 'utf8'); } });
        must(viaLink.mode === 'isolated' && viaLink.kind === 'test', '清单 dir=真实目录、SDH_DATA_DIR=指向它的联接 → 解析真实路径后视为同目录', JSON.stringify(viaLink));
        const otherDir = path.join(rtmp, 'other');
        fs.mkdirSync(otherDir);
        fs.writeFileSync(path.join(otherDir, 'sdh-instance.json'), man);
        const wrong = mode.resolveInstanceConfig({ env: { SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: otherDir }, checkoutDir: CK, readFile: (p) => { if (p.startsWith(CK)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(p, 'utf8'); } });
        expectRefuse('清单 dir 指向另一个真实目录 → 拒绝', wrong, 'TEST_MANIFEST_DIR_MISMATCH');
        // 数据根经联接指向检出目录：真实路径判重叠，不能靠字面路径绕过
        const fakeCo = path.join(rtmp, 'co');
        fs.mkdirSync(fakeCo);
        const linkCo = path.join(rtmp, 'link-to-co');
        fs.symlinkSync(fakeCo, linkCo, 'junction');
        fs.writeFileSync(path.join(fakeCo, 'sdh-instance.json'), JSON.stringify({ instance: 'test-abc123', parent: 'main', pid: 4242, createdAt: 'x', dir: fakeCo }));
        const viaCo = mode.resolveInstanceConfig({ env: { SDH_INSTANCE: 'test-abc123', SDH_DATA_DIR: linkCo }, checkoutDir: fakeCo, readFile: (p) => fs.readFileSync(p, 'utf8') });
        expectRefuse('数据根是指向检出目录的联接 → 按真实路径判重叠，拒绝', viaCo, 'TEST_DATA_DIR_OVERLAPS_CHECKOUT');
    } finally {
        try { fs.rmSync(rtmp, { recursive: true, force: true }); } catch (_) { /* junction 删除失败不影响结论 */ }
    }
}

section('A9 环境变量名大小写：win32 不分大小写（模拟），非 win32 区分');
{
    const ENVF = path.join(CK, '.env');
    const withPlat = (platform, env, files) => mode.resolveInstanceConfig({ env, checkoutDir: CK, readFile: mkRead(files || {}), platform });
    const j = (x) => JSON.stringify(x);
    // 进程变量
    let a = withPlat('win32', { sdh_external: 'stub' }, {});
    expectRefuse('win32：进程变量 sdh_external=stub（小写）→ 拒绝', a, 'ISOLATION_VAR_IN_NORMAL_MODE');
    must(j(a) === j(withPlat('win32', { SDH_EXTERNAL: 'stub' }, {})), 'win32：小写键与大写键的判定结果逐字相同');
    expectRefuse('win32：进程变量 sdh_db_file / Sdh_Data_Dir 混合大小写 → 拒绝', withPlat('win32', { sdh_db_file: ABS('a.db'), Sdh_Data_Dir: ABS('d') }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    expectRefuse('win32：Sdh_Instance=line-b、检出身份 line-a → 冒用', withPlat('win32', { Sdh_Instance: 'line-b' }, { [IDF]: 'line-a' }), 'INSTANCE_IMPERSONATION');
    expectRefuse('win32：sdh_instance=not-test、无检出身份 → 拒绝', withPlat('win32', { sdh_instance: 'not-test' }, {}), 'INSTANCE_WITHOUT_CHECKOUT_IDENTITY');
    expectRefuse('win32：sdh_external=real、线检出 → 拒绝', withPlat('win32', { sdh_external: 'real' }, { [IDF]: 'line-a' }), 'EXTERNAL_NOT_ALLOWED');
    // .env 里的键
    expectRefuse('win32：.env 里小写键 sdh_external=stub、无标识文件 → 拒绝', withPlat('win32', {}, { [ENVF]: 'sdh_external=stub\n' }), 'ISOLATION_VAR_IN_NORMAL_MODE');
    // .env 内同名不同大小写变体：dotenv 写 process.env 时「键已存在就跳过」，win32 上大小写变体是同一个键，所以先出现者保留
    let r = withPlat('win32', {}, { [IDF]: 'line-a', [ENVF]: 'SDH_BACKGROUND_JOBS=off\nsdh_background_jobs=on\n' });
    must(r.background === 'off', 'win32：.env 内同名不同大小写变体，先出现者保留（大写在前 → off）', j(r));
    r = withPlat('win32', {}, { [IDF]: 'line-a', [ENVF]: 'sdh_background_jobs=on\nSDH_BACKGROUND_JOBS=off\n' });
    must(r.background === 'on', 'win32：.env 内同名不同大小写变体，先出现者保留（小写在前 → on）', j(r));
    // codex 06-H 的具体误判例：.env 先 sdh_instance=test-probe、后 SDH_INSTANCE=（空）。win32 上先出现者保留 → 身份是 test-probe（缺数据根，必须拒绝），
    //   旧实现（后者覆盖）会得到空身份而走正常模式。
    expectRefuse('win32：.env `sdh_instance=test-probe` 后接 `SDH_INSTANCE=` → 身份为 test-probe，缺数据根被拒（不是正常模式）',
        withPlat('win32', {}, { [ENVF]: 'sdh_instance=test-probe\nSDH_INSTANCE=\n' }), 'TEST_DATA_DIR_REQUIRED');
    must(withPlat('win32', {}, { [ENVF]: 'SDH_INSTANCE=\nsdh_instance=test-probe\n' }).mode === 'normal', 'win32：反向顺序（空值在前）→ 空值先到先得，等价未设身份（与 dotenv 一致）');
    // 已有进程变量时，.env 的两个变体都不生效
    r = withPlat('win32', { SDH_BACKGROUND_JOBS: 'off' }, { [IDF]: 'line-a', [ENVF]: 'sdh_background_jobs=on\nSDH_BACKGROUND_JOBS=on\n' });
    must(r.background === 'off', 'win32：进程里已有该变量 → .env 的两个大小写变体都不生效', j(r));
    r = withPlat('win32', { sdh_background_jobs: 'off' }, { [IDF]: 'line-a', [ENVF]: 'SDH_BACKGROUND_JOBS=on\n' });
    must(r.background === 'off', 'win32：进程变量小写、.env 大写 → 进程变量优先', j(r));
    // 归一只对 ASCII 字母大写：'ſ'（U+017F）经 toUpperCase 会变成 'S'，不能因此把 `ſdh_external` 当成 SDH_EXTERNAL
    must('ſdh_external'.toUpperCase() === 'SDH_EXTERNAL', '前置：JS 的 toUpperCase 会把 ſdh_external 变成 SDH_EXTERNAL（这个用例防的就是它）');
    must(withPlat('win32', { 'ſdh_external': 'stub' }, {}).mode === 'normal', 'win32：进程变量 ſdh_external 不会被当成 SDH_EXTERNAL');
    must(withPlat('win32', {}, { [ENVF]: 'ſdh_external=stub\n' }).mode === 'normal', 'win32：.env 里的 ſdh_external 不会被当成 SDH_EXTERNAL');
    // 非 win32：大小写变体是两个变量，只认大写
    r = withPlat('linux', {}, { [IDF]: 'line-a', [ENVF]: 'sdh_background_jobs=on\nSDH_BACKGROUND_JOBS=off\n' });
    must(r.background === 'off', '非 win32：.env 里小写变体不参与，只认大写键', j(r));
    r = withPlat('win32', { Sdh_Background_Jobs: 'off' }, { [IDF]: 'line-a', [ENVF]: 'SDH_BACKGROUND_JOBS=on\n' });
    must(r.background === 'off', 'win32：进程变量（任意大小写）优先于 .env', j(r));
    // 非 win32：大小写敏感，小写名是另一个变量
    must(withPlat('linux', { sdh_external: 'stub' }, {}).mode === 'normal', '非 win32：小写 sdh_external 不参与判定（与该平台 process.env 语义一致）');
    expectRefuse('非 win32：大写 SDH_EXTERNAL 照旧拒绝', withPlat('linux', { SDH_EXTERNAL: 'stub' }, {}), 'ISOLATION_VAR_IN_NORMAL_MODE');
    must(withPlat('linux', {}, { [ENVF]: 'sdh_external=stub\n' }).mode === 'normal', '非 win32：.env 小写键不参与判定');
}

// ---------------------------------------------------------------- B. 正常模式与改造前一致（真实进程环境，不起服务）
section('B 正常模式取值与改造前逐字相同（真实 fs / process.env）');
if (fs.existsSync(path.join(WBS, '.sdh-instance'))) {
  console.log('  [SKIP] 本检出存在 .sdh-instance（线检出），跳过「主工作区」断言');
} else {
    mode._resetInstanceConfigForTest();
    const cfg = mode.getInstanceConfig();
    must(cfg.mode === 'normal' && cfg.instance === null, '本检出无标识文件、无 SDH_* → 正常模式', JSON.stringify(cfg));
    must(cfg === mode.getInstanceConfig(), 'getInstanceConfig 缓存同一份结果');
    must(cfg.dbFile === path.join(WBS, 'task_pool.db'), 'dbFile === path.join(__dirname, "task_pool.db")（server.js 原写法）');
    must(cfg.uploadDir === path.join(WBS, 'uploads') && cfg.archiveDir === path.join(WBS, 'archive'), 'uploads / archive 同 server.js 原写法');
    const helpers = require('../utils/collab-submit-helpers');
    must(helpers.resolveAttachmentPath('collab/a.xlsx') === path.resolve(path.join(path.dirname(path.join(WBS, 'utils')), 'uploads'), 'collab/a.xlsx'), 'collab-submit-helpers 附件解析根 = 原写法 wbs-server/uploads');
    const runner = require('../routes/periodic-fetch/runner');
    must(runner.PERIODIC_RESULTS_DIR === path.join(WBS, 'routes', 'periodic-fetch', '..', '..', 'periodic-results'), 'periodic-fetch runner 结果目录 = 原写法');
    mode._resetInstanceConfigForTest();
}

// ---------------------------------------------------------------- B2. 真实加载顺序（子进程 + 临时 checkoutDir）
section('B2 真实加载顺序：工具模块在 dotenv 之前触发首次判定，结果仍与 dotenv 之后重新判定一致');
{
    const { execFileSync } = require('child_process');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s1a-order-'));
    try {
        const co = path.join(root, 'wbs-server');
        fs.mkdirSync(path.join(co, 'utils'), { recursive: true });
        // 临时 checkoutDir 里放一份 instance-mode.js 的字节拷贝（单例的 checkoutDir 取自它自己的位置，所以必须挪过去才能不碰主工作区的 .env）
        fs.copyFileSync(path.join(WBS, 'utils', 'instance-mode.js'), path.join(co, 'utils', 'instance-mode.js'));
        // 对应 server.js:20 的 collab-submit-helpers：顶层立刻调用 getInstanceConfig()
        fs.writeFileSync(path.join(co, 'utils', 'early-helper.js'), "module.exports = require('./instance-mode').getInstanceConfig();\n");
        fs.writeFileSync(path.join(co, 'driver.js'), [
            "'use strict';",
            "const path = require('path');",
            "const early = require('./utils/early-helper');                       // server.js:20 一带：dotenv 之前",
            "require('dotenv').config({ path: path.join(__dirname, '.env') });    // server.js:65",
            "const im = require('./utils/instance-mode');",
            "const fs = require('fs');",
            "// 独立参照：dotenv 已把 .env 写进 process.env。参照的环境按 5 个规范名逐个用 process.env[NAME] 取值（借操作系统自己的不分大小写查找，",
            "// win32 上 process.env.SDH_EXTERNAL 会命中 sdh_external），再传 platform:'linux' 关掉被测的大小写归一，并让 .env 读到 ENOENT——",
            "// 这样参照不经过被测的归一逻辑，也不依赖 .env 合并逻辑。（单例 getInstanceConfig() 与 early 是同一个缓存对象，拿它比是恒真，不作判据。）",
            "const refEnv = {};",
            "for (const n of ['SDH_INSTANCE', 'SDH_DB_FILE', 'SDH_DATA_DIR', 'SDH_EXTERNAL', 'SDH_BACKGROUND_JOBS']) { if (process.env[n] !== undefined) refEnv[n] = process.env[n]; }",
            "const ref = im.resolveInstanceConfig({ env: refEnv, platform: 'linux', checkoutDir: __dirname, readFile: (p) => { if (path.basename(p) === '.env') { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return fs.readFileSync(p, 'utf8'); } });",
            "console.log(JSON.stringify({ early, ref, envAfter: { ext: process.env.SDH_EXTERNAL || null } }));",
        ].join('\n'));
        const childEnv = Object.assign({}, process.env, { NODE_PATH: path.join(WBS, 'node_modules') });
        for (const k of Object.keys(childEnv)) { if (/^sdh_/i.test(k)) delete childEnv[k]; }
        const runDriver = (extraEnv) => JSON.parse(execFileSync(process.execPath, [path.join(co, 'driver.js')], { cwd: root, env: Object.assign({}, childEnv, extraEnv || {}), encoding: 'utf8', windowsHide: true }));

        // 场景 1：.env 写 SDH_EXTERNAL=stub、无标识文件 → 正常模式出现隔离类变量，三处都必须拒绝
        fs.writeFileSync(path.join(co, '.env'), 'SDH_EXTERNAL=stub\n');
        let o = runDriver();
        must(o.envAfter.ext === 'stub', '前置：dotenv 之后 process.env 里确实有 .env 的 SDH_EXTERNAL', JSON.stringify(o.envAfter));
        must(o.early.refuse === true && o.early.code === 'ISOLATION_VAR_IN_NORMAL_MODE', '场景 1：dotenv 之前的首次判定已拒绝（.env 的 SDH_* 不会被静默忽略）', JSON.stringify(o.early));
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 1：dotenv 之前的首次结果 = 独立参照（dotenv 之后按进程环境重新判定）', JSON.stringify(o));

        // 场景 2：线检出 + .env 写 SDH_BACKGROUND_JOBS=on → 线服务且周期任务开启
        fs.writeFileSync(path.join(co, '.sdh-instance'), 'line-x\n');
        fs.writeFileSync(path.join(co, '.env'), 'SDH_BACKGROUND_JOBS=on\nSDH_EXTERNAL=stub\n');
        o = runDriver();
        must(o.early.mode === 'isolated' && o.early.background === 'on' && o.early.external === 'stub', '场景 2：dotenv 之前的首次判定就带上 .env 的 SDH_BACKGROUND_JOBS=on', JSON.stringify(o.early));
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 2：dotenv 之前的首次结果 = 独立参照', JSON.stringify(o));

        // 场景 3：线检出 + .env 写 SDH_EXTERNAL=real → 拒绝
        fs.writeFileSync(path.join(co, '.env'), 'SDH_EXTERNAL=real\n');
        o = runDriver();
        must(o.early.refuse === true && o.early.code === 'EXTERNAL_NOT_ALLOWED' && JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 3：.env 写 SDH_EXTERNAL=real → 首次结果拒绝且 = 独立参照', JSON.stringify(o));

        // 场景 4：无 .env 无标识文件 → 正常模式（三处一致）
        fs.rmSync(path.join(co, '.env'));
        fs.rmSync(path.join(co, '.sdh-instance'));
        o = runDriver();
        must(o.early.mode === 'normal' && JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 4：无 .env、无标识文件 → 正常模式，= 独立参照', JSON.stringify(o));

        // 场景 5（H-new1）：.env 里写小写键 sdh_external=stub。win32 上环境变量名不分大小写，dotenv 写进 process.env 后就是 SDH_EXTERNAL，
        //   判定必须据此拒绝；非 win32 上小写名是另一个变量，不参与判定。独立参照读 process.env，两侧口径一致。
        fs.writeFileSync(path.join(co, '.env'), 'sdh_external=stub\n');
        o = runDriver();
        if (process.platform === 'win32') {
            must(o.early.refuse === true && o.early.code === 'ISOLATION_VAR_IN_NORMAL_MODE', '场景 5（win32）：.env 小写键 sdh_external=stub 同样拒绝', JSON.stringify(o.early));
        } else {
            must(o.early.mode === 'normal', '场景 5（非 win32）：小写键不参与判定（大小写敏感）', JSON.stringify(o.early));
        }
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 5：首次结果 = 独立参照', JSON.stringify(o));

        // 场景 6 / 7（codex 06-H / 06T-M2）：.env 里同名不同大小写变体的优先级，以 dotenv 加载后的实际 process.env 为参照。
        //   win32：同一变量，dotenv 先写先得；非 win32：两个不同变量，判定只认大写键。两侧在各自平台上必须一致。
        fs.writeFileSync(path.join(co, '.sdh-instance'), 'line-x\n');
        fs.writeFileSync(path.join(co, '.env'), 'SDH_BACKGROUND_JOBS=off\nsdh_background_jobs=on\n');
        o = runDriver();
        must(o.early.mode === 'isolated' && o.early.background === 'off', '场景 6：.env 先 SDH_BACKGROUND_JOBS=off、后 sdh_background_jobs=on → off（win32 先到先得；非 win32 只认大写）', JSON.stringify(o.early));
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 6：首次结果 = 独立参照（dotenv 加载后的实际 process.env）', JSON.stringify(o));
        fs.writeFileSync(path.join(co, '.env'), 'sdh_background_jobs=on\nSDH_BACKGROUND_JOBS=off\n');
        o = runDriver();
        const wantBg = process.platform === 'win32' ? 'on' : 'off';
        must(o.early.mode === 'isolated' && o.early.background === wantBg, `场景 7：.env 先 sdh_background_jobs=on、后 SDH_BACKGROUND_JOBS=off → ${wantBg}（win32 先到先得；非 win32 只认大写）`, JSON.stringify(o.early));
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 7：首次结果 = 独立参照', JSON.stringify(o));
        // 场景 9（变体并存）：进程环境有 SDH_BACKGROUND_JOBS=off，.env 里又有 sdh_background_jobs=on 与 SDH_BACKGROUND_JOBS=on —— 进程变量优先，
        //   两个平台都应得 off；参照用 process.env[NAME] 取值，不经过被测的归一逻辑。
        fs.writeFileSync(path.join(co, '.env'), 'sdh_background_jobs=on\nSDH_BACKGROUND_JOBS=on\n');
        o = runDriver({ SDH_BACKGROUND_JOBS: 'off' });
        must(o.early.mode === 'isolated' && o.early.background === 'off', '场景 9：进程变量 off 与 .env 的两个变体并存 → off', JSON.stringify(o.early));
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 9：首次结果 = 独立参照', JSON.stringify(o));
        // 场景 8：06-H 的具体误判例，无标识文件：先 sdh_instance=test-probe、后 SDH_INSTANCE=
        fs.rmSync(path.join(co, '.sdh-instance'));
        fs.writeFileSync(path.join(co, '.env'), 'sdh_instance=test-probe\nSDH_INSTANCE=\n');
        o = runDriver();
        if (process.platform === 'win32') {
            must(o.early.refuse === true && o.early.code === 'TEST_DATA_DIR_REQUIRED', '场景 8（win32）：身份是 test-probe（先到先得），缺数据根被拒，不是正常模式', JSON.stringify(o.early));
        } else {
            must(o.early.mode === 'normal', '场景 8（非 win32）：小写 sdh_instance 是另一个变量，不参与判定', JSON.stringify(o.early));
        }
        must(JSON.stringify(o.ref) === JSON.stringify(o.early), '场景 8：首次结果 = 独立参照', JSON.stringify(o));
    } catch (e) {
        bad('B2 出现未预期异常', e && (e.stack || e.message));
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
    // 工具模块确实在顶层触发首次判定——这是上面场景要覆盖的"早于 dotenv"的真实来源（server.js 第 20 行 require）
    must(/require\('\.\/instance-mode'\)\.getInstanceConfig\(\)/.test(fs.readFileSync(path.join(WBS, 'utils', 'collab-submit-helpers.js'), 'utf8')), '前置：collab-submit-helpers 顶层确实调用 getInstanceConfig()（首次判定早于 server.js 的 dotenv）');
}

// ---------------------------------------------------------------- C. AES 纯函数
section('C AES 纯函数与 server.js 原实现逐字节同口径');
{
    function legacyEncrypt(key, password, iv) {
        const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(key.padEnd(32).slice(0, 32)), iv);
        let encrypted = cipher.update(password, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        return iv.toString('hex') + ':' + encrypted;
    }
    function legacyDecrypt(key, text) {
        const parts = text.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(key.padEnd(32).slice(0, 32)), iv);
        let d = decipher.update(parts[1], 'hex', 'utf8');
        d += decipher.final('utf8');
        return d;
    }
    const keys = ['K'.repeat(32), 'abcdefghijklmnopqrstuvwxyz0123456789-long-key-over-32', aes.ISOLATED_ENCRYPTION_KEY];
    for (const key of keys) {
        const plain = '口令 pass/word:with:colons ' + key.length;
        const mine = aes.encryptWithKey(key, plain);
        must(legacyDecrypt(key, mine) === plain, `纯函数加密 → 原实现可解（key 长 ${key.length}）`);
        must(aes.decryptWithKey(key, legacyEncrypt(key, plain.split(':')[0], Buffer.alloc(16, 7))) === plain.split(':')[0], `原实现加密 → 纯函数可解（key 长 ${key.length}）`);
        const iv = Buffer.alloc(16, 9);
        const orig = Object.getOwnPropertyDescriptor(crypto, 'randomBytes');
        crypto.randomBytes = (n) => (n === 16 ? iv : orig.value.call(crypto, n));
        let same;
        try { same = aes.encryptWithKey(key, 'x') === legacyEncrypt(key, 'x', iv); } finally { Object.defineProperty(crypto, 'randomBytes', orig); }
        must(same, `固定 IV 下密文逐字节相同（key 长 ${key.length}）`);
    }
    must(aes.ISOLATED_ENCRYPTION_KEY.length >= 32, '隔离专用键 ≥ 32 字节');
    must(/isolated/.test(aes.ISOLATED_ENCRYPTION_KEY), '隔离专用键内容体现 isolated');
    const a = aes.encryptWithKey(keys[0], 'same');
    const b = aes.encryptWithKey(keys[0], 'same');
    must(a !== b, '每次随机 IV（同明文两次密文不同）');
    // 换键解密：CBC 下约 1/256 的概率恰好通过填充校验而「解出」乱码，所以判据是「抛错，或解出结果 ≠ 原明文」，不是必抛错
    const wrongKeyCannotRecover = (decryptKey, ct, plain) => {
        try { return aes.decryptWithKey(decryptKey, ct) !== plain; } catch (_) { return true; }
    };
    must(wrongKeyCannotRecover(keys[1], a, 'same'), '换键解密：抛错或结果 ≠ 原明文');
    must(wrongKeyCannotRecover(aes.ISOLATED_ENCRYPTION_KEY, aes.encryptWithKey(keys[0], 'secret'), 'secret'), '隔离键解不出真键密文的原文（抛错或结果 ≠ 原文）');
    must(!wrongKeyCannotRecover(keys[0], a, 'same'), '对照：正确键解得出原文（上面两条的判据不是恒真）');
}

// ---------------------------------------------------------------- D. 库内身份
(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s1a-unit-'));
    const sqlite3 = require('sqlite3');
    const run = (db, sql, params) => new Promise((res, rej) => db.run(sql, params || [], (e) => (e ? rej(e) : res())));
    const all = (db, sql) => new Promise((res, rej) => db.all(sql, [], (e, r) => (e ? rej(e) : res(r))));
    const open = (f) => new Promise((res, rej) => { const d = new sqlite3.Database(f, (e) => (e ? rej(e) : res(d))); });
    const close = (db) => new Promise((res) => db.close(() => res()));
    const newDb = async (name) => { const f = path.join(tmp, name); const d = await open(f); return { f, d }; };

    try {
        section('D1 writeInstanceIdentity');
        const w1 = path.join(tmp, 'w1.db');
        await instanceDb._internal.writeInstanceIdentity(w1, { instanceId: 'line-a', parent: 'main', from: 'E:/src/task_pool.db' });
        let d = await open(w1);
        let rows = await all(d, 'SELECT id, instance_id, created_at, source FROM _sdh_instance');
        await close(d);
        must(rows.length === 1 && rows[0].id === 1 && rows[0].instance_id === 'line-a' && !!rows[0].created_at, '建表并写入一行', JSON.stringify(rows));
        must(JSON.parse(rows[0].source).parent === 'main' && JSON.parse(rows[0].source).from === 'E:/src/task_pool.db', 'source 存 {"parent","from"} JSON');
        await instanceDb._internal.writeInstanceIdentity(w1, { instanceId: 'test-xyz', parent: 'line-a', from: w1 });
        d = await open(w1);
        rows = await all(d, 'SELECT instance_id, source FROM _sdh_instance');
        await close(d);
        must(rows.length === 1 && rows[0].instance_id === 'test-xyz' && JSON.parse(rows[0].source).parent === 'line-a', '再次写入是替换不是追加', JSON.stringify(rows));
        for (const bad1 of [{ instanceId: '', parent: 'main' }, { instanceId: 'x', parent: '' }, { instanceId: 'x' }]) {
            let t = false;
            try { await instanceDb._internal.writeInstanceIdentity(path.join(tmp, 'w-bad.db'), bad1); } catch (_) { t = true; }
            must(t, `写入参数缺失被拒：${JSON.stringify(bad1)}`);
        }
        // 事务回滚：已有一张缺 source 列的 _sdh_instance，INSERT 必失败，旧行必须还在
        {
            const { f, d: dd } = await newDb('w-rollback.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER PRIMARY KEY, instance_id TEXT NOT NULL, created_at TEXT NOT NULL)');
            await run(dd, "INSERT INTO _sdh_instance VALUES (1, 'old-one', 't')");
            await close(dd);
            let threw = false;
            try { await instanceDb._internal.writeInstanceIdentity(f, { instanceId: 'new-one', parent: 'main' }); } catch (_) { threw = true; }
            const d2 = await open(f);
            const r2 = await all(d2, 'SELECT instance_id FROM _sdh_instance');
            await close(d2);
            must(threw && r2.length === 1 && r2[0].instance_id === 'old-one', '写入失败整体回滚（旧行保留，没有「删了没补」）', JSON.stringify(r2));
        }

        section('D2 checkInstanceIdentity');
        const okRes = await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'test-xyz', expectedParent: 'line-a' });
        must(okRes.ok === true && okRes.code === 'OK', '身份一致且父身份一致 → ok', JSON.stringify(okRes));
        must((await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'test-xyz' })).ok === true, '不传 expectedParent 则不核对父身份');
        let r = await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'other' });
        must(r.ok === false && r.code === 'INSTANCE_MISMATCH', 'instance_id 不一致 → INSTANCE_MISMATCH', JSON.stringify(r));
        r = await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'test-xyz', expectedParent: 'main' });
        must(r.ok === false && r.code === 'PARENT_MISMATCH', '父检出身份不一致 → PARENT_MISMATCH', JSON.stringify(r));

        // 缺表
        {
            const { f, d: dd } = await newDb('no-table.db');
            await run(dd, 'CREATE TABLE other (a INTEGER)');
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'x' });
            must(r.ok === false && r.code === 'TABLE_MISSING', '缺 _sdh_instance 表 → TABLE_MISSING', JSON.stringify(r));
        }
        // 空表
        {
            const { f, d: dd } = await newDb('empty-table.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)');
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'x' });
            must(r.ok === false && r.code === 'ROW_COUNT', '空表 → ROW_COUNT', JSON.stringify(r));
        }
        // 两行（直接 SQL 造：无 PK / CHECK 的同名表，第一行恰好匹配——不查行数的实现会放行）
        {
            const { f, d: dd } = await newDb('two-rows.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER, instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)');
            await run(dd, "INSERT INTO _sdh_instance VALUES (1, 'line-a', 't', '{\"parent\":\"main\"}')");
            await run(dd, "INSERT INTO _sdh_instance VALUES (1, 'line-b', 't', '{\"parent\":\"main\"}')");
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'line-a' });
            must(r.ok === false && r.code === 'ROW_COUNT', '表两行（第一行匹配）→ 仍拒绝 ROW_COUNT', JSON.stringify(r));
        }
        // 字段为空串
        {
            const { f, d: dd } = await newDb('empty-field.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)');
            await run(dd, "INSERT INTO _sdh_instance VALUES (1, 'line-a', '', '{}')");
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'line-a' });
            must(r.ok === false && r.code === 'FIELD_EMPTY', '字段为空串 → FIELD_EMPTY', JSON.stringify(r));
        }
        // id 不是 1
        {
            const { f, d: dd } = await newDb('id2.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER, instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)');
            await run(dd, "INSERT INTO _sdh_instance VALUES (2, 'line-a', 't', '{}')");
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'line-a' });
            must(r.ok === false && r.code === 'ID_INVALID', 'id≠1 → ID_INVALID', JSON.stringify(r));
        }
        // source 不是 JSON 且要求核对父身份
        {
            const { f, d: dd } = await newDb('bad-source.db');
            await run(dd, 'CREATE TABLE _sdh_instance (id INTEGER PRIMARY KEY CHECK (id = 1), instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL)');
            await run(dd, "INSERT INTO _sdh_instance VALUES (1, 'line-a', 't', 'not-json')");
            await close(dd);
            r = await instanceDb.checkInstanceIdentity(f, { expectedInstance: 'line-a', expectedParent: 'main' });
            must(r.ok === false && r.code === 'SOURCE_INVALID', 'source 非 JSON + 要求核父身份 → SOURCE_INVALID', JSON.stringify(r));
        }
        // 业务库式的库（无身份表）
        // 文件不存在：只读打开必失败，且不得创建文件
        {
            const ghost = path.join(tmp, 'ghost.db');
            r = await instanceDb.checkInstanceIdentity(ghost, { expectedInstance: 'x' });
            must(r.ok === false && r.code === 'DB_OPEN_FAILED' && !fs.existsSync(ghost), '库文件不存在 → DB_OPEN_FAILED 且不创建文件', JSON.stringify(r));
        }
        // 只读：核对前后库文件字节不变、不留 journal
        {
            const before = fs.readFileSync(w1);
            await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'test-xyz' });
            await instanceDb.checkInstanceIdentity(w1, { expectedInstance: 'wrong' });
            const after = fs.readFileSync(w1);
            must(before.equals(after) && !fs.existsSync(w1 + '-journal'), '核对是只读的：库文件字节不变、无 journal 残留');
        }
        // hot journal：上次异常退出（进程被杀）留下未回滚的 journal，普通只读连接读不了（SQLITE_READONLY）；
        //   身份核对必须仍然能给出正确结论（匹配 → ok，不匹配 → 拒绝），且不改动库文件与 journal
        {
            const hjDb = path.join(tmp, 'hot.db');
            await instanceDb._internal.writeInstanceIdentity(hjDb, { instanceId: 'line-hot', parent: 'main' });
            const childFile = path.join(tmp, 'hj-child.js');
            fs.writeFileSync(childFile, [
                `const sqlite3 = require(${JSON.stringify(require.resolve('sqlite3'))});`,
                'const db = new sqlite3.Database(process.argv[2]);',
                'db.serialize(() => {',
                "  db.run('PRAGMA cache_size = 10');",
                "  db.run('CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, v TEXT)');",
                "  db.run('BEGIN IMMEDIATE');",
                '  db.run("WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 30000) INSERT INTO big(v) SELECT hex(randomblob(200)) FROM c", [], (e) => { console.log(e ? "ERR " + e.message : "READY"); });',
                '});',
                'setInterval(() => {}, 1000);',
            ].join('\n'));
            // 子进程等待：累计输出后再匹配标记（标记可能被拆在两个数据块里）；就绪 / 退出各设期限；处理 spawn 的 error 事件；
            //   独立 try/finally 保证失败路径也终止并回收子进程。
            const { spawn } = require('child_process');
            // 结果用结构化状态表示（ready / error / exit / spawn_error / timeout），只有「完整的 READY 行」才算 ready；
            //   超时 / 提前退出 / ERR 行都不会被正则误当成就绪。
            let sig = { state: 'unknown', output: '' };
            const ch = spawn(process.execPath, [childFile, hjDb], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
            let chExited = false;
            const chExit = new Promise((res) => { ch.once('exit', () => { chExited = true; res(); }); ch.once('error', () => { chExited = true; res(); }); });
            try {
                let acc = '';
                const ready = new Promise((res) => {
                    ch.stdout.on('data', (b) => {
                        acc += String(b);
                        if (/^READY\s*$/m.test(acc)) res({ state: 'ready', output: acc });
                        else if (/^ERR /m.test(acc)) res({ state: 'error', output: acc });
                    });
                    ch.once('exit', () => res({ state: 'exit', output: acc }));
                    ch.once('error', (e) => res({ state: 'spawn_error', output: acc + ' ' + (e && e.message) }));
                });
                let timer;
                sig = await Promise.race([ready, new Promise((res) => { timer = setTimeout(() => res({ state: 'timeout', output: acc }), 30000); })]);
                clearTimeout(timer);
            } finally {
                if (!chExited) { try { ch.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }
                await Promise.race([chExit, new Promise((res) => setTimeout(res, 10000))]);
                if (!chExited) bad('hot journal 子进程在 10 秒期限内没有退出（已发 SIGKILL）');
            }
            must(sig.state === 'ready' && fs.existsSync(hjDb + '-journal'), '前置：造出 hot journal（写事务进行中进程被硬杀）；就绪只认明确的 READY 行，超时 / 提前退出 / ERR 都判红', JSON.stringify(sig));
            // 前置：普通只读连接确实读不了
            const plain = await new Promise((res) => {
                const x = new sqlite3.Database(hjDb, sqlite3.OPEN_READONLY, (e) => {
                    if (e) return res('OPEN_ERR ' + e.message);
                    x.all('SELECT 1 FROM sqlite_master', [], (err) => x.close(() => res(err ? err.code : 'READ_OK')));
                });
            });
            must(plain === 'SQLITE_READONLY', '前置：普通只读连接读 hot journal 库报 SQLITE_READONLY（不是用例造得不对）', plain);
            const jBefore = fs.readFileSync(hjDb + '-journal');
            const dbBefore = fs.readFileSync(hjDb);
            r = await instanceDb.checkInstanceIdentity(hjDb, { expectedInstance: 'line-hot', expectedParent: 'main' });
            must(r.ok === true, 'hot journal 库：身份一致 → 仍核对通过（immutable 只读回退）', JSON.stringify(r));
            r = await instanceDb.checkInstanceIdentity(hjDb, { expectedInstance: 'someone-else' });
            must(r.ok === false && r.code === 'INSTANCE_MISMATCH', 'hot journal 库：身份不一致 → 仍拒绝 INSTANCE_MISMATCH', JSON.stringify(r));
            must(fs.readFileSync(hjDb + '-journal').equals(jBefore) && fs.readFileSync(hjDb).equals(dbBefore), '核对未改动库文件与 journal（没有触发回滚 / 写入）');
        }
        // 同步版的失败处理：替身核对脚本（经 _checkScript 注入，仅测试用）模拟「非 0 退出」「输出 ok:true 却非 0 退出」「输出垃圾」
        {
            const mkFake = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return f; };
            const okExit1 = mkFake('fake-ok-exit1.js', "process.stdout.write(JSON.stringify({ ok: true, code: 'OK', message: 'fake' })); process.exitCode = 1;\n");
            const okExit0 = mkFake('fake-ok-exit0.js', "process.stdout.write(JSON.stringify({ ok: true, code: 'OK', message: 'fake' }));\n");
            const failExit1 = mkFake('fake-fail-exit1.js', "process.stdout.write(JSON.stringify({ ok: false, code: 'INSTANCE_MISMATCH', message: 'fake' })); process.exitCode = 1;\n");
            const garbage = mkFake('fake-garbage.js', "process.stdout.write('not json');\n");
            const silentCrash = mkFake('fake-silent-crash.js', 'process.exit(3);\n');
            const run = (script) => instanceDb.checkInstanceIdentitySync(w1, { expectedInstance: 'test-xyz', _checkScript: script });
            let s = run(okExit1);
            must(s.ok === false && s.code === 'CHECK_PROCESS_FAILED', '子进程非 0 退出却输出 ok:true → 按失败处理（CHECK_PROCESS_FAILED）', JSON.stringify(s));
            s = run(okExit0);
            must(s.ok === true, '对照：同样输出 ok:true 但正常退出（退出码 0）→ 通过（上一条不是恒判失败）', JSON.stringify(s));
            s = run(failExit1);
            must(s.ok === false && s.code === 'INSTANCE_MISMATCH', '对照：非 0 退出且输出 ok:false → 原样带出原因码', JSON.stringify(s));
            s = run(garbage);
            must(s.ok === false && s.code === 'CHECK_OUTPUT_INVALID', '输出无法解析 → CHECK_OUTPUT_INVALID', JSON.stringify(s));
            s = run(silentCrash);
            must(s.ok === false && s.code === 'CHECK_PROCESS_FAILED', '子进程无输出崩溃 → CHECK_PROCESS_FAILED', JSON.stringify(s));
        }
        // 同步版（server.js 启动期用）
        {
            let s = instanceDb.checkInstanceIdentitySync(w1, { expectedInstance: 'test-xyz', expectedParent: 'line-a' });
            must(s.ok === true, '同步版（子进程）通过', JSON.stringify(s));
            s = instanceDb.checkInstanceIdentitySync(w1, { expectedInstance: 'nope' });
            must(s.ok === false && s.code === 'INSTANCE_MISMATCH', '同步版不一致 → 拒绝并带原因码', JSON.stringify(s));
            s = instanceDb.checkInstanceIdentitySync(path.join(tmp, 'ghost2.db'), { expectedInstance: 'x' });
            must(s.ok === false && s.code === 'DB_OPEN_FAILED' && !fs.existsSync(path.join(tmp, 'ghost2.db')), '同步版：库不存在 → 拒绝，不创建文件', JSON.stringify(s));
        }
    } catch (e) {
        bad('D 段出现未预期异常', e && e.stack);
    } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }

    // ---------------------------------------------------------------- E. server.js 接入点静态核对
    section('E server.js 接入点静态核对');
    const src = fs.readFileSync(path.join(WBS, 'server.js'), 'utf8');
    // 注：判定「早于/晚于 dotenv」的行为由 A8 / B2 的行为断言覆盖；这里不再做只比源码文字先后的断言（那种断言在 getInstanceConfig 被更早触发时仍然绿）。
    const posDotenv = src.indexOf("require('dotenv').config(");
    must(/const UPLOAD_DIR = INSTANCE_CONFIG\.uploadDir;/.test(src) && /const ARCHIVE_DIR = INSTANCE_CONFIG\.archiveDir;/.test(src), 'UPLOAD_DIR / ARCHIVE_DIR 取自实例配置');
    must(!/^const (DB_FILE|UPLOAD_DIR|ARCHIVE_DIR) = path\.join\(__dirname/m.test(src), '旧的三处写死路径定义已删除');
    must(/const PORT = parseInt\(process\.env\.PORT \|\| '3000'\);/.test(src) && src.indexOf("const PORT = parseInt") < posDotenv, 'PORT 仍在 dotenv 之前读取（读取顺序不变）');
    must(/\.\.\.\(INSTANCE_CONFIG\.background === 'on' \? \{\} : \{ expirySweepEnabled: false \}\)/.test(src) && /expirySweepEnabled: true,/.test(src), 'sys-iteration 过期扫描：保留字面量 true + 隔离默认关闭的覆盖');
    must(/\.\.\.\(INSTANCE_CONFIG\.background === 'on' \? \{\} : \{ verifyEnabled: false \}\)/.test(src) && /verifyEnabled: true,/.test(src), '模型中心三端核验：保留字面量 true + 隔离默认关闭的覆盖');
    must(/reconcileStorageDir: INSTANCE_CONFIG\.itReconcileDir/.test(src) && /inspectionSheetStorageDir: INSTANCE_CONFIG\.itInspectionSheetDir/.test(src) && /INSTANCE_CONFIG\.mode === 'isolated' \? \{/.test(src), 'it-ledger 注入：隔离模式传 reconcileStorageDir / inspectionSheetStorageDir，正常模式展开空对象');
    // 主会话裁定（修复批 2）：主库打开回调保持与生产一致，不做二次身份复核，也不包装启动序列（残余登记在 server.js 启动前核对处的注释）
    must(!/startAfterOpen|recheckIdentityOnConnection/.test(src) && /new sqlite3\.Database\(DB_FILE, \(err\) => \{\s*if \(err\) \{\s*logger\.error\('Error opening database', err\.message\);\s*\} else \{\s*logger\.info\('Connected to Task Pool database\.'\);\s*\/\/ v1\.70\.0 codex 24 审 #4/.test(src), '主库打开回调：无 startAfterOpen 包装、无二次复核，回调开头与生产写法一致');
    must(/^app\.listen\(PORT, '0\.0\.0\.0', function onListening\(\) \{/m.test(src), 'app.listen 仍是零缩进锚点形态');
    must(/\[instance\] mode=\$\{INSTANCE_CONFIG\.mode\}/.test(src), 'listen 回调打印 [instance] 行');
    const ver = src.slice(src.indexOf("app.get('/api/version'"), src.indexOf("app.get('/api/auth/me'"));
    must(['version: packageJson.version', "name: '智数协同平台'", "nameEn: 'Smart Data Hub'", 'mode: INSTANCE_CONFIG.mode', 'instance: INSTANCE_CONFIG.instance', 'external: INSTANCE_CONFIG.external', 'background: INSTANCE_CONFIG.background', 'commit: DEPLOY_COMMIT'].every((s) => ver.includes(s)), '/api/version 保留原字段并新增 mode / instance / external / background / commit');

    // E2 正常模式 DB_ENCRYPTION_KEY fail-closed：把 server.js 里这一段拎出来在 vm 里执行（不启动 server.js）
    const keyStart = src.indexOf('const ENCRYPTION_KEY =');
    const keyEnd = src.indexOf('function encryptPassword(');
    must(keyStart > 0 && keyEnd > keyStart, '定位到 ENCRYPTION_KEY 段');
    const keySnippet = src.slice(keyStart, keyEnd);
    function runKeySnippet(cfgMode, envKey) {
        const rec = { exit: null, errors: [] };
        const sandbox = {
            INSTANCE_CONFIG: { mode: cfgMode },
            aesPassword: aes,
            process: { env: envKey === undefined ? {} : { DB_ENCRYPTION_KEY: envKey }, exit: (c) => { rec.exit = c; } },
            console: { error: (...a) => rec.errors.push(a.join(' ')) },
        };
        vm.runInNewContext(keySnippet + '\nthis.__key = ENCRYPTION_KEY;', sandbox);
        rec.key = sandbox.__key;
        return rec;
    }
    must(runKeySnippet('normal', undefined).exit === 1, '正常模式：DB_ENCRYPTION_KEY 未设 → process.exit(1)（fail-closed 保持）');
    must(runKeySnippet('normal', 'x'.repeat(31)).exit === 1, '正常模式：DB_ENCRYPTION_KEY 31 字节 → 拒绝');
    const okKey = runKeySnippet('normal', 'k'.repeat(32));
    must(okKey.exit === null && okKey.key === 'k'.repeat(32), '正常模式：32 字节键 → 通过且用的是进程键');
    const isoNoKey = runKeySnippet('isolated', undefined);
    must(isoNoKey.exit === null && isoNoKey.key === aes.ISOLATED_ENCRYPTION_KEY, '隔离模式：不设 DB_ENCRYPTION_KEY 也通过，用固定隔离键');
    const isoBadKey = runKeySnippet('isolated', 'short');
    must(isoBadKey.exit === null && isoBadKey.key === aes.ISOLATED_ENCRYPTION_KEY, '隔离模式：即使进程键非法也忽略，用固定隔离键');
    must(/encryptWithKey\(ENCRYPTION_KEY, password\)/.test(src) && /decryptWithKey\(ENCRYPTION_KEY, encryptedPassword\)/.test(src), 'encryptPassword / decryptPassword 委托纯函数且传 ENCRYPTION_KEY');

    console.log(`\nverify-instance-mode PASS=${pass} FAIL=${fail}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('verify-instance-mode 未预期异常:', e); process.exit(1); });
