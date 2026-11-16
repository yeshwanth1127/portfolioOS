'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ReportSection } from '../../components/report-blocks';
import { apiRaw, api } from '../../lib/api.js';
import { periodLabel } from '../../lib/report-format.js';
import { readStoredSession } from '../../lib/session.js';

const STEPS = ['Gathering the numbers', 'Building charts and tables', 'Qlix is writing the summary'];

export default function ReportPage() {
  const { id } = useParams();
  const router = useRouter();
  const [token, setToken] = useState(null);
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [step, setStep] = useState(0);
  const docRef = useRef(null);

  const load = useCallback(
    async (t) => {
      if (!t || !id) return;
      try {
        const out = await api(`/reports/generated/${id}`, t);
        setReport(out.report);
      } catch (e) {
        setError(e.message);
      }
    },
    [id],
  );

  useEffect(() => {
    const t = readStoredSession()?.token ?? null;
    setToken(t);
    load(t);
  }, [load]);

  const working = report && (report.status === 'queued' || report.status === 'running');
  useEffect(() => {
    if (!working) return undefined;
    const poll = setInterval(() => load(token), 2000);
    const tick = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 2500);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [working, token, load]);

  /** Same naming as the Excel / CSV exports: "<title> <from>[_<to>]" slugified. */
  function pdfName() {
    const base = `${report.title} ${report.period_from}${report.period_to !== report.period_from ? `_${report.period_to}` : ''}`
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .toLowerCase();
    return `${base || 'report'}.pdf`;
  }

  async function downloadPdf() {
    if (!docRef.current) return;
    setBusy('pdf');
    setError('');
    try {
      const { downloadReportPdf } = await import('../../lib/report-pdf.js');
      await downloadReportPdf(docRef.current, pdfName());
    } catch (e) {
      setError(`Could not create the PDF. ${e?.message ?? ''}`.trim());
    } finally {
      setBusy('');
    }
  }

  async function download(format) {
    setBusy(format);
    try {
      const res = await apiRaw(`/reports/generated/${id}/export.${format}`, token);
      if (!res.ok) throw new Error('Download failed');
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `report.${format}`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  async function action(path, method = 'POST') {
    setBusy(path);
    setError('');
    try {
      await api(`/reports/generated/${id}${path}`, token, { method });
      if (method === 'DELETE') router.push('/reports');
      else await load(token);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  if (!report) {
    return (
      <main className="dashboard-page rp-page">
        <Link href="/reports" className="rp-back no-print">← Reports</Link>
        {error ? <p className="rp-error">{error}</p> : <div className="rp-card rp-skeleton" aria-busy="true" />}
      </main>
    );
  }

  const spec = report.spec ?? {};
  const datasets = report.datasets ?? {};

  return (
    <main ref={docRef} className="dashboard-page rp-page rp-doc">
      <Link href="/reports" className="rp-back no-print">← Reports</Link>

      <header className="rp-doc-head">
        <div>
          <h1>{report.title}</h1>
          <p>
            {periodLabel(report.period_from, report.period_to)}
            {report.requested_by_name && !report.is_mine ? ` · by ${report.requested_by_name}` : ''}
            {report.submitted_at ? ` · sent to ${report.submitted_to_name ?? 'manager'}` : ''}
          </p>
        </div>
        {report.status === 'ready' ? (
          <div className="rp-doc-actions no-print">
            <button type="button" className="rp-btn-ghost" disabled={busy === 'pdf'} onClick={downloadPdf}>
              {busy === 'pdf' ? 'Preparing PDF…' : 'PDF'}
            </button>
            <button type="button" className="rp-btn-ghost" disabled={busy === 'xlsx'} onClick={() => download('xlsx')}>Excel</button>
            <button type="button" className="rp-btn-ghost" disabled={busy === 'csv'} onClick={() => download('csv')}>CSV</button>
            {report.can_submit && !report.submitted_at ? (
              <button type="button" className="rp-btn" disabled={Boolean(busy)} onClick={() => action('/submit')}>
                Send to manager
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {error ? <p className="rp-error no-print">{error}</p> : null}

      {working ? (
        <div className="rp-card rp-progress" aria-live="polite">
          <span className="rp-spinner" aria-hidden />
          <div>
            <strong>{STEPS[step]}…</strong>
            <p>Usually under a minute. You can leave this page; it will be in your reports list.</p>
          </div>
        </div>
      ) : null}

      {report.status === 'failed' ? (
        <div className="rp-card rp-failed">
          <strong>This report could not be generated.</strong>
          <p>{report.error ?? 'Something went wrong.'}</p>
          {report.is_mine ? (
            <button type="button" className="rp-btn" onClick={() => action('/retry')}>Try again</button>
          ) : null}
        </div>
      ) : null}

      {report.status === 'ready' ? (
        <>
          <section className="rp-card rp-summary">
            <p className="rp-summary-text">{spec.summary}</p>
            {spec.highlights?.length || spec.watch?.length ? (
              <div className="rp-summary-lists">
                {spec.highlights?.length ? (
                  <ul className="rp-good">
                    {spec.highlights.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                ) : null}
                {spec.watch?.length ? (
                  <ul className="rp-watch">
                    {spec.watch.map((h) => <li key={h}>{h}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
            <p className="rp-source">
              {report.narrative_source === 'agent'
                ? 'Summary drafted by Qlix. Every number is checked against the data below.'
                : spec.agent_unavailable
                  ? 'Summary generated from the data below. Qlix was unavailable, so this report has no agent-written summary.'
                  : 'Summary generated from the data below.'}
              {spec.narrative_note ? ` ${spec.narrative_note}` : ''}
            </p>
          </section>

          {(spec.sections ?? []).map((s) => (
            <ReportSection key={s.key} section={s} datasets={datasets} />
          ))}

          <footer className="rp-doc-foot">
            Generated {new Date(report.completed_at ?? report.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })} · Orbit by Exora
            {report.is_mine ? (
              <button type="button" className="rp-link no-print" onClick={() => action('', 'DELETE')}>Delete report</button>
            ) : null}
          </footer>
        </>
      ) : null}
    </main>
  );
}
