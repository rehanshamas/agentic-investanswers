// The shared backtest engine (M3-06): bars and signals in, trades and totals out.
// Pure.
//
// It follows the defaults of TradingView's Strategy Tester, because backtest
// parity (M3-03, M3-07c) compares our totals with its exports:
// - A signal is read at the close of its bar and its order fills at the OPEN
//   of the next bar (TradingView's default, process_orders_on_close = false).
// - One position at a time (pyramiding 0). Entering the other side while in
//   a position closes it and opens the new one, at the same open.
// - Stops and targets are checked inside each bar, the fill bar included,
//   along TradingView's assumed price path: if the high is nearer the open
//   than the low, open -> high -> low -> close, otherwise open -> low -> high
//   -> close. If the bar opens beyond a level, it fills at the open (a gap).
// - Commission is a percentage of each fill's value, on entry and on exit;
//   zero unless set. No slippage.
// Indicators produce the signals (an ATR port turns its markers and stop
// levels into them); the engine knows nothing about how they were made.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';

export type Side = 'long' | 'short';

/**
 * What a strategy says at the close of a bar.
 * - `enter`: open a position on that side at the next open (closing the other side first).
 *   Optional stop and target (decimal prices) protect it from the fill bar onwards.
 * - `exit`: close the open position at the next open.
 * - `protect`: move the open position's stop and/or target, from the next bar on
 *   (a trailing stop). `null` removes a level; leaving a field out keeps it.
 */
export type Signal =
  | { readonly time: BarTime; readonly kind: 'enter'; readonly side: Side; readonly stop?: number; readonly target?: number }
  | { readonly time: BarTime; readonly kind: 'exit' }
  | { readonly time: BarTime; readonly kind: 'protect'; readonly stop?: number | null; readonly target?: number | null };

export type Sizing =
  | { readonly kind: 'fixed'; readonly quantity: number }
  /**
   * A share of equity at the signal bar's close: initial capital plus closed
   * profit plus the open position's profit (TradingView's strategy.equity).
   */
  | { readonly kind: 'percentOfEquity'; readonly percent: number };

export interface BacktestConfig {
  readonly initialCapital: number;
  readonly sizing: Sizing;
  /** Percent of each fill's value. TradingView's default is 0. */
  readonly commissionPercent?: number;
}

/** TradingView's Strategy Tester defaults: 1,000,000 capital, 1 unit per trade, no commission. */
export const TRADINGVIEW_DEFAULTS: BacktestConfig = {
  initialCapital: 1_000_000,
  sizing: { kind: 'fixed', quantity: 1 },
  commissionPercent: 0,
};

export type ExitReason = 'signal' | 'reverse' | 'stop' | 'target';

export interface Trade {
  readonly side: Side;
  readonly quantity: number;
  readonly entryTime: BarTime;
  readonly entryPrice: number;
  readonly exitTime: BarTime;
  readonly exitPrice: number;
  readonly exitReason: ExitReason;
  readonly commission: number;
  /** Net of commission, in the quote currency. */
  readonly profit: number;
  /** Profit as a percentage of the entry value. */
  readonly profitPercent: number;
}

export interface OpenPosition {
  readonly side: Side;
  readonly quantity: number;
  readonly entryTime: BarTime;
  readonly entryPrice: number;
  readonly stop: number | undefined;
  readonly target: number | undefined;
  /** At the last bar's close, net of the entry commission. */
  readonly openProfit: number;
}

export interface BacktestTotals {
  readonly closedTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  /** Winning trades as a percentage of closed trades; 0 with no trades. */
  readonly winRate: number;
  readonly grossProfit: number;
  /** As a positive number. */
  readonly grossLoss: number;
  readonly netProfit: number;
  /** Net profit as a percentage of initial capital. */
  readonly roi: number;
  /** Gross profit over gross loss; null with no losing trades. */
  readonly profitFactor: number | null;
  readonly commission: number;
  readonly averageTrade: number;
}

export interface BacktestResult {
  readonly trades: readonly Trade[];
  readonly open: OpenPosition | undefined;
  /** An order signalled on the last bar, still waiting for a next open. */
  readonly pending: Signal | undefined;
  readonly totals: BacktestTotals;
}

export class BacktestError extends Error {}

interface Position {
  side: Side;
  quantity: number;
  entryTime: BarTime;
  entryPrice: number;
  entryCommission: number;
  stop: number | undefined;
  target: number | undefined;
}

interface Prices {
  readonly time: BarTime;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

function checkConfig(config: BacktestConfig): void {
  if (!(config.initialCapital > 0)) throw new BacktestError('Initial capital must be positive');
  const commission = config.commissionPercent ?? 0;
  if (!(commission >= 0 && commission < 100)) throw new BacktestError('Commission must be a percentage from 0 to below 100');
  const { sizing } = config;
  if (sizing.kind === 'fixed' && !(sizing.quantity > 0)) throw new BacktestError('Fixed quantity must be positive');
  if (sizing.kind === 'percentOfEquity' && !(sizing.percent > 0 && sizing.percent <= 100)) {
    throw new BacktestError('Percent of equity must be above 0 and at most 100');
  }
}

/** Where a stop or target fills inside a bar, or undefined if neither is touched. */
function intrabarExit(position: Position, bar: Prices): { price: number; reason: 'stop' | 'target' } | undefined {
  const { stop, target, side } = position;
  const long = side === 'long';
  const stopHit = (price: number) => stop !== undefined && (long ? price <= stop : price >= stop);
  const targetHit = (price: number) => target !== undefined && (long ? price >= target : price <= target);

  // A gap through a level fills at the open.
  if (stopHit(bar.open)) return { price: bar.open, reason: 'stop' };
  if (targetHit(bar.open)) return { price: bar.open, reason: 'target' };

  const highFirst = bar.high - bar.open <= bar.open - bar.low;
  const legs = highFirst
    ? [{ to: bar.high, up: true }, { to: bar.low, up: false }]
    : [{ to: bar.low, up: false }, { to: bar.high, up: true }];
  for (const { to, up } of legs) {
    // Moving up can reach a long's target or a short's stop; moving down, the reverse.
    const reason = long === up ? 'target' : 'stop';
    if (reason === 'target' ? targetHit(to) : stopHit(to)) {
      return { price: reason === 'stop' ? (stop as number) : (target as number), reason };
    }
  }
  return undefined;
}

/** An open position's profit at a price, net of its entry commission. */
function openProfitAt(position: Readonly<Position>, price: number): number {
  const gross = (position.side === 'long' ? price - position.entryPrice : position.entryPrice - price) * position.quantity;
  return gross - position.entryCommission;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(Number((value * factor).toPrecision(15))) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Currency values in results are rounded to cents, as the Strategy Tester shows them. */
const MONEY_DECIMALS = 2;

/**
 * A backtest part-way through: everything needed to take the next bar. Plain
 * data, never changed in place, so it can be cached and resumed like an
 * indicator run, and a live bar can be tried without keeping the result.
 */
export interface BacktestState {
  readonly config: BacktestConfig;
  readonly trades: readonly Trade[];
  readonly realised: number;
  readonly position: Readonly<Position> | undefined;
  readonly pending: { readonly signal: Signal; readonly quantity: number } | undefined;
  readonly lastBar: Bar | undefined;
}

export function startBacktest(config: BacktestConfig = TRADINGVIEW_DEFAULTS): BacktestState {
  checkConfig(config);
  return { config, trades: [], realised: 0, position: undefined, pending: undefined, lastBar: undefined };
}

/**
 * Take one closed bar and the signals at its close. The given state is left
 * unchanged. This is the only place the rules live: a backtest over all
 * stored history at once and one advanced bar by bar as bars close (live)
 * both go through it, so they agree exactly on every closed bar.
 */
export function stepBacktest(
  state: BacktestState,
  instrument: Instrument,
  bar: Bar,
  signals: readonly Signal[] = [],
): BacktestState {
  if (state.lastBar !== undefined && bar.time <= state.lastBar.time) {
    throw new BacktestError(`Bar at ${bar.time} is not after the last bar at ${state.lastBar.time}`);
  }
  for (const signal of signals) {
    if (signal.time !== bar.time) throw new BacktestError(`Signal at ${signal.time} is not on the bar at ${bar.time}`);
  }
  const { config } = state;
  const commissionRate = (config.commissionPercent ?? 0) / 100;
  const p = (value: number) => Number(formatScaled(value, instrument.priceScale));
  const prices: Prices = { time: bar.time, open: p(bar.open), high: p(bar.high), low: p(bar.low), close: p(bar.close) };

  let trades = state.trades;
  let realised = state.realised;
  let position: Position | undefined = state.position === undefined ? undefined : { ...state.position };
  let pending = state.pending;

  const close = (at: BarTime, fill: number, reason: ExitReason) => {
    if (position === undefined) return;
    const { side, quantity, entryPrice, entryCommission } = position;
    const exitCommission = fill * quantity * commissionRate;
    const gross = (side === 'long' ? fill - entryPrice : entryPrice - fill) * quantity;
    const profit = gross - entryCommission - exitCommission;
    realised += profit;
    trades = [
      ...trades,
      {
        side,
        quantity,
        entryTime: position.entryTime,
        entryPrice,
        exitTime: at,
        exitPrice: fill,
        exitReason: reason,
        commission: round(entryCommission + exitCommission, MONEY_DECIMALS),
        profit: round(profit, MONEY_DECIMALS),
        profitPercent: round((profit / (entryPrice * quantity)) * 100, 2),
      },
    ];
    position = undefined;
  };

  // 1. Orders signalled at the previous close fill at this open.
  if (pending !== undefined) {
    const { signal, quantity } = pending;
    pending = undefined;
    if (signal.kind === 'exit') {
      close(bar.time, prices.open, 'signal');
    } else if (signal.kind === 'enter' && position?.side !== signal.side) {
      close(bar.time, prices.open, 'reverse');
      position = {
        side: signal.side,
        quantity,
        entryTime: bar.time,
        entryPrice: prices.open,
        entryCommission: prices.open * quantity * commissionRate,
        stop: signal.stop,
        target: signal.target,
      };
    }
  }

  // 2. Stops and targets inside the bar, the fill bar included.
  if (position !== undefined) {
    const hit = intrabarExit(position, prices);
    if (hit) close(bar.time, hit.price, hit.reason);
  }

  // 3. Signals at this close: orders for the next open, or new protective levels.
  for (const signal of signals) {
    if (signal.kind === 'protect') {
      if (position !== undefined) {
        if (signal.stop !== undefined) position.stop = signal.stop ?? undefined;
        if (signal.target !== undefined) position.target = signal.target ?? undefined;
      }
      continue;
    }
    // Like Pine's strategy.close, an exit does nothing while flat, so it never
    // cancels an entry signalled at the same close.
    if (signal.kind === 'exit' && position === undefined) continue;
    const equity = config.initialCapital + realised + (position === undefined ? 0 : openProfitAt(position, prices.close));
    const quantity = config.sizing.kind === 'fixed' ? config.sizing.quantity : (equity * config.sizing.percent) / 100 / prices.close;
    pending = { signal, quantity };
  }

  return { config, trades, realised, position, pending, lastBar: bar };
}

/** Trades, the open position and totals, as of the last bar taken. */
export function summarise(state: BacktestState, instrument: Instrument): BacktestResult {
  const { position, lastBar } = state;
  let open: OpenPosition | undefined;
  if (position !== undefined && lastBar !== undefined) {
    const lastClose = Number(formatScaled(lastBar.close, instrument.priceScale));
    open = {
      side: position.side,
      quantity: position.quantity,
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      stop: position.stop,
      target: position.target,
      openProfit: round(openProfitAt(position, lastClose), MONEY_DECIMALS),
    };
  }
  return { trades: state.trades, open, pending: state.pending?.signal, totals: totalsOf(state.trades, state.config.initialCapital) };
}

/**
 * Run a backtest over a whole series at once. Bars must be in time order;
 * every signal must fall on a bar time, in time order. The same as calling
 * `stepBacktest` bar by bar.
 */
export function backtest(
  instrument: Instrument,
  bars: readonly Bar[],
  signals: readonly Signal[],
  config: BacktestConfig = TRADINGVIEW_DEFAULTS,
): BacktestResult {
  let state = startBacktest(config);
  const barTimes = new Set(bars.map((bar) => bar.time as number));
  const signalsAt = new Map<number, Signal[]>();
  let previous = -Infinity;
  for (const signal of signals) {
    if (!barTimes.has(signal.time)) throw new BacktestError(`Signal at ${signal.time} is not on a bar`);
    if (signal.time < previous) throw new BacktestError(`Signals are not in time order at ${signal.time}`);
    previous = signal.time;
    const list = signalsAt.get(signal.time) ?? [];
    list.push(signal);
    signalsAt.set(signal.time, list);
  }
  for (const bar of bars) state = stepBacktest(state, instrument, bar, signalsAt.get(bar.time));
  return summarise(state, instrument);
}

function totalsOf(trades: readonly Trade[], initialCapital: number): BacktestTotals {
  // Summed from the unrounded profits would differ from the Strategy Tester,
  // which shows each trade to the cent; trades are rounded, then summed.
  let grossProfit = 0;
  let grossLoss = 0;
  let commission = 0;
  let winning = 0;
  let losing = 0;
  for (const trade of trades) {
    commission += trade.commission;
    if (trade.profit > 0) {
      winning += 1;
      grossProfit += trade.profit;
    } else if (trade.profit < 0) {
      losing += 1;
      grossLoss -= trade.profit;
    }
  }
  const netProfit = grossProfit - grossLoss;
  const closed = trades.length;
  return {
    closedTrades: closed,
    winningTrades: winning,
    losingTrades: losing,
    winRate: closed === 0 ? 0 : round((winning / closed) * 100, 2),
    grossProfit: round(grossProfit, MONEY_DECIMALS),
    grossLoss: round(grossLoss, MONEY_DECIMALS),
    netProfit: round(netProfit, MONEY_DECIMALS),
    roi: round((netProfit / initialCapital) * 100, 2),
    profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss, 3),
    commission: round(commission, MONEY_DECIMALS),
    averageTrade: closed === 0 ? 0 : round(netProfit / closed, MONEY_DECIMALS),
  };
}
