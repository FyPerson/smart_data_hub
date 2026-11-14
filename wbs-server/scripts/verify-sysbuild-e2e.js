/**
 * #113 C1c 项目管理（系统建设记录）附件端点：端到端冒烟（经 test-env 起真实临时隔离实例）
 *
 * 范围与定位：这是集成冒烟，只证明「接线」——模块就绪登记、真实鉴权中间件、路由挂载、UPLOADS_PROTECTED_DIRS
 *   对 sysbuild 子目录生效、响应头真实发出。权限矩阵、回读门、失败路径等判别力由单元级
 *   scripts/verify-sysbuild-attachments.js（含 --self-test 变异自检）承担，所以本脚本没有 --self-test。
 *
 * 用法：node scripts/verify-sysbuild-e2e.js
 *   经 scripts/lib/test-env.js 自起临时隔离实例（本检出本地库快照，钉钉走替身，周期任务关闭），也可由 TEST_* 变量组
 *   指向已起好的隔离实例。种子（一个项目、一位成员）直接写实例库；数据根随 teardown 删除。
 *   汇总行格式 `N/M 通过`。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const fx = require('./_test-fixture');
const testEnv = require('./lib/test-env');

let BASE = null;
let DB_FILE = null;
let UPLOAD_ROOT = null;

let pass = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
    if (cond) { pass++; results.push(`  ✅ ${name}`); }
    else { fail++; results.push(`  ❌ ${name}${detail ? ' · ' + detail : ''}`); }
}

function dbAll(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (oe) => {
            if (oe) return reject(oe);
            db.all(sql, params || [], (err, rows) => { db.close(() => { err ? reject(err) : resolve(rows); }); });
        });
    });
}
function dbRun(sql, params) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE, (oe) => {
            if (oe) return reject(oe);
            db.run(sql, params || [], function onRun(err) {
                const out = { lastID: this && this.lastID };   // this 只在回调同步段有效，先取出
                db.close(() => (err ? reject(err) : resolve(out)));
            });
        });
    });
}
async function http(method, urlPath, token, opts) {
    const o = opts || {};
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`${BASE}${urlPath}`, { method, headers, body: o.body });
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null;
    if ((r.headers.get('content-type') || '').includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')); } catch (_) { json = null; } }
    return { status: r.status, headers: r.headers, buf, json };
}

(async () => {
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    try {
        BASE = fx.BASE;
        DB_FILE = fx.DB_PATH;
        const dataDir = testEnv.env().dataDir;
        if (!dataDir) throw new Error('取不到实例数据根（env().dataDir 为 null）：无法定位 uploads 目录，拒绝跳过物理文件断言');
        UPLOAD_ROOT = path.join(dataDir, 'uploads');

        // 1. 模块就绪登记
        const hr = await http('GET', '/api/health/ready');
        const mod = hr.json && hr.json.modules && hr.json.modules.sysbuild;
        check('GET /api/health/ready：modules 含 sysbuild 且 ready', hr.status === 200 && !!mod && mod.ready === true, JSON.stringify(hr.json));
        if (!(mod && mod.ready === true)) throw new Error('sysbuild 未就绪，后续用例无意义');

        // 种子：取两位 active、非 admin、不在只读名单 [6, 11] 的用户
        const users = await dbAll("SELECT id FROM users WHERE status = 'active' AND role <> 'admin' AND id NOT IN (6, 11) ORDER BY id LIMIT 2");
        if (users.length < 2) throw new Error('实例库里找不到两位符合条件的非 admin 用户');
        const memberId = users[0].id;
        const outsiderId = users[1].id;
        const proj = await dbRun("INSERT INTO sysbuild_projects (system_name, build_type, pm_user_id, status, created_by) VALUES ('e2e-冒烟项目', 'inhouse', ?, 'active', ?)", [fx.ADMIN_ID, fx.ADMIN_ID]);
        const pid = proj.lastID;
        await dbRun("INSERT INTO sysbuild_members (project_id, user_id, joined_at, added_by) VALUES (?, ?, '2026-10-01 10:00:00', ?)", [pid, memberId, fx.ADMIN_ID]);
        const memberTok = await fx.signAs(memberId);
        const outsiderTok = await fx.signAs(outsiderId);

        // 2. 未带 token → 401
        const r401 = await http('GET', '/api/sysbuild/attachments/1/download', null);
        check('未带 token 访问 /api/sysbuild/attachments/1/download → 401', r401.status === 401, `status=${r401.status}`);

        // 3. 成员经真实鉴权暂存上传
        const content = Buffer.from('e2e 冒烟 附件内容\n', 'utf8');
        const form = new FormData();
        form.append('file', new Blob([content]), 'e2e-smoke.txt');
        const up = await http('POST', `/api/sysbuild/projects/${pid}/attachments/stage`, memberTok, { body: form });
        const att = up.json && up.json.attachment;
        const expectedSha = crypto.createHash('sha256').update(content).digest('hex');
        check('成员暂存上传 txt → 200，返回 sha256 / size 正确', up.status === 200 && !!att && att.sha256 === expectedSha && att.size === content.length, `status=${up.status} body=${up.buf.toString('utf8').slice(0, 200)}`);
        if (!att) throw new Error('暂存失败，后续用例无意义');
        const rows = await dbAll('SELECT file_name, sha256 FROM sysbuild_attachments WHERE id = ?', [att.id]);
        const rel = rows[0] && rows[0].file_name;
        const diskPath = rel ? path.resolve(UPLOAD_ROOT, rel) : null;
        const inDir = !!diskPath && diskPath.startsWith(path.join(UPLOAD_ROOT, 'sysbuild', String(pid)) + path.sep);
        check('文件落在 <dataDir>/uploads/sysbuild/<pid>/ 下且内容 sha256 一致',
            inDir && fs.existsSync(diskPath) && crypto.createHash('sha256').update(fs.readFileSync(diskPath)).digest('hex') === expectedSha,
            `file_name=${rel} diskPath=${diskPath}`);

        // 4. 直接访问静态路径 → 403（UPLOADS_PROTECTED_DIRS 生效）
        const direct = await http('GET', `/uploads/${rel}`, null);
        check('直接访问 /uploads/sysbuild/<pid>/<文件名>（不带 token）→ 403', direct.status === 403, `status=${direct.status}`);
        const directMember = await http('GET', `/uploads/${rel}`, memberTok);
        check('带成员有效 token 直接访问 /uploads/sysbuild/<pid>/<文件名> → 403（受限目录不看登录态）', directMember.status === 403, `status=${directMember.status}`);
        const directOutsider = await http('GET', `/uploads/${rel}`, outsiderTok);
        check('带非成员有效 token 直接访问 /uploads/sysbuild/<pid>/<文件名> → 403', directOutsider.status === 403, `status=${directOutsider.status}`);

        // 5. 成员下载
        const dl = await http('GET', `/api/sysbuild/attachments/${att.id}/download`, memberTok);
        check('成员下载 → 200 且内容一致', dl.status === 200 && dl.buf.equals(content), `status=${dl.status}`);
        check('下载带 Cache-Control: private, no-store', dl.headers.get('cache-control') === 'private, no-store', `cache-control=${dl.headers.get('cache-control')}`);

        // 6. 非成员下载 → 404
        const dl2 = await http('GET', `/api/sysbuild/attachments/${att.id}/download`, outsiderTok);
        check('非成员下载 → 404 SYSBUILD_NOT_FOUND', dl2.status === 404 && dl2.json && dl2.json.code === 'SYSBUILD_NOT_FOUND', `status=${dl2.status} body=${dl2.buf.toString('utf8').slice(0, 120)}`);
    } catch (e) {
        check('e2e 执行异常', false, e.message + '\n' + (e.stack || ''));
    } finally {
        // 实例数据根（含 uploads 目录）由 teardown 删除；变量组（共享实例）形态下 teardown 不做事，数据根由批跑器收实例时删除
        try { await fx.teardown(); } catch (e) { check('teardown（收掉自起实例）', false, e.message); }
    }

    console.log('─────── 项目管理 C1c 附件 e2e 冒烟结果 ───────');
    results.forEach((l) => console.log(l));
    console.log(`\n${pass}/${pass + fail} 通过`);
    fx.finish(fail === 0 ? 0 : 1);   // teardown 之后设退出码 + 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('sysbuild e2e 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
