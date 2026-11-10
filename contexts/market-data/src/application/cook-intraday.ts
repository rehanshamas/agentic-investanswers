// Cook the intraday timeframes (5m, 15m, 1h, 4h) from stored 1-minute bars.
//
// D/W/M and the stock session specifics are M1-08's; this use case refuses
// calendar timeframes rather than half-handling them.

import type {
  Bar,
  BarTime,
  Instrument,
  MarketCalendar,
  Timeframe,
} from '@aia/shared-kernel';
import { barTime, isIntraday, timeframeSeconds } from '@aia/shared-kernel';

import { partitionOf } from '../domain/cooked-partition.js';
import { affectedBarTimes, rollUp } from '../domain/roll-up.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export class CookIntradayError extends Error {}

/** The intraday timeframes built from 1-minute bars, shortest first. */
export const INTRADAY_ROLLUPS: readonly Timeframe[] = ['5m', '15m', '1h', '4h'];

function spanOf(timeframe: Timeframe): number {
  if (!isIntraday(timeframe)) {
    throw new CookIntradayError(
      `${timeframe} is a calendar timeframe; cooking it is M1-08's job, not this one`,
    );
  }
  const seconds = timeframeSeconds(timeframe);
  if (seconds === undefined) {
    throw new CookIntradayError(`${timeframe} has no fixed length`);
  }
  return seconds;
}

export interface CookIntradayDeps {
  readonly source: OneMinuteBarSourcePort;
  readonly store: CookedBarStorePort;
  /** Required for instruments with sessions, ignored otherwise. */
  readonly calendar?: MarketCalendar;
}

export class CookIntraday {
  constructor(private readonly deps: CookIntradayDeps) {}

  /**
   * Rebuild one timeframe across a range, from the 1-minute bars in it.
   *
   * The first and last bars can be partial if the range cuts through a bucket,
   * so callers rebuilding a partition should pass whole bucket boundaries.
   * M1-10's rebuild check does exactly this over a whole partition.
   */
  async cookRange(
    instrument: Instrument,
    timeframe: Timeframe,
    from: BarTime,
    until: BarTime,
  ): Promise<Bar[]> {
    spanOf(timeframe);
    const minutes = await this.deps.source.read(instrument.symbol, from, until);
    const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
    await this.writeMerged(instrument.symbol, timeframe, bars, (time) => time >= from && time <= until);
    return bars;
  }

  /**
   * Apply newly arrived 1-minute bars, touching only the bars they affect.
   *
   * This is the requirement in the backlog row: "one new 1m updates only the
   * affected bars". For each affected bucket the full bucket is re-read from
   * the source and rebuilt, so a late-arriving minute inside an already-cooked
   * bucket produces the same bar as a full re-cook would — which is the
   * property M1-10 later asserts across the whole store.
   */
  async applyNewMinutes(
    instrument: Instrument,
    timeframe: Timeframe,
    newMinutes: readonly Bar[],
  ): Promise<Bar[]> {
    const span = spanOf(timeframe);
    const affected = affectedBarTimes(instrument, timeframe, newMinutes, this.deps.calendar);
    if (affected.length === 0) return [];

    const rebuilt: Bar[] = [];
    for (const open of affected) {
      // The whole bucket, not just the new minutes: a bar is only correct if
      // built from every minute it covers.
      const minutes = await this.deps.source.read(
        instrument.symbol,
        open,
        barTime(open + span - 1),
      );
      const bars = rollUp(instrument, timeframe, minutes, this.deps.calendar);
      const bar = bars.find((b) => b.time === open);
      if (bar !== undefined) rebuilt.push(bar);
    }

    const replaced = new Set(affected);
    await this.writeMerged(instrument.symbol, timeframe, rebuilt, (time) => replaced.has(time));
    return rebuilt;
  }

  /**
   * Write `bars` without losing the rest of their partitions.
   *
   * The store's `put` replaces each partition it touches whole (a month for
   * intraday), so writing only the rebuilt bars would delete every other bar
   * of that month. For each touched partition this reads what is stored,
   * drops the bars `replaces` covers, adds `bars`, and writes it all back.
   */
  private async writeMerged(
    symbol: string,
    timeframe: Timeframe,
    bars: readonly Bar[],
    replaces: (time: BarTime) => boolean,
  ): Promise<void> {
    const byPartition = new Map<string, Bar[]>();
    for (const bar of bars) {
      const partition = partitionOf(timeframe, bar.time);
      const group = byPartition.get(partition);
      if (group === undefined) byPartition.set(partition, [bar]);
      else group.push(bar);
    }
    for (const [partition, fresh] of byPartition) {
      const stored = (await this.deps.store.getPartition(symbol, timeframe, partition)) ?? [];
      const kept = stored.filter((bar) => !replaces(bar.time));
      const merged = [...kept, ...fresh].sort((a, b) => a.time - b.time);
      await this.deps.store.put(symbol, timeframe, merged);
    }
  }

  /** Apply new minutes to every intraday timeframe, shortest first. */
  async applyNewMinutesToAll(
    instrument: Instrument,
    newMinutes: readonly Bar[],
  ): Promise<Map<Timeframe, Bar[]>> {
    const result = new Map<Timeframe, Bar[]>();
    for (const timeframe of INTRADAY_ROLLUPS) {
      result.set(timeframe, await this.applyNewMinutes(instrument, timeframe, newMinutes));
    }
    return result;
  }
}
