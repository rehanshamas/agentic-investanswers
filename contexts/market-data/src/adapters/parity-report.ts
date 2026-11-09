// Turn parity results into the report `pnpm parity` prints: a summary table,
// then the first differing bar of every file that is not exact.
//
// Values are printed at the instrument's scale with `formatScaled`, which is
// exact, so what the report shows is exactly what was compared.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';

import type { ParityResult } from '../application/run-parity.js';
import { parityPassed } from '../application/run-parity.js';
import type { BarDifference, BarField } from '../domain/parity.js';
import { BAR_FIELDS } from '../domain/parity.js';

/** `2026-11-04 13:35`, always UTC: the exports' timestamps are UNIX seconds. */
export function formatUtc(time: BarTime): string {
  return new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function statusLabel(result: ParityResult): string {
  if (result.kind === 'no-export') return 'NO EXPORT';
  switch (result.comparison.status) {
    case 'exact':
      return 'EXACT';
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

function summaryRow(result: ParityResult): string[] {
  if (result.kind === 'no-export') {
    return [result.file, statusLabel(result), '-', '', '', '', '', ''];
  }
  const c = result.comparison;
  const window =
    c.window === undefined ? '-' : `${formatUtc(c.window.from)} .. ${formatUtc(c.window.until)}`;
  return [
    result.file,
    statusLabel(result),
    window,
    String(c.matched),
    String(c.differing),
    String(c.missing),
    String(c.extra),
    String(c.window?.skipped ?? 0),
  ];
}

function cells(instrument: Instrument, bar: Bar | undefined): string[] {
  if (bar === undefined) return ['(no bar)', '', '', '', ''];
  return BAR_FIELDS.map((field) =>
    formatScaled(bar[field], field === 'volume' ? instrument.volumeScale : instrument.priceScale),
  );
}

function explain(difference: BarDifference): string {
  if (difference.ours === undefined) return 'we have no bar here';
  if (difference.theirs === undefined) return 'we have a bar the export does not';
  const count = difference.fields.length;
  return `${count} field${count === 1 ? '' : 's'} differ${count === 1 ? 's' : ''}: ${difference.fields.join(', ')}`;
}

/** The block showing one differing bar, export above ours, with carets under what differs. */
export function formatDifference(
  file: string,
  instrument: Instrument,
  difference: BarDifference,
): string {
  const header = ['', ...BAR_FIELDS];
  const theirs = ['export', ...cells(instrument, difference.theirs)];
  const ours = ['ours', ...cells(instrument, difference.ours)];
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
    `${file}: first difference at ${formatUtc(difference.time)} UTC (${difference.time}), ${explain(difference)}`,
    `  ${h ?? ''}`,
    `  ${t ?? ''}`,
    `  ${o ?? ''}`,
    ...(carets === '' ? [] : [`  ${carets}`]),
  ].join('\n');
}

/** The full report: summary, first differences, what to do next, verdict. */
export function formatParityReport(results: readonly ParityResult[]): string {
  const lines: string[] = [];
  lines.push(
    ...table(
      [
        ['FILE', 'STATUS', 'WINDOW (UTC)', 'MATCH', 'DIFFER', 'MISSING', 'EXTRA', 'SKIPPED'],
        ...results.map(summaryRow),
      ],
      new Set([3, 4, 5, 6, 7]),
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
    notes.push('NO OVERLAP: we hold bars, but our history starts after the export ends.');
  }
  for (const result of results) {
    if (result.kind === 'no-export') notes.push(`NO EXPORT: ${result.message}`);
  }
  if (results.some((r) => r.kind === 'compared' && (r.comparison.window?.skipped ?? 0) > 0)) {
    notes.push(
      'SKIPPED: export bars before our history begins (plus our first bar, which may be ' +
        'partial). Inside the window nothing is skipped.',
    );
  }
  if (notes.length > 0) lines.push('', ...notes);

  const exact = results.filter(
    (r) => r.kind === 'compared' && r.comparison.status === 'exact',
  ).length;
  lines.push(
    '',
    parityPassed(results)
      ? `PARITY OK: ${exact} of ${results.length} files exact.`
      : `PARITY FAILED: ${exact} of ${results.length} files exact.`,
  );
  return lines.join('\n');
}
