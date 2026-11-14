# Decision record (for the client)

What we decided to keep the MVP moving: fallbacks in effect, temporary choices that will be replaced, and decisions still open. It is written for InvestAnswers and can be shared as is. Claude updates it at the end of every task that adds, changes or closes an entry (`CLAUDE.md`, Workflow). Sham reviews it before each Friday update.

Each entry gives the date, what was decided and why, what it affects, and what replaces it or closes it. Entries are never deleted: when one closes, it moves to "Closed" with the outcome.

Last updated: 2026-11-14.

## Fallbacks in effect
Where something we were waiting for has not arrived, so we use an agreed alternative.

**F-01 · Local environment instead of AWS staging** (2026-11-13)
- **Why:** AWS account access (owner input OI-20, due 2026-11-10) has not arrived. Sham confirmed on 2026-11-13 that everything stays local until it does.
- **Affects:** everything runs and is tested on local stand-ins: MinIO for S3, Redis, DynamoDB Local. Demos run locally, including the client demo on 2026-11-13. Deployment (M2-01) waits.
- **Closes when:** access arrives and the staging stack is deployed. Nothing built so far depends on running locally.

**F-03 · Stocks are history only, with no live stream** (2026-11-10)
- **Why:** the current Massive plan refuses WebSocket access, both real time and 15-minute delayed (OI-28).
- **Affects:** NVDA and TSLA 1-minute history is stored; no live stock bars. Crypto live is unaffected.
- **For now:** Sham decided on 2026-11-13 to stay on the free plan for the client demo that day, and to ask InvestAnswers afterwards whether to move to a paid plan.
- **Closes when:** a Massive plan with WebSocket access is chosen, together with the delay promised to customers (OI-24). The live stream (M1-07b) is then built on the same interfaces crypto uses.

**F-04 · Our own agent keys, until InvestAnswers sign-in can issue agent tokens** (2026-11-13)
- **Why:** it is still open whether InvestAnswers sign-in can issue tokens for agents (OI-25, due 2026-11-23), and the app's own sign-in is in place meanwhile (T-01).
- **Affects:** agent access (M4-01). A signed-in user creates a named agent key, shown once and stored only as a hash, and can revoke it at any time (up to 10 per account). The agent uses it like a sign-in token, reads on its user's plan, and is read-only: it cannot change the account, its keys or anything else.
- **Closes when:** InvestAnswers confirms it can issue agent tokens, which then plug in behind the same interface.

## Temporary decisions
Choices made to keep progress going, each built so it can be swapped later without rework.

**T-01 · The app's own sign-up and sign-in** (2026-11-13)
- **Why:** the InvestAnswers sign-in and subscription details (OI-21, due 2026-11-10) have not arrived, and the client is not focused on this yet.
- **Affects:** the platform gets its own accounts: sign-up, sign-in and session tokens (M2-08). Accounts and sessions are stored permanently in DynamoDB, as the architecture plans (Sham, 2026-11-13), not in a temporary store; passwords are stored only as salted scrypt hashes; a session lasts 30 days or until sign-out.
- **Swap later:** every request already carries a "principal" (who is asking, human or agent), resolved through one interface. Moving to InvestAnswers sign-in later means replacing that resolver; routes, checks and the rest of the app do not change.

**T-02 · Placeholder subscription plans** (2026-11-13)
- **Why:** the real plans and what each includes are not decided (OI-21).
- **Affects:** a configurable set of plans, each listing the instruments and timeframes it includes. Every REST route and WebSocket subscription checks it (M2-09). For now: **Free** (Bitcoin and Ether, 1-hour bars and longer), which every new account starts on, and **Pro** (everything). An account is moved to Pro by adding its email to the plans file. Locked content points to an upgrade link, which is a placeholder (`investanswers.example`) until the client gives the real page.
- **Swap later:** plans are data in one place, behind one access-policy interface. Changing them is a configuration change; linking to InvestAnswers billing later is a new adapter.

**T-04 · Only crypto at 1m to 4h is served** (2026-11-11)
- **Why:** daily, weekly and monthly bars, and stock bars, are cooked in M1-08, which waits on the stock export with consolidated volume (OI-27).
- **Affects:** the History API and live updates refuse stocks and 1D/1W/1M with a clear `timeframe_not_served` error.
- **Closes when:** M1-08 cooks them; one rule is switched on, with no other change.

**T-05 · The data layer is isolated in code now, as a separate service later** (2026-11-13)
- **Why:** the client wants the data layer (provider data, hydration, stored bars) isolatable from the rest of the app, without dead ends.
- **Affects:** the rest of the app reaches bars only through one data-access interface; no other module touches storage, the cache or provider code directly (M1-16). For the MVP it runs in-process.
- **Swap later:** running the data layer as its own service means one new adapter behind that interface; nothing else changes.
- **In code since M1-16 (2026-11-14):** the interface is `@aia/data`. A lint rule refuses any other way in, and the browser app cannot reach the data layer at all. Client-facing rules (the History API, the live gateway) moved to their own module, so the data layer holds data only. The separate-service design is in `docs/architecture.md`.

**T-06 · Starter rate limits, and edge (WAF) rules with the AWS stack** (2026-11-13, M2-10)
- **Why:** usage limits per customer are not agreed yet, and the web application firewall (WAF) is an AWS service that comes with staging (F-01, M2-01).
- **Affects:** each signed-in user may make 300 chart requests a minute and each agent key 120 (bars, plan and live connections; live updates on an open connection are not counted). Per client address: 10 sign-in attempts per 15 minutes and 5 new accounts an hour. Per account: 20 agent keys created or revoked an hour. Over a limit, the request is refused with "too many requests" and when to retry. A single request returns at most 1,000 bars. If the limit counter (Redis) is down, requests are let through rather than refused.
- **Swap later:** the numbers are configuration (`config/safeguards.json`), changed without code. The WAF rules (basic managed rule sets and a per-address request ceiling in front of the platform) are added in the AWS stack (M2-01).

**T-07 · The chart has no sign-in screen while everything runs locally** (2026-11-14, M2-05)
- **Why:** everything runs locally until AWS access arrives (F-01). Sham decided on 2026-11-14 that the chart uses local developer access until then, and that the email and password screens are built when the app moves to AWS.
- **Affects:** locally, the chart is run against the platform in developer access mode, where every request has access to everything. The chart already sends a session token with every request when it has one, so it works unchanged once a sign-in screen gives it one. The sign-in itself (T-01) is in place on the server.
- **Closes when:** the move to AWS (M2-01) adds the sign-in screens, using the app's own sign-in (T-01) or InvestAnswers' (OI-21).

## Postponed decisions
Open questions, what we assume meanwhile, and the latest date the answer is useful.

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

**D-05 · The repository is public until NDA material arrives** (2026-11-01)
- **What:** it goes private (GitHub Pro) before the ATR source (OI-23) is added, so NDA code never sits in a public repository.

**D-06 · Chart library: KLineChart** (2026-11-12)
- **What:** the chart uses KLineChart, free and open source (Apache 2.0), with its built-in indicators turned off; our own indicator engine draws everything. Research charts (backtests, comparisons) will use Apache ECharts.
- **Why:** the client wants no TradingView libraries. KLineChart is the strongest free open-source library built for price bars, and suits an indicators and research platform.

**D-07 · Stored bars are written once a day, not every minute** (2026-11-13, M1-15)
- **What:** live bars are built in memory as each minute closes. Each completed day is written to storage once. The newest part, since the last completed day, is built from the stored 1-minute data when read, with the same rules.
- **Why:** the client's top concern is no bottleneck in the data layer. Measured at 500 instruments, the previous design rewrote each instrument's monthly files every minute: about 100 MB uploaded a minute, bars reaching charts about 53 s late, and about $600 a month in storage requests alone. Now it is one small write per instrument per minute.
- **Swap later:** the reading side is one interface, so a different storage layout or a separate data service can replace it without changing the rest of the app (see T-05).

**D-08 · API responses are compressed** (2026-11-13)
- **What:** the History API compresses large responses (gzip) for browsers and agents that accept it, using `@fastify/compress`, the compression plugin maintained by the Fastify team. Added with the History API (M2-03, #79); confirmed by Sham on 2026-11-13.
- **Why:** a chart loads thousands of bars at once; compressed, the same response is several times smaller, so charts open faster, especially on mobile.

**D-09 · Backtests follow TradingView's Strategy Tester rules** (2026-11-13, M3-06)
- **What:** a signal at a bar's close fills at the next bar's open; one position at a time, and a signal for the other side reverses it; stops and targets fill inside the bar along TradingView's assumed price path, or at the open after a gap; commission is a percentage per fill. Defaults match TradingView's: 1,000,000 starting capital, 1 unit per trade, no commission.
- **Why:** backtest totals are checked against TradingView's exports, so the rules must be the same.
- **Both ways the client described:** the same engine runs a backtest over all stored history at once, or bar by bar as bars close on the chart (including live), and the two give identical results on every closed bar.

**D-10 · Live data can be split across several processes** (2026-11-13, M1-15c)
- **What:** the process that streams live prices can run as several copies, each handling its own share of instruments, assigned automatically or pinned in the feed configuration. Adding copies is how hydration grows with the number of instruments.
- **Why:** the client's concern is no bottleneck or dead end in the data layer. One process streaming everything was a hard limit; now each instrument has exactly one writer however many processes run, and charts are unaffected (tested with 1,000 browsers and two publishers).

**D-11 · The MVP indicator is the simple moving average; ATR is Phase 1** (2026-11-13, Sham)
- **What:** the MVP's indicator milestone (M3) is built and proven on a simple moving average and its demo strategy: plotted on the chart, with its settings dialog and backtest, at 100% parity against its own TradingView exports (OI-30). The IA-ATR-Model 2.1 port (M3-07a to M3-07c) moves to Phase 1.
- **Why:** Sham decided the MVP uses a simple indicator such as a moving average, so the MVP no longer waits on the ATR source.
- **Design requirement (kept):** the indicator interface and engine take ATR later as one new indicator, with no change to the engine, the API or the chart.

**D-12 · Agents read through MCP, the standard way AI assistants connect to tools** (2026-11-13, M4-02)
- **What:** an agent connects to the platform's MCP endpoint with its read-only agent key (F-04) and gets three tools: list the instruments, get bars, and see its plan. Indicator outputs join as a fourth tool when the chart serves them (M3-05). Built with the official MCP software kit (`@modelcontextprotocol/sdk`), approved by Sham on 2026-11-13.
- **Why:** the brief asks for agents to read the same data as the chart, with the same plan checks; MCP is what assistants such as Claude use to call tools.
- **Same rules as the chart:** every tool answers exactly what the API answers, through the same plan checks and rate limits; agents can only read.

## Closed
**F-02 · Simple moving average stands in for the ATR indicator** (2026-11-13) · closed 2026-11-13
- **Was:** a fallback: the indicator milestone ran on a simple moving average until the ATR source and exports (OI-23) arrived, with the same design requirement as D-11.
- **Outcome:** no longer a fallback. Sham decided the same day that the simple moving average is the MVP indicator and ATR is Phase 1 (D-11).

**T-03 · Local developer access mode** (2026-11-11) · closed 2026-11-13 (M2-08)
- **Was:** with `AIA_DEV_AUTH=1` every request counted as a local user with full access; without it, every request was refused.
- **Outcome:** the app's own sign-in (T-01) is in place, so without `AIA_DEV_AUTH=1` the platform now requires a signed-in user. The mode stays for local development only, never in staging.

**P-01 · Data licence and daily bars** (OI-22, due 2026-11-13) · closed 2026-11-13
- **Was:** open question; meanwhile we kept data permanently and used provider daily bars only if building them from 1-minute bars failed parity.
- **Outcome:** Sham chose the default on 2026-11-13: data is kept permanently, and daily, weekly and monthly bars are built from 1-minute bars, with provider daily bars only if that fails parity. If InvestAnswers' data licence requires otherwise, tell us and it reopens.
