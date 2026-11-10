import type { Bar, Instrument } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, nyseCalendar, price, volume } from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertStorableFill, dayStart, mergeDay } from '../domain/raw-day.js';
import { GapRepair } from './gap-repair.js';
import type { HistoryProviderPort } from './history-provider-port.js';
import type { RawDayRef } from './raw-bar-store-port.js';
import { RawDayAlreadyStoredError } from './raw-bar-store-port.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const NVDA: Instrument = { symbol: 'NVDA', kind: 'stock', venue: 'NASDAQ', timeZone: 'America/New_York', priceScale: 2, volumeScale: 0 };
const nyse = nyseCalendar();

function bar(time: number, close = 100): Bar {
  return { time: barTime(time), open: price(close), high: price(close), low: price(close), close: price(close), volume: volume(7) };
}

/** Every minute of a UTC day, as a provider with full data would return it. */
function fullDay(date: string): Bar[] {
  const start = dayStart(date);
  return Array.from({ length: 1440 }, (_, i) => bar(start + i * 60));
}

/** In memory, with the real fill rules: write-once day files plus fill files. */
class MemoryRaw {
  readonly days = new Map<string, Bar[]>();
  readonly fills = new Map<string, Bar[][]>();
  writes = 0;
  private key(ref: RawDayRef): string {
    return `${ref.provider}/${ref.symbol}/${ref.date}`;
  }
  hasDay(ref: RawDayRef): Promise<boolean> {
    return Promise.resolve(this.days.has(this.key(ref)));
  }
  putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    if (this.days.has(this.key(ref))) return Promise.reject(new RawDayAlreadyStoredError(ref));
    this.writes++;
    this.days.set(this.key(ref), [...bars]);
    return Promise.resolve();
  }
  getDay(ref: RawDayRef): Promise<Bar[] | undefined> {
    const day = this.days.get(this.key(ref));
    if (day === undefined) return Promise.resolve(undefined);
    return Promise.resolve(mergeDay(ref.date, [day, ...(this.fills.get(this.key(ref)) ?? [])]));
  }
  async putFill(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    const existing = await this.getDay(ref);
    if (existing === undefined) throw new Error('never stored');
    assertStorableFill(ref.date, existing, bars);
    this.writes++;
    this.fills.set(this.key(ref), [...(this.fills.get(this.key(ref)) ?? []), [...bars]]);
  }
}

class FakeProvider implements HistoryProviderPort {
  readonly name = 'fake';
  readonly data = new Map<string, Bar[]>();
  fetchCount = 0;
  fetchDay(_i: Instrument, date: string): Promise<Bar[]> {
    this.fetchCount++;
    return Promise.resolve(this.data.get(date) ?? []);
  }
}

const NOW = barTimeFromUtcParts(2026, 1, 4, 12, 0); // settled through 2026-01-03
const RANGE = { from: '2026-01-01', until: '2026-01-03', now: NOW };
let raw: MemoryRaw;
let provider: FakeProvider;

beforeEach(() => {
  raw = new MemoryRaw();
  provider = new FakeProvider();
  for (const date of ['2026-01-01', '2026-01-02', '2026-01-03']) provider.data.set(date, fullDay(date));
});

function repair(dryRun = false): GapRepair {
  return new GapRepair({ provider, raw, calendar: nyse, dryRun });
}

describe('GapRepair', () => {
  it('finds deleted minutes, re-fetches them, and stores them as a fill (the done-check)', async () => {
    for (const date of ['2026-01-01', '2026-01-02', '2026-01-03']) {
      const day = fullDay(date);
      // Delete 10 minutes from 2 January.
      await raw.putDay({ provider: 'fake', symbol: 'BTCUSD', date }, date === '2026-01-02' ? day.filter((_, i) => i < 600 || i >= 610) : day);
    }
    const report = await repair().run(BTC, RANGE);
    expect(report.days).toEqual([{ date: '2026-01-02', holes: 10, filled: 10, confirmedEmpty: 0, differing: 0 }]);
    expect(report.monthsTouched).toEqual(['2026-01']);
    expect(await raw.getDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' })).toHaveLength(1440);
    // Only the suspect day was re-fetched.
    expect(provider.fetchCount).toBe(1);
  });

  it('counts minutes the provider also lacks as confirmed empty, and writes nothing', async () => {
    const day = fullDay('2026-01-02').filter((_, i) => i !== 5);
    provider.data.set('2026-01-02', day);
    await raw.putDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' }, day);
    const writesBefore = raw.writes;
    const report = await repair().run(BTC, { ...RANGE, from: '2026-01-02', until: '2026-01-02' });
    expect(report.days).toEqual([{ date: '2026-01-02', holes: 1, filled: 0, confirmedEmpty: 1, differing: 0 }]);
    expect(report.monthsTouched).toEqual([]);
    expect(raw.writes).toBe(writesBefore);
  });

  it('writes nothing on a second run', async () => {
    await raw.putDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' }, fullDay('2026-01-02').slice(0, 1000));
    await repair().run(BTC, { ...RANGE, from: '2026-01-02', until: '2026-01-02' });
    const writes = raw.writes;
    const again = await repair().run(BTC, { ...RANGE, from: '2026-01-02', until: '2026-01-02' });
    expect(again.days).toEqual([]);
    expect(raw.writes).toBe(writes);
  });

  it('re-fetches a whole missing day through the backfill', async () => {
    const report = await repair().run(BTC, RANGE);
    expect(report.backfill.stored).toBe(3);
    expect(report.monthsTouched).toEqual(['2026-01']);
  });

  it('reports minutes where the provider now differs, without changing raw', async () => {
    const day = fullDay('2026-01-02');
    await raw.putDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' }, day.filter((_, i) => i !== 0));
    provider.data.set('2026-01-02', day.map((b, i) => (i === 7 ? bar(b.time, 101) : b)));
    const report = await repair().run(BTC, { ...RANGE, from: '2026-01-02', until: '2026-01-02' });
    expect(report.days[0]).toMatchObject({ filled: 1, differing: 1 });
    const stored = await raw.getDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' });
    expect(stored?.[7]?.close).toBe(price(100));
  });

  it('writes nothing in a dry run', async () => {
    await raw.putDay({ provider: 'fake', symbol: 'BTCUSD', date: '2026-01-02' }, fullDay('2026-01-02').slice(0, 1000));
    const writes = raw.writes;
    const report = await repair(true).run(BTC, { ...RANGE, from: '2026-01-02', until: '2026-01-02' });
    expect(report.days[0]).toMatchObject({ holes: 440, filled: 440 });
    expect(raw.writes).toBe(writes);
  });

  describe('stocks, per market hours', () => {
    // Monday 2026-01-05: session 14:30-21:00 UTC. Pre-market from 09:00 UTC.
    const date = '2026-01-05';
    const session = (m: number): number => barTimeFromUtcParts(2026, 1, 5, 14, 30) + m * 60;
    const preMarket = (m: number): number => barTimeFromUtcParts(2026, 1, 5, 9, 0) + m * 60;

    it('ignores a pre-market hole and checks a session hole', async () => {
      const sessionBars = Array.from({ length: 390 }, (_, m) => bar(session(m)));
      const stored = [bar(preMarket(0)), bar(preMarket(5)), ...sessionBars.filter((_, m) => m !== 100)];
      await raw.putDay({ provider: 'fake', symbol: 'NVDA', date }, stored);
      provider.data.set(date, [bar(preMarket(0)), bar(preMarket(5)), ...sessionBars]);
      const report = await repair().run(NVDA, { from: date, until: date, now: barTimeFromUtcParts(2026, 1, 9) });
      expect(report.scanned).toBe(1);
      expect(report.days).toEqual([{ date, holes: 1, filled: 1, confirmedEmpty: 0, differing: 0 }]);
    });

    it('does not look for bars on a holiday', async () => {
      // 2026-01-19 is Martin Luther King Jr. Day.
      const report = await repair(true).run(NVDA, { from: '2026-01-19', until: '2026-01-19', now: barTimeFromUtcParts(2026, 1, 25) });
      expect(report.scanned).toBe(0);
      expect(report.days).toEqual([]);
    });
  });
});

