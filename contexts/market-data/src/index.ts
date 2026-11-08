// Public entry of the market-data context. Other packages import only from here.

export type { CookedBarStorePort } from './application/cooked-bar-store-port.js';
export type { OneMinuteBarSourcePort } from './application/one-minute-bar-source-port.js';
export type { CookIntradayDeps } from './application/cook-intraday.js';
export { CookIntraday, CookIntradayError, INTRADAY_ROLLUPS } from './application/cook-intraday.js';
export { RollUpError, affectedBarTimes, rollUp } from './domain/roll-up.js';
export { CookedStoreError } from './application/cooked-bar-store-port.js';

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
