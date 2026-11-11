# Deploy PortfolioOS with Docker

One command starts **Postgres** plus a **single app container** that runs:

| Process inside the container | Port |
|------------------------------|------|
| Web (Next.js)                | 3001 |
| API                          | 4001 |
| WA gateway                   | 3938 |
| WhatsApp sidecar (QR)        | 3939 |
| Agent runner                 | 3940 |

**Not inside the image:** Qlix `backend-adk` inference (needs its own Postgres/Redis). Point `QLIX_BACKEND_URL` at a host or remote Qlix.

## Start

From `sona-ecosystem/` (parent `EXORA/` must contain `qlix-monorepo/` for the build):

```bash
cp .env.docker.example .env
# fill QLIX_AGENT_ID, QLIX_RUNNER_TOKEN, WHATSAPP_AUTH_ENCRYPTION_KEY

docker compose up --build
```

Open http://localhost:3001 — login `owner@portfolio.local` / `password123`.

Settings → WhatsApp → Generate QR (sidecar is on :3939 inside the same container).

## Qlix on the host

```bash
cd ../qlix-monorepo/backend-adk && npm run dev   # :4000
```

Compose maps `host.docker.internal:4000` into the container via `QLIX_BACKEND_URL`.

## Persist WhatsApp link

Keep a fixed `WHATSAPP_AUTH_ENCRYPTION_KEY` and `WA_CONNECTOR_ID` in `.env`. Auth files live in the `wa_auth` volume.

## Rebuild after code changes

```bash
docker compose up --build
```

## Why not literally everything in one OS process tree including Postgres?

Postgres runs as its own Compose service (healthchecks, volumes, upgrades). The **app** is one container so you do not juggle five Node terminals. Qlix stays separate because it is a different product with its own DB/Redis.
