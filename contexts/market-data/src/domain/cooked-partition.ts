// How cooked bars are grouped into files, and what those files are called.
// Pure: imports only @aia/shared-kernel, no I/O, no clock.

import type { BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime, barTimeFromUtcParts, isIntraday, zonedParts } from '@aia/shared-kernel';

export class CookedPartitionError extends Error {}

/**
 * Timeframe names as they appear in storage keys.
 *
 * Lower case throughout, with `1mo` for monthly, matching the export file
 * names in docs/bar-rules.md and for the same reason. On real S3 keys are
 * case-sensitive, so `1m` and `1M` would be distinct and this would not
 * matter — but **MinIO stores objects as files**, and on a case-insensitive
 * disk (macOS and Windows by default) `.../1M/2024.parquet` and
 * `.../1m/2024.parquet` are the same file. A 1-minute partition would
 * silently overwrite a monthly one locally and behave correctly on staging:
 * the worst kind of bug, because the environment that is wrong is the one you
 * develop on.
 */
const STORAGE_TOKENS: { readonly [T in Timeframe]: string } = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1D': '1d',
  '1W': '1w',
  '1M': '1mo',
};

export function storageToken(timeframe: Timeframe): string {
  return STORAGE_TOKENS[timeframe];
}

/** The timeframe a storage token refers to, or `undefined` if it is not one. */
export function timeframeFromStorageToken(token: string): Timeframe | undefined {
  const found = Object.entries(STORAGE_TOKENS).find(([, value]) => value === token);
  return found === undefined ? undefined : (found[0] as Timeframe);
}

/**
 * Which file a bar belongs in.
 *
 * Intraday bars are grouped by month and calendar bars by year, which keeps
 * files in a useful size range instead of 60-row files for 1W: a month of
 * 1-minute crypto bars is about 44,000 rows, and a year of weekly bars is 52.
 *
 * Partitions are cut on **UTC** boundaries even for stocks, whose bars are
 * stamped by session date. The two agree for every stock bar, because a
 * session never spans a month or year end, and keeping the rule UTC-only means
 * the storage layout never depends on a market calendar that may later be
 * corrected (M1-12).
 */
export function partitionOf(timeframe: Timeframe, time: BarTime): string {
  const parts = zonedParts(time, 'UTC');
  const year = parts.year.toString().padStart(4, '0');
  if (!isIntraday(timeframe)) return year;
  return `${year}-${parts.month.toString().padStart(2, '0')}`;
}

/**
 * Every partition that could hold bars in `[from, until]`, inclusive, in order.
 *
 * Returned by computing the range rather than listing the bucket, so a range
 * read costs one GET per partition and no LIST.
 */
export function partitionsBetween(
  timeframe: Timeframe,
  from: BarTime,
  until: BarTime,
): string[] {
  if (until < from) {
    throw new CookedPartitionError(`Range is backwards: ${from} to ${until}`);
  }
  const start = zonedParts(from, 'UTC');
  const end = zonedParts(until, 'UTC');
  const partitions: string[] = [];

  if (!isIntraday(timeframe)) {
    for (let year = start.year; year <= end.year; year += 1) {
      partitions.push(year.toString().padStart(4, '0'));
    }
    return partitions;
  }

  let year = start.year;
  let month = start.month;
  while (year < end.year || (year === end.year && month <= end.month)) {
    partitions.push(`${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return partitions;
}

/**
 * The time span a partition covers, both ends inclusive: a UTC month
 * (`2024-11`) for intraday timeframes, a UTC year (`2024`) for calendar ones.
 */
export function partitionBounds(partition: string): { from: BarTime; until: BarTime } {
  const month = /^(\d{4})-(\d{2})$/.exec(partition);
  if (month !== null) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) throw new CookedPartitionError(`Not a partition: ${partition}`);
    const from = barTimeFromUtcParts(year, m, 1);
    const next = m === 12 ? barTimeFromUtcParts(year + 1, 1, 1) : barTimeFromUtcParts(year, m + 1, 1);
    return { from, until: barTime(next - 1) };
  }
  const year = /^(\d{4})$/.exec(partition);
  if (year !== null) {
    const y = Number(year[1]);
    return { from: barTimeFromUtcParts(y, 1, 1), until: barTime(barTimeFromUtcParts(y + 1, 1, 1) - 1) };
  }
  throw new CookedPartitionError(`Not a partition: ${partition}`);
}
