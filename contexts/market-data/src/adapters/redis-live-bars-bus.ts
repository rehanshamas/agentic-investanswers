// The live bars bus on Redis pub/sub (M2-04): ElastiCache in staging, the
// Redis from docker-compose.yml locally. No new service: the architecture
// already names pub/sub as the link between the two processes.
//
// One channel. Each announcement is one JSON message:
//   { "p": publisher, "s": seq, "r": 1 if resync, "u": [[symbol, tf, forming 0|1, time, open, high, low, close, volume], ...] }
// Values are our scaled whole numbers, so nothing is a float. Pub/sub keeps
// order per publisher but never replays: while the subscriber is disconnected,
// announcements are lost, so on reconnecting it reports `lost` and the gateway
// resyncs browsers. A malformed message is reported as `lost` too.

import type { Timeframe } from '@aia/shared-kernel';
import { barTime, isTimeframe, price, volume } from '@aia/shared-kernel';
import { createClient } from 'redis';

import type { LiveBarsBusPort, LiveBarsListener } from '../application/live-bars-bus-port.js';
import { LiveBarsBusError } from '../application/live-bars-bus-port.js';
import type { LiveBarUpdate, LiveBatch } from '../domain/live-update.js';

export const LIVE_BARS_CHANNEL = 'bars:live';

export interface RedisLiveBarsBusOptions {
  /** Defaults to the local Redis from docker-compose.yml. */
  readonly url?: string | undefined;
  /** Defaults to `bars:live`. Tests use their own. */
  readonly channel?: string;
  /** Told about connection errors; the client keeps them from crashing the process. */
  readonly onError?: (error: Error) => void;
}

type Client = ReturnType<typeof createClient>;

function client(options: RedisLiveBarsBusOptions, state: { connected: boolean }): Client {
  const c = createClient({
    url: options.url ?? 'redis://127.0.0.1:6379',
    // Fail a publish while disconnected rather than queue it: the gap is then
    // visible in the sequence, and nothing stale is delivered later.
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 2_000,
      // After the first connection, keep trying: both processes run for days.
      // The first connection gives up quickly, so a missing Redis is reported at once.
      reconnectStrategy: (retries: number) =>
        state.connected ? Math.min(100 * 2 ** retries, 5_000) : retries >= 2 ? new LiveBarsBusError('Redis is unreachable') : 200,
    },
  });
  c.on('error', (error: Error) => options.onError?.(error));
  return c;
}

export class RedisLiveBarsBus implements LiveBarsBusPort {
  private subscriber: Client | undefined;

  private constructor(
    private readonly publisher: Client,
    private readonly options: RedisLiveBarsBusOptions,
  ) {}

  static async connect(options: RedisLiveBarsBusOptions = {}): Promise<RedisLiveBarsBus> {
    const state = { connected: false };
    const publisher = client(options, state);
    await publisher.connect();
    state.connected = true;
    return new RedisLiveBarsBus(publisher, options);
  }

  get channel(): string {
    return this.options.channel ?? LIVE_BARS_CHANNEL;
  }

  async publish(batch: LiveBatch): Promise<void> {
    await this.publisher.publish(this.channel, encode(batch));
  }

  async subscribe(listener: LiveBarsListener): Promise<void> {
    if (this.subscriber !== undefined) throw new LiveBarsBusError('already subscribed');
    const state = { connected: false };
    const subscriber = client(this.options, state);
    let down = false;
    subscriber.on('error', () => (down = true));
    subscriber.on('reconnecting', () => (down = true));
    subscriber.on('ready', () => {
      if (!down) return;
      down = false;
      listener.lost('the connection to Redis was lost; announcements may have been missed');
    });
    await subscriber.connect();
    state.connected = true;
    // node-redis subscribes again by itself after a reconnect.
    await subscriber.subscribe(this.channel, (message: string) => {
      const batch = decode(message);
      if (batch === undefined) listener.lost('a malformed announcement was received');
      else listener.batch(batch);
    });
    this.subscriber = subscriber;
  }

  async close(): Promise<void> {
    if (this.subscriber?.isOpen === true) await this.subscriber.close();
    if (this.publisher.isOpen) await this.publisher.close();
  }
}

type Row = [string, string, 0 | 1, number, number, number, number, number, number];

export function encode(batch: LiveBatch): string {
  const u: Row[] = batch.updates.map(({ symbol, timeframe, bar, forming }) => [
    symbol,
    timeframe,
    forming ? 1 : 0,
    bar.time,
    bar.open,
    bar.high,
    bar.low,
    bar.close,
    bar.volume,
  ]);
  return JSON.stringify({ p: batch.publisher, s: batch.seq, ...(batch.resync === true ? { r: 1 } : {}), u });
}

/** The announcement, or `undefined` if the message is not a well-formed one. */
export function decode(message: string): LiveBatch | undefined {
  try {
    const value = JSON.parse(message) as { p?: unknown; s?: unknown; r?: unknown; u?: unknown };
    if (typeof value.p !== 'string' || !Number.isSafeInteger(value.s) || !Array.isArray(value.u)) return undefined;
    const updates: LiveBarUpdate[] = [];
    for (const row of value.u as unknown[]) {
      if (!Array.isArray(row) || row.length !== 9) return undefined;
      const [symbol, tf, forming, ...numbers] = row as unknown[];
      if (typeof symbol !== 'string' || typeof tf !== 'string' || !isTimeframe(tf) || (forming !== 0 && forming !== 1)) return undefined;
      if (!numbers.every((n) => Number.isSafeInteger(n))) return undefined;
      const [time, open, high, low, close, vol] = numbers as number[];
      updates.push({
        symbol,
        timeframe: tf as Timeframe,
        forming: forming === 1,
        bar: {
          time: barTime(time as number),
          open: price(open as number),
          high: price(high as number),
          low: price(low as number),
          close: price(close as number),
          volume: volume(vol as number),
        },
      });
    }
    return { publisher: value.p, seq: value.s as number, updates, ...(value.r === 1 ? { resync: true } : {}) };
  } catch {
    return undefined;
  }
}
