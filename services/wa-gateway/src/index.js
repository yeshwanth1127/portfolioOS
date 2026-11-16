import { createGateway } from './app.js';

const devFallback = (name, fallback) =>
  process.env[name] || (process.env.NODE_ENV === 'production' ? '' : fallback);

// Production refuses to start with missing / default / short secrets (docs/BUILD.md § 4.9).
for (const name of ['AGENT_RUNNER_SECRET', 'WA_SERVICE_SECRET', 'DATABASE_URL']) {
  const v = process.env[name];
  const bad = !v || v === 'dev-runner-secret' || (name !== 'DATABASE_URL' && v.length < 32);
  if (bad && process.env.NODE_ENV === 'production') {
    console.error(`[wa-gateway] unsafe configuration: ${name} is missing, a default, or too short. Refusing to start.`);
    process.exit(1);
  }
}

const runnerSecret = devFallback('AGENT_RUNNER_SECRET', 'dev-runner-secret');
const gateway = createGateway({
  databaseUrl: process.env.DATABASE_URL ?? 'postgresql://portfolio_app:portfolio_app@localhost:5433/portfolio_os',
  apiUrl: process.env.PORTFOLIOOS_API_URL ?? 'http://localhost:4001',
  runnerUrl: process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940',
  runnerSecret,
  serviceSecret: process.env.WA_SERVICE_SECRET ?? process.env.SERVICE_SECRET ?? runnerSecret,
  sidecarUrl: process.env.WA_SERVICE_URL ?? '',
  connectorId: process.env.WA_CONNECTOR_ID ?? '',
  ackText: process.env.WA_ACK_TEXT,
});

setInterval(() => gateway.drainOutbox().catch((e) => console.error('[wa] outbox', e.message)), 5000);

const port = Number(process.env.WA_PORT ?? 3938);
const host = process.env.WA_BIND_HOST ?? '127.0.0.1';
gateway.app.listen(port, host, () => console.log(`WA gateway on ${host}:${port}`));
