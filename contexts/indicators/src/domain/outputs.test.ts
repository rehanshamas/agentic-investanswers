import { barTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';
import type { OutputSpec } from './outputs.js';
import { OutputError, toDrawn } from './outputs.js';

const t = barTime(1_731_000_000 - (1_731_000_000 % 60));
const specs: OutputSpec[] = [
  { kind: 'line', key: 'basis', label: 'Basis' },
  { kind: 'band', key: 'channel', label: 'Channel' },
  { kind: 'marker', key: 'signal', label: 'Signal' },
  { kind: 'level', key: 'stop', label: 'Stop' },
];

describe('toDrawn', () => {
  it('rounds every value to display precision', () => {
    const point = toDrawn(
      specs,
      t,
      {
        basis: 60123.456789,
        channel: { upper: 60200.005, lower: 59999.994 },
        signal: { side: 'above', price: 60250.129, text: 'Sell' },
        stop: 59000.1,
      },
      2,
    );
    expect(point).toEqual({
      time: t,
      values: {
        basis: 60123.46,
        channel: { upper: 60200.01, lower: 59999.99 },
        signal: { side: 'above', price: 60250.13, text: 'Sell' },
        stop: 59000.1,
      },
    });
  });

  it('keeps only declared outputs, so internal values never leave', () => {
    const point = toDrawn(specs, t, { basis: 1, secretState: 123, trueRange: 4.56 }, 2);
    expect(Object.keys(point.values).sort()).toEqual(['basis', 'channel', 'signal', 'stop']);
    expect(JSON.stringify(point)).not.toContain('123');
  });

  it('draws nothing for missing values, null and NaN (warm-up)', () => {
    const point = toDrawn(specs, t, { basis: Number.NaN, channel: null }, 2);
    expect(point.values).toEqual({ basis: null, channel: null, signal: null, stop: null });
  });

  it.each([
    [1.005, 1.01],
    [1.255, 1.26],
    [0.145, 0.15],
    [60200.005, 60200.01],
    [-1.005, -1],
    [-1.006, -1.01],
    [2.675, 2.68],
    [123.4549999, 123.45],
  ])('rounds %d to the tick as %d (half ticks go up)', (raw, drawn) => {
    expect(toDrawn(specs, t, { basis: raw }, 2).values.basis).toBe(drawn);
  });

  it('cuts long marker labels, so they cannot carry internal values out', () => {
    const point = toDrawn(specs, t, { signal: { side: 'above', price: 1, text: 'Buy @ atr=123.4567 state=9' } }, 2);
    expect(point.values.signal).toEqual({ side: 'above', price: 1, text: 'Buy @ atr=123.45' });
  });

  it('never draws minus zero', () => {
    expect(Object.is(toDrawn(specs, t, { basis: -0.001 }, 2).values.basis, 0)).toBe(true);
  });

  it('drops extra fields from markers and bands', () => {
    const raw = {
      channel: { upper: 2, lower: 1, width: 1 },
      signal: { side: 'below', price: 1, internal: 9 },
    } as unknown as Record<string, null>;
    expect(toDrawn(specs, t, raw, 2).values).toMatchObject({
      channel: { upper: 2, lower: 1 },
      signal: { side: 'below', price: 1 },
    });
    expect(toDrawn(specs, t, raw, 2).values.channel).not.toHaveProperty('width');
    expect(toDrawn(specs, t, raw, 2).values.signal).not.toHaveProperty('internal');
  });

  it.each([
    ['infinity on a line', { basis: Number.POSITIVE_INFINITY }],
    ['a band given as a number', { channel: 5 }],
    ['a line given as an object', { basis: { upper: 1, lower: 0 } }],
    ['a marker with no side', { signal: { price: 1 } }],
  ])('throws on %s, a bug in the indicator', (_, raw) => {
    expect(() => toDrawn(specs, t, raw as never, 2)).toThrow(OutputError);
  });
});
