// The data layer in this process (M1-16): market-data's reading pieces
// composed behind DataAccess. The stores, cache and bus are passed in, so the
// same composition serves S3 and Redis (openLocalDataLayer) and memory
// (memoryDataLayer).

import type {
  CookedBarStorePort,
  CookedWatermarkPort,
  LiveBarsBusPort,
  LiveBarsListener,
  OneMinuteBarSourcePort,
  RecentBarsCachePort,
} from '@aia/market-data';
import { CookedReader, RecentBars, whyNotServed } from '@aia/market-data';
import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';

import type { BarsPage, DataAccess, PageQuery } from './data-access.js';

export interface InProcessDataLayerDeps {
  readonly instruments: readonly Instrument[];
  /** Where each instrument's history starts. */
  readonly earliest: (symbol: string) => BarTime;
  readonly minutes: OneMinuteBarSourcePort;
  readonly cooked: Pick<CookedBarStorePort, 'getRange'>;
  /** Without watermarks, cooked bars are read from the store alone. */
  readonly watermarks?: Pick<CookedWatermarkPort, 'getWatermark'>;
  readonly cache: RecentBarsCachePort;
  readonly bus: Pick<LiveBarsBusPort, 'subscribe' | 'close'>;
  readonly calendar?: MarketCalendar;
  /** Epoch milliseconds. */
  readonly nowMs: () => number;
  /** Anything else to close with the layer (for example the cache's connection). */
  readonly onClose?: () => Promise<void>;
}

const NO_WATERMARKS: Pick<CookedWatermarkPort, 'getWatermark'> = { getWatermark: () => Promise.resolve(undefined) };

export class InProcessDataLayer implements DataAccess {
  readonly instruments: readonly Instrument[];
  private readonly reader: CookedReader;
  private readonly recent: RecentBars;

  constructor(private readonly deps: InProcessDataLayerDeps) {
    this.instruments = deps.instruments;
    this.reader = new CookedReader({
      store: deps.cooked,
      watermarks: deps.watermarks ?? NO_WATERMARKS,
      minutes: deps.minutes,
      instruments: deps.instruments,
      nowMs: deps.nowMs,
      ...(deps.calendar === undefined ? {} : { calendar: deps.calendar }),
    });
    this.recent = new RecentBars({ cache: deps.cache, store: this.reader, minutes: deps.minutes });
  }

  whyNotServed(instrument: Instrument, timeframe: Timeframe): string | undefined {
    return whyNotServed(instrument, timeframe);
  }

  page(instrument: Instrument, timeframe: Timeframe, query: PageQuery): Promise<BarsPage> {
    return this.recent.page(instrument, timeframe, { ...query, earliest: this.deps.earliest(instrument.symbol) });
  }

  bars(instrument: Instrument, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    return timeframe === '1m'
      ? this.deps.minutes.read(instrument.symbol, from, until)
      : this.reader.getRange(instrument.symbol, timeframe, from, until);
  }

  subscribe(listener: LiveBarsListener): Promise<void> {
    return this.deps.bus.subscribe(listener);
  }

  async close(): Promise<void> {
    await this.deps.bus.close();
    await this.deps.onClose?.();
  }
}
