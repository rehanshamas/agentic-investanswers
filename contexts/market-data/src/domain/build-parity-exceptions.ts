// Bars where TradingView's own exports disagree with each other, approved by
// Sham one by one. Pure data.
//
// Build parity compares TradingView's finer export, rolled up by our code,
// with its coarser export. Where TradingView's two files contradict each
// other, no code can match both, so the bar is listed here with the evidence.
// An exception never makes a file EXACT: the report shows EXCEPTION, and it
// applies only while that bar differs on exactly the listed fields. Anything
// else still fails. Add entries only with Sham's approval, never to get green.

import type { BarTime, Timeframe } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import type { BarField } from './parity.js';

export interface BuildParityException {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly time: BarTime;
  readonly fields: readonly BarField[];
  readonly reason: string;
  readonly approved: string;
}

export const BUILD_PARITY_EXCEPTIONS: readonly BuildParityException[] = [
  {
    symbol: 'BTCUSD',
    timeframe: '1D',
    time: barTime(1_766_880_000), // 2025-12-28
    fields: ['volume'],
    reason:
      "btcusd_1d.csv says 1841.84641775; the 24 bars of btcusd_1h.csv for that day sum to " +
      '1859.62245916 (17.78 BTC, about 1%, more). Prices agree. TradingView\'s daily and ' +
      'hourly records of the day disagree with each other.',
    approved: 'Sham, 2026-11-09 (M1-14)',
  },
  {
    symbol: 'ETHUSD',
    timeframe: '1M',
    time: barTime(1_583_020_800), // 2020-03
    fields: ['volume'],
    reason:
      'ethusd_1mo.csv says 10627439.41330001; the daily bars of ethusd_1d.csv for March 2020 ' +
      "sum to 10627439.41330000. One unit at the 8th decimal: a rounding leftover in " +
      "TradingView's own floating-point sum.",
    approved: 'Sham, 2026-11-09 (M1-14)',
  },
];

/** The exceptions for one instrument and timeframe. */
export function buildParityExceptions(
  symbol: string,
  timeframe: Timeframe,
  list: readonly BuildParityException[] = BUILD_PARITY_EXCEPTIONS,
): BuildParityException[] {
  return list.filter((e) => e.symbol === symbol && e.timeframe === timeframe);
}
