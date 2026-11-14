// The data layer on the local stack or AWS (M1-16): raw and cooked bars on S3
// (MinIO locally), the recent-bars cache and the live bus on Redis, and the
// feed plan. What `pnpm platform` used to wire by hand.
//
// Settings, all optional: AIA_S3_ENDPOINT, AIA_S3_REGION, AIA_S3_ACCESS_KEY,
// AIA_S3_SECRET_KEY, AIA_RAW_BUCKET (aia-raw), AIA_COOKED_BUCKET (aia-cooked),
// AIA_REDIS_URL, AIA_FEED_PLAN.

import { RawMinuteSource, S3RawBarStore, feedsFor, liveProviderOf, loadFeedPlan, rawProviderOf } from '@aia/hydration';
import { PARITY_INSTRUMENTS, RedisLiveBarsBus, RedisRecentBarsCache, S3CookedBarStore } from '@aia/market-data';
import { barTimeFromUtcParts, nyseCalendar, parseDateKey } from '@aia/shared-kernel';

import type { DataAccess } from '../application/data-access.js';
import { InProcessDataLayer } from '../application/in-process-data-layer.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface LocalDataLayerOptions {
  /** Told about Redis connection errors; reads go to the store meanwhile and charts resync afterwards. */
  readonly onError?: (what: string, error: Error) => void;
}

export async function openLocalDataLayer(env: Env = process.env, options: LocalDataLayerOptions = {}): Promise<DataAccess> {
  const plan = loadFeedPlan(env);
  const s3 = {
    endpoint: env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    region: env['AIA_S3_REGION'] ?? 'us-east-1',
    // The local MinIO's credentials from docker-compose.yml, unless overridden.
    credentials: {
      accessKeyId: env['AIA_S3_ACCESS_KEY'] ?? 'minio',
      secretAccessKey: env['AIA_S3_SECRET_KEY'] ?? 'minio12345',
    },
  };
  const raw = new S3RawBarStore({ ...s3, bucket: env['AIA_RAW_BUCKET'] ?? 'aia-raw' });
  const cooked = new S3CookedBarStore({ ...s3, bucket: env['AIA_COOKED_BUCKET'] ?? 'aia-cooked' });
  const cache = await RedisRecentBarsCache.connect({
    url: env['AIA_REDIS_URL'],
    reconnect: 'forever',
    onError: (error) => options.onError?.('recent-bars cache', error),
  });
  const bus = await RedisLiveBarsBus.connect({ url: env['AIA_REDIS_URL'], onError: (error) => options.onError?.('live bus', error) });
  return new InProcessDataLayer({
    instruments: PARITY_INSTRUMENTS.filter((i) => plan.instruments.some((f) => f.symbol === i.symbol)),
    // Where each instrument's history starts: the feed plan's default start day.
    earliest: (symbol) => {
      const { year, month, day } = parseDateKey(feedsFor(plan, symbol).defaultFrom);
      return barTimeFromUtcParts(year, month, day);
    },
    minutes: new RawMinuteSource(raw, rawProviderOf(plan), liveProviderOf(plan)),
    cooked,
    watermarks: cooked,
    cache,
    bus,
    calendar: nyseCalendar(),
    nowMs: () => Date.now(),
    onClose: () => cache.close(),
  });
}
