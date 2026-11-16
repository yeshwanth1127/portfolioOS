import crypto from 'crypto';
import express from 'express';
import pg from 'pg';
import { digits, phoneDigitsFromJid, resolveSender } from './identity.js';

const SYSTEM_ID = '00000000-0000-0000-0000-000000000000';
const ACK_DEFAULT = 'On it ⏳ checking PortfolioOS…';
const NOT_REGISTERED = 'This number is not registered with PortfolioOS.';

/** Agent runs on WhatsApp only when the message contains @ (e.g. "@ list KPIs for TMS"). */
const agentTriggerPresent = (text) => String(text ?? '').includes('@');

/** Drop @mentions; keep the rest as the turn sent to the agent. */
function messageForAgent(text) {
  const stripped = String(text ?? '').replace(/@\S+/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped || String(text ?? '').trim();
}

/** Delivery phrases route through the agent (portfolio_os: complete_task, comment_on_task, post_project_update, my_tasks). */
export function isDeliveryIntent(text) {
  return /\b(my tasks?|complete|done|comment on|project update|milestone)\b/i.test(String(text ?? ''));
}

function secretMatches(expected, given) {
  const a = Buffer.from(String(expected ?? ''));
  const b = Buffer.from(String(given ?? ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The gateway as an Express app (index.js listens; tests mount it directly).
 * opts: { databaseUrl, runnerUrl, runnerSecret, serviceSecret, sidecarUrl, connectorId, ackText, fetch }
 */
export function createGateway(opts) {
  const pool = new pg.Pool({ connectionString: opts.databaseUrl });
  const doFetch = opts.fetch ?? fetch;
  const sidecarUrl = (opts.sidecarUrl ?? '').replace(/\/$/, '');
  const state = { linkedJid: null };

  /** One short transaction scoped to an actor (row-level security reads these settings). */
  async function scoped(actor, fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [actor.workspace_id ?? '']);
      await client.query(`SELECT set_config('app.role', $1, true)`, [actor.role]);
      await client.query(`SELECT set_config('app.org_id', $1, true)`, [actor.org_id ?? '']);
      await client.query(`SELECT set_config('app.membership_id', $1, true)`, [actor.id]);
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function sidecar(pathname, body) {
    if (!sidecarUrl || !opts.connectorId) {
      console.log('[wa] sidecar not configured', pathname, String(body.message ?? '').slice(0, 80));
      return { stub: true };
    }
    const res = await doFetch(`${sidecarUrl}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Secret': opts.serviceSecret },
      body: JSON.stringify({ connector_id: opts.connectorId, ...body }),
    });
    if (!res.ok) throw new Error((await res.text()) || `${pathname} ${res.status}`);
    return res.json().catch(() => ({ ok: true }));
  }

  const sendWhatsApp = (to, message) => sidecar('/send-to', { recipient: to, message });

  async function sendAck(phone, selfChat) {
    try {
      await sidecar(selfChat ? '/send' : '/send-to', selfChat ? { message: opts.ackText ?? ACK_DEFAULT } : { recipient: phone, message: opts.ackText ?? ACK_DEFAULT });
    } catch (e) {
      console.warn('[wa] ack failed', e.message);
    }
  }

  /** The workspace that owns this gateway's WhatsApp connection (null until registered). */
  async function connectionWorkspace() {
    if (!opts.connectorId) return null;
    const { rows } = await pool.query(`SELECT auth.workspace_for_connector($1) AS id`, [opts.connectorId]);
    return rows[0]?.id ?? null;
  }

  async function drainOutbox() {
    const workspaceId = await connectionWorkspace();
    if (!workspaceId) return;
    const SYSTEM = { id: SYSTEM_ID, role: 'system', org_id: null, workspace_id: workspaceId };
    const rows = await scoped(SYSTEM, async (c) =>
      (await c.query(
        `SELECT id, to_phone, body FROM wa_outbox WHERE state = 'queued' AND send_after <= now() ORDER BY id LIMIT 10`,
      )).rows,
    );
    for (const row of rows) {
      try {
        await sendWhatsApp(row.to_phone, row.body);
        await scoped(SYSTEM, (c) => c.query(`UPDATE wa_outbox SET state = 'sent', sent_at = now() WHERE id = $1`, [row.id]));
      } catch (e) {
        await scoped(SYSTEM, (c) =>
          c.query(
            `UPDATE wa_outbox SET attempts = attempts + 1,
               state = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE state END,
               send_after = now() + (interval '1 minute' * power(2, attempts))
             WHERE id = $1`,
            [row.id],
          ),
        );
        console.error('[wa] outbox send failed', row.id, e.message);
      }
    }
  }

  /**
   * Run one agent turn for a verified, registered sender.
   * Mutations are enforced by Portfolio API (`POST /agent/tools/portfolio_os` → `can()` / domain);
   * this gateway has no separate permission matrix.
   */
  async function runTurn(actor, phone, text) {
    const base = messageForAgent(text);
    const agentMessage = isDeliveryIntent(text) ? `Delivery request: ${base}` : base;
    const agentId = actor.role === 'owner' ? 'portfolio-owner-agent' : 'portfolio-reporter-agent';
    const scope = { id: actor.membership_id, role: actor.role, org_id: actor.org_id, workspace_id: actor.workspace_id };
    const session = await scoped(scope, async (c) => {
      const { rows } = await c.query(
        `SELECT id, context FROM agent_sessions WHERE membership_id = $1 AND agent = $2 AND channel = 'whatsapp'
         ORDER BY last_seen_at DESC LIMIT 1`,
        [actor.membership_id, agentId],
      );
      if (rows[0]) return rows[0];
      return (await c.query(
        `INSERT INTO agent_sessions (membership_id, agent, channel, context)
         VALUES ($1, $2, 'whatsapp', '{"messages":[]}'::jsonb) RETURNING id, context`,
        [actor.membership_id, agentId],
      )).rows[0];
    });
    const messages = Array.isArray(session.context?.messages) ? session.context.messages : [];
    let reply;
    try {
      const res = await doFetch(`${opts.runnerUrl}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-service-secret': opts.runnerSecret },
        body: JSON.stringify({
          membership_id: actor.membership_id,
          agent_id: agentId,
          message: agentMessage,
          history: messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          channel: 'whatsapp',
        }),
      });
      const data = await res.json().catch(() => ({}));
      reply = res.ok ? data.reply || 'No reply' : 'The assistant could not answer just now. Please try again in a moment.';
    } catch (e) {
      console.error('[wa] agent-runner unreachable', e.message);
      reply = 'The assistant is not available right now. Please try again in a moment.';
    }
    const next = [...messages, { role: 'user', content: agentMessage }, { role: 'assistant', content: reply }].slice(-20);
    await scoped(scope, (c) =>
      c.query(`UPDATE agent_sessions SET context = $2::jsonb, last_seen_at = now() WHERE id = $1`, [session.id, JSON.stringify({ messages: next })]),
    );
    return reply;
  }

  const app = express();
  app.use(express.json());

  const requireService = (req, res, next) => {
    if (!secretMatches(opts.serviceSecret, req.headers['x-service-secret'])) {
      return res.status(401).json({ error: 'Invalid service secret' });
    }
    if (opts.connectorId && req.params.id && req.params.id !== opts.connectorId) {
      return res.status(404).json({ error: 'Unknown connector' });
    }
    next();
  };

  app.get('/health', (_req, res) => {
    res.json({ ok: true, whatsapp: { sidecar: Boolean(sidecarUrl), connector_id: opts.connectorId || null, linked: Boolean(state.linkedJid) } });
  });

  // The only inbound path. Sender identity comes from the sidecar's chat id, never from the body.
  app.post('/api/v1/whatsapp/inbound', requireService, async (req, res, next) => {
    try {
      const body = req.body ?? {};
      if (opts.connectorId && body.connector_id && body.connector_id !== opts.connectorId) {
        return res.status(404).json({ error: 'Unknown connector' });
      }
      const text = String(body.text ?? '');
      if (!agentTriggerPresent(text) || !messageForAgent(text)) {
        return res.json({ ok: true, handled: false, reason: 'no_trigger', reply: '' });
      }
      const sender = resolveSender(body, state.linkedJid);
      if (!sender.ok) {
        console.warn('[wa] inbound rejected', sender.reason, String(body.remote_jid ?? '').replace(/\d(?=\d{4})/g, '•'));
        return res.json({ ok: true, handled: false, reason: sender.reason, reply: '' });
      }
      const { rows } = await pool.query(`SELECT * FROM auth.actor_for_phone($1, $2)`, [opts.connectorId, sender.phone]);
      const actor = rows[0];
      const deliver = sender.selfChat
        ? { deliver_to: 'self' }
        : { deliver_to: 'contact', contact_jid: `${digits(sender.phone)}@s.whatsapp.net` };
      if (!actor) {
        return res.json({ ok: true, handled: false, reason: 'not_registered', reply: NOT_REGISTERED, message: NOT_REGISTERED, ...deliver });
      }
      await sendAck(sender.phone, sender.selfChat);
      const reply = await runTurn(actor, sender.phone, text);
      res.json({ ok: true, handled: true, reply, message: reply, ...deliver });
    } catch (e) {
      next(e);
    }
  });

  app.get('/api/v1/whatsapp/auto-reply/armed', requireService, async (req, res) => {
    const remote = phoneDigitsFromJid(req.query.remote_jid);
    const { rows } = await pool.query(`SELECT phone_e164 FROM auth.registered_phones($1)`, [opts.connectorId]);
    res.json({ armed: Boolean(remote) && rows.some((r) => digits(r.phone_e164) === remote) });
  });

  app.get('/api/v1/whatsapp/auto-reply/armed-contacts', requireService, async (_req, res) => {
    const { rows } = await pool.query(`SELECT phone_e164 FROM auth.registered_phones($1)`, [opts.connectorId]);
    res.json({ contacts: rows.map((r) => `${digits(r.phone_e164)}@s.whatsapp.net`), muted: [] });
  });

  app.post('/api/v1/internal/whatsapp/:id/linked', requireService, (req, res) => {
    state.linkedJid = req.body?.owner_jid ?? null;
    res.json({ ok: true, linked: Boolean(state.linkedJid) });
  });

  app.post('/api/v1/internal/whatsapp/:id/logged-out', requireService, (_req, res) => {
    state.linkedJid = null;
    res.json({ ok: true });
  });

  // Optional sidecar callbacks — acknowledged so its outbox does not retry them.
  app.post('/api/v1/internal/whatsapp/:id/thread-handled', requireService, (_req, res) => res.json({ ok: true }));
  app.post('/api/v1/internal/whatsapp/:id/message-received', requireService, (_req, res) => res.json({ ok: true }));

  app.post('/digest/trigger', requireService, async (_req, res, next) => {
    try {
      const r = await doFetch(`${opts.apiUrl}/digest/run`, { method: 'POST', headers: { 'x-service-secret': opts.runnerSecret } });
      res.status(r.status).json(await r.json().catch(() => ({})));
    } catch (e) {
      next(e);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error('[wa] error', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'internal' });
  });

  return { app, drainOutbox, state, close: () => pool.end() };
}
