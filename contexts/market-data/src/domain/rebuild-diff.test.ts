import type { Bar } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { RebuildDiffError, diffBars, differences } from './rebuild-diff.js';

function bar(i: number, close = 100): Bar {
  const p = price(close);
  return { time: barTime(1_735_689_600 + i * 300), open: p, high: p, low: p, close: p, volume: volume(1) };
}

describe('diffBars', () => {
  it('is all matched when stored equals rebuilt', () => {
    const d = diffBars([bar(0), bar(1)], [bar(0), bar(1)]);
    expect(d).toMatchObject({ matched: 2, differing: 0, missingFromStore: 0, notRebuildable: 0 });
    expect(differences(d)).toBe(0);
    expect(d.first).toBeUndefined();
  });

  it('tells the three kinds apart and keeps the earliest', () => {
    const d = diffBars([bar(0), bar(1), bar(3, 5)], [bar(1), bar(2), bar(3, 6)]);
    expect(d).toMatchObject({ matched: 1, differing: 1, missingFromStore: 1, notRebuildable: 1 });
    expect(differences(d)).toBe(3);
    // Bar 0 is the earliest: rebuilt from raw, but missing from the store.
    expect(d.first).toMatchObject({ time: bar(0).time, theirs: undefined });
  });

  it('labels a field difference with stored as theirs and rebuilt as ours', () => {
    const d = diffBars([bar(0, 5)], [bar(0, 6)]);
    expect(d.first).toMatchObject({ theirs: { close: 6 }, ours: { close: 5 } });
  });

  it('refuses bars out of order', () => {
    expect(() => diffBars([bar(1), bar(0)], [])).toThrow(RebuildDiffError);
    expect(() => diffBars([], [bar(0), bar(0)])).toThrow(RebuildDiffError);
  });
});
