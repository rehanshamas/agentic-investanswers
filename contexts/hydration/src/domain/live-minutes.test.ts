import type { BarTime } from '@aia/shared-kernel';
import { barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { LiveTrade } from './live-minutes.js';
import { LiveMinutesError, MinuteBuilder, minuteOf, splitGapByDay } from './live-minutes.js';

const T0 = barTimeFromUtcParts(2026, 11, 10, 12, 0) * 1000; // 12:00:00.000 UTC, ms
const at = (minute: number, second: number, ms = 0): number => T0 + minute * 60_000 + second * 1000 + ms;
const sec = (ms: number): BarTime => minuteOf(ms);

let seq = 0;
function trade(timeMs: number, p: number, size = 1, s = ++seq): LiveTrade {
  return { timeMs, seq: s, price: price(p), size: volume(size) };
}

/** A builder already running from 12:00 (resumed exactly on the minute). */
function running(): MinuteBuilder {
  const builder = new MinuteBuilder();
  builder.resume(T0);
  return builder;
}

describe('MinuteBuilder', () => {
  it('builds OHLCV from the trades of one minute, in trade order', () => {
    const b = running();
    b.add(trade(at(0, 1), 100, 2));
    b.add(trade(at(0, 20), 105, 3));
    b.add(trade(at(0, 40), 95, 1));
    b.add(trade(at(0, 59, 999), 101, 4));

    const bars = b.closeDue(at(1, 2), 2000);
    expect(bars).toEqual([
      { time: sec(at(0, 0)), open: 100, high: 105, low: 95, close: 101, volume: 10 },
    ]);
  });

  it('buckets by trade time, so a trade on the boundary opens the next minute', () => {
    const b = running();
    b.add(trade(at(0, 59, 999), 100));
    b.add(trade(at(1, 0, 0), 200));
    const bars = b.closeDue(at(2, 5), 2000);
    expect(bars.map((x) => [x.time, x.open])).toEqual([
      [sec(at(0, 0)), 100],
      [sec(at(1, 0)), 200],
    ]);
  });

  it('waits out the grace period, then refuses a trade for the closed minute as late', () => {
    const b = running();
    b.add(trade(at(0, 30), 100));
    expect(b.closeDue(at(1, 1, 999), 2000)).toEqual([]); // 1.999 s past the end: still open
    expect(b.add(trade(at(0, 59), 110))).toBe('added'); // arrived late but within grace
    expect(b.closeDue(at(1, 2), 2000)).toHaveLength(1);
    expect(b.add(trade(at(0, 59, 500), 120))).toBe('late');
  });

  it('gives no bar for a minute with no trades, and still refuses a late trade for it', () => {
    const b = running();
    b.add(trade(at(0, 10), 100));
    b.add(trade(at(2, 10), 100));
    const bars = b.closeDue(at(3, 5), 2000);
    expect(bars.map((x) => x.time)).toEqual([sec(at(0, 0)), sec(at(2, 0))]);
    expect(b.add(trade(at(1, 30), 100))).toBe('late');
  });

  it('takes open and close by trade order when trades arrive out of order, and ignores repeats', () => {
    const b = running();
    b.add(trade(at(0, 30), 103, 1, 3));
    b.add(trade(at(0, 10), 101, 1, 1));
    b.add(trade(at(0, 50), 104, 1, 4));
    b.add(trade(at(0, 20), 102, 1, 2));
    expect(b.add(trade(at(0, 20), 102, 1, 2))).toBe('duplicate');
    const [bar] = b.closeDue(at(1, 5), 2000);
    expect(bar).toMatchObject({ open: 101, close: 104, volume: 4 });
  });

  it('skips the partial minute it starts in', () => {
    const b = new MinuteBuilder();
    expect(b.resume(at(0, 25))).toBe(sec(at(1, 0)));
    expect(b.add(trade(at(0, 26), 100))).toBe('partial');
    expect(b.add(trade(at(1, 0), 100))).toBe('added');
  });

  it('refuses trades before it is started', () => {
    expect(() => new MinuteBuilder().add(trade(at(0, 1), 100))).toThrow(LiveMinutesError);
  });

  it('discards partial minutes on a disconnect and says where the gap starts', () => {
    const b = running();
    b.add(trade(at(0, 10), 100));
    expect(b.closeDue(at(1, 3), 2000)).toHaveLength(1); // 12:00 closed and written
    b.add(trade(at(1, 30), 100)); // 12:01 forming when the stream drops
    expect(b.interrupt()).toBe(sec(at(1, 0)));
    expect(b.running).toBe(false);
    // Resumed at 12:03:40: 12:01 to 12:03 are the gap, 12:04 is the first whole minute.
    expect(b.resume(at(3, 40))).toBe(sec(at(4, 0)));
    expect(b.closeDue(at(5, 5), 2000)).toEqual([]);
  });

  it('has no gap start if it never ran', () => {
    expect(new MinuteBuilder().interrupt()).toBeUndefined();
  });
});

describe('MinuteBuilder forming minutes (M2-04)', () => {
  it('reports the forming minute only when it changed, and it converges on the stored bar', () => {
    const b = running();
    expect(b.takeForming()).toBeUndefined();
    b.add(trade(at(0, 1), 100, 2));
    expect(b.takeForming()).toEqual([{ time: sec(at(0, 0)), open: 100, high: 100, low: 100, close: 100, volume: 2 }]);
    expect(b.takeForming()).toBeUndefined(); // nothing new
    b.add(trade(at(0, 30), 105, 3));
    b.add(trade(at(0, 50), 95, 1));
    const forming = b.takeForming();
    expect(forming).toEqual([{ time: sec(at(0, 0)), open: 100, high: 105, low: 95, close: 95, volume: 6 }]);
    expect(b.closeDue(at(1, 2), 2000)).toEqual(forming);
  });

  it('reports a repeated trade as no change', () => {
    const b = running();
    b.add(trade(at(0, 1), 100, 1, 7));
    b.takeForming();
    expect(b.add(trade(at(0, 1), 100, 1, 7))).toBe('duplicate');
    expect(b.takeForming()).toBeUndefined();
  });

  it('reports both minutes during the grace, ascending, and drops a minute once it closes', () => {
    const b = running();
    b.add(trade(at(0, 59), 100));
    b.add(trade(at(1, 0, 500), 200));
    expect(b.takeForming()?.map((x) => [x.time, x.close])).toEqual([
      [sec(at(0, 0)), 100],
      [sec(at(1, 0)), 200],
    ]);
    b.add(trade(at(0, 59, 900), 110)); // late but within grace: still the 12:00 minute
    expect(b.closeDue(at(1, 2), 2000).map((x) => x.close)).toEqual([110]);
    b.add(trade(at(1, 3), 210));
    expect(b.takeForming()?.map((x) => [x.time, x.close])).toEqual([[sec(at(1, 0)), 210]]);
  });

  it('never forms a partial minute, and forgets forming minutes on a disconnect', () => {
    const b = new MinuteBuilder();
    b.resume(at(0, 25));
    b.add(trade(at(0, 26), 100)); // partial: refused
    expect(b.takeForming()).toBeUndefined();
    b.add(trade(at(1, 5), 101));
    b.interrupt();
    expect(b.takeForming()).toBeUndefined();
    b.resume(at(2, 30));
    expect(b.takeForming()).toBeUndefined();
  });
});

describe('splitGapByDay', () => {
  it('splits a gap across UTC midnight', () => {
    const from = barTimeFromUtcParts(2026, 11, 10, 23, 58);
    const until = barTimeFromUtcParts(2026, 11, 11, 0, 3);
    expect(splitGapByDay({ from, until })).toEqual([
      { date: '2026-11-10', gap: { from, until: barTimeFromUtcParts(2026, 11, 11) } },
      { date: '2026-11-11', gap: { from: barTimeFromUtcParts(2026, 11, 11), until } },
    ]);
  });

  it('is empty for an empty gap', () => {
    const t = barTimeFromUtcParts(2026, 11, 10, 1, 0);
    expect(splitGapByDay({ from: t, until: t })).toEqual([]);
  });
});
