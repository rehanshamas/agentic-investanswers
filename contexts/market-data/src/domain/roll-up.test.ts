import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import {
  barTimeFromUtcParts,
  nyseCalendar,
  parseScaled,
  price,
  sessionOn,
  volume,
} from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { affectedBarTimes, rollUp, RollUpError } from './roll-up.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};
const NVDA: Instrument = {
  symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ',
  timeZone: 'America/New_York', priceScale: 2, volumeScale: 0,
};
const nyse = nyseCalendar();

/** A 1-minute bar with explicit OHLCV, as decimal strings. */
function m(
  time: BarTime,
  o: string, h: string, l: string, c: string, v: string,
  scale = 8,
): Bar {
  return {
    time,
    open: price(parseScaled(o, 2)),
    high: price(parseScaled(h, 2)),
    low: price(parseScaled(l, 2)),
    close: price(parseScaled(c, 2)),
    volume: volume(parseScaled(v, scale)),
  };
}

const t0 = barTimeFromUtcParts(2024, 3, 15); // 00:00 UTC, a Friday
const at = (minutes: number): BarTime => (t0 + minutes * 60) as BarTime;

describe('aggregation rules', () => {
  it('takes the first open, last close, highest high and lowest low', () => {
    const minutes = [
      m(at(0), '100.00', '101.00', '99.00', '100.50', '1.00000000'),
      m(at(1), '100.50', '103.00', '100.00', '102.00', '2.00000000'),
      m(at(2), '102.00', '102.50', '98.00', '98.50', '3.00000000'),
      m(at(3), '98.50', '99.00', '98.25', '98.75', '4.00000000'),
      m(at(4), '98.75', '100.00', '98.50', '99.90', '5.00000000'),
    ];
    const [bar] = rollUp(BTC, '5m', minutes);
    expect(bar?.time).toBe(at(0));
    expect(bar?.open).toBe(parseScaled('100.00', 2)); // first
    expect(bar?.close).toBe(parseScaled('99.90', 2)); // last
    expect(bar?.high).toBe(parseScaled('103.00', 2)); // max
    expect(bar?.low).toBe(parseScaled('98.00', 2)); // min
    expect(bar?.volume).toBe(parseScaled('15.00000000', 8)); // sum
  });

  it('sums volume exactly, where decimal addition would drift', () => {
    // 0.1 + 0.2 as floats is 0.30000000000000004.
    const minutes = [
      m(at(0), '1.00', '1.00', '1.00', '1.00', '0.10000000'),
      m(at(1), '1.00', '1.00', '1.00', '1.00', '0.20000000'),
    ];
    const [bar] = rollUp(BTC, '5m', minutes);
    expect(bar?.volume).toBe(parseScaled('0.30000000', 8));
  });

  it('builds a bar from a partial bucket rather than inventing flat minutes', () => {
    // docs/bar-rules.md: a minute with no trades has no bar, and we never
    // invent flat bars. So 3 of 5 minutes still makes exactly one 5m bar.
    const minutes = [
      m(at(0), '100.00', '100.00', '100.00', '100.00', '1.00000000'),
      m(at(2), '101.00', '102.00', '101.00', '101.50', '1.00000000'),
      m(at(4), '101.50', '101.50', '100.50', '100.75', '1.00000000'),
    ];
    const bars = rollUp(BTC, '5m', minutes);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.open).toBe(parseScaled('100.00', 2));
    expect(bars[0]?.close).toBe(parseScaled('100.75', 2));
    expect(bars[0]?.volume).toBe(parseScaled('3.00000000', 8));
  });

  it('produces no bar for a bucket with no minutes', () => {
    expect(rollUp(BTC, '5m', [])).toEqual([]);
  });

  it('rejects unsorted input rather than silently mis-aggregating', () => {
    const minutes = [
      m(at(1), '1.00', '1.00', '1.00', '1.00', '1.00000000'),
      m(at(0), '1.00', '1.00', '1.00', '1.00', '1.00000000'),
    ];
    expect(() => rollUp(BTC, '5m', minutes)).toThrow(RollUpError);
  });
});

describe('crypto bucketing', () => {
  const day = Array.from({ length: 1440 }, (_, i) =>
    m(at(i), '100.00', '100.00', '100.00', '100.00', '0.00100000'),
  );

  it.each([
    ['5m' as const, 288],
    ['15m' as const, 96],
    ['1h' as const, 24],
    ['4h' as const, 6],
  ])('splits a 1,440-minute day into %s buckets', (timeframe, expected) => {
    expect(rollUp(BTC, timeframe, day)).toHaveLength(expected);
  });

  it('anchors 4h bars to 00:00 UTC', () => {
    const bars = rollUp(BTC, '4h', day);
    expect(bars.map((b) => new Date(b.time * 1000).getUTCHours())).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('starts a new bar exactly at midnight UTC rather than extending the last', () => {
    const minutes = [
      m((t0 - 60) as BarTime, '99.00', '99.00', '99.00', '99.00', '1.00000000'),
      m(t0, '100.00', '100.00', '100.00', '100.00', '1.00000000'),
    ];
    const bars = rollUp(BTC, '4h', minutes);
    expect(bars).toHaveLength(2);
    expect(bars[1]?.time).toBe(t0);
  });

  it('keeps every minute: summed bucket volume equals the input total', () => {
    for (const timeframe of ['5m', '15m', '1h', '4h'] as const) {
      const total = rollUp(BTC, timeframe, day).reduce((sum, b) => sum + b.volume, 0);
      expect(total).toBe(1440 * parseScaled('0.00100000', 8));
    }
  });
});

describe('stock bucketing', () => {
  // Tuesday 16 January 2024, a regular winter session: 14:30-21:00 UTC.
  const session = sessionOn(NVDA, nyse, '2024-01-16');
  const open = session?.open ?? (0 as BarTime);
  const sessionMinutes = Array.from({ length: 390 }, (_, i) =>
    m((open + i * 60) as BarTime, '500.00', '500.00', '500.00', '500.00', '10', 0),
  );

  it('gives seven 1h bars, the last one short', () => {
    const bars = rollUp(NVDA, '1h', sessionMinutes, nyse);
    expect(bars).toHaveLength(7);
    expect(bars[0]?.time).toBe(open);
  });

  it('gives exactly two 4h bars, holding 240 and 150 minutes of volume', () => {
    // Confirmed against the real exports: 16 and 10 fifteen-minute bars.
    const bars = rollUp(NVDA, '4h', sessionMinutes, nyse);
    expect(bars).toHaveLength(2);
    expect(bars[0]?.volume).toBe(240 * 10);
    expect(bars[1]?.volume).toBe(150 * 10);
  });

  it('drops minutes outside the session instead of bucketing them', () => {
    const withOutside = [
      m((open - 60) as BarTime, '1.00', '1.00', '1.00', '1.00', '99', 0), // pre-market
      ...sessionMinutes,
      m((session?.close ?? 0) as BarTime, '1.00', '1.00', '1.00', '1.00', '99', 0), // at the close
    ];
    const bars = rollUp(NVDA, '1h', withOutside, nyse);
    expect(bars).toHaveLength(7);
    const total = bars.reduce((sum, b) => sum + b.volume, 0);
    expect(total).toBe(390 * 10); // neither outside minute contributed
  });

  it('never merges two sessions into one bar', () => {
    const next = sessionOn(NVDA, nyse, '2024-01-17');
    const bothDays = [
      ...sessionMinutes,
      ...Array.from({ length: 390 }, (_, i) =>
        m(((next?.open ?? 0) + i * 60) as BarTime, '500.00', '500.00', '500.00', '500.00', '10', 0),
      ),
    ];
    const bars = rollUp(NVDA, '4h', bothDays, nyse);
    expect(bars).toHaveLength(4); // two per session, never three
    expect(bars[2]?.time).toBe(next?.open);
  });
});

describe('affectedBarTimes', () => {
  it('maps one new minute to exactly one bucket per timeframe', () => {
    const one = [m(at(7), '1.00', '1.00', '1.00', '1.00', '1.00000000')];
    for (const timeframe of ['5m', '15m', '1h', '4h'] as const) {
      expect(affectedBarTimes(BTC, timeframe, one)).toHaveLength(1);
    }
  });

  it('points at the bucket that contains the minute', () => {
    const one = [m(at(7), '1.00', '1.00', '1.00', '1.00', '1.00000000')];
    expect(affectedBarTimes(BTC, '5m', one)[0]).toBe(at(5));
    expect(affectedBarTimes(BTC, '15m', one)[0]).toBe(at(0));
    expect(affectedBarTimes(BTC, '4h', one)[0]).toBe(at(0));
  });

  it('returns each affected bucket once, in order', () => {
    const minutes = [at(0), at(1), at(6), at(7), at(13)].map((t) =>
      m(t, '1.00', '1.00', '1.00', '1.00', '1.00000000'),
    );
    expect(affectedBarTimes(BTC, '5m', minutes)).toEqual([at(0), at(5), at(10)]);
  });

  it('ignores minutes that belong to no bar', () => {
    const outside = [
      m(barTimeFromUtcParts(2024, 1, 20, 15, 0, 0), '1.00', '1.00', '1.00', '1.00', '1', 0),
    ];
    expect(affectedBarTimes(NVDA, '1h', outside, nyse)).toEqual([]);
  });
});
