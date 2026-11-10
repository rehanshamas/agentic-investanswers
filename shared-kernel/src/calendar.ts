// MarketCalendar: which days have a session, and when it ends.
//
// docs/bar-rules.md: "Holidays and early closes: NYSE/Nasdaq calendar.
// Early-close days end at 13:00 New York time. The calendar lives in config,
// one list per year."
//
// The helpers take a calendar as an argument, so the kernel stays pure and a
// caller can supply a different venue's calendar. The NYSE data below is that
// config for 1999 (NVDA's listing) through 2027 (M1-12).
//
// How it was validated (M1-12, 2026-11-10):
// - Holidays and unscheduled closures: every day from 1999-01-22 to
//   2026-11-06 matches TradingView's NVDA daily export (6,992 sessions), and
//   2010-06-29 onward TSLA's (4,116), both ways: a day listed here as closed
//   has no bar, and a weekday not listed has one. Zero mismatches.
// - 2027 and early January 1999: the NYSE rules, and nyse.com's published
//   2026-2028 calendar for 2027.
// - Early closes: a daily bar cannot show a half day, so these follow NYSE
//   history as encoded (with citations) in the open-source exchange_calendars
//   XNYS calendar, which also matches every 2020-2026 date M0-04 listed.
//   calendar.test.ts recomputes the rules, so a typo here fails a test.

import type { LocalTime } from './time-zone.js';
import { addDays, dateKey, dayOfWeek, parseDateKey } from './time-zone.js';

export class CalendarError extends Error {}

export interface MarketCalendar {
  /** Zone the dates and times below are expressed in. */
  readonly timeZone: string;
  /** Dates with no session at all, `YYYY-MM-DD`. Weekends are not listed; they are implied. */
  readonly holidays: ReadonlySet<string>;
  /** Dates that close early, mapped to that day's close. */
  readonly earlyCloses: ReadonlyMap<string, LocalTime>;
  readonly regularOpen: LocalTime;
  readonly regularClose: LocalTime;
  /** Inclusive first and last year the data covers. Outside it, lookups throw rather than guess. */
  readonly coveredYears: readonly [number, number];
}

const NYSE_HOLIDAYS: readonly string[] = [
  // NYSE rules: Saturday holidays move to Friday and Sunday ones to Monday,
  // except New Year's Day on a Saturday, which is not observed at all (2005,
  // 2011, 2022, 2028). MLK Day from 1998; Juneteenth from 2022.
  // 1999
  '1999-01-01', '1999-01-18', '1999-02-15', '1999-04-02', '1999-05-31', '1999-07-05', '1999-09-06', '1999-11-25', '1999-12-24',
  // 2000
  '2000-01-17', '2000-02-21', '2000-04-21', '2000-05-29', '2000-07-04', '2000-09-04', '2000-11-23', '2000-12-25',
  // 2001 (unscheduled: 09-11: 9/11; 09-12: 9/11; 09-13: 9/11; 09-14: 9/11)
  '2001-01-01', '2001-01-15', '2001-02-19', '2001-04-13', '2001-05-28', '2001-07-04', '2001-09-03', '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14', '2001-11-22', '2001-12-25',
  // 2002
  '2002-01-01', '2002-01-21', '2002-02-18', '2002-03-29', '2002-05-27', '2002-07-04', '2002-09-02', '2002-11-28', '2002-12-25',
  // 2003
  '2003-01-01', '2003-01-20', '2003-02-17', '2003-04-18', '2003-05-26', '2003-07-04', '2003-09-01', '2003-11-27', '2003-12-25',
  // 2004 (unscheduled: 06-11: Reagan)
  '2004-01-01', '2004-01-19', '2004-02-16', '2004-04-09', '2004-05-31', '2004-06-11', '2004-07-05', '2004-09-06', '2004-11-25', '2004-12-24',
  // 2005
  '2005-01-17', '2005-02-21', '2005-03-25', '2005-05-30', '2005-07-04', '2005-09-05', '2005-11-24', '2005-12-26',
  // 2006
  '2006-01-02', '2006-01-16', '2006-02-20', '2006-04-14', '2006-05-29', '2006-07-04', '2006-09-04', '2006-11-23', '2006-12-25',
  // 2007 (unscheduled: 01-02: Ford)
  '2007-01-01', '2007-01-02', '2007-01-15', '2007-02-19', '2007-04-06', '2007-05-28', '2007-07-04', '2007-09-03', '2007-11-22', '2007-12-25',
  // 2008
  '2008-01-01', '2008-01-21', '2008-02-18', '2008-03-21', '2008-05-26', '2008-07-04', '2008-09-01', '2008-11-27', '2008-12-25',
  // 2009
  '2009-01-01', '2009-01-19', '2009-02-16', '2009-04-10', '2009-05-25', '2009-07-03', '2009-09-07', '2009-11-26', '2009-12-25',
  // 2010
  '2010-01-01', '2010-01-18', '2010-02-15', '2010-04-02', '2010-05-31', '2010-07-05', '2010-09-06', '2010-11-25', '2010-12-24',
  // 2011
  '2011-01-17', '2011-02-21', '2011-04-22', '2011-05-30', '2011-07-04', '2011-09-05', '2011-11-24', '2011-12-26',
  // 2012 (unscheduled: 10-29: Sandy; 10-30: Sandy)
  '2012-01-02', '2012-01-16', '2012-02-20', '2012-04-06', '2012-05-28', '2012-07-04', '2012-09-03', '2012-10-29', '2012-10-30', '2012-11-22', '2012-12-25',
  // 2013
  '2013-01-01', '2013-01-21', '2013-02-18', '2013-03-29', '2013-05-27', '2013-07-04', '2013-09-02', '2013-11-28', '2013-12-25',
  // 2014
  '2014-01-01', '2014-01-20', '2014-02-17', '2014-04-18', '2014-05-26', '2014-07-04', '2014-09-01', '2014-11-27', '2014-12-25',
  // 2015
  '2015-01-01', '2015-01-19', '2015-02-16', '2015-04-03', '2015-05-25', '2015-07-03', '2015-09-07', '2015-11-26', '2015-12-25',
  // 2016
  '2016-01-01', '2016-01-18', '2016-02-15', '2016-03-25', '2016-05-30', '2016-07-04', '2016-09-05', '2016-11-24', '2016-12-26',
  // 2017
  '2017-01-02', '2017-01-16', '2017-02-20', '2017-04-14', '2017-05-29', '2017-07-04', '2017-09-04', '2017-11-23', '2017-12-25',
  // 2018 (unscheduled: 12-05: G.H.W. Bush)
  '2018-01-01', '2018-01-15', '2018-02-19', '2018-03-30', '2018-05-28', '2018-07-04', '2018-09-03', '2018-11-22', '2018-12-05', '2018-12-25',
  // 2019
  '2019-01-01', '2019-01-21', '2019-02-18', '2019-04-19', '2019-05-27', '2019-07-04', '2019-09-02', '2019-11-28', '2019-12-25',
  // 2020
  '2020-01-01', '2020-01-20', '2020-02-17', '2020-04-10', '2020-05-25', '2020-07-03', '2020-09-07', '2020-11-26', '2020-12-25',
  // 2021
  '2021-01-01', '2021-01-18', '2021-02-15', '2021-04-02', '2021-05-31', '2021-07-05', '2021-09-06', '2021-11-25', '2021-12-24',
  // 2022
  '2022-01-17', '2022-02-21', '2022-04-15', '2022-05-30', '2022-06-20', '2022-07-04', '2022-09-05', '2022-11-24', '2022-12-26',
  // 2023
  '2023-01-02', '2023-01-16', '2023-02-20', '2023-04-07', '2023-05-29', '2023-06-19', '2023-07-04', '2023-09-04', '2023-11-23', '2023-12-25',
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27', '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025 (unscheduled: 01-09: Carter)
  '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
];

const ONE_PM: LocalTime = { hour: 13, minute: 0 };

// Half days, all at 13:00 New York in this range (14:00 ended in 1993):
// - the day after Thanksgiving, every year;
// - Christmas Eve on a Monday to Thursday (on a Friday it is the observed
//   Christmas holiday instead);
// - 3 July on a Monday, Tuesday or Thursday, and from 2013 on a Wednesday too;
// - before 2013, 5 July when it is a Friday (only 2002 in range);
// - two one-offs: 1999-12-31 (the Y2K year end) and 2003-12-26.
const NYSE_EARLY_CLOSES: readonly string[] = [
  '1999-11-26', '1999-12-31',  // 1999: day after Thanksgiving; year-end 1999 (Y2K)
  '2000-07-03', '2000-11-24',  // 2000: before Independence Day; day after Thanksgiving
  '2001-07-03', '2001-11-23', '2001-12-24',  // 2001: before Independence Day; day after Thanksgiving; Christmas Eve
  '2002-07-05', '2002-11-29', '2002-12-24',  // 2002: after Independence Day; day after Thanksgiving; Christmas Eve
  '2003-07-03', '2003-11-28', '2003-12-24', '2003-12-26',  // 2003: before Independence Day; day after Thanksgiving; Christmas Eve; day after Christmas
  '2004-11-26',  // 2004: day after Thanksgiving
  '2005-11-25',  // 2005: day after Thanksgiving
  '2006-07-03', '2006-11-24',  // 2006: before Independence Day; day after Thanksgiving
  '2007-07-03', '2007-11-23', '2007-12-24',  // 2007: before Independence Day; day after Thanksgiving; Christmas Eve
  '2008-07-03', '2008-11-28', '2008-12-24',  // 2008: before Independence Day; day after Thanksgiving; Christmas Eve
  '2009-11-27', '2009-12-24',  // 2009: day after Thanksgiving; Christmas Eve
  '2010-11-26',  // 2010: day after Thanksgiving
  '2011-11-25',  // 2011: day after Thanksgiving
  '2012-07-03', '2012-11-23', '2012-12-24',  // 2012: before Independence Day; day after Thanksgiving; Christmas Eve
  '2013-07-03', '2013-11-29', '2013-12-24',  // 2013: before Independence Day; day after Thanksgiving; Christmas Eve
  '2014-07-03', '2014-11-28', '2014-12-24',  // 2014: before Independence Day; day after Thanksgiving; Christmas Eve
  '2015-11-27', '2015-12-24',  // 2015: day after Thanksgiving; Christmas Eve
  '2016-11-25',  // 2016: day after Thanksgiving
  '2017-07-03', '2017-11-24',  // 2017: before Independence Day; day after Thanksgiving
  '2018-07-03', '2018-11-23', '2018-12-24',  // 2018: before Independence Day; day after Thanksgiving; Christmas Eve
  '2019-07-03', '2019-11-29', '2019-12-24',  // 2019: before Independence Day; day after Thanksgiving; Christmas Eve
  '2020-11-27', '2020-12-24',  // 2020: day after Thanksgiving; Christmas Eve
  '2021-11-26',  // 2021: day after Thanksgiving
  '2022-11-25',  // 2022: day after Thanksgiving
  '2023-07-03', '2023-11-24',  // 2023: before Independence Day; day after Thanksgiving
  '2024-07-03', '2024-11-29', '2024-12-24',  // 2024: before Independence Day; day after Thanksgiving; Christmas Eve
  '2025-07-03', '2025-11-28', '2025-12-24',  // 2025: before Independence Day; day after Thanksgiving; Christmas Eve
  '2026-11-27', '2026-12-24',  // 2026: day after Thanksgiving; Christmas Eve
  '2027-11-26',  // 2027: day after Thanksgiving
];

/** The US equities calendar: 09:30 to 16:00 New York, 13:00 on half days. */
export function nyseCalendar(): MarketCalendar {
  return {
    timeZone: 'America/New_York',
    holidays: new Set(NYSE_HOLIDAYS),
    earlyCloses: new Map(NYSE_EARLY_CLOSES.map((date) => [date, ONE_PM])),
    regularOpen: { hour: 9, minute: 30 },
    regularClose: { hour: 16, minute: 0 },
    coveredYears: [1999, 2027],
  };
}

function assertCovered(calendar: MarketCalendar, key: string): void {
  const { year } = parseDateKey(key);
  const [first, last] = calendar.coveredYears;
  if (year < first || year > last) {
    throw new CalendarError(
      `No calendar data for ${key}: covered years are ${first} to ${last}. Add that year's holidays rather than guessing.`,
    );
  }
}

/** True when the date has a session: a weekday that is not a holiday. */
export function isTradingDay(calendar: MarketCalendar, key: string): boolean {
  assertCovered(calendar, key);
  const weekday = dayOfWeek(key);
  if (weekday === 0 || weekday === 6) return false;
  return !calendar.holidays.has(key);
}

/** That date's close: 13:00 on a half day, otherwise the regular close. */
export function closeTimeOn(calendar: MarketCalendar, key: string): LocalTime {
  assertCovered(calendar, key);
  return calendar.earlyCloses.get(key) ?? calendar.regularClose;
}

/** The first trading day on or after `key`. */
export function tradingDayOnOrAfter(calendar: MarketCalendar, key: string): string {
  let cursor = key;
  for (let step = 0; step < 14; step += 1) {
    if (isTradingDay(calendar, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  throw new CalendarError(`No trading day within 14 days of ${key}`);
}

/** The last trading day on or before `key`. */
export function tradingDayOnOrBefore(calendar: MarketCalendar, key: string): string {
  let cursor = key;
  for (let step = 0; step < 14; step += 1) {
    if (isTradingDay(calendar, cursor)) return cursor;
    cursor = addDays(cursor, -1);
  }
  throw new CalendarError(`No trading day within 14 days before ${key}`);
}

/**
 * The first session of the week containing `key`.
 *
 * Weeks run Monday to Sunday, so this is normally the Monday and is the
 * Tuesday after a Monday holiday (docs/bar-rules.md, "Week").
 */
export function firstTradingDayOfWeek(calendar: MarketCalendar, key: string): string {
  const weekday = dayOfWeek(key);
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const monday = addDays(key, -daysSinceMonday);
  return tradingDayOnOrAfter(calendar, monday);
}

/** The first session of the month containing `key`. */
export function firstTradingDayOfMonth(calendar: MarketCalendar, key: string): string {
  const { year, month } = parseDateKey(key);
  return tradingDayOnOrAfter(calendar, dateKey(year, month, 1));
}
