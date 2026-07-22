/**
 * 数据开发台账演示数据种子（作废与查询优化 用户实测用·一次性）
 * 用法：先起本地服务（PORT=3000），再 node scripts/seed-issue-lite-demo.js
 * 建 6 张【测试】前缀单覆盖全部形态：待处理无通知对象(后补演示)/处理中有预计/已完成带看板/
 * 已作废(原待处理)/已作废(原已完成·保留完成事实)/已归档。清理：删【测试】前缀即可。
 * ⚠️ 不触发任何钉钉发送/拉群。
 */
'use strict';
const fx = require('./_test-fixture');
const BASE = 'http://localhost:3000';

async function api(method, urlPath, token, body) {
    const opts = { method, headers: { Authorization: `Bearer ${token}` } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(`${BASE}${urlPath}`, opts);
    let j = null; try { j = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error(`${method} ${urlPath} → ${r.status} ${JSON.stringify(j)}`);
    return j;
}

(async () => {
    const admin = await fx.signAs(fx.ADMIN_ID);
    const feng = await fx.signAs(fx.CONTACT_ID); // 示例用户A(3)

    // 1. 待处理·无通知对象（详情页可演示「选择通知对象」后补弹窗）
    const a = await api('POST', '/api/issue-lite', feng, {
        title: '【测试】营收月报按区域拆分取数', requester_name: '张一鸣', requester_dept: '市场营销部',
        requester_phone: '13800000001', req_date: '2026-07-31', oa_number: '36430001',
        description: '需要 2026 上半年营收按七大区域拆分，口径对齐 PBI 报表口径',
    });
    console.log(`✓ #${a.issue.id} 待处理·无通知对象（后补演示）`);

    // 2. 处理中·已回填预计（admin 回填 → 自动进处理中）
    const b = await api('POST', '/api/issue-lite', feng, {
        title: '【测试】在职人数月度报表', requester_name: '李海峰', requester_dept: '人事行政部',
        requester_phone: '13800000002', req_date: '2026-08-05', notify_target_id: 10,
        description: '按月末在职口径，含分/子公司维度',
    });
    await api('PUT', `/api/issue-lite/${b.issue.id}/estimate`, admin, { estimated_at: '2026-08-01' });
    console.log(`✓ #${b.issue.id} 处理中·预计 2026-08-01`);

    // 3. 已完成·完成说明+看板地址
    const c = await api('POST', '/api/issue-lite', feng, {
        title: '【测试】合同台账看板搭建', requester_name: '王建国', requester_dept: '华东分公司',
        requester_phone: '13800000003', oa_number: '36430003',
        description: '合同全生命周期台账，需带续签链视图',
    });
    await api('PUT', `/api/issue-lite/${c.issue.id}/status`, admin, {
        status: '已完成', complete_note: '看板已上线并与业务方核对口径，含续签链视图与到期预警',
        board_url: 'https://app.powerbi.cn/groups/demo/reports/contract-board',
    });
    console.log(`✓ #${c.issue.id} 已完成·带看板`);

    // 4. 已作废（原状态待处理·建单人作废——重复登记场景）
    const d = await api('POST', '/api/issue-lite', feng, {
        title: '【测试】营收月报取数（重复登记）', requester_name: '张一鸣', requester_dept: '市场营销部',
        requester_phone: '13800000001',
        description: '与 #' + a.issue.id + ' 重复',
    });
    await api('POST', `/api/issue-lite/${d.issue.id}/void`, feng, { reason: '与已有登记单重复，作废本单保留原单' });
    console.log(`✓ #${d.issue.id} 已作废（原待处理·重复登记）`);

    // 5. 已作废（原状态已完成·保留完成事实——业务方撤回场景）
    const e = await api('POST', '/api/issue-lite', feng, {
        title: '【测试】口径变更前的利润表取数', requester_name: '赵敏', requester_dept: '财务管理部',
        requester_phone: '13800000005', oa_number: '36430005',
    });
    await api('PUT', `/api/issue-lite/${e.issue.id}/status`, feng, {
        status: '已完成', complete_note: '按旧口径完成交付，Excel 已发送业务方',
    });
    await api('POST', `/api/issue-lite/${e.issue.id}/void`, feng, { reason: '财务口径调整，旧口径交付作废留痕，新口径另行建单' });
    console.log(`✓ #${e.issue.id} 已作废（原已完成·保留完成时间）`);

    // 6. 已归档
    const f = await api('POST', '/api/issue-lite', admin, {
        title: '【测试】历史需求归档样例', requester_name: '孙丽', requester_dept: '杭州区域',
        requester_phone: '13800000006',
    });
    await api('PUT', `/api/issue-lite/${f.issue.id}/status`, admin, {
        status: '已完成', complete_note: '已交付并确认，无后续跟进事项，可归档',
    });
    await api('PUT', `/api/issue-lite/${f.issue.id}/status`, admin, { status: '已归档' });
    console.log(`✓ #${f.issue.id} 已归档`);

    console.log('\n✅ 6 张演示单就绪（admin 勾「含已作废」可见 2 张作废单）');
})().catch(e => { console.error('❌ 种子失败：' + e.message); process.exit(1); });
