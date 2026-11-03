// Integration tests against the local MinIO from `docker compose up -d`.
// Skipped when MinIO is unreachable; see the note in the hydration equivalent.

import { CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import type { Bar, BarTime } from '@aia/shared-kernel';
import { beforeAll, describe, expect, it } from 'vitest';

import { CookedStoreError } from '../application/cooked-bar-store-port.js';
import { cookedKey, S3CookedBarStore } from './s3-cooked-bar-store.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client } from './s3-objects.js';

const config: S3StoreConfig = {
  bucket: 'aia-cooked',
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
  if (process.env['CI']) throw new Error('MinIO not reachable at ' + config.endpoint + ' in CI; the cooked store tests must run there.');
  console.warn('MinIO not reachable at ' + config.endpoint + '; skipping cooked store tests. Run: docker compose up -d');
}

/** A fresh symbol per run, so an overwrite in one run cannot mask a bug in the next. */
const symbol = `TEST${Date.now().toString(36).toUpperCase()}`;

function bar(time: BarTime, close: string): Bar {
  const value = price(parseScaled(close, 2));
  return {
    time,
    open: value,
    high: value,
    low: value,
    close: value,
    volume: volume(parseScaled('2.50000000', 8)),
  };
}

describe.skipIf(!available)('S3CookedBarStore against MinIO', () => {
  let store: S3CookedBarStore;

  beforeAll(() => {
    store = new S3CookedBarStore(config);
  });

  it('round-trips bars exactly', async () => {
    const start = barTimeFromUtcParts(2024, 3, 15);
    const bars = [bar(start, '100.00'), bar((start + 3600) as BarTime, '101.50')];
    await store.put(symbol, '1h', bars);
    expect(await store.getRange(symbol, '1h', start, (start + 7200) as BarTime)).toEqual(bars);
  });

  it('overwrites a partition, because cooked bars are rebuildable', async () => {
    // Unlike raw, re-cooking is normal: M1-10's rebuild check depends on it.
    const start = barTimeFromUtcParts(2024, 5, 1);
    await store.put(symbol, '1h', [bar(start, '1.00')]);
    await store.put(symbol, '1h', [bar(start, '2.00')]);
    const read = await store.getRange(symbol, '1h', start, start);
    expect(read).toHaveLength(1);
    expect(read[0]?.close).toBe(parseScaled('2.00', 2));
  });

  it('writes bars spanning a month boundary into both partitions', async () => {
    // The bug this guards: silently dropping the overflow into one file.
    const january = barTimeFromUtcParts(2024, 1, 31, 23, 0, 0);
    const february = barTimeFromUtcParts(2024, 2, 1, 0, 0, 0);
    await store.put(symbol, '1h', [bar(january, '10.00'), bar(february, '20.00')]);

    expect(await store.getPartition(symbol, '1h', '2024-01')).toHaveLength(1);
    expect(await store.getPartition(symbol, '1h', '2024-02')).toHaveLength(1);

    const both = await store.getRange(symbol, '1h', january, february);
    expect(both.map((b) => b.time)).toEqual([january, february]);
  });

  it('reads a range across a year boundary', async () => {
    const december = barTimeFromUtcParts(2023, 12, 31, 12, 0, 0);
    const january = barTimeFromUtcParts(2024, 1, 1, 12, 0, 0);
    await store.put(symbol, '4h', [bar(december, '5.00')]);
    await store.put(symbol, '4h', [bar(january, '6.00')]);
    const read = await store.getRange(symbol, '4h', december, january);
    expect(read.map((b) => b.time)).toEqual([december, january]);
  });

  it('keeps 1m and 1M in separate objects despite the case-only name difference', async () => {
    // On a case-insensitive disk these would be one file if the tokens were
    // `1m` and `1M`; the lower-case tokens are what prevent it.
    const time = barTimeFromUtcParts(2024, 7, 1);
    await store.put(symbol, '1m', [bar(time, '1.11')]);
    await store.put(symbol, '1M', [bar(time, '9.99')]);
    const minute = await store.getRange(symbol, '1m', time, time);
    const month = await store.getRange(symbol, '1M', time, time);
    expect(minute[0]?.close).toBe(parseScaled('1.11', 2));
    expect(month[0]?.close).toBe(parseScaled('9.99', 2));
  });

  it('treats a missing partition as a gap, not an error', async () => {
    const from = barTimeFromUtcParts(2019, 1, 1);
    expect(await store.getRange(symbol, '1h', from, barTimeFromUtcParts(2019, 3, 1))).toEqual([]);
    expect(await store.getPartition(symbol, '1h', '2019-01')).toBeUndefined();
  });

  it('clips the range to the bars asked for', async () => {
    const start = barTimeFromUtcParts(2024, 9, 2);
    const bars = [0, 1, 2, 3].map((i) => bar((start + i * 3600) as BarTime, '7.00'));
    await store.put(symbol, '1h', bars);
    const middle = await store.getRange(
      symbol,
      '1h',
      (start + 3600) as BarTime,
      (start + 7200) as BarTime,
    );
    expect(middle).toHaveLength(2);
  });

  it('rejects unsorted bars rather than writing them', async () => {
    const start = barTimeFromUtcParts(2024, 10, 1);
    const later = bar((start + 3600) as BarTime, '1.00');
    const earlier = bar(start, '2.00');
    await expect(store.put(symbol, '1h', [later, earlier])).rejects.toThrow(CookedStoreError);
  });

  it('writing no bars is a no-op', async () => {
    await expect(store.put(symbol, '1h', [])).resolves.toBeUndefined();
  });
});

describe('cookedKey', () => {
  it('uses the lower-case storage token', () => {
    expect(cookedKey('NVDA', '1M', '2024')).toBe('cooked/NVDA/1mo/2024.parquet');
    expect(cookedKey('NVDA', '1m', '2024-03')).toBe('cooked/NVDA/1m/2024-03.parquet');
    expect(cookedKey('BTCUSD', '1D', '2024')).toBe('cooked/BTCUSD/1d/2024.parquet');
  });

  it('gives 1m and 1M keys that differ in more than case', () => {
    const minute = cookedKey('NVDA', '1m', '2024-03');
    const month = cookedKey('NVDA', '1M', '2024-03');
    expect(minute.toLowerCase()).not.toBe(month.toLowerCase());
  });
});
