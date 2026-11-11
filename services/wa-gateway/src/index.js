import express from 'express';
import pg from 'pg';

const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? 'postgresql://portfolio:portfolio@localhost:5433/portfolio_os',
});

const API_URL = process.env.PORTFOLIOOS_API_URL ?? 'http://localhost:4001';
const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940';
const RUNNER_SECRET = process.env.AGENT_RUNNER_SECRET ?? 'dev-runner-secret';
const WA_SERVICE_URL = (process.env.WA_SERVICE_URL ?? '').replace(/\/$/, '');
const WA_CONNECTOR_ID = process.env.WA_CONNECTOR_ID ?? '';
const WA_SERVICE_SECRET = process.env.WA_SERVICE_SECRET ?? process.env.SERVICE_SECRET ?? RUNNER_SECRET;

const app = express();
app.use(express.json());

let linkedJid = null;

function digits(value) {
  return String(value ?? '').replace(/\D/g, '');
}

/** Phone digits from a JID — strip device id (`:61`) before taking digits. */
function phoneDigitsFromJid(jid) {
  const local = String(jid ?? '').split('@')[0].split(':')[0];
  return digits(local);
}

function jidFor(phone) {
  return `${digits(phone)}@s.whatsapp.net`;
}

function phonesMatch(a, b) {
  const da = digits(a);
  const db = digits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-10) === db.slice(-10);
}

function linkedPhoneE164() {
  const d = phoneDigitsFromJid(linkedJid);
  return d ? `+${d}` : null;
}

/** Agent runs on WhatsApp only when the message contains @ (e.g. "@ list KPIs for TMS"). */
function agentTriggerPresent(text) {
  return String(text ?? '').includes('@');
}

/** Drop @mentions; keep the rest as the turn sent to the agent. */
function messageForAgent(text) {
  const stripped = String(text ?? '')
    .replace(/@\S+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || String(text ?? '').trim();
}

async function registeredPhones() {
  const { rows } = await pool.query(
    `SELECT phone_e164 FROM users WHERE phone_e164 IS NOT NULL AND phone_e164 <> ''`,
  );
  return rows.map((row) => row.phone_e164);
}

async function sendWhatsApp(to, body) {
  if (!WA_SERVICE_URL || !WA_CONNECTOR_ID) {
    console.log('[wa] sidecar not configured', to, String(body).slice(0, 80));
    return { stub: true };
  }
  const res = await fetch(`${WA_SERVICE_URL}/send-to`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Secret': WA_SERVICE_SECRET,
    },
    body: JSON.stringify({
      connector_id: WA_CONNECTOR_ID,
      recipient: to,
      message: body,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `send-to ${res.status}`);
  }
  return res.json().catch(() => ({ ok: true }));
}

async function drainOutbox() {
  const { rows } = await pool.query(
    `SELECT id, to_phone, body, kind FROM wa_outbox
     WHERE state = 'queued' AND send_after <= now() ORDER BY id LIMIT 10`,
  );
  for (const row of rows) {
    try {
      await sendWhatsApp(row.to_phone, row.body);
      await pool.query(`UPDATE wa_outbox SET state = 'sent', sent_at = now() WHERE id = $1`, [row.id]);
    } catch (e) {
      await pool.query(
        `UPDATE wa_outbox SET attempts = attempts + 1, send_after = now() + interval '1 minute' WHERE id = $1`,
        [row.id],
      );
      console.error('outbox send failed', row.id, e.message);
    }
  }
}

setInterval(() => {
  drainOutbox().catch(console.error);
}, 5000);

const ACK_TEXT = process.env.WA_ACK_TEXT || 'On it ⏳ checking PortfolioOS…';

/** Self-chat (linked account) goes through /send; anyone else through /send-to. */
async function sendAck(phone, { selfChat }) {
  if (!WA_SERVICE_URL || !WA_CONNECTOR_ID) return;
  try {
    const res = await fetch(`${WA_SERVICE_URL}/${selfChat ? 'send' : 'send-to'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Secret': WA_SERVICE_SECRET },
      body: JSON.stringify(
        selfChat
          ? { connector_id: WA_CONNECTOR_ID, message: ACK_TEXT }
          : { connector_id: WA_CONNECTOR_ID, recipient: phone, message: ACK_TEXT },
      ),
    });
    if (!res.ok) console.warn('[wa] ack failed', res.status, (await res.text()).slice(0, 120));
  } catch (e) {
    console.warn('[wa] ack failed', e.message);
  }
}

async function handleText(phone, text, { queue = true, onAccepted } = {}) {
  if (!agentTriggerPresent(text)) {
    return { handled: false, reason: 'no_trigger', run: { reply: '' } };
  }
  const agentMessage = messageForAgent(text);
  if (!agentMessage) {
    return { handled: false, reason: 'no_trigger', run: { reply: '' } };
  }

  const { rows } = await pool.query(
    `SELECT m.id AS membership_id, m.role, u.full_name, u.phone_e164
     FROM users u JOIN memberships m ON m.user_id = u.id
     WHERE m.state <> 'inactive' AND u.phone_e164 IS NOT NULL
     ORDER BY CASE m.role
       WHEN 'owner' THEN 0
       WHEN 'manager' THEN 1
       WHEN 'vice_manager' THEN 2
       WHEN 'team_lead' THEN 3
       ELSE 4
     END`,
  );
  let match = rows.find((row) => phonesMatch(row.phone_e164, phone));
  if (!match) {
    const reply = 'This number is not registered with PortfolioOS.';
    if (queue) await sendWhatsApp(phone, reply);
    return { handled: false, reason: 'not_registered', run: { reply } };
  }
  // Tell the sender we're working before the (multi-second) agent turn starts.
  if (onAccepted) await onAccepted();
  const agent_id = match.role === 'owner' ? 'portfolio-owner-agent' : 'portfolio-reporter-agent';
  const { rows: sessions } = await pool.query(
    `SELECT id, context FROM agent_sessions
     WHERE membership_id = $1 AND agent = $2 AND channel = 'whatsapp'
     ORDER BY last_seen_at DESC LIMIT 1`,
    [match.membership_id, agent_id],
  );
  let session = sessions[0];
  let messages = Array.isArray(session?.context?.messages) ? session.context.messages : [];
  if (!session) {
    const inserted = await pool.query(
      `INSERT INTO agent_sessions (membership_id, agent, channel, context)
       VALUES ($1, $2, 'whatsapp', '{"messages":[]}'::jsonb) RETURNING id, context`,
      [match.membership_id, agent_id],
    );
    session = inserted.rows[0];
    messages = [];
  }
  const history = messages.slice(-12).map((item) => ({ role: item.role, content: item.content }));
  let runData;
  try {
    const runRes = await fetch(`${RUNNER_URL}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-service-secret': RUNNER_SECRET,
      },
      body: JSON.stringify({
        membership_id: match.membership_id,
        agent_id,
        message: agentMessage,
        history,
        channel: 'whatsapp',
      }),
    });
    runData = await runRes.json().catch(() => ({}));
    if (!runRes.ok) {
      runData = {
        reply: `Agent runner error (${runRes.status}). Is agent-runner on :3940 and Qlix on :4000 running?`,
        error: runData,
      };
    }
  } catch (e) {
    console.error('agent-runner unreachable', e.message);
    return {
      handled: false,
      reason: 'runner_down',
      run: {
        reply:
          'Agent runner is not running (port 3940). Start it, and Qlix backend on 4000, then try again.',
      },
    };
  }
  const reply = runData.reply || 'No reply';
  const next = [...messages, { role: 'user', content: agentMessage }, { role: 'assistant', content: reply }].slice(-20);
  await pool.query(
    `UPDATE agent_sessions SET context = $2::jsonb, last_seen_at = now() WHERE id = $1`,
    [session.id, JSON.stringify({ messages: next })],
  );
  if (queue && reply) {
    await pool.query(
      `INSERT INTO wa_outbox (to_phone, body, kind) VALUES ($1,$2,'agent_reply')`,
      [match.phone_e164, reply],
    );
  }
  return { handled: true, agent_id, run: runData };
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    whatsapp: {
      sidecar: Boolean(WA_SERVICE_URL),
      connector_id: WA_CONNECTOR_ID || null,
      linked_jid: linkedJid,
    },
  });
});

app.post('/inbound', async (req, res) => {
  const phone = req.body?.phone_e164;
  const text = req.body?.text ?? '';
  if (!phone) return res.status(400).json({ error: 'phone_e164 required' });
  res.json(
    await handleText(phone, text, {
      onAccepted: () => sendWhatsApp(phone, ACK_TEXT).catch((e) => console.warn('[wa] ack failed', e.message)),
    }),
  );
});

function serviceOk(req, res) {
  const header = req.headers['x-service-secret'];
  if (header !== WA_SERVICE_SECRET) {
    res.status(401).json({ error: 'Invalid service secret' });
    return false;
  }
  return true;
}

app.post('/api/v1/whatsapp/inbound', async (req, res) => {
  if (!serviceOk(req, res)) return;
  const text = req.body?.text ?? '';
  const fromContact = Boolean(req.body?.from_contact);
  const remoteJid = req.body?.remote_jid || '';
  const isLid = String(remoteJid).includes('@lid');

  // Self-chat / LID: use the QR-linked phone. Contact chats: use remote phone JID.
  let phone = null;
  if (!fromContact || isLid) {
    phone = linkedPhoneE164();
  }
  if (!phone && remoteJid && !isLid) {
    const d = phoneDigitsFromJid(remoteJid);
    phone = d ? `+${d}` : null;
  }
  if (!phone) {
    const { rows } = await pool.query(
      `SELECT u.phone_e164 FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.role = 'owner' AND m.state <> 'inactive' AND u.phone_e164 IS NOT NULL
       LIMIT 1`,
    );
    phone = rows[0]?.phone_e164 ?? null;
  }
  if (!phone) {
    return res.status(400).json({
      error: 'remote_jid required',
      hint: 'Save the owner phone in PortfolioOS and ensure WhatsApp is linked.',
    });
  }

  const result = await handleText(phone, text, {
    queue: false,
    onAccepted: () => sendAck(phone, { selfChat: !fromContact }),
  });
  const reply = result.run?.reply ?? '';
  // Self-chat must use deliver_to=self (sidecar rejects send-to-self as contact).
  if (!fromContact) {
    return res.json({ ok: true, reply, message: reply, deliver_to: 'self' });
  }
  res.json({
    ok: true,
    reply,
    message: reply,
    deliver_to: 'contact',
    contact_jid: jidFor(phone),
  });
});

app.get('/api/v1/whatsapp/auto-reply/armed', async (req, res) => {
  if (!serviceOk(req, res)) return;
  const remote = phoneDigitsFromJid(req.query.remote_jid) || digits(req.query.remote_jid);
  const phones = await registeredPhones();
  const armed = phones.some((phone) => phonesMatch(phone, remote));
  res.json({ armed });
});

app.get('/api/v1/whatsapp/auto-reply/armed-contacts', async (req, res) => {
  if (!serviceOk(req, res)) return;
  const phones = await registeredPhones();
  res.json({ contacts: phones.map(jidFor), muted: [] });
});

app.post('/api/v1/internal/whatsapp/:id/linked', (req, res) => {
  if (!serviceOk(req, res)) return;
  linkedJid = req.body?.owner_jid ?? null;
  res.json({ ok: true, linked_jid: linkedJid });
});

app.post('/api/v1/internal/whatsapp/:id/logged-out', (req, res) => {
  if (!serviceOk(req, res)) return;
  linkedJid = null;
  res.json({ ok: true });
});

/** Sidecar optional callbacks — acknowledge so the outbox does not spam 404s. */
app.post('/api/v1/internal/whatsapp/:id/thread-handled', (req, res) => {
  if (!serviceOk(req, res)) return;
  res.json({ ok: true });
});

app.post('/api/v1/internal/whatsapp/:id/message-received', (req, res) => {
  if (!serviceOk(req, res)) return;
  res.json({ ok: true });
});

app.post('/digest/trigger', async (req, res) => {
  const r = await fetch(`${API_URL}/digest/run`, {
    method: 'POST',
    headers: { 'x-service-secret': RUNNER_SECRET },
  });
  const data = await r.json();
  res.json(data);
});

const port = Number(process.env.WA_PORT ?? 3938);
app.listen(port, () => console.log(`WA gateway on :${port}`));
