// The port cooked bars are read and written through.
//
// Cooked bars are derived from raw 1-minute bars and are always rebuildable
// (CLAUDE.md rule 3), so unlike raw they may be overwritten: re-cooking a
// partition is a normal operation, and M1-10's rebuild check depends on it.

import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';

export class CookedStoreError extends Error {}

export interface CookedBarStorePort {
  /**
   * Replace the partitions the given bars fall in.
   *
   * Bars may span several partitions; each one written is replaced whole, so
   * the caller must pass every bar belonging to a partition it touches, not
   * just the new ones. M1-06's incremental update reads a partition, extends
   * it and writes it back.
   */
  put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void>;

  /** Bars in `[from, until]` inclusive, ascending, across partition boundaries. */
  getRange(
    symbol: string,
    timeframe: Timeframe,
    from: BarTime,
    until: BarTime,
  ): Promise<Bar[]>;

  /** One whole partition, or `undefined` if it was never written. */
  getPartition(
    symbol: string,
    timeframe: Timeframe,
    partition: string,
  ): Promise<Bar[] | undefined>;
}
