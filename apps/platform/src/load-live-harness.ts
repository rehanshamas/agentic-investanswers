// The live gateway load test (M2-04 done-check): the real server, gateway and
// bus, a fake publisher, and many WebSocket clients that check what arrives.
//
// The publisher drives the real FormingBars as `pnpm live` does, from made-up
// minutes, `speed` times faster than real time: forming bars every tick
// (250 ms / speed), a minute every 60 s / speed, and each minute's stored bars
// announced one tick after it closes (the store-then-cook race, as live). Each
// update's close carries a counter (load-live-clients.ts), so every client
// checks order and completeness by itself.
//
// Clients run in this process (tests) or in child processes (the command),
// so they do not compete with the server for its event loop.

import { fork } from 'node:child_process';

import { accessFromEnv } from '@aia/access';
import type { LiveBarUpdate, LiveBarsBusPort } from '@aia/market-data';
import {
  FormingBars,
  HistoryQuery,
  INTRADAY_ROLLUPS,
  LiveAnnouncer,
  LiveGateway,
  MemoryLiveBarsBus,
  MemoryRecentBarsCache,
  RecentBars,
  RedisLiveBarsBus,
  rollUp,
} from '@aia/market-data';
import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, price, volume } from '@aia/shared-kernel';

import type { ClientsReport, PublishedSummary } from './load-live-clients.js';
import { LATENCY_BUCKETS, LOAD_INSTRUMENTS, PRICE_BASE, runClients } from './load-live-clients.js';
import { buildServer } from './server.js';

export interface LoadOptions {
  readonly clients: number;
  readonly seconds: number;
  /** How much faster than real time the publisher runs. Default 5: a tick every 50 ms. */
  readonly speed?: number;
  /** Redis URL for the bus; memory when absent. */
  readonly redis?: string | undefined;
  /** Child processes for the clients; 0 runs them in this process. */
  readonly processes?: number;
  readonly log?: (line: string) => void;
}

export interface LoadReport extends ClientsReport {
  readonly published: number;
  readonly announcements: number;
  readonly seconds: number;
  readonly percentiles: { readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number };
  readonly bus: string;
}

const T0 = 1_794_312_000; // 2026-11-12 12:00 UTC, a 4h boundary
const TICKS_PER_MINUTE = 240; // a 250 ms tick, as LiveStream's

/** Made-up minutes for one instrument, with the counter in every close. */
class FakeInstrument {
  counter = 0;
  readonly publishedAt: number[] = [];
  readonly finals = new Map<string, Map<number, number>>();
  private readonly stored: Bar[] = [];
  private readonly forming: FormingBars;
  /** The minute forming: its index and first and newest counter. */
  private current = { minute: 0, open: 0, close: 0 };
  /** The minute that just closed, still being written. */
  private closing: Bar | undefined;

  constructor(readonly instrument: Instrument) {
    this.forming = new FormingBars(instrument, INTRADAY_ROLLUPS);
    // As `pnpm live` after its first minute: one minute already cooked, so every timeframe forms.
    const seed: Bar = { ...this.bar({ minute: -1, open: 0, close: 0 }) };
    this.stored.push(seed);
    this.forming.stored(seed);
    this.forming.cooked(seed, new Map(INTRADAY_ROLLUPS.map((tf) => [tf, rollUp(instrument, tf, [seed])])));
  }

  /** One tick: what `pnpm live` would announce now, in order. */
  tick(index: number, now: number): LiveBarUpdate[][] {
    const out: LiveBarUpdate[][] = [];
    const tickInMinute = index % TICKS_PER_MINUTE;
    if (tickInMinute === 0 && index > 0) {
      this.closing = this.bar(this.current);
      this.current = { minute: this.current.minute + 1, open: 0, close: 0 };
    }
    // One tick after a minute closed, it is stored and cooked.
    if (tickInMinute === 1 && this.closing !== undefined) {
      const minute = this.closing;
      this.closing = undefined;
      this.forming.stored(minute);
      this.stored.push(minute);
      const rebuilt = new Map<Timeframe, Bar[]>();
      for (const tf of INTRADAY_ROLLUPS) {
        const period = alignToTimeframe(this.instrument, tf, minute.time);
        rebuilt.set(tf, rollUp(this.instrument, tf, this.stored.filter((b) => alignToTimeframe(this.instrument, tf, b.time) === period)));
      }
      out.push(this.stamp(this.forming.cooked(minute, rebuilt), now));
    }
    // A trade.
    this.counter++;
    if (this.current.open === 0) this.current.open = this.counter;
    this.current.close = this.counter;
    const unstored = [...(this.closing === undefined ? [] : [this.closing]), this.bar(this.current)];
    out.push(this.stamp(this.forming.unstoredChanged(unstored), now));
    return out;
  }

  private bar({ minute, open, close }: { minute: number; open: number; close: number }): Bar {
    return {
      time: barTime(T0 + minute * 60),
      open: price(PRICE_BASE + open),
      high: price(PRICE_BASE + close),
      low: price(PRICE_BASE),
      close: price(PRICE_BASE + close),
      volume: volume(1_000_000 + close),
    };
  }

  /** Record what each update carries, for the clients' checks. */
  private stamp(updates: LiveBarUpdate[], now: number): LiveBarUpdate[] {
    for (const u of updates) {
      const counter = u.bar.close - PRICE_BASE;
      // When the value was new: a stored bar repeats its minute's last forming value.
      this.publishedAt[counter] ??= now;
      const pair = `${u.symbol}:${u.timeframe}`;
      let times = this.finals.get(pair);
      if (times === undefined) this.finals.set(pair, (times = new Map()));
      times.set(u.bar.time, counter);
    }
    return updates;
  }
}

function percentile(histogram: readonly number[], fraction: number): number {
  const total = histogram.reduce((a, b) => a + b, 0);
  let seen = 0;
  for (let ms = 0; ms < histogram.length; ms++) {
    seen += histogram[ms] as number;
    if (seen >= total * fraction) return ms;
  }
  return histogram.length;
}

function merge(reports: readonly ClientsReport[]): ClientsReport {
  const latency = new Array<number>(LATENCY_BUCKETS).fill(0);
  for (const r of reports) r.latency.forEach((n, i) => (latency[i]! += n));
  return {
    clients: reports.reduce((n, r) => n + r.clients, 0),
    subscriptions: reports.reduce((n, r) => n + r.subscriptions, 0),
    messages: reports.reduce((n, r) => n + r.messages, 0),
    updates: reports.reduce((n, r) => n + r.updates, 0),
    latency,
    failures: reports.reduce((n, r) => n + r.failures, 0),
    examples: reports.flatMap((r) => r.examples).slice(0, 10),
  };
}

interface ClientGroup {
  ready: Promise<void>;
  finish(summary: PublishedSummary): Promise<ClientsReport>;
}

function inProcess(url: string, ids: number[]): ClientGroup {
  const running = runClients(url, ids);
  return {
    ready: running.then(() => undefined),
    finish: async (summary) => (await running).finish(summary),
  };
}

function childProcess(url: string, ids: number[], wave: number): ClientGroup {
  const child = fork(new URL('./load-live-worker.ts', import.meta.url), [], { execArgv: process.execArgv });
  let report: (r: ClientsReport) => void = () => {};
  let ready: () => void = () => {};
  let failed: (e: Error) => void = () => {};
  child.on('message', (message: { kind: string; report?: ClientsReport; error?: string }) => {
    if (message.kind === 'ready') ready();
    if (message.kind === 'report' && message.report !== undefined) report(message.report);
    if (message.kind === 'error') failed(new Error(message.error));
  });
  child.send({ kind: 'start', url, ids, wave });
  return {
    ready: new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    }),
    finish: (summary) =>
      new Promise<ClientsReport>((resolve) => {
        report = (r) => {
          child.kill();
          resolve(r);
        };
        child.send({ kind: 'finish', summary });
      }),
  };
}

export async function runLoad(options: LoadOptions): Promise<LoadReport> {
  const log = options.log ?? (() => {});
  const speed = options.speed ?? 5;
  const tickMs = 250 / speed;

  const bus: LiveBarsBusPort =
    options.redis === undefined ? new MemoryLiveBarsBus() : await RedisLiveBarsBus.connect({ url: options.redis, channel: `load:live:${Date.now()}` });
  const gateway = new LiveGateway({
    instruments: LOAD_INSTRUMENTS,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  await bus.subscribe(gateway);
  const empty = { getRange: () => Promise.resolve([]), read: () => Promise.resolve([]) };
  const app = await buildServer({
    history: new HistoryQuery({
      recentBars: new RecentBars({ cache: new MemoryRecentBarsCache(), store: empty, minutes: empty }),
      instruments: LOAD_INSTRUMENTS,
      earliest: () => barTime(T0),
    }),
    access: accessFromEnv({ AIA_DEV_AUTH: '1' }),
    live: gateway,
    now: () => barTime(T0),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const url = `ws://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/live`;

  try {
    const processes = options.processes ?? 0;
    const ids = Array.from({ length: options.clients }, (_, i) => i);
    const groups =
      processes === 0
        ? [inProcess(url, ids)]
        : Array.from({ length: processes }, (_, p) =>
            // At most 100 handshakes in flight in all (see runClients).
            childProcess(url, ids.filter((id) => id % processes === p), Math.max(1, Math.floor(100 / processes))),
          );
    await Promise.all(groups.map((g) => g.ready));
    log(`${options.clients} clients connected, ${gateway.stats.subscriptions} subscriptions; publishing for ${options.seconds} s at ${speed}x`);

    // One publisher per instrument, as if each came from its own hydration shard (M1-15c):
    // their announcements interleave on the bus, and clients count any resync as a failure.
    const announcers = new Map(LOAD_INSTRUMENTS.map((i) => [i.symbol, new LiveAnnouncer(bus, `load-${i.symbol}`)]));
    const fakes = LOAD_INSTRUMENTS.map((i) => new FakeInstrument(i));
    let published = 0;
    let announcements = 0;
    const ticks = Math.round((options.seconds * 1000) / tickMs);
    const started = performance.now();
    for (let index = 0; index < ticks; index++) {
      // Keep to the schedule even if a tick runs late.
      const due = started + index * tickMs;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const now = performance.timeOrigin + performance.now();
      for (const fake of fakes) {
        for (const updates of fake.tick(index, now)) {
          published += updates.length;
          announcements++;
          void announcers.get(fake.instrument.symbol)?.publish(updates);
        }
      }
    }
    // Let the last batches through the bus and the gateway.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const summary: PublishedSummary = {
      finals: Object.fromEntries(
        fakes.flatMap((f) => [...f.finals].map(([pair, times]) => [pair, Object.fromEntries([...times].map(([t, c]) => [String(t), c]))])),
      ),
      publishedAt: Object.fromEntries(fakes.map((f) => [f.instrument.symbol, f.publishedAt])),
    };
    const report = merge(await Promise.all(groups.map((g) => g.finish(summary))));
    return {
      ...report,
      published,
      announcements,
      seconds: options.seconds,
      bus: options.redis === undefined ? 'memory' : 'redis',
      percentiles: {
        p50: percentile(report.latency, 0.5),
        p95: percentile(report.latency, 0.95),
        p99: percentile(report.latency, 0.99),
        max: report.latency.reduce((last, n, ms) => (n > 0 ? ms : last), 0),
      },
    };
  } finally {
    gateway.stop();
    await app.close();
    await bus.close();
  }
}
