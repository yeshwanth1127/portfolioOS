/** Default forbidden copy keyed by matrix action (domain may override for resource-specific cases). */
const MESSAGE_BY_ACTION = {
  'submission.record': 'Not owner of this KPI',
  'submission.approve': 'Manager or team lead required',
  'submission.amend': 'You cannot amend this submission',
  'day.lock': 'Only the owner or the manager can close or reopen a day.',
  'day.reopen': 'Only the owner or the manager can close or reopen a day.',
  'kpi.edit': 'Only the portfolio owner can change the KPI register',
  'person.manage': 'Only the owner or a manager can manage people',
  'unit.manage': 'Only the owner or a manager can manage units',
  'invitation.create': 'Only the owner or a manager can invite people',
  'calendar.edit': 'You cannot change this event',
  'calendar.event.create': 'You cannot add events',
  'project.edit': 'You cannot change this project',
  'task.assign': 'You cannot assign tasks on this project',
};

/**
 * Standard route/domain forbidden payload for a matrix action.
 *
 * @param {{ role?: string }} _membership — reserved for future scoped messages
 * @param {string} action — matrix action, e.g. `submission.approve`
 * @param {string} [message] — override default copy
 * @returns {{ error: { code: 'forbidden', message: string } }}
 */
export function permissionDenied(_membership, action, message) {
  return {
    error: {
      code: 'forbidden',
      message: message ?? MESSAGE_BY_ACTION[action] ?? 'You do not have permission to perform this action.',
    },
  };
}
