// KLineChart's data loader over our bar series: the one place the chart
// library meets our data. KLineChart asks for bars when its symbol (our
// instrument) or period (our timeframe) is set, and subscribes for live bars.
//
// - One series at a time: a new instrument or timeframe stops the old one
//   (it unsubscribes on the same WebSocket) and starts the new one.
// - A reload of the series (resync) resets the chart, which asks again and
//   gets the series' bars without another request.
// - KLineChart (10.1.0) drops a live bar older than its newest one, but the
//   protocol revises the previous bar every minute. So a revision patches the
//   bar in the chart's own list (getDataList returns it) and re-sends the
//   newest bar, which makes the chart recompute its range and redraw.
// - Older history (scroll-back) is M2-06: the chart is told there is no more.

import type { Timeframe } from '@aia/shared-kernel';
import type { DataLoader, DataLoaderGetBarsParams, DataLoaderSubscribeBarParams, KLineData } from 'klinecharts';

import type { BarSeries, SeriesEvent, SeriesStatus } from '../data/bar-series.js';
import { timeframeOf, toKLine } from './periods.js';

/** What the feed needs from the chart. */
export interface ChartHandle {
  getDataList(): KLineData[];
  resetData(): void;
}

export interface ChartFeedDeps {
  readonly chart: () => ChartHandle | undefined;
  readonly newSeries: (
    instrument: string,
    tf: Timeframe,
    handlers: { onEvent: (event: SeriesEvent) => void; onStatus: (status: SeriesStatus) => void },
  ) => BarSeries;
  readonly onStatus?: (status: SeriesStatus) => void;
}

export class ChartFeed implements DataLoader {
  private series: BarSeries | undefined;
  private key: string | undefined;
  /** KLineChart's callback for the first load, until the series has bars. */
  private waiting: { readonly key: string; readonly callback: DataLoaderGetBarsParams['callback'] } | undefined;
  private push: ((bar: KLineData) => void) | undefined;

  constructor(private readonly deps: ChartFeedDeps) {}

  getBars = ({ type, symbol, period, callback }: DataLoaderGetBarsParams): void => {
    if (type !== 'init') {
      callback([], false);
      return;
    }
    const tf = timeframeOf(period);
    if (tf === undefined) {
      callback([], false);
      return;
    }
    const key = `${symbol.ticker}|${tf}`;
    if (key === this.key && this.series?.loaded === true) {
      callback(this.series.current.map(toKLine), false);
      return;
    }
    if (key !== this.key) {
      this.series?.stop();
      this.key = key;
      this.series = this.deps.newSeries(symbol.ticker, tf, {
        onEvent: (event) => this.receive(key, event),
        onStatus: (status) => {
          if (key === this.key) this.deps.onStatus?.(status);
        },
      });
      this.series.start();
    }
    this.waiting = { key, callback };
  };

  subscribeBar = ({ callback }: DataLoaderSubscribeBarParams): void => {
    this.push = callback;
  };

  unsubscribeBar = (): void => {
    this.push = undefined;
  };

  dispose(): void {
    this.series?.stop();
    this.series = undefined;
    this.key = undefined;
    this.waiting = undefined;
    this.push = undefined;
  }

  private receive(key: string, event: SeriesEvent): void {
    if (key !== this.key) return;
    if (event.type === 'reset') {
      const waiting = this.waiting;
      if (waiting?.key === key) {
        this.waiting = undefined;
        waiting.callback(event.bars.map(toKLine), false);
      } else {
        this.deps.chart()?.resetData();
      }
      return;
    }
    const push = this.push;
    if (push === undefined) return;
    if (event.newest) {
      push(toKLine(event.bar));
      return;
    }
    const list = this.deps.chart()?.getDataList() ?? [];
    const timestamp = event.bar.time * 1000;
    const target = findByTimestamp(list, timestamp);
    if (target === undefined) return;
    Object.assign(target, toKLine(event.bar));
    const newest = list[list.length - 1];
    if (newest !== undefined) push({ ...newest });
  }
}

function findByTimestamp(list: readonly KLineData[], timestamp: number): KLineData | undefined {
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i] as KLineData;
    if (item.timestamp === timestamp) return item;
    if (item.timestamp < timestamp) return undefined;
  }
  return undefined;
}
