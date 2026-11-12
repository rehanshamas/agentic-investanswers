// Composition root for the platform process: HTTP API, WebSocket live updates, MCP tools.
// Wires adapters into handlers. No business rules here. `main.ts` runs it.
export type { ServerDeps } from './server.js';
export { buildServer } from './server.js';
