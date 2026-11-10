// `pnpm backfill`: fetch crypto 1-minute history into the raw store.
//
// Composition only: the Backfill use case and the Coinbase adapter live in
// @aia/hydration. History comes from Coinbase's public candles API, not
// CoinAPI (M1-04, Sham 2026-11-09; see tasks/M1-04.md).
//
//   pnpm backfill                                  BTCUSD and ETHUSD from 2024-11-01
//   pnpm backfill --symbol ETHUSD --from 2022-01-01 --until 2022-12-31
//
// Safe to stop and re-run at any time: days already stored are skipped.
// Exits 0 when every planned day is stored or skipped, 1 when some failed or
// came back empty, and 2 on a setup error.

import { parseArgs } from 'node:util';

import type { BackfillReport, DayOutcome } from '@aia/hydration';
import { Backfill, CoinbaseCandles } from '@aia/hydration';
import { CRYPTO_PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { barTime } from '@aia/shared-kernel';

import { localStores } from './stores.js';

const DEFAULT_FROM = '2024-11-01';

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm backfill [--symbol S]... [--from YYYY-MM-DD] [--until YYYY-MM-DD]`);
  process.exit(2);
}

function parse(): { instruments: Instrument[]; from: string; until: string | undefined } {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      from: { type: 'string' },
      until: { type: 'string' },
    },
  });
  const instruments = (values.symbol ?? []).map((symbol) => {
    const instrument = parityInstrument(symbol) ?? usage(`Unknown symbol: ${symbol}`);
    if (instrument.kind !== 'crypto') usage(`${symbol} is a stock; stock history is M1-07`);
    return instrument;
  });
  return {
    instruments: instruments.length > 0 ? instruments : [...CRYPTO_PARITY_INSTRUMENTS],
    from: values.from ?? DEFAULT_FROM,
    until: values.until,
  };
}

/** One line per month, so a two-year run prints about 25 lines per symbol. */
class MonthlyProgress {
  private month = '';
  private counts = { stored: 0, skipped: 0, empty: 0, failed: 0, bars: 0 };

  day(instrument: Instrument, outcome: DayOutcome): void {
    const month = outcome.date.slice(0, 7);
    if (month !== this.month) this.flush(instrument);
    this.month = month;
    this.counts[outcome.kind]++;
    if (outcome.kind === 'stored') this.counts.bars += outcome.bars;
    if (outcome.kind === 'failed') console.log(`  ${outcome.date} FAILED: ${outcome.error}`);
  }

  flush(instrument: Instrument): void {
    if (this.month === '') return;
    const c = this.counts;
    console.log(
      `  ${instrument.symbol} ${this.month}: ${c.stored} stored (${c.bars} bars), ` +
        `${c.skipped} already there, ${c.empty} empty, ${c.failed} failed`,
    );
    this.month = '';
    this.counts = { stored: 0, skipped: 0, empty: 0, failed: 0, bars: 0 };
  }
}

function summary(report: BackfillReport): string {
  return (
    `${report.symbol} from ${report.provider}: ${report.planned} days planned, ` +
    `${report.stored} stored (${report.bars} bars), ${report.skipped} already there, ` +
    `${report.empty} empty, ${report.failed.length} failed` +
    (report.aborted ? ' — STOPPED after repeated failures' : '')
  );
}

async function main(): Promise<void> {
  const { instruments, from, until } = parse();
  const { endpoint, raw } = localStores(instruments);

  // Fail fast on an unreachable store, before spending any provider requests.
  try {
    await raw.hasDay({ provider: 'coinbase', symbol: 'BTCUSD', date: from });
  } catch (error) {
    console.error(
      `Could not reach the raw store at ${endpoint}: ${String(error)}\n` +
        'Is the local stack up? Run: docker compose up -d',
    );
    process.exit(2);
  }

  const progress = new MonthlyProgress();
  const backfill = new Backfill({
    provider: new CoinbaseCandles(),
    raw,
    onDay: (instrument, outcome) => progress.day(instrument, outcome),
  });
  const now = barTime(Math.floor(Date.now() / 1000));

  const reports: BackfillReport[] = [];
  for (const instrument of instruments) {
    console.log(`Backfilling ${instrument.symbol} 1m from ${from}${until ? ` to ${until}` : ''} into ${endpoint}`);
    const report = await backfill.run(instrument, { from, until, now });
    progress.flush(instrument);
    reports.push(report);
  }

  console.log('');
  for (const report of reports) console.log(summary(report));
  const clean = reports.every((r) => r.failed.length === 0 && r.empty === 0 && !r.aborted);
  process.exit(clean ? 0 : 1);
}

await main();
