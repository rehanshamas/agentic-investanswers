// Synthetic responses in Massive's shape, not recorded Massive data.

import type { Instrument } from '@aia/shared-kernel';
import { barTimeFromUtcParts } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { MassiveAggregates, MassiveError, parseAggregates } from './massive-aggregates.js';

const NVDA: Instrument = {
  symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ', timeZone: 'America/New_York',
  priceScale: 2, volumeScale: 0, rawPriceScale: 6, rawVolumeScale: 6,
};
const KEY = 'test-key-not-real-0123456789abcdef';

const ms = (y: number, mo: number, d: number, h: number, mi: number): number =>
  barTimeFromUtcParts(y, mo, d, h, mi) * 1000;
const agg = (t: number, p = 201.1154, v = 149703.790541) => ({ t, o: p, h: p, l: p, c: p, v, vw: p, n: 3 });
const page = (results: unknown[], next?: string) => ({
  ticker: 'NVDA', status: 'OK', resultsCount: results.length, results, ...(next ? { next_url: next } : {}),
});

describe('parseAggregates', () => {
  it('keeps prices and volumes to 6 places, as Massive sends them', () => {
    const { bars } = parseAggregates(NVDA, page([agg(ms(2026, 11, 5, 14, 30), 174.617297)]), new Set(['2026-11-05']));
    expect(bars.get('2026-11-05')?.[0]).toMatchObject({ open: 174617297, volume: 149703790541 });
  });

  it('groups by UTC day: winter after-hours to 20:00 New York falls on the next UTC day', () => {
    // 2026-11-05 19:59 New York (EST) is 2026-11-06 00:59 UTC.
    const dates = new Set(['2026-11-05', '2026-11-06']);
    const { bars } = parseAggregates(NVDA, page([agg(ms(2026, 11, 5, 23, 59)), agg(ms(2026, 11, 6, 0, 59))]), dates);
    expect(bars.get('2026-11-05')).toHaveLength(1);
    expect(bars.get('2026-11-06')).toHaveLength(1);
  });

  it('drops bars for dates that were not asked for', () => {
    const { bars } = parseAggregates(NVDA, page([agg(ms(2026, 11, 4, 15, 0))]), new Set(['2026-11-05']));
    expect(bars.size).toBe(0);
  });

  it('refuses a price with more than 6 places, and a time off the minute', () => {
    expect(() => parseAggregates(NVDA, page([agg(ms(2026, 11, 5, 15, 0), 201.1154512)]), new Set(['2026-11-05']))).toThrow(
      /decimal places/,
    );
    expect(() => parseAggregates(NVDA, page([agg(ms(2026, 11, 5, 15, 0) + 500)]), new Set(['2026-11-05']))).toThrow(
      /whole minute/,
    );
  });

  it('refuses an error status rather than reading it as an empty day', () => {
    expect(() => parseAggregates(NVDA, { status: 'NOT_AUTHORIZED', message: 'plan' }, new Set())).toThrow(MassiveError);
  });

  it('treats a day with no results as empty', () => {
    expect(parseAggregates(NVDA, { status: 'OK', resultsCount: 0 }, new Set(['2026-11-07'])).bars.size).toBe(0);
  });
});

/** A fake fetch answering from a queue, recording URLs and headers. */
function fakeFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const queue = [...responses];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(input), auth: headers['Authorization'] });
    const next = queue.shift();
    return Promise.resolve(next === undefined ? Response.json(page([])) : next());
  };
  return { fetch: fn as typeof fetch, calls };
}
const noSleep = (): Promise<void> => Promise.resolve();

describe('MassiveAggregates.fetchDays', () => {
  it('asks once for the whole span, unadjusted, with the key only in the header', async () => {
    const { fetch, calls } = fakeFetch([() => Response.json(page([agg(ms(2026, 11, 3, 15, 0)), agg(ms(2026, 11, 5, 15, 0))]))]);
    const result = await new MassiveAggregates({ apiKey: KEY, fetch, sleep: noSleep }).fetchDays(NVDA, [
      '2026-11-05', '2026-11-03', '2026-11-04',
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `https://api.massive.com/v2/aggs/ticker/NVDA/range/1/minute/${ms(2026, 11, 3, 0, 0)}/${ms(2026, 11, 5, 23, 59)}` +
        '?adjusted=false&sort=asc&limit=50000',
    );
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.auth).toBe(`Bearer ${KEY}`);
    expect([...result.keys()]).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
    expect(result.get('2026-11-04')).toEqual([]);
  });

  it('follows next_url, keeping the key in the header', async () => {
    const next = 'https://api.massive.com/v2/aggs/ticker/NVDA/range/1/minute/x/y?cursor=abc';
    const { fetch, calls } = fakeFetch([
      () => Response.json(page([agg(ms(2026, 11, 5, 15, 0))], next)),
      () => Response.json(page([agg(ms(2026, 11, 5, 15, 1))])),
    ]);
    const result = await new MassiveAggregates({ apiKey: KEY, fetch, sleep: noSleep }).fetchDays(NVDA, ['2026-11-05']);
    expect(calls.map((c) => c.url)).toEqual([expect.any(String), next]);
    expect(calls[1]?.auth).toBe(`Bearer ${KEY}`);
    expect(result.get('2026-11-05')).toHaveLength(2);
  });

  it('waits out a 429 as Retry-After says, then succeeds', async () => {
    const waits: number[] = [];
    const { fetch, calls } = fakeFetch([
      () => new Response('{"status":"ERROR"}', { status: 429, headers: { 'Retry-After': '60' } }),
      () => Response.json(page([])),
    ]);
    await new MassiveAggregates({
      apiKey: KEY, fetch, minIntervalMs: 0,
      sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
    }).fetchDays(NVDA, ['2026-11-05']);
    expect(waits).toContain(60_000);
    expect(calls).toHaveLength(2);
  });

  it('never puts the key in an error', async () => {
    const { fetch } = fakeFetch([() => new Response('{"status":"NOT_AUTHORIZED"}', { status: 403 })]);
    const error = await new MassiveAggregates({ apiKey: KEY, fetch, sleep: noSleep })
      .fetchDays(NVDA, ['2019-06-03'])
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(MassiveError);
    expect(String((error as Error).message)).toContain('HTTP 403');
    expect(String((error as Error).message)).not.toContain(KEY);
  });

  it('refuses to start without a key', () => {
    expect(() => new MassiveAggregates({ apiKey: '' })).toThrow(MassiveError);
  });
});
