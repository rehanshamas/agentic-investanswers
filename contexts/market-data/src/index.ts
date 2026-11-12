// Public entry of the market-data context. Other packages import only from here.

export type { CookedBarStorePort } from './application/cooked-bar-store-port.js';
export type { OneMinuteBarSourcePort } from './application/one-minute-bar-source-port.js';
export type { CookIntradayDeps } from './application/cook-intraday.js';
export { CookIntraday, CookIntradayError, INTRADAY_ROLLUPS } from './application/cook-intraday.js';
export { RollUpError, affectedBarTimes, rollUp } from './domain/roll-up.js';
export { CookedStoreError } from './application/cooked-bar-store-port.js';

export type {
  BarDifference,
  BarField,
  ParityComparison,
  ParityStatus,
  ParityWindow,
} from './domain/parity.js';
export { BAR_FIELDS, ParityError, compareBars, parityWindow } from './domain/parity.js';
export { BUILD_SOURCES, buildParity, buildSource } from './domain/build-parity.js';
export type {
  ParityExport,
  ParityExportSourcePort,
  ParityResult,
  RunParityDeps,
} from './application/run-parity.js';
export {
  ParityExportMissingError,
  RunParity,
  RunParityError,
  parityPassed,
} from './application/run-parity.js';
export type { ParityReportOptions } from './adapters/parity-report.js';
export {
  formatDifference,
  formatFidelityReport,
  formatParityReport,
  formatUtc,
} from './adapters/parity-report.js';

export {
  CookedPartitionError,
  partitionBounds,
  partitionOf,
  partitionsBetween,
  storageToken,
  timeframeFromStorageToken,
} from './domain/cooked-partition.js';

export type { S3StoreConfig } from './adapters/s3-objects.js';
export { S3CookedBarStore, cookedKey } from './adapters/s3-cooked-bar-store.js';

export type { LoadOptions, ParityFixture } from './adapters/tradingview-export.js';
export {
  DEFAULT_FIXTURE_DIR,
  FixtureError,
  fixtureFileName,
  listFixtureFiles,
  loadFixture,
  loadFixtures,
  summariseFixtures,
  TradingViewExportSource,
} from './adapters/tradingview-export.js';

export {
  BTCUSD,
  CRYPTO_PARITY_INSTRUMENTS,
  ETHUSD,
  NVDA,
  PARITY_INSTRUMENTS,
  STOCK_PARITY_INSTRUMENTS,
  TSLA,
  parityInstrument,
} from './domain/parity-instruments.js';

export type { RebuildDiff } from './domain/rebuild-diff.js';
export { RebuildDiffError, diffBars, differences } from './domain/rebuild-diff.js';
export type { PartitionResult, RebuildCheckDeps } from './application/rebuild-check.js';
export { RebuildCheck } from './application/rebuild-check.js';
export { formatRebuildReport, rebuildPassed, totalDifferences } from './adapters/rebuild-report.js';
export type { DifferenceLabels } from './adapters/parity-report.js';

export type { BarClosed } from './domain/bar-closed.js';
export { barClosedEvents } from './domain/bar-closed.js';
export type { RecentWindow } from './domain/recent-window.js';
export { RECENT_BARS_CAPACITY, RecentWindowError } from './domain/recent-window.js';
export type { RecentBarsCachePort } from './application/recent-bars-cache-port.js';
export { RecentBarsCacheError } from './application/recent-bars-cache-port.js';
export type { BarsPage, RecentBarsDeps, RecentBarsPageQuery, RecentBarsQuery } from './application/recent-bars.js';
export { RecentBars, RecentBarsError } from './application/recent-bars.js';
export { MemoryRecentBarsCache } from './adapters/memory-recent-bars-cache.js';
export type { RedisCacheOptions } from './adapters/redis-recent-bars-cache.js';
export { RedisRecentBarsCache } from './adapters/redis-recent-bars-cache.js';

export { whyNotServed } from './domain/served.js';
export type {
  HistoryBar,
  HistoryError,
  HistoryErrorCode,
  HistoryQueryDeps,
  HistoryRequest,
  HistoryResponse,
} from './application/history-query.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, HistoryQuery } from './application/history-query.js';

// The live gateway (M2-04).
export type { DisplayBar } from './domain/display-bar.js';
export { displayBar } from './domain/display-bar.js';
export type { LiveBarUpdate, LiveBatch } from './domain/live-update.js';
export { storedUpdates } from './domain/live-update.js';
export { FormingBars } from './domain/forming-bars.js';
export type { LiveBarsBusPort, LiveBarsListener } from './application/live-bars-bus-port.js';
export { LiveBarsBusError } from './application/live-bars-bus-port.js';
export { LiveAnnouncer } from './application/live-announcer.js';
export type {
  LiveClientMessage,
  LiveErrorCode,
  LiveServerMessage,
  LiveWireUpdate,
} from './application/live-protocol.js';
export { LIVE_MAX_CLIENT_MESSAGE, parseClientMessage } from './application/live-protocol.js';
export type { Authorize, LiveGatewayDeps, LiveGatewayOptions, LiveSocket } from './application/live-gateway.js';
export { LIVE_CLOSE_TOO_SLOW, LiveGateway, LiveSession } from './application/live-gateway.js';
export { MemoryLiveBarsBus } from './adapters/memory-live-bars-bus.js';
export type { RedisLiveBarsBusOptions } from './adapters/redis-live-bars-bus.js';
export { LIVE_BARS_CHANNEL, RedisLiveBarsBus } from './adapters/redis-live-bars-bus.js';

// Settled cooked bars plus the tail (M1-15).
export { tailStart } from './domain/cooked-tail.js';
export type { CookedWatermarkPort } from './application/cooked-watermark-port.js';
export type { CookedReaderDeps } from './application/cooked-reader.js';
export { CookedReader } from './application/cooked-reader.js';
export type { LiveCookDeps } from './application/live-cook.js';
export { LiveCook } from './application/live-cook.js';
export type { CookedCompactorDeps } from './application/cooked-compactor.js';
export { CookedCompactor } from './application/cooked-compactor.js';
export { MemoryCookedWatermarks } from './adapters/memory-cooked-watermarks.js';
export { cookedWatermarkKey } from './adapters/s3-cooked-bar-store.js';
