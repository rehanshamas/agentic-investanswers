import { describe, expect, it } from 'vitest';

import { barTimeFromUtcParts } from './bar-time.js';
import {
  CalendarError,
  closeTimeOn,
  firstTradingDayOfMonth,
  firstTradingDayOfWeek,
  isTradingDay,
  nyseCalendar,
  tradingDayOnOrAfter,
  tradingDayOnOrBefore,
} from './calendar.js';
import type { Instrument } from './instrument.js';
import { hasSessions, isCrypto, tickSize } from './instrument.js';
import { sessionContaining, SessionError, sessionMinutes, sessionOn } from './session.js';

const NVDA: Instrument = {
  symbol: 'NVDA',
  kind: 'stock',
  venue: 'NASDAQ',
  timeZone: 'America/New_York',
  priceScale: 2,
  volumeScale: 0,
};

const BTC: Instrument = {
  symbol: 'BTCUSD',
  kind: 'crypto',
  venue: 'COINBASE',
  timeZone: 'UTC',
  priceScale: 2,
  volumeScale: 8,
};

const nyse = nyseCalendar();

describe('instruments', () => {
  it('knows which instruments have sessions', () => {
    expect(hasSessions(NVDA)).toBe(true);
    expect(hasSessions(BTC)).toBe(false);
    expect(isCrypto(BTC)).toBe(true);
  });

  it('derives the tick size from the price scale', () => {
    expect(tickSize(NVDA)).toBe('0.01');
    expect(tickSize({ ...BTC, priceScale: 8 })).toBe('0.00000001');
    expect(tickSize({ ...NVDA, priceScale: 0 })).toBe('1');
  });
});

describe('the NYSE calendar', () => {
  it('treats ordinary weekdays as trading days', () => {
    expect(isTradingDay(nyse, '2024-01-16')).toBe(true);
    expect(isTradingDay(nyse, '2024-07-16')).toBe(true);
  });

  it('excludes weekends', () => {
    expect(isTradingDay(nyse, '2024-01-20')).toBe(false); // Saturday
    expect(isTradingDay(nyse, '2024-01-21')).toBe(false); // Sunday
  });

  it('excludes the published holidays', () => {
    for (const holiday of [
      '2024-01-01', // New Year's Day
      '2024-01-15', // Martin Luther King Jr. Day
      '2024-03-29', // Good Friday
      '2024-06-19', // Juneteenth
      '2024-07-04', // Independence Day
      '2024-11-28', // Thanksgiving
      '2024-12-25', // Christmas
      '2025-01-09', // national day of mourning, President Carter
    ]) {
      expect(isTradingDay(nyse, holiday)).toBe(false);
    }
  });

  it('closes early at 13:00 on half days', () => {
    expect(closeTimeOn(nyse, '2024-11-29')).toEqual({ hour: 13, minute: 0 }); // after Thanksgiving
    expect(closeTimeOn(nyse, '2024-12-24')).toEqual({ hour: 13, minute: 0 }); // Christmas Eve
    expect(closeTimeOn(nyse, '2024-07-03')).toEqual({ hour: 13, minute: 0 }); // before 4 July
    expect(closeTimeOn(nyse, '2024-01-16')).toEqual({ hour: 16, minute: 0 }); // ordinary day
  });

  it('refuses a year it has no data for, rather than guessing', () => {
    // Guessing would invent sessions on real holidays and fail parity later,
    // a long way from the cause.
    expect(() => isTradingDay(nyse, '2019-06-03')).toThrow(CalendarError);
    expect(() => isTradingDay(nyse, '2027-06-03')).toThrow(CalendarError);
  });

  it('walks to the nearest trading day', () => {
    // Saturday 20 January 2024 forwards to the Monday, back to the Friday.
    expect(tradingDayOnOrAfter(nyse, '2024-01-20')).toBe('2024-01-22');
    expect(tradingDayOnOrBefore(nyse, '2024-01-20')).toBe('2024-01-19');
    // A trading day is its own answer.
    expect(tradingDayOnOrAfter(nyse, '2024-01-22')).toBe('2024-01-22');
  });

  it('finds the first session of a week, skipping a Monday holiday', () => {
    // 15 January 2024 is a Monday holiday, so that week opens on the Tuesday.
    expect(firstTradingDayOfWeek(nyse, '2024-01-17')).toBe('2024-01-16');
    expect(firstTradingDayOfWeek(nyse, '2024-01-24')).toBe('2024-01-22');
    // Asking on a Sunday still gives that week's Monday, not the next one.
    expect(firstTradingDayOfWeek(nyse, '2024-01-28')).toBe('2024-01-22');
  });

  it('finds the first session of a month, skipping a holiday on the 1st', () => {
    expect(firstTradingDayOfMonth(nyse, '2024-01-16')).toBe('2024-01-02'); // 1 Jan is a holiday
    expect(firstTradingDayOfMonth(nyse, '2024-07-16')).toBe('2024-07-01');
    expect(firstTradingDayOfMonth(nyse, '2024-06-20')).toBe('2024-06-03'); // 1 June is a Saturday
  });
});

describe('sessions', () => {
  it('opens 09:30 and closes 16:00 New York, stored in UTC', () => {
    const winter = sessionOn(NVDA, nyse, '2024-01-16');
    expect(winter?.open).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 30, 0));
    expect(winter?.close).toBe(barTimeFromUtcParts(2024, 1, 16, 21, 0, 0));

    const summer = sessionOn(NVDA, nyse, '2024-07-16');
    expect(summer?.open).toBe(barTimeFromUtcParts(2024, 7, 16, 13, 30, 0));
    expect(summer?.close).toBe(barTimeFromUtcParts(2024, 7, 16, 20, 0, 0));
  });

  it('runs 390 minutes on a regular day and 210 on a half day', () => {
    const regular = sessionOn(NVDA, nyse, '2024-01-16');
    const half = sessionOn(NVDA, nyse, '2024-11-29');
    expect(regular).toBeDefined();
    expect(half).toBeDefined();
    if (regular !== undefined) expect(sessionMinutes(regular)).toBe(390);
    if (half !== undefined) expect(sessionMinutes(half)).toBe(210);
  });

  it('has no session on a weekend or a holiday', () => {
    expect(sessionOn(NVDA, nyse, '2024-01-20')).toBeUndefined();
    expect(sessionOn(NVDA, nyse, '2024-12-25')).toBeUndefined();
  });

  it('refuses to give a session for an instrument that trades 24/7', () => {
    expect(() => sessionOn(BTC, nyse, '2024-01-16')).toThrow(SessionError);
  });

  it('finds the session containing an instant', () => {
    const midSession = barTimeFromUtcParts(2024, 1, 16, 17, 0, 0);
    expect(sessionContaining(NVDA, nyse, midSession)?.date).toBe('2024-01-16');
  });

  it('includes the opening second and excludes the closing one', () => {
    const session = sessionOn(NVDA, nyse, '2024-01-16');
    expect(session).toBeDefined();
    if (session === undefined) return;
    expect(sessionContaining(NVDA, nyse, session.open)).toBeDefined();
    // The close is the first instant *after* the session, so 16:00:00 belongs
    // to no bar; the last bar covers 15:59.
    expect(sessionContaining(NVDA, nyse, session.close)).toBeUndefined();
  });

  it('excludes pre-market and after-hours instants', () => {
    // 09:00 and 16:30 New York, on a regular winter day.
    expect(sessionContaining(NVDA, nyse, barTimeFromUtcParts(2024, 1, 16, 14, 0, 0))).toBeUndefined();
    expect(sessionContaining(NVDA, nyse, barTimeFromUtcParts(2024, 1, 16, 21, 30, 0))).toBeUndefined();
  });

  it('keys on the exchange date, not the UTC date', () => {
    // 15:00 New York on 16 January is already 20:00 UTC the same day, but
    // after-hours instants late in the New York evening roll the UTC date.
    const lateEvening = barTimeFromUtcParts(2024, 1, 17, 2, 0, 0); // 21:00 NY on the 16th
    expect(sessionContaining(NVDA, nyse, lateEvening)).toBeUndefined();
  });
});
