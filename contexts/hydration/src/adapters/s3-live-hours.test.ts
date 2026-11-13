// M1-15b against the local MinIO: hour files for live minutes. A full day of
// live minutes reads back the same with hour files, in far fewer requests;
// an hour file is write-once. Skipped when MinIO is unreachable (fails in CI).

import { barTime, barTimeFromUtcParts, price, volume } from '@aia/shared-kernel';
import type { Bar } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { RawDayRef } from '../application/raw-bar-store-port.js';
import { RawStoreError } from '../application/raw-bar-store-port.js';
import { LiveHourSealer } from '../application/live-hour-sealer.js';
import { S3RawBarStore, rawLiveHourKey } from './s3-raw-bar-store.js';
import type { S3StoreConfig } from './s3-objects.js';

const counts = new Map<string, number>();
const config: S3StoreConfig = {
  bucket: 'aia-raw',
  endpoint: process.env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
  region: 'us-east-1',
  credentials: { accessKeyId: 'minio', secretAccessKey: 'minio12345' },
  observe: (command) => counts.set(command, (counts.get(command) ?? 0) + 1),
};
const store = new S3RawBarStore(config);
const available = await store.ensureBucket().then(
  () => true,
  () => false,
);
if (!available) {
  if (process.env['CI']) throw new Error(`MinIO not reachable at ${config.endpoint} in CI; the live hour tests must run there.`);
  console.warn(`MinIO not reachable at ${config.endpoint}; skipping live hour tests. Run: docker compose up -d`);
}

const runId = `test-hours-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const DATE = '2026-11-10';
const D0 = barTimeFromUtcParts(2026, 11, 10);
const ref = (symbol = 'BTCUSD'): RawDayRef => ({ provider: runId, symbol, date: DATE });

function minute(i: number): Bar {
  const p = 7_000_000 + i;
  return { time: barTime(D0 + i * 60), open: price(p), high: price(p + 5), low: price(p - 5), close: price(p + 1), volume: volume(10_000_000 + i) };
}

const requests = async (run: () => Promise<unknown>) => {
  counts.clear();
  await run();
  return Object.fromEntries(counts);
};

describe.skipIf(!available)('live hour files on MinIO (M1-15b)', () => {
  it('reads a full day of live minutes the same with hour files, in about 24 GETs instead of 1,440', async () => {
    const day = Array.from({ length: 1_440 }, (_, i) => minute(i)).filter((_, i) => i % 50 !== 7); // a few minutes with no trades
    for (let i = 0; i < day.length; i += 64) await Promise.all(day.slice(i, i + 64).map((b) => store.putLiveMinute(ref(), b)));

    let before: Bar[] = [];
    const unsealed = await requests(async () => (before = await store.getLiveMinutes(ref())));
    expect(before).toEqual(day);
    expect(unsealed['GetObjectCommand']).toBe(day.length);

    // The live process seals the 23 ended hours; 23:00 is still in progress.
    const sealer = new LiveHourSealer(store);
    const hours = Array.from({ length: 23 }, (_, h) => h);
    let outcomes = new Map();
    const sealing = await requests(async () => (outcomes = await sealer.seal(ref(), hours, day)));
    expect([...outcomes.values()]).toEqual(hours.map(() => 'sealed'));
    // One index of the day, whatever the number of hours: the hour files (1 LIST) and the
    // minute objects (S3 pages listings at 1,000 keys, so 2 LISTs for 1,411), then one PUT per hour.
    expect(sealing['ListObjectsV2Command']).toBe(3);
    expect(sealing['PutObjectCommand']).toBe(23);

    let after: Bar[] = [];
    const sealed = await requests(async () => (after = await store.getLiveMinutes(ref())));
    expect(after).toEqual(day);
    const hour23 = day.filter((b) => b.time >= D0 + 23 * 3_600).length;
    expect(sealed['GetObjectCommand']).toBe(23 + hour23);
    console.log(`full day: ${unsealed['GetObjectCommand']} GETs unsealed, ${sealed['GetObjectCommand']} with 23 hour files (LISTs ${unsealed['ListObjectsV2Command']} and ${sealed['ListObjectsV2Command']})`);
  }, 60_000);

  it('writes an hour file once; a second seal changes nothing', async () => {
    const bars = [minute(60), minute(61), minute(62)];
    for (const b of bars) await store.putLiveMinute(ref('ETHUSD'), b);
    const sealer = new LiveHourSealer(store);
    expect((await sealer.seal(ref('ETHUSD'), [1], bars)).get(1)).toBe('sealed');
    expect((await sealer.seal(ref('ETHUSD'), [1], bars)).get(1)).toBe('already-sealed');
    expect(await store.putLiveHour(ref('ETHUSD'), 1, [minute(60)])).toBe(false);
    expect(await store.getLiveMinutes(ref('ETHUSD'))).toEqual(bars);
  });

  it('seals from the stored objects when what the process holds differs, and an empty hour not at all', async () => {
    const bars = [minute(120), minute(121), minute(122)];
    for (const b of bars) await store.putLiveMinute(ref('SOLUSD'), b);
    const sealer = new LiveHourSealer(store);
    // The process missed 02:01 (another run stored it): the stored three go in the hour file.
    expect((await sealer.seal(ref('SOLUSD'), [2], [minute(120), minute(122)])).get(2)).toBe('sealed');
    expect(await store.getLiveMinutes(ref('SOLUSD'))).toEqual(bars);
    expect((await sealer.seal(ref('SOLUSD'), [3], [])).get(3)).toBe('empty');
  });

  it('refuses an hour file with a minute outside its hour, and names keys by hour', async () => {
    await expect(store.putLiveHour(ref('XRPUSD'), 4, [minute(5 * 60)])).rejects.toThrow(RawStoreError);
    expect(rawLiveHourKey(ref(), 7)).toMatch(/\/2026\/11\/10\.live-hours\/07\.parquet$/);
    expect(() => rawLiveHourKey(ref(), 24)).toThrow(RawStoreError);
  });
});
