import crypto from 'crypto';
import { todayIn } from './core/dates.js';
import express from 'express';
import { authenticateRequest, loadMembership, signRunToken, signToken } from './auth.js';
import { config } from './core/config.js';
import { hashPassword, verifyPassword } from './core/passwords.js';
import { withSession, query } from './db.js';
import { dispatchAgentTool, getToolCatalog } from './agent-tools.js';
import { getWhatsAppSettings, startWhatsAppSession } from './whatsapp-sidecar.js';
import { showMe, updateMe } from './domain/account.js';
import {
  addKpi,
  assignKpiOwner,
  listKpisForOrg,
  retireKpi,
  setTargetByCode,
  updateKpiRegister,
} from './domain/kpis.js';
import { acceptInvitation, createInvitation, listInvitations } from './domain/invitations.js';
import { createOrg, listOrgs, listPeopleInOrg, showOrg, updateOrg } from './domain/orgs.js';
import { addPerson, removePerson, updatePerson } from './domain/people.js';
import { listScores } from './domain/scores.js';
import { lockDay, reopenDay } from './domain/signoffs.js';
import {
  amendNumber,
  listAmendments,
  listSubmissions,
  validateSubmission,
  withdrawSubmission,
} from './domain/submissions.js';
import {
  calendarFeed,
  createEvent,
  deleteEvent,
  icsToken,
  respondToEvent,
  toIcs,
  updateEvent,
  verifyIcsToken,
} from './modules/calendar.js';
import { overviewDashboard } from './modules/overview.js';
import {
  addParticipants,
  closeRoom,
  createMeeting,
  decideActionItem,
  deleteMeeting,
  endMeeting,
  getMeeting,
  handleLivekitEvent,
  issueJoinToken,
  listInvitees,
  listMeetings,
  requestSummary,
} from './modules/meetings/index.js';
import { listNotifications, markNotificationsRead } from './modules/notifications.js';
import { appendTranscript, ensureBot, getTranscript } from './modules/meetings/assistant.js';
import { verifyWebhook as verifyLivekitWebhook } from './modules/meetings/livekit.js';
import {
  drillDown,
  meDashboard,
  ownerDashboard,
  projectDashboard,
  reportsSummary,
  measuresToCsv,
  unitDashboard,
  formatDigestBody,
  ownerDigestSnapshot,
} from './modules/dashboards/index.js';
import './jobs/digest.js';
import { createAssignment } from './domain/assignments.js';
import { attendanceStatus, clock, recordAuthEvent } from './modules/attendance.js';
import {
  createReport,
  deleteReport,
  exportReport,
  getReport,
  listReports,
  reportOptions,
  retryReport,
  runReport,
  submitReport,
} from './modules/reports/index.js';
import { createUnit, listUnitTree, updateUnit } from './modules/units.js';
import { requireFeature } from './core/permissions/can.js';
import { requireRoleGate } from './core/permissions/require-permission.js';
import { rateLimitLogin, respondIfRateLimited, maxAgent, maxLogin } from './middleware/rate-limit.js';
import { listAuditLog } from './modules/commercial/audit.js';
import { currentEntitlement, listPlans, provisionEntitlement } from './modules/commercial/entitlements.js';
import { applyOnboarding, importCsvDryRun } from './modules/commercial/onboarding.js';
import {
  enqueueExport,
  getExportJob,
  requestDeletion,
} from './modules/commercial/portability.js';
import { bumpUsage, getWorkspaceUsage } from './modules/commercial/usage.js';
import './modules/commercial/portability.js';
import { notePermissionCheck } from './core/permissions/permission-audit.js';
import { TOOL_TO_MATRIX_ACTION } from './core/permissions/tool-matrix.js';
import {
  commentOnTask,
  completeTask,
  createComment,
  createMilestone,
  createProject,
  createTask,
  getProject,
  listComments,
  listMilestones,
  listProjectActivity,
  listProjectUpdates,
  listProjects,
  listTasks,
  myWork,
  postProjectUpdate,
  updateMilestone,
  updateProject,
  updateTask,
} from './modules/projects.js';
import { createCheckoutSession, billingWebhook } from './modules/billing.js';
import {
  handleLinkRequested,
  handlePaused,
  inviteOwner,
  queueQlixProvision,
  queueQlixProvisionFor,
  qlixStatus,
  runnerCredentials,
  revealOwnerLogin,
  saveConversationId,
  setOwnerPassword,
  verifyQlixSignature,
  workspaceQlixState,
} from './modules/qlix/provision.js';
import {
  addTaskDependency,
  calendarIntegrationStatus,
  connectCalendar,
  createAttachment,
  createProjectTemplate,
  createSavedView,
  deleteSavedView,
  getAttachment,
  instantiateProjectTemplate,
  listProjectTemplates,
  listSavedViews,
  projectDependencyGraph,
  removeTaskDependency,
  scheduleCalendarSync,
  workloadByUnit,
} from './modules/expansion.js';
function domainHttpStatus(error) {
  if (error.code === 'forbidden') return 403;
  if (error.code === 'not_found') return 404;
  if (error.code === 'conflict') return 409;
  if (error.code === 'locked') return 423;
  return 400;
}

const scoped = (req, fn) => withSession(req.auth.membership, fn);

/** New workspace: queue its Qlix org + agents. Never blocks or fails the signup itself. */
function provisionQlixLater(session) {
  const workspaceId = session?.membership?.workspace_id;
  if (!workspaceId) return;
  queueQlixProvisionFor(workspaceId).catch((e) => {
    if (process.env.NODE_ENV !== 'test') console.error('[qlix] could not queue provisioning', workspaceId, e.message);
  });
}

/** Background/service work (digest, outbox): the 'system' scope, which only service routes can open. */
const withSystem = (workspaceId, fn) =>
  withSession({ id: '00000000-0000-0000-0000-000000000000', role: 'system', org_id: null, workspace_id: workspaceId }, fn);

const CONNECTOR_ID = () => process.env.WA_CONNECTOR_ID ?? '';

function serviceSecretOk(value) {
  const expected = Buffer.from(config.runnerSecret);
  const given = Buffer.from(String(value ?? ''));
  return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function adminSecretOk(req) {
  const expected = process.env.PORTFOLIO_ADMIN_SECRET;
  if (!expected || expected.length < 8) return false;
  const given = String(req.headers['x-admin-secret'] ?? '');
  if (given.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function registeredPhoneCount() {
  if (!CONNECTOR_ID()) return 0;
  const { rows } = await query(`SELECT count(*)::int AS c FROM auth.registered_phones($1)`, [CONNECTOR_ID()]);
  return rows[0]?.c ?? 0;
}

function sendDomain(res, result) {
  if (result?.error) return res.status(domainHttpStatus(result.error)).json(result);
  return res.json(result);
}

async function roleGateDeny(membership, action, meta = { channel: 'http' }) {
  const denied = requireRoleGate(membership, action);
  if (denied) {
    await withSession(membership, (c) => notePermissionCheck(c, membership, action, false, meta));
  }
  return denied;
}

/** Mutating route: matrix role gate, then scoped domain work (domain re-checks with full `can()`). */
async function gatedMutate(req, res, action, work) {
  const denied = await roleGateDeny(req.auth.membership, action);
  if (denied) return sendDomain(res, denied);
  sendDomain(res, await scoped(req, work));
}

/** Express 4 ignores rejected async handlers; forward them to the error middleware instead. */
function catchAsync(router) {
  for (const method of ['use', 'get', 'post', 'patch', 'put', 'delete']) {
    const original = router[method].bind(router);
    router[method] = (...args) =>
      original(
        ...args.map((arg) =>
          typeof arg === 'function' && arg.length < 4
            ? (req, res, next) => Promise.resolve(arg(req, res, next)).catch(next)
            : arg,
        ),
      );
  }
  return router;
}

export function createRouter() {
  const router = catchAsync(express.Router());

  router.post('/auth/login', rateLimitLogin, async (req, res) => {
    const { email, password } = req.body ?? {};
    const invalid = () => res.status(401).json({ error: { code: 'unauthorized', message: 'Email or password is incorrect.' } });
    if (!email || !password) return invalid();
    const { rows } = await query(`SELECT * FROM auth.login_candidate($1)`, [email]);
    const user = rows[0];
    if (!user || user.status !== 'active' || !user.password_hash) return invalid();
    const check = await verifyPassword(password, user.password_hash);
    if (!check.ok) return invalid();
    if (check.needsUpgrade) {
      await query(`SELECT auth.upgrade_password_hash($1, $2, $3)`, [
        user.user_id,
        user.password_hash,
        await hashPassword(password),
      ]);
    }
    const wanted = /^[0-9a-f-]{36}$/i.test(String(req.body?.workspace_id ?? '')) ? req.body.workspace_id : null;
    const { rows: primary } = await query(`SELECT auth.primary_membership($1, $2) AS id`, [user.user_id, wanted]);
    const membership = primary[0]?.id ? await loadMembership(primary[0].id) : null;
    if (!membership) return res.status(403).json({ error: { code: 'forbidden', message: 'This account has no active role.' } });
    const { rows: workspaces } = await query(`SELECT * FROM auth.workspaces_for_user($1)`, [user.user_id]);
    await bumpUsage(membership.workspace_id, membership.workspace_timezone, 'active_users', 1);
    await recordAuthEvent(membership.id, 'login', { userAgent: req.headers['user-agent'] ?? null });
    res.json({ token: signToken(membership), membership, workspaces });
  });

  /** Workspaces the signed-in person belongs to (for the switcher). */
  router.get('/auth/workspaces', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { rows } = await query(`SELECT * FROM auth.workspaces_for_user($1)`, [auth.membership.user_id]);
    res.json({ workspaces: rows, current: auth.membership.workspace_id });
  });

  /** Switch to another workspace the person belongs to: a fresh token for that workspace. */
  router.post('/admin/workspaces/:id/entitlements', async (req, res) => {
    const workspaceId = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) {
      return res.status(400).json({ error: { code: 'invalid', message: 'workspace id required' } });
    }
    if (!adminSecretOk(req)) {
      return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
    sendDomain(
      res,
      await withSystem(workspaceId, (c) =>
        provisionEntitlement(c, { role: 'system', workspace_id: workspaceId }, workspaceId, req.body, { admin: true }),
      ),
    );
  });

  router.post('/auth/switch', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const target = String(req.body?.workspace_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(target)) return res.status(400).json({ error: { code: 'invalid', message: 'workspace_id required' } });
    const { rows } = await query(`SELECT auth.primary_membership($1, $2) AS id`, [auth.membership.user_id, target]);
    const membership = rows[0]?.id ? await loadMembership(rows[0].id) : null;
    if (!membership) return res.status(403).json({ error: { code: 'forbidden', message: 'You are not a member of that workspace.' } });
    await recordAuthEvent(membership.id, 'switch', { userAgent: req.headers['user-agent'] ?? null });
    res.json({ token: signToken(membership), membership });
  });

  /*
   * Self-serve workspaces (migration 022). Sign-up creates a person plus their first workspace;
   * a signed-in person can open more. Both answer with a token scoped to the new workspace.
   */
  const WORKSPACE_ERRORS = {
    email_invalid: [400, 'Enter a valid work email.'],
    email_taken: [409, 'An account with this email already exists. Sign in instead.'],
    name_required: [400, 'Enter your full name.'],
    password_required: [400, 'Choose a password.'],
    workspace_name_required: [400, 'Name your workspace (at least 2 characters).'],
    workspace_limit: [409, 'You already own the maximum of 10 workspaces.'],
    user_inactive: [403, 'This account is not active.'],
  };
  function workspaceError(res, err) {
    const hit = Object.entries(WORKSPACE_ERRORS).find(([code]) => String(err?.message ?? '').includes(code));
    if (!hit) throw err;
    const [code, [status, message]] = hit;
    return res.status(status).json({ error: { code, message } });
  }
  async function sessionFor(membershipId, userId) {
    const membership = await loadMembership(membershipId);
    const { rows: workspaces } = await query(`SELECT * FROM auth.workspaces_for_user($1)`, [userId ?? membership.user_id]);
    await bumpUsage(membership.workspace_id, membership.workspace_timezone, 'active_users', 1);
    await recordAuthEvent(membership.id, 'login');
    return { token: signToken(membership), membership, workspaces };
  }

  router.post('/auth/signup', rateLimitLogin, async (req, res) => {
    const { full_name, email, password, workspace_name, timezone } = req.body ?? {};
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: { code: 'password_short', message: 'Password must be at least 8 characters.' } });
    }
    let membershipId;
    try {
      const { rows } = await query(`SELECT auth.signup($1, $2, $3, $4, $5) AS id`, [
        full_name ?? '',
        email ?? '',
        await hashPassword(password),
        workspace_name ?? '',
        timezone || 'Asia/Kolkata',
      ]);
      membershipId = rows[0].id;
    } catch (err) {
      return workspaceError(res, err);
    }
    const session = await sessionFor(membershipId);
    provisionQlixLater(session);
    res.status(201).json(session);
  });

  /** Open a new workspace as the signed-in person (they become its owner) and switch into it. */
  router.post('/auth/workspaces', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { name, timezone } = req.body ?? {};
    let membershipId;
    try {
      const { rows } = await query(`SELECT auth.create_workspace($1, $2, $3) AS id`, [
        auth.membership.user_id,
        name ?? '',
        timezone || auth.membership.workspace_timezone || 'Asia/Kolkata',
      ]);
      membershipId = rows[0].id;
    } catch (err) {
      return workspaceError(res, err);
    }
    const session = await sessionFor(membershipId, auth.membership.user_id);
    provisionQlixLater(session);
    res.status(201).json(session);
  });

  router.use(async (req, res, next) => {
    if (
      [
        '/auth/login',
        '/auth/signup',
        '/auth/workspaces',
        '/auth/switch',
        '/agent/runs',
        '/agent/qlix/conversation',
        '/qlix/webhook',
        '/livekit/webhook',
        '/internal/meetings/transcript',
        '/digest/run',
        '/calendar.ics',
        '/billing/webhook',
      ].includes(req.path) ||
      /^\/admin\/workspaces\/[^/]+\/entitlements$/.test(req.path) ||
      /^\/invitations\/[^/]+\/accept$/.test(req.path)
    ) {
      return next();
    }
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    req.auth = auth;
    next();
  });

  router.get('/units', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listUnitTree(c, req.auth.membership)));
  });

  router.get('/units/tree', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listUnitTree(c, req.auth.membership)));
  });

  router.post('/units', async (req, res) =>
    gatedMutate(req, res, 'unit.manage', (c) => createUnit(c, req.auth.membership, req.body)),
  );

  router.patch('/units/:id', async (req, res) =>
    gatedMutate(req, res, 'unit.manage', (c) => updateUnit(c, req.auth.membership, req.params.id, req.body)),
  );

  router.post('/assignments', async (req, res) =>
    gatedMutate(req, res, 'person.manage', (c) => createAssignment(c, req.auth.membership, req.body)),
  );

  router.post('/invitations', async (req, res) =>
    gatedMutate(req, res, 'invitation.create', (c) => createInvitation(c, req.auth.membership, req.body)),
  );

  router.get('/invitations', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listInvitations(c, req.auth.membership)));
  });

  router.post('/invitations/:id/accept', async (req, res) => {
    sendDomain(res, await acceptInvitation(req.params.id, req.body));
  });

  router.get('/orgs', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listOrgs(c, req.auth.membership)));
  });

  router.post('/orgs', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => createOrg(c, req.auth.membership, req.body)));
  });

  router.get('/orgs/:slug', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => showOrg(c, req.auth.membership, req.params.slug)));
  });

  router.get('/orgs/:slug/kpis', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listKpisForOrg(c, req.auth.membership, req.params.slug)));
  });

  router.get('/orgs/:slug/people', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listPeopleInOrg(c, req.auth.membership, req.params.slug)));
  });

  router.patch('/orgs/:slug', async (req, res) =>
    gatedMutate(req, res, 'unit.manage', (c) => updateOrg(c, req.auth.membership, req.params.slug, req.body)),
  );

  router.post('/orgs/:slug/kpis', async (req, res) =>
    gatedMutate(req, res, 'kpi.edit', (c) => addKpi(c, req.auth.membership, req.params.slug, req.body)),
  );

  router.patch('/kpis/:id', async (req, res) => {
    const { name, unit, how_often, cadence, target, goals, rollup_method, owner_id: nextOwnerId } = req.body ?? {};
    const wantsRegisterEdit =
      rollup_method !== undefined ||
      goals !== undefined ||
      name !== undefined ||
      unit !== undefined ||
      how_often !== undefined ||
      cadence !== undefined ||
      target !== undefined;
    const wantsOwnerEdit = nextOwnerId !== undefined;
    if (!wantsRegisterEdit && !wantsOwnerEdit) {
      return res.status(400).json({ error: { message: 'Nothing to update.' } });
    }
    if (wantsRegisterEdit) {
      const denied = await roleGateDeny(req.auth.membership, 'kpi.edit');
      if (denied) return sendDomain(res, denied);
    }
    if (wantsOwnerEdit) {
      const denied = await roleGateDeny(req.auth.membership, 'person.manage');
      if (denied) return sendDomain(res, denied);
    }
    const result = await scoped(req, async (c) => {
      let out = null;
      if (wantsRegisterEdit) {
        out = await updateKpiRegister(c, req.auth.membership, req.params.id, req.body);
        if (out.error) return out;
      }
      if (wantsOwnerEdit) {
        out = await assignKpiOwner(c, req.auth.membership, req.params.id, { owner_id: nextOwnerId });
      }
      return out;
    });
    sendDomain(res, result);
  });

  router.delete('/kpis/:id', async (req, res) =>
    gatedMutate(req, res, 'kpi.edit', (c) => retireKpi(c, req.auth.membership, req.params.id)),
  );

  router.post('/orgs/:slug/people', async (req, res) =>
    gatedMutate(req, res, 'person.manage', (c) => addPerson(c, req.auth.membership, req.params.slug, req.body)),
  );

  router.patch('/people/:id', async (req, res) =>
    gatedMutate(req, res, 'person.manage', (c) => updatePerson(c, req.auth.membership, req.params.id, req.body)),
  );

  router.delete('/people/:id', async (req, res) =>
    gatedMutate(req, res, 'person.manage', (c) => removePerson(c, req.auth.membership, req.params.id)),
  );

  router.patch('/submissions/:id', async (req, res) =>
    gatedMutate(req, res, 'submission.amend', (c) =>
      amendNumber(c, req.auth.membership, req.params.id, req.body?.value, req.body?.reason),
    ),
  );

  router.get('/submissions/:id/amendments', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listAmendments(c, req.auth.membership, req.params.id)));
  });

  router.delete('/submissions/:id', async (req, res) =>
    gatedMutate(req, res, 'submission.amend', (c) => withdrawSubmission(c, req.auth.membership, req.params.id)),
  );

  router.post('/kpis/target', async (req, res) => {
    const { kpi_code, target, how_often } = req.body ?? {};
    return gatedMutate(req, res, 'kpi.edit', async (c) => {
      const out = await setTargetByCode(c, req.auth.membership, {
        kpi_code,
        how_often,
        value: target,
        reason: 'set from dashboard',
      });
      if (out.error) return out;
      return { ok: true, kpi_code, how_often: out.how_often, target: out.value, goals: out.goals };
    });
  });

  router.get('/readiness', async (req, res) => {
    const { membership } = req.auth;
    if (membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Owner only' } });
    }
    const out = await scoped(req, async (c) => {
      const { rows: unnamed } = await c.query(
        `SELECT o.slug, count(*)::int AS c FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.state = 'pending_name' GROUP BY o.slug`,
      );
      const { rows: nullTargets } = await c.query(
        `SELECT o.slug, count(*)::int AS c FROM kpis k JOIN organisations o ON o.id = k.org_id WHERE k.target IS NULL AND k.unmeasured = false AND k.status = 'active' GROUP BY o.slug`,
      );
      return { unnamed_by_org: unnamed, null_targets_by_org: nullTargets };
    });
    res.json(out);
  });

  router.get('/submissions', async (req, res) => {
    const date = req.query.date ?? todayIn();
    sendDomain(
      res,
      await scoped(req, (c) => listSubmissions(c, req.auth.membership, { org_slug: req.query.org, date })),
    );
  });

  router.post('/submissions', async (req, res) => {
    const { membership } = req.auth;
    const denied = await roleGateDeny(membership, 'submission.record');
    if (denied) return sendDomain(res, denied);
    const { kpi_code, value, period_date } = req.body ?? {};
    const out = await withSession(membership, (client) =>
      dispatchAgentTool(
        client,
        membership,
        { action: 'record_number', kpi_code, value, period_date, channel: 'web', _headers: req.headers },
        async () => {},
      ),
    );
    sendDomain(res, out);
  });

  router.post('/submissions/:id/validate', async (req, res) =>
    gatedMutate(req, res, 'submission.approve', (c) =>
      validateSubmission(c, req.auth.membership, req.params.id, req.body),
    ),
  );

  router.post('/orgs/:slug/signoff', async (req, res) => {
    const period = req.body?.period_date ?? todayIn();
    return gatedMutate(req, res, 'day.lock', (c) => lockDay(c, req.auth.membership, req.params.slug, period));
  });

  router.post('/orgs/:slug/reopen', async (req, res) => {
    const { period_date, reason } = req.body ?? {};
    return gatedMutate(req, res, 'day.reopen', (c) =>
      reopenDay(c, req.auth.membership, req.params.slug, period_date, reason),
    );
  });

  router.get('/scores', async (req, res) => {
    sendDomain(
      res,
      await scoped(req, (c) =>
        listScores(c, req.auth.membership, {
          org_slug: req.query.org,
          from: req.query.from,
          to: req.query.to,
        }),
      ),
    );
  });

  router.get('/dashboards/overview', async (req, res) => {
    const date = typeof req.query.date === 'string' ? req.query.date : undefined;
    sendDomain(res, await scoped(req, (c) => overviewDashboard(c, req.auth.membership, date)));
  });

  router.get('/dashboards/owner', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => ownerDashboard(c, req.auth.membership, req.query)));
  });

  router.get('/dashboards/unit/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => unitDashboard(c, req.auth.membership, req.params.id, req.query)));
  });

  router.get('/dashboards/project/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => projectDashboard(c, req.auth.membership, req.params.id, req.query)));
  });

  router.get('/dashboards/me', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => meDashboard(c, req.auth.membership, req.query)));
  });

  router.get('/dashboards/drill-down', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => drillDown(c, req.auth.membership, req.query)));
  });

  router.get('/reports/summary', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => reportsSummary(c, req.auth.membership, req.query)));
  });

  router.get('/reports/export.csv', async (req, res) => {
    const payload = await scoped(req, (c) => reportsSummary(c, req.auth.membership, req.query));
    if (payload?.error) {
      return sendDomain(res, payload);
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="portfolio-reports.csv"');
    res.send(measuresToCsv(payload));
  });

  /* Reports section (docs/REPORTS.md): pick a type, scope and period; the API computes the
     figures, the Qlix agent drafts the narrative, the page renders and exports it. */
  router.get('/reports/options', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => reportOptions(c, req.auth.membership)));
  });

  router.get('/reports/generated', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listReports(c, req.auth.membership)));
  });

  router.post('/reports/generated', async (req, res) => {
    const { membership } = req.auth;
    const out = await scoped(req, (c) => createReport(c, membership, req.body ?? {}, { channel: 'web' }));
    if (out.error) return sendDomain(res, out);
    setImmediate(() => runReport(out.report.id, membership.id));
    res.status(202).json(out);
  });

  router.get('/reports/generated/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getReport(c, req.auth.membership, req.params.id)));
  });

  router.post('/reports/generated/:id/submit', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => submitReport(c, req.auth.membership, req.params.id)));
  });

  router.post('/reports/generated/:id/retry', async (req, res) => {
    const { membership } = req.auth;
    const out = await scoped(req, (c) => retryReport(c, membership, req.params.id));
    if (out.error) return sendDomain(res, out);
    setImmediate(() => runReport(req.params.id, membership.id));
    res.status(202).json(out);
  });

  router.delete('/reports/generated/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => deleteReport(c, req.auth.membership, req.params.id)));
  });

  router.get('/reports/generated/:id/export.:format', async (req, res) => {
    const format = req.params.format === 'xlsx' ? 'xlsx' : 'csv';
    const out = await scoped(req, (c) => exportReport(c, req.auth.membership, req.params.id, format));
    if (out.error) return sendDomain(res, out);
    res.setHeader('content-type', out.contentType);
    res.setHeader('content-disposition', `attachment; filename="${out.filename}"`);
    res.send(out.body);
  });

  router.get('/attendance/today', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => attendanceStatus(c, req.auth.membership)));
  });

  router.post('/attendance/clock', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => clock(c, req.auth.membership, req.body ?? {}, 'web')));
  });

  router.post('/auth/logout', async (req, res) => {
    await recordAuthEvent(req.auth.membership.id, 'logout', { userAgent: req.headers['user-agent'] ?? null });
    res.json({ ok: true });
  });

  router.get('/calendar', async (req, res) => {
    sendDomain(
      res,
      await scoped(req, (c) =>
        calendarFeed(c, req.auth.membership, { from: req.query.from, to: req.query.to }),
      ),
    );
  });

  router.get('/calendar/ics-token', async (req, res) => {
    res.json({ token: icsToken(req.auth.membership) });
  });

  router.get('/calendar.ics', async (req, res, next) => {
    try {
      const payload = verifyIcsToken(req.query.token);
      const membership = await loadMembership(payload.membership_id);
      if (!membership || membership.workspace_id !== payload.workspace_id) {
        return res.status(401).send('Invalid or expired link');
      }
      const feed = await withSession(membership, (c) =>
        calendarFeed(c, membership, {
          from: req.query.from,
          to: req.query.to,
        }),
      );
      if (feed.error) return res.status(400).send(feed.error.message);
      res.setHeader('content-type', 'text/calendar; charset=utf-8');
      res.setHeader('content-disposition', 'attachment; filename="portfolio.ics"');
      res.send(toIcs(feed, membership.workspace_name));
    } catch (e) {
      next(e);
    }
  });

  router.post('/calendar/events', async (req, res) =>
    gatedMutate(req, res, 'calendar.event.create', (c) => createEvent(c, req.auth.membership, req.body)),
  );

  router.patch('/calendar/events/:id', async (req, res) =>
    gatedMutate(req, res, 'calendar.edit', (c) => updateEvent(c, req.auth.membership, req.params.id, req.body)),
  );

  router.delete('/calendar/events/:id', async (req, res) =>
    gatedMutate(req, res, 'calendar.edit', (c) => deleteEvent(c, req.auth.membership, req.params.id)),
  );

  // Notifications (the bell) ----------------------------------------------------------------
  router.get('/notifications', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listNotifications(c, req.auth.membership, { limit: req.query.limit })));
  });

  router.post('/notifications/read', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => markNotificationsRead(c, req.auth.membership, req.body)));
  });

  // Meetings (docs/MEETINGS.md) ------------------------------------------------------------
  router.get('/meetings', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listMeetings(c, req.auth.membership)));
  });

  router.post('/meetings', async (req, res) =>
    gatedMutate(req, res, 'meeting.create', (c) => createMeeting(c, req.auth.membership, req.body)),
  );

  // Who the caller can invite (people, teams, organisations): before /meetings/:id.
  router.get('/meetings/invitees', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listInvitees(c, req.auth.membership)));
  });

  router.get('/meetings/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getMeeting(c, req.auth.membership, req.params.id)));
  });

  router.delete('/meetings/:id', async (req, res) =>
    gatedMutate(req, res, 'meeting.manage', (c) => deleteMeeting(c, req.auth.membership, req.params.id)),
  );

  // Joining is allowed to anyone who can see the meeting (RLS), so no role gate here.
  router.post('/meetings/:id/token', async (req, res) => {
    const result = await scoped(req, (c) => issueJoinToken(c, req.auth.membership, req.params.id));
    // The Meeting Assistant's bot joins with the first person (no-op if it is already there).
    if (!result?.error && result.qlix_enabled) ensureBot({ room: result.room, meetingId: result.meeting_id });
    sendDomain(res, result);
  });

  router.get('/meetings/:id/transcript', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getTranscript(c, req.auth.membership, req.params.id)));
  });

  router.post('/meetings/:id/participants', async (req, res) =>
    gatedMutate(req, res, 'meeting.manage', (c) => addParticipants(c, req.auth.membership, req.params.id, req.body)),
  );

  router.post('/meetings/:id/action-items/:index', async (req, res) =>
    gatedMutate(req, res, 'meeting.manage', (c) =>
      decideActionItem(c, req.auth.membership, req.params.id, req.params.index, req.body),
    ),
  );

  router.post('/meetings/:id/summary', async (req, res) =>
    gatedMutate(req, res, 'meeting.manage', (c) => requestSummary(c, req.auth.membership, req.params.id)),
  );

  // The meeting bot posts what it heard (service secret; the room name identifies the meeting).
  router.post('/internal/meetings/transcript', async (req, res) => {
    if (!serviceSecretOk(req.headers['x-service-secret'])) {
      return res.status(401).json({ error: { message: 'Invalid service secret' } });
    }
    sendDomain(res, await appendTranscript(req.body ?? {}));
  });

  router.post('/meetings/:id/end', async (req, res) => {
    const denied = await roleGateDeny(req.auth.membership, 'meeting.manage');
    if (denied) return sendDomain(res, denied);
    const result = await scoped(req, (c) => endMeeting(c, req.auth.membership, req.params.id));
    if (!result?.error) await closeRoom(result.room);
    if (result && !result.error) delete result.room;
    sendDomain(res, result);
  });

  // LiveKit posts room/participant events here, signed with the LiveKit API secret.
  router.post('/livekit/webhook', express.text({ type: 'application/webhook+json', limit: '256kb' }), async (req, res) => {
    const raw = typeof req.body === 'string' ? req.body : req.rawBody;
    const event = verifyLivekitWebhook(raw, req.headers.authorization);
    if (!event) return res.status(401).json({ error: { code: 'bad_signature', message: 'Invalid signature' } });
    await handleLivekitEvent(event);
    res.json({ ok: true });
  });

  router.get('/projects', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listProjects(c, req.auth.membership)));
  });

  router.post('/projects', async (req, res) => {
    const featDenied = requireFeature(req.auth.membership, 'projects');
    if (featDenied) return sendDomain(res, featDenied);
    return gatedMutate(req, res, 'project.edit', (c) => createProject(c, req.auth.membership, req.body));
  });

  router.get('/projects/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getProject(c, req.auth.membership, req.params.id)));
  });

  router.patch('/projects/:id', async (req, res) =>
    gatedMutate(req, res, 'project.edit', (c) => updateProject(c, req.auth.membership, req.params.id, req.body)),
  );

  router.get('/projects/:id/tasks', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listTasks(c, req.auth.membership, req.params.id)));
  });

  router.post('/projects/:id/tasks', async (req, res) =>
    gatedMutate(req, res, 'task.assign', (c) => createTask(c, req.auth.membership, req.params.id, req.body)),
  );

  router.patch('/tasks/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => updateTask(c, req.auth.membership, req.params.id, req.body)));
  });

  router.get('/projects/:id/milestones', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listMilestones(c, req.auth.membership, req.params.id)));
  });

  router.post('/projects/:id/milestones', async (req, res) =>
    gatedMutate(req, res, 'project.edit', (c) => createMilestone(c, req.auth.membership, req.params.id, req.body)),
  );

  router.patch('/milestones/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => updateMilestone(c, req.auth.membership, req.params.id, req.body)));
  });

  router.get('/comments', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listComments(c, req.auth.membership, req.query)));
  });

  router.post('/comments', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => createComment(c, req.auth.membership, req.body)));
  });

  router.get('/projects/:id/updates', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listProjectUpdates(c, req.auth.membership, req.params.id)));
  });

  router.post('/projects/:id/updates', async (req, res) =>
    gatedMutate(req, res, 'project.edit', (c) => postProjectUpdate(c, req.auth.membership, req.params.id, req.body)),
  );

  router.get('/projects/:id/activity', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listProjectActivity(c, req.auth.membership, req.params.id)));
  });

  router.get('/my-work', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => myWork(c, req.auth.membership)));
  });

  router.post('/calendar/events/:id/respond', async (req, res) => {
    const response = req.body?.response;
    sendDomain(res, await scoped(req, (c) => respondToEvent(c, req.auth.membership, req.params.id, response)));
  });

  router.get('/me', async (req, res) => {
    sendDomain(res, await showMe(req.auth.membership.id));
  });

  router.patch('/me', async (req, res) => {
    const out = await withSession(req.auth.membership, (client) =>
      updateMe(client, req.auth.membership, req.body),
    );
    sendDomain(res, out);
  });

  const OWNER_WEB_AGENT = 'portfolio-owner-agent';

  function chatTitle(messages) {
    if (!Array.isArray(messages)) return 'New chat';
    const first = messages.find((item) => item.role === 'user' && item.content);
    if (!first) return 'New chat';
    const text = String(first.content).trim();
    return text.length > 56 ? `${text.slice(0, 56)}…` : text;
  }

  async function loadOwnerWebSession(client, membershipId, sessionId) {
    if (sessionId) {
      if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
      const { rows } = await client.query(
        `SELECT id, context FROM agent_sessions
         WHERE id = $1 AND membership_id = $2 AND agent = $3 AND channel = 'web'`,
        [sessionId, membershipId, OWNER_WEB_AGENT],
      );
      return rows[0] ?? null;
    }
    const { rows } = await client.query(
      `SELECT id, context FROM agent_sessions
       WHERE membership_id = $1 AND agent = $2 AND channel = 'web'
       ORDER BY last_seen_at DESC LIMIT 1`,
      [membershipId, OWNER_WEB_AGENT],
    );
    return rows[0] ?? null;
  }

  async function createOwnerWebSession(client, membershipId) {
    const inserted = await client.query(
      `INSERT INTO agent_sessions (membership_id, agent, channel, context)
       VALUES ($1, $2, 'web', '{"messages":[]}'::jsonb) RETURNING id, context, last_seen_at`,
      [membershipId, OWNER_WEB_AGENT],
    );
    return inserted.rows[0];
  }

  router.get('/agent/chat/sessions', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'The agent tab is for the owner.' } });
    }
    const { rows } = await scoped(req, (c) => c.query(
      `SELECT id, context, last_seen_at FROM agent_sessions
       WHERE membership_id = $1 AND agent = $2 AND channel = 'web'
       ORDER BY last_seen_at DESC LIMIT 40`,
      [req.auth.membership.id, OWNER_WEB_AGENT],
    ));
    res.json({
      sessions: rows.map((row) => {
        const messages = Array.isArray(row.context?.messages) ? row.context.messages : [];
        const last = messages[messages.length - 1];
        return {
          id: row.id,
          title: chatTitle(messages),
          last_seen_at: row.last_seen_at,
          preview: last?.content ? String(last.content).slice(0, 80) : '',
          message_count: messages.length,
        };
      }),
    });
  });

  router.post('/agent/chat/sessions', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'The agent tab is for the owner.' } });
    }
    const session = await scoped(req, (c) => createOwnerWebSession(c, req.auth.membership.id));
    res.status(201).json({ session_id: session.id, messages: [] });
  });

  router.get('/agent/chat', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'The agent tab is for the owner.' } });
    }
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;
    const session = await scoped(req, async (c) => {
      const found = await loadOwnerWebSession(c, req.auth.membership.id, sessionId);
      if (found || sessionId) return found;
      return createOwnerWebSession(c, req.auth.membership.id);
    });
    if (!session) {
      return res.status(404).json({ error: { message: 'Chat not found' } });
    }
    const messages = Array.isArray(session.context?.messages) ? session.context.messages : [];
    res.json({ session_id: session.id, messages });
  });

  router.post('/agent/chat', async (req, res) => {
    const { membership } = req.auth;
    if (membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'The agent tab is for the owner.' } });
    }
    const message = String(req.body?.message ?? '').trim();
    if (!message) return res.status(400).json({ error: { message: 'Message required' } });
    const agent = OWNER_WEB_AGENT;
    const requestedId = typeof req.body?.session_id === 'string' ? req.body.session_id : null;
    // Short transaction to load the chat; never hold a connection across the agent turn.
    const session = await scoped(req, async (c) => {
      const found = await loadOwnerWebSession(c, membership.id, requestedId);
      if (found || requestedId) return found;
      return createOwnerWebSession(c, membership.id);
    });
    if (!session) return res.status(404).json({ error: { message: 'Chat not found' } });
    const messages = Array.isArray(session?.context?.messages) ? session.context.messages : [];
    const history = messages.slice(-12).map((item) => ({ role: item.role, content: item.content }));
    const run = await fetch(`${config.runnerUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-secret': config.runnerSecret,
      },
      body: JSON.stringify({
        membership_id: membership.id,
        agent_id: agent,
        message,
        history,
        channel: 'web',
        focus_org_slug:
          typeof req.body?.focus_org_slug === 'string' ? req.body.focus_org_slug.trim() : '',
      }),
    });
    const data = await run.json().catch(() => ({}));
    if (!run.ok) {
      return res.status(run.status).json({ error: { message: data.error || 'Agent run failed' } });
    }
    const reply = data.reply || 'No reply';
    const tools = (data.tools ?? []).map((tool) => tool.action).filter(Boolean);
    const next = [
      ...messages,
      { role: 'user', content: message },
      { role: 'assistant', content: reply, tools },
    ].slice(-20);
    await scoped(req, (c) =>
      c.query(`UPDATE agent_sessions SET context = $2::jsonb, last_seen_at = now() WHERE id = $1`, [
        session.id,
        JSON.stringify({ messages: next }),
      ]),
    );
    res.json({ session_id: session.id, reply, tools, messages: next });
  });

  router.post('/agent/runs', async (req, res) => {
    const serviceSecret = req.headers['x-service-secret'];
    if (!serviceSecretOk(serviceSecret)) {
      return res.status(401).json({ error: { message: 'Invalid service secret' } });
    }
    const { membership_id, agent_id, message, profile, report_id, meeting_id, transcript_part, channel } = req.body ?? {};
    const membership = await loadMembership(membership_id);
    if (!membership) return res.status(404).json({ error: { message: 'Membership not found' } });
    const isMeeting = profile === 'meeting' && /^[0-9a-f-]{36}$/i.test(String(meeting_id ?? ''));
    if (profile === 'meeting' && !isMeeting) {
      return res.status(400).json({ error: { message: 'A meeting run needs meeting_id' } });
    }
    const runToken = signRunToken(
      membership,
      agent_id,
      {
        ...(profile === 'report' && /^[0-9a-f-]{36}$/i.test(String(report_id ?? '')) ? { profile, report_id } : {}),
        ...(isMeeting
          ? { profile, meeting_id, ...(Number.isInteger(transcript_part) && transcript_part >= 0 ? { transcript_part } : {}) }
          : {}),
        ...(['whatsapp', 'web', 'report', 'meeting'].includes(channel) ? { channel } : {}),
      },
    );
    // This workspace's own Qlix agent (Assistant, or Report writer for report drafts). Only the
    // service-secret runner gets this; null until the workspace's Qlix org is provisioned.
    let qlix = null;
    try {
      qlix = await runnerCredentials(membership.workspace_id, {
        profile: profile === 'report' ? 'report' : isMeeting ? 'meeting' : null,
        channel: isMeeting ? 'meeting' : channel ?? 'whatsapp',
        membershipId: membership.id,
        meetingId: isMeeting ? meeting_id : null,
      });
    } catch (e) {
      console.error('[qlix] credentials unavailable', membership.workspace_id, e.message);
    }
    const qlixState = qlix ? 'active' : await workspaceQlixState(membership.workspace_id).catch(() => 'unknown');
    res.json({
      run_token: runToken,
      membership,
      agent_id,
      message,
      qlix,
      qlix_state: qlixState,
      invoke: `${config.runnerUrl}/run`,
    });
  });

  /**
   * Qlix webhooks (signed with QLIX_WEBHOOK_SECRET). Answer fast: Qlix waits 5 s and retries
   * 3 times; the work runs after the reply, and the catch-up poll covers anything missed.
   */
  router.post('/qlix/webhook', (req, res) => {
    if (!verifyQlixSignature(req.rawBody, req.headers['x-qlix-signature'])) {
      return res.status(401).json({ error: { code: 'bad_signature', message: 'Invalid or expired signature' } });
    }
    const event = req.headers['x-qlix-event'] || req.body?.event;
    const handlers = { 'tenant.link_requested': handleLinkRequested, 'tenant.paused': handlePaused };
    const handler = handlers[event];
    res.status(202).json({ ok: true, handled: Boolean(handler) });
    if (!handler) return;
    handler(req.body).catch((e) => console.error(`[qlix] webhook ${event} failed:`, e.message));
  });

  /** The runner opened a Qlix conversation for this workspace's agent + channel; remember it. */
  router.post('/agent/qlix/conversation', async (req, res) => {
    if (!serviceSecretOk(req.headers['x-service-secret'])) {
      return res.status(401).json({ error: { message: 'Invalid service secret' } });
    }
    const { workspace_id, agent_kind, channel, membership_id, conversation_id, meeting_id } = req.body ?? {};
    await saveConversationId(workspace_id, {
      agentKind: agent_kind,
      channel,
      membershipId: membership_id,
      conversationId: conversation_id,
      meetingId: meeting_id,
    });
    res.json({ ok: true });
  });

  /** Owner: this workspace's Qlix org and agents (no secrets). */
  router.get('/qlix/status', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Only the owner can see the Qlix connection.' } });
    }
    res.json(await scoped(req, (c) => qlixStatus(c, { workspaceId: req.auth.membership.workspace_id })));
  });

  /** Owner: the Qlix login (email + the password Orbit set), shown only when asked for. */
  router.get('/qlix/login', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Only the owner can see the Qlix login.' } });
    }
    res.set('Cache-Control', 'no-store');
    const out = await scoped(req, (c) => revealOwnerLogin(c));
    if (out?.error) return res.status(out.error.status ?? 404).json({ error: out.error });
    res.json(out);
  });

  /** Owner: change the Qlix password (typed, or generated when `password` is empty). */
  router.post('/qlix/login/password', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Only the owner can change the Qlix login.' } });
    }
    res.set('Cache-Control', 'no-store');
    const out = await scoped(req, (c) => setOwnerPassword(c, req.auth.membership, { password: req.body?.password }));
    if (out?.error) return res.status(out.error.status ?? 409).json({ error: out.error });
    res.json(out);
  });

  /** Owner: a one-time link to sign into this workspace's Qlix org (Qlix sends no email). */
  router.post('/qlix/invite-owner', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Only the owner can get a Qlix login.' } });
    }
    const out = await scoped(req, (c) => inviteOwner(c, req.auth.membership));
    if (out?.error) return res.status(out.error.status ?? 409).json({ error: out.error });
    res.json(out);
  });

  /** Owner: retry a failed or pending Qlix setup. */
  router.post('/qlix/retry', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Only the owner can reconnect Qlix.' } });
    }
    res.json(
      await scoped(req, async (c) => {
        await queueQlixProvision(c);
        return qlixStatus(c);
      }),
    );
  });

  router.get('/agent/tools/catalog', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    res.json(getToolCatalog(auth.membership.role, auth.payload?.profile ?? null));
  });

  router.post('/agent/tools/portfolio_os', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { membership } = auth;
    const featDenied = requireFeature(membership, 'agent');
    if (featDenied) return sendDomain(res, featDenied);
    if (respondIfRateLimited(res, `agent:${membership.id}`, maxAgent())) return;
    const sessionId = req.headers['x-agent-session-id'];
    // Logged in its own short, scoped transaction so the record survives a rolled-back action.
    const logToolCall = (tool, args, allowed) =>
      withSession(membership, async (c) => {
        await c.query(
          `INSERT INTO agent_tool_calls (session_id, tool, args, allowed, result_rows) VALUES ($1,$2,$3,$4,$5)`,
          [/^[0-9a-f-]{36}$/i.test(String(sessionId ?? '')) ? sessionId : null, tool, JSON.stringify(args), allowed, null],
        );
        await bumpUsage(membership.workspace_id, membership.workspace_timezone, 'agent_tool_calls', 1);
        if (!allowed) {
          const matrixAction = TOOL_TO_MATRIX_ACTION[tool];
          if (matrixAction) {
            await notePermissionCheck(c, membership, matrixAction, false, { channel: 'agent', tool });
          }
        }
      });
    // The tool-call log is written on its own connection so it survives a rolled-back action.
    try {
      const out = await withSession(membership, (client) =>
        dispatchAgentTool(
          client,
          membership,
          {
            ...req.body,
            _headers: req.headers,
            // Run-token claims (never from the request body): the report being drafted, if any.
            _run:
              auth.payload?.kind === 'agent_run'
                ? {
                    profile: auth.payload.profile ?? null,
                    report_id: auth.payload.report_id ?? null,
                    meeting_id: auth.payload.meeting_id ?? null,
                    transcript_part: auth.payload.transcript_part ?? null,
                    channel: auth.payload.channel ?? null,
                  }
                : null,
          },
          logToolCall,
        ),
      );
      res.json(out);
    } catch (e) {
      if (/header mismatch/.test(e.message)) {
        return res.status(403).json({ error: { code: 'forbidden', message: 'Caller does not match the run token.' } });
      }
      throw e;
    }
  });

  router.get('/settings/whatsapp', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Settings are for the owner.' } });
    }
    const settings = await getWhatsAppSettings();
    res.json({ ...settings, registered_phones: await registeredPhoneCount() });
  });

  router.post('/settings/whatsapp/start', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Settings are for the owner.' } });
    }
    try {
      const settings = await startWhatsAppSession();
      if (CONNECTOR_ID()) {
        await scoped(req, (c) =>
          c.query(
            `INSERT INTO whatsapp_connections (connector_id) VALUES ($1)
             ON CONFLICT (connector_id) DO NOTHING`,
            [CONNECTOR_ID()],
          ),
        );
      }
      res.json({ ...settings, registered_phones: await registeredPhoneCount() });
    } catch (e) {
      res.status(e.status ?? 502).json({
        error: { message: e.message || 'Could not start WhatsApp session.' },
      });
    }
  });

  router.get('/plans', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listPlans(c)));
  });

  router.get('/entitlements', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => currentEntitlement(c, req.auth.membership)));
  });

  router.post('/workspaces/:id/entitlements', async (req, res) => {
    const workspaceId = req.params.id;
    if (req.auth.membership.workspace_id !== workspaceId) {
      return res.status(403).json({ error: { code: 'forbidden', message: 'Wrong workspace.' } });
    }
    sendDomain(res, await scoped(req, (c) => provisionEntitlement(c, req.auth.membership, workspaceId, req.body)));
  });

  router.get('/admin/usage', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getWorkspaceUsage(c, req.auth.membership, req.query)));
  });

  router.post('/onboarding/import-csv', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'onboarding');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => importCsvDryRun(c, req.auth.membership, req.body)));
  });

  router.post('/onboarding/apply', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'onboarding');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => applyOnboarding(c, req.auth.membership, req.body)));
  });

  router.post('/workspace/export', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'export');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => enqueueExport(c, req.auth.membership)));
  });

  router.get('/workspace/export/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getExportJob(c, req.auth.membership, req.params.id)));
  });

  router.post('/workspace/delete-request', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'portability');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => requestDeletion(c, req.auth.membership, req.body)));
  });

  router.get('/audit-log', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listAuditLog(c, req.auth.membership, req.query)));
  });

  router.post('/tasks/:id/dependencies', async (req, res) =>
    gatedMutate(req, res, 'task.assign', (c) => addTaskDependency(c, req.auth.membership, req.params.id, req.body)),
  );

  router.delete('/tasks/:id/dependencies', async (req, res) =>
    gatedMutate(req, res, 'task.assign', (c) => removeTaskDependency(c, req.auth.membership, req.params.id, req.body)),
  );

  router.get('/projects/:id/dependency-graph', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => projectDependencyGraph(c, req.auth.membership, req.params.id)));
  });

  router.get('/project-templates', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listProjectTemplates(c, req.auth.membership)));
  });

  router.post('/project-templates', async (req, res) =>
    gatedMutate(req, res, 'project.edit', (c) => createProjectTemplate(c, req.auth.membership, req.body)),
  );

  router.post('/projects/from-template/:id', async (req, res) => {
    const featDenied = requireFeature(req.auth.membership, 'projects');
    if (featDenied) return sendDomain(res, featDenied);
    return gatedMutate(req, res, 'project.edit', (c) =>
      instantiateProjectTemplate(c, req.auth.membership, req.params.id, req.body),
    );
  });

  router.post('/attachments', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => createAttachment(c, req.auth.membership, req.body)));
  });

  router.get('/attachments/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => getAttachment(c, req.auth.membership, req.params.id)));
  });

  router.get('/saved-views', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => listSavedViews(c, req.auth.membership)));
  });

  router.post('/saved-views', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => createSavedView(c, req.auth.membership, req.body)));
  });

  router.delete('/saved-views/:id', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => deleteSavedView(c, req.auth.membership, req.params.id)));
  });

  router.get('/workload', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => workloadByUnit(c, req.auth.membership, req.query.unit_id)));
  });

  router.post('/integrations/calendar/connect', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'calendar_sync');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => connectCalendar(c, req.auth.membership, req.body)));
  });

  router.get('/integrations/calendar/status', async (req, res) => {
    sendDomain(res, await scoped(req, (c) => calendarIntegrationStatus(c, req.auth.membership)));
  });

  router.post('/integrations/calendar/sync', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'calendar_sync');
    if (denied) return sendDomain(res, denied);
    if (req.auth.membership.role !== 'owner') {
      return sendDomain(res, { error: { code: 'forbidden', message: 'Workspace owner only.' } });
    }
    sendDomain(
      res,
      await scoped(req, async (c) => {
        await scheduleCalendarSync(c);
        return { ok: true, queued: true };
      }),
    );
  });

  router.post('/billing/checkout-session', async (req, res) => {
    const denied = requireFeature(req.auth.membership, 'billing');
    if (denied) return sendDomain(res, denied);
    sendDomain(res, await scoped(req, (c) => createCheckoutSession(c, req.auth.membership)));
  });

  router.post('/billing/webhook', async (req, res) => {
    const workspaceId = req.body?.workspace_id;
    if (!/^[0-9a-f-]{36}$/i.test(String(workspaceId ?? ''))) {
      return res.status(400).json({ error: { code: 'invalid', message: 'workspace_id required.' } });
    }
    const out = await withSystem(workspaceId, (c) => billingWebhook(c, req.body ?? {}, req.headers));
    sendDomain(res, out);
  });

  router.post('/digest/run', async (req, res) => {
    if (!serviceSecretOk(req.headers['x-service-secret'])) {
      return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
    const { rows: workspaces } = await query(`SELECT * FROM auth.active_workspaces()`);
    const out = [];
    for (const ws of workspaces) {
      out.push(
        await withSystem(ws.workspace_id, async (c) => {
          const period = todayIn(ws.timezone);
          const snapshot = await ownerDigestSnapshot(c, ws.workspace_id, ws.timezone);
          const body =
            snapshot.error != null
              ? `PortfolioOS digest — ${period} (${ws.timezone})\n\n(snapshot unavailable)`
              : formatDigestBody(snapshot, { period, timezone: ws.timezone });
          const { rows: owner } = await c.query(
            `SELECT u.phone_e164 FROM memberships m JOIN users u ON u.id = m.user_id
             WHERE m.role = 'owner' AND m.state <> 'inactive' AND u.phone_e164 IS NOT NULL LIMIT 1`,
          );
          if (owner[0]?.phone_e164) {
            await c.query(`INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1,$2,'digest')`, [owner[0].phone_e164, body]);
          }
          return { workspace_id: ws.workspace_id, body, queued_whatsapp: Boolean(owner[0]?.phone_e164) };
        }),
      );
    }
    res.json(out);
  });

  return router;
}
