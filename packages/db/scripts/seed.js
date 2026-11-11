import pg from 'pg';
import { KPI_DEFS } from '../data/kpis.js';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://portfolio:portfolio@localhost:5432/portfolio_os';

const ORGS = [
  { slug: 'tms', name: 'Track My Services', short_name: 'TMS', sector: 'Operational Technology', descriptor: 'Operational Resource Planning platform', positioning: "India's first Operational Resource Planning platform", is_department: false },
  { slug: 'uatc', name: 'Unreal Authorized Training Center', short_name: 'Unreal ATC', sector: 'Immersive Technology', descriptor: 'AR/VR/MR training', positioning: 'AR/VR/MR and real-time 3D training', is_department: false },
  { slug: 's3dx', name: 'Sonastar3Dx', short_name: 'Sonastar3Dx', sector: 'Engineering Technology', descriptor: 'Aerospace, automotive and EV design', positioning: 'Aerospace, automotive and EV design', is_department: false },
  { slug: 'pats', name: 'Plantation Automation Tech Solution', short_name: 'PATS', sector: 'AgriTech', descriptor: 'Drone-as-a-Service', positioning: 'Precision Farming Made Easy', is_department: false },
  { slug: 'sai', name: 'Sona Accelerator & Incubation Foundation', short_name: 'SAI Foundation', sector: 'Startup Ecosystem', descriptor: 'Incubation and acceleration', positioning: 'Build. Validate. Scale.', is_department: false },
  { slug: 'comms', name: 'Communications Department', short_name: 'Communications', sector: 'Corporate Communications', descriptor: 'Centralised branding and promotion', positioning: 'Centralised branding, promotion and design', is_department: true },
  { slug: 'scale', name: 'Sona Centre of Advanced Learning & Entrepreneurship', short_name: 'SCALE', sector: 'Advanced Learning', descriptor: 'Industry-led learning and entrepreneurship', positioning: 'Designed by the industry, for the industry', is_department: false },
];

const DEFAULT_PASSWORD = 'password123';

const USERS = [
  { key: 'u_owner', full_name: 'Thyagu Sir', email: 'owner@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_tms_lead', full_name: 'Mrs. Indhumathi', email: 'indhumathi@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_tms_1', full_name: 'Ms. Harini', email: 'harini@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_tms_tl', full_name: 'Karthik', email: 'karthik@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_uatc_lead', full_name: 'Mr. Raj Kumar', email: 'rajkumar@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_uatc_1', full_name: 'Associate 1', email: 'uatc1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_uatc_2', full_name: 'Associate 2', email: 'uatc2@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_uatc_3', full_name: 'Associate 3', email: 'uatc3@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_uatc_4', full_name: 'Associate 4', email: 'uatc4@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_s3dx_lead', full_name: 'Ventak Raja', email: 'ventakraja@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_s3dx_1', full_name: 'Associate 1', email: 's3dx1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_s3dx_2', full_name: 'Associate 2', email: 's3dx2@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_s3dx_3', full_name: 'Associate 3', email: 's3dx3@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_pats_lead', full_name: 'Anju Raj', email: 'anjuraj@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_pats_1', full_name: 'Drone Pilot 1', email: 'pats1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_pats_2', full_name: 'Drone Pilot 2', email: 'pats2@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_pats_3', full_name: 'Drone Pilot 3', email: 'pats3@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_pats_4', full_name: 'Drone Pilot 4', email: 'pats4@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_sai_lead', full_name: 'Nagaraj', email: 'nagaraj@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_sai_1', full_name: 'Sasikumar', email: 'sasikumar@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_comms_lead', full_name: 'Abhinav', email: 'abhinav@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_comms_s1', full_name: 'Senior Team Member 1', email: 'comms_s1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_comms_s2', full_name: 'Senior Team Member 2', email: 'comms_s2@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_comms_s3', full_name: 'Senior Team Member 3', email: 'comms_s3@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_comms_1', full_name: 'Associate 1', email: 'comms1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_lead', full_name: 'Venugopal', email: 'venugopal@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_scale_vl', full_name: 'Sheelan Mam', email: 'sheelan@portfolio.local', is_named: true, password: DEFAULT_PASSWORD },
  { key: 'u_scale_1', full_name: 'Associate 1', email: 'scale1@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_2', full_name: 'Associate 2', email: 'scale2@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_3', full_name: 'Associate 3', email: 'scale3@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_4', full_name: 'Associate 4', email: 'scale4@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_5', full_name: 'Associate 5', email: 'scale5@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
  { key: 'u_scale_6', full_name: 'Associate 6', email: 'scale6@portfolio.local', is_named: false, password: DEFAULT_PASSWORD },
];

const MEMBERSHIPS = [
  { key: 'm_owner', userKey: 'u_owner', orgSlug: null, role: 'owner', title: 'Portfolio Owner', parentKey: null, state: 'active' },
  { key: 'm_tms_lead', userKey: 'u_tms_lead', orgSlug: 'tms', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_tms_tl', userKey: 'u_tms_tl', orgSlug: 'tms', role: 'team_lead', title: 'Team lead', parentKey: 'm_tms_lead', state: 'active' },
  { key: 'm_tms_1', userKey: 'u_tms_1', orgSlug: 'tms', role: 'member', title: 'Associate', parentKey: 'm_tms_tl', state: 'active' },
  { key: 'm_uatc_lead', userKey: 'u_uatc_lead', orgSlug: 'uatc', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_uatc_1', userKey: 'u_uatc_1', orgSlug: 'uatc', role: 'member', title: 'Associate', parentKey: 'm_uatc_lead', state: 'pending_name' },
  { key: 'm_uatc_2', userKey: 'u_uatc_2', orgSlug: 'uatc', role: 'member', title: 'Associate', parentKey: 'm_uatc_lead', state: 'pending_name' },
  { key: 'm_uatc_3', userKey: 'u_uatc_3', orgSlug: 'uatc', role: 'member', title: 'Associate', parentKey: 'm_uatc_lead', state: 'pending_name' },
  { key: 'm_uatc_4', userKey: 'u_uatc_4', orgSlug: 'uatc', role: 'member', title: 'Associate', parentKey: 'm_uatc_lead', state: 'pending_name' },
  { key: 'm_s3dx_lead', userKey: 'u_s3dx_lead', orgSlug: 's3dx', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_s3dx_1', userKey: 'u_s3dx_1', orgSlug: 's3dx', role: 'member', title: 'Associate', parentKey: 'm_s3dx_lead', state: 'pending_name' },
  { key: 'm_s3dx_2', userKey: 'u_s3dx_2', orgSlug: 's3dx', role: 'member', title: 'Associate', parentKey: 'm_s3dx_lead', state: 'pending_name' },
  { key: 'm_s3dx_3', userKey: 'u_s3dx_3', orgSlug: 's3dx', role: 'member', title: 'Associate', parentKey: 'm_s3dx_lead', state: 'pending_name' },
  { key: 'm_pats_lead', userKey: 'u_pats_lead', orgSlug: 'pats', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_pats_1', userKey: 'u_pats_1', orgSlug: 'pats', role: 'member', title: 'Drone Pilot', parentKey: 'm_pats_lead', state: 'pending_name' },
  { key: 'm_pats_2', userKey: 'u_pats_2', orgSlug: 'pats', role: 'member', title: 'Drone Pilot', parentKey: 'm_pats_lead', state: 'pending_name' },
  { key: 'm_pats_3', userKey: 'u_pats_3', orgSlug: 'pats', role: 'member', title: 'Drone Pilot', parentKey: 'm_pats_lead', state: 'pending_name' },
  { key: 'm_pats_4', userKey: 'u_pats_4', orgSlug: 'pats', role: 'member', title: 'Drone Pilot', parentKey: 'm_pats_lead', state: 'pending_name' },
  { key: 'm_sai_lead', userKey: 'u_sai_lead', orgSlug: 'sai', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_sai_1', userKey: 'u_sai_1', orgSlug: 'sai', role: 'member', title: 'Associate', parentKey: 'm_sai_lead', state: 'active' },
  { key: 'm_comms_lead', userKey: 'u_comms_lead', orgSlug: 'comms', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_comms_s1', userKey: 'u_comms_s1', orgSlug: 'comms', role: 'member', title: 'Senior', parentKey: 'm_comms_lead', state: 'pending_name' },
  { key: 'm_comms_s2', userKey: 'u_comms_s2', orgSlug: 'comms', role: 'member', title: 'Senior', parentKey: 'm_comms_lead', state: 'pending_name' },
  { key: 'm_comms_s3', userKey: 'u_comms_s3', orgSlug: 'comms', role: 'member', title: 'Senior', parentKey: 'm_comms_lead', state: 'pending_name' },
  { key: 'm_comms_1', userKey: 'u_comms_1', orgSlug: 'comms', role: 'member', title: 'Associate', parentKey: 'm_comms_lead', state: 'pending_name' },
  { key: 'm_scale_lead', userKey: 'u_scale_lead', orgSlug: 'scale', role: 'manager', title: 'Manager', parentKey: 'm_owner', state: 'active' },
  { key: 'm_scale_vl', userKey: 'u_scale_vl', orgSlug: 'scale', role: 'vice_manager', title: 'Vice manager', parentKey: 'm_scale_lead', state: 'active' },
  { key: 'm_scale_1', userKey: 'u_scale_1', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
  { key: 'm_scale_2', userKey: 'u_scale_2', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
  { key: 'm_scale_3', userKey: 'u_scale_3', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
  { key: 'm_scale_4', userKey: 'u_scale_4', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
  { key: 'm_scale_5', userKey: 'u_scale_5', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
  { key: 'm_scale_6', userKey: 'u_scale_6', orgSlug: 'scale', role: 'member', title: 'Associate', parentKey: 'm_scale_vl', state: 'pending_name' },
];

async function hashPassword(plain) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(`portfolio-os:${plain}`).digest('hex');
}

function orgPrefix(code) {
  return code.split('.')[0];
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  await client.query('BEGIN');
  try {
    await client.query(`
      TRUNCATE wa_outbox, wa_auth_state, agent_tool_calls, agent_sessions,
        agent_pending_confirms, amendments, scores, signoffs, submissions,
        activity_entries, kpi_audit, kpis, revenue_lines, escalations,
        org_links, partnerships, case_studies, profile_sections,
        memberships, users, organisations CASCADE;
    `);

    const orgIds = {};
    for (const o of ORGS) {
      const { rows } = await client.query(
        `INSERT INTO organisations (slug, name, short_name, sector, descriptor, positioning, is_department)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [o.slug, o.name, o.short_name, o.sector, o.descriptor, o.positioning, o.is_department],
      );
      orgIds[o.slug] = rows[0].id;
    }

    const userIds = {};
    for (const u of USERS) {
      const pw = await hashPassword(u.password);
      const { rows } = await client.query(
        `INSERT INTO users (full_name, email, password_hash, is_named)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [u.full_name, u.email, pw, u.is_named],
      );
      userIds[u.key] = rows[0].id;
    }

    const membershipIds = {};
    for (const m of MEMBERSHIPS) {
      membershipIds[m.key] = null;
    }
    for (const m of MEMBERSHIPS) {
      const orgId = m.orgSlug ? orgIds[m.orgSlug] : null;
      const parentId = m.parentKey ? membershipIds[m.parentKey] : null;
      const { rows } = await client.query(
        `INSERT INTO memberships (user_id, org_id, role, title, parent_id, state)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [userIds[m.userKey], orgId, m.role, m.title, parentId, m.state],
      );
      membershipIds[m.key] = rows[0].id;
    }

    for (const def of KPI_DEFS) {
      const slug = orgPrefix(def.code);
      const orgId = orgIds[slug];
      const ownerId = membershipIds[def.ownerKey];
      const forOrgId = def.for_org_id ? orgIds[def.for_org_id] : null;
      await client.query(
        `INSERT INTO kpis (
          org_id, code, name, unit, owned_at_level, owner_id, for_org_id,
          how_often, direction, rollup_method, target, green_at, amber_at,
          source_tag, rationale
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          orgId,
          def.code,
          def.name,
          def.unit,
          def.owned_at_level,
          ownerId,
          forOrgId,
          def.how_often,
          def.direction,
          def.rollup_method,
          def.target,
          def.green_at,
          def.amber_at,
          def.source_tag,
          def.rationale,
        ],
      );
    }

    await client.query(
      `INSERT INTO case_studies (org_id, client, title, problem, solution, outcomes)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        orgIds.tms,
        'Sona College of Technology',
        'Track My Services deployment',
        'Manual asset tracking and complaint resolution',
        'ORP mobile app with QR asset tracking',
        JSON.stringify([
          { metric: 'annual_savings_inr', value: 1500000 },
          { metric: 'inventory_skus', value: 55000 },
          { metric: 'efficiency_multiplier', value: '3-5x' },
        ]),
      ],
    );

    await client.query(
      `INSERT INTO case_studies (org_id, client, title, outcomes)
       VALUES ($1,$2,$3,$4)`,
      [
        orgIds.s3dx,
        'AEPL',
        'Aerospace drawing digitisation',
        JSON.stringify([{ metric: 'drawings', value: '200+' }]),
      ],
    );

    const s3dxPartners = [
      ['TIIC', 'Institutional'],
      ['TIDCO', 'Institutional'],
      ['Dassault Systèmes', 'Technology'],
    ];
    for (const [name, kind] of s3dxPartners) {
      await client.query(
        `INSERT INTO partnerships (org_id, name, kind) VALUES ($1,$2,$3)`,
        [orgIds.s3dx, name, kind],
      );
    }
    await client.query(
      `INSERT INTO partnerships (org_id, name, kind) VALUES ($1,$2,$3)`,
      [orgIds.uatc, 'Epic Games', 'Authorisation'],
    );

    const links = [
      ['scale', 'uatc', 'Joint programme — immersive technology training'],
      ['scale', 's3dx', 'Joint programme — CAD and engineering design'],
      ['scale', 'sai', 'Joint programme — incubation and commercialisation'],
      ['tms', 'sai', 'Operational management for incubated ventures'],
    ];
    for (const [from, to, kind] of links) {
      await client.query(
        `INSERT INTO org_links (from_org, to_org, kind) VALUES ($1,$2,$3)`,
        [orgIds[from], orgIds[to], kind],
      );
    }
    for (const slug of Object.keys(orgIds)) {
      if (slug === 'comms') continue;
      await client.query(
        `INSERT INTO org_links (from_org, to_org, kind) VALUES ($1,$2,$3)`,
        [orgIds.comms, orgIds[slug], 'Shared service'],
      );
    }

    await client.query(
      `INSERT INTO kpi_goals (kpi_id, how_often, target) SELECT id, how_often, target FROM kpis ON CONFLICT DO NOTHING`,
    );
    await client.query('COMMIT');
    console.log(`Seeded ${ORGS.length} orgs, ${USERS.length} users, ${MEMBERSHIPS.length} memberships, ${KPI_DEFS.length} KPIs.`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
