// The load test's clients (M2-04): WebSocket clients that each follow a few
// instrument and timeframe pairs and check what they receive.
//
// The publisher (load-live-harness.ts) writes a counter into every bar's
// close price, counting up per instrument with every update it makes. So a
// client can check, per pair and bar time, that values arrive in the order
// they were made, and at the end that it holds the newest value of every bar
// with nothing missing, for exactly the pairs it subscribed to.

import { BTCUSD, ETHUSD } from '@aia/data';
import type { LiveServerMessage } from '@aia/serving';
import type { Timeframe } from '@aia/shared-kernel';

export const LOAD_INSTRUMENTS = [BTCUSD, ETHUSD];
export const LOAD_TIMEFRAMES: readonly Timeframe[] = ['1m', '5m', '15m', '1h', '4h'];
export const LOAD_PAIRS = LOAD_INSTRUMENTS.flatMap((i) => LOAD_TIMEFRAMES.map((tf) => `${i.symbol}:${tf}`));
/** Scaled close = BASE + counter, so the counter survives display units. */
export const PRICE_BASE = 5_000_000;

/** What the publisher made, sent to clients once it has stopped. */
export interface PublishedSummary {
  /** Per pair, per bar time, the counter of the newest value. */
  readonly finals: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Per instrument, the publish time (epoch ms) of each counter value. */
  readonly publishedAt: Readonly<Record<string, readonly number[]>>;
}

export interface ClientsReport {
  readonly clients: number;
  readonly subscriptions: number;
  readonly messages: number;
  readonly updates: number;
  /** Latency from publish to receipt, in 1 ms buckets (the last bucket is "or more"). */
  readonly latency: number[];
  readonly failures: number;
  readonly examples: string[];
}

export const LATENCY_BUCKETS = 5_000;

/** Repeatable per client, so a failing run can be replayed. */
function random(seed: number): () => number {
  let state = seed * 2_654_435_761 + 1;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** 1 to 4 distinct pairs for client `id`. */
export function pairsFor(id: number): string[] {
  const next = random(id + 1);
  const count = 1 + Math.floor(next() * 4);
  const pool = [...LOAD_PAIRS];
  const picked: string[] = [];
  while (picked.length < count) picked.push(pool.splice(Math.floor(next() * pool.length), 1)[0] as string);
  return picked;
}

interface Received {
  readonly pair: string;
  readonly time: number;
  readonly counter: number;
  readonly at: number;
}

class Client {
  readonly received: Received[] = [];
  readonly problems: string[] = [];
  messages = 0;
  private ws!: WebSocket;

  constructor(
    readonly id: number,
    readonly pairs: readonly string[],
  ) {}

  /** Connect and subscribe; resolves once every subscription is confirmed. */
  start(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      let confirmed = 0;
      ws.addEventListener('open', () => {
        for (const pair of this.pairs) {
          const [instrument, tf] = pair.split(':');
          ws.send(JSON.stringify({ op: 'subscribe', instrument, tf }));
        }
      });
      ws.addEventListener('error', (event) => reject(new Error(`client ${this.id} could not connect: ${(event as ErrorEvent).message}`)));
      ws.addEventListener('close', (event) => this.problems.push(`closed by the server: ${event.code} ${event.reason}`));
      ws.addEventListener('message', (event) => {
        const at = performance.timeOrigin + performance.now();
        this.messages++;
        const message = JSON.parse(String(event.data)) as LiveServerMessage;
        switch (message.type) {
          case 'subscribed':
            if (++confirmed === this.pairs.length) resolve();
            return;
          case 'bars':
            for (const u of message.updates) {
              const instrument = LOAD_INSTRUMENTS.find((i) => i.symbol === u.instrument);
              const counter = Math.round(u.bar.close * 10 ** (instrument?.priceScale ?? 0)) - PRICE_BASE;
              this.received.push({ pair: `${u.instrument}:${u.timeframe}`, time: u.bar.time, counter, at });
            }
            return;
          default:
            this.problems.push(`unexpected ${JSON.stringify(message)}`);
        }
      });
    });
  }

  check(summary: PublishedSummary, latency: number[]): number {
    const newest = new Map<string, number>();
    // Latency is how long a value took to arrive the first time this client saw it.
    const seen = new Set<string>();
    for (const r of this.received) {
      if (!this.pairs.includes(r.pair)) {
        this.problems.push(`got ${r.pair}, not subscribed`);
        continue;
      }
      const key = `${r.pair}@${r.time}`;
      const before = newest.get(key);
      if (before !== undefined && r.counter < before) this.problems.push(`${key}: value ${r.counter} arrived after ${before}`);
      newest.set(key, r.counter);
      const symbol = r.pair.split(':')[0] as string;
      const sent = summary.publishedAt[symbol]?.[r.counter];
      if (sent === undefined) this.problems.push(`${key}: value ${r.counter} was never published`);
      else if (!seen.has(`${symbol}:${r.counter}`)) {
        seen.add(`${symbol}:${r.counter}`);
        latency[Math.min(LATENCY_BUCKETS - 1, Math.max(0, Math.floor(r.at - sent)))]! += 1;
      }
    }
    for (const pair of this.pairs) {
      for (const [time, counter] of Object.entries(summary.finals[pair] ?? {})) {
        const got = newest.get(`${pair}@${time}`);
        if (got === undefined) this.problems.push(`${pair}@${time}: never received`);
        else if (got !== counter) this.problems.push(`${pair}@${time}: ended at ${got}, newest published ${counter}`);
      }
    }
    return this.received.length;
  }

  close(): void {
    this.ws.close();
  }
}

/**
 * Run clients `ids` against `url`, connecting `wave` at a time; `finish`
 * checks them against what was published. Waves keep the handshakes waiting
 * across all client processes under macOS's listen queue (kern.ipc.somaxconn,
 * 128), which refuses the rest; Linux allows 4,096.
 */
export async function runClients(url: string, ids: readonly number[], wave = 50) {
  const clients = ids.map((id) => new Client(id, pairsFor(id)));
  for (let i = 0; i < clients.length; i += wave) await Promise.all(clients.slice(i, i + wave).map((c) => c.start(url)));
  return {
    finish(summary: PublishedSummary): ClientsReport {
      const latency = new Array<number>(LATENCY_BUCKETS).fill(0);
      let updates = 0;
      let failures = 0;
      const examples: string[] = [];
      for (const client of clients) {
        updates += client.check(summary, latency);
        client.close();
        // Closing is ours, not a failure.
        const problems = client.problems.filter((p) => !p.startsWith('closed by the server: 1005'));
        failures += problems.length;
        for (const p of problems) if (examples.length < 10) examples.push(`client ${client.id}: ${p}`);
      }
      return {
        clients: clients.length,
        subscriptions: clients.reduce((n, c) => n + c.pairs.length, 0),
        messages: clients.reduce((n, c) => n + c.messages, 0),
        updates,
        latency,
        failures,
        examples,
      };
    },
  };
}
