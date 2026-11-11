// The port the recent-bars cache is read and written through (M2-02).
//
// What a window is, and the rules that keep it true, are in
// domain/recent-window.ts. Adapters: Redis (ElastiCache in staging) and an
// in-memory one for tests.

import type { Bar, Timeframe } from '@aia/shared-kernel';

import type { RecentWindow } from '../domain/recent-window.js';

export class RecentBarsCacheError extends Error {}

export interface RecentBarsCachePort {
  /** The cached window, or `undefined` if there is none (a cold key). */
  get(symbol: string, timeframe: Timeframe): Promise<RecentWindow | undefined>;

  /**
   * A counter that changes on every `apply` and `invalidate`, cold key or not.
   * Read it before reading the store, and pass it to `fill`.
   */
  version(symbol: string, timeframe: Timeframe): Promise<number>;

  /**
   * Replace the window with one read from the store, but only if the version
   * is still `ifVersion`. Otherwise a bar changed while the store was being
   * read, the window would miss it, and nothing is written. Returns whether
   * it was written. The adapter trims to its capacity.
   */
  fill(symbol: string, timeframe: Timeframe, window: RecentWindow, ifVersion: number): Promise<boolean>;

  /** The store's value of `bar` changed: replace or insert it, if a window exists. */
  apply(symbol: string, timeframe: Timeframe, bar: Bar): Promise<void>;

  /** Drop the window; the next read refills it from the store. */
  invalidate(symbol: string, timeframe: Timeframe): Promise<void>;
}
