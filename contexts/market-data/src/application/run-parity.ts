// Run bar parity: for each instrument and timeframe, load the export, read
// our bars over its range, and compare them (docs/bar-rules.md, "Comparing
// against the exports").
//
// Every reader is a port. The CLI wires the real export files, the cooked
// store and the raw store behind them; the tests wire memory.

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import { barTime, timeframeSeconds } from '@aia/shared-kernel';

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
  /** 5m and above. */
  readonly cooked: Pick<CookedBarStorePort, 'getRange'>;
  /** 1m is not cooked: it is raw, read through the port the app wires. */
  readonly minutes: OneMinuteBarSourcePort;
}

export type ParityResult =
  | {
      readonly kind: 'compared';
      readonly instrument: Instrument;
      readonly timeframe: Timeframe;
      readonly file: string;
      readonly comparison: ParityComparison;
    }
  | {
      readonly kind: 'no-export';
      readonly instrument: Instrument;
      readonly timeframe: Timeframe;
      readonly file: string;
      readonly message: string;
    };

/** True only when every result was compared and is exact. */
export function parityPassed(results: readonly ParityResult[]): boolean {
  return (
    results.length > 0 &&
    results.every((r) => r.kind === 'compared' && r.comparison.status === 'exact')
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
    if (timeframe === '1m') return this.deps.minutes.read(instrument.symbol, from, until);
    return this.deps.cooked.getRange(instrument.symbol, timeframe, from, until);
  }
}
