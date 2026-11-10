import type { Instrument } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { LiveSink } from '../../application/live-trades-port.js';
import type { LiveTrade } from '../../domain/live-minutes.js';
import type { SocketLike } from './coinbase-trades.js';
import { CoinbaseTrades } from './coinbase-trades.js';

const BTC: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'COINBASE', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };

class FakeSocket implements SocketLike {
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  emit(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function connect() {
  const socket = new FakeSocket();
  const recorded: string[] = [];
  const events: string[] = [];
  const trades: LiveTrade[] = [];
  const sink: LiveSink = {
    onOpen: () => events.push('open'),
    onTrade: (symbol, trade) => {
      events.push(`trade ${symbol}`);
      trades.push(trade);
    },
    onAlive: () => events.push('alive'),
    onClose: (reason) => events.push(`close: ${reason}`),
  };
  const connection = new CoinbaseTrades({ socket: () => socket, record: (m) => recorded.push(m), now: () => 0 }).connect(
    [BTC],
    sink,
  );
  socket.onopen?.({});
  return { socket, recorded, events, trades, connection };
}

const match = (id: number, extra: object = {}) => ({
  type: 'match',
  trade_id: id,
  product_id: 'BTC-USD',
  price: '73490.72',
  size: '0.00000013',
  time: '2026-11-10T18:42:29.504012Z',
  ...extra,
});

describe('CoinbaseTrades', () => {
  it('subscribes to matches and heartbeats for our symbols, by Coinbase product', () => {
    const { socket } = connect();
    expect(JSON.parse(socket.sent[0] ?? '')).toEqual({
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['matches', 'heartbeat'],
    });
  });

  it('opens on the subscription ack, and turns matches into trades in our units and symbols', () => {
    const { socket, events, trades, recorded } = connect();
    socket.emit({ type: 'subscriptions', channels: [] });
    socket.emit({ type: 'last_match', trade_id: 9, product_id: 'BTC-USD', price: '1.00', size: '1', time: '2026-11-10T18:42:00Z' });
    socket.emit(match(10));
    expect(events).toEqual(['open', 'alive', 'trade BTCUSD']);
    expect(trades).toEqual([{ timeMs: Date.parse('2026-11-10T18:42:29.504Z'), seq: 10, price: 7349072, size: 13 }]);
    expect(recorded).toHaveLength(3);
  });

  it('closes when a trade id is skipped, since trades were missed', () => {
    const { socket, events } = connect();
    socket.emit({ type: 'last_match', trade_id: 9, product_id: 'BTC-USD', price: '1.00', size: '1', time: '2026-11-10T18:42:00Z' });
    socket.emit(match(12));
    expect(events.at(-1)).toBe('close: BTCUSD: trades 10 to 11 missing');
    expect(socket.closed).toBe(true);
  });

  it('closes when a heartbeat names a trade it never delivered', () => {
    const { socket, events } = connect();
    socket.emit(match(10));
    socket.emit({ type: 'heartbeat', product_id: 'BTC-USD', last_trade_id: 11 });
    expect(events.at(-1)).toBe('close: BTCUSD: heartbeat names trade 11, last seen 10');
  });

  it('closes rather than round a price it cannot hold exactly', () => {
    const { socket, events } = connect();
    socket.emit(match(10, { price: '73490.725' }));
    expect(events.at(-1)).toMatch(/^close: unreadable message: .*more precision/);
  });

  it('reports a socket close once, and nothing after', () => {
    const { socket, events } = connect();
    socket.onclose?.({ code: 1006 });
    socket.emit(match(10));
    socket.onerror?.({});
    expect(events).toEqual(['close: socket closed (1006)']);
  });

  it('ignores products it was not asked for and message types it does not use', () => {
    const { socket, events } = connect();
    socket.emit(match(10, { product_id: 'SOL-USD' }));
    socket.emit({ type: 'ticker', product_id: 'BTC-USD' });
    expect(events).toEqual([]);
  });
});
