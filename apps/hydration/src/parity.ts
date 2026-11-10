// `pnpm parity`: the two parity checks (docs/bar-rules.md, "Comparing against
// the exports"; split by Sham on 2026-11-09, M1-14).
//
// 1. Build parity, exact and blocking: TradingView's finer export rolled up
//    by our code must equal its coarser export. Needs no stores.
// 2. Source fidelity, reported only: our stored bars against each export.
//
// Composition only. The checks and the reports live in @aia/market-data; this
// wires the export files, the cooked store and the raw store (through
// RawMinuteSource) behind them.
//
//   pnpm parity                         both checks, every crypto instrument and timeframe
//   pnpm parity --build                 build parity only (no MinIO needed)
//   pnpm parity --fidelity --timeframe 1m
//   pnpm parity --symbol BTCUSD --fixtures <dir>
//
// Exits 0 when build parity is exact, 1 when it is not, and 2 on bad
// arguments or a malformed export. Source fidelity never changes the exit
// code; an unreachable store is a note. Stocks are left out by default until
// OI-27 settles their venue; pass --symbol NVDA to try one anyway.

import { parseArgs } from 'node:util';

import { S3RawBarStore } from '@aia/hydration';
import type { ParityResult } from '@aia/market-data';
import {
  CRYPTO_PARITY_INSTRUMENTS,
  DEFAULT_FIXTURE_DIR,
  RunParity,
  S3CookedBarStore,
  TradingViewExportSource,
  buildSource,
  formatFidelityReport,
  formatParityReport,
  parityInstrument,
  parityPassed,
} from '@aia/market-data';
import type { Instrument, Timeframe } from '@aia/shared-kernel';
import { TIMEFRAMES, isTimeframe, nyseCalendar } from '@aia/shared-kernel';

import { RawMinuteSource } from './raw-minute-source.js';

/**
 * Raw files are keyed by provider. Crypto history is backfilled from
 * Coinbase (M1-04); stocks will come from Massive (M1-07).
 */
function providerOf(instrument: Instrument): string {
  return instrument.kind === 'crypto' ? 'coinbase' : 'massive';
}

const USAGE =
  'Usage: pnpm parity [--build | --fidelity] [--symbol S]... [--timeframe T]... [--fixtures DIR]';

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

interface Args {
  readonly instruments: Instrument[];
  readonly timeframes: Timeframe[];
  readonly dir: string;
  readonly build: boolean;
  readonly fidelity: boolean;
}

function parse(): Args {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      timeframe: { type: 'string', multiple: true },
      fixtures: { type: 'string' },
      build: { type: 'boolean' },
      fidelity: { type: 'boolean' },
    },
  });
  const instruments = (values.symbol ?? []).map(
    (symbol) => parityInstrument(symbol) ?? usage(`Unknown parity symbol: ${symbol}`),
  );
  const timeframes = (values.timeframe ?? []).map((tf) =>
    isTimeframe(tf) ? tf : usage(`Unknown timeframe: ${tf} (one of ${TIMEFRAMES.join(', ')})`),
  );
  const onlyOne = values.build === true || values.fidelity === true;
  return {
    instruments: instruments.length > 0 ? instruments : [...CRYPTO_PARITY_INSTRUMENTS],
    timeframes: timeframes.length > 0 ? timeframes : [...TIMEFRAMES],
    dir: values.fixtures ?? DEFAULT_FIXTURE_DIR,
    build: !onlyOne || values.build === true,
    fidelity: !onlyOne || values.fidelity === true,
  };
}

async function fidelity(args: Args, exports: TradingViewExportSource): Promise<void> {
  const env = process.env;
  const endpoint = env['AIA_S3_ENDPOINT'] ?? 'http://127.0.0.1:9000';
  const s3 = {
    endpoint,
    region: env['AIA_S3_REGION'] ?? 'us-east-1',
    // The local MinIO's credentials from docker-compose.yml, unless overridden.
    credentials: {
      accessKeyId: env['AIA_S3_ACCESS_KEY'] ?? 'minio',
      secretAccessKey: env['AIA_S3_SECRET_KEY'] ?? 'minio12345',
    },
  };
  const raw = new S3RawBarStore({ ...s3, bucket: env['AIA_RAW_BUCKET'] ?? 'aia-raw' });
  const cooked = new S3CookedBarStore({ ...s3, bucket: env['AIA_COOKED_BUCKET'] ?? 'aia-cooked' });
  const bySymbol = new Map(args.instruments.map((i) => [i.symbol, i]));
  const minutes = new RawMinuteSource(raw, (symbol) => {
    const instrument = bySymbol.get(symbol);
    if (instrument === undefined) throw new Error(`No instrument for ${symbol}`);
    return providerOf(instrument);
  });

  console.log(`SOURCE FIDELITY (reported only)   stores: ${endpoint}\n`);
  let results: ParityResult[];
  try {
    results = await new RunParity({ exports, cooked, minutes }).run(args.instruments, args.timeframes);
  } catch (error) {
    // Reported only, so a store we cannot reach is a note, not a failure.
    console.log(
      `Not run: could not read the bar stores at ${endpoint}: ${String(error)}\n` +
        'Is the local stack up? Run: docker compose up -d\n',
    );
    return;
  }
  console.log(`${formatFidelityReport(results)}\n`);
}

async function main(): Promise<void> {
  const args = parse();
  const exports = new TradingViewExportSource({ dir: args.dir });
  console.log(
    `Bar parity: ${args.instruments.map((i) => i.symbol).join(', ')} × ${args.timeframes.join(' ')}\n` +
      `Exports: ${args.dir}\n`,
  );

  // A malformed export throws FixtureError out of either check: a broken spec
  // should stop the run, not be one row among many.
  let build: ParityResult[] | undefined;
  if (args.build && args.timeframes.every((tf) => buildSource(tf) === undefined)) {
    console.log('BUILD PARITY: nothing to rebuild (1m is the finest export).\n');
  } else if (args.build) {
    build = await new RunParity({ exports, calendar: nyseCalendar() }).runBuild(
      args.instruments,
      args.timeframes,
    );
    console.log('BUILD PARITY (blocking): TradingView bars rebuilt by our rollups\n');
    console.log(`${formatParityReport(build, { label: 'BUILD PARITY' })}\n`);
  }
  if (args.fidelity) await fidelity(args, exports);

  if (build === undefined) process.exit(0);
  process.exit(parityPassed(build) ? 0 : 1);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
