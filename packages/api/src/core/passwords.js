import crypto from 'crypto';

/*
 * Password hashing with scrypt (Node built-in, memory-hard; no native dependency to build).
 * Stored format:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *
 * Legacy MVP hashes are sha256('portfolio-os:' + password) as 64 hex characters. They still
 * verify once, and the caller replaces them with a scrypt hash on that successful login.
 */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

const scrypt = (plain, salt, n, r, p) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (e, key) => (e ? reject(e) : resolve(key)));
  });

export async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters.');
  }
  const salt = crypto.randomBytes(16);
  const key = await scrypt(plain, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function isLegacyHash(stored) {
  return /^[0-9a-f]{64}$/.test(String(stored ?? ''));
}

/**
 * @returns {Promise<{ ok: boolean, needsUpgrade: boolean }>}
 *   needsUpgrade is true when the stored hash is the legacy format (rehash after a successful login).
 */
export async function verifyPassword(plain, stored) {
  if (typeof plain !== 'string' || !stored) return { ok: false, needsUpgrade: false };
  if (isLegacyHash(stored)) {
    const legacy = crypto.createHash('sha256').update(`portfolio-os:${plain}`).digest();
    const ok = crypto.timingSafeEqual(legacy, Buffer.from(stored, 'hex'));
    return { ok, needsUpgrade: ok };
  }
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, needsUpgrade: false };
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(plain, Buffer.from(saltB64, 'base64'), Number(n), Number(r), Number(p));
  const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
  return { ok, needsUpgrade: ok && Number(n) < N };
}
