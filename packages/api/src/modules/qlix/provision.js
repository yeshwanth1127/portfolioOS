/*
 * One Qlix org per workspace, with three hybrid agents:
 *   Assistant          — web chat and WhatsApp
 *   Report writer      — report summaries (runs with the 'report' run-token profile)
 *   Meeting Assistant  — attends meetings, writes summaries ('meeting' profile; docs/MEETINGS.md)
 *
 * Provisioning runs as a durable job ('qlix_provision'). Each step commits on its own, so a
 * failure part-way (Qlix down, timeout) resumes from where it stopped instead of creating
 * duplicate orgs or agents. The workspace keeps working while Qlix is not connected.
 */
import crypto from 'node:crypto';
import { loadMembership } from '../../auth.js';
import { query, withSession } from '../../db.js';
import { enqueue, registerJob } from '../../jobs/queue.js';
import { config } from '../../core/config.js';
import { decryptSecret, encryptSecret } from '../../core/secrets.js';
import {
  QlixError,
  createHybridAgent,
  completeLink,
  createTenant,
  disableTenant,
  listLinks,
  inviteToTenant,
  listTenantInvitations,
  qlixConfigured,
  rotateTenantKey,
  setMemberPassword,
} from './client.js';

const AGENTS = {
  assistant: {
    name: 'Assistant',
    description: 'Answers questions and records updates for this Orbit workspace (web chat and WhatsApp).',
  },
  report: {
    name: 'Report writer',
    description: 'Writes the summary of Orbit reports from figures computed by Orbit.',
  },
  meeting: {
    name: 'Meeting Assistant',
    description: 'Attends Orbit meetings: answers questions during the call and writes the summary, decisions and action items.',
  },
};

const CHANNELS = new Set(['web', 'whatsapp', 'report', 'meeting']);
const PROFILE_AGENT = { report: 'report', meeting: 'meeting' };

const systemActor = (workspaceId) => ({
  id: '00000000-0000-0000-0000-000000000000',
  role: 'system',
  org_id: null,
  workspace_id: workspaceId,
});

/** Run fn in its own committed, system-scoped transaction for one workspace. */
const asSystem = (workspaceId, fn) => withSession(systemActor(workspaceId), fn);

async function loadRow(client) {
  const { rows } = await client.query(`SELECT * FROM workspace_qlix LIMIT 1`);
  return rows[0] ?? null;
}

/** Queue provisioning for the workspace in `client`'s scope (signup, new workspace, retry). */
export async function queueQlixProvision(client) {
  await client.query(
    `INSERT INTO workspace_qlix (status) VALUES ('pending')
     ON CONFLICT (workspace_id) DO UPDATE SET status = 'pending', last_error = NULL, updated_at = now()
     WHERE workspace_qlix.status IN ('failed', 'pending')`,
  );
  await enqueue(client, 'qlix_provision', {}, { dedupeKey: 'qlix_provision' });
}

/** Queue provisioning for a workspace by id, from outside any session (signup, backfill script). */
export async function queueQlixProvisionFor(workspaceId) {
  await asSystem(workspaceId, (client) => queueQlixProvision(client));
}

async function workspaceFacts(workspaceId) {
  const { rows } = await asSystem(workspaceId, (client) =>
    client.query(
      `SELECT w.name,
              (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
                WHERE m.workspace_id = w.id AND m.role = 'owner' AND m.state <> 'inactive'
                ORDER BY m.created_at LIMIT 1) AS owner_email
       FROM workspaces w WHERE w.id = $1`,
      [workspaceId],
    ),
  );
  return rows[0] ?? null;
}

async function patchRow(workspaceId, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  await asSystem(workspaceId, (client) =>
    client.query(`UPDATE workspace_qlix SET ${sets}, updated_at = now()`, keys.map((k) => fields[k])),
  );
}

/** Create whichever agent is missing. Each is saved as soon as it exists (token shown once). */
async function ensureAgents(workspaceId, row, tenantKey) {
  for (const [kind, spec] of Object.entries(AGENTS)) {
    if (row[`${kind}_agent_id`]) continue;
    const { agentId, runnerToken } = await createHybridAgent(tenantKey, spec);
    await patchRow(workspaceId, {
      [`${kind}_agent_id`]: agentId,
      [`${kind}_runner_token_enc`]: encryptSecret(runnerToken),
    });
  }
}

async function failRow(workspaceId, row, e) {
  await patchRow(workspaceId, {
    status: 'failed',
    last_error: String(e.message ?? e).slice(0, 500),
    attempts: (row?.attempts ?? 0) + 1,
  }).catch(() => {});
}

async function ensureRow(workspaceId) {
  let row = await asSystem(workspaceId, loadRow);
  if (!row) {
    await asSystem(workspaceId, (c) =>
      c.query(`INSERT INTO workspace_qlix (status) VALUES ('pending') ON CONFLICT (workspace_id) DO NOTHING`),
    );
    row = await asSystem(workspaceId, loadRow);
  }
  return row;
}

/**
 * Provision (or finish provisioning) one workspace by creating a new Qlix org. Safe to call
 * repeatedly. If the owner already uses Qlix, the workspace waits ('waiting_link') for them to
 * turn the Orbit plugin on in their own org instead (see handleLinkRequested).
 */
export async function provisionWorkspace(workspaceId) {
  if (!qlixConfigured()) throw new QlixError('Qlix is not configured (QLIX_BACKEND_URL, QLIX_PARTNER_KEY)');
  const row = await ensureRow(workspaceId);
  if (row.status === 'active') return ensureMissingAgents(workspaceId, row);
  if (['disabled', 'waiting_link', 'paused'].includes(row.status)) return row;

  try {
    const facts = await workspaceFacts(workspaceId);
    if (!facts) throw new Error('Workspace not found');

    // 1. The Qlix org (tenant). If Qlix already has it (an earlier attempt lost its key), rotate.
    let tenantKey = row.tenant_key_enc ? decryptSecret(row.tenant_key_enc) : null;
    if (!tenantKey) {
      let out;
      try {
        out = await createTenant({
          workspaceId,
          name: facts.name,
          ownerEmail: facts.owner_email ?? `owner+${workspaceId}@orbit.invalid`,
        });
      } catch (e) {
        if (e.code === 'qlix_workspace_exists') {
          // Not a failure: the owner turns Orbit on in their existing Qlix org.
          await patchRow(workspaceId, {
            status: 'waiting_link',
            waiting_email: facts.owner_email,
            connect_url: e.details?.connectUrl ?? null,
            last_error: null,
          });
          return asSystem(workspaceId, loadRow);
        }
        if (e.code !== 'already_provisioned') throw e;
        out = await rotateTenantKey(workspaceId);
      }
      tenantKey = out.apiKey;
      await patchRow(workspaceId, {
        tenant_key_enc: encryptSecret(tenantKey),
        qlix_org_id: out.orgId,
        qlix_org_name: facts.name,
        link_mode: row.link_mode ?? 'created',
      });
    }

    // 2. The two agents.
    await ensureAgents(workspaceId, row, tenantKey);
    await patchRow(workspaceId, { status: 'active', last_error: null });
    return asSystem(workspaceId, loadRow);
  } catch (e) {
    await failRow(workspaceId, row, e);
    throw e;
  }
}

/**
 * An active workspace provisioned before an agent kind existed (e.g. the Meeting Assistant):
 * create just the missing agents with the stored tenant key. The workspace stays active even if
 * this fails (the other agents keep working); the error is logged and the next call retries.
 */
export async function ensureMissingAgents(workspaceId, row = null) {
  const current = row ?? (await asSystem(workspaceId, loadRow));
  if (!current || current.status !== 'active') return current;
  if (Object.keys(AGENTS).every((kind) => current[`${kind}_agent_id`])) return current;
  if (!current.tenant_key_enc || !qlixConfigured()) return current;
  try {
    await ensureAgents(workspaceId, current, decryptSecret(current.tenant_key_enc));
  } catch (e) {
    console.error('[qlix] could not add missing agents', workspaceId, e.message);
    return current;
  }
  return asSystem(workspaceId, loadRow);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const linking = new Set();

/** Which Orbit workspace a Qlix link belongs to; opens one for a known Orbit user if needed. */
async function workspaceForLink(link) {
  if (link.externalOrgId) return UUID.test(link.externalOrgId) ? link.externalOrgId : null;
  const email = String(link.requestedByEmail ?? '').trim();
  if (!email) return null;
  const waiting = await query(`SELECT auth.qlix_waiting_workspace($1) AS id`, [email]);
  if (waiting.rows[0]?.id) return waiting.rows[0].id;
  // No workspace is waiting: if this person has an Orbit account, open a workspace for the Qlix org.
  const user = await query(`SELECT user_id FROM auth.login_candidate($1)`, [email]);
  if (!user.rows[0]?.user_id) return null;
  const created = await query(`SELECT auth.create_workspace($1, $2) AS id`, [
    user.rows[0].user_id,
    String(link.orgName || 'Qlix workspace').slice(0, 80),
  ]);
  const membership = await loadMembership(created.rows[0].id);
  return membership?.workspace_id ?? null;
}

/**
 * Qlix: someone turned the Orbit plugin on in a Qlix org (webhook tenant.link_requested, or a
 * pending link found by the catch-up poll). Link it to an Orbit workspace and make sure the
 * two agents exist. A re-link (plugin off then on) reuses the agents already created.
 */
export async function handleLinkRequested(link) {
  if (!link?.linkId) return { skipped: 'no linkId' };
  if (linking.has(link.linkId)) return { skipped: 'already in progress' };
  linking.add(link.linkId);
  try {
    const workspaceId = await workspaceForLink(link);
    if (!workspaceId) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[qlix] link ${link.linkId}: no Orbit workspace or account for ${link.requestedByEmail ?? 'unknown email'}`);
      }
      return { skipped: 'no matching Orbit workspace' };
    }
    const row = await ensureRow(workspaceId);
    let tenantKey = row.tenant_key_enc ? decryptSecret(row.tenant_key_enc) : null;
    try {
      const out = await completeLink(link.linkId, workspaceId);
      tenantKey = out.apiKey;
      await patchRow(workspaceId, {
        tenant_key_enc: encryptSecret(tenantKey),
        qlix_org_id: out.orgId ?? link.orgId ?? null,
        qlix_link_id: link.linkId,
        qlix_org_name: link.orgName ?? row.qlix_org_name ?? null,
        link_mode: row.link_mode === 'created' ? 'created' : 'linked',
        waiting_email: null,
        connect_url: null,
      });
    } catch (e) {
      // Completed already (webhook and poll both saw it): fine if we hold the key.
      if (!(e.code === 'link_not_pending' && tenantKey)) {
        await failRow(workspaceId, row, e);
        throw e;
      }
    }
    await ensureAgents(workspaceId, row, tenantKey);
    await patchRow(workspaceId, { status: 'active', last_error: null });
    return { linked: true, workspaceId };
  } finally {
    linking.delete(link.linkId);
  }
}

/** Qlix: the Orbit plugin was turned off in that org. Stop using the agents; delete nothing. */
export async function handlePaused(event) {
  const workspaceId = event?.externalOrgId;
  if (!workspaceId || !UUID.test(workspaceId)) return { skipped: 'unknown externalOrgId' };
  await asSystem(workspaceId, (c) =>
    c.query(`UPDATE workspace_qlix SET status = 'paused', updated_at = now() WHERE status <> 'disabled'`),
  );
  return { paused: true, workspaceId };
}

/** Catch up on webhooks Orbit missed: complete pending links and mark paused ones. */
export async function syncQlixLinks() {
  if (!qlixConfigured()) return { skipped: 'not configured' };
  const { links = [] } = await listLinks();
  const results = [];
  for (const link of links) {
    try {
      if (link.status === 'pending_link') results.push(await handleLinkRequested(link));
      else if (link.status === 'paused' && link.externalOrgId) results.push(await handlePaused(link));
    } catch (e) {
      results.push({ error: e.message, linkId: link.linkId });
    }
  }
  return { checked: links.length, results };
}

/**
 * Qlix webhook signature: X-Qlix-Signature "t=<unix seconds>,v1=<hex>",
 * v1 = HMAC_SHA256(secret, `${t}.${rawBody}`), and t no older than 5 minutes.
 */
export function verifyQlixSignature(rawBody, header, secret = config.qlix.webhookSecret, now = Date.now()) {
  if (!secret || !rawBody || typeof header !== 'string') return false;
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > 300 || !/^[0-9a-f]+$/i.test(parts.v1 ?? '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

registerJob('qlix_provision', async (_client, _payload, job) => {
  // Not configured (e.g. local dev without Qlix): leave the row 'pending' and stop retrying.
  if (!qlixConfigured()) return;
  await provisionWorkspace(job.workspace_id);
});

/** Turn off the workspace's Qlix org when the workspace is closed. Best effort. */
export async function disableWorkspaceQlix(client, workspaceId) {
  const row = await loadRow(client);
  if (!row || row.status === 'disabled' || !row.qlix_org_id || !qlixConfigured()) return;
  try {
    await disableTenant(workspaceId);
    await client.query(`UPDATE workspace_qlix SET status = 'disabled', updated_at = now()`);
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.error('[qlix] disable failed', workspaceId, e.message);
  }
}

/** Pick up an accepted / expired invitation from Qlix. Best effort: Settings still loads without it. */
async function refreshOwnerInvite(client, row, workspaceId) {
  if (row?.owner_invite_status !== 'pending' || !row.owner_invite_email || !qlixConfigured()) return row;
  try {
    const { invitations = [] } = await listTenantInvitations(workspaceId);
    const latest = invitations
      .filter((i) => String(i.email).toLowerCase() === row.owner_invite_email.toLowerCase())
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    if (latest && latest.status !== row.owner_invite_status) {
      await client.query(`UPDATE workspace_qlix SET owner_invite_status = $1, updated_at = now()`, [latest.status]);
      return { ...row, owner_invite_status: latest.status };
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'test') console.warn('[qlix] invite status unavailable', e.message);
  }
  return row;
}

const AGENT_PURPOSE = {
  assistant: 'Answers Agent chat and WhatsApp',
  report: 'Writes report summaries',
  meeting: 'Attends meetings and writes summaries',
};

/** Owner view (Settings): never includes secrets (the password comes only from revealOwnerLogin). */
export async function qlixStatus(client, { workspaceId } = {}) {
  let row = await loadRow(client);
  if (workspaceId) row = await refreshOwnerInvite(client, row, workspaceId);
  let orgName = row?.qlix_org_name ?? null;
  if (!orgName && row?.qlix_org_id && row.link_mode !== 'linked') {
    // Orbit names the orgs it creates after the workspace.
    const { rows } = await client.query(`SELECT name FROM workspaces WHERE id = app_workspace()`);
    orgName = rows[0]?.name ?? null;
  }
  const loginEmail = row?.owner_login_email ?? row?.owner_invite_email ?? null;
  return {
    configured: qlixConfigured(),
    status: row?.status ?? 'not_started',
    org_id: row?.qlix_org_id ?? null,
    org_name: orgName,
    agents: row
      ? [
          { kind: 'assistant', name: AGENTS.assistant.name, purpose: AGENT_PURPOSE.assistant, id: row.assistant_agent_id },
          { kind: 'report', name: AGENTS.report.name, purpose: AGENT_PURPOSE.report, id: row.report_agent_id },
          { kind: 'meeting', name: AGENTS.meeting.name, purpose: AGENT_PURPOSE.meeting, id: row.meeting_agent_id },
        ]
      : [],
    last_error: row?.status === 'failed' ? row.last_error : null,
    link_mode: row?.link_mode ?? null,
    // waiting_link: the owner already uses Qlix and turns the Orbit plugin on there to connect.
    connect_url: row?.status === 'waiting_link' ? row.connect_url ?? config.qlix.consoleUrl ?? null : null,
    waiting_email: row?.status === 'waiting_link' ? row.waiting_email : null,
    console_url: config.qlix.consoleUrl || null,
    owner_invite: row?.owner_invite_status
      ? { status: row.owner_invite_status, email: row.owner_invite_email, invited_at: row.owner_invited_at }
      : null,
    login: loginEmail
      ? {
          email: loginEmail,
          // Orbit can show the password only after it has set it (the first one was chosen in Qlix).
          password_known: Boolean(row.owner_password_enc),
          password_set_at: row.owner_password_set_at ?? null,
          // Orbit manages the login only for orgs it created; a linked org's accounts are the customer's.
          managed_by_orbit: row.link_mode !== 'linked',
        }
      : null,
    updated_at: row?.updated_at ?? null,
  };
}

/** Owner: the Qlix login Orbit set, password included (asked for explicitly, never in status). */
export async function revealOwnerLogin(client) {
  const row = await loadRow(client);
  const email = row?.owner_login_email ?? row?.owner_invite_email ?? null;
  if (!email) return { error: { code: 'no_login', status: 404, message: 'There is no Qlix login for this workspace yet.' } };
  return {
    email,
    password: row.owner_password_enc ? decryptSecret(row.owner_password_enc) : null,
    password_set_at: row.owner_password_set_at ?? null,
  };
}

const PASSWORD_WORDS = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generatePassword(length = 16) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (const b of bytes) out += PASSWORD_WORDS[b % PASSWORD_WORDS.length];
  return out;
}

const PASSWORD_PROBLEMS = {
  not_member: 'That email has not joined the Qlix organisation yet. Open your Qlix sign-in link first, then set the password here.',
  not_partner_managed: 'This Qlix account belongs to you, not to Orbit. Change its password in Qlix.',
  weak_password: 'Qlix rejected the password as too weak. Use at least 12 characters.',
  password_too_long: 'Qlix allows at most 72 characters.',
  not_found: 'Qlix does not know this workspace. Check the connection first.',
};

/**
 * Owner: set a new Qlix password (typed, or generated when empty). Orbit sends it to Qlix and
 * keeps an encrypted copy so it can show it again in Settings.
 */
export async function setOwnerPassword(client, membership, { password } = {}) {
  const row = await loadRow(client);
  if (!row || row.status !== 'active') {
    return { error: { code: 'not_connected', status: 409, message: 'Qlix is not connected for this workspace.' } };
  }
  if (row.link_mode === 'linked') {
    return { error: { code: 'not_partner_managed', status: 409, message: PASSWORD_PROBLEMS.not_partner_managed } };
  }
  const email = row.owner_login_email ?? row.owner_invite_email;
  if (!email) {
    return { error: { code: 'no_login', status: 409, message: 'Get your Qlix login first, then set its password here.' } };
  }
  // Qlix only accepts a password for a member who has joined (invite accepted).
  if (row.owner_invite_status && row.owner_invite_status !== 'accepted') {
    return {
      error: {
        code: 'not_member',
        status: 409,
        message: 'Open your Qlix sign-in link first. You can set the password here once you have joined.',
      },
    };
  }
  const chosen = typeof password === 'string' && password.length ? password : generatePassword();
  // Qlix's limits are 8–72 characters (72 is its hashing limit); Orbit asks for at least 12.
  if (chosen.length < 12 || chosen.length > 72) {
    return {
      error: { code: chosen.length > 72 ? 'password_too_long' : 'weak_password', status: 400, message: 'Use between 12 and 72 characters.' },
    };
  }
  try {
    await setMemberPassword(membership.workspace_id, { email, password: chosen });
  } catch (e) {
    // A bare 404 with no Qlix error code = this Qlix doesn't have the endpoint yet.
    if (e.status === 404 && e.code === 'qlix_error') {
      return {
        error: {
          code: 'qlix_unsupported',
          status: 501,
          message: 'This Qlix server cannot change passwords from Orbit yet. Nothing was changed.',
        },
      };
    }
    const message = PASSWORD_PROBLEMS[e.code] ?? `Qlix could not change the password: ${e.message}`;
    const status = e.status === 400 ? 400 : e.status === 404 ? 404 : 409;
    return { error: { code: e.code ?? 'qlix_error', status, message } };
  }
  await client.query(
    `UPDATE workspace_qlix
       SET owner_login_email = $1, owner_password_enc = $2, owner_password_set_at = now(), updated_at = now()`,
    [email, encryptSecret(chosen)],
  );
  return { email, password: chosen, password_set_at: new Date().toISOString() };
}

const INVITE_PROBLEMS = {
  email_in_other_org:
    'Your email already belongs to another Qlix organisation, and one email can belong to only one. Sign in there, or ask your Qlix administrator to free the email.',
  invalid_role: 'Qlix refused the invitation role.',
  not_found: 'Qlix does not know this workspace yet. Try "Set up now" first.',
};

/**
 * Owner: get a Qlix login for their workspace's org. Qlix sends no email, so the one-time
 * invite link comes straight back here and is shown to the owner in Settings.
 */
export async function inviteOwner(client, membership) {
  const row = await loadRow(client);
  if (!row || row.status !== 'active') {
    return { error: { code: 'not_connected', status: 409, message: 'Qlix is not connected for this workspace yet.' } };
  }
  if (row.link_mode === 'linked') {
    return {
      error: {
        code: 'linked_org',
        status: 409,
        message: 'This workspace is connected to your own Qlix organisation. Sign in to Qlix with your existing account.',
      },
    };
  }
  if (!membership.email) {
    return { error: { code: 'no_email', status: 400, message: 'Your Orbit account has no email address.' } };
  }
  let out;
  try {
    out = await inviteToTenant(membership.workspace_id, { email: membership.email, role: 'owner' });
  } catch (e) {
    if (e.code === 'already_member' || e.code === 'owner_exists') {
      await client.query(
        `UPDATE workspace_qlix SET owner_invite_status = 'accepted', owner_invite_email = coalesce(owner_invite_email, $1), updated_at = now()`,
        [membership.email],
      );
      return { already: true, message: 'This Qlix organisation already has its owner. Sign in to Qlix with that account.' };
    }
    const message = INVITE_PROBLEMS[e.code] ?? `Qlix could not create the invitation: ${e.message}`;
    return { error: { code: e.code ?? 'qlix_error', status: e.status === 404 ? 404 : 409, message } };
  }
  await client.query(
    `UPDATE workspace_qlix
       SET owner_invited_at = now(), owner_invite_status = 'pending', owner_invite_email = $1,
           owner_login_email = $1, updated_at = now()`,
    [membership.email],
  );
  return { invite_url: out.inviteUrl, expires_at: out.expiresAt, email: out.email ?? membership.email };
}

/** The workspace's Qlix connection state, for messages when no agent is usable. */
export async function workspaceQlixState(workspaceId) {
  if (!workspaceId) return 'not_started';
  const row = await asSystem(workspaceId, loadRow);
  return row?.status ?? 'not_started';
}

/**
 * Credentials for one agent turn, handed only to the agent runner (service-secret route).
 * Returns null when the workspace's Qlix org is not active yet.
 */
export async function runnerCredentials(workspaceId, { profile, channel, membershipId, meetingId }) {
  if (!workspaceId) return null;
  let row = await asSystem(workspaceId, loadRow);
  if (!row || row.status !== 'active') return null;
  const kind = PROFILE_AGENT[profile] ?? 'assistant';
  // Workspaces provisioned before this agent kind existed get it on first use.
  if (!row[`${kind}_agent_id`]) row = await ensureMissingAgents(workspaceId, row);
  if (!row?.[`${kind}_agent_id`]) return null;
  const ch = CHANNELS.has(channel) ? channel : 'web';
  if (kind === 'meeting') {
    // One Qlix conversation per meeting (questions during the call and the summary share it).
    const { rows } = await asSystem(workspaceId, (c) =>
      c.query(`SELECT qlix_conversation_id FROM meetings WHERE id = $1`, [meetingId]),
    );
    if (!rows[0]) return null;
    return {
      backend_url: config.qlix.backendUrl,
      agent_id: row.meeting_agent_id,
      runner_token: decryptSecret(row.meeting_runner_token_enc),
      agent_kind: 'meeting',
      channel: 'meeting',
      meeting_id: meetingId,
      conversation_id: rows[0].qlix_conversation_id ?? null,
    };
  }
  return {
    backend_url: config.qlix.backendUrl,
    agent_id: row[`${kind}_agent_id`],
    runner_token: decryptSecret(row[`${kind}_runner_token_enc`]),
    agent_kind: kind,
    channel: ch,
    // One Qlix conversation per agent, channel and person: runs group sensibly on the Qlix
    // dashboard, and two people's turns never share (and steer into) one conversation.
    conversation_id: row.conversation_ids?.[conversationKey(kind, ch, membershipId)] ?? null,
  };
}

const conversationKey = (kind, channel, membershipId) => `${kind}:${channel}:${membershipId ?? 'shared'}`;

/** The runner created a Qlix conversation for this agent + channel + person; remember it. */
export async function saveConversationId(workspaceId, { agentKind, channel, membershipId, conversationId, meetingId }) {
  if (!workspaceId || !conversationId || !CHANNELS.has(channel) || !AGENTS[agentKind]) return;
  if (agentKind === 'meeting') {
    if (!UUID.test(String(meetingId ?? ''))) return;
    await asSystem(workspaceId, (client) =>
      client.query(`UPDATE meetings SET qlix_conversation_id = $2 WHERE id = $1 AND qlix_conversation_id IS NULL`, [
        meetingId,
        String(conversationId).slice(0, 80),
      ]),
    );
    return;
  }
  if (membershipId && !/^[0-9a-f-]{36}$/i.test(String(membershipId))) return;
  await asSystem(workspaceId, (client) =>
    client.query(
      `UPDATE workspace_qlix
         SET conversation_ids = conversation_ids || jsonb_build_object($1::text, $2::text), updated_at = now()`,
      [conversationKey(agentKind, channel, membershipId), String(conversationId).slice(0, 80)],
    ),
  );
}
