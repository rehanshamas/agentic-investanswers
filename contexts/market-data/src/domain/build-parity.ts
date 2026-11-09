// Build parity: TradingView's own bars, rolled up by our code, must equal
// TradingView's higher-timeframe export. Exact, with no tolerance.
// Pure: imports only @aia/shared-kernel and this context's domain.
//
// Why this is the check that blocks (Sham, 2026-11-09, M1-14): comparing our
// provider's bars with the exports mixes two questions, "is our data the same
// as TradingView's?" and "do we build bars the way TradingView does?". The
// first cannot be exact — TradingView's record misses trades, so its volume
// differs from the venue's own candles by up to a few percent an hour. The
// second can, and it is what the bar rules are about. Feeding TradingView's
// own finer bars through our rollups isolates it: any difference left is ours.

import type { Bar, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

import type { ParityComparison } from './parity.js';
import { compareBars } from './parity.js';
import { rollUp } from './roll-up.js';

/**
 * Which export each timeframe is rebuilt from: the next finer one, chosen
 * for overlap rather than depth, since an export's history shrinks as the
 * timeframe gets finer. None of these sources has a bar straddling a target
 * bar, including stock 4h (09:30/13:30) from session-aligned 1h.
 */
export const BUILD_SOURCES: Readonly<Partial<Record<Timeframe, Timeframe>>> = {
  '5m': '1m',
  '15m': '5m',
  '1h': '15m',
  '4h': '1h',
  '1D': '1h',
  '1W': '1D',
  '1M': '1D',
};

/** The export a timeframe is rebuilt from, or `undefined` for 1m. */
export function buildSource(target: Timeframe): Timeframe | undefined {
  return BUILD_SOURCES[target];
}

function noOverlap(): ParityComparison {
  return {
    status: 'no-overlap',
    window: undefined,
    matched: 0,
    differing: 0,
    missing: 0,
    extra: 0,
    first: undefined,
    fieldDiffers: { open: 0, high: 0, low: 0, close: 0, volume: 0 },
    maxVolumeDeviation: 0,
  };
}

/**
 * Roll `source` up to `target` and compare it with the `exported` target bars.
 *
 * Only target bars the source covers completely are compared:
 * - the first rolled bar is dropped when the source starts after its open,
 *   since the minutes before the source began are not in it;
 * - the rolled bar holding the source's last bar is dropped, since the
 *   source may stop partway through it (its own forming bar is already gone);
 * - export bars outside what is left are not compared, and those before it
 *   are counted in `window.skipped`.
 * Inside that window it is strict: a missing or differing bar fails.
 */
export function buildParity(
  instrument: Instrument,
  target: Timeframe,
  source: readonly Bar[],
  exported: readonly Bar[],
  calendar?: MarketCalendar,
): ParityComparison {
  const sourceFirst = source[0];
  const sourceLast = source[source.length - 1];
  if (sourceFirst === undefined || sourceLast === undefined) return noOverlap();

  let rolled = rollUp(instrument, target, source, calendar);
  const firstRolled = rolled[0];
  if (firstRolled !== undefined && sourceFirst.time > firstRolled.time) rolled = rolled.slice(1);
  const lastBucket = alignToTimeframe(instrument, target, sourceLast.time, calendar);
  if (lastBucket !== undefined) rolled = rolled.filter((bar) => bar.time < lastBucket);

  const from = rolled[0]?.time;
  const until = rolled[rolled.length - 1]?.time;
  if (from === undefined || until === undefined) return noOverlap();

  // Trim the export to what we rebuilt, so `compareBars` sees our history
  // starting where theirs does and applies no further skip of its own.
  const theirs = exported.filter((bar) => bar.time >= from && bar.time <= until);
  if (theirs.length === 0) return noOverlap();
  const comparison = compareBars(theirs, rolled);
  const skipped = exported.filter((bar) => bar.time < from).length;
  return {
    ...comparison,
    window: comparison.window === undefined ? undefined : { ...comparison.window, skipped },
  };
}
