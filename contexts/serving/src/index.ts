// Public entry of the serving context (M1-16): what the platform promises its
// clients. The History API's rules and the live gateway with its wire
// protocol, both in display units, over the data layer (@aia/data).

export type { DisplayBar } from './domain/display-bar.js';
export { displayBar } from './domain/display-bar.js';
export type {
  HistoryBar,
  HistoryError,
  HistoryErrorCode,
  HistoryQueryDeps,
  HistoryRequest,
  HistoryResponse,
} from './application/history-query.js';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, HistoryQuery } from './application/history-query.js';
export type { LiveClientMessage, LiveErrorCode, LiveServerMessage, LiveWireUpdate } from './application/live-protocol.js';
export { LIVE_MAX_CLIENT_MESSAGE, parseClientMessage } from './application/live-protocol.js';
export type { Authorize, LiveGatewayDeps, LiveGatewayOptions, LiveSocket } from './application/live-gateway.js';
export { LIVE_CLOSE_TOO_SLOW, LiveGateway, LiveSession } from './application/live-gateway.js';
