import crypto from 'node:crypto';

/*
 * AES-256-GCM for secrets Orbit must store and later use (Qlix tenant key, runner tokens).
 * Key: QLIX_SECRETS_KEY, any string of 32+ characters (hashed to 32 bytes).
 * Format: "v1:<iv b64>:<tag b64>:<ciphertext b64>".
 */
function key() {
  const raw = process.env.QLIX_SECRETS_KEY ?? '';
  if (raw.length < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('QLIX_SECRETS_KEY must be set (32+ characters) to store Qlix credentials.');
    }
    // Development only: a fixed key so local setups work without extra configuration.
    return crypto.createHash('sha256').update('dev-qlix-secrets-key-not-for-production').digest();
  }
  return crypto.createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':');
}

export function decryptSecret(stored) {
  if (!stored) return null;
  const [v, iv, tag, body] = String(stored).split(':');
  if (v !== 'v1' || !iv || !tag || !body) throw new Error('Unrecognised secret format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8');
}
