// `pnpm live`: stream trades, write each closed 1-minute bar to raw as its
// minute ends, and cook the intraday timeframes it touches (M1-05).
//
// Composition only: LiveStream and the adapters live in @aia/hydration,
// CookIntraday in @aia/market-data. Which provider streams each instrument
// comes from the feed plan, config/feeds.json (CLAUDE.md rule 7); if the plan
// switches an instrument's live provider at a UTC midnight, the stream is
// restarted on the new one.
//
//   pnpm live                                   every instrument with a live feed today
//   pnpm live --symbol BTCUSD
//   pnpm live --record rec.jsonl                also save every raw message, for replay
//
// Runs until stopped (Ctrl-C); minutes not yet closed are not written. Exits 2
// on a setup error.

import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import type { LiveEvent, RawDayRef, Scheduler } from '@aia/hydration';
import { FeedPlanError, FeedSetupError, LiveStream, feedsFor, liveSourceOn } from '@aia/hydration';
import { CookIntraday, PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Bar, Instrument } from '@aia/shared-kernel';
import { formatScaled, nyseCalendar, rawPriceScale, rawVolumeScale, zonedDateKey } from '@aia/shared-kernel';

import { feedAdapters, liveProviderOf, loadFeedPlan, rawProviderOf } from './feeds.js';
import { RawMinuteSource } from './raw-minute-source.js';
import { localStores } from './stores.js';

const USAGE = 'Usage: pnpm live [--symbol S]... [--record FILE]';

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

const realTime: Scheduler = {
  now: () => Date.now(),
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

const today = (): string => new Date().toISOString().slice(0, 10);
const hhmm = (time: number): string => new Date(time * 1000).toISOString().slice(11, 16);

function describe(instrument: Instrument, bar: Bar): string {
  const p = (value: number) => formatScaled(value, rawPriceScale(instrument));
  return (
    `O ${p(bar.open)} H ${p(bar.high)} L ${p(bar.low)} C ${p(bar.close)} ` +
    `V ${formatScaled(bar.volume, rawVolumeScale(instrument))}`
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { symbol: { type: 'string', multiple: true }, record: { type: 'string' } } });
  let plan;
  try {
    plan = loadFeedPlan();
  } catch (error) {
    if (error instanceof FeedPlanError || error instanceof FeedSetupError) usage(error.message);
    throw error;
  }
  const feedPlan = plan;
  const asked = (values.symbol ?? []).map((symbol) => parityInstrument(symbol) ?? usage(`Unknown symbol: ${symbol}`));
  const candidates = asked.length > 0 ? asked : PARITY_INSTRUMENTS.filter((i) => feedPlan.instruments.some((f) => f.symbol === i.symbol));
  const liveToday = (instrument: Instrument) => liveSourceOn(feedsFor(feedPlan, instrument.symbol), today())?.provider;
  const instruments = candidates.filter((i) => liveToday(i) !== undefined);
  for (const i of candidates) if (liveToday(i) === undefined) console.log(`${i.symbol}: no live feed in the feed plan today, skipped`);
  if (instruments.length === 0) usage('Nothing to stream.');

  let adapters;
  try {
    adapters = feedAdapters(feedPlan, instruments.map((i) => i.symbol));
  } catch (error) {
    if (error instanceof FeedPlanError || error instanceof FeedSetupError) usage(error.message);
    throw error;
  }
  const feeds = adapters;
  const stores = localStores(feedPlan);
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));

  // Today's live minutes, held in memory once read, so cooking each new minute
  // does not list the day's objects again. Seeded from the store on first use.
  const liveCache = new Map<string, Promise<Bar[]>>();
  const cacheKey = (ref: RawDayRef) => `${ref.provider}/${ref.symbol}/${ref.date}`;
  const cachedRaw = {
    getDay: (ref: RawDayRef) => stores.raw.getDay(ref),
    getLiveMinutes: (ref: RawDayRef) => {
      const key = cacheKey(ref);
      let minutes = liveCache.get(key);
      if (minutes === undefined) {
        minutes = stores.raw.getLiveMinutes(ref);
        liveCache.set(key, minutes);
      }
      return minutes;
    },
  };
  const cook = new CookIntraday({
    source: new RawMinuteSource(cachedRaw, rawProviderOf(feedPlan), liveProviderOf(feedPlan)),
    store: stores.cooked,
    calendar: nyseCalendar(),
  });
  const cooking = new Map<string, Promise<void>>();

  const record = values.record;
  const onEvent = (provider: string) => (event: LiveEvent) => {
    const stamp = new Date().toISOString().slice(11, 19);
    switch (event.kind) {
      case 'connected':
        console.log(`${stamp} ${provider}: connected`);
        return;
      case 'disconnected':
        console.log(`${stamp} ${provider}: disconnected (${event.reason}); retrying in ${(event.retryInMs / 1000).toFixed(1)} s`);
        return;
      case 'gap':
        console.log(`${stamp} ${event.symbol}: gap recorded ${hhmm(event.gap.from)} to ${hhmm(event.gap.until)} (gap repair fills it once the day is backfilled)`);
        return;
      case 'late':
        console.log(`${stamp} ${event.symbol}: a trade arrived after its minute closed; dropped`);
        return;
      case 'write-failed':
        console.log(`${stamp} ${event.symbol}: FAILED to store ${event.what}: ${event.error}`);
        return;
      case 'minute': {
        const instrument = bySymbol.get(event.symbol);
        if (instrument === undefined) return;
        const ref = { provider, symbol: event.symbol, date: zonedDateKey(event.bar.time, 'UTC') };
        void cachedRaw.getLiveMinutes(ref).then((minutes) => {
          if (!minutes.some((b) => b.time === event.bar.time)) minutes.push(event.bar);
        });
        console.log(`${stamp} ${event.symbol} ${hhmm(event.bar.time)} ${describe(instrument, event.bar)}`);
        // Stocks are not cooked until M1-08; none streams yet anyway (OI-28).
        if (instrument.kind === 'stock') return;
        const previous = cooking.get(event.symbol) ?? Promise.resolve();
        cooking.set(
          event.symbol,
          previous
            .then(() => cachedRaw.getLiveMinutes(ref))
            .then(() => cook.applyNewMinutesToAll(instrument, [event.bar]))
            .then(
              () => undefined,
              (error: unknown) => console.log(`${stamp} ${event.symbol}: cooking failed: ${String(error)}`),
            ),
        );
        return;
      }
    }
  };

  // One stream per live provider in effect today; rebuilt if the plan's
  // answer changes, which happens only at a UTC midnight.
  let running: Array<{ provider: string; stream: LiveStream }> = [];
  let layout = '';
  const start = (): void => {
    const groups = new Map<string, Instrument[]>();
    for (const instrument of instruments) {
      const provider = liveToday(instrument);
      if (provider !== undefined) groups.set(provider, [...(groups.get(provider) ?? []), instrument]);
    }
    layout = JSON.stringify([...groups].map(([p, list]) => [p, list.map((i) => i.symbol)]));
    running = [...groups].map(([provider, list]) => {
      const feed = feeds.liveFeed(provider, {
        ...(record === undefined ? {} : { record: (m: string, t: number) => appendFileSync(record, JSON.stringify({ t, m }) + '\n') }),
      });
      console.log(`Streaming ${list.map((i) => i.symbol).join(', ')} from ${provider} into ${stores.endpoint}`);
      const stream = new LiveStream({ feed, store: stores.raw, scheduler: realTime, onEvent: onEvent(provider) }, list);
      stream.start();
      return { provider, stream };
    });
  };
  start();

  const checkPlan = setInterval(() => {
    const groups = new Map<string, string[]>();
    for (const instrument of instruments) {
      const provider = liveToday(instrument);
      if (provider !== undefined) groups.set(provider, [...(groups.get(provider) ?? []), instrument.symbol]);
    }
    if (JSON.stringify([...groups]) === layout) return;
    console.log('The feed plan changes live providers today; restarting the streams.');
    const old = running;
    running = [];
    void Promise.all(old.map(({ stream }) => stream.stop())).then(start);
  }, 60_000);

  const shutdown = (): void => {
    clearInterval(checkPlan);
    console.log('Stopping; minutes not yet closed are not written.');
    void Promise.all(running.map(({ stream }) => stream.stop()))
      .then(() => Promise.all(cooking.values()))
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main().catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
