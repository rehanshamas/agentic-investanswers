// Public entry of the market-data context. Other packages import only from here.

export type { CookedBarStorePort } from './application/cooked-bar-store-port.js';
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
