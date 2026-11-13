// A fake indicator for tests only: not a real indicator and never shipped.
// Real indicator source lives in agentic-investanswers-indicators.
//
// It uses every input kind and draws every output kind:
// - band "channel": highest high and lowest low of the last `length` bars, widened by `offset`
// - line "basis": the middle of the channel, or the selected source price
// - marker "breakout": when the close breaks above the previous bar's channel
// - level "anchor": the close of the first bar

import type { IndicatorDefinition } from '../domain/indicator-definition.js';
import type { PriceSource } from '../domain/inputs.js';
import { priceFromSource } from '../domain/inputs.js';

interface ChannelState {
  readonly window: readonly { readonly high: number; readonly low: number }[];
  readonly anchor: number | null;
  readonly previousUpper: number | null;
}

export const fakeChannel: IndicatorDefinition<ChannelState> = {
  id: 'fakeChannel',
  version: '1',
  name: 'Fake channel (tests only)',
  inputs: [
    { kind: 'int', key: 'length', label: 'Length', default: 3, min: 1, max: 500 },
    { kind: 'float', key: 'offset', label: 'Offset', default: 0, min: 0, max: 1000, step: 0.5 },
    { kind: 'bool', key: 'showSignals', label: 'Show breakouts', default: true },
    { kind: 'choice', key: 'basis', label: 'Basis', options: ['middle', 'source'], default: 'middle' },
    { kind: 'source', key: 'source', label: 'Source', default: 'close' },
  ],
  outputs: [
    { kind: 'band', key: 'channel', label: 'Channel' },
    { kind: 'line', key: 'basis', label: 'Basis' },
    { kind: 'marker', key: 'breakout', label: 'Breakout' },
    { kind: 'level', key: 'anchor', label: 'Anchor' },
  ],
  init: () => ({ window: [], anchor: null, previousUpper: null }),
  step(state, bar, settings) {
    const length = settings.length as number;
    const offset = settings.offset as number;
    const window = [...state.window, { high: bar.high, low: bar.low }].slice(-length);
    const anchor = state.anchor ?? bar.close;
    const full = window.length === length;
    const upper = full ? Math.max(...window.map((b) => b.high)) + offset : null;
    const lower = full ? Math.min(...window.map((b) => b.low)) - offset : null;
    const basis =
      upper === null || lower === null
        ? null
        : settings.basis === 'middle'
          ? (upper + lower) / 2
          : priceFromSource(bar, settings.source as PriceSource);
    const breakout =
      settings.showSignals === true && state.previousUpper !== null && bar.close > state.previousUpper
        ? { side: 'below' as const, price: bar.low, text: 'Up' }
        : null;
    return {
      state: { window, anchor, previousUpper: upper },
      outputs: {
        channel: upper === null || lower === null ? null : { upper, lower },
        basis,
        breakout,
        anchor,
        internalScratch: 42, // not declared, so it must never be drawn
      },
    };
  },
};
