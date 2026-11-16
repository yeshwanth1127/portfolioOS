/**
 * In-memory sliding-window rate limits (Phase 8 local gate).
 * Production: replace with Redis-backed limits (documented in DEPLOY.md).
 */

const buckets = new Map();

function windowMs() {
  return Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000);
}

export function maxLogin() {
  if (process.env.NODE_ENV === 'test') return Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 10_000);
  return Number(process.env.RATE_LIMIT_LOGIN_MAX ?? 20);
}

export function maxAgent() {
  if (process.env.NODE_ENV === 'test') return Number(process.env.RATE_LIMIT_AGENT_MAX ?? 10_000);
  return Number(process.env.RATE_LIMIT_AGENT_MAX ?? 120);
}

function touch(key, limit) {
  const now = Date.now();
  const win = windowMs();
  let entry = buckets.get(key);
  if (!entry || now - entry.start > win) {
    entry = { start: now, count: 0 };
    buckets.set(key, entry);
  }
  entry.count += 1;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.start + win - now) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  return { limited: false };
}

export function rateLimitLogin(req, res, next) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
  const email = String(req.body?.email ?? '').toLowerCase().slice(0, 120);
  const key = `login:${ip}:${email}`;
  const { limited, retryAfter } = touch(key, maxLogin());
  if (limited) {
    res.setHeader('retry-after', String(retryAfter));
    return res.status(429).json({
      error: { code: 'rate_limited', message: 'Too many login attempts. Try again shortly.' },
    });
  }
  next();
}

export function respondIfRateLimited(res, key, limit) {
  const { limited, retryAfter } = touch(key, limit);
  if (!limited) return false;
  res.setHeader('retry-after', String(retryAfter));
  res.status(429).json({
    error: { code: 'rate_limited', message: 'Too many requests. Slow down and retry.' },
  });
  return true;
}

export function rateLimitAgentTools(req, res, next) {
  const membershipId = req.auth?.membership?.id ?? 'anon';
  const key = `agent:${membershipId}`;
  const { limited, retryAfter } = touch(key, maxAgent());
  if (limited) {
    res.setHeader('retry-after', String(retryAfter));
    return res.status(429).json({
      error: { code: 'rate_limited', message: 'Too many agent requests. Slow down and retry.' },
    });
  }
  next();
}

/** Test helper: force a bucket over the limit. */
export function _testExhaustKey(key, limit) {
  const win = windowMs();
  buckets.set(key, { start: Date.now(), count: limit + 1 });
  return win;
}
