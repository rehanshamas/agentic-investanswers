// A bar in display units, as the History API and the live gateway send it.
// Pure.

import type { Bar, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';

/** One bar in display units: prices and volume as decimal numbers, time in UTC seconds. */
export interface DisplayBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

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
