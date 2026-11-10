// The report `pnpm rebuild-check` prints: one row per instrument and
// timeframe, the first difference of each failing one, and a verdict.

import type { Instrument, Timeframe } from '@aia/shared-kernel';

import type { PartitionResult } from '../application/rebuild-check.js';
import { differences } from '../domain/rebuild-diff.js';
import { formatDifference } from './parity-report.js';

const REBUILD_LABELS = {
  theirs: 'stored',
  ours: 'rebuilt',
  oursMissing: 'stored, but not rebuildable from raw',
  theirsMissing: 'rebuilt from raw, but missing from the store',
};

interface Row {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  partitions: number;
  matched: number;
  differences: number;
  notCooked: number;
  noRaw: number;
  first: PartitionResult | undefined;
}

/** Total differences across every partition checked. */
export function totalDifferences(results: readonly PartitionResult[]): number {
  return results.reduce((sum, r) => sum + differences(r.diff), 0);
}

/** True only when something was checked and nothing differs. */
export function rebuildPassed(results: readonly PartitionResult[]): boolean {
  return results.length > 0 && totalDifferences(results) === 0;
}

export function formatRebuildReport(
  results: readonly PartitionResult[],
  instruments: readonly Instrument[],
): string {
  const rows = new Map<string, Row>();
  for (const r of results) {
    const key = `${r.symbol}/${r.timeframe}`;
    const row = rows.get(key) ?? {
      symbol: r.symbol,
      timeframe: r.timeframe,
      partitions: 0,
      matched: 0,
      differences: 0,
      notCooked: 0,
      noRaw: 0,
      first: undefined,
    };
    row.partitions++;
    row.matched += r.diff.matched;
    row.differences += differences(r.diff);
    if (r.kind === 'not-cooked') row.notCooked++;
    if (r.kind === 'no-raw') row.noRaw++;
    if (row.first === undefined && differences(r.diff) > 0) row.first = r;
    rows.set(key, row);
  }

  const table: string[][] = [
    ['SYMBOL', 'TIMEFRAME', 'MONTHS', 'BARS MATCH', 'DIFFERENCES', 'NOT COOKED', 'NO RAW'],
    ...[...rows.values()].map((row) => [
      row.symbol,
      row.timeframe,
      String(row.partitions),
      String(row.matched),
      String(row.differences),
      String(row.notCooked),
      String(row.noRaw),
    ]),
  ];
  const widths = table[0]?.map((_, i) => Math.max(...table.map((r) => (r[i] ?? '').length))) ?? [];
  const lines = table.map((r) =>
    r.map((cell, i) => (i >= 2 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0))).join('  ').trimEnd(),
  );

  for (const row of rows.values()) {
    const failing = row.first;
    const instrument = instruments.find((i) => i.symbol === row.symbol);
    if (failing?.diff.first === undefined || instrument === undefined) continue;
    lines.push(
      '',
      formatDifference(
        `${row.symbol} ${row.timeframe} ${failing.partition}`,
        instrument,
        failing.diff.first,
        REBUILD_LABELS,
      ),
    );
  }

  const total = totalDifferences(results);
  const notes: string[] = [];
  if ([...rows.values()].some((r) => r.notCooked > 0)) {
    notes.push('NOT COOKED: months with raw 1m bars but no cooked file. Run: pnpm cook');
  }
  if ([...rows.values()].some((r) => r.noRaw > 0)) {
    notes.push('NO RAW: cooked files with no raw 1m bars behind them: cooked must come only from raw.');
  }
  if (notes.length > 0) lines.push('', ...notes);
  lines.push(
    '',
    results.length === 0
      ? 'REBUILD CHECK FAILED: nothing to check (no raw and no cooked bars in range).'
      : total === 0
        ? `REBUILD CHECK OK: 0 differences across ${results.length} partition files.`
        : `REBUILD CHECK FAILED: ${total} differences across ${results.length} partition files.`,
  );
  return lines.join('\n');
}
