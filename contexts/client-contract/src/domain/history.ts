// The History API's responses (M2-03), as clients see them. The rules that
// produce them are @aia/serving's (HistoryQuery). Pure.
//
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000

import type { Timeframe } from '@aia/shared-kernel';

import type { DisplayBar } from './display-bar.js';

/** Most bars one request may ask for. */
export const HISTORY_MAX_LIMIT = 1_000;
/** Bars per page when the request does not say. */
export const HISTORY_DEFAULT_LIMIT = 500;

export type HistoryErrorCode =
  | 'bad_parameter'
  | 'limit_too_large'
  | 'unknown_instrument'
  | 'timeframe_not_served';

export interface HistoryError {
  readonly code: HistoryErrorCode;
  readonly message: string;
}

/** One bar in display units: prices and volume as decimal numbers, time in UTC seconds. */
export type HistoryBar = DisplayBar;

export interface HistoryResponse {
  readonly instrument: string;
  readonly timeframe: Timeframe;
  readonly bars: HistoryBar[];
  /** Pass as `before` for the next older page; `null` once history is exhausted. */
  readonly next: number | null;
}

/**
 * The body of every refused REST request: `{ error: { code, message } }`. A
 * plan refusal (403 `forbidden`) adds `upgradeUrl`.
 */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly upgradeUrl?: string;
  };
}
