# MVP task backlog

Each task is sized for one Claude Code session and one PR. `→` names the tasks it depends on. The lane letters match `docs/plan.md`.
To start a task, ask Claude: "Start task M1-06". It copies the template into `tasks/M1-06.md`, fills it in from the row, and plans from it. To resume, say "Resume task M1-06" in a fresh session; it reads the Handoff section.

## Prep and skeleton (M0)
| ID | Task | → | Done when |
|---|---|---|---|
| M0-01 | Monorepo skeleton: pnpm + Nx, `apps/{platform,hydration,web-chart}`, `contexts/{hydration,market-data,access,preferences,indicators,backtesting,agent,audit}`, `shared-kernel/`, Nx boundary tags, Vitest | | `pnpm nx run-many -t lint test` green; a boundary violation fails lint |
| M0-02 | CI on PRs: lint, test, typecheck, and a fixtures guard (the parity job is added by M1-03); docker-compose with MinIO, DynamoDB Local, Redis | M0-01 | PR shows required checks; `docker compose up` starts the local stack |
| M0-03 | `docs/bar-rules.md`: crypto day 00:00 UTC; stock regular-session hours, holidays, early closes; week start; month boundaries; volume rules; what counts as a "missing minute" (written by you, Claude formats it) | | Reviewed by you; cited in the CLAUDE.md |
| M0-05 | `.github/pull_request_template.md` with the must-check-by-hand list; `tasks/` folder with `_template.md`; `tasks/STATUS.md` (one line per task: todo / in progress / in review / done) | M0-01 | A new PR shows the checklist; `STATUS.md` lists every backlog task |
| M0-04 | `shared-kernel`: `Instrument`, `Timeframe` (1m to 1M), `Bar`, `BarTime`, session helpers (time is passed in as an argument) | M0-01 | Unit tests for timeframe alignment, including DST for stocks |
| M0-06 | Claude Code automation: `.claude/settings.json` hooks (block edits under `fixtures/`; run lint + affected tests after edits), commands `/start-task` and `/handoff`, status line showing context % and usage; GitHub Projects board with one issue per backlog task; Claude GitHub app for `@claude` and automatic PR review | M0-05 | Editing a fixture is blocked; `/start-task M1-01` creates the task card; board shows all tasks |

## M1: Data and hydration (Week 1)
| ID | Task | Lane | → | Done when |
|---|---|---|---|---|
| M1-01 | Raw store (write-once Parquet per provider/instrument/day) and cooked store (per timeframe), behind `BarStorePort`, with S3/MinIO adapters | A | M0-04 | Round-trip test; writing a raw file twice is rejected |
| M1-02 | Import TradingView exports into `fixtures/parity/` (normalised CSV), with a loader | A | M0-04 | Loader test; row counts per file printed |
| M1-03 | **Bar parity harness** `pnpm parity`: compares cooked bars to fixtures on OHLCV, reports the first differing bar and a summary table; adds a required CI parity job | A | M1-01, M1-02 | Runs; fails with a readable report while nothing is built |
| M1-04 | CoinAPI history backfill for BTC/ETH 1m into the raw store; idempotent, resumable | B | M1-01 | 2+ years stored locally; re-run writes nothing new |
| M1-05 | CoinAPI live stream: forming bar in memory, closed 1m to raw store, reconnect with backoff, gap marked on disconnect | B | M1-01 | Replay of a recorded stream gives the same bars as the fixture; a reconnect test |
| M1-06 | Cook intraday rollups 1m → 5m/15m/1h/4h, incrementally (one new 1m updates only the affected bars) | C | M1-01 | `pnpm parity` green for BTC/ETH intraday |
| M1-07 | Massive (stocks) backfill and live stream for 2 symbols, same ports as crypto | B | M1-01 | Replay test; history stored |
| M1-08 | Cook D/W/M and stock session-aware rollups (regular hours, holidays) | C | M1-06, M0-03 | `pnpm parity` green for all 4 symbols on all timeframes (stocks D/W can spill into Week 2) |
| M1-09 | Gap detector + auto re-fetch (completeness check), per market hours | A | M1-04, M1-07 | Test deletes minutes; they are found, re-fetched and re-cooked |
| M1-10 | Rebuild check: re-cook every timeframe from raw and diff against stored cooked bars | A | M1-06 | `pnpm rebuild-check` reports 0 differences |
| M1-11 | Latency probe: minute close → raw stored → cooked, per symbol | A | M1-05 | p50/p95 printed; logged as a metric |
| M1-12 | Extend the market calendar to 1999–2027: NYSE holidays, early closes **and unscheduled closures** (9/11, Hurricane Sandy, funeral closures), replacing M0-04's hard 2020–2026 error | C | M0-04 | `isTradingDay` answers for 1999-01-22 and 2027-12-31; 2001-09-11 to 09-14 and 2012-10-29 to 10-30 are not trading days; the early-close list covers the pre-2004 era, when half days were more common |

## M2: Chart, sign-in and access (Weeks 2 to 3; Week 3 also carries M4-01)
| ID | Task | Lane | → | Done when |
|---|---|---|---|---|
| M2-01 | CDK `staging` stack: VPC, S3 buckets, DynamoDB tables, ElastiCache Serverless, ECS service for platform + hydration, ALB, CloudFront | A | M1-* | `cdk deploy` to staging; hydration runs there |
| M2-02 | Cache layer: recent bars per instrument/timeframe in Redis, updated on BarClosed | A | M1-06 | Cache hit test; cache equals the store after replay |
| M2-03 | History API: `GET /bars?instrument&tf&before&limit` (paged, capped), cache first, then S3 | A | M2-02 | Contract tests; the cap is enforced |
| M2-04 | Live gateway: one WebSocket per browser, subscribe per visible instrument/tf, batched updates | A | M2-02 | Load test locally with 1k fake clients; bars arrive in order |
| M2-05 | Chart app: React + Lightweight Charts, first ~500 bars, live bar, symbol and timeframe switch | B | M2-03, M2-04 | Playwright test: chart renders and the live bar updates |
| M2-06 | Scroll-back paging, smooth loading of older history | B | M2-05 | Playwright test scrolls back 2 years without gaps |
| M2-07 | **Freshness checker:** minute close → storage → cache → open chart, per step | C | M2-04 | Report per staging release; thresholds configurable |
| M2-08 | Sign-in integration with InvestAnswers (token validation), user context | A | client's auth details | Test accounts per plan sign in on staging |
| M2-09 | Plan-based access: check on every REST route and every WebSocket subscribe; locked content returns an upgrade link | A | M2-08 | Test matrix: each plan × each route/stream |
| M2-10 | Safeguards: per-user rate limits, bars-per-request cap, basic WAF rules | A | M2-09 | Tests hit the limits and get 429s |
| M2-11 | Embed in the InvestAnswers site (iframe or web component), domain-locked | B | M2-05 | Loads inside the client's test page only |
| M2-12 | Themes (light and dark) and mobile layout | B | M2-05 | Playwright screenshots at phone width |
| M2-13 | Saved chart preferences in DynamoDB (last symbol, timeframe, theme) | B | M2-08 | Reload restores preferences per user |

## M3: First indicator at parity (groundwork Week 3, port Week 4)
| ID | Task | → | Done when |
|---|---|---|---|
| M3-01 | `IndicatorDefinition` interface: declared inputs, output types (lines, bands, markers, levels), incremental update | M0-04 | Interface + a sample fake indicator with tests |
| M3-02 | Settings schema → settings dialog (generated from the declared inputs, with range limits) | M3-01, M2-05 | Dialog renders from the schema; out-of-range values rejected server-side |
| M3-03 | **Indicator parity harness:** signals exact, plotted values to the tick, backtest totals exact; reports the first differing bar | M3-01 | Runs against the demo indicator fixtures |
| M3-04 | Indicator engine: runs server-side, caches by indicator+version+instrument+tf+settings, extends by one bar | M3-01, M2-02 | Cache test; result extended rather than recomputed |
| M3-05 | Demo indicator end to end (chart, dialog, output types) | M3-02, M3-04 | Visible on the staging chart; parity green against its own exports |
| M3-06 | Backtest engine (shared): trades, profit, ROI, win rate, totals | M3-01 | Parity green on demo indicator backtest exports |
| M3-07a | ATR port, slice 1: plotted values (`agentic-investanswers-indicators`) | M3-03, source | Values parity green |
| M3-07b | ATR port, slice 2: signals | M3-07a | Signals parity green |
| M3-07c | ATR port, slice 3: backtest | M3-06, M3-07b | Backtest parity green; 100% across all exports |
| M3-08 | Leak test: no internals in API, WebSocket or the browser bundle | M3-05 | CI test greps responses and bundle for internal field names |

## M4: Agent access and MVP review (Week 4, beside the ATR port; Week 5 is buffer)
| ID | Task | → | Done when |
|---|---|---|---|
| M4-01 | Agent identity: agent principal linked to a user/org, tokens (client's sign-in, or our own scoped keys as fallback) | M2-09 | Agent token authenticates; scope is read-only |
| M4-02 | Read-only MCP tools: get bars, get indicator output, list instruments (same queries as the API, no new logic) | M4-01 | MCP client test calls each tool; plan checks apply |
| M4-03 | Read-only agent API endpoints | M4-01 | Contract tests |
| M4-04 | Usage and audit records for every human and agent request | M4-01 | Records queryable per user/agent |
| M4-05 | Freshness and speed dashboard (CloudWatch) against agreed targets | M2-07 | Dashboard link for the client |
| M4-06 | MVP demo script + acceptance report (runs all four checks, prints pass/fail) | all | One command produces the sign-off report |

**Total:** 6 + 11 + 13 + 10 + 6 = 46 tasks over 4 build weeks, about 11 per week across 3 lanes.

---

## Task card template
```
# <ID> <title>
Goal: <one sentence>
Context to read: CLAUDE.md, contexts/<x>/AGENTS.md, docs/<relevant>.md
Touch only: <paths>
Do not touch: parity fixtures, tests outside this context, infra (unless this is an infra task)
Done when:
- <the check from the backlog row>
- `pnpm nx affected -t lint test` green
Process: propose a plan and wait for approval; work on branch <id>-<slug>; open a PR using the PR template (fill in the by-hand checklist with what you checked).
Before ending (done or not): update tasks/<ID>.md "Handoff" (what's done, what's left, any surprises) and tasks/STATUS.md.

## Handoff
<written by Claude at the end of each session>
Stop and ask if: a fixture or tolerance looks wrong, a new AWS service seems needed, or the task needs another context's internals.
```
