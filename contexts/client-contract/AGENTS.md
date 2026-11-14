# AGENTS.md: contexts/client-contract
Owns: What the platform promises its clients (M2-05), as types and pure checks: bars in display units, History API responses and errors, the instrument listing, and the live wire protocol. One source of truth for the server (@aia/serving, apps/platform) and the browser (apps/web-chart).
Does not own: The rules that produce these (@aia/serving), HTTP or WebSocket code, anything stateful.
Layers: src/domain only (pure, imports only @aia/shared-kernel).
May import: @aia/shared-kernel. Nothing else: the browser imports this package, so it must never reach the data layer (eslint.config.mjs, tag runtime:browser).
Before you finish: pnpm check.
Stop and ask a human if: a change here alters what clients receive or send (that is a contract change), or this file conflicts with the task.
