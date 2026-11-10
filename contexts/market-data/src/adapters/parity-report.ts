// Turn parity results into the report `pnpm parity` prints.
//
// - `formatParityReport`: an exact comparison — a summary table, the first
//   differing bar of every file that is not exact, and a verdict. Build
//   parity uses it (with a FROM column naming the export rebuilt from).
// - `formatFidelityReport`: source fidelity, reported only — how often each
//   field matches, and the largest volume gap. It has no verdict.
//
// Values are printed at the instrument's scale with `formatScaled`, which is
// exact, so what the report shows is exactly what was compared.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';

import type { ParityResult } from '../application/run-parity.js';
import { parityPassed } from '../application/run-parity.js';
import { BUILD_PARITY_EXCEPTIONS } from '../domain/build-parity-exceptions.js';
import type { BarDifference, BarField } from '../domain/parity.js';
import { BAR_FIELDS } from '../domain/parity.js';

/** `2026-11-04 13:35`, always UTC: the exports' timestamps are UNIX seconds. */
export function formatUtc(time: BarTime): string {
  return new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function statusLabel(result: ParityResult): string {
  if (result.kind === 'no-export') return 'NO EXPORT';
  if (result.kind === 'error') return 'ERROR';
  switch (result.comparison.status) {
    case 'exact':
      return 'EXACT';
    case 'excepted':
      return 'EXCEPTION';
    case 'differs':
      return 'FAIL';
    case 'not-built':
      return 'NOT BUILT';
    case 'no-overlap':
      return 'NO OVERLAP';
  }
}

function table(rows: readonly (readonly string[])[], rightAligned: ReadonlySet<number>): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        return rightAligned.has(index) ? cell.padStart(width) : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd(),
  );
}

function windowText(result: ParityResult): string {
  if (result.kind !== 'compared' || result.comparison.window === undefined) return '-';
  const { from, until } = result.comparison.window;
  return `${formatUtc(from)} .. ${formatUtc(until)}`;
}

function summaryRow(result: ParityResult, withSource: boolean): string[] {
  const source = withSource
    ? result.kind === 'compared'
      ? [String(result.comparison.recentDiffers ?? 0), result.sourceFile ?? '']
      : ['', '']
    : [];
  if (result.kind !== 'compared') {
    return [result.file, statusLabel(result), '-', '', '', '', '', '', ...source];
  }
  const c = result.comparison;
  return [
    result.file,
    statusLabel(result),
    windowText(result),
    String(c.matched),
    String(c.differing),
    String(c.missing),
    String(c.extra),
    String(c.window?.skipped ?? 0),
    ...source,
  ];
}

/** Errors and missing exports, shared by both reports. */
function problemNotes(results: readonly ParityResult[]): string[] {
  const notes: string[] = [];
  for (const result of results) {
    if (result.kind === 'no-export') notes.push(`NO EXPORT: ${result.message}`);
    if (result.kind === 'error') notes.push(`ERROR: ${result.message}`);
  }
  return notes;
}

function cells(instrument: Instrument, bar: Bar | undefined): string[] {
  if (bar === undefined) return ['(no bar)', '', '', '', ''];
  return BAR_FIELDS.map((field) =>
    formatScaled(bar[field], field === 'volume' ? instrument.volumeScale : instrument.priceScale),
  );
}

export interface DifferenceLabels {
  /** Row label for `theirs`; default `export`. */
  readonly theirs: string;
  /** Row label for `ours`; default `ours`. */
  readonly ours: string;
  /** Explanation when `ours` is missing; default "we have no bar here". */
  readonly oursMissing: string;
  /** Explanation when `theirs` is missing; default "we have a bar the export does not". */
  readonly theirsMissing: string;
}

const PARITY_LABELS: DifferenceLabels = {
  theirs: 'export',
  ours: 'ours',
  oursMissing: 'we have no bar here',
  theirsMissing: 'we have a bar the export does not',
};

function explain(difference: BarDifference, labels: DifferenceLabels): string {
  if (difference.ours === undefined) return labels.oursMissing;
  if (difference.theirs === undefined) return labels.theirsMissing;
  const count = difference.fields.length;
  return `${count} field${count === 1 ? '' : 's'} differ${count === 1 ? 's' : ''}: ${difference.fields.join(', ')}`;
}

/** The block showing one differing bar, export above ours, with carets under what differs. */
export function formatDifference(
  file: string,
  instrument: Instrument,
  difference: BarDifference,
  labels: DifferenceLabels = PARITY_LABELS,
): string {
  const header = ['', ...BAR_FIELDS];
  const theirs = [labels.theirs, ...cells(instrument, difference.theirs)];
  const ours = [labels.ours, ...cells(instrument, difference.ours)];
  const [h, t, o] = table([header, theirs, ours], new Set([1, 2, 3, 4, 5]));

  // Carets under each differing column, only when both bars exist.
  let carets = '';
  if (difference.theirs !== undefined && difference.ours !== undefined) {
    const differs = new Set<BarField>(difference.fields);
    const widths = header.map((_, i) =>
      Math.max(...[header, theirs, ours].map((row) => (row[i] ?? '').length)),
    );
    carets = widths
      .map((width, i) => {
        const field = BAR_FIELDS[i - 1];
        return (field !== undefined && differs.has(field) ? '^' : ' ').repeat(width);
      })
      .join('  ')
      .trimEnd();
  }

  return [
    `${file}: first difference at ${formatUtc(difference.time)} UTC (${difference.time}), ${explain(difference, labels)}`,
    `  ${h ?? ''}`,
    `  ${t ?? ''}`,
    `  ${o ?? ''}`,
    ...(carets === '' ? [] : [`  ${carets}`]),
  ].join('\n');
}

export interface ParityReportOptions {
  /** Names the check in the verdict, for example `BUILD PARITY`. */
  readonly label?: string;
}

/** The full report: summary, first differences, what to do next, verdict. */
export function formatParityReport(
  results: readonly ParityResult[],
  options: ParityReportOptions = {},
): string {
  const label = options.label ?? 'PARITY';
  const withSource = results.some((r) => r.kind === 'compared' && r.sourceFile !== undefined);
  const header = ['FILE', 'STATUS', 'WINDOW (UTC)', 'MATCH', 'DIFFER', 'MISSING', 'EXTRA', 'SKIPPED'];
  const lines: string[] = [];
  lines.push(
    ...table(
      [
        withSource ? [...header, 'RECENT DIFF', 'FROM'] : header,
        ...results.map((r) => summaryRow(r, withSource)),
      ],
      new Set(withSource ? [3, 4, 5, 6, 7, 8] : [3, 4, 5, 6, 7]),
    ),
  );

  for (const result of results) {
    if (result.kind === 'compared' && result.comparison.first !== undefined) {
      if (result.comparison.status === 'not-built') continue;
      lines.push('', formatDifference(result.file, result.instrument, result.comparison.first));
    }
  }

  const has = (label: string): boolean => results.some((r) => statusLabel(r) === label);
  const notes: string[] = [];
  if (has('NOT BUILT')) {
    notes.push(
      'NOT BUILT: we hold no bars in that export\'s range. 1m is read from the raw store ' +
        '(M1-04 backfill); 5m to 4h from the cooked store (M1-06); 1D, 1W, 1M are M1-08.',
    );
  }
  if (has('NO OVERLAP')) {
    notes.push(
      withSource
        ? 'NO OVERLAP: the finer export covers no complete bar of this one.'
        : 'NO OVERLAP: we hold bars, but our history starts after the export ends.',
    );
  }
  notes.push(...problemNotes(results));
  if (results.some((r) => r.kind === 'compared' && (r.comparison.window?.skipped ?? 0) > 0)) {
    notes.push(
      withSource
        ? 'SKIPPED: export bars before the finer export begins (plus the first rebuilt bar ' +
            'when the finer export starts inside it). Inside the window nothing is skipped.'
        : 'SKIPPED: export bars before our history begins (plus our first bar, which may be ' +
            'partial). Inside the window nothing is skipped.',
    );
  }
  const recent = results.reduce(
    (sum, r) => sum + (r.kind === 'compared' ? (r.comparison.recentDiffers ?? 0) : 0),
    0,
  );
  if (withSource && recent > 0) {
    notes.push(
      `RECENT DIFF: ${recent} bars that closed within 14 days of the newest bar in either export ` +
        "differ, and are excused: TradingView's live-built bars are not yet reconciled across its " +
        'timeframes. Recent bars that match are counted in MATCH. Older bars must be exact.',
    );
  }
  notes.push(...exceptionNotes(results));
  if (notes.length > 0) lines.push('', ...notes);

  const count = (status: string): number =>
    results.filter((r) => r.kind === 'compared' && r.comparison.status === status).length;
  const exact = count('exact');
  const excepted = count('excepted');
  const withExceptions = excepted > 0 ? `, ${excepted} more exact apart from approved exceptions` : '';
  lines.push(
    '',
    parityPassed(results)
      ? `${label} OK: ${exact} of ${results.length} files exact${withExceptions}.`
      : `${label} FAILED: ${exact} of ${results.length} files exact${withExceptions}.`,
  );
  return lines.join('\n');
}

/** One note per exception applied, with its reason, and one per stale exception. */
function exceptionNotes(results: readonly ParityResult[]): string[] {
  const notes: string[] = [];
  for (const result of results) {
    if (result.kind !== 'compared') continue;
    const stale = new Set(result.comparison.staleExceptions ?? []);
    for (const time of stale) {
      notes.push(
        `STALE EXCEPTION: ${result.file} ${formatUtc(time)} no longer differs as listed; ` +
          'remove it from build-parity-exceptions.ts (with Sham).',
      );
    }
    if ((result.comparison.excepted ?? 0) === 0) continue;
    for (const exception of BUILD_PARITY_EXCEPTIONS) {
      if (
        exception.symbol === result.instrument.symbol &&
        exception.timeframe === result.timeframe &&
        !stale.has(exception.time)
      ) {
        notes.push(
          `EXCEPTION: ${result.file} ${formatUtc(exception.time)} ${exception.fields.join(', ')}: ` +
            `${exception.reason} Approved: ${exception.approved}.`,
        );
      }
    }
  }
  return notes;
}

function percent(part: number, whole: number): string {
  if (whole === 0) return '-';
  const value = (100 * part) / whole;
  // Never round a shortfall up to 100: 99.996% prints as 99.99, not 100.00.
  return (Math.floor(value * 100) / 100).toFixed(2);
}

/**
 * Source fidelity: our stored bars against each export, as match rates.
 *
 * Reported, never a verdict (Sham, 2026-11-09): TradingView's record misses
 * trades, so volume can never match a venue's own candles exactly. The rates
 * show how close our data is; build parity is what proves our bar building.
 */
export function formatFidelityReport(results: readonly ParityResult[]): string {
  const rows = results.map((result) => {
    if (result.kind !== 'compared') {
      return [result.file, statusLabel(result), '-', '', '', '', '', '', '', '', '', ''];
    }
    const c = result.comparison;
    const both = c.matched + c.differing;
    const equal = (field: BarField): string => percent(both - c.fieldDiffers[field], both);
    const status = c.status === 'exact' ? 'EXACT' : c.status === 'differs' ? 'DIFFERS' : statusLabel(result);
    return [
      result.file,
      status,
      windowText(result),
      String(both),
      equal('open'),
      equal('high'),
      equal('low'),
      equal('close'),
      equal('volume'),
      both === 0 ? '-' : `${(c.maxVolumeDeviation * 100).toFixed(2)}`,
      String(c.missing),
      String(c.extra),
    ];
  });
  const lines = table(
    [
      ['FILE', 'STATUS', 'WINDOW (UTC)', 'BARS', 'OPEN%', 'HIGH%', 'LOW%', 'CLOSE%', 'VOL%', 'MAX dVOL%', 'MISSING', 'EXTRA'],
      ...rows,
    ],
    new Set([3, 4, 5, 6, 7, 8, 9, 10, 11]),
  );
  const notes = [
    'Each % is the share of bars present on both sides that are equal on that field. ' +
      'MAX dVOL% is the largest volume gap, relative to the export.',
    ...problemNotes(results),
  ];
  if (results.some((r) => statusLabel(r) === 'NOT BUILT')) {
    notes.push('NOT BUILT: we hold no bars in that export\'s range yet.');
  }
  return [...lines, '', ...notes, '', 'Source fidelity is reported only; it does not affect the exit code.'].join('\n');
}
