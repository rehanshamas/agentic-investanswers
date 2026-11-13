// M2-08: the app's own sign-in through the real Fastify server: sign up, sign
// in, sign out, and the session token accepted by /bars and /live.

import { request as httpRequest } from 'node:http';

import { AllowEverythingPolicy, MemoryAccountStore, MemorySessionStore, NodeCryptoTokens, ScryptPasswordHasher, SignIn } from '@aia/access';
import { BTCUSD, ETHUSD, HistoryQuery, LiveGateway, MemoryRecentBarsCache, RecentBars } from '@aia/market-data';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const empty = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };
const PASSWORD = 'correct horse battery';

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start(options: { listen?: boolean } = {}) {
  const signIn = new SignIn({
    accounts: new MemoryAccountStore(),
    sessions: new MemorySessionStore(),
    hasher: new ScryptPasswordHasher({ n: 1_024, r: 8, p: 1 }),
    tokens: new NodeCryptoTokens(),
    now: () => T0 * 1_000,
  });
  const history = new HistoryQuery({
    recentBars: new RecentBars({ cache: new MemoryRecentBarsCache(), store: empty, minutes: empty }),
    instruments: [BTCUSD, ETHUSD],
    earliest: () => barTime(T0),
  });
  gateway = new LiveGateway({ instruments: [BTCUSD, ETHUSD], every: () => () => undefined });
  app = await buildServer({
    history,
    access: { principals: signIn, policy: new AllowEverythingPolicy(), signIn },
    live: gateway,
    now: () => barTime(T0),
  });
  if (options.listen) await app.listen({ port: 0, host: '127.0.0.1' });
  return app;
}

const post = (a: FastifyInstance, url: string, payload?: unknown, token?: string) =>
  a.inject({ method: 'POST', url, ...(payload === undefined ? {} : { payload: payload as object }), headers: token ? { authorization: `Bearer ${token}` } : {} });
const getWith = (a: FastifyInstance, url: string, token?: string) =>
  a.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });

async function signUp(a: FastifyInstance, email = 'sham@example.com'): Promise<string> {
  const res = await post(a, '/auth/sign-up', { email, password: PASSWORD });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

describe('sign-up, sign-in and sign-out', () => {
  it('signs up, then the token reads bars and says who is signed in', async () => {
    const a = await start();
    const res = await post(a, '/auth/sign-up', { email: 'Sham@Example.com', password: PASSWORD });
    expect(res.statusCode).toBe(201);
    const { token, account } = res.json() as { token: string; account: { id: string; email: string } };
    expect(account.email).toBe('sham@example.com');
    expect(JSON.stringify(res.json())).not.toContain(PASSWORD);

    expect((await getWith(a, '/auth/me', token)).json()).toEqual(account);
    expect((await getWith(a, '/bars?instrument=BTCUSD&tf=5m', token)).statusCode).toBe(200);
  });

  it('refuses a bad sign-up with a reason', async () => {
    const a = await start();
    await signUp(a);
    expect((await post(a, '/auth/sign-up', { email: 'nope', password: PASSWORD })).json()).toMatchObject({ error: { code: 'invalid_email' } });
    expect((await post(a, '/auth/sign-up', { email: 'x@y.co', password: 'short' })).statusCode).toBe(400);
    const taken = await post(a, '/auth/sign-up', { email: 'SHAM@example.com', password: PASSWORD });
    expect(taken.statusCode).toBe(409);
    expect((await post(a, '/auth/sign-up', { email: 'x@y.co' })).json()).toMatchObject({ error: { code: 'bad_request' } });
    const unreadable = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: '{not json', headers: { 'content-type': 'application/json' } });
    expect(unreadable.statusCode).toBe(400);
  });

  it('signs in with the right password only', async () => {
    const a = await start();
    await signUp(a);
    const ok = await post(a, '/auth/sign-in', { email: 'sham@example.com', password: PASSWORD });
    expect(ok.statusCode).toBe(200);
    const wrong = await post(a, '/auth/sign-in', { email: 'sham@example.com', password: 'wrong password 1' });
    const unknown = await post(a, '/auth/sign-in', { email: 'nobody@example.com', password: PASSWORD });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it('signing out ends the session: /bars and /auth/me refuse the token', async () => {
    const a = await start();
    const token = await signUp(a);
    expect((await post(a, '/auth/sign-out', undefined, token)).statusCode).toBe(204);
    expect((await getWith(a, '/bars?instrument=BTCUSD&tf=5m', token)).statusCode).toBe(401);
    expect((await getWith(a, '/auth/me', token)).statusCode).toBe(401);
  });

  it('refuses /bars without a token or with a made-up one', async () => {
    const a = await start();
    expect((await getWith(a, '/bars?instrument=BTCUSD&tf=5m')).statusCode).toBe(401);
    expect((await getWith(a, '/bars?instrument=BTCUSD&tf=5m', 'made-up')).statusCode).toBe(401);
  });

  it('refuses an oversized body', async () => {
    const a = await start();
    const res = await post(a, '/auth/sign-up', { email: 'a@b.co', password: 'x'.repeat(10_000) });
    expect(res.statusCode).toBe(413);
  });
});

function upgradeStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      port,
      host: '127.0.0.1',
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /live with a session token', () => {
  it('accepts a live session token in the query and refuses a signed-out one', async () => {
    const a = await start({ listen: true });
    const address = a.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const token = await signUp(a);
    expect(await upgradeStatus(port, `/live?token=${token}`)).toBe(101);
    await post(a, '/auth/sign-out', undefined, token);
    expect(await upgradeStatus(port, `/live?token=${token}`)).toBe(401);
  });
});
