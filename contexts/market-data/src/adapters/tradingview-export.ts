// Read the TradingView parity exports from disk as Bars.
//
// These files are the spec (CLAUDE.md, "Tests are the spec"), so this loader
// changes nothing about them: it parses, validates, and reports. The one
// transformation it makes is dropping the final bar, and the one rounding it
// does is of float noise it proves is noise first — both explained below.
//
// It lives in this context because `market-data` owns bars, and as an adapter
// because it touches the file system. It is used by the parity harness
// (M1-03), through `TradingViewExportSource` at the bottom, and by no
// production path.

import { readFile, readdir } from 'node:fs/promises';

import type { Bar, BarTime, Instrument, Timeframe } from '@aia/shared-kernel';
import {
  assertCoherent,
  barTime,
  isIntraday,
  parseScaled,
  price,
  timeframeSeconds,
  volume,
} from '@aia/shared-kernel';

import type { ParityExport, ParityExportSourcePort } from '../application/run-parity.js';
import { ParityExportMissingError } from '../application/run-parity.js';
import { storageToken } from '../domain/cooked-partition.js';

export class FixtureError extends Error {}

/** Default location, relative to the repo root. Overridable for tests. */
export const DEFAULT_FIXTURE_DIR = ['fixtures', 'parity', 'tradingview'].join('/');

/**
 * Largest excess we will treat as float noise rather than a real difference.
 *
 * TradingView's higher-timeframe volumes are float sums, so about one row per
 * file carries digits past the instrument's real precision — measured worst
 * case 4.55e-13 on `ethusd_4h.csv` (`2391.1941948600006`). Those digits carry
 * no information. Anything larger is a genuine value we cannot represent, and
 * is an error rather than something to round away quietly.
 */
const NOISE_TOLERANCE = 1e-9;

/** `btcusd_1m.csv`, `btcusd_1mo.csv`: lower case, with the storage token. */
export function fixtureFileName(symbol: string, timeframe: Timeframe): string {
  return `${symbol.toLowerCase()}_${storageToken(timeframe)}.csv`;
}

export interface ParityFixture {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  readonly file: string;
  /** Bars in file order, ascending, with the forming last bar removed. */
  readonly bars: Bar[];
  /**
   * The final row of the file, which is excluded from `bars`.
   *
   * docs/bar-rules.md: the newest bar is still forming when the export is
   * saved, so two files saved seconds apart disagree on it. Measured on
   * `btcusd_5m.csv`, whose last bar was the only one of 501 that did not match
   * the 1m file. Comparing it would fail parity forever for a non-bug.
   */
  readonly formingBarDropped: Bar | undefined;
}

interface Columns {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

function readHeader(header: string, file: string): Columns {
  const names = header.split(',').map((c) => c.trim().toLowerCase());
  const find = (name: string): number => {
    const index = names.indexOf(name);
    if (index === -1) {
      throw new FixtureError(`${file}: no "${name}" column; header was ${header}`);
    }
    return index;
  };
  // TradingView writes "Volume" capitalised; match case-insensitively.
  return {
    time: find('time'),
    open: find('open'),
    high: find('high'),
    low: find('low'),
    close: find('close'),
    volume: find('volume'),
  };
}

/**
 * Parse a decimal cell at `scale`, tolerating provable float noise.
 *
 * `parseScaled` refuses to round away real precision, which is what we want.
 * But TradingView's own float sums put noise beyond the instrument's scale, so
 * this retries once at the rounded value after checking the discarded part is
 * noise-sized. A genuinely unrepresentable value still throws.
 */
function parseCell(text: string, scale: number, file: string, what: string): number {
  const trimmed = text.trim();
  try {
    return parseScaled(trimmed, scale);
  } catch (error) {
    const asNumber = Number(trimmed);
    if (!Number.isFinite(asNumber)) {
      throw new FixtureError(`${file}: ${what} is not a number: ${JSON.stringify(trimmed)}`);
    }
    const rounded = asNumber.toFixed(scale);
    const discarded = Math.abs(asNumber - Number(rounded));
    if (discarded > NOISE_TOLERANCE) {
      throw new FixtureError(
        `${file}: ${what} ${trimmed} needs more than ${scale} decimal places ` +
          `(would discard ${discarded}, far beyond float noise). Fix the instrument scale ` +
          `rather than rounding this away. Original: ${String(error)}`,
      );
    }
    return parseScaled(rounded, scale);
  }
}

function assertGrid(fixture: { timeframe: Timeframe; file: string }, bars: readonly Bar[]): void {
  let previous: BarTime | undefined;
  for (const bar of bars) {
    if (previous !== undefined && bar.time <= previous) {
      throw new FixtureError(
        `${fixture.file}: bars must be strictly ascending; ${bar.time} follows ${previous}`,
      );
    }
    previous = bar.time;
  }
  if (!isIntraday(fixture.timeframe)) return;
  const step = timeframeSeconds(fixture.timeframe);
  if (step === undefined) return;
  // Crypto intraday bars are anchored to 00:00 UTC, so every open is a
  // multiple of the timeframe. Stock bars are session-anchored and are not,
  // so this only applies where the file is a 24/7 instrument.
  for (const bar of bars) {
    if (bar.time % step !== 0) {
      throw new FixtureError(
        `${fixture.file}: ${bar.time} is not on the ${fixture.timeframe} grid`,
      );
    }
  }
}

export interface LoadOptions {
  readonly dir?: string;
  /** Skip the grid check for session-anchored instruments. Default: by kind. */
  readonly checkGrid?: boolean;
}

/** Load one fixture file for an instrument and timeframe. */
export async function loadFixture(
  instrument: Instrument,
  timeframe: Timeframe,
  options: LoadOptions = {},
): Promise<ParityFixture> {
  const dir = options.dir ?? DEFAULT_FIXTURE_DIR;
  const file = fixtureFileName(instrument.symbol, timeframe);
  let text: string;
  try {
    text = await readFile(`${dir}/${file}`, 'utf8');
  } catch {
    throw new FixtureError(
      `${file} is missing from ${dir}. The exports are not committed while the repo is public ` +
        `(OI-04, M1-13); place them there by hand.`,
    );
  }

  const lines = text.trim().split('\n');
  const header = lines[0];
  if (header === undefined) throw new FixtureError(`${file} is empty`);
  const columns = readHeader(header, file);

  const all: Bar[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    const cells = line.split(',');
    const cell = (at: number, what: string): string => {
      const value = cells[at];
      if (value === undefined || value.trim() === '') {
        throw new FixtureError(`${file} line ${index + 2}: ${what} is empty`);
      }
      return value;
    };
    const seconds = Number(cell(columns.time, 'time').trim());
    if (!Number.isInteger(seconds)) {
      throw new FixtureError(
        `${file} line ${index + 2}: time ${seconds} is not whole seconds. ` +
          `Export with time format = UNIX timestamp.`,
      );
    }
    const bar: Bar = {
      time: barTime(seconds),
      open: price(parseCell(cell(columns.open, 'open'), instrument.priceScale, file, 'open')),
      high: price(parseCell(cell(columns.high, 'high'), instrument.priceScale, file, 'high')),
      low: price(parseCell(cell(columns.low, 'low'), instrument.priceScale, file, 'low')),
      close: price(parseCell(cell(columns.close, 'close'), instrument.priceScale, file, 'close')),
      volume: volume(
        parseCell(cell(columns.volume, 'volume'), instrument.volumeScale, file, 'volume'),
      ),
    };
    assertCoherent(bar);
    all.push(bar);
  }

  const checkGrid = options.checkGrid ?? instrument.kind === 'crypto';
  if (checkGrid) assertGrid({ timeframe, file }, all);

  // Drop the forming bar, never the whole file.
  const formingBarDropped = all.length > 0 ? all[all.length - 1] : undefined;
  const bars = all.slice(0, Math.max(0, all.length - 1));

  return { symbol: instrument.symbol, timeframe, file, bars, formingBarDropped };
}

/** Load every timeframe for the given instruments. */
export async function loadFixtures(
  instruments: readonly Instrument[],
  timeframes: readonly Timeframe[],
  options: LoadOptions = {},
): Promise<ParityFixture[]> {
  const loaded: ParityFixture[] = [];
  for (const instrument of instruments) {
    for (const timeframe of timeframes) {
      loaded.push(await loadFixture(instrument, timeframe, options));
    }
  }
  return loaded;
}

/** Fixture file names present in a directory, for reporting what is missing. */
export async function listFixtureFiles(dir: string = DEFAULT_FIXTURE_DIR): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => name.endsWith('.csv')).sort();
  } catch {
    return [];
  }
}

/**
 * The row counts per file that this task's done-check asks to be printed.
 *
 * Reports the forming bar separately, so the dropped row is visible rather
 * than looking like an off-by-one.
 */
export function summariseFixtures(fixtures: readonly ParityFixture[]): string {
  const widest = Math.max(10, ...fixtures.map((f) => f.file.length));
  const lines = [
    `${'FILE'.padEnd(widest)}  ${'BARS'.padStart(7)}  ${'DROPPED'.padStart(7)}  RANGE (UTC)`,
  ];
  for (const fixture of fixtures) {
    const first = fixture.bars[0];
    const last = fixture.bars[fixture.bars.length - 1];
    const range =
      first === undefined || last === undefined
        ? '(empty)'
        : `${new Date(first.time * 1000).toISOString().slice(0, 10)} .. ` +
          `${new Date(last.time * 1000).toISOString().slice(0, 10)}`;
    lines.push(
      `${fixture.file.padEnd(widest)}  ${String(fixture.bars.length).padStart(7)}  ` +
        `${String(fixture.formingBarDropped === undefined ? 0 : 1).padStart(7)}  ${range}`,
    );
  }
  const total = fixtures.reduce((sum, f) => sum + f.bars.length, 0);
  lines.push(`${'TOTAL'.padEnd(widest)}  ${String(total).padStart(7)}`);
  return lines.join('\n');
}

/**
 * The exports as the parity run reads them.
 *
 * A missing file becomes `ParityExportMissingError`, so the run reports it
 * against that file and carries on. A file that is present but malformed
 * still throws `FixtureError`: a broken spec should stop the run, not be
 * listed as one row among many.
 */
export class TradingViewExportSource implements ParityExportSourcePort {
  constructor(private readonly options: LoadOptions = {}) {}

  async load(instrument: Instrument, timeframe: Timeframe): Promise<ParityExport> {
    const dir = this.options.dir ?? DEFAULT_FIXTURE_DIR;
    const file = fixtureFileName(instrument.symbol, timeframe);
    if (!(await listFixtureFiles(dir)).includes(file)) {
      throw new ParityExportMissingError(
        file,
        `${file} is missing from ${dir}. The exports are not committed while the repo is ` +
          `public (OI-04, M1-13); place them there by hand.`,
      );
    }
    const fixture = await loadFixture(instrument, timeframe, this.options);
    return { file: fixture.file, bars: fixture.bars };
  }
}
