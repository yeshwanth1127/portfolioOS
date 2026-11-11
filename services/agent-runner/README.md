# PortfolioOS agent-runner

Invokes **qlix-monorepo/adk_new** for WhatsApp and digest agents. Set:

```bash
export QLIX_ADK_PATH=/Users/ysw/EXORA/qlix-monorepo/adk_new
export PORTFOLIO_PYTHON=/opt/homebrew/bin/python3.12
pip install -e "$QLIX_ADK_PATH[dev]"
```

The turn uses Qlix inference. Run `backend-adk` locally (port 4000), create one hybrid agent, and set `QLIX_BACKEND_URL`, `QLIX_AGENT_ID`, and `QLIX_RUNNER_TOKEN` in the repo `.env`. PortfolioOS still enforces role on every tool call; the Qlix agent is only the model router.

Then `npm run dev` in this directory.
