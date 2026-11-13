// What an indicator draws: lines, bands, markers and levels.
// Pure.
//
// CLAUDE.md rule 5: only drawn outputs at display precision leave the engine.
// An indicator returns raw decimals; `toDrawn` rounds them to the instrument's
// price precision and keeps only declared outputs, so intermediate values an
// indicator computes can never reach the API, the WebSocket or an agent.

import type { BarTime } from '@aia/shared-kernel';

interface OutputBase {
  /** Key in each bar's output values. */
  readonly key: string;
  /** Name shown in the chart legend. */
  readonly label: string;
}

/** One value per bar, joined into a line. */
export interface LineOutput extends OutputBase {
  readonly kind: 'line';
}

/** An upper and a lower value per bar, drawn as a filled band. */
export interface BandOutput extends OutputBase {
  readonly kind: 'band';
}

/** A marker on some bars, for example a buy or sell signal. */
export interface MarkerOutput extends OutputBase {
  readonly kind: 'marker';
}

/** A horizontal level, for example a stop or a target; drawn flat until it changes. */
export interface LevelOutput extends OutputBase {
  readonly kind: 'level';
}

export type OutputSpec = LineOutput | BandOutput | MarkerOutput | LevelOutput;
export type OutputKind = OutputSpec['kind'];

export interface BandValue {
  readonly upper: number;
  readonly lower: number;
}

export interface MarkerValue {
  /** Drawn above or below the bar. */
  readonly side: 'above' | 'below';
  /** Price the marker points at. */
  readonly price: number;
  /** Short label, for example "Buy". */
  readonly text?: string;
}

/**
 * What an indicator returns for one output on one bar. `null` means nothing is
 * drawn on this bar (TradingView's `na`), for example during warm-up.
 */
export type OutputValue = number | BandValue | MarkerValue | null;

/** What an indicator returns for one bar, keyed by output key. */
export type BarOutputs = Readonly<Record<string, OutputValue>>;

/** One bar of drawn output: display precision, declared outputs only. */
export interface DrawnPoint {
  readonly time: BarTime;
  readonly values: Readonly<Record<string, OutputValue>>;
}

export class OutputError extends Error {}

/** Longest marker label drawn; longer labels are cut. Enough for "Buy", "Sell", "Exit long". */
export const MARKER_TEXT_MAX = 16;

function round(value: number, priceScale: number, where: string): number | null {
  if (Number.isNaN(value)) return null;
  if (!Number.isFinite(value)) throw new OutputError(`${where} is not a finite number: ${value}`);
  // Round to the tick, ties up, as TradingView's math.round_to_mintick
  // intends (round(value / tick) * tick), so plotted values can be compared
  // "to the tick" in the parity harness (M3-03). Multiplying a half-tick value
  // such as 1.005 by 100 gives 100.49999999999999, so the product is first cut
  // to 15 significant digits (the most a float64 holds exactly in decimal),
  // which puts it back on the tie: 1.005 -> 1.01, 0.145 -> 0.15.
  const factor = 10 ** priceScale;
  const rounded = Math.round(Number((value * factor).toPrecision(15))) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function drawnValue(spec: OutputSpec, value: OutputValue | undefined, priceScale: number, where: string): OutputValue {
  if (value === undefined || value === null) return null;
  switch (spec.kind) {
    case 'line':
    case 'level': {
      if (typeof value !== 'number') throw new OutputError(`${where} (${spec.kind}) must be a number or null`);
      return round(value, priceScale, where);
    }
    case 'band': {
      if (!isObject(value) || typeof value.upper !== 'number' || typeof value.lower !== 'number') {
        throw new OutputError(`${where} (band) must be { upper, lower } or null`);
      }
      const upper = round(value.upper, priceScale, `${where}.upper`);
      const lower = round(value.lower, priceScale, `${where}.lower`);
      return upper === null || lower === null ? null : { upper, lower };
    }
    case 'marker': {
      if (!isObject(value) || typeof value.price !== 'number' || (value.side !== 'above' && value.side !== 'below')) {
        throw new OutputError(`${where} (marker) must be { side, price, text? } or null`);
      }
      const markerPrice = round(value.price, priceScale, `${where}.price`);
      if (markerPrice === null) return null;
      // Capped, so a marker label cannot carry internal values out (rule 5).
      const text = typeof value.text === 'string' ? value.text.slice(0, MARKER_TEXT_MAX) : undefined;
      return text === undefined ? { side: value.side, price: markerPrice } : { side: value.side, price: markerPrice, text };
    }
  }
}

/**
 * Turn an indicator's raw outputs for one bar into a drawn point: every declared
 * output present (null where nothing is drawn), rounded to `priceScale` decimal
 * places, and nothing else. A value of the wrong shape is a bug in the
 * indicator and throws, rather than drawing something misleading.
 */
export function toDrawn(
  outputs: readonly OutputSpec[],
  time: BarTime,
  raw: BarOutputs,
  priceScale: number,
): DrawnPoint {
  const values: Record<string, OutputValue> = {};
  for (const spec of outputs) {
    values[spec.key] = drawnValue(spec, raw[spec.key], priceScale, `Output "${spec.key}" at ${time}`);
  }
  return { time, values };
}
