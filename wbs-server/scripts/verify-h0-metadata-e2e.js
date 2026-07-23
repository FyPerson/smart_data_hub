// H0 回归 - Part B：打真 metadata 端点 + 四入口 HTTP 层验证（隔离实例 3300）
// 方案 §0 回归面：① metadata 三态 ③ 四入口负向 ④ 注入探针无副作用
// 前置：PORT=3300 node server.js 已在跑；token 写在 $TEMP/h0_token.txt
// 运行：node scripts/verify-h0-metadata-e2e.js

const fs = require('fs');
const http = require('http');

const BASE = 'http://127.0.0.1:3300';
const TOKEN = fs.readFileSync(process.env.TEMP + '/h0_token.txt', 'utf8').trim();

function req(method, path, body) {
    return new Promise((resolve) => {
        const data = body ? JSON.stringify(body) : null;
        const r = http.request(BASE + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + TOKEN,
                ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
            }
        }, (res) => {
            let buf = '';
            res.on('data', c => buf += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(buf); } catch (e) {}
                resolve({ status: res.statusCode, json, raw: buf });
            });
        });
        r.on('error', e => resolve({ status: 0, error: e.message }));
        if (data) r.write(data);
        r.end();
    });
}

let pass = 0, fail = 0;
function ok(desc, cond, extra) { if (cond) { pass++; console.log(`  ✓ ${desc}`); } else { fail++; console.log(`  ✗ ${desc} ${extra || ''}`); } }

(async () => {
    // ===== ① metadata 三态 =====
    console.log('=== ① metadata 端点三态 ===');
    // 正常：模型 85 dwd_customer_visit_df（数仓真实存在，参数化后应正常返回列）
    const r85 = await req('GET', '/api/models/6/metadata');
    ok('模型6 正常返回 200 + 列非空',
        r85.status === 200 && r85.json?.metadata?.columns?.length > 0,
        `status=${r85.status} cols=${r85.json?.metadata?.columns?.length}`);
    ok('模型6 参数化后 列结构完整（column_name/data_type 非空，证明 OBJECT_ID(@param) 正确解析）',
        (r85.json?.metadata?.columns || []).every(c => c.column_name && c.data_type));

    // 404：不存在的模型 id
    const r404 = await req('GET', '/api/models/99999999/metadata');
    ok('不存在模型 → 404', r404.status === 404, `status=${r404.status}`);

    // ===== ③ 四入口负向（注入串表名一律被拒，不写库、不触达数仓） =====
    console.log('=== ③ 四入口负向（注入表名被拒）===');
    const inj = "x'; DROP TABLE data_models;--";

    const rReg = await req('POST', '/api/models', { table_name: inj, layer: 'ODS' });
    ok('注册入口拒绝注入表名 → 400', rReg.status === 400, `status=${rReg.status} body=${rReg.raw?.slice(0,80)}`);

    // 编辑入口：改模型 85 表名为注入串
    const rEdit = await req('PUT', '/api/models/6', { table_name: inj });
    ok('编辑入口拒绝注入表名 → 400', rEdit.status === 400, `status=${rEdit.status}`);

    // 批量导入：一合法一非法，非法行计入 errors
    const rBatch = await req('POST', '/api/models/batch', [
        { table_name: inj, layer: 'ODS' },
        { table_name: ' another\'bad', layer: 'DWD' }
    ]);
    ok('批量导入非法行计入 errors（failCount>0）',
        rBatch.status === 200 && (rBatch.json?.failCount > 0 || (rBatch.json?.errors||[]).length > 0),
        `body=${rBatch.raw?.slice(0,120)}`);
    ok('批量导入 errors 含"不合法"说明',
        (rBatch.json?.errors || []).some(e => /不合法/.test(e)),
        JSON.stringify(rBatch.json?.errors));

    // 伴生表入口：PUT DWD 模型 52 带非法 changeTableName（伴生表机制仅 DWD 生效，须用 DWD 样本）
    const rComp = await req('PUT', '/api/models/52', {
        dim_config: { dwdConfig: { changeTracking: { enabled: true, changeTableName: inj } } }
    });
    ok('伴生表入口拒绝非法 changeTableName → 400（DWD 模型52）', rComp.status === 400, `status=${rComp.status} body=${rComp.raw?.slice(0,80)}`);

    // ===== ③b source_table 校验（HIGH：验收引擎注入面）=====
    console.log('=== ③b source_table 注入被拒 + 中文放行 ===');
    const rSrcInj = await req('POST', '/api/models', { table_name: 'ods_h0_probe_df', layer: 'ODS', source_table: "real; DROP TABLE t;--" });
    ok('注册拒绝注入 source_table → 400', rSrcInj.status === 400, `status=${rSrcInj.status} body=${rSrcInj.raw?.slice(0,80)}`);

    const rSrcBracket = await req('POST', '/api/models', { table_name: 'ods_h0_probe2_df', layer: 'ODS', source_table: "t]; DROP--" });
    ok('注册拒绝方括号逃逸 source_table → 400', rSrcBracket.status === 400, `status=${rSrcBracket.status}`);

    // 中文 source_table 应放行（生产真实场景，不误伤）——用批量导入探（不实际落库看校验是否放过）
    const rCn = await req('POST', '/api/models/batch', [{ table_name: 'ods_h0_cn_probe_df', layer: 'ODS', source_table: '内部交易客户' }]);
    const cnRejected = (rCn.json?.errors || []).some(e => /源表名.*不合法/.test(e));
    ok('中文 source_table 未被误伤（无"源表名不合法"错误）', !cnRejected, JSON.stringify(rCn.json?.errors));

    // ===== ③c M1 复审：changeTableName 类型绕过（enabled:"true" 字符串）=====
    console.log('=== ③c changeTableName 类型绕过被拦（复审 M1）===');
    const ctInj = "x; DROP TABLE important;--";
    // 注册入口：enabled 字符串 "true" + 非法 changeTableName
    const rCt1 = await req('POST', '/api/models', {
        table_name: 'ods_h0_ctprobe_df', layer: 'DWD',
        dim_config: { dwdConfig: { changeTracking: { enabled: 'true', changeTableName: ctInj } } }
    });
    ok('注册: enabled="true" 绕过被拦 → 400', rCt1.status === 400, `status=${rCt1.status} body=${rCt1.raw?.slice(0,80)}`);
    // 编辑入口：DWD 模型52 + enabled:1 数字
    const rCt2 = await req('PUT', '/api/models/52', {
        dim_config: { dwdConfig: { changeTracking: { enabled: 1, changeTableName: ctInj } } }
    });
    ok('编辑: enabled=1 绕过被拦 → 400', rCt2.status === 400, `status=${rCt2.status}`);

    // ===== ③d M1 三审：字符串化 dim_config 绕过 + 合法对象不误伤 =====
    console.log('=== ③d 字符串化 dim_config 绕过被拦 + 合法对象放行（三审 M1）===');
    // 攻击：整个 dim_config 作为 JSON 字符串提交
    const injCfgStr = JSON.stringify({ dwdConfig: { changeTracking: { enabled: 'true', changeTableName: ctInj } } });
    const rStr = await req('POST', '/api/models', { table_name: 'ods_h0_strprobe_df', layer: 'DWD', dim_config: injCfgStr });
    ok('注册: 字符串化 dim_config 被拦 → 400', rStr.status === 400, `status=${rStr.status} body=${rStr.raw?.slice(0,90)}`);
    // 防误伤：合法对象 dim_config（含合法 changeTableName）应能正常创建
    const rObj = await req('POST', '/api/models', {
        table_name: 'ods_h0_okobj_df', layer: 'DWD',
        dim_config: { dwdConfig: { changeTracking: { enabled: true, changeTableName: 'dwd_h0_ok_change_di' } } }
    });
    ok('注册: 合法对象 dim_config 不误伤 → 2xx', rObj.status >= 200 && rObj.status < 300, `status=${rObj.status} body=${rObj.raw?.slice(0,90)}`);

    // ===== ④ 注入探针无副作用（注入串未被当 SQL 执行）=====
    console.log('=== ④ 注入无副作用确认 ===');
    // 上面注册若真执行了 DROP，data_models 会被破坏 → 再查一次模型 85 元数据应仍正常
    const rAfter = await req('GET', '/api/models/6/metadata');
    ok('注入尝试后 data_models 完好（模型6 仍可查）',
        rAfter.status === 200 && rAfter.json?.metadata?.columns?.length > 0,
        `status=${rAfter.status}`);
    // 注册注入串后，不应产生一条表名=注入串的新模型（校验在写库前拦截）
    const rList = await req('GET', '/api/models');
    const injected = (rList.json || []).some(m => m.table_name === inj);
    ok('注入表名未落库（无残留脏模型）', !injected);

    console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
})();
