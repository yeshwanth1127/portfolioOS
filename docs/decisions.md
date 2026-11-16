# PortfolioOS — locked pre-build decisions

Recorded: 2026-11-06. Source: PortfolioOS Development Build Specification + plan approval.

## Open spec decisions (resolved)

| # | Topic | Decision |
|---|--------|----------|
| 1 | Rollup per KPI | Set per KPI at creation in seed (`rollup_method` column). Acres/counts use `sum`; rates and percentages use `latest`; conversion-style metrics use `manual`. |
| 2 | Vacant level behavior | Mark KPI level unowned; show red on portfolio grid. Do not auto-reassign or block lock silently. |
| 3 | PATS price target | **Pending Lead input.** Seed `pats.price_acre` with `target = null` until Anju Raj confirms a value inside ₹300–800/acre. Operational default for demos: ₹500/acre when explicitly set via env `PATS_PRICE_TARGET`. |
| 4 | SCALE revenue model | **Pending.** `scale.revenue` remains `source_tag = tbd`, `target = null` until Thyagu + Venugopal ruling. |
| 5 | Communications seniors | Remain **L1 `member`** (not L2) until designations confirmed; deadline 17:00 IST. |
| 6 | KPI “unmeasured” | **L4 only**, with mandatory reason stored on KPI (`unmeasured_reason` via audit). |

## Auth and hosting

- **Pilot auth:** Email + password (scrypt; legacy SHA-256 upgraded on login) for dashboard; JWT maps to `membership_id`.
- **Post-collection:** Phone OTP tied to `users.phone_e164` for WhatsApp alignment.
- **Agent runs:** Short-lived run tokens minted by API; immutable `X-PortfolioOS-*` headers.
- **Hosting:** Single-region deployment; cron digest **Asia/Kolkata** (05:30 IST).
- **Backups:** Daily PostgreSQL dump including `wa_auth_state`.

## adk_new dependency

- Path: `../../qlix-monorepo/adk_new` (editable install from agent-runner).
- Pin: record git SHA of qlix-monorepo when cutting releases.

## Qlix ADK commit pin

Recorded when Phase 0 catalogue `input_schema` landed (F14). Re-pin on every release that changes ADK integration.

```
QLIX_MONOREPO_SHA=c7ff359b0be7c39e734b3957078a4d006fd2e463
```

## Measurement ledger removed (2026-11-14)

The Phase 6 ledger (`metrics`, `target_versions`, `report_revisions`, `approvals`, `ledger_entries`, `period_results`) ran alongside KPIs and goals but was never adopted, and the two systems confused owners. It is removed from the app: the `/goals` page, the `/metrics`, `/reports/revisions` and `/approvals` routes, the `list_metrics` / `record_report` / `approve_report` agent tools, and the `target.edit` / `report.approve` permissions. KPIs + `kpi_goals` are the only goal system; Overview "Target attainment" and reporting completeness read KPI scores and submissions.

Migration `019_ledger_engine.sql` and its tables are left in place (no data dropped). A later migration can drop them once nobody needs the history.
