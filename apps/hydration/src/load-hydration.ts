// `pnpm load-hydration`: load test the live data path (M1-15).
//
// Simulated instruments each close a minute at the same moment, every minute,
// as a live stream would. Each minute is stored in raw (write-once), then
// handed to `pnpm live`'s own LivePipeline: cooked, applied to the recent-bars
// cache and announced. Every S3 request and Redis operation is counted.
//
//   pnpm load-hydration                                  500 instruments, 5 minutes at the real rate
//   pnpm load-hydration --instruments 50 --minutes 3
//   pnpm load-hydration --minute-ms 10000                 a "minute" every 10 s (quicker, harsher)
//   pnpm load-hydration --day 1                           start of a month: small cooked partitions
//
// By default the simulation starts at 23:58 on the 28th, with each
// instrument's cooked month already filled up to then, because cost that grows
// with the partition shows late in a month; the third minute crosses midnight,
// so the daily compaction is measured too. It uses its own buckets (aia-load-raw,
// aia-load-cooked) and Redis database 14, with fresh symbols every run; all of
// it is disposable.
//
// Prints per-minute timings and counts, then a projection to 2, 50 and 500
// instruments (requests a day and S3 cost at list prices). Exits 1 if any
// minute took longer than a minute to handle (the pipeline fell behind), 2 on
// bad usage or an unreachable stack.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { S3RawBarStore } from '@aia/hydration';
import type { RecentBarsCachePort } from '@aia/market-data';
import { INTRADAY_ROLLUPS, RedisLiveBarsBus, RedisRecentBarsCache, S3CookedBarStore } from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, price, timeframeSeconds, volume, zonedDateKey } from '@aia/shared-kernel';

import { LivePipeline } from './live-pipeline.js';

const USAGE = 'Usage: pnpm load-hydration [--instruments N] [--minutes M] [--minute-ms MS] [--day D]';

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    instruments: { type: 'string' },
    minutes: { type: 'string' },
    'minute-ms': { type: 'string' },
    day: { type: 'string' },
  },
});
const whole = (text: string | undefined, fallback: number, name: string, max = Infinity): number => {
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value < 1 || value > max) usage(`--${name} must be a whole number from 1${max === Infinity ? '' : ` to ${max}`}`);
  return value;
};
const INSTRUMENTS = whole(values.instruments, 500, 'instruments');
const MINUTES = whole(values.minutes, 5, 'minutes');
const MINUTE_MS = whole(values['minute-ms'], 60_000, 'minute-ms');
const DAY = whole(values.day, 28, 'day', 28);

/** S3 Standard list prices, us-east-1 (USD per 1,000 requests). Check current pricing before quoting. */
const PRICE_PER_1000 = { write: 0.005, read: 0.0004 };
const WRITES = new Set(['PutObjectCommand', 'ListObjectsV2Command', 'CopyObjectCommand']);

// ---- counting -------------------------------------------------------------

type Counts = Map<string, { requests: number; bytes: number }>;
let counts: Counts = new Map();
const count = (key: string, bytes = 0) => {
  const entry = counts.get(key) ?? { requests: 0, bytes: 0 };
  entry.requests++;
  entry.bytes += bytes;
  counts.set(key, entry);
};
const take = (): Counts => {
  const taken = counts;
  counts = new Map();
  return taken;
};

function countingCache(inner: RecentBarsCachePort): RecentBarsCachePort {
  return {
    get: (s, tf) => (count('redis'), inner.get(s, tf)),
    version: (s, tf) => (count('redis'), inner.version(s, tf)),
    fill: (s, tf, w, v) => (count('redis'), inner.fill(s, tf, w, v)),
    apply: (s, tf, b) => (count('redis'), inner.apply(s, tf, b)),
    invalidate: (s, tf) => (count('redis'), inner.invalidate(s, tf)),
  };
}

// ---- simulated data -------------------------------------------------------

const run = randomUUID().slice(0, 8);
const instruments: Instrument[] = Array.from({ length: INSTRUMENTS }, (_, i) => ({
  symbol: `L${run}N${String(i).padStart(4, '0')}`,
  kind: 'crypto',
  venue: 'LOAD',
  timeZone: 'UTC',
  priceScale: 2,
  volumeScale: 8,
}));
// Two minutes before midnight: every timeframe has a bar in progress, and the
// third minute starts a new UTC day, which sets off compaction.
const SIM_START = barTimeFromUtcParts(2026, 11, DAY, 23, 58);

function bar(time: number, seed: number): Bar {
  const base = 5_000_000 + ((seed * 7_919) % 100_000);
  return {
    time: barTime(time),
    open: price(base),
    high: price(base + 50),
    low: price(base - 50),
    close: price(base + (seed % 40) - 20),
    volume: volume(100_000_000 + seed),
  };
}

/** The cooked month as it would stand at the simulation's start. */
function monthSoFar(timeframe: Timeframe, seed: number): Bar[] {
  const span = timeframeSeconds(timeframe) as number;
  const start: number = barTimeFromUtcParts(2026, 11, 1);
  const bars: Bar[] = [];
  for (let t = start; t < SIM_START; t += span) bars.push(bar(t, seed + t));
  return bars;
}

// ---- report ---------------------------------------------------------------

const n = (value: number) => Math.round(value).toLocaleString('en-GB');
const percentile = (sorted: readonly number[], f: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
const sum = (c: Counts, prefix: string, command?: string) =>
  [...c].filter(([k]) => k.startsWith(prefix) && (command === undefined || k.endsWith(command))).reduce((a, [, v]) => a + v.requests, 0);
const bytes = (c: Counts, prefix: string) => [...c].filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v.bytes, 0);

function row(label: string, c: Counts, times: readonly number[]): string {
  const sorted = [...times].sort((a, b) => a - b);
  return [
    label.padEnd(9),
    `${n(percentile(sorted, 0.5))}`.padStart(7),
    `${n(percentile(sorted, 0.95))}`.padStart(7),
    `${n(sorted.at(-1) ?? 0)}`.padStart(7),
    `${n(sum(c, 'raw:', 'PutObjectCommand'))}`.padStart(8),
    `${n(sum(c, 'raw:', 'GetObjectCommand'))}`.padStart(8),
    `${n(sum(c, 'raw:', 'ListObjectsV2Command'))}`.padStart(8),
    `${n(sum(c, 'cooked:', 'GetObjectCommand'))}`.padStart(8),
    `${n(sum(c, 'cooked:', 'PutObjectCommand'))}`.padStart(8),
    `${(bytes(c, 'cooked:') / 1e6).toFixed(1)}`.padStart(9),
    `${n(sum(c, 'redis'))}`.padStart(7),
  ].join(' ');
}

async function main(): Promise<void> {
  const env = process.env;
  const s3 = {
    endpoint: env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000',
    region: env['AIA_S3_REGION'] ?? 'us-east-1',
    credentials: { accessKeyId: env['AIA_S3_ACCESS_KEY'] ?? 'minio', secretAccessKey: env['AIA_S3_SECRET_KEY'] ?? 'minio12345' },
  };
  const raw = new S3RawBarStore({ ...s3, bucket: 'aia-load-raw', observe: (command, b) => count(`raw:${command}`, b) });
  const cooked = new S3CookedBarStore({ ...s3, bucket: 'aia-load-cooked', observe: (command, b) => count(`cooked:${command}`, b) });
  const redisUrl = env['AIA_REDIS_URL'] ?? 'redis://127.0.0.1:6379';
  let cache: RedisRecentBarsCache;
  let bus: RedisLiveBarsBus;
  try {
    await raw.ensureBucket();
    await cooked.ensureBucket();
    cache = await RedisRecentBarsCache.connect({ url: `${redisUrl}/14` });
    bus = await RedisLiveBarsBus.connect({ url: redisUrl, channel: `load:hydration:${run}` });
  } catch (error) {
    usage(`The local stack is unreachable (${String(error)}). Run: docker compose up -d`);
  }

  const errors: string[] = [];
  const compactions: Array<{ at: number; ms: number }> = [];
  const pipeline = new LivePipeline({
    instruments,
    raw,
    rawProviderOf: () => 'loadsim',
    liveProviderOf: () => 'loadsim',
    cooked,
    watermarks: cooked,
    hours: raw,
    cache: countingCache(cache),
    bus: { publish: (batch) => (count('redis'), bus.publish(batch)) },
    publisher: `load-${run}`,
    log: (line) => {
      if (line.includes('failed')) errors.push(line);
      else if (line.includes('settled day')) compactions.push({ at: performance.now(), ms: Number(/in (\d+) ms/.exec(line)?.[1] ?? 0) });
      else console.log(`  ${line}`);
    },
    nowMs: () => Date.now(),
  });

  console.log(`Filling each instrument's cooked month up to 2026-11-${String(DAY).padStart(2, '0')} 23:58 (not counted)...`);
  for (let i = 0; i < instruments.length; i += 25) {
    await Promise.all(
      instruments.slice(i, i + 25).flatMap((instrument, j) => [
        ...(DAY > 1 ? INTRADAY_ROLLUPS.map((tf) => cooked.put(instrument.symbol, tf, monthSoFar(tf, i + j))) : []),
        // As a process that has been running: earlier days are settled.
        cooked.setWatermark(instrument.symbol, barTimeFromUtcParts(2026, 11, DAY)),
      ]),
    );
  }
  take();

  console.log(
    `${n(INSTRUMENTS)} instruments, ${MINUTES} minutes, a minute every ${MINUTE_MS / 1000} s, from 2026-11-${String(DAY).padStart(2, '0')} 23:58 (run ${run})\n`,
  );
  console.log('minute    p50 ms  p95 ms  max ms  raw PUT  raw GET raw LIST  ckd GET  ckd PUT  ckd MB up  redis');
  const minutesSeen: Array<{ counts: Counts; times: number[]; start: number; dayChange: boolean }> = [];
  let fellBehind = false;
  const started = performance.now();
  for (let k = 0; k < MINUTES; k++) {
    const wait = started + k * MINUTE_MS - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const closed = performance.now();
    const time = SIM_START + k * 60;
    const times = await Promise.all(
      instruments.map(async (instrument, i) => {
        const minute = bar(time, i * 1_000 + k);
        await raw.putLiveMinute({ provider: 'loadsim', symbol: instrument.symbol, date: zonedDateKey(time, 'UTC') }, minute);
        await pipeline.minute('loadsim', instrument.symbol, minute);
        return performance.now() - closed;
      }),
    );
    // Counted up to the next minute's close, so background compaction lands in the minute it ran in.
    const nextClose = started + (k + 1) * MINUTE_MS;
    if (k < MINUTES - 1 && nextClose > performance.now()) await new Promise((resolve) => setTimeout(resolve, nextClose - performance.now() - 5));
    const c = take();
    const dayChange = time % 86_400 === 0;
    console.log(row(k === 0 ? `${k + 1} (start)` : dayChange ? `${k + 1} (00:00)` : `${k + 1}`, c, times));
    if (times.reduce((a, b) => Math.max(a, b), 0) > MINUTE_MS) fellBehind = true;
    minutesSeen.push({ counts: c, times, start: closed, dayChange });
  }
  await pipeline.settled();
  const trailing = take(); // compaction still running after the last minute

  // Ordinary minutes: after the start, with no compaction running. The day's
  // compaction work: everything the other minutes did beyond an ordinary
  // minute, plus what ran after the last one. Projected as ordinary × 1,440 +
  // compaction once a day.
  const lastCompaction = compactions.reduce((a, c) => Math.max(a, c.at), 0);
  const firstDayChange = minutesSeen.findIndex((m) => m.dayChange);
  const compacting = (i: number) => firstDayChange >= 0 && i >= firstDayChange && minutesSeen[i]!.start <= lastCompaction;
  const ordinary = minutesSeen.filter((_, i) => i > 0 && !compacting(i));
  const busy = minutesSeen.filter((_, i) => i > 0 && compacting(i));
  const kinds = new Set([...minutesSeen.flatMap((m) => [...m.counts.keys()]), ...trailing.keys()]);
  const perMinute = new Map<string, { requests: number; bytes: number }>();
  for (const key of kinds) {
    const total = ordinary.reduce((a, m) => a + (m.counts.get(key)?.requests ?? 0), 0);
    const totalBytes = ordinary.reduce((a, m) => a + (m.counts.get(key)?.bytes ?? 0), 0);
    perMinute.set(key, { requests: total / Math.max(1, ordinary.length), bytes: totalBytes / Math.max(1, ordinary.length) });
  }
  const daily = new Map<string, { requests: number; bytes: number }>();
  for (const key of kinds) {
    const base = perMinute.get(key) ?? { requests: 0, bytes: 0 };
    const requests = busy.reduce((a, m) => a + (m.counts.get(key)?.requests ?? 0) - base.requests, 0) + (trailing.get(key)?.requests ?? 0);
    const b = busy.reduce((a, m) => a + (m.counts.get(key)?.bytes ?? 0) - base.bytes, 0) + (trailing.get(key)?.bytes ?? 0);
    daily.set(key, { requests: Math.max(0, requests), bytes: Math.max(0, b) });
  }
  const isWrite = (key: string) => key.includes(':') && WRITES.has(key.split(':')[1] as string);
  const isRead = (key: string) => key.includes(':') && !isWrite(key);
  const total = (m: Map<string, { requests: number; bytes: number }>, f: (k: string) => boolean) => [...m].filter(([k]) => f(k)).reduce((a, [, v]) => a + v.requests, 0);
  const per = (m: Map<string, { requests: number; bytes: number }>, key: string) => (m.get(key)?.requests ?? 0) / INSTRUMENTS;
  const writesPerDay = (total(perMinute, isWrite) * 1_440 + total(daily, isWrite)) / INSTRUMENTS;
  const readsPerDay = (total(perMinute, isRead) * 1_440 + total(daily, isRead)) / INSTRUMENTS;
  const cookedMbPerDay = ([...perMinute].filter(([k]) => k.startsWith('cooked:')).reduce((a, [, v]) => a + v.bytes, 0) * 1_440 +
    [...daily].filter(([k]) => k.startsWith('cooked:')).reduce((a, [, v]) => a + v.bytes, 0)) / INSTRUMENTS / 1e6;
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  const ordinaryTimes = sorted(ordinary.flatMap((m) => m.times));
  const busyTimes = sorted(busy.flatMap((m) => m.times));
  const compactionMs = sorted(compactions.map((c) => c.ms));
  console.log(
    [
      '',
      `Ordinary minute, per instrument: raw PUT ${per(perMinute, 'raw:PutObjectCommand').toFixed(2)}, raw GET ${per(perMinute, 'raw:GetObjectCommand').toFixed(2)}, ` +
        `cooked GET ${per(perMinute, 'cooked:GetObjectCommand').toFixed(2)}, cooked PUT ${per(perMinute, 'cooked:PutObjectCommand').toFixed(2)}, Redis ${per(perMinute, 'redis').toFixed(1)}`,
      `Daily compaction, per instrument: raw GET ${per(daily, 'raw:GetObjectCommand').toFixed(1)}, raw LIST ${per(daily, 'raw:ListObjectsV2Command').toFixed(1)}, ` +
        `cooked GET ${per(daily, 'cooked:GetObjectCommand').toFixed(1)}, cooked PUT ${per(daily, 'cooked:PutObjectCommand').toFixed(1)}` +
        (compactions.length === 0 ? ' (no midnight in this run)' : `; ${compactions.length} instruments compacted, ${n(percentile(compactionMs, 0.5))} ms each (p50), all done ${((lastCompaction - (minutesSeen[firstDayChange]?.start ?? lastCompaction)) / 1000).toFixed(0)} s after midnight`),
      '',
      'Projection          S3 writes/day   S3 reads/day   cooked GB up/day   S3 requests $/month',
      ...[2, 50, 500].map((count_) => {
        const dollars = ((writesPerDay * count_) / 1000) * PRICE_PER_1000.write * 30 + ((readsPerDay * count_) / 1000) * PRICE_PER_1000.read * 30;
        return `${`${count_} instruments`.padEnd(19)} ${n(writesPerDay * count_).padStart(13)}   ${n(readsPerDay * count_).padStart(12)}   ${((cookedMbPerDay * count_) / 1000).toFixed(2).padStart(16)}   ${('$' + dollars.toFixed(0)).padStart(19)}`;
      }),
      '(ordinary minutes × 1,440 + one compaction a day; S3 Standard list prices, us-east-1: $0.005 per 1,000 writes and lists,',
      ' $0.0004 per 1,000 reads; requests only, not storage. Compaction here reads a few live minutes per day; a full day of',
      ' live minutes reads as about 24 hour files plus the hour in progress (M1-15b).)',
      '',
      `Minute close to announced: ordinary minutes p50 ${n(percentile(ordinaryTimes, 0.5))} ms, p95 ${n(percentile(ordinaryTimes, 0.95))} ms` +
        (busyTimes.length === 0 ? '.' : `; during compaction p50 ${n(percentile(busyTimes, 0.5))} ms, p95 ${n(percentile(busyTimes, 0.95))} ms.`),
      fellBehind ? 'FELL BEHIND: a minute took longer than a minute to handle.' : 'Kept up: every minute was handled within the minute.',
      ...(errors.length === 0 ? [] : [`${errors.length} pipeline errors, for example: ${errors[0]}`]),
    ].join('\n'),
  );
  await cache.close();
  await bus.close();
  process.exit(fellBehind || errors.length > 0 ? 1 : 0);
}

await main();
