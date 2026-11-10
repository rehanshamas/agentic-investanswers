// Live trades from Coinbase Exchange's public WebSocket feed (M1-05).
//
// Why Coinbase and not CoinAPI (Sham, 2026-11-10): `ws.coinapi.io` resets the
// TLS handshake from our machine, as `rest.coinapi.io` did in M1-04, and its
// free plan bills per message. Coinbase is free, keyless, and the same venue as
// the history backfill and the TradingView exports. CoinAPI can join as a
// second adapter; nothing outside this folder knows which one runs (CLAUDE.md
// rule 7).
//
// The feed, as measured on 2026-11-10:
//   subscribe {"type":"subscribe","product_ids":["BTC-USD"],"channels":["matches","heartbeat"]}
//   -> {"type":"subscriptions",...}            the subscription is live
//   -> {"type":"last_match",...}               the trade *before* we joined: not built,
//                                              but its trade_id is where counting starts
//   -> {"type":"match","trade_id":1118352629,"price":"73490.72","size":"0.00000013",
//       "product_id":"BTC-USD","time":"2026-11-10T18:42:29.504012Z",...}
//   -> {"type":"heartbeat","last_trade_id":1118352628,"product_id":"BTC-USD",...} every second
// `trade_id` is consecutive per product, so a jump, or a heartbeat naming a
// trade we never saw, means trades were missed: the connection is then closed,
// and the stream records the minutes as a gap rather than build them short.

import type { Instrument } from '@aia/shared-kernel';
import { parseScaled, price, rawPriceScale, rawVolumeScale, volume } from '@aia/shared-kernel';

import type { LiveConnection, LiveFeedOptions, LiveSink, LiveTradesPort } from '../../application/live-trades-port.js';
import type { LiveTrade } from '../../domain/live-minutes.js';
import { coinbaseProduct } from './coinbase-candles.js';

export const COINBASE_FEED_URL = 'wss://ws-feed.exchange.coinbase.com';

/** The part of a WebSocket this adapter uses; the built-in `WebSocket` fits it. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CoinbaseTradesOptions extends LiveFeedOptions {
  readonly url?: string;
  /** Injected for tests and replay; defaults to Node's built-in WebSocket. */
  readonly socket?: (url: string) => SocketLike;
  /** Injected for replay, so recorded messages carry their recorded time. */
  readonly now?: () => number;
}

export type CoinbaseMessage =
  | { readonly kind: 'subscribed' }
  | { readonly kind: 'trade'; readonly symbol: string; readonly trade: LiveTrade }
  | { readonly kind: 'heartbeat'; readonly symbol: string; readonly lastTradeId: number }
  | { readonly kind: 'joined'; readonly symbol: string; readonly lastTradeId: number }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'ignore' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one feed message into our terms. Throws if a field we rely on is
 * missing or cannot be held exactly at the instrument's raw scale: raw is
 * never rounded (CLAUDE.md rule 3).
 */
export function parseFeedMessage(text: string, byProduct: ReadonlyMap<string, Instrument>): CoinbaseMessage {
  const message: unknown = JSON.parse(text);
  if (!isRecord(message)) throw new Error(`Feed message is not an object: ${text.slice(0, 200)}`);
  const type = message['type'];
  if (type === 'subscriptions') return { kind: 'subscribed' };
  if (type === 'error') return { kind: 'error', message: `${String(message['message'])}: ${String(message['reason'])}` };
  if (type !== 'match' && type !== 'heartbeat' && type !== 'last_match') return { kind: 'ignore' };

  const instrument = byProduct.get(String(message['product_id']));
  if (instrument === undefined) return { kind: 'ignore' };
  if (type === 'heartbeat' || type === 'last_match') {
    const lastTradeId = message[type === 'heartbeat' ? 'last_trade_id' : 'trade_id'];
    if (typeof lastTradeId !== 'number') throw new Error(`${type} without a trade id: ${text.slice(0, 200)}`);
    return { kind: type === 'heartbeat' ? 'heartbeat' : 'joined', symbol: instrument.symbol, lastTradeId };
  }

  const { trade_id: tradeId, price: p, size, time } = message;
  if (typeof tradeId !== 'number' || !Number.isSafeInteger(tradeId)) throw new Error(`Match without a trade_id: ${text.slice(0, 200)}`);
  if (typeof p !== 'string' || typeof size !== 'string' || typeof time !== 'string') {
    throw new Error(`Match ${tradeId} lacks price, size or time`);
  }
  const timeMs = Date.parse(time);
  if (!Number.isFinite(timeMs)) throw new Error(`Match ${tradeId} has an unreadable time ${time}`);
  return {
    kind: 'trade',
    symbol: instrument.symbol,
    trade: {
      timeMs,
      seq: tradeId,
      price: price(parseScaled(p, rawPriceScale(instrument))),
      size: volume(parseScaled(size, rawVolumeScale(instrument))),
    },
  };
}

export class CoinbaseTrades implements LiveTradesPort {
  readonly name = 'coinbase';

  constructor(private readonly options: CoinbaseTradesOptions = {}) {}

  connect(instruments: readonly Instrument[], sink: LiveSink): LiveConnection {
    const byProduct = new Map(instruments.map((i) => [coinbaseProduct(i.symbol), i]));
    const lastTradeId = new Map<string, number>();
    const now = this.options.now ?? Date.now;
    const socket = (this.options.socket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(
      this.options.url ?? COINBASE_FEED_URL,
    );
    let ended = false;
    const end = (reason: string): void => {
      if (ended) return;
      ended = true;
      socket.close();
      sink.onClose(reason);
    };

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'subscribe', product_ids: [...byProduct.keys()], channels: ['matches', 'heartbeat'] }));
    };
    socket.onclose = (event) => end(`socket closed (${event.code ?? '?'}${event.reason ? `: ${event.reason}` : ''})`);
    socket.onerror = () => end('socket error');
    socket.onmessage = (event) => {
      if (ended) return;
      const text = String(event.data);
      this.options.record?.(text, now());
      let message: CoinbaseMessage;
      try {
        message = parseFeedMessage(text, byProduct);
      } catch (error) {
        end(`unreadable message: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      switch (message.kind) {
        case 'subscribed':
          sink.onOpen();
          return;
        case 'error':
          end(`feed error: ${message.message}`);
          return;
        case 'joined':
          lastTradeId.set(message.symbol, message.lastTradeId);
          return;
        case 'heartbeat': {
          const seen = lastTradeId.get(message.symbol);
          if (seen !== undefined && message.lastTradeId > seen) {
            end(`${message.symbol}: heartbeat names trade ${message.lastTradeId}, last seen ${seen}`);
            return;
          }
          sink.onAlive();
          return;
        }
        case 'trade': {
          const seen = lastTradeId.get(message.symbol);
          if (seen !== undefined && message.trade.seq > seen + 1) {
            end(`${message.symbol}: trades ${seen + 1} to ${message.trade.seq - 1} missing`);
            return;
          }
          if (seen === undefined || message.trade.seq > seen) lastTradeId.set(message.symbol, message.trade.seq);
          sink.onAlive();
          sink.onTrade(message.symbol, message.trade);
          return;
        }
        case 'ignore':
          return;
      }
    };
    return { close: () => end('closed by us') };
  }
}
