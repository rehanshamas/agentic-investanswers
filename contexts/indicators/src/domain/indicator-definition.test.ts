import { describe, expect, it } from 'vitest';
import { fakeChannel } from '../test-support/fake-channel.js';
import type { IndicatorDefinition } from './indicator-definition.js';
import { IndicatorDefinitionError, assertValidDefinition } from './indicator-definition.js';
import type { InputSpec } from './inputs.js';
import { defaultSettings, priceFromSource } from './inputs.js';

function withInputs(inputs: InputSpec[]): IndicatorDefinition<unknown> {
  return { ...(fakeChannel as IndicatorDefinition<unknown>), inputs };
}

describe('assertValidDefinition', () => {
  it('accepts the fake indicator, which uses every input and output kind', () => {
    expect(() => assertValidDefinition(fakeChannel as IndicatorDefinition<unknown>)).not.toThrow();
    expect(new Set(fakeChannel.inputs.map((i) => i.kind))).toEqual(new Set(['int', 'float', 'bool', 'choice', 'source']));
    expect(new Set(fakeChannel.outputs.map((o) => o.kind))).toEqual(new Set(['line', 'band', 'marker', 'level']));
  });

  it.each<[string, InputSpec[]]>([
    ['a default above its limit', [{ kind: 'int', key: 'n', label: 'N', default: 600, min: 1, max: 500 }]],
    ['min above max', [{ kind: 'float', key: 'x', label: 'X', default: 1, min: 5, max: 2, step: 0.1 }]],
    ['a fractional whole-number limit', [{ kind: 'int', key: 'n', label: 'N', default: 2, min: 1.5, max: 5 }]],
    ['a zero step', [{ kind: 'float', key: 'x', label: 'X', default: 1, min: 0, max: 2, step: 0 }]],
    ['a choice default not in the options', [{ kind: 'choice', key: 'c', label: 'C', options: ['a', 'b'], default: 'z' }]],
    ['duplicate options', [{ kind: 'choice', key: 'c', label: 'C', options: ['a', 'a'], default: 'a' }]],
    ['an unknown price source', [{ kind: 'source', key: 's', label: 'S', default: 'vwap' as 'close' }]],
    [
      'duplicate input keys',
      [
        { kind: 'bool', key: 'on', label: 'On', default: true },
        { kind: 'bool', key: 'on', label: 'On again', default: false },
      ],
    ],
    ['a key that is not an identifier', [{ kind: 'bool', key: 'Show Signals', label: 'S', default: true }]],
  ])('rejects %s', (_, inputs) => {
    expect(() => assertValidDefinition(withInputs(inputs))).toThrow(IndicatorDefinitionError);
  });

  it('rejects a definition that draws nothing, or has no version', () => {
    const base = fakeChannel as IndicatorDefinition<unknown>;
    expect(() => assertValidDefinition({ ...base, outputs: [] })).toThrow(/no outputs/);
    expect(() => assertValidDefinition({ ...base, version: ' ' })).toThrow(/version/);
  });
});

describe('defaultSettings', () => {
  it('takes every declared default', () => {
    expect(defaultSettings(fakeChannel.inputs)).toEqual({
      length: 3,
      offset: 0,
      showSignals: true,
      basis: 'middle',
      source: 'close',
    });
  });
});

describe('priceFromSource', () => {
  const bar = { open: 10, high: 14, low: 8, close: 12 };
  it.each([
    ['open', 10],
    ['high', 14],
    ['low', 8],
    ['close', 12],
    ['hl2', 11],
    ['hlc3', 34 / 3],
    ['ohlc4', 11],
  ] as const)('%s', (source, expected) => {
    expect(priceFromSource(bar, source)).toBe(expected);
  });
});
