# Architecture (MVP)

Full specification: `analytics-platform-architecture` (project files). This page is the MVP summary Claude works from.

## Shape
- **Monolith first.** One repo, two processes: `apps/platform` (HTTP API, WebSocket live updates, MCP tools) and `apps/hydration` (provider streams, backfill, gap repair), so hydration is isolated from user traffic. `apps/web-chart` is the browser chart.
- **Contexts** in `contexts/<name>` own the business rules, in three layers: `domain` (pure), `application` (use cases and ports), `adapters` (AWS, HTTP, providers). Contexts talk through their package entry only.
- **Deferred for the MVP:** gRPC/proto contracts and separate services. Contexts call each other in-process through TypeScript interfaces; the two processes share data through S3 and announce new bars over Redis pub/sub.

## Data
- Providers: CoinAPI (crypto live), Massive (stocks). Live over WebSocket, history over REST. **Crypto 1-minute history comes from Coinbase Exchange's public candles API** (M1-04), the exports' own venue, free and keyless, because CoinAPI's free plan cannot cover two years of minutes. Raw keys carry the provider (`raw/coinbase/...`), so sources never mix in one file.
- **Raw** 1-minute data: write-once Parquet (**gzip**) on S3, per provider, instrument and day. Never edited. Write-once is enforced by a conditional `PutObject` (`IfNoneMatch: '*'`), so a second write is refused atomically by the store rather than by a read-then-write check two writers could interleave.
- **Cooked** bars for every timeframe, built only from raw 1-minute bars, Parquet (**snappy**) on S3; always rebuildable. One file per instrument, timeframe and partition: by month for intraday, by year for 1D/1W/1M.
- **Not zstd, and why** (M1-01): the pure-JS `@dsnp/parquetjs` has no zstd — its types offer it but the runtime codec table is gzip, snappy, brotli and uncompressed only. zstd would mean `parquet-wasm` plus `apache-arrow`, 29MB against 8.4MB, and on a measured 2,000-bar sample its zstd files were *larger* (11.0kB) than parquetjs gzip (6.9kB). So: gzip for raw, which is written once and read rarely, and snappy for cooked, which is read on every chart load. Columns are INT64 scaled whole numbers, so no float reaches disk.
- Hot bars and indicator output in ElastiCache (Redis). User, access, preferences and agent data in DynamoDB.
- Locally: MinIO, DynamoDB Local and Redis via `docker compose`.

## Security
- Indicator source lives only in `agentic-investanswers-indicators`. Only drawn outputs at display precision leave the engine.
- Every request carries a principal (human or agent); plan checks run on every REST route and WebSocket subscription.

## Stack
TypeScript on Node.js 22, pnpm + Nx, Vitest, Playwright, React + Lightweight Charts, AWS CDK (TypeScript).
