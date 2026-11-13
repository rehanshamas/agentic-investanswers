// Cooking live minutes in memory (M1-15). For each new minute, the 5m to 4h
// bars it belongs to, rebuilt from every minute of their buckets, as
// `CookIntraday.applyNewMinutes` would, but without touching the cooked store:
// the compactor writes settled days, and readers roll up the rest from raw.
//
// It keeps the minutes of the longest bucket in progress. The first minute,
// or one older than what it holds, reads the bucket's earlier minutes from
// the source once; after that, minutes arrive one by one.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, timeframeSeconds } from '@aia/shared-kernel';

import { rollUp } from '../domain/roll-up.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface LiveCookDeps {
  readonly instrument: Instrument;
  /** Intraday timeframes above 1m. */
  readonly timeframes: readonly Timeframe[];
  readonly source: OneMinuteBarSourcePort;
  readonly calendar?: MarketCalendar;
}

export class LiveCook {
  /** Ascending minutes from `from` on. */
  private minutes: Bar[] = [];
  private from: BarTime | undefined;

  constructor(private readonly deps: LiveCookDeps) {}

  /** A minute was stored: the bars it rebuilt, per timeframe (what `applyNewMinutesToAll` returns). */
  async apply(minute: Bar): Promise<Map<Timeframe, Bar[]>> {
    const { instrument, timeframes, calendar } = this.deps;
    const opens = new Map<Timeframe, BarTime>();
    for (const tf of timeframes) {
      const open = alignToTimeframe(instrument, tf, minute.time, calendar);
      if (open !== undefined) opens.set(tf, open);
    }
    const earliest = Math.min(...opens.values(), minute.time);
    if (this.from === undefined || earliest < this.from) {
      const earlier = await this.deps.source.read(instrument.symbol, barTime(earliest), barTime(minute.time - 1));
      this.minutes = merge(earlier, this.minutes.filter((m) => m.time >= minute.time));
      this.from = barTime(earliest);
    }
    this.minutes = merge(this.minutes.filter((m) => m.time >= earliest && m.time !== minute.time), [minute]);
    this.from = barTime(Math.max(this.from, earliest));

    const rebuilt = new Map<Timeframe, Bar[]>();
    for (const tf of timeframes) {
      const open = opens.get(tf);
      const span = timeframeSeconds(tf);
      if (open === undefined || span === undefined) {
        rebuilt.set(tf, []);
        continue;
      }
      const bucket = this.minutes.filter((m) => m.time >= open && m.time < open + span);
      rebuilt.set(tf, rollUp(instrument, tf, bucket, calendar).filter((b) => b.time === open));
    }
    return rebuilt;
  }
}

function merge(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of a) byTime.set(bar.time, bar);
  for (const bar of b) byTime.set(bar.time, bar);
  return [...byTime.values()].sort((x, y) => x.time - y.time);
}
