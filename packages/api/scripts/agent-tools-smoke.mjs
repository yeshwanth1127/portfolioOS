/**
 * Smoke test: POST /agent/tools/portfolio_os for owner, manager, and member.
 * Run API on localhost:4001 with seeded DB (password password123).
 */
const API = process.env.API_URL ?? 'http://localhost:4001';

async function login(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`login ${email}: ${JSON.stringify(data)}`);
  return data.token;
}

async function tool(token, body) {
  const res = await fetch(`${API}/agent/tools/portfolio_os`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`tool ${body.action}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const period = new Date().toISOString().slice(0, 10);
  const ownerToken = await login('owner@portfolio.local');
  const managerToken = await login('indhumathi@portfolio.local');
  const memberToken = await login('harini@portfolio.local');

  const orgs = await tool(ownerToken, { action: 'list_orgs' });
  if (!orgs.orgs?.length) throw new Error('list_orgs empty');

  await tool(ownerToken, { action: 'show_org', org_slug: 'tms' });
  await tool(ownerToken, { action: 'list_kpis', org_slug: 'tms' });
  await tool(managerToken, { action: 'list_people', org_slug: 'tms' });
  await tool(managerToken, { action: 'list_scores', org_slug: 'tms', from: period, to: period });
  await tool(ownerToken, { action: 'show_me' });

  const memberRecord = await tool(memberToken, {
    action: 'record_number',
    kpi_code: 'tms.complaints',
    value: 42,
    period_date: period,
    channel: 'smoke',
  });
  console.log('record_number', memberRecord);

  const kpis = await tool(ownerToken, { action: 'list_kpis', org_slug: 'tms' });
  const withGoal = kpis.kpis?.find((k) => k.goal != null);
  if (withGoal) {
    await tool(ownerToken, {
      action: 'set_target',
      kpi_code: withGoal.code,
      value: withGoal.goal,
    });
  }

  console.log('agent-tools-smoke OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
