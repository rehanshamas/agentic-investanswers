# Bar rules

How bars are built so they match TradingView exactly (requirements §4: "Bars must be built the same way TradingView builds them (trading sessions, week start, crypto daily close at 00:00 UTC)"; "Split-adjusted prices").
Every rule here has a matching **export setting** in TradingView: the exports in `fixtures/parity/tradingview/` must be made with exactly these settings, or parity will fail for reasons that aren't bugs.

## Instruments for parity
| Instrument | TradingView symbol (exports) | Provider symbol | Why |
|---|---|---|---|
| BTC | `COINBASE:BTCUSD` | History: Coinbase `BTC-USD`; live: CoinAPI `COINBASE_SPOT_BTC_USD` | Same venue on both sides; bars differ between exchanges |
| ETH | `COINBASE:ETHUSD` | History: Coinbase `ETH-USD`; live: CoinAPI `COINBASE_SPOT_ETH_USD` | Same |
| NVDA | `NASDAQ:NVDA` | Massive `NVDA` | On the client's launch list; 10-for-1 split in June 2024 tests split adjustment |
| TSLA | `NASDAQ:TSLA` | Massive `TSLA` | On the client's launch list; 3-for-1 split in Aug 2022 |

**Watch out: TradingView will hand you Cboe BZX (BATS) data for US stocks, whatever symbol you type.** Primary-exchange feeds are sold separately, so without a Nasdaq data subscription the `NASDAQ:NVDA` chart is fed by Cboe BZX and the export is named `BATS_NVDA`. Cboe carries 25%+ of US volume, so prices are close but **volume is not**, and volume parity would fail on every bar. Two consequences:

- Check the export's filename, not the symbol you searched for.
- **Massive serves the consolidated tape (M1-07, 2026-11-10), so the TradingView feed must be consolidated too.** On 2026-11-05 regular hours, Massive's NVDA volume was 257.3M shares against 24.4M on the BATS export (10.6×), with both having all 390 minutes and closes equal in only 40% of them. A BATS or single-exchange (for example Nasdaq-only) export will not match Massive on volume or on most closes. OI-27 tracks buying the consolidated feed and re-exporting.
- **Massive's raw minutes include pre-market and after-hours (from 04:00 New York), sub-penny prices to 6 places and fractional-share volumes to 6 places.** Raw keeps them as sent and as traded (unadjusted); cooking keeps regular hours, rounds to the export's precision and applies splits (M1-08).

Venue does not affect *bucketing*, so the BATS exports are still valid for proving session, DST and alignment rules — which is what they were used for above.


## Crypto
- Trades 24/7; there are no sessions, holidays or gaps by design.
- Daily bar: 00:00 to 24:00 UTC.
- Volume is in the base asset (BTC, ETH), as TradingView shows for `COINBASE:BTCUSD`.

## Stocks
- **Regular trading hours only.** 09:30 to 16:00 America/New_York; pre-market and after-hours minutes are not part of any bar. TradingView export setting: chart session = *Regular trading hours* (the default; "Extended trading hours" off).
- Time zone and daylight saving: sessions are defined in America/New_York and stored in UTC, so the session is 14:30 to 21:00 UTC in winter and 13:30 to 20:00 UTC in summer.
- **Holidays and early closes:** NYSE/Nasdaq calendar. Early-close days end at 13:00 New York time (for example the day after Thanksgiving and Christmas Eve). The calendar lives in config, one list per year. It covers **1999–2027** (M1-12), including unscheduled closures: 11–14 September 2001, 29–30 October 2012 (Sandy), and the funerals of Presidents Reagan (2004-06-11), Ford (2007-01-02), G. H. W. Bush (2018-12-05) and Carter (2025-01-09). Validated against the NVDA daily export (every day 1999-01-22 to 2026-11-06) and TSLA's (from 2010-06-29) with zero mismatches; early closes follow NYSE history, and 2027 follows nyse.com. Outside the range, lookups throw rather than guess.
- **Split-adjusted, not dividend-adjusted.** All history is adjusted for splits (NVDA before 10 June 2024 divided by 10). TradingView export setting: "Adjust data for dividends" **off** (TradingView always adjusts for splits).
- Volume is in shares.
- **Daily, weekly and monthly stock bars (known risk):** TradingView's daily stock bar uses the exchange's official open and close (the auctions) and the full day's consolidated volume, which can differ slightly from summing 1-minute regular-hours bars. Default: build D/W/M from 1-minute bars as everything else. If parity fails only on stock D/W/M open, close or volume, use Massive's daily bars for stock D, roll W and M from them, and record it here; the brief allows this exception.

## All markets
- **Timeframes:** 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M. Intraday bars are aligned to the session start for stocks (09:30, 10:30, ... for 1h; the last bar of the day is shorter) and to 00:00 UTC for crypto.
- **Stock 4h bars (the session doesn't divide evenly):** a 6.5-hour session gives one full 4h bar and a short one. Bars start at the session open and **reset each session**: 09:30–13:30 and 13:30–16:00 New York, two bars per trading day. A session's last bar is short; **a bar never spans two sessions.** Crypto 4h is unaffected: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC. **Confirmed against the exports:** `nvda_4h.csv` and `tsla_4h.csv` have exactly two distinct New York times of day, 09:30 and 13:30, across 5,378 trading days; rolled up from 15m they contain 16 and 10 bars (240 and 150 minutes), and an early-close day collapses to a single 14-bar bucket.
- **Week:** crypto weeks start Monday 00:00 UTC. Stock weeks start with the first session of the week (normally Monday; Tuesday after a Monday holiday). **Confirmed:** every crypto weekly bar in the exports is a Monday at 00:00 UTC, and 133 of 1,451 `nvda_1w.csv` bars fall on a Tuesday or later — for example 2000-01-18 after Martin Luther King Jr. Day and 2000-02-22 after Presidents Day.
- **Month:** calendar month; in UTC for crypto and in New York time for stocks. Stock month bars start with the first session of the month. **Confirmed:** every crypto monthly bar is day 1 at 00:00 UTC; stock monthly bars land on only a handful of distinct days of the month, as the first trading day moves.
- **Missing minute:** a minute with no trades has **no bar** (TradingView skips it; we never invent flat bars). A gap is a minute for which the provider's history has a bar but our raw store doesn't. Gap repair re-fetches those from the provider.

## Timestamps
- Every bar is stamped with its **open time in UTC**. TradingView export setting: time format = UNIX timestamp, so exports carry UTC epoch seconds.
- **Stock 1D, 1W and 1M bars are stamped with the session open, 09:30 New York** — not midnight. This rule beat the looser "stamped with that session's date" wording elsewhere in this file, and it was settled by measurement: `nvda_1d.csv` holds 6,992 bars whose New York time of day is **always 09:30**, showing as 13:30 or 14:30 UTC purely because of daylight saving.

  ```
  NVDA 1D  6992 rows  1999-01-22 -> 2026-11-06
    UTC time-of-day: [13:30, 14:30]   NY time-of-day: [09:30]
  ```

  `shared-kernel` originally guessed midnight UTC, which was wrong by 13.5 or 14.5 hours on every stock calendar bar. Verified after fixing: our session opens reproduce **1,717 of 1,717** export stamps in 2020–2026.
- **Discard the last bar of every export.** The newest bar is still forming when the file is saved, so two files saved seconds apart disagree on it — measured on `btcusd_5m.csv`, whose final bar was the only one of 501 that did not match the 1m file. Delayed stock feeds have the same effect for a different reason. Parity must compare up to the fixture's second-to-last bar, never to "now".

## Comparing against the exports (parity)
**Parity is two checks** (Sham, 2026-11-09, M1-14). `pnpm parity` runs both, and only the first decides pass or fail.

### 1. Build parity: exact, and the gate
TradingView's own finer export, rolled up by our code, must equal its coarser export: 1m→5m, 5m→15m, 15m→1h, 1h→4h and 1D, 1D→1W and 1M. Any difference left is in how *we* build bars (bucketing, sessions, DST, week and month starts), which is what these rules exist to get right.
- **Exact; there is no tolerance.** `docs/glossary.md` defines parity as "our output equals the TradingView export, bar for bar", and build parity means that literally. There is nothing to widen to make a failing test pass (CLAUDE.md, "Tests are the spec").
- **Only bars the finer export covers whole are compared.** The first rebuilt bar is dropped when the finer export starts inside it, and the bar holding the finer export's last bar is dropped (it may be partial). Bars before are counted as SKIPPED.
- **Recent bars: a difference is excused, a match still counts.** A bar that closed within **14 days** of the newest bar in either export is compared; if it differs, it is reported as RECENT DIFF and does not fail. Measured on the exports: every disagreement between TradingView's own timeframes but two fell in the last 10 days before each export ended. Those are bars TradingView built from its live feed and has not yet reconciled across timeframes (for example ETH 2026-10-29 18:15: the 15m export carries 0.468 ETH that the 5m and 1h exports do not). Recent bars are not skipped outright, because a 1m export reaches back about 7 days at most, which would leave 5m unchecked. Bars older than 14 days must be exact.
- **Approved exceptions.** Where TradingView's own files contradict each other on an old bar, no code can match both. Such bars are listed one by one, with the evidence, in `contexts/market-data/src/domain/build-parity-exceptions.ts`, only with Sham's approval. The file then reports EXCEPTION, never EXACT. An exception applies only while that bar differs on exactly the listed fields; one that no longer does is reported as stale. Today there are two: BTCUSD 1D 2025-12-28 (daily volume 1% below the sum of its own hourly bars) and ETHUSD 1M 2020-03 (one unit at the 8th decimal, TradingView float rounding).

### 2. Source fidelity: reported, never a gate
Our stored bars (raw 1m, cooked above it) against each export, as the share of bars equal on each field, plus the largest volume gap. It cannot be exact. On the first real comparison (M1-04), Coinbase's own candles differed from the exports in volume on 1–10% of bars, with Coinbase higher by up to ~3.5% an hour: TradingView's record misses trades. Prices differed only at minute boundaries, where a trade lands in a different minute. Any provider that is not TradingView will show this, so fidelity informs and does not block.

### How values are compared (both checks)
- **Compare numerically at the precision the export carries**, not as text: `191.2` and `191.20` are the same price, and a CSV float that parses to `191.19999999999999` is not a difference.
- **Prices (O, H, L, C) are copied, never computed.** An hourly open is some 1-minute bar's open; an hourly high is the highest of its 1-minute highs. So they match exactly, and any difference is a real bug.
- **Volume is summed, so sum it in whole units at the instrument's scale** — 8 decimal places for crypto, whole shares for stocks — and convert for display only. Adding decimal floats drifts (`0.1 + 0.2` is `0.30000000000000004`), and over a month of minutes that drift would fail an exact check for a difference far too small to ever appear on a chart. Integer sums are exact, which is what lets parity stay exact.
- **The scale is the export's precision, not the blockchain's.** Each instrument declares `priceScale` and `volumeScale` (`shared-kernel`), taken from the decimal places the export carries. Native units are the wrong choice for ETH: a month of volume in wei is around 1e25, far beyond the 9e15 that a float64 can hold exactly, so it would destroy the exactness this rule exists to protect. A sum that leaves the exact-integer range raises an error rather than quietly losing the low digits.

## Making the exports (OI-04)
1. Open each symbol above in TradingView with the settings above (regular hours, dividends off).
2. For each timeframe, scroll back as far as the chart will load, then use *Export chart data* (needs a paid plan; chart-data export starts at **Plus** — Essential is ambiguous in TradingView's own docs, so Plus is the safe buy), with time format = UNIX timestamp.
3. Name files `<symbol>_<token>.csv` — **all lower case**, using the file token from the table below (for example `btcusd_1d.csv`, `nvda_1m.csv`, `nvda_1mo.csv`).
4. **Put them in `fixtures/parity/tradingview/` and do not commit them** — that directory is gitignored while the repo is public. See "Where the exports live" below.
5. There are 4 symbols × 8 timeframes = **32 files**. The M1-02 loader reports which are missing.

### How many bars to expect — 10,000 is the ceiling, not a failed export
TradingView caps **intraday** history per plan and [says it cannot be extended](https://www.tradingview.com/support/solutions/43000480679-historical-intraday-data-bars-and-limits-explained/): Basic 5,000 · Essential and Plus **10,000** · Premium 20,000 · Expert 25,000 · Ultimate 40,000. So an intraday export stops at the limit however far you scroll. At 10,000 bars:

| Timeframe | BTC/ETH (24/7) | NVDA/TSLA (390 min/day) |
|---|---|---|
| 1m | ~7 days | ~26 trading days |
| 5m | ~35 days | ~6 months |
| 15m | ~104 days | ~1.5 years |
| 1h | ~1.1 years | ~5.7 years |
| 4h | ~4.5 years | ~20 years |

**1D, 1W and 1M are not intraday and are not capped this way**, so daily history should reach back to each stock's listing (NVDA 1999, TSLA 2010). That is what makes M1-12 — the calendar back to 1999 — a prerequisite for stock D/W/M parity rather than a later tidy-up.

This is plenty for parity: proving a rollup is correct needs every boundary crossed many times, not years of it. What matters more than depth is that the short 1m windows **land on the days that break things**. If the default scroll-back does not include them, re-export with the chart positioned so it does:

- a DST changeover: 9 to 11 March 2024 and 1 to 4 November 2024 (stocks)
- an early close: 29 November 2024, the day after Thanksgiving (stocks)
- a full holiday: 25 December 2024 (stocks — the export should have no bars at all that day)
- a split: 10 June 2024 for NVDA, 25 August 2022 for TSLA (daily is enough)
- a month and a year boundary, for both crypto and stocks

### Where the exports live
**Not in git, while the repo is public.** NVDA and TSLA bars are Nasdaq-licensed and TradingView's terms restrict redistribution, so committing them to a public repository is a licensing problem rather than an untidiness. `.gitignore` therefore ignores everything in `fixtures/parity/tradingview/` except `.gitkeep`.

Consequences, all deliberate:
- `pnpm parity` runs **locally only**. The CI parity job that M1-03 was to add cannot compare against files CI does not have.
- The loader and the parity harness are still tested in CI, against **small synthetic sample files** committed in the repo. Synthetic bars are not licensed data; they prove the code works, not that our bars match TradingView.
- Parity against the real exports is therefore a **by-hand step before each milestone sign-off**, run by whoever has the fixtures, until the repo is private.

**M1-13** reverses all of this once the repo is private and on GitHub Pro: commit the exports with the `fixtures-approved` label, and turn on the required CI parity job.

### File name tokens
Timeframe names in code stay as the glossary defines them (`1m`, `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`). File names use these tokens instead:

| Timeframe | File token | Timeframe | File token |
|---|---|---|---|
| 1m | `1m` | 4h | `4h` |
| 5m | `5m` | 1D | `1d` |
| 15m | `15m` | 1W | `1w` |
| 1h | `1h` | 1M | `1mo` |

**Why lower case, and why `1mo` for monthly.** macOS and Windows file systems are case-insensitive by default, so `NVDA_1m.csv` and `NVDA_1M.csv` are *the same file*: exporting one after the other silently leaves a single file, and the export set looks complete while the 1-minute bars are gone. Lower-case-only names cannot collide under case folding, and `1mo` keeps monthly distinct from 1-minute without relying on case. The loader maps tokens back to the canonical timeframe names.
