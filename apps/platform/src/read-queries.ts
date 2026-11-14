// The reads the platform serves, shared by the REST routes and the MCP tools
// (M4-02), so an agent gets exactly what the API gives: the History API's
// parameters, cap and pages (@aia/serving), what is served (the data layer,
// @aia/data), and the plan check (@aia/access). No rules of its own.

import type { Access, Entitlements, Principal } from '@aia/access';
import type { DataAccess } from '@aia/data';
import type { HistoryErrorCode, HistoryQuery, HistoryResponse } from '@aia/serving';
import type { BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { TIMEFRAMES } from '@aia/shared-kernel';

export interface ReadError {
  readonly code: string;
  readonly message: string;
  readonly upgradeUrl?: string;
}

export type ReadOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly status: number; readonly error: ReadError };

export interface InstrumentListing {
  readonly symbol: string;
  readonly kind: Instrument['kind'];
  /** Timeframes with bars to serve now. */
  readonly timeframes: readonly Timeframe[];
  /** Of those, the ones the caller's plan includes. */
  readonly included: readonly Timeframe[];
}

export interface ReadQueriesDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly policy: Access['policy'];
  readonly now: () => BarTime;
  /** The instruments and what is served, for listings: the data layer's. */
  readonly catalog?: Pick<DataAccess, 'instruments' | 'whyNotServed'> | undefined;
}

const HISTORY_STATUS: Readonly<Record<HistoryErrorCode, number>> = {
  bad_parameter: 400,
  limit_too_large: 400,
  unknown_instrument: 404,
  timeframe_not_served: 409,
};

export class ReadQueries {
  constructor(private readonly deps: ReadQueriesDeps) {}

  /** GET /bars: parameters as the query string carries them. */
  async bars(principal: Principal, query: Readonly<Record<string, unknown>>): Promise<ReadOutcome<HistoryResponse>> {
    const parsed = this.deps.history.parse(query);
    if (!parsed.ok) return { ok: false, status: HISTORY_STATUS[parsed.error.code], error: parsed.error };
    const { instrument, timeframe } = parsed.request;
    if (!(await this.deps.policy.canReadBars(principal, instrument.symbol, timeframe))) {
      const { upgradeUrl } = await this.deps.policy.entitlements(principal);
      return {
        ok: false,
        status: 403,
        error: {
          code: 'forbidden',
          message: `your plan does not include ${instrument.symbol} ${timeframe}`,
          ...(upgradeUrl === undefined ? {} : { upgradeUrl }),
        },
      };
    }
    return { ok: true, value: await this.deps.history.run(parsed.request, this.deps.now()) };
  }

  /** GET /plan. */
  async plan(principal: Principal): Promise<ReadOutcome<Entitlements>> {
    return { ok: true, value: await this.deps.policy.entitlements(principal) };
  }

  /** Every instrument, the timeframes served for it, and which the caller's plan includes. */
  async instruments(principal: Principal): Promise<ReadOutcome<readonly InstrumentListing[]>> {
    const listings: InstrumentListing[] = [];
    const catalog = this.deps.catalog;
    for (const instrument of catalog?.instruments ?? []) {
      const timeframes = TIMEFRAMES.filter((tf) => catalog?.whyNotServed(instrument, tf) === undefined);
      const included: Timeframe[] = [];
      for (const tf of timeframes) if (await this.deps.policy.canReadBars(principal, instrument.symbol, tf)) included.push(tf);
      listings.push({ symbol: instrument.symbol, kind: instrument.kind, timeframes, included });
    }
    return { ok: true, value: listings };
  }
}
