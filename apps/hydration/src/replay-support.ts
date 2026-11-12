// Replaying the recorded Coinbase stream through the real pipeline, shared by
// the replay tests (M2-02's cache check, M2-04's live updates check).

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import type { Cancel, LiveRawStorePort, RawDayRef, Scheduler, SocketLike } from '@aia/hydration';
import type { CookedBarStorePort } from '@aia/market-data';
import { INTRADAY_ROLLUPS, parityInstrument, partitionOf } from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

// The recording belongs to the hydration context's tests; read as data, not imported.
export const RECORDING = new URL('../../../contexts/hydration/test-data/coinbase-matches-2026-11-10.jsonl.gz', import.meta.url);
export const INSTRUMENTS = ['BTCUSD', 'ETHUSD'].map((s) => parityInstrument(s) as Instrument);
export const TIMEFRAMES: readonly Timeframe[] = ['1m', ...INTRADAY_ROLLUPS];

/** Fires timers in order as the recording's arrival times pass (as in M1-05's replay test). */
export class ReplayClock implements Scheduler {
  time = 0;
  private timers: Array<{ due: number; every?: number; run: () => void; live: boolean }> = [];
  now(): number {
    return this.time;
  }
  every(ms: number, run: () => void): Cancel {
    const timer = { due: this.time + ms, every: ms, run, live: true };
    this.timers.push(timer);
    return () => (timer.live = false);
  }
  after(ms: number, run: () => void): Cancel {
    const timer = { due: this.time + ms, run, live: true };
    this.timers.push(timer);
    return () => (timer.live = false);
  }
  advance(to: number): void {
    for (;;) {
      const next = this.timers.filter((t) => t.live && t.due <= to).sort((a, b) => a.due - b.due)[0];
      if (next === undefined) break;
      this.time = next.due;
      if (next.every === undefined) next.live = false;
      else next.due += next.every;
      next.run();
    }
    this.time = to;
  }
}

export class ReplaySocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(): void {}
  close(): void {}
}

const dayKey = (ref: RawDayRef): string => `${ref.symbol}/${ref.date}`;

export class MemoryLiveStore implements LiveRawStorePort {
  private readonly bars = new Map<string, Bar[]>();
  putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void> {
    this.bars.set(dayKey(ref), [...(this.bars.get(dayKey(ref)) ?? []), bar]);
    return Promise.resolve();
  }
  getLiveMinutes(ref: RawDayRef): Promise<Bar[]> {
    return Promise.resolve([...(this.bars.get(dayKey(ref)) ?? [])]);
  }
  putLiveGap(): Promise<void> {
    return Promise.resolve();
  }
  getLiveGaps(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

export class MemoryCookedStore implements CookedBarStorePort {
  private readonly partitions = new Map<string, Bar[]>();
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    const touched = new Map<string, Bar[]>();
    for (const bar of bars) {
      const key = `${symbol}/${timeframe}/${partitionOf(timeframe, bar.time)}`;
      touched.set(key, [...(touched.get(key) ?? []), bar]);
    }
    for (const [key, group] of touched) this.partitions.set(key, group);
    return Promise.resolve();
  }
  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const bars = [...this.partitions]
      .filter(([key]) => key.startsWith(`${symbol}/${timeframe}/`))
      .flatMap(([, group]) => group)
      .filter((b) => b.time >= from && b.time <= until);
    return Promise.resolve(bars.sort((a, b) => a.time - b.time));
  }
  getPartition(symbol: string, timeframe: Timeframe, partition: string): Promise<Bar[] | undefined> {
    return Promise.resolve(this.partitions.get(`${symbol}/${timeframe}/${partition}`));
  }
}

export function recording(): Array<{ t: number; m: string }> {
  return gunzipSync(readFileSync(RECORDING))
    .toString('utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { t: number; m: string });
}

export const seconds = (ms: number): BarTime => barTime(Math.floor(ms / 1000));
