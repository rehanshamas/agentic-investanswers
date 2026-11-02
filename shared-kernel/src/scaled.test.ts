import { describe, expect, it } from 'vitest';

import {
  formatScaled,
  parseScaled,
  price,
  ScaledNumberError,
  sumVolume,
  volume,
} from './scaled.js';

describe('parseScaled', () => {
  it('reads prices exactly at the instrument scale', () => {
    expect(parseScaled('191.20', 2)).toBe(19120);
    expect(parseScaled('191.2', 2)).toBe(19120);
    expect(parseScaled('191', 2)).toBe(19100);
    expect(parseScaled('0.00', 2)).toBe(0);
  });

  it('avoids the floating-point error a multiply would introduce', () => {
    // `Number('1.005') * 100` is 100.49999999999999, which rounds to 100 and
    // loses a tick. String surgery gives the exact 1005 tenths-of-a-cent.
    expect(parseScaled('1.005', 3)).toBe(1005);
    expect(parseScaled('0.07', 2)).toBe(7);
    expect(parseScaled('8.165', 3)).toBe(8165);
  });

  it('reads crypto volumes at 8 decimal places', () => {
    expect(parseScaled('0.00000001', 8)).toBe(1);
    expect(parseScaled('12.34567891', 8)).toBe(1234567891);
  });

  it('allows trailing zeros beyond the scale, because they lose nothing', () => {
    expect(parseScaled('191.2000', 2)).toBe(19120);
  });

  it('refuses to round away real precision', () => {
    // Silently rounding here is exactly how an exact parity check would start
    // failing for a reason nobody can find.
    expect(() => parseScaled('191.205', 2)).toThrow(ScaledNumberError);
    expect(() => parseScaled('0.000000001', 8)).toThrow(ScaledNumberError);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['', 'abc', '1.2.3', '1e5', 'NaN', '0x10', '1,000.00']) {
      expect(() => parseScaled(bad, 2)).toThrow(ScaledNumberError);
    }
  });

  it('rejects an impossible scale', () => {
    expect(() => parseScaled('1.00', -1)).toThrow(ScaledNumberError);
    expect(() => parseScaled('1.00', 1.5)).toThrow(ScaledNumberError);
    expect(() => parseScaled('1.00', 20)).toThrow(ScaledNumberError);
  });
});

describe('formatScaled', () => {
  it('round-trips with parseScaled', () => {
    for (const [text, scale] of [
      ['191.20', 2],
      ['0.00000001', 8],
      ['12.34567891', 8],
      ['1.005', 3],
    ] as const) {
      expect(formatScaled(parseScaled(text, scale), scale)).toBe(text);
    }
  });

  it('pads values smaller than one unit', () => {
    expect(formatScaled(7, 2)).toBe('0.07');
    expect(formatScaled(1, 8)).toBe('0.00000001');
  });

  it('writes whole numbers at scale 0', () => {
    expect(formatScaled(12345, 0)).toBe('12345');
  });
});

describe('price and volume', () => {
  it('accepts whole scaled units', () => {
    expect(price(19120)).toBe(19120);
    expect(volume(0)).toBe(0);
  });

  it('rejects fractional scaled units, which mean the wrong scale was used', () => {
    expect(() => price(191.2)).toThrow(ScaledNumberError);
    expect(() => volume(0.5)).toThrow(ScaledNumberError);
  });

  it('rejects negative volume', () => {
    expect(() => volume(-1)).toThrow(ScaledNumberError);
  });
});

describe('sumVolume', () => {
  it('adds a month of minutes exactly, where floats would drift', () => {
    // 0.1 + 0.2 as decimals is 0.30000000000000004. At scale 8 these are whole
    // numbers, so the total is exact.
    const tenth = volume(parseScaled('0.1', 8));
    const fifth = volume(parseScaled('0.2', 8));
    expect(sumVolume([tenth, fifth])).toBe(parseScaled('0.3', 8));

    const minutes = Array.from({ length: 44_640 }, () => tenth); // 31 days
    expect(sumVolume(minutes)).toBe(44_640 * 10_000_000);
  });

  it('is zero for no bars', () => {
    expect(sumVolume([])).toBe(0);
  });

  it('fails loudly rather than losing the low digits', () => {
    const huge = volume(Number.MAX_SAFE_INTEGER - 1);
    expect(() => sumVolume([huge, huge])).toThrow(ScaledNumberError);
  });
});
