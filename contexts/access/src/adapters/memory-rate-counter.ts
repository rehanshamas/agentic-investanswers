// Rate counters in memory (M2-10), for tests and a single local process.
// Expired windows are swept as new ones start. Time is passed in.

import type { RateCounterPort } from '../application/rate-limiter.js';

export class MemoryRateCounter implements RateCounterPort {
  private readonly counts = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  hit(key: string, ttlSeconds: number): Promise<number> {
    const now = this.now();
    const entry = this.counts.get(key);
    if (entry === undefined || entry.expiresAt <= now) {
      for (const [other, value] of this.counts) if (value.expiresAt <= now) this.counts.delete(other);
      this.counts.set(key, { count: 1, expiresAt: now + ttlSeconds * 1_000 });
      return Promise.resolve(1);
    }
    entry.count += 1;
    return Promise.resolve(entry.count);
  }
}
