// Run the two parity checks (docs/bar-rules.md, "Comparing against the
// exports"; split by Sham on 2026-11-09, M1-14):
// - `runBuild`: build parity, exact and blocking. TradingView's finer export
//   rolled up by our code against its higher-timeframe export. Needs only the
//   exports.
// - `run`: source fidelity, reported only. Our stored bars against the
//   export. Needs the cooked store and the 1m source.
//
// Every reader is a port. The CLI wires the real export files, the cooked
// store and the raw store behind them; the tests wire memory.

import type { Bar, BarTime, Instrument, MarketCalendar, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

import { buildParityExceptions } from '../domain/build-parity-exceptions.js';
import type { BuildParityException } from '../domain/build-parity-exceptions.js';
import { buildParity, buildSource } from '../domain/build-parity.js';
import type { ParityComparison } from '../domain/parity.js';
import { compareBars } from '../domain/parity.js';
import type { CookedBarStorePort } from './cooked-bar-store-port.js';
import type { OneMinuteBarSourcePort } from './one-minute-bar-source-port.js';

/** One export, as the parity run needs it: bars without the forming one. */
export interface ParityExport {
  readonly file: string;
  readonly bars: readonly Bar[];
}

/**
 * Where the exports come from.
 *
 * Throws `ParityExportMissingError` when the file is not there, so a missing
 * export is reported per file instead of stopping the whole run.
 */
export interface ParityExportSourcePort {
  load(instrument: Instrument, timeframe: Timeframe): Promise<ParityExport>;
}

export class ParityExportMissingError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(message);
  }
}

export interface RunParityDeps {
  readonly exports: ParityExportSourcePort;
  /** Source fidelity, 5m and above. Not needed for build parity. */
  readonly cooked?: Pick<CookedBarStorePort, 'getRange'>;
  /** Source fidelity, 1m: raw, read through the port the app wires. */
  readonly minutes?: OneMinuteBarSourcePort;
  /** Required to roll up instruments with sessions (stocks). */
  readonly calendar?: MarketCalendar;
  /** Approved build-parity exceptions. Defaults to the committed list. */
  readonly exceptions?: readonly BuildParityException[];
  /** Build parity's settle time. Defaults to 14 days; tests on short samples pass 0. */
  readonly settleSeconds?: number;
}

export class RunParityError extends Error {}

export type ParityResult =
  | {
      readonly kind: 'compared';
      readonly instrument: Instrument;
      readonly timeframe: Timeframe;
      readonly file: string;
      readonly comparison: ParityComparison;
      /** Build parity only: the export the bars were rebuilt from. */
      readonly sourceFile?: string;
    }
  | {
      readonly kind: 'no-export';
      readonly instrument: Instrument;
      readonly timeframe: Timeframe;
      readonly file: string;
      readonly message: string;
    }
  | {
      /** The check itself could not run, for example a calendar out of range. */
      readonly kind: 'error';
      readonly instrument: Instrument;
      readonly timeframe: Timeframe;
      readonly file: string;
      readonly message: string;
    };

/** True only when every result was compared and is exact (or exact apart from approved exceptions). */
export function parityPassed(results: readonly ParityResult[]): boolean {
  return (
    results.length > 0 &&
    results.every(
      (r) =>
        r.kind === 'compared' &&
        (r.comparison.status === 'exact' || r.comparison.status === 'excepted'),
    )
  );
}

/**
 * How far before the export's first bar to read ours.
 *
 * `parityWindow` skips our first bar when our history starts after the
 * export's, since that bar may be partial. Reading one bar further back lets
 * it tell "our history starts later" from "we are missing that one bar": in
 * the second case our earlier bar is found and the missing one fails.
 * Calendar timeframes use the longest month.
 */
function lookbackSeconds(timeframe: Timeframe): number {
  return timeframeSeconds(timeframe) ?? 31 * 24 * 60 * 60;
}

export class RunParity {
  constructor(private readonly deps: RunParityDeps) {}

  /** Source fidelity: our stored bars against each export. */
  async run(
    instruments: readonly Instrument[],
    timeframes: readonly Timeframe[],
  ): Promise<ParityResult[]> {
    const results: ParityResult[] = [];
    for (const instrument of instruments) {
      for (const timeframe of timeframes) {
        results.push(await this.runOne(instrument, timeframe));
      }
    }
    return results;
  }

  /**
   * Build parity for every target that has a finer export to rebuild it
   * from (all but 1m). A missing target or source export is a NO EXPORT row.
   */
  async runBuild(
    instruments: readonly Instrument[],
    targets: readonly Timeframe[],
  ): Promise<ParityResult[]> {
    const results: ParityResult[] = [];
    for (const instrument of instruments) {
      for (const target of targets) {
        const source = buildSource(target);
        if (source === undefined) continue;
        results.push(await this.buildOne(instrument, target, source));
      }
    }
    return results;
  }

  private async buildOne(
    instrument: Instrument,
    target: Timeframe,
    source: Timeframe,
  ): Promise<ParityResult> {
    let exported: ParityExport;
    let finer: ParityExport;
    try {
      exported = await this.deps.exports.load(instrument, target);
      finer = await this.deps.exports.load(instrument, source);
    } catch (error) {
      if (!(error instanceof ParityExportMissingError)) throw error;
      return { kind: 'no-export', instrument, timeframe: target, file: error.file, message: error.message };
    }
    try {
      return {
        kind: 'compared',
        instrument,
        timeframe: target,
        file: exported.file,
        sourceFile: finer.file,
        comparison: buildParity(instrument, target, finer.bars, exported.bars, {
          ...(this.deps.calendar === undefined ? {} : { calendar: this.deps.calendar }),
          exceptions: buildParityExceptions(instrument.symbol, target, this.deps.exceptions),
          ...(this.deps.settleSeconds === undefined ? {} : { settleSeconds: this.deps.settleSeconds }),
        }),
      };
    } catch (error) {
      return {
        kind: 'error',
        instrument,
        timeframe: target,
        file: exported.file,
        message: `${exported.file} from ${finer.file}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async runOne(instrument: Instrument, timeframe: Timeframe): Promise<ParityResult> {
    let exported: ParityExport;
    try {
      exported = await this.deps.exports.load(instrument, timeframe);
    } catch (error) {
      if (!(error instanceof ParityExportMissingError)) throw error;
      return { kind: 'no-export', instrument, timeframe, file: error.file, message: error.message };
    }

    const first = exported.bars[0];
    const last = exported.bars[exported.bars.length - 1];
    const ours =
      first === undefined || last === undefined
        ? []
        : await this.readOurs(
            instrument,
            timeframe,
            barTime(first.time - lookbackSeconds(timeframe)),
            last.time,
          );

    return {
      kind: 'compared',
      instrument,
      timeframe,
      file: exported.file,
      comparison: compareBars(exported.bars, ours),
    };
  }

  private readOurs(
    instrument: Instrument,
    timeframe: Timeframe,
    from: BarTime,
    until: BarTime,
  ): Promise<Bar[]> {
    const { cooked, minutes } = this.deps;
    if (timeframe === '1m') {
      if (minutes === undefined) throw new RunParityError('Source fidelity needs a 1m source');
      return minutes.read(instrument.symbol, from, until);
    }
    if (cooked === undefined) throw new RunParityError('Source fidelity needs the cooked store');
    return cooked.getRange(instrument.symbol, timeframe, from, until);
  }
}
