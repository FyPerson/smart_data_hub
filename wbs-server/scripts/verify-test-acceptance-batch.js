// verify-test-acceptance-batch.js — 验收批跑清单与 MIGRATED 登记的防漂移校验（#106 S4e-2，收尾登记 ⑨）
//
// 背景：已迁移（MIGRATED）的脚本不是 FAMILY 成员，验收跑要靠一份清单（scripts/lib/test-acceptance-batch.json）：
//   members = 每个已迁移脚本的批跑约束（needsService / exclusive / resources / timeoutMs / args，字段与 lib/test-batch.js 的成员同源）；
//   excluded = 登记为 MIGRATED 但不进验收批跑的脚本 → 理由；
//   envProvidedBy = 独占（exclusive）成员里源码带 extraEnv 的脚本 → 它需要的环境值在批跑器起的实例里怎样进来（见下面 EXTRAENV）。
//   清单由生成器按登记表与历史派单清单生成（不手抄）；批跑器只读 members（run-test-batch.js 的 --manifest），顶层其他键被忽略。
// 本校验把「清单 ⇄ 登记表」的漂移变成红灯：以后新登记一个 MIGRATED 却忘了进清单（或反过来）、字段写错、文件被删，FAMILY 都会判红。
//
// 运行面：纯 node，只读源码与 JSON；不起进程、不开库、不读环境配置文件、不联网。
//   require('./lib/test-batch') 的副作用（实测，只加载模块、不起任何东西）：顺带加载 test-instance.js（含 sqlite3 原生模块与 dotenv 模块的加载，不调用 config）与 scripts/lines 下的几个登记模块；
//   进程环境变量键集合、cwd、事件监听器、活动句柄加载前后不变。字段校验与批跑器同源（normalizeMembers），不另写一份。
//
// 检查（任一不满足即判红、退出码 1；每条问题带文件名）：
//   STRUCT       清单是对象，members 是数组，excluded 是对象
//   NORMALIZE    members 经 lib/test-batch 的 normalizeMembers 规范化不抛错（未知字段 / 类型 / 重复 label / 资源名 / 不需服务却写 resources 等）
//   REL / LABEL / REL_DUP / MISSING_FILE
//                每个成员 rel 恰为 scripts/<名>.js、label === <名>；rel 不重复；对应文件存在（excluded 的文件同样要存在）
//   MISSING / EXTRA / OVERLAP / REASON
//                成员名集合 ∪ excluded 键集合 = 登记表 MIGRATED 键集合：登记了却不在清单里（MISSING）、清单里有登记表没有的（EXTRA）、同时在 members 与 excluded（OVERLAP）、excluded 理由空白（REASON）
//   NOTIMEOUT    不需服务的成员（没有 needsService 且不 exclusive）不得写 timeoutMs：批跑器对它们走同步 spawn、没有截止，timeoutMs 被忽略（lib/test-batch.js 头注释 :23、runSync），写了会让人误以为有截止
//   EXTRAENV     需服务成员（needsService 为 true，含 exclusive）的源码里（注释除外）出现 extraEnv 的，必须登记在 envProvidedBy：需服务成员的实例一律由批跑器起（共享 / 独占都是），
//                成员拿到 TEST_* 变量组后 ready() 的选项被忽略（lib/test-env.js 变量组形态），成员传的 extraEnv 不会生效；不需服务的成员自己 ready() 起实例，extraEnv 生效，不查
//   ENVSRC_STALE / ENVSRC_REASON
//                envProvidedBy 的登记硬门：登记的文件必须是 members 里 exclusive 的需服务成员（共享实例成员登记一律判红，证据写「非 exclusive」：登记理由是按独占实例的情境核过的）、
//                源码（注释除外）确实含 extraEnv，否则判过期；理由必须非空白。不做任何按文件名或理由内容的自动放行
//   SOURCE_READ  需要读源码判断 extraEnv 的成员（未登记的需服务成员、已登记的 exclusive 成员）文件存在但读取失败（权限等）：单独报错并带原因，不当作「没有 extraEnv」；
//                每个文件只读一次、只报一次，读取失败的文件不再叠加 EXTRAENV / ENVSRC_STALE。不需服务的成员不读源码，读不读得出来都不管
//   注释里的 extraEnv 字样不算：只看代码（acorn 剥掉注释；解析失败则按全文判，宁可误红）。
//
// 残余（登记，不在本校验内处理）：不需服务的成员（现 27 个：26 个自己 ready() 起隔离实例，verify-dingtalk-file-helper 无 ready）走 spawnSync、没有截止；
//   验收跑必须在批跑器外层再加一个总截止，否则其中一个挂住会拖住整批。
//
// 用法：node scripts/verify-test-acceptance-batch.js            校验真实清单与登记表
//       node scripts/verify-test-acceptance-batch.js --self-test 在内存里构造合成的登记表 / 清单 / 文件内容，逐条证明每一项违规都判红、合法组合判绿，最后对真实清单跑一遍
// 输出末行：verify-test-acceptance-batch members=<n> excluded=<n> envProvidedBy=<n> PASS  |  … FAIL problems=<n>（并逐条列出）；自检末行 … --self-test PASS=<n> FAIL=<n>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');
const { normalizeMembers, DEFAULT_MEMBER_TIMEOUT_MS } = require('./lib/test-batch');

const MANIFEST_FILE = path.join(__dirname, 'lib', 'test-acceptance-batch.json');
const REL_RE = /^scripts\/([A-Za-z0-9._-]+\.js)$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 源码去掉注释（用 acorn 收集注释区间后换成空格）；解析失败 → 原文照旧（宁可把注释里的字样也算上，误红比漏红安全） */
function stripComments(text) {
    const comments = [];
    try { acorn.parse(text, { ecmaVersion: 'latest', allowHashBang: true, sourceType: 'script', onComment: comments }); } catch (e) { return text; }
    let out = text;
    for (let i = comments.length - 1; i >= 0; i--) out = out.slice(0, comments[i].start) + ' '.repeat(comments[i].end - comments[i].start) + out.slice(comments[i].end);
    return out;
}
const hasExtraEnvInCode = (text) => typeof text === 'string' && stripComments(text).includes('extraEnv');

/**
 * 纯函数：校验一份清单。
 *   manifest  已解析的清单对象（或任何值，用来测 STRUCT）
 *   migrated  登记表 MIGRATED 的键数组（文件名）
 *   io        { exists(name) -> boolean, readSource(name) -> string }（真实运行读 scripts 目录，自检注入合成内容）
 * 返回 { problems: [{ code, file, msg }], members, excluded, envProvidedBy }（后三项为数量）
 */
function checkAcceptance(manifest, migrated, io) {
    const problems = [];
    const add = (code, file, msg) => problems.push({ code, file: file || '', msg });
    let nMembers = 0;
    let nExcluded = 0;
    if (!isObj(manifest)) { add('STRUCT', '', '清单必须是对象'); return { problems, members: 0, excluded: 0, envProvidedBy: 0 }; }
    const rawMembers = manifest.members;
    const rawExcluded = manifest.excluded;
    if (!Array.isArray(rawMembers)) add('STRUCT', '', 'members 必须是数组');
    if (!isObj(rawExcluded)) add('STRUCT', '', 'excluded 必须是对象');
    const rawEnv = manifest.envProvidedBy;
    if (rawEnv !== undefined && !isObj(rawEnv)) add('STRUCT', '', 'envProvidedBy 必须是对象（缺省视为空）');
    const members = Array.isArray(rawMembers) ? rawMembers : [];
    const excluded = isObj(rawExcluded) ? rawExcluded : {};
    const envProvidedBy = isObj(rawEnv) ? rawEnv : {};
    nMembers = members.length;
    nExcluded = Object.keys(excluded).length;

    // 字段校验与批跑器同源
    let normalized = null;
    if (Array.isArray(rawMembers)) {
        try { normalized = normalizeMembers(members, { timeoutMs: DEFAULT_MEMBER_TIMEOUT_MS }); } catch (e) { add('NORMALIZE', '', `normalizeMembers 抛错：${e && e.message ? e.message : String(e)}`); }
    }

    // rel / label / 重复 / 文件存在
    const names = [];
    const seenRel = new Set();
    const svcByName = new Map();   // 文件名 -> 该成员是否需服务（needsService 或 exclusive 为 true）
    const exclByName = new Map();  // 文件名 -> 该成员是否 exclusive
    for (const m of members) {
        if (!isObj(m)) continue;
        const rel = typeof m.rel === 'string' ? m.rel : null;
        const hit = rel === null ? null : REL_RE.exec(rel);
        const needsSvc = m.needsService === true || m.exclusive === true;
        if (m.timeoutMs !== undefined && !needsSvc) add('NOTIMEOUT', hit ? hit[1] : (rel === null ? String(m.label) : rel), `成员 ${JSON.stringify(m.label)} 不需服务却写了 timeoutMs（同步成员没有截止，timeoutMs 被批跑器忽略）`);
        if (hit && !svcByName.has(hit[1])) { svcByName.set(hit[1], needsSvc); exclByName.set(hit[1], m.exclusive === true); }
        if (!hit) { add('REL', rel === null ? String(m.label) : rel, `成员 ${JSON.stringify(m.label)} 的 rel 不是 scripts/<名>.js 形态：${JSON.stringify(m.rel)}`); continue; }
        const name = hit[1];
        names.push(name);
        if (m.label !== name.replace(/\.js$/, '')) add('LABEL', name, `label ${JSON.stringify(m.label)} 应为 ${JSON.stringify(name.replace(/\.js$/, ''))}`);
        if (seenRel.has(rel)) add('REL_DUP', name, `rel ${rel} 重复`); else seenRel.add(rel);
        if (!io.exists(name)) add('MISSING_FILE', name, `成员对应的文件不存在：${name}`);
    }
    for (const name of Object.keys(excluded)) {
        if (!io.exists(name)) add('MISSING_FILE', name, `excluded 对应的文件不存在：${name}`);
        const why = excluded[name];
        if (typeof why !== 'string' || why.trim() === '') add('REASON', name, `excluded 的理由必须是非空白字符串：${name}`);
    }

    // 成员名 ∪ excluded = MIGRATED，且不相交
    const memberSet = new Set(names);
    const excludedSet = new Set(Object.keys(excluded));
    const migSet = new Set(migrated);
    for (const n of migSet) if (!memberSet.has(n) && !excludedSet.has(n)) add('MISSING', n, `登记表 MIGRATED 里有、清单（members 与 excluded）里都没有：${n}`);
    for (const n of memberSet) if (!migSet.has(n)) add('EXTRA', n, `members 里有、登记表 MIGRATED 里没有：${n}`);
    for (const n of excludedSet) if (!migSet.has(n)) add('EXTRA', n, `excluded 里有、登记表 MIGRATED 里没有：${n}`);
    for (const n of memberSet) if (excludedSet.has(n)) add('OVERLAP', n, `同时出现在 members 与 excluded：${n}`);

    // extraEnv：需服务成员（含 exclusive）的源码（注释除外）里出现，必须登记在 envProvidedBy（需服务成员的实例都由批跑器起，变量组形态下 ready() 选项被忽略）
    //   读取失败（文件存在但读不出来，如权限错误）不等于「没有 extraEnv」：单独报 SOURCE_READ（每个文件只读一次、只报一次），其后的 EXTRAENV / ENVSRC_STALE 判断对该文件跳过（避免误导）
    const readCache = new Map();   // 文件名 -> true / false（源码去注释后是否含 extraEnv）/ null（读取失败，已报 SOURCE_READ）
    const codeHasExtraEnv = (name) => {
        if (readCache.has(name)) return readCache.get(name);
        let r;
        try {
            r = hasExtraEnvInCode(io.readSource(name));
        } catch (e) {
            const why = `${e && e.code ? e.code + '：' : ''}${String(e && e.message !== undefined ? e.message : e).split('\n')[0]}`;
            add('SOURCE_READ', name, `文件存在但读取失败，无法判断是否含 extraEnv：${name}（${why}）`);
            r = null;
        }
        readCache.set(name, r);
        return r;
    };
    for (const [name, needsSvc] of svcByName) {
        if (!needsSvc || Object.prototype.hasOwnProperty.call(envProvidedBy, name)) continue;
        if (codeHasExtraEnv(name) === true) add('EXTRAENV', name, `需服务成员的源码里出现 extraEnv（实例由批跑器起，变量组形态下 ready() 选项被忽略，extraEnv 不生效）：${name}——应在 envProvidedBy 登记它需要的环境值怎样进到实例，或去掉 extraEnv`);
    }
    // envProvidedBy 登记硬门：必须是 exclusive 的需服务成员、源码确实含 extraEnv，且理由非空白；不做任何自动推断放行
    //   为什么要求 exclusive：登记理由描述的是「独占实例由批跑器起、环境值来自检出环境 / 批跑器环境」这一情境；共享实例成员同样拿不到 extraEnv，但共享实例上的理由没有被核过，所以登记共享成员一律判红
    for (const name of Object.keys(envProvidedBy)) {
        if (!svcByName.get(name)) add('ENVSRC_STALE', name, `envProvidedBy 登记的不是 members 里需服务的成员：${name}`);
        else if (!exclByName.get(name)) add('ENVSRC_STALE', name, `envProvidedBy 登记的成员非 exclusive（登记只接受 exclusive 成员；共享实例成员不得靠登记放行 extraEnv）：${name}`);
        else if (codeHasExtraEnv(name) === false) add('ENVSRC_STALE', name, `envProvidedBy 登记的成员源码（注释除外）里已没有 extraEnv，登记过期：${name}`);
        const why = envProvidedBy[name];
        if (typeof why !== 'string' || why.trim() === '') add('ENVSRC_REASON', name, `envProvidedBy 的理由必须是非空白字符串：${name}`);
    }
    return { problems, members: nMembers, excluded: nExcluded, envProvidedBy: Object.keys(envProvidedBy).length };
}

function realIo() {
    return {
        exists: (name) => fs.existsSync(path.join(__dirname, name)),
        readSource: (name) => fs.readFileSync(path.join(__dirname, name), 'utf8'),
    };
}

function loadReal() {
    const migrated = Object.keys(require('./lib/test-isolation-registry').MIGRATED);
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8').replace(/^﻿/, '')); } catch (e) { manifest = undefined; return { migrated, manifest, loadError: `读取或解析 ${path.basename(MANIFEST_FILE)} 失败：${e && e.message ? e.message : String(e)}` }; }
    return { migrated, manifest, loadError: null };
}

function runReal(print) {
    const { migrated, manifest, loadError } = loadReal();
    const r = loadError === null ? checkAcceptance(manifest, migrated, realIo()) : { problems: [{ code: 'STRUCT', file: '', msg: loadError }], members: 0, excluded: 0, envProvidedBy: 0 };
    const counts = `members=${r.members} excluded=${r.excluded} envProvidedBy=${r.envProvidedBy === undefined ? 0 : r.envProvidedBy}`;
    if (r.problems.length === 0) { print(`verify-test-acceptance-batch ${counts} PASS`); return 0; }
    for (const p of r.problems) print(`  [${p.code}] ${p.file ? p.file + '：' : ''}${p.msg}`);
    print(`verify-test-acceptance-batch ${counts} FAIL problems=${r.problems.length}`);
    return 1;
}

// ───────────────────────────── 自检 ─────────────────────────────
function selfTest(print) {
    let pass = 0;
    let fail = 0;
    const check = (name, cond, detail) => { if (cond) pass++; else { fail++; print(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`); } };
    const sigs = (r) => r.problems.map((p) => `${p.code}|${p.file}`).sort();
    const want = (...s) => s.slice().sort();
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    // 合成基线：登记表 a / b / c / d；members = a（自起实例，无字段）、b（共享）、d（独占）；excluded = c
    const MIG = ['a.js', 'b.js', 'c.js', 'd.js'];
    const PLAIN = '// plain source\n';
    const mk = () => ({
        manifest: {
            members: [
                { label: 'a', rel: 'scripts/a.js' },
                { label: 'b', rel: 'scripts/b.js', needsService: true, timeoutMs: 1000 },
                { label: 'd', rel: 'scripts/d.js', exclusive: true, resources: ['uploads'] },
            ],
            excluded: { 'c.js': '不进验收批跑的理由' },
        },
        files: { 'a.js': PLAIN, 'b.js': PLAIN, 'c.js': PLAIN, 'd.js': PLAIN },
        mig: MIG.slice(),
    });
    const run = (s) => checkAcceptance(s.manifest, s.mig, { exists: (n) => Object.prototype.hasOwnProperty.call(s.files, n), readSource: (n) => { const v = s.files[n]; if (v instanceof Error) throw v; return v; } });
    const readErr = () => Object.assign(new Error('EACCES: permission denied, open (合成)\n第二行不应出现在证据里'), { code: 'EACCES' });   // 文件存在（exists 为真）但读取抛错

    const good = run(mk());
    check('合法组合判绿（自起实例成员 + 共享成员 + 独占成员 + excluded）', good.problems.length === 0 && good.members === 3 && good.excluded === 1, JSON.stringify(good));

    // extraEnv 的合法形态
    const WITH_ENV = '// x\nconst o = { extraEnv: { A: "1" } };\n';
    const ONLY_COMMENT_ENV = '// 本文件不传 extraEnv\n/* extraEnv 也只是注释 */\nconst o = {};\n';
    { const s = mk(); s.files['a.js'] = WITH_ENV; check('合法：不需服务的成员（自己 ready() 起实例，extraEnv 生效）源码里有 extraEnv', run(s).problems.length === 0, JSON.stringify(run(s).problems)); }
    { const s = mk(); s.files['c.js'] = WITH_ENV; check('合法：excluded 文件源码里有 extraEnv 不查', run(s).problems.length === 0, JSON.stringify(run(s).problems)); }
    { const s = mk(); s.files['d.js'] = ONLY_COMMENT_ENV; s.files['b.js'] = ONLY_COMMENT_ENV; check('合法：需服务成员（独占 / 共享）源码里 extraEnv 只出现在注释里，不算', run(s).problems.length === 0, JSON.stringify(run(s).problems)); }
    { const s = mk(); s.files['d.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'd.js': '该环境值来自检出环境文件白名单键（合成理由）' }; const r = run(s); check('合法：独占成员源码有 extraEnv 且已登记 envProvidedBy', r.problems.length === 0 && r.envProvidedBy === 1, JSON.stringify(r.problems)); }
    { const s = mk(); s.files['b.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'b.js': '合成理由' }; const p = run(s).problems; check('非 exclusive 登记的证据文案写明「非 exclusive」', p.length === 1 && p[0].code === 'ENVSRC_STALE' && p[0].msg.includes('非 exclusive'), JSON.stringify(p)); }
    { const s = mk(); s.files['a.js'] = readErr(); const r = run(s); check('合法：不需服务的成员读取失败 → 不读、不报（它本来就不查 extraEnv）', r.problems.length === 0, JSON.stringify(r.problems)); }
    { const s = mk(); s.files['b.js'] = readErr(); const p = run(s).problems; check('SOURCE_READ 证据带文件名与错误原因（code 与 message 首行，不带第二行）', p.length === 1 && p[0].code === 'SOURCE_READ' && p[0].msg.includes('b.js') && p[0].msg.includes('EACCES') && p[0].msg.includes('permission denied') && !p[0].msg.includes('第二行'), JSON.stringify(p)); }
    { const s = mk(); s.manifest.members[2].timeoutMs = 5000; check('合法：需服务（独占）成员写 timeoutMs', run(s).problems.length === 0, JSON.stringify(run(s).problems)); }
    { const s = mk(); s.manifest.envProvidedBy = {}; check('合法：envProvidedBy 为空对象', run(s).problems.length === 0, JSON.stringify(run(s).problems)); }

    // 违规逐条判红（签名全等：既不漏报，也不多报）
    const cases = [
        ['缺成员：登记了却不在清单里', (s) => { s.manifest.members = s.manifest.members.filter((m) => m.label !== 'b'); }, want('MISSING|b.js')],
        ['缺成员：登记表新增一个键而清单没跟上', (s) => { s.mig.push('e.js'); s.files['e.js'] = PLAIN; }, want('MISSING|e.js')],
        ['多成员：清单里有、登记表没有（members）', (s) => { s.manifest.members.push({ label: 'x', rel: 'scripts/x.js' }); s.files['x.js'] = PLAIN; }, want('EXTRA|x.js')],
        ['多成员：清单里有、登记表没有（excluded）', (s) => { s.manifest.excluded['y.js'] = '理由'; s.files['y.js'] = PLAIN; }, want('EXTRA|y.js')],
        ['重叠：同时在 members 与 excluded', (s) => { s.manifest.excluded['b.js'] = '理由'; }, want('OVERLAP|b.js')],
        ['理由空白：纯空白串', (s) => { s.manifest.excluded['c.js'] = '   \t'; }, want('REASON|c.js')],
        ['理由空白：空串', (s) => { s.manifest.excluded['c.js'] = ''; }, want('REASON|c.js')],
        ['理由空白：不是字符串', (s) => { s.manifest.excluded['c.js'] = 7; }, want('REASON|c.js')],
        ['未知字段（needService 笔误）', (s) => { s.manifest.members[1] = { label: 'b', rel: 'scripts/b.js', needService: true }; }, want('NORMALIZE|')],
        ['字段类型错误（needsService 不是布尔）', (s) => { s.manifest.members[1] = { label: 'b', rel: 'scripts/b.js', needsService: 'yes' }; }, want('NORMALIZE|')],
        ['不需服务却写 resources', (s) => { s.manifest.members[0] = { label: 'a', rel: 'scripts/a.js', resources: ['uploads'] }; }, want('NORMALIZE|')],
        ['rel 与 label 不一致：label 错', (s) => { s.manifest.members[0] = { label: 'zz', rel: 'scripts/a.js' }; }, want('LABEL|a.js')],
        ['rel 形态错：多一层目录', (s) => { s.manifest.members[0] = { label: 'a', rel: 'scripts/sub/a.js' }; }, want('REL|scripts/sub/a.js', 'MISSING|a.js')],
        ['rel 形态错：缺少 scripts/ 前缀', (s) => { s.manifest.members[0] = { label: 'a', rel: 'a.js' }; }, want('REL|a.js', 'MISSING|a.js')],
        ['rel 重复（label 随之重复，规范化也抛错）', (s) => { s.manifest.members.push({ label: 'a', rel: 'scripts/a.js' }); }, want('REL_DUP|a.js', 'NORMALIZE|')],
        ['文件不存在：成员', (s) => { delete s.files['b.js']; }, want('MISSING_FILE|b.js')],
        ['文件不存在：excluded', (s) => { delete s.files['c.js']; }, want('MISSING_FILE|c.js')],
        ['extraEnv 共享成员未登记：needsService 且不独占', (s) => { s.files['b.js'] = WITH_ENV; }, want('EXTRAENV|b.js')],
        ['extraEnv 独占成员未登记', (s) => { s.files['d.js'] = WITH_ENV; }, want('EXTRAENV|d.js')],
        ['extraEnv 独占成员：登记在别的文件名下不算（登记按文件名逐个对；被登记的共享成员另判非 exclusive）', (s) => { s.files['d.js'] = WITH_ENV; s.files['b.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'b.js': '合成理由' }; }, want('EXTRAENV|d.js', 'ENVSRC_STALE|b.js')],
        ['envProvidedBy 登记共享成员（非 exclusive）：源码有 extraEnv 也判红', (s) => { s.files['b.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'b.js': '合成理由' }; }, want('ENVSRC_STALE|b.js')],
        ['envProvidedBy 登记共享成员（非 exclusive）：源码没有 extraEnv 同样只报这一条', (s) => { s.manifest.envProvidedBy = { 'b.js': '合成理由' }; }, want('ENVSRC_STALE|b.js')],
        ['读取失败（文件存在但读不出）：未登记的需服务（共享）成员 → 恰报 SOURCE_READ，不当作没有 extraEnv', (s) => { s.files['b.js'] = readErr(); }, want('SOURCE_READ|b.js')],
        ['读取失败（文件存在但读不出）：未登记的需服务（独占）成员 → 恰报 SOURCE_READ', (s) => { s.files['d.js'] = readErr(); }, want('SOURCE_READ|d.js')],
        ['读取失败（文件存在但读不出）：已登记的 exclusive 成员 → 只报 SOURCE_READ，不再叠加「源码已无 extraEnv」', (s) => { s.files['d.js'] = readErr(); s.manifest.envProvidedBy = { 'd.js': '合成理由' }; }, want('SOURCE_READ|d.js')],
        ['读取失败 + 登记理由空白：各报各的', (s) => { s.files['d.js'] = readErr(); s.manifest.envProvidedBy = { 'd.js': ' ' }; }, want('SOURCE_READ|d.js', 'ENVSRC_REASON|d.js')],
        ['读取失败：两个需服务成员各自读取失败 → 各报一条', (s) => { s.files['b.js'] = readErr(); s.files['d.js'] = readErr(); }, want('SOURCE_READ|b.js', 'SOURCE_READ|d.js')],
        ['extraEnv 解析失败回退全文：语法错误的需服务成员文件里 extraEnv 只在「注释」里，仍按全文判红', (s) => { s.files['b.js'] = '( // extraEnv\n'; }, want('EXTRAENV|b.js')],
        ['envProvidedBy 登记过期：登记的不是成员（excluded 里的文件）', (s) => { s.files['c.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'c.js': '合成理由' }; }, want('ENVSRC_STALE|c.js')],
        ['envProvidedBy 登记过期：登记的文件不在清单里', (s) => { s.manifest.envProvidedBy = { 'zz.js': '合成理由' }; }, want('ENVSRC_STALE|zz.js')],
        ['envProvidedBy 登记过期：登记的成员不需服务', (s) => { s.files['a.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'a.js': '合成理由' }; }, want('ENVSRC_STALE|a.js')],
        ['envProvidedBy 登记过期：源码里已没有 extraEnv', (s) => { s.manifest.envProvidedBy = { 'd.js': '合成理由' }; }, want('ENVSRC_STALE|d.js')],
        ['envProvidedBy 登记过期：extraEnv 只剩在注释里', (s) => { s.files['d.js'] = ONLY_COMMENT_ENV; s.manifest.envProvidedBy = { 'd.js': '合成理由' }; }, want('ENVSRC_STALE|d.js')],
        ['envProvidedBy 理由空白：纯空白', (s) => { s.files['d.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'd.js': '  ' }; }, want('ENVSRC_REASON|d.js')],
        ['envProvidedBy 理由空白：不是字符串', (s) => { s.files['d.js'] = WITH_ENV; s.manifest.envProvidedBy = { 'd.js': 1 }; }, want('ENVSRC_REASON|d.js')],
        ['envProvidedBy 登记过期且理由空白：各报各的', (s) => { s.manifest.envProvidedBy = { 'd.js': '' }; }, want('ENVSRC_STALE|d.js', 'ENVSRC_REASON|d.js')],
        ['结构：envProvidedBy 不是对象', (s) => { s.manifest.envProvidedBy = []; }, want('STRUCT|')],
        ['不需服务的成员写 timeoutMs（没写 needsService）', (s) => { s.manifest.members[0].timeoutMs = 5000; }, want('NOTIMEOUT|a.js')],
        ['不需服务的成员写 timeoutMs（needsService: false）', (s) => { s.manifest.members[0] = { label: 'a', rel: 'scripts/a.js', needsService: false, timeoutMs: 5000 }; }, want('NOTIMEOUT|a.js')],
        ['结构：members 不是数组', (s) => { s.manifest.members = {}; }, want('STRUCT|', 'MISSING|a.js', 'MISSING|b.js', 'MISSING|d.js')],
        ['结构：excluded 是数组', (s) => { s.manifest.excluded = []; }, want('STRUCT|', 'MISSING|c.js')],
        ['结构：缺 excluded', (s) => { delete s.manifest.excluded; }, want('STRUCT|', 'MISSING|c.js')],
    ];
    for (const [name, mut, expect] of cases) {
        const s = mk();
        mut(s);
        const got = sigs(run(s));
        check(`违规判红：${name}`, same(got, expect), `期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(got)}`);
    }
    { const r = checkAcceptance(null, MIG, { exists: () => true, readSource: () => '' }); check('结构：清单不是对象（null）判红', same(sigs(r), want('STRUCT|')), JSON.stringify(r.problems)); }
    { const r = checkAcceptance([], MIG, { exists: () => true, readSource: () => '' }); check('结构：清单是数组判红', same(sigs(r), want('STRUCT|')), JSON.stringify(r.problems)); }
    // 同时出现多种违规：每种各报各的
    {
        const s = mk();
        s.manifest.members = s.manifest.members.filter((m) => m.label !== 'b');
        s.manifest.excluded['c.js'] = ' ';
        s.manifest.excluded['d.js'] = '理由';
        const got = sigs(run(s));
        check('多种违规并存时各报各的（缺 b / 理由空白 c / 重叠 d）', same(got, want('MISSING|b.js', 'REASON|c.js', 'OVERLAP|d.js')), JSON.stringify(got));
    }

    // 对真实清单与登记表跑一遍应为绿
    {
        const { migrated, manifest, loadError } = loadReal();
        const r = loadError === null ? checkAcceptance(manifest, migrated, realIo()) : null;
        check('真实清单与登记表：全绿', r !== null && r.problems.length === 0, loadError || JSON.stringify(r && r.problems.slice(0, 5)));
        check('真实清单：members 与 excluded 之和等于登记表 MIGRATED 键数', r !== null && r.members + r.excluded === migrated.length, JSON.stringify([r && r.members, r && r.excluded, migrated.length]));
        // 真实清单上的 extraEnv 登记：键集合与「需服务且源码（注释除外）含 extraEnv 的成员」全等（独立再算一遍，不复用 checkAcceptance 的内部变量）
        const io = realIo();
        const need = manifest && Array.isArray(manifest.members) ? manifest.members.filter((m) => (m.needsService === true || m.exclusive === true) && hasExtraEnvInCode(io.readSource(m.rel.replace(/^scripts\//, '')))).map((m) => m.rel.replace(/^scripts\//, '')).sort() : null;
        const reg = manifest && isObj(manifest.envProvidedBy) ? Object.keys(manifest.envProvidedBy).sort() : null;
        check('真实清单：envProvidedBy 的键集合 = 需服务且源码（注释除外）含 extraEnv 的成员集合', need !== null && reg !== null && same(need, reg), JSON.stringify({ need, reg }));
    }
    print(`verify-test-acceptance-batch --self-test PASS=${pass} FAIL=${fail}`);
    return fail === 0 ? 0 : 1;
}

if (require.main === module) {
    const print = (line) => console.log(line);
    process.exitCode = process.argv.includes('--self-test') ? selfTest(print) : runReal(print);
}

module.exports = { checkAcceptance };
