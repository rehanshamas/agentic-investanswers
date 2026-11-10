// `pnpm gaps`: find minutes missing from raw within market hours, ask the
// provider which it has, store those as write-once fills, and re-cook the
// months that changed (M1-09). Composition only.
//
//   pnpm gaps                                  every symbol, the last 7 settled days
//   pnpm gaps --from 2024-11-01                everything stored
//   pnpm gaps --symbol BTCUSD --dry-run        report, write nothing
//
// Exits 0 when every hole is filled or confirmed empty, 1 when a re-fetch or
// write failed, and 2 on a setup error. Stocks are repaired but not re-cooked
// until M1-08.

import { parseArgs } from 'node:util';

import { PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { addDays, barTime, nyseCalendar } from '@aia/shared-kernel';

import { DEFAULT_FROM, ProviderSetupError, SETTLE_SECONDS, providers, startFor } from './providers.js';
import { repairAndRecook } from './repair-and-recook.js';
import { localStores } from './stores.js';

const USAGE = 'Usage: pnpm gaps [--symbol S]... [--from YYYY-MM-DD] [--until YYYY-MM-DD] [--dry-run]';

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}

function parse(): { instruments: Instrument[]; from: string | undefined; until: string | undefined; dryRun: boolean } {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      from: { type: 'string' },
      until: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });
  const instruments = (values.symbol ?? []).map(
    (symbol) => parityInstrument(symbol) ?? usage(`Unknown symbol: ${symbol}`),
  );
  for (const date of [values.from, values.until]) {
    if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(date)) usage('Dates must be YYYY-MM-DD');
  }
  return {
    instruments: instruments.length > 0 ? instruments : [...PARITY_INSTRUMENTS],
    from: values.from,
    until: values.until,
    dryRun: values['dry-run'] === true,
  };
}

async function main(): Promise<void> {
  const { instruments, from, until, dryRun } = parse();
  const stores = localStores(instruments);
  const calendar = nyseCalendar();
  const provider = providers();
  const now = barTime(Math.floor(Date.now() / 1000));
  const today = new Date().toISOString().slice(0, 10);
  let clean = true;

  for (const instrument of instruments) {
    // Default: the last 7 days, but never before the provider's history.
    const lastWeek = addDays(today, -9);
    const earliest = DEFAULT_FROM[instrument.kind];
    const { start, moved } = startFor(instrument, from ?? (lastWeek > earliest ? lastWeek : earliest));
    console.log(`${instrument.symbol}: scanning ${start} to ${until ?? 'the last settled day'}${dryRun ? ' (dry run)' : ''}`);
    if (moved) console.log(`  (start moved to ${start}: the Massive plan serves nothing earlier)`);

    let source;
    try {
      source = provider(instrument);
    } catch (error) {
      if (error instanceof ProviderSetupError) usage(error.message);
      throw error;
    }
    const { report, recooked } = await repairAndRecook(
      { provider: source, raw: stores.raw, calendar, dryRun, minutes: stores.minutes, cooked: stores.cooked },
      instrument,
      { from: start, until, now, settleSeconds: SETTLE_SECONDS[instrument.kind] },
    );

    const sum = (key: 'holes' | 'filled' | 'confirmedEmpty' | 'differing'): number =>
      report.days.reduce((total, day) => total + day[key], 0);
    const failed = report.days.filter((day) => day.error !== undefined);
    console.log(
      `  ${report.scanned} days scanned (market hours), ${report.backfill.stored} missing days fetched, ` +
        `${report.days.length} days with holes: ${sum('holes')} minutes missing, ${sum('filled')} filled ` +
        `from ${report.provider}, ${sum('confirmedEmpty')} confirmed empty (no trades)` +
        (sum('differing') > 0 ? `; ${sum('differing')} stored minutes now differ at the provider (not changed)` : ''),
    );
    for (const day of report.days.filter((d) => d.filled > 0)) {
      console.log(`    ${day.date}: filled ${day.filled} of ${day.holes} missing minutes`);
    }
    const longest = report.days
      .filter((d) => d.confirmedEmpty >= 30)
      .map((d) => `${d.date} (${d.confirmedEmpty} min)`);
    if (longest.length > 0) console.log(`    long no-trade stretches confirmed: ${longest.join(', ')}`);
    for (const day of failed) console.log(`    ${day.date} FAILED: ${day.error}`);
    if (report.backfill.failed.length > 0 || report.backfill.aborted) {
      console.log(`    missing-day backfill failures: ${report.backfill.failed.map((f) => f.date).join(', ')}`);
    }
    if (recooked.length > 0) console.log(`  re-cooked ${recooked.join(', ')}`);
    else if (instrument.kind === 'stock' && report.monthsTouched.length > 0) {
      console.log(`  raw changed in ${report.monthsTouched.join(', ')}; stock re-cooking is M1-08`);
    }
    if (failed.length > 0 || report.backfill.failed.length > 0 || report.backfill.aborted) clean = false;
    console.log('');
  }
  process.exit(clean ? 0 : 1);
}

await main().catch((error: unknown) => {
  console.error(
    `${error instanceof Error ? error.message : String(error)}\n` +
      'Is the local stack up? Run: docker compose up -d',
  );
  process.exit(2);
});

