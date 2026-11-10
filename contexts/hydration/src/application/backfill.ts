// Backfill 1-minute history into the write-once raw store, one UTC day at a
// time, so a re-run or a resumed run never writes anything twice.
//
// What makes it idempotent and resumable is the store, not bookkeeping: a day
// already stored is skipped, and losing a race to another writer is a skip
// too. There is no progress file to get out of step with the data.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';

import { DEFAULT_SETTLE_SECONDS, backfillDays } from '../domain/backfill-days.js';
import { assertStorableRawDay } from '../domain/raw-day.js';
import type { HistoryProviderPort } from './history-provider-port.js';
import type { RawBarStorePort } from './raw-bar-store-port.js';
import { RawDayAlreadyStoredError } from './raw-bar-store-port.js';

export type DayOutcome =
  | { readonly date: string; readonly kind: 'stored'; readonly bars: number }
  | { readonly date: string; readonly kind: 'skipped' }
  | { readonly date: string; readonly kind: 'empty' }
  | { readonly date: string; readonly kind: 'failed'; readonly error: string };

export interface BackfillReport {
  readonly symbol: string;
  readonly provider: string;
  readonly planned: number;
  readonly stored: number;
  /** Already in the raw store, from an earlier run or another writer. */
  readonly skipped: number;
  /** The provider returned no bars; not stored, so a later run retries. */
  readonly empty: number;
  readonly failed: ReadonlyArray<{ readonly date: string; readonly error: string }>;
  readonly bars: number;
  /** True when the run stopped early after repeated failures. */
  readonly aborted: boolean;
}

export interface BackfillDeps {
  readonly provider: HistoryProviderPort;
  readonly raw: Pick<RawBarStorePort, 'hasDay' | 'putDay'>;
  /** Called once per day, for progress output. */
  readonly onDay?: (instrument: Instrument, outcome: DayOutcome) => void;
  /** Stop after this many failed days in a row: the provider is likely down. */
  readonly maxConsecutiveFailures?: number;
}

export interface BackfillRange {
  readonly from: string;
  readonly until?: string | undefined;
  readonly now: BarTime;
  readonly settleSeconds?: number;
}

export class Backfill {
  constructor(private readonly deps: BackfillDeps) {}

  async run(instrument: Instrument, range: BackfillRange): Promise<BackfillReport> {
    const provider = this.deps.provider.name;
    const days = backfillDays(
      range.from,
      range.until,
      range.now,
      range.settleSeconds ?? DEFAULT_SETTLE_SECONDS,
    );
    const limit = this.deps.maxConsecutiveFailures ?? 3;

    let stored = 0;
    let skipped = 0;
    let empty = 0;
    let bars = 0;
    let consecutiveFailures = 0;
    let aborted = false;
    const failed: Array<{ date: string; error: string }> = [];

    /** Count one day's outcome; true when the run should stop. */
    const tally = (outcome: DayOutcome): boolean => {
      this.deps.onDay?.(instrument, outcome);
      switch (outcome.kind) {
        case 'stored':
          stored++;
          bars += outcome.bars;
          break;
        case 'skipped':
          skipped++;
          break;
        case 'empty':
          empty++;
          break;
        case 'failed':
          failed.push({ date: outcome.date, error: outcome.error });
          break;
      }
      consecutiveFailures = outcome.kind === 'failed' ? consecutiveFailures + 1 : 0;
      return consecutiveFailures >= limit;
    };

    // Days are reported in date order. Those still to fetch are gathered into
    // batches of the provider's `daysPerRequest` (1 unless it has `fetchDays`),
    // so a slow-rate provider makes one request per batch, not per day.
    const { fetchDays, daysPerRequest } = this.deps.provider;
    const batchSize = fetchDays === undefined ? 1 : Math.max(1, daysPerRequest ?? 1);
    let queued: string[] = [];
    let pending: string[] = [];
    const flush = async (): Promise<boolean> => {
      const fetched = await this.fetch(instrument, pending);
      const toFetch = new Set(pending);
      for (const date of queued) {
        const outcome = toFetch.has(date)
          ? await this.store(instrument, provider, date, fetched.get(date))
          : ({ date, kind: 'skipped' } as const);
        if (tally(outcome)) return true;
      }
      queued = [];
      pending = [];
      return false;
    };

    for (const date of days) {
      queued.push(date);
      if (!(await this.deps.raw.hasDay({ provider, symbol: instrument.symbol, date }))) {
        pending.push(date);
      }
      if (pending.length >= batchSize && (await flush())) {
        aborted = true;
        break;
      }
    }
    if (!aborted && queued.length > 0) aborted = await flush();

    return {
      symbol: instrument.symbol,
      provider,
      planned: days.length,
      stored,
      skipped,
      empty,
      failed,
      bars,
      aborted,
    };
  }

  /** Fetch the given days: each maps to its bars, or to the error that failed it. */
  private async fetch(instrument: Instrument, dates: readonly string[]): Promise<Map<string, Bar[] | Error>> {
    const result = new Map<string, Bar[] | Error>();
    if (dates.length === 0) return result;
    const { provider } = this.deps;
    const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));
    if (provider.fetchDays !== undefined && dates.length > 1) {
      try {
        const fetched = await provider.fetchDays(instrument, dates);
        for (const date of dates) result.set(date, fetched.get(date) ?? []);
      } catch (error) {
        for (const date of dates) result.set(date, asError(error));
      }
      return result;
    }
    for (const date of dates) {
      try {
        result.set(date, await provider.fetchDay(instrument, date));
      } catch (error) {
        result.set(date, asError(error));
      }
    }
    return result;
  }

  /**
   * Store one fetched day. The whole day is in memory before anything is
   * written, so a crash loses only the days in flight, and nothing partial
   * reaches raw.
   */
  private async store(
    instrument: Instrument,
    provider: string,
    date: string,
    fetched: Bar[] | Error | undefined,
  ): Promise<DayOutcome> {
    if (fetched instanceof Error) return { date, kind: 'failed', error: fetched.message };
    if (fetched === undefined || fetched.length === 0) return { date, kind: 'empty' };
    try {
      assertStorableRawDay(date, fetched);
      await this.deps.raw.putDay({ provider, symbol: instrument.symbol, date }, fetched);
      return { date, kind: 'stored', bars: fetched.length };
    } catch (error) {
      if (error instanceof RawDayAlreadyStoredError) return { date, kind: 'skipped' };
      return { date, kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
