// Public entry of the hydration context. Other packages import only from here.

export type { RawBarStorePort, RawDayRef } from './application/raw-bar-store-port.js';
export { RawDayAlreadyStoredError, RawStoreError } from './application/raw-bar-store-port.js';

export { RawDayError, assertStorableRawDay, dayEnd, dayStart } from './domain/raw-day.js';

export type { S3StoreConfig } from './adapters/s3-objects.js';
export { S3RawBarStore, rawDayKey } from './adapters/s3-raw-bar-store.js';

export type { HistoryProviderPort } from './application/history-provider-port.js';
export type {
  BackfillDeps,
  BackfillRange,
  BackfillReport,
  DayOutcome,
} from './application/backfill.js';
export { Backfill } from './application/backfill.js';
export {
  BackfillDaysError,
  DEFAULT_SETTLE_SECONDS,
  backfillDays,
  lastCompleteDay,
} from './domain/backfill-days.js';

export type { CoinbaseCandlesOptions } from './adapters/coinbase/coinbase-candles.js';
export {
  COINBASE_BASE_URL,
  CoinbaseCandles,
  CoinbaseError,
  coinbaseProduct,
  parseCandles,
} from './adapters/coinbase/coinbase-candles.js';

export type { MassiveAggregatesOptions } from './adapters/massive/massive-aggregates.js';
export {
  MASSIVE_BASE_URL,
  MASSIVE_DAYS_PER_REQUEST,
  MassiveAggregates,
  MassiveError,
  parseAggregates,
} from './adapters/massive/massive-aggregates.js';

export type { GapDay, GapRange, GapRepairDeps, GapReport } from './application/gap-repair.js';
export { GapRepair } from './application/gap-repair.js';
export { expectedSpan, findHoles, holeRuns } from './domain/gaps.js';
export { assertStorableFill, mergeDay } from './domain/raw-day.js';
export { rawFillKey } from './adapters/s3-raw-bar-store.js';

// Feed independence (CLAUDE.md rule 7): the plan says which provider serves
// what, and the registry is the only place a provider name becomes an adapter.
export type {
  FeedPlan,
  FeedSource,
  HistorySegment,
  HistorySource,
  InstrumentFeeds,
} from './domain/feed-plan.js';
export {
  FeedPlanError,
  feedsFor,
  historySegments,
  historySourceOn,
  historyStart,
  liveSourceOn,
  parseFeedPlan,
} from './domain/feed-plan.js';
export type { AdapterEntry, Env } from './adapters/registry.js';
export { ADAPTERS, FeedAdapters, FeedSetupError } from './adapters/registry.js';

// The live stream (M1-05).
export type { LiveGap, LiveTrade, TradeOutcome } from './domain/live-minutes.js';
export { LiveMinutesError, MinuteBuilder, minuteOf, splitGapByDay } from './domain/live-minutes.js';
export type { LiveConnection, LiveFeedOptions, LiveSink, LiveTradesPort } from './application/live-trades-port.js';
export type { LiveRawStorePort } from './application/live-raw-store-port.js';
export { LiveMinuteAlreadyStoredError } from './application/live-raw-store-port.js';
export type { Cancel, LiveEvent, LiveStreamDeps, LiveStreamOptions, Scheduler } from './application/live-stream.js';
export { LiveStream } from './application/live-stream.js';
export type { CoinbaseMessage, CoinbaseTradesOptions, SocketLike } from './adapters/coinbase/coinbase-trades.js';
export { COINBASE_FEED_URL, CoinbaseTrades, parseFeedMessage } from './adapters/coinbase/coinbase-trades.js';
export { rawLiveGapKey, rawLiveMinuteKey } from './adapters/s3-raw-bar-store.js';

export type { ProviderOf } from './application/raw-minute-source.js';
export { RawMinuteSource, liveProviderOf, rawProviderOf } from './application/raw-minute-source.js';
export { loadFeedPlan } from './adapters/feed-plan-file.js';

// Hour files for live minutes (M1-15b).
export type { LiveHourStorePort } from './application/live-hour-store-port.js';
export type { SealOutcome } from './application/live-hour-sealer.js';
export { LiveHourSealer } from './application/live-hour-sealer.js';
export { rawLiveHourKey } from './adapters/s3-raw-bar-store.js';

// Live shards (M1-15c).
export type { Shard } from './domain/shards.js';
export { ALL_IN_ONE, inShard, parseShard, shardOf } from './domain/shards.js';
