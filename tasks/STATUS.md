# Task status

Updated by Claude at the start and end of each task (`/start-task`, `/handoff`) and by you when you merge. Statuses: todo, in progress, in review, done, blocked.

| ID | Task | Status | PR |
|---|---|---|---|
| M0-01 | Monorepo skeleton | in review | setup PR |
| M0-02 | CI on PRs | in review | setup PR |
| M0-03 | docs/bar-rules.md | todo |  |
| M0-04 | shared-kernel | todo |  |
| M0-05 | PR template, task cards and STATUS | in review | setup PR |
| M0-06 | Claude Code automation | in review | setup PR |
| M1-01 | Raw store (write-once Parquet per provider/instrument/day) and cooked store (per timeframe | todo |  |
| M1-02 | Import TradingView exports into fixtures/parity/ (normalised CSV), with a loader | todo |  |
| M1-03 | Bar parity harness pnpm parity | todo |  |
| M1-04 | CoinAPI history backfill for BTC/ETH 1m into the raw store; idempotent, resumable | todo |  |
| M1-05 | CoinAPI live stream | todo |  |
| M1-06 | Cook intraday rollups 1m → 5m/15m/1h/4h, incrementally (one new 1m updates only the affect | todo |  |
| M1-07 | Massive (stocks) backfill and live stream for 2 symbols, same ports as crypto | todo |  |
| M1-08 | Cook D/W/M and stock session-aware rollups (regular hours, holidays) | todo |  |
| M1-09 | Gap detector + auto re-fetch (completeness check), per market hours | todo |  |
| M1-10 | Rebuild check | todo |  |
| M1-11 | Latency probe: minute close → raw stored → cooked, per symbol | todo |  |
| M2-01 | CDK staging stack | todo |  |
| M2-02 | Cache layer | todo |  |
| M2-03 | History API | todo |  |
| M2-04 | Live gateway | todo |  |
| M2-05 | Chart app | todo |  |
| M2-06 | Scroll-back paging, smooth loading of older history | todo |  |
| M2-07 | Freshness checker | todo |  |
| M2-08 | Sign-in integration with InvestAnswers (token validation), user context | todo |  |
| M2-09 | Plan-based access | todo |  |
| M2-10 | Safeguards | todo |  |
| M2-11 | Embed in the InvestAnswers site (iframe or web component), domain-locked | todo |  |
| M2-12 | Themes (light and dark) and mobile layout | todo |  |
| M2-13 | Saved chart preferences in DynamoDB (last symbol, timeframe, theme) | todo |  |
| M3-01 | IndicatorDefinition interface | todo |  |
| M3-02 | Settings schema → settings dialog (generated from the declared inputs, with range limits) | todo |  |
| M3-03 | Indicator parity harness | todo |  |
| M3-04 | Indicator engine | todo |  |
| M3-05 | Demo indicator end to end (chart, dialog, output types) | todo |  |
| M3-06 | Backtest engine (shared): trades, profit, ROI, win rate, totals | todo |  |
| M3-07a | ATR port, slice 1: plotted values (agentic-investanswers-indicators) | todo |  |
| M3-07b | ATR port, slice 2: signals | todo |  |
| M3-07c | ATR port, slice 3: backtest | todo |  |
| M3-08 | Leak test: no internals in API, WebSocket or the browser bundle | todo |  |
| M4-01 | Agent identity | todo |  |
| M4-02 | Read-only MCP tools | todo |  |
| M4-03 | Read-only agent API endpoints | todo |  |
| M4-04 | Usage and audit records for every human and agent request | todo |  |
| M4-05 | Freshness and speed dashboard (CloudWatch) against agreed targets | todo |  |
| M4-06 | MVP demo script + acceptance report (runs all four checks, prints pass/fail) | todo |  |
