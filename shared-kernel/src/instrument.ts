// Instrument: a tradable symbol (docs/glossary.md).
//
// Carries the precision its bars are stored and compared at, settled here
// rather than later so every context inherits one answer. The scales come from
// the precision the TradingView export carries, because that is what parity is
// compared against (docs/bar-rules.md).

/** Crypto trades 24/7; stocks have market sessions. */
export type MarketKind = 'crypto' | 'stock';

export interface Instrument {
  /** Our identifier, as used in storage paths and API requests. For example `BTCUSD`, `NVDA`. */
  readonly symbol: string;
  readonly kind: MarketKind;
  /** Venue the bars come from. Bars differ between venues, so this is part of the identity. */
  readonly venue: string;
  /**
   * IANA zone the instrument's sessions and calendar dates are defined in.
   * `UTC` for crypto; `America/New_York` for US stocks.
   */
  readonly timeZone: string;
  /** Decimal places in a price: 2 means prices are whole cents. */
  readonly priceScale: number;
  /** Decimal places in a volume: 8 for crypto base units, 0 for whole shares. */
  readonly volumeScale: number;
  /**
   * Decimal places the *raw* store keeps prices at, when the provider sends
   * more than `priceScale`. Raw is the provider's record exactly as received
   * (CLAUDE.md rule 3), so it is not rounded to the export's precision; cooking
   * converts. Massive prints sub-penny stock prices to as many as 6 places
   * (for example 174.617297), so US stocks use 6. Defaults to `priceScale`.
   */
  readonly rawPriceScale?: number;
  /**
   * Decimal places the raw store keeps volumes at, for the same reason.
   * Massive reports fractional shares to 6 places. Defaults to `volumeScale`.
   * Kept separate from `volumeScale` because a month of stock volume at 6
   * places would leave the exact-integer range; a day does not.
   */
  readonly rawVolumeScale?: number;
}

/** The price scale raw bars are stored at (decided in M1-07). */
export function rawPriceScale(instrument: Instrument): number {
  return instrument.rawPriceScale ?? instrument.priceScale;
}

/** The volume scale raw bars are stored at (decided in M1-07). */
export function rawVolumeScale(instrument: Instrument): number {
  return instrument.rawVolumeScale ?? instrument.volumeScale;
}

export function isCrypto(instrument: Instrument): boolean {
  return instrument.kind === 'crypto';
}

export function hasSessions(instrument: Instrument): boolean {
  return instrument.kind === 'stock';
}

/** Smallest price increment, as a decimal string. Useful for display and for error messages. */
export function tickSize(instrument: Instrument): string {
  const { priceScale } = instrument;
  if (priceScale === 0) return '1';
  return `0.${'0'.repeat(priceScale - 1)}1`;
}
