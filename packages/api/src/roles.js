/** PortfolioOS membership roles (hierarchy within an org). */
export const ROLE = {
  OWNER: 'owner',
  MANAGER: 'manager',
  VICE_MANAGER: 'vice_manager',
  TEAM_LEAD: 'team_lead',
  MEMBER: 'member',
};

export const ROLE_LABELS = {
  owner: 'Owner',
  manager: 'Manager',
  vice_manager: 'Vice manager',
  team_lead: 'Team lead',
  member: 'Member',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] ?? role ?? '—';
}

export function isOwner(membership) {
  return membership?.role === ROLE.OWNER;
}

/** Org managers who run the organisation register / team / lock. */
export function managesOrg(membership, org) {
  if (isOwner(membership)) return true;
  if (!org || membership?.org_id !== org.id) return false;
  return membership.role === ROLE.MANAGER || membership.role === ROLE.VICE_MANAGER;
}

export function canReviewSubmissions(membership) {
  return [
    ROLE.OWNER,
    ROLE.MANAGER,
    ROLE.VICE_MANAGER,
    ROLE.TEAM_LEAD,
  ].includes(membership?.role);
}

export function canLockDay(membership) {
  return membership?.role === ROLE.OWNER || membership?.role === ROLE.MANAGER;
}

/** Roles a manager (or vice manager) may assign in their own org. */
export const MANAGER_ASSIGNABLE_ROLES = [ROLE.MEMBER, ROLE.VICE_MANAGER];

/** Roles the portfolio owner may assign in any org (includes appointing the manager). */
export const OWNER_ASSIGNABLE_ROLES = [
  ROLE.MEMBER,
  ROLE.TEAM_LEAD,
  ROLE.VICE_MANAGER,
  ROLE.MANAGER,
];

/** @deprecated Prefer assignableRolesFor(membership). */
export const ASSIGNABLE_ROLES = MANAGER_ASSIGNABLE_ROLES;

export function assignableRolesFor(membership) {
  return isOwner(membership) ? OWNER_ASSIGNABLE_ROLES : MANAGER_ASSIGNABLE_ROLES;
}

export function submissionLevelRank(level) {
  switch (level) {
    case ROLE.OWNER:
      return 5;
    case ROLE.MANAGER:
      return 4;
    case ROLE.VICE_MANAGER:
      return 3;
    case ROLE.TEAM_LEAD:
      return 2;
    default:
      return 1;
  }
}
