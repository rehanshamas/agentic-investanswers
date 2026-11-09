"""Generate the synthetic parity samples in this directory.

Run from this directory:  python3 -I generate.py

These are made-up BTCUSD bars, not licensed data, so they can be committed
while the real exports cannot (docs/bar-rules.md, "Where the exports live").
They let CI prove the parity harness works; they prove nothing about whether
our bars match TradingView.

The higher timeframes are aggregated here, in Python with Decimal, on purpose:
if they came from our own rollUp, a rollup bug would be copied into the
expected files and the samples would only test themselves.

What the series covers, 2025-12-31 16:00 to 2026-01-01 03:59 UTC:
- a year, month and day boundary at 00:00;
- minutes with no trades (no bar, never a flat one), including the first
  minute of a 4h bar and the 00:00 minute, so opens come from later minutes;
- a whole 5m bucket with no trades (01:10 to 01:14), so no 5m bar exists;
- volumes in tenths, which drift if summed as floats (0.1 + 0.2).

Every file ends with one extra "forming" row, as a real export does
(docs/bar-rules.md, "Discard the last bar of every export"). Its values are
deliberately wrong, so a harness that forgot to drop it would fail.
"""

from datetime import datetime, timezone
from decimal import Decimal

START = int(datetime(2025, 12, 31, 16, 0, tzinfo=timezone.utc).timestamp())
MINUTES = 12 * 60
GAPS = {"17:03", "20:00", "23:59", "00:00", "01:10", "01:11", "01:12", "01:13", "01:14", "02:30"}
CENT = Decimal("0.01")


def hhmm(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%H:%M")


def lcg(seed):
    state = seed
    while True:
        state = (state * 1103515245 + 12345) % 2**31
        yield state


def minutes():
    rand = lcg(20260101)
    close = Decimal("93000.00")
    bars = []
    for i in range(MINUTES):
        t = START + i * 60
        open_ = close
        close = open_ + Decimal(next(rand) % 2001 - 1000) * CENT
        high = max(open_, close) + Decimal(next(rand) % 500) * CENT
        low = min(open_, close) - Decimal(next(rand) % 500) * CENT
        volume = Decimal(next(rand) % 30 + 1) / 10
        if hhmm(t) in GAPS:
            continue
        bars.append((t, open_, high, low, close, volume))
    return bars


def roll_up(bars, seconds):
    buckets = {}
    for bar in bars:
        buckets.setdefault(bar[0] - bar[0] % seconds, []).append(bar)
    out = []
    for t in sorted(buckets):
        group = buckets[t]
        out.append((
            t,
            group[0][1],
            max(b[2] for b in group),
            min(b[3] for b in group),
            group[-1][4],
            sum((b[5] for b in group), Decimal(0)),
        ))
    return out


def write(name, bars, seconds):
    end = START + MINUTES * 60
    forming = (end, Decimal("1.00"), Decimal("999999.00"), Decimal("1.00"),
               Decimal("2.00"), Decimal("12345"))
    with open(name, "w", newline="") as f:
        f.write("time,open,high,low,close,Volume\n")
        for t, o, h, l, c, v in bars + [forming]:
            f.write(f"{t},{o:.2f},{h:.2f},{l:.2f},{c:.2f},{v.normalize():f}\n")


def main():
    one = minutes()
    write("btcusd_1m.csv", one, 60)
    for token, seconds in [("5m", 300), ("15m", 900), ("1h", 3600), ("4h", 14400)]:
        write(f"btcusd_{token}.csv", roll_up(one, seconds), seconds)


if __name__ == "__main__":
    main()
