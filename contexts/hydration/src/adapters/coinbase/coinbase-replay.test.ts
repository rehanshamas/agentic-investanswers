// M1-05 done-check: "Replay of a recorded stream gives the same bars as the
// fixture." A real recording of Coinbase's feed (BTC-USD and ETH-USD, about 30
// minutes, 2026-11-10) is replayed through the real adapter, LiveStream and
// MinuteBuilder, on a clock that follows each message's recorded arrival
// time. Every whole minute must equal Coinbase's own 1-minute candle for it,
// fetched from the REST API at the time and saved beside the recording: open,
// high, low, close and volume, exactly, with no minute missing.
//
// The recording is kept as received (gzip JSONL of {t: receivedMs, m: raw}),
// so the parser is tested on the provider's real messages.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { LiveRawStorePort } from '../../application/live-raw-store-port.js';
import type { Cancel, Scheduler } from '../../application/live-stream.js';
import { LiveStream } from '../../application/live-stream.js';
import type { RawDayRef } from '../../application/raw-bar-store-port.js';
import type { LiveGap } from '../../domain/live-minutes.js';
import { parseCandles } from './coinbase-candles.js';
import type { SocketLike } from './coinbase-trades.js';
import { CoinbaseTrades } from './coinbase-trades.js';

const DATA = new URL('../../../test-data/', import.meta.url);
const RECORDING = 'coinbase-matches-2026-11-10.jsonl.gz';
const CANDLES = 'coinbase-candles-2026-11-10.json';

// The instruments as the platform defines them (market-data's parity
// instruments); repeated here because a context may not import another's
// internals, and hydration does not depend on market-data.
const INSTRUMENTS = [
  { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 },
  { symbol: 'ETHUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 3, volumeScale: 8 },
] as const;

class ReplayClock implements Scheduler {
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

class ReplaySocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(): void {}
  close(): void {}
}

class MemoryLiveStore implements LiveRawStorePort {
  readonly bars = new Map<string, Bar[]>();
  readonly gaps: LiveGap[] = [];
  putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void> {
    this.bars.set(ref.symbol, [...(this.bars.get(ref.symbol) ?? []), bar]);
    return Promise.resolve();
  }
  getLiveMinutes(ref: RawDayRef): Promise<Bar[]> {
    return Promise.resolve(this.bars.get(ref.symbol) ?? []);
  }
  putLiveGap(_ref: RawDayRef, gap: LiveGap): Promise<void> {
    this.gaps.push(gap);
    return Promise.resolve();
  }
  getLiveGaps(): Promise<LiveGap[]> {
    return Promise.resolve(this.gaps);
  }
}

function recording(): Array<{ t: number; m: string }> {
  const text = gunzipSync(readFileSync(new URL(RECORDING, DATA))).toString('utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { t: number; m: string });
}

/** Coinbase REST candle responses saved with the recording: `{ symbol: { from, until, body } }`. */
function candles(): Record<string, { from: number; until: number; body: unknown }> {
  return JSON.parse(readFileSync(new URL(CANDLES, DATA), 'utf8')) as Record<
    string,
    { from: number; until: number; body: unknown }
  >;
}

describe('replay of a recorded Coinbase stream (M1-05 done-check)', () => {
  it('builds every whole minute exactly as Coinbase candles it', async () => {
    const messages = recording();
    const clock = new ReplayClock();
    clock.time = messages[0]?.t ?? 0;
    const socket = new ReplaySocket();
    const store = new MemoryLiveStore();
    const feed = new CoinbaseTrades({ socket: () => socket, now: () => clock.now() });
    const disconnects: string[] = [];
    const stream = new LiveStream({
      feed,
      store,
      scheduler: clock,
      onEvent: (e) => {
        if (e.kind === 'disconnected') disconnects.push(e.reason);
      },
    }, INSTRUMENTS);

    stream.start();
    socket.onopen?.({});
    for (const { t, m } of messages) {
      clock.advance(t);
      socket.onmessage?.({ data: m });
    }
    clock.advance((messages.at(-1)?.t ?? 0) + 3_000);
    await stream.stop();

    expect(disconnects).toEqual([]);
    expect(store.gaps).toEqual([]);

    for (const instrument of INSTRUMENTS) {
      const saved = candles()[instrument.symbol];
      if (saved === undefined) throw new Error(`No saved candles for ${instrument.symbol}`);
      const built = store.bars.get(instrument.symbol) ?? [];
      // Compare over the minutes the stream saw whole: from its first bar to its last.
      const first = built[0]?.time as BarTime;
      const last = built.at(-1)?.time as BarTime;
      const expected = parseCandles(instrument, saved.body, barTime(saved.from), barTime(saved.until)).filter(
        (bar) => bar.time >= first && bar.time <= last,
      );
      expect(built.length).toBeGreaterThanOrEqual(25);
      expect(built).toEqual(expected);
    }
  });
});
