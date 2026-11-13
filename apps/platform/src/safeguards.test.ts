// M2-10: every rate limit through the real server: each is hit, then 429
// with Retry-After. Limits are tiny here; config/safeguards.json holds the
// real ones.

import { MemoryAccountStore, MemorySessionStore, MemoryRateCounter, RateLimiter, accessFromEnv, parseRateLimits } from '@aia/access';
import { BTCUSD, ETHUSD, HistoryQuery, LiveGateway, MemoryRecentBarsCache, RecentBars } from '@aia/market-data';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const NOW_MS = 1_763_000_080_000; // 40 s into a minute, 880 s into a 900 s or 3600 s window
const empty = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };
const PASSWORD = 'correct horse battery';

const LIMITS = parseRateLimits({
  rateLimits: {
    humanReads: { limit: 3, windowSeconds: 60 },
    agentReads: { limit: 2, windowSeconds: 60 },
    signIn: { limit: 2, windowSeconds: 900 },
    signUp: { limit: 3, windowSeconds: 3600 },
    agentKeyChanges: { limit: 1, windowSeconds: 3600 },
  },
});

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

async function start() {
  const history = new HistoryQuery({
    recentBars: new RecentBars({ cache: new MemoryRecentBarsCache(), store: empty, minutes: empty }),
    instruments: [BTCUSD, ETHUSD],
    earliest: () => barTime(T0),
  });
  gateway = new LiveGateway({ instruments: [BTCUSD, ETHUSD], every: () => () => undefined });
  const access = accessFromEnv({}, { accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() });
  const limits = new RateLimiter({ limits: LIMITS, counter: new MemoryRateCounter(() => NOW_MS), now: () => NOW_MS });
  app = await buildServer({ history, access, live: gateway, limits, now: () => barTime(T0) });
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signUp(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

function expectLimited(res: { statusCode: number; headers: Record<string, unknown>; json: () => unknown }, retryAfter: number) {
  expect(res.statusCode).toBe(429);
  expect(res.headers['retry-after']).toBe(String(retryAfter));
  expect(res.json()).toEqual({ error: { code: 'rate_limited', message: expect.any(String), retryAfterSeconds: retryAfter } });
}

describe('rate limits', () => {
  it('reads per user: /bars and /plan share the limit, then 429; another user is unaffected', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const kim = await signUp(a, 'kim@example.com');
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) })).statusCode).toBe(200);
    expectLimited(await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(sam) }), 20);
    expectLimited(await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) }), 20);
    expect((await a.inject({ method: 'GET', url: '/bars?instrument=BTCUSD&tf=1h', headers: auth(kim) })).statusCode).toBe(200);
  });

  it('live connections count as reads: over the limit the upgrade gets 429', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const upgrade = () =>
      a.inject({
        method: 'GET',
        url: `/live?token=${sam}`,
        headers: { connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      });
    for (let i = 0; i < 3; i += 1) await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) });
    expectLimited(await upgrade(), 20);
  });

  it('reads per agent key, with the agent limit', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const { key } = (await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(sam), payload: { name: 'bot' } })).json() as { key: string };
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(key) })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(key) })).statusCode).toBe(200);
    expectLimited(await a.inject({ method: 'GET', url: '/plan', headers: auth(key) }), 20);
    expect((await a.inject({ method: 'GET', url: '/plan', headers: auth(sam) })).statusCode).toBe(200);
  });

  it('sign-in attempts per client address, right or wrong password', async () => {
    const a = await start();
    await signUp(a, 'sam@example.com');
    const attempt = (password: string) => a.inject({ method: 'POST', url: '/auth/sign-in', payload: { email: 'sam@example.com', password } });
    expect((await attempt('wrong password!!')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    expectLimited(await attempt(PASSWORD), 20);
  });

  it('sign-ups per client address', async () => {
    const a = await start();
    for (let i = 0; i < 3; i += 1) await signUp(a, `u${i}@example.com`);
    expectLimited(await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'u9@example.com', password: PASSWORD } }), 2_720);
  });

  it('agent key changes per account', async () => {
    const a = await start();
    const sam = await signUp(a, 'sam@example.com');
    const create = () => a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(sam), payload: { name: 'bot' } });
    const first = await create();
    expect(first.statusCode).toBe(201);
    expectLimited(await create(), 2_720);
    const id = (first.json() as { agentKey: { id: string } }).agentKey.id;
    expectLimited(await a.inject({ method: 'DELETE', url: `/auth/agent-keys/${id}`, headers: auth(sam) }), 2_720);
    // Listing is not a change.
    expect((await a.inject({ method: 'GET', url: '/auth/agent-keys', headers: auth(sam) })).statusCode).toBe(200);
  });
});
