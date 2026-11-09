// Compare our bars with a TradingView export, bar for bar.
// Pure: imports only @aia/shared-kernel, no I/O, no clock.
//
// docs/bar-rules.md, "Comparing against the exports": parity is exact, with
// no tolerance. Both sides are already scaled integers at the instrument's
// precision (the loader parses the export that way, and cooked bars are built
// that way), so `191.2` and `191.20` are the same number before we get here
// and a plain `!==` is the whole comparison.

import type { Bar, BarTime } from '@aia/shared-kernel';

export const BAR_FIELDS = ['open', 'high', 'low', 'close', 'volume'] as const;

export type BarField = (typeof BAR_FIELDS)[number];

/**
 * One bar that is not equal on both sides.
 *
 * `ours` undefined means we are missing the bar; `theirs` undefined means we
 * have a bar the export does not. Otherwise both exist and `fields` lists
 * what differs.
 */
export interface BarDifference {
  readonly time: BarTime;
  readonly theirs: Bar | undefined;
  readonly ours: Bar | undefined;
  readonly fields: readonly BarField[];
}

/** The span actually compared, both ends inclusive. */
export interface ParityWindow {
  readonly from: BarTime;
  readonly until: BarTime;
  /** Export bars before `from`, left out because our history starts later. */
  readonly skipped: number;
}

/**
 * - `exact`: every export bar in the window equals ours, with nothing extra.
 * - `differs`: at least one bar differs, is missing or is extra.
 * - `not-built`: we hold no bars in the export's range at all.
 * - `no-overlap`: we hold bars, but none inside a comparable window.
 */
export type ParityStatus = 'exact' | 'differs' | 'not-built' | 'no-overlap';

export interface ParityComparison {
  readonly status: ParityStatus;
  readonly window: ParityWindow | undefined;
  readonly matched: number;
  readonly differing: number;
  readonly missing: number;
  readonly extra: number;
  /** The earliest difference of any kind, which is where to start looking. */
  readonly first: BarDifference | undefined;
  /** Among bars present on both sides, how many differ on each field. */
  readonly fieldDiffers: Readonly<Record<BarField, number>>;
  /**
   * Largest relative volume difference among bars present on both sides,
   * `|ours - theirs| / theirs`; 0 when every volume matches. Source fidelity
   * reports it, since a feed missing trades shows up here first.
   */
  readonly maxVolumeDeviation: number;
}

function noFieldDiffers(): Record<BarField, number> {
  return { open: 0, high: 0, low: 0, close: 0, volume: 0 };
}

/**
 * Work out which span of the export we can fairly be held to.
 *
 * The end is the export's last bar; the loader has already dropped the
 * forming one (docs/bar-rules.md, "Discard the last bar of every export").
 * Bars we hold beyond it are not compared, since we may simply be newer.
 *
 * The start is the export's first bar, unless our history begins later. Then
 * our own first bar is left out too, because the minutes before it may not
 * exist and it can be built from part of its bucket. Everything inside the
 * window is strict: a missing bar there is a failure, never a skip.
 *
 * Returns `undefined` when there is nothing comparable.
 */
export function parityWindow(
  theirs: readonly Bar[],
  ours: readonly Bar[],
): ParityWindow | undefined {
  const theirFirst = theirs[0];
  const theirLast = theirs[theirs.length - 1];
  const ourFirst = ours[0];
  if (theirFirst === undefined || theirLast === undefined || ourFirst === undefined) {
    return undefined;
  }

  let from: BarTime;
  if (ourFirst.time <= theirFirst.time) {
    from = theirFirst.time;
  } else {
    const ourSecond = ours[1];
    if (ourSecond === undefined) return undefined;
    from = ourSecond.time;
  }
  if (from > theirLast.time) return undefined;

  const skipped = theirs.filter((bar) => bar.time < from).length;
  return { from, until: theirLast.time, skipped };
}

function differingFields(theirs: Bar, ours: Bar): BarField[] {
  return BAR_FIELDS.filter((field) => theirs[field] !== ours[field]);
}

function assertAscending(bars: readonly Bar[], side: string): void {
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1];
    const current = bars[i];
    if (previous !== undefined && current !== undefined && current.time <= previous.time) {
      throw new ParityError(
        `${side} bars must be strictly ascending: ${current.time} follows ${previous.time}`,
      );
    }
  }
}

export class ParityError extends Error {}

/**
 * Compare the export (`theirs`) with our bars over the window
 * `parityWindow` chooses. Both inputs must be strictly ascending.
 */
export function compareBars(theirs: readonly Bar[], ours: readonly Bar[]): ParityComparison {
  assertAscending(theirs, 'Export');
  assertAscending(ours, 'Our');

  const empty = {
    matched: 0,
    differing: 0,
    extra: 0,
    first: undefined,
    fieldDiffers: noFieldDiffers(),
    maxVolumeDeviation: 0,
  };
  if (ours.length === 0) {
    const theirFirst = theirs[0];
    const theirLast = theirs[theirs.length - 1];
    const window =
      theirFirst === undefined || theirLast === undefined
        ? undefined
        : { from: theirFirst.time, until: theirLast.time, skipped: 0 };
    return { ...empty, status: 'not-built', window, missing: theirs.length };
  }

  const window = parityWindow(theirs, ours);
  if (window === undefined) {
    return { ...empty, status: 'no-overlap', window, missing: 0 };
  }

  const inWindow = (bar: Bar): boolean => bar.time >= window.from && bar.time <= window.until;
  const a = theirs.filter(inWindow);
  const b = ours.filter(inWindow);

  let matched = 0;
  let differing = 0;
  let missing = 0;
  let extra = 0;
  let first: BarDifference | undefined;
  const fieldDiffers = noFieldDiffers();
  let maxVolumeDeviation = 0;
  const note = (difference: BarDifference): void => {
    if (first === undefined) first = difference;
  };

  // Merge walk: both sides ascending, so the first difference noted is the
  // earliest in time.
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const t = a[i];
    const o = b[j];
    if (t !== undefined && (o === undefined || t.time < o.time)) {
      missing++;
      note({ time: t.time, theirs: t, ours: undefined, fields: BAR_FIELDS });
      i++;
    } else if (o !== undefined && (t === undefined || o.time < t.time)) {
      extra++;
      note({ time: o.time, theirs: undefined, ours: o, fields: BAR_FIELDS });
      j++;
    } else if (t !== undefined && o !== undefined) {
      const fields = differingFields(t, o);
      for (const field of fields) fieldDiffers[field]++;
      if (t.volume !== o.volume) {
        const deviation = t.volume === 0 ? 1 : Math.abs(o.volume - t.volume) / t.volume;
        if (deviation > maxVolumeDeviation) maxVolumeDeviation = deviation;
      }
      if (fields.length === 0) {
        matched++;
      } else {
        differing++;
        note({ time: t.time, theirs: t, ours: o, fields });
      }
      i++;
      j++;
    }
  }

  const status: ParityStatus = differing + missing + extra === 0 ? 'exact' : 'differs';
  return {
    status,
    window,
    matched,
    differing,
    missing,
    extra,
    first,
    fieldDiffers,
    maxVolumeDeviation,
  };
}
