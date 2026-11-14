// Rate counters in Redis (M2-10; ElastiCache in staging, docker-compose.yml
// locally), shared by every platform process. One key per bucket, subject and
// window, prefixed `rl|`, counted and given its expiry in one script.

import { createClient } from 'redis';

import type { RateCounterPort } from '../application/rate-limiter.js';

export interface RedisRateCounterOptions {
  /** Defaults to the local Redis from docker-compose.yml. */
  readonly url?: string | undefined;
  /** Keep reconnecting after the first connection (a server), or give up after a few tries (a test). */
  readonly reconnect?: 'forever' | 'briefly';
  readonly onError?: (error: Error) => void;
}

type Client = ReturnType<typeof createClient>;

const HIT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

export class RedisRateCounter implements RateCounterPort {
  private constructor(private readonly client: Client) {}

  static async connect(options: RedisRateCounterOptions = {}): Promise<RedisRateCounter> {
    let connected = false;
    const client = createClient({
      url: options.url ?? 'redis://127.0.0.1:6379',
      // A limiter that is down lets requests through (RateLimiter); never queue behind it.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries: number) =>
          connected && options.reconnect === 'forever'
            ? Math.min(100 * 2 ** retries, 5_000)
            : retries >= 2
              ? new Error('Redis is unreachable')
              : 200,
      },
    });
    client.on('error', (error: Error) => options.onError?.(error));
    await client.connect();
    connected = true;
    return new RedisRateCounter(client);
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }

  async hit(key: string, ttlSeconds: number): Promise<number> {
    return Number(await this.client.eval(HIT, { keys: [key], arguments: [String(ttlSeconds)] }));
  }
}
