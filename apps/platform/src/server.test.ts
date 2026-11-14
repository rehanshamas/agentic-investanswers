// M2-03 done-check: contract tests for GET /bars, through the real Fastify
// server (in process) and the real HistoryQuery, RecentBars and access rules,
// on in-memory stores and cache. They pin the request parameters, the
// response shape and units, every error, paging and the cap.

import type { AccessPolicyPort } from '@aia/access';
import { accessFromEnv } from '@aia/access';
import type { CookedBarsSource, MinuteBarsSource } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer, NVDA } from '@aia/data';
import { HistoryQuery } from '@aia/serving';
import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, parseScaled, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';

/** A policy that refuses everything, as a plan that includes nothing would. */
const REFUSE_ALL: AccessPolicyPort = {
  canReadBars: () => Promise.resolve(false),
  entitlements: () =>
    Promise.resolve({ plan: { id: 'none', name: 'None' }, instruments: [], timeframes: [], upgradeUrl: 'https://example.com/upgrade' }),
};

const EARLIEST = barTime(1_730_419_200); // 2024-11-01
const T0 = 1_762_800_000; // a whole 4h boundary
const NOW = barTime(T0 + 1_200 * 300 + 10); // just after the newest 5m bar below

function fiveMinuteBars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => {
    const cents = 7_000_000 + i;
    return {
      time: barTime(T0 + i * 300),
      open: price(cents),
      high: price(cents + 25),
      low: price(cents - 25),
      close: price(cents + 10),
      volume: volume(parseScaled('1.23456789', 8) + i),
    };
  });
}

class MemoryStore implements CookedBarsSource, MinuteBarsSource {
  reads = 0;
  failing = false;
  constructor(private readonly bars: Bar[]) {}
  getRange(_symbol: string, _tf: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    return this.read('', from, until);
  }
  read(_symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    this.reads++;
    if (this.failing) return Promise.reject(new Error('S3 is down: secret-bucket-name'));
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function server(options: { bars?: Bar[]; devAuth?: boolean; allow?: boolean } = {}) {
  const store = new MemoryStore(options.bars ?? fiveMinuteBars(1_201));
  const history = new HistoryQuery({
    data: new MemoryDataLayer({ instruments: [BTCUSD, ETHUSD, NVDA], cooked: store, minutes: store, earliest: EARLIEST }),
  });
  const access = accessFromEnv(options.devAuth === false ? {} : { AIA_DEV_AUTH: '1' });
  const policy = options.allow === false ? REFUSE_ALL : access.policy;
  app = await buildServer({ history, access: { principals: access.principals, policy }, now: () => NOW });
  return { app, store };
}

const get = async (url: string, headers: Record<string, string> = {}) => {
  const { app: a } = app === undefined ? await server() : { app };
  return a.inject({ method: 'GET', url, headers });
};

describe('GET /bars: success', () => {
  it('returns the newest page, ascending, in display units, with next', async () => {
    await server();
    const res = await get('/bars?instrument=BTCUSD&tf=5m&limit=2');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({
      instrument: 'BTCUSD',
      timeframe: '5m',
      bars: [
        { time: T0 + 1_199 * 300, open: 70_011.99, high: 70_012.24, low: 70_011.74, close: 70_012.09, volume: 1.23457988 },
        { time: T0 + 1_200 * 300, open: 70_012, high: 70_012.25, low: 70_011.75, close: 70_012.1, volume: 1.23457989 },
      ],
      next: T0 + 1_199 * 300,
    });
  });

  it('gives 500 bars when limit is omitted', async () => {
    await server();
    const body = (await get('/bars?instrument=BTCUSD&tf=5m')).json();
    expect(body.bars).toHaveLength(500);
  });

  it('serves a repeated request from the cache, with no store read', async () => {
    const { store } = await server();
    await get('/bars?instrument=BTCUSD&tf=5m&limit=100');
    const reads = store.reads;
    const res = await get('/bars?instrument=BTCUSD&tf=5m&limit=100');
    expect(res.statusCode).toBe(200);
    expect(store.reads).toBe(reads);
  });

  it('pages back with next until null, giving every bar once, in order', async () => {
    await server({ bars: fiveMinuteBars(1_201) });
    const times: number[] = [];
    let url = '/bars?instrument=BTCUSD&tf=5m&limit=1000';
    for (let pages = 0; pages < 10; pages++) {
      const body = (await get(url)).json() as { bars: Array<{ time: number }>; next: number | null };
      times.unshift(...body.bars.map((b) => b.time));
      if (body.next === null) break;
      url = `/bars?instrument=BTCUSD&tf=5m&limit=1000&before=${body.next}`;
    }
    expect(times).toEqual(fiveMinuteBars(1_201).map((b) => b.time));
  });

  it('compresses large responses for clients that accept gzip', async () => {
    await server();
    const res = await get('/bars?instrument=BTCUSD&tf=5m&limit=500', { 'accept-encoding': 'gzip' });
    expect(res.headers['content-encoding']).toBe('gzip');
  });
});

describe('GET /bars: the cap', () => {
  it('accepts 1,000 bars and refuses 1,001 with 400 limit_too_large', async () => {
    await server();
    const ok = await get('/bars?instrument=BTCUSD&tf=5m&limit=1000');
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bars).toHaveLength(1_000);

    const refused = await get('/bars?instrument=BTCUSD&tf=5m&limit=1001');
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('limit_too_large');
    expect(refused.json().error.message).toContain('1000');
  });
});

describe('GET /bars: errors', () => {
  it.each([
    ['/bars?tf=5m', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD&tf=7m', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD&tf=5m&limit=abc', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD&tf=5m&before=1762800000000', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD&tf=5m&interval=5m', 400, 'bad_parameter'],
    ['/bars?instrument=BTCUSD&instrument=ETHUSD&tf=5m', 400, 'bad_parameter'],
    ['/bars?instrument=DOGEUSD&tf=5m', 404, 'unknown_instrument'],
    ['/bars?instrument=NVDA&tf=5m', 409, 'timeframe_not_served'],
    ['/bars?instrument=BTCUSD&tf=1D', 409, 'timeframe_not_served'],
    ['/nothing-here', 404, 'not_found'],
  ])('%s gives %i %s', async (url, status, code) => {
    await server();
    const res = await get(url);
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual({ error: { code, message: expect.any(String) } });
  });

  it('gives 401 to a request with no principal, before looking at anything else', async () => {
    const { store } = await server({ devAuth: false });
    const res = await get('/bars?instrument=BTCUSD&tf=5m&limit=99999');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthorized');
    expect(store.reads).toBe(0);
  });

  it('gives 403 when the policy refuses, without reading bars', async () => {
    const { store } = await server({ allow: false });
    const res = await get('/bars?instrument=BTCUSD&tf=5m');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('forbidden');
    expect(store.reads).toBe(0);
  });

  it('gives 500 without internal detail when the store fails', async () => {
    const { store } = await server();
    store.failing = true;
    const res = await get('/bars?instrument=BTCUSD&tf=5m');
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal');
    expect(res.body).not.toContain('secret-bucket-name');
  });
});

describe('GET /health', () => {
  it('answers without a principal', async () => {
    await server({ devAuth: false });
    expect((await get('/health')).json()).toEqual({ ok: true });
  });
});
