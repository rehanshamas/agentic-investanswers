// Public entry of the serving context (M1-16): what the platform promises its
// clients. The History API's rules and the live gateway, both in display
// units, over the data layer (@aia/data). The shapes clients see (responses,
// the wire protocol) are the client contract's (@aia/client-contract, M2-05),
// re-exported here so server code has one import.

export type {
  DisplayBar,
  HistoryBar,
  HistoryError,
  HistoryErrorCode,
  HistoryResponse,
  LiveClientMessage,
  LiveErrorCode,
  LiveServerMessage,
  LiveWireUpdate,
} from '@aia/client-contract';
export { HISTORY_DEFAULT_LIMIT, HISTORY_MAX_LIMIT, LIVE_MAX_CLIENT_MESSAGE, parseClientMessage } from '@aia/client-contract';
export { displayBar } from './application/display-bar.js';
export type { HistoryQueryDeps, HistoryRequest } from './application/history-query.js';
export { HistoryQuery } from './application/history-query.js';
export type { Authorize, LiveGatewayDeps, LiveGatewayOptions, LiveSocket } from './application/live-gateway.js';
export { LIVE_CLOSE_TOO_SLOW, LiveGateway, LiveSession } from './application/live-gateway.js';
