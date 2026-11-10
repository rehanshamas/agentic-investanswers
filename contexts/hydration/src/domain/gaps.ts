// Which minutes a raw day should hold, per market hours, and which are missing.
// Pure: imports only @aia/shared-kernel and this context's domain.
//
// docs/bar-rules.md: "a minute with no trades has no bar", and "a gap is a
// minute for which the provider's history has a bar but our raw store
// doesn't". So a missing minute found here is only a suspect; the provider
// decides whether it is a gap (it has a bar) or simply had no trades.

import type { Bar, BarTime, Instrument, MarketCalendar } from '@aia/shared-kernel';
import { barTime, isTradingDay, sessionOn } from '@aia/shared-kernel';

import { dayEnd, dayStart } from './raw-day.js';

const MINUTE = 60;

/**
 * The span of a UTC day whose minutes should have bars, or `undefined` when
 * none should: every minute for crypto; for stocks, the regular session of
 * that New York date (shorter on half days, none on holidays and weekends).
 * Pre- and after-hours are never expected: a quiet extended-hours minute is
 * normal. A New York session always lies within one UTC day.
 */
export function expectedSpan(
  instrument: Instrument,
  date: string,
  calendar: MarketCalendar,
): { from: BarTime; until: BarTime } | undefined {
  if (instrument.kind === 'crypto') return { from: dayStart(date), until: dayEnd(date) };
  if (!isTradingDay(calendar, date)) return undefined;
  const session = sessionOn(instrument, calendar, date);
  return session === undefined ? undefined : { from: session.open, until: session.close };
}

/** Minutes in `[from, until)` with no bar, ascending. */
export function findHoles(
  bars: readonly Bar[],
  span: { from: BarTime; until: BarTime },
): BarTime[] {
  const have = new Set(bars.map((bar) => bar.time));
  const holes: BarTime[] = [];
  for (let t: number = span.from; t < span.until; t += MINUTE) {
    const time = barTime(t);
    if (!have.has(time)) holes.push(time);
  }
  return holes;
}

/** Group ascending minutes into runs of consecutive ones, for reporting. */
export function holeRuns(holes: readonly BarTime[]): Array<{ from: BarTime; minutes: number }> {
  const runs: Array<{ from: BarTime; minutes: number }> = [];
  for (const t of holes) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.from + last.minutes * MINUTE === t) last.minutes++;
    else runs.push({ from: t, minutes: 1 });
  }
  return runs;
}
