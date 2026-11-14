// What the platform tells clients about its instruments. Pure.
//
//   GET /instruments   { instruments: InstrumentInfo[] }   (M2-05, for the chart)
//   MCP list_instruments   InstrumentListing[]             (M4-02, for agents)

import type { MarketKind, Timeframe } from '@aia/shared-kernel';

export interface InstrumentListing {
  readonly symbol: string;
  readonly kind: MarketKind;
  /** Timeframes with bars to serve now. */
  readonly timeframes: readonly Timeframe[];
  /** Of those, the ones the caller's plan includes. */
  readonly included: readonly Timeframe[];
}

/** A listing plus how to show its bars. */
export interface InstrumentInfo extends InstrumentListing {
  /** Decimal places in a price, as bars are sent. */
  readonly pricePrecision: number;
  /** Decimal places in a volume, as bars are sent. */
  readonly volumePrecision: number;
}

export interface InstrumentsResponse {
  readonly instruments: readonly InstrumentInfo[];
}
