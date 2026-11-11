// `pnpm gaps`: find minutes missing from raw within market hours, ask the
// provider which it has, store those as write-once fills, and re-cook the
// months that changed (M1-09). Composition only. Each day is checked against
// the provider the feed plan names for it (config/feeds.json, CLAUDE.md rule 7).
//
//   pnpm gaps                                  every symbol, the last 7 settled days
//   pnpm gaps --from 2024-11-01                everything stored
//   pnpm gaps --symbol BTCUSD --dry-run        report, write nothing
//
// Exits 0 when every hole is filled or confirmed empty, 1 when a re-fetch or
// write failed, and 2 on a setup error. Stocks are repaired but not re-cooked
// until M1-08.

import { parseArgs } from 'node:util';

import { FeedPlanError, FeedSetupError, feedsFor, historySegments, historyStart } from '@aia/hydration';
import { PARITY_INSTRUMENTS, parityInstrument } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { addDays, barTime, nyseCalendar } from '@aia/shared-kernel';

import { feedAdapters, loadFeedPlan } from './feeds.js';
import { dropCachedWindows } from './cache.js';
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
  let plan;
  let adapters;
  try {
    plan = loadFeedPlan();
    adapters = feedAdapters(plan, instruments.map((i) => i.symbol));
  } catch (error) {
    if (error instanceof FeedPlanError || error instanceof FeedSetupError) usage(error.message);
    throw error;
  }
  const stores = localStores(plan);
  const calendar = nyseCalendar();
  const now = barTime(Math.floor(Date.now() / 1000));
  const today = new Date().toISOString().slice(0, 10);
  let clean = true;
  const changed = new Set<string>();

  for (const instrument of instruments) {
    // Default: the last 7 days, but never before the plan's default start.
    const feeds = feedsFor(plan, instrument.symbol);
    const lastWeek = addDays(today, -9);
    const { start, moved } = historyStart(feeds, from ?? (lastWeek > feeds.defaultFrom ? lastWeek : feeds.defaultFrom));
    console.log(`${instrument.symbol}: scanning ${start} to ${until ?? 'the last settled day'}${dryRun ? ' (dry run)' : ''}`);
    if (moved) console.log(`  (start moved to ${start}: no provider in the feed plan serves earlier days)`);

    // One repair per provider when the range spans a switch in the feed plan.
    for (const segment of historySegments(feeds, start, until)) {
      const { report, recooked } = await repairAndRecook(
        {
          provider: adapters.historyProvider(segment.source.provider),
          raw: stores.raw,
          calendar,
          dryRun,
          minutes: stores.minutes,
          cooked: stores.cooked,
        },
        instrument,
        { from: segment.from, until: segment.until, now, settleSeconds: segment.source.settleSeconds },
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
      if (report.monthsTouched.length > 0) changed.add(instrument.symbol);
      if (recooked.length > 0) console.log(`  re-cooked ${recooked.join(', ')}`);
      else if (instrument.kind === 'stock' && report.monthsTouched.length > 0) {
        console.log(`  raw changed in ${report.monthsTouched.join(', ')}; stock re-cooking is M1-08`);
      }
      if (failed.length > 0 || report.backfill.failed.length > 0 || report.backfill.aborted) clean = false;
    }
    console.log('');
  }
  // Raw and cooked bars changed outside BarClosed: drop those cached windows (M2-02).
  try {
    await dropCachedWindows([...changed]);
  } catch (error) {
    console.error(`Could not drop the cached windows of ${[...changed].join(', ')}, which may now be stale: ${String(error)}`);
    clean = false;
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

