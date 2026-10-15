// verify-model-impl-objects.js — #77 C2b-1 实现对象两表 + API + 校验 + 权限 + 请求体上限 + 整组替换（方案 v0.9 §7.1「实现对象完整性与权限」「请求体上限」）
//
// 运行面（自包含、零本机库、零真实外发）：直接复用 verify-model-config-rev-http.js 导出的起服务工具——
//   空库由被测代码自建 → 服务停止时写夹具（含用种子脚本在夹具库里写外部源占位连接）→ 启动服务 → 测试进程只持只读连接；
//   被测服务在临时目录的源码副本里自起，出网拦截 net-guard 同款；不读不写 wbs-server/task_pool.db，不连网。
//   db_connections 的行一律经 HTTP（POST /api/db-connections）或既有种子脚本写入，本文件不含对该表的直写语句（G4 守卫统管）。
//
// 断言期望值全部手写（哈希期望用公开测试向量 sha256('abc')，不从被测代码导入）。
//
// 变异自证（--self-test）：对被测服务的源码副本逐个做破坏性改动（M-1 … M-N），每个变异须使本套件判红且首条失败断言与变异有因果；
//   单个变异：node scripts/verify-model-impl-objects.js --mutation=<id>（只改临时目录里的副本，不改仓库文件）。
//
// 运行：node scripts/verify-model-impl-objects.js        （--tmp=<目录> 或环境变量 MC_C1C_TMP 可指定临时根目录）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const H = require('./verify-model-config-rev-http.js');

const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';   // sha256('abc')，公开测试向量
// 手写常量（用独立工具预先算好，不从被测模块取值）：sha256('v1') / sha256('v2') / sha256('doc-text')
const SHA_V1 = '3bfc269594ef649228e9a74bab00f042efc91d5acc6fbee31a382e80d42388fe';
const SHA_V2 = 'fb04dcb6970e4c3d1873de51fd5a50d7bb46b3383113602665c350ec40b5f990';
const SHA_DOC = '058798218f36d7c3282e589fc9d8fca528a2ba6430963434a3792981cf5959a7';

// ───────────────────────────── 原始 HTTP 助手（自定义头 / 分块 / 声明长度）─────────────────────────────
/** 发一个原始 http 请求；chunks 为要依次写出的 Buffer / 字符串；返回 { status, text } 或 { error } */
function rawHttp(baseUrl, { method, urlPath, headers, chunks, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const u = new URL(baseUrl);
    const req = http.request({ host: u.hostname, port: u.port, method, path: urlPath, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message, code: e.code }));
    (async () => {
      try { for (const c of (chunks || [])) { if (!req.write(c)) await new Promise((r) => req.once('drain', r)); } req.end(); } catch (e) { resolve({ error: e.message }); }
    })();
  });
}
/** 原始 TCP：发送整段字节，读到连接关闭或超时；返回收到的全部文本 */
function rawTcp(port, payload, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const parts = [];
    const done = () => { try { sock.destroy(); } catch (_) { /* ignore */ } resolve(Buffer.concat(parts).toString('utf8')); };
    sock.setTimeout(timeoutMs, done);
    sock.on('data', (d) => parts.push(d));
    sock.on('end', done);
    sock.on('close', done);
    sock.on('error', done);
    sock.write(payload);
  });
}


// ───────────────────────────── 变异表（只改临时目录里的源码副本）─────────────────────────────
const MOD = ['routes', 'model-center', 'impl-objects.js'];
const BS = String.fromCharCode(92);
const MUTATIONS = [
  { id: 'no-mutex', label: 'M-1 去掉模块互斥锁（等锁改成空操作，BEGIN IMMEDIATE 并发撞车）', expectPrefix: 'Y2', file: MOD, from: 'release = await implWriteMutex.acquire(5000);', to: 'release = () => {};' },
  { id: 'links-no-bump', label: 'M-2 挂接集合变化不再 bumpConfigRev', expectPrefix: '挂接集合变化：mA 的 config_rev +1', file: MOD, from: '                    await bumpConfigRev(conn, [modelId]);\n                    const hashOf', to: '                    const hashOf' },
  { id: 'role-bumps', label: 'M-3 role / sort_no 变化也算集合变化（递增）', expectPrefix: '只改 role / sort_no ⇒ 200', file: MOD, from: 'const setChanged = delN > 0 || insN > 0;', to: 'const setChanged = delN > 0 || insN > 0 || kept.some((w) => { const c = curMap.get(w.object_id); return c.role !== w.role || c.sort_no !== w.sort_no; });' },
  { id: 'first-reg-bumps', label: 'M-4 首次登记源码也递增', expectPrefix: '首次登记源码', file: MOD, from: 'if (!isBlank(oldHash) && oldHash !== newHash) {', to: 'if (oldHash !== newHash) {' },
  { id: 'no-415-gate', label: 'M-5 去掉媒体类型硬门（表单 / text/plain 落进全局解析器）', expectPrefix: 'x-www-form-urlencoded', file: ['server.js'], from: "return res.status(415).json({ error: '请求体必须是 application/json', code: 'UNSUPPORTED_MEDIA_TYPE' });", to: 'return next();' },
  { id: 'limit-50mb', label: 'M-6 专用解析器上限改回 50mb', expectPrefix: '请求体上限：分块传输', file: ['server.js'], from: "implBodyGate.use(IMPL_OBJECT_BODY_PATHS, bodyParser.json({ limit: '2.5mb' }));", to: "implBodyGate.use(IMPL_OBJECT_BODY_PATHS, bodyParser.json({ limit: '50mb' }));" },
  { id: 'bytes-as-chars', label: 'M-7 源码上限按字符数而不是 UTF-8 字节数', expectPrefix: '登记源码：349526 个', file: MOD, from: "const bytes = Buffer.byteLength(v, 'utf8');", to: 'const bytes = v.length;' },
  { id: 'ctx-fail-open', label: 'M-8 连接上下文缺失时放行（fail-open）', expectPrefix: 'fail-closed：', file: MOD, from: "ctx.connection === undefined) return fail('CTX_MISSING', 'db_connection_id', '缺少连接行上下文，拒绝（fail-closed）');", to: 'ctx.connection === undefined) return okv(null);' },
  { id: 'external-allowed', label: 'M-9 连接类型校验改成只拒 mysql（外部源占位行放行）', expectPrefix: '连接 type=', file: MOD, from: "if (c.type !== 'sqlserver') return fail(", to: "if (c.type === 'mysql') return fail(" },
  { id: 'model-delete-keeps-links', label: 'M-10 模型软删除后不再删关系', expectPrefix: '模型软删除：该模型的关系行被删除', file: ['server.js'], from: 'implObjectsModule.removeLinksForDeletedModel(model.id)', to: 'Promise.resolve()' },
  { id: 'object-delete-keeps-links', label: 'M-11 对象软删除不再删关系', expectPrefix: '对象软删除 ⇒ 200', file: MOD, from: "await run('DELETE FROM model_impl_links WHERE object_id = ?', [id]);", to: '/* 变异：不删关系 */' },
  { id: 'perm-bypass', label: 'M-12 挂接权限不再校验 canEditModel', expectPrefix: '挂接 403：', file: MOD, from: 'if (!canEditModel(req.user, model)) throw new ApiError(403', to: 'if (false) throw new ApiError(403' },
  { id: 'identity-update-allowed', label: 'M-13 PUT 对象不再拒绝身份字段', expectPrefix: 'PUT summary 400：携带', file: MOD, from: "if (hasOwn(body, k)) return sendError(res, 'summary'", to: "if (false) return sendError(res, 'summary'" },
  { id: 'attach-deleted-object', label: 'M-14 挂接时不再要求对象未删除', expectPrefix: '挂接 400：挂已删除对象', file: MOD, from: 'SELECT id FROM model_impl_objects WHERE is_deleted = 0 AND id IN (', to: 'SELECT id FROM model_impl_objects WHERE id IN (' },
  { id: 'doc-path-escape-allowed', label: 'M-15 doc_path 规范化后越出根目录也放行', expectPrefix: '文档上报 400：doc_path ../x.sql', file: MOD, from: "if (n === '.' || n === '' || n === '..' || n.startsWith('../') || n.startsWith('/')) return fail(", to: 'if (false) return fail(' },
  // ── 修复 1 新增 ──
  { id: 'gate-path-array', label: 'M-16 前置门改回 app 上的绝对路径数组挂法（双斜杠路径绕过 415 / 2.5MB）', expectPrefix: 'W1 双斜杠', edits: [
    { file: ['server.js'], from: "const IMPL_OBJECT_BODY_PATHS = ['/model-impl-objects', '/models/:id/impl-links'];", to: "const IMPL_OBJECT_BODY_PATHS = ['/api/model-impl-objects', '/api/models/:id/impl-links'];" },
    { file: ['server.js'], from: "app.use('/api', implBodyGate);", to: 'app.use(implBodyGate);' }] },
  { id: 'pf-links-no-txn', label: 'PF-1 整组替换不开事务', expectPrefix: 'W3 整组替换失败后', file: MOD, from: "withWriteLock('links', true,", to: "withWriteLock('links', false," },
  { id: 'pf-delete-no-txn', label: 'PF-2 对象软删除不开事务', expectPrefix: 'W3 对象删除失败后', file: MOD, from: "withWriteLock('delete', true,", to: "withWriteLock('delete', false," },
  { id: 'pf-source-no-txn', label: 'PF-2b 登记源码不开事务', expectPrefix: 'W3 源码变化失败后', file: MOD, from: "withWriteLock('source', true,", to: "withWriteLock('source', false," },
  { id: 'pf-no-recheck', label: 'PF-3 去掉锁内模型复核（只信锁外预检）', expectPrefix: 'Y2 PF-3', file: MOD, from: 'const model = await assertEditable();\n                if (wanted.length) {\n                    const ids', to: "const model = await get('SELECT * FROM data_models WHERE id = ?', [modelId]);\n                if (wanted.length) {\n                    const ids" },
  { id: 'restore-no-purge', label: 'M-17 POST restore 前不再清关系', expectPrefix: 'W2 恢复带历史残留关系', file: ['server.js'], from: 'await implObjectsModule.purgeLinksOfModel(modelId, { onlyIfDeleted: true });', to: '/* 变异：不清 */' },
  { id: 'companion-linkable', label: 'M-18 伴生表可挂接', expectPrefix: 'W2 伴生表挂接', file: MOD, from: "if (model.companion_of != null) throw new ApiError(400, 'COMPANION_NOT_LINKABLE'", to: "if (false) throw new ApiError(400, 'COMPANION_NOT_LINKABLE'" },
  { id: 'purge-unconditional', label: 'M-19 purge 的 onlyIfDeleted 条件失效（对存活模型也清）', expectPrefix: 'W2 对已处于恢复状态的模型', file: MOD, from: "sql = 'DELETE FROM model_impl_links WHERE model_id = ? AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND is_deleted = 1)'", to: "sql = 'DELETE FROM model_impl_links WHERE model_id = ? AND ? IS NOT NULL'" },
  { id: 'companion-restore-no-purge', label: 'M-20 companion-restore 前不再清关系', expectPrefix: 'W2 companion-restore', file: ['server.js'], from: 'implObjectsModule.purgeLinksOfModel(existing.id, { onlyIfDeleted: true }).then(() => {', to: 'Promise.resolve().then(() => {' },
  { id: 'cancel-no-purge', label: 'M-21 取消变更追踪不再清伴生表关系', expectPrefix: 'W2 取消变更追踪', file: ['server.js'], from: 'implObjectsModule.purgeLinksOfModel(parentId, { companionsOnly: true })', to: 'Promise.resolve()' },
  { id: 'batch-rollback-uncond', label: 'M-22 模型批量导入改回无条件 ROLLBACK（会滚掉本模块事务）', expectPrefix: 'Y8 静态核对', file: ['server.js'], from: 'console.error("Model batch import error:", e.message);\n        if (transactionActive) {', to: 'console.error("Model batch import error:", e.message);\n        if (true) {' },
  { id: 'begin-busy-unmapped', label: 'M-23 BEGIN 失败不映射成 503 IMPL_TX_BUSY', expectPrefix: 'Y8 他模块先开事务', file: MOD, from: '/within a transaction|SQLITE_BUSY|database is locked/i', to: '/zzz_never_matches/' },
  { id: 'nocase-off', label: 'M-24 身份唯一改回区分大小写（索引与预检都去 NOCASE）', expectPrefix: 'Y9', edits: [
    { file: ['server.js'], from: "IFNULL(schema_name,'') COLLATE NOCASE, obj_name COLLATE NOCASE)", to: "IFNULL(schema_name,''), obj_name)" },
    { file: MOD, from: "IFNULL(?,'') COLLATE NOCASE AND obj_name = ? COLLATE NOCASE", to: "IFNULL(?,'') AND obj_name = ?" }] },
  { id: 'c1-control-off', label: 'M-25 控制字符正则退回只拒 C0 / DEL', expectPrefix: '校验器（L6）', file: MOD, from: 'const CONTROL_RE = /[' + BS + 'u0000-' + BS + 'u001F' + BS + 'u007F-' + BS + 'u009F', to: 'const CONTROL_RE = /[' + BS + 'u0000-' + BS + 'u001F' + BS + 'u007F' },
  { id: 'doc-trailing-slash-off', label: 'M-26 doc_path 不再拒绝以 / 结尾', expectPrefix: 'normalizeDocPath（L1）', file: MOD, from: "if (n.endsWith('/')) return fail(", to: "if (false) return fail(" },
  // ── 修复 2 新增 ──
  // ── 修复 3 新增 ──
  { id: 'doc-bumps', label: 'M-32 文档上报对已挂接模型也递增 config_rev（Y1）', expectPrefix: 'Y1 文档上报不递增', file: MOD, from: "不能上报文档（只限 PROC / VIEW / TRIGGER）`, { field: 'doc_source' });", to: "不能上报文档（只限 PROC / VIEW / TRIGGER）`, { field: 'doc_source' });\n                for (const m of await liveModelsOfObject(id)) { await bumpConfigRev(conn, [m.id]); }" },
  { id: 'links-limit-off', label: 'M-33 去掉 500 条挂接上限（Y4）', expectPrefix: 'Y4 挂接校验器：501 条', file: MOD, from: 'const MAX_LINKS_PER_REPLACE = 500;', to: 'const MAX_LINKS_PER_REPLACE = 100000;' },
  { id: 'creator-branch-off', label: 'M-34 canEditModel 去掉创建者分支（Y5）', expectPrefix: 'Y5 模型创建者', file: ['server.js'], from: 'if (model.created_by_id && user.id && model.created_by_id === user.id) return true;', to: 'if (false) return true;' },
  { id: 'gate-doc-summary-skip', label: 'M-35 请求体媒体类型门放行 /doc 与 PUT /:id（Y6；用 originalUrl 判，router 内 req.path 已被裁剪）', expectPrefix: 'Y6 /doc：x-www-form-urlencoded', file: ['server.js'], from: 'implBodyGate.use(IMPL_OBJECT_BODY_PATHS, (req, res, next) => {', to: 'implBodyGate.use(IMPL_OBJECT_BODY_PATHS, (req, res, next) => {\n    if (req.method === \'PUT\' && /^' + BS + '/api' + BS + '/model-impl-objects' + BS + '/' + BS + 'd+(' + BS + '/doc)?$/.test(req.originalUrl)) return next();' },
  { id: 'account-off', label: 'M-36 转伴生的清理不带记账（X1）', expectPrefix: 'P52 purge-account：目标不是该主表', file: MOD, from: 'if (o.account) {', to: 'if (false) {' },
  { id: 'index-nocase-off', label: 'M-37 唯一索引只去 obj_name 的 NOCASE（Y9）', expectPrefix: 'Y9', file: ['server.js'], from: "IFNULL(schema_name,'') COLLATE NOCASE, obj_name COLLATE NOCASE)", to: "IFNULL(schema_name,'') COLLATE NOCASE, obj_name)" },
  { id: 'v1-block-off', label: 'M-27 去掉「转伴生前阻断有关系的独立模型」', expectPrefix: 'V1 带有效关系', file: ['server.js'], from: 'if (targetRow.is_deleted != 1) {', to: 'if (false) {' },
  { id: 'companion-restore-purge-fail-open', label: 'M-28 companion-restore 清理失败时仍继续恢复（fail-open）', expectPrefix: 'V4 companion-restore 清理关系失败', file: ['server.js'], from: 'implObjectsModule.purgeLinksOfModel(existing.id, { onlyIfDeleted: true }).then(() => {', to: 'implObjectsModule.purgeLinksOfModel(existing.id, { onlyIfDeleted: true }).catch(() => {}).then(() => {' },
  { id: 'rereg-no-purge', label: 'M-29 同名重注册物理删除后不再清关系', expectPrefix: 'V4 同名重注册：旧行已物理删除', file: ['server.js'], from: 'implObjectsModule.purgeLinksOfModel(existingModel.id)', to: 'Promise.resolve()' },
  { id: 'tx-lost-commit-unmapped', label: 'M-30 COMMIT 报 no transaction is active 不映射成 IMPL_TX_LOST', expectPrefix: 'V4 COMMIT', file: MOD, from: 'if (/no transaction is active/i.test(commitErr && commitErr.message)) {', to: 'if (false) {' },
  { id: 'tx-lost-rollback-unmapped', label: 'M-31 ROLLBACK 报 no transaction is active 不映射成 IMPL_TX_LOST', expectPrefix: 'V4 事务体语句失败后', file: MOD, from: 'if (/no transaction is active/i.test(rbErr && rbErr.message)) {', to: 'if (false) {' },
  // ── P52 = C：锁内预检（业务失败全部在 BEGIN 之前）──
  // 「预检挪回事务体」：预检 lambda 改成返回一个函数（预检阶段什么都不检查），事务体开头再执行它——即旧实现的次序 BEGIN → 检查
  { id: 'p52-source-in-tx', label: 'P52-1 登记源码的预检挪回事务体（BEGIN 之后才检查）', expectPrefix: 'P52 source：对象不存在', edits: [
    { file: MOD, from: "withWriteLock('source', true, async (obj) => {", to: "withWriteLock('source', true, async (__pre) => { const obj = await __pre();" },
    { file: MOD, from: "}, async () => {\n                // 锁内预检（BEGIN 之前）：读最新对象行；不存在 404、类型不允许 400", to: "}, async () => async () => {\n                // 锁内预检（BEGIN 之前）：读最新对象行；不存在 404、类型不允许 400" }] },
  { id: 'p52-delete-in-tx', label: 'P52-2 对象软删除的预检挪回事务体', expectPrefix: 'P52 delete：对象不存在', edits: [
    { file: MOD, from: "withWriteLock('delete', true, async (obj) => {", to: "withWriteLock('delete', true, async (__pre) => { const obj = await __pre();" },
    { file: MOD, from: "}, async () => {\n                // 锁内预检（BEGIN 之前）：读最新对象行，不存在 404", to: "}, async () => async () => {\n                // 锁内预检（BEGIN 之前）：读最新对象行，不存在 404" }] },
  { id: 'p52-links-in-tx', label: 'P52-3 整组替换的预检（模型复核 + 对象存在性）挪回事务体', expectPrefix: 'P52 links：OBJECT_NOT_FOUND', edits: [
    { file: MOD, from: "withWriteLock('links', true, async (model) => {", to: "withWriteLock('links', true, async (__pre) => { const model = await __pre();" },
    { file: MOD, from: "}, async () => {\n                // 锁内预检（BEGIN 之前）：按最新的行重做一次", to: "}, async () => async () => {\n                // 锁内预检（BEGIN 之前）：按最新的行重做一次" }] },
  { id: 'p52-purge-in-tx', label: 'P52-4 转伴生清理的目标状态复核挪回事务体（skip 也开事务）', expectPrefix: 'P52 purge-account：目标不是该主表', edits: [
    { file: MOD, from: "withWriteLock('purge-account', true, async (pre) => {", to: "withWriteLock('purge-account', true, async (__pre) => { const pre = await __pre(); if (pre && pre[SKIP_TXN] === true) return pre.value;" },
    { file: MOD, from: "}, async () => {\n                // 锁内预检（BEGIN 之前）：目标状态复核", to: "}, async () => async () => {\n                // 锁内预检（BEGIN 之前）：目标状态复核" }] },
  { id: 'p52-precheck-after-begin', label: 'P52-5 预检失败仍发 BEGIN（预检整体挪到 BEGIN 之后才执行，失败时 ROLLBACK）', expectPrefix: 'P52 source：对象不存在', edits: [
    { file: MOD, from: "                pre = await precheck();", to: "                pre = precheck;" },
    { file: MOD, from: "            const out = await fn(pre);", to: "            const out = await fn(typeof pre === 'function' ? await pre() : pre);" }] },
  // ── P57①（codex 49A-astra HIGH）：写语句自带目标状态条件 ──
  { id: 'p57-purge-no-cond', label: 'P57-1 purge-account 的 DELETE 去掉「目标仍是该主表的未删除伴生表」条件（只信预检）', expectPrefix: 'P57 purge-account 翻转（改回独立模型）：预检通过后目标被改', file: MOD,
    from: "AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND companion_of = ? AND ${liveModelPred('')})`,", to: 'AND ? IS NOT NULL AND ? IS NOT NULL`,' },
  { id: 'p57-links-insert-no-cond', label: 'P57-2 impl-links 的 INSERT 去掉模型状态条件', expectPrefix: 'P57 links 翻转·INSERT（模型被软删除（BEGIN 之后首条写语句之前））：⇒ 409', file: MOD,
    from: "SELECT ?, ?, ?, ?, datetime('now','localtime'), ? WHERE ${MODEL_STATE_OK}`", to: "SELECT ?, ?, ?, ?, datetime('now','localtime'), ? WHERE ? IS NOT NULL`" },
  { id: 'p57-links-delete-no-cond', label: 'P57-3 impl-links 的 DELETE 去掉模型状态条件', expectPrefix: 'P57 links 翻转·DELETE（预检通过后模型被软删除）', file: MOD,
    from: 'WHERE model_id = ? AND object_id = ? AND ${MODEL_STATE_OK}`, [modelId, oid, modelId]', to: 'WHERE model_id = ? AND object_id = ? AND ? IS NOT NULL`, [modelId, oid, modelId]' },
  { id: 'p57-links-update-no-cond', label: 'P57-4 impl-links 的 UPDATE 去掉模型状态条件', expectPrefix: 'P57 links 翻转·UPDATE（预检通过后模型转伴生表）', file: MOD,
    from: 'SET role = ?, sort_no = ? WHERE model_id = ? AND object_id = ? AND ${MODEL_STATE_OK}`', to: 'SET role = ?, sort_no = ? WHERE model_id = ? AND object_id = ? AND ? IS NOT NULL`' },
  { id: 'p57-links-bump-after-changed', label: 'P57-5 模型状态已变但一条都没生效（首条写语句之前翻转）时仍递增 config_rev', expectPrefix: 'P57 links 翻转·INSERT（模型被软删除（BEGIN 之后首条写语句之前））：config_rev 不变', file: MOD,
    from: 'const setChanged = delN > 0 || insN > 0;', to: 'const setChanged = delN > 0 || insN > 0 || stateChanged;' },
  { id: 'p57-links-partial-not-accounted', label: 'P57-5b 模型状态已变时不记账（已生效的部分也不递增、不留痕——旧口径）', expectPrefix: 'P57 links 中途翻转：完整 trace', file: MOD,
    from: 'const setChanged = delN > 0 || insN > 0;', to: 'const setChanged = !stateChanged && (delN > 0 || insN > 0);' },
  { id: 'p57-links-after-from-wanted', label: 'P57-5c 变更日志 after 取请求的 wanted 而不是事务内重读的实际集合', expectPrefix: 'P57 links 中途翻转：变更日志 before = 原集合', file: MOD,
    from: 'snap(finalRows.map((r) => r.object_id)), req.user);', to: 'snap(wanted.map((w) => w.object_id)), req.user);' },
  { id: 'p57-links-rollback-after-changed', label: 'P57-6 模型状态已变（stateChanged）之后改为抛错 ROLLBACK', expectPrefix: 'P57 links 翻转·INSERT（模型被软删除（BEGIN 之后首条写语句之前））：事务 BEGIN,COMMIT', file: MOD,
    from: 'if (stateChanged) return { stateChanged: true, partial: effective > 0, changed: setChanged, links: finalRows };', to: "if (stateChanged) throw new ApiError(409, 'MODEL_STATE_CHANGED', '模型状态已变化（变异：抛错回滚），挂接未保存', { partial: effective > 0 });" },
  { id: 'p57-links-no-stop', label: 'P57-5d 遇 changes = 0 不停止、继续执行后续关系写语句（§8.2：翻转状态保持，后续语句也都 changes 0，只有语句序列暴露）', expectPrefix: 'P57 links 中途翻转：完整 trace', file: MOD,
    from: 'if (r.changes === 0) { stateChanged = true; return false; }', to: 'if (r.changes === 0) { stateChanged = true; return true; }' },
  { id: 'p57-links-partial-by-setchanged', label: 'P57-5e 409 的 partial 改按 setChanged（关系集合变了）计，而不是按「有语句生效」计（§8.2：只改 role 的 UPDATE 生效后翻转）', expectPrefix: 'P57 links UPDATE 生效后翻转（只改 role，后续 INSERT 被挡）：⇒ 409', file: MOD,
    from: 'partial: effective > 0, changed: setChanged', to: 'partial: setChanged, changed: setChanged' },
  { id: 'p57-links-msg-not-partial', label: 'P57-5f 409 文案不按 partial 区分（部分生效时仍说「挂接未保存」，codex 50A LOW）', expectPrefix: 'P57 links 中途翻转：部分生效时文案', file: MOD,
    from: "out.partial ? '模型状态已变化（已删除或已转为伴生表），部分挂接变更已生效，请刷新后查看' : '模型状态已变化（已删除或已转为伴生表），挂接未保存，请刷新后重试',", to: "'模型状态已变化（已删除或已转为伴生表），挂接未保存，请刷新后重试'," },
  { id: 'p57-state-null-dead', label: 'P57-8 存活谓词改回只认 is_deleted = 0（NULL 被当成已删，与读取口径不一致）', expectPrefix: 'P57 NULL is_deleted·links', file: MOD,
    from: 'const liveModelPred = (prefix) => `(${prefix}is_deleted = 0 OR ${prefix}is_deleted IS NULL)`;', to: 'const liveModelPred = (prefix) => `(${prefix}is_deleted = 0)`;' },
  { id: 'p57-remove-links-no-cond', label: 'P57-9 removeLinksForDeletedModel 的 DELETE 去掉「此刻确为已删除」条件', expectPrefix: 'P57 removeLinksForDeletedModel 排队期间模型被恢复', file: MOD,
    from: '(model_id = ? AND EXISTS (SELECT 1 FROM data_models WHERE id = ? AND is_deleted = 1))', to: '(model_id = ? AND ? IS NOT NULL)' },
  { id: 'p57-invariant-source-no-throw', label: 'P57-10 登记源码的 IMPL_INVARIANT 抛出被删掉', expectPrefix: 'P57 IMPL_INVARIANT·source', file: MOD,
    from: "if (r.changes === 0) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在更新时已不存在", to: "if (false) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在更新时已不存在" },
  { id: 'p57-invariant-source-404', label: 'P57-10b 登记源码的 IMPL_INVARIANT 状态码改成 404', expectPrefix: 'P57 IMPL_INVARIANT·source', file: MOD,
    from: "throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在更新时已不存在", to: "throw new ApiError(404, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在更新时已不存在" },
  { id: 'p57-invariant-delete-no-throw', label: 'P57-11 对象软删除的 IMPL_INVARIANT 抛出被删掉', expectPrefix: 'P57 IMPL_INVARIANT·delete', file: MOD,
    from: "if (r.changes === 0) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在软删除时已不存在", to: "if (false) throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在软删除时已不存在" },
  { id: 'p57-invariant-delete-404', label: 'P57-11b 对象软删除的 IMPL_INVARIANT 状态码改成 404', expectPrefix: 'P57 IMPL_INVARIANT·delete', file: MOD,
    from: "throw new ApiError(500, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在软删除时已不存在", to: "throw new ApiError(404, 'IMPL_INVARIANT', '内部不变量被破坏：锁内预检读到的实现对象在软删除时已不存在" },
  { id: 'p57-links-409-to-200', label: 'P57-7 模型状态已变时路由不返回 409（落回 200）', expectPrefix: 'P57 links 翻转·INSERT（模型被软删除（BEGIN 之后首条写语句之前））：⇒ 409', file: MOD,
    from: 'if (out.stateChanged === true) {', to: 'if (false) {' },
];
const mutArg = process.argv.find((x) => x.startsWith('--mutation='));
const MUTATION = mutArg ? MUTATIONS.find((m) => m.id === mutArg.slice('--mutation='.length)) : null;
if (mutArg && !MUTATION) { console.log('FAIL 未知变异：' + mutArg); process.exit(1); }

/** --self-test：逐个变异起子进程跑本套件，须判红且「首条」FAIL 断言以 expectPrefix 开头（严格因果判据，不是「存在」） */
function selfTest() {
  let pass = 0, fail = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [__filename, '--mutation=' + m.id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.signal) { fail++; console.log('FAIL 变异 ' + m.label + '：超时或被杀（' + ((r.error && r.error.code) || r.signal) + '），不计为判红'); continue; }
    const out = (r.stdout || '') + (r.stderr || '');
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL '));
    const causal = fails.length > 0 && fails[0].startsWith('FAIL ' + m.expectPrefix) ? [fails[0]] : [];   // Y3：首条失败必须就是预期断言（不是「存在」）
    if (r.status !== 0 && causal.length > 0) { pass++; console.log('  变异 ' + m.label + ' → 判红（' + fails.length + ' 条失败；首条因果断言：' + causal[0].slice(0, 200) + '）'); }
    else { fail++; console.log('FAIL 变异 ' + m.label + '：' + (r.status === 0 ? '没有任何断言变红' : '变红了但首条失败不是预期的「' + m.expectPrefix + '」类断言：' + (fails[0] || out.slice(-300)).slice(0, 200))); }
  }
  console.log('verify-model-impl-objects --self-test PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
}

async function main() {
  if (!process.env.JWT_SECRET || !process.env.DB_ENCRYPTION_KEY) { console.log('FAIL 缺少 JWT_SECRET / DB_ENCRYPTION_KEY（读自 wbs-server/.env）'); process.exit(1); }
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`); } };

  // 被测代码一律取「临时目录里的源码副本」（变异只改副本）：纯函数校验器也从副本加载，变异对它同样生效
  const runDir = H.makeRunDir('impl');
  const { copyRoot } = H.copyCode(H.ROOT, path.join(runDir, 'svc'), 'after');
  if (MUTATION) for (const e of (MUTATION.edits || [MUTATION])) H.replaceExactlyOnce(path.join(copyRoot, ...e.file), e.from, e.to, MUTATION.label);
  process.env.NODE_PATH = path.join(H.ROOT, 'node_modules');   // 副本在临时目录里，依赖（express）经 NODE_PATH 解析（与被测服务进程同做法）
  require('node:module')._initPaths();
  const V = require(path.join(copyRoot, 'routes', 'model-center', 'impl-objects.js')).validators;

  // ═════════ 一、纯函数校验器（无服务；ctx 缺失一律 fail-closed）═════════
  {
    const base = { obj_type: 'PROC', db_connection_id: 7, schema_name: 'dbo', obj_name: 'usp_a' };
    const f = V.validateObjectFields(base);
    check('校验器：PROC 合法字段通过', f.ok === true && f.value.schema_name === 'dbo' && f.value.db_connection_id === 7, JSON.stringify(f));
    for (const [label, ctx] of [['ctx 为 undefined', undefined], ['ctx 为空对象', {}], ['ctx.connection 为 undefined', { connection: undefined }], ['ctx 为 null', null]]) {
      const r = V.validateObjectInput(base, ctx);
      check(`fail-closed：${label} ⇒ CTX_MISSING（不是「给了才校验」）`, r.ok === false && r.code === 'CTX_MISSING', JSON.stringify(r));
    }
    let r = V.validateObjectInput(base, { connection: null });
    check('连接行为 null（查无此行）⇒ DB_CONNECTION_NOT_FOUND', r.ok === false && r.code === 'DB_CONNECTION_NOT_FOUND', JSON.stringify(r));
    for (const ty of ['external', 'mysql', 'SQLSERVER', '', null]) {
      r = V.validateObjectInput(base, { connection: { id: 7, type: ty } });
      check(`连接 type=${JSON.stringify(ty)} ⇒ DB_CONNECTION_TYPE_NOT_ALLOWED`, r.ok === false && r.code === 'DB_CONNECTION_TYPE_NOT_ALLOWED', JSON.stringify(r));
    }
    r = V.validateObjectInput(base, { connection: { id: 8, type: 'sqlserver' } });
    check('连接行 id 与请求不一致 ⇒ 判失败', r.ok === false && r.code === 'DB_CONNECTION_NOT_FOUND', JSON.stringify(r));
    r = V.validateObjectInput(base, { connection: { id: 7, type: 'sqlserver' } });
    check('连接行 sqlserver 且 id 一致 ⇒ 通过', r.ok === true, JSON.stringify(r));
    r = V.validateObjectInput({ obj_type: 'FDL_TASK', obj_name: '日清任务' }, undefined);
    check('FDL_TASK 不需要连接上下文 ⇒ 通过（无连接可校验）', r.ok === true && r.value.db_connection_id === null, JSON.stringify(r));
    r = V.validateObjectInput({ obj_type: 'TRIGGER', db_connection_id: 7, schema_name: null, obj_name: 'trg_db' }, { connection: { id: 7, type: 'sqlserver' } });
    check('库级触发器：TRIGGER 且 schema_name 为空 ⇒ 允许', r.ok === true && r.value.schema_name === null, JSON.stringify(r));
    r = V.validateObjectFields({ obj_type: 'VIEW', db_connection_id: 7, schema_name: '', obj_name: 'v_a' });
    check('VIEW 的 schema_name 为空 ⇒ 拒绝（空 schema 只对 TRIGGER 放行）', r.ok === false && r.code === 'FIELD_COMBINATION_INVALID', JSON.stringify(r));
    r = V.validateLinksInput({ links: [{ object_id: 1, role: 'a' }, { object_id: 1, role: 'b' }] });
    check('挂接校验器：同一请求内 object_id 重复 ⇒ DUPLICATE_OBJECT_ID', r.ok === false && r.code === 'DUPLICATE_OBJECT_ID', JSON.stringify(r));
    r = V.validateLinksInput({ links: [{ object_id: 1, role: 'a' }] });
    check('挂接校验器：sort_no 缺省 ⇒ 0', r.ok === true && r.value[0].sort_no === 0, JSON.stringify(r));
    {
      const over = V.validateLinksInput({ links: Array.from({ length: 501 }, (_, i) => ({ object_id: i + 1, role: 'r' })) });
      check('Y4 挂接校验器：501 条 ⇒ INVALID_BODY，field = links，消息点名 500 上限', over.ok === false && over.code === 'INVALID_BODY' && over.field === 'links' && /500/.test(over.message), JSON.stringify(over));
      check('Y4 挂接校验器：恰 500 条（合法）⇒ 通过', V.validateLinksInput({ links: Array.from({ length: 500 }, (_, i) => ({ object_id: i + 1, role: 'r' })) }).ok === true);
    }
    check('normHash 公开向量：norm_v1 对不含需规范化内容的 "abc" 等于 sha256("abc")', V.normHash('abc') === SHA_ABC, V.normHash('abc'));
    check('normalizeDocPath：a/../b.sql ⇒ b.sql；a\\b\\c.sql ⇒ a/b/c.sql', V.normalizeDocPath('a/../b.sql').value === 'b.sql' && V.normalizeDocPath('a\\b\\c.sql').value === 'a/b/c.sql');
    check('normalizeDocPath（L1）：首尾空白 / 以 / 结尾 ⇒ 拒绝', V.normalizeDocPath(' a.sql').ok === false && V.normalizeDocPath('a.sql ').ok === false && V.normalizeDocPath('a/b/').ok === false);
    check('校验器（L6）：C1 控制符 / 双向控制符 / U+2028 在 obj_name、role 里被拒；summary 仍允许 LF', V.validateObjectFields({ obj_type: 'FDL_TASK', obj_name: 'a' + String.fromCharCode(0x85) + 'b' }).ok === false
      && V.validateRole('a' + String.fromCharCode(0x202e)).ok === false && V.validateRole('a' + String.fromCharCode(0x2028)).ok === false
      && V.validateSummary('a\nb').ok === true && V.validateSummary('a' + String.fromCharCode(0x2066)).ok === false);
  }

  // Y8 静态核对：两个批量导入的 catch 必须是「BEGIN 成功才 ROLLBACK」（BEGIN 撞上他模块事务失败时无条件 ROLLBACK 会滚掉本模块的事务）。
  //   这条性质不依赖时序：直接核副本里 server.js 两个处理器的源码
  {
    const srvText = fs.readFileSync(path.join(copyRoot, 'server.js'), 'utf8');
    for (const [label, startMark] of [['POST /api/create/batch', "app.post('/api/create/batch'"], ['POST /api/models/batch', "app.post('/api/models/batch'"]]) {
      const a = srvText.indexOf(startMark); const b = srvText.indexOf('\napp.', a + 10);
      const seg = a >= 0 ? srvText.slice(a, b > a ? b : undefined) : '';
      check(`Y8 静态核对：${label} 的 catch 为「if (transactionActive) { try { ROLLBACK … } }」（BEGIN 成功才 ROLLBACK）`, a >= 0 && /let transactionActive = false;/.test(seg) && /if \(transactionActive\) \{\s*try \{ await dbRunAsync\("ROLLBACK"\)/.test(seg), seg.slice(-300));
    }
  }

  // ═════════ 二、起服务 ═════════
  const dbPath = path.join(runDir, 'fixture.db');
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const svc = H.makeService({ copyRoot, dbPath, tag: 'svc', gate });
  const api = H.makeApi(() => svc.baseUrl);
  let rd = null;
  try {
    await H.createFreshDb(svc);
    // 外部源占位行：用既有种子脚本写进夹具库（服务已停止；TARGET_DB 与 --allow-db-override 成对出现）。本文件不直写 db_connections。
    const seed = spawnSync(process.execPath, [path.join(__dirname, '_seed-collab-external-source.js'), '--apply', '--allow-db-override'], {
      encoding: 'utf8', env: { ...process.env, TARGET_DB: dbPath }, timeout: 30000,
    });
    check('夹具：种子脚本在夹具库写入外部源占位连接（RESULT=CREATED）', seed.status === 0 && /RESULT=CREATED/.test(seed.stdout || ''), `status=${seed.status} out=${(seed.stdout || '').slice(-300)} err=${(seed.stderr || '').slice(-300)}`);

    const w = await H.openWriter(dbPath, gate);
    const fx = H.makeFixtures(w);
    let creator, mCr, admin, owner, other, viewer, mA, mB, mDel, mCc, mS1, mS2, mDelTest, mParent, mComp, mLinkRole, oDirty;
    let v1, v4, mRe, oRe, x1;
    let mHist, oHist, mFail, oFail, mAlive, oPhys, mTx, mTxY, mTT, mTU, oTx1, oTx2, oTxSrc, cmp, oComp, mBig1, mBig2, mRace, mBatch, mBatch2;
    try {
      await w.get('PRAGMA journal_mode = WAL');
      admin = await fx.user('mc_admin', 'admin');
      owner = await fx.user('mc_owner', 'user');
      other = await fx.user('mc_other', 'user');
      viewer = await fx.user('mc_viewer', 'viewer');
      creator = await fx.user('mc_creator', 'user');
      const own = { created_by_id: 900001 };   // 不等于任何夹具用户 id，避免 canEditModel 的「创建者」分支误放行
      mA = await fx.model({ ...own, tech_owner: owner.display_name });
      mB = await fx.model({ ...own, tech_owner: 'mc_someone_else' });
      mCr = await fx.model({ created_by_id: creator.id, tech_owner: 'mc_someone_else' });   // Y5：创建者 = 实际测试用户（非技术负责人）
      mDel = await fx.model({ ...own, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });
      mCc = await fx.model({ ...own });
      mS1 = await fx.model({ ...own });
      mS2 = await fx.model({ ...own });
      mDelTest = await fx.model({ ...own });
      mParent = await fx.model({ ...own, layer: 'DWD' });
      mComp = await fx.model({ ...own, layer: 'DWD', config_mode: 'companion', companion_of: mParent });
      mLinkRole = await fx.model({ ...own });
      // 历史脏关系夹具：对象存在、其唯一关系指向已删除模型 mDel（读取一律过滤，该对象应算「未归属」）
      oDirty = (await w.run(`INSERT INTO model_impl_objects (obj_type, obj_name, is_deleted, created_at, updated_at, created_by, updated_by)
                             VALUES ('FDL_TASK', 'mc_dirty_fdl', 0, datetime('now','localtime'), datetime('now','localtime'), 'fx', 'fx')`)).lastID;
      await w.run(`INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?, ?, '历史脏关系', 0, datetime('now','localtime'), 'fx')`, [mDel, oDirty]);
      // ── 修复 1 夹具（服务停止期间一次性写好；全部直写表，绕过 API 校验以模拟「历史数据 / 失败注入」）──
      const fxObj = async (name, o) => (await w.run(`INSERT INTO model_impl_objects (obj_type, obj_name, reg_source, reg_hash, hash_algo, is_deleted, created_at, updated_at, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, 0, datetime('now','localtime'), datetime('now','localtime'), 'fx', 'fx')`,
        [(o && o.type) || 'FDL_TASK', `${name}_${Date.now().toString(36)}`, (o && o.src) || null, (o && o.src) ? require('node:crypto').createHash('sha256').update(o.src).digest('hex') : null, (o && o.src) ? 'norm_v1' : null])).lastID;
      const fxLink = (mid, oid, role) => w.run(`INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?, ?, ?, 0, datetime('now','localtime'), 'fx')`, [mid, oid, role || '夹具']);
      mHist = await fx.model({ ...own, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });     // 历史脏关系 + 恢复必须清掉
      oHist = await fxObj('mc_hist'); await fxLink(mHist, oHist, '历史残留');
      mFail = await fx.model({ ...own, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });     // 清理失败（注入）时恢复必须被拒
      oFail = await fxObj('mc_failpurge'); await fxLink(mFail, oFail, '历史残留');
      await w.run(`CREATE TRIGGER pf_purge_fail BEFORE DELETE ON model_impl_links WHEN OLD.model_id = ${mFail} BEGIN SELECT RAISE(ABORT, 'pf-purge-inject'); END`);
      mAlive = await fx.model({ ...own });                                                        // 已处于恢复状态的模型：重复 restore 不得清掉其有效关系
      oPhys = await fxObj('mc_phys'); await fxLink(99999999, oPhys, '指向物理不存在的模型');          // L4
      // 事务原子性注入：变更日志 INSERT 对这些模型失败（模拟事务体中途出错）
      mTx = await fx.model({ ...own }); mTxY = await fx.model({ ...own }); mTT = await fx.model({ ...own }); mTU = await fx.model({ ...own });
      oTx1 = await fxObj('mc_tx1'); oTx2 = await fxObj('mc_tx2'); await fxLink(mTx, oTx1, '原有');
      oTxSrc = await fxObj('mc_txsrc', { type: 'PROC', src: 'v1' }); await fxLink(mTT, oTxSrc, '主'); await fxLink(mTU, oTxSrc, '备');
      await w.run(`CREATE TRIGGER pf_log_fail BEFORE INSERT ON model_change_logs WHEN NEW.change_type = 'impl_object' AND NEW.model_id IN (${mTx}, ${mTT}) BEGIN SELECT RAISE(ABORT, 'pf-log-inject'); END`);
      // 伴生表：恢复 / 取消追踪路径上残留关系不得复活（P2→C2 走 companion-restore；P3→C3 先取消追踪再重新勾选）
      const cfgOn = (name) => ({ version: 1, dwdConfig: { changeTracking: { enabled: true, changeTableName: name } } });
      const cfgOff = (name) => ({ version: 1, dwdConfig: { changeTracking: { enabled: false, changeTableName: name } } });
      cmp = {};
      for (const [k, enabled, compDeleted] of [['p2', false, true], ['p3', true, false]]) {
        const chg = fx.nextName(`chg_${k}`);
        const p = await fx.model({ ...own, layer: 'DWD', dim_config: enabled ? cfgOn(chg) : cfgOff(chg) });
        const c = await fx.model({ ...own, layer: 'DWD', table_name: chg, config_mode: 'companion', companion_of: p, ...(compDeleted ? { is_deleted: 1, deleted_at: '2026-01-01 00:00:00' } : {}) });
        const o = await fxObj(`mc_comp_${k}`); await fxLink(c, o, '历史残留');
        cmp[k] = { p, c, o, chg, cfgOn: cfgOn(chg), cfgOff: cfgOff(chg) };
      }
      // 伴生表历史关系（原 mComp 经 API 挂接的用例改为夹具直写：伴生表现已禁止挂接）
      oComp = await fxObj('mc_comp_hist'); await fxLink(mComp, oComp, '伴生表历史关系');
      // PF-3 竞态与大集合
      mBig1 = await fx.model({ ...own }); mBig2 = await fx.model({ ...own }); mRace = await fx.model({ ...own, tech_owner: owner.display_name });
      mBatch = await fx.model({ ...own }); mBatch2 = await fx.model({ ...own });
      // X1 夹具：独立模型 tX 的表名恰是主表 pX 的伴生表名，tX 此刻没有关系（预检放行）；触发器在「tX 被转成伴生表」的同一条 UPDATE 里写入一条关系，
      //   模拟「预检与转换之间被并发挂接」的窗口——转换后的带记账清理必须把它清掉、config_rev +1、留一条 impl_object 日志
      {
        const chgX = fx.nextName('chg_x1');
        const pX = await fx.model({ ...own, layer: 'DWD', dim_config: cfgOff(chgX) });
        const tX = await fx.model({ ...own, layer: 'DWD', table_name: chgX, config_mode: 'standard' });
        const oX = await fxObj('mc_x1');
        await w.run(`CREATE TRIGGER pf_race_link AFTER UPDATE OF companion_of ON data_models WHEN NEW.id = ${tX} AND OLD.companion_of IS NULL AND NEW.companion_of IS NOT NULL
          BEGIN INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (${tX}, ${oX}, '并发窗口写入', 0, datetime('now','localtime'), 'fx'); END`);
        x1 = { pX, tX, oX, cfgOn: cfgOn(chgX) };
      }
      // 修复 2 夹具
      //   V1：独立模型 tV（有 1 条有效关系）的表名恰是主表 pV 的伴生表名 ⇒ 启用追踪会把 tV 转成伴生表
      {
        const chgV = fx.nextName('chg_v1');
        const pV = await fx.model({ ...own, layer: 'DWD', dim_config: cfgOff(chgV) });
        const tV = await fx.model({ ...own, layer: 'DWD', table_name: chgV, config_mode: 'standard' });
        const oV = await fxObj('mc_v1'); await fxLink(tV, oV, '独立模型的关系');
        v1 = { pV, tV, oV, cfgOn: cfgOn(chgV) };
      }
      //   V4：companion-restore 清理失败（触发器注入）⇒ 跳过恢复
      {
        const chg4 = fx.nextName('chg_v4');
        const p4 = await fx.model({ ...own, layer: 'DWD', dim_config: cfgOff(chg4) });
        const c4 = await fx.model({ ...own, layer: 'DWD', table_name: chg4, config_mode: 'companion', companion_of: p4, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });
        const o4 = await fxObj('mc_v4'); await fxLink(c4, o4, '历史残留');
        await w.run(`CREATE TRIGGER pf_purge_fail_c4 BEFORE DELETE ON model_impl_links WHEN OLD.model_id = ${c4} BEGIN SELECT RAISE(ABORT, 'pf-purge-inject-c4'); END`);
        v4 = { p4, c4, o4, cfgOn: cfgOn(chg4) };
      }
      //   V4：同名重注册——已软删除的旧模型带历史关系，重注册物理删除旧行后其关系不得残留
      mRe = await fx.model({ ...own, is_deleted: 1, deleted_at: '2026-01-01 00:00:00' });
      oRe = await fxObj('mc_re'); await fxLink(mRe, oRe, '历史残留');
      await w.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await w.close(); }
    await svc.start();
    rd = await H.openReader(dbPath);

    // Y9：直接读 sqlite_master，唯一索引存在，且 schema_name / obj_name 带 COLLATE NOCASE、只管未删除行。
    //   注意：下面「并发同身份新建」用例只覆盖单进程（创建路径持模块级互斥锁，即使索引被删它也能得到 1×200 + 其余 409）；
    //   跨进程 / 跨实例下的唯一性靠这条索引本身，故在此直接核索引定义。
    {
      const idx = await rd.get("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_impl_obj_identity'");
      const sql = (idx && idx.sql) || '';
      // C2b-2（codex 25-R LOW）：改用 PRAGMA index_xinfo 精确断言列、顺序、排序规则；表达式列的 name 为 NULL（cid = -2），其文本从 sqlite_master.sql 取
      const xinfo = await rd.all("PRAGMA index_xinfo('idx_impl_obj_identity')");
      const keyCols = xinfo.filter((c) => c.key === 1).map((c) => ({ seqno: c.seqno, cid_kind: c.cid >= 0 ? 'column' : 'expr', name: c.name, coll: c.coll, desc: c.desc }));
      const wantCols = [
        { seqno: 0, cid_kind: 'column', name: 'obj_type', coll: 'BINARY', desc: 0 },
        { seqno: 1, cid_kind: 'expr', name: null, coll: 'BINARY', desc: 0 },       // IFNULL(db_connection_id,0)
        { seqno: 2, cid_kind: 'expr', name: null, coll: 'NOCASE', desc: 0 },       // IFNULL(schema_name,'') COLLATE NOCASE
        { seqno: 3, cid_kind: 'column', name: 'obj_name', coll: 'NOCASE', desc: 0 },
      ];
      check('Y9 唯一索引 idx_impl_obj_identity：index_xinfo 的键列恰为 4 列、顺序 obj_type / 表达式 / 表达式 / obj_name，排序规则 BINARY / BINARY / NOCASE / NOCASE，均升序',
        JSON.stringify(keyCols) === JSON.stringify(wantCols), JSON.stringify(xinfo));
      const m = /^CREATE UNIQUE INDEX\s+idx_impl_obj_identity\s+ON\s+model_impl_objects\s*\(([\s\S]*)\)\s+WHERE\s+([\s\S]+)$/i.exec(sql.trim());
      const splitTop = (s) => { const out = []; let depth = 0; let cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } out.push(cur.trim()); return out; };
      const colTexts = m ? splitTop(m[1]).map((t) => t.replace(/\s+/g, ' ')) : [];
      check('Y9 唯一索引：sqlite_master 里的列文本逐项等于期望（含两个表达式的 IFNULL 与 COLLATE NOCASE 写法）', JSON.stringify(colTexts) === JSON.stringify(['obj_type', 'IFNULL(db_connection_id,0)', "IFNULL(schema_name,'') COLLATE NOCASE", 'obj_name COLLATE NOCASE']), JSON.stringify(colTexts));
      check('Y9 唯一索引：是 UNIQUE 索引，部分索引谓词（取自 sqlite_master.sql）恰为 is_deleted = 0', !!m && m[2].replace(/\s+/g, ' ').trim() === 'is_deleted = 0', sql);
    }
    // ─────────── 通用助手 ───────────
    const adm = admin.token;
    const call = (token, method, p, body) => api(method, p, { token, body });
    const rev = async (id) => (await rd.get('SELECT config_rev FROM data_models WHERE id = ?', [id])).config_rev;
    const objRow = (id) => rd.get('SELECT * FROM model_impl_objects WHERE id = ?', [id]);
    const linkRows = (mid) => rd.all('SELECT object_id, role, sort_no, created_by FROM model_impl_links WHERE model_id = ? ORDER BY object_id', [mid]);
    const countAll = async () => ({
      objs: (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects')).c,
      links: (await rd.get('SELECT COUNT(*) AS c FROM model_impl_links')).c,
      logs: (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object'")).c,
    });
    let nameSeq = 0;
    const uniq = (p) => `${p}_${Date.now().toString(36)}_${++nameSeq}`;
    const mkObj = async (b, token = adm) => call(token, 'POST', '/api/model-impl-objects', b);
    const mkFdl = async (name) => { const r = await mkObj({ obj_type: 'FDL_TASK', obj_name: name || uniq('fdl') }); if (r.status !== 200) throw new Error('夹具建对象失败：' + JSON.stringify(r.json || r.text)); return r.json.id; };

    // 三种连接：sqlserver / mysql 经 HTTP 创建；外部源占位行来自种子脚本
    let r = await call(adm, 'POST', '/api/db-connections', { name: uniq('mc_sql'), type: 'sqlserver', host: 'mc-host.invalid', database: 'mc_db', username: 'u', password: 'p' });
    check('夹具：POST /api/db-connections 创建 sqlserver 连接', r.status === 200 && Number.isInteger(r.json && r.json.id), JSON.stringify(r.json || r.text));
    const cSql = r.json.id;
    r = await call(adm, 'POST', '/api/db-connections', { name: uniq('mc_my'), type: 'mysql', host: 'mc-host.invalid', database: 'mc_db', username: 'u', password: 'p' });
    const cMy = r.json && r.json.id;
    check('夹具：POST /api/db-connections 创建 mysql 连接', r.status === 200 && Number.isInteger(cMy), JSON.stringify(r.json || r.text));
    const extRow = await rd.get("SELECT id FROM db_connections WHERE type = 'external'");
    check('夹具：夹具库里有外部源占位行（type = external）', !!extRow, JSON.stringify(extRow));
    const cExt = extRow && extRow.id;

    // ═════════ 三、对象新建：校验 / 唯一 / 权限 ═════════
    const pName = uniq('usp');
    r = await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: pName, summary: '  第一行\n第二行  ' });
    check('新建 PROC ⇒ 200 并给出 id', r.status === 200 && Number.isInteger(r.json && r.json.id), JSON.stringify(r.json || r.text));
    const oProc = r.json.id;
    let row = await objRow(oProc);
    check('新建 PROC：字段落库（summary 已 trim，换行保留；is_deleted=0；created_by 为操作者名；reg 相关列为空）',
      row && row.obj_type === 'PROC' && row.db_connection_id === cSql && row.schema_name === 'dbo' && row.obj_name === pName && row.summary === '第一行\n第二行'
      && row.is_deleted === 0 && row.created_by === admin.display_name && row.reg_source == null && row.reg_hash == null && row.hash_algo == null && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.created_at), JSON.stringify(row));
    r = await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: pName });
    check('身份唯一冲突（同类型 + 连接 + schema + 名称）⇒ 409 OBJECT_IDENTITY_CONFLICT，带已存在 id', r.status === 409 && r.json && r.json.code === 'OBJECT_IDENTITY_CONFLICT' && r.json.existing_id === oProc, JSON.stringify(r.json || r.text));
    check('冲突请求零写入：对象行数不变', (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ?', [pName])).c === 1);
    r = await mkObj({ obj_type: 'VIEW', db_connection_id: cSql, schema_name: 'dbo', obj_name: pName });
    check('同名但类型不同（VIEW）⇒ 200（身份含 obj_type）', r.status === 200, JSON.stringify(r.json || r.text));
    const oView = r.json.id;
    r = await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'etl', obj_name: pName });
    check('同名但 schema 不同 ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    const tName = uniq('trg_db');
    r = await mkObj({ obj_type: 'TRIGGER', db_connection_id: cSql, schema_name: null, obj_name: tName });
    check('库级触发器：TRIGGER + schema_name 为 null ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    const oTrigDb = r.json && r.json.id;
    row = oTrigDb ? await objRow(oTrigDb) : null;
    check('库级触发器：schema_name 落库为 NULL', row && row.schema_name === null, JSON.stringify(row));
    r = await mkObj({ obj_type: 'TRIGGER', db_connection_id: cSql, schema_name: '', obj_name: tName });
    check('同一库级触发器再建（schema 传空串，规范为 NULL）⇒ 409（唯一索引 IFNULL 口径）', r.status === 409, JSON.stringify(r.json || r.text));
    r = await mkObj({ obj_type: 'TRIGGER', db_connection_id: cSql, schema_name: 'dbo', obj_name: uniq('trg_tbl') });
    check('表级触发器 TRIGGER + schema ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    r = await mkObj({ obj_type: 'TABLE', db_connection_id: cSql, schema_name: 'dbo', obj_name: uniq('tbl') });
    check('TABLE ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    const oTable = r.json && r.json.id;
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: '日清调度任务' });
    check('FDL_TASK（中文名称，db_connection_id / schema 缺省）⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    const oFdl = r.json && r.json.id;
    row = oFdl ? await objRow(oFdl) : null;
    check('FDL_TASK：db_connection_id 与 schema_name 落库为 NULL', row && row.db_connection_id === null && row.schema_name === null, JSON.stringify(row));
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: '字'.repeat(200) });
    check('FDL_TASK 名称恰 200 字 ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: '字'.repeat(201) });
    check('FDL_TASK 名称 201 字 ⇒ 400', r.status === 400, JSON.stringify(r.json || r.text));

    const before400 = await countAll();
    const bad = [
      ['obj_type 缺失', { db_connection_id: cSql, schema_name: 'dbo', obj_name: 'x1' }],
      ['obj_type 不在白名单（FUNCTION）', { obj_type: 'FUNCTION', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'x1' }],
      ['obj_type 小写 proc', { obj_type: 'proc', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'x1' }],
      ['PROC 缺 db_connection_id', { obj_type: 'PROC', schema_name: 'dbo', obj_name: 'x1' }],
      ['PROC db_connection_id 是字符串', { obj_type: 'PROC', db_connection_id: String(cSql), schema_name: 'dbo', obj_name: 'x1' }],
      ['PROC 缺 schema_name', { obj_type: 'PROC', db_connection_id: cSql, obj_name: 'x1' }],
      ['TABLE 缺 schema_name', { obj_type: 'TABLE', db_connection_id: cSql, obj_name: 'x1' }],
      ['VIEW schema_name 为空串', { obj_type: 'VIEW', db_connection_id: cSql, schema_name: '', obj_name: 'x1' }],
      ['PROC 引用不存在的连接', { obj_type: 'PROC', db_connection_id: 99999999, schema_name: 'dbo', obj_name: 'x1' }],
      ['TABLE 引用外部源占位连接', { obj_type: 'TABLE', db_connection_id: cExt, schema_name: 'dbo', obj_name: 'x1' }],
      ['PROC 引用外部源占位连接', { obj_type: 'PROC', db_connection_id: cExt, schema_name: 'dbo', obj_name: 'x2' }],
      ['TABLE 引用 mysql 类型连接', { obj_type: 'TABLE', db_connection_id: cMy, schema_name: 'dbo', obj_name: 'x1' }],
      ['FDL_TASK 带 schema_name', { obj_type: 'FDL_TASK', schema_name: 'dbo', obj_name: 'x1' }],
      ['FDL_TASK 带 db_connection_id', { obj_type: 'FDL_TASK', db_connection_id: cSql, obj_name: 'x1' }],
      ['obj_name 以数字开头', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: '1abc' }],
      ['obj_name 含连字符', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'a-b' }],
      ['obj_name 含空格', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'a b' }],
      ['obj_name 含分号（注入形态）', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'a;drop' }],
      ['obj_name 含方括号', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: '[a]' }],
      ['obj_name 中文（非 FDL）', { obj_type: 'VIEW', db_connection_id: cSql, schema_name: 'dbo', obj_name: '视图' }],
      ['obj_name 129 字符', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'a'.repeat(129) }],
      ['schema_name 含点号', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'd.bo', obj_name: 'x1' }],
      ['obj_name 为空串', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: '' }],
      ['obj_name 缺失', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo' }],
      ['FDL_TASK obj_name 含换行', { obj_type: 'FDL_TASK', obj_name: '任务\n甲' }],
      ['FDL_TASK obj_name 含 TAB', { obj_type: 'FDL_TASK', obj_name: '任务\t甲' }],
      ['FDL_TASK obj_name 含 NUL', { obj_type: 'FDL_TASK', obj_name: '任务\u0000甲' }],
      ['FDL_TASK obj_name 含 DEL(0x7F)', { obj_type: 'FDL_TASK', obj_name: '任务\u007F甲' }],
      ['FDL_TASK obj_name 首尾有空白', { obj_type: 'FDL_TASK', obj_name: ' 任务甲' }],
      ['FDL_TASK obj_name 纯空白', { obj_type: 'FDL_TASK', obj_name: '   ' }],
      ['summary 超 500 字', { obj_type: 'FDL_TASK', obj_name: 'x_sum', summary: 'a'.repeat(501) }],
      ['summary 含 TAB', { obj_type: 'FDL_TASK', obj_name: 'x_sum', summary: 'a\tb' }],
      ['summary 含 U+0001', { obj_type: 'FDL_TASK', obj_name: 'x_sum', summary: 'a\u0001b' }],
      ['summary 不是字符串', { obj_type: 'FDL_TASK', obj_name: 'x_sum', summary: 5 }],
      ['新建时携带 reg_source（须走专用端点）', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'x_src', reg_source: 'abc' }],
      ['新建时携带 doc_path', { obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: 'x_doc', doc_path: 'a/b.sql' }],
    ];
    for (const [label, body] of bad) {
      r = await mkObj(body);
      check(`新建 400：${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    r = await call(adm, 'POST', '/api/model-impl-objects', [1, 2]);
    check('新建 400：请求体是数组', r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    const after400 = await countAll();
    check('以上全部 400 / 409 请求零写入：对象 / 关系 / 留痕行数均不变（仅 FDL 200 字与 200 字 ok 一条除外）', after400.objs === before400.objs && after400.links === before400.links && after400.logs === before400.logs, `${JSON.stringify(before400)} → ${JSON.stringify(after400)}`);
    const summaryOk = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('fdl_sum'), summary: 'a'.repeat(500) });
    check('summary 恰 500 字 ⇒ 200', summaryOk.status === 200, JSON.stringify(summaryOk.json || summaryOk.text));
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('fdl_sum') }, owner.token);
    check('新建：非 admin ⇒ 403', r.status === 403, `${r.status}`);
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('fdl_sum') }, viewer.token);
    check('新建：viewer ⇒ 403', r.status === 403, `${r.status}`);
    r = await call(null, 'POST', '/api/model-impl-objects', { obj_type: 'FDL_TASK', obj_name: uniq('fdl') });
    check('新建：无 token ⇒ 401 / 403', r.status === 401 || r.status === 403, `${r.status}`);

    // ═════════ 四、summary 修改 ═════════
    r = await call(adm, 'PUT', `/api/model-impl-objects/${oProc}`, { summary: '改后说明' });
    check('PUT summary ⇒ 200 且落库', r.status === 200 && (await objRow(oProc)).summary === '改后说明', JSON.stringify(r.json || r.text));
    row = await objRow(oProc);
    check('PUT summary：updated_by 为操作者名，身份字段未变', row.updated_by === admin.display_name && row.obj_name === pName && row.obj_type === 'PROC', JSON.stringify(row));
    r = await call(adm, 'PUT', `/api/model-impl-objects/${oProc}`, { summary: null });
    check('PUT summary 为 null ⇒ 200，库里为 NULL', r.status === 200 && (await objRow(oProc)).summary === null, JSON.stringify(r.json || r.text));
    for (const [label, body] of [['携带 obj_name', { summary: 'x', obj_name: 'zz' }], ['携带 obj_type', { summary: 'x', obj_type: 'VIEW' }], ['携带 db_connection_id', { summary: 'x', db_connection_id: cSql }], ['携带 schema_name', { summary: 'x', schema_name: 'dbo' }], ['缺 summary', {}], ['summary 超长', { summary: 'a'.repeat(501) }]]) {
      r = await call(adm, 'PUT', `/api/model-impl-objects/${oProc}`, body);
      check(`PUT summary 400：${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    check('PUT summary 400 后：对象行逐字段不变（身份字段不可改）', (await objRow(oProc)).obj_name === pName && (await objRow(oProc)).summary === null);
    r = await call(owner.token, 'PUT', `/api/model-impl-objects/${oProc}`, { summary: '越权' });
    check('PUT summary：非 admin ⇒ 403，未落库', r.status === 403 && (await objRow(oProc)).summary === null, `${r.status}`);
    r = await call(adm, 'PUT', '/api/model-impl-objects/99999999', { summary: 'x' });
    check('PUT summary：对象不存在 ⇒ 404', r.status === 404, `${r.status}`);
    r = await call(adm, 'PUT', '/api/model-impl-objects/abc', { summary: 'x' });
    check('PUT summary：id 非数字 ⇒ 400', r.status === 400, `${r.status}`);

    // ═════════ 五、登记源码 ═════════
    const putSrc = (token, id, body) => call(token, 'PUT', `/api/model-impl-objects/${id}/source`, body);
    r = await putSrc(owner.token, oProc, { reg_source: 'abc' });
    check('登记源码：非 admin ⇒ 403，未落库', r.status === 403 && (await objRow(oProc)).reg_source == null, `${r.status}`);
    r = await putSrc(null, oProc, { reg_source: 'abc' });
    check('登记源码：无 token ⇒ 401 / 403', r.status === 401 || r.status === 403, `${r.status}`);
    r = await putSrc(adm, oProc, { reg_source: 'abc' });
    row = await objRow(oProc);
    check('登记源码：PROC 首次登记 ⇒ 200，reg_hash = sha256("abc")（norm_v1 对 "abc" 不改字节），hash_algo = norm_v1，源码落库', r.status === 200 && row.reg_hash === SHA_ABC && row.hash_algo === 'norm_v1' && row.reg_source === 'abc', JSON.stringify(r.json || r.text) + JSON.stringify(row));
    check('登记源码：响应回显 reg_hash / hash_algo', r.json && r.json.reg_hash === SHA_ABC && r.json.hash_algo === 'norm_v1', JSON.stringify(r.json));
    for (const [label, id, body, want] of [
      ['TABLE 对象', oTable, { reg_source: 'abc' }, 400], ['FDL_TASK 对象', oFdl, { reg_source: 'abc' }, 400],
      ['不存在的对象', 99999999, { reg_source: 'abc' }, 404], ['缺 reg_source', oProc, {}, 400], ['reg_source 为空串', oProc, { reg_source: '' }, 400],
      ['reg_source 纯空白', oProc, { reg_source: ' \n\t ' }, 400], ['reg_source 不是字符串', oProc, { reg_source: 5 }, 400],
      ['reg_source 含 U+0001', oProc, { reg_source: 'a\u0001b' }, 400], ['reg_source 含 DEL(0x7F)', oProc, { reg_source: 'a\u007Fb' }, 400],
      ['reg_source 含 NUL', oProc, { reg_source: 'a\u0000b' }, 400], ['reg_source 含 U+000B', oProc, { reg_source: 'a\u000Bb' }, 400],
      ['reg_source 含不成对代理项', oProc, { reg_source: 'a\ud800b' }, 400],
    ]) {
      r = await putSrc(adm, id, body);
      check(`登记源码 ${want}：${label}`, r.status === want, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    check('登记源码 400 / 404 后：oProc 的源码与哈希未变', (await objRow(oProc)).reg_source === 'abc' && (await objRow(oProc)).reg_hash === SHA_ABC);
    r = await putSrc(adm, oView, { reg_source: 'CREATE VIEW\tdbo.v AS\r\nSELECT 1\n' });
    check('登记源码：TAB / CR / LF 允许 ⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    const big1 = 'a'.repeat(1048576);
    r = await putSrc(adm, oView, { reg_source: big1 });
    check('登记源码：恰 1048576 字节（ASCII）⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);
    r = await putSrc(adm, oView, { reg_source: big1 + 'a' });
    check('登记源码：1048577 字节（ASCII）⇒ 413（处理器按 UTF-8 字节数拒绝）', r.status === 413, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);
    const mb = '中'.repeat(349526);    // 349526 字符 × 3 字节 = 1048578 字节 > 1MB，但字符数远小于 1048576
    r = await putSrc(adm, oView, { reg_source: mb });
    check('登记源码：349526 个「中」= 1048578 UTF-8 字节（字符数 < 1M）⇒ 413（按字节不按字符）', r.status === 413, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);
    const mbOk = '中'.repeat(349525) + 'a';   // 恰 1048576 字节
    r = await putSrc(adm, oView, { reg_source: mbOk });
    check('登记源码：349525 个「中」+ 1 个 a = 恰 1048576 字节 ⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);
    check('超限被拒后库里是上一次成功的值（零写入）', (await objRow(oView)).reg_source === mbOk);
    // 标准序列化的 1MB 字段（全由换行 / 引号 / 反斜杠组成，转义后约 2MB）可提交（§7.1）
    const esc = '\n"\\'.repeat(349525) + '\n';   // 349525×3+1 = 1048576 字节
    check('夹具自检：转义字段恰 1048576 字节，标准序列化后体积在 2.5MB 以内', Buffer.byteLength(esc, 'utf8') === 1048576 && Buffer.byteLength(JSON.stringify({ reg_source: esc }), 'utf8') < 2.5 * 1024 * 1024);
    r = await putSrc(adm, oView, { reg_source: esc });
    check('请求体上限：1MB 字段由换行 / 引号 / 反斜杠构成（标准序列化约 2MB）⇒ 200 可提交，且按原文落库', r.status === 200 && (await objRow(oView)).reg_source === esc, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 200)}`);

    // ═════════ 六、文档上报 ═════════
    const putDoc = (token, id, body) => call(token, 'PUT', `/api/model-impl-objects/${id}/doc`, body);
    const revProcBefore = await rev(mA);
    r = await putDoc(owner.token, oProc, { doc_path: 'docs/a.sql', doc_source: 'abc' });
    check('文档上报：非 admin ⇒ 403', r.status === 403, `${r.status}`);
    r = await putDoc(adm, oProc, { doc_path: 'sql/procs/usp_a.sql', doc_source: 'abc' });
    row = await objRow(oProc);
    check('文档上报 ⇒ 200：doc_hash = sha256("abc")，doc_path 落库，doc_reported_at 为 SQLite 本地时间格式，hash_algo = norm_v1',
      r.status === 200 && row.doc_hash === SHA_ABC && row.doc_path === 'sql/procs/usp_a.sql' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(row.doc_reported_at || '') && row.hash_algo === 'norm_v1', JSON.stringify(r.json || r.text) + JSON.stringify(row));
    check('文档上报不动登记源码与 reg_hash', row.reg_source === 'abc' && row.reg_hash === SHA_ABC);
    for (const [label, p, want] of [
      ['../x.sql', '../x.sql', null], ['a/../../x.sql', 'a/../../x.sql', null], ['绝对路径 /etc/x', '/etc/x', null], ['UNC \\\\srv\\share', '\\\\srv\\share', null],
      ['盘符 C:\\x', 'C:\\x', null], ['盘符 c:/x', 'c:/x', null], ['URL http://x/y', 'http://x/y', null], ['URL file:///x', 'file:///x', null],
      ['单点 .', '.', null], ['空串', '', null], ['纯空白', '   ', null], ['含 NUL', 'a\u0000b.sql', null], ['含换行', 'a\nb.sql', null], ['501 字', 'a'.repeat(501), null],
      ['规范化后为空 a/..', 'a/..', null],
    ]) {
      r = await putDoc(adm, oProc, { doc_path: p, doc_source: 'abc' });
      check(`文档上报 400：doc_path ${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
      void want;
    }
    r = await putDoc(adm, oProc, { doc_path: 'a/../docs/b.sql', doc_source: 'abc' });
    check('文档上报：doc_path 规范化 a/../docs/b.sql ⇒ docs/b.sql 落库', r.status === 200 && (await objRow(oProc)).doc_path === 'docs/b.sql', `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await putDoc(adm, oProc, { doc_path: 'x\\y\\z.sql', doc_source: 'abc' });
    check('文档上报：反斜杠统一为 / ⇒ x/y/z.sql', r.status === 200 && (await objRow(oProc)).doc_path === 'x/y/z.sql', `${r.status} ${JSON.stringify(r.json || r.text)}`);
    for (const [label, id, body, want] of [['缺 doc_source', oProc, { doc_path: 'a.sql' }, 400], ['缺 doc_path', oProc, { doc_source: 'abc' }, 400], ['doc_source 含 U+0001', oProc, { doc_path: 'a.sql', doc_source: 'a\u0001' }, 400],
      ['TABLE 对象', oTable, { doc_path: 'a.sql', doc_source: 'abc' }, 400], ['FDL_TASK 对象', oFdl, { doc_path: 'a.sql', doc_source: 'abc' }, 400], ['对象不存在', 99999999, { doc_path: 'a.sql', doc_source: 'abc' }, 404],
      ['doc_source 超 1MB 字节', oProc, { doc_path: 'a.sql', doc_source: '中'.repeat(349526) }, 413]]) {
      r = await putDoc(adm, id, body);
      check(`文档上报 ${want}：${label}`, r.status === want, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 160)}`);
    }
    // Y1：把专用文档对象挂接到一个未删除模型，上报新文档后 config_rev 与 impl_object 日志条数都必须精确不变（上面 oProc 未挂接，不足以证明）
    r = await call(adm, 'PUT', `/api/models/${mLinkRole}/impl-links`, { links: [{ object_id: oProc, role: '文档对象' }] });
    check('Y1 夹具：oProc 挂接到未删除模型 mLinkRole', r.status === 200 && (await rd.get('SELECT COUNT(*) AS c FROM model_impl_links WHERE model_id = ? AND object_id = ?', [mLinkRole, oProc])).c === 1, JSON.stringify(r.json || r.text));
    const y1Rev = await rev(mLinkRole);
    const y1Logs = (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [mLinkRole])).c;
    r = await putDoc(adm, oProc, { doc_path: 'docs/y1/new_doc.sql', doc_source: 'doc-text' });
    check('Y1 文档上报（对象已挂接）⇒ 200，doc_hash 为手写常量 sha256("doc-text")', r.status === 200 && (await objRow(oProc)).doc_hash === SHA_DOC, JSON.stringify(r.json || r.text));
    check('Y1 文档上报不递增已挂接模型的 config_rev，也不写 impl_object 日志（二者精确不变）', (await rev(mLinkRole)) === y1Rev && (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [mLinkRole])).c === y1Logs, `rev ${y1Rev} → ${await rev(mLinkRole)}`);

    // ═════════ 七、挂接整组替换：权限 / 校验 / 集合语义 / 留痕 ═════════
    const putLinks = (token, mid, body) => call(token, 'PUT', `/api/models/${mid}/impl-links`, body);
    const oL1 = await mkFdl(), oL2 = await mkFdl(), oL3 = await mkFdl();
    const gone = await mkFdl();
    r = await call(adm, 'DELETE', `/api/model-impl-objects/${gone}`);
    check('夹具：删除一个对象备用（已删除对象）', r.status === 200, JSON.stringify(r.json || r.text));
    const links0 = await countAll();
    const revA0 = await rev(mA);
    const denies = [
      ['他人（非编辑者）改 mA', other.token, mA, { links: [{ object_id: oL1, role: 'r' }] }, 403],
      ['模型编辑者（mA 技术负责人）改别的模型 mB', owner.token, mB, { links: [{ object_id: oL1, role: 'r' }] }, 403],
      ['viewer', viewer.token, mA, { links: [{ object_id: oL1, role: 'r' }] }, 403],
      ['无 token', null, mA, { links: [{ object_id: oL1, role: 'r' }] }, 401],
      ['挂已删除模型（admin）', adm, mDel, { links: [{ object_id: oL1, role: 'r' }] }, 400],
      ['挂不存在的模型（admin）', adm, 99999999, { links: [{ object_id: oL1, role: 'r' }] }, 400],
      ['挂已删除对象', adm, mA, { links: [{ object_id: gone, role: 'r' }] }, 400],
      ['挂不存在的对象', adm, mA, { links: [{ object_id: 99999999, role: 'r' }] }, 400],
      ['role 为空串', adm, mA, { links: [{ object_id: oL1, role: '' }] }, 400],
      ['role 纯空白', adm, mA, { links: [{ object_id: oL1, role: '   ' }] }, 400],
      ['role 缺失', adm, mA, { links: [{ object_id: oL1 }] }, 400],
      ['role 101 字', adm, mA, { links: [{ object_id: oL1, role: 'r'.repeat(101) }] }, 400],
      ['role 含换行', adm, mA, { links: [{ object_id: oL1, role: 'a\nb' }] }, 400],
      ['role 含 TAB', adm, mA, { links: [{ object_id: oL1, role: 'a\tb' }] }, 400],
      ['sort_no = -1', adm, mA, { links: [{ object_id: oL1, role: 'r', sort_no: -1 }] }, 400],
      ['sort_no = 1000', adm, mA, { links: [{ object_id: oL1, role: 'r', sort_no: 1000 }] }, 400],
      ['sort_no = 1.5', adm, mA, { links: [{ object_id: oL1, role: 'r', sort_no: 1.5 }] }, 400],
      ['sort_no 是字符串 "1"', adm, mA, { links: [{ object_id: oL1, role: 'r', sort_no: '1' }] }, 400],
      ['同一请求内 object_id 重复', adm, mA, { links: [{ object_id: oL1, role: 'a' }, { object_id: oL1, role: 'b' }] }, 400],
      ['object_id 是字符串', adm, mA, { links: [{ object_id: String(oL1), role: 'r' }] }, 400],
      ['object_id = 0', adm, mA, { links: [{ object_id: 0, role: 'r' }] }, 400],
      ['links 缺失', adm, mA, {}, 400], ['links 不是数组', adm, mA, { links: {} }, 400], ['links 元素不是对象', adm, mA, { links: [5] }, 400],
    ];
    for (const [label, token, mid, body, want] of denies) {
      r = await putLinks(token, mid, body);
      check(`挂接 ${want}：${label}`, want === 401 ? (r.status === 401 || r.status === 403) : r.status === want, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    const links1 = await countAll();
    check('以上全部拒绝：关系 / 留痕行数不变，mA 的 config_rev 不变', links1.links === links0.links && links1.logs === links0.logs && (await rev(mA)) === revA0, `${JSON.stringify(links0)} → ${JSON.stringify(links1)} rev ${revA0} → ${await rev(mA)}`);
    // Y5：创建者分支——创建者（非技术负责人）可维护；非负责人且非创建者 403
    r = await putLinks(creator.token, mCr, { links: [{ object_id: oL1, role: '创建者维护' }] });
    check('Y5 模型创建者（created_by_id = 该用户，非技术负责人）可维护挂接 ⇒ 200', r.status === 200 && r.json && r.json.changed === true, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await putLinks(other.token, mCr, { links: [{ object_id: oL1, role: '越权' }] });
    check('Y5 非技术负责人且非创建者的普通用户改该模型挂接 ⇒ 403', r.status === 403, `${r.status}`);
    r = await putLinks(creator.token, mB, { links: [{ object_id: oL1, role: '越权' }] });
    check('Y5 创建者只能维护自己创建的模型：改别的模型 mB ⇒ 403', r.status === 403, `${r.status}`);
    await putLinks(adm, mCr, { links: [] });
    r = await putLinks(owner.token, mA, { links: [{ object_id: oL1, role: '职责一', sort_no: 2 }, { object_id: oL2, role: '职责二', sort_no: 1 }] });
    check('模型编辑者替换本模型挂接 ⇒ 200，changed=true', r.status === 200 && r.json && r.json.changed === true, JSON.stringify(r.json || r.text));
    let lk = await linkRows(mA);
    check('挂接落库：两条关系，role / sort_no / created_by（编辑者名）正确',
      lk.length === 2 && lk[0].object_id === oL1 && lk[0].role === '职责一' && lk[0].sort_no === 2 && lk[1].object_id === oL2 && lk[1].role === '职责二' && lk[1].sort_no === 1 && lk.every((x) => x.created_by === owner.display_name), JSON.stringify(lk));
    check('挂接：响应 links 按 sort_no、object_id 升序', r.json.links.map((x) => x.object_id).join() === [oL2, oL1].join(), JSON.stringify(r.json.links));
    check('挂接集合变化：mA 的 config_rev +1', (await rev(mA)) === revA0 + 1, `${revA0} → ${await rev(mA)}`);
    let logs = await rd.all("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object' ORDER BY id", [mA]);
    check('挂接集合变化：写 1 条 impl_object 变更日志，before 为空集、after 含两个对象 id 与 reg_hash（空为 null）',
      logs.length === 1 && logs[0].action === 'UPDATE' && JSON.stringify(JSON.parse(logs[0].before_value)) === '[]'
      && JSON.stringify(JSON.parse(logs[0].after_value)) === JSON.stringify([{ object_id: oL1, reg_hash: null }, { object_id: oL2, reg_hash: null }].sort((a, b) => a.object_id - b.object_id))
      && logs[0].operator_name === owner.display_name && logs[0].model_name != null, JSON.stringify(logs));
    const createdAtBefore = (await rd.get('SELECT created_at FROM model_impl_links WHERE model_id = ? AND object_id = ?', [mA, oL1])).created_at;
    await H.settle(1100);
    r = await putLinks(adm, mA, { links: [{ object_id: oL1, role: '职责一（改）', sort_no: 5 }, { object_id: oL2, role: '职责二', sort_no: 1 }] });
    check('只改 role / sort_no ⇒ 200，changed=false，config_rev 不变，不新增变更日志', r.status === 200 && r.json.changed === false && (await rev(mA)) === revA0 + 1
      && (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [mA])).c === 1, JSON.stringify(r.json || r.text));
    lk = await linkRows(mA);
    check('只改 role / sort_no：新值落库，且保留关系的 created_at / created_by 不被重写', lk[0].role === '职责一（改）' && lk[0].sort_no === 5
      && (await rd.get('SELECT created_at FROM model_impl_links WHERE model_id = ? AND object_id = ?', [mA, oL1])).created_at === createdAtBefore && lk[0].created_by === owner.display_name, JSON.stringify(lk));
    r = await putLinks(adm, mA, { links: [{ object_id: oL1, role: '职责一（改）', sort_no: 5 }, { object_id: oL2, role: '职责二', sort_no: 1 }] });
    check('同集合同内容重放 ⇒ 200，changed=false，config_rev 不变', r.status === 200 && r.json.changed === false && (await rev(mA)) === revA0 + 1, JSON.stringify(r.json || r.text));
    r = await putLinks(adm, mA, { links: [{ object_id: oL2, role: '职责二', sort_no: 1 }, { object_id: oL3, role: '职责三' }] });
    lk = await linkRows(mA);
    check('整组替换 [oL1,oL2] → [oL2,oL3]：结果恰为 {oL2,oL3}（oL1 解挂、oL3 新增，oL3 的 sort_no 缺省 0）',
      r.status === 200 && r.json.changed === true && lk.map((x) => x.object_id).join() === [oL2, oL3].join() && lk.find((x) => x.object_id === oL3).sort_no === 0, JSON.stringify(lk));
    check('集合再次变化：config_rev 累计 +2', (await rev(mA)) === revA0 + 2, `${revA0} → ${await rev(mA)}`);
    r = await putLinks(adm, mA, { links: [] });
    check('空数组 = 解挂全部 ⇒ 200，关系清空，config_rev 累计 +3', r.status === 200 && r.json.changed === true && (await linkRows(mA)).length === 0 && (await rev(mA)) === revA0 + 3, JSON.stringify(r.json || r.text));
    r = await putLinks(adm, mA, { links: [] });
    check('对空集再提交空数组 ⇒ 200，changed=false，config_rev 不变', r.status === 200 && r.json.changed === false && (await rev(mA)) === revA0 + 3, JSON.stringify(r.json || r.text));
    r = await putLinks(adm, mA, { links: [{ object_id: oL1, role: 'r'.repeat(100), sort_no: 999 }, { object_id: oL2, role: '边界', sort_no: 0 }] });
    check('role 恰 100 字、sort_no 恰 999 / 0 ⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    r = await putLinks(adm, mA, { links: [{ object_id: oL1, role: '  去空白  ' }] });
    lk = await linkRows(mA);
    check('role 首尾空白被 trim 后落库', r.status === 200 && lk.length === 1 && lk[0].role === '去空白', JSON.stringify(lk));

    // ═════════ 八、GET / unowned / 读取过滤 ═════════
    r = await call(viewer.token, 'GET', `/api/model-impl-objects/${oL1}`);
    check('GET 详情：viewer 也可读 ⇒ 200，含有效关系（mA）与 reg_source 字段', r.status === 200 && r.json.id === oL1 && Array.isArray(r.json.links) && r.json.links.length === 1 && r.json.links[0].model_id === mA && r.json.links[0].role === '去空白' && 'reg_source' in r.json, JSON.stringify(r.json || r.text));
    r = await call(null, 'GET', `/api/model-impl-objects/${oL1}`);
    check('GET 详情：无 token ⇒ 401 / 403', r.status === 401 || r.status === 403, `${r.status}`);
    r = await call(adm, 'GET', `/api/model-impl-objects/${gone}`);
    check('GET 详情：已删除对象 ⇒ 404', r.status === 404, `${r.status}`);
    r = await call(adm, 'GET', `/api/model-impl-objects/${oDirty}`);
    check('GET 详情：历史脏关系（唯一关系指向已删除模型）被过滤 ⇒ links 为空', r.status === 200 && r.json.links.length === 0, JSON.stringify(r.json || r.text));
    r = await call(viewer.token, 'GET', '/api/model-impl-objects');
    check('GET 列表：viewer 可读 ⇒ 200 数组；不含已删除对象；不含 reg_source 大字段（只给 has_reg_source）', r.status === 200 && Array.isArray(r.json) && !r.json.some((o) => o.id === gone) && r.json.every((o) => !('reg_source' in o)) && r.json.find((o) => o.id === oProc).has_reg_source === 1, JSON.stringify(r.json && r.json.slice(0, 1)));
    check('GET 列表：link_count 只算未删除模型的关系（oL1 → 1，oDirty → 0）', r.json.find((o) => o.id === oL1).link_count === 1 && r.json.find((o) => o.id === oDirty).link_count === 0);
    r = await call(viewer.token, 'GET', '/api/model-impl-objects?unowned=1');
    const unIds = new Set((r.json || []).map((o) => o.id));
    check('unowned=1：只返回零条有效关系的对象——oDirty（关系指向已删模型）与 oL2（无关系）在，oL1（挂在 mA）与已删除对象不在',
      r.status === 200 && unIds.has(oDirty) && unIds.has(oL2) && !unIds.has(oL1) && !unIds.has(gone), JSON.stringify([...unIds]));

    // ═════════ 九、源码变化 / 对象软删除 / 模型软删除 的服务端语义（记账细节由 HTTP 套件归因，这里验行为与留痕）═════════
    const oShared = (await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: uniq('usp_shared') })).json.id;
    r = await putLinks(adm, mS1, { links: [{ object_id: oShared, role: '主过程' }] });
    r = await putLinks(adm, mS2, { links: [{ object_id: oShared, role: '备用过程' }] });
    const s1 = await rev(mS1), s2 = await rev(mS2);
    r = await putSrc(adm, oShared, { reg_source: 'v1' });
    check('首次登记源码：两个挂接模型 config_rev 都不变，响应 bumped_model_ids 为空', r.status === 200 && (await rev(mS1)) === s1 && (await rev(mS2)) === s2 && r.json.bumped_model_ids.length === 0, JSON.stringify(r.json || r.text));
    r = await putSrc(adm, oShared, { reg_source: 'v2' });
    check('Y7 源码变化后 reg_hash 恰为手写常量 sha256("v2")', (await objRow(oShared)).reg_hash === SHA_V2, JSON.stringify((await objRow(oShared)).reg_hash));
    check('源码变化（非空 → 另一非空）：两个挂接模型各 +1', r.status === 200 && (await rev(mS1)) === s1 + 1 && (await rev(mS2)) === s2 + 1 && r.json.bumped_model_ids.slice().sort((a, b) => a - b).join() === [mS1, mS2].sort((a, b) => a - b).join(), JSON.stringify(r.json || r.text));
    logs = await rd.all("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object' ORDER BY id", [mS1]);
    const lastLog = logs[logs.length - 1];
    check('源码变化留痕：受影响模型各写一条 impl_object 日志，before / after 记对象 id 与新旧 reg_hash（hash 为 sha256 小写十六进制）',
      logs.length === 2 && lastLog && /^[0-9a-f]{64}$/.test(JSON.parse(lastLog.before_value)[0].reg_hash) && /^[0-9a-f]{64}$/.test(JSON.parse(lastLog.after_value)[0].reg_hash)
      && JSON.parse(lastLog.before_value)[0].object_id === oShared && JSON.parse(lastLog.before_value)[0].reg_hash !== JSON.parse(lastLog.after_value)[0].reg_hash, JSON.stringify(logs.map((x) => [x.before_value, x.after_value])));
    r = await putSrc(adm, oShared, { reg_source: 'v2' });
    check('源码相同重放：config_rev 不变', r.status === 200 && r.json.changed === false && (await rev(mS1)) === s1 + 1 && (await rev(mS2)) === s2 + 1, JSON.stringify(r.json || r.text));
    // 已删除模型不被递增：把 mS2 的关系保留不动，先软删除 mS2（模型软删除只删关系），再改源码只递增 mS1
    r = await call(adm, 'DELETE', `/api/models/${mS2}`, { force: true, reason: 'mc' });
    check('模型软删除 ⇒ 200，仍返回「模型已删除」', r.status === 200 && r.json && r.json.message === '模型已删除', JSON.stringify(r.json || r.text));
    check('模型软删除：该模型的关系行被删除，对象本身保留（is_deleted = 0）', (await linkRows(mS2)).length === 0 && (await objRow(oShared)).is_deleted === 0);
    const s1b = await rev(mS1), s2b = await rev(mS2);
    r = await putSrc(adm, oShared, { reg_source: 'v3' });
    check('源码再变化：只递增仍有效挂接的 mS1（+1），已软删除的 mS2 不变', r.status === 200 && (await rev(mS1)) === s1b + 1 && (await rev(mS2)) === s2b && r.json.bumped_model_ids.join() === String(mS1), JSON.stringify(r.json || r.text));
    r = await call(adm, 'POST', `/api/models/${mS2}/restore`);
    check('模型恢复 ⇒ 200，但不自动恢复关系', r.status === 200 && (await linkRows(mS2)).length === 0, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    // 对象软删除：同事务删全部关系 + 原挂接模型 +1 + 留痕
    const oDelA = (await mkObj({ obj_type: 'VIEW', db_connection_id: cSql, schema_name: 'dbo', obj_name: uniq('v_del') })).json.id;
    await putLinks(adm, mDelTest, { links: [{ object_id: oDelA, role: '待删' }] });
    await putLinks(adm, mS1, { links: [{ object_id: oShared, role: '主过程' }, { object_id: oDelA, role: '待删' }] });
    const d1 = await rev(mDelTest), d2 = await rev(mS1);
    r = await call(owner.token, 'DELETE', `/api/model-impl-objects/${oDelA}`);
    check('对象删除：非 admin ⇒ 403，未删', r.status === 403 && (await objRow(oDelA)).is_deleted === 0, `${r.status}`);
    r = await call(adm, 'DELETE', `/api/model-impl-objects/${oDelA}`);
    check('对象软删除 ⇒ 200：is_deleted=1，其全部关系被删，原挂接的两个模型 config_rev 各 +1',
      r.status === 200 && (await objRow(oDelA)).is_deleted === 1 && (await rd.get('SELECT COUNT(*) AS c FROM model_impl_links WHERE object_id = ?', [oDelA])).c === 0 && (await rev(mDelTest)) === d1 + 1 && (await rev(mS1)) === d2 + 1, JSON.stringify(r.json || r.text));
    check('对象软删除：mS1 的另一条关系（oShared）保留', (await linkRows(mS1)).map((x) => x.object_id).join() === String(oShared), JSON.stringify(await linkRows(mS1)));
    logs = await rd.all("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object' ORDER BY id DESC LIMIT 1", [mDelTest]);
    check('对象软删除留痕：受影响模型写 impl_object 日志，after 为空集', logs.length === 1 && JSON.parse(logs[0].after_value).length === 0 && JSON.parse(logs[0].before_value)[0].object_id === oDelA, JSON.stringify(logs));
    r = await call(adm, 'DELETE', `/api/model-impl-objects/${oDelA}`);
    check('对象再次删除 ⇒ 404', r.status === 404, `${r.status}`);
    r = await call(adm, 'PUT', `/api/model-impl-objects/${oDelA}`, { summary: 'x' });
    check('已删除对象改 summary ⇒ 404', r.status === 404, `${r.status}`);
    r = await putSrc(adm, oDelA, { reg_source: 'abc' });
    check('已删除对象登记源码 ⇒ 404', r.status === 404, `${r.status}`);
    r = await putLinks(adm, mA, { links: [{ object_id: oDelA, role: 'r' }] });
    check('挂已软删除的对象 ⇒ 400', r.status === 400, `${r.status}`);
    r = await mkObj({ obj_type: 'VIEW', db_connection_id: cSql, schema_name: 'dbo', obj_name: (await objRow(oDelA)).obj_name });
    check('已删除对象的身份可被重新使用（部分唯一索引只管未删除行）⇒ 200', r.status === 200, JSON.stringify(r.json || r.text));
    // 模型软删除后对象变为未归属（unowned=1 可见）；伴生表关系随主表级联删除
    const oOnly = await mkFdl();
    await putLinks(adm, mDelTest, { links: [{ object_id: oOnly, role: '唯一挂接' }] });
    r = await call(adm, 'GET', '/api/model-impl-objects?unowned=1');
    check('unowned=1：挂在未删除模型上的对象不在清单', !(r.json || []).some((o) => o.id === oOnly));
    r = await call(adm, 'DELETE', `/api/models/${mDelTest}`, { force: true, reason: 'mc' });
    r = await call(adm, 'GET', '/api/model-impl-objects?unowned=1');
    check('模型软删除后，其唯一挂接的对象变为未归属：unowned=1 可见，对象本身保留', r.status === 200 && (r.json || []).some((o) => o.id === oOnly) && (await objRow(oOnly)).is_deleted === 0);
    check('夹具：伴生表 mComp 有一条历史关系（夹具直写）', (await linkRows(mComp)).length === 1);
    r = await call(adm, 'DELETE', `/api/models/${mParent}`, { force: true, reason: 'mc' });
    check('主表软删除（级联软删除伴生表）：伴生表的关系一并删除，对象保留', r.status === 200 && (await linkRows(mComp)).length === 0 && (await objRow(oComp)).is_deleted === 0, `${r.status} ${JSON.stringify(r.json || r.text)}`);

    // ═════════ 九-B、修复 1·W2：恢复路径不得让关系复活；伴生表禁止挂接 ═════════
    check('W2 夹具自检：mHist 已删除且带一条历史关系，oHist 详情被过滤、unowned 可见', (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [mHist])).is_deleted === 1 && (await linkRows(mHist)).length === 1);
    r = await call(adm, 'POST', `/api/models/${mHist}/restore`);
    check('W2 恢复带历史残留关系的已删除模型 ⇒ 200，恢复后关系行 = 0（恢复前先清掉，关系不复活）', r.status === 200 && (await linkRows(mHist)).length === 0 && (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [mHist])).is_deleted === 0, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await call(adm, 'GET', `/api/model-impl-objects/${oHist}`);
    check('W2 恢复后：对象详情 links 为空', r.status === 200 && r.json.links.length === 0, JSON.stringify(r.json));
    r = await call(adm, 'GET', '/api/model-impl-objects?unowned=1');
    check('W2 恢复后：unowned=1 列出该对象', (r.json || []).some((o) => o.id === oHist));
    const revFail0 = await rev(mFail);
    r = await call(adm, 'POST', `/api/models/${mFail}/restore`);
    check('W2 清理关系失败（注入）时恢复 ⇒ 500 MODEL_RESTORE_LINK_PURGE_FAILED，拒绝恢复', r.status === 500 && r.json && r.json.code === 'MODEL_RESTORE_LINK_PURGE_FAILED', `${r.status} ${JSON.stringify(r.json || r.text)}`);
    check('W2 恢复被拒后：模型仍为已删除、config_rev 不变、历史关系仍在（未半恢复）', (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [mFail])).is_deleted === 1 && (await rev(mFail)) === revFail0 && (await linkRows(mFail)).length === 1);
    r = await putLinks(adm, mAlive, { links: [{ object_id: oOnly, role: '有效关系' }] });
    r = await call(adm, 'POST', `/api/models/${mAlive}/restore`);
    check('W2 对已处于恢复状态的模型重复 restore ⇒ already_restored，其有效关系不被清掉（onlyIfDeleted）', r.status === 200 && r.json.already_restored === true && (await linkRows(mAlive)).length === 1, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    // 伴生表 companion-restore：P2 未启用追踪、C2 已软删除且带历史关系 ⇒ PUT 启用追踪走 companion-restore，关系不复活
    r = await call(adm, 'PUT', `/api/models/${cmp.p2.p}`, { dim_config: cmp.p2.cfgOn });
    const c2ok = await H.waitFor(async () => (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [cmp.p2.c])).is_deleted === 0, 8000, 100);
    check('W2 companion-restore：伴生表被恢复（is_deleted → 0），且历史关系没有复活', r.status === 200 && !!c2ok && (await linkRows(cmp.p2.c)).length === 0, `${r.status} restored=${c2ok} links=${(await linkRows(cmp.p2.c)).length}`);
    // P3：取消追踪（C3 软删）→ 重新勾选（companion-restore）：关系始终不复活
    r = await call(adm, 'PUT', `/api/models/${cmp.p3.p}`, { dim_config: cmp.p3.cfgOff });
    const c3del = await H.waitFor(async () => (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [cmp.p3.c])).is_deleted === 1, 8000, 100);
    const c3clr = await H.waitFor(async () => (await linkRows(cmp.p3.c)).length === 0, 5000, 100);
    check('W2 取消变更追踪：伴生表被软删除，其历史关系被一并清掉', r.status === 200 && !!c3del && !!c3clr, `${r.status} del=${c3del} cleared=${c3clr}`);
    r = await call(adm, 'PUT', `/api/models/${cmp.p3.p}`, { dim_config: cmp.p3.cfgOn });
    const c3back = await H.waitFor(async () => (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [cmp.p3.c])).is_deleted === 0, 8000, 100);
    check('W2 取消追踪后重新勾选：伴生表恢复，关系仍为空（不复活）', r.status === 200 && !!c3back && (await linkRows(cmp.p3.c)).length === 0, `${r.status} restored=${c3back}`);
    r = await putLinks(adm, cmp.p3.c, { links: [{ object_id: oOnly, role: 'r' }] });
    check('W2 伴生表挂接 ⇒ 400 COMPANION_NOT_LINKABLE（伴生表的对象登记在主模型下）', r.status === 400 && r.json && r.json.code === 'COMPANION_NOT_LINKABLE', `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await putLinks(adm, cmp.p3.c, { links: [] });
    check('W2 伴生表即使提交空数组也 400（不留「解挂」后门）', r.status === 400 && r.json && r.json.code === 'COMPANION_NOT_LINKABLE', `${r.status} ${JSON.stringify(r.json || r.text)}`);
    // L4：关系指向物理不存在的模型 id
    r = await call(adm, 'GET', `/api/model-impl-objects/${oPhys}`);
    check('L4 关系指向物理不存在的模型：对象详情 links 为空', r.status === 200 && r.json.links.length === 0, JSON.stringify(r.json));
    r = await call(adm, 'GET', '/api/model-impl-objects?unowned=1');
    check('L4 关系指向物理不存在的模型：unowned=1 列出该对象', (r.json || []).some((o) => o.id === oPhys));
    r = await call(adm, 'GET', '/api/model-impl-objects');
    check('L4 关系指向物理不存在的模型：列表 link_count = 0', (r.json || []).find((o) => o.id === oPhys).link_count === 0);

    // ═════════ 九-C、修复 1·W3：事务原子性（变更日志 INSERT 被注入失败 ⇒ 整体回滚、锁已释放）═════════
    const revTx0 = await rev(mTx);
    const logsTx0 = (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object'")).c;
    r = await putLinks(adm, mTx, { links: [{ object_id: oTx2, role: 'r2' }] });
    check('W3 整组替换：事务体中途失败（日志 INSERT 注入失败）⇒ 500', r.status === 500, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    check('W3 整组替换失败后：关系仍是原集合 {oTx1}，config_rev 不变，留痕不增（整体回滚）', JSON.stringify((await linkRows(mTx)).map((x) => x.object_id)) === JSON.stringify([oTx1]) && (await rev(mTx)) === revTx0
      && (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object'")).c === logsTx0, JSON.stringify(await linkRows(mTx)));
    r = await putLinks(adm, mTxY, { links: [{ object_id: oTx2, role: 'r' }] });
    check('W3 随后另一模型的整组替换 ⇒ 200（锁已释放、连接上没有残留的未提交事务）', r.status === 200, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await call(adm, 'DELETE', `/api/model-impl-objects/${oTx1}`);
    check('W3 对象软删除：事务体中途失败 ⇒ 500', r.status === 500, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    check('W3 对象删除失败后：对象未删除、关系仍在、mTx 的 config_rev 不变（整体回滚）', (await objRow(oTx1)).is_deleted === 0 && (await linkRows(mTx)).length === 1 && (await rev(mTx)) === revTx0);
    r = await call(adm, 'PUT', `/api/model-impl-objects/${oTx2}`, { summary: '锁已释放' });
    check('W3 随后 PUT summary ⇒ 200（锁已释放）', r.status === 200, `${r.status}`);
    const revT0 = await rev(mTT), revU0 = await rev(mTU);
    r = await putSrc(adm, oTxSrc, { reg_source: 'v2' });
    check('W3 登记源码变化：事务体中途失败 ⇒ 500', r.status === 500, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    const so = await objRow(oTxSrc);
    check('W3 源码变化失败后：源码与哈希仍是旧值（v1），两个挂接模型 config_rev 都不变（整体回滚）', so.reg_source === 'v1' && so.reg_hash === SHA_V1 && (await rev(mTT)) === revT0 && (await rev(mTU)) === revU0, JSON.stringify(so));
    r = await call(adm, 'PUT', `/api/model-impl-objects/${oTx2}`, { summary: '锁仍可用' });
    check('W3 再次确认锁已释放：PUT summary ⇒ 200', r.status === 200, `${r.status}`);

    // ═════════ 九-C2、Y2 / Y8：进程内构造模块 + 工厂注入观察钩子（确定性同步点，不靠毫秒延迟）═════════
    // 用内存 sqlite 连接 + 最小表结构在进程内构造 impl-objects 模块（工厂参数里传 onLockQueued / onLockAcquired / onTxBegun；
    // server.js 正式挂载不传，也没有任何环境变量开关）。「他模块」直接在同一连接上执行 BEGIN / ROLLBACK 模拟。
    {
      const sqlite3 = require('sqlite3');
      const createImplObjects = require(path.join(copyRoot, 'routes', 'model-center', 'impl-objects.js'));
      const express = require('express');
      const { listenOnSafePort } = require('./lib/listen-safe-port');
      const deferred = () => { let resolve; const promise = new Promise((r2) => { resolve = r2; }); return { promise, resolve }; };
      const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('等待超时：' + what)), ms))]);
      // opts（P52 = C 用例用）：trace = 数组，记录经这条连接发出的每条 run 语句的首词（BEGIN / COMMIT / ROLLBACK / UPDATE …）；
      //   onQuery(sql) = 每次 get / all 之前执行的异步钩子（可模拟「别的模块恰在此刻往同一连接写一条语句」）；canEdit = canEditModel 的实现
      //   afterRun(sql, err)（P57①）= 每条 run 语句执行完、结果交还给调用方之前执行的异步钩子（可模拟「别的模块恰在这条写语句之后立刻改了模型表」）；
      //   钩子里自己再发的 run 也会经过它，调用方须自带一次性开关
      const mkEnv = async (hooks, opts) => {
        const o = opts || {};
        const db = new sqlite3.Database(':memory:');
        if (o.trace || o.onQuery || o.afterRun) {
          const origRun = db.run.bind(db), origGet = db.get.bind(db), origAll = db.all.bind(db);
          db.run = function (sql, ...rest) {
            if (o.trace) o.trace.push(String(sql).trim().split(/\s+/)[0].toUpperCase());
            if (o.afterRun && typeof rest[rest.length - 1] === 'function') {
              const cb = rest[rest.length - 1];
              rest[rest.length - 1] = function (err) { const self = this; Promise.resolve(o.afterRun(String(sql), err)).then(() => cb.call(self, err), (e) => cb.call(self, e)); };
            }
            return origRun(sql, ...rest);
          };
          const wrapQ = (orig) => function (sql, ...rest) {
            if (!o.onQuery) return orig(sql, ...rest);
            const cb = rest[rest.length - 1];
            Promise.resolve(o.onQuery(String(sql))).then(() => orig(sql, ...rest), (e) => cb(e));
          };
          db.get = wrapQ(origGet); db.all = wrapQ(origAll);
        }
        const exec = (sql, p) => new Promise((res, rej) => db.run(sql, p || [], function (e) { if (e) rej(e); else res(this); }));
        const q = (sql, p) => new Promise((res, rej) => db.all(sql, p || [], (e, rows) => (e ? rej(e) : res(rows))));
        await exec('CREATE TABLE data_models (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, is_deleted INTEGER DEFAULT 0, companion_of INTEGER, tech_owner TEXT, created_by_id INTEGER, config_rev INTEGER NOT NULL DEFAULT 1)');
        // 列要补齐到 source / delete / doc 的 UPDATE 用到的全部列（updated_at / updated_by / prod_* / verified_at / last_*）：否则这些语句在内存库里先报「no such column」，
        //   走到数据库错误分支而不是内部不变量分支（P57 LOW-2：IMPL_INVARIANT 用例要的是不变量分支）
        await exec('CREATE TABLE model_impl_objects (id INTEGER PRIMARY KEY AUTOINCREMENT, reg_hash TEXT, is_deleted INTEGER DEFAULT 0, obj_type TEXT, reg_source TEXT, doc_hash TEXT, hash_algo TEXT, prod_hash TEXT, prod_missing INTEGER DEFAULT 0, verified_at TEXT, last_attempt_at TEXT, last_error TEXT, updated_at TEXT, updated_by TEXT)');
        await exec('CREATE TABLE model_impl_links (model_id INTEGER NOT NULL, object_id INTEGER NOT NULL, role TEXT NOT NULL, sort_no INTEGER NOT NULL DEFAULT 0, created_at TEXT, created_by TEXT, PRIMARY KEY (model_id, object_id))');
        await exec('CREATE TABLE model_change_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER, model_name TEXT, action TEXT, change_type TEXT, before_value TEXT, after_value TEXT, change_summary TEXT, operator_id INTEGER, operator_name TEXT)');
        await exec('CREATE TABLE other_mod (x INTEGER)');
        for (const n of ['m1', 'm2']) await exec('INSERT INTO data_models (table_name, tech_owner) VALUES (?, ?)', [n, 'x']);
        for (let i = 0; i < 3; i++) await exec('INSERT INTO model_impl_objects (reg_hash) VALUES (NULL)');
        const pass = (req, res, next) => next();
        const logger = { warn() {}, error() {}, info() {} };
        const mod = createImplObjects({ db, logger, authenticateToken: (req, res, next) => { req.user = { id: 1, role: 'admin', username: 'a', display_name: 'a' }; next(); }, requireAdmin: pass, requireNonViewer: pass, canEditModel: o.canEdit || (() => true), ...hooks });
        const app = express(); app.use(express.json()); app.use('/api', mod.router);
        const srv = await listenOnSafePort(http.createServer(app));
        const base = `http://127.0.0.1:${srv.address().port}`;
        const put = async (mid, links) => { const res = await fetch(`${base}/api/models/${mid}/impl-links`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }) }); return { status: res.status, json: await res.json().catch(() => null) }; };
        const call = async (method, urlPath, body) => { const res = await fetch(`${base}/api${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: res.status, json: await res.json().catch(() => null) }; };
        return { db, exec, q, put, call, mod, close: () => new Promise((resolve) => srv.close(() => db.close(() => resolve()))) };
      };
      // ── Y2：PF-3 锁内复核，确定性同步点：① 持锁者持锁 ② 竞态请求预检通过并进入锁等待（onLockQueued）③ 此时删除模型 ④ 放行持锁者 ⑤ 竞态请求锁内复核失败 400
      {
        const holdGate = deferred(), held = deferred(), racerQueued = deferred();
        let queuedN = 0, acquiredN = 0; const events = [];
        const env = await mkEnv({
          onLockQueued: async (label) => { events.push('queued:' + (++queuedN)); if (queuedN === 2) racerQueued.resolve(); },
          onLockAcquired: async (label) => { acquiredN++; events.push('acquired:' + acquiredN); if (acquiredN === 1) { held.resolve(); await holdGate.promise; } },
        });
        try {
          const pHolder = env.put(1, [{ object_id: 1, role: 'h' }]);
          await within(held.promise, 5000, '持锁者取得锁');
          const pRacer = env.put(2, [{ object_id: 2, role: 'r' }]);
          await within(racerQueued.promise, 5000, '竞态请求预检通过并进入锁等待（onLockQueued）');
          const dequeuedBeforeDelete = acquiredN;   // 竞态请求此刻还没拿到锁
          await env.exec('UPDATE data_models SET is_deleted = 1 WHERE id = 2');   // 模型在等锁期间被软删除（不经本模块锁，与 server.js 的软删除 UPDATE 同形）
          holdGate.resolve();
          const [rh, rr2] = [await pHolder, await pRacer];
          const l2 = await env.q('SELECT * FROM model_impl_links WHERE model_id = 2');
          check('Y2 PF-3 确定性同步：竞态请求「预检通过 → 进入锁等待（此时尚未取得锁）→ 模型被删 → 持锁者放行 → 锁内复核失败」', dequeuedBeforeDelete === 1 && events.join() === 'queued:1,acquired:1,queued:2,acquired:2', events.join());
          check('Y2 PF-3 锁内复核：竞态请求 ⇒ 400 MODEL_DELETED（不是 200），已删除模型没有关系行；持锁者 200', rr2.status === 400 && rr2.json && rr2.json.code === 'MODEL_DELETED' && l2.length === 0 && rh.status === 200, JSON.stringify([rh, rr2, l2]));
        } finally { holdGate.resolve(); await env.close(); }
      }
      // ── Y8 情形 A：他模块先开事务（同一连接上 BEGIN TRANSACTION），本模块 BEGIN 失败 ⇒ 503 IMPL_TX_BUSY，且他模块事务不受损（本模块没有 ROLLBACK 它）
      {
        const env = await mkEnv({});
        try {
          await env.exec('BEGIN TRANSACTION'); await env.exec('INSERT INTO other_mod (x) VALUES (1)');
          const ra = await env.put(1, [{ object_id: 1, role: 'r' }]);
          await env.exec('INSERT INTO other_mod (x) VALUES (2)'); await env.exec('COMMIT');   // 若本模块无条件 ROLLBACK 过，这里 COMMIT 会报 no transaction is active
          const other = (await env.q('SELECT x FROM other_mod ORDER BY x')).map((r2) => r2.x).join();
          check('Y8 他模块先开事务：本模块 ⇒ 503 IMPL_TX_BUSY；他模块事务不受损（两行都提交），本模块没有写入任何关系', ra.status === 503 && ra.json && ra.json.code === 'IMPL_TX_BUSY' && other === '1,2' && (await env.q('SELECT * FROM model_impl_links')).length === 0, JSON.stringify([ra, other]));
        } finally { await env.close(); }
      }
      // ── Y8 情形 B：本模块先开事务（onTxBegun 同步点），他模块 BEGIN 失败（not 无条件 ROLLBACK）⇒ 本模块集合完整、config_rev +1、一条留痕
      {
        const txBegun = deferred(), gate = deferred();
        const env = await mkEnv({ onTxBegun: async () => { txBegun.resolve(); await gate.promise; } });
        try {
          const p = env.put(1, [{ object_id: 1, role: 'a' }, { object_id: 2, role: 'b' }]);
          await within(txBegun.promise, 5000, '本模块事务已开（onTxBegun）');
          let otherErr = null; try { await env.exec('BEGIN TRANSACTION'); } catch (e) { otherErr = e; }   // 他模块的 BEGIN 撞上本模块事务
          gate.resolve();
          const rb = await p;
          const links = (await env.q('SELECT object_id FROM model_impl_links WHERE model_id = 1 ORDER BY object_id')).map((x) => x.object_id).join();
          const rv = (await env.q('SELECT config_rev FROM data_models WHERE id = 1'))[0].config_rev;
          const lg = (await env.q("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object'"))[0].c;
          check('Y8 本模块先开事务：他模块 BEGIN 失败（within a transaction）；本模块 200，集合完整 {1,2}，config_rev +1，一条留痕', !!otherErr && /within a transaction/i.test(otherErr.message) && rb.status === 200 && links === '1,2' && rv === 2 && lg === 1, JSON.stringify([otherErr && otherErr.message, rb, links, rv, lg]));
        } finally { gate.resolve(); await env.close(); }
      }
      // ── Y8 情形 C：本模块先开事务，他模块（有缺陷的写法）无条件 ROLLBACK 滚掉本模块事务 ⇒ 本模块 503 IMPL_TX_LOST，文案「结果未知…先 GET 核对」
      {
        const txBegun = deferred(), gate = deferred();
        const env = await mkEnv({ onTxBegun: async () => { txBegun.resolve(); await gate.promise; } });
        try {
          const p = env.put(1, [{ object_id: 1, role: 'a' }]);
          await within(txBegun.promise, 5000, '本模块事务已开（onTxBegun）');
          await env.exec('ROLLBACK');   // 他模块无条件 ROLLBACK（真实 sqlite 连接上滚掉了本模块事务）
          gate.resolve();
          const rc = await p;
          check('Y8 / X2 他模块无条件 ROLLBACK 滚掉本模块事务 ⇒ 503 IMPL_TX_LOST，文案为「结果未知：本次写入可能部分落库，请先 GET 核对当前集合再决定是否重放」', rc.status === 503 && rc.json && rc.json.code === 'IMPL_TX_LOST' && /结果未知/.test(rc.json.error) && /GET/.test(rc.json.error), JSON.stringify(rc));
        } finally { gate.resolve(); await env.close(); }
      }
      // ═════════ P52 = C：业务失败全部在 BEGIN 之前（锁内预检），事务里只剩写入 ═════════
      // 在进程内（内存库 + trace 记录每条 run 语句的首词）逐类业务失败断言：响应码 / 错误码与改前相同，且全程没有 BEGIN、没有 ROLLBACK；
      // 再用「别的模块恰在预检查询的那一刻往同一连接写一条语句（bumpConfigRev）」的行为用例证明：业务失败的请求不会撤销别人的写入
      // （旧实现在 BEGIN 之后才检查，别人的写入被卷进未提交事务，随业务失败的 ROLLBACK 一起撤销）。
      {
        const { bumpConfigRev } = require(path.join(copyRoot, 'routes', 'model-center', 'config-rev.js'));
        const noTx = (trace) => !trace.includes('BEGIN') && !trace.includes('ROLLBACK') && !trace.includes('COMMIT');
        // 每个用例一个全新的内存库：对象 1（FDL_TASK）/ 对象 2（PROC，可登记源码）/ 模型 1 / 模型 2（旁观模型，config_rev 起始 1）
        const mkP52 = async (hooks, o2) => {
          const trace = [];
          let envRef = null;
          const wrap = (fn) => (fn ? (...a) => fn(envRef, ...a) : undefined);
          const env = await mkEnv({ ...(hooks && hooks.onLockQueued ? { onLockQueued: wrap(hooks.onLockQueued) } : {}), ...(hooks && hooks.ev ? hooks.ev : {}) },
            { trace, canEdit: (o2 && o2.canEdit) || undefined, onQuery: o2 && o2.onQuery ? (sql) => o2.onQuery(envRef, sql) : undefined,
              afterRun: o2 && o2.afterRun ? (sql, err) => o2.afterRun(envRef, sql, err) : undefined });
          envRef = env;
          await env.exec("UPDATE model_impl_objects SET obj_type = 'FDL_TASK' WHERE id = 1");
          await env.exec("UPDATE model_impl_objects SET obj_type = 'PROC' WHERE id = 2");
          trace.length = 0;   // 夹具语句不计入
          return { env, trace };
        };
        const foreignBumpOnce = (re) => { let fired = false; return async (e, sql) => { if (!fired && re.test(sql)) { fired = true; await bumpConfigRev(e.db, [2]); } }; };
        const revOf = async (e, id) => (await e.q('SELECT config_rev FROM data_models WHERE id = ?', [id]))[0].config_rev;
        let t;
        // ── 业务失败 ⇒ 响应码不变 + 没有 BEGIN / ROLLBACK ──
        t = await mkP52();
        try {
          const rs = await t.env.call('PUT', '/model-impl-objects/999/source', { reg_source: 'select 1' });
          check('P52 source：对象不存在 ⇒ 404 OBJECT_NOT_FOUND，全程没有 BEGIN / ROLLBACK', rs.status === 404 && rs.json && rs.json.code === 'OBJECT_NOT_FOUND' && noTx(t.trace), JSON.stringify([rs, t.trace]));
          t.trace.length = 0;
          const rt = await t.env.call('PUT', '/model-impl-objects/1/source', { reg_source: 'select 1' });
          check('P52 source：类型不允许（FDL_TASK）⇒ 400 FIELD_COMBINATION_INVALID，全程没有 BEGIN / ROLLBACK', rt.status === 400 && rt.json && rt.json.code === 'FIELD_COMBINATION_INVALID' && noTx(t.trace), JSON.stringify([rt, t.trace]));
        } finally { await t.env.close(); }
        t = await mkP52();
        try {
          const rd2 = await t.env.call('DELETE', '/model-impl-objects/999');
          check('P52 delete：对象不存在 ⇒ 404 OBJECT_NOT_FOUND，全程没有 BEGIN / ROLLBACK', rd2.status === 404 && rd2.json && rd2.json.code === 'OBJECT_NOT_FOUND' && noTx(t.trace), JSON.stringify([rd2, t.trace]));
        } finally { await t.env.close(); }
        t = await mkP52();
        try {
          const rl = await t.env.put(1, [{ object_id: 999, role: 'r' }]);
          check('P52 links：OBJECT_NOT_FOUND ⇒ 400（带 object_ids），全程没有 BEGIN / ROLLBACK', rl.status === 400 && rl.json && rl.json.code === 'OBJECT_NOT_FOUND' && JSON.stringify(rl.json.object_ids) === '[999]' && noTx(t.trace), JSON.stringify([rl, t.trace]));
        } finally { await t.env.close(); }
        // links 的锁内复核四类：锁外那一次通过，等锁期间（onLockQueued 钩子）模型被改，锁内预检失败
        for (const [label, code, status, mutate] of [
          ['MODEL_NOT_FOUND', 'MODEL_NOT_FOUND', 400, (e) => e.exec('DELETE FROM data_models WHERE id = 1')],
          ['MODEL_DELETED', 'MODEL_DELETED', 400, (e) => e.exec('UPDATE data_models SET is_deleted = 1 WHERE id = 1')],
          ['COMPANION_NOT_LINKABLE', 'COMPANION_NOT_LINKABLE', 400, (e) => e.exec('UPDATE data_models SET companion_of = 2 WHERE id = 1')],
          ['FORBIDDEN', 'FORBIDDEN', 403, null],
        ]) {
          let allow = true;
          t = await mkP52({ onLockQueued: async (e) => { if (mutate) await mutate(e); else allow = false; } }, { canEdit: () => allow });
          try {
            const rl2 = await t.env.put(1, [{ object_id: 1, role: 'r' }]);
            check(`P52 links：锁内复核 ${label} ⇒ ${status} ${code}（锁外那次通过），全程没有 BEGIN / ROLLBACK，没有写入关系`, rl2.status === status && rl2.json && rl2.json.code === code && noTx(t.trace) && (await t.env.q('SELECT * FROM model_impl_links')).length === 0, JSON.stringify([rl2, t.trace]));
          } finally { await t.env.close(); }
        }
        // purge-account：目标状态不满足 ⇒ skipped，且不再开一个空事务；没有关系可清 ⇒ 同样不开事务；对照：有关系 ⇒ BEGIN … COMMIT 且记账
        t = await mkP52();
        try {
          const sk = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });   // 模型 1 此刻不是主表 2 的伴生表
          check('P52 purge-account：目标不是该主表的伴生表 ⇒ skipped NOT_COMPANION_OF_PARENT，全程没有 BEGIN / COMMIT / ROLLBACK（不再开空事务）', sk.skipped === 'NOT_COMPANION_OF_PARENT' && sk.accounted === false && noTx(t.trace), JSON.stringify([sk, t.trace]));
          await t.env.exec('UPDATE data_models SET companion_of = 2 WHERE id = 1'); t.trace.length = 0;
          const nr = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
          check('P52 purge-account：是伴生表但没有关系可清 ⇒ { changes: 0, accounted: false }，不开事务', nr.changes === 0 && nr.accounted === false && !nr.skipped && noTx(t.trace), JSON.stringify([nr, t.trace]));
          await t.env.exec("INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, 1, 'r', 0)"); t.trace.length = 0;
          const ok = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
          const seq = t.trace.filter((x) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(x)).join();
          check('P52 purge-account 对照：有关系 ⇒ 清除并记账（accounted、config_rev +1），事务顺序 BEGIN, COMMIT', ok.accounted === true && ok.changes === 1 && seq === 'BEGIN,COMMIT' && (await revOf(t.env, 1)) === 2, JSON.stringify([ok, t.trace]));
        } finally { await t.env.close(); }
        // ── 行为：业务失败的请求不会撤销别人在同一时刻写进共享连接的语句 ──
        for (const [label, req, re] of [
          ['source 404', (e) => e.call('PUT', '/model-impl-objects/999/source', { reg_source: 'select 1' }), /FROM model_impl_objects WHERE id = \? AND is_deleted = 0/],
          ['delete 404', (e) => e.call('DELETE', '/model-impl-objects/999'), /FROM model_impl_objects WHERE id = \? AND is_deleted = 0/],
          ['links OBJECT_NOT_FOUND', (e) => e.put(1, [{ object_id: 999, role: 'r' }]), /FROM model_impl_objects WHERE is_deleted = 0 AND id IN/],
        ]) {
          t = await mkP52(null, { onQuery: foreignBumpOnce(re) });
          try {
            const rr = await req(t.env);
            check(`P52 行为（${label}）：业务失败的请求不撤销他人写入——失败的同一时刻别的模块对旁观模型执行了一次 bumpConfigRev，旁观模型 config_rev 仍是 +1（2），本请求 4xx，没有 BEGIN / ROLLBACK`,
              rr.status >= 400 && rr.status < 500 && (await revOf(t.env, 2)) === 2 && noTx(t.trace), JSON.stringify([rr, await revOf(t.env, 2), t.trace]));
          } finally { await t.env.close(); }
        }
        // ── 事件顺序：queued → acquired → prechecked → txBegun；预检失败时只到 prechecked 之前（没有 prechecked / txBegun） ──
        {
          const ev = [];
          const evHooks = { ev: { onLockQueued: async () => { ev.push('queued'); }, onLockAcquired: async () => { ev.push('acquired'); }, onPrechecked: async () => { ev.push('prechecked'); }, onTxBegun: async () => { ev.push('txBegun'); } } };
          t = await mkP52(evHooks);
          try {
            const okR = await t.env.put(1, [{ object_id: 1, role: 'r' }]);
            const evOk = ev.join();
            ev.length = 0;
            const badR = await t.env.put(1, [{ object_id: 999, role: 'r' }]);
            check('P52 钩子顺序：成功请求 queued → acquired → prechecked → txBegun；预检失败的请求只有 queued → acquired（没有 prechecked / txBegun）',
              okR.status === 200 && evOk === 'queued,acquired,prechecked,txBegun' && badR.status === 400 && ev.join() === 'queued,acquired', JSON.stringify([okR.status, evOk, badR.status, ev.join()]));
          } finally { await t.env.close(); }
        }
        // ═════════ P57① = codex 49A-astra HIGH：实现对象写语句自带目标状态条件 ═════════
        // 本模块的锁只护本模块的表，server.js 里改 data_models 归属 / 删除态的写语句都不持这把锁——预检通过之后、写语句之前，模型状态可能已变。
        // 全部确定性：翻转点用钩子（onPrechecked / onTxBegun）或「写语句之后」的包装（afterRun），不用 sleep。
        {
          const txSeq = (trace) => trace.filter((x) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(x)).join();
          const implLogs = async (e) => (await e.q("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object'"))[0].c;
          const linkIds = async (e, mid) => (await e.q('SELECT object_id FROM model_impl_links WHERE model_id = ? ORDER BY object_id', [mid])).map((x) => x.object_id).join();
          const linkRoles = async (e, mid) => (await e.q('SELECT role FROM model_impl_links WHERE model_id = ? ORDER BY object_id', [mid])).map((x) => x.role).join();
          // 旁观者（§8.2，预检 LOW-2）：别的模块恰在本模块事务内（BEGIN 之后，onTxBegun）给旁观模型 2 做一次 bumpConfigRev——这条写入被卷进本模块的未提交事务，
          //   只有 COMMIT 才留得住，ROLLBACK 会把它连同本事务一起撤掉。（旧版把旁观递增放在锁内预检里＝BEGIN 之前，ROLLBACK 也撤不掉它，起不到「证明没有回滚」的作用）
          const withBystander = (h, holder) => {
            const ev = Object.assign({}, h && h.ev);
            const prior = ev.onTxBegun;
            ev.onTxBegun = async (...a) => { if (prior) await prior(...a); await bumpConfigRev(holder.env.db, [2]); };   // 先做该场景自己的翻转（如有），再做旁观递增
            return Object.assign({}, h, { ev });
          };
          const modelRow = async (e, id) => (await e.q('SELECT is_deleted, companion_of FROM data_models WHERE id = ?', [id]))[0];
          // purge-account：模型 1 是主表 2 的伴生表且挂着对象 1；翻转发生在「预检通过之后、BEGIN 之前」（onPrechecked）
          const mkPurge = async (flipSql) => {
            const holder = {};
            const tt = await mkP52(withBystander(flipSql ? { ev: { onPrechecked: async () => { await holder.env.exec(flipSql); } } } : null, holder));
            holder.env = tt.env;
            await tt.env.exec('UPDATE data_models SET companion_of = 2 WHERE id = 1');
            await tt.env.exec("INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, 1, 'r', 0)");
            tt.trace.length = 0;
            return tt;
          };
          t = await mkPurge(null);
          try {
            const ok = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
            check('P57 purge-account 对照（目标未翻转）：清除并记账——accounted、changes 1、关系清空、config_rev +1、一条 impl_object 变更日志、事务 BEGIN,COMMIT',
              ok.accounted === true && ok.changes === 1 && !ok.skipped && (await linkIds(t.env, 1)) === '' && (await revOf(t.env, 1)) === 2 && (await implLogs(t.env)) === 1 && txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify([ok, t.trace]));
          } finally { await t.env.close(); }
          const flipExpect = {   // 翻转之后模型 1 行的期望（is_deleted 初值 0；purge 夹具里 companion_of 初值 2）
            '改回独立模型': { is_deleted: 0, companion_of: null }, '改挂到别的父表': { is_deleted: 0, companion_of: 99 }, '被软删除': { is_deleted: 1, companion_of: 2 },
          };
          for (const [label, flipSql] of [
            ['改回独立模型', 'UPDATE data_models SET companion_of = NULL WHERE id = 1'],
            ['改挂到别的父表', 'UPDATE data_models SET companion_of = 99 WHERE id = 1'],
            ['被软删除', 'UPDATE data_models SET is_deleted = 1 WHERE id = 1'],
          ]) {
            t = await mkPurge(flipSql);
            try {
              const sk = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
              check(`P57 purge-account 翻转（${label}）：预检通过后目标被改 ⇒ 返回 skipped TARGET_CHANGED（accounted false、changes 0）`,
                sk.skipped === 'TARGET_CHANGED' && sk.accounted === false && sk.changes === 0, JSON.stringify(sk));
              check(`P57 purge-account 翻转（${label}）：关系行保留、模型 1 的 config_rev 不变（1）、没有 impl_object 变更日志`,
                (await linkIds(t.env, 1)) === '1' && (await revOf(t.env, 1)) === 1 && (await implLogs(t.env)) === 0,
                JSON.stringify([await linkIds(t.env, 1), await revOf(t.env, 1), await implLogs(t.env)]));
              check(`P57 purge-account 翻转（${label}）：事务照常 BEGIN,COMMIT、没有 ROLLBACK`, txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify(t.trace));
              check(`P57 purge-account 翻转（${label}）：事务内的旁观递增仍在（模型 2 的 config_rev 2；被卷进本事务的他人写入没有随回滚被撤掉），翻转本身没被撤销`,
                (await revOf(t.env, 2)) === 2 && JSON.stringify(await modelRow(t.env, 1)) === JSON.stringify(flipExpect[label]), JSON.stringify([await revOf(t.env, 2), await modelRow(t.env, 1)]));
            } finally { await t.env.close(); }
          }

          // impl-links：模型 1 独立、未删除；seed 为预置关系（[] = 无）；hooks / o2 决定在哪一刻翻转
          const mkLinks = async (seed, hooks, o2) => {
            const holder = {};
            const tt = await mkP52(withBystander(hooks ? hooks(holder) : null, holder), o2 ? o2(holder) : undefined);
            holder.env = tt.env;
            for (const [oid, role] of seed) await tt.env.exec('INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, ?, ?, 0)', [oid, role]);
            tt.trace.length = 0;
            return tt;
          };
          const flipAfterPrecheck = (sql) => (h) => ({ ev: { onPrechecked: async () => { await h.env.exec(sql); } } });
          const flipAfterBegin = (sql) => (h) => ({ ev: { onTxBegun: async () => { await h.env.exec(sql); } } });
          const SOFT_DEL = 'UPDATE data_models SET is_deleted = 1 WHERE id = 1';
          const TO_COMPANION = 'UPDATE data_models SET companion_of = 2 WHERE id = 1';
          // 对照：不翻转 ⇒ 200，挂上、config_rev +1、一条日志、事务 BEGIN,COMMIT
          t = await mkLinks([], null);
          try {
            const rc = await t.env.put(1, [{ object_id: 1, role: 'r' }]);
            check('P57 links 对照（模型未翻转）：挂接 ⇒ 200 changed，关系 {1}，config_rev +1，一条 impl_object 变更日志，事务 BEGIN,COMMIT',
              rc.status === 200 && rc.json && rc.json.changed === true && (await linkIds(t.env, 1)) === '1' && (await revOf(t.env, 1)) === 2 && (await implLogs(t.env)) === 1 && txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify([rc, t.trace]));
          } finally { await t.env.close(); }
          // 翻转点在「首条关系写语句之前」：INSERT 路径（软删除 / 转伴生）
          for (const [label, hooks, rowAfter] of [['模型被软删除（BEGIN 之后首条写语句之前）', flipAfterBegin(SOFT_DEL), { is_deleted: 1, companion_of: null }], ['模型转为伴生表（预检通过之后 BEGIN 之前）', flipAfterPrecheck(TO_COMPANION), { is_deleted: 0, companion_of: 2 }]]) {
            t = await mkLinks([], hooks);
            try {
              const rl = await t.env.put(1, [{ object_id: 1, role: 'r' }]);
              check(`P57 links 翻转·INSERT（${label}）：⇒ 409 MODEL_STATE_CHANGED（首条写语句之前翻转：partial === false，零写入）`, rl.status === 409 && rl.json && rl.json.code === 'MODEL_STATE_CHANGED' && /模型状态已变化/.test(rl.json.error || '') && /挂接未保存/.test(rl.json.error || '') && rl.json.partial === false, JSON.stringify(rl));
              check(`P57 links 翻转·INSERT（${label}）：关系表零变化（没有挂上）`, (await linkIds(t.env, 1)) === '', await linkIds(t.env, 1));
              check(`P57 links 翻转·INSERT（${label}）：config_rev 不变（1）、没有 impl_object 变更日志`, (await revOf(t.env, 1)) === 1 && (await implLogs(t.env)) === 0, JSON.stringify([await revOf(t.env, 1), await implLogs(t.env)]));
              check(`P57 links 翻转·INSERT（${label}）：事务 BEGIN,COMMIT、没有 ROLLBACK`, txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify(t.trace));
              check(`P57 links 翻转·INSERT（${label}）：事务内的旁观递增仍在（模型 2 的 config_rev 2），翻转本身没被撤销（模型 1 行 = ${JSON.stringify(rowAfter)}）——都在本模块事务里写入，ROLLBACK 会一并撤掉`,
                (await revOf(t.env, 2)) === 2 && JSON.stringify(await modelRow(t.env, 1)) === JSON.stringify(rowAfter), JSON.stringify([await revOf(t.env, 2), await modelRow(t.env, 1)]));
            } finally { await t.env.close(); }
          }
          // DELETE 路径：预置关系 {1}，整组替换为空 ⇒ 唯一的写语句是 DELETE
          t = await mkLinks([[1, 'a']], flipAfterPrecheck(SOFT_DEL));
          try {
            const rl = await t.env.put(1, []);
            check('P57 links 翻转·DELETE（预检通过后模型被软删除）：⇒ 409 MODEL_STATE_CHANGED', rl.status === 409 && rl.json && rl.json.code === 'MODEL_STATE_CHANGED', JSON.stringify(rl));
            check('P57 links 翻转·DELETE：被解挂的关系仍在（DELETE 自带条件没有执行）、config_rev 不变（1）、没有变更日志、事务 BEGIN,COMMIT',
              (await linkIds(t.env, 1)) === '1' && (await revOf(t.env, 1)) === 1 && (await implLogs(t.env)) === 0 && txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify([await linkIds(t.env, 1), await revOf(t.env, 1), t.trace]));
          } finally { await t.env.close(); }
          // UPDATE 路径：预置关系 {1: role a}，只改 role ⇒ 唯一的写语句是 UPDATE
          t = await mkLinks([[1, 'a']], flipAfterPrecheck(TO_COMPANION));
          try {
            const rl = await t.env.put(1, [{ object_id: 1, role: 'b' }]);
            check('P57 links 翻转·UPDATE（预检通过后模型转伴生表）：⇒ 409 MODEL_STATE_CHANGED', rl.status === 409 && rl.json && rl.json.code === 'MODEL_STATE_CHANGED', JSON.stringify(rl));
            check('P57 links 翻转·UPDATE：role 仍是 a（UPDATE 自带条件没有执行）、config_rev 不变、没有变更日志、事务 BEGIN,COMMIT',
              (await linkRoles(t.env, 1)) === 'a' && (await revOf(t.env, 1)) === 1 && (await implLogs(t.env)) === 0 && txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify([await linkRoles(t.env, 1), await revOf(t.env, 1), t.trace]));
          } finally { await t.env.close(); }
          // 中途翻转：第一条 INSERT 成功之后（afterRun）模型被改成伴生表 ⇒ 第二条 INSERT 被条件挡住 ⇒ 409；
          //   §7 口径：按实际生效的语句记账——第 1 条 INSERT 已生效，所以关系集合真的变了：照常递增 + 留痕（before = 原集合，after = 事务内重读的实际集合 {1}，不是 wanted {1,2}），
          //   409 带 partial: true 与实际 links；第 2 条没有执行；事务照常 COMMIT（不回滚，随后由排队的 purgeLinksOfModel(account) 清掉并接着记账）
          {
            let fired = false;
            t = await mkLinks([], null, () => ({ afterRun: async (e, sql) => { if (!fired && /^\s*INSERT INTO model_impl_links/i.test(sql)) { fired = true; await e.exec(TO_COMPANION); } } }));
            try {
              const rm = await t.env.put(1, [{ object_id: 1, role: 'r' }, { object_id: 2, role: 'r' }, { object_id: 3, role: 'r' }]);   // 请求 3 个对象：第 1 条生效、翻转、第 2 条被挡，第 3 条必须不再执行（§8.2）
              check('P57 links 中途翻转（第 1 条 INSERT 之后模型转伴生表）：⇒ 409 MODEL_STATE_CHANGED，partial === true，links 为实际集合 [{object_id:1}]',
                fired === true && rm.status === 409 && rm.json && rm.json.code === 'MODEL_STATE_CHANGED' && rm.json.partial === true && JSON.stringify((rm.json.links || []).map((x) => x.object_id)) === '[1]', JSON.stringify([fired, rm]));
              check('P57 links 中途翻转：部分生效时文案说「部分挂接变更已生效」，不说「挂接未保存」（codex 50A LOW）',
                /部分挂接变更已生效/.test((rm.json && rm.json.error) || '') && !/挂接未保存/.test((rm.json && rm.json.error) || ''), JSON.stringify(rm.json && rm.json.error));
              check('P57 links 中途翻转：已写入的第 1 条关系保留（不回滚）、第 2 / 3 条没有生效——关系恰为 {1}', (await linkIds(t.env, 1)) === '1', await linkIds(t.env, 1));
              // 完整 trace（语句首词序列）：翻转后状态一直保持，继续执行的后续语句 changes 也是 0，结果与「停止」完全相同——只有语句序列区分得出。
              //   BEGIN；事务内旁观递增 UPDATE；第 1 条 INSERT（生效）；afterRun 注入的翻转 UPDATE；第 2 条 INSERT（被挡 changes 0，在此停止，第 3 条 INSERT 不再发出）；
              //   bumpConfigRev 的 UPDATE；变更日志 INSERT；COMMIT。若遇 0 不停止，会多一条 INSERT（第 3 条）。
              check('P57 links 中途翻转：完整 trace 在翻转后不再出现后续 INSERT——恰为 BEGIN,UPDATE,INSERT,UPDATE,INSERT,UPDATE,INSERT,COMMIT（第 3 条关系的 INSERT 没有发出）',
                t.trace.join() === 'BEGIN,UPDATE,INSERT,UPDATE,INSERT,UPDATE,INSERT,COMMIT', t.trace.join());
              check('P57 links 中途翻转：已生效的变化照常记账——模型 1 的 config_rev +1（2）、恰好 1 条 impl_object 变更日志', (await revOf(t.env, 1)) === 2 && (await implLogs(t.env)) === 1, JSON.stringify([await revOf(t.env, 1), await implLogs(t.env)]));
              const lg1 = (await t.env.q("SELECT before_value, after_value, change_summary FROM model_change_logs WHERE change_type = 'impl_object' ORDER BY id"))[0] || {};
              const objIds = (s) => { try { return JSON.parse(s).map((x) => x.object_id).join(); } catch (_) { return 'bad'; } };
              check('P57 links 中途翻转：变更日志 before = 原集合（空），after = 事务内重读的实际集合 {1}（不是请求的 {1,2}），摘要写明仅部分生效',
                objIds(lg1.before_value) === '' && objIds(lg1.after_value) === '1' && /新增 1、解挂 0/.test(lg1.change_summary || '') && /部分生效/.test(lg1.change_summary || ''), JSON.stringify(lg1));
              check('P57 links 中途翻转：事务 BEGIN,COMMIT、没有 ROLLBACK', txSeq(t.trace) === 'BEGIN,COMMIT', JSON.stringify(t.trace));
              check('P57 links 中途翻转：事务内的旁观递增仍在（模型 2 的 config_rev 2），翻转本身没被撤销（模型 1 行 companion_of = 2）、第 1 条 INSERT 也在',
                (await revOf(t.env, 2)) === 2 && JSON.stringify(await modelRow(t.env, 1)) === JSON.stringify({ is_deleted: 0, companion_of: 2 }), JSON.stringify([await revOf(t.env, 2), await modelRow(t.env, 1)]));
              // 排队的清理（转伴生路径之后 server.js 会调用 purgeLinksOfModel(account)）：残留的那条关系被清掉，并递增 + 留痕；留痕的 before 集与上一条日志的 after 集衔接
              const pg = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
              const lgs = await t.env.q("SELECT before_value, after_value FROM model_change_logs WHERE change_type = 'impl_object' ORDER BY id");
              check('P57 links 中途翻转·随后的清理链：purgeLinksOfModel(account) 清掉残留关系并记账——accounted、changes 1、关系清空、config_rev +1（3）、共两条变更日志，第 2 条 before = 第 1 条 after',
                pg.accounted === true && pg.changes === 1 && (await linkIds(t.env, 1)) === '' && (await revOf(t.env, 1)) === 3 && lgs.length === 2 && objIds(lgs[1].before_value) === objIds(lgs[0].after_value) && objIds(lgs[1].after_value) === '',
                JSON.stringify([pg, await linkIds(t.env, 1), await revOf(t.env, 1), lgs]));
            } finally { await t.env.close(); }
          }
          // §8.2：「只改 role（UPDATE 生效）之后翻转、后续 INSERT 被挡」——partial 按「有语句生效」计（effective > 0），不是按「关系集合变了」（setChanged）：
          //   UPDATE 已生效（role a → b），所以 409 带 partial: true 与实际 links；但 role 变化不是集合变化 ⇒ 不递增、不留痕
          {
            let fired2 = false;
            t = await mkLinks([[1, 'a']], null, () => ({ afterRun: async (e, sql) => { if (!fired2 && /^\s*UPDATE model_impl_links/i.test(sql)) { fired2 = true; await e.exec(TO_COMPANION); } } }));
            try {
              const ru = await t.env.put(1, [{ object_id: 1, role: 'b' }, { object_id: 2, role: 'r' }]);
              check('P57 links UPDATE 生效后翻转（只改 role，后续 INSERT 被挡）：⇒ 409 MODEL_STATE_CHANGED，partial === true，links 为实际集合（对象 1 的 role 已是 b）',
                fired2 === true && ru.status === 409 && ru.json && ru.json.code === 'MODEL_STATE_CHANGED' && ru.json.partial === true && JSON.stringify((ru.json.links || []).map((x) => [x.object_id, x.role])) === '[[1,"b"]]', JSON.stringify([fired2, ru]));
              check('P57 links UPDATE 生效后翻转：已生效的 role 变化保留（b）、被挡的 INSERT 没有生效（关系恰为 {1}）；role 变化不是集合变化 ⇒ config_rev 不变（1）、没有 impl_object 变更日志',
                (await linkRoles(t.env, 1)) === 'b' && (await linkIds(t.env, 1)) === '1' && (await revOf(t.env, 1)) === 1 && (await implLogs(t.env)) === 0, JSON.stringify([await linkRoles(t.env, 1), await linkIds(t.env, 1), await revOf(t.env, 1), await implLogs(t.env)]));
              check('P57 links UPDATE 生效后翻转：完整 trace 恰为 BEGIN,UPDATE,UPDATE,UPDATE,INSERT,COMMIT（旁观递增 / role UPDATE / 翻转 UPDATE / 被挡的 INSERT；不递增故没有 bump 与日志语句），事务内的旁观递增仍在（模型 2 的 config_rev 2）',
                t.trace.join() === 'BEGIN,UPDATE,UPDATE,UPDATE,INSERT,COMMIT' && (await revOf(t.env, 2)) === 2, JSON.stringify([t.trace.join(), await revOf(t.env, 2)]));
            } finally { await t.env.close(); }
          }
          // §7：is_deleted 为 NULL 按存活（与 LIVE_MODEL_PRED / 预检 JS 口径一致）——条件写不得把 NULL 行当成已删
          t = await mkLinks([], null);
          try {
            await t.env.exec('UPDATE data_models SET is_deleted = NULL WHERE id = 1');
            const rn = await t.env.put(1, [{ object_id: 1, role: 'r' }]);
            check('P57 NULL is_deleted·links：模型 is_deleted = NULL 按存活——挂接 ⇒ 200 changed，关系 {1}，config_rev +1', rn.status === 200 && rn.json && rn.json.changed === true && (await linkIds(t.env, 1)) === '1' && (await revOf(t.env, 1)) === 2, JSON.stringify(rn));
          } finally { await t.env.close(); }
          t = await mkPurge(null);
          try {
            await t.env.exec('UPDATE data_models SET is_deleted = NULL WHERE id = 1');
            const pn = await t.env.mod.purgeLinksOfModel(1, { account: true, expectedParentId: 2 });
            check('P57 NULL is_deleted·purge-account：伴生表 is_deleted = NULL 按存活——清除并记账（accounted、changes 1、关系清空、config_rev +1）', pn.accounted === true && pn.changes === 1 && !pn.skipped && (await linkIds(t.env, 1)) === '' && (await revOf(t.env, 1)) === 2, JSON.stringify(pn));
          } finally { await t.env.close(); }
          // §7：removeLinksForDeletedModel 的 DELETE 自带「此刻确为已删除」条件——排队等锁期间模型被恢复并重新挂接，不得误删合法关系
          {
            const mkRm = async (restoreInQueue) => {
              const tt = await mkP52(restoreInQueue ? { onLockQueued: async (e) => { await e.exec('UPDATE data_models SET is_deleted = 0 WHERE id = 1'); await e.exec("INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, 2, 'new', 0)"); } } : null);
              await tt.env.exec('UPDATE data_models SET is_deleted = 1 WHERE id = 1');
              await tt.env.exec("INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, 1, 'old', 0)");
              tt.trace.length = 0;
              return tt;
            };
            t = await mkRm(false);
            try {
              const rr = await t.env.mod.removeLinksForDeletedModel(1);
              check('P57 removeLinksForDeletedModel 对照（模型仍为已删）：清掉其关系', rr.changes === 1 && (await linkIds(t.env, 1)) === '', JSON.stringify([rr, await linkIds(t.env, 1)]));
            } finally { await t.env.close(); }
            t = await mkRm(true);
            try {
              const rr = await t.env.mod.removeLinksForDeletedModel(1);
              check('P57 removeLinksForDeletedModel 排队期间模型被恢复并重新挂接（is_deleted = 0，新关系 {2}）：清理不删任何关系（changes 0，关系 {1,2} 原样）',
                rr.changes === 0 && (await linkIds(t.env, 1)) === '1,2', JSON.stringify([rr, await linkIds(t.env, 1)]));
            } finally { await t.env.close(); }
          }
          // §7 LOW-2：IMPL_INVARIANT 分支——预检通过后对象被锁外置为已删（onPrechecked 里改），事务体 UPDATE 的 changes 为 0 ⇒ 500 IMPL_INVARIANT + ROLLBACK
          {
            const softDelObj = (oid) => (h) => ({ ev: { onPrechecked: async () => { await h.env.exec(`UPDATE model_impl_objects SET is_deleted = 1 WHERE id = ${oid}`); } } });
            let h = {};
            t = await mkP52(softDelObj(2)(h));
            h.env = t.env;
            try {
              const ri = await t.env.call('PUT', '/model-impl-objects/2/source', { reg_source: 'select 1' });
              check('P57 IMPL_INVARIANT·source：预检通过后对象被锁外软删 ⇒ 500 IMPL_INVARIANT（不是 404 / 200），事务 BEGIN…ROLLBACK',
                ri.status === 500 && ri.json && ri.json.code === 'IMPL_INVARIANT' && txSeq(t.trace) === 'BEGIN,ROLLBACK', JSON.stringify([ri, t.trace]));
            } finally { await t.env.close(); }
            h = {};
            t = await mkP52(softDelObj(2)(h));
            h.env = t.env;
            try {
              await t.env.exec("INSERT INTO model_impl_links (model_id, object_id, role, sort_no) VALUES (1, 2, 'r', 0)");
              t.trace.length = 0;
              const rd3 = await t.env.call('DELETE', '/model-impl-objects/2');
              check('P57 IMPL_INVARIANT·delete：预检通过后对象被锁外软删 ⇒ 500 IMPL_INVARIANT，事务 BEGIN…ROLLBACK，先执行的关系 DELETE 已回滚（关系仍在）、模型 1 的 config_rev 不变',
                rd3.status === 500 && rd3.json && rd3.json.code === 'IMPL_INVARIANT' && txSeq(t.trace) === 'BEGIN,ROLLBACK' && (await linkIds(t.env, 1)) === '2' && (await revOf(t.env, 1)) === 1, JSON.stringify([rd3, t.trace, await linkIds(t.env, 1)]));
            } finally { await t.env.close(); }
          }
        }
      }
    }

    // ═════════ 九-D、修复 1·W4 / L3 + 修复 2·V3：他模块事务与本模块事务互相撞车（多轮，只核不变量，不赌先后）═════════
    // 两个各 500 个 FDL 对象的池：在两个池之间来回整组替换（DELETE 500 + INSERT 500）让锁内事务持续数十毫秒
    const poolP1 = [], poolP2 = [];
    for (let i = 0; i < 5; i++) { poolP1.push(...await Promise.all(Array.from({ length: 100 }, () => mkFdl()))); }
    for (let i = 0; i < 5; i++) { poolP2.push(...await Promise.all(Array.from({ length: 100 }, () => mkFdl()))); }
    const setOf = (pool, tag) => ({ links: pool.map((id, i) => ({ object_id: id, role: `${tag}${i}`, sort_no: i })) });
    const idsKey = (pool) => pool.slice().sort((a, b) => a - b).join();
    const mkBatch = (tag, n) => Array.from({ length: n }, (_, i) => ({ layer: 'ods', table_name: `mc_w4_${tag}_${Date.now().toString(36)}_${i}`, table_comment: 'w4' }));
    const countModels = async (arr) => (await rd.get('SELECT COUNT(*) AS c FROM data_models WHERE table_name IN (' + arr.map(() => '?').join(',') + ')', arr.map((x) => x.table_name))).c;
    r = await putLinks(adm, mBig1, setOf(poolP1, 'p1_'));
    check('W4 夹具：mBig1 先挂上 P1 的 500 个对象', r.status === 200 && (await linkRows(mBig1)).length === 500, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 120)}`);
    {
      // 每轮并发发出「本模块 500↔500 整组替换」与「他模块模型批量导入（BEGIN TRANSACTION）」，错开的毫秒数与谁先发按轮次循环变化；
      // 先后不预设，每轮两种结果都合法，只核不变量：
      //   · 本模块 503 IMPL_TX_BUSY（他模块事务先开，本模块 BEGIN 失败）⇒ 批量导入必须 200 且 1200 条全部落库；关系集合保持原样（不是半个集合）；
      //   · 本模块 200 ⇒ 关系集合恰为完整的新集合；批量导入要么 200 且全部落库，要么（BEGIN 撞上本模块事务失败）500 且 0 行落库；
      //   · 其余任何状态（含 IMPL_TX_LOST、500）一律判错；任何时刻关系集合只能是完整的旧集合或完整的新集合（不允许混合）。
      // 本小节只作补充：循环到两种碰撞都出现或达到轮数上限 40 即止，不把「出现过」当作有效性依据（确定性覆盖见 Y2 / Y8 进程内小节）。
      const MAX_ROUNDS = 40, MIN_ROUNDS = 6;
      let cur = 'p1', busyRounds = 0, collideRounds = 0, rounds = 0; const bad = [];
      for (let round = 0; round < MAX_ROUNDS && (round < MIN_ROUNDS || busyRounds < 1 || collideRounds < 1); round++) {
        rounds++;
        const curPool = cur === 'p1' ? poolP1 : poolP2, nextPool = cur === 'p1' ? poolP2 : poolP1, tag = (cur === 'p1' ? 'p2_' : 'p1_') + round + '_';
        const bt = mkBatch('r' + round, 1200);
        const offset = [0, 3, 8, 15, 30, 60][round % 6];
        const startLinks = () => putLinks(adm, mBig1, setOf(nextPool, tag));
        const startBatch = () => call(adm, 'POST', '/api/models/batch', bt);
        let pL, pB;
        if (round % 2 === 1) { pL = startLinks(); pB = H.settle(offset).then(startBatch); } else { pB = startBatch(); pL = H.settle(offset).then(startLinks); }
        const [rl, rb] = await Promise.all([pL, pB]);
        const rowIds = (await linkRows(mBig1)).map((x) => x.object_id).sort((a, b) => a - b).join();
        const imported = await countModels(bt);
        const batchOk = (rb.status === 200 && rb.json && rb.json.success === 1200 && imported === 1200) || (rb.status === 500 && imported === 0);
        const setWhole = rowIds === idsKey(curPool) || rowIds === idsKey(nextPool);
        const why = `round ${round}(offset ${offset}, ${round % 2 === 1 ? '本模块先发' : '批量先发'}): links=${rl.status}${rl.json && rl.json.code ? ' ' + rl.json.code : ''} batch=${rb.status} imported=${imported}`;
        if (!setWhole || !batchOk) { bad.push(why + ' 集合完整=' + setWhole); continue; }
        if (rl.status === 200) {
          if (rowIds !== idsKey(nextPool)) { bad.push(why + ' 本模块 200 但集合不是完整的新集合'); continue; }
          cur = cur === 'p1' ? 'p2' : 'p1';
          if (rb.status === 500) collideRounds++;
        } else if (rl.status === 503 && rl.json && rl.json.code === 'IMPL_TX_BUSY') {
          if (!(rb.status === 200 && imported === 1200) || rowIds !== idsKey(curPool)) { bad.push(why + ' 本模块 503 BUSY 时批量导入应 200 全落库且关系集合不变'); continue; }
          busyRounds++;
        } else bad.push(why + ' 非法状态');
      }
      check(`L3 / W4 补充（${rounds} 轮，不依赖碰撞必然出现）：每轮两种先后都合法，不变量全部成立（BUSY ⇒ 他模块 200 全落库；本模块 200 ⇒ 完整新集合且他模块 200 全落库或 500 零落库；无混合集合；无 IMPL_TX_LOST）`, bad.length === 0, bad.slice(0, 4).join(' | '));
      // （不再断言「两种碰撞各出现一次」：多轮延迟只作补充观察，不作为有效性依据；两种先后的确定性覆盖见上面「Y2 / Y8 进程内」小节）
      console.log(`  [info] 多轮补充观察：${rounds} 轮，BUSY ${busyRounds} 轮，批量导入撞上本模块事务 ${collideRounds} 轮`);
    }

    // ═════════ 九-E、Y4：挂接上限（501 个已存在对象）═════════
    //   原先用 501 个不存在的 object_id，会在「对象存在性」阶段返回 400，删掉 500 条上限也能假绿。这里用 501 个已存在的对象，并断言错误码。
    {
      const exist501 = [...poolP1, ...poolP2].slice(0, 501);
      r = await putLinks(adm, mBatch2, { links: exist501.map((id) => ({ object_id: id, role: 'r' })) });
      check('Y4 501 个已存在对象 ⇒ 400 INVALID_BODY（field = links，消息点名 500 上限），不是 OBJECT_NOT_FOUND', r.status === 400 && r.json && r.json.code === 'INVALID_BODY' && r.json.field === 'links' && /500/.test(r.json.error), `${r.status} ${JSON.stringify(r.json || r.text)}`);
      check('Y4 超限请求零写入：mBatch2 没有关系行', (await linkRows(mBatch2)).length === 0);
      r = await putLinks(adm, mBatch2, { links: exist501.slice(0, 500).map((id) => ({ object_id: id, role: 'r' })) });
      check('Y4 恰 500 个已存在对象 ⇒ 200，500 行落库', r.status === 200 && (await linkRows(mBatch2)).length === 500, `${r.status} ${JSON.stringify(r.json || r.text).slice(0, 120)}`);
    }

    // ═════════ 九-G、修复 2：V1 转伴生阻断 / V4 TX_LOST / companion-restore 失败 / 重注册 ═════════
    {
      const revT0 = await rev(v1.tV);
      r = await call(adm, 'PUT', `/api/models/${v1.pV}`, { dim_config: v1.cfgOn });
      check('V1 带有效关系的独立模型将被转成伴生表 ⇒ 400 COMPANION_TARGET_HAS_LINKS', r.status === 400 && r.json && r.json.code === 'COMPANION_TARGET_HAS_LINKS', `${r.status} ${JSON.stringify(r.json || r.text)}`);
      const tRow = await rd.get('SELECT companion_of, config_mode, is_deleted FROM data_models WHERE id = ?', [v1.tV]);
      const pCfg = JSON.parse((await rd.get('SELECT dim_config FROM data_models WHERE id = ?', [v1.pV])).dim_config);
      check('V1 阻断后：关系仍在、config_rev 不变、模型未被转换（companion_of 仍空、config_mode = standard）、主表配置未改', (await linkRows(v1.tV)).length === 1 && (await rev(v1.tV)) === revT0 && tRow.companion_of == null && tRow.config_mode === 'standard' && pCfg.dwdConfig.changeTracking.enabled === false, JSON.stringify(tRow));
      r = await putLinks(adm, v1.tV, { links: [] });
      check('V1 夹具：先解除实现对象挂接（impl-links 空数组）⇒ 200', r.status === 200 && (await linkRows(v1.tV)).length === 0, `${r.status} ${JSON.stringify(r.json || r.text)}`);
      r = await call(adm, 'PUT', `/api/models/${v1.pV}`, { dim_config: v1.cfgOn });
      const conv = await H.waitFor(async () => (await rd.get('SELECT companion_of FROM data_models WHERE id = ?', [v1.tV])).companion_of === v1.pV, 8000, 100);
      check('V1 解挂后再启用追踪 ⇒ 200，独立模型被转成伴生表（companion_of = 主表）', r.status === 200 && !!conv, `${r.status} converted=${conv}`);
    }
    {
      // X1：并发窗口兜底——触发器在转换的同一条 UPDATE 里写入一条关系（预检时没有关系，放行），转换后的带记账清理必须清掉它、config_rev +1、留一条 impl_object 日志
      const revX0 = await rev(x1.tX);
      const logsX0 = (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [x1.tX])).c;
      r = await call(adm, 'PUT', `/api/models/${x1.pX}`, { dim_config: x1.cfgOn });
      const convX = await H.waitFor(async () => (await rd.get('SELECT companion_of FROM data_models WHERE id = ?', [x1.tX])).companion_of === x1.pX, 8000, 100);
      const clearedX = await H.waitFor(async () => (await linkRows(x1.tX)).length === 0 && (await rev(x1.tX)) === revX0 + 1, 8000, 100);
      check('X1 转伴生时并发窗口里写入的关系：转换 200，伴生表关系被清，config_rev +1（带记账清理）', r.status === 200 && !!convX && !!clearedX, `${r.status} converted=${convX} cleared=${clearedX} rev=${await rev(x1.tX)} links=${(await linkRows(x1.tX)).length}`);
      const lx = await rd.all("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object' ORDER BY id", [x1.tX]);
      const lastX = lx[lx.length - 1];
      check('X1 带记账清理写一条 impl_object 变更日志：before 为原集合（含并发写入的对象），after 为空集，摘要点名「转为伴生表」', lx.length === logsX0 + 1 && lastX && JSON.parse(lastX.before_value).length === 1 && JSON.parse(lastX.before_value)[0].object_id === x1.oX && JSON.parse(lastX.after_value).length === 0 && /转为伴生表/.test(lastX.change_summary), JSON.stringify(lx.map((x) => [x.before_value, x.after_value, x.change_summary])));
    }
    {
      // V4：他模块无条件 ROLLBACK 的「事务丢失」——用进程内假连接直接构造（生产代码没有可靠可触发的无条件 ROLLBACK 路径），断言 503 IMPL_TX_LOST / IMPL_TX_BUSY
      const createImplObjects = require(path.join(copyRoot, 'routes', 'model-center', 'impl-objects.js'));
      const express = require('express');
      const { listenOnSafePort } = require('./lib/listen-safe-port');
      const modelRow = { id: 1, is_deleted: 0, companion_of: null, tech_owner: 'x', table_name: 't_fake' };
      const runFake = async (name, hooks) => {
        const calls = [];
        const fakeDb = {
          run(sql, params, cb) { calls.push(String(sql).trim().split(/\s+/)[0].toUpperCase()); const e = hooks.run ? hooks.run(String(sql)) : null; cb.call({ changes: 0, lastID: 0 }, e || null); },
          get(sql, params, cb) { cb(null, modelRow); },
          all(sql, params, cb) { const e = hooks.all ? hooks.all(String(sql)) : null; cb(e || null, []); },
        };
        const logger = { warn() {}, error() {}, info() {} };
        const pass = (req, res, next) => next();
        const mod = createImplObjects({ db: fakeDb, logger, authenticateToken: (req, res, next) => { req.user = { id: 1, role: 'admin', username: 'a', display_name: 'a' }; next(); }, requireAdmin: pass, requireNonViewer: pass, canEditModel: () => true });
        const app = express(); app.use(express.json()); app.use('/api', mod.router);
        const srv = await listenOnSafePort(http.createServer(app));
        try {
          const res = await fetch(`http://127.0.0.1:${srv.address().port}/api/models/1/impl-links`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links: [] }) });
          return { status: res.status, json: await res.json().catch(() => null), calls, name };
        } finally { await new Promise((resolve) => srv.close(resolve)); }
      };
      let f = await runFake('commit-lost', { run: (sql) => (/^\s*COMMIT/i.test(sql) ? new Error('SQLITE_ERROR: cannot commit - no transaction is active') : null) });
      check('V4 COMMIT 报 no transaction is active（他模块的 ROLLBACK 滚掉了本模块事务）⇒ 503 IMPL_TX_LOST', f.status === 503 && f.json && f.json.code === 'IMPL_TX_LOST', JSON.stringify(f));
      f = await runFake('rollback-lost', { all: (sql) => (/FROM model_impl_links WHERE model_id/.test(sql) ? new Error('SQLITE_ERROR: injected statement failure') : null), run: (sql) => (/^\s*ROLLBACK/i.test(sql) ? new Error('SQLITE_ERROR: cannot rollback - no transaction is active') : null) });
      check('V4 事务体语句失败后 ROLLBACK 报 no transaction is active ⇒ 503 IMPL_TX_LOST', f.status === 503 && f.json && f.json.code === 'IMPL_TX_LOST', JSON.stringify(f));
      f = await runFake('begin-busy', { run: (sql) => (/^\s*BEGIN/i.test(sql) ? new Error('SQLITE_ERROR: cannot start a transaction within a transaction') : null) });
      check('V4 / L3 BEGIN 撞上他模块事务 ⇒ 503 IMPL_TX_BUSY，且没有发出 ROLLBACK（不滚他人事务）', f.status === 503 && f.json && f.json.code === 'IMPL_TX_BUSY' && !f.calls.includes('ROLLBACK'), JSON.stringify(f));
      f = await runFake('begin-sqlite-busy', { run: (sql) => (/^\s*BEGIN/i.test(sql) ? Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' }) : null) });
      check('V4 / L3 BEGIN 报 SQLITE_BUSY ⇒ 503 IMPL_TX_BUSY（可重试）', f.status === 503 && f.json && f.json.code === 'IMPL_TX_BUSY' && !f.calls.includes('ROLLBACK'), JSON.stringify(f));
      f = await runFake('ok', {});
      check('V4 对照：假连接无故障时同一请求 ⇒ 200，且事务顺序 BEGIN … COMMIT', f.status === 200 && f.calls[0] === 'BEGIN' && f.calls[f.calls.length - 1] === 'COMMIT', JSON.stringify(f));
    }
    {
      r = await call(adm, 'PUT', `/api/models/${v4.p4}`, { dim_config: v4.cfgOn });
      const skipped = await H.waitFor(async () => fs.readFileSync(svc.inst.logPath, 'utf8').includes('伴生表恢复已跳过'), 8000, 100);   // 到达信号：服务日志里的跳过记录
      check('V4 companion-restore 清理关系失败（触发器注入）⇒ 跳过恢复：伴生表仍为已删除、历史关系仍在（不置 is_deleted = 0）', r.status === 200 && !!skipped && (await rd.get('SELECT is_deleted FROM data_models WHERE id = ?', [v4.c4])).is_deleted === 1 && (await linkRows(v4.c4)).length === 1, `${r.status} skipped=${skipped}`);
    }
    {
      const reName = (await rd.get('SELECT table_name FROM data_models WHERE id = ?', [mRe])).table_name;
      r = await call(adm, 'POST', '/api/models', { layer: 'ODS', table_name: reName, table_comment: '重注册', domain: 'MCDOM', tech_owner: 'mc_tech', biz_owner: 'mc_biz', update_cycle: 'di' });
      check('V4 同名重注册：POST /api/models 物理删除已软删除的旧行并建新行 ⇒ 200，新 id ≠ 旧 id', r.status === 200 && r.json && r.json.id && r.json.id !== mRe, `${r.status} ${JSON.stringify(r.json || r.text)}`);
      const oldGone = (await rd.get('SELECT COUNT(*) AS c FROM data_models WHERE id = ?', [mRe])).c === 0;
      check('V4 同名重注册：旧行已物理删除，指向它的实现对象关系一并清掉，对象保留', oldGone && (await linkRows(mRe)).length === 0 && (await objRow(oRe)).is_deleted === 0, `oldGone=${oldGone} links=${(await linkRows(mRe)).length}`);
    }

    // ═════════ 九-F、修复 1·L1 / L2 / L6（服务端）═════════
    for (const [label, p] of [['首部空白', ' a.sql'], ['尾部空白', 'a.sql '], ['以 / 结尾', 'a/b/'], ['以 \\ 结尾', 'a\\b\\']]) {
      r = await call(adm, 'PUT', `/api/model-impl-objects/${oProc}/doc`, { doc_path: p, doc_source: 'abc' });
      check(`L1 文档上报 400：doc_path ${label}`, r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    r = await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: pName.toUpperCase() });
    check('L2 身份唯一不区分大小写：已有 usp_x 时登记 USP_X ⇒ 409', r.status === 409, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'DBO', obj_name: pName });
    check('L2 schema 大小写不同（DBO vs dbo）⇒ 409', r.status === 409, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    const cc = (n) => String.fromCharCode(n);
    for (const [label, n] of [['C1 控制符 U+0085', 0x85], ['C1 控制符 U+009F', 0x9f], ['行分隔符 U+2028', 0x2028], ['段分隔符 U+2029', 0x2029], ['双向控制 U+202E', 0x202e], ['双向控制 U+2066', 0x2066], ['双向控制 U+2069', 0x2069]]) {
      r = await mkObj({ obj_type: 'FDL_TASK', obj_name: `任务${cc(n)}甲` });
      check(`L6 obj_name 含${label} ⇒ 400`, r.status === 400, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    }
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('l6'), summary: `说明${cc(0x85)}` });
    check('L6 summary 含 C1 控制符 ⇒ 400', r.status === 400, `${r.status}`);
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('l6'), summary: `说明${cc(0x202e)}` });
    check('L6 summary 含双向控制符 ⇒ 400', r.status === 400, `${r.status}`);
    r = await mkObj({ obj_type: 'FDL_TASK', obj_name: uniq('l6'), summary: `第一行\n第二行` });
    check('L6 summary 仍允许换行 ⇒ 200', r.status === 200, `${r.status} ${JSON.stringify(r.json || r.text)}`);
    r = await putLinks(adm, mCc, { links: [{ object_id: oTx2, role: `职责${cc(0x202e)}` }] });
    check('L6 role 含双向控制符 ⇒ 400', r.status === 400, `${r.status}`);
    r = await putLinks(adm, mCc, { links: [{ object_id: oTx2, role: `职责${cc(0x2028)}` }] });
    check('L6 role 含 U+2028 ⇒ 400', r.status === 400, `${r.status}`);

    // ═════════ 十、并发：两个整组替换同时发 → 结果恰为其中之一的完整集合 ═════════
    const poolA = await Promise.all(Array.from({ length: 30 }, () => mkFdl()));
    const poolB = await Promise.all(Array.from({ length: 30 }, () => mkFdl()));
    const setA = poolA.map((id, i) => ({ object_id: id, role: `甲${i}`, sort_no: i }));
    const setB = poolB.map((id, i) => ({ object_id: id, role: `乙${i}`, sort_no: 100 + i }));
    const canon = (rows) => JSON.stringify(rows.map((x) => [x.object_id, x.role, x.sort_no]).sort((a, b) => a[0] - b[0]));
    const canonWant = (set) => canon(set);
    const cc0 = await rev(mCc);
    let cleanRounds = 0, aWins = 0, bWins = 0, badRounds = 0;
    let lastRev = cc0;
    for (let round = 0; round < 6; round++) {
      const [ra, rb] = await Promise.all([putLinks(adm, mCc, { links: setA }), putLinks(adm, mCc, { links: setB })]);
      const got = canon(await linkRows(mCc));
      const isA = got === canonWant(setA), isB = got === canonWant(setB);
      if (ra.status === 200 && rb.status === 200 && (isA || isB)) { cleanRounds++; if (isA) aWins++; else bWins++; } else { badRounds++; console.log(`  并发轮 ${round} 异常：${ra.status} ${rb.status} A=${isA} B=${isB} ${JSON.stringify(ra.json || ra.text).slice(0, 120)} ${JSON.stringify(rb.json || rb.text).slice(0, 120)}`); }
      lastRev = await rev(mCc);
    }
    check('并发整组替换：6 轮（每轮 Promise.all 两个互不相交的 30 条集合），每轮两个请求都 200 且结果恰为其中一个完整集合（不交错）', cleanRounds === 6 && badRounds === 0, `clean=${cleanRounds} bad=${badRounds}`);
    // 每轮：第一轮从空集到 A 或 B（+1），第二个请求从 X 到 Y（Y≠X 集合不同 → +1）；之后每轮的第一个请求若与当前集合相同则不变——只断言总增量下界 ≥ 2 且每轮落在合法集合
    check('并发整组替换：config_rev 至少递增 2（首轮两个集合互不相交）', lastRev - cc0 >= 2, `${cc0} → ${lastRev}`);
    check('并发整组替换后：关系行数恰为 30', (await linkRows(mCc)).length === 30);
    // L4：留痕与最终集合一致——每次递增恰好一条日志；最后一条日志的 after 恰是最终关系集合的对象 id
    const ccLogs = await rd.all("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object' ORDER BY id", [mCc]);
    const finalIds = (await linkRows(mCc)).map((x) => x.object_id).sort((a, b) => a - b);
    const lastAfter = ccLogs.length ? JSON.parse(ccLogs[ccLogs.length - 1].after_value).map((x) => x.object_id).sort((a, b) => a - b) : null;
    check('并发整组替换后：变更日志条数 = config_rev 递增次数，且最后一条日志的 after 集合 = 最终关系集合', ccLogs.length === lastRev - cc0 && JSON.stringify(lastAfter) === JSON.stringify(finalIds), `logs=${ccLogs.length} revΔ=${lastRev - cc0} last=${JSON.stringify(lastAfter)} final=${JSON.stringify(finalIds)}`);
    // 并发新建同身份：恰一个 200 一个 409
    const dupName = uniq('usp_race');
    const race = await Promise.all([0, 1, 2, 3].map(() => mkObj({ obj_type: 'PROC', db_connection_id: cSql, schema_name: 'dbo', obj_name: dupName })));
    const st = race.map((x) => x.status).sort();
    check('并发新建同身份对象（4 个请求）：恰 1 个 200、其余 409，库里恰 1 行', st.join() === '200,409,409,409' && (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ? AND is_deleted = 0', [dupName])).c === 1, JSON.stringify(st));

    // ═════════ 十一、请求体上限（§7.1）═════════
    const baseUrl = svc.baseUrl;
    const tokenH = { Authorization: `Bearer ${adm}` };
    const oBody = await mkFdl();           // 无源码类型也可用于 impl-links 路径；源码类用 oProc
    // C2b-2：PUT source / doc 成功后服务会异步核验并写 last_attempt_at / last_error 等核验列——「零写入」比较排除这五列（它们只由核验写，由 verify-model-impl-verify.js 专门断言）
    const stableObj = (o) => { const x = { ...o }; for (const k of ['prod_hash', 'prod_missing', 'verified_at', 'last_attempt_at', 'last_error']) delete x[k]; return JSON.stringify(x); };
    const snapshotObj = async () => stableObj(await objRow(oProc));
    const objBefore = await snapshotObj();
    const cnt0 = await countAll();
    // 11.1 分块传输累计 > 2.5MB ⇒ 413（源码端点）
    //   体内是一个合法的小源码 + 3MB 的多余字段：处理器自己的 1MB 字段校验拦不住它，只有传输层上限能拒绝（避免「处理器兜底造成假绿」）
    const chunkBody = Buffer.from('{"reg_source":"abc","pad":"' + 'a'.repeat(3 * 1024 * 1024) + '"}');
    const mkChunks = (buf, size) => { const out = []; for (let i = 0; i < buf.length; i += size) out.push(buf.subarray(i, i + size)); return out; };
    let rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api/model-impl-objects/${oProc}/source`, headers: { ...tokenH, 'Content-Type': 'application/json' }, chunks: mkChunks(chunkBody, 64 * 1024) });
    check('请求体上限：分块传输（无 Content-Length）累计 3MB ⇒ 413', rr.status === 413, JSON.stringify(rr).slice(0, 200));
    // 11.2 声明 Content-Length > 2.5MB ⇒ 413
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api/model-impl-objects/${oProc}/source`, headers: { ...tokenH, 'Content-Type': 'application/json', 'Content-Length': String(chunkBody.length) }, chunks: mkChunks(chunkBody, 64 * 1024) });
    check('请求体上限：声明 Content-Length 3MB（全部发送）⇒ 413', rr.status === 413, JSON.stringify(rr).slice(0, 200));
    // 11.3 impl-links 路径同样受限
    const linksBig = Buffer.from('{"links":[],"pad":"' + 'a'.repeat(3 * 1024 * 1024) + '"}');
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api/models/${mCc}/impl-links`, headers: { ...tokenH, 'Content-Type': 'application/json', 'Content-Length': String(linksBig.length) }, chunks: mkChunks(linksBig, 64 * 1024) });
    check('请求体上限：/api/models/:id/impl-links 同样受 2.5MB 限制 ⇒ 413', rr.status === 413, JSON.stringify(rr).slice(0, 200));
    // 11.4 声明长度小于实际长度（原始 TCP）：声明长度截断在 JSON 内部 ⇒ 不进入处理器、零写入（不锁状态码）
    const full = '{"reg_source":"TRUNCATED_SOURCE_SHOULD_NOT_LAND_0123456789"}';
    const declared = 25;   // 截在 JSON 字符串内部
    const tcpPayload = `PUT /api/model-impl-objects/${oProc}/source HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${adm}\r\nContent-Type: application/json\r\nContent-Length: ${declared}\r\nConnection: close\r\n\r\n${full}`;
    const tcpOut = await rawTcp(svc.port, tcpPayload);
    await H.settle(300);
    check('请求体上限：声明 Content-Length 小于实际长度且截断在 JSON 内部（原始 TCP）⇒ 首个响应不是 2xx（不锁具体状态码）', /^HTTP\/1\.1 (4|5)\d\d/.test(tcpOut), tcpOut.slice(0, 120));
    check('声明长度截断：对象行逐字段不变（零写入，处理器未执行）', (await snapshotObj()) === objBefore);
    // 11.5 form-urlencoded / text/plain ⇒ 415 且未进入全局解析器（若进了全局 urlencoded 解析器，合法字段会让对象被建出来）
    const formName = uniq('form_fdl');
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH, 'Content-Type': 'application/x-www-form-urlencoded' }, chunks: [`obj_type=FDL_TASK&obj_name=${formName}`] });
    check('x-www-form-urlencoded ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    check('x-www-form-urlencoded 未进入全局解析器：合法字段没有把对象建出来', (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ?', [formName])).c === 0);
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH, 'Content-Type': 'text/plain' }, chunks: [JSON.stringify({ obj_type: 'FDL_TASK', obj_name: formName })] });
    check('text/plain ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    check('text/plain 未被任何解析器接管：对象没有被建出来', (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ?', [formName])).c === 0);
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH }, chunks: [JSON.stringify({ obj_type: 'FDL_TASK', obj_name: formName })] });
    check('带请求体但没有 Content-Type ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api/models/${mCc}/impl-links`, headers: { ...tokenH, 'Content-Type': 'application/x-www-form-urlencoded' }, chunks: ['links=1'] });
    check('impl-links 路径：x-www-form-urlencoded ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    // Y6：同前缀下其余写端点（/doc 与 PUT /:id 改 summary）同样受 415 与 2.5MB 限制，且零写入
    {
      for (const [label, urlPath, small, formBody] of [
        ['/doc', `/api/model-impl-objects/${oProc}/doc`, { doc_path: 'docs/y6.sql', doc_source: 'y6-doc' }, 'doc_path=docs/y6.sql&doc_source=y6-doc'],
        ['PUT /:id（summary）', `/api/model-impl-objects/${oProc}`, { summary: 'y6-summary' }, 'summary=y6-summary'],
      ]) {
        const big = Buffer.from(JSON.stringify({ ...small, pad: 'a'.repeat(3 * 1024 * 1024) }));   // 小而合法的字段 + 3MB 多余字段：只有传输层上限能拒
        const rowBefore = stableObj(await objRow(oProc)); const cntBefore = JSON.stringify(await countAll());
        let x = await rawHttp(baseUrl, { method: 'PUT', urlPath, headers: { ...tokenH, 'Content-Type': 'application/json' }, chunks: mkChunks(big, 64 * 1024) });
        check(`Y6 ${label}：分块传输累计 3MB ⇒ 413`, x.status === 413, JSON.stringify(x).slice(0, 200));
        x = await rawHttp(baseUrl, { method: 'PUT', urlPath, headers: { ...tokenH, 'Content-Type': 'application/json', 'Content-Length': String(big.length) }, chunks: mkChunks(big, 64 * 1024) });
        check(`Y6 ${label}：声明 Content-Length 3MB ⇒ 413`, x.status === 413, JSON.stringify(x).slice(0, 200));
        x = await rawHttp(baseUrl, { method: 'PUT', urlPath, headers: { ...tokenH, 'Content-Type': 'application/x-www-form-urlencoded' }, chunks: [formBody] });
        check(`Y6 ${label}：x-www-form-urlencoded ⇒ 415`, x.status === 415, JSON.stringify(x).slice(0, 200));
        check(`Y6 ${label}：以上三个请求零写入（对象行逐字段不变，对象 / 关系 / 留痕行数不变）`, stableObj(await objRow(oProc)) === rowBefore && JSON.stringify(await countAll()) === cntBefore, rowBefore.slice(0, 200));
      }
    }
    // 修复 1·W1：双斜杠路径与业务路由走同一挂载点裁剪语义，前置门不得被绕过（`/api//…` 能命中业务路由，也必须命中前置门）
    const dsName = uniq('dslash_fdl');
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api//model-impl-objects', headers: { ...tokenH, 'Content-Type': 'application/x-www-form-urlencoded' }, chunks: [`obj_type=FDL_TASK&obj_name=${dsName}`] });
    check('W1 双斜杠 /api//model-impl-objects：x-www-form-urlencoded ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    check('W1 双斜杠表单请求未进入全局解析器：对象没有被建出来', (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ?', [dsName])).c === 0);
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api//model-impl-objects/${oProc}/source`, headers: { ...tokenH, 'Content-Type': 'application/json', 'Content-Length': String(chunkBody.length) }, chunks: mkChunks(chunkBody, 64 * 1024) });
    check('W1 双斜杠 /api//model-impl-objects/:id/source：3MB JSON ⇒ 413', rr.status === 413, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api//models/${mCc}/impl-links`, headers: { ...tokenH, 'Content-Type': 'application/json', 'Content-Length': String(linksBig.length) }, chunks: mkChunks(linksBig, 64 * 1024) });
    check('W1 双斜杠 /api//models/:id/impl-links：3MB JSON ⇒ 413', rr.status === 413, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'PUT', urlPath: `/api//models/${mCc}/impl-links`, headers: { ...tokenH, 'Content-Type': 'text/plain' }, chunks: ['links=1'] });
    check('W1 双斜杠 /api//models/:id/impl-links：text/plain ⇒ 415', rr.status === 415, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api//model-impl-objects', headers: { ...tokenH, 'Content-Type': 'application/json' }, chunks: [JSON.stringify({ obj_type: 'FDL_TASK', obj_name: uniq('dslash_ok') })] });
    check('W1 双斜杠路径的合法 JSON 请求照常处理 ⇒ 200', rr.status === 200, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH, 'Content-Type': 'application/json; charset=utf-8' }, chunks: [JSON.stringify({ obj_type: 'FDL_TASK', obj_name: formName })] });
    check('application/json; charset=utf-8 ⇒ 200 正常处理（并真的建出对象）', rr.status === 200 && (await rd.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE obj_name = ?', [formName])).c === 1, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH, 'Content-Type': 'APPLICATION/JSON' }, chunks: [JSON.stringify({ obj_type: 'FDL_TASK', obj_name: uniq('upper_ct') })] });
    check('Content-Type 大小写不敏感（APPLICATION/JSON）⇒ 200', rr.status === 200, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'DELETE', urlPath: '/api/model-impl-objects/99999999', headers: { ...tokenH, 'Content-Length': '0' }, chunks: [] });
    check('无请求体的 DELETE（Content-Length: 0、无 Content-Type）不被 415 误拦 ⇒ 404（对象不存在）', rr.status === 404, JSON.stringify(rr).slice(0, 200));
    rr = await rawHttp(baseUrl, { method: 'POST', urlPath: '/api/model-impl-objects', headers: { ...tokenH, 'Content-Type': 'application/json' }, chunks: ['{"obj_type":'] });
    check('请求体是不完整 JSON ⇒ 400（解析层拒绝，未进入处理器）', rr.status === 400, JSON.stringify(rr).slice(0, 200));
    const cnt1 = await countAll();
    check('请求体上限各拒绝用例：对象行数 / 关系行数 / 留痕行数只增不乱（本段只有三次 200 新建（charset=utf-8、大写 Content-Type、双斜杠合法请求）= +3 对象）', cnt1.objs === cnt0.objs + 3 && cnt1.links === cnt0.links && cnt1.logs === cnt0.logs, `${JSON.stringify(cnt0)} → ${JSON.stringify(cnt1)}`);
    void oBody;

    // ═════════ 十二、收尾：服务运行期间测试进程写库次数 = 0；无 3000 端口 ═════════
    check('前提：被测服务端口不是 3000，库不是本机真实库', svc.port !== 3000 && path.resolve(dbPath) !== H.REAL_DB_ABS, `port=${svc.port}`);
    check('服务运行期间测试进程写库次数 = 0（写连接只在服务停止时使用，写闸计数）', gate.writes === 0, `writes=${gate.writes}`);
  } catch (e) {
    let tail = '';
    try { tail = fs.readFileSync(svc.inst ? svc.inst.logPath : path.join(copyRoot, 'svc.server.log'), 'utf8').slice(-1800); } catch (_) { /* ignore */ }
    fail++;
    console.log(`FAIL 套件异常：${e && e.stack || e}\n  [诊断] 被测服务状态=${svc.inst ? svc.inst.state() : '未运行'}；服务日志尾部：\n${tail}`);
  } finally {
    try { if (rd) await rd.close(); } catch (_) { /* ignore */ }
    try { await svc.stop(); } catch (_) { /* ignore */ }
    H.removeTree(runDir);
  }
  console.log(`verify-model-impl-objects PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

(process.argv.includes('--self-test') ? Promise.resolve(selfTest()) : main()).catch((e) => { console.log(`FAIL 套件异常：${e && e.stack || e}`); process.exitCode = 1; }).finally(() => {
  H.runCleanupsSync();
  if (H.cleanupFailures.length) { console.log(`FAIL 清理复查：${H.cleanupFailures.length} 项未通过（临时目录 / 进程仍在）\n  ${H.cleanupFailures.join('\n  ')}`); process.exitCode = 1; }
});
