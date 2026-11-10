// The port the rest of hydration writes raw bars through.
//
// Two ports rather than one: raw is write-once and keyed by provider,
// instrument and day, and this context owns it; cooked bars are rewritable,
// keyed by instrument and timeframe, and `@aia/market-data` owns those. Giving
// each context its own port keeps the ownership in each AGENTS.md honest, at
// the cost of a little duplicated S3 plumbing.

import type { Bar } from '@aia/shared-kernel';

/** Identifies one raw file: one provider, one instrument, one UTC day. */
export interface RawDayRef {
  /** Provider the data came from, for example `coinapi` or `massive`. */
  readonly provider: string;
  /** Our instrument symbol, for example `BTCUSD` or `NVDA`. */
  readonly symbol: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly date: string;
}

export class RawStoreError extends Error {}

/**
 * Raised when a raw day already exists.
 *
 * Raw is write-once and never edited, so this is a normal outcome for an
 * idempotent backfill re-run (M1-04), not necessarily a fault. Callers that
 * expect it should catch this type rather than inspect a message.
 */
export class RawDayAlreadyStoredError extends RawStoreError {
  constructor(public readonly ref: RawDayRef) {
    super(`Raw day already stored: ${ref.provider}/${ref.symbol}/${ref.date}`);
  }
}

export interface RawBarStorePort {
  /**
   * Store one day of 1-minute bars, once.
   *
   * Throws `RawDayAlreadyStoredError` if the day exists. Implementations must
   * make that check atomic rather than read-then-write, so two writers cannot
   * both believe they are first.
   */
  putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void>;

  /**
   * Read a stored day, merged with its gap fills, or `undefined` if the day
   * was never written.
   */
  getDay(ref: RawDayRef): Promise<Bar[] | undefined>;

  /**
   * Store minutes found after the day was written (M1-09), in a new
   * write-once file beside it. The day file itself is never edited. Every
   * minute must be absent from the day and its earlier fills, so a fill only
   * ever adds; the store refuses anything else. The day must already exist.
   */
  putFill(ref: RawDayRef, bars: readonly Bar[]): Promise<void>;

  /** Whether a day is already stored, without transferring it. */
  hasDay(ref: RawDayRef): Promise<boolean>;
}
