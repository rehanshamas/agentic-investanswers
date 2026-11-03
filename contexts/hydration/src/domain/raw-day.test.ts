import { barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import type { Bar, BarTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { assertStorableRawDay, dayEnd, dayStart, RawDayError } from './raw-day.js';

function bar(time: BarTime, close = '100.00'): Bar {
  const value = price(parseScaled(close, 2));
  return {
    time,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: volume(parseScaled('1.00000000', 8)),
  };
}

const DAY = '2024-03-15';
const start = dayStart(DAY);

describe('raw day bounds', () => {
  it('runs from 00:00 UTC to 00:00 the next day', () => {
    expect(dayStart(DAY)).toBe(barTimeFromUtcParts(2024, 3, 15));
    expect(dayEnd(DAY)).toBe(barTimeFromUtcParts(2024, 3, 16));
    expect(dayEnd(DAY) - dayStart(DAY)).toBe(86_400);
  });

  it('is a UTC day even across a US DST change', () => {
    // 10 March 2024 is the US spring-forward day. Raw is keyed on UTC, so the
    // day is still exactly 24 hours; session dates are a cooked concern.
    expect(dayEnd('2024-03-10') - dayStart('2024-03-10')).toBe(86_400);
  });
});

describe('assertStorableRawDay', () => {
  it('accepts an empty day', () => {
    expect(() => assertStorableRawDay(DAY, [])).not.toThrow();
  });

  it('accepts a full 1,440-minute crypto day', () => {
    const bars = Array.from({ length: 1440 }, (_, i) => bar((start + i * 60) as BarTime));
    expect(() => assertStorableRawDay(DAY, bars)).not.toThrow();
  });

  it('accepts a partial day, because stocks and interrupted backfills make them', () => {
    const bars = [bar((start + 3600) as BarTime), bar((start + 7200) as BarTime)];
    expect(() => assertStorableRawDay(DAY, bars)).not.toThrow();
  });

  it('rejects a bar from the previous or next day', () => {
    expect(() => assertStorableRawDay(DAY, [bar((start - 60) as BarTime)])).toThrow(RawDayError);
    expect(() => assertStorableRawDay(DAY, [bar(dayEnd(DAY))])).toThrow(RawDayError);
  });

  it('includes the first minute and excludes the first minute of the next day', () => {
    expect(() => assertStorableRawDay(DAY, [bar(start)])).not.toThrow();
    const lastMinute = (dayEnd(DAY) - 60) as BarTime;
    expect(() => assertStorableRawDay(DAY, [bar(lastMinute)])).not.toThrow();
  });

  it('rejects a bar that is not on a whole minute', () => {
    expect(() => assertStorableRawDay(DAY, [bar((start + 30) as BarTime)])).toThrow(RawDayError);
  });

  it('rejects out-of-order and duplicated bars', () => {
    const first = bar((start + 120) as BarTime);
    const second = bar((start + 60) as BarTime);
    expect(() => assertStorableRawDay(DAY, [first, second])).toThrow(RawDayError);
    expect(() => assertStorableRawDay(DAY, [first, first])).toThrow(RawDayError);
  });

  it('rejects a bar whose own prices contradict each other', () => {
    // Raw is write-once, so an incoherent bar could never be corrected in
    // place; better to refuse it than to store it.
    const broken: Bar = {
      ...bar(start),
      high: price(parseScaled('90.00', 2)),
      low: price(parseScaled('99.00', 2)),
    };
    expect(() => assertStorableRawDay(DAY, [broken])).toThrow();
  });
});
