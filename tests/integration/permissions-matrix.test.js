import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionAllowed, getToolCatalog } from '../../packages/api/src/agent-tools.js';
import { TOOL_TO_MATRIX_ACTION } from '../../packages/api/src/core/permissions/tool-matrix.js';
import { can, canRoleGate } from '../../packages/api/src/core/permissions/can.js';
import {
  MATRIX,
  PERMISSION_ACTIONS,
  ROLES,
  matrixRoleAllows,
} from '../../packages/api/src/core/permissions/matrix.js';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const org = { id: 'cccccccc-cccc-cccc-cccc-cccccccccccc' };

/** @param {string} role */
function member(role, extra = {}) {
  return { id, role, org_id: org.id, ...extra };
}

/** Permissive resource hints so can() reflects matrix Y cells (not every Y* edge). */
const RESOURCE_FOR_ACTION = {
  'submission.record': { kpiOwnerId: id },
  'submission.approve': {},
  'submission.amend': {},
  'day.lock': {},
  'day.reopen': {},
  'kpi.edit': {},
  'person.manage': { org },
  'unit.manage': { org },
  'invitation.create': { org },
  'calendar.event.create': {},
  'calendar.edit': { isCreator: true },
  'project.edit': { unitOrgId: org.id },
  'task.assign': { unitOrgId: org.id },
  'meeting.create': {},
  'meeting.manage': { isHost: true },
};

/** Documented matrix expectations (role gate ± resource hints). */
const cases = [
  { role: 'owner', action: 'kpi.edit', expect: true },
  { role: 'manager', action: 'kpi.edit', expect: false },
  { role: 'vice_manager', action: 'kpi.edit', expect: false },
  { role: 'team_lead', action: 'kpi.edit', expect: false },
  { role: 'member', action: 'kpi.edit', expect: false },

  { role: 'owner', action: 'day.lock', expect: true },
  { role: 'manager', action: 'day.lock', expect: true },
  { role: 'vice_manager', action: 'day.lock', expect: false },
  { role: 'team_lead', action: 'day.lock', expect: false },
  { role: 'member', action: 'day.lock', expect: false },

  { role: 'owner', action: 'day.reopen', expect: true },
  { role: 'manager', action: 'day.reopen', expect: true },
  { role: 'vice_manager', action: 'day.reopen', expect: false },
  { role: 'team_lead', action: 'day.reopen', expect: false },
  { role: 'member', action: 'day.reopen', expect: false },

  { role: 'owner', action: 'submission.approve', expect: true },
  { role: 'manager', action: 'submission.approve', expect: true },
  { role: 'vice_manager', action: 'submission.approve', expect: true },
  { role: 'team_lead', action: 'submission.approve', expect: true },
  { role: 'member', action: 'submission.approve', expect: false },

  { role: 'member', action: 'submission.record', resource: { kpiOwnerId: id }, expect: true },
  { role: 'member', action: 'submission.record', resource: { kpiOwnerId: otherId }, expect: false },
  { role: 'manager', action: 'submission.record', resource: {}, expect: true },

  { role: 'owner', action: 'submission.amend', expect: true },
  { role: 'manager', action: 'submission.amend', expect: true },
  { role: 'vice_manager', action: 'submission.amend', expect: true },
  { role: 'team_lead', action: 'submission.amend', expect: true },
  { role: 'member', action: 'submission.amend', expect: true },

  { role: 'manager', action: 'person.manage', resource: { org }, expect: true },
  { role: 'team_lead', action: 'person.manage', resource: { org }, expect: false },
  { role: 'member', action: 'unit.manage', resource: { org }, expect: false },
  { role: 'vice_manager', action: 'invitation.create', resource: { org }, expect: true },

  { role: 'member', action: 'calendar.event.create', expect: true },
  { role: 'team_lead', action: 'calendar.edit', expect: false },
  { role: 'manager', action: 'calendar.edit', resource: { isCreator: true }, expect: true },
  { role: 'member', action: 'calendar.edit', resource: { isCreator: true }, expect: true },
  { role: 'member', action: 'calendar.edit', resource: {}, expect: false },

  { role: 'vice_manager', action: 'calendar.edit', resource: { eventOrgId: org.id }, expect: true },
  {
    role: 'manager',
    action: 'calendar.edit',
    resource: { eventOrgId: 'dddddddd-dddd-dddd-dddd-dddddddddddd' },
    expect: false,
  },
  { role: 'manager', action: 'calendar.edit', resource: { isCreator: false, eventOrgId: null }, expect: false },
  { role: 'manager', action: 'calendar.edit', resource: { isCreator: true, eventOrgId: null }, expect: true },
];

test('can() matches permissions matrix for fixture roles', () => {
  for (const { role, action, resource = {}, expect } of cases) {
    const m = member(role);
    assert.equal(
      can(m, action, resource),
      expect,
      `${role} ${action} ${JSON.stringify(resource)}`,
    );
  }
});

test('matrixRoleAllows for every documented cell', () => {
  let cells = 0;
  for (const action of PERMISSION_ACTIONS) {
    for (const role of ROLES) {
      const cell = MATRIX[action][role];
      const allowed = matrixRoleAllows(role, action);
      const expectAllowed = cell === 'Y' || cell === 'Y*';
      assert.equal(allowed, expectAllowed, `${role} ${action} cell=${cell}`);
      cells += 1;
    }
  }
  assert.equal(cells, 75, '15 actions × 5 roles');
});

test('can() role gate for Y cells with permissive resource hints', () => {
  let cells = 0;
  for (const action of PERMISSION_ACTIONS) {
    for (const role of ROLES) {
      const cell = MATRIX[action][role];
      if (cell !== 'Y') continue;
      const resource = RESOURCE_FOR_ACTION[action] ?? {};
      assert.equal(
        can(member(role), action, resource),
        true,
        `Y cell: ${role} ${action}`,
      );
      cells += 1;
    }
  }
  assert.equal(cells, 41, 'pure Y cells in 15×5 matrix');
});

test('can() denies N cells with permissive resource hints', () => {
  for (const action of PERMISSION_ACTIONS) {
    for (const role of ROLES) {
      if (MATRIX[action][role] !== 'N') continue;
      const resource = RESOURCE_FOR_ACTION[action] ?? {};
      assert.equal(can(member(role), action, resource), false, `${role} ${action}`);
    }
  }
});

test('every mapped write tool actionAllowed matches canRoleGate', () => {
  for (const role of ROLES) {
    for (const [tool, matrixAction] of Object.entries(TOOL_TO_MATRIX_ACTION)) {
      assert.equal(
        actionAllowed(role, tool),
        canRoleGate({ role }, matrixAction),
        `${role} ${tool}`,
      );
    }
  }
});

test('actionAllowed uses canRoleGate for mapped write tools', () => {
  const toolCases = [
    { role: 'member', tool: 'validate_submission', expect: false },
    { role: 'team_lead', tool: 'validate_submission', expect: true },
    { role: 'vice_manager', tool: 'lock_day', expect: false },
    { role: 'manager', tool: 'lock_day', expect: true },
    { role: 'owner', tool: 'reopen_day', expect: true },
    { role: 'member', tool: 'reopen_day', expect: false },
    { role: 'member', tool: 'amend_number', expect: true },
    { role: 'team_lead', tool: 'move_event', expect: false },
    { role: 'manager', tool: 'add_kpi', expect: false },
    { role: 'owner', tool: 'retire_kpi', expect: true },
    { role: 'vice_manager', tool: 'add_person', expect: true },
    { role: 'team_lead', tool: 'add_person', expect: false },
    { role: 'member', tool: 'record_number', expect: true },
    { role: 'member', tool: 'add_event', expect: true },
  ];
  for (const { role, tool, expect } of toolCases) {
    assert.equal(actionAllowed(role, tool), expect, `${role} ${tool}`);
    const matrixAction = TOOL_TO_MATRIX_ACTION[tool];
    if (matrixAction) {
      assert.equal(
        actionAllowed(role, tool),
        canRoleGate({ role }, matrixAction),
        `parity ${role} ${tool}`,
      );
    }
  }
});

test('Y* cells deny at role gate only when matrix says N', () => {
  assert.ok(matrixRoleAllows('member', 'submission.record'));
  assert.equal(matrixRoleAllows('member', 'submission.approve'), false);
  assert.equal(matrixRoleAllows('team_lead', 'calendar.edit'), false);
});

test('unknown action is denied', () => {
  assert.equal(can(member('owner'), 'not.a.real.action'), false);
  assert.equal(actionAllowed('owner', 'unknown_tool'), false);
});

test('catalogue mutating tools: allowed === actionAllowed(role)', () => {
  for (const role of ROLES) {
    const catalog = getToolCatalog(role);
    for (const tool of catalog.tools) {
      if (!tool.mutating) {
        assert.equal(tool.allowed, true, `${role} read ${tool.action}`);
        continue;
      }
      assert.equal(tool.allowed, actionAllowed(role, tool.action), `${role} ${tool.action}`);
    }
  }
});
