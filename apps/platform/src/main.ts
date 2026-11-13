// `pnpm platform`: run the platform process locally (M2-03).
//
// Wires the stores (MinIO locally), the recent-bars cache (Redis) and the
// feed plan into the History API, and the live bars bus (the same Redis) into
// the live gateway (M2-04), and listens. Settings, all optional:
//   AIA_PORT (8080), AIA_HOST (127.0.0.1), AIA_REDIS_URL, AIA_S3_* and
//   AIA_*_BUCKET as for the hydration commands, AIA_FEED_PLAN,
//   AIA_DEV_AUTH=1 to treat every request as the local developer (until M2-08).
//
// Exits 2 on a setup error.

import { accessFromEnv } from '@aia/access';
import { RawMinuteSource, S3RawBarStore, feedsFor, liveProviderOf, loadFeedPlan, rawProviderOf } from '@aia/hydration';
import {
  CookedReader,
  HistoryQuery,
  LiveGateway,
  PARITY_INSTRUMENTS,
  RecentBars,
  RedisLiveBarsBus,
  RedisRecentBarsCache,
  S3CookedBarStore,
} from '@aia/market-data';
import { barTime, barTimeFromUtcParts, nyseCalendar, parseDateKey } from '@aia/shared-kernel';

import { buildServer } from './server.js';

async function main(): Promise<void> {
  const env = process.env;
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
  const minutes = new RawMinuteSource(raw, rawProviderOf(plan), liveProviderOf(plan));

  const cache = await RedisRecentBarsCache.connect({
    url: env['AIA_REDIS_URL'],
    reconnect: 'forever',
    onError: (failure) => console.error(`redis: ${failure.message} (reads go to the store meanwhile)`),
  });

  // Where each instrument's history starts: the feed plan's default start day.
  const earliest = (symbol: string) => {
    const { year, month, day } = parseDateKey(feedsFor(plan, symbol).defaultFrom);
    return barTimeFromUtcParts(year, month, day);
  };
  const instruments = PARITY_INSTRUMENTS.filter((i) => plan.instruments.some((f) => f.symbol === i.symbol));
  // Settled cooked bars plus the rest rolled up from raw (M1-15).
  const reader = new CookedReader({ store: cooked, watermarks: cooked, minutes, instruments, calendar: nyseCalendar(), nowMs: () => Date.now() });
  const history = new HistoryQuery({
    recentBars: new RecentBars({ cache, store: reader, minutes }),
    instruments,
    earliest,
  });

  // One subscriber per process; the gateway fans out to every browser.
  const live = new LiveGateway({
    instruments,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  const bus = await RedisLiveBarsBus.connect({
    url: env['AIA_REDIS_URL'],
    onError: (failure) => console.error(`redis (live bus): ${failure.message} (charts resync once it is back)`),
  });
  await bus.subscribe(live);

  const access = accessFromEnv(env);
  console.log(access.description);
  const app = await buildServer({ history, access, live, now: () => barTime(Math.floor(Date.now() / 1000)), logger: true });

  const port = Number(env['AIA_PORT'] ?? 8080);
  const host = env['AIA_HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });

  const shutdown = (): void => {
    live.stop();
    void app
      .close()
      .then(() => bus.close())
      .then(() => cache.close())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main().catch((failure: unknown) => {
  console.error(
    `${failure instanceof Error ? failure.message : String(failure)}\n` +
      'Is the local stack up? Run: docker compose up -d',
  );
  process.exit(2);
});
