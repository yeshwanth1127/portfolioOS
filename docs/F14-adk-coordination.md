# F14 — ADK coordination checklist

PortfolioOS owns the tool catalogue and invoke API. **qlix-monorepo/adk_new** must stay a generic HTTP client — see [AGENTS.md](../AGENTS.md). This repo does not patch ADK; use this doc when pairing with the ADK maintainer.

## Portfolio side (this repo)

| Item | Status |
|------|--------|
| `GET /agent/tools/catalog` — `action`, `summary`, `mutating`, `allowed`, `input_schema`, `requires` on writes | Done (`packages/api/src/agent-tool-schemas.js`) |
| `POST /agent/tools/portfolio_os` — single dispatch; run tokens + `X-PortfolioOS-*` headers | Done |
| Pin tested ADK git SHA | `docs/decisions.md` → `QLIX_MONOREPO_SHA` |
| Regression tests (identity, submissions, RLS, WhatsApp) | `npm test` (57 cases) |

**Catalogue smoke (from agent-runner host):**

```bash
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:4001/agent/tools/catalog | jq '.tools[0]'
# expect input_schema.type == "object"
```

## ADK side (qlix-monorepo — maintainer)

Current code (`portfolio_os_catalog.py`) still merges a hardcoded `_INPUT_PROPERTIES` map into one capability schema. **Target behaviour:**

1. **Fetch** `GET /agent/tools/catalog` each turn (already happens in `portfolio_os_turn.py`).
2. **Build tool schemas from catalogue** — for each `tools[]` entry, use `input_schema` from the API (merged with `action` enum), not `_INPUT_PROPERTIES`.
3. **Playbook** — use `catalog.playbook` only; delete duplicate hardcoded playbook strings in ADK where they drift.
4. **Scope index** — `static_scope_index_definition()` may keep minimal read/write stubs; runtime scopes come from `mutating` on each tool.
5. **Commit + test** — `adk_new/tests/test_portfolio_os_capability.py` green against a running Portfolio API with forced RLS.

### Suggested ADK diff (conceptual)

```python
# Replace definition_from_catalog() body:
# - required: ["action"] + per-action required fields from each tool's input_schema
# - properties: union of all tool input_schema.properties + action enum
# Or expose one executor tool per catalogue entry (if the runtime supports N tools per capability).
```

### Verification before Phase 0 exit

```bash
cd qlix-monorepo/adk_new && pytest tests/test_portfolio_os_capability.py -q
# Pin HEAD in sona-ecosystem/docs/decisions.md
git -C qlix-monorepo rev-parse HEAD
```

### Out of scope for Portfolio PRs

- Editing `portfolio_os_capability.py` action enums, executor factory maps, or playbooks in ADK from this repo.
- Registering new Portfolio actions only in ADK without a matching catalogue entry here.

## DEPLOY.md dependency

Part A step A1 (“push portfolio_os capability”) remains until the maintainer commit above is on the branch you deploy. After that, DEPLOY can reference a tagged qlix-monorepo revision matching `QLIX_MONOREPO_SHA`.
