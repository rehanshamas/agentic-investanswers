// In-memory output cache for tests and local runs without Redis. Stores text,
// like Redis, so tests catch anything that would not survive the round trip.
// Time is an argument (the `now` function), never read from the clock here.

import type { IndicatorOutputCachePort } from '../application/indicator-output-cache-port.js';

export class MemoryIndicatorOutputCache implements IndicatorOutputCachePort {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => 0) {}

  get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSeconds * 1_000 });
    return Promise.resolve();
  }

  /** Test helper: drop everything, as a Redis restart would. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
