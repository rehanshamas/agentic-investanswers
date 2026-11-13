// Splitting instruments across live processes (M1-15c). Pure.
//
// `pnpm live --shard 2/8` streams the instruments of shard 2 of 8. Each
// instrument is in exactly one shard, so it has exactly one writer of its live
// minutes, hour files and cooked days. An instrument goes to the shard its
// feed plan entry pins (`"shard": n`), otherwise to one chosen by a stable
// hash of its symbol, which needs no list to keep up to date. Changing the
// count moves hashed instruments between shards; restart every shard together.

import { FeedPlanError } from './feed-plan.js';
import type { InstrumentFeeds } from './feed-plan.js';

/** 1-based: shard `index` of `count`. */
export interface Shard {
  readonly index: number;
  readonly count: number;
}

export const ALL_IN_ONE: Shard = { index: 1, count: 1 };

/** `"2/8"` → shard 2 of 8. */
export function parseShard(text: string): Shard {
  const m = /^(\d{1,4})\/(\d{1,4})$/.exec(text);
  const index = Number(m?.[1]);
  const count = Number(m?.[2]);
  if (m === null || count < 1 || index < 1 || index > count) {
    throw new FeedPlanError(`a shard is written i/n with 1 ≤ i ≤ n, for example 2/8; got "${text}"`);
  }
  return { index, count };
}

/** FNV-1a, 32 bits: stable across runs, machines and Node versions. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Which shard (1-based) of `count` an instrument belongs to. */
export function shardOf(feeds: InstrumentFeeds, count: number): number {
  if (feeds.shard !== undefined) {
    if (feeds.shard > count) {
      throw new FeedPlanError(`${feeds.symbol} is pinned to shard ${feeds.shard}, but there are only ${count}`);
    }
    return feeds.shard;
  }
  return (hash(feeds.symbol) % count) + 1;
}

export function inShard(feeds: InstrumentFeeds, shard: Shard): boolean {
  return shardOf(feeds, shard.count) === shard.index;
}
