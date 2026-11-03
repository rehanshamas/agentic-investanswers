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
import { sessionContaining } from './session.js';
import type { Timeframe } from './timeframe.js';
import { timeframeKind, timeframeSeconds } from './timeframe.js';
import { parseDateKey, zonedParts } from './time-zone.js';

export class AlignmentError extends Error {}

/** 1970-01-05, the first Monday of the epoch, in seconds. Crypto weeks are anchored here. */
const FIRST_MONDAY = 345_600;
const DAY = 86_400;
const WEEK = 604_800;

/**
 * How a stock's 1D, 1W and 1M bar is stamped.
 *
 * docs/bar-rules.md says these are "stamped with that session's date", while
 * "Timestamps" says every bar carries its open time in UTC. For an intraday
 * bar those agree; for a daily stock bar they do not, and TradingView could
 * plausibly use midnight UTC, midnight New York, or the 09:30 session open.
 *
 * Midnight UTC of the session date is the default, as the plainest reading of
 * "that session's date". It is deliberately the only place that decision is
 * made, so confirming it against `nvda_1d.csv` when the exports land is a
 * one-line change rather than a hunt. OI-04 settles it.
 */
function stampForSessionDate(date: string): BarTime {
  const { year, month, day } = parseDateKey(date);
  return barTimeFromUtcParts(year, month, day);
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
      return stampForSessionDate(session.date);
    case 'weekly':
      return stampForSessionDate(firstTradingDayOfWeek(calendar, session.date));
    case 'monthly':
      return stampForSessionDate(firstTradingDayOfMonth(calendar, session.date));
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
