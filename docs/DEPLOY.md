# Deploy PortfolioOS on a server

PortfolioOS builds with `qlix-monorepo` next to it (the Dockerfile copies `adk_new` and
`platform/qlix-whatsapp-service`), and talks to Qlix `backend-adk` for inference.

```
~/exora/
├── portfolioOS/      ← this repo
└── qlix-monorepo/    ← exorasolutions/qlix-monorepo (must include adk_new/…/portfolio_os)
```

Requirements: Docker + Compose v2, `jq`, ports 80/443 open. ~2 GB RAM.

## 1. Clone both repos side by side

```bash
mkdir -p ~/exora && cd ~/exora
git clone https://github.com/yeshwanth1127/portfolioOS.git
git clone https://github.com/exorasolutions/qlix-monorepo.git
```

## 2. Start Qlix (backend-adk + Postgres + Redis)

```bash
cd ~/exora/qlix-monorepo
cp .env.example .env            # fill per its README (OPENROUTER_API_KEY, secrets…)
POSTGRES_HOST_PORT=5434 docker compose --env-file .env up -d --build postgres redis backend
docker network ls | grep qlix   # note the network name, e.g. qlix-monorepo_default
```

## 3. Create the Qlix agent PortfolioOS uses

```bash
cd ~/exora/portfolioOS
bash scripts/create-qlix-agent.sh http://localhost:4000
# prints QLIX_AGENT_ID=… and QLIX_RUNNER_TOKEN=…
```

## 4. Configure and start PortfolioOS

```bash
cp .env.server.example .env
# fill: JWT_SECRET / AGENT_RUNNER_SECRET / WA_SERVICE_SECRET (openssl rand -hex 32),
#       DEMO_PASSWORD, QLIX_AGENT_ID, QLIX_RUNNER_TOKEN, QLIX_NETWORK,
#       WA_CONNECTOR_ID (uuidgen), WHATSAPP_AUTH_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
docker compose logs -f portfolio
```

Only the web port (`WEB_PORT`, default 3001) is public; the browser reaches the API at `/papi`.
API, agent-runner and WhatsApp ports bind to 127.0.0.1.

## 5. HTTPS (Caddy example)

```
portfolio.example.com {
    reverse_proxy localhost:3001
}
```

## 6. First login + WhatsApp

- Sign in as `owner@portfolio.local` with `DEMO_PASSWORD`.
- Settings → Generate QR → scan from the phone that will be the bot.

## Update

```bash
cd ~/exora/qlix-monorepo && git pull
cd ~/exora/portfolioOS && git pull
docker compose -f docker-compose.yml -f docker-compose.server.yml up -d --build
```

Data lives in the `portfolio_pg` and `wa_auth` Docker volumes; rebuilding keeps it.
