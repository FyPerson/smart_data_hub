// 验证脚本库：项目管理（系统建设记录）模块 C3b / C5——内容包与版本（草稿期）、通用建包入口、现行版本解析、snapshot 编辑与校验、actions 同源的用例（#113 段 3 N-S2）
//   #212 第一步 C7：由原 sysbuild-api-suite-items.js 拆出——模块、需求条目与版本、条目集合修订、附件沿用的用例与变异随需求条目流程删除，保留规则的 12 组用例整组搬来、5 组拆分后搬来、1 组改写后搬来（逐用例去向见 C7 提交卡 test-impact 第一节）。
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 / §2.3 / §4.1 / §4.5 / §5.2 / §6.2 / §6.3 / §7 / §10.3
//   派单：docs/local/系统建设记录/送审准备/C3b_模块条目内容包_派单_20261030.md §4
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 的 defineCases() 末尾调用 definePackageCases(T) 登记（同一套夹具、同一个变异自检）。
//   T = 套件注入的夹具与助手。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects，建包 / 版本都走生产端点。只有 C3b 无法经生产路径到达的状态直接写库，并在用例名里标「夹具」：
//   ① 总体规划版本 effective——C4a 起，能经生产路径到达的（兄弟项目生效版本、验收包 parent、D1 的总体规划 / 立项包、包读接口）已改走「提交 + 全部确认」；
//   仍用夹具的是生产路径到不了的状态：总体规划版本被替代、生效后再回到生效、结项包 / 验收包生效、版本状态在 draft / pending / effective 间来回切换的矩阵用例；
//   ② 包版本 pending；③ 第二个批次 / 已转出 / 被替代批次（C3 没有建批次端点）；
//   ④ 附件的软删除状态与包版本自己的附件绑定（附件端点有专门的验证脚本，这里只需要这些状态）。
'use strict';
const assert = require('assert');
const path = require('path');

function definePackageCases(T) {
  const { test, U, api, apiRaw, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember } = T;
  // T.confirm = sysbuild-api-suite-confirm.js 的共用助手（C4a 交接 ②：经生产路径让总体规划 / 立项包版本生效）
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const patch = (uid, url, body) => api(uid, 'PATCH', url, body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  let projSeq = 0;
  let attSeq = 0;
  let nameSeq = 0;
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  async function newProject(buildType, pm) {
    projSeq += 1;
    return T.createEmptyProjectFixture(pm || U.pm, { system_name: `内容包测试项目${projSeq}`, build_type: buildType || 'inhouse' });
  }
  const defaultBatchId = T.confirm.defaultBatchId;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '内容包用例' });
  async function stageAttachment(pid, uid) {
    attSeq += 1;
    const r = await sqlRun(
      "INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (?, ?, '证据文件.txt', 'text/plain', 3, ?, 0, ?)",
      [pid, `c3b-${runTag}-${attSeq}.txt`, 'b'.repeat(64), uid]
    );
    return r.lastID;
  }
  const deleteAtt = (aid) => sqlRun("UPDATE sysbuild_attachments SET deleted_at = '2026-10-30 10:00:00', deleted_by = 1 WHERE id = ?", [aid]);
  async function mkPackage(pid, type, batchId) {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/packages`, batchId ? { type, batch_id: batchId } : { type });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.package.id;
  }
  async function mkVersion(pkid, uid) {
    const r = await post(uid || U.pm, `/sysbuild/packages/${pkid}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    return r.body.version.id;
  }
  // 夹具：包版本状态直接改写（pending / effective 无法经 C3b 的生产路径到达，C4 才有提交确认与生效）。
  const setVerStatus = (vid, st) => sqlRun(
    st === 'effective' ? "UPDATE sysbuild_package_versions SET status = 'effective', effective_at = '2026-10-30 10:00:00' WHERE id = ?"
      : `UPDATE sysbuild_package_versions SET status = '${st}', effective_at = NULL WHERE id = ?`,
    [vid]
  );
  // 夹具（P-S0，2026-11-01）：兄弟项目——有一个生效的总体规划版本。过滤模式下用例单独运行，库里没有别的项目的数据；
  //   凡是在「新项目上断言现行 / 生效的总体规划版本为空」的用例，先调用它，「解析函数不限本项目」这类变异才会让断言判红（以前靠前序用例残留的数据，隐式依赖）。
  //   C4a 交接 ②：改走生产路径（需求部门参与方 + 提交 + 全部确认），不再直接改写版本状态。
  async function mkSiblingEffectiveOverall() {
    const sib = await newProject();
    return (await T.confirm.produceEffectiveOverall(sib)).pv;
  }
  // 夹具：直接写第二个及之后的批次（C3 没有建批次端点）。
  async function fixtureBatch(pid, status) {
    const seqNo = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [pid])).m + 1;
    const r = await sqlRun(
      'INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status) VALUES (?, ?, ?, 0, ?)',
      [pid, seqNo, `夹具批次${seqNo}`, status || 'planning']
    );
    return r.lastID;
  }
  // 数组请求体：必须是「请求体必须是 JSON 对象」这一条（field = body）。只断言 400 不够——去掉 bodyOf 的数组判断后，缺字段的 400 会顶替它。
  const expectBodyNotObject = (r, label) => {
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
    assert.strictEqual(r.body.field, 'body', `${label} 的 field 应为 body（实际 ${JSON.stringify(r.body)}）`);
  };

  // ── 内容包附件视图 ───────────────────────────────────────────────────────────────────────────────
  // #212 C7：原载体是条目详情的附件视图（随需求条目流程删除）；改用确认任务详情的冻结附件视图（confirm-core.attachmentView，经 attachmentStateFields 展开遮蔽 / 删除字段）。
  test('C3b 读接口：附件视图的删除信息（夹具软删除）——显示已删除、删除时间、删除人；原名仍可见，只有遮蔽才隐藏原名（预筛 LOW-5；载体：确认任务详情的冻结附件视图）', async () => {
    const pid = await newProject();
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    await T.confirm.seedEffectiveInitiation(pid);
    const pv = await mkVersion(await mkPackage(pid, 'overall'));
    const attId = await stageAttachment(pid, U.pm);
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'package_version', ?, ?)", [attId, pv, U.pm]);
    await T.confirm.planAllNodes(pid);
    await T.confirm.prepareBasisVersion(pv);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    const task = (await T.confirm.tasksOf(pv))[0];
    await deleteAtt(attId); // 夹具：软删除状态（软删除端点有专门的验证脚本）
    const view = await get(task.user_id, `/sysbuild/confirm-tasks/${task.task_id}`);
    assert.strictEqual(view.status, 200, view.text);
    const d = view.body.frozen_attachments.find((item) => item.attachment_id === attId);
    assert.deepStrictEqual([d.deleted, d.deleted_at, d.deleted_by, d.name, d.masked, d.masked_at, d.masked_by, d.mask_reason],
      [true, '2026-10-30 10:00:00', 1, '证据文件.txt', false, null, null, null]);
  });

  // ── 4 内容包 ─────────────────────────────────────────────────────────────────────────────────────
  // C5（R10，C5-RC1–C5-RC5 / RC25）：通用建包入口按最终清单（PACKAGE_TYPES_FINAL）校验类型，位置在批次参数校验、可见性与权限之前；先采集全部请求、后统一断言，每条带标签。
  test('C5 R10：通用建包入口按最终清单拒绝（C5-RC1–C5-RC5 各请求：batch_req / change 与通用非法类型同口径 400 field=type；类型校验先于批次、可见性与权限）', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    await addMember(pid, U.m1);
    const url = `/sysbuild/projects/${pid}/packages`;
    const REC = {};
    const grab = async (label, uid, body) => { const r = await post(uid, url, body); REC[label] = { status: r.status, body: r.body }; };
    // 先发完全部请求
    await grab('R10-1a', U.pm, { type: 'batch_req', batch_id: batch });
    await grab('R10-1b', U.pm, { type: 'batch_req' });
    await grab('R10-2', U.pm, { type: 'change' });
    await grab('R10-2b', U.pm, { type: 'change', batch_id: batch });
    await grab('顺序对照①', U.pm, { type: 'initiation', batch_id: batch }); // 批次错误：initiation 不挂批次
    await grab('[C5-RC5-A-非成员]', U.out, { type: 'batch_req', batch_id: batch });
    await grab('[C5-RC5-A-非PM]', U.m1, { type: 'batch_req', batch_id: batch });
    await grab('[C5-RC5-B-非成员]', U.out, { type: 'change' });
    await grab('[C5-RC5-B-非PM]', U.m1, { type: 'change' });
    await grab('[C5-RC5-foo]', U.out, { type: 'foo' });
    await grab('[C5-RC5-foo-非PM]', U.m1, { type: 'foo' }); // 非 PM 成员 + 通用非法类型：类型校验仍先于权限（400 field=type，不是 403）
    await grab('通用-foo', U.pm, { type: 'foo' });
    await grab('通用-5', U.pm, { type: 5 });
    await grab('通用-缺省', U.pm, {});
    // 后统一断言
    const MSG = 'type 必须是 initiation / overall / batch_accept / closing 之一';
    const typeErr = (label) => {
      const r = REC[label];
      assert.strictEqual(r.status, 400, `${label} 状态码应为 400，实际 ${r.status}`); // 失败信息带实际状态码：N21 / N19 下非成员 404、非 PM 403 分别记录
      assert.deepStrictEqual(r.body, { code: 'SYSBUILD_INVALID_INPUT', message: MSG, field: 'type' }, `${label} 完整响应`);
      assert.deepStrictEqual(Object.keys(r.body).sort(), ['code', 'field', 'message'], `${label} 响应键集合`);
    };
    // 逐项断言、各带标签、不在第一条失败处停（N19 / N21 的判红证据要求目标标签都出现在失败信息里）
    const fails = [];
    const chk = (label, fn) => { try { fn(); } catch (e) { fails.push(`${label.startsWith('[') ? label : `[${label}]`} ${String(e.message).split('\n')[0].slice(0, 200)}`); } };
    for (const label of ['R10-1a', 'R10-1b', 'R10-2', 'R10-2b', '[C5-RC5-A-非成员]', '[C5-RC5-A-非PM]', '[C5-RC5-B-非成员]', '[C5-RC5-B-非PM]', '[C5-RC5-foo]', '[C5-RC5-foo-非PM]', '通用-foo', '通用-5', '通用-缺省']) chk(label, () => typeErr(label));
    chk('顺序对照①', () => {
      assert.strictEqual(REC['顺序对照①'].status, 400);
      assert.strictEqual(REC['顺序对照①'].body.field, 'batch_id', '对照：initiation 带 batch_id 得批次错误（类型合法时才轮到批次校验）');
    });
    assert.strictEqual(fails.length, 0, fails.join(' ‖ ')); // 单行：变异记录只保留失败信息首行，各标签都要在这一行里
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_packages WHERE project_id = ?', [pid])).n, 0, '全部被拒，没有建出任何包');
  });

  test('C5 R10：create_package_types 与建包入口逐类型同源（读接口只列最终清单里的类型，顺序固定）', async () => {
    const pid = await newProject();
    const typesOf = async () => (await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.actions.create_package_types;
    assert.deepStrictEqual(await typesOf(), ['initiation', 'overall', 'batch_accept', 'closing'], '顺序与旧输出一致');
    const listed = await typesOf();
    const batch = await defaultBatchId(pid);
    for (const t of ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing']) {
      const res = await post(U.pm, `/sysbuild/projects/${pid}/packages`, t === 'batch_req' || t === 'batch_accept' ? { type: t, batch_id: batch } : { type: t });
      if (listed.includes(t)) assert.strictEqual(res.status, 201, `${t}：列出了就必须建得成 ${res.text}`);
      else assert.strictEqual(res.status, 400, `${t}：没列出就是 400 field=type ${res.text}`);
    }
  });

  test('C3b 包创建：overall / initiation / closing 各一次成功、重复 409；类型 / 批次参数 400；batch_accept 须给本项目批次', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const url = `/sysbuild/projects/${pid}/packages`;
    for (const type of ['overall', 'initiation', 'closing']) {
      const r = await post(U.pm, url, { type });
      assert.strictEqual(r.status, 201, r.text);
      assert.deepStrictEqual(r.body.package, { id: r.body.package.id, project_id: pid, batch_id: null, type });
      expectErr(await post(U.pm, url, { type }), 409, 'SYSBUILD_STATE', `${type} 重复`);
    }
    assert.deepStrictEqual((await payloads(pid, 'package_created')).map((p) => p.type), ['overall', 'initiation', 'closing']);
    // 参数（batch_req / change 已按最终清单在类型校验处拒绝，见「C5 R10」用例）
    const bads = [[{}, 'type', '缺 type'], [{ type: 'overall_batch_req' }, 'type', 'overall_batch_req 已不是包类型（D41）'], [{ type: 'nope' }, 'type', '类型非法'],
      [{ type: 'batch_accept' }, 'batch_id', 'batch_accept 缺批次'], [{ type: 'batch_accept', batch_id: 'x' }, 'batch_id', '批次编号非法'], [{ type: 'overall', batch_id: batch }, 'batch_id', 'overall 不挂批次'],
      [{ type: 'closing', extra: 1 }, 'extra', '多余键']];
    for (const [body, field, label] of bads) {
      const rr = await post(U.pm, url, body);
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, field, `${label} 的 field`);
    }
    expectBodyNotObject(await post(U.pm, url, []), '数组请求体');
    // batch_accept 缺批次：提示的是「必须指定批次」，不是批次编号不合法（后者说明必填检查被删、由编号解析顶替了）
    assert.ok((await post(U.pm, url, { type: 'batch_accept' })).body.message.includes('必须指定批次'), 'batch_accept 缺批次的提示');
    // batch_accept：他项目 / 不存在的批次 400；本项目批次成功；同批第二个 409；已转出 / 被替代的批次 409（夹具）
    const other = await newProject();
    const foreignBatch = await defaultBatchId(other);
    // 预筛 LOW-2：别项目的批次上已经有验收包时，也只能得到和「批次不存在」一样的 400，不能因为「已有同类型包」报 409 而泄露别处的情况
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${other}/packages`, { type: 'batch_accept', batch_id: foreignBatch })).status, 201);
    const leak = await post(U.pm, url, { type: 'batch_accept', batch_id: foreignBatch });
    expectErr(leak, 400, 'SYSBUILD_INVALID_INPUT', '他项目的批次（该批次上已有验收包）');
    assert.strictEqual(leak.body.field, 'batch_id');
    expectErr(await post(U.pm, url, { type: 'batch_accept', batch_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '批次不存在');
    const acc = await post(U.pm, url, { type: 'batch_accept', batch_id: batch });
    assert.strictEqual(acc.status, 201, acc.text);
    assert.strictEqual(acc.body.package.batch_id, batch);
    expectErr(await post(U.pm, url, { type: 'batch_accept', batch_id: batch }), 409, 'SYSBUILD_STATE', '同批第二个验收包');
    const live = await fixtureBatch(pid, 'planning');
    assert.strictEqual((await post(U.pm, url, { type: 'batch_accept', batch_id: live })).status, 201, '别的批次可以有自己的验收包');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_packages WHERE project_id = ?', [pid])).n, 5, '3 个项目级包 + 2 个验收包');
  });

  test('C3b 包创建：权限与项目状态——一般成员 / 只读账号 / admin 未接管 403；非成员 404；暂停可建；终止 409', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const url = `/sysbuild/projects/${pid}/packages`;
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) expectErr(await post(uid, url, { type: 'overall' }), 403, 'SYSBUILD_FORBIDDEN', label);
    expectErr(await post(U.out, url, { type: 'overall' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, url, { type: 'overall' })).status, 201, '暂停可建');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, url, { type: 'initiation' }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_packages WHERE project_id = ?', [pid])).n, 1);
  });

  // ── 5 包版本 ─────────────────────────────────────────────────────────────────────────────────────
  test('C3b 包版本：首个草稿；已有草稿再建 409；包有待确认版本也 409（夹具）；单批与多批 form 均为 overall_batch_req；其他包 form 为空', async () => {
    const pid = await newProject();
    const pkO = await mkPackage(pid, 'overall');
    const r = await post(U.pm, `/sysbuild/packages/${pkO}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.version, { id: r.body.version.id, package_id: pkO, version_no: 1, status: 'draft', form: 'overall_batch_req', parent_overall_version_id: null });
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, 'copied_items'), '响应没有 copied_items（#212 C7：条目集合没有了）');
    const row = await sqlGet('SELECT version_no, status, form, snapshot_json, created_by, effective_at FROM sysbuild_package_versions WHERE id = ?', [r.body.version.id]);
    assert.deepStrictEqual(row, { version_no: 1, status: 'draft', form: 'overall_batch_req', snapshot_json: '{}', created_by: U.pm, effective_at: null });
    assert.deepStrictEqual((await payloads(pid, 'package_version_created'))[0], { package_id: pkO, version_no: 1, form: 'overall_batch_req', parent_overall_version_id: null });
    // S4：已有草稿再建
    expectErr(await post(U.pm, `/sysbuild/packages/${pkO}/versions`), 409, 'SYSBUILD_STATE', '已有草稿');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_versions WHERE package_id = ?', [pkO])).n, 1);
    // 夹具：包有待确认版本也拒绝（此时没有草稿，只违反「待确认」这条）
    await setVerStatus(r.body.version.id, 'pending');
    expectErr(await post(U.pm, `/sysbuild/packages/${pkO}/versions`), 409, 'SYSBUILD_STATE', '夹具：已有待确认版本');
    // 版本被替代（夹具）之后可以再建草稿，form 仍随批次数；总体规划已生效时不能建（D1，见专门用例）
    await setVerStatus(r.body.version.id, 'superseded');
    const r2 = await post(U.pm, `/sysbuild/packages/${pkO}/versions`);
    assert.strictEqual(r2.status, 201, r2.text);
    assert.deepStrictEqual([r2.body.version.version_no, r2.body.version.form], [2, 'overall_batch_req']);
    // 多批夹具也使用合并形态。
    const pid2 = await newProject();
    const pk2 = await mkPackage(pid2, 'overall');
    await fixtureBatch(pid2, 'planning');
    const v = await post(U.pm, `/sysbuild/packages/${pk2}/versions`);
    assert.strictEqual(v.status, 201, v.text);
    assert.strictEqual(v.body.version.form, 'overall_batch_req');
    // 其他包的版本 form 为空，parent 为空
    const pkI = await mkPackage(pid, 'initiation');
    const iv = await post(U.pm, `/sysbuild/packages/${pkI}/versions`);
    assert.deepStrictEqual([iv.body.version.form, iv.body.version.parent_overall_version_id], [null, null]);
    const pkC = await mkPackage(pid, 'closing');
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pkC}/versions`)).body.version.form, null);
  });

  test('C3b 包版本：批次验收包的 parent_overall_version_id = 当前生效的总体规划版本（经生产路径生效；验收包版本置已替代为夹具；没有则空）', async () => {
    await mkSiblingEffectiveOverall(); // 兄弟项目有生效版本：本项目的 parent 不得取到它
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const pkA = await mkPackage(pid, 'batch_accept', batch);
    const first = await post(U.pm, `/sysbuild/packages/${pkA}/versions`);
    assert.strictEqual(first.status, 201, first.text);
    assert.deepStrictEqual([first.body.version.form, first.body.version.parent_overall_version_id], [null, null], '还没有生效的总体规划版本');
    const pkO = await mkPackage(pid, 'overall');
    const pvO = await mkVersion(pkO);
    expectErr(await post(U.pm, `/sysbuild/packages/${pkA}/versions`), 409, 'SYSBUILD_STATE', '验收包已有草稿');
    await setVerStatus(first.body.version.id, 'superseded');
    const stillNone = await post(U.pm, `/sysbuild/packages/${pkA}/versions`);
    assert.strictEqual(stillNone.body.version.parent_overall_version_id, null, '总体规划版本还是草稿：不算生效');
    await setVerStatus(stillNone.body.version.id, 'superseded');
    // C4a 交接 ②：总体规划版本经生产路径生效（补需求部门参与方 + 提交 + 全部确认）
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    const { pk: pkI } = await T.confirm.produceEffectiveInitiation(pid); // P37：总体规划包提交前须立项包已生效（同样走生产路径）
    await T.confirm.planAllNodes(pid); // 修订批三 H-1：总体规划包提交前节点计划须齐全
    await T.confirm.prepareBasisVersion(pvO);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pvO}/submit`)).status, 200);
    await T.confirm.confirmAll(pvO);
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [pvO])).status, 'effective');
    const withParent = await post(U.pm, `/sysbuild/packages/${pkA}/versions`);
    assert.strictEqual(withParent.body.version.parent_overall_version_id, pvO);
    assert.strictEqual((await payloads(pid, 'package_version_created')).pop().parent_overall_version_id, pvO);
    // 立项包的版本不带 parent（即使总体规划版本已生效）；立项包在上面已建好并生效，这里在它上面再出一个草稿版本
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pkI}/versions`)).body.version.parent_overall_version_id, null);
    // C6a：结项包与批次验收包一样「只引用结项时的现行版本」，parent = 当前生效的总体规划版本（建草稿与提交时都按现行版本重写）；原先「结项包不带 parent」的断言随契约改为引用现行版本
    const pkC = await mkPackage(pid, 'closing');
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pkC}/versions`)).body.version.parent_overall_version_id, pvO);
  });

  test('C3b 包版本：新草稿继承上一版本（最大 version_no）的 snapshot（夹具：上一版本置已替代）；响应与事件没有 copied_items（#212 C7：条目集合没有了，原「集合继承」断言随之删除）', async () => {
    const pid = await newProject();
    const pk = await mkPackage(pid, 'overall');
    const pv1 = await mkVersion(pk);
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv1}`, { snapshot_json: { 说明: '第一版文案', 材料: ['a'] } })).status, 200);
    await setVerStatus(pv1, 'superseded'); // 夹具：总体规划已生效时不能直接建草稿（D1），继承逻辑用「上一版本已被替代」的状态验证
    const r = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    const pv2 = r.body.version.id;
    assert.ok(!Object.prototype.hasOwnProperty.call(r.body, 'copied_items'), '响应没有 copied_items');
    assert.deepStrictEqual(Object.keys((await payloads(pid, 'package_version_created'))[1]).sort(), ['form', 'package_id', 'parent_overall_version_id', 'version_no'], '事件没有 copied_items');
    // snapshot_json 同样继承上一版本（预筛裁定：与原集合继承取同一个「上一版本」）
    const snapOf = async (vid) => JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [vid])).snapshot_json);
    assert.deepStrictEqual(await snapOf(pv2), { 说明: '第一版文案', 材料: ['a'] }, '新草稿继承上一版本的 snapshot_json');
    // 以最大 version_no 的版本为准：pv2 里改文案，pv2 被替代后，pv3 继承 pv2 的 snapshot
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv2}`, { snapshot_json: { 说明: '第二版文案' } })).status, 200);
    await setVerStatus(pv2, 'superseded');
    const r3 = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
    assert.strictEqual(r3.status, 201, r3.text);
    assert.deepStrictEqual(await snapOf(r3.body.version.id), { 说明: '第二版文案' }, '继承的是最大 version_no 的版本（不是第一版）');
    // 立项包的新版本响应也不返回 copied_items。
    const pkI = await mkPackage(pid, 'initiation');
    const iv1 = await mkVersion(pkI);
    await setVerStatus(iv1, 'superseded');
    assert.ok(!Object.prototype.hasOwnProperty.call((await post(U.pm, `/sysbuild/packages/${pkI}/versions`)).body, 'copied_items'));
  });

  test('C3b 包版本：权限与项目状态（权限先于草稿冲突）——一般成员 / 只读账号 / admin 未接管 403；非成员 404；暂停可建；终止 409；键白名单（夹具：版本置已替代）', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) expectErr(await post(uid, `/sysbuild/packages/${pk}/versions`), 403, 'SYSBUILD_FORBIDDEN', `${label}（包已有草稿，仍是 403）`);
    expectErr(await post(U.out, `/sysbuild/packages/${pk}/versions`), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/packages/99999999/versions'), 404, 'SYSBUILD_NOT_FOUND', '包不存在');
    expectErr(await post(U.pm, '/sysbuild/packages/abc/versions'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    expectErr(await post(U.pm, `/sysbuild/packages/${pk}/versions`, { x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    await setVerStatus(pv, 'superseded');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pk}/versions`)).status, 201, '暂停可建');
    await setVerStatus((await sqlGet('SELECT MAX(id) AS m FROM sysbuild_package_versions WHERE package_id = ?', [pk])).m, 'superseded');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, `/sysbuild/packages/${pk}/versions`), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
  });

  // D1（预筛裁定）：方案核心原则 4「冻结只能经正式变更修改」+ 不变量 2「变更包生效时生成新的完整总体规划版本」。
  test('C3b D1 总体规划已生效（经生产路径生效；结项包 / 验收包生效与总体规划被替代为夹具）：总体规划包不能直接建草稿 409「范围已确认，不能再出新版本」（C5-RC7 / N16），读接口 new_version 为假；立项包 / 结项包 / 验收包的生效版本不受限；被替代而无生效版本时可建', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const { pk: pkO, pv: pv1 } = await T.confirm.produceEffectiveOverall(pid); // C4a 交接 ②：总体规划版本经提交 + 全部确认生效
    const flagOf = async (pkid) => (await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.packages.find((p) => p.id === pkid).actions.new_version;
    const r = await post(U.pm, `/sysbuild/packages/${pkO}/versions`);
    expectErr(r, 409, 'SYSBUILD_STATE', '总体规划已生效');
    assert.strictEqual(r.body.message, '范围已确认，不能再出新版本', `C5 新提示逐字，实际 ${r.body.message}`);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_versions WHERE package_id = ?', [pkO])).n, 1, '被拒绝的请求不出版本');
    assert.strictEqual(await flagOf(pkO), false, '包列表 new_version 随之为假');
    assert.strictEqual((await get(U.pm, `/sysbuild/package-versions/${pv1}`)).body.actions.new_version, false, '版本详情 new_version 随之为假');
    // 其他类型的包：生效版本之后仍可建新草稿。立项包已在上面 produceEffectiveOverall 里经生产路径生效（P37 前置），这里取现成的包，再出新草稿版本走一遍生效
    const pkI = (await sqlGet("SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = 'initiation'", [pid])).id;
    const pkC = await mkPackage(pid, 'closing');
    const pkA = await mkPackage(pid, 'batch_accept', batch);
    for (const [pk, label] of [[pkI, '立项包'], [pkC, '结项包'], [pkA, '验收包']]) {
      const ev = await mkVersion(pk);
      if (pk === pkI) {
        // 立项包经生产路径生效（各需求部门负责人确认）；结项包 / 验收包的提交确认 C5 / C6 起可用，生效仍用夹具
        assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${ev}/submit`)).status, 200);
        await T.confirm.confirmAll(ev);
        assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_package_versions WHERE id = ?', [ev])).status, 'effective');
      } else {
        await setVerStatus(ev, 'effective');
      }
      assert.strictEqual(await flagOf(pk), true, `${label}：生效版本之后 new_version 仍为真`);
      const rr = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
      assert.strictEqual(rr.status, 201, `${label}：生效版本之后可建新草稿 ${rr.text}`);
    }
    // 总体规划包没有生效版本（被替代）时可以建
    await setVerStatus(pv1, 'superseded');
    assert.strictEqual(await flagOf(pkO), true);
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pkO}/versions`)).status, 201, '没有生效版本时可建');
  });

  // 实际上线之后，同一个验收包仍允许新建和编辑草稿，提交继续受批次状态限制。
  test('C3b D2 批次包允许草稿维护：已上线时按包版本自身规则处理', async () => {
    const pid = await newProject();
    const bid = await defaultBatchId(pid);
    await T.confirm.produceEffectiveOverall(pid);
    const { pk, pv: effective } = await T.confirm.readyForGolive(pid, bid);
    await T.confirm.productionGolive(bid);
    const listed = (await get(U.pm, '/sysbuild/projects/' + pid + '/packages')).body.packages.find((p) => p.id === pk);
    assert.strictEqual(listed.actions.new_version, true);
    expectErr(await patch(U.pm, '/sysbuild/package-versions/' + effective, { snapshot_json: {} }), 409, 'SYSBUILD_STATE');
    const pv = await mkVersion(pk);
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv}`, { snapshot_json: { 已上线: true } })).status, 200);
    const { actions } = (await get(U.pm, `/sysbuild/package-versions/${pv}`)).body;
    assert.deepStrictEqual([actions.edit, actions.new_version, actions.submit], [true, false, false]);
    const versions = () => sqlAll('SELECT id, status, snapshot_json FROM sysbuild_package_versions WHERE package_id = ? ORDER BY id', [pk]);
    const before = await versions();
    assert.deepStrictEqual(before.map(({ id, status }) => [id, status]), [[effective, 'effective'], [pv, 'draft']]);
    const submit = await post(U.pm, '/sysbuild/package-versions/' + pv + '/submit');
    expectErr(submit, 409, 'SYSBUILD_STATE');
    assert.strictEqual(submit.body.message, '批次已正式上线，不能再提交批次验收');
    assert.deepStrictEqual(await versions(), before);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_version_id = ?', [pv])).n, 0);
  });

  // LOW-1：嵌套过深的 snapshot 以前会交给数据库、以 500 暴露；字符串值与键名同其它文本入参一样拒收控制字符（保留 \n \r \t）。
  test('C3b snapshot 校验（预筛 LOW-1）：嵌套深度上限 64（对象 / 数组都算）；字符串值与键名拒收控制字符（保留换行回车制表符）；均为 400 field snapshot_json，不是 500', async () => {
    const pid = await newProject();
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    const url = `/sysbuild/package-versions/${pv}`;
    const send = (snap) => patch(U.pm, url, { snapshot_json: snap });
    const nestObj = (levels) => { let o = {}; for (let i = 1; i < levels; i += 1) o = { a: o }; return o; }; // 总共 levels 层容器（含最外层）
    const nestArr = (arrays) => { let a = []; for (let i = 1; i < arrays; i += 1) a = [a]; return { x: a }; }; // 最外层对象 + arrays 层数组
    const stored = async () => JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json);
    // 深度边界：64 层通过，65 层 400
    assert.strictEqual((await send(nestObj(64))).status, 200, '64 层对象通过');
    assert.deepStrictEqual(await stored(), nestObj(64));
    let rr = await send(nestObj(65));
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '65 层对象');
    assert.strictEqual(rr.body.field, 'snapshot_json');
    assert.strictEqual((await send(nestArr(63))).status, 200, '最外层对象 + 63 层数组 = 64 层通过');
    rr = await send(nestArr(64));
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '最外层对象 + 64 层数组 = 65 层');
    assert.strictEqual(rr.body.field, 'snapshot_json');
    assert.deepStrictEqual(await stored(), nestArr(63), '被拒绝的编辑不改库');
    // 控制字符：值（顶层 / 数组元素 / 嵌套对象）与键名
    const bads = [
      [{ 说明: '带\u0000空字符' }, '顶层值含 NUL'],
      [{ 说明: '带\u001f分隔' }, '顶层值含 0x1F'],
      [{ 说明: '带\u007f删除符' }, '顶层值含 DEL'],
      [{ 列表: ['正常', ['嵌套', '带\u0001控制']] }, '数组里的字符串'],
      [{ 外层: { 内层: { 值: '带\u0002控制' } } }, '嵌套对象里的字符串'],
      [{ ['键\u0003名']: '正常值' }, '键名含控制字符'],
      [{ 外层: { ['键\u0004名']: 1 } }, '嵌套对象的键名含控制字符'],
    ];
    for (const [snap, label] of bads) {
      rr = await send(snap);
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, 'snapshot_json', `${label} 的 field`);
    }
    assert.deepStrictEqual(await stored(), nestArr(63), '被拒绝的编辑都不改库');
    // 换行 / 回车 / 制表符保留；数字、布尔、null 不受影响
    const fine = { 说明: '第一行\n第二行\r\n\t缩进', 数: 1.5, 真: true, 空: null, 列表: [1, 'a', { b: '\t' }] };
    assert.strictEqual((await send(fine)).status, 200);
    assert.deepStrictEqual(await stored(), fine);
  });

  // 18 号 L-1：1e400 这类数字解析成 Infinity，JSON.stringify 会把它静默改成 null，保存下来的就不是请求的内容。必须发原始 JSON 文本
  //   （用 JSON.stringify 构造请求体，Infinity 在发出前就被改成 null 了，用例就测不到）。
  test('C3b snapshot 校验（18 号 L-1）：数字必须是有限数——1e400 / -1e400 / 嵌套与数组里的溢出数字 → 400 field snapshot_json，草稿内容不变；有限的极大 / 极小数照常保存', async () => {
    const pid = await newProject();
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    const url = `/sysbuild/package-versions/${pv}`;
    const stored = async () => JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json);
    assert.strictEqual((await patch(U.pm, url, { snapshot_json: { 原内容: 1 } })).status, 200);
    const bads = [
      ['{"snapshot_json":{"x":1e400}}', '顶层 1e400'],
      ['{"snapshot_json":{"x":-1e400}}', '-1e400'],
      ['{"snapshot_json":{"列表":[1,[2,1e999]]}}', '数组里的溢出数字'],
      ['{"snapshot_json":{"a":{"b":{"c":1E+500}}}}', '嵌套对象里的溢出数字'],
    ];
    for (const [text, label] of bads) {
      const rr = await apiRaw(U.pm, 'PATCH', url, text);
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, 'snapshot_json', `${label} 的 field`);
    }
    assert.deepStrictEqual(await stored(), { 原内容: 1 }, '被拒绝的编辑不改库（也没有被悄悄改成 null 保存）');
    const fine = await apiRaw(U.pm, 'PATCH', url, '{"snapshot_json":{"大":1e308,"小":-1e-320,"零":0,"小数":1.5}}');
    assert.strictEqual(fine.status, 200, fine.text);
    assert.deepStrictEqual(await stored(), { 大: 1e308, 小: -1e-320, 零: 0, 小数: 1.5 });
  });

  // D9：项目级 actions.create_package_types = 对每个包类型各调一次 opAllowed('package_create')，与建包端点同源。
  test('C3b D9 包列表 actions.create_package_types：可建的类型随权限 / 项目状态 / 已有的包 / 批次状态变化，且与建包端点的成败逐类型一致', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const typesOf = async (uid, p) => (await get(uid, `/sysbuild/projects/${p || pid}/packages`)).body.actions.create_package_types;
    const batchOf = (p) => defaultBatchId(p);
    // 新项目：PM 四类可建（batch_req 恒不可建 S2，change 恒不可建）
    assert.deepStrictEqual(await typesOf(U.pm), ['initiation', 'overall', 'batch_accept', 'closing']);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) assert.deepStrictEqual(await typesOf(uid), [], label);
    // 逐类型与端点一致：列出的 = 建得成；其余 = 403 / 409
    const sameSource = async (uid, p, label) => {
      const bid = await batchOf(p);
      for (const t of ['initiation', 'overall', 'batch_req', 'batch_accept', 'change', 'closing']) {
        const listed = (await typesOf(uid, p)).includes(t);
        const body = t === 'batch_req' || t === 'batch_accept' ? { type: t, batch_id: bid } : { type: t };
        const res = await post(uid, `/sysbuild/projects/${p}/packages`, body);
        if (listed) assert.strictEqual(res.status, 201, `${label} ${t}：列出了但建不成 ${res.status} ${res.text}`);
        else assert.ok(res.status === 403 || res.status === 409 || (res.status === 400 && res.body.field === 'type' && !['initiation', 'overall', 'batch_accept', 'closing'].includes(t)), `${label} ${t}：没列出但没被 403 / 409 拒绝（最终清单外的类型为 400 field=type） ${res.status} ${res.text}`);
      }
    };
    await sameSource(U.m1, pid, '一般成员');
    await sameSource(U.admin, pid, 'admin 未接管');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_packages WHERE project_id = ?', [pid])).n, 0, '无权的人一个包也建不出来');
    // 建过的类型从列表里消失：先 overall
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${pid}/packages`, { type: 'overall' })).status, 201);
    assert.deepStrictEqual(await typesOf(U.pm), ['initiation', 'batch_accept', 'closing']);
    await sameSource(U.pm, pid, 'PM');
    assert.deepStrictEqual(await typesOf(U.pm), [], '三个项目级包 + 默认批次的验收包都建过之后没有可建类型');
    // 批次级：增加一个批次后验收包重新可建。
    const second = await fixtureBatch(pid, 'live');
    assert.deepStrictEqual(await typesOf(U.pm), ['batch_accept']);
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${pid}/packages`, { type: 'batch_accept', batch_id: second })).status, 201);
    assert.deepStrictEqual(await typesOf(U.pm), []);
    // 暂停仍可建，终止不可
    const p2 = await newProject();
    assert.strictEqual((await setStatus(p2, 'paused')).status, 200);
    assert.deepStrictEqual(await typesOf(U.pm, p2), ['initiation', 'overall', 'batch_accept', 'closing'], '暂停可建');
    assert.strictEqual((await setStatus(p2, 'terminated')).status, 200);
    assert.deepStrictEqual(await typesOf(U.pm, p2), [], '终止后没有可建类型');
    await sameSource(U.pm, p2, '终止后的 PM');
  });

  // ── 7 snapshot 编辑 ────────────────────────────────────────────────────────────────────────────────
  test('C3b snapshot 编辑：草稿可改（整体替换、事件）；非对象 400；序列化后 64KB 边界；多余键 400；非草稿 409 且说明是草稿规则（夹具 pending / effective）', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const pk = await mkPackage(pid, 'initiation');
    const pv = await mkVersion(pk);
    const url = `/sysbuild/package-versions/${pv}`;
    let r = await patch(U.pm, url, { snapshot_json: { 材料: ['授权说明'], 文案: '立项说明' } });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body.version, { id: pv, status: 'draft', snapshot_json: { 材料: ['授权说明'], 文案: '立项说明' } });
    assert.deepStrictEqual(JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json), { 材料: ['授权说明'], 文案: '立项说明' });
    assert.deepStrictEqual((await get(U.pm, url)).body.snapshot_json, { 材料: ['授权说明'], 文案: '立项说明' });
    r = await patch(U.pm, url, { snapshot_json: { a: 1 } });
    assert.deepStrictEqual((await get(U.m1, url)).body.snapshot_json, { a: 1 }, '整体替换，不合并；成员可读');
    const evs = await payloads(pid, 'package_version_edited');
    assert.deepStrictEqual(evs.map((e) => [e.package_id, e.version_no, e.bytes]), [[pk, 1, Buffer.byteLength(JSON.stringify({ 材料: ['授权说明'], 文案: '立项说明' }), 'utf8')], [pk, 1, 7]]);
    // 形态
    for (const [v, label] of [[[1, 2], '数组'], ['abc', '字符串'], [null, 'null'], [7, '数字'], [undefined, '缺失']]) {
      const rr = await patch(U.pm, url, v === undefined ? {} : { snapshot_json: v });
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, 'snapshot_json', label);
    }
    expectErr(await patch(U.pm, url, { snapshot_json: {}, extra: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    expectBodyNotObject(await patch(U.pm, url, []), '数组请求体');
    // 64KB 边界：{"k":"…"} 固定 8 字节外壳
    const exact = await patch(U.pm, url, { snapshot_json: { k: 'x'.repeat(64 * 1024 - 8) } });
    assert.strictEqual(exact.status, 200, `恰好 64KB 通过 ${exact.text.slice(0, 120)}`);
    const over = await patch(U.pm, url, { snapshot_json: { k: 'x'.repeat(64 * 1024 - 7) } });
    expectErr(over, 400, 'SYSBUILD_INVALID_INPUT', '超 64KB 一个字节');
    assert.strictEqual(over.body.field, 'snapshot_json');
    const multibyte = await patch(U.pm, url, { snapshot_json: { k: '汉'.repeat(21846) } });
    expectErr(multibyte, 400, 'SYSBUILD_INVALID_INPUT', '按字节算：21846 个汉字 = 65538 字节');
    assert.strictEqual(JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json).k.length, 64 * 1024 - 8, '被拒绝的请求不改库');
    // 权限
    expectErr(await patch(U.m1, url, { snapshot_json: {} }), 403, 'SYSBUILD_FORBIDDEN', '一般成员');
    expectErr(await patch(U.ro, url, { snapshot_json: {} }), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
    expectErr(await patch(U.admin, url, { snapshot_json: {} }), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
    expectErr(await patch(U.out, url, { snapshot_json: {} }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await patch(U.pm, '/sysbuild/package-versions/99999999', { snapshot_json: {} }), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    // 非草稿（夹具）：说明是草稿规则，不是并发冲突
    for (const st of ['pending', 'effective', 'superseded']) {
      await setVerStatus(pv, st);
      const rr = await patch(U.pm, url, { snapshot_json: { z: st } });
      expectErr(rr, 409, 'SYSBUILD_STATE', `夹具：${st}`);
      assert.ok(rr.body.message.includes('草稿'), `夹具：${st} 的提示应说明只有草稿可改，实际 ${rr.body.message}`);
    }
    assert.strictEqual(JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json).k.length, 64 * 1024 - 8, '非草稿被拒绝后库不变');
    await setVerStatus(pv, 'draft');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await patch(U.pm, url, { snapshot_json: { p: 1 } })).status, 200, '暂停可编辑');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await patch(U.pm, url, { snapshot_json: { t: 1 } }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
  });

  // ── 8 现行版本解析 ───────────────────────────────────────────────────────────────────────────────
  test('C3b 现行版本解析（夹具 effective，含兄弟项目的生效版本）：现行版本 = 本项目唯一生效的总体规划版本，经 GET /projects/:id/packages 的 overall_version_id 与直接调 effectiveOverallVersionId 两个出口读到同一个值；草稿与更新的版本不影响；无生效版本时为空且读不到别的项目的生效版本；非总体规划包不算；两个生效版本被唯一索引拒绝', async () => {
    // #212 C7：原用例同时核条目的 current_version_id / pending_version_ids / committed_batch_id（随条目删除），这里只留「现行 = 唯一生效的总体规划版本」这条规则
    const sibPv = await mkSiblingEffectiveOverall(); // 兄弟项目的生效版本：本项目的解析不得读到它
    const pid = await newProject();
    const { effectiveOverallVersionId } = require(path.join(T.getModuleDir(), 'packages.js'));
    const q = { get: sqlGet, all: sqlAll, run: sqlRun };
    const listed = async () => (await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.overall_version_id;
    // 两个出口同值：读接口与直接调解析函数
    const both = async (expected, label) => {
      assert.strictEqual(await listed(), expected, `${label}（读接口 overall_version_id）`);
      assert.strictEqual(await effectiveOverallVersionId(q, pid), expected, `${label}（直接调 effectiveOverallVersionId）`);
    };
    // 没有任何包：没有现行版本（本项目读不到兄弟项目的生效版本）
    assert.notStrictEqual(sibPv, null, '前置：兄弟项目有生效版本');
    await both(null, `本项目没有任何包，不能读到兄弟项目的生效版本 ${sibPv}`);
    // 草稿不算生效
    const pk = await mkPackage(pid, 'overall');
    const pv1 = await mkVersion(pk);
    await both(null, '草稿版本不算生效');
    // 夹具：先让 v1 暂为已替代，建出草稿 v2（总体规划一旦生效就不能直接建草稿，D1），再把 v1 置为 effective——此时「生效的 v1」与更新的草稿 v2 并存
    await setVerStatus(pv1, 'superseded');
    const pv2 = await mkVersion(pk);
    await setVerStatus(pv1, 'effective');
    await both(pv1, '仍读生效的 v1，不读最新的草稿 v2');
    await setVerStatus(pv2, 'pending');
    await both(pv1, '待确认的 v2 也不影响现行版本');
    // 换成 v2 生效（v1 被替代）：现行版本随之变化
    await setVerStatus(pv1, 'superseded');
    await setVerStatus(pv2, 'effective');
    await both(pv2, 'v2 生效后现行版本切到 v2');
    // 两个版本同时 effective：唯一索引拒绝
    await assert.rejects(setVerStatus(pv1, 'effective'), (e) => e && e.code === 'SQLITE_CONSTRAINT', '同包第二个生效版本（把被替代的 v1 再置为生效）应被唯一索引拒绝');
    // 非总体规划包的生效版本不算：夹具——立项包版本置为生效
    const pkI = await mkPackage(pid, 'initiation');
    const pvI = await mkVersion(pkI);
    await setVerStatus(pvI, 'effective');
    await both(pv2, '立项包的生效版本不是总体规划');
    // 本项目的总体规划都被替代后：没有现行版本，仍不读兄弟项目的
    await setVerStatus(pv2, 'superseded');
    await both(null, '本项目没有生效的总体规划版本时为空，不取兄弟项目的');
  });

  test('C3b 包读接口：项目内包列表（版本、overall_version_id）与版本详情（snapshot、actions）；没有条目数与条目清单（#212 C7）；非成员 404、只读账号可读', async () => {
    await mkSiblingEffectiveOverall(); // 兄弟项目有生效版本：下面「本项目 overall_version_id 为 null」才有判别力
    const pid = await newProject();
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    const pkC = await mkPackage(pid, 'closing');
    let list = await get(U.pm, `/sysbuild/projects/${pid}/packages`);
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.body.overall_version_id, null);
    assert.deepStrictEqual(list.body.packages.map((p) => [p.id, p.type, p.batch_id, p.versions.length, p.actions.new_version]), [[pk, 'overall', null, 1, false], [pkC, 'closing', null, 0, true]]);
    assert.deepStrictEqual(list.body.packages[0].versions.map((v) => [v.id, v.version_no, v.status, v.form]), [[pv, 1, 'draft', 'overall_batch_req']]);
    assert.ok(!Object.prototype.hasOwnProperty.call(list.body.packages[0].versions[0], 'item_count'), '版本行没有 item_count（#212 C7）');
    // C4a 交接 ②：经生产路径生效（需求部门参与方 + 提交 + 全部确认）
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    await T.confirm.produceEffectiveInitiation(pid); // P37：总体规划包提交前须立项包已生效
    await T.confirm.planAllNodes(pid); // 修订批三 H-1：总体规划包提交前节点计划须齐全
    const paired = await T.confirm.prepareBasisVersion(pv);
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    await T.confirm.confirmAll(pv);
    list = await get(U.ro, `/sysbuild/projects/${pid}/packages`);
    assert.strictEqual(list.status, 200, '只读账号可读');
    assert.strictEqual(list.body.overall_version_id, pv);
    assert.ok(list.body.packages.every((p) => p.actions.new_version === false), '只读账号没有任何动作');
    const view = await get(U.ro, `/sysbuild/package-versions/${pv}`);
    assert.strictEqual(view.status, 200, view.text);
    assert.deepStrictEqual(view.body.actions, { edit: false, new_version: false, submit: false, withdraw: false, export_sheet: true }); // C4c：读动作，只读账号可见即真（已生效版本）
    assert.deepStrictEqual(view.body.package, { id: pk, project_id: pid, batch_id: null, type: 'overall' });
    assert.deepStrictEqual([view.body.version.status, view.body.version.form], ['effective', 'overall_batch_req']);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(view.body.version.effective_at), `effective_at 实际 ${view.body.version.effective_at}`);
    assert.ok(!Object.prototype.hasOwnProperty.call(view.body, 'items'), '版本详情没有 items 键（#212 C7）');
    assert.deepStrictEqual(view.body.snapshot_json, { material_version_ids: [paired], text: '本次需要确认的内容及依据' });
    expectErr(await get(U.out, `/sysbuild/projects/${pid}/packages`), 404, 'SYSBUILD_NOT_FOUND', '非成员列表');
    expectErr(await get(U.out, `/sysbuild/package-versions/${pv}`), 404, 'SYSBUILD_NOT_FOUND', '非成员详情');
    expectErr(await get(U.pm, '/sysbuild/package-versions/99999999'), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    expectErr(await get(U.pm, '/sysbuild/package-versions/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
  });

  // ── 9 actions 同源 ───────────────────────────────────────────────────────────────────────────────
  test('C3b actions 与执行同源：对每个视角（PM / 一般成员 / 其他成员 / 只读账号 / admin）、每个项目状态与包版本状态，读接口的每个标志与实际调用的成败一致（夹具：版本状态直接改写；#212 C7 起没有条目 / 模块 / 条目集合修订动作列）', async () => {
    const seen = { true: 0, false: 0 };
    const check = (label, flag, res) => {
      if (flag) assert.ok(res.status === 200 || res.status === 201, `${label}: 标志为真但执行失败 ${res.status} ${res.text}`);
      else assert.ok(res.status === 403 || res.status === 409, `${label}: 标志为假但执行不是 403 / 409：${res.status} ${res.text}`);
      seen[flag] += 1;
    };
    const plans = [['active', ['draft', 'pending', 'effective']], ['paused', ['draft']], ['terminated', ['draft']]];
    for (const [projectStatus, states] of plans) {
      const pid = await newProject();
      await addMember(pid, U.m1);
      await addMember(pid, U.m2);
      const pkO = await mkPackage(pid, 'overall');
      const pkI = await mkPackage(pid, 'initiation');
      const pkC = await mkPackage(pid, 'closing');
      const pvO = await mkVersion(pkO);
      const pvI = await mkVersion(pkI);
      if (projectStatus !== 'active') assert.strictEqual((await setStatus(pid, projectStatus)).status, 200);
      for (const st of states) {
        await setVerStatus(pvO, st);
        for (const [uid, who] of [[U.pm, 'PM'], [U.m1, '一般成员'], [U.m2, '其他成员'], [U.ro, '只读账号'], [U.admin, 'admin']]) {
          const L = `${projectStatus}/${st}/${who}`;
          // 内容包版本
          for (const [pv, pk, pkgType] of [[pvO, pkO, 'overall'], [pvI, pkI, 'initiation']]) {
            const view = (await get(uid, `/sysbuild/package-versions/${pv}`)).body;
            const A = view.actions;
            check(`${L} ${pkgType} edit`, A.edit, await patch(uid, `/sysbuild/package-versions/${pv}`, { snapshot_json: { n: nameSeq += 1 } }));
            if (pv === pvO) check(`${L} ${pkgType} new_version`, A.new_version, await post(uid, `/sysbuild/packages/${pk}/versions`));
            if (pv === pvO) await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?', [pk, pvO]);
          }
          // 包列表里的 new_version：总体规划包（草稿 / 待确认 / 生效三种状态各不同）与结项包（没有任何版本）
          const listed = (await get(uid, `/sysbuild/projects/${pid}/packages`)).body.packages;
          check(`${L} 列表 overall new_version`, listed.find((p) => p.id === pkO).actions.new_version, await post(uid, `/sysbuild/packages/${pkO}/versions`));
          await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?', [pkO, pvO]);
          check(`${L} 列表 closing new_version`, listed.find((p) => p.id === pkC).actions.new_version, await post(uid, `/sysbuild/packages/${pkC}/versions`));
          await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ?', [pkC]);
        }
      }
    }
    assert.ok(seen.true > 5 && seen.false > 50, `两种结果都要覆盖到：${JSON.stringify(seen)}`);
  });

  // ── C7 H-1：材料自身的绑定与冻结散列一致性。跨来源的散列比较由 L1 的送审范围用例另测。──
  test('C7 H-1：材料绑定附件的散列与冻结清单不一致——总体规划包草稿选入带附件的材料版本，附件现值的散列被改动（夹具）后提交 500 SYSBUILD_INTERNAL「内部错误：材料附件与其冻结清单不一致」，版本仍是草稿、没有任务 / 冻结行 / 提交事件；散列一致时同一请求 200（对照）', async () => {
    const pid = await newProject();
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    await T.confirm.seedEffectiveInitiation(pid);
    const node = await sqlGet("SELECT id FROM sysbuild_nodes WHERE project_id = ? AND template_key = 'p_initiation'", [pid]);
    const att = await T.confirm.stageAtt(pid, U.pm, 'd');
    const m = await post(U.pm, `/sysbuild/nodes/${node.id}/materials/h1-evidence/versions`, { name: '评估依据', body: '评估时的冻结材料', attachment_ids: [att] });
    assert.strictEqual(m.status, 201, m.text);
    const mid = m.body.version.id;
    const pv = await mkVersion(await mkPackage(pid, 'overall'));
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv}`, { snapshot_json: { material_version_ids: [mid] } })).status, 200);
    await T.confirm.prepareBasisVersion(pv);
    await T.confirm.planAllNodes(pid);
    // 前置：材料冻结行的散列 = 附件当前散列（'d' × 64）
    assert.strictEqual((await sqlGet("SELECT sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'material_version' AND object_version_id = ? AND attachment_id = ?", [mid, att])).sha256, 'd'.repeat(64));
    const snap = () => sqlGet("SELECT (SELECT COUNT(*) FROM sysbuild_confirm_tasks WHERE object_type = 'package_version' AND object_version_id = ?) AS tasks, (SELECT COUNT(*) FROM sysbuild_frozen_attachments WHERE object_type = 'package_version' AND object_version_id = ?) AS frozen, (SELECT COUNT(*) FROM sysbuild_events WHERE project_id = ? AND event_type = 'package_version_submitted') AS events, (SELECT status FROM sysbuild_package_versions WHERE id = ?) AS status", [pv, pv, pid, pv]);
    // 附件现值的散列被改（夹具：直接写库）→ 绑定附件与冻结清单对不上
    await sqlRun('UPDATE sysbuild_attachments SET sha256 = ? WHERE id = ?', ['e'.repeat(64), att]);
    const bad = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    expectErr(bad, 500, 'SYSBUILD_INTERNAL', '材料附件散列与冻结清单不一致');
    assert.strictEqual(bad.body.message, '内部错误：材料附件与其冻结清单不一致');
    assert.deepStrictEqual(await snap(), { tasks: 0, frozen: 0, events: 0, status: 'draft' }, '被拒的提交不留任务 / 冻结行 / 事件，版本仍是草稿');
    // 对照：散列恢复一致后同一请求通过
    await sqlRun('UPDATE sysbuild_attachments SET sha256 = ? WHERE id = ?', ['d'.repeat(64), att]);
    const ok = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await snap()).status, 'pending');
  });

}

// ── 变异（锚点必须在被测文件副本里恰好出现一次）──────────────────────────────────────────────────
const PACKAGE_MUTATIONS = [
  // 包创建
  { id: 'C3b 包唯一性预查删掉（项目级）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "return !!(await q.get('SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = ?', [pid, type]));", to: 'return false;' }] },
  { id: 'C3b 包唯一性预查删掉（批次级）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));", to: 'return false;' }] },
  // LOW-2：预查不限本项目批次 → 别项目批次上有验收包时 409 泄露（目标用例是包创建里「他项目的批次（该批次上已有验收包）」那一段）
  { id: 'C3b 验收包预查不限本项目批次（别项目批次上的验收包被探测到）', expect: ['C3b 包创建：overall'], edits: [{ file: 'packages.js', from: "return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));", to: "return !!(batchId !== null && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));" }] },
  { id: 'C3b 包唯一性的 state 判定删掉', expect: ['C3b 包创建：'], edits: [{ file: 'rules.js', from: "if (t.exists) return '该项目（或该批次）已有同类型的内容包，每个只能有一个';", to: '' }] },
  { id: 'C3b 验收包的批次不查是否属本项目', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, pid]);", to: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND ? IS NOT NULL', [batchId, pid]);" }] },
  { id: 'C3b 验收包不要求批次', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (!givenBatch) throw invalid('该类型的内容包必须指定批次', 'batch_id');", to: '' }] },
  { id: 'C3b 非批次包带批次不拒', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "} else if (givenBatch) {\n      throw invalid('该类型的内容包不挂批次', 'batch_id');\n    }", to: '}' }] },
  { id: 'C3b 包类型不查枚举（overall_batch_req 可建）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (typeof body.type !== 'string' || !rules.PACKAGE_TYPES_FINAL.includes(body.type)) {", to: "if (typeof body.type !== 'string') {" }] },
  { id: 'C3b 建包端点放过多余键', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "onlyKeys(body, ['type', 'batch_id']);", to: '' }] },
  { id: 'C3b 建包权限放宽为 PM 或 admin', expect: ['C3b 包创建：权限'], edits: [{ file: 'rules.js', from: "  package_create: Object.freeze({\n    can: canActAsPm,", to: "  package_create: Object.freeze({\n    can: (identity) => !identity.isReadonly && (identity.isPm || identity.isAdmin)," }] },
  // 包版本
  { id: 'C3b S4 删掉（已有草稿可再建）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'rules.js', from: "if (t.hasDraft) return '该内容包已有草稿版本，请先在草稿上修改';", to: '' }] },
  { id: 'C3b 已有待确认版本仍可建新草稿', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'rules.js', from: "return t.hasPending ? '该内容包已有待确认的版本，请等待处理后再建新版本' : null;", to: 'return null;' }] },
  { id: 'C3b 草稿判定漏看（hasDraft 恒假）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "hasDraft: versions.some((v) => v.status === 'draft')", to: 'hasDraft: false' }] },
  { id: 'C3b 待确认判定漏看（hasPending 恒假）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "hasPending: versions.some((v) => v.status === 'pending')", to: 'hasPending: false' }] },
  { id: 'C3b form 判定反转', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "const form = pkg.type === 'overall' ? 'overall_batch_req' : null;", to: "const form = pkg.type === 'overall' ? 'overall' : null;" }] },
  { id: 'C3b form 对其他包也填写', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "const form = pkg.type === 'overall' ? 'overall_batch_req' : null;", to: "const form = 'overall_batch_req';" }] },
  { id: 'C3b parent 对总体规划包也填写', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (true) parentId =' }] }, // C6a：锚点随结项包也取 parent 改写
  { id: 'C3b parent 不填（批次包的父版本丢失）', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (false) parentId =' }] },
  { id: 'C6a parent 不对结项包填写（结项包引用结项时的现行版本丢失）', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (pkg.batch_id !== null) parentId =' }] },
  { id: 'C3b 继承取第一个版本而不是最大 version_no', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: 'const prev = versions.length > 0 ? versions[versions.length - 1] : null;', to: 'const prev = versions.length > 0 ? versions[0] : null;' }] },
  { id: 'C3b 新版本号固定为 1', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: 'const versionNo = prev ? prev.version_no + 1 : 1;', to: 'const versionNo = 1;' }] },
  { id: 'C3b 建版本端点放过多余键', expect: ['C3b 包版本：权限'], edits: [{ file: 'packages.js', from: "const pkid = readIdParam(req.params.pkid, 'pkid', '内容包编号');\n    onlyKeys(bodyOf(req), []);", to: "const pkid = readIdParam(req.params.pkid, 'pkid', '内容包编号');" }] },
  { id: 'C3b 建版本权限放宽为 PM 或 admin', expect: ['C3b 包版本：权限'], edits: [{ file: 'rules.js', from: "  package_version_create: Object.freeze({\n    can: canActAsPm,", to: "  package_version_create: Object.freeze({\n    can: (identity) => !identity.isReadonly && (identity.isPm || identity.isAdmin)," }] },
  // snapshot
  { id: 'C3b snapshot 的草稿状态规则删掉（SQL 条件仍在，提示变成「状态已变化」）', expect: ['C3b snapshot 编辑'], edits: [{ file: 'rules.js', from: "const draftVersionState = (t) => (t.versionStatus === 'draft' ? null : '只有草稿版本可以修改');", to: 'const draftVersionState = () => null;' }] },
  { id: 'C3b snapshot 大小上限放宽', expect: ['C3b snapshot 编辑'], edits: [{ file: 'packages.js', from: 'const SNAPSHOT_MAX_BYTES = 64 * 1024;', to: 'const SNAPSHOT_MAX_BYTES = 640 * 1024;' }] },
  { id: 'C3b snapshot 大小按字符数而不是字节数', expect: ['C3b snapshot 编辑'], edits: [{ file: 'packages.js', from: "const bytes = Buffer.byteLength(text, 'utf8');", to: 'const bytes = text.length;' }] },
  { id: 'C3b snapshot 边界改成 >=', expect: ['C3b snapshot 编辑'], edits: [{ file: 'packages.js', from: 'if (bytes > SNAPSHOT_MAX_BYTES) throw', to: 'if (bytes >= SNAPSHOT_MAX_BYTES) throw' }] },
  // C8：材料引用助手独立核快照类型。两个等价数组闸门同时撤掉，验证对外拒绝数组的契约。
  { id: 'C3b snapshot 接受数组', expect: ['C3b snapshot 编辑'], edits: [
    { file: 'packages.js', from: "if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) throw", to: "if (snap === null || typeof snap !== 'object') throw" },
    { file: 'materials-core.js', from: "if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw", to: "if (!raw || typeof raw !== 'object') throw" },
  ] },
  { id: 'C3b snapshot 端点放过多余键', expect: ['C3b snapshot 编辑'], edits: [{ file: 'packages.js', from: "onlyKeys(body, ['snapshot_json']);", to: '' }] },
  { id: 'C3b snapshot 不写事件', expect: ['C3b snapshot 编辑'], edits: [{ file: 'packages.js', from: "await emit(q, user, pkg.project_id, 'package_version', vid, 'package_version_edited', { package_id: pkg.id, version_no: ver.version_no, bytes });", to: '' }] },
  { id: 'C3b snapshot 编辑权限放宽为 PM 或 admin', expect: ['C3b snapshot 编辑'], edits: [{ file: 'rules.js', from: "package_version_edit: Object.freeze({ can: canActAsPm, state: draftVersionState }),", to: 'package_version_edit: Object.freeze({ can: (identity) => !identity.isReadonly && (identity.isPm || identity.isAdmin), state: draftVersionState }),' }] },
  // 解析函数
  { id: 'C3b 解析函数改读最新版本而不是生效版本', expect: ['C3b 现行版本解析'], edits: [{ file: 'packages.js', from: "AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,", to: "AND p.type = 'overall' ORDER BY v.id DESC LIMIT 1`," }] },
  { id: 'C3b 解析函数不限总体规划包', expect: ['C3b 现行版本解析'], edits: [{ file: 'packages.js', from: "AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,", to: "AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`," }] },
  { id: 'C3b 解析函数不限本项目', expect: ['C3b 现行版本解析', 'C3b 包版本：批次验收包的 parent_overall_version_id', 'C3b 包读接口：项目内包列表'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,\n    [projectId]", to: "WHERE ? IS NOT NULL AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,\n    [projectId]" }] },
  // actions 同源
  { id: 'C3b actions.edit 不看版本状态（改用 item_set_module 判定）', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "edit: rules.opAllowed('package_version_edit', access, access.project, t),", to: "edit: rules.opAllowed('package_create', access, access.project, t)," }] }, // #212 C7（M354）：原 to 引用 item_set_module（规则键随条目流程删除），换成另一个不检查版本状态的保留规则键 package_create
  { id: 'C3b actions.new_version（版本详情）忽略已有草稿', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus)),\n    };", to: "new_version: rules.opAllowed('package_version_create', access, access.project, { hasDraft: false, hasPending: false }),\n    };" }] },
  { id: 'C3b actions.new_version（包列表）忽略已有草稿', expect: ['C3b actions 与执行同源', 'C3b 包读接口'], edits: [{ file: 'packages.js', from: "actions: { new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(vrows, pkg, await batchStatusOf(q, pkg))) },", to: "actions: { new_version: rules.opAllowed('package_version_create', access, access.project, { hasDraft: false, hasPending: false }) }," }] },
  // 项目状态类别（OP_KIND）：每个新动作改成「已终止也允许」的 resolve 类，终止后的 409 用例必须判红
  { id: 'C3b OP_KIND package_create 记成 resolve', expect: ['C3b 包创建：权限'], edits: [{ file: 'rules.js', from: "  package_create: 'maintain',", to: "  package_create: 'resolve'," }] },
  { id: 'C3b OP_KIND package_version_create 记成 resolve', expect: ['C3b 包版本：权限'], edits: [{ file: 'rules.js', from: "  package_version_create: 'maintain',", to: "  package_version_create: 'resolve'," }] },
  { id: 'C3b OP_KIND package_version_edit 记成 resolve', expect: ['C3b snapshot 编辑'], edits: [{ file: 'rules.js', from: "  package_version_edit: 'maintain',", to: "  package_version_edit: 'resolve'," }] },
  // 其余键白名单 / 请求体形态
  { id: 'C3b packages.js 的 bodyOf 放过数组请求体', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (typeof b !== 'object' || Array.isArray(b)) throw invalid(", to: 'if (false) throw invalid(' }] },

  // ── 第二批（预筛修订）：每条只删一处，expect 指向目标用例（跑完核对命中的用例名）──────────────────────────────────────
  // D1
  { id: 'C3b D1 总体规划已生效的拒绝删掉', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.hasEffective) return '范围已确认，不能再出新版本';", to: '' }] },
  { id: 'C3b D1 对所有包生效后都拒绝（不限总体规划包）', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.hasEffective) return", to: 'if (t.hasEffective) return' }] },
  { id: 'C3b D1 hasEffective 恒假', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'packages.js', from: "hasEffective: versions.some((v) => v.status === 'effective'),", to: 'hasEffective: false,' }] },
  // D2
  { id: 'C3b D2 取不到批次包所在批次的状态', expect: ['C6a 上线：批次验收包提交'], edits: [{ file: 'packages.js', from: 'if (pkg.batch_id === null) return undefined;', to: 'return undefined;' }] },
  { id: 'C3b D2 版本详情的标志不带批次状态', expect: ['C6a 上线：批次验收包提交'], edits: [{ file: 'packages.js', from: 'const t = versionTarget(ver, pkg, batchStatus, facts);\n    return {', to: 'const t = versionTarget(ver, pkg, undefined, facts);\n    return {' }] },
  // 执行者没把握 3：snapshot 继承
  {"id":"C3b 新草稿不继承上一版本的 snapshot","expect":["C3b 包版本：新草稿继承"],"edits":[{"file":"packages.js","from":"let prevSnapshot = prev ? (await q.get('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [prev.id])).snapshot_json : '{}';","to":"let prevSnapshot = '{}';"}]},
  { id: 'C3b snapshot 继承取第一个版本而不是最大 version_no', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: "WHERE id = ?', [prev.id])).snapshot_json", to: "WHERE id = ?', [versions[0].id])).snapshot_json" }] },
  // LOW-1
  { id: 'C3b snapshot 嵌套深度上限放宽到 640', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'const SNAPSHOT_MAX_DEPTH = 64;', to: 'const SNAPSHOT_MAX_DEPTH = 640;' }] },
  { id: 'C3b snapshot 嵌套深度检查删掉', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (depth > SNAPSHOT_MAX_DEPTH) throw invalid(`snapshot_json 嵌套不能超过 ${SNAPSHOT_MAX_DEPTH} 层`, 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 不递归数组元素', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'for (const x of v) checkSnapshotValue(x, depth + 1);', to: '' }] },
  { id: 'C3b snapshot 不递归对象的值', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'checkSnapshotValue(v[k], depth + 1);', to: '' }] },
  { id: 'C3b snapshot 字符串值不拒控制字符', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (rules.hasControlChar(v)) throw invalid('snapshot_json 的文本不能包含控制字符', 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 键名不拒控制字符', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (rules.hasControlChar(k)) throw invalid('snapshot_json 的键名不能包含控制字符', 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 不做递归检查', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'checkSnapshotValue(snap, 1);', to: '' }] },
  // LOW-5
  { id: 'C3b 附件视图缺 masked_at', expect: ['C4a 浏览：'], edits: [{ file: 'attachments.js', from: 'masked_at: att.masked_at, masked_by: att.masked_by,', to: 'masked_by: att.masked_by,' }] },
  { id: 'C3b 附件视图缺 masked_by', expect: ['C4a 浏览：'], edits: [{ file: 'attachments.js', from: ' masked_by: att.masked_by,', to: '' }] },
  { id: 'C3b 附件视图缺 mask_reason', expect: ['C4a 浏览：'], edits: [{ file: 'attachments.js', from: ' mask_reason: att.mask_reason,', to: '' }] },
  { id: 'C3b 附件视图缺 deleted_at', expect: ['C4a 浏览：', 'C3b 读接口：附件视图的删除信息'], edits: [{ file: 'attachments.js', from: ' deleted_at: att.deleted_at,', to: '' }] },
  { id: 'C3b 附件视图缺 deleted_by', expect: ['C4a 浏览：', 'C3b 读接口：附件视图的删除信息'], edits: [{ file: 'attachments.js', from: ' deleted_by: att.deleted_by,', to: '' }] },
  // D9
  { id: 'C3b D9 项目级包类型的 exists 不查', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: 'const exists = await packageExists(q, pid, type, null, null);', to: 'const exists = false;' }] },
  { id: 'C3b D9 批次类型的 exists 不查', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: 'const exists = await packageExists(q, pid, type, b.id, b);', to: 'const exists = false;' }] },
  { id: 'C3b D9 项目级类型不调 opAllowed（只看 exists）', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: "can = rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: undefined });", to: 'can = !exists;' }] },
  { id: 'C3b D9 批次类型不调 opAllowed（只看 exists）', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: "if (rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: b.status })) can = true;", to: 'if (!exists) can = true;' }] },
  // ── 第三批（codex 18 号）：下面三条只登记、本批不跑，随之后的子集补跑一起跑 ──
  { id: 'C3b 18号 L-1 snapshot 数字不查有限性', expect: ['C3b snapshot 校验（18 号 L-1）'], edits: [{ file: 'packages.js', from: "if (!Number.isFinite(v)) throw invalid('snapshot_json 的数字必须是有限数', 'snapshot_json');", to: '' }] },
  // ── #212 C7 新增（H-1）：覆盖材料本身的冻结散列比较 ──
  { id: 'C7 H-1：材料冻结清单散列比对去掉（materials-core.js:71）', expect: ['C7 H-1：材料绑定附件的散列与冻结清单不一致'], edits: [{ file: 'materials-core.js', from: '|| a.sha256 !== frozen[i].sha256', to: '' }] },
];

module.exports = { definePackageCases, PACKAGE_MUTATIONS };
