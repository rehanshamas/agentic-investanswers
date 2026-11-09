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

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, timeframeSeconds } from '@aia/shared-kernel';

import type { BuildParityException } from './build-parity-exceptions.js';
import type { BarField, ParityComparison } from './parity.js';
import { BAR_FIELDS, compareBars } from './parity.js';
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

const DAY = 24 * 60 * 60;

/**
 * How long a bar must have been closed before a difference on it fails:
 * 14 days (Sham, 2026-11-09, M1-14). Measured on the exports: every
 * disagreement between TradingView's own timeframes but two fell in the last
 * 10 days before each export ended. Those bars were built from TradingView's
 * live feed, and its timeframes had not yet been reconciled with each other.
 *
 * Recent bars are still compared, and count when they match. Only a recent
 * bar that differs is excused and counted (`recentDiffers`). They are not
 * skipped, because a 1m export reaches back about 7 days at most (the
 * 10,000-bar cap), so skipping would leave 5m with nothing to check. Bars
 * older than this must be exact.
 */
export const SETTLE_SECONDS = 14 * DAY;

/** Upper bound on a bar's length; calendar bars use their longest case. */
function barLength(timeframe: Timeframe): number {
  const fixed = timeframeSeconds(timeframe);
  if (fixed !== undefined) return fixed;
  if (timeframe === '1W') return 7 * DAY;
  if (timeframe === '1M') return 31 * DAY;
  return DAY;
}

export interface BuildParityOptions {
  readonly calendar?: MarketCalendar;
  /** Approved exception bars for this instrument and timeframe. */
  readonly exceptions?: readonly BuildParityException[];
  readonly settleSeconds?: number;
}

function sameFields(a: readonly BarField[], b: readonly BarField[]): boolean {
  return a.length === b.length && a.every((field) => b.includes(field));
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
 *   are counted in `window.skipped`;
 * - a bar that closed less than `settleSeconds` before the newest bar of
 *   either export and differs is excused and counted in `recentDiffers`;
 * - listed exceptions that still differ on exactly their listed fields are
 *   set aside and counted in `excepted`; any other difference fails.
 * Inside that window it is strict: a missing or differing bar fails.
 */
export function buildParity(
  instrument: Instrument,
  target: Timeframe,
  source: readonly Bar[],
  exported: readonly Bar[],
  options: BuildParityOptions = {},
): ParityComparison {
  const { calendar, exceptions = [], settleSeconds = SETTLE_SECONDS } = options;
  const sourceFirst = source[0];
  const sourceLast = source[source.length - 1];
  const exportedLast = exported[exported.length - 1];
  if (sourceFirst === undefined || sourceLast === undefined || exportedLast === undefined) {
    return noOverlap();
  }

  let rolled = rollUp(instrument, target, source, calendar);
  const firstRolled = rolled[0];
  if (firstRolled !== undefined && sourceFirst.time > firstRolled.time) rolled = rolled.slice(1);
  const lastBucket = alignToTimeframe(instrument, target, sourceLast.time, calendar);
  if (lastBucket !== undefined) rolled = rolled.filter((bar) => bar.time < lastBucket);

  const newest = Math.max(sourceLast.time, exportedLast.time);
  const settled = (time: BarTime): boolean => time + barLength(target) <= newest - settleSeconds;

  const from = rolled[0]?.time;
  const until = rolled[rolled.length - 1]?.time;
  if (from === undefined || until === undefined) return noOverlap();

  // Trim the export to what we rebuilt, so `compareBars` sees our history
  // starting where theirs does and applies no further skip of its own.
  let theirs = exported.filter((bar) => bar.time >= from && bar.time <= until);
  const theirLast = theirs[theirs.length - 1];
  if (theirLast === undefined) return noOverlap();
  // Bars we rebuilt beyond the export's end are not compared: the finer
  // export may simply run later than the coarser one.
  rolled = rolled.filter((bar) => bar.time <= theirLast.time);

  // Set aside exception bars that still differ exactly as listed.
  let excepted = 0;
  const staleExceptions: BarTime[] = [];
  const setAside = new Set<BarTime>();
  for (const exception of exceptions) {
    if (exception.time < from || exception.time > until) continue;
    const t = theirs.find((bar) => bar.time === exception.time);
    const o = rolled.find((bar) => bar.time === exception.time);
    const fields =
      t === undefined || o === undefined ? [] : BAR_FIELDS.filter((field) => t[field] !== o[field]);
    if (fields.length > 0 && sameFields(fields, exception.fields)) {
      excepted++;
      setAside.add(exception.time);
    } else {
      staleExceptions.push(exception.time);
    }
  }

  // Excuse recent bars that differ (or exist on one side only); recent bars
  // that match stay in and count.
  let recentDiffers = 0;
  const ours = new Map(rolled.map((bar) => [bar.time, bar]));
  const exportedAt = new Map(theirs.map((bar) => [bar.time, bar]));
  for (const time of new Set([...ours.keys(), ...exportedAt.keys()])) {
    if (settled(time) || setAside.has(time)) continue;
    const t = exportedAt.get(time);
    const o = ours.get(time);
    const equal = t !== undefined && o !== undefined && BAR_FIELDS.every((field) => t[field] === o[field]);
    if (!equal) {
      recentDiffers++;
      setAside.add(time);
    }
  }
  if (setAside.size > 0) {
    theirs = theirs.filter((bar) => !setAside.has(bar.time));
    rolled = rolled.filter((bar) => !setAside.has(bar.time));
  }

  const comparison = compareBars(theirs, rolled);
  const skipped = exported.filter((bar) => bar.time < from).length;
  return {
    ...comparison,
    status: comparison.status === 'exact' && excepted > 0 ? 'excepted' : comparison.status,
    // The span compared, including bars set aside within it.
    window:
      comparison.window === undefined
        ? undefined
        : { from: comparison.window.from, until: theirLast.time, skipped },
    recentDiffers,
    excepted,
    staleExceptions,
  };
}
