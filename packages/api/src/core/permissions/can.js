import { ROLE, canLockDay, canReviewSubmissions, isOwner, managesOrg } from '../../roles.js';
import { featureDenied, hasFeature } from './features.js';
import { matrixRoleAllows } from './matrix.js';

/** Catalogue / `actionAllowed`: matrix role gate only; domain uses full `can()`. */
export function canRoleGate(membership, action) {
  return matrixRoleAllows(membership?.role, action);
}

/**
 * Phase 4 scoped permission check (slice 4.0: membership + resource hints).
 *
 * @param {{ id?: string, role?: string, org_id?: string }} membership
 * @param {string} action — e.g. `submission.record`, `day.lock`
 * @param {object} [resource]
 * @param {string} [resource.kpiOwnerId] — KPI owner for `submission.record`
 * @param {{ id: string }} [resource.org] — org row for org-scoped manage actions
 * @param {boolean} [resource.isCreator] — event creator for `calendar.edit`
 * @param {string|null} [resource.eventOrgId] — event org for mgr/vice `calendar.edit`
 * @param {boolean} [resource.isHost] — meeting host for `meeting.manage`
 * @param {string|null} [resource.meetingOrgId] — meeting org for mgr/vice `meeting.manage`
 * @returns {boolean}
 */
export function can(membership, action, resource = {}) {
  if (typeof action === 'string' && action.startsWith('feature.')) {
    return hasFeature(membership, action.slice('feature.'.length));
  }
  const role = membership?.role;
  if (!role || !matrixRoleAllows(role, action)) return false;
  return applyResourceRules(action, membership, resource);
}

export function requireFeature(membership, feature) {
  if (hasFeature(membership, feature)) return null;
  return featureDenied(membership, feature);
}

function applyResourceRules(action, membership, resource) {
  switch (action) {
    case 'submission.record':
      if (membership.role === ROLE.MEMBER) {
        return resource.kpiOwnerId != null && resource.kpiOwnerId === membership.id;
      }
      return true;

    case 'submission.approve':
      return canReviewSubmissions(membership);

    case 'submission.amend':
      return true;

    case 'day.lock':
    case 'day.reopen':
      return canLockDay(membership);

    case 'kpi.edit':
      return isOwner(membership);

    case 'person.manage':
    case 'unit.manage':
    case 'invitation.create':
      return canManageOrg(membership, resource);

    case 'calendar.event.create':
    case 'meeting.create':
      return true;

    case 'meeting.manage':
      if (isOwner(membership)) return true;
      if (Boolean(resource.isHost)) return true;
      if (membership.role === ROLE.MANAGER || membership.role === ROLE.VICE_MANAGER) {
        return resource.meetingOrgId != null && membership.org_id === resource.meetingOrgId;
      }
      return false;

    case 'calendar.edit':
      if (isOwner(membership)) return true;
      if (membership.role === ROLE.TEAM_LEAD) return false;
      if (membership.role === ROLE.MEMBER) return Boolean(resource.isCreator);
      if (membership.role === ROLE.MANAGER || membership.role === ROLE.VICE_MANAGER) {
        if (resource.eventOrgId == null) return Boolean(resource.isCreator);
        return membership.org_id === resource.eventOrgId;
      }
      return false;

    case 'project.edit':
      if (isOwner(membership)) return true;
      if (Boolean(resource.isProjectManager)) return true;
      if (membership.role === ROLE.MANAGER || membership.role === ROLE.VICE_MANAGER) {
        return resource.unitOrgId != null && membership.org_id === resource.unitOrgId;
      }
      return false;

    case 'task.assign':
      if (isOwner(membership)) return true;
      if (Boolean(resource.isProjectManager)) return true;
      if (
        resource.unitOrgId != null &&
        membership.org_id === resource.unitOrgId &&
        (membership.role === ROLE.MANAGER ||
          membership.role === ROLE.VICE_MANAGER ||
          membership.role === ROLE.TEAM_LEAD)
      ) {
        return true;
      }
      return false;

    default:
      return false;
  }
}

function canManageOrg(membership, resource) {
  if (isOwner(membership)) return true;
  if (resource.org) {
    if (membership.org_id !== resource.org.id) return false;
    return managesOrg(membership, resource.org);
  }
  return membership.role === ROLE.MANAGER || membership.role === ROLE.VICE_MANAGER;
}
