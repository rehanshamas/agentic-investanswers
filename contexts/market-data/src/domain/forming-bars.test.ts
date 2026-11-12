import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { FormingBars } from './forming-bars.js';
import type { LiveBarUpdate } from './live-update.js';
import { rollUp } from './roll-up.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const ROLLUPS: readonly Timeframe[] = ['5m', '15m', '1h', '4h'];
const T0 = barTimeFromUtcParts(2026, 11, 12, 11, 52); // 8 minutes before a 4h boundary

/** A pseudo-random but repeatable minute: prices wander so open, high, low and close all matter. */
function minute(i: number, extra = 0): Bar {
  const base = 7_000_000 + ((i * 7_919) % 5_000) + extra;
  return {
    time: barTime(T0 + i * 60),
    open: price(base),
    high: price(base + 40 + (i % 7) + extra),
    low: price(base - 30 - (i % 5)),
    close: price(base + 10 - (i % 11)),
    volume: volume(100_000_000 + i * 1_234 + extra),
  };
}

/** What the store gives after cooking `upTo`: every bar its minute touched, from all stored minutes. */
function rebuilt(stored: readonly Bar[], upTo: Bar): Map<Timeframe, Bar[]> {
  const result = new Map<Timeframe, Bar[]>();
  for (const tf of ROLLUPS) {
    const period = alignToTimeframe(BTC, tf, upTo.time);
    result.set(tf, rollUp(BTC, tf, stored).filter((b) => b.time === period));
  }
  return result;
}

/** The truth: each timeframe's bar over every minute known, stored or not. */
function expected(known: readonly Bar[], unstored: readonly Bar[]): LiveBarUpdate[] {
  const all = [...known, ...unstored];
  const out: LiveBarUpdate[] = unstored.map((bar) => ({ symbol: 'BTCUSD', timeframe: '1m', bar, forming: true }));
  for (const tf of ROLLUPS) {
    const periods = new Set(unstored.map((m) => alignToTimeframe(BTC, tf, m.time)));
    for (const bar of rollUp(BTC, tf, all)) if (periods.has(bar.time)) out.push({ symbol: 'BTCUSD', timeframe: tf, bar, forming: true });
  }
  return out;
}

describe('FormingBars', () => {
  it('forms only the 1m bar until the first minute is cooked', () => {
    const forming = new FormingBars(BTC, ROLLUPS);
    expect(forming.unstoredChanged([minute(0)])).toEqual([{ symbol: 'BTCUSD', timeframe: '1m', bar: minute(0), forming: true }]);
  });

  it('matches a roll-up of every known minute at each step, through the race between storing and cooking, across a 4h boundary', () => {
    const forming = new FormingBars(BTC, ROLLUPS);
    // Minutes stored before this process started: the store's cooked bars hold them.
    const stored: Bar[] = [0, 1, 2].map((i) => minute(i));
    let cookedUpTo = 2;
    forming.cooked(minute(2), rebuilt(stored, minute(2)));

    for (let i = 3; i < 20; i++) {
      // Trades arrive: the forming minute grows twice.
      expect(forming.unstoredChanged([minute(i)])).toEqual(expected(stored, [minute(i)]));
      expect(forming.unstoredChanged([minute(i, 5)])).toEqual(expected(stored, [minute(i, 5)]));
      // Minute i closes; i+1 forms while i is still being written.
      expect(forming.unstoredChanged([minute(i, 5), minute(i + 1)])).toEqual(expected(stored, [minute(i, 5), minute(i + 1)]));
      // i is stored (its final value may differ from the last forming one: a late trade).
      const final = minute(i, 6);
      forming.stored(final);
      stored.push(final);
      // i+1 keeps forming before i is cooked: i comes from the uncooked minutes.
      expect(forming.unstoredChanged([minute(i + 1, 1)])).toEqual(expected(stored, [minute(i + 1, 1)]));
      // Cooking sometimes lags by two minutes.
      if (i % 3 === 0) continue;
      for (const m of stored.filter((b) => b.time > T0 + cookedUpTo * 60)) {
        const updates = forming.cooked(m, rebuilt(stored.filter((b) => b.time <= m.time), m));
        // Stored first, then the forming bars on top of them.
        const stores = updates.filter((u) => !u.forming);
        expect(stores.map((u) => [u.timeframe, u.bar.time])).toEqual(
          ['1m', ...ROLLUPS].map((tf) => [tf, alignToTimeframe(BTC, tf as Timeframe, m.time)]),
        );
        expect(updates.slice(stores.length)).toEqual(expected(stored, [minute(i + 1, 1)]));
        cookedUpTo = (m.time - T0) / 60;
      }
    }
  });

  it('stops forming once the stream drops', () => {
    const forming = new FormingBars(BTC, ROLLUPS);
    forming.cooked(minute(0), rebuilt([minute(0)], minute(0)));
    expect(forming.unstoredChanged([minute(1)])).toHaveLength(5);
    forming.reset();
    expect(forming.cooked(minute(0), rebuilt([minute(0)], minute(0))).filter((u) => u.forming)).toEqual([]);
  });

  it('never counts a minute twice if a stale report still lists a stored one', () => {
    const forming = new FormingBars(BTC, ROLLUPS);
    forming.cooked(minute(0), rebuilt([minute(0)], minute(0)));
    forming.stored(minute(1, 3));
    const updates = forming.unstoredChanged([minute(1), minute(2)]);
    expect(updates).toEqual(expected([minute(0), minute(1, 3)], [minute(2)]));
  });
});
