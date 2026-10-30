# Owner inputs

What Sham (or the client, through Sham) must provide. Claude reads this file at the start of every session and **refuses to start a task that a pending item blocks** (`pnpm owner-inputs --task <ID>`).

How to mark an item done: change `[ ]` to `[x]` and commit. Items with a `check` are also verified on your machine: an env var must be set in `.env`, a folder must contain files, or a file must have no `TODO(Sham)` left.

Format: `- [ ] **ID** what · due YYYY-MM-DD · blocks TASK, TASK · check KIND:VALUE`

## From Sham
- [ ] **OI-01** CoinAPI key in `.env` and as GitHub secret `COINAPI_KEY` · due 2026-11-01 · blocks M1-04, M1-05 · check env:COINAPI_KEY
- [ ] **OI-02** Massive key in `.env` and as GitHub secret `MASSIVE_API_KEY` · due 2026-11-01 · blocks M1-07 · check env:MASSIVE_API_KEY
- [x] **OI-03** Choose the 2 stock symbols for parity and write them in `docs/bar-rules.md` (NVDA, TSLA) · due 2026-11-01 · blocks M1-02, M1-07
- [ ] **OI-04** TradingView exports (BTC, ETH, 2 stocks; 1m to 1M, OHLCV, UTC) copied into `fixtures/parity/tradingview/` (commit them in a PR and add the `fixtures-approved` label) · due 2026-11-02 · blocks M1-02, M1-03 · check dir:fixtures/parity/tradingview
- [x] **OI-05** Bar rules answered in `docs/bar-rules.md` (no `TODO(Sham)` left) · due 2026-11-02 · blocks M0-03, M0-04, M1-06, M1-08 · check nodo:docs/bar-rules.md
- [ ] **OI-06** Local machine ready: Node 22, pnpm 10, Docker running, `docker compose up -d` works · due 2026-11-02 · blocks M1-01
- [ ] **OI-07** Branch protection on `main`: require a PR and the `CI` check (Settings → Rules → Rulesets, or Settings → Branches). Private repos need GitHub Pro for this; without it, never merge a red PR · due 2026-11-02 · blocks M0-04
- [ ] **OI-08** Claude GitHub app for `@claude` and automatic PR review: run `/install-github-app` in Claude Code once · due 2026-11-03 · blocks nothing
- [ ] **OI-09** Project board: GitHub → Projects → New project → Board, then add all `agentic-investanswers` issues and turn on the "Item closed → Done" and "Pull request merged → Done" workflows · due 2026-11-02 · blocks nothing

## From the client (Sham chases)
- [ ] **OI-20** AWS account access for staging · due 2026-11-10 · blocks M2-01
- [ ] **OI-21** Sign-in and subscription details, one test account per plan · due 2026-11-10 · blocks M2-08, M2-09
- [ ] **OI-22** Data licence and daily-bar decision · due 2026-11-13 · blocks nothing (default: keep data permanently, provider daily bars only if needed)
- [ ] **OI-23** IA-ATR-Model 2.1 source (NDA) and its TradingView exports · due 2026-11-16 · blocks M3-07a, M3-07b, M3-07c (fallback: M3 on the demo indicator)
- [ ] **OI-24** Data delay promised to customers; what a "tenant" is · due 2026-11-20 · blocks M4-05
- [ ] **OI-26** Which BTC/ETH symbol (exchange) the client's indicators use in TradingView; Coinbase assumed in `docs/bar-rules.md` · due 2026-11-02 · blocks M1-02, M1-04
- [ ] **OI-25** Whether InvestAnswers sign-in can issue agent tokens · due 2026-11-23 · blocks nothing (fallback: our own scoped read-only keys)
