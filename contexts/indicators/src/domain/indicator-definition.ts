// IndicatorDefinition: the one shape every indicator takes (task M3-01).
// Pure.
//
// An indicator declares its inputs (the settings dialog is generated from them)
// and its outputs (what it draws), and computes one bar at a time:
//
//   init(settings)          -> state before the first bar
//   step(state, bar)        -> { state after this bar, raw outputs for this bar }
//
// `step` must not change the state it is given. That is what lets the engine
// keep the state after the last closed bar and recompute the forming bar from
// it on every trade, and extend a cached result by one bar instead of starting
// again (M3-04). ATR, the simple moving average (decision F-02) and any later
// indicator fit this shape, so adding one is a new definition and nothing else.
//
// Indicator source lives in agentic-investanswers-indicators (CLAUDE.md rule 5);
// this repo holds only the interface and test fakes.

import type { BarTime } from '@aia/shared-kernel';
import type { InputSpec, Settings, SourcePrices } from './inputs.js';
import { PRICE_SOURCES } from './inputs.js';
import type { BarOutputs, OutputSpec } from './outputs.js';

/** A bar as an indicator sees it: decimal prices, as TradingView scripts compute with. */
export interface IndicatorBar extends SourcePrices {
  readonly time: BarTime;
  readonly volume: number;
}

export interface StepResult<S> {
  readonly state: S;
  readonly outputs: BarOutputs;
}

export interface IndicatorDefinition<S = unknown> {
  /** Stable identifier, for example `sma`. Part of the output cache key. */
  readonly id: string;
  /**
   * Bumped whenever the drawn output could change for the same bars and
   * settings, so cached output from an older version is never served.
   */
  readonly version: string;
  /** Name shown to users. */
  readonly name: string;
  readonly inputs: readonly InputSpec[];
  readonly outputs: readonly OutputSpec[];
  /** State before the first bar. */
  init(settings: Settings): S;
  /** Advance by one bar. Must return a new state and leave `state` unchanged. */
  step(state: S, bar: IndicatorBar, settings: Settings): StepResult<S>;
}

export class IndicatorDefinitionError extends Error {}

const KEY = /^[a-z][a-zA-Z0-9_]*$/;

function checkKeys(id: string, what: string, keys: readonly string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (!KEY.test(key)) throw new IndicatorDefinitionError(`${id}: ${what} key "${key}" must match ${KEY}`);
    if (seen.has(key)) throw new IndicatorDefinitionError(`${id}: duplicate ${what} key "${key}"`);
    seen.add(key);
  }
}

function checkInput(id: string, input: InputSpec): void {
  const where = `${id}: input "${input.key}"`;
  switch (input.kind) {
    case 'int':
    case 'float': {
      const { min, max } = input;
      const step = input.step ?? 1;
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
        throw new IndicatorDefinitionError(`${where}: needs finite limits with min <= max`);
      }
      if (!(step > 0)) throw new IndicatorDefinitionError(`${where}: step must be positive`);
      if (input.kind === 'int' && ![min, max, input.default, step].every(Number.isInteger)) {
        throw new IndicatorDefinitionError(`${where}: limits, default and step must be whole numbers`);
      }
      if (input.default < min || input.default > max) {
        throw new IndicatorDefinitionError(`${where}: default ${input.default} is outside ${min}..${max}`);
      }
      return;
    }
    case 'bool':
      if (typeof input.default !== 'boolean') throw new IndicatorDefinitionError(`${where}: default must be true or false`);
      return;
    case 'choice':
      if (input.options.length === 0) throw new IndicatorDefinitionError(`${where}: needs at least one option`);
      if (new Set(input.options).size !== input.options.length) {
        throw new IndicatorDefinitionError(`${where}: options must be unique`);
      }
      if (!input.options.includes(input.default)) {
        throw new IndicatorDefinitionError(`${where}: default "${input.default}" is not one of the options`);
      }
      return;
    case 'source':
      if (!PRICE_SOURCES.includes(input.default)) {
        throw new IndicatorDefinitionError(`${where}: default "${input.default}" is not a price source`);
      }
      return;
  }
}

/**
 * Check a definition is well formed: identifier and version present, keys
 * unique, every default within its own limits, at least one output. The engine
 * runs this when an indicator is registered, so a broken definition fails at
 * start-up rather than on a user's chart.
 */
export function assertValidDefinition(definition: IndicatorDefinition<unknown>): void {
  const { id } = definition;
  if (!KEY.test(id)) throw new IndicatorDefinitionError(`Indicator id "${id}" must match ${KEY}`);
  if (definition.version.trim() === '') throw new IndicatorDefinitionError(`${id}: version is required`);
  if (definition.outputs.length === 0) throw new IndicatorDefinitionError(`${id}: declares no outputs`);
  checkKeys(id, 'input', definition.inputs.map((i) => i.key));
  checkKeys(id, 'output', definition.outputs.map((o) => o.key));
  for (const input of definition.inputs) checkInput(id, input);
}
