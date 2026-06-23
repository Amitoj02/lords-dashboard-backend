import { decrypt, encrypt, encryptionTransformer } from './encryption.transformer';

describe('encryption.transformer', () => {
  const KEY = 'a'.repeat(64);

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = KEY;
  });

  it('round-trips a value without leaking plaintext', () => {
    const cipher = encrypt('discord-access-token');
    expect(cipher).not.toContain('discord-access-token');
    expect(decrypt(cipher)).toBe('discord-access-token');
  });

  it('uses a random IV (different ciphertext each call)', () => {
    expect(encrypt('same')).not.toBe(encrypt('same'));
  });

  it('transformer.to/from round-trips and treats null/empty as null', () => {
    expect(encryptionTransformer.to(null)).toBeNull();
    expect(encryptionTransformer.to('')).toBeNull();
    const stored = encryptionTransformer.to('secret') as string;
    expect(encryptionTransformer.from(stored)).toBe('secret');
    expect(encryptionTransformer.from(null)).toBeNull();
  });

  it('rejects a tampered payload (GCM auth tag)', () => {
    const cipher = encrypt('secret');
    const tampered = `${cipher.slice(0, -4)}AAAA`;
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when the key is not 64 hex chars', () => {
    process.env.ENCRYPTION_KEY = 'too-short';
    expect(() => encrypt('x')).toThrow(/ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = KEY;
  });
});
