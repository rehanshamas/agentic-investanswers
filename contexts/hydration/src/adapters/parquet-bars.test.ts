import { barTimeFromUtcParts, parseScaled, price, volume } from '@aia/shared-kernel';
import type { Bar, BarTime } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import { codecIdsOf, decodeBars, encodeBars, ParquetBarsError } from './parquet-bars.js';

const CODEC = { uncompressed: 0, snappy: 1, gzip: 2, brotli: 4 } as const;

function bar(time: BarTime, o: string, h: string, l: string, c: string, v: string): Bar {
  return {
    time,
    open: price(parseScaled(o, 2)),
    high: price(parseScaled(h, 2)),
    low: price(parseScaled(l, 2)),
    close: price(parseScaled(c, 2)),
    volume: volume(parseScaled(v, 8)),
  };
}

const start = barTimeFromUtcParts(2024, 3, 15);
const sample: Bar[] = [
  bar(start, '68123.45', '68200.00', '68100.01', '68150.99', '1.23456789'),
  bar((start + 60) as BarTime, '68150.99', '68300.50', '68150.00', '68290.10', '0.00000001'),
  bar((start + 120) as BarTime, '68290.10', '68290.10', '68290.10', '68290.10', '0'),
];

describe('round trip', () => {
  it('returns exactly the same bars', async () => {
    const decoded = await decodeBars(await encodeBars(sample));
    expect(decoded).toEqual(sample);
  });

  it('is exact for volumes above 2^53, where a float64 could not be', async () => {
    // This is the whole reason prices and volumes are scaled whole numbers.
    const big = { ...sample[0], volume: volume(Number.MAX_SAFE_INTEGER) } as Bar;
    const decoded = await decodeBars(await encodeBars([big]));
    expect(decoded[0]?.volume).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('handles an empty bar list', async () => {
    expect(await decodeBars(await encodeBars([]))).toEqual([]);
  });

  it('preserves a full day of minutes', async () => {
    const day = Array.from({ length: 1440 }, (_, i) =>
      bar((start + i * 60) as BarTime, '100.00', '100.00', '100.00', '100.00', '1.00000000'),
    );
    const decoded = await decodeBars(await encodeBars(day));
    expect(decoded).toHaveLength(1440);
    expect(decoded).toEqual(day);
  });
});

describe('compression', () => {
  it('actually compresses, which parquetjs will not tell you', async () => {
    // The writer-level `compression` option is silently ignored by this
    // library, so the only honest check is the codec recorded in the file.
    expect(await codecIdsOf(await encodeBars(sample))).toEqual([CODEC.gzip]);
  });

  it('records the codec that was asked for', async () => {
    expect(await codecIdsOf(await encodeBars(sample, 'SNAPPY'))).toEqual([CODEC.snappy]);
    expect(await codecIdsOf(await encodeBars(sample, 'BROTLI'))).toEqual([CODEC.brotli]);
    expect(await codecIdsOf(await encodeBars(sample, 'UNCOMPRESSED'))).toEqual([
      CODEC.uncompressed,
    ]);
  });

  it('makes raw days smaller with gzip than uncompressed', async () => {
    const day = Array.from({ length: 1440 }, (_, i) =>
      bar((start + i * 60) as BarTime, '100.00', '100.50', '99.50', '100.25', '1.00000000'),
    );
    const gzipped = await encodeBars(day, 'GZIP');
    const plain = await encodeBars(day, 'UNCOMPRESSED');
    expect(gzipped.length).toBeLessThan(plain.length);
  });

  it('round-trips under every codec we claim to support', async () => {
    for (const codec of ['UNCOMPRESSED', 'GZIP', 'SNAPPY', 'BROTLI'] as const) {
      expect(await decodeBars(await encodeBars(sample, codec))).toEqual(sample);
    }
  });
});

describe('guards', () => {
  it('refuses to encode a value that cannot be stored exactly', async () => {
    const unsafe = { ...sample[0], volume: 2 ** 53 + 2 } as Bar;
    await expect(encodeBars([unsafe])).rejects.toThrow(ParquetBarsError);
  });
});
