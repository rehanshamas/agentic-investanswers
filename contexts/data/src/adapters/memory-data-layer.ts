// The data layer in memory (M1-16), for tests and load tests: the same
// in-process composition as the real one, on stores the caller supplies (or
// empty ones), a memory cache and a memory bus, or the real Redis bus on a
// private channel (`overRedis`). `announcer` publishes live updates as a
// hydration process would.

import type { LiveBarUpdate, LiveBarsBusPort } from '@aia/market-data';
import { LiveAnnouncer, MemoryLiveBarsBus, MemoryRecentBarsCache, RedisLiveBarsBus } from '@aia/market-data';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import { InProcessDataLayer } from '../application/in-process-data-layer.js';

/** Reads cooked bars: `[from, until]` inclusive, ascending. */
export interface CookedBarsSource {
  getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]>;
}

/** Reads 1-minute bars: `[from, until]` inclusive, ascending. */
export interface MinuteBarsSource {
  read(symbol: string, from: BarTime, until: BarTime): Promise<Bar[]>;
}

export interface MemoryDataLayerOptions {
  readonly instruments: readonly Instrument[];
  readonly cooked?: CookedBarsSource;
  readonly minutes?: MinuteBarsSource;
  /** Where history starts, for every instrument. Default 1990-01-01. */
  readonly earliest?: BarTime;
  readonly nowMs?: () => number;
}

/** Publishes live updates on the layer's bus, as one hydration process (publisher) would. */
export interface Announcer {
  publish(updates: readonly LiveBarUpdate[]): Promise<void>;
  resync(): Promise<void>;
}

const NONE = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };

export class MemoryDataLayer extends InProcessDataLayer {
  private readonly announceOn: LiveBarsBusPort;

  /** Memory stores and the real Redis live bus, on its own channel (load tests through Redis). */
  static async overRedis(options: MemoryDataLayerOptions, redis: { readonly url: string; readonly channel: string }): Promise<MemoryDataLayer> {
    return new MemoryDataLayer(options, await RedisLiveBarsBus.connect(redis));
  }

  constructor(options: MemoryDataLayerOptions, bus: LiveBarsBusPort = new MemoryLiveBarsBus()) {
    super({
      instruments: options.instruments,
      earliest: () => options.earliest ?? barTime(631_152_000),
      minutes: options.minutes ?? NONE,
      cooked: options.cooked ?? NONE,
      cache: new MemoryRecentBarsCache(),
      bus,
      nowMs: options.nowMs ?? (() => 0),
    });
    this.announceOn = bus;
  }

  /** Announce as a hydration process named `publisher`, with its own sequence. */
  announcer(publisher: string): Announcer {
    return new LiveAnnouncer(this.announceOn, publisher);
  }
}
