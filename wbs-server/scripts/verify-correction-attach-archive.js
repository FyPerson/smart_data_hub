// verify-correction-attach-archive.js — 数据修正 附件压缩包支持（附件压缩包支持方案 D4/D5/D12，C2 阶段）
//   覆盖方案 §5：V1 / V2b / V3 / V3u（修正五组）/ V6a-V6f
//   用法：node scripts/verify-correction-attach-archive.js
//   范式：router-mount + in-memory db + require-cache mock 钉钉（同 verify-correction-rework-notify.js/
//   verify-correction-notify-done-e2e.js），四挂点用直插 correction_requests 行的方式造态（不跑完整状态机，
//   本文件只测「附件二次卡」与「钉钉三态发送判据」两件事，不重复覆盖既有 verify-correction-transition.js
//   已验证过的状态机本身）。
'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const sqlite3 = require('sqlite3');
const { ARCHIVE_MAX_SIZE, isArchiveExt } = require('../utils/attachment-archive');

// ── require-cache mock 钉钉（必须在 require corrections 之前）：计数 uploadMedia/sendFileToUser/markdown ──
let MK = 100;
const CALLS = { uploadMedia: 0, sendFileToUser: 0, sendMarkdownToUser: 0 };
const SENDS = [];
let SEND_FILE_FAIL = false;    // 可控：sendFileToUser 是否失败（V6f 不需要，留作扩展）
let MARKDOWN_FAIL = false;     // 可控：sendMarkdownToUser 是否失败（V6f）
function resetDingtalkStubState() {
    CALLS.uploadMedia = 0; CALLS.sendFileToUser = 0; CALLS.sendMarkdownToUser = 0;
    SENDS.length = 0; SEND_FILE_FAIL = false; MARKDOWN_FAIL = false;
}
const dtPath = require.resolve('../utils/dingtalk-notify');
require.cache[dtPath] = { id: dtPath, filename: dtPath, loaded: true, exports: {
    getAccessToken: async () => 'tok',
    resolveRequesterDingUserId: async (t, phone) => ({ ok: true, userid: 'uid_' + phone }),
    sendMarkdownToUser: async (t, robot, uids, title, md) => {
        CALLS.sendMarkdownToUser++;
        SENDS.push({ title, md, uids });
        if (MARKDOWN_FAIL) return { errcode: 1, errmsg: 'stub markdown fail' };
        return { errcode: 0, processQueryKey: 'mk_' + (MK++) };
    },
    sendFileToUser: async () => { CALLS.sendFileToUser++; return SEND_FILE_FAIL ? { errcode: 1 } : { errcode: 0 }; },
    uploadMedia: async () => { CALLS.uploadMedia++; return 'media1'; },
    getReadStatus: async () => ({ readDetails: [] }),
    escapeMarkdown: (x) => x,
    classifyError: () => ({ reason: 'exception', hint: 'err' }),
} };

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'correction-archive-'));
const db = new sqlite3.Database(':memory:');
const dbRunAsyncReal = (q, p = []) => new Promise((res, rej) => db.run(q, p, function (e) { e ? rej(e) : res(this); }));
// codex 06 M2：定点故障注入——一次性谓词，命中即让该次 dbRunAsync 抛错（模拟"钉钉已发但落库失败"），
//   不命中/已消耗则原样代理到真实 db.run。谓词传 null 表示当前无故障待注入。
let FAULT_PREDICATE = null;
const dbRunAsync = (q, p = []) => {
    if (FAULT_PREDICATE && FAULT_PREDICATE(q)) {
        FAULT_PREDICATE = null;   // 一次性：命中即消耗，不影响同一用例内后续其它 UPDATE
        return Promise.reject(new Error('注入故障：模拟通知落库失败（verify 一次性 dbRunAsync 拦截）'));
    }
    return dbRunAsyncReal(q, p);
};
const dbGetAsync = (q, p = []) => new Promise((res, rej) => db.get(q, p, (e, r) => e ? rej(e) : res(r)));
const dbAllAsync = (q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => e ? rej(e) : res(r)));
const noop = () => {};
const CONFIG = { dingtalk_app_key: 'k', dingtalk_app_secret: 's', dingtalk_robot_code: 'r' };

const deps = {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    db, dbRunAsync, dbGetAsync, dbAllAsync,
    authenticateToken: (req, res, next) => {
        const h = req.headers['x-test-user'];
        if (!h) return res.status(401).json({ error: 'no user' });
        try { req.user = JSON.parse(Buffer.from(h, 'base64').toString('utf8')); return next(); } catch (e) { return res.status(401).json({ error: 'bad user' }); }
    },
    requireAdmin: (req, res, next) => (req.user && req.user.role === 'admin') ? next() : res.status(403).json({ error: 'admin only' }),
    requirePublisherOrAdmin: (req, res, next) => (req.user && ['admin', 'publisher'].includes(req.user.role)) ? next() : res.status(403).json({ error: 'pub/admin only' }),
    sendIssueDingtalkRaw: async () => ({}),
    UPLOAD_DIR,
    readSystemConfig: async (key) => (CONFIG[key] != null ? CONFIG[key] : null),
    COLLAB_CHAT_ADMIN_ID: 3,
    callDingtalkWithTokenRetry: async (ak, as, tk, fn) => fn(tk),
    normalizeAttachmentExt: (name) => {
        // 与生产 server.js normalizeAttachmentExt 同序：先 trim 再查控制字符（方案 F7：首尾换行被 trim 掉后接受）——Opus 预筛 C2 L3 纠正夹具顺序
        const s = String(name || '').trim();
        if (!s) return '';
        if (/[\x00-\x1F\x7F]/.test(s)) return '';   // eslint-disable-line no-control-regex
        return path.extname(s).toLowerCase().trim();
    },
    safeDeleteFileSync: noop,
    maskPhone: (x) => x,
};

const mod = require('../routes/corrections')(deps);
const I = mod._internals;

let passed = 0;
const ok = (m) => { passed++; console.log('  ✓ ' + m); };

const ADMIN = { id: 1, username: 'admin', display_name: '管理员', role: 'admin' };
const DEV5 = { id: 5, username: 'dev5', display_name: '开发五', role: 'user' };

let PORT, srv;
function reqJson(method, p, body, user) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request({ host: 'localhost', port: PORT, method, path: p,
            headers: { 'Content-Type': 'application/json', 'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64'),
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
        r.on('error', e => resolve({ status: 0, error: e.message }));
        if (data) r.write(data); r.end();
    });
}
// multipart 上传：支持自定义文件名/内容/字段（用于建单 oa_proof_files 与 /complete /resubmit /attachments 的 files 字段）
function reqMultipart(method, p, fields, fileFieldName, fileName, fileBuf, user) {
    return new Promise((resolve) => {
        const boundary = '----CorrArchBoundary' + (p.length * 7919 + Date.now() + Math.floor(Math.random() * 1e6));
        const chunks = [];
        for (const [k, v] of Object.entries(fields || {})) {
            if (v === undefined || v === null) continue;
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
        }
        if (fileName) {
            chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileFieldName}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
            chunks.push(fileBuf || Buffer.from('x'));
            chunks.push(Buffer.from('\r\n'));
        }
        chunks.push(Buffer.from(`--${boundary}--\r\n`));
        const bodyBuf = Buffer.concat(chunks);
        const r = http.request({ host: 'localhost', port: PORT, method, path: p,
            headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': bodyBuf.length,
                'x-test-user': Buffer.from(JSON.stringify(user || ADMIN)).toString('base64') } },
            (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = {}; try { j = JSON.parse(d || '{}'); } catch (_) {} resolve({ status: res.statusCode, body: j }); }); });
        r.on('error', e => resolve({ status: 0, error: e.message }));
        r.write(bodyBuf); r.end();
    });
}
async function waitReady() {
    const t0 = Date.now();
    while (!I.CORRECTION_SCHEMA_STATE.ready) { if (I.CORRECTION_SCHEMA_STATE.error) throw new Error(I.CORRECTION_SCHEMA_STATE.error); if (Date.now() - t0 > 3000) throw new Error('timeout'); await new Promise(r => setTimeout(r, 30)); }
}

// 直插一条修正单（不跑完整状态机——本文件只测附件二次卡 + 钉钉发送判据，状态机本身由
//   verify-correction-transition.js 等既有套件覆盖）。correction_group_id 留空 → is_master 天然 true。
async function mkRow(o = {}) {
    const base = { source_system: 'BMS', location_info: 'loc', correction_count: 1, reason: '附件压缩包 C2 verify fixture 占位原因文本',
        correction_type: 'single', requester_name: '业务张', requester_phone: '13800000001', status: 'IN_PROGRESS',
        created_by: 1, created_by_name: '管理员', assigned_to: 5, assigned_to_name: '开发五', oa_number: 'datafix-fixture' };
    const row = { ...base, ...o };
    const keys = Object.keys(row);
    const r = await dbRunAsync(`INSERT INTO correction_requests (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    return r.lastID;
}
async function mkRequester(masterId, o = {}) {
    const base = { requester_name: '业务张', requester_phone: '13800000001', is_primary: 1, seq: 1, completion_notify_status: 'not_sent' };
    const row = { correction_request_id: masterId, ...base, ...o };
    const keys = Object.keys(row);
    const r = await dbRunAsync(`INSERT INTO correction_requesters (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
    return r.lastID;
}
async function mkAttachment(rid, attachmentType, fileName, buf) {
    const finalDir = path.join(UPLOAD_DIR, 'correction', String(rid));
    fs.mkdirSync(finalDir, { recursive: true });
    const finalName = `${Date.now()}_${Math.round(Math.random() * 1e9)}_${fileName}`;
    fs.writeFileSync(path.join(finalDir, finalName), buf);
    const relPath = path.join('correction', String(rid), finalName).replace(/\\/g, '/');
    const r = await dbRunAsync(
        `INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, file_size, uploaded_by, uploaded_by_name) VALUES (?,?,?,?,?,?,?)`,
        [rid, attachmentType, relPath, fileName, buf.length, 1, '管理员']);
    return r.lastID;
}
function pendingDirFiles(rid) {
    const dir = path.join(UPLOAD_DIR, 'correction', '_pending', String(rid));
    try { return fs.readdirSync(dir); } catch (_) { return []; }
}
function buildDirPendingFiles() {   // 建单 oa_proof 挂点（无 rid）走 _pending/_new/{buildKey}/，只需断言其为空目录集合
    const dir = path.join(UPLOAD_DIR, 'correction', '_pending', '_new');
    try { return fs.readdirSync(dir).filter(d => { try { return fs.readdirSync(path.join(dir, d)).length > 0; } catch (_) { return false; } }); } catch (_) { return []; }
}

async function main() {
    mod.initSchema();
    await waitReady();
    const app = express();
    app.use(express.json());
    app.use('/api/corrections', mod.router);
    srv = app.listen(0);
    PORT = srv.address().port;
    ok('in-process app 启动 + readiness ready');

    // ── V1：oa_proof（建单 multipart）/ error_proof / fix_proof 各上传 1 字节 .zip/.rar/.7z → 2xx 入库 ──
    {
        let oaSeq = 700100;
        for (const ext of ['zip', 'rar', '7z']) {
            const r = await reqMultipart('POST', '/api/corrections', {
                source_system: 'BMS', location_info: 'V1 oa_proof', correction_type: 'single', oa_number: String(oaSeq++),
                reason: 'V1 oa_proof 压缩包 fixture 原因文本', requester_name: '业务张', requester_phone: '13800000001',
            }, 'oa_proof_files', `oa.${ext}`, Buffer.from('x'), ADMIN);
            assert.strictEqual(r.status, 200, `[V1] 建单 oa_proof .${ext} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
        }
        ok('[V1] oa_proof（建单）zip/rar/7z 各 1 字节 → 200 建单成功（实现坏成什么样它会红：规则表/白名单漏放压缩包 → 400）');

        for (const ext of ['zip', 'rar', '7z']) {
            const rid = await mkRow({ status: 'PENDING_ASSIGN' });   // ERROR_PROOF_STATES 含 PENDING_ASSIGN
            const r = await reqMultipart('POST', `/api/corrections/${rid}/attachments`, { attachment_type: 'error_proof' }, 'files', `e.${ext}`, Buffer.from('x'), ADMIN);
            assert.strictEqual(r.status, 200, `[V1] error_proof .${ext} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
            const att = await dbGetAsync('SELECT file_size FROM correction_attachments WHERE id=?', [r.body.attachments[0].id]);
            assert.strictEqual(att.file_size, 1, `[V1] error_proof .${ext} file_size 入库正确`);
        }
        ok('[V1] error_proof zip/rar/7z 各 1 字节 → 200 入库 + file_size 正确');

        for (const ext of ['zip', 'rar', '7z']) {
            const rid = await mkRow({ status: 'FIXED' });
            const r = await reqMultipart('POST', `/api/corrections/${rid}/attachments`, { attachment_type: 'fix_proof' }, 'files', `f.${ext}`, Buffer.from('x'), ADMIN);
            assert.strictEqual(r.status, 200, `[V1] fix_proof .${ext} 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
        }
        ok('[V1] fix_proof zip/rar/7z 各 1 字节 → 200 入库（实现坏成什么样它会红：白名单/规则表任一漏放压缩包 → 400）');
    }

    // ── V2b：52428801 字节 .zip → multer LIMIT_FILE_SIZE；52428800 字节 → 2xx ──
    {
        const ridOver = await mkRow({ status: 'FIXED' });
        const bufOver = Buffer.alloc(ARCHIVE_MAX_SIZE + 1, 2);
        let r = await reqMultipart('POST', `/api/corrections/${ridOver}/attachments`, { attachment_type: 'fix_proof' }, 'files', 'over.zip', bufOver, ADMIN);
        assert.strictEqual(r.status, 400, `[V2b] 50MB+1 字节 .zip 应 400，实际 ${r.status}`);
        assert.strictEqual(r.body.code, 'LIMIT_FILE_SIZE', `[V2b] 应命中既有 multer LIMIT_FILE_SIZE 映射，实际 code=${r.body.code}`);

        const ridExact = await mkRow({ status: 'FIXED' });
        const bufExact = Buffer.alloc(ARCHIVE_MAX_SIZE, 3);
        r = await reqMultipart('POST', `/api/corrections/${ridExact}/attachments`, { attachment_type: 'fix_proof' }, 'files', 'exact.zip', bufExact, ADMIN);
        assert.strictEqual(r.status, 200, `[V2b] 恰 50MB .zip 应 2xx，实际 ${r.status} ${JSON.stringify(r.body)}`);
        ok('[V2b] 顶上限边界：50MB+1 字节 .zip → 400 LIMIT_FILE_SIZE；恰 50MB → 2xx（实现坏成什么样它会红：顶上限未抬 → 50MB 整被拒；抬过头 → 51MB 通过）');
    }

    // ── V3：四挂点各上传 20MB+1 .pdf → 400 ATTACHMENT_RULE_VIOLATION reason=SIZE_EXCEEDED limit_mb=20，pending 已清 ──
    {
        const size21 = 20 * 1024 * 1024 + 1;
        const buf21 = Buffer.alloc(size21, 4);

        // 挂点①：建单 oa_proof
        let oaSeq = 700200;
        let r = await reqMultipart('POST', '/api/corrections', {
            source_system: 'BMS', location_info: 'V3 oa_proof', correction_type: 'single', oa_number: String(oaSeq++),
            reason: 'V3 oa_proof 超限 fixture 原因文本', requester_name: '业务张', requester_phone: '13800000001',
        }, 'oa_proof_files', 'big.pdf', buf21, ADMIN);
        assert.strictEqual(r.status, 400, `[V3] 建单 oa_proof 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION');
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED');
        assert.strictEqual(r.body.limit_mb, 20);
        assert.deepStrictEqual(buildDirPendingFiles(), [], '[V3] 建单 oa_proof 拒绝后 _pending/_new 下无残留非空目录');

        // 挂点②：/complete fix_proof（rework_parent_id 留空跳过 FIX_PROOF_REQUIRED 闸；status 任意，因验证先于 transition）
        const rid2 = await mkRow({ status: 'IN_PROGRESS' });
        r = await reqMultipart('POST', `/api/corrections/${rid2}/complete`, {}, 'files', 'big.pdf', buf21, ADMIN);
        assert.strictEqual(r.status, 400, `[V3] /complete fix_proof 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION');
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED');
        assert.strictEqual(r.body.limit_mb, 20);
        assert.deepStrictEqual(pendingDirFiles(rid2), [], `[V3] /complete 拒绝后 pending 目录（issue=${rid2}）内本请求文件已清`);

        // 挂点③：/resubmit fix_proof
        const rid3 = await mkRow({ status: 'REFIXED' });
        r = await reqMultipart('POST', `/api/corrections/${rid3}/resubmit`, {}, 'files', 'big.pdf', buf21, ADMIN);
        assert.strictEqual(r.status, 400, `[V3] /resubmit fix_proof 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION');
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED');
        assert.strictEqual(r.body.limit_mb, 20);
        assert.deepStrictEqual(pendingDirFiles(rid3), [], `[V3] /resubmit 拒绝后 pending 目录（issue=${rid3}）内本请求文件已清`);

        // 挂点④：/attachments（fix_proof 与 error_proof 各一次）
        const rid4a = await mkRow({ status: 'FIXED' });
        r = await reqMultipart('POST', `/api/corrections/${rid4a}/attachments`, { attachment_type: 'fix_proof' }, 'files', 'big.pdf', buf21, ADMIN);
        assert.strictEqual(r.status, 400, `[V3] /attachments fix_proof 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION');
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED');
        assert.strictEqual(r.body.limit_mb, 20);
        assert.deepStrictEqual(pendingDirFiles(rid4a), [], `[V3] /attachments(fix_proof) 拒绝后 pending 目录（issue=${rid4a}）内本请求文件已清`);

        const rid4b = await mkRow({ status: 'PENDING_ASSIGN' });
        r = await reqMultipart('POST', `/api/corrections/${rid4b}/attachments`, { attachment_type: 'error_proof' }, 'files', 'big.pdf', buf21, ADMIN);
        assert.strictEqual(r.status, 400, `[V3] /attachments error_proof 21MB .pdf 应 400，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'ATTACHMENT_RULE_VIOLATION');
        assert.strictEqual(r.body.reason, 'SIZE_EXCEEDED');
        assert.strictEqual(r.body.limit_mb, 20);
        assert.deepStrictEqual(pendingDirFiles(rid4b), [], `[V3] /attachments(error_proof) 拒绝后 pending 目录（issue=${rid4b}）内本请求文件已清`);

        ok('[V3] 四挂点（建单 oa_proof / complete / resubmit / attachments×2）各上传 21MB .pdf → 400 ATTACHMENT_RULE_VIOLATION reason=SIZE_EXCEEDED limit_mb=20，pending 均已清（实现坏成什么样它会红：只抬 multer 不加二次卡 → 2xx；某挂点漏挂 → 该挂点 2xx）');

        // ── V3-perm（codex 06 建议）：无权限用户上传 20MB+1 .pdf → 403（权限门先于二次卡 400），非本单
        //   assignee/creator/admin 的用户 id=99；锁住「403 先于 ATTACHMENT_RULE_VIOLATION」既有顺序——若权限
        //   检查被误挪到二次卡之后，这里会先拿到 400 而非 403，断言即红。
        const STRANGER = { id: 99, username: 'stranger', display_name: '路人', role: 'user' };
        // /complete：静态源码确认（:2859）该分支实际码 NOT_AUTHORIZED_FOR_TRANSITION
        {
            const ridP = await mkRow({ status: 'IN_PROGRESS', assigned_to: 5, created_by: 1 });
            r = await reqMultipart('POST', `/api/corrections/${ridP}/complete`, {}, 'files', 'big.pdf', buf21, STRANGER);
            assert.strictEqual(r.status, 403, `[V3-perm] /complete 无权限用户上传 21MB .pdf 应 403（非 400），实际 ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', `[V3-perm] /complete 实际码应 NOT_AUTHORIZED_FOR_TRANSITION，实际 ${r.body.code}`);
            assert.deepStrictEqual(pendingDirFiles(ridP), [], `[V3-perm] /complete 403 拒绝后 pending 目录（issue=${ridP}）内本请求文件已清`);
        }
        // /resubmit：静态源码确认（:2892）该分支实际码 NOT_AUTHORIZED_FOR_TRANSITION
        {
            const ridP = await mkRow({ status: 'REFIXED', assigned_to: 5, created_by: 1 });
            r = await reqMultipart('POST', `/api/corrections/${ridP}/resubmit`, {}, 'files', 'big.pdf', buf21, STRANGER);
            assert.strictEqual(r.status, 403, `[V3-perm] /resubmit 无权限用户上传 21MB .pdf 应 403（非 400），实际 ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_TRANSITION', `[V3-perm] /resubmit 实际码应 NOT_AUTHORIZED_FOR_TRANSITION，实际 ${r.body.code}`);
            assert.deepStrictEqual(pendingDirFiles(ridP), [], `[V3-perm] /resubmit 403 拒绝后 pending 目录（issue=${ridP}）内本请求文件已清`);
        }
        // /attachments（fix_proof 分支）：静态源码确认（:2964）该分支实际码 NOT_AUTHORIZED_FOR_ATTACHMENT
        {
            const ridP = await mkRow({ status: 'FIXED', assigned_to: 5, created_by: 1 });
            r = await reqMultipart('POST', `/api/corrections/${ridP}/attachments`, { attachment_type: 'fix_proof' }, 'files', 'big.pdf', buf21, STRANGER);
            assert.strictEqual(r.status, 403, `[V3-perm] /attachments(fix_proof) 无权限用户上传 21MB .pdf 应 403（非 400），实际 ${r.status} ${JSON.stringify(r.body)}`);
            assert.strictEqual(r.body.code, 'NOT_AUTHORIZED_FOR_ATTACHMENT', `[V3-perm] /attachments(fix_proof) 实际码应 NOT_AUTHORIZED_FOR_ATTACHMENT，实际 ${r.body.code}`);
            assert.deepStrictEqual(pendingDirFiles(ridP), [], `[V3-perm] /attachments(fix_proof) 403 拒绝后 pending 目录（issue=${ridP}）内本请求文件已清`);
        }
        ok('[V3-perm] 三挂点（complete/resubmit/attachments）无权限用户（非 admin/assignee/creator）上传 20MB+1 .pdf → 403（NOT_AUTHORIZED_FOR_TRANSITION ×2 / NOT_AUTHORIZED_FOR_ATTACHMENT ×1），非 400 ATTACHMENT_RULE_VIOLATION，pending 已清（实现坏成什么样它会红：权限检查若被误挪到二次卡校验之后，这里会先拿到 400 而非 403）');
    }

    // ── V3u：直调校验器五组 ──
    {
        let c = I.validateCorrectionAttachmentRule('fix_proof', 'a.zip', ARCHIVE_MAX_SIZE);
        assert.strictEqual(c.ok, true, `[V3u] fix_proof .zip 恰 50MB 应过，实际 ${JSON.stringify(c)}`);
        c = I.validateCorrectionAttachmentRule('fix_proof', 'a.zip', ARCHIVE_MAX_SIZE + 1);
        assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'SIZE_EXCEEDED', `[V3u] fix_proof .zip 50MB+1 应 SIZE_EXCEEDED`);
        c = I.validateCorrectionAttachmentRule('fix_proof', 'a.pdf', 20 * 1024 * 1024);
        assert.strictEqual(c.ok, true, `[V3u] fix_proof .pdf 恰 20MB 应过，实际 ${JSON.stringify(c)}`);
        c = I.validateCorrectionAttachmentRule('fix_proof', 'a.pdf', 20 * 1024 * 1024 + 1);
        assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'SIZE_EXCEEDED', `[V3u] fix_proof .pdf 20MB+1 应 SIZE_EXCEEDED`);
        c = I.validateCorrectionAttachmentRule('oa_proof', 'x.exe', 1);
        assert.strictEqual(c.ok, false); assert.strictEqual(c.reason, 'EXT_NOT_ALLOWED', `[V3u] oa_proof .exe 应 EXT_NOT_ALLOWED`);
        ok('[V3u] validateCorrectionAttachmentRule 五组直调用例全部符合方案 §5 判据（实现坏成什么样它会红：任一分支写反 → 对应断言红）');
    }

    // ── V6a：fix_proof 最新一条 .zip，触发 done 与 rework 两路通知 ──
    //   codex 06 M2 收口：正常路径补 success/status 断言 + 落库核对（done 走 correction_requesters，
    //   rework 走 correction_requests 自身行——两条 UPDATE 语句里都是 completion_notify_status/
    //   completion_notify_message_key 两列，字面量写「sent」，无独立 notify_status/notify_message_key 列）；
    //   再各定点注入一次「钉钉已发但落库失败」，钉住 NOTIFY_SENT_BUT_DB_UPDATE_FAILED + file_sent=false（压缩包
    //   场景 fileSent 天然为 false，与是否落库无关）+ file_skipped_reason=archive；最后证明故障是一次性的，
    //   同一单再发一次仍能正常 sent（消耗后的 FAULT_PREDICATE 已自动清空，不影响后续请求）。
    {
        // done（主单）路径——正常
        const rid = await mkRow({ status: 'FIXED' });
        await mkRequester(rid, {});
        await mkAttachment(rid, 'fix_proof', 'proof.zip', Buffer.from('PK\x03\x04'));
        resetDingtalkStubState();
        const r = await reqJson('POST', `/api/corrections/${rid}/notify-done`, {}, ADMIN);
        assert.strictEqual(r.status, 200, `[V6a-done] notify-done 应 200，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.success, true, '[V6a-done] 响应 success 应 true');
        assert.strictEqual(r.body.status, 'sent', '[V6a-done] 响应 status 应 sent');
        assert.strictEqual(CALLS.uploadMedia, 0, '[V6a-done] uploadMedia 调用次数应 0（压缩包不发文件）');
        assert.strictEqual(CALLS.sendFileToUser, 0, '[V6a-done] sendFileToUser 调用次数应 0');
        assert.strictEqual(CALLS.sendMarkdownToUser, 1, '[V6a-done] sendMarkdownToUser 调用次数应 1');
        const lastMd = SENDS[SENDS.length - 1];
        assert.ok(lastMd && /结果证明为压缩包（≤50MB），请登录平台下载/.test(lastMd.md), `[V6a-done] 文案应恰为压缩包三态句，实际：${lastMd && lastMd.md}`);
        assert.ok(!/随附文件/.test(lastMd.md), '[V6a-done] 文案不含「随附文件」');
        assert.strictEqual(r.body.file_sent, false, '[V6a-done] 响应 file_sent 应 false');
        assert.strictEqual(r.body.has_attachment, true, '[V6a-done] 响应 has_attachment 应 true');
        assert.strictEqual(r.body.file_skipped_reason, 'archive', '[V6a-done] 响应 file_skipped_reason 应 archive');
        {
            const reqRow = await dbGetAsync('SELECT completion_notify_status, completion_notify_message_key FROM correction_requesters WHERE correction_request_id=? AND is_primary=1', [rid]);
            assert.strictEqual(reqRow.completion_notify_status, 'sent', `[V6a-done] 落库核对：correction_requesters.completion_notify_status 应 sent，实际 ${JSON.stringify(reqRow)}`);
            assert.ok(reqRow.completion_notify_message_key && reqRow.completion_notify_message_key.startsWith('mk_'), `[V6a-done] 落库核对：correction_requesters.completion_notify_message_key 应非空且为本次 mock key，实际 ${reqRow.completion_notify_message_key}`);
        }

        // rework（返工子单）路径——正常
        const master = await mkRow({ status: 'ARCHIVED', closure_type: 'normal' });
        await mkRequester(master, {});
        const child = await mkRow({ status: 'FIXED', correction_group_id: master, rework_parent_id: master, rework_root_id: master, rework_seq: 1 });
        await mkAttachment(child, 'fix_proof', 'rework-proof.rar', Buffer.from('Rar!'));
        resetDingtalkStubState();
        const r2 = await reqJson('POST', `/api/corrections/${child}/notify-done`, {}, ADMIN);
        assert.strictEqual(r2.status, 200, `[V6a-rework] notify-done 应 200，实际 ${r2.status} ${JSON.stringify(r2.body)}`);
        assert.strictEqual(r2.body.success, true, '[V6a-rework] 响应 success 应 true');
        assert.strictEqual(r2.body.status, 'sent', '[V6a-rework] 响应 status 应 sent');
        assert.strictEqual(CALLS.uploadMedia, 0, '[V6a-rework] uploadMedia 调用次数应 0');
        assert.strictEqual(CALLS.sendFileToUser, 0, '[V6a-rework] sendFileToUser 调用次数应 0');
        assert.strictEqual(CALLS.sendMarkdownToUser, 1, '[V6a-rework] sendMarkdownToUser 调用次数应 1');
        const lastMdR = SENDS[SENDS.length - 1];
        assert.ok(lastMdR && /二次修复结果证明为压缩包（≤50MB），请登录平台下载/.test(lastMdR.md), `[V6a-rework] 文案应恰为压缩包三态句，实际：${lastMdR && lastMdR.md}`);
        assert.ok(!/随附文件/.test(lastMdR.md), '[V6a-rework] 文案不含「随附文件」');
        assert.strictEqual(r2.body.file_sent, false, '[V6a-rework] 响应 file_sent 应 false');
        assert.strictEqual(r2.body.has_attachment, true, '[V6a-rework] 响应 has_attachment 应 true');
        assert.strictEqual(r2.body.file_skipped_reason, 'archive', '[V6a-rework] 响应 file_skipped_reason 应 archive');
        {
            const childRow = await dbGetAsync('SELECT completion_notify_status, completion_notify_message_key FROM correction_requests WHERE id=?', [child]);
            assert.strictEqual(childRow.completion_notify_status, 'sent', `[V6a-rework] 落库核对：correction_requests(返工子单自身行).completion_notify_status 应 sent，实际 ${JSON.stringify(childRow)}`);
            assert.ok(childRow.completion_notify_message_key && childRow.completion_notify_message_key.startsWith('mk_'), `[V6a-rework] 落库核对：completion_notify_message_key 应非空且为本次 mock key，实际 ${childRow.completion_notify_message_key}`);
        }

        ok('[V6a] fix_proof 最新一条 .zip/.rar，done 与 rework 两路均：success=true/status=sent + uploadMedia/sendFileToUser 调用 0、markdown 调用 1、三态压缩包文案且不含「随附文件」、file_sent=false/has_attachment=true/file_skipped_reason=archive + 落库 completion_notify_status=sent/message_key 非空（实现坏成什么样它会红：删「压缩包置空 physicalPath」分支 → 走文件发送，调用次数非 0；漏写库 → 落库核对红）');

        // ── V6a-fault：定点注入一次通知落库失败（done 路 correction_requesters、rework 路
        //   correction_requests 自身行的 UPDATE ... SET completion_notify_status='sent' 各命中一次）──
        {
            const ridF = await mkRow({ status: 'FIXED' });
            await mkRequester(ridF, {});
            await mkAttachment(ridF, 'fix_proof', 'fault.zip', Buffer.from('PK\x03\x04'));
            resetDingtalkStubState();
            FAULT_PREDICATE = (q) => /UPDATE correction_requesters SET completion_notify_status='sent'/.test(q);
            const rF = await reqJson('POST', `/api/corrections/${ridF}/notify-done`, {}, ADMIN);
            assert.strictEqual(FAULT_PREDICATE, null, '[V6a-fault-done] 一次性谓词已被消耗（证明确实命中了目标 UPDATE，而非侥幸绕过）');
            assert.strictEqual(rF.status, 200, `[V6a-fault-done] 部分失败仍 200（success:false 载荷），实际 ${rF.status} ${JSON.stringify(rF.body)}`);
            assert.strictEqual(rF.body.success, false, '[V6a-fault-done] success 应 false');
            assert.strictEqual(rF.body.code, 'NOTIFY_SENT_BUT_DB_UPDATE_FAILED', `[V6a-fault-done] code 应 NOTIFY_SENT_BUT_DB_UPDATE_FAILED，实际 ${rF.body.code}`);
            assert.strictEqual(rF.body.file_sent, false, '[V6a-fault-done] file_sent 应 false（压缩包场景 fileSent 天然为 false，与落库结果无关）');
            assert.strictEqual(rF.body.file_skipped_reason, 'archive', '[V6a-fault-done] file_skipped_reason 应 archive');
            // codex 08 rec：仅 file_sent=false 不能证明该值没被硬编码——落库失败路径也须证 markdown 真发了恰 1 次、文件发送 0 次
            assert.strictEqual(CALLS.sendMarkdownToUser, 1, `[V6a-fault-done] 落库失败前 markdown 已真发 1 次，实际 ${CALLS.sendMarkdownToUser}`);
            assert.strictEqual(CALLS.sendFileToUser, 0, `[V6a-fault-done] 压缩包场景文件发送 0 次，实际 ${CALLS.sendFileToUser}`);
            const rowAfterFault = await dbGetAsync('SELECT completion_notify_status FROM correction_requesters WHERE correction_request_id=? AND is_primary=1', [ridF]);
            assert.strictEqual(rowAfterFault.completion_notify_status, 'not_sent', `[V6a-fault-done] 落库确实未被写入（UPDATE 抛错，行仍保持建夹具时的 not_sent），实际 ${rowAfterFault.completion_notify_status}`);
            // 恢复：故障已一次性消耗，同一单再发一次应正常 sent（未 force_resend——因上次未落 sent，非 already_sent 分支）
            resetDingtalkStubState();
            const rRecover = await reqJson('POST', `/api/corrections/${ridF}/notify-done`, {}, ADMIN);
            assert.strictEqual(rRecover.status, 200, `[V6a-fault-done-恢复] 应 200，实际 ${rRecover.status} ${JSON.stringify(rRecover.body)}`);
            assert.strictEqual(rRecover.body.success, true, '[V6a-fault-done-恢复] success 应 true（故障已消耗，正常路径不受影响）');
            assert.strictEqual(rRecover.body.status, 'sent', '[V6a-fault-done-恢复] status 应 sent');
            const rowAfterRecover = await dbGetAsync('SELECT completion_notify_status FROM correction_requesters WHERE correction_request_id=? AND is_primary=1', [ridF]);
            assert.strictEqual(rowAfterRecover.completion_notify_status, 'sent', '[V6a-fault-done-恢复] 落库确实写入 sent');
            ok('[V6a-fault-done] 定点注入一次 correction_requesters 落库失败 → 200 success:false code=NOTIFY_SENT_BUT_DB_UPDATE_FAILED + file_sent=false + file_skipped_reason=archive，行未被写脏；故障消耗后同单再发恢复正常 sent（实现坏成什么样它会红：catch 分支被删/吞掉异常直接当成功 → success 误报 true；file_sent 从别处硬编码 → 与 fileSent 变量脱钩后仍可能凑巧对，故用 fault 场景钉死其来自 sendDoneDingtalkCard 返回值而非猜测）');

            const masterF = await mkRow({ status: 'ARCHIVED', closure_type: 'normal' });
            await mkRequester(masterF, {});
            const childF = await mkRow({ status: 'FIXED', correction_group_id: masterF, rework_parent_id: masterF, rework_root_id: masterF, rework_seq: 1 });
            await mkAttachment(childF, 'fix_proof', 'fault-rework.rar', Buffer.from('Rar!'));
            resetDingtalkStubState();
            FAULT_PREDICATE = (q) => /UPDATE correction_requests SET completion_notify_status='sent'/.test(q);
            const rF2 = await reqJson('POST', `/api/corrections/${childF}/notify-done`, {}, ADMIN);
            assert.strictEqual(FAULT_PREDICATE, null, '[V6a-fault-rework] 一次性谓词已被消耗（命中目标 UPDATE）');
            assert.strictEqual(rF2.status, 200, `[V6a-fault-rework] 应 200，实际 ${rF2.status} ${JSON.stringify(rF2.body)}`);
            assert.strictEqual(rF2.body.success, false, '[V6a-fault-rework] success 应 false');
            assert.strictEqual(rF2.body.code, 'NOTIFY_SENT_BUT_DB_UPDATE_FAILED', `[V6a-fault-rework] code 应 NOTIFY_SENT_BUT_DB_UPDATE_FAILED，实际 ${rF2.body.code}`);
            assert.strictEqual(rF2.body.file_sent, false, '[V6a-fault-rework] file_sent 应 false');
            assert.strictEqual(rF2.body.file_skipped_reason, 'archive', '[V6a-fault-rework] file_skipped_reason 应 archive');
            const childRowAfterFault = await dbGetAsync('SELECT completion_notify_status FROM correction_requests WHERE id=?', [childF]);
            // completion_notify_status 建夹具（mkRow）时未显式设置，DB 列无默认值应为 NULL——核对确实未被 UPDATE 写成 'sent'
            assert.notStrictEqual(childRowAfterFault.completion_notify_status, 'sent', `[V6a-fault-rework] 落库确实未被写入 sent，实际 ${JSON.stringify(childRowAfterFault)}`);
            resetDingtalkStubState();
            const rRecover2 = await reqJson('POST', `/api/corrections/${childF}/notify-done`, {}, ADMIN);
            assert.strictEqual(rRecover2.status, 200, `[V6a-fault-rework-恢复] 应 200，实际 ${rRecover2.status} ${JSON.stringify(rRecover2.body)}`);
            assert.strictEqual(rRecover2.body.success, true, '[V6a-fault-rework-恢复] success 应 true');
            assert.strictEqual(rRecover2.body.status, 'sent', '[V6a-fault-rework-恢复] status 应 sent');
            const childRowAfterRecover = await dbGetAsync('SELECT completion_notify_status FROM correction_requests WHERE id=?', [childF]);
            assert.strictEqual(childRowAfterRecover.completion_notify_status, 'sent', '[V6a-fault-rework-恢复] 落库确实写入 sent');
            ok('[V6a-fault-rework] 定点注入一次 correction_requests(返工子单自身行) 落库失败 → 同款 NOTIFY_SENT_BUT_DB_UPDATE_FAILED + file_sent=false + file_skipped_reason=archive，未写脏；故障消耗后同单再发恢复正常 sent');
        }
    }

    // ── V6b：fix_proof .zip 物理缺失 → 409 FIX_PROOF_FILE_MISSING，markdown 未调用 ──
    {
        const rid = await mkRow({ status: 'FIXED' });
        await mkRequester(rid, {});
        // 直接落库一条指向不存在物理文件的 fix_proof 记录（不走 mkAttachment 的真实落盘）
        await dbRunAsync(`INSERT INTO correction_attachments (correction_request_id, attachment_type, file_name, original_name, uploaded_by, uploaded_by_name) VALUES (?, 'fix_proof', ?, ?, 1, '管理员')`,
            [rid, path.join('correction', String(rid), 'missing.zip').replace(/\\/g, '/'), 'missing.zip']);
        resetDingtalkStubState();
        const r = await reqJson('POST', `/api/corrections/${rid}/notify-done`, {}, ADMIN);
        assert.strictEqual(r.status, 409, `[V6b] 物理缺失应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'FIX_PROOF_FILE_MISSING');
        assert.strictEqual(CALLS.sendMarkdownToUser, 0, '[V6b] markdown 未调用（早于发送环节即 409）');
        ok('[V6b] fix_proof .zip 物理缺失 → 409 FIX_PROOF_FILE_MISSING，markdown 未调用（existsSync 检查压缩包同样照常执行）');
    }

    // ── V6c：fix_proof 直插 .exe → 409 FIX_PROOF_NOT_SENDABLE ──
    {
        const rid = await mkRow({ status: 'FIXED' });
        await mkRequester(rid, {});
        await mkAttachment(rid, 'fix_proof', 'evil.exe', Buffer.from('MZ'));
        resetDingtalkStubState();
        const r = await reqJson('POST', `/api/corrections/${rid}/notify-done`, {}, ADMIN);
        assert.strictEqual(r.status, 409, `[V6c] 脏扩展名应 409，实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.code, 'FIX_PROOF_NOT_SENDABLE');
        ok('[V6c] fix_proof 直插 .exe → 409 FIX_PROOF_NOT_SENDABLE（可发送集仍为联合白名单，未被 isArchiveExt 顶替）');
    }

    // ── V6d：上传序 [zip, png] 与 [png, zip] → 最新一条决定发送方式 ──
    {
        const rid1 = await mkRow({ status: 'FIXED' });
        await mkRequester(rid1, {});
        await mkAttachment(rid1, 'fix_proof', 'first.zip', Buffer.from('PK'));
        await new Promise(r => setTimeout(r, 5));
        await mkAttachment(rid1, 'fix_proof', 'second.png', Buffer.from('PNGDATA'));
        resetDingtalkStubState();
        const r1 = await reqJson('POST', `/api/corrections/${rid1}/notify-done`, {}, ADMIN);
        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r1.body.file_sent, true, '[V6d] [zip,png] 序：最新一条 png → file_sent=true（走文件发送）');
        assert.strictEqual(r1.body.file_skipped_reason, undefined, '[V6d] [zip,png] 序：最新一条非压缩包 → 无 file_skipped_reason');

        const rid2 = await mkRow({ status: 'FIXED' });
        await mkRequester(rid2, {});
        await mkAttachment(rid2, 'fix_proof', 'first.png', Buffer.from('PNGDATA'));
        await new Promise(r => setTimeout(r, 5));
        await mkAttachment(rid2, 'fix_proof', 'second.zip', Buffer.from('PK'));
        resetDingtalkStubState();
        const r2 = await reqJson('POST', `/api/corrections/${rid2}/notify-done`, {}, ADMIN);
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.file_sent, false, '[V6d] [png,zip] 序：最新一条 zip → file_sent=false（压缩包不发文件）');
        assert.strictEqual(r2.body.file_skipped_reason, 'archive', '[V6d] [png,zip] 序：最新一条压缩包 → file_skipped_reason=archive');
        ok('[V6d] 上传序 [zip,png]/[png,zip]：最新一条（ORDER BY id DESC LIMIT 1）决定发送方式（实现坏成什么样它会红：取首而非最新 → 两组结果对调）');
    }

    // ── V6e：fix_proof .png → file_sent=true 且无 file_skipped_reason；无 fix_proof → has_attachment=false 文案「自主查看」 ──
    {
        const rid1 = await mkRow({ status: 'FIXED' });
        await mkRequester(rid1, {});
        await mkAttachment(rid1, 'fix_proof', 'plain.png', Buffer.from('PNGDATA'));
        resetDingtalkStubState();
        const r1 = await reqJson('POST', `/api/corrections/${rid1}/notify-done`, {}, ADMIN);
        assert.strictEqual(r1.status, 200);
        assert.strictEqual(r1.body.file_sent, true, '[V6e] .png → file_sent=true');
        assert.strictEqual(r1.body.file_skipped_reason, undefined, '[V6e] .png → 无 file_skipped_reason');

        const rid2 = await mkRow({ status: 'FIXED' });
        await mkRequester(rid2, {});
        resetDingtalkStubState();
        const r2 = await reqJson('POST', `/api/corrections/${rid2}/notify-done`, {}, ADMIN);
        assert.strictEqual(r2.status, 200);
        assert.strictEqual(r2.body.has_attachment, false, '[V6e] 无 fix_proof → has_attachment=false');
        const lastMd = SENDS[SENDS.length - 1];
        assert.ok(lastMd && /已完成，请自主查看/.test(lastMd.md), `[V6e] 无证明文案应含「自主查看」，实际：${lastMd && lastMd.md}`);
        ok('[V6e] fix_proof .png → file_sent=true 无 file_skipped_reason；无 fix_proof → has_attachment=false 文案「自主查看」');
    }

    // ── V6f：.png，stub sendFileToUser 成功、markdown 失败 → 失败路径 failedStep=markdown_send 且 file_sent=true ──
    {
        const rid = await mkRow({ status: 'FIXED' });
        await mkRequester(rid, {});
        await mkAttachment(rid, 'fix_proof', 'plain2.png', Buffer.from('PNGDATA'));
        resetDingtalkStubState();
        MARKDOWN_FAIL = true;
        const r = await reqJson('POST', `/api/corrections/${rid}/notify-done`, {}, ADMIN);
        MARKDOWN_FAIL = false;
        assert.strictEqual(r.status, 200, `[V6f] 部分失败仍 200（success:false 载荷），实际 ${r.status} ${JSON.stringify(r.body)}`);
        assert.strictEqual(r.body.success, false, '[V6f] success=false');
        assert.strictEqual(r.body.code, 'NOTIFY_PARTIAL_FAILURE');
        assert.strictEqual(r.body.failed_step, 'markdown_send', '[V6f] failedStep=markdown_send');
        assert.strictEqual(r.body.file_sent, true, '[V6f] sendFileToUser 已成功 → file_sent=true（与 allOk 解耦）');
        ok('[V6f] .png，sendFileToUser 成功、markdown 失败 → 失败路径 failedStep=markdown_send 且 file_sent=true（实现坏成什么样它会红：用 allOk 冒充 file_sent → false）');
    }

    console.log(`\n✅ verify-correction-attach-archive 全部通过（${passed} 项断言）`);
}

main().then(() => { srv.close(); db.close(); }).catch((e) => {
    console.error('❌ verify-correction-attach-archive 失败:', e && e.stack || e);
    if (srv) srv.close();
    process.exit(1);
});
