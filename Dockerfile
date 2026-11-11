# PortfolioOS all-in-one: API, web, agent-runner, wa-gateway, WhatsApp sidecar.
# Build with parent (EXORA) as context — see docker-compose.yml.

FROM node:20-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv \
      ca-certificates curl tini supervisor \
    && rm -rf /var/lib/apt/lists/*

# --- ADK (Python) ---
FROM base AS adk
COPY qlix-monorepo/adk_new /opt/adk_new
WORKDIR /opt/adk_new
RUN python3 -m venv /opt/adk-venv \
 && /opt/adk-venv/bin/pip install --no-cache-dir -U pip \
 && /opt/adk-venv/bin/pip install --no-cache-dir -e .

# --- WhatsApp sidecar node_modules ---
FROM base AS wa-deps
WORKDIR /opt/whatsapp
COPY qlix-monorepo/platform/qlix-whatsapp-service/package.json \
     qlix-monorepo/platform/qlix-whatsapp-service/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund 2>/dev/null \
 || npm install --omit=dev --no-audit --no-fund

# --- PortfolioOS install + Next build ---
FROM base AS app-build
WORKDIR /app
COPY sona-ecosystem/package.json sona-ecosystem/package-lock.json ./
COPY sona-ecosystem/packages ./packages
COPY sona-ecosystem/apps ./apps
COPY sona-ecosystem/services ./services
COPY sona-ecosystem/docs ./docs
# Include devDependencies so `next build` works in this stage.
RUN npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
ARG NEXT_PUBLIC_HIDE_DEMO_LOGINS=1
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_API_URL=/papi \
    NEXT_PUBLIC_HIDE_DEMO_LOGINS=${NEXT_PUBLIC_HIDE_DEMO_LOGINS}
RUN npm run build -w @portfolio-os/web \
 && npm prune --omit=dev

# --- runtime ---
FROM base AS runtime
WORKDIR /app

COPY --from=app-build /app /app
COPY --from=adk /opt/adk_new /opt/adk_new
COPY --from=adk /opt/adk-venv /opt/adk-venv
COPY --from=wa-deps /opt/whatsapp/node_modules /opt/whatsapp/node_modules
COPY qlix-monorepo/platform/qlix-whatsapp-service /opt/whatsapp
# restore node_modules after COPY of source (overwrites)
COPY --from=wa-deps /opt/whatsapp/node_modules /opt/whatsapp/node_modules

COPY sona-ecosystem/docker/supervisord.conf /etc/supervisor/conf.d/portfolio.conf
COPY sona-ecosystem/docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /var/lib/qlix-whatsapp/auth_info /var/lib/qlix-whatsapp/data /var/log/supervisor

ENV NODE_ENV=production \
    PORT=4001 \
    DATABASE_URL=postgresql://portfolio:portfolio@postgres:5432/portfolio_os \
    AGENT_RUNNER_URL=http://127.0.0.1:3940 \
    PORTFOLIOOS_API_URL=http://127.0.0.1:4001 \
    QLIX_ADK_PATH=/opt/adk_new \
    PORTFOLIO_PYTHON=/opt/adk-venv/bin/python3 \
    WA_PORT=3938 \
    WA_SERVICE_URL=http://127.0.0.1:3939 \
    WA_DISABLE=0 \
    QLIX_URL=http://127.0.0.1:3938 \
    WHATSAPP_BIND_HOST=0.0.0.0 \
    WHATSAPP_AUTH_DIR=/var/lib/qlix-whatsapp/auth_info \
    WHATSAPP_DATA_DIR=/var/lib/qlix-whatsapp/data \
    WHATSAPP_SKIP_LOCAL_APPROVALS=1 \
    QLIX_REQUEST_TIMEOUT_MS=120000 \
    QLIX_CALLBACK_RETRIES=0 \
    SEED_ON_START=1

EXPOSE 3001 4001 3938 3939 3940
VOLUME ["/var/lib/qlix-whatsapp"]

ENTRYPOINT ["/usr/bin/tini", "--", "/entrypoint.sh"]
