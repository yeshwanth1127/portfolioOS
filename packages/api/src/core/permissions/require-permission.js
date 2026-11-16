import { can, canRoleGate } from './can.js';
import { permissionDenied } from './permission-denied.js';

/**
 * HTTP adapter: matrix role gate before domain resource rules (defence in depth).
 * Returns null when allowed, or a domain-shaped `{ error }` payload when denied.
 */
export function requireRoleGate(membership, action) {
  if (!canRoleGate(membership, action)) return permissionDenied(membership, action);
  return null;
}

/**
 * HTTP adapter when route layer already resolved resource hints.
 */
export function requirePermission(membership, action, resource = {}) {
  if (!can(membership, action, resource)) return permissionDenied(membership, action);
  return null;
}
