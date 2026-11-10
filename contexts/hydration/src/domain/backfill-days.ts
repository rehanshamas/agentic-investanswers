// Which UTC days a backfill should fetch.
// Pure: imports only @aia/shared-kernel, and `now` is an argument.
//
// Raw is write-once per day (docs/architecture.md), so a day stored before it
// has finished could never be completed. A backfill therefore only plans days
// that ended at least `settleSeconds` ago, giving the provider time to finish
// the day's last minutes. Today belongs to the live stream (M1-05).

import type { BarTime } from '@aia/shared-kernel';
import { addDays, parseDateKey, zonedDateKey } from '@aia/shared-kernel';

export class BackfillDaysError extends Error {}

/** Default wait after a day ends before it is treated as complete. */
export const DEFAULT_SETTLE_SECONDS = 60 * 60;

/** The latest UTC day that ended at least `settleSeconds` before `now`. */
export function lastCompleteDay(now: BarTime, settleSeconds: number = DEFAULT_SETTLE_SECONDS): string {
  // A day is complete once its end, the next day's 00:00, is `settle` behind
  // us. So the day containing `now - settle` is still open; the one before it
  // is the latest complete one.
  return addDays(zonedDateKey(now - settleSeconds, 'UTC'), -1);
}

function assertDateKey(date: string, what: string): void {
  try {
    parseDateKey(date);
  } catch {
    throw new BackfillDaysError(`${what} must be a UTC date as YYYY-MM-DD, got ${JSON.stringify(date)}`);
  }
}

/**
 * Every UTC day from `from` to `until` inclusive, stopping at the last
 * complete day whatever `until` says. Empty when nothing is complete yet.
 */
export function backfillDays(
  from: string,
  until: string | undefined,
  now: BarTime,
  settleSeconds: number = DEFAULT_SETTLE_SECONDS,
): string[] {
  assertDateKey(from, 'from');
  if (until !== undefined) assertDateKey(until, 'until');
  const complete = lastCompleteDay(now, settleSeconds);
  const end = until !== undefined && until < complete ? until : complete;

  const days: string[] = [];
  for (let date = from; date <= end; date = addDays(date, 1)) days.push(date);
  return days;
}
