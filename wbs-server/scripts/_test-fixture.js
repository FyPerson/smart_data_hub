/**
 * 协作单 e2e 共享 fixture helper（2026-05-19）
 *
 * 给 submit/bypass/friction 三套 e2e 复用，避免每个脚本各自维护 fixture。
 * v3 二级转派后，原本依赖 id=3 固定协作单的 e2e 都失效——本 helper 通过 v3 创建流程
 * 动态造单，然后 UPDATE 直接推进状态到测试需要的态。
 *
 * 用法：
 *   const fx = require('./_test-fixture');
 *   await fx.ready();   // [#106 S3b] 先于任何写库 / 网络请求（自起隔离实例或核对 TEST_* 变量组）；之后才能读 fx.BASE / fx.DB_PATH
 *   const ctx = await fx.createPendingFixture();
 *   // ctx = { id, oaNo, adminToken, contactToken, dev1Token }
 *   // 测试结束后：
 *   await fx.cleanup(ctx.id);
 *
 * fixture 角色（沿用 test-collab-two-level-e2e.js 的用户 id）：
 *   admin (id=1)
 *   示例用户A demo_user_a (id=3, user) 作为 contact_person
 *   示例用户B demo_user_b (id=19, user) 作为 developer
 *   示例发布者 19900000003 (id=7, publisher) — v1.71.0 attachment 按人锁 e2e 用（验证 publisher 收权）
 *   示例开发A 19900000005 (id=8, user) — v1.71.0 三级转发 e2e 作 exporter（数据导出人）
 */
'use strict';

// [#106 S3b] 本 fixture 基于 scripts/lib/test-env.js：被测服务 / 实例库 / 实例密钥都来自 test-env（TEST_* 变量组，或自起的临时隔离实例），
// 不再有写死的 localhost:3000、真实 task_pool.db 路径，也不再加载真实 .env。
//   用法：先 `await fx.ready()`（等价 testEnv.ready()），再读 fx.BASE / fx.DB_PATH / fx.JWT_SECRET 或调用异步助手；
//   BASE / DB_PATH / JWT_SECRET 是 getter：ready() 完成之前读取立即抛错（fail-closed，不会悄悄打到 3000），也不可赋值。
//   **异步助手（signAs / apiCall / createPendingFixture / setCollabState / cleanup）要求已 ready，不隐式 ready**（S3b 修复批 1，预筛 HIGH-1）：ready() 尚未完成就抛 FX_NOT_READY（「先 await fx.ready()」），
//   不发请求、不开库、不起实例。显式 fx.ready() / testEnv.ready() 是唯一的启动入口。理由：隐式自起的实例库经 VACUUM INTO 连 sqlite_sequence 一起复制，拿到的单号恰是真实库的下一个号，
//   未迁移脚本再拿这个号用自己写死的真实库路径插子表（外键不生效）、删除又走 3000（实例密钥签的令牌 → 401），孤儿行就永久留在真实本地库里。
//   未迁移脚本（还在顶层读 fx.BASE / fx.DB_PATH，或不先 ready() 就调用助手）因此一律 fail-closed，全部留给 S4 迁移。
const sqlite3 = require('sqlite3').verbose();
const testEnv = require('./lib/test-env');

function readyOnly(name, pick) {
    try {
        return pick(testEnv.env());
    } catch (e) {
        if (e && e.code === 'TE_NOT_READY') {
            const err = new Error(`_test-fixture 的 ${name} 在 ready() 完成之前不可用：先 await fx.ready()（${e.message}）`);
            err.code = 'FX_NOT_READY';
            throw err;
        }
        throw e;
    }
}
/** 异步助手的入口闸：已就绪 → 返回 test-env 的解析结果；否则抛 FX_NOT_READY。绝不调用 ready()（隐式自起是 S3b 预筛 HIGH-1 的根因） */
function requireReady(name) {
    return readyOnly(name, (e) => e);
}
function readOnlyProp(name) {
    return () => { throw new Error(`_test-fixture 的 ${name} 是只读的（来自 test-env）：要换被测服务请设 TEST_INSTANCE / TEST_BASE_URL / TEST_DB_PATH / TEST_JWT_SECRET，不要改写 fixture`); };
}

const ADMIN_ID = 1;
const CONTACT_ID = 3;
const DEV1_ID = 19;
const PUBLISHER_ID = 7;
const EXPORTER_ID = 8;  // v1.71.0 三级转发 e2e 用（user 角色，与 dev1 不同人）
const VIEWER_ID = 2;    // v1.72.5 admin 直派给 viewer e2e 用（示例客服A）
const VIEWER2_ID = 4;   // v1.72.5 跨单越权测试用（示例客服B，另一个 viewer）
const TARGET_DB_CONN_ID = 2;

/** 等价 testEnv.ready()：必须在任何写库 / 网络请求之前 await；幂等 */
function ready(options) {
    return testEnv.ready(options);
}

/**
 * 打开实例库做写入：只读写已存在的实例库（不带 OPEN_CREATE，路径不存在就报错而不是悄悄建空库）。
 * 带打开回调并转成 Promise：不带回调时 node-sqlite3 把打开失败当成未监听的 'error' 事件抛成未捕获异常（进程直接崩），助手拿不到可处理的拒绝（S3b 修复批 2a 探针实测）。
 */
function openInstanceDb(dbPath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE, (err) => (err ? reject(err) : resolve(db)));
    });
}

async function signAs(userId) {
    requireReady('signAs');
    return testEnv.signToken(userId);
}

async function apiCall(method, urlPath, token, body) {
    const e = requireReady('apiCall');
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const r = await fetch(`${e.baseUrl}${urlPath}`, opts);
    let j = null;
    try { j = await r.json(); } catch (_) { }
    return { status: r.status, body: j };
}

/**
 * 造一条 PENDING 状态的协作单：
 *   1. admin 创建 → PENDING_ASSIGN
 *   2. contact 调 assign 指派 dev1 → PENDING
 *
 * 返回 { id, oaNo, adminToken, contactToken, dev1Token }
 */
async function createPendingFixture() {
    requireReady('createPendingFixture');
    const adminToken = await signAs(ADMIN_ID);
    const contactToken = await signAs(CONTACT_ID);
    const dev1Token = await signAs(DEV1_ID);

    const oaNo = `OA_FX_${Date.now()}`;
    const createRes = await apiCall('POST', '/api/collab/requests', adminToken, {
        oa_request_no: oaNo,
        requester_dept: '市场营销部',
        requester_name: 'fixture',
        description: 'e2e fixture',
        deadline: '2026-12-31 18:00:00',
        contact_person_id: CONTACT_ID,
        target_db_connection_id: TARGET_DB_CONN_ID
    });
    if (createRes.status !== 200) {
        throw new Error(`fixture 创建失败: ${createRes.status} ${JSON.stringify(createRes.body)}`);
    }
    const id = createRes.body.id;

    // [#106 S4d-1 修复批 2] 建单已成功、指派失败（非 200 或请求抛错）：调用方拿不到 id（还没返回），make-dc 的 seed 回滚也清不到——
    // 所以在抛出前用本文件的 cleanup(id) 删掉刚建的单；抛出的错误带 fixtureCreatedId = id；cleanup 自己失败再带 cleanupErrors = [说明]
    // （与 make-dc-ui-fixtures.js 的 e.cleanupErrors 同名同形），调用方据此逐条计失败。成功路径与返回值形状不变。
    let assignFailure = null;
    try {
        const assignRes = await apiCall('POST', `/api/collab/requests/${id}/assign`, contactToken, { developer_id: DEV1_ID });
        if (assignRes.status !== 200) {
            assignFailure = new Error(`fixture 指派失败: ${assignRes.status} ${JSON.stringify(assignRes.body)}`);
        }
    } catch (e) {
        assignFailure = (e instanceof Error) ? e : new Error(`fixture 指派请求抛错: ${String(e)}`);
    }
    if (assignFailure) {
        assignFailure.fixtureCreatedId = id;
        try {
            await cleanup(id);
        } catch (ce) {
            assignFailure.cleanupErrors = [`夹具单 #${id} 指派失败后的回收清理失败: ${ce && ce.message}`];
        }
        throw assignFailure;
    }

    return { id, oaNo, adminToken, contactToken, dev1Token };
}

/**
 * 直接 UPDATE 推进协作单到指定状态（bypass-e2e / friction-e2e 用，模拟"开发已提交"等中间态）
 * 不走 submit 真实路径，避免触发 smoke test + mssql 真连
 *
 * @param {number} id
 * @param {object} patch  可设字段：status / sql_validation_status / sql_validation_error /
 *                                 sql_validated_at / done_at / submitted_at / last_submitted_at /
 *                                 attachment_dir / friction_occurred / friction_cause_category /
 *                                 friction_note / friction_recorded_at / bypass_validation /
 *                                 bypass_reason / bypass_by / bypass_by_name
 */
async function setCollabState(id, patch) {
    const allowedFields = [
        'status', 'sql_validation_status', 'sql_validation_error',
        'sql_validated_at', 'done_at', 'submitted_at', 'last_submitted_at',
        'attachment_dir', 'validation_started_at',
        'friction_occurred', 'friction_cause_category', 'friction_note', 'friction_recorded_at',
        'bypass_validation', 'bypass_reason', 'bypass_by', 'bypass_by_name',
        'submission_version',
        // v1.72.10 codex 50 L-1：V9c 测 EXPORTING 状态需要造 exporter 字段
        'exporter_user_id', 'exporter_name',
        // v1.72.3 admin 直派模式
        'assign_mode',
        // 2026-09-06：V9c 造「normal 已转发 EXPORTING」真实形态（Opus 预筛 M1）
        'forwarded_to_exporter_at',
        // 导出通知业务方（2026-05-29）：造 DONE 直派单 + 测 done_* 已读跟踪
        'done_notified_at', 'done_notify_message_key', 'done_read_at',
        // 通知/对接人字段（造测试单时直接设）
        'contact_person_id', 'contact_person_name',
        // v1.77.0 创建人发送权限：T5d 造"创建人非 admin"单（创建 endpoint 仅 admin，模拟需直改）
        'created_by', 'created_by_name'
    ];
    const sets = [];
    const params = [];
    for (const f of allowedFields) {
        if (f in patch) {
            sets.push(`${f}=?`);
            params.push(patch[f]);
        }
    }
    requireReady('setCollabState');   // 空补丁也要求已 ready（行为不随补丁内容变化）
    if (sets.length === 0) return;
    params.push(id);

    const db = await openInstanceDb(testEnv.env().dbPath);
    return new Promise((resolve, reject) => {
        db.run(`UPDATE collab_requests SET ${sets.join(', ')} WHERE id=?`, params, (err) => {
            // 等 close 回调再落定（S4-x）：关库错误不再丢失；resolve 时库句柄已经关闭。UPDATE 的错误优先，其次才是关库的错误（语句出错时也关库）
            db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(); });
        });
    });
}

/**
 * 删除测试协作单 + 级联清子表（FK CASCADE）
 */
async function cleanup(id) {
    requireReady('cleanup');
    const db = await openInstanceDb(testEnv.env().dbPath);
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('PRAGMA foreign_keys = ON');
            db.run('DELETE FROM collab_requests WHERE id = ?', [id], (err) => {
                // 等 close 回调再落定（S4-x，同 setCollabState）：关库错误不再丢失；resolve 时库句柄已经关闭。DELETE 的错误优先，其次才是关库的错误（语句出错时也关库）
                db.close((cerr) => { const e = err || cerr; e ? reject(e) : resolve(); });
            });
        });
    });
}

module.exports = {
    ready,
    teardown: () => testEnv.teardown(),
    finish: (code) => testEnv.finish(code),   // S4-x：teardown 之后的收尾（设退出码 + 不阻止退出的兜底计时器），见 lib/test-env.js finish
    ADMIN_ID,
    CONTACT_ID,
    DEV1_ID,
    PUBLISHER_ID,
    EXPORTER_ID,
    VIEWER_ID,
    VIEWER2_ID,
    TARGET_DB_CONN_ID,
    signAs,
    apiCall,
    createPendingFixture,
    setCollabState,
    cleanup,
    openInstanceDb,   // [#106 S4c 收口] 导出给脚本里的 db 助手：带打开回调、不带 OPEN_CREATE（不建空库），打开失败变 Promise 拒绝
};

// BASE / DB_PATH / JWT_SECRET：getter（ready() 完成之前读取抛 FX_NOT_READY）+ 抛错的 setter（旧脚本运行期改写 fixture 的 BASE 会立即失败，而不是静默无效）
for (const [name, pick] of [['BASE', (e) => e.baseUrl], ['DB_PATH', (e) => e.dbPath], ['JWT_SECRET', (e) => e.jwtSecret]]) {
    Object.defineProperty(module.exports, name, { enumerable: true, get: () => readyOnly(name, pick), set: readOnlyProp(name) });
}
