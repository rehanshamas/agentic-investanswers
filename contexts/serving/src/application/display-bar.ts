// A bar in display units, as the History API and the live gateway send it
// (the shape is the client contract's, @aia/client-contract).

import type { DisplayBar } from '@aia/client-contract';
import type { Bar, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';

/** Scaled whole numbers to decimals at the instrument's precision. */
export function displayBar(instrument: Instrument, bar: Bar): DisplayBar {
  const p = (value: number) => Number(formatScaled(value, instrument.priceScale));
  return {
    time: bar.time,
    open: p(bar.open),
    high: p(bar.high),
    low: p(bar.low),
    close: p(bar.close),
    volume: Number(formatScaled(bar.volume, instrument.volumeScale)),
  };
}
