import { TIMEFRAMES } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { periodOf, timeframeOf, toKLine } from './periods.js';

describe('periods', () => {
  it.each(TIMEFRAMES)('maps %s to a chart period and back', (tf) => {
    expect(timeframeOf(periodOf(tf))).toBe(tf);
  });

  it('refuses a period that is not one of our timeframes', () => {
    expect(timeframeOf({ type: 'minute', span: 3 })).toBeUndefined();
  });

  it('turns bar time in seconds into chart time in milliseconds', () => {
    expect(toKLine({ time: 1_762_800_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })).toEqual({
      timestamp: 1_762_800_000_000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 10,
    });
  });
});
