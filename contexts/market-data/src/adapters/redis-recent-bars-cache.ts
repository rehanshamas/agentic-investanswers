// The recent-bars cache in Redis (ElastiCache in staging; docker-compose.yml locally).
//
// Per instrument and timeframe, three keys sharing one hash tag, so they sit in
// one slot if the cluster is sharded:
//   bars:{BTCUSD:5m}       sorted set, score = bar time, member = "time,open,high,low,close,volume"
//   bars:{BTCUSD:5m}:from  the window start (domain/recent-window.ts); absent = no window
//   bars:{BTCUSD:5m}:v     version, bumped by every apply and invalidate
// Values are our scaled whole numbers, so nothing is a float. Each write is one
// Lua script, so two writers cannot interleave its steps; the scripts follow
// the rules in domain/recent-window.ts and are tested against the same cases.

import type { Bar, Timeframe } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { createClient } from 'redis';

import type { RecentBarsCachePort } from '../application/recent-bars-cache-port.js';
import { RecentBarsCacheError } from '../application/recent-bars-cache-port.js';
import type { RecentWindow } from '../domain/recent-window.js';
import { RECENT_BARS_CAPACITY, fillWindow } from '../domain/recent-window.js';

// KEYS: set, from, version. ARGV: time, member, capacity.
const APPLY = `
redis.call('INCR', KEYS[3])
local from = redis.call('GET', KEYS[2])
if not from then return 0 end
local t = tonumber(ARGV[1])
if t < tonumber(from) then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[1], t, t)
redis.call('ZADD', KEYS[1], t, ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
local cap = tonumber(ARGV[3])
if n > cap then
  redis.call('ZREMRANGEBYRANK', KEYS[1], 0, n - cap - 1)
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  redis.call('SET', KEYS[2], first[2])
end
return 1
`;

// KEYS: set, from, version. ARGV: expected version, from, then time and member pairs.
const FILL = `
local v = redis.call('GET', KEYS[3]) or '0'
if v ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[2])
for i = 3, #ARGV, 2 do
  redis.call('ZADD', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 1
`;

// KEYS: set, from. Returns {from, member...}, or {} when there is no window.
const GET = `
local from = redis.call('GET', KEYS[2])
if not from then return {} end
local out = redis.call('ZRANGE', KEYS[1], 0, -1)
table.insert(out, 1, from)
return out
`;

// KEYS: set, from, version.
const INVALIDATE = `
redis.call('INCR', KEYS[3])
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

export interface RedisCacheOptions {
  /** Defaults to the local Redis from docker-compose.yml. */
  readonly url?: string | undefined;
  readonly capacity?: number;
  /**
   * After the first connection: keep reconnecting forever (a long-running
   * process), or give up after a few tries (a command). The first connection
   * always gives up after a few tries, so a missing Redis is reported at once.
   */
  readonly reconnect?: 'forever' | 'briefly';
  /** Told about connection errors; the client keeps them from crashing the process. */
  readonly onError?: (error: Error) => void;
}

type Client = ReturnType<typeof createClient>;

export class RedisRecentBarsCache implements RecentBarsCachePort {
  private constructor(
    private readonly client: Client,
    private readonly capacity: number,
  ) {}

  static async connect(options: RedisCacheOptions = {}): Promise<RedisRecentBarsCache> {
    let connected = false;
    const client = createClient({
      url: options.url ?? 'redis://127.0.0.1:6379',
      // Fail commands while disconnected rather than queue them: a queued
      // update would hold up whoever awaits it (cooking, in `pnpm live`), and
      // the caller drops the window instead (see RecentBars.onBarClosed).
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2_000,
        reconnectStrategy: (retries: number) =>
          connected && options.reconnect === 'forever'
            ? Math.min(100 * 2 ** retries, 5_000)
            : retries >= 2
              ? new RecentBarsCacheError('Redis is unreachable')
              : 200,
      },
    });
    client.on('error', (error: Error) => options.onError?.(error));
    await client.connect();
    connected = true;
    return new RedisRecentBarsCache(client, options.capacity ?? RECENT_BARS_CAPACITY);
  }

  async close(): Promise<void> {
    if (this.client.isOpen) await this.client.close();
  }

  async get(symbol: string, timeframe: Timeframe): Promise<RecentWindow | undefined> {
    const reply = (await this.client.eval(GET, { keys: keys(symbol, timeframe).slice(0, 2) })) as string[];
    if (reply.length === 0) return undefined;
    const [from, ...members] = reply as [string, ...string[]];
    return { from: barTime(Number(from)), bars: members.map(decode) };
  }

  async version(symbol: string, timeframe: Timeframe): Promise<number> {
    return Number((await this.client.get(keys(symbol, timeframe)[2])) ?? '0');
  }

  async fill(symbol: string, timeframe: Timeframe, window: RecentWindow, ifVersion: number): Promise<boolean> {
    const { from, bars } = fillWindow(window.from, window.bars, this.capacity);
    const args = [String(ifVersion), String(from)];
    for (const bar of bars) args.push(String(bar.time), encode(bar));
    return (await this.client.eval(FILL, { keys: keys(symbol, timeframe), arguments: args })) === 1;
  }

  async apply(symbol: string, timeframe: Timeframe, bar: Bar): Promise<void> {
    await this.client.eval(APPLY, {
      keys: keys(symbol, timeframe),
      arguments: [String(bar.time), encode(bar), String(this.capacity)],
    });
  }

  async invalidate(symbol: string, timeframe: Timeframe): Promise<void> {
    await this.client.eval(INVALIDATE, { keys: keys(symbol, timeframe) });
  }
}

function keys(symbol: string, timeframe: Timeframe): [string, string, string] {
  const base = `bars:{${symbol}:${timeframe}}`;
  return [base, `${base}:from`, `${base}:v`];
}

function encode(bar: Bar): string {
  return `${bar.time},${bar.open},${bar.high},${bar.low},${bar.close},${bar.volume}`;
}

function decode(member: string): Bar {
  const [time, open, high, low, close, vol] = member.split(',').map(Number);
  if (vol === undefined) throw new RecentBarsCacheError(`malformed cached bar: ${member}`);
  return {
    time: barTime(time as number),
    open: price(open as number),
    high: price(high as number),
    low: price(low as number),
    close: price(close as number),
    volume: volume(vol),
  };
}
