/** 61 KPI register — codes from build spec; targets only where report states figures. */

function deriveSeedBands(target, direction) {
  if (target == null) return { green_at: null, amber_at: null };
  if (direction === 'lower_is_better') {
    return { green_at: target, amber_at: Math.round((target / 0.8) * 100) / 100 };
  }
  return { green_at: target, amber_at: Math.round(target * 0.8 * 100) / 100 };
}

function kpi(code, name, opts = {}) {
  const direction = opts.direction ?? 'higher_is_better';
  const target = opts.target ?? null;
  const bands = deriveSeedBands(target, direction);
  return {
    code,
    name,
    unit: opts.unit ?? 'count',
    owned_at_level: opts.level ?? 'member',
    ownerKey: opts.ownerKey,
    how_often: opts.how_often ?? 'Every day',
    direction,
    rollup_method: opts.rollup ?? 'manual',
    target,
    green_at: bands.green_at,
    amber_at: bands.amber_at,
    source_tag: opts.source ?? 'derived',
    rationale: opts.rationale ?? `Seeded from portfolio report for ${code}.`,
    for_org_id: opts.forOrgSlug ?? null,
  };
}

export const KPI_DEFS = [
  // TMS — 8
  kpi('tms.complaints', 'Complaints logged and closed', { level: 'member', ownerKey: 'm_tms_1', how_often: 'Every day', source: 'derived' }),
  kpi('tms.qr_tagged', 'Assets QR-tagged', { level: 'member', ownerKey: 'm_tms_1', how_often: 'Every day', source: 'derived' }),
  kpi('tms.resolution_hrs', 'Complaint resolution hours', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every day', unit: 'hours', direction: 'lower_is_better', source: 'derived' }),
  kpi('tms.esc_breach', 'Escalation breaches', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every day', direction: 'lower_is_better', source: 'derived' }),
  kpi('tms.clients', 'Active institutional clients', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every month', source: 'derived' }),
  kpi('tms.impl', 'Implementations in progress', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every week', source: 'derived' }),
  kpi('tms.amc', 'AMC renewals', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every month', source: 'derived' }),
  kpi('tms.revenue', 'Revenue (INR)', { level: 'manager', ownerKey: 'm_tms_lead', how_often: 'Every month', unit: 'INR', source: 'derived' }),

  // Unreal ATC — 9
  kpi('uatc.certified', 'Learners certified', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every month', source: 'report' }),
  kpi('uatc.batches', 'Training batches run', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every month', source: 'report' }),
  kpi('uatc.session_hrs', 'Training session hours', { level: 'member', ownerKey: 'm_uatc_1', how_often: 'Every week', unit: 'hours', rollup: 'sum', source: 'derived' }),
  kpi('uatc.utilisation', 'Lab utilisation', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every week', unit: '%', source: 'derived' }),
  kpi('uatc.corporate', 'Corporate training programmes', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every month', source: 'report' }),
  kpi('uatc.fdp', 'Faculty development programmes', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every quarter', source: 'report' }),
  kpi('uatc.project_value', 'Custom AR/VR project value (INR)', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every month', unit: 'INR', source: 'derived' }),
  kpi('uatc.partners', 'Institutional partners', { level: 'manager', ownerKey: 'm_uatc_lead', how_often: 'Every quarter', source: 'report' }),
  kpi('uatc.tasks', 'Associate task completion', { level: 'member', ownerKey: 'm_uatc_1', how_often: 'Every week', source: 'derived' }),

  // Sonastar3Dx — 8
  kpi('s3dx.drawings', 'Drawings delivered', { level: 'member', ownerKey: 'm_s3dx_1', how_often: 'Every week', rollup: 'sum', source: 'report' }),
  kpi('s3dx.projects', 'Active projects', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every week', source: 'derived' }),
  kpi('s3dx.on_time', 'On-time delivery rate', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every month', unit: '%', rollup: 'latest', source: 'report' }),
  kpi('s3dx.first_pass', 'First-pass quality rate', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every month', unit: '%', rollup: 'latest', source: 'derived' }),
  kpi('s3dx.rework', 'Rework hours', { level: 'member', ownerKey: 'm_s3dx_1', how_often: 'Every week', unit: 'hours', direction: 'lower_is_better', rollup: 'sum', source: 'derived' }),
  kpi('s3dx.billable', 'Billable hours', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every week', unit: 'hours', rollup: 'sum', source: 'derived' }),
  kpi('s3dx.revenue', 'Revenue (INR)', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every month', unit: 'INR', source: 'derived' }),
  kpi('s3dx.cad_training', 'CAD training sessions', { level: 'manager', ownerKey: 'm_s3dx_lead', how_often: 'Every month', source: 'report' }),

  // PATS — 9
  kpi('pats.acres', 'Acres sprayed', { level: 'member', ownerKey: 'm_pats_1', how_often: 'Every day', unit: 'acres', rollup: 'sum', target: 12, source: 'report', rationale: 'Report reference 12–16 acres/day; target set at 12.' }),
  kpi('pats.completions', 'Service completions', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every day', rollup: 'sum', source: 'derived' }),
  kpi('pats.collected', 'Payment collection rate', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every day', unit: '%', target: 100, source: 'report' }),
  kpi('pats.price_acre', 'Average price per acre (INR)', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every week', unit: 'INR', rollup: 'latest', source: 'report' }),
  kpi('pats.serviceable', 'Drone serviceability', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every day', unit: '%', source: 'derived' }),
  kpi('pats.pipeline', 'Bookings pipeline (acres)', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every week', unit: 'acres', source: 'derived' }),
  kpi('pats.demos', 'Village demonstrations held', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every week', source: 'report' }),
  kpi('pats.contracts', 'FPO and enterprise contracts', { level: 'manager', ownerKey: 'm_pats_lead', how_often: 'Every month', source: 'report' }),
  kpi('pats.flight_hrs', 'Flight hours', { level: 'member', ownerKey: 'm_pats_1', how_often: 'Every day', unit: 'hours', rollup: 'sum', source: 'derived' }),

  // SAI Foundation — 9
  kpi('sai.incubated', 'Startups incubated', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every month', target: 40, source: 'report', rationale: 'Report goal 40 by 2026; current 14+.' }),
  kpi('sai.pipeline', 'Startups in pipeline', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every month', target: 4, source: 'report' }),
  kpi('sai.founder_network', 'Founder network size', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every quarter', target: 100, source: 'report' }),
  kpi('sai.power_on_me', 'Power On Me events', { level: 'member', ownerKey: 'm_sai_1', how_often: 'Every month', source: 'report' }),
  kpi('sai.validation_camps', 'Idea validation camps', { level: 'member', ownerKey: 'm_sai_1', how_often: 'Every quarter', source: 'report' }),
  kpi('sai.applications', 'Grant applications submitted', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every month', source: 'derived' }),
  kpi('sai.funding', 'Funding secured (INR)', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every quarter', unit: 'INR', source: 'derived' }),
  kpi('sai.mentor_sessions', 'Mentor sessions delivered', { level: 'member', ownerKey: 'm_sai_1', how_often: 'Every week', source: 'derived' }),
  kpi('sai.funnel', 'Funnel stage progression', { level: 'manager', ownerKey: 'm_sai_lead', how_often: 'Every month', source: 'report' }),

  // Communications — 9 (for_org dimension on deliverables)
  kpi('comms.posts', 'Social posts published', { level: 'member', ownerKey: 'm_comms_1', how_often: 'Every week', forOrgSlug: 'tms', source: 'derived' }),
  kpi('comms.reach', 'Social reach', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every week', source: 'derived' }),
  kpi('comms.leads', 'Leads generated', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every week', source: 'derived' }),
  kpi('comms.creatives', 'Creatives delivered', { level: 'member', ownerKey: 'm_comms_s1', how_often: 'Every week', source: 'derived' }),
  kpi('comms.turnaround', 'Turnaround time (hours)', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every week', unit: 'hours', direction: 'lower_is_better', source: 'report' }),
  kpi('comms.requests', 'Service requests fulfilled', { level: 'member', ownerKey: 'm_comms_1', how_often: 'Every week', source: 'derived' }),
  kpi('comms.event_effect', 'Event promotion effectiveness', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every month', source: 'derived' }),
  kpi('comms.media', 'Media mentions', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every month', source: 'derived' }),
  kpi('comms.web', 'Website sessions', { level: 'manager', ownerKey: 'm_comms_lead', how_often: 'Every week', source: 'derived' }),

  // SCALE — 9
  kpi('scale.enrolled', 'Learners enrolled', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every month', source: 'report' }),
  kpi('scale.sessions', 'Programme sessions delivered', { level: 'member', ownerKey: 'm_scale_1', how_often: 'Every week', source: 'derived' }),
  kpi('scale.programmes', 'Active programmes', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every month', source: 'report' }),
  kpi('scale.placements', 'Placement conversions', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every quarter', rollup: 'manual', source: 'derived' }),
  kpi('scale.partnerships', 'Industry partnerships', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every quarter', source: 'report' }),
  kpi('scale.corp_innovation', 'Corporate innovation engagements', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every quarter', source: 'report' }),
  kpi('scale.learners_supported', 'Learners supported', { level: 'vice_manager', ownerKey: 'm_scale_vl', how_often: 'Every month', source: 'derived' }),
  kpi('scale.cross_portfolio', 'Cross-portfolio programmes', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every quarter', source: 'report' }),
  kpi('scale.revenue', 'Revenue (INR)', { level: 'manager', ownerKey: 'm_scale_lead', how_often: 'Every month', unit: 'INR', source: 'tbd', rationale: 'SCALE revenue model pending Thyagu/Venugopal ruling.' }),
];
