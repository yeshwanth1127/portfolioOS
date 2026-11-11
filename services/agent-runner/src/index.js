import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_URL = process.env.PORTFOLIOOS_API_URL ?? 'http://localhost:4001';
const RUNNER_SECRET = process.env.AGENT_RUNNER_SECRET ?? 'dev-runner-secret';
const ADK_ROOT =
  process.env.QLIX_ADK_PATH ??
  path.resolve(__dirname, '../../../../../qlix-monorepo/adk_new');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, adk_root: ADK_ROOT });
});

function qlixCredentials() {
  const agentId =
    process.env.QLIX_AGENT_ID?.trim() ||
    process.env.QLIX_OWNER_AGENT_ID?.trim() ||
    '';
  const runnerToken =
    process.env.QLIX_RUNNER_TOKEN?.trim() ||
    process.env.QLIX_OWNER_RUNNER_TOKEN?.trim() ||
    '';
  return { agentId, runnerToken };
}

function pythonBin() {
  const preferred = process.env.PORTFOLIO_PYTHON || '/opt/homebrew/bin/python3.12';
  return fs.existsSync(preferred) ? preferred : 'python3';
}

function runAdkPortfolioAgent(payload) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'run_portfolio_agent.py');
    const proc = spawn(pythonBin(), [script], {
      env: {
        ...process.env,
        PORTFOLIOOS_API_URL: API_URL,
        PORTFOLIO_RUN_JSON: JSON.stringify(payload),
        QLIX_ADK_PATH: ADK_ROOT,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `exit ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        resolve({ reply: stdout.trim() || 'No response from agent.' });
      }
    });
    proc.stdin.end();
  });
}

const READ_PREFIXES = ['list_', 'show_', 'check_', 'who_', 'find_'];
const CLAIM = /\b(has|have) been (successfully )?(set|updated|recorded|added|changed|locked|assigned|removed|validated|retired|saved)\b|\bsuccessfully (set|updated|recorded|added|changed|locked|assigned|removed|validated|saved)\b/i;

/** If the reply claims a change but no write tool succeeded this turn, say so instead of misleading the user. */
function guardUnbackedClaims(result) {
  const reply = String(result?.reply ?? '');
  if (!CLAIM.test(reply)) return result;
  const writes = (result.tools ?? []).filter(
    (t) => t?.action && !READ_PREFIXES.some((p) => t.action.startsWith(p)),
  );
  const ok = writes.some((t) => t.result && !t.result.error);
  if (ok) return result;
  return {
    ...result,
    reply: 'Nothing was saved — I did not complete that change. Please send the full request again (e.g. "set the daily goal for creatives delivered to 5").',
    guarded: true,
  };
}

app.post('/run', async (req, res) => {
  if (req.headers['x-service-secret'] !== RUNNER_SECRET) {
    return res.status(401).json({ error: 'Invalid service secret' });
  }
  const { membership_id, agent_id, message, channel, history, focus_org_slug } = req.body ?? {};
  if (!membership_id || !agent_id) {
    return res.status(400).json({ error: 'membership_id and agent_id required' });
  }
  const { agentId, runnerToken } = qlixCredentials();

  const mint = await fetch(`${API_URL}/agent/runs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-service-secret': RUNNER_SECRET,
    },
    body: JSON.stringify({ membership_id, agent_id, message }),
  });
  const mintData = await mint.json();
  if (!mint.ok) return res.status(mint.status).json(mintData);

  try {
    const result = await runAdkPortfolioAgent({
      run_token: mintData.run_token,
      membership: mintData.membership,
      agent_id,
      message: message ?? '',
      channel: channel ?? 'whatsapp',
      history: history ?? [],
      focus_org_slug: focus_org_slug ?? '',
      qlix_backend_url: process.env.QLIX_BACKEND_URL ?? '',
      qlix_agent_id: agentId,
      qlix_runner_token: runnerToken,
    });
    res.json(guardUnbackedClaims(result));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const port = Number(process.env.AGENT_RUNNER_PORT ?? 3940);
app.listen(port, () => console.log(`Agent runner on :${port} (adk: ${ADK_ROOT})`));
