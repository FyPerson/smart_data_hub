'use strict';

const manager = (identity) => !!(identity.isPm || identity.isAdmin);
const joined = (row) => row.joined_at !== null && row.joined_at !== undefined;
const active = (row) => joined(row) && row.removed_at === null;

function memberVisible(identity, row) {
  return joined(row) && (manager(identity) || active(row));
}
function appointmentVisible(identity, row) {
  return row.status === 'ended' || (row.status === 'active' && (manager(identity) || active(row)));
}
function delegationVisible(identity, row) {
  return row.status === 'revoked' || (row.status === 'active' && (manager(identity) || active(row)));
}

module.exports = { memberVisible, appointmentVisible, delegationVisible };
