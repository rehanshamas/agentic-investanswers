// The recent-bars cache the command-line tools keep in step with the store (M2-02).
//
// `pnpm live` updates it through BarClosed after every minute. Anything else
// that rewrites bars (`pnpm cook`, gap repair in `pnpm gaps`) drops the
// windows of the instruments it touched, so the next read refills them from
// the store. Locally it is the Redis from docker-compose.yml; AIA_REDIS_URL
// overrides it for staging.

import type { RedisCacheOptions } from '@aia/market-data';
import { INTRADAY_ROLLUPS, RedisRecentBarsCache } from '@aia/market-data';
import type { Timeframe } from '@aia/shared-kernel';

/** Every timeframe cached: 1m (from raw) and the cooked intraday ones. */
export const CACHED_TIMEFRAMES: readonly Timeframe[] = ['1m', ...INTRADAY_ROLLUPS];

export function connectCache(
  options: Omit<RedisCacheOptions, 'url'> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<RedisRecentBarsCache> {
  return RedisRecentBarsCache.connect({ ...options, url: env['AIA_REDIS_URL'] });
}

/**
 * Drop the cached windows of `symbols`, after their bars were rewritten
 * other than through BarClosed. Throws if Redis cannot be reached, because a
 * window left behind would then be served stale.
 */
export async function dropCachedWindows(symbols: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (symbols.length === 0) return;
  const cache = await connectCache({}, env);
  try {
    for (const symbol of symbols) {
      for (const timeframe of CACHED_TIMEFRAMES) await cache.invalidate(symbol, timeframe);
    }
  } finally {
    await cache.close();
  }
}
