// L2 站内待办收件人；登记临时要求的无收件人提示与待办共用。不创建发送意图。
'use strict';
const core = require('./confirm-core');
const entries = require('./entries-core');

async function reportRecipientsOf(q, projectId) {
  const partyId = await entries.devPartyIdOf(q, projectId);
  if (partyId === null) return { due: [], assessment: [] };
  const delegate = await core.currentDelegate(q, partyId);
  const owner = await core.currentOwner(q, partyId);
  const userOf = async (person) => {
    if (!person || person.proxyOnly) return null;
    const member = await core.eligibleMember(q, person.memberId);
    return member && member.user_id !== null ? Number(member.user_id) : null;
  };
  // 只有没有代表人时才退到负责人；已有无账号代表人不把其待办转交负责人。
  const dueUser = await userOf(delegate || owner);
  const assessment = [];
  for (const person of [delegate, owner]) {
    const uid = await userOf(person);
    if (uid !== null && !assessment.includes(uid)) assessment.push(uid);
  }
  return { due: dueUser === null ? [] : [dueUser], assessment };
}

module.exports = { reportRecipientsOf };
