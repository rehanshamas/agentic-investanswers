// The bar stores the command-line tools wire together: raw (hydration), cooked
// (market-data), and the raw store seen as market-data's 1m source.
//
// Locally they point at the MinIO from docker-compose.yml; every setting can be
// overridden by environment variable for staging.

import type { FeedPlan } from '@aia/hydration';
import { S3RawBarStore } from '@aia/hydration';
import { S3CookedBarStore } from '@aia/market-data';

import { liveProviderOf, rawProviderOf } from './feeds.js';
import { RawMinuteSource } from './raw-minute-source.js';

export interface Stores {
  readonly endpoint: string;
  readonly raw: S3RawBarStore;
  readonly cooked: S3CookedBarStore;
  readonly minutes: RawMinuteSource;
}

/** Raw files are keyed by provider; the feed plan says which one per day. */
export function localStores(
  plan: FeedPlan,
  env: NodeJS.ProcessEnv = process.env,
): Stores {
  const endpoint = env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000';
  const s3 = {
    endpoint,
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
  return { endpoint, raw, cooked, minutes };
}

/** The months from `from` to `until` (YYYY-MM-DD), as cooked partition names. */
export function monthsBetween(from: string, until: string): string[] {
  const months: string[] = [];
  let [year, month] = from.split('-').map(Number) as [number, number];
  const [endYear, endMonth] = until.split('-').map(Number) as [number, number];
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push(`${year}-${String(month).padStart(2, '0')}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}
