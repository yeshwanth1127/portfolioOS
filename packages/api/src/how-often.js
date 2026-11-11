export const HOW_OFTEN_DEFAULT = 'Every day';

const LEGACY_CADENCE = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every quarter',
};

/** Normalise API input: accept legacy cadence codes or UI labels. */
export function normalizeHowOften(value) {
  if (!value) return HOW_OFTEN_DEFAULT;
  return LEGACY_CADENCE[value] ?? value;
}
