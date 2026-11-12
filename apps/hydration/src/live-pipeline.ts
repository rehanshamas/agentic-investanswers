// What `pnpm live` does with each live event, per instrument (M1-15):
// composition only, so `pnpm live`, the replay tests and `pnpm load-hydration`
// all run the same steps.
//
// A minute the live stream has stored is cooked, then applied to the
// recent-bars cache, then announced to charts, in that order and one minute at
// a time per instrument. Forming minutes are announced at once. Anything that
// may leave charts differing from the store announces a resync.

import type { ProviderOf, RawDayRef } from '@aia/hydration';
import { RawMinuteSource } from '@aia/hydration';
import type { CookedBarStorePort, LiveBarUpdate, LiveBarsBusPort, RecentBarsCachePort } from '@aia/market-data';
import { CookIntraday, FormingBars, INTRADAY_ROLLUPS, LiveAnnouncer, RecentBars, barClosedEvents } from '@aia/market-data';
import type { Bar, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { zonedDateKey } from '@aia/shared-kernel';

import { CACHED_TIMEFRAMES } from './cache.js';

export interface LivePipelineDeps {
  readonly instruments: readonly Instrument[];
  readonly raw: {
    getDay(ref: RawDayRef): Promise<Bar[] | undefined>;
    getLiveMinutes(ref: RawDayRef): Promise<Bar[]>;
  };
  readonly rawProviderOf: ProviderOf;
  readonly liveProviderOf: ProviderOf;
  readonly cooked: CookedBarStorePort;
  readonly cache: RecentBarsCachePort;
  readonly bus: Pick<LiveBarsBusPort, 'publish'>;
  /** Unique per process run. */
  readonly publisher: string;
  readonly calendar?: MarketCalendar;
  readonly log: (line: string) => void;
}

export class LivePipeline {
  private readonly bySymbol: ReadonlyMap<string, Instrument>;
  private readonly forming: ReadonlyMap<string, FormingBars>;
  /** Today's live minutes, held in memory once read, so cooking a new minute does not list the day again. */
  private readonly liveDays = new Map<string, Promise<Bar[]>>();
  private readonly cook: CookIntraday;
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
    this.cook = new CookIntraday({
      source: minutes,
      store: deps.cooked,
      ...(deps.calendar === undefined ? {} : { calendar: deps.calendar }),
    });
    this.recent = new RecentBars({ cache: deps.cache, store: deps.cooked, minutes });
    this.announcer = new LiveAnnouncer(deps.bus, deps.publisher);
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
      next = previous
        .then(() => this.liveDay(ref))
        .then(() => this.cook.applyNewMinutesToAll(instrument, [bar]))
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
    this.chains.set(symbol, next);
    return next;
  }

  /** Every minute handed in so far is done. */
  async settled(): Promise<void> {
    await Promise.all(this.chains.values());
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
