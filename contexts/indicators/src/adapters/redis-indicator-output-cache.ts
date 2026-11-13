// The indicator output cache in Redis (ElastiCache in staging; docker-compose.yml
// locally). One string key per run, with a TTL, so runs nobody asks for expire.
// Keys are prefixed `ind|`; the recent-bars cache (market-data) uses `bars:`.

import { createClient } from 'redis';

import type { IndicatorOutputCachePort } from '../application/indicator-output-cache-port.js';

export class IndicatorOutputCacheError extends Error {}

export interface RedisIndicatorCacheOptions {
  /** Defaults to the local Redis from docker-compose.yml. */
  readonly url?: string | undefined;
  /** Keep reconnecting after the first connection (a server), or give up after a few tries (a command). */
  readonly reconnect?: 'forever' | 'briefly';
  readonly onError?: (error: Error) => void;
}

type Client = ReturnType<typeof createClient>;

export class RedisIndicatorOutputCache implements IndicatorOutputCachePort {
  private constructor(private readonly client: Client) {}

  static async connect(options: RedisIndicatorCacheOptions = {}): Promise<RedisIndicatorOutputCache> {
    let connected = false;
    const client = createClient({
      url: options.url ?? 'redis://127.0.0.1:6379',
      // A cache that is down must not hold requests up: fail fast, recompute.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries: number) =>
          connected && options.reconnect === 'forever'
            ? Math.min(100 * 2 ** retries, 5_000)
            : retries >= 2
              ? new IndicatorOutputCacheError('Redis is unreachable')
              : 200,
      },
    });
    client.on('error', (error: Error) => options.onError?.(error));
    await client.connect();
    connected = true;
    return new RedisIndicatorOutputCache(client);
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }

  async get(key: string): Promise<string | undefined> {
    return (await this.client.get(key)) ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.client.set(key, value, { expiration: { type: 'EX', value: ttlSeconds } });
  }
}
