/*
 * Records one Orbit agent turn as a run of the workspace's own Qlix agent, using Qlix's generic
 * hybrid-runner endpoints (no Orbit-specific code in Qlix):
 *   POST /agents/:id/runner/conversations      → a conversation per agent, channel and person
 *   POST /agents/:id/runner/local-message      → the run (status 'queued' until completed)
 *   POST /agents/:id/runs/:runId/event         → one log line per tool call (name + ok/error only)
 *   POST /agents/:id/runs/:runId/complete      → final reply or error
 * Orbit executes the run itself, so it never polls (polling would hand out other people's runs).
 * Failures here never break the turn: the person still gets an answer; only Qlix's record is lost.
 */
const TIMEOUT_MS = 10_000;
const MAX_MESSAGE = 32_000;
const CHANNEL_TITLES = { web: 'Web chat', whatsapp: 'WhatsApp', report: 'Reports' };

async function qlix(creds, path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${creds.backend_url}/api/v1/agents/${encodeURIComponent(creds.agent_id)}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-QLIX-Runner-Token': creds.runner_token },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error?.message ?? `Qlix ${path} failed (${res.status})`);
      err.code = data?.error?.code;
      err.status = res.status;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function newConversation(creds, title, saveConversation) {
  const out = await qlix(creds, '/runner/conversations', { title: title.slice(0, 120) });
  const id = out?.conversation?.id;
  if (!id) throw new Error('Qlix did not return a conversation id');
  await saveConversation(id).catch(() => {});
  return id;
}

/**
 * Open a Qlix run for this turn. Returns { runId, conversationId } or null if Qlix is unavailable.
 * `saveConversation(id)` stores a newly created conversation id back in Orbit.
 */
export async function startQlixRun(creds, { message, personName, saveConversation }) {
  const title = `${CHANNEL_TITLES[creds.channel] ?? 'Agent'}${personName ? ` · ${personName}` : ''}`;
  const text = String(message ?? '').slice(0, MAX_MESSAGE) || '(empty message)';
  try {
    let conversationId = creds.conversation_id || (await newConversation(creds, title, saveConversation));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const out = await qlix(creds, '/runner/local-message', { message: text, conversationId });
        // 'steered' = Qlix folded the message into a run still open in this conversation. That run
        // belongs to an earlier turn, so start this turn in a fresh conversation instead.
        if (out?.status === 'accepted' && out.runId) {
          // Mark it running while Orbit works on it (optional: complete accepts queued runs too).
          await qlix(creds, `/runs/${encodeURIComponent(out.runId)}/claim`, {}).catch((e) => {
            if (e.status === 401) throw e;
          });
          return { runId: out.runId, conversationId };
        }
      } catch (e) {
        if (e.code !== 'conversation_not_found') throw e;
      }
      conversationId = await newConversation(creds, title, saveConversation);
    }
    throw new Error('Qlix would not open a run for this turn');
  } catch (e) {
    // 401 = the Qlix link is paused, pending or deactivated: the turn must stop, not carry on.
    if (e.status === 401) return { disconnected: true, reason: e.message };
    console.warn(`[qlix-runs] run not recorded in Qlix (${creds.channel}): ${e.message}`);
    return null;
  }
}

/** True when an error from a Qlix call (or the ADK turn) means the workspace's link is off. */
export function isQlixDisconnected(message) {
  return /QLIX_401|partner link is (paused|pending_link|deactivated)|pending_link|runner_unauthorized|\b401\b/i.test(
    String(message ?? ''),
  );
}

/** Record which tools ran (names and outcome only, never their data) and close the run. */
export async function finishQlixRun(creds, runId, { reply, tools, error }) {
  if (!runId) return;
  try {
    for (const t of tools ?? []) {
      if (!t?.action) continue;
      const failed = Boolean(t.result && typeof t.result === 'object' && t.result.error);
      await qlix(creds, `/runs/${encodeURIComponent(runId)}/event`, {
        type: 'log',
        data: { message: 'tool_call', tool: String(t.action), ok: !failed },
      });
    }
    await qlix(
      creds,
      `/runs/${encodeURIComponent(runId)}/complete`,
      error ? { ok: false, errorMessage: String(error).slice(0, 10_000) } : { ok: true, result: String(reply ?? '') },
    );
  } catch (e) {
    console.warn(`[qlix-runs] could not close run ${runId}: ${e.message}`);
  }
}
