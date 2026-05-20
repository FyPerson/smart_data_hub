/**
 * 协作单数据模板（example_xlsx）端到端测试 (v1.67.0)
 *
 * 验证：
 *   T1：admin 上传 .xlsx 数据模板 → 200，attachments 增加 1 条 attachment_type='example_xlsx'
 *   T2：admin 上传 .txt 非法格式 → 拒绝（multer fileFilter 或 endpoint 校验报错）
 *   T3：详情 endpoint 返回的 attachments 列表包含 example_xlsx 项，含 original_name + file_name
 *
 * 用例独立 fixture，不污染其他 e2e。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { tmpdir } = require('os');
const fx = require('./_test-fixture');

const BASE = 'http://localhost:3000';

let testTmpDir = null;
const createdFixtureIds = [];

function makeTmpFile(filename, content) {
    if (!testTmpDir) testTmpDir = fs.mkdtempSync(path.join(tmpdir(), 'collab-template-test-'));
    const p = path.join(testTmpDir, filename);
    fs.writeFileSync(p, content);
    return p;
}

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
}

(async () => {
    try {
        await runTests();
    } catch (e) {
        console.error('\n[FATAL]', e);
        failed++;
    } finally {
        // cleanup
        for (const id of createdFixtureIds) {
            try { await fx.cleanup(id); } catch (e) { console.warn(`cleanup ${id} failed: ${e.message}`); }
        }
        if (testTmpDir) {
            try { fs.rmSync(testTmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
        }
        console.log(`\n=== 结果：${passed} passed / ${failed} failed ===`);
        process.exit(failed === 0 ? 0 : 1);
    }
})();
