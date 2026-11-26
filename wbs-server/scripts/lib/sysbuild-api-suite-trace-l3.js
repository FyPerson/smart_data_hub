// #213 L3：确认单展示与开始门读取失败。夹具沿用 test-env / 进程内套件；期望手写。
'use strict';
const assert = require('assert');
const path = require('path');
const express = require('express');
const { listenOnSafePort } = require('./listen-safe-port');
const P = 'L3 留痕：';
const FAIL_TEXT = '开发节点开始条件无法读取，请刷新后重试';
const section = (html, id) => {
  const found = html.match(new RegExp('<section id="' + id + '">[\\s\\S]*?</section>'));
  assert.ok(found, '缺少确认单分区 ' + id);
  return found[0];
};
function defineTraceL3Cases(T) {
  const { test, U, api, sqlGet, sqlAll, expectErr, confirm: H } = T;
  const post = (url, body) => api(U.pm, 'POST', url, body || {});
  const get = (url) => api(U.pm, 'GET', url);
  const patch = (url, body) => api(U.pm, 'PATCH', url, body);
  const mod = (name) => require(path.join(T.getModuleDir(), name));

  test(`${P}开始门读取失败——HTTP读写同源拒绝且准确说明原因`, async () => {
    const pid = await H.newProject();
    const node = await sqlGet("SELECT * FROM sysbuild_nodes WHERE project_id=? AND template_key='b_dev'", [pid]);
    const user = await sqlGet('SELECT id,username,display_name,role FROM users WHERE id=?', [U.pm]);
    let broken = false; let attemptedWrites = 0;
    const q = {
      get: sqlGet,
      all: async (query, params) => {
        // 只在汇报事实的开发节点查询上注入读取失败，项目权限、普通排期查询仍读真实隔离夹具。
        if (broken && query.includes("WHERE batch_id = ? AND status <> 'cancelled' ORDER BY id")) throw new Error('L3 模拟汇报事实读取失败');
        return sqlAll(query, params);
      },
      run: async () => { attemptedWrites += 1; throw new Error('失败分支不允许写入'); },
    };
    const db = { withRead: (fn) => fn(q), withWriteTxn: (fn) => fn(q) };
    const routes = mod('plan.js').createPlanRoutes({ db, logger: { error() {} }, readonlyIds: [], writeRoles: ['admin', 'publisher', 'user'], attachmentHelpers: { bindStagedAttachments() { throw new Error('不应绑定附件'); } }, todayProvider: () => '2090-11-15' });
    const app = express(); app.use((req, res, next) => { req.user = user; next(); }); app.use('/api', routes.router);
    const server = await listenOnSafePort(app);
    const call = async (method, url) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
      const body = await response.json(); return { status: response.status, body, text: JSON.stringify(body) };
    };
    try {
      const control = await call('GET', `/sysbuild/projects/${pid}/plan`);
      assert.strictEqual(control.status, 200, control.text);
      assert.strictEqual(control.body.nodes.find((n) => n.id === node.id).dev_start_ready, 'ok');
      broken = true;
      const viewed = await call('GET', `/sysbuild/projects/${pid}/plan`);
      assert.strictEqual(viewed.status, 200, viewed.text);
      const current = viewed.body.nodes.find((n) => n.id === node.id);
      assert.strictEqual(current.dev_start_ready, 'unknown', '读取失败不能冒充缺计划');
      assert.strictEqual(current.actions.start, false, '读取失败 actions.start 同源为假');
      assert.strictEqual(current.report.facts_unreadable, true);
      const denied = await call('POST', `/sysbuild/nodes/${node.id}/start`);
      expectErr(denied, 409, 'SYSBUILD_STATE', '读取失败的开始门');
      assert.strictEqual(denied.body.message, FAIL_TEXT, '开始门应准确提示读取失败');
      assert.strictEqual(attemptedWrites, 0, '拒绝前不应触达任何写入');
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_nodes WHERE id=?', [node.id])).status, 'not_started');
    } finally { await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); }
  });

  test(`${P}立项依据确认单——选入立项节点材料冻结版与声明同时展示`, async () => {
    const pid = await H.newProject(); await H.seedParty(pid, '立项需求部门', U.own, U.del);
    const nodes = await sqlAll('SELECT * FROM sysbuild_nodes WHERE project_id=?', [pid]);
    const initiation = nodes.find((n) => n.template_key === 'p_initiation');
    const other = nodes.find((n) => n.template_key === 'b_dev');
    async function material(node, key, name, body) {
      const aid = await H.stageAtt(pid, U.pm);
      const r = await post(`/sysbuild/nodes/${node.id}/materials/${key}/versions`, { name, body, attachment_ids: [aid] });
      assert.strictEqual(r.status, 201, r.text); return { vid: r.body.version.id, aid };
    }
    const chosen = await material(initiation, 'initiation-basis', '立项依据', '提交时选入的立项依据第一版');
    const foreign = await material(other, 'other-proof', '开发节点材料', '不应归到立项依据的其他节点正文');
    const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk);
    const saved = await patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: { text: '项目立项确认正文', material_version_ids: [chosen.vid, foreign.vid] } });
    assert.strictEqual(saved.status, 200, saved.text);
    assert.strictEqual((await post(`/sysbuild/package-versions/${vid}/submit`)).status, 200);
    const later = await material(initiation, 'initiation-basis', '立项依据', '后来的材料版本不能替换已提交版本');
    const response = await get(`/sysbuild/package-versions/${vid}/confirmation-sheet`);
    assert.strictEqual(response.status, 200, response.text);
    // #212 C2（D4，清单 4.4 ⑥）：小节序号手推——快照、立项依据、冻结附件、引用材料版本全文（本场景选入两份材料）、必需确认人，附录不编号（#212 C7：「引用条目」小节随需求条目流程删除，必需确认人前移一位，M-SHEET）
    const heads = (response.text.match(/<h2>[^<]*<\/h2>/g) || []).map((x) => x.slice(4, -5));
    assert.deepStrictEqual(heads, ['一、包内容快照', '二、立项依据', '三、冻结附件清单（本包版本）', '四、引用材料版本全文', '五、必需确认人', '附录：修订历史'], '立项包小节序号连续（无节点计划节、无历史补录节）');
    const basis = section(response.text, 'sec-initiation-basis');
    for (const text of ['立项依据', '提交时选入的立项依据第一版', `data-material-version-id="${chosen.vid}"`, `data-attachment-id="${chosen.aid}"`]) assert.ok(basis.includes(text), '立项依据缺少 ' + text);
    assert.ok(!basis.includes('开发节点材料'), '仅立项节点材料进入依据分区');
    assert.ok(!basis.includes(`data-material-version-id="${later.vid}"`), '不得读取材料最新版');
    assert.ok(!basis.includes(`data-attachment-id="${later.aid}"`), '不得读取后续附件');
    const frozen = await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type='package_version' AND object_version_id=? AND attachment_id=?", [vid, chosen.aid]);
    assert.ok(basis.includes(frozen.sha256), '须展示本版冻结附件散列');
  });

  test(`${P}提交拒绝原因同源——读接口submit_block与提交端点同一原文，无权限不给原因`, async () => {
    const pid = await H.newProject();
    const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk);
    // 读到的原因必须与此刻真正点提交时服务端返回的原文、错误码逐字相同（提交被拒不改任何状态）。
    async function sameAsSubmit(expectedMessage) {
      const view = await get(`/sysbuild/package-versions/${vid}`);
      assert.strictEqual(view.status, 200, view.text);
      assert.strictEqual(view.body.actions.submit, false, 'submit 为假时才有原因');
      assert.deepStrictEqual(view.body.submit_block, { code: 'SYSBUILD_STATE', message: expectedMessage });
      const denied = await post(`/sysbuild/package-versions/${vid}/submit`);
      expectErr(denied, 409, 'SYSBUILD_STATE', '提交被拒');
      assert.strictEqual(denied.body.message, view.body.submit_block.message, '读接口原因与提交端点原文不同源');
      assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id=?', [vid])).status, 'draft');
    }
    await sameAsSubmit('项目还没有需求部门参与方，无法确定必需确认人');
    await H.seedParty(pid, '原因核对需求部门', U.own, null);
    await sameAsSubmit('请选入「立项依据」中带可用附件的一版，或在立项依据卡片填写无书面依据原因（10–500字）');
    const own = await api(U.own, 'GET', `/sysbuild/package-versions/${vid}`);
    assert.strictEqual(own.status, 200, own.text);
    assert.strictEqual(own.body.actions.submit, false);
    assert.strictEqual(own.body.submit_block, null, '没有发起权限的账号不给原因');
    await H.declareInitiationBasis(vid);
    const saved = await patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: { text: '原因核对立项内容' } });
    assert.strictEqual(saved.status, 200, saved.text);
    const ready = await get(`/sysbuild/package-versions/${vid}`);
    assert.strictEqual(ready.body.actions.submit, true);
    assert.strictEqual(ready.body.submit_block, null, '可提交时不给原因');
    assert.strictEqual((await post(`/sysbuild/package-versions/${vid}/submit`)).status, 200);
    const pending = await get(`/sysbuild/package-versions/${vid}`);
    assert.strictEqual(pending.body.version.status, 'pending');
    assert.strictEqual(pending.body.submit_block, null, '非草稿不给原因');
  });

  test(`${P}立项依据声明单独展示——无材料旧版说明且声明转义`, async () => {
    const pid = await H.newProject(); await H.seedParty(pid, '口头立项需求部门', U.own, U.del);
    const pk = await H.mkPackage(pid, 'initiation'); const vid = await H.mkVersion(pk);
    const node = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [pid]);
    assert.strictEqual((await post(`/sysbuild/nodes/${node.id}/materials/initiation-basis/not-applicable`, { reason: '口头会议 <img src=x> 已批准本次项目建设' })).status, 201);
    const r = await patch(`/sysbuild/package-versions/${vid}`, { snapshot_json: { text: '口头立项确认内容' } });
    assert.strictEqual(r.status, 200, r.text); assert.strictEqual((await post(`/sysbuild/package-versions/${vid}/submit`)).status, 200);
    const response = await get(`/sysbuild/package-versions/${vid}/confirmation-sheet`); assert.strictEqual(response.status, 200, response.text);
    const basis = section(response.text, 'sec-initiation-basis');
    assert.ok(basis.includes('无书面依据')); assert.ok(basis.includes('口头会议 &lt;img src=x&gt; 已批准本次项目建设'));
    assert.ok(basis.includes('本版未选入立项节点材料'));
  });
}
const mu = (id, expect, file, from, to) => ({ id: `L3 ${id}`, expect: [`${P}${expect}`], edits: [{ file, from, to }] });
const TRACE_L3_MUTATIONS = [
  mu('开始事实失败误报缺计划', '开始门读取失败', 'report-core.js', "if (facts.unreadable || facts.is_dev === null) return 'unknown';", "if (facts.unreadable || facts.is_dev === null) return 'no_plan';"),
  mu('确认单漏立项依据', '立项依据确认单', 'confirmation-sheet.js', "${m.pkg.type === 'initiation' ? section('sec-initiation-basis', '立项依据', renderInitiationBasis(m)) : ''}", "${''}"),
  mu('确认单立项误收其他节点', '立项依据确认单', 'confirmation-sheet.js', 'm.materials.filter((material) => ids.includes(material.node_id))', 'm.materials'),
  mu('确认单立项遗漏声明', '立项依据声明单独展示', 'confirmation-sheet.js', 'const reason = m.snapshot.no_written_basis_reason;', 'const reason = null;'),
  // 55 号 D1 修复：读接口拒绝原因与提交端点同一判定。
  {"id":"L3 提交原因不给出","expect":["L3 留痕：提交拒绝原因同源"],"edits":[{"file":"packages.js","from":"return v && v.status !== 403 ? {","to":"return false ? {"}]},
  mu('提交原因不用版本事实', '提交拒绝原因同源', 'packages.js', "rules.checkOp('package_version_submit', access, access.project, versionTarget(ver, pkg, batchStatus, facts));", "rules.checkOp('package_version_submit', access, access.project, versionTarget(ver, pkg, batchStatus, {}));"),
  mu('提交原因对无权限也给出', '提交拒绝原因同源', 'packages.js', 'return v && v.status !== 403 ?', 'return v ?'),
  mu('提交原因不限草稿', '提交拒绝原因同源', 'packages.js', "    if (ver.status !== 'draft') return null;\n    const v = rules.checkOp('package_version_submit'", "    const v = rules.checkOp('package_version_submit'"),
];
module.exports = { defineTraceL3Cases, TRACE_L3_MUTATIONS };
