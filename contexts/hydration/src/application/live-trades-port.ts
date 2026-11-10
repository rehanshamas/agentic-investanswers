// Where live trades come from (M1-05). Speaks our language only (CLAUDE.md
// rule 7): our instrument symbols, trades in our units. The provider's
// symbols, message format, subscriptions and heartbeats stay in its adapter.

import type { Instrument } from '@aia/shared-kernel';

import type { LiveTrade } from '../domain/live-minutes.js';

/** What a connection reports. Called by the adapter; never throws back into it. */
export interface LiveSink {
  /** Subscribed: trades from here on are live. */
  onOpen(): void;
  onTrade(symbol: string, trade: LiveTrade): void;
  /** Any sign of life (a heartbeat, a trade), for dead-connection detection. */
  onAlive(): void;
  /**
   * The connection ended or became untrustworthy (a socket close, an error,
   * a message that cannot be read exactly, trades known to be missing). Called
   * at most once per connection.
   */
  onClose(reason: string): void;
}

export interface LiveConnection {
  close(): void;
}

export interface LiveTradesPort {
  /** The adapter's registered name, and the `provider` part of raw keys. */
  readonly name: string;
  /** Open one connection for these instruments. Reconnecting is the caller's job. */
  connect(instruments: readonly Instrument[], sink: LiveSink): LiveConnection;
}

/** Settings every live adapter accepts. */
export interface LiveFeedOptions {
  /** Called with every raw message as received, for recording and replay. */
  readonly record?: (message: string, receivedMs: number) => void;
}
