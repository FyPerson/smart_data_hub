// H0 回归 - Part B：打真 metadata 端点 + 四入口 HTTP 层验证
// 方案 §0 回归面：① metadata 三态 ③ 四入口负向 ④ 注入探针无副作用
// 运行：node scripts/verify-h0-metadata-e2e.js
//
// [#106 S4b1] 经 scripts/lib/test-env.js 自起临时隔离实例（也可由 TEST_* 变量组指向已起好的隔离实例）；不再需要人工在固定端口起服务、
//   不再读 $TEMP 下的 token 文件（token 由 testEnv.signToken(1) 用实例密钥签 admin）。
//   隔离实例没有外部库连接（external-gate 拒绝，db_connections 口令已清空），所以 3 条需要真实数仓的正向断言
//   （① 模型6 metadata 返回 200 且列非空 / ① 列结构完整 / ④ 注入后模型6 metadata 仍可查）在执行前判断：
//   /api/version 明确答复 external 是 stub 时不执行，打印一行 SKIP，不计入通过数，汇总行单列 SKIP 数；
//   版本接口本身答复异常（HTTP 非成功 / JSON 无效 / 缺字段 / 实例名或 mode 不符 / external 为其他值）不是 SKIP，计失败并终止（见 /api/version 校验那条断言）。
//   **externalOk 分支在任何 test-env 形态下都不会执行**：自起实例与 TEST_* 变量组形态下实例都是隔离模式（external 恒为 stub），
//   live 形态（TEST_TARGET=live）下 signToken 拒绝（不提供实例密钥），本脚本取不到 token——所以这三条只能人工在真实环境核对。
//   人工核对办法：用真实服务的 admin token 调 `GET /api/models/6/metadata`，应返回 200 且 metadata.columns 非空、每列有 column_name / data_type；
//   注入类请求（本脚本 ③ 各项）发过之后再调一次，仍应同样返回。分支代码原样保留。
//   ④ 另加一条不依赖数仓的替代断言：模型列表仍含 id 6。
//   本脚本会创建模型行（合法 dim_config 注册 / 批量导入中文源表名探针）：收尾按 table_name 前缀 ods_h0_ / dwd_h0_ 查到后软删除，并核对列表里已无。

'use strict';
const testEnv = require('./lib/test-env');

let BASE = null;
let TOKEN = null;

async function req(method, path, body) {
    try {
        const r = await fetch(BASE + path, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + TOKEN,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const raw = await r.text();
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        return { status: r.status, json, raw };
    } catch (e) {
        return { status: 0, error: e.message };
    }
}

let pass = 0, fail = 0, skip = 0;
function ok(desc, cond, extra) { if (cond) { pass++; console.log(`  ✓ ${desc}`); } else { fail++; console.log(`  ✗ ${desc} ${extra || ''}`); } }
function skipCase(id) { skip++; console.log(`  SKIP ${id}：隔离实例无外部库连接（external-gate 拒绝），需真实数仓环境人工核对`); }

// 本脚本创建的模型（表名前缀 ods_h0_ / dwd_h0_）→ 软删除（DELETE /api/models/:id，force 越过关联任务警告）
async function cleanupModels() {
    const list = await req('GET', '/api/models');
    if (list.status !== 200 || !Array.isArray(list.json)) return { ok: false, detail: `列表失败 status=${list.status}` };
    const mine = list.json.filter(m => typeof m.table_name === 'string' && /^(?:ods|dwd)_h0_/.test(m.table_name));
    for (const m of mine) await req('DELETE', `/api/models/${m.id}`, { reason: 'verify-h0-metadata-e2e 清理', force: true });
    const after = await req('GET', '/api/models');
    const left = (after.json || []).filter(m => typeof m.table_name === 'string' && /^(?:ods|dwd)_h0_/.test(m.table_name));
    return { ok: after.status === 200 && left.length === 0, detail: `删除 ${mine.length} 条，列表仍剩 ${left.length} 条`, deleted: mine.length };
}

(async () => {
    await testEnv.ready();   // 先于任何网络请求：自起隔离实例（或核对 TEST_* 变量组）
    try {
        BASE = testEnv.env().baseUrl;
        TOKEN = await testEnv.signToken(1);   // admin
        // 版本接口 GET /api/version（server.js:4637，无需认证）：服务端返回 { version, name, nameEn, mode, instance, external, background, commit }（mode / instance / external 取自 INSTANCE_CONFIG，utils/instance-mode.js:149 / :278）。
        //   本脚本只信这个接口的明确答复：HTTP 必须成功、响应体必须是 JSON 对象、instance 等于 test-env 契约里的实例名、mode === 'isolated'、external 必须是 'stub'（隔离模式下外部数据源恒为桩，utils/instance-mode.js:278；mode=isolated 却报 real 属于配置矛盾）；
        //   任何一项不满足（状态非成功 / JSON 无效 / 缺字段 / 身份不符 / external 为其他值）都计失败并终止，**不当成正常 SKIP**（读不到答复就无法证明「隔离实例没有外部库」，SKIP 会掩盖异常）。
        const expectedInstance = testEnv.env().instance;
        const verRes = await fetch(BASE + '/api/version');
        let ver = null;
        let verJsonProblem = null;
        try { ver = await verRes.json(); } catch (e) { verJsonProblem = '响应体不是有效 JSON：' + (e && e.message); }
        const verProblems = [];
        if (!verRes.ok) verProblems.push(`HTTP ${verRes.status}`);
        if (verJsonProblem) verProblems.push(verJsonProblem);
        else if (ver === null || typeof ver !== 'object' || Array.isArray(ver)) verProblems.push('响应体不是 JSON 对象');
        else {
            if (typeof expectedInstance !== 'string' || ver.instance !== expectedInstance) verProblems.push(`instance=${JSON.stringify(ver.instance)} 与 test-env 实例名 ${JSON.stringify(expectedInstance)} 不符或缺失`);
            if (ver.mode !== 'isolated') verProblems.push(`mode=${JSON.stringify(ver.mode)}（期望 isolated）`);
            if (ver.external !== 'stub') verProblems.push(`external=${JSON.stringify(ver.external)}（期望 stub）`);
        }
        ok('版本接口 /api/version：HTTP 成功 + JSON 对象 + instance 等于实例名 + mode=isolated + external=stub', verProblems.length === 0, verProblems.join('；'));
        if (verProblems.length) throw new Error('/api/version 答复异常，无法确认 external，终止（不记 SKIP）：' + verProblems.join('；'));
        // 走到这里 external 已确认是 'stub'，下面三项记 SKIP。externalOk 为真的正向分支（迁移前连真实数仓的原断言）在 test-env 下不可达，原样保留作断言职责记录
        const externalOk = ver.external === 'real';
        console.log(`被测实例 instance=${ver.instance} mode=${ver.mode} external=${ver.external}`);

        // ===== ① metadata 三态 =====
        console.log('=== ① metadata 端点三态 ===');
        if (externalOk) {
            // 正常：模型 85 dwd_customer_visit_df（数仓真实存在，参数化后应正常返回列）
            const r85 = await req('GET', '/api/models/6/metadata');
            ok('模型6 正常返回 200 + 列非空',
                r85.status === 200 && r85.json?.metadata?.columns?.length > 0,
                `status=${r85.status} cols=${r85.json?.metadata?.columns?.length}`);
            ok('模型6 参数化后 列结构完整（column_name/data_type 非空，证明 OBJECT_ID(@param) 正确解析）',
                (r85.json?.metadata?.columns || []).every(c => c.column_name && c.data_type));
        } else {
            skipCase('①-a 模型6 正常返回 200 + 列非空');
            skipCase('①-b 模型6 列结构完整');
        }

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
        if (externalOk) {
            const rAfter = await req('GET', '/api/models/6/metadata');
            ok('注入尝试后 data_models 完好（模型6 仍可查）',
                rAfter.status === 200 && rAfter.json?.metadata?.columns?.length > 0,
                `status=${rAfter.status}`);
        } else {
            skipCase('④-a 注入尝试后模型6 metadata 仍可查');
        }
        // 不依赖数仓的等价核对：data_models 表完好 = 模型列表仍可读且含 id 6
        const rList = await req('GET', '/api/models');
        ok('注入尝试后 data_models 完好（模型列表仍可读且含 id 6）',
            rList.status === 200 && Array.isArray(rList.json) && rList.json.some(m => m.id === 6),
            `status=${rList.status} len=${Array.isArray(rList.json) ? rList.json.length : 'n/a'}`);
        // 注册注入串后，不应产生一条表名=注入串的新模型（校验在写库前拦截）
        const injected = (rList.json || []).some(m => m.table_name === inj);
        ok('注入表名未落库（无残留脏模型）', !injected);
    } catch (e) {
        fail++;
        console.log(`  ✗ 执行异常 ${e && e.message}`);
    } finally {
        // 清理本脚本创建的模型行；清理结果本身是断言
        if (BASE && TOKEN) {
            try {
                const c = await cleanupModels();
                ok('清理：本脚本创建的模型（ods_h0_ / dwd_h0_ 前缀）已删除', c.ok, c.detail);
            } catch (e) { fail++; console.log(`  ✗ 清理异常 ${e && e.message}`); }
        }
        try { await testEnv.teardown(); } catch (e) { fail++; console.log(`  ✗ teardown（收掉自起实例）失败 ${e && e.message}`); }
    }

    console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skip} SKIP（SKIP 不计入通过数，需真实数仓环境人工核对）`);
    testEnv.finish(fail === 0 ? 0 : 1);   // 收尾：teardown 之后设退出码 + 10 秒 unref 兜底（不直接 process.exit：Node v24 / Windows 上 fetch 刚完成就 exit 会触发 libuv 断言）
})().catch(async (e) => {
    console.error('H0 e2e 启动失败：', e && e.stack || e);
    try { await testEnv.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
