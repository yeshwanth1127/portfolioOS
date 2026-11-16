'use client';

import Link from 'next/link';
import {
  DeliveryBarChart,
  KpiHealthPie,
  OrgDayBoard,
  OrgRagBarChart,
  PerformanceTrendChart,
  ReportingBarChart,
  TargetAttainmentPie,
} from './overview-charts.js';

function pct(n) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${Math.round(n * 100)}%`;
}

function StatBlock({ value, label, href, tone }) {
  const cls = `pw-kpi-tile pw-glass pw-tone-${tone}${href ? ' pw-kpi-tile-link' : ''}`;
  const inner = (
    <>
      <strong>{value}</strong>
      <span>{label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cls}>
        {inner}
      </Link>
    );
  }
  return <div className={cls}>{inner}</div>;
}

const TILE_TONES = {
  orgs: 'sky',
  perf: 'violet',
  reporting: 'teal',
  approvals: 'amber',
  targets: 'rose',
  delivery: 'indigo',
};

function shiftDay(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function longDate(iso) {
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T12:00:00Z`));
}

/** Day picker for the overview: previous / next day, a calendar input, and a jump back to today. */
function DateFilter({ value, today, onChange, disabled }) {
  const isToday = value >= today;
  return (
    <div className="pw-date-filter" role="group" aria-label="Overview date">
      <button
        type="button"
        className="pw-btn-secondary pw-date-step"
        onClick={() => onChange(shiftDay(value, -1))}
        disabled={disabled}
        aria-label="Previous day"
      >
        ‹
      </button>
      <input
        id="overview-date"
        type="date"
        className="pw-date-input"
        value={value}
        max={today}
        onChange={(e) => e.target.value && onChange(e.target.value)}
        disabled={disabled}
        aria-label="Show analytics for date"
      />
      <button
        type="button"
        className="pw-btn-secondary pw-date-step"
        onClick={() => onChange(shiftDay(value, 1))}
        disabled={disabled || isToday}
        aria-label="Next day"
      >
        ›
      </button>
      {!isToday && (
        <button type="button" className="pw-btn-secondary" onClick={() => onChange(null)} disabled={disabled}>
          Today
        </button>
      )}
    </div>
  );
}

export default function OverviewV1({ data, selectedId, onSelectAttention, onRefresh, refreshing, today, onDateChange }) {
  if (!data) {
    return (
      <div className="overview-v1 overview-v1-compact loading dashboard-page">
        <p className="overview-muted">Loading overview…</p>
      </div>
    );
  }

  const {
    greeting,
    organisations,
    performance,
    reporting,
    approvals,
    attention,
    as_of: asOf,
    coverage,
    delivery,
    target_attainment: targetAttainment,
    timezone,
  } = data;
  const isToday = !today || asOf >= today;

  const kpiTiles = [
    {
      key: 'orgs',
      tone: TILE_TONES.orgs,
      value: (() => {
        const total = organisations.locked + organisations.open;
        return total ? `${organisations.locked}/${total}` : '—';
      })(),
      label: 'Orgs closed',
    },
    {
      key: 'perf',
      tone: TILE_TONES.perf,
      value: pct(performance.avg),
      label: '14d avg good',
    },
    {
      key: 'reporting',
      tone: TILE_TONES.reporting,
      value: reporting.submitted,
      label: isToday ? 'Submitted today' : 'Submitted',
    },
    {
      key: 'approvals',
      tone: TILE_TONES.approvals,
      value: approvals.pending,
      label: 'Pending approval',
    },
    {
      key: 'coverage',
      tone: TILE_TONES.perf,
      value: pct(coverage),
      label: 'KPI coverage',
    },
    {
      key: 'attention',
      tone: TILE_TONES.rose,
      value: attention.length,
      label: 'Needs attention',
    },
  ];

  if (targetAttainment) {
    kpiTiles.push({
      key: 'targets',
      tone: TILE_TONES.targets,
      value: targetAttainment.good ?? 0,
      label: 'Targets good',
      href: '/?tab=today',
    });
  }
  if (delivery) {
    kpiTiles.push({
      key: 'delivery',
      tone: TILE_TONES.delivery,
      value: delivery.open_tasks ?? 0,
      label: 'Open tasks',
      href: '/my-work',
    });
  }

  const attentionPreview = attention.slice(0, 4);

  return (
    <div className="overview-v1 overview-v1-compact dashboard-page">
      <header className="pw-page-head pw-page-head-compact">
        <div>
          <h1>Overview</h1>
          <p className="pw-page-sub">
            {greeting.part}, {greeting.name} · {greeting.summary}
          </p>
        </div>
        <div className="pw-page-actions">
          {onDateChange && today ? (
            <DateFilter value={asOf} today={today} onChange={onDateChange} disabled={refreshing} />
          ) : null}
          <Link href="/calendar" className="pw-btn-secondary pw-btn-ghost-inline">
            Calendar
          </Link>
          <button
            type="button"
            className="pw-btn-secondary"
            onClick={() => onRefresh?.()}
            disabled={refreshing}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <p className="pw-analytics-context">
        {isToday ? `Today, ${longDate(asOf)}` : `Showing ${longDate(asOf)}`}
        {timezone ? ` · ${timezone}` : ''}
        {' · '}
        Trend covers the 14 days up to this date
        {' · '}
        KPI coverage {pct(coverage)}
        {organisations.attention ? ` · ${organisations.attention} org(s) need attention` : ''}
      </p>

      <section className="pw-kpi-strip pw-kpi-strip-compact" aria-label="Key figures">
        {kpiTiles.map((t) => (
          <StatBlock
            key={t.key}
            value={t.value}
            label={t.label}
            href={t.href}
            tone={t.tone}
          />
        ))}
      </section>

      <section className="pw-analytics-bento" aria-label="Analytics">
        <PerformanceTrendChart series={performance.series} className="pw-bento-trend" />
        <KpiHealthPie organisations={organisations} className="pw-bento-health" />
        <OrgDayBoard organisations={organisations} className="pw-bento-orgday" />
        <ReportingBarChart reporting={reporting} className="pw-bento-report" />
        <DeliveryBarChart delivery={delivery} className="pw-bento-delivery" />
        <TargetAttainmentPie targetAttainment={targetAttainment} className="pw-bento-target" />
        <OrgRagBarChart bars={organisations.bars} className="pw-bento-rag" />

        <article className="pw-attention-glass pw-glass pw-tone-rose pw-bento-attention">
          <header className="pw-attention-glass-head">
            <h3>Needs attention</h3>
            <span className="pw-pill">{attention.length}</span>
          </header>
          {attention.length === 0 ? (
            <p className="overview-muted pw-attention-glass-empty">Nothing off track for this day.</p>
          ) : (
            <ul className="pw-attention-glass-list">
              {attentionPreview.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={`pw-attention-glass-row${selectedId === row.id ? ' selected' : ''}`}
                    onClick={() => onSelectAttention?.(row)}
                  >
                    <span className={`status-chip ${row.status}`}>{row.status}</span>
                    <span className="pw-attention-glass-main">
                      <b>{row.title}</b>
                      <small>
                        {row.org} · {row.value}/{row.goal}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {attention.length > attentionPreview.length ? (
            <p className="pw-attention-glass-more overview-muted">
              +{attention.length - attentionPreview.length} more in full list below
            </p>
          ) : null}
        </article>
      </section>

      {selectedId && attention.find((a) => a.id === selectedId) ? (
        <aside className="overview-detail pw-glass pw-tone-violet">
          {(() => {
            const row = attention.find((a) => a.id === selectedId);
            return (
              <>
                <h3>{row.title}</h3>
                <p className="overview-muted">{row.org}</p>
                <dl>
                  <div>
                    <dt>Status</dt>
                    <dd className={`status-chip ${row.status}`}>{row.status}</dd>
                  </div>
                  <div>
                    <dt>Value vs goal</dt>
                    <dd>
                      {row.value} / {row.goal}
                    </dd>
                  </div>
                  <div>
                    <dt>Owner</dt>
                    <dd>{row.owner}</dd>
                  </div>
                </dl>
              </>
            );
          })()}
        </aside>
      ) : null}

      {attention.length > 4 ? (
        <section className="overview-attention pw-attention-section-compact" aria-label="All attention items">
          <div className="overview-attention-head">
            <h2>All KPIs needing attention</h2>
          </div>
          <ul className="overview-attention-list overview-attention-list-compact">
            {attention.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={`overview-attention-row pw-glass${selectedId === row.id ? ' selected' : ''}`}
                  onClick={() => onSelectAttention?.(row)}
                >
                  <span className={`status-chip ${row.status}`}>{row.status}</span>
                  <span className="overview-attention-main">
                    <b>{row.title}</b>
                    <small>
                      {row.org} · {row.owner}
                    </small>
                  </span>
                  <span className="overview-attention-val">
                    {row.value} / {row.goal}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
