// 1-minute history from Coinbase Exchange's public candles API.
//
// Why Coinbase and not CoinAPI (M1-04, Sham 2026-11-09): the TradingView
// exports are `COINBASE:BTCUSD` and `COINBASE:ETHUSD`, so this is the venue
// itself rather than a reseller of it, and on a spot check of 2026-11-07 its
// 1m candles equalled the export exactly on OHLCV. It is also free and needs
// no key, where CoinAPI's free plan is a one-time credit too small for two
// years of minutes. CoinAPI remains the plan for the live stream (M1-05).
//
// The API, as measured:
//   GET /products/BTC-USD/candles?granularity=60&start=<ISO>&end=<ISO>
//   - at most 300 candles per request; `start` and `end` are both inclusive
//   - rows are [time, low, high, open, close, volume], newest first
//   - `time` is the candle's open, in UTC epoch seconds
//   - a minute with no trades has no row

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import {
  assertCoherent,
  barTime,
  price,
  rawPriceScale,
  rawVolumeScale,
  volume,
} from '@aia/shared-kernel';

import type { HistoryProviderPort } from '../../application/history-provider-port.js';
import { dayStart } from '../../domain/raw-day.js';
import { PacedJson } from '../paced-json.js';
import { scaledNumber } from '../provider-numbers.js';

export class CoinbaseError extends Error {}

export const COINBASE_BASE_URL = 'https://api.exchange.coinbase.com';

/** Our symbols to Coinbase product ids. */
const PRODUCTS: Readonly<Record<string, string>> = {
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
};

export function coinbaseProduct(symbol: string): string {
  const product = PRODUCTS[symbol];
  if (product === undefined) throw new CoinbaseError(`No Coinbase product for ${symbol}`);
  return product;
}

const MINUTE = 60;
const DAY_MINUTES = 24 * 60;
const PAGE_MINUTES = 300;

const fail = (message: string): Error => new CoinbaseError(message);

function scaled(value: unknown, scale: number, what: string): number {
  return scaledNumber(value, scale, what, fail);
}

/** Parse one response page into ascending Bars, checking each lies in `[from, until]`. */
export function parseCandles(
  instrument: Instrument,
  body: unknown,
  from: BarTime,
  until: BarTime,
): Bar[] {
  if (!Array.isArray(body)) {
    throw new CoinbaseError(`Expected an array of candles, got ${JSON.stringify(body).slice(0, 200)}`);
  }
  const bars: Bar[] = [];
  for (const row of body as unknown[]) {
    if (!Array.isArray(row) || row.length < 6) {
      throw new CoinbaseError(`Malformed candle: ${JSON.stringify(row)}`);
    }
    const [time, low, high, open, close, vol] = row as unknown[];
    if (typeof time !== 'number' || !Number.isInteger(time)) {
      throw new CoinbaseError(`Candle time is not whole seconds: ${JSON.stringify(time)}`);
    }
    if (time < from || time > until) {
      throw new CoinbaseError(`Candle at ${time} is outside the requested ${from} to ${until}`);
    }
    const what = `${instrument.symbol} ${time}`;
    const bar: Bar = {
      time: barTime(time),
      open: price(scaled(open, rawPriceScale(instrument), `${what} open`)),
      high: price(scaled(high, rawPriceScale(instrument), `${what} high`)),
      low: price(scaled(low, rawPriceScale(instrument), `${what} low`)),
      close: price(scaled(close, rawPriceScale(instrument), `${what} close`)),
      volume: volume(scaled(vol, rawVolumeScale(instrument), `${what} volume`)),
    };
    assertCoherent(bar);
    bars.push(bar);
  }
  bars.sort((a, b) => a.time - b.time);
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1];
    const current = bars[i];
    if (previous !== undefined && current !== undefined && current.time === previous.time) {
      throw new CoinbaseError(`Duplicate candle at ${current.time}`);
    }
  }
  return bars;
}

export interface CoinbaseCandlesOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  /** Injected so tests do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Minimum gap between requests. Coinbase's public limit is about 10 per
   * second per IP; 200ms keeps us well under it.
   */
  readonly minIntervalMs?: number;
  readonly maxAttempts?: number;
}

function iso(time: BarTime): string {
  return new Date(time * 1000).toISOString().replace('.000Z', 'Z');
}

export class CoinbaseCandles implements HistoryProviderPort {
  readonly name = 'coinbase';
  private readonly baseUrl: string;
  private readonly http: PacedJson;

  constructor(options: CoinbaseCandlesOptions = {}) {
    this.baseUrl = options.baseUrl ?? COINBASE_BASE_URL;
    this.http = new PacedJson({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      minIntervalMs: options.minIntervalMs ?? 200,
      fail,
    });
  }

  /**
   * Pages of 300 minutes cover the day: four full ones and a last one of 240,
   * since 1,440 is not a multiple of 300. Any page failing fails the day.
   */
  async fetchDay(instrument: Instrument, date: string): Promise<Bar[]> {
    const product = coinbaseProduct(instrument.symbol);
    const start = dayStart(date);
    const lastMinute = start + (DAY_MINUTES - 1) * MINUTE;
    const bars: Bar[] = [];
    for (let offset = 0; offset < DAY_MINUTES; offset += PAGE_MINUTES) {
      const from = barTime(start + offset * MINUTE);
      const until = barTime(Math.min(from + (PAGE_MINUTES - 1) * MINUTE, lastMinute));
      const body = await this.get(product, from, until);
      bars.push(...parseCandles(instrument, body, from, until));
    }
    return bars;
  }

  private get(product: string, from: BarTime, until: BarTime): Promise<unknown> {
    const url =
      `${this.baseUrl}/products/${product}/candles?granularity=60` +
      `&start=${iso(from)}&end=${iso(until)}`;
    return this.http.get(url, {
      Accept: 'application/json',
      'User-Agent': 'agentic-investanswers-backfill',
    });
  }
}
