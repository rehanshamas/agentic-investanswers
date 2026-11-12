// M2-04: the load test, small enough for every `pnpm check` (100 clients, 6 s,
// in this process), so order and completeness stay tested in CI. At 20x a
// minute lasts 3 s, so stored bars and the store-then-cook race are covered
// too. The 1,000 client run is `pnpm load-live`; its results are in
// tasks/M2-04.md.

import { describe, expect, it } from 'vitest';

import { runLoad } from './load-live-harness.js';

describe('live gateway under load', () => {
  it('delivers every update of every subscribed pair to 100 clients, in order, and nothing else', async () => {
    const report = await runLoad({ clients: 100, seconds: 6, speed: 20 });
    expect(report.examples).toEqual([]);
    expect(report.failures).toBe(0);
    expect(report.clients).toBe(100);
    expect(report.updates).toBeGreaterThan(report.clients * 50);
    // Batched: far fewer messages than updates delivered would be one by one.
    expect(report.messages).toBeLessThan(report.updates);
  }, 30_000);
});
