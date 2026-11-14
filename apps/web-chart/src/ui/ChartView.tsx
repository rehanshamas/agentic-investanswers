// The KLineChart canvas. It only binds: bars come from ChartFeed (one
// BarSeries at a time over the shared LiveConnection). KLineChart's built-in
// indicators stay off (none is ever created): indicators are drawn from the
// server's output (M3), as overlays on this chart.

import type { InstrumentInfo } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import type { Chart } from 'klinecharts';
import { dispose, init } from 'klinecharts';
import { useEffect, useRef } from 'react';

import { ChartFeed } from '../chart/chart-feed.js';
import { periodOf } from '../chart/periods.js';
import { BarSeries } from '../data/bar-series.js';
import type { SeriesStatus } from '../data/bar-series.js';
import type { LiveConnection } from '../data/live-connection.js';
import type { PlatformClient } from '../data/platform-client.js';

declare global {
  interface Window {
    /** The chart, for the end-to-end tests to read its bars (read-only use). */
    __aiaChart?: Chart;
  }
}

export interface ChartViewProps {
  readonly client: PlatformClient;
  readonly live: LiveConnection;
  readonly instrument: InstrumentInfo;
  readonly timeframe: Timeframe;
  readonly onStatus: (status: SeriesStatus) => void;
}

export function ChartView({ client, live, instrument, timeframe, onStatus }: ChartViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const status = useRef(onStatus);
  status.current = onStatus;

  useEffect(() => {
    const element = container.current;
    if (element === null) return undefined;
    const created = init(element);
    if (created === null) return undefined;
    chart.current = created;
    const feed = new ChartFeed({
      chart: () => chart.current ?? undefined,
      newSeries: (symbol, tf, handlers) => new BarSeries(symbol, tf, { live, history: (s, t) => client.history(s, t), ...handlers }),
      onStatus: (s) => status.current(s),
    });
    created.setDataLoader(feed);
    window.__aiaChart = created;
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(element);
    return () => {
      resize.disconnect();
      feed.dispose();
      dispose(element);
      chart.current = null;
      if (window.__aiaChart === created) delete window.__aiaChart;
    };
  }, [client, live]);

  const { symbol, pricePrecision, volumePrecision } = instrument;
  useEffect(() => {
    chart.current?.setSymbol({ ticker: symbol, pricePrecision, volumePrecision });
  }, [client, live, symbol, pricePrecision, volumePrecision]);

  useEffect(() => {
    chart.current?.setPeriod(periodOf(timeframe));
  }, [client, live, timeframe]);

  return <div ref={container} className="chart" data-testid="chart" />;
}
