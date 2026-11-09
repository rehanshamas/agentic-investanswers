// `pnpm parity`: compare our bars with the TradingView exports
// (docs/bar-rules.md, "Comparing against the exports").
//
// Composition only. The comparison, the run and the report live in
// @aia/market-data; this wires the export files, the cooked store and the
// raw store (through RawMinuteSource) behind them.
//
//   pnpm parity                         every crypto instrument, every timeframe
//   pnpm parity --symbol BTCUSD --timeframe 5m --timeframe 1h
//   pnpm parity --fixtures <dir>        another export directory
//
// Exits 0 only when every compared file is exact, 1 when parity fails, and 2
// when the stores cannot be read at all. Stocks are left out by default until
// OI-27 settles their venue; pass --symbol NVDA to try one anyway.

import { parseArgs } from 'node:util';

import { S3RawBarStore } from '@aia/hydration';
import {
  CRYPTO_PARITY_INSTRUMENTS,
  DEFAULT_FIXTURE_DIR,
  FixtureError,
  RunParity,
  S3CookedBarStore,
  TradingViewExportSource,
  formatParityReport,
  parityInstrument,
  parityPassed,
} from '@aia/market-data';
import type { Instrument, Timeframe } from '@aia/shared-kernel';
import { TIMEFRAMES, isTimeframe } from '@aia/shared-kernel';

import { RawMinuteSource } from './raw-minute-source.js';

/** Raw files are keyed by provider: CoinAPI for crypto, Massive for stocks. */
function providerOf(instrument: Instrument): string {
  return instrument.kind === 'crypto' ? 'coinapi' : 'massive';
}

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm parity [--symbol S]... [--timeframe T]... [--fixtures DIR]`);
  process.exit(2);
}

function parse(): { instruments: Instrument[]; timeframes: Timeframe[]; dir: string } {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      timeframe: { type: 'string', multiple: true },
      fixtures: { type: 'string' },
    },
  });
  const instruments = (values.symbol ?? []).map(
    (symbol) => parityInstrument(symbol) ?? usage(`Unknown parity symbol: ${symbol}`),
  );
  const timeframes = (values.timeframe ?? []).map((tf) =>
    isTimeframe(tf) ? tf : usage(`Unknown timeframe: ${tf} (one of ${TIMEFRAMES.join(', ')})`),
  );
  return {
    instruments: instruments.length > 0 ? instruments : [...CRYPTO_PARITY_INSTRUMENTS],
    timeframes: timeframes.length > 0 ? timeframes : [...TIMEFRAMES],
    dir: values.fixtures ?? DEFAULT_FIXTURE_DIR,
  };
}

async function main(): Promise<void> {
  const { instruments, timeframes, dir } = parse();
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
  const bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
  const minutes = new RawMinuteSource(raw, (symbol) => {
    const instrument = bySymbol.get(symbol);
    if (instrument === undefined) throw new Error(`No instrument for ${symbol}`);
    return providerOf(instrument);
  });

  console.log(
    `Bar parity: ${instruments.map((i) => i.symbol).join(', ')} × ${timeframes.join(' ')}\n` +
      `Exports: ${dir}   Stores: ${endpoint}\n`,
  );

  let results;
  try {
    results = await new RunParity({
      exports: new TradingViewExportSource({ dir }),
      cooked,
      minutes,
    }).run(instruments, timeframes);
  } catch (error) {
    // A malformed export is a broken spec, not a store problem: let it throw.
    if (error instanceof FixtureError) throw error;
    console.error(
      `Could not read the bar stores at ${endpoint}: ${String(error)}\n` +
        'Is the local stack up? Run: docker compose up -d',
    );
    process.exit(2);
  }

  console.log(formatParityReport(results));
  process.exit(parityPassed(results) ? 0 : 1);
}

await main();
