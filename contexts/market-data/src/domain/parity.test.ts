import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTime, parseScaled, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { ParityError, compareBars, parityWindow } from './parity.js';

const MINUTE = 60;
const T0 = 1_767_225_600; // 2026-01-01 00:00 UTC

function t(index: number): BarTime {
  return barTime(T0 + index * MINUTE);
}

function bar(index: number, close = '100.00', vol = '1.5'): Bar {
  const c = price(parseScaled(close, 2));
  return { time: t(index), open: c, high: c, low: c, close: c, volume: volume(parseScaled(vol, 8)) };
}

function series(...indexes: number[]): Bar[] {
  return indexes.map((i) => bar(i));
}

describe('compareBars', () => {
  it('is exact when every bar is equal', () => {
    const result = compareBars(series(0, 1, 2), series(0, 1, 2));
    expect(result).toMatchObject({ status: 'exact', matched: 3, differing: 0, missing: 0, extra: 0 });
    expect(result.first).toBeUndefined();
  });

  it('compares the numbers, not their spelling', () => {
    // 191.2 and 191.20 parse to the same scaled integer (docs/bar-rules.md).
    const theirs = [bar(0, '191.2')];
    const ours = [bar(0, '191.20')];
    expect(compareBars(theirs, ours).status).toBe('exact');
  });

  it.each(['open', 'high', 'low', 'close', 'volume'] as const)(
    'finds a difference of one unit in %s',
    (field) => {
      const ours = series(0, 1, 2);
      const changed = ours[1];
      if (changed === undefined) throw new Error('unreachable');
      ours[1] = { ...changed, [field]: changed[field] + 1 };
      const result = compareBars(series(0, 1, 2), ours);
      expect(result).toMatchObject({ status: 'differs', matched: 2, differing: 1 });
      expect(result.first).toMatchObject({ time: t(1), fields: [field] });
    },
  );

  it('counts a bar we lack as missing', () => {
    const result = compareBars(series(0, 1, 2), series(0, 2));
    expect(result).toMatchObject({ status: 'differs', matched: 2, missing: 1, extra: 0 });
    expect(result.first).toMatchObject({ time: t(1), ours: undefined });
  });

  it('counts a bar the export lacks as extra', () => {
    const result = compareBars(series(0, 2), series(0, 1, 2));
    expect(result).toMatchObject({ status: 'differs', matched: 2, missing: 0, extra: 1 });
    expect(result.first).toMatchObject({ time: t(1), theirs: undefined });
  });

  it('reports the earliest difference first, whatever its kind', () => {
    const ours = series(0, 2, 3);
    const late = ours[2];
    if (late === undefined) throw new Error('unreachable');
    ours[2] = { ...late, volume: volume(late.volume + 1) };
    const result = compareBars(series(0, 1, 2, 3), ours);
    expect(result).toMatchObject({ missing: 1, differing: 1 });
    expect(result.first?.time).toBe(t(1));
  });

  it('is not built when we hold nothing, and counts every export bar missing', () => {
    const result = compareBars(series(0, 1, 2), []);
    expect(result).toMatchObject({ status: 'not-built', missing: 3, matched: 0 });
    expect(result.window).toEqual({ from: t(0), until: t(2), skipped: 0 });
  });

  it('ignores our bars after the export ends: we may simply be newer', () => {
    expect(compareBars(series(0, 1), series(0, 1, 2, 3)).status).toBe('exact');
  });

  it('refuses bars out of order rather than comparing them wrongly', () => {
    expect(() => compareBars(series(1, 0), series(0, 1))).toThrow(ParityError);
    expect(() => compareBars(series(0, 1), series(1, 1))).toThrow(ParityError);
  });
});

describe('parityWindow', () => {
  it('is the whole export when our history starts at or before it', () => {
    expect(parityWindow(series(5, 6, 7), series(3, 4, 5, 6, 7))).toEqual({
      from: t(5),
      until: t(7),
      skipped: 0,
    });
  });

  it('starts at our second bar when our history starts later, since the first may be partial', () => {
    expect(parityWindow(series(0, 1, 2, 3, 4), series(2, 3, 4))).toEqual({
      from: t(3),
      until: t(4),
      skipped: 3,
    });
  });

  it('does not let a partial first bar of ours fail the comparison', () => {
    const ours = series(2, 3, 4);
    const partial = ours[0];
    if (partial === undefined) throw new Error('unreachable');
    ours[0] = { ...partial, volume: volume(1) };
    const result = compareBars(series(0, 1, 2, 3, 4), ours);
    expect(result).toMatchObject({ status: 'exact', matched: 2 });
    expect(result.window?.skipped).toBe(3);
  });

  it('stays strict inside the window: a later gap still fails', () => {
    const result = compareBars(series(0, 1, 2, 3, 4, 5), series(2, 3, 5));
    expect(result).toMatchObject({ status: 'differs', missing: 1 });
    expect(result.first?.time).toBe(t(4));
  });

  it('has no window when our history starts after the export ends', () => {
    expect(parityWindow(series(0, 1), series(5, 6))).toBeUndefined();
    expect(compareBars(series(0, 1), series(5, 6)).status).toBe('no-overlap');
  });

  it('has no window when we hold only one bar after the export starts', () => {
    expect(compareBars(series(0, 1, 2), series(1)).status).toBe('no-overlap');
  });
});

describe('compareBars field counts, for source fidelity', () => {
  it('counts differing bars per field and the largest relative volume gap', () => {
    const ours = series(0, 1, 2, 3);
    const [b0, b1, , b3] = ours;
    if (b0 === undefined || b1 === undefined || b3 === undefined) throw new Error('unreachable');
    ours[1] = { ...b1, volume: volume(Math.round(b1.volume * 1.02)) }; // +2%
    ours[3] = { ...b3, low: price(b3.low - 1), volume: volume(Math.round(b3.volume * 0.97)) }; // -3%
    const result = compareBars(series(0, 1, 2, 3), ours);
    expect(result.fieldDiffers).toEqual({ open: 0, high: 0, low: 1, close: 0, volume: 2 });
    expect(result.maxVolumeDeviation).toBeCloseTo(0.03, 10);
  });

  it('is all zero when exact, and when nothing is built', () => {
    for (const result of [compareBars(series(0, 1), series(0, 1)), compareBars(series(0, 1), [])]) {
      expect(result.fieldDiffers).toEqual({ open: 0, high: 0, low: 0, close: 0, volume: 0 });
      expect(result.maxVolumeDeviation).toBe(0);
    }
  });
});
