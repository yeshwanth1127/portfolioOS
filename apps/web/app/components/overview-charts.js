'use client';

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const RAG_COLORS = {
  good: '#7ccf1f',
  watch: '#e3a008',
  bad: '#d6402a',
  locked: '#6d28d9',
  open: '#d4d4da',
};

const H_TREND = 172;
const H_PIE = 168;
const H_BAR = 112;
const H_RAG_ROW = 26;
const RAG_MAX_ROWS = 4;

function formatShortDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function pctTooltip(value) {
  if (value == null || Number.isNaN(value)) return '—';
  return `${Math.round(Number(value) * 100)}%`;
}

function ChartPanel({ title, subtitle, tone, children, className = '' }) {
  return (
    <article className={`pw-analytics-panel pw-glass pw-tone-${tone} ${className}`.trim()}>
      <header className="pw-analytics-panel-head">
        <h3>{title}</h3>
        {subtitle ? <p>{subtitle}</p> : null}
      </header>
      <div className="pw-analytics-chart">{children}</div>
    </article>
  );
}

function EmptyChart({ message }) {
  return <p className="overview-muted pw-analytics-empty">{message}</p>;
}

export function PerformanceTrendChart({ series, className = '' }) {
  if (!series?.length) {
    return (
      <ChartPanel
        title="Performance trend"
        subtitle="Good-share by day (14d)"
        tone="violet"
        className={className}
      >
        <EmptyChart message="No scored KPI days in this window yet." />
      </ChartPanel>
    );
  }
  const data = series.map((p) => ({
    date: p.date,
    label: formatShortDate(p.date),
    good_share: Number(p.good_share) || 0,
  }));

  return (
    <ChartPanel
      title="Performance trend"
      subtitle="Share of KPIs in good status (14 days)"
      tone="violet"
      className={className}
    >
      <ResponsiveContainer width="100%" height={H_TREND}>
        <AreaChart data={data} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="perfFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6d28d9" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#6d28d9" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececf0" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <YAxis
            tickFormatter={(v) => `${Math.round(v * 100)}%`}
            domain={[0, 1]}
            width={38}
            tick={{ fontSize: 10 }}
            stroke="#a1a1aa"
          />
          <Tooltip
            formatter={(v) => [pctTooltip(v), 'Good share']}
            labelFormatter={(_, items) => (items?.[0]?.payload?.date ? `Day ${items[0].payload.date}` : '')}
          />
          <Area
            type="monotone"
            dataKey="good_share"
            stroke="#6d28d9"
            strokeWidth={2}
            fill="url(#perfFill)"
            dot={{ r: 2.5, fill: '#6d28d9' }}
            activeDot={{ r: 4 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function KpiHealthPie({ organisations, className = '' }) {
  const totals = (organisations?.bars ?? []).reduce(
    (acc, b) => {
      acc.good += b.good ?? 0;
      acc.watch += b.watch ?? 0;
      acc.bad += b.bad ?? 0;
      return acc;
    },
    { good: 0, watch: 0, bad: 0 },
  );
  const data = [
    { name: 'Good', value: totals.good, key: 'good' },
    { name: 'Watch', value: totals.watch, key: 'watch' },
    { name: 'Bad', value: totals.bad, key: 'bad' },
  ].filter((d) => d.value > 0);
  const total = totals.good + totals.watch + totals.bad;

  return (
    <ChartPanel
      title="KPI health"
      subtitle="Scored KPIs across organisations"
      tone="teal"
      className={className}
    >
      {total === 0 ? (
        <EmptyChart message="No scored KPIs for this day yet." />
      ) : (
        <ResponsiveContainer width="100%" height={H_PIE}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="45%"
              innerRadius={38}
              outerRadius={56}
              paddingAngle={2}
              stroke="#fff"
              strokeWidth={2}
            >
              {data.map((entry) => (
                <Cell key={entry.key} fill={RAG_COLORS[entry.key]} />
              ))}
            </Pie>
            <Tooltip formatter={(v, name) => [`${v} KPIs`, name]} />
            <Legend verticalAlign="bottom" height={28} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}

export function OrgDayStatusPie({ organisations, className = '' }) {
  const locked = organisations?.locked ?? 0;
  const open = organisations?.open ?? 0;
  const data = [
    { name: 'Closed', value: locked, key: 'locked' },
    { name: 'Open', value: open, key: 'open' },
  ].filter((d) => d.value > 0);

  return (
    <ChartPanel title="Organisation days" subtitle="As of reporting date" tone="sky" className={className}>
      {data.length === 0 ? (
        <EmptyChart message="No organisations in scope." />
      ) : (
        <ResponsiveContainer width="100%" height={H_PIE}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="45%"
              outerRadius={56}
              stroke="#fff"
              strokeWidth={2}
            >
              {data.map((entry) => (
                <Cell key={entry.key} fill={RAG_COLORS[entry.key]} />
              ))}
            </Pie>
            <Tooltip />
            <Legend verticalAlign="bottom" height={28} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}

const STAGES = [
  { key: 'locked', label: 'Closed', color: '#6d28d9' },
  { key: 'ready', label: 'Ready to close', color: '#7ccf1f' },
  { key: 'in_progress', label: 'Numbers coming in', color: '#c4b5fd' },
  { key: 'not_started', label: 'Not started', color: '#e4e4e7' },
];
const STAGE_BY_KEY = Object.fromEntries(STAGES.map((s) => [s.key, s]));

/**
 * Today by organisation: a donut of where each organisation's day stands, beside one row per
 * organisation with numbers entered against expected and daily goals met.
 */
export function OrgDayBoard({ organisations, className = '' }) {
  const rows = organisations?.today ?? [];
  const total = rows.length;
  const counts = Object.fromEntries(STAGES.map((st) => [st.key, rows.filter((r) => r.stage === st.key).length]));
  const data = STAGES.map((st) => ({ name: st.label, key: st.key, value: counts[st.key] })).filter((d) => d.value > 0);
  const entered = rows.reduce((n, r) => n + Math.min(r.entered, r.expected || r.entered), 0);
  const expected = rows.reduce((n, r) => n + (r.expected || 0), 0);

  return (
    <article className={`pw-analytics-panel pw-orgday ${className}`.trim()}>
      <header className="pw-analytics-panel-head pw-orgday-head">
        <div>
          <h3>Day by organisation</h3>
          <p>
            {counts.locked} of {total} closed · {entered} of {expected} numbers in
          </p>
        </div>
      </header>
      {total === 0 ? (
        <EmptyChart message="No organisations in scope." />
      ) : (
        <div className="pw-orgday-body">
          <figure className="pw-orgday-donut" aria-label={`${counts.locked} of ${total} organisations closed`}>
            <div className="pw-orgday-chart">
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={70}
                    outerRadius={104}
                    paddingAngle={data.length > 1 ? 2 : 0}
                    startAngle={90}
                    endAngle={-270}
                    stroke="#fff"
                    strokeWidth={3}
                    isAnimationActive={false}
                  >
                    {data.map((entry) => (
                      <Cell key={entry.key} fill={STAGE_BY_KEY[entry.key].color} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v, name) => [`${v} organisation${v === 1 ? '' : 's'}`, name]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="pw-orgday-center" aria-hidden>
                <strong>
                  {counts.locked}
                  <span>/{total}</span>
                </strong>
                <small>closed</small>
              </div>
            </div>
            <ul className="pw-orgday-legend">
              {STAGES.map((st) => (
                <li key={st.key}>
                  <i style={{ background: st.color }} />
                  <span>{st.label}</span>
                  <b>{counts[st.key]}</b>
                </li>
              ))}
            </ul>
          </figure>

          <table className="pw-orgday-table">
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Numbers in</th>
                <th>Daily goals</th>
                <th>Day</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const exp = r.expected || 0;
                const validatedPct = exp ? Math.min(100, (r.validated / exp) * 100) : 0;
                const enteredPct = exp ? Math.min(100, (r.entered / exp) * 100) : 0;
                const stage = STAGE_BY_KEY[r.stage] ?? STAGE_BY_KEY.not_started;
                return (
                  <tr key={r.slug}>
                    <td className="pw-orgday-org">{r.org}</td>
                    <td>
                      <div className="pw-orgday-progress">
                        <span className="pw-orgday-bar" role="img" aria-label={`${r.entered} of ${exp} entered, ${r.validated} validated`}>
                          <span className="pw-orgday-bar-entered" style={{ width: `${enteredPct}%` }} />
                          <span className="pw-orgday-bar-validated" style={{ width: `${validatedPct}%` }} />
                        </span>
                        <span className="pw-orgday-count">
                          {Math.min(r.entered, exp || r.entered)}/{exp}
                        </span>
                      </div>
                    </td>
                    <td className="pw-orgday-goals">
                      {r.goals_set ? (
                        <>
                          <b className={r.goals_met === r.goals_set ? 'is-good' : r.entered ? 'is-short' : ''}>
                            {r.goals_met}/{r.goals_set}
                          </b>{' '}
                          met
                        </>
                      ) : (
                        <span className="pw-orgday-none">No daily goals</span>
                      )}
                    </td>
                    <td>
                      <span className={`pw-orgday-chip pw-orgday-chip-${r.stage}`}>{stage.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

export function ReportingBarChart({ reporting, className = '' }) {
  const data = [
    { name: 'Submitted', value: reporting?.submitted ?? 0, fill: '#7ccf1f' },
    { name: 'Awaiting review', value: reporting?.awaiting_review ?? 0, fill: '#e3a008' },
    { name: 'Missing', value: reporting?.missing ?? 0, fill: '#d6402a' },
  ];

  return (
    <ChartPanel title="Reporting" subtitle="Submissions for the day" tone="amber" className={className}>
      <ResponsiveContainer width="100%" height={H_BAR}>
        <BarChart data={data} layout="vertical" margin={{ top: 2, right: 8, left: 2, bottom: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececf0" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <YAxis type="category" dataKey="name" width={92} tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <Tooltip />
          <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={18}>
            {data.map((entry) => (
              <Cell key={entry.name} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function OrgRagBarChart({ bars, className = '' }) {
  if (!bars?.length) {
    return (
      <ChartPanel title="By organisation" subtitle="Good · watch · bad" tone="indigo" className={className}>
        <EmptyChart message="No per-org scores for this day." />
      </ChartPanel>
    );
  }
  const sliced = bars.slice(0, RAG_MAX_ROWS);
  const data = sliced.map((b) => ({
    org: b.org,
    good: b.good ?? 0,
    watch: b.watch ?? 0,
    bad: b.bad ?? 0,
  }));
  const height = Math.max(72, Math.min(H_BAR + 12, data.length * H_RAG_ROW + 36));

  return (
    <ChartPanel
      title="By organisation"
      subtitle={bars.length > RAG_MAX_ROWS ? `Top ${RAG_MAX_ROWS} · good · watch · bad` : 'KPI counts by RAG'}
      tone="indigo"
      className={className}
    >
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} layout="vertical" margin={{ top: 2, right: 8, left: 2, bottom: 2 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececf0" horizontal={false} />
          <XAxis type="number" allowDecimals={false} tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <YAxis type="category" dataKey="org" width={64} tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <Tooltip />
          <Legend verticalAlign="top" height={22} wrapperStyle={{ fontSize: 10 }} />
          <Bar dataKey="good" stackId="rag" fill={RAG_COLORS.good} name="Good" radius={[0, 0, 0, 0]} />
          <Bar dataKey="watch" stackId="rag" fill={RAG_COLORS.watch} name="Watch" />
          <Bar dataKey="bad" stackId="rag" fill={RAG_COLORS.bad} name="Bad" radius={[0, 6, 6, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function DeliveryBarChart({ delivery, className = '' }) {
  if (!delivery) return null;
  const data = [
    { name: 'Open tasks', value: delivery.open_tasks ?? 0 },
    { name: 'Overdue', value: delivery.overdue_tasks ?? 0 },
    { name: 'Milestones (14d)', value: delivery.milestones_due_soon ?? 0 },
  ];

  return (
    <ChartPanel title="Delivery" subtitle="Tasks and milestones" tone="rose" className={className}>
      <ResponsiveContainer width="100%" height={H_BAR}>
        <BarChart data={data} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#ececf0" vertical={false} />
          <XAxis dataKey="name" tick={{ fontSize: 9 }} interval={0} stroke="#a1a1aa" />
          <YAxis allowDecimals={false} width={28} tick={{ fontSize: 10 }} stroke="#a1a1aa" />
          <Tooltip />
          <Bar dataKey="value" fill="#6d28d9" radius={[6, 6, 0, 0]} barSize={32} />
        </BarChart>
      </ResponsiveContainer>
    </ChartPanel>
  );
}

export function TargetAttainmentPie({ targetAttainment, className = '' }) {
  if (!targetAttainment) return null;
  const data = [
    { name: 'Good', value: targetAttainment.good ?? 0, key: 'good' },
    { name: 'Watch', value: targetAttainment.watch ?? 0, key: 'watch' },
    { name: 'Bad', value: targetAttainment.bad ?? 0, key: 'bad' },
  ].filter((d) => d.value > 0);
  const total = targetAttainment.total ?? data.reduce((s, d) => s + d.value, 0);

  return (
    <ChartPanel title="Target attainment" subtitle="KPI scores for the day" tone="sky" className={className}>
      {total === 0 ? (
        <EmptyChart message="No scored KPIs for this day." />
      ) : (
        <ResponsiveContainer width="100%" height={H_PIE}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="45%"
              innerRadius={34}
              outerRadius={52}
              stroke="#fff"
              strokeWidth={2}
            >
              {data.map((entry) => (
                <Cell key={entry.key} fill={RAG_COLORS[entry.key]} />
              ))}
            </Pie>
            <Tooltip formatter={(v, name) => [`${v} KPIs`, name]} />
            <Legend verticalAlign="bottom" height={28} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
          </PieChart>
        </ResponsiveContainer>
      )}
    </ChartPanel>
  );
}
