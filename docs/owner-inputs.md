# Owner inputs

What Sham (or the client, through Sham) must provide. Claude reads this file at the start of every session and **refuses to start a task that a pending item blocks** (`pnpm owner-inputs --task <ID>`).

How to mark an item done: change `[ ]` to `[x]` and commit. Items with a `check` are also verified on your machine: an env var must be set in `.env`, a folder must contain files, or a file must have no `TODO(Sham)` left.

Format: `- [ ] **ID** what · due YYYY-MM-DD · blocks TASK, TASK · check KIND:VALUE`

## From Sham
- [x] **OI-01** CoinAPI key in `.env` and as GitHub secret `COINAPI_KEY` · due 2026-11-01 · blocks M1-04, M1-05 · check env:COINAPI_KEY
- [x] **OI-02** Massive key in `.env` and as GitHub secret `MASSIVE_API_KEY` · due 2026-11-01 · blocks M1-07 · check env:MASSIVE_API_KEY
- [x] **OI-03** Choose the 2 stock symbols for parity and write them in `docs/bar-rules.md` · due 2026-11-01 · blocks M1-02, M1-07
- [x] **OI-04** TradingView exports for **crypto**: BTC and ETH, all 8 timeframes, OHLCV, UNIX timestamps, Coinbase spot, placed on your machine and **not committed** while the repo is public (decided 2026-11-04; M1-13 commits them once it is private). Done 2026-11-08: 16 files, verified by Claude — grids clean, 1h reproduces 1m exactly, 4h anchored to 00:00 UTC, weekly on Mondays, monthly on day 1. Stocks moved to OI-27, because the venue question did not exist when this item was written · due 2026-11-04 · blocks M1-02
- [x] **OI-05** Bar rules answered in `docs/bar-rules.md` (no `TODO(Sham)` left) · due 2026-11-02 · blocks M0-03, M0-04, M1-06, M1-08 · check nodo:docs/bar-rules.md
- [x] **OI-06** Local machine ready: Node 22, pnpm 10, Docker running, `docker compose up -d` works · due 2026-11-02 · blocks M1-01
- [x] **OI-07** Branch protection on `main`: require a PR and the `CI` check (Settings → Rules → Rulesets, or Settings → Branches). Rulesets need GitHub Pro on a private repo. Decided 2026-11-01 (Sham): make the repo public now, since nothing proprietary is in it yet, and use free rulesets. **Revisit before OI-23** — see the note there · due 2026-11-02 · blocks M0-04
- [ ] **OI-08** Claude GitHub app for `@claude` and automatic PR review: run `/install-github-app` in Claude Code once · due 2026-11-03 · blocks nothing
- [ ] **OI-09** Project board: GitHub → Projects → New project → Board, then add all `agentic-investanswers` issues and turn on the "Item closed → Done" and "Pull request merged → Done" workflows · due 2026-11-02 · blocks nothing

## From the client (Sham chases)
- [ ] **OI-20** AWS account access for staging · due 2026-11-10 · blocks M2-01
- [ ] **OI-21** Sign-in and subscription details, one test account per plan · due 2026-11-10 · blocks M2-08, M2-09
- [ ] **OI-22** Data licence and daily-bar decision · due 2026-11-13 · blocks nothing (default: keep data permanently, provider daily bars only if needed)
- [ ] **OI-23** IA-ATR-Model 2.1 source (NDA) and its TradingView exports · due 2026-11-16 · blocks M3-07a, M3-07b, M3-07c (fallback: M3 on the demo indicator). **Before this lands, make the repo private again and buy GitHub Pro** (agreed 2026-11-01), or the NDA source goes into a public repo; re-apply the `main` ruleset afterwards (OI-07). Going private also unblocks **M1-13**: the parity fixtures and the CI parity job are waiting on it
- [ ] **OI-24** Data delay promised to customers; what a "tenant" is · due 2026-11-20 · blocks M4-05
- [ ] **OI-25** Whether InvestAnswers sign-in can issue agent tokens · due 2026-11-23 · blocks nothing (fallback: our own scoped read-only keys)
- [x] **OI-26** Which BTC/ETH symbol (exchange) the client's indicators use in TradingView; Coinbase assumed in `docs/bar-rules.md` (client: "use any that is best", 31 Oct → Coinbase) · due 2026-11-02 · blocks M1-02, M1-04
- [ ] **OI-27** **Stock parity venue, then the stock exports.** TradingView serves Cboe BZX (BATS) for US stocks whatever symbol you type, because primary-exchange feeds are sold separately — so `NASDAQ:NVDA` exports as `BATS_NVDA`, and Cboe's volume is not Nasdaq's. **Do not buy a data feed yet:** M1-07 reveals what venue Massive actually serves for NVDA and TSLA, and the TradingView feed must match *that*, or the fixture is the wrong reference. Once M1-07 answers it: buy the matching feed if needed, re-export the 8 stock files, and record the venue in `docs/bar-rules.md`. The existing BATS exports stay useful meanwhile — venue affects numbers, not bucketing, and they already proved the session, 4h and DST rules. **Answered by M1-07 (2026-11-10): Massive serves the consolidated US tape** — on 2026-11-05 regular hours its NVDA volume was 257.3M shares against 24.4M on the BATS export (10.6×), closes equal in 40% of minutes. So buy a TradingView feed that shows **consolidated** US volume (not BATS, not a single exchange such as Nasdaq-only), then re-export · due 2026-11-20 · blocks M1-08
- [ ] **OI-28** **Massive plan with WebSocket access** for the stock live stream: the current plan refuses both `socket.massive.com` (real-time) and `delayed.massive.com` (15-minute delay) and allows about 5 REST requests a minute (measured 2026-11-10, M1-07). Starter gives a 15-minute delay; real time needs a higher tier — choose with OI-24 (the delay promised to customers) · due 2026-11-13 · blocks M1-07b
- [ ] **OI-29** **Stock history before 2024-11-11.** The current Massive plan serves a rolling 2 years of 1-minute data (2024-11-08 and earlier answer 403), so stock D/W/M from listing (NVDA 1999, TSLA 2010) cannot come from it, nor can the provider-daily-bars fallback in `docs/bar-rules.md`. Decide: a Massive plan with more history, or D/W/M from 2024-11 only · due 2026-11-16 · blocks nothing yet (M1-08 scopes stock D/W/M by this)
