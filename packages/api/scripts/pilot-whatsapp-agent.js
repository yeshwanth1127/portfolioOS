/**
 * Simulates WhatsApp → agent-runner → adk_new readiness query.
 * Requires: API, agent-runner, Postgres seeded, owner phone on file.
 */
const API = process.env.API_URL ?? 'http://localhost:4001';
const RUNNER = process.env.AGENT_RUNNER_URL ?? 'http://localhost:3940';

async function main() {
  const login = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'owner@portfolio.local', password: 'owner-change-me' }),
  }).then((r) => r.json());

  if (!login.membership?.id) {
    console.log('Owner login ok; add phone_e164 to user for full WA path.');
    console.log('Testing agent-runner with owner membership...');
  }

  const membershipId = login.membership.id;
  const run = await fetch(`${RUNNER}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      membership_id: membershipId,
      agent_id: 'portfolio-owner-agent',
      message: 'readiness',
      channel: 'whatsapp',
    }),
  }).then((r) => r.json());

  if (run.error) throw new Error(JSON.stringify(run));
  console.log('Agent reply:', run.reply?.slice(0, 500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
