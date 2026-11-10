import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { formatRebuildReport, rebuildPassed, totalDifferences } from '../adapters/rebuild-report.js';
import { partitionOf } from '../domain/cooked-partition.js';
import { CookIntraday } from './cook-intraday.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';
import { RebuildCheck } from './rebuild-check.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};

class MemorySource implements OneMinuteBarSourcePort {
  constructor(public bars: Bar[]) {}
  read(_s: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    return Promise.resolve(this.bars.filter((b) => b.time >= from && b.time <= until));
  }
}

/** S3 semantics: `put` replaces each touched partition whole. Records writes. */
class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();
  puts = 0;

  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    this.puts++;
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.files.set(key, group);
    return Promise.resolve();
  }
  getRange(): Promise<Bar[]> {
    return Promise.resolve([]);
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.files.get(`${symbol}/${timeframe}/${partition}`));
  }
}

/** Minutes either side of the 2025-01 month end, with a gap minute. */
function minutes(): Bar[] {
  const start = barTimeFromUtcParts(2025, 1, 31, 22, 0);
  const bars: Bar[] = [];
  for (let i = 0; i < 4 * 60; i++) {
    if (i === 7) continue; // a minute with no trades: no bar
    const p = price(parseScaled((100 + (i % 9)).toFixed(2), 2));
    bars.push({ time: barTime(start + i * 60), open: p, high: p, low: p, close: p, volume: volume(parseScaled('0.1', 8)) });
  }
  return bars;
}

const MONTHS = ['2025-01', '2025-02'];
let source: MemorySource;
let store: PartitionStore;

async function cookAll(): Promise<void> {
  const cook = new CookIntraday({ source, store });
  for (const month of MONTHS) await cook.cookPartition(BTC, month);
}

function check(): ReturnType<RebuildCheck['run']> {
  return new RebuildCheck({ source, store }).run(BTC, MONTHS);
}

beforeEach(() => {
  source = new MemorySource(minutes());
  store = new PartitionStore();
});

describe('RebuildCheck', () => {
  it('finds 0 differences after a clean cook, across a month end, and writes nothing', async () => {
    await cookAll();
    const putsBefore = store.puts;
    const results = await check();
    expect(store.puts).toBe(putsBefore);
    // 4 timeframes × 2 months.
    expect(results).toHaveLength(8);
    expect(totalDifferences(results)).toBe(0);
    expect(rebuildPassed(results)).toBe(true);
    expect(formatRebuildReport(results, [BTC])).toContain('REBUILD CHECK OK: 0 differences across 8 partition files.');
  });

  it('finds a changed stored bar and names it, with stored above rebuilt', async () => {
    await cookAll();
    const key = 'BTCUSD/15m/2025-02';
    const file = store.files.get(key);
    const bar = file?.[1];
    if (file === undefined || bar === undefined) throw new Error('nothing cooked');
    file[1] = { ...bar, high: price(bar.high + 1) };

    const results = await check();
    const report = formatRebuildReport(results, [BTC]);
    expect(totalDifferences(results)).toBe(1);
    expect(report).toContain('BTCUSD 15m 2025-02: first difference at 2025-02-01 00:15 UTC');
    expect(report).toMatch(/\n\s+stored\s.*\n\s+rebuilt\s/);
    expect(report).toContain('REBUILD CHECK FAILED: 1 differences');
  });

  it('finds a month that was never cooked', async () => {
    await cookAll();
    store.files.delete('BTCUSD/1h/2025-01');
    const results = await check();
    expect(results.find((r) => r.timeframe === '1h' && r.partition === '2025-01')).toMatchObject({
      kind: 'not-cooked',
      diff: { missingFromStore: 2 },
    });
    expect(formatRebuildReport(results, [BTC])).toContain('NOT COOKED');
  });

  it('finds a cooked file with no raw behind it', async () => {
    await cookAll();
    source = new MemorySource(minutes().filter((b) => b.time >= barTimeFromUtcParts(2025, 2, 1)));
    const results = await check();
    const orphan = results.filter((r) => r.partition === '2025-01');
    expect(orphan.every((r) => r.kind === 'no-raw')).toBe(true);
    expect(rebuildPassed(results)).toBe(false);
  });

  it('finds a stored bar that raw cannot produce', async () => {
    await cookAll();
    const file = store.files.get('BTCUSD/5m/2025-02');
    const last = file?.[file.length - 1];
    if (file === undefined || last === undefined) throw new Error('nothing cooked');
    file.push({ ...last, time: barTime(last.time + 300) });
    const results = await check();
    expect(results.find((r) => r.timeframe === '5m' && r.partition === '2025-02')?.diff).toMatchObject({
      notRebuildable: 1,
    });
  });

  it('is never a pass with nothing to check', async () => {
    source = new MemorySource([]);
    const results = await check();
    expect(results).toEqual([]);
    expect(rebuildPassed(results)).toBe(false);
    expect(formatRebuildReport(results, [BTC])).toContain('nothing to check');
  });
});
