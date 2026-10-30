# MVP execution plan (our own)

**Window:** prep Thu 29 Oct to Sun 1 Nov, then 4 build weeks (Mon 2 Nov to Fri 27 Nov) and 1 buffer week ending with the client review on Fri 4 Dec 2026.
**Source of truth for scope:** the MVP and Roadmap Brief (M1 to M4 and the four checks). Anything not in it goes on the Phase 1 list, not into the MVP.
**Companion files:** `backlog.md` (every task, with a done-check), `starter-CLAUDE.md` (the repo root `CLAUDE.md`).

---

## 1. Ground rules

1. **Tests before features.** Each milestone starts by building its checker: bar parity in Week 1, freshness in Week 2, indicator parity in Week 3. Feature tasks then mean "make the checker pass".
2. **One task = one branch = one PR.** Claude Code writes the code and opens the PR. You review and merge. `main` is protected.
3. **Scope fence.** New requests from the client go into `docs/phase1-list.md` the same day. Only a swap of similar size gets into the MVP.
4. **Merged branches are deleted** (GitHub setting "Automatically delete head branches"); undo a change with the PR's Revert button. Never delete an unmerged branch.
5. **Milestone tags.** When a Friday gate passes, tag `main` (`m1-signoff`, `m2-signoff`, `m3-signoff`, `mvp-review`) as a known-good point to roll back to.
6. **Friday = demo day.** Each Friday, run that week's demo script on staging (or locally in Week 1) and send the client a 5-line update: what was signed off, what's next, and what's at risk.

## 2. Simplify the architecture for the MVP

The architecture spec is the target. For the MVP, keep its **boundaries** but defer its **machinery**:

| Keep now | Defer to Phase 1 |
|---|---|
| pnpm workspaces + Nx, `apps/` + `contexts/` + `shared-kernel/` layout | gRPC / `.proto` contracts and `buf breaking` (use plain TypeScript interfaces exported from each `index.ts`) |
| Raw vs cooked split, Parquet on S3, DynamoDB, Redis | Separate deployables (run `platform` + `hydration` as two processes from one repo; indicator engine in-process behind a port) |
| Module-boundary lint (Nx tags) | dependency-cruiser, cdk-nag hardening, multi-region copies |
| CDK for one `staging` stack | Production stack, failover drills, WAF tuning |
| Private indicator repo (`agentic-investanswers-indicators`) | Code generators (`nx g @rtv/tools:*`) |

The deferred items keep the same boundaries, so adding them later doesn't mean rewriting anything.

## 3. Week by week (4 build weeks + 1 buffer)

**Internal target:** the whole MVP is built by Fri 27 Nov. **Week 5 (30 Nov to 4 Dec) is buffer**, and the client review stays on Fri 4 Dec as promised in the brief. We report to the client on the brief's milestones; the 4-week target is ours. A brief milestone that lands early is fine; one that lands late is not.

This means about 11 tasks a week instead of 9, so you need **3 lanes (3 worktrees) running most days**.

### Prep: Thu 29 Oct to Sun 1 Nov (you, about 1 day)
- Create GitHub repos `agentic-investanswers` and `agentic-investanswers-indicators` (private, restricted). Protect `main` (PR required, CI required).
- Get provider API keys (CoinAPI, Massive) and download the TradingView exports for BTC, ETH and 2 stocks, every timeframe from 1m to 1M.
- Install Docker locally (MinIO for S3, DynamoDB Local, Redis) until AWS access arrives.
- Write your notes for `docs/bar-rules.md` (backlog task M0-03); Claude will format them.

### Week 1 (2 to 6 Nov): M1 Data and hydration
| Day | Lane A (parity, data) | Lane B (ingest) | Lane C (rollups) |
|---|---|---|---|
| Mon | M0-01 skeleton, M0-02 CI, M0-05 PR template + handoff files, M0-06 hooks, commands, board | | |
| Tue | M1-01 bar model + storage, M1-02 fixtures | M0-04 shared-kernel | |
| Wed | M1-03 parity harness | M1-04 crypto backfill | |
| Thu | M1-09 gap detector | M1-05 crypto live stream | M1-06 intraday rollups |
| Fri | M1-10 rebuild check, M1-11 latency probe | M1-07 stock backfill + stream | M1-08 D/W/M + stock sessions |

**Friday gate (= brief's M1):** bar parity green for BTC/ETH on all timeframes, and stocks green at least intraday.
**Cut line if late:** stocks drop to 1 symbol; stock D/W and the latency probe move to Monday of Week 2.

### Week 2 (9 to 13 Nov): serving, chart and sign-in
| Lane A (backend) | Lane B (chart) | Lane C (checks, access) |
|---|---|---|
| M2-01 staging stack (when AWS arrives; local until then), M2-02 cache, M2-03 history API, M2-04 live gateway | M2-05 chart app, M2-06 scroll-back | M2-07 freshness checker, M2-08 sign-in (test accounts arrive early this week) |

**Friday gate:** a chart opens BTC from cache, live bars tick, scroll-back works, freshness numbers are printed, and test accounts can sign in.

### Week 3 (16 to 20 Nov): finish M2, M3 groundwork
| Lane A (access) | Lane B (chart) | Lane C (indicators) |
|---|---|---|
| M2-09 plan checks, M2-10 safeguards, M4-01 agent identity | M2-11 embed, M2-12 themes + mobile, M2-13 preferences | M3-01 indicator interface, M3-03 indicator parity harness, M3-04 engine, M3-06 backtest engine |

**Friday gate (= brief's M2):** M2 is signed off. **ATR source and exports must be in by Monday of this week.** If they aren't, M3 runs on the demo indicator only, and ATR moves to Phase 1, as agreed in the brief.

### Week 4 (23 to 27 Nov): M3 indicator at parity + M4 agents
| Lane A (agents) | Lane B (demo indicator) | Lane C (ATR) |
|---|---|---|
| M4-02 MCP tools, M4-03 agent API, M4-04 usage + audit, M4-05 dashboard | M3-02 settings dialog, M3-05 demo indicator end to end, M3-08 leak test | M3-07a values, M3-07b signals, M3-07c backtest |

Agent tasks are small and reuse existing queries, so they run beside the ATR port. If the client hasn't decided on agent tokens, use our own scoped read-only keys.
**Friday gate (= internal MVP complete):** ATR 100% at parity, agents can read through MCP, and M4-06 produces the acceptance report.
**This is the riskiest week.** If ATR parity isn't 100%, ATR gets the buffer week first.

### Week 5 (30 Nov to 4 Dec): buffer and review
- **Mon to Wed: buffer, in this order:** (1) anything still red on the four checks, (2) slipped tasks, (3) bugs from your own testing. **No new features**, even if the week is free. Extra time goes to tests, freshness numbers and the demo.
- **Thu:** freeze. Rehearse the demo script on staging.
- **Fri 4 Dec:** MVP review with the client.

If the buffer is used up before Wednesday of Week 4, tell the client that day which item would slip, not at the review.

## 4. Your daily routine (about 2 to 3 hours of your own time)
- **Morning (30 min):** pick today's tasks from the backlog, paste each task card into a fresh Claude Code session (one per worktree), and approve each plan.
- **Midday and afternoon:** review PRs as they land. Read the diff, run the demo locally if it touches the UI, and merge. Check `/usage` once.
- **End of day (15 min):** tick the backlog, move anything not finished into tomorrow's task card notes, and add any new rule you learned to `CLAUDE.md`.

## 5. Must-check-by-hand list (each PR)
- [ ] No test, tolerance or fixture changed unless the task said so
- [ ] Bar rules respected (sessions, UTC, week start), spot-checked against TradingView for 3 bars
- [ ] Raw data is never overwritten; cooked data is always derived from raw
- [ ] Plan check present on any new route or stream
- [ ] No indicator internals in API responses or browser code
- [ ] No secrets, no `.env`, and no new AWS service without your OK

## 6. Risks and what we do
| Risk | Signal | Action |
|---|---|---|
| Stock bars won't match TradingView (sessions, adjustments) | Week 1 Friday parity red on stocks | Fix intraday first, then use provider daily bars (the brief's fallback) |
| AWS access late | Not there by Wed of Week 2 | Keep using local stand-ins and demo locally; tell the client the same day |
| ATR source late | Not there by Mon of Week 3 | M3 signed off on the demo indicator; ATR moves to Phase 1 (agreed in the brief) |
| Agent tokens undecided | No answer by end of Week 4 | Use our own agent API keys, scoped read-only |
| Scope creep | New asks in the tracker | Put them on the Phase 1 list; only a swap of similar size gets in |
| Claude Code usage limits | `/usage` above 70% midweek | Drop to 2 lanes and keep the parity and ingest lanes |
