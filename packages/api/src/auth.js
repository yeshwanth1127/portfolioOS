import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-portfolio-os-secret-change-in-prod';

export function hashPassword(plain) {
  return crypto.createHash('sha256').update(`portfolio-os:${plain}`).digest('hex');
}

export async function loadMembership(membershipId) {
  const { rows } = await query(
    `SELECT m.id, m.role, m.org_id, m.user_id, m.title, m.state, m.parent_id,
            u.full_name, u.email, u.phone_e164, u.is_named,
            o.slug AS org_slug, o.short_name AS org_short_name, o.name AS org_name,
            pu.full_name AS reports_to_name, pm.role AS reports_to_role, pm.title AS reports_to_title
     FROM memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN organisations o ON o.id = m.org_id
     LEFT JOIN memberships pm ON pm.id = m.parent_id
     LEFT JOIN users pu ON pu.id = pm.user_id
     WHERE m.id = $1 AND m.state <> 'inactive'`,
    [membershipId],
  );
  return rows[0] ?? null;
}

export function signToken(membership) {
  return jwt.sign(
    {
      membership_id: membership.id,
      role: membership.role,
      org_id: membership.org_id,
    },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

export function signRunToken(membership, agentId) {
  return jwt.sign(
    {
      kind: 'agent_run',
      membership_id: membership.id,
      role: membership.role,
      org_id: membership.org_id,
      agent_id: agentId,
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
