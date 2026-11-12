// Live bar updates (M2-04): what the hydration process announces to the
// platform process, which pushes them to charts. Pure.
//
// Two kinds of update, both replacing any earlier value of the same bar:
// - stored (`forming: false`): the BarClosed events of a minute that has been
//   stored, cooked and applied to the recent-bars cache. A 5m to 4h bar here
//   may still be extended by later minutes.
// - forming (`forming: true`): built from minutes not yet stored, so charts
//   tick with trades. Never written anywhere; a later stored update replaces
//   it.
//
// Our types only (CLAUDE.md rule 7): instrument symbol, timeframe, `Bar`.

import type { Bar, Timeframe } from '@aia/shared-kernel';

import type { BarClosed } from './bar-closed.js';

export interface LiveBarUpdate {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bar: Bar;
  /** Includes a minute not yet stored. */
  readonly forming: boolean;
}

/**
 * One announcement. `seq` counts up by one per announcement from the same
 * `publisher` (one per hydration process run), so a listener can tell when it
 * missed one. `resync` says listeners must reload from the History API: the
 * publisher knows charts may now differ from the store.
 */
export interface LiveBatch {
  readonly publisher: string;
  readonly seq: number;
  readonly updates: readonly LiveBarUpdate[];
  readonly resync?: boolean;
}

export function storedUpdates(events: readonly BarClosed[]): LiveBarUpdate[] {
  return events.map(({ symbol, timeframe, bar }) => ({ symbol, timeframe, bar, forming: false }));
}
