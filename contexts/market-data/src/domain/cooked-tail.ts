// Settled cooked bars and the tail (M1-15). Pure.
//
// The cooked store holds every bar built from minutes before an instrument's
// watermark (`through`): settled days, written once by the compactor. Bars
// from the watermark on, the tail, are rolled up from raw 1-minute bars when
// they are read, with the same `rollUp`. A bar that contains the watermark is
// in the tail, so it is always built from all its minutes.

import type { BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe } from '@aia/shared-kernel';

/**
 * Where `timeframe`'s tail starts: the open of the bar containing `through`,
 * or `through` itself if no bar contains it (outside a market session).
 */
export function tailStart(instrument: Instrument, timeframe: Timeframe, through: BarTime, calendar?: MarketCalendar): BarTime {
  return alignToTimeframe(instrument, timeframe, through, calendar) ?? through;
}
