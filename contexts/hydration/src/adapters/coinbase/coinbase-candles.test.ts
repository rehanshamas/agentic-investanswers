// Synthetic responses in Coinbase's shape, not recorded Coinbase data.

import type { Instrument } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { dayStart } from '../../domain/raw-day.js';
import { CoinbaseCandles, CoinbaseError, coinbaseProduct, parseCandles } from './coinbase-candles.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};
const ETH: Instrument = { ...BTC, symbol: 'ETHUSD', priceScale: 3 };

const T = barTimeFromUtcParts(2026, 11, 7, 11, 54);
const FROM = barTime(T - 600);
const UNTIL = barTime(T + 600);

describe('parseCandles', () => {
  it('maps [time, low, high, open, close, volume] to Bars, ascending', () => {
    const body = [
      [T + 60, 75900.52, 75909.52, 75909.52, 75900.53, 0.14767548],
      [T, 75909.51, 75936.59, 75933.05, 75909.52, 2.16504904],
    ];
    const bars = parseCandles(BTC, body, FROM, UNTIL);
    expect(bars.map((b) => b.time)).toEqual([T, T + 60]);
    expect(bars[0]).toEqual({
      time: T,
      open: 7593305,
      high: 7593659,
      low: 7590951,
      close: 7590952,
      volume: 216504904,
    });
  });

  it('scales at the instrument: ETH carries 3 price decimals', () => {
    const [bar] = parseCandles(ETH, [[T, 220.535, 220.675, 220.6, 220.6, 1]], FROM, UNTIL);
    expect(bar).toMatchObject({ high: 220675, low: 220535, volume: 100000000 });
  });

  it('accepts float noise beyond the scale, which carries no information', () => {
    const [bar] = parseCandles(BTC, [[T, 1, 1, 1, 1, 0.30000000000000004]], FROM, UNTIL);
    expect(bar?.volume).toBe(30000000);
  });

  it('refuses real precision beyond the scale rather than rounding it into raw', () => {
    expect(() => parseCandles(BTC, [[T, 1, 1.005, 1, 1, 1]], FROM, UNTIL)).toThrow(/decimal places/);
    expect(() => parseCandles(BTC, [[T, 1, 1, 1, 1, 0.123456789]], FROM, UNTIL)).toThrow(CoinbaseError);
  });

  it('refuses a candle outside the requested range', () => {
    expect(() => parseCandles(BTC, [[UNTIL + 60, 1, 1, 1, 1, 1]], FROM, UNTIL)).toThrow(/outside/);
  });

  it('refuses duplicates, incoherent bars and malformed rows', () => {
    expect(() => parseCandles(BTC, [[T, 1, 1, 1, 1, 1], [T, 1, 1, 1, 1, 1]], FROM, UNTIL)).toThrow(
      /Duplicate/,
    );
    expect(() => parseCandles(BTC, [[T, 2, 1, 1, 1, 1]], FROM, UNTIL)).toThrow();
    expect(() => parseCandles(BTC, [[T, 1, 1]], FROM, UNTIL)).toThrow(/Malformed/);
    expect(() => parseCandles(BTC, { message: 'NotFound' }, FROM, UNTIL)).toThrow(/array/);
  });
});

describe('coinbaseProduct', () => {
  it('maps our symbols and refuses others', () => {
    expect(coinbaseProduct('BTCUSD')).toBe('BTC-USD');
    expect(coinbaseProduct('ETHUSD')).toBe('ETH-USD');
    expect(() => coinbaseProduct('NVDA')).toThrow(CoinbaseError);
  });
});

/** A fake fetch that answers from a queue and records URLs. */
function fakeFetch(responses: Array<() => Response>): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const queue = [...responses];
  const fn = (input: string | URL | Request): Promise<Response> => {
    urls.push(String(input));
    const next = queue.shift();
    if (next === undefined) return Promise.resolve(Response.json([]));
    return Promise.resolve(next());
  };
  return { fetch: fn as typeof fetch, urls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('CoinbaseCandles.fetchDay', () => {
  const day = '2026-11-07';
  const start = dayStart(day);

  it('reads the day in inclusive pages of 300 minutes, the last one ending at 23:59', async () => {
    const pages = [0, 1, 2, 3, 4].map(
      (page) => () => Response.json([[start + page * 300 * 60, 1, 1, 1, 1, 1]]),
    );
    const { fetch, urls } = fakeFetch(pages);
    const bars = await new CoinbaseCandles({ fetch, sleep: noSleep }).fetchDay(BTC, day);

    expect(bars).toHaveLength(5);
    expect(urls).toHaveLength(5);
    expect(urls[0]).toBe(
      'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60' +
        '&start=2026-11-07T00:00:00Z&end=2026-11-07T04:59:00Z',
    );
    expect(urls[4]).toContain('&start=2026-11-07T20:00:00Z&end=2026-11-07T23:59:00Z');
  });

  it('retries a 429, honouring Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    const { fetch, urls } = fakeFetch([
      () => new Response('slow down', { status: 429, headers: { 'Retry-After': '2' } }),
      () => Response.json([]),
    ]);
    await new CoinbaseCandles({
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      minIntervalMs: 0,
    }).fetchDay(BTC, day);
    expect(waits).toContain(2000);
    expect(urls).toHaveLength(6);
  });

  it('retries server errors and network failures with backoff', async () => {
    const { fetch } = fakeFetch([
      () => new Response('oops', { status: 502 }),
      () => {
        throw new TypeError('fetch failed');
      },
    ]);
    await expect(
      new CoinbaseCandles({ fetch, sleep: noSleep }).fetchDay(BTC, day),
    ).resolves.toEqual([]);
  });

  it('fails the whole day when a page keeps failing, so nothing partial is stored', async () => {
    const { fetch } = fakeFetch([
      () => Response.json([[start, 1, 1, 1, 1, 1]]),
      ...Array.from({ length: 3 }, () => () => new Response('down', { status: 503 })),
    ]);
    await expect(
      new CoinbaseCandles({ fetch, sleep: noSleep, maxAttempts: 3 }).fetchDay(BTC, day),
    ).rejects.toThrow(/after 3 attempts: HTTP 503/);
  });

  it('does not retry a client error', async () => {
    const { fetch, urls } = fakeFetch([() => new Response('NotFound', { status: 404 })]);
    await expect(
      new CoinbaseCandles({ fetch, sleep: noSleep }).fetchDay(BTC, day),
    ).rejects.toThrow(/HTTP 404/);
    expect(urls).toHaveLength(1);
  });
});
