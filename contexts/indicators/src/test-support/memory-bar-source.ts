// A bar source over an array, for engine tests. Counts reads.

import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';

import type { ClosedBarsQuery, IndicatorBarSourcePort } from '../application/indicator-bar-source-port.js';

export class MemoryBarSource implements IndicatorBarSourcePort {
  reads = 0;
  constructor(public bars: Bar[]) {}

  closedBars(_instrument: Instrument, _timeframe: Timeframe, query: ClosedBarsQuery): Promise<readonly Bar[]> {
    this.reads += 1;
    if (query.from === undefined) return Promise.resolve(this.bars.slice(-query.limit));
    const from = query.from;
    return Promise.resolve(this.bars.filter((b) => b.time >= from).slice(0, query.limit));
  }
}
