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

- **Pilot auth:** Email + password (bcrypt) for dashboard; JWT maps to `membership_id`.
- **Post-collection:** Phone OTP tied to `users.phone_e164` for WhatsApp alignment.
- **Agent runs:** Short-lived run tokens minted by API; immutable `X-PortfolioOS-*` headers.
- **Hosting:** Single-region deployment; cron digest **Asia/Kolkata** (05:30 IST).
- **Backups:** Daily PostgreSQL dump including `wa_auth_state`.

## adk_new dependency

- Path: `../../qlix-monorepo/adk_new` (editable install from agent-runner).
- Pin: record git SHA of qlix-monorepo when cutting releases.

## Qlix ADK commit pin

Update on release:

```
QLIX_MONOREPO_SHA=<git rev-parse HEAD in qlix-monorepo>
```
