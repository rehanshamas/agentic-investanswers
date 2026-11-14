// M2-05: GET /instruments, the chart's instrument picker. The same listing the
// MCP tool gives agents (what is served, what the caller's plan includes),
// plus the display precision of each instrument's bars.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryAccountStore, MemorySessionStore, accessFromEnv } from '@aia/access';
import type { InstrumentsResponse } from '@aia/client-contract';
import { BTCUSD, ETHUSD, MemoryDataLayer, NVDA } from '@aia/data';
import { HistoryQuery } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

const T0 = 1_762_800_000;

const plansPath = join(mkdtempSync(join(tmpdir(), 'aia-instruments-')), 'plans.json');
writeFileSync(
  plansPath,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [{ id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h', '4h'] }],
    assignments: {},
  }),
);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<FastifyInstance> {
  const access = accessFromEnv({ AIA_PLANS: plansPath }, { accounts: new MemoryAccountStore(), sessions: new MemorySessionStore() });
  const data = new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD, NVDA], earliest: barTime(T0) });
  app = await buildServer({ history: new HistoryQuery({ data }), access, catalog: data, now: () => barTime(T0) });
  return app;
}

describe('GET /instruments', () => {
  it('lists every instrument with what is served, what the plan includes, and display precision', async () => {
    const a = await start();
    const signUp = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'free@example.com', password: 'correct horse battery' } });
    const { token } = signUp.json() as { token: string };

    const res = await a.inject({ method: 'GET', url: '/instruments', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual<InstrumentsResponse>({
      instruments: [
        { symbol: 'BTCUSD', kind: 'crypto', timeframes: ['1m', '5m', '15m', '1h', '4h'], included: ['1h', '4h'], pricePrecision: BTCUSD.priceScale, volumePrecision: BTCUSD.volumeScale },
        { symbol: 'ETHUSD', kind: 'crypto', timeframes: ['1m', '5m', '15m', '1h', '4h'], included: [], pricePrecision: ETHUSD.priceScale, volumePrecision: ETHUSD.volumeScale },
        { symbol: 'NVDA', kind: 'stock', timeframes: [], included: [], pricePrecision: NVDA.priceScale, volumePrecision: NVDA.volumeScale },
      ],
    });
  });

  it('needs a principal', async () => {
    const a = await start();
    expect((await a.inject({ method: 'GET', url: '/instruments' })).statusCode).toBe(401);
  });
});
