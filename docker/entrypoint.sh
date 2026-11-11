#!/bin/sh
set -eu

echo "[portfolio] waiting for database…"
i=0
until node -e "
const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.end()).then(()=>process.exit(0)).catch(()=>process.exit(1));
" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "[portfolio] database not ready after 60s" >&2
    exit 1
  fi
  sleep 1
done
echo "[portfolio] database ready"

# Inside Docker, localhost is the container — Qlix runs on the host.
case "${QLIX_BACKEND_URL:-}" in
  http://localhost:*|http://127.0.0.1:*|https://localhost:*|https://127.0.0.1:*)
    port="${QLIX_BACKEND_URL##*:}"
    export QLIX_BACKEND_URL="http://host.docker.internal:${port}"
    echo "[portfolio] QLIX_BACKEND_URL rewritten to $QLIX_BACKEND_URL (host Qlix)"
    ;;
esac

echo "[portfolio] migrating…"
npm run migrate -w @portfolio-os/db

if [ "${SEED_ON_START:-0}" = "1" ]; then
  count="$(node -e "
const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.query('SELECT count(*)::int AS n FROM organisations'))
  .then(r=>{console.log(r.rows[0].n);return c.end();})
  .catch(()=>{console.log(0);process.exit(0);});
")"
  if [ "$count" = "0" ]; then
    echo "[portfolio] seeding empty database…"
    npm run seed -w @portfolio-os/db
  else
    echo "[portfolio] seed skipped (organisations already present)"
  fi
fi

if [ -n "${DEMO_PASSWORD:-}" ]; then
  node -e "
const pg=require('pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL});
c.connect().then(()=>c.query(\"UPDATE users SET password_hash=encode(digest('portfolio-os:'||\$1,'sha256'),'hex') WHERE password_hash=encode(digest('portfolio-os:password123','sha256'),'hex')\",[process.env.DEMO_PASSWORD]))
 .then(r=>{console.log('[portfolio] demo logins updated:',r.rowCount);return c.end();}).catch(e=>{console.error(e.message);process.exit(0);});
"
fi

if [ -z "${WA_CONNECTOR_ID:-}" ]; then
  # Stable UUID for this volume so QR sessions survive restarts when unset.
  if [ -f /var/lib/qlix-whatsapp/connector_id ]; then
    export WA_CONNECTOR_ID="$(cat /var/lib/qlix-whatsapp/connector_id)"
  else
    export WA_CONNECTOR_ID="$(node -e "console.log(require('crypto').randomUUID())")"
    echo "$WA_CONNECTOR_ID" > /var/lib/qlix-whatsapp/connector_id
  fi
  echo "[portfolio] WA_CONNECTOR_ID=$WA_CONNECTOR_ID"
fi

if [ -z "${WHATSAPP_AUTH_ENCRYPTION_KEY:-}" ]; then
  export WHATSAPP_AUTH_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  echo "[portfolio] generated WHATSAPP_AUTH_ENCRYPTION_KEY (set a fixed one in compose for persistence)"
fi

echo "[portfolio] starting processes (api web agent-runner wa-gateway whatsapp)…"
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/portfolio.conf
