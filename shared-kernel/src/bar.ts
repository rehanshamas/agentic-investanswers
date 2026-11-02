// Bar: open, high, low, close and volume for one instrument over one timeframe
// period, stamped with its open time in UTC (docs/glossary.md). Never "candle".
//
// Prices and volume are scaled whole numbers so parity stays exact; see
// `scaled.ts` for why.

import type { BarTime } from './bar-time.js';
import type { Price, Volume } from './scaled.js';

export class BarError extends Error {}

export interface Bar {
  /** The bar's open time, UTC. */
  readonly time: BarTime;
  readonly open: Price;
  readonly high: Price;
  readonly low: Price;
  readonly close: Price;
  readonly volume: Volume;
}

/**
 * Check a bar is internally consistent.
 *
 * Catches the classic rollup bug of taking the high from one source and the
 * close from another: the high must be the highest of the four prices and the
 * low the lowest, or the bar did not come from real 1-minute bars.
 */
export function assertCoherent(bar: Bar): void {
  const { open, high, low, close } = bar;
  if (high < low) throw new BarError(`Bar at ${bar.time}: high ${high} is below low ${low}`);
  if (open > high || close > high) {
    throw new BarError(`Bar at ${bar.time}: high ${high} is not the highest price`);
  }
  if (open < low || close < low) {
    throw new BarError(`Bar at ${bar.time}: low ${low} is not the lowest price`);
  }
}
