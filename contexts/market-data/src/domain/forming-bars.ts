// Forming bars for one instrument (M2-04): what each timeframe's newest bar
// looks like with the minutes not yet stored, so charts tick with trades.
// Pure: no I/O, no clock.
//
// A forming 5m to 4h bar is rolled up, with the same `rollUp` cooking uses,
// from three parts of its period:
//   1. the newest cooked bar of that period (everything the store holds up to
//      the minute last cooked),
//   2. minutes stored since but not yet cooked (cooking takes a moment, and
//      the next minute's trades do not wait for it),
//   3. the minutes not yet stored (forming, or closed and being written).
// Rolling the cooked bar up with later minutes gives the same bar as rolling
// up all its minutes: open from the first part, close from the last, high and
// low the extremes, volume the sum.
//
// Until the first minute is cooked, what the store holds for the current
// periods is unknown, so only the 1m bar forms; higher timeframes start
// forming from the first cooked minute on, about a minute after start.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

import { barClosedEvents } from './bar-closed.js';
import type { LiveBarUpdate } from './live-update.js';
import { storedUpdates } from './live-update.js';
import { rollUp } from './roll-up.js';

/** Stored-but-uncooked minutes kept at most: a 4h period's worth. */
const MAX_UNCOOKED = 240;

export class FormingBars {
  /** Per timeframe, the newest cooked bar. */
  private readonly newestCooked = new Map<Timeframe, Bar>();
  /** The last minute cooked; `undefined` until the first. */
  private cookedThrough: BarTime | undefined;
  /** Minutes stored after `cookedThrough`, ascending. */
  private uncooked: Bar[] = [];
  /** Minutes not yet stored, ascending. */
  private unstored: readonly Bar[] = [];

  constructor(
    private readonly instrument: Instrument,
    /** The cooked timeframes above 1m. */
    private readonly timeframes: readonly Timeframe[],
    private readonly calendar?: MarketCalendar,
  ) {}

  /** The minutes not yet stored changed: the forming updates, 1m first. */
  unstoredChanged(minutes: readonly Bar[]): LiveBarUpdate[] {
    // A stored minute is final; a report that still lists one is stale.
    const storedThrough = this.uncooked.at(-1)?.time ?? this.cookedThrough;
    this.unstored = storedThrough === undefined ? minutes : minutes.filter((m) => m.time > storedThrough);
    return this.forming();
  }

  /** A minute was stored (not yet cooked). */
  stored(minute: Bar): void {
    this.unstored = this.unstored.filter((m) => m.time > minute.time);
    if (this.cookedThrough !== undefined && minute.time <= this.cookedThrough) return;
    if (this.uncooked.some((m) => m.time >= minute.time)) return;
    this.uncooked.push(minute);
    if (this.uncooked.length > MAX_UNCOOKED) this.uncooked = this.uncooked.slice(-MAX_UNCOOKED);
  }

  /**
   * `minute` was cooked, giving `rebuilt` (what `CookIntraday.applyNewMinutesToAll`
   * returns), and the recent-bars cache has them. Returns the stored updates,
   * then the forming updates rebuilt on them, so a chart applying them in
   * order ends with the forming values.
   */
  cooked(minute: Bar, rebuilt: ReadonlyMap<Timeframe, readonly Bar[]>): LiveBarUpdate[] {
    for (const [timeframe, bars] of rebuilt) {
      const newest = bars.at(-1);
      const known = this.newestCooked.get(timeframe);
      if (newest !== undefined && (known === undefined || newest.time >= known.time)) this.newestCooked.set(timeframe, newest);
    }
    if (this.cookedThrough === undefined || minute.time > this.cookedThrough) this.cookedThrough = minute.time;
    const through = this.cookedThrough;
    this.uncooked = this.uncooked.filter((m) => m.time > through);
    this.unstored = this.unstored.filter((m) => m.time > minute.time);
    return [...storedUpdates(barClosedEvents(this.instrument.symbol, minute, rebuilt)), ...this.forming()];
  }

  /** The stream dropped: minutes not yet stored will never be. */
  reset(): void {
    this.unstored = [];
  }

  private forming(): LiveBarUpdate[] {
    const symbol = this.instrument.symbol;
    const updates: LiveBarUpdate[] = this.unstored.map((bar) => ({ symbol, timeframe: '1m', bar, forming: true }));
    if (this.unstored.length === 0 || this.cookedThrough === undefined) return updates;

    for (const timeframe of this.timeframes) {
      const periodOf = (minute: Bar) => alignToTimeframe(this.instrument, timeframe, minute.time, this.calendar);
      const periods = new Set<BarTime>();
      for (const minute of this.unstored) {
        const period = periodOf(minute);
        if (period !== undefined) periods.add(period);
      }
      for (const period of [...periods].sort((a, b) => a - b)) {
        const cooked = this.newestCooked.get(timeframe);
        const parts = [
          ...(cooked !== undefined && cooked.time === period ? [cooked] : []),
          ...this.uncooked.filter((m) => periodOf(m) === period),
          ...this.unstored.filter((m) => periodOf(m) === period),
        ];
        for (const bar of rollUp(this.instrument, timeframe, parts, this.calendar)) {
          updates.push({ symbol, timeframe, bar, forming: true });
        }
      }
    }
    return updates;
  }
}
