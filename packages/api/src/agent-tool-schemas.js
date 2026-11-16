/** JSON Schema fragments for GET /agent/tools/catalog (docs/BUILD.md § 4.14, § 13). */

const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Business date (Asia/Kolkata), YYYY-MM-DD' };
const orgSlug = { type: 'string', description: 'Organisation slug or familiar name (e.g. pats, TMS)' };
const kpiCode = { type: 'string', description: 'KPI code (e.g. pats.acres) or display name' };

/** @type {Record<string, object>} */
export const INPUT_SCHEMA_BY_ACTION = {
  check_readiness: {
    type: 'object',
    properties: { org_slug: { ...orgSlug, description: 'Optional; omit for the whole portfolio (owner).' } },
  },
  check_day: {
    type: 'object',
    required: ['org_slug'],
    properties: { org_slug: orgSlug, date, period_date: date, period: date },
  },
  show_kpi: {
    type: 'object',
    required: ['kpi_code'],
    properties: { org_slug: orgSlug, kpi_code: kpiCode, date, period: date, period_date: date },
  },
  list_kpis: {
    type: 'object',
    required: ['org_slug'],
    properties: { org_slug: orgSlug },
  },
  list_waiting: {
    type: 'object',
    properties: { org_slug: orgSlug, date, period_date: date },
  },
  list_off_track: {
    type: 'object',
    properties: {
      org_slug: { ...orgSlug, description: 'Optional for owner (whole portfolio).' },
      severity: { type: 'string', enum: ['red', 'watch', 'bad'] },
      date,
      period_date: date,
    },
  },
  who_owns: {
    type: 'object',
    required: ['kpi_code'],
    properties: { org_slug: orgSlug, kpi_code: kpiCode },
  },
  find_person: {
    type: 'object',
    required: ['name'],
    properties: { name: { type: 'string' }, org_slug: orgSlug },
  },
  list_escalations: {
    type: 'object',
    properties: { org_slug: orgSlug },
  },
  list_orgs: { type: 'object', properties: {} },
  list_units: { type: 'object', properties: {} },
  show_org: {
    type: 'object',
    required: ['org_slug'],
    properties: { org_slug: orgSlug },
  },
  list_people: {
    type: 'object',
    required: ['org_slug'],
    properties: { org_slug: orgSlug },
  },
  list_scores: {
    type: 'object',
    properties: { org_slug: orgSlug, from: date, to: date, date, period_date: date },
  },
  list_pending: {
    type: 'object',
    properties: { org_slug: orgSlug, date, period_date: date },
  },
  show_me: { type: 'object', properties: {} },
  list_events: {
    type: 'object',
    properties: { from: date, to: date },
  },
  list_meetings: {
    type: 'object',
    properties: { from: date, to: date },
  },
  meeting_notes: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Words from the meeting title' },
      date: { ...date, description: 'Day the meeting happened (YYYY-MM-DD)' },
    },
  },
  add_event: {
    type: 'object',
    required: ['title', 'starts_at', 'ends_at'],
    properties: {
      title: { type: 'string' },
      kind: { type: 'string', enum: ['meeting', 'review', 'visit', 'call', 'deadline', 'other'] },
      org_slug: orgSlug,
      org_id: { type: 'string', format: 'uuid' },
      starts_at: { type: 'string', description: 'ISO timestamp' },
      ends_at: { type: 'string', description: 'ISO timestamp' },
      all_day: { type: 'boolean' },
      location: { type: 'string' },
      description: { type: 'string' },
      reminder_minutes: { type: 'array', items: { type: 'integer' } },
      participant_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },
  move_event: {
    type: 'object',
    required: ['event_id'],
    properties: {
      event_id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      starts_at: { type: 'string' },
      ends_at: { type: 'string' },
      location: { type: 'string' },
      description: { type: 'string' },
      reminder_minutes: { type: 'array', items: { type: 'integer' } },
      participant_ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
    },
  },
  record_number: {
    type: 'object',
    required: ['kpi_code', 'value'],
    properties: {
      kpi_code: kpiCode,
      value: { type: 'number' },
      date,
      period_date: date,
    },
  },
  set_target: {
    type: 'object',
    required: ['kpi_code', 'how_often'],
    properties: {
      kpi_code: kpiCode,
      org_slug: orgSlug,
      how_often: { type: 'string', description: 'Every day | Every week | Every month | Every quarter' },
      value: { type: 'number', description: 'Goal value for that cadence' },
      target: { type: 'number' },
    },
  },
  decide_escalation: {
    type: 'object',
    required: ['escalation_id'],
    properties: {
      escalation_id: { type: 'string', format: 'uuid' },
      decision: { type: 'string', description: 'Default accepted' },
    },
  },
  add_kpi: {
    type: 'object',
    required: ['org_slug', 'code', 'name'],
    properties: {
      org_slug: orgSlug,
      code: { type: 'string' },
      name: { type: 'string' },
      unit: { type: 'string' },
      how_often: { type: 'string' },
      cadence: { type: 'string' },
      target: { type: 'number' },
      direction: { type: 'string', enum: ['higher_is_better', 'lower_is_better'] },
    },
  },
  update_kpi: {
    type: 'object',
    properties: {
      org_slug: orgSlug,
      kpi_code: kpiCode,
      kpi_id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      unit: { type: 'string' },
      rationale: { type: 'string' },
    },
  },
  assign_kpi_owner: {
    type: 'object',
    properties: {
      org_slug: orgSlug,
      kpi_code: kpiCode,
      kpi_id: { type: 'string', format: 'uuid' },
      membership_id: { type: 'string', format: 'uuid' },
      person_id: { type: 'string', format: 'uuid' },
    },
  },
  retire_kpi: {
    type: 'object',
    properties: { org_slug: orgSlug, kpi_code: kpiCode, kpi_id: { type: 'string', format: 'uuid' } },
  },
  add_person: {
    type: 'object',
    required: ['org_slug'],
    properties: {
      org_slug: orgSlug,
      full_name: { type: 'string' },
      email: { type: 'string' },
      title: { type: 'string' },
      role: { type: 'string' },
      phone_e164: { type: 'string' },
      password: { type: 'string', minLength: 8 },
    },
  },
  add_unit: {
    type: 'object',
    required: ['parent_id', 'type', 'name'],
    properties: {
      parent_id: { type: 'string', format: 'uuid' },
      type: { type: 'string', enum: ['branch', 'department', 'team'] },
      name: { type: 'string' },
      short_name: { type: 'string' },
    },
  },
  update_person: {
    type: 'object',
    properties: {
      membership_id: { type: 'string', format: 'uuid' },
      person_id: { type: 'string', format: 'uuid' },
      full_name: { type: 'string' },
      email: { type: 'string' },
      title: { type: 'string' },
      phone_e164: { type: 'string' },
    },
  },
  remove_person: {
    type: 'object',
    properties: {
      membership_id: { type: 'string', format: 'uuid' },
      person_id: { type: 'string', format: 'uuid' },
    },
  },
  amend_number: {
    type: 'object',
    required: ['submission_id', 'value', 'reason'],
    properties: {
      submission_id: { type: 'string', format: 'uuid' },
      value: { type: 'number' },
      reason: { type: 'string', minLength: 1 },
    },
  },
  withdraw_submission: {
    type: 'object',
    required: ['submission_id'],
    properties: { submission_id: { type: 'string', format: 'uuid' } },
  },
  validate_submission: {
    type: 'object',
    required: ['submission_id', 'accept'],
    properties: {
      submission_id: { type: 'string', format: 'uuid' },
      accept: { type: 'boolean' },
      reason: { type: 'string', description: 'Required when accept is false' },
    },
  },
  lock_day: {
    type: 'object',
    required: ['org_slug'],
    properties: { org_slug: orgSlug, date, period_date: date },
  },
  reopen_day: {
    type: 'object',
    required: ['org_slug', 'reason'],
    properties: { org_slug: orgSlug, date, period_date: date, reason: { type: 'string', minLength: 1 } },
  },
  update_org: {
    type: 'object',
    required: ['org_slug'],
    properties: {
      org_slug: orgSlug,
      name: { type: 'string' },
      positioning: { type: 'string' },
      descriptor: { type: 'string' },
    },
  },
  update_me: {
    type: 'object',
    properties: { full_name: { type: 'string' }, phone_e164: { type: 'string' } },
  },
  list_projects: { type: 'object', properties: {} },
  list_tasks: {
    type: 'object',
    required: ['project_id'],
    properties: { project_id: { type: 'string', format: 'uuid' } },
  },
  my_tasks: { type: 'object', properties: {} },
  create_project: {
    type: 'object',
    required: ['name', 'unit_id'],
    properties: {
      name: { type: 'string' },
      unit_id: { type: 'string', format: 'uuid' },
      description: { type: 'string' },
      manager_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['planned', 'active', 'on_hold', 'done', 'cancelled'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      starts_on: date,
      due_on: date,
    },
  },
  create_task: {
    type: 'object',
    required: ['project_id', 'title'],
    properties: {
      project_id: { type: 'string', format: 'uuid' },
      title: { type: 'string' },
      description: { type: 'string' },
      assignee_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['todo', 'in_progress', 'in_review', 'done', 'cancelled'] },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      due_on: date,
    },
  },
  complete_task: {
    type: 'object',
    required: ['task_id'],
    properties: { task_id: { type: 'string', format: 'uuid' } },
  },
  comment_on_task: {
    type: 'object',
    required: ['task_id', 'body'],
    properties: {
      task_id: { type: 'string', format: 'uuid' },
      body: { type: 'string', minLength: 1 },
    },
  },
  post_project_update: {
    type: 'object',
    required: ['project_id', 'body'],
    properties: {
      project_id: { type: 'string', format: 'uuid' },
      body: { type: 'string', minLength: 1 },
    },
  },
  generate_report: {
    type: 'object',
    required: ['report_type'],
    properties: {
      report_type: {
        type: 'string',
        enum: ['kpi_performance', 'reporting', 'task_delivery', 'projects', 'workload', 'people', 'attendance', 'logins', 'my_work'],
        description: 'my_work = personal work report for a day/week/month',
      },
      from: { ...date, description: 'First day of the period (YYYY-MM-DD)' },
      to: { ...date, description: 'Last day of the period (YYYY-MM-DD)' },
      org_slug: { ...orgSlug, description: 'Optional: one organisation (owner)' },
      person_name: { type: 'string', description: 'Optional: report on one person (name)' },
      instructions: { type: 'string', description: 'Optional: what the reader wants to know' },
    },
  },
  clock_in: { type: 'object', properties: { note: { type: 'string' } } },
  clock_out: { type: 'object', properties: { note: { type: 'string' } } },
};

/** Permission hints for catalogue consumers (Phase 2 matrix will be authoritative). */
export const REQUIRES_BY_ACTION = {
  record_number: 'submission.record',
  amend_number: 'submission.amend',
  withdraw_submission: 'submission.withdraw',
  validate_submission: 'submission.review',
  lock_day: 'period.lock',
  reopen_day: 'period.reopen',
  set_target: 'kpi.target',
  add_kpi: 'kpi.create',
  update_kpi: 'kpi.update',
  assign_kpi_owner: 'kpi.assign',
  retire_kpi: 'kpi.retire',
  add_person: 'people.add',
  add_unit: 'units.add',
  update_person: 'people.update',
  remove_person: 'people.remove',
  update_org: 'org.update',
  update_me: 'account.update',
  decide_escalation: 'escalation.decide',
  add_event: 'calendar.edit',
  move_event: 'calendar.edit',
  create_project: 'project.edit',
  create_task: 'task.assign',
  post_project_update: 'project.edit',
  complete_task: 'task.complete',
  comment_on_task: 'task.comment',
  generate_report: 'report.generate',
  clock_in: 'attendance.self',
  clock_out: 'attendance.self',
};
