// Public entry of the client contract (M2-05): what the platform promises its
// clients over HTTP and WebSocket, as types and pure checks only. The browser
// may import it, since it depends on nothing but the kernel; @aia/serving and
// the platform build their responses to it. The rules that produce them are
// @aia/serving's.

export type { DisplayBar } from './domain/display-bar.js';
export type { ApiErrorBody, HistoryBar, HistoryError, HistoryErrorCode, HistoryResponse } from './domain/history.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT } from './domain/history.js';
export type { InstrumentInfo, InstrumentListing, InstrumentsResponse } from './domain/instruments.js';
export type { LiveClientMessage, LiveErrorCode, LiveServerMessage, LiveWireUpdate } from './domain/live-protocol.js';
export { LIVE_MAX_CLIENT_MESSAGE, parseClientMessage } from './domain/live-protocol.js';
export type {
  DialogField,
  DialogNumberField,
  DialogSelectField,
  DialogSwitchField,
  IndicatorSettingValue,
  IndicatorSettings,
  IndicatorSettingsDialog,
  IndicatorsResponse,
  InvalidSettingsBody,
  SettingFieldError,
  SettingFieldErrorCode,
  SettingsAccepted,
} from './domain/indicator-settings.js';
