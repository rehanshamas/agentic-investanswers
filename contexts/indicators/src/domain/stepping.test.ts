import type { Bar } from '@aia/shared-kernel';
import { price } from '@aia/shared-kernel';
import { describe, expect, it } from 'vitest';
import { btc, makeBars } from '../test-support/bars.js';
import { fakeChannel } from '../test-support/fake-channel.js';
import type { IndicatorDefinition } from './indicator-definition.js';
import { defaultSettings } from './inputs.js';
import { SteppingError, commit, indicatorBar, preview, runAll, startRun } from './stepping.js';

const settings = { ...defaultSettings(fakeChannel.inputs), length: 5, offset: 0.5 };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The fake, with every state it receives frozen, so any mutation throws. */
const frozenChannel: IndicatorDefinition<unknown> = {
  ...(fakeChannel as IndicatorDefinition<unknown>),
  init: (s) => deepFreeze(fakeChannel.init(s)),
  step: (state, bar, s) => {
    const result = fakeChannel.step(state as never, bar, s);
    return { ...result, state: deepFreeze(result.state) };
  },
};

describe('indicatorBar', () => {
  it('hands the indicator decimal prices at the instrument precision', () => {
    const [bar] = makeBars(1) as [Bar];
    const seen = indicatorBar(btc, bar);
    expect(seen.close).toBe(bar.close / 100);
    expect(seen.volume).toBe(bar.volume / 1e8);
  });
});

describe('one bar at a time', () => {
  const bars = makeBars(300);

  it('extending by one bar equals recomputing from the start', () => {
    const full = runAll(fakeChannel, settings, btc, bars).points;
    let run = runAll(fakeChannel, settings, btc, bars.slice(0, 200)).run;
    const extended = full.slice(0, 200);
    for (const bar of bars.slice(200)) {
      const next = commit(run, bar);
      run = next.run;
      extended.push(next.point);
    }
    expect(extended).toEqual(full);
  });

  it('draws every declared output kind somewhere in the series, and nothing else', () => {
    const { points } = runAll(fakeChannel, settings, btc, bars);
    for (const point of points) expect(Object.keys(point.values).sort()).toEqual(['anchor', 'basis', 'breakout', 'channel']);
    expect(points.some((p) => p.values.breakout !== null)).toBe(true);
    expect(points.slice(0, 4).every((p) => p.values.channel === null)).toBe(true);
    expect(points[4]?.values.channel).not.toBeNull();
  });

  it('a forming bar previewed on every trade leaves the run unchanged', () => {
    const { run } = runAll(frozenChannel, settings, btc, bars.slice(0, 100));
    const closed = bars[100] as Bar;
    // Trades move the forming bar's close up and down before it closes.
    for (const delta of [-500, 300, -50, 900, 0]) {
      const forming = { ...closed, close: price(closed.close + delta), high: price(Math.max(closed.high, closed.close + delta)), low: price(Math.min(closed.low, closed.close + delta)) };
      preview(run, forming);
    }
    const afterPreviews = commit(run, closed);
    const fresh = runAll(frozenChannel, settings, btc, bars.slice(0, 101));
    expect(afterPreviews.point).toEqual(fresh.points[100]);
    expect(afterPreviews.run.state).toEqual(fresh.run.state);
  });

  it('a preview of the closed bar equals committing it', () => {
    const { run } = runAll(fakeChannel, settings, btc, bars.slice(0, 50));
    expect(preview(run, bars[50] as Bar)).toEqual(commit(run, bars[50] as Bar).point);
  });

  it('never changes a state it was given (frozen states do not throw)', () => {
    expect(() => runAll(frozenChannel, settings, btc, bars)).not.toThrow();
  });

  it('refuses a bar that is not after the last committed one', () => {
    const { run } = runAll(fakeChannel, settings, btc, bars.slice(0, 10));
    expect(() => commit(run, bars[9] as Bar)).toThrow(SteppingError);
    expect(() => preview(run, bars[3] as Bar)).toThrow(SteppingError);
  });

  it('settings change the drawn output', () => {
    const a = runAll(fakeChannel, settings, btc, bars).points;
    const b = runAll(fakeChannel, { ...settings, length: 20 }, btc, bars).points;
    expect(a).not.toEqual(b);
  });

  it('starts empty', () => {
    const run = startRun(fakeChannel, settings, btc);
    expect(run.lastTime).toBeUndefined();
    expect(run.state).toEqual({ window: [], anchor: null, previousUpper: null });
  });
});
