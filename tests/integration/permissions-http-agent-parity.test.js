import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { canRoleGate } from '../../packages/api/src/core/permissions/can.js';
import {
  MATRIX,
  PERMISSION_ACTIONS,
  ROLES,
} from '../../packages/api/src/core/permissions/matrix.js';
import { TOOL_TO_MATRIX_ACTION } from '../../packages/api/src/core/permissions/tool-matrix.js';
import { createEnv } from '../helpers/env.js';

/**
 * Representative HTTP mutation for a matrix action (role gate only; body may fail later).
 */
const HTTP_PROBE_BY_ACTION = {
  'submission.record': { method: 'post', path: '/submissions', body: { kpi_code: 'alpha.daily', value: 1 } },
  'submission.approve': { method: 'post', path: '/submissions/00000000-0000-0000-0000-000000000099/validate', body: { accept: true } },
  'submission.amend': { method: 'patch', path: '/submissions/00000000-0000-0000-0000-000000000099', body: { value: 2, reason: 'x' } },
  'day.lock': { method: 'post', path: '/orgs/alpha/signoff', body: {} },
  'day.reopen': { method: 'post', path: '/orgs/alpha/reopen', body: { period_date: '2099-01-01', reason: 'x' } },
  'kpi.edit': { method: 'post', path: '/orgs/alpha/kpis', body: { code: 'x.probe', name: 'Probe' } },
  'person.manage': { method: 'post', path: '/orgs/alpha/people', body: { full_name: 'X', email: 'x@test.local' } },
  'unit.manage': { method: 'post', path: '/units', body: { parent_id: '00000000-0000-0000-0000-000000000099', type: 'team', name: 'x' } },
  'invitation.create': { method: 'post', path: '/invitations', body: { email: 'inv@test.local' } },
  'calendar.event.create': {
    method: 'post',
    path: '/calendar/events',
    body: { title: 'x', starts_at: '2099-06-01T10:00:00.000Z', ends_at: '2099-06-01T11:00:00.000Z' },
  },
  'calendar.edit': { method: 'patch', path: '/calendar/events/00000000-0000-0000-0000-000000000099', body: { title: 'y' } },
  'project.edit': {
    method: 'post',
    path: '/projects',
    body: { name: 'Probe', unit_id: '00000000-0000-0000-0000-000000000099' },
  },
  'task.assign': {
    method: 'post',
    path: '/projects/00000000-0000-0000-0000-000000000099/tasks',
    body: { title: 'Probe task' },
  },
  'meeting.create': { method: 'post', path: '/meetings', body: { title: 'Probe', starts_at: '2099-06-01T10:00:00.000Z' } },
  'meeting.manage': { method: 'post', path: '/meetings/00000000-0000-0000-0000-000000000099/end', body: {} },
};

const AGENT_TOOL_BY_ACTION = {};
for (const [tool, action] of Object.entries(TOOL_TO_MATRIX_ACTION)) {
  if (!AGENT_TOOL_BY_ACTION[action]) AGENT_TOOL_BY_ACTION[action] = tool;
}

/** Documented asymmetric entry points (no HTTP+agent pair for same probe). */
const ASYMMETRIC_TOOLS = {
  assign_kpi_owner: 'agent',
  withdraw_submission: 'agent',
  update_org: 'agent',
  add_unit: 'agent',
  move_event: 'agent',
  retire_kpi: 'http',
  'POST /assignments': 'http',
};

let env;
before(async () => {
  env = await createEnv();
});
after(async () => {
  await env?.close();
});

const ROLE_FIXTURE = {
  owner: 'owner',
  manager: 'alphaManager',
  vice_manager: 'crossBranchManager',
  team_lead: 'alphaLead',
  member: 'alphaMember1',
};

for (const action of PERMISSION_ACTIONS) {
  test(`HTTP ∩ agent role gate parity: ${action}`, async () => {
    const httpProbe = HTTP_PROBE_BY_ACTION[action];
    const agentTool = AGENT_TOOL_BY_ACTION[action];
    assert.ok(httpProbe || agentTool, `probe missing for ${action}`);

    for (const role of ROLES) {
      const gate = canRoleGate({ role }, action);
      const membership = env.fx[ROLE_FIXTURE[role]];

      if (agentTool) {
        assert.equal(canRoleGate(membership, action), gate, `agent map ${role} ${agentTool}`);
        const agentRes = await env.http(membership).post('/agent/tools/portfolio_os', {
          action: agentTool,
          org_slug: 'alpha',
        });
        if (!gate) {
          assert.equal(agentRes.body?.error?.code, 'forbidden', `${role} ${agentTool}`);
        }
      }

      if (httpProbe) {
        const client = env.http(membership);
        const call = client[httpProbe.method] ?? client.post;
        const httpRes = await call(httpProbe.path, httpProbe.body);
        if (!gate) {
          assert.equal(httpRes.status, 403, `${role} ${action} http`);
          assert.equal(httpRes.body?.error?.code, 'forbidden');
        }
      }
    }
  });
}

test('documented HTTP-only / agent-only matrix paths', () => {
  assert.ok(ASYMMETRIC_TOOLS.assign_kpi_owner);
  assert.ok(TOOL_TO_MATRIX_ACTION.update_org === 'unit.manage');
});
