import { describe, expect, it } from 'vitest';

import {
  addDays,
  dateKey,
  dayOfWeek,
  epochSecondsFromZonedParts,
  parseDateKey,
  TimeZoneError,
  zoneOffsetSeconds,
  zonedDateKey,
  zonedParts,
} from './time-zone.js';

const NY = 'America/New_York';
const HOUR = 3600;

/** Seconds for a UTC wall clock, without going through BarTime. */
function utc(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute) / 1000;
}

describe('zone offsets', () => {
  it('is UTC-5 in winter and UTC-4 in summer in New York', () => {
    expect(zoneOffsetSeconds(utc(2024, 1, 16, 17), NY)).toBe(-5 * HOUR);
    expect(zoneOffsetSeconds(utc(2024, 7, 16, 17), NY)).toBe(-4 * HOUR);
  });

  it('switches at the 2024 transitions', () => {
    // Forward at 02:00 local on 10 March 2024 (07:00 UTC).
    expect(zoneOffsetSeconds(utc(2024, 3, 10, 6, 59), NY)).toBe(-5 * HOUR);
    expect(zoneOffsetSeconds(utc(2024, 3, 10, 7, 0), NY)).toBe(-4 * HOUR);
    // Back at 02:00 local on 3 November 2024 (06:00 UTC).
    expect(zoneOffsetSeconds(utc(2024, 11, 3, 5, 59), NY)).toBe(-4 * HOUR);
    expect(zoneOffsetSeconds(utc(2024, 11, 3, 6, 0), NY)).toBe(-5 * HOUR);
  });

  it('uses the pre-2007 rules for pre-2007 dates', () => {
    // Before 2007, US DST began on the first Sunday in April. On 15 March 2006
    // New York was still on standard time; today's rules (second Sunday in
    // March) would wrongly say daylight time. This is what proves the offsets
    // come from real tzdata rather than hard-coded month rules.
    expect(zoneOffsetSeconds(utc(2006, 3, 15, 17), NY)).toBe(-5 * HOUR);
    expect(zoneOffsetSeconds(utc(2006, 4, 15, 17), NY)).toBe(-4 * HOUR);
    // And in 2024 the same mid-March date *is* daylight time.
    expect(zoneOffsetSeconds(utc(2024, 3, 15, 17), NY)).toBe(-4 * HOUR);
  });

  it('is always zero for UTC', () => {
    expect(zoneOffsetSeconds(utc(2024, 1, 16, 17), 'UTC')).toBe(0);
    expect(zoneOffsetSeconds(utc(2024, 7, 16, 17), 'UTC')).toBe(0);
  });
});

describe('wall clock to instant and back', () => {
  it('round-trips a winter wall clock', () => {
    const parts = { year: 2024, month: 1, day: 16, hour: 9, minute: 30, second: 0 };
    const instant = epochSecondsFromZonedParts(parts, NY);
    expect(instant).toBe(utc(2024, 1, 16, 14, 30));
    expect(zonedParts(instant, NY)).toEqual(parts);
  });

  it('round-trips a summer wall clock', () => {
    const parts = { year: 2024, month: 7, day: 16, hour: 9, minute: 30, second: 0 };
    const instant = epochSecondsFromZonedParts(parts, NY);
    expect(instant).toBe(utc(2024, 7, 16, 13, 30));
    expect(zonedParts(instant, NY)).toEqual(parts);
  });

  it('round-trips the session open on both DST transition days', () => {
    for (const date of [
      { year: 2024, month: 3, day: 10 },
      { year: 2024, month: 11, day: 3 },
    ]) {
      const parts = { ...date, hour: 9, minute: 30, second: 0 };
      expect(zonedParts(epochSecondsFromZonedParts(parts, NY), NY)).toEqual(parts);
    }
  });

  it('reports midnight as hour 0, not hour 24', () => {
    expect(zonedParts(utc(2024, 1, 16, 5), NY).hour).toBe(0);
  });
});

describe('calendar dates', () => {
  it('reads the exchange date, which can differ from the UTC date', () => {
    // 21:30 New York on 16 January is already the 17th in UTC.
    expect(zonedDateKey(utc(2024, 1, 17, 2, 30), NY)).toBe('2024-01-16');
    expect(zonedDateKey(utc(2024, 1, 17, 2, 30), 'UTC')).toBe('2024-01-17');
  });

  it('knows the day of the week', () => {
    expect(dayOfWeek('2024-01-15')).toBe(1); // Monday
    expect(dayOfWeek('2024-01-20')).toBe(6); // Saturday
    expect(dayOfWeek('2024-01-21')).toBe(0); // Sunday
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2024-01-31', 1)).toBe('2024-02-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    expect(addDays('2024-01-01', -1)).toBe('2023-12-31');
  });

  it('formats and parses date keys', () => {
    expect(dateKey(2024, 1, 5)).toBe('2024-01-05');
    expect(parseDateKey('2024-01-05')).toEqual({ year: 2024, month: 1, day: 5 });
    expect(() => parseDateKey('5 January 2024')).toThrow(TimeZoneError);
    expect(() => parseDateKey('2024-1-5')).toThrow(TimeZoneError);
  });
});
