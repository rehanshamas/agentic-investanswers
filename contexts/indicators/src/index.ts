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
export { MARKER_TEXT_MAX, OutputError, toDrawn } from './domain/outputs.js';

export type { IndicatorBar, IndicatorDefinition, StepResult } from './domain/indicator-definition.js';
export { IndicatorDefinitionError, assertValidDefinition } from './domain/indicator-definition.js';

export type { IndicatorRun } from './domain/stepping.js';
export { SteppingError, commit, indicatorBar, preview, runAll, startRun } from './domain/stepping.js';

export type { SettingError, SettingErrorCode, SettingsCheck } from './domain/settings.js';
export { checkSettings, settingsKey } from './domain/settings.js';

export type { DialogField, NumberField, SelectField, SettingsDialog, SwitchField } from './domain/settings-dialog.js';
export { settingsDialog } from './domain/settings-dialog.js';

export { RUN_WINDOW_BARS, runStart } from './domain/run-window.js';

export type { ClosedBarsQuery, IndicatorBarSourcePort } from './application/indicator-bar-source-port.js';
export type { IndicatorOutputCachePort } from './application/indicator-output-cache-port.js';
export type { EngineStats, IndicatorEngineDeps, IndicatorRequest, IndicatorResult } from './application/indicator-engine.js';
export {
  ENGINE_CACHE_TTL_SECONDS,
  ENGINE_MAX_POINTS,
  IndicatorEngine,
  IndicatorRegistry,
  IndicatorRegistryError,
} from './application/indicator-engine.js';

export { MemoryIndicatorOutputCache } from './adapters/memory-indicator-output-cache.js';
export type { RedisIndicatorCacheOptions } from './adapters/redis-indicator-output-cache.js';
export { IndicatorOutputCacheError, RedisIndicatorOutputCache } from './adapters/redis-indicator-output-cache.js';
