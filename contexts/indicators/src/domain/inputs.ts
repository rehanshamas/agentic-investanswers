// The settings an indicator declares (docs/glossary.md: "indicator").
// Pure.
//
// Each declared input becomes one field of the settings dialog (M3-02) and one
// key of the settings object the indicator runs with. Number inputs always
// carry limits, so out-of-range values can be refused before any bar is read.

/** Which price of a bar an input reads, as in a TradingView `source` input. */
export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4';

export const PRICE_SOURCES: readonly PriceSource[] = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4'];

interface InputBase {
  /** Key in the settings object. Stable across versions; part of the output cache key. */
  readonly key: string;
  /** Label shown in the settings dialog. */
  readonly label: string;
  /** Optional help text shown under the field. */
  readonly help?: string;
}

/** A whole number with limits, for example a length in bars. */
export interface IntInput extends InputBase {
  readonly kind: 'int';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Increment of the dialog's spinner; values must be min + a whole number of steps. Defaults to 1. */
  readonly step?: number;
}

/** A decimal with limits, for example a multiplier. */
export interface FloatInput extends InputBase {
  readonly kind: 'float';
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Increment of the dialog's spinner; values must be min + a whole number of steps (checked server-side). */
  readonly step: number;
}

/** An on/off switch. */
export interface BoolInput extends InputBase {
  readonly kind: 'bool';
  readonly default: boolean;
}

/** One of a fixed list of options. */
export interface ChoiceInput extends InputBase {
  readonly kind: 'choice';
  readonly options: readonly string[];
  readonly default: string;
}

/** Which price of the bar to read. */
export interface SourceInput extends InputBase {
  readonly kind: 'source';
  readonly default: PriceSource;
}

export type InputSpec = IntInput | FloatInput | BoolInput | ChoiceInput | SourceInput;

export type SettingValue = number | boolean | string;

/** The values an indicator runs with, one per declared input key. */
export type Settings = Readonly<Record<string, SettingValue>>;

/** The settings an indicator runs with when the user changed nothing. */
export function defaultSettings(inputs: readonly InputSpec[]): Settings {
  const settings: Record<string, SettingValue> = {};
  for (const input of inputs) settings[input.key] = input.default;
  return settings;
}

/** A bar's prices in decimals, which is what indicators compute with. */
export interface SourcePrices {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** The price a `source` input selects from a bar. */
export function priceFromSource(bar: SourcePrices, source: PriceSource): number {
  switch (source) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'close':
      return bar.close;
    case 'hl2':
      return (bar.high + bar.low) / 2;
    case 'hlc3':
      return (bar.high + bar.low + bar.close) / 3;
    case 'ohlc4':
      return (bar.open + bar.high + bar.low + bar.close) / 4;
  }
}
