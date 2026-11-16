/*
 * Thin HTTP client for the Qlix backend (qlix-monorepo/backend-adk), product-agnostic endpoints only:
 *   - partner control plane  /api/v1/partners/*            (Authorization: Bearer <partner key>)
 *   - tenant API             /api/v1/agents                (X-API-Key: <tenant key>)
 *   - hybrid runner          /api/v1/agents/:id/runner/*, /runs/:runId/*   (X-QLIX-Runner-Token)
 * Nothing here is Portfolio-specific inside Qlix: Orbit is just one partner (AGENTS.md).
 */
import { config } from '../../core/config.js';

const TIMEOUT_MS = 20_000;

export class QlixError extends Error {
  constructor(message, { status = 0, code = 'qlix_error', details = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    /** Extra fields Qlix sent with the error, e.g. connectUrl on qlix_workspace_exists. */
    this.details = details;
  }
}

export function qlixConfigured() {
  return Boolean(config.qlix.backendUrl && config.qlix.partnerKey);
}

async function call(path, { method = 'GET', headers = {}, body, baseUrl = config.qlix.backendUrl } = {}) {
  if (!baseUrl) throw new QlixError('QLIX_BACKEND_URL is not set', { code: 'not_configured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${baseUrl}/api/v1${path}`, {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new QlixError(`Qlix unreachable at ${baseUrl} (${e.name === 'AbortError' ? 'timeout' : e.message})`, {
      code: 'unreachable',
    });
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new QlixError(data?.error?.message ?? `Qlix ${method} ${path} failed (${res.status})`, {
      status: res.status,
      code: data?.error?.code ?? 'qlix_error',
      details: data?.error ?? {},
    });
  }
  return data;
}

const partner = () => ({ Authorization: `Bearer ${config.qlix.partnerKey}` });

/**
 * Create the Qlix org for one workspace. Throws QlixError:
 *   409 already_provisioned   — this workspace already has an org (recover with rotateTenantKey)
 *   409 qlix_workspace_exists — the owner already uses Qlix; details.connectUrl is where they
 *                               turn the Orbit plugin on, which links their existing org.
 */
export function createTenant({ workspaceId, name, ownerEmail }) {
  return call('/partners/tenants', {
    method: 'POST',
    headers: { ...partner(), 'Idempotency-Key': `orbit-tenant-${workspaceId}` },
    body: { externalOrgId: workspaceId, name, ownerEmail },
  });
}

/** Issue a fresh tenant API key (the old one stops working). Used to recover an existing tenant. */
export function rotateTenantKey(workspaceId) {
  return call(`/partners/tenants/${encodeURIComponent(workspaceId)}/rotate-key`, {
    method: 'POST',
    headers: partner(),
  });
}

export function disableTenant(workspaceId) {
  return call(`/partners/tenants/${encodeURIComponent(workspaceId)}`, { method: 'DELETE', headers: partner() });
}

/** Create a hybrid agent in the tenant's org; returns { agentId, runnerToken } (token shown once). */
export async function createHybridAgent(tenantKey, { name, description }) {
  const out = await call('/agents', {
    method: 'POST',
    headers: { 'X-API-Key': tenantKey },
    body: {
      name,
      description,
      permissionScopes: ['web.read'],
      runtime: 'hybrid',
      model: config.qlix.agentModel,
      llmMode: 'proxy',
      localInferenceMode: null,
      clientPlatform: 'linux',
    },
  });
  const agentId = out?.agent?.id;
  const runnerToken = out?.sdkAgentFile?.runner_token;
  if (!agentId || !runnerToken) throw new QlixError('Qlix did not return an agent id and runner token');
  return { agentId, runnerToken };
}

/**
 * Invite a person into the workspace's Qlix org (Qlix partner API). Qlix sends no email: the
 * returned `inviteUrl` is shown once and is Orbit's to deliver. Re-inviting the same email
 * replaces the old link ("resend").
 */
export function inviteToTenant(workspaceId, { email, role }) {
  return call(`/partners/tenants/${encodeURIComponent(workspaceId)}/invitations`, {
    method: 'POST',
    headers: partner(),
    body: { email, role },
  });
}

/**
 * Set the Qlix password of a member of a tenant org Orbit created (Qlix partner API, see
 * docs/qlix-partner-invite-spec.md). Qlix refuses it for linked orgs, whose accounts belong to
 * the customer (403 not_partner_managed).
 */
export function setMemberPassword(workspaceId, { email, password }) {
  return call(`/partners/tenants/${encodeURIComponent(workspaceId)}/members/password`, {
    method: 'POST',
    headers: partner(),
    body: { email, password },
  });
}

/** { invitations: [{ invitationId, email, role, status, expiresAt, createdAt }] } */
export function listTenantInvitations(workspaceId) {
  return call(`/partners/tenants/${encodeURIComponent(workspaceId)}/invitations`, { headers: partner() });
}

/** Link an existing Qlix org (plugin turned on there) to this workspace. Returns { apiKey, orgId, ... }. */
export function completeLink(linkId, externalOrgId) {
  return call(`/partners/links/${encodeURIComponent(linkId)}/complete`, {
    method: 'POST',
    headers: partner(),
    body: { externalOrgId },
  });
}

/** Partner links and their state: active | pending_link | paused | deactivated. */
export function listLinks(status) {
  return call(`/partners/links${status ? `?status=${encodeURIComponent(status)}` : ''}`, { headers: partner() });
}

export function listAgents(tenantKey) {
  return call('/agents', { headers: { 'X-API-Key': tenantKey } });
}
