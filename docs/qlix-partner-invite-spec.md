# Qlix partner API used by Orbit

**Status (2026-11-14):** Qlix has built everything Orbit asked for. Orbit's side is in `packages/api/src/modules/qlix/` and `services/agent-runner/src/qlix-runs.js`, and `docs/QLIX_WORKSPACES.md` describes the flows.

| Qlix endpoint or event | Orbit uses it in |
|---|---|
| `POST /partners/tenants` (+ `409 qlix_workspace_exists` with `connectUrl`) | `provisionWorkspace` |
| `POST /partners/tenants/:id/rotate-key`, `DELETE /partners/tenants/:id` | `provisionWorkspace`, `disableWorkspaceQlix` |
| `POST /partners/tenants/:id/invitations`, `GET …/invitations` | `inviteOwner`, status refresh |
| `POST /partners/links/:linkId/complete`, `GET /partners/links` | `handleLinkRequested`, `syncQlixLinks` |
| Webhooks `tenant.link_requested`, `tenant.paused` → `POST /qlix/webhook` | `routes.js`, `verifyQlixSignature` |
| `POST /agents` (`runtime: hybrid`, `llmMode: proxy`, `model: openrouter/auto`, `permissionScopes: ["web.read"]`) | `createHybridAgent` |
| `runner/conversations`, `runner/local-message`, `runs/:id/claim`, `runs/:id/event`, `runs/:id/complete` | `qlix-runs.js` |
| `401` "Partner link is paused / pending_link / deactivated" on runner calls | runner answers "Qlix is disconnected" |

**Open with Qlix:** single sign-on from the Qlix plugin iframe into Orbit.
