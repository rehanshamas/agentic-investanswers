// The chart app (M2-05): React + KLineChart in the browser. Its entry is
// main.tsx (Vite); this exports the framework-free data client, for other
// browser front ends (the embed, M2-11).

export type { BarSeriesDeps, SeriesEvent, SeriesStatus } from './data/bar-series.js';
export { BarSeries } from './data/bar-series.js';
export type { ConnectionState, LiveConnectionOptions, LiveListener, SocketLike, Timers } from './data/live-connection.js';
export { LiveConnection, browserSocket } from './data/live-connection.js';
export type { PlatformClientOptions } from './data/platform-client.js';
export { ApiError, PlatformClient, storedToken } from './data/platform-client.js';
