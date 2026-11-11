// The recent-bars window: the newest bars of one instrument and timeframe, as
// the cache holds them (M2-02). Pure: imports only @aia/shared-kernel.
//
// A window is `{ from, bars }` and means "these are *every* stored bar from
// `from` onwards". That promise is what makes a cache read trustworthy: a
// missing minute inside the window is a minute with no trades, not a minute
// the cache never heard of. Every rule here keeps the promise:
// - a window is only created whole, from the store (`fillWindow`);
// - an update replaces or appends one bar (`applyToWindow`), and an update
//   for a bar older than `from` is ignored, since the window does not cover it;
// - trimming to capacity moves `from` up to the oldest bar kept.
//
// The Redis adapter runs the same rules in a Lua script; both are tested
// against the same cases.

import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

export class RecentWindowError extends Error {}

/** Bars kept per instrument and timeframe. About 4 MB for 4 instruments x 8 timeframes. */
export const RECENT_BARS_CAPACITY = 2_000;

export interface RecentWindow {
  /** The window holds every stored bar with `time >= from`. */
  readonly from: BarTime;
  /** Ascending by time, at most the capacity. */
  readonly bars: readonly Bar[];
}

function assertCapacity(capacity: number): void {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new RecentWindowError(`capacity must be a positive whole number, got ${capacity}`);
  }
}

/** Keep the newest `capacity` bars; if any were dropped, the window starts at the oldest one kept. */
function trim(from: BarTime, bars: readonly Bar[], capacity: number): RecentWindow {
  if (bars.length <= capacity) return { from, bars };
  const kept = bars.slice(bars.length - capacity);
  return { from: (kept[0] as Bar).time, bars: kept };
}

/**
 * A window built from what the store holds from `from` onwards.
 * `bars` must be ascending and all at or after `from`.
 */
export function fillWindow(from: BarTime, bars: readonly Bar[], capacity: number): RecentWindow {
  assertCapacity(capacity);
  let previous: BarTime | undefined;
  for (const bar of bars) {
    if (bar.time < from) throw new RecentWindowError(`bar ${bar.time} is before the window start ${from}`);
    if (previous !== undefined && bar.time <= previous) {
      throw new RecentWindowError(`bars must be strictly ascending: ${bar.time} follows ${previous}`);
    }
    previous = bar.time;
  }
  return trim(from, bars, capacity);
}

/**
 * The window after the store's value of `bar` changed: the bar replaces the
 * one with the same time, or is inserted in order. A bar older than the
 * window is ignored. Usually the bar is the newest (a closed minute, or the
 * forming 5m bar it extended); a late minute can correct an older one.
 */
export function applyToWindow(window: RecentWindow, bar: Bar, capacity: number): RecentWindow {
  assertCapacity(capacity);
  if (bar.time < window.from) return window;
  const bars = window.bars.filter((b) => b.time !== bar.time);
  let at = bars.length;
  while (at > 0 && (bars[at - 1] as Bar).time > bar.time) at--;
  bars.splice(at, 0, bar);
  return trim(window.from, bars, capacity);
}

/**
 * How far back a store read for `limit` bars before `until` looks: `limit`
 * timeframe lengths. Calendar timeframes use their longest length (a 31-day
 * month), so the lookback never falls short for crypto. An instrument with
 * market sessions can have fewer than `limit` bars in it; the caller pages on.
 */
export function lookbackStart(timeframe: Timeframe, until: BarTime, limit: number): BarTime {
  const span = timeframeSeconds(timeframe) ?? CALENDAR_SPAN[timeframe] ?? 0;
  return barTime(Math.max(until - limit * span + 1, MIN_LOOKBACK));
}

const DAY = 86_400;
const CALENDAR_SPAN: Partial<Record<Timeframe, number>> = { '1D': DAY, '1W': 7 * DAY, '1M': 31 * DAY };
// barTime's own lower bound, 1990-01-01.
const MIN_LOOKBACK = 631_152_000;

/**
 * The newest `limit` bars before `before` (exclusive; `undefined` means the
 * newest) if the window can answer, otherwise `undefined`.
 *
 * It can answer when it holds at least `limit` such bars, or when it starts at
 * or before `lookback`, the start of the range a store read would cover, so
 * the store could not give more.
 */
export function readWindow(
  window: RecentWindow,
  limit: number,
  before: BarTime | undefined,
  lookback: BarTime,
): Bar[] | undefined {
  const candidates = before === undefined ? window.bars : window.bars.filter((b) => b.time < before);
  if (candidates.length >= limit) return candidates.slice(candidates.length - limit);
  if (window.from <= lookback) return [...candidates];
  return undefined;
}
