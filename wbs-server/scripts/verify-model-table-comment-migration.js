// #77 C2a：table_comment 拆分迁移脚本（migrate-model-table-comment.js）的验证。
//
// 全程只用自建的临时夹具库（临时根下由被测代码自建空库 + 一次性写夹具），服务从夹具库起（复用 HTTP 套件导出的起服务工具，出网被 net-guard 拦截）；
// 不读写本机真实库 wbs-server/task_pool.db，不连外网。迁移脚本的 apply / revert 只经 HTTP 打到夹具服务（127.0.0.1 随机端口，非 3000）；
// 还原信息写进独占新建的执行回执 JSON（--receipt），不再有备份库（C2a 修复 2：codex 24-R 两个 HIGH 都出在备份库，整套删除）。
// 期望值全部手写：夹具文本、长度、建议短名 / 实现说明、回执行的 before / target、各行状态都是字面量，不从被测代码推导。
//
// 覆盖：建议规则（全角括号 / 半角括号 / 无括号 ≤30 / 无括号 >30 需人工 / 括号开头需人工 / 边界 15 与 16 / 伴生行与已删除行不进清单 / 三档计数 / 无 impl_note 列的旧库 /
//   经 HTTP 取数与 --db 取数结果一致）、建议模式只读、apply 干跑零写入且不创建回执、apply 正常写（值、回执逐行 before / target、变更日志、config_rev 全库不变）、
//   回执已存在被拒、重跑同一 migration_id 零写入、期间被改过的行跳过且不覆盖、已有不同 impl_note 的行跳过、伴生行重新派生（标准形态写入 / 非标准形态跳过）、
//   清单里指向伴生 / 已删除模型的行被拒、revert 只读回执（format / migration_id / base_url 校验）、整行条件还原（expected = target）、apply 与 revert 互逆、
//   伴生行改挂后 revert 记 skipped-modified 不写（24-R HIGH-1 反例）、revert 自身回执、中途崩溃回执仍是合法 JSON 且 revert 可据此还原、
//   超时三态与 config_rev 比对（R3）、伴生行时效、partial / failed / interrupted 与命令行退出码、apply / revert 传 --db 被拒、无默认库、清单校验失败零写入、服务缺 impl_note 字段时拒绝。
//
// 运行：node scripts/verify-model-table-comment-migration.js [--script <被测脚本路径>]（变异自证时指向 scratchpad 里的副本；默认是仓库内脚本）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const H = require('./verify-model-config-rev-http.js');
const { listenOnSafePort } = require('./lib/listen-safe-port');
// 可选 --script <路径>：指定被测迁移脚本（变异自证时指向 scratchpad 里的副本；默认仍是仓库内脚本）。副本不在仓库目录树下，靠 NODE_PATH 解析 sqlite3。
const scriptArgIdx = process.argv.indexOf('--script');
const SCRIPT_PATH = scriptArgIdx >= 0 && process.argv[scriptArgIdx + 1] ? path.resolve(process.argv[scriptArgIdx + 1]) : path.join(__dirname, 'migrate-model-table-comment.js');
const CUSTOM_SCRIPT = scriptArgIdx >= 0;
if (CUSTOM_SCRIPT) {
  process.env.NODE_PATH = [path.join(H.ROOT, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
  require('node:module').Module._initPaths();
}
const M = require(SCRIPT_PATH);

const results = [];
const check = (name, cond, detail) => {
  results.push({ name, ok: !!cond });
  if (!cond) console.log(`FAIL ${name}${detail === undefined ? '' : '\n  ' + detail}`);
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const len = (s) => [...s].length;
const J = (v) => JSON.stringify(v);

// ───────────── 夹具文本（字面量；长度在前提断言里核对）─────────────
const A_OLD = '员工信息（HR 系统每日全量同步，含离职员工）';            // 23 字，全角括号
const A_NEW = '员工信息';
const A_IMPL = '（HR 系统每日全量同步，含离职员工）';
const A_COMP_OLD = A_OLD + ' - 变更追踪';                              // 30 字，伴生行标准派生形态
const A_COMP_NEW = '员工信息 - 变更追踪';
const B_OLD = '客户维度(来源CRM,按天增量更新,保留历史)';                 // 23 字，半角括号
const B_IMPL_OLD = '旧手写说明';
const C_OLD = '没有括号但是超过十五个字的表注释说明文本';                  // 20 字，无括号 ≤30
const C_EDITED = '被别人改过的注释';
const D_OLD = '无括号长注释'.repeat(6);                                 // 36 字，无括号 >30；库里 category 是 NULL（遗留形态）
const D_NEW = '无括号短名';
const D_EDITED = 'D 又被别人改了';
const H_OLD = '（仅括号开头的注释文字很长很长很长）';                      // 18 字，括号开头
const H_NEW = '括号开头模型';
const E_OLD = '短注释';                                                 // 3 字
const B15 = '一二三四五六七八九十一二三四五';                              // 15 字：不进清单
const B16 = '一二三四五六七八九十一二三四五六';                            // 16 字：进清单
const P2_OLD = '订单明细表';
const P2_NEW = '订单明细';
const P2_COMP = '手工维护的伴生注释';
const G_OLD = '已删除模型（这个注释很长很长很长很长很长很长）';

async function main() {
  const runDir = H.makeRunDir('tcmig');
  const code = H.copyCode(H.ROOT, path.join(runDir, 'svc'), 'after');
  const dbPath = path.join(runDir, 'fixture.db');            // 服务库
  const receiptDir = path.join(runDir, 'receipts');   // 回执目录（独占新建的回执 JSON 都放这里）
  fs.mkdirSync(receiptDir, { recursive: true });
  const gate = { up: false, writes: 0, fixtureWrites: 0 };
  const svc = H.makeService({ copyRoot: code.copyRoot, dbPath, tag: 'tcmig', gate });
  const fakeLive = path.join(runDir, 'fake-live.db');   // 注入的「正式库」路径（不是真的正式库）
  const runner = M.createRunner({ liveDb: path.join(runDir, 'no-such-live.db') });
  const ids = {};
  let adminToken = null;
  let stubServer = null;
  try {
    // ── 阶段 0/1：空库自建 → 服务停止时一次性写夹具 ──
    await H.createFreshDb(svc);
    const w = await H.openWriter(dbPath, gate);
    try {
      await w.get('PRAGMA journal_mode = WAL');
      const fx = H.makeFixtures(w);
      const admin = await fx.user('tc_admin', 'admin');
      adminToken = admin.token;
      const mk = (key, f) => fx.model(f).then((id) => { ids[key] = id; return id; });
      await mk('A', { layer: 'DWD', table_comment: A_OLD });
      await mk('F', { layer: 'DWD', table_comment: A_COMP_OLD, companion_of: ids.A, config_mode: 'companion' });
      await mk('B', { layer: 'DIM', table_comment: B_OLD, impl_note: B_IMPL_OLD });
      await mk('C', { layer: 'ODS', table_comment: C_OLD });
      await mk('D', { layer: 'ODS', table_comment: D_OLD, category: null });
      await mk('E', { layer: 'ODS', table_comment: E_OLD });
      await mk('H', { layer: 'ODS', table_comment: H_OLD });
      await mk('B15', { layer: 'ODS', table_comment: B15 });
      await mk('B16', { layer: 'ODS', table_comment: B16 });
      await mk('P2', { layer: 'DWD', table_comment: P2_OLD });
      await mk('P2C', { layer: 'DWD', table_comment: P2_COMP, companion_of: ids.P2, config_mode: 'companion' });
      await mk('G', { layer: 'ODS', table_comment: G_OLD, is_deleted: 1 });
      await w.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { await w.close(); }

    // 前提：夹具长度（期望值的依据，手写核对）
    const lens = [len(A_OLD), len(B_OLD), len(C_OLD), len(D_OLD), len(H_OLD), len(B15), len(B16), len(A_COMP_OLD)].join(',');
    check('前提：夹具文本长度符合手写依据（A=23 B=23 C=20 D=36 H=18 B15=15 B16=16 伴生=30）', lens === '23,23,20,36,18,15,16,30', lens);

    // ── §1 建议规则（服务停止、--db 只读）──
    const hashBefore = sha(dbPath);
    const outFile = path.join(runDir, 'suggest.json');
    const sg = await runner.suggest({ db: dbPath, out: outFile });
    const rep = sg.report;
    check('suggest：库文件哈希不变（只读打开，零写入）', sha(dbPath) === hashBefore, 'db 文件被改动');
    check('suggest：三档计数 = >15 共 6 个 / >20 共 3 个 / >30 共 1 个，候选总体 9 个（非伴生、未删除、有注释）',
      rep.counts.over_15 === 6 && rep.counts.over_20 === 3 && rep.counts.over_30 === 1 && rep.counts.population === 9, J(rep.counts));
    check('suggest：默认阈值 15，清单 6 条', rep.min_len === 15 && rep.items.length === 6, `${rep.min_len} / ${rep.items.length}`);
    const byId = new Map(rep.items.map(i => [i.model_id, i]));
    const A1 = byId.get(ids.A);
    check('suggest 全角括号：短名「员工信息」，实现说明为括号及之后全文，不需人工',
      A1 && A1.suggested_short === A_NEW && A1.suggested_impl_note === A_IMPL && A1.needs_manual === false && A1.old_table_comment === A_OLD && A1.layer === 'DWD', J(A1));
    const B1 = byId.get(ids.B);
    check('suggest 半角括号：短名「客户维度」，实现说明 = 「(来源CRM,按天增量更新,保留历史)」，current_impl_note 带出库里已有值',
      B1 && B1.suggested_short === '客户维度' && B1.suggested_impl_note === '(来源CRM,按天增量更新,保留历史)' && B1.needs_manual === false && B1.current_impl_note === B_IMPL_OLD, J(B1));
    const C1 = byId.get(ids.C);
    check('suggest 无括号且 ≤30 字：不拆（建议短名 = 原注释，无实现说明，不需人工）', C1 && C1.suggested_short === C_OLD && C1.suggested_impl_note === null && C1.needs_manual === false, J(C1));
    const D1 = byId.get(ids.D);
    check('suggest 无括号且 >30 字：标需人工拟短名（短名与实现说明均为空）', D1 && D1.needs_manual === true && D1.suggested_short === null && D1.suggested_impl_note === null, J(D1));
    const H1 = byId.get(ids.H);
    check('suggest 括号开头（界前为空）：标需人工拟短名', H1 && H1.needs_manual === true && H1.suggested_short === null, J(H1));
    check('suggest 边界：15 字不进清单、16 字进清单、3 字不进清单', !byId.has(ids.B15) && byId.has(ids.B16) && !byId.has(ids.E), [...byId.keys()].join(','));
    check('suggest：伴生行与已删除行不进清单', !byId.has(ids.F) && !byId.has(ids.P2C) && !byId.has(ids.G), [...byId.keys()].join(','));
    check('suggest：每条带 §6.1 C2a ⑥ 的重新验收提示，顶层 notice 同', rep.items.every(i => /需重新验收/.test(i.rev_impact)) && /需重新验收/.test(rep.notice), J(rep.items[0]));
    const fileJson = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    check('suggest --out：JSON 文件内容与返回一致，字段齐全（model_id / table_name / layer / old_table_comment / suggested_short / suggested_impl_note / needs_manual / current_impl_note）',
      fileJson.items.length === 6 && ['model_id', 'table_name', 'layer', 'old_table_comment', 'suggested_short', 'suggested_impl_note', 'needs_manual', 'current_impl_note'].every(k => k in fileJson.items[0]), J(Object.keys(fileJson.items[0])));
    const sg20 = await runner.suggest({ db: dbPath, minLen: 20 });
    check('suggest --min-len 20：清单 = 超过 20 字的 3 条（A / B / D），三档计数与阈值无关', sg20.report.items.map(i => i.model_id).sort((x, y) => x - y).join(',') === [ids.A, ids.B, ids.D].sort((x, y) => x - y).join(',') && sg20.report.counts.over_15 === 6, J(sg20.report.items.map(i => i.model_id)));
    await check_rejects('suggest --out 指向已存在文件被拒', () => runner.suggest({ db: dbPath, out: outFile }), /不存在的新文件/);
    await check_rejects('suggest 同时给 --db 与 --base-url 被拒', () => runner.suggest({ db: dbPath, baseUrl: 'http://127.0.0.1:1', tokenFile: 'x' }), /二选一/);
    await check_rejects('suggest 两者都不给被拒', () => runner.suggest({}), /--db .*或 --base-url/);

    // 旧库（尚无 impl_note 列）：suggest --db 照常工作（current_impl_note 全 null）
    const oldDb = path.join(runDir, 'old-schema.db');
    await new Promise((resolve, reject) => {
      const d = new sqlite3.Database(oldDb, (e) => {
        if (e) return reject(e);
        d.exec(`CREATE TABLE data_models (id INTEGER PRIMARY KEY, table_name TEXT, layer TEXT, table_comment TEXT, companion_of INTEGER, is_deleted INTEGER, config_rev INTEGER);
                INSERT INTO data_models VALUES (1, 'old_a', 'ODS', '${A_OLD}', NULL, 0, 1);`, (e2) => d.close(() => (e2 ? reject(e2) : resolve())));
      });
    });
    const sgOld = await runner.suggest({ db: oldDb });
    check('suggest 旧库（无 impl_note 列）：可用，current_impl_note 为 null，列缺失标记为 false', sgOld.report.impl_note_column_present === false && sgOld.report.items.length === 1 && sgOld.report.items[0].current_impl_note === null, J(sgOld.report));

    // ── 阶段 2：起服务 ──
    await svc.start();
    const rd = await H.openReader(dbPath);
    const api = H.makeApi(() => svc.baseUrl);
    const put = (id, body) => api('PUT', `/api/models/${id}`, { token: adminToken, body });
    const getRow = async (id) => (await api('GET', `/api/models/${id}`, { token: adminToken })).json;
    const tokenFile = path.join(runDir, 'token.txt');
    fs.writeFileSync(tokenFile, adminToken + '\n');
    try {
      const rowOf = (id) => rd.get('SELECT table_comment, impl_note, config_rev, category FROM data_models WHERE id = ?', [id]);
      const revMap = async () => Object.fromEntries((await rd.all('SELECT id, config_rev FROM data_models ORDER BY id')).map(r => [r.id, r.config_rev]));
      const snapshot = async () => J(await rd.all('SELECT id, table_comment, impl_note, config_rev, category FROM data_models ORDER BY id'));
      const svcHasBackupTable = async () => (await rd.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_migration_backup'")).length > 0;
      const logCount = async (id) => (await rd.get("SELECT COUNT(*) AS c FROM model_change_logs WHERE model_id = ? AND action = 'UPDATE'", [id])).c;
      const readJ = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
      const settle = (ms) => H.settle(ms);
      const rev0 = await revMap();
      var cli = (...args) => spawnSync(process.execPath, [SCRIPT_PATH, ...args], { encoding: 'utf8', timeout: 20000 });   // var：后面服务块之外的命令行用例也要用
      check('前提：夹具全部 config_rev = 1', Object.values(rev0).every(v => v === 1), J(rev0));
      check('前提：D 在服务库里 category 为 NULL（遗留形态）', (await rowOf(ids.D)).category === null, J(await rowOf(ids.D)));
      const dBeforeAll = await rd.get('SELECT * FROM data_models WHERE id = ?', [ids.D]);   // 全列快照：apply / revert 后只允许 table_comment / impl_note / updated_at 变化

      // suggest 经 HTTP 取数：与 --db 取数的清单一致（A / B / C / D / H / B16 同样的建议）
      const snapHttp0 = await snapshot();
      const sgHttp = await runner.suggest({ baseUrl: svc.baseUrl, tokenFile });
      const httpIds = sgHttp.report.items.map(i => i.model_id).sort((x, y) => x - y).join(',');
      check('suggest 经 HTTP 取数：来源标记为 http，清单 6 条且与 --db 取数同一批模型，三档计数相同',
        /^http:/.test(sgHttp.report.source) && httpIds === rep.items.map(i => i.model_id).sort((x, y) => x - y).join(',') && J(sgHttp.report.counts) === J(rep.counts), J([sgHttp.report.source, httpIds, sgHttp.report.counts]));
      const hA = sgHttp.report.items.find(i => i.model_id === ids.A);
      check('suggest 经 HTTP 取数：A 的建议短名 / 实现说明与 --db 取数一致，伴生与已删除模型不在清单', hA && hA.suggested_short === A_NEW && hA.suggested_impl_note === A_IMPL && !sgHttp.report.items.some(i => [ids.F, ids.P2C, ids.G].includes(i.model_id)), J(hA));
      check('suggest 经 HTTP 取数：库零写入', await snapshot() === snapHttp0 && J(await revMap()) === J(rev0), '服务库被改动');

      // 期间被人改过：C 的表注释在清单定稿后被别人改了（走服务 PUT）
      const pc = await put(ids.C, { table_comment: C_EDITED });
      check('前提：把 C 的表注释改成别人的版本（PUT 200）', pc.status === 200, J(pc.json || pc.text));
      await settle(300);
      const cLogsBefore = await logCount(ids.C);

      // 最终清单（手写；字段 = model_id / old_table_comment / new_table_comment / new_impl_note）
      const finalList = [
        { model_id: ids.A, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: A_IMPL },
        { model_id: ids.B, old_table_comment: B_OLD, new_table_comment: '客户维度', new_impl_note: '(来源CRM,按天增量更新,保留历史)' },
        { model_id: ids.C, old_table_comment: C_OLD, new_table_comment: '无括号说明短名', new_impl_note: null },
        { model_id: ids.D, old_table_comment: D_OLD, new_table_comment: D_NEW, new_impl_note: D_OLD },
        { model_id: ids.H, old_table_comment: H_OLD, new_table_comment: H_NEW, new_impl_note: null },
        { model_id: ids.P2, old_table_comment: P2_OLD, new_table_comment: P2_NEW, new_impl_note: null },
        { model_id: ids.G, old_table_comment: G_OLD, new_table_comment: '已删除不应被写', new_impl_note: null },
        { model_id: ids.F, old_table_comment: A_COMP_OLD, new_table_comment: '伴生行直接列入清单', new_impl_note: null },
      ];
      const listFile = path.join(runDir, 'final.json');
      fs.writeFileSync(listFile, J(finalList));
      let rcpSeq = 0;
      const newReceipt = () => path.join(receiptDir, `rcp-${++rcpSeq}.json`);   // 每次调用一个全新的、不存在的回执路径
      const base = { list: listFile, baseUrl: svc.baseUrl, tokenFile, migrationId: 'mig_t1' };
      const withR = (o, extra) => ({ ...o, receipt: newReceipt(), ...(extra || {}) });
      const state = (res, kind, id) => (res.rows.find(r => r.kind === kind && r.model_id === id) || {}).state;

      // ── 参数校验失败：零写入、回执不被创建 ──
      const snap0 = await snapshot();
      const dupList = path.join(runDir, 'dup.json');
      fs.writeFileSync(dupList, J([finalList[0], finalList[0]]));
      await check_rejects('apply 清单里 model_id 重复被拒', () => runner.apply(withR(base, { list: dupList })), /重复/);
      const badList = path.join(runDir, 'bad.json');
      fs.writeFileSync(badList, J([{ model_id: ids.A, old_table_comment: A_OLD, new_table_comment: '', new_impl_note: null }]));
      await check_rejects('apply 清单里 new_table_comment 为空被拒', () => runner.apply(withR(base, { list: badList })), /new_table_comment/);
      const wsList = path.join(runDir, 'ws.json');
      fs.writeFileSync(wsList, J([{ model_id: ids.A, old_table_comment: A_OLD, new_table_comment: '   ', new_impl_note: null }]));
      await check_rejects('Z1 apply 清单里 new_table_comment 只有空格被拒（与空串同一道校验：already-target 行的 table_comment 恒非空）', () => runner.apply(withR(base, { list: wsList })), /new_table_comment 必须是非空字符串/);
      await check_rejects('apply 缺 migration-id 被拒', () => runner.apply(withR(base, { migrationId: undefined })), /migration-id/);
      await check_rejects('apply 传 --db 被拒（不再接受 --db，报错说明新用法）', () => runner.apply(withR(base, { db: dbPath })), /不再接受 --db.*--receipt/);
      await check_rejects('revert 传 --db 被拒', () => runner.revert({ baseUrl: svc.baseUrl, tokenFile, receipt: 'x.json', db: dbPath }), /不再接受 --db/);
      await check_rejects('R1 apply 缺 --receipt 被拒', () => runner.apply({ ...base }), /必须给 --receipt/);
      await check_rejects('R1 apply --receipt 所在目录不存在被拒', () => runner.apply({ ...base, receipt: path.join(runDir, 'no-dir', 'x.json') }), /所在目录不存在/);
      await check_rejects('R1 apply --receipt 扩展名不是 .json 被拒（拒绝把回执写成 .db 之类）', () => runner.apply({ ...base, receipt: path.join(runDir, 'receipts', 'x.db') }), /必须是 \.json/);
      check('参数校验失败：服务库零写入、无备份表、回执目录里没有任何文件被创建', await snapshot() === snap0 && !(await svcHasBackupTable()) && fs.readdirSync(path.join(runDir, 'receipts')).length === 0, J(fs.readdirSync(path.join(runDir, 'receipts'))));

      // ── dry-run：零写入、不创建回执 ──
      const dry = await runner.apply({ ...base, dryRun: true, receipt: path.join(runDir, 'receipts', 'dry.json') });
      check('apply --dry-run：计划里 A / 伴生 F / D / H / P2 为 write，B / C / P2 伴生为 skipped-modified，G / 清单里的 F 为 skipped-invalid',
        state(dry, 'parent', ids.A) === 'write' && state(dry, 'companion', ids.F) === 'write' && state(dry, 'parent', ids.D) === 'write' && state(dry, 'parent', ids.H) === 'write' && state(dry, 'parent', ids.P2) === 'write'
        && state(dry, 'parent', ids.B) === 'skipped-modified' && state(dry, 'parent', ids.C) === 'skipped-modified' && state(dry, 'companion', ids.P2C) === 'skipped-modified'
        && state(dry, 'parent', ids.G) === 'skipped-invalid' && state(dry, 'parent', ids.F) === 'skipped-invalid', J(dry.rows.map(r => [r.kind, r.model_id, r.state])));
      await settle(300);
      check('R1 apply --dry-run：服务库零写入（表注释 / impl_note / config_rev / category 全库不变）、不创建回执', await snapshot() === snap0 && !fs.existsSync(path.join(runDir, 'receipts', 'dry.json')) && fs.readdirSync(path.join(runDir, 'receipts')).length === 0, '干跑改动了库或创建了回执');

      // ── apply ──
      const logsA0 = await logCount(ids.A), logsF0 = await logCount(ids.F), logsD0 = await logCount(ids.D), logsH0 = await logCount(ids.H), logsP20 = await logCount(ids.P2), logsB0 = await logCount(ids.B);
      const apReceipt = newReceipt();
      const ap = await runner.apply({ ...base, receipt: apReceipt });
      check('apply：无错误；清单里有跳过行（B / C / P2 伴生 skipped-modified、G / 清单里的 F skipped-invalid）⇒ 状态 partial（不再标 applied），未完成清单恰为这 5 行', ap.errors.length === 0 && ap.status === 'partial'
        && J(ap.unfinished.map(u => [u.model_id, u.state]).sort((x, y) => x[0] - y[0])) === J([[ids.B, 'skipped-modified'], [ids.C, 'skipped-modified'], [ids.F, 'skipped-invalid'], [ids.P2C, 'skipped-modified'], [ids.G, 'skipped-invalid']].sort((x, y) => x[0] - y[0])), J([ap.status, ap.errors, ap.unfinished]));
      check('apply 各行状态：A / 伴生 F / D / H / P2 written；B、C、P2 伴生 skipped-modified；G、清单里的 F skipped-invalid',
        state(ap, 'parent', ids.A) === 'written' && state(ap, 'companion', ids.F) === 'written' && state(ap, 'parent', ids.D) === 'written' && state(ap, 'parent', ids.H) === 'written' && state(ap, 'parent', ids.P2) === 'written'
        && state(ap, 'parent', ids.B) === 'skipped-modified' && state(ap, 'parent', ids.C) === 'skipped-modified' && state(ap, 'companion', ids.P2C) === 'skipped-modified'
        && state(ap, 'parent', ids.G) === 'skipped-invalid' && state(ap, 'parent', ids.F) === 'skipped-invalid', J(ap.rows.map(r => [r.kind, r.model_id, r.state])));
      // 同一服务库：GET（服务读到的）与库文件一致，且是 new 值
      const gA = await getRow(ids.A), gF = await getRow(ids.F), gD = await getRow(ids.D), gH = await getRow(ids.H), gP2 = await getRow(ids.P2);
      check('apply 后经 GET 读：A 表注释 / 实现说明、伴生 F、D、H、P2 均为 new 值（写与读是同一个服务库）',
        gA.table_comment === A_NEW && gA.impl_note === A_IMPL && gF.table_comment === A_COMP_NEW && gD.table_comment === D_NEW && gD.impl_note === D_OLD && gH.table_comment === H_NEW && gP2.table_comment === P2_NEW, J([gA, gF, gD, gH, gP2].map(g => [g.table_comment, g.impl_note])));
      const rA = await rowOf(ids.A), rF = await rowOf(ids.F), rD = await rowOf(ids.D), rH = await rowOf(ids.H), rP2 = await rowOf(ids.P2);
      check('apply 落库：A 表注释「员工信息」+ 实现说明全文', rA.table_comment === A_NEW && rA.impl_note === A_IMPL, J(rA));
      check('apply 落库：伴生行 F 重新派生为「员工信息 - 变更追踪」', rF.table_comment === A_COMP_NEW, J(rF));
      check('apply 落库：D 表注释为短名、实现说明为原长注释', rD.table_comment === D_NEW && rD.impl_note === D_OLD, J(rD));
      check('apply 落库：H 只改表注释（new_impl_note 为空不动 impl_note）', rH.table_comment === H_NEW && rH.impl_note === null, J(rH));
      check('apply 落库：P2 表注释改了、其非标准伴生行保持手工注释不动', rP2.table_comment === P2_NEW && (await rowOf(ids.P2C)).table_comment === P2_COMP, J([rP2, await rowOf(ids.P2C)]));
      const rB = await rowOf(ids.B), rC = await rowOf(ids.C);
      check('apply 跳过的行原样不动：B（已有不同 impl_note）与 C（期间被改过）', rB.table_comment === B_OLD && rB.impl_note === B_IMPL_OLD && rC.table_comment === C_EDITED && rC.impl_note === null, J([rB, rC]));
      check('apply 已删除模型与被列入清单的伴生行未被清单直接写', (await rowOf(ids.G)).table_comment === G_OLD, J(await rowOf(ids.G)));
      check('apply：全库 config_rev 与迁移前逐行相同（全程不触碰 config_rev）', J(await revMap()) === J(rev0), J(await revMap()));
      check('R1 apply：服务库里没有备份表（备份库子系统已删除，只有回执文件）', !(await svcHasBackupTable()), 'svc 出现备份表');
      // R1 回执：整体 + 逐行 before / target（手写期望）
      const rc = readJ(apReceipt);
      const rcRow = (kind, id) => rc.rows.find(r => r.kind === kind && r.model_id === id);
      const col = (tc, impl, comp, del) => ({ table_comment: tc, impl_note: impl, companion_of: comp, is_deleted: del });
      check('R1 回执头部：format / migration_id / base_url（规范化）/ list_path / started_at / finished_at 齐全，status = partial（与 apply 结果一致）',
        rc.format === 'mc77-table-comment-receipt-v2' && rc.migration_id === 'mig_t1' && rc.base_url === svc.baseUrl.toLowerCase().replace(/\/+$/, '') && rc.list_path === path.resolve(listFile) && !!rc.started_at && !!rc.finished_at && rc.status === 'partial', J({ ...rc, rows: undefined }));
      check('R1 回执：行数 = apply 报告行数，没有遗留 writing / write 中间态，回执目录里没有残留临时文件', rc.rows.length === ap.rows.length && !rc.rows.some(r => r.state === 'writing' || r.state === 'write') && fs.readdirSync(path.join(runDir, 'receipts')).every(f => !/\.tmp-/.test(f)), J([rc.rows.length, ap.rows.length, fs.readdirSync(path.join(runDir, 'receipts'))]));
      const wantRows = [
        ['parent', ids.A, null, col(A_OLD, null, null, 0), { table_comment: A_NEW, impl_note: A_IMPL }],
        ['companion', ids.F, ids.A, col(A_COMP_OLD, null, ids.A, 0), { table_comment: A_COMP_NEW, impl_note: null }],
        ['parent', ids.D, null, col(D_OLD, null, null, 0), { table_comment: D_NEW, impl_note: D_OLD }],
        ['parent', ids.H, null, col(H_OLD, null, null, 0), { table_comment: H_NEW, impl_note: null }],
        ['parent', ids.P2, null, col(P2_OLD, null, null, 0), { table_comment: P2_NEW, impl_note: null }],
      ];
      for (const [kind, id, pid, bef, tgt] of wantRows) {
        const x = rcRow(kind, id);
        check(`R1 回执行 ${kind} ${id}：state written、put_sent = true、parent_id = ${pid}、before 逐字段 = 写前 GET、target = 新值`, x && x.state === 'written' && x.put_sent === true && x.parent_id === pid && J(x.before) === J(bef) && J(x.target) === J(tgt), J(x));
      }
      check('X1 真服务回执：每个 written 行的 before_meta = { config_rev: 1, is_deleted: 0, companion_of: 父 id 或 null }（写前 GET 同一行），after_meta = { config_rev: 1 }（B 类写入不递增 config_rev）',
        wantRows.every(([kind, id, pid]) => { const x = rcRow(kind, id); return x && J(x.before_meta) === J({ config_rev: 1, is_deleted: 0, companion_of: pid }) && J(x.after_meta) === J({ config_rev: 1 }); }), J(rc.rows.map(r => [r.model_id, r.before_meta, r.after_meta])));
      const xB = rcRow('parent', ids.B);
      check('R1 回执：被跳过的 B 记 skipped-modified，带写前值与原因，target 为空', xB && xB.state === 'skipped-modified' && xB.before && xB.before.impl_note === B_IMPL_OLD && xB.target === null && !!xB.reason, J(xB));
      // 变更日志：写入走专用接口，每个被写模型恰多 1 条 UPDATE 日志；跳过的模型不多
      await settle(500);
      check('apply 变更日志：A / F / D / H / P2 各新增 1 条 UPDATE 日志，B 与 C 不新增',
        (await logCount(ids.A)) - logsA0 === 1 && (await logCount(ids.F)) - logsF0 === 1 && (await logCount(ids.D)) - logsD0 === 1 && (await logCount(ids.H)) - logsH0 === 1 && (await logCount(ids.P2)) - logsP20 === 1
        && (await logCount(ids.B)) === logsB0 && (await logCount(ids.C)) === cLogsBefore, 'log 计数不符');
      const aLog = await rd.get("SELECT change_type, change_summary FROM model_change_logs WHERE model_id = ? AND action = 'UPDATE' ORDER BY id DESC LIMIT 1", [ids.A]);
      check('apply 变更日志：A 的日志为 basic_info，摘要精确为「修改: 表注释, 实现说明」', aLog && aLog.change_type === 'basic_info' && aLog.change_summary === '修改: 表注释, 实现说明', J(aLog));
      const rowD = ap.rows.find(r => r.kind === 'parent' && r.model_id === ids.D);
      const dAfterAll = await rd.get('SELECT * FROM data_models WHERE id = ?', [ids.D]);
      check('F1 apply 报告：所有 written 行（父 + 伴生）的 normalized_fields 均为空；D 的 category 仍为 NULL，整行只有 impl_note / table_comment / updated_at 三列变化',
        ap.rows.filter(r => r.state === 'written').every(r => J(r.normalized_fields) === '[]') && ap.rows.filter(r => r.state === 'written').length === 5 && rowD && J(rowD.normalized_fields) === '[]'
        && (await rowOf(ids.D)).category === null && J(Object.keys(dBeforeAll).filter(k => dBeforeAll[k] !== dAfterAll[k]).sort()) === J(['impl_note', 'table_comment', 'updated_at']), J(rowD));

      // R1：回执已存在 ⇒ apply 拒绝，零写入、原回执一字节不动
      {
        const rcHash = sha(apReceipt), snapR = await snapshot();
        await check_rejects('R1 apply --receipt 指向已存在的回执被拒（独占创建，不覆盖）', () => runner.apply({ ...base, receipt: apReceipt }), /已存在，拒绝覆盖/);
        check('R1 回执已存在被拒后：回执字节不变、服务库零写入', sha(apReceipt) === rcHash && await snapshot() === snapR, '回执被覆盖或库被改');
      }

      // ── 重跑同一 migration_id（新回执）：零写入 ──
      const snap1 = await snapshot();
      const logsAll1 = (await rd.get('SELECT COUNT(*) AS c FROM model_change_logs')).c;
      const againReceipt = newReceipt();
      const again = await runner.apply({ ...base, receipt: againReceipt });
      await settle(500);
      check('重跑同一 migration_id：没有任何 written；A / D / H / P2 为 already-target（开始时已是目标值），B / C 为 skipped-modified，G / 清单中的 F 为 skipped-invalid',
        !again.rows.some(r => r.state === 'written') && state(again, 'parent', ids.A) === 'already-target' && state(again, 'parent', ids.D) === 'already-target' && state(again, 'parent', ids.H) === 'already-target' && state(again, 'parent', ids.P2) === 'already-target'
        && state(again, 'parent', ids.B) === 'skipped-modified' && state(again, 'parent', ids.C) === 'skipped-modified'
        && state(again, 'parent', ids.G) === 'skipped-invalid' && state(again, 'parent', ids.F) === 'skipped-invalid', J(again.rows.map(r => [r.kind, r.model_id, r.state])));
      check('X4 父行 already-target（本次未写）⇒ 不派生其伴生行：重跑里没有任何 companion 行（A 的伴生 F、P2 的伴生 P2C 都不出现），父行 reason 带「不派生」提示',
        !again.rows.some(r => r.kind === 'companion') && /其伴生行不在本次处理/.test((again.rows.find(r => r.kind === 'parent' && r.model_id === ids.A) || {}).reason || ''), J(again.rows.map(r => [r.kind, r.model_id, r.state])));
      check('重跑：服务库、变更日志条数都不变（零写入、不重复写）；重跑回执里 A 的 before 已等于 target（done）', await snapshot() === snap1 && (await rd.get('SELECT COUNT(*) AS c FROM model_change_logs')).c === logsAll1
        && (() => { const x = readJ(againReceipt).rows.find(r => r.kind === 'parent' && r.model_id === ids.A); return x && x.state === 'already-target' && x.put_sent === false && x.before.table_comment === A_NEW && x.target && x.target.table_comment === A_NEW && /还原须同时提供更早的回执/.test(x.reason || ''); })(), '重跑改动了库');

      // ── revert：干跑零写入、不创建回执 ──
      const revBase = { receipt: apReceipt, baseUrl: svc.baseUrl, tokenFile };
      const snap2 = await snapshot();
      const rvDryPath = path.join(runDir, 'receipts', 'rv-dry.json');
      const dirListing = () => J(fs.readdirSync(receiptDir).sort().map(n => [n, sha(path.join(receiptDir, n))]));   // P57⑥：回执目录文件清单（文件名 + 内容哈希）
      const dirBeforeRvDry = dirListing();
      const rvDry = await runner.revert({ ...revBase, dryRun: true, revertReceipt: rvDryPath });
      await settle(300);
      check('revert --dry-run：计划还原 A / F / D / H / P2，服务库零写入、不创建 revert 回执（指定的回执路径不存在，且回执目录文件清单前后完全相同）', ['A', 'F', 'D', 'H', 'P2'].every(k => state(rvDry, 'revert', ids[k]) === 'write') && await snapshot() === snap2 && !fs.existsSync(rvDryPath) && dirListing() === dirBeforeRvDry, J(rvDry.rows.map(r => [r.model_id, r.state])));
      // D 的表注释被别人再改一次：revert 条件写 expected = target（整行两列），当前值不是 target ⇒ 不写，skipped-modified，别人的值与 impl_note 都原样保留
      const pd = await put(ids.D, { table_comment: D_EDITED });
      check('前提：把 D 的表注释再改一次（PUT 200）', pd.status === 200, J(pd.json || pd.text));
      await settle(300);
      const rvReceipt = newReceipt();
      const rv = await runner.revert({ ...revBase, revertReceipt: rvReceipt });
      check('R2 revert：无错误；D 被别人改过 ⇒ skipped-modified ⇒ 状态 partial（其余行 reverted）', rv.errors.length === 0 && rv.status === 'partial' && state(rv, 'revert', ids.D) === 'skipped-modified'
        && ['A', 'F', 'H', 'P2'].every(k => state(rv, 'revert', ids[k]) === 'reverted'), J(rv.rows.map(r => [r.model_id, r.state])));
      // 互逆：apply 后 GET 为 new（上面已核），revert 后 GET 为 old
      const vgA = await getRow(ids.A), vgF = await getRow(ids.F), vgH = await getRow(ids.H), vgP2 = await getRow(ids.P2), vgD = await getRow(ids.D);
      check('R5 互逆：revert 后经 GET 读，A / 伴生 F / H / P2 的表注释回到 old，A 的 impl_note 回 null（apply 后为 new、revert 后为 old，同一服务库）',
        vgA.table_comment === A_OLD && vgA.impl_note === null && vgF.table_comment === A_COMP_OLD && vgH.table_comment === H_OLD && vgP2.table_comment === P2_OLD, J([vgA, vgF, vgH, vgP2].map(g => [g.table_comment, g.impl_note])));
      const vA = await rowOf(ids.A), vF = await rowOf(ids.F), vD = await rowOf(ids.D), vH = await rowOf(ids.H), vP2 = await rowOf(ids.P2);
      check('revert 还原（库文件）：A 表注释回原长注释、impl_note 回 NULL；伴生行 F 回「原父表注释 - 变更追踪」；H、P2 表注释回原值', vA.table_comment === A_OLD && vA.impl_note === null && vF.table_comment === A_COMP_OLD && vH.table_comment === H_OLD && vP2.table_comment === P2_OLD, J([vA, vF, vH, vP2]));
      check('R2 revert 整行条件：D 被别人改过表注释 ⇒ 整行不还原（impl_note 保持原长注释、表注释保持「D 又被别人改了」，不再做列级部分还原）', vD.table_comment === D_EDITED && vD.impl_note === D_OLD && vgD.table_comment === D_EDITED, J(vD));
      check('revert：被跳过的 B、C 与 P2 伴生行没被碰', (await rowOf(ids.B)).table_comment === B_OLD && (await rowOf(ids.C)).table_comment === C_EDITED && (await rowOf(ids.P2C)).table_comment === P2_COMP, 'B/C/P2C 被改动');
      check('revert：全库 config_rev 与迁移前逐行相同', J(await revMap()) === J(rev0), J(await revMap()));
      const rvc = readJ(rvReceipt);
      check('R2 revert 回执：独立新文件（format = revert 回执、migration_id / base_url 同源、source_receipt 指向 apply 回执），5 行结果与报告一致（A / F / H / P2 reverted + D skipped-modified），status partial；apply 回执一字节未被 revert 改动',
        rvc.format === 'mc77-table-comment-revert-receipt-v1' && rvc.migration_id === 'mig_t1' && rvc.base_url === rc.base_url && rvc.source_receipt === path.resolve(apReceipt) && rvc.rows.length === 5 && rvc.rows.filter(r => r.state === 'reverted').length === 4
        && rvc.rows.find(r => r.model_id === ids.D).state === 'skipped-modified' && rvc.status === 'partial' && !!rvc.finished_at && J(readJ(apReceipt)) === J(rc), J(rvc.rows.map(r => [r.model_id, r.state])));
      // 再次 revert（新 revert 回执）：零写入
      const snap3 = await snapshot();
      const rv2 = await runner.revert({ ...revBase, revertReceipt: newReceipt() });
      await settle(300);
      check('再次 revert：没有 reverted / write，A / F / H / P2 为 done（当前已是原值），D 为 skipped-modified（表注释仍被别人占着）',
        !rv2.rows.some(r => r.state === 'reverted' || r.state === 'write') && ['A', 'F', 'H', 'P2'].every(k => state(rv2, 'revert', ids[k]) === 'done') && state(rv2, 'revert', ids.D) === 'skipped-modified' && await snapshot() === snap3, J(rv2.rows.map(r => [r.model_id, r.state])));
      // R2 revert 前置校验
      await check_rejects('R2 revert 回执 base_url 与命令行不一致被拒（回执不得跨服务使用）', () => runner.revert({ ...revBase, baseUrl: 'http://127.0.0.1:9', revertReceipt: newReceipt() }), /base_url.*不一致/);
      await check_rejects('R2 revert 命令行 --migration-id 与回执不一致被拒', () => runner.revert({ ...revBase, migrationId: 'mig_other', revertReceipt: newReceipt() }), /migration_id.*不一致/);
      check('R2 revert --migration-id 与回执一致、base_url 尾斜杠写法不同可通过前置校验（干跑）', (await runner.revert({ ...revBase, baseUrl: svc.baseUrl + '/', migrationId: 'mig_t1', dryRun: true })).errors.length === 0, 'unexpected');
      await check_rejects('R2 revert --revert-receipt 指向已存在文件被拒', () => runner.revert({ ...revBase, revertReceipt: rvReceipt }), /已存在，拒绝覆盖/);
      await check_rejects('R2 revert 缺 --revert-receipt 被拒（非干跑）', () => runner.revert({ ...revBase }), /必须给 --revert-receipt/);
      await check_rejects('R2 revert --receipt 不是 apply 回执（format 不对）被拒', () => runner.revert({ receipt: rvReceipt, baseUrl: svc.baseUrl, tokenFile, revertReceipt: newReceipt() }), /format 不是/);
      await check_rejects('R2 revert --receipt 不是合法 JSON 被拒', () => runner.revert({ receipt: tokenFile, baseUrl: svc.baseUrl, tokenFile, revertReceipt: newReceipt() }), /回执读取 \/ 解析失败/);
      check('回执前置校验被拒后：服务库零写入', await snapshot() === snap3, '被拒后仍有写入');

      // F6：命令行退出码（真实夹具服务）。清单只含已删除模型 G ⇒ skipped-invalid ⇒ partial：退出码 1；--allow-skips ⇒ 0；报告末尾有未完成清单 JSON
      const gOnly = path.join(runDir, 'g-only.json');
      fs.writeFileSync(gOnly, J([{ model_id: ids.G, old_table_comment: G_OLD, new_table_comment: '已删除不应被写', new_impl_note: null }]));
      const cliArgsG = () => ['--apply', '--list', gOnly, '--base-url', svc.baseUrl, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli'];
      const cp1 = cli(...cliArgsG());
      const m1 = /未完成清单\(JSON\): (\[.*\])/.exec(cp1.stdout || '');
      check('F6 命令行：partial（只有 skipped-invalid）退出码 1，输出「结果: partial」与未完成清单 JSON（含 model_id / state / reason）', cp1.status === 1 && /结果: partial/.test(cp1.stdout || '') && m1 && (() => { const a = JSON.parse(m1[1]); return a.length === 1 && a[0].model_id === ids.G && a[0].state === 'skipped-invalid' && !!a[0].reason; })(), `${cp1.status} ${cp1.stdout} ${cp1.stderr}`);
      const cp2 = cli(...cliArgsG(), '--allow-skips');
      check('F6 命令行：同样的 partial 加 --allow-skips 退出码 0（清单仍输出）', cp2.status === 0 && /结果: partial/.test(cp2.stdout || '') && /未完成清单\(JSON\): \[\{/.test(cp2.stdout || ''), `${cp2.status} ${cp2.stdout} ${cp2.stderr}`);
      const cp3 = cli(...cliArgsG(), '--timeout-ms', 'abc');
      check('F4 命令行：--timeout-ms 非正整数报错退出', cp3.status === 1 && /--timeout-ms 必须是正整数/.test(cp3.stderr || ''), `${cp3.status} ${cp3.stderr}`);

      // ── 服务缺 impl_note 字段（旧版本服务）：apply 拒绝（用桩服务模拟，只返回无 impl_note 的行）──
      stubServer = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api/models') res.end(J([{ id: 1, table_name: 'old_a', layer: 'ODS', table_comment: A_OLD, companion_of: null, is_deleted: 0, config_rev: 1 }]));
        else res.end(J({ id: 1, table_name: 'old_a', layer: 'ODS', table_comment: A_OLD, companion_of: null, is_deleted: 0, config_rev: 1 }));
      });
      await listenOnSafePort(stubServer);
      const stubUrl = `http://127.0.0.1:${stubServer.address().port}`;
      const listOne = path.join(runDir, 'list-one.json');
      fs.writeFileSync(listOne, J([{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: A_IMPL }]));
      await check_rejects('apply 目标服务的模型行没有 impl_note 字段（旧版本服务）被拒', () => runner.apply({ list: listOne, baseUrl: stubUrl, tokenFile, migrationId: 'mig_old', dryRun: true }), /没有 impl_note 字段/);

      // ═══════════════ 用可编程桩服务（内存模型 + 与服务端同语义的条件写）验证竞态 / 超时 / 伴生时效 / 退出码 / 回执 ═══════════════
      let listSeq = 0;
      const writeList = (rows) => { const f = path.join(runDir, `stub-list-${++listSeq}.json`); fs.writeFileSync(f, J(rows)); return f; };
      const withStub = async (models, fn) => {
        const stub = await makeStub(models);
        try { return await fn(stub); } finally { await stub.close(); }
      };
      const P1 = { id: 1, table_name: 's_parent', table_comment: A_OLD };
      const L1 = [{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: A_IMPL }];
      const tracked = [];   // X6：桩服务上跑出的全部 apply / revert 结果，收尾统一断言状态机（出现 error 后最终状态不得是 applied / reverted）
      const sApply = (stub, list, extra) => runner.apply({ list: writeList(list), baseUrl: stub.url, tokenFile, receipt: newReceipt(), migrationId: 'mig_s', timeoutMs: 400, ...(extra || {}) }).then(r => { tracked.push(r); return r; });
      // revert 抛错（如「没有可还原的行」）转成可断言的结果，让回归判红而不是整个套件异常退出
      const safeRevert = (o) => runner.revert(o).then(r => { tracked.push(r); return r; }, e => ({ rows: [], status: 'threw: ' + e.message, errors: [e.message], unfinished: [], timeouts: [] }));
      const rowState = (res, kind, id) => (res.rows.find(r => r.kind === kind && r.model_id === id) || {}).state;
      // 桩服务在本进程内：命令行子进程必须异步等待（spawnSync 会阻塞事件循环让桩无法响应）
      const spawnScript = (args) => {
        const child = require('node:child_process').spawn(process.execPath, [SCRIPT_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        const t = setTimeout(() => child.kill(), 20000);
        const done = new Promise((resolve) => child.on('close', (status, signal) => { clearTimeout(t); resolve({ status, signal, stdout, stderr }); }));
        return { child, done };
      };
      const cliAsync = (...args) => spawnScript(args).done;

      // ── F1 / F7 竞态：脚本 GET 之后、条件写之前，行被别人改过 ⇒ 服务端 409 ⇒ skipped-modified，不覆盖 ──
      await withStub([P1], async (stub) => {
        stub.hooks.beforePut = (id, b, st) => { if (id === 1) st.models.get(1).table_comment = '被抢先改了'; };
        const res = await sApply(stub, L1);
        const pr = res.rows.find(r => r.kind === 'parent');
        check('F1 竞态（table_comment）：GET 后、写前被别人改了 ⇒ 条件写 409 ⇒ parent skipped-modified，status partial，行里仍是别人的值（未覆盖）',
          pr && pr.state === 'skipped-modified' && res.status === 'partial' && stub.models.get(1).table_comment === '被抢先改了' && stub.models.get(1).impl_note === null && stub.puts === 1, J([res.rows, res.status, stub.models.get(1)]));
        check('F1 竞态：skipped-modified 行附服务端返回的 current（table_comment = 别人的值）', pr && pr.current && pr.current.table_comment === '被抢先改了', J(pr));
        check('F1 请求形态：专用接口 PUT /api/models/1/comment-split，body = { expected: { table_comment: 旧值, impl_note: null }, set: { table_comment: 短名, impl_note: 实现说明 }, parent_only: true, expected_config_rev: 写前 GET 的 config_rev（1）}',
          stub.putUrls[0] === '/api/models/1/comment-split' && J(stub.putBodies[0]) === J({ expected: { table_comment: A_OLD, impl_note: null }, set: { table_comment: A_NEW, impl_note: A_IMPL }, parent_only: true, expected_config_rev: 1 }), J([stub.putUrls, stub.putBodies]));
      });
      // S3：GET 之后、写之前父行被转成伴生行 ⇒ 父行写带 parent_only ⇒ 409 ⇒ skipped-modified，不写
      await withStub([P1], async (stub) => {
        stub.hooks.beforePut = (id, b, st) => { if (id === 1) st.models.get(1).companion_of = 55; };
        const res = await sApply(stub, L1);
        check('S3 父行写带 parent_only：GET 后父行被转成伴生行 ⇒ 409 ⇒ skipped-modified，行未被写，status partial',
          rowState(res, 'parent', 1) === 'skipped-modified' && stub.models.get(1).table_comment === A_OLD && stub.models.get(1).companion_of === 55 && res.status === 'partial' && stub.putBodies[0].parent_only === true && stub.putBodies[0].companion_of === undefined, J([res.rows, stub.models.get(1), stub.putBodies]));
      });
      await withStub([P1], async (stub) => {
        stub.hooks.beforePut = (id, b, st) => { if (id === 1) st.models.get(1).impl_note = '别人写的实现说明'; };
        const res = await sApply(stub, L1);
        check('F1 竞态（impl_note）：写前别人写了 impl_note ⇒ 409 ⇒ skipped-modified，别人的 impl_note 与原表注释都不被覆盖', rowState(res, 'parent', 1) === 'skipped-modified' && stub.models.get(1).impl_note === '别人写的实现说明' && stub.models.get(1).table_comment === A_OLD, J([res.rows, stub.models.get(1)]));
      });

      // ── F5 / F7 伴生时效：父行成功后重新取伴生集合；GET 到 404 → skipped-invalid；被改挂别的父表 → 409 skipped-modified；apply 开始后新出现的伴生行被覆盖到 ──
      await withStub([P1,
        { id: 2, table_name: 's_c2', table_comment: A_COMP_OLD, companion_of: 1 },
        { id: 4, table_name: 's_c4', table_comment: A_COMP_OLD, companion_of: 1 }], async (stub) => {
        stub.hooks.onGet = (id, st) => { if (id === 2 && st.puts >= 1) st.models.delete(2); };                       // 列表之后、GET 之前被删
        stub.hooks.afterApply = (id, st) => { if (id === 1) st.models.set(3, { id: 3, table_name: 's_c3', table_comment: A_COMP_OLD, impl_note: null, companion_of: 1, is_deleted: 0, config_rev: 1 }); };   // apply 开始后才出现的新伴生行
        stub.hooks.beforePut = (id, b, st) => { if (id === 4) st.models.get(4).companion_of = 99; };                  // GET 之后、写前被改挂到别的父表
        const res = await sApply(stub, L1);
        check('F5 父行 written；伴生 2（GET 时 404）= skipped-invalid 且不抛未处理异常', rowState(res, 'parent', 1) === 'written' && rowState(res, 'companion', 2) === 'skipped-invalid', J(res.rows.map(r => [r.kind, r.model_id, r.state, r.reason])));
        check('F5 父行写后才出现的新伴生行 3 被重新取得的集合覆盖到并写成「员工信息 - 变更追踪」', rowState(res, 'companion', 3) === 'written' && stub.models.get(3).table_comment === A_COMP_NEW, J([res.rows.map(r => [r.kind, r.model_id, r.state]), stub.models.get(3)]));
        const put3 = stub.putBodies.find((b, i) => stub.putUrls[i] === '/api/models/3/comment-split');
        check('F5 伴生行写入带 companion_of = 父 id（服务端同句复核伴生归属）', put3 && put3.companion_of === 1 && put3.expected.table_comment === A_COMP_OLD && put3.set.table_comment === A_COMP_NEW, J(put3));
        check('F5 伴生 4（写前被改挂到 99）条件写 409 ⇒ skipped-modified，行未被写（table_comment 仍是旧派生值、companion_of 仍是 99）', rowState(res, 'companion', 4) === 'skipped-modified' && stub.models.get(4).table_comment === A_COMP_OLD && stub.models.get(4).companion_of === 99, J([res.rows.map(r => [r.kind, r.model_id, r.state]), stub.models.get(4)]));
        check('F5 汇总：有跳过 ⇒ status partial，未完成清单 = 伴生 2 与 4', res.status === 'partial' && J(res.unfinished.map(u => u.model_id).sort()) === J([2, 4]), J([res.status, res.unfinished]));
      });

      // ── R2 / 24-R HIGH-1 反例：伴生行在 apply 后被改挂到另一父表、注释保持 new ⇒ revert 按回执里的原始归属条件写 ⇒ 409 ⇒ skipped-modified，不写 ──
      await withStub([P1, { id: 2, table_name: 's_c2', table_comment: A_COMP_OLD, companion_of: 1 }, { id: 9, table_name: 's_other_parent', table_comment: '另一个父表' }], async (stub) => {
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp });
        check('R2 前提：apply 写了父行 1 与伴生行 2（回执里伴生行 parent_id = 1、before.companion_of = 1）', rowState(res, 'parent', 1) === 'written' && rowState(res, 'companion', 2) === 'written' && stub.models.get(2).table_comment === A_COMP_NEW
          && (() => { const x = readJ(rcp).rows.find(r => r.kind === 'companion'); return x && x.parent_id === 1 && x.before.companion_of === 1; })(), J(res.rows.map(r => [r.kind, r.model_id, r.state])));
        stub.models.get(2).companion_of = 9;   // apply 之后伴生行被改挂到另一个父表，注释仍是 new 值
        const putsBefore = stub.puts;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        const body2 = stub.putBodies.slice(putsBefore).find((b, i) => stub.putUrls[putsBefore + i] === '/api/models/2/comment-split');
        check('R2 24-R HIGH-1 反例：伴生行改挂后 revert ⇒ 条件写带回执里的原始 companion_of（= 1）⇒ 409 ⇒ skipped-modified，该行零写入（注释仍为 new、仍挂在 9）',
          rowState(rv, 'revert', 2) === 'skipped-modified' && body2 && body2.companion_of === 1 && stub.models.get(2).table_comment === A_COMP_NEW && stub.models.get(2).companion_of === 9 && rv.status === 'partial', J([rv.rows.map(r => [r.model_id, r.state]), body2, stub.models.get(2)]));
        check('R2 同一次 revert 里父行 1 正常还原（写前归属 parent_only）', rowState(rv, 'revert', 1) === 'reverted' && stub.models.get(1).table_comment === A_OLD, J(rv.rows.map(r => [r.model_id, r.state])));
      });

      // ── F6 结果状态：全部完成 = applied；PUT 报 500 = failed（命令行退出码 1）──
      await withStub([P1], async (stub) => {
        const res = await sApply(stub, L1);
        check('F6 全部完成 ⇒ status applied，未完成清单为空', res.status === 'applied' && res.unfinished.length === 0 && rowState(res, 'parent', 1) === 'written', J([res.status, res.unfinished]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'error500';
        const res = await sApply(stub, L1);
        check('F6 条件写返回 500 ⇒ 行 error，status failed', res.status === 'failed' && res.errors.length === 1 && rowState(res, 'parent', 1) === 'error' && stub.models.get(1).table_comment === A_OLD, J([res.status, res.errors]));
        const cf = await cliAsync('--apply', '--list', writeList(L1), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_f');
        check('F6 命令行：failed 退出码 1，输出「结果: failed」', cf.status === 1 && /结果: failed/.test(cf.stdout || ''), `${cf.status} ${cf.stdout}`);
        const cf2 = await cliAsync('--apply', '--list', writeList(L1), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_f2', '--allow-skips');
        check('F6 命令行：failed 加 --allow-skips 仍退出码 1', cf2.status === 1, `${cf2.status} ${cf2.stdout}`);
      });

      // ── F4 超时 ──
      await withStub([P1], async (stub) => {
        stub.hangAll = true;
        const t0 = Date.now();
        await check_rejects('F4 永不响应的服务：apply 在 --timeout-ms 内超时报错退出', () => sApply(stub, L1, { timeoutMs: 300 }), /超时/);
        await check_rejects('F4 永不响应的服务：suggest 经 HTTP 取数也超时报错退出', () => runner.suggest({ baseUrl: stub.url, tokenFile, timeoutMs: 300 }), /超时/);
        check('F4 永不响应：总耗时远小于无限等待（< 8s），没有任何 PUT 到达，行未被写', Date.now() - t0 < 8000 && stub.puts === 0 && stub.models.get(1).table_comment === A_OLD, `${Date.now() - t0}ms puts=${stub.puts}`);
      });
      await withStub([P1], async (stub) => {
        stub.hangGetIds.add(1);   // 列表正常、单行 GET 永不响应
        const res = await sApply(stub, L1, { timeoutMs: 300 });
        check('F4 单行 GET 超时：行记 error（含「超时」）、停止、status failed、零 PUT', res.status === 'failed' && rowState(res, 'parent', 1) === 'error' && /超时/.test(res.errors.join('')) && stub.puts === 0, J([res.status, res.errors, stub.puts]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-no-reply';   // 服务端已提交但不回响应
        const res = await sApply(stub, L1, { timeoutMs: 300 });
        const pr = res.rows.find(r => r.kind === 'parent');
        check('F4 PUT 超时（服务端实际已提交）：不重试（恰 1 次 PUT），有界 GET 重读 = 目标值且 config_rev 未变 ⇒ done（推定已提交），报告列出该行', stub.puts === 1 && pr && pr.state === 'done' && pr.timed_out_put === true && stub.models.get(1).table_comment === A_NEW
          && res.timeouts.length === 1 && res.timeouts[0].outcome === 'done-presumed' && res.timeouts[0].model_id === 1, J([stub.puts, res.rows, res.timeouts]));
        check('F4 推定已提交的行不拉低整体结果（status applied）', res.status === 'applied', res.status);
      });
      // R3：PUT 超时后重读 = 目标值，但 config_rev 与写前不同（期间有别的写入）⇒ error 并停止，不能记 done
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        stub.putMode = () => 'commit-bump-rev-no-reply';
        const rcp = newReceipt();
        const res = await sApply(stub, [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }], { timeoutMs: 300, receipt: rcp });
        const pr = res.rows.find(r => r.kind === 'parent' && r.model_id === 1);
        check('R3 超时重读 = 目标值但 config_rev 变了 ⇒ 第一行 error（不是 done）、停止、第二行 not-processed、status failed、只发了 1 次 PUT、报告含 rev-changed',
          pr && pr.state === 'error' && /config_rev/.test(pr.error || '') && rowState(res, 'parent', 7) === 'not-processed' && res.status === 'failed' && stub.puts === 1 && res.timeouts.length === 1 && res.timeouts[0].outcome === 'rev-changed' && res.errors.length === 1, J([res.rows.map(r => [r.model_id, r.state]), res.status, res.timeouts, stub.puts]));
        check('R3 回执里该行记 error（写前值与目标值仍在，供人工核对）', (() => { const x = readJ(rcp).rows.find(r => r.model_id === 1); return x && x.state === 'error' && x.before && x.before.table_comment === A_OLD && x.target && x.target.table_comment === A_NEW; })(), J(readJ(rcp).rows));
      });
      // R3 revert 侧：同规则
      await withStub([P1], async (stub) => {
        const rcp = newReceipt();
        await sApply(stub, L1, { receipt: rcp });
        stub.putMode = () => 'commit-bump-rev-no-reply';
        const rv = await runner.revert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 300 });
        check('R3 revert 超时重读 = 回执 before 但 config_rev 变了 ⇒ error（不是 done / reverted）、status failed', rowState(rv, 'revert', 1) === 'error' && rv.status === 'failed' && rv.timeouts.length === 1 && rv.timeouts[0].outcome === 'rev-changed', J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.timeouts]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';   // 服务端没提交也不回响应
        const res = await sApply(stub, L1, { timeoutMs: 300, migrationId: 'mig_rerun' });
        check('F4 PUT 超时（未生效）：重读 = 旧值 ⇒ timeout-unknown-not-applied，status partial，行仍是旧值，报告列出', stub.puts === 1 && rowState(res, 'parent', 1) === 'timeout-unknown-not-applied' && res.status === 'partial' && stub.models.get(1).table_comment === A_OLD && res.timeouts.length === 1 && res.timeouts[0].outcome === 'not-applied', J([res.rows, res.status, res.timeouts]));
        stub.putMode = null;   // 服务恢复：同一 migration_id、新回执重跑可安全完成
        const res2 = await sApply(stub, L1, { timeoutMs: 300, migrationId: 'mig_rerun' });
        check('F4 timeout-unknown-not-applied 可安全重跑：新回执重跑 ⇒ written，status applied', rowState(res2, 'parent', 1) === 'written' && res2.status === 'applied' && stub.models.get(1).table_comment === A_NEW, J([res2.rows, res2.status]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'mutate-hang';   // 超时期间行被别人改成了另一个值
        const res = await sApply(stub, L1, { timeoutMs: 300 });
        check('F4 PUT 超时后重读既不是目标也不是旧值 ⇒ skipped-modified（并列入超时报告）', rowState(res, 'parent', 1) === 'skipped-modified' && res.timeouts.length === 1 && res.timeouts[0].outcome === 'modified' && res.status === 'partial', J([res.rows, res.timeouts]));
        // 复审 47A-H1 / 47C-HIGH：put_sent 为真的 skipped-modified 行（只可能来自超时后重读为第三个值）同样是「PUT 结果未知」（在途请求可能稍后才提交）
        check('F4 PUT 超时后重读为第三个值：行带 timed_out_put，汇总 inflight_unknown 为真（共用判定 putResultUnknown）', res.rows.find(r => r.kind === 'parent' && r.model_id === 1).timed_out_put === true && res.inflight_unknown === true, J([res.rows.map(r => [r.model_id, r.state, r.timed_out_put]), res.inflight_unknown]));
      });
      // 同一情形的命令行：partial 本可被 --allow-skips 豁免，但结果未知不可豁免——退出码仍为 1 且输出提示
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'mutate-hang';
        const HINT_RE = /有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原/;
        const cm = (extra) => cliAsync('--apply', '--list', writeList(L1), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_f4m', '--timeout-ms', '300', ...extra);
        const m1 = await cm([]);
        stub.models.get(1).table_comment = A_OLD;   // mutate-hang 把行改成了别的值：还原成写前原值，第二次运行才会再发 PUT
        const m2 = await cm(['--allow-skips']);
        check('F4 命令行：PUT 超时后重读为第三个值（skipped-modified + timed_out_put）⇒ 退出码 1、输出「结果: partial」与「有写请求结果未知」提示；加 --allow-skips 退出码仍为 1', m1.status === 1 && /结果: partial/.test(m1.stdout) && HINT_RE.test(m1.stdout) && m2.status === 1 && HINT_RE.test(m2.stdout), `${m1.status}/${m2.status} ${m1.stdout} ${m2.stdout}`);
      });
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        stub.hangGetAfterPut = true;   // 超时之后连重读 GET 也永不响应
        const res = await sApply(stub, [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }], { timeoutMs: 300 });
        check('S1 PUT 超时且重读也失败 ⇒ 第一行 timeout-unknown-reread-failed 并停止；status interrupted（不是 partial）；第二行以 not-processed 出现在 rows 与未完成清单',
          rowState(res, 'parent', 1) === 'timeout-unknown-reread-failed' && rowState(res, 'parent', 7) === 'not-processed' && res.status === 'interrupted' && stub.puts === 1
          && J(res.unfinished.map(u => [u.model_id, u.state])) === J([[1, 'timeout-unknown-reread-failed'], [7, 'not-processed']]), J([res.rows.map(r => [r.model_id, r.state]), res.status, res.unfinished, stub.puts]));
        // S1 命令行：interrupted 退出码非 0，且 --allow-skips 不豁免
        const cliA = (extra) => {
          const lf = writeList([...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }]);
          return cliAsync('--apply', '--list', lf, '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_i', '--timeout-ms', '300', ...extra);
        };
        stub.puts = 0;
        const ci1 = await cliA([]);
        stub.puts = 0;   // 重置：hangGetAfterPut 以 puts > 0 为界，第二次运行也要从「第一次 PUT 之前」开始
        const ci2 = await cliA(['--allow-skips']);
        check('S1 命令行：interrupted 退出码非 0，输出「结果: interrupted」，未完成清单含 not-processed 行；加 --allow-skips 退出码仍非 0', ci1.status === 1 && /结果: interrupted/.test(ci1.stdout) && /"state":"not-processed"/.test(ci1.stdout) && ci2.status === 1 && /结果: interrupted/.test(ci2.stdout), `${ci1.status}/${ci2.status} ${ci1.stdout}`);
      });
      await check_rejects('F4 --timeout-ms 非正整数被拒（先于任何读写，回执不被创建）', () => runner.apply({ list: writeList(L1), baseUrl: 'http://127.0.0.1:1', tokenFile, receipt: path.join(runDir, 'receipts', 'never2.json'), migrationId: 'mig_to', timeoutMs: 'abc' }), /--timeout-ms 必须是正整数/);
      check('F4 --timeout-ms 非法时回执未被创建', !fs.existsSync(path.join(runDir, 'receipts', 'never2.json')), '被创建');

      // ── M12（末次合并审）：清单校验与回执校验同口径——model_id 正整数、old_table_comment 去首尾空白后非空；任何写入之前整体拒绝（零请求：一个合法行混进一个非法行，合法行也不能先写）──
      await withStub([P1], async (stub) => {
        const good = L1[0];
        const mixes = [
          ['model_id = 0', { model_id: 0, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }, /model_id 必须是正整数/],
          ['model_id 为负数', { model_id: -3, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }, /model_id 必须是正整数/],
          ['old_table_comment 只有空白', { model_id: 7, old_table_comment: '  \t ', new_table_comment: '第二行短名', new_impl_note: null }, /old_table_comment 必须是去掉首尾空白后非空/],
        ];
        for (const [label, bad, re] of mixes) {
          const rcp = path.join(runDir, 'receipts', `m12-${label.replace(/\W+/g, '_')}-${Date.now()}.json`);
          await check_rejects(`M12 清单混入「${label}」的行：整份拒绝（合法行在前也不先写）`, () => sApply(stub, [good, bad], { receipt: rcp }), re);
          check(`M12 清单混入「${label}」被拒之后：零请求（GET 0 次、PUT 0 次）、桩里模型 1 的表注释不变、回执未创建`, stub.getUrls.length === 0 && stub.puts === 0 && stub.models.get(1).table_comment === A_OLD && !fs.existsSync(rcp), J([stub.getUrls, stub.puts]));
        }
        // 对照：只有合法行的清单照常写入（校验没有过严）
        const okRes = await sApply(stub, [good], {});
        check('M12 对照：合法清单照常写入（桩里模型 1 已是新值）', okRes.status === 'applied' && stub.models.get(1).table_comment === A_NEW, J([okRes.status, stub.models.get(1).table_comment]));
      });

      // ── R5 中途崩溃：第二行写的途中进程被杀 ⇒ 回执仍是合法 JSON（第一行 written、第二行 writing），revert 能据此还原 ──
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        const rcp = newReceipt();
        const L2 = [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }];
        let killer = null;
        stub.putMode = () => { if (stub.puts === 2 && killer) { killer.kill('SIGKILL'); return 'hang-no-apply'; } return 'normal'; };
        const sp = spawnScript(['--apply', '--list', writeList(L2), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', rcp, '--migration-id', 'mig_crash', '--timeout-ms', '8000']);
        killer = sp.child;
        const out = await sp.done;
        let parsed = null; try { parsed = readJ(rcp); } catch (_) { /* 断言里报 */ }
        check('R5 中途崩溃：进程被杀（非正常退出）后回执仍是合法 JSON，status = running、finished_at 为空', out.status !== 0 && parsed && parsed.status === 'running' && parsed.finished_at === null && parsed.format === 'mc77-table-comment-receipt-v2', `${out.status} ${out.signal} ${J(parsed)}`);
        const r1 = parsed && parsed.rows.find(r => r.model_id === 1), r7 = parsed && parsed.rows.find(r => r.model_id === 7);
        check('R5 中途崩溃：第一行 written（before / target 齐全），第二行以 writing 留痕（写前值与目标值已记入，崩溃时不确定是否提交）', r1 && r1.state === 'written' && r1.before.table_comment === A_OLD && r1.target.table_comment === A_NEW && r7 && r7.state === 'writing' && r7.before.table_comment === C_OLD && r7.target.table_comment === '第二行短名', J(parsed && parsed.rows));
        check('R5 中途崩溃：桩里第一行已提交、第二行未提交', stub.models.get(1).table_comment === A_NEW && stub.models.get(7).table_comment === C_OLD, J([stub.models.get(1).table_comment, stub.models.get(7).table_comment]));
        const putsBeforeRv = stub.puts;
        const getsBeforeRv = stub.getUrls.length;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        // 复审 48 sol-H（整批确认）：writing 行（put_sent 为真）= PUT 发出后进程被杀，服务端的在途请求可能稍后才提交——revert 在任何请求之前扫描来源回执，有这样的行就整次拒绝、零写入
        //   （旧口径：第一行照常还原为 reverted、writing 行逐行标 uncertain、status partial、PUT 总数 3）
        check('R5 中途崩溃后 revert（整批确认）：writing 行（第 7 行）⇒ blocked-inflight，其余行（第 1 行，本可还原）⇒ not-processed；零写入（PUT 总数仍是 apply 的 2 次，第 1 行仍是新值）、零请求（无任何 GET）；status blocked-inflight，inflight_unknown 为真；未完成清单 = [7 blocked-inflight, 1 not-processed]，触发行带来源状态 writing 与来源回执名',
          rowState(rv, 'revert', 7) === 'blocked-inflight' && rowState(rv, 'revert', 1) === 'not-processed' && rv.status === 'blocked-inflight' && rv.inflight_unknown === true
          && stub.puts === putsBeforeRv && putsBeforeRv === 2 && stub.getUrls.length === getsBeforeRv && stub.models.get(1).table_comment === A_NEW && stub.models.get(7).table_comment === C_OLD
          && J(rv.unfinished.map(u => [u.model_id, u.state])) === J([[7, 'blocked-inflight'], [1, 'not-processed']])
          && rv.unfinished[0].source_state === 'writing' && rv.unfinished[0].source_receipt === path.basename(rcp), J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.inflight_unknown, rv.unfinished, putsBeforeRv, stub.puts]));
        const rv2 = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('R5 中途崩溃后确认在途请求已终止（inflightCleared）重跑 ⇒ 整批照常：第 7 行当前值 = 写前原值 ⇒ done（零写入，reason 注明已确认），第 1 行当前值 = target ⇒ reverted；status reverted，inflight_unknown 为假，PUT 总数 3',
          rowState(rv2, 'revert', 7) === 'done' && /操作员已确认在途请求已终止/.test((rv2.rows.find(r => r.model_id === 7) || {}).reason || '') && rowState(rv2, 'revert', 1) === 'reverted' && rv2.status === 'reverted' && rv2.inflight_unknown === false
          && stub.models.get(1).table_comment === A_OLD && stub.models.get(7).table_comment === C_OLD && stub.puts === 3, J([rv2.rows.map(r => [r.model_id, r.state]), rv2.status, rv2.inflight_unknown, stub.puts]));
        // 命令行：同一回执不带 --inflight-cleared ⇒ 退出码 1（--allow-skips 也不豁免）并输出提示（此时库里两行都已是写前原值：整批拒绝与当前值无关）
        const HINT_RE_R5 = /有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原/;
        const cr5 = await cliAsync('--revert', '--receipt', rcp, '--revert-receipt', newReceipt(), '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--allow-skips');
        check('R5 中途崩溃回执 命令行 revert：writing 行 ⇒ 整批拒绝，退出码 1（加 --allow-skips 也不豁免）、输出「结果: blocked-inflight」与提示', cr5.status === 1 && /结果: blocked-inflight/.test(cr5.stdout) && HINT_RE_R5.test(cr5.stdout), `${cr5.status} ${cr5.stdout}`);
      });
      // ═══════════════ 预筛后修复：P1 put_sent / P2 回执链 / P3 写了未记 / P4 rename 重试 ═══════════════
      // P1 场景 A：PUT 已提交（200）但写后 GET 超时 ⇒ apply 记 error；revert 须还原（回执行 put_sent = true）
      await withStub([P1], async (stub) => {
        stub.hangGetAfterPut = true;
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        const x = readJ(rcp).rows.find(r => r.model_id === 1);
        check('P1 场景 A 前提：PUT 已提交、写后 GET 超时 ⇒ apply 行 error、桩里已是新值，回执该行 state = error 且 put_sent = true', rowState(res, 'parent', 1) === 'error' && stub.models.get(1).table_comment === A_NEW && x && x.state === 'error' && x.put_sent === true && x.before.table_comment === A_OLD && x.target.table_comment === A_NEW, J([res.rows.map(r => [r.model_id, r.state]), x]));
        stub.hangGetAfterPut = false;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P1 场景 A：revert 处理 put_sent 的 error 行 ⇒ 当前值 = target ⇒ 条件写还原 ⇒ 库回到旧值，状态 reverted', rowState(rv, 'revert', 1) === 'reverted' && rv.status === 'reverted' && stub.models.get(1).table_comment === A_OLD && stub.models.get(1).impl_note === null, J([rv.rows.map(r => [r.model_id, r.state]), rv.status, stub.models.get(1)]));
      });
      // P1 场景 B：PUT 已提交但不回响应、重读也超时 ⇒ timeout-unknown-reread-failed；revert 须还原
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-no-reply';
        stub.hangGetAfterPut = true;
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        check('P1 场景 B 前提：PUT 已提交不回响应、重读也超时 ⇒ timeout-unknown-reread-failed、桩里已是新值', rowState(res, 'parent', 1) === 'timeout-unknown-reread-failed' && stub.models.get(1).table_comment === A_NEW && readJ(rcp).rows.find(r => r.model_id === 1).put_sent === true, J(res.rows.map(r => [r.model_id, r.state])));
        stub.hangGetAfterPut = false; stub.putMode = null;
        // 复审 48（整批确认）：timeout-unknown-reread-failed 是结果未知——不带 inflightCleared 的 revert 整次拒绝、零写入（旧断言：直接还原）；确认在途请求已终止后带 inflightCleared 才还原
        const rvBlocked = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P1 场景 B：revert（不带 inflightCleared）⇒ 整次拒绝 blocked-inflight，零写入（PUT 仍只有 apply 的 1 次，行仍是新值）', rowState(rvBlocked, 'revert', 1) === 'blocked-inflight' && rvBlocked.status === 'blocked-inflight' && stub.puts === 1 && stub.models.get(1).table_comment === A_NEW, J([rvBlocked.rows.map(r => [r.model_id, r.state]), rvBlocked.status, stub.puts]));
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('P1 场景 B：确认在途请求已终止（inflightCleared）后 revert 还原 ⇒ 库回到旧值，状态 reverted',rowState(rv, 'revert', 1) === 'reverted' && rv.status === 'reverted' && stub.models.get(1).table_comment === A_OLD, J([rv.rows.map(r => [r.model_id, r.state]), stub.models.get(1)]));
      });
      // P1：timeout-unknown-not-applied（没提交）⇒ revert 当前值 = before ⇒ done；rev-changed（已提交 + config_rev 变）⇒ revert 仍还原
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        // H6（末次合并审；复审 48 整批确认）：这行的 PUT 曾超时——在途请求可能稍后才提交，当前值虽是写前原值也不能记 done，更不能逐行放行：整次拒绝、零写入，需确认服务已重启后带 inflightCleared 重跑
        //   （旧口径：该行逐行标 uncertain、status partial、未完成清单 [[1, 'uncertain']]）
        check('H6② timeout-unknown-not-applied 行：revert 当前值 = before、但 PUT 曾超时 ⇒ 整次拒绝（blocked-inflight，零写入：PUT 仍只有 apply 的 1 次），inflight_unknown 为真，进未完成清单（带来源状态 timeout-unknown-not-applied）',
          rowState(res, 'parent', 1) === 'timeout-unknown-not-applied' && rowState(rv, 'revert', 1) === 'blocked-inflight' && rv.status === 'blocked-inflight' && rv.inflight_unknown === true && stub.models.get(1).table_comment === A_OLD && stub.puts === 1
          && J(rv.unfinished.map(u => [u.model_id, u.state, u.source_state])) === J([[1, 'blocked-inflight', 'timeout-unknown-not-applied']]), J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.unfinished, stub.puts]));
        check('H6① apply 出现 timeout-unknown* 行：结果带 inflight_unknown = true', res.inflight_unknown === true, J(res.inflight_unknown));
        const rv2 = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('H6② 确认在途请求已终止后带 inflightCleared 重跑 ⇒ done（零写入，reason 注明已确认），status reverted，inflight_unknown 为假', rowState(rv2, 'revert', 1) === 'done' && /操作员已确认在途请求已终止/.test(rv2.rows[0].reason || '') && rv2.status === 'reverted' && rv2.inflight_unknown === false && stub.models.get(1).table_comment === A_OLD && stub.puts === 1, J([rv2.rows.map(r => [r.model_id, r.state]), rv2.status, stub.puts]));
        // 命令行：revert 无 --inflight-cleared 退出码 1（--allow-skips 也不豁免）并输出提示；带 --inflight-cleared 退出码 0
        const HINT_RE = /有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原/;
        const cr1 = await cliAsync('--revert', '--receipt', rcp, '--revert-receipt', newReceipt(), '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--allow-skips');
        const cr2 = await cliAsync('--revert', '--receipt', rcp, '--revert-receipt', newReceipt(), '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--inflight-cleared');
        check('H6② 命令行 revert：整批拒绝退出码 1（加 --allow-skips 也不豁免）、输出「结果: blocked-inflight」与提示；带 --inflight-cleared 退出码 0', cr1.status === 1 && /结果: blocked-inflight/.test(cr1.stdout) && HINT_RE.test(cr1.stdout) && cr2.status === 0 && /结果: reverted/.test(cr2.stdout) && !HINT_RE.test(cr2.stdout), `${cr1.status}/${cr2.status} ${cr1.stdout} ${cr2.stdout}`);
        await check_rejects('H6② apply 传 inflightCleared 被拒（仅 --revert）', () => sApply(stub, L1, { inflightCleared: true }), /--inflight-cleared 只用于 --revert/);
      });
      // H6①：apply 命令行——PUT 超时（未生效）⇒ 输出明确提示，退出码非 0，--allow-skips 也不豁免；推定已提交（done-presumed，当前值 = 目标值）不触发
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        const HINT_RE = /有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原/;
        const ca = (extra) => cliAsync('--apply', '--list', writeList(L1), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_h6', '--timeout-ms', '300', ...extra);
        const c1 = await ca([]);
        const c2 = await ca(['--allow-skips']);
        check('H6① apply 命令行：PUT 超时（未生效）⇒ 输出「有写请求结果未知：先重启服务…再重跑或还原」，退出码 1；加 --allow-skips 退出码仍为 1（结果未知不可豁免）', c1.status === 1 && HINT_RE.test(c1.stdout) && c2.status === 1 && HINT_RE.test(c2.stdout), `${c1.status}/${c2.status} ${c1.stdout}`);
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-no-reply';
        const res = await sApply(stub, L1, { timeoutMs: 300 });
        check('H6① 对照：PUT 超时但重读 = 目标值（推定已提交，行 done）不算结果未知——inflight_unknown 为假、status applied', rowState(res, 'parent', 1) === 'done' && res.inflight_unknown === false && res.status === 'applied', J([res.rows.map(r => [r.model_id, r.state]), res.inflight_unknown, res.status]));
      });
      // H6②（第二种情形）：timeout-unknown-reread-failed（PUT 超时、重读也失败）——服务随后恢复、值仍是写前原值 ⇒ revert 同样整次拒绝（blocked-inflight），带 inflightCleared 才记 done
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        stub.hangGetAfterPut = true;
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.hangGetAfterPut = false; stub.putMode = null;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        const rv2 = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('H6② timeout-unknown-reread-failed 行：revert 当前值 = before ⇒ 整次拒绝（blocked-inflight）；带 inflightCleared 重跑 ⇒ done；全程只有 apply 那 1 次 PUT',
          rowState(res, 'parent', 1) === 'timeout-unknown-reread-failed' && res.inflight_unknown === true && rowState(rv, 'revert', 1) === 'blocked-inflight' && rv.status === 'blocked-inflight' && rowState(rv2, 'revert', 1) === 'done' && rv2.status === 'reverted' && stub.puts === 1 && stub.models.get(1).table_comment === A_OLD,
          J([res.rows.map(r => [r.model_id, r.state]), rv.rows.map(r => [r.model_id, r.state]), rv2.rows.map(r => [r.model_id, r.state]), stub.puts]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-bump-rev-no-reply';
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P1 / X1 rev-changed 行（apply 记 error，期间 config_rev 被别的写入递增到 2）：revert 带 expected_config_rev = 写前版本 1 ⇒ 409 ⇒ skipped-modified、零写入（值仍是新值，不盲目覆盖别的写入之后的行），status partial',
          rowState(res, 'parent', 1) === 'error' && rowState(rv, 'revert', 1) === 'skipped-modified' && rv.status === 'partial' && stub.models.get(1).table_comment === A_NEW && stub.models.get(1).config_rev === 2 && stub.puts === 2 && stub.putBodies[1].expected_config_rev === 1, J([res.rows.map(r => [r.model_id, r.state]), rv.rows.map(r => [r.model_id, r.state]), stub.putBodies]));
      });
      // 收口批 2 LOW-4：revert 的整批门槛只认结果仍未知的行（共用判定 putResultUnknown：timeout-unknown*；put_sent 为真且 state 为 skipped-modified——不依赖 timed_out_put，旧回执同样成立；put_sent 为真且 state 为 writing）。
      //   done-presumed（重读已证实目标值落库）与 rev-changed（重读已证实目标值落库、期间 config_rev 变过）的结果是已知的：上一轮 revert 已把这些行还原、因别的行出错中断后重跑时，
      //   当前值 = 写前原值，不会被无谓地整次拒绝（旧口径：timed_out_put 为真就标，退出码 1 且提示「先重启服务」）。
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-no-reply';
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        const rv1 = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        const rv2 = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('LOW-4 对照 done-presumed 行（apply 推定已提交、timed_out_put 为真）：第一次 revert 还原；重跑时当前值 = 写前原值 ⇒ done（不整次拒绝），status reverted，inflight_unknown 为假，零写入',
          rowState(res, 'parent', 1) === 'done' && readJ(rcp).rows.find(r => r.model_id === 1).timed_out_put === true && rowState(rv1, 'revert', 1) === 'reverted' && rowState(rv2, 'revert', 1) === 'done' && rv2.status === 'reverted' && rv2.inflight_unknown === false && stub.puts === 2 && stub.models.get(1).table_comment === A_OLD,
          J([res.rows.map(r => [r.model_id, r.state]), rv1.rows.map(r => [r.model_id, r.state]), rv2.rows.map(r => [r.model_id, r.state]), rv2.status, rv2.inflight_unknown, stub.puts]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-bump-rev-no-reply';
        const rcp = newReceipt();
        const res = await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        stub.models.get(1).table_comment = A_OLD; stub.models.get(1).impl_note = null;   // 模拟别处已把这行改回写前原值（apply 记 error 的 rev-changed 行，重读已证实目标值曾落库）
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('LOW-4 对照 rev-changed 行（apply 记 error、timed_out_put 为真，目标值已落库）：当前值 = 写前原值 ⇒ done（不整次拒绝），inflight_unknown 为假，零写入',
          rowState(res, 'parent', 1) === 'error' && readJ(rcp).rows.find(r => r.model_id === 1).timed_out_put === true && rowState(rv, 'revert', 1) === 'done' && rv.inflight_unknown === false && stub.puts === 1,
          J([res.rows.map(r => [r.model_id, r.state]), rv.rows.map(r => [r.model_id, r.state]), rv.inflight_unknown, stub.puts]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        const rcp = newReceipt();
        await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        const j = readJ(rcp); const row = j.rows.find(r => r.model_id === 1);
        row.state = 'skipped-modified';   // 超时后重读既不等于目标也不等于旧值的行形态（回执里 put_sent / timed_out_put 照旧为真）
        const f = newReceipt(); fs.writeFileSync(f, J(j));
        const rv = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('LOW-4 skipped-modified + timed_out_put 为真的行：仍是结果未知 ⇒ revert 整次拒绝（blocked-inflight，旧口径：逐行 uncertain），inflight_unknown 为真，零写入',
          row.timed_out_put === true && row.put_sent === true && rowState(rv, 'revert', 1) === 'blocked-inflight' && rv.status === 'blocked-inflight' && rv.inflight_unknown === true && stub.puts === 1,
          J([rv.rows.map(r => [r.model_id, r.state]), rv.inflight_unknown, stub.puts, row]));
      });
      // 复审口径调整：判定不依赖 timed_out_put 字段——旧格式回执（skipped-modified + put_sent 为真，没有 timed_out_put 字段）同样整次拒绝（blocked-inflight）
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        const rcp = newReceipt();
        await sApply(stub, L1, { receipt: rcp, timeoutMs: 300 });
        stub.putMode = null;
        const j = readJ(rcp); const row = j.rows.find(r => r.model_id === 1);
        row.state = 'skipped-modified';
        delete row.timed_out_put;   // 旧格式回执：没有 timed_out_put 字段
        const f = newReceipt(); fs.writeFileSync(f, J(j));
        const rv = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        const rv2 = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('旧格式回执（skipped-modified + put_sent 为真、无 timed_out_put 字段）：revert ⇒ 整次拒绝（blocked-inflight），inflight_unknown 为真，零写入；带 inflightCleared 重跑 ⇒ done',
          !('timed_out_put' in row) && row.put_sent === true && rowState(rv, 'revert', 1) === 'blocked-inflight' && rv.status === 'blocked-inflight' && rv.inflight_unknown === true && rowState(rv2, 'revert', 1) === 'done' && rv2.status === 'reverted' && stub.puts === 1,
          J([rv.rows.map(r => [r.model_id, r.state]), rv.inflight_unknown, rv2.rows.map(r => [r.model_id, r.state]), stub.puts, row]));
      });

      // ═══════════════ 复审 48 sol-H：revert 整批确认矩阵（用户裁定修法）═══════════════
      // 来源回执里一行（模型 1，回执第一行）结果未知，其余行（模型 7，回执第二行 = 逆序处理时先于模型 1 被处理的可还原行）正常；
      // 三种未知形态 × 五种当前值（= target / = 写前原值且归属正常 / = 写前原值但已删除 / = 写前原值但已改挂 / 第三个值）。
      // 无 --inflight-cleared：一律零 PUT、零请求（门槛在读当前值的 GET 之前）、库不变、status blocked-inflight、inflight_unknown 为真；命令行退出码 1，加 --allow-skips 仍为 1；revert 回执照常写出并记录这次被拒。
      // 带 --inflight-cleared：整批照常——当前值 = target ⇒ reverted；= 写前原值且归属正常 ⇒ done（注明已确认）；已删除 / 改挂 / 第三个值 ⇒ skipped-modified。
      // 「第一行可还原、第二行未知」：处理顺序是回执行逆序，模型 7（可还原）先于模型 1（未知）——门槛若放在第一次写之后，模型 7 会先被写，零 PUT 断言即判红。
      {
        const L2m = [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }];
        const HINT_M = /有写请求结果未知：先重启服务（确保在途请求终止）再重跑或还原/;
        const forms = [
          ['timeout-unknown*（timeout-unknown-not-applied）', 'timeout-unknown-not-applied'],
          ['put_sent + skipped-modified', 'skipped-modified'],
          ['put_sent + writing', 'writing'],
        ];
        const curStates = [
          ['= target', () => {}, 'reverted', 'reverted', 4],
          ['= 写前原值且归属正常', (m) => { m.table_comment = A_OLD; m.impl_note = null; }, 'done', 'reverted', 3],
          ['= 写前原值但已删除', (m) => { m.table_comment = A_OLD; m.impl_note = null; m.is_deleted = 1; }, 'skipped-modified', 'partial', 3],
          ['= 写前原值但已改挂', (m) => { m.table_comment = A_OLD; m.impl_note = null; m.companion_of = 7; }, 'skipped-modified', 'partial', 3],
          ['第三个值', (m) => { m.table_comment = '第三个值'; m.impl_note = null; }, 'skipped-modified', 'partial', 3],
        ];
        for (const [fName, fState] of forms) for (const [sName, sMut, wantState, wantStatus, wantPuts] of curStates) {
          await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
            const rcp = newReceipt();
            await sApply(stub, L2m, { receipt: rcp });
            const j = readJ(rcp); j.rows.find(r => r.model_id === 1).state = fState;
            const f = newReceipt(); fs.writeFileSync(f, J(j));
            sMut(stub.models.get(1));
            const snap = J([...stub.models.values()]); const puts0 = stub.puts, gets0 = stub.getUrls.length, reqs0 = stub.reqs.length;
            const tag = `整批确认「${fName}」× 当前值${sName}`;
            const rv = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
            check(`${tag}：无 --inflight-cleared ⇒ 零 PUT、零请求（含 GET）、库不变；status blocked-inflight，inflight_unknown 为真；行 1 blocked-inflight（带来源状态与来源回执），行 7 not-processed`,
              puts0 === 2 && stub.puts === puts0 && stub.getUrls.length === gets0 && stub.reqs.length === reqs0 && J([...stub.models.values()]) === snap && rv.status === 'blocked-inflight' && rv.inflight_unknown === true
              && rowState(rv, 'revert', 1) === 'blocked-inflight' && rowState(rv, 'revert', 7) === 'not-processed'
              && J(rv.unfinished.map(u => [u.model_id, u.state])) === J([[7, 'not-processed'], [1, 'blocked-inflight']]) && rv.unfinished.find(u => u.model_id === 1).source_state === fState && rv.unfinished.find(u => u.model_id === 1).source_receipt === path.basename(f),
              J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.inflight_unknown, rv.unfinished, stub.puts, stub.getUrls.length - gets0]));
            const rrA = newReceipt(), rrB = newReceipt();
            const cA = await cliAsync('--revert', '--receipt', f, '--revert-receipt', rrA, '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400');
            const cB = await cliAsync('--revert', '--receipt', f, '--revert-receipt', rrB, '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--allow-skips');
            const rcB = readJ(rrB);
            check(`${tag}：命令行退出码 1，加 --allow-skips 仍为 1；输出「结果: blocked-inflight」与提示；零 PUT；revert 回执照常写出（format 正确、status blocked-inflight、finished_at 非空、触发行记 source_state / source_receipt）`,
              cA.status === 1 && cB.status === 1 && /结果: blocked-inflight/.test(cA.stdout) && /结果: blocked-inflight/.test(cB.stdout) && HINT_M.test(cB.stdout) && stub.puts === puts0
              && rcB.format === 'mc77-table-comment-revert-receipt-v1' && rcB.status === 'blocked-inflight' && !!rcB.finished_at && rcB.rows.find(r => r.model_id === 1).state === 'blocked-inflight' && rcB.rows.find(r => r.model_id === 1).source_state === fState,
              `${cA.status}/${cB.status} ${cB.stdout} ${J(rcB)}`);
            const rvc = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
            check(`${tag}：带 --inflight-cleared ⇒ 整批照常：行 1 ${wantState}、行 7 reverted，status ${wantStatus}，inflight_unknown 为假，PUT 总数 ${wantPuts}`,
              rowState(rvc, 'revert', 1) === wantState && rowState(rvc, 'revert', 7) === 'reverted' && rvc.status === wantStatus && rvc.inflight_unknown === false && stub.puts === wantPuts
              && (wantState !== 'done' || /操作员已确认在途请求已终止/.test((rvc.rows.find(r => r.model_id === 1) || {}).reason || '')),
              J([rvc.rows.map(r => [r.model_id, r.state]), rvc.status, rvc.inflight_unknown, stub.puts]));
          });
        }
        // 干跑：同样报告「会被拒绝」（outcome blocked-inflight，status 保持 dry-run）并输出提示；零请求、不创建回执；退出码按干跑既有约定（只看 errors）= 0；带 --inflight-cleared 的干跑不报拒绝
        await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
          const rcp = newReceipt();
          await sApply(stub, L2m, { receipt: rcp });
          const j = readJ(rcp); j.rows.find(r => r.model_id === 1).state = 'writing';
          const f = newReceipt(); fs.writeFileSync(f, J(j));
          const reqs0 = stub.reqs.length, puts0 = stub.puts;
          // P57⑥（codex 49C LOW）：「不创建回执」要比较回执目录的文件清单（文件名 + 内容哈希），不只查某个文件名——干跑若写出任何新文件（revert 回执 / 临时文件）都应判红；覆盖接口调用、命令行、带 --inflight-cleared 的干跑三种
          const dirSnap = () => J(fs.readdirSync(receiptDir).sort().map(n => [n, sha(path.join(receiptDir, n))]));
          const ls0 = dirSnap();
          const dr = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, dryRun: true, timeoutMs: 400 });
          const lsApi = dirSnap();
          const cd = await cliAsync('--revert', '--receipt', f, '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--dry-run');
          const lsCli = dirSnap();
          const reqsAfterBlockedDry = stub.reqs.length;   // 被拒的两次干跑之后到达桩的请求总数（必须仍是 reqs0）；下一次带 --inflight-cleared 的干跑会正常发只读 GET
          const dc = await safeRevert({ receipt: f, baseUrl: stub.url, tokenFile, dryRun: true, timeoutMs: 400, inflightCleared: true });
          const lsCleared = dirSnap();
          check('P57⑥ 整批确认干跑 不写回执：接口调用 / 命令行 / 带 --inflight-cleared 的干跑，前后回执目录文件清单（文件名 + 内容哈希）逐次完全相同，且没有 .tmp 残留',
            lsApi === ls0 && lsCli === ls0 && lsCleared === ls0 && fs.readdirSync(receiptDir).every(n => !/\.tmp-/.test(n)), J([ls0 === lsApi, ls0 === lsCli, ls0 === lsCleared, fs.readdirSync(receiptDir)]));
          check('整批确认 干跑：status 保持 dry-run、outcome blocked-inflight、inflight_unknown 为真、行 1 blocked-inflight；零 PUT；命令行干跑输出「结果: blocked-inflight（干跑）」与提示，退出码 0（干跑既有约定）；带 --inflight-cleared 的干跑 outcome 不是 blocked-inflight',
            dr.status === 'dry-run' && dr.outcome === 'blocked-inflight' && dr.inflight_unknown === true && rowState(dr, 'revert', 1) === 'blocked-inflight' && stub.puts === puts0 && reqsAfterBlockedDry === reqs0
            && cd.status === 0 && /结果: blocked-inflight（干跑）/.test(cd.stdout) && HINT_M.test(cd.stdout) && dc.outcome !== 'blocked-inflight' && dc.inflight_unknown === false,
            J([dr.status, dr.outcome, dr.inflight_unknown, dr.rows.map(r => [r.model_id, r.state]), `${cd.status} ${cd.stdout}`, dc.outcome]));
        });
        // 两份回执链：一份正常、一份有未知行 ⇒ 同样整批拒绝（未知行在较旧一份 / 较新一份各一例；门槛只看第一份回执会漏掉较旧一例）
        await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
          const r1 = newReceipt(), r2 = newReceipt();
          await sApply(stub, L1, { receipt: r1 });          // 较旧：模型 1 written
          await settle(20);
          await sApply(stub, L2m, { receipt: r2 });         // 较新：模型 1 already-target、模型 7 written（正常）
          const j = readJ(r1); j.rows.find(r => r.model_id === 1).state = 'writing';
          const f1 = newReceipt(); fs.writeFileSync(f1, J(j));   // 较旧一份的模型 1 变成 writing（未知）
          const puts0 = stub.puts, reqs0 = stub.reqs.length, snap = J([...stub.models.values()]);
          const rv = await safeRevert({ receipt: [f1, r2], baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
          check('整批确认 两份回执链（较旧一份有未知行 = 模型 1 writing，较新一份正常）⇒ 整批拒绝：零 PUT、零请求、库不变；触发行出自较旧回执，模型 7（较新回执的正常行）not-processed',
            rv.status === 'blocked-inflight' && rv.inflight_unknown === true && stub.puts === puts0 && stub.reqs.length === reqs0 && J([...stub.models.values()]) === snap
            && rowState(rv, 'revert', 1) === 'blocked-inflight' && rowState(rv, 'revert', 7) === 'not-processed' && rv.unfinished.find(u => u.model_id === 1).source_receipt === path.basename(f1),
            J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.unfinished, stub.puts]));
          const cli2 = await cliAsync('--revert', '--receipt', f1, '--receipt', r2, '--revert-receipt', newReceipt(), '--base-url', stub.url, '--token-file', tokenFile, '--timeout-ms', '400', '--allow-skips');
          check('整批确认 两份回执链 命令行：退出码 1（--allow-skips 不豁免），输出「结果: blocked-inflight」', cli2.status === 1 && /结果: blocked-inflight/.test(cli2.stdout) && stub.puts === puts0, `${cli2.status} ${cli2.stdout}`);
          const rvOk = await safeRevert({ receipt: [f1, r2], baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
          check('整批确认 两份回执链 带 --inflight-cleared ⇒ 照常处理：模型 7 与模型 1 都回到最早的 before，status reverted',
            rvOk.status === 'reverted' && stub.models.get(1).table_comment === A_OLD && stub.models.get(7).table_comment === C_OLD && rvOk.inflight_unknown === false, J([rvOk.rows.map(r => [r.model_id, r.state]), rvOk.status, stub.models.get(1).table_comment, stub.models.get(7).table_comment]));
        });
        await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
          const r1 = newReceipt(), r2 = newReceipt();
          await sApply(stub, L1, { receipt: r1 });
          await settle(20);
          await sApply(stub, L2m, { receipt: r2 });
          const j = readJ(r2); j.rows.find(r => r.model_id === 7).state = 'timeout-unknown-reread-failed';
          const f2 = newReceipt(); fs.writeFileSync(f2, J(j));   // 较新一份的模型 7 变成未知
          const puts0 = stub.puts, reqs0 = stub.reqs.length;
          const rv = await safeRevert({ receipt: [r1, f2], baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
          check('整批确认 两份回执链（较新一份有未知行 = 模型 7 timeout-unknown-reread-failed，较旧一份正常）⇒ 整批拒绝：零 PUT、零请求；模型 1（较旧回执的正常行）not-processed',
            rv.status === 'blocked-inflight' && stub.puts === puts0 && stub.reqs.length === reqs0 && rowState(rv, 'revert', 7) === 'blocked-inflight' && rowState(rv, 'revert', 1) === 'not-processed' && rv.unfinished.find(u => u.model_id === 7).source_receipt === path.basename(f2),
            J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.unfinished, stub.puts]));
        });
      }

      // P2 预筛 C：第一次 written + error、第二次（新回执）already-target + written ⇒ 只给第二份回执 revert 得 partial；两份都给 ⇒ 全部还原
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        const L2 = [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }];
        const r1 = newReceipt(), r2 = newReceipt();
        stub.putMode = (id) => (id === 7 ? 'error500' : 'normal');
        const a1 = await sApply(stub, L2, { receipt: r1 });
        stub.putMode = null;
        await settle(20);
        const a2 = await sApply(stub, L2, { receipt: r2 });
        const x2 = readJ(r2).rows.find(r => r.model_id === 1);
        check('P2 前提：第一次 1 written + 7 error（500）；第二次 1 记 already-target（输出与回执里带「还原须同时提供更早的回执」提示）、7 written',
          rowState(a1, 'parent', 1) === 'written' && rowState(a1, 'parent', 7) === 'error' && rowState(a2, 'parent', 1) === 'already-target' && rowState(a2, 'parent', 7) === 'written' && x2.state === 'already-target' && x2.put_sent === false && /还原须同时提供更早的回执/.test(x2.reason || '')
          && /还原须同时提供更早的回执/.test(a2.rows.find(r => r.model_id === 1).reason), J([a1.rows.map(r => [r.model_id, r.state]), a2.rows.map(r => [r.model_id, r.state]), x2]));
        check('P2 already-target 行不拉低 apply 状态（第二次 applied）', a2.status === 'applied', a2.status);
        const rvOnly = await runner.revert({ receipt: r2, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P2 只给第二份回执 revert ⇒ 行 7 reverted、行 1 列为 not-written-by-these-receipts（未完成清单）、status partial；行 1 仍是新值',
          rowState(rvOnly, 'revert', 7) === 'reverted' && rowState(rvOnly, 'revert', 1) === 'not-written-by-these-receipts' && rvOnly.status === 'partial' && rvOnly.unfinished.some(u => u.model_id === 1 && u.state === 'not-written-by-these-receipts') && stub.models.get(1).table_comment === A_NEW && stub.models.get(7).table_comment === C_OLD,
          J([rvOnly.rows.map(r => [r.model_id, r.state]), rvOnly.status, stub.models.get(1).table_comment]));
        // 再把行 7 写回新值，模拟「回到第二次运行之后」，两份回执一起还原
        const a3 = await sApply(stub, L2, { receipt: newReceipt() });
        check('P2 前提：重跑把行 7 重新写成新值', rowState(a3, 'parent', 7) === 'written' && stub.models.get(7).table_comment === '第二行短名', J(a3.rows.map(r => [r.model_id, r.state])));
        // 两份回执一起（故意把旧的放前面，验证按 started_at 逆序而不是命令行顺序）：r2 最新先还原，再 r1
        const rvBoth = await runner.revert({ receipt: [r1, r2], baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P2 两份回执一起 revert（按 started_at 逆序：r2 先、r1 后）⇒ 无 not-written、行 1 与 7 都回到最早 before，status reverted',
          !rvBoth.rows.some(r => r.state === 'not-written-by-these-receipts') && rvBoth.status === 'reverted' && stub.models.get(1).table_comment === A_OLD && stub.models.get(1).impl_note === null && stub.models.get(7).table_comment === C_OLD, J([rvBoth.rows.map(r => [r.model_id, r.state]), rvBoth.status, stub.models.get(1).table_comment, stub.models.get(7).table_comment]));
        const cliR = await cliAsync('--revert', '--receipt', r1, '--receipt', r2, '--base-url', stub.url, '--token-file', tokenFile, '--revert-receipt', newReceipt(), '--timeout-ms', '400', '--migration-id', 'mig_s');
        check('P2 命令行 --receipt 可重复：两份回执 revert（已还原，再跑全是 done）退出码 0、输出「结果: reverted」', cliR.status === 0 && /结果: reverted/.test(cliR.stdout || ''), `${cliR.status} ${cliR.stdout} ${cliR.stderr}`);
      });

      // P3：桩服务先提交写入、再让脚本进程被杀且不回响应 ⇒ 回执该行 writing + put_sent = true；revert 后库回到旧值、状态 reverted
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        const rcp = newReceipt();
        const L2 = [...L1, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }];
        let killer = null;
        stub.putMode = () => { if (stub.puts === 2 && killer) { killer.kill('SIGKILL'); return 'commit-no-reply'; } return 'normal'; };   // 提交写入，再杀进程，不回响应
        const sp = spawnScript(['--apply', '--list', writeList(L2), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', rcp, '--migration-id', 'mig_crash2', '--timeout-ms', '8000']);
        killer = sp.child;
        const out = await sp.done;
        let parsed = null; try { parsed = readJ(rcp); } catch (_) { /* 断言里报 */ }
        const r7 = parsed && parsed.rows.find(r => r.model_id === 7);
        check('P3 写了未记：桩里第二行已提交（新值）、进程被杀，回执仍是合法 JSON，第二行 state = writing 且 put_sent = true', out.status !== 0 && stub.models.get(7).table_comment === '第二行短名' && r7 && r7.state === 'writing' && r7.put_sent === true, `${out.status} ${J(parsed && parsed.rows)}`);
        // 复审 48（整批确认）：writing 行是结果未知——不带 inflightCleared 的 revert 整次拒绝、零写入（旧断言：直接两行都 reverted）；确认在途请求已终止后带 inflightCleared 才还原
        const rvBlocked = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400 });
        check('P3 写了未记：revert（不带 inflightCleared）⇒ 整次拒绝 blocked-inflight，零写入（PUT 仍是 apply 的 2 次，两行仍是新值）', rowState(rvBlocked, 'revert', 7) === 'blocked-inflight' && rowState(rvBlocked, 'revert', 1) === 'not-processed' && rvBlocked.status === 'blocked-inflight' && stub.puts === 2 && stub.models.get(1).table_comment === A_NEW && stub.models.get(7).table_comment === '第二行短名', J([rvBlocked.rows.map(r => [r.model_id, r.state]), rvBlocked.status, stub.puts]));
        const rv = await safeRevert({ receipt: rcp, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, inflightCleared: true });
        check('P3 写了未记：确认在途请求已终止（inflightCleared）后 revert，两行都回到旧值，状态 reverted',rowState(rv, 'revert', 1) === 'reverted' && rowState(rv, 'revert', 7) === 'reverted' && rv.status === 'reverted' && stub.models.get(1).table_comment === A_OLD && stub.models.get(7).table_comment === C_OLD, J([rv.rows.map(r => [r.model_id, r.state]), rv.status]));
      });

      // P4：回执原子重写的 rename 被占用（EPERM）⇒ 有界重试（5 次、间隔 100ms 递增）；仍失败则清理 .tmp 后抛错
      await withStub([P1], async (stub) => {
        const origRename = M._ops.rename;
        let calls = 0, thrown = 0;
        M._ops.rename = (a, b) => { calls++; if (thrown < 2) { thrown++; const e = new Error('EPERM: 模拟回执被占用'); e.code = 'EPERM'; throw e; } return origRename(a, b); };
        const rcp = newReceipt();
        let res = null, err = null;
        try { res = await sApply(stub, L1, { receipt: rcp }); } catch (e) { err = e; } finally { M._ops.rename = origRename; }
        check('P4 rename 前两次 EPERM、第三次成功 ⇒ apply 正常完成（status applied），回执是合法完整 JSON，无 .tmp 残留',
          !err && res && res.status === 'applied' && thrown === 2 && calls >= 3 && readJ(rcp).status === 'applied' && fs.readdirSync(receiptDir).every(f => !/\.tmp-/.test(f)), J([err && err.message, res && res.status, thrown, calls]));
        M._ops.rename = () => { const e = new Error('EPERM: 一直被占用'); e.code = 'EPERM'; throw e; };
        let err2 = null;
        try { await sApply(stub, L1, { receipt: newReceipt() }); } catch (e) { err2 = e; } finally { M._ops.rename = origRename; }
        check('P4 rename 一直 EPERM ⇒ 重试用尽后抛错（含 EPERM），并清理 .tmp', err2 && /EPERM/.test(err2.message) && fs.readdirSync(receiptDir).every(f => !/\.tmp-/.test(f)), J([err2 && err2.message, fs.readdirSync(receiptDir)]));
      });

      // ═══════════════ 修复 3（codex 24-R2 / 24-R2T）：X1 / X2 / X3 / X4 / X5 / X6 / X8 ═══════════════
      const revertThrows = async (o) => { try { await runner.revert(o); return null; } catch (e) { return e.message; } };
      const revOpts = (stub, receipt, extra) => ({ receipt, baseUrl: stub.url, tokenFile, revertReceipt: newReceipt(), timeoutMs: 400, ...(extra || {}) });
      const L1c = [{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: A_IMPL }];
      const Pc2 = { id: 2, table_name: 's_c2', table_comment: A_COMP_OLD, companion_of: 1 };
      const bodyOf = (stub, id, from) => stub.putBodies.slice(from || 0).find((b, i) => stub.putUrls[(from || 0) + i] === `/api/models/${id}/comment-split`);

      // X1：回执记 before_meta / after_meta；apply 与 revert 条件写都带 expected_config_rev；revert 时版本被改过 ⇒ 409 ⇒ skipped-modified 零写入
      await withStub([P1, Pc2], async (stub) => {
        const rcp = newReceipt();
        const res = await sApply(stub, L1c, { receipt: rcp });
        const rr = readJ(rcp).rows;
        const x1 = rr.find(r => r.model_id === 1), x2 = rr.find(r => r.model_id === 2);
        check('X1 回执：父行 / 伴生行记 before_meta = { config_rev, is_deleted, companion_of }（写前 GET 同一行）与 after_meta = { config_rev }（写后 GET）',
          rowState(res, 'parent', 1) === 'written' && x1 && x2 && J(x1.before_meta) === J({ config_rev: 1, is_deleted: 0, companion_of: null }) && J(x1.after_meta) === J({ config_rev: 1 }) && J(x2.before_meta) === J({ config_rev: 1, is_deleted: 0, companion_of: 1 }) && J(x2.after_meta) === J({ config_rev: 1 }), J([x1, x2]));
        check('X1 apply 条件写（父行 / 伴生行）都带 expected_config_rev = 写前 GET 的 config_rev', stub.putBodies.length === 2 && stub.putBodies.every(b => b.expected_config_rev === 1), J(stub.putBodies));
        stub.models.get(1).config_rev = 2;   // 别的写入把版本递增了，表注释仍是 apply 的 target
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        check('X1 revert：行 1 的 config_rev 被改成 2（表注释仍是 target）⇒ 条件写带 expected_config_rev = 1（回执 after_meta）⇒ 409 ⇒ skipped-modified，零写入（仍是新值）；行 2 照常 reverted；status partial',
          rowState(rv, 'revert', 1) === 'skipped-modified' && stub.models.get(1).table_comment === A_NEW && rowState(rv, 'revert', 2) === 'reverted' && stub.models.get(2).table_comment === A_COMP_OLD && rv.status === 'partial'
          && (bodyOf(stub, 1, from) || {}).expected_config_rev === 1 && (bodyOf(stub, 2, from) || {}).expected_config_rev === 1, J([rv.rows.map(r => [r.model_id, r.state]), rv.status, stub.putBodies.slice(from)]));
      });

      // X2：revert 当前值已是写前原值，但行被删除 / 改挂 ⇒ 不得记 done
      await withStub([P1, Pc2, { id: 3, table_name: 's_p3', table_comment: P2_OLD }], async (stub) => {
        const rcp = newReceipt();
        const res = await sApply(stub, [...L1c, { model_id: 3, old_table_comment: P2_OLD, new_table_comment: P2_NEW, new_impl_note: null }], { receipt: rcp });
        check('X2 前提：apply 写了父行 1、伴生 2、父行 3', ['1', '3'].every(k => rowState(res, 'parent', Number(k)) === 'written') && rowState(res, 'companion', 2) === 'written', J(res.rows.map(r => [r.kind, r.model_id, r.state])));
        // 值都被改回写前原值，但：行 1 被删除、行 2 改挂到别的父表、行 3 被转成伴生行
        Object.assign(stub.models.get(1), { table_comment: A_OLD, impl_note: null, is_deleted: 1 });
        Object.assign(stub.models.get(2), { table_comment: A_COMP_OLD, companion_of: 9 });
        Object.assign(stub.models.get(3), { table_comment: P2_OLD, companion_of: 77 });
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        check('X2 当前值 = 写前原值但行已删除（父行 1）/ 改挂（伴生 2）/ 被转成伴生行（父行 3）⇒ 都是 skipped-modified、不记 done、零写入；status partial',
          [1, 2, 3].every(id => rowState(rv, 'revert', id) === 'skipped-modified') && stub.puts === from && rv.status === 'partial' && rv.rows.every(r => /写前原值，但行已被删除或归属与回执不符/.test(r.reason || '')), J([rv.rows.map(r => [r.model_id, r.state, r.reason]), rv.status]));
      });
      // X2 正向：值 = 写前原值且归属相符 ⇒ 仍记 done（零写入）
      await withStub([P1, Pc2], async (stub) => {
        const rcp = newReceipt();
        await sApply(stub, L1c, { receipt: rcp });
        Object.assign(stub.models.get(1), { table_comment: A_OLD, impl_note: null });
        Object.assign(stub.models.get(2), { table_comment: A_COMP_OLD });
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        check('X2 正向：值 = 写前原值且归属相符 ⇒ done（零写入），status reverted', rowState(rv, 'revert', 1) === 'done' && rowState(rv, 'revert', 2) === 'done' && stub.puts === from && rv.status === 'reverted', J(rv.rows.map(r => [r.model_id, r.state])));
      });

      // X3：回执是不可信输入——篡改后的回执在任何请求之前整份拒绝（桩零请求、revert 回执不被创建）
      await withStub([P1, Pc2], async (stub) => {
        const rcp = newReceipt();
        await sApply(stub, L1c, { receipt: rcp });
        const tamper = async (label, mutate, reason) => {
          const j = readJ(rcp); mutate(j);
          const f = newReceipt(); fs.writeFileSync(f, J(j));
          const o = revOpts(stub, f);
          const n0 = stub.reqs.length;
          const msg = await revertThrows(o);
          check(`X3 篡改回执（${label}）⇒ 拒绝，桩零请求，revert 回执未创建`, msg !== null && /拒绝/.test(msg) && reason.test(msg) && stub.reqs.length === n0 && !fs.existsSync(o.revertReceipt), `${msg} reqs=${stub.reqs.length - n0}`);
        };
        const p = (j) => j.rows.find(r => r.kind === 'parent'), c = (j) => j.rows.find(r => r.kind === 'companion');
        check('X3 前提：未篡改的回执可被 revert 干跑接受', (await safeRevert({ ...revOpts(stub, rcp), dryRun: true })).errors.length === 0, 'unexpected');
        await tamper('before.table_comment 类型错（数字）', j => { p(j).before.table_comment = 123; }, /before \/ target 缺失或字段不全/);
        await tamper('before.impl_note 类型错（对象）', j => { p(j).before.impl_note = {}; }, /before \/ target 缺失或字段不全/);
        await tamper('target 缺 impl_note 字段', j => { delete p(j).target.impl_note; }, /before \/ target 缺失或字段不全/);
        await tamper('target 整个缺失（null）', j => { p(j).target = null; }, /before \/ target 缺失或字段不全/);
        await tamper('put_sent = true 但 before 缺失', j => { delete p(j).before; }, /before \/ target 缺失或字段不全/);
        await tamper('伴生行 parent_id 缺失', j => { delete c(j).parent_id; }, /缺少合法 parent_id/);
        await tamper('伴生行 parent_id = -1', j => { c(j).parent_id = -1; }, /缺少合法 parent_id/);
        await tamper('伴生行 parent_id 是字符串', j => { c(j).parent_id = '1'; }, /缺少合法 parent_id/);
        await tamper('父行 parent_id 非 null', j => { p(j).parent_id = 5; }, /parent_id 必须为 null/);
        await tamper('重复 model_id（put_sent 行重复）', j => { j.rows.push(JSON.parse(JSON.stringify(p(j)))); }, /在同一回执内重复/);
        await tamper('rows 不是数组', j => { j.rows = { a: 1 }; }, /rows 不是数组/);
        await tamper('rows 里有非对象项', j => { j.rows.push(7); }, /不是对象/);
        await tamper('put_sent 不是布尔（字符串 "true"）', j => { p(j).put_sent = 'true'; }, /put_sent 不是布尔值/);
        await tamper('model_id 是字符串', j => { p(j).model_id = '1'; }, /model_id 不是正整数/);
        await tamper('model_id 为 0', j => { p(j).model_id = 0; }, /model_id 不是正整数/);
        await tamper('kind 不合法', j => { p(j).kind = 'grandparent'; }, /kind 不合法/);
        await tamper('put_sent 行 kind = companion-list', j => { p(j).kind = 'companion-list'; }, /kind 只能是 parent \/ companion/);
        await tamper('before_meta 缺失', j => { delete p(j).before_meta; }, /before_meta 缺失或类型不对/);
        await tamper('before_meta.config_rev 是字符串', j => { p(j).before_meta.config_rev = '1'; }, /before_meta 缺失或类型不对/);
        await tamper('before_meta.is_deleted = 1（写前已删除的行不可能被写）', j => { p(j).before_meta.is_deleted = 1; }, /before_meta 缺失或类型不对/);
        await tamper('伴生行 before_meta.companion_of 与 parent_id 不一致', j => { c(j).before_meta.companion_of = 9; }, /before_meta\.companion_of 与 kind/);
        await tamper('父行 before_meta.companion_of 非 null', j => { p(j).before_meta.companion_of = 4; }, /before_meta\.companion_of 与 kind/);
        await tamper('after_meta.config_rev 是字符串', j => { p(j).after_meta = { config_rev: 'x' }; }, /after_meta 类型不对/);
        await tamper('MED-2 before.table_comment 为 null', j => { p(j).before.table_comment = null; }, /table_comment 必须是非空字符串/);
        await tamper('MED-2 target.table_comment 为空串', j => { p(j).target.table_comment = '  '; }, /table_comment 必须是非空字符串/);
        // Z2：after_meta.config_rev 必须等于 before_meta.config_rev（B 类写入不递增）——桩当前 config_rev 也调到 9，使篡改后的回执若不被结构校验拦下，revert 就会照常发出 expected_config_rev = 9 的条件写
        stub.models.get(1).config_rev = 9;
        await tamper('Z2 after_meta.config_rev = 9（≠ before_meta.config_rev 1），桩当前 config_rev 也是 9', j => { p(j).after_meta = { config_rev: 9 }; }, /after_meta\.config_rev（9）与 before_meta\.config_rev（1）不一致/);
        stub.models.get(1).config_rev = 1;
        // Y3：put_rejected 组合约束
        await tamper('Y3 put_sent = true + put_rejected = true', j => { p(j).put_rejected = true; }, /put_rejected 要求 put_sent = false 且 state = skipped-modified/);
        await tamper('Y3 put_rejected = true + state = written（put_sent = false）', j => { p(j).put_sent = false; p(j).put_rejected = true; }, /put_rejected 要求 put_sent = false 且 state = skipped-modified/);
        // Y4：before 四字段 + 与 kind / parent_id / before_meta 一致
        await tamper('Y4 before.companion_of 缺失', j => { delete p(j).before.companion_of; }, /before 缺少 companion_of \/ is_deleted/);
        await tamper('Y4 before.is_deleted 缺失', j => { delete p(j).before.is_deleted; }, /before 缺少 companion_of \/ is_deleted/);
        await tamper('Y4 before.companion_of 是字符串', j => { p(j).before.companion_of = 'x'; }, /before\.companion_of 必须是正整数或 null/);
        await tamper('Y4 before.companion_of 是小数', j => { c(j).before.companion_of = 1.5; }, /before\.companion_of 必须是正整数或 null/);
        await tamper('Y4 伴生行 before.companion_of 与 parent_id 不符', j => { c(j).before.companion_of = 9; }, /before\.companion_of 与 kind \/ parent_id 不一致/);
        await tamper('Y4 父行 before.companion_of 非 null', j => { p(j).before.companion_of = 4; }, /before\.companion_of 与 kind \/ parent_id 不一致/);
        await tamper('Y4 before.is_deleted = 1', j => { p(j).before.is_deleted = 1; }, /before\.is_deleted 必须是 0 或 null/);
        await tamper('Y4 before.is_deleted 是字符串 "0"', j => { p(j).before.is_deleted = '0'; }, /before\.is_deleted 必须是 0 或 null/);
        await tamper('Y4 before.is_deleted 与 before_meta 不一致（null vs 0）', j => { p(j).before.is_deleted = null; }, /before 快照的 companion_of \/ is_deleted 与 before_meta 不一致/);
        // Y5：target 类型
        await tamper('Y5 target.table_comment 是数字', j => { p(j).target.table_comment = 7; }, /before \/ target 缺失或字段不全/);
        await tamper('Y5 target.impl_note 是对象', j => { p(j).target.impl_note = { a: 1 }; }, /before \/ target 缺失或字段不全/);
        await tamper('Y5 target.impl_note 是数组', j => { p(j).target.impl_note = []; }, /before \/ target 缺失或字段不全/);
        await tamper('Y5 target.impl_note 缺失', j => { delete p(j).target.impl_note; }, /before \/ target 缺失或字段不全/);
        await tamper('put_rejected 不是布尔', j => { p(j).put_rejected = 'yes'; }, /put_rejected 不是布尔值/);
        {
          const j1 = readJ(rcp); j1.format = 'mc77-table-comment-receipt-v1';
          const f1 = newReceipt(); fs.writeFileSync(f1, J(j1));
          const o1 = revOpts(stub, f1), nR = stub.reqs.length;
          const m1 = await revertThrows(o1);
          check('L5 revert 拒绝旧版 v1 回执（说明只接受 v2），桩零请求、revert 回执未创建', m1 !== null && /旧版 mc77-table-comment-receipt-v1.*只接受 mc77-table-comment-receipt-v2/.test(m1) && stub.reqs.length === nR && !fs.existsSync(o1.revertReceipt), String(m1));
        }
        await tamper('already-target 行 target 缺字段', j => { j.rows.push({ model_id: 50, kind: 'parent', parent_id: null, before: { table_comment: 'a', impl_note: null }, put_sent: false, target: { table_comment: 'a' }, state: 'already-target' }); }, /before \/ target 缺失或字段不全/);
      });

      // X5：多份回执——乱序传参 / 同一模型多次 written / 衔接不上 / 时间相同 / 缺失 started_at
      await withStub([P1], async (stub) => {
        const rA = newReceipt(), rB = newReceipt(), rC = newReceipt();
        const a = await sApply(stub, L1c, { receipt: rA });
        await settle(25);
        const b = await sApply(stub, [{ model_id: 1, old_table_comment: A_NEW, new_table_comment: '第二次短名', new_impl_note: null }], { receipt: rB });
        await settle(25);
        const c = await sApply(stub, [{ model_id: 1, old_table_comment: '第二次短名', new_table_comment: '第三次短名', new_impl_note: null }], { receipt: rC });
        check('X5 前提：同一模型被三次 written（A_OLD → 员工信息 → 第二次 → 第三次）', [a, b, c].every(x => rowState(x, 'parent', 1) === 'written') && stub.models.get(1).table_comment === '第三次短名', J([a, b, c].map(x => x.rows.map(r => r.state))));
        // 衔接不上：跳过 rB
        const nSkip = stub.reqs.length;
        const msgGap = await revertThrows(revOpts(stub, [rA, rC]));
        check('X5 衔接不上（缺中间回执 rB）⇒ 拒绝并说明，桩零请求', msgGap !== null && /衔接不上/.test(msgGap) && stub.reqs.length === nSkip, String(msgGap));
        // 乱序传参 + 三份衔接：最终回到最早 before
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, [rB, rC, rA]));
        check('X5 同一模型多次 written + 乱序传参 [rB, rC, rA]：按 started_at 逆序 C → B → A 逐份还原，最终回到最早 before（A_OLD / impl NULL），3 次 PUT，status reverted',
          rv.status === 'reverted' && stub.puts - from === 3 && stub.models.get(1).table_comment === A_OLD && stub.models.get(1).impl_note === null && J(rv.rows.map(r => r.state)) === J(['reverted', 'reverted', 'reverted']), J([rv.status, rv.rows.map(r => r.state), stub.models.get(1)]));
        // 时间相同 / 缺失 / 同一文件传两次
        const withAt = (src, at) => { const j = readJ(src); if (at === undefined) delete j.started_at; else j.started_at = at; const f = newReceipt(); fs.writeFileSync(f, J(j)); return f; };
        const nT = stub.reqs.length;
        const msgSame = await revertThrows(revOpts(stub, [rA, withAt(rB, readJ(rA).started_at)]));
        const msgMiss = await revertThrows(revOpts(stub, [rA, withAt(rB, undefined)]));
        const msgBad = await revertThrows(revOpts(stub, [rA, withAt(rB, 'not-a-date')]));
        const msgDup = await revertThrows(revOpts(stub, [rA, rA]));
        check('X5 started_at 两份相同 ⇒ 拒绝（无法判定先后）', msgSame !== null && /started_at.*相同/.test(msgSame), String(msgSame));
        check('X5 started_at 缺失 ⇒ 拒绝', msgMiss !== null && /started_at.*缺失或不合法/.test(msgMiss), String(msgMiss));
        check('X5 started_at 不可解析 ⇒ 拒绝', msgBad !== null && /started_at.*缺失或不合法/.test(msgBad), String(msgBad));
        check('X5 同一份回执传两次（started_at 相同）⇒ 拒绝；以上四种拒绝都发生在任何请求之前（桩零请求）', msgDup !== null && /started_at.*相同/.test(msgDup) && stub.reqs.length === nT, `${msgDup} reqs=${stub.reqs.length - nT}`);
      });

      // X6：任何 error 一律停止——中间一行条件写 500 ⇒ 后面的行 not-processed、status failed、回执 status failed；revert 同理
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }, { id: 8, table_name: 's_third', table_comment: B15 }], async (stub) => {
        const L3 = [...L1c, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }, { model_id: 8, old_table_comment: B15, new_table_comment: '第三行短名', new_impl_note: null }];
        stub.putMode = (id) => (id === 7 ? 'error500' : 'normal');
        const rcp = newReceipt();
        const res = await sApply(stub, L3, { receipt: rcp });
        const rc3 = readJ(rcp);
        check('X6 apply：第二行 PUT 500 ⇒ 第二行 error、第三行 not-processed（未发 PUT）、status failed，stopped = true；回执 status failed 且 finished_at 非空',
          rowState(res, 'parent', 1) === 'written' && rowState(res, 'parent', 7) === 'error' && rowState(res, 'parent', 8) === 'not-processed' && res.status === 'failed' && res.stopped === true && stub.puts === 2 && stub.models.get(8).table_comment === B15 && rc3.status === 'failed' && !!rc3.finished_at,
          J([res.rows.map(r => [r.model_id, r.state]), res.status, res.stopped, stub.puts, rc3.status]));
        stub.putMode = null;
        const rcp2 = newReceipt();
        await sApply(stub, L3, { receipt: rcp2, migrationId: 'mig_s6' });
        stub.putMode = (id) => (id === 8 ? 'error500' : 'normal');
        const rv = await safeRevert(revOpts(stub, rcp2));
        check('X6 revert：回执 2 里写入的是行 7、8（行 1 开始时已是目标值），逆序先还原行 8：PUT 500 ⇒ 行 8 error、行 7 not-processed（未发 PUT，仍是新值）、status failed，stopped = true',
          rowState(rv, 'revert', 8) === 'error' && rowState(rv, 'revert', 7) === 'not-processed' && rv.status === 'failed' && rv.stopped === true && stub.models.get(7).table_comment === '第二行短名' && stub.puts === 5,
          J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.stopped, stub.puts]));
      });

      // X8：Authorization 头 / 非 JSON 与异常状态码 / impl_note NULL·空串·非空矩阵 / 超时分支请求序列 / 回执 flush 失败
      await withStub([P1, Pc2], async (stub) => {
        const rcp = newReceipt();
        await sApply(stub, L1c, { receipt: rcp });
        await safeRevert(revOpts(stub, rcp));
        check('X8 桩记录：每个请求（列表 / 单行 GET / PUT，apply 与 revert）都带 Authorization: Bearer <token 文件内容>', stub.reqs.length >= 8 && stub.reqs.some(r => r.method === 'PUT') && stub.reqs.every(r => r.auth === `Bearer ${adminToken}`), J(stub.reqs.slice(0, 3)));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'conflict-nonjson';
        const res = await sApply(stub, L1c);
        const pr = res.rows.find(r => r.kind === 'parent');
        check('X8 PUT 返回 409 但响应体不是 JSON ⇒ 不崩溃，skipped-modified，current 为空，status partial，行未被写', pr && pr.state === 'skipped-modified' && pr.current === null && res.status === 'partial' && stub.models.get(1).table_comment === A_OLD, J([res.rows, res.status]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'put404';
        const res = await sApply(stub, L1c);
        check('X8 PUT 返回 404（接口不存在 / 服务版本不对）⇒ 行 error（含 404 与响应文本），status failed，行未被写', rowState(res, 'parent', 1) === 'error' && res.status === 'failed' && /404/.test(res.errors.join('')) && /Cannot PUT/.test(res.errors.join('')) && stub.models.get(1).table_comment === A_OLD, J([res.rows, res.errors]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'error500-nonjson';
        const res = await sApply(stub, L1c);
        check('X8 PUT 返回 500 且响应体不是 JSON ⇒ 行 error（错误里带响应文本），status failed', rowState(res, 'parent', 1) === 'error' && res.status === 'failed' && /500/.test(res.errors.join('')) && /upstream exploded/.test(res.errors.join('')), J([res.rows, res.errors]));
      });
      // impl_note 三组合矩阵（NULL / 空串 / 非空 × 清单 new_impl_note 为空 / 非空）：请求 body 与落库值全部手写
      await withStub([
        { id: 1, table_name: 'm1', table_comment: 'T1', impl_note: null }, { id: 2, table_name: 'm2', table_comment: 'T2', impl_note: '' }, { id: 3, table_name: 'm3', table_comment: 'T3', impl_note: '旧' },
        { id: 4, table_name: 'm4', table_comment: 'T4', impl_note: null }, { id: 5, table_name: 'm5', table_comment: 'T5', impl_note: '' }, { id: 6, table_name: 'm6', table_comment: 'T6', impl_note: '旧' }], async (stub) => {
        const LM = [
          { model_id: 1, old_table_comment: 'T1', new_table_comment: 'N1', new_impl_note: null }, { model_id: 2, old_table_comment: 'T2', new_table_comment: 'N2', new_impl_note: '' },
          { model_id: 3, old_table_comment: 'T3', new_table_comment: 'N3', new_impl_note: null }, { model_id: 4, old_table_comment: 'T4', new_table_comment: 'N4', new_impl_note: '新4' },
          { model_id: 5, old_table_comment: 'T5', new_table_comment: 'N5', new_impl_note: '新5' }, { model_id: 6, old_table_comment: 'T6', new_table_comment: 'N6', new_impl_note: '新6' }];
        const rcp = newReceipt();
        const res = await sApply(stub, LM, { receipt: rcp });
        const body = (exp, set, extra) => J({ expected: exp, set, parent_only: true, expected_config_rev: 1, ...(extra || {}) });
        const want = {
          1: body({ table_comment: 'T1', impl_note: null }, { table_comment: 'N1', impl_note: null }),
          2: body({ table_comment: 'T2', impl_note: '' }, { table_comment: 'N2', impl_note: '' }),
          3: body({ table_comment: 'T3', impl_note: '旧' }, { table_comment: 'N3', impl_note: '旧' }),
          4: body({ table_comment: 'T4', impl_note: null }, { table_comment: 'N4', impl_note: '新4' }),
          5: body({ table_comment: 'T5', impl_note: '' }, { table_comment: 'N5', impl_note: '新5' }),
        };
        check('X8 impl_note 矩阵 apply 请求 body：行 1（NULL，清单空）/ 2（空串，清单空）/ 3（非空，清单空：impl 原样带回）/ 4（NULL，清单非空）/ 5（空串，清单非空）逐个等于手写 body；行 6（非空 vs 清单非空不同）不发请求',
          [1, 2, 3, 4, 5].every(id => J(bodyOf(stub, id)) === want[id]) && !bodyOf(stub, 6) && stub.puts === 5, J(stub.putBodies));
        const st = (id) => [stub.models.get(id).table_comment, stub.models.get(id).impl_note];
        check('X8 impl_note 矩阵 apply 落库：1 (N1, NULL) / 2 (N2, NULL：空串被服务规范成 NULL) / 3 (N3, 旧) / 4 (N4, 新4) / 5 (N5, 新5) / 6 不动 (T6, 旧)；行 6 skipped-modified',
          J([1, 2, 3, 4, 5, 6].map(st)) === J([['N1', null], ['N2', null], ['N3', '旧'], ['N4', '新4'], ['N5', '新5'], ['T6', '旧']]) && rowState(res, 'parent', 6) === 'skipped-modified', J([1, 2, 3, 4, 5, 6].map(st)));
        const rowsR = readJ(rcp).rows;
        check('X8 impl_note 矩阵回执：行 2 的 before.impl_note 保留空串、target.impl_note 空串；行 4 的 target.impl_note = 新4；行 6 无 target',
          J(rowsR.find(r => r.model_id === 2).before.impl_note) === '""' && J(rowsR.find(r => r.model_id === 2).target.impl_note) === '""' && rowsR.find(r => r.model_id === 4).target.impl_note === '新4' && rowsR.find(r => r.model_id === 6).target === null, J(rowsR.map(r => [r.model_id, r.before && r.before.impl_note, r.target && r.target.impl_note])));
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        const wantR = {
          1: body({ table_comment: 'N1', impl_note: null }, { table_comment: 'T1', impl_note: null }),
          2: body({ table_comment: 'N2', impl_note: null }, { table_comment: 'T2', impl_note: '' }),
          3: body({ table_comment: 'N3', impl_note: '旧' }, { table_comment: 'T3', impl_note: '旧' }),
          4: body({ table_comment: 'N4', impl_note: '新4' }, { table_comment: 'T4', impl_note: null }),
          5: body({ table_comment: 'N5', impl_note: '新5' }, { table_comment: 'T5', impl_note: '' }),
        };
        check('X8 impl_note 矩阵 revert 请求 body：每行 expected = 当前值、set = 回执 before 的两列（空串原样带回，由服务规范成 NULL），逐个等于手写 body',
          [1, 2, 3, 4, 5].every(id => J(bodyOf(stub, id, from)) === wantR[id]) && stub.puts - from === 5, J(stub.putBodies.slice(from)));
        check('X8 impl_note 矩阵 revert 落库：1 (T1, NULL) / 2 (T2, NULL) / 3 (T3, 旧) / 4 (T4, NULL) / 5 (T5, NULL)，status reverted',
          J([1, 2, 3, 4, 5].map(st)) === J([['T1', null], ['T2', null], ['T3', '旧'], ['T4', null], ['T5', null]]) && rv.status === 'reverted', J([[1, 2, 3, 4, 5].map(st), rv.status]));
      });
      // 超时分支：断言 GET / PUT 的次数、顺序与 PUT body
      const wantPut = J({ expected: { table_comment: A_OLD, impl_note: null }, set: { table_comment: A_NEW, impl_note: A_IMPL }, parent_only: true, expected_config_rev: 1 });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'commit-no-reply';
        const res = await sApply(stub, L1c, { timeoutMs: 300 });
        check('X8 PUT 超时（已提交）：请求序列恰为 GET 列表 → GET 行 → PUT（1 次，body 逐字段符合）→ 重读 GET 行（1 次）→ 父行 done 后重取伴生集合 GET 列表；不重试 PUT',
          rowState(res, 'parent', 1) === 'done' && J(stub.getUrls) === J(['/api/models', '/api/models/1', '/api/models/1', '/api/models']) && stub.puts === 1 && J(stub.putBodies[0]) === wantPut, J([stub.getUrls, stub.puts, stub.putBodies]));
      });
      await withStub([P1], async (stub) => {
        stub.putMode = () => 'hang-no-apply';
        const res = await sApply(stub, L1c, { timeoutMs: 300 });
        check('X8 PUT 超时（未提交）：GET 列表 → GET 行 → PUT（1 次）→ 重读 GET 行（1 次），未生效 ⇒ 不派生伴生行（无后续列表 GET）；PUT body 同上',
          rowState(res, 'parent', 1) === 'timeout-unknown-not-applied' && J(stub.getUrls) === J(['/api/models', '/api/models/1', '/api/models/1']) && stub.puts === 1 && J(stub.putBodies[0]) === wantPut, J([stub.getUrls, stub.puts]));
      });
      // 回执 flush 失败（rename 重试用尽）：回执保持可解析；发请求前的 put_sent 落盘失败 ⇒ 不发 PUT
      await withStub([P1], async (stub) => {
        const origRename = M._ops.rename;
        let okLeft = 2;   // 前两次落盘（初始 + 记入清单行）成功，第三次（put_sent 落盘）起一直 EPERM
        M._ops.rename = (a, b) => { if (okLeft > 0) { okLeft--; return origRename(a, b); } const e = new Error('EPERM: 回执一直被占用'); e.code = 'EPERM'; throw e; };
        const rcp = newReceipt();
        let err = null;
        try { await sApply(stub, L1c, { receipt: rcp }); } catch (e) { err = e; } finally { M._ops.rename = origRename; }
        let parsed = null; try { parsed = readJ(rcp); } catch (_) { /* 断言里报 */ }
        check('X8 回执 flush 失败（put_sent 落盘 rename 用尽重试）：apply 抛 EPERM、没有发出 PUT、回执仍是上一份完整可解析 JSON（format 正确、行 1 put_sent = false）、无 .tmp 残留',
          err && /EPERM/.test(err.message) && stub.puts === 0 && parsed && parsed.format === 'mc77-table-comment-receipt-v2' && parsed.status === 'running' && parsed.rows.length === 1 && parsed.rows[0].put_sent === false && fs.readdirSync(receiptDir).every(f => !/\.tmp-/.test(f)), J([err && err.message, stub.puts, parsed]));
        // 首次落盘就失败：回执是独占创建时写入的占位 JSON（可解析），revert 拒绝它（不是 apply 回执）
        M._ops.rename = () => { const e = new Error('EPERM: 一开始就被占用'); e.code = 'EPERM'; throw e; };
        const rcp0 = newReceipt();
        let err0 = null;
        try { await sApply(stub, L1c, { receipt: rcp0 }); } catch (e) { err0 = e; } finally { M._ops.rename = origRename; }
        let parsed0 = null; try { parsed0 = readJ(rcp0); } catch (_) { /* 断言里报 */ }
        const msg0 = await revertThrows(revOpts(stub, rcp0));
        check('X8 首次落盘就失败：回执不是 0 字节（占位 JSON 可解析、无 format），revert 以「format 不是」拒绝', err0 && /EPERM/.test(err0.message) && parsed0 && parsed0.format === undefined && msg0 !== null && /format 不是/.test(msg0), J([err0 && err0.message, parsed0, msg0]));
      });

      // X4b：父行 already-target 时不写伴生行（MED-3：只列尚未达到新派生值的伴生行，见下方 MED-3 用例），但仍有未删除伴生行 ⇒ 记未完成清单、status partial（防「中途失败重跑后伴生行永不补写却报 applied」）
      const P1T = { id: 1, table_name: 's_parent', table_comment: A_NEW, impl_note: A_IMPL };
      await withStub([P1T, { ...Pc2 }, { id: 3, table_name: 's_c3', table_comment: A_COMP_OLD, companion_of: 1 }], async (stub) => {
        const res = await sApply(stub, L1c);
        const u = res.unfinished;
        check('X4b ① 父行 already-target + 2 个未删除伴生 ⇒ status partial，未完成清单恰 1 条（父行 1，state companions-unprocessed，companion_ids = [2, 3]，reason 含「需人工核对」），伴生零 PUT 且仍是旧派生值',
          rowState(res, 'parent', 1) === 'already-target' && res.status === 'partial' && u.length === 1 && u[0].model_id === 1 && u[0].state === 'companions-unprocessed' && J(u[0].companion_ids) === J([2, 3]) && /需人工核对/.test(u[0].reason) && stub.puts === 0
          && stub.models.get(2).table_comment === A_COMP_OLD && stub.models.get(3).table_comment === A_COMP_OLD, J([res.status, u, stub.puts]));
        const dry = await runner.apply({ list: writeList(L1c), baseUrl: stub.url, tokenFile, migrationId: 'mig_s', timeoutMs: 400, dryRun: true });
        check('X4b ① dry-run 同样列出（未完成清单含父行 1 的 companion_ids [2, 3]），零 PUT', dry.unfinished.length === 1 && J(dry.unfinished[0].companion_ids) === J([2, 3]) && stub.puts === 0, J(dry.unfinished));
        const cli1 = await cliAsync('--apply', '--list', writeList(L1c), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_x4b');
        const cli2 = await cliAsync('--apply', '--list', writeList(L1c), '--base-url', stub.url, '--token-file', tokenFile, '--receipt', newReceipt(), '--migration-id', 'mig_cli_x4b', '--allow-skips');
        check('X4b ① 命令行：partial 退出码 1，--allow-skips 豁免为 0', cli1.status === 1 && /结果: partial/.test(cli1.stdout || '') && cli2.status === 0, `${cli1.status}/${cli2.status}`);
      });
      await withStub([P1T], async (stub) => {
        const res = await sApply(stub, L1c);
        check('X4b ② 父行 already-target + 无伴生 ⇒ 不进未完成清单，status applied', rowState(res, 'parent', 1) === 'already-target' && res.unfinished.length === 0 && res.status === 'applied', J([res.status, res.unfinished]));
      });
      await withStub([P1T, { ...Pc2, is_deleted: 1 }], async (stub) => {
        const res = await sApply(stub, L1c);
        check('X4b ③ 父行 already-target + 伴生已删除 ⇒ 不列，status applied', res.unfinished.length === 0 && res.status === 'applied' && stub.puts === 0, J([res.status, res.unfinished]));
      });

      // ═══════════════ 修复 3b（Opus 预筛）：HIGH-1 / HIGH-2 / MED-1 / MED-3 / MED-4 ═══════════════
      const L2c = [...L1c, { model_id: 7, old_table_comment: C_OLD, new_table_comment: '第二行短名', new_impl_note: null }];
      // HIGH-1：PUT 超时后重读 = 目标值，但行已被删除 / 转成伴生行 ⇒ 不得推定 done
      await withStub([P1], async (stub) => {
        const rcp = newReceipt();
        await sApply(stub, L1c, { receipt: rcp });
        stub.putMode = () => 'commit-no-reply';
        stub.hooks.afterApply = (id, st) => { Object.assign(st.models.get(id), { is_deleted: 1 }); };   // revert 的写入提交后（值 = 回执 before），行被软删除
        const rv = await safeRevert(revOpts(stub, rcp, { timeoutMs: 300 }));
        check('HIGH-1 revert：PUT 挂起期间行被软删除、值恰为 before ⇒ 重读不记 done（outcome modified、skipped-modified、current.is_deleted = 1），status partial（不是 reverted）',
          rowState(rv, 'revert', 1) === 'skipped-modified' && rv.status === 'partial' && rv.timeouts.length === 1 && rv.timeouts[0].outcome === 'modified' && (rv.rows[0].current || {}).is_deleted === 1, J([rv.rows.map(r => [r.model_id, r.state]), rv.status, rv.timeouts]));
      });
      await withStub([P1, Pc2], async (stub) => {
        stub.putMode = (id) => (id === 1 ? 'commit-no-reply' : 'normal');
        stub.hooks.afterApply = (id, st) => { if (id === 1) st.models.get(1).companion_of = 55; };   // 父行写入提交后被转成伴生行
        const res = await sApply(stub, L1c);
        check('HIGH-1 apply：PUT 挂起期间父行被转成伴生行、值 = target ⇒ 重读不记 done（skipped-modified，outcome modified），不派生伴生（无任何 companion 行、总共只 1 次 PUT），status partial（不是 applied）',
          rowState(res, 'parent', 1) === 'skipped-modified' && res.status === 'partial' && res.timeouts.length === 1 && res.timeouts[0].outcome === 'modified' && !res.rows.some(r => r.kind === 'companion') && stub.puts === 1 && stub.models.get(2).table_comment === A_COMP_OLD, J([res.rows.map(r => [r.kind, r.model_id, r.state]), res.status, stub.puts]));
      });
      await withStub([P1, Pc2], async (stub) => {
        stub.putMode = (id) => (id === 2 ? 'commit-no-reply' : 'normal');
        stub.hooks.afterApply = (id, st) => { if (id === 2) st.models.get(2).companion_of = 9; };   // 伴生行写入提交后被改挂到别的父表
        const res = await sApply(stub, L1c);
        check('HIGH-1 apply 伴生行：PUT 挂起期间伴生行被改挂（companion_of = 9）、值 = 新派生值 ⇒ 重读不记 done（skipped-modified，outcome modified），status partial',
          rowState(res, 'parent', 1) === 'written' && rowState(res, 'companion', 2) === 'skipped-modified' && res.status === 'partial' && res.timeouts.length === 1 && res.timeouts[0].outcome === 'modified', J([res.rows.map(r => [r.kind, r.model_id, r.state]), res.status, res.timeouts]));
      });
      // HIGH-2：apply 时服务端 409（确定零写入）⇒ 回执 put_sent = false、put_rejected = true；之后他人把值写成 target，revert 对该行零 PUT
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        stub.hooks.beforePut = (id, b, st) => { if (id === 7) st.models.get(7).table_comment = '被抢先改了'; };
        const rcp = newReceipt();
        const res = await sApply(stub, L2c, { receipt: rcp });
        const x7 = readJ(rcp).rows.find(r => r.model_id === 7);
        check('HIGH-2 apply：行 7 条件写 409 ⇒ skipped-modified，回执该行 put_sent = false 且 put_rejected = true', rowState(res, 'parent', 7) === 'skipped-modified' && x7 && x7.state === 'skipped-modified' && x7.put_sent === false && x7.put_rejected === true, J(x7));
        stub.hooks.beforePut = null;
        stub.models.get(7).table_comment = '第二行短名';   // 之后他人把行 7 写成了与 target 相同的值
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        check('HIGH-2 revert：行 1 照常还原；行 7（apply 时被 409 拒绝）零 PUT、不出现在还原行里，最终仍是他人写的值；回执里的 put_rejected 行通过结构校验',
          rowState(rv, 'revert', 1) === 'reverted' && !rv.rows.some(r => r.model_id === 7) && stub.puts - from === 1 && stub.models.get(7).table_comment === '第二行短名' && rv.status === 'reverted', J([rv.rows.map(r => [r.model_id, r.state]), stub.puts - from, rv.status]));
      });
      // MED-1：链最旧一项只是 already-target（更早的写入回执 r0 没给）⇒ 较新回执照常还原，该模型列 not-written-by-these-receipts，status partial
      await withStub([P1], async (stub) => {
        const r0 = newReceipt(), rA = newReceipt(), rB = newReceipt();
        await sApply(stub, L1c, { receipt: r0 });   // r0（不给 revert）：ORIG → NEW
        await settle(25);
        const a = await sApply(stub, L1c, { receipt: rA });   // rA：重跑 already-target
        await settle(25);
        await sApply(stub, [{ model_id: 1, old_table_comment: A_NEW, new_table_comment: '第二次短名', new_impl_note: null }], { receipt: rB });   // rB：NEW → NEW2
        const rv = await safeRevert(revOpts(stub, [rA, rB]));
        check('MED-1 前提：rA 里行 1 是 already-target', rowState(a, 'parent', 1) === 'already-target', J(a.rows.map(r => [r.model_id, r.state])));
        check('MED-1 revert [rA, rB]：rB 的写入还原到 NEW（员工信息 + 实现说明），该模型另列 not-written-by-these-receipts（未完成清单含它），status partial；只发 1 次还原 PUT',
          rv.status === 'partial' && rv.rows.some(r => r.model_id === 1 && r.state === 'reverted') && rv.rows.some(r => r.model_id === 1 && r.state === 'not-written-by-these-receipts') && rv.unfinished.some(u => u.model_id === 1 && u.state === 'not-written-by-these-receipts')
          && stub.models.get(1).table_comment === A_NEW && stub.models.get(1).impl_note === A_IMPL && stub.puts === 3, J([rv.status, rv.rows.map(r => [r.model_id, r.state]), stub.models.get(1), stub.puts]));
      });
      // MED-3：首跑 applied 后原样重跑——伴生行已是新派生值，不算未完成 ⇒ 重跑 applied、未完成清单为空
      await withStub([P1, Pc2], async (stub) => {
        const a = await sApply(stub, L1c);
        const b = await sApply(stub, L1c);
        check('MED-3 首跑 applied（父 + 伴生 written）后原样重跑：父行 already-target、伴生已是新派生值 ⇒ status applied，未完成清单为空，零新增 PUT（共 2 次）',
          a.status === 'applied' && rowState(b, 'parent', 1) === 'already-target' && b.status === 'applied' && b.unfinished.length === 0 && stub.puts === 2 && stub.models.get(2).table_comment === A_COMP_NEW, J([a.status, b.status, b.unfinished, stub.puts]));
      });
      // MED-4：PUT 返回 200 但 config_rev 被别的写入递增 ⇒ apply 行 error 停止；回执 after_meta 为空；随后 revert 因版本不符 409 ⇒ skipped-modified 不写
      await withStub([P1, { id: 7, table_name: 's_second', table_comment: C_OLD }], async (stub) => {
        stub.putMode = (id) => (id === 1 ? 'commit-bump-rev-reply' : 'normal');
        const rcp = newReceipt();
        const res = await sApply(stub, L2c, { receipt: rcp });
        const x1 = readJ(rcp).rows.find(r => r.model_id === 1);
        check('MED-4 apply：200 但 config_rev 被改 ⇒ 行 1 error 并停止、行 7 not-processed、status failed、只 1 次 PUT；回执该行 put_sent = true、after_meta 为 null',
          rowState(res, 'parent', 1) === 'error' && rowState(res, 'parent', 7) === 'not-processed' && res.status === 'failed' && stub.puts === 1 && x1 && x1.put_sent === true && x1.after_meta === null && x1.before_meta.config_rev === 1, J([res.rows.map(r => [r.model_id, r.state]), res.status, x1]));
        stub.putMode = null;
        const from = stub.puts;
        const rv = await safeRevert(revOpts(stub, rcp));
        check('MED-4 revert：行 1 当前值 = target 但 config_rev 已是 2 ⇒ 条件写带 expected_config_rev = 1 ⇒ 409 ⇒ skipped-modified，值保持新值，status partial',
          rowState(rv, 'revert', 1) === 'skipped-modified' && rv.status === 'partial' && stub.puts - from === 1 && (bodyOf(stub, 1, from) || {}).expected_config_rev === 1 && stub.models.get(1).table_comment === A_NEW && stub.models.get(1).config_rev === 2, J([rv.rows.map(r => [r.model_id, r.state]), rv.status, stub.putBodies.slice(from)]));
      });

      // ═══════════════ 修复 4（codex 24-R3 / R3TA / R3TB）：Y2 / Y6 / Y7 / Y8 ═══════════════
      // Y2：清单 new_impl_note 空串 / null 语义——首跑后重跑不得每次重写；当前 impl_note 为空串 / 清单为 null ⇒ 不改 impl_note
      await withStub([{ id: 1, table_name: 's_parent', table_comment: A_OLD }], async (stub) => {
        const LY = [{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: '' }];
        const a = await sApply(stub, LY);
        const b = await sApply(stub, LY);
        check('Y2 清单 new_impl_note 为空串（视同 null = 不改 impl_note）：首跑只写表注释（1 次 PUT，impl_note 仍 NULL），重跑 already-target、applied、零新增 PUT',
          rowState(a, 'parent', 1) === 'written' && a.status === 'applied' && rowState(b, 'parent', 1) === 'already-target' && b.status === 'applied' && b.unfinished.length === 0 && stub.puts === 1 && stub.models.get(1).table_comment === A_NEW && stub.models.get(1).impl_note === null, J([a.status, b.status, stub.puts, stub.models.get(1)]));
      });
      await withStub([{ id: 1, table_name: 's_parent', table_comment: A_NEW, impl_note: '' }], async (stub) => {
        const res = await sApply(stub, [{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: null }]);
        check('Y2 当前 impl_note 为空串、清单 new_impl_note 为 null、表注释已是新值 ⇒ already-target（applied），零 PUT，impl_note 不被清空 / 改写', rowState(res, 'parent', 1) === 'already-target' && res.status === 'applied' && stub.puts === 0 && stub.models.get(1).impl_note === '', J([res.rows.map(r => [r.model_id, r.state]), res.status, stub.puts]));
      });
      await withStub([{ id: 1, table_name: 's_parent', table_comment: A_OLD, impl_note: '手写的实现说明' }], async (stub) => {
        const res = await sApply(stub, [{ model_id: 1, old_table_comment: A_OLD, new_table_comment: A_NEW, new_impl_note: '另一份说明' }]);
        check('Y2 已有不同 impl_note、清单给了新说明 ⇒ skipped-modified，零 PUT（脚本从不覆盖已有 impl_note）', rowState(res, 'parent', 1) === 'skipped-modified' && stub.puts === 0 && stub.models.get(1).impl_note === '手写的实现说明', J([res.rows.map(r => [r.model_id, r.state]), stub.puts]));
      });
      // Y6：跨回执衔接要求 kind 相同、伴生行 parent_id 相同——每份回执各自自洽、值也衔接，但 kind / parent_id 不同 ⇒ 拒绝，零请求
      await withStub([P1, Pc2], async (stub) => {
        const rA = newReceipt();
        await sApply(stub, L1c, { receipt: rA });
        const jA = readJ(rA);
        const rowA = jA.rows.find(r => r.model_id === 2);   // 伴生行：kind companion、parent_id 1，target = 新派生值
        const mkNewer = (mutateRow) => {
          const row = JSON.parse(JSON.stringify(rowA));
          row.before = { ...row.before, table_comment: rowA.target.table_comment, impl_note: rowA.target.impl_note };   // 衔接：较新 before = 较旧 target
          row.target = { table_comment: '更新的短名 - 变更追踪', impl_note: null };
          mutateRow(row);
          const f = newReceipt();
          fs.writeFileSync(f, J({ ...jA, started_at: new Date(Date.parse(jA.started_at) + 60000).toISOString(), finished_at: null, rows: [row] }));
          return f;
        };
        const asParent = mkNewer(r => { r.kind = 'parent'; r.parent_id = null; r.before.companion_of = null; r.before_meta.companion_of = null; });
        const otherParent = mkNewer(r => { r.parent_id = 9; r.before.companion_of = 9; r.before_meta.companion_of = 9; });
        const sameOk = mkNewer(() => { });
        const n0 = stub.reqs.length;
        const m1 = await revertThrows(revOpts(stub, [rA, asParent]));
        const m2 = await revertThrows(revOpts(stub, [rA, otherParent]));
        check('Y6 跨回执 kind 不同（较新回执同一 model_id 是 parent、较旧是 companion；各自自洽、值衔接）⇒ 拒绝并说明 kind / parent_id，桩零请求', m1 !== null && /回执链 kind \/ parent_id 不一致/.test(m1) && stub.reqs.length === n0, String(m1));
        check('Y6 跨回执伴生 parent_id 不同（1 vs 9）⇒ 拒绝并说明，桩零请求', m2 !== null && /回执链 kind \/ parent_id 不一致/.test(m2) && stub.reqs.length === n0, String(m2));
        const ok = await safeRevert({ ...revOpts(stub, [rA, sameOk]), dryRun: true });
        check('Y6 对照：kind / parent_id 相同且值衔接的两份回执通过链校验（干跑无错误）', ok.errors.length === 0 && !/threw/.test(ok.status), J([ok.status, ok.errors]));
      });
      // Y7：PUT 已成功（written）之后，记结果的那次 flush 的 rename 用尽重试 ⇒ 抛错；磁盘回执仍可解析、该行 writing + put_sent = true；用这份回执 revert 能还原
      await withStub([P1], async (stub) => {
        const origRename = M._ops.rename;
        let okLeft = 3;   // 初始 / 记入清单行 / put_sent（writing）三次落盘成功，第 4 次（PUT 成功后记 written）起一直 EPERM
        M._ops.rename = (a, b) => { if (okLeft > 0) { okLeft--; return origRename(a, b); } const e = new Error('EPERM: 回执一直被占用（结果 flush）'); e.code = 'EPERM'; throw e; };
        const rcp = newReceipt();
        let err = null;
        try { await sApply(stub, L1c, { receipt: rcp }); } catch (e) { err = e; } finally { M._ops.rename = origRename; }
        let parsed = null; try { parsed = readJ(rcp); } catch (_) { /* 断言里报 */ }
        const x = parsed && parsed.rows.find(r => r.model_id === 1);
        check('Y7 PUT 成功后结果 flush 失败：apply 抛 EPERM（命令行入口会以退出码 1 结束）、桩里已是新值（1 次 PUT）、磁盘回执仍可解析、status running、该行仍是 writing 且 put_sent = true（before / target 齐全）、无 .tmp 残留',
          err && /EPERM/.test(err.message) && stub.puts === 1 && stub.models.get(1).table_comment === A_NEW && x && x.state === 'writing' && x.put_sent === true && x.before.table_comment === A_OLD && x.target.table_comment === A_NEW && parsed.status === 'running' && fs.readdirSync(receiptDir).every(f => !/\.tmp-/.test(f)), J([err && err.message, stub.puts, parsed]));
        // 复审 48（整批确认）：writing 行是结果未知——无 --inflight-cleared 的 revert 整次拒绝、零写入（旧断言：直接 reverted、共 2 次 PUT）；确认在途请求已终止后带 inflightCleared 才按 put_sent 还原
        const rvBlocked = await safeRevert(revOpts(stub, rcp));
        check('Y7 用这份回执 revert（不带 inflightCleared）：writing + put_sent 的行是结果未知 ⇒ 整次拒绝 blocked-inflight，零写入（PUT 仍只有 apply 的 1 次，行仍是新值）', rowState(rvBlocked, 'revert', 1) === 'blocked-inflight' && rvBlocked.status === 'blocked-inflight' && stub.puts === 1 && stub.models.get(1).table_comment === A_NEW, J([rvBlocked.rows.map(r => [r.model_id, r.state]), rvBlocked.status, stub.puts]));
        const rv = await safeRevert(revOpts(stub, rcp, { inflightCleared: true }));
        check('Y7 用这份回执 revert（带 inflightCleared）：writing + put_sent 的行按 put_sent 处理，当前值 = target ⇒ 条件写还原到 before，status reverted', rowState(rv, 'revert', 1) === 'reverted' && rv.status === 'reverted' && stub.models.get(1).table_comment === A_OLD && stub.models.get(1).impl_note === null, J([rv.rows.map(r => [r.model_id, r.state]), rv.status, stub.models.get(1)]));
        // Z4：revert 阶段唯一那次 PUT（第 2 次）的 body：expected = target、set = before、expected_config_rev = after_meta.config_rev（该行 after_meta 为 null，取 before_meta = 1）、父行带 parent_only 且不带 companion_of
        check('Z4 Y7 revert 的唯一一次 PUT body = { expected: target(员工信息 + 实现说明), set: before(原长注释, NULL), parent_only: true, expected_config_rev: 1 }，不带 companion_of；整个过程共 2 次 PUT',
          stub.puts === 2 && J(stub.putBodies[1]) === J({ expected: { table_comment: A_NEW, impl_note: A_IMPL }, set: { table_comment: A_OLD, impl_note: null }, parent_only: true, expected_config_rev: 1 }) && !('companion_of' in stub.putBodies[1]), J(stub.putBodies));
      });
      // Z1：apply 一次后原样重跑，第二份回执（含 already-target 行，table_comment 非空）能过 revert 结构校验（干跑）；单独给、与第一份一起给都不得被拒
      await withStub([P1, Pc2], async (stub) => {
        const rA = newReceipt(), rB = newReceipt();
        await sApply(stub, L1c, { receipt: rA });
        await settle(25);
        const b = await sApply(stub, L1c, { receipt: rB });
        const xb = readJ(rB).rows.find(r => r.model_id === 1);
        check('Z1 前提：第二份回执里行 1 是 already-target，before / target 的 table_comment 均非空', rowState(b, 'parent', 1) === 'already-target' && xb && xb.state === 'already-target' && xb.before.table_comment === A_NEW && xb.target.table_comment === A_NEW, J(xb));
        const only = await safeRevert({ ...revOpts(stub, rB), dryRun: true });
        const both = await safeRevert({ ...revOpts(stub, [rA, rB]), dryRun: true });
        check('Z1 第二份回执单独 revert --dry-run：通过结构校验（不被拒，行 1 列 not-written-by-these-receipts）', !/threw/.test(only.status) && only.errors.length === 0 && only.rows.some(r => r.model_id === 1 && r.state === 'not-written-by-these-receipts'), J([only.status, only.errors, only.rows.map(r => [r.model_id, r.state])]));
        check('Z1 两份回执一起 revert --dry-run：通过结构校验与链校验（不被拒），行 1 / 2 计划还原（write）', !/threw/.test(both.status) && both.errors.length === 0 && rowState(both, 'revert', 1) === 'write' && rowState(both, 'revert', 2) === 'write', J([both.status, both.errors, both.rows.map(r => [r.model_id, r.state])]));
      });
      // Z3：suggest 经 HTTP 取数只发 GET（桩收到的全部请求方法都是 GET，没有 PUT / POST）
      await withStub([P1, Pc2, { id: 7, table_name: 's_long', table_comment: A_OLD }], async (stub) => {
        const sg = await runner.suggest({ baseUrl: stub.url, tokenFile, timeoutMs: 400 });
        check('Z3 suggest 经 HTTP 取数：桩收到的所有请求方法都是 GET（至少 1 个请求，没有 PUT / POST），带 Authorization，并确有候选', stub.reqs.length >= 1 && stub.reqs.every(r => r.method === 'GET' && r.auth === `Bearer ${adminToken}`) && stub.puts === 0 && sg.report.items.length >= 1, J([stub.reqs.map(r => r.method + ' ' + r.url), stub.puts]));
      });
      // Y8：revert 侧 PUT 超时分支——PUT 恰一次、重读 GET 次数、body（expected = target、set = before、expected_config_rev = 回执 after_meta、父行 parent_only、伴生行 companion_of = 回执 parent_id）
      for (const [mode, label, wantState] of [['commit-no-reply', '已提交', 'done'], ['hang-no-apply', '未提交', 'timeout-unknown-not-applied']]) {
        await withStub([{ ...P1, config_rev: 3 }, { ...Pc2, config_rev: 3 }], async (stub) => {
          const rcp = newReceipt();
          await sApply(stub, L1c, { receipt: rcp });
          const rcj = readJ(rcp);
          stub.putMode = () => mode;
          const g0 = stub.getUrls.length, p0 = stub.puts;
          const rv = await safeRevert(revOpts(stub, rcp, { timeoutMs: 300 }));
          const gets = stub.getUrls.slice(g0);
          const wantComp = J({ expected: { table_comment: A_COMP_NEW, impl_note: null }, set: { table_comment: A_COMP_OLD, impl_note: null }, companion_of: 1, expected_config_rev: 3 });
          const wantPar = J({ expected: { table_comment: A_NEW, impl_note: A_IMPL }, set: { table_comment: A_OLD, impl_note: null }, parent_only: true, expected_config_rev: 3 });
          check(`Y8 revert PUT 超时（${label}）：回执 after_meta.config_rev = 3；伴生 2 先、父行 1 后各恰 1 次 PUT（共 2 次，不重试），每个 PUT 后恰 1 次重读 GET（GET 序列 2,2,1,1），两行状态 ${wantState}`,
            rcj.rows.every(r => r.after_meta && r.after_meta.config_rev === 3) && stub.puts - p0 === 2 && J(gets) === J(['/api/models/2', '/api/models/2', '/api/models/1', '/api/models/1']) && rowState(rv, 'revert', 2) === wantState && rowState(rv, 'revert', 1) === wantState, J([stub.puts - p0, gets, rv.rows.map(r => [r.model_id, r.state])]));
          check(`Y8 revert PUT 超时（${label}）：伴生 PUT body = { expected: 新派生值, set: 写前值, companion_of: 回执 parent_id (1), expected_config_rev: 3 }；父行 PUT body = { expected: target, set: before, parent_only: true, expected_config_rev: 3 }`,
            J(bodyOf(stub, 2, p0)) === wantComp && J(bodyOf(stub, 1, p0)) === wantPar, J(stub.putBodies.slice(p0)));
        });
      }

      // X6 状态机总断言：桩上跑出的全部 apply / revert 结果——出现 error 行 / errors 后最终状态必为 failed，不得是 applied / reverted；停止的运行 stopped 为真
      check('X6 状态机：全部桩运行结果里，凡有 error（errors 非空或存在 error 行）⇒ status = failed 且 stopped = true；status 为 applied / reverted ⇒ 没有 error',
        tracked.length > 30 && tracked.every(r => { const hasErr = r.errors.length > 0 || r.rows.some(x => x.state === 'error'); return (!hasErr || (r.status === 'failed' && r.stopped === true)) && (!['applied', 'reverted'].includes(r.status) || !hasErr); }), J(tracked.filter(r => { const hasErr = r.errors.length > 0 || r.rows.some(x => x.state === 'error'); return hasErr && !(r.status === 'failed' && r.stopped === true); }).map(r => [r.status, r.stopped, r.errors])) + ` n=${tracked.length}`);
    } finally {
      await rd.close();
      if (stubServer) await new Promise(r => stubServer.close(r));
    }

    // ── suggest --db 指向（注入的）正式库路径：被拒 ──
    fs.copyFileSync(dbPath, fakeLive);
    const fakeHash = sha(fakeLive);
    const liveRunner = M.createRunner({ liveDb: fakeLive });
    await check_rejects('suggest：--db 指向注入的正式库路径被拒（改用 --base-url 经 HTTP 取数）', () => liveRunner.suggest({ db: fakeLive }), /拒绝指向 wbs-server\/task_pool\.db.*--base-url/);
    // 硬链接（同一文件的另一个名字）：dev + ino 比对也拒（ino 为 0 的文件系统上该层失效——登记不改，suggest 只读打开）
    const hardLink = path.join(runDir, 'hard-link.db');
    let linked = false;
    try { fs.linkSync(fakeLive, hardLink); linked = true; } catch (_) { /* 文件系统不支持硬链接则跳过该用例 */ }
    if (linked) await check_rejects('suggest：--db 是正式库的硬链接（dev + ino 相同）也拒', () => liveRunner.suggest({ db: hardLink }), /拒绝指向 wbs-server\/task_pool\.db/);
    check('被拒后：该库文件哈希不变（未被读写）', sha(fakeLive) === fakeHash, '被拒的库被改动');
    if (!CUSTOM_SCRIPT) check('默认运行器的正式库路径 = wbs-server/task_pool.db（仅比对路径字符串，不打开）', M.DEFAULT_RUNNER.liveDb === path.resolve(H.ROOT, 'task_pool.db') && M.DEFAULT_LIVE_DB === M.DEFAULT_RUNNER.liveDb, M.DEFAULT_RUNNER.liveDb);
    // 命令行：无默认库 / 互斥模式 / apply 与 revert 传 --db
    const c1 = cli('--suggest');
    check('命令行 --suggest 不给 --db 也不给 --base-url：报错退出（没有默认库）', c1.status === 1 && /必须给 --db/.test(c1.stderr || ''), `${c1.status} ${c1.stderr}`);
    const c2 = cli('--suggest', '--apply', '--db', dbPath);
    check('命令行 --suggest 与 --apply 同时给出：报错退出', c2.status === 1 && /只能选一个/.test(c2.stderr || ''), `${c2.status} ${c2.stderr}`);
    const c3 = cli('--revert', '--migration-id', 'x', '--db', dbPath, '--base-url', 'http://127.0.0.1:1', '--token-file', tokenFile, '--receipt', path.join(runDir, 'receipts', 'rcp-1.json'));
    check('命令行 --revert 传 --db：报错退出并说明新用法', c3.status === 1 && /不再接受 --db/.test(c3.stderr || ''), `${c3.status} ${c3.stderr}`);
    const c4 = cli('--apply', '--list', path.join(runDir, 'final.json'), '--migration-id', 'x', '--base-url', 'http://127.0.0.1:1', '--token-file', tokenFile);
    check('命令行 --apply 缺 --receipt：报错退出', c4.status === 1 && /必须给 --receipt/.test(c4.stderr || ''), `${c4.status} ${c4.stderr}`);
    const c5 = cli('--apply', '--backup-db', 'x.db');
    check('命令行 --backup-db 已不存在（备份库子系统已删除）：当作未知参数报用法退出', c5.status === 1 && /用法/.test(c5.stderr || ''), `${c5.status} ${c5.stderr}`);
    check('前提：服务运行期间测试进程写库次数 = 0（夹具只在服务停止时写）', gate.writes === 0, `writes=${gate.writes}`);
  } finally {
    await svc.stop();
    H.removeTree(runDir);
  }
  const failed = results.filter(r => !r.ok);
  console.log(`verify-model-table-comment-migration PASS=${results.length - failed.length} FAIL=${failed.length}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

/**
 * 可编程桩服务（内存模型）：GET /api/models、GET /api/models/:id、PUT /api/models/:id/comment-split。
 * 条件写与真服务同语义（行存在且未删除、table_comment / impl_note 按 NULL 安全 IS 比较、带 companion_of 时须仍等于它；不满足 409 + current）。
 * 注入点（同步屏障）：hooks.onGet(id, st)（GET 单行前）、hooks.beforePut(id, body, st)（条件判定前，模拟「GET 之后、写之前被别人改」）、hooks.afterApply(id, st)（写入后）。
 * 行为开关：hangAll（永不响应）、hangGetIds（这些 id 的单行 GET 永不响应）、hangGetAfterPut（首次 PUT 之后的单行 GET 永不响应）、
 *   putMode(id) → 'normal' | 'error500' | 'commit-no-reply'（提交但不回响应）| 'commit-bump-rev-no-reply'（提交 + config_rev 被别的写入递增 + 不回响应）| 'hang-no-apply'（不提交也不回）| 'mutate-hang'（把行改成另一个值且不回）。
 */
async function makeStub(models) {
  const st = {
    models: new Map(models.map(m => [m.id, { impl_note: null, companion_of: null, is_deleted: 0, config_rev: 1, ...m }])),
    puts: 0, putUrls: [], putBodies: [], hooks: {}, hangAll: false, hangGetIds: new Set(), hangGetAfterPut: false, putMode: null,
    reqs: [], getUrls: [],   // X3 / X8：到达桩的全部请求（含 Authorization 头）与单行 / 列表 GET 的 URL 序列
  };
  const eq = (a, b) => (a === undefined ? null : a) === (b === undefined ? null : b);
  const conns = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => { raw += d; });
    req.on('end', () => {
      st.reqs.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
      if (req.method === 'GET') st.getUrls.push(req.url);
      if (st.hangAll) return;
      const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      const sendText = (code, text) => { res.statusCode = code; res.setHeader('Content-Type', 'text/plain'); res.end(text); };
      const m = /^\/api\/models(?:\/(\d+))?(\/comment-split)?$/.exec(req.url.split('?')[0]);
      if (!m) return send(404, { error: 'not found' });
      const id = m[1] ? Number(m[1]) : null;
      if (req.method === 'GET' && id === null) return send(200, [...st.models.values()]);
      if (req.method === 'GET') {
        if (st.hooks.onGet) st.hooks.onGet(id, st);
        if (st.hangGetIds.has(id) || (st.hangGetAfterPut && st.puts > 0)) return;
        const row = st.models.get(id);
        return row ? send(200, row) : send(404, { error: '模型不存在' });
      }
      if (req.method === 'PUT' && m[2]) {
        const body = JSON.parse(raw || '{}');
        st.puts++; st.putUrls.push(req.url); st.putBodies.push(body);
        if (!body.set || typeof body.set.table_comment !== 'string' || body.set.table_comment.trim() === '') return send(400, { error: '请求体须为 { expected, set }（set.table_comment 非空字符串）' });   // MED-2：与真接口同口径
        const mode = st.putMode ? st.putMode(id) : 'normal';
        if (mode === 'error500') return send(500, { error: 'boom' });
        if (mode === 'error500-nonjson') return sendText(500, '<html>upstream exploded</html>');   // X8：响应体不是 JSON
        if (mode === 'conflict-nonjson') return sendText(409, 'conflict (not json)');
        if (mode === 'put404') return sendText(404, 'Cannot PUT /api/models/x/comment-split');
        if (mode === 'hang-no-apply') return;
        if (st.hooks.beforePut) st.hooks.beforePut(id, body, st);
        const row = st.models.get(id);
        if (mode === 'mutate-hang') { if (row) row.table_comment = '超时期间被改成了别的值'; return; }
        const ok = row && !row.is_deleted && eq(row.table_comment, body.expected.table_comment) && eq(row.impl_note, body.expected.impl_note)
          && (body.companion_of === undefined || row.companion_of === body.companion_of)
          && (body.parent_only !== true || row.companion_of == null)
          && (body.expected_config_rev === undefined || row.config_rev === body.expected_config_rev);   // X1：与真服务同语义的版本条件
        if (!ok) return send(409, { error: 'precondition_failed', current: row ? { table_comment: row.table_comment, impl_note: row.impl_note, companion_of: row.companion_of, is_deleted: row.is_deleted, config_rev: row.config_rev } : null });
        row.table_comment = body.set.table_comment;
        row.impl_note = body.set.impl_note === '' ? null : body.set.impl_note;
        if (st.hooks.afterApply) st.hooks.afterApply(id, st);
        if (mode === 'commit-no-reply') return;
        if (mode === 'commit-bump-rev-reply') { row.config_rev += 1; return send(200, { message: 'ok' }); }   // MED-4：提交 + config_rev 被别的写入递增 + 正常回 200
        if (mode === 'commit-bump-rev-no-reply') { row.config_rev += 1; return; }   // 提交后期间有别的写入递增了 config_rev，且不回响应
        return send(200, { message: 'ok' });
      }
      return send(405, { error: 'method' });
    });
  });
  server.on('connection', s => { conns.add(s); s.on('close', () => conns.delete(s)); });
  await listenOnSafePort(server);
  st.url = `http://127.0.0.1:${server.address().port}`;
  st.close = () => new Promise(r => { for (const s of conns) s.destroy(); server.close(() => r()); });
  return st;
}

async function check_rejects(name, fn, re) {
  let msg = null;
  try { await fn(); } catch (e) { msg = e.message; }
  check(name, msg !== null && re.test(msg), msg === null ? '没有抛错' : msg);
}

if (require.main === module) {
  main().catch((e) => { console.log(`FAIL 套件异常：${e && e.stack || e}`); process.exitCode = 1; }).finally(() => {
    H.runCleanupsSync();
    if (H.cleanupFailures.length) { console.log(`FAIL 清理复查：${H.cleanupFailures.length} 项未通过\n  ${H.cleanupFailures.join('\n  ')}`); process.exitCode = 1; }
  });
}
