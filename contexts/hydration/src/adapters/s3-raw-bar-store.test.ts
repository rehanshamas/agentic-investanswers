// Integration tests against the local MinIO from `docker compose up -d`.
//
// Skipped with a clear message when MinIO is unreachable, so `pnpm check`
// stays green on a machine without Docker. In CI (which runs a MinIO service)
// an unreachable MinIO fails the run instead, so these tests can never be
// silently skipped there.

import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import type { Bar, BarTime } from '@aia/shared-kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { RawDayAlreadyStoredError } from '../application/raw-bar-store-port.js';
import type { RawDayRef } from '../application/raw-bar-store-port.js';
import { RawDayError } from '../domain/raw-day.js';
import { S3RawBarStore, rawDayKey } from './s3-raw-bar-store.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client } from './s3-objects.js';

const config: S3StoreConfig = {
  bucket: 'aia-raw',
  endpoint: process.env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minio', secretAccessKey: 'minio12345' },
};

async function minioReachable(): Promise<boolean> {
  // Reuse the adapter's own factory, so the test cannot drift from how the
  // store really builds its client.
  const client = createS3Client(config);
  try {
    try {
      await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    } catch {
      await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
    }
    return true;
  } catch {
    return false;
  } finally {
    client.destroy();
  }
}

const available = await minioReachable();
if (!available) {
  if (process.env['CI']) throw new Error('MinIO not reachable at ' + config.endpoint + ' in CI; the raw store tests must run there.');
  console.warn('MinIO not reachable at ' + config.endpoint + '; skipping raw store tests. Run: docker compose up -d');
}

/** Raw is write-once, so every run needs its own keys or the second run fails. */
const runId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function ref(date = '2024-03-15'): RawDayRef {
  return { provider: runId, symbol: 'BTCUSD', date };
}

function bar(time: BarTime, close: string): Bar {
  const value = price(parseScaled(close, 2));
  return {
    time,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: volume(parseScaled('1.23456789', 8)),
  };
}

const start = barTimeFromUtcParts(2024, 3, 15);
const day: Bar[] = [
  bar(start, '68123.45'),
  bar((start + 60) as BarTime, '68150.99'),
  bar((start + 120) as BarTime, '68290.10'),
];

describe.skipIf(!available)('S3RawBarStore against MinIO', () => {
  let store: S3RawBarStore;

  beforeAll(() => {
    store = new S3RawBarStore(config);
  });

  it('round-trips a day exactly', async () => {
    const key = ref();
    await store.putDay(key, day);
    expect(await store.getDay(key)).toEqual(day);
  });

  it('rejects writing the same raw day twice', async () => {
    // The done-check for this task, and CLAUDE.md rule 3: raw is write-once.
    const key = ref('2024-03-16');
    await store.putDay(key, [bar(barTimeFromUtcParts(2024, 3, 16), '100.00')]);
    await expect(
      store.putDay(key, [bar(barTimeFromUtcParts(2024, 3, 16), '999.99')]),
    ).rejects.toThrow(RawDayAlreadyStoredError);
  });

  it('leaves the first write intact after a rejected second write', async () => {
    const key = ref('2024-03-17');
    const first = [bar(barTimeFromUtcParts(2024, 3, 17), '111.11')];
    await store.putDay(key, first);
    await store
      .putDay(key, [bar(barTimeFromUtcParts(2024, 3, 17), '222.22')])
      .catch(() => undefined);
    expect(await store.getDay(key)).toEqual(first);
  });

  it('reports whether a day exists without reading it', async () => {
    const key = ref('2024-03-18');
    expect(await store.hasDay(key)).toBe(false);
    await store.putDay(key, [bar(barTimeFromUtcParts(2024, 3, 18), '100.00')]);
    expect(await store.hasDay(key)).toBe(true);
  });

  it('returns undefined for a day that was never written', async () => {
    expect(await store.getDay(ref('2024-03-19'))).toBeUndefined();
  });

  it('stores an empty day, so a known-empty day is distinguishable from a gap', async () => {
    const key = ref('2024-03-20');
    await store.putDay(key, []);
    expect(await store.hasDay(key)).toBe(true);
    expect(await store.getDay(key)).toEqual([]);
  });

  it('validates before writing, so a bad batch leaves nothing behind', async () => {
    const key = ref('2024-03-21');
    const wrongDay = [bar(barTimeFromUtcParts(2024, 3, 22), '100.00')];
    await expect(store.putDay(key, wrongDay)).rejects.toThrow(RawDayError);
    expect(await store.hasDay(key)).toBe(false);
  });
});

describe('rawDayKey', () => {
  it('splits by provider, symbol, year and month', () => {
    expect(rawDayKey({ provider: 'coinapi', symbol: 'BTCUSD', date: '2024-03-05' })).toBe(
      'raw/coinapi/BTCUSD/2024/03/05.parquet',
    );
  });

  it('zero-pads month and day, so keys sort lexically', () => {
    const keys = ['2024-01-02', '2024-01-10', '2024-02-01', '2024-11-30'].map((date) =>
      rawDayKey({ provider: 'p', symbol: 'S', date }),
    );
    expect([...keys].sort()).toEqual(keys);
  });
});

describe.skipIf(!available)('S3RawBarStore gap fills against MinIO', () => {
  const store = new S3RawBarStore(config);
  const t = (minute: number): BarTime => barTimeFromUtcParts(2024, 4, 2, 10, minute);
  const day = (): RawDayRef => ref('2024-04-02');

  it('adds minutes beside a stored day, in new files, and reads them back merged', async () => {
    await store.putDay(day(), [bar(t(0), '100.00'), bar(t(3), '103.00')]);
    await store.putFill(day(), [bar(t(1), '101.00')]);
    await store.putFill(day(), [bar(t(2), '102.00')]);

    const merged = await store.getDay(day());
    expect(merged?.map((b) => b.time)).toEqual([t(0), t(1), t(2), t(3)]);
    expect(await store.hasDay(day())).toBe(true);
  });

  it('never replaces a stored minute, from the day or an earlier fill', async () => {
    await expect(store.putFill(day(), [bar(t(1), '999.00')])).rejects.toThrow(RawDayError);
    await expect(store.putFill(day(), [bar(t(3), '999.00')])).rejects.toThrow(RawDayError);
    expect((await store.getDay(day()))?.find((b) => b.time === t(1))?.close).toBe(price(parseScaled('101.00', 2)));
  });

  it('refuses a fill for a day that was never stored', async () => {
    await expect(store.putFill(ref('2024-04-03'), [bar(barTimeFromUtcParts(2024, 4, 3, 1, 0), '1.00')])).rejects.toThrow(
      /never stored/,
    );
  });
});
