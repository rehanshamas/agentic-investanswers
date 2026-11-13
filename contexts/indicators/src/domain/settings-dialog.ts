// The settings dialog, described from an indicator's declared inputs.
// Pure. Task M3-02.
//
// The chart app draws the dialog from this description and never from the
// indicator itself, so adding an indicator (ATR later, decision F-02) needs no
// dialog code. The description is plain JSON: it can go over the History API
// to the browser or to an agent. It holds only what the user sets (labels,
// limits, current values), never how the indicator computes.

import type { IndicatorDefinition } from './indicator-definition.js';
import type { InputSpec, PriceSource, SettingValue, Settings } from './inputs.js';
import { PRICE_SOURCES, defaultSettings } from './inputs.js';

interface FieldBase {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
}

/** A number box with a spinner; the dialog stops values outside min..max. */
export interface NumberField extends FieldBase {
  readonly control: 'number';
  readonly value: number;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** True for whole numbers only. */
  readonly whole: boolean;
}

/** An on/off switch. */
export interface SwitchField extends FieldBase {
  readonly control: 'switch';
  readonly value: boolean;
  readonly default: boolean;
}

/** A drop-down list. */
export interface SelectField extends FieldBase {
  readonly control: 'select';
  readonly value: string;
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export type DialogField = NumberField | SwitchField | SelectField;

export interface SettingsDialog {
  readonly indicatorId: string;
  readonly title: string;
  readonly fields: readonly DialogField[];
}

const SOURCE_LABELS: Record<PriceSource, string> = {
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  hl2: '(High + Low) / 2',
  hlc3: '(High + Low + Close) / 3',
  ohlc4: '(Open + High + Low + Close) / 4',
};

function field(input: InputSpec, current: SettingValue | undefined): DialogField {
  const base = input.help === undefined ? { key: input.key, label: input.label } : { key: input.key, label: input.label, help: input.help };
  switch (input.kind) {
    case 'int':
    case 'float':
      return {
        ...base,
        control: 'number',
        value: typeof current === 'number' ? current : input.default,
        default: input.default,
        min: input.min,
        max: input.max,
        step: input.step ?? 1,
        whole: input.kind === 'int',
      };
    case 'bool':
      return { ...base, control: 'switch', value: typeof current === 'boolean' ? current : input.default, default: input.default };
    case 'choice':
      return {
        ...base,
        control: 'select',
        value: typeof current === 'string' ? current : input.default,
        default: input.default,
        options: input.options.map((o) => ({ value: o, label: o })),
      };
    case 'source':
      return {
        ...base,
        control: 'select',
        value: typeof current === 'string' ? current : input.default,
        default: input.default,
        options: PRICE_SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] })),
      };
  }
}

/**
 * Describe the settings dialog for an indicator, one field per declared input
 * in declared order, filled with `current` settings (already checked) or the
 * defaults.
 */
export function settingsDialog(definition: IndicatorDefinition<unknown>, current?: Settings): SettingsDialog {
  const values = current ?? defaultSettings(definition.inputs);
  return {
    indicatorId: definition.id,
    title: `${definition.name} settings`,
    fields: definition.inputs.map((input) => field(input, values[input.key])),
  };
}
