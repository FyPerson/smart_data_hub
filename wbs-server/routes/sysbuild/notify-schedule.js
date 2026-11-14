// routes/sysbuild/notify-schedule.js — 项目管理（系统建设记录）模块：改期知会的生成（C6b，在改期写事务内调用）与改期知会异议的资格判定
//   方案 SSOT = docs/local/系统建设记录/系统建设记录_平台集成_方案_20261107_v1.5.md §4.4（:748 知会）、§6.2（sysbuild_notices / sysbuild_notice_attempts / sysbuild_notice_objections）、§9.2。
//   派单 = docs/local/系统建设记录/送审准备/C6_C6b_通知待办改期知会_派单_20261107.md §5。
//
// 生成（plan.js POST /nodes/:nid/schedule 改期式写入、非草稿、写完改期记录之后同一事务内调用）：该节点是正式上线里程碑、且新的计划结束日期晚于改前的当前计划结束日期（推后），
//   给每个需求部门的现任负责人各写一条 sysbuild_notices（kind = schedule_change，ref_type = schedule_record，ref_id = 改期记录编号，recipient_member_id = 负责人成员编号）；
//   负责人有平台账号 → 同一事务写一条发送意图（purpose = schedule_notice，引用这条知会），发送结果由 notify.js 事务外回写 sysbuild_notice_attempts（channel = dingtalk）；
//   负责人没有平台账号（只能代录）→ 没有钉钉可发，同事务写一条失败的发送尝试（channel = dingtalk，result = failed，response_code = no_account），让留痕里看得到「没发出去」。
//   提前或同日不知会；草稿期计划不知会（调用方只在改期式分支调用）；需求部门没有现任负责人的不生成（没有收件人）。
//   「现任负责人」按与账号状态无关的任职资格选（C6b 修订批 4 / O2）：负责人账号此刻停用也生成知会与发送意图，由发送侧记 failed（user_disabled，可恢复）。
// 异议资格（P158，非仅供参考类知会按来源判定，C5 残余④）：改期知会只有**接收人本人、且仍是需求部门现任负责人**可以提；其他人（含项目 PM、其他需求部门负责人、已卸任的接收人）403。
'use strict';
const { writeEvent } = require('./events');
const core = require('./confirm-core');
const notifyCore = require('./notify-core');

const NOTICE_KIND_SCHEDULE = 'schedule_change';
const NOTICE_REF_SCHEDULE = 'schedule_record';

// node：节点行（至少 id / is_golive_milestone / batch_id）；before / after：{ start, end }（before 可空 = 改前没有当前计划）。返回新建的知会 [{ notice_id, member_id, party_id, user_id, intent_id }]。
async function createScheduleNotices(q, user, o) {
  const node = o.node;
  if (!node || node.is_golive_milestone !== 1) return [];
  if (!o.before || typeof o.before.end !== 'string' || typeof o.after.end !== 'string') return [];
  if (!(o.after.end > o.before.end)) return []; // 提前或同日不知会
  const uid = Number(user.id);
  const parties = await q.all("SELECT id, name FROM sysbuild_parties WHERE project_id = ? AND side = 'demand' ORDER BY sort_order, id", [o.projectId]);
  const out = [];
  for (const p of parties) {
    // 修订批 4（codex 28-R2 O2）：选「现任负责人」按与账号状态无关的任职资格（任职生效 + 成员已加入未移出），账号停用的负责人也选——否则改期恰逢负责人账号停用，整条知会（含发送意图）丢失，
    //   账号恢复后也无从补发。有账号的照常写发送意图（发送侧发现账号停用 → 记 failed（user_disabled，可恢复），恢复后补发 / 扫描送出）；无账号的走下面的原逻辑。
    const owner = await core.currentOwner(q, p.id, { ignoreAccountStatus: true });
    if (!owner) continue;
    const nr = await q.run(
      'INSERT INTO sysbuild_notices (project_id, kind, ref_type, ref_id, recipient_member_id, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [o.projectId, NOTICE_KIND_SCHEDULE, NOTICE_REF_SCHEDULE, o.recordId, owner.memberId, uid]
    );
    const recipientUserId = await notifyCore.userOfMember(q, owner.memberId);
    let intentId = null;
    if (recipientUserId !== null) {
      intentId = await notifyCore.enqueueSendIntent(q, {
        projectId: o.projectId, purpose: notifyCore.PURPOSES.SCHEDULE_NOTICE, refType: notifyCore.REF_TYPES.NOTICE, refId: nr.lastID, recipientUserId,
      });
    } else {
      await q.run("INSERT INTO sysbuild_notice_attempts (notice_id, channel, result, response_code) VALUES (?, 'dingtalk', 'failed', 'no_account')", [nr.lastID]);
    }
    await writeEvent(q, {
      projectId: o.projectId, objectType: 'notice', objectId: nr.lastID, eventType: 'notice_created',
      payload: {
        kind: NOTICE_KIND_SCHEDULE, record_id: o.recordId, node_id: node.id, party_id: p.id, recipient_member_id: owner.memberId,
        before_end: o.before.end, after_end: o.after.end, send_intent_id: intentId, no_account: recipientUserId === null,
      },
      operatorId: uid, operatorName: core.operatorNameOf(user),
    });
    out.push({ notice_id: nr.lastID, member_id: owner.memberId, party_id: p.id, user_id: recipientUserId, intent_id: intentId });
  }
  return out;
}

// 改期知会异议的资格事实（读，q 在 withRead / withWriteTxn 里）：接收人成员行此刻仍是某个需求部门的现任负责人？
//   返回接收人的账号编号与 { stillOwner, partyId }。stillOwner 的口径 = 成员仍在项目内（已加入未移出）+ 本方有生效任职指向它（核对的是通知发出时的那个部门：接收人成员行属于哪个参与方就看哪个参与方）。
//   o（可空）：{ ignoreAccountStatus: true } = 「现任负责人」不把账号状态并进判定（钉钉发送侧先判永久失格、账号停用另记可恢复的失败，C6b 修订批 3；站内异议资格不传，口径不变）。
async function scheduleNoticeObjectorFacts(q, notice, o) {
  const m = await q.get('SELECT id, user_id, party_id FROM sysbuild_members WHERE id = ?', [notice.recipient_member_id]);
  if (!m) return { recipientUserId: null, stillOwner: false, partyId: null };
  const cur = m.party_id === null || m.party_id === undefined ? null : await core.currentOwner(q, m.party_id, o);
  const party = m.party_id === null || m.party_id === undefined ? null : await q.get('SELECT side FROM sysbuild_parties WHERE id = ?', [m.party_id]);
  return {
    recipientUserId: m.user_id === null || m.user_id === undefined ? null : Number(m.user_id),
    stillOwner: !!cur && cur.memberId === m.id && !!party && party.side === 'demand',
    partyId: m.party_id === undefined ? null : m.party_id,
  };
}

module.exports = { NOTICE_KIND_SCHEDULE, NOTICE_REF_SCHEDULE, createScheduleNotices, scheduleNoticeObjectorFacts };
