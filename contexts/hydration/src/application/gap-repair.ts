// Find and repair gaps in the raw store (M1-09), per market hours.
//
// docs/bar-rules.md: "A gap is a minute for which the provider's history has a
// bar but our raw store doesn't. Gap repair re-fetches those from the
// provider." A minute missing from raw is only a suspect until the provider is
// asked: if it has a bar, that is a gap and the bar is stored as a write-once
// fill beside the day; if it has none, the minute simply had no trades.
//
// Raw is never edited. Whole missing days go through the ordinary Backfill;
// minutes inside a stored day go into fill files (RawBarStorePort.putFill).

import type { Bar, BarTime, Instrument, MarketCalendar } from '@aia/shared-kernel';
import { zonedDateKey } from '@aia/shared-kernel';

import { DEFAULT_SETTLE_SECONDS, backfillDays } from '../domain/backfill-days.js';
import { expectedSpan, findHoles } from '../domain/gaps.js';
import type { BackfillReport } from './backfill.js';
import { Backfill } from './backfill.js';
import type { HistoryProviderPort } from './history-provider-port.js';
import type { RawBarStorePort } from './raw-bar-store-port.js';

export interface GapDay {
  readonly date: string;
  /** Minutes in market hours missing from raw before the repair. */
  readonly holes: number;
  /** Of those, minutes the provider had: now stored in a fill. */
  readonly filled: number;
  /** Of those, minutes the provider has no bar for either: no trades. */
  readonly confirmedEmpty: number;
  /** Minutes in market hours present in both, but different (late corrections). Reported only. */
  readonly differing: number;
  readonly error?: string;
}

export interface GapReport {
  readonly symbol: string;
  readonly provider: string;
  /** Settled days in the range that should hold bars. */
  readonly scanned: number;
  /** Whole days that were missing, and what the backfill did with them. */
  readonly backfill: BackfillReport;
  /** Every day that had holes, with the outcome. */
  readonly days: readonly GapDay[];
  /** UTC months (`YYYY-MM`) whose raw changed: these need re-cooking. */
  readonly monthsTouched: readonly string[];
}

export interface GapRepairDeps {
  readonly provider: HistoryProviderPort;
  readonly raw: Pick<RawBarStorePort, 'getDay' | 'putDay' | 'hasDay' | 'putFill'>;
  readonly calendar: MarketCalendar;
  /** Report holes and what the provider has, but write nothing. */
  readonly dryRun?: boolean;
}

export interface GapRange {
  readonly from: string;
  readonly until?: string | undefined;
  readonly now: BarTime;
  readonly settleSeconds?: number;
}

const sameBar = (a: Bar, b: Bar): boolean =>
  a.open === b.open && a.high === b.high && a.low === b.low && a.close === b.close && a.volume === b.volume;

export class GapRepair {
  constructor(private readonly deps: GapRepairDeps) {}

  async run(instrument: Instrument, range: GapRange): Promise<GapReport> {
    const provider = this.deps.provider.name;
    const symbol = instrument.symbol;
    const settleSeconds = range.settleSeconds ?? DEFAULT_SETTLE_SECONDS;
    const months = new Set<string>();

    // 1. Whole missing days: the ordinary backfill, which skips stored ones.
    const backfillRange = { from: range.from, until: range.until, now: range.now, settleSeconds };
    const backfill = this.deps.dryRun
      ? emptyBackfillReport(symbol, provider)
      : await new Backfill({
          provider: this.deps.provider,
          raw: this.deps.raw,
          onDay: (_i, outcome) => {
            if (outcome.kind === 'stored') months.add(outcome.date.slice(0, 7));
          },
        }).run(instrument, backfillRange);

    // 2. Holes inside stored days, per market hours.
    const suspects = new Map<string, { span: { from: BarTime; until: BarTime }; holes: BarTime[]; stored: Bar[] }>();
    let scanned = 0;
    for (const date of backfillDays(range.from, range.until, range.now, settleSeconds)) {
      const span = expectedSpan(instrument, date, this.deps.calendar);
      if (span === undefined) continue;
      scanned++;
      const stored = await this.deps.raw.getDay({ provider, symbol, date });
      if (stored === undefined) continue; // still missing: the backfill above reported it
      const holes = findHoles(stored, span);
      if (holes.length > 0) suspects.set(date, { span, holes, stored });
    }

    // 3. Ask the provider about the suspects, in its batch size.
    const days: GapDay[] = [];
    const dates = [...suspects.keys()];
    const batch = this.deps.provider.fetchDays === undefined ? 1 : Math.max(1, this.deps.provider.daysPerRequest ?? 1);
    for (let i = 0; i < dates.length; i += batch) {
      const group = dates.slice(i, i + batch);
      let fetched: Map<string, Bar[]> | undefined;
      let error: string | undefined;
      try {
        fetched = await this.fetch(instrument, group);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      for (const date of group) {
        const suspect = suspects.get(date);
        if (suspect === undefined) continue;
        if (fetched === undefined) {
          days.push({ date, holes: suspect.holes.length, filled: 0, confirmedEmpty: 0, differing: 0, error: error ?? 'not fetched' });
          continue;
        }
        days.push(await this.resolve(instrument, provider, date, suspect, fetched.get(date) ?? [], months));
      }
    }

    return {
      symbol,
      provider,
      scanned,
      backfill,
      days,
      monthsTouched: [...months].sort(),
    };
  }

  private async fetch(instrument: Instrument, dates: readonly string[]): Promise<Map<string, Bar[]>> {
    const { provider } = this.deps;
    if (provider.fetchDays !== undefined && dates.length > 1) return provider.fetchDays(instrument, dates);
    const result = new Map<string, Bar[]>();
    for (const date of dates) result.set(date, await provider.fetchDay(instrument, date));
    return result;
  }

  private async resolve(
    instrument: Instrument,
    provider: string,
    date: string,
    suspect: { span: { from: BarTime; until: BarTime }; holes: BarTime[]; stored: Bar[] },
    fromProvider: readonly Bar[],
    months: Set<string>,
  ): Promise<GapDay> {
    const theirs = new Map(fromProvider.map((bar) => [bar.time, bar]));
    const fill = suspect.holes.flatMap((time) => {
      const bar = theirs.get(time);
      return bar === undefined ? [] : [bar];
    });
    let differing = 0;
    for (const bar of suspect.stored) {
      if (bar.time < suspect.span.from || bar.time >= suspect.span.until) continue;
      const other = theirs.get(bar.time);
      if (other !== undefined && !sameBar(bar, other)) differing++;
    }
    const outcome = {
      date,
      holes: suspect.holes.length,
      filled: fill.length,
      confirmedEmpty: suspect.holes.length - fill.length,
      differing,
    };
    if (fill.length === 0 || this.deps.dryRun) return outcome;
    try {
      await this.deps.raw.putFill({ provider, symbol: instrument.symbol, date }, fill);
      months.add(zonedDateKey(suspect.span.from, 'UTC').slice(0, 7));
      return outcome;
    } catch (e) {
      return { ...outcome, filled: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function emptyBackfillReport(symbol: string, provider: string): BackfillReport {
  return { symbol, provider, planned: 0, stored: 0, skipped: 0, empty: 0, failed: [], bars: 0, aborted: false };
}
