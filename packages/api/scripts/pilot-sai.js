/**
 * SAI Foundation pilot: login as lead, member submits mentor_sessions,
 * lead validates, signoff, verify scores.
 */
import { query } from '../src/db.js';
import { hashPassword } from '../src/auth.js';

const API = process.env.API_URL ?? 'http://localhost:4001';

async function api(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}

async function main() {
  const period = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

  const lead = await api('POST', '/auth/login', null, {
    email: 'nagaraj@portfolio.local',
    password: 'lead-change-me',
  });
  const member = await api('POST', '/auth/login', null, {
    email: 'sasikumar@portfolio.local',
    password: 'member-change-me',
  });

  await api('POST', '/submissions', member.token, {
    kpi_code: 'sai.mentor_sessions',
    value: 3,
    period_date: period,
  });

  const { submissions } = await api(
    'GET',
    `/submissions?org=sai&date=${period}`,
    lead.token,
  );
  const sub = submissions.find((s) => s.kpi_code === 'sai.mentor_sessions');
  if (!sub) throw new Error('Submission not found');

  await api('POST', `/submissions/${sub.id}/validate`, lead.token, { accept: true });
  await api('POST', '/orgs/sai/signoff', lead.token, { period_date: period });

  const { scores } = await api(
    'GET',
    `/scores?org=sai&from=${period}&to=${period}`,
    lead.token,
  );
  const mentorScore = scores.find((s) => s.code === 'sai.mentor_sessions');
  console.log('Pilot SAI OK:', {
    period,
    submission_id: sub.id,
    mentor_sessions_rag: mentorScore?.rag ?? 'unscored',
  });

  const { rows } = await query(
    `SELECT count(*)::int AS c FROM signoffs s JOIN organisations o ON o.id = s.org_id WHERE o.slug = 'sai' AND s.period_date = $1`,
    [period],
  );
  if (!rows[0].c) throw new Error('Signoff missing');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
