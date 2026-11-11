// Recent bars, cache first (M2-02).
//
// Reads are answered from the cached window when it can answer them, and
// otherwise from the store: the cooked store for 5m and up, the 1-minute
// source for 1m, which is not cooked. A miss for the newest bars refills the
// window. Writers call `onBarClosed` after the store has the new bars, so the
// cache never runs ahead of the store; if a cache write fails, the window is
// dropped, so the next read refills it rather than serving a stale one.
//
// The History API (M2-03) reads through this; M2-04's live gateway consumes
// the same BarClosed events.

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import type { BarClosed } from '../domain/bar-closed.js';
import { RECENT_BARS_CAPACITY, lookbackStart, readWindow } from '../domain/recent-window.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';
import type { RecentBarsCachePort } from './recent-bars-cache-port.js';

export class RecentBarsError extends Error {}

export interface RecentBarsDeps {
  readonly cache: RecentBarsCachePort;
  readonly store: Pick<CookedBarStorePort, 'getRange'>;
  readonly minutes: OneMinuteBarSourcePort;
  /** Must match the cache adapter's capacity. */
  readonly capacity?: number;
}

export interface RecentBarsQuery {
  /** How many bars, newest last. */
  readonly limit: number;
  /** Only bars opening before this time; omitted for the newest bars. */
  readonly before?: BarTime;
  /** The current time, passed in. */
  readonly now: BarTime;
}

export interface RecentBarsPageQuery extends RecentBarsQuery {
  /** Where the instrument's history starts; no page looks earlier. */
  readonly earliest: BarTime;
}

export interface BarsPage {
  /** Ascending; `limit` bars unless history ran out or the scan stopped. */
  readonly bars: Bar[];
  /** The `before` for the next older page, or `null` once history is exhausted. */
  readonly next: BarTime | null;
}

/** Widenings per page: the last covers 64 `limit`s of timeframe lengths. */
const PAGE_WIDENINGS = 6;

export class RecentBars {
  private readonly capacity: number;

  constructor(private readonly deps: RecentBarsDeps) {
    this.capacity = deps.capacity ?? RECENT_BARS_CAPACITY;
  }

  /**
   * The newest `limit` bars (before `before`, if given), ascending. On a store
   * read, fewer than `limit` can come back for an instrument with market
   * sessions; see `lookbackStart`.
   */
  async read(instrument: Instrument, timeframe: Timeframe, query: RecentBarsQuery): Promise<Bar[]> {
    const { limit, before, now } = query;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RecentBarsError(`limit must be a positive whole number, got ${limit}`);
    }
    const until = before === undefined ? now : barTime(before - 1);
    const lookback = lookbackStart(timeframe, until, limit);
    const symbol = instrument.symbol;

    const window = await this.deps.cache.get(symbol, timeframe);
    const hit = window === undefined ? undefined : readWindow(window, limit, before, lookback);
    if (hit !== undefined) return hit;

    if (before === undefined && limit <= this.capacity) {
      const filled = await this.refill(symbol, timeframe, now);
      return filled.slice(Math.max(filled.length - limit, 0));
    }
    const bars = await this.fromStore(symbol, timeframe, lookback, until);
    return bars.slice(Math.max(bars.length - limit, 0));
  }

  /**
   * One page of history for the History API (M2-03): the newest `limit` bars
   * before `before`, and the `before` to ask for next.
   *
   * `read` looks back `limit` timeframe lengths, which can hold fewer bars
   * across closed market sessions or missing history. A page widens the look
   * back, doubling, until it has `limit` bars or reaches `earliest` (where the
   * instrument's history starts), reading only the newly covered range each
   * time. It stops after a few widenings so one request stays bounded; `next`
   * then points at where it stopped, and the page may hold fewer bars, even
   * none. `next` is `null` only once the page reaches `earliest`.
   */
  async page(instrument: Instrument, timeframe: Timeframe, query: RecentBarsPageQuery): Promise<BarsPage> {
    const { limit, before, now, earliest } = query;
    let bars = await this.read(instrument, timeframe, { limit, now, ...(before === undefined ? {} : { before }) });
    if (bars.length >= limit) return { bars, next: (bars[0] as Bar).time };

    const until = before === undefined ? now : barTime(before - 1);
    let span = limit;
    // Everything from `low` to `until` has been read. The read may have come
    // from a wider refill, so its oldest bar can sit below its own lookback.
    let low = barTime(Math.min(lookbackStart(timeframe, until, span), bars[0]?.time ?? Infinity));
    for (let round = 0; round < PAGE_WIDENINGS && bars.length < limit && low > earliest; round++) {
      span *= 2;
      const from = barTime(Math.max(lookbackStart(timeframe, until, span), earliest));
      const older = await this.fromStore(instrument.symbol, timeframe, from, barTime(low - 1));
      bars = [...older, ...bars];
      low = from;
    }
    if (bars.length >= limit) {
      const page = bars.slice(bars.length - limit);
      return { bars: page, next: (page[0] as Bar).time };
    }
    return { bars, next: low > earliest ? low : null };
  }

  /**
   * Bring the cache up to date with bars the store now holds. Call after the
   * store write. Events for one key are applied in the order given.
   */
  async onBarClosed(events: readonly BarClosed[]): Promise<void> {
    for (const { symbol, timeframe, bar } of events) {
      try {
        await this.deps.cache.apply(symbol, timeframe, bar);
      } catch (error) {
        // A window that missed an update must not be served. If dropping it
        // fails too, the caller has to know.
        try {
          await this.deps.cache.invalidate(symbol, timeframe);
        } catch {
          throw new RecentBarsError(
            `cache update for ${symbol} ${timeframe} failed and its window could not be dropped: ${String(error)}`,
          );
        }
      }
    }
  }

  /** Drop cached windows, after the store was rewritten other than through BarClosed (a re-cook). */
  async invalidate(symbol: string, timeframes: readonly Timeframe[]): Promise<void> {
    for (const timeframe of timeframes) await this.deps.cache.invalidate(symbol, timeframe);
  }

  /** Read the newest `capacity` bars' lookback from the store and make it the window. */
  private async refill(symbol: string, timeframe: Timeframe, now: BarTime): Promise<Bar[]> {
    const version = await this.deps.cache.version(symbol, timeframe);
    const from = lookbackStart(timeframe, now, this.capacity);
    const bars = await this.fromStore(symbol, timeframe, from, now);
    const kept = bars.slice(Math.max(bars.length - this.capacity, 0));
    const start = kept.length < bars.length ? (kept[0] as Bar).time : from;
    // If a bar changed during the read, the fill is refused (the window would
    // miss it) and the next read tries again; this answer is still the store
    // as it was read.
    await this.deps.cache.fill(symbol, timeframe, { from: start, bars: kept }, version);
    return kept;
  }

  private fromStore(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    return timeframe === '1m'
      ? this.deps.minutes.read(symbol, from, until)
      : this.deps.store.getRange(symbol, timeframe, from, until);
  }
}
