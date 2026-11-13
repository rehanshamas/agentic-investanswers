// M2-09: plan-based access on placeholder plans, through the real server and
// the real access wiring (accessFromEnv reading a plans file). Each plan is
// tried against each route and stream, and a plan change is made by editing
// the plans file alone.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SignInStores } from '@aia/access';
import { MemoryAccountStore, MemorySessionStore, accessFromEnv } from '@aia/access';
import type { LiveServerMessage } from '@aia/market-data';
import { BTCUSD, ETHUSD, HistoryQuery, LiveGateway, MemoryRecentBarsCache, RecentBars } from '@aia/market-data';
import type { Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;
const empty = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };
const PASSWORD = 'correct horse battery';
const UPGRADE = 'https://example.com/upgrade';

const PLANS = {
  upgradeUrl: UPGRADE,
  defaultPlan: 'free',
  plans: [
    { id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h', '4h'] },
    { id: 'pro', name: 'Pro', instruments: 'all', timeframes: 'all' },
  ],
  assignments: { 'pro@example.com': 'pro' },
};

const dir = mkdtempSync(join(tmpdir(), 'aia-plans-'));
function plansFile(config: unknown): string {
  const path = join(dir, `plans-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(config));
  return path;
}

let app: FastifyInstance | undefined;
let gateway: LiveGateway | undefined;
afterEach(async () => {
  gateway?.stop();
  await app?.close();
  app = undefined;
});

/** The platform as main.ts wires it (minus storage), with plans from the given file. */
async function start(plansPath: string, stores: SignInStores) {
  const access = accessFromEnv({ AIA_PLANS: plansPath }, stores);
  const history = new HistoryQuery({
    recentBars: new RecentBars({ cache: new MemoryRecentBarsCache(), store: empty, minutes: empty }),
    instruments: [BTCUSD, ETHUSD],
    earliest: () => barTime(T0),
  });
  gateway = new LiveGateway({ instruments: [BTCUSD, ETHUSD], every: () => () => undefined });
  app = await buildServer({ history, access, live: gateway, now: () => barTime(T0) });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  return { app, port: typeof address === 'object' && address !== null ? address.port : 0 };
}

const stores = (): SignInStores => ({ accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() });

async function signUp(a: FastifyInstance, email: string): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email, password: PASSWORD } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { token: string }).token;
}

const bars = (a: FastifyInstance, token: string, symbol: string, tf: Timeframe) =>
  a.inject({ method: 'GET', url: `/bars?instrument=${symbol}&tf=${tf}`, headers: { authorization: `Bearer ${token}` } });

/** The first answer to one live subscription. */
async function subscribe(port: number, token: string, symbol: string, tf: Timeframe): Promise<LiveServerMessage> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live?token=${encodeURIComponent(token)}`);
  try {
    const first = new Promise<LiveServerMessage>((resolve) =>
      ws.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as LiveServerMessage), { once: true }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('could not connect')));
    });
    ws.send(JSON.stringify({ op: 'subscribe', instrument: symbol, tf }));
    return await first;
  } finally {
    ws.close();
  }
}

// Every plan against every kind of pair: in the plan, an instrument outside
// it, a timeframe outside it. Worked out by hand from PLANS above.
const MATRIX: readonly { plan: string; email: string; symbol: string; tf: Timeframe; allowed: boolean }[] = [
  { plan: 'free', email: 'free@example.com', symbol: 'BTCUSD', tf: '1h', allowed: true },
  { plan: 'free', email: 'free@example.com', symbol: 'BTCUSD', tf: '4h', allowed: true },
  { plan: 'free', email: 'free@example.com', symbol: 'BTCUSD', tf: '5m', allowed: false },
  { plan: 'free', email: 'free@example.com', symbol: 'ETHUSD', tf: '1h', allowed: false },
  { plan: 'pro', email: 'pro@example.com', symbol: 'BTCUSD', tf: '1h', allowed: true },
  { plan: 'pro', email: 'pro@example.com', symbol: 'BTCUSD', tf: '5m', allowed: true },
  { plan: 'pro', email: 'pro@example.com', symbol: 'ETHUSD', tf: '1m', allowed: true },
];

describe('each plan on each route and stream', () => {
  let path: string;
  beforeAll(() => {
    path = plansFile(PLANS);
  });

  it.each(MATRIX)('$plan: GET /bars $symbol $tf allowed=$allowed', async ({ email, symbol, tf, allowed }) => {
    const { app: a } = await start(path, stores());
    const res = await bars(a, await signUp(a, email), symbol, tf);
    if (allowed) {
      expect(res.statusCode).toBe(200);
    } else {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: { code: 'forbidden', message: `your plan does not include ${symbol} ${tf}`, upgradeUrl: UPGRADE } });
    }
  });

  it.each(MATRIX)('$plan: live subscribe $symbol $tf allowed=$allowed', async ({ email, symbol, tf, allowed }) => {
    const { app: a, port } = await start(path, stores());
    const answer = await subscribe(port, await signUp(a, email), symbol, tf);
    expect(answer).toMatchObject(allowed ? { type: 'subscribed', instrument: symbol, timeframe: tf } : { type: 'error', code: 'forbidden', instrument: symbol });
  });

  it.each([
    ['free@example.com', { plan: { id: 'free', name: 'Free' }, instruments: ['BTCUSD'], timeframes: ['1h', '4h'], upgradeUrl: UPGRADE }],
    ['pro@example.com', { plan: { id: 'pro', name: 'Pro' }, instruments: 'all', timeframes: 'all', upgradeUrl: UPGRADE }],
  ])('GET /plan tells %s what is included and where to upgrade', async (email, expected) => {
    const { app: a } = await start(path, stores());
    const token = await signUp(a, email);
    const res = await a.inject({ method: 'GET', url: '/plan', headers: { authorization: `Bearer ${token}` } });
    expect(res.json()).toEqual(expected);
  });

  it('GET /plan needs a principal', async () => {
    const { app: a } = await start(path, stores());
    expect((await a.inject({ method: 'GET', url: '/plan' })).statusCode).toBe(401);
  });
});

describe('a plan change is a configuration change', () => {
  it('moving an account to Pro, and changing what Free includes, take only an edit to the plans file', async () => {
    const kept = stores(); // the same accounts and sessions across the restart, as DynamoDB would keep them
    let { app: a } = await start(plansFile(PLANS), kept);
    const token = await signUp(a, 'sam@example.com');
    expect((await bars(a, token, 'ETHUSD', '1h')).statusCode).toBe(403);
    expect((await bars(a, token, 'BTCUSD', '1h')).statusCode).toBe(200);
    await app?.close();
    gateway?.stop();

    // Sam is moved to Pro; Free stops including BTCUSD 1h.
    const edited = {
      ...PLANS,
      plans: [{ ...PLANS.plans[0], timeframes: ['4h'] }, PLANS.plans[1]],
      assignments: { ...PLANS.assignments, 'sam@example.com': 'pro' },
    };
    ({ app: a } = await start(plansFile(edited), kept));
    expect((await bars(a, token, 'ETHUSD', '1h')).statusCode).toBe(200);
    const free = await signUp(a, 'free@example.com');
    expect((await bars(a, free, 'BTCUSD', '1h')).statusCode).toBe(403);
    expect((await bars(a, free, 'BTCUSD', '4h')).statusCode).toBe(200);
  });
});
