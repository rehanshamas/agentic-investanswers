// The live stream use case (M1-05): trades in, closed 1-minute bars out to
// the raw store as each minute ends, reconnecting with backoff and recording a
// gap for every minute a disconnect cost. On each tick it also reports the
// minutes still forming, when they changed (M2-04), so charts tick with
// trades; those are never stored.
//
// Provider-neutral (CLAUDE.md rule 7): it sees a `LiveTradesPort` and a
// `LiveRawStorePort`, never a provider. The clock and timers are injected, so
// tests drive time by hand.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { zonedDateKey } from '@aia/shared-kernel';

import type { LiveGap } from '../domain/live-minutes.js';
import { MinuteBuilder, splitGapByDay } from '../domain/live-minutes.js';
import type { LiveRawStorePort } from './live-raw-store-port.js';
import { LiveMinuteAlreadyStoredError } from './live-raw-store-port.js';
import type { LiveConnection, LiveTradesPort } from './live-trades-port.js';
import type { RawDayRef } from './raw-bar-store-port.js';

export type Cancel = () => void;

/** Time and timers, injected so tests control them. */
export interface Scheduler {
  /** Epoch milliseconds. */
  now(): number;
  every(ms: number, run: () => void): Cancel;
  after(ms: number, run: () => void): Cancel;
}

export type LiveEvent =
  | { readonly kind: 'connected' }
  | { readonly kind: 'disconnected'; readonly reason: string; readonly retryInMs: number }
  | { readonly kind: 'minute'; readonly symbol: string; readonly bar: Bar }
  /** The minutes still forming, ascending (M2-04). Not stored; a later `minute` event gives the stored bar. */
  | { readonly kind: 'forming'; readonly symbol: string; readonly bars: readonly Bar[] }
  | { readonly kind: 'gap'; readonly symbol: string; readonly gap: LiveGap }
  | { readonly kind: 'late'; readonly symbol: string }
  | { readonly kind: 'write-failed'; readonly symbol: string; readonly what: string; readonly error: string };

export interface LiveStreamOptions {
  /** How long past a minute's end to wait for late trades. Default 2 s. */
  readonly graceMs?: number;
  /** Silence after which the connection is treated as dead. Default 30 s. */
  readonly heartbeatTimeoutMs?: number;
  /** First reconnect delay; doubles each failure. Default 1 s. */
  readonly backoffInitialMs?: number;
  /** Longest reconnect delay. Default 60 s. */
  readonly backoffMaxMs?: number;
  /** A connection that lasted this long resets the backoff. Default 5 min. */
  readonly healthyAfterMs?: number;
  /** How often minutes are closed, forming minutes reported and the heartbeat checked. Default 250 ms. */
  readonly tickMs?: number;
  /** 0..1, for jitter; injected so tests are exact. */
  readonly random?: () => number;
}

export interface LiveStreamDeps {
  readonly feed: LiveTradesPort;
  readonly store: LiveRawStorePort;
  readonly scheduler: Scheduler;
  readonly onEvent?: (event: LiveEvent) => void;
}

export class LiveStream {
  private readonly builders = new Map<string, MinuteBuilder>();
  /** Per symbol: where the current gap began, while disconnected. */
  private readonly gapFrom = new Map<string, BarTime>();
  /** Per symbol: writes in order, so minutes land in raw ascending. */
  private readonly writes = new Map<string, Promise<void>>();
  private readonly options: Required<LiveStreamOptions>;
  private connection: LiveConnection | undefined;
  private connectionId = 0;
  private open = false;
  private openedAt = 0;
  private lastAlive = 0;
  private failures = 0;
  private stopped = true;
  private cancelTick: Cancel | undefined;
  private cancelRetry: Cancel | undefined;

  constructor(
    private readonly deps: LiveStreamDeps,
    private readonly instruments: readonly Instrument[],
    options: LiveStreamOptions = {},
  ) {
    this.options = {
      graceMs: options.graceMs ?? 2_000,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 30_000,
      backoffInitialMs: options.backoffInitialMs ?? 1_000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
      healthyAfterMs: options.healthyAfterMs ?? 5 * 60_000,
      tickMs: options.tickMs ?? 250,
      random: options.random ?? Math.random,
    };
    for (const instrument of instruments) this.builders.set(instrument.symbol, new MinuteBuilder());
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.cancelTick = this.deps.scheduler.every(this.options.tickMs, () => this.tick());
    this.connect();
  }

  /** Stop, and wait for every write already started. Unfinished minutes are not written. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTick?.();
    this.cancelRetry?.();
    this.connectionId++;
    this.connection?.close();
    this.connection = undefined;
    this.open = false;
    await Promise.all(this.writes.values());
  }

  /** Close due minutes, report forming ones and check the connection is alive. Runs on a timer. */
  tick(): void {
    if (!this.open) return;
    const now = this.deps.scheduler.now();
    this.closeDue(now);
    this.reportForming();
    if (now - this.lastAlive > this.options.heartbeatTimeoutMs) {
      this.drop(`no message for ${Math.round((now - this.lastAlive) / 1000)} s`);
    }
  }

  private connect(): void {
    this.cancelRetry = undefined;
    const id = ++this.connectionId;
    const current = (): boolean => id === this.connectionId && !this.stopped;
    this.connection = this.deps.feed.connect(this.instruments, {
      onOpen: () => {
        if (current()) this.opened();
      },
      onTrade: (symbol, trade) => {
        if (!current() || !this.open) return;
        this.lastAlive = this.deps.scheduler.now();
        const builder = this.builders.get(symbol);
        if (builder !== undefined && builder.add(trade) === 'late') this.emit({ kind: 'late', symbol });
      },
      onAlive: () => {
        if (current()) this.lastAlive = this.deps.scheduler.now();
      },
      onClose: (reason) => {
        if (current()) this.drop(reason);
      },
    });
  }

  private opened(): void {
    const now = this.deps.scheduler.now();
    this.open = true;
    this.openedAt = now;
    this.lastAlive = now;
    for (const [symbol, builder] of this.builders) {
      const first = builder.resume(now);
      const from = this.gapFrom.get(symbol);
      this.gapFrom.delete(symbol);
      if (from !== undefined && first > from) this.recordGap(symbol, { from, until: first });
    }
    this.emit({ kind: 'connected' });
  }

  private drop(reason: string): void {
    const now = this.deps.scheduler.now();
    if (this.open) {
      // Minutes already past their grace are whole: keep them.
      this.closeDue(now);
      if (now - this.openedAt >= this.options.healthyAfterMs) this.failures = 0;
    }
    for (const [symbol, builder] of this.builders) {
      const from = builder.interrupt();
      if (from !== undefined && !this.gapFrom.has(symbol)) this.gapFrom.set(symbol, from);
    }
    this.open = false;
    this.connectionId++;
    this.connection?.close();
    this.connection = undefined;
    const retryInMs = this.backoff();
    this.failures++;
    this.emit({ kind: 'disconnected', reason, retryInMs });
    if (!this.stopped) this.cancelRetry = this.deps.scheduler.after(retryInMs, () => this.connect());
  }

  /** Equal jitter: half the doubled delay fixed, half random. */
  private backoff(): number {
    const { backoffInitialMs, backoffMaxMs, random } = this.options;
    const base = Math.min(backoffMaxMs, backoffInitialMs * 2 ** this.failures);
    return Math.round(base / 2 + (random() * base) / 2);
  }

  private closeDue(now: number): void {
    for (const [symbol, builder] of this.builders) {
      for (const bar of builder.closeDue(now, this.options.graceMs)) this.writeMinute(symbol, bar);
    }
  }

  /** At most once a tick per symbol, and only when a forming minute changed. */
  private reportForming(): void {
    for (const [symbol, builder] of this.builders) {
      const bars = builder.takeForming();
      if (bars !== undefined && bars.length > 0) this.emit({ kind: 'forming', symbol, bars });
    }
  }

  private ref(symbol: string, time: number): RawDayRef {
    return { provider: this.deps.feed.name, symbol, date: zonedDateKey(time, 'UTC') };
  }

  private writeMinute(symbol: string, bar: Bar): void {
    this.enqueue(symbol, async () => {
      try {
        await this.deps.store.putLiveMinute(this.ref(symbol, bar.time), bar);
      } catch (error) {
        // Already there is fine (raw is write-once and this is the same minute).
        if (!(error instanceof LiveMinuteAlreadyStoredError)) {
          this.emit({ kind: 'write-failed', symbol, what: `minute ${bar.time}`, error: String(error) });
          return;
        }
      }
      this.emit({ kind: 'minute', symbol, bar });
    });
  }

  private recordGap(symbol: string, gap: LiveGap): void {
    this.emit({ kind: 'gap', symbol, gap });
    for (const part of splitGapByDay(gap)) {
      this.enqueue(symbol, async () => {
        try {
          await this.deps.store.putLiveGap(this.ref(symbol, part.gap.from), part.gap);
        } catch (error) {
          this.emit({ kind: 'write-failed', symbol, what: `gap ${part.gap.from}-${part.gap.until}`, error: String(error) });
        }
      });
    }
  }

  private enqueue(symbol: string, write: () => Promise<void>): void {
    const previous = this.writes.get(symbol) ?? Promise.resolve();
    this.writes.set(symbol, previous.then(write));
  }

  private emit(event: LiveEvent): void {
    this.deps.onEvent?.(event);
  }
}
