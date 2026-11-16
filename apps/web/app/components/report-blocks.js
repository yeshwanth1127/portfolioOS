'use client';

import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatValue, shortDate } from '../lib/report-format.js';

const TONE = {
  good: '#1f9d63',
  watch: '#e0a100',
  bad: '#d6402a',
  primary: '#6d28d9',
  muted: '#a1a1aa',
  soft: '#c4b5fd',
};

function Tiles({ items }) {
  if (!items?.length) return null;
  return (
    <div className="rp-tiles">
      {items.map((t) => (
        <div key={t.label} className={`rp-tile${t.tone ? ` is-${t.tone}` : ''}`}>
          <span className="rp-tile-value">{formatValue(t.value, t.format)}</span>
          <span className="rp-tile-label">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

function ReportChart({ block, dataset }) {
  if (!dataset?.rows?.length) return null;
  const rows = block.limit ? dataset.rows.slice(0, block.limit) : dataset.rows;
  const hasData = rows.some((r) => block.series.some((s) => Number(r[s.key]) > 0));
  if (!hasData) return null;
  const isDate = block.x === 'date';
  const stacked = block.type === 'stacked';
  const pct = block.format === 'pct';
  const data = rows.map((r) => ({
    ...r,
    _x: isDate ? shortDate(r[block.x]) : String(r[block.x] ?? '').slice(0, 18),
    ...Object.fromEntries(block.series.map((s) => [s.key, pct && r[s.key] != null ? Math.round(r[s.key] * 100) : r[s.key] ?? 0])),
  }));
  return (
    <div className="rp-chart">
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="#ececf0" />
          <XAxis dataKey="_x" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b6b73' }} interval="preserveStartEnd" minTickGap={8} />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#6b6b73' }} allowDecimals={false} unit={pct ? '%' : ''} />
          <Tooltip
            cursor={{ fill: 'rgba(109,40,217,0.06)' }}
            contentStyle={{ borderRadius: 12, border: '1px solid #e6e6ea', fontSize: 12 }}
            formatter={(v) => (pct ? `${v}%` : v)}
          />
          {block.series.length > 1 ? <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} /> : null}
          {block.series.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId={stacked ? 'a' : undefined}
              fill={TONE[s.tone] ?? TONE.primary}
              radius={stacked && i < block.series.length - 1 ? 0 : [6, 6, 0, 0]}
              maxBarSize={36}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Cell({ value, format }) {
  if (format === 'status') {
    return <span className={`rp-status is-${value ?? 'unscored'}`}>{value ?? '—'}</span>;
  }
  return formatValue(value, format);
}

function ReportTable({ block, dataset }) {
  const [all, setAll] = useState(false);
  if (!dataset) return null;
  const limit = block.limit ?? 20;
  const rows = all ? dataset.rows : dataset.rows.slice(0, limit);
  return (
    <div className="rp-table-wrap">
      <div className="rp-table-head">
        <h4>{dataset.title}</h4>
        <span>{dataset.rows.length} {dataset.rows.length === 1 ? 'row' : 'rows'}</span>
      </div>
      {dataset.rows.length ? (
        <div className="rp-table-scroll">
          <table className="rp-table">
            <thead>
              <tr>
                {dataset.columns.map((c) => (
                  <th key={c.key} className={c.format !== 'text' && c.format !== 'status' ? 'is-num' : ''}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {dataset.columns.map((c) => (
                    <td key={c.key} className={c.format !== 'text' && c.format !== 'status' ? 'is-num' : ''}>
                      <Cell value={r[c.key]} format={c.format} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="rp-empty">Nothing to show for this period.</p>
      )}
      {dataset.rows.length > limit ? (
        <button type="button" className="rp-link no-print" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all ${dataset.rows.length}`}
        </button>
      ) : null}
      {dataset.note ? <p className="rp-note">{dataset.note}</p> : null}
    </div>
  );
}

export function ReportSection({ section, datasets }) {
  return (
    <section className="rp-section">
      <h3>{section.title}</h3>
      {section.blocks.map((b, i) => {
        if (b.kind === 'tiles') return <Tiles key={i} items={b.items} />;
        if (b.kind === 'chart') return <ReportChart key={i} block={b} dataset={datasets[b.dataset]} />;
        if (b.kind === 'table') return <ReportTable key={i} block={b} dataset={datasets[b.dataset]} />;
        return null;
      })}
    </section>
  );
}
