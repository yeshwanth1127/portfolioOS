# PortfolioOS agent rules

## Do not modify ADK for Portfolio tools

**Never edit `qlix-monorepo/adk_new` (or `qlix-final`, or `backend-adk`) to add, rename, or document PortfolioOS tools.**

ADK is a separate, shared agent runtime. Hardcoding this product’s actions into ADK (capability enums, executor factory lists, playbooks) couples every product change to that repo and does not scale to other projects.

### Source of truth

| Concern | Where it lives |
|---------|----------------|
| Tool names, permissions, SQL, handlers | **This repo** — `packages/api` (`agent-tools.js`, `domain/`) |
| Tool catalogue for agents | **This repo** — `GET /agent/tools/catalog` (see below) |
| Playbook / when-to-use copy for Portfolio | **This repo** — serve with the catalogue (or docs), not ADK |
| Generic LLM runtime, sessions, inference | ADK / `backend-adk` — **product-agnostic** |

### Required architecture

1. **Portfolio owns the catalogue.** New tools = new actions in Portfolio only, then they appear on the catalogue endpoint.
2. **ADK must discover tools at runtime** by reading Portfolio’s catalogue and calling `POST /agent/tools/portfolio_os` with `{ "action": "<name>", ... }`. No Portfolio-specific action enums in ADK.
3. **Leave ADK as a generic client.** If ADK currently has a hardcoded `portfolio_os` action list or playbook, treat that as legacy. Do not extend it. Restore / keep ADK generic; discovery belongs in the platform layer, not per-product forks.
4. **This repo never patches ADK** to “match” Portfolio. If Agent chat lags the API, fix discovery + catalogue — not another ADK hand-edit.

### When adding a tool

1. Implement in `packages/api` (`dispatchAgentTool` + domain + `actionAllowed`).
2. Ensure it shows up on `GET /agent/tools/catalog`.
3. Update `docs/agent-tools.md` if needed.
4. **Do not** open `adk_new` to register the action.

### Out of scope for ADK edits from Portfolio work

- `portfolio_os_capability.py` action lists  
- `portfolio_os_executor_factory.py` handler maps  
- `portfolio_os_playbook.py`  

Those files must not grow with Portfolio features.
