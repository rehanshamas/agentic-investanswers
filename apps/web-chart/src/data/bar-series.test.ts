import type { DisplayBar, HistoryResponse, LiveWireUpdate } from '@aia/client-contract';
import { beforeEach, describe, expect, it } from 'vitest';

import type { SeriesEvent, SeriesStatus } from './bar-series.js';
import { BarSeries } from './bar-series.js';
import type { LiveListener } from './live-connection.js';
import { ApiError } from './platform-client.js';

const bar = (time: number, close: number): DisplayBar => ({ time, open: close, high: close, low: close, close, volume: 1 });
const wire = (time: number, close: number): LiveWireUpdate => ({ instrument: 'BTCUSD', timeframe: '1m', forming: true, bar: bar(time, close) });
const page = (...bars: DisplayBar[]): HistoryResponse => ({ instrument: 'BTCUSD', timeframe: '1m', bars, next: null });

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let listener: LiveListener | undefined;
let unsubscribed: number;
let requests: ReturnType<typeof deferred<HistoryResponse>>[];
let events: SeriesEvent[];
let statuses: SeriesStatus[];
let series: BarSeries;

beforeEach(() => {
  listener = undefined;
  unsubscribed = 0;
  requests = [];
  events = [];
  statuses = [];
  series = new BarSeries('BTCUSD', '1m', {
    live: {
      subscribe: (_instrument, _tf, l) => {
        listener = l;
        return () => unsubscribed++;
      },
    },
    history: () => {
      const request = deferred<HistoryResponse>();
      requests.push(request);
      return request.promise;
    },
    onEvent: (e) => events.push(structuredClone(e)),
    onStatus: (s) => statuses.push(s),
  });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const live = () => listener as LiveListener;

describe('BarSeries', () => {
  it('subscribes before it loads the newest page, then shows the page', async () => {
    series.start();
    expect(listener).toBeDefined();
    expect(requests).toHaveLength(1);
    expect(series.loaded).toBe(false);
    requests[0]?.resolve(page(bar(60, 1), bar(120, 2)));
    await flush();
    expect(events).toEqual([{ type: 'reset', bars: [bar(60, 1), bar(120, 2)] }]);
    expect(statuses).toEqual([{ state: 'loading' }, { state: 'ready' }]);
    expect(series.loaded).toBe(true);
  });

  it('holds updates that arrive before the page and applies them on top of it', async () => {
    series.start();
    live().updates([wire(120, 5), wire(180, 6)]);
    requests[0]?.resolve(page(bar(60, 1), bar(120, 2)));
    await flush();
    expect(events).toEqual([{ type: 'reset', bars: [bar(60, 1), bar(120, 5), bar(180, 6)] }]);
  });

  it('appends a newer bar, replaces the newest, and revises an older one in place', async () => {
    series.start();
    requests[0]?.resolve(page(bar(60, 1), bar(120, 2)));
    await flush();
    events.length = 0;
    live().updates([wire(120, 3), wire(180, 4), wire(120, 5)]);
    expect(events).toEqual([
      { type: 'bar', bar: bar(120, 3), index: 1, newest: true },
      { type: 'bar', bar: bar(180, 4), index: 2, newest: true },
      { type: 'bar', bar: bar(120, 5), index: 1, newest: false },
    ]);
    expect(series.current).toEqual([bar(60, 1), bar(120, 5), bar(180, 4)]);
  });

  it('ignores a bar older than everything loaded, and inserts one missing inside the range', async () => {
    series.start();
    requests[0]?.resolve(page(bar(60, 1), bar(180, 3)));
    await flush();
    events.length = 0;
    live().updates([wire(0, 9)]);
    expect(events).toEqual([]);
    live().updates([wire(120, 2)]);
    expect(events).toEqual([{ type: 'reset', bars: [bar(60, 1), bar(120, 2), bar(180, 3)] }]);
  });

  it('reloads the newest page on resync, holding updates meanwhile, and drops the page a newer load replaced', async () => {
    series.start();
    requests[0]?.resolve(page(bar(60, 1)));
    await flush();
    events.length = 0;
    live().resync();
    live().resync();
    live().updates([wire(120, 7)]);
    expect(requests).toHaveLength(3);
    requests[2]?.resolve(page(bar(60, 1), bar(120, 2)));
    await flush();
    requests[1]?.resolve(page(bar(60, 0)));
    await flush();
    expect(events).toEqual([{ type: 'reset', bars: [bar(60, 1), bar(120, 7)] }]);
  });

  it('reports a refused page with the server message and upgrade link', async () => {
    series.start();
    requests[0]?.reject(new ApiError(403, 'forbidden', 'your plan does not include ETHUSD 1m', 'https://example.com/up'));
    await flush();
    expect(statuses.at(-1)).toEqual({ state: 'error', code: 'forbidden', message: 'your plan does not include ETHUSD 1m', upgradeUrl: 'https://example.com/up' });
  });

  it('reports a network failure, and an error on the live subscription', async () => {
    series.start();
    requests[0]?.reject(new TypeError('fetch failed'));
    await flush();
    expect(statuses.at(-1)).toEqual({ state: 'error', code: 'network', message: 'could not reach the server; try again' });
    live().error('too_many_subscriptions', 'at most 20');
    expect(statuses.at(-1)).toEqual({ state: 'error', code: 'too_many_subscriptions', message: 'at most 20' });
  });

  it('stops: unsubscribes, and ignores a page or updates that arrive later', async () => {
    series.start();
    series.stop();
    expect(unsubscribed).toBe(1);
    requests[0]?.resolve(page(bar(60, 1)));
    live().updates([wire(60, 2)]);
    await flush();
    expect(events).toEqual([]);
    expect(statuses).toEqual([{ state: 'loading' }]);
  });
});
