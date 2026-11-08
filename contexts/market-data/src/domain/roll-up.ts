// Build higher-timeframe bars from 1-minute bars.
// Pure: imports only @aia/shared-kernel, no I/O, no clock.
//
// The aggregation rules come from docs/bar-rules.md: open is the first
// 1-minute open, close the last 1-minute close, high the maximum of the highs,
// low the minimum of the lows, volume the sum. Prices are **copied, never
// computed**, which is why parity on OHLC can be exact; only volume is
// arithmetic, and it is summed in whole scaled units so it stays exact too.
//
// Which bucket a minute belongs to is entirely `alignToTimeframe` from the
// shared kernel. Nothing here re-derives alignment, so sessions, daylight
// saving, early closes and the 4h stub are already handled and already tested.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, assertCoherent, price, sumVolume, volume } from '@aia/shared-kernel';

export class RollUpError extends Error {}

/** A bucket under construction: the bars that belong to one output bar. */
interface Bucket {
  readonly time: BarTime;
  readonly minutes: Bar[];
}

function assertAscendingMinutes(bars: readonly Bar[]): void {
  let previous: BarTime | undefined;
  for (const bar of bars) {
    if (previous !== undefined && bar.time <= previous) {
      throw new RollUpError(
        `1-minute bars must be strictly ascending: ${bar.time} follows ${previous}`,
      );
    }
    previous = bar.time;
  }
}

/**
 * Group 1-minute bars by the bar of `timeframe` they belong to.
 *
 * Minutes that belong to no bar are dropped: for an instrument with sessions
 * that means pre-market, after-hours, weekend and holiday minutes, which
 * `docs/bar-rules.md` says are not part of any bar.
 */
function bucket(
  instrument: Instrument,
  timeframe: Timeframe,
  minutes: readonly Bar[],
  calendar: MarketCalendar | undefined,
): Bucket[] {
  const byTime = new Map<BarTime, Bar[]>();
  for (const minute of minutes) {
    const open = alignToTimeframe(instrument, timeframe, minute.time, calendar);
    if (open === undefined) continue;
    const existing = byTime.get(open);
    if (existing === undefined) byTime.set(open, [minute]);
    else existing.push(minute);
  }
  return [...byTime.entries()]
    .map(([time, bars]) => ({ time, minutes: bars }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Aggregate the minutes of one bucket into a single bar.
 *
 * A bucket may be partial — a 5m bar built from 3 minutes is still one bar,
 * because a minute with no trades has no bar and we never invent flat ones.
 */
function aggregate(time: BarTime, minutes: readonly Bar[]): Bar {
  const first = minutes[0];
  const last = minutes[minutes.length - 1];
  if (first === undefined || last === undefined) {
    throw new RollUpError(`Cannot aggregate an empty bucket at ${time}`);
  }

  let high = first.high;
  let low = first.low;
  for (const minute of minutes) {
    if (minute.high > high) high = minute.high;
    if (minute.low < low) low = minute.low;
  }

  const bar: Bar = {
    time,
    open: price(first.open),
    high: price(high),
    low: price(low),
    close: price(last.close),
    volume: sumVolume(minutes.map((m) => volume(m.volume))),
  };
  // Cheap guard against the classic rollup bug of mixing sources.
  assertCoherent(bar);
  return bar;
}

/**
 * Build every bar of `timeframe` that the given 1-minute bars support.
 *
 * Only whole buckets the caller actually passed minutes for are produced, so
 * rolling up a partial range yields partial edge bars. Callers that need a
 * bucket to be complete must pass every minute of it — which is what
 * `affectedBarTimes` plus a re-read of the source is for.
 */
export function rollUp(
  instrument: Instrument,
  timeframe: Timeframe,
  minutes: readonly Bar[],
  calendar?: MarketCalendar,
): Bar[] {
  assertAscendingMinutes(minutes);
  return bucket(instrument, timeframe, minutes, calendar).map((b) =>
    aggregate(b.time, b.minutes),
  );
}

/**
 * The open times of the bars that the given 1-minute bars fall into.
 *
 * This is what makes the update incremental: one new minute yields one bar
 * time per timeframe, so only that bar is rebuilt rather than the whole
 * partition. Minutes belonging to no bar contribute nothing.
 */
export function affectedBarTimes(
  instrument: Instrument,
  timeframe: Timeframe,
  minutes: readonly Bar[],
  calendar?: MarketCalendar,
): BarTime[] {
  const times = new Set<BarTime>();
  for (const minute of minutes) {
    const open = alignToTimeframe(instrument, timeframe, minute.time, calendar);
    if (open !== undefined) times.add(open);
  }
  return [...times].sort((a, b) => a - b);
}
