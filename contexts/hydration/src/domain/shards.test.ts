import { describe, expect, it } from 'vitest';

import { FeedPlanError, parseFeedPlan } from './feed-plan.js';
import type { InstrumentFeeds } from './feed-plan.js';
import { inShard, parseShard, shardOf } from './shards.js';

const feeds = (symbol: string, shard?: number): InstrumentFeeds => ({
  symbol,
  defaultFrom: '2024-11-01',
  history: [{ provider: 'coinbase', settleSeconds: 3_600 }],
  live: [{ provider: 'coinbase' }],
  ...(shard === undefined ? {} : { shard }),
});

describe('live shards', () => {
  const symbols = Array.from({ length: 500 }, (_, i) => `SYM${i}`);

  it('puts every instrument in exactly one shard, for any count', () => {
    for (const count of [1, 2, 3, 8, 16]) {
      for (const symbol of symbols) {
        const homes = Array.from({ length: count }, (_, i) => i + 1).filter((index) => inShard(feeds(symbol), { index, count }));
        expect(homes).toHaveLength(1);
      }
    }
  });

  it('is stable (the same answer every time) and spreads instruments evenly', () => {
    expect(symbols.map((s) => shardOf(feeds(s), 8))).toEqual(symbols.map((s) => shardOf(feeds(s), 8)));
    expect(shardOf(feeds('BTCUSD'), 8)).toBe(shardOf(feeds('BTCUSD'), 8));
    const sizes = new Map<number, number>();
    for (const s of symbols) sizes.set(shardOf(feeds(s), 8), (sizes.get(shardOf(feeds(s), 8)) ?? 0) + 1);
    for (const size of sizes.values()) expect(size).toBeGreaterThan(40); // 62.5 on average
  });

  it('honours a pin, and refuses one beyond the count', () => {
    expect(shardOf(feeds('BTCUSD', 3), 8)).toBe(3);
    expect(() => shardOf(feeds('BTCUSD', 9), 8)).toThrow(FeedPlanError);
  });

  it('parses i/n and refuses anything else', () => {
    expect(parseShard('2/8')).toEqual({ index: 2, count: 8 });
    for (const bad of ['0/8', '9/8', '2', '2/0', 'a/b', '1/2/3']) expect(() => parseShard(bad)).toThrow(FeedPlanError);
  });

  it('reads a pin from the feed plan and validates it', () => {
    const plan = (shard: unknown) => ({ instruments: [{ symbol: 'BTCUSD', defaultFrom: '2024-11-01', history: [{ provider: 'coinbase', settleSeconds: 0 }], shard }] });
    expect(parseFeedPlan(plan(2)).instruments[0]?.shard).toBe(2);
    expect(parseFeedPlan({ instruments: [{ symbol: 'BTCUSD', defaultFrom: '2024-11-01', history: [{ provider: 'coinbase', settleSeconds: 0 }] }] }).instruments[0]?.shard).toBeUndefined();
    for (const bad of [0, 1.5, '2', -1]) expect(() => parseFeedPlan(plan(bad))).toThrow(FeedPlanError);
  });
});
