# AGENTS.md: contexts/market-data
Owns: Instruments, market sessions, cooked bars for every timeframe, re-cooking from raw.
Does not own: Raw provider data (hydration), indicator output, backtests, user data.
Layers: src/domain (pure, imports only @aia/shared-kernel), src/application (use cases, ports), src/adapters (AWS, HTTP, providers).
May import: @aia/shared-kernel, other contexts only through their package entry (@aia/<context>).
Before you finish: pnpm check (and pnpm parity if bars changed, once it exists).
Stop and ask a human if: another context's interface must change, a new AWS service seems needed, or this file conflicts with the task.
