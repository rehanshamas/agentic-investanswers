// The raw store on S3 (MinIO locally): write-once Parquet, one file per
// provider, instrument and UTC day.

import type { S3Client } from '@aws-sdk/client-s3';

import type { Bar } from '@aia/shared-kernel';

import type { RawBarStorePort, RawDayRef } from '../application/raw-bar-store-port.js';
import { RawDayAlreadyStoredError } from '../application/raw-bar-store-port.js';
import { assertStorableRawDay } from '../domain/raw-day.js';
import { decodeBars, encodeBars } from './parquet-bars.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client, exists, get, putIfAbsent } from './s3-objects.js';
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
    return decodeBars(bytes);
  }

  async hasDay(ref: RawDayRef): Promise<boolean> {
    return exists(this.client, this.bucket, rawDayKey(ref));
  }
}
