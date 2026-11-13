// Writing settled days to the cooked store (M1-15). Live minutes are cooked in
// memory; once a UTC day has ended, the compactor cooks it from raw into the
// cooked partitions, every intraday timeframe from one read, then moves the
// instrument's watermark past it. One rewrite per timeframe per day, not per
// minute.
//
// Day by day, the watermark moving only after a day is written: a crash
// leaves the store and the watermark consistent, and the next run redoes at
// most that day. Readers roll up everything from the watermark on, so a
// compactor that falls behind makes reads longer, never wrong. One compactor
// per instrument (its hydration process) at a time.

import type { BarTime, Instrument } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import type { CookIntraday } from './cook-intraday.js';
import type { CookedWatermarkPort } from './cooked-watermark-port.js';

const DAY = 86_400;

export interface CookedCompactorDeps {
  readonly cook: Pick<CookIntraday, 'cookRangeAll'>;
  readonly watermarks: CookedWatermarkPort;
  /** With no watermark yet, how many days back to start. Default 7. */
  readonly initialDays?: number;
}

export class CookedCompactor {
  constructor(private readonly deps: CookedCompactorDeps) {}

  /**
   * Write every settled day before `today` (a UTC midnight) that the
   * watermark has not passed. Returns the number of days written.
   */
  async compact(instrument: Instrument, today: BarTime): Promise<number> {
    const symbol = instrument.symbol;
    const mark = await this.deps.watermarks.getWatermark(symbol);
    let day = mark ?? barTime(today - (this.deps.initialDays ?? 7) * DAY);
    let written = 0;
    for (; day < today; day = barTime(day + DAY)) {
      await this.deps.cook.cookRangeAll(instrument, day, barTime(day + DAY - 1));
      await this.deps.watermarks.setWatermark(symbol, barTime(day + DAY));
      written++;
    }
    return written;
  }
}
