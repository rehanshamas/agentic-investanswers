// The raw store on S3 (MinIO locally): write-once Parquet, one file per
// provider, instrument and UTC day, plus write-once gap-fill files beside a
// day for minutes found later (M1-09). Nothing is ever edited.

import type { S3Client } from '@aws-sdk/client-s3';

import type { Bar } from '@aia/shared-kernel';

import type { RawBarStorePort, RawDayRef } from '../application/raw-bar-store-port.js';
import { RawDayAlreadyStoredError, RawStoreError } from '../application/raw-bar-store-port.js';
import { assertStorableFill, assertStorableRawDay, mergeDay } from '../domain/raw-day.js';
import { decodeBars, encodeBars } from './parquet-bars.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client, exists, get, listKeys, putIfAbsent } from './s3-objects.js';
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

export class S3RawBarStore implements RawBarStorePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StoreConfig, client?: S3Client) {
    this.client = client ?? createS3Client(config);
    this.bucket = config.bucket;
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
}
