# Qlix per workspace

Every Orbit workspace has its own **Qlix organisation** with two **hybrid agents**:

| Agent | Used for | Run-token profile |
|---|---|---|
| Assistant | web Agent chat, WhatsApp | default |
| Report writer | report summaries | `report` (only `report_data` for one report) |

Each agent turn is recorded as a run in that org, so the Qlix dashboard shows each workspace's conversations, tool calls (names only), replies and usage separately.

## Two ways a workspace gets its Qlix org

| Case | What happens | `link_mode` |
|---|---|---|
| Owner is new to Qlix | Orbit creates the org (`POST /partners/tenants`), then both agents. The owner gets a one-time Qlix sign-in link in **Settings → Qlix agents**. Qlix sends no email. | `created` |
| Owner already uses Qlix | Creating the tenant returns `409 qlix_workspace_exists`. The workspace waits (`waiting_link`) and Settings tells the owner to turn on the Orbit plugin in Qlix. Qlix then sends `tenant.link_requested`, and Orbit completes the link and creates both agents in their existing org. No owner invite is sent. | `linked` |

**Plugin turned off in Qlix:** Qlix sends `tenant.paused`, and the workspace becomes `paused`. The assistant says "Qlix is disconnected" and nothing is deleted. Turning it back on sends `tenant.link_requested` with Orbit's workspace id, and Orbit reuses the same agents with a new tenant key.

**Webhooks:** Qlix posts to `POST /qlix/webhook` (locally `http://portfolio:4001/qlix/webhook`) and signs each one with `X-Qlix-Signature: t=…,v1=HMAC_SHA256(QLIX_WEBHOOK_SECRET, "t.rawBody")`. Bad or older-than-5-minute signatures get `401`. Orbit replies `202` at once and does the work afterwards. Every 3 minutes, and at startup, the API also reads `GET /partners/links` and handles any link it missed (`QLIX_LINK_SYNC_MS`).

**Iframe:** Qlix shows Orbit inside its Orbit plugin. The web app sends `Content-Security-Policy: frame-ancestors 'self' http://localhost:3010` (`QLIX_FRAME_ANCESTORS`, set at build time). Use `http://localhost:3001` for Orbit, not `127.0.0.1`, so sign-in works inside the frame.

## How an agent reaches workspace data

The agent never connects to Orbit's database and holds no standing Orbit credential. For each turn:

1. The agent runner asks the API for a **15-minute run token** for the person asking (`POST /agent/runs`, `signRunToken`).
2. The same response carries this workspace's Qlix agent id and runner token (`qlix` block). Only the service-secret runner receives it.
3. The runner opens a Qlix run (`runner/local-message`), runs the ADK loop locally, and calls Orbit tools (`POST /agent/tools/portfolio_os`) with the run token. Every tool call runs in that person's database session, so row-level security keeps it to their workspace and role.
4. The runner logs each tool's name and outcome to the run, then completes it with the reply.

Qlix sees the prompt, the tool results the model reads during the turn (through its inference proxy), and the reply. Its run history stores the prompt, the tool names and outcomes, and the reply. It doesn't store tool result payloads.

## Code

| Piece | File |
|---|---|
| Table `workspace_qlix` (owner-only, secrets encrypted) | `packages/db/migrations/024_workspace_qlix.sql` |
| Encryption (AES-256-GCM, `QLIX_SECRETS_KEY`) | `packages/api/src/core/secrets.js` |
| Qlix partner/tenant client | `packages/api/src/modules/qlix/client.js` |
| Provisioning job, credentials for the runner | `packages/api/src/modules/qlix/provision.js` |
| Routes: signup hook, `/agent/runs` `qlix` block, `/qlix/status`, `/qlix/retry`, `/agent/qlix/conversation` | `packages/api/src/routes.js` |
| Run lifecycle in the runner | `services/agent-runner/src/qlix-runs.js`, `index.js`, `run_portfolio_agent.py` |
| Owner UI (Settings → Qlix agents) | `apps/web/app/components/qlix-settings.js` |
| Existing workspaces | `packages/api/scripts/qlix-provision.mjs` |

## Setup

1. On the Qlix server, set `PARTNER_REGISTRATION_KEY` and register Orbit once:
   ```bash
   curl -X POST $QLIX_BACKEND_URL/api/v1/partners/register \
     -H "x-admin-key: $PARTNER_REGISTRATION_KEY" -H 'Content-Type: application/json' \
     -d '{"slug":"orbit","name":"Orbit"}'
   ```
2. In Orbit's `.env`:
   - `QLIX_BACKEND_URL=http://backend:4000` (shared `exora` Docker network)
   - `QLIX_PARTNER_KEY` = the `partnerKey` from Qlix
   - `QLIX_WEBHOOK_SECRET` = the `whsec_…` from Qlix
   - `QLIX_SECRETS_KEY` = 32+ random characters (never change it afterwards)
   - optionally `QLIX_CONSOLE_URL`
3. New workspaces are provisioned automatically after sign-up (job `qlix_provision`, retried with backoff).
4. For existing workspaces:
   ```bash
   npm run qlix:provision -w @portfolio-os/api -- --workspace sona
   npm run qlix:provision -w @portfolio-os/api -- --status
   ```

## Moving Sona over

1. Keep `QLIX_LEGACY_AGENT_FALLBACK=1` while switching, so un-provisioned workspaces still use the shared `QLIX_AGENT_ID`.
2. Run `--workspace sona`. Check Settings → Qlix agents shows **Connected**.
3. Send one web chat, one WhatsApp message and one report. Check that all three appear as runs in the Sona org, and that the report says "Summary drafted by Qlix".
4. After a week, set `QLIX_LEGACY_AGENT_FALLBACK=0` and remove `QLIX_AGENT_ID` / `QLIX_RUNNER_TOKEN`.

Past turns aren't in Qlix, because they were never recorded there. Orbit's `agent_sessions` and `agent_tool_calls` keep them.

## Not yet possible

- **Single sign-on from Qlix into the Orbit iframe:** people sign into Orbit inside the frame. To be agreed with Qlix.
