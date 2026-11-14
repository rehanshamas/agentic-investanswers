// Our timeframes as KLineChart periods, and bars as its KLineData (times in
// milliseconds; ours are UTC seconds).

import type { DisplayBar } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import { isTimeframe } from '@aia/shared-kernel';
import type { KLineData, Period } from 'klinecharts';

const PERIODS: Readonly<Record<Timeframe, Period>> = {
  '1m': { type: 'minute', span: 1 },
  '5m': { type: 'minute', span: 5 },
  '15m': { type: 'minute', span: 15 },
  '1h': { type: 'hour', span: 1 },
  '4h': { type: 'hour', span: 4 },
  '1D': { type: 'day', span: 1 },
  '1W': { type: 'week', span: 1 },
  '1M': { type: 'month', span: 1 },
};

export function periodOf(tf: Timeframe): Period {
  return { ...PERIODS[tf] };
}

/** The timeframe a period stands for, if it is one of ours. */
export function timeframeOf(period: Period): Timeframe | undefined {
  const found = Object.entries(PERIODS).find(([, p]) => p.type === period.type && p.span === period.span);
  return found !== undefined && isTimeframe(found[0]) ? found[0] : undefined;
}

export function toKLine(bar: DisplayBar): KLineData {
  return { timestamp: bar.time * 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
}
