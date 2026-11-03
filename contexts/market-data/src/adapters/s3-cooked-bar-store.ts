// The cooked store on S3 (MinIO locally): one Parquet file per instrument,
// timeframe and partition, overwritten whenever that partition is re-cooked.

import type { S3Client } from '@aws-sdk/client-s3';

import type { Bar, BarTime, Timeframe } from '@aia/shared-kernel';

import type { CookedBarStorePort } from '../application/cooked-bar-store-port.js';
import { CookedStoreError } from '../application/cooked-bar-store-port.js';
import {
  partitionOf,
  partitionsBetween,
  storageToken,
} from '../domain/cooked-partition.js';
import { decodeBars, encodeBars } from './parquet-bars.js';
import type { S3StoreConfig } from './s3-objects.js';
import { createS3Client, get, put } from './s3-objects.js';

/** `cooked/<symbol>/<token>/<partition>.parquet`, with the lower-case token. */
export function cookedKey(symbol: string, timeframe: Timeframe, partition: string): string {
  return `cooked/${symbol}/${storageToken(timeframe)}/${partition}.parquet`;
}

export class S3CookedBarStore implements CookedBarStorePort {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3StoreConfig, client?: S3Client) {
    this.client = client ?? createS3Client(config);
    this.bucket = config.bucket;
  }

  async put(symbol: string, timeframe: Timeframe, bars: readonly Bar[]): Promise<void> {
    if (bars.length === 0) return;

    // Group by partition, so a batch spanning a month or year end writes both
    // files rather than silently dropping the overflow into one of them.
    const byPartition = new Map<string, Bar[]>();
    let previous: BarTime | undefined;
    for (const bar of bars) {
      if (previous !== undefined && bar.time <= previous) {
        throw new CookedStoreError(
          `Cooked bars must be strictly ascending: ${bar.time} follows ${previous}`,
        );
      }
      previous = bar.time;
      const partition = partitionOf(timeframe, bar.time);
      const group = byPartition.get(partition);
      if (group === undefined) byPartition.set(partition, [bar]);
      else group.push(bar);
    }

    for (const [partition, group] of byPartition) {
      const bytes = await encodeBars(group);
      await put(this.client, this.bucket, cookedKey(symbol, timeframe, partition), bytes);
    }
  }

  async getPartition(
    symbol: string,
    timeframe: Timeframe,
    partition: string,
  ): Promise<Bar[] | undefined> {
    const bytes = await get(this.client, this.bucket, cookedKey(symbol, timeframe, partition));
    if (bytes === undefined) return undefined;
    return decodeBars(bytes);
  }

  async getRange(
    symbol: string,
    timeframe: Timeframe,
    from: BarTime,
    until: BarTime,
  ): Promise<Bar[]> {
    const bars: Bar[] = [];
    // Partitions are computed, not listed, so this is one GET per partition
    // and no LIST. A missing partition is simply a gap, not an error.
    for (const partition of partitionsBetween(timeframe, from, until)) {
      const stored = await this.getPartition(symbol, timeframe, partition);
      if (stored === undefined) continue;
      for (const bar of stored) {
        if (bar.time >= from && bar.time <= until) bars.push(bar);
      }
    }
    return bars;
  }
}
