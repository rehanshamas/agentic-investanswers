// The recent-bars cache held in memory: for tests, and for running without
// Redis. Follows domain/recent-window.ts exactly; the Redis adapter is tested
// against the same cases.

import type { Bar, Timeframe } from '@aia/shared-kernel';

import type { RecentBarsCachePort } from '../application/recent-bars-cache-port.js';
import type { RecentWindow } from '../domain/recent-window.js';
import { RECENT_BARS_CAPACITY, applyToWindow, fillWindow } from '../domain/recent-window.js';

export class MemoryRecentBarsCache implements RecentBarsCachePort {
  private readonly windows = new Map<string, RecentWindow>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly capacity: number = RECENT_BARS_CAPACITY) {}

  get(symbol: string, timeframe: Timeframe): Promise<RecentWindow | undefined> {
    return Promise.resolve(this.windows.get(key(symbol, timeframe)));
  }

  version(symbol: string, timeframe: Timeframe): Promise<number> {
    return Promise.resolve(this.versions.get(key(symbol, timeframe)) ?? 0);
  }

  fill(symbol: string, timeframe: Timeframe, window: RecentWindow, ifVersion: number): Promise<boolean> {
    const k = key(symbol, timeframe);
    if ((this.versions.get(k) ?? 0) !== ifVersion) return Promise.resolve(false);
    this.windows.set(k, fillWindow(window.from, window.bars, this.capacity));
    return Promise.resolve(true);
  }

  apply(symbol: string, timeframe: Timeframe, bar: Bar): Promise<void> {
    const k = key(symbol, timeframe);
    this.bump(k);
    const window = this.windows.get(k);
    if (window !== undefined) this.windows.set(k, applyToWindow(window, bar, this.capacity));
    return Promise.resolve();
  }

  invalidate(symbol: string, timeframe: Timeframe): Promise<void> {
    const k = key(symbol, timeframe);
    this.bump(k);
    this.windows.delete(k);
    return Promise.resolve();
  }

  private bump(k: string): void {
    this.versions.set(k, (this.versions.get(k) ?? 0) + 1);
  }
}

const key = (symbol: string, timeframe: Timeframe): string => `${symbol}:${timeframe}`;
