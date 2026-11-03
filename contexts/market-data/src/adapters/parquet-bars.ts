// Bars to Parquet bytes and back.
//
// DELIBERATE DUPLICATE of contexts/hydration/src/adapters/parquet-bars.ts.
// The boundary rules leave no shared home for it: shared-kernel must stay pure
// (no Parquet, no AWS), and market-data, which owns cooked bars, must not
// depend on hydration. Two copies is the price of that boundary. A third
// consumer would be the signal to add a small shared adapters package.
//
// @aia/shared-kernel, so no float ever reaches disk and a round trip is exact.
// parquetjs returns INT64 as `bigint`, which is what lets this work above
// 2^53; the shared kernel's own guards keep values inside the safe-integer
// range, so the BigInt/Number conversions here cannot lose anything.
//
// Two traps in this library, both found by measuring rather than reading:
//  1. Compression must be declared **per column**. The writer-level
//     `compression` option is silently ignored: pass it there and you get an
//     uncompressed file with no warning at all. `codecIdsOf` exists so a test
//     can prove what was really written.
//  2. Its `ParquetCompression` type offers ZSTD, LZO and LZ4, but the runtime
//     codec table has only UNCOMPRESSED, GZIP, SNAPPY and BROTLI. Asking for
//     ZSTD typechecks and then throws. Hence `SupportedCompression` below,
//     which lists only the codecs verified to work.

import { Writable } from 'node:stream';

import type { Bar } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import parquet from '@dsnp/parquetjs';

export class ParquetBarsError extends Error {}

/** The codecs this library can actually do, as opposed to the ones it types. */
export type SupportedCompression = 'UNCOMPRESSED' | 'GZIP' | 'SNAPPY' | 'BROTLI';

/**
 * Cooked bars are read on every chart load, so read speed beats size: snappy
 * decompresses faster than gzip, at 17.2kB against 6.9kB on a measured
 * 2,000-bar sample. The raw store makes the opposite trade.
 */
const COOKED_COMPRESSION: SupportedCompression = 'SNAPPY';

function schema(compression: SupportedCompression): parquet.ParquetSchema {
  const column = { type: 'INT64' as const, compression };
  return new parquet.ParquetSchema({
    time: column,
    open: column,
    high: column,
    low: column,
    close: column,
    volume: column,
  });
}

/**
 * parquetjs types its sink as `Pick<fs.WriteStream, 'write' | 'end'>`, so a
 * `stream.Writable` fails to typecheck only because `end()` returns
 * `Writable` rather than `WriteStream`. At runtime just those two methods are
 * called, and a plain `Writable` works — verified against the real library
 * before this cast was written.
 */
type ParquetSink = Parameters<typeof parquet.ParquetWriter.openStream>[1];

function toBigInt(value: number, field: string): bigint {
  if (!Number.isSafeInteger(value)) {
    throw new ParquetBarsError(
      `${field} ${value} is not a safe integer, so it cannot be stored exactly`,
    );
  }
  return BigInt(value);
}

function fromBigInt(value: unknown, field: string): number {
  const asBigInt = typeof value === 'bigint' ? value : BigInt(value as number);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (asBigInt > limit || asBigInt < -limit) {
    throw new ParquetBarsError(`${field} ${asBigInt} read back outside the safe-integer range`);
  }
  return Number(asBigInt);
}

/** Encode bars as a Parquet file in memory. */
export async function encodeBars(
  bars: readonly Bar[],
  compression: SupportedCompression = COOKED_COMPRESSION,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const finished = new Promise<void>((resolve, reject) => {
    sink.on('finish', () => resolve());
    sink.on('error', reject);
  });

  const writer = await parquet.ParquetWriter.openStream(
    schema(compression),
    sink as unknown as ParquetSink,
  );
  for (const bar of bars) {
    await writer.appendRow({
      time: toBigInt(bar.time, 'time'),
      open: toBigInt(bar.open, 'open'),
      high: toBigInt(bar.high, 'high'),
      low: toBigInt(bar.low, 'low'),
      close: toBigInt(bar.close, 'close'),
      volume: toBigInt(bar.volume, 'volume'),
    });
  }
  await writer.close();
  await finished;
  return Buffer.concat(chunks);
}

/** Decode a Parquet file back into bars. */
export async function decodeBars(bytes: Buffer): Promise<Bar[]> {
  const reader = await parquet.ParquetReader.openBuffer(bytes);
  try {
    const cursor = reader.getCursor();
    const bars: Bar[] = [];
    let row = (await cursor.next()) as Record<string, unknown> | null;
    while (row !== null && Object.keys(row).length > 0) {
      bars.push({
        time: barTime(fromBigInt(row['time'], 'time')),
        open: price(fromBigInt(row['open'], 'open')),
        high: price(fromBigInt(row['high'], 'high')),
        low: price(fromBigInt(row['low'], 'low')),
        close: price(fromBigInt(row['close'], 'close')),
        volume: volume(fromBigInt(row['volume'], 'volume')),
      });
      row = (await cursor.next()) as Record<string, unknown> | null;
    }
    return bars;
  } finally {
    await reader.close();
  }
}

/**
 * The compression codec ids actually recorded in a Parquet file.
 *
 * 0 uncompressed, 1 snappy, 2 gzip, 4 brotli. Tests use this to prove a file
 * is really compressed, because parquetjs will not complain if it is not.
 */
export async function codecIdsOf(bytes: Buffer): Promise<number[]> {
  const reader = await parquet.ParquetReader.openBuffer(bytes);
  try {
    const ids = new Set<number>();
    for (const group of reader.metadata?.row_groups ?? []) {
      for (const column of group.columns ?? []) {
        const codec = column.meta_data?.codec;
        if (typeof codec === 'number') ids.add(codec);
      }
    }
    return [...ids].sort((a, b) => a - b);
  } finally {
    await reader.close();
  }
}
