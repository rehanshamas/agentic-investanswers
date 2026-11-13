import { describe, expect, it } from 'vitest';

import { MemoryAccountStore, MemorySessionStore } from '../adapters/memory-sign-in-stores.js';
import { NodeCryptoTokens, ScryptPasswordHasher } from '../adapters/node-crypto-sign-in.js';
import { SESSION_LIFETIME_MS } from '../domain/session.js';
import type { PrincipalResolverPort } from './principal-resolver-port.js';
import { SignIn } from './sign-in.js';

const PASSWORD = 'correct horse battery';

function setUp() {
  let now = 1_763_000_000_000;
  const sessions = new MemorySessionStore();
  const signIn = new SignIn({
    accounts: new MemoryAccountStore(),
    sessions,
    hasher: new ScryptPasswordHasher({ n: 1_024, r: 8, p: 1 }), // fast for tests
    tokens: new NodeCryptoTokens(),
    now: () => now,
  });
  return { signIn, sessions, advance: (ms: number) => (now += ms) };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('sign up', () => {
  it('creates an account, signs it in, and resolves its token to a human principal', async () => {
    const { signIn } = setUp();
    const result = await signIn.signUp('  Sham@Example.com ', PASSWORD);
    if (!result.ok) throw new Error(result.message);
    expect(result.account.email).toBe('sham@example.com');
    expect(await signIn.resolve(bearer(result.token))).toEqual({ kind: 'human', id: result.account.id });
    expect(await signIn.account(bearer(result.token))).toEqual(result.account);
  });

  it.each([
    ['an invalid email', 'not-an-email', PASSWORD, 'invalid_email'],
    ['a short password', 'a@b.co', 'short', 'weak_password'],
    ['a password of spaces', 'a@b.co', ' '.repeat(12), 'weak_password'],
    ['an overlong password', 'a@b.co', 'x'.repeat(201), 'weak_password'],
  ])('refuses %s', async (_, email, password, code) => {
    expect(await setUp().signIn.signUp(email, password)).toMatchObject({ ok: false, code });
  });

  it('refuses a second account for the same email, whatever its case', async () => {
    const { signIn } = setUp();
    await signIn.signUp('a@b.co', PASSWORD);
    expect(await signIn.signUp('A@B.CO', 'another long password')).toMatchObject({ ok: false, code: 'email_taken' });
  });
});

describe('sign in and out', () => {
  it('signs in with the right password and gives a fresh token', async () => {
    const { signIn } = setUp();
    const up = await signIn.signUp('a@b.co', PASSWORD);
    const result = await signIn.signIn('A@b.co', PASSWORD);
    if (!result.ok || !up.ok) throw new Error('expected success');
    expect(result.token).not.toBe(up.token);
    expect(result.account).toEqual(up.account);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const { signIn } = setUp();
    await signIn.signUp('a@b.co', PASSWORD);
    const wrong = await signIn.signIn('a@b.co', 'wrong password 123');
    const unknown = await signIn.signIn('nobody@b.co', PASSWORD);
    expect(wrong).toEqual(unknown);
    expect(wrong).toMatchObject({ ok: false, code: 'invalid_credentials' });
  });

  it('signing out ends that session only', async () => {
    const { signIn } = setUp();
    const first = await signIn.signUp('a@b.co', PASSWORD);
    const second = await signIn.signIn('a@b.co', PASSWORD);
    if (!first.ok || !second.ok) throw new Error('expected success');
    await signIn.signOut(bearer(first.token));
    expect(await signIn.resolve(bearer(first.token))).toBeUndefined();
    expect(await signIn.resolve(bearer(second.token))).toBeDefined();
  });

  it('a session expires after 30 days, and is removed', async () => {
    const { signIn, sessions, advance } = setUp();
    const up = await signIn.signUp('a@b.co', PASSWORD);
    if (!up.ok) throw new Error('expected success');
    advance(SESSION_LIFETIME_MS - 1);
    expect(await signIn.resolve(bearer(up.token))).toBeDefined();
    advance(1);
    expect(await signIn.resolve(bearer(up.token))).toBeUndefined();
    expect(sessions.size).toBe(0);
  });

  it('recognises nobody without a token, or with a made-up one', async () => {
    const { signIn } = setUp();
    expect(await signIn.resolve({})).toBeUndefined();
    expect(await signIn.resolve(bearer('made-up'))).toBeUndefined();
    expect(await signIn.resolve({ authorization: 'Basic abc' })).toBeUndefined();
  });

  it('stores only a hash of each token', async () => {
    const { signIn, sessions } = setUp();
    const up = await signIn.signUp('a@b.co', PASSWORD);
    if (!up.ok) throw new Error('expected success');
    const stored = await sessions.get(new NodeCryptoTokens().hashToken(up.token));
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(up.token);
  });
});

describe('swapping the resolver', () => {
  it('anything implementing PrincipalResolverPort can replace sign-in (InvestAnswers later)', async () => {
    const investAnswers: PrincipalResolverPort = {
      resolve: (c) => Promise.resolve(c.authorization === 'Bearer ia-token' ? { kind: 'human', id: 'ia-user-1' } : undefined),
    };
    const resolvers: PrincipalResolverPort[] = [setUp().signIn, investAnswers];
    for (const resolver of resolvers) expect(await resolver.resolve({})).toBeUndefined();
    expect(await investAnswers.resolve(bearer('ia-token'))).toEqual({ kind: 'human', id: 'ia-user-1' });
  });
});
