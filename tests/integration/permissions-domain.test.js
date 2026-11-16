import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createEnv } from '../helpers/env.js';

let env;
let Kpis;
let People;
let Calendar;

before(async () => {
  env = await createEnv();
  Kpis = await env.api('domain/kpis.js');
  People = await env.api('domain/people.js');
  Calendar = await env.api('modules/calendar.js');
});
after(async () => {
  await env.close();
});

test('kpi.register mutations deny non-owner at domain', async () => {
  const denied = await env.as(env.fx.alphaManager, (client) =>
    Kpis.addKpi(client, env.fx.alphaManager, 'alpha', { code: 'x.new', name: 'New' }),
  );
  assert.equal(denied.error?.code, 'forbidden');
  const allowed = await env.as(env.fx.owner, (client) =>
    Kpis.addKpi(client, env.fx.owner, 'alpha', { code: 'owner.kpi', name: 'Owner KPI' }),
  );
  assert.ok(allowed.kpi?.code === 'owner.kpi');
});

test('person.manage denies team lead addPerson', async () => {
  const denied = await env.as(env.fx.alphaLead, (client) =>
    People.addPerson(client, env.fx.alphaLead, 'alpha', {
      full_name: 'Blocked',
      email: 'blocked.person@test.local',
    }),
  );
  assert.equal(denied.error?.code, 'forbidden');
});

test('calendar.event.create allowed; calendar.edit scoped by creator and org', async () => {
  const start = new Date(Date.now() + 90 * 60000).toISOString();
  const end = new Date(Date.now() + 150 * 60000).toISOString();

  const created = await env.as(env.fx.owner, (client) =>
    Calendar.createEvent(client, env.fx.owner, {
      title: 'Permission probe',
      org_id: env.fx.alpha.id,
      starts_at: start,
      ends_at: end,
    }),
  );
  assert.ok(created.event?.id);
  const eventId = created.event.id;

  const memberDenied = await env.as(env.fx.alphaMember2, (client) =>
    Calendar.updateEvent(client, env.fx.alphaMember2, eventId, { title: 'Nope' }),
  );
  assert.equal(memberDenied.error?.code, 'forbidden');

  const crossOrgMgr = await env.as(env.fx.betaManager, (client) =>
    Calendar.updateEvent(client, env.fx.betaManager, eventId, { title: 'Cross org' }),
  );
  assert.ok(
    ['forbidden', 'not_found'].includes(crossOrgMgr.error?.code),
    'RLS may hide foreign-org events before calendar.edit runs',
  );

  const sameOrgMgr = await env.as(env.fx.alphaManager, (client) =>
    Calendar.updateEvent(client, env.fx.alphaManager, eventId, { title: 'Manager edit' }),
  );
  assert.equal(sameOrgMgr.event?.title, 'Manager edit');
});
