import { describe, expect, it } from 'vitest';

import { assertCoherent, BarError } from './bar.js';
import type { Bar } from './bar.js';
import { barTimeFromUtcParts } from './bar-time.js';
import { parseScaled, price, volume } from './scaled.js';

function bar(open: string, high: string, low: string, close: string, vol: string): Bar {
  return {
    time: barTimeFromUtcParts(2024, 1, 16, 14, 30, 0),
    open: price(parseScaled(open, 2)),
      high: price(parseScaled(high, 2)),
    low: price(parseScaled(low, 2)),
    close: price(parseScaled(close, 2)),
    volume: volume(parseScaled(vol, 0)),
  };
}

describe('assertCoherent', () => {
  it('accepts a well-formed bar', () => {
    expect(() => assertCoherent(bar('191.20', '192.05', '190.88', '191.95', '12345'))).not.toThrow();
  });

  it('accepts a flat bar, where all four prices are equal', () => {
    expect(() => assertCoherent(bar('191.20', '191.20', '191.20', '191.20', '0'))).not.toThrow();
  });

  it('rejects a high below the low', () => {
    expect(() => assertCoherent(bar('191.20', '190.00', '191.00', '191.00', '1'))).toThrow(BarError);
  });

  it('rejects a high that is not the highest price', () => {
    // The classic rollup bug: high taken from one source, close from another.
    expect(() => assertCoherent(bar('191.20', '191.50', '190.00', '192.00', '1'))).toThrow(BarError);
    expect(() => assertCoherent(bar('193.00', '191.50', '190.00', '191.00', '1'))).toThrow(BarError);
  });

  it('rejects a low that is not the lowest price', () => {
    expect(() => assertCoherent(bar('191.20', '192.00', '191.00', '190.00', '1'))).toThrow(BarError);
    expect(() => assertCoherent(bar('190.50', '192.00', '191.00', '191.50', '1'))).toThrow(BarError);
  });
});
