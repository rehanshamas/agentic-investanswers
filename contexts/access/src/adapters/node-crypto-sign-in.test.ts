import { describe, expect, it } from 'vitest';

import { NodeCryptoTokens, ScryptPasswordHasher } from './node-crypto-sign-in.js';

const hasher = new ScryptPasswordHasher({ n: 1_024, r: 8, p: 1 });

describe('ScryptPasswordHasher', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verify('correct horse battery', hash)).toBe(true);
    expect(await hasher.verify('correct horse batterY', hash)).toBe(false);
  });

  it('salts every hash, and never stores the password', async () => {
    const [a, b] = [await hasher.hash('same password 1'), await hasher.hash('same password 1')];
    expect(a).not.toBe(b);
    expect(a).not.toContain('same password');
    expect(a.split('$')).toHaveLength(6);
  });

  it('refuses a malformed stored hash instead of throwing', async () => {
    expect(await hasher.verify('x', 'garbage')).toBe(false);
    expect(await hasher.verify('x', 'bcrypt$1$2$3$4$5')).toBe(false);
  });

  it('checks old hashes at the cost they were made with', async () => {
    const old = await new ScryptPasswordHasher({ n: 512, r: 8, p: 1 }).hash('kept from before');
    expect(await hasher.verify('kept from before', old)).toBe(true);
  });
});

describe('NodeCryptoTokens', () => {
  const tokens = new NodeCryptoTokens();
  it('makes long, URL-safe, unique tokens and stable hashes', () => {
    const [a, b] = [tokens.newToken(), tokens.newToken()];
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokens.hashToken(a)).toBe(tokens.hashToken(a));
    expect(tokens.hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
  });
});
