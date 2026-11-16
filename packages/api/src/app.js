import cors from 'cors';
import express from 'express';
import { API_SECRETS, assertSecrets } from './core/config.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { createRouter } from './routes.js';

/** The Express app without a listener, so tests can mount it in-process. */
export function createApp() {
  assertSecrets('api', API_SECRETS);
  const app = express();
  app.use(cors());
  app.use(requestIdMiddleware());
  // Keep the exact bytes for webhooks whose signatures cover the raw body (Qlix, LiveKit).
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/qlix/webhook') || req.url?.startsWith('/livekit/webhook')) req.rawBody = buf.toString('utf8');
      },
    }),
  );
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'portfolio-os-api' }));
  app.use(createRouter());
  // Express 4 does not catch rejected async handlers: turn them into a clean 500.
  app.use((err, _req, res, _next) => {
    if (process.env.NODE_ENV !== 'test') console.error('[api] unhandled error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong. Please try again.' } });
  });
  return app;
}
