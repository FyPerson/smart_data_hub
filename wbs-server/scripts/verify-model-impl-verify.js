// verify-model-impl-verify.js — #77 C2b-2 norm_v1 规范化 + 三端核验（即时 + 每日）+ 徽章 + C2b-1 审查遗留三项（方案 v0.9 §4.4 / §6.1 C2b / §7.1）
//
// 运行面（自包含、零真实库、不连任何 SQL Server、不起 3000 端口）：
//   被测模块一律取「临时目录里的源码副本」（变异只改副本）；实现对象模块在进程内以工厂构造，挂在回环端口的 express 上，
//   库是临时目录里的 sqlite 文件（表结构直接从副本 server.js 的建表 SQL 里抠出来，不手抄）；
//   读生产定义的 SQL Server 查询层一律用桩（readDefinition 注入 / 假连接池），测试里没有任何真实连接。
// 断言期望值全部手写（哈希期望用独立 crypto 对手写的规范化文本现算，不引用被测函数的输出当期望）。
//
// 真实夹具：E:/projects/data-warehouse/docs/_common/平台核验夹具/ 下三个 .sql 是从生产只读取到的定义原文（过程 / 视图 / 库级触发器），
//   已逐个用 HASHBYTES(SHA2_256) 与 UTF-16LE 本地哈希核对为逐字节一致；与数仓仓库对应文件分别规范化后比较哈希。
//
// 变异自证（--self-test）：对副本逐个做破坏性改动，每个变异须使本套件判红且「首条」失败断言以 expectPrefix 开头（严格因果）；
//   单个变异：node scripts/verify-model-impl-verify.js --mutation=<id>
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { spawnSync } = require('node:child_process');
const H = require('./verify-model-config-rev-http.js');

// 生产定义快照放在数仓项目里（wbs-server 是公开镜像的同步源，生产定义不进平台仓库）；夹具或数仓底稿缺失一律判 FAIL（fail-closed）
const DW = 'E:/projects/data-warehouse/docs/';
const FIX_DIR = DW + '_common/平台核验夹具';
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const turn = () => new Promise((r) => setImmediate(r));                      // 让出一轮事件循环（不是等真实时间）
const turns = async (n) => { for (let i = 0; i < n; i++) await turn(); };

// ───────────────────────────── 变异表 ─────────────────────────────
const NORM = ['routes', 'model-center', 'sql-normalize.js'];
const VER = ['routes', 'model-center', 'impl-verify.js'];
const OBJ = ['routes', 'model-center', 'impl-objects.js'];
const SWEEP = ['routes', 'model-center', 'daily-sweep.js'];
const MUTATIONS = [
  { id: 'norm-body-create', label: 'V-1 norm 第 5 步把正文里的 CREATE OR ALTER 也改掉', expectPrefix: 'norm_v1 不等价：正文中出现 CREATE OR ALTER', file: NORM,
    from: "if (m) s = s.slice(0, p) + 'CREATE ' + m[1].toUpperCase() + s.slice(p + m[0].length);",
    to: "if (m) s = s.slice(0, p) + 'CREATE ' + m[1].toUpperCase() + s.slice(p + m[0].length).replace(/CREATE\\s+OR\\s+ALTER\\s+/gi, 'CREATE ');" },
  { id: 'no-cr-unify', label: 'V-2 去掉 CR / CRLF 统一为 LF', expectPrefix: 'norm_v1 手写期望：CRLF', file: NORM, from: "s = s.replace(/\\r\\n?/g, '\\n');", to: 's = s;' },
  { id: 'fail-updates-verified', label: 'V-3 失败时把 verified_at 也更新了', expectPrefix: '落库·连库失败：verified_at 不动', file: VER,
    from: "SET last_attempt_at = datetime('now','localtime'), last_error = ?", to: "SET verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = ?" },
  { id: 'null-def-missing', label: 'V-4 定义为 NULL 记成 prod_missing', expectPrefix: '落库·存在但定义为 NULL', file: VER,
    from: "if (res.definition === null || res.definition === undefined) return fail('无权读取定义');",
    to: "if (res.definition === null || res.definition === undefined) { await write(SQL_WRITE_MISSING, [obj.id]); return { outcome: 'missing' }; }" },
  { id: 'stale-6d', label: 'V-5 7 天阈值改成大于等于 6 天', expectPrefix: '徽章·时钟钉死：verified_at 为 6 天 23 小时', file: VER, from: 'age > STALE_MS', to: 'age >= 6 * 86400000' },
  { id: 'recompute-bumps', label: 'V-6 启动重算时递增了 config_rev', expectPrefix: '启动重算：config_rev 不变', file: OBJ, from: 'updated += r.changes;', to: "updated += r.changes; await bumpConfigRev(conn, (await all('SELECT model_id FROM model_impl_links WHERE object_id = ?', [rid])).map((x) => x.model_id));" },
  { id: 'go-case-sensitive', label: 'V-7 GO 检查改成区分大小写（去掉 i 标志）：小写 / 混合大小写的独占 go 行被放过', expectPrefix: 'GO 检查：独占一行的 GO', file: NORM, from: ")?$', 'i');", to: ")?$', '');" },
  { id: 'read-concat', label: 'V-8 读定义改为字符串拼接', expectPrefix: '参数化静态断言', file: VER,
    from: 'const r = await req.query(SQL_READ_BY_SCHEMA);',
    to: `const r = await req.query(SQL_READ_BY_SCHEMA.split('@s').join("N'" + obj.schema_name + "'").split('@n').join("N'" + obj.obj_name + "'"));` },
  { id: 'purge-no-recheck', label: 'V-9 purgeLinksOfModel 去掉目标状态复核（0a）', expectPrefix: '0a 目标仍是独立模型', file: OBJ,
    from: "if (!target || target.companion_of !== expectedParentId || target.is_deleted === 1) {", to: 'if (false) {' },
  { id: 'server-no-expected-parent', label: 'V-10 server.js 转伴生一处不传 expectedParentId（0a）', expectPrefix: '0a server.js：每处 account: true', file: ['server.js'],
    from: 'purgeLinksOfModel(existing.id, { account: true, expectedParentId: parentId, user: { id: userId, display_name: userName } }).catch((pErr) => logger.error(`伴生转换：清理 id=${existing.id} 的实现对象关系失败: ${pErr && pErr.message}`));\n                        updateCompanionModelId',
    to: 'purgeLinksOfModel(existing.id, { account: true, user: { id: userId, display_name: userName } }).catch((pErr) => logger.error(`伴生转换：清理 id=${existing.id} 的实现对象关系失败: ${pErr && pErr.message}`));\n                        updateCompanionModelId' },
  { id: 'hooks-unchecked', label: 'V-11 工厂不校验观察钩子类型（0b）', expectPrefix: '0b 钩子', file: OBJ, from: "if (v !== undefined && typeof v !== 'function') throw new Error(`impl-objects：钩子", to: "if (false) throw new Error(`impl-objects：钩子" },
  { id: 'compare-raw-text', label: 'V-12 源码变化改按原文比较（空白 / 换行 / 对象头大小写也递增）', expectPrefix: '记账·norm_v1：只改空白', file: OBJ,
    from: 'if (!isBlank(oldHash) && oldHash !== newHash) {', to: 'if (!isBlank(oldHash) && obj.reg_source !== t.value.text) {' },
  { id: 'badge-time-compare', label: 'V-16 徽章第 3 行恢复成按时间列比较', expectPrefix: '徽章·行 3 边界', file: VER, from: 'if (hasError) {', to: 'if (hasError && (!hasVerified || (nonEmpty(obj.last_attempt_at) && obj.last_attempt_at > obj.verified_at))) {' },
  { id: 'no-queue', label: 'V-17 去掉核验串行队列（同一对象并发触发各自读取、旧读取可覆盖新读取）', expectPrefix: 'W1 同一对象并发触发', file: VER, from: 'const verifyObject = (objectId) => enqueue(objectId);', to: 'const verifyObject = (objectId) => runOne(objectId);' },
  { id: 'clock-fail-clears-due', label: 'V-18 读时钟失败时清空 due（当天触发被顺延到次日）', expectPrefix: 'W2 读时钟失败', file: SWEEP, from: 'else { delay = retryDelay(); }', to: 'else { due = null; delay = retryDelay(); }' },
  { id: 'recompute-no-trycatch', label: 'V-19 重算单行失败不跳过（整体中断）', expectPrefix: 'W3 一行坏数据', file: OBJ, from: 'failed.push(rid);', to: 'failed.push(rid); throw e;' },
  { id: 'raw-error-stored', label: 'V-20 last_error 落库错误原文', expectPrefix: '落库·连库失败：last_attempt_at 前进为 SQLite 当前时间，last_error 只存分类文案', file: VER, from: 'return fail(classifyError(e), cleanError(e));', to: 'return fail(cleanError(e));' },
  { id: 'doc-put-keeps-raw-reg', label: 'V-21 PUT doc 不顺带处理旧算法行的 reg_hash', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT doc', file: OBJ, from: 'const regHashNow = staleAlgo && !isBlank(obj.reg_source) ? normHash(obj.reg_source) : null;', to: 'const regHashNow = null;' },
  { id: 'source-put-keeps-raw-doc', label: 'V-22 PUT source 不顺带清空旧算法行的 doc_hash', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ, from: 'doc_hash = CASE WHEN ? = 1 THEN NULL ELSE doc_hash END,', to: 'doc_hash = CASE WHEN ? = 2 THEN NULL ELSE doc_hash END,' },
  { id: 'no-nested-comments', label: 'V-23 块注释不按嵌套深度计数', expectPrefix: 'L2 嵌套块注释', file: NORM, from: "if (text.startsWith('/*', j)) { depth++; j += 2; } else if", to: "if (false) { depth++; j += 2; } else if" },
  { id: 'daily-error-as-ok', label: 'V-24 每日任务把 outcome = error 也计入 ok', expectPrefix: 'L4 每日任务', file: SWEEP, from: "if (out && out.outcome === 'error') result.failed.push(id); else result.ok++;", to: 'result.ok++;' },
  { id: 'verify-switch-ignored', label: 'V-25 忽略核验显式开关（只要有读取器就启用）', expectPrefix: 'L9 核验开关', file: OBJ, from: '(deps.verifyEnabled === true && readDefinition)', to: 'readDefinition' },
  { id: 'go-nbsp', label: 'V-26 GO 检查的空白不含 NBSP', expectPrefix: 'GO 检查：独占一行的 GO（后跟 NBSP）', file: NORM, from: 'String.fromCharCode(0xA0)', to: 'String.fromCharCode(0x20)' },
  { id: 'fail-after-stop', label: 'V-27 队列已停止后在途项失败仍写库（去掉 writable 的写前检查与锁内复查）', expectPrefix: 'U2 等写锁期间停服超时', edits: [
    { file: VER, from: "            if (!writable) return { outcome: 'stopped' };\n            const w = await write(sql, params);", to: "            const w = await write(sql, params);" },
    { file: VER, from: '        if (!writable) return STOPPED_MARK;\n', to: '' }] },
  { id: 'rf-rejected', label: 'V-28 PROC 不再接受 RF 类型', expectPrefix: 'L-c', file: VER, from: "PROC: ['P', 'RF']", to: "PROC: ['P']" },
  { id: 'server-no-verify-enabled', label: 'V-29 server.js 挂载 impl-objects 时删掉 verifyEnabled: true', expectPrefix: 'L-e server.js 挂载', file: ['server.js'],
    from: '  verifyEnabled: true,   // C2b-2：三端核验显式开关（仿 expirySweepEnabled，只有严格等于 true 才启用）；本地副本想关闭就改成 false 或删掉本行\n', to: '' },
  { id: 'merge-inflight', label: 'V-30 在途项也被合并（合并表项在任务结束后才移出，而不是开始时）', expectPrefix: 'W1 同一对象并发触发', edits: [
    { file: VER, from: 'waiting.delete(objectId);\n            if (!accepting) return', to: 'if (!accepting) return' },
    { file: VER, from: 'waiting.set(objectId, p);', to: 'waiting.set(objectId, p); p.then(() => waiting.delete(objectId), () => waiting.delete(objectId));' }] },
  { id: 'no-sticky', label: 'V-31 对象头匹配去掉 sticky（允许在前置 SQL 后寻找 CREATE）', expectPrefix: 'T4 对象头负例', file: NORM, from: '|FUNCTION)\\b/iy;', to: '|FUNCTION)\\b/i;' },
  { id: 'header-keyword-case', label: 'V-32 对象头关键字不再转大写', expectPrefix: 'norm_v1 手写期望：对象头小写', file: NORM, from: "'CREATE ' + m[1].toUpperCase() + s.slice", to: "'CREATE ' + m[1] + s.slice" },
  { id: 'stale-before-failed', label: 'V-33 徽章把 stale 判断提到核验失败之前', expectPrefix: 'T1 徽章优先级', file: VER,
    from: '    if (hasError) {', to: '    if (civilMs(nowText) - civilMs(obj.verified_at) > STALE_MS) return { doc: LABEL.STALE, reg: LABEL.STALE };\n    if (hasError) {' },
  { id: 'failure-bypasses-lock', label: 'V-34 失败分支的写库绕开模块锁', expectPrefix: 'T2 落库锁序', file: VER,
    from: '            const w = await write(sql, params);', to: '            const w = await (sql === SQL_WRITE_FAILURE ? run(sql, params) : write(sql, params));' },
  { id: 'double-update', label: 'V-35 每种结果写两条等价 UPDATE（同一把锁内）', expectPrefix: 'T6 三态写库', file: VER,
    from: '            const w = await write(sql, params);', to: "            const w = await withWriteLock('verify', false, async () => { await run(sql, params); return run(sql, params); });" },
  { id: 'abnormal-no-write', label: 'V-36 读取结果无法识别时直接返回 error 而不落库', expectPrefix: 'T7 读取结果异常', file: VER,
    from: "return fail('查询出错', '读取生产定义返回了无法识别的结果');", to: "return { outcome: 'error', error: '查询出错' };" },
  { id: 'ignore-can-view', label: 'V-37 忽略 can_view（无对象行一律当缺失）', expectPrefix: 'R1 无对象行且 can_view = 0', file: VER,
    from: 'if (Number(hit.can_view) === 1) return { exists: false, definition: null };', to: 'return { exists: false, definition: null };' },
  { id: 'sql-inner-join', label: 'V-38 库级触发器 SQL 的 LEFT JOIN sys.sql_modules 改成 INNER JOIN', expectPrefix: 'T3 读定义 SQL 文本', file: VER,
    from: 'LEFT JOIN sys.sql_modules', to: 'INNER JOIN sys.sql_modules' },
  { id: 'sql-or-1-1', label: 'V-39 读定义 SQL 的 WHERE 加 OR 1 = 1', expectPrefix: 'T3 读定义 SQL 文本', file: VER,
    from: "QUOTENAME(@n))) AS q", to: "QUOTENAME(@n)) OR 1 = 1) AS q" },
  { id: 'commit-check-failure-only', label: 'V-40 写前检查只对失败路径生效（成功路径停服后仍写库）', expectPrefix: 'U2 等写锁期间停服超时', edits: [
    { file: VER, from: "            if (!writable) return { outcome: 'stopped' };\n            const w = await write(sql, params);", to: "            if (!writable && outcome.outcome === 'error') return { outcome: 'stopped' };\n            const w = await write(sql, params);" },
    { file: VER, from: '        if (!writable) return STOPPED_MARK;\n', to: "        if (!writable && sql === SQL_WRITE_FAILURE) return STOPPED_MARK;\n" }] },
  { id: 'manual-no-timeout', label: 'V-41 手动核验端点不设等待上限', expectPrefix: 'R4 手动核验：队列很长', file: OBJ,
    from: 'timer = setT(() => resolve(TIMEOUT), MANUAL_VERIFY_WAIT_MS);', to: 'timer = setT(() => {}, MANUAL_VERIFY_WAIT_MS);' },
  { id: 'recompute-keeps-verify', label: 'V-42 重算不清空旧核验数据', expectPrefix: 'U3 迁移只用一条 UPDATE：重算', file: OBJ,
    from: ', prod_hash = NULL, prod_missing = 0, verified_at = NULL, last_attempt_at = NULL, last_error = NULL WHERE id = ? AND hash_algo IS NOT ?', to: ' WHERE id = ? AND hash_algo IS NOT ?' },
  { id: 'put-keeps-verify', label: 'V-43 旧算法行 PUT 时不清空旧核验数据', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: 'prod_hash = CASE WHEN ? = 1 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 1 THEN 0 ELSE prod_missing END,\n                            verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE last_attempt_at END,\n                            last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END,\n                            updated_at = datetime(\'now\',\'localtime\'), updated_by = ?\n                      WHERE id = ? AND is_deleted = 0`,\n                    [t.value.text',
    to: 'prod_hash = CASE WHEN ? = 9 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 9 THEN 0 ELSE prod_missing END,\n                            verified_at = CASE WHEN ? = 9 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 9 THEN NULL ELSE last_attempt_at END,\n                            last_error = CASE WHEN ? = 9 THEN NULL ELSE last_error END,\n                            updated_at = datetime(\'now\',\'localtime\'), updated_by = ?\n                      WHERE id = ? AND is_deleted = 0`,\n                    [t.value.text' },
  { id: 'retry-constant', label: 'V-44 退避延迟恒为 60 秒（不递增、无上限语义）', expectPrefix: 'T5 退避', file: SWEEP, from: 'const retryDelay = () => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failStreak - 1, 16));', to: 'const retryDelay = () => 60000;' },
  { id: 'stale-ge', label: 'V-45 stale 边界改成大于等于（恰好 7 天也算待重核）', expectPrefix: 'U5 stale 边界：恰好 7 天', file: VER, from: 'age > STALE_MS', to: 'age >= STALE_MS' },
  { id: 'stale-nan-open', label: 'V-46 时间无法解析时不再 fail-closed 为 stale', expectPrefix: 'U5 无法解析', file: VER, from: '!Number.isFinite(age) || age > STALE_MS', to: 'age > STALE_MS' },
  { id: 'run-outside-lock', label: 'V-47 先空锁、再在锁外执行 UPDATE', expectPrefix: 'U1 锁内执行', file: VER,
    from: '            const w = await write(sql, params);', to: "            await withWriteLock('verify', false, async () => {});\n            const w = await run(sql, params);" },
  { id: 'no-lock-recheck', label: 'V-48 去掉锁内的 writable 复查', expectPrefix: 'U2 等写锁期间停服超时', file: VER, from: '        if (!writable) return STOPPED_MARK;\n', to: '' },
  { id: 'recompute-split-clear', label: 'V-49 重算把清理拆成第二条 UPDATE', expectPrefix: 'U3 迁移只用一条 UPDATE：重算', file: OBJ,
    from: 'updated += r.changes;', to: "updated += r.changes; await run('UPDATE model_impl_objects SET last_error = NULL WHERE id = ?', [rid]);" },
  { id: 'stop-wait-30s', label: 'V-50 停服等待默认值改成 30000 毫秒', expectPrefix: 'U4 停服等待默认值', file: VER, from: 'const STOP_WAIT_MS = 3000;', to: 'const STOP_WAIT_MS = 30000;' },
  { id: 'source-split-clear', label: 'V-51 旧算法行 PUT source 把清理拆成第二条 UPDATE', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: '[t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);', to: "[t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);\n                await run('UPDATE model_impl_objects SET last_error = NULL WHERE id = ?', [id]);" },
  { id: 'doc-split-clear', label: 'V-52 旧算法行 PUT doc 把清理拆成第二条 UPDATE', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT doc', file: OBJ,
    from: '[p.value, docHash, HASH_ALGO, staleAlgo, regHashNow, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);', to: "[p.value, docHash, HASH_ALGO, staleAlgo, regHashNow, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);\n                await run('UPDATE model_impl_objects SET last_error = NULL WHERE id = ?', [id]);" },
  { id: 'source-idless-update', label: 'V-53 旧算法行 PUT source 先执行正确的 UPDATE，再加一条不带 id 参数的 UPDATE（按 hash_algo 清理）', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: '[t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);', to: "[t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);\n                await run(\"UPDATE model_impl_objects SET last_error = NULL WHERE hash_algo = 'raw_v0'\", []);" },
  { id: 'recompute-idless-update', label: 'V-54 重算每行额外执行一条不带 id 的 UPDATE', expectPrefix: 'U3 迁移只用一条 UPDATE：重算', file: OBJ,
    from: 'updated += r.changes;', to: "updated += r.changes; await run('UPDATE model_impl_objects SET last_error = last_error WHERE hash_algo IS NOT NULL', []);" },
  { id: 'commit-idless-update', label: 'V-55 核验落库后额外执行一条不带 id 的 UPDATE', expectPrefix: 'T6 三态写库：成功', file: VER,
    from: '            if (w === STOPPED_MARK) return { outcome: \'stopped\' };', to: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };\n            await run(\"UPDATE model_impl_objects SET last_error = last_error WHERE prod_hash IS NOT NULL AND 1 = 1\", []);" },
  { id: 'civil-no-readback', label: 'V-56 civilMs 去掉回读校验', expectPrefix: 'V2 严格解析', file: VER, from: 'return readbackOk ? t : NaN;', to: 'return t;' },
  { id: 'endpoint-stopped-as-done', label: 'V-57 手动核验端点把 stopped 当成「核验完成」', expectPrefix: 'V3 手动核验', file: OBJ,
    from: "if (outcome !== TIMEOUT && outcome.outcome === 'stopped') throw", to: "if (false) throw" },
  { id: 'daily-stopped-as-ok', label: 'V-58 每日任务把 stopped 当作 ok 继续', expectPrefix: 'V3 每日任务', file: SWEEP,
    from: "if (out && out.outcome === 'stopped') { result.stopped = true; result.terminal = typeof isTerminal === 'function' && !!isTerminal(); break; }", to: '' },
  { id: 'put-source-or-second-id', label: 'V-59 旧算法行 PUT source 的 WHERE 改成 id = ? OR id = ?，并多传另一对象（id + 1）的 id', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: "WHERE id = ? AND is_deleted = 0`,\n                    [t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id]);",
    to: "WHERE id = ? OR id = ?`,\n                    [t.value.text, newHash, HASH_ALGO, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, staleAlgo, userLabel(req.user), id, id + 1]);" },
  { id: 'put-source-delete-insert', label: 'V-60 旧算法行 PUT source 先执行正确的 UPDATE，再对目标行 DELETE + INSERT 恢复原样', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: '// 方案 §4.1.1 A 表原句：reg_hash 由非空值变为另一非空值才递增',
    to: "const cur = await get('SELECT * FROM model_impl_objects WHERE id = ?', [id]); const ks = Object.keys(cur); await run('DELETE FROM model_impl_objects WHERE id = ?', [id]); await run('INSERT INTO model_impl_objects (' + ks.join(', ') + ') VALUES (' + ks.map(() => '?').join(', ') + ')', ks.map((k) => cur[k]));\n                // 方案 §4.1.1 A 表原句：reg_hash 由非空值变为另一非空值才递增" },
  { id: 'put-source-replace-other', label: 'V-61 旧算法行 PUT source 先执行正确的 UPDATE，再对另一行（id + 1）执行 REPLACE（行内容不变）', expectPrefix: 'U3 迁移只用一条 UPDATE：旧算法行 PUT source', file: OBJ,
    from: '// 方案 §4.1.1 A 表原句：reg_hash 由非空值变为另一非空值才递增',
    to: "await run('REPLACE INTO model_impl_objects SELECT * FROM model_impl_objects WHERE id = ?', [id + 1]);\n                // 方案 §4.1.1 A 表原句：reg_hash 由非空值变为另一非空值才递增" },
  { id: 'recompute-extra-norm-update', label: 'V-62 重算每处理一行，额外更新一个 norm_v1 行（内容不变），并把 updated 计数加 1', expectPrefix: 'U3 迁移只用一条 UPDATE：重算', file: OBJ,
    from: 'updated += r.changes;', to: "updated += r.changes; await run('UPDATE model_impl_objects SET last_error = last_error WHERE id = (SELECT MIN(id) FROM model_impl_objects WHERE hash_algo = ?)', [HASH_ALGO]); updated += 1;" },
  { id: 'verify-writes-change-log', label: 'V-63 核验落库之后，再对 model_change_logs 写一条记录（其他表的副作用）', expectPrefix: 'T6 三态写库：成功', file: VER,
    from: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };", to: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };\n            await run(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object')\", []);" },
  { id: 'sweep-stopped-as-success', label: 'V-64 每日任务调度把 stopped 的一轮当成功（清零退避、due 推进到次日）', expectPrefix: 'V4 每日任务 stopped 契约', file: SWEEP,
    from: 'if (result.stopped) { stoppedRound = true; if (result.terminal) terminated = true; }\n                else if (result.skipped) { skippedRound = true; }\n                else if (!result.cancelled) {', to: 'if (!result.skipped && !result.cancelled) {' },
  { id: 'stale-algo-needs-nonblank', label: 'V-78 PUT source / PUT doc 的旧算法判定改回「hash_algo 非空且不是 norm_v1」（NULL 算法行被当成已迁移，与启动重算口径不一致）', expectPrefix: 'M1 记账·hash_algo 为 NULL 且有哈希材料的行 PUT source', edits: [
    { file: OBJ, from: 'const staleAlgo = isStaleAlgoRow(obj) ? 1 : 0;\n                const r = await run(', to: 'const staleAlgo = !isBlank(obj.hash_algo) && obj.hash_algo !== HASH_ALGO ? 1 : 0;\n                const r = await run(' },
    { file: OBJ, from: 'const staleAlgo = isStaleAlgoRow(obj) ? 1 : 0;\n                const regHashNow', to: 'const staleAlgo = !isBlank(obj.hash_algo) && obj.hash_algo !== HASH_ALGO ? 1 : 0;\n                const regHashNow' }] },
  { id: 'stale-algo-ignores-material', label: 'V-79 旧算法判定去掉「至少一项哈希材料非空」条件（只看 hash_algo 不是 norm_v1：无哈希材料的 NULL 算法行被当成旧算法行，首次 PUT 清掉它的核验数据）', expectPrefix: 'M1/LOW-3 记账·', file: OBJ,
    from: 'const isStaleAlgoRow = (o) => o.hash_algo !== HASH_ALGO && hasHashMaterial(o);', to: 'const isStaleAlgoRow = (o) => o.hash_algo !== HASH_ALGO;' },
  { id: 'sweep-skipped-spin', label: 'V-77 每日任务未就绪（skipped）的一轮不固定 60 秒（due 已过时按 due - now 钳成 1 毫秒空转）', expectPrefix: 'M3 每日任务未就绪', file: SWEEP,
    from: 'if (stoppedRound || skippedRound) delay = 60000;', to: 'if (stoppedRound) delay = 60000;' },
  { id: 'sweep-terminal-ignored', label: 'V-67 每日任务调度忽略 terminal（stopped 且队列已永久停止仍每 60 秒重试）', expectPrefix: 'G4 每日任务终态：调度器', file: SWEEP,
    from: 'if (result.terminal) terminated = true;', to: 'if (false) terminated = true;' },
  { id: 'sweep-terminal-not-wired', label: 'V-68 实现对象模块不给每日任务传 isTerminal（终态靠 stopService 的调用顺序）', expectPrefix: 'G4 每日任务终态：实现对象模块接线', file: OBJ,
    from: 'isTerminal: () => !verifier.isAccepting(),', to: '' },
  { id: 'g1a-require-sqlite3', label: 'V-65 impl-verify.js require sqlite3 并在核验落库后新开连接写库', expectPrefix: 'G1a 静态', edits: [
    { file: VER, from: "const { normalizeSqlDefinition } = require('./sql-normalize');", to: "const { normalizeSqlDefinition } = require('./sql-normalize');\nconst sqliteBackdoor = require('sqlite3');" },
    { file: VER, from: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };", to: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };\n            new sqliteBackdoor.Database(':memory:').run('CREATE TABLE zz (a)');" }] },
  { id: 'g1b-detached-run', label: 'V-69 impl-verify 把连接的 run 拆出来裸调（不经传入的 Proxy 调用；K1c 之后方法取出当值在静态侧就被挡住）', expectPrefix: 'H1 静态：对数据库句柄', file: VER,
    from: "conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); });", to: "const cb0 = function (err) { if (err) reject(err); else resolve({ changes: this.changes }); }; if (String(conn.run).includes('badIdentity')) { const r0 = conn.run; r0(sql, params, cb0); } else conn.run(sql, params, cb0);" },
  { id: 'h1-serialize-restore', label: 'V-70 impl-verify 用 conn.serialize 的回调里的 this.run 写一条再恢复', expectPrefix: 'H1 静态：对数据库句柄', file: VER,
    from: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };", to: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };\n            conn.serialize(function () { this.run(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object')\"); this.run(\"DELETE FROM model_change_logs WHERE model_name = 'x'\"); });" },
  { id: 'h1-require-alias', label: 'V-71 impl-verify 里 const r = require; r(\'sqlite3\')', expectPrefix: 'H1 静态：require 只以', file: VER,
    from: "const { normalizeSqlDefinition } = require('./sql-normalize');", to: "const { normalizeSqlDefinition } = require('./sql-normalize');\nconst r0 = require; r0('sqlite3');" },
  { id: 'h1-module-require', label: 'V-72 impl-verify 里 module.require(\'sqlite3\')', expectPrefix: 'H1 静态：require 只以', file: VER,
    from: "const { normalizeSqlDefinition } = require('./sql-normalize');", to: "const { normalizeSqlDefinition } = require('./sql-normalize');\nmodule.require('sqlite3');" },
  { id: 'm1-deferred-timer-write', label: 'V-73 核验落库返回后用 setTimeout(…, 50) 写一条再恢复', expectPrefix: 'M1 静态：定时器', file: VER,
    from: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };", to: "            if (w === STOPPED_MARK) return { outcome: 'stopped' };\n            setTimeout(() => { run(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object')\", []).then(() => run(\"DELETE FROM model_change_logs WHERE model_name = 'x'\", [])).catch(() => {}); }, 50);" },
  { id: 'k1-return-chain-exec', label: 'V-74 impl-verify 的 run 在合法调用之后经返回值链式调用 exec 写入再恢复', expectPrefix: 'H1 静态：对数据库句柄', file: VER,
    from: "conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); });", to: "conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); }).exec(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object'); DELETE FROM model_change_logs WHERE model_name = 'x';\");" },
  { id: 'k1-return-to-local-fn', label: 'V-75 impl-verify 把 run 的返回值传给局部函数，函数里调 .run 写入再恢复', expectPrefix: 'H1 静态：对数据库句柄', file: VER,
    from: "conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); });", to: "const leak = (c) => { c.run(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object')\", []); c.run(\"DELETE FROM model_change_logs WHERE model_name = 'x'\", []); }; leak(conn.run(sql, params, function (err) { if (err) reject(err); else resolve({ changes: this.changes }); }));" },
  { id: 'k2-long-timer-write', label: 'V-76 名单内的定时器（stopDailyVerify 3 秒上限）延迟改成 10001 毫秒、回调里写库，并让它不被清理', expectPrefix: 'K2 默认定时器路径（专门用例）', file: OBJ,
    from: "new Promise((resolve) => { t = setTimeout(resolve, 3000); if (t.unref) t.unref(); }),", to: "new Promise((resolve) => { t = setTimeout(() => { resolve(); run(\"INSERT INTO model_change_logs (model_id, model_name, action, change_type) VALUES (NULL, 'x', 'UPDATE', 'impl_object')\", []).then(() => run(\"DELETE FROM model_change_logs WHERE model_name = 'x'\", [])).catch(() => {}); }, 10001); if (t.unref) t.unref(); t = null; }),"},
  { id: 'g1c-fixture-trigger', label: 'V-66 夹具库里加触发器：UPDATE model_impl_objects 时往另一张表写一行', expectPrefix: 'T6 三态写库：成功', fixture: 'trigger', edits: [] },
  { id: 'sweep-minute', label: 'V-13 每日触发时刻不是 07:30', expectPrefix: '调度·下一次触发时刻', file: OBJ, from: 'const DAILY_VERIFY_MINUTE = 30;', to: 'const DAILY_VERIFY_MINUTE = 0;' },
  { id: 'sweep-stop-noop', label: 'V-14 stop 不停定时器 / 不置停止标志', expectPrefix: '调度·stopService 后不再触发', file: SWEEP,
    from: 'epoch++; started = false; stopped = true;\n        if (timer !== null) { clearTimer(timer); timer = null; }', to: 'if (false) { clearTimer(timer); }' },
  { id: 'no-fixed-time-columns', label: 'V-15 成功落库的时间列改由 JS 传入', expectPrefix: '落库·对象存在', file: VER,
    from: "verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = NULL WHERE id = ? AND is_deleted = 0`;\nconst SQL_WRITE_MISSING",
    to: "verified_at = '2000-01-01 00:00:00', last_attempt_at = '2000-01-01 00:00:00', last_error = NULL WHERE id = ? AND is_deleted = 0`;\nconst SQL_WRITE_MISSING" },
];
const mutArg = process.argv.find((x) => x.startsWith('--mutation='));
const MUTATION = mutArg ? MUTATIONS.find((m) => m.id === mutArg.slice('--mutation='.length)) : null;
if (mutArg && !MUTATION) { console.log('FAIL 未知变异：' + mutArg); process.exit(1); }

function selfTest() {
  let pass = 0, fail = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [__filename, '--mutation=' + m.id], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 240000 });   // 单个变异最多跑 4 分钟，超时按「没有判红」处理，不让自测挂死
    if (r.error || r.signal) { fail++; console.log('FAIL 变异 ' + m.label + '：超时或被杀（' + ((r.error && r.error.code) || r.signal) + '），不计为判红'); continue; }
    const out = (r.stdout || '') + (r.stderr || '');
    const fails = out.split('\n').filter((l) => l.startsWith('FAIL '));
    const causal = fails.length > 0 && fails[0].startsWith('FAIL ' + m.expectPrefix);
    if (r.status !== 0 && causal) { pass++; console.log('  变异 ' + m.label + ' → 判红（' + fails.length + ' 条失败；首条：' + fails[0].slice(0, 200) + '）'); }
    else { fail++; console.log('FAIL 变异 ' + m.label + '：' + (r.status === 0 ? '没有任何断言变红' : '变红了但首条失败不是预期的「' + m.expectPrefix + '」类断言：' + (fails[0] || out.slice(-300)).slice(0, 240))); }
  }
  console.log('verify-model-impl-verify --self-test PASS=' + pass + ' FAIL=' + fail);
  process.exitCode = fail === 0 ? 0 : 1;
}

// ───────────────────────────── 小工具 ─────────────────────────────
// K1a 放行标记：只有「经测试自己的 Proxy / 测试助手」发起的数据库调用才会把它置真，且只覆盖这一次同步调用（sqlite3 的 run / get / all / exec 都是同步入队），调用返回后立即复位；
//   sqlite3.Database 原型上的观察钩子在任何实例（含夹具库的原始连接）上看到写语句而标记不为真，就记为 foreignWrites——拿到原始连接后的任何直接调用（返回值链式、传给别的函数再调）都会被抓到
let viaProxy = false;
const withVia = (fn) => { viaProxy = true; try { return fn(); } finally { viaProxy = false; } };
function dbPromisified(file) {
  const sqlite3 = require('sqlite3');
  const raw = new sqlite3.Database(file);
  const run = (sql, p = []) => new Promise((res, rej) => withVia(() => raw.run(sql, p, function (e) { e ? rej(e) : res({ changes: this.changes, lastID: this.lastID }); })));
  const get = (sql, p = []) => new Promise((res, rej) => withVia(() => raw.get(sql, p, (e, r) => (e ? rej(e) : res(r)))));
  const all = (sql, p = []) => new Promise((res, rej) => withVia(() => raw.all(sql, p, (e, r) => (e ? rej(e) : res(r)))));
  const exec = (sql) => new Promise((res, rej) => withVia(() => raw.exec(sql, (e) => (e ? rej(e) : res()))));
  const close = () => new Promise((res) => raw.close(() => res()));
  // 交给被测模块用的「透传 Proxy」（不记录，只置放行标记）：被测模块的数据库调用一律经它或经记录器 Proxy，不再直接拿原始连接
  const mod = new Proxy(raw, { get(t, k) {
    if (k === 'run' || k === 'get' || k === 'all' || k === 'each' || k === 'exec' || k === 'prepare') return function (...a) { return withVia(() => { const r = t[k](...a); return r === t ? mod : r; }); };
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  return { raw, mod, run, get, all, exec, close };
}
const readFix = (name) => fs.readFileSync(path.join(FIX_DIR, name), 'utf8');
/** 数仓文件里「CREATE 所在的那一个批次」：按独占一行的 GO 切批，取匹配 CREATE 的批次（截取逻辑写在测试里） */
function createBatchOf(file, re) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r\n?|\n/);
  const batches = [[]];
  for (const l of lines) { if (/^[ \t]*go[ \t]*$/i.test(l)) batches.push([]); else batches[batches.length - 1].push(l); }
  const hit = batches.map((b) => b.join('\n')).filter((b) => re.test(b));
  return hit;
}
function firstDiff(a, b) {
  let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return { at: i, a: JSON.stringify(a.slice(Math.max(0, i - 40), i + 60)), b: JSON.stringify(b.slice(Math.max(0, i - 40), i + 60)) };
}

async function main() {
  let pass = 0, fail = 0;
  const check = (name, cond, detail) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`); } };
  const info = (s) => console.log('  [info] ' + s);

  // 被测代码取临时目录里的源码副本
  const runDir = H.makeRunDir('implverify');
  const { copyRoot } = H.copyCode(H.ROOT, path.join(runDir, 'svc'), 'after');
  if (MUTATION) for (const e of (MUTATION.edits || [MUTATION])) H.replaceExactlyOnce(path.join(copyRoot, ...e.file), e.from, e.to, MUTATION.label);
  process.env.NODE_PATH = path.join(H.ROOT, 'node_modules');
  require('node:module')._initPaths();
  const mc = (f) => path.join(copyRoot, 'routes', 'model-center', f);
  const { normalizeSqlDefinition: norm, findGoSeparatorLine } = require(mc('sql-normalize.js'));
  const Ver = require(mc('impl-verify.js'));
  const { createDailySweep, nextAt } = require(mc('daily-sweep.js'));
  const createImplObjects = require(mc('impl-objects.js'));
  const express = require('express');
  const { listenOnSafePort } = require('./lib/listen-safe-port');
  const srvText = fs.readFileSync(path.join(copyRoot, 'server.js'), 'utf8');
  const verText = fs.readFileSync(mc('impl-verify.js'), 'utf8');
  // K2：全局 setTimeout / setInterval / setImmediate 的包装，整个套件期间持续生效，不按延迟值筛选：凡是调用栈里含被测模块副本目录的创建（unref 的也算）都登记到 pendingTimers，
  //   已触发（setInterval 除外）或被 clear* 清理才算结束；套件结束前排空后断言被测模块创建、且尚未结束的定时器为 0
  Error.stackTraceLimit = 40;
  const MC_DIR = path.join(copyRoot, 'routes', 'model-center').replace(/\\/g, '/');
  const pendingTimers = new Map();
  const timerOrig = {};
  for (const [name, kind] of [['setTimeout', 'timeout'], ['setInterval', 'interval'], ['setImmediate', 'immediate']]) {
    const orig = global[name]; timerOrig[name] = orig;
    global[name] = function (fn, ...r) {
      if (typeof fn !== 'function') return orig.call(this, fn, ...r);
      const fromModule = (new Error().stack || '').replace(/\\/g, '/').includes(MC_DIR);
      let h;
      const wrapped = function (...a) { if (kind !== 'interval') pendingTimers.delete(h); return fn.apply(this, a); };
      h = orig.call(this, wrapped, ...r);
      if (fromModule) pendingTimers.set(h, { api: name, ms: kind === 'immediate' ? 0 : r[0] });
      return h;
    };
  }
  for (const name of ['clearTimeout', 'clearInterval', 'clearImmediate']) { const orig = global[name]; timerOrig[name] = orig; global[name] = function (h) { pendingTimers.delete(h); return orig.call(this, h); }; }
  const restoreTimers = () => { for (const [name, orig] of Object.entries(timerOrig)) global[name] = orig; };

  // ═════════ 一、norm_v1：等价 / 不等价夹具（手写期望）═════════
  {
    // T9：每个关键规范化类别都直接写出手写的规范化文本和独立的 SHA-256 期望（十六进制常量由独立工具对手写文本预先算好）；
    //   后面的成对比较只作补充，不是主要 oracle（避免对称性错误同时作用在两侧而假绿）
    for (const [name, input, want, hex] of [
      ["BOM", "" + String.fromCharCode(0xFEFF) + "CREATE PROCEDURE p\nAS\nSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["CRLF", "CREATE PROCEDURE p\r\nAS\r\nSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["单独 CR", "CREATE PROCEDURE p\rAS\rSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["行尾空白与制表符", "CREATE PROCEDURE p  \t\nAS \t\nSELECT 1;  ", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["首尾空行", "\n \n\nCREATE PROCEDURE p\nAS\nSELECT 1;\n\n\t\n", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["对象头 CREATE OR ALTER", "CREATE OR ALTER PROCEDURE p\nAS\nSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["对象头 CREATE + 3 空格", "CREATE   PROCEDURE p\nAS\nSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["对象头小写", "create or alter procedure p\nAS\nSELECT 1;", "CREATE PROCEDURE p\nAS\nSELECT 1;", '0b68ddc8f0adf1e7420e2128950e1d8d473cd126ce0078ef110238171aa8bca0'],
      ["对象头前有头注释", "-- 头注释\ncreate or alter view v AS SELECT 1", "-- 头注释\nCREATE VIEW v AS SELECT 1", 'a54a3e4efe48c558656d15b644d434a01d9bd823f49c852c373af165aca738ef'],
      ["方括号与 schema 限定名", "CREATE OR ALTER PROC [etl].[usp_x]\nAS\nSELECT 1;", "CREATE PROC [etl].[usp_x]\nAS\nSELECT 1;", 'd714677c1d008f3579644b8891ed5e3ca26bfdb981ddd561b9b7a65615caace2'],
      ["行注释与块注释交替", "-- a\n/* b */\n-- c\ncreate or alter trigger t ON DATABASE AS SELECT 1", "-- a\n/* b */\n-- c\nCREATE TRIGGER t ON DATABASE AS SELECT 1", 'b685d81dffccafba4a6d188c3b1f77bed7f8fad7bb0a6a2ac08126736c73e0f0'],
    ]) {
      const g = norm(input);
      check(`norm_v1 手写期望：${name}：规范化文本逐字相等，哈希 = 手写 SHA-256 常量`, g.normalized === want && g.hash === hex, JSON.stringify(g));
    }
    // T4：对象头负例——第一个非注释位置必须就是 CREATE，否则不改写
    {
      const neg = [
        ['DECLARE 之后的 CREATE（不在第一个非注释位置）', 'DECLARE @x int; create  procedure p AS SELECT 1'],
        ['RECREATE PROCEDURE（CREATE 只是标识符的一部分）', 'recreate  procedure p AS SELECT 1'],
        ['CREATE 之后不是对象关键字', 'create  table t (a int)'],
        ['CREATE FUNCTIONX（关键字后紧跟标识符字符）', 'create functionx f'],
      ];
      for (const [name, text] of neg) {
        const g = norm(text);
        check(`T4 对象头负例：${name} ⇒ 原样不改写`, g.normalized === text, JSON.stringify(g));
      }
    }
    const same = (name, a, b) => { const x = norm(a), y = norm(b); check(`norm_v1 等价：${name}`, x.hash === y.hash && x.normalized === y.normalized, `${JSON.stringify(x.normalized)} vs ${JSON.stringify(y.normalized)}`); };
    const diff = (name, a, b) => check(`norm_v1 不等价：${name}`, norm(a).hash !== norm(b).hash);
    const base = 'CREATE PROCEDURE dbo.usp_a\nAS\nSELECT 1;';
    same('CRLF 与 LF', base.replace(/\n/g, '\r\n'), base);
    same('CR 单独换行与 LF', base.replace(/\n/g, '\r'), base);
    same('CREATE OR ALTER 与 CREATE', 'CREATE OR ALTER PROCEDURE dbo.usp_a\nAS\nSELECT 1;', base);
    same('CREATE + 3 个空格', 'CREATE   PROCEDURE dbo.usp_a\nAS\nSELECT 1;', base);
    same('对象头小写', 'create or alter procedure dbo.usp_a\nAS\nSELECT 1;', base);
    same('行尾空白与制表符', 'CREATE PROCEDURE dbo.usp_a  \t\nAS \nSELECT 1;   ', base);
    same('开头 BOM', String.fromCharCode(0xFEFF) + base, base);
    same('开头注释（含 CREATE OR ALTER）', '-- 头注释\nCREATE OR ALTER PROCEDURE dbo.usp_a\nAS\nSELECT 1;', '-- 头注释\nCREATE PROCEDURE dbo.usp_a\nAS\nSELECT 1;');
    same('方括号与 schema 限定名', 'CREATE OR ALTER PROC [etl].[usp_x]\nAS\nSELECT 1;', 'CREATE PROC [etl].[usp_x]\nAS\nSELECT 1;');
    same('头部行注释与块注释交替', '-- a\n/* b\n   b2 */\n-- c\n/* d */\nCREATE OR ALTER VIEW v AS SELECT 1', '-- a\n/* b\n   b2 */\n-- c\n/* d */\nCREATE VIEW v AS SELECT 1');
    same('开头与结尾的空行', '\n\n  \n' + base + '\n\n\t\n', base);
    diff('正文改一个字符', base, 'CREATE PROCEDURE dbo.usp_a\nAS\nSELECT 2;');
    diff('正文中出现 CREATE OR ALTER 字样', 'CREATE PROCEDURE p\nAS\n-- CREATE OR ALTER x\nSELECT 1;', 'CREATE PROCEDURE p\nAS\n-- CREATE x\nSELECT 1;');
    diff('开头注释内容不同（注释不归一）', '-- a\nCREATE PROCEDURE p\nAS\nSELECT 1;', '-- b\nCREATE PROCEDURE p\nAS\nSELECT 1;');
    diff('PROC 与 PROCEDURE 不互相归一（SQL Server 按原样存储）', 'CREATE PROC p\nAS\nSELECT 1;', 'CREATE PROCEDURE p\nAS\nSELECT 1;');
    diff('正文大小写不归一', 'CREATE PROCEDURE p\nAS\nselect 1;', 'CREATE PROCEDURE p\nAS\nSELECT 1;');
    // 手写期望的规范化文本与哈希（哈希用独立 crypto 现算手写文本）
    const hand = 'CREATE PROCEDURE dbo.usp_a\nAS\nSELECT 1;';
    const got = norm(String.fromCharCode(0xFEFF) + '\r\ncreate  or  alter  procedure dbo.usp_a  \r\nAS\r\nSELECT 1;  \r\n\r\n');
    check('norm_v1 手写期望：规范化文本逐字相等，哈希 = 手写文本的 SHA-256', got.normalized === hand && got.hash === sha(hand), JSON.stringify(got));
    check('norm_v1 对象头 PROC 保持 PROC、关键字大写', norm('create or alter proc x as select 1').normalized === 'CREATE PROC x as select 1');
    check('norm_v1 块注释未闭合时不改对象头（原样处理）', norm('/* 未闭合\ncreate or alter proc x').normalized === '/* 未闭合\ncreate or alter proc x');
    check('L2 嵌套块注释：/* a /* b */ c */ 开头的对象头照常归一（深度计数，SQL Server 块注释可嵌套），注释本身原样保留', norm('/* a /* b */ c */ create proc x').normalized === '/* a /* b */ c */ CREATE PROC x' && norm('/* a /* b */ c */ create proc x').hash === norm('/* a /* b */ c */ CREATE PROC x').hash, JSON.stringify(norm('/* a /* b */ c */ create proc x')));
    check('L2 嵌套块注释未闭合（深度没回到 0）⇒ 原样处理', norm('/* a /* b */ c create proc x').normalized === '/* a /* b */ c create proc x');
    check('norm_v1 入参非字符串 ⇒ 抛 TypeError', (() => { try { norm(null); return false; } catch (e) { return e instanceof TypeError; } })());
  }

  // ═════════ 二、真实夹具：生产三个定义 vs 数仓仓库文件 ═════════
  {
    const defs = [
      ['过程 dbo.usp_load_dwd_due_detail_df', 'prod_dbo_usp_load_dwd_due_detail_df.sql', DW + 'dwd_due_detail/dwd_due_detail_df_usp_load.sql', /CREATE\s+(OR\s+ALTER\s+)?PROC(EDURE)?\s+dbo\.usp_load_dwd_due_detail_df/i, true],
      ['视图 etl.v_dim_oc_change_patched', 'prod_etl_v_dim_oc_change_patched.sql', DW + 'dim_official_customer/09_补丁视图_v_dim_oc_change_patched_20260923_v1.0.sql', /CREATE\s+(OR\s+ALTER\s+)?VIEW\s+etl\.v_dim_oc_change_patched/i, false],
      ['库级触发器 trg_exec_element_ddl_guard', 'prod_trg_exec_element_ddl_guard.sql', DW + '_报表专题/经营利润报表/执行元素表_阶段1装载_补充DDL_20260902_v1.0.sql', /CREATE\s+(OR\s+ALTER\s+)?TRIGGER\s+trg_exec_element_ddl_guard/i, true],
    ];
    for (const [label, fx, docFile, re, mustEqual] of defs) {
      const fxPath = path.join(FIX_DIR, fx);
      const fxOk = fs.existsSync(fxPath), docOk = fs.existsSync(docFile);
      check(`真实夹具：${label} 夹具文件存在（缺失即失败）：${fxPath}`, fxOk);
      check(`真实夹具：${label} 数仓底稿文件存在（缺失即失败）：${docFile}`, docOk);
      if (!fxOk || !docOk) continue;
      const prod = readFix(fx);
      check(`真实夹具：${label} 夹具文件无凭证 / 密码字样`, !/password\s*[=:]|pwd\s*=|passwd|secret\s*=|token\s*=|Bearer\s/i.test(prod));
      const batches = createBatchOf(docFile, re);
      check(`真实夹具：${label} 数仓文件里恰有 1 个批次含 CREATE`, batches.length === 1, `命中 ${batches.length} 个批次`);
      const a = norm(prod), b = norm(batches[0] || '');
      if (mustEqual) check(`真实夹具：${label} 生产定义与数仓文件规范化后哈希相等`, a.hash === b.hash, JSON.stringify(firstDiff(a.normalized, b.normalized)));
      else {
        // 视图：当前已知事实 = 生产里存的定义不含数仓文件开头的头部注释块（部署时丢了），所以整体哈希不等，去掉开头注释块后相等。
        //   硬断言这两条事实：任何一侧（生产或底稿）有变化，这条都会变红，提醒重新确认。不改算法去凑。
        const idx = b.normalized.indexOf('CREATE VIEW');
        const fromCreate = norm(b.normalized.slice(idx));
        check(`真实夹具：${label} 已知差异：生产视图缺少底稿头部注释，交用户裁定数仓侧处理；若此断言变红，说明生产或底稿已变化，需重新确认`,
          a.hash !== b.hash && idx > 0 && /^\/\*[\s\S]*?\*\/\n$/.test(b.normalized.slice(0, idx)) && fromCreate.hash === a.hash, JSON.stringify(firstDiff(a.normalized, b.normalized)));
      }
    }
  }

  // ═════════ 三、静态：参数化 + 读定义 SQL 只含常量 ═════════
  {
    // G1a / G3 / H1 / M1：观测边界的静态硬门——严格白名单（acorn 解析被测源文件）。
    //   被测模块只能经工厂参数拿到数据库连接，且对连接只能调用 run / get / all；模块加载只能是 require('字面量')；定时器 API 的出现位置与手写名单全等；
    //   不再逐个列举绕法，名单外的写法一律判红（说不清是不是数据库句柄的成员访问，一律按句柄处理）。
    {
      const acorn = require('acorn');
      const TIMER_NAMES = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'clearTimeout', 'clearInterval', 'clearImmediate', 'setTimer', 'clearTimer', 'setT', 'clearT']);
      const analyze = (text, handleSeed) => {
        const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
        const nodes = []; const fnStack = [];
        const fnNameOf = (n, parent) => (n.id && n.id.name) || (parent && parent.type === 'VariableDeclarator' && parent.id.type === 'Identifier' && parent.id.name) || (parent && parent.type === 'Property' && !parent.computed && parent.key.name) || (parent && parent.type === 'MethodDefinition' && !parent.computed && parent.key.name) || (parent && parent.type === 'AssignmentExpression' && parent.left.type === 'Identifier' && parent.left.name) || '<anon>';
        const collect = (n, parent) => {
          if (!n || typeof n.type !== 'string') return;
          const isFn = n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
          if (isFn) fnStack.push(fnNameOf(n, parent));
          nodes.push({ n, parent, fn: fnStack.length ? fnStack[fnStack.length - 1] : '<top>' });
          for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && collect(c, n)); else if (v && typeof v.type === 'string') collect(v, n); }
          if (isFn) fnStack.pop();
        };
        collect(ast, null);
        const parentOf = new Map(nodes.map((x) => [x.n, x.parent]));
        // 数据库句柄集合 = 种子（工厂参数名）+ 别名（声明器 init 是句柄表达式；对象解构里 key 为 db 的目标）；`.db` 成员（deps.db）本身也按句柄表达式处理
        const H = new Set(handleSeed);
        const isDbMember = (n) => n.type === 'MemberExpression' && ((!n.computed && n.property.type === 'Identifier' && n.property.name === 'db') || (n.computed && n.property.type === 'Literal' && n.property.value === 'db'));
        const isHandleExpr = (n) => (n.type === 'Identifier' && H.has(n.name)) || isDbMember(n);
        for (let round = 0; round < 4; round++) {
          for (const { n } of nodes) {
            if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init && isHandleExpr(n.init)) H.add(n.id.name);
            if (n.type === 'ObjectPattern') for (const p of n.properties) if (p.type === 'Property' && !p.computed && p.key.name === 'db') { const v = p.value.type === 'AssignmentPattern' ? p.value.left : p.value; if (v.type === 'Identifier') H.add(v.name); }
          }
        }
        const declPos = (n, p) => !!p && ((/Function/.test(p.type) && p.params.includes(n)) || (p.type === 'VariableDeclarator' && p.id === n) || (p.type === 'AssignmentPattern' && p.left === n) || (p.type === 'Property' && parentOf.get(p) && parentOf.get(p).type === 'ObjectPattern') || ((p.type === 'FunctionDeclaration' || p.type === 'FunctionExpression' || p.type === 'ClassDeclaration') && p.id === n) || (p.type === 'CatchClause' && p.param === n));
        const skipPos = (n, p) => !!p && ((p.type === 'MemberExpression' && !p.computed && p.property === n) || (p.type === 'Property' && !p.computed && p.key === n) || ((p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && !p.computed && p.key === n) || ((p.type === 'LabeledStatement' || p.type === 'BreakStatement' || p.type === 'ContinueStatement') && p.label === n));
        const out = { handleViolations: [], loadViolations: [], thisMembers: new Set(), timers: [], requires: [], free: [], banned: [] };
        const declared = new Set(); const refs = new Set();
        const pat = (p) => { if (!p) return; if (p.type === 'Identifier') declared.add(p.name); else if (p.type === 'ObjectPattern') p.properties.forEach((q) => pat(q.type === 'RestElement' ? q.argument : q.value)); else if (p.type === 'ArrayPattern') p.elements.forEach(pat); else if (p.type === 'AssignmentPattern') pat(p.left); else if (p.type === 'RestElement') pat(p.argument); };
        for (const { n, parent, fn } of nodes) {
          switch (n.type) {
            case 'VariableDeclarator': pat(n.id); break;
            case 'FunctionDeclaration': case 'FunctionExpression': case 'ArrowFunctionExpression': if (n.id) declared.add(n.id.name); n.params.forEach(pat); break;
            case 'ClassDeclaration': case 'ClassExpression': if (n.id) declared.add(n.id.name); break;
            case 'CatchClause': pat(n.param); break;
            case 'ImportExpression': out.loadViolations.push('import()'); break;
            case 'CallExpression': if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length === 1 && n.arguments[0].type === 'Literal' && typeof n.arguments[0].value === 'string') out.requires.push(n.arguments[0].value); break;
            case 'ThisExpression': if (parent && parent.type === 'MemberExpression' && parent.object === n) out.thisMembers.add(parent.computed ? '<computed>' : parent.property.name); else out.thisMembers.add('<bare>'); break;
            case 'MemberExpression': {
              const pn = !n.computed && n.property.type === 'Identifier' ? n.property.name : (n.computed && n.property.type === 'Literal' ? String(n.property.value) : null);
              if (pn === 'prepare' || pn === 'bind') out.banned.push(pn);   // 按成员访问的属性名判，不论对象是谁
              // H1：对数据库句柄的成员访问只允许 run / get / all（其余——serialize / parallelize / exec / prepare / each / close / configure / on / loadExtension 等以及计算属性——一律判红）
              if (isHandleExpr(n.object) && (n.computed || n.property.type !== 'Identifier' || !['run', 'get', 'all'].includes(n.property.name))) out.handleViolations.push('member:' + (n.computed ? '<computed>' : n.property.name));
              // K1c：句柄方法调用的返回值（sqlite3 的 run / get / all 返回的就是原始 Database）必须被丢弃——调用本身必须是表达式语句：不得链式调用（conn.run(...).exec）、不得把返回值赋值 / 传参 / 返回，也不得把方法取出来当值
              if (isHandleExpr(n.object)) { const gp = parentOf.get(parent); const okCall = !!parent && parent.type === 'CallExpression' && parent.callee === n; if (!okCall || !(gp && gp.type === 'ExpressionStatement')) out.handleViolations.push('result-use:' + (n.computed ? '<computed>' : n.property.name)); }
              break;
            }
          }
          if (n.type === 'Identifier' && !skipPos(n, parent)) {
            const isDecl = declPos(n, parent);
            if (!isDecl) refs.add(n.name);
            if (!isDecl && n.name === 'require') {   // require 只能以 require('字面量') 的形式出现（不得当值使用、赋值、传参）
              const ok = parent && parent.type === 'CallExpression' && parent.callee === n && parent.arguments.length === 1 && parent.arguments[0].type === 'Literal' && typeof parent.arguments[0].value === 'string';
              if (!ok) out.loadViolations.push('require-as-value');
            }
            if (!isDecl && n.name === 'module') {   // module 只能出现在 module.exports(.x) = … 的赋值左侧（module.require 等一律判红）
              let cur = parent; let up = parentOf.get(cur);
              let ok = !!parent && parent.type === 'MemberExpression' && parent.object === n && !parent.computed && parent.property.name === 'exports';
              while (ok && up && up.type === 'MemberExpression' && up.object === cur && !up.computed) { cur = up; up = parentOf.get(cur); }
              ok = ok && !!up && up.type === 'AssignmentExpression' && up.left === cur;
              if (!ok) out.loadViolations.push('module-use');
            }
            if (!isDecl && TIMER_NAMES.has(n.name)) out.timers.push(n.name + '@' + fn);
            if (!isDecl && H.has(n.name)) {   // 句柄作为「值」只允许：成员访问的对象、传给 bumpConfigRev 的实参、`db: 句柄` 属性值、别名声明的 init
              const p = parent;
              const ok = (p.type === 'MemberExpression' && p.object === n) || (p.type === 'CallExpression' && p.callee.type === 'Identifier' && p.callee.name === 'bumpConfigRev' && p.arguments.includes(n)) || (p.type === 'Property' && !p.computed && p.key.name === 'db' && p.value === n) || (p.type === 'VariableDeclarator' && p.init === n);
              if (!ok) out.handleViolations.push('value-use:' + n.name + '@' + p.type);
            }
          }
          if (isDbMember(n)) {
            const p = parent;
            const ok = (p.type === 'MemberExpression' && p.object === n) || (p.type === 'VariableDeclarator' && p.init === n) || (p.type === 'CallExpression' && p.callee.type === 'Identifier' && p.callee.name === 'bumpConfigRev' && p.arguments.includes(n));
            if (!ok) out.handleViolations.push('value-use:.db@' + p.type);
          }
        }
        out.free = [...refs].filter((x) => !declared.has(x)).sort();
        out.timers.sort(); out.thisMembers = [...out.thisMembers].sort();
        return out;
      };
      // 手写名单：每个文件的数据库句柄种子、允许 require 的模块、允许出现的自由标识符（全是语言 / Node 内置全局）、this 成员、定时器 API 的出现位置（名字@所在函数）
      //   定时器名单按现状核实后手写：impl-verify 停服等待；impl-objects 的互斥锁等待 / 停服 3 秒上限 / 启动等表 / 手动核验 20 秒上限；daily-sweep 的调度与清理
      const ALLOW = {
        'impl-verify.js': { handle: ['conn'], req: ['./sql-normalize'], free: ['Date', 'Error', 'Map', 'NaN', 'Number', 'Object', 'Promise', 'String', 'Symbol', 'clearTimeout', 'module', 'require', 'setTimeout', 'undefined'], thisM: ['changes'],
          timers: ['clearTimeout@stop', 'setTimeout@<anon>'] },
        'impl-objects.js': { handle: ['conn'], req: ['path', 'express', './config-rev', './sql-normalize', './impl-verify', './daily-sweep'], free: ['Array', 'Buffer', 'Error', 'JSON', 'Map', 'Number', 'Object', 'Promise', 'Set', 'String', 'Symbol', 'clearTimeout', 'module', 'require', 'setTimeout', 'undefined'], thisM: ['changes', 'code', 'extra', 'lastID', 'status'],
          timers: ['clearT@<anon>', 'clearTimeout@<anon>', 'clearTimeout@release', 'clearTimeout@stopDailyVerify', 'setT@<anon>', 'setTimeout@<anon>', 'setTimeout@<anon>', 'setTimeout@<anon>', 'setTimeout@<anon>'] },
        'daily-sweep.js': { handle: [], req: [], free: ['Date', 'Error', 'Math', 'Number', 'Object', 'String', 'clearTimeout', 'module', 'setTimeout'], thisM: [],
          timers: ['clearTimeout@createDailySweep', 'clearTimer@stop', 'setTimeout@createDailySweep', 'setTimer@schedule'] },
        'sql-normalize.js': { handle: [], req: ['crypto'], free: ['Buffer', 'RegExp', 'String', 'TypeError', 'module', 'require'], thisM: [], timers: [] },
        'config-rev.js': { handle: ['db'], req: [], free: ['Array', 'Number', 'Promise', 'module'], thisM: ['<bare>', 'changes'], timers: [] },   // 被测模块把连接传给的唯一外部函数 bumpConfigRev 所在文件，同样纳入
      };
      const got = {};
      for (const fname of Object.keys(ALLOW)) got[fname] = analyze(fs.readFileSync(mc(fname), 'utf8'), ALLOW[fname].handle);
      const per = (fn) => JSON.stringify(Object.fromEntries(Object.keys(ALLOW).map((f) => [f, fn(f)])));
      check('G1a 静态：被测源文件（四个 + 接收连接的 config-rev.js）的 require 全在手写名单内（不 require sqlite3 或任何数据库驱动；所有数据库访问只能经工厂参数 deps.db / conn 进来）',
        Object.keys(ALLOW).every((f) => isDeepStrictEqual([...got[f].requires].sort(), [...ALLOW[f].req].sort())), per((f) => got[f].requires));
      check('G1a 静态：被测源文件里没有名单外的自由标识符（不引用模块外的全局数据库对象；acorn 解析引用 / 声明后按手写名单比对）',
        Object.keys(ALLOW).every((f) => got[f].free.every((x) => ALLOW[f].free.includes(x))), per((f) => got[f].free.filter((x) => !ALLOW[f].free.includes(x))));
      check('G3 静态：被测源文件不使用 prepare / bind（记录器只拦 run / get / all / each / exec，用这条把契约钉死）', Object.keys(ALLOW).every((f) => got[f].banned.length === 0), per((f) => got[f].banned));
      check('H1 静态：对数据库句柄（工厂参数 db / conn 及其别名、deps.db）的成员访问只有 run / get / all 三个名字，没有 serialize / parallelize / exec / prepare / each / close / configure / on / loadExtension 或计算属性访问；方法调用的返回值必须被丢弃（调用本身是表达式语句，不得链式调用、赋值、传参，也不得把方法取出来当值）；句柄作为值只传给 bumpConfigRev / createImplVerify 的 db 属性',
        Object.keys(ALLOW).every((f) => got[f].handleViolations.length === 0), per((f) => got[f].handleViolations));
      check('H1 静态：回调里的 this 成员只在手写名单内（changes / lastID 等结果字段与错误类字段；不能经 this 取到原始连接）', Object.keys(ALLOW).every((f) => isDeepStrictEqual(got[f].thisMembers, [...ALLOW[f].thisM].sort())), per((f) => got[f].thisMembers));
      check('H1 静态：require 只以 require(\'字面量\') 的形式出现（不得赋值 / 传参 / 当值使用），没有 module.require、process.mainModule、动态 import()；module 只出现在 module.exports 的赋值左侧', Object.keys(ALLOW).every((f) => got[f].loadViolations.length === 0), per((f) => got[f].loadViolations));
      check('M1 静态：定时器 API（setTimeout / setInterval / setImmediate / queueMicrotask 及其清理、可注入的 setTimer / clearTimer / setT / clearT）在每个被测文件里的出现位置与手写名单全等（新增任何一处都判红）',
        Object.keys(ALLOW).every((f) => isDeepStrictEqual(got[f].timers, [...ALLOW[f].timers].sort())), per((f) => got[f].timers));
    }
    // T3：SQL 期望是独立手写的精确文本（不从 Ver.SQL 取 oracle）。任何语义改动（INNER JOIN、OR 1 = 1、改错对象视图 / 参数）都会让这条变红
    const EXPECT_SQL_SCHEMA = "SELECT p.can_view AS can_view, q.otype AS otype, q.def AS def FROM (SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view) AS p LEFT JOIN (SELECT o.type AS otype, OBJECT_DEFINITION(o.object_id) AS def FROM sys.objects AS o WHERE o.object_id = OBJECT_ID(QUOTENAME(@s) + N'.' + QUOTENAME(@n))) AS q ON 1 = 1";
    const EXPECT_SQL_DBTRG = "SELECT p.can_view AS can_view, q.otype AS otype, q.def AS def FROM (SELECT HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'VIEW DEFINITION') AS can_view) AS p LEFT JOIN (SELECT t.type AS otype, m.definition AS def FROM sys.triggers AS t LEFT JOIN sys.sql_modules AS m ON m.object_id = t.object_id WHERE t.parent_class = 0 AND t.name = @n) AS q ON 1 = 1";
    check('T3 读定义 SQL 文本与独立手写的精确期望逐字相等（含 HAS_PERMS_BY_NAME 的 can_view、外层 LEFT JOIN … ON 1 = 1、库级触发器的 LEFT JOIN sys.sql_modules）', Ver.SQL.SQL_READ_BY_SCHEMA === EXPECT_SQL_SCHEMA && Ver.SQL.SQL_READ_DB_TRIGGER === EXPECT_SQL_DBTRG, JSON.stringify([Ver.SQL.SQL_READ_BY_SCHEMA, Ver.SQL.SQL_READ_DB_TRIGGER]));
    const lits = [...verText.matchAll(/^const (SQL_READ_[A-Z_]+) = ("(?:[^"\\]|\\.)*");$/gm)];
    const queryCalls = [...verText.matchAll(/\.query\(/g)].length;
    const okQueryCalls = [...verText.matchAll(/\.query\(\s*(SQL_READ_[A-Z_]+)\s*\)/g)].length;
    check('参数化静态断言：读定义的 2 条 SQL 都是纯双引号字面量常量（无 + 拼接、无模板插值），且每个 .query( 的实参都是这些常量本身',
      lits.length === 2 && queryCalls === 2 && okQueryCalls === queryCalls && !/\$\{/.test(lits.map((m) => m[2]).join('')), `常量 ${lits.length} 个，.query 调用 ${queryCalls} 处，实参为常量 ${okQueryCalls} 处`);
    check('参数化静态断言：读定义 SQL 只用 @s / @n 两个参数名，且存在性、定义与权限合并在一条里',
      lits.every((m) => /@n/.test(m[2]) && /HAS_PERMS_BY_NAME/.test(m[2])) && lits.filter((m) => /BY_SCHEMA/.test(m[1])).every((m) => /QUOTENAME\(@s\)/.test(m[2]) && /QUOTENAME\(@n\)/.test(m[2]) && /OBJECT_DEFINITION\(o\.object_id\)/.test(m[2])) && lits.filter((m) => /DB_TRIGGER/.test(m[1])).every((m) => /parent_class = 0 AND t\.name = @n/.test(m[2]) && /sys\.sql_modules/.test(m[2])));
    // 行为：假连接池记录 input 与 query 文本；恶意名称只能出现在 input 里
    const evilS = "dbo]; DROP TABLE x;--", evilN = "n'; DROP TABLE y;--";
    const calls = [];
    const fakePool = { request() { const rec = { inputs: {}, sql: null }; calls.push(rec); return { input(k, v) { rec.inputs[k] = v; }, async query(s) { rec.sql = s; return { recordset: [{ can_view: 1, otype: 'P ', def: 'CREATE PROC x AS SELECT 1' }] }; } }; } };
    const conn1 = async () => ({ id: 1, type: 'sqlserver', host: 'h', port: 1, database: 'd', username: 'u', password: 'enc' });
    const reader = Ver.createSqlServerDefinitionReader({ getConnectionRow: conn1, getMssqlPool: async () => fakePool, decryptPassword: () => 'pw' });
    const r1 = await reader({ db_connection_id: 1, obj_type: 'PROC', schema_name: evilS, obj_name: evilN });
    check('参数化行为：有 schema 的对象——只发 1 条查询，文本恰为手写期望，恶意 schema / 名称只出现在 input(s / n) 里、不出现在 SQL 文本里',
      r1.exists === true && r1.definition === 'CREATE PROC x AS SELECT 1' && calls.length === 1 && calls.every((c) => c.sql === EXPECT_SQL_SCHEMA && !c.sql.includes('DROP') && c.inputs.s === evilS && c.inputs.n === evilN), JSON.stringify(calls));
    calls.length = 0;
    const r2 = await reader({ db_connection_id: 1, obj_type: 'TRIGGER', schema_name: null, obj_name: evilN });
    check('参数化行为：库级触发器（schema 为空）——走 sys.triggers parent_class = 0 的 1 条查询，文本恰为手写期望，只绑 n 不绑 s', r2.exists === true && calls.length === 1 && calls.every((c) => c.sql === EXPECT_SQL_DBTRG && c.inputs.n === evilN && !('s' in c.inputs)), JSON.stringify(calls));
    // 读取结果解读（R1 / T3）：无对象行时只有 can_view = 1 才算缺失
    const rdOne = (rec, extra) => Ver.createSqlServerDefinitionReader({ getConnectionRow: conn1, decryptPassword: () => 'p', getMssqlPool: async () => ({ request() { return { input() {}, async query() { return rec; } }; } }), ...(extra || {}) });
    const objV = { db_connection_id: 1, obj_type: 'VIEW', schema_name: 'dbo', obj_name: 'v' };
    const objDbTrg = { db_connection_id: 1, obj_type: 'TRIGGER', schema_name: null, obj_name: 'trg_db' };
    const kindOf = (p) => p.then(() => null, (e) => ({ kind: e.verifyKind, msg: e.message }));
    check('R1 无对象行且 can_view = 1（确认有元数据可见权限）⇒ { exists: false }（缺失）', (await rdOne({ recordset: [{ can_view: 1, otype: null, def: null }] })(objV)).exists === false);
    for (const [label, cv] of [['can_view = 0', 0], ['can_view 为 NULL', null], ['can_view 缺失', undefined]]) {
      const e = await kindOf(rdOne({ recordset: [{ can_view: cv, otype: null, def: null }] })(objV));
      check(`R1 无对象行且 ${label}（元数据可能不可见）⇒ 抛「无权读取定义」，不当作缺失`, !!e && e.kind === '无权读取定义', JSON.stringify(e));
    }
    const noRows = await kindOf(rdOne({ recordset: [] })(objV));
    check('R1 查询没有返回任何行（无法确认权限）⇒ fail-closed 抛「无权读取定义」', !!noRows && noRows.kind === '无权读取定义', JSON.stringify(noRows));
    check('R1 库级触发器：无对象行且 can_view = 1 ⇒ { exists: false }（确实无行）', (await rdOne({ recordset: [{ can_view: 1, otype: null, def: null }] })(objDbTrg)).exists === false);
    const dbNoView = await kindOf(rdOne({ recordset: [{ can_view: 0, otype: null, def: null }] })(objDbTrg));
    check('R1 库级触发器：无对象行且 can_view = 0 ⇒ 抛「无权读取定义」，不当作缺失', !!dbNoView && dbNoView.kind === '无权读取定义', JSON.stringify(dbNoView));
    const dbNullDef = await rdOne({ recordset: [{ can_view: 1, otype: 'TR', def: null }] })(objDbTrg);
    check('T3 库级触发器：有对象行（TR）但 sql_modules 无行 / 定义为 NULL ⇒ { exists: true, definition: null }（不是缺失）', dbNullDef.exists === true && dbNullDef.definition === null, JSON.stringify(dbNullDef));
    const nullDef = await rdOne({ recordset: [{ can_view: 1, otype: 'V ', def: null }] })(objV);
    check('读取器：有对象行但定义为 NULL ⇒ { exists: true, definition: null }（无权读取，不是缺失）', nullDef.exists === true && nullDef.definition === null);
    const tm = await kindOf(rdOne({ recordset: [{ can_view: 1, otype: 'U ', def: null }] })(objV));
    check('读取器：生产对象类型与登记不符（登记 VIEW，生产是表 U）⇒ 抛「类型不符」', !!tm && tm.kind === '类型不符', JSON.stringify(tm));
    for (const t of ['PC', 'X ', 'TA']) {
      const e = await kindOf(rdOne({ recordset: [{ can_view: 1, otype: t, def: null }] })({ ...objV, obj_type: t === 'TA' ? 'TRIGGER' : 'PROC' }));
      check(`读取器：生产类型 ${t.trim()}（CLR / 扩展，无 T-SQL 定义）⇒ 抛「类型不符」，详情「该类型对象无 T-SQL 定义」只进日志`, !!e && e.kind === '类型不符' && /该类型对象无 T-SQL 定义/.test(e.msg), JSON.stringify(e));
    }
    {
      const rf = await rdOne({ recordset: [{ can_view: 1, otype: 'RF', def: 'CREATE PROCEDURE rf AS SELECT 1' }] })({ ...objV, obj_type: 'PROC' }).catch((err) => ({ err: err.message }));
      check('L-c 读取器：PROC 接受生产类型 RF（复制过滤过程有 T-SQL 定义）⇒ { exists: true, definition: 原文 }', rf.exists === true && rf.definition === 'CREATE PROCEDURE rf AS SELECT 1', JSON.stringify(rf));
      const ta = await kindOf(rdOne({ recordset: [{ can_view: 1, otype: 'TA', def: null }] })(objDbTrg));
      const tr = await rdOne({ recordset: [{ can_view: 1, otype: 'TR', def: 'CREATE TRIGGER t ON DATABASE AS SELECT 1' }] })(objDbTrg);
      check('L-c 读取器：库级触发器 TA（CLR 触发器）⇒ 抛「类型不符」，TR ⇒ 正常返回定义', !!ta && ta.kind === '类型不符' && tr.exists === true, JSON.stringify([ta, tr]));
    }
    const c1 = await kindOf(Ver.createSqlServerDefinitionReader({ getConnectionRow: async () => ({ id: 1, type: 'mysql' }), getMssqlPool: async () => null, decryptPassword: () => '' })({ ...objV }));
    const c2 = await kindOf(Ver.createSqlServerDefinitionReader({ getConnectionRow: async () => null, getMssqlPool: async () => null, decryptPassword: () => '' })({ ...objV, db_connection_id: 9 }));
    check('读取器：连接行不是 sqlserver / 不存在 ⇒ 抛「连接失败」', !!c1 && c1.kind === '连接失败' && !!c2 && c2.kind === '连接失败', JSON.stringify([c1, c2]));
    // 错误分类（落库只存这些文案）
    const cls = (m, code) => Ver.classifyError(Object.assign(new Error(m), code ? { code } : {}));
    check('错误分类：登录失败 / 超时 / 连接失败 / 查询出错 / 未知错误（含 IP、端口、登录名的原文只能被归入这些枚举）',
      cls("Login failed for user 'svc'") === '登录失败' && cls('x', 'ELOGIN') === '登录失败' && cls('connect ETIMEDOUT 1.2.3.4:1433') === '超时' && cls('Timeout: Request failed to complete') === '超时'
      && cls('connect ECONNREFUSED 1.2.3.4:1433') === '连接失败' && cls('Invalid object name', 'EREQUEST') === '查询出错' && cls('boom') === '未知错误' && Ver.classifyError(null) === '未知错误'
      && Ver.ERROR_KINDS.join() === '连接失败,登录失败,超时,查询出错,类型不符,无权读取定义,未知错误');
    // R5：时区前提（头注释写明）
    check('R5 impl-verify.js 头注释写明：徽章 7 天按本机公民时间计，平台部署在北京时间、无夏令时', /本机公民时间/.test(verText) && /北京时间/.test(verText) && /无夏令时/.test(verText));
    check('R1 impl-verify.js 头注释写明：生产账号需要数据库级 VIEW DEFINITION', /数据库级 VIEW DEFINITION/.test(verText));
    check('Q2 头注释口径：只有「缺失判定」需要数据库级 VIEW DEFINITION；对象行已存在时对象级权限即可正常核验', /只有「缺失判定」需要数据库级 VIEW DEFINITION/.test(verText) && /对象级权限即可正常核验/.test(verText));
    check('Q3 手动核验端点注释与 202 文案写明：停服期间已排队的核验可能被取消，以对象详情里的最终核验时间为准', /停服期间已排队的核验可能被取消/.test(fs.readFileSync(mc('impl-objects.js'), 'utf8')));
  }

  // ═════════ 四、徽章（时钟钉死；八行顺序表每行至少一例，期望手写）═════════
  {
    const NOW = '2026-10-03 12:00:00';
    const B = (o) => Ver.computeBadges({ obj_type: 'PROC', verified_at: null, last_attempt_at: null, last_error: null, prod_missing: 0, prod_hash: null, reg_hash: null, doc_hash: null, ...o }, NOW);
    const eq = (name, got, doc, reg) => check(name, got.doc === doc && got.reg === reg, JSON.stringify(got));
    // 行 1
    for (const t of ['FDL_TASK', 'TABLE']) {
      const g = Ver.computeBadges({ obj_type: t, verified_at: '2026-10-03 11:00:00', last_error: 'x', prod_missing: 1, prod_hash: 'a', reg_hash: 'b', doc_hash: 'c' }, NOW);
      check(`徽章·行 1：${t} 不显示徽章（doc / reg 均为 null，无视其余字段）`, g.doc === null && g.reg === null, JSON.stringify(g));
    }
    // 行 2
    eq('徽章·行 2：verified_at 与 last_error 都为空 ⇒ 未核验', B({}), 'unverified', 'unverified');
    eq('徽章·行 2：空串视同为空', B({ verified_at: '', last_error: '' }), 'unverified', 'unverified');
    // 行 3
    let g = B({ verified_at: '2026-10-03 11:00:00', last_attempt_at: '2026-10-03 11:30:00', last_error: '连接超时', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h' });
    check('徽章·行 3：last_attempt_at > verified_at 且有错误 ⇒ 核验失败（不沿用旧的「一致」），附失败时间与错误', g.doc === 'verify_failed' && g.reg === 'verify_failed' && g.failure && g.failure.at === '2026-10-03 11:30:00' && g.failure.error === '连接超时', JSON.stringify(g));
    eq('徽章·行 3：verified_at 为空但有错误 ⇒ 核验失败', B({ last_attempt_at: '2026-10-03 11:30:00', last_error: '无权读取定义' }), 'verify_failed', 'verify_failed');
    eq('徽章·行 3 边界：同一秒内先成功后失败（last_attempt_at = verified_at，last_error 非空）⇒ 核验失败（只看 last_error，不比较时间列）', B({ verified_at: '2026-10-03 11:00:00', last_attempt_at: '2026-10-03 11:00:00', last_error: 'x', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h' }), 'verify_failed', 'verify_failed');
    // T1：last_error 非空与 stale / prod_missing 同时成立时，核验失败优先（行 3 先于行 4 / 行 5）
    eq('T1 徽章优先级：verified_at 超过 7 天且 last_error 非空 ⇒ verify_failed（不是 stale）', B({ verified_at: '2026-09-20 12:00:00', last_attempt_at: '2026-10-03 11:00:00', last_error: '超时', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h' }), 'verify_failed', 'verify_failed');
    eq('T1 徽章优先级：verified_at 超过 7 天、last_error 非空且 prod_missing = 1 ⇒ verify_failed（不是 stale / prod_missing）', B({ verified_at: '2026-09-20 12:00:00', last_attempt_at: '2026-10-03 11:00:00', last_error: '超时', prod_missing: 1 }), 'verify_failed', 'verify_failed');
    eq('T1 徽章优先级：未过期、last_error 非空且 prod_missing = 1 ⇒ verify_failed（不是 prod_missing）', B({ verified_at: '2026-10-03 11:00:00', last_attempt_at: '2026-10-03 11:30:00', last_error: '超时', prod_missing: 1 }), 'verify_failed', 'verify_failed');
    // 行 4（时钟钉死）
    const ok = { prod_hash: 'h', reg_hash: 'h', doc_hash: 'h', last_attempt_at: null };
    eq('徽章·时钟钉死：verified_at 为 6 天 23 小时 ⇒ 一致', B({ ...ok, verified_at: '2026-09-26 13:00:00' }), 'consistent', 'consistent');
    eq('徽章·时钟钉死：verified_at 为 7 天 1 分钟 ⇒ 待重核（不论上次结果）', B({ ...ok, verified_at: '2026-09-26 11:59:00' }), 'stale', 'stale');
    eq('U5 stale 边界：恰好 7 天（方案原句 now - verified_at > 7 天，严格大于才待重核）⇒ 一致', B({ ...ok, verified_at: '2026-09-26 12:00:00' }), 'consistent', 'consistent');
    eq('U5 stale 边界：7 天零 1 秒 ⇒ 待重核（手写期望）', B({ ...ok, verified_at: '2026-09-26 11:59:59' }), 'stale', 'stale');
    eq('U5 stale 边界：恰好 7 天时两枚徽章仍按比对结果显示（文档不一致 / 登记一致）', B({ verified_at: '2026-09-26 12:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'x' }), 'inconsistent', 'consistent');
    eq('U5 无法解析：verified_at 非空但不是合法时间 ⇒ fail-closed 按 stale', B({ ...ok, verified_at: 'not-a-time' }), 'stale', 'stale');
    for (const [label, bad] of [['2026-02-30（不存在的日期）', '2026-02-30 10:00:00'], ['月份 13', '2026-13-01 10:00:00'], ['小时 24', '2026-10-03 24:00:00'], ['分钟 60', '2026-10-03 10:60:00']]) {
      eq(`V2 严格解析：verified_at = ${label} ⇒ stale（回读校验判非法）`, B({ ...ok, verified_at: bad }), 'stale', 'stale');
      check(`V2 严格解析：now = ${label} ⇒ stale`, (() => { const g = Ver.computeBadges({ obj_type: 'PROC', verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h', prod_missing: 0 }, bad); return g.doc === 'stale' && g.reg === 'stale'; })());
    }
    check('U5 无法解析：now 不是合法时间 ⇒ fail-closed 按 stale', (() => { const g = Ver.computeBadges({ obj_type: 'PROC', verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h', prod_missing: 0 }, 'garbage'); return g.doc === 'stale' && g.reg === 'stale'; })());
    eq('徽章·行 4 优先于行 5：7 天前核验且 prod_missing ⇒ 待重核', B({ ...ok, verified_at: '2026-09-20 12:00:00', prod_missing: 1 }), 'stale', 'stale');
    // 行 5
    eq('徽章·行 5：prod_missing = 1 ⇒ 生产缺失（优先于未登记 / 一致）', B({ verified_at: '2026-10-03 11:00:00', prod_missing: 1, prod_hash: null, reg_hash: null, doc_hash: 'x' }), 'prod_missing', 'prod_missing');
    // 行 6
    eq('徽章·行 6：doc_hash 为空 ⇒ 文档未登记；reg_hash 非空且一致 ⇒ 登记一致', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: null }), 'unregistered', 'consistent');
    eq('徽章·行 6：reg_hash 为空 ⇒ 登记未登记；doc_hash 一致', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: null, doc_hash: 'h' }), 'consistent', 'unregistered');
    eq('徽章·行 6：两端都为空 ⇒ 都未登记', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h' }), 'unregistered', 'unregistered');
    // 行 7 / 8
    eq('徽章·行 7：两端都与生产相等 ⇒ 一致 / 一致', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h' }), 'consistent', 'consistent');
    eq('徽章·行 8：文档与生产不等、登记相等 ⇒ 不一致 / 一致（两枚徽章独立）', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'x' }), 'inconsistent', 'consistent');
    eq('徽章·行 8：登记与生产不等 ⇒ 文档一致 / 登记不一致', B({ verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'x', doc_hash: 'h' }), 'consistent', 'inconsistent');
    check('徽章·BADGE_LABELS：code → 方案 §4.4 表中文文案，手写逐项相等（共 7 项）', JSON.stringify(Ver.BADGE_LABELS) === JSON.stringify({ unverified: '未核验', verify_failed: '核验失败', stale: '待重核', prod_missing: '生产缺失', unregistered: '未登记', consistent: '一致', inconsistent: '不一致' }), JSON.stringify(Ver.BADGE_LABELS));
    eq('徽章：VIEW / TRIGGER 与 PROC 同规则', Ver.computeBadges({ obj_type: 'TRIGGER', verified_at: '2026-10-03 11:00:00', prod_hash: 'h', reg_hash: 'h', doc_hash: 'h', prod_missing: 0 }, NOW), 'consistent', 'consistent');
  }

  // ═════════ 五、调度（假时钟 / 假定时器）═════════
  {
    check('调度·下一次触发时刻按 07:30 计算：06:00 ⇒ 当日 07:30；07:30:00 整 ⇒ 次日；23:59:59 ⇒ 次日 07:30',
      nextAt('2026-10-03 06:00:00', 7, 30) === '2026-10-03 07:30:00' && nextAt('2026-10-03 07:30:00', 7, 30) === '2026-10-04 07:30:00' && nextAt('2026-10-03 23:59:59', 7, 30) === '2026-10-04 07:30:00' && nextAt('2026-12-31 08:00:00', 7, 30) === '2027-01-01 07:30:00');
    const mkEnv = () => {
      const env = { now: '2026-10-03 07:00:00', timers: [], processed: [], active: 0, maxActive: 0, logs: [], failIds: new Set(), errIds: new Set(), stopIds: new Set(), clockFail: false, listFail: false, ready: true, terminal: false };
      env.setTimer = (fn, delay) => { const t = { fn, delay, cancelled: false }; env.timers.push(t); return t; };
      env.clearTimer = (t) => { t.cancelled = true; };
      env.fireNext = async () => { const t = env.timers.filter((x) => !x.cancelled && !x.fired).shift(); if (!t) return false; t.fired = true; await t.fn(); await turn(); return true; };
      env.sweep = createDailySweep({
        label: '测试日任务', atHour: 7, atMinute: 30, isReady: () => env.ready, isTerminal: () => env.terminal, readNow: async () => { if (env.clockFail) throw new Error('clock down'); return env.now; }, logger: { info() {}, error(m, d) { env.logs.push([m, d]); }, warn() {} },
        listCandidates: async () => { if (env.listFail) throw new Error('db down'); return [1, 2, 3]; }, setTimer: env.setTimer, clearTimer: env.clearTimer,
        processOne: async (id) => { env.active++; env.maxActive = Math.max(env.maxActive, env.active); await turn(); env.active--; env.processed.push(id); if (env.failIds.has(id)) throw new Error('boom' + id); return env.stopIds.has(id) ? { outcome: 'stopped' } : env.errIds.has(id) ? { outcome: 'error', error: '超时' } : { outcome: 'ok' }; },
      });
      return env;
    };
    let e = mkEnv();
    e.failIds.add(2);
    e.sweep.start();
    await e.fireNext();
    check('调度·启动时不补跑：首次唤醒只排定下一个触发点（07:00 启动 ⇒ due = 当日 07:30:00），没有处理任何对象', e.processed.length === 0 && e.sweep.status().due === '2026-10-03 07:30:00', JSON.stringify(e.sweep.status()));
    e.now = '2026-10-03 07:29:59'; await e.fireNext();
    check('调度·07:29:59 仍不触发', e.processed.length === 0);
    e.now = '2026-10-03 07:30:00'; await e.fireNext();
    check('调度·07:30:00 触发：串行（并发度恒为 1）处理全部候选，中间一个失败不影响其余（[1,2,3] 全部处理、failed = [2]）', e.processed.join() === '1,2,3' && e.maxActive === 1 && JSON.stringify(e.sweep.status().lastResult.failed) === '[2]', JSON.stringify([e.processed, e.maxActive, e.sweep.status().lastResult]));
    check('调度·触发后下一个触发点 = 次日 07:30:00，同日再次唤醒不重复触发', e.sweep.status().due === '2026-10-04 07:30:00' && (e.now = '2026-10-03 09:00:00', await e.fireNext(), e.processed.length === 3), JSON.stringify(e.sweep.status()));
    e.now = '2026-10-04 07:30:01'; await e.fireNext();
    check('调度·次日 07:30 之后再次触发（共 6 次处理）', e.processed.length === 6, String(e.processed.length));
    const before = e.processed.length;
    await e.sweep.stop();
    e.now = '2026-10-05 07:31:00';
    for (const t of e.timers.slice()) if (!t.fired) { t.fired = true; await t.fn(); }   // 连被清掉的旧定时器回调也强行执行一遍，stop 之后任何迟到回调都不得处理对象
    await turns(3);
    check('调度·stopService 后不再触发：stop 清掉定时器、置停止标志，迟到的定时器回调（强制执行）也不处理任何对象，状态 stopped', e.processed.length === before && e.sweep.status().stopped === true && e.timers.filter((t) => !t.fired && !t.cancelled).length === 0, JSON.stringify([e.processed.length, before, e.sweep.status()]));
    // W2：读时钟失败后退避重试，保留 due；时钟恢复后若已过 due 立即补跑，不顺延到次日
    e = mkEnv();
    e.sweep.start(); await e.fireNext();                      // 07:00：排定 due = 07:30
    e.now = '2026-10-03 07:30:00'; e.clockFail = true; await e.fireNext();
    const pendingRetry = e.timers.filter((t) => !t.cancelled && !t.fired);
    check('W2 读时钟失败：本次唤醒没有处理任何对象，已排定的 due 保持 2026-10-03 07:30:00（不清空、不改排次日），并按退避排下一次重试（60 秒）', e.processed.length === 0 && e.sweep.status().due === '2026-10-03 07:30:00' && pendingRetry.length === 1 && pendingRetry[0].delay === 60000, JSON.stringify([e.sweep.status(), pendingRetry.map((t) => t.delay)]));
    e.clockFail = false; e.now = '2026-10-03 07:31:00'; await e.fireNext();
    check('W2 读时钟失败后时钟恢复：已过 due，当天补跑（[1,2,3] 全部处理），不会被顺延到次日', e.processed.join() === '1,2,3' && e.sweep.status().due === '2026-10-04 07:30:00', JSON.stringify([e.processed, e.sweep.status().due]));
    await e.sweep.stop();
    // L4：processOne 返回 outcome = error 计入 failed、不计入 ok
    e = mkEnv(); e.errIds.add(2); e.sweep.start(); await e.fireNext(); e.now = '2026-10-03 07:30:00'; await e.fireNext();
    check('L4 每日任务：outcome = error 的对象计入 failed、不计入 ok（[1,2,3] 全处理，failed = [2]，ok = 2）', JSON.stringify(e.sweep.status().lastResult.failed) === '[2]' && e.sweep.status().lastResult.ok === 2 && e.sweep.status().lastResult.scanned === 3, JSON.stringify(e.sweep.status().lastResult));
    await e.sweep.stop();
    // V3：processOne 返回 stopped（核验队列已停止）⇒ 既不计 ok 也不计 failed，记为 stopped 并结束本轮（后面的对象不再处理）
    e = mkEnv(); e.stopIds.add(2); e.sweep.start(); await e.fireNext(); e.now = '2026-10-03 07:30:00'; await e.fireNext();
    check('V3 每日任务：outcome = stopped ⇒ 不计 ok 也不计 failed，记 stopped 并结束本轮（[1,2,3] 中处理到 2 为止：scanned = 2，ok = 1，failed = []，stopped = true，3 没有被处理）', (() => { const lr = e.sweep.status().lastResult; return lr.scanned === 2 && lr.ok === 1 && lr.failed.length === 0 && lr.stopped === true && e.processed.join() === '1,2'; })(), JSON.stringify(e.sweep.status().lastResult));
    await e.sweep.stop();
    // V4（stopped 的消费契约，对应 daily-sweep.js tick 里对 execute() 结果的消费）：stopped 的一轮不算成功——不清零退避状态、不把 due 推进到下一天、
    //   只在进程仍然存活时按既有逻辑继续排下一次（固定 60 秒）；停服后重启不补跑（启动只排定下一个触发点）
    {
      e = mkEnv(); e.listFail = true;
      e.sweep.start(); await e.fireNext();                        // 07:00：排定 due = 07:30
      e.now = '2026-10-03 07:30:00'; await e.fireNext();          // 整轮失败（列候选出错）：failStreak = 1，due = 07:31:00（+1 分钟退避）
      const s1 = e.sweep.status();
      e.listFail = false; e.stopIds.add(2); e.now = '2026-10-03 07:31:00';
      await e.fireNext();                                         // 已过 due：本轮处理到 2 时收到 stopped
      const s2 = e.sweep.status();
      const pend2 = e.timers.filter((t) => !t.cancelled && !t.fired);
      check('V4 每日任务 stopped 契约：stopped 的一轮不算成功——failStreak 保持 1（不清零），due 保持 2026-10-03 07:31:00（不推进到次日），本轮记 stopped（scanned = 2、ok = 1、failed = []），并只排 1 个下一次唤醒、间隔 60000 毫秒（不自旋）',
        s1.failStreak === 1 && s1.due === '2026-10-03 07:31:00' && e.processed.join() === '1,2' && s2.lastResult.stopped === true && s2.lastResult.scanned === 2 && s2.lastResult.ok === 1 && s2.lastResult.failed.length === 0
        && s2.failStreak === 1 && s2.due === '2026-10-03 07:31:00' && pend2.length === 1 && pend2[0].delay === 60000, JSON.stringify([s1.failStreak, s1.due, e.processed, s2, pend2.map((t) => t.delay)]));
      await e.fireNext();                                         // 下一次唤醒：队列仍是停止状态，再次 stopped，状态不变
      const s3 = e.sweep.status();
      check('V4 每日任务 stopped 契约：再次唤醒仍是 stopped 时状态不变（failStreak = 1，due 不动，不补偿扫描、不推进），仍只排 1 个下一次唤醒',
        e.processed.join() === '1,2,1,2' && s3.lastResult.stopped === true && s3.failStreak === 1 && s3.due === '2026-10-03 07:31:00' && e.timers.filter((t) => !t.cancelled && !t.fired).length === 1, JSON.stringify([e.processed, s3]));
      await e.sweep.stop();
      // 停服后重启不补跑：当天 07:30 已过，新实例 09:00 启动，首次唤醒只排定下一个触发点（次日 07:30），不处理任何对象
      const eR = mkEnv(); eR.now = '2026-10-03 09:00:00';
      eR.sweep.start(); await eR.fireNext();
      check('V4 每日任务 stopped 契约：停服后重启不补跑——当天 07:30 已过，09:00 新启动的实例首次唤醒不处理任何对象，due = 次日 07:30:00', eR.processed.length === 0 && eR.sweep.status().due === '2026-10-04 07:30:00', JSON.stringify(eR.sweep.status()));
      await eR.sweep.stop();
    }
    // G4（终态）：核验队列已永久停止接收（isTerminal 为真）时收到 stopped ⇒ 调度器进入终态，tick 直接结束、不再排任何定时器（不每 60 秒空转），不依赖 stopService 先后顺序
    {
      e = mkEnv(); e.terminal = true; e.stopIds.add(2);
      e.sweep.start(); await e.fireNext();
      e.now = '2026-10-03 07:30:00'; await e.fireNext();
      const stT = e.sweep.status(); const nTimers = e.timers.length;
      await turns(3);
      check('G4 每日任务终态：调度器——stopped 且 isTerminal() 为真 ⇒ 本轮 { stopped: true, terminal: true }、status.terminated = true，tick 结束后没有任何待触发的定时器，之后也不再创建定时器；这一轮不算成功（failStreak 与 due 不动）',
        stT.lastResult.stopped === true && stT.lastResult.terminal === true && stT.terminated === true && e.processed.join() === '1,2' && e.timers.filter((x) => !x.cancelled && !x.fired).length === 0 && e.timers.length === nTimers && stT.failStreak === 0 && stT.due === '2026-10-03 07:30:00', JSON.stringify([stT, e.timers.length, nTimers]));
      await e.sweep.stop();
      const e2t = mkEnv(); e2t.stopIds.add(2);   // 对照：队列没有永久停止（isTerminal 为假）⇒ 仍按 V4 契约排下一次唤醒
      e2t.sweep.start(); await e2t.fireNext(); e2t.now = '2026-10-03 07:30:00'; await e2t.fireNext();
      check('G4 每日任务终态：调度器对照——stopped 但 isTerminal() 为假 ⇒ 不进入终态（terminated = false），仍排 1 个 60 秒后的下一次唤醒', e2t.sweep.status().terminated === false && e2t.sweep.status().lastResult.terminal === false && e2t.timers.filter((x) => !x.cancelled && !x.fired).length === 1, JSON.stringify(e2t.sweep.status()));
      await e2t.sweep.stop();
    }
    // M3（末次合并审）：未就绪（isReady 为假）的一轮——skipped，due 不动（仍 <= now），下一次唤醒固定 60000 毫秒；
    //   修复前 due 已过时按「due - now」算出的间隔 <= 0 被钳成 1 毫秒，未就绪期间空转。注入时钟：每次唤醒把假时钟推进 60 秒，检查每一次排出的间隔；恢复就绪后的下一次唤醒执行一轮
    {
      e = mkEnv(); e.ready = false;
      e.sweep.start(); await e.fireNext();                       // 07:00：排定 due = 07:30
      e.now = '2026-10-03 07:30:00';
      const delaysM3 = [];
      for (let k = 0; k < 4; k++) {
        await e.fireNext();                                      // 已过 due、未就绪：skipped
        const pend = e.timers.filter((t) => !t.cancelled && !t.fired);
        delaysM3.push(pend.length === 1 ? pend[0].delay : -1);
        e.now = new Date(Date.parse(e.now.replace(' ', 'T') + 'Z') + 60000).toISOString().slice(0, 19).replace('T', ' ');
      }
      const sM3 = e.sweep.status();
      check('M3 每日任务未就绪：连续 4 次唤醒（已过 due、isReady 为假）每次都恰排 1 个下一次唤醒、间隔恒为 60000 毫秒（不是 1 毫秒空转），没有处理任何对象，本轮记 skipped，due 保持 2026-10-03 07:30:00（不推进），failStreak 不变',
        delaysM3.join() === '60000,60000,60000,60000' && e.processed.length === 0 && sM3.lastResult === null && sM3.due === '2026-10-03 07:30:00' && sM3.failStreak === 0, JSON.stringify([delaysM3, e.processed, sM3]));
      e.ready = true; await e.fireNext();
      const sM3b = e.sweep.status();
      check('M3 每日任务恢复就绪：下一次唤醒执行一轮（[1,2,3] 全部处理），due 推进到次日 07:30:00', e.processed.join() === '1,2,3' && sM3b.due === '2026-10-04 07:30:00' && !!sM3b.lastResult && sM3b.lastResult.skipped === false, JSON.stringify([e.processed, sM3b]));
      await e.sweep.stop();
    }
    // T5：整轮失败（列候选出错）的退避序列——假时钟连续制造失败：1、2、4、8、16、32 分钟，之后恒 60 分钟（上限），且不越过下一个触发点
    {
      e = mkEnv(); e.listFail = true;
      e.sweep.start(); await e.fireNext();                       // 07:00：排定 due = 07:30
      e.now = '2026-10-03 07:30:00';
      const addMin = (ts, m) => new Date(Date.parse(ts.replace(' ', 'T') + 'Z') + m * 60000).toISOString().slice(0, 19).replace('T', ' ');
      // 手写期望：独立的算术，不取被测代码的值
      const expectedDues = []; let cur = '2026-10-03 07:30:00'; const NEXT_TRIGGER = '2026-10-04 07:30:00';
      for (const m of [1, 2, 4, 8, 16, 32, 60]) { cur = addMin(cur, m); expectedDues.push(cur); }
      while (addMin(cur, 60) < NEXT_TRIGGER) { cur = addMin(cur, 60); expectedDues.push(cur); }
      expectedDues.push(NEXT_TRIGGER);                              // 再 +60 分钟会越过下一个触发点 ⇒ 截断到下一个 07:30
      const observed = [];
      for (let k = 0; k < expectedDues.length + 2; k++) {
        await e.fireNext();
        const due = e.sweep.status().due; observed.push(due);
        if (due === NEXT_TRIGGER) break;
        e.now = due;
      }
      check('T5 退避：整轮失败连续发生时 due 序列 = +1、+2、+4、+8、+16、+32 分钟，之后恒 +60 分钟（上限），最后一次被截断到下一个触发点 2026-10-04 07:30:00（不越过）', JSON.stringify(observed) === JSON.stringify(expectedDues), JSON.stringify([observed.slice(0, 9), observed.length, expectedDues.length]));
      check('T5 退避：期间一个对象都没有被处理，failStreak 随失败递增', e.processed.length === 0 && e.sweep.status().failStreak === expectedDues.length, JSON.stringify(e.sweep.status()));
      await e.sweep.stop();
    }
    e = mkEnv(); e.ready = false; e.sweep.start(); await e.fireNext(); e.now = '2026-10-03 07:31:00'; await e.fireNext();
    check('调度·未就绪（isReady = false）时到点不处理，也不顺延到次日（due 保持，就绪后下一次唤醒补跑）', e.processed.length === 0 && e.sweep.status().due === '2026-10-03 07:30:00');
    e.ready = true; await e.fireNext();
    check('调度·就绪后补跑', e.processed.join() === '1,2,3', e.processed.join());
    await e.sweep.stop();
  }

  // ═════════ 六、进程内实现对象模块（真 sqlite 夹具库 + 桩读取器）═════════
  const dbFile = path.join(runDir, 'fixture.db');
  const db = dbPromisified(dbFile);
  const cutSql = (startMark) => { const a = srvText.indexOf(startMark); const b = srvText.indexOf('`', a); return srvText.slice(a, b); };
  await db.exec(cutSql('CREATE TABLE IF NOT EXISTS model_impl_objects ('));
  await db.exec(cutSql('CREATE UNIQUE INDEX IF NOT EXISTS idx_impl_obj_identity'));
  await db.exec(cutSql('CREATE TABLE IF NOT EXISTS model_impl_links ('));
  await db.exec(`CREATE TABLE data_models (id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT, layer TEXT, is_deleted INTEGER DEFAULT 0, companion_of INTEGER, config_rev INTEGER NOT NULL DEFAULT 1, tech_owner TEXT);
    CREATE TABLE model_change_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER, model_name TEXT, action TEXT, change_type TEXT, before_value TEXT, after_value TEXT, change_summary TEXT, operator_id INTEGER, operator_name TEXT);
    CREATE TABLE db_connections (id INTEGER PRIMARY KEY, type TEXT);`);
  if (MUTATION && MUTATION.fixture === 'trigger') await db.exec("CREATE TABLE zz_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, x INTEGER); CREATE TRIGGER zz_trg AFTER UPDATE ON model_impl_objects BEGIN INSERT INTO zz_audit (x) VALUES (1); END;");   // 变异夹具（G1c）：UPDATE model_impl_objects 时触发器往另一张表写一行
  const mkModel = async (o) => (await db.run('INSERT INTO data_models (table_name, layer, is_deleted, companion_of, tech_owner) VALUES (?,?,?,?,?)', [(o && o.name) || ('m' + Math.random().toString(36).slice(2, 8)), 'ODS', (o && o.deleted) ? 1 : 0, (o && o.companion_of) || null, 'x'])).lastID;
  const mkObj = async (o) => (await db.run(
    `INSERT INTO model_impl_objects (obj_type, db_connection_id, schema_name, obj_name, reg_source, reg_hash, hash_algo, doc_path, doc_hash, doc_reported_at, is_deleted, created_at, updated_at, created_by, updated_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, '2000-01-01 00:00:00','2000-01-01 00:00:00','fx','fx')`,
    [o.type || 'PROC', o.conn === undefined ? 1 : o.conn, o.schema === undefined ? 'dbo' : o.schema, o.name || ('o' + Math.random().toString(36).slice(2, 9)), o.src || null, o.regHash || null, o.algo || null, o.docPath || null, o.docHash || null, o.docAt || null, o.deleted ? 1 : 0])).lastID;
  const link = (m, o) => db.run("INSERT INTO model_impl_links (model_id, object_id, role, sort_no, created_at, created_by) VALUES (?,?,'r',0,'2000-01-01 00:00:00','fx')", [m, o]);
  const objRow = (id) => db.get('SELECT * FROM model_impl_objects WHERE id = ?', [id]);
  const revOf = async (id) => (await db.get('SELECT config_rev FROM data_models WHERE id = ?', [id])).config_rev;
  const logCount = async () => (await db.get('SELECT COUNT(*) AS c FROM model_change_logs')).c;

  const logs = { warn: [], error: [], info: [] };
  const logger = { warn: (m) => logs.warn.push(String(m)), error: (m) => logs.error.push(String(m)), info: (m) => logs.info.push(String(m)) };
  const pass3 = (req, res, next) => next();
  const stub = { impl: async () => { throw new Error('读取器桩未设置'); }, calls: [] };
  let badgeClock = '2026-10-03 12:00:00';   // 服务端徽章时钟（注入）
  const openServers = [];
  // K2：被测模块的注入定时器（手动核验 20 秒上限、每日任务）在测试里一律传入测试自己的可控定时器（不触发、只登记 / 清除），不使用 setTimeout 默认值；默认值路径只在专门的 K2 用例里出现
  const ctlTimers = { all: [], setTimer: (fn, ms) => { const tm = { fn, ms, cleared: false }; ctlTimers.all.push(tm); return tm; }, clearTimer: (tm) => { if (tm) tm.cleared = true; } };
  const build = async (extra, { withRouter = true } = {}) => {
    const mod = createImplObjects({
      db: db.mod, manualVerifyTimers: ctlTimers, dailyVerifyTimers: ctlTimers, logger, authenticateToken: (req, res, next) => { req.user = { id: 1, role: 'admin', username: 'a', display_name: 'a' }; next(); },
      requireAdmin: pass3, requireNonViewer: pass3, canEditModel: () => true,
      badgeNow: () => badgeClock, verifyEnabled: (extra && extra.readDefinition) ? true : undefined, ...(extra || {}),
    });
    if (!withRouter) return { mod };
    const app = express(); app.use(express.json({ limit: '2.5mb' })); app.use('/api', mod.router);
    const srv = await listenOnSafePort(http.createServer(app));
    openServers.push(srv);
    const base = `http://127.0.0.1:${srv.address().port}`;
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => null) }; };
    return { mod, srv, call, close: () => new Promise((res) => srv.close(res)) };
  };

  try {
    // ── 0b：观察钩子类型校验 ──
    for (const [k, v] of [['onLockQueued', 'x'], ['onLockAcquired', null], ['onTxBegun', 5], ['onLockQueued', {}]]) {
      let threw = null; try { await build({ [k]: v }, { withRouter: false }); } catch (err) { threw = err; }
      check(`0b 钩子 ${k} = ${JSON.stringify(v)}（非函数）⇒ 工厂初始化抛错，消息点名该钩子`, !!threw && threw.message.includes(k), String(threw && threw.message));
    }
    {
      let threw = null; try { await build({ onLockQueued() {}, onLockAcquired: undefined, onTxBegun: async () => {} }, { withRouter: false }); } catch (err) { threw = err; }
      check('0b 钩子为函数或 undefined ⇒ 正常构造', threw === null, String(threw && threw.message));
    }
    // ── 0a：purgeLinksOfModel({ account: true, expectedParentId }) 目标状态复核 ──
    {
      const { mod } = await build({}, { withRouter: false });
      const P = await mkModel({ name: 'pa' }), Q = await mkModel({ name: 'qa' });
      const S = await mkModel({ name: 'sa' });                                   // 仍是独立模型（转伴生没成功）
      const C = await mkModel({ name: 'ca', companion_of: P });                  // 已是 P 的伴生表
      const D = await mkModel({ name: 'da', companion_of: P, deleted: true });   // 已删除的伴生表
      const W = await mkModel({ name: 'wa', companion_of: Q });                  // 别的主表的伴生表
      const oa = await mkObj({ type: 'FDL_TASK', conn: null, schema: null });
      for (const m of [S, C, D, W]) await link(m, oa);
      const linksOf = async (m) => (await db.all('SELECT object_id FROM model_impl_links WHERE model_id = ?', [m])).length;
      const w0 = logs.warn.length;
      const l0 = await logCount();
      let r = await mod.purgeLinksOfModel(S, { account: true, expectedParentId: P, user: { id: 1, display_name: 'a' } });
      check('0a 目标仍是独立模型（未被转成功）：返回 skipped = NOT_COMPANION_OF_PARENT，关系不动，config_rev 不变，无变更日志，记了 warn 日志',
        r.skipped === 'NOT_COMPANION_OF_PARENT' && (await linksOf(S)) === 1 && (await revOf(S)) === 1 && (await logCount()) === l0 && logs.warn.length === w0 + 1 && /跳过清理/.test(logs.warn[w0]), JSON.stringify([r, await linksOf(S), await revOf(S)]));
      r = await mod.purgeLinksOfModel(W, { account: true, expectedParentId: P, user: null });
      check('0a 目标是别的主表的伴生表 ⇒ 跳过，关系不动、config_rev 不变', r.skipped === 'NOT_COMPANION_OF_PARENT' && (await linksOf(W)) === 1 && (await revOf(W)) === 1);
      r = await mod.purgeLinksOfModel(D, { account: true, expectedParentId: P, user: null });
      check('0a 目标已删除 ⇒ 跳过，关系不动、config_rev 不变', r.skipped === 'NOT_COMPANION_OF_PARENT' && (await linksOf(D)) === 1 && (await revOf(D)) === 1);
      r = await mod.purgeLinksOfModel(C, { account: true, expectedParentId: P, user: { id: 1, display_name: 'a' } });
      const lg = await db.get("SELECT * FROM model_change_logs WHERE model_id = ? AND change_type = 'impl_object'", [C]);
      check('0a 目标确是 expectedParentId 的未删除伴生表 ⇒ 照常清理并记账：关系清空、config_rev +1、1 条 impl_object 日志', r.accounted === true && r.skipped === undefined && (await linksOf(C)) === 0 && (await revOf(C)) === 2 && !!lg && /转为伴生表/.test(lg.change_summary), JSON.stringify(r));
      const e1 = await mod.purgeLinksOfModel(C, { account: true, user: null }).then(() => 'resolved', (err) => err.message);
      check('0a account 模式缺 expectedParentId ⇒ 抛错（调用方必须传父表 id，不静默放行）', /expectedParentId/.test(String(e1)), String(e1));
      // server.js 两处调用点都传了 expectedParentId
      const callSites = srvText.split(/\r?\n/).filter((l) => /purgeLinksOfModel\(/.test(l) && /account:\s*true/.test(l));
      check('0a server.js：每处 account: true 的 purgeLinksOfModel 调用都带 expectedParentId（共 2 处：link-existing / link-by-name）', callSites.length === 2 && callSites.every((l) => /expectedParentId:\s*parentId/.test(l)), JSON.stringify(callSites.map((l) => l.trim().slice(0, 120))));
    }

    // ── 核验模块：三态落库 + NULL 定义 ──
    const lockLog = [];
    const env = await build({
      readDefinition: (o) => { stub.calls.push({ ...o }); lockLog.push('read'); return stub.impl(o); },
      onLockQueued: (label) => { lockLog.push('lock:' + label); },
    });
    const { mod, call } = env;
    const mProd = await mkModel({ name: 'mv1' });
    const DEF1 = 'CREATE PROCEDURE dbo.usp_v\r\nAS\r\nSELECT 1;  \r\n';
    const DEF1_NORM = 'CREATE PROCEDURE dbo.usp_v\nAS\nSELECT 1;';
    const oV = await mkObj({ type: 'PROC', name: 'usp_v', schema: 'dbo', src: DEF1_NORM, regHash: sha(DEF1_NORM), algo: 'norm_v1' });
    await link(mProd, oV);
    const TS_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/;
    const dbNow = async () => (await db.get("SELECT datetime('now','localtime') AS t")).t;
    const near = (t, ref) => Math.abs(Date.parse(t.replace(' ', 'T') + 'Z') - Date.parse(ref.replace(' ', 'T') + 'Z')) <= 5000;
    {
      stub.impl = async () => ({ exists: true, definition: DEF1 });
      lockLog.length = 0; stub.calls.length = 0;
      const out = await mod.verifyObject(oV); const r = await objRow(oV); const t = await dbNow();
      check('落库·对象存在：prod_hash = 手写规范化文本的 SHA-256，prod_missing = 0，last_error = NULL，outcome = ok',
        out.outcome === 'ok' && r.prod_hash === sha(DEF1_NORM) && r.prod_missing === 0 && r.last_error === null, JSON.stringify([out, r]));
      check('落库·对象存在：verified_at = last_attempt_at（同值同格式 YYYY-MM-DD HH:MM:SS）且是 SQLite 当前本地时间', TS_RE.test(r.verified_at || '') && r.verified_at === r.last_attempt_at && near(r.verified_at, t), JSON.stringify([r.verified_at, r.last_attempt_at, t]));
      check('落库·最后一条 UPDATE 在模块锁内：读取（read）发生在占锁（lock:verify）之前，且本次核验只占一次锁', lockLog.join() === 'read,lock:verify' && stub.calls.length === 1 && stub.calls[0].schema_name === 'dbo' && stub.calls[0].obj_name === 'usp_v', lockLog.join());
      const gold = r;   // 之后失败 / 缺失用例的对照基线
      // 连库失败：只写 last_attempt_at / last_error，verified_at 与 prod_hash 不动
      // 把两个时间列改成远古哨兵值：失败若误写 verified_at 就会变成「现在」，与哨兵逐字比较才能区分（不会因同一秒而假绿）
      await db.run("UPDATE model_impl_objects SET last_attempt_at = '2000-01-01 00:00:00', verified_at = '2001-01-01 00:00:00' WHERE id = ?", [oV]);
      const gold2 = await objRow(oV);
      stub.impl = async () => { throw new Error('connect ETIMEDOUT 10.0.0.1:1433'); };
      lockLog.length = 0;
      const f = await mod.verifyObject(oV); const r2 = await objRow(oV); const t2 = await dbNow();
      check('落库·连库失败：verified_at 不动（与失败前逐字相同）', f.outcome === 'error' && r2.verified_at === gold2.verified_at, JSON.stringify([f, r2.verified_at, gold2.verified_at]));
      check('落库·连库失败：prod_hash / prod_missing 不动', r2.prod_hash === gold.prod_hash && r2.prod_missing === 0, JSON.stringify(r2));
      check('落库·连库失败：last_attempt_at 前进为 SQLite 当前时间，last_error 只存分类文案「超时」', near(r2.last_attempt_at, t2) && r2.last_attempt_at !== '2000-01-01 00:00:00' && r2.last_error === '超时', JSON.stringify(r2));
      check('T2 落库锁序：连接失败——先读取，之后恰有一次 lock:verify（失败分支的写库不绕开模块锁）', lockLog.join() === 'read,lock:verify', lockLog.join());
      // 存在但定义为 NULL：失败类（无权读取定义），不是 missing
      await db.run("UPDATE model_impl_objects SET last_attempt_at = '2000-01-01 00:00:00' WHERE id = ?", [oV]);
      stub.impl = async () => ({ exists: true, definition: null });
      lockLog.length = 0;
      const n = await mod.verifyObject(oV); const r3 = await objRow(oV);
      check('落库·存在但定义为 NULL：记「无权读取定义」且 prod_missing 仍为 0（不是缺失），verified_at / prod_hash 不动', n.outcome === 'error' && r3.last_error === '无权读取定义' && r3.prod_missing === 0 && r3.verified_at === gold2.verified_at && r3.prod_hash === gold.prod_hash && r3.last_attempt_at !== '2000-01-01 00:00:00', JSON.stringify([n, r3]));
      check('T2 落库锁序：定义为 NULL——先读取，之后恰有一次 lock:verify', lockLog.join() === 'read,lock:verify', lockLog.join());
      // 对象不存在
      await db.run("UPDATE model_impl_objects SET last_attempt_at = '2000-01-01 00:00:00', verified_at = '2000-01-01 00:00:00' WHERE id = ?", [oV]);
      stub.impl = async () => ({ exists: false, definition: null });
      lockLog.length = 0;
      const mi = await mod.verifyObject(oV); const r4 = await objRow(oV); const t4 = await dbNow();
      check('落库·对象不存在：prod_hash = NULL，prod_missing = 1，last_error = NULL，verified_at = last_attempt_at = SQLite 当前时间', mi.outcome === 'missing' && r4.prod_hash === null && r4.prod_missing === 1 && r4.last_error === null && TS_RE.test(r4.verified_at) && r4.verified_at === r4.last_attempt_at && near(r4.verified_at, t4), JSON.stringify([mi, r4]));
      check('T2 落库锁序：对象缺失——先读取，之后恰有一次 lock:verify', lockLog.join() === 'read,lock:verify', lockLog.join());
      // 存在后恢复：prod_missing 回 0
      stub.impl = async () => ({ exists: true, definition: DEF1 });
      await mod.verifyObject(oV); const r5 = await objRow(oV);
      check('落库·对象重新出现：prod_missing 回到 0，prod_hash 写回，last_error 清空', r5.prod_missing === 0 && r5.prod_hash === sha(DEF1_NORM) && r5.last_error === null);
      // 软删除保护：读取期间对象被删，最后一条 UPDATE 不写
      const oDel = await mkObj({ type: 'VIEW', name: 'v_del', schema: 'dbo' });
      stub.impl = async (o) => { await db.run('UPDATE model_impl_objects SET is_deleted = 1 WHERE id = ?', [o.id]); return { exists: true, definition: 'CREATE VIEW v_del AS SELECT 1' }; };
      await mod.verifyObject(oDel); const r6 = await objRow(oDel);
      check('落库·最后一条 UPDATE 带「对象仍未删除」条件：读取期间对象被软删除 ⇒ 不写任何核验列', r6.is_deleted === 1 && r6.prod_hash === null && r6.verified_at === null && r6.last_attempt_at === null);
      // 非 PROC/VIEW/TRIGGER、已删除 ⇒ skipped，且不读生产
      const oF = await mkObj({ type: 'FDL_TASK', conn: null, schema: null, name: 'fdl1' });
      stub.calls.length = 0; stub.impl = async () => ({ exists: true, definition: 'x' });
      const sk = [await mod.verifyObject(oF), await mod.verifyObject(oDel), await mod.verifyObject(99999)];
      check('核验·FDL_TASK / 已删除 / 不存在的对象 ⇒ skipped，不读生产', sk.every((x) => x.outcome === 'skipped') && stub.calls.length === 0, JSON.stringify(sk));
    }

    // ── 写入记录器 / 全表快照 / 差异比较（T6 / U1 / U2 / U3 共用，F1 / F2 / G1 / G2）──
    //   写入契约：被测操作期间，底层连接上出现的「每一条」写语句（任何表；UPDATE / INSERT / DELETE / REPLACE / 以 WITH 开头的写语句 / BEGIN / COMMIT / ROLLBACK / DDL 等）
    //   必须与「手写」期望序列逐条全等（条数、顺序、规范化空白后的 SQL 原文、参数）；没写进期望的写入（含事务语句）一律算多出来，判失败。
    //   记录器接在连接对象本身（Proxy）：run / exec / prepare(...).run|get|all|each / get / all / each 全部入口；get / all / each / prepare 路径上出现的写语句（RETURNING、WITH ... UPDATE 之类）同样记录。
    //   观测边界（G1，只用硬门，不引入引擎级 trace / authorizer）：
    //     a. 静态：四个被测源文件不 require 任何数据库驱动、不引用模块外的数据库全局，也不使用 prepare / bind（见「三、静态」一节）；
    //     b. 运行时：Proxy 上每个方法都核对 this === 测试传入的那个 Proxy（被测模块不得拆出方法裸调或经包装对象调用）；另在 sqlite3.Database 原型上挂观察钩子，
    //        任何不是夹具库那个连接的实例上出现的写语句（被测模块自己另开连接写库）一律记为 foreign；
    //     c. 行状态：快照覆盖夹具库「全部用户表」（sqlite_master 里 type = table 且名字不以 sqlite_ 开头），并核对 type = trigger 的集合与手写期望（空）全等、操作前后不变（触发器副作用 = 其他表出现多出来的行 / 触发器集合变化）；
    //     d. 每个被测操作结束后先排空（等核验队列空闲 + 让出事件循环）再拍后快照，延迟写入不会漏到观测窗口之外。
    //   行状态（G2）：操作前后对全部用户表做全表快照，按主键配对；行存在性、行数独立比对，能识别 insert / delete；差异必须恰等于手写期望（哪几行、哪几列、改成什么值），其余一律逐字不变。
    //   时间占位 TSV：严格的公民时间解析（测试里独立实现，回读校验），值必须落在「操作开始前取的 SQLite 当前时间 − 1 秒」到「操作结束后取的时间 + 1 秒」之间。
    const normWs = (s) => String(s).replace(/\s+/g, ' ').trim();
    const stripLead = (s) => { let t = String(s); for (;;) { const u = t.replace(/^\s+/, '').replace(/^--[^\n]*(\n|$)/, '').replace(/^\/\*[\s\S]*?\*\//, ''); if (u === t) return t; t = u; } };
    const isWriteSql = (sql) => {
      const s = stripLead(sql);
      return /^(UPDATE|INSERT|DELETE|REPLACE|BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|CREATE|DROP|ALTER|VACUUM|REINDEX|ANALYZE|ATTACH|DETACH)\b/i.test(s)
        || (/^WITH\b/i.test(s) && /\b(UPDATE|INSERT|DELETE|REPLACE)\b/i.test(s)) || (/^PRAGMA\b/i.test(s) && /=/.test(s));
    };
    const paramsOf = (args) => { const xs = args.filter((x) => typeof x !== 'function'); return xs.length === 1 && Array.isArray(xs[0]) ? xs[0].slice() : xs; };
    // G1b：sqlite3.Database 原型上的观察钩子——任何 Database 实例（含夹具库的原始连接 db.raw）上出现的写语句，只要放行标记 viaProxy 不为真（即不是经测试的 Proxy / 助手发起）就记为 foreign（K1a）
    const foreignWrites = [];
    const sqlite3Mod = require('sqlite3');
    const protoPatched = [];
    for (const k of ['run', 'get', 'all', 'each', 'exec', 'prepare']) {
      const orig = sqlite3Mod.Database.prototype[k];
      sqlite3Mod.Database.prototype[k] = function (sql, ...a) { if (!viaProxy && (k === 'exec' || isWriteSql(sql))) foreignWrites.push({ api: k, sql: normWs(sql) }); return orig.call(this, sql, ...a); };
      protoPatched.push([k, orig]);
    }
    const restoreProto = () => { for (const [k, orig] of protoPatched) sqlite3Mod.Database.prototype[k] = orig; restoreTimers(); };
    // M1 运行时：记录器在整个套件期间持续开着；每个操作用 reset()（开窗）/ close()（关窗）圈定观测窗口，窗口之外出现的写语句记入 outOfWindow（延迟写入）；
    //   套件结束前先排空（各模块 idle + 让出若干轮事件循环）再断言 outOfWindow 为空；仍未结束的被测模块定时器由 K2 断言兜底
    const allRecs = [];
    const recordingDb = (rawDb, tagFn) => {
      const writes = []; const badIdentity = []; const outOfWindow = []; let open = false;
      const note = (api, sql, args) => { if ((api === 'exec' || isWriteSql(sql)) && !open) outOfWindow.push({ api, sql: normWs(sql) }); if (api === 'exec' || isWriteSql(sql)) writes.push({ api, sql: normWs(sql), params: api === 'exec' ? [] : paramsOf(args), tag: tagFn ? tagFn() : undefined }); };
      const proxy = new Proxy(rawDb, { get(t, k) {
        if (k === 'run' || k === 'get' || k === 'all' || k === 'each' || k === 'exec') return function (sql, ...a) { if (this !== proxy) badIdentity.push(k); note(k, sql, a); return withVia(() => { const r = t[k](sql, ...a); return r === t ? proxy : r; }); };   // K1a 放行标记只覆盖这一次同步调用；K1b 返回值若是原始连接就包回 Proxy（防御性，主要依赖 K1a）
        if (k === 'prepare') return function (sql, ...a) {
          if (this !== proxy) badIdentity.push(k);
          const st = withVia(() => t.prepare(sql, ...a));
          return new Proxy(st, { get(s, kk) {
            if (kk === 'run' || kk === 'get' || kk === 'all' || kk === 'each') return (...b) => { note('prepare.' + kk, sql, b); return s[kk](...b); };
            const v = s[kk]; return typeof v === 'function' ? v.bind(s) : v;
          } });
        };
        const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
      } });
      const rec = { db: proxy, writes, badIdentity, outOfWindow, drain: null, reset() { writes.length = 0; open = true; }, close() { open = false; }, isOpen: () => open, seq: () => writes.map((w) => ({ sql: w.sql, params: w.params })) };
      allRecs.push(rec);
      return rec;
    };
    const expSeq = (pairs) => pairs.map(([sql, params]) => ({ sql: normWs(sql), params }));
    // 严格公民时间解析（独立实现，回读校验：2026-02-30、月份 13、小时 24、分钟 60 一律 NaN）
    const strictCivilMs = (v) => {
      const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(typeof v === 'string' ? v : '');
      if (!m) return NaN;
      const [Y, Mo, D, h, mi, s] = m.slice(1).map(Number);
      const d = new Date(Date.UTC(Y, Mo - 1, D, h, mi, s));
      return (d.getUTCFullYear() === Y && d.getUTCMonth() === Mo - 1 && d.getUTCDate() === D && d.getUTCHours() === h && d.getUTCMinutes() === mi && d.getUTCSeconds() === s) ? d.getTime() : NaN;
    };
    const tablesOf = async () => (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name")).map((r) => r.name);
    const triggersOf = async () => (await db.all("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"));
    const EXPECT_TRIGGERS = [];   // 手写期望：夹具库（server.js 的建表 SQL + 测试自建的辅助表）里没有任何触发器
    /** 全部用户表的全表快照（按主键配对）+ 触发器集合 + 取快照时刻（SQLite 当前本地时间，严格解析为毫秒） */
    const snapAll = async (drain) => {
      if (drain) await drain();
      await turns(2);   // G1d：排空——先等调用方给的空闲信号，再让出事件循环，延迟写入不会漏到窗口之外
      const s = { tables: {}, triggers: await triggersOf(), at: strictCivilMs(await dbNow()) };
      for (const t of await tablesOf()) {
        const info = await db.all(`PRAGMA table_info(${t})`);
        const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        s.tables[t] = { pk, rows: await db.all(`SELECT * FROM ${t}`) };
      }
      return s;
    };
    const keyOf = (pk, row) => pk.map((c) => row[c]);
    /** 差异：按主键配对；只要表集合、行存在性或行数有变化就产生 insert / delete / table-set 条目。返回数组带 win（窗口两端时刻）与 counts */
    const diffSnap = (a, b) => {
      const out = [];
      const names = [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort();
      for (const t of names) {
        const x = a.tables[t], y = b.tables[t];
        if (!x || !y) { out.push({ table: t, op: 'table-set' }); continue; }
        const am = new Map(x.rows.map((r) => [JSON.stringify(keyOf(x.pk, r)), r])), bm = new Map(y.rows.map((r) => [JSON.stringify(keyOf(y.pk, r)), r]));
        if (x.pk.length === 0) { out.push({ table: t, op: 'no-pk' }); continue; }   // 没有主键的表无法配对：直接判差异（夹具里所有表都应有主键）
        const keys = [...new Set([...am.keys(), ...bm.keys()])].map((k) => JSON.parse(k)).sort((p, q) => { for (let i = 0; i < p.length; i++) { if (p[i] < q[i]) return -1; if (p[i] > q[i]) return 1; } return 0; });
        for (const key of keys) {
          const ks = JSON.stringify(key), r1 = am.get(ks), r2 = bm.get(ks);
          if (!r1) out.push({ table: t, key, op: 'insert', row: r2 });
          else if (!r2) out.push({ table: t, key, op: 'delete', row: r1 });
          else { const cols = {}; for (const c of Object.keys(r1)) if (!isDeepStrictEqual(r1[c], r2[c])) cols[c] = [r1[c], r2[c]]; if (Object.keys(cols).length) out.push({ table: t, key, op: 'update', cols }); }
        }
      }
      out.win = { lo: a.at - 1000, hi: b.at + 1000 };
      out.countsSame = names.every((t) => a.tables[t] && b.tables[t] && a.tables[t].rows.length === b.tables[t].rows.length);
      out.triggersSame = isDeepStrictEqual(a.triggers, EXPECT_TRIGGERS) && isDeepStrictEqual(b.triggers, EXPECT_TRIGGERS);
      return out;   // 顺序：先按表名、再按主键升序
    };
    const TSV = { ts: true };   // 期望里的「SQLite 当前本地时间」占位：严格公民时间，且落在 [操作前时刻 − 1 秒, 操作后时刻 + 1 秒]
    const matchVal = (a, e, win) => {
      if (e !== TSV) return isDeepStrictEqual(a, e);
      const ms = strictCivilMs(a);
      return Number.isFinite(ms) && ms >= win.lo && ms <= win.hi;
    };
    /** 实际差异与手写期望全等：条数、表、主键（期望里写 rid = 对象 id）、操作类型、被改的列集合、每列的前后值；期望里只允许 update（出现 insert / delete / table-set 即多出来）；行数与触发器集合同样要求不变 */
    const diffEquals = (actual, expected) => actual.countsSame === true && actual.triggersSame === true && actual.length === expected.length && actual.every((x, i) => {
      const e = expected[i];
      if (x.table !== e.table || x.op !== 'update' || e.op !== 'update' || !isDeepStrictEqual(x.key, [e.rid])) return false;
      const ak = Object.keys(x.cols).sort(), ek = Object.keys(e.cols).sort();
      return isDeepStrictEqual(ak, ek) && ak.every((c) => matchVal(x.cols[c][0], e.cols[c][0], actual.win) && matchVal(x.cols[c][1], e.cols[c][1], actual.win));
    });
    const diffText = (d) => JSON.stringify({ win: d.win, countsSame: d.countsSame, triggersSame: d.triggersSame, diff: [...d] });
    // K1 钩子自检（正反两面）：① 直接对夹具库的原始连接 db.raw 写（不经 Proxy、不置放行标记）会被原型钩子记为 foreign——这正是「拿到原始连接后的任何直接调用」的判红依据；
    //   ② 经记录器 Proxy 写不会被记为 foreign，且 Proxy 的方法返回值（原始连接）被包回 Proxy 自身（K1b）
    {
      const n0 = foreignWrites.length;
      await new Promise((res, rej) => db.raw.exec('CREATE TABLE zz_hook (a)', (e) => (e ? rej(e) : res())));
      const leaked = foreignWrites.slice(n0);
      foreignWrites.splice(n0);   // 自检产生的 foreign 记录清掉，不影响后面的 G1b 断言
      const tmp = recordingDb(db.raw); tmp.reset();
      let ret = null;
      await new Promise((res, rej) => { ret = tmp.db.run('DROP TABLE zz_hook', [], (e) => (e ? rej(e) : res())); });
      tmp.close();
      check('K1 钩子自检：直接对原始连接 db.raw 写被记为 foreign（放行标记不为真）；经记录器 Proxy 写不被记为 foreign，且方法返回值被包回 Proxy 自身（不是原始连接）',
        leaked.length === 1 && /^CREATE TABLE zz_hook/.test(leaked[0].sql) && foreignWrites.length === n0 && ret === tmp.db && ret !== db.raw, JSON.stringify([leaked, foreignWrites.slice(n0), ret === tmp.db]));
    }
    // 手写的写语句文本（独立写出，不取被测模块的常量；比较时两侧都规范化空白）
    const W_OK = "UPDATE model_impl_objects SET prod_hash = ?, prod_missing = 0, verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = NULL WHERE id = ? AND is_deleted = 0";
    const W_MISSING = "UPDATE model_impl_objects SET prod_hash = NULL, prod_missing = 1, verified_at = datetime('now','localtime'), last_attempt_at = datetime('now','localtime'), last_error = NULL WHERE id = ? AND is_deleted = 0";
    const W_FAIL = "UPDATE model_impl_objects SET last_attempt_at = datetime('now','localtime'), last_error = ? WHERE id = ? AND is_deleted = 0";

    // ── T6：每种结果的写入序列与行状态全等（F1 / F2）──
    {
      const e6rec = recordingDb(db.raw);
      let t6next = null;
      const e6 = await build({ db: e6rec.db, readDefinition: async () => t6next() }, { withRouter: false });
      e6rec.drain = () => e6.mod.idleVerifies();
      const o6 = await mkObj({ type: 'PROC', name: 'usp_t6', schema: 'dbo' });
      const oSent6 = await mkObj({ type: 'PROC', name: 'usp_t6_sentinel', schema: 'dbo' });
      await db.run("UPDATE model_impl_objects SET prod_hash = 'sent-hash', prod_missing = 1, verified_at = '2026-10-01 10:00:00', last_attempt_at = '2026-10-02 10:00:00', last_error = '超时' WHERE id = ?", [oSent6]);
      const sent6Before = JSON.stringify(await objRow(oSent6));
      const V0 = '2001-01-01 00:00:00', A0 = '2001-01-02 00:00:00', NEWDEF = 'CREATE PROC t AS SELECT 1';
      for (const c of [
        { label: '成功', next: () => ({ exists: true, definition: NEWDEF }), outcome: 'ok', base: { prod_missing: 1, last_error: '登录失败' }, seq: [[W_OK, [sha(NEWDEF), o6]]], stamped: true,
          cols: { prod_hash: ['base-hash', sha(NEWDEF)], prod_missing: [1, 0], verified_at: [V0, TSV], last_attempt_at: [A0, TSV], last_error: ['登录失败', null] } },
        { label: '缺失', next: () => ({ exists: false, definition: null }), outcome: 'missing', base: { prod_missing: 0, last_error: '登录失败' }, seq: [[W_MISSING, [o6]]], stamped: true,
          cols: { prod_hash: ['base-hash', null], prod_missing: [0, 1], verified_at: [V0, TSV], last_attempt_at: [A0, TSV], last_error: ['登录失败', null] } },
        { label: '读取失败', next: () => { throw new Error('connect ECONNREFUSED'); }, outcome: 'error', base: { prod_missing: 1, last_error: null }, seq: [[W_FAIL, ['连接失败', o6]]], stamped: false,
          cols: { last_attempt_at: [A0, TSV], last_error: [null, '连接失败'] } },
        { label: '定义为 NULL', next: () => ({ exists: true, definition: null }), outcome: 'error', base: { prod_missing: 1, last_error: '超时' }, seq: [[W_FAIL, ['无权读取定义', o6]]], stamped: false,
          cols: { last_attempt_at: [A0, TSV], last_error: ['超时', '无权读取定义'] } },
      ]) {
        const label = c.label;
        await db.run('UPDATE model_impl_objects SET prod_hash = ?, prod_missing = ?, verified_at = ?, last_attempt_at = ?, last_error = ? WHERE id = ?', ['base-hash', c.base.prod_missing, V0, A0, c.base.last_error, o6]);
        const before = await snapAll(); e6rec.reset(); t6next = c.next;
        const out = await e6.mod.verifyObject(o6);
        const seq = e6rec.seq(); const after = await snapAll(() => e6.mod.idleVerifies()); e6rec.close(); const d = diffSnap(before, after);
        check(`T6 三态写库：${label} ⇒ 被测操作期间全部写语句（任何表、任何语句类型、含事务语句）与手写期望序列深度全等：恰 1 条，就是对应的那条 UPDATE，参数逐个相等（outcome = ${c.outcome}）`,
          out.outcome === c.outcome && isDeepStrictEqual(seq, expSeq(c.seq)), JSON.stringify([out.outcome, seq]));
        const rowAfter = after.tables.model_impl_objects.rows.find((r) => r.id === o6);
        check(`T6 三态写库：${label} ⇒ 夹具库全部用户表前后快照（按主键配对，行存在性与行数独立比对）的差异恰等于手写期望：只有目标行的 ${Object.keys(c.cols).join(' / ')} 变化，其余行、其余列逐字不变${c.stamped ? '，且 verified_at = last_attempt_at' : ''}`,
          diffEquals(d, [{ table: 'model_impl_objects', rid: o6, op: 'update', cols: c.cols }]) && (!c.stamped || rowAfter.verified_at === rowAfter.last_attempt_at), diffText(d));
        check(`G1c 触发器集合：T6 ${label} 操作前后 sqlite_master 中 type = trigger 的集合都与手写期望（空）全等`, isDeepStrictEqual(before.triggers, EXPECT_TRIGGERS) && isDeepStrictEqual(after.triggers, EXPECT_TRIGGERS), JSON.stringify([before.triggers, after.triggers]));
        check(`T6 三态写库：${label} ⇒ 哨兵行（另一个对象，带核验数据）全列不变（补充断言，主判据是上面的全表差异）`, JSON.stringify(await objRow(oSent6)) === sent6Before);
      }
      check('G1b 观测身份：T6 四种结果里被测模块的每次数据库调用都经测试传入的那个 Proxy（this 即该 Proxy），且夹具库之外的任何连接上没有出现写语句', e6rec.badIdentity.length === 0 && foreignWrites.length === 0, JSON.stringify([e6rec.badIdentity, foreignWrites]));
      check('T6 写语句常量本身：成功 / 缺失各自只含一条 UPDATE（单语句，不含分号拼接的第二条）', [Ver.SQL.SQL_WRITE_OK, Ver.SQL.SQL_WRITE_MISSING, Ver.SQL.SQL_WRITE_FAILURE].every((q) => /^UPDATE model_impl_objects SET /.test(q) && !/;/.test(q)));
    }
    // ── T7：读取结果异常 ⇒ outcome = error，last_attempt_at 前进，last_error 为指定分类，prod_hash / verified_at 不动 ──
    {
      const o7 = await mkObj({ type: 'PROC', name: 'usp_t7', schema: 'dbo' });
      await db.run("UPDATE model_impl_objects SET prod_hash = 'keep-hash', verified_at = '2001-01-01 00:00:00' WHERE id = ?", [o7]);
      const mk7 = (readDefinition, normalize) => Ver.createImplVerify({ db: db.mod, logger, withWriteLock: (label, txn, fn) => fn(), readDefinition, ...(normalize ? { normalize } : {}) });
      for (const [label, read, norm7, want] of [
        ['读取器返回 {}（缺 exists）', async () => ({}), null, '查询出错'],
        ['读取器返回 null', async () => null, null, '查询出错'],
        ['exists:true 但 definition 不是字符串（数字）', async () => ({ exists: true, definition: 12345 }), null, '查询出错'],
        ['normalize 抛错', async () => ({ exists: true, definition: 'CREATE PROC x AS SELECT 1' }), () => { throw new Error('normalize boom'); }, '未知错误'],
      ]) {
        await db.run("UPDATE model_impl_objects SET last_attempt_at = '2000-01-01 00:00:00', last_error = NULL WHERE id = ?", [o7]);
        const out = await mk7(read, norm7).verifyObject(o7);
        const row = await objRow(o7);
        check(`T7 读取结果异常：${label} ⇒ outcome = error，last_attempt_at 前进，last_error = 「${want}」，prod_hash / verified_at 不动`,
          out.outcome === 'error' && out.error === want && row.last_error === want && row.last_attempt_at !== '2000-01-01 00:00:00' && TS_RE.test(row.last_attempt_at) && row.prod_hash === 'keep-hash' && row.verified_at === '2001-01-01 00:00:00', JSON.stringify([out, row.last_error, row.last_attempt_at, row.prod_hash, row.verified_at]));
      }
    }
    // ── R1：默认读取器 + 假连接池 ⇒ 元数据不可见不误判为缺失 ──
    {
      let recordset = [];
      const fakePoolR1 = { request() { return { input() {}, async query() { return { recordset }; } }; } };
      // 默认读取器 + 假连接池（连接行用桩，本文件不直写 db_connections 表——该表的写点由 verify-db-connections-writers 统管）
      const readerR1 = Ver.createSqlServerDefinitionReader({ getConnectionRow: async () => ({ id: 1, type: 'sqlserver', host: 'h', port: 1433, database: 'd', username: 'u', password: 'enc' }), getMssqlPool: async () => fakePoolR1, decryptPassword: (x) => x });
      const eR1 = await build({ readDefinition: readerR1 }, { withRouter: false });
      const oR1 = await mkObj({ type: 'PROC', name: 'usp_r1', schema: 'dbo' });
      recordset = [{ can_view: 0, otype: null, def: null }];
      const a = await eR1.mod.verifyObject(oR1); const ra = await objRow(oR1);
      check('R1 端到端：无对象行且 can_view = 0 ⇒ outcome = error，last_error = 「无权读取定义」，prod_missing 仍为 0（不记缺失），verified_at 不动', a.outcome === 'error' && ra.last_error === '无权读取定义' && ra.prod_missing === 0 && ra.verified_at === null, JSON.stringify([a, ra]));
      recordset = [{ can_view: 1, otype: null, def: null }];
      const b = await eR1.mod.verifyObject(oR1); const rb = await objRow(oR1);
      check('R1 端到端：无对象行且 can_view = 1 ⇒ outcome = missing，prod_missing = 1，last_error 清空', b.outcome === 'missing' && rb.prod_missing === 1 && rb.last_error === null, JSON.stringify([b, rb]));
    }

    // ── U1：每种结果的写语句序列与手写期望全等（恰 1 条 UPDATE），且每条写语句都在锁内执行（测试用的 withWriteLock 维护 inLock，记录器记下每条写语句执行时的 inLock）──
    {
      let inLock = false;
      const u1rec = recordingDb(db.raw, () => inLock);
      const lockedWrite = async (label, txn, fn) => { inLock = true; try { return await fn(); } finally { inLock = false; } };
      const o1 = await mkObj({ type: 'PROC', name: 'usp_u1', schema: 'dbo' });
      const DEF_U = 'CREATE PROC u AS SELECT 1';
      for (const [label, read, pairs] of [
        ['成功', async () => ({ exists: true, definition: DEF_U }), [[W_OK, [sha(DEF_U), o1]]]],
        ['缺失', async () => ({ exists: false, definition: null }), [[W_MISSING, [o1]]]],
        ['读取失败', async () => { throw new Error('connect ECONNREFUSED'); }, [[W_FAIL, ['连接失败', o1]]]],
        ['定义为 NULL', async () => ({ exists: true, definition: null }), [[W_FAIL, ['无权读取定义', o1]]]],
      ]) {
        u1rec.reset();
        const v1 = Ver.createImplVerify({ db: u1rec.db, logger, withWriteLock: lockedWrite, readDefinition: read });
        u1rec.drain = () => v1.idle();
        await v1.verifyObject(o1); await v1.idle(); await turns(2);   // G1d：排空后再看写语句序列
        u1rec.close();
        check(`U1 锁内执行：${label} ⇒ 全部写语句序列与手写期望深度全等（恰 1 条 UPDATE），且每条写语句执行时 inLock = true（不是先空锁、再在锁外 run）`,
          isDeepStrictEqual(u1rec.seq(), expSeq(pairs)) && u1rec.writes.length === 1 && u1rec.writes.every((w) => w.tag === true), JSON.stringify(u1rec.writes.map((w) => [w.sql.slice(0, 40), w.params, w.tag])));
      }
      check('G1b 观测身份：U1 里被测模块的每次数据库调用都经测试传入的那个 Proxy，夹具库之外的连接上没有写语句', u1rec.badIdentity.length === 0 && foreignWrites.length === 0, JSON.stringify([u1rec.badIdentity, foreignWrites]));
    }
    // ── U2：等写锁期间停服超时 ⇒ 拿到锁后也不能再写（锁内复查 writable）：写语句序列为空 ──
    {
      let queued = 0, releaseLock; const lockGate = new Promise((res) => { releaseLock = res; });
      const gatedLock = async (label, txn, fn) => { queued++; await lockGate; return fn(); };
      const u2rec = recordingDb(db.raw);
      const o2 = await mkObj({ type: 'PROC', name: 'usp_u2', schema: 'dbo' });
      await db.run("UPDATE model_impl_objects SET prod_hash = 'old-hash', verified_at = '2001-02-03 04:05:06', last_attempt_at = '2001-02-03 04:05:06', last_error = NULL WHERE id = ?", [o2]);
      const v2 = Ver.createImplVerify({ db: u2rec.db, logger, withWriteLock: gatedLock, readDefinition: async () => ({ exists: true, definition: 'CREATE PROC u AS SELECT 1' }), stopWaitMs: 20 });
      u2rec.reset();
      const inflight2 = v2.verifyObject(o2);                       // 读取立即成功，随后卡在「等写锁」
      await H.waitFor(async () => queued === 1, 5000, 10);        // 确认写锁请求已排队
      await v2.stop();                                            // 等待上限（注入 20 毫秒）到了就返回，writable = false
      releaseLock();                                              // 之后才拿到锁
      const fin2 = await inflight2; await v2.idle(); await turns(2); u2rec.close();
      u2rec.drain = () => v2.idle();
      const row2 = await objRow(o2);
      check('U2 等写锁期间停服超时：拿到锁后不执行任何写语句（任何表、任何类型，序列为空），库里旧值不变，outcome = stopped', fin2.outcome === 'stopped' && isDeepStrictEqual(u2rec.seq(), []) && row2.prod_hash === 'old-hash' && row2.verified_at === '2001-02-03 04:05:06' && row2.last_attempt_at === '2001-02-03 04:05:06', JSON.stringify([fin2, u2rec.seq(), row2.prod_hash, row2.verified_at]));
    }
    // ── U4：停服等待默认值为 3000 毫秒 ──
    {
      const delays = []; const realSetTimeout = global.setTimeout;
      global.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
      try {
        const v4 = Ver.createImplVerify({ db: db.mod, logger, withWriteLock: (l, t, fn) => fn(), readDefinition: async () => ({ exists: true, definition: 'x' }) });
        await v4.stop();                                          // 未传 stopWaitMs：用默认值
      } finally { global.setTimeout = realSetTimeout; }
      check('U4 停服等待默认值：未传 stopWaitMs 时 stop 排的等待计时器恰为 3000 毫秒（导出常量 STOP_WAIT_MS 也是 3000）', delays.length === 1 && delays[0] === 3000 && Ver.STOP_WAIT_MS === 3000, JSON.stringify([delays, Ver.STOP_WAIT_MS]));
    }
    // ── U3：算法迁移（重算 / 旧算法行 PUT source / PUT doc）——F1 写语句全等 + F2 四表差异全等 + F3 重算的期望集合由测试自己给出（手写夹具 id），不取 recomputeNormHashes 的返回值生成期望 ──
    {
      const u3rec = recordingDb(db.raw);
      const e3b = await build({ db: u3rec.db }, {});
      const rawSrc = 'create or alter proc x\r\nAS\r\nSELECT 1;';
      const N1 = 'CREATE PROC x\nAS\nSELECT 1;';                    // rawSrc 的 norm_v1 规范化文本（手写）
      const OLD_VERIFY = "UPDATE model_impl_objects SET prod_hash = 'old-prod', prod_missing = 1, verified_at = '2026-10-01 10:00:00', last_attempt_at = '2026-10-02 10:00:00', last_error = '超时' WHERE id = ?";
      const withData = async (id) => { await db.run(OLD_VERIFY, [id]); return id; };
      const mkRaw = async (name) => withData(await mkObj({ type: 'PROC', name, schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0', docPath: 'a.sql', docHash: sha('d') }));
      const rowJson = async (id) => JSON.stringify(await objRow(id));
      const CLEARED = () => ({ prod_hash: ['old-prod', null], prod_missing: [1, 0], verified_at: ['2026-10-01 10:00:00', null], last_attempt_at: ['2026-10-02 10:00:00', null], last_error: ['超时', null] });
      const SQL_RECALC = 'UPDATE model_impl_objects SET reg_hash = ?, doc_hash = NULL, hash_algo = ?, prod_hash = NULL, prod_missing = 0, verified_at = NULL, last_attempt_at = NULL, last_error = NULL WHERE id = ? AND hash_algo IS NOT ?';
      const SQL_PUT_SRC = "UPDATE model_impl_objects SET reg_source = ?, reg_hash = ?, hash_algo = ?, doc_hash = CASE WHEN ? = 1 THEN NULL ELSE doc_hash END, prod_hash = CASE WHEN ? = 1 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 1 THEN 0 ELSE prod_missing END, verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE last_attempt_at END, last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ? AND is_deleted = 0";
      const SQL_PUT_DOC = "UPDATE model_impl_objects SET doc_path = ?, doc_hash = ?, hash_algo = ?, doc_reported_at = datetime('now','localtime'), reg_hash = CASE WHEN ? = 1 THEN ? ELSE reg_hash END, prod_hash = CASE WHEN ? = 1 THEN NULL ELSE prod_hash END, prod_missing = CASE WHEN ? = 1 THEN 0 ELSE prod_missing END, verified_at = CASE WHEN ? = 1 THEN NULL ELSE verified_at END, last_attempt_at = CASE WHEN ? = 1 THEN NULL ELSE last_attempt_at END, last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END, updated_at = datetime('now','localtime'), updated_by = ? WHERE id = ? AND is_deleted = 0";
      /** 记录一次操作：操作前快照 → 清空记录器 → 执行 → 取写语句序列 → 操作后快照与差异 */
      const cap = async (fn) => { const before = await snapAll(); u3rec.reset(); const out = await fn(); const seq = u3rec.seq(); const after = await snapAll(() => e3b.mod.idleVerifies()); u3rec.close(); return { out, seq, before, after, diff: diffSnap(before, after) }; };
      u3rec.drain = () => e3b.mod.idleVerifies();   // G1d：后快照前先排空

      // ── 重算 ──
      const oRe = await mkRaw('usp_u3_re');                                                                                                                         // 有源码 + 文档哈希的旧算法行
      const oRe2 = await withData(await mkObj({ type: 'VIEW', name: 'v_u3_re2', schema: 'dbo', algo: 'raw_v0', docPath: 'p/b.sql', docHash: sha('d2') }));          // 只有文档哈希的旧算法行（reg_hash 本来就是 NULL）
      const oSentNorm = await withData(await mkObj({ type: 'PROC', name: 'usp_u3_sent_norm', schema: 'dbo', src: 'CREATE PROC z AS SELECT 1', regHash: sha('CREATE PROC z AS SELECT 1'), algo: 'norm_v1' }));
      const sentNormBefore = await rowJson(oSentNorm);
      const rawIds = (await db.all("SELECT id FROM model_impl_objects WHERE hash_algo IS NOT NULL AND hash_algo <> 'norm_v1' ORDER BY id")).map((r) => r.id);
      const nullAlgoWithHash = (await db.get('SELECT COUNT(*) AS c FROM model_impl_objects WHERE hash_algo IS NULL AND (reg_source IS NOT NULL OR reg_hash IS NOT NULL OR doc_hash IS NOT NULL)')).c;
      check('U3 迁移只用一条 UPDATE：重算——前提：夹具里待迁移的旧算法行恰为手写的两个 id（oRe / oRe2），没有带哈希材料却无算法标记的行（期望集合由测试自己给出）', isDeepStrictEqual(rawIds, [oRe, oRe2]) && nullAlgoWithHash === 0, JSON.stringify([rawIds, [oRe, oRe2], nullAlgoWithHash]));
      const rc = await cap(() => e3b.mod.recomputeNormHashes());
      check('U3 迁移只用一条 UPDATE：重算——被测操作期间全部写语句与手写期望序列深度全等：恰 2 条 UPDATE，按 id 升序每行一条、参数逐个相等，没有任何其他写语句（不含事务语句、不碰任何其他表、不碰 norm_v1 行）',
        isDeepStrictEqual(rc.seq, expSeq([[SQL_RECALC, [sha(N1), 'norm_v1', oRe, 'norm_v1']], [SQL_RECALC, [null, 'norm_v1', oRe2, 'norm_v1']]])), JSON.stringify(rc.seq));
      check('U3 迁移只用一条 UPDATE：重算——被更新对象 id 的多重集合 = 手写的 [oRe, oRe2]（每个恰一次）；返回值与手写期望一致（扫描 2、更新 2、失败 0；期望不取自返回值）',
        isDeepStrictEqual(rc.seq.map((w) => w.params[2]).sort((a, b) => a - b), [oRe, oRe2].sort((a, b) => a - b)) && isDeepStrictEqual(rc.out, { scanned: 2, updated: 2, failed: [] }), JSON.stringify([rc.seq.map((w) => w.params[2]), rc.out]));
      check('U3 迁移只用一条 UPDATE：重算——夹具库全部用户表前后快照（按主键配对、行数与触发器集合同样比对）的差异恰等于手写期望：只有 oRe / oRe2 两行，各自的哈希、算法与五个核验字段变化，其余行（含 norm_v1 哨兵）、其余列逐字不变',
        diffEquals(rc.diff, [
          { table: 'model_impl_objects', rid: oRe, op: 'update', cols: { reg_hash: [sha(rawSrc), sha(N1)], doc_hash: [sha('d'), null], hash_algo: ['raw_v0', 'norm_v1'], ...CLEARED() } },
          { table: 'model_impl_objects', rid: oRe2, op: 'update', cols: { doc_hash: [sha('d2'), null], hash_algo: ['raw_v0', 'norm_v1'], ...CLEARED() } },
        ]), diffText(rc.diff));
      check('U3 迁移只用一条 UPDATE：重算——哨兵行（已是 norm_v1、带核验数据）全列不变（补充断言，主判据是上面的全表差异）', (await rowJson(oSentNorm)) === sentNormBefore);

      // ── PUT source ──
      const oSrc = await mkRaw('usp_u3_src'); const oSentA = await mkRaw('usp_u3_sent_a'); const sentABefore = await rowJson(oSentA);
      const T2 = 'CREATE PROC x\nAS\nSELECT 2;';
      const ps = await cap(() => e3b.call('PUT', `/api/model-impl-objects/${oSrc}/source`, { reg_source: T2 }));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT source——被测操作期间全部写语句与手写期望序列深度全等：恰 3 条（BEGIN IMMEDIATE、那一条 UPDATE、COMMIT），参数逐个相等，WHERE 是单个 id = ? 与 is_deleted = 0',
        ps.out.status === 200 && isDeepStrictEqual(ps.seq, expSeq([['BEGIN IMMEDIATE', []], [SQL_PUT_SRC, [T2, sha(T2), 'norm_v1', 1, 1, 1, 1, 1, 1, 'a', oSrc]], ['COMMIT', []]])), JSON.stringify([ps.out.status, ps.seq]));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT source——夹具库全部用户表前后快照（按主键配对、行数与触发器集合同样比对）的差异恰等于手写期望：只有目标行的源码、哈希、算法、doc_hash、五个核验字段与 updated_at / updated_by 变化，其余行（含旧算法哨兵）逐字不变',
        diffEquals(ps.diff, [{ table: 'model_impl_objects', rid: oSrc, op: 'update', cols: { reg_source: [rawSrc, T2], reg_hash: [sha(rawSrc), sha(T2)], hash_algo: ['raw_v0', 'norm_v1'], doc_hash: [sha('d'), null], ...CLEARED(), updated_at: ['2000-01-01 00:00:00', TSV], updated_by: ['fx', 'a'] } }]), diffText(ps.diff));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT source——哨兵行（另一个旧算法、带核验数据的对象）全列不变（补充断言）', (await rowJson(oSentA)) === sentABefore);

      // ── PUT doc ──
      const oDoc = await mkRaw('usp_u3_doc'); const oSentB = await mkRaw('usp_u3_sent_b'); const sentBBefore = await rowJson(oSentB);
      const T3 = 'CREATE PROC x\nAS\nSELECT 3;';
      const pd = await cap(() => e3b.call('PUT', `/api/model-impl-objects/${oDoc}/doc`, { doc_path: 'b/new.sql', doc_source: T3 }));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT doc——被测操作期间全部写语句与手写期望序列深度全等：恰 1 条 UPDATE（无事务语句），参数逐个相等（reg_hash 现算自旧源码的 norm_v1 哈希）',
        pd.out.status === 200 && isDeepStrictEqual(pd.seq, expSeq([[SQL_PUT_DOC, ['b/new.sql', sha(T3), 'norm_v1', 1, sha(N1), 1, 1, 1, 1, 1, 'a', oDoc]]])), JSON.stringify([pd.out.status, pd.seq]));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT doc——夹具库全部用户表前后快照（按主键配对、行数与触发器集合同样比对）的差异恰等于手写期望：只有目标行的文档路径、doc_hash、算法、上报时间、reg_hash、五个核验字段与 updated_at / updated_by 变化，其余行逐字不变',
        diffEquals(pd.diff, [{ table: 'model_impl_objects', rid: oDoc, op: 'update', cols: { doc_path: ['a.sql', 'b/new.sql'], doc_hash: [sha('d'), sha(T3)], hash_algo: ['raw_v0', 'norm_v1'], doc_reported_at: [null, TSV], reg_hash: [sha(rawSrc), sha(N1)], ...CLEARED(), updated_at: ['2000-01-01 00:00:00', TSV], updated_by: ['fx', 'a'] } }]), diffText(pd.diff));
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT doc——哨兵行全列不变（补充断言）', (await rowJson(oSentB)) === sentBBefore);
      const docRowAfter = pd.after.tables.model_impl_objects.rows.find((r) => r.id === oDoc);
      check('U3 迁移只用一条 UPDATE：旧算法行 PUT doc——同一条语句写入的 doc_reported_at 与 updated_at 相等（同一语句内 now 恒定）', docRowAfter.doc_reported_at === docRowAfter.updated_at && Number.isFinite(strictCivilMs(docRowAfter.updated_at)), JSON.stringify([docRowAfter.doc_reported_at, docRowAfter.updated_at]));
      check('G1b 观测身份：U3 里被测模块的每次数据库调用都经测试传入的那个 Proxy，夹具库之外的连接上没有写语句', u3rec.badIdentity.length === 0 && foreignWrites.length === 0, JSON.stringify([u3rec.badIdentity, foreignWrites]));
      check('G1c 触发器集合：U3 三个操作前后 sqlite_master 中 type = trigger 的集合都与手写期望（空）全等', [rc, ps, pd].every((x) => isDeepStrictEqual(x.before.triggers, EXPECT_TRIGGERS) && isDeepStrictEqual(x.after.triggers, EXPECT_TRIGGERS)));
      u3rec.reset(); await e3b.mod.recomputeNormHashes(); await e3b.mod.idleVerifies(); await turns(2); u3rec.close();   // 把哨兵留下的旧算法行迁掉，不影响后面「启动重算」用例的扫描 / 更新计数
    }

    // ── 徽章：成功 → 失败 → 成功（真实落库 + 服务端 GET 带 badges）──
    {
      const oS = await mkObj({ type: 'PROC', name: 'usp_seq', schema: 'dbo', src: DEF1_NORM, regHash: sha(DEF1_NORM), algo: 'norm_v1', docPath: 'a/b.sql', docHash: sha(DEF1_NORM) });
      const badgesNow = async () => { const x = await call('GET', `/api/model-impl-objects/${oS}`); return x; };
      stub.impl = async () => ({ exists: true, definition: DEF1 });
      await mod.verifyObject(oS);
      const realNow = Ver.civilNow();
      const b1 = Ver.computeBadges(await objRow(oS), realNow);
      check('徽章·序列第 1 步（成功）⇒ 一致 / 一致', b1.doc === 'consistent' && b1.reg === 'consistent', JSON.stringify(b1));
      stub.impl = async () => { throw new Error('login failed'); };
      await mod.verifyObject(oS);
      const b2 = Ver.computeBadges(await objRow(oS), Ver.civilNow());
      check('徽章·序列第 2 步（失败；与第 1 步可能落在同一秒，不隔秒）⇒ 核验失败 / 核验失败（不沿用旧结论），附错误', b2.doc === 'verify_failed' && b2.reg === 'verify_failed' && b2.failure && b2.failure.error === '登录失败', JSON.stringify(b2));
      stub.impl = async () => ({ exists: true, definition: DEF1 });
      await mod.verifyObject(oS);
      const r3 = await objRow(oS); const b3 = Ver.computeBadges(r3, Ver.civilNow());
      check('徽章·序列第 3 步（再成功）⇒ 一致 / 一致，且 last_error 已清空', b3.doc === 'consistent' && b3.reg === 'consistent' && r3.last_error === null, JSON.stringify([b3, r3.last_error]));
      const d0 = await badgesNow();
      check('GET /api/model-impl-objects/:id 带 badges（注入时钟 = 刚核验后 ⇒ 一致 / 一致）', d0.status === 200 && d0.json.badges && d0.json.badges.doc === 'consistent' && d0.json.badges.reg === 'consistent', JSON.stringify(d0.json && d0.json.badges));
      badgeClock = '2099-01-01 00:00:00';
      const d = await badgesNow();
      check('GET 详情的 badges 用服务端注入时钟现算：时钟拨到 2099 ⇒ 待重核 / 待重核', d.status === 200 && d.json.badges && d.json.badges.doc === 'stale' && d.json.badges.reg === 'stale', JSON.stringify(d.json && d.json.badges));
      const l = await call('GET', '/api/model-impl-objects');
      const row = (l.json || []).find((x) => x.id === oS);
      const fdl = (l.json || []).find((x) => x.obj_type === 'FDL_TASK');
      check('GET 列表每行都带 badges；FDL_TASK 行的 badges 为 { doc: null, reg: null }', l.status === 200 && row && row.badges && fdl && fdl.badges.doc === null && fdl.badges.reg === null, JSON.stringify([row && row.badges, fdl && fdl.badges]));
    }

    // ── W1：核验串行队列 ──
    {
      const oQ = await mkObj({ type: 'PROC', name: 'usp_q', schema: 'dbo' });
      let release; const gate = new Promise((res) => { release = res; });
      let n = 0; stub.calls.length = 0;
      stub.impl = async () => { const my = ++n; if (my === 1) await gate; return { exists: true, definition: `CREATE PROCEDURE dbo.usp_q AS SELECT ${my}` }; };
      const first = mod.verifyObject(oQ);                                      // 在途：卡在闸门上，读到的是「旧状态」（1）
      await H.waitFor(async () => stub.calls.length === 1, 5000, 10);
      const rest = [1, 2, 3, 4].map(() => mod.verifyObject(oQ));              // 再并发触发 4 次
      check('W1 同一对象并发触发 5 次：在途的 1 次之外，其余 4 次合并成 1 个等待项（共享同一个 promise）', rest.every((p) => p === rest[0]) && rest[0] !== first, `distinct=${new Set(rest).size}`);
      release();
      await Promise.all([first, ...rest]);
      const rq = await objRow(oQ);
      check('W1 同一对象并发触发 5 次：读取器桩共 2 次（1 在途 + 1 合并），最终 prod_hash 是最后一次读到的定义（旧的慢读取没有覆盖新的）', stub.calls.length === 2 && rq.prod_hash === sha('CREATE PROCEDURE dbo.usp_q AS SELECT 2') && rq.last_error === null, JSON.stringify([stub.calls.length, rq.prod_hash, rq.last_error]));
      // 不同对象串行：并发度恒为 1
      const oQ2 = await mkObj({ type: 'VIEW', name: 'v_q2', schema: 'dbo' }); const oQ3 = await mkObj({ type: 'VIEW', name: 'v_q3', schema: 'dbo' });
      let active = 0, maxActive = 0;
      stub.impl = async () => { active++; maxActive = Math.max(maxActive, active); await turn(); active--; return { exists: true, definition: 'CREATE VIEW v AS SELECT 1' }; };
      await Promise.all([mod.verifyObject(oQ2), mod.verifyObject(oQ3), mod.verifyObject(oQ)]);
      check('W1 不同对象的核验经同一条队列串行执行（读取器并发度恒为 1）', maxActive === 1, String(maxActive));
    }
    // ── GO 检查（两个端点）、即时核验触发、手动端点 ──
    {
      const oG = await mkObj({ type: 'PROC', name: 'usp_go', schema: 'dbo' });
      const msg = '只提交对象所在批次；注释或字符串里也不能有单独一行的 GO';
      stub.impl = async () => ({ exists: true, definition: DEF1 });
      stub.calls.length = 0;
      const blockedCases = [['GO', 'SELECT 1\nGO\nSELECT 2'], ['go（前后空格）', 'SELECT 1\n go \nSELECT 2'], ['Go', 'Go\nSELECT 1'], ['go（TAB 包围）', 'SELECT 1\n\tgo\t'], ['GO（CRLF）', 'SELECT 1\r\nGO\r\nSELECT 2'], ['gO（CR 单独换行）', 'SELECT 1\rgO\rSELECT 2'], ['GO 5（带计数）', 'SELECT 1\nGO 5\nSELECT 2'], ['GO -- end（带注释）', 'SELECT 1\nGO -- end\nSELECT 2'], ['GO/* c */（紧跟块注释）', 'SELECT 1\nGO/* c */\nSELECT 2'], ['GO;（带分号）', 'SELECT 1\nGO;\nSELECT 2'], ['GO（后跟 NBSP）', 'SELECT 1\nGO' + String.fromCharCode(0xA0) + '\nSELECT 2']];
      for (const [label, text] of blockedCases) {
        const a = await call('PUT', `/api/model-impl-objects/${oG}/source`, { reg_source: text });
        check(`GO 检查：独占一行的 ${label} ⇒ 400（源码端点），消息为方案原句`, a.status === 400 && a.json && a.json.code === 'GO_SEPARATOR_FOUND' && a.json.error === msg, JSON.stringify(a));
        const b = await call('PUT', `/api/model-impl-objects/${oG}/doc`, { doc_path: 'x/y.sql', doc_source: text });
        check(`GO 检查：独占一行的 ${label} ⇒ 400（文档端点），消息为方案原句`, b.status === 400 && b.json && b.json.code === 'GO_SEPARATOR_FOUND' && b.json.error === msg, JSON.stringify(b));
      }
      const g0 = await objRow(oG);
      check('GO 检查 400 后零写入：源码 / 哈希 / 文档列未变，没有触发核验', g0.reg_source === null && g0.reg_hash === null && g0.doc_hash === null && stub.calls.length === 0);
      for (const [label, text] of [['GOTO 行', 'SELECT 1\nGOTO done\ndone:'], ['注释行 --GO', 'SELECT 1\n--GO\nSELECT 2'], ['行中 GO', 'SELECT 1 GO\nSELECT 2'], ['GO 作为标识符前缀', 'SELECT 1\nGOLD_TABLE\n'], ['GO_x', 'SELECT 1\nGO_x\n'], ['GOx', 'SELECT 1\nGOx\n'], ['/* GO */ 同行块注释', 'SELECT 1\n/* GO */\n']]) {
        const a = await call('PUT', `/api/model-impl-objects/${oG}/source`, { reg_source: text });
        const b = await call('PUT', `/api/model-impl-objects/${oG}/doc`, { doc_path: 'x/y.sql', doc_source: text });
        check(`GO 检查：${label} 不拦（源码 / 文档端点均 200）`, a.status === 200 && b.status === 200, JSON.stringify([a, b]));
      }
      check('GO 检查：findGoSeparatorLine 返回命中的行号（1 起）；无命中为 0', findGoSeparatorLine('a\nb\nGO') === 3 && findGoSeparatorLine('a\nGOTO') === 0);
      await mod.idleVerifies();
    }
    {
      // PUT source / PUT doc 成功后各触发一次核验，不阻塞响应；手动端点
      const oT = await mkObj({ type: 'PROC', name: 'usp_trig', schema: 'dbo' });
      let release; const gate = new Promise((r) => { release = r; });
      stub.calls.length = 0;
      stub.impl = async () => { await gate; return { exists: true, definition: 'CREATE PROCEDURE dbo.usp_trig AS SELECT 1' }; };
      const a = await call('PUT', `/api/model-impl-objects/${oT}/source`, { reg_source: 'CREATE PROCEDURE dbo.usp_trig AS SELECT 1' });
      await H.waitFor(async () => stub.calls.length >= 1, 5000, 20);   // 触发在响应之后，读取器调用要再过一次库查询：有界等待到达信号，不靠固定延时
      const mid = await objRow(oT);
      check('即时核验·PUT source 不阻塞响应：读取器还卡在闸门上时响应已 200，核验尚未落库', a.status === 200 && stub.calls.length === 1 && mid.last_attempt_at === null, JSON.stringify([a.status, stub.calls.length, mid.last_attempt_at]));
      release(); await mod.idleVerifies();
      const after = await objRow(oT);
      check('即时核验·PUT source 后落库：prod_hash = 登记哈希（登记与生产一致）', after.prod_hash === after.reg_hash && after.last_error === null && !!after.verified_at, JSON.stringify(after));
      stub.calls.length = 0; stub.impl = async () => ({ exists: false, definition: null });
      const b = await call('PUT', `/api/model-impl-objects/${oT}/doc`, { doc_path: 'a/b.sql', doc_source: 'CREATE PROCEDURE dbo.usp_trig AS SELECT 1' });
      await mod.idleVerifies();
      const afterDoc = await objRow(oT);
      check('即时核验·PUT doc 成功后也触发恰好一次（桩返回缺失 ⇒ prod_missing = 1）', b.status === 200 && stub.calls.length === 1 && afterDoc.prod_missing === 1, JSON.stringify([b.status, stub.calls.length, afterDoc.prod_missing]));
      stub.calls.length = 0;
      const bad = await call('PUT', `/api/model-impl-objects/${oT}/doc`, { doc_path: '../x.sql', doc_source: 'a' });
      await mod.idleVerifies();
      check('即时核验·请求被 400 拒绝时不触发核验', bad.status === 400 && stub.calls.length === 0);
      // 失败只落 last_error，不影响响应
      stub.impl = async () => { throw new Error('boom'); };
      const c = await call('PUT', `/api/model-impl-objects/${oT}/source`, { reg_source: 'CREATE PROCEDURE dbo.usp_trig AS SELECT 2' });
      await mod.idleVerifies();
      check('即时核验·读取失败只落 last_error，PUT 响应仍是 200', c.status === 200 && (await objRow(oT)).last_error === '未知错误');
      // 手动端点
      stub.impl = async () => ({ exists: true, definition: 'CREATE PROCEDURE dbo.usp_trig AS SELECT 2' });
      const m = await call('POST', `/api/model-impl-objects/${oT}/verify`);
      check('POST /model-impl-objects/:id/verify：200，outcome = ok，返回最新 badges', m.status === 200 && m.json.outcome === 'ok' && m.json.badges && typeof m.json.badges.reg === 'string', JSON.stringify(m));
      const oFx = await mkObj({ type: 'TABLE', name: 'tbl1' });
      const m2 = await call('POST', `/api/model-impl-objects/${oFx}/verify`);
      const m3 = await call('POST', '/api/model-impl-objects/987654/verify');
      const m4 = await call('POST', '/api/model-impl-objects/abc/verify');
      check('POST verify：TABLE ⇒ 400；不存在 ⇒ 404；id 非法 ⇒ 400', m2.status === 400 && m3.status === 404 && m4.status === 400, JSON.stringify([m2.status, m3.status, m4.status]));
      const off = await build({}, {});
      const m5 = await off.call('POST', `/api/model-impl-objects/${oT}/verify`);
      check('POST verify：未注入读取器（核验关闭）⇒ 503 VERIFY_DISABLED', m5.status === 503 && m5.json.code === 'VERIFY_DISABLED', JSON.stringify(m5));
      await off.close();
    }

    // ── 记账：norm_v1 下的源码变化 / 启动重算 ──
    {
      const mA = await mkModel({ name: 'ma' }), mB = await mkModel({ name: 'mb' }), mGone = await mkModel({ name: 'mg', deleted: true });
      const oR = await mkObj({ type: 'PROC', name: 'usp_rev', schema: 'dbo' });
      for (const m of [mA, mB, mGone]) await link(m, oR);
      stub.impl = async () => ({ exists: true, definition: 'x' });
      const V1 = 'CREATE PROCEDURE dbo.usp_rev\nAS\nSELECT 1;';
      const put = (text) => call('PUT', `/api/model-impl-objects/${oR}/source`, { reg_source: text });
      const revs = async () => [await revOf(mA), await revOf(mB), await revOf(mGone)];
      const logsBeforeFirst = await logCount();   // L3：PUT 之前先取计数，再与 PUT 之后比较
      let r = await put(V1);
      check('记账·首次登记：不递增、不写变更日志', r.status === 200 && r.json.changed === true && JSON.stringify(await revs()) === '[1,1,1]' && (await logCount()) === logsBeforeFirst, `${logsBeforeFirst} → ${await logCount()}`);
      await mod.idleVerifies();
      const l0 = await db.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object' AND model_name IN ('ma','mb')");
      const h1 = (await objRow(oR)).reg_hash;
      r = await put('create  or  alter  procedure dbo.usp_rev  \r\nAS \r\nSELECT 1;\r\n\r\n');
      const rowAfter = await objRow(oR);
      const l1 = await db.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object' AND model_name IN ('ma','mb')");
      check('记账·norm_v1：只改空白 / 换行风格 / 对象头大小写的重登记 ⇒ changed = false，每个挂接模型 config_rev 不变，无变更日志，reg_hash 不变（源码原文仍更新为新提交）',
        r.status === 200 && r.json.changed === false && r.json.hash_algo === 'norm_v1' && JSON.stringify(await revs()) === '[1,1,1]' && l1.c === l0.c && rowAfter.reg_hash === h1 && h1 === sha(V1) && rowAfter.reg_source.includes('\r\n'), JSON.stringify([r.json, await revs(), rowAfter.reg_hash, h1]));
      await mod.idleVerifies();
      r = await put('CREATE PROCEDURE dbo.usp_rev\nAS\nSELECT 2;');
      const l2 = await db.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE change_type = 'impl_object' AND model_name IN ('ma','mb')");
      check('记账·正文改变 ⇒ 每个挂接模型 config_rev +1（已软删除的挂接模型不动），各写 1 条 impl_object 日志', r.status === 200 && r.json.changed === true && JSON.stringify(await revs()) === '[2,2,1]' && l2.c === l1.c + 2 && JSON.stringify(r.json.bumped_model_ids) === JSON.stringify([mA, mB]), JSON.stringify([r.json, await revs()]));
      await mod.idleVerifies();
      // 旧算法行（raw_v0）在重算窗口里被重登记：旧哈希从旧源码现算，同口径比较，不拿 raw_v0 的值去比
      const mC = await mkModel({ name: 'mc' });
      const rawSrc = 'CREATE PROCEDURE dbo.usp_raw\r\nAS\r\nSELECT 1;\r\n';
      const oRaw = await mkObj({ type: 'PROC', name: 'usp_raw', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0' });
      await link(mC, oRaw);
      r = await call('PUT', `/api/model-impl-objects/${oRaw}/source`, { reg_source: 'CREATE PROCEDURE dbo.usp_raw\nAS\nSELECT 1;' });
      check('记账·旧算法（raw_v0）行被重登记且只改了换行 ⇒ 不递增（旧哈希按旧源码现算，不拿 raw 值比）', r.status === 200 && r.json.changed === false && (await revOf(mC)) === 1, JSON.stringify([r.json, await revOf(mC)]));
      await mod.idleVerifies();
      // M1（末次合并审）：「旧算法」判定与启动重算同口径——hash_algo IS NOT norm_v1，含 hash_algo 为 NULL 但已有源码 / 哈希材料的行（启动重算会处理它）。
      //   PUT source / PUT doc 对这类行同样走旧算法分支（同一条 UPDATE 顺带清掉旧 doc_hash / 旧核验数据 / 按 norm_v1 现算另一半 reg_hash）。修复前（判定要求 hash_algo 非空）NULL 行被当成已迁移：旧 doc_hash 与旧核验数据原样留下。
      const OLD_VERIFY_M1 = "UPDATE model_impl_objects SET prod_hash = 'old-prod', prod_missing = 1, verified_at = '2026-10-01 10:00:00', last_attempt_at = '2026-10-02 10:00:00', last_error = '超时' WHERE id = ?";
      const nullSrc = 'CREATE PROCEDURE dbo.usp_nullalgo\r\nAS\r\nSELECT 1;\r\n';
      const mN = await mkModel({ name: 'mn' });
      const oNull = await mkObj({ type: 'PROC', name: 'usp_nullalgo', schema: 'dbo', src: nullSrc, regHash: sha(nullSrc), algo: null, docPath: 'p/n.sql', docHash: sha('doc-null') });
      await db.run(OLD_VERIFY_M1, [oNull]);
      await link(mN, oNull);
      const nullBefore = await objRow(oNull);
      r = await call('PUT', `/api/model-impl-objects/${oNull}/source`, { reg_source: 'CREATE PROCEDURE dbo.usp_nullalgo\nAS\nSELECT 2;' });
      const nullAfter = await objRow(oNull);
      check('M1 记账·hash_algo 为 NULL 且有哈希材料的行 PUT source：按旧算法行处理——hash_algo 变 norm_v1、reg_hash 换新值、旧 doc_hash 与旧核验数据（prod_hash / verified_at / last_error）在同一条 UPDATE 里清空',
        r.status === 200 && nullBefore.hash_algo === null && nullBefore.doc_hash === sha('doc-null') && nullBefore.prod_hash === 'old-prod'
        && nullAfter.hash_algo === 'norm_v1' && nullAfter.reg_hash === r.json.reg_hash && nullAfter.reg_hash !== sha(nullSrc) && nullAfter.doc_hash === null && nullAfter.prod_hash === null && nullAfter.verified_at === null && nullAfter.last_error === null && nullAfter.prod_missing === 0,
        JSON.stringify([r.json, nullBefore, nullAfter]));
      check('M1 记账·该 NULL 算法行改了源码正文 ⇒ 旧哈希按旧源码现算、与新哈希不同 ⇒ 挂接模型 config_rev +1（与 raw_v0 行同口径）', r.json.changed === true && (await revOf(mN)) === 2, JSON.stringify([r.json, await revOf(mN)]));
      await mod.idleVerifies();
      const nullSrc2 = 'CREATE PROCEDURE dbo.usp_nullalgo2\r\nAS\r\nSELECT 1;\r\n';
      const oNull2 = await mkObj({ type: 'PROC', name: 'usp_nullalgo2', schema: 'dbo', src: nullSrc2, regHash: sha(nullSrc2), algo: null, docPath: 'p/n2.sql', docHash: sha('doc-null2') });
      await db.run(OLD_VERIFY_M1, [oNull2]);
      const rDoc = await call('PUT', `/api/model-impl-objects/${oNull2}/doc`, { doc_path: 'p/n2-new.sql', doc_source: 'doc text 2' });
      const doc2 = await objRow(oNull2);
      check('M1 记账·hash_algo 为 NULL 且有哈希材料的行 PUT doc：按旧算法行处理——hash_algo 变 norm_v1、reg_hash 按 norm_v1 对旧源码现算（不再是 raw 哈希）、旧核验数据清空',
        rDoc.status === 200 && doc2.hash_algo === 'norm_v1' && doc2.reg_hash !== sha(nullSrc2) && !!doc2.reg_hash && doc2.doc_hash === rDoc.json.doc_hash && doc2.prod_hash === null && doc2.verified_at === null && doc2.last_error === null && doc2.prod_missing === 0,
        JSON.stringify([rDoc.json, doc2]));
      await mod.idleVerifies();
      // 收口批 2 LOW-3：旧算法判定与启动重算（:443）完全同口径——hash_algo IS NOT norm_v1 **且** reg_source / reg_hash / doc_hash / hash_algo 至少一项非空。
      //   「新建后还没登记源码 / 文档、只被每日核验扫过」的行：hash_algo 为 NULL、没有任何哈希材料，却带着核验数据（prod_hash / verified_at / last_error）——它不是旧算法行，
      //   首次 PUT source / PUT doc 不得把已有的核验数据清掉（清掉后若重核失败，上一次成功的核验结果就丢了）。
      const noMatSrc = await mkObj({ type: 'PROC', name: 'usp_nomat_src', schema: 'dbo', algo: null });
      await db.run(OLD_VERIFY_M1, [noMatSrc]);
      const nmBefore = await objRow(noMatSrc);
      const rNm = await call('PUT', `/api/model-impl-objects/${noMatSrc}/source`, { reg_source: 'CREATE PROCEDURE dbo.usp_nomat_src\nAS\nSELECT 1;' });
      const nmAfter = await objRow(noMatSrc);
      check('M1/LOW-3 记账·hash_algo 为 NULL 且没有任何哈希材料（reg_source / reg_hash / doc_hash 全空）、已有核验数据的行首次 PUT source：登记成功（hash_algo = norm_v1、reg_hash 为新值），但已有核验数据（prod_hash / prod_missing / verified_at / last_attempt_at / last_error）原样保留',
        rNm.status === 200 && nmBefore.hash_algo === null && nmBefore.reg_source === null && nmBefore.reg_hash === null && nmBefore.doc_hash === null && nmBefore.prod_hash === 'old-prod'
        && nmAfter.hash_algo === 'norm_v1' && nmAfter.reg_hash === rNm.json.reg_hash && !!nmAfter.reg_hash && nmAfter.prod_hash === 'old-prod' && nmAfter.prod_missing === 1 && nmAfter.verified_at === '2026-10-01 10:00:00' && nmAfter.last_attempt_at === '2026-10-02 10:00:00' && nmAfter.last_error === '超时',
        JSON.stringify([rNm.json, nmBefore, nmAfter]));
      await mod.idleVerifies();
      const noMatDoc = await mkObj({ type: 'PROC', name: 'usp_nomat_doc', schema: 'dbo', algo: null });
      await db.run(OLD_VERIFY_M1, [noMatDoc]);
      const rNmDoc = await call('PUT', `/api/model-impl-objects/${noMatDoc}/doc`, { doc_path: 'p/nomat.sql', doc_source: 'doc text nomat' });
      const nmDoc = await objRow(noMatDoc);
      check('M1/LOW-3 记账·同样的无哈希材料 NULL 算法行首次 PUT doc：上报成功（hash_algo = norm_v1、doc_hash 为新值），但已有核验数据原样保留，reg_hash 仍为空（没有源码可现算）',
        rNmDoc.status === 200 && nmDoc.hash_algo === 'norm_v1' && nmDoc.doc_hash === rNmDoc.json.doc_hash && nmDoc.reg_hash === null && nmDoc.prod_hash === 'old-prod' && nmDoc.prod_missing === 1 && nmDoc.verified_at === '2026-10-01 10:00:00' && nmDoc.last_attempt_at === '2026-10-02 10:00:00' && nmDoc.last_error === '超时',
        JSON.stringify([rNmDoc.json, nmDoc]));
      await mod.idleVerifies();
    }
    {
      // 启动重算
      const mR = await mkModel({ name: 'mr' });
      const src1 = 'create or alter proc dbo.usp_rc1\r\nAS  \r\nSELECT 1;\r\n';
      // W3：坏行（reg_source 是 BLOB，normHash 会抛）排在最前（id 最小）：它只能被跳过，其余行必须照常重算
      const badId = (await db.run(`INSERT INTO model_impl_objects (obj_type, db_connection_id, schema_name, obj_name, reg_source, reg_hash, hash_algo, is_deleted, created_at, updated_at, created_by, updated_by)
        VALUES ('PROC', 1, 'dbo', 'usp_blob_bad', x'414243', 'bad-hash', 'raw_v0', 0, '2000-01-01 00:00:00', '2000-01-01 00:00:00', 'fx', 'fx')`)).lastID;
      const o1 = await mkObj({ type: 'PROC', name: 'usp_rc1', schema: 'dbo', src: src1, regHash: sha(src1), algo: 'raw_v0', docPath: 'p/a.sql', docHash: sha('doc-raw'), docAt: '2026-09-01 10:00:00' });
      const o2 = await mkObj({ type: 'VIEW', name: 'v_rc2', schema: 'dbo', algo: 'raw_v0', docPath: 'p/b.sql', docHash: sha('doc-raw2') });      // 只有文档
      const o3 = await mkObj({ type: 'PROC', name: 'usp_rc3', schema: 'dbo', src: 'CREATE PROC x AS SELECT 1', regHash: 'sentinel-keep', algo: 'norm_v1', docHash: 'sentinel-doc' });   // 已是 norm_v1：不得动
      const o4 = await mkObj({ type: 'FDL_TASK', conn: null, schema: null, name: 'fdl_rc4' });                                                                                           // 无哈希、无算法：不动
      for (const o of [o1, o2, o3, o4]) await link(mR, o);
      const snap = async () => (await db.all('SELECT id, updated_at, created_at, reg_source, doc_path, doc_reported_at FROM model_impl_objects WHERE id IN (?,?,?,?) ORDER BY id', [o1, o2, o3, o4]));
      const s0 = await snap(); const rev0 = await revOf(mR); const log0 = await logCount();
      const rr = await mod.recomputeNormHashes().catch((err) => ({ scanned: 0, updated: 0, failed: ['THROW:' + err.message] }));   // 抛出本身也让 W3 断言变红（而不是整套件异常）
      const a1 = await objRow(o1), a2 = await objRow(o2), a3 = await objRow(o3), a4 = await objRow(o4);
      const want1 = 'CREATE PROC dbo.usp_rc1\nAS\nSELECT 1;';
      const badRow = await objRow(badId);
      check('W3 一行坏数据（reg_source 为 BLOB）：只跳过这一行（failed = [坏行]，其行原样未动），其余 raw_v0 行照常重算为 norm_v1，并记了日志', JSON.stringify(rr.failed) === JSON.stringify([badId]) && badRow.hash_algo === 'raw_v0' && badRow.reg_hash === 'bad-hash' && a1.hash_algo === 'norm_v1' && a1.reg_hash === sha(want1) && a2.hash_algo === 'norm_v1' && logs.error.some((m) => m.includes(`对象 ${badId} 失败`)), JSON.stringify([rr, badRow.hash_algo, a1.hash_algo]));
      check('启动重算：raw_v0 行的 reg_hash 按 norm_v1 重算（手写期望）、hash_algo = norm_v1；旧算法的 doc_hash 无原文可重算 ⇒ 置空', a1.reg_hash === sha(want1) && a1.hash_algo === 'norm_v1' && a1.doc_hash === null && a2.hash_algo === 'norm_v1' && a2.doc_hash === null && a2.reg_hash === null, JSON.stringify([a1, a2]));
      check('启动重算：已是 norm_v1 的行不动；无哈希无算法的行不动', a3.reg_hash === 'sentinel-keep' && a3.doc_hash === 'sentinel-doc' && a4.hash_algo === null && a4.reg_hash === null && rr.updated === 2 && rr.scanned === 3, JSON.stringify([rr, a3, a4]));
      check('启动重算：config_rev 不变（重算本身不算源码变化）', (await revOf(mR)) === rev0, `${rev0} → ${await revOf(mR)}`);
      check('启动重算：不写任何变更日志', (await logCount()) === log0, `${log0} → ${await logCount()}`);
      check('启动重算：updated_at / 源码 / doc_path / doc_reported_at 不动', JSON.stringify(await snap()) === JSON.stringify(s0));
      const rr2 = await mod.recomputeNormHashes();
      check('启动重算：幂等，第二次更新 0 行（只剩坏行被再次扫到并再次跳过）', rr2.scanned === 1 && rr2.updated === 0 && JSON.stringify(rr2.failed) === JSON.stringify([badId]) && (await revOf(mR)) === rev0, JSON.stringify(rr2));
    }

    // ── W5：last_error 只存分类文案，错误原文只进服务端日志 ──
    {
      const oE = await mkObj({ type: 'PROC', name: 'usp_err', schema: 'dbo' });
      stub.impl = async () => { throw new Error("Login failed for user 'svc_secret' on 10.9.8.7:14330"); };
      const w0 = logs.warn.length;
      const out = await mod.verifyObject(oE);
      const row = await objRow(oE);
      const det = await call('GET', `/api/model-impl-objects/${oE}`); const lst = await call('GET', '/api/model-impl-objects'); const man = await call('POST', `/api/model-impl-objects/${oE}/verify`);
      const blob = JSON.stringify([row, det.json, lst.json, man.json, out]);
      check('W5 落库只存分类文案：桩抛出含 IP / 端口 / 登录名的错误 ⇒ last_error = 「登录失败」，库行与 GET 详情 / 列表 / 手动核验响应里都不含 10.9.8.7、14330、svc_secret', row.last_error === '登录失败' && !/10\.9\.8\.7|14330|svc_secret/.test(blob), blob.slice(0, 300));
      check('W5 错误原文只进服务端日志（warn 里有主机 / 端口 / 登录名，便于排查）', logs.warn.slice(w0).some((m) => /10\.9\.8\.7/.test(m) && /svc_secret/.test(m)));
      const kinds = (await db.all('SELECT DISTINCT last_error FROM model_impl_objects WHERE last_error IS NOT NULL')).map((x) => x.last_error);
      check('W5 库里所有 last_error 取值都在枚举内（连接失败 / 登录失败 / 超时 / 查询出错 / 类型不符 / 无权读取定义 / 未知错误）', kinds.length > 0 && kinds.every((k) => Ver.ERROR_KINDS.includes(k)), JSON.stringify(kinds));
    }
    // ── L1：旧算法（raw_v0）行在重算之前被 PUT：同一条 UPDATE 顺带处理另一半哈希 ──
    {
      stub.impl = async () => ({ exists: true, definition: 'x' });
      const rawSrc = 'create or alter proc x\r\nAS\r\nSELECT 1;';
      const oA = await mkObj({ type: 'PROC', name: 'usp_l1a', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0', docPath: 'a.sql', docHash: sha('d0') });
      const a = await call('PUT', `/api/model-impl-objects/${oA}/doc`, { doc_path: 'b.sql', doc_source: 'CREATE PROC x\nAS\nSELECT 1;' });
      const ra = await objRow(oA);
      check('L1 旧算法行 PUT doc：同一条 UPDATE 里按 norm_v1 现算 reg_hash（取旧源码），doc_hash 为新文档的 norm 哈希，hash_algo = norm_v1', a.status === 200 && ra.hash_algo === 'norm_v1' && ra.reg_hash === sha('CREATE PROC x\nAS\nSELECT 1;') && ra.doc_hash === sha('CREATE PROC x\nAS\nSELECT 1;'), JSON.stringify(ra));
      const oB = await mkObj({ type: 'PROC', name: 'usp_l1b', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0', docPath: 'a.sql', docHash: sha('d1') });
      const b = await call('PUT', `/api/model-impl-objects/${oB}/source`, { reg_source: 'CREATE PROC y\nAS\nSELECT 1;' });
      const rb = await objRow(oB);
      check('L1 旧算法行 PUT source：同一条 UPDATE 里把旧算法的 doc_hash 置空（无原文无从重算），reg_hash 为新源码的 norm 哈希，hash_algo = norm_v1', b.status === 200 && rb.hash_algo === 'norm_v1' && rb.doc_hash === null && rb.doc_path === 'a.sql' && rb.reg_hash === sha('CREATE PROC y\nAS\nSELECT 1;'), JSON.stringify(rb));
      const oC = await mkObj({ type: 'PROC', name: 'usp_l1c', schema: 'dbo', src: 'CREATE PROC z AS SELECT 1', regHash: sha('CREATE PROC z AS SELECT 1'), algo: 'norm_v1', docPath: 'a.sql', docHash: sha('keep-doc') });
      await call('PUT', `/api/model-impl-objects/${oC}/source`, { reg_source: 'CREATE PROC z AS SELECT 2' });
      check('L1 对照：norm_v1 行 PUT source 不动 doc_hash', (await objRow(oC)).doc_hash === sha('keep-doc'));
      await mod.idleVerifies();
    }
    // ── L9：核验显式开关 ──
    {
      const calls0 = [];
      const eo = await build({ readDefinition: async (o) => { calls0.push(o.id); return { exists: true, definition: 'x' }; }, verifyEnabled: undefined });
      const oO = await mkObj({ type: 'PROC', name: 'usp_off', schema: 'dbo' });
      const m = await eo.call('POST', `/api/model-impl-objects/${oO}/verify`);
      const p = await eo.call('PUT', `/api/model-impl-objects/${oO}/source`, { reg_source: 'CREATE PROC o AS SELECT 1' });
      await eo.mod.idleVerifies();
      check('L9 核验开关：注入了读取器但 verifyEnabled 不是 true ⇒ 核验关闭：手动端点 503 VERIFY_DISABLED，PUT source 成功但不触发核验，不排每日任务', m.status === 503 && m.json.code === 'VERIFY_DISABLED' && p.status === 200 && calls0.length === 0 && eo.mod.startDailyVerify() === false, JSON.stringify([m.status, p.status, calls0]));
      const eo2 = await build({ readDefinition: async () => ({ exists: true, definition: 'x' }), verifyEnabled: 1 });
      const m2 = await eo2.call('POST', `/api/model-impl-objects/${oO}/verify`);
      check('L9 核验开关：只有严格等于 true 才启用（verifyEnabled: 1 仍关闭）', m2.status === 503, String(m2.status));
    }
    // ── V3：队列已停止接收时，手动核验端点返回 503 VERIFY_STOPPED（不再返回「核验完成」）──
    {
      const eV3 = await build({ readDefinition: async () => ({ exists: true, definition: 'CREATE PROC v AS SELECT 1' }) });
      const oV3 = await mkObj({ type: 'PROC', name: 'usp_v3', schema: 'dbo' });
      await eV3.mod.stopDailyVerify();
      const mv = await eV3.call('POST', `/api/model-impl-objects/${oV3}/verify`);
      check('V3 手动核验：服务停止后返回 503，code = VERIFY_STOPPED，文案「服务正在停止，本次核验未执行」（不是 200「核验完成」）', mv.status === 503 && mv.json && mv.json.code === 'VERIFY_STOPPED' && mv.json.error === '服务正在停止，本次核验未执行', JSON.stringify(mv));
    }
    // ── W1：停服——队列停止接收新任务并等在途任务完成 ──
    {
      let release2; const gate2 = new Promise((res) => { release2 = res; });
      const readsS = [];
      const es = await build({ readDefinition: async (o) => { readsS.push(o.id); await gate2; return { exists: true, definition: 'CREATE PROC s AS SELECT 1' }; } });
      const oS2 = await mkObj({ type: 'PROC', name: 'usp_stop', schema: 'dbo' });
      const inflight = es.mod.verifyObject(oS2);
      await H.waitFor(async () => readsS.length === 1, 5000, 10);
      let done = false; const sp = es.mod.stopDailyVerify().then(() => { done = true; });
      const lateP = es.mod.verifyObject(oS2);   // stop 同步置位「停止接收」：新请求拿到的是已完成的 stopped；与一轮事件循环赛跑，缺陷时（挂起）会输给它
      const late = await Promise.race([lateP, turn().then(() => ({ outcome: 'HUNG' }))]);
      await turns(3);
      check('W1 停服：在途任务未完成时 stopDailyVerify 不返回（等在途任务，最多 3 秒）；停止后新请求不再接收（outcome = stopped），读取器没有被再次调用', done === false && late.outcome === 'stopped' && readsS.length === 1, JSON.stringify([done, late, readsS]));
      release2(); await sp; const fin = await inflight; await lateP;
      check('W1 停服：在途任务完成后 stopDailyVerify 返回，在途任务照常落库', done === true && fin.outcome === 'ok' && (await objRow(oS2)).prod_hash !== null);
    }

    // ── L-a：停服超时返回后，在途项才失败 ⇒ 不写库，旧结论保持不变 ──
    {
      let release3; const gate3 = new Promise((res) => { release3 = res; });
      const reads3 = [];
      const e3 = await build({ readDefinition: async (o) => { reads3.push(o.id); await gate3; throw new Error('connect ECONNREFUSED 10.0.0.9:1433'); }, verifyStopWaitMs: 20 });
      const o3 = await mkObj({ type: 'PROC', name: 'usp_stop_fail', schema: 'dbo' });
      await db.run("UPDATE model_impl_objects SET last_error = '登录失败', last_attempt_at = '2001-02-03 04:05:06' WHERE id = ?", [o3]);
      const inflight3 = e3.mod.verifyObject(o3);
      await H.waitFor(async () => reads3.length === 1, 5000, 10);
      await e3.mod.stopDailyVerify();                 // 在途项卡在闸门上：等待上限（注入 20 毫秒）到了就返回，此时闸门还没放开
      release3();                                     // 超时返回之后，在途项才失败
      const fin3 = await inflight3;
      const row3 = await objRow(o3);
      check('L-a 停服后在途项失败：stopDailyVerify 在等待上限到了（闸门未放开）时返回后，在途项失败只返回 { outcome: stopped }，库里 last_error / last_attempt_at 保持原值不变', fin3.outcome === 'stopped' && row3.last_error === '登录失败' && row3.last_attempt_at === '2001-02-03 04:05:06', JSON.stringify([fin3, row3.last_error, row3.last_attempt_at]));
    }
    // ── R2：停服超时返回后，在途项读取成功 ⇒ 不写库（成功路径同样受「写前检查」约束）──
    {
      let release4; const gate4 = new Promise((res) => { release4 = res; });
      const reads4 = [];
      const e4 = await build({ readDefinition: async (o) => { reads4.push(o.id); await gate4; return { exists: true, definition: 'CREATE PROC s AS SELECT 1' }; }, verifyStopWaitMs: 20 });
      const o4 = await mkObj({ type: 'PROC', name: 'usp_stop_ok', schema: 'dbo' });
      await db.run("UPDATE model_impl_objects SET prod_hash = 'old-hash', verified_at = '2001-02-03 04:05:06', last_attempt_at = '2001-02-03 04:05:06' WHERE id = ?", [o4]);
      const inflight4 = e4.mod.verifyObject(o4);
      await H.waitFor(async () => reads4.length === 1, 5000, 10);
      await e4.mod.stopDailyVerify();                 // 在途项卡在闸门上：等待上限到了就返回
      release4();                                     // 返回之后在途项才读成功
      const fin4 = await inflight4;
      const row4 = await objRow(o4);
      check('R2 停服后在途项读取成功：不写库，库里旧的 prod_hash / verified_at / last_attempt_at 保持原值，outcome = stopped', fin4.outcome === 'stopped' && row4.prod_hash === 'old-hash' && row4.verified_at === '2001-02-03 04:05:06' && row4.last_attempt_at === '2001-02-03 04:05:06', JSON.stringify([fin4, row4]));
    }
    // ── R4：手动核验端点最多等 20 秒，超时返回 202 { queued: true }（计时器注入，不真等）──
    {
      let releaseSlow; const slowGate = new Promise((res) => { releaseSlow = res; });
      let slow = true; const readsM = [];
      const timersM = [];
      const eM = await build({
        readDefinition: async (o) => { readsM.push(o.id); if (slow) await slowGate; return { exists: true, definition: 'CREATE PROC m AS SELECT 1' }; },
        manualVerifyTimers: { setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timersM.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; } },
      });
      const oM = await mkObj({ type: 'PROC', name: 'usp_manual', schema: 'dbo' });
      const pending = eM.call('POST', `/api/model-impl-objects/${oM}/verify`);       // 队列长：读取卡在闸门上
      await H.waitFor(async () => timersM.length === 1 && readsM.length === 1, 5000, 10);
      check('R4 手动核验：等待上限常量为 20000 毫秒', timersM[0].ms === 20000, String(timersM[0] && timersM[0].ms));
      timersM[0].fn();                                // 触发「20 秒到了」
      // 缺陷（不设上限）时请求会一直挂着：仅在失败路径上用一个有界的兜底计时器防止整套件挂死（通过时被立即清除）
      let guardT; const r202 = await Promise.race([pending, new Promise((res) => { guardT = setTimeout(() => res({ status: 'HUNG' }), 4000); })]); clearTimeout(guardT);
      check('R4 手动核验：队列很长（读取卡住）时超时返回 202 { queued: true }（文案含「停服期间已排队的核验可能被取消，以对象详情里的最终核验时间为准」），核验继续在队列里执行', r202.status === 202 && r202.json && r202.json.queued === true && /停服期间已排队的核验可能被取消/.test(r202.json.message), JSON.stringify(r202));
      slow = false; releaseSlow(); await eM.mod.idleVerifies();
      check('R4 手动核验：202 之后核验仍在队列里执行完毕并落库（prod_hash 已写）', (await objRow(oM)).prod_hash !== null);
      const r200 = await eM.call('POST', `/api/model-impl-objects/${oM}/verify`);
      check('R4 手动核验：队列短（读取立即完成）⇒ 200，计时器已清除（不会晚触发）', r200.status === 200 && r200.json.outcome === 'ok' && timersM[timersM.length - 1].cancelled === true, JSON.stringify([r200.status, timersM.map((t) => t.cancelled)]));
    }
    // ── R3：算法迁移同一条 UPDATE 清空旧核验数据（重算 / 旧算法行被 PUT 顺带处理）──
    {
      const verifData = (id) => db.run("UPDATE model_impl_objects SET prod_hash = 'old-prod', prod_missing = 1, verified_at = '2026-10-01 10:00:00', last_attempt_at = '2026-10-02 10:00:00', last_error = '超时' WHERE id = ?", [id]);
      const cleared = (r) => r.prod_hash === null && r.prod_missing === 0 && r.verified_at === null && r.last_attempt_at === null && r.last_error === null;
      const rawSrc = 'create or alter proc x\r\nAS\r\nSELECT 1;';
      const eR3 = await build({}, {});           // 不启用核验：PUT 后不会异步重写核验列，便于断言
      const oRc = await mkObj({ type: 'PROC', name: 'usp_r3_rc', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0' }); await verifData(oRc);
      const rrr = await eR3.mod.recomputeNormHashes();
      const rowRc = await objRow(oRc);
      check('R3 算法迁移：重算 raw_v0 行时同一条 UPDATE 清空 prod_hash / prod_missing / verified_at / last_attempt_at / last_error，徽章回到 unverified', rowRc.hash_algo === 'norm_v1' && cleared(rowRc) && Ver.computeBadges(rowRc, '2026-10-03 12:00:00').doc === 'unverified', JSON.stringify([rrr.updated, rowRc]));
      const oPs = await mkObj({ type: 'PROC', name: 'usp_r3_ps', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0', docPath: 'a.sql', docHash: sha('d') }); await verifData(oPs);
      const ps = await eR3.call('PUT', `/api/model-impl-objects/${oPs}/source`, { reg_source: 'CREATE PROC x\nAS\nSELECT 2;' });
      const rowPs = await objRow(oPs);
      check('R3 算法迁移：旧算法行 PUT source 时同一条 UPDATE 清空核验列（徽章回到 unverified）', ps.status === 200 && cleared(rowPs) && Ver.computeBadges(rowPs, '2026-10-03 12:00:00').reg === 'unverified', JSON.stringify(rowPs));
      const oPd = await mkObj({ type: 'PROC', name: 'usp_r3_pd', schema: 'dbo', src: rawSrc, regHash: sha(rawSrc), algo: 'raw_v0' }); await verifData(oPd);
      const pd = await eR3.call('PUT', `/api/model-impl-objects/${oPd}/doc`, { doc_path: 'a.sql', doc_source: 'CREATE PROC x\nAS\nSELECT 1;' });
      const rowPd = await objRow(oPd);
      check('R3 算法迁移：旧算法行 PUT doc 时同一条 UPDATE 清空核验列（徽章回到 unverified）', pd.status === 200 && cleared(rowPd) && Ver.computeBadges(rowPd, '2026-10-03 12:00:00').doc === 'unverified', JSON.stringify(rowPd));
      const oOk = await mkObj({ type: 'PROC', name: 'usp_r3_ok', schema: 'dbo', src: 'CREATE PROC z AS SELECT 1', regHash: sha('CREATE PROC z AS SELECT 1'), algo: 'norm_v1' }); await verifData(oOk);
      await eR3.call('PUT', `/api/model-impl-objects/${oOk}/source`, { reg_source: 'CREATE PROC z AS SELECT 2' });
      const rowOk = await objRow(oOk);
      check('R3 对照：norm_v1 行 PUT source 不清核验列', rowOk.prod_hash === 'old-prod' && rowOk.prod_missing === 1 && rowOk.last_error === '超时');
    }

    // ── L-e：server.js 挂载 impl-objects 时明确传了 verifyEnabled: true（仿 verify-sys-expiry-sweep-lifecycle「生产模块明确启用后台扫描」）──
    {
      const acorn = require('acorn');
      const ast = acorn.parse(srvText, { ecmaVersion: 'latest' });
      const decl = ast.body.filter((n) => n.type === 'VariableDeclaration').flatMap((n) => n.declarations).find((d) => d.id && d.id.name === 'implObjectsModule');
      const arg0 = decl && decl.init && decl.init.type === 'CallExpression' ? decl.init.arguments[0] : null;
      const hasProp = !!(arg0 && arg0.type === 'ObjectExpression' && arg0.properties.some((p) => p.key && p.key.name === 'verifyEnabled' && p.value && p.value.value === true));
      check('L-e server.js 挂载 impl-objects 时传了 verifyEnabled: true（静态解析实参对象字面量，不是注释里的字样）', hasProp);
    }

    // ── 每日任务经工厂（07:30、候选范围、stop）──
    {
      const timers = []; let clock = '2026-10-03 07:00:00';
      const e2 = await build({
        readDefinition: async (o) => { stub.calls.push({ id: o.id, t: o.obj_type }); return { exists: true, definition: 'x' }; },
        dailyVerifyClock: async () => clock,
        dailyVerifyTimers: { setTimer: (fn, d) => { const t = { fn, d, cancelled: false }; timers.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; } },
      }, { withRouter: false });
      await db.run("DELETE FROM model_impl_objects WHERE obj_name LIKE 'sweep_%'");
      const keep = [await mkObj({ type: 'PROC', name: 'sweep_p' }), await mkObj({ type: 'VIEW', name: 'sweep_v' }), await mkObj({ type: 'TRIGGER', name: 'sweep_t', schema: null })];
      await mkObj({ type: 'TABLE', name: 'sweep_tbl' }); await mkObj({ type: 'FDL_TASK', conn: null, schema: null, name: 'sweep_f' }); await mkObj({ type: 'PROC', name: 'sweep_del', deleted: true });
      const fire = async () => { const t = timers.filter((x) => !x.cancelled && !x.fired).shift(); if (t) { t.fired = true; await t.fn(); await turn(); } };
      stub.calls.length = 0;
      await e2.mod.startBackground();   // W3：库里有一行坏数据（BLOB）的情况下，启动序列照常排定每日任务
      check('W3 启动序列：重算遇到坏行（已跳过）时每日任务照常排定（started = true，已排定 1 个定时器）', e2.mod._internals.dailySweep && e2.mod._internals.dailySweep.status().started === true && timers.filter((t) => !t.cancelled && !t.fired).length === 1, JSON.stringify(e2.mod._internals.dailySweep && e2.mod._internals.dailySweep.status()));
      await fire();
      const due0 = e2.mod._internals.dailySweep.status().due;
      check('调度·下一次触发时刻按 07:30 计算（经实现对象模块的每日任务）：07:00 启动 ⇒ due = 当日 07:30:00', due0 === '2026-10-03 07:30:00', String(due0));
      clock = '2026-10-03 07:30:00'; await fire();
      const live = (await db.all("SELECT id FROM model_impl_objects WHERE is_deleted = 0 AND obj_type IN ('PROC','VIEW','TRIGGER') ORDER BY id")).map((x) => x.id);
      check('调度·每日核验候选 = 全部未删除的 PROC / VIEW / TRIGGER（不含 TABLE / FDL_TASK / 已删除），按 id 升序串行', JSON.stringify(stub.calls.map((c) => c.id)) === JSON.stringify(live) && keep.every((k) => live.includes(k)) && stub.calls.every((c) => ['PROC', 'VIEW', 'TRIGGER'].includes(c.t)), JSON.stringify([stub.calls, live]));
      const n0 = stub.calls.length;
      await e2.mod.stopDailyVerify();
      clock = '2026-10-04 07:31:00';
      for (const t of timers.slice()) if (!t.fired) { t.fired = true; await t.fn(); }
      await turns(3);
      {
        // G4 接线：只停核验队列（不停每日任务）后，每日任务收到 stopped 即进入终态，不再排定时器——结果不依赖 stopService 里两个 stop 的先后
        const timersG = []; let clockG = '2026-10-03 07:00:00';
        const eG = await build({
          readDefinition: async () => ({ exists: true, definition: 'x' }), dailyVerifyClock: async () => clockG,
          dailyVerifyTimers: { setTimer: (fn, d) => { const t = { fn, d, cancelled: false }; timersG.push(t); return t; }, clearTimer: (t) => { t.cancelled = true; } },
        }, { withRouter: false });
        const fireG = async () => { const t = timersG.filter((x) => !x.cancelled && !x.fired).shift(); if (t) { t.fired = true; await t.fn(); await turn(); } };
        eG.mod.startDailyVerify();
        await fireG();                                           // 07:00：排定 due = 07:30
        clockG = '2026-10-03 07:30:00';
        await eG.mod._internals.verifier.stop();                 // 只停核验队列，不停每日任务
        await fireG();                                           // 到点：第一个对象收到 stopped
        const stG = eG.mod._internals.dailySweep.status(); const nG = timersG.length;
        await turns(3);
        check('G4 每日任务终态：实现对象模块接线——只停核验队列（每日任务未 stop）后到点，本轮 stopped 且 terminal，status.terminated = true，没有待触发的定时器，之后也不再创建', stG.lastResult.stopped === true && stG.lastResult.terminal === true && stG.terminated === true && timersG.filter((x) => !x.cancelled && !x.fired).length === 0 && timersG.length === nG, JSON.stringify([stG, timersG.length, nG]));
        await eG.mod.stopDailyVerify();
      }
      check('调度·stopService 后不再触发（经实现对象模块 stopDailyVerify）：强制执行迟到的定时器回调也不再核验任何对象', stub.calls.length === n0, `${n0} → ${stub.calls.length}`);
      const srvStop = /async function stopService\(\) \{[\s\S]*?implObjectsModule\.stopDailyVerify\(\)[\s\S]*?process\.exit\(0\);/.test(srvText);
      check('调度·server.js 的 stopService 里调用了 implObjectsModule.stopDailyVerify()；启动序列调用 startBackground()；挂载传入 getMssqlPool / decryptPassword',
        srvStop && /implObjectsModule\.startBackground\(\)/.test(srvText) && /require\('\.\/routes\/model-center\/impl-objects'\)\(\{[\s\S]*?getMssqlPool, decryptPassword/.test(srvText));
    }
    // K2 默认定时器路径（专门用例）：不注入可控定时器，走 setTimeout 默认值；用例结束时被测模块没有遗留任何定时器
    {
      const eD = await build({ readDefinition: async () => ({ exists: true, definition: 'CREATE PROC d AS SELECT 1' }), manualVerifyTimers: undefined, dailyVerifyTimers: undefined });
      const oD = await mkObj({ type: 'PROC', name: 'usp_k2_default', schema: 'dbo' });
      const mD = await eD.call('POST', `/api/model-impl-objects/${oD}/verify`);
      const afterManual = pendingTimers.size;
      eD.mod.startDailyVerify();
      const duringSweep = pendingTimers.size;
      await eD.mod.stopDailyVerify();
      await turns(3);
      check('K2 默认定时器路径（专门用例）：手动核验端点用默认 setTimeout 的 20 秒上限，核验结束即清理；每日任务用默认 setTimeout 排定（登记 ≥ 1 个）后 stop 即清理；用例结束时被测模块没有遗留定时器', mD.status === 200 && afterManual === 0 && duringSweep >= 1 && pendingTimers.size === 0, JSON.stringify([mD.status, afterManual, duringSweep, pendingTimers.size]));
    }
    // M1 / K2 运行时：套件结束前排空——各模块 idle、让出若干轮事件循环；然后断言 ① 所有记录器在观测窗口之外没有出现任何写语句（延迟写入）② 被测模块创建且尚未结束的定时器为 0（含 unref 的）③ 可控注入定时器没有遗留未清理的
    {
      for (const r of allRecs) if (r.drain) await r.drain();
      await turns(5);
      for (const r of allRecs) if (r.drain) await r.drain();
      await turns(5);
      check('M1 运行时：记录器整个套件期间持续开着，套件结束前排空后，所有记录器在观测窗口之外没有出现任何写语句（outOfWindow 为空）', allRecs.every((r) => r.outOfWindow.length === 0), JSON.stringify(allRecs.map((r) => r.outOfWindow)));
      check('K2 运行时：套件结束前排空后，被测模块创建、且尚未结束的定时器为 0（全局 setTimeout / setInterval / setImmediate 的包装不按延迟筛选，unref 的也算；已触发或已清理才算结束）', pendingTimers.size === 0, JSON.stringify([...pendingTimers.values()]));
      const ctlPending = ctlTimers.all.filter((x) => !x.cleared && !x.fired);
      check('K2 运行时：测试自己的可控注入定时器（手动核验 / 每日任务）在套件结束前没有遗留未清理也未触发的项', ctlPending.length === 0, JSON.stringify(ctlPending.map((x) => x.ms)));
    }
    restoreProto();   // 还原 sqlite3.Database 原型上的观察钩子
  } finally {
    for (const s of openServers) { try { if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); await new Promise((res) => s.close(() => res())); } catch (_) { /* ignore */ } }
    try { await db.close(); } catch (_) { /* ignore */ }
    H.removeTree(runDir);
  }
  console.log(`verify-model-impl-verify PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

(process.argv.includes('--self-test') ? Promise.resolve(selfTest()) : main()).catch((e) => { console.log(`FAIL 套件异常：${e && e.stack || e}`); process.exitCode = 1; }).finally(() => {
  H.runCleanupsSync();
  if (H.cleanupFailures.length) { console.log(`FAIL 清理复查：${H.cleanupFailures.length} 项未通过\n  ${H.cleanupFailures.join('\n  ')}`); process.exitCode = 1; }
});
