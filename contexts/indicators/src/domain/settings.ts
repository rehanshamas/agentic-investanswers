// Checking the settings a user (or an agent) asks an indicator to run with.
// Pure. Task M3-02.
//
// Settings arrive from the browser or an agent, so they are untrusted: every
// value is checked against the input declared for it, and anything out of
// range, of the wrong type or undeclared is refused with a reason per field.
// Number values must sit on the input's step grid (min, min + step, ...), so
// two requests meaning the same value share one cache key. Keys left out take
// their declared default. The server runs this before any
// bar is read; the dialog's own limits are a convenience, not the check.

import type { InputSpec, SettingValue, Settings } from './inputs.js';
import { PRICE_SOURCES } from './inputs.js';

export type SettingErrorCode =
  | 'not_an_object'
  | 'unknown_setting'
  | 'wrong_type'
  | 'not_whole'
  | 'out_of_range'
  | 'off_step'
  | 'not_an_option';

export interface SettingError {
  /** The setting's key; empty when the whole value is wrong. */
  readonly key: string;
  readonly code: SettingErrorCode;
  /** Plain words, safe to show to the user. */
  readonly message: string;
}

export type SettingsCheck =
  | { readonly ok: true; readonly settings: Settings }
  | { readonly ok: false; readonly errors: readonly SettingError[] };

/** Decimal places of a step such as 0.25 (2) or 5 (0). */
function decimalsOf(step: number): number {
  const text = step.toString();
  const exponent = /e-(\d+)$/.exec(text);
  if (exponent) return Number(exponent[1]);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

/**
 * A number input's value on its step grid (min, min + step, min + 2 step, ...),
 * or undefined when it is off the grid. A tiny tolerance absorbs float noise
 * such as 0.30000000000000004 for 0.3; the value returned is the grid point
 * itself, so equal settings always give the same cache key.
 */
function onStepGrid(value: number, min: number, step: number): number | undefined {
  const steps = (value - min) / step;
  const whole = Math.round(steps);
  if (Math.abs(steps - whole) > 1e-9) return undefined;
  const decimals = Math.min(12, Math.max(decimalsOf(step), decimalsOf(min)));
  return Number((min + whole * step).toFixed(decimals));
}

type ValueCheck = { readonly value: SettingValue } | { readonly error: SettingError };

function checkValue(input: InputSpec, value: unknown): ValueCheck {
  const fail = (code: SettingErrorCode, message: string): ValueCheck => ({ error: { key: input.key, code, message } });
  switch (input.kind) {
    case 'int':
    case 'float': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fail('wrong_type', `${input.label} must be a number`);
      }
      if (input.kind === 'int' && !Number.isInteger(value)) {
        return fail('not_whole', `${input.label} must be a whole number`);
      }
      if (value < input.min || value > input.max) {
        return fail('out_of_range', `${input.label} must be between ${input.min} and ${input.max}`);
      }
      const step = input.step ?? 1;
      const snapped = onStepGrid(value, input.min, step);
      if (snapped === undefined) {
        return fail('off_step', `${input.label} must go in steps of ${step} from ${input.min}`);
      }
      return { value: snapped };
    }
    case 'bool':
      return typeof value === 'boolean' ? { value } : fail('wrong_type', `${input.label} must be on or off`);
    case 'choice':
      if (typeof value !== 'string') return fail('wrong_type', `${input.label} must be one of the listed options`);
      return input.options.includes(value)
        ? { value }
        : fail('not_an_option', `${input.label} must be one of: ${input.options.join(', ')}`);
    case 'source':
      if (typeof value !== 'string') return fail('wrong_type', `${input.label} must be a price source`);
      return (PRICE_SOURCES as readonly string[]).includes(value)
        ? { value }
        : fail('not_an_option', `${input.label} must be one of: ${PRICE_SOURCES.join(', ')}`);
  }
}

/**
 * Check `given` against the declared inputs. Returns the complete settings
 * (defaults filled in, in declared order) or every problem found.
 */
export function checkSettings(inputs: readonly InputSpec[], given: unknown): SettingsCheck {
  if (given === undefined || given === null) given = {};
  if (typeof given !== 'object' || Array.isArray(given)) {
    return { ok: false, errors: [{ key: '', code: 'not_an_object', message: 'Settings must be an object of named values' }] };
  }
  const values = given as Record<string, unknown>;
  const errors: SettingError[] = [];
  const declared = new Set(inputs.map((i) => i.key));
  for (const key of Object.keys(values)) {
    if (!declared.has(key)) errors.push({ key, code: 'unknown_setting', message: `"${key}" is not a setting of this indicator` });
  }
  const settings: Record<string, SettingValue> = {};
  for (const input of inputs) {
    const value = Object.hasOwn(values, input.key) ? values[input.key] : input.default;
    const checked = checkValue(input, value);
    if ('error' in checked) errors.push(checked.error);
    else settings[input.key] = checked.value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, settings };
}

/**
 * A stable text form of checked settings, in declared order, for cache keys
 * (indicator + version + instrument + timeframe + settings, M3-04). Two
 * requests that mean the same settings give the same key, whatever order or
 * omissions they arrived with.
 */
export function settingsKey(inputs: readonly InputSpec[], settings: Settings): string {
  return JSON.stringify(inputs.map((input) => [input.key, settings[input.key] ?? input.default]));
}
