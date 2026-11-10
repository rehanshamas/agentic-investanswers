// `pnpm rebuild-check`: re-cook every cooked month from raw, in memory, and
// diff it against the cooked store (CLAUDE.md rule 3). Writes nothing.
//
// Composition only: RebuildCheck and its report live in @aia/market-data.
//
//   pnpm rebuild-check                          BTCUSD and ETHUSD, 2024-11 to this month
//   pnpm rebuild-check --symbol BTCUSD --from 2026-01-01
//
// Exits 0 only when something was checked and nothing differs, 1 on any
// difference, and 2 when the stores cannot be read.

import { parseArgs } from 'node:util';

import {
  CRYPTO_PARITY_INSTRUMENTS,
  RebuildCheck,
  formatRebuildReport,
  parityInstrument,
  rebuildPassed,
} from '@aia/market-data';
import type { PartitionResult } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { nyseCalendar } from '@aia/shared-kernel';

import { localStores, monthsBetween } from './stores.js';

const DEFAULT_FROM = '2024-11-01';

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm rebuild-check [--symbol S]... [--from YYYY-MM-DD] [--until YYYY-MM-DD]`);
  process.exit(2);
}

function parse(): { instruments: Instrument[]; from: string; until: string } {
  const { values } = parseArgs({
    options: {
      symbol: { type: 'string', multiple: true },
      from: { type: 'string' },
      until: { type: 'string' },
    },
  });
  const instruments = (values.symbol ?? []).map((symbol) => {
    const instrument = parityInstrument(symbol) ?? usage(`Unknown symbol: ${symbol}`);
    // Raw stock bars keep Massive's precision (4-place prices, 6-place
    // volumes); turning them into whole-cent, whole-share bars is M1-08.
    if (instrument.kind === 'stock') usage(`${symbol} is a stock; cooking stocks is M1-08`);
    return instrument;
  });
  const date = /^\d{4}-\d{2}-\d{2}$/;
  const from = values.from ?? DEFAULT_FROM;
  const until = values.until ?? new Date().toISOString().slice(0, 10);
  if (!date.test(from) || !date.test(until)) usage('Dates must be YYYY-MM-DD');
  return {
    instruments: instruments.length > 0 ? instruments : [...CRYPTO_PARITY_INSTRUMENTS],
    from,
    until,
  };
}

async function main(): Promise<void> {
  const { instruments, from, until } = parse();
  const stores = localStores(instruments);
  const check = new RebuildCheck({ source: stores.minutes, store: stores.cooked, calendar: nyseCalendar() });
  const months = monthsBetween(from, until);
  console.log(
    `Rebuild check: ${instruments.map((i) => i.symbol).join(', ')}, ${months[0]} to ` +
      `${months[months.length - 1]}, raw and cooked at ${stores.endpoint}\n`,
  );

  const results: PartitionResult[] = [];
  try {
    for (const instrument of instruments) results.push(...(await check.run(instrument, months)));
  } catch (error) {
    console.error(
      `Could not read the bar stores at ${stores.endpoint}: ${String(error)}\n` +
        'Is the local stack up? Run: docker compose up -d',
    );
    process.exit(2);
  }

  console.log(formatRebuildReport(results, instruments));
  console.log('\n1D, 1W and 1M join the check once M1-08 cooks them.');
  process.exit(rebuildPassed(results) ? 0 : 1);
}

await main();
