// Which provider serves an instrument's 1-minute history, and its limits.
// Shared by the backfill and gap-repair commands.

import type { HistoryProviderPort } from '@aia/hydration';
import { CoinbaseCandles, MassiveAggregates } from '@aia/hydration';
import type { Instrument } from '@aia/shared-kernel';

/**
 * The earliest day the current Massive plan serves: history is a rolling two
 * years (measured 2026-11-10; 2024-11-08 and before answered 403).
 */
export const MASSIVE_EARLIEST = '2024-11-11';

export const DEFAULT_FROM = { crypto: '2024-11-01', stock: MASSIVE_EARLIEST };

/**
 * How long a day must have ended before it is stored. Raw is write-once, so a
 * day must be final first. Crypto: 1 hour. Stocks: 2 days (Sham, M1-07),
 * because Massive's newest day can still change: on 2026-11-10 only the
 * previous day carried 6-decimal prints, a sign of corrections still to come.
 */
export const SETTLE_SECONDS = { crypto: 60 * 60, stock: 2 * 24 * 60 * 60 };

export class ProviderSetupError extends Error {}

/** Coinbase for crypto (M1-04), Massive for stocks (M1-07, needs MASSIVE_API_KEY). */
export function providers(env: NodeJS.ProcessEnv = process.env): (instrument: Instrument) => HistoryProviderPort {
  let coinbase: CoinbaseCandles | undefined;
  let massive: MassiveAggregates | undefined;
  return (instrument) => {
    if (instrument.kind === 'crypto') return (coinbase ??= new CoinbaseCandles());
    const apiKey = env['MASSIVE_API_KEY'] ?? '';
    if (apiKey === '') throw new ProviderSetupError('MASSIVE_API_KEY is not set (put it in .env).');
    return (massive ??= new MassiveAggregates({ apiKey }));
  };
}

/**
 * A start date no earlier than the provider can serve. Asking Massive for
 * days before its plan's limit fails the whole multi-day request, including
 * the days after the limit, so the start is moved forward instead.
 */
export function startFor(instrument: Instrument, from: string | undefined): { start: string; moved: boolean } {
  const earliest = DEFAULT_FROM[instrument.kind];
  if (from === undefined) return { start: earliest, moved: false };
  if (instrument.kind === 'stock' && from < earliest) return { start: earliest, moved: true };
  return { start: from, moved: false };
}
