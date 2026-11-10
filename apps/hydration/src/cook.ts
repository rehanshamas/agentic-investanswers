// `pnpm cook`: cook the intraday timeframes (5m, 15m, 1h, 4h) from raw 1m.
//
// Composition only: CookIntraday lives in @aia/market-data. It works month by
// month, reading each month's raw minutes once and writing each timeframe's
// month partition whole, so memory stays bounded and a re-run simply replaces
// what it wrote (cooked is always rebuildable from raw, CLAUDE.md rule 3).
//
//   pnpm cook                                   BTCUSD and ETHUSD, 2024-11 to this month
//   pnpm cook --symbol ETHUSD --from 2025-06-01 --until 2025-08-31
//
// 1D, 1W and 1M are not cooked until M1-08.

import { parseArgs } from 'node:util';

import { CRYPTO_PARITY_INSTRUMENTS, CookIntraday, parityInstrument } from '@aia/market-data';
import type { Instrument } from '@aia/shared-kernel';
import { nyseCalendar } from '@aia/shared-kernel';

import { localStores, monthsBetween } from './stores.js';

const DEFAULT_FROM = '2024-11-01';

function usage(message: string): never {
  console.error(`${message}\nUsage: pnpm cook [--symbol S]... [--from YYYY-MM-DD] [--until YYYY-MM-DD]`);
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
  const cook = new CookIntraday({ source: stores.minutes, store: stores.cooked, calendar: nyseCalendar() });
  const months = monthsBetween(from, until);

  for (const instrument of instruments) {
    console.log(`Cooking ${instrument.symbol} 5m 15m 1h 4h, ${months[0]} to ${months[months.length - 1]}, into ${stores.endpoint}`);
    let total = 0;
    for (const month of months) {
      const written = await cook.cookPartition(instrument, month);
      const counts = [...written.entries()].map(([tf, n]) => `${tf} ${n}`).join(', ');
      total += [...written.values()].reduce((a, b) => a + b, 0);
      console.log(`  ${instrument.symbol} ${month}: ${counts}`);
    }
    console.log(`  ${instrument.symbol}: ${total} bars written across ${months.length} months\n`);
  }
  console.log('1D, 1W and 1M are not cooked yet (M1-08).');
}

await main().catch((error: unknown) => {
  console.error(
    `${error instanceof Error ? error.message : String(error)}\n` +
      'Is the local stack up? Run: docker compose up -d',
  );
  process.exit(2);
});
