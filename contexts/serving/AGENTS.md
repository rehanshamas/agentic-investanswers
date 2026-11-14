# AGENTS.md: contexts/serving
Owns: What the platform promises its clients (M1-16): the History API's rules (parameters, the bars-per-request cap, display units) and the live gateway with its wire protocol (subscriptions, batching, resync, slow clients).
Does not own: Bars (it gets them from @aia/data), who may see what (access), HTTP or WebSocket libraries (the platform app maps these use cases onto Fastify).
Layers: src/application (use cases, including the bar-to-display-units mapping), src/adapters. Pure shapes live in @aia/client-contract.
May import: @aia/shared-kernel, @aia/client-contract (the shapes clients see: change them only as a contract change), @aia/data. Never @aia/hydration or @aia/market-data (eslint.config.mjs, tag layer:product).
Before you finish: pnpm check.
Stop and ask a human if: the History API or the live protocol must change in a way clients notice, or this file conflicts with the task.
