import type { Bar } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  RecentWindowError,
  applyToWindow,
  fillWindow,
  lookbackStart,
  readWindow,
} from './recent-window.js';
import { barClosedEvents } from './bar-closed.js';

const T0 = 1_762_800_000; // 2025-11-10 18:40 UTC, a whole minute
const at = (minute: number) => barTime(T0 + minute * 60);

function bar(minute: number, close = 100): Bar {
  return { time: at(minute), open: price(close), high: price(close), low: price(close), close: price(close), volume: volume(1) };
}

describe('fillWindow', () => {
  it('keeps everything under capacity, from where the store read started', () => {
    const w = fillWindow(at(-5), [bar(0), bar(1)], 3);
    expect(w.from).toBe(at(-5));
    expect(w.bars.map((b) => b.time)).toEqual([at(0), at(1)]);
  });

  it('trims to the newest bars and moves the start up to the oldest kept', () => {
    const w = fillWindow(at(0), [bar(0), bar(1), bar(2), bar(3)], 2);
    expect(w.from).toBe(at(2));
    expect(w.bars.map((b) => b.time)).toEqual([at(2), at(3)]);
  });

  it('refuses bars out of order, before the start, or a bad capacity', () => {
    expect(() => fillWindow(at(0), [bar(1), bar(0)], 5)).toThrow(RecentWindowError);
    expect(() => fillWindow(at(1), [bar(0)], 5)).toThrow(RecentWindowError);
    expect(() => fillWindow(at(0), [], 0)).toThrow(RecentWindowError);
  });
});

describe('applyToWindow', () => {
  const window = fillWindow(at(0), [bar(0), bar(1), bar(2)], 3);

  it('replaces the bar with the same time (a forming bar extended)', () => {
    const w = applyToWindow(window, bar(2, 105), 3);
    expect(w.bars.map((b) => b.close)).toEqual([100, 100, 105]);
    expect(w.from).toBe(at(0));
  });

  it('appends a newer bar and trims, moving the start', () => {
    const w = applyToWindow(window, bar(3), 3);
    expect(w.bars.map((b) => b.time)).toEqual([at(1), at(2), at(3)]);
    expect(w.from).toBe(at(1));
  });

  it('inserts a late bar in order', () => {
    const gappy = fillWindow(at(0), [bar(0), bar(2)], 5);
    expect(applyToWindow(gappy, bar(1), 5).bars.map((b) => b.time)).toEqual([at(0), at(1), at(2)]);
  });

  it('ignores a bar older than the window, which it does not cover', () => {
    const w = fillWindow(at(5), [bar(5)], 5);
    expect(applyToWindow(w, bar(4), 5)).toBe(w);
  });
});

describe('readWindow', () => {
  const window = fillWindow(at(0), [bar(0), bar(1), bar(3), bar(4)], 10);

  it('answers when it holds enough bars', () => {
    expect(readWindow(window, 2, undefined, at(-100))?.map((b) => b.time)).toEqual([at(3), at(4)]);
    expect(readWindow(window, 2, at(4), at(-100))?.map((b) => b.time)).toEqual([at(1), at(3)]);
  });

  it('answers with fewer bars when it covers the whole lookback a store read would', () => {
    expect(readWindow(window, 9, undefined, at(0))?.length).toBe(4);
  });

  it('cannot answer when the store could hold older bars it lacks', () => {
    expect(readWindow(window, 9, undefined, at(-5))).toBeUndefined();
    expect(readWindow(window, 2, at(1), at(-1))).toBeUndefined();
  });
});

describe('lookbackStart', () => {
  it('reaches back limit timeframe lengths, inclusive of the newest', () => {
    expect(lookbackStart('5m', at(10), 2)).toBe(barTime(T0 + 600 - 600 + 1));
    expect(lookbackStart('1D', barTime(T0), 1)).toBe(barTime(T0 - 86_400 + 1));
  });

  it('never goes before 1990', () => {
    expect(lookbackStart('1M', barTime(T0), 1_000)).toBe(barTime(631_152_000));
  });
});

describe('barClosedEvents', () => {
  it('lists the minute first, then each rebuilt bar shortest first', () => {
    const events = barClosedEvents('BTCUSD', bar(4), new Map([['5m', [bar(0)]], ['15m', [bar(0)]]]));
    expect(events.map((e) => e.timeframe)).toEqual(['1m', '5m', '15m']);
    expect(events.every((e) => e.symbol === 'BTCUSD')).toBe(true);
  });
});
