// The indicator engine (M3-04): runs indicators on the server, caches each run
// by indicator + version + instrument + timeframe + settings, and extends a
// cached run by the bars that closed since, instead of recomputing.
//
// What leaves: drawn points only (declared outputs at display precision,
// CLAUDE.md rule 5). Indicator state stays in the cache, which only the engine
// reads.
//
// A cache entry holds the state after the last closed bar it saw, that bar
// itself, and the newest drawn points. On a request:
// 1. read the newest closed bar, which fixes where the run starts (run-window.ts);
// 2. on a hit, read the bars from the entry's last bar onwards. If that bar is
//    unchanged in the store, commit only the newer bars (usually none or one);
//    if it changed (a re-cook), recompute;
// 3. on a miss, run from the start;
// 4. the forming bar, if the caller passes one, is previewed from the closed
//    state and never cached.

import type { Bar, Instrument, Timeframe } from '@aia/shared-kernel';

import type { IndicatorDefinition } from '../domain/indicator-definition.js';
import { assertValidDefinition } from '../domain/indicator-definition.js';
import type { DrawnPoint } from '../domain/outputs.js';
import { RUN_WINDOW_BARS, runStart } from '../domain/run-window.js';
import type { SettingError } from '../domain/settings.js';
import { checkSettings, settingsKey } from '../domain/settings.js';
import { decodeState, encodeState } from '../domain/state-codec.js';
import type { IndicatorRun } from '../domain/stepping.js';
import { commit, preview, startRun } from '../domain/stepping.js';
import type { IndicatorBarSourcePort } from './indicator-bar-source-port.js';
import type { IndicatorOutputCachePort } from './indicator-output-cache-port.js';

/** Drawn points kept per cache entry, and the most one request returns. */
export const ENGINE_MAX_POINTS = 2_000;
/** Cache entries expire if nobody asks for them for this long. */
export const ENGINE_CACHE_TTL_SECONDS = 7 * 86_400;
/** Bump when the entry format changes, so old entries are ignored. */
const ENTRY_FORMAT = 1;

export class IndicatorRegistryError extends Error {}

/** The indicators the engine can run, each checked when registered. */
export class IndicatorRegistry {
  private readonly byId = new Map<string, IndicatorDefinition<unknown>>();

  constructor(definitions: readonly IndicatorDefinition<unknown>[]) {
    for (const definition of definitions) {
      assertValidDefinition(definition);
      if (this.byId.has(definition.id)) throw new IndicatorRegistryError(`Indicator "${definition.id}" is registered twice`);
      this.byId.set(definition.id, definition);
    }
  }

  get(id: string): IndicatorDefinition<unknown> | undefined {
    return this.byId.get(id);
  }

  list(): readonly IndicatorDefinition<unknown>[] {
    return [...this.byId.values()];
  }
}

export interface IndicatorRequest {
  readonly indicatorId: string;
  readonly instrument: Instrument;
  readonly timeframe: Timeframe;
  /** Untrusted; checked against the declared inputs. Missing keys take their default. */
  readonly settings?: unknown;
  /** Newest closed points to return; at most ENGINE_MAX_POINTS. Defaults to 500. */
  readonly limit?: number;
  /** The bar still forming, if the chart has one; previewed, never cached. */
  readonly forming?: Bar;
}

export type IndicatorResult =
  | {
      readonly ok: true;
      /** Closed bars' drawn points, oldest first. */
      readonly points: readonly DrawnPoint[];
      /** The forming bar's drawn point, if one was passed and it is newer than the last closed bar. */
      readonly forming?: DrawnPoint;
    }
  | { readonly ok: false; readonly code: 'unknown_indicator'; readonly message: string }
  | { readonly ok: false; readonly code: 'invalid_settings'; readonly errors: readonly SettingError[] };

interface CacheEntry {
  readonly format: number;
  readonly lastBar: Bar;
  readonly state: string;
  readonly points: readonly DrawnPoint[];
}

/** Counters for tests and for the latency probe; not part of any response. */
export interface EngineStats {
  /** Bars stepped through an indicator, closed or forming. */
  steps: number;
  hits: number;
  misses: number;
  /** Hits whose last bar had changed in the store, so the run was recomputed. */
  stale: number;
  /** Cache reads or writes that failed, or entries that could not be read; each treated as a miss. */
  cacheErrors: number;
}

export interface IndicatorEngineDeps {
  readonly registry: IndicatorRegistry;
  readonly bars: IndicatorBarSourcePort;
  readonly cache: IndicatorOutputCachePort;
  /** Bars per run-window block; tests make it small. */
  readonly windowBars?: number;
  /** Told when the cache fails; the engine carries on without it. */
  readonly onCacheError?: (error: unknown) => void;
}

function sameBar(a: Bar, b: Bar): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

interface Progress {
  readonly run: IndicatorRun<unknown>;
  readonly points: DrawnPoint[];
  /** The last closed bar committed, as stored; kept in the entry to spot a re-cook. */
  readonly lastBar: Bar | undefined;
}

export class IndicatorEngine {
  readonly stats: EngineStats = { steps: 0, hits: 0, misses: 0, stale: 0, cacheErrors: 0 };
  private readonly windowBars: number;

  constructor(private readonly deps: IndicatorEngineDeps) {
    this.windowBars = deps.windowBars ?? RUN_WINDOW_BARS;
  }

  async drawn(request: IndicatorRequest): Promise<IndicatorResult> {
    const definition = this.deps.registry.get(request.indicatorId);
    if (definition === undefined) {
      return { ok: false, code: 'unknown_indicator', message: `There is no indicator "${request.indicatorId}"` };
    }
    const checked = checkSettings(definition.inputs, request.settings);
    if (!checked.ok) return { ok: false, code: 'invalid_settings', errors: checked.errors };
    const asked = request.limit ?? 500;
    const limit = Number.isFinite(asked) ? Math.min(Math.max(1, Math.floor(asked)), ENGINE_MAX_POINTS) : 500;

    const { instrument, timeframe } = request;
    const fresh = startRun(definition, checked.settings, instrument);
    let progress: Progress = { run: fresh, points: [], lastBar: undefined };

    const [newest] = await this.deps.bars.closedBars(instrument, timeframe, { limit: 1 });
    if (newest !== undefined) {
      const start = runStart(timeframe, newest.time, this.windowBars);
      const key = [
        'ind',
        definition.id,
        definition.version,
        instrument.symbol,
        timeframe,
        String(start),
        settingsKey(definition.inputs, checked.settings),
      ].join('|');
      const resumed = await this.resume(key, fresh, instrument, timeframe);
      if (resumed !== undefined) {
        progress = resumed.progress;
        if (resumed.extended) await this.store(key, progress);
      } else {
        const bars = await this.deps.bars.closedBars(instrument, timeframe, { from: start, limit: this.maxBars() });
        progress = this.commitAll(progress, bars);
        await this.store(key, progress);
      }
    }

    const { run, points } = progress;
    const forming =
      request.forming !== undefined && (run.lastTime === undefined || request.forming.time > run.lastTime)
        ? this.preview(run, request.forming)
        : undefined;
    return forming === undefined
      ? { ok: true, points: points.slice(-limit) }
      : { ok: true, points: points.slice(-limit), forming };
  }

  /** Most bars one run reads: two blocks, plus the bar it resumes from. */
  private maxBars(): number {
    return 2 * this.windowBars + 1;
  }

  private preview(run: IndicatorRun<unknown>, forming: Bar): DrawnPoint {
    this.stats.steps += 1;
    return preview(run, forming);
  }

  /** Continue a cached run, or undefined if there is none or its last bar changed in the store. */
  private async resume(
    key: string,
    fresh: IndicatorRun<unknown>,
    instrument: Instrument,
    timeframe: Timeframe,
  ): Promise<{ progress: Progress; extended: boolean } | undefined> {
    const entry = await this.readEntry(key);
    if (entry === undefined || entry.format !== ENTRY_FORMAT) {
      this.stats.misses += 1;
      return undefined;
    }
    const bars = await this.deps.bars.closedBars(instrument, timeframe, { from: entry.lastBar.time, limit: this.maxBars() });
    const [first, ...newer] = bars;
    if (first === undefined || !sameBar(first, entry.lastBar)) {
      this.stats.stale += 1;
      return undefined;
    }
    this.stats.hits += 1;
    let state: unknown;
    try {
      state = decodeState(entry.state);
    } catch (error) {
      this.cacheFailed(error);
      return undefined;
    }
    const run: IndicatorRun<unknown> = { ...fresh, state, lastTime: entry.lastBar.time };
    const progress = this.commitAll({ run, points: [...entry.points], lastBar: entry.lastBar }, newer);
    return { progress, extended: newer.length > 0 };
  }

  /**
   * The cached entry, or undefined on a miss. The cache is an optimisation:
   * if Redis is down or an entry is corrupt, the engine recomputes rather
   * than fail the request (as /bars falls back to the store).
   */
  private async readEntry(key: string): Promise<CacheEntry | undefined> {
    try {
      const text = await this.deps.cache.get(key);
      return text === undefined ? undefined : (JSON.parse(text) as CacheEntry);
    } catch (error) {
      this.cacheFailed(error);
      return undefined;
    }
  }

  private cacheFailed(error: unknown): void {
    this.stats.cacheErrors += 1;
    this.deps.onCacheError?.(error);
  }

  private commitAll(progress: Progress, bars: readonly Bar[]): Progress {
    let { run, lastBar } = progress;
    const points = progress.points;
    for (const bar of bars) {
      const next = commit(run, bar);
      this.stats.steps += 1;
      run = next.run;
      lastBar = bar;
      points.push(next.point);
    }
    return { run, lastBar, points: points.length > ENGINE_MAX_POINTS ? points.slice(-ENGINE_MAX_POINTS) : points };
  }

  private async store(key: string, progress: Progress): Promise<void> {
    if (progress.lastBar === undefined) return;
    const entry: CacheEntry = {
      format: ENTRY_FORMAT,
      lastBar: progress.lastBar,
      state: encodeState(progress.run.state),
      points: progress.points,
    };
    try {
      await this.deps.cache.set(key, JSON.stringify(entry), ENGINE_CACHE_TTL_SECONDS);
    } catch (error) {
      // Best effort: the answer is already computed; the next request recomputes.
      this.cacheFailed(error);
    }
  }
}
