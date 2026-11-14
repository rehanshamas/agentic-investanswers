// The platform for the chart's end-to-end tests (M2-05): the real server,
// History API and live gateway over the in-memory data layer, so a browser
// test needs no Redis, S3, DynamoDB or provider. Never used in production.
//
// - History: made-up 1-minute bars for BTCUSD and ETHUSD, the same on every
//   run, for the 30 days before NOW, and 5m to 4h bars rolled up from them
//   (first open, highest high, lowest low, last close, summed volume).
// - Live: the data layer's simulated feed (the same forming and stored bar
//   rules as `pnpm live`), driven by the test through two routes:
//     POST /e2e/trade  { instrument, minute, close }   a trade in minute
//                      `minute` (0 is the minute starting at NOW), at
//                      `close` in display units: its forming bars are announced
//     POST /e2e/store  { instrument, minute, close? }  that minute is stored
//                      (with `close`, a last trade changed it): its stored
//                      bars are announced
// - Access: local developer mode, everything allowed.
//
//   tsx apps/platform/src/e2e-server.ts   (AIA_PORT, default 8181)

import { accessFromEnv } from '@aia/access';
import type { LiveBarUpdate } from '@aia/data';
import { BTCUSD, ETHUSD, MemoryDataLayer, SimulatedLiveFeed } from '@aia/data';
import { IndicatorRegistry } from '@aia/indicators';
import { HistoryQuery, LiveGateway } from '@aia/serving';
import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { alignToTimeframe, barTime, price, volume } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';

import { buildServer } from './server.js';
import { settingsDemo } from './settings-demo-indicator.js';

/** 2026-11-10 12:00 UTC: a 4h boundary, so every timeframe's bar starts here. */
export const E2E_NOW = 1_794_312_000;
const HISTORY_DAYS = 30;
const INSTRUMENTS = [BTCUSD, ETHUSD];
/** Where each instrument's made-up prices hover, in display units. */
const BASE_PRICE: Readonly<Record<string, number>> = { BTCUSD: 90_000, ETHUSD: 3_000 };

/** A price in display units as the instrument's scaled whole number. */
const scaled = (instrument: Instrument, value: number) => Math.round(value * 10 ** instrument.priceScale);

/** A made-up minute: a slow wave plus a wiggle. */
function madeUpMinute(instrument: Instrument, time: number): Bar {
  const base = BASE_PRICE[instrument.symbol] ?? 1_000;
  const at = (t: number) => scaled(instrument, base * (1 + 0.02 * Math.sin(t / 21_600) + 0.002 * Math.sin(t / 420)));
  const open = at(time);
  const close = at(time + 60);
  const spread = scaled(instrument, base * 0.0005);
  return {
    time: barTime(time),
    open: price(open),
    high: price(Math.max(open, close) + spread),
    low: price(Math.min(open, close) - spread),
    close: price(close),
    volume: volume(100_000_000 + (time % 7_919) * 1_000),
  };
}

/** Made-up history before NOW, plus the minutes the test stored. */
class E2EMinutes {
  readonly stored = new Map<string, Map<number, Bar>>();

  read(symbol: string, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = INSTRUMENTS.find((i) => i.symbol === symbol);
    if (instrument === undefined) return Promise.resolve([]);
    const bars: Bar[] = [];
    const start = Math.max(from, E2E_NOW - HISTORY_DAYS * 86_400);
    for (let t = Math.ceil(start / 60) * 60; t <= until && t < E2E_NOW; t += 60) bars.push(madeUpMinute(instrument, t));
    for (const [t, bar] of [...(this.stored.get(symbol) ?? new Map<number, Bar>())].sort(([a], [b]) => a - b)) {
      if (t >= from && t <= until) bars.push(bar);
    }
    return Promise.resolve(bars);
  }
}

const SPAN_SECONDS: Partial<Record<Timeframe, number>> = { '5m': 300, '15m': 900, '1h': 3_600, '4h': 14_400 };

/** 5m to 4h bars rolled up from the minutes: `[from, until]` by bar time. */
class E2ECooked {
  constructor(private readonly minutes: E2EMinutes) {}

  async getRange(symbol: string, timeframe: Timeframe, from: BarTime, until: BarTime): Promise<Bar[]> {
    const instrument = INSTRUMENTS.find((i) => i.symbol === symbol);
    if (instrument === undefined) return [];
    const span = SPAN_SECONDS[timeframe];
    if (span === undefined) return [];
    const bars: Bar[] = [];
    for (const minute of await this.minutes.read(symbol, from, barTime(until + span - 60))) {
      const time = alignToTimeframe(instrument, timeframe, minute.time);
      if (time === undefined || time < from || time > until) continue;
      const last = bars[bars.length - 1];
      if (last === undefined || last.time !== time) {
        bars.push({ ...minute, time });
        continue;
      }
      bars[bars.length - 1] = {
        time,
        open: last.open,
        high: price(Math.max(last.high, minute.high)),
        low: price(Math.min(last.low, minute.low)),
        close: minute.close,
        volume: volume(last.volume + minute.volume),
      };
    }
    return bars;
  }
}

/** One instrument's live minutes, as the test trades and stores them. */
class E2ELive {
  private readonly feed: SimulatedLiveFeed;
  private readonly unstored = new Map<number, Bar>();

  constructor(readonly instrument: Instrument) {
    this.feed = new SimulatedLiveFeed(instrument);
    // As `pnpm live` after its first minute: the minute before NOW is cooked, so every timeframe forms.
    this.feed.stored(madeUpMinute(instrument, E2E_NOW - 60));
  }

  trade(minute: number, closePrice: number): LiveBarUpdate[] {
    const time = E2E_NOW + minute * 60;
    const was = this.unstored.get(time);
    const value = scaled(this.instrument, closePrice);
    const close = price(value);
    this.unstored.set(time, {
      time: barTime(time),
      open: was?.open ?? close,
      high: price(Math.max(was?.high ?? value, value)),
      low: price(Math.min(was?.low ?? value, value)),
      close,
      volume: volume((was?.volume ?? 0) + 1_000_000),
    });
    return this.feed.unstoredChanged([...this.unstored.values()].sort((a, b) => a.time - b.time));
  }

  store(minute: number, closePrice: number | undefined): { bar: Bar; updates: LiveBarUpdate[] } | undefined {
    const time = E2E_NOW + minute * 60;
    const was = this.unstored.get(time);
    if (was === undefined) return undefined;
    this.unstored.delete(time);
    const value = closePrice === undefined ? undefined : scaled(this.instrument, closePrice);
    const bar: Bar =
      value === undefined ? was : { ...was, close: price(value), high: price(Math.max(was.high, value)), low: price(Math.min(was.low, value)) };
    return { bar, updates: this.feed.stored(bar) };
  }
}

export async function startE2EServer(port: number): Promise<FastifyInstance> {
  const minutes = new E2EMinutes();
  const data = new MemoryDataLayer({
    instruments: INSTRUMENTS,
    minutes,
    cooked: new E2ECooked(minutes),
    earliest: barTime(E2E_NOW - HISTORY_DAYS * 86_400),
    nowMs: () => E2E_NOW * 1000,
  });
  const history = new HistoryQuery({ data });
  const live = new LiveGateway({
    data,
    every: (ms, run) => {
      const timer = setInterval(run, ms);
      return () => clearInterval(timer);
    },
  });
  await data.subscribe(live);
  const announcer = data.announcer('e2e');
  const feeds = new Map(INSTRUMENTS.map((i) => [i.symbol, new E2ELive(i)]));

  const app = await buildServer({
    history,
    access: accessFromEnv({ AIA_DEV_AUTH: '1' }),
    live,
    catalog: data,
    indicators: new IndicatorRegistry([settingsDemo]),
    now: () => barTime(E2E_NOW),
    logger: false,
  });

  const body = (request: { body: unknown }) => request.body as { instrument?: string; minute?: number; close?: number };
  app.post('/e2e/trade', async (request, reply) => {
    const { instrument = '', minute = 0, close } = body(request);
    const feed = feeds.get(instrument);
    if (feed === undefined || typeof close !== 'number') return reply.code(400).send({ error: 'instrument and close are required' });
    await announcer.publish(feed.trade(minute, close));
    return { ok: true };
  });
  app.post('/e2e/store', async (request, reply) => {
    const { instrument = '', minute = 0, close } = body(request);
    const feed = feeds.get(instrument);
    const stored = feed?.store(minute, close);
    if (stored === undefined) return reply.code(400).send({ error: 'trade in that minute first' });
    let byTime = minutes.stored.get(instrument);
    if (byTime === undefined) minutes.stored.set(instrument, (byTime = new Map()));
    byTime.set(stored.bar.time, stored.bar);
    await announcer.publish(stored.updates);
    return { ok: true };
  });
  app.addHook('onClose', () => {
    live.stop();
  });

  await app.listen({ port, host: '127.0.0.1' });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env['AIA_PORT'] ?? 8181);
  const app = await startE2EServer(port);
  console.log(`e2e platform on http://127.0.0.1:${port} (made-up bars, AIA_DEV_AUTH)`);
  const shutdown = () => void app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
