import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

/**
 * AES-256-GCM column transformer for data that must be encrypted at rest
 * (Discord OAuth tokens, event server passwords).
 *
 * Storage format (base64): `iv(12) : authTag(16) : ciphertext`, dot-separated.
 * The key comes from ENCRYPTION_KEY — 64 hex chars (32 bytes). Transformers are
 * instantiated at class-load time (before ConfigService exists), so the key is
 * read lazily from process.env on first use.
 */
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      'ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
    '.',
  );
}

export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted payload');
  }
  const decipher = createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return plain.toString('utf8');
}

/** TypeORM ValueTransformer — apply to a column via `{ transformer: encryptionTransformer }`. */
export const encryptionTransformer: ValueTransformer = {
  to(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    return encrypt(value);
  },
  from(value: string | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    return decrypt(value);
  },
};
