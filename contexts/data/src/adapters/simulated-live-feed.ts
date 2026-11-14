// What `pnpm live` would announce for made-up minutes (M1-16), for load tests
// and demos: the same forming and stored bar rules (FormingBars, rollUp), so
// a simulated chart behaves like a real one. One per instrument.

import type { LiveBarUpdate } from '@aia/market-data';
import { FormingBars, INTRADAY_ROLLUPS, rollUp } from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

export class SimulatedLiveFeed {
  private readonly forming: FormingBars;
  private readonly storedMinutes: Bar[] = [];

  constructor(readonly instrument: Instrument) {
    this.forming = new FormingBars(instrument, INTRADAY_ROLLUPS);
  }

  /** The minutes not yet stored changed (forming, or closed and being written): the forming updates. */
  unstoredChanged(minutes: readonly Bar[]): LiveBarUpdate[] {
    return this.forming.unstoredChanged(minutes);
  }

  /**
   * A minute was stored and cooked: its stored updates (the 1m bar and each
   * bar it rebuilt), then the forming bars rebuilt on top of them.
   */
  stored(minute: Bar): LiveBarUpdate[] {
    this.forming.stored(minute);
    this.storedMinutes.push(minute);
    const rebuilt = new Map<Timeframe, Bar[]>();
    for (const tf of INTRADAY_ROLLUPS) {
      const period = alignToTimeframe(this.instrument, tf, minute.time);
      const inPeriod = this.storedMinutes.filter((b) => alignToTimeframe(this.instrument, tf, b.time) === period);
      rebuilt.set(tf, rollUp(this.instrument, tf, inPeriod));
    }
    return this.forming.cooked(minute, rebuilt);
  }
}
