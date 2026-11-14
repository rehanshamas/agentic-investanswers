// The live gateway (M2-04), free of any WebSocket library: which browser
// follows which instrument and timeframe, and what each one is sent.
//
// - One session per browser connection, carrying all its subscriptions (at
//   most `maxSubscriptions`). Subscribing checks the same rules as GET /bars,
//   then the session's access check (plan checks on every subscription).
// - Updates are batched: each session collects them and gets one message per
//   `batchMs`, only when it has something. A bar repeated within one batch
//   keeps its first position and its newest value.
// - Order: announcements are handled one at a time, in the order received, and
//   each session's messages are sent in order. So for each instrument and
//   timeframe a browser sees updates to a bar in the order they were made.
// - Several hydration processes (shards, M1-15c) may announce at once; each
//   has its own sequence. A missed announcement (a jump in one publisher's
//   sequence, or the bus connection dropping), an instrument whose
//   announcements move to another publisher (a restarted or rebalanced shard:
//   the old one's forming bars may still be on screen), or a publisher's
//   request sends every session `resync`, so browsers reload from GET /bars
//   rather than show a wrong bar.
// - A session whose socket has more than `maxBufferedBytes` waiting is closed
//   (1013, try again later): the browser reconnects and resyncs, and the
//   server never queues without bound for a slow client.

import type { LiveClientMessage, LiveServerMessage, LiveWireUpdate } from '@aia/client-contract';
import { parseClientMessage } from '@aia/client-contract';
import type { DataAccess, LiveBarsListener, LiveBatch } from '@aia/data';
import type { Instrument, Timeframe } from '@aia/shared-kernel';

import { displayBar } from './display-bar.js';

/** The transport's side of one browser connection. */
export interface LiveSocket {
  send(text: string): void;
  /** Bytes accepted by `send` but not yet written to the network. */
  bufferedBytes(): number;
  close(code: number, reason: string): void;
}

export interface LiveGatewayOptions {
  /** Default 100 ms. */
  readonly batchMs?: number;
  /** Default 20. */
  readonly maxSubscriptions?: number;
  /** Default 1 MiB. */
  readonly maxBufferedBytes?: number;
}

export interface LiveGatewayDeps {
  /** The instruments, and what is served, from the data layer (M1-16). */
  readonly data: Pick<DataAccess, 'instruments' | 'whyNotServed'>;
  /** Run `run` every `ms`; returns a cancel. Injected so tests drive time. */
  readonly every: (ms: number, run: () => void) => () => void;
  readonly options?: LiveGatewayOptions;
}

/** May this session's principal follow this instrument and timeframe? */
export type Authorize = (symbol: string, timeframe: Timeframe) => Promise<boolean>;

/** Close code for a client too slow to keep up (RFC 6455: try again later). */
export const LIVE_CLOSE_TOO_SLOW = 1013;

const pairKey = (symbol: string, timeframe: Timeframe) => `${symbol}:${timeframe}`;

export class LiveSession {
  /** Subscribed pairs. */
  readonly pairs = new Set<string>();
  /** Pending updates, by pair and bar time. */
  readonly outbox = new Map<string, LiveWireUpdate>();
  closed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly gateway: LiveGateway,
    readonly socket: LiveSocket,
    readonly authorize: Authorize,
  ) {}

  /** A message from the browser. Handled after any earlier one, so subscribe and unsubscribe never cross. */
  receive(text: string): Promise<void> {
    this.queue = this.queue.then(() => this.gateway.handle(this, text));
    return this.queue;
  }

  /** The connection closed. */
  close(): void {
    this.gateway.drop(this);
  }
}

export class LiveGateway implements LiveBarsListener {
  private readonly sessions = new Set<LiveSession>();
  private readonly followers = new Map<string, Set<LiveSession>>();
  private readonly instruments: ReadonlyMap<string, Instrument>;
  private readonly data: Pick<DataAccess, 'instruments' | 'whyNotServed'>;
  private readonly batchMs: number;
  private readonly maxSubscriptions: number;
  private readonly maxBufferedBytes: number;
  private readonly cancelFlush: () => void;
  /** Per publisher, the last sequence number seen (M1-15c: one per hydration shard). */
  private readonly sequences = new Map<string, number>();
  /** Per instrument, the publisher announcing it. */
  private readonly announcer = new Map<string, string>();
  /** Per instrument, the newest stored 1m bar sent: a forming 1m bar never goes back over it. */
  private readonly stored1m = new Map<string, number>();

  constructor(deps: LiveGatewayDeps) {
    this.data = deps.data;
    this.instruments = new Map(deps.data.instruments.map((i) => [i.symbol, i]));
    this.batchMs = deps.options?.batchMs ?? 100;
    this.maxSubscriptions = deps.options?.maxSubscriptions ?? 20;
    this.maxBufferedBytes = deps.options?.maxBufferedBytes ?? 1 << 20;
    this.cancelFlush = deps.every(this.batchMs, () => this.flush());
  }

  /** A browser connected; its principal has been resolved, and `authorize` checks its plan. */
  open(socket: LiveSocket, authorize: Authorize): LiveSession {
    const session = new LiveSession(this, socket, authorize);
    this.sessions.add(session);
    return session;
  }

  get stats(): { readonly sessions: number; readonly subscriptions: number } {
    let subscriptions = 0;
    for (const session of this.sessions) subscriptions += session.pairs.size;
    return { sessions: this.sessions.size, subscriptions };
  }

  /** Stop batching and close every session. */
  stop(): void {
    this.cancelFlush();
    for (const session of [...this.sessions]) {
      this.drop(session);
      session.socket.close(1001, 'server shutting down');
    }
  }

  batch(batch: LiveBatch): void {
    const last = this.sequences.get(batch.publisher);
    if (last === undefined && batch.resync === true && batch.updates.length === 0) {
      // A resync on its own from a publisher not being followed (a maintenance
      // command that rewrote bars): resync, and do not follow it.
      this.resyncAll();
      return;
    }
    // One publisher's announcements arrive in order; a jump means some were missed.
    let resync = last !== undefined && batch.seq !== last + 1;
    for (const { symbol } of batch.updates) {
      const before = this.announcer.get(symbol);
      if (before !== undefined && before !== batch.publisher) resync = true; // taken over by another process
      this.announcer.set(symbol, batch.publisher);
    }
    if (resync || batch.resync === true) this.resyncAll();
    this.sequences.set(batch.publisher, batch.seq);
    if (this.sequences.size > 1_000) this.sequences.delete(this.sequences.keys().next().value as string);

    for (const update of batch.updates) {
      const instrument = this.instruments.get(update.symbol);
      if (instrument === undefined) continue;
      if (update.timeframe === '1m') {
        const stored = this.stored1m.get(update.symbol);
        if (update.forming && stored !== undefined && update.bar.time <= stored) continue;
        if (!update.forming && (stored === undefined || update.bar.time > stored)) this.stored1m.set(update.symbol, update.bar.time);
      }
      const key = pairKey(update.symbol, update.timeframe);
      const followers = this.followers.get(key);
      if (followers === undefined) continue;
      const wire: LiveWireUpdate = {
        instrument: update.symbol,
        timeframe: update.timeframe,
        forming: update.forming,
        bar: displayBar(instrument, update.bar),
      };
      const slot = `${key}:${update.bar.time}`;
      for (const session of followers) session.outbox.set(slot, wire);
    }
  }

  lost(): void {
    this.sequences.clear();
    this.resyncAll();
  }

  /** Send each session its pending updates, as one message. Runs every `batchMs`. */
  flush(): void {
    for (const session of this.sessions) {
      if (session.outbox.size === 0) continue;
      const updates = [...session.outbox.values()];
      session.outbox.clear();
      this.send(session, { type: 'bars', updates });
    }
  }

  /** @internal Called by LiveSession.receive, in order. */
  async handle(session: LiveSession, text: string): Promise<void> {
    if (session.closed) return;
    const parsed = parseClientMessage(text);
    if (!parsed.ok) {
      this.send(session, { type: 'error', code: 'bad_parameter', message: parsed.message });
      return;
    }
    const message = parsed.message;
    if (message.op === 'unsubscribe') {
      this.unfollow(session, pairKey(message.instrument, message.tf));
      this.send(session, { type: 'unsubscribed', instrument: message.instrument, timeframe: message.tf });
      return;
    }
    await this.subscribe(session, message);
  }

  /** @internal Called by LiveSession.close. */
  drop(session: LiveSession): void {
    if (session.closed) return;
    session.closed = true;
    for (const key of [...session.pairs]) this.unfollow(session, key);
    session.outbox.clear();
    this.sessions.delete(session);
  }

  private async subscribe(session: LiveSession, message: LiveClientMessage): Promise<void> {
    const { instrument: symbol, tf } = message;
    const refuse = (code: Extract<LiveServerMessage, { type: 'error' }>['code'], text: string) =>
      this.send(session, { type: 'error', code, message: text, instrument: symbol, timeframe: tf });

    const instrument = this.instruments.get(symbol);
    if (instrument === undefined) {
      refuse('unknown_instrument', `unknown instrument "${symbol}"; known: ${[...this.instruments.keys()].join(', ')}`);
      return;
    }
    const notServed = this.data.whyNotServed(instrument, tf);
    if (notServed !== undefined) {
      refuse('timeframe_not_served', notServed);
      return;
    }
    const key = pairKey(symbol, tf);
    if (!session.pairs.has(key)) {
      if (session.pairs.size >= this.maxSubscriptions) {
        refuse('too_many_subscriptions', `at most ${this.maxSubscriptions} subscriptions per connection; unsubscribe from one first`);
        return;
      }
      if (!(await session.authorize(symbol, tf))) {
        refuse('forbidden', `your plan does not include ${symbol} ${tf}`);
        return;
      }
      if (session.closed) return;
      session.pairs.add(key);
      let followers = this.followers.get(key);
      if (followers === undefined) this.followers.set(key, (followers = new Set()));
      followers.add(session);
    }
    this.send(session, { type: 'subscribed', instrument: symbol, timeframe: tf });
  }

  private unfollow(session: LiveSession, key: string): void {
    session.pairs.delete(key);
    for (const slot of [...session.outbox.keys()]) if (slot.startsWith(`${key}:`)) session.outbox.delete(slot);
    const followers = this.followers.get(key);
    followers?.delete(session);
    if (followers?.size === 0) this.followers.delete(key);
  }

  private resyncAll(): void {
    for (const session of this.sessions) {
      session.outbox.clear();
      this.send(session, { type: 'resync' });
    }
  }

  private send(session: LiveSession, message: LiveServerMessage): void {
    if (session.closed) return;
    if (session.socket.bufferedBytes() > this.maxBufferedBytes) {
      this.drop(session);
      session.socket.close(LIVE_CLOSE_TOO_SLOW, 'too slow to keep up; reconnect and load the newest bars again');
      return;
    }
    session.socket.send(JSON.stringify(message));
  }
}
