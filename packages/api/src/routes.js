import express from 'express';
import { authenticateRequest, hashPassword, loadMembership, signRunToken, signToken } from './auth.js';
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
import { listOrgs, listPeopleInOrg, showOrg, updateOrg } from './domain/orgs.js';
import { addPerson, removePerson, updatePerson } from './domain/people.js';
import { listScores } from './domain/scores.js';
import { lockDay } from './domain/signoffs.js';
import {
  amendNumber,
  listSubmissions,
  validateSubmission,
  withdrawSubmission,
} from './domain/submissions.js';
function domainHttpStatus(error) {
  if (error.code === 'forbidden') return 403;
  if (error.code === 'not_found') return 404;
  return 400;
}

function sendDomain(res, result) {
  if (result?.error) return res.status(domainHttpStatus(result.error)).json(result);
  return res.json(result);
}

export function createRouter() {
  const router = express.Router();

  router.post('/auth/login', async (req, res) => {
    const { email, password } = req.body ?? {};
    const { rows } = await query(
      `SELECT u.id, u.password_hash FROM users u WHERE u.email = $1`,
      [email],
    );
    const user = rows[0];
    if (!user || user.password_hash !== hashPassword(password)) {
      return res.status(401).json({ error: { message: 'Invalid credentials' } });
    }
    const { rows: memberships } = await query(
      `SELECT id FROM memberships WHERE user_id = $1 AND state <> 'inactive'
       ORDER BY CASE role
         WHEN 'owner' THEN 0
         WHEN 'manager' THEN 1
         WHEN 'vice_manager' THEN 2
         WHEN 'team_lead' THEN 3
         ELSE 4
       END
       LIMIT 1`,
      [user.id],
    );
    const membership = await loadMembership(memberships[0].id);
    const token = signToken(membership);
    res.json({ token, membership });
  });

  router.use(async (req, res, next) => {
    if (req.path === '/auth/login' || req.path === '/agent/runs' || req.path === '/digest/run') return next();
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    req.auth = auth;
    next();
  });

  router.get('/orgs', async (req, res) => {
    sendDomain(res, await listOrgs(null, req.auth.membership));
  });

  router.get('/orgs/:slug', async (req, res) => {
    sendDomain(res, await showOrg(null, req.auth.membership, req.params.slug));
  });

  router.get('/orgs/:slug/kpis', async (req, res) => {
    sendDomain(res, await listKpisForOrg(null, req.auth.membership, req.params.slug));
  });

  router.get('/orgs/:slug/people', async (req, res) => {
    sendDomain(res, await listPeopleInOrg(null, req.auth.membership, req.params.slug));
  });

  router.patch('/orgs/:slug', async (req, res) => {
    sendDomain(res, await updateOrg(null, req.auth.membership, req.params.slug, req.body));
  });

  router.post('/orgs/:slug/kpis', async (req, res) => {
    sendDomain(res, await addKpi(null, req.auth.membership, req.params.slug, req.body));
  });

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
    let result = null;
    if (wantsRegisterEdit) {
      result = await updateKpiRegister(null, req.auth.membership, req.params.id, req.body);
      if (result.error) return sendDomain(res, result);
    }
    if (wantsOwnerEdit) {
      result = await assignKpiOwner(null, req.auth.membership, req.params.id, {
        owner_id: nextOwnerId,
      });
    }
    sendDomain(res, result);
  });

  router.delete('/kpis/:id', async (req, res) => {
    sendDomain(res, await retireKpi(null, req.auth.membership, req.params.id));
  });

  router.post('/orgs/:slug/people', async (req, res) => {
    sendDomain(res, await addPerson(null, req.auth.membership, req.params.slug, req.body));
  });

  router.patch('/people/:id', async (req, res) => {
    sendDomain(res, await updatePerson(null, req.auth.membership, req.params.id, req.body));
  });

  router.delete('/people/:id', async (req, res) => {
    sendDomain(res, await removePerson(null, req.auth.membership, req.params.id));
  });

  router.patch('/submissions/:id', async (req, res) => {
    sendDomain(res, await amendNumber(null, req.auth.membership, req.params.id, req.body?.value));
  });

  router.delete('/submissions/:id', async (req, res) => {
    sendDomain(res, await withdrawSubmission(null, req.auth.membership, req.params.id));
  });

  router.post('/kpis/target', async (req, res) => {
    const { kpi_code, target, how_often } = req.body ?? {};
    const out = await setTargetByCode(null, req.auth.membership, {
      kpi_code,
      how_often,
      value: target,
      reason: 'set from dashboard',
    });
    if (out.error) return sendDomain(res, out);
    res.json({ ok: true, kpi_code, how_often: out.how_often, target: out.value, goals: out.goals });
  });

  router.get('/readiness', async (req, res) => {
    const { membership } = req.auth;
    if (membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Owner only' } });
    }
    const { rows: unnamed } = await query(
      `SELECT o.slug, count(*)::int AS c FROM memberships m JOIN organisations o ON o.id = m.org_id WHERE m.state = 'pending_name' GROUP BY o.slug`,
    );
    const { rows: nullTargets } = await query(
      `SELECT o.slug, count(*)::int AS c FROM kpis k JOIN organisations o ON o.id = k.org_id WHERE k.target IS NULL AND k.unmeasured = false GROUP BY o.slug`,
    );
    res.json({ unnamed_by_org: unnamed, null_targets_by_org: nullTargets });
  });

  router.get('/submissions', async (req, res) => {
    const date = req.query.date ?? new Date().toISOString().slice(0, 10);
    sendDomain(
      res,
      await listSubmissions(null, req.auth.membership, { org_slug: req.query.org, date }),
    );
  });

  router.post('/submissions', async (req, res) => {
    const { membership } = req.auth;
    const { kpi_code, value, period_date } = req.body ?? {};
    const out = await withSession(membership, (client) =>
      dispatchAgentTool(
        client,
        membership,
        { action: 'record_number', kpi_code, value, period_date, channel: 'web', _headers: req.headers },
        async () => {},
      ),
    );
    if (out.error) {
      const status = out.error.code === 'forbidden' ? 403 : out.error.code === 'not_found' ? 404 : 400;
      return res.status(status).json(out);
    }
    res.json(out);
  });

  router.post('/submissions/:id/validate', async (req, res) => {
    sendDomain(res, await validateSubmission(null, req.auth.membership, req.params.id, req.body));
  });

  router.post('/orgs/:slug/signoff', async (req, res) => {
    const period = req.body?.period_date ?? new Date().toISOString().slice(0, 10);
    const out = await withSession(req.auth.membership, (client) =>
      lockDay(client, req.auth.membership, req.params.slug, period),
    );
    sendDomain(res, out);
  });

  router.get('/scores', async (req, res) => {
    sendDomain(
      res,
      await listScores(null, req.auth.membership, {
        org_slug: req.query.org,
        from: req.query.from,
        to: req.query.to,
      }),
    );
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

  async function loadOwnerWebSession(membershipId, sessionId) {
    if (sessionId) {
      const { rows } = await query(
        `SELECT id, context FROM agent_sessions
         WHERE id = $1 AND membership_id = $2 AND agent = $3 AND channel = 'web'`,
        [sessionId, membershipId, OWNER_WEB_AGENT],
      );
      return rows[0] ?? null;
    }
    const { rows } = await query(
      `SELECT id, context FROM agent_sessions
       WHERE membership_id = $1 AND agent = $2 AND channel = 'web'
       ORDER BY last_seen_at DESC LIMIT 1`,
      [membershipId, OWNER_WEB_AGENT],
    );
    return rows[0] ?? null;
  }

  async function createOwnerWebSession(membershipId) {
    const inserted = await query(
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
    const { rows } = await query(
      `SELECT id, context, last_seen_at FROM agent_sessions
       WHERE membership_id = $1 AND agent = $2 AND channel = 'web'
       ORDER BY last_seen_at DESC LIMIT 40`,
      [req.auth.membership.id, OWNER_WEB_AGENT],
    );
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
    const session = await createOwnerWebSession(req.auth.membership.id);
    res.status(201).json({ session_id: session.id, messages: [] });
  });

  router.get('/agent/chat', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'The agent tab is for the owner.' } });
    }
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : null;
    let session = await loadOwnerWebSession(req.auth.membership.id, sessionId);
    if (!session && !sessionId) {
      session = await createOwnerWebSession(req.auth.membership.id);
    }
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
    let session = await loadOwnerWebSession(membership.id, requestedId);
    if (!session) {
      if (requestedId) {
        return res.status(404).json({ error: { message: 'Chat not found' } });
      }
      session = await createOwnerWebSession(membership.id);
    }
    let messages = Array.isArray(session?.context?.messages) ? session.context.messages : [];
    const history = messages.slice(-12).map((item) => ({ role: item.role, content: item.content }));
    const runnerUrl = process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940';
    const run = await fetch(`${runnerUrl}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-secret': process.env.AGENT_RUNNER_SECRET ?? 'dev-runner-secret',
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
    await query(
      `UPDATE agent_sessions SET context = $2::jsonb, last_seen_at = now() WHERE id = $1`,
      [session.id, JSON.stringify({ messages: next })],
    );
    res.json({ session_id: session.id, reply, tools, messages: next });
  });

  router.post('/agent/runs', async (req, res) => {
    const serviceSecret = req.headers['x-service-secret'];
    if (serviceSecret !== (process.env.AGENT_RUNNER_SECRET ?? 'dev-runner-secret')) {
      return res.status(401).json({ error: { message: 'Invalid service secret' } });
    }
    const { membership_id, agent_id, message } = req.body ?? {};
    const membership = await loadMembership(membership_id);
    if (!membership) return res.status(404).json({ error: { message: 'Membership not found' } });
    const runToken = signRunToken(membership, agent_id);
    res.json({
      run_token: runToken,
      membership,
      agent_id,
      message,
      invoke: `${process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940'}/run`,
    });
  });

  router.get('/agent/tools/catalog', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    res.json(getToolCatalog(auth.membership.role));
  });

  router.post('/agent/tools/portfolio_os', async (req, res) => {
    const auth = await authenticateRequest(req);
    if (!auth) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { membership } = auth;
    const sessionId = req.headers['x-agent-session-id'];
    const logToolCall = async (tool, args, allowed) => {
      await query(
        `INSERT INTO agent_tool_calls (session_id, tool, args, allowed, result_rows)
         VALUES ($1,$2,$3,$4,$5)`,
        [sessionId ?? null, tool, JSON.stringify(args), allowed, null],
      );
    };
    try {
      const out = await withSession(membership, (client) =>
        dispatchAgentTool(client, membership, { ...req.body, _headers: req.headers }, logToolCall),
      );
      res.json(out);
    } catch (e) {
      res.status(400).json({ error: { message: e.message } });
    }
  });

  router.get('/settings/whatsapp', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Settings are for the owner.' } });
    }
    const { rows } = await query(
      `SELECT count(*)::int AS c FROM users WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''`,
    );
    const settings = await getWhatsAppSettings();
    res.json({ ...settings, registered_phones: rows[0]?.c ?? 0 });
  });

  router.post('/settings/whatsapp/start', async (req, res) => {
    if (req.auth.membership.role !== 'owner') {
      return res.status(403).json({ error: { message: 'Settings are for the owner.' } });
    }
    try {
      const settings = await startWhatsAppSession();
      const { rows } = await query(
        `SELECT count(*)::int AS c FROM users WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''`,
      );
      res.json({ ...settings, registered_phones: rows[0]?.c ?? 0 });
    } catch (e) {
      res.status(e.status ?? 502).json({
        error: { message: e.message || 'Could not start WhatsApp session.' },
      });
    }
  });

  router.post('/digest/run', async (req, res) => {
    if (req.headers['x-service-secret'] !== (process.env.AGENT_RUNNER_SECRET ?? 'dev-runner-secret')) {
      return res.status(401).json({ error: { message: 'Unauthorized' } });
    }
    const period = new Date().toISOString().slice(0, 10);
    const { rows: orgs } = await query(`SELECT slug, name FROM organisations ORDER BY slug`);
    const lines = [`PortfolioOS digest — ${period} (Asia/Kolkata)`, ''];
    for (const org of orgs) {
      const { rows: lock } = await query(
        `SELECT 1 FROM signoffs s JOIN organisations o ON o.id = s.org_id WHERE o.slug = $1 AND s.period_date = $2`,
        [org.slug, period],
      );
      lines.push(`${org.name}: ${lock.length ? 'locked' : 'open'}`);
    }
    lines.push('', 'Readiness: use dashboard /readiness for unnamed roster and missing targets.');
    const body = lines.join('\n');
    const { rows: owner } = await query(
      `SELECT u.phone_e164 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner' LIMIT 1`,
    );
    if (owner[0]?.phone_e164) {
      await query(
        `INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1,$2,'digest')`,
        [owner[0].phone_e164, body],
      );
    }
    res.json({ body, queued_whatsapp: Boolean(owner[0]?.phone_e164) });
  });

  return router;
}
