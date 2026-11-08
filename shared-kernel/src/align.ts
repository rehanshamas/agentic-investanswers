// Which bar does an instant belong to?
//
// Every rule here comes from docs/bar-rules.md. Crypto is anchored to 00:00
// UTC; stocks are anchored to the session open, so a session's last bar is
// short and no bar ever spans two sessions.

import type { BarTime } from './bar-time.js';
import { barTime, barTimeFromUtcParts, floorToSeconds } from './bar-time.js';
import type { MarketCalendar } from './calendar.js';
import { firstTradingDayOfMonth, firstTradingDayOfWeek } from './calendar.js';
import type { Instrument } from './instrument.js';
import { hasSessions } from './instrument.js';
import { sessionContaining, sessionOn } from './session.js';
import type { Timeframe } from './timeframe.js';
import { timeframeKind, timeframeSeconds } from './timeframe.js';
import { zonedParts } from './time-zone.js';

export class AlignmentError extends Error {}

/** 1970-01-05, the first Monday of the epoch, in seconds. Crypto weeks are anchored here. */
const FIRST_MONDAY = 345_600;
const DAY = 86_400;
const WEEK = 604_800;

/**
 * How a stock's 1D, 1W and 1M bar is stamped: with its **session open**.
 *
 * Settled against the real exports (OI-04), which contradicted the guess this
 * function originally held. `nvda_1d.csv` carries 6,992 bars whose New York
 * time of day is **always 09:30**, appearing as either 13:30 or 14:30 UTC
 * purely because of daylight saving:
 *
 *     NVDA 1D  6992 rows  1999-01-22 -> 2026-11-06
 *       UTC time-of-day: [13:30, 14:30]   NY time-of-day: [09:30]
 *
 * So `docs/bar-rules.md`'s "every bar is stamped with its open time in UTC"
 * is the rule that holds, and its "stamped with that session's date" wording
 * was the loose one. A daily stock bar's open time really is its session open.
 *
 * The previous implementation returned midnight UTC of the session date, which
 * was wrong by 13.5 or 14.5 hours on every stock 1D, 1W and 1M bar.
 */
function stampForSessionDate(
  instrument: Instrument,
  calendar: MarketCalendar,
  date: string,
): BarTime {
  const session = sessionOn(instrument, calendar, date);
  if (session === undefined) {
    throw new AlignmentError(
      `${date} has no session, so no bar can be stamped with it. This should be unreachable: callers pass a trading day.`,
    );
  }
  return session.open;
}

function alignCrypto(timeframe: Timeframe, instant: BarTime): BarTime {
  const seconds = timeframeSeconds(timeframe);
  if (seconds !== undefined) {
    // 1m, 5m, 15m, 1h and 4h all divide a day, and the epoch is a midnight,
    // so flooring against the epoch lands on 00:00/04:00/... UTC.
    return floorToSeconds(instant, seconds);
  }
  switch (timeframeKind(timeframe)) {
    case 'daily':
      return floorToSeconds(instant, DAY);
    case 'weekly':
      return barTime(Math.floor((instant - FIRST_MONDAY) / WEEK) * WEEK + FIRST_MONDAY);
    case 'monthly': {
      const parts = zonedParts(instant, 'UTC');
      return barTimeFromUtcParts(parts.year, parts.month, 1);
    }
    default:
      throw new AlignmentError(`Unhandled timeframe ${timeframe}`);
  }
}

function alignStock(
  instrument: Instrument,
  timeframe: Timeframe,
  instant: BarTime,
  calendar: MarketCalendar,
): BarTime | undefined {
  const session = sessionContaining(instrument, calendar, instant);
  // Outside regular hours, on a weekend or on a holiday the instant belongs to
  // no bar at all: those minutes are not part of any bar.
  if (session === undefined) return undefined;

  const seconds = timeframeSeconds(timeframe);
  if (seconds !== undefined) {
    // Anchored to the session open, so the day's last bar is simply short and
    // a bar can never run past the close into the next session.
    const elapsed = instant - session.open;
    return barTime(session.open + Math.floor(elapsed / seconds) * seconds);
  }

  switch (timeframeKind(timeframe)) {
    case 'daily':
      // The containing session's own open: no lookup needed.
      return session.open;
    case 'weekly':
      return stampForSessionDate(instrument, calendar, firstTradingDayOfWeek(calendar, session.date));
    case 'monthly':
      return stampForSessionDate(instrument, calendar, firstTradingDayOfMonth(calendar, session.date));
    default:
      throw new AlignmentError(`Unhandled timeframe ${timeframe}`);
  }
}

/**
 * The open time of the bar that contains `instant`, or `undefined` when the
 * instant belongs to no bar.
 *
 * `undefined` only happens for instruments with sessions: a minute outside
 * regular hours, on a weekend or on a holiday is not part of any bar. Crypto
 * trades 24/7, so every instant lands in a bar.
 *
 * A calendar is required for instruments with sessions and ignored otherwise.
 */
export function alignToTimeframe(
  instrument: Instrument,
  timeframe: Timeframe,
  instant: BarTime,
  calendar?: MarketCalendar,
): BarTime | undefined {
  if (!hasSessions(instrument)) return alignCrypto(timeframe, instant);
  if (calendar === undefined) {
    throw new AlignmentError(
      `${instrument.symbol} has market sessions, so aligning it needs a calendar`,
    );
  }
  return alignStock(instrument, timeframe, instant, calendar);
}
