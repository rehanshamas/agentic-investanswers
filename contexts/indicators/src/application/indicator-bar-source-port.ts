// The port the engine reads closed bars through (M3-04).
//
// The engine never touches storage or the cache layer directly. The app wires
// this to the data-access interface (M1-16; until then, market-data's
// RecentBars and cooked reader). Bars are our own type, oldest first, closed
// bars only; the forming bar comes separately with each request.

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';

export interface ClosedBarsQuery {
  /** Bars at or after this time, oldest first. Without it: the newest `limit` bars. */
  readonly from?: BarTime;
  readonly limit: number;
}

export interface IndicatorBarSourcePort {
  closedBars(instrument: Instrument, timeframe: Timeframe, query: ClosedBarsQuery): Promise<readonly Bar[]>;
}
