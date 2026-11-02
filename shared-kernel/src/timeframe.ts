// Timeframe: the period one bar covers. Never "interval" (docs/glossary.md).
//
// Note the case: `1m` is one minute, `1M` is one month. TypeScript unions are
// case-sensitive so this is safe in code; only file names needed a different
// scheme, which is why docs/bar-rules.md names export files `1m` and `1mo`.

/** Every timeframe the MVP serves, shortest first. */
export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W', '1M'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

/**
 * How a timeframe is built.
 * - `intraday`: a fixed number of minutes, anchored (crypto: 00:00 UTC; stocks: the session open).
 * - `daily`, `weekly`, `monthly`: calendar periods, which need a session calendar for stocks.
 */
export type TimeframeKind = 'intraday' | 'daily' | 'weekly' | 'monthly';

interface TimeframeMeta {
  readonly kind: TimeframeKind;
  /** Length in minutes; only meaningful for `intraday`. */
  readonly minutes: number | undefined;
}

const META: { readonly [T in Timeframe]: TimeframeMeta } = {
  '1m': { kind: 'intraday', minutes: 1 },
  '5m': { kind: 'intraday', minutes: 5 },
  '15m': { kind: 'intraday', minutes: 15 },
  '1h': { kind: 'intraday', minutes: 60 },
  '4h': { kind: 'intraday', minutes: 240 },
  '1D': { kind: 'daily', minutes: undefined },
  '1W': { kind: 'weekly', minutes: undefined },
  '1M': { kind: 'monthly', minutes: undefined },
};

export function isTimeframe(value: string): value is Timeframe {
  return Object.prototype.hasOwnProperty.call(META, value);
}

export function timeframeKind(tf: Timeframe): TimeframeKind {
  return META[tf].kind;
}

/** Length in minutes, or `undefined` for calendar timeframes (1D, 1W, 1M). */
export function timeframeMinutes(tf: Timeframe): number | undefined {
  return META[tf].minutes;
}

/** Length in seconds, or `undefined` for calendar timeframes. */
export function timeframeSeconds(tf: Timeframe): number | undefined {
  const minutes = META[tf].minutes;
  return minutes === undefined ? undefined : minutes * 60;
}

/** True for 1m/5m/15m/1h/4h. */
export function isIntraday(tf: Timeframe): boolean {
  return META[tf].kind === 'intraday';
}
