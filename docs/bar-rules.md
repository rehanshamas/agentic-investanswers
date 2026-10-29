# Bar rules

How bars are built so they match TradingView exactly. Sham answers every `TODO(Sham)`; Claude formats. Owner input OI-05 stays pending until none are left.

## Instruments for parity
- Crypto: BTC, ETH. Provider: CoinAPI. TradingView symbol used for the exports: TODO(Sham)
- Stocks: TODO(Sham) and TODO(Sham). Provider: Massive. TradingView symbols used: TODO(Sham)

## Crypto
- Trades 24/7. Daily bar closes at 00:00 UTC.
- Which exchange or index TradingView uses for the exports (bars differ between venues): TODO(Sham)

## Stocks
- Regular session only, or extended hours included in the exports: TODO(Sham)
- Session hours and time zone: 09:30 to 16:00 America/New_York (confirm): TODO(Sham)
- Holidays and early closes: NYSE calendar (confirm): TODO(Sham)
- Split and dividend adjustment in the exports (on or off): TODO(Sham)

## All markets
- Week start (Monday 00:00 UTC for crypto; first session of the week for stocks?): TODO(Sham)
- Month bars: calendar month in the exchange time zone (confirm): TODO(Sham)
- Volume: base asset units or quote currency, as in the exports: TODO(Sham)
- A "missing minute" is a minute inside market hours with no stored 1m bar. A minute with no trades is: (a) skipped, as TradingView does, or (b) stored as a flat bar. TODO(Sham)

## Timestamps
- Bars are stamped with their open time, in UTC.
