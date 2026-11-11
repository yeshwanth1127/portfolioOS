# PortfolioOS

Multi-tenant portfolio management for seven Sona-aligned organisations. Spec: Exora PortfolioOS Development Build Specification.

## Stack

- PostgreSQL 16 + RLS — `packages/db`
- Node 20 API — `packages/api`
- Next.js 14 dashboard — `apps/web`
- Baileys WhatsApp — `services/wa-gateway`
- Qlix **adk_new** agents — `qlix-monorepo/adk_new` + `services/agent-runner`

Server deploy: see [docs/DEPLOY.md](docs/DEPLOY.md). Local dev with hot reload: `bash scripts/dev.sh`.

## Quick start

```bash
docker compose up -d
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run api:dev
# another terminal
npm run web:dev
```

Pilot (requires API running):

```bash
npm run test:pilot
```

Default pilot logins are seeded in `packages/db/scripts/seed.js` (change passwords before production).

## adk_new

Agent capability and domain pack live in `../qlix-monorepo/adk_new`. See `services/agent-runner/README.md`.
