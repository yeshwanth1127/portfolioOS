/**
 * MessagingAdapter — Baileys first; swap implementation without changing callers.
 */

export class StubAdapter {
  async send(_to, body, kind) {
    console.log('[wa stub send]', kind, body.slice(0, 80));
    return { ok: true, stub: true };
  }

  async health() {
    return { connected: false, since: null, mode: 'stub' };
  }
}

export function createAdapter() {
  if (process.env.WA_DISABLE === '1') {
    return new StubAdapter();
  }
  return new StubAdapter();
}
