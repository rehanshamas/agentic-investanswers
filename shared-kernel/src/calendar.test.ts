// The NYSE calendar data for 1999-2027 (M1-12).
//
// The rule check below recomputes every scheduled holiday and half day from
// the NYSE's rules, independently of the lists in calendar.ts, so a typo in
// those lists fails here rather than as a wrong bar months later.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CalendarError, closeTimeOn, isTradingDay, nyseCalendar } from './calendar.js';
import { addDays, dateKey, dayOfWeek, parseDateKey } from './time-zone.js';

const nyse = nyseCalendar();

// ---- An independent statement of the NYSE rules, for 1999-2027 ----

function easterSunday(year: number): string {
  // Anonymous Gregorian computus.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return dateKey(year, month, day);
}

/** The `n`th given weekday (0 = Sunday) of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = dateKey(year, month, 1);
  return addDays(first, ((weekday - dayOfWeek(first) + 7) % 7) + 7 * (n - 1));
}

function lastWeekday(year: number, month: number, weekday: number): string {
  const last = addDays(month === 12 ? dateKey(year + 1, 1, 1) : dateKey(year, month + 1, 1), -1);
  return addDays(last, -((dayOfWeek(last) - weekday + 7) % 7));
}

/** Saturday moves to Friday, Sunday to Monday. */
function observed(key: string): string {
  const weekday = dayOfWeek(key);
  if (weekday === 6) return addDays(key, -1);
  if (weekday === 0) return addDays(key, 1);
  return key;
}

const UNSCHEDULED = [
  '2001-09-11', '2001-09-12', '2001-09-13', '2001-09-14', // the attacks
  '2004-06-11', // President Reagan
  '2007-01-02', // President Ford
  '2012-10-29', '2012-10-30', // Hurricane Sandy
  '2018-12-05', // President George H. W. Bush
  '2025-01-09', // President Carter
];

function expectedHolidays(year: number): string[] {
  const days: string[] = [];
  const newYear = dateKey(year, 1, 1);
  // A Saturday New Year's Day is not observed at all (NYSE Rule 7.2).
  if (dayOfWeek(newYear) === 0) days.push(addDays(newYear, 1));
  else if (dayOfWeek(newYear) !== 6) days.push(newYear);
  days.push(nthWeekday(year, 1, 1, 3)); // Martin Luther King Jr. Day
  days.push(nthWeekday(year, 2, 1, 3)); // Washington's Birthday
  days.push(addDays(easterSunday(year), -2)); // Good Friday
  days.push(lastWeekday(year, 5, 1)); // Memorial Day
  if (year >= 2022) days.push(observed(dateKey(year, 6, 19))); // Juneteenth
  days.push(observed(dateKey(year, 7, 4)));
  days.push(nthWeekday(year, 9, 1, 1)); // Labor Day
  days.push(nthWeekday(year, 11, 4, 4)); // Thanksgiving
  days.push(observed(dateKey(year, 12, 25)));
  days.push(...UNSCHEDULED.filter((key) => parseDateKey(key).year === year));
  return days.sort();
}

function expectedEarlyCloses(year: number): string[] {
  const days = [addDays(nthWeekday(year, 11, 4, 4), 1)]; // day after Thanksgiving
  const july3 = dateKey(year, 7, 3);
  const july3Day = dayOfWeek(july3);
  if (july3Day === 1 || july3Day === 2 || july3Day === 4 || (year >= 2013 && july3Day === 3)) {
    days.push(july3);
  }
  const july5 = dateKey(year, 7, 5);
  if (year < 2013 && dayOfWeek(july5) === 5) days.push(july5);
  const christmasEve = dateKey(year, 12, 24);
  if (dayOfWeek(christmasEve) >= 1 && dayOfWeek(christmasEve) <= 4) days.push(christmasEve);
  if (year === 1999) days.push('1999-12-31');
  if (year === 2003) days.push('2003-12-26');
  return days.sort();
}

describe('the NYSE calendar, 1999-2027', () => {
  it('answers from NVDA\'s first session to the last day of 2027', () => {
    expect(isTradingDay(nyse, '1999-01-22')).toBe(true);
    expect(isTradingDay(nyse, '2027-12-31')).toBe(true);
    expect(nyse.coveredYears).toEqual([1999, 2027]);
  });

  it('still refuses to guess outside that range', () => {
    expect(() => isTradingDay(nyse, '1998-12-31')).toThrow(CalendarError);
    expect(() => isTradingDay(nyse, '2028-01-03')).toThrow(CalendarError);
    expect(() => closeTimeOn(nyse, '2028-11-24')).toThrow(CalendarError);
  });

  it.each(UNSCHEDULED)('has no session on the unscheduled closure %s', (key) => {
    expect(isTradingDay(nyse, key)).toBe(false);
  });

  it('reopened on Monday 17 September 2001, after the attacks', () => {
    expect(isTradingDay(nyse, '2001-09-17')).toBe(true);
  });

  it('lists exactly the holidays the rules give, every year', () => {
    for (let year = 1999; year <= 2027; year++) {
      const listed = [...nyse.holidays].filter((key) => parseDateKey(key).year === year).sort();
      expect(listed, `holidays in ${year}`).toEqual(expectedHolidays(year));
    }
  });

  it('lists exactly the half days the rules give, every year', () => {
    for (let year = 1999; year <= 2027; year++) {
      const listed = [...nyse.earlyCloses.keys()].filter((key) => parseDateKey(key).year === year).sort();
      expect(listed, `early closes in ${year}`).toEqual(expectedEarlyCloses(year));
    }
  });

  it('closes at 13:00 on pre-2004 half days', () => {
    for (const key of ['1999-11-26', '1999-12-31', '2000-07-03', '2002-07-05', '2003-12-26']) {
      expect(closeTimeOn(nyse, key), key).toEqual({ hour: 13, minute: 0 });
    }
    expect(closeTimeOn(nyse, '2002-07-03')).toEqual({ hour: 16, minute: 0 }); // a Wednesday before 2013
  });

  it('has the published 2027 calendar (nyse.com)', () => {
    expect([...nyse.holidays].filter((key) => key.startsWith('2027-')).sort()).toEqual([
      '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
      '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
    ]);
    expect([...nyse.earlyCloses.keys()].filter((key) => key.startsWith('2027-'))).toEqual(['2027-11-26']);
  });
});

// ---- Against the NVDA daily export, once it is in the exports folder ----

const NVDA_1D = join(__dirname, '..', '..', 'fixtures', 'parity', 'tradingview', 'nvda_1d.csv');
const HAVE_NVDA = existsSync(NVDA_1D);
if (!HAVE_NVDA) {
  console.warn(
    `\n  SKIPPING the NVDA calendar check: no ${NVDA_1D}.` +
      '\n  Expected until OI-27 places the stock exports. M1-12 ran it by hand: 0 mismatches 1999-2026.\n',
  );
}

describe.skipIf(!HAVE_NVDA)('the calendar against the NVDA daily export', () => {
  it('has a session exactly on the days the export has a bar', () => {
    const lines = readFileSync(NVDA_1D, 'utf8').trim().split('\n').slice(1);
    // Stamped at 09:30 New York, so the UTC date is the session date.
    const bars = new Set(lines.map((line) => new Date(Number(line.split(',')[0]) * 1000).toISOString().slice(0, 10)));
    const days = [...bars].sort();
    const first = days[0];
    const last = days[days.length - 1];
    if (first === undefined || last === undefined) throw new Error('empty export');
    const wrong: string[] = [];
    for (let key = first; key <= last; key = addDays(key, 1)) {
      if (isTradingDay(nyse, key) !== bars.has(key)) wrong.push(key);
    }
    expect(wrong).toEqual([]);
  });
});
