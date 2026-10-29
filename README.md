# agentic-investanswers

Agent-first analytics and charting platform for InvestAnswers. MVP: 2 Nov to 27 Nov 2026, buffer and client review 30 Nov to 4 Dec.

## Start here
1. Install Node 22, pnpm 10, Docker, and Claude Code (VS Code extension or CLI).
2. `pnpm install`, `cp .env.example .env` and fill in the provider keys, then `docker compose up -d`.
3. Open Claude Code in this folder. It shows what you still owe (`docs/owner-inputs.md`) and the task status.
4. `/start-task <ID>` to begin a task, `/handoff` before you stop, `/resume-task <ID>` in a fresh session, `/status` any time.

## Where things are
| Path | What |
|---|---|
| `CLAUDE.md` | Rules Claude Code follows in every session |
| `docs/plan.md`, `docs/backlog.md` | The 4+1 week plan and every task with its done-check |
| `docs/owner-inputs.md` | What you and the client must provide; blocks tasks until done |
| `tasks/STATUS.md`, `tasks/<ID>.md` | Task status and per-task cards with handoff notes |
| `apps/`, `contexts/`, `shared-kernel/` | Code: composition roots, business contexts, shared types |
| `fixtures/` | Parity fixtures (TradingView exports). Protected by a hook and by CI |
| `.claude/` | Hooks, slash commands and the status line |

## Guards
- **CI** (`.github/workflows/ci.yml`): lint, tests, typecheck and architecture boundaries on every PR; fixtures changes need the `fixtures-approved` label.
- **Hooks** (`.claude/settings.json`): block edits to `fixtures/`, run `pnpm check` before Claude stops, and show owner inputs at session start.
- **Status line**: context and plan usage; turns yellow at 60% with a reminder to `/handoff`.
