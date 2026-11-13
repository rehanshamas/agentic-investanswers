# CLAUDE.md (agentic-investanswers)

Agent-first analytics and charting platform for InvestAnswers. MVP is built Mon 2 Nov to Fri 27 Nov 2026; 30 Nov to 4 Dec is buffer and client review.
Read before planning: `docs/architecture.md`, `docs/bar-rules.md`, `docs/glossary.md`, the task's card in `tasks/`, and the `AGENTS.md` of any context you touch. The plan is `docs/plan.md`; the task list is `docs/backlog.md`.

## Non-negotiable rules
1. **Monolith first, with hydration isolated.** One repo; `apps/` only wire things together. Business rules live in `contexts/<name>/{domain,application,adapters}`. A context imports another only through its `index.ts`.
2. **Every timeframe is built from 1-minute bars.** Never fetch or store higher timeframes from a provider (exception: provider daily bars, only if `docs/bar-rules.md` says so).
3. **Raw vs cooked.** Raw = provider data exactly as received, write-once, never edited. Cooked = derived bars, always rebuildable from raw. Never write to raw outside `contexts/hydration`.
4. **Sessions have human and agent sub-contexts.** Every request carries a principal (human or agent). Plan checks apply to both.
5. **Indicator internals never leave the indicator engine.** Only drawn outputs (lines, bands, markers, levels) at display precision go to the API, the WebSocket or agents. Indicator source lives only in `agentic-investanswers-indicators`.
6. **`domain/` is pure:** imports only `shared-kernel`. No AWS SDK, no HTTP, no `Date.now()` (time is an argument).
7. **Every data feed is replaceable (client requirement).** Changing the provider of any instrument, history or live, is a change to the feed plan (`docs/architecture.md`, "Feed independence") plus at most one new adapter. No other code changes. Provider names, symbols, field names, units and quirks stay inside `contexts/hydration/src/adapters/<provider>/`. Everything outside sees only our own types (`Bar`, trades in our units, our instrument symbols). Raw and cooked schemas carry no provider-specific column. Never branch on a provider name or pick a provider from an instrument's kind outside the feed plan and the adapter registry. A switch must not hide history already stored from the old provider.

## Tests are the spec
- Never change a file under `fixtures/`, a parity tolerance or an existing assertion to make a test pass. If you believe one is wrong, **stop and explain why**.
- A task is done only when its done-check passes and `pnpm check` is green.
- If you touched bars, run `pnpm parity` and `pnpm rebuild-check`. If you touched indicators, run `pnpm parity:indicators`.

## Commands
- `docker compose up -d`: local MinIO (S3), DynamoDB Local, Redis
- `pnpm check`: lint, test and typecheck for affected projects (same as CI)
- `pnpm owner-inputs [--task <ID>]`: what Sham still owes; with `--task`, exits non-zero if that task is blocked
- `pnpm status`: task counts from `tasks/STATUS.md`
- Added by later tasks: `pnpm parity` (M1-03), `pnpm rebuild-check` (M1-10), `pnpm freshness` (M2-07), `pnpm parity:indicators` (M3-03). Until they exist, say so instead of claiming they passed.

## Stack
TypeScript on Node.js, pnpm + Nx, Vitest, Playwright. React + KLineChart (open source, Apache 2.0; no TradingView libraries, per the client). Parquet (zstd) on S3; DynamoDB for user, access and agent data; ElastiCache Redis for hot bars. AWS CDK (TypeScript). Deferred for the MVP: gRPC/proto contracts, separate services.

## Words
Say "bar", "timeframe", "instrument", "market session", "indicator". Never "candle", "interval", or "model" for an indicator.

## Owner inputs gate
`docs/owner-inputs.md` lists what Sham (or the client) must provide, with due dates and the tasks each one blocks. **Never start or continue a task that `pnpm owner-inputs --task <ID>` reports as blocked**, and never work around a missing input with mock data unless Sham says so in this session. Tell Sham exactly what is missing and stop. Overdue items: mention them at the start of every session.

## Package names
`@aia/shared-kernel`, `@aia/<context>`, `@aia/app-<app>`. Boundaries are enforced by `eslint.config.mjs` (Nx tags plus import rules); never weaken that file to get green.

## Workflow
- **Work happens in more than one session** (local Claude Code and Sham's cloud project threads). Before starting or resuming any task, fetch `origin/main` and check that nobody else has it: its row in `tasks/STATUS.md` on `origin/main`, open PRs (`gh pr list`), and remote branches named `<ID>-*` (`git branch -r`). If it is "in progress" or "in review" elsewhere, or already done, stop and tell Sham instead of redoing it. When you start a task, get its "in progress" row onto `main` early (push the branch and open a draft PR, or a one-line STATUS PR), so other sessions see it.
- Tasks come from `docs/backlog.md`. Use `/start-task <ID>`, `/resume-task <ID>` and `/handoff`. "Start task <ID>" means: create `tasks/<ID>.md` from `tasks/_template.md`, fill it from the backlog row, set it to "in progress" in `tasks/STATUS.md`, then plan. "Resume task <ID>" means: read `tasks/<ID>.md`, including its Handoff, and continue.
- Propose a plan first and wait for approval before editing.
- One task per branch (`<task-id>-<slug>`), small commits, then open a PR describing what changed and how it was verified. Never push to `main`, never force-push, never commit `.env` or keys. Each PR body says `Closes #<issue>` for its task's GitHub issue.
- **Before you stop, finished or not:** update the Handoff in `tasks/<ID>.md` (done, left, surprises, next step) and `tasks/STATUS.md`, and commit them on the task branch. If context is getting long, do this first and tell the user to start a fresh session.
- **Decision record (for the client):** `docs/decisions-record.md` lists every fallback in effect, temporary decision and postponed decision, in plain words the client can read. When a task adds, changes or closes one (a missing input worked around, a placeholder, a choice deferred), update it in the same PR, and move closed entries to "Closed" with the outcome, never deleting them.
- In the PR description, fill in the template's by-hand checklist: tick what you verified, and list for the user what **they** must still check by hand (for example, "spot-check BTC 1W bars of 2024-03 against TradingView").
- Use subagents for broad reading or searching; keep this session for the change itself.
- `fixtures/` is protected: a hook blocks edits unless Sham started Claude with `AIA_ALLOW_FIXTURES=1`, and CI fails any PR that touches it without the `fixtures-approved` label.
- **Stop and ask** if: a contract between contexts must change, a new AWS service or dependency seems needed, a fixture looks wrong, or these rules conflict with the task.
