// The rebuild check (M1-10): re-cook every cooked partition from raw, in
// memory, and compare it with what the cooked store holds. It writes nothing.
//
// CLAUDE.md rule 3 says cooked is always rebuildable from raw; this is the
// check that it still is. It reads raw once per month and rolls it up to every
// intraday timeframe, the same `rollUp` cooking uses. Calendar timeframes
// (1D, 1W, 1M) join when M1-08 cooks them.

import type { Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';

import { partitionBounds } from '../domain/cooked-partition.js';
import type { RebuildDiff } from '../domain/rebuild-diff.js';
import { diffBars } from '../domain/rebuild-diff.js';
import { rollUp } from '../domain/roll-up.js';
import { INTRADAY_ROLLUPS } from './cook-intraday.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

export interface RebuildCheckDeps {
  readonly source: OneMinuteBarSourcePort;
  /** Read only: the check never writes. */
  readonly store: Pick<CookedBarStorePort, 'getPartition'>;
  readonly calendar?: MarketCalendar;
}

export interface PartitionResult {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly partition: string;
  /**
   * - `compared`: raw and a stored file both exist; `diff` says how they agree.
   * - `not-cooked`: raw exists but no stored file: every rebuilt bar is missing.
   * - `no-raw`: a stored file exists with no raw behind it: every stored bar is unrebuildable.
   */
  readonly kind: 'compared' | 'not-cooked' | 'no-raw';
  readonly diff: RebuildDiff;
}

export class RebuildCheck {
  constructor(private readonly deps: RebuildCheckDeps) {}

  /**
   * Check each of the given month partitions for every intraday timeframe.
   * A month with neither raw nor a stored file is skipped: nothing to rebuild.
   */
  async run(
    instrument: Instrument,
    partitions: readonly string[],
    timeframes: readonly Timeframe[] = INTRADAY_ROLLUPS,
  ): Promise<PartitionResult[]> {
    const results: PartitionResult[] = [];
    for (const partition of partitions) {
      const { from, until } = partitionBounds(partition);
      const minutes = await this.deps.source.read(instrument.symbol, from, until);
      for (const timeframe of timeframes) {
        const rebuilt = rollUp(instrument, timeframe, minutes, this.deps.calendar);
        const stored = await this.deps.store.getPartition(instrument.symbol, timeframe, partition);
        if (stored === undefined && rebuilt.length === 0) continue;
        const kind =
          stored === undefined ? 'not-cooked' : rebuilt.length === 0 ? 'no-raw' : 'compared';
        results.push({
          symbol: instrument.symbol,
          timeframe,
          partition,
          kind,
          diff: diffBars(rebuilt, stored ?? []),
        });
      }
    }
    return results;
  }
}
