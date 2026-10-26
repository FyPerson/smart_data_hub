/**
 * 协作单数据模板（example_xlsx）端到端测试 (v1.67.0)
 *
 * 验证：
 *   T1：admin 上传 .xlsx 数据模板 → 200，attachments 增加 1 条 attachment_type='example_xlsx'
 *   T2：admin 上传 .txt 非法格式 → 拒绝（multer fileFilter 或 endpoint 校验报错）
 *   T3：详情 endpoint 返回的 attachments 列表包含 example_xlsx 项，含 original_name + file_name
 *   T4：一次上传 2 个 xlsx → 入库 2 行 + template_warnings 数组
 *   T5：已有 3 个再传 3 个 → 400 EXAMPLE_XLSX_TOO_MANY（本单总数 ≤ 5）
 *
 * 用例独立 fixture，不污染其他 e2e。
 */
'use strict';

const fx = require('./_test-fixture');

// [#106 S4c-A1] 被测服务来自 test-env（自起隔离实例或 TEST_* 变量组）：BASE 在 ready() 之后才有值，不再写死 3000
let BASE = null;

const createdFixtureIds = [];

async function postAttachment(reqId, token, attachmentType, fileName, fileContent) {
    const fd = new FormData();
    fd.append('attachment_type', attachmentType);
    const buf = Buffer.from(fileContent);
    fd.append('files', new Blob([buf]), fileName);
    const res = await fetch(`${BASE}/api/collab/requests/${reqId}/attachments`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
        body: fd,
    });
    let body;
    try { body = await res.json(); } catch (e) { body = { _raw: await res.text() }; }
    return { status: res.status, body };
}

async function getDetail(reqId, token) {
    const res = await fetch(`${BASE}/api/collab/requests/${reqId}`, {
        headers: { authorization: `Bearer ${token}` },
    });
    let body;
    try { body = await res.json(); } catch (e) { body = { _raw: await res.text() }; }
    return { status: res.status, body };
}

let passed = 0;
let failed = 0;

function assert(cond, label) {
    if (cond) {
        console.log(`  ✓ ${label}`);
        passed++;
    } else {
        console.log(`  ✗ ${label}`);
        failed++;
    }
}

async function runTests() {
    console.log('=== T1: admin 上传 .xlsx 数据模板 → 200，attachments 增 1 条 example_xlsx ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);

        // xlsx 文件二进制头（PK\x03\x04 = zip 标识，被 example_xlsx 规则按扩展名识别）
        const xlsxContent = 'PK\x03\x04 mock xlsx content for e2e';
        const { status, body } = await postAttachment(ctx.id, ctx.adminToken, 'example_xlsx', 'template_demo.xlsx', xlsxContent);

        assert(status === 200, `T1 上传成功 status=${status}, body=${JSON.stringify(body).slice(0, 200)}`);
        assert(body.attachments && body.attachments.length === 1, `T1 返回 attachments[0] 存在`);
        if (body.attachments && body.attachments[0]) {
            assert(body.attachments[0].attachment_type === 'example_xlsx', `T1 attachment_type=example_xlsx`);
            assert(body.attachments[0].original_name === 'template_demo.xlsx', `T1 original_name 正确`);
        }
    }

    console.log('\n=== T2: admin 上传 .txt 非法格式 → 拒绝 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);

        const { status, body } = await postAttachment(ctx.id, ctx.adminToken, 'example_xlsx', 'wrong_format.txt', 'plain text');

        assert(status >= 400, `T2 拒绝 status=${status}（应 >= 400）, body=${JSON.stringify(body).slice(0, 200)}`);
    }

    console.log('\n=== T3: 详情 endpoint 返回 attachments 含 example_xlsx 项 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);

        // 先上传一个模板
        const xlsxContent = 'PK\x03\x04 mock xlsx for detail check';
        const uploadRes = await postAttachment(ctx.id, ctx.adminToken, 'example_xlsx', 'detail_template.xlsx', xlsxContent);
        assert(uploadRes.status === 200, `T3 准备步骤：上传 200`);

        // 拉详情
        const { status, body } = await getDetail(ctx.id, ctx.adminToken);
        assert(status === 200, `T3 详情 status=200`);
        assert(Array.isArray(body.attachments), `T3 attachments 是数组`);
        const tplFile = (body.attachments || []).find(a => a.attachment_type === 'example_xlsx');
        assert(!!tplFile, `T3 详情 attachments 含 example_xlsx 项`);
        if (tplFile) {
            assert(tplFile.original_name === 'detail_template.xlsx', `T3 original_name 正确`);
            assert(typeof tplFile.file_name === 'string' && tplFile.file_name.length > 0, `T3 file_name 非空（下载路径用）`);
        }
    }

    console.log('\n=== T4: 一次上传 2 个 xlsx → 入库 2 行 ===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const fd = new FormData();
        fd.append('attachment_type', 'example_xlsx');
        fd.append('files', new Blob([Buffer.from('PK\x03\x04 a')]), 'a.xlsx');
        fd.append('files', new Blob([Buffer.from('PK\x03\x04 b')]), 'b.xlsx');
        const res = await fetch(`${BASE}/api/collab/requests/${ctx.id}/attachments`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ctx.adminToken}` },
            body: fd,
        });
        const body = await res.json();
        assert(res.status === 200, `T4 200 实得 ${res.status}`);
        assert(Array.isArray(body.attachments) && body.attachments.length === 2, `T4 入库 2 行`);
        assert(Array.isArray(body.template_warnings), `T4 响应含 template_warnings 数组`);
    }

    console.log('\n=== T5: 已有 3 个再传 3 个 → 400 EXAMPLE_XLSX_TOO_MANY（总数上限 5）===');
    {
        const ctx = await fx.createPendingFixture();
        createdFixtureIds.push(ctx.id);
        const first = new FormData();
        first.append('attachment_type', 'example_xlsx');
        for (const n of ['t1.xlsx', 't2.xlsx', 't3.xlsx']) {
            first.append('files', new Blob([Buffer.from('PK\x03\x04 ' + n)]), n);
        }
        const r1 = await fetch(`${BASE}/api/collab/requests/${ctx.id}/attachments`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ctx.adminToken}` },
            body: first,
        });
        assert(r1.status === 200, `T5 先传 3 个 200`);
        const second = new FormData();
        second.append('attachment_type', 'example_xlsx');
        for (const n of ['t4.xlsx', 't5.xlsx', 't6.xlsx']) {
            second.append('files', new Blob([Buffer.from('PK\x03\x04 ' + n)]), n);
        }
        const r2 = await fetch(`${BASE}/api/collab/requests/${ctx.id}/attachments`, {
            method: 'POST',
            headers: { authorization: `Bearer ${ctx.adminToken}` },
            body: second,
        });
        const b2 = await r2.json();
        assert(r2.status === 400, `T5 3+3 应 400 实得 ${r2.status}`);
        assert(b2.code === 'EXAMPLE_XLSX_TOO_MANY', `T5 code=EXAMPLE_XLSX_TOO_MANY 实得 ${b2.code}`);
    }
}

(async () => {
    // ready() 在 try 之外、入口函数的第一条有副作用的语句：失败直接落到末尾 .catch（非零退出），不先吞掉失败再做 I/O
    await fx.ready();   // 先于任何写库 / 网络请求：自起隔离实例（或核对 TEST_* 变量组）
    try {
        BASE = fx.BASE;
        await runTests();
    } catch (e) {
        console.error('\n[FATAL]', e);
        failed++;
    } finally {
        // cleanup
        // [#106 S4c 收口] 夹具清理逐个 try/catch：只移除清理成功的编号，剩余编号再试一轮；仍遗留的每个计 1 次失败，不中断后续清理与 teardown
        for (let round = 0; round < 2 && createdFixtureIds.length > 0; round++) {
            if (round > 0) await new Promise((r) => setTimeout(r, 200));   // [#106 S4c 送审前小修] 两轮之间等 200ms：防服务端事务外异步回写偶发 SQLITE_BUSY 被计失败
            for (const id of createdFixtureIds.slice()) {
                try { await fx.cleanup(id); createdFixtureIds.splice(createdFixtureIds.indexOf(id), 1); } catch (e) { console.error(`cleanup ${id} failed (第 ${round + 1} 轮): ${e.message}`); }
            }
        }
        if (createdFixtureIds.length > 0) { console.error(`夹具清理失败，遗留协作单 id=${createdFixtureIds.join(',')}`); failed += createdFixtureIds.length; }
        try { await fx.teardown(); } catch (e) { console.error(`teardown 失败：${e.message}`); failed++; }
    }
    console.log(`\n=== 结果：${passed} passed / ${failed} failed ===`);
    fx.finish(failed === 0 ? 0 : 1);   // 成功路径：teardown 已落定，只设退出码、让事件循环自然结束（见 lib/test-env.js finish）
})().catch(async (e) => {
    // ready() 失败（或收尾阶段的意外异常）：打印并以非零退出；ready 失败时没有实例可收
    console.error('template e2e 启动失败：', e && e.stack || e);
    try { await fx.teardown(); } catch (_) { /* 已在报错路径 */ }
    process.exit(1);
});
