// The live gateway's wire protocol (M2-04): JSON text messages over one
// WebSocket per browser, carrying all its subscriptions. The gateway that
// speaks it is @aia/serving's (LiveGateway). Pure.
//
// Browser to server:
//   { "op": "subscribe",   "instrument": "BTCUSD", "tf": "5m" }
//   { "op": "unsubscribe", "instrument": "BTCUSD", "tf": "5m" }
//
// Server to browser:
//   { "type": "subscribed",   "instrument": "BTCUSD", "timeframe": "5m" }
//   { "type": "unsubscribed", "instrument": "BTCUSD", "timeframe": "5m" }
//   { "type": "bars", "updates": [{ "instrument", "timeframe", "forming", "bar": { time, open, high, low, close, volume } }] }
//   { "type": "resync" }
//   { "type": "error", "code", "message", "instrument"?, "timeframe"? }
//
// Bars are in display units, as GET /bars sends them. Each update replaces
// the bar with the same time; `forming: true` means it includes a minute not
// yet stored. Within a message, a bar appears once, with its newest value.
// For each instrument and timeframe, updates to a bar arrive in the order they
// were made, and the newest bar's time never goes back, except that a bar
// still open may be revised after a newer one appeared: the previous minute
// within the 2 s after it ends, and the stored value of a minute replacing its
// forming one.
//
// The client contract: subscribe, then load the newest page from GET /bars,
// then apply updates by bar time. An update arriving before the page is
// harmless. On `resync`, load the newest page again.

import type { Timeframe } from '@aia/shared-kernel';
import { isTimeframe } from '@aia/shared-kernel';

import type { DisplayBar } from './display-bar.js';

export type LiveErrorCode =
  | 'bad_parameter'
  | 'unknown_instrument'
  | 'timeframe_not_served'
  | 'forbidden'
  | 'too_many_subscriptions';

export interface LiveClientMessage {
  readonly op: 'subscribe' | 'unsubscribe';
  readonly instrument: string;
  readonly tf: Timeframe;
}

export interface LiveWireUpdate {
  readonly instrument: string;
  readonly timeframe: Timeframe;
  readonly forming: boolean;
  readonly bar: DisplayBar;
}

export type LiveServerMessage =
  | { readonly type: 'subscribed' | 'unsubscribed'; readonly instrument: string; readonly timeframe: Timeframe }
  | { readonly type: 'bars'; readonly updates: readonly LiveWireUpdate[] }
  | { readonly type: 'resync' }
  | {
      readonly type: 'error';
      readonly code: LiveErrorCode;
      readonly message: string;
      readonly instrument?: string;
      readonly timeframe?: string;
    };

/** Longest client message accepted, in characters. */
export const LIVE_MAX_CLIENT_MESSAGE = 256;

type Parsed =
  | { readonly ok: true; readonly message: LiveClientMessage }
  | { readonly ok: false; readonly message: string };

const FIELDS = new Set(['op', 'instrument', 'tf']);

export function parseClientMessage(text: string): Parsed {
  const bad = (message: string): Parsed => ({ ok: false, message });
  if (text.length > LIVE_MAX_CLIENT_MESSAGE) return bad(`messages may be at most ${LIVE_MAX_CLIENT_MESSAGE} characters`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return bad('messages must be JSON, for example {"op":"subscribe","instrument":"BTCUSD","tf":"5m"}');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return bad('a message must be a JSON object');
  const fields = value as Record<string, unknown>;
  for (const name of Object.keys(fields)) {
    if (!FIELDS.has(name)) return bad(`unknown field "${name}"; allowed: op, instrument, tf`);
  }
  const { op, instrument, tf } = fields;
  if (op !== 'subscribe' && op !== 'unsubscribe') return bad('"op" must be "subscribe" or "unsubscribe"');
  if (typeof instrument !== 'string' || instrument === '') return bad('"instrument" is required, for example BTCUSD');
  if (typeof tf !== 'string' || !isTimeframe(tf)) return bad('"tf" must be one of 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M');
  return { ok: true, message: { op, instrument, tf } };
}
