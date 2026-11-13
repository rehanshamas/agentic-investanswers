// What `pnpm live` does with each live event, per instrument (M1-15):
// composition only, so `pnpm live`, the replay tests and `pnpm load-hydration`
// all run the same steps.
//
// A minute the live stream has stored is cooked, then applied to the
// recent-bars cache, then announced to charts, in that order and one minute at
// a time per instrument. Forming minutes are announced at once. Anything that
// may leave charts differing from the store announces a resync.
//
// Cooking is in memory (M1-15): the cooked store holds settled days only,
// written by the compactor, and readers roll up the rest from raw. The first
// minute of each UTC day, and the first after start, sets off compaction for
// that instrument in the background; it never holds up a minute.
//
// Once an hour has ended, its live minutes are also written as one hour file
// (M1-15b), so reading a day of them costs about 24 GETs, not 1,440. Hours are
// sealed for the days this process has streamed, before compaction reads them.

import type { LiveHourStorePort, ProviderOf, RawDayRef } from '@aia/hydration';
import { LiveHourSealer, RawMinuteSource } from '@aia/hydration';
import type { CookedBarStorePort, CookedWatermarkPort, LiveBarUpdate, LiveBarsBusPort, RecentBarsCachePort } from '@aia/market-data';
import {
  CookIntraday,
  CookedCompactor,
  CookedReader,
  FormingBars,
  INTRADAY_ROLLUPS,
  LiveAnnouncer,
  LiveCook,
  RecentBars,
  barClosedEvents,
} from '@aia/market-data';
import type { Bar, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { addDays, barTime, zonedDateKey } from '@aia/shared-kernel';

import { CACHED_TIMEFRAMES } from './cache.js';

export interface LivePipelineDeps {
  readonly instruments: readonly Instrument[];
  readonly raw: {
    getDay(ref: RawDayRef): Promise<Bar[] | undefined>;
    getLiveMinutes(ref: RawDayRef): Promise<Bar[]>;
  };
  readonly rawProviderOf: ProviderOf;
  readonly liveProviderOf: ProviderOf;
  /** Hour files for live minutes (M1-15b); without it, hours are not sealed. */
  readonly hours?: LiveHourStorePort;
  readonly cooked: CookedBarStorePort;
  readonly watermarks: CookedWatermarkPort;
  readonly cache: RecentBarsCachePort;
  readonly bus: Pick<LiveBarsBusPort, 'publish'>;
  /** Unique per process run. */
  readonly publisher: string;
  readonly calendar?: MarketCalendar;
  readonly log: (line: string) => void;
  /** Epoch milliseconds. */
  readonly nowMs: () => number;
  /**
   * How many instruments compact at once. Default 4: at midnight every
   * instrument has a day to write, and compaction must not compete with the
   * live minutes for the store.
   */
  readonly compactionConcurrency?: number;
}

const DAY = 86_400;

export class LivePipeline {
  private readonly bySymbol: ReadonlyMap<string, Instrument>;
  private readonly forming: ReadonlyMap<string, FormingBars>;
  /** Today's live minutes, held in memory once read, so cooking a new minute does not list the day again. */
  private readonly liveDays = new Map<string, Promise<Bar[]>>();
  private readonly sealer: LiveHourSealer | undefined;
  /** Hours already sealed (or found empty), and the days streamed, per provider and instrument. */
  private readonly sealedHours = new Set<string>();
  private readonly daysStreamed = new Set<string>();
  private readonly cooks: ReadonlyMap<string, LiveCook>;
  private readonly compactor: CookedCompactor;
  /** Per instrument, the UTC day compaction last ran for, and the run in progress. */
  private readonly compacted = new Map<string, number>();
  private readonly compacting = new Map<string, Promise<void>>();
  /** Compactions waiting for a slot, and how many run now. */
  private readonly compactionQueue: Array<() => void> = [];
  private compactionsRunning = 0;
  private readonly recent: RecentBars;
  private readonly announcer: LiveAnnouncer;
  /** Per instrument, its minutes in order. */
  private readonly chains = new Map<string, Promise<void>>();
  /** Instruments whose cached windows may have missed an update; dropped before the next one. */
  private readonly staleCache = new Set<string>();

  constructor(private readonly deps: LivePipelineDeps) {
    this.bySymbol = new Map(deps.instruments.map((i) => [i.symbol, i]));
    // Stocks are not cooked until M1-08, so only their 1m bar forms.
    this.forming = new Map(
      deps.instruments.map((i) => [i.symbol, new FormingBars(i, i.kind === 'stock' ? [] : INTRADAY_ROLLUPS, deps.calendar)]),
    );
    const cachedRaw = {
      getDay: (ref: RawDayRef) => deps.raw.getDay(ref),
      getLiveMinutes: (ref: RawDayRef) => this.liveDay(ref),
    };
    const minutes = new RawMinuteSource(cachedRaw, deps.rawProviderOf, deps.liveProviderOf);
    const calendar = deps.calendar === undefined ? {} : { calendar: deps.calendar };
    // Stocks are not cooked until M1-08.
    this.cooks = new Map(
      deps.instruments
        .filter((i) => i.kind !== 'stock')
        .map((i) => [i.symbol, new LiveCook({ instrument: i, timeframes: INTRADAY_ROLLUPS, source: minutes, ...calendar })]),
    );
    this.compactor = new CookedCompactor({ cook: new CookIntraday({ source: minutes, store: deps.cooked, ...calendar }), watermarks: deps.watermarks });
    const reader = new CookedReader({
      store: deps.cooked,
      watermarks: deps.watermarks,
      minutes,
      instruments: deps.instruments,
      nowMs: deps.nowMs,
      ...calendar,
    });
    this.recent = new RecentBars({ cache: deps.cache, store: reader, minutes });
    this.announcer = new LiveAnnouncer(deps.bus, deps.publisher);
    this.sealer = deps.hours === undefined ? undefined : new LiveHourSealer(deps.hours);
  }

  /** The minutes not yet stored changed. */
  formingChanged(symbol: string, bars: readonly Bar[]): void {
    this.announce(this.forming.get(symbol)?.unstoredChanged(bars) ?? []);
  }

  /** The stream for these instruments dropped: their forming minutes will never be stored. */
  disconnected(symbols: readonly string[], why: string): void {
    for (const symbol of symbols) this.forming.get(symbol)?.reset();
    this.resync(why);
  }

  /** A minute could not be stored. */
  writeFailed(symbol: string): void {
    this.resync(`${symbol} write failed`);
  }

  /**
   * A minute was stored in raw by the live stream (`provider`). Resolves once
   * it is cooked, cached and announced, or once that failed (logged).
   */
  minute(provider: string, symbol: string, bar: Bar): Promise<void> {
    const instrument = this.bySymbol.get(symbol);
    if (instrument === undefined) return Promise.resolve();
    const forming = this.forming.get(symbol);
    forming?.stored(bar);
    const ref = { provider, symbol, date: zonedDateKey(bar.time, 'UTC') };
    void this.liveDay(ref).then((minutes) => {
      if (!minutes.some((b) => b.time === bar.time)) minutes.push(bar);
    });

    // The stored bars go out only once the cache has them.
    const cachedThenAnnounce = (rebuilt: Map<Timeframe, Bar[]>) =>
      this.updateCache(symbol, bar, rebuilt).then(
        () => this.announce(forming?.cooked(bar, rebuilt) ?? []),
        (error: unknown) => {
          this.resync(`${symbol} cache update failed`);
          throw error;
        },
      );
    const previous = this.chains.get(symbol) ?? Promise.resolve();
    let next: Promise<void>;
    // Stocks are not cooked until M1-08, so only their 1m window follows.
    if (instrument.kind === 'stock') {
      next = previous
        .then(() => cachedThenAnnounce(new Map()))
        .catch((error: unknown) => this.deps.log(`${symbol}: cache update failed: ${String(error)}`));
    } else {
      const cook = this.cooks.get(symbol) as LiveCook;
      next = previous
        .then(() => this.liveDay(ref))
        .then(() => cook.apply(bar))
        .then(
          (rebuilt) =>
            cachedThenAnnounce(rebuilt).catch((error: unknown) =>
              this.deps.log(`${symbol}: cache update failed, its windows are dropped once Redis is back: ${String(error)}`),
            ),
          (error: unknown) => {
            // The minute is in raw but its bars are not cooked, so cached windows are behind the store.
            this.staleCache.add(symbol);
            this.resync(`${symbol} cooking failed`);
            this.deps.log(`${symbol}: cooking failed: ${String(error)}`);
          },
        );
    }
    // Then seal hours that have ended, before compaction (set off below) reads them.
    next = next
      .then(() => this.sealEndedHours(provider, symbol, bar))
      .catch((error: unknown) => this.deps.log(`${symbol}: sealing an hour of live minutes failed, retried next minute: ${String(error)}`));
    this.chains.set(symbol, next);
    if (instrument.kind !== 'stock') void next.then(() => this.compactIfNewDay(instrument, bar));
    return next;
  }

  /** Compaction runs in progress, so a shutdown can wait for them. */
  async compactions(): Promise<void> {
    await Promise.all(this.compacting.values());
  }

  /** The first minute of a UTC day (or since start) writes the days before it to the cooked store. */
  private compactIfNewDay(instrument: Instrument, minute: Bar): void {
    const symbol = instrument.symbol;
    const today = Math.floor(minute.time / DAY) * DAY;
    if ((this.compacted.get(symbol) ?? -1) >= today || this.compacting.has(symbol)) return;
    const run = this.compactionSlot()
      .then(() => {
        const started = this.deps.nowMs();
        return this.compactor.compact(instrument, barTime(today)).then((days) => ({ days, started }));
      })
      .then(
        ({ days, started }) => {
          this.compacted.set(symbol, today);
          if (days > 0) this.deps.log(`${symbol}: ${days} settled day(s) written to the cooked store in ${this.deps.nowMs() - started} ms`);
        },
        // Readers roll up everything past the watermark, so a late compaction slows reads, never breaks them.
        (error: unknown) => this.deps.log(`${symbol}: compaction failed, retried on the next minute: ${String(error)}`),
      )
      .finally(() => {
        this.compacting.delete(symbol);
        this.compactionsRunning--;
        this.compactionQueue.shift()?.();
      });
    this.compacting.set(symbol, run);
  }

  /** Resolves when fewer than `compactionConcurrency` compactions run; the caller then holds a slot. */
  private compactionSlot(): Promise<void> {
    if (this.compactionsRunning < (this.deps.compactionConcurrency ?? 4)) {
      this.compactionsRunning++;
      return Promise.resolve();
    }
    return new Promise((resolve) =>
      this.compactionQueue.push(() => {
        this.compactionsRunning++;
        resolve();
      }),
    );
  }

  /** Every minute handed in so far is done, and any compaction it set off. */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
    await this.compactions();
  }

  /**
   * Seal every ended hour of the days this process streamed for the
   * instrument (today's hours before this minute's, and all of yesterday's),
   * and forget minutes held for older days.
   */
  private async sealEndedHours(provider: string, symbol: string, minute: Bar): Promise<void> {
    const today = zonedDateKey(minute.time, 'UTC');
    const yesterday = addDays(today, -1);
    const stream = `${provider}/${symbol}`;
    this.daysStreamed.add(`${stream}/${today}`);
    for (const key of [...this.liveDays.keys()]) {
      const date = key.slice(key.lastIndexOf('/') + 1);
      if (key.startsWith(`${stream}/`) && date < yesterday) this.liveDays.delete(key);
    }
    for (const set of [this.sealedHours, this.daysStreamed]) {
      for (const key of [...set]) if (key.startsWith(`${stream}/`) && key.split('/')[2]! < yesterday) set.delete(key);
    }
    if (this.sealer === undefined) return;
    const hourNow = Math.floor((minute.time % 86_400) / 3_600);
    const due: Array<{ date: string; hour: number }> = [];
    if (this.daysStreamed.has(`${stream}/${yesterday}`)) for (let hour = 0; hour < 24; hour++) due.push({ date: yesterday, hour });
    for (let hour = 0; hour < hourNow; hour++) due.push({ date: today, hour });
    const sealer = this.sealer;
    await Promise.all(
      due
        .filter(({ date, hour }) => !this.sealedHours.has(`${stream}/${date}/${hour}`))
        .map(async ({ date, hour }) => {
          const ref = { provider, symbol, date };
          await sealer.seal(ref, hour, await this.liveDay(ref));
          this.sealedHours.add(`${stream}/${date}/${hour}`);
        }),
    );
  }

  private liveDay(ref: RawDayRef): Promise<Bar[]> {
    const key = `${ref.provider}/${ref.symbol}/${ref.date}`;
    let minutes = this.liveDays.get(key);
    if (minutes === undefined) {
      minutes = this.deps.raw.getLiveMinutes(ref);
      this.liveDays.set(key, minutes);
    }
    return minutes;
  }

  private async updateCache(symbol: string, minute: Bar, rebuilt: Map<Timeframe, Bar[]>): Promise<void> {
    try {
      if (this.staleCache.has(symbol)) {
        await this.recent.invalidate(symbol, CACHED_TIMEFRAMES);
        this.staleCache.delete(symbol);
      }
      await this.recent.onBarClosed(barClosedEvents(symbol, minute, rebuilt));
    } catch (error) {
      this.staleCache.add(symbol);
      throw error;
    }
  }

  private announce(updates: readonly LiveBarUpdate[]): void {
    this.announcer.publish(updates).catch((error: unknown) => this.deps.log(`live announcement failed (charts resync on the next): ${String(error)}`));
  }

  private resync(why: string): void {
    this.announcer.resync().catch((error: unknown) => this.deps.log(`live resync (${why}) failed to send: ${String(error)}`));
  }
}
