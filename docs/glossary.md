# Glossary

- **Bar**: open, high, low, close, volume for one instrument over one timeframe period, stamped with its open time (UTC). Never "candle".
- **Timeframe**: 1m, 5m, 15m, 1h, 4h, 1D, 1W, 1M. Never "interval".
- **Instrument**: a tradable symbol (BTC, ETH, a stock).
- **Market session**: the hours an instrument trades; stocks have sessions, crypto trades 24/7.
- **Raw data**: provider data exactly as received; write-once, never edited.
- **Cooked bars**: bars derived from raw 1-minute bars; always rebuildable from raw.
- **Hydration**: loading history once, then keeping data current from live streams, and repairing gaps.
- **Indicator**: a ported TradingView script (for example IA-ATR-Model 2.1). Never call it a "model".
- **Parity** (build parity): our output equals the TradingView export, bar for bar — measured by rolling TradingView's own finer export up with our code and comparing it with its coarser export, exactly. The gate. See `docs/bar-rules.md`.
- **Source fidelity**: how closely our provider's bars match the TradingView export, as match rates per field. Reported, never a gate, because TradingView's record misses some trades.
- **Principal**: who is making a request, a human or an agent. Every request carries one.
- **Plan**: the customer's subscription tier, which decides what they can see.
