// One WebSocket per browser tab to the live gateway (GET /live, M2-04),
// carrying every subscription the page has. Framework-free; the chart binds to it.
//
// - Subscriptions are ref-counted: the first listener of an instrument and
//   timeframe sends `subscribe`, the last one to leave sends `unsubscribe`.
// - Reconnects after any close (a dropped network, a server restart, 1013 for
//   a client too slow to keep up), with backoff: 0.5 s doubling to 30 s, with
//   jitter. A reconnect resubscribes everything and tells every listener to
//   resync, since updates were missed meanwhile.
// - The server's `resync` goes to every listener; an `error` goes to the
//   listeners of its instrument and timeframe, or to all when it names none.

import type { LiveClientMessage, LiveErrorCode, LiveServerMessage, LiveWireUpdate } from '@aia/client-contract';
import type { Timeframe } from '@aia/shared-kernel';

/** What the connection needs from a WebSocket (see browserSocket). */
export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
}

/** The browser's WebSocket as a SocketLike. */
export function browserSocket(url: string): SocketLike {
  const ws = new WebSocket(url);
  const socket: SocketLike = {
    send: (text) => ws.send(text),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  ws.onopen = () => socket.onopen?.();
  ws.onmessage = (event) => socket.onmessage?.(event);
  ws.onclose = (event) => socket.onclose?.(event);
  return socket;
}

export interface LiveListener {
  /** Updates to this instrument and timeframe, in the order the server sent them. */
  updates(updates: readonly LiveWireUpdate[]): void;
  /** Updates may have been missed: load the newest page again. */
  resync(): void;
  error(code: LiveErrorCode, message: string): void;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface Timers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LiveConnectionOptions {
  /** The /live URL, built on every attempt so a new session token is picked up. */
  readonly url: () => string;
  readonly open: (url: string) => SocketLike;
  readonly timers: Timers;
  /** 0 to 1; jitter for the backoff. Default Math.random. */
  readonly random?: () => number;
  readonly onState?: (state: ConnectionState) => void;
}

const FIRST_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

const keyOf = (instrument: string, timeframe: string) => `${instrument}|${timeframe}`;

export class LiveConnection {
  private socket: SocketLike | undefined;
  private open = false;
  private readonly subscriptions = new Map<string, { readonly instrument: string; readonly tf: Timeframe; readonly listeners: Set<LiveListener> }>();
  /** Failed attempts since a connection last got a message; sets the backoff. */
  private failures = 0;
  private everOpened = false;
  private retry: unknown;
  private disposed = false;

  constructor(private readonly options: LiveConnectionOptions) {}

  /** Follow one instrument and timeframe; returns the way to stop. */
  subscribe(instrument: string, tf: Timeframe, listener: LiveListener): () => void {
    const key = keyOf(instrument, tf);
    let subscription = this.subscriptions.get(key);
    if (subscription === undefined) {
      subscription = { instrument, tf, listeners: new Set() };
      this.subscriptions.set(key, subscription);
      this.send({ op: 'subscribe', instrument, tf });
    }
    subscription.listeners.add(listener);
    this.connect();
    const owned = subscription;
    return () => {
      owned.listeners.delete(listener);
      if (owned.listeners.size === 0 && this.subscriptions.get(key) === owned) {
        this.subscriptions.delete(key);
        this.send({ op: 'unsubscribe', instrument, tf });
      }
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.retry !== undefined) this.options.timers.clear(this.retry);
    this.retry = undefined;
    this.socket?.close(1000, 'page closed');
    this.socket = undefined;
    this.setState('closed');
  }

  private connect(): void {
    if (this.disposed || this.socket !== undefined || this.retry !== undefined) return;
    this.setState(this.everOpened ? 'reconnecting' : 'connecting');
    const socket = this.options.open(this.options.url());
    this.socket = socket;
    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.open = true;
      this.everOpened = true;
      this.setState('open');
      for (const { instrument, tf } of this.subscriptions.values()) this.send({ op: 'subscribe', instrument, tf });
      if (reconnected) for (const listener of this.allListeners()) listener.resync();
    };
    socket.onmessage = (event) => {
      this.failures = 0;
      this.receive(event.data);
    };
    socket.onclose = () => {
      this.socket = undefined;
      this.open = false;
      if (this.disposed) return;
      this.setState('reconnecting');
      const backoff = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** this.failures);
      this.failures++;
      const jitter = 0.8 + 0.4 * (this.options.random ?? Math.random)();
      this.retry = this.options.timers.set(() => {
        this.retry = undefined;
        this.connect();
      }, Math.round(backoff * jitter));
    };
  }

  private receive(data: unknown): void {
    let message: LiveServerMessage;
    try {
      message = JSON.parse(String(data)) as LiveServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'bars': {
        const byKey = new Map<string, LiveWireUpdate[]>();
        for (const update of message.updates) {
          const key = keyOf(update.instrument, update.timeframe);
          let list = byKey.get(key);
          if (list === undefined) byKey.set(key, (list = []));
          list.push(update);
        }
        for (const [key, updates] of byKey) for (const listener of this.subscriptions.get(key)?.listeners ?? []) listener.updates(updates);
        return;
      }
      case 'resync':
        for (const listener of this.allListeners()) listener.resync();
        return;
      case 'error': {
        const named = message.instrument !== undefined && message.timeframe !== undefined;
        const listeners = named ? (this.subscriptions.get(keyOf(message.instrument ?? '', message.timeframe ?? ''))?.listeners ?? []) : this.allListeners();
        for (const listener of listeners) listener.error(message.code, message.message);
        return;
      }
      default:
        return;
    }
  }

  private allListeners(): LiveListener[] {
    return [...this.subscriptions.values()].flatMap((s) => [...s.listeners]);
  }

  private send(message: LiveClientMessage): void {
    if (this.open) this.socket?.send(JSON.stringify(message));
  }

  private setState(state: ConnectionState): void {
    this.options.onState?.(state);
  }
}
