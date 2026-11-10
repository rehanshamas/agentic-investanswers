import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, nyseCalendar, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { expectedSpan, findHoles, holeRuns } from './gaps.js';
import { RawDayError, assertStorableFill, mergeDay } from './raw-day.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const NVDA: Instrument = { symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ', timeZone: 'America/New_York', priceScale: 2, volumeScale: 0 };
const nyse = nyseCalendar();

function bar(time: BarTime): Bar {
  return { time, open: price(100), high: price(100), low: price(100), close: price(100), volume: volume(1) };
}

describe('expectedSpan', () => {
  it('is the whole UTC day for crypto', () => {
    expect(expectedSpan(BTC, '2026-01-01', nyse)).toEqual({
      from: barTimeFromUtcParts(2026, 1, 1),
      until: barTimeFromUtcParts(2026, 1, 2),
    });
  });

  it('is the regular session for stocks, in UTC, across daylight saving', () => {
    // 09:30-16:00 New York: 14:30-21:00 UTC in winter, 13:30-20:00 in summer.
    expect(expectedSpan(NVDA, '2026-01-06', nyse)).toEqual({
      from: barTimeFromUtcParts(2026, 1, 6, 14, 30),
      until: barTimeFromUtcParts(2026, 1, 6, 21, 0),
    });
    expect(expectedSpan(NVDA, '2026-07-07', nyse)?.from).toBe(barTimeFromUtcParts(2026, 7, 7, 13, 30));
  });

  it('ends at 13:00 New York on a half day', () => {
    expect(expectedSpan(NVDA, '2026-11-27', nyse)?.until).toBe(barTimeFromUtcParts(2026, 11, 27, 18, 0));
  });

  it('expects nothing on stock weekends and holidays', () => {
    expect(expectedSpan(NVDA, '2026-11-26', nyse)).toBeUndefined(); // Thanksgiving
    expect(expectedSpan(NVDA, '2026-11-28', nyse)).toBeUndefined(); // Saturday
  });
});

describe('findHoles and holeRuns', () => {
  const span = { from: barTimeFromUtcParts(2026, 1, 1, 0, 0), until: barTimeFromUtcParts(2026, 1, 1, 0, 10) };
  const at = (m: number): BarTime => barTime(span.from + m * 60);

  it('finds the missing minutes and groups them into runs', () => {
    const bars = [0, 1, 4, 5, 6, 9].map((m) => bar(at(m)));
    const holes = findHoles(bars, span);
    expect(holes).toEqual([at(2), at(3), at(7), at(8)]);
    expect(holeRuns(holes)).toEqual([{ from: at(2), minutes: 2 }, { from: at(7), minutes: 2 }]);
  });

  it('ignores bars outside the span, such as pre-market minutes', () => {
    const bars = [bar(barTime(span.from - 60)), ...[...Array(10).keys()].map((m) => bar(at(m)))];
    expect(findHoles(bars, span)).toEqual([]);
  });
});

describe('gap fills', () => {
  const day = '2026-01-01';
  const at = (m: number): BarTime => barTime(barTimeFromUtcParts(2026, 1, 1) + m * 60);

  it('accepts minutes absent from the day and earlier fills', () => {
    expect(() => assertStorableFill(day, [bar(at(0)), bar(at(2))], [bar(at(1))])).not.toThrow();
  });

  it('refuses to replace a stored minute: raw is never edited', () => {
    expect(() => assertStorableFill(day, [bar(at(0)), bar(at(1))], [bar(at(1))])).toThrow(/never edited/);
  });

  it('refuses an empty fill and a bar outside the day', () => {
    expect(() => assertStorableFill(day, [], [])).toThrow(RawDayError);
    expect(() => assertStorableFill(day, [], [bar(barTime(at(0) - 60))])).toThrow(RawDayError);
  });

  it('merges a day with its fills in time order, refusing overlaps', () => {
    expect(mergeDay(day, [[bar(at(0)), bar(at(3))], [bar(at(1))], [bar(at(2))]]).map((b) => b.time)).toEqual([
      at(0), at(1), at(2), at(3),
    ]);
    expect(() => mergeDay(day, [[bar(at(0))], [bar(at(0))]])).toThrow(/twice/);
  });
});
