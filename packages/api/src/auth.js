import jwt from 'jsonwebtoken';
import { query } from './db.js';
import { config } from './core/config.js';

const JWT_SECRET = config.jwtSecret;

/**
 * The caller behind a membership id (token, run token, test). Runs before any scope exists,
 * through the auth.actor_for_membership definer function (migration 008).
 */
export async function loadMembership(membershipId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(membershipId ?? ''))) return null;
  const { rows } = await query(`SELECT * FROM auth.actor_for_membership($1)`, [membershipId]);
  return rows[0] ?? null;
}

export function signToken(membership) {
  return jwt.sign(
    {
      membership_id: membership.id,
      workspace_id: membership.workspace_id,
      role: membership.role,
      org_id: membership.org_id,
    },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

/**
 * Agent run token. `extra` carries run-scoped claims such as { profile: 'report', report_id } or
 * { profile: 'meeting', meeting_id, transcript_part }.
 */
export function signRunToken(membership, agentId, extra = {}) {
  return jwt.sign(
    {
      kind: 'agent_run',
      membership_id: membership.id,
      workspace_id: membership.workspace_id,
      role: membership.role,
      org_id: membership.org_id,
      agent_id: agentId,
      ...(extra.profile ? { profile: extra.profile } : {}),
      ...(extra.report_id ? { report_id: extra.report_id } : {}),
      ...(extra.meeting_id ? { meeting_id: extra.meeting_id } : {}),
      ...(Number.isInteger(extra.transcript_part) ? { transcript_part: extra.transcript_part } : {}),
      ...(extra.channel ? { channel: extra.channel } : {}),
    },
    JWT_SECRET,
    { expiresIn: '15m' },
  );
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function authenticateRequest(req) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  try {
    const payload = verifyToken(auth.slice(7));
    const membership = await loadMembership(payload.membership_id);
    if (!membership) return null;
    if (payload.org_id && membership.org_id && payload.org_id !== membership.org_id) {
      return null;
    }
    // A token is bound to one workspace; a moved or removed membership invalidates it.
    if (payload.workspace_id !== membership.workspace_id) return null;
    return { membership, payload };
  } catch {
    return null;
  }
}

export function assertHeadersMatch(membership, req) {
  const mid = req.headers['x-portfolioos-membership-id'];
  const role = req.headers['x-portfolioos-role'];
  const org = req.headers['x-portfolioos-org-id'];
  if (mid && mid !== membership.id) {
    throw new Error('membership header mismatch');
  }
  if (role && role !== membership.role) {
    throw new Error('role header mismatch');
  }
  if (org && membership.org_id && org !== membership.org_id) {
    throw new Error('org header mismatch');
  }
}
