# AGENTS.md: contexts/hydration
Owns: Raw provider data: backfill, live streams, the write-once raw store, gap detection and re-fetch.
Does not own: Cooked bars, indicator output, user data.
Layers: src/domain (pure, imports only @aia/shared-kernel), src/application (use cases, ports), src/adapters (AWS, HTTP, providers).
May import: @aia/shared-kernel, other contexts only through their package entry (@aia/<context>).
Before you finish: pnpm check (and pnpm parity if bars changed, once it exists).
Stop and ask a human if: another context's interface must change, a new AWS service seems needed, or this file conflicts with the task.
