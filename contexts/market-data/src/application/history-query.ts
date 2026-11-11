// The History API's rules (M2-03), free of any HTTP framework: which
// parameters a request may carry, the cap, what is served, and the response
// in display units. The platform app maps the outcomes to HTTP statuses and
// runs the access check between `parse` and `run`.
//
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { BarTimeError, barTime, formatScaled, isTimeframe } from '@aia/shared-kernel';

import { whyNotServed } from '../domain/served.js';
import type { RecentBars } from './recent-bars.js';

/** Most bars one request may ask for. */
export const HISTORY_MAX_LIMIT = 1_000;
/** Bars per page when the request does not say. */
export const HISTORY_DEFAULT_LIMIT = 500;

const PARAMETERS = new Set(['instrument', 'tf', 'limit', 'before']);

export type HistoryErrorCode =
  | 'bad_parameter'
  | 'limit_too_large'
  | 'unknown_instrument'
  | 'timeframe_not_served';

export interface HistoryError {
  readonly code: HistoryErrorCode;
  readonly message: string;
}

export interface HistoryRequest {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly limit: number;
  readonly before?: BarTime;
}

/** One bar in display units: prices and volume as decimal numbers, time in UTC seconds. */
export interface HistoryBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface HistoryResponse {
  readonly instrument: string;
  readonly timeframe: Timeframe;
  readonly bars: HistoryBar[];
  /** Pass as `before` for the next older page; `null` once history is exhausted. */
  readonly next: number | null;
}

export interface HistoryQueryDeps {
  readonly recentBars: Pick<RecentBars, 'page'>;
  /** The instruments the platform knows. */
  readonly instruments: readonly Instrument[];
  /** Where an instrument's history starts. */
  readonly earliest: (symbol: string) => BarTime;
}

type Parsed = { readonly ok: true; readonly request: HistoryRequest } | { readonly ok: false; readonly error: HistoryError };

const fail = (code: HistoryErrorCode, message: string): Parsed => ({ ok: false, error: { code, message } });

export class HistoryQuery {
  constructor(private readonly deps: HistoryQueryDeps) {}

  /**
   * Check a request's query parameters. Values arrive as strings, or arrays
   * when a parameter is repeated, which is refused.
   */
  parse(query: Readonly<Record<string, unknown>>): Parsed {
    for (const name of Object.keys(query)) {
      if (!PARAMETERS.has(name)) return fail('bad_parameter', `unknown parameter "${name}"; allowed: instrument, tf, limit, before`);
      if (typeof query[name] !== 'string') return fail('bad_parameter', `"${name}" must be given once`);
    }
    const text = query as Readonly<Record<string, string | undefined>>;

    const symbol = text['instrument'];
    if (symbol === undefined || symbol === '') return fail('bad_parameter', '"instrument" is required, for example BTCUSD');
    const tf = text['tf'];
    if (tf === undefined || tf === '') return fail('bad_parameter', '"tf" is required: 1m, 5m, 15m, 1h, 4h, 1D, 1W or 1M');
    if (!isTimeframe(tf)) return fail('bad_parameter', `"tf" must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M; got "${tf}"`);

    let limit = HISTORY_DEFAULT_LIMIT;
    const limitText = text['limit'];
    if (limitText !== undefined) {
      if (!/^[1-9]\d{0,6}$/.test(limitText)) return fail('bad_parameter', `"limit" must be a whole number from 1; got "${limitText}"`);
      limit = Number(limitText);
      if (limit > HISTORY_MAX_LIMIT) {
        return fail('limit_too_large', `"limit" may be at most ${HISTORY_MAX_LIMIT}; got ${limit}. Page with "before" for more.`);
      }
    }

    let before: BarTime | undefined;
    const beforeText = text['before'];
    if (beforeText !== undefined) {
      const bad = fail('bad_parameter', `"before" must be a bar time in whole UTC seconds; got "${beforeText}"`);
      if (!/^\d{1,12}$/.test(beforeText)) return bad;
      try {
        before = barTime(Number(beforeText));
      } catch (error) {
        if (error instanceof BarTimeError) return bad;
        throw error;
      }
    }

    const instrument = this.deps.instruments.find((i) => i.symbol === symbol);
    if (instrument === undefined) {
      return fail('unknown_instrument', `unknown instrument "${symbol}"; known: ${this.deps.instruments.map((i) => i.symbol).join(', ')}`);
    }
    const notServed = whyNotServed(instrument, tf);
    if (notServed !== undefined) return fail('timeframe_not_served', notServed);

    return { ok: true, request: { instrument, timeframe: tf, limit, ...(before === undefined ? {} : { before }) } };
  }

  /** The page, cache first, in display units. */
  async run(request: HistoryRequest, now: BarTime): Promise<HistoryResponse> {
    const { instrument, timeframe, limit, before } = request;
    const page = await this.deps.recentBars.page(instrument, timeframe, {
      limit,
      now,
      earliest: this.deps.earliest(instrument.symbol),
      ...(before === undefined ? {} : { before }),
    });
    return {
      instrument: instrument.symbol,
      timeframe,
      bars: page.bars.map((bar) => displayBar(instrument, bar)),
      next: page.next,
    };
  }
}

/** Scaled whole numbers to decimals at the instrument's precision. */
function displayBar(instrument: Instrument, bar: Bar): HistoryBar {
  const p = (value: number) => Number(formatScaled(value, instrument.priceScale));
  return {
    time: bar.time,
    open: p(bar.open),
    high: p(bar.high),
    low: p(bar.low),
    close: p(bar.close),
    volume: Number(formatScaled(bar.volume, instrument.volumeScale)),
  };
}
