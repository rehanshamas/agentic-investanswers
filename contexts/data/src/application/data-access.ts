// The data layer's one front door (M1-16; decision record T-05).
//
// Everything outside the data layer gets bars through this interface and
// nothing else: never the raw or cooked stores, the cache, the bus or provider
// code. Bars are our own types in our scaled units; formatting them for
// clients is the serving layer's job.
//
// Today it runs in process (InProcessDataLayer). Running the data layer as its
// own service later means one new adapter of this interface (for example over
// HTTP, with live updates on the existing bus), proved by the same contract
// tests (data-access.contract.ts); no caller changes.

import type { LiveBarsListener } from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';

export interface BarsPage {
  /** Ascending; `limit` bars unless history ran out or the look-back stopped. */
  readonly bars: readonly Bar[];
  /** The `before` for the next older page, or `null` once history is exhausted. */
  readonly next: BarTime | null;
}

export interface PageQuery {
  readonly limit: number;
  /** Only bars opening before this time; omitted for the newest bars. */
  readonly before?: BarTime;
  /** The current time, passed in. */
  readonly now: BarTime;
}

export interface DataAccess {
  /** The instruments the data layer holds. */
  readonly instruments: readonly Instrument[];
  /** Why bars of this instrument and timeframe are not served, or `undefined` if they are. */
  whyNotServed(instrument: Instrument, timeframe: Timeframe): string | undefined;
  /** One page of history, newest first: cache first, then the stores, never past where history starts. */
  page(instrument: Instrument, timeframe: Timeframe, query: PageQuery): Promise<BarsPage>;
  /** Every bar in `[from, until]`, ascending (indicators, backtests, agents). */
  bars(instrument: Instrument, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]>;
  /** Live bar updates, in order; `lost` when some may have been missed. */
  subscribe(listener: LiveBarsListener): Promise<void>;
  close(): Promise<void>;
}
