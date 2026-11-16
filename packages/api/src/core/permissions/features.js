/**
 * Workspace plan features (Phase 8). Features arrive on membership as plan_features jsonb array.
 */

export function planFeatures(membership) {
  const raw = membership?.plan_features;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function hasFeature(membership, feature) {
  return planFeatures(membership).includes(feature);
}

/** Domain-shaped denial when a route requires a plan feature. */
export function featureDenied(membership, feature) {
  return {
    error: {
      code: 'forbidden',
      message: `Your workspace plan does not include ${feature}.`,
      feature,
      plan: membership?.plan_code ?? null,
    },
  };
}
