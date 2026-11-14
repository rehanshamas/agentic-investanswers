import type { DisplayBar } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';
import type { DataLoaderGetBarsParams, KLineData, Period } from 'klinecharts';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BarSeries, SeriesEvent, SeriesStatus } from '../data/bar-series.js';
import type { ChartHandle } from './chart-feed.js';
import { ChartFeed } from './chart-feed.js';
import { toKLine } from './periods.js';

const bar = (time: number, close: number): DisplayBar => ({ time, open: close, high: close, low: close, close, volume: 1 });

/** A series the test drives by hand. */
class FakeSeries {
  started = false;
  stopped = false;
  loaded = false;
  current: DisplayBar[] = [];
  constructor(
    readonly instrument: string,
    readonly timeframe: Timeframe,
    readonly handlers: { onEvent: (e: SeriesEvent) => void; onStatus: (s: SeriesStatus) => void },
  ) {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  load(bars: DisplayBar[]) {
    this.current = bars;
    this.loaded = true;
    this.handlers.onEvent({ type: 'reset', bars });
  }
}

/** KLineChart's side, as 10.1.0 behaves: it keeps the list it is given and applies pushed bars only at or after its newest. */
class FakeChart implements ChartHandle {
  list: KLineData[] = [];
  resets = 0;
  getDataList() {
    return this.list;
  }
  resetData() {
    this.resets++;
  }
  apply(data: KLineData) {
    const last = this.list[this.list.length - 1];
    if (last === undefined || data.timestamp > last.timestamp) this.list.push(data);
    else if (data.timestamp === last.timestamp) this.list[this.list.length - 1] = data;
  }
}

const MINUTE: Period = { type: 'minute', span: 1 };
const HOUR: Period = { type: 'hour', span: 1 };

let chart: FakeChart;
let series: FakeSeries[];
let statuses: SeriesStatus[];
let feed: ChartFeed;

beforeEach(() => {
  chart = new FakeChart();
  series = [];
  statuses = [];
  feed = new ChartFeed({
    chart: () => chart,
    newSeries: (instrument, tf, handlers) => {
      const s = new FakeSeries(instrument, tf, handlers);
      series.push(s);
      return s as unknown as BarSeries;
    },
    onStatus: (s) => statuses.push(s),
  });
});

/** KLineChart's init request, recording what the callback gets. */
function init(ticker: string, period: Period): KLineData[][] {
  const calls: KLineData[][] = [];
  const params: DataLoaderGetBarsParams = {
    type: 'init',
    timestamp: null,
    symbol: { ticker, pricePrecision: 2, volumePrecision: 8 },
    period,
    callback: (data) => {
      calls.push(data);
      chart.list = data;
    },
  };
  void feed.getBars(params);
  feed.subscribeBar({ symbol: params.symbol, period, callback: (d) => chart.apply(d) });
  return calls;
}

const latest = () => series[series.length - 1] as FakeSeries;

describe('ChartFeed', () => {
  it('starts a series for the chart symbol and period and hands its first page to the chart', () => {
    const calls = init('BTCUSD', MINUTE);
    expect(latest()).toMatchObject({ instrument: 'BTCUSD', timeframe: '1m', started: true });
    expect(calls).toEqual([]);
    latest().load([bar(60, 1), bar(120, 2)]);
    expect(calls).toEqual([[toKLine(bar(60, 1)), toKLine(bar(120, 2))]]);
  });

  it('pushes the newest bar live', () => {
    init('BTCUSD', MINUTE);
    latest().load([bar(60, 1)]);
    latest().handlers.onEvent({ type: 'bar', bar: bar(60, 2), index: 0, newest: true });
    latest().handlers.onEvent({ type: 'bar', bar: bar(120, 3), index: 1, newest: true });
    expect(chart.list.map((d) => [d.timestamp, d.close])).toEqual([
      [60_000, 2],
      [120_000, 3],
    ]);
  });

  it('shows a revision of an older bar, which the chart alone would drop, and redraws through the newest bar', () => {
    init('BTCUSD', MINUTE);
    latest().load([bar(60, 1), bar(120, 2)]);
    latest().handlers.onEvent({ type: 'bar', bar: bar(60, 9), index: 0, newest: false });
    expect(chart.list.map((d) => d.close)).toEqual([9, 2]);
    expect(chart.list).toHaveLength(2);
  });

  it('on a reload (resync) resets the chart, which gets the bars again without a new series', () => {
    init('BTCUSD', MINUTE);
    latest().load([bar(60, 1)]);
    latest().load([bar(60, 1), bar(120, 2)]);
    expect(chart.resets).toBe(1);
    const calls = init('BTCUSD', MINUTE);
    expect(calls).toEqual([[toKLine(bar(60, 1)), toKLine(bar(120, 2))]]);
    expect(series).toHaveLength(1);
  });

  it('switching instrument or timeframe stops the old series, and ignores its late events', () => {
    init('BTCUSD', MINUTE);
    const old = latest();
    const calls = init('BTCUSD', HOUR);
    expect(old.stopped).toBe(true);
    expect(latest()).toMatchObject({ instrument: 'BTCUSD', timeframe: '1h' });
    old.load([bar(60, 1)]);
    old.handlers.onStatus({ state: 'ready' });
    expect(calls).toEqual([]);
    expect(statuses).toEqual([]);
    latest().load([bar(3600, 5)]);
    expect(calls).toEqual([[toKLine(bar(3600, 5))]]);
  });

  it('passes the current series status on', () => {
    init('BTCUSD', MINUTE);
    latest().handlers.onStatus({ state: 'error', code: 'forbidden', message: 'no' });
    expect(statuses).toEqual([{ state: 'error', code: 'forbidden', message: 'no' }]);
  });

  it('answers older history requests with nothing for now (scroll-back is M2-06)', () => {
    const got: [KLineData[], unknown][] = [];
    void feed.getBars({ type: 'backward', timestamp: 60_000, symbol: { ticker: 'BTCUSD', pricePrecision: 2, volumePrecision: 8 }, period: MINUTE, callback: (d, more) => got.push([d, more]) });
    expect(got).toEqual([[[], false]]);
  });

  it('stops its series on dispose', () => {
    init('BTCUSD', MINUTE);
    feed.dispose();
    expect(latest().stopped).toBe(true);
  });
});
