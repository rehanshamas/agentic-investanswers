// The four instruments docs/bar-rules.md names for parity, with the precision
// their exports actually carry. Pure data; imports only @aia/shared-kernel.
//
// The scales are measured, not assumed. `parseScaled` throws rather than
// rounds, so a scale that is one too small turns the loader into an error on
// the single row that needs it.

import type { Instrument } from '@aia/shared-kernel';

/**
 * BTC. Price never exceeded 2 decimal places across all 8 exports.
 *
 * Volume is the venue's 8 decimal places. About one row per higher-timeframe
 * file carries more, which is float noise in TradingView's own summation
 * (worst measured 2.84e-14 on `btcusd_1h.csv`); the loader rounds that away
 * only after proving it is noise.
 */
export const BTCUSD: Instrument = {
  symbol: 'BTCUSD',
  kind: 'crypto',
  venue: 'COINBASE',
  timeZone: 'UTC',
  priceScale: 2,
  volumeScale: 8,
};

/**
 * ETH. **3** price decimal places, not 2.
 *
 * Measured: 2 rows of 3,822 in `ethusd_1d.csv` carry three, on 2020-05-28 and
 * 2020-05-29 (for example `H=220.675`, `L=217.535`). Those are clean
 * half-cent values rather than float artifacts, so the scale has to hold them
 * or the daily fixture cannot be loaded at all.
 */
export const ETHUSD: Instrument = {
  symbol: 'ETHUSD',
  kind: 'crypto',
  venue: 'COINBASE',
  timeZone: 'UTC',
  priceScale: 3,
  volumeScale: 8,
};

/**
 * NVDA. Venue is provisional: OI-27 settles whether we compare against
 * Nasdaq or Cboe BZX, once M1-07 reveals what Massive serves. Volume is whole
 * shares, so scale 0.
 */
export const NVDA: Instrument = {
  symbol: 'NVDA',
  kind: 'stock',
  venue: 'NASDAQ',
  timeZone: 'America/New_York',
  priceScale: 2,
  volumeScale: 0,
};

/** TSLA. Same provisional venue note as NVDA. */
export const TSLA: Instrument = {
  symbol: 'TSLA',
  kind: 'stock',
  venue: 'NASDAQ',
  timeZone: 'America/New_York',
  priceScale: 2,
  volumeScale: 0,
};

/** Both crypto instruments: the set with complete, verified fixtures today. */
export const CRYPTO_PARITY_INSTRUMENTS: readonly Instrument[] = [BTCUSD, ETHUSD];

/** Both stock instruments. Their fixtures await OI-27. */
export const STOCK_PARITY_INSTRUMENTS: readonly Instrument[] = [NVDA, TSLA];

export const PARITY_INSTRUMENTS: readonly Instrument[] = [
  ...CRYPTO_PARITY_INSTRUMENTS,
  ...STOCK_PARITY_INSTRUMENTS,
];

export function parityInstrument(symbol: string): Instrument | undefined {
  return PARITY_INSTRUMENTS.find((i) => i.symbol === symbol.toUpperCase());
}
