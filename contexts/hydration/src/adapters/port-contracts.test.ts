// Port contract tests (CLAUDE.md rule 7): every registered adapter must behave
// the same through its port, so the feed plan can swap one for another. Each
// adapter gets a canned provider response below; a new entry in ADAPTERS with
// no case here fails the first test, so no adapter joins without passing.

import type { Instrument } from '@aia/shared-kernel';
import { barTimeFromUtcParts } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { HistoryProviderPort } from '../application/history-provider-port.js';
import type { LiveConnection, LiveSink, LiveTradesPort } from '../application/live-trades-port.js';
import { assertStorableRawDay } from '../domain/raw-day.js';
import { CoinbaseCandles } from './coinbase/coinbase-candles.js';
import type { SocketLike } from './coinbase/coinbase-trades.js';
import { CoinbaseTrades } from './coinbase/coinbase-trades.js';
import { MassiveAggregates } from './massive/massive-aggregates.js';
import { ADAPTERS } from './registry.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const NVDA: Instrument = {
  symbol: 'NVDA',
  kind: 'stock',
  venue: 'NASDAQ',
  timeZone: 'America/New_York',
  priceScale: 2,
  volumeScale: 0,
  rawPriceScale: 6,
  rawVolumeScale: 6,
};
const DAY = '2026-11-05';
const noSleep = (): Promise<void> => Promise.resolve();

interface HistoryCase {
  readonly instrument: Instrument;
  /** The adapter, answering with one bar at 15:00 UTC on DAY. */
  readonly working: () => HistoryProviderPort;
  /** The adapter, with the provider failing every request. */
  readonly failing: () => HistoryProviderPort;
}

const failingFetch = (() => Promise.resolve(new Response('down', { status: 500 }))) as typeof fetch;
const at1500 = barTimeFromUtcParts(2026, 11, 5, 15, 0);

const HISTORY: Record<string, HistoryCase> = {
  coinbase: {
    instrument: BTC,
    working: () =>
      new CoinbaseCandles({
        sleep: noSleep,
        fetch: ((url: string) => {
          // Answer the page that covers 15:00 with one candle, the rest empty.
          const start = Date.parse(new URL(url).searchParams.get('start') ?? '') / 1000;
          const end = Date.parse(new URL(url).searchParams.get('end') ?? '') / 1000;
          const rows = at1500 >= start && at1500 <= end ? [[at1500, 99.5, 101.25, 100, 101, 1.5]] : [];
          return Promise.resolve(Response.json(rows));
        }) as typeof fetch,
      }),
    failing: () => new CoinbaseCandles({ sleep: noSleep, fetch: failingFetch, maxAttempts: 2 }),
  },
  massive: {
    instrument: NVDA,
    working: () =>
      new MassiveAggregates({
        apiKey: 'test',
        sleep: noSleep,
        fetch: (() =>
          Promise.resolve(
            Response.json({
              ticker: 'NVDA',
              status: 'OK',
              resultsCount: 1,
              results: [{ t: at1500 * 1000, o: 100, h: 101.25, l: 99.5, c: 101, v: 1500, vw: 100, n: 3 }],
            }),
          )) as typeof fetch,
      }),
    failing: () => new MassiveAggregates({ apiKey: 'test', sleep: noSleep, fetch: failingFetch, maxAttempts: 2 }),
  },
};

describe('HistoryProviderPort contract', () => {
  it('has a case for every registered history adapter', () => {
    const registered = Object.entries(ADAPTERS).filter(([, e]) => e.history !== undefined).map(([name]) => name);
    expect(Object.keys(HISTORY).sort()).toEqual(registered.sort());
  });

  describe.each(Object.entries(HISTORY))('%s', (name, c) => {
    it('is named as registered, since raw keys use the name', () => {
      expect(c.working().name).toBe(name);
    });

    it('returns a day that may be stored raw as it is: in the day, ascending, whole minutes, coherent', async () => {
      const bars = await c.working().fetchDay(c.instrument, DAY);
      expect(bars.map((b) => b.time)).toEqual([at1500]);
      expect(() => assertStorableRawDay(DAY, bars)).not.toThrow();
    });

    it('fails the whole day when the provider fails, never returning part of it', async () => {
      await expect(c.failing().fetchDay(c.instrument, DAY)).rejects.toThrow();
    });
  });
});

interface LiveCase {
  readonly instrument: Instrument;
  /** The adapter and a script that opens, delivers one trade, then drops. */
  readonly session: () => { feed: LiveTradesPort; open: () => void; trade: () => void; drop: () => void };
}

class ScriptSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  send(): void {}
  close(): void {}
  emit(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const LIVE: Record<string, LiveCase> = {
  coinbase: {
    instrument: BTC,
    session: () => {
      const socket = new ScriptSocket();
      return {
        feed: new CoinbaseTrades({ socket: () => socket }),
        open: () => {
          socket.onopen?.({});
          socket.emit({ type: 'subscriptions', channels: [] });
        },
        trade: () =>
          socket.emit({
            type: 'match',
            trade_id: 1,
            product_id: 'BTC-USD',
            price: '101.00',
            size: '1.5',
            time: '2026-11-05T15:00:01.250Z',
          }),
        drop: () => socket.onclose?.({ code: 1006 }),
      };
    },
  },
};

function recorder(): { sink: LiveSink; events: string[]; trades: Array<{ symbol: string; bar: unknown }> } {
  const events: string[] = [];
  const trades: Array<{ symbol: string; bar: unknown }> = [];
  return {
    events,
    trades,
    sink: {
      onOpen: () => events.push('open'),
      onTrade: (symbol, trade) => {
        events.push('trade');
        trades.push({ symbol, bar: trade });
      },
      onAlive: () => undefined,
      onClose: () => events.push('close'),
    },
  };
}

describe('LiveTradesPort contract', () => {
  it('has a case for every registered live adapter', () => {
    const registered = Object.entries(ADAPTERS).filter(([, e]) => e.live !== undefined).map(([name]) => name);
    expect(Object.keys(LIVE).sort()).toEqual(registered.sort());
  });

  describe.each(Object.entries(LIVE))('%s', (name, c) => {
    it('is named as registered, since raw keys use the name', () => {
      expect(c.session().feed.name).toBe(name);
    });

    it('opens, then delivers trades in our symbol and units, and reports a drop once', () => {
      const s = c.session();
      const r = recorder();
      s.feed.connect([c.instrument], r.sink);
      s.open();
      s.trade();
      s.drop();
      s.drop();
      expect(r.events).toEqual(['open', 'trade', 'close']);
      expect(r.trades).toEqual([
        { symbol: c.instrument.symbol, bar: { timeMs: Date.parse('2026-11-05T15:00:01.250Z'), seq: 1, price: 10100, size: 150000000 } },
      ]);
    });

    it('is silent after the caller closes it', () => {
      const s = c.session();
      const r = recorder();
      const connection: LiveConnection = s.feed.connect([c.instrument], r.sink);
      s.open();
      connection.close();
      const before = r.events.length;
      s.trade();
      s.drop();
      expect(r.events.slice(before)).toEqual([]);
    });
  });
});
