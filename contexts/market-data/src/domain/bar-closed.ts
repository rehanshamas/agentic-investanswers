// BarClosed: a stored bar now has this value (M2-02). Pure.
//
// Sent when a 1-minute bar closes, and for each higher-timeframe bar that
// minute rebuilt. The 1m bar is final; a 5m, 15m, 1h or 4h bar it extended may
// still be forming, and the next minute sends it again with its new value. So
// a consumer replaces the bar with the same time rather than appending: the
// recent-bars cache does, and so will M2-04's live gateway.
//
// Our types only (CLAUDE.md rule 7): instrument symbol, timeframe, `Bar`.

import type { Bar, Timeframe } from '@aia/shared-kernel';

export interface BarClosed {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly bar: Bar;
}

/**
 * The events for one closed minute: the minute itself, then each rebuilt bar,
 * shortest timeframe first. `rebuilt` is what `CookIntraday.applyNewMinutesToAll`
 * returns for it.
 */
export function barClosedEvents(
  symbol: string,
  minute: Bar,
  rebuilt: ReadonlyMap<Timeframe, readonly Bar[]>,
): BarClosed[] {
  const events: BarClosed[] = [{ symbol, timeframe: '1m', bar: minute }];
  for (const [timeframe, bars] of rebuilt) {
    for (const bar of bars) events.push({ symbol, timeframe, bar });
  }
  return events;
}
