#!/usr/bin/env node
/**
 * 夹具播种：为数据协作前端 UI 测试造单（EXPORTING 三张 + PENDING 一张）。
 *
 * 产出（既写 JSON 供独立调用，也可被 require 直接拿返回值）：
 *   · dc-testsingle.json —— 真直派单（assign_mode='admin_direct' + forwarded_to_exporter_at IS NULL）
 *   · dc-testnormal.json —— normal 流转单且**已三级转发**（forwarded_to_exporter_at 非 NULL），
 *                            精确复刻生产协作单 #45 形态（v1.164.2 放开无附件闭环的触发实证）。
 *   · dc-testnormal2.json —— 【2026-09-06 新增】第二张 normal 已转发单，专供 admin 侧行政闭环用例
 *                             （C-UI-7）消费，避免与 exporter 侧 C-UI-4/5/6 共用同一张 `normal`
 *                             单——C-UI-4 会把 `normal` 真实闭环成 DONE，C-UI-7 需要一张仍处于
 *                             EXPORTING 的新鲜单。
 *   · dc-testpending.json —— 【2026-09-07 新增】PENDING（已指派开发、开发未提交）单，供 C-UI-8 验证
 *                             「admin 行政闭环放开到任意状态」——待开发单也能被 admin 记账闭环。
 *
 * 动机：原 Commit C Playwright 脚本硬依赖这两个 JSON 却没有配套播种脚本，夹具丢失后
 *   直接 ENOENT 崩溃、整套 UI 回归跑不了（2026-09-01 实遇）。本脚本把播种固化并可被自动调用。
 *
 * ⚠️ 文件名**刻意不用 `_seed-` 前缀**：.gitignore:127 的 `wbs-server/scripts/_seed-*.js` 会忽略
 *   演示/观察数据播种脚本，而本脚本是**回归测试资产必须进 git**（否则依赖它的 Playwright
 *   脚本在别的机器/部署后仍会 ENOENT——正是本脚本要修的问题）。改名前先确认该忽略规则。
 *
 * [#106 S4d-1] 现状：只作库被已迁移到隔离实例的脚本 require（如 test-collab-direct-close-c-playwright.js，调用方先 fx.ready()，
 *   本文件只经 fx.BASE / fx.openInstanceDb 操作该实例）。命令行独立运行在迁移前不可用：没有 ready 就读 fx.BASE 会抛 FX_NOT_READY、
 *   以退出码 1 失败关闭（登记表里本文件是 EXEMPT「演示 / 观察环境用」，需要独立运行时另行重做）。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const fx = require('./_test-fixture');

const SINGLE_PATH = path.join(os.tmpdir(), 'dc-testsingle.json');
const NORMAL_PATH = path.join(os.tmpdir(), 'dc-testnormal.json');
const NORMAL2_PATH = path.join(os.tmpdir(), 'dc-testnormal2.json');
const PENDING_PATH = path.join(os.tmpdir(), 'dc-testpending.json');

// [#106 S4d-1] 开库走夹具导出的 fx.openInstanceDb（带打开回调、OPEN_READWRITE、不带 OPEN_CREATE：库不存在就报错，不悄悄建空库）；
//   等 close 回调落定，关库错误不丢（语句错误优先）
async function dbGet(sql, params) {
    const db = await fx.openInstanceDb(fx.DB_PATH);
    return new Promise((resolve, reject) => {
        db.get(sql, params, (e, r) => { db.close((cerr) => { const err = e || cerr; err ? reject(err) : resolve(r); }); });
    });
}
async function dbRun(sql, params) {
    const db = await fx.openInstanceDb(fx.DB_PATH);
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (e) { const stmt = this; db.close((cerr) => { const err = e || cerr; err ? reject(err) : resolve(stmt); }); });
    });
}

// 2026-09-07 新增：造一张停在 PENDING（已指派开发、开发未提交）的单，供 C-UI-8 测行政闭环放开。
//   createPendingFixture 恒止于 PENDING，**不做任何 setCollabState**——这里要的就是它的原始形态
//   （submission_version 初始值、无附件、无 exporter），任何加工都会削弱"待开发单真实形态"这个前提。
// [#106 S4d-1] track = 调用方的追踪数组：建单后立即登记编号，后续步骤抛错时失败回滚也能清到这张单
async function makePendingSingle(track) {
    const f = await fx.createPendingFixture();
    track.push(f.id);
    const row = await dbGet(
        'SELECT assign_mode, forwarded_to_exporter_at, status, developer_id FROM collab_requests WHERE id=?', [f.id]);
    return { id: f.id, row };
}

async function makeExporting(assignMode, forwarded, track) {
    const f = await fx.createPendingFixture();
    track.push(f.id);
    const exporterRow = await dbGet('SELECT display_name FROM users WHERE id=?', [fx.EXPORTER_ID]);
    await fx.setCollabState(f.id, {
        status: 'EXPORTING',
        exporter_user_id: fx.EXPORTER_ID,
        exporter_name: exporterRow ? exporterRow.display_name : 'exporter',
        assign_mode: assignMode,
        submission_version: 0,
    });
    // forwarded_to_exporter_at 不在 setCollabState 白名单内，直写兜底
    await dbRun('UPDATE collab_requests SET forwarded_to_exporter_at=? WHERE id=?', [forwarded, f.id]);
    const row = await dbGet(
        'SELECT assign_mode, forwarded_to_exporter_at, status FROM collab_requests WHERE id=?', [f.id]);
    return { id: f.id, row };
}

/**
 * 播种四张单。返回 { single:{id,...}, normal:{id,...}, normal2:{id,...}, pending:{id,...}, ids:[] }。
 *
 * @param {object}  opts
 * @param {boolean} opts.quiet     静默（被其他脚本 require 时不打印）
 * @param {boolean} opts.writeJson 是否落 JSON 文件。**默认 false**——
 *   codex 审 MED 采纳（2026-09-01）：JSON 含 adminToken/exporterToken，测试跑完只删了库记录、
 *   文件却长期留在系统临时目录，且指向已删除的单；固定文件名在并发跑时还会互相覆盖，
 *   让其他读取者从「ENOENT 显式崩溃」退化成「读到了但夹具无效」的隐蔽误报。
 *   ∴ 内嵌调用（Playwright require）不写文件；仅独立 CLI 运行时才写，供人工排查。
 *
 * ⚠️ 失败自清理：第二张单创建/校验失败时，第一张已创建的单会被回滚删除，不留残留
 *   （codex 审 MED 采纳：原实现无失败回滚）。
 */
async function seed(opts = {}) {
    // 兼容旧签名 seed(true) === seed({ quiet: true })
    const { quiet = false, writeJson = false } = (typeof opts === 'boolean') ? { quiet: opts } : opts;

    // codex 审 MED 采纳（部分）：健康检查不能只看 fetch 没抛错——连到任意一个别的 HTTP 服务
    //   时 fetch 同样成功，后续断言就会测在错误的服务/库上。
    // ⚠️ 但不能照搬「探 `/` 并要求 res.ok」：本服务**没有根路由，`GET /` 恒 404**（实测），
    //   那样写会让脚本永远起不来。改探 `/login.html`——它是本平台的静态页，
    //   既能证明「HTTP 通」，又能证明「对面确实是本平台」（别的服务不会有这个文件）。
    let res;
    try {
        res = await fetch(`${fx.BASE}/login.html`, { method: 'GET' });
    } catch (e) {
        throw new Error(`服务器不可达（${fx.BASE}），请先启动 dev server`);
    }
    if (!res.ok) {
        throw new Error(`健康检查失败：${fx.BASE}/login.html 返回 ${res.status}（对面可能不是本平台服务）`);
    }

    const adminToken = await fx.signAs(fx.ADMIN_ID);
    const exporterToken = await fx.signAs(fx.EXPORTER_ID);

    const createdIds = [];
    try {
        const direct = await makeExporting('admin_direct', null, createdIds);
        const normal = await makeExporting('normal', '2026-09-01 17:29:37', createdIds);
        // 2026-09-06 新增：第二张 normal 已转发单，专供 admin 侧行政闭环用例（C-UI-7）——
        //   与 exporter 侧 C-UI-4/5/6 共用的 `normal` 分开，避免 C-UI-4 把单闭环成 DONE 后
        //   C-UI-7 拿到的已不是 EXPORTING 态。
        const normal2 = await makeExporting('normal', '2026-09-01 17:29:37', createdIds);
        // 2026-09-07 新增：一张 PENDING（已指派未提交）单，专供 C-UI-8 测「行政闭环放开到任意状态」
        const pending = await makePendingSingle(createdIds);

        // 形态自校验：防「播种成功但形态不对」静默误导下游 UI 断言（夹具错会让断言测的是别的东西）
        const bad = [];
        if (pending.row.status !== 'PENDING') {
            bad.push(`pending 单状态错: ${JSON.stringify(pending.row)}`);
        }
        if (!pending.row.developer_id) {
            bad.push(`pending 单应已指派开发（PENDING 语义=已指派未提交）: ${JSON.stringify(pending.row)}`);
        }
        if (direct.row.assign_mode !== 'admin_direct' || direct.row.forwarded_to_exporter_at != null) {
            bad.push(`direct 单形态错: ${JSON.stringify(direct.row)}`);
        }
        if (normal.row.assign_mode !== 'normal' || normal.row.forwarded_to_exporter_at == null) {
            bad.push(`normal 单形态错: ${JSON.stringify(normal.row)}`);
        }
        if (normal2.row.assign_mode !== 'normal' || normal2.row.forwarded_to_exporter_at == null) {
            bad.push(`normal2 单形态错: ${JSON.stringify(normal2.row)}`);
        }
        if (direct.row.status !== 'EXPORTING' || normal.row.status !== 'EXPORTING' || normal2.row.status !== 'EXPORTING') {
            bad.push(`状态非 EXPORTING: direct=${direct.row.status} normal=${normal.row.status} normal2=${normal2.row.status}`);
        }
        if (bad.length) throw new Error('夹具形态校验失败:\n  ' + bad.join('\n  '));

        const single = { id: direct.id, adminToken, exporterToken };
        const norm = { id: normal.id, adminToken, exporterToken };
        const norm2 = { id: normal2.id, adminToken, exporterToken };
        const pend = { id: pending.id, adminToken, exporterToken };

        if (writeJson) {
            fs.writeFileSync(SINGLE_PATH, JSON.stringify(single, null, 2), 'utf8');
            fs.writeFileSync(NORMAL_PATH, JSON.stringify(norm, null, 2), 'utf8');
            fs.writeFileSync(NORMAL2_PATH, JSON.stringify(norm2, null, 2), 'utf8');
            fs.writeFileSync(PENDING_PATH, JSON.stringify(pend, null, 2), 'utf8');
        }
        if (!quiet) {
            console.log(`✓ 真直派单 #${direct.id}${writeJson ? '  → ' + SINGLE_PATH : ''}`);
            console.log(`✓ normal 已转发单 #${normal.id}（#45 形态）${writeJson ? '→ ' + NORMAL_PATH : ''}`);
            console.log(`✓ normal 已转发单（第二张）#${normal2.id}${writeJson ? '→ ' + NORMAL2_PATH : ''}`);
            console.log(`✓ PENDING 待开发单 #${pending.id}${writeJson ? '→ ' + PENDING_PATH : ''}`);
        }
        return { single, normal: norm, normal2: norm2, pending: pend, ids: createdIds };
    } catch (e) {
        // 失败回滚：删掉本次已创建的单，避免半截夹具残留在库里
        // [#106 S4d-1] 回滚清理的失败不再丢弃：打印残留说明，并附到抛出的错误上（err.cleanupErrors），调用方据此逐条计失败
        const cleanupErrors = await cleanupSeeded(createdIds, true);
        if (cleanupErrors.length) {
            cleanupErrors.forEach((m) => console.error('⚠️ 播种失败回滚未清干净: ' + m));
            // 与夹具 createPendingFixture 指派失败时带上来的 e.cleanupErrors 合并，不覆盖
            if (e && typeof e === 'object') e.cleanupErrors = (Array.isArray(e.cleanupErrors) ? e.cleanupErrors : []).concat(cleanupErrors);
        }
        throw e;
    }
}

/**
 * 删除播种出来的测试单（FK 级联清子表）。
 * @param {number[]} ids
 * @param {boolean}  quiet 静默（失败回滚路径用，避免盖住原始异常）
 * @returns {string[]} 清理失败的说明（调用方应据此判红——codex 审 MED 采纳：不再静默吞）
 */
async function cleanupSeeded(ids, quiet = false) {
    const errs = [];
    for (const id of ids || []) {
        try {
            await fx.cleanup(id);
        } catch (e) {
            const msg = `测试单 #${id} 清理失败: ${e.message}`;
            errs.push(msg);
            if (!quiet) console.warn('⚠️ ' + msg);
        }
    }
    return errs;
}

module.exports = { seed, cleanupSeeded, SINGLE_PATH, NORMAL_PATH, NORMAL2_PATH, PENDING_PATH };

if (require.main === module) {
    // 独立 CLI 运行才落 JSON（供人工排查/手动跑 UI 脚本）；内嵌调用默认不写，见 seed() 注释
    seed({ quiet: false, writeJson: true })
        .then(() => console.log('提示：这两张是测试单，回归跑完可用 cleanupSeeded 清理，或留在本地 dev 库。'))
        .catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
}
