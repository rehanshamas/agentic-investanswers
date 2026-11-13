// Public entry of the indicators context. Other packages import only from here.

export type {
  BoolInput,
  ChoiceInput,
  FloatInput,
  InputSpec,
  IntInput,
  PriceSource,
  SettingValue,
  Settings,
  SourceInput,
  SourcePrices,
} from './domain/inputs.js';
export { PRICE_SOURCES, defaultSettings, priceFromSource } from './domain/inputs.js';

export type {
  BandOutput,
  BandValue,
  BarOutputs,
  DrawnPoint,
  LevelOutput,
  LineOutput,
  MarkerOutput,
  MarkerValue,
  OutputKind,
  OutputSpec,
  OutputValue,
} from './domain/outputs.js';
export { OutputError, toDrawn } from './domain/outputs.js';

export type { IndicatorBar, IndicatorDefinition, StepResult } from './domain/indicator-definition.js';
export { IndicatorDefinitionError, assertValidDefinition } from './domain/indicator-definition.js';

export type { IndicatorRun } from './domain/stepping.js';
export { SteppingError, commit, indicatorBar, preview, runAll, startRun } from './domain/stepping.js';

export type { SettingError, SettingErrorCode, SettingsCheck } from './domain/settings.js';
export { checkSettings, settingsKey } from './domain/settings.js';

export type { DialogField, NumberField, SelectField, SettingsDialog, SwitchField } from './domain/settings-dialog.js';
export { settingsDialog } from './domain/settings-dialog.js';
