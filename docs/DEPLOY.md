# PortfolioOS — server deployment checklist

Target: **https://portfolio.exora.solutions** on a Linux server (Ubuntu/Debian, root access).
Time: ~30–45 min, most of it Docker builds.

What runs on the server:

| Component | How | Port |
|---|---|---|
| Qlix backend-adk + its Postgres + Redis | Docker (`qlix-monorepo` compose, project `qlix-monorepo`) | API on 127.0.0.1:4100, Postgres 127.0.0.1:5434 |
| PortfolioOS (web, API, agent-runner, WhatsApp) + its Postgres | Docker (this repo, project `portfolio`) | web on 127.0.0.1:3101 only |
| nginx + Let's Encrypt | system packages | 80 / 443 public |

Nothing else on the server is changed: a new nginx site file is added, existing sites are left alone.

---

## Part A — Yeshwanth does this on his Mac (before the engineer starts)

**A1. Push the PortfolioOS agent code in qlix-monorepo** (it was never committed; the server needs it):

```bash
cd ~/EXORA/qlix-monorepo
git add adk_new/adk_new/capabilities/shared/portfolio_os \
        adk_new/adk_new/capabilities/ports/portfolio_os_http_client.py \
        adk_new/adk_new/teams/domain_packs/portfolio_os_pack.py \
        adk_new/adk_new/capabilities/catalog/capability_scope_index.py \
        adk_new/tests/test_portfolio_os_capability.py
git commit -m "feat(adk): portfolio_os capability"
git push
```

**A2. Send the engineer `qlix-monorepo/backend-adk/.env`** over a private channel (it holds the OpenRouter key and Qlix secrets; it is not in git).

**A3. DNS:** add an **A record** `portfolio` → `201.18.196.230` for `exora.solutions`. Check:

```bash
dig +short portfolio.exora.solutions   # must print 201.18.196.230
```

**A4. Give the engineer read access** to `exorasolutions/qlix-monorepo` (or a deploy key/token for the server).

---

## Part B — Engineer, on the server (as root)

**B1. Check prerequisites**

```bash
cat /etc/os-release | head -2        # Ubuntu 22.04/24.04 or Debian 12 expected
free -h                              # ≥ 2 GB RAM free recommended (4 GB comfortable)
df -h /                              # ≥ 10 GB free
ss -ltnp | grep -E ':(80|443|3101|4100|5434) '   # 80/443 may be nginx; 3101/4100/5434 must be free
```

If 3101/4100/5434 are taken, pick others and pass them in B5 as `WEB_PORT=… QLIX_API_PORT=… QLIX_PG_PORT=…`.
If something other than nginx owns port 80 (Apache, Caddy, Traefik), stop at B5 and see "Other web server" below.

**B2. Clone both repos side by side** (folder names matter — the Docker build expects them):

```bash
mkdir -p /opt/exora && cd /opt/exora
git clone https://github.com/yeshwanth1127/portfolioos.git sona-ecosystem
git clone https://github.com/exorasolutions/qlix-monorepo.git qlix-monorepo
ls qlix-monorepo/adk_new/adk_new/capabilities/shared/portfolio_os   # must exist (step A1)
```

**B3. Put the Qlix backend env in place** (file from step A2):

```bash
nano /opt/exora/qlix-monorepo/backend-adk/.env      # paste contents
chmod 600 /opt/exora/qlix-monorepo/backend-adk/.env
grep -E '^(OPENROUTER_API_KEY|QLIX_INTERNAL_SERVICE_SECRET|JWT_SECRET)=.+' /opt/exora/qlix-monorepo/backend-adk/.env | cut -d= -f1
# must list all three
```

**B4. Confirm DNS resolves to this server** (needed for the certificate):

```bash
dig +short portfolio.exora.solutions; curl -4 -s https://api.ipify.org; echo
# both must show the same IP
```

**B5. Run the setup script**

```bash
bash /opt/exora/sona-ecosystem/scripts/server-setup.sh portfolio.exora.solutions admin@exora.solutions
```

It does, in order (safe to re-run):

1. Installs Docker, Compose, nginx, certbot, jq if missing.
2. Builds and starts Qlix: Postgres + Redis + backend-adk, runs Prisma migrations, waits for `/api/v1/health`.
3. Creates `/opt/exora/sona-ecosystem/.env` with random secrets, a demo password and WhatsApp IDs (only if `.env` doesn't exist).
4. Creates the Qlix login + hybrid agent PortfolioOS uses; saves them to `/root/portfolio-qlix-agent.txt` and `.env`.
5. Builds and starts PortfolioOS (`docker compose -p portfolio …`), runs its DB migrations and seed.
6. Adds `/etc/nginx/sites-available/portfolio.exora.solutions` → `127.0.0.1:3101`, reloads nginx, opens the firewall if ufw is active.
7. Gets a Let's Encrypt certificate with `certbot --nginx --redirect` (skipped with instructions if DNS isn't pointing yet).

At the end it prints the URL and the login.

**B6. Verify**

```bash
curl -I https://portfolio.exora.solutions                 # 200
curl -s https://portfolio.exora.solutions/papi/health      # {"ok":true,...}
docker compose -p portfolio ps                             # portfolio + postgres up
docker compose -p qlix-monorepo ps                         # postgres, redis, backend up
certbot certificates | grep -A2 portfolio.exora.solutions  # expiry ~90 days, auto-renews
systemctl list-timers | grep certbot                       # renewal timer present
```

Then in a browser: open the site, sign in as `owner@portfolio.local` with the printed password, open **Agent**, ask *"Give me a quick portfolio summary for today."* A reply within ~10 s means Qlix inference works.

**B7. Hand back to Yeshwanth**
- URL and owner password (`grep DEMO_PASSWORD /opt/exora/sona-ecosystem/.env`).
- He links WhatsApp: **Settings → Generate QR**, scan with the bot phone.

---

## Operations

| Task | Command |
|---|---|
| PortfolioOS logs | `docker compose -p portfolio logs -f portfolio` |
| Qlix logs | `docker compose -p qlix-monorepo logs -f backend` |
| Restart PortfolioOS | `cd /opt/exora/sona-ecosystem && docker compose -p portfolio -f docker-compose.yml -f docker-compose.server.yml restart portfolio` |
| Deploy an update | `cd /opt/exora/sona-ecosystem && git pull && cd ../qlix-monorepo && git pull && bash /opt/exora/sona-ecosystem/scripts/server-setup.sh portfolio.exora.solutions admin@exora.solutions` |
| DB backup | `docker compose -p portfolio exec -T postgres pg_dump -U portfolio portfolio_os > /root/portfolio-$(date +%F).sql` |
| Stop everything | `docker compose -p portfolio down; docker compose -p qlix-monorepo down` (data volumes kept) |

Data lives in Docker volumes `portfolio_portfolio_pg`, `portfolio_wa_auth`, `qlix-monorepo_qlix_pg_data`. Do not run `down -v`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Script stops at "Qlix backend not healthy" | `docker compose -p qlix-monorepo logs backend` — usually a missing value in `backend-adk/.env` |
| "agent creation failed" | Qlix logs; `subscription_required` → the new Qlix account has no trial, set `isSuperAdmin` or billing-exempt email in Qlix |
| Site loads, Agent tab says inference failed | `QLIX_AGENT_ID`/`QLIX_RUNNER_TOKEN` in `.env`; `docker compose -p portfolio exec portfolio curl -s http://backend:4000/api/v1/health` |
| 502 from nginx | `curl -I http://127.0.0.1:3101`; `docker compose -p portfolio ps` |
| certbot fails | DNS not pointing yet, or port 80 blocked by a cloud firewall/security group — open 80 and 443 |
| `!reset` / `!override` error from compose | Docker Compose older than 2.24 — `apt-get install docker-compose-plugin` or reinstall via get.docker.com |

**Other web server on port 80:** don't install nginx. Proxy `portfolio.exora.solutions` → `http://127.0.0.1:3101` in the existing server (read timeout ≥ 180 s), issue the certificate with that server's tooling, and run the script with nginx already handled (comment out steps 6–7).

## Security notes

- Only nginx is public. Web is 127.0.0.1:3101; the API, agent-runner, WhatsApp gateway and both Postgres bind to localhost or Docker networks only.
- All demo users share `DEMO_PASSWORD` — change it before sharing with anyone beyond the investor.
- The root password was shared in chat: **rotate it** (`passwd`) and prefer SSH keys (`PasswordAuthentication no`).
