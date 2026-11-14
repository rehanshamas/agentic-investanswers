// A bar in display units, as the History API and the live gateway send it.
// Pure.

/** One bar in display units: prices and volume as decimal numbers, time in UTC seconds. */
export interface DisplayBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}
