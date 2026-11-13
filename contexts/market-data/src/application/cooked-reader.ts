// Reading cooked bars as settled store plus tail (M1-15).
//
// Bars before the instrument's watermark come from the cooked store; bars
// from it on are rolled up from raw 1-minute bars here, with the same
// `rollUp` cooking uses. Live cooking therefore never writes the store every
// minute, yet readers always see every stored minute. An instrument with no
// watermark yet is read from the store alone, as before M1-15.
//
// It has the cooked store's read shape, so RecentBars and the History API use
// it unchanged.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

import { tailStart } from '../domain/cooked-tail.js';
import { rollUp } from '../domain/roll-up.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { CookedWatermarkPort } from './cooked-watermark-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface CookedReaderDeps {
  readonly store: Pick<CookedBarStorePort, 'getRange'>;
  readonly watermarks: Pick<CookedWatermarkPort, 'getWatermark'>;
  readonly minutes: OneMinuteBarSourcePort;
  readonly instruments: readonly Instrument[];
  readonly calendar?: MarketCalendar;
  /** Epoch milliseconds, for how long a watermark read is reused. */
  readonly nowMs: () => number;
  /** Default 30 s. A stale watermark only makes the tail longer, never wrong. */
  readonly watermarkTtlMs?: number;
}

export class CookedReader implements Pick<CookedBarStorePort, 'getRange'> {
  private readonly instruments: ReadonlyMap<string, Instrument>;
  private readonly marks = new Map<string, { through: BarTime | undefined; at: number }>();

  constructor(private readonly deps: CookedReaderDeps) {
    this.instruments = new Map(deps.instruments.map((i) => [i.symbol, i]));
  }

  /** Bars in `[from, until]` inclusive, ascending: stored before the tail, rolled up from raw after. */
  async getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = this.instruments.get(symbol);
    const span = timeframeSeconds(timeframe);
    // Calendar timeframes join with M1-08; until then they are read from the store alone.
    if (instrument === undefined || span === undefined) return this.deps.store.getRange(symbol, timeframe, from, until);
    const through = await this.watermark(symbol);
    if (through === undefined) return this.deps.store.getRange(symbol, timeframe, from, until);

    const start = tailStart(instrument, timeframe, through, this.deps.calendar);
    const stored = from < start ? await this.deps.store.getRange(symbol, timeframe, from, barTime(Math.min(until, start - 1))) : [];
    if (until < start) return stored;
    const tailFrom = barTime(Math.max(from, start));
    const minutes = await this.deps.minutes.read(symbol, tailFrom, barTime(until + span - 1));
    const tail = rollUp(instrument, timeframe, minutes, this.deps.calendar).filter((b) => b.time >= tailFrom && b.time <= until);
    return [...stored, ...tail];
  }

  private async watermark(symbol: string): Promise<BarTime | undefined> {
    const now = this.deps.nowMs();
    const known = this.marks.get(symbol);
    if (known !== undefined && now - known.at < (this.deps.watermarkTtlMs ?? 30_000)) return known.through;
    const through = await this.deps.watermarks.getWatermark(symbol);
    this.marks.set(symbol, { through, at: now });
    return through;
  }
}
