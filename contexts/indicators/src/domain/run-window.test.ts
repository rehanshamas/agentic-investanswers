import { barTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { RUN_WINDOW_BARS, runStart } from './run-window.js';

describe('runStart', () => {
  const block = RUN_WINDOW_BARS * 60;
  const blockStart = 1_731_000_000 - (1_731_000_000 % block);

  it('starts at the beginning of the previous block, so a run covers one to two blocks of bars', () => {
    for (const offset of [0, 60, block / 2, block - 60]) {
      const newest = barTime(blockStart + offset);
      expect(runStart('1m', newest)).toBe(blockStart - block);
      const bars = (newest - runStart('1m', newest)) / 60 + 1;
      expect(bars).toBeGreaterThan(RUN_WINDOW_BARS);
      expect(bars).toBeLessThanOrEqual(2 * RUN_WINDOW_BARS);
    }
  });

  it('is the same for every newest bar within one block, and moves once per block', () => {
    expect(runStart('1m', barTime(blockStart + 60))).toBe(runStart('1m', barTime(blockStart + block - 60)));
    expect(runStart('1m', barTime(blockStart + block))).toBe(blockStart);
  });

  it('scales with the timeframe', () => {
    const newest = barTime(1_731_000_000 - (1_731_000_000 % 3_600));
    const start = runStart('1h', newest);
    expect((newest - start) / 3_600).toBeGreaterThanOrEqual(RUN_WINDOW_BARS);
    expect((newest - start) / 3_600).toBeLessThan(2 * RUN_WINDOW_BARS);
  });

  it('covers all history on daily and longer timeframes (clamped to 1990)', () => {
    expect(runStart('1W', barTime(1_731_000_000 - (1_731_000_000 % 86_400)))).toBe(631_152_000);
    expect(runStart('1M', barTime(1_730_419_200))).toBe(631_152_000);
  });
});
