#!/usr/bin/env python3
"""Run one PortfolioOS turn through adk_new AgentRunRunner."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

adk_path = Path(os.environ.get("QLIX_ADK_PATH", "")).resolve()
if str(adk_path) not in sys.path and adk_path.exists():
    sys.path.insert(0, str(adk_path))

from adk_new.capabilities.shared.portfolio_os.portfolio_os_turn import run_portfolio_turn  # noqa: E402


def _model_client(payload: dict):
    """Qlix inference tied to this turn's Qlix run, so the run shows its model calls.

    Without a run id, return None and let run_portfolio_turn build its default client.
    """
    run_id = payload.get("qlix_run_id") or ""
    backend_url = payload.get("qlix_backend_url") or ""
    agent_id = payload.get("qlix_agent_id") or ""
    runner_token = payload.get("qlix_runner_token") or ""
    if not (run_id and backend_url and agent_id and runner_token):
        return None
    from adk_new.runner.backend_model_client import BackendModelClient  # noqa: E402

    return BackendModelClient(
        backend_url=backend_url,
        agent_id=agent_id,
        runner_token=runner_token,
        run_id=run_id,
    )


def main() -> None:
    payload = json.loads(os.environ["PORTFOLIO_RUN_JSON"])
    result = run_portfolio_turn(
        model_client=_model_client(payload),
        api_url=os.environ.get("PORTFOLIOOS_API_URL", "http://localhost:4001"),
        run_token=payload["run_token"],
        membership=payload["membership"],
        agent_id=payload["agent_id"],
        message=payload.get("message") or "",
        history=payload.get("history") or [],
        qlix_backend_url=payload.get("qlix_backend_url") or "",
        qlix_agent_id=payload.get("qlix_agent_id") or "",
        qlix_runner_token=payload.get("qlix_runner_token") or "",
        focus_org_slug=payload.get("focus_org_slug") or "",
    )
    print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        # A 401 from Qlix (inference/chat or any runner call) means the workspace's Qlix link is
        # paused, pending or gone: tell the runner plainly so it answers "Qlix is disconnected".
        if getattr(exc, "status_code", None) == 401 or getattr(getattr(exc, "response", None), "status_code", None) == 401:
            print(f"QLIX_401: {exc}", file=sys.stderr)
            sys.exit(3)
        raise
