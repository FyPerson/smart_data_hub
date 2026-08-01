/**
 * S1 verify e2e · 零星事项台账（快速通道）后端（sys_quick_log）
 * 方案 docs/local/系统迭代/系统迭代_零星事项台账_方案_20260801_v0.1.md
 *
 * 覆盖：非 admin 逐端点 403 → CRUD 正环（含 title 派生随 description 变化、updated_at 变化）→
 *       category 白名单负例 + category_note 归一（other 保留/非 other 强制 NULL）→ 标题派生
 *       （多行取首行·>40 code point 截断且不切碎 emoji）→ 日期（非法格式/2026-02-30 400 + DB CHECK
 *       独立防线直插断言）→ requester 全空 NULL 语义 + 列表排序 COALESCE(end_date,date(created_at))
 *       倒序 → 附件（合法/白名单外拒/数量超限拒·下载往返·删除·路径越界拦截·主记录删除级联）→ 404 族。
 *
 * harness 范式对齐 scripts/verify-issue-lite-c2.js 等既有 issue_lite 系列（grep 逐个核实：全部直接
 * 跑在真实 dev task_pool.db 上，非临时库副本），自启 PORT=3399、按端口精确杀、跑完清理测试行 + 落盘附件。
 *
 * 用法：node scripts/verify-quick-log.js
 */
'use strict';
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');

const TEST_PORT = 3399;
const BASE = `http://localhost:${TEST_PORT}`;
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'task_pool.db');
const UPLOAD_BASE = path.join(ROOT, 'uploads', 'quick-log');
const ADMIN_ID = fx.ADMIN_ID;      // 1，admin
const NONADMIN_ID = fx.CONTACT_ID; // 3，role=user（非 admin）
const PREFIX = '[QLVERIFY]';

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
    if (cond) { pass++; results.push(`  ✅ ${name}`); }
    else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}
async function api(method, urlPath, token, body) {
    const opts = { method, headers: {} };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) { /* 下载类端点非 json */ }
    return { status: r.status, body: j, raw: r };
}
async function apiUpload(urlPath, token, fields) {
    // fields: { fileName, content, extraNoFile }
    const form = new FormData();
    if (!fields.noFile) {
        form.append('files', new Blob([fields.content !== undefined ? fields.content : 'quick-log verify content']), fields.fileName || 'test.txt');
    }
    const opts = { method: 'POST', headers: {}, body: form };
    if (token) opts.headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) { /* ignore */ }
    return { status: r.status, body: j };
}
// netstat 精确端口比较（findstr 子串匹配会误命中，对齐 verify-issue-lite-c2 范式）
function killPort(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', shell: 'cmd.exe' });
        const pids = new Set();
        out.split(/\r?\n/).forEach(line => {
            const cols = line.trim().split(/\s+/);
            if (cols.length >= 5 && cols[0] === 'TCP' && /LISTENING/i.test(cols[3])) {
                const m = cols[1].match(/:(\d+)$/);
                if (m && Number(m[1]) === port) pids.add(cols[4]);
            }
        });
        pids.forEach(pid => { try { execSync(`taskkill /F /PID ${pid}`, { shell: 'cmd.exe' }); } catch (_) { /* ignore */ } });
    } catch (_) { /* ignore */ }
}
function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_FILE);
        db.all(sql, params || [], (err, rows) => { db.close(); err ? reject(err) : resolve(rows); });
    });
}
function dbRun(sql, params) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(DB_FILE);
        db.run(sql, params || [], function (err) { db.close(); resolve({ err, lastID: this && this.lastID, changes: this && this.changes }); });
    });
}
async function cleanupTestRows() {
    try {
        const rows = await dbAll(`SELECT id FROM sys_quick_log WHERE description LIKE ?`, [PREFIX + '%']);
        for (const r of rows) {
            const atts = await dbAll(`SELECT file_name FROM sys_quick_log_attachments WHERE quick_log_id = ?`, [r.id]);
            for (const a of atts) {
                try { const p = path.join(ROOT, 'uploads', a.file_name); if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignore */ }
            }
        }
        await dbRun(`DELETE FROM sys_quick_log_attachments WHERE quick_log_id IN (SELECT id FROM sys_quick_log WHERE description LIKE ?)`, [PREFIX + '%']);
        await dbRun(`DELETE FROM sys_quick_log WHERE description LIKE ?`, [PREFIX + '%']);
    } catch (_) { /* 表可能还不存在（首次跑），忽略 */ }
}
async function waitReady(getLog, ms = 15000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        // 探测锚用"接口放行"稳定后缀而非表名文案——2026-08-01 复审收口改日志文案（表就绪→双表就绪）
        //   曾让旧探测串永不命中造成假红：教训=探测/断言别钉在会演进的展示性文案上，钉语义锚。
        if (/\[零星事项台账\] ✅ .*零星事项台账接口放行/.test(getLog())) {
            try { const r = await fetch(`${BASE}/api/quick-logs`); if (r.status === 401) return true; } catch (_) { /* ignore */ }
        }
        await new Promise(r => setTimeout(r, 400));
    }
    return false;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function baseBody(extra) {
    return Object.assign({
        category: 'tool',
        description: PREFIX + '基础校验用描述文本',
        result_note: '基础结果说明文本',
    }, extra || {});
}

(async () => {
    killPort(TEST_PORT);
    await cleanupTestRows();
    let log = '';
    const child = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(TEST_PORT), LOG_LEVEL: 'INFO' } });
    child.stdout.on('data', d => { log += d.toString(); });
    child.stderr.on('data', d => { log += d.toString(); });

    try {
        // ===== 组 0：静态断言——中间件顺序（codex S1 复审 HIGH 采纳）=====
        //   e2e 无法便捷构造"schema 未就绪"态（表首启即建，正常跑起来后必 ready），故用静态断言诚实覆盖
        //   顺序本身：读源文本，逐条路由注册行断言 requireAdmin 出现位置早于 requireQuickLogSchemaReady——
        //   消除"非 admin 在 schema 未就绪窗口看到 503+内部状态"的边界不一致（既有逐端点 403 断言全保留）。
        const routerSrcPath = path.join(ROOT, 'routes', 'quick-log', 'index.js');
        const routerSrc = fs.readFileSync(routerSrcPath, 'utf8');
        const regLines = routerSrc.split(/\r?\n/).filter(l => /router\.(get|post|put|delete)\(/.test(l));
        check('静态断言：找到全部8条路由注册行', regLines.length === 8, `实际 ${regLines.length} 行：${JSON.stringify(regLines.map(l => l.trim()))}`);
        const badOrderLines = regLines.filter(l => {
            const posAdmin = l.indexOf('requireAdmin');
            const posSchema = l.indexOf('requireQuickLogSchemaReady');
            return !(posAdmin >= 0 && posSchema >= 0 && posAdmin < posSchema);
        });
        check('静态断言：全部8条 requireAdmin 先于 requireQuickLogSchemaReady', badOrderLines.length === 0, JSON.stringify(badOrderLines.map(l => l.trim())));

        const ready = await waitReady(() => log);
        check('服务 + sys_quick_log schema 就绪', ready);
        if (!ready) throw new Error('服务未就绪：' + log.slice(-2000));

        // 直连 PRAGMA 断言附件表列齐（codex S1 复审 MED 采纳：readiness 补附件表复查后配一条直连验证）
        const attColsRows = await dbAll(`PRAGMA table_info("sys_quick_log_attachments")`);
        const attColNames = (attColsRows || []).map(rr => rr.name);
        const expectedAttCols = ['id', 'quick_log_id', 'file_name', 'original_name', 'file_size', 'mime_type', 'uploaded_by', 'uploaded_by_name', 'created_at'];
        check('直连 PRAGMA：sys_quick_log_attachments 9 列齐全', expectedAttCols.every(c => attColNames.includes(c)), JSON.stringify(attColNames));

        const adminTok = await fx.signAs(ADMIN_ID);
        const nonAdminTok = await fx.signAs(NONADMIN_ID);

        // ===== 组 1：非 admin 逐端点 403（+ 未鉴权 401 抽样，全 8 端点齐） =====
        check('未鉴权 GET 列表 → 401', (await api('GET', '/api/quick-logs')).status === 401);
        check('非admin GET 列表 → 403', (await api('GET', '/api/quick-logs', nonAdminTok)).status === 403);
        check('非admin POST 新建 → 403', (await api('POST', '/api/quick-logs', nonAdminTok, baseBody())).status === 403);
        check('非admin PUT 编辑 → 403', (await api('PUT', '/api/quick-logs/999999', nonAdminTok, baseBody())).status === 403);
        check('非admin DELETE 删除 → 403', (await api('DELETE', '/api/quick-logs/999999', nonAdminTok)).status === 403);
        check('非admin GET 附件清单 → 403', (await api('GET', '/api/quick-logs/999999/attachments', nonAdminTok)).status === 403);
        check('非admin POST 上传附件 → 403', (await apiUpload('/api/quick-logs/999999/attachments', nonAdminTok, {})).status === 403);
        check('非admin GET 下载附件 → 403', (await api('GET', '/api/quick-logs/attachments/999999/download', nonAdminTok)).status === 403);
        check('非admin DELETE 附件 → 403', (await api('DELETE', '/api/quick-logs/attachments/999999', nonAdminTok)).status === 403);

        // ===== 组 2：CRUD 正环 =====
        let r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + 'CRUD正环创建描述' }));
        check('创建 → 200 + title派生 + created_by=admin + requester为空NULL',
            r.status === 200 && r.body && r.body.item && r.body.item.title === PREFIX + 'CRUD正环创建描述'
            && r.body.item.created_by === ADMIN_ID && r.body.item.requester_name === null && r.body.item.requester_dept === null,
            JSON.stringify(r.body));
        const idCrud = r.body.item.id;
        const updatedAtAfterCreate = r.body.item.updated_at;

        let list = (await api('GET', '/api/quick-logs?category=tool&keyword=CRUD正环', adminTok)).body;
        check('列表 category+keyword 筛选含新单', list && Array.isArray(list.items) && list.items.some(x => x.id === idCrud) && list.total >= 1, JSON.stringify(list));
        let list2 = (await api('GET', '/api/quick-logs?category=demo&keyword=CRUD正环', adminTok)).body;
        check('列表 category 不匹配不含', list2 && Array.isArray(list2.items) && !list2.items.some(x => x.id === idCrud));

        await sleep(1100); // 跨过 SQLite datetime('now','localtime') 秒级分辨率，保证 updated_at 真实可比
        r = await api('PUT', `/api/quick-logs/${idCrud}`, adminTok, baseBody({ description: PREFIX + 'CRUD正环编辑后描述已改' }));
        check('编辑 → 200 + title 随 description 重派生 + updated_at 变化',
            r.status === 200 && r.body.item.title === PREFIX + 'CRUD正环编辑后描述已改' && r.body.item.updated_at !== updatedAtAfterCreate,
            JSON.stringify(r.body));

        r = await api('DELETE', `/api/quick-logs/${idCrud}`, adminTok);
        check('删除 → 200', r.status === 200 && r.body.success === true, JSON.stringify(r.body));
        r = await api('PUT', `/api/quick-logs/${idCrud}`, adminTok, baseBody());
        check('删除后编辑 → 404 QUICK_LOG_NOT_FOUND', r.status === 404 && r.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(r.body));

        // ===== 组 3：category 白名单 + category_note 归一 =====
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ category: 'bogus', description: PREFIX + 'category非法' }));
        check('category 非法 → 400 VALIDATION', r.status === 400 && r.body.code === 'VALIDATION', JSON.stringify(r.body));

        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ category: 'other', category_note: '其他类型备注内容', description: PREFIX + 'other备注保留' }));
        check('category=other 携带 category_note → 保留', r.status === 200 && r.body.item.category_note === '其他类型备注内容', JSON.stringify(r.body));
        const idOther = r.body.item.id;

        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ category: 'tool', category_note: '不该被存的备注', description: PREFIX + 'tool备注归一NULL' }));
        check('category=tool 携带 category_note → 归一 NULL（不报错）', r.status === 200 && r.body.item.category_note === null, JSON.stringify(r.body));
        const idNormNote = r.body.item.id;

        // ===== 组 4：标题派生 =====
        const shortDesc = PREFIX + '第一行标题\n第二行详情\n第三行详情';
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: shortDesc }));
        check('多行描述 → title 取首行', r.status === 200 && r.body.item.title === PREFIX + '第一行标题', JSON.stringify(r.body));
        const idMultiline = r.body.item.id;

        const longFirstLine = PREFIX + '中'.repeat(29) + '\u{1F600}' + 'X'.repeat(5); // prefix(10)+中29+emoji(1)=40码点 后接5个X触发截断
        const longDesc = longFirstLine + '\n第二行不影响截断判定';
        const expectedLongTitle = PREFIX + '中'.repeat(29) + '\u{1F600}' + '…';
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: longDesc }));
        check('超40 code point → 截断且不切碎 emoji + 追加省略号',
            r.status === 200 && r.body.item.title === expectedLongTitle && !r.body.item.title.includes('X'),
            JSON.stringify(r.body && r.body.item && r.body.item.title));
        const idLongTitle = r.body.item.id;

        // ===== 组 5：日期校验（服务端 + DB CHECK 双防线） =====
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '开始日期格式非法', start_date: '2026/13/40' }));
        check('start_date 格式非法 → 400 START_DATE_INVALID', r.status === 400 && r.body.code === 'START_DATE_INVALID', JSON.stringify(r.body));
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '开始日期月内溢出', start_date: '2026-02-30' }));
        check('start_date=2026-02-30 服务端 → 400 START_DATE_INVALID', r.status === 400 && r.body.code === 'START_DATE_INVALID', JSON.stringify(r.body));
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '结束日期月内溢出', end_date: '2026-02-30' }));
        check('end_date=2026-02-30 服务端 → 400 END_DATE_INVALID', r.status === 400 && r.body.code === 'END_DATE_INVALID', JSON.stringify(r.body));

        // DB CHECK 独立防线：绕过 API 直插，证明约束不仅靠服务端校验
        const directCols = { category: 'tool', title: PREFIX + '直插测试', description: PREFIX + '直插测试描述', result_note: '直插结果说明', created_by: ADMIN_ID, created_by_name: 'admin' };
        const insStart = await dbRun(
            `INSERT INTO sys_quick_log (category,title,description,result_note,created_by,created_by_name,start_date) VALUES (?,?,?,?,?,?,?)`,
            [directCols.category, directCols.title, directCols.description, directCols.result_note, directCols.created_by, directCols.created_by_name, '2026-02-30']);
        check('DB 直插 start_date=2026-02-30 → CHECK 拒', insStart.err && /CHECK constraint failed/i.test(insStart.err.message), insStart.err && insStart.err.message);
        const insEnd = await dbRun(
            `INSERT INTO sys_quick_log (category,title,description,result_note,created_by,created_by_name,end_date) VALUES (?,?,?,?,?,?,?)`,
            [directCols.category, directCols.title, directCols.description, directCols.result_note, directCols.created_by, directCols.created_by_name, '2026-02-30']);
        check('DB 直插 end_date=2026-02-30 → CHECK 拒', insEnd.err && /CHECK constraint failed/i.test(insEnd.err.message), insEnd.err && insEnd.err.message);

        // ===== 组 6：requester 全空 + 列表排序 COALESCE(end_date, date(created_at)) 倒序 =====
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + 'SORTTEST早', end_date: '2020-01-01' }));
        const idSortEarly = r.body.item.id;
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + 'SORTTEST无', end_date: undefined }));
        const idSortNone = r.body.item.id;
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + 'SORTTEST晚', end_date: '2099-12-31' }));
        const idSortLate = r.body.item.id;
        const sortList = (await api('GET', '/api/quick-logs?keyword=SORTTEST', adminTok)).body;
        const order = (sortList && sortList.items || []).map(x => x.id);
        const posLate = order.indexOf(idSortLate), posNone = order.indexOf(idSortNone), posEarly = order.indexOf(idSortEarly);
        check('列表倒序：晚end_date在前 → 无end_date(今日) → 早end_date在后',
            posLate >= 0 && posNone >= 0 && posEarly >= 0 && posLate < posNone && posNone < posEarly,
            JSON.stringify({ posLate, posNone, posEarly, order }));

        // ===== 组 7：附件（合法/白名单外拒/数量超限拒·下载往返·删除·路径越界·主记录删除级联） =====
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '附件往返测试记录' }));
        const idAttRT = r.body.item.id;
        let up = await apiUpload(`/api/quick-logs/${idAttRT}/attachments`, adminTok, { fileName: 'legal.txt', content: 'hello-quick-log-verify-content' });
        check('合法扩展名(.txt)上传 → 200', up.status === 200 && up.body.success === true, JSON.stringify(up.body));
        const attIdRT = up.body.attachment.id;

        up = await apiUpload(`/api/quick-logs/${idAttRT}/attachments`, adminTok, { fileName: 'illegal.exe', content: 'MZ-fake-exe' });
        check('白名单外扩展名(.exe)上传 → 400', up.status === 400, JSON.stringify(up.body));

        let dl = await fetch(`${BASE}/api/quick-logs/attachments/${attIdRT}/download`, { headers: { Authorization: `Bearer ${adminTok}` } });
        const dlText = await dl.text();
        check('下载往返内容一致', dl.status === 200 && dlText === 'hello-quick-log-verify-content', `status=${dl.status} text=${dlText}`);

        r = await api('DELETE', `/api/quick-logs/attachments/${attIdRT}`, adminTok);
        check('删除单个附件 → 200', r.status === 200 && r.body.success === true, JSON.stringify(r.body));
        r = await api('GET', `/api/quick-logs/attachments/${attIdRT}/download`, adminTok);
        check('删除后再下载 → 404 ATTACHMENT_NOT_FOUND', r.status === 404 && r.body.code === 'ATTACHMENT_NOT_FOUND', JSON.stringify(r.body));

        // 路径越界拦截：直插一条伪造 file_name 指向本模块子树之外，验证下载端点 403 拦截
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '路径越界测试记录' }));
        const idPathEscape = r.body.item.id;
        const insEvil = await dbRun(
            `INSERT INTO sys_quick_log_attachments (quick_log_id, file_name, original_name) VALUES (?,?,?)`,
            [idPathEscape, '../evil-outside-quick-log.txt', 'evil.txt']);
        r = await api('GET', `/api/quick-logs/attachments/${insEvil.lastID}/download`, adminTok);
        check('伪造越界 file_name 下载 → 403 ILLEGAL_FILE_PATH', r.status === 403 && r.body.code === 'ILLEGAL_FILE_PATH', JSON.stringify(r.body));

        // 附件挂在不存在的主记录 → 404
        up = await apiUpload('/api/quick-logs/999999/attachments', adminTok, { fileName: 'x.txt', content: 'x' });
        check('上传附件于不存在主记录 → 404 QUICK_LOG_NOT_FOUND', up.status === 404 && up.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(up.body));
        r = await api('GET', '/api/quick-logs/attachments/999999/download', adminTok);
        check('下载不存在附件 → 404 ATTACHMENT_NOT_FOUND', r.status === 404 && r.body.code === 'ATTACHMENT_NOT_FOUND', JSON.stringify(r.body));
        r = await api('DELETE', '/api/quick-logs/attachments/999999', adminTok);
        check('删除不存在附件 → 404 ATTACHMENT_NOT_FOUND', r.status === 404 && r.body.code === 'ATTACHMENT_NOT_FOUND', JSON.stringify(r.body));

        // 数量超限（上限20）+ 主记录删除级联（表行 + 磁盘文件）
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + '附件数量上限测试记录' }));
        const idAttLimit = r.body.item.id;
        const limitAttIds = [];
        const limitFilePaths = [];
        let limitOk = true;
        for (let i = 0; i < 20; i++) {
            const u = await apiUpload(`/api/quick-logs/${idAttLimit}/attachments`, adminTok, { fileName: `f${i}.txt`, content: `content-${i}` });
            if (u.status !== 200) { limitOk = false; results.push(`  ⚠️ 第${i + 1}个附件上传非预期失败: ${JSON.stringify(u.body)}`); break; }
            limitAttIds.push(u.body.attachment.id);
        }
        check('连续上传20个附件全部成功（未触及上限前）', limitOk && limitAttIds.length === 20);
        const rows20 = await dbAll('SELECT file_name FROM sys_quick_log_attachments WHERE quick_log_id = ?', [idAttLimit]);
        rows20.forEach(rr => limitFilePaths.push(path.join(ROOT, 'uploads', rr.file_name)));
        // codex S1 审 MED 采纳后，数量上限判定并入条件 INSERT 原子执行（关并发竞态窗口）——
        //   状态码维持 400 ATTACHMENT_LIMIT 对齐 issue_lite 同款上限拒（server.js:14041），
        //   原子化只改判定时机不改错误码语义（主会话裁定：跨模块同名错误码不同状态=口径不一致）。
        const up21 = await apiUpload(`/api/quick-logs/${idAttLimit}/attachments`, adminTok, { fileName: 'f20.txt', content: 'content-20' });
        check('第21个附件上传 → 400 ATTACHMENT_LIMIT（对齐 issue_lite 同款）', up21.status === 400 && up21.body.code === 'ATTACHMENT_LIMIT', JSON.stringify(up21.body));
        const filesExistBeforeDelete = limitFilePaths.every(p => fs.existsSync(p));
        check('级联删除前：20个物理文件确实存在', filesExistBeforeDelete);

        r = await api('DELETE', `/api/quick-logs/${idAttLimit}`, adminTok);
        check('删除主记录（含20个附件）→ 200', r.status === 200, JSON.stringify(r.body));
        const remainRows = await dbAll('SELECT id FROM sys_quick_log_attachments WHERE quick_log_id = ?', [idAttLimit]);
        check('级联：附件表行归零', Array.isArray(remainRows) && remainRows.length === 0, JSON.stringify(remainRows));
        const filesGone = limitFilePaths.every(p => !fs.existsSync(p));
        check('级联：20个物理文件全部不存在', filesGone);

        // ===== 组 7b：GET /quick-logs/:id/attachments 新端点 + 列表 att_count 生命周期（主会话抽查补） =====
        //   非admin 403 已并入组 1（全 8 端点齐一处断言，去重，见 codex S1 复审 LOW 采纳）
        r = await api('POST', '/api/quick-logs', adminTok, baseBody({ description: PREFIX + 'att_count生命周期记录' }));
        const idAttCount = r.body.item.id;

        r = await api('GET', '/api/quick-logs/999999/attachments', adminTok);
        check('GET 附件列表(新端点)于不存在主记录 → 404 QUICK_LOG_NOT_FOUND', r.status === 404 && r.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(r.body));

        let listAC = (await api('GET', '/api/quick-logs?keyword=att_count生命周期', adminTok)).body;
        let rowAC = (listAC && listAC.items || []).find(x => x.id === idAttCount);
        check('新建 → 列表 att_count=0', rowAC && rowAC.att_count === 0, JSON.stringify(rowAC));

        let attListResp = await api('GET', `/api/quick-logs/${idAttCount}/attachments`, adminTok);
        check('新端点：新建后附件清单为空数组', attListResp.status === 200 && Array.isArray(attListResp.body.items) && attListResp.body.items.length === 0, JSON.stringify(attListResp.body));

        const uAC1 = await apiUpload(`/api/quick-logs/${idAttCount}/attachments`, adminTok, { fileName: 'ac1.txt', content: 'ac-content-1' });
        const uAC2 = await apiUpload(`/api/quick-logs/${idAttCount}/attachments`, adminTok, { fileName: 'ac2.txt', content: 'ac-content-2' });
        check('att_count 生命周期夹具：两次上传均成功', uAC1.status === 200 && uAC2.status === 200, JSON.stringify([uAC1.body, uAC2.body]));
        const attIdAC1 = uAC1.body.attachment.id, attIdAC2 = uAC2.body.attachment.id;

        listAC = (await api('GET', '/api/quick-logs?keyword=att_count生命周期', adminTok)).body;
        rowAC = (listAC && listAC.items || []).find(x => x.id === idAttCount);
        check('传2个 → 列表 att_count=2', rowAC && rowAC.att_count === 2, JSON.stringify(rowAC));

        attListResp = await api('GET', `/api/quick-logs/${idAttCount}/attachments`, adminTok);
        const acItems = (attListResp.body && attListResp.body.items) || [];
        check('新端点：字段齐全（不泄露file_name）+ 按id正序',
            attListResp.status === 200 && acItems.length === 2
            && acItems[0].id === attIdAC1 && acItems[1].id === attIdAC2
            && acItems.every(a => 'id' in a && 'original_name' in a && 'file_size' in a && 'mime_type' in a && 'uploaded_by_name' in a && 'created_at' in a && !('file_name' in a)),
            JSON.stringify(attListResp.body));

        await api('DELETE', `/api/quick-logs/attachments/${attIdAC1}`, adminTok);
        listAC = (await api('GET', '/api/quick-logs?keyword=att_count生命周期', adminTok)).body;
        rowAC = (listAC && listAC.items || []).find(x => x.id === idAttCount);
        check('删1个 → 列表 att_count=1', rowAC && rowAC.att_count === 1, JSON.stringify(rowAC));

        await api('DELETE', `/api/quick-logs/${idAttCount}`, adminTok);
        r = await api('GET', `/api/quick-logs/${idAttCount}/attachments`, adminTok);
        check('主删后再查附件列表(新端点) → 404 QUICK_LOG_NOT_FOUND', r.status === 404 && r.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(r.body));

        // ===== 组 8：404 族（改/删/挂附件于不存在 id，补充覆盖） =====
        r = await api('PUT', '/api/quick-logs/999999', adminTok, baseBody());
        check('编辑不存在 id → 404 QUICK_LOG_NOT_FOUND', r.status === 404 && r.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(r.body));
        r = await api('DELETE', '/api/quick-logs/999999', adminTok);
        check('删除不存在 id → 404 QUICK_LOG_NOT_FOUND', r.status === 404 && r.body.code === 'QUICK_LOG_NOT_FOUND', JSON.stringify(r.body));

        // 清理本轮剩余记录（部分记录未在流程内被删除：idOther/idNormNote/idMultiline/idLongTitle/
        //   idSortEarly/idSortNone/idSortLate/idAttRT/idPathEscape 及其附件行——finally 里统一按描述前缀扫清）
        void idOther; void idNormNote; void idMultiline; void idLongTitle; void idSortEarly; void idSortNone; void idSortLate; void idAttRT; void idPathEscape;

    } catch (e) {
        check('e2e 执行异常', false, e.message + '\n' + (e.stack || ''));
    } finally {
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
        killPort(TEST_PORT);
        await cleanupTestRows();
        // 兜底清理可能残留的越界测试文件目录（正常路径下不会有本模块外文件被创建，仅防御性 no-op）
        try { if (fs.existsSync(UPLOAD_BASE)) { /* 目录本身保留供下次复用，不删除 */ } } catch (_) { /* ignore */ }
    }

    console.log('─────── 零星事项台账 S1 verify e2e 结果 ───────');
    results.forEach(l => console.log(l));
    console.log(`\n总判定：${fail === 0 ? '✅ PASS' : '❌ FAIL'}（${pass} 通过 / ${fail} 失败）`);
    process.exit(fail === 0 ? 0 : 1);
})();
