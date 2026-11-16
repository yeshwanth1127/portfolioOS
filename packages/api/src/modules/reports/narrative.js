/*
 * The Qlix agent's part of a report: it reads the computed datasets through the `report_data`
 * tool and writes the summary, highlights and watch-outs. It never supplies figures for the
 * tiles, charts or tables. Any narrative line quoting a number that is not in the datasets is
 * dropped before the report is saved.
 */
import { fmt } from './types.js';

const MAX_ROWS_FOR_AGENT = 20;

function formatCell(value, format) {
  if (value == null) return null;
  if (format === 'pct' || format === 'hours' || format === 'int' || format === 'num') return fmt(value, format);
  return value;
}

/** What `report_data` returns: titles, totals and the first rows of each dataset, formatted. */
export function compactForAgent(report) {
  const datasets = {};
  for (const [key, ds] of Object.entries(report.datasets ?? {})) {
    const fmtOf = Object.fromEntries((ds.columns ?? []).map((c) => [c.key, c.format]));
    datasets[key] = {
      title: ds.title,
      note: ds.note ?? null,
      totals: ds.totals,
      columns: (ds.columns ?? []).map((c) => c.label),
      row_count: ds.rows.length,
      rows: ds.rows.slice(0, MAX_ROWS_FOR_AGENT).map((r) =>
        Object.fromEntries((ds.columns ?? []).map((c) => [c.label, formatCell(r[c.key], fmtOf[c.key])])),
      ),
    };
  }
  return {
    report: {
      title: report.title,
      type: report.report_type,
      scope: report.scope_label,
      from: report.period_from,
      to: report.period_to,
      instructions: report.instructions ?? null,
    },
    datasets,
  };
}

export const REPORT_PLAYBOOK = `You are drafting the written part of an Orbit (PortfolioOS) report.
Step 1: call portfolio_os with action "report_data" (no other fields). It returns the report's figures.
Step 2: reply with plain text in exactly this shape and nothing else:
SUMMARY: two or three sentences on what the period looked like.
HIGHLIGHTS:
- one line per notable win (max 3)
WATCH:
- one line per risk or gap that needs action (max 3)
Rules: every number you write must appear in report_data (totals or rows) — copy it exactly, never calculate new ones.
Use people, KPI and project names exactly as given. No markdown, no emoji, no greetings. Under 120 words.
If report_data shows no activity, say so plainly in SUMMARY and leave HIGHLIGHTS and WATCH empty.`;

export function agentMessage(report) {
  const extra = report.instructions ? `\nThe person asked: "${report.instructions}". Address it if the data allows.` : '';
  return `${REPORT_PLAYBOOK}\n\nReport: ${report.title} · ${report.scope_label} · ${report.period_from} to ${report.period_to}.${extra}`;
}

/** Parse SUMMARY / HIGHLIGHTS / WATCH; tolerant of the agent runner's tag clean-up. */
export function parseAgentReply(text) {
  const out = { summary: '', highlights: [], watch: [] };
  let mode = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/^\[(?:-|good|watch|bad|saved|open|person|locked|unscored)\]\s*/i, '- ').trim();
    if (!line) continue;
    const head = line.match(/^(SUMMARY|HIGHLIGHTS|WATCH)\s*:?\s*(.*)$/i);
    if (head) {
      mode = head[1].toLowerCase();
      if (mode === 'summary' && head[2]) out.summary = head[2].trim();
      else if (head[2] && mode !== 'summary') out[mode].push(head[2].replace(/^[-•]\s*/, '').trim());
      continue;
    }
    const item = line.replace(/^[-•*]\s*/, '').trim();
    if (mode === 'summary') out.summary = `${out.summary} ${item}`.trim();
    else if (mode === 'highlights' || mode === 'watch') out[mode].push(item);
  }
  out.highlights = out.highlights.filter(Boolean).slice(0, 3);
  out.watch = out.watch.filter(Boolean).slice(0, 3);
  return out;
}

const NUM = /(?<![\w-])-?\d[\d,]*(?:\.\d+)?/g;

/** Every number a narrative may quote: raw values, their displayed forms, and the period's dates. */
export function allowedNumbers(report) {
  const set = new Set();
  const add = (n) => {
    if (n == null || Number.isNaN(Number(n))) return;
    const v = Number(n);
    set.add(Math.round(v * 10) / 10);
    set.add(Math.round(v));
  };
  const addValue = (v, format) => {
    if (typeof v !== 'number') {
      if (typeof v === 'string') for (const m of v.match(NUM) ?? []) add(m.replace(/,/g, ''));
      return;
    }
    add(v);
    if (format === 'pct' || (v > 0 && v < 1)) add(v * 100);
  };
  for (const ds of Object.values(report.datasets ?? {})) {
    const fmtOf = Object.fromEntries((ds.columns ?? []).map((c) => [c.key, c.format]));
    for (const [k, v] of Object.entries(ds.totals ?? {})) addValue(v, /rate|attainment/.test(k) ? 'pct' : null);
    add(ds.rows.length);
    for (const row of ds.rows) for (const [k, v] of Object.entries(row)) addValue(v, fmtOf[k]);
  }
  for (const d of [report.period_from, report.period_to]) {
    if (!d) continue;
    const [y, m, day] = String(d).split('-').map(Number);
    add(y);
    add(m);
    add(day);
  }
  return set;
}

function lineIsBacked(line, allowed) {
  for (const m of line.match(NUM) ?? []) {
    const v = Number(m.replace(/,/g, ''));
    if (!allowed.has(Math.round(v * 10) / 10) && !allowed.has(Math.round(v))) return false;
  }
  return true;
}

/** Keep only narrative sentences whose numbers all appear in the datasets. */
export function verifyNarrative(parsed, report) {
  const allowed = allowedNumbers(report);
  const sentences = parsed.summary.split(/(?<=[.!?])\s+/).filter(Boolean);
  const keptSummary = sentences.filter((x) => lineIsBacked(x, allowed));
  const result = {
    summary: keptSummary.join(' ').trim(),
    highlights: parsed.highlights.filter((x) => lineIsBacked(x, allowed)),
    watch: parsed.watch.filter((x) => lineIsBacked(x, allowed)),
  };
  result.dropped =
    sentences.length - keptSummary.length +
    (parsed.highlights.length - result.highlights.length) +
    (parsed.watch.length - result.watch.length);
  return result;
}
