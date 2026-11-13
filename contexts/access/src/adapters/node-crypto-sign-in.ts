// Password hashing and tokens with node:crypto (M2-08). No new dependency.
//
// Passwords: scrypt (memory-hard, built into Node), a random 16-byte salt per
// password, stored as `scrypt$N$r$p$salt$hash` so the cost can be raised later
// without breaking old hashes. Tokens: 32 random bytes, base64url; stored as
// their SHA-256.

import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';

import type { PasswordHasherPort, TokenPort } from '../application/sign-in-ports.js';

const KEY_LENGTH = 32;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export class ScryptPasswordHasher implements PasswordHasherPort {
  /** N = 2^15 by default (about 32 MB, tens of milliseconds); tests pass a smaller one. */
  constructor(private readonly cost: { n: number; r: number; p: number } = { n: 32_768, r: 8, p: 1 }) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const { n, r, p } = this.cost;
    const key = await scryptAsync(password, salt, n, r, p);
    return ['scrypt', n, r, p, salt.toString('base64url'), key.toString('base64url')].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const [scheme, n, r, p, salt, key] = stored.split('$');
    if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) return false;
    const expected = Buffer.from(key, 'base64url');
    const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export class NodeCryptoTokens implements TokenPort {
  newToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  newId(): string {
    return randomUUID();
  }
}
