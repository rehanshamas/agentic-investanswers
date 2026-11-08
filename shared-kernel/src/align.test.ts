import { describe, expect, it } from 'vitest';

import { alignToTimeframe, AlignmentError } from './align.js';
import type { BarTime } from './bar-time.js';
import { addMinutes, barTimeFromUtcParts } from './bar-time.js';
import { nyseCalendar } from './calendar.js';
import type { Instrument } from './instrument.js';

import { sessionOn } from './session.js';
import type { Timeframe } from './timeframe.js';
import { zonedParts } from './time-zone.js';

const BTC: Instrument = {
  symbol: 'BTCUSD',
  kind: 'crypto',
  venue: 'COINBASE',
  timeZone: 'UTC',
  priceScale: 2,
  volumeScale: 8,
};

const NVDA: Instrument = {
  symbol: 'NVDA',
  kind: 'stock',
  venue: 'NASDAQ',
  timeZone: 'America/New_York',
  priceScale: 2,
  volumeScale: 0,
};

const nyse = nyseCalendar();

/** Every distinct bar open a timeframe produces across one stock session. */
function barsAcrossSession(timeframe: Timeframe, date: string): BarTime[] {
  const session = sessionOn(NVDA, nyse, date);
  if (session === undefined) throw new Error(`${date} has no session`);
  const opens: BarTime[] = [];
  for (let minute = session.open; minute < session.close; minute = addMinutes(minute, 1)) {
    const aligned = alignToTimeframe(NVDA, timeframe, minute, nyse);
    if (aligned === undefined) throw new Error(`minute ${minute} aligned to nothing`);
    if (opens.at(-1) !== aligned) opens.push(aligned);
  }
  return opens;
}

describe('crypto alignment, anchored to 00:00 UTC', () => {
  it.each([
    ['1m' as Timeframe, barTimeFromUtcParts(2024, 3, 15, 7, 43, 0)],
    ['5m' as Timeframe, barTimeFromUtcParts(2024, 3, 15, 7, 40, 0)],
    ['15m' as Timeframe, barTimeFromUtcParts(2024, 3, 15, 7, 30, 0)],
    ['1h' as Timeframe, barTimeFromUtcParts(2024, 3, 15, 7, 0, 0)],
    ['4h' as Timeframe, barTimeFromUtcParts(2024, 3, 15, 4, 0, 0)],
    ['1D' as Timeframe, barTimeFromUtcParts(2024, 3, 15)],
  ])('%s at 07:43:00 UTC', (timeframe, expected) => {
    const instant = barTimeFromUtcParts(2024, 3, 15, 7, 43, 29);
    expect(alignToTimeframe(BTC, timeframe, instant)).toBe(expected);
  });

  it('puts the last minute of a UTC day in that day, not the next', () => {
    const instant = barTimeFromUtcParts(2024, 3, 15, 23, 59, 0);
    expect(alignToTimeframe(BTC, '1h', instant)).toBe(barTimeFromUtcParts(2024, 3, 15, 23, 0, 0));
    expect(alignToTimeframe(BTC, '1D', instant)).toBe(barTimeFromUtcParts(2024, 3, 15));
    expect(alignToTimeframe(BTC, '4h', instant)).toBe(barTimeFromUtcParts(2024, 3, 15, 20, 0, 0));
  });

  it('starts the daily bar exactly at the 00:00 UTC close (bar-rules: 00:00 to 24:00)', () => {
    const midnight = barTimeFromUtcParts(2024, 3, 16);
    expect(alignToTimeframe(BTC, '1D', midnight)).toBe(midnight);
    const secondBefore = addMinutes(midnight, -1);
    expect(alignToTimeframe(BTC, '1D', secondBefore)).toBe(barTimeFromUtcParts(2024, 3, 15));
  });

  it('gives six 4h bars a day, at 00:00 to 20:00 UTC', () => {
    const opens = new Set<number>();
    const dayStart = barTimeFromUtcParts(2024, 3, 15);
    for (let minute = 0; minute < 1440; minute += 1) {
      const aligned = alignToTimeframe(BTC, '4h', addMinutes(dayStart, minute));
      if (aligned !== undefined) opens.add(aligned);
    }
    expect([...opens]).toEqual([0, 4, 8, 12, 16, 20].map((h) => barTimeFromUtcParts(2024, 3, 15, h, 0, 0)));
  });

  it('starts the week on Monday 00:00 UTC', () => {
    // 15 March 2024 is a Friday; its week starts Monday the 11th.
    const friday = barTimeFromUtcParts(2024, 3, 15, 13, 0, 0);
    expect(alignToTimeframe(BTC, '1W', friday)).toBe(barTimeFromUtcParts(2024, 3, 11));
    const monday = barTimeFromUtcParts(2024, 3, 11);
    expect(alignToTimeframe(BTC, '1W', monday)).toBe(monday);
    expect(alignToTimeframe(BTC, '1W', addMinutes(monday, -1))).toBe(barTimeFromUtcParts(2024, 3, 4));
  });

  it('starts the month on the 1st, 00:00 UTC', () => {
    expect(alignToTimeframe(BTC, '1M', barTimeFromUtcParts(2024, 3, 15, 13, 0, 0))).toBe(
      barTimeFromUtcParts(2024, 3, 1),
    );
    expect(alignToTimeframe(BTC, '1M', barTimeFromUtcParts(2024, 12, 31, 23, 59, 0))).toBe(
      barTimeFromUtcParts(2024, 12, 1),
    );
  });

  it('never leaves an instant without a bar, because crypto trades 24/7', () => {
    const dayStart = barTimeFromUtcParts(2024, 12, 25); // a stock holiday
    for (let minute = 0; minute < 1440; minute += 60) {
      expect(alignToTimeframe(BTC, '1h', addMinutes(dayStart, minute))).toBeDefined();
    }
  });
});

describe('stock alignment, anchored to the session open', () => {
  it('gives seven 1h bars, the last one short', () => {
    // Tuesday 16 January 2024, a regular session: 09:30-16:00 New York.
    const opens = barsAcrossSession('1h', '2024-01-16');
    const session = sessionOn(NVDA, nyse, '2024-01-16');
    expect(session).toBeDefined();
    expect(opens).toHaveLength(7);
    expect(opens[0]).toBe(session?.open);
    // 09:30 ET is 14:30 UTC in winter, so bars run 14:30 to 20:30 UTC.
    expect(opens).toEqual([14.5, 15.5, 16.5, 17.5, 18.5, 19.5, 20.5].map((hour) =>
      barTimeFromUtcParts(2024, 1, 16, Math.floor(hour), (hour % 1) * 60, 0),
    ));
    // The last bar is 30 minutes, not an hour: 20:30 to the 21:00 close.
    const lastOpen = opens.at(-1);
    expect(lastOpen).toBeDefined();
    expect((session?.close ?? 0) - (lastOpen ?? 0)).toBe(30 * 60);
  });

  it('gives exactly two 4h bars, at 09:30 and 13:30 New York', () => {
    const opens = barsAcrossSession('4h', '2024-01-16');
    expect(opens).toHaveLength(2);
    expect(opens).toEqual([
      barTimeFromUtcParts(2024, 1, 16, 14, 30, 0), // 09:30 ET
      barTimeFromUtcParts(2024, 1, 16, 18, 30, 0), // 13:30 ET
    ]);
  });

  it('never lets a bar span two sessions', () => {
    const monday = barsAcrossSession('4h', '2024-01-16');
    const tuesday = barsAcrossSession('4h', '2024-01-17');
    const lastOfMonday = monday.at(-1);
    const firstOfTuesday = tuesday[0];
    expect(lastOfMonday).toBeDefined();
    expect(firstOfTuesday).toBeDefined();
    expect(firstOfTuesday).not.toBe(lastOfMonday);
    // Tuesday's first bar starts at Tuesday's open, not part-way through a
    // block carried over from Monday.
    expect(firstOfTuesday).toBe(sessionOn(NVDA, nyse, '2024-01-17')?.open);
  });

  it('gives 390 one-minute bars on a regular day and 210 on a half day', () => {
    expect(barsAcrossSession('1m', '2024-01-16')).toHaveLength(390);
    // Friday 29 November 2024, the day after Thanksgiving: closes at 13:00.
    expect(barsAcrossSession('1m', '2024-11-29')).toHaveLength(210);
  });

  it('puts no bar on a minute outside regular hours', () => {
    const session = sessionOn(NVDA, nyse, '2024-01-16');
    expect(session).toBeDefined();
    const beforeOpen = addMinutes(session?.open ?? (0 as BarTime), -1);
    const atClose = session?.close ?? (0 as BarTime);
    expect(alignToTimeframe(NVDA, '1m', beforeOpen, nyse)).toBeUndefined();
    expect(alignToTimeframe(NVDA, '1m', atClose, nyse)).toBeUndefined();
  });

  it('puts no bar on a weekend or a holiday', () => {
    const saturday = barTimeFromUtcParts(2024, 1, 20, 15, 0, 0);
    const christmas = barTimeFromUtcParts(2024, 12, 25, 15, 0, 0);
    const mlkDay = barTimeFromUtcParts(2024, 1, 15, 15, 0, 0);
    expect(alignToTimeframe(NVDA, '1m', saturday, nyse)).toBeUndefined();
    expect(alignToTimeframe(NVDA, '1m', christmas, nyse)).toBeUndefined();
    expect(alignToTimeframe(NVDA, '1m', mlkDay, nyse)).toBeUndefined();
  });

  it('refuses to align an instrument with sessions when no calendar is given', () => {
    const instant = barTimeFromUtcParts(2024, 1, 16, 15, 0, 0);
    expect(() => alignToTimeframe(NVDA, '1m', instant)).toThrow(AlignmentError);
  });
});

describe('stock alignment across daylight saving', () => {
  // US DST in 2024: forward on 10 March, back on 3 November. The session is
  // 14:30-21:00 UTC in winter and 13:30-20:00 UTC in summer (bar-rules).
  it('opens at 14:30 UTC in winter and 13:30 UTC in summer', () => {
    expect(sessionOn(NVDA, nyse, '2024-01-16')?.open).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 30, 0));
    expect(sessionOn(NVDA, nyse, '2024-07-16')?.open).toBe(barTimeFromUtcParts(2024, 7, 16, 13, 30, 0));
  });

  it('shifts the whole bar grid on the Monday after the clocks go forward', () => {
    // Friday 8 March is EST; Monday 11 March is EDT.
    const beforeOpens = barsAcrossSession('1h', '2024-03-08');
    const afterOpens = barsAcrossSession('1h', '2024-03-11');
    expect(beforeOpens[0]).toBe(barTimeFromUtcParts(2024, 3, 8, 14, 30, 0));
    expect(afterOpens[0]).toBe(barTimeFromUtcParts(2024, 3, 11, 13, 30, 0));
    // Same shape either side: seven bars, last one short.
    expect(beforeOpens).toHaveLength(7);
    expect(afterOpens).toHaveLength(7);
  });

  it('shifts back on the Monday after the clocks go back', () => {
    // Friday 1 November is EDT; Monday 4 November is EST.
    expect(barsAcrossSession('1h', '2024-11-01')[0]).toBe(barTimeFromUtcParts(2024, 11, 1, 13, 30, 0));
    expect(barsAcrossSession('1h', '2024-11-04')[0]).toBe(barTimeFromUtcParts(2024, 11, 4, 14, 30, 0));
  });

  it('keeps 390 one-minute bars on both DST transition weeks', () => {
    expect(barsAcrossSession('1m', '2024-03-11')).toHaveLength(390);
    expect(barsAcrossSession('1m', '2024-11-04')).toHaveLength(390);
  });
});

describe('stock daily, weekly and monthly stamping', () => {
  // These expectations were corrected against the real TradingView exports
  // (OI-04). The earlier ones said midnight UTC of the session date, which was
  // a documented guess; `nvda_1d.csv` has 6,992 bars whose New York time of day
  // is always 09:30, so the stamp is the session open.

  /** Every stamp must read 09:30 in New York, whatever the UTC offset is. */
  function expectNineThirtyNewYork(stamp: BarTime | undefined): void {
    expect(stamp).toBeDefined();
    if (stamp === undefined) return;
    const parts = zonedParts(stamp, 'America/New_York');
    expect(`${parts.hour}:${parts.minute}`).toBe('9:30');
  }

  it('stamps a daily bar with its session open, not midnight', () => {
    const midSession = barTimeFromUtcParts(2024, 1, 16, 17, 0, 0);
    const stamp = alignToTimeframe(NVDA, '1D', midSession, nyse);
    expect(stamp).toBe(sessionOn(NVDA, nyse, '2024-01-16')?.open);
    expect(stamp).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 30, 0));
    expectNineThirtyNewYork(stamp);
  });

  it('reads 09:30 New York in both EST and EDT, which is 14:30 and 13:30 UTC', () => {
    // The invariant the exports actually show: one New York time, two UTC times.
    const winter = alignToTimeframe(NVDA, '1D', barTimeFromUtcParts(2024, 1, 16, 17, 0, 0), nyse);
    const summer = alignToTimeframe(NVDA, '1D', barTimeFromUtcParts(2024, 7, 16, 17, 0, 0), nyse);
    expect(winter).toBe(barTimeFromUtcParts(2024, 1, 16, 14, 30, 0));
    expect(summer).toBe(barTimeFromUtcParts(2024, 7, 16, 13, 30, 0));
    expectNineThirtyNewYork(winter);
    expectNineThirtyNewYork(summer);
  });

  it('starts the week at the first session, so Tuesday after a Monday holiday', () => {
    // Monday 15 January 2024 is Martin Luther King Jr. Day.
    const wednesday = barTimeFromUtcParts(2024, 1, 17, 17, 0, 0);
    const stamp = alignToTimeframe(NVDA, '1W', wednesday, nyse);
    expect(stamp).toBe(sessionOn(NVDA, nyse, '2024-01-16')?.open);
    expectNineThirtyNewYork(stamp);
  });

  it('starts the week on Monday when Monday is a trading day', () => {
    const wednesday = barTimeFromUtcParts(2024, 1, 24, 17, 0, 0);
    const stamp = alignToTimeframe(NVDA, '1W', wednesday, nyse);
    expect(stamp).toBe(sessionOn(NVDA, nyse, '2024-01-22')?.open);
    expectNineThirtyNewYork(stamp);
  });

  it('starts the month at the first session, so the 2nd when the 1st is a holiday', () => {
    // 1 January 2024 is a Monday and a holiday, so January opens on the 2nd.
    const midJanuary = barTimeFromUtcParts(2024, 1, 16, 17, 0, 0);
    expect(alignToTimeframe(NVDA, '1M', midJanuary, nyse)).toBe(
      sessionOn(NVDA, nyse, '2024-01-02')?.open,
    );
    // 1 July 2024 is a Monday and a trading day, and in daylight time.
    const midJuly = barTimeFromUtcParts(2024, 7, 16, 17, 0, 0);
    const july = alignToTimeframe(NVDA, '1M', midJuly, nyse);
    expect(july).toBe(barTimeFromUtcParts(2024, 7, 1, 13, 30, 0));
    expectNineThirtyNewYork(july);
  });

  it('never stamps a stock calendar bar at midnight UTC', () => {
    // The bug this replaced: a guard so it cannot come back unnoticed.
    for (const timeframe of ['1D', '1W', '1M'] as const) {
      const stamp = alignToTimeframe(NVDA, timeframe, barTimeFromUtcParts(2024, 1, 16, 17, 0, 0), nyse);
      expect(stamp).toBeDefined();
      if (stamp !== undefined) expect(stamp % 86_400).not.toBe(0);
    }
  });
});
