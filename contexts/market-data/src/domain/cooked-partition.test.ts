import { barTimeFromUtcParts, TIMEFRAMES } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import {
  CookedPartitionError,
  partitionOf,
  partitionsBetween,
  storageToken,
  timeframeFromStorageToken,
} from './cooked-partition.js';

describe('storage tokens', () => {
  it('is lower case for every timeframe, so no two can fold together', () => {
    const tokens = TIMEFRAMES.map(storageToken);
    expect(tokens).toEqual(['1m', '5m', '15m', '1h', '4h', '1d', '1w', '1mo']);
    for (const token of tokens) expect(token).toBe(token.toLowerCase());
  });

  it('keeps 1-minute and monthly distinct without relying on case', () => {
    // MinIO stores objects as files, so on a case-insensitive disk `1m` and
    // `1M` would be the same directory and a 1-minute partition would silently
    // overwrite a monthly one. This is the assertion that stops that.
    expect(storageToken('1m')).toBe('1m');
    expect(storageToken('1M')).toBe('1mo');
    expect(storageToken('1m').toLowerCase()).not.toBe(storageToken('1M').toLowerCase());
  });

  it('maps every token back to exactly one timeframe', () => {
    for (const timeframe of TIMEFRAMES) {
      expect(timeframeFromStorageToken(storageToken(timeframe))).toBe(timeframe);
    }
    expect(new Set(TIMEFRAMES.map(storageToken)).size).toBe(TIMEFRAMES.length);
  });

  it('does not recognise a token it did not produce', () => {
    for (const bad of ['1M', '1D', '1W', '1min', '1mon', '']) {
      expect(timeframeFromStorageToken(bad)).toBeUndefined();
    }
  });
});

describe('partitionOf', () => {
  it('groups intraday bars by month', () => {
    expect(partitionOf('1m', barTimeFromUtcParts(2024, 3, 15, 7, 43, 0))).toBe('2024-03');
    expect(partitionOf('4h', barTimeFromUtcParts(2024, 12, 31, 20, 0, 0))).toBe('2024-12');
    expect(partitionOf('1h', barTimeFromUtcParts(2024, 1, 1))).toBe('2024-01');
  });

  it('groups calendar bars by year', () => {
    expect(partitionOf('1D', barTimeFromUtcParts(2024, 3, 15))).toBe('2024');
    expect(partitionOf('1W', barTimeFromUtcParts(2024, 3, 11))).toBe('2024');
    expect(partitionOf('1M', barTimeFromUtcParts(2024, 3, 1))).toBe('2024');
  });

  it('pads the month, so keys sort lexically', () => {
    const keys = [1, 2, 10, 11, 12].map((month) =>
      partitionOf('1m', barTimeFromUtcParts(2024, month, 1)),
    );
    expect(keys).toEqual(['2024-01', '2024-02', '2024-10', '2024-11', '2024-12']);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe('partitionsBetween', () => {
  it('returns the single partition for a range inside one month', () => {
    expect(
      partitionsBetween(
        '1m',
        barTimeFromUtcParts(2024, 3, 1),
        barTimeFromUtcParts(2024, 3, 31, 23, 59, 0),
      ),
    ).toEqual(['2024-03']);
  });

  it('spans a month boundary', () => {
    expect(
      partitionsBetween('1m', barTimeFromUtcParts(2024, 1, 31), barTimeFromUtcParts(2024, 3, 1)),
    ).toEqual(['2024-01', '2024-02', '2024-03']);
  });

  it('spans a year boundary, rolling the month over correctly', () => {
    expect(
      partitionsBetween('1h', barTimeFromUtcParts(2023, 11, 15), barTimeFromUtcParts(2024, 2, 15)),
    ).toEqual(['2023-11', '2023-12', '2024-01', '2024-02']);
  });

  it('returns years for calendar timeframes', () => {
    expect(
      partitionsBetween('1D', barTimeFromUtcParts(2022, 6, 1), barTimeFromUtcParts(2024, 6, 1)),
    ).toEqual(['2022', '2023', '2024']);
  });

  it('covers a two-year 1-minute range without gaps', () => {
    const partitions = partitionsBetween(
      '1m',
      barTimeFromUtcParts(2022, 1, 1),
      barTimeFromUtcParts(2023, 12, 31),
    );
    expect(partitions).toHaveLength(24);
    expect(partitions[0]).toBe('2022-01');
    expect(partitions.at(-1)).toBe('2023-12');
  });

  it('includes the partition a bar sits in, for every bar in the range', () => {
    // The property the range read depends on: if this ever fails, getRange
    // silently drops bars.
    const from = barTimeFromUtcParts(2023, 11, 20);
    const until = barTimeFromUtcParts(2024, 1, 10);
    const covered = new Set(partitionsBetween('1m', from, until));
    for (let time = from; time <= until; time = (time + 86_400) as typeof time) {
      expect(covered.has(partitionOf('1m', time))).toBe(true);
    }
  });

  it('rejects a backwards range rather than returning nothing', () => {
    expect(() =>
      partitionsBetween('1m', barTimeFromUtcParts(2024, 3, 1), barTimeFromUtcParts(2024, 1, 1)),
    ).toThrow(CookedPartitionError);
  });
});
