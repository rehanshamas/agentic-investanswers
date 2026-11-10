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
