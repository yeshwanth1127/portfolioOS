/**
 * Machine-readable Phase 4 subset (twin: docs/permissions.csv, human: docs/model/permissions-matrix.md).
 * Cell values: Y = allowed at role gate, N = denied, Y* = allowed with resource/domain conditions.
 */

export const ROLES = ['owner', 'manager', 'vice_manager', 'team_lead', 'member'];

export const PERMISSION_ACTIONS = [
  'submission.record',
  'submission.approve',
  'submission.amend',
  'day.lock',
  'day.reopen',
  'kpi.edit',
  'person.manage',
  'unit.manage',
  'invitation.create',
  'calendar.edit',
  'calendar.event.create',
  'project.edit',
  'task.assign',
  'meeting.create',
  'meeting.manage',
];

/** @type {Record<string, Record<string, 'Y' | 'N' | 'Y*'>>} */
export const MATRIX = {
  'submission.record': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'Y',
    member: 'Y*',
  },
  'submission.approve': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'Y*',
    member: 'N',
  },
  'submission.amend': {
    owner: 'Y',
    manager: 'Y*',
    vice_manager: 'Y*',
    team_lead: 'Y*',
    member: 'Y*',
  },
  'day.lock': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'N',
    team_lead: 'N',
    member: 'N',
  },
  'day.reopen': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'N',
    team_lead: 'N',
    member: 'N',
  },
  'kpi.edit': {
    owner: 'Y',
    manager: 'N',
    vice_manager: 'N',
    team_lead: 'N',
    member: 'N',
  },
  'person.manage': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'N',
    member: 'N',
  },
  'unit.manage': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'N',
    member: 'N',
  },
  'invitation.create': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'N',
    member: 'N',
  },
  'calendar.event.create': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'Y',
    member: 'Y',
  },
  'calendar.edit': {
    owner: 'Y',
    manager: 'Y*',
    vice_manager: 'Y*',
    team_lead: 'N',
    member: 'Y*',
  },
  'project.edit': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'N',
    member: 'N',
  },
  'task.assign': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'Y',
    member: 'N',
  },
  'meeting.create': {
    owner: 'Y',
    manager: 'Y',
    vice_manager: 'Y',
    team_lead: 'Y',
    member: 'Y',
  },
  'meeting.manage': {
    owner: 'Y',
    manager: 'Y*',
    vice_manager: 'Y*',
    team_lead: 'Y*',
    member: 'Y*',
  },
};

/** Role-gate only (ignores resource conditions behind Y*). */
export function matrixRoleAllows(role, action) {
  const row = MATRIX[action];
  if (!row) return false;
  const cell = row[role];
  return cell === 'Y' || cell === 'Y*';
}
