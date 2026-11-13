// The raw store on S3 (MinIO locally): write-once Parquet, one file per
// provider, instrument and UTC day, plus write-once gap-fill files beside a
// day for minutes found later (M1-09), plus write-once live minutes and live
// gap records for days not yet settled (M1-05). Nothing is ever edited.

import type { S3Client } from '@aws-sdk/client-s3';

import type { Bar, BarTime } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import type { LiveHourStorePort } from '../application/live-hour-store-port.js';
import type { LiveRawStorePort } from '../application/live-raw-store-port.js';
import { LiveMinuteAlreadyStoredError } from '../application/live-raw-store-port.js';
import type { RawBarStorePort, RawDayRef } from '../application/raw-bar-store-port.js';
import { RawDayAlreadyStoredError, RawStoreError } from '../application/raw-bar-store-port.js';
import type { LiveGap } from '../domain/live-minutes.js';
import { assertStorableFill, assertStorableRawDay, dayEnd, dayStart, mergeDay } from '../domain/raw-day.js';
import { decodeBars, encodeBars } from './parquet-bars.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client, ensureBucket, exists, get, listKeys, putIfAbsent } from './s3-objects.js';
import { parseDateKey } from '@aia/shared-kernel';

/**
 * Object key for a raw day.
 *
 * `raw/<provider>/<symbol>/<YYYY>/<MM>/<DD>.parquet`. Split by year and month
 * so a prefix listing can scope to one month, which M1-09's gap detector will
 * want rather than listing an instrument's whole history.
 */
export function rawDayKey(ref: RawDayRef): string {
  const { year, month, day } = parseDateKey(ref.date);
  const pad = (value: number): string => value.toString().padStart(2, '0');
  return `raw/${ref.provider}/${ref.symbol}/${year}/${pad(month)}/${pad(day)}.parquet`;
}

/**
 * Object key for a day's `n`th gap fill (1, 2, ...):
 * `raw/<provider>/<symbol>/<YYYY>/<MM>/<DD>.fill-<n>.parquet`.
 */
export function rawFillKey(ref: RawDayRef, n: number): string {
  return rawDayKey(ref).replace(/\.parquet$/, `.fill-${n}.parquet`);
}

function fillPrefix(ref: RawDayRef): string {
  return rawDayKey(ref).replace(/\.parquet$/, '.fill-');
}

/** The fill number in a fill key, for ordering 2 before 10. */
function fillNumber(key: string): number {
  return Number(/\.fill-(\d+)\.parquet$/.exec(key)?.[1] ?? NaN);
}

/** `HHMM` of a time within its UTC day; `2400` for the end of the day. */
function hhmm(ref: RawDayRef, time: number): string {
  const minutes = Math.round((time - dayStart(ref.date)) / 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
}

function livePrefix(ref: RawDayRef): string {
  return rawDayKey(ref).replace(/\.parquet$/, '.live/');
}

function liveHourPrefix(ref: RawDayRef): string {
  return rawDayKey(ref).replace(/\.parquet$/, '.live-hours/');
}

/**
 * Object key for one hour of live minutes (M1-15b), written once the hour has ended:
 * `raw/<provider>/<symbol>/<YYYY>/<MM>/<DD>.live-hours/<HH>.parquet`.
 */
export function rawLiveHourKey(ref: RawDayRef, hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RawStoreError(`hour must be 0 to 23, got ${hour}`);
  return `${liveHourPrefix(ref)}${String(hour).padStart(2, '0')}.parquet`;
}

/** The `HH` of a live minute or hour key. */
function keyHour(key: string): string {
  return /\/(\d{2})(?:\d{2})?\.parquet$/.exec(key)?.[1] ?? '';
}

function liveGapPrefix(ref: RawDayRef): string {
  return rawDayKey(ref).replace(/\.parquet$/, '.live-gaps/');
}

/**
 * Object key for one live minute (M1-05):
 * `raw/<provider>/<symbol>/<YYYY>/<MM>/<DD>.live/<HHMM>.parquet`.
 */
export function rawLiveMinuteKey(ref: RawDayRef, time: BarTime): string {
  return `${livePrefix(ref)}${hhmm(ref, time)}.parquet`;
}

/**
 * Object key for a live gap record, `[from, until)` within the day:
 * `raw/<provider>/<symbol>/<YYYY>/<MM>/<DD>.live-gaps/<HHMM>-<HHMM>.json`.
 */
export function rawLiveGapKey(ref: RawDayRef, gap: LiveGap): string {
  return `${liveGapPrefix(ref)}${hhmm(ref, gap.from)}-${hhmm(ref, gap.until)}.json`;
}

function assertWithinDay(ref: RawDayRef, from: number, until: number, what: string): void {
  if (from < dayStart(ref.date) || until > dayEnd(ref.date) || from >= until || from % 60 !== 0 || until % 60 !== 0) {
    throw new RawStoreError(`${what} ${from}-${until} is not whole minutes within ${ref.date}`);
  }
}

export class S3RawBarStore implements RawBarStorePort, LiveRawStorePort, LiveHourStorePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StoreConfig, client?: S3Client) {
    this.client = client ?? createS3Client(config);
    this.bucket = config.bucket;
  }

  /** Create the bucket if it does not exist. */
  ensureBucket(): Promise<void> {
    return ensureBucket(this.client, this.bucket);
  }

  async putDay(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    // Validate before encoding: raw is never edited, so a bad file could only
    // be removed, which this store deliberately cannot do.
    assertStorableRawDay(ref.date, bars);
    const bytes = await encodeBars(bars);
    const written = await putIfAbsent(this.client, this.bucket, rawDayKey(ref), bytes);
    if (!written) throw new RawDayAlreadyStoredError(ref);
  }

  async getDay(ref: RawDayRef): Promise<Bar[] | undefined> {
    const bytes = await get(this.client, this.bucket, rawDayKey(ref));
    if (bytes === undefined) return undefined;
    const day = await decodeBars(bytes);
    const fills = await this.fillKeys(ref);
    if (fills.length === 0) return day;
    const parts: Bar[][] = [day];
    for (const key of fills) {
      const fill = await get(this.client, this.bucket, key);
      if (fill !== undefined) parts.push(await decodeBars(fill));
    }
    return mergeDay(ref.date, parts);
  }

  async putFill(ref: RawDayRef, bars: readonly Bar[]): Promise<void> {
    const existing = await this.getDay(ref);
    if (existing === undefined) {
      throw new RawStoreError(`Cannot fill ${ref.provider}/${ref.symbol}/${ref.date}: the day was never stored`);
    }
    assertStorableFill(ref.date, existing, bars);
    const bytes = await encodeBars([...bars].sort((a, b) => a.time - b.time));
    // The next free number; if another writer takes it first, re-check and
    // try the next, so two fills can never share a key or overlap.
    for (let attempt = 0; attempt < 5; attempt++) {
      const n = (await this.fillKeys(ref)).length + 1;
      if (await putIfAbsent(this.client, this.bucket, rawFillKey(ref, n), bytes)) return;
      assertStorableFill(ref.date, (await this.getDay(ref)) ?? [], bars);
    }
    throw new RawStoreError(`Could not store a fill for ${ref.provider}/${ref.symbol}/${ref.date}`);
  }

  private async fillKeys(ref: RawDayRef): Promise<string[]> {
    const keys = await listKeys(this.client, this.bucket, fillPrefix(ref));
    return keys.sort((a, b) => fillNumber(a) - fillNumber(b));
  }

  async hasDay(ref: RawDayRef): Promise<boolean> {
    return exists(this.client, this.bucket, rawDayKey(ref));
  }

  async putLiveMinute(ref: RawDayRef, bar: Bar): Promise<void> {
    assertWithinDay(ref, bar.time, bar.time + 60, 'Live minute');
    assertStorableRawDay(ref.date, [bar]);
    const key = rawLiveMinuteKey(ref, bar.time);
    if (!(await putIfAbsent(this.client, this.bucket, key, await encodeBars([bar])))) {
      throw new LiveMinuteAlreadyStoredError(`Live minute already stored: ${key}`);
    }
  }

  /**
   * Every live minute of the day: an hour's file where it exists (M1-15b),
   * otherwise that hour's minute objects. A whole sealed day is about 24 GETs
   * instead of 1,440.
   */
  async getLiveMinutes(ref: RawDayRef): Promise<Bar[]> {
    const [hourKeys, minuteKeys] = await Promise.all([
      listKeys(this.client, this.bucket, liveHourPrefix(ref)),
      listKeys(this.client, this.bucket, livePrefix(ref)),
    ]);
    const sealed = new Set(hourKeys.map(keyHour));
    const keys = [...hourKeys, ...minuteKeys.filter((key) => !sealed.has(keyHour(key)))];
    return this.readAll(keys);
  }

  async liveMinuteTimes(ref: RawDayRef, hour: number): Promise<BarTime[]> {
    const keys = await listKeys(this.client, this.bucket, `${livePrefix(ref)}${String(hour).padStart(2, '0')}`);
    return keys
      .map((key) => /(\d{2})(\d{2})\.parquet$/.exec(key))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => barTime(dayStart(ref.date) + Number(m[1]) * 3_600 + Number(m[2]) * 60))
      .sort((a, b) => a - b);
  }

  async getLiveMinutesOfHour(ref: RawDayRef, hour: number): Promise<Bar[]> {
    return this.readAll(await listKeys(this.client, this.bucket, `${livePrefix(ref)}${String(hour).padStart(2, '0')}`));
  }

  async putLiveHour(ref: RawDayRef, hour: number, bars: readonly Bar[]): Promise<boolean> {
    const from = dayStart(ref.date) + hour * 3_600;
    for (const bar of bars) assertWithinDay(ref, bar.time, bar.time + 60, 'Live hour minute');
    if (bars.some((b) => b.time < from || b.time >= from + 3_600)) throw new RawStoreError(`Live hour ${ref.date} ${hour}: a minute outside the hour`);
    assertStorableRawDay(ref.date, bars);
    return putIfAbsent(this.client, this.bucket, rawLiveHourKey(ref, hour), await encodeBars(bars));
  }

  /** Read and merge objects of live minutes, a batch at a time; ascending, one bar per time. */
  private async readAll(keys: readonly string[]): Promise<Bar[]> {
    const byTime = new Map<number, Bar>();
    for (let i = 0; i < keys.length; i += 32) {
      const batch = await Promise.all(keys.slice(i, i + 32).map((key) => get(this.client, this.bucket, key)));
      for (const bytes of batch) if (bytes !== undefined) for (const bar of await decodeBars(bytes)) byTime.set(bar.time, bar);
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  async putLiveGap(ref: RawDayRef, gap: LiveGap): Promise<void> {
    assertWithinDay(ref, gap.from, gap.until, 'Live gap');
    const body = Buffer.from(JSON.stringify({ from: gap.from, until: gap.until }));
    // A second record of the same window says nothing new, so it is not an error.
    await putIfAbsent(this.client, this.bucket, rawLiveGapKey(ref, gap), body);
  }

  async getLiveGaps(ref: RawDayRef): Promise<LiveGap[]> {
    const gaps: LiveGap[] = [];
    for (const key of await listKeys(this.client, this.bucket, liveGapPrefix(ref))) {
      const bytes = await get(this.client, this.bucket, key);
      if (bytes === undefined) continue;
      const { from, until } = JSON.parse(bytes.toString('utf8')) as { from: number; until: number };
      gaps.push({ from: barTime(from), until: barTime(until) });
    }
    return gaps.sort((a, b) => a.from - b.from);
  }
}
