# Architecture (MVP)

Full specification: `analytics-platform-architecture` (project files). This page is the MVP summary Claude works from.

## Shape
- **Monolith first.** One repo, two processes: `apps/platform` (HTTP API, WebSocket live updates, MCP tools) and `apps/hydration` (provider streams, backfill, gap repair), so hydration is isolated from user traffic. `apps/web-chart` is the browser chart.
- **Contexts** in `contexts/<name>` own the business rules, in three layers: `domain` (pure), `application` (use cases and ports), `adapters` (AWS, HTTP, providers). Contexts talk through their package entry only.
- **Deferred for the MVP:** gRPC/proto contracts and separate services. Contexts call each other in-process through TypeScript interfaces; the two processes share data through S3 and announce new bars over Redis pub/sub.

## Data
- Providers (current feed plan, replaceable, see "Feed independence"): Coinbase Exchange public WebSocket for crypto live (M1-05, chosen over CoinAPI, whose hosts reset TLS from our machine and whose free plan bills per message), Massive for stocks. Live over WebSocket, history over REST. **Crypto 1-minute history comes from Coinbase Exchange's public candles API** (M1-04), the exports' own venue, free and keyless, because CoinAPI's free plan cannot cover two years of minutes. Raw keys carry the provider (`raw/coinbase/...`), so sources never mix in one file.
- **Raw** 1-minute data: write-once Parquet (**gzip**) on S3, per provider, instrument and day. Never edited. Write-once is enforced by a conditional `PutObject` (`IfNoneMatch: '*'`), so a second write is refused atomically by the store rather than by a read-then-write check two writers could interleave. **Gap fills (M1-09):** minutes the provider turns out to have after a day was stored go into further write-once files beside it (`DD.fill-1.parquet`, `DD.fill-2.parquet`, ...). Each may only add minutes absent from the day and its earlier fills, and reading a day returns them merged. So a raw object is never edited or replaced, yet a day can still be completed.
- **Cooked** bars for every timeframe, built only from raw 1-minute bars, Parquet (**snappy**) on S3; always rebuildable. One file per instrument, timeframe and partition: by month for intraday, by year for 1D/1W/1M.
- **Not zstd, and why** (M1-01): the pure-JS `@dsnp/parquetjs` has no zstd — its types offer it but the runtime codec table is gzip, snappy, brotli and uncompressed only. zstd would mean `parquet-wasm` plus `apache-arrow`, 29MB against 8.4MB, and on a measured 2,000-bar sample its zstd files were *larger* (11.0kB) than parquetjs gzip (6.9kB). So: gzip for raw, which is written once and read rarely, and snappy for cooked, which is read on every chart load. Columns are INT64 scaled whole numbers, so no float reaches disk.
- Hot bars and indicator output in ElastiCache (Redis). User, access, preferences and agent data in DynamoDB.
- Locally: MinIO, DynamoDB Local and Redis via `docker compose`.

## Feed independence (client requirement, CLAUDE.md rule 7)
The client must be able to change the source of any feed at any time with no hard dependency on a provider. Introduced in M1-05.
- **Ports speak our language only.** `HistoryProviderPort` returns `Bar`s and `LiveTradesPort` emits trades as `{ time, price, size }` in our scaled units, both keyed by our instrument symbol (`BTCUSD`). Mapping to the provider's symbol (`BTC-USD`), parsing its JSON, its units, rate limits, reconnect quirks and errors all live in its adapter. The domain, the application layer and the stores never see a provider type.
- **Adapter registry.** Adapters register by name (`coinbase`, `massive`, later `coinapi`, ...) with what they offer (history, live) and the settings they need (an API key from env, for example). The apps build adapters only through the registry.
- **Feed plan, as data.** One validated config holds, per instrument, an **effective-dated** list of history sources (`[{ provider, from }]`), the live source, and per-source limits (earliest day served, settle time). Switching BTC from Coinbase to CoinAPI on 2027-01-01 means adding one entry. Backfill, gap repair, the live stream and the 1-minute reader all ask the plan which provider serves a given instrument and day. Nothing else picks a provider.
- **History survives a switch.** Raw keys keep the provider (`raw/<provider>/<symbol>/...`), so sources never mix in one file. The reader takes each day from the provider the plan names for that day, so older days keep coming from the old provider and cooked stays rebuildable from raw.
- **Neutral schemas.** Raw and cooked Parquet hold only `time, open, high, low, close, volume` as INT64 scaled whole numbers. Instrument precision belongs to the instrument, not the provider.
- **Proved by tests.** Every adapter passes the same port contract tests, using recorded provider data. A switch test moves an instrument to a second (fake) provider mid-history and checks the reader and a full re-cook give the expected bars, with no code change.

## Security
- Indicator source lives only in `agentic-investanswers-indicators`. Only drawn outputs at display precision leave the engine.
- Every request carries a principal (human or agent); plan checks run on every REST route and WebSocket subscription.

## Stack
TypeScript on Node.js 22, pnpm + Nx, Vitest, Playwright, React + Lightweight Charts, AWS CDK (TypeScript).
