/**
 * Agent tool name → Phase 4 matrix action (role gate; domain applies Y* resources).
 * Source of truth for catalogue `allowed` and `actionAllowed`.
 */
export const TOOL_TO_MATRIX_ACTION = {
  record_number: 'submission.record',
  amend_number: 'submission.amend',
  withdraw_submission: 'submission.amend',
  validate_submission: 'submission.approve',
  lock_day: 'day.lock',
  reopen_day: 'day.reopen',
  add_kpi: 'kpi.edit',
  update_kpi: 'kpi.edit',
  retire_kpi: 'kpi.edit',
  set_target: 'kpi.edit',
  assign_kpi_owner: 'person.manage',
  add_person: 'person.manage',
  update_person: 'person.manage',
  remove_person: 'person.manage',
  add_unit: 'unit.manage',
  update_org: 'unit.manage',
  add_event: 'calendar.event.create',
  move_event: 'calendar.edit',
  create_project: 'project.edit',
  create_task: 'task.assign',
  post_project_update: 'project.edit',
};

/** Owner-only tools not yet on the matrix CSV (escalations). */
export const TOOL_OWNER_ONLY = new Set(['decide_escalation']);
