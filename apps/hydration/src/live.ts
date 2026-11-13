// `pnpm live`: stream trades, write each closed 1-minute bar to raw as its
// minute ends, and cook the intraday timeframes it touches (M1-05).
//
// Composition only: LiveStream and the adapters live in @aia/hydration,
// CookIntraday and RecentBars in @aia/market-data. After each minute is cooked,
// its BarClosed events update the recent-bars cache in Redis (M2-02), so the
// cache only changes once the store has (AIA_REDIS_URL, default the local one).
// Live updates for charts go out on the same Redis (M2-04): forming bars as
// trades arrive, and each minute's stored bars once the cache has them, never
// before. Anything that may leave charts differing from the store (a dropped
// stream, a failed write, cooking or cache update) announces a resync. Which provider streams each instrument
// comes from the feed plan, config/feeds.json (CLAUDE.md rule 7); if the plan
// switches an instrument's live provider at a UTC midnight, the stream is
// restarted on the new one.
//
//   pnpm live                                   every instrument with a live feed today
//   pnpm live --symbol BTCUSD
//   pnpm live --record rec.jsonl                also save every raw message, for replay
//   pnpm live --shard 2/8                       only the instruments of shard 2 of 8 (M1-15c)
//
// Shards split instruments across processes, each instrument in exactly one
// (a feed plan pin, `"shard": n`, or a stable hash of its symbol), so each has
// one writer. Run every shard i/n with the same n, and restart them together
// when n changes.
//
// Runs until stopped (Ctrl-C); minutes not yet closed are not written. Exits 2
// on a setup error, including Redis being unreachable at start.

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import type { LiveEvent, Scheduler } from '@aia/hydration';
import {
  ALL_IN_ONE,
  FeedPlanError,
  FeedSetupError,
  LiveStream,
  feedsFor,
  inShard,
  liveProviderOf,
  liveSourceOn,
  loadFeedPlan,
  parseShard,
  rawProviderOf,
} from '@aia/hydration';
import { PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Bar, Instrument } from '@aia/shared-kernel';
import { formatScaled, nyseCalendar, rawPriceScale, rawVolumeScale } from '@aia/shared-kernel';

import { connectCache, connectLiveBus } from './cache.js';
import { feedAdapters } from './feeds.js';
import { LivePipeline } from './live-pipeline.js';
import { localStores } from './stores.js';

const USAGE = 'Usage: pnpm live [--symbol S]... [--record FILE] [--shard I/N]';

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
  const { values } = parseArgs({
    options: { symbol: { type: 'string', multiple: true }, record: { type: 'string' }, shard: { type: 'string' } },
  });
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
  let shard = ALL_IN_ONE;
  let mine: (i: Instrument) => boolean;
  try {
    if (values.shard !== undefined) shard = parseShard(values.shard);
    const theShard = shard;
    // Checked for every instrument now, so a bad pin stops the start rather than dropping one.
    const homes = new Map(candidates.map((i) => [i.symbol, inShard(feedsFor(feedPlan, i.symbol), theShard)]));
    mine = (i) => homes.get(i.symbol) === true;
  } catch (error) {
    if (error instanceof FeedPlanError) usage(error.message);
    throw error;
  }
  if (shard.count > 1) {
    const elsewhere = candidates.filter((i) => !mine(i)).map((i) => i.symbol);
    console.log(`Shard ${shard.index}/${shard.count}${elsewhere.length > 0 ? `; other shards stream ${elsewhere.join(', ')}` : ''}`);
  }
  const instruments = candidates.filter((i) => mine(i) && liveToday(i) !== undefined);
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

  let cache;
  try {
    cache = await connectCache({
      reconnect: 'forever',
      onError: (error) => console.log(`${new Date().toISOString().slice(11, 19)} redis: ${error.message}`),
    });
  } catch (error) {
    usage(`Redis is unreachable (${String(error)}); the recent-bars cache must follow every minute. Run: docker compose up -d`);
  }
  const redis = cache;

  // Live updates for charts (M2-04). One announcer, so announcements keep the
  // order they were made in; a restart is a new publisher, which charts resync on.
  let bus;
  try {
    bus = await connectLiveBus({ onError: (error) => console.log(`${new Date().toISOString().slice(11, 19)} redis (live bus): ${error.message}`) });
  } catch (error) {
    usage(`Redis is unreachable (${String(error)}); live updates for charts go through it. Run: docker compose up -d`);
  }
  const liveBus = bus;
  const pipeline = new LivePipeline({
    instruments,
    raw: stores.raw,
    rawProviderOf: rawProviderOf(feedPlan),
    liveProviderOf: liveProviderOf(feedPlan),
    cooked: stores.cooked,
    watermarks: stores.cooked,
    hours: stores.raw,
    cache: redis,
    bus: liveBus,
    publisher: `live-${shard.index}of${shard.count}-${randomUUID()}`,
    calendar: nyseCalendar(),
    log: (line) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`),
    nowMs: () => Date.now(),
  });

  const record = values.record;
  const onEvent = (provider: string) => (event: LiveEvent) => {
    const stamp = new Date().toISOString().slice(11, 19);
    switch (event.kind) {
      case 'connected':
        console.log(`${stamp} ${provider}: connected`);
        return;
      case 'disconnected':
        console.log(`${stamp} ${provider}: disconnected (${event.reason}); retrying in ${(event.retryInMs / 1000).toFixed(1)} s`);
        pipeline.disconnected(
          instruments.filter((i) => liveToday(i) === provider).map((i) => i.symbol),
          `${provider} disconnected`,
        );
        return;
      case 'gap':
        console.log(`${stamp} ${event.symbol}: gap recorded ${hhmm(event.gap.from)} to ${hhmm(event.gap.until)} (gap repair fills it once the day is backfilled)`);
        return;
      case 'late':
        console.log(`${stamp} ${event.symbol}: a trade arrived after its minute closed; dropped`);
        return;
      case 'write-failed':
        console.log(`${stamp} ${event.symbol}: FAILED to store ${event.what}: ${event.error}`);
        pipeline.writeFailed(event.symbol);
        return;
      case 'forming':
        pipeline.formingChanged(event.symbol, event.bars);
        return;
      case 'minute': {
        const instrument = bySymbol.get(event.symbol);
        if (instrument === undefined) return;
        console.log(`${stamp} ${event.symbol} ${hhmm(event.bar.time)} ${describe(instrument, event.bar)}`);
        void pipeline.minute(provider, event.symbol, event.bar);
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
      .then(() => pipeline.settled())
      .then(() => redis.close())
      .then(() => liveBus.close())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

await main().catch((error: unknown) => {
  console.error(`${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
});
