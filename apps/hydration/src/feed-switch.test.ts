// Feed independence (CLAUDE.md rule 7): an instrument moves to another
// provider through the feed plan alone. Older days keep coming from the old
// provider, newer ones from the new, and cooking reads both. In memory, through
// the real plan, registry, Backfill, reader and CookIntraday.

import type { AdapterEntry, HistoryProviderPort, RawDayRef } from '@aia/hydration';
import {
  Backfill,
  FeedAdapters,
  RawDayAlreadyStoredError,
  dayStart,
  feedsFor,
  historySegments,
  parseFeedPlan,
} from '@aia/hydration';
import type { CookedBarStorePort } from '@aia/market-data';
import { BTCUSD, CookIntraday, partitionOf } from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, nyseCalendar, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { rawProviderOf } from './feeds.js';
import { RawMinuteSource } from './raw-minute-source.js';

/** A provider whose every price is `level`, so its bars are recognisable. */
function flatProvider(name: string, level: number): HistoryProviderPort {
  return {
    name,
    fetchDay(_i: Instrument, date: string): Promise<Bar[]> {
      const start = dayStart(date);
      return Promise.resolve(
        Array.from({ length: 1440 }, (_, i) => {
          const p = price(level);
          return { time: barTime(start + i * 60), open: p, high: p, low: p, close: p, volume: volume(100) };
        }),
      );
    },
  };
}

class MemoryRaw {
  readonly days = new Map<string, Bar[]>();
  readonly asked: string[] = [];
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
    this.asked.push(this.key(ref));
    return Promise.resolve(this.days.get(this.key(ref)));
  }
}

class PartitionStore implements CookedBarStorePort {
  readonly files = new Map<string, Bar[]>();
  put(symbol: string, tf: Timeframe, bars: readonly Bar[]): Promise<void> {
    const groups = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${tf}/${partitionOf(tf, bar.time)}`;
      groups.set(key, [...(groups.get(key) ?? []), bar]);
    }
    for (const [key, group] of groups) this.files.set(key, group);
    return Promise.resolve();
  }
  getRange(): Promise<Bar[]> {
    return Promise.resolve([]);
  }
  getPartition(symbol: string, tf: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.files.get(`${symbol}/${tf}/${partition}`));
  }
}

const registry: Record<string, AdapterEntry> = {
  coinbase: { env: [], history: () => flatProvider('coinbase', 100_00) },
  other: { env: [], history: () => flatProvider('other', 200_00) },
};

function plan(switchDay?: string) {
  const history: object[] = [{ provider: 'coinbase', settleSeconds: 3600 }];
  if (switchDay !== undefined) history.push({ provider: 'other', from: switchDay, settleSeconds: 3600 });
  return parseFeedPlan({ instruments: [{ symbol: 'BTCUSD', defaultFrom: '2026-03-01', history }] });
}

const now = barTimeFromUtcParts(2026, 3, 10);

/** What the backfill command does: one Backfill run per provider segment. */
async function backfill(raw: MemoryRaw, feedPlan: ReturnType<typeof plan>, from: string, until: string): Promise<void> {
  const adapters = new FeedAdapters({}, registry);
  for (const segment of historySegments(feedsFor(feedPlan, 'BTCUSD'), from, until)) {
    await new Backfill({ provider: adapters.historyProvider(segment.source.provider), raw }).run(BTCUSD, {
      from: segment.from,
      until: segment.until,
      now,
      settleSeconds: segment.source.settleSeconds,
    });
  }
}

describe('switching a feed through the plan alone', () => {
  it('fetches each day from the provider in effect, and cooks across the switch', async () => {
    const raw = new MemoryRaw();
    const switched = plan('2026-03-03');
    await backfill(raw, switched, '2026-03-01', '2026-03-04');

    expect([...raw.days.keys()].sort()).toEqual([
      'coinbase/BTCUSD/2026-03-01',
      'coinbase/BTCUSD/2026-03-02',
      'other/BTCUSD/2026-03-03',
      'other/BTCUSD/2026-03-04',
    ]);

    const cooked = new PartitionStore();
    const minutes = new RawMinuteSource(raw, rawProviderOf(switched));
    await new CookIntraday({ source: minutes, store: cooked, calendar: nyseCalendar() }).cookPartition(
      BTCUSD,
      '2026-03',
    );

    const hours = cooked.files.get('BTCUSD/1h/2026-03') ?? [];
    const closeAt = (d: number, h: number) =>
      hours.find((b) => b.time === barTimeFromUtcParts(2026, 3, d, h))?.close;
    expect(hours).toHaveLength(4 * 24);
    expect(closeAt(2, 23)).toBe(100_00);
    expect(closeAt(3, 0)).toBe(200_00);
    expect(closeAt(4, 23)).toBe(200_00);
  });

  it('keeps reading history stored under the old provider after a switch is added', async () => {
    const raw = new MemoryRaw();
    await backfill(raw, plan(), '2026-03-01', '2026-03-02');

    // Later, the plan moves BTCUSD to `other` from 2026-03-03. No code changes.
    const minutes = new RawMinuteSource(raw, rawProviderOf(plan('2026-03-03')));
    const bars = await minutes.read('BTCUSD', barTimeFromUtcParts(2026, 3, 1), barTimeFromUtcParts(2026, 3, 3, 0, 59));

    expect(bars).toHaveLength(2 * 1440);
    expect(raw.asked).toEqual([
      'coinbase/BTCUSD/2026-03-01',
      'coinbase/BTCUSD/2026-03-02',
      'other/BTCUSD/2026-03-03',
    ]);
  });
});
