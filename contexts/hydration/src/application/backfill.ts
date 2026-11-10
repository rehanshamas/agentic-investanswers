// Backfill 1-minute history into the write-once raw store, one UTC day at a
// time, so a re-run or a resumed run never writes anything twice.
//
// What makes it idempotent and resumable is the store, not bookkeeping: a day
// already stored is skipped, and losing a race to another writer is a skip
// too. There is no progress file to get out of step with the data.

import type { BarTime, Instrument } from '@aia/shared-kernel';

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

    for (const date of days) {
      const outcome = await this.day(instrument, provider, date);
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
          failed.push({ date, error: outcome.error });
          break;
      }
      consecutiveFailures = outcome.kind === 'failed' ? consecutiveFailures + 1 : 0;
      if (consecutiveFailures >= limit) {
        aborted = true;
        break;
      }
    }

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

  private async day(instrument: Instrument, provider: string, date: string): Promise<DayOutcome> {
    const ref = { provider, symbol: instrument.symbol, date };
    if (await this.deps.raw.hasDay(ref)) return { date, kind: 'skipped' };

    try {
      // The whole day is in memory before anything is written, so a crash
      // here loses only this day, and nothing partial reaches raw.
      const fetched = await this.deps.provider.fetchDay(instrument, date);
      if (fetched.length === 0) return { date, kind: 'empty' };
      assertStorableRawDay(date, fetched);
      await this.deps.raw.putDay(ref, fetched);
      return { date, kind: 'stored', bars: fetched.length };
    } catch (error) {
      if (error instanceof RawDayAlreadyStoredError) return { date, kind: 'skipped' };
      return { date, kind: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
