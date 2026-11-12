# Decision record (for the client)

What we decided to keep the MVP moving: fallbacks in effect, temporary choices that will be replaced, and decisions still open. It is written for InvestAnswers and can be shared as is. Claude updates it at the end of every task that adds, changes or closes an entry (`CLAUDE.md`, Workflow). Sham reviews it before each Friday update.

Each entry gives the date, what was decided and why, what it affects, and what replaces it or closes it. Entries are never deleted: when one closes, it moves to "Closed" with the outcome.

Last updated: 2026-11-13.

## Fallbacks in effect
Where something we were waiting for has not arrived, so we use an agreed alternative.

**F-01 · Local environment instead of AWS staging** (2026-11-13)
- **Why:** AWS account access (owner input OI-20, due 2026-11-10) has not arrived. Expected 2026-11-14.
- **Affects:** everything runs and is tested on local stand-ins: MinIO for S3, Redis, DynamoDB Local. Demos run locally. Deployment (M2-01) waits.
- **Closes when:** access arrives and the staging stack is deployed. Nothing built so far depends on running locally.

**F-02 · Simple moving average stands in for the ATR indicator** (2026-11-13)
- **Why:** the IA-ATR-Model 2.1 source and its TradingView exports (OI-23) have not arrived.
- **Affects:** the indicator milestone (M3) is built and proven on a simple moving average.
- **Design requirement:** the indicator interface and engine must take ATR later as one new indicator, with no change to the engine, the API or the chart.
- **Closes when:** the ATR source arrives and its port (M3-07a to M3-07c) passes parity. If it is not in by Monday of Week 3, ATR moves to Phase 1, as agreed in the brief.

**F-03 · Stocks are history only, with no live stream** (2026-11-10)
- **Why:** the current Massive plan refuses WebSocket access, both real time and 15-minute delayed (OI-28).
- **Affects:** NVDA and TSLA 1-minute history is stored; no live stock bars. Crypto live is unaffected.
- **Closes when:** a Massive plan with WebSocket access is chosen, together with the delay promised to customers (OI-24). The live stream (M1-07b) is then built on the same interfaces crypto uses.

**F-04 · Our own agent keys, if InvestAnswers sign-in cannot issue agent tokens** (planned)
- **Why:** it is still open whether InvestAnswers sign-in can issue tokens for agents (OI-25, due 2026-11-23).
- **Affects:** agent access (M4-01) would use our own scoped, read-only keys.
- **Closes when:** InvestAnswers confirms it can issue agent tokens, which then plug in behind the same interface.

## Temporary decisions
Choices made to keep progress going, each built so it can be swapped later without rework.

**T-01 · The app's own sign-up and sign-in** (2026-11-13)
- **Why:** the InvestAnswers sign-in and subscription details (OI-21, due 2026-11-10) have not arrived, and the client is not focused on this yet.
- **Affects:** the platform gets its own accounts: sign-up, sign-in and session tokens (M2-08).
- **Swap later:** every request already carries a "principal" (who is asking, human or agent), resolved through one interface. Moving to InvestAnswers sign-in later means replacing that resolver; routes, checks and the rest of the app do not change.

**T-02 · Placeholder subscription plans** (2026-11-13)
- **Why:** the real plans and what each includes are not decided (OI-21).
- **Affects:** a configurable set of plans (for example Free and Pro), each listing the instruments and timeframes it includes. Every REST route and WebSocket subscription checks it (M2-09).
- **Swap later:** plans are data in one place, behind one access-policy interface. Changing them is a configuration change; linking to InvestAnswers billing later is a new adapter.

**T-03 · Local developer access mode** (2026-11-11)
- **Why:** sign-in did not exist yet when the History API was built.
- **Affects:** with `AIA_DEV_AUTH=1` on a developer's machine, every request counts as a local user with full access. Without it, every request is refused.
- **Closes when:** the app's own sign-in (T-01) lands; the mode then stays for local development only, never in staging.

**T-04 · Only crypto at 1m to 4h is served** (2026-11-11)
- **Why:** daily, weekly and monthly bars, and stock bars, are cooked in M1-08, which waits on the stock export with consolidated volume (OI-27).
- **Affects:** the History API and live updates refuse stocks and 1D/1W/1M with a clear `timeframe_not_served` error.
- **Closes when:** M1-08 cooks them; one rule is switched on, with no other change.

**T-05 · The data layer is isolated in code now, as a separate service later** (2026-11-13)
- **Why:** the client wants the data layer (provider data, hydration, stored bars) isolatable from the rest of the app, without dead ends.
- **Affects:** the rest of the app reaches bars only through one data-access interface; no other module touches storage, the cache or provider code directly (M1-16). For the MVP it runs in-process.
- **Swap later:** running the data layer as its own service means one new adapter behind that interface; nothing else changes.

## Postponed decisions
Open questions, what we assume meanwhile, and the latest date the answer is useful.

**P-01 · Data licence and daily bars** (OI-22, due 2026-11-13)
- **Meanwhile:** we keep data permanently, and use provider daily bars only if building them from 1-minute bars fails parity.

**P-02 · Delay promised to customers; what a "tenant" is** (OI-24, due 2026-11-20)
- **Meanwhile:** crypto is live, about 2 to 3 seconds after each minute closes, with forming bars ticking with trades. Stocks are history only (F-03). The freshness dashboard (M4-05) waits for an agreed target.

**P-03 · Stock parity venue and exports** (OI-27, due 2026-11-20)
- **Finding:** Massive serves the consolidated US tape. TradingView's free stock data is Cboe BZX only, about 10× less volume on NVDA.
- **Meanwhile:** stock rollup rules are proven on the Cboe exports. Stock daily, weekly and monthly bars cannot be checked against TradingView until a consolidated-volume export exists.

**P-04 · Stock history before November 2024** (OI-29, due 2026-11-16)
- **Meanwhile:** the current Massive plan serves 2 rolling years of 1-minute data, so stock daily, weekly and monthly bars start in November 2024 unless a plan with more history is chosen.

## Decided (for context)
Settled choices the client may ask about.

**D-01 · Crypto data comes from Coinbase Exchange's public feeds** (2026-11-09 and 2026-11-10)
- **What:** 1-minute history from its public candles API; live from its public WebSocket.
- **Why:** it is the venue of the TradingView `COINBASE:` exports and matched them on spot checks. It is free and needs no key. CoinAPI's free plan could not cover two years of minutes, and bills live data per message.
- **Swap later:** every feed is replaceable by configuration (the client requirement). CoinAPI or another provider can take over any instrument from a chosen date, and history already stored stays.

**D-02 · Parity is split in two** (2026-11-09)
- **Build parity, exact and blocking:** TradingView's own bars through our rollups must equal its higher-timeframe exports. This proves our bar rules.
- **Source fidelity, reported only:** how closely our provider's bars match TradingView's.
- **Why:** TradingView's record misses some trades, so exact volume parity is impossible from any other source. Prices match; volume differs on 1 to 10% of bars.

**D-03 · Storage formats** (M1-01, week 1)
- **What:** Parquet with gzip for raw provider data (written once, read rarely) and snappy for cooked bars (read on every chart load), rather than zstd.
- **Why:** the pure-JavaScript Parquet library has no zstd, and on a measured sample zstd files were larger anyway.

**D-04 · The chart ticks with trades** (2026-11-12)
- **What:** the newest bar updates with every trade, at most 4 times a second, not only once a minute.
- **How it stays safe:** these "forming" bars are never stored, and the stored bar replaces each one a moment after its minute closes. Charts are told to reload whenever they might differ from the store.

**D-06 · Stored bars are written once a day, not every minute** (2026-11-13, M1-15)
- **What:** live bars are built in memory as each minute closes. Each completed day is written to storage once. The newest part, since the last completed day, is built from the stored 1-minute data when read, with the same rules.
- **Why:** the client's top concern is no bottleneck in the data layer. Measured at 500 instruments, the previous design rewrote each instrument's monthly files every minute: about 100 MB uploaded a minute, bars reaching charts about 53 s late, and about $600 a month in storage requests alone. Now it is one small write per instrument per minute.
- **Swap later:** the reading side is one interface, so a different storage layout or a separate data service can replace it without changing the rest of the app (see T-05).

**D-05 · The repository is public until NDA material arrives** (2026-11-01)
- **What:** it goes private (GitHub Pro) before the ATR source (OI-23) is added, so NDA code never sits in a public repository.

## Closed
None yet.
