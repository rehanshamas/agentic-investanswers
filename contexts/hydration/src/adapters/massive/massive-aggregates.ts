// 1-minute stock history from Massive's aggregates API (Massive was Polygon.io).
//
// What the current plan allows, measured 2026-11-10 (M1-07):
// - history back to a rolling 2 years; older ranges answer 403
// - about 5 requests a minute; more answer 429
// - no WebSocket, so live minutes are M1-07b, not here
//
// The API:
//   GET /v2/aggs/ticker/NVDA/range/1/minute/{fromMs}/{toMs}?adjusted=false&sort=asc&limit=50000
//   - results: [{ t (minute open, epoch ms), o, h, l, c, v, vw, n }]
//   - pre-market and after-hours included; the session filter belongs to cooking
//   - prices to as many as 6 places (sub-penny prints) and volumes to 6
//     (fractional shares)
//   - the newest day may still change (late corrections), so stocks wait
//     2 days before being stored (Sham, M1-07)
//   - `next_url` when more results remain
//
// Decided by Sham for raw (M1-07): prices and volumes are kept at the
// precision Massive sends (`rawPriceScale`, `rawVolumeScale`), and bars are
// stored as traded (`adjusted=false`), so a later split never makes raw
// stale; cooking applies splits.

import type { Bar, Instrument } from '@aia/shared-kernel';
import {
  assertCoherent,
  barTime,
  price,
  rawPriceScale,
  rawVolumeScale,
  volume,
  zonedDateKey,
} from '@aia/shared-kernel';

import type { HistoryProviderPort } from '../../application/history-provider-port.js';
import { dayEnd, dayStart } from '../../domain/raw-day.js';
import { PacedJson } from '../paced-json.js';
import { scaledNumber } from '../provider-numbers.js';

export class MassiveError extends Error {}

export const MASSIVE_BASE_URL = 'https://api.massive.com';

const fail = (message: string): Error => new MassiveError(message);

/**
 * UTC days per request. A stock day is at most 960 minutes (04:00 to 20:00
 * New York), so 40 days stay under the 50,000-result page; paging covers
 * anything beyond.
 */
export const MASSIVE_DAYS_PER_REQUEST = 40;

interface Aggregate {
  readonly t: unknown;
  readonly o: unknown;
  readonly h: unknown;
  readonly l: unknown;
  readonly c: unknown;
  readonly v: unknown;
}

/**
 * Parse a page's results into bars grouped by UTC day, keeping only the
 * requested dates. Throws on anything raw should not hold.
 */
export function parseAggregates(
  instrument: Instrument,
  body: unknown,
  dates: ReadonlySet<string>,
): { bars: Map<string, Bar[]>; nextUrl: string | undefined } {
  if (typeof body !== 'object' || body === null) {
    throw new MassiveError(`Expected an object, got ${JSON.stringify(body).slice(0, 200)}`);
  }
  const { status, results, next_url: nextUrl } = body as {
    status?: unknown;
    results?: unknown;
    next_url?: unknown;
  };
  if (status !== 'OK' && status !== 'DELAYED') {
    throw new MassiveError(`Unexpected status ${JSON.stringify(status)}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const rows = results === undefined ? [] : results;
  if (!Array.isArray(rows)) throw new MassiveError(`results is not an array`);

  const priceScale = rawPriceScale(instrument);
  const volumeScale = rawVolumeScale(instrument);
  const bars = new Map<string, Bar[]>();
  for (const row of rows as Aggregate[]) {
    if (typeof row.t !== 'number' || !Number.isInteger(row.t) || row.t % 60_000 !== 0) {
      throw new MassiveError(`Aggregate time is not a whole minute in ms: ${JSON.stringify(row.t)}`);
    }
    const time = barTime(row.t / 1000);
    const date = zonedDateKey(time, 'UTC');
    if (!dates.has(date)) continue;
    const what = `${instrument.symbol} ${row.t}`;
    const bar: Bar = {
      time,
      open: price(scaledNumber(row.o, priceScale, `${what} open`, fail)),
      high: price(scaledNumber(row.h, priceScale, `${what} high`, fail)),
      low: price(scaledNumber(row.l, priceScale, `${what} low`, fail)),
      close: price(scaledNumber(row.c, priceScale, `${what} close`, fail)),
      volume: volume(scaledNumber(row.v, volumeScale, `${what} volume`, fail)),
    };
    assertCoherent(bar);
    const day = bars.get(date);
    if (day === undefined) bars.set(date, [bar]);
    else day.push(bar);
  }
  return { bars, nextUrl: typeof nextUrl === 'string' && nextUrl !== '' ? nextUrl : undefined };
}

export interface MassiveAggregatesOptions {
  /** The API key. Sent only in the Authorization header, never in a URL or error. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** 13 s keeps a plan of 5 requests a minute from ever being refused. */
  readonly minIntervalMs?: number;
  readonly maxAttempts?: number;
}

export class MassiveAggregates implements HistoryProviderPort {
  readonly name = 'massive';
  readonly daysPerRequest = MASSIVE_DAYS_PER_REQUEST;
  private readonly baseUrl: string;
  private readonly http: PacedJson;
  private readonly headers: Record<string, string>;

  constructor(options: MassiveAggregatesOptions) {
    if (options.apiKey === '') throw new MassiveError('No Massive API key');
    this.baseUrl = options.baseUrl ?? MASSIVE_BASE_URL;
    this.headers = { Accept: 'application/json', Authorization: `Bearer ${options.apiKey}` };
    this.http = new PacedJson({
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      minIntervalMs: options.minIntervalMs ?? 13_000,
      // Without Retry-After, wait a full rate window before trying again.
      backoffBaseMs: 15_000,
      backoffCapMs: 65_000,
      fail,
    });
  }

  async fetchDay(instrument: Instrument, date: string): Promise<Bar[]> {
    return (await this.fetchDays(instrument, [date])).get(date) ?? [];
  }

  /** Every requested UTC day, from one request plus any pages it needs. */
  async fetchDays(instrument: Instrument, dates: readonly string[]): Promise<Map<string, Bar[]>> {
    const sorted = [...dates].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const result = new Map<string, Bar[]>(sorted.map((date) => [date, []]));
    if (first === undefined || last === undefined) return result;

    const fromMs = dayStart(first) * 1000;
    const toMs = (dayEnd(last) - 60) * 1000;
    const ticker = encodeURIComponent(instrument.symbol);
    let url: string | undefined =
      `${this.baseUrl}/v2/aggs/ticker/${ticker}/range/1/minute/${fromMs}/${toMs}` +
      '?adjusted=false&sort=asc&limit=50000';
    const wanted = new Set(sorted);
    let page = 0;
    while (url !== undefined) {
      page++;
      const label = `Massive ${instrument.symbol} ${first}..${last} page ${page}`;
      const parsed = parseAggregates(instrument, await this.http.get(url, this.headers, label), wanted);
      for (const [date, bars] of parsed.bars) result.get(date)?.push(...bars);
      url = parsed.nextUrl;
    }

    for (const [date, bars] of result) {
      bars.sort((a, b) => a.time - b.time);
      for (let i = 1; i < bars.length; i++) {
        if (bars[i]?.time === bars[i - 1]?.time) {
          throw new MassiveError(`Duplicate aggregate at ${bars[i]?.time} on ${date}`);
        }
      }
    }
    return result;
  }
}
