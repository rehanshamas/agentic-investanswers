// Market session: the hours an instrument trades (docs/glossary.md).
// Stocks have sessions; crypto trades 24/7 and has none.
//
// Every function takes the instant or date in as an argument. Nothing here
// reads the clock.

import type { BarTime } from './bar-time.js';
import { barTime } from './bar-time.js';
import type { MarketCalendar } from './calendar.js';
import { closeTimeOn, isTradingDay } from './calendar.js';
import type { Instrument } from './instrument.js';
import { hasSessions } from './instrument.js';
import { epochSecondsFromZonedParts, zonedDateKey } from './time-zone.js';
import { parseDateKey } from './time-zone.js';

export class SessionError extends Error {}

export interface Session {
  /** The session's own date in the exchange's zone, `YYYY-MM-DD`. */
  readonly date: string;
  /** First instant of the session. */
  readonly open: BarTime;
  /** First instant *after* the session: a bar never includes this second. */
  readonly close: BarTime;
}

function wallClockToBarTime(
  key: string,
  time: { hour: number; minute: number },
  timeZone: string,
): BarTime {
  const { year, month, day } = parseDateKey(key);
  return barTime(
    epochSecondsFromZonedParts(
      { year, month, day, hour: time.hour, minute: time.minute, second: 0 },
      timeZone,
    ),
  );
}

/**
 * The session on a given exchange date, or `undefined` when that date has none
 * (a weekend or a holiday).
 *
 * Regular hours only: pre-market and after-hours minutes are not part of any
 * bar (docs/bar-rules.md, "Stocks").
 */
export function sessionOn(
  instrument: Instrument,
  calendar: MarketCalendar,
  date: string,
): Session | undefined {
  if (!hasSessions(instrument)) {
    throw new SessionError(`${instrument.symbol} trades 24/7 and has no sessions`);
  }
  if (!isTradingDay(calendar, date)) return undefined;
  return {
    date,
    open: wallClockToBarTime(date, calendar.regularOpen, calendar.timeZone),
    close: wallClockToBarTime(date, closeTimeOn(calendar, date), calendar.timeZone),
  };
}

/**
 * The session containing an instant, or `undefined` when the instant falls
 * outside every session — a weekend, a holiday, or outside regular hours.
 *
 * Checks the previous exchange date too: a session that opens at 09:30 New
 * York can start on the previous UTC date is not possible, but the instant's
 * UTC date can run ahead of the exchange date late in the evening, so the
 * exchange-local date is what we key on.
 */
export function sessionContaining(
  instrument: Instrument,
  calendar: MarketCalendar,
  instant: BarTime,
): Session | undefined {
  const date = zonedDateKey(instant, calendar.timeZone);
  const session = sessionOn(instrument, calendar, date);
  if (session === undefined) return undefined;
  if (instant < session.open || instant >= session.close) return undefined;
  return session;
}

/** Length of a session in whole minutes. 390 for a regular day, 210 for a half day. */
export function sessionMinutes(session: Session): number {
  return (session.close - session.open) / 60;
}
