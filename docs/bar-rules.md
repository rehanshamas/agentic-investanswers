# Bar rules

How bars are built so they match TradingView exactly (requirements §4: "Bars must be built the same way TradingView builds them (trading sessions, week start, crypto daily close at 00:00 UTC)"; "Split-adjusted prices").
Every rule here has a matching **export setting** in TradingView: the exports in `fixtures/parity/tradingview/` must be made with exactly these settings, or parity will fail for reasons that aren't bugs.

## Instruments for parity
| Instrument | TradingView symbol (exports) | Provider symbol | Why |
|---|---|---|---|
| BTC | `COINBASE:BTCUSD` | CoinAPI `COINBASE_SPOT_BTC_USD` | Same venue on both sides; bars differ between exchanges |
| ETH | `COINBASE:ETHUSD` | CoinAPI `COINBASE_SPOT_ETH_USD` | Same |
| NVDA | `NASDAQ:NVDA` | Massive `NVDA` | On the client's launch list; 10-for-1 split in June 2024 tests split adjustment |
| TSLA | `NASDAQ:TSLA` | Massive `TSLA` | On the client's launch list; 3-for-1 split in Aug 2022 |


## Crypto
- Trades 24/7; there are no sessions, holidays or gaps by design.
- Daily bar: 00:00 to 24:00 UTC.
- Volume is in the base asset (BTC, ETH), as TradingView shows for `COINBASE:BTCUSD`.

## Stocks
- **Regular trading hours only.** 09:30 to 16:00 America/New_York; pre-market and after-hours minutes are not part of any bar. TradingView export setting: chart session = *Regular trading hours* (the default; "Extended trading hours" off).
- Time zone and daylight saving: sessions are defined in America/New_York and stored in UTC, so the session is 14:30 to 21:00 UTC in winter and 13:30 to 20:00 UTC in summer.
- **Holidays and early closes:** NYSE/Nasdaq calendar. Early-close days end at 13:00 New York time (for example the day after Thanksgiving and Christmas Eve). The calendar lives in config, one list per year.
- **Split-adjusted, not dividend-adjusted.** All history is adjusted for splits (NVDA before 10 June 2024 divided by 10). TradingView export setting: "Adjust data for dividends" **off** (TradingView always adjusts for splits).
- Volume is in shares.
- **Daily, weekly and monthly stock bars (known risk):** TradingView's daily stock bar uses the exchange's official open and close (the auctions) and the full day's consolidated volume, which can differ slightly from summing 1-minute regular-hours bars. Default: build D/W/M from 1-minute bars as everything else. If parity fails only on stock D/W/M open, close or volume, use Massive's daily bars for stock D, roll W and M from them, and record it here; the brief allows this exception.

## All markets
- **Timeframes:** 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M. Intraday bars are aligned to the session start for stocks (09:30, 10:30, ... for 1h; the last bar of the day is shorter) and to 00:00 UTC for crypto.
- **Stock 4h bars (the session doesn't divide evenly):** a 6.5-hour session gives one full 4h bar and a short one. Bars start at the session open and **reset each session**: 09:30–13:30 and 13:30–16:00 New York, two bars per trading day. A session's last bar is short; **a bar never spans two sessions.** Crypto 4h is unaffected: 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC. *(Confirm against `nvda_4h.csv` when the exports land — expect two rows per trading day, at 09:30 and 13:30 New York.)*
- **Week:** crypto weeks start Monday 00:00 UTC. Stock weeks start with the first session of the week (normally Monday; Tuesday after a Monday holiday) and the bar is stamped with that session's date.
- **Month:** calendar month; in UTC for crypto and in New York time for stocks. Stock month bars start with the first session of the month.
- **Missing minute:** a minute with no trades has **no bar** (TradingView skips it; we never invent flat bars). A gap is a minute for which the provider's history has a bar but our raw store doesn't. Gap repair re-fetches those from the provider.

## Timestamps
- Every bar is stamped with its **open time in UTC**. TradingView export setting: time format = UNIX timestamp, so exports carry UTC epoch seconds.

## Comparing against the exports (parity)
- **Parity is exact; there is no tolerance.** `docs/glossary.md` defines parity as "our output equals the TradingView export, bar for bar", and that is meant literally. There is no margin of error to widen, so there is nothing for a failing test to be made to pass against (CLAUDE.md, "Tests are the spec").
- **Compare numerically at the precision the export carries**, not as text: `191.2` and `191.20` are the same price, and a CSV float that parses to `191.19999999999999` is not a difference.
- **Prices (O, H, L, C) are copied, never computed.** An hourly open is some 1-minute bar's open; an hourly high is the highest of its 1-minute highs. So they match exactly, and any difference is a real bug.
- **Volume is summed, so sum it in whole units at the instrument's scale** — 8 decimal places for crypto, whole shares for stocks — and convert for display only. Adding decimal floats drifts (`0.1 + 0.2` is `0.30000000000000004`), and over a month of minutes that drift would fail an exact check for a difference far too small to ever appear on a chart. Integer sums are exact, which is what lets parity stay exact.
- **The scale is the export's precision, not the blockchain's.** Each instrument declares `priceScale` and `volumeScale` (`shared-kernel`), taken from the decimal places the export carries. Native units are the wrong choice for ETH: a month of volume in wei is around 1e25, far beyond the 9e15 that a float64 can hold exactly, so it would destroy the exactness this rule exists to protect. A sum that leaves the exact-integer range raises an error rather than quietly losing the low digits.

## Making the exports (OI-04)
1. Open each symbol above in TradingView with the settings above (regular hours, dividends off).
2. For each timeframe, scroll back until the chart has loaded as much history as possible, then use *Export chart data* (needs a paid TradingView plan), with time format = UNIX timestamp.
3. Name files `<symbol>_<token>.csv` — **all lower case**, using the file token from the table below (for example `btcusd_1d.csv`, `nvda_1m.csv`, `nvda_1mo.csv`). Put them in `fixtures/parity/tradingview/`. Commit them in a PR and add the `fixtures-approved` label.
4. There are 4 symbols × 8 timeframes = **32 files**. The M1-02 loader fails if any is missing.

### File name tokens
Timeframe names in code stay as the glossary defines them (`1m`, `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`). File names use these tokens instead:

| Timeframe | File token | Timeframe | File token |
|---|---|---|---|
| 1m | `1m` | 4h | `4h` |
| 5m | `5m` | 1D | `1d` |
| 15m | `15m` | 1W | `1w` |
| 1h | `1h` | 1M | `1mo` |

**Why lower case, and why `1mo` for monthly.** macOS and Windows file systems are case-insensitive by default, so `NVDA_1m.csv` and `NVDA_1M.csv` are *the same file*: exporting one after the other silently leaves a single file, and the export set looks complete while the 1-minute bars are gone. Lower-case-only names cannot collide under case folding, and `1mo` keeps monthly distinct from 1-minute without relying on case. The loader maps tokens back to the canonical timeframe names.
