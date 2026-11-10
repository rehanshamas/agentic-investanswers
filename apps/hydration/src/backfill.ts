// `pnpm backfill`: fetch 1-minute history into the raw store.
//
// Composition only: the Backfill use case and the adapters live in
// @aia/hydration. Crypto comes from Coinbase's public candles API (M1-04),
// stocks from Massive's aggregates (M1-07), which needs MASSIVE_API_KEY.
//
//   pnpm backfill                                  BTCUSD and ETHUSD from 2024-11-01
//   pnpm backfill --symbol NVDA --symbol TSLA      stocks from 2024-11-11
//   pnpm backfill --symbol ETHUSD --from 2022-01-01 --until 2022-12-31
//
// Safe to stop and re-run at any time: days already stored are skipped.
// Exits 0 when every planned day is stored or skipped, 1 when some failed or
// a trading day came back empty, and 2 on a setup error. A stock's weekends
// and holidays are empty by nature and do not count against the run.

import { parseArgs } from 'node:util';

import type { BackfillReport, DayOutcome } from '@aia/hydration';
import { Backfill } from '@aia/hydration';
import { CRYPTO_PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { barTime, isTradingDay, nyseCalendar } from '@aia/shared-kernel';

import { ProviderSetupError, SETTLE_SECONDS, providers, startFor } from './providers.js';
import { localStores } from './stores.js';

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm backfill [--symbol S]... [--from YYYY-MM-DD] [--until YYYY-MM-DD]`);
  process.exit(2);
}

function parse(): { instruments: Instrument[]; from: string | undefined; until: string | undefined } {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      from: { type: 'string' },
      until: { type: 'string' },
    },
  });
  const instruments = (values.symbol ?? []).map((symbol) => {
    return parityInstrument(symbol) ?? usage(`Unknown symbol: ${symbol}`);
  });
  return {
    instruments: instruments.length > 0 ? instruments : [...CRYPTO_PARITY_INSTRUMENTS],
    from: values.from,
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

const nyse = nyseCalendar();

/** Empty days that count against the run: for a stock, only trading days. */
function unexpectedEmpties(instrument: Instrument, emptyDates: readonly string[]): string[] {
  if (instrument.kind === 'crypto') return [...emptyDates];
  return emptyDates.filter((date) => isTradingDay(nyse, date));
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
    await raw.hasDay({ provider: 'coinbase', symbol: 'BTCUSD', date: '2024-11-01' });
  } catch (error) {
    console.error(
      `Could not reach the raw store at ${endpoint}: ${String(error)}\n` +
        'Is the local stack up? Run: docker compose up -d',
    );
    process.exit(2);
  }

  const provider = providers();
  const providerFor = (instrument: Instrument) => {
    try {
      return provider(instrument);
    } catch (error) {
      if (error instanceof ProviderSetupError) usage(error.message);
      throw error;
    }
  };

  const progress = new MonthlyProgress();
  const now = barTime(Math.floor(Date.now() / 1000));
  const reports: Array<{ report: BackfillReport; unexpected: string[] }> = [];
  for (const instrument of instruments) {
    const { start, moved } = startFor(instrument, from);
    if (moved) console.log(`(${instrument.symbol}: start moved to ${start}; the Massive plan serves nothing earlier)`);
    const empties: string[] = [];
    const backfill = new Backfill({
      provider: providerFor(instrument),
      raw,
      onDay: (i, outcome) => {
        if (outcome.kind === 'empty') empties.push(outcome.date);
        progress.day(i, outcome);
      },
    });
    console.log(`Backfilling ${instrument.symbol} 1m from ${start}${until ? ` to ${until}` : ''} into ${endpoint}`);
    const report = await backfill.run(instrument, {
      from: start,
      until,
      now,
      settleSeconds: SETTLE_SECONDS[instrument.kind],
    });
    progress.flush(instrument);
    reports.push({ report, unexpected: unexpectedEmpties(instrument, empties) });
  }

  console.log('');
  for (const { report, unexpected } of reports) {
    console.log(summary(report));
    if (report.empty > 0 && unexpected.length < report.empty) {
      console.log(`  (${report.empty - unexpected.length} empty days are weekends or market holidays)`);
    }
    if (unexpected.length > 0) console.log(`  empty trading days: ${unexpected.join(', ')}`);
  }
  const clean = reports.every(
    ({ report, unexpected }) => report.failed.length === 0 && unexpected.length === 0 && !report.aborted,
  );
  process.exit(clean ? 0 : 1);
}

await main();
