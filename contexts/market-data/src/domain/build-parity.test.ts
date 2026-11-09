import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { BUILD_SOURCES, buildParity, buildSource } from './build-parity.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};

const T0 = 1_767_225_600; // 2026-01-01 00:00 UTC

/** Minute `i` after T0, with a price that moves so OHLC are distinguishable. */
function minute(i: number): Bar {
  const base = 10_000 + ((i * 37) % 50);
  return {
    time: barTime(T0 + i * 60),
    open: price(base),
    high: price(base + 5),
    low: price(base - 5),
    close: price(base + 1),
    volume: volume(100 + i),
  };
}

function minutes(from: number, to: number): Bar[] {
  return Array.from({ length: to - from }, (_, k) => minute(from + k));
}

/** What a correct 5m export holds for minutes [from, to): an independent sum. */
function expected5m(from: number, to: number): Bar[] {
  const bars: Bar[] = [];
  for (let start = from - (from % 5); start < to; start += 5) {
    const group = minutes(Math.max(start, from), Math.min(start + 5, to));
    const first = group[0];
    const last = group[group.length - 1];
    if (first === undefined || last === undefined) continue;
    bars.push({
      time: barTime(T0 + start * 60),
      open: first.open,
      high: price(Math.max(...group.map((b) => b.high))),
      low: price(Math.min(...group.map((b) => b.low))),
      close: last.close,
      volume: volume(group.reduce((sum, b) => sum + b.volume, 0)),
    });
  }
  return bars;
}

function at(i: number): BarTime {
  return barTime(T0 + i * 60);
}

describe('buildParity', () => {
  it('is exact when our rollup of the finer export equals the coarser one', () => {
    const result = buildParity(BTC, '5m', minutes(0, 60), expected5m(0, 60));
    // 12 buckets; the last holds the source's final minute and is dropped.
    expect(result).toMatchObject({ status: 'exact', matched: 11, differing: 0, missing: 0 });
    expect(result.window).toEqual({ from: at(0), until: at(50), skipped: 0 });
  });

  it('fails on a single differing bar and names it', () => {
    const exported = expected5m(0, 60);
    const target = exported[3];
    if (target === undefined) throw new Error('unreachable');
    exported[3] = { ...target, volume: volume(target.volume + 1) };
    const result = buildParity(BTC, '5m', minutes(0, 60), exported);
    expect(result).toMatchObject({ status: 'differs', differing: 1 });
    expect(result.first).toMatchObject({ time: at(15), fields: ['volume'] });
  });

  it('does not compare a first bar the source only partly covers', () => {
    // The source starts at minute 7, inside the 5..10 bucket.
    const exported = expected5m(0, 60).map((bar, i) => (i === 1 ? { ...bar, high: price(1) } : bar));
    const result = buildParity(BTC, '5m', minutes(7, 60), exported);
    expect(result).toMatchObject({ status: 'exact', matched: 9 });
    expect(result.window?.from).toBe(at(10));
    expect(result.window?.skipped).toBe(2);
  });

  it('does not compare a last bar the source may stop partway through', () => {
    // The source stops at minute 57, inside the 55..60 bucket the export has whole.
    const result = buildParity(BTC, '5m', minutes(0, 58), expected5m(0, 60));
    expect(result).toMatchObject({ status: 'exact', matched: 11 });
    expect(result.window?.until).toBe(at(50));
  });

  it('stays strict inside the window: an export bar we cannot rebuild fails', () => {
    // A gap in the finer export where the coarser one has a bar.
    const source = minutes(0, 60).filter((_, i) => i < 20 || i >= 25);
    const result = buildParity(BTC, '5m', source, expected5m(0, 60));
    expect(result).toMatchObject({ status: 'differs', missing: 1 });
    expect(result.first?.time).toBe(at(20));
  });

  it('has nothing to compare when the source is empty or too short', () => {
    expect(buildParity(BTC, '5m', [], expected5m(0, 60)).status).toBe('no-overlap');
    expect(buildParity(BTC, '5m', minutes(0, 4), expected5m(0, 60)).status).toBe('no-overlap');
  });
});

describe('buildSource', () => {
  it('rebuilds every timeframe but 1m from the next finer export', () => {
    expect(buildSource('1m')).toBeUndefined();
    expect(BUILD_SOURCES).toEqual({
      '5m': '1m', '15m': '5m', '1h': '15m', '4h': '1h', '1D': '1h', '1W': '1D', '1M': '1D',
    });
  });
});
