// Running an indicator over bars, one bar at a time.
// Pure.
//
// These are the rules every caller (the engine in M3-04, the parity harness in
// M3-03) uses, so incremental and full runs can never disagree:
//
// - `commit` advances by one closed bar and keeps the new state.
// - `preview` computes the forming bar from the last committed state and keeps
//   nothing, so it can run on every trade.
// - `runAll` is `commit` over a list of bars.
//
// Prices go to the indicator as decimals at the instrument's precision; what
// comes back is passed through `toDrawn`, so only declared outputs at display
// precision leave.

import type { Bar, BarTime, Instrument } from '@aia/shared-kernel';
import { formatScaled } from '@aia/shared-kernel';
import type { IndicatorBar, IndicatorDefinition } from './indicator-definition.js';
import type { Settings } from './inputs.js';
import type { DrawnPoint } from './outputs.js';
import { toDrawn } from './outputs.js';

export class SteppingError extends Error {}

/** An indicator part-way through a series: the state after the last committed bar. */
export interface IndicatorRun<S> {
  readonly definition: IndicatorDefinition<S>;
  readonly settings: Settings;
  readonly instrument: Instrument;
  readonly state: S;
  /** Open time of the last committed bar; undefined before the first. */
  readonly lastTime: BarTime | undefined;
}

/** A stored bar (scaled whole numbers) as an indicator sees it (decimals). */
export function indicatorBar(instrument: Instrument, bar: Bar): IndicatorBar {
  const p = (value: number) => Number(formatScaled(value, instrument.priceScale));
  return {
    time: bar.time,
    open: p(bar.open),
    high: p(bar.high),
    low: p(bar.low),
    close: p(bar.close),
    volume: Number(formatScaled(bar.volume, instrument.volumeScale)),
  };
}

export function startRun<S>(
  definition: IndicatorDefinition<S>,
  settings: Settings,
  instrument: Instrument,
): IndicatorRun<S> {
  return { definition, settings, instrument, state: definition.init(settings), lastTime: undefined };
}

function stepOnce<S>(run: IndicatorRun<S>, bar: Bar): { state: S; point: DrawnPoint } {
  if (run.lastTime !== undefined && bar.time <= run.lastTime) {
    throw new SteppingError(
      `${run.definition.id}: bar at ${bar.time} is not after the last committed bar at ${run.lastTime}`,
    );
  }
  const { state, outputs } = run.definition.step(run.state, indicatorBar(run.instrument, bar), run.settings);
  return { state, point: toDrawn(run.definition.outputs, bar.time, outputs, run.instrument.priceScale) };
}

/** Advance by one closed bar. The given run is left unchanged. */
export function commit<S>(run: IndicatorRun<S>, bar: Bar): { run: IndicatorRun<S>; point: DrawnPoint } {
  const { state, point } = stepOnce(run, bar);
  return { run: { ...run, state, lastTime: bar.time }, point };
}

/** Drawn output for the forming bar, computed from the last committed state; nothing is kept. */
export function preview<S>(run: IndicatorRun<S>, formingBar: Bar): DrawnPoint {
  return stepOnce(run, formingBar).point;
}

/** Commit every bar in order. */
export function runAll<S>(
  definition: IndicatorDefinition<S>,
  settings: Settings,
  instrument: Instrument,
  bars: readonly Bar[],
): { run: IndicatorRun<S>; points: DrawnPoint[] } {
  let run = startRun(definition, settings, instrument);
  const points: DrawnPoint[] = [];
  for (const bar of bars) {
    const next = commit(run, bar);
    run = next.run;
    points.push(next.point);
  }
  return { run, points };
}
