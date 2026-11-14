// The History API's rules (M2-03), free of any HTTP framework: which
// parameters a request may carry, the cap, and the response in display units.
// Bars and what is served come from the data layer (@aia/data, M1-16). The
// platform app maps the outcomes to HTTP statuses and runs the access check
// between `parse` and `run`.
//
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000

import type { HistoryError, HistoryErrorCode, HistoryResponse } from '@aia/client-contract';
import { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from '@aia/client-contract';
import type { DataAccess } from '@aia/data';
import type { BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { BarTimeError, barTime, isTimeframe } from '@aia/shared-kernel';

import { displayBar } from './display-bar.js';

const PARAMETERS = new Set(['instrument', 'tf', 'limit', 'before']);

export interface HistoryRequest {
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  readonly limit: number;
  readonly before?: BarTime;
}

export interface HistoryQueryDeps {
  readonly data: Pick<DataAccess, 'instruments' | 'whyNotServed' | 'page'>;
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

    const instrument = this.deps.data.instruments.find((i) => i.symbol === symbol);
    if (instrument === undefined) {
      return fail('unknown_instrument', `unknown instrument "${symbol}"; known: ${this.deps.data.instruments.map((i) => i.symbol).join(', ')}`);
    }
    const notServed = this.deps.data.whyNotServed(instrument, tf);
    if (notServed !== undefined) return fail('timeframe_not_served', notServed);

    return { ok: true, request: { instrument, timeframe: tf, limit, ...(before === undefined ? {} : { before }) } };
  }

  /** The page, cache first, in display units. */
  async run(request: HistoryRequest, now: BarTime): Promise<HistoryResponse> {
    const { instrument, timeframe, limit, before } = request;
    const page = await this.deps.data.page(instrument, timeframe, { limit, now, ...(before === undefined ? {} : { before }) });
    return {
      instrument: instrument.symbol,
      timeframe,
      bars: page.bars.map((bar) => displayBar(instrument, bar)),
      next: page.next,
    };
  }
}
