// M1-09's done-check: a test deletes minutes; they are found, re-fetched and
// re-cooked. In memory, end to end through the real use cases.

import type { HistoryProviderPort, RawDayRef } from '@aia/hydration';
import { RawDayAlreadyStoredError, RawMinuteSource, assertStorableFill, dayStart, mergeDay } from '@aia/hydration';
import type { CookedBarStorePort } from '@aia/market-data';
import { BTCUSD, CookIntraday, RebuildCheck, partitionOf, rebuildPassed } from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, nyseCalendar, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { repairAndRecook } from './repair-and-recook.js';

function day(date: string): Bar[] {
  const start = dayStart(date);
  return Array.from({ length: 1440 }, (_, i) => {
    const p = price(10_000_00 + (i % 37) * 100);
    return { time: barTime(start + i * 60), open: p, high: p, low: p, close: p, volume: volume(1_000_000 + i) };
  });
}

class MemoryRaw {
  readonly days = new Map<string, Bar[]>();
  readonly fills = new Map<string, Bar[][]>();
  private key(ref: RawDayRef): string {
    return `${ref.provider}/${ref.symbol}/${ref.date}`;
  }
  hasDay(ref: RawDayRef): Promise<boolean> {
    return Promise.resolve(this.days.has(this.key(ref)));
  }
  putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    if (this.days.has(this.key(ref))) return Promise.reject(new RawDayAlreadyStoredError(ref));
    this.days.set(this.key(ref), [...bars]);
    return Promise.resolve();
  }
  getDay(ref: RawDayRef): Promise<Bar[] | undefined> {
    const stored = this.days.get(this.key(ref));
    if (stored === undefined) return Promise.resolve(undefined);
    return Promise.resolve(mergeDay(ref.date, [stored, ...(this.fills.get(this.key(ref)) ?? [])]));
  }
  async putFill(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    assertStorableFill(ref.date, (await this.getDay(ref)) ?? [], bars);
    this.fills.set(this.key(ref), [...(this.fills.get(this.key(ref)) ?? []), [...bars]]);
  }
}

/** Cooked store with S3's semantics: put replaces each touched partition whole. */
class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
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

class Provider implements HistoryProviderPort {
  readonly name = 'coinbase';
  fetchDay(_i: Instrument, date: string): Promise<Bar[]> {
    return Promise.resolve(day(date));
  }
}

describe('gap repair, end to end (M1-09 done-check)', () => {
  it('finds deleted minutes, re-fetches them, and re-cooks the month', async () => {
    const raw = new MemoryRaw();
    const minutes = new RawMinuteSource(raw, () => 'coinbase');
    const cooked = new PartitionStore();
    const calendar = nyseCalendar();
    const ref = (date: string): RawDayRef => ({ provider: 'coinbase', symbol: 'BTCUSD', date });

    // Two stored days; 2 March loses 20 minutes (10:00-10:19 UTC).
    const deleted = (b: Bar): boolean =>
      b.time >= barTimeFromUtcParts(2026, 3, 2, 10, 0) && b.time < barTimeFromUtcParts(2026, 3, 2, 10, 20);
    await raw.putDay(ref('2026-03-01'), day('2026-03-01'));
    await raw.putDay(ref('2026-03-02'), day('2026-03-02').filter((b) => !deleted(b)));

    // Cook the month as it stands: the 10:00 hour is built from 40 minutes.
    await new CookIntraday({ source: minutes, store: cooked, calendar }).cookPartition(BTCUSD, '2026-03');
    const hourBefore = (await cooked.getPartition('BTCUSD', '1h', '2026-03'))?.find(
      (b) => b.time === barTimeFromUtcParts(2026, 3, 2, 10, 0),
    );

    const { report, recooked } = await repairAndRecook(
      { provider: new Provider(), raw, calendar, minutes, cooked },
      BTCUSD,
      { from: '2026-03-01', until: '2026-03-02', now: barTimeFromUtcParts(2026, 3, 3, 12, 0) },
    );

    // Found and re-fetched.
    expect(report.days).toEqual([{ date: '2026-03-02', holes: 20, filled: 20, confirmedEmpty: 0, differing: 0 }]);
    expect(await raw.getDay(ref('2026-03-02'))).toHaveLength(1440);
    // Re-cooked: the hour now holds all 60 minutes' volume.
    expect(recooked).toEqual(['2026-03']);
    const hourAfter = (await cooked.getPartition('BTCUSD', '1h', '2026-03'))?.find(
      (b) => b.time === barTimeFromUtcParts(2026, 3, 2, 10, 0),
    );
    const fullHour = day('2026-03-02').filter(
      (b) => b.time >= barTimeFromUtcParts(2026, 3, 2, 10, 0) && b.time < barTimeFromUtcParts(2026, 3, 2, 11, 0),
    );
    expect(hourAfter?.volume).toBe(fullHour.reduce((sum, b) => sum + b.volume, 0));
    expect(hourAfter?.volume).toBeGreaterThan(hourBefore?.volume ?? Infinity);
    // And cooked still equals a rebuild from raw.
    expect(rebuildPassed(await new RebuildCheck({ source: minutes, store: cooked }).run(BTCUSD, ['2026-03']))).toBe(true);
  });
});

