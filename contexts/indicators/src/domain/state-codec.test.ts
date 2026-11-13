import { describe, expect, it } from 'vitest';

import { decodeState, encodeState } from './state-codec.js';

describe('state codec', () => {
  it('round-trips plain data, keeping NaN and infinities that JSON would turn into null', () => {
    const state = {
      window: [1.5, Number.NaN, 3],
      prev: Number.NaN,
      hi: Number.POSITIVE_INFINITY,
      lo: Number.NEGATIVE_INFINITY,
      label: 'x',
      on: true,
      none: null,
      nested: { deep: [{ v: Number.NaN }] },
    };
    const back = decodeState(encodeState(state)) as typeof state;
    expect(back).toEqual(state);
    expect(Number.isNaN(back.prev)).toBe(true);
    expect(back.hi).toBe(Number.POSITIVE_INFINITY);
  });

  it('round-trips the exact float', () => {
    expect(decodeState(encodeState({ x: 0.1 + 0.2 }))).toEqual({ x: 0.30000000000000004 });
  });
});
