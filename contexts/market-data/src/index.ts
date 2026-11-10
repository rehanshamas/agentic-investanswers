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
