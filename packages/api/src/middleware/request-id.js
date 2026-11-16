import crypto from 'crypto';

/** Attach or propagate x-request-id for structured logs (Phase 8). */
export function requestIdMiddleware() {
  return (req, res, next) => {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && incoming.length >= 8 && incoming.length <= 128
        ? incoming
        : crypto.randomUUID();
    req.requestId = id;
    res.setHeader('x-request-id', id);
    next();
  };
}
