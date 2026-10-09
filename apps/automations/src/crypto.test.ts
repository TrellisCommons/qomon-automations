import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from './crypto.js';

describe('secret encryption', () => {
  const key = randomBytes(32);

  it('round-trips and never repeats a ciphertext', () => {
    const a = encryptSecret('sandbox-key', key);
    expect(decryptSecret(a, key)).toBe('sandbox-key');
    expect(encryptSecret('sandbox-key', key)).not.toBe(a);
  });

  it('rejects a wrong key or a tampered value', () => {
    const stored = encryptSecret('sandbox-key', key);
    expect(() => decryptSecret(stored, randomBytes(32))).toThrow();
    const parts = stored.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'), key)).toThrow();
  });
});
