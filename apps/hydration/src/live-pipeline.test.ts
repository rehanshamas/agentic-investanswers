// M1-15: the live path's storage work per minute does not grow. Through
// `pnpm live`'s own LivePipeline on in-memory stores: a live minute writes
// nothing to the cooked store, however full its month is; the first minute of
// a new UTC day writes each timeframe once and moves the watermark. The
// 500-instrument run against MinIO is `pnpm load-hydration`.

import type { LiveHourStorePort, RawDayRef } from '@aia/hydration';
import type { LiveBatch } from '@aia/market-data';
import { CookedReader, INTRADAY_ROLLUPS, MemoryCookedWatermarks, MemoryLiveBarsBus, MemoryRecentBarsCache, rollUp } from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, price, volume, zonedDateKey } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { LivePipeline } from './live-pipeline.js';
import { MemoryCookedStore, MemoryLiveStore } from './replay-support.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const DAY = 86_400;
const D28 = barTimeFromUtcParts(2026, 11, 28);

function minute(t: number): Bar {
  const base = 7_000_000 + ((t / 60) * 7_919) % 9_000;
  return { time: barTime(t), open: price(base), high: price(base + 20), low: price(base - 20), close: price(base + 3), volume: volume(50_000_000) };
}

class CountingCooked extends MemoryCookedStore {
  puts = 0;
  gets = 0;
  override put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    this.puts++;
    return super.put(symbol, timeframe, bars);
  }
  override getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    this.gets++;
    return super.getPartition(symbol, timeframe, partition);
  }
}

/** Hour files over the in-memory live store, counting writes. */
class MemoryHours implements LiveHourStorePort {
  readonly files = new Map<string, Bar[]>();
  constructor(private readonly raw: MemoryLiveStore) {}
  private async inHour(ref: RawDayRef, hour: number): Promise<Bar[]> {
    const from = Date.parse(`${ref.date}T00:00:00Z`) / 1000 + hour * 3_600;
    return (await this.raw.getLiveMinutes(ref)).filter((b) => b.time >= from && b.time < from + 3_600);
  }
  async liveDayIndex(ref: RawDayRef): Promise<{ minuteTimes: BarTime[]; sealedHours: Set<number> }> {
    const minuteTimes = (await this.raw.getLiveMinutes(ref)).map((b) => b.time).sort((a, b) => a - b);
    const sealedHours = new Set([...this.files.keys()].filter((k) => k.startsWith(`${ref.symbol}/${ref.date}/`)).map((k) => Number(k.split('/')[2])));
    return { minuteTimes, sealedHours };
  }
  getLiveMinutesOfHour(ref: RawDayRef, hour: number): Promise<Bar[]> {
    return this.inHour(ref, hour);
  }
  putLiveHour(ref: RawDayRef, hour: number, bars: readonly Bar[]): Promise<boolean> {
    const key = `${ref.symbol}/${ref.date}/${hour}`;
    if (this.files.has(key)) return Promise.resolve(false);
    this.files.set(key, [...bars]);
    return Promise.resolve(true);
  }
}

async function setup(prestored: readonly Bar[] = []) {
  const raw = new MemoryLiveStore();
  for (const b of prestored) await raw.putLiveMinute({ provider: 'coinbase', symbol: 'BTCUSD', date: zonedDateKey(b.time, 'UTC') }, b);
  const hours = new MemoryHours(raw);
  const cooked = new CountingCooked();
  const watermarks = new MemoryCookedWatermarks();
  // A full month already settled: 27 days of 5m to 4h bars, and the watermark at the 28th.
  const month = Array.from({ length: 27 * 1_440 }, (_, i) => minute(D28 - 27 * DAY + i * 60));
  for (const tf of INTRADAY_ROLLUPS) await cooked.put('BTCUSD', tf, rollUp(BTC, tf, month));
  await watermarks.setWatermark('BTCUSD', D28);
  cooked.puts = 0;
  cooked.gets = 0;
  const bus = new MemoryLiveBarsBus();
  const batches: LiveBatch[] = [];
  await bus.subscribe({ batch: (b) => batches.push(b), lost: () => {} });
  const logs: string[] = [];
  const pipeline = new LivePipeline({
    instruments: [BTC],
    raw: { getDay: () => Promise.resolve(undefined), getLiveMinutes: (ref) => raw.getLiveMinutes(ref) },
    rawProviderOf: () => undefined,
    liveProviderOf: () => 'coinbase',
    cooked,
    watermarks,
    hours,
    cache: new MemoryRecentBarsCache(),
    bus,
    publisher: 'test',
    log: (line) => logs.push(line),
    nowMs: () => 0,
  });
  const live = async (t: number) => {
    const bar = minute(t);
    await raw.putLiveMinute({ provider: 'coinbase', symbol: 'BTCUSD', date: zonedDateKey(t, 'UTC') }, bar);
    await pipeline.minute('coinbase', 'BTCUSD', bar);
    await pipeline.compactions();
  };
  return { raw, hours, cooked, watermarks, pipeline, live, batches, logs, month };
}

describe('LivePipeline storage work (M1-15)', () => {
  it('writes nothing to the cooked store for a live minute, late in a full month', async () => {
    const { cooked, live, batches } = await setup();
    for (let i = 0; i < 120; i++) await live(D28 + 20 * 3_600 + i * 60);
    expect(cooked.puts).toBe(0);
    expect(cooked.gets).toBe(0);
    // Yet every minute was cooked and announced: its 1m bar and one bar per timeframe.
    expect(batches).toHaveLength(120);
    expect(batches.every((b) => b.updates.filter((u) => !u.forming).length === 1 + INTRADAY_ROLLUPS.length)).toBe(true);
  });

  it('at the first minute of a new day, writes the day just ended once per timeframe and moves the watermark', async () => {
    const { cooked, watermarks, live, logs, raw, month } = await setup();
    const day28 = Array.from({ length: 1_440 }, (_, i) => D28 + i * 60);
    for (const t of day28) await live(t);
    expect(cooked.puts).toBe(0);
    await live(D28 + DAY); // 00:00 on the 29th
    expect(cooked.puts).toBe(INTRADAY_ROLLUPS.length);
    expect(await watermarks.getWatermark('BTCUSD')).toBe(D28 + DAY);
    expect(logs.some((l) => l.includes('1 settled day(s) written'))).toBe(true);

    // What readers see equals a roll-up of every raw minute, settled and not.
    const minutes = {
      read: async (_s: string, from: BarTime, until: BarTime) => {
        const live28 = await raw.getLiveMinutes({ provider: 'coinbase', symbol: 'BTCUSD', date: '2026-11-28' });
        const live29 = await raw.getLiveMinutes({ provider: 'coinbase', symbol: 'BTCUSD', date: '2026-11-29' });
        return [...month, ...live28, ...live29].filter((b) => b.time >= from && b.time <= until).sort((a, b) => a.time - b.time);
      },
    };
    const reader = new CookedReader({ store: cooked, watermarks, minutes, instruments: [BTC], nowMs: () => 0 });
    const all = [...month, ...day28.map(minute), minute(D28 + DAY)];
    for (const tf of INTRADAY_ROLLUPS) {
      const from = barTime(D28 - DAY);
      const until = barTime(D28 + DAY);
      expect(await reader.getRange('BTCUSD', tf, from, until), tf).toEqual(rollUp(BTC, tf, all).filter((b) => b.time >= from && b.time <= until));
    }
  }, 30_000);

  it('seals each hour as it ends, yesterday\'s last hour at midnight, each once, equal to the stored minutes (M1-15b)', async () => {
    const { hours, raw, live } = await setup();
    for (let i = 0; i < 150; i++) await live(D28 + 21 * 3_600 + 30 * 60 + i * 60); // 21:30 to 23:59 on the 28th
    expect([...hours.files.keys()]).toEqual(['BTCUSD/2026-11-28/21', 'BTCUSD/2026-11-28/22']);
    await live(D28 + DAY); // 00:00 on the 29th
    expect(hours.files.has('BTCUSD/2026-11-28/23')).toBe(true);
    expect(hours.files.size).toBe(3); // hours before the stream began were empty: no files
    const stored = await raw.getLiveMinutes({ provider: 'coinbase', symbol: 'BTCUSD', date: '2026-11-28' });
    expect(hours.files.get('BTCUSD/2026-11-28/22')).toEqual(stored.filter((b) => b.time >= D28 + 22 * 3_600 && b.time < D28 + 23 * 3_600));
  });

  it('at start, seals the ended hours of today that a previous run stored', async () => {
    const earlier = Array.from({ length: 120 }, (_, i) => minute(D28 + 8 * 3_600 + i * 60)); // 08:00 to 09:59, a previous run
    const { hours, live } = await setup(earlier);
    await live(D28 + 11 * 3_600 + 5 * 60); // this run's first minute, 11:05
    expect([...hours.files.keys()].sort()).toEqual(['BTCUSD/2026-11-28/8', 'BTCUSD/2026-11-28/9']);
    expect(hours.files.get('BTCUSD/2026-11-28/9')).toHaveLength(60);
  });
});
