// Building 1-minute bars from a live trade stream (M1-05). Pure: imports only
// @aia/shared-kernel, no I/O, and time is always an argument.
//
// The rules, in order of importance:
// - A bar is built only from a minute seen whole. The minute in progress when
//   the stream starts, or resumes after a disconnect, is partial, so it is not
//   built: building it would write a wrong bar to write-once raw. It counts as
//   a gap instead, which gap repair fills from the provider's history.
// - Trades are bucketed by the exchange's trade time, never by when they
//   arrived. A minute closes once the clock is `grace` past its end, so trades
//   that arrive a little late still land in their own minute.
// - A trade for a minute already closed is dropped and counted, never written:
//   the minute is already in raw, and raw is never edited.
// - A minute with no trades has no bar (docs/bar-rules.md, "Missing minute").
// - Open and close follow the provider's trade order (`seq`), not arrival
//   order, so trades delivered out of order still give the right open/close.
//
// The trade type speaks our language only (CLAUDE.md rule 7): our scaled
// units, our clock. Every provider adapter converts into it.

import type { Bar, BarTime, Price, Volume } from '@aia/shared-kernel';
import { assertCoherent, barTime, volume, zonedDateKey } from '@aia/shared-kernel';

export class LiveMinutesError extends Error {}

const MINUTE_MS = 60_000;
const MINUTE = 60;

/** One trade, in our units. */
export interface LiveTrade {
  /** The exchange's trade time, epoch milliseconds. */
  readonly timeMs: number;
  /** The provider's trade order for this instrument: ascending in trade order, unique. */
  readonly seq: number;
  /** At the instrument's raw price scale. */
  readonly price: Price;
  /** At the instrument's raw volume scale. */
  readonly size: Volume;
}

/** Minutes not covered by the live stream: `[from, until)`, whole minutes, UTC. */
export interface LiveGap {
  readonly from: BarTime;
  readonly until: BarTime;
}

/**
 * `partial`: the trade belongs to a minute the builder joined part-way (at
 * start or after a reconnect), which is skipped by design. `late`: its minute
 * had already closed when it arrived.
 */
export type TradeOutcome = 'added' | 'late' | 'partial' | 'duplicate';

interface Accumulator {
  openSeq: number;
  open: Price;
  closeSeq: number;
  close: Price;
  high: Price;
  low: Price;
  volume: number;
  readonly seen: Set<number>;
}

/** Start of the minute containing `ms`, in epoch seconds. */
export function minuteOf(ms: number): BarTime {
  return barTime(Math.floor(ms / MINUTE_MS) * MINUTE);
}

/** Start of the first minute that begins at or after `ms`. */
function firstWholeMinuteFrom(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE;
}

/** The forming bars of one instrument. */
export class MinuteBuilder {
  private readonly forming = new Map<number, Accumulator>();
  /** Every minute starting at or before this has closed. */
  private closedThrough: number | undefined;
  /** The first whole minute since the last resume; earlier minutes are partial. */
  private firstWhole = 0;

  /**
   * Begin, or begin again after a disconnect, at `nowMs`. The minute in
   * progress is partial and is skipped: only trades from the next whole
   * minute on are built. Returns that first whole minute.
   */
  resume(nowMs: number): BarTime {
    const first = firstWholeMinuteFrom(nowMs);
    this.forming.clear();
    this.closedThrough = first - MINUTE;
    this.firstWhole = first;
    return barTime(first);
  }

  /** Whether `resume` has been called. Trades before that are refused. */
  get running(): boolean {
    return this.closedThrough !== undefined;
  }

  add(trade: LiveTrade): TradeOutcome {
    if (this.closedThrough === undefined) throw new LiveMinutesError('MinuteBuilder.add before resume');
    const minute = minuteOf(trade.timeMs);
    if (minute <= this.closedThrough) return minute < this.firstWhole ? 'partial' : 'late';
    const acc = this.forming.get(minute);
    if (acc === undefined) {
      this.forming.set(minute, {
        openSeq: trade.seq,
        open: trade.price,
        closeSeq: trade.seq,
        close: trade.price,
        high: trade.price,
        low: trade.price,
        volume: trade.size,
        seen: new Set([trade.seq]),
      });
      return 'added';
    }
    if (acc.seen.has(trade.seq)) return 'duplicate';
    acc.seen.add(trade.seq);
    if (trade.seq < acc.openSeq) {
      acc.openSeq = trade.seq;
      acc.open = trade.price;
    }
    if (trade.seq > acc.closeSeq) {
      acc.closeSeq = trade.seq;
      acc.close = trade.price;
    }
    if (trade.price > acc.high) acc.high = trade.price;
    if (trade.price < acc.low) acc.low = trade.price;
    acc.volume += trade.size;
    return 'added';
  }

  /**
   * Close every minute that ended at least `graceMs` before `nowMs`, and
   * return the bars of those that had trades, ascending. Minutes with no
   * trades close too, so a trade arriving for one later is refused as late.
   */
  closeDue(nowMs: number, graceMs: number): Bar[] {
    if (this.closedThrough === undefined) return [];
    // A minute starting at `m` ends at `m + 60`; it may close once that end
    // is `grace` behind us.
    const last = Math.floor((nowMs - graceMs) / MINUTE_MS) * MINUTE - MINUTE;
    if (last <= this.closedThrough) return [];
    const bars: Bar[] = [];
    for (const minute of [...this.forming.keys()].sort((a, b) => a - b)) {
      if (minute > last) break;
      const acc = this.forming.get(minute);
      this.forming.delete(minute);
      if (acc !== undefined) bars.push(toBar(minute, acc));
    }
    this.closedThrough = last;
    return bars;
  }

  /**
   * The stream dropped. Minutes not yet closed are partial and discarded.
   * Returns the first minute not covered, where the gap starts, or
   * `undefined` if the stream never ran.
   */
  interrupt(): BarTime | undefined {
    this.forming.clear();
    const closed = this.closedThrough;
    this.closedThrough = undefined;
    return closed === undefined ? undefined : barTime(closed + MINUTE);
  }
}

function toBar(minute: number, acc: Accumulator): Bar {
  const bar: Bar = {
    time: barTime(minute),
    open: acc.open,
    high: acc.high,
    low: acc.low,
    close: acc.close,
    volume: volume(acc.volume),
  };
  assertCoherent(bar);
  return bar;
}

/** A gap split at UTC midnights, since raw is kept per UTC day. */
export function splitGapByDay(gap: LiveGap): Array<{ readonly date: string; readonly gap: LiveGap }> {
  if (gap.until <= gap.from) return [];
  const parts: Array<{ date: string; gap: LiveGap }> = [];
  let from: number = gap.from;
  while (from < gap.until) {
    const nextMidnight = (Math.floor(from / 86_400) + 1) * 86_400;
    const until = Math.min(nextMidnight, gap.until);
    parts.push({ date: zonedDateKey(from, 'UTC'), gap: { from: barTime(from), until: barTime(until) } });
    from = until;
  }
  return parts;
}
