// Indicator settings as clients see them (M3-02): the settings dialog, the
// list of indicators and the answer to a settings check. The dialog is built
// from an indicator's declared inputs (@aia/indicators, settingsDialog) and
// the check is checkSettings; the platform hands both on in these shapes. Pure.
//
//   GET  /indicators
//   POST /indicators/:id/settings   body { settings: { key: value, ... } }
//
// Only what the user sets (labels, limits, values) ever crosses this
// boundary, never how an indicator computes (CLAUDE.md rule 5).

interface DialogFieldBase {
  readonly key: string;
  readonly label: string;
  readonly help?: string;
}

/** A number box with a spinner. */
export interface DialogNumberField extends DialogFieldBase {
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
export interface DialogSwitchField extends DialogFieldBase {
  readonly control: 'switch';
  readonly value: boolean;
  readonly default: boolean;
}

/** A drop-down list. */
export interface DialogSelectField extends DialogFieldBase {
  readonly control: 'select';
  readonly value: string;
  readonly default: string;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

export type DialogField = DialogNumberField | DialogSwitchField | DialogSelectField;

/** One field per declared input, in declared order, filled with current values. */
export interface IndicatorSettingsDialog {
  readonly indicatorId: string;
  readonly title: string;
  readonly fields: readonly DialogField[];
}

/** A setting value as sent and returned. */
export type IndicatorSettingValue = number | boolean | string;

export type IndicatorSettings = Readonly<Record<string, IndicatorSettingValue>>;

/** GET /indicators: every indicator the caller may add, its dialog at defaults. */
export interface IndicatorsResponse {
  readonly indicators: readonly {
    readonly id: string;
    readonly name: string;
    readonly dialog: IndicatorSettingsDialog;
  }[];
}

/** POST /indicators/:id/settings, accepted: defaults filled in, values on their step grid. */
export interface SettingsAccepted {
  readonly indicatorId: string;
  readonly settings: IndicatorSettings;
  /** The dialog refilled with the accepted settings. */
  readonly dialog: IndicatorSettingsDialog;
}

export type SettingFieldErrorCode =
  | 'not_an_object'
  | 'unknown_setting'
  | 'wrong_type'
  | 'not_whole'
  | 'out_of_range'
  | 'off_step'
  | 'not_an_option';

export interface SettingFieldError {
  /** The setting's key; empty when the whole body is wrong. */
  readonly key: string;
  readonly code: SettingFieldErrorCode;
  /** Plain words, safe to show to the user. */
  readonly message: string;
}

/** POST /indicators/:id/settings, refused (400): every field that is wrong. */
export interface InvalidSettingsBody {
  readonly error: {
    readonly code: 'invalid_settings';
    readonly message: string;
    readonly fields: readonly SettingFieldError[];
  };
}
