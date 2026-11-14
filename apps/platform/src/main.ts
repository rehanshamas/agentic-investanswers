// `pnpm platform`: run the platform process locally (M2-03).
//
// Opens the data layer (@aia/data, M1-16: stores on MinIO locally, the cache
// and live bus on Redis, the feed plan), puts the History API and the live
// gateway (@aia/serving) over it, and listens. Settings, all optional:
//   AIA_PORT (8080), AIA_HOST (127.0.0.1), AIA_REDIS_URL, AIA_S3_* and
//   AIA_*_BUCKET as for the hydration commands, AIA_FEED_PLAN,
//   AIA_DEV_AUTH=1 to treat every request as the local developer; otherwise the
//   app's own sign-in (M2-08) at /auth/*, with accounts and sessions in
//   DynamoDB: AIA_DYNAMODB_ENDPOINT (the local one, http://127.0.0.1:8000;
//   "aws" for AWS itself), AIA_USERS_TABLE (aia-users).
//
// Exits 2 on a setup error.

import {
  DynamoAccountStore,
  DynamoAgentKeyStore,
  DynamoSessionStore,
  RateLimiter,
  RedisRateCounter,
  accessFromEnv,
  dynamoClient,
  ensureUsersTable,
  loadRateLimits,
} from '@aia/access';
import { openLocalDataLayer } from '@aia/data';
import { IndicatorRegistry } from '@aia/indicators';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';

import { buildServer } from './server.js';

/** Account and session stores in DynamoDB; locally the table is created if missing (CDK creates it in AWS). */
async function usersStores(env: NodeJS.ProcessEnv) {
  const table = env['AIA_USERS_TABLE'] ?? 'aia-users';
  const endpoint = env['AIA_DYNAMODB_ENDPOINT'] ?? 'http://127.0.0.1:8000';
  const local = endpoint !== 'aws';
  const client = dynamoClient(local ? { endpoint, table, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : { endpoint, table });
  if (local) await ensureUsersTable(client, table);
  return {
    accounts: new DynamoAccountStore(client, table),
    sessions: new DynamoSessionStore(client, table),
    agentKeys: new DynamoAgentKeyStore(client, table),
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const data = await openLocalDataLayer(env, {
    onError: (what, failure) => console.error(`redis (${what}): ${failure.message} (reads go to the store meanwhile; charts resync once it is back)`),
  });
  const history = new HistoryQuery({ data });
  // One subscription per process; the gateway fans out to every browser.
  const live = new LiveGateway({
    data,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  await data.subscribe(live);

  const access = env['AIA_DEV_AUTH'] === '1' ? accessFromEnv(env) : accessFromEnv(env, await usersStores(env));
  console.log(access.description);
  // Per-user rate limits (M2-10), counted in the same Redis, so every platform process shares them.
  const counter = await RedisRateCounter.connect({
    url: env['AIA_REDIS_URL'],
    reconnect: 'forever',
    onError: (failure) => console.error(`redis (rate limits): ${failure.message} (requests are let through meanwhile)`),
  });
  const limits = new RateLimiter({
    limits: loadRateLimits(env),
    counter,
    now: () => Date.now(),
    onError: (failure) => console.error(`rate limits: ${failure.message} (request let through)`),
  });
  // No indicator is registered until M3-05 brings the simple moving average (decision record D-11).
  const indicators = new IndicatorRegistry([]);
  const app = await buildServer({ history, access, live, limits, catalog: data, indicators, now: () => barTime(Math.floor(Date.now() / 1000)), logger: true });

  const port = Number(env['AIA_PORT'] ?? 8080);
  const host = env['AIA_HOST'] ?? '127.0.0.1';
  await app.listen({ port, host });

  const shutdown = (): void => {
    live.stop();
    void app
      .close()
      .then(() => data.close())
      .then(() => counter.close())
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
