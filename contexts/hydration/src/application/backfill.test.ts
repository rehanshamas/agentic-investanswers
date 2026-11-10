import type { Bar, Instrument } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import { dayStart } from '../domain/raw-day.js';
import type { DayOutcome } from './backfill.js';
import { Backfill } from './backfill.js';
import type { HistoryProviderPort } from './history-provider-port.js';
import type { RawDayRef } from './raw-bar-store-port.js';
import { RawDayAlreadyStoredError } from './raw-bar-store-port.js';

const BTC: Instrument = {
  symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE',
  timeZone: 'UTC', priceScale: 2, volumeScale: 8,
};

/** Noon on 2026-01-06, so the last complete day is 2026-01-05. */
const NOW = barTimeFromUtcParts(2026, 1, 6, 12, 0);
const RANGE = { from: '2026-01-01', now: NOW };
const ALL_DAYS = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];

function minutesOf(date: string, count = 3): Bar[] {
  const p = price(parseScaled('100.00', 2));
  return Array.from({ length: count }, (_, i) => ({
    time: barTime(dayStart(date) + i * 60),
    open: p, high: p, low: p, close: p,
    volume: volume(parseScaled('0.1', 8)),
  }));
}

class FakeProvider implements HistoryProviderPort {
  readonly name = 'fake';
  readonly fetched: string[] = [];
  failOn = new Set<string>();
  emptyOn = new Set<string>();
  crashOn: string | undefined;

  fetchDay(_instrument: Instrument, date: string): Promise<Bar[]> {
    this.fetched.push(date);
    if (date === this.crashOn) throw new Error('process killed');
    if (this.failOn.has(date)) return Promise.reject(new Error(`upstream 503 on ${date}`));
    if (this.emptyOn.has(date)) return Promise.resolve([]);
    return Promise.resolve(minutesOf(date));
  }
}

class MemoryRaw {
  readonly days = new Map<string, Bar[]>();
  readonly puts: string[] = [];
  /** Simulate another writer storing a day between our check and our write. */
  racedOn: string | undefined;

  private key(ref: RawDayRef): string {
    return `${ref.provider}/${ref.symbol}/${ref.date}`;
  }

  hasDay(ref: RawDayRef): Promise<boolean> {
    return Promise.resolve(this.days.has(this.key(ref)));
  }

  putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    if (ref.date === this.racedOn || this.days.has(this.key(ref))) {
      return Promise.reject(new RawDayAlreadyStoredError(ref));
    }
    this.days.set(this.key(ref), [...bars]);
    this.puts.push(ref.date);
    return Promise.resolve();
  }
}

let provider: FakeProvider;
let raw: MemoryRaw;
let outcomes: DayOutcome[];

function backfill(): Backfill {
  return new Backfill({ provider, raw, onDay: (_i, outcome) => outcomes.push(outcome) });
}

beforeEach(() => {
  provider = new FakeProvider();
  raw = new MemoryRaw();
  outcomes = [];
});

describe('Backfill', () => {
  it('stores every complete day once, under the provider name', async () => {
    const report = await backfill().run(BTC, RANGE);
    expect(report).toMatchObject({ planned: 5, stored: 5, skipped: 0, empty: 0, bars: 15, aborted: false });
    expect(raw.puts).toEqual(ALL_DAYS);
    expect([...raw.days.keys()][0]).toBe('fake/BTCUSD/2026-01-01');
  });

  it('writes nothing new on a second run, and fetches nothing either', async () => {
    await backfill().run(BTC, RANGE);
    provider.fetched.length = 0;
    raw.puts.length = 0;

    const again = await backfill().run(BTC, RANGE);
    expect(again).toMatchObject({ planned: 5, stored: 0, skipped: 5 });
    expect(raw.puts).toEqual([]);
    expect(provider.fetched).toEqual([]);
  });

  it('resumes after a crash: the days before it stay, the rest are stored next run', async () => {
    provider.crashOn = '2026-01-03';
    provider.failOn.add('2026-01-03');
    const first = await backfill().run(BTC, { ...RANGE, until: '2026-01-03' });
    expect(first).toMatchObject({ stored: 2, failed: [{ date: '2026-01-03' }] });

    provider.crashOn = undefined;
    provider.failOn.clear();
    const second = await backfill().run(BTC, RANGE);
    expect(second).toMatchObject({ stored: 3, skipped: 2 });
    expect([...raw.days.keys()].map((k) => k.slice(-10))).toEqual(ALL_DAYS);
  });

  it('does not store an empty day, so a later run can retry it', async () => {
    provider.emptyOn.add('2026-01-02');
    const report = await backfill().run(BTC, RANGE);
    expect(report).toMatchObject({ stored: 4, empty: 1 });
    expect(raw.puts).not.toContain('2026-01-02');

    provider.emptyOn.clear();
    expect(await backfill().run(BTC, RANGE)).toMatchObject({ stored: 1, skipped: 4 });
  });

  it('counts losing a race to another writer as a skip, not a failure', async () => {
    raw.racedOn = '2026-01-04';
    const report = await backfill().run(BTC, RANGE);
    expect(report).toMatchObject({ stored: 4, skipped: 1, failed: [] });
  });

  it('never fetches a day that has not settled', async () => {
    const justAfterMidnight = barTimeFromUtcParts(2026, 1, 6, 0, 30);
    const report = await backfill().run(BTC, { from: '2026-01-04', now: justAfterMidnight });
    expect(provider.fetched).toEqual(['2026-01-04']);
    expect(report.planned).toBe(1);
  });

  it('reports a failed day and carries on', async () => {
    provider.failOn.add('2026-01-02');
    const report = await backfill().run(BTC, RANGE);
    expect(report).toMatchObject({ stored: 4, aborted: false });
    expect(report.failed).toEqual([{ date: '2026-01-02', error: 'upstream 503 on 2026-01-02' }]);
  });

  it('stops after repeated failures in a row: the provider is likely down', async () => {
    for (const day of ALL_DAYS.slice(1)) provider.failOn.add(day);
    const report = await new Backfill({ provider, raw, maxConsecutiveFailures: 2 }).run(BTC, RANGE);
    expect(report).toMatchObject({ stored: 1, aborted: true });
    expect(provider.fetched).toEqual(ALL_DAYS.slice(0, 3));
  });

  it('refuses to store a day whose bars do not belong to it', async () => {
    provider.fetchDay = (_i, date) =>
      Promise.resolve(date === '2026-01-02' ? minutesOf('2026-01-03') : minutesOf(date));
    const report = await backfill().run(BTC, RANGE);
    expect(report.failed.map((f) => f.date)).toEqual(['2026-01-02']);
    expect(raw.puts).not.toContain('2026-01-02');
  });

  it('reports each day to onDay in order', async () => {
    raw.days.set('fake/BTCUSD/2026-01-01', minutesOf('2026-01-01'));
    await backfill().run(BTC, { ...RANGE, until: '2026-01-02' });
    expect(outcomes).toEqual([
      { date: '2026-01-01', kind: 'skipped' },
      { date: '2026-01-02', kind: 'stored', bars: 3 },
    ]);
  });
});
