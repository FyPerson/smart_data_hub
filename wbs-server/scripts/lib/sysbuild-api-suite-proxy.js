// 验证脚本库：项目管理（系统建设记录）模块 C4b Q-S1——代录（#113 段 4 C4b）的用例与变异
//   方案：docs/local/系统建设记录/系统建设记录_平台集成_方案_20261102_v1.3.md §4.2（代录、v1.3 编码期细则）、§4.5、§5.2「代录、历史补录」行、§6.2 confirmations 行、§7「确认」组
//   派单：docs/local/系统建设记录/送审准备/C4b_Q-S1_代录_派单_20261104.md（契约 2.1–2.5；锚点 Q3 = Q-D1，Q9 = P44–P52）
//
// 本文件只放用例与变异，由 sysbuild-api-suite.js 登记（同一套夹具、同一个变异自检）。期望值一律手写，不取自被测代码。
// 夹具规则：建项走 POST /projects；无账号成员走 POST /members（person_name）；任职提议、授权提议、提交、代录全部走生产端点。只有这几类直接写库：
//   ① 需求部门参与方、现任任职 / 生效授权（membership 套件另有端点用例，这里只要「现任负责人 / 生效代表人」这个事实）；② 附件行（暂存）；
//   ③ 把修订 / 任职 / 授权的创建时间回拨到固定日期（外部确认日期的下限取创建日，真实时钟下「今天」会随运行日变化，用例需要固定的下限）。
// 日期约定：回拨后的创建时间 = FLOOR_AT（2026-10-20 09:00:00）；合法的外部确认日期 [2026-10-20, 今天]；「今天」进程内夹具是注入的固定值，实例模式取本机本地日期。
'use strict';
const assert = require('assert');

const FLOOR_AT = '2026-10-20 09:00:00';
const FLOOR = '2026-10-20';
const OK_DATE = '2026-10-25';
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

function defineProxyCases(T) {
  const { test, U, api, sqlRun, sqlGet, sqlAll, expectErr, eventsOf, addMember, addParty, addAppointment, addDelegation, confirm: H } = T;
  // 暂存附件的 sha256 必须是 64 位小写十六进制：传入十六进制字符原样用（用例要核对冻结清单里的 sha256 时），其余字符映射成一个十六进制字符
  const stageAtt = (pid, uid, ch) => H.stageAtt(pid, uid, /^[0-9a-f]$/.test(ch) ? ch : (ch.charCodeAt(0) % 16).toString(16));
  const { newProject, defaultBatchId, mkItem, mkPackage, mkVersion, addToSet, tasksOf, openTask, openAndDecide, planAllNodes, seedEffectiveInitiation } = H;
  const post = (uid, url, body) => api(uid, 'POST', url, body === undefined ? {} : body);
  const get = (uid, url) => api(uid, 'GET', url);
  const payloads = async (pid, type) => (await eventsOf(pid, type)).map((e) => JSON.parse(e.payload_json));
  const rowOf = (table, id) => sqlGet(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  const countOf = async (s, p) => (await sqlGet(s, p)).n;
  const setStatus = (pid, to) => post(U.admin, `/sysbuild/projects/${pid}/status`, { to, reason: '代录用例' });
  const today = () => (T.getFixedToday && T.getFixedToday()) || localDate(new Date());
  const proxyUrl = (tid) => `/sysbuild/confirm-tasks/${tid}/proxy`;

  // ── 场景与请求体助手 ───────────────────────────────────────────────────────────────────────────
  const backdate = async (table, ids) => { for (const id of ids) await sqlRun(`UPDATE ${table} SET created_at = ? WHERE id = ?`, [FLOOR_AT, id]); };
  const backdateRevs = (ids) => backdate('sysbuild_confirm_task_revisions', ids);
  async function addNaMember(pid, party, name) {
    const r = await post(U.pm, `/sysbuild/projects/${pid}/members`, { party_id: party, person_name: name });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.member.user_id, null);
    return r.body.member.id;
  }
  // 凭据四字段（附件由 PM 暂存）；extra 覆盖 / 用 undefined 去掉某个键
  async function evid(pid, extra) {
    return Object.assign({
      external_date: OK_DATE, actual_confirmer: '甲部张主任', identity_basis: '甲部现任负责人，微信确认截图', attachment_ids: [await stageAtt(pid, U.pm, 'p')],
    }, extra || {});
  }
  // 确认任务代录请求体：t = tasksOf 的一行
  async function bodyOf(pid, t, decision, extra) {
    return Object.assign({ revision_id: t.rev_id, object_version_id: t.object_version_id, decision }, decision === 'confirm' ? {} : { reason: '对方来邮件提出异议' }, await evid(pid), extra || {});
  }
  // 无账号负责人（+ 无账号代表人 / 指定账号的代表人）的总体规划包已提交：返回各编号与按任务编号排序的任务（负责人在前、代表人在后）
  async function mkNaScene(opt) {
    const o = opt || {};
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mOwn = o.ownerUid ? await addMember(pid, o.ownerUid, { party }) : await addNaMember(pid, party, '无账号负责人');
    const apt = await addAppointment(party, mOwn, 'active');
    const mDel = o.delegateUid ? await addMember(pid, o.delegateUid, { party }) : await addNaMember(pid, party, '无账号代表人');
    const dlg = await addDelegation(party, mDel, apt, 'active');
    await seedEffectiveInitiation(pid);
    const item = await mkItem(pid);
    const pk = await mkPackage(pid, 'overall');
    const pv = await mkVersion(pk);
    await addToSet(pv, item.versions[0].id, await defaultBatchId(pid));
    await planAllNodes(pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    const tasks = await tasksOf(pv);
    await backdateRevs(tasks.map((t) => t.rev_id));
    return { pid, party, mOwn, apt, mDel, dlg, item, pk, pv, sub, tasks };
  }
  const revOf = (rid) => rowOf('sysbuild_confirm_task_revisions', rid);
  const verStatus = async (vid) => (await rowOf('sysbuild_package_versions', vid)).status;
  const baselineCountIn = (pid) => countOf("SELECT COUNT(*) AS n FROM sysbuild_node_schedule_records r JOIN sysbuild_nodes n ON n.id = r.node_id WHERE n.project_id = ? AND r.kind = 'baseline'", [pid]);
  // 一个任务的全部可观察状态（被拒绝的代录必须不改任何东西）
  const taskSnap = async (tid) => JSON.stringify([
    await sqlAll('SELECT id, status FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY id', [tid]),
    await sqlAll('SELECT c.id FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id WHERE r.task_id = ? ORDER BY c.id', [tid]),
    await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
    await sqlAll("SELECT id FROM sysbuild_events WHERE event_type = 'confirm_proxy_recorded' ORDER BY id"),
  ]);
  // 提出人任务：无账号成员 / 有账号成员作提出人的条目（已加入的成员），返回 { item, ivid, tid, rid, mid }
  async function mkProposerTask(pid, memberId) {
    const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: memberId });
    const ivid = it.versions[0].id;
    const t = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [ivid]);
    assert.ok(t, '提出人任务应已生成');
    const rev = await sqlGet('SELECT id FROM sysbuild_confirm_task_revisions WHERE task_id = ? ORDER BY rev_no DESC LIMIT 1', [t.id]);
    await backdateRevs([rev.id]);
    return { item: it, ivid, tid: t.id, rid: rev.id, mid: memberId };
  }
  const proposerBody = async (pid, p, decision, extra) => Object.assign({ revision_id: p.rid, object_version_id: p.ivid, decision }, decision === 'confirm' ? {} : { reason: '这不是我提的' }, await evid(pid), extra || {});
  const itemStatus = (ivid) => sqlGet('SELECT proposer_status, deny_reason FROM sysbuild_item_versions WHERE id = ?', [ivid]);

  // ── 1 主场景：无账号负责人 + 无账号代表人 ─────────────────────────────────────────────────────────
  test('C4b 代录：无账号——无账号负责人 + 无账号代表人的总体规划包提交成功、生成两条 proxy_only 任务；两条代录后生效并形成基线（同一参与方两个无账号成员，去重键不撞）；确认记录各列 / 凭据附件 / 事件手写核对', async () => {
    const s = await mkNaScene();
    assert.strictEqual(s.tasks.length, 2);
    assert.deepStrictEqual(s.tasks.map((t) => [t.party_id, t.required_member_id, t.user_id, t.status]), [[s.party, s.mOwn, null, 'pending'], [s.party, s.mDel, null, 'pending']]);
    assert.deepStrictEqual(s.sub.body.tasks.map((t) => [t.kind, t.required_member_id, t.proxy_only]), [['owner', s.mOwn, true], ['delegate', s.mDel, true]]);
    const list = await get(U.pm, `/sysbuild/package-versions/${s.pv}/confirm-tasks`);
    assert.strictEqual(list.status, 200, list.text);
    assert.deepStrictEqual(list.body.tasks.map((t) => [t.proxy_only, t.current_revision.proxy_only]), [[true, true], [true, true]]);
    // 任务详情：PM 打开不写浏览记录；修订带 proxy_only；PM 的代录标志为真、decide 为假
    const d0 = await openTask(U.pm, s.tasks[0].task_id);
    assert.strictEqual(d0.status, 200, d0.text);
    assert.strictEqual(d0.body.view_id, null);
    assert.deepStrictEqual([d0.body.revision.proxy_only, d0.body.revisions.map((r) => r.proxy_only), d0.body.actions], [true, [true], { decide: false, proxy: true, reissue: true, export_sheet: true }]);
    // 第一条：负责人代录确认
    const att1 = await stageAtt(s.pid, U.pm, 'p');
    const r1 = await post(U.pm, proxyUrl(s.tasks[0].task_id), await bodyOf(s.pid, s.tasks[0], 'confirm', { attachment_ids: [att1] }));
    assert.strictEqual(r1.status, 200, r1.text);
    assert.deepStrictEqual(r1.body, {
      decision: 'confirm', method: 'proxy', revision: { id: s.tasks[0].rev_id, status: 'confirmed' }, confirmation_id: r1.body.confirmation_id, attachment_ids: [att1],
      effective: false, superseded_version_ids: [], baseline_node_ids: [], advanced_batch_ids: [], version: { id: s.pv, status: 'pending' },
    });
    const c1 = await rowOf('sysbuild_confirmations', r1.body.confirmation_id);
    assert.deepStrictEqual(c1, {
      id: c1.id, task_revision_id: s.tasks[0].rev_id, object_type: 'package_version', object_version_id: s.pv, actor_user_id: null, actual_confirmer: '甲部张主任',
      identity_basis: '甲部现任负责人，微信确认截图', method: 'proxy', decision: 'confirm', checkbox_text: null, reason: null, view_id: null, external_date: OK_DATE, proxy_by: U.pm,
      card_instance_id: null, dingtalk_user_id: null, created_at: c1.created_at,
    });
    assert.strictEqual((await revOf(s.tasks[0].rev_id)).status, 'confirmed');
    assert.deepStrictEqual(await sqlAll("SELECT attachment_id, owner_type, owner_id, bound_by FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' AND owner_id = ?", [c1.id]),
      [{ attachment_id: att1, owner_type: 'confirmation', owner_id: c1.id, bound_by: U.pm }]);
    assert.deepStrictEqual(await payloads(s.pid, 'confirm_proxy_recorded'), [{
      confirmation_id: c1.id, revision_id: s.tasks[0].rev_id, object_type: 'package_version', object_version_id: s.pv, required_member_id: s.mOwn, decision: 'confirm', method: 'proxy',
      actual_confirmer: '甲部张主任', external_date: OK_DATE, attachment_ids: [att1], reason: null,
    }]);
    assert.strictEqual((await eventsOf(s.pid, 'confirmation_recorded')).length, 0, '代录不写平台确认事件');
    assert.strictEqual(await verStatus(s.pv), 'pending', '只确认了一条，版本仍待确认');
    assert.strictEqual(await baselineCountIn(s.pid), 0);
    // 第二条：代表人代录确认 → 全部确认，版本生效，基线形成（自研项目 6 个节点都已补计划）
    const r2 = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'confirm', { actual_confirmer: '甲部李代表', identity_basis: '甲部授权代表人' }));
    assert.strictEqual(r2.status, 200, r2.text);
    assert.deepStrictEqual([r2.body.effective, r2.body.version.status, r2.body.baseline_node_ids.length], [true, 'effective', 6]);
    assert.strictEqual(await verStatus(s.pv), 'effective');
    assert.strictEqual(await baselineCountIn(s.pid), 6);
    assert.strictEqual((await eventsOf(s.pid, 'package_version_effective')).length, 1);
    // 已确认的修订不能再代录，也不能再决策
    const again = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'confirm'));
    expectErr(again, 409, 'SYSBUILD_STATE', '已确认再代录');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_confirmations WHERE task_revision_id = ?', [s.tasks[1].rev_id]), 1);
    // 预筛 MED-2：任务详情的每条确认记录带它的凭据附件（attachment_ids 含该记录名下全部绑定，口径同 plan.js 改期证据读接口；attachments 复用统一格式，遮蔽的不返回原名，另标已删除与删除人）
    const dv = await openTask(U.pm, s.tasks[0].task_id);
    assert.strictEqual(dv.status, 200, dv.text);
    assert.deepStrictEqual(dv.body.confirmations.map((c) => [c.method, c.attachment_ids]), [['proxy', [att1]]]);
    assert.deepStrictEqual(dv.body.confirmations[0].attachments.map((x) => [x.attachment_id, x.masked, x.name, x.size, x.mime_type, x.deleted, x.deleted_by, x.deleted_by_name]), [[att1, false, '确认证据.txt', 3, 'text/plain', false, null, null]]);
    // 小修批 F6：别的所属类型的绑定即使 owner_id 恰与本确认记录同号也不串入（夹具：造一条 schedule_record 绑定，owner_id = 本确认记录编号）
    const confId = dv.body.confirmations[0].id;
    const strayAtt = await stageAtt(s.pid, U.pm, 'e');
    await sqlRun("INSERT INTO sysbuild_attachment_bindings (attachment_id, owner_type, owner_id, bound_by) VALUES (?, 'schedule_record', ?, ?)", [strayAtt, confId, U.pm]);
    assert.deepStrictEqual((await openTask(U.pm, s.tasks[0].task_id)).body.confirmations[0].attachment_ids, [att1], 'owner_type 不同、owner_id 同号的绑定不串入');
    // 别的确认记录（同一个库里编号不同）的凭据也不串入：第二条任务的确认记录只带它自己的附件
    assert.deepStrictEqual((await openTask(U.pm, s.tasks[1].task_id)).body.confirmations.map((c) => c.attachment_ids.length), [1]);
    await sqlRun("UPDATE sysbuild_attachments SET masked_at = '2026-10-30 10:00:00', masked_by = 1, mask_reason = '含敏感信息' WHERE id = ?", [att1]);
    const dm = await openTask(U.pm, s.tasks[0].task_id);
    assert.deepStrictEqual(dm.body.confirmations[0].attachments.map((x) => [x.attachment_id, x.masked, x.name]), [[att1, true, null]]);
    assert.ok(!dm.text.includes('确认证据'), '遮蔽后响应体任何位置都不含原名');
    // 小修批 F2：已软删除的凭据照样列出，并标明已删除与删除人（方案 §10.3；D1 之后经 API 已删不掉，这里用直接写库夹具构造）
    await sqlRun('UPDATE sysbuild_attachments SET deleted_at = ?, deleted_by = ? WHERE id = ?', ['2026-10-31 10:00:00', U.admin, att1]);
    const dd = (await openTask(U.pm, s.tasks[0].task_id)).body.confirmations[0];
    assert.deepStrictEqual(dd.attachment_ids, [att1], '已软删除的凭据仍在 attachment_ids 里（口径同 plan.js 改期证据读接口）');
    assert.deepStrictEqual([dd.attachments[0].deleted, dd.attachments[0].deleted_at, dd.attachments[0].deleted_by], [true, '2026-10-31 10:00:00', U.admin]);
    assert.ok(typeof dd.attachments[0].deleted_by_name === 'string' && dd.attachments[0].deleted_by_name.length > 0, '标明删除人显示名');
    // 预筛 L1：该附件先遮蔽后删除——名称仍为 null，响应全文不含原名（遮蔽优先于删除标记）
    assert.strictEqual(dd.attachments[0].name, null, '先遮蔽后删除：name 为 null');
    assert.ok(!JSON.stringify(dd).includes('确认证据'), '先遮蔽后删除：确认记录整体不含原名');
    assert.ok(!(await openTask(U.pm, s.tasks[0].task_id)).text.includes('确认证据'), '先遮蔽后删除：响应全文不含原名');
    // 对照（与 items.js 的口径一致）：删除但未遮蔽的凭据，名称照常返回并标已删除
    await sqlRun('UPDATE sysbuild_attachments SET masked_at = NULL, masked_by = NULL, mask_reason = NULL WHERE id = ?', [att1]);
    const dn = (await openTask(U.pm, s.tasks[0].task_id)).body.confirmations[0].attachments[0];
    assert.deepStrictEqual([dn.name, dn.masked, dn.deleted], ['确认证据.txt', false, true], '删除未遮蔽：名称照常返回、标已删除');
    // 平台确认记录没有凭据附件：返回空数组
    const sp = await mkNaScene({ ownerUid: U.own });
    assert.strictEqual((await openAndDecide(U.own, sp.tasks[0].task_id, 'confirm')).status, 200);
    assert.deepStrictEqual((await openTask(U.pm, sp.tasks[0].task_id)).body.confirmations.map((c) => [c.method, c.attachment_ids, c.attachments]), [['platform', [], []]]);
  });

  // ── 2 混合与有账号的人 ─────────────────────────────────────────────────────────────────────────
  test('C4b 代录：混合——一条平台确认 + 一条代录 → 生效；有账号的人被代录也计入通过（确认记录 actor_user_id 记他的账号），之后他本人不能再决策', async () => {
    // 负责人有账号（own 平台确认），代表人无账号（代录）
    const s = await mkNaScene({ ownerUid: U.own });
    assert.deepStrictEqual(s.tasks.map((t) => t.user_id), [U.own, null]);
    assert.deepStrictEqual(s.sub.body.tasks.map((t) => t.proxy_only), [false, true]);
    const dec = await openAndDecide(U.own, s.tasks[0].task_id, 'confirm');
    assert.strictEqual(dec.status, 200, dec.text);
    assert.strictEqual(await verStatus(s.pv), 'pending');
    const r = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'confirm'));
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual([r.body.effective, r.body.version.status], [true, 'effective']);
    assert.deepStrictEqual((await sqlAll('SELECT method, actor_user_id FROM sysbuild_confirmations WHERE object_version_id = ? ORDER BY id', [s.pv])), [{ method: 'platform', actor_user_id: U.own }, { method: 'proxy', actor_user_id: null }]);
    // 有账号的人被代录：负责人 own 与代表人 del 都有账号，PM 在平台外代录两人
    const w = await mkNaScene({ ownerUid: U.own, delegateUid: U.del });
    assert.deepStrictEqual(w.sub.body.tasks.map((t) => t.proxy_only), [false, false]);
    const rw = await post(U.pm, proxyUrl(w.tasks[0].task_id), await bodyOf(w.pid, w.tasks[0], 'confirm'));
    assert.strictEqual(rw.status, 200, rw.text);
    const cw = await rowOf('sysbuild_confirmations', rw.body.confirmation_id);
    assert.deepStrictEqual([cw.method, cw.actor_user_id, cw.proxy_by, cw.view_id, cw.checkbox_text], ['proxy', U.own, U.pm, null, null]);
    // 他本人再来决策：修订已确认 → 409；任务详情里 decide 为假
    const o = await openTask(U.own, w.tasks[0].task_id);
    assert.strictEqual(o.body.actions.decide, false);
    expectErr(await post(U.own, `/sysbuild/confirm-tasks/${w.tasks[0].task_id}/decide`, { revision_id: w.tasks[0].rev_id, object_version_id: w.pv, decision: 'confirm', checkbox_text: '我已阅读以上全部内容，确认无误' }), 409, 'SYSBUILD_STATE', '代录后本人决策');
    const rw2 = await post(U.pm, proxyUrl(w.tasks[1].task_id), await bodyOf(w.pid, w.tasks[1], 'confirm'));
    assert.deepStrictEqual([rw2.status, rw2.body.effective], [200, true], '两个有账号的人都被代录 → 生效');
    // 反向：先代录再平台决策的顺序也成立（修订终态只有一个）：新场景里 own 先被代录，del 平台确认
    const v = await mkNaScene({ ownerUid: U.own, delegateUid: U.del });
    assert.strictEqual((await post(U.pm, proxyUrl(v.tasks[0].task_id), await bodyOf(v.pid, v.tasks[0], 'confirm'))).status, 200);
    const last = await openAndDecide(U.del, v.tasks[1].task_id, 'confirm');
    assert.deepStrictEqual([last.status, last.body.effective], [200, true]);
  });

  // ── 3 校验顺序 ───────────────────────────────────────────────────────────────────────────────
  test('C4b 代录：校验顺序——400 参数形态 → 404 → 403 → 409（项目状态 / 修订号 / 版本号 / 修订状态 / 对象状态 / 资格）→ 400 日期范围与附件；被拒的请求不改任何状态', async () => {
    const s = await mkNaScene();
    const t = s.tasks[0];
    const url = proxyUrl(t.task_id);
    await addMember(s.pid, U.m1);
    const snap0 = await taskSnap(t.task_id);
    const good = async (extra) => bodyOf(s.pid, t, 'confirm', extra);
    // 400 参数形态（先于一切数据库检查：任务不存在 / 非成员也先报 400）
    const shapes = [
      [{ extra: { x: 1 } }, 'x', '多余键'],
      [{ extra: { revision_id: undefined } }, 'revision_id', '缺 revision_id'],
      [{ extra: { object_version_id: 'abc' } }, 'object_version_id', 'object_version_id 非法'],
      [{ extra: { decision: 'maybe' } }, 'decision', 'decision 枚举'],
      [{ extra: { external_date: undefined } }, 'external_date', '缺外部日期'],
      [{ extra: { external_date: '2026-02-30' } }, 'external_date', '日期不存在'],
      [{ extra: { external_date: '2026/10/25' } }, 'external_date', '日期格式'],
      [{ extra: { actual_confirmer: '   ' } }, 'actual_confirmer', '实际确认人空白'],
      [{ extra: { actual_confirmer: undefined } }, 'actual_confirmer', '缺实际确认人'],
      [{ extra: { actual_confirmer: '甲'.repeat(101) } }, 'actual_confirmer', '实际确认人 101 字'],
      [{ extra: { identity_basis: undefined } }, 'identity_basis', '缺身份依据'],
      [{ extra: { identity_basis: '依'.repeat(501) } }, 'identity_basis', '身份依据 501 字'],
      [{ extra: { attachment_ids: undefined } }, 'attachment_ids', '缺附件'],
      [{ extra: { attachment_ids: [] } }, 'attachment_ids', '空附件列表'],
      [{ extra: { attachment_ids: 'a' } }, 'attachment_ids', '附件列表不是数组'],
      [{ extra: { attachment_ids: [0] } }, 'attachment_ids', '附件编号不合法'],
    ];
    for (const [{ extra }, field, label] of shapes) {
      const r = await post(U.pm, url, await good(extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    }
    const a1 = await stageAtt(s.pid, U.pm, 'q');
    expectErr(await post(U.pm, url, await good({ attachment_ids: [a1, a1] })), 400, 'SYSBUILD_INVALID_INPUT', '附件重复');
    const rObj = await post(U.pm, url, await bodyOf(s.pid, t, 'object', { reason: undefined }));
    expectErr(rObj, 400, 'SYSBUILD_INVALID_INPUT', 'object 缺原因');
    assert.strictEqual(rObj.body.field, 'reason');
    expectErr(await post(U.pm, url, await bodyOf(s.pid, t, 'reject', { reason: '  ' })), 400, 'SYSBUILD_INVALID_INPUT', 'reject 原因空白');
    expectErr(await post(U.pm, url, await good({ reason: '确'.repeat(501), decision: 'object' })), 400, 'SYSBUILD_INVALID_INPUT', '原因 501 字');
    expectErr(await post(U.pm, '/sysbuild/confirm-tasks/abc/proxy', await good()), 400, 'SYSBUILD_INVALID_INPUT', '任务编号非法');
    expectErr(await post(U.pm, '/sysbuild/confirm-tasks/99999999/proxy', await good({ attachment_ids: undefined })), 400, 'SYSBUILD_INVALID_INPUT', '参数形态先于 404');
    // 404：任务不存在 / 非项目成员（用格式合格的请求体）
    expectErr(await post(U.pm, '/sysbuild/confirm-tasks/99999999/proxy', await good()), 404, 'SYSBUILD_NOT_FOUND', '任务不存在');
    expectErr(await post(U.out, url, await good()), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    // 403：不是本项目 PM（一般成员、必需确认人本人（无账号，用同参与方的有账号成员代替：负责人本人看不到别人的任务也一样 403）、admin 非 PM、只读账号成员）
    await addMember(s.pid, U.ro);
    for (const [uid, label] of [[U.m1, '一般成员'], [U.admin, 'admin 非 PM'], [U.ro, '只读账号成员']]) expectErr(await post(uid, url, await good()), 403, 'SYSBUILD_FORBIDDEN', label);
    // 403 先于 409：非 PM 带着过期修订号也是 403
    expectErr(await post(U.m1, url, await good({ revision_id: t.rev_id + 999 })), 403, 'SYSBUILD_FORBIDDEN', '403 先于 409');
    // 409：修订号 / 版本号
    const stale = await post(U.pm, url, await good({ revision_id: t.rev_id + 999 }));
    expectErr(stale, 409, 'SYSBUILD_TASK_SUPERSEDED', '修订号不符');
    expectErr(await post(U.pm, url, await good({ object_version_id: s.pv + 999 })), 409, 'SYSBUILD_VERSION_CHANGED', '版本号不符');
    // 409 先于 400 日期范围：过期修订号 + 晚于今天的日期 → 先报 409
    expectErr(await post(U.pm, url, await good({ revision_id: t.rev_id + 999, external_date: addDays(today(), 1) })), 409, 'SYSBUILD_TASK_SUPERSEDED', '409 先于日期范围');
    // 409：对象版本不再待确认
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'superseded' WHERE id = ?", [s.pv]);
    expectErr(await post(U.pm, url, await good()), 409, 'SYSBUILD_VERSION_CHANGED', '版本不再待确认');
    await sqlRun("UPDATE sysbuild_package_versions SET status = 'pending' WHERE id = ?", [s.pv]);
    // 409：资格失效（依据的任职已结束 / 授权已撤销 / 成员已移出）——代录与决策同一个资格复核
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '离任' WHERE id = ?", [s.apt]);
    const lost = await post(U.pm, url, await good());
    expectErr(lost, 409, 'SYSBUILD_STATE', '任职已结束');
    assert.ok(lost.body.message.includes('任职'), `提示实际 ${lost.body.message}`);
    await sqlRun("UPDATE sysbuild_appointments SET status = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?", [s.apt]);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'revoked', revoked_at = '2026-10-21 10:00:00', revoke_reason = '换人' WHERE id = ?", [s.dlg]);
    const lostD = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'confirm'));
    expectErr(lostD, 409, 'SYSBUILD_STATE', '授权已撤销');
    assert.ok(lostD.body.message.includes('授权'), `提示实际 ${lostD.body.message}`);
    await sqlRun("UPDATE sysbuild_delegations SET status = 'active', revoked_at = NULL, revoke_reason = NULL WHERE id = ?", [s.dlg]);
    await sqlRun("UPDATE sysbuild_members SET removed_at = '2026-10-22 10:00:00', removed_reason = '离项' WHERE id = ?", [s.mOwn]);
    const gone = await post(U.pm, url, await good());
    expectErr(gone, 409, 'SYSBUILD_STATE', '成员已移出');
    assert.ok(gone.body.message.includes('成员'), `提示实际 ${gone.body.message}`);
    await sqlRun('UPDATE sysbuild_members SET removed_at = NULL, removed_reason = NULL WHERE id = ?', [s.mOwn]);
    // 400：日期范围（上限 = 今天，下限 = 本修订创建日；两侧边界各一条合法 + 一条非法）与附件可用性
    const tomorrow = addDays(today(), 1);
    const rLate = await post(U.pm, url, await good({ external_date: tomorrow }));
    expectErr(rLate, 400, 'SYSBUILD_INVALID_INPUT', '晚于今天');
    assert.strictEqual(rLate.body.field, 'external_date');
    const rEarly = await post(U.pm, url, await good({ external_date: addDays(FLOOR, -1) }));
    expectErr(rEarly, 400, 'SYSBUILD_INVALID_INPUT', '早于修订创建日');
    assert.strictEqual(rEarly.body.field, 'external_date');
    const other = await stageAtt(s.pid, U.m1, 'r'); // 别人暂存的附件
    const rOther = await post(U.pm, url, await good({ attachment_ids: [other] }));
    expectErr(rOther, 400, 'SYSBUILD_INVALID_INPUT', '别人的附件');
    assert.strictEqual(rOther.body.field, 'attachment_ids');
    expectErr(await post(U.pm, url, await good({ attachment_ids: [99999999] })), 400, 'SYSBUILD_INVALID_INPUT', '附件不存在');
    const foreign = await stageAtt(await newProject(), U.pm, 's'); // 别的项目的附件
    expectErr(await post(U.pm, url, await good({ attachment_ids: [foreign] })), 400, 'SYSBUILD_INVALID_INPUT', '别的项目的附件');
    assert.strictEqual(await taskSnap(t.task_id), snap0, '被拒绝的代录不改任何状态（含附件绑定与事件）');
    // 边界合法：外部日期 = 创建日（下限）通过；另一条任务用 = 今天（上限）通过
    const okLow = await post(U.pm, url, await good({ external_date: FLOOR }));
    assert.strictEqual(okLow.status, 200, `等于创建日应通过 ${okLow.text}`);
    const okHigh = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'confirm', { external_date: today() }));
    assert.strictEqual(okHigh.status, 200, `等于今天应通过 ${okHigh.text}`);
    assert.deepStrictEqual((await sqlAll('SELECT external_date FROM sysbuild_confirmations WHERE object_version_id = ? ORDER BY id', [s.pv])).map((r) => r.external_date), [FLOOR, today()]);
    // 附件一旦被某次代录绑定，不能再被另一次代录使用
    const usedAtt = (await sqlGet("SELECT attachment_id AS a FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id LIMIT 1")).a;
    const s2 = await mkNaScene();
    const rUsed = await post(U.pm, proxyUrl(s2.tasks[0].task_id), await bodyOf(s2.pid, s2.tasks[0], 'confirm', { attachment_ids: [usedAtt] }));
    expectErr(rUsed, 400, 'SYSBUILD_INVALID_INPUT', '附件已被使用');
    assert.strictEqual((await revOf(s2.tasks[0].rev_id)).status, 'pending', '附件校验失败整体回滚，修订仍待确认');
    // 409 项目状态：已终止 / 已暂停可代录
    const s3 = await mkNaScene();
    assert.strictEqual((await setStatus(s3.pid, 'paused')).status, 200);
    assert.strictEqual((await post(U.pm, proxyUrl(s3.tasks[0].task_id), await bodyOf(s3.pid, s3.tasks[0], 'confirm'))).status, 200, '已暂停可代录');
    assert.strictEqual((await setStatus(s3.pid, 'terminated')).status, 200);
    expectErr(await post(U.pm, proxyUrl(s3.tasks[1].task_id), await bodyOf(s3.pid, s3.tasks[1], 'confirm')), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
  });

  // ── 4 有异议 / 不认可 ─────────────────────────────────────────────────────────────────────────
  test('C4b 代录：有异议 / 不认可——包不生效，修订终态 objected / rejected，确认记录带原因；提出人任务不认可 → denied + 原因、确认 → proxy_confirmed、有异议不改提出人状态（均由代录驱动）', async () => {
    const s = await mkNaScene();
    const ro = await post(U.pm, proxyUrl(s.tasks[0].task_id), await bodyOf(s.pid, s.tasks[0], 'object', { reason: '范围要再议' }));
    assert.strictEqual(ro.status, 200, ro.text);
    assert.deepStrictEqual([ro.body.decision, ro.body.revision.status, ro.body.effective, ro.body.version.status], ['object', 'objected', false, 'pending']);
    const co = await rowOf('sysbuild_confirmations', ro.body.confirmation_id);
    assert.deepStrictEqual([co.decision, co.reason, co.method, co.checkbox_text], ['object', '范围要再议', 'proxy', null]);
    const rr = await post(U.pm, proxyUrl(s.tasks[1].task_id), await bodyOf(s.pid, s.tasks[1], 'reject', { reason: '不认可该范围' }));
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual([rr.body.revision.status, rr.body.effective], ['rejected', false]);
    assert.strictEqual(await verStatus(s.pv), 'pending');
    assert.strictEqual(await baselineCountIn(s.pid), 0);
    assert.deepStrictEqual((await payloads(s.pid, 'confirm_proxy_recorded')).map((p) => [p.decision, p.reason]), [['object', '范围要再议'], ['reject', '不认可该范围']]);
    // 提出人任务（无账号成员作提出人）
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mNa = await addNaMember(pid, party, '无账号提出人');
    const pc = await mkProposerTask(pid, mNa);
    const pr = await mkProposerTask(pid, mNa);
    const po = await mkProposerTask(pid, mNa);
    const rc = await post(U.pm, proxyUrl(pc.tid), await proposerBody(pid, pc, 'confirm'));
    assert.strictEqual(rc.status, 200, rc.text);
    assert.deepStrictEqual([rc.body.decision, rc.body.proposer_status, rc.body.revision.status], ['confirm', 'proxy_confirmed', 'confirmed']);
    assert.deepStrictEqual(await itemStatus(pc.ivid), { proposer_status: 'proxy_confirmed', deny_reason: null });
    assert.deepStrictEqual((await payloads(pid, 'item_proposer_status_changed'))[0], { item_id: pc.item.id, from: 'pending', to: 'proxy_confirmed', confirmation_id: rc.body.confirmation_id, method: 'proxy' });
    const cc = await rowOf('sysbuild_confirmations', rc.body.confirmation_id);
    assert.deepStrictEqual([cc.object_type, cc.object_version_id, cc.method, cc.actor_user_id, cc.proxy_by], ['item_version', pc.ivid, 'proxy', null, U.pm]);
    const pcView = await openTask(U.pm, pc.tid);
    assert.deepStrictEqual(pcView.body.confirmations.map((x) => [x.method, x.attachment_ids.length]), [['proxy', 1]], '预筛 MED-2：提出人任务的代录确认记录带凭据附件');
    const rj = await post(U.pm, proxyUrl(pr.tid), await proposerBody(pid, pr, 'reject', { reason: '这不是他提的需求' }));
    assert.strictEqual(rj.status, 200, rj.text);
    assert.deepStrictEqual([rj.body.proposer_status, rj.body.revision.status], ['denied', 'rejected']);
    assert.deepStrictEqual(await itemStatus(pr.ivid), { proposer_status: 'denied', deny_reason: '这不是他提的需求' });
    const ob = await post(U.pm, proxyUrl(po.tid), await proposerBody(pid, po, 'object', { reason: '原话要点不准' }));
    assert.strictEqual(ob.status, 200, ob.text);
    assert.deepStrictEqual([ob.body.proposer_status, ob.body.revision.status], [undefined, 'objected']);
    assert.deepStrictEqual(await itemStatus(po.ivid), { proposer_status: 'pending', deny_reason: null }, '有异议不改提出人状态');
    assert.strictEqual((await payloads(pid, 'item_proposer_status_changed')).length, 2, '有异议不写提出人状态事件');
    // 提出人状态已变（denied）的版本，对应的修订已是终态：再代录 409
    expectErr(await post(U.pm, proxyUrl(pc.tid), await proposerBody(pid, pc, 'confirm')), 409, 'SYSBUILD_STATE', '提出人已确认再代录');
  });

  // ── 5 提出人任务：无账号提出人 / 只填姓名 / 改发 ──────────────────────────────────────────────
  test('C4b 代录：提出人——提出人是无账号成员 → 生成任务（proxy_only）并冻结条目附件、只能代录确认；只填姓名 → 不生成任务（P47）；有账号成员的任务不是 proxy_only（提出人账号停用时不生成任务见 C4a 用例「C4a 确认人解析与资格同源」；账号停用时的改发 / 代录见进程内用例「C4b 账号停用」）', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mNa = await addNaMember(pid, party, '无账号提出人');
    const att = await stageAtt(pid, U.pm, 'c');
    const it = await mkItem(pid, { proposer_name: undefined, proposer_member_id: mNa, attachment_ids: [att], no_written_evidence: undefined, no_evidence_reason: undefined });
    const task = await sqlGet("SELECT * FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id]);
    assert.deepStrictEqual([task.project_id, task.object_id, task.purpose, task.party_id, task.created_by], [pid, it.id, 'proposer_confirm', party, U.pm]);
    const revs = await sqlAll('SELECT rev_no, required_member_id, basis_appointment_id, basis_delegation_id, status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [task.id]);
    assert.deepStrictEqual(revs, [{ rev_no: 1, required_member_id: mNa, basis_appointment_id: null, basis_delegation_id: null, status: 'pending' }]);
    assert.deepStrictEqual(await sqlAll("SELECT attachment_id, sha256 FROM sysbuild_frozen_attachments WHERE object_type = 'item_version' AND object_version_id = ?", [it.versions[0].id]), [{ attachment_id: att, sha256: 'c'.repeat(64) }]);
    const d = await openTask(U.pm, task.id);
    assert.deepStrictEqual([d.body.revision.proxy_only, d.body.actions.proxy, d.body.actions.decide], [true, true, false]);
    // 只填姓名：不生成任务（P47）
    const it2 = await mkItem(pid);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it2.versions[0].id]), 0);
    // 有账号成员作提出人：任务不是 proxy_only
    const m1 = await addMember(pid, U.m1, { party });
    const it3 = await mkItem(pid, { proposer_name: undefined, proposer_member_id: m1 });
    const t3 = await sqlGet("SELECT id FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [it3.versions[0].id]);
    assert.strictEqual((await openTask(U.pm, t3.id)).body.revision.proxy_only, false);
    // 条目出新版本：给上一版本的无账号提出人沿用 → 新版本也生成任务，旧版本的待确认修订置已替代
    const v2 = await post(U.pm, `/sysbuild/items/${it.id}/versions`, { content: '修订后的需求', ref_attachment_ids: [att] });
    assert.strictEqual(v2.status, 201, v2.text);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [v2.body.item_version_id]), 1, '沿用无账号提出人：新版本也生成任务');
    assert.strictEqual((await sqlGet('SELECT status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [task.id])).status, 'superseded');
  });

  test('C4b 提出人改发（P48）：终止项目后重开 → 修订已失效 → 改发出新修订（无账号提出人仍 proxy_only）→ 可代录；提出人已移出 / 条目已有新版本 → 改发 409 且 actions.reissue 为假（账号停用见进程内用例「C4b 账号停用」，其他对象类型任务不能改发见任职代录用例）', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mNa = await addNaMember(pid, party, '无账号提出人');
    const p = await mkProposerTask(pid, mNa);
    const reissue = (uid, tid, reason) => post(uid, `/sysbuild/confirm-tasks/${tid}/reissue`, reason === undefined ? {} : { reason });
    assert.strictEqual((await setStatus(pid, 'terminated')).status, 200);
    assert.strictEqual((await revOf(p.rid)).status, 'invalid', '终止项目：待确认修订置已失效');
    assert.strictEqual((await setStatus(pid, 'active')).status, 200);
    const flag0 = (await openTask(U.pm, p.tid)).body.actions;
    assert.deepStrictEqual([flag0.reissue, flag0.proxy], [true, false], '已失效的修订：可改发，不可代录');
    expectErr(await post(U.pm, proxyUrl(p.tid), await proposerBody(pid, p, 'confirm')), 409, 'SYSBUILD_STATE', '已失效不能直接代录');
    const rr = await reissue(U.pm, p.tid, '重新请对方确认');
    assert.strictEqual(rr.status, 200, rr.text);
    assert.deepStrictEqual(rr.body, { task_id: p.tid, revision: { id: rr.body.revision.id, rev_no: 2, status: 'pending', required_member_id: mNa, proxy_only: true } });
    assert.strictEqual((await revOf(p.rid)).status, 'invalid', '已失效的旧修订保留原状');
    assert.deepStrictEqual((await payloads(pid, 'confirm_task_reissued')).pop(), {
      revision_id: rr.body.revision.id, previous_revision_id: p.rid, rev_no: 2, required_member_id: mNa, basis_appointment_id: null, basis_delegation_id: null, reason: '重新请对方确认',
    });
    // 新修订可代录（外部日期下限 = 新修订创建日：回拨后再代录）
    await backdateRevs([rr.body.revision.id]);
    const ok = await post(U.pm, proxyUrl(p.tid), await proposerBody(pid, { rid: rr.body.revision.id, ivid: p.ivid }, 'confirm'));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await itemStatus(p.ivid)).proposer_status, 'proxy_confirmed');
    expectErr(await reissue(U.pm, p.tid, '已确认再改发'), 409, 'SYSBUILD_STATE', '提出人已确认（对象版本不再待确认）不能改发');
    // 提出人已移出 → 改发 409，标志为假
    const q = await mkProposerTask(pid, mNa);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${mNa}/remove`, { reason: '离项' })).status, 200);
    const flagG = (await openTask(U.pm, q.tid)).body.actions;
    assert.deepStrictEqual([flagG.reissue, flagG.proxy], [false, false], '提出人已移出：改发 / 代录标志都为假');
    const rg = await reissue(U.pm, q.tid, '改发');
    expectErr(rg, 409, 'SYSBUILD_STATE', '提出人已移出');
    assert.ok(rg.body.message.includes('提出人'), `提示实际 ${rg.body.message}`);
    // 条目已有新版本：旧版本任务的修订已被替代（pending → superseded）；对旧版本上已有异议的修订改发 → 409（请对新版本处理）
    const pid2 = await newProject();
    const party2 = await addParty(pid2, '乙部', 'demand');
    const mNa2 = await addNaMember(pid2, party2, '另一个无账号提出人');
    const o = await mkProposerTask(pid2, mNa2);
    assert.strictEqual((await post(U.pm, proxyUrl(o.tid), await proposerBody(pid2, o, 'object', { reason: '要改' }))).status, 200);
    const v2 = await post(U.pm, `/sysbuild/items/${o.item.id}/versions`, { content: '新版本需求', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(v2.status, 201, v2.text);
    assert.strictEqual((await openTask(U.pm, o.tid)).body.actions.reissue, false, '条目已有新版本：旧版本任务的改发标志为假');
    const rv = await reissue(U.pm, o.tid, '改发旧版本');
    expectErr(rv, 409, 'SYSBUILD_STATE', '条目已有新版本');
    assert.ok(rv.body.message.includes('新版本'), `提示实际 ${rv.body.message}`);
    // （有账号提出人账号停用后不能改发：见进程内专属用例「C4b 账号停用（进程内）」）
  });

  // ── 6 任职接受代录 ────────────────────────────────────────────────────────────────────────────
  async function mkApptScene(withOld) {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    let old = null;
    if (withOld) {
      const mOld = await addMember(pid, U.own, { party });
      const aptOld = await addAppointment(party, mOld, 'active');
      const mDelOld = await addMember(pid, U.del, { party });
      old = { mOld, aptOld, dlgOld: await addDelegation(party, mDelOld, aptOld, 'active') };
    }
    const mNa = await addNaMember(pid, party, '无账号张三');
    const r = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: mNa });
    assert.strictEqual(r.status, 201, r.text);
    assert.strictEqual(r.body.invitation, null, '无账号成员的任职提议不建邀请');
    await backdate('sysbuild_appointments', [r.body.appointment.id]);
    return { pid, party, mNa, apt: r.body.appointment.id, old };
  }
  const apptProxy = (uid, apt, body) => post(uid, `/sysbuild/appointments/${apt}/proxy-accept`, body);
  test('C4b 代录：任职——无账号成员的任职接受由 PM 代录：同事务建 invitation（已接受）+ 任务（accept_invitation）+ 修订（已确认）+ confirmations(proxy)，任职生效且原负责人更换、其授权一并撤销；事件手写核对', async () => {
    const s = await mkApptScene(true);
    const att = await stageAtt(s.pid, U.pm, 'w');
    const body = await evid(s.pid, { attachment_ids: [att], actual_confirmer: '张三', identity_basis: '电话确认接任甲部负责人，记录见附件' });
    const r = await apptProxy(U.pm, s.apt, body);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, {
      appointment: { id: s.apt, status: 'active' }, invitation: { id: r.body.invitation.id, kind: 'appointment', status: 'accepted' },
      task_id: r.body.task_id, revision_id: r.body.revision_id, confirmation_id: r.body.confirmation_id, attachment_ids: [att],
    });
    const a = await rowOf('sysbuild_appointments', s.apt);
    assert.deepStrictEqual([a.status, a.member_id, a.party_id], ['active', s.mNa, s.party]);
    assert.ok(a.effective_at);
    const inv = await rowOf('sysbuild_invitations', r.body.invitation.id);
    assert.deepStrictEqual([inv.project_id, inv.member_id, inv.kind, inv.appointment_id, inv.status, inv.invited_by], [s.pid, s.mNa, 'appointment', s.apt, 'accepted', U.pm]);
    assert.ok(inv.responded_at);
    const task = await rowOf('sysbuild_confirm_tasks', r.body.task_id);
    assert.deepStrictEqual([task.project_id, task.object_type, task.object_id, task.object_version_id, task.purpose, task.party_id, task.created_by], [s.pid, 'invitation', inv.id, inv.id, 'accept_invitation', s.party, U.pm]);
    const rev = await rowOf('sysbuild_confirm_task_revisions', r.body.revision_id);
    assert.deepStrictEqual([rev.task_id, rev.rev_no, rev.required_member_id, rev.basis_appointment_id, rev.basis_delegation_id, rev.status], [task.id, 1, s.mNa, null, null, 'confirmed']);
    const c = await rowOf('sysbuild_confirmations', r.body.confirmation_id);
    assert.deepStrictEqual(c, {
      id: c.id, task_revision_id: rev.id, object_type: 'invitation', object_version_id: inv.id, actor_user_id: null, actual_confirmer: '张三', identity_basis: '电话确认接任甲部负责人，记录见附件',
      method: 'proxy', decision: 'confirm', checkbox_text: null, reason: null, view_id: null, external_date: OK_DATE, proxy_by: U.pm, card_instance_id: null, dingtalk_user_id: null, created_at: c.created_at,
    });
    assert.deepStrictEqual(await sqlAll("SELECT attachment_id, owner_type, owner_id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' AND owner_id = ?", [c.id]), [{ attachment_id: att, owner_type: 'confirmation', owner_id: c.id }]);
    // 原负责人更换：旧任职 ended（负责人更换），旧授权 revoked（负责人更换后需重新授权）
    const oldA = await rowOf('sysbuild_appointments', s.old.aptOld);
    assert.deepStrictEqual([oldA.status, oldA.end_reason], ['ended', '负责人更换']);
    const oldD = await rowOf('sysbuild_delegations', s.old.dlgOld);
    assert.deepStrictEqual([oldD.status, oldD.revoke_reason], ['revoked', '负责人更换后需重新授权']);
    // 事件
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_proxy_accepted'), [{ party_id: s.party, member_id: s.mNa, invitation_id: inv.id, task_id: task.id, revision_id: rev.id, confirmation_id: c.id }]);
    assert.deepStrictEqual(await payloads(s.pid, 'appointment_activated'), [{ party_id: s.party, member_id: s.mNa, replaced: [s.old.aptOld] }]);
    assert.deepStrictEqual((await payloads(s.pid, 'invitation_accepted')).pop(), { kind: 'appointment', member_id: s.mNa, appointment_id: s.apt, via: 'proxy' });
    assert.deepStrictEqual((await payloads(s.pid, 'confirm_proxy_recorded')).pop(), {
      confirmation_id: c.id, revision_id: rev.id, object_type: 'invitation', object_version_id: inv.id, required_member_id: s.mNa, decision: 'confirm', method: 'proxy',
      actual_confirmer: '张三', external_date: OK_DATE, attachment_ids: [att], reason: null,
    });
    // 之后：任务详情只读（对象类型邀请）、不可再代录 / 改发
    const d = await openTask(U.pm, task.id);
    assert.strictEqual(d.status, 200, d.text);
    assert.deepStrictEqual([d.body.object.type, d.body.actions], ['invitation', { decide: false, proxy: false, reissue: false, export_sheet: false }]);
    assert.deepStrictEqual(d.body.confirmations.map((x) => [x.method, x.attachment_ids]), [['proxy', [att]]], '预筛 MED-2：任职代录的确认记录带凭据附件');
    expectErr(await post(U.pm, proxyUrl(task.id), { revision_id: rev.id, object_version_id: inv.id, decision: 'confirm', external_date: OK_DATE, actual_confirmer: 'x', identity_basis: 'y', attachment_ids: [await stageAtt(s.pid, U.pm, 'z')] }), 409, 'SYSBUILD_STATE', '邀请类任务不能再代录');
    expectErr(await post(U.pm, `/sysbuild/confirm-tasks/${task.id}/reissue`, { reason: '改发' }), 409, 'SYSBUILD_STATE', '邀请类任务不能改发');
    // 再调用一次：任职已不是待接受 → 409，不再建邀请
    const nInv = await countOf('SELECT COUNT(*) AS n FROM sysbuild_invitations WHERE appointment_id = ?', [s.apt]);
    expectErr(await apptProxy(U.pm, s.apt, await evid(s.pid)), 409, 'SYSBUILD_STATE', '任职已生效再代录');
    assert.strictEqual(await countOf('SELECT COUNT(*) AS n FROM sysbuild_invitations WHERE appointment_id = ?', [s.apt]), nInv);
  });

  test('C4b 代录：任职接受的校验——有账号成员 409（请走邀请）；已移出 409；非 PM 403（admin 非 PM / 负责人 / 一般成员）；非成员 404；日期范围 / 附件 / 多余键 400；已终止 409、已暂停与已结项可；被拒的请求不建邀请、不建任务、任职不变', async () => {
    const s = await mkApptScene(false);
    const url = (apt) => `/sysbuild/appointments/${apt}/proxy-accept`;
    await addMember(s.pid, U.m1);
    const snap = async () => JSON.stringify([
      await sqlAll('SELECT id, status FROM sysbuild_appointments WHERE party_id = ? ORDER BY id', [s.party]),
      await sqlAll('SELECT id, status FROM sysbuild_invitations WHERE project_id = ? ORDER BY id', [s.pid]),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [s.pid]),
      await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
    ]);
    const before = await snap();
    // 400
    for (const [extra, field, label] of [[{ x: 1 }, 'x', '多余键'], [{ decision: 'confirm' }, 'decision', '不收 decision'], [{ revision_id: 1 }, 'revision_id', '不收 revision_id'],
      [{ external_date: undefined }, 'external_date', '缺日期'], [{ actual_confirmer: undefined }, 'actual_confirmer', '缺确认人'], [{ identity_basis: undefined }, 'identity_basis', '缺依据'], [{ attachment_ids: [] }, 'attachment_ids', '缺附件']]) {
      const r = await apptProxy(U.pm, s.apt, await evid(s.pid, extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field, `${label} 的 field`);
    }
    expectErr(await post(U.pm, '/sysbuild/appointments/abc/proxy-accept', await evid(s.pid)), 400, 'SYSBUILD_INVALID_INPUT', '任职编号非法');
    // 404 / 403
    expectErr(await apptProxy(U.pm, 99999999, await evid(s.pid)), 404, 'SYSBUILD_NOT_FOUND', '任职不存在');
    expectErr(await apptProxy(U.out, s.apt, await evid(s.pid)), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    for (const [uid, label] of [[U.m1, '一般成员'], [U.admin, 'admin 非 PM']]) expectErr(await apptProxy(uid, s.apt, await evid(s.pid)), 403, 'SYSBUILD_FORBIDDEN', label);
    // 400 日期范围：上限 = 今天、下限 = 任职提议创建日
    expectErr(await apptProxy(U.pm, s.apt, await evid(s.pid, { external_date: addDays(today(), 1) })), 400, 'SYSBUILD_INVALID_INPUT', '晚于今天');
    expectErr(await apptProxy(U.pm, s.apt, await evid(s.pid, { external_date: addDays(FLOOR, -1) })), 400, 'SYSBUILD_INVALID_INPUT', '早于提议创建日');
    expectErr(await apptProxy(U.pm, s.apt, await evid(s.pid, { attachment_ids: [await stageAtt(s.pid, U.m1, 'k')] })), 400, 'SYSBUILD_INVALID_INPUT', '别人的附件');
    assert.strictEqual(await snap(), before, '被拒的请求不改任何状态');
    // 409：有账号成员（走邀请）
    const mAcc = await addMember(s.pid, U.cand, { party: s.party });
    const rAcc = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mAcc });
    expectErr(rAcc, 409, 'SYSBUILD_STATE', '同一参与方已有待接受的任职提议'); // 先撤回无账号的那条再提议
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${s.apt}/withdraw`)).status, 200);
    const rAcc2 = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mAcc });
    assert.strictEqual(rAcc2.status, 201, rAcc2.text);
    assert.ok(rAcc2.body.invitation, '有账号成员的任职提议建邀请');
    await backdate('sysbuild_appointments', [rAcc2.body.appointment.id]);
    const before2 = await snap();
    const rA = await apptProxy(U.pm, rAcc2.body.appointment.id, await evid(s.pid));
    expectErr(rA, 409, 'SYSBUILD_STATE', '有账号成员');
    assert.ok(rA.body.message.includes('平台账号'), `提示实际 ${rA.body.message}`);
    assert.strictEqual(await snap(), before2, '有账号成员被拒：不建邀请、不建任务、任职仍待接受');
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${rAcc2.body.appointment.id}/withdraw`)).status, 200);
    // 409：成员已移出（任职提议随移出级联撤回 → 状态不是待接受）；已撤回的任职
    const s2 = await mkApptScene(false);
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${s2.mNa}/remove`, { reason: '离项' })).status, 200);
    expectErr(await apptProxy(U.pm, s2.apt, await evid(s2.pid)), 409, 'SYSBUILD_STATE', '成员已移出');
    // 已加入标志缺失（成员行未加入）：夹具把 joined_at 置空
    const s3 = await mkApptScene(false);
    await sqlRun('UPDATE sysbuild_members SET joined_at = NULL WHERE id = ?', [s3.mNa]);
    const rJ = await apptProxy(U.pm, s3.apt, await evid(s3.pid));
    expectErr(rJ, 409, 'SYSBUILD_STATE', '成员未加入');
    assert.ok(rJ.body.message.includes('尚未加入') || rJ.body.message.includes('已移出'), `提示实际 ${rJ.body.message}`);
    // 项目状态：membership 行——已终止 409，已暂停 / 已结项可（D3）
    const s4 = await mkApptScene(false);
    assert.strictEqual((await setStatus(s4.pid, 'terminated')).status, 200);
    expectErr(await apptProxy(U.pm, s4.apt, await evid(s4.pid)), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(s4.pid, 'active')).status, 200);
    assert.strictEqual((await setStatus(s4.pid, 'paused')).status, 200);
    assert.strictEqual((await apptProxy(U.pm, s4.apt, await evid(s4.pid))).status, 200, '已暂停可代录');
    const s5 = await mkApptScene(false);
    await sqlRun("UPDATE sysbuild_projects SET status = 'closed' WHERE id = ?", [s5.pid]);
    assert.strictEqual((await apptProxy(U.pm, s5.apt, await evid(s5.pid))).status, 200, '已结项可代录（与本人接受同属 membership 行）');
    // 日期边界合法：= 创建日 / = 今天
    const s6 = await mkApptScene(false);
    assert.strictEqual((await apptProxy(U.pm, s6.apt, await evid(s6.pid, { external_date: FLOOR }))).status, 200, '等于提议创建日通过');
    const s7 = await mkApptScene(false);
    assert.strictEqual((await apptProxy(U.pm, s7.apt, await evid(s7.pid, { external_date: today() }))).status, 200, '等于今天通过');
    // 只读账号作 PM 也不行
    const s8 = await mkApptScene(false);
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.ro, s8.pid]);
    await sqlRun('INSERT INTO sysbuild_members (project_id, user_id, joined_at, added_by) VALUES (?, ?, ?, ?)', [s8.pid, U.ro, '2026-10-01 10:00:00', U.admin]);
    expectErr(await apptProxy(U.ro, s8.apt, await evid(s8.pid)), 403, 'SYSBUILD_FORBIDDEN', '只读账号即使是 PM');
  });

  // ── 7 授权代录 ────────────────────────────────────────────────────────────────────────────────
  // 旧场景默认描述批准；接受场景必须在调用处固定声明，不能由当前状态推算意图。
  const dlgProxy = (uid, did, body, expectedStep = 'grant') => post(uid, `/sysbuild/delegations/${did}/proxy`, { ...body, expected_step: expectedStep });
  // 把某条授权的平台批准事件时间回拨（接受一步的外部日期下限取它，codex 21 号 L1 / G3）
  const backdateApproval = (did, at) => sqlRun("UPDATE sysbuild_events SET created_at = ? WHERE object_type = 'delegation' AND object_id = ? AND event_type = 'delegation_approved'", [at || FLOOR_AT, did]);
  // 无账号负责人（经任职代录生效）+ 无账号被授权人；PM 提议授权 → pending_owner
  async function mkDlgScene(ownerAccount) {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    let mOwn;
    let apt;
    if (ownerAccount) {
      mOwn = await addMember(pid, U.own, { party });
      apt = await addAppointment(party, mOwn, 'active');
    } else {
      mOwn = await addNaMember(pid, party, '无账号负责人');
      const ra = await post(U.pm, `/sysbuild/parties/${party}/appointments`, { member_id: mOwn });
      assert.strictEqual(ra.status, 201, ra.text);
      apt = ra.body.appointment.id;
      await backdate('sysbuild_appointments', [apt]);
      const acc = await apptProxy(U.pm, apt, await evid(pid));
      assert.strictEqual(acc.status, 200, acc.text);
    }
    return { pid, party, mOwn, apt };
  }
  async function proposeDlg(s, memberId) {
    const r = await post(U.pm, `/sysbuild/parties/${s.party}/delegations`, { member_id: memberId });
    assert.strictEqual(r.status, 201, r.text);
    await backdate('sysbuild_delegations', [r.body.delegation.id]);
    return r.body.delegation.id;
  }
  test('C7 F-1 授权代录意图锁：缺失或非法步骤400；接受不能代替批准；旧页批准重试409且任务、确认、绑定与授权不变；明确接受后才生效', async () => {
    const s = await mkDlgScene(false);
    const member = await addNaMember(s.pid, s.party, '意图锁无账号代表人');
    const did = await proposeDlg(s, member);
    const url = `/sysbuild/delegations/${did}/proxy`;
    for (const step of [undefined, null, '', 'approve', {}, ['grant']]) {
      const rejected = await post(U.pm, url, await evid(s.pid, { expected_step: step }));
      expectErr(rejected, 400, 'SYSBUILD_INVALID_INPUT', '缺失或非法步骤');
      assert.strictEqual(rejected.body.field, 'expected_step');
    }
    const snap = async () => JSON.stringify([
      await rowOf('sysbuild_delegations', did),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [s.pid]),
      await sqlAll('SELECT c.id FROM sysbuild_confirmations c JOIN sysbuild_confirm_task_revisions r ON r.id = c.task_revision_id JOIN sysbuild_confirm_tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY c.id', [s.pid]),
      await sqlAll('SELECT b.id FROM sysbuild_attachment_bindings b JOIN sysbuild_attachments a ON a.id = b.attachment_id WHERE a.project_id = ? ORDER BY b.id', [s.pid]),
      await sqlAll('SELECT id, event_type FROM sysbuild_events WHERE project_id = ? ORDER BY id', [s.pid]),
    ]);
    const wrongAccept = await evid(s.pid);
    const before = await snap();
    const rejected = await dlgProxy(U.pm, did, wrongAccept, 'accept');
    expectErr(rejected, 409, 'SYSBUILD_STATE', '批准前不可代录接受');
    assert.ok(rejected.body.message.includes('授权步骤已变化'));
    assert.strictEqual(await snap(), before, '步骤不符不得产生任何业务写入');
    assert.strictEqual((await dlgProxy(U.pm, did, await evid(s.pid))).status, 200);
    const staleGrant = await evid(s.pid); // 响应丢失后重新暂存凭据，附件编号不同仍不能推进到接受。
    const granted = await snap();
    const retried = await dlgProxy(U.pm, did, staleGrant);
    expectErr(retried, 409, 'SYSBUILD_STATE', '旧页批准重试');
    assert.ok(retried.body.message.includes('授权步骤已变化'));
    assert.strictEqual(await snap(), granted, '旧页批准重试不得冒认本人接受');
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'pending_accept');
    const accepted = await dlgProxy(U.pm, did, await evid(s.pid), 'accept');
    assert.strictEqual(accepted.status, 200, accepted.text);
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'active');
  });
  test('C4b 代录：授权——无账号负责人 + 无账号被授权人：PM 提议（原 C2 守卫已去）→ 代录负责人批准（delegation_grant）→ 代录本人接受（delegation_accept）→ 生效；两步各建任务 / 已确认修订 / 代录确认记录，原代表人撤销；之后总体规划包的两条任务都只能代录并可生效', async () => {
    const s = await mkDlgScene(false);
    // 原生效代表人（有账号，夹具）：接受后被撤销
    const mOldDel = await addMember(s.pid, U.del, { party: s.party });
    const oldDlg = await addDelegation(s.party, mOldDel, s.apt, 'active');
    const mNaDel = await addNaMember(s.pid, s.party, '无账号代表人');
    const did = await proposeDlg(s, mNaDel);
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'pending_owner');
    // 第一步：代录负责人批准
    const att1 = await stageAtt(s.pid, U.pm, 'g');
    const r1 = await dlgProxy(U.pm, did, await evid(s.pid, { attachment_ids: [att1], actual_confirmer: '无账号负责人本人', identity_basis: '现任负责人，电话批准' }));
    assert.strictEqual(r1.status, 200, r1.text);
    assert.deepStrictEqual(r1.body, { delegation: { id: did, status: 'pending_accept' }, step: 'grant', task_id: r1.body.task_id, revision_id: r1.body.revision_id, confirmation_id: r1.body.confirmation_id, attachment_ids: [att1] });
    assert.strictEqual((await rowOf('sysbuild_delegations', did)).status, 'pending_accept');
    const t1 = await rowOf('sysbuild_confirm_tasks', r1.body.task_id);
    assert.deepStrictEqual([t1.project_id, t1.object_type, t1.object_id, t1.object_version_id, t1.purpose, t1.party_id, t1.created_by], [s.pid, 'delegation', did, did, 'delegation_grant', s.party, U.pm]);
    const v1 = await rowOf('sysbuild_confirm_task_revisions', r1.body.revision_id);
    assert.deepStrictEqual([v1.rev_no, v1.required_member_id, v1.basis_appointment_id, v1.status], [1, s.mOwn, s.apt, 'confirmed']);
    const c1 = await rowOf('sysbuild_confirmations', r1.body.confirmation_id);
    assert.deepStrictEqual([c1.object_type, c1.object_version_id, c1.method, c1.decision, c1.actor_user_id, c1.proxy_by, c1.actual_confirmer, c1.identity_basis], ['delegation', did, 'proxy', 'confirm', null, U.pm, '无账号负责人本人', '现任负责人，电话批准']);
    assert.deepStrictEqual((await openTask(U.pm, r1.body.task_id)).body.confirmations.map((x) => [x.method, x.attachment_ids]), [['proxy', [att1]]], '预筛 MED-2：授权代录的确认记录带凭据附件');
    assert.deepStrictEqual(await payloads(s.pid, 'delegation_proxy_granted'), [{ party_id: s.party, member_id: mNaDel, required_member_id: s.mOwn, task_id: t1.id, revision_id: v1.id, confirmation_id: c1.id }]);
    assert.deepStrictEqual((await payloads(s.pid, 'delegation_approved')).pop(), { party_id: s.party, member_id: mNaDel, via: 'proxy' });
    assert.strictEqual((await eventsOf(s.pid, 'delegation_activated')).length, 0, '批准一步还没生效');
    // 第二步：代录被授权人接受 → 生效，原代表人撤销
    const r2 = await dlgProxy(U.pm, did, await evid(s.pid, { actual_confirmer: '无账号代表人本人', identity_basis: '甲部授权代表人，接受授权' }), 'accept');
    assert.strictEqual(r2.status, 200, r2.text);
    assert.deepStrictEqual([r2.body.delegation, r2.body.step], [{ id: did, status: 'active' }, 'accept']);
    const d = await rowOf('sysbuild_delegations', did);
    assert.strictEqual(d.status, 'active');
    assert.ok(d.effective_at);
    const oldD = await rowOf('sysbuild_delegations', oldDlg);
    assert.deepStrictEqual([oldD.status, oldD.revoke_reason], ['revoked', '代表人更换']);
    const t2 = await rowOf('sysbuild_confirm_tasks', r2.body.task_id);
    assert.deepStrictEqual([t2.object_type, t2.object_id, t2.object_version_id, t2.purpose], ['delegation', did, did, 'delegation_accept']);
    const v2 = await rowOf('sysbuild_confirm_task_revisions', r2.body.revision_id);
    assert.deepStrictEqual([v2.required_member_id, v2.basis_appointment_id, v2.status], [mNaDel, null, 'confirmed']);
    assert.deepStrictEqual((await payloads(s.pid, 'delegation_proxy_accepted')).length, 1);
    assert.deepStrictEqual((await payloads(s.pid, 'delegation_activated')).pop(), { party_id: s.party, member_id: mNaDel, appointment_id: s.apt, replaced: [oldDlg] });
    // 之后没有可代录的步骤
    expectErr(await dlgProxy(U.pm, did, await evid(s.pid)), 409, 'SYSBUILD_STATE', '授权已生效再代录');
    // 连起来：该方的总体规划包提交 → 负责人 + 代表人都是无账号成员 → 两条任务都只能代录，代录后生效（去重键）
    await seedEffectiveInitiation(s.pid);
    const item = await mkItem(s.pid);
    const pk = await mkPackage(s.pid, 'overall');
    const pv = await mkVersion(pk);
    await addToSet(pv, item.versions[0].id, await defaultBatchId(s.pid));
    await planAllNodes(s.pid);
    const sub = await post(U.pm, `/sysbuild/package-versions/${pv}/submit`);
    assert.strictEqual(sub.status, 200, sub.text);
    assert.deepStrictEqual(sub.body.tasks.map((t) => [t.kind, t.required_member_id, t.proxy_only]), [['owner', s.mOwn, true], ['delegate', mNaDel, true]]);
    const tasks = await tasksOf(pv);
    await backdateRevs(tasks.map((t) => t.rev_id));
    for (const t of tasks) assert.strictEqual((await post(U.pm, proxyUrl(t.task_id), await bodyOf(s.pid, t, 'confirm'))).status, 200);
    assert.strictEqual(await verStatus(pv), 'effective');
  });

  test('C4b 代录：授权的校验与分步——负责人有账号时批准一步 409（请负责人本人批准）；被授权人有账号时接受一步 409（请本人接受）；无账号负责人 + 有账号被授权人：代录批准后由本人平台接受；非 PM 403；日期 / 附件 400；状态不对 409', async () => {
    // 负责人有账号：PM 提议 → pending_owner → 代录 409
    const a = await mkDlgScene(true);
    const mNa = await addNaMember(a.pid, a.party, '无账号代表人');
    const didA = await proposeDlg(a, mNa);
    const snapOf = async (pid, did) => JSON.stringify([
      await sqlAll('SELECT id, status FROM sysbuild_delegations WHERE party_id = ? ORDER BY id', [a.party]),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [pid]),
      await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
      did,
    ]);
    const bA = await snapOf(a.pid, didA);
    const rA = await dlgProxy(U.pm, didA, await evid(a.pid));
    expectErr(rA, 409, 'SYSBUILD_STATE', '负责人有账号');
    assert.ok(rA.body.message.includes('负责人'), `提示实际 ${rA.body.message}`);
    assert.strictEqual(await snapOf(a.pid, didA), bA);
    // 负责人本人批准后（平台路径）→ pending_accept，被授权人无账号 → 代录接受
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${didA}/approve`)).status, 200);
    await backdateApproval(didA); // 平台批准的批准日取 delegation_approved 事件时间（真实时钟）；回拨到固定日期，下面接受一步的外部日期才可控（G3）
    await addMember(a.pid, U.m1);
    expectErr(await dlgProxy(U.m1, didA, await evid(a.pid)), 403, 'SYSBUILD_FORBIDDEN', '非 PM');
    expectErr(await dlgProxy(U.own, didA, await evid(a.pid)), 403, 'SYSBUILD_FORBIDDEN', '现任负责人本人也不是 PM');
    const rAcc = await dlgProxy(U.pm, didA, await evid(a.pid), 'accept');
    assert.strictEqual(rAcc.status, 200, rAcc.text);
    assert.deepStrictEqual([rAcc.body.step, rAcc.body.delegation.status], ['accept', 'active']);
    // 被授权人有账号、待接受：代录 409；本人接受照常
    const b = await mkDlgScene(true);
    const mAcc = await addMember(b.pid, U.del, { party: b.party });
    const didB = await proposeDlg(b, mAcc);
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${didB}/approve`)).status, 200);
    const bB = await snapOf(b.pid, didB);
    const rB = await dlgProxy(U.pm, didB, await evid(b.pid), 'accept');
    expectErr(rB, 409, 'SYSBUILD_STATE', '被授权人有账号');
    assert.ok(rB.body.message.includes('被授权人'), `提示实际 ${rB.body.message}`);
    assert.strictEqual(await snapOf(b.pid, didB), bB);
    assert.strictEqual((await post(U.del, `/sysbuild/delegations/${didB}/accept`)).status, 200, '有账号的被授权人本人接受不受影响');
    // 无账号负责人 + 有账号被授权人：代录批准 → 本人接受
    const c = await mkDlgScene(false);
    const mAcc2 = await addMember(c.pid, U.del, { party: c.party });
    const didC = await proposeDlg(c, mAcc2);
    const rC = await dlgProxy(U.pm, didC, await evid(c.pid));
    assert.strictEqual(rC.status, 200, rC.text);
    assert.deepStrictEqual([rC.body.step, rC.body.delegation.status], ['grant', 'pending_accept']);
    expectErr(await dlgProxy(U.pm, didC, await evid(c.pid), 'accept'), 409, 'SYSBUILD_STATE', '有账号被授权人不能代录接受');
    assert.strictEqual((await post(U.del, `/sysbuild/delegations/${didC}/accept`)).status, 200);
    assert.strictEqual((await rowOf('sysbuild_delegations', didC)).status, 'active');
    // 参数 / 404 / 日期 / 附件
    const d = await mkDlgScene(false);
    const mNa2 = await addNaMember(d.pid, d.party, '无账号代表人');
    const didD = await proposeDlg(d, mNa2);
    const bD = await snapOf(d.pid, didD);
    for (const [extra, field, label] of [[{ x: 1 }, 'x', '多余键'], [{ decision: 'confirm' }, 'decision', '不收 decision'], [{ attachment_ids: [] }, 'attachment_ids', '缺附件'], [{ external_date: 'x' }, 'external_date', '日期格式']]) {
      const r = await dlgProxy(U.pm, didD, await evid(d.pid, extra));
      expectErr(r, 400, 'SYSBUILD_INVALID_INPUT', label);
      assert.strictEqual(r.body.field, field);
    }
    expectErr(await post(U.pm, '/sysbuild/delegations/abc/proxy', await evid(d.pid)), 400, 'SYSBUILD_INVALID_INPUT', '授权编号非法');
    expectErr(await dlgProxy(U.pm, 99999999, await evid(d.pid)), 404, 'SYSBUILD_NOT_FOUND', '授权不存在');
    expectErr(await dlgProxy(U.out, didD, await evid(d.pid)), 404, 'SYSBUILD_NOT_FOUND', '非成员');
    expectErr(await dlgProxy(U.admin, didD, await evid(d.pid)), 403, 'SYSBUILD_FORBIDDEN', 'admin 非 PM');
    expectErr(await dlgProxy(U.pm, didD, await evid(d.pid, { external_date: addDays(today(), 1) })), 400, 'SYSBUILD_INVALID_INPUT', '晚于今天');
    expectErr(await dlgProxy(U.pm, didD, await evid(d.pid, { external_date: addDays(FLOOR, -1) })), 400, 'SYSBUILD_INVALID_INPUT', '早于提议创建日');
    expectErr(await dlgProxy(U.pm, didD, await evid(d.pid, { attachment_ids: [await stageAtt(d.pid, U.m1, 'u')] })), 400, 'SYSBUILD_INVALID_INPUT', '别人的附件');
    assert.strictEqual(await snapOf(d.pid, didD), bD, '被拒的请求不改任何状态');
    // 依据的负责人任职已变化：409（提议所依据的任职不再现行）
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '离任' WHERE id = ?", [d.apt]);
    expectErr(await dlgProxy(U.pm, didD, await evid(d.pid)), 409, 'SYSBUILD_STATE', '依据任职已结束');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'active', ended_at = NULL, end_reason = NULL WHERE id = ?", [d.apt]);
    // 日期边界合法 + 项目状态
    assert.strictEqual((await dlgProxy(U.pm, didD, await evid(d.pid, { external_date: FLOOR }))).status, 200, '等于提议创建日通过');
    assert.strictEqual((await dlgProxy(U.pm, didD, await evid(d.pid, { external_date: today() }), 'accept')).status, 200, '等于今天通过（接受一步）');
    const e = await mkDlgScene(false);
    const mNa3 = await addNaMember(e.pid, e.party, '无账号代表人');
    const didE = await proposeDlg(e, mNa3);
    assert.strictEqual((await setStatus(e.pid, 'terminated')).status, 200);
    expectErr(await dlgProxy(U.pm, didE, await evid(e.pid)), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    assert.strictEqual((await setStatus(e.pid, 'active')).status, 200);
    assert.strictEqual((await dlgProxy(U.pm, didE, await evid(e.pid))).status, 200, '重开后可代录');
  });

  test('C4b 无账号授权：无账号成员可以被授权为代表人（Q-D1，原 C2 守卫「无账号成员不能被授权为代表人」已去）——PM 发起 pending_owner、负责人发起 pending_accept；其余前置不变（未加入 / 已移出 / 负责人本人 / 已是生效代表人仍 409）', async () => {
    const s = await mkDlgScene(true);
    const url = `/sysbuild/parties/${s.party}/delegations`;
    const mNa = await addNaMember(s.pid, s.party, '无账号甲');
    const r1 = await post(U.pm, url, { member_id: mNa });
    assert.strictEqual(r1.status, 201, r1.text);
    assert.deepStrictEqual(r1.body.delegation, { id: r1.body.delegation.id, party_id: s.party, member_id: mNa, appointment_id: s.apt, status: 'pending_owner' });
    assert.strictEqual((await post(U.pm, `/sysbuild/delegations/${r1.body.delegation.id}/withdraw`)).status, 200);
    const r2 = await post(U.own, url, { member_id: mNa });
    assert.strictEqual(r2.status, 201, r2.text);
    assert.strictEqual(r2.body.delegation.status, 'pending_accept', '负责人发起：直接待被授权人接受');
    // 无账号的被授权人本人没有入口：详情里 PM 看到代录标志为真，普通接受 / 拒绝端点对他人 404
    const detail = await get(U.pm, `/sysbuild/projects/${s.pid}`);
    const dEntry = detail.body.delegations.find((x) => x.id === r2.body.delegation.id);
    assert.strictEqual(dEntry.actions.proxy, true);
    assert.strictEqual(dEntry.name, '无账号甲');
    // 其余前置不变
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${r2.body.delegation.id}/withdraw`)).status, 200);
    const mGone = await addNaMember(s.pid, s.party, '无账号乙');
    assert.strictEqual((await post(U.pm, `/sysbuild/members/${mGone}/remove`, { reason: '离项' })).status, 200);
    expectErr(await post(U.pm, url, { member_id: mGone }), 409, 'SYSBUILD_STATE', '已移出');
    expectErr(await post(U.pm, url, { member_id: s.mOwn }), 409, 'SYSBUILD_STATE', '负责人本人');
  });

  test('C4b 代录：授权的校验——批准一步也核对被授权人资格（codex 21 号 G2）：pending_owner 提议的被授权成员被移出 / 被设为 PM 后，代录批准 409、标志为假、不产生任务 / 确认记录 / 附件绑定', async () => {
    const snapOf = async (pid) => JSON.stringify([
      await sqlAll('SELECT d.id, d.status FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id WHERE p.project_id = ? ORDER BY d.id', [pid]),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [pid]),
      await sqlAll('SELECT id FROM sysbuild_confirmations ORDER BY id'),
      await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
    ]);
    // 被授权成员已移出（夹具：直接写库，不走会级联撤回提议的移出端点，构造「提议仍待负责人确认、但被授权人已不是成员」）
    const a = await mkDlgScene(false);
    const mNa = await addNaMember(a.pid, a.party, '无账号代表人');
    const didA = await proposeDlg(a, mNa);
    await sqlRun("UPDATE sysbuild_members SET removed_at = '2026-10-22 10:00:00', removed_reason = '离项' WHERE id = ?", [mNa]);
    const bA = await snapOf(a.pid);
    const flagA = (await get(U.pm, `/sysbuild/projects/${a.pid}`)).body.delegations.find((x) => x.id === didA);
    assert.strictEqual(flagA.actions.proxy, false, '被授权人已移出：代录标志为假');
    const rA = await dlgProxy(U.pm, didA, await evid(a.pid));
    expectErr(rA, 409, 'SYSBUILD_STATE', '被授权人已移出');
    assert.ok(rA.body.message.includes('被授权人已不是本项目成员'), `提示实际 ${rA.body.message}`);
    assert.strictEqual(await snapOf(a.pid), bA, '被拒的批准代录不产生任务 / 确认记录 / 附件绑定，授权状态不变');
    // 被授权成员被设为 PM（夹具：写库把 PM 改成被授权人的账号；操作人就是这位 PM 本人）
    const b = await mkDlgScene(false);
    const mAcc = await addMember(b.pid, U.cand, { party: b.party });
    const didB = await proposeDlg(b, mAcc);
    await sqlRun('UPDATE sysbuild_projects SET pm_user_id = ? WHERE id = ?', [U.cand, b.pid]);
    const bB = await snapOf(b.pid);
    const flagB = (await get(U.cand, `/sysbuild/projects/${b.pid}`)).body.delegations.find((x) => x.id === didB);
    assert.strictEqual(flagB.actions.proxy, false, '被授权人被设为 PM：代录标志为假');
    const rB = await dlgProxy(U.cand, didB, await evid(b.pid));
    expectErr(rB, 409, 'SYSBUILD_STATE', '被授权人被设为 PM');
    assert.ok(rB.body.message.includes('PM 不得兼任'), `提示实际 ${rB.body.message}`);
    assert.strictEqual(await snapOf(b.pid), bB, '被拒的批准代录不产生任务 / 确认记录 / 附件绑定，授权状态不变');
  });

  test('C4b 代录：授权的校验——接受一步的外部日期下限 = 负责人批准日（codex 21 号 G3）：批准是代录的取那条 delegation_grant 记录的 external_date；平台批准取 delegation_approved 事件时间；本方负责人自己提议（无批准记录）取提议创建日', async () => {
    // ① 代录批准：批准日 = 代录记录的 external_date（2026-10-25）；接受日早于它 400，等于它通过
    const a = await mkDlgScene(false);
    const mNa = await addNaMember(a.pid, a.party, '无账号代表人');
    const didA = await proposeDlg(a, mNa);
    assert.strictEqual((await dlgProxy(U.pm, didA, await evid(a.pid, { external_date: '2026-10-25' }))).status, 200);
    const early = await dlgProxy(U.pm, didA, await evid(a.pid, { external_date: '2026-10-24' }), 'accept');
    expectErr(early, 400, 'SYSBUILD_INVALID_INPUT', '接受日早于代录批准日');
    assert.strictEqual(early.body.field, 'external_date');
    assert.ok(early.body.message.includes('2026-10-25'), `提示应指出下限日期，实际 ${early.body.message}`);
    assert.strictEqual((await rowOf('sysbuild_delegations', didA)).status, 'pending_accept', '被拒的接受不改状态');
    assert.strictEqual((await dlgProxy(U.pm, didA, await evid(a.pid, { external_date: '2026-10-25' }), 'accept')).status, 200, '等于批准日通过');
    // ② 平台批准：批准日 = delegation_approved 事件时间（回拨到 2026-10-22）
    const b = await mkDlgScene(true);
    const mNb = await addNaMember(b.pid, b.party, '无账号代表人');
    const didB = await proposeDlg(b, mNb);
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${didB}/approve`)).status, 200);
    await backdateApproval(didB, '2026-10-22 09:00:00');
    const earlyB = await dlgProxy(U.pm, didB, await evid(b.pid, { external_date: '2026-10-21' }), 'accept');
    expectErr(earlyB, 400, 'SYSBUILD_INVALID_INPUT', '接受日早于平台批准日');
    assert.ok(earlyB.body.message.includes('2026-10-22'), `提示实际 ${earlyB.body.message}`);
    assert.strictEqual((await dlgProxy(U.pm, didB, await evid(b.pid, { external_date: '2026-10-22' }), 'accept')).status, 200, '等于平台批准日通过');
    // ③ 本方负责人自己提议：直接待接受，没有批准记录 → 下限取提议创建日
    const c = await mkDlgScene(true);
    const mNc = await addNaMember(c.pid, c.party, '无账号代表人');
    const rc = await post(U.own, `/sysbuild/parties/${c.party}/delegations`, { member_id: mNc });
    assert.strictEqual(rc.status, 201, rc.text);
    assert.strictEqual(rc.body.delegation.status, 'pending_accept');
    await backdate('sysbuild_delegations', [rc.body.delegation.id]);
    expectErr(await dlgProxy(U.pm, rc.body.delegation.id, await evid(c.pid, { external_date: addDays(FLOOR, -1) }), 'accept'), 400, 'SYSBUILD_INVALID_INPUT', '无批准记录：早于提议创建日');
    assert.strictEqual((await dlgProxy(U.pm, rc.body.delegation.id, await evid(c.pid, { external_date: FLOOR }), 'accept')).status, 200, '无批准记录：等于提议创建日通过');
  });

  test('C4b 提出人改发（G1，codex 21 号 M1）：提出人不认可后（denied）不能改发，出路是条目新版本——actions.reissue 为假、改发 409 且文案指向「出新版本」、状态不变；有异议（提出人状态仍 pending）后可改发', async () => {
    const pid = await newProject();
    const party = await addParty(pid, '甲部', 'demand');
    const mNa = await addNaMember(pid, party, '无账号提出人');
    const reissue = (tid) => post(U.pm, `/sysbuild/confirm-tasks/${tid}/reissue`, { reason: '想改发' });
    // 不认可 → denied
    const d = await mkProposerTask(pid, mNa);
    assert.strictEqual((await post(U.pm, proxyUrl(d.tid), await proposerBody(pid, d, 'reject', { reason: '这不是他提的需求' }))).status, 200);
    assert.strictEqual((await itemStatus(d.ivid)).proposer_status, 'denied');
    const before = JSON.stringify([await sqlAll('SELECT id, status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [d.tid]), await itemStatus(d.ivid)]);
    assert.strictEqual((await openTask(U.pm, d.tid)).body.actions.reissue, false, 'denied 后改发标志为假');
    const r = await reissue(d.tid);
    expectErr(r, 409, 'SYSBUILD_STATE', 'denied 后改发');
    assert.strictEqual(r.body.message, '提出人已不认可，请对条目出新版本');
    assert.strictEqual(JSON.stringify([await sqlAll('SELECT id, status FROM sysbuild_confirm_task_revisions WHERE task_id = ?', [d.tid]), await itemStatus(d.ivid)]), before, '被拒的改发不改任何状态（不新增 denied → pending 的写法）');
    // 出路：条目出新版本 → 新版本生成新任务
    const v2 = await post(U.pm, `/sysbuild/items/${d.item.id}/versions`, { content: '补正后的需求', no_written_evidence: true, no_evidence_reason: '口头电话确认了本次需求内容' });
    assert.strictEqual(v2.status, 201, v2.text);
    assert.strictEqual(await countOf("SELECT COUNT(*) AS n FROM sysbuild_confirm_tasks WHERE object_type = 'item_version' AND object_version_id = ?", [v2.body.item_version_id]), 1);
    // 有异议 → 提出人状态仍 pending，可改发
    const o = await mkProposerTask(pid, mNa);
    assert.strictEqual((await post(U.pm, proxyUrl(o.tid), await proposerBody(pid, o, 'object', { reason: '原话要点不准' }))).status, 200);
    assert.strictEqual((await itemStatus(o.ivid)).proposer_status, 'pending');
    assert.strictEqual((await openTask(U.pm, o.tid)).body.actions.reissue, true, 'objected 后改发标志为真');
    const ro = await reissue(o.tid);
    assert.strictEqual(ro.status, 200, ro.text);
    assert.strictEqual(ro.body.revision.rev_no, 2);
  });

  // ── 7b 账号停用（进程内专属）──────────────────────────────────────────────────────────────────
  // 真实实例的鉴权中间件会先拦下停用账号，users.status 只能在进程内夹具里改（登记残余，照 C4a 写法）：实例模式返回 SKIP，汇总行另计跳过。
  test('C4b 账号停用（进程内）：停用账号的成员仍视为缺人——提出人账号停用时改发 409 且标志为假；任职 / 授权代录遇账号停用给专门文案（「账号已停用，不能作为确认人」），区别于「有平台账号请本人处理」；账号恢复后回到各自的原文案', async () => {
    if (!(T.getFixedToday && T.getFixedToday())) return T.SKIP;
    const setUser = (uid, st) => sqlRun('UPDATE users SET status = ? WHERE id = ?', [st, uid]);
    // 提出人（有账号）账号停用：不能改发，也不能代录；恢复后可改发
    const pid3 = await newProject();
    const m2 = await addMember(pid3, U.m2);
    const x = await mkProposerTask(pid3, m2);
    const reissue = (uid, tid, reason) => post(uid, `/sysbuild/confirm-tasks/${tid}/reissue`, { reason });
    await setUser(U.m2, 'inactive');
    try {
      expectErr(await reissue(U.pm, x.tid, '改发'), 409, 'SYSBUILD_STATE', '提出人账号停用');
      const fl = (await openTask(U.pm, x.tid)).body.actions;
      assert.deepStrictEqual([fl.reissue, fl.proxy], [false, false]);
      expectErr(await post(U.pm, proxyUrl(x.tid), await proposerBody(pid3, x, 'confirm')), 409, 'SYSBUILD_STATE', '提出人账号停用不能代录');
    } finally { await setUser(U.m2, 'active'); }
    assert.strictEqual((await reissue(U.pm, x.tid, '账号恢复后改发')).status, 200);
    // 任职接受：有账号成员的账号停用 → 专门文案；恢复后回到「有平台账号」文案
    const s = await mkApptScene(false);
    const mAcc = await addMember(s.pid, U.cand, { party: s.party });
    assert.strictEqual((await post(U.pm, `/sysbuild/appointments/${s.apt}/withdraw`)).status, 200);
    const ra = await post(U.pm, `/sysbuild/parties/${s.party}/appointments`, { member_id: mAcc });
    assert.strictEqual(ra.status, 201, ra.text);
    await backdate('sysbuild_appointments', [ra.body.appointment.id]);
    await setUser(U.cand, 'inactive');
    try {
      const r = await apptProxy(U.pm, ra.body.appointment.id, await evid(s.pid));
      expectErr(r, 409, 'SYSBUILD_STATE', '任职：账号停用');
      assert.ok(r.body.message.includes('账号已停用') && !r.body.message.includes('有平台账号'), `提示实际 ${r.body.message}`);
      assert.strictEqual((await get(U.pm, `/sysbuild/projects/${s.pid}`)).body.appointments.find((y) => y.id === ra.body.appointment.id).actions.proxy_accept, false);
    } finally { await setUser(U.cand, 'active'); }
    const r2 = await apptProxy(U.pm, ra.body.appointment.id, await evid(s.pid));
    expectErr(r2, 409, 'SYSBUILD_STATE', '任职：账号正常的有账号成员');
    assert.ok(r2.body.message.includes('有平台账号'), `提示实际 ${r2.body.message}`);
    // 授权：批准一步负责人账号停用 / 接受一步被授权人账号停用
    const b = await mkDlgScene(true);
    const mAcc2 = await addMember(b.pid, U.del, { party: b.party });
    const didB = await proposeDlg(b, mAcc2);
    await setUser(U.own, 'inactive');
    try {
      const r = await dlgProxy(U.pm, didB, await evid(b.pid));
      expectErr(r, 409, 'SYSBUILD_STATE', '授权批准：负责人账号停用');
      assert.ok(r.body.message.includes('账号已停用') && r.body.message.includes('负责人'), `提示实际 ${r.body.message}`);
    } finally { await setUser(U.own, 'active'); }
    assert.ok((await dlgProxy(U.pm, didB, await evid(b.pid))).body.message.includes('有平台账号'), '负责人账号恢复：回到「有平台账号请本人批准」');
    assert.strictEqual((await post(U.own, `/sysbuild/delegations/${didB}/approve`)).status, 200);
    await setUser(U.del, 'inactive');
    try {
      const r = await dlgProxy(U.pm, didB, await evid(b.pid), 'accept');
      expectErr(r, 409, 'SYSBUILD_STATE', '授权接受：被授权人账号停用');
      assert.ok(r.body.message.includes('账号已停用') && r.body.message.includes('被授权人'), `提示实际 ${r.body.message}`);
    } finally { await setUser(U.del, 'active'); }
    assert.ok((await dlgProxy(U.pm, didB, await evid(b.pid), 'accept')).body.message.includes('有平台账号'), '被授权人账号恢复：回到「有平台账号请本人接受」');
  });

  // ── 8 动作标志 ⇔ 执行 ─────────────────────────────────────────────────────────────────────────
  test('C4b actions 与执行一致：confirm_proxy / appointment_proxy_accept / delegation_proxy 三个动作的读接口标志为真 ⇔ 真实调用成功，为假 ⇔ 被拒（403 / 404 / 409）且状态不变——PM / 非 PM 成员 / admin 非 PM，进行中 / 已终止，有账号 / 无账号', async () => {
    const s = await mkNaScene({ ownerUid: U.own });
    await addMember(s.pid, U.m1);
    const [tOwn, tDel] = s.tasks; // tOwn：有账号的负责人（可代录）；tDel：无账号代表人
    const flagOf = async (uid, tid) => (await openTask(uid, tid)).body.actions.proxy;
    assert.strictEqual(await flagOf(U.pm, tOwn.task_id), true);
    for (const uid of [U.m1, U.admin, U.own]) assert.strictEqual(await flagOf(uid, tOwn.task_id) === true, false, `uid ${uid} 的代录标志`);
    // 标志为假的执行必被拒且不改状态
    const snap0 = await taskSnap(tOwn.task_id);
    for (const uid of [U.m1, U.admin, U.own]) {
      const r = await post(uid, proxyUrl(tOwn.task_id), await bodyOf(s.pid, tOwn, 'confirm'));
      assert.ok([403, 404].includes(r.status), `uid ${uid} 标志为假但执行 ${r.status} ${r.text.slice(0, 120)}`);
    }
    assert.strictEqual(await taskSnap(tOwn.task_id), snap0);
    // 标志为真的执行成功；成功后标志变假（修订已确认）
    const ok = await post(U.pm, proxyUrl(tOwn.task_id), await bodyOf(s.pid, tOwn, 'confirm'));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(await flagOf(U.pm, tOwn.task_id), false);
    const noMore = await post(U.pm, proxyUrl(tOwn.task_id), await bodyOf(s.pid, tOwn, 'confirm'));
    assert.strictEqual(noMore.status, 409);
    // 已终止：标志为假，执行 409
    assert.strictEqual((await setStatus(s.pid, 'terminated')).status, 200);
    assert.strictEqual(await flagOf(U.pm, tDel.task_id), false, '已终止：代录标志为假');
    expectErr(await post(U.pm, proxyUrl(tDel.task_id), await bodyOf(s.pid, tDel, 'confirm')), 409, 'SYSBUILD_PROJECT_READONLY', '已终止');
    // 任职 / 授权标志（项目详情逐对象 actions）
    const a = await mkDlgScene(false);
    const mNaDel = await addNaMember(a.pid, a.party, '无账号代表人');
    const did = await proposeDlg(a, mNaDel);
    const detail = async (uid) => (await get(uid, `/sysbuild/projects/${a.pid}`)).body;
    const dPm = await detail(U.pm);
    assert.deepStrictEqual(dPm.delegations.filter((x) => x.id === did).map((x) => x.actions.proxy), [true], 'PM：无账号负责人待批准 → 代录标志为真');
    assert.ok(dPm.appointments.every((x) => x.actions.proxy_accept === false), '负责人任职已生效：任职接受代录标志为假');
    // 待接受的无账号任职：另一个参与方
    const party2 = await addParty(a.pid, '乙部', 'demand');
    const mNaB = await addNaMember(a.pid, party2, '无账号乙');
    const ra = await post(U.pm, `/sysbuild/parties/${party2}/appointments`, { member_id: mNaB });
    assert.strictEqual(ra.status, 201, ra.text);
    await backdate('sysbuild_appointments', [ra.body.appointment.id]);
    const d2 = await detail(U.pm);
    const apt2 = d2.appointments.find((x) => x.id === ra.body.appointment.id);
    assert.strictEqual(apt2.actions.proxy_accept, true);
    // 非 PM 成员 / admin：标志为假，执行被拒
    await addMember(a.pid, U.m1);
    const projSnap = async () => JSON.stringify([
      await sqlAll('SELECT a.id, a.status FROM sysbuild_appointments a JOIN sysbuild_parties p ON p.id = a.party_id WHERE p.project_id = ? ORDER BY a.id', [a.pid]),
      await sqlAll('SELECT d.id, d.status FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id WHERE p.project_id = ? ORDER BY d.id', [a.pid]),
      await sqlAll('SELECT id, status FROM sysbuild_invitations WHERE project_id = ? ORDER BY id', [a.pid]),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [a.pid]),
      await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
    ]);
    const negBefore = await projSnap();
    for (const uid of [U.m1, U.admin]) {
      const dd = await detail(uid);
      const apt = dd.appointments.find((x) => x.id === ra.body.appointment.id);
      const dlg = dd.delegations.find((x) => x.id === did);
      if (uid === U.admin) {
        // admin（管理者，非 PM）能看到对象，代录标志为假
        assert.ok(apt && dlg, 'admin 应能看到待接受的任职与待处理的授权');
        assert.strictEqual(apt.actions.proxy_accept, false, 'admin 的任职代录标志');
        assert.strictEqual(dlg.actions.proxy, false, 'admin 的授权代录标志');
      } else {
        // 一般成员看不到别人的待接受任职 / 待处理授权（可见性规则）：显式断言不可见，而不是静默跳过
        assert.strictEqual(apt, undefined, '一般成员看不到别人的待接受任职');
        assert.strictEqual(dlg, undefined, '一般成员看不到他方的待处理授权');
      }
      for (const x of dd.delegations) assert.strictEqual(x.actions.proxy, false, `uid ${uid} 的授权代录标志`);
      for (const x of dd.appointments) assert.strictEqual(x.actions.proxy_accept, false, `uid ${uid} 的任职代录标志`);
      const r1 = await apptProxy(uid, ra.body.appointment.id, await evid(a.pid));
      assert.ok([403, 404].includes(r1.status), `uid ${uid} 任职标志为假但执行 ${r1.status}`);
      const r2 = await dlgProxy(uid, did, await evid(a.pid));
      assert.ok([403, 404].includes(r2.status), `uid ${uid} 授权标志为假但执行 ${r2.status}`);
    }
    assert.strictEqual(await projSnap(), negBefore, '标志为假的执行被拒后，任职 / 授权 / 邀请 / 任务 / 凭据绑定都不变');
    // 标志为真的执行成功，成功后标志变假
    assert.strictEqual((await apptProxy(U.pm, ra.body.appointment.id, await evid(a.pid))).status, 200);
    assert.strictEqual((await dlgProxy(U.pm, did, await evid(a.pid))).status, 200);
    const d3 = await detail(U.pm);
    assert.strictEqual(d3.appointments.find((x) => x.id === ra.body.appointment.id).actions.proxy_accept, false);
    assert.strictEqual(d3.delegations.find((x) => x.id === did).actions.proxy, true, '批准后进入待接受：被授权人无账号 → 代录标志仍为真（接受一步）');
    assert.strictEqual((await dlgProxy(U.pm, did, await evid(a.pid), 'accept')).status, 200);
    assert.strictEqual((await detail(U.pm)).delegations.find((x) => x.id === did).actions.proxy, false);
    // 有账号的一方：标志为假且执行 409
    const b = await mkDlgScene(true);
    const mAcc = await addMember(b.pid, U.del, { party: b.party });
    const didB = await proposeDlg(b, mAcc);
    const dB = (await get(U.pm, `/sysbuild/projects/${b.pid}`)).body.delegations.find((x) => x.id === didB);
    assert.strictEqual(dB.actions.proxy, false, '负责人有账号：批准一步的代录标志为假');
    const bSnap = async () => JSON.stringify([
      await sqlAll('SELECT d.id, d.status FROM sysbuild_delegations d JOIN sysbuild_parties p ON p.id = d.party_id WHERE p.project_id = ? ORDER BY d.id', [b.pid]),
      await sqlAll('SELECT id FROM sysbuild_confirm_tasks WHERE project_id = ? ORDER BY id', [b.pid]),
      await sqlAll("SELECT id FROM sysbuild_attachment_bindings WHERE owner_type = 'confirmation' ORDER BY id"),
    ]);
    const bBefore = await bSnap();
    expectErr(await dlgProxy(U.pm, didB, await evid(b.pid)), 409, 'SYSBUILD_STATE', '标志为假执行 409');
    assert.strictEqual(await bSnap(), bBefore, '有账号的一方被拒：授权 / 任务 / 凭据绑定不变');
  });

  // ── 9 P36：无账号同一人 ───────────────────────────────────────────────────────────────────────
  test('C4b P36（无账号同一人）：同一参与方的另一类任务已由某无账号成员确认，改发后新负责人恰是该成员 → 改发 409 且标志为假（同一人 = 同一 member_id）；换另一个无账号成员可改发', async () => {
    const s = await mkNaScene();
    const [tOwn, tDel] = s.tasks;
    // 代表人（无账号）先被代录确认
    assert.strictEqual((await post(U.pm, proxyUrl(tDel.task_id), await bodyOf(s.pid, tDel, 'confirm'))).status, 200);
    // 负责人更换成「同一个无账号成员」：夹具——结束现任任职，给代表人成员另建一条现任任职
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-21 10:00:00', end_reason = '换人' WHERE id = ?", [s.apt]);
    await addAppointment(s.party, s.mDel, 'active');
    const flag = (await openTask(U.pm, tOwn.task_id)).body.actions.reissue;
    assert.strictEqual(flag, false, '新负责人 = 已确认的代表人（同一个无账号成员）：改发标志为假');
    const rr = await post(U.pm, `/sysbuild/confirm-tasks/${tOwn.task_id}/reissue`, { reason: '换人' });
    expectErr(rr, 409, 'SYSBUILD_STATE', '同一无账号成员兼负责人与代表人');
    assert.ok(rr.body.message.includes('同一人'), `提示实际 ${rr.body.message}`);
    // 换成另一个无账号成员：可改发（user_id 都为空，不能按 user_id 判同一人）
    const mOther = await addNaMember(s.pid, s.party, '另一个无账号负责人');
    await sqlRun("UPDATE sysbuild_appointments SET status = 'ended', ended_at = '2026-10-22 10:00:00', end_reason = '再换人' WHERE party_id = ? AND status = 'active'", [s.party]);
    await addAppointment(s.party, mOther, 'active');
    assert.strictEqual((await openTask(U.pm, tOwn.task_id)).body.actions.reissue, true);
    const ok = await post(U.pm, `/sysbuild/confirm-tasks/${tOwn.task_id}/reissue`, { reason: '换人' });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.deepStrictEqual([ok.body.revision.required_member_id, ok.body.revision.proxy_only], [mOther, true]);
  });

  // ── 10 rules 手写矩阵 ────────────────────────────────────────────────────────────────────────
  test('C4b 代录：PM 不能代录自己（预筛 D3 / P60）——必需确认人就是 PM 本人（提出人是 PM 自己的条目）→ 代录 409「本人请在平台确认」、标志为假、不改任何状态；本人仍可在平台确认；PM 代录别人的任务不受影响', async () => {
    const pid = await newProject();
    const pmMember = (await sqlGet('SELECT id FROM sysbuild_members WHERE project_id = ? AND user_id = ? AND removed_at IS NULL', [pid, U.pm])).id;
    const own = await mkProposerTask(pid, pmMember);
    const snap0 = await taskSnap(own.tid);
    const r = await post(U.pm, proxyUrl(own.tid), await proposerBody(pid, own, 'confirm'));
    expectErr(r, 409, 'SYSBUILD_STATE', 'PM 代录自己');
    assert.ok(r.body.message.includes('本人请在平台确认'), `提示实际 ${r.body.message}`);
    assert.strictEqual(await taskSnap(own.tid), snap0, '被拒的代录不改任何状态');
    const d = await openTask(U.pm, own.tid);
    assert.deepStrictEqual([d.body.actions.proxy, d.body.actions.decide], [false, true], 'PM 是必需确认人：代录标志为假，本人 decide 标志为真');
    // 别人的任务照常可被 PM 代录
    const m1 = await addMember(pid, U.m1);
    const other = await mkProposerTask(pid, m1);
    assert.strictEqual((await openTask(U.pm, other.tid)).body.actions.proxy, true);
    assert.strictEqual((await post(U.pm, proxyUrl(other.tid), await proposerBody(pid, other, 'confirm'))).status, 200);
    // 本人在平台确认
    const dec = await openAndDecide(U.pm, own.tid, 'confirm');
    assert.strictEqual(dec.status, 200, dec.text);
    assert.strictEqual((await itemStatus(own.ivid)).proposer_status, 'confirmed');
  });

  test('C4b rules：三个代录动作——PM 专属（admin 非 PM / 只读 PM / 一般成员 / 无项目身份都否），项目状态类别手写（confirm_proxy = accept 行；任职 / 授权代录 = membership 行），对象状态与错误码，事件类型已登记', async () => {
    const R = T.getMods().rules;
    const pm = { isPm: true, isReadonly: false };
    // 注：「必需确认人本人」不是身份层概念（identity 里没有对应字段），其拒绝由 target.requiredIsSelf 表达（预筛 D3，见下）；这里只列身份层的否定情形。
    const nots = [[{ isAdmin: true, isPm: false, isReadonly: false }, 'admin 非 PM'], [{ isMember: true, isPm: false, isReadonly: false }, '一般成员'], [{ isPm: false, isReadonly: false }, '非 PM、无任何项目身份'], [{ isPm: true, isReadonly: true }, '只读 PM']];
    const acceptRow = { active: true, paused: true, terminated: false, closed: false };
    const membershipRow = { active: true, paused: true, terminated: false, closed: true };
    const cOk = { proxyable: true, currentRevisionId: 7, revisionStatus: 'pending', objectVersionId: 9, objectPending: true, requiredIsSelf: false, qualificationLoss: null, historyConflict: null };
    // C4b Q-S2：三类目标都带 historyConflict（P58 历史互斥事实；null = 无冲突，缺失 fail-closed）
    const aOk = { status: 'pending', memberActive: true, hasAccount: false, accountDisabled: false, historyConflict: null };
    const dOwnerOk = { status: 'pending_owner', appointmentIsCurrent: true, requalReason: null, ownerHasAccount: false, ownerAccountDisabled: false, memberHasAccount: true, memberAccountDisabled: false, historyConflict: null };
    const dAcceptOk = { status: 'pending_accept', appointmentIsCurrent: true, requalReason: null, ownerHasAccount: true, ownerAccountDisabled: false, memberHasAccount: false, memberAccountDisabled: false, historyConflict: null };
    const cases = [['confirm_proxy', cOk, acceptRow], ['appointment_proxy_accept', aOk, membershipRow], ['delegation_proxy', dOwnerOk, membershipRow], ['delegation_proxy', dAcceptOk, membershipRow]];
    for (const [op, tgt, row] of cases) {
      for (const [st, ok] of Object.entries(row)) assert.strictEqual(R.opAllowed(op, pm, { status: st }, tgt), ok, `${op} × ${st}`);
      for (const [who, label] of nots) assert.strictEqual(R.opAllowed(op, who, { status: 'active' }, tgt), false, `${op}：${label}`);
      assert.strictEqual(R.checkOp(op, { isPm: true, isReadonly: false }, { status: 'terminated' }, tgt).code, 'SYSBUILD_PROJECT_READONLY', `${op} 已终止的错误码`);
      assert.strictEqual(R.checkOp(op, { isMember: true }, { status: 'active' }, tgt).code, 'SYSBUILD_FORBIDDEN', `${op} 非 PM 的错误码`);
    }
    assert.deepStrictEqual([R.OP_KIND.confirm_proxy, R.OP_KIND.appointment_proxy_accept, R.OP_KIND.delegation_proxy], ['accept', 'membership', 'membership']);
    const chk = (op, t, st) => R.checkOp(op, pm, { status: st || 'active' }, t);
    // confirm_proxy 对象状态
    const cv = (t) => chk('confirm_proxy', Object.assign({}, cOk, t));
    assert.deepStrictEqual([cv({ proxyable: false }).code, cv({ proxyable: false }).message], ['SYSBUILD_STATE', '该类型的确认任务不能代录']);
    assert.strictEqual(cv({ revisionIdGiven: 8 }).code, 'SYSBUILD_TASK_SUPERSEDED');
    assert.strictEqual(cv({ objectVersionIdGiven: 10 }).code, 'SYSBUILD_VERSION_CHANGED');
    assert.strictEqual(cv({ revisionIdGiven: 7, objectVersionIdGiven: 9 }), null, '带的编号与现状一致放行');
    for (const rs of ['confirmed', 'objected', 'rejected', 'invalid', 'superseded']) assert.strictEqual(cv({ revisionStatus: rs }).code, 'SYSBUILD_STATE', `修订 ${rs} 不可代录`);
    assert.strictEqual(cv({ objectPending: false }).code, 'SYSBUILD_VERSION_CHANGED');
    assert.deepStrictEqual([cv({ qualificationLoss: '失去资格' }).status, cv({ qualificationLoss: '失去资格' }).message], [409, '失去资格']);
    assert.deepStrictEqual([cv({ historyConflict: '历史补录窗口冲突' }).status, cv({ historyConflict: '历史补录窗口冲突' }).message], [409, '历史补录窗口冲突'], 'Q-S2 挂点：冲突文案原样 409');
    // appointment_proxy_accept
    const av = (t) => chk('appointment_proxy_accept', Object.assign({}, aOk, t));
    for (const st of ['active', 'rejected', 'ended', 'withdrawn']) assert.strictEqual(av({ status: st }).code, 'SYSBUILD_STATE', `任职 ${st}`);
    assert.strictEqual(av({ memberActive: false }).code, 'SYSBUILD_STATE');
    assert.ok(av({ hasAccount: true }).message.includes('平台账号'));
    // delegation_proxy
    const dv = (base, t) => chk('delegation_proxy', Object.assign({}, base, t));
    assert.ok(dv(dOwnerOk, { ownerHasAccount: true }).message.includes('负责人'));
    assert.strictEqual(dv(dOwnerOk, { memberHasAccount: true }), null, '批准一步不看被授权人是否有账号');
    assert.strictEqual(dv(dOwnerOk, { appointmentIsCurrent: false }).code, 'SYSBUILD_STATE');
    assert.ok(dv(dAcceptOk, { memberHasAccount: true }).message.includes('被授权人'));
    assert.strictEqual(dv(dAcceptOk, { ownerHasAccount: false }), null, '接受一步不看负责人是否有账号');
    assert.strictEqual(dv(dAcceptOk, { requalReason: '被授权人已不是本项目成员，该授权提议已失效' }).message, '被授权人已不是本项目成员，该授权提议已失效');
    for (const st of ['active', 'rejected', 'revoked', 'withdrawn']) assert.strictEqual(dv(dAcceptOk, { status: st }).code, 'SYSBUILD_STATE', `授权 ${st}`);
    // 预筛 D3 / P60：必需确认人就是操作人本人 → 409「本人请在平台确认」（读接口标志同源）
    const self = cv({ requiredIsSelf: true });
    assert.deepStrictEqual([self.status, self.code, self.message], [409, 'SYSBUILD_STATE', '本人请在平台确认，不能由项目经理代录自己的确认']);
    assert.strictEqual(R.opAllowed('confirm_proxy', pm, { status: 'active' }, Object.assign({}, cOk, { requiredIsSelf: true })), false);
    // 预筛 L6 fail-closed：前置事实没取到（undefined）一律拒绝，不当作「通过」
    const drop = (base, k) => { const o = Object.assign({}, base); delete o[k]; return o; };
    for (const k of ['proxyable', 'objectPending', 'requiredIsSelf', 'qualificationLoss', 'historyConflict']) {
      assert.strictEqual(R.opAllowed('confirm_proxy', pm, { status: 'active' }, drop(cOk, k)), false, `confirm_proxy 缺事实 ${k} 应拒绝`);
    }
    for (const k of ['memberActive', 'hasAccount']) assert.strictEqual(R.opAllowed('appointment_proxy_accept', pm, { status: 'active' }, drop(aOk, k)), false, `appointment_proxy_accept 缺事实 ${k} 应拒绝`);
    assert.strictEqual(R.opAllowed('delegation_proxy', pm, { status: 'active' }, drop(dOwnerOk, 'ownerHasAccount')), false, 'delegation_proxy 批准一步缺 ownerHasAccount 应拒绝');
    assert.strictEqual(R.opAllowed('delegation_proxy', pm, { status: 'active' }, drop(dOwnerOk, 'appointmentIsCurrent')), false, 'delegation_proxy 批准一步缺 appointmentIsCurrent 应拒绝');
    assert.strictEqual(R.opAllowed('delegation_proxy', pm, { status: 'active' }, drop(dAcceptOk, 'memberHasAccount')), false, 'delegation_proxy 接受一步缺 memberHasAccount 应拒绝');
    assert.strictEqual(R.opAllowed('delegation_proxy', pm, { status: 'active' }, drop(dAcceptOk, 'requalReason')), false, 'delegation_proxy 接受一步缺 requalReason 应拒绝');
    // 预筛 L10：账号停用另给文案（区别于「有平台账号请本人处理」）
    assert.strictEqual(av({ hasAccount: true, accountDisabled: true }).message, '该成员账号已停用，不能作为确认人');
    assert.strictEqual(av({ hasAccount: true, accountDisabled: false }).message, '该成员有平台账号，请由本人通过邀请接受任职');
    assert.strictEqual(dv(dOwnerOk, { ownerHasAccount: true, ownerAccountDisabled: true }).message, '现任负责人账号已停用，不能作为确认人');
    assert.strictEqual(dv(dOwnerOk, { ownerHasAccount: true, ownerAccountDisabled: false }).message, '现任负责人有平台账号，请由负责人本人批准');
    assert.strictEqual(dv(dAcceptOk, { memberHasAccount: true, memberAccountDisabled: true }).message, '被授权人账号已停用，不能作为确认人');
    assert.strictEqual(dv(dAcceptOk, { memberHasAccount: true, memberAccountDisabled: false }).message, '被授权人有平台账号，请由本人接受授权');
    // codex 21 号 G2：批准一步也核对 requalReason（非 null 拒绝并原样给出，undefined 拒绝）
    assert.strictEqual(dv(dOwnerOk, { requalReason: '被授权人已不是本项目成员，该授权提议已失效' }).message, '被授权人已不是本项目成员，该授权提议已失效');
    assert.strictEqual(R.opAllowed('delegation_proxy', pm, { status: 'active' }, drop(dOwnerOk, 'requalReason')), false, 'delegation_proxy 批准一步缺 requalReason 应拒绝');
    // codex 21 号 G1：提出人任务被不认可（denied）后改发的文案与对象类型限定
    const rd = R.checkOp('confirm_reissue', pm, { status: 'active' }, { objectType: 'item_version', objectStatus: 'denied', revisionStatus: 'rejected', reissueBlocked: null, historyConflict: null });
    assert.deepStrictEqual([rd.status, rd.code, rd.message], [409, 'SYSBUILD_STATE', '提出人已不认可，请对条目出新版本']);
    assert.strictEqual(R.opAllowed('confirm_reissue', pm, { status: 'active' }, { objectType: 'item_version', objectStatus: 'pending', revisionStatus: 'objected', reissueBlocked: null, historyConflict: null }), true, '有异议（提出人状态仍 pending）可改发');
    // 事件类型登记（手写全集）
    const types = require(require('path').join(T.getModuleDir(), 'events.js')).EVENT_TYPES;
    for (const t of ['confirm_proxy_recorded', 'appointment_proxy_accepted', 'delegation_proxy_granted', 'delegation_proxy_accepted']) assert.ok(types.includes(t), `事件类型 ${t} 已登记`);
  });
}

// ── 变异（由 sysbuild-api-suite.js 登记到 MUTATIONS 末尾）：每条登记 expect；锚点在被测副本里恰好出现一次 ─────────────────────────────────────────
const PROXY_MUTATIONS = [
  // ── 去重键 / 同人判定（P44）──
  { id: 'C4b 去重键：无账号成员按 user_id 去重（两个无账号成员撞 null）', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: 'const k = `${r.party_id}:${r.user_id !== null ? r.user_id : `m:${r.member_id}`}`;', to: 'const k = `${r.party_id}:${r.user_id}`;' }] },
  { id: 'C4b P36：无账号同一人不判冲突（只看 user_id）', expect: ['C4b P36'], edits: [{ file: 'confirm-core.js', from: 'return rows.some((r) => (me.user_id !== null ? r.user_id === me.user_id : r.member_id === memberId));', to: 'return rows.some((r) => me.user_id !== null && r.user_id === me.user_id);' }] },
  { id: 'C4b P36：任何无账号成员互相算同一人（null === null）', expect: ['C4b P36'], edits: [{ file: 'confirm-core.js', from: 'return rows.some((r) => (me.user_id !== null ? r.user_id === me.user_id : r.member_id === memberId));', to: 'return rows.some((r) => r.user_id === me.user_id);' }] },
  // ── 外部日期两侧边界 ──
  { id: 'C4b 代录：外部日期不核对上限（可晚于今天）', expect: ['C4b 代录：校验顺序', 'C4b 代录：任职接受的校验', 'C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'if (externalDate > today) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C4b 代录：外部日期上限含今天被拒（> 写成 >=）', expect: ['C4b 代录：校验顺序', 'C4b 代录：任职接受的校验', 'C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'if (externalDate > today) throw invalid(', to: 'if (externalDate >= today) throw invalid(' }] },
  { id: 'C4b 代录：外部日期不核对下限（可早于创建日）', expect: ['C4b 代录：校验顺序', 'C4b 代录：任职接受的校验', 'C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'if (externalDate < floor) throw invalid(', to: 'if (false) throw invalid(' }] },
  { id: 'C4b 代录：外部日期下限含创建日被拒（< 写成 <=）', expect: ['C4b 代录：校验顺序', 'C4b 代录：任职接受的校验', 'C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'if (externalDate < floor) throw invalid(', to: 'if (externalDate <= floor) throw invalid(' }] },
  { id: 'C4b 代录：确认任务代录不核对外部日期范围', expect: ['C4b 代录：校验顺序'], edits: [{ file: 'confirm.js', from: "core.assertProxyDate(evidence.externalDate, c.latest.created_at, today(), '本修订的创建日期');", to: '' }] },
  { id: 'C4b 代录：任职接受代录不核对外部日期范围', expect: ['C4b 代录：任职接受的校验'], edits: [{ file: 'membership.js', from: "confirmCore.assertProxyDate(evidence.externalDate, a.created_at, today(), '任职提议的创建日期');", to: '' }] },
  { id: 'C4b 代录：授权代录不核对外部日期范围', expect: ['C4b 代录：授权的校验'], edits: [{ file: 'membership.js', from: "confirmCore.assertProxyDate(evidence.externalDate, grant ? d.created_at : await delegationApprovalFloor(q, d), today(), grant ? '授权提议的创建日期' : '负责人批准日');", to: '' }] },
  // ── 附件必填 / 凭据落库 ──
  { id: 'C4b 代录：附件不必填', expect: ['C4b 代录：校验顺序', 'C4b 代录：任职接受的校验', 'C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'if (!Array.isArray(raw) || raw.length === 0) throw invalid(', to: 'if (!Array.isArray(raw)) throw invalid(' }] },
  { id: 'C4b 代录：凭据附件绑定到别的所属类型', expect: ['C4b 代录：无账号', 'C4b 代录：任职——'], edits: [{ file: 'confirm-core.js', from: "ownerType: 'confirmation', ownerId: ins.lastID", to: "ownerType: 'event', ownerId: ins.lastID" }] },
  { id: 'C4b 代录：不写 confirm_proxy_recorded 事件', expect: ['C4b 代录：无账号', 'C4b 代录：任职——'], edits: [{ file: 'confirm-core.js', from: "await emit(q, user, o.projectId, 'confirm_task', o.taskId, 'confirm_proxy_recorded', {", to: "if (false) await emit(q, user, o.projectId, 'confirm_task', o.taskId, 'confirm_proxy_recorded', {" }] },
  { id: 'C4b 代录：确认记录 actor_user_id 记成操作的 PM', expect: ['C4b 代录：无账号', 'C4b 代录：混合'], edits: [{ file: 'confirm.js', from: 'actorUserId: c.requiredUserId, decision, reason, evidence,', to: 'actorUserId: Number(user.id), decision, reason, evidence,' }] },
  // ── 修订条件更新（规则层与条件更新两层同时去掉才可观察）──
  { id: 'C4b 代录：修订状态判定（规则层）与条件更新的旧状态条件同时去掉', expect: ['C4b 代录：无账号', 'C4b actions 与执行一致'], edits: [
    { file: 'rules.js', from: "if (t.revisionStatus !== 'pending') return '该任务修订已处理，不能再代录';", to: '' },
    { file: 'confirm-core.js', from: "WHERE id = ? AND status = 'pending'\",\n    [toStatus, revisionId]", to: "WHERE id = ?\",\n    [toStatus, revisionId]" },
  ] },
  // ── PM 检查 ──
  { id: 'C4b 代录：一般成员也能代录确认任务', expect: ['C4b 代录：校验顺序', 'C4b rules'], edits: [{ file: 'rules.js', from: 'confirm_proxy: Object.freeze({\n    can: canActAsPm,', to: 'confirm_proxy: Object.freeze({\n    can: canRegisterItem,' }] },
  { id: 'C4b 代录：admin 非 PM 也能代录确认任务', expect: ['C4b 代录：校验顺序', 'C4b rules'], edits: [{ file: 'rules.js', from: 'confirm_proxy: Object.freeze({\n    can: canActAsPm,', to: 'confirm_proxy: Object.freeze({\n    can: (identity) => canActAsPm(identity) || identity.isAdmin === true,' }] },
  { id: 'C4b 代录：一般成员也能代录任职接受', expect: ['C4b 代录：任职接受的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'appointment_proxy_accept: Object.freeze({\n    can: canActAsPm,', to: 'appointment_proxy_accept: Object.freeze({\n    can: canRegisterItem,' }] },
  { id: 'C4b 代录：一般成员也能代录授权', expect: ['C4b 代录：授权的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'delegation_proxy: Object.freeze({\n    can: canActAsPm,', to: 'delegation_proxy: Object.freeze({\n    can: canRegisterItem,' }] },
  // ── 项目状态类别 ──
  { id: 'C4b 代录：确认任务代录的项目状态类别改成 resolve（已终止也能代录）', expect: ['C4b 代录：校验顺序', 'C4b rules', 'C4b actions'], edits: [{ file: 'rules.js', from: "confirm_proxy: 'accept',", to: "confirm_proxy: 'resolve'," }] },
  { id: 'C4b 代录：任职接受代录的项目状态类别改成 accept（已结项不能代录）', expect: ['C4b 代录：任职接受的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: "appointment_proxy_accept: 'membership',", to: "appointment_proxy_accept: 'accept'," }] },
  // ── 资格检查 ──
  { id: 'C4b 代录：资格复核结果不进目标（失去资格也能代录）', expect: ['C4b 代录：校验顺序'], edits: [{ file: 'confirm.js', from: 'objectPending: c.obj.pending, qualificationLoss: loss, historyConflict', to: 'objectPending: c.obj.pending, qualificationLoss: null, historyConflict' }] },
  { id: 'C4b 代录：规则层不用资格复核结果', expect: ['C4b 代录：校验顺序', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.qualificationLoss !== null) return t.qualificationLoss || PROXY_FACT_UNKNOWN_MESSAGE;', to: '' }] },
  { id: 'C4b 代录：历史补录窗口冲突挂点不生效', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.historyConflict !== null) return t.historyConflict || PROXY_FACT_UNKNOWN_MESSAGE;', to: '' }] },
  // ── 提出人状态映射 ──
  { id: 'C4b 代录：提出人代录确认写成 confirmed（不是 proxy_confirmed）', expect: ['C4b 代录：有异议'], edits: [{ file: 'confirm.js', from: "const confirmedTo = method === 'proxy' ? 'proxy_confirmed' : 'confirmed';", to: "const confirmedTo = 'confirmed';" }] },
  { id: 'C4b 代录：提出人代录不认可写成 confirmed', expect: ['C4b 代录：有异议'], edits: [{ file: 'confirm.js', from: "const to = decision === 'confirm' ? confirmedTo : 'denied';", to: "const to = confirmedTo;" }] },
  // ── 任职 / 授权代录 ──
  { id: 'C7 F-1 授权代录不要求合法步骤', expect: ['C7 F-1 授权代录意图锁'], edits: [{ file: 'membership.js', from: "if (!['grant', 'accept'].includes(expectedStep)) throw invalid('请选择本次代录的授权步骤（grant / accept）', 'expected_step');", to: 'void expectedStep;' }] },
  { id: 'C7 F-1 授权代录不核对期望步骤与当前状态', expect: ['C7 F-1 授权代录意图锁'], edits: [{ file: 'membership.js', from: "if (d.status !== (grant ? 'pending_owner' : 'pending_accept')) throw stateError('授权步骤已变化，请刷新后按当前步骤重新代录');", to: 'void d.status;' }] },
  { id: 'C4b 代录：任职代录对有账号成员放行（目标恒视为无账号）', expect: ['C4b 代录：任职接受的校验'], edits: [{ file: 'membership.js', from: 'hasAccount: present(a.user_id),', to: 'hasAccount: false,' }] },
  { id: 'C4b 代录：任职代录规则层不拦有账号成员', expect: ['C4b 代录：任职接受的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.hasAccount === false) return null;', to: 'return null;' }] },
  { id: 'C4b 代录：任职代录不激活任职', expect: ['C4b 代录：任职——'], edits: [{ file: 'membership.js', from: 'await activateAppointment(q, user, a.project_id, a);', to: '' }] },
  { id: 'C4b 代录：任职代录的修订不置已确认', expect: ['C4b 代录：任职——'], edits: [{ file: 'membership.js', from: "await confirmCore.settleRevision(q, t.revisionId, 'confirmed');\n      const rec = await confirmCore.recordProxyConfirmation(q, user, attachmentHelpers, {\n        projectId: a.project_id", to: "const rec = await confirmCore.recordProxyConfirmation(q, user, attachmentHelpers, {\n        projectId: a.project_id" }] },
  { id: 'C4b 代录：授权批准一步对有账号负责人放行', expect: ['C4b 代录：授权的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.ownerHasAccount === false) return null;', to: 'return null;' }] },
  { id: 'C4b 代录：授权接受一步对有账号被授权人放行', expect: ['C4b 代录：授权的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.memberHasAccount === false) return null;', to: 'return null;' }] },
  { id: 'C4b 代录：授权批准一步的必需确认人记成被授权人', expect: ['C4b 代录：授权——'], edits: [{ file: 'membership.js', from: 'const requiredMemberId = grant ? owner.member_id : d.member_id;', to: 'const requiredMemberId = d.member_id;' }] },
  { id: 'C4b 代录：授权接受一步不激活授权', expect: ['C4b 代录：授权——'], edits: [{ file: 'membership.js', from: 'else await activateDelegation(q, user, d.project_id, d);', to: 'else { /* 不激活 */ }' }] },
  { id: 'C4b 代录：授权批准一步不推进到待接受', expect: ['C4b 代录：授权——'], edits: [{ file: 'membership.js', from: "if (grant) await moveDelegation(q, user, d.project_id, d, 'pending_accept', 'delegation_approved', { via: 'proxy' });", to: 'if (grant) { /* 不推进 */ }' }] },
  // ── 提出人任务改发（P48）──
  { id: 'C4b P48：提出人改发不核对提出人是否仍是确认人', expect: ['C4b 提出人改发'], edits: [{ file: 'confirm.js', from: 'const m = iv.proposer_member_id === null ? null : await core.eligibleMember(q, iv.proposer_member_id);', to: 'const m = iv.proposer_member_id === null ? null : { id: iv.proposer_member_id, proxy_only: false };' }] },
  { id: 'C4b P48：提出人改发不核对条目是否已有新版本', expect: ['C4b 提出人改发'], edits: [{ file: 'confirm.js', from: 'if (latest && latest.v !== iv.version_no) return', to: 'if (false) return' }] },
  // ── 读接口 ──
  { id: 'C4b 读接口：任务详情的代录标志不看对象状态（恒为真）', expect: ['C4b actions', 'C4a 浏览：', 'C4a 决策：成功路径'], edits: [{ file: 'confirm.js', from: "proxy: rules.opAllowed('confirm_proxy', c.access, c.access.project, await proxyTarget(q, c, user, null)),", to: 'proxy: true,' }] },
  { id: 'C4b 读接口：任职详情的代录标志恒为假', expect: ['C4b actions'], edits: [{ file: 'membership.js', from: "proxy_accept: rules.opAllowed('appointment_proxy_accept', identity, project, appointmentProxyTarget(a, apptConflict)),", to: 'proxy_accept: false,' }] },
  { id: 'C4b 读接口：授权详情的代录标志恒为假', expect: ['C4b actions', 'C4b 无账号授权'], edits: [{ file: 'membership.js', from: "proxy: rules.opAllowed('delegation_proxy', identity, project, t),", to: 'proxy: false,' }] },
  { id: 'C4b 读接口：提交返回的任务不带 proxy_only', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm.js', from: 'proxy_only: e.proxyOnly === true });', to: 'proxy_only: false });' }] },
  // ── 预筛修订批（fix1）──
  // L5：代录路径的对象侧效果与映射
  { id: 'C4b fix1 L5：代录路径不调 applyDecisionEffects（包不生效、提出人状态不变）', expect: ['C4b 代录：无账号', 'C4b 代录：混合', 'C4b 代录：有异议'], edits: [{ file: 'confirm.js', from: "await applyDecisionEffects(q, user, c, decision, reason, rec.confirmationId, 'proxy', result);", to: '' }] },
  { id: 'C4b fix1 L5：代录确认不走 takeEffectIfComplete（最后一条代录后版本仍待确认）', expect: ['C4b 代录：无账号', 'C4b 代录：混合'], edits: [{ file: 'confirm.js', from: 'const eff = await core.takeEffectIfComplete(q, user, c.task.project_id, c.obj.pkg, c.obj.ver);', to: "const eff = method === 'proxy' ? { effective: false, superseded: [], baselineNodes: [], advancedBatches: [] } : await core.takeEffectIfComplete(q, user, c.task.project_id, c.obj.pkg, c.obj.ver);" }] },
  { id: 'C4b fix1 L5：代录决策 → 修订状态映射写错（一律置已确认）', expect: ['C4b 代录：有异议'], edits: [{ file: 'confirm.js', from: "const toStatus = DECISIONS[decision];\n      await core.settleRevision(", to: "const toStatus = 'confirmed';\n      await core.settleRevision(" }] },
  { id: 'C4b fix1 L5：confirm_proxy 不核对修订号', expect: ['C4b 代录：校验顺序', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.revisionIdGiven !== undefined && t.currentRevisionId !== t.revisionIdGiven) return', to: 'if (false) return' }] },
  { id: 'C4b fix1 L5：confirm_proxy 不核对对象版本号', expect: ['C4b 代录：校验顺序', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.objectVersionIdGiven !== undefined && t.objectVersionId !== t.objectVersionIdGiven) return', to: 'if (false) return' }] },
  { id: 'C4b fix1 L5：任职代录的邀请行 status 写错（declined）', expect: ['C4b 代录：任职——'], edits: [{ file: 'membership.js', from: "VALUES (?, ?, 'appointment', ?, 'accepted', ?, datetime('now','localtime'))", to: "VALUES (?, ?, 'appointment', ?, 'declined', ?, datetime('now','localtime'))" }] },
  { id: 'C4b fix1 L5：任务详情的 proxy_only 写反', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm.js', from: 'proxy_only: c.requiredUserId === null,', to: 'proxy_only: c.requiredUserId !== null,' }] },
  { id: 'C4b fix1 L5：任务列表的 proxy_only 写反', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm.js', from: 'const proxyOnly = await core.isProxyOnlyMember(q, cur.required_member_id);', to: 'const proxyOnly = !(await core.isProxyOnlyMember(q, cur.required_member_id));' }] },
  // MED-2：确认记录的凭据附件
  { id: 'C4b fix1 MED-2：确认记录不返回凭据附件编号', expect: ['C4b 代录：无账号', 'C4b 代录：任职——', 'C4b 代录：授权——', 'C4b 代录：有异议'], edits: [{ file: 'confirm-core.js', from: 'cf.attachment_ids = bound.map((x) => x.attachment_id);', to: 'cf.attachment_ids = [];' }] },
  // 小修批 F2：原变异「凭据附件把已软删除的也列出」（去掉 a.deleted_at IS NULL 过滤）随契约翻转——现在已删除的凭据本来就要列出，对应变异是「已删除凭据不标已删除」及「把已删除的滤掉」。
  { id: 'C4b fix2 F2：已删除凭据不标已删除', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: 'deleted: bound[i].deleted_at !== null, deleted_at:', to: 'deleted: false, deleted_at:' }] },
  { id: 'C4b fix2 F2：已删除凭据不标删除人', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: 'deleted_by: bound[i].deleted_by, deleted_by_name: bound[i].deleted_by_name,', to: 'deleted_by: null, deleted_by_name: null,' }] },
  { id: 'C4b fix2 F2：凭据附件读接口把已软删除的滤掉（回到 fix1 口径）', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: "WHERE b.owner_type = 'confirmation' AND b.owner_id = ? ORDER BY b.attachment_id", to: "WHERE b.owner_type = 'confirmation' AND b.owner_id = ? AND a.deleted_at IS NULL ORDER BY b.attachment_id" }] },
  { id: 'C4b fix1 MED-2：凭据附件不限本条确认记录（别的确认记录的附件串入）', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: "WHERE b.owner_type = 'confirmation' AND b.owner_id = ? ORDER BY b.attachment_id", to: "WHERE b.owner_type = 'confirmation' AND (b.owner_id = ? OR 1 = 1) ORDER BY b.attachment_id" }] },
  { id: 'C4b fix2 F6：凭据附件查询不限 owner_type（同号的改期证据串入）', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: "WHERE b.owner_type = 'confirmation' AND b.owner_id = ? ORDER BY b.attachment_id", to: "WHERE b.owner_id = ? ORDER BY b.attachment_id" }] },
  { id: 'C4b fix1 MED-2：凭据附件视图返回原名（不走遮蔽规则）', expect: ['C4b 代录：无账号'], edits: [{ file: 'confirm-core.js', from: 'const view = await attachmentView(q, bound);', to: "const view = await Promise.all(bound.map(async (x) => ({ attachment_id: x.attachment_id, sha256: x.sha256, masked: false, name: (await q.get('SELECT original_name AS n FROM sysbuild_attachments WHERE id = ?', [x.attachment_id])).n, size: 3, mime_type: 'text/plain' })));" }] },
  // 小修批 F3：fail-closed 的非等价变异（只拦「明确为假」的写法，缺失事实放行；被 rules 用例的 drop 断言打红）
  { id: 'C4b fix2 F3：objectPending 只拦明确为假（缺失放行）', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.objectPending !== true) return', to: 'if (t.objectPending === false) return' }] },
  { id: 'C4b fix2 F3：任职 memberActive 只拦明确为假（缺失放行）', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.memberActive !== true) return', to: 'if (t.memberActive === false) return' }] },
  { id: 'C4b fix2 F3：授权批准 appointmentIsCurrent 只拦明确为假（缺失放行）', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: "return t.appointmentIsCurrent ? null : '授权所依据的负责人任职已变化，请重新发起授权';", to: "return t.appointmentIsCurrent === false ? '授权所依据的负责人任职已变化，请重新发起授权' : null;" }] },
  // D3：PM 不得代录自己
  { id: 'C4b fix1 D3：规则层不拦 PM 代录自己', expect: ['C4b 代录：PM 不能代录自己', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.requiredIsSelf === true) return PROXY_SELF_MESSAGE;', to: '' }] },
  { id: 'C4b fix1 D3：目标里 requiredIsSelf 恒为假（读写两端都不识别本人）', expect: ['C4b 代录：PM 不能代录自己'], edits: [{ file: 'confirm.js', from: 'requiredIsSelf: c.requiredUserId !== null && c.requiredUserId === Number(user.id),', to: 'requiredIsSelf: false,' }] },
  // L6：事实缺失即拒（每处各一条：写回「只拦明确为假」的旧写法）
  { id: 'C4b fix1 L6：proxyable 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.proxyable !== true) return', to: 'if (t.proxyable === false) return' }] },
  { id: 'C4b fix1 L6：requiredIsSelf 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.requiredIsSelf !== false) return PROXY_FACT_UNKNOWN_MESSAGE;', to: '' }] },
  { id: 'C4b fix1 L6：qualificationLoss 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.qualificationLoss !== null) return', to: 'if (t.qualificationLoss) return' }] },
  { id: 'C4b fix1 L6：historyConflict 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.historyConflict !== null) return', to: 'if (t.historyConflict) return' }] },
  { id: 'C4b fix1 L6：任职 hasAccount 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.hasAccount === false) return null;', to: 'if (!t.hasAccount) return null;' }] },
  { id: 'C4b fix1 L6：授权批准一步 ownerHasAccount 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.ownerHasAccount === false) return null;', to: 'if (!t.ownerHasAccount) return null;' }] },
  { id: 'C4b fix1 L6：授权接受一步 memberHasAccount 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.memberHasAccount === false) return null;', to: 'if (!t.memberHasAccount) return null;' }] },
  { id: 'C4b fix1 L6：授权接受一步 requalReason 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.requalReason !== null) return t.requalReason || PROXY_FACT_UNKNOWN_MESSAGE;\n        if (t.memberHasAccount === false) return null;', to: 'if (t.requalReason) return t.requalReason;\n        if (t.memberHasAccount === false) return null;' }] },
  // codex 21 号 G2：批准分支也核对 requalReason（非 null / undefined 拒绝）
  { id: 'C4b fix2 G2：授权批准一步不查 requalReason（被授权人已移出 / 被设为 PM 仍可代录批准）', expect: ['C4b 代录：授权的校验', 'C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.requalReason !== null) return t.requalReason || PROXY_FACT_UNKNOWN_MESSAGE;\n        if (t.ownerHasAccount === false) return null;', to: 'if (t.ownerHasAccount === false) return null;' }] },
  { id: 'C4b fix2 G2：授权批准一步 requalReason 缺失放行', expect: ['C4b rules'], edits: [{ file: 'rules.js', from: 'if (t.requalReason !== null) return t.requalReason || PROXY_FACT_UNKNOWN_MESSAGE;\n        if (t.ownerHasAccount === false) return null;', to: 'if (t.requalReason) return t.requalReason;\n        if (t.ownerHasAccount === false) return null;' }] },
  // codex 21 号 G3：接受一步的外部日期下限 = 负责人批准日
  { id: 'C4b fix2 G3：接受一步外部日期下限仍取提议创建日', expect: ['C4b 代录：授权的校验'], edits: [{ file: 'membership.js', from: 'grant ? d.created_at : await delegationApprovalFloor(q, d)', to: 'd.created_at' }] },
  { id: 'C4b fix2 G3：批准日不取代录批准记录的 external_date', expect: ['C4b 代录：授权——'], edits: [{ file: 'confirm-core.js', from: 'if (g) return g.external_date;', to: 'if (false) return g.external_date;' }] }, // Q-S2 末轮 LOW-3：批准日取法抽到 confirm-core.js delegationApprovedOn，锚点随之换文件
  { id: 'C4b fix2 G3：批准日不取平台批准事件时间', expect: ['C4b 代录：授权的校验'], edits: [{ file: 'confirm-core.js', from: 'return e.created_at;', to: 'continue;' }] },
  { id: 'C4b fix2 G3：没有批准记录时不回落提议创建日（下限取空）', expect: ['C4b 代录：授权的校验'], edits: [{ file: 'membership.js', from: 'return (await confirmCore.delegationApprovedOn(q, d.id)) || d.created_at;', to: "return (await confirmCore.delegationApprovedOn(q, d.id)) || '2000-01-01';" }] },
  // codex 21 号 G1：提出人不认可后不能改发
  { id: 'C4b fix2 G1：提出人不认可后的改发文案回到泛化文案', expect: ['C4b 提出人改发（G1'], edits: [{ file: 'rules.js', from: "if (t.objectType === 'item_version' && t.objectStatus === 'denied') return PROPOSER_DENIED_REISSUE_MESSAGE;", to: '' }] },
  { id: 'C4b fix2 G1：提出人不认可后允许改发（denied 视同待确认）', expect: ['C4b 提出人改发（G1'], edits: [
    { file: 'rules.js', from: "if (t.objectType === 'item_version' && t.objectStatus === 'denied') return PROPOSER_DENIED_REISSUE_MESSAGE;", to: '' },
    { file: 'rules.js', from: "if (t.objectStatus !== 'pending') return '任务所在的版本已不是待确认，不能改发';", to: "if (t.objectStatus !== 'pending' && t.objectStatus !== 'denied') return '任务所在的版本已不是待确认，不能改发';" },
  ] },
  // L10：账号停用另给文案
  { id: 'C4b fix1 L10：任职代录遇账号停用仍报「有平台账号」', expect: ['C4b rules', 'C4b 账号停用（进程内）'], edits: [{ file: 'rules.js', from: "return t.accountDisabled === true ? '该成员账号已停用，不能作为确认人' : '该成员有平台账号，请由本人通过邀请接受任职';", to: "return '该成员有平台账号，请由本人通过邀请接受任职';" }] },
  { id: 'C4b fix1 L10：授权批准一步遇负责人账号停用仍报「有平台账号」', expect: ['C4b rules', 'C4b 账号停用（进程内）'], edits: [{ file: 'rules.js', from: "return t.ownerAccountDisabled === true ? '现任负责人账号已停用，不能作为确认人' : '现任负责人有平台账号，请由负责人本人批准';", to: "return '现任负责人有平台账号，请由负责人本人批准';" }] },
  { id: 'C4b fix1 L10：授权接受一步遇被授权人账号停用仍报「有平台账号」', expect: ['C4b rules', 'C4b 账号停用（进程内）'], edits: [{ file: 'rules.js', from: "return t.memberAccountDisabled === true ? '被授权人账号已停用，不能作为确认人' : '被授权人有平台账号，请由本人接受授权';", to: "return '被授权人有平台账号，请由本人接受授权';" }] },
  { id: 'C4b fix1 L10：任职目标不识别账号停用', expect: ['C4b 账号停用（进程内）'], edits: [{ file: 'membership.js', from: "accountDisabled: present(a.user_id) && a.user_status !== 'active',", to: 'accountDisabled: false,' }] },
];

module.exports = { defineProxyCases, PROXY_MUTATIONS };
