/*
 * LiveKit, without the SDK: access tokens and webhook signatures are plain HS256 JWTs signed
 * with the API secret, and the server API is Twirp (JSON over POST). docs/MEETINGS.md.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { isProduction } from '../../core/config.js';

// `livekit-server --dev` uses this key pair; production must set its own.
const DEV_KEY = 'devkey';
const DEV_SECRET = 'secret';

export function livekitConfig(env = process.env) {
  const dev = !isProduction();
  return {
    apiKey: env.LIVEKIT_API_KEY || (dev ? DEV_KEY : ''),
    apiSecret: env.LIVEKIT_API_SECRET || (dev ? DEV_SECRET : ''),
    /** What browsers connect to, e.g. wss://orbit.example.com/lk (nginx → livekit :7880). */
    publicUrl: (env.LIVEKIT_PUBLIC_URL || (dev ? 'ws://localhost:7880' : '')).replace(/\/$/, ''),
    /** Server-to-server API base, e.g. http://meetings:7880. */
    apiUrl: (env.LIVEKIT_URL || (dev ? 'http://localhost:7880' : '')).replace(/\/$/, '').replace(/^ws/, 'http'),
  };
}

export function livekitConfigured(cfg = livekitConfig()) {
  return Boolean(cfg.apiKey && cfg.apiSecret && cfg.publicUrl);
}

/** Server-to-server calls (close room, dispatch the bot). Tests never reach a real server. */
function serverCallsEnabled(env = process.env) {
  return env.NODE_ENV !== 'test' || Boolean(env.LIVEKIT_URL);
}

/** A join token for one person in one room. */
export function joinToken({ room, identity, name, metadata, ttlSeconds = 6 * 3600 }, cfg = livekitConfig()) {
  return jwt.sign(
    {
      name,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      video: {
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
      },
    },
    cfg.apiSecret,
    { algorithm: 'HS256', issuer: cfg.apiKey, subject: String(identity), jwtid: String(identity), expiresIn: ttlSeconds, notBefore: 0 },
  );
}

/** Short-lived server token for the room-admin API. */
function adminToken(room, cfg) {
  return jwt.sign({ video: { room, roomAdmin: true, roomCreate: true, roomList: true } }, cfg.apiSecret, {
    algorithm: 'HS256',
    issuer: cfg.apiKey,
    expiresIn: 60,
  });
}

/**
 * Verify a LiveKit webhook: the Authorization header is a JWT signed with our API secret whose
 * `sha256` claim is the base64 SHA-256 of the exact body. Returns the parsed event or null.
 */
export function verifyWebhook(rawBody, authHeader, cfg = livekitConfig()) {
  if (!cfg.apiSecret || !rawBody || !authHeader) return null;
  const token = String(authHeader).replace(/^Bearer\s+/i, '');
  let claims;
  try {
    claims = jwt.verify(token, cfg.apiSecret, { algorithms: ['HS256'], issuer: cfg.apiKey });
  } catch {
    return null;
  }
  const digest = crypto.createHash('sha256').update(rawBody).digest('base64');
  const given = Buffer.from(String(claims.sha256 ?? ''));
  const expected = Buffer.from(digest);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'));
  } catch {
    return null;
  }
}

async function twirp(service, method, body, room, cfg) {
  if (!serverCallsEnabled()) return {};
  if (!cfg.apiUrl) throw new Error('LIVEKIT_URL is not set');
  const res = await fetch(`${cfg.apiUrl}/twirp/livekit.${service}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken(room, cfg)}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`LiveKit ${method} failed: ${res.status} ${await res.text().catch(() => '')}`.slice(0, 300));
  return res.json().catch(() => ({}));
}

/** Close a room and disconnect everyone in it. A room that does not exist is fine. */
export async function deleteRoom(room, cfg = livekitConfig()) {
  try {
    await twirp('RoomService', 'DeleteRoom', { room }, room, cfg);
  } catch (e) {
    if (!/404|not.?found/i.test(e.message)) throw e;
  }
}

/** Agent dispatches already made for a room (normalised to { agent_name, id }). */
export async function listDispatches(room, cfg = livekitConfig()) {
  const out = await twirp('AgentDispatchService', 'ListDispatch', { room }, room, cfg);
  const list = out.agent_dispatches ?? out.agentDispatches ?? [];
  return list.map((d) => ({ id: d.id, agent_name: d.agent_name ?? d.agentName ?? '' }));
}

/** Send a named agent worker (the meeting bot) into a room, with JSON metadata for its job. */
export async function createDispatch(room, agentName, metadata, cfg = livekitConfig()) {
  return twirp(
    'AgentDispatchService',
    'CreateDispatch',
    { room, agent_name: agentName, metadata: JSON.stringify(metadata ?? {}) },
    room,
    cfg,
  );
}
