// Compare a stored cooked partition with the same partition rebuilt from raw.
// Pure: imports only @aia/shared-kernel and this context's domain.
//
// CLAUDE.md rule 3: cooked bars are always rebuildable from raw. So a stored
// partition must equal its rebuild exactly, bar for bar — no window, no
// tolerance, no recent-bar allowance. Unlike parity, both sides here are our
// own code and our own data; any difference is a bug or a stale file.

import type { Bar, BarTime } from '@aia/shared-kernel';

import type { BarDifference } from './parity.js';
import { BAR_FIELDS } from './parity.js';

export class RebuildDiffError extends Error {}

export interface RebuildDiff {
  readonly matched: number;
  /** In both, but at least one field differs. */
  readonly differing: number;
  /** Rebuilt from raw but absent from the store: cooking missed it. */
  readonly missingFromStore: number;
  /** Stored but not rebuildable from raw: a stale or invented bar. */
  readonly notRebuildable: number;
  /**
   * The earliest difference. In the `BarDifference`, `theirs` is the stored
   * bar and `ours` the rebuilt one.
   */
  readonly first: BarDifference | undefined;
}

/** Total of every kind of difference. */
export function differences(diff: RebuildDiff): number {
  return diff.differing + diff.missingFromStore + diff.notRebuildable;
}

function assertAscending(bars: readonly Bar[], side: string): void {
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1];
    const current = bars[i];
    if (previous !== undefined && current !== undefined && current.time <= previous.time) {
      throw new RebuildDiffError(
        `${side} bars must be strictly ascending: ${current.time} follows ${previous.time}`,
      );
    }
  }
}

/** Exact comparison of `stored` against `rebuilt`, both ascending. */
export function diffBars(rebuilt: readonly Bar[], stored: readonly Bar[]): RebuildDiff {
  assertAscending(rebuilt, 'Rebuilt');
  assertAscending(stored, 'Stored');

  let matched = 0;
  let differing = 0;
  let missingFromStore = 0;
  let notRebuildable = 0;
  let first: BarDifference | undefined;
  const note = (time: BarTime, s: Bar | undefined, r: Bar | undefined, fields: BarDifference['fields']): void => {
    if (first === undefined) first = { time, theirs: s, ours: r, fields };
  };

  let i = 0;
  let j = 0;
  while (i < rebuilt.length || j < stored.length) {
    const r = rebuilt[i];
    const s = stored[j];
    if (r !== undefined && (s === undefined || r.time < s.time)) {
      missingFromStore++;
      note(r.time, undefined, r, BAR_FIELDS);
      i++;
    } else if (s !== undefined && (r === undefined || s.time < r.time)) {
      notRebuildable++;
      note(s.time, s, undefined, BAR_FIELDS);
      j++;
    } else if (r !== undefined && s !== undefined) {
      const fields = BAR_FIELDS.filter((field) => r[field] !== s[field]);
      if (fields.length === 0) {
        matched++;
      } else {
        differing++;
        note(r.time, s, r, fields);
      }
      i++;
      j++;
    }
  }
  return { matched, differing, missingFromStore, notRebuildable, first };
}
