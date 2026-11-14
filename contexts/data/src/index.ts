// Public entry of the data layer (M1-16): the only way the rest of the app
// gets bars. Other packages import only from here, never from @aia/hydration
// or @aia/market-data (enforced by eslint.config.mjs).

export type { BarsPage, DataAccess, PageQuery } from './application/data-access.js';
export type { InProcessDataLayerDeps } from './application/in-process-data-layer.js';
export type { LocalDataLayerOptions } from './adapters/local-data-layer.js';
export { openLocalDataLayer } from './adapters/local-data-layer.js';
export type { Announcer, CookedBarsSource, MemoryDataLayerOptions, MinuteBarsSource } from './adapters/memory-data-layer.js';
export { MemoryDataLayer } from './adapters/memory-data-layer.js';
export { SimulatedLiveFeed } from './adapters/simulated-live-feed.js';

// Our types for what the data layer hands out.
export type { LiveBarUpdate, LiveBatch, LiveBarsListener } from '@aia/market-data';
// The instruments the data layer knows.
export { BTCUSD, ETHUSD, NVDA, PARITY_INSTRUMENTS as KNOWN_INSTRUMENTS, TSLA } from '@aia/market-data';
