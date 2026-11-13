// The port the engine caches runs through (M3-04). Adapters: Redis
// (ElastiCache in staging; docker-compose.yml locally) and memory for tests.
//
// Values are opaque text; the engine owns their format. The cache may lose any
// entry at any time: the engine then recomputes and gets the same answer.

export interface IndicatorOutputCachePort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}
