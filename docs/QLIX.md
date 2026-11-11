# Qlix + PortfolioOS (local)

PortfolioOS uses **one** Qlix hybrid agent for every turn (owner tab and WhatsApp). Role checks stay in PortfolioOS on each `portfolio_os` tool call.

## Qlix backend

From `qlix-monorepo/backend-adk` (or an equivalent checkout on port **4000**):

1. Postgres on **5434** and Redis on **6379** (e.g. `qlix-local-pg` / `qlix-local-redis` containers).
2. `backend-adk/.env` with `DATABASE_URL`, `OPENROUTER_API_KEY`, `AGENT_SECRETS_KEY`, JWT secrets, etc.
3. `npm install && npm run dev` → `http://localhost:4000/api/v1/health`

## PortfolioOS env

In `sona-ecosystem/.env`:

```bash
QLIX_BACKEND_URL=http://localhost:4000
QLIX_AGENT_ID=<hybrid agent id>
QLIX_RUNNER_TOKEN=<one-time token from agent create>
```

Restart **agent-runner** after changing these.

## Create the agent (once)

Hybrid agent via API: `POST /api/v1/agents` with `runtime: hybrid`, `localInferenceMode: null`, `model: openrouter/openai/gpt-4o-mini`, and at least one permission scope (e.g. `web.read`). The response `sdkAgentFile.runner_token` is shown only once.

## PortfolioOS processes

Local terminals **or** one Docker stack — see [DOCKER.md](./DOCKER.md):

```bash
cd sona-ecosystem && docker compose up --build
```

| Service        | Port |
|----------------|------|
| API            | 4001 |
| Web            | 3001 |
| Agent runner   | 3940 |
| WA gateway     | 3938 |
| Qlix WhatsApp  | 3939 (`QLIX_URL=http://127.0.0.1:3938`) |

Sign in as `owner@portfolio.local` / `password123` → **Settings** tab to scan the WhatsApp QR (proxied from the sidecar), then **Agent** tab.

On WhatsApp, the agent runs only when the message contains **`@`** (e.g. `@ list KPIs for TMS`). Plain texts are ignored.
