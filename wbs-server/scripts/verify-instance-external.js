/**
 * #106 S1b 外部调用闸门 / 隔离库准备 验证（进程内，不起 server.js、不连外部库、不发任何真实请求、不打开业务库）。
 *
 * 全程外连绊线（T1）：本脚本在加载任何被测模块之前就把全局 fetch 换成「记录 + 抛错」的绊线，并让 net.Socket.prototype.connect 对非回环地址同样记录 + 抛错；
 *   只有「正常模式透传」用例在局部临时换成返回固定响应的探针，用完换回绊线（不是真实 fetch）。进程结束前断言绊线命中 0 次——所以被测实现即使
 *   误把请求回退成真实 fetch，也是先被绊线截住再判红，不会真的发出去。
 *
 * 口径说明（T4）：第 3 段「外部库创建点」是把 server.js 里 getMssqlPool / getMysqlPool / test-new 的**函数文本**抽出来放进带探针的 vm 沙箱执行，
 *   证明的是「抽出的函数文本在给定依赖（sql / mysql / externalGate 由沙箱提供）下」的行为；它**不**证明 server.js 顶部的驱动导入是对的。
 *   后一半由一条静态契约断言补上：server.js 里 `const sql = require('mssql')`、`const mysql = require('mysql2/promise')` 存在，且绑定名与抽取函数里使用的名字一致。
 *   另：正常模式等价**不覆盖数据库资源操作次数**（mysql 的 getConnection / ping / release / query / end，MSSQL 的 query / close 都没有计数断言）——按测试轮上限登记的残余。
 *
 * 覆盖：
 *   0  绊线自检
 *   1  钉钉闸门：隔离配置下 9 个接口函数全部走替身（真实 fetch 绊线一次都不许响），响应能让调用方解析走成功分支；
 *      未识别接口 / handler 异常：先记录再 reject（err.code）；external-calls.jsonl 逐次记录且逐字段脱敏（各哨兵值互不相同）；写日志失败不影响业务；
 *      运行模式判定被拒绝时 fail-closed；虚拟标识跨实例唯一
 *   2  正常模式不变：fetchWithTimeout 原样调用全局 fetch（URL、选项、signal），不进替身、不写日志（预置日志的大小与内容哈希前后比对）
 *   2b 闸门判定的表驱动矩阵：null / {} / 缺 external / 未知值 / refuse+real / 正常配置——只有正常配置放行
 *   3  外部库 4 个创建点（见上「口径说明」）：正常模式走原路径且连接参数与缓存行为与改造前一致、隔离模式抛 EXTERNAL_DISABLED 且探针一次都不被调用；
 *      test-new 的正常模式失败响应与改造前逐字相同
 *   4  文档发布：隔离模式 409 且在任何文件操作之前；正常模式仍走原逻辑
 *   5  设备巡检采集器：隔离模式不读配置文件、不启动 PowerShell，所有采集入口（target / collectSnapshot）都被拦住
 *   6  createIsolatedDb（VACUUM INTO 建目标 + 隔离化）：身份 + 虚拟钉钉凭证（隔离键加密）+ 清口令，同一事务；失败整体回滚并清理目标；与 server.js 的建表 / 写配置语句对拍；
 *      目标必须原先不存在（空文件 / 硬链接 / 符号链接一律 TARGET_EXISTS）；防呆（原样路径 + 真实路径两组祖先含 junction）；来源/目标目录检查；
 *      内部函数 _internal.prepareIsolatedDb 的 WAL 模式检查点
 *   7  （S2-0）system_configs 白名单重写：传正确 / 显式 null / 缺键（SOURCE_KEY_REQUIRED）/ 错误来源键（SOURCE_KEY_MISMATCH：判据 = 来源里有非空白名单行、且干净解密数为 0，
 *      7.9 四个场景 + 零候选行成功）、注入乱码、混合夹具、隔离库作来源（SOURCE_KEY_UNEXPECTED）、身份行不合法的隔离来源（SOURCE_IDENTITY_INVALID）、
 *      7.8 逐键负例 / 正例 / 声明的两处差异（总长度 2048、列表键含 U+FFFD / 控制字符整串删）、writeInstanceIdentity 不再公开、
 *      解密钩子记录的键集合（解密包装在第 7 段内一直留在 require 缓存里，段末在 finally 里恢复原模块与缓存）、中途失败整体回滚；
 *      泄漏检查（返回值 / 错误 / 全部输出里无明文无密钥）放在第 7 段最末，且先断言语料里确有每个子例的标签。全部用测试里写死的假来源键与哨兵值，不读 .env、不碰业务库
 *
 * 运行：node scripts/verify-instance-external.js
 * 变异自证用：设置 INSTANCE_VERIFY_SOURCE_ROOT=<被测 wbs-server 副本的绝对路径>，脚本改为从该副本加载 utils / routes / server.js 源码。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const childProcess = require('child_process');

// ---- 全程外连绊线（T1）：必须在加载任何被测模块之前安装；本脚本里不保留真实 fetch 的引用 ----
const TRIP = { hits: [] };
global.fetch = async function trippedFetch(input) {
    const u = (input && typeof input === 'object' && input.url) || String(input);
    TRIP.hits.push(`fetch ${u}`);
    throw new Error(`TRIPWIRE: 真实 fetch 被调用 ${u}`);
};
const TRIPWIRE_FETCH = global.fetch;
{
    const isLoopback = (h) => h === undefined || h === null || h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h === '0.0.0.0' || h === '::';
    TRIP.origConnect = net.Socket.prototype.connect;   // 自检里会临时换成探针来数“原始 connect 被调用几次”
    net.Socket.prototype.connect = function trippedConnect() {
        let a = arguments[0];
        if (Array.isArray(a)) a = a[0];   // net 内部把参数归一成 [options, cb]
        let host;
        let port;
        if (a && typeof a === 'object') {
            // T8：只有 path 是非空字符串才算本地 IPC；path 为 null / undefined / '' 等空值时 Node 按 TCP 处理，必须检查 host
            if (!(typeof a.path === 'string' && a.path !== '')) { host = a.host; port = a.port; }
        } else if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
            host = typeof arguments[1] === 'string' ? arguments[1] : undefined;
            port = a;
        }
        if (!isLoopback(host)) {
            TRIP.hits.push(`connect ${host}:${port}`);
            throw new Error(`TRIPWIRE: 连接非回环地址 ${host}:${port}`);
        }
        return TRIP.origConnect.apply(this, arguments);
    };
}

const SELF_ROOT = path.resolve(__dirname, '..');
const ROOT = process.env.INSTANCE_VERIFY_SOURCE_ROOT ? path.resolve(process.env.INSTANCE_VERIFY_SOURCE_ROOT) : SELF_ROOT;
for (const k of Object.keys(process.env)) { if (/^sdh_/i.test(k)) delete process.env[k]; }

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  [OK] ${m}`); };
const bad = (m, d) => { fail++; console.log(`  [FAIL] ${m}${d ? '\n         ' + d : ''}`); };
const must = (cond, m, d) => (cond ? ok(m) : bad(m, d));
const section = (t) => console.log(`\n== ${t} ==`);
const jstr = (v) => { try { return JSON.stringify(v); } catch (_) { return String(v); } };

const load = (rel) => require(path.join(ROOT, rel));
const externalGate = load('utils/external-gate.js');
const dingtalk = load('utils/dingtalk-notify.js');
const stubMod = load('utils/dingtalk-stub.js');
const instanceMode = load('utils/instance-mode.js');
const instanceDb = load('utils/instance-db.js');
const aes = load('utils/aes-password.js');
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdh-s1b-ext-'));

// ---- 运行模式配置（用真实的 resolveInstanceConfig 生成，不手写字段）----
const enoent = () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
const NORMAL_CFG = instanceMode.resolveInstanceConfig({ env: {}, checkoutDir: ROOT, readFile: enoent });
function isolatedCfg(dataRoot) {
    return instanceMode.resolveInstanceConfig({
        env: { SDH_DATA_DIR: dataRoot },
        checkoutDir: ROOT,
        readFile: (p) => (String(p).endsWith('.sdh-instance') ? 'line-s1b\n' : enoent()),
    });
}
const REFUSED_CFG = instanceMode.resolveInstanceConfig({ env: { SDH_EXTERNAL: 'stub' }, checkoutDir: ROOT, readFile: enoent });

// ---- 绊线辅助：armFetchTrip 记录起点，tripCallsSince 返回起点之后的命中；restoreFetch 换回**绊线**（不是真实 fetch）----
let tripMark = 0;
function armFetchTrip() { tripMark = TRIP.hits.length; global.fetch = TRIPWIRE_FETCH; }
function tripCallsSince() { return TRIP.hits.slice(tripMark); }
function restoreFetch() { global.fetch = TRIPWIRE_FETCH; }
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
/** 文件指纹：存在性 + 大小 + 内容哈希（不存在返回 null） */
function fileFp(f) {
    if (!fs.existsSync(f)) return null;
    const b = fs.readFileSync(f);
    return { size: b.length, sha: sha256(b) };
}

function readJsonl(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ---- 从 server.js 源码里抽出一段完整代码（带字符串 / 注释 / 模板字面量感知的括号配对）----
function matchClose(src, openIdx, open, close) {
    let depth = 0;
    const stack = [];   // 模板字面量里的 ${ 嵌套：记录进入时的 depth
    for (let i = openIdx; i < src.length; i++) {
        const c = src[i];
        const n = src[i + 1];
        if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i++; continue; }
        if (c === '\'' || c === '"') {
            const q = c;
            for (i++; i < src.length && src[i] !== q; i++) { if (src[i] === '\\') i++; }
            continue;
        }
        if (c === '`') {
            for (i++; i < src.length && src[i] !== '`'; i++) {
                if (src[i] === '\\') { i++; continue; }
                if (src[i] === '$' && src[i + 1] === '{') {
                    // 模板里的表达式：递归匹配到对应的 }
                    const end = matchClose(src, i + 1, '{', '}');
                    if (end < 0) return -1;
                    i = end;
                }
            }
            continue;
        }
        if (c === open) depth++;
        else if (c === close) { depth--; if (depth === 0) return i; }
    }
    return -1;
}
function extractFunction(src, headerRe) {
    const m = headerRe.exec(src);
    if (!m) throw new Error('找不到函数头 ' + headerRe);
    const braceIdx = src.indexOf('{', m.index + m[0].length - 1);
    const end = matchClose(src, braceIdx, '{', '}');
    if (end < 0) throw new Error('括号不配对 ' + headerRe);
    return src.slice(m.index, end + 1);
}
function extractCallStatement(src, startNeedle) {
    const idx = src.indexOf(startNeedle);
    if (idx < 0) throw new Error('找不到语句 ' + startNeedle);
    const open = src.indexOf('(', idx);
    const end = matchClose(src, open, '(', ')');
    if (end < 0) throw new Error('括号不配对 ' + startNeedle);
    return src.slice(idx, end + 1) + ';';
}

/** 往临时库的 db_connections 种三行「真实形态密文」的连接（单条 INSERT，一个字符串字面量——db_connections 直写登记守卫 verify-db-connections-writers 的约定）。 */
async function seedDbConnections(file, cipher) {
    const sqlite3 = require('sqlite3');
    await new Promise((res, rej) => {
        const d = new sqlite3.Database(file, (e) => {
            if (e) return rej(e);
            d.exec(`INSERT INTO db_connections (name, type, host, port, database, username, password) VALUES ('wh', 'sqlserver', '10.1.1.1', 1433, 'dw', 'sa', '${cipher}'), ('src', 'mysql', '10.1.1.2', 3306, 'hrd', 'ro', '${cipher}'), ('ext', 'external', '-', 0, '-', '-', '')`, (er) => d.close(() => (er ? rej(er) : res())));
        });
    });
}

function fakeRes() {
    const r = { statusCode: 200, body: undefined, ended: false };
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; r.ended = true; return r; };
    return r;
}

(async () => {
    console.log(`被测源码根目录：${ROOT}${ROOT === SELF_ROOT ? '' : '（变异副本）'}`);
    console.log(`临时目录：${TMP}`);
    try {
        // ======================= 0. 绊线自检 =======================
        section('0 外连绊线自检：全局 fetch / 非回环 TCP 连接都被记录并抛错；回环不算');
        {
            let e1 = null;
            try { await fetch('https://trip-selftest.invalid/x'); } catch (e) { e1 = e; }
            must(e1 && /TRIPWIRE/.test(e1.message) && TRIP.hits.length === 1 && /^fetch https:\/\/trip-selftest\.invalid/.test(TRIP.hits[0]), '全局 fetch 已是绊线：调用被记录并抛错', jstr({ m: e1 && e1.message, hits: TRIP.hits }));
            let e2 = null;
            try { net.connect(80, '203.0.113.7'); } catch (e) { e2 = e; }
            must(e2 && /TRIPWIRE/.test(e2.message) && TRIP.hits.length === 2 && /^connect 203\.0\.113\.7:80$/.test(TRIP.hits[1]), '非回环 TCP 连接被记录并抛错（连接没有发出）', jstr({ m: e2 && e2.message, hits: TRIP.hits }));
            // T8：path 为 null / '' 的对象参数在 Node 里按 TCP 处理，同样必须被绊线拒绝，且拒绝发生在调用原始 connect 之前
            {
                const realOrig = TRIP.origConnect;
                let origCalls = 0;
                TRIP.origConnect = function probeConnect() { origCalls += 1; return this; };
                try {
                    TRIP.hits.length = 0;
                    const results = [];
                    for (const [label, opts] of [['path:null', { host: '203.0.113.7', port: 80, path: null }], ["path:''", { host: '203.0.113.8', port: 80, path: '' }], ['path:undefined', { host: '203.0.113.9', port: 80, path: undefined }]]) {
                        let ee = null;
                        try { net.connect(opts); } catch (e) { ee = e; }
                        results.push([label, !!(ee && /TRIPWIRE/.test(ee.message))]);
                    }
                    must(results.every(([, rejected]) => rejected) && TRIP.hits.length === 3 && origCalls === 0,
                        '绊线拒绝 { host: 非回环, port, path: null / "" / undefined } 的对象参数，且拒绝发生在原始 connect 之前（探针计数 0）', jstr({ results, hits: TRIP.hits, origCalls }));
                    // 对照：真正的本地 IPC（path 为非空字符串）不被绊线拦，会走到原始 connect
                    TRIP.hits.length = 0;
                    net.connect({ path: '\\\\.\\pipe\\sdh-trip-selftest-not-exist' });
                    must(TRIP.hits.length === 0 && origCalls === 1, '对照：path 为非空字符串（本地 IPC）不触发绊线，调用到达原始 connect', jstr({ hits: TRIP.hits, origCalls }));
                } finally {
                    TRIP.origConnect = realOrig;
                }
            }
            TRIP.hits.length = 0;
            await new Promise((res) => { const s = net.connect(1, '127.0.0.1'); s.on('error', () => res()); s.on('connect', () => { s.destroy(); res(); }); });
            must(TRIP.hits.length === 0, '对照：连接回环地址不触发绊线', jstr(TRIP.hits));
        }

        // ======================= 1. 钉钉闸门（隔离配置）=======================
        section('1 钉钉闸门：隔离配置下 9 个接口函数走替身，真实 fetch 一次都不响');
        const dataRoot = path.join(TMP, 'iso-data');
        fs.mkdirSync(dataRoot, { recursive: true });
        const ISO = isolatedCfg(dataRoot);
        must(ISO.mode === 'isolated' && ISO.external === 'stub' && ISO.dataRoot === dataRoot, '前提：构造出的配置是隔离模式、external=stub、数据根=临时目录', jstr(ISO));
        externalGate._setConfigProviderForTest(() => ISO);
        dingtalk._resetCacheForTest();
        armFetchTrip();
        const SECRET = 'APPSECRET-test-123';
        const APPKEY = 'APPKEY-test-456';
        const PHONE = '13812345678';
        const logFile = path.join(dataRoot, 'external-calls.jsonl');
        let token, uid, md, chat, grp, rs, media, fileResp, add;
        try {
            token = await dingtalk.getAccessToken(APPKEY, SECRET);
            must(typeof token === 'string' && token.length > 0, 'getAccessToken：解析出 access_token（走成功分支）', jstr(token));
            uid = await dingtalk.getUserIdByMobile(token, PHONE);
            must(typeof uid === 'string' && /^sdh-stub-user-[0-9a-f]{8}$/.test(uid), 'getUserIdByMobile：返回稳定可识别的虚拟 userid', jstr(uid));
            const uid2 = await dingtalk.getUserIdByMobile(token, PHONE);
            const uid3 = await dingtalk.getUserIdByMobile(token, '13900000000');
            must(uid2 === uid && uid3 !== uid, '虚拟 userid 对同一手机号稳定、对不同手机号不同');
            md = await dingtalk.sendMarkdownToUser(token, 'RC-1', [uid], 'T', '# 正文 13812345678');
            must(md && md.errcode === 0 && Array.isArray(md.invalidStaffIdList) && md.invalidStaffIdList.length === 0 && /^sdh-stub-pqk-/.test(md.processQueryKey || ''),
                'sendMarkdownToUser：errcode=0、invalidStaffIdList=[]、processQueryKey 非空（调用方的软成功判据全部通过）', jstr(md));
            const md2 = await dingtalk.sendMarkdownToUser(token, 'RC-1', [uid], 'T', 'x');
            must(md2.processQueryKey !== md.processQueryKey, '每次发送的 processQueryKey 不同（已读跟踪 / 唯一约束不会撞）');
            chat = await dingtalk.createChatGroup(token, '群名', uid, [uid, 'sdh-stub-user-ffffffff']);
            must(chat && chat.errcode === 0 && /^sdh-stub-chat-[0-9a-f]{16}$/.test(chat.chatid || '') && /^sdh-stub-ocid-[0-9a-f]{16}$/.test(chat.openConversationId || '')
                && chat.chatid.slice('sdh-stub-chat-'.length) === chat.openConversationId.slice('sdh-stub-ocid-'.length),
                'createChatGroup：errcode=0、chatid / openConversationId 为虚拟值（16 位十六进制随机串，两者共用同一串便于对照）', jstr(chat));
            grp = await dingtalk.sendGroupMessage(token, 'RC-1', chat.openConversationId, 'sampleMarkdown', { title: 't', text: 'x' });
            must(grp && !grp.code && /^sdh-stub-gmsg-/.test(grp.processQueryKey || ''), 'sendGroupMessage：返回值为真且没有 code 字段（调用方只检查这两点）', jstr(grp));
            rs = await dingtalk.getReadStatus(token, 'RC-1', md.processQueryKey);
            must(rs && Array.isArray(rs.readUserIds) && rs.readUserIds.length === 0 && Array.isArray(rs.readDetails) && rs.readDetails.length === 0
                && rs.raw && rs.raw.errcode === 0 && Array.isArray(rs.raw.messageReadInfoList) && rs.raw.messageReadInfoList.length === 0,
                'getReadStatus：解析出空的已读列表（readUserIds=[]、readDetails=[]、raw.errcode=0、raw.messageReadInfoList=[]）', jstr(rs));
            const cls = dingtalk.classifyReadStatus ? dingtalk.classifyReadStatus(rs, uid, new Date().toISOString().replace('T', ' ').slice(0, 19), Date.now()) : null;
            must(cls === null || cls.state === 'unread' || cls.state === 'unqueryable', 'classifyReadStatus 吃得下替身的已读结构（不抛错）', jstr(cls));
            media = await dingtalk.uploadMedia(token, 'a.xlsx', Buffer.from('xx'));
            must(typeof media === 'string' && /^sdh-stub-media-[0-9a-f]{16}$/.test(media), 'uploadMedia：返回 media_id（errcode=0 且 media_id 非空才不抛错）', jstr(media));
            fileResp = await dingtalk.sendFileToUser(token, 'RC-1', [uid], media, 'a.xlsx');
            must(fileResp && fileResp.errcode === 0 && fileResp.invalidStaffIdList.length === 0 && /^sdh-stub-pqk-/.test(fileResp.processQueryKey || ''), 'sendFileToUser：errcode=0、invalidStaffIdList=[]、processQueryKey 非空', jstr(fileResp));
            add = await dingtalk.addUserToChat(token, chat.chatid, [uid]);
            must(add && add.ok === true && add.errcode === 0 && Array.isArray(add.errorUserIds) && add.errorUserIds.length === 0, 'addUserToChat：ok=true、errcode=0、errorUserIds=[]', jstr(add));
            must(dingtalk.classifyAddUserErrcode(add.errcode, add.errorUserIds).kind === 'soft_success', 'classifyAddUserErrcode 把替身结果判为 soft_success');
        } finally {
            restoreFetch();
        }
        must(tripCallsSince().length === 0, '真实 fetch 绊线全程没响（隔离配置下没有任何请求绕过闸门）', jstr(tripCallsSince()));

        // ---- 日志 ----
        const records = readJsonl(logFile);
        // 调用次数：gettoken 1（后续命中缓存）+ get_by_mobile 3 + batchSend 2(md)+1(file) + chat/create 1 + groupMessages 1 + readStatus 1 + media 1 + chat/update 1 = 12
        const apis = records.map((r) => r.api);
        must(records.length === 12, `external-calls.jsonl 每次调用一行（期望 12 行）`, `实际 ${records.length} 行：${apis.join(' ')}`);
        for (const a of ['/gettoken', '/user/get_by_mobile', '/v1.0/robot/oToMessages/batchSend', '/v1.0/robot/oToMessages/readStatus', '/chat/create', '/chat/update', '/media/upload', '/v1.0/robot/groupMessages/send']) {
            must(apis.includes(a), `日志含接口 ${a}`);
        }
        must(records.every((r) => r.at && !Number.isNaN(Date.parse(r.at)) && typeof r.method === 'string' && r.params && typeof r.params === 'object' && r.outcome === 'stubbed'),
            '每行都有 at / api / method / params / outcome=stubbed');
        const logText = fs.readFileSync(logFile, 'utf8');
        must(!logText.includes(SECRET), '日志里搜不到 appsecret 原文');
        must(!logText.includes(APPKEY), '日志里搜不到 appkey 原文');
        must(!logText.includes(stubMod.STUB_ACCESS_TOKEN) && !logText.includes(token), '日志里搜不到 access_token 原文');
        must(!logText.includes(PHONE) && logText.includes('138****5678'), '日志里搜不到手机号原文，只有前三后四的脱敏形式');
        must(!logText.includes('# 正文'), '日志里没有消息正文（msgParam 只记长度）');
        const tokenRec = records.find((r) => r.api === '/gettoken');
        must(tokenRec && tokenRec.params.query.appkey === '***' && tokenRec.params.query.appsecret === '***', 'gettoken 记录里 appkey / appsecret 为 ***', jstr(tokenRec));

        // ---- 未识别接口 / handler 异常 / 不可解析 URL（F2）：先记录、再 reject，绝不返回成功形态的响应 ----
        const errOf = async (fn) => { try { await fn(); return null; } catch (x) { return x; } };
        const stubFetch = stubMod.createDingtalkStub({ dataRoot: path.join(TMP, 'stub-direct') });
        const xUnknown = await errOf(() => stubFetch('https://api.dingtalk.com/v1.0/some/new/api?access_token=ZZZ-secret', { method: 'POST', body: JSON.stringify({ a: 1, appsecret: 'ZZZ-secret' }) }));
        must(xUnknown && xUnknown.code === 'EXTERNAL_STUB_UNRECOGNIZED' && /api\.dingtalk\.com\/v1\.0\/some\/new\/api/.test(xUnknown.message) && !/ZZZ-secret/.test(xUnknown.message),
            '未识别接口：reject，err.code = EXTERNAL_STUB_UNRECOGNIZED，消息含接口键、不含查询串里的密钥', jstr(xUnknown && { c: xUnknown.code, m: xUnknown.message }));
        const xBad = await errOf(() => stubFetch('not a url', {}));
        must(xBad && xBad.code === 'EXTERNAL_STUB_UNRECOGNIZED', '不可解析的 URL：同样 reject（EXTERNAL_STUB_UNRECOGNIZED）', jstr(xBad && { c: xBad.code, m: xBad.message }));
        const direct = readJsonl(path.join(TMP, 'stub-direct', 'external-calls.jsonl'));
        must(direct.length === 2 && direct[0].outcome === 'unrecognized' && direct[1].outcome === 'unrecognized', '未识别调用先于抛错被记录，outcome=unrecognized', jstr(direct));
        must(!JSON.stringify(direct).includes('ZZZ-secret'), '未识别调用的记录同样脱敏（query 与 body 里的密钥）');
        must(direct[1].api === '<unparseable url len 9>', '不可解析的网址：api 字段是固定占位 <unparseable url len N>，不落原文', jstr(direct[1]));
        // handler 异常：让 media/upload 的 handler 在第一次取时钟时抛错（handler 先于写日志取一次时钟；之后的取时钟照常），应记录 stub_error 并 reject EXTERNAL_STUB_ERROR
        {
            let clockCalls = 0;
            const stubErr = stubMod.createDingtalkStub({ dataRoot: path.join(TMP, 'stub-handler-err'), now: () => { clockCalls += 1; if (clockCalls === 1) throw new Error('handler boom'); return new Date(); } });
            const xErr = await errOf(() => stubErr('https://oapi.dingtalk.com/media/upload?access_token=T', { method: 'POST' }));
            const errRecs = readJsonl(path.join(TMP, 'stub-handler-err', 'external-calls.jsonl'));
            must(xErr && xErr.code === 'EXTERNAL_STUB_ERROR' && /oapi\.dingtalk\.com\/media\/upload/.test(xErr.message) && /handler boom/.test(xErr.message),
                'handler 异常：reject，err.code = EXTERNAL_STUB_ERROR，消息含接口键与原因', jstr(xErr && { c: xErr.code, m: xErr.message }));
            must(errRecs.length === 1 && errRecs[0].outcome === 'stub_error', 'handler 异常也先被记录，outcome=stub_error', jstr(errRecs));
        }
        // 虚拟标识跨实例唯一（F3）：两次独立创建的替身实例各建一个群 / 传一个文件 / 发一条消息 → 标识都不相同
        {
            const sA = stubMod.createDingtalkStub({ dataRoot: path.join(TMP, 'stub-id-a') });
            const sB = stubMod.createDingtalkStub({ dataRoot: path.join(TMP, 'stub-id-b') });
            const call = async (s, u, o) => (await s(u, o || {})).json();
            const cA = await call(sA, 'https://oapi.dingtalk.com/chat/create?access_token=T', { method: 'POST', body: JSON.stringify({ name: 'g' }) });
            const cB = await call(sB, 'https://oapi.dingtalk.com/chat/create?access_token=T', { method: 'POST', body: JSON.stringify({ name: 'g' }) });
            must(cA.chatid && cB.chatid && cA.chatid !== cB.chatid && cA.openConversationId !== cB.openConversationId, '两个独立替身实例各建一个群：chatid / openConversationId 都不相同（不再是进程内计数器）', jstr({ cA, cB }));
            const mA = await call(sA, 'https://oapi.dingtalk.com/media/upload?access_token=T', { method: 'POST' });
            const mB = await call(sB, 'https://oapi.dingtalk.com/media/upload?access_token=T', { method: 'POST' });
            must(mA.media_id !== mB.media_id, '两个实例的 media_id 不相同', jstr({ mA, mB }));
            const pA = await call(sA, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend?x-acs-dingtalk-access-token=T', { method: 'POST', body: '{}' });
            const pB = await call(sB, 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend?x-acs-dingtalk-access-token=T', { method: 'POST', body: '{}' });
            const gA = await call(sA, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send?x-acs-dingtalk-access-token=T', { method: 'POST', body: '{}' });
            const gB = await call(sB, 'https://api.dingtalk.com/v1.0/robot/groupMessages/send?x-acs-dingtalk-access-token=T', { method: 'POST', body: '{}' });
            must(pA.processQueryKey !== pB.processQueryKey && gA.processQueryKey !== gB.processQueryKey && /^sdh-stub-pqk-[0-9a-f]{16}$/.test(pA.processQueryKey) && /^sdh-stub-gmsg-[0-9a-f]{16}$/.test(gA.processQueryKey),
                '两个实例的单聊 / 群消息 processQueryKey 都不相同，且格式为前缀 + 16 位十六进制', jstr({ pA, pB, gA, gB }));
            const u1 = await call(sA, 'https://oapi.dingtalk.com/user/get_by_mobile?access_token=T&mobile=13800000001');
            const u2 = await call(sB, 'https://oapi.dingtalk.com/user/get_by_mobile?access_token=T&mobile=13800000001');
            must(u1.userid === u2.userid, '对照：userid 按手机号哈希，同一手机号在不同实例里保持稳定（有意如此）', jstr({ u1, u2 }));
        }

        // ---- 逐字段脱敏（T5）：各敏感字段用互不相同的哨兵值，调用后对整份日志逐个断言原文不出现 ----
        {
            const SENT = {
                appkey: 'SENT-APPKEY-7a1', appsecret: 'SENT-APPSECRET-7a2', accessToken: 'SENT-ACCESSTOKEN-7a3', robotCode: 'SENT-ROBOTCODE-7a4',
                phone: '13711112222', queryRobot: 'SENT-QROBOT-7a5', nested: 'SENT-NESTED-7a6', formToken: 'SENT-FORMTOKEN-7a7', formSecret: 'SENT-FORMSECRET-7a8',
                header: 'SENT-HEADER-7a9', msg: 'SENT-MSGBODY-7b0', badUrl: 'SENT-BADURL-7b1', bodyPassword: 'SENT-PASSWORD-7b2',
            };
            const sdir = path.join(TMP, 'stub-sanitize');
            const sS = stubMod.createDingtalkStub({ dataRoot: sdir });
            await sS(`https://oapi.dingtalk.com/gettoken?appkey=${SENT.appkey}&appsecret=${SENT.appsecret}&visible=ok-visible`, {});
            await sS(`https://oapi.dingtalk.com/user/get_by_mobile?access_token=${SENT.accessToken}&mobile=${SENT.phone}`, {});
            await sS(`https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend?x-acs-dingtalk-access-token=${SENT.header}&robotCode=${SENT.queryRobot}`, {
                method: 'POST',
                headers: { 'x-acs-dingtalk-access-token': SENT.header },
                body: JSON.stringify({
                    robotCode: SENT.robotCode, userIds: ['u1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 't', text: SENT.msg }),
                    mobile: SENT.phone, payload: { appsecret: SENT.nested, inner: { access_token: SENT.nested + '-deep' } }, password: SENT.bodyPassword, note: 'visible-note',
                }),
            });
            const fd = new FormData();
            fd.append('access_token', SENT.formToken);
            fd.append('appsecret', SENT.formSecret);
            fd.append('media', new Blob(['xx']), 'a.xlsx');
            await sS('https://oapi.dingtalk.com/media/upload?type=file', { method: 'POST', body: fd });
            const xBadUrl = await errOf(() => sS(`not a url?appsecret=${SENT.badUrl}`, { method: 'POST' }));
            must(xBadUrl && xBadUrl.code === 'EXTERNAL_STUB_UNRECOGNIZED' && !xBadUrl.message.includes(SENT.badUrl), '带 appsecret 的不可解析网址：reject，错误消息里也没有原文', jstr(xBadUrl && xBadUrl.message));
            const sText = fs.readFileSync(path.join(sdir, 'external-calls.jsonl'), 'utf8');
            must(sText.includes('ok-visible') && sText.includes('visible-note'), '对照：非敏感字段照常记录（证明日志确实写了、摘要确实展开了）', sText.slice(0, 300));
            for (const [name, val] of Object.entries(SENT)) {
                must(!sText.includes(val), `日志里搜不到哨兵 ${name} 的原文`);
            }
            must(sText.includes('137****2222'), '手机号只留前三后四');
            const badRec = readJsonl(path.join(sdir, 'external-calls.jsonl')).pop();
            must(badRec && badRec.api === `<unparseable url len ${`not a url?appsecret=${SENT.badUrl}`.length}>` && badRec.outcome === 'unrecognized', '不可解析网址的记录：api 为固定占位，outcome=unrecognized', jstr(badRec));
        }

        const txt = await (await stubFetch('https://oapi.dingtalk.com/gettoken?appkey=a&appsecret=b', {})).text();
        must(JSON.parse(txt).errcode === 0, '替身响应对象支持 .text()');
        // 数据根是一个文件：mkdir / append 必失败，业务调用仍须成功
        const blocker = path.join(TMP, 'blocker-file');
        fs.writeFileSync(blocker, 'x');
        const stubBroken = stubMod.createDingtalkStub({ dataRoot: path.join(blocker, 'sub') });
        const warns = [];
        const origWarn = console.warn;
        console.warn = (...a) => warns.push(a.join(' '));
        let brokenResp;
        try { brokenResp = await (await stubBroken('https://oapi.dingtalk.com/gettoken?appkey=a&appsecret=b', {})).json(); } finally { console.warn = origWarn; }
        must(brokenResp && brokenResp.errcode === 0 && warns.length === 1 && /写 external-calls\.jsonl 失败/.test(warns[0]), '日志写失败：只打一行警告，替身响应不受影响', jstr({ brokenResp, warns }));

        // ---- 判定被拒绝：fail-closed ----
        externalGate._setConfigProviderForTest(() => REFUSED_CFG);
        armFetchTrip();
        let refusedErr = null;
        try { dingtalk._resetCacheForTest(); await dingtalk.getAccessToken('k', 's'); } catch (e) { refusedErr = e; } finally { restoreFetch(); }
        must(REFUSED_CFG.refuse === true && refusedErr && refusedErr.code === 'EXTERNAL_DISABLED' && tripCallsSince().length === 0,
            '运行模式判定被拒绝（refuse）：钉钉调用抛 EXTERNAL_DISABLED，真实 fetch 不响（fail-closed）', jstr({ refusedErr: refusedErr && refusedErr.message, tripCalls: tripCallsSince() }));

        // ======================= 2. 正常模式不变 =======================
        section('2 正常模式：fetchWithTimeout 原样调用全局 fetch，不进替身、不写日志');
        externalGate._setConfigProviderForTest(() => NORMAL_CFG);
        must(NORMAL_CFG.mode === 'normal' && NORMAL_CFG.external === 'real', '前提：构造出的配置是正常模式、external=real', jstr(NORMAL_CFG));
        dingtalk._resetCacheForTest();
        const probeCalls = [];
        global.fetch = async (url, opts) => {
            probeCalls.push({ url: String(url), opts });
            return new Response(JSON.stringify({ errcode: 0, access_token: 'T-normal', expires_in: 7200, processQueryKey: 'PQK-normal', invalidStaffIdList: [] }), { status: 200 });
        };
        // T7：候选日志路径都记「存在性 + 大小 + 内容哈希」，调用后逐一比较；受控临时目录里预置一份已有的 external-calls.jsonl 并把 cwd 切过去，
        //   正常模式既不能新建也不能追加（追加一个字节哈希就变）
        const normCwd = path.join(TMP, 'normal-cwd');
        fs.mkdirSync(normCwd, { recursive: true });
        fs.writeFileSync(path.join(normCwd, 'external-calls.jsonl'), '{"preseeded":true}\n');
        const origCwd = process.cwd();
        process.chdir(normCwd);
        const logCandidates = [logFile, path.join(ROOT, 'external-calls.jsonl'), path.join(normCwd, 'external-calls.jsonl'), path.join(os.tmpdir(), 'external-calls.jsonl'), path.join(normCwd, 'data', 'external-calls.jsonl')];
        const fpBefore = logCandidates.map(fileFp);
        must(fpBefore[0] !== null && fpBefore[2] !== null, '前提：隔离数据根里的日志与受控目录里预置的日志都已存在', jstr(fpBefore));
        try {
            const t = await dingtalk.getAccessToken('k 1', 's&2');
            must(t === 'T-normal', '正常模式 getAccessToken 返回探针里的 token（走了全局 fetch）', jstr(t));
            must(probeCalls.length === 1 && probeCalls[0].url === 'https://oapi.dingtalk.com/gettoken?appkey=k%201&appsecret=s%262', 'URL 与改造前一致（encodeURIComponent 拼接）', jstr(probeCalls[0]));
            must(probeCalls[0].opts && probeCalls[0].opts.signal instanceof AbortSignal, '选项里带 AbortController 的 signal（超时机制保留）');
            const r = await dingtalk.sendMarkdownToUser('TOK', 'RC', ['u1'], 'ttl', 'md');
            const c1 = probeCalls[1];
            must(c1 && c1.url === 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend?x-acs-dingtalk-access-token=TOK' && c1.opts.method === 'POST'
                && c1.opts.headers['Content-Type'] === 'application/json'
                && c1.opts.body === JSON.stringify({ robotCode: 'RC', userIds: ['u1'], msgKey: 'sampleMarkdown', msgParam: JSON.stringify({ title: 'ttl', text: 'md' }) }),
                'sendMarkdownToUser：method / headers / body 原样透传给全局 fetch', jstr(c1));
            must(r && r.processQueryKey === 'PQK-normal', '返回的是探针响应的 JSON（不是替身）', jstr(r));
        } finally {
            restoreFetch();   // 换回绊线（不是真实 fetch）
            process.chdir(origCwd);
        }
        must(!probeCalls.some((c) => /sdh-stub/.test(c.url)), '正常模式没有任何虚拟值进入请求');
        const fpAfter = logCandidates.map(fileFp);
        must(jstr(fpAfter) === jstr(fpBefore), '正常模式不写 external-calls.jsonl：5 个候选路径的存在性 / 大小 / 内容哈希前后完全一致（既没新建也没追加）', jstr({ before: fpBefore, after: fpAfter }));
        must(externalGate.dingtalkFetchOverride(NORMAL_CFG) === null && (() => { try { externalGate.assertExternalDbAllowed('mysql', NORMAL_CFG); return true; } catch (_) { return false; } })(),
            '正常模式：dingtalkFetchOverride() 为 null、assertExternalDbAllowed() 无副作用返回');
        externalGate._setConfigProviderForTest(null);

        // ======================= 2b. 闸门判定矩阵（T2）=======================
        section('2b 闸门判定的表驱动矩阵：只有正常配置放行（外部库入口 + 钉钉入口逐行断言，绊线命中 0）');
        {
            const mxDir = path.join(TMP, 'matrix-data');
            fs.mkdirSync(mxDir, { recursive: true });
            const mxLog = path.join(mxDir, 'external-calls.jsonl');
            const rows = [
                { name: 'null', cfg: null, dbAllow: false, dt: 'blocked' },
                { name: '{}', cfg: {}, dbAllow: false, dt: 'blocked' },
                { name: '缺 external（隔离形态、有数据根）', cfg: { mode: 'isolated', dataRoot: mxDir }, dbAllow: false, dt: 'blocked' },
                { name: "external='REAL'（未知值，大小写不同）", cfg: { mode: 'isolated', external: 'REAL', dataRoot: mxDir }, dbAllow: false, dt: 'blocked' },
                { name: "external='on'（未知值）", cfg: { mode: 'isolated', external: 'on', dataRoot: mxDir }, dbAllow: false, dt: 'blocked' },
                { name: "refuse:true + external:'real'", cfg: { refuse: true, code: 'X', external: 'real' }, dbAllow: false, dt: 'blocked' },
                { name: "external='stub' + 数据根", cfg: { mode: 'isolated', external: 'stub', dataRoot: mxDir }, dbAllow: false, dt: 'stub' },
                { name: "external='stub' 缺数据根", cfg: { mode: 'isolated', external: 'stub' }, dbAllow: false, dt: 'blocked' },
                { name: '正常配置（resolveInstanceConfig 生成）', cfg: NORMAL_CFG, dbAllow: true, dt: 'real' },
            ];
            const lines = () => (fs.existsSync(mxLog) ? fs.readFileSync(mxLog, 'utf8').split('\n').filter(Boolean).length : 0);
            const allowedDb = [];
            const reachedReal = [];
            for (const row of rows) {
                let dbErr = null;
                try { externalGate.assertExternalDbAllowed('mysql', row.cfg); } catch (e) { dbErr = e; }
                if (!dbErr) allowedDb.push(row.name);
                must(row.dbAllow ? dbErr === null : (dbErr && dbErr.code === 'EXTERNAL_DISABLED'), `[${row.name}] 外部库入口：${row.dbAllow ? '放行' : '抛 EXTERNAL_DISABLED'}`, jstr(dbErr && { c: dbErr.code, m: dbErr.message }));

                externalGate._setConfigProviderForTest(() => row.cfg);
                dingtalk._resetCacheForTest();
                armFetchTrip();
                const linesBefore = lines();
                let realProbeCalls = 0;
                if (row.dt === 'real') {
                    global.fetch = async () => { realProbeCalls += 1; return new Response(JSON.stringify({ errcode: 0, access_token: 'T-matrix', expires_in: 7200 }), { status: 200 }); };
                }
                let tok = null;
                let dtErr = null;
                try { tok = await dingtalk.getAccessToken('k', 's'); } catch (e) { dtErr = e; } finally { restoreFetch(); }
                if (realProbeCalls > 0) reachedReal.push(row.name);
                if (row.dt === 'blocked') {
                    must(dtErr && dtErr.code === 'EXTERNAL_DISABLED' && lines() === linesBefore && tripCallsSince().length === 0, `[${row.name}] 钉钉入口：拒绝（EXTERNAL_DISABLED），不写替身日志，绊线 0`, jstr({ dtErr: dtErr && dtErr.message, trips: tripCallsSince(), lines: [linesBefore, lines()] }));
                } else if (row.dt === 'stub') {
                    must(!dtErr && typeof tok === 'string' && tok.length > 0 && lines() === linesBefore + 1 && tripCallsSince().length === 0, `[${row.name}] 钉钉入口：走替身（写一行日志），绊线 0`, jstr({ dtErr: dtErr && dtErr.message, tok, lines: [linesBefore, lines()], trips: tripCallsSince() }));
                } else {
                    must(!dtErr && tok === 'T-matrix' && realProbeCalls === 1 && lines() === linesBefore && tripCallsSince().length === 0, `[${row.name}] 钉钉入口：放行到全局 fetch（局部探针收到 1 次），不走替身`, jstr({ dtErr: dtErr && dtErr.message, tok, realProbeCalls, lines: [linesBefore, lines()] }));
                }
            }
            externalGate._setConfigProviderForTest(null);
            must(jstr(allowedDb) === jstr([rows[rows.length - 1].name]) && jstr(reachedReal) === jstr([rows[rows.length - 1].name]), '汇总：外部库放行与钉钉到达真实 fetch 的行都只有「正常配置」一行', jstr({ allowedDb, reachedReal }));
        }

        // ======================= 3. 外部库 4 个创建点 =======================
        section('3 外部库创建点（server.js 源码里的真实函数文本，放进探针沙箱执行）');
        const mssqlSrc = extractFunction(SERVER_SRC, /async function getMssqlPool\(connConfig\) \{/);
        const mysqlSrc = extractFunction(SERVER_SRC, /async function getMysqlPool\(connConfig\) \{/);
        const testNewSrc = extractCallStatement(SERVER_SRC, "app.post('/api/db-connections/test-new'");
        function makeSandbox(cfg) {
            const probes = { mssqlCtor: 0, mssqlConnect: 0, mysqlPool: 0, mysqlConn: 0, mysqlCreateConnection: 0, failMysqlWith: null, mssqlArgs: [], mysqlPoolArgs: [], mysqlConnArgs: [] };
            class ConnectionPool {
                constructor(config) { probes.mssqlCtor++; probes.mssqlArgs.push(config); this.config = config; this.connected = false; }
                async connect() { probes.mssqlConnect++; this.connected = true; }
                request() { return { query: async () => ({ recordset: [{ test: 1 }] }) }; }
                async close() { this.connected = false; }
            }
            const gate = {
                assertExternalDbAllowed: (kind) => externalGate.assertExternalDbAllowed(kind, cfg),
            };
            const logs = [];
            const sandbox = {
                externalGate: gate,
                sql: { ConnectionPool, NVarChar: 'nvarchar' },
                mysql: {
                    createPool: (opts) => { probes.mysqlPool++; probes.mysqlPoolArgs.push(opts); return { getConnection: async () => ({ ping: async () => {}, release: () => {} }) }; },
                    createConnection: async (opts) => {
                        probes.mysqlCreateConnection++;
                        probes.mysqlConnArgs.push(opts);
                        if (probes.failMysqlWith) throw probes.failMysqlWith;
                        return { query: async () => [[{ test: 1 }]], end: async () => {} };
                    },
                },
                mssqlPools: new Map(),
                mysqlPools: new Map(),
                logger: { info: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: () => {} },
                authenticateToken: () => {}, requireAdmin: () => {},
                isWritableDbType: (t) => t === 'sqlserver' || t === 'mysql',
                __captured: null,
                app: null,
                console,
            };
            sandbox.app = { post: (...a) => { sandbox.__captured = a[a.length - 1]; } };
            return { sandbox, probes, logs };
        }
        function bind(cfg) {
            const env = makeSandbox(cfg);
            const ctx = vm.createContext(env.sandbox);
            vm.runInContext(`${mssqlSrc}\n${mysqlSrc}\n${testNewSrc}\n`, ctx, { filename: 'server.js(extracted)' });
            return { ...env, getMssqlPool: ctx.getMssqlPool, getMysqlPool: ctx.getMysqlPool, handler: env.sandbox.__captured };
        }
        const cc = { host: 'h', port: 1433, database: 'd', username: 'u', password: 'p' };

        // 正常模式
        {
            const e = bind(NORMAL_CFG);
            const p1 = await e.getMssqlPool(cc);
            must(e.probes.mssqlCtor === 1 && e.probes.mssqlConnect === 1 && p1 && p1.connected, '正常模式 getMssqlPool：构造并连接（走原路径）', jstr(e.probes));
            await e.getMssqlPool(cc);
            must(e.probes.mssqlCtor === 1, '正常模式 getMssqlPool：第二次命中连接池缓存，不重复构造');
            await e.getMysqlPool(cc);
            must(e.probes.mysqlPool === 1, '正常模式 getMysqlPool：创建连接池并探活', jstr(e.probes));
            const resMy = fakeRes();
            await e.handler({ body: { type: 'mysql', host: 'h', database: 'd', username: 'u', password: 'p' } }, resMy);
            must(e.probes.mysqlCreateConnection === 1 && resMy.body && resMy.body.success === true, '正常模式 test-new(mysql)：走 mysql.createConnection 并返回成功', jstr({ probes: e.probes, body: resMy.body }));
            const resMs = fakeRes();
            const ctorBefore = e.probes.mssqlCtor;
            await e.handler({ body: { type: 'sqlserver', host: 'h2', database: 'd', username: 'u', password: 'p' } }, resMs);
            must(e.probes.mssqlCtor === ctorBefore + 1 && resMs.body && resMs.body.success === true, '正常模式 test-new(sqlserver)：走 new sql.ConnectionPool 并返回成功', jstr({ probes: e.probes, body: resMs.body }));
            // 失败响应与改造前逐字相同（不多出 code 字段）
            const e2 = bind(NORMAL_CFG);
            e2.probes.failMysqlWith = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:3306'), { code: 'ECONNREFUSED' });
            const resFail = fakeRes();
            await e2.handler({ body: { type: 'mysql', host: 'h', database: 'd', username: 'u', password: 'p' } }, resFail);
            must(resFail.statusCode === 500 && jstr(resFail.body) === jstr({ success: false, error: '连接失败: connect ECONNREFUSED 10.0.0.1:3306' }),
                '正常模式 test-new 失败响应与改造前逐字相同（状态 500，键只有 success / error）', jstr({ s: resFail.statusCode, b: resFail.body }));

            // ---- T3：连接参数映射与缓存（期望值全部手写，取自改造前 server.js 里的映射方式，不从被测变量取；各字段取值互不相同，串位会被发现）----
            const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x));
            const pc = { host: 'db-a.example', port: 14330, database: 'dw_a', username: 'user_a', password: 'pw_a' };
            const e3 = bind(NORMAL_CFG);
            await e3.getMssqlPool(pc);
            must(e3.probes.mssqlArgs.length === 1 && canon(e3.probes.mssqlArgs[0]) === canon({
                user: 'user_a', password: 'pw_a', server: 'db-a.example', port: 14330, database: 'dw_a',
                options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true, requestTimeout: 60000 },
                pool: { max: 10, min: 2, idleTimeoutMillis: 60000 },
            }), '正常模式 getMssqlPool：传给 ConnectionPool 的配置逐字段与改造前映射一致（user / password / server / port / database / options / pool）', canon(e3.probes.mssqlArgs[0]));
            await e3.getMssqlPool(pc);
            await e3.getMssqlPool({ ...pc });
            must(e3.probes.mssqlCtor === 1, '同一配置再取（含按值相同的新对象）命中缓存，构造次数不增', jstr(e3.probes.mssqlCtor));
            await e3.getMssqlPool({ ...pc, database: 'dw_b' });
            await e3.getMssqlPool({ ...pc, port: 14331 });
            await e3.getMssqlPool({ ...pc, host: 'db-b.example' });
            must(e3.probes.mssqlCtor === 4 && e3.probes.mssqlArgs[1].database === 'dw_b' && e3.probes.mssqlArgs[2].port === 14331 && e3.probes.mssqlArgs[3].server === 'db-b.example',
                '库名 / 端口 / 主机任一不同都不复用缓存，各自按自己的配置构造（mssql）', jstr(e3.probes.mssqlArgs.map((a) => [a.server, a.port, a.database])));
            await e3.getMysqlPool(pc);
            must(e3.probes.mysqlPoolArgs.length === 1 && canon(e3.probes.mysqlPoolArgs[0]) === canon({
                host: 'db-a.example', port: 14330, database: 'dw_a', user: 'user_a', password: 'pw_a', connectionLimit: 10, connectTimeout: 10000, charset: 'utf8mb4',
            }), '正常模式 getMysqlPool：传给 createPool 的参数逐字段与改造前映射一致（host / port / database / user / password / 池参数 / charset）', canon(e3.probes.mysqlPoolArgs[0]));
            await e3.getMysqlPool({ ...pc });
            must(e3.probes.mysqlPool === 1, '同一配置再取命中缓存，createPool 次数不增（mysql）', jstr(e3.probes.mysqlPool));
            await e3.getMysqlPool({ ...pc, database: 'dw_b' });
            await e3.getMysqlPool({ ...pc, port: 14331 });
            await e3.getMysqlPool({ ...pc, host: 'db-b.example' });
            must(e3.probes.mysqlPool === 4 && e3.probes.mysqlPoolArgs[1].database === 'dw_b' && e3.probes.mysqlPoolArgs[2].port === 14331 && e3.probes.mysqlPoolArgs[3].host === 'db-b.example',
                '库名 / 端口 / 主机任一不同都不复用缓存（mysql）', jstr(e3.probes.mysqlPoolArgs.map((a) => [a.host, a.port, a.database])));
            // test-new 两种库的一次性连接参数（含端口缺省值 3306 / 1433）
            const tnBody = { host: 'h-t', port: 3307, database: 'd-t', username: 'u-t', password: 'p-t' };
            const e4 = bind(NORMAL_CFG);
            await e4.handler({ body: { type: 'mysql', ...tnBody } }, fakeRes());
            await e4.handler({ body: { type: 'mysql', host: 'h-t', database: 'd-t', username: 'u-t', password: 'p-t' } }, fakeRes());
            must(e4.probes.mysqlConnArgs.length === 2 && canon(e4.probes.mysqlConnArgs[0]) === canon({ host: 'h-t', port: 3307, database: 'd-t', user: 'u-t', password: 'p-t', connectTimeout: 10000, charset: 'utf8mb4' })
                && e4.probes.mysqlConnArgs[1].port === 3306,
                '正常模式 test-new(mysql)：createConnection 参数逐字段一致，缺省端口 3306', jstr(e4.probes.mysqlConnArgs));
            await e4.handler({ body: { type: 'sqlserver', ...tnBody } }, fakeRes());
            await e4.handler({ body: { type: 'sqlserver', host: 'h-t', database: 'd-t', username: 'u-t', password: 'p-t' } }, fakeRes());
            must(e4.probes.mssqlArgs.length === 2 && canon(e4.probes.mssqlArgs[0]) === canon({
                user: 'u-t', password: 'p-t', server: 'h-t', port: 3307, database: 'd-t',
                options: { encrypt: false, trustServerCertificate: true, enableArithAbort: true, requestTimeout: 10000 },
            }) && e4.probes.mssqlArgs[1].port === 1433,
                '正常模式 test-new(sqlserver)：ConnectionPool 配置逐字段一致，缺省端口 1433', jstr(e4.probes.mssqlArgs));
        }
        // ---- T4：静态契约——server.js 顶部的驱动导入存在，且绑定名与抽取函数里使用的名字一致（沙箱里提供的名字就是 sql / mysql）----
        {
            must(/^const sql = require\('mssql'\);$/m.test(SERVER_SRC), "server.js：`const sql = require('mssql');` 存在（沙箱里的 sql 对应它）");
            must(/^const mysql = require\('mysql2\/promise'\);$/m.test(SERVER_SRC), "server.js：`const mysql = require('mysql2/promise');` 存在（沙箱里的 mysql 对应它）");
            must(/\bnew sql\.ConnectionPool\(/.test(mssqlSrc) && /\bmysql\.createPool\(/.test(mysqlSrc) && /\bmysql\.createConnection\(/.test(testNewSrc) && /\bnew sql\.ConnectionPool\(/.test(testNewSrc),
                '抽取的函数文本里用的就是 sql.ConnectionPool / mysql.createPool / mysql.createConnection（绑定名与上面两条导入一致）');
            must(/\bexternalGate\.assertExternalDbAllowed\(/.test(mssqlSrc) && /^const externalGate = require\('\.\/utils\/external-gate'\);/m.test(SERVER_SRC),
                "server.js：`externalGate` 由 require('./utils/external-gate') 绑定，抽取函数里调用的就是它");
        }
        // 隔离 / 拒绝
        for (const [label, cfg] of [['隔离模式', isolatedCfg(path.join(TMP, 'iso-data'))], ['判定被拒绝', REFUSED_CFG]]) {
            const e = bind(cfg);
            const errOf = async (fn) => { try { await fn(); return null; } catch (x) { return x; } };
            const x1 = await errOf(() => e.getMssqlPool(cc));
            must(x1 && x1.code === 'EXTERNAL_DISABLED' && /EXTERNAL_DISABLED/.test(x1.message) && e.probes.mssqlCtor === 0, `${label} getMssqlPool：抛 EXTERNAL_DISABLED，连接构造探针 0 次`, jstr({ m: x1 && x1.message, p: e.probes }));
            const x2 = await errOf(() => e.getMysqlPool(cc));
            must(x2 && x2.code === 'EXTERNAL_DISABLED' && e.probes.mysqlPool === 0, `${label} getMysqlPool：抛 EXTERNAL_DISABLED，createPool 探针 0 次`, jstr({ m: x2 && x2.message, p: e.probes }));
            const rMy = fakeRes();
            await e.handler({ body: { type: 'mysql', host: 'h', database: 'd', username: 'u', password: 'p' } }, rMy);
            must(rMy.statusCode === 500 && rMy.body && rMy.body.success === false && rMy.body.code === 'EXTERNAL_DISABLED' && /EXTERNAL_DISABLED/.test(rMy.body.error) && e.probes.mysqlCreateConnection === 0,
                `${label} test-new(mysql)：失败响应含 EXTERNAL_DISABLED，createConnection 探针 0 次`, jstr({ r: rMy.body, p: e.probes }));
            const rMs = fakeRes();
            await e.handler({ body: { type: 'sqlserver', host: 'h', database: 'd', username: 'u', password: 'p' } }, rMs);
            must(rMs.statusCode === 500 && rMs.body && rMs.body.success === false && rMs.body.code === 'EXTERNAL_DISABLED' && /EXTERNAL_DISABLED/.test(rMs.body.error) && e.probes.mssqlCtor === 0,
                `${label} test-new(sqlserver)：失败响应含 EXTERNAL_DISABLED，ConnectionPool 探针 0 次`, jstr({ r: rMs.body, p: e.probes }));
        }
        // 缓存不绕过闸：正常模式建好池以后，同一个 sandbox 切到隔离配置，缓存命中也必须被拦（闸在缓存查找之前）
        {
            let live = NORMAL_CFG;
            const env = makeSandbox(NORMAL_CFG);
            env.sandbox.externalGate = { assertExternalDbAllowed: (k) => externalGate.assertExternalDbAllowed(k, live) };
            const ctx = vm.createContext(env.sandbox);
            vm.runInContext(mssqlSrc, ctx);
            await ctx.getMssqlPool(cc);
            live = isolatedCfg(path.join(TMP, 'iso-data'));
            let x = null;
            try { await ctx.getMssqlPool(cc); } catch (e) { x = e; }
            must(x && x.code === 'EXTERNAL_DISABLED', '闸在连接池缓存查找之前：缓存里有池也不能绕过隔离判定');
        }

        // ======================= 4. 文档发布 =======================
        section('4 POST /api/docs/publish：隔离模式在任何文件操作之前返回 409');
        {
            const pubSrc = extractCallStatement(SERVER_SRC, "app.post('/api/docs/publish'");
            const run = async (instanceConfig, body) => {
                const fsCalls = [];
                const fakeFs = new Proxy({}, { get: (_, k) => (...a) => { fsCalls.push(String(k)); return false; } });
                const sb = {
                    authenticateToken: () => {}, requirePublisherOrAdmin: () => {}, INSTANCE_CONFIG: instanceConfig,
                    fs: fakeFs, path, __dirname: ROOT, logger: { info() {}, warn() {}, error() {} }, __h: null, console,
                    dbRunAsync: async () => { fsCalls.push('dbRunAsync'); return {}; }, extractVersionInfo: () => ({ baseName: 'b', version: '1' }),
                };
                sb.app = { post: (...a) => { sb.__h = a[a.length - 1]; } };
                vm.runInContext(pubSrc, vm.createContext(sb));
                const res = fakeRes();
                await sb.__h({ body }, res);
                return { res, fsCalls };
            };
            const body = { old_filename: 'docs/x-old.md', new_filename: 'docs/x-new.md' };
            const iso = await run({ mode: 'isolated' }, body);
            must(iso.res.statusCode === 409 && iso.res.body && iso.res.body.code === 'ISOLATED_DOCS_READONLY' && iso.fsCalls.length === 0, '隔离模式：409 ISOLATED_DOCS_READONLY，fs / 库调用 0 次', jstr(iso));
            const iso2 = await run({ mode: 'isolated' }, {});
            must(iso2.res.statusCode === 409 && iso2.fsCalls.length === 0, '隔离模式：连缺参数的请求也先返回 409（拒绝在参数校验之前）', jstr(iso2));
            const norm = await run({ mode: 'normal' }, body);
            must(norm.res.statusCode === 404 && /新版本文件不存在/.test(norm.res.body && norm.res.body.error) && norm.fsCalls.includes('existsSync'), '正常模式：仍走原逻辑（探针 fs 返回不存在 → 404 新版本文件不存在）', jstr(norm));
        }

        // ======================= 5. 设备巡检采集器 =======================
        section('5 设备巡检采集器：隔离模式不读配置文件、不启动 PowerShell');
        {
            const cfgPath = path.join(TMP, 'servers.env');
            fs.writeFileSync(cfgPath, 'IP地址: 10.20.30.40\n');
            const collectorPath = path.join(ROOT, 'routes/it-ledger/inspection-collector.js');
            const collectPath = path.join(ROOT, 'routes/it-ledger/inspection-collect.js');
            const origExec = childProcess.execFile;
            const origRead = fs.readFileSync;
            const execCalls = [];
            const reads = [];
            const norm = (p) => path.resolve(String(p)).toLowerCase();
            childProcess.execFile = function (file, args) { execCalls.push({ file, args }); throw new Error('execFile 不应真的执行'); };
            fs.readFileSync = function (p, ...rest) { if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) { try { reads.push(norm(typeof p === 'string' ? p : String(p))); } catch (_) { /* ignore */ } } return origRead.call(this, p, ...rest); };
            const readsOfCfg = () => reads.filter((r) => r === norm(cfgPath)).length;
            try {
                delete require.cache[require.resolve(collectorPath)];
                delete require.cache[require.resolve(collectPath)];
                const { createCollector } = require(collectorPath);
                const createInspectionCollect = require(collectPath);
                const asset = { id: 1, name: 's1', sn: 'SN-1', category: 'server', status: 'in_service', attrs: JSON.stringify({ ip: '10.20.30.40' }) };
                const q = { get: async () => asset };
                const rm = { assertActive: async () => {} };
                // 正常（未禁用）：读配置、拼出 PowerShell 调用
                const collNormal = createCollector(cfgPath, {});
                const hostN = collNormal.host();
                must(hostN === '10.20.30.40' && readsOfCfg() === 1, '未禁用：host() 读配置文件并解析出 IP（对照：证明读文件的探针有效）', jstr({ hostN, reads: readsOfCfg() }));
                const colN = createInspectionCollect({ collector: collNormal, recordManagement: rm });
                const tN = await colN.target(q, 1);
                must(tN.host === '10.20.30.40', '未禁用：target() 通过资格判定', jstr(tN));
                const snapN = await colN.collectSnapshot({ host: '10.20.30.40', sn: 'SN-1' });
                must(execCalls.length === 1 && execCalls[0].file === 'powershell.exe' && execCalls[0].args.includes(cfgPath) && snapN.collection_status === 'failed',
                    '未禁用：collect() 走 execFile(powershell.exe … -ConfigPath <配置>)（探针拦下后按失败快照收口）', jstr({ exec: execCalls.length, snap: snapN.collection_status }));
                // 禁用
                const readsBefore = readsOfCfg();
                const execBefore = execCalls.length;
                const collOff = createCollector(cfgPath, { externalDisabled: true });
                must(collOff.host() === null, '禁用：host() 返回 null');
                const colOff = createInspectionCollect({ collector: collOff, recordManagement: rm });
                let tErr = null;
                try { await colOff.target(q, 1); } catch (e) { tErr = e; }
                must(tErr && tErr.status === 400 && tErr.code === 'LEDGER_BAD_REQUEST', '禁用：target() 以「未配置可用的采集连接」拒绝（400）', jstr(tErr && { s: tErr.status, c: tErr.code, m: tErr.message }));
                let cErr = null;
                try { await collOff.collect(); } catch (e) { cErr = e; }
                must(cErr && cErr.code === 'EXTERNAL_DISABLED', '禁用：collect() 直接调用以 EXTERNAL_DISABLED 拒绝', jstr(cErr && cErr.message));
                const snapOff = await colOff.collectSnapshot({ host: '10.20.30.40', sn: 'SN-1' });
                must(snapOff.collection_status === 'failed' && snapOff.server === null, '禁用：collectSnapshot() 得到 failed 快照，不会被当成成功', jstr(snapOff.collection_status));
                must(readsOfCfg() === readsBefore, '禁用：全程没有读取巡检配置文件', `读取次数 ${readsBefore} -> ${readsOfCfg()}`);
                must(execCalls.length === execBefore, '禁用：全程没有启动 PowerShell', `execFile 次数 ${execBefore} -> ${execCalls.length}`);
                // 默认配置路径也不读：不传 configPath
                const collDef = createCollector(undefined, { externalDisabled: true });
                const defaultCfgRe = /servers\.env$/i;
                const before = reads.filter((r) => defaultCfgRe.test(r)).length;
                collDef.host();
                try { await collDef.collect(); } catch (_) { /* EXTERNAL_DISABLED */ }
                must(reads.filter((r) => defaultCfgRe.test(r)).length === before, '禁用：默认配置路径（docs/local/servers.env）同样不读');
            } finally {
                childProcess.execFile = origExec;
                fs.readFileSync = origRead;
                delete require.cache[require.resolve(collectorPath)];
                delete require.cache[require.resolve(collectPath)];
            }
            const idx = fs.readFileSync(path.join(ROOT, 'routes/it-ledger/index.js'), 'utf8');
            must(/createCollector\(deps\.inspectionConfigPath, \{ externalDisabled: deps\.inspectionExternalDisabled === true \}\)/.test(idx), 'it-ledger/index.js：采集器创建处把 deps.inspectionExternalDisabled 传给 createCollector');
            const isoSpread = /INSTANCE_CONFIG\.mode === 'isolated' \? \{[\s\S]{0,600}?inspectionExternalDisabled: true,[\s\S]{0,40}?\} : \{\}/.exec(SERVER_SRC);
            must(!!isoSpread, 'server.js：隔离模式的 it-ledger 注入里带 inspectionExternalDisabled: true（正常模式展开空对象）');
        }

        // ======================= 6. createIsolatedDb =======================
        section('6 createIsolatedDb：VACUUM INTO 建目标 + 身份 + 虚拟钉钉凭证 + 清口令，同一事务');
        {
            const sqlite3 = require('sqlite3');
            const dbp = (n) => path.join(TMP, n);
            const exec = (file, sqlText) => new Promise((res, rej) => { const d = new sqlite3.Database(file, (e) => { if (e) return rej(e); d.exec(sqlText, (er) => d.close(() => (er ? rej(er) : res()))); }); });
            const rows = (file, sqlText, params) => new Promise((res, rej) => { const d = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (e) => { if (e) return rej(e); d.all(sqlText, params || [], (er, r) => d.close(() => (er ? rej(er) : res(r)))); }); });
            const REAL_KEY = 'real-production-key-0123456789abcdef-xyz';
            const realCipher = aes.encryptWithKey(REAL_KEY, 'Pr0dPassw0rd!');

            // 一个简单的来源库：多数防呆 / 结构用例只需要“来源存在且是普通文件”
            const srcDb = dbp('prep-source.db');
            await exec(srcDb, 'CREATE TABLE t (a INTEGER);');
            /** createIsolatedDb 的简写：来源默认 srcDb，目标必须是尚不存在的新路径 */
            const mk = (target, extra) => instanceDb.createIsolatedDb(Object.assign({ sourceDbPath: srcDb, targetDbPath: target, instanceId: 'test-prep-x', parent: 'main', sourceEncryptionKey: null }, extra || {}));   // S2-0 修复批 1：非隔离来源必须显式传来源键；这些结构 / 防呆用例不关心配置，明确传 null
            const sideFiles = (f) => ['', '-journal', '-wal', '-shm'].map((s) => f + s).filter((p) => fs.existsSync(p));
            /** 目录里残留的 createIsolatedDb 临时目录（.sdh-create-*） */
            const createLeft = (d) => fs.readdirSync(d).filter((n) => n.startsWith('.sdh-create-'));

            // 6a 一个像业务库的来源库：两张表都在，有真实口令密文与真实钉钉凭证密文；目标由 createIsolatedDb 用 VACUUM INTO 新建
            const src1 = dbp('prep-full-src.db');
            const f1 = dbp('prep-full.db');
            await exec(src1, `
                CREATE TABLE system_configs (config_key TEXT PRIMARY KEY, config_value_encrypted TEXT, updated_by INTEGER, updated_by_name TEXT, updated_at DATETIME DEFAULT (datetime('now','localtime')));
                INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name) VALUES ('dingtalk_app_secret', '${realCipher}', 7, 'real-admin');
                INSERT INTO system_configs (config_key, config_value_encrypted) VALUES ('collab_notify_admin_on_submit', 'keepme');
                CREATE TABLE db_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT, host TEXT NOT NULL, port INTEGER, database TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL);
            `);
            await seedDbConnections(src1, realCipher);
            const src1Fp = fileFp(src1);
            must(!fs.existsSync(f1), '前提：目标原先不存在');
            const r1 = await instanceDb.createIsolatedDb({ sourceDbPath: src1, targetDbPath: f1, instanceId: 'test-prep-a', parent: 'main', from: 'unit', sourceEncryptionKey: null });
            must(r1.dbConnectionsCleared === 3 && r1.configKeys.length === 4, '返回清空的口令行数 3 与四个配置键', jstr(r1));
            must(jstr(fileFp(src1)) === jstr(src1Fp) && fileFp(f1) !== null, '来源库 sha256 / 大小前后不变，目标已创建', jstr({ before: src1Fp, after: fileFp(src1) }));
            must(sideFiles(f1).join('|') === f1, '成功后目标旁没有 -journal / -wal / -shm 残留', jstr(sideFiles(f1)));
            must(sideFiles(src1).join('|') === src1, '回滚日志模式的来源：执行后来源旁没有 -journal / -wal / -shm', jstr(sideFiles(src1)));
            const srcStillReal =(await rows(src1, 'SELECT count(*) AS n FROM db_connections WHERE password <> \'\'' ))[0].n;
            must(srcStillReal === 2, '对照：来源库里的真实口令密文原样还在（只改了副本）', jstr(srcStillReal));
            const id1 = await instanceDb.checkInstanceIdentity(f1, { expectedInstance: 'test-prep-a', expectedParent: 'main' });
            must(id1.ok, '库内身份核对通过', jstr(id1));
            const cfgRows = await rows(f1, 'SELECT config_key, config_value_encrypted, updated_by, updated_by_name FROM system_configs ORDER BY config_key');
            const byKey = Object.fromEntries(cfgRows.map((r) => [r.config_key, r]));
            for (const k of Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG)) {
                let dec = null;
                try { dec = aes.decryptWithKey(aes.ISOLATED_ENCRYPTION_KEY, byKey[k].config_value_encrypted); } catch (e) { dec = 'ERR:' + e.message; }
                must(dec === instanceDb.VIRTUAL_DINGTALK_CONFIG[k], `${k}：用隔离键解出虚拟值`, jstr({ dec }));
            }
            must(byKey.dingtalk_app_secret.updated_by === null && byKey.dingtalk_app_secret.updated_by_name === 'sdh-isolated', '真实凭证被覆盖（updated_by / 名称不再是真实管理员）');
            // S2-0 起白名单键在没传来源键时被删除（'keepme' 不是合法密文，也不再“原样保留”）；完整的白名单重写用例见第 7 段
            must(!byKey.collab_notify_admin_on_submit && cfgRows.length === 4 && jstr(r1.configDropped) === jstr([{ key: 'collab_notify_admin_on_submit', reason: 'no_source_key' }]) && jstr(r1.configRewritten) === jstr([]),
                '显式 null（sourceEncryptionKey: null，不解密）：白名单键 collab_notify_admin_on_submit 被删除（reason = no_source_key），共 4 行（只剩 4 项虚拟配置）', jstr({ keys: cfgRows.map((r) => r.config_key), dropped: r1.configDropped, rewritten: r1.configRewritten }));
            // 虚拟值是密文：库里不含明文
            const rawDb = fs.readFileSync(f1).toString('latin1');
            must(!rawDb.includes(instanceDb.VIRTUAL_DINGTALK_CONFIG.dingtalk_app_secret) && !rawDb.includes(realCipher), '库文件里既没有虚拟 appsecret 明文，也没有真实口令密文（口令列被清空且未残留）');
            const conns = await rows(f1, 'SELECT id, password FROM db_connections ORDER BY id');
            must(conns.length === 3 && conns.every((c) => c.password === ''), 'db_connections 口令列全部清空为空串，行数不变', jstr(conns));
            let decEmpty = null;
            try { aes.decryptWithKey(aes.ISOLATED_ENCRYPTION_KEY, ''); decEmpty = 'NO-THROW'; } catch (_) { decEmpty = 'THROWS'; }
            must(decEmpty === 'THROWS', '空串口令解密必抛错（不依赖「换键解密失败」的概率）');
            const wrong = (() => { try { return aes.decryptWithKey(aes.ISOLATED_ENCRYPTION_KEY, realCipher) === 'Pr0dPassw0rd!'; } catch (_) { return false; } })();
            must(wrong === false, '对照：真实密文用隔离键解不出原文');

            // 6b 从一个已经隔离过的库再派生 = 替换身份，不追加（线库派生测试库的真实用法）
            const f1b = dbp('prep-full-b.db');
            const r2 = await instanceDb.createIsolatedDb({ sourceDbPath: f1, targetDbPath: f1b, instanceId: 'test-prep-b', parent: 'line-x', from: 'unit2' });
            const idRows = await rows(f1b, 'SELECT instance_id, source FROM _sdh_instance');
            const cnt = await rows(f1b, 'SELECT count(*) AS n FROM system_configs');
            must(idRows.length === 1 && idRows[0].instance_id === 'test-prep-b' && JSON.parse(idRows[0].source).parent === 'line-x' && cnt[0].n === 4 && r2.dbConnectionsCleared === 3, '从隔离库再派生：身份行被替换（仍恰好一行），配置行不重复（4 项虚拟配置）', jstr({ idRows, cnt }));

            // 6c 空库：两张业务表都没有 -> 建出 system_configs，跳过清口令
            const f2 = dbp('prep-empty.db');
            const r3 = await mk(f2, { instanceId: 'test-prep-c' });
            const tbls = (await rows(f2, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => t.name);
            const c2 = await rows(f2, 'SELECT count(*) AS n FROM system_configs');
            must(r3.dbConnectionsCleared === 0 && tbls.join(',') === '_sdh_instance,system_configs,t' && c2[0].n === 4, '来源里没有 system_configs / db_connections：先建 system_configs 再写入四项，跳过清口令', jstr({ r3, tbls }));

            // 6d 中途失败（隔离化那一步）：整体回滚，且本函数创建的目标及其伴随文件全部清掉
            const src3 = dbp('prep-rollback-src.db');
            await exec(src3, 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT);');   // 没有 password 列：UPDATE db_connections SET password 在预编译阶段就失败（不需要行）
            const f3 = dbp('prep-rollback.db');
            const rbErr = await errOf(() => mk(f3, { sourceDbPath: src3, instanceId: 'test-prep-d' }));
            must(rbErr && /password/.test(rbErr.message) && sideFiles(f3).length === 0, '中途失败（db_connections 无 password 列）：抛原错误，目标及 -journal / -wal / -shm 都不存在', jstr({ err: rbErr && rbErr.message, left: sideFiles(f3) }));
            const src3b = dbp('prep-rollback-src-b.db');
            await exec(src3b, 'CREATE TABLE _sdh_instance (x TEXT);');   // 与身份表同名但结构不兼容：隔离化第一步的 INSERT 失败
            const f3b = dbp('prep-rollback-b.db');
            const rbErr2 = await errOf(() => mk(f3b, { sourceDbPath: src3b, instanceId: 'test-prep-d2' }));
            must(rbErr2 && rbErr2.code !== 'TARGET_EXISTS' && sideFiles(f3b).length === 0, '中途失败（同名但结构不兼容的 _sdh_instance）：抛错，目标及伴随文件都不存在', jstr({ err: rbErr2 && rbErr2.message, left: sideFiles(f3b) }));
            must(createLeft(TMP).length === 0, '两种中途失败之后：目标目录里没有残留的 .sdh-create-* 临时目录', jstr(createLeft(TMP)));
            must(sideFiles(f1).join('|') === f1 && createLeft(TMP).length === 0, '成功路径（6a 的目标）：目标存在、旁边没有伴随文件，目录里没有 .sdh-create-* 残留', jstr({ side: sideFiles(f1), left: createLeft(TMP) }));
            must(fs.lstatSync(f1).nlink === 1, '成功路径：目标 nlink === 1（临时文件已删）', jstr(fs.lstatSync(f1).nlink));

            // 6d-2（07-R2 H1）清理归属：来源库就叫「<目标>-shm」，且内容会让隔离化失败——必须在检查伴随路径那一步就被 TARGET_EXISTS 拒绝，来源不能被删
            {
                const victimTarget = dbp('shm-victim.db');
                const victimSrc = victimTarget + '-shm';
                await exec(victimSrc, 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT);');
                const vFp = fileFp(victimSrc);
                const eV = await errOf(() => mk(victimTarget, { sourceDbPath: victimSrc }));
                must(eV && eV.code === 'TARGET_EXISTS' && /-shm/.test(eV.message) && fs.existsSync(victimSrc) && jstr(fileFp(victimSrc)) === jstr(vFp) && !fs.existsSync(victimTarget) && createLeft(TMP).length === 0,
                    '来源叫「<目标>-shm」：被 TARGET_EXISTS 拒绝（消息点名伴随路径），来源仍存在且 sha256 / 大小不变，目标未创建，无临时目录残留', jstr({ code: eV && eV.code, msg: eV && eV.message, exists: fs.existsSync(victimSrc) }));
                // 目标旁已有的 -journal / -wal：同样拒绝，那份文件内容不变
                // 6d-3 竞态注入（确定性）：临时替换 fs.lstatSync，让“别的调用”恰好在 createIsolatedDb 自己的检查之后创建出路径。
                //   按目标 `-shm` 路径的第 n 次 lstat 触发：第 1 次 lstat 属于“进入时检查”，第 2 次属于“发布前复查”（检查顺序固定为 目标、-journal、-wal、-shm，-shm 是最后一个）。
                const withLstatHook = async (shmCallNo, action, fn) => {
                    const orig = fs.lstatSync;
                    let n = 0;
                    fs.lstatSync = function hookedLstat(p, ...rest) {
                        if (String(p) === raceTarget + '-shm') {
                            n += 1;
                            if (n === shmCallNo) { try { return orig.call(this, p, ...rest); } finally { action(); } }
                        }
                        return orig.call(this, p, ...rest);
                    };
                    try { return await fn(); } finally { fs.lstatSync = orig; }
                };
                // 发布前复查之后（第 2 次 -shm lstat 之后）目标被并发创建：link 不能覆盖它，且它的内容不变，临时目录被清掉
                let raceTarget = dbp('race-target.db');
                const eRace = await withLstatHook(2, () => fs.writeFileSync(raceTarget, 'RACER-CONTENT'), () => errOf(() => mk(raceTarget)));
                must(eRace && eRace.code === 'TARGET_EXISTS' && fs.readFileSync(raceTarget, 'utf8') === 'RACER-CONTENT' && createLeft(TMP).length === 0,
                    '发布前目标被并发创建：link 失败（TARGET_EXISTS），不覆盖对方的文件，临时目录已清', jstr({ code: eRace && eRace.code, msg: eRace && eRace.message, content: fs.existsSync(raceTarget) && fs.readFileSync(raceTarget, 'utf8') }));
                // 进入检查之后、发布前复查之前出现陈旧 -journal：复查拦住，不发布，那份 journal 内容不变
                raceTarget = dbp('race-journal.db');
                const eRaceJ = await withLstatHook(1, () => fs.writeFileSync(raceTarget + '-journal', 'STALE-JOURNAL'), () => errOf(() => mk(raceTarget)));
                must(eRaceJ && eRaceJ.code === 'TARGET_EXISTS' && /-journal/.test(eRaceJ.message) && fs.readFileSync(raceTarget + '-journal', 'utf8') === 'STALE-JOURNAL' && !fs.existsSync(raceTarget) && createLeft(TMP).length === 0,
                    '进入检查之后出现陈旧 -journal：发布前复查拦住（TARGET_EXISTS），目标未创建，那份 journal 不被删除，临时目录已清', jstr({ code: eRaceJ && eRaceJ.code, msg: eRaceJ && eRaceJ.message, exists: fs.existsSync(raceTarget) }));
                for (const suffix of ['-journal', '-wal']) {
                    const t = dbp(`pre${suffix}.db`);
                    const side = t + suffix;
                    fs.writeFileSync(side, `PRE-EXISTING${suffix}`);
                    const sFp = fileFp(side);
                    const eS = await errOf(() => mk(t));
                    must(eS && eS.code === 'TARGET_EXISTS' && eS.message.includes(suffix) && jstr(fileFp(side)) === jstr(sFp) && !fs.existsSync(t) && createLeft(TMP).length === 0,
                        `目标旁已有 ${suffix}：TARGET_EXISTS，那份文件内容不变，目标未创建，无临时目录残留`, jstr({ code: eS && eS.code, msg: eS && eS.message }));
                }
            }

            // 6d-4（F9）含中文 + 空格的目录：Node v24.11.1 上 fs.rmSync 对含中文的路径既不报错也不删除，createIsolatedDb 的清理改为逐项 unlink / rmdir 并 lstat 确认。
            //   测试自己清理这个目录时同样不能用 fs.rmSync。
            {
                const delTree = (d) => {
                    for (const n of fs.readdirSync(d)) {
                        const p = path.join(d, n);
                        if (fs.lstatSync(p).isDirectory()) delTree(p); else fs.unlinkSync(p);
                    }
                    fs.rmdirSync(d);
                };
                const cnDir = dbp('中文 目录');
                fs.mkdirSync(cnDir);
                try {
                    const cnOk = path.join(cnDir, 'ok.db');
                    const eCnOk = await errOf(() => mk(cnOk, { instanceId: 'test-cn-ok' }));
                    const stCn = fs.existsSync(cnOk) ? fs.lstatSync(cnOk) : { isFile: () => false, nlink: -1 };
                    must(!eCnOk && stCn.isFile() && stCn.nlink === 1 && createLeft(cnDir).length === 0 && sideFiles(cnOk).join('|') === cnOk,
                        '中文+空格目录·成功路径：目标 nlink === 1，无 .sdh-create-* 残留，无伴随文件', jstr({ err: eCnOk && eCnOk.message, nlink: stCn.nlink, left: createLeft(cnDir), side: sideFiles(cnOk) }));
                    const cnFail = path.join(cnDir, 'fail.db');
                    const eCn = await errOf(() => mk(cnFail, { sourceDbPath: src3, instanceId: 'test-cn-fail' }));
                    must(eCn && /password/.test(eCn.message) && !/残留/.test(eCn.message) && sideFiles(cnFail).length === 0 && createLeft(cnDir).length === 0,
                        '中文+空格目录·中途失败：目标与伴随路径都不存在，无 .sdh-create-* 残留，错误消息里没有“残留”说明', jstr({ msg: eCn && eCn.message, side: sideFiles(cnFail), left: createLeft(cnDir) }));
                } finally {
                    delTree(cnDir);
                }
                must(!fs.existsSync(cnDir), '中文+空格目录已用逐项 unlink / rmdir 清理（测试自身也不用 fs.rmSync）');
            }

            // 6d-5（F13）来源旁有未回滚的 -journal（上次异常退出）：VACUUM INTO 报 SQLITE_READONLY，包装成 SOURCE_HOT_JOURNAL 的可操作提示
            {
                const hjDir = dbp('hotjournal');
                fs.mkdirSync(hjDir);
                const hjSrc = path.join(hjDir, 'src.db');
                await exec(hjSrc, 'CREATE TABLE t (a INTEGER);');
                // 子进程开一个大事务把脏页刷进 -journal 后被强杀（cache_size 很小，事务没提交，journal 留在盘上）
                const childCode = [
                    "const sqlite3 = require(process.argv[2]);",
                    "const db = new sqlite3.Database(process.argv[1]);",
                    "db.serialize(() => {",
                    "  db.run('PRAGMA cache_size = 10');",
                    "  db.run('CREATE TABLE IF NOT EXISTS big (id INTEGER PRIMARY KEY, v TEXT)');",
                    "  db.run('BEGIN IMMEDIATE');",
                    "  db.run('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 30000) INSERT INTO big(v) SELECT hex(randomblob(200)) FROM c', [], (e) => { console.log(e ? 'ERR ' + e.message : 'READY'); });",
                    "});",
                    "setInterval(() => {}, 1000);",
                ].join('\n');
                const child = childProcess.spawn(process.execPath, ['-e', childCode, hjSrc, require.resolve('sqlite3')], { stdio: ['ignore', 'pipe', 'ignore'] });
                const ready = await Promise.race([
                    new Promise((res) => { child.stdout.on('data', (d) => { const t = String(d); if (/READY/.test(t)) res(true); else if (/ERR/.test(t)) res(false); }); child.once('exit', () => res(false)); }),
                    new Promise((res) => setTimeout(() => res(false), 30000)),
                ]);
                const exited = new Promise((res) => { if (child.exitCode !== null) res(); else child.once('exit', () => res()); });
                child.kill();
                await exited;
                const jFile = hjSrc + '-journal';
                const jSizeBefore = fs.existsSync(jFile) ? fs.statSync(jFile).size : null;
                must(ready && jSizeBefore !== null && jSizeBefore > 0, '前提：子进程被强杀后，来源旁留下了未回滚的 -journal', jstr({ ready, jSizeBefore }));
                if (ready && jSizeBefore) {
                    const hjTarget = path.join(hjDir, 'tgt.db');
                    const eHj = await errOf(() => mk(hjTarget, { sourceDbPath: hjSrc }));
                    must(eHj && eHj.code === 'SOURCE_HOT_JOURNAL' && /读写连接打开来源库、执行一次读取/.test(eHj.message) && /SELECT count\(\*\) FROM sqlite_master/.test(eHj.message) && /只开关连接不保证触发热日志恢复/.test(eHj.message) && !/正常打开并关闭一次/.test(eHj.message) && /SQLITE_READONLY/.test(eHj.message),
                        '来源有热日志：抛 code = SOURCE_HOT_JOURNAL，消息要求「读写连接打开 + 执行一次读取（SELECT count(*) FROM sqlite_master）后关闭」并说明只开关连接不保证触发恢复，保留原错误作后缀', jstr(eHj && { c: eHj.code, m: eHj.message }));
                    must(!fs.existsSync(hjTarget) && createLeft(hjDir).length === 0 && fs.existsSync(jFile) && fs.statSync(jFile).size === jSizeBefore,
                        '来源有热日志：目标未创建，无 .sdh-create-* 残留，来源的 -journal 没被动过（大小不变）', jstr({ target: fs.existsSync(hjTarget), left: createLeft(hjDir), jNow: fs.existsSync(jFile) && fs.statSync(jFile).size }));
                }
            }

            // 6d-6（F14）内部函数的“中途失败整体回滚”：对一个含缺 password 列的 db_connections 的库调用 → 抛错后没有 _sdh_instance，system_configs 保持原样
            {
                const rbDb = dbp('internal-rollback.db');
                await exec(rbDb, `
                    CREATE TABLE system_configs (config_key TEXT PRIMARY KEY, config_value_encrypted TEXT, updated_by INTEGER, updated_by_name TEXT, updated_at DATETIME DEFAULT (datetime('now','localtime')));
                    INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name) VALUES ('dingtalk_app_secret', 'ORIGINAL-CIPHER', 7, 'real-admin');
                    CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT);
                `);
                const eRb = await errOf(() => instanceDb._internal.prepareIsolatedDb(rbDb, { instanceId: 'test-prep-rb', parent: 'main', sourceEncryptionKey: null }));
                const rbTables = (await rows(rbDb, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => t.name);
                const rbCfg = await rows(rbDb, 'SELECT config_key, config_value_encrypted, updated_by, updated_by_name FROM system_configs');
                must(eRb && /password/.test(eRb.message) && !rbTables.includes('_sdh_instance') && rbCfg.length === 1 && rbCfg[0].config_key === 'dingtalk_app_secret' && rbCfg[0].config_value_encrypted === 'ORIGINAL-CIPHER' && rbCfg[0].updated_by === 7 && rbCfg[0].updated_by_name === 'real-admin',
                    '内部函数中途失败：整体回滚——没有 _sdh_instance，system_configs 只剩原有一行且原样（四项虚拟配置没有写进去）', jstr({ err: eRb && eRb.message, rbTables, rbCfg }));
            }

            // 6c-2（P2）内部函数对不存在的路径应报错，不悄悄建库（不存在的目标由 createIsolatedDb 的 VACUUM INTO 创建才是预期）
            {
                const ghost = dbp('internal-ghost.db');
                const eGhost = await errOf(() => instanceDb._internal.prepareIsolatedDb(ghost, { instanceId: 'test-prep-ghost', parent: 'main', sourceEncryptionKey: null }));
                must(eGhost && !fs.existsSync(ghost) && sideFiles(ghost).length === 0, '内部准备函数对不存在的路径：报错，且没有建出任何文件（已去掉 OPEN_CREATE）', jstr(eGhost && eGhost.message));
            }

            // 6e 参数与防呆
            let argErr = 0;
            const goodArgs = { sourceDbPath: srcDb, targetDbPath: dbp('never.db'), instanceId: 'x', parent: 'main' };
            const badArgs = [
                { ...goodArgs, instanceId: '' }, { ...goodArgs, parent: '' }, { ...goodArgs, sourceDbPath: '' }, { ...goodArgs, targetDbPath: '' },
                { ...goodArgs, sourceDbPath: undefined }, { ...goodArgs, targetDbPath: undefined }, {},
            ];
            for (const bad1 of badArgs) { try { await instanceDb.createIsolatedDb(bad1); } catch (_) { argErr++; } }
            must(argErr === badArgs.length && !fs.existsSync(dbp('never.db')), '缺 / 空 sourceDbPath、targetDbPath、instanceId、parent：全部拒绝，且没有创建库文件', `拒绝 ${argErr}/${badArgs.length}`);
            must(typeof instanceDb.prepareIsolatedDb === 'undefined', 'prepareIsolatedDb 不再对外导出（只有 createIsolatedDb 是入口）');
            must(typeof instanceDb.assertNotBusinessDb === 'function', '导出 assertNotBusinessDb（防呆函数可单测）');
            if (typeof instanceDb.assertNotBusinessDb === 'function') {
                const hasIdentity = fs.existsSync(path.join(ROOT, '.sdh-instance'));
                // 本检出的 task_pool.db 及同目录的备份文件 / 子目录里的库：无 .sdh-instance 时都拒绝（只调函数，不打开任何文件）
                for (const [label, rel] of [['task_pool.db', 'task_pool.db'], ['同目录备份 task_pool.db.backup_20261016', 'task_pool.db.backup_20261016'], ['子目录里的文件 private/x.db', path.join('private', 'x.db')]]) {
                    let threw = false;
                    try { instanceDb.assertNotBusinessDb(path.join(ROOT, rel)); } catch (_) { threw = true; }
                    must(hasIdentity ? !threw : threw, hasIdentity ? `线检出：本检出的 ${label} 是线库，允许准备` : `主工作区形态（无 .sdh-instance）：拒绝对本检出的 ${label} 执行（只调函数，不打开该文件）`);
                }
                let threwTmp = false;
                try { instanceDb.assertNotBusinessDb(path.join(TMP, 'any.db')); } catch (_) { threwTmp = true; }
                must(!threwTmp, '临时目录里的库不受防呆影响');
            }

            // 6g（F1）防呆看「目标所在位置」：在 os.tmpdir() 下建一个假的检出目录（空的 server.js + package.json，先不放 .sdh-instance）
            {
                const fakeCo = dbp('fake-checkout');
                fs.mkdirSync(path.join(fakeCo, 'sub', 'deep'), { recursive: true });
                fs.writeFileSync(path.join(fakeCo, 'server.js'), '');
                fs.writeFileSync(path.join(fakeCo, 'package.json'), '');
                const realFakeCo = fs.realpathSync(fakeCo);
                const bakFile = path.join(fakeCo, 'task_pool.db.backup_20261016');
                fs.writeFileSync(bakFile, 'NOT-A-DB-BUT-MUST-STAY-UNTOUCHED');
                const keyOf = (f) => { const s = fs.statSync(f); return `${s.size}@${s.mtimeMs}`; };
                const bakBefore = keyOf(bakFile);
                const prep = (target, extra) => mk(target, Object.assign({ instanceId: 'test-prep-f1' }, extra || {}));
                const rejectCase = async (label, target) => {
                    const err = await errOf(() => prep(target));
                    must(err && /检出目录/.test(err.message) && err.message.toLowerCase().includes(realFakeCo.toLowerCase()), `${label}：被防呆拒绝，消息指出触发的检出目录`, jstr(err && err.message));
                };
                await rejectCase('假检出目录下的新库（不存在）', path.join(fakeCo, 'new-line.db'));
                must(!fs.existsSync(path.join(fakeCo, 'new-line.db')) && !fs.existsSync(path.join(fakeCo, 'new-line.db-journal')), '  目标文件没有被创建');
                await rejectCase('假检出目录的子目录下的新库（不存在）', path.join(fakeCo, 'sub', 'deep', 'y.db'));
                must(!fs.existsSync(path.join(fakeCo, 'sub', 'deep', 'y.db')), '  目标文件没有被创建');
                await rejectCase('假检出目录里已存在的 task_pool.db.backup_* 备份文件', bakFile);
                must(keyOf(bakFile) === bakBefore && fs.readFileSync(bakFile, 'utf8') === 'NOT-A-DB-BUT-MUST-STAY-UNTOUCHED', '  已存在目标的大小 / mtime / 内容全部不变（没有被打开写入）', `${bakBefore} -> ${keyOf(bakFile)}`);
                // 补上 .sdh-instance：同一目录下放行（线检出形态）
                fs.writeFileSync(path.join(fakeCo, '.sdh-instance'), 'line-f1\n');
                const okTop = await errOf(() => prep(path.join(fakeCo, 'line.db')));
                const okSub = await errOf(() => prep(path.join(fakeCo, 'sub', 'deep', 'z.db')));
                must(okTop === null && fs.existsSync(path.join(fakeCo, 'line.db')) && okSub === null && fs.existsSync(path.join(fakeCo, 'sub', 'deep', 'z.db')), '补上 .sdh-instance 后：同一目录及其子目录下放行（库已准备）', jstr([okTop && okTop.message, okSub && okSub.message]));
                // 逐级上溯：外层有 .sdh-instance，但更内层的某一级又是无标记的检出目录 → 仍拒绝
                const innerCo = path.join(fakeCo, 'sub', 'deep');
                fs.writeFileSync(path.join(innerCo, 'server.js'), '');
                fs.writeFileSync(path.join(innerCo, 'package.json'), '');
                await rejectCase('外层有标记、内层目录自己是无标记检出', path.join(innerCo, 'w.db'));
                must(!fs.existsSync(path.join(innerCo, 'w.db')), '  目标文件没有被创建');
                // 6g-2（F6）目标路径经过 junction 指到检出之外：真实路径的祖先里没有检出，但原样路径的祖先里有假检出 → 仍拒绝，且目标没有被创建
                {
                    const co2 = dbp('fake-checkout-2');
                    const outside = dbp('outside-dir');
                    fs.mkdirSync(co2, { recursive: true });
                    fs.mkdirSync(outside, { recursive: true });
                    fs.writeFileSync(path.join(co2, 'server.js'), '');
                    fs.writeFileSync(path.join(co2, 'package.json'), '');
                    fs.symlinkSync(outside, path.join(co2, 'link'), 'junction');
                    must(fs.realpathSync(path.join(co2, 'link')).toLowerCase() === fs.realpathSync(outside).toLowerCase(), '前提：junction 的真实路径指向检出之外的目录');
                    const eJ = await errOf(() => prep(path.join(co2, 'link', 'new.db')));
                    must(eJ && /检出目录/.test(eJ.message) && /原样路径/.test(eJ.message) && !fs.existsSync(path.join(outside, 'new.db')) && sideFiles(path.join(outside, 'new.db')).length === 0,
                        '目标经 junction 指到检出之外：被「原样路径祖先」命中而拒绝，目标（含真实位置）没有被创建', jstr(eJ && eJ.message));
                }
            }

            // 6i（F5）目标必须原先不存在：空文件 / 硬链接 / 目录一律 TARGET_EXISTS，原文件不变；来源 / 目标目录检查；成功路径不动来源
            {
                const d5 = dbp('f5');
                fs.mkdirSync(d5, { recursive: true });
                const emptyT = path.join(d5, 'empty-target.db');
                fs.writeFileSync(emptyT, '');
                const eEmpty = await errOf(() => mk(emptyT));
                must(eEmpty && eEmpty.code === 'TARGET_EXISTS' && fs.statSync(emptyT).size === 0 && fs.readFileSync(emptyT).length === 0, '目标是已存在的空文件：拒绝，code = TARGET_EXISTS，文件仍是空的（VACUUM INTO 本身会写入空文件，所以这条只靠“目标必须不存在”挡住）', jstr(eEmpty && { c: eEmpty.code, m: eEmpty.message }));

                const hlSrc = path.join(d5, 'hl-src.db');
                await exec(hlSrc, 'CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1);');
                const hlTarget = path.join(d5, 'hl-target.db');
                fs.linkSync(hlSrc, hlTarget);
                const hlFp = fileFp(hlSrc);
                const eHl = await errOf(() => mk(hlTarget, { sourceDbPath: hlSrc }));
                must(eHl && eHl.code === 'TARGET_EXISTS' && jstr(fileFp(hlSrc)) === jstr(hlFp) && jstr(fileFp(hlTarget)) === jstr(hlFp), '目标是来源的硬链接：拒绝，code = TARGET_EXISTS；来源（及硬链接）sha256 / 大小不变', jstr(eHl && { c: eHl.code, m: eHl.message }));

                const dirT = path.join(d5, 'dir-target');
                fs.mkdirSync(dirT);
                const eDir = await errOf(() => mk(dirT));
                must(eDir && eDir.code === 'TARGET_EXISTS' && fs.statSync(dirT).isDirectory(), '目标是已存在的目录：拒绝，code = TARGET_EXISTS', jstr(eDir && eDir.message));

                const eNoSrc = await errOf(() => mk(path.join(d5, 'x1.db'), { sourceDbPath: path.join(d5, 'no-such-source.db') }));
                must(eNoSrc && !fs.existsSync(path.join(d5, 'x1.db')) && /来源/.test(eNoSrc.message), '来源不存在：拒绝，目标没有被创建', jstr(eNoSrc && eNoSrc.message));
                const eSrcDir = await errOf(() => mk(path.join(d5, 'x2.db'), { sourceDbPath: dirT }));
                must(eSrcDir && !fs.existsSync(path.join(d5, 'x2.db')) && /来源/.test(eSrcDir.message), '来源是目录：拒绝，目标没有被创建', jstr(eSrcDir && eSrcDir.message));
                const noDir = path.join(d5, 'no-such-dir');
                const eNoDir = await errOf(() => mk(path.join(noDir, 'x3.db')));
                must(eNoDir && /目标所在目录不存在/.test(eNoDir.message) && !fs.existsSync(noDir), '目标所在目录不存在：拒绝，且没有代建目录', jstr(eNoDir && eNoDir.message));

                // 成功路径（沿用 6a 的身份 / 配置 / 口令断言）：此处再钉“目标是独立的普通文件”
                const okT = path.join(d5, 'ok-target.db');
                const okSrcFp = fileFp(hlSrc);
                const rOk = await mk(okT, { sourceDbPath: hlSrc, instanceId: 'test-prep-ok' });
                const stOk = fs.lstatSync(okT);
                const idOk = await instanceDb.checkInstanceIdentity(okT, { expectedInstance: 'test-prep-ok', expectedParent: 'main' });
                must(rOk && stOk.isFile() && !stOk.isSymbolicLink() && stOk.nlink === 1 && idOk.ok && jstr(fileFp(hlSrc)) === jstr(okSrcFp), '成功：目标是 nlink = 1 的普通文件，身份核对通过，来源 sha256 不变', jstr({ nlink: stOk.nlink, idOk }));
                must(createLeft(d5).length === 0 && sideFiles(okT).join('|') === okT, '成功：目标目录里没有 .sdh-create-* 临时目录，目标旁没有伴随文件', jstr({ left: createLeft(d5), side: sideFiles(okT) }));
            }

            // 6h（F4）WAL 模式的库（直接对内部函数测，见下）：提交后做 wal_checkpoint(TRUNCATE)，调用后 -wal 文件不存在或大小为 0；被占用（busy）则抛错
            //   后两例（另有连接开着 / 持有读快照）违反“只对独立副本调用”的约定，仅用于验证检查点机制本身——这两例有意义：去掉检查点只有它们会判红
            {
                const mkWal = async (name) => {
                    const f = dbp(name);
                    await exec(f, 'PRAGMA journal_mode=WAL; CREATE TABLE seed (a INTEGER); INSERT INTO seed VALUES (1);');
                    return f;
                };
                const walSize = (f) => (fs.existsSync(f + '-wal') ? fs.statSync(f + '-wal').size : 0);
                const openHeld = (f, withTxn) => new Promise((res, rej) => {
                    const d = new sqlite3.Database(f, (e) => {
                        if (e) return rej(e);
                        d.serialize(() => {
                            if (withTxn) d.run('BEGIN');
                            d.all('SELECT count(*) AS n FROM seed', (er) => (er ? rej(er) : res(d)));
                        });
                    });
                });
                const closeHeld = (d) => new Promise((res) => d.close(() => res()));
                // 独立副本（没有其他连接）
                const w1 = await mkWal('prep-wal-1.db');
                // 内部函数（module.exports._internal，测试专用）：createIsolatedDb 建出的目标在隔离化那一步之前没有插入点，所以 WAL 检查点单独在内部函数上测
                const prepInternal = instanceDb._internal.prepareIsolatedDb;
                await prepInternal(w1, { instanceId: 'test-prep-w1', parent: 'main', sourceEncryptionKey: null });
                const jm1 = await rows(w1, 'PRAGMA journal_mode');
                must(jm1[0].journal_mode === 'wal' && walSize(w1) === 0, 'WAL 库（独立副本）：调用后库仍是 wal 模式，-wal 文件不存在或大小为 0', jstr({ jm1, walSize: walSize(w1) }));
                // 另有一个空闲连接开着：没有检查点的话关闭本连接时 -wal 删不掉、内含旧页；有 TRUNCATE 检查点则被截成 0
                const w2 = await mkWal('prep-wal-2.db');
                const idle = await openHeld(w2, false);
                try {
                    await prepInternal(w2, { instanceId: 'test-prep-w2', parent: 'main', sourceEncryptionKey: null });
                    must(walSize(w2) === 0, 'WAL 库（另有空闲连接开着）：-wal 被 TRUNCATE 检查点截成 0（没有检查点的实现这里会剩下带旧页的 -wal）', `-wal 大小 ${walSize(w2)}`);
                } finally { await closeHeld(idle); }
                // 另有一个持有读快照的连接：检查点无法完成（busy），必须抛错而不是静默放过
                const w3 = await mkWal('prep-wal-3.db');
                const holder = await openHeld(w3, true);
                let busyErr = null;
                try {
                    try { await prepInternal(w3, { instanceId: 'test-prep-w3', parent: 'main', sourceEncryptionKey: null }); } catch (e) { busyErr = e; }
                } finally { await closeHeld(holder); }
                must(busyErr && /WAL 检查点|SQLITE_BUSY/.test(busyErr.message), 'WAL 库（另有连接持有读快照）：检查点 busy ≠ 0 → 抛错，不静默放过', jstr(busyErr && busyErr.message));
            }

            // ======================= 7 非钉钉配置白名单重写（S2-0）=======================
            section('7 createIsolatedDb 的 system_configs 白名单重写（S2-0）：来源键解密 → 形态校验 → 隔离键重新加密；其余键删除');
            {
                // 全部是测试里写死的假键与哨兵值（不读 .env、不碰业务库）
                const FAKE_SRC_KEY = 'fake-source-key-for-s2-0-tests-0123456789abcdef';
                const WRONG_KEY = 'another-wrong-key-for-s2-0-tests-fedcba9876543210';
                // 合法值全部选成语料里不会偶然出现的独特串（开关键用 NBSP 包一圈：消费方 trim 会去掉，但搜索时足够独特）
                const VALID7 = {
                    collab_notify_admin_on_submit: ' on ',
                    issue_lite_developer_id: '4242',
                    issue_lite_chat_owner_id: '4343',
                    issue_lite_notify_target_ids: '4242,4343',
                    sys_notify_dry_run: ' ON ',
                    sys_release_default_executor_ids: '7777, 8888',
                    sys_single_commit_group_systems: 'SENT-SYS-ALPHA,SENT-SYS-BETA',
                };
                const KEYS7 = ['collab_notify_admin_on_submit', 'issue_lite_chat_owner_id', 'issue_lite_developer_id', 'issue_lite_notify_target_ids', 'sys_notify_dry_run', 'sys_release_default_executor_ids', 'sys_single_commit_group_systems'];   // 手写，已按默认字符串序排好
                const DT_SENT = { dingtalk_app_key: 'SENT-S20-DT-APPKEY', dingtalk_app_secret: 'SENT-S20-DT-APPSECRET', dingtalk_robot_code: 'SENT-S20-DT-ROBOT', platform_base_url: 'http://SENT-S20-base.example' };
                const NONWL = { unlisted_cfg: 'SENT-S20-NONWL-VALUE', constructor: 'SENT-S20-CTOR-VALUE' };   // constructor：原型链上就有的名字，不能被当成白名单键
                const DB_PASS_SENT = 'SENT-S20-DBPASS';
                const SENT_HOOK = 'SENT-S20-HOOKSECRET';
                const enc = (plain) => aes.encryptWithKey(FAKE_SRC_KEY, plain);
                const DB_PASS_CIPHER = enc(DB_PASS_SENT);   // 夹具实际写进来源库 db_connections 的口令密文（只生成一次；每次 enc() 的 IV 都不同，重新加密出来的串搜不到）
                const util7 = require('util');

                // ---- 4.4：在加载被测模块之前替换 aes-password 的 decryptWithKey 为记录包装，再重新加载 instance-db；第 7 段全部用这份加载 ----
                //   打过包装的 aes-password 与这份 instance-db 在整个第 7 段期间一直留在 require 缓存里（08T-M4）：被测代码若在调用时才 require('./aes-password').decryptWithKey
                //   去解钉钉行 / 口令，拿到的仍是这份记录包装，会被 decCalls 记下来；只有在段末的 finally 里才恢复外层原来的模块与缓存条目。
                const aesPath7 = require.resolve(path.join(ROOT, 'utils/aes-password.js'));
                const idbPath7 = require.resolve(path.join(ROOT, 'utils/instance-db.js'));
                const savedCache7 = [[aesPath7, require.cache[aesPath7]], [idbPath7, require.cache[idbPath7]]];
                const decCalls = [];   // 实际被解密的 { cipher, key }
                delete require.cache[aesPath7];
                delete require.cache[idbPath7];
                try {   // try 体不再缩进（避免整段重排）；对应的 finally 在本段末尾恢复缓存
                const aes7 = require(aesPath7);
                const realDecrypt7 = aes7.decryptWithKey;
                aes7.decryptWithKey = function recordingDecrypt(key, cipher) { decCalls.push({ cipher, key }); return realDecrypt7(key, cipher); };
                const instanceDb = require(idbPath7);   // 遮蔽外层的 instanceDb：本段所有调用都走带记录包装的这份
                const runP = (file, sqlText, params) => new Promise((res, rej) => { const d = new sqlite3.Database(file, (e) => { if (e) return rej(e); d.run(sqlText, params || [], (er) => d.close(() => (er ? rej(er) : res()))); }); });
                const DB_CONN_DDL = 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, type TEXT, host TEXT NOT NULL, port INTEGER, database TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL);';
                async function buildCfgSource(name, cfgRows, withConn) {
                    const f = dbp(name);
                    await exec(f, `${instanceDb.SYSTEM_CONFIGS_DDL};${withConn ? DB_CONN_DDL : ''}`);
                    for (const [key, cipher] of cfgRows) await runP(f, 'INSERT INTO system_configs (config_key, config_value_encrypted, updated_by, updated_by_name) VALUES (?, ?, 7, ?)', [key, cipher, 'real-admin']);
                    if (withConn) await seedDbConnections(f, DB_PASS_CIPHER);
                    return f;
                }
                const dumpCfg = (f) => rows(f, 'SELECT config_key, config_value_encrypted, updated_by, updated_by_name, updated_at FROM system_configs ORDER BY config_key');
                const dec = (key, cipher) => aes.decryptWithKey(key, cipher);
                const decOrErr = (key, cipher) => { try { return dec(key, cipher); } catch (_) { return 'THROWS'; } };
                // ---- 泄漏语料（08T-H1）：第 7 段里对被测模块的每一次调用，返回值、抛出的错误（util.inspect showHidden：message / stack / code / cause / 自有属性）
                //      和调用期间的全部输出（console.* 与 process.stdout / stderr.write）都进语料，放到第 7 段最后统一搜 ----
                const leak = [];
                const inspect7 = (x) => util7.inspect(x, { showHidden: true, depth: 10, breakLength: Infinity });
                async function cc(label, fn) {
                    const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug, so: process.stdout.write, se: process.stderr.write };
                    const sink = (...a) => { leak.push(`${label}:console:${a.map((x) => (typeof x === 'string' ? x : inspect7(x))).join(' ')}`); };
                    console.log = sink; console.info = sink; console.warn = sink; console.error = sink; console.debug = sink;
                    process.stdout.write = (chunk) => { leak.push(`${label}:stdout:${String(chunk)}`); return true; };
                    process.stderr.write = (chunk) => { leak.push(`${label}:stderr:${String(chunk)}`); return true; };
                    try {
                        const v = await fn();
                        leak.push(`${label}:result:${inspect7(v)}`);
                        return v;
                    } catch (e) {
                        leak.push(`${label}:error:${inspect7(e)}`);
                        throw e;
                    } finally {
                        console.log = saved.log; console.info = saved.info; console.warn = saved.warn; console.error = saved.error; console.debug = saved.debug;
                        process.stdout.write = saved.so; process.stderr.write = saved.se;
                    }
                }
                const ccErr = async (label, fn) => { try { await cc(label, fn); return null; } catch (e) { return e; } };
                /** 预期成功的调用：抛错时不让整段脚本中止，而是返回 { threw: code 或消息 }，使后面的 must 给出一条清晰的 FAIL（错误照样已进泄漏语料） */
                const ccSoft = async (label, fn) => { try { return await cc(label, fn); } catch (e) { return { threw: e && (e.code || e.message) }; } };
                const VIRT_KEYS = ['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code', 'platform_base_url'];
                /** 手写的完整返回对象（成功调用的返回值必须与它深度全等，不只是字段存在） */
                const expectRet = (cleared, rewritten, dropped) => ({ dbConnectionsCleared: cleared, configKeys: VIRT_KEYS, configRewritten: rewritten, configDropped: dropped });
                const same = (a, b) => util7.isDeepStrictEqual(a, b);
                /** 用错误来源键加密、确定性地造两种密文：解密抛错的 / 解密「恰好通过 CBC 填充校验」却是乱码的（对 FAKE_SRC_KEY 解） */
                function wrongKeyCipher(wantThrow) {
                    for (let i = 0; i < 40000; i++) {
                        const c = aes.encryptWithKey(WRONG_KEY, 'on');
                        let threw = false;
                        let out = null;
                        try { out = aes.decryptWithKey(FAKE_SRC_KEY, c); } catch (_) { threw = true; }
                        if (wantThrow ? threw : (!threw && out.includes(String.fromCharCode(0xFFFD)))) return c;
                    }
                    return null;
                }

                must(jstr(Object.keys(instanceDb.ISOLATED_CONFIG_WHITELIST).sort()) === jstr(KEYS7) && Object.isFrozen(instanceDb.ISOLATED_CONFIG_WHITELIST) && Object.values(instanceDb.ISOLATED_CONFIG_WHITELIST).every((s) => Object.isFrozen(s) && typeof s.accepts === 'function'),
                    '导出的 ISOLATED_CONFIG_WHITELIST：键恰好是手写的 7 键，对象冻结，每键带形态校验函数', jstr(Object.keys(instanceDb.ISOLATED_CONFIG_WHITELIST)));
                must(instanceDb.writeInstanceIdentity === undefined && typeof instanceDb._internal.writeInstanceIdentity === 'function' && Object.keys(instanceDb).includes('createIsolatedDb'),
                    'writeInstanceIdentity 不再公开导出（instanceDb.writeInstanceIdentity === undefined），只在 _internal 上；唯一公开入口是 createIsolatedDb', jstr(Object.keys(instanceDb)));

                const cfgRowsA = [
                    ...Object.entries(VALID7).map(([k, v]) => [k, enc(v)]),
                    ...Object.entries(DT_SENT).map(([k, v]) => [k, enc(v)]),
                    ...Object.entries(NONWL).map(([k, v]) => [k, enc(v)]),
                ];
                const origCiphersA = cfgRowsA.map((r) => r[1]);
                const wlCiphersA = cfgRowsA.filter(([k]) => KEYS7.includes(k)).map((r) => r[1]).sort();   // 白名单键且非 NULL 的密文（解密全量观察的期望集合）
                const srcA = await buildCfgSource('s20-src-a.db', cfgRowsA, true);
                const srcAFp = fileFp(srcA);
                must(fs.readFileSync(srcA).toString('latin1').includes(DB_PASS_CIPHER), '前提：来源库文件里确实能搜到夹具写进去的外部库口令密文（后面“目标库里搜不到”才有意义）');
                const mk7 = (target, extra) => instanceDb.createIsolatedDb(Object.assign({ sourceDbPath: srcA, targetDbPath: target, instanceId: 'test-s20-a', parent: 'main' }, extra || {}));

                // ---- 7.1 传正确来源键 ----
                const tA1 = dbp('s20-a1.db');
                decCalls.length = 0;
                const r71 = await cc('7.1', () => mk7(tA1, { sourceEncryptionKey: FAKE_SRC_KEY }));
                const decCalls71 = decCalls.slice();
                must(same(r71, expectRet(3, KEYS7, [{ key: 'constructor', reason: 'not_whitelisted' }, { key: 'unlisted_cfg', reason: 'not_whitelisted' }])),
                    '7.1 传正确来源键：返回值与手写的完整对象深度全等（7 键改写；constructor / unlisted_cfg = not_whitelisted；钉钉四键被覆盖不在其中；口令清 3 行）', jstr(r71));
                const rowsA1 = await dumpCfg(tA1);
                const byKeyA1 = Object.fromEntries(rowsA1.map((r) => [r.config_key, r]));
                must(jstr(rowsA1.map((r) => r.config_key).sort()) === jstr([...KEYS7, 'dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code', 'platform_base_url'].sort()),
                    '7.1 目标 system_configs 恰好是 7 个白名单键 + 钉钉四键（非白名单行不存在，含 constructor）', jstr(rowsA1.map((r) => r.config_key)));
                for (const k of KEYS7) {
                    must(decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyA1[k].config_value_encrypted) === VALID7[k], `7.1 ${k}：隔离键解出的明文全等于原明文 ${jstr(VALID7[k])}`, decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyA1[k].config_value_encrypted));
                    must(decOrErr(FAKE_SRC_KEY, byKeyA1[k].config_value_encrypted) !== VALID7[k] && byKeyA1[k].updated_by === 7 && byKeyA1[k].updated_by_name === 'real-admin',
                        `7.1 ${k}：不再能用来源键解出原文（已用隔离键重新加密），其余列（updated_by / 名称）保持`);
                }
                for (const k of Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG)) {
                    must(decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyA1[k].config_value_encrypted) === instanceDb.VIRTUAL_DINGTALK_CONFIG[k] && byKeyA1[k].updated_by_name === 'sdh-isolated', `7.1 ${k}：是虚拟值（不是来源里的哨兵）`);
                }
                const connsA1 = await rows(tA1, 'SELECT password FROM db_connections');
                must(connsA1.length === 3 && connsA1.every((c) => c.password === '') && r71.dbConnectionsCleared === 3, '7.1 外部库口令已清（3 行全为空串）', jstr(connsA1));
                must(jstr(fileFp(srcA)) === jstr(srcAFp), '7.1 来源文件 sha256 / 大小前后相同');
                const rawA1 = fs.readFileSync(tA1).toString('latin1');
                must(origCiphersA.every((c) => !rawA1.includes(c)), '7.1 来源里的 13 条旧配置密文都不在目标库文件里（被覆盖页已抹掉）');
                must(!rawA1.includes(DB_PASS_CIPHER), '7.1 外部库口令的旧密文（与上面前提里在来源库文件中搜到的是同一个字符串）不在目标库文件里');
                // 4.4 解密全量观察：被记录包装实际解密的密文集合 = 白名单键且非 NULL 的那些行的密文；钉钉四键、非白名单键、外部库口令的密文一次都没出现
                must(jstr(decCalls71.map((c) => c.cipher).sort()) === jstr(wlCiphersA) && decCalls71.every((c) => c.key === FAKE_SRC_KEY),
                    '7.4/4.4 实际被解密的密文集合全等于「白名单 7 键且非 NULL 的行」的密文（共 7 个，都用来源键）——钉钉四键、非白名单键、外部库口令的密文一次都没有被解密', jstr({ n: decCalls71.length }));
                must(!decCalls71.some((c) => cfgRowsA.filter(([k]) => !KEYS7.includes(k)).some((r) => r[1] === c.cipher) || c.cipher === DB_PASS_CIPHER), '4.4 反向核对：非白名单行 / 钉钉行 / 口令的密文都不在被解密的集合里');

                // ---- 7.2 明确传 null（不解密）----
                const tA2 = dbp('s20-a2.db');
                decCalls.length = 0;
                const r72 = await cc('7.2', () => mk7(tA2, { sourceEncryptionKey: null }));
                const decCalls72 = decCalls.slice();
                const expDrop2 = [
                    { key: 'collab_notify_admin_on_submit', reason: 'no_source_key' }, { key: 'constructor', reason: 'not_whitelisted' },
                    { key: 'issue_lite_chat_owner_id', reason: 'no_source_key' }, { key: 'issue_lite_developer_id', reason: 'no_source_key' }, { key: 'issue_lite_notify_target_ids', reason: 'no_source_key' },
                    { key: 'sys_notify_dry_run', reason: 'no_source_key' }, { key: 'sys_release_default_executor_ids', reason: 'no_source_key' }, { key: 'sys_single_commit_group_systems', reason: 'no_source_key' },
                    { key: 'unlisted_cfg', reason: 'not_whitelisted' },
                ];
                must(same(r72, expectRet(3, [], expDrop2)), '7.2 显式 null：返回值与手写完整对象深度全等（白名单 7 键全部删除，reason 全为 no_source_key；非白名单键 not_whitelisted；没有改写）', jstr(r72));
                const rowsA2 = await dumpCfg(tA2);
                const byKeyA2 = Object.fromEntries(rowsA2.map((r) => [r.config_key, r]));
                must(rowsA2.length === 4 && Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG).every((k) => decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyA2[k] && byKeyA2[k].config_value_encrypted) === instanceDb.VIRTUAL_DINGTALK_CONFIG[k]),
                    '7.2 目标里只剩虚拟钉钉凭证 4 行（照写）', jstr(rowsA2.map((r) => r.config_key)));
                const connsA2 = await rows(tA2, 'SELECT password FROM db_connections');
                must(connsA2.length === 3 && connsA2.every((c) => c.password === ''), '7.2 外部库口令照清', jstr(connsA2));
                must(decCalls72.length === 0, '4.4 显式 null 时一次解密都没发生', jstr(decCalls72.length));

                // ---- 7.2b 非隔离来源不传 sourceEncryptionKey（undefined / 属性缺失）→ SOURCE_KEY_REQUIRED ----
                {
                    const tReq = dbp('s20-req.db');
                    const tReq2 = dbp('s20-req2.db');
                    decCalls.length = 0;
                    const eReq = await ccErr('7.2b-a', () => mk7(tReq));
                    const eReq2 = await ccErr('7.2b-b', () => mk7(tReq2, { sourceEncryptionKey: undefined }));
                    must(eReq && eReq.code === 'SOURCE_KEY_REQUIRED' && eReq2 && eReq2.code === 'SOURCE_KEY_REQUIRED' && sideFiles(tReq).length === 0 && sideFiles(tReq2).length === 0 && createLeft(TMP).length === 0 && decCalls.length === 0,
                        '7.2b 非隔离来源缺 sourceEncryptionKey（属性缺失 / 显式 undefined）：code = SOURCE_KEY_REQUIRED，无目标、无 .sdh-create-* 残留、没有任何解密', jstr({ a: eReq && eReq.code, b: eReq2 && eReq2.code, left: createLeft(TMP) }));
                }

                // ---- 7.3 错误来源键：传了字符串键、来源里有非空白名单行、却一行都改写不了 → SOURCE_KEY_MISMATCH（整体回滚、无目标、无残留）----
                const tA3 = dbp('s20-a3.db');
                decCalls.length = 0;
                const e73 = await ccErr('7.3', () => mk7(tA3, { sourceEncryptionKey: WRONG_KEY }));
                must(e73 && e73.code === 'SOURCE_KEY_MISMATCH' && sideFiles(tA3).length === 0 && createLeft(TMP).length === 0 && decCalls.length === 7 && decCalls.every((c) => c.key === WRONG_KEY),
                    '7.3 错误来源键：抛 SOURCE_KEY_MISMATCH，目标与伴随路径都不存在，无 .sdh-create-* 残留；7 个白名单行都尝试过解密', jstr({ c: e73 && e73.code, left: createLeft(TMP), n: decCalls.length }));
                must(e73 && !e73.message.includes(WRONG_KEY) && !e73.message.includes(FAKE_SRC_KEY) && e73.message.includes('显式传 null') && jstr(fileFp(srcA)) === jstr(srcAFp), '7.3 错误消息不含任何键、提示“显式传 null”；来源文件 sha256 不变');

                // 7.3b 注入「解出乱码 / 形态不合法」的解密结果（确定性地覆盖 CBC 恰好通过填充校验的情形）：不得写回
                {
                    const injected = {
                        collab_notify_admin_on_submit: `${' '.repeat(2100)}on`,     // 只违反总长度上限 2048（声明的差异；单看规范化后是合法的 on）
                        sys_notify_dry_run: 'o\u0001n',                             // 同时违反开关形态（不是 on / off / 空）与「规范化后仍存在的控制字符」（trim 去不掉中间的 \u0001）——开关键没有“只违反控制字符”的值
                        issue_lite_developer_id: `${String.fromCharCode(0xFFFD).repeat(3)}\u0001`,   // 典型乱码：替换符 + 控制字符
                        issue_lite_chat_owner_id: '0',                              // 只违反形态（不是正整数）
                        sys_single_commit_group_systems: '["HRD",1]',               // 只违反形态（JSON 数组含非字符串元素）
                    };
                    const tHook = dbp('s20-hook.db');
                    decCalls.length = 0;
                    instanceDb._internal.setDecryptHookForTest((k, c, key) => (Object.prototype.hasOwnProperty.call(injected, key) ? injected[key] : realDecrypt7(k, c)));
                    let rH = null;
                    try { rH = await cc('7.3b', () => mk7(tHook, { sourceEncryptionKey: FAKE_SRC_KEY })); } finally { instanceDb._internal.setDecryptHookForTest(null); }
                    const expH = [
                        { key: 'collab_notify_admin_on_submit', reason: 'invalid_shape' }, { key: 'constructor', reason: 'not_whitelisted' },
                        { key: 'issue_lite_chat_owner_id', reason: 'invalid_shape' }, { key: 'issue_lite_developer_id', reason: 'invalid_shape' },
                        { key: 'sys_notify_dry_run', reason: 'invalid_shape' }, { key: 'sys_single_commit_group_systems', reason: 'invalid_shape' }, { key: 'unlisted_cfg', reason: 'not_whitelisted' },
                    ];
                    must(same(rH, expectRet(3, ['issue_lite_notify_target_ids', 'sys_release_default_executor_ids'], expH)),
                        '7.3b 注入乱码 / 形态不合法 / 超长 / 控制字符的解密结果：5 个键 invalid_shape 删除，未被注入的两个键（编号逗号串、执行人逗号串）被改写；返回值与手写完整对象全等', jstr(rH));
                    const rowsH = await dumpCfg(tHook);
                    const keysH = rowsH.map((r) => r.config_key).sort();
                    must(jstr(keysH) === jstr(['dingtalk_app_key', 'dingtalk_app_secret', 'dingtalk_robot_code', 'issue_lite_notify_target_ids', 'platform_base_url', 'sys_release_default_executor_ids']), '7.3b 目标里没有任何被注入键的行（乱码没有被写回）', jstr(keysH));
                }

                // ---- 7.3d 解密钩子抛出的错误消息里故意带上来源键与一个哨兵：它们不得出现在返回值 / 错误 / 输出里（最后统一搜语料）----
                {
                    const tThrow = dbp('s20-hookthrow.db');
                    instanceDb._internal.setDecryptHookForTest((k, c, key) => {
                        if (key === 'issue_lite_developer_id') throw Object.assign(new Error(`boom key=${k} secret=${SENT_HOOK}`), { cause: { k, SENT_HOOK } });
                        return realDecrypt7(k, c);
                    });
                    let rT = null;
                    try { rT = await cc('7.3d', () => mk7(tThrow, { sourceEncryptionKey: FAKE_SRC_KEY })); } finally { instanceDb._internal.setDecryptHookForTest(null); }
                    must(same(rT, expectRet(3, KEYS7.filter((k) => k !== 'issue_lite_developer_id'), [{ key: 'constructor', reason: 'not_whitelisted' }, { key: 'issue_lite_developer_id', reason: 'undecryptable' }, { key: 'unlisted_cfg', reason: 'not_whitelisted' }])),
                        '7.3d 解密钩子抛错（消息里带来源键与哨兵）：该键 undecryptable，其余 6 键改写；返回值与手写完整对象全等（reason 是固定枚举，不带异常消息）', jstr(rT));
                }

                // ---- 7.3c 混合夹具（正确来源键）：NULL / 解不开 / CBC 恰好通过填充的乱码 / 形态不合法 / 合法 同时存在 ----
                const cThrows = wrongKeyCipher(true);
                const cLucky = wrongKeyCipher(false);
                must(cThrows !== null && cLucky !== null, '前提：造出了「用错键加密、对来源键解密会抛错」与「解密恰好通过填充校验却是乱码」两种密文');
                const cipherB = {
                    collab_notify_admin_on_submit: enc('on'),
                    issue_lite_developer_id: cThrows,
                    issue_lite_chat_owner_id: cLucky,
                    issue_lite_notify_target_ids: enc('abc,def'),
                    sys_release_default_executor_ids: enc('23'),
                    sys_single_commit_group_systems: enc('HRD,电子签'),
                };
                const srcB = await buildCfgSource('s20-src-b.db', [
                    ['collab_notify_admin_on_submit', cipherB.collab_notify_admin_on_submit],
                    ['issue_lite_developer_id', cipherB.issue_lite_developer_id],
                    ['issue_lite_chat_owner_id', cipherB.issue_lite_chat_owner_id],
                    ['issue_lite_notify_target_ids', cipherB.issue_lite_notify_target_ids],
                    ['sys_notify_dry_run', null],
                    ['sys_release_default_executor_ids', cipherB.sys_release_default_executor_ids],
                    ['sys_single_commit_group_systems', cipherB.sys_single_commit_group_systems],
                    ['unlisted_cfg', enc(NONWL.unlisted_cfg)],
                    ...Object.entries(DT_SENT).map(([k, v]) => [k, enc(v)]),
                ], false);
                const tB = dbp('s20-b.db');
                decCalls.length = 0;
                const rB = await cc('7.3c', () => instanceDb.createIsolatedDb({ sourceDbPath: srcB, targetDbPath: tB, instanceId: 'test-s20-b', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                const decCallsB = decCalls.slice();
                const expB = [
                    { key: 'issue_lite_chat_owner_id', reason: 'invalid_shape' }, { key: 'issue_lite_developer_id', reason: 'undecryptable' }, { key: 'issue_lite_notify_target_ids', reason: 'invalid_shape' },
                    { key: 'sys_notify_dry_run', reason: 'null_value' }, { key: 'unlisted_cfg', reason: 'not_whitelisted' },
                ];
                must(same(rB, expectRet(0, ['collab_notify_admin_on_submit', 'sys_release_default_executor_ids', 'sys_single_commit_group_systems'], expB)),
                    '7.3c 混合夹具：返回值与手写完整对象全等（改写 3 个合法键；解不开 → undecryptable、通过填充的乱码 → invalid_shape、无合法编号的串 → invalid_shape、NULL → null_value、非白名单 → not_whitelisted）', jstr(rB));
                const rowsB = await dumpCfg(tB);
                const byKeyB = Object.fromEntries(rowsB.map((r) => [r.config_key, r]));
                must(rowsB.length === 7 && decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyB.sys_single_commit_group_systems.config_value_encrypted) === 'HRD,电子签' && decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyB.sys_release_default_executor_ids.config_value_encrypted) === '23' && decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyB.collab_notify_admin_on_submit.config_value_encrypted) === 'on',
                    '7.3c 目标 7 行（3 个改写 + 4 个虚拟），改写的明文用隔离键解出原文', jstr(rowsB.map((r) => r.config_key)));
                must(jstr(decCallsB.map((c) => c.cipher).sort()) === jstr(Object.values(cipherB).sort()),
                    '4.4 混合夹具：实际被解密的密文集合全等于「值非 NULL 的白名单行」的密文（sys_notify_dry_run 是 NULL，钉钉行与非白名单行的密文没被解密）', jstr(decCallsB.length));

                // ---- 7.4 隔离库作来源（用 7.1 的产物）----
                const srcFpIso = fileFp(tA1);
                const tIso = dbp('s20-iso-derived.db');
                const tIso2 = dbp('s20-iso-derived-null.db');
                const isoCiphers = (await dumpCfg(tA1)).filter((r) => KEYS7.includes(r.config_key)).map((r) => r.config_value_encrypted).sort();
                decCalls.length = 0;
                const r74 = await cc('7.4', () => instanceDb.createIsolatedDb({ sourceDbPath: tA1, targetDbPath: tIso, instanceId: 'test-s20-derived', parent: 'line-x' }));
                const decCalls74 = decCalls.slice();
                const r74n = await cc('7.4n', () => instanceDb.createIsolatedDb({ sourceDbPath: tA1, targetDbPath: tIso2, instanceId: 'test-s20-derived2', parent: 'line-x', sourceEncryptionKey: null }));
                const rowsIso = await dumpCfg(tIso);
                const byKeyIso = Object.fromEntries(rowsIso.map((r) => [r.config_key, r]));
                must(same(r74, expectRet(3, KEYS7, [])) && same(r74n, expectRet(3, KEYS7, [])) && KEYS7.every((k) => decOrErr(aes.ISOLATED_ENCRYPTION_KEY, byKeyIso[k].config_value_encrypted) === VALID7[k]),
                    '7.4 隔离库作来源，不传键（undefined）与显式 null 都一样：返回值与手写完整对象全等（7 键保留、无删除项），明文不变（隔离键解密再加密）', jstr({ r74, r74n }));
                must(decCalls74.length === 7 && jstr(decCalls74.map((c) => c.cipher).sort()) === jstr(isoCiphers) && decCalls74.every((c) => c.key === aes.ISOLATED_ENCRYPTION_KEY) && jstr(fileFp(tA1)) === jstr(srcFpIso),
                    '7.4/4.4 解密的是来源（7.1 产物）里 7 个白名单行的密文，解密键是隔离键；来源 sha256 不变', jstr(decCalls74.length));
                const tIsoBad = dbp('s20-iso-bad.db');
                const e74 = await ccErr('7.4e', () => instanceDb.createIsolatedDb({ sourceDbPath: tA1, targetDbPath: tIsoBad, instanceId: 'test-s20-bad', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                must(e74 && e74.code === 'SOURCE_KEY_UNEXPECTED' && sideFiles(tIsoBad).length === 0 && createLeft(TMP).length === 0 && jstr(fileFp(tA1)) === jstr(srcFpIso),
                    '7.4 隔离库作来源却传了字符串来源键：code = SOURCE_KEY_UNEXPECTED，目标与伴随路径都不存在，没有 .sdh-create-* 残留，来源不变', jstr({ c: e74 && e74.code, m: e74 && e74.message, side: sideFiles(tIsoBad), left: createLeft(TMP) }));

                // ---- 7.5（08-M2）带 _sdh_instance 表但身份行不合法的来源 → SOURCE_IDENTITY_INVALID（无目标、无残留）----
                {
                    const IDENT_DDL = 'CREATE TABLE _sdh_instance (id INTEGER, instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL);';   // 故意不带 PRIMARY KEY / CHECK，才能造出 0 行 / 2 行 / 空字段
                    const mkIdent = async (name, insertSql) => { const f = dbp(name); await exec(f, `${instanceDb.SYSTEM_CONFIGS_DDL};${IDENT_DDL}${insertSql || ''}`); await runP(f, 'INSERT INTO system_configs (config_key, config_value_encrypted) VALUES (?, ?)', ['sys_notify_dry_run', enc('on')]); return f; };
                    const variants = [
                        ['空身份表（0 行）', ''],
                        ['两行身份表', "INSERT INTO _sdh_instance VALUES (1, 'a', '2026-01-01T00:00:00Z', '{}'); INSERT INTO _sdh_instance VALUES (1, 'b', '2026-01-01T00:00:00Z', '{}');"],
                        ['身份行字段为空串', "INSERT INTO _sdh_instance VALUES (1, '', '2026-01-01T00:00:00Z', '{}');"],
                        ['身份行 id 不是 1', "INSERT INTO _sdh_instance VALUES (2, 'a', '2026-01-01T00:00:00Z', '{}');"],
                    ];
                    let vi = 0;
                    const got = [];
                    for (const [label, sqlText] of variants) {
                        vi += 1;
                        const src = await mkIdent(`s20-ident-${vi}.db`, sqlText);
                        const fp = fileFp(src);
                        for (const withKey of [undefined, FAKE_SRC_KEY, null]) {
                            const tgt = dbp(`s20-ident-${vi}-${withKey === undefined ? 'u' : withKey === null ? 'n' : 's'}.db`);
                            const e = await ccErr(`7.5-${vi}`, () => instanceDb.createIsolatedDb({ sourceDbPath: src, targetDbPath: tgt, instanceId: 'test-s20-ident', parent: 'main', sourceEncryptionKey: withKey }));
                            got.push([label, withKey === undefined ? 'undefined' : withKey === null ? 'null' : 'string', e && e.code, sideFiles(tgt).length, createLeft(TMP).length]);
                        }
                        got.push([label, 'src-unchanged', jstr(fileFp(src)) === jstr(fp)]);
                    }
                    must(got.filter((g) => g.length === 5).every((g) => g[2] === 'SOURCE_IDENTITY_INVALID' && g[3] === 0 && g[4] === 0) && got.filter((g) => g.length === 3).every((g) => g[2] === true),
                        '7.5 空身份表 / 两行身份表 / 空字段 / id 不是 1，且不论 sourceEncryptionKey 是 undefined / 字符串 / null：全部 SOURCE_IDENTITY_INVALID，无目标、无 .sdh-create-* 残留，来源不变', jstr(got));
                    // 结构不兼容的身份表（只有 x 列）同样按非法处理
                    const srcBad = dbp('s20-ident-bad.db');
                    await exec(srcBad, 'CREATE TABLE _sdh_instance (x TEXT);');
                    const eBad = await ccErr('7.5-bad', () => instanceDb.createIsolatedDb({ sourceDbPath: srcBad, targetDbPath: dbp('s20-ident-bad-t.db'), instanceId: 'test-s20-ident', parent: 'main', sourceEncryptionKey: null }));
                    must(eBad && eBad.code === 'SOURCE_IDENTITY_INVALID' && createLeft(TMP).length === 0, '7.5 身份表结构不兼容：SOURCE_IDENTITY_INVALID', jstr(eBad && eBad.code));
                    // 表名大小写变体（_SDH_INSTANCE）也算身份表（COLLATE NOCASE）：行不合法照样拒绝
                    const srcUp = dbp('s20-ident-upper.db');
                    await exec(srcUp, `${instanceDb.SYSTEM_CONFIGS_DDL};CREATE TABLE _SDH_INSTANCE (id INTEGER, instance_id TEXT NOT NULL, created_at TEXT NOT NULL, source TEXT NOT NULL);`);
                    const eUp = await ccErr('7.5-upper', () => instanceDb.createIsolatedDb({ sourceDbPath: srcUp, targetDbPath: dbp('s20-ident-upper-t.db'), instanceId: 'test-s20-ident', parent: 'main', sourceEncryptionKey: null }));
                    must(eUp && eUp.code === 'SOURCE_IDENTITY_INVALID' && createLeft(TMP).length === 0, '7.5 表名大小写变体 _SDH_INSTANCE：同样被识别为身份表（COLLATE NOCASE），0 行 → SOURCE_IDENTITY_INVALID', jstr(eUp && eUp.code));
                }

                // ---- 7.8（08T-M3）逐键负例 / 正例：消费方规范化对齐 ----
                {
                    const NEG = {
                        collab_notify_admin_on_submit: ['onn', 'true', '1'],
                        issue_lite_developer_id: ['0', '-3', 'abc'],
                        issue_lite_chat_owner_id: ['abc', '3.5', '1e400'],
                        issue_lite_notify_target_ids: ['abc', '0', '-4,-2'],
                        sys_notify_dry_run: ['true', 'yes', 'onn'],
                        sys_release_default_executor_ids: ['abc', '0', '-1,x'],
                        sys_single_commit_group_systems: ['["HRD",1]', '[not-json', 'HRD,\u0001BAD'],
                    };
                    let rn = 0;
                    // 键错检测的判据是「干净解密数 = 0」（修复批 2）：这里 7 个键的负例值解出来都是干净文本（只是形态不对），所以不再需要塞一个合法的“对照键”来避开 SOURCE_KEY_MISMATCH——
                    // 每组 7 键全部负例，逐个断言 invalid_shape、一个都不改写（去掉某键的形态校验，该键就会出现在 configRewritten 里而判红）。
                    // 唯一含控制字符的负例 'HRD,\u0001BAD' 解出来不干净，但同组其余 6 个值是干净的，所以整体仍不触发 MISMATCH。
                    for (let n = 0; n < 3; n++) {
                        rn += 1;
                        const src = await buildCfgSource(`s20-neg-${rn}.db`, KEYS7.map((k) => [k, enc(NEG[k][n])]), false);
                        const tgt = dbp(`s20-neg-${rn}-t.db`);
                        const r = await ccSoft(`7.8-neg-${rn}`, () => instanceDb.createIsolatedDb({ sourceDbPath: src, targetDbPath: tgt, instanceId: 'test-s20-neg', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                        const exp = expectRet(0, [], KEYS7.map((k) => ({ key: k, reason: 'invalid_shape' })));
                        must(same(r, exp), `7.8 负例第 ${n + 1} 组（7 键各取第 ${n + 1} 个负例 ${jstr(KEYS7.map((k) => NEG[k][n]))}）：7 键全部 invalid_shape、一个都不改写`, jstr(r));
                    }
                    // 声明的差异：总长度 > 2048（规范化后其实合法）仍判 invalid_shape
                    const srcLen = await buildCfgSource('s20-len.db', [['collab_notify_admin_on_submit', enc(`${' '.repeat(2100)}on`)], ['issue_lite_developer_id', enc('42')]], false);
                    const rLen = await ccSoft('7.8-len', () => instanceDb.createIsolatedDb({ sourceDbPath: srcLen, targetDbPath: dbp('s20-len-t.db'), instanceId: 'test-s20-len', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rLen, expectRet(0, ['issue_lite_developer_id'], [{ key: 'collab_notify_admin_on_submit', reason: 'invalid_shape' }])), '7.8 声明的差异：总长度 2102 > 2048 的开关值判 invalid_shape（消费方没有上限）', jstr(rLen));
                    // 正例：与消费方等价、原串原样改写
                    const ids65 = Array.from({ length: 65 }, (_, i) => String(i + 1)).join(', ');
                    const POS = [
                        { collab_notify_admin_on_submit: 'on\n', sys_notify_dry_run: ' ON\t', issue_lite_developer_id: '\t42', issue_lite_chat_owner_id: ' 7\n', issue_lite_notify_target_ids: ids65, sys_release_default_executor_ids: ' 23 , 7 ,', sys_single_commit_group_systems: '[\n  "HRD",\n  "电子签"\n]\n' },
                        { collab_notify_admin_on_submit: ' off ', sys_notify_dry_run: 'off', issue_lite_developer_id: '10\n', issue_lite_chat_owner_id: '1', issue_lite_notify_target_ids: '10,abc', sys_release_default_executor_ids: '23,0', sys_single_commit_group_systems: 'HRD/OA' },
                        { collab_notify_admin_on_submit: '', sys_notify_dry_run: '', issue_lite_developer_id: '', issue_lite_chat_owner_id: '', issue_lite_notify_target_ids: '', sys_release_default_executor_ids: '', sys_single_commit_group_systems: 'HRD&OA,X+Y' },
                        { collab_notify_admin_on_submit: 'on', sys_notify_dry_run: 'on', issue_lite_developer_id: '9007199254740991', issue_lite_chat_owner_id: '0x1f', issue_lite_notify_target_ids: ' 5 ', sys_release_default_executor_ids: ',7', sys_single_commit_group_systems: 'HRD·X,电子签' },
                    ];
                    let pn = 0;
                    for (const vals of POS) {
                        pn += 1;
                        const src = await buildCfgSource(`s20-pos-${pn}.db`, KEYS7.map((k) => [k, enc(vals[k])]), false);
                        const tgt = dbp(`s20-pos-${pn}-t.db`);
                        const r = await ccSoft(`7.8-pos-${pn}`, () => instanceDb.createIsolatedDb({ sourceDbPath: src, targetDbPath: tgt, instanceId: 'test-s20-pos', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                        const got = r && r.threw ? {} : Object.fromEntries((await dumpCfg(tgt)).filter((x) => KEYS7.includes(x.config_key)).map((x) => [x.config_key, decOrErr(aes.ISOLATED_ENCRYPTION_KEY, x.config_value_encrypted)]));
                        must(same(r, expectRet(0, KEYS7, [])) && KEYS7.every((k) => got[k] === vals[k]), `7.8 正例第 ${pn} 组：7 键全部改写且隔离键解出的明文与原串逐字相等（${jstr(vals)}）`, jstr({ r, got }));
                    }
                }

                // ---- 7.9 SOURCE_KEY_MISMATCH 的判据（修复批 2）：传了字符串键 + 非 NULL 白名单行 > 0 + 「干净解密数」= 0 才抛；干净解密 ≥ 1 即认定键正确，
                //      形态不合法的行照常按 invalid_shape 删除。干净解密 = 解密未抛错，且明文按该键规范化后不含 U+FFFD 与控制字符（与形态无关）----
                {
                    const sideClean = (t) => sideFiles(t).length === 0 && createLeft(TMP).length === 0;
                    // (a) 正确键、唯一一行 sys_notify_dry_run = 'yes'（手误，形态不对但文本干净）→ 成功，该行 invalid_shape
                    const srcA9 = await buildCfgSource('s20-m9a.db', [['sys_notify_dry_run', enc('yes')]], false);
                    decCalls.length = 0;
                    const rA9 = await ccSoft('7.9-a', () => instanceDb.createIsolatedDb({ sourceDbPath: srcA9, targetDbPath: dbp('s20-m9a-t.db'), instanceId: 'test-s20-m9a', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rA9, expectRet(0, [], [{ key: 'sys_notify_dry_run', reason: 'invalid_shape' }])) && decCalls.length === 1,
                        "7.9(a) 正确键 + 唯一一行 sys_notify_dry_run='yes'：成功（不抛 MISMATCH），该行 invalid_shape，没有改写；返回值与手写完整对象全等", jstr(rA9));
                    // (b) 正确键、collab = 'keepme' + executor_ids = 'abc'（两行都形态不对、文本干净）→ 成功，两行都 invalid_shape
                    const srcB9 = await buildCfgSource('s20-m9b.db', [['collab_notify_admin_on_submit', enc('keepme')], ['sys_release_default_executor_ids', enc('abc')]], false);
                    decCalls.length = 0;
                    const rB9 = await ccSoft('7.9-b', () => instanceDb.createIsolatedDb({ sourceDbPath: srcB9, targetDbPath: dbp('s20-m9b-t.db'), instanceId: 'test-s20-m9b', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rB9, expectRet(0, [], [{ key: 'collab_notify_admin_on_submit', reason: 'invalid_shape' }, { key: 'sys_release_default_executor_ids', reason: 'invalid_shape' }])) && decCalls.length === 2,
                        "7.9(b) 正确键 + collab='keepme' + executor_ids='abc'：成功，两行都 invalid_shape；返回值与手写完整对象全等", jstr(rB9));
                    // (c) 错误键 → MISMATCH；消息列各原因计数（7 行都解密失败或解出乱码），提示显式 null，不含键与明文；无目标无残留
                    const srcC9 = await buildCfgSource('s20-m9c.db', Object.entries(VALID7).map(([k, v]) => [k, enc(v)]), false);
                    const tC9 = dbp('s20-m9c-t.db');
                    const eC9 = await ccErr('7.9-c', () => instanceDb.createIsolatedDb({ sourceDbPath: srcC9, targetDbPath: tC9, instanceId: 'test-s20-m9c', parent: 'main', sourceEncryptionKey: WRONG_KEY }));
                    must(eC9 && eC9.code === 'SOURCE_KEY_MISMATCH' && sideClean(tC9) && /来源里有 7 行非空的白名单配置/.test(eC9.message) && /解密失败 \d+ 行/.test(eC9.message) && /含控制字符 \d+ 行/.test(eC9.message) && eC9.message.includes('显式传 null') && !eC9.message.includes(WRONG_KEY) && !eC9.message.includes(FAKE_SRC_KEY),
                        '7.9(c) 错误键：SOURCE_KEY_MISMATCH，消息列出“来源里有 7 行 / 解密失败 N 行 / 解出乱码或含控制字符 N 行”并提示显式传 null，不含键；无目标、无 .sdh-create-* 残留', jstr({ c: eC9 && eC9.code, m: eC9 && eC9.message }));
                    // (d) 唯一一行是别的键（轮换前旧键）加密的、用现键解不开 → MISMATCH（与键错无法区分，函数头注释写明）；计数：解密失败 1、乱码 0
                    const srcD9 = await buildCfgSource('s20-m9d.db', [['sys_notify_dry_run', cThrows]], false);
                    const tD9 = dbp('s20-m9d-t.db');
                    const eD9 = await ccErr('7.9-d', () => instanceDb.createIsolatedDb({ sourceDbPath: srcD9, targetDbPath: tD9, instanceId: 'test-s20-m9d', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(eD9 && eD9.code === 'SOURCE_KEY_MISMATCH' && sideClean(tD9) && eD9.message.includes('来源里有 1 行非空的白名单配置') && eD9.message.includes('解密失败 1 行') && eD9.message.includes('含控制字符 0 行'),
                        '7.9(d) 唯一一行是轮换前旧键加密的（现键解密抛错）：SOURCE_KEY_MISMATCH，计数“解密失败 1、乱码 0”；无目标无残留', jstr({ c: eD9 && eD9.code, m: eD9 && eD9.message }));
                    // (e) 唯一一行用别的键加密、对现键解密「恰好通过填充校验」却是乱码 → MISMATCH，计数：解密失败 0、乱码 1
                    const srcE9 = await buildCfgSource('s20-m9e.db', [['sys_notify_dry_run', cLucky]], false);
                    const tE9 = dbp('s20-m9e-t.db');
                    const eE9 = await ccErr('7.9-e', () => instanceDb.createIsolatedDb({ sourceDbPath: srcE9, targetDbPath: tE9, instanceId: 'test-s20-m9e', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(eE9 && eE9.code === 'SOURCE_KEY_MISMATCH' && sideClean(tE9) && eE9.message.includes('解密失败 0 行') && eE9.message.includes('含控制字符 1 行'),
                        '7.9(e) 唯一一行解出乱码（含 U+FFFD）：SOURCE_KEY_MISMATCH，计数“解密失败 0、乱码 1”；无目标无残留', jstr({ c: eE9 && eE9.code, m: eE9 && eE9.message }));
                }

                // ---- 7.10 字符串键 + 零候选行 → 成功（08T-M3）：没有任何“非 NULL 的白名单行”时不存在键错的证据，不得抛 MISMATCH；解密调用 0 次 ----
                {
                    const srcEmpty = await buildCfgSource('s20-z-a.db', [], false);
                    decCalls.length = 0;
                    const rZa = await ccSoft('7.10-a', () => instanceDb.createIsolatedDb({ sourceDbPath: srcEmpty, targetDbPath: dbp('s20-z-a-t.db'), instanceId: 'test-s20-za', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rZa, expectRet(0, [], [])) && decCalls.length === 0, '7.10(a) 字符串键 + system_configs 为空表：成功，返回值与手写完整对象全等（无改写、无删除），解密调用 0 次', jstr(rZa));
                    const srcOnly = await buildCfgSource('s20-z-b.db', [
                        ...Object.entries(DT_SENT).map(([k, v]) => [k, enc(v)]),
                        ['unlisted_cfg', enc(NONWL.unlisted_cfg)],
                        ['sys_notify_dry_run', null],
                    ], false);
                    decCalls.length = 0;
                    const rZb = await ccSoft('7.10-b', () => instanceDb.createIsolatedDb({ sourceDbPath: srcOnly, targetDbPath: dbp('s20-z-b-t.db'), instanceId: 'test-s20-zb', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rZb, expectRet(0, [], [{ key: 'sys_notify_dry_run', reason: 'null_value' }, { key: 'unlisted_cfg', reason: 'not_whitelisted' }])) && decCalls.length === 0,
                        '7.10(b) 字符串键 + 只有钉钉四键 / 非白名单键 / 值为 NULL 的白名单行：成功，返回值与手写完整对象全等（null_value / not_whitelisted），解密调用 0 次', jstr(rZb));
                }

                // ---- 7.11 声明的差异（修复批 2）：列表键任一项含 U+FFFD 或控制字符 → 整串删除（与消费方不等价，见 instance-db 白名单注释②）。每组必须带一个合法的对照键 issue_lite_developer_id：
                //      这些列表值解出来含 U+FFFD / 控制字符、算“不干净”，若没有一行干净解密，调用会按键错抛 SOURCE_KEY_MISMATCH；对照键同时证明调用整体成功、其余行照常改写 ----
                {
                    const FFFD = String.fromCharCode(0xFFFD);
                    // (a) 只因 U+FFFD 而删：长度合法、无控制字符、满足逗号串形态
                    const srcFf = await buildCfgSource('s20-d-a.db', [['issue_lite_developer_id', enc('42')], ['sys_single_commit_group_systems', enc(`SENT-${FFFD}-SYSTEM`)]], false);
                    const rFf = await ccSoft('7.11-a', () => instanceDb.createIsolatedDb({ sourceDbPath: srcFf, targetDbPath: dbp('s20-d-a-t.db'), instanceId: 'test-s20-da', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rFf, expectRet(0, ['issue_lite_developer_id'], [{ key: 'sys_single_commit_group_systems', reason: 'invalid_shape' }])),
                        "7.11(a) sys_single_commit_group_systems = 'SENT-<U+FFFD>-SYSTEM'（只含 U+FFFD，别无控制字符）：整串 invalid_shape；对照键改写", jstr(rFf));
                    // (b) 编号逗号串里有一项含控制字符（其余项合法）：整串删，而不是“保留合法项”
                    const srcCt = await buildCfgSource('s20-d-b.db', [['issue_lite_developer_id', enc('42')], ['issue_lite_notify_target_ids', enc('10,a\u0001b')], ['sys_release_default_executor_ids', enc('23,\u0085x')]], false);
                    const rCt = await ccSoft('7.11-b', () => instanceDb.createIsolatedDb({ sourceDbPath: srcCt, targetDbPath: dbp('s20-d-b-t.db'), instanceId: 'test-s20-db', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    must(same(rCt, expectRet(0, ['issue_lite_developer_id'], [{ key: 'issue_lite_notify_target_ids', reason: 'invalid_shape' }, { key: 'sys_release_default_executor_ids', reason: 'invalid_shape' }])),
                        "7.11(b) issue_lite_notify_target_ids = '10,a\\u0001b'、sys_release_default_executor_ids = '23,\\u0085x'（含 C0 / C1 控制字符的一项）：整串 invalid_shape（声明的差异）；对照键改写", jstr(rCt));
                }

                // ---- 参数错误：sourceEncryptionKey 只能是非空字符串、null、undefined；钩子只能是函数或 null ----
                {
                    let n = 0;
                    const t = dbp('s20-badarg.db');
                    for (const bad1 of ['', 123, {}, ['k'], true]) {
                        const e = await errOf(() => mk7(t, { sourceEncryptionKey: bad1 }));
                        if (e && /sourceEncryptionKey/.test(e.message) && !fs.existsSync(t)) n++;
                    }
                    must(n === 5, "sourceEncryptionKey 为 '' / 数字 / 对象 / 数组 / 布尔：全部按参数错误拒绝，目标未创建", `拒绝 ${n}/5`);
                    let hookErrs = 0;
                    for (const badHook of ['x', 1, {}, undefined]) { try { instanceDb._internal.setDecryptHookForTest(badHook); } catch (e) { if (e instanceof TypeError) hookErrs++; } }
                    must(hookErrs === 4, 'setDecryptHookForTest 只接受函数或 null：字符串 / 数字 / 对象 / undefined 都抛 TypeError', `抛 ${hookErrs}/4`);
                }

                // ---- 7.7 中途失败整体回滚（_internal.prepareIsolatedDb，沿用 F14）：白名单处理已执行、随后清口令那步失败 → system_configs 与原样相同 ----
                {
                    const rbCfg = await buildCfgSource('s20-rollback.db', cfgRowsA, false);
                    await exec(rbCfg, 'CREATE TABLE db_connections (id INTEGER PRIMARY KEY, name TEXT);');   // 没有 password 列：UPDATE db_connections SET password 在预编译阶段失败
                    const before = await dumpCfg(rbCfg);
                    decCalls.length = 0;
                    const eRb = await ccErr('7.7', () => instanceDb._internal.prepareIsolatedDb(rbCfg, { instanceId: 'test-s20-rb', parent: 'main', sourceEncryptionKey: FAKE_SRC_KEY }));
                    const decCallsRb = decCalls.slice();
                    const after = await dumpCfg(rbCfg);
                    const tablesRb = (await rows(rbCfg, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).map((t) => t.name);
                    must(eRb && /password/.test(eRb.message) && jstr(after) === jstr(before) && before.length === 13 && !tablesRb.includes('_sdh_instance'),
                        '7.7 中途失败整体回滚：system_configs 13 行（含 updated_at）与调用前逐行相同——没有一部分被删、一部分被改，也没有 _sdh_instance', jstr({ err: eRb && eRb.message, before: before.length, after: after.length, tables: tablesRb }));
                    // LOW-8：失败发生在清口令那一步，之前 sanitize 已经执行（7 个白名单行的密文都被解密过）——否则“回滚”断言可能只是什么都没改过
                    must(decCallsRb.length === 7 && jstr(decCallsRb.map((c) => c.cipher).sort()) === jstr(wlCiphersA), '7.7 回滚前 sanitize 确实已执行：失败前解密了 7 个白名单行的密文（解密调用次数 = 手写期望 7）', jstr(decCallsRb.length));
                }

                // ---- 7.6（08T-H1 / 08T-R H1）泄漏语料：放在第 7 段**最末**——第 7 段所有调用（含 7.7 的失败路径）的返回值、抛出的错误（message / stack / code / cause / 自有属性）
                //      和调用期间的全部输出，统一在这里搜。搜之前先断言语料里确有每个子例的标签（手写清单；子例被移到搜索之后 / 漏收进语料都会在这里判红）----
                {
                    const corpus = leak.join('\n');
                    const EXPECT_LABELS = [
                        '7.1', '7.2', '7.2b-a', '7.2b-b', '7.3', '7.3b', '7.3d', '7.3c', '7.4', '7.4n', '7.4e',
                        '7.5-1', '7.5-2', '7.5-3', '7.5-4', '7.5-bad', '7.5-upper',
                        '7.8-neg-1', '7.8-neg-2', '7.8-neg-3', '7.8-len', '7.8-pos-1', '7.8-pos-2', '7.8-pos-3', '7.8-pos-4',
                        '7.9-a', '7.9-b', '7.9-c', '7.9-d', '7.9-e', '7.10-a', '7.10-b', '7.11-a', '7.11-b', '7.7',
                    ];
                    const missingLabels = EXPECT_LABELS.filter((l) => !corpus.includes(`${l}:result:`) && !corpus.includes(`${l}:error:`));
                    must(missingLabels.length === 0 && corpus.includes('7.7:error:'), `7.6 前提：语料里确有每个子例的标签（${EXPECT_LABELS.length} 个，含 7.7 的失败路径 7.7:error）`, jstr(missingLabels));
                    const forbidden = [['假来源键', FAKE_SRC_KEY], ['错误来源键', WRONG_KEY], ['解密钩子抛错消息里的哨兵', SENT_HOOK], ...Object.entries(DT_SENT), ...Object.entries(NONWL), ['外部库口令明文', DB_PASS_SENT], ...Object.entries(VALID7).map(([k, v]) => [`${k} 的合法值`, v])];
                    for (const [name, val] of forbidden) must(!corpus.includes(val) && !corpus.includes(JSON.stringify(val).slice(1, -1)), `7.6 语料（返回值 / 错误 / 输出）里搜不到 ${name}`);
                    must(corpus.length > 2000 && corpus.includes('SOURCE_KEY_MISMATCH') && corpus.includes('SOURCE_KEY_REQUIRED') && corpus.includes('SOURCE_IDENTITY_INVALID') && corpus.includes('configRewritten'),
                        '7.6 前提：被搜的语料确实收进了错误（含 code）与返回值，不是空转', String(corpus.length));
                }
                } finally {
                    // 外层 finally：恢复外层原来的 aes-password / instance-db 模块与 require 缓存条目（第 7 段期间一直保持着打过包装的版本）
                    for (const [p, entry] of savedCache7) { if (entry) require.cache[p] = entry; else delete require.cache[p]; }
                }
            }

            // 6f 与 server.js 的建表 / 写配置语句对拍（防漂移）
            const squash = (s) => String(s).replace(/\s+/g, ' ').trim();
            const serverDdl = /db\.run\(`(CREATE TABLE IF NOT EXISTS system_configs \([\s\S]*?\))`\);/.exec(SERVER_SRC);
            must(serverDdl && squash(serverDdl[1]) === squash(instanceDb.SYSTEM_CONFIGS_DDL), 'system_configs 建表语句与 server.js initTable 里的逐字一致（忽略空白）', serverDdl && squash(serverDdl[1]));
            const serverUpsert = /`(INSERT INTO system_configs \(config_key, config_value_encrypted, updated_by, updated_by_name, updated_at\)[\s\S]*?updated_at = excluded\.updated_at)`/.exec(SERVER_SRC);
            const modSrc = fs.readFileSync(path.join(ROOT, 'utils/instance-db.js'), 'utf8');
            const modUpsert = /`(INSERT INTO system_configs \(config_key, config_value_encrypted, updated_by, updated_by_name, updated_at\)[\s\S]*?updated_at = excluded\.updated_at)`/.exec(modSrc);
            must(serverUpsert && modUpsert && squash(serverUpsert[1]) === squash(modUpsert[1]), '写配置的 upsert 语句与 server.js writeSystemConfig 里的逐字一致（忽略空白）');
            const keysInServer = /const DINGTALK_CONFIG_KEYS = (\[[^\]]*\])/.exec(SERVER_SRC);
            must(keysInServer && jstr(eval(keysInServer[1]).sort()) === jstr(Object.keys(instanceDb.VIRTUAL_DINGTALK_CONFIG).sort()), '虚拟配置键集合与 server.js 的 DINGTALK_CONFIG_KEYS 相同', keysInServer && keysInServer[1]);
        }
    } catch (e) {
        bad('未预期异常', e && e.stack);
    } finally {
        restoreFetch();
        externalGate._setConfigProviderForTest(null);
        must(TRIP.hits.length === 0, '外连绊线全程命中 0 次（没有任何真实 fetch / 非回环连接尝试）', jstr(TRIP.hits));
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { bad('临时目录清理失败', e && e.message); }
        must(!fs.existsSync(TMP), '临时目录已删除');
        console.log(`\nverify-instance-external PASS=${pass} FAIL=${fail}`);
        process.exit(fail ? 1 : 0);
    }
})();
