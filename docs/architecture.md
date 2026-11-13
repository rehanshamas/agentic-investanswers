# Architecture (MVP)

Full specification: `analytics-platform-architecture` (project files). This page is the MVP summary Claude works from.

## Shape
- **Monolith first.** One repo, two processes: `apps/platform` (HTTP API, WebSocket live updates, MCP tools) and `apps/hydration` (provider streams, backfill, gap repair), so hydration is isolated from user traffic. `apps/web-chart` is the browser chart.
- **Contexts** in `contexts/<name>` own the business rules, in three layers: `domain` (pure), `application` (use cases and ports), `adapters` (AWS, HTTP, providers). Contexts talk through their package entry only.
- **Data layer isolated in code, as a service later** (Sham, 2026-11-13, for the client; decision record T-05): the rest of the app reaches bars only through one data-access interface, never storage, the cache or provider code directly (M1-16). Running the data layer as its own service later is one new adapter behind that interface.
- **Deferred for the MVP:** gRPC/proto contracts and separate services. Contexts call each other in-process through TypeScript interfaces; the two processes share data through S3 and announce new bars over Redis pub/sub.

## Data
- Providers (current feed plan, replaceable, see "Feed independence"): Coinbase Exchange public WebSocket for crypto live (M1-05, chosen over CoinAPI, whose hosts reset TLS from our machine and whose free plan bills per message), Massive for stocks. Live over WebSocket, history over REST. **Crypto 1-minute history comes from Coinbase Exchange's public candles API** (M1-04), the exports' own venue, free and keyless, because CoinAPI's free plan cannot cover two years of minutes. Raw keys carry the provider (`raw/coinbase/...`), so sources never mix in one file.
- **Raw** 1-minute data: write-once Parquet (**gzip**) on S3, per provider, instrument and day. Never edited. Write-once is enforced by a conditional `PutObject` (`IfNoneMatch: '*'`), so a second write is refused atomically by the store rather than by a read-then-write check two writers could interleave. **Gap fills (M1-09):** minutes the provider turns out to have after a day was stored go into further write-once files beside it (`DD.fill-1.parquet`, `DD.fill-2.parquet`, ...). Each may only add minutes absent from the day and its earlier fills, and reading a day returns them merged. So a raw object is never edited or replaced, yet a day can still be completed.
- **Live minutes (M1-05):** a raw day is written only once it has settled, so today cannot go into it. The live stream instead writes each closed minute as its own write-once object beside the day (`DD.live/HHMM.parquet`), and each disconnect window as a write-once gap record (`DD.live-gaps/HHMM-HHMM.json`). Readers use the day file when it exists, otherwise the live minutes, so live minutes stand in for days not yet backfilled and are superseded, never edited. A minute is built only if the stream saw all of it: the minute in progress at start or reconnect is skipped and counted as gap. Trades are bucketed by exchange time, a minute closes 2 s after it ends, later trades for it are dropped, and missed trades (a jump in Coinbase's consecutive `trade_id`, or a heartbeat naming a trade never delivered) end the connection so the minutes become a gap rather than short bars.
- **Hour files for live minutes (M1-15b).**
  - Once an hour has ended, `pnpm live` writes its live minutes as one write-once file beside them (`DD.live-hours/HH.parquet`). It writes from the minutes it holds after one LIST confirms they are exactly the minute objects stored for that hour; otherwise it writes from the stored objects.
  - Readers take an hour file where one exists and minute objects otherwise. A full day reads back in about 24 GETs instead of up to 1,440 (measured on MinIO: 82 against 1,411).
  - Minute objects are never edited or deleted, and the day file still supersedes both.
  - Only hours of days the process streamed are sealed, before compaction reads them.
- **Live shards (M1-15c).**
  - `pnpm live --shard i/n` streams only the instruments of shard i of n. Each instrument is in exactly one shard: the one its feed plan entry pins (`"shard": n`), otherwise one chosen by a stable hash of its symbol (FNV-1a).
  - So each instrument has one writer of its live minutes, hour files and cooked days, and hydration scales out by adding processes.
  - Start-up refuses a pin beyond n. Run every shard with the same n, and restart them together when n changes.
  - The live gateway follows each publisher's sequence separately. It resyncs charts on a jump in one publisher's sequence, or when an instrument's announcements move to another publisher (a restarted or rebalanced shard), not when a new shard with its own instruments appears.
- **Cooked** bars for every timeframe, built only from raw 1-minute bars, Parquet (**snappy**) on S3; always rebuildable. One file per instrument, timeframe and partition: by month for intraday, by year for 1D/1W/1M.
- **Settled cooked bars plus the tail (M1-15).**
  - **Watermark:** the cooked store holds settled days only. Each instrument has a cooked watermark (`watermarks/<symbol>.json` in the cooked bucket), and every bar built from minutes before it is stored.
  - **Live:** `pnpm live` cooks each minute **in memory** (`LiveCook`, from the longest bucket's minutes) for the cache and charts, and writes no cooked file per minute.
  - **Compaction:** at the first minute of each UTC day, the **compactor** cooks the days before it from raw, all intraday timeframes from one read, and moves the watermark a day at a time. That is one partition rewrite per timeframe per day, so a crash redoes at most a day.
  - **Reads:** readers (`CookedReader`, used by `RecentBars` and so the History API) take stored bars before the watermark and roll up the tail from raw with the same `rollUp`. A compactor that falls behind makes reads longer, never wrong. With no watermark yet, the store is read alone, as before.
  - **Rebuild check:** it compares settled bars only.
  - **Why:** measured with `pnpm load-hydration` at 500 instruments. Before, every minute rewrote each instrument's month files for 4 timeframes: about 100 MB uploaded a minute, about 53 s from minute close to announced, and about $609 a month of S3 requests. After, one raw PUT per instrument per minute and nothing cooked until midnight (results in `tasks/M1-15.md`).
- **Not zstd, and why** (M1-01): the pure-JS `@dsnp/parquetjs` has no zstd — its types offer it but the runtime codec table is gzip, snappy, brotli and uncompressed only. zstd would mean `parquet-wasm` plus `apache-arrow`, 29MB against 8.4MB, and on a measured 2,000-bar sample its zstd files were *larger* (11.0kB) than parquetjs gzip (6.9kB). So: gzip for raw, which is written once and read rarely, and snappy for cooked, which is read on every chart load. Columns are INT64 scaled whole numbers, so no float reaches disk.
- Hot bars and indicator output in ElastiCache (Redis).
- **Recent-bars cache (M2-02).** Redis holds a window of the newest bars (up to 2,000) per instrument and timeframe, 1m included. A window means "every stored bar from `from` onwards", so a read inside it is a true hit. It is only ever created whole from the store, on a read miss. After `pnpm live` has stored and cooked a minute, it sends **BarClosed** events (the 1m bar, plus each 5m to 4h bar it rebuilt, which may still be forming) and the cache replaces or appends those bars. Updates to a key with no window are ignored. A fill is refused if a bar changed while the store was being read. Each change runs as one Lua script. If an update fails, the window is dropped. Commands that rewrite bars any other way (`pnpm cook`, `pnpm gaps`, `pnpm backfill`) drop the windows of the instruments they touched. The cache never runs ahead of the store, and a failure costs a store read rather than a stale chart. User, access, preferences and agent data in DynamoDB.
- Locally: MinIO, DynamoDB Local and Redis via `docker compose`.

## History API (M2-03)
- `GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=<UTC seconds>` on the platform process (Fastify, `pnpm platform`, port 8080). Response: `{ instrument, timeframe, bars: [{ time, open, high, low, close, volume }], next }`. Prices and volumes are decimals at the instrument's precision. `next` is the `before` for the next older page, or `null` at the start of history.
- **Cap: 1,000 bars per request** (default 500). A larger `limit` gets `400 limit_too_large`, never a silent clamp. Errors are `{ error: { code, message } }`: `400 bad_parameter`, `401 unauthorized`, `403 forbidden`, `404 unknown_instrument`, `409 timeframe_not_served`, `500 internal`.
- **Cache first, then S3.** The newest page comes from the recent-bars cache. Older pages, or a cold cache, read the cooked store (raw for 1m). A page widens its look-back across closed sessions or missing history, up to 64× the page, and stops at where the feed plan says the instrument's history starts. If Redis is down, reads go to the store.
- The rules (parameters, cap, what is served) live in `HistoryQuery` (`@aia/market-data`). The app only maps outcomes to HTTP statuses. Until M1-08, only crypto at 1m to 4h is served.
- **Principal on every request.** The resolver and policy ports in `@aia/access` are checked first (401), and the policy after parsing (403). Until M2-08: with `AIA_DEV_AUTH=1`, every request is the local developer with full access; without it, everything gets 401.

## Live gateway (M2-04)
- **One WebSocket per browser**, `GET /live` on the platform process, carrying all its subscriptions (`{ op: 'subscribe' | 'unsubscribe', instrument, tf }`, at most 20). The protocol is in `@aia/market-data` (`application/live-protocol.ts`). The principal is resolved before the upgrade (401 otherwise; browsers may pass `?token=` until M2-08 settles sign-in), and the plan is checked on every subscription (`forbidden`).
- **Two kinds of update**, each replacing the bar with the same time:
  - **Stored:** a minute's BarClosed events. `pnpm live` announces them only after the store, cooking and the recent-bars cache have them, so a chart is never ahead of `GET /bars`.
  - **Forming** (`forming: true`): the chart ticks with trades.
    - The live stream reports the minutes not yet stored (still forming, or closed and being written) at most every 250 ms when they change.
    - `FormingBars` rolls each timeframe's bar up from three parts: the newest cooked bar, minutes stored but not yet cooked, and those unstored minutes. It uses the same `rollUp` as cooking.
    - Forming bars are never written anywhere. The partial minute at a start or reconnect never forms.
- **Transport:** announcements go over Redis pub/sub (channel `bars:live`) with a sequence number per publisher. The platform has one subscriber, and `LiveGateway` fans out in process.
- **Batching:** each browser gets at most one message per 100 ms, holding only the newest value of each bar.
- **Resync:** after a gap in the sequence, a lost Redis connection, a dropped provider stream, or a failed write, cook or cache update, every browser is sent `resync` and reloads from `GET /bars`. `pnpm cook`, `pnpm gaps` and `pnpm backfill` also send one, after dropping cached windows.
- **Slow clients:** a browser with more than 1 MiB waiting to be sent is closed (1013) and reconnects.
- **Load test:** `pnpm load-live`, 1,000 clients by default (100 in `pnpm check`). Results are in `tasks/M2-04.md`.

## Feed independence (client requirement, CLAUDE.md rule 7)
The client must be able to change the source of any feed at any time with no hard dependency on a provider. Introduced in M1-05.
- **Ports speak our language only.** `HistoryProviderPort` returns `Bar`s and `LiveTradesPort` emits trades as `{ time, price, size }` in our scaled units, both keyed by our instrument symbol (`BTCUSD`). Mapping to the provider's symbol (`BTC-USD`), parsing its JSON, its units, rate limits, reconnect quirks and errors all live in its adapter. The domain, the application layer and the stores never see a provider type.
- **Adapter registry.** Adapters register by name (`coinbase`, `massive`, later `coinapi`, ...) with what they offer (history, live) and the settings they need (an API key from env, for example). The apps build adapters only through the registry.
- **Feed plan, as data.** One validated config holds, per instrument, an **effective-dated** list of history sources (`[{ provider, from }]`), the live source, and per-source limits (earliest day served, settle time). Switching BTC from Coinbase to CoinAPI on 2027-01-01 means adding one entry. Backfill, gap repair, the live stream and the 1-minute reader all ask the plan which provider serves a given instrument and day. Nothing else picks a provider.
- **History survives a switch.** Raw keys keep the provider (`raw/<provider>/<symbol>/...`), so sources never mix in one file. The reader takes each day from the provider the plan names for that day, so older days keep coming from the old provider and cooked stays rebuildable from raw.
- **Neutral schemas.** Raw and cooked Parquet hold only `time, open, high, low, close, volume` as INT64 scaled whole numbers. Instrument precision belongs to the instrument, not the provider.
- **Proved by tests.** Every adapter passes the same port contract tests, using recorded provider data. A switch test moves an instrument to a second (fake) provider mid-history and checks the reader and a full re-cook give the expected bars, with no code change.

## Sign-in (M2-08; decision record T-01)
- **The app's own accounts** in the access context, behind `PrincipalResolverPort`: `/auth/sign-up`, `/auth/sign-in`, `/auth/sign-out`, `/auth/me`. The session token goes on REST as `Authorization: Bearer`, and on `/live` as `?token=`. InvestAnswers sign-in later replaces the resolver; routes and checks do not change.
- **Stored in DynamoDB** (DynamoDB Local until staging): one table, `pk`/`sk`; an account and its email are written in one conditional transaction, so emails stay unique; sessions are stored as a SHA-256 of the token, with a TTL. Passwords are salted scrypt hashes (node:crypto, no extra dependency).
- `AIA_DEV_AUTH=1` skips sign-in on a developer's machine only.
- **Agent keys (M4-01; decision record F-04):** a signed-in user creates read-only keys for their agents (`/auth/agent-keys`: create, list, revoke; at most 10). A key starts `aia_agent_`, is shown once and stored as a SHA-256 in the same table (`AGENTKEY#<hash>` for lookup, `ACCOUNT#<id>` / `AGENTKEY#<keyId>` for the list, written and deleted together). The agent sends it like a session token and becomes an agent principal whose `owner` is the user; `mayWrite` is false for agents, so account and key routes refuse them (`403 read_only`). InvestAnswers-issued agent tokens later are one more resolver behind `PrincipalResolverPort`.

## Plans (M2-09; decision record T-02)
- **Placeholder plans as configuration** (`config/plans.json`, or `AIA_PLANS`): each plan lists the instruments and timeframes it includes (`"all"` for everything); every new account starts on the default plan; `assignments` moves an account, by email, to another plan; `upgradeUrl` is where locked content points. Checked at start-up, so a bad edit stops the platform with a clear message. Changing plans is an edit to that file and a restart.
- **Checked behind `AccessPolicyPort`** (`PlanPolicy`), on every `/bars` request and every `/live` subscription. A refused `/bars` is `403 forbidden` with `upgradeUrl`; a refused subscription is a `forbidden` message on the socket. `GET /plan` tells the chart what the caller's plan includes and where to upgrade, so it can show locked instruments and timeframes before anyone asks.
- An agent reads on its owner's plan (M4-01); an agent with no owner gets the default plan. InvestAnswers billing later is a new adapter behind the same port.

## Indicator engine (M3-01, M3-04)
- **One shape for every indicator** (`contexts/indicators`): declared inputs with limits, declared outputs (lines, bands, markers, levels), and `step(state, bar)` that returns a new state and leaves the old one unchanged. ATR (Phase 1) later is one new definition (decision record D-11).
- **Runs on the server, cached in Redis** by indicator + version + instrument + timeframe + run start + settings. An entry holds the state after the last closed bar, that bar, and the newest 2,000 drawn points. A new closed bar is one step; the forming bar is previewed from the closed state and never cached; a changed last bar (a re-cook) means recompute.
- **Run start pinned to a grid** of 5,000-bar blocks, starting one block before the newest bar's block, so a run covers 5,000 to 10,000 bars and a run rebuilt after a cache miss draws exactly the same values.
- **Only drawn points leave:** declared outputs rounded to the instrument's tick. Indicator state stays in the cache, which only the engine reads.

## Security
- Indicator source lives only in `agentic-investanswers-indicators`. Only drawn outputs at display precision leave the engine.
- Every request carries a principal (human or agent); plan checks run on every REST route and WebSocket subscription.
- **Rate limits (M2-10; decision record T-06):** fixed windows counted in Redis (`rl|<bucket>|<subject>|<window>`, one script per hit), shared by every platform process. Reads (`/bars`, `/plan`, a `/live` connection) per user or per agent key; sign-in and sign-up per client address; agent key changes per account. Over a limit: `429 rate_limited` with `Retry-After`. Limits are `config/safeguards.json` (or `AIA_SAFEGUARDS`). If Redis fails, requests are let through and the failure is logged. Behind a load balancer the client address must come from it (Fastify `trustProxy`, set with the AWS stack). The bars-per-request cap is the History API's (1,000). WAF rules come with M2-01.

## Stack
TypeScript on Node.js 22, pnpm + Nx, Vitest, Playwright, React + KLineChart (Apache 2.0; the client rules out TradingView libraries, including Lightweight Charts; its built-in indicators stay off, because indicators run server-side), AWS CDK (TypeScript).
