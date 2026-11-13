// Where an indicator's run starts. Pure. Task M3-04.
//
// Indicators such as ATR carry history forward, so their values depend on the
// first bar they were run from. If the start simply trailed the newest bar by
// a fixed count, a run rebuilt after a cache miss would start later than the
// cached one and draw slightly different values. Instead the start is pinned
// to a grid: blocks of RUN_WINDOW_BARS bars' worth of time, counted from 1970.
// The run starts at the beginning of the block before the newest bar's block,
// so it covers between RUN_WINDOW_BARS and 2 × RUN_WINDOW_BARS bars (fewer
// where the market is closed), and every run within one block starts at the
// same bar and agrees exactly. When the newest bar crosses into the next block
// the start moves forward once, and the cache key changes with it.

import type { BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

/** Bars per block (Sham, 2026-11-13: "at most the last 5,000 bars", pinned to a grid as above). */
export const RUN_WINDOW_BARS = 5_000;

/** Nominal lengths for calendar timeframes; only used to size the grid. */
const CALENDAR_SECONDS: Partial<Record<Timeframe, number>> = {
  '1D': 86_400,
  '1W': 7 * 86_400,
  '1M': 31 * 86_400,
};

function nominalSeconds(timeframe: Timeframe): number {
  const seconds = timeframeSeconds(timeframe) ?? CALENDAR_SECONDS[timeframe];
  if (seconds === undefined) throw new Error(`No nominal length for timeframe ${timeframe}`);
  return seconds;
}

/**
 * The time the run starts from (bars at or after it are used), given the
 * newest closed bar. Before 1990 the grid would fall outside BarTime's range,
 * so it is clamped there, which for the 1W and 1M grids means "all history".
 */
export function runStart(timeframe: Timeframe, newest: BarTime, windowBars = RUN_WINDOW_BARS): BarTime {
  const block = windowBars * nominalSeconds(timeframe);
  const start = (Math.floor(newest / block) - 1) * block;
  return barTime(Math.max(start, 631_152_000)); // 1990-01-01
}
