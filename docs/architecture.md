# Architecture (MVP)

Full specification: `analytics-platform-architecture` (project files). This page is the MVP summary Claude works from.

## Shape
- **Monolith first.** One repo, two processes: `apps/platform` (HTTP API, WebSocket live updates, MCP tools) and `apps/hydration` (provider streams, backfill, gap repair), so hydration is isolated from user traffic. `apps/web-chart` is the browser chart.
- **Contexts** in `contexts/<name>` own the business rules, in three layers: `domain` (pure), `application` (use cases and ports), `adapters` (AWS, HTTP, providers). Contexts talk through their package entry only.
- **Deferred for the MVP:** gRPC/proto contracts and separate services. Contexts call each other in-process through TypeScript interfaces; the two processes share data through S3 and announce new bars over Redis pub/sub.

## Data
- Providers: CoinAPI (crypto), Massive (stocks). Live over WebSocket, history over REST, one feed per provider.
- **Raw** 1-minute data: write-once Parquet (zstd) on S3, per provider, instrument and day. Never edited.
- **Cooked** bars for every timeframe, built only from raw 1-minute bars, Parquet on S3; always rebuildable.
- Hot bars and indicator output in ElastiCache (Redis). User, access, preferences and agent data in DynamoDB.
- Locally: MinIO, DynamoDB Local and Redis via `docker compose`.

## Security
- Indicator source lives only in `agentic-investanswers-indicators`. Only drawn outputs at display precision leave the engine.
- Every request carries a principal (human or agent); plan checks run on every REST route and WebSocket subscription.

## Stack
TypeScript on Node.js 22, pnpm + Nx, Vitest, Playwright, React + Lightweight Charts, AWS CDK (TypeScript).
