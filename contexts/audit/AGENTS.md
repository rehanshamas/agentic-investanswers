# AGENTS.md: contexts/audit
Owns: Usage and audit records for every human and agent request.
Does not own: Access decisions.
Layers: src/domain (pure, imports only @aia/shared-kernel), src/application (use cases, ports), src/adapters (AWS, HTTP, providers).
May import: @aia/shared-kernel, other contexts only through their package entry (@aia/<context>).
Before you finish: pnpm check (and pnpm parity if bars changed, once it exists).
Stop and ask a human if: another context's interface must change, a new AWS service seems needed, or this file conflicts with the task.
