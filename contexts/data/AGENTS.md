# AGENTS.md: contexts/data
Owns: The data layer's one front door (M1-16): `DataAccess`, the only way the rest of the app gets bars (instruments, what is served, history pages, ranges, live updates), and its adapters: in process on S3 and Redis (`openLocalDataLayer`), in memory (`MemoryDataLayer`), and a simulated live feed for load tests and demos.
Does not own: How bars are stored, cooked or cached (market-data), provider data (hydration), anything shown to clients (serving).
Layers: src/application (the interface, the in-process composition, the contract tests), src/adapters (local, memory, simulated). Bars stay in our scaled units here; formatting for clients is @aia/serving's.
May import: @aia/shared-kernel, @aia/hydration and @aia/market-data through their package entries. Everything else imports the data layer only from here (eslint.config.mjs, tag layer:data).
Rule: any new adapter (for example a remote one, if the data layer runs as its own service) must pass the contract in src/application/data-access.contract.ts.
Before you finish: pnpm check (and pnpm parity and pnpm rebuild-check if bars changed).
Stop and ask a human if: DataAccess must change shape, a new AWS service seems needed, or this file conflicts with the task.
