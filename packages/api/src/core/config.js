/*
 * Service configuration with production safety checks (docs/BUILD.md § 4.9).
 * In production a missing, default or short secret stops the process at startup instead of
 * silently running with a value anyone can read in this repository.
 */
const KNOWN_DEFAULTS = new Set([
  'dev-runner-secret',
  'dev-portfolio-os-secret-change-in-prod',
  'change-me',
  'secret',
]);
const MIN_SECRET = 32;

export const isProduction = () => process.env.NODE_ENV === 'production';

/** Problems with the given secret env vars, as human-readable strings (empty = fine). */
export function secretProblems(names, env = process.env) {
  const problems = [];
  for (const name of names) {
    const value = env[name];
    if (!value) problems.push(`${name} is not set`);
    else if (KNOWN_DEFAULTS.has(value)) problems.push(`${name} uses a known development default`);
    else if (value.length < MIN_SECRET) problems.push(`${name} is shorter than ${MIN_SECRET} characters`);
  }
  return problems;
}

/** Exit (production) or warn (development) when required secrets are unsafe. */
export function assertSecrets(service, names, env = process.env) {
  const problems = secretProblems(names, env);
  if (!problems.length) return;
  const message = `[${service}] unsafe configuration: ${problems.join('; ')}`;
  if (env.NODE_ENV === 'production') {
    console.error(`${message}. Refusing to start.`);
    process.exit(1);
  }
  if (env.NODE_ENV !== 'test') console.warn(`${message} (allowed outside production).`);
}

const devFallback = (name, fallback) => process.env[name] || (isProduction() ? '' : fallback);

export const config = {
  jwtSecret: devFallback('JWT_SECRET', 'dev-portfolio-os-secret-change-in-prod'),
  runnerSecret: devFallback('AGENT_RUNNER_SECRET', 'dev-runner-secret'),
  runnerUrl: process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940',
  qlix: {
    /** Qlix backend (backend-adk), e.g. http://localhost:4000. */
    backendUrl: (process.env.QLIX_BACKEND_URL ?? '').replace(/\/$/, ''),
    /** Partner key from POST /api/v1/partners/register; enables per-workspace provisioning. */
    partnerKey: process.env.QLIX_PARTNER_KEY ?? '',
    /** whsec_… from Qlix; verifies X-Qlix-Signature on POST /qlix/webhook. */
    webhookSecret: process.env.QLIX_WEBHOOK_SECRET ?? '',
    /** Qlix console, for "Open in Qlix" links. */
    consoleUrl: (process.env.QLIX_CONSOLE_URL ?? '').replace(/\/$/, ''),
    /** Model given to newly created agents. */
    agentModel: process.env.QLIX_AGENT_MODEL || 'openrouter/qlix/auto',
  },
};

export const API_SECRETS = ['JWT_SECRET', 'AGENT_RUNNER_SECRET', 'DATABASE_URL'];
