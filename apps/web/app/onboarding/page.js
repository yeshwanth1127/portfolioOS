'use client';

import { useState } from 'react';
import { api } from '../lib/api.js';
import { readStoredSession } from '../lib/session.js';

const STEPS = ['welcome', 'import', 'confirm'];

export default function OnboardingPage() {
  const session = readStoredSession();
  const token = session?.token;
  const isOwner = session?.membership?.role === 'owner';
  const [step, setStep] = useState(0);
  const [csv, setCsv] = useState('');
  const [dryRun, setDryRun] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token || !isOwner) {
    return (
      <main className="mx-auto max-w-xl p-8">
        <h1 className="text-2xl font-bold">Onboarding</h1>
        <p className="mt-4 text-muted">Sign in as the workspace owner to run setup.</p>
      </main>
    );
  }

  async function runDryRun() {
    setBusy(true);
    setMessage('');
    try {
      const out = await api('/onboarding/import-csv', token, { method: 'POST', body: JSON.stringify({ csv }) });
      setDryRun(out);
      if (!out.valid) setMessage(`Validation found ${out.errors?.length ?? 0} issue(s).`);
      else setMessage('Dry run OK — review counts, then apply.');
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function applyImport() {
    if (!dryRun?.dry_run_token) return;
    setBusy(true);
    try {
      const out = await api('/onboarding/apply', token, {
        method: 'POST',
        body: JSON.stringify({ dry_run_token: dryRun.dry_run_token }),
      });
      setMessage(`Applied — ${out.applied?.units ?? 0} units, ${out.applied?.people ?? 0} people, ${out.applied?.kpis ?? 0} KPIs.`);
      setStep(2);
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <h1 className="text-3xl font-bold">Workspace setup</h1>
      <p className="text-muted">Step {step + 1} of {STEPS.length}: {STEPS[step]}</p>

      {step === 0 && (
        <section className="rounded-2xl border border-line bg-frame p-6">
          <p>Import people, units, and KPIs from a CSV template, or skip and configure manually in Settings.</p>
          <button
            type="button"
            className="mt-4 rounded-full bg-ink px-5 py-2 text-sm font-semibold text-white"
            onClick={() => setStep(1)}
          >
            Continue
          </button>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4 rounded-2xl border border-line bg-frame p-6">
          <label className="block text-sm font-semibold" htmlFor="csv">
            CSV (sections # people, # units, # kpis)
          </label>
          <textarea
            id="csv"
            className="min-h-[200px] w-full rounded-xl border border-line bg-white p-3 font-mono text-sm"
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="# people&#10;email,full_name,role,org_slug&#10;..."
          />
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy || !csv.trim()}
              className="rounded-full bg-ink px-5 py-2 text-sm font-semibold text-white disabled:opacity-50"
              onClick={runDryRun}
            >
              Dry run
            </button>
            <button
              type="button"
              disabled={busy || !dryRun?.valid}
              className="rounded-full border border-ink px-5 py-2 text-sm font-semibold disabled:opacity-50"
              onClick={applyImport}
            >
              Apply import
            </button>
          </div>
          {dryRun?.summary && (
            <pre className="rounded-xl bg-row p-3 text-xs">{JSON.stringify(dryRun.summary, null, 2)}</pre>
          )}
        </section>
      )}

      {step === 2 && (
        <section className="rounded-2xl border border-line bg-frame p-6">
          <p>Setup complete. Open Overview to confirm your workspace.</p>
          <a href="/" className="mt-4 inline-block rounded-full bg-ink px-5 py-2 text-sm font-semibold text-white no-underline">
            Go to Overview
          </a>
        </section>
      )}

      {message && <p className="text-sm text-muted">{message}</p>}
    </main>
  );
}
