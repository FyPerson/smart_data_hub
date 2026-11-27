'use strict';

const rules = require('./rules');
const work = require('./work-core');
const { PURPOSES, REF_TYPES, ROUTES, enqueueSendIntent } = require('./notify-core');
const { OPINION_ASSESS, OPINION_READY, OPINION_RESULT, OPINION_CUT } = PURPOSES;
const STRUCTURAL = Object.freeze({ ignoreAccountStatus: true });
const TITLES = Object.freeze({
  [OPINION_ASSESS]: '意见评估知悉',
  [OPINION_READY]: '开发意见知悉',
  [OPINION_RESULT]: '意见结论知悉',
  [OPINION_CUT]: '砍需求待同意知悉',
});
const OUTCOMES = { now: '本期做', next: '留到下一期', no: '不做', cut_agreed: '同意本期移出范围', scope_kept: '维持原范围' };
const isWorkPurpose = (purpose) => Object.hasOwn(TITLES, purpose);

async function queue(q, projectId, purpose, refId, recipientUserId) {
  if (!Number.isSafeInteger(recipientUserId) || recipientUserId <= 0) return;
  const refType = purpose === OPINION_CUT ? REF_TYPES.CUT_APPROVAL : REF_TYPES.OPINION;
  await enqueueSendIntent(q, { projectId, purpose, refType, refId, recipientUserId });
}

async function afterTriage(q, opinion, status) {
  const { project_id: pid, id } = opinion;
  if (status === 'assessment') {
    const developer = await work.developerResponsible(q, pid, STRUCTURAL);
    await queue(q, pid, OPINION_ASSESS, id, developer?.userId);
  }
  if (status === 'cut_approval') {
    const rows = await q.all('SELECT id, party_id FROM sysbuild_cut_approvals WHERE project_id = ? AND opinion_id = ? ORDER BY id', [pid, id]);
    for (const row of rows) {
      const recipient = await work.responsibleUser(q, pid, row.party_id, STRUCTURAL);
      await queue(q, pid, OPINION_CUT, row.id, recipient?.userId);
    }
  }
  if (status === 'concluded') await afterConclusion(q, opinion);
}

function afterDeveloperAssessment(q, opinion, project) {
  return queue(q, opinion.project_id, OPINION_READY, opinion.id, project.pm_user_id);
}

function afterConclusion(q, opinion) {
  return queue(q, opinion.project_id, OPINION_RESULT, opinion.id, opinion.author_user_id);
}

async function describe(q, intent, user, readonlyIds) {
  const pid = intent.project_id;
  const purpose = intent.purpose;
  const skip = (reason, route = ROUTES.project(pid)) => ({ skip: reason, route, summary: '' });
  const expectedType = purpose === OPINION_CUT ? REF_TYPES.CUT_APPROVAL : REF_TYPES.OPINION;
  if (!user || intent.ref_type !== expectedType) return skip('意见知悉的收件人或引用对象不符');
  const project = await q.get('SELECT id, pm_user_id, status FROM sysbuild_projects WHERE id = ?', [pid]);
  if (!project || project.status === 'terminated') return skip('项目不再需要意见知悉');
  let approval = null;
  if (purpose === OPINION_CUT) {
    approval = await q.get('SELECT id, opinion_id, party_id, status FROM sysbuild_cut_approvals WHERE id = ? AND project_id = ?', [intent.ref_id, pid]);
    if (!approval) return skip('待同意记录已不存在');
  }
  const opinion = await q.get('SELECT * FROM sysbuild_opinions WHERE id = ? AND project_id = ?', [approval ? approval.opinion_id : intent.ref_id, pid]);
  if (!opinion) return skip('意见已不存在');
  const route = ROUTES.opinion(pid, opinion.id);
  const notNeeded = () => skip('意见状态或收件人资格已变化', route);
  const target = (summary) => ({ route, summary, skip: '' });
  if (purpose === OPINION_RESULT) {
    if (opinion.status !== 'concluded' || opinion.author_user_id !== user.id) return notNeeded();
    // 项目可见性只核身份与成员关系。账号停用由发送服务统一按可恢复失败处理。
    const identity = await rules.loadProjectAccess(q, pid, user, { readonlyIds, writeRoles: [] });
    if (!rules.canViewProject(identity) || (!identity.isMember && !identity.isAdmin)) return notNeeded();
    const assessment = opinion.assessment_source
      ? `\n开发意见：${opinion.assessment_text}\n工时：${opinion.assessment_hours} 小时`
      : opinion.skip_reason ? '\n跳过开发评估：' + opinion.skip_reason : '';
    return target(`「${opinion.title}」${OUTCOMES[opinion.outcome]}。\n${opinion.outcome_text}${assessment}`);
  }
  if (!['active', 'paused'].includes(project.status)) return notNeeded();
  if (purpose === OPINION_READY) return opinion.status === 'disposition' && project.pm_user_id === user.id
    ? target('「' + opinion.title + '」的开发意见已提交，请查看。') : notNeeded();
  if (purpose === OPINION_ASSESS) {
    const developer = await work.developerResponsible(q, pid, STRUCTURAL);
    return opinion.status === 'assessment' && developer?.userId === user.id
      ? target('「' + opinion.title + '」需要开发评估，请查看。') : notNeeded();
  }
  const responsible = await work.responsibleUser(q, pid, approval.party_id, STRUCTURAL);
  return opinion.status === 'cut_approval' && approval.status === 'pending' && responsible?.userId === user.id
    ? target('「' + opinion.title + '」等您本人表态，请到项目查看。') : notNeeded();
}

const OPINION_ACTIONS = {
  triage: ['opinion_triage', '待您初判'],
  assessment: ['opinion_assess', '待您给开发意见与工时'],
  disposition: ['opinion_dispose', '待您定去向'],
  cut_approval: ['opinion_cut_decide', '待您本人表态'],
};

async function myWork(q, user, accessOptions) {
  const uid = Number(user.id);
  const projects = await q.all(
    `SELECT p.id, p.system_name FROM sysbuild_projects p WHERE p.status IN ('active','paused') AND
      (p.pm_user_id = ? OR EXISTS (SELECT 1 FROM sysbuild_members m WHERE m.project_id = p.id AND m.user_id = ? AND ${rules.MEMBER_ACTIVE_SQL}))
      ORDER BY p.id DESC`, [uid, uid]
  );
  const opinions = [];
  const tasks = [];
  for (const project of projects) {
    const access = await rules.loadProjectAccess(q, project.id, user, accessOptions);
    if (!rules.canViewProject(access)) continue;
    // 「等我处理」只按本人身份算：平台管理员的代办权限不算他的待办（isSuper 置假），否则他作为普通成员的项目里会冒出 PM 的事项。
    const identity = { ...access, isSuper: false, userId: uid };
    const open = await q.all(
      "SELECT id, title, status, updated_at FROM sysbuild_opinions WHERE project_id = ? AND status IN ('triage','assessment','disposition','cut_approval') ORDER BY id DESC",
      [project.id]
    );
    const developer = open.some((row) => row.status === 'assessment') ? await work.developerResponsible(q, project.id) : null;
    const cut = open.some((row) => row.status === 'cut_approval')
      ? await q.all(
        `SELECT a.opinion_id, a.party_id FROM sysbuild_cut_approvals a
           JOIN sysbuild_opinions o ON o.id = a.opinion_id AND o.project_id = a.project_id
          WHERE a.project_id = ? AND a.status = 'pending' AND o.status = 'cut_approval' ORDER BY a.id`, [project.id])
      : [];
    const qualifyingCuts = new Set();
    for (const row of cut) {
      const owner = await work.responsibleUser(q, project.id, row.party_id);
      if (owner?.userId === uid) qualifyingCuts.add(row.opinion_id);
    }
    for (const item of open) {
      // PM 可以代录，待开发评估仍是现任开发负责人的事项。
      if (item.status === 'assessment' && developer?.userId !== uid) continue;
      const applicable = OPINION_ACTIONS[item.status];
      if (!applicable) continue;
      const [op, label] = applicable;
      const target = { opinionStatus: item.status, isDevResponsible: developer?.userId === uid, isCutResponsible: qualifyingCuts.has(item.id), cutStatus: 'pending' };
      if (rules.opAllowed(op, identity, identity.project, target)) opinions.push({
        project_id: project.id, system_name: project.system_name, object_type: 'opinion', object_id: item.id, opinion_id: item.id,
        title: item.title, message: label + ' · ' + item.title, created_at: item.updated_at,
      });
    }
    const pending = await q.all("SELECT id, node_id, title, assignee_user_id, status, created_at FROM sysbuild_tasks WHERE project_id = ? AND assignee_user_id = ? AND status = 'pending' ORDER BY id DESC", [project.id, uid]);
    for (const task of pending) {
      if (rules.opAllowed('work_task_result', identity, identity.project, { taskStatus: task.status, assigneeUserId: task.assignee_user_id })) tasks.push({
        project_id: project.id, system_name: project.system_name, object_type: 'work_task', object_id: task.id,
        work_task_id: task.id, node_id: task.node_id, title: task.title, created_at: task.created_at,
      });
    }
  }
  return { opinion: opinions, work_task: tasks };
}

module.exports = { TITLES, isWorkPurpose, afterTriage, afterDeveloperAssessment, afterConclusion, describe, myWork };
