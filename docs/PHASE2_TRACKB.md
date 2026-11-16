# Phase 2 Track B — what shipped

Minimum viable app shell, design tokens, Overview v1, and Calendar per [ROADMAP.md](./ROADMAP.md) §5 and Phase 2 Track B exit criteria (not Phase 9 polish).

## Shipped

- **Tailwind CSS v4** in `apps/web` (`postcss.config.mjs`, `@import 'tailwindcss'` + `@theme` tokens in `globals.css`).
- **Design tokens** aligned with §5: canvas cream, black sidebar (`--color-sidebar`), pastel cards (butter, rose, olive, periwinkle), rose today highlight on calendar cells.
- **App shell** (`app-shell.js`): primary nav — Overview, Calendar, Settings (owner); workspace switcher; black rounded sidebar; mobile drawer + bottom bar.
- **Overview v1** on `/` (overview tab): `GET /dashboards/overview`, four summary cards, needs-attention list, right **calendar rail** (mini month, add event, today timeline, ICS).
- **Legacy workspace tabs** (KPIs, Team, Today, Agent, etc.) remain on `/` under **Workspace tools** secondary nav — subordinate to sidebar.
- **Calendar page** `/calendar`: full month grid, day detail panel, create/edit/delete events, org picker (owner), participants, RSVP, ICS export; wrapped in the same cream canvas + white **board** frame as home.

## Verify

```bash
cd apps/web && npm run build
```

## Not in this track (still ROADMAP / production gaps)

- shadcn/ui component library, global search + scope chips, profile/notification header icons.
- Sidebar full §5 menu (My Work, Organisations, Projects, Goals & Metrics, People, Reports, Agent, WhatsApp).
- Calendar: ISO week numbers, now-line on timeline, WhatsApp reminders (depends on Phase 2 Track A job queue).
- Phase 2 **exit gate** end-to-end: cross-workspace isolation tests, data reconciliation, job-queue-delivered WhatsApp reminder.
