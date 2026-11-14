# Task status

Updated by Claude at the start and end of each task (`/start-task`, `/handoff`) and by you when you merge. Statuses: todo, in progress, in review, done, blocked, Phase 1 (not in the MVP).

| ID | Task | Status | Issue | PR |
|---|---|---|---|---|
| M0-01 | Monorepo skeleton | done | #1 | #47 |
| M0-02 | CI on PRs | done | #2 | #47 |
| M0-03 | docs/bar-rules.md | todo | #3 |  |
| M0-04 | shared-kernel | done | #5 | #52 |
| M0-05 | PR template, task cards and STATUS | done | #4 | #47 |
| M0-06 | Claude Code automation | done | #6 | #47 |
| M1-01 | Raw store (write-once Parquet per provider/instrument/day) and cooked store (per timeframe | done | #7 | #55 |
| M1-02 | Import TradingView exports into fixtures/parity/ (normalised CSV), with a loader | done | #8 | #63 |
| M1-03 | Bar parity harness pnpm parity | done | #9 | #65 |
| M1-04 | CoinAPI history backfill for BTC/ETH 1m into the raw store; idempotent, resumable | done | #10 | #66 |
| M1-05 | CoinAPI live stream | done | #11 | #74 |
| M1-06 | Cook intraday rollups 1m → 5m/15m/1h/4h, incrementally (one new 1m updates only the affect | done | #12 | #62 |
| M1-07 | Massive (stocks) backfill and live stream for 2 symbols, same ports as crypto | done | #13 | #72 |
| M1-07b | Massive live stream (needs a plan with WebSocket, OI-28) | blocked | #71 |  |
| M1-08 | Cook D/W/M and stock session-aware rollups (regular hours, holidays) | todo | #14 |  |
| M1-09 | Gap detector + auto re-fetch (completeness check), per market hours | done | #15 | #73 |
| M1-10 | Rebuild check | done | #16 | #69 |
| M1-11 | Latency probe: minute close → raw stored → cooked, per symbol | todo | #17 |  |
| M1-12 | Extend the market calendar to 1999-2027 | done | #53 | #70 |
| M1-13 | Commit parity fixtures, turn on the CI parity job | blocked | #58 |  |
| M1-14 | Split parity: exact build parity, reported source fidelity | done | #67 | #68 |
| M1-15 | M1 scale-out: no bottleneck or dead end in the live data path | done | #81 | #87, #90, #94 |
| M1-16 | Data layer boundary: one data-access interface for the rest of the app | done | #82 | #102 |
| M2-01 | CDK staging stack | todo | #18 |  |
| M2-02 | Cache layer | done | #19 | #77 |
| M2-03 | History API | done | #20 | #79 |
| M2-04 | Live gateway | done | #21 | #80 |
| M2-05 | Chart app | done | #22 | #103 |
| M2-06 | Scroll-back paging, smooth loading of older history | todo | #23 |  |
| M2-07 | Freshness checker | todo | #24 |  |
| M2-08 | The app's own sign-up and sign-in (InvestAnswers sign-in later) | done | #25 | #92 |
| M2-09 | Plan-based access on placeholder plans | done | #26 | #95 |
| M2-10 | Safeguards | done | #27 | #99 |
| M2-11 | Embed in the InvestAnswers site (iframe or web component), domain-locked | todo | #28 |  |
| M2-12 | Themes (light and dark) and mobile layout | todo | #29 |  |
| M2-13 | Saved chart preferences in DynamoDB (last symbol, timeframe, theme) | todo | #30 |  |
| M3-01 | IndicatorDefinition interface | done | #31 | #85 |
| M3-02 | Settings schema → settings dialog (generated from the declared inputs, with range limits) | in review | #32 | #86 |
| M3-03 | Indicator parity harness | todo | #33 |  |
| M3-04 | Indicator engine | done | #34 | #89 |
| M3-05 | The MVP indicator (SMA) end to end (chart, dialog, output types) | todo | #35 |  |
| M3-06 | Backtest engine (shared): trades, profit, ROI, win rate, totals | done, parity pending (OI-30) | #36 | #91 |
| M3-07a | ATR port, slice 1: plotted values (agentic-investanswers-indicators) | Phase 1 | #37 |  |
| M3-07b | ATR port, slice 2: signals | Phase 1 | #38 |  |
| M3-07c | ATR port, slice 3: backtest | Phase 1 | #39 |  |
| M3-08 | Leak test: no internals in API, WebSocket or the browser bundle | todo | #40 |  |
| M4-01 | Agent identity | done | #41 | #97 |
| M4-02 | Read-only MCP tools | done | #42 | #101 |
| M4-03 | Read-only agent API endpoints | todo | #43 |  |
| M4-04 | Usage and audit records for every human and agent request | todo | #44 |  |
| M4-05 | Freshness and speed dashboard (CloudWatch) against agreed targets | todo | #45 |  |
| M4-06 | MVP demo script + acceptance report (runs all four checks, prints pass/fail) | todo | #46 |  |
