import { describe, expect, it } from 'vitest';

import { MemoryRateCounter } from '../adapters/memory-rate-counter.js';
import { parseRateLimits } from '../domain/safeguards.js';
import { RateLimiter } from './rate-limiter.js';

const limits = parseRateLimits({
  rateLimits: {
    humanReads: { limit: 3, windowSeconds: 60 },
    agentReads: { limit: 2, windowSeconds: 60 },
    signIn: { limit: 2, windowSeconds: 900 },
    signUp: { limit: 1, windowSeconds: 3600 },
    agentKeyChanges: { limit: 1, windowSeconds: 3600 },
  },
});

function limiter(start = 1_763_000_080_000) {
  let now = start;
  const counter = new MemoryRateCounter(() => now);
  return { limiter: new RateLimiter({ limits, counter, now: () => now }), advance: (ms: number) => (now += ms) };
}

describe('RateLimiter', () => {
  it('allows up to the limit in a window, then refuses until the next window', async () => {
    const { limiter: l, advance } = limiter();
    const human = { kind: 'human' as const, id: 'u1' };
    for (let i = 0; i < 3; i += 1) expect(await l.checkReads(human)).toEqual({ ok: true });
    // 1_763_000_080 s is 40 s into its minute, so the next window is 20 s away.
    expect(await l.checkReads(human)).toEqual({ ok: false, retryAfterSeconds: 20, limit: 3 });
    advance(20_000);
    expect(await l.checkReads(human)).toEqual({ ok: true });
  });

  it('counts each subject and each bucket separately; agents have their own limit', async () => {
    const { limiter: l } = limiter();
    const agent = { kind: 'agent' as const, id: 'k1', owner: 'u1' };
    expect((await l.checkReads(agent)).ok).toBe(true);
    expect((await l.checkReads(agent)).ok).toBe(true);
    expect((await l.checkReads(agent)).ok).toBe(false);
    expect((await l.checkReads({ kind: 'human', id: 'u1' })).ok).toBe(true);
    expect((await l.checkReads({ kind: 'agent', id: 'k2', owner: 'u1' })).ok).toBe(true);
    expect((await l.check('signUp', '10.0.0.1')).ok).toBe(true);
    expect((await l.check('signUp', '10.0.0.1')).ok).toBe(false);
    expect((await l.check('signUp', '10.0.0.2')).ok).toBe(true);
  });

  it('lets requests through and reports it when the counter store fails', async () => {
    const errors: string[] = [];
    const l = new RateLimiter({
      limits,
      counter: { hit: () => Promise.reject(new Error('redis down')) },
      now: () => 0,
      onError: (error) => errors.push(error.message),
    });
    expect(await l.check('signIn', 'x')).toEqual({ ok: true });
    expect(errors).toEqual(['redis down']);
  });
});
