import { describe, expect, it } from 'vitest';

import { isValidEmail, normaliseEmail, passwordProblem } from './account.js';
import { bearerToken, isLive, newSession, SESSION_LIFETIME_MS } from './session.js';

describe('accounts', () => {
  it('normalises and checks emails loosely', () => {
    expect(normaliseEmail('  A.B@Example.COM ')).toBe('a.b@example.com');
    expect(isValidEmail('a@b.co')).toBe(true);
    for (const bad of ['a@b', 'a b@c.d', '@b.co', 'a@.co', '']) expect(isValidEmail(bad)).toBe(false);
  });

  it('explains a refused password', () => {
    expect(passwordProblem('short')).toBe('Use at least 10 characters');
    expect(passwordProblem('long enough now')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('reads a bearer token, case-insensitively, and nothing else', () => {
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('bearer abc ')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });

  it('is live until its expiry', () => {
    const session = newSession('h', 'acc', 1_000);
    expect(isLive(session, 1_000 + SESSION_LIFETIME_MS - 1)).toBe(true);
    expect(isLive(session, 1_000 + SESSION_LIFETIME_MS)).toBe(false);
  });
});
