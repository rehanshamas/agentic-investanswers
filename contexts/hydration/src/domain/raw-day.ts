// Rules for what may be stored as one raw day. Pure: imports only
// @aia/shared-kernel, no I/O, no clock.
//
// Raw is provider data exactly as received, write-once, one file per provider,
// instrument and day (CLAUDE.md rule 3, docs/architecture.md). A raw day is a
// UTC calendar day for every instrument, including stocks: session dates are a
// cooked concern, and keeping raw keyed on UTC means the raw layout never
// depends on a market calendar that might later be corrected.

import type { Bar, BarTime } from '@aia/shared-kernel';
import { assertCoherent, barTimeFromUtcParts, parseDateKey } from '@aia/shared-kernel';

export class RawDayError extends Error {}

const DAY_SECONDS = 86_400;
const MINUTE = 60;

/** First instant of a UTC calendar day, `YYYY-MM-DD`. */
export function dayStart(date: string): BarTime {
  const { year, month, day } = parseDateKey(date);
  return barTimeFromUtcParts(year, month, day);
}

/** First instant *after* a UTC calendar day. */
export function dayEnd(date: string): BarTime {
  return (dayStart(date) + DAY_SECONDS) as BarTime;
}

/**
 * Check a batch of 1-minute bars may be stored as this raw day.
 *
 * Raw is write-once, so a bad batch cannot be repaired in place later: it would
 * have to be deleted, which the store refuses by design. That makes it worth
 * rejecting loudly here rather than storing something subtly wrong.
 *
 * A day may be partial — a stock day holds only session minutes, and a backfill
 * may stop mid-day — so gaps are allowed. What is not allowed is a bar outside
 * the day, an out-of-order or duplicated bar, a bar not on a whole minute, or a
 * bar whose own prices contradict each other.
 */
export function assertStorableRawDay(date: string, bars: readonly Bar[]): void {
  const from = dayStart(date);
  const until = dayEnd(date);

  let previous: BarTime | undefined;
  for (const bar of bars) {
    if (bar.time < from || bar.time >= until) {
      throw new RawDayError(
        `Bar at ${bar.time} does not belong to raw day ${date} (${from} to ${until})`,
      );
    }
    if ((bar.time - from) % MINUTE !== 0) {
      throw new RawDayError(`Bar at ${bar.time} is not on a whole minute`);
    }
    if (previous !== undefined && bar.time <= previous) {
      throw new RawDayError(
        `Raw bars must be strictly ascending: ${bar.time} follows ${previous} in day ${date}`,
      );
    }
    assertCoherent(bar);
    previous = bar.time;
  }
}
