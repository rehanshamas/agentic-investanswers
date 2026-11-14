// Per-user rate limits (M2-10), counted in fixed windows. Time is passed in.
//
// If the counter store fails (Redis down), requests are let through and the
// failure is reported: a cache outage must not take the API down with it.

import type { Principal } from '../domain/principal.js';
import type { RateBucket, RateLimits } from '../domain/safeguards.js';
import { windowOf } from '../domain/safeguards.js';

export interface RateCounterPort {
  /** Add one to `key` and return the new count; the key expires after `ttlSeconds`. */
  hit(key: string, ttlSeconds: number): Promise<number>;
}

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterSeconds: number; readonly limit: number };

export interface RateLimiterDeps {
  readonly limits: RateLimits;
  readonly counter: RateCounterPort;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly onError?: (error: Error) => void;
}

export class RateLimiter {
  constructor(private readonly deps: RateLimiterDeps) {}

  /** Count one request in `bucket` for `subject` (a principal id, an account id or a client address). */
  async check(bucket: RateBucket, subject: string): Promise<RateDecision> {
    const rule = this.deps.limits[bucket];
    const { start, retryAfter } = windowOf(this.deps.now() / 1_000, rule.windowSeconds);
    let count: number;
    try {
      count = await this.deps.counter.hit(`rl|${bucket}|${subject}|${start}`, rule.windowSeconds + 1);
    } catch (error) {
      this.deps.onError?.(error instanceof Error ? error : new Error(String(error)));
      return { ok: true };
    }
    return count <= rule.limit ? { ok: true } : { ok: false, retryAfterSeconds: retryAfter, limit: rule.limit };
  }

  /** Reads by a principal: humans and agents have separate limits. */
  checkReads(principal: Principal): Promise<RateDecision> {
    return this.check(principal.kind === 'agent' ? 'agentReads' : 'humanReads', principal.id);
  }
}
