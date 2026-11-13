// Hand-worked cases: every expected number below is worked out from the bars
// in the test, so each one checks a Strategy Tester rule, not the code itself.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { barTime, price, volume } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';

import type { BacktestConfig, Signal } from './backtest.js';
import { BacktestError, TRADINGVIEW_DEFAULTS, backtest, startBacktest, stepBacktest, summarise } from './backtest.js';

const btc: Instrument = { symbol: 'BTCUSD', kind: 'crypto', venue: 'test', timeZone: 'UTC', priceScale: 2, volumeScale: 8 };
const T0 = 1_731_000_000;
const t = (i: number): BarTime => barTime(T0 + i * 60);
const cents = (dollars: number) => price(Math.round(dollars * 100));

/** Bars from [open, high, low, close] in dollars, one minute apart. */
function bars(...ohlc: [number, number, number, number][]): Bar[] {
  return ohlc.map(([o, h, l, c], i) => ({
    time: t(i),
    open: cents(o),
    high: cents(h),
    low: cents(l),
    close: cents(c),
    volume: volume(1),
  }));
}

const flat = (value: number): [number, number, number, number] => [value, value + 1, value - 1, value];

describe('orders fill at the next open', () => {
  it('a long entered and exited by signals', () => {
    const b = bars(flat(100), [101, 102, 100, 101], [103, 106, 102, 105], [105, 107, 104, 106]);
    const signals: Signal[] = [
      { time: t(0), kind: 'enter', side: 'long' },
      { time: t(2), kind: 'exit' },
    ];
    const { trades, open, totals } = backtest(btc, b, signals);
    expect(trades).toEqual([
      {
        side: 'long',
        quantity: 1,
        entryTime: t(1),
        entryPrice: 101,
        exitTime: t(3),
        exitPrice: 105,
        exitReason: 'signal',
        commission: 0,
        profit: 4,
        profitPercent: 3.96, // 4 / 101
      },
    ]);
    expect(open).toBeUndefined();
    expect(totals).toMatchObject({ closedTrades: 1, winningTrades: 1, netProfit: 4, winRate: 100 });
  });

  it('entering the other side closes the position and opens the new one at the same open', () => {
    const b = bars(flat(100), flat(100), flat(110), flat(104));
    const { trades, open } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long' },
      { time: t(1), kind: 'enter', side: 'short' },
    ]);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: 'long', entryPrice: 100, exitPrice: 110, exitReason: 'reverse', profit: 10 });
    // Short from 110, marked at the last close of 104.
    expect(open).toMatchObject({ side: 'short', entryTime: t(2), entryPrice: 110, openProfit: 6 });
  });

  it('ignores an entry on the side already held (one position at a time)', () => {
    const b = bars(flat(100), flat(101), flat(102), flat(103));
    const { trades, open } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long' },
      { time: t(1), kind: 'enter', side: 'long' },
    ]);
    expect(trades).toHaveLength(0);
    expect(open).toMatchObject({ entryPrice: 101, quantity: 1 });
  });

  it('ignores an exit while flat', () => {
    const { trades, open, pending } = backtest(btc, bars(flat(100), flat(101)), [{ time: t(0), kind: 'exit' }]);
    expect([trades.length, open, pending]).toEqual([0, undefined, undefined]);
  });

  it('reports an order signalled on the last bar as pending, not filled', () => {
    const signal: Signal = { time: t(1), kind: 'enter', side: 'long' };
    const { open, pending } = backtest(btc, bars(flat(100), flat(101)), [signal]);
    expect(open).toBeUndefined();
    expect(pending).toEqual(signal);
  });
});

describe('stops and targets inside the bar', () => {
  it('a long stop fills at the stop when the low reaches it', () => {
    const b = bars(flat(100), [100, 101, 99, 100], [99, 99.5, 94, 96]);
    const { trades } = backtest(btc, b, [{ time: t(0), kind: 'enter', side: 'long', stop: 95 }]);
    expect(trades[0]).toMatchObject({ exitTime: t(2), exitPrice: 95, exitReason: 'stop', profit: -5 });
  });

  it('a gap through the stop fills at the open, not at the stop', () => {
    const b = bars(flat(100), [100, 101, 99, 100], [90, 91, 88, 89]);
    const { trades } = backtest(btc, b, [{ time: t(0), kind: 'enter', side: 'long', stop: 95 }]);
    expect(trades[0]).toMatchObject({ exitPrice: 90, exitReason: 'stop', profit: -10 });
  });

  it('the stop is live on the fill bar itself', () => {
    const b = bars(flat(100), [100, 100.5, 97, 98]);
    const { trades } = backtest(btc, b, [{ time: t(0), kind: 'enter', side: 'long', stop: 98 }]);
    expect(trades[0]).toMatchObject({ entryTime: t(1), exitTime: t(1), exitPrice: 98, exitReason: 'stop' });
  });

  it('high nearer the open: open, high, low, close, so the target fills before the stop', () => {
    // Open 100, high 103 (3 away), low 90 (10 away).
    const b = bars(flat(100), [100, 100.5, 99.5, 100], [100, 103, 90, 95]);
    const { trades } = backtest(btc, b, [{ time: t(0), kind: 'enter', side: 'long', stop: 95, target: 102 }]);
    expect(trades[0]).toMatchObject({ exitTime: t(2), exitPrice: 102, exitReason: 'target' });
  });

  it('low nearer the open: open, low, high, close, so the stop fills before the target', () => {
    // Open 100, low 98 (2 away), high 110 (10 away).
    const b = bars(flat(100), [100, 100.5, 99.5, 100], [100, 110, 98, 108]);
    const { trades } = backtest(btc, b, [{ time: t(0), kind: 'enter', side: 'long', stop: 99, target: 105 }]);
    expect(trades[0]).toMatchObject({ exitPrice: 99, exitReason: 'stop', profit: -1 });
  });

  it('a short: the stop is above, the target below', () => {
    const b = bars(flat(100), [100, 100.5, 99.5, 100], [100, 101, 94, 95], [100, 106, 99, 105]);
    const target = backtest(btc, b.slice(0, 3), [{ time: t(0), kind: 'enter', side: 'short', stop: 105, target: 95 }]);
    expect(target.trades[0]).toMatchObject({ exitPrice: 95, exitReason: 'target', profit: 5 });
    const stopped = backtest(btc, [b[0], b[1], b[3]].map((bar, i) => ({ ...(bar as Bar), time: t(i) })), [
      { time: t(0), kind: 'enter', side: 'short', stop: 105, target: 95 },
    ]);
    expect(stopped.trades[0]).toMatchObject({ exitPrice: 105, exitReason: 'stop', profit: -5 });
  });

  it('a protect signal moves the stop from the next bar on (a trailing stop)', () => {
    const b = bars(flat(100), [100, 104, 99.5, 104], [104, 108, 103, 107], [107, 107.5, 104, 105]);
    const { trades } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long', stop: 95 },
      { time: t(1), kind: 'protect', stop: 102 },
      { time: t(2), kind: 'protect', stop: 105.5 },
    ]);
    // Bar 2's low (103) is above the stop of 102 that applied to it; bar 3's low (104) hits 105.5.
    expect(trades[0]).toMatchObject({ exitTime: t(3), exitPrice: 105.5, exitReason: 'stop', profit: 5.5 });
  });

  it('a protect signal with null removes a level', () => {
    const b = bars(flat(100), [100, 101, 99.5, 100], [100, 101, 90, 91]);
    const { trades, open } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long', stop: 95 },
      { time: t(1), kind: 'protect', stop: null },
    ]);
    expect(trades).toHaveLength(0);
    expect(open?.stop).toBeUndefined();
  });
});

describe('sizing and commission', () => {
  it('takes a percentage commission on both fills, net of profit', () => {
    const config: BacktestConfig = { initialCapital: 10_000, sizing: { kind: 'fixed', quantity: 10 }, commissionPercent: 0.1 };
    const b = bars(flat(100), flat(100), flat(110), flat(110));
    const { trades, totals } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long' },
      { time: t(1), kind: 'exit' },
    ], config);
    // Entry 1,000 × 0.1% = 1.00; exit 1,100 × 0.1% = 1.10; gross 100.
    expect(trades[0]).toMatchObject({ commission: 2.1, profit: 97.9 });
    expect(totals).toMatchObject({ commission: 2.1, netProfit: 97.9, roi: 0.98 });
  });

  it('sizes by a share of equity at the signal close, growing with closed profit', () => {
    const config: BacktestConfig = { initialCapital: 10_000, sizing: { kind: 'percentOfEquity', percent: 50 } };
    const b = bars(flat(100), flat(100), flat(120), flat(200), flat(200), flat(210));
    const { trades } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long' }, // 5,000 / 100 = 50 units
      { time: t(1), kind: 'exit' }, // out at 120: +1,000
      { time: t(3), kind: 'enter', side: 'long' }, // 5,500 / 200 = 27.5 units
      { time: t(4), kind: 'exit' }, // out at 210: +275
    ], config);
    expect(trades.map((x) => [x.quantity, x.profit])).toEqual([
      [50, 1_000],
      [27.5, 275],
    ]);
  });
});

describe('totals', () => {
  it('counts wins and losses, and works out win rate, ROI and profit factor', () => {
    const b = bars(flat(100), flat(100), flat(110), flat(110), flat(104), flat(104), flat(101), flat(101));
    const { totals } = backtest(btc, b, [
      { time: t(0), kind: 'enter', side: 'long' }, // 100 -> 110: +10
      { time: t(1), kind: 'exit' },
      { time: t(2), kind: 'enter', side: 'long' }, // 110 -> 104: -6
      { time: t(3), kind: 'exit' },
      { time: t(4), kind: 'enter', side: 'short' }, // 104 -> 101: +3
      { time: t(5), kind: 'exit' },
    ]);
    expect(totals).toEqual({
      closedTrades: 3,
      winningTrades: 2,
      losingTrades: 1,
      winRate: 66.67,
      grossProfit: 13,
      grossLoss: 6,
      netProfit: 7,
      roi: 0, // 7 on TradingView's default 1,000,000 capital
      profitFactor: 2.167,
      commission: 0,
      averageTrade: 2.33,
    });
  });

  it('is all zero with no trades, and the profit factor is null without a loss', () => {
    const none = backtest(btc, bars(flat(100)), []);
    expect(none.totals).toMatchObject({ closedTrades: 0, winRate: 0, netProfit: 0, averageTrade: 0, profitFactor: null });
  });

  it('sums profit to the cent without float drift', () => {
    // Ten trades of +0.10 each.
    const ohlc: [number, number, number, number][] = [];
    const signals: Signal[] = [];
    for (let i = 0; i < 10; i += 1) {
      ohlc.push(flat(100), flat(100), flat(100.1));
      signals.push({ time: t(i * 3), kind: 'enter', side: 'long' }, { time: t(i * 3 + 1), kind: 'exit' });
    }
    expect(backtest(btc, bars(...ohlc), signals).totals.netProfit).toBe(1);
  });
});

describe('refuses bad input', () => {
  const b = bars(flat(100), flat(101));
  it.each<[string, () => unknown]>([
    ['a signal not on a bar', () => backtest(btc, b, [{ time: barTime(T0 + 30), kind: 'exit' }])],
    [
      'signals out of order',
      () => backtest(btc, b, [{ time: t(1), kind: 'exit' }, { time: t(0), kind: 'exit' }]),
    ],
    ['bars out of order', () => backtest(btc, [b[1] as Bar, b[0] as Bar], [])],
    ['no capital', () => backtest(btc, b, [], { ...TRADINGVIEW_DEFAULTS, initialCapital: 0 })],
    ['a zero quantity', () => backtest(btc, b, [], { ...TRADINGVIEW_DEFAULTS, sizing: { kind: 'fixed', quantity: 0 } })],
    ['over 100% of equity', () => backtest(btc, b, [], { ...TRADINGVIEW_DEFAULTS, sizing: { kind: 'percentOfEquity', percent: 150 } })],
  ])('%s', (_, run) => {
    expect(run).toThrow(BacktestError);
  });
});

describe('bar by bar, as bars close', () => {
  // A mixed run: signals, reversals, stops, a trailing stop and commission.
  const ohlc: [number, number, number, number][] = [];
  for (let i = 0; i < 120; i += 1) {
    const base = 100 + 8 * Math.sin(i / 6) + (i % 7) * 0.3;
    ohlc.push([base, base + 1.2 + (i % 3) * 0.4, base - 1.1 - (i % 4) * 0.3, base + ((i % 5) - 2) * 0.35]);
  }
  const b = bars(...ohlc);
  const signals: Signal[] = [];
  for (let i = 2; i < 118; i += 1) {
    const prev = ohlc[i - 1] as [number, number, number, number];
    const cur = ohlc[i] as [number, number, number, number];
    if (prev[3] < cur[3] && i % 9 === 0) signals.push({ time: t(i), kind: 'enter', side: 'long', stop: cur[3] - 3 });
    else if (prev[3] > cur[3] && i % 11 === 0) signals.push({ time: t(i), kind: 'enter', side: 'short', stop: cur[3] + 3, target: cur[3] - 4 });
    else if (i % 13 === 0) signals.push({ time: t(i), kind: 'protect', stop: cur[3] - 1.5 });
    else if (i % 17 === 0) signals.push({ time: t(i), kind: 'exit' });
  }
  const config: BacktestConfig = { initialCapital: 50_000, sizing: { kind: 'percentOfEquity', percent: 20 }, commissionPercent: 0.05 };

  it('gives exactly the same trades and totals as a run over the whole history, at every bar', () => {
    let state = startBacktest(config);
    for (const [i, bar] of b.entries()) {
      state = stepBacktest(state, btc, bar, signals.filter((s) => s.time === bar.time));
      const batch = backtest(btc, b.slice(0, i + 1), signals.filter((s) => s.time <= bar.time), config);
      expect(summarise(state, btc)).toEqual(batch);
    }
    expect(summarise(state, btc).trades.length).toBeGreaterThan(3);
  });

  it('never changes the state it was given, so a forming bar can be tried and thrown away', () => {
    let state = startBacktest(config);
    for (const bar of b.slice(0, 60)) state = stepBacktest(state, btc, bar, signals.filter((s) => s.time === bar.time));
    const before = JSON.stringify(state);
    stepBacktest(state, btc, b[60] as Bar, signals.filter((s) => s.time === (b[60] as Bar).time));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('survives a round trip through JSON (so it can be cached) and carries on identically', () => {
    let state = startBacktest(config);
    for (const bar of b.slice(0, 60)) state = stepBacktest(state, btc, bar, signals.filter((s) => s.time === bar.time));
    let restored = JSON.parse(JSON.stringify(state)) as typeof state;
    for (const bar of b.slice(60)) {
      const at = signals.filter((s) => s.time === bar.time);
      state = stepBacktest(state, btc, bar, at);
      restored = stepBacktest(restored, btc, bar, at);
    }
    expect(summarise(restored, btc)).toEqual(summarise(state, btc));
  });

  it('refuses a bar that is not after the last one, or a signal for another bar', () => {
    const state = stepBacktest(startBacktest(), btc, b[1] as Bar);
    expect(() => stepBacktest(state, btc, b[0] as Bar)).toThrow(BacktestError);
    expect(() => stepBacktest(startBacktest(), btc, b[0] as Bar, [{ time: t(1), kind: 'exit' }])).toThrow(BacktestError);
  });
});
