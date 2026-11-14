// 验证脚本库：项目管理（系统建设记录）模块 C3b——模块、需求条目与版本、内容包与版本（草稿期）、条目集合修订、现行版本解析、附件沿用（#113 段 3 N-S2）的用例
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261030_v1.2.md §2.2 / §2.3 / §4.1 / §4.5 / §5.2 / §6.2 / §6.3 / §7 / §10.3
//   派单：docs/local/系统建设记录/送审准备/C3b_模块条目内容包_派单_20261030.md §4
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 的 defineCases() 末尾调用 defineItemCases(T) 登记（同一套夹具、同一个变异自检）。
//   T = 套件注入的夹具与助手。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects，建模块 / 条目 / 包 / 版本 / 集合修订都走生产端点。只有 C3b 无法经生产路径到达的状态直接写库，并在用例名里标「夹具」：
//   ① 总体规划版本 effective——C4a 起，能经生产路径到达的（兄弟项目生效版本、验收包 parent、D1 的总体规划 / 立项包、包读接口）已改走「提交 + 全部确认」；
//   仍用夹具的是生产路径到不了的状态：总体规划版本被替代、生效后再回到生效、结项包 / 验收包生效、版本状态在 draft / pending / effective 间来回切换的矩阵用例；
//   ② 包版本 pending；③ 第二个批次 / 已转出 / 被替代批次（C3 没有建批次端点）；
//   ④ 附件的遮蔽 / 软删除状态与「只引用不绑定」的引用行（附件端点有专门的验证脚本，这里只需要这些状态）。
'use strict';
const assert = require('assert');

function defineItemCases(T) {
  const { test, U, api, apiRaw, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty } = T;
  // T.confirm = sysbuild-api-suite-confirm.js 的共用助手（C4a 交接 ②：经生产路径让总体规划 / 立项包版本生效）
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const patch = (uid, url, body) => api(uid, 'PATCH', url, body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  let projSeq = 0;
  let attSeq = 0;
  let nameSeq = 0;
  const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const EV = { no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' };

  async function newProject(buildType, pm) {
    projSeq += 1;
    const r = await post(pm || U.pm, '/sysbuild/projects', { system_name: `条目测试项目${projSeq}`, build_type: buildType || 'inhouse' });
    assert.strictEqual(r.status, 201, r.text);
    return r.body.project.id;
  }
  const defaultBatchId = async (pid) => (await sqlGet('SELECT id FROM sysbuild_batches WHERE project_id = ? AND is_default = 1', [pid])).id;
  const memberIdOf = async (pid, uid) => (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL ORDER BY id LIMIT 1', [pid, uid])).id;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '条目用例' });
  const itemBody = (extra) => Object.assign({ content: '需求：支持按部门导出', proposer_name: '外部张三' }, EV, extra || {});
  const itemsUrl = (pid) => `/sysbuild/projects/${pid}/items`;
  async function createItem(uid, pid, extra) {
    const r = await post(uid, itemsUrl(pid), itemBody(extra));
    assert.strictEqual(r.status, 201, r.text);
    return r.body.item;
  }
  const newVersion = (uid, iid, extra) => post(uid, `/sysbuild/items/${iid}/versions`, Object.assign({ content: '修订后的需求内容' }, EV, extra || {}));
  async function stageAttachment(pid, uid) {
    attSeq += 1;
    const r = await sqlRun(
      "INSERT INTO sysbuild_attachments (project_id, file_name, original_name, mime_type, size, sha256, is_image, uploaded_by) VALUES (?, ?, '证据文件.txt', 'text/plain', 3, ?, 0, ?)",
      [pid, `c3b-${runTag}-${attSeq}.txt`, 'b'.repeat(64), uid]
    );
    return r.lastID;
  }
  const maskAtt = (aid) => sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = 1, mask_reason = '含敏感信息' WHERE id = ?", [aid]);
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
  const revUrl = (vid) => `/sysbuild/package-versions/${vid}/items`;
  const addRev = (uid, vid, itemVersionId, extra) => post(uid, revUrl(vid), Object.assign({ op: 'add', item_version_id: itemVersionId }, extra || {}));
  const removeRev = (uid, vid, itemVersionId) => post(uid, revUrl(vid), { op: 'remove', item_version_id: itemVersionId });
  // 夹具：包版本状态直接改写（pending / effective 无法经 C3b 的生产路径到达，C4 才有提交确认与生效）。
  const setVerStatus = (vid, st) => sqlRun(
    st === 'effective' ? "UPDATE sysbuild_package_versions SET status = 'effective', effective_at = '2026-10-30 10:00:00' WHERE id = ?"
      : `UPDATE sysbuild_package_versions SET status = '${st}', effective_at = NULL WHERE id = ?`,
    [vid]
  );
  // 夹具（P-S0，2026-11-01）：兄弟项目——有一个生效的总体规划版本，条目集合非空。过滤模式下用例单独运行，库里没有别的项目的数据；
  //   凡是在「新项目上断言现行 / 生效的总体规划版本为空」的用例，先调用它，「解析函数不限本项目」这类变异才会让断言判红（以前靠前序用例残留的数据，隐式依赖）。
  //   C4a 交接 ②：改走生产路径（需求部门参与方 + 条目 + 提交 + 全部确认），不再直接改写版本状态。
  async function mkSiblingEffectiveOverall() {
    const sib = await newProject();
    return (await T.confirm.produceEffectiveOverall(sib)).pv;
  }
  // 夹具：直接写第二个及之后的批次（C3 没有建批次端点）。
  async function fixtureBatch(pid, status) {
    const seqNo = (await sqlGet('SELECT MAX(seq) AS m FROM sysbuild_batches WHERE project_id = ?', [pid])).m + 1;
    const r = await sqlRun(
      'INSERT INTO sysbuild_batches (project_id, seq, name, is_default, status, transfer_change_id, superseded_by) VALUES (?, ?, ?, 0, ?, ?, ?)',
      [pid, seqNo, `夹具批次${seqNo}`, status || 'planning', status === 'transferred' ? 1 : null, status === 'superseded' ? 1 : null]
    );
    return r.lastID;
  }
  const eventCount = async (pid, type) => (await eventsOf(pid, type)).length;
  // 数组请求体：必须是「请求体必须是 JSON 对象」这一条（field = body）。只断言 400 不够——去掉 bodyOf 的数组判断后，缺字段的 400 会顶替它。
  const expectBodyNotObject = (r, label) => {
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
    assert.strictEqual(r.body.field, 'body', `${label} 的 field 应为 body（实际 ${JSON.stringify(r.body)}）`);
  };

  // ── 1 模块 ─────────────────────────────────────────────────────────────────────────────────────
  test('C3b 模块：PM 建模块（trim、事件）；同名 409（trim 后比较、大小写敏感、别的项目不冲突）；改名、改成已有名 409、改成自己的名字不变且不写事件', async () => {
    const pid = await newProject();
    const url = `/sysbuild/projects/${pid}/modules`;
    const r = await post(U.pm, url, { name: '  财务模块  ' });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.module.name, '财务模块');
    const mid = r.body.module.id;
    assert.deepStrictEqual(await sqlGet('SELECT project_id, name, created_by FROM sysbuild_modules WHERE id = ?', [mid]), { project_id: pid, name: '财务模块', created_by: U.pm });
    assert.deepStrictEqual(await payloads(pid, 'module_created'), [{ name: '财务模块' }]);
    expectErr(await post(U.pm, url, { name: '财务模块' }), 409, 'SYSBUILD_STATE', '同名');
    expectErr(await post(U.pm, url, { name: ' 财务模块 ' }), 409, 'SYSBUILD_STATE', 'trim 后同名');
    assert.strictEqual((await post(U.pm, url, { name: 'Abc' })).status, 201);
    assert.strictEqual((await post(U.pm, url, { name: 'abc' })).status, 201, '大小写敏感：Abc 与 abc 不同名');
    const other = await newProject();
    assert.strictEqual((await post(U.pm, `/sysbuild/projects/${other}/modules`, { name: '财务模块' })).status, 201, '别的项目同名不冲突');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_modules WHERE project_id = ?', [pid])).n, 3, '被拒绝的请求不留行');
    // 改名
    const m2 = (await post(U.pm, url, { name: '采购模块' })).body.module.id;
    const ok = await patch(U.pm, `/sysbuild/modules/${m2}`, { name: '  采购与合同  ' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.module.name, ok.body.changed], ['采购与合同', true]);
    assert.strictEqual((await sqlGet('SELECT name FROM sysbuild_modules WHERE id = ?', [m2])).name, '采购与合同');
    assert.deepStrictEqual(await payloads(pid, 'module_renamed'), [{ before: '采购模块', after: '采购与合同' }]);
    expectErr(await patch(U.pm, `/sysbuild/modules/${m2}`, { name: '财务模块' }), 409, 'SYSBUILD_STATE', '改成已有名');
    assert.strictEqual((await sqlGet('SELECT name FROM sysbuild_modules WHERE id = ?', [m2])).name, '采购与合同', '被拒绝的改名不改库');
    const same = await patch(U.pm, `/sysbuild/modules/${m2}`, { name: '采购与合同' });
    assert.strictEqual(same.status, 200, '改成自己的名字不算重名');
    assert.strictEqual(same.body.changed, false);
    assert.strictEqual(await eventCount(pid, 'module_renamed'), 1, '没有变化不写事件');
    expectErr(await patch(U.pm, '/sysbuild/modules/99999999', { name: 'x' }), 404, 'SYSBUILD_NOT_FOUND', '模块不存在');
    expectErr(await patch(U.out, `/sysbuild/modules/${m2}`, { name: 'y' }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
  });

  test('C3b 模块：参数校验（空 / 超长 / 非文本 / 控制字符 / 多余键 / 数组体）各 400；60 字边界通过', async () => {
    const pid = await newProject();
    const url = `/sysbuild/projects/${pid}/modules`;
    const bads = [[{}, '缺名称'], [{ name: '   ' }, '空白'], [{ name: 'a'.repeat(61) }, '61 字'], [{ name: 123 }, '非文本'], [{ name: 'a\u0000b' }, 'NUL 控制字符'], [{ name: '好', extra: 1 }, '多余键']];
    for (const [body, label] of bads) {
      const r = await post(U.pm, url, body);
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
    }
    expectBodyNotObject(await post(U.pm, url, []), '数组请求体');
    expectErr(await patch(U.pm, '/sysbuild/modules/abc', { name: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    const target = (await post(U.pm, url, { name: '改名对象' })).body.module.id;
    const extraKey = await patch(U.pm, `/sysbuild/modules/${target}`, { name: '好名字', extra: 1 });
    expectErr(extraKey, 400, 'SYSBUILD_INVALID_INPUT', '改名多余键');
    assert.strictEqual(extraKey.body.field, 'extra');
    expectErr(await patch(U.pm, `/sysbuild/modules/${target}`, { name: 'a'.repeat(61) }), 400, 'SYSBUILD_INVALID_INPUT', '改名 61 字');
    assert.strictEqual((await sqlGet('SELECT name FROM sysbuild_modules WHERE id = ?', [target])).name, '改名对象', '被拒绝的改名不改库');
    assert.strictEqual((await post(U.pm, url, { name: 'a'.repeat(60) })).status, 201, '60 字通过');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_modules WHERE project_id = ?', [pid])).n, 2, '参数错误不留行（只有改名对象与 60 字边界各一行）');
  });

  test('C3b 模块：一般成员 / 只读账号 / admin 未接管 403；非成员 404；暂停可建可改；终止 409 SYSBUILD_PROJECT_READONLY', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const url = `/sysbuild/projects/${pid}/modules`;
    const mid = (await post(U.pm, url, { name: '基础模块' })).body.module.id;
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) {
      expectErr(await post(uid, url, { name: `${label}想建` }), 403, 'SYSBUILD_FORBIDDEN', `${label} 建`);
      expectErr(await patch(uid, `/sysbuild/modules/${mid}`, { name: `${label}想改` }), 403, 'SYSBUILD_FORBIDDEN', `${label} 改名`);
    }
    expectErr(await post(U.out, url, { name: '非成员' }), 404, 'SYSBUILD_NOT_FOUND', '非成员建');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, url, { name: '暂停期新模块' })).status, 201, '暂停可建');
    assert.strictEqual((await patch(U.pm, `/sysbuild/modules/${mid}`, { name: '暂停期改名' })).status, 200, '暂停可改名');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, url, { name: '终止后新模块' }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后建');
    expectErr(await patch(U.pm, `/sysbuild/modules/${mid}`, { name: '终止后改名' }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后改名');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_modules WHERE project_id = ?', [pid])).n, 2);
  });

  // ── 2 条目创建 ───────────────────────────────────────────────────────────────────────────────────
  test('C3b 条目创建：编号 R-01、R-02 连续，超过 99 自然变三位；版本 1 为待提出人确认；事件手写核对；响应带派生字段', async () => {
    const pid = await newProject();
    const a = await createItem(U.pm, pid, { quote_text: '  财务说要能导出  ', occasion: '周会', proposed_on: '2026-10-20' });
    assert.strictEqual(a.code, 'R-01');
    const b = await createItem(U.pm, pid);
    assert.strictEqual(b.code, 'R-02');
    assert.strictEqual(a.versions.length, 1);
    const v = a.versions[0];
    assert.deepStrictEqual([v.version_no, v.proposer_status, v.content, v.quote_text, v.occasion, v.proposed_on, v.proposer_name, v.proposer_member_id, v.proposer_party_id, v.no_written_evidence, v.no_evidence_reason, v.created_by],
      [1, 'pending', '需求：支持按部门导出', '财务说要能导出', '周会', '2026-10-20', '外部张三', null, null, true, '口头电话确认了本次需求内容', U.pm]);
    assert.deepStrictEqual([a.in_effective_plan, a.current_version_id, a.committed_batch_id, a.pending_version_ids, a.module_id], [false, null, null, [], null]);
    assert.deepStrictEqual(a.actions, { new_version: true, set_module: true });
    const evs = await payloads(pid, 'item_created');
    assert.deepStrictEqual(evs[0], { code: 'R-01', module_id: null, item_version_id: v.id, version_no: 1, proposer_member_id: null, proposer_name: '外部张三', proposer_party_id: null, attachment_ids: [], no_written_evidence: true });
    // 跳到 R-99 之后：下一个是 R-100（三位）
    //   夹具：直接写一行 R-99 的条目（原因：经生产路径要登记 97 条才能走到两位变三位的边界，且这一条只为占住编号，不需要版本）。
    await sqlRun("INSERT INTO sysbuild_items (project_id, code, created_by) VALUES (?, 'R-99', ?)", [pid, U.pm]);
    assert.strictEqual((await createItem(U.pm, pid)).code, 'R-100');
    assert.strictEqual((await createItem(U.pm, pid)).code, 'R-101');
    // 编号按项目独立
    const other = await newProject();
    assert.strictEqual((await createItem(U.pm, other)).code, 'R-01');
  });

  test('C3b 条目创建：提出人——成员（参与方自动取）、PM 成员（参与方为空）、无账号提出人（参与方可选）；已移出 / 未加入 / 他项目成员；二选一与组合规则', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '财务部', 'demand');
    const otherParty = await addParty(pid, '人力部', 'demand');
    await addMember(pid, U.m1, { party });
    await addMember(pid, U.m2, { removed: true });
    await addMember(pid, U.cand, { pending: true });
    const m1 = await memberIdOf(pid, U.m1);
    const pmMember = await memberIdOf(pid, U.pm);
    const removedMember = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.m2])).id;
    const pendingMember = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ?', [pid, U.cand])).id;
    const body = (extra) => ({ content: '需求内容', ...EV, ...extra });
    // 成员：参与方取自成员行
    let r = await post(U.pm, itemsUrl(pid), body({ proposer_member_id: m1 }));
    assert.strictEqual(r.status, 201, r.text);
    let v = r.body.item.versions[0];
    assert.deepStrictEqual([v.proposer_member_id, v.proposer_party_id, v.proposer_name], [m1, party, null], '提出人是成员：参与方自动取');
    r = await post(U.pm, itemsUrl(pid), body({ proposer_member_id: pmMember }));
    assert.strictEqual(r.status, 201, r.text);
    v = r.body.item.versions[0];
    assert.deepStrictEqual([v.proposer_member_id, v.proposer_party_id], [pmMember, null], 'PM 成员行没有参与方');
    // 无账号提出人：参与方可选
    r = await post(U.pm, itemsUrl(pid), body({ proposer_name: '  客户代表李四 ', proposer_party_id: otherParty }));
    assert.strictEqual(r.status, 201, r.text);
    v = r.body.item.versions[0];
    assert.deepStrictEqual([v.proposer_member_id, v.proposer_party_id, v.proposer_name], [null, otherParty, '客户代表李四']);
    const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n;
    // 被拒绝的组合
    const foreignPid = await newProject();
    const foreignMember = await memberIdOf(foreignPid, U.pm);
    const foreignParty = await addParty(foreignPid, '外部门', 'demand');
    const rejects = [
      [body({}), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_member_id', '提出人一个都没给'],
      [body({ proposer_member_id: m1, proposer_name: '张三' }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_name', '成员与姓名同时给'],
      [body({ proposer_member_id: m1, proposer_party_id: party }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_party_id', '成员与参与方同时给'],
      [body({ proposer_party_id: party }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_member_id', '只给参与方没有提出人'],
      [body({ proposer_member_id: foreignMember }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_member_id', '他项目成员'],
      [body({ proposer_member_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_member_id', '成员不存在'],
      [body({ proposer_member_id: removedMember }), 409, 'SYSBUILD_STATE', null, '已移出的成员'],
      [body({ proposer_member_id: pendingMember }), 409, 'SYSBUILD_STATE', null, '尚未加入的成员'],
      [body({ proposer_name: '张三', proposer_party_id: foreignParty }), 400, 'SYSBUILD_INVALID_INPUT', 'proposer_party_id', '无账号提出人的参与方是他项目的'],
    ];
    for (const [b, status, code, field, label] of rejects) {
      const rr = await post(U.pm, itemsUrl(pid), b);
      expectErr(rr, status, code, label);
      if (field) assert.strictEqual(rr.body.field, field, `${label} 的 field`);
    }
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, n0, '被拒绝的请求不留条目');
  });

  test('C3b 条目创建：方向类证据——附件 / 无书面证据各一例成功；都没有 400 SYSBUILD_EVIDENCE_REQUIRED；原因不足 10 字；两者互斥；附件在同一事务绑定到版本 1', async () => {
    const pid = await newProject();
    const base = { content: '需求内容', proposer_name: '张三' };
    // 附件
    const att = await stageAttachment(pid, U.pm);
    let r = await post(U.pm, itemsUrl(pid), { ...base, attachment_ids: [att] });
    assert.strictEqual(r.status, 201, r.text);
    const v1 = r.body.item.versions[0];
    assert.deepStrictEqual([v1.no_written_evidence, v1.no_evidence_reason, v1.attachments.map((a) => [a.attachment_id, a.via, a.masked, a.original_name])], [false, null, [[att, 'bound', false, '证据文件.txt']]]);
    assert.deepStrictEqual(await sqlGet('SELECT owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att]), { owner_type: 'item_version', owner_id: v1.id, bound_by: U.pm });
    assert.strictEqual((await payloads(pid, 'item_created'))[0].attachment_ids.length, 1);
    // 事件 payload 不含附件原名（Q8）
    for (const e of await sqlAll("SELECT payload_json FROM sysbuild_events WHERE project_id = ? AND (event_type IN ('item_created','attachment_bound'))", [pid])) {
      assert.ok(!String(e.payload_json).includes('证据文件'), '事件不写附件原名');
    }
    // 无书面证据
    r = await post(U.pm, itemsUrl(pid), { ...base, ...EV });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual([r.body.item.versions[0].no_written_evidence, r.body.item.versions[0].no_evidence_reason], [true, '口头电话确认了本次需求内容']);
    const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n;
    // 都没有
    expectErr(await post(U.pm, itemsUrl(pid), { ...base }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '都没有');
    expectErr(await post(U.pm, itemsUrl(pid), { ...base, attachment_ids: [] }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '空附件列表');
    expectErr(await post(U.pm, itemsUrl(pid), { ...base, no_written_evidence: false }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', 'no_written_evidence=false');
    // 原因不足 10 字 / 声明却无原因
    let rr = await post(U.pm, itemsUrl(pid), { ...base, no_written_evidence: true, no_evidence_reason: '口头说的' });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '原因不足 10 字');
    assert.strictEqual(rr.body.field, 'no_evidence_reason');
    expectErr(await post(U.pm, itemsUrl(pid), { ...base, no_written_evidence: true }), 400, 'SYSBUILD_INVALID_INPUT', '声明无书面证据却无原因');
    // 互斥（真实暂存附件，避免被绑定校验的 400 遮蔽）
    const att2 = await stageAttachment(pid, U.pm);
    rr = await post(U.pm, itemsUrl(pid), { ...base, ...EV, attachment_ids: [att2] });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '附件与无书面证据同时给');
    assert.strictEqual(rr.body.field, 'no_written_evidence');
    rr = await post(U.pm, itemsUrl(pid), { ...base, attachment_ids: [att2], no_evidence_reason: '口头电话确认了本次需求内容' });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '未声明却给原因');
    assert.strictEqual(rr.body.field, 'no_evidence_reason');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att2])).n, 0, '被拒绝的请求不绑定附件');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, n0, '被拒绝的请求不留条目');
    // 附件校验失败整体回滚：他人暂存的附件 / 已用过的附件；编号不被占用
    const theirs = await stageAttachment(pid, U.m1);
    expectErr(await post(U.pm, itemsUrl(pid), { ...base, attachment_ids: [theirs] }), 400, 'SYSBUILD_INVALID_INPUT', '他人暂存的附件');
    expectErr(await post(U.pm, itemsUrl(pid), { ...base, attachment_ids: [att] }), 400, 'SYSBUILD_INVALID_INPUT', '已被使用的附件');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, n0, '附件校验失败：条目与版本整体回滚');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id NOT IN (SELECT id FROM sysbuild_items)', [])).n, 0, '没有孤儿版本行');
    const next = await createItem(U.pm, pid);
    assert.strictEqual(next.code, 'R-03', '失败的登记不占用编号');
  });

  test('C3b 条目创建：模块须属本项目；内容 / 原话 / 场合 / 日期 / 附件列表的长度与形态校验；多余键、数组体、控制字符 400；边界通过', async () => {
    const pid = await newProject();
    const other = await newProject();
    const mod = (await post(U.pm, `/sysbuild/projects/${pid}/modules`, { name: '模块一' })).body.module.id;
    const foreignMod = (await post(U.pm, `/sysbuild/projects/${other}/modules`, { name: '外项目模块' })).body.module.id;
    const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n;
    const bads = [
      [{ module_id: foreignMod }, 'module_id', '模块属于别的项目'],
      [{ module_id: 99999999 }, 'module_id', '模块不存在'],
      [{ module_id: 'x' }, 'module_id', '模块编号非法'],
      [{ content: undefined }, 'content', '缺内容'],
      [{ content: '   ' }, 'content', '内容空白'],
      [{ content: 'c'.repeat(4001) }, 'content', '内容 4001 字'],
      [{ content: 123 }, 'content', '内容非文本'],
      [{ content: '内容\u0000带控制字符' }, 'content', '内容含控制字符'],
      [{ quote_text: 'q'.repeat(2001) }, 'quote_text', '原话 2001 字'],
      [{ occasion: 'o'.repeat(201) }, 'occasion', '场合 201 字'],
      [{ proposed_on: '2026-02-30' }, 'proposed_on', '日期非法'],
      [{ proposed_on: '1999-01-01' }, 'proposed_on', '日期越界'],
      [{ attachment_ids: 'abc' }, 'attachment_ids', '附件列表非数组'],
      [{ attachment_ids: Array.from({ length: 21 }, (_, i) => i + 1) }, 'attachment_ids', '附件 21 个'],
      [{ attachment_ids: [1, 1] }, 'attachment_ids', '附件重复'],
      [{ attachment_ids: ['x'] }, 'attachment_ids', '附件编号非法'],
      [{ no_written_evidence: 'yes' }, 'no_written_evidence', '无书面证据非布尔'],
      [{ unknown_field: 1 }, 'unknown_field', '多余键'],
    ];
    for (const [extra, field, label] of bads) {
      const b = itemBody(extra);
      if (extra.content === undefined && Object.prototype.hasOwnProperty.call(extra, 'content')) delete b.content;
      const rr = await post(U.pm, itemsUrl(pid), b);
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, field, `${label} 的 field`);
    }
    expectBodyNotObject(await post(U.pm, itemsUrl(pid), []), '数组请求体');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, n0, '参数错误不留行');
    const edge = await post(U.pm, itemsUrl(pid), itemBody({ module_id: mod, content: 'c'.repeat(4000), quote_text: 'q'.repeat(2000), occasion: 'o'.repeat(200), proposed_on: '2099-12-31' }));
    assert.strictEqual(edge.status, 201, edge.text);
    assert.strictEqual(edge.body.item.module_id, mod);
  });

  test('C3b 条目创建：权限与项目状态——一般成员可建；只读账号 / admin 未接管 403；非成员 404；暂停可建；终止 409 SYSBUILD_PROJECT_READONLY', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const r = await post(U.m1, itemsUrl(pid), itemBody());
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.item.created_by, U.m1);
    expectErr(await post(U.ro, itemsUrl(pid), itemBody()), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
    expectErr(await post(U.admin, itemsUrl(pid), itemBody()), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
    // 只读否决独立于「是不是成员」：只读账号即使已是项目成员也不能登记（只读账号为成员的情形：被加入后账号被列入只读名单）
    await addMember(pid, U.ro);
    expectErr(await post(U.ro, itemsUrl(pid), itemBody()), 403, 'SYSBUILD_FORBIDDEN', '只读账号即使是成员');
    expectErr(await post(U.out, itemsUrl(pid), itemBody()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/projects/99999999/items', itemBody()), 404, 'SYSBUILD_NOT_FOUND', '项目不存在');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, itemsUrl(pid), itemBody())).status, 201, '暂停可建');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, itemsUrl(pid), itemBody()), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, 2);
  });

  // ── 3 条目新版本 ─────────────────────────────────────────────────────────────────────────────────
  test('C3b 条目新版本：S1 三方——PM 可、登记人本人可、其他成员 403；非成员 404；登记人被移出后 404；版本号递增；提出人整组沿用，给了就整组替换', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    await addMember(pid, U.m2);
    const party = await addParty(pid, '财务部', 'demand');
    const m2Member = await memberIdOf(pid, U.m2);
    const item = await createItem(U.m1, pid, { proposer_name: '原提出人', proposer_party_id: party, occasion: '原场合', proposed_on: '2026-10-01', quote_text: '原话' });
    const iid = item.id;
    const url = `/sysbuild/items/${iid}/versions`;
    expectErr(await newVersion(U.m2, iid), 403, 'SYSBUILD_FORBIDDEN', '其他成员');
    expectErr(await newVersion(U.ro, iid), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
    expectErr(await newVersion(U.admin, iid), 403, 'SYSBUILD_FORBIDDEN', 'admin 未接管');
    expectErr(await newVersion(U.out, iid), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await post(U.pm, '/sysbuild/items/99999999/versions', { content: 'x', ...EV }), 404, 'SYSBUILD_NOT_FOUND', '条目不存在');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [iid])).n, 1, '被拒绝的请求不出版本');
    // 登记人本人
    let r = await newVersion(U.m1, iid, { content: '第二版内容' });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.item.versions.map((v) => v.version_no), [1, 2]);
    let v2 = r.body.item.versions[1];
    assert.deepStrictEqual([v2.proposer_status, v2.content, v2.created_by], ['pending', '第二版内容', U.m1]);
    assert.deepStrictEqual([v2.proposer_name, v2.proposer_member_id, v2.proposer_party_id], ['原提出人', null, party], '提出人整组沿用');
    assert.deepStrictEqual([v2.occasion, v2.proposed_on, v2.quote_text], [null, null, null], '场合 / 日期 / 原话是每版自己的，不沿用');
    assert.strictEqual(r.body.item_version_id, v2.id);
    // PM
    r = await newVersion(U.pm, iid, { content: '第三版内容', proposer_member_id: m2Member });
    assert.strictEqual(r.status, 201, r.text);
    const v3 = r.body.item.versions[2];
    assert.deepStrictEqual([v3.version_no, v3.proposer_member_id, v3.proposer_name, v3.proposer_party_id, v3.created_by], [3, m2Member, null, null, U.pm], '给了提出人就整组替换');
    // 沿用上一版（v3 的成员提出人）
    r = await newVersion(U.pm, iid, { content: '第四版内容' });
    assert.deepStrictEqual([r.body.item.versions[3].proposer_member_id, r.body.item.versions[3].proposer_name], [m2Member, null]);
    // 事件
    const evs = await payloads(pid, 'item_version_created');
    assert.deepStrictEqual(evs[0], { item_version_id: v2.id, version_no: 2, attachment_ids: [], ref_attachment_ids: [], no_written_evidence: true });
    assert.strictEqual(evs.length, 3);
    // 被拒绝的提出人（已移出成员）：整个请求失败
    const gone = await addMember(pid, U.cand, { removed: true });
    expectErr(await newVersion(U.pm, iid, { proposer_member_id: gone }), 409, 'SYSBUILD_STATE', '提出人已移出');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [iid])).n, 4);
    // 登记人被移出后不再是成员：404（走生产的移出成员端点）
    const m1Member = await memberIdOf(pid, U.m1);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${m1Member}/remove`, { reason: '离项' })).status, 200);
    expectErr(await newVersion(U.m1, iid), 404, 'SYSBUILD_NOT_FOUND', '登记人已移出');
    // 夹具：只读账号是成员、也是某条目的登记人。原因：正常路径下只读账号登记不了条目，只能直接写库造出这个状态——只读否决对它同样生效
    await addMember(pid, U.ro);
    const roItem = await sqlRun("INSERT INTO sysbuild_items (project_id, code, created_by) VALUES (?, 'R-50', ?)", [pid, U.ro]);
    await sqlRun("INSERT INTO sysbuild_item_versions (item_id, version_no, content, proposer_name, created_by) VALUES (?, 1, '只读登记人的条目', '某人', ?)", [roItem.lastID, U.ro]);
    expectErr(await newVersion(U.ro, roItem.lastID), 403, 'SYSBUILD_FORBIDDEN', '夹具：只读账号即使是登记人');
  });

  // LOW-4：登记人「仍是已加入成员」这一条不能被 404 遮蔽——admin 不是成员（也没接管），可见项目，所以走到权限判定得 403；
  //   删掉 isMember 判定后，只要 created_by 是本人就放行（admin 登记人会拿到 201）。
  test('C3b 条目新版本：S1 登记人不再是成员——admin 登记的条目，admin 未接管（非成员）出新版本 403，不是 404 也不是 201（夹具）', async () => {
    const pid = await newProject();
    // 夹具：admin 作为登记人。原因：admin 未接管时不是成员，登记条目要先是成员，生产路径造不出「admin 登记过条目、之后又不是成员」的状态。
    const it = await sqlRun("INSERT INTO sysbuild_items (project_id, code, created_by) VALUES (?, 'R-70', ?)", [pid, U.admin]);
    await sqlRun("INSERT INTO sysbuild_item_versions (item_id, version_no, content, proposer_name, created_by) VALUES (?, 1, 'admin 登记的条目', '某人', ?)", [it.lastID, U.admin]);
    const r = await newVersion(U.admin, it.lastID);
    expectErr(r, 403, 'SYSBUILD_FORBIDDEN', '夹具：admin 是登记人但不是成员');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [it.lastID])).n, 1, '被拒绝的请求不出版本');
    // 对照：PM 可以给同一条目出新版本
    assert.strictEqual((await newVersion(U.pm, it.lastID)).status, 201);
  });

  test('C3b 条目新版本：必须有证据（新绑定 + 新引用都计入）；参数校验与键白名单；暂停可出新版本、终止 409', async () => {
    const pid = await newProject();
    const item = await createItem(U.pm, pid);
    const iid = item.id;
    const keep = await stageAttachment(pid, U.pm);
    expectErr(await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '无证据' }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '无证据');
    expectErr(await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '无证据', ref_attachment_ids: [] }), 400, 'SYSBUILD_EVIDENCE_REQUIRED', '空沿用列表');
    // 新绑定算证据
    let r = await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '带新附件', attachment_ids: [keep] });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(await sqlGet('SELECT owner_type, owner_id FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [keep]), { owner_type: 'item_version', owner_id: r.body.item_version_id });
    // 只有沿用（无新绑定、无无书面证据声明）也算证据
    r = await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '只沿用', ref_attachment_ids: [keep] });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.item.versions[2].attachments.map((a) => [a.attachment_id, a.via]), [[keep, 'ref']]);
    // 互斥：沿用附件 + 无书面证据声明
    expectErr(await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '互斥', ref_attachment_ids: [keep], ...EV }), 400, 'SYSBUILD_INVALID_INPUT', '沿用与无书面证据同时给');
    expectErr(await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '互斥', ref_attachment_ids: [keep], no_evidence_reason: '口头电话确认了本次需求内容' }), 400, 'SYSBUILD_INVALID_INPUT', '未声明却给原因');
    expectErr(await post(U.pm, `/sysbuild/items/${iid}/versions`, { content: '不足', no_written_evidence: true, no_evidence_reason: '太短' }), 400, 'SYSBUILD_INVALID_INPUT', '原因不足 10 字');
    // 参数校验
    const bads = [[{ content: '' }, 'content'], [{ content: 'c'.repeat(4001) }, 'content'], [{ proposed_on: 'bad' }, 'proposed_on'], [{ ref_attachment_ids: 'x' }, 'ref_attachment_ids'],
      [{ ref_attachment_ids: [keep, keep] }, 'ref_attachment_ids'], [{ ref_attachment_ids: Array.from({ length: 21 }, (_, i) => i + 1) }, 'ref_attachment_ids'], [{ foo: 1 }, 'foo']];
    for (const [extra, field] of bads) {
      const rr = await post(U.pm, `/sysbuild/items/${iid}/versions`, Object.assign({ content: '内容', ...EV }, extra));
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', field);
      assert.strictEqual(rr.body.field, field);
    }
    expectBodyNotObject(await post(U.pm, `/sysbuild/items/${iid}/versions`, []), '数组请求体');
    expectErr(await post(U.pm, '/sysbuild/items/abc/versions', { content: 'x', ...EV }), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
    const n = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [iid])).n;
    assert.strictEqual(n, 3, '只有三次成功出了版本');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await newVersion(U.pm, iid)).status, 201, '暂停可出新版本');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await newVersion(U.pm, iid), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
  });

  test('C3b 条目新版本：S6 沿用附件——本条目旧版本绑定的可沿用（写引用行与事件、冻结不在此测）；他条目的附件 / 已遮蔽 / 已软删除 / 不存在 / 无归属 各 400 且不出版本', async () => {
    const pid = await newProject();
    const att = await stageAttachment(pid, U.pm);
    const item = await createItem(U.pm, pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const iid = item.id;
    const v1 = item.versions[0].id;
    // 沿用成功
    let r = await newVersion(U.pm, iid, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [att] });
    assert.strictEqual(r.status, 201, r.text);
    const v2 = r.body.item_version_id;
    assert.deepStrictEqual(await sqlGet('SELECT project_id, attachment_id, owner_type, owner_id, ref_by FROM sysbuild_attachment_refs WHERE attachment_id = ?', [att]), { project_id: pid, attachment_id: att, owner_type: 'item_version', owner_id: v2, ref_by: U.pm });
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [att])).n, 1, '绑定仍是上传来源归属，不重复绑定');
    assert.deepStrictEqual(await sqlGet("SELECT owner_id FROM sysbuild_attachment_bindings WHERE attachment_id = ?", [att]), { owner_id: v1 });
    const evs = await sqlAll("SELECT object_type, object_id, payload_json FROM sysbuild_events WHERE project_id = ? AND event_type = 'attachment_referenced'", [pid]);
    assert.strictEqual(evs.length, 1);
    assert.deepStrictEqual([evs[0].object_type, evs[0].object_id, JSON.parse(evs[0].payload_json)], ['attachment', att, { owner_type: 'item_version', owner_id: v2, item_id: iid }]);
    assert.ok(!evs[0].payload_json.includes('证据文件'), '引用事件不写原名');
    const view = (await get(U.pm, `/sysbuild/items/${iid}`)).body.item;
    assert.deepStrictEqual(view.versions[0].attachments.map((a) => [a.attachment_id, a.via]), [[att, 'bound']]);
    assert.deepStrictEqual(view.versions[1].attachments.map((a) => [a.attachment_id, a.via]), [[att, 'ref']]);
    // 继续沿用（v3 沿用同一附件，对不同对象各一条引用）
    r = await newVersion(U.pm, iid, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [att] });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_refs WHERE attachment_id = ?', [att])).n, 2);
    // 以下每个输入只触犯一条规则（避免相邻规则遮蔽）
    const nVersions = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [iid])).n;
    const before = await nVersions();
    const tryRef = (aid) => newVersion(U.pm, iid, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [aid] });
    // 他条目的附件（同项目、未遮蔽、未删除、已绑定——只违反「本条目旧版本」）
    const otherAtt = await stageAttachment(pid, U.pm);
    await createItem(U.pm, pid, { attachment_ids: [otherAtt], no_written_evidence: undefined, no_evidence_reason: undefined });
    let rr = await tryRef(otherAtt);
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '他条目的附件');
    assert.strictEqual(rr.body.field, 'ref_attachment_ids');
    // 已遮蔽（绑定在本条目旧版本——只违反「未遮蔽」）
    const maskedAtt = await stageAttachment(pid, U.pm);
    const mi = await createItem(U.pm, pid, { attachment_ids: [maskedAtt], no_written_evidence: undefined, no_evidence_reason: undefined });
    await maskAtt(maskedAtt);
    expectErr(await newVersion(U.pm, mi.id, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [maskedAtt] }), 400, 'SYSBUILD_INVALID_INPUT', '已遮蔽');
    // 已软删除（绑定在本条目旧版本——只违反「未软删除」）
    const delAtt = await stageAttachment(pid, U.pm);
    const di = await createItem(U.pm, pid, { attachment_ids: [delAtt], no_written_evidence: undefined, no_evidence_reason: undefined });
    await deleteAtt(delAtt);
    expectErr(await newVersion(U.pm, di.id, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [delAtt] }), 400, 'SYSBUILD_INVALID_INPUT', '已软删除');
    // 不存在 / 暂存未绑定任何记录（不属于任何旧版本）
    expectErr(await tryRef(99999999), 400, 'SYSBUILD_INVALID_INPUT', '附件不存在');
    const loose = await stageAttachment(pid, U.pm);
    expectErr(await tryRef(loose), 400, 'SYSBUILD_INVALID_INPUT', '暂存未绑定');
    // 他项目的附件
    const other = await newProject();
    const foreignAtt = await stageAttachment(other, U.pm);
    await createItem(U.pm, other, { attachment_ids: [foreignAtt], no_written_evidence: undefined, no_evidence_reason: undefined });
    expectErr(await tryRef(foreignAtt), 400, 'SYSBUILD_INVALID_INPUT', '他项目的附件');
    assert.strictEqual(await nVersions(), before, '被拒绝的请求不出版本');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_refs WHERE attachment_id IN (?, ?, ?, ?, ?)', [otherAtt, maskedAtt, delAtt, loose, foreignAtt])).n, 0, '被拒绝的请求不写引用');
    // 夹具：引用行里已有、但本条目旧版本都没有绑定的附件（C3b 的生产路径到不了这个状态；S6 写「已绑定或已引用」，两条路各自有断言）
    const refOnly = await stageAttachment(pid, U.pm);
    await sqlRun("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'item_version', ?, ?)", [pid, refOnly, v1, U.pm]);
    r = await tryRef(refOnly);
    assert.strictEqual(r.status, 201, `夹具：旧版本已引用的附件可沿用 ${r.text}`);
  });

  // MED-1：S6 的「所属类型 = item_version」过滤必须有自己的判别用例。两个夹具附件的编号都等于「本条目 v1 的编号」，但所属类型不是条目版本——
  //   绑定的是 comment（评论，第二期才有），引用的是 material_version（材料出新版本，C5 起）。只有 owner_type 过滤能挡住；
  //   其余规则（同项目、未遮蔽、未删除、不是别条目的）对这两个附件都满足，所以不会被相邻规则遮蔽。
  //   C5 S-S1a 围栏外的一处改动：绑定类型原为 entry，C5 起登记真实使用 entry 绑定，夹具里编号恰好等于登记编号的假绑定会被「给结论时冻结登记附件」读到
  //   （跨项目的 500 内部错误，只在整套顺序跑时出现）。改用不进冻结对象类型的 comment，判别力不变（owner_type 仍不是 item_version）。
  test('C3b 条目新版本：S6 所属类型（夹具）——绑定 / 引用的所属对象类型不是条目版本时，即使编号等于本条目旧版本的编号也不能沿用，400 ref_attachment_ids', async () => {
    const pid = await newProject();
    const item = await createItem(U.pm, pid);
    const v1 = item.versions[0].id;
    const boundAsEntry = await stageAttachment(pid, U.pm);
    const refAsMaterial = await stageAttachment(pid, U.pm);
    // 夹具：C3b 的生产路径写不出这两种行（登记 entry 与材料版本是 C5 的内容），只能直接写库
    // 注意（C5 预筛 L7）：第二期做评论附件时，owner_type = 'comment' 会成为真实绑定类型，届时这里编号恰等于条目版本编号的假绑定会同样与真实评论编号相撞，
    //   到时要把这里换成当时仍无真实用途的类型（如 golive_event）。
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'comment', ?, ?)", [boundAsEntry, v1, U.pm]);
    await sqlRun("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'material_version', ?, ?)", [pid, refAsMaterial, v1, U.pm]);
    const noEv = { no_written_evidence: undefined, no_evidence_reason: undefined };
    for (const [aid, label] of [[boundAsEntry, '绑定在 comment（编号 = 本条目 v1）'], [refAsMaterial, '引用在 material_version（编号 = 本条目 v1）']]) {
      const rr = await newVersion(U.pm, item.id, Object.assign({ ref_attachment_ids: [aid] }, noEv));
      expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(rr.body.field, 'ref_attachment_ids', label);
    }
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [item.id])).n, 1, '被拒绝的请求不出版本');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_refs WHERE project_id = ? AND owner_type = ?', [pid, 'item_version'])).n, 0, '被拒绝的请求不写条目版本的引用');
  });

  // 18 号 L-2：旧版本不再展开成编号占位符，改联表 item_id 限定。两个方向都要有用例：① 旧版本很多时仍能沿用最早版本的附件；
  //   ② 别的条目的版本上的引用 / 绑定不算「本条目旧版本」（引用方向用夹具造：引用行挂在他条目的版本上）。
  test('C3b 条目新版本：S6 本条目限定（18 号 L-2）——3 个以上旧版本时可沿用最早版本的附件；挂在他条目版本上的引用行（夹具）不能沿用', async () => {
    const pid = await newProject();
    const att = await stageAttachment(pid, U.pm);
    const item = await createItem(U.pm, pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    for (let i = 0; i < 3; i += 1) assert.strictEqual((await newVersion(U.pm, item.id)).status, 201, `第 ${i + 2} 版`);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [item.id])).n, 4, '4 个旧版本');
    const noEv = { no_written_evidence: undefined, no_evidence_reason: undefined };
    const ok = await newVersion(U.pm, item.id, Object.assign({ ref_attachment_ids: [att] }, noEv));
    assert.strictEqual(ok.status, 201, `沿用最早版本（v1）绑定的附件 ${ok.text}`);
    assert.deepStrictEqual(ok.body.item.versions[4].attachments.map((a) => [a.attachment_id, a.via]), [[att, 'ref']]);
    assert.strictEqual((await sqlGet("SELECT owner_id FROM sysbuild_attachment_refs WHERE attachment_id = ? AND owner_type = 'item_version'", [att])).owner_id, ok.body.item_version_id);
    // 夹具：引用行挂在「他条目」的版本上，附件没有绑定在本条目任何版本上。原因：C3b 的生产路径写不出「未先绑定就被引用」的行
    const other = await createItem(U.pm, pid);
    const foreignRef = await stageAttachment(pid, U.pm);
    await sqlRun("INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'item_version', ?, ?)", [pid, foreignRef, other.versions[0].id, U.pm]);
    const before = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [item.id])).n;
    const rr = await newVersion(U.pm, item.id, Object.assign({ ref_attachment_ids: [foreignRef] }, noEv));
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '他条目版本上的引用');
    assert.strictEqual(rr.body.field, 'ref_attachment_ids');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [item.id])).n, before, '被拒绝的请求不出版本');
  });

  // D5(a)：暂存附件被遮蔽后不能再绑定到新记录（遮蔽的内容不能被带进新版本）。绑定助手本身的判别（含变异）在 verify-sysbuild-attachments.js，这里验端到端。
  test('C3b 条目创建：暂存的附件已被遮蔽（夹具）→ 400 attachment_ids 且不留条目；未遮蔽的照常（D5(a) 端到端）', async () => {
    const pid = await newProject();
    const masked = await stageAttachment(pid, U.pm);
    const fine = await stageAttachment(pid, U.pm);
    await maskAtt(masked); // 夹具：暂存附件的遮蔽状态（遮蔽端点有专门的验证脚本）
    const n0 = (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n;
    const rr = await post(U.pm, itemsUrl(pid), itemBody({ attachment_ids: [masked], no_written_evidence: undefined, no_evidence_reason: undefined }));
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '已遮蔽的暂存附件');
    assert.strictEqual(rr.body.field, 'attachment_ids');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_items WHERE project_id = ?', [pid])).n, n0, '被拒绝的请求不留条目');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_bindings WHERE attachment_id = ?', [masked])).n, 0);
    const ok = await post(U.pm, itemsUrl(pid), itemBody({ attachment_ids: [fine], no_written_evidence: undefined, no_evidence_reason: undefined }));
    assert.strictEqual(ok.status, 201, ok.text);
  });

  test('C3b 条目新版本：附件校验失败整体回滚（版本行、事件、绑定都不留；沿用的附件不写引用）', async () => {
    const pid = await newProject();
    const att = await stageAttachment(pid, U.pm);
    const item = await createItem(U.pm, pid, { attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const theirs = await stageAttachment(pid, U.m1);
    const r = await newVersion(U.pm, item.id, { no_written_evidence: undefined, no_evidence_reason: undefined, ref_attachment_ids: [att], attachment_ids: [theirs] });
    expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', '新附件是他人暂存的');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_item_versions WHERE item_id = ?', [item.id])).n, 1);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_attachment_refs WHERE attachment_id = ?', [att])).n, 0);
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_events WHERE project_id = ? AND event_type IN (\'item_version_created\', \'attachment_referenced\')', [pid])).n, 0);
  });

  test('C3b 条目改模块：PM 可置入 / 置空、事件 before / after；模块须属本项目 400；非 PM 403；没有变化不写事件；终止 409', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const other = await newProject();
    const m1 = (await post(U.pm, `/sysbuild/projects/${pid}/modules`, { name: '甲' })).body.module.id;
    const foreign = (await post(U.pm, `/sysbuild/projects/${other}/modules`, { name: '乙' })).body.module.id;
    const item = await createItem(U.m1, pid);
    const url = `/sysbuild/items/${item.id}`;
    expectErr(await patch(U.m1, url, { module_id: m1 }), 403, 'SYSBUILD_FORBIDDEN', '登记人也不能改模块');
    expectErr(await patch(U.ro, url, { module_id: m1 }), 403, 'SYSBUILD_FORBIDDEN', '只读账号');
    expectErr(await patch(U.out, url, { module_id: m1 }), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await patch(U.pm, url, { module_id: foreign }), 400, 'SYSBUILD_INVALID_INPUT', '他项目模块');
    expectErr(await patch(U.pm, url, { module_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '模块不存在');
    const missing = await patch(U.pm, url, {});
    expectErr(missing, 400, 'SYSBUILD_INVALID_INPUT', '缺 module_id');
    assert.ok(missing.body.message.includes('必填'), `缺 module_id 的提示应说明必填（去掉必填检查后会变成「模块不合法」），实际 ${missing.body.message}`);
    expectErr(await patch(U.pm, url, { module_id: m1, x: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '多余键');
    expectErr(await patch(U.pm, url, { module_id: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '模块编号非法');
    assert.strictEqual((await sqlGet('SELECT module_id FROM sysbuild_items WHERE id = ?', [item.id])).module_id, null, '被拒绝的请求不改库');
    let r = await patch(U.pm, url, { module_id: m1 });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.changed, r.body.item.module_id], [true, m1]);
    assert.deepStrictEqual(await payloads(pid, 'item_module_changed'), [{ before: null, after: m1 }]);
    r = await patch(U.pm, url, { module_id: m1 });
    assert.strictEqual(r.body.changed, false);
    assert.strictEqual(await eventCount(pid, 'item_module_changed'), 1, '没有变化不写事件');
    r = await patch(U.pm, url, { module_id: null });
    assert.deepStrictEqual([r.status, r.body.item.module_id], [200, null]);
    assert.deepStrictEqual((await payloads(pid, 'item_module_changed'))[1], { before: m1, after: null });
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await patch(U.pm, url, { module_id: m1 })).status, 200, '暂停可改');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await patch(U.pm, url, { module_id: null }), 409, 'SYSBUILD_PROJECT_READONLY', '终止后');
  });

  test('C3b 读接口：条目列表 / 详情——可见性、模块与 actions、遮蔽附件不返回原名（Q8）、只读账号可读', async () => {
    await mkSiblingEffectiveOverall(); // 兄弟项目有生效版本：下面「本项目 overall_version_id 为 null」才有判别力
    const pid = await newProject();
    await addMember(pid, U.m1);
    const mid = (await post(U.pm, `/sysbuild/projects/${pid}/modules`, { name: '读测试模块' })).body.module.id;
    const att = await stageAttachment(pid, U.pm);
    const item = await createItem(U.pm, pid, { module_id: mid, attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    await createItem(U.m1, pid);
    let list = await get(U.pm, itemsUrl(pid));
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.items.map((i) => i.code), ['R-01', 'R-02']);
    assert.deepStrictEqual(list.body.modules.map((m) => [m.id, m.name, m.actions.rename]), [[mid, '读测试模块', true]]);
    assert.deepStrictEqual(list.body.actions, { create_item: true, create_module: true });
    assert.strictEqual(list.body.overall_version_id, null);
    assert.strictEqual(list.body.items[0].versions[0].attachments[0].original_name, '证据文件.txt');
    // 预筛 LOW-5：附件视图带 sha256；遮蔽 / 删除相关字段只在发生时才有值
    const plain = list.body.items[0].versions[0].attachments[0];
    assert.deepStrictEqual([plain.sha256, plain.masked, plain.masked_at, plain.masked_by, plain.mask_reason, plain.deleted, plain.deleted_at, plain.deleted_by],
      ['b'.repeat(64), false, null, null, null, false, null, null], '未遮蔽未删除：遮蔽 / 删除字段全为空');
    await maskAtt(att);
    list = await get(U.pm, itemsUrl(pid));
    const a = list.body.items[0].versions[0].attachments[0];
    assert.deepStrictEqual([a.masked, a.original_name], [true, null], '遮蔽后不返回原名');
    assert.deepStrictEqual([a.sha256, a.masked_at, a.masked_by, a.mask_reason, a.deleted, a.deleted_at, a.deleted_by],
      ['b'.repeat(64), '2026-10-30 10:00:00', 1, '含敏感信息', false, null, null], '遮蔽后：SHA-256、遮蔽时间、操作人、原因都在');
    assert.ok(!list.text.includes('证据文件'), '响应体任何位置都不含原名');
    const one = await get(U.pm, `/sysbuild/items/${item.id}`);
    assert.ok(!one.text.includes('证据文件'));
    // 一般成员：只读列表的 actions 与逐条目 actions
    const asM1 = (await get(U.m1, itemsUrl(pid))).body;
    assert.deepStrictEqual(asM1.actions, { create_item: true, create_module: false });
    assert.deepStrictEqual(asM1.items.map((i) => i.actions), [{ new_version: false, set_module: false }, { new_version: true, set_module: false }], '登记人只能给自己的条目出新版本');
    assert.strictEqual(asM1.modules[0].actions.rename, false);
    for (const [uid, label] of [[U.ro, '只读账号'], [U.admin, 'admin']]) {
      const rr = await get(uid, itemsUrl(pid));
      assert.strictEqual(rr.status, 200, label);
      assert.deepStrictEqual(rr.body.actions, { create_item: false, create_module: false }, label);
      assert.ok(rr.body.items.every((i) => i.actions.new_version === false && i.actions.set_module === false), label);
    }
    expectErr(await get(U.out, itemsUrl(pid)), 404, 'SYSBUILD_NOT_FOUND', '非成员列表');
    expectErr(await get(U.out, `/sysbuild/items/${item.id}`), 404, 'SYSBUILD_NOT_FOUND', '非成员详情');
    expectErr(await get(U.pm, '/sysbuild/items/99999999'), 404, 'SYSBUILD_NOT_FOUND', '条目不存在');
    expectErr(await get(U.pm, '/sysbuild/items/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
  });

  test('C3b 读接口：附件视图的删除信息（夹具软删除）——显示已删除、删除时间、删除人；原名仍可见，只有遮蔽才隐藏原名（预筛 LOW-5）', async () => {
    const pid = await newProject();
    const attId = await stageAttachment(pid, U.pm);
    const item = await createItem(U.pm, pid, { attachment_ids: [attId], no_written_evidence: undefined, no_evidence_reason: undefined });
    await deleteAtt(attId); // 夹具：软删除状态（软删除端点有专门的验证脚本）
    const d = (await get(U.pm, `/sysbuild/items/${item.id}`)).body.item.versions[0].attachments[0];
    assert.deepStrictEqual([d.deleted, d.deleted_at, d.deleted_by, d.original_name, d.masked, d.masked_at, d.masked_by, d.mask_reason],
      [true, '2026-10-30 10:00:00', 1, '证据文件.txt', false, null, null, null]);
  });

  // ── 4 内容包 ─────────────────────────────────────────────────────────────────────────────────────
  test('C3b 包创建：overall / initiation / closing 各一次成功、重复 409；batch_req 409（S2）；change 409；类型 / 批次参数 400；batch_accept 须给本项目批次', async () => {
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
    // S2：批次需求包第一期不建
    expectErr(await post(U.pm, url, { type: 'batch_req', batch_id: batch }), 409, 'SYSBUILD_STATE', 'batch_req（S2）');
    // change 只经正式变更产生
    expectErr(await post(U.pm, url, { type: 'change' }), 409, 'SYSBUILD_STATE', 'change');
    // 参数
    const bads = [[{}, 'type', '缺 type'], [{ type: 'overall_batch_req' }, 'type', 'overall_batch_req 已不是包类型（D41）'], [{ type: 'nope' }, 'type', '类型非法'],
      [{ type: 'batch_accept' }, 'batch_id', 'batch_accept 缺批次'], [{ type: 'batch_accept', batch_id: 'x' }, 'batch_id', '批次编号非法'], [{ type: 'overall', batch_id: batch }, 'batch_id', 'overall 不挂批次'],
      [{ type: 'change', batch_id: batch }, 'batch_id', 'change 不挂批次'], [{ type: 'batch_req' }, 'batch_id', 'batch_req 缺批次'], [{ type: 'closing', extra: 1 }, 'extra', '多余键']];
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
    const transferred = await fixtureBatch(pid, 'transferred');
    const superseded = await fixtureBatch(pid, 'superseded');
    expectErr(await post(U.pm, url, { type: 'batch_accept', batch_id: transferred }), 409, 'SYSBUILD_STATE', '夹具：已转出的批次');
    expectErr(await post(U.pm, url, { type: 'batch_accept', batch_id: superseded }), 409, 'SYSBUILD_STATE', '夹具：被替代的批次');
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
  test('C3b 包版本：首个草稿；已有草稿再建 409；包有待确认版本也 409（夹具）；form 单批 = overall_batch_req，多批 = overall；其他包 form 为空', async () => {
    const pid = await newProject();
    const pkO = await mkPackage(pid, 'overall');
    const r = await post(U.pm, `/sysbuild/packages/${pkO}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.version, { id: r.body.version.id, package_id: pkO, version_no: 1, status: 'draft', form: 'overall_batch_req', parent_overall_version_id: null });
    assert.strictEqual(r.body.copied_items, 0);
    const row = await sqlGet('SELECT version_no, status, form, snapshot_json, created_by, effective_at FROM sysbuild_package_versions WHERE id = ?', [r.body.version.id]);
    assert.deepStrictEqual(row, { version_no: 1, status: 'draft', form: 'overall_batch_req', snapshot_json: '{}', created_by: U.pm, effective_at: null });
    assert.deepStrictEqual((await payloads(pid, 'package_version_created'))[0], { package_id: pkO, version_no: 1, form: 'overall_batch_req', parent_overall_version_id: null, copied_items: 0 });
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
    // 夹具：多批 → overall；已转出 / 被替代的批次不计入有效批次
    const pid2 = await newProject();
    const pk2 = await mkPackage(pid2, 'overall');
    const second = await fixtureBatch(pid2, 'planning');
    const v = await post(U.pm, `/sysbuild/packages/${pk2}/versions`);
    assert.strictEqual(v.body.version.form, 'overall', '夹具：两个有效批次 = 普通总体形态');
    await setVerStatus(v.body.version.id, 'superseded');
    await sqlRun("UPDATE sysbuild_batches SET status = 'transferred', transfer_change_id = 1 WHERE id = ?", [second]);
    const v2 = await post(U.pm, `/sysbuild/packages/${pk2}/versions`);
    assert.strictEqual(v2.body.version.form, 'overall_batch_req', '夹具：另一批已转出，有效批次只剩 1 个');
    await fixtureBatch(pid2, 'superseded');
    await setVerStatus(v2.body.version.id, 'superseded');
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pk2}/versions`)).body.version.form, 'overall_batch_req', '夹具：被替代的批次同样不计入');
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
    // C4a 交接 ②：总体规划版本经生产路径生效（补需求部门参与方 + 一条条目 + 提交 + 全部确认）
    const effItem = await createItem(U.pm, pid);
    assert.strictEqual((await addRev(U.pm, pvO, effItem.versions[0].id, { committed_batch_id: batch })).status, 201);
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    const { pk: pkI } = await T.confirm.produceEffectiveInitiation(pid); // P37：总体规划包提交前须立项包已生效（同样走生产路径）
    await T.confirm.planAllNodes(pid); // 修订批三 H-1：总体规划包提交前节点计划须齐全
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

  test('C3b 包版本：新草稿继承上一版本（最大 version_no）的集合——逐条 add 修订、操作人为创建者、承诺批次照抄；已移出的不继承（夹具：上一版本置已替代）', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const i1 = await createItem(U.pm, pid);
    const i2 = await createItem(U.pm, pid);
    const i3 = await createItem(U.pm, pid);
    const pk = await mkPackage(pid, 'overall');
    const pv1 = await mkVersion(pk);
    assert.strictEqual((await addRev(U.pm, pv1, i1.versions[0].id, { committed_batch_id: batch })).status, 201);
    assert.strictEqual((await addRev(U.pm, pv1, i2.versions[0].id)).status, 201);
    assert.strictEqual((await addRev(U.pm, pv1, i3.versions[0].id, { committed_batch_id: batch })).status, 201);
    assert.strictEqual((await removeRev(U.pm, pv1, i3.versions[0].id)).status, 201);
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv1}`, { snapshot_json: { 说明: '第一版文案', 材料: ['a'] } })).status, 200);
    await setVerStatus(pv1, 'superseded'); // 夹具：总体规划已生效时不能直接建草稿（D1），继承逻辑用「上一版本已被替代」的状态验证
    const r = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
    assert.strictEqual(r.status, 201, r.text);
    const pv2 = r.body.version.id;
    assert.strictEqual(r.body.copied_items, 2);
    const revs = await sqlAll('SELECT item_version_id, committed_batch_id, op, created_by FROM sysbuild_package_item_revisions WHERE package_version_id = ? ORDER BY id', [pv2]);
    assert.deepStrictEqual(revs, [
      { item_version_id: i1.versions[0].id, committed_batch_id: batch, op: 'add', created_by: U.pm },
      { item_version_id: i2.versions[0].id, committed_batch_id: null, op: 'add', created_by: U.pm },
    ]);
    assert.strictEqual((await payloads(pid, 'package_version_created'))[1].copied_items, 2);
    // snapshot_json 同样继承上一版本（预筛裁定：与集合继承取同一个「上一版本」）
    const snapOf = async (vid) => JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [vid])).snapshot_json);
    assert.deepStrictEqual(await snapOf(pv2), { 说明: '第一版文案', 材料: ['a'] }, '新草稿继承上一版本的 snapshot_json');
    // 以最大 version_no 的版本为准：pv2 里再去掉 i2、换成 i3、改文案，pv2 被替代后，pv3 继承 pv2 的集合与 snapshot
    assert.strictEqual((await removeRev(U.pm, pv2, i2.versions[0].id)).status, 201);
    assert.strictEqual((await addRev(U.pm, pv2, i3.versions[0].id)).status, 201);
    assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv2}`, { snapshot_json: { 说明: '第二版文案' } })).status, 200);
    await setVerStatus(pv2, 'superseded');
    const r3 = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
    assert.strictEqual(r3.body.copied_items, 2);
    assert.deepStrictEqual(await snapOf(r3.body.version.id), { 说明: '第二版文案' }, '继承的是最大 version_no 的版本（不是第一版）');
    const view = (await get(U.pm, `/sysbuild/package-versions/${r3.body.version.id}`)).body;
    assert.deepStrictEqual(view.items.map((i) => [i.code, i.version_no, i.committed_batch_id]), [['R-01', 1, batch], ['R-03', 1, null]]);
    // 非总体规划包的集合恒为空，新版本不复制任何东西
    const pkI = await mkPackage(pid, 'initiation');
    const iv1 = await mkVersion(pkI);
    await setVerStatus(iv1, 'superseded');
    assert.strictEqual((await post(U.pm, `/sysbuild/packages/${pkI}/versions`)).body.copied_items, 0);
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
  test('C3b D1 总体规划已生效（经生产路径生效；结项包 / 验收包生效与总体规划被替代为夹具）：总体规划包不能直接建草稿 409「须经正式变更」，读接口 new_version 为假；立项包 / 结项包 / 验收包的生效版本不受限；被替代而无生效版本时可建', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const { pk: pkO, pv: pv1 } = await T.confirm.produceEffectiveOverall(pid); // C4a 交接 ②：总体规划版本经提交 + 全部确认生效
    const flagOf = async (pkid) => (await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.packages.find((p) => p.id === pkid).actions.new_version;
    const r = await post(U.pm, `/sysbuild/packages/${pkO}/versions`);
    expectErr(r, 409, 'SYSBUILD_STATE', '总体规划已生效');
    assert.ok(r.body.message.includes('总体规划已生效') && r.body.message.includes('正式变更'), `提示应说明须经正式变更，实际 ${r.body.message}`);
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

  // D2（预筛裁定）：批次包所在批次已转出 / 被替代，建版本、改 snapshot、集合修订一律拒绝（与 C3a 的 withFrozenBatch 同族）。
  test('C3b D2 批次包所在批次已转出 / 被替代（夹具）：建版本、改 snapshot、集合修订一律 409，读接口标志随之为假；批次正常时同样的操作成功', async () => {
    const pid = await newProject();
    const item = await createItem(U.pm, pid);
    for (const frozen of ['transferred', 'superseded']) {
      // 对照：批次正常的验收包，版本被替代后可以再建新草稿
      const okBatch = await fixtureBatch(pid, 'planning');
      const okPk = await mkPackage(pid, 'batch_accept', okBatch);
      await setVerStatus(await mkVersion(okPk), 'superseded');
      assert.strictEqual((await post(U.pm, `/sysbuild/packages/${okPk}/versions`)).status, 201, `${frozen}：对照——批次正常时可建`);
      // 被测：同样的验收包，批次转为已转出 / 被替代（夹具：C3 没有转出 / 替代批次的生产路径）
      const bid = await fixtureBatch(pid, 'planning');
      const pk = await mkPackage(pid, 'batch_accept', bid);
      const pv = await mkVersion(pk);
      assert.strictEqual((await patch(U.pm, `/sysbuild/package-versions/${pv}`, { snapshot_json: { 前: 1 } })).status, 200, '对照：批次正常时可改 snapshot');
      await sqlRun(frozen === 'transferred'
        ? "UPDATE sysbuild_batches SET status = 'transferred', transfer_change_id = 1 WHERE id = ?"
        : "UPDATE sysbuild_batches SET status = 'superseded', superseded_by = 1 WHERE id = ?", [bid]);
      const edit = await patch(U.pm, `/sysbuild/package-versions/${pv}`, { snapshot_json: { 后: 2 } });
      expectErr(edit, 409, 'SYSBUILD_STATE', `${frozen}：改 snapshot`);
      assert.ok(edit.body.message.includes('已转出或被替代'), `${frozen}：改 snapshot 的提示应指向批次冻结，实际 ${edit.body.message}`);
      assert.deepStrictEqual(JSON.parse((await sqlGet('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [pv])).snapshot_json), { 前: 1 }, '被拒绝的编辑不改库');
      // 集合修订：批次包按 S3 本来也不能挂条目，所以这里认提示——要指向「批次冻结」这个真正的原因
      const add = await addRev(U.pm, pv, item.versions[0].id);
      expectErr(add, 409, 'SYSBUILD_STATE', `${frozen}：add`);
      assert.ok(add.body.message.includes('批次包所在批次已转出或被替代'), `${frozen}：add 的提示应指向批次冻结，实际 ${add.body.message}`);
      const rm = await removeRev(U.pm, pv, item.versions[0].id);
      expectErr(rm, 409, 'SYSBUILD_STATE', `${frozen}：remove`);
      assert.ok(rm.body.message.includes('批次包所在批次已转出或被替代'), `${frozen}：remove 的提示应指向批次冻结，实际 ${rm.body.message}`);
      // 读接口：草稿版本的 edit / add_item / remove_item 标志为假
      assert.deepStrictEqual((await get(U.pm, `/sysbuild/package-versions/${pv}`)).body.actions, { edit: false, add_item: false, remove_item: false, new_version: false, submit: false, withdraw: false, export_sheet: false }, `${frozen}：版本详情标志`); // C4c：草稿版本没有冻结快照，export_sheet 为假
      // 建版本：先让草稿被替代（夹具），否则会先报「已有草稿」
      await setVerStatus(pv, 'superseded');
      const create = await post(U.pm, `/sysbuild/packages/${pk}/versions`);
      expectErr(create, 409, 'SYSBUILD_STATE', `${frozen}：建版本`);
      assert.ok(create.body.message.includes('已转出或被替代'), `${frozen}：建版本的提示应指向批次冻结，实际 ${create.body.message}`);
      assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_versions WHERE package_id = ?', [pk])).n, 1, '被拒绝的请求不出版本');
      const listed = (await get(U.pm, `/sysbuild/projects/${pid}/packages`)).body.packages.find((p) => p.id === pk);
      assert.strictEqual(listed.actions.new_version, false, `${frozen}：包列表 new_version`);
    }
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
        else assert.ok(res.status === 403 || res.status === 409, `${label} ${t}：没列出但没被 403 / 409 拒绝 ${res.status} ${res.text}`);
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
    // 批次级：多一个批次（夹具）后 batch_accept 重新可建；只剩已转出 / 被替代的批次没有验收包时不可建
    const second = await fixtureBatch(pid, 'planning');
    assert.deepStrictEqual(await typesOf(U.pm), ['batch_accept']);
    await sqlRun("UPDATE sysbuild_batches SET status = 'transferred', transfer_change_id = 1 WHERE id = ?", [second]);
    assert.deepStrictEqual(await typesOf(U.pm), [], '夹具：唯一没有验收包的批次已转出');
    await sqlRun("UPDATE sysbuild_batches SET status = 'superseded', superseded_by = 1, transfer_change_id = NULL WHERE id = ?", [second]);
    assert.deepStrictEqual(await typesOf(U.pm), [], '夹具：唯一没有验收包的批次被替代');
    // 暂停仍可建，终止不可
    const p2 = await newProject();
    assert.strictEqual((await setStatus(p2, 'paused')).status, 200);
    assert.deepStrictEqual(await typesOf(U.pm, p2), ['initiation', 'overall', 'batch_accept', 'closing'], '暂停可建');
    assert.strictEqual((await setStatus(p2, 'terminated')).status, 200);
    assert.deepStrictEqual(await typesOf(U.pm, p2), [], '终止后没有可建类型');
    await sameSource(U.pm, p2, '终止后的 PM');
  });

  // ── 6 条目集合修订 ─────────────────────────────────────────────────────────────────────────────────
  test('C3b 集合修订：add / remove 折叠；重复 add 409（同条目换版本也算）；remove 不在集合 409；事件与响应手写核对；承诺批次可空', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const i1 = await createItem(U.pm, pid);
    const i2 = await createItem(U.pm, pid);
    const v1b = (await newVersion(U.pm, i1.id)).body.item_version_id;
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    let r = await addRev(U.pm, pv, i1.versions[0].id, { committed_batch_id: batch });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.items, [{ item_id: i1.id, item_version_id: i1.versions[0].id, committed_batch_id: batch }]);
    assert.deepStrictEqual((await payloads(pid, 'package_item_added'))[0], { revision_id: r.body.revision_id, item_id: i1.id, item_version_id: i1.versions[0].id, committed_batch_id: batch });
    assert.deepStrictEqual(await sqlGet('SELECT package_version_id, item_version_id, committed_batch_id, op, created_by FROM sysbuild_package_item_revisions WHERE id = ?', [r.body.revision_id]),
      { package_version_id: pv, item_version_id: i1.versions[0].id, committed_batch_id: batch, op: 'add', created_by: U.pm });
    r = await addRev(U.pm, pv, i2.versions[0].id);
    assert.deepStrictEqual(r.body.items.map((i) => [i.item_id, i.committed_batch_id]), [[i1.id, batch], [i2.id, null]]);
    const n = async () => (await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pv])).n;
    assert.strictEqual(await n(), 2);
    // 重复 add：同一条目版本 / 同一条目的另一个版本
    expectErr(await addRev(U.pm, pv, i1.versions[0].id), 409, 'SYSBUILD_STATE', '重复 add');
    expectErr(await addRev(U.pm, pv, v1b), 409, 'SYSBUILD_STATE', '同条目另一个版本');
    assert.strictEqual(await n(), 2, '被拒绝的请求不写修订');
    // remove：不在集合 / 在集合但版本不是它
    expectErr(await removeRev(U.pm, pv, v1b), 409, 'SYSBUILD_STATE', '集合里是另一个版本');
    const i3 = await createItem(U.pm, pid);
    expectErr(await removeRev(U.pm, pv, i3.versions[0].id), 409, 'SYSBUILD_STATE', '不在集合');
    assert.strictEqual(await n(), 2);
    // remove 成功，之后可以换版本再 add
    r = await removeRev(U.pm, pv, i1.versions[0].id);
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.items.map((i) => i.item_id), [i2.id]);
    assert.deepStrictEqual((await payloads(pid, 'package_item_removed'))[0], { revision_id: r.body.revision_id, item_id: i1.id, item_version_id: i1.versions[0].id, committed_batch_id: null });
    expectErr(await removeRev(U.pm, pv, i1.versions[0].id), 409, 'SYSBUILD_STATE', '已移出再移出');
    r = await addRev(U.pm, pv, v1b, { committed_batch_id: batch });
    assert.strictEqual(r.status, 201, r.text);
    assert.deepStrictEqual(r.body.items.map((i) => [i.item_id, i.item_version_id]), [[i1.id, v1b], [i2.id, i2.versions[0].id]]);
    // 版本视图：当前集合 = 修订折叠
    let view = (await get(U.pm, `/sysbuild/package-versions/${pv}`)).body;
    assert.deepStrictEqual(view.items.map((i) => [i.code, i.version_no, i.committed_batch_id]), [['R-01', 2, batch], ['R-02', 1, null]]);
    // 夹具：同一条目重复 add 的修订行（写入侧已拒，只能直接写库）——折叠时按最后一次为准
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, NULL, 'add', ?)", [pv, i1.versions[0].id, U.pm]);
    view = (await get(U.pm, `/sysbuild/package-versions/${pv}`)).body;
    assert.deepStrictEqual(view.items.map((i) => [i.code, i.version_no, i.committed_batch_id]), [['R-01', 1, null], ['R-02', 1, null]], '夹具：重复 add 以最后一次为准（版本与承诺批次都取后一次）');
  });

  test('C3b 集合修订：非总体规划包的草稿版本 409（S3）；非草稿版本 409（夹具 pending / effective）；对照：总体规划草稿可改', async () => {
    const pid = await newProject();
    const i1 = await createItem(U.pm, pid);
    const pkI = await mkPackage(pid, 'initiation');
    const pvI = await mkVersion(pkI);
    expectErr(await addRev(U.pm, pvI, i1.versions[0].id), 409, 'SYSBUILD_STATE', '初始包草稿版本 add（S3）');
    expectErr(await removeRev(U.pm, pvI, i1.versions[0].id), 409, 'SYSBUILD_STATE', '初始包草稿版本 remove（S3）');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pvI])).n, 0);
    // 夹具：初始包的草稿版本里其实有这条修订（C3b 生产路径写不进去）——此时 remove 的「不在集合」规则不再顶替「非总体规划包」规则
    const fx = await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, NULL, 'add', ?)", [pvI, i1.versions[0].id, U.pm]);
    expectErr(await removeRev(U.pm, pvI, i1.versions[0].id), 409, 'SYSBUILD_STATE', '夹具：集合里确有该条目的初始包草稿 remove（S3）');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pvI])).n, 1, '被拒绝的 remove 不写修订');
    await sqlRun('DELETE FROM sysbuild_package_item_revisions WHERE id = ?', [fx.lastID]);
    const pkO = await mkPackage(pid, 'overall');
    const pvO = await mkVersion(pkO);
    assert.strictEqual((await addRev(U.pm, pvO, i1.versions[0].id)).status, 201, '对照：总体规划草稿可 add');
    for (const st of ['pending', 'effective', 'superseded']) {
      await setVerStatus(pvO, st);
      const i2 = await createItem(U.pm, pid);
      expectErr(await addRev(U.pm, pvO, i2.versions[0].id), 409, 'SYSBUILD_STATE', `夹具：${st} 版本 add`);
      expectErr(await removeRev(U.pm, pvO, i1.versions[0].id), 409, 'SYSBUILD_STATE', `夹具：${st} 版本 remove`);
    }
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pvO])).n, 1, '被拒绝的请求都不写修订');
  });

  test('C3b 集合修订：承诺批次——他项目 / 不存在 400；已转出 / 被替代 409（夹具）；本项目其他批次可；remove 不能带批次；条目版本须属本项目；参数校验', async () => {
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const other = await newProject();
    const foreignBatch = await defaultBatchId(other);
    const foreignItem = await createItem(U.pm, other);
    const items = [];
    for (let i = 0; i < 6; i += 1) items.push(await createItem(U.pm, pid));
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    let rr = await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: foreignBatch });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '他项目批次');
    assert.strictEqual(rr.body.field, 'committed_batch_id');
    expectErr(await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: 99999999 }), 400, 'SYSBUILD_INVALID_INPUT', '批次不存在');
    expectErr(await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: 'x' }), 400, 'SYSBUILD_INVALID_INPUT', '批次编号非法');
    const transferred = await fixtureBatch(pid, 'transferred');
    const superseded = await fixtureBatch(pid, 'superseded');
    const second = await fixtureBatch(pid, 'planning');
    expectErr(await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: transferred }), 409, 'SYSBUILD_STATE', '夹具：已转出批次');
    expectErr(await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: superseded }), 409, 'SYSBUILD_STATE', '夹具：被替代批次');
    assert.strictEqual((await sqlGet('SELECT COUNT(*) AS n FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pv])).n, 0, '被拒绝的请求不写修订');
    assert.strictEqual((await addRev(U.pm, pv, items[0].versions[0].id, { committed_batch_id: second })).status, 201, '夹具：本项目另一个有效批次可挂');
    assert.strictEqual((await addRev(U.pm, pv, items[1].versions[0].id, { committed_batch_id: batch })).status, 201);
    rr = await post(U.pm, revUrl(pv), { op: 'remove', item_version_id: items[1].versions[0].id, committed_batch_id: batch });
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', 'remove 带批次');
    assert.strictEqual(rr.body.field, 'committed_batch_id');
    rr = await addRev(U.pm, pv, foreignItem.versions[0].id);
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', '他项目的条目版本');
    assert.strictEqual(rr.body.field, 'item_version_id');
    // 预筛 LOW-3：remove 对别项目的条目版本与 add 一样 400（不因「不在集合」报 409 而露出差别）
    rr = await removeRev(U.pm, pv, foreignItem.versions[0].id);
    expectErr(rr, 400, 'SYSBUILD_INVALID_INPUT', 'remove 他项目的条目版本');
    assert.strictEqual(rr.body.field, 'item_version_id');
    expectErr(await removeRev(U.pm, pv, 99999999), 400, 'SYSBUILD_INVALID_INPUT', 'remove 不存在的条目版本');
    expectErr(await addRev(U.pm, pv, 99999999), 400, 'SYSBUILD_INVALID_INPUT', '条目版本不存在');
    const bads = [[{ item_version_id: items[2].versions[0].id }, 'op', '缺 op'], [{ op: 'swap', item_version_id: items[2].versions[0].id }, 'op', 'op 非法'], [{ op: 'add' }, 'item_version_id', '缺条目版本'],
      [{ op: 'add', item_version_id: 'x' }, 'item_version_id', '条目版本编号非法'], [{ op: 'add', item_version_id: items[2].versions[0].id, extra: 1 }, 'extra', '多余键']];
    for (const [body, field, label] of bads) {
      const b = await post(U.pm, revUrl(pv), body);
      expectErr(b, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(b.body.field, field, `${label} 的 field`);
    }
    expectBodyNotObject(await post(U.pm, revUrl(pv), []), '数组请求体');
    expectErr(await post(U.pm, '/sysbuild/package-versions/99999999/items', { op: 'add', item_version_id: 1 }), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    expectErr(await post(U.pm, '/sysbuild/package-versions/abc/items', { op: 'add', item_version_id: 1 }), 400, 'SYSBUILD_INVALID_INPUT', '版本编号非法');
  });

  test('C3b 集合修订：权限与项目状态——一般成员 / 只读账号 / admin 未接管 403（含非草稿版本，权限先于状态）；非成员 404；暂停可改；终止 409', async () => {
    const pid = await newProject();
    await addMember(pid, U.m1);
    const item = await createItem(U.pm, pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.ro, '只读账号'], [U.admin, 'admin 未接管']]) {
      expectErr(await addRev(uid, pv, item.versions[0].id), 403, 'SYSBUILD_FORBIDDEN', label);
      expectErr(await removeRev(uid, pv, item.versions[0].id), 403, 'SYSBUILD_FORBIDDEN', `${label} remove`);
    }
    expectErr(await addRev(U.out, pv, item.versions[0].id), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    assert.strictEqual((await setStatus(pid, 'paused')).status, 200);
    assert.strictEqual((await addRev(U.pm, pv, item.versions[0].id)).status, 201, '暂停可改');
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    expectErr(await removeRev(U.pm, pv, item.versions[0].id), 409, 'SYSBUILD_PROJECT_READONLY', '终止后 remove');
    const another = await sqlRun("INSERT INTO sysbuild_items (project_id, code, created_by) VALUES (?, 'R-60', ?)", [pid, U.pm]);
    const anotherVer = await sqlRun("INSERT INTO sysbuild_item_versions (item_id, version_no, content, proposer_name, created_by) VALUES (?, 1, '终止期间的条目', '某人', ?)", [another.lastID, U.pm]);
    expectErr(await addRev(U.pm, pv, anotherVer.lastID), 409, 'SYSBUILD_PROJECT_READONLY', '终止后 add（另一个条目，避免被「已在集合」顶替）');
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
  test('C3b 现行版本解析（夹具 effective，含兄弟项目的生效版本）：现行版本 / 待处理版本 / 承诺批次由生效的总体规划版本决定；草稿与更新的版本不影响；无生效版本时全空且读不到别的项目的生效版本；非总体规划包不算；两个生效版本被唯一索引拒绝', async () => {
    const sibPv = await mkSiblingEffectiveOverall(); // 兄弟项目的生效版本：本项目的解析不得读到它
    const pid = await newProject();
    const batch = await defaultBatchId(pid);
    const i1 = await createItem(U.pm, pid);
    const i2 = await createItem(U.pm, pid);
    const i3 = await createItem(U.pm, pid);
    const v1b = (await newVersion(U.pm, i1.id)).body.item_version_id;
    const iv11 = i1.versions[0].id;
    const iv21 = i2.versions[0].id;
    const listOf = async () => (await get(U.pm, itemsUrl(pid))).body;
    const pick = (list, id) => list.items.find((i) => i.id === id);
    // 没有任何包：全部没有现行版本
    let list = await listOf();
    assert.strictEqual(list.overall_version_id, null, `本项目没有任何包，不能读到兄弟项目的生效版本 ${sibPv}`);
    for (const it of list.items) assert.deepStrictEqual([it.in_effective_plan, it.current_version_id, it.committed_batch_id, it.pending_version_ids], [false, null, null, []], `${it.code} 无生效版本`);
    // 草稿不算生效
    const pk = await mkPackage(pid, 'overall');
    const pv1 = await mkVersion(pk);
    assert.strictEqual((await addRev(U.pm, pv1, iv11, { committed_batch_id: batch })).status, 201);
    assert.strictEqual((await addRev(U.pm, pv1, iv21)).status, 201);
    list = await listOf();
    assert.strictEqual(list.overall_version_id, null, '草稿版本不算生效');
    assert.strictEqual(pick(list, i1.id).current_version_id, null);
    // 夹具：先让 v1 暂为已替代，建出带继承集合的草稿 v2 并改动它（总体规划一旦生效就不能直接建草稿，D1），再把 v1 置为 effective——此时「生效的 v1」与「内容不同的最新草稿 v2」并存
    await setVerStatus(pv1, 'superseded');
    const pv2 = await mkVersion(pk);
    assert.strictEqual((await removeRev(U.pm, pv2, iv11)).status, 201);
    assert.strictEqual((await addRev(U.pm, pv2, v1b)).status, 201);
    assert.strictEqual((await removeRev(U.pm, pv2, iv21)).status, 201);
    await setVerStatus(pv1, 'effective');
    list = await listOf();
    assert.strictEqual(list.overall_version_id, pv1, '仍读生效的 v1，不读最新的草稿 v2');
    assert.deepStrictEqual([pick(list, i2.id).current_version_id, pick(list, i2.id).committed_batch_id], [iv21, null], 'v2 草稿里已移出 i2，现行仍读 v1');
    assert.deepStrictEqual([pick(list, i1.id).in_effective_plan, pick(list, i1.id).current_version_id, pick(list, i1.id).committed_batch_id, pick(list, i1.id).pending_version_ids], [true, iv11, batch, [v1b]], 'i1：现行是 v1，v2 是待处理');
    assert.deepStrictEqual([pick(list, i2.id).current_version_id, pick(list, i2.id).committed_batch_id, pick(list, i2.id).pending_version_ids], [iv21, null, []], 'i2：现行 v1，承诺批次为空');
    assert.deepStrictEqual([pick(list, i3.id).in_effective_plan, pick(list, i3.id).current_version_id, pick(list, i3.id).pending_version_ids], [false, null, []], 'i3 未入生效规划');
    // 之后产生的条目版本是待处理版本，不改变现行版本
    const v1c = (await newVersion(U.pm, i1.id)).body.item_version_id;
    list = await listOf();
    assert.deepStrictEqual([pick(list, i1.id).current_version_id, pick(list, i1.id).pending_version_ids], [iv11, [v1b, v1c]]);
    // 草稿 v2（继承后移出 i2、把 i1 换成 v2）不影响现行解析
    list = await listOf();
    assert.strictEqual(list.overall_version_id, pv1);
    assert.deepStrictEqual([pick(list, i1.id).current_version_id, pick(list, i1.id).committed_batch_id], [iv11, batch]);
    // 换成 v2 生效（v1 被替代）：现行版本随之变化，i2 退出
    await setVerStatus(pv1, 'superseded');
    await setVerStatus(pv2, 'effective');
    list = await listOf();
    assert.strictEqual(list.overall_version_id, pv2);
    assert.deepStrictEqual([pick(list, i1.id).current_version_id, pick(list, i1.id).pending_version_ids], [v1b, [v1c]]);
    assert.deepStrictEqual([pick(list, i2.id).in_effective_plan, pick(list, i2.id).current_version_id], [false, null]);
    // 两个版本同时 effective：唯一索引拒绝
    await assert.rejects(setVerStatus(pv1, 'effective'), (e) => e && e.code === 'SQLITE_CONSTRAINT', '同包第二个生效版本（把被替代的 v1 再置为生效）应被唯一索引拒绝');
    // 非总体规划包的生效版本不算：夹具——立项包版本里塞一条修订并置为生效
    const pkI = await mkPackage(pid, 'initiation');
    const pvI = await mkVersion(pkI);
    await sqlRun("INSERT INTO sysbuild_package_item_revisions (package_version_id, item_version_id, committed_batch_id, op, created_by) VALUES (?, ?, NULL, 'add', ?)", [pvI, i3.versions[0].id, U.pm]);
    await setVerStatus(pvI, 'effective');
    list = await listOf();
    assert.strictEqual(list.overall_version_id, pv2, '立项包的生效版本不是总体规划');
    assert.strictEqual(pick(list, i3.id).in_effective_plan, false);
    // 详情接口与列表同源
    const one = (await get(U.pm, `/sysbuild/items/${i1.id}`)).body.item;
    assert.deepStrictEqual([one.current_version_id, one.pending_version_ids, one.committed_batch_id, one.in_effective_plan], [v1b, [v1c], null, true]);
  });

  test('C3b 包读接口：项目内包列表（版本、条目数、overall_version_id）与版本详情（集合、snapshot、actions）；非成员 404、只读账号可读', async () => {
    await mkSiblingEffectiveOverall(); // 兄弟项目有生效版本：下面「本项目 overall_version_id 为 null」才有判别力
    const pid = await newProject();
    const i1 = await createItem(U.pm, pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    assert.strictEqual((await addRev(U.pm, pv, i1.versions[0].id, { committed_batch_id: await defaultBatchId(pid) })).status, 201);
    const pkC = await mkPackage(pid, 'closing');
    let list = await get(U.pm, `/sysbuild/projects/${pid}/packages`);
    assert.strictEqual(list.status, 200, list.text);
    assert.strictEqual(list.body.overall_version_id, null);
    assert.deepStrictEqual(list.body.packages.map((p) => [p.id, p.type, p.batch_id, p.versions.length, p.actions.new_version]), [[pk, 'overall', null, 1, false], [pkC, 'closing', null, 0, true]]);
    assert.deepStrictEqual(list.body.packages[0].versions.map((v) => [v.id, v.version_no, v.status, v.form, v.item_count]), [[pv, 1, 'draft', 'overall_batch_req', 1]]);
    // C4a 交接 ②：经生产路径生效（需求部门参与方 + 提交 + 全部确认）
    await T.confirm.seedParty(pid, '甲部', U.own, U.del);
    await T.confirm.produceEffectiveInitiation(pid); // P37：总体规划包提交前须立项包已生效
    await T.confirm.planAllNodes(pid); // 修订批三 H-1：总体规划包提交前节点计划须齐全
    assert.strictEqual((await post(U.pm, `/sysbuild/package-versions/${pv}/submit`)).status, 200);
    await T.confirm.confirmAll(pv);
    list = await get(U.ro, `/sysbuild/projects/${pid}/packages`);
    assert.strictEqual(list.status, 200, '只读账号可读');
    assert.strictEqual(list.body.overall_version_id, pv);
    assert.ok(list.body.packages.every((p) => p.actions.new_version === false), '只读账号没有任何动作');
    const view = await get(U.ro, `/sysbuild/package-versions/${pv}`);
    assert.strictEqual(view.status, 200, view.text);
    assert.deepStrictEqual(view.body.actions, { edit: false, add_item: false, remove_item: false, new_version: false, submit: false, withdraw: false, export_sheet: true }); // C4c：读动作，只读账号可见即真（已生效版本）
    assert.deepStrictEqual(view.body.package, { id: pk, project_id: pid, batch_id: null, type: 'overall' });
    assert.deepStrictEqual([view.body.version.status, view.body.version.form], ['effective', 'overall_batch_req']);
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(view.body.version.effective_at), `effective_at 实际 ${view.body.version.effective_at}`);
    assert.deepStrictEqual(view.body.items.map((i) => [i.code, i.item_version_id]), [['R-01', i1.versions[0].id]]);
    assert.deepStrictEqual(view.body.snapshot_json, {});
    expectErr(await get(U.out, `/sysbuild/projects/${pid}/packages`), 404, 'SYSBUILD_NOT_FOUND', '非成员列表');
    expectErr(await get(U.out, `/sysbuild/package-versions/${pv}`), 404, 'SYSBUILD_NOT_FOUND', '非成员详情');
    expectErr(await get(U.pm, '/sysbuild/package-versions/99999999'), 404, 'SYSBUILD_NOT_FOUND', '版本不存在');
    expectErr(await get(U.pm, '/sysbuild/package-versions/abc'), 400, 'SYSBUILD_INVALID_INPUT', '编号非法');
  });

  // ── 9 actions 同源 ───────────────────────────────────────────────────────────────────────────────
  test('C3b actions 与执行同源：对每个视角（PM / 登记人 / 其他成员 / 只读账号 / admin）、每个项目状态与包版本状态，读接口的每个标志与实际调用的成败一致（夹具：版本状态直接改写）', async () => {
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
      const pmItem = await createItem(U.pm, pid);
      const m1Item = await createItem(U.m1, pid);
      const addItem = await createItem(U.pm, pid);
      const remItem = await createItem(U.pm, pid);
      const mod = (await post(U.pm, `/sysbuild/projects/${pid}/modules`, { name: '同源模块' })).body.module.id;
      const pkO = await mkPackage(pid, 'overall');
      const pkI = await mkPackage(pid, 'initiation');
      const pkC = await mkPackage(pid, 'closing');
      const pvO = await mkVersion(pkO);
      const pvI = await mkVersion(pkI);
      assert.strictEqual((await addRev(U.pm, pvO, remItem.versions[0].id)).status, 201);
      assert.strictEqual((await addRev(U.pm, pvI, remItem.versions[0].id)).status, 409, '初始包不能挂条目（S3）');
      const baseRev = (await sqlGet('SELECT MAX(id) AS m FROM sysbuild_package_item_revisions WHERE package_version_id = ?', [pvO])).m;
      if (projectStatus !== 'active') assert.strictEqual((await setStatus(pid, projectStatus)).status, 200);
      for (const st of states) {
        await setVerStatus(pvO, st);
        for (const [uid, who] of [[U.pm, 'PM'], [U.m1, '登记人'], [U.m2, '其他成员'], [U.ro, '只读账号'], [U.admin, 'admin']]) {
          const L = `${projectStatus}/${st}/${who}`;
          // 条目与模块
          const items = (await get(uid, itemsUrl(pid))).body;
          const flagOf = (it) => items.items.find((i) => i.id === it.id).actions;
          for (const it of [pmItem, m1Item]) {
            check(`${L} 条目 ${it.code} new_version`, flagOf(it).new_version, await newVersion(uid, it.id));
            await sqlRun('DELETE FROM sysbuild_item_versions WHERE item_id = ? AND version_no > 1', [it.id]);
            check(`${L} 条目 ${it.code} set_module`, flagOf(it).set_module, await patch(uid, `/sysbuild/items/${it.id}`, { module_id: mod }));
            await sqlRun('UPDATE sysbuild_items SET module_id = NULL WHERE id = ?', [it.id]);
          }
          check(`${L} 模块 rename`, items.modules[0].actions.rename, await patch(uid, `/sysbuild/modules/${mod}`, { name: `同源改名${nameSeq += 1}` }));
          await sqlRun('UPDATE sysbuild_modules SET name = ? WHERE id = ?', ['同源模块', mod]);
          check(`${L} create_item`, items.actions.create_item, await post(uid, itemsUrl(pid), itemBody()));
          check(`${L} create_module`, items.actions.create_module, await post(uid, `/sysbuild/projects/${pid}/modules`, { name: `同源新模块${nameSeq += 1}` }));
          // 内容包版本
          for (const [pv, pk, pkgType] of [[pvO, pkO, 'overall'], [pvI, pkI, 'initiation']]) {
            const view = (await get(uid, `/sysbuild/package-versions/${pv}`)).body;
            const A = view.actions;
            check(`${L} ${pkgType} edit`, A.edit, await patch(uid, `/sysbuild/package-versions/${pv}`, { snapshot_json: { n: nameSeq += 1 } }));
            check(`${L} ${pkgType} add_item`, A.add_item, await addRev(uid, pv, addItem.versions[0].id));
            check(`${L} ${pkgType} remove_item`, A.remove_item, await removeRev(uid, pv, remItem.versions[0].id));
            await sqlRun('DELETE FROM sysbuild_package_item_revisions WHERE package_version_id = ? AND id > ?', [pv, pv === pvO ? baseRev : 1e9]);
            if (pv === pvO) check(`${L} ${pkgType} new_version`, A.new_version, await post(uid, `/sysbuild/packages/${pk}/versions`));
            if (pv === pvO) {
              await sqlRun('DELETE FROM sysbuild_package_item_revisions WHERE package_version_id IN (SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?)', [pk, pvO]);
              await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?', [pk, pvO]);
            }
          }
          // 包列表里的 new_version：总体规划包（草稿 / 待确认 / 生效三种状态各不同）与结项包（没有任何版本）
          const listed = (await get(uid, `/sysbuild/projects/${pid}/packages`)).body.packages;
          check(`${L} 列表 overall new_version`, listed.find((p) => p.id === pkO).actions.new_version, await post(uid, `/sysbuild/packages/${pkO}/versions`));
          await sqlRun('DELETE FROM sysbuild_package_item_revisions WHERE package_version_id IN (SELECT id FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?)', [pkO, pvO]);
          await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ? AND id <> ?', [pkO, pvO]);
          check(`${L} 列表 closing new_version`, listed.find((p) => p.id === pkC).actions.new_version, await post(uid, `/sysbuild/packages/${pkC}/versions`));
          await sqlRun('DELETE FROM sysbuild_package_versions WHERE package_id = ?', [pkC]);
        }
      }
    }
    assert.ok(seen.true > 30 && seen.false > 60, `两种结果都要覆盖到：${JSON.stringify(seen)}`);
  });

}

// ── 变异（锚点必须在被测文件副本里恰好出现一次）──────────────────────────────────────────────────
const ITEM_MUTATIONS = [
  // 模块
  { id: 'C3b 模块重名检查删掉（建）', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: "rules.assertOp('module_create', access, access.project, { nameTaken: !!taken });", to: "rules.assertOp('module_create', access, access.project, { nameTaken: false });" }] },
  { id: 'C3b 模块重名检查删掉（改名）', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: "rules.assertOp('module_rename', access, access.project, { nameTaken: !!taken });", to: "rules.assertOp('module_rename', access, access.project, { nameTaken: false });" }] },
  { id: 'C3b 模块重名判定的 state 函数恒为空', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'rules.js', from: "const moduleNameState = (t) => (t.nameTaken ? '本项目已有同名模块' : null);", to: 'const moduleNameState = () => null;' }] },
  { id: 'C3b 模块改名的重名查询不排除自己', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: 'WHERE project_id = ? AND name = ? AND id <> ?\', [mod.project_id, name, mid]', to: 'WHERE project_id = ? AND name = ? AND ? IS NOT NULL\', [mod.project_id, name, mid]' }] },
  { id: 'C3b 模块重名比较忽略大小写', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: "const taken = await q.get('SELECT id FROM sysbuild_modules WHERE project_id = ? AND name = ?', [pid, name]);", to: "const taken = await q.get('SELECT id FROM sysbuild_modules WHERE project_id = ? AND lower(name) = lower(?)', [pid, name]);" }] },
  { id: 'C3b 模块重名查询不限项目', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: "const taken = await q.get('SELECT id FROM sysbuild_modules WHERE project_id = ? AND name = ?', [pid, name]);", to: "const taken = await q.get('SELECT id FROM sysbuild_modules WHERE ? IS NOT NULL AND name = ?', [pid, name]);" }] },
  { id: 'C3b 模块名不 trim 后比较（readText 不 trim）', expect: ['C3b 模块：PM 建模块'], edits: [{ file: 'items.js', from: '  const v = raw.trim();\n  if (v === \'\') {', to: '  const v = raw;\n  if (v.trim() === \'\') {' }] },
  { id: 'C3b 模块端点放过多余键', expect: ['C3b 模块：参数校验'], edits: [{ file: 'items.js', from: "onlyKeys(body, ['name']);\n    const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);\n    const user = req.user;\n    const out = await db.withWriteTxn(async (q) => {\n      const access = await loadProjectCtx", to: "const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);\n    const user = req.user;\n    const out = await db.withWriteTxn(async (q) => {\n      const access = await loadProjectCtx" }] },
  { id: 'C3b items.js 的 readText 不拒控制字符', expect: ['C3b 模块：参数校验'], edits: [{ file: 'items.js', from: 'if (rules.hasControlChar(v)) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b items.js 的 bodyOf 放过数组请求体', expect: ['C3b 模块：参数校验'], edits: [{ file: 'items.js', from: "if (typeof b !== 'object' || Array.isArray(b)) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3b 模块名长度上限放宽', expect: ['C3b 模块：参数校验'], edits: [{ file: 'items.js', from: 'const MODULE_NAME_MAX = 60;', to: 'const MODULE_NAME_MAX = 600;' }] },
  // 条目创建
  { id: 'C3b 条目编号固定为 R-01', expect: ['C3b 条目创建：编号'], edits: [{ file: 'items.js', from: "const code = 'R-' + String(mx.m + 1).padStart(2, '0');", to: "const code = 'R-' + String(1).padStart(2, '0');" }] },
  { id: 'C3b 条目编号不补两位', expect: ['C3b 条目创建：编号'], edits: [{ file: 'items.js', from: "String(mx.m + 1).padStart(2, '0')", to: 'String(mx.m + 1)' }] },
  { id: 'C3b 条目编号取项目内条目总数 + 1（跳号后撞号）', expect: ['C3b 条目创建：编号'], edits: [{ file: 'items.js', from: 'SELECT COALESCE(MAX(CAST(substr(code, 3) AS INTEGER)), 0) AS m FROM sysbuild_items WHERE project_id = ?', to: 'SELECT COUNT(*) AS m FROM sysbuild_items WHERE project_id = ?' }] },
  { id: 'C3b 条目版本 1 的提出人状态写成已确认', expect: ['C3b 条目创建：编号'], edits: [{ file: 'items.js', from: "proposer_status, no_written_evidence, no_evidence_reason, created_by) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,", to: "proposer_status, no_written_evidence, no_evidence_reason, created_by) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`," }] },
  { id: 'C3b 方向类证据校验删掉（创建）', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "if (!ev.noEvidence && count === 0) {", to: 'if (false) {' }] },
  { id: 'C3b 无书面证据原因 10 字校验删掉', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: 'if (ev.noEvidence && (ev.noEvidenceReason === null || Array.from(ev.noEvidenceReason).length < EVIDENCE_REASON_MIN)) {', to: 'if (false) {' }] },
  { id: 'C3b 删掉「附件与无书面证据互斥」', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "if (ev.noEvidence && count > 0) throw invalid('已附证据附件，不应再声明无书面证据', 'no_written_evidence');", to: '' }] },
  { id: 'C3b 删掉「未声明却给原因」', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "if (!ev.noEvidence && ev.noEvidenceReason !== null) throw invalid('未声明无书面证据时不应填写无书面证据原因', 'no_evidence_reason');", to: '' }] },
  { id: 'C3b 创建不绑定证据附件', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "const bound = attachmentIds.length > 0\n        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid,", to: "const bound = false\n        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: pid," }] },
  { id: 'C3b 证据附件绑定到条目而不是版本（owner_type 写错）', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) })\n        : [];\n      await emit(q, user, pid, 'item'", to: "ownerType: 'entry', ownerId: vr.lastID, operatorName: operatorNameOf(user) })\n        : [];\n      await emit(q, user, pid, 'item'" }] },
  { id: 'C3b 提出人是成员时参与方不取成员行', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: 'return { memberId: m.id, name: null, partyId: m.party_id };', to: 'return { memberId: m.id, name: null, partyId: null };' }] },
  { id: 'C3b 提出人成员不查已移出 / 未加入', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: 'if (m.removed_at !== null || m.joined_at === null) throw stateError(', to: 'if (false) throw stateError(' }] },
  { id: 'C3b 提出人成员不限本项目', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: "FROM sysbuild_members WHERE id = ? AND project_id = ?', [group.memberId, pid]", to: "FROM sysbuild_members WHERE id = ? AND ? IS NOT NULL', [group.memberId, pid]" }] },
  { id: 'C3b 无账号提出人的参与方不限本项目', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: "const p = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND project_id = ?', [group.partyId, pid]);", to: "const p = await q.get('SELECT id FROM sysbuild_parties WHERE id = ? AND ? IS NOT NULL', [group.partyId, pid]);" }] },
  { id: 'C3b 提出人成员与姓名可同时给', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: "if (memberGiven && name !== null) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3b 提出人成员与参与方可同时给', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: "if (memberGiven && partyGiven) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3b 只给参与方也算给了提出人', expect: ['C3b 条目创建：提出人'], edits: [{ file: 'items.js', from: "if (!memberGiven && name === null) throw invalid(", to: 'if (false) throw invalid(' }] },
  { id: 'C3b 创建时模块不查是否属本项目', expect: ['C3b 条目创建：模块须属本项目'], edits: [{ file: 'items.js', from: "const m = await q.get('SELECT id FROM sysbuild_modules WHERE id = ? AND project_id = ?', [moduleId, pid]);", to: "const m = await q.get('SELECT id FROM sysbuild_modules WHERE id = ? AND ? IS NOT NULL', [moduleId, pid]);" }] },
  { id: 'C3b 内容长度上限放宽', expect: ['C3b 条目创建：模块须属本项目'], edits: [{ file: 'items.js', from: 'const CONTENT_MAX = 4000;', to: 'const CONTENT_MAX = 40000;' }] },
  { id: 'C3b 附件列表上限去掉', expect: ['C3b 条目创建：模块须属本项目'], edits: [{ file: 'items.js', from: 'if (raw.length > ATTACHMENT_LIST_MAX) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b 附件列表重复不拒', expect: ['C3b 条目创建：模块须属本项目'], edits: [{ file: 'items.js', from: 'if (new Set(ids).size !== ids.length) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b 条目端点放过多余键', expect: ['C3b 条目创建：模块须属本项目'], edits: [{ file: 'items.js', from: "onlyKeys(body, ['module_id', 'content', 'quote_text', 'proposer_member_id', 'proposer_name', 'proposer_party_id', 'occasion', 'proposed_on', 'attachment_ids', 'no_written_evidence', 'no_evidence_reason']);", to: '' }] },
  { id: 'C3b 条目创建的权限判定放宽到任何可见者（admin 未接管可建）', expect: ['C3b 条目创建：权限'], edits: [{ file: 'rules.js', from: '  return !!(!identity.isReadonly && identity.isMember);', to: '  return !!(!identity.isReadonly && (identity.isMember || identity.isAdmin));' }] },
  { id: 'C3b 条目创建去掉只读否决', expect: ['C3b 条目创建：权限'], edits: [{ file: 'rules.js', from: '  return !!(!identity.isReadonly && identity.isMember);', to: '  return !!identity.isMember;' }] },
  // 条目新版本
  { id: 'C3b S1 放宽为全体成员', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm || (identity.isMember && t.isCreator === true));', to: 'return !!(identity.isPm || identity.isMember);' }] },
  { id: 'C3b S1 去掉登记人本人（只剩 PM）', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm || (identity.isMember && t.isCreator === true));', to: 'return !!identity.isPm;' }] },
  { id: 'C3b S1 登记人判定改成人人都是（isCreator 恒真）', expect: ['C3b 条目新版本：S1', 'C3b 读接口'], edits: [{ file: 'items.js', from: 'const itemTarget = (item, user) => ({ isCreator: Number(item.created_by) === Number(user.id) });', to: 'const itemTarget = () => ({ isCreator: true });' }] },
  { id: 'C3b S1 去掉只读否决', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'rules.js', from: '  if (identity.isReadonly) return false;\n  return !!(identity.isPm || (identity.isMember && t.isCreator === true));', to: '  return !!(identity.isPm || (identity.isMember && t.isCreator === true));' }] },
  { id: 'C3b 新版本号固定为 2', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'items.js', from: 'const versionNo = prev.version_no + 1;', to: 'const versionNo = 2;' }] },
  { id: 'C3b 新版本不沿用上一版本的提出人', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'items.js', from: ': { memberId: prev.proposer_member_id, name: prev.proposer_name, partyId: prev.proposer_party_id };', to: ': { memberId: null, name: \'未知\', partyId: null };' }] },
  { id: 'C3b 新版本沿用的提出人取自第一版而不是上一版', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'items.js', from: 'const prev = old[old.length - 1];', to: 'const prev = old[0];' }] },
  { id: 'C3b 新版本给了提出人也不替换', expect: ['C3b 条目新版本：S1'], edits: [{ file: 'items.js', from: 'const proposer = group.given\n        ? await resolveProposer(q, group, item.project_id)', to: 'const proposer = false\n        ? await resolveProposer(q, group, item.project_id)' }] },
  { id: 'C3b 新版本的证据校验不计入沿用', expect: ['C3b 条目新版本：必须有证据'], edits: [{ file: 'items.js', from: 'assertEvidence(attachmentIds.length + refIds.length, ev);', to: 'assertEvidence(attachmentIds.length, ev);' }] },
  { id: 'C3b 新版本不要求证据', expect: ['C3b 条目新版本：必须有证据'], edits: [{ file: 'items.js', from: 'assertEvidence(attachmentIds.length + refIds.length, ev);', to: '' }] },
  { id: 'C3b 新版本的新附件不绑定', expect: ['C3b 条目新版本：必须有证据'], edits: [{ file: 'items.js', from: "const bound = attachmentIds.length > 0\n        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: item.project_id,", to: "const bound = false\n        ? await attachmentHelpers.bindStagedAttachments(q, { projectId: item.project_id," }] },
  { id: 'C3b S6 去掉遮蔽检查', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: 'if (att.masked_at) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b S6 去掉软删除检查', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: 'if (att.deleted_at) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b S6 去掉「本条目旧版本」限制', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: 'if (!bound && !refd) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C3b S6 只认绑定不认引用', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: 'const refd = bound ? null : await q.get(', to: 'const refd = true ? null : await q.get(' }] },
  // MED-1：直接删掉 owner_type 字面量（不加占位符、参数个数不变），必须由「S6 所属类型」夹具用例判红，而不是由别的断言顺带判红
  { id: 'C3b S6 绑定查询不限 item_version 类型（直接删字面量）', expect: ['C3b 条目新版本：S6 所属类型'], edits: [{ file: 'items.js', from: "WHERE b.attachment_id = ? AND b.owner_type = 'item_version' AND iv.item_id = ?", to: 'WHERE b.attachment_id = ? AND iv.item_id = ?' }] },
  { id: 'C3b S6 引用查询不限 item_version 类型（直接删字面量）', expect: ['C3b 条目新版本：S6 所属类型'], edits: [{ file: 'items.js', from: "WHERE r.attachment_id = ? AND r.owner_type = 'item_version' AND iv.item_id = ?", to: 'WHERE r.attachment_id = ? AND iv.item_id = ?' }] },
  { id: 'C3b S6 不查附件是否存在（空行当成可用）', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: 'if (!att || att.project_id !== pid) throw invalid(', to: 'if (att && att.project_id !== pid) throw invalid(' }] },
  { id: 'C3b 沿用的附件绑定错误被吞掉（新附件校验失败仍出版本）', expect: ['C3b 条目新版本：附件校验失败'], edits: [{ file: 'items.js', from: "ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) })\n        : [];\n      for (const aid of refIds) {", to: "ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) }).catch(() => [])\n        : [];\n      for (const aid of refIds) {" }] },
  { id: 'C3b 创建时附件绑定错误被吞掉（条目照常创建）', expect: ['C3b 条目创建：方向类证据'], edits: [{ file: 'items.js', from: "ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) })\n        : [];\n      await emit(q, user, pid, 'item'", to: "ownerType: 'item_version', ownerId: vr.lastID, operatorName: operatorNameOf(user) }).catch(() => [])\n        : [];\n      await emit(q, user, pid, 'item'" }] },
  { id: 'C3b 沿用不写引用行', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: "await q.run(\"INSERT INTO sysbuild_attachment_refs (project_id, attachment_id, owner_type, owner_id, ref_by) VALUES (?, ?, 'item_version', ?, ?)\", [item.project_id, aid, vr.lastID, uid]);", to: '' }] },
  { id: 'C3b 沿用不写 attachment_referenced 事件', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: "await emit(q, user, item.project_id, 'attachment', aid, 'attachment_referenced', { owner_type: 'item_version', owner_id: vr.lastID, item_id: iid });", to: '' }] },
  { id: 'C3b 引用事件带上附件原名', expect: ['C3b 条目新版本：S6'], edits: [{ file: 'items.js', from: "{ owner_type: 'item_version', owner_id: vr.lastID, item_id: iid });", to: "{ owner_type: 'item_version', owner_id: vr.lastID, item_id: iid, original_name: '证据文件.txt' });" }] },
  { id: 'C3b 新版本端点放过多余键', expect: ['C3b 条目新版本：必须有证据'], edits: [{ file: 'items.js', from: "onlyKeys(body, ['content', 'quote_text', 'proposer_member_id', 'proposer_name', 'proposer_party_id', 'occasion', 'proposed_on', 'attachment_ids', 'ref_attachment_ids', 'no_written_evidence', 'no_evidence_reason']);", to: '' }] },
  // 改模块
  { id: 'C3b 改模块不查是否属本项目', expect: ['C3b 条目改模块'], edits: [{ file: 'items.js', from: "const m = await q.get('SELECT id FROM sysbuild_modules WHERE id = ? AND project_id = ?', [moduleId, pid]);", to: "const m = await q.get('SELECT id FROM sysbuild_modules WHERE id = ? AND ? IS NOT NULL', [moduleId, pid]);" }] },
  { id: 'C3b 改模块放宽到登记人', expect: ['C3b 条目改模块'], edits: [{ file: 'rules.js', from: '  item_set_module: Object.freeze({ can: canActAsPm, state: noStateLimit }),', to: '  item_set_module: Object.freeze({ can: canCreateItemVersion, state: noStateLimit }),' }] },
  { id: 'C3b 改模块没有变化也写事件', expect: ['C3b 条目改模块'], edits: [{ file: 'items.js', from: 'if (moduleId !== item.module_id) {', to: 'if (true) {' }] },
  { id: 'C3b 改模块事件缺 before', expect: ['C3b 条目改模块'], edits: [{ file: 'items.js', from: "{ before: item.module_id, after: moduleId }", to: '{ after: moduleId }' }] },
  { id: 'C3b 改模块不要求给出 module_id 键', expect: ['C3b 条目改模块'], edits: [{ file: 'items.js', from: "if (!hasKey(body, 'module_id')) throw invalid('module_id 必填（置空传 null）', 'module_id');", to: '' }] },
  // 包创建
  { id: 'C3b S2 删掉（批次需求包可建）', expect: ['C3b 包创建：'], edits: [{ file: 'rules.js', from: "if (t.type === 'batch_req') return '单批项目的批次需求在总体规划包里维护';", to: '' }] },
  { id: 'C3b 变更包可建', expect: ['C3b 包创建：'], edits: [{ file: 'rules.js', from: "if (t.type === 'change') return '变更包只经正式变更产生，不能在这里创建';", to: '' }] },
  { id: 'C3b 包唯一性预查删掉（项目级）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "return !!(await q.get('SELECT id FROM sysbuild_packages WHERE project_id = ? AND type = ?', [pid, type]));", to: 'return false;' }] },
  { id: 'C3b 包唯一性预查删掉（批次级）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));", to: 'return false;' }] },
  // LOW-2：预查不限本项目批次 → 别项目批次上有验收包时 409 泄露（目标用例是包创建里「他项目的批次（该批次上已有验收包）」那一段）
  { id: 'C3b 验收包预查不限本项目批次（别项目批次上的验收包被探测到）', expect: ['C3b 包创建：overall'], edits: [{ file: 'packages.js', from: "return !!(batch && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));", to: "return !!(batchId !== null && await q.get('SELECT id FROM sysbuild_packages WHERE batch_id = ? AND type = ?', [batchId, type]));" }] },
  { id: 'C3b 包唯一性的 state 判定删掉', expect: ['C3b 包创建：'], edits: [{ file: 'rules.js', from: "if (t.exists) return '该项目（或该批次）已有同类型的内容包，每个只能有一个';", to: '' }] },
  { id: 'C3b 验收包的批次不查是否属本项目', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, pid]);", to: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND ? IS NOT NULL', [batchId, pid]);" }] },
  { id: 'C3b 验收包不要求批次', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (!givenBatch) throw invalid('该类型的内容包必须指定批次', 'batch_id');", to: '' }] },
  { id: 'C3b 非批次包带批次不拒', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "} else if (givenBatch) {\n      throw invalid('该类型的内容包不挂批次', 'batch_id');\n    }", to: '}' }] },
  { id: 'C3b 包类型不查枚举（overall_batch_req 可建）', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (typeof body.type !== 'string' || !schema.ENUMS.packageType.includes(body.type)) {", to: "if (typeof body.type !== 'string') {" }] },
  { id: 'C3b 验收包的已转出 / 被替代批次不拒', expect: ['C3b 包创建：'], edits: [{ file: 'rules.js', from: "return batchFrozen(t) ? '批次已转出或被替代，不能再建内容包' : null;", to: 'return null;' }] },
  { id: 'C3b 建包端点放过多余键', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "onlyKeys(body, ['type', 'batch_id']);", to: '' }] },
  { id: 'C3b 建包权限放宽为 PM 或 admin', expect: ['C3b 包创建：权限'], edits: [{ file: 'rules.js', from: "  package_create: Object.freeze({\n    can: canActAsPm,", to: "  package_create: Object.freeze({\n    can: canManageMembership," }] },
  // 包版本
  { id: 'C3b S4 删掉（已有草稿可再建）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'rules.js', from: "if (t.hasDraft) return '该内容包已有草稿版本，请先在草稿上修改';", to: '' }] },
  { id: 'C3b 已有待确认版本仍可建新草稿', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'rules.js', from: "return t.hasPending ? '该内容包已有待确认的版本，请等待处理后再建新版本' : null;", to: 'return null;' }] },
  { id: 'C3b 草稿判定漏看（hasDraft 恒假）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "hasDraft: versions.some((v) => v.status === 'draft')", to: 'hasDraft: false' }] },
  { id: 'C3b 待确认判定漏看（hasPending 恒假）', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "hasPending: versions.some((v) => v.status === 'pending')", to: 'hasPending: false' }] },
  { id: 'C3b form 判定反转', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "form = cnt.n === 1 ? 'overall_batch_req' : 'overall';", to: "form = cnt.n === 1 ? 'overall' : 'overall_batch_req';" }] },
  { id: 'C3b form 不排除已转出 / 被替代批次', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "status NOT IN (${marks})`, [pkg.project_id, ...rules.BATCH_FROZEN_STATUSES]);", to: "status NOT IN (${marks})`, [pkg.project_id, 'x', 'y']);" }] },
  { id: 'C3b form 对其他包也填写', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: "if (pkg.type === 'overall') {\n    const marks", to: "if (true) {\n    const marks" }] },
  { id: 'C3b parent 对总体规划包也填写', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (true) parentId =' }] }, // C6a：锚点随结项包也取 parent 改写
  { id: 'C3b parent 不填（批次包的父版本丢失）', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (false) parentId =' }] },
  { id: 'C6a parent 不对结项包填写（结项包引用结项时的现行版本丢失）', expect: ['C3b 包版本：批次验收包'], edits: [{ file: 'packages.js', from: "if (pkg.batch_id !== null || pkg.type === 'closing') parentId =", to: 'if (pkg.batch_id !== null) parentId =' }] },
  { id: 'C3b 新草稿不继承上一版本集合', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: 'if (prev) {\n        const prevSet', to: 'if (false) {\n        const prevSet' }] },
  { id: 'C3b 继承取第一个版本而不是最大 version_no', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: 'const prev = versions.length > 0 ? versions[versions.length - 1] : null;', to: 'const prev = versions.length > 0 ? versions[0] : null;' }] },
  { id: 'C3b 继承丢掉承诺批次', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: '[ins.lastID, it.item_version_id, it.committed_batch_id, uid]', to: '[ins.lastID, it.item_version_id, null, uid]' }] },
  { id: 'C3b 继承时 created_by 写成原作者', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: '[ins.lastID, it.item_version_id, it.committed_batch_id, uid]', to: '[ins.lastID, it.item_version_id, it.committed_batch_id, 1]' }] },
  { id: 'C3b 继承把已移出的条目也复制（只回放 add 不折叠）', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: "else if (r.op === 'remove') delete byItem[r.item_id];", to: '' }] },
  { id: 'C3b 新版本号固定为 1', expect: ['C3b 包版本：首个草稿'], edits: [{ file: 'packages.js', from: 'const versionNo = prev ? prev.version_no + 1 : 1;', to: 'const versionNo = 1;' }] },
  { id: 'C3b 建版本端点放过多余键', expect: ['C3b 包版本：权限'], edits: [{ file: 'packages.js', from: "const pkid = readIdParam(req.params.pkid, 'pkid', '内容包编号');\n    onlyKeys(bodyOf(req), []);", to: "const pkid = readIdParam(req.params.pkid, 'pkid', '内容包编号');" }] },
  { id: 'C3b 建版本权限放宽为 PM 或 admin', expect: ['C3b 包版本：权限'], edits: [{ file: 'rules.js', from: "  package_version_create: Object.freeze({\n    can: canActAsPm,", to: "  package_version_create: Object.freeze({\n    can: canManageMembership," }] },
  // 集合修订
  { id: 'C3b 重复 add 检查删掉', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'rules.js', from: "if (t.inSet === true) return '该条目已在集合中，如需换版本请先移出';", to: '' }] },
  { id: 'C3b add 的 inSet 按条目版本而不是按条目判定', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'packages.js', from: 'const inSet = !!iv && hasKey(set, iv.item_id);\n        rules.assertOp(\'package_item_add\'', to: 'const inSet = !!iv && hasKey(set, iv.item_id) && set[iv.item_id].item_version_id === itemVersionId;\n        rules.assertOp(\'package_item_add\'' }] },
  { id: 'C3b remove 不在集合检查删掉', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'rules.js', from: "return t.inSet === false ? '该条目版本不在集合中' : null;", to: 'return null;' }] },
  { id: 'C3b remove 只按条目判定（集合里是另一个版本也放行）', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'packages.js', from: 'const inSet = iv ? hasKey(set, iv.item_id) && set[iv.item_id].item_version_id === itemVersionId : undefined;', to: 'const inSet = iv ? hasKey(set, iv.item_id) : undefined;' }] },
  // LOW-3：remove 对别项目的条目版本也要 400（回到 `!!iv &&` 的写法 inSet 为 false → 409）
  { id: 'C3b remove 对他项目的条目版本报 409 而不是 400', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: 'const inSet = iv ? hasKey(set, iv.item_id) && set[iv.item_id].item_version_id === itemVersionId : undefined;', to: 'const inSet = !!iv && hasKey(set, iv.item_id) && set[iv.item_id].item_version_id === itemVersionId;' }] },
  { id: 'C3b 折叠按先到先得（后一次 add 不覆盖）', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'packages.js', from: "if (r.op === 'add') byItem[r.item_id] =", to: "if (r.op === 'add' && !hasKey(byItem, r.item_id)) byItem[r.item_id] =" }] },
  { id: 'C3b S3 删掉（非总体规划包可修订集合）', expect: ['C3b 集合修订：非总体规划包'], edits: [{ file: 'rules.js', from: "      // S3（主会话自决）：C3 只在总体规划包的版本上做条目集合修订；其他类型的包版本只编辑 snapshot_json。C5 S-S1c：变更包版本是「提议的下一版完整总体规划」，同样可以修订集合。\n      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      if (t.inSet === true)", to: "      if (t.inSet === true)" }] }, // S-S1c：锚点随条件放宽到变更包而改写
  { id: 'C3b remove 的总体规划包限制删掉', expect: ['C3b 集合修订：非总体规划包'], edits: [{ file: 'rules.js', from: "      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false", to: "      return t.inSet === false" }] }, // S-S1c：锚点随条件放宽到变更包而改写
  { id: 'C3b add 的草稿检查删掉', expect: ['C3b 集合修订：非总体规划包'], edits: [{ file: 'rules.js', from: "      if (t.versionStatus !== 'draft') return '只有草稿版本可以修订条目集合';\n      // D2：批次包所在批次已冻结时先报这一条", to: '      // D2：批次包所在批次已冻结时先报这一条' }] },
  { id: 'C3b remove 的草稿检查删掉', expect: ['C3b 集合修订：非总体规划包'], edits: [{ file: 'rules.js', from: "      if (t.versionStatus !== 'draft') return '只有草稿版本可以修订条目集合';\n      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';\n      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false", to: "      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';\n      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false" }] }, // S-S1c：锚点随条件放宽到变更包而改写
  { id: 'C3b 承诺批次不查是否属本项目', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND project_id = ?', [batchId, pkg.project_id]);", to: "const batch = batchId === null ? null : await q.get('SELECT id, status FROM sysbuild_batches WHERE id = ? AND ? IS NOT NULL', [batchId, pkg.project_id]);" }] },
  { id: 'C3b 承诺批次的已转出 / 被替代检查删掉', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'rules.js', from: "return batchFrozen({ batchStatus: t.commitBatchStatus }) ? '承诺批次已转出或被替代，不能再挂条目' : null;", to: 'return null;' }] },
  { id: 'C3b 条目版本不查是否属本项目', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: "WHERE iv.id = ? AND it.project_id = ?',\n        [itemVersionId, pkg.project_id]", to: "WHERE iv.id = ? AND ? IS NOT NULL',\n        [itemVersionId, pkg.project_id]" }] },
  { id: 'C3b remove 带批次不拒', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: "if (op === 'remove') throw invalid('移出条目不需要承诺批次', 'committed_batch_id');", to: '' }] },
  { id: 'C3b 集合修订端点放过多余键', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: "onlyKeys(body, ['op', 'item_version_id', 'committed_batch_id']);", to: '' }] },
  { id: 'C3b op 不查枚举', expect: ['C3b 集合修订：承诺批次'], edits: [{ file: 'packages.js', from: "if (body.op !== 'add' && body.op !== 'remove') throw invalid('op 必须是 add 或 remove', 'op');", to: '' }] },
  { id: 'C3b 集合修订权限放宽为 PM 或 admin（add）', expect: ['C3b 集合修订：权限'], edits: [{ file: 'rules.js', from: "  package_item_add: Object.freeze({\n    can: canActAsPm,", to: "  package_item_add: Object.freeze({\n    can: canManageMembership," }] },
  { id: 'C3b 集合修订权限放宽为 PM 或 admin（remove）', expect: ['C3b 集合修订：权限'], edits: [{ file: 'rules.js', from: "  package_item_remove: Object.freeze({\n    can: canActAsPm,", to: "  package_item_remove: Object.freeze({\n    can: canManageMembership," }] },
  { id: 'C3b 集合修订事件缺条目版本', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'packages.js', from: "revision_id: ins.lastID, item_id: iv.item_id, item_version_id: itemVersionId, committed_batch_id: batchId,", to: 'revision_id: ins.lastID, item_id: iv.item_id, committed_batch_id: batchId,' }] },
  { id: 'C3b 修订的 created_by 写成固定值', expect: ['C3b 集合修订：add / remove 折叠'], edits: [{ file: 'packages.js', from: "[vid, itemVersionId, batchId, op, uid]", to: '[vid, itemVersionId, batchId, op, 1]' }] },
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
  { id: 'C3b snapshot 编辑权限放宽为 PM 或 admin', expect: ['C3b snapshot 编辑'], edits: [{ file: 'rules.js', from: "package_version_edit: Object.freeze({ can: canActAsPm, state: withFrozenBatch(draftVersionState) }),", to: 'package_version_edit: Object.freeze({ can: canManageMembership, state: withFrozenBatch(draftVersionState) }),' }] },
  // 解析函数
  { id: 'C3b 解析函数改读最新版本而不是生效版本', expect: ['C3b 现行版本解析'], edits: [{ file: 'packages.js', from: "AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,", to: "AND p.type = 'overall' ORDER BY v.id DESC LIMIT 1`," }] },
  { id: 'C3b 解析函数不限总体规划包', expect: ['C3b 现行版本解析'], edits: [{ file: 'packages.js', from: "AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,", to: "AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`," }] },
  { id: 'C3b 解析函数不限本项目', expect: ['C3b 现行版本解析', 'C3b 读接口：条目列表', 'C3b 包版本：批次验收包的 parent_overall_version_id', 'C3b 包读接口：项目内包列表'], edits: [{ file: 'packages.js', from: "WHERE p.project_id = ? AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,\n    [projectId]", to: "WHERE ? IS NOT NULL AND p.type = 'overall' AND v.status = 'effective' ORDER BY v.id DESC LIMIT 1`,\n    [projectId]" }] },
  { id: 'C3b 解析函数不折叠修订（只看 add）', expect: ['C3b 现行版本解析'], edits: [{ file: 'packages.js', from: "else if (r.op === 'remove') delete byItem[r.item_id];", to: '' }] },
  { id: 'C3b 条目现行版本取最新版本而不是生效版本引用', expect: ['C3b 现行版本解析'], edits: [{ file: 'items.js', from: 'const currentVersion = entry ? versions.find((v) => v.id === entry.item_version_id) : null;', to: 'const currentVersion = entry ? versions[versions.length - 1] : null;' }, { file: 'items.js', from: 'current_version_id: entry ? entry.item_version_id : null,', to: 'current_version_id: entry ? versions[versions.length - 1].id : null,' }] },
  { id: 'C3b 待处理版本包含现行版本本身', expect: ['C3b 现行版本解析'], edits: [{ file: 'items.js', from: 'versions.filter((v) => v.version_no > currentVersion.version_no)', to: 'versions.filter((v) => v.version_no >= currentVersion.version_no)' }] },
  { id: 'C3b 承诺批次不取折叠结果', expect: ['C3b 现行版本解析'], edits: [{ file: 'items.js', from: 'committed_batch_id: entry ? entry.committed_batch_id : null,', to: 'committed_batch_id: null,' }] },
  { id: 'C3b 未入生效规划标志恒为真', expect: ['C3b 现行版本解析'], edits: [{ file: 'items.js', from: 'in_effective_plan: !!entry,', to: 'in_effective_plan: true,' }] },
  // actions 同源
  { id: 'C3b actions.new_version 改用 PM 判定（登记人看不到）', expect: ['C3b actions 与执行同源', 'C3b 读接口'], edits: [{ file: 'items.js', from: "new_version: rules.opAllowed('item_version_create', access, access.project, t),", to: "new_version: rules.opAllowed('item_set_module', access, access.project, t)," }] },
  { id: 'C3b actions.set_module 改用 item_version_create 判定', expect: ['C3b actions 与执行同源', 'C3b 读接口'], edits: [{ file: 'items.js', from: "set_module: rules.opAllowed('item_set_module', access, access.project, t),", to: "set_module: rules.opAllowed('item_version_create', access, access.project, t)," }] },
  { id: 'C3b actions.create_item 恒为真', expect: ['C3b actions 与执行同源', 'C3b 读接口'], edits: [{ file: 'items.js', from: "create_item: rules.opAllowed('item_create', access, access.project, {}),", to: 'create_item: true,' }] },
  { id: 'C3b actions.edit 不看版本状态（改用 item_set_module 判定）', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "edit: rules.opAllowed('package_version_edit', access, access.project, t),", to: "edit: rules.opAllowed('item_set_module', access, access.project, t)," }] },
  { id: 'C3b actions.add_item 不看包类型（改用 package_version_edit 判定）', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "add_item: rules.opAllowed('package_item_add', access, access.project, t),", to: "add_item: rules.opAllowed('package_version_edit', access, access.project, t)," }] },
  { id: 'C3b actions.remove_item 不看包类型（改用 package_version_edit 判定）', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "remove_item: rules.opAllowed('package_item_remove', access, access.project, t),", to: "remove_item: rules.opAllowed('package_version_edit', access, access.project, t)," }] },
  { id: 'C3b actions.new_version（版本详情）忽略已有草稿', expect: ['C3b actions 与执行同源'], edits: [{ file: 'packages.js', from: "new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus)),\n    };", to: "new_version: rules.opAllowed('package_version_create', access, access.project, { hasDraft: false, hasPending: false }),\n    };" }] },
  { id: 'C3b actions.new_version（包列表）忽略已有草稿', expect: ['C3b actions 与执行同源', 'C3b 包读接口'], edits: [{ file: 'packages.js', from: "actions: { new_version: rules.opAllowed('package_version_create', access, access.project, newVersionTarget(vrows, pkg, await batchStatusOf(q, pkg))) },", to: "actions: { new_version: rules.opAllowed('package_version_create', access, access.project, { hasDraft: false, hasPending: false }) }," }] },
  // 项目状态类别（OP_KIND）：每个新动作改成「已终止也允许」的 resolve 类，终止后的 409 用例必须判红
  { id: 'C3b OP_KIND module_create 记成 resolve（终止后仍可建）', expect: ['C3b 模块：一般成员'], edits: [{ file: 'rules.js', from: "  module_create: 'maintain',", to: "  module_create: 'resolve'," }] },
  { id: 'C3b OP_KIND module_rename 记成 resolve', expect: ['C3b 模块：一般成员'], edits: [{ file: 'rules.js', from: "  module_rename: 'maintain',", to: "  module_rename: 'resolve'," }] },
  { id: 'C3b OP_KIND item_create 记成 resolve', expect: ['C3b 条目创建：权限'], edits: [{ file: 'rules.js', from: "  item_create: 'maintain',", to: "  item_create: 'resolve'," }] },
  { id: 'C3b OP_KIND item_create 记成 close（暂停不能建）', expect: ['C3b 条目创建：权限'], edits: [{ file: 'rules.js', from: "  item_create: 'maintain',", to: "  item_create: 'close'," }] },
  { id: 'C3b OP_KIND item_version_create 记成 resolve', expect: ['C3b 条目新版本：必须有证据'], edits: [{ file: 'rules.js', from: "  item_version_create: 'maintain',", to: "  item_version_create: 'resolve'," }] },
  { id: 'C3b OP_KIND item_set_module 记成 resolve', expect: ['C3b 条目改模块'], edits: [{ file: 'rules.js', from: "  item_set_module: 'maintain',", to: "  item_set_module: 'resolve'," }] },
  { id: 'C3b OP_KIND package_create 记成 resolve', expect: ['C3b 包创建：权限'], edits: [{ file: 'rules.js', from: "  package_create: 'maintain',", to: "  package_create: 'resolve'," }] },
  { id: 'C3b OP_KIND package_version_create 记成 resolve', expect: ['C3b 包版本：权限'], edits: [{ file: 'rules.js', from: "  package_version_create: 'maintain',", to: "  package_version_create: 'resolve'," }] },
  { id: 'C3b OP_KIND package_version_edit 记成 resolve', expect: ['C3b snapshot 编辑'], edits: [{ file: 'rules.js', from: "  package_version_edit: 'maintain',", to: "  package_version_edit: 'resolve'," }] },
  { id: 'C3b OP_KIND package_item_add 记成 resolve', expect: ['C3b 集合修订：权限'], edits: [{ file: 'rules.js', from: "  package_item_add: 'maintain',", to: "  package_item_add: 'resolve'," }] },
  { id: 'C3b OP_KIND package_item_remove 记成 resolve', expect: ['C3b 集合修订：权限'], edits: [{ file: 'rules.js', from: "  package_item_remove: 'maintain',", to: "  package_item_remove: 'resolve'," }] },
  // 其余键白名单 / 请求体形态
  { id: 'C3b 模块改名端点放过多余键', expect: ['C3b 模块：参数校验'], edits: [{ file: 'items.js', from: "onlyKeys(body, ['name']);\n    const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);\n    const user = req.user;\n    const out = await db.withWriteTxn(async (q) => {\n      const mod = await", to: "const name = readText(body.name, 'name', '模块名称', MODULE_NAME_MAX, true);\n    const user = req.user;\n    const out = await db.withWriteTxn(async (q) => {\n      const mod = await" }] },
  { id: 'C3b 条目改模块端点放过多余键', expect: ['C3b 条目改模块'], edits: [{ file: 'items.js', from: "onlyKeys(body, ['module_id']);", to: '' }] },
  { id: 'C3b packages.js 的 bodyOf 放过数组请求体', expect: ['C3b 包创建：'], edits: [{ file: 'packages.js', from: "if (typeof b !== 'object' || Array.isArray(b)) throw invalid(", to: 'if (false) throw invalid(' }] },

  // ── 第二批（预筛修订）：每条只删一处，expect 指向目标用例（跑完核对命中的用例名）──────────────────────────────────────
  // D1
  { id: 'C3b D1 总体规划已生效的拒绝删掉', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.hasEffective) return '总体规划已生效，修改须经正式变更（C5）';", to: '' }] },
  { id: 'C3b D1 对所有包生效后都拒绝（不限总体规划包）', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'rules.js', from: "if (t.packageType === 'overall' && t.hasEffective) return", to: 'if (t.hasEffective) return' }] },
  { id: 'C3b D1 hasEffective 恒假', expect: ['C3b D1 总体规划已生效'], edits: [{ file: 'packages.js', from: "hasEffective: versions.some((v) => v.status === 'effective'),", to: 'hasEffective: false,' }] },
  // D2
  { id: 'C3b D2 建版本不拦冻结批次', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'rules.js', from: 'state: withFrozenBatch((t) => {\n      // D1（预筛裁定）', to: 'state: ((t) => {\n      // D1（预筛裁定）' }] },
  { id: 'C3b D2 改 snapshot 不拦冻结批次', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'rules.js', from: 'state: withFrozenBatch(draftVersionState) }),', to: 'state: draftVersionState }),' }] },
  { id: 'C3b D2 add 不先报冻结批次', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'rules.js', from: "\n      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';\n      // S3", to: '\n      // S3' }] },
  { id: 'C3b D2 remove 不先报冻结批次', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'rules.js', from: "      if (batchFrozen(t)) return '批次包所在批次已转出或被替代，不能再修订';\n      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false", to: "      if (t.packageType !== 'overall' && t.packageType !== 'change') return '只有总体规划包和变更包的版本可以修订条目集合';\n      return t.inSet === false" }] }, // S-S1c：锚点随条件放宽到变更包而改写
  { id: 'C3b D2 取不到批次包所在批次的状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: 'if (pkg.batch_id === null) return undefined;', to: 'return undefined;' }] },
  { id: 'C3b D2 版本详情的标志不带批次状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: 'const t = versionTarget(ver, pkg, batchStatus, facts);\n    return {', to: 'const t = versionTarget(ver, pkg, undefined, facts);\n    return {' }] },
  { id: 'C3b D2 包列表的标志不带批次状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: 'newVersionTarget(vrows, pkg, await batchStatusOf(q, pkg))', to: 'newVersionTarget(vrows, pkg, undefined)' }] },
  { id: 'C3b D2 建版本端点的 target 不带批次状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: "rules.assertOp('package_version_create', access, access.project, newVersionTarget(versions, pkg, batchStatus));", to: "rules.assertOp('package_version_create', access, access.project, newVersionTarget(versions, pkg, undefined));" }] },
  { id: 'C3b D2 改 snapshot 端点的 target 不带批次状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: "rules.assertOp('package_version_edit', access, access.project, versionTarget(ver, pkg, batchStatus));", to: "rules.assertOp('package_version_edit', access, access.project, versionTarget(ver, pkg, undefined));" }] },
  { id: 'C3b D2 集合修订端点的 target 不带批次状态', expect: ['C3b D2 批次包所在批次'], edits: [{ file: 'packages.js', from: 'const base = versionTarget(ver, pkg, batchStatus);', to: 'const base = versionTarget(ver, pkg, undefined);' }] },
  // 执行者没把握 3：snapshot 继承
  { id: 'C3b 新草稿不继承上一版本的 snapshot', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: "const prevSnapshot = prev ? (await q.get('SELECT snapshot_json FROM sysbuild_package_versions WHERE id = ?', [prev.id])).snapshot_json : '{}';", to: "const prevSnapshot = '{}';" }] },
  { id: 'C3b snapshot 继承取第一个版本而不是最大 version_no', expect: ['C3b 包版本：新草稿继承'], edits: [{ file: 'packages.js', from: "WHERE id = ?', [prev.id])).snapshot_json", to: "WHERE id = ?', [versions[0].id])).snapshot_json" }] },
  // LOW-1
  { id: 'C3b snapshot 嵌套深度上限放宽到 640', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'const SNAPSHOT_MAX_DEPTH = 64;', to: 'const SNAPSHOT_MAX_DEPTH = 640;' }] },
  { id: 'C3b snapshot 嵌套深度检查删掉', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (depth > SNAPSHOT_MAX_DEPTH) throw invalid(`snapshot_json 嵌套不能超过 ${SNAPSHOT_MAX_DEPTH} 层`, 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 不递归数组元素', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'for (const x of v) checkSnapshotValue(x, depth + 1);', to: '' }] },
  { id: 'C3b snapshot 不递归对象的值', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'checkSnapshotValue(v[k], depth + 1);', to: '' }] },
  { id: 'C3b snapshot 字符串值不拒控制字符', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (rules.hasControlChar(v)) throw invalid('snapshot_json 的文本不能包含控制字符', 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 键名不拒控制字符', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: "if (rules.hasControlChar(k)) throw invalid('snapshot_json 的键名不能包含控制字符', 'snapshot_json');", to: '' }] },
  { id: 'C3b snapshot 不做递归检查', expect: ['C3b snapshot 校验'], edits: [{ file: 'packages.js', from: 'checkSnapshotValue(snap, 1);', to: '' }] },
  // LOW-4
  { id: 'C3b S1 登记人判定删掉 isMember（admin 登记人未接管也放行）', expect: ['C3b 条目新版本：S1 登记人不再是成员'], edits: [{ file: 'rules.js', from: 'return !!(identity.isPm || (identity.isMember && t.isCreator === true));', to: 'return !!(identity.isPm || t.isCreator === true);' }] },
  // LOW-5
  { id: 'C3b 附件视图直接返回原名（不经 attachmentDisplayName）', expect: ['C3b 读接口：条目列表'], edits: [{ file: 'items.js', from: 'original_name: attachmentDisplayName(a),', to: 'original_name: a.original_name,' }] },
  { id: 'C3b 附件视图缺 sha256', expect: ['C3b 读接口：条目列表'], edits: [{ file: 'items.js', from: 'size: a.size, sha256: a.sha256, is_image', to: 'size: a.size, is_image' }] },
  { id: 'C3b 附件视图缺 masked_at', expect: ['C3b 读接口：条目列表'], edits: [{ file: 'attachments.js', from: 'masked_at: att.masked_at, masked_by: att.masked_by,', to: 'masked_by: att.masked_by,' }] },
  { id: 'C3b 附件视图缺 masked_by', expect: ['C3b 读接口：条目列表'], edits: [{ file: 'attachments.js', from: ' masked_by: att.masked_by,', to: '' }] },
  { id: 'C3b 附件视图缺 mask_reason', expect: ['C3b 读接口：条目列表'], edits: [{ file: 'attachments.js', from: ' mask_reason: att.mask_reason,', to: '' }] },
  { id: 'C3b 附件视图缺 deleted_at', expect: ['C3b 读接口：附件视图的删除信息'], edits: [{ file: 'attachments.js', from: ' deleted_at: att.deleted_at,', to: '' }] },
  { id: 'C3b 附件视图缺 deleted_by', expect: ['C3b 读接口：附件视图的删除信息'], edits: [{ file: 'attachments.js', from: ' deleted_by: att.deleted_by,', to: '' }] },
  // D9
  { id: 'C3b D9 项目级包类型的 exists 不查', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: 'const exists = await packageExists(q, pid, type, null, null);', to: 'const exists = false;' }] },
  { id: 'C3b D9 批次类型的 exists 不查', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: 'const exists = await packageExists(q, pid, type, b.id, b);', to: 'const exists = false;' }] },
  { id: 'C3b D9 批次类型不带批次状态', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: "if (rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: b.status })) can = true;", to: "if (rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: undefined })) can = true;" }] },
  { id: 'C3b D9 项目级类型不调 opAllowed（只看 exists）', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: "can = rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: undefined });", to: 'can = !exists;' }] },
  { id: 'C3b D9 批次类型不调 opAllowed（只看 exists）', expect: ['C3b D9 包列表'], edits: [{ file: 'packages.js', from: "if (rules.opAllowed('package_create', access, access.project, { type, exists, batchStatus: b.status })) can = true;", to: 'if (!exists) can = true;' }] },
  // ── 第三批（codex 18 号）：下面三条只登记、本批不跑，随之后的子集补跑一起跑 ──
  { id: 'C3b 18号 L-1 snapshot 数字不查有限性', expect: ['C3b snapshot 校验（18 号 L-1）'], edits: [{ file: 'packages.js', from: "if (!Number.isFinite(v)) throw invalid('snapshot_json 的数字必须是有限数', 'snapshot_json');", to: '' }] },
  { id: 'C3b 18号 L-2 沿用附件的绑定查询去掉 item_id 限定（他条目的附件可沿用）', expect: ['C3b 条目新版本：S6 沿用附件'], edits: [{ file: 'items.js', from: "AND b.owner_type = 'item_version' AND iv.item_id = ? AND", to: "AND b.owner_type = 'item_version' AND ? IS NOT NULL AND" }] },
  { id: 'C3b 18号 L-2 沿用附件的引用查询去掉 item_id 限定（他条目版本上的引用可沿用）', expect: ['C3b 条目新版本：S6 本条目限定'], edits: [{ file: 'items.js', from: "AND r.owner_type = 'item_version' AND iv.item_id = ? AND", to: "AND r.owner_type = 'item_version' AND ? IS NOT NULL AND" }] },
];

module.exports = { defineItemCases, ITEM_MUTATIONS };
