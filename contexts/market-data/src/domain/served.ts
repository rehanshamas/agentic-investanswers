// Which instrument and timeframe pairs have bars to serve (M2-03). Pure.
//
// Until M1-08: only crypto, and only 1m to 4h. Calendar timeframes (1D, 1W,
// 1M) are not cooked yet, and stocks are not cooked at all; their raw 1m is
// at the provider's precision, not the instrument's, so it cannot be served
// as it is. M1-08 widens this.

import type { Instrument, Timeframe } from '@aia/shared-kernel';
import { isIntraday } from '@aia/shared-kernel';

/** `undefined` when served, otherwise why not, in words a client can show. */
export function whyNotServed(instrument: Instrument, timeframe: Timeframe): string | undefined {
  if (instrument.kind === 'stock') return `${instrument.symbol} bars are not served yet (stocks arrive with M1-08)`;
  if (!isIntraday(timeframe)) return `${timeframe} bars are not served yet (1D, 1W and 1M arrive with M1-08)`;
  return undefined;
}
