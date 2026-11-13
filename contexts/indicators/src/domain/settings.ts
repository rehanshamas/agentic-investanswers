// Checking the settings a user (or an agent) asks an indicator to run with.
// Pure. Task M3-02.
//
// Settings arrive from the browser or an agent, so they are untrusted: every
// value is checked against the input declared for it, and anything out of
// range, of the wrong type or undeclared is refused with a reason per field.
// Keys left out take their declared default. The server runs this before any
// bar is read; the dialog's own limits are a convenience, not the check.

import type { InputSpec, SettingValue, Settings } from './inputs.js';
import { PRICE_SOURCES } from './inputs.js';

export type SettingErrorCode = 'not_an_object' | 'unknown_setting' | 'wrong_type' | 'not_whole' | 'out_of_range' | 'not_an_option';

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

function checkValue(input: InputSpec, value: unknown): SettingError | undefined {
  const fail = (code: SettingErrorCode, message: string): SettingError => ({ key: input.key, code, message });
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
      return undefined;
    }
    case 'bool':
      return typeof value === 'boolean' ? undefined : fail('wrong_type', `${input.label} must be on or off`);
    case 'choice':
      if (typeof value !== 'string') return fail('wrong_type', `${input.label} must be one of the listed options`);
      return input.options.includes(value)
        ? undefined
        : fail('not_an_option', `${input.label} must be one of: ${input.options.join(', ')}`);
    case 'source':
      if (typeof value !== 'string') return fail('wrong_type', `${input.label} must be a price source`);
      return (PRICE_SOURCES as readonly string[]).includes(value)
        ? undefined
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
    const error = checkValue(input, value);
    if (error) errors.push(error);
    else settings[input.key] = value as SettingValue;
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
