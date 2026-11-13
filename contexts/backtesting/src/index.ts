// Public entry of the backtesting context. Other packages import only from here.

export type {
  BacktestConfig,
  BacktestState,
  BacktestResult,
  BacktestTotals,
  ExitReason,
  OpenPosition,
  Side,
  Signal,
  Sizing,
  Trade,
} from './domain/backtest.js';
export { BacktestError, TRADINGVIEW_DEFAULTS, backtest, startBacktest, stepBacktest, summarise } from './domain/backtest.js';
