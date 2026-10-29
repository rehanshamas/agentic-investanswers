# AGENTS.md: contexts/agent
Owns: Agent identity, read-only MCP tools and agent API queries.
Does not own: New business logic: tools call queries owned by other contexts.
Layers: src/domain (pure, imports only @aia/shared-kernel), src/application (use cases, ports), src/adapters (AWS, HTTP, providers).
May import: @aia/shared-kernel, other contexts only through their package entry (@aia/<context>).
Before you finish: pnpm check (and pnpm parity if bars changed, once it exists).
Stop and ask a human if: another context's interface must change, a new AWS service seems needed, or this file conflicts with the task.
