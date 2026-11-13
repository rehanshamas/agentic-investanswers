import { describe, expect, it } from 'vitest';
import { fakeChannel } from '../test-support/fake-channel.js';
import { defaultSettings } from './inputs.js';
import { checkSettings, settingsKey } from './settings.js';

const inputs = fakeChannel.inputs;

function errorsOf(given: unknown) {
  const result = checkSettings(inputs, given);
  if (result.ok) throw new Error('expected the settings to be refused');
  return result.errors.map((e) => [e.key, e.code]);
}

describe('checkSettings', () => {
  it('fills every missing setting with its default', () => {
    expect(checkSettings(inputs, {})).toEqual({ ok: true, settings: defaultSettings(inputs) });
    expect(checkSettings(inputs, undefined)).toEqual({ ok: true, settings: defaultSettings(inputs) });
  });

  it('accepts values within their limits, at the edges too', () => {
    const result = checkSettings(inputs, { length: 500, offset: 0, showSignals: false, basis: 'source', source: 'hlc3' });
    expect(result).toEqual({
      ok: true,
      settings: { length: 500, offset: 0, showSignals: false, basis: 'source', source: 'hlc3' },
    });
  });

  it.each([
    ['above the maximum', { length: 501 }, [['length', 'out_of_range']]],
    ['below the minimum', { length: 0 }, [['length', 'out_of_range']]],
    ['a negative decimal', { offset: -0.5 }, [['offset', 'out_of_range']]],
    ['a fraction for a whole number', { length: 2.5 }, [['length', 'not_whole']]],
    ['a number sent as text', { length: '14' }, [['length', 'wrong_type']]],
    ['NaN', { offset: Number.NaN }, [['offset', 'wrong_type']]],
    ['infinity', { offset: Number.POSITIVE_INFINITY }, [['offset', 'wrong_type']]],
    ['text for a switch', { showSignals: 'yes' }, [['showSignals', 'wrong_type']]],
    ['an option not on the list', { basis: 'average' }, [['basis', 'not_an_option']]],
    ['an unknown price source', { source: 'vwap' }, [['source', 'not_an_option']]],
    ['an undeclared setting', { secret: 1 }, [['secret', 'unknown_setting']]],
  ])('refuses %s', (_, given, expected) => {
    expect(errorsOf(given)).toEqual(expected);
  });

  it('reports every problem at once, with words fit for the user', () => {
    const result = checkSettings(inputs, { length: 9999, offset: 'x', basis: 'nope' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.key)).toEqual(['length', 'offset', 'basis']);
    expect(result.errors[0]?.message).toBe('Length must be between 1 and 500');
  });

  it.each([[[1, 2]], ['length=3'], [7]])('refuses settings that are not an object: %j', (given) => {
    expect(errorsOf(given)).toEqual([['', 'not_an_object']]);
  });

  it('does not treat inherited properties as settings', () => {
    const given = Object.create({ length: 9999 }) as object;
    expect(checkSettings(inputs, given)).toEqual({ ok: true, settings: defaultSettings(inputs) });
  });
});

describe('settingsKey', () => {
  it('is the same for the same settings, whatever order or omissions they came with', () => {
    const a = checkSettings(inputs, { source: 'close', length: 3 });
    const b = checkSettings(inputs, { length: 3 });
    if (!a.ok || !b.ok) throw new Error('expected valid settings');
    expect(settingsKey(inputs, a.settings)).toBe(settingsKey(inputs, b.settings));
  });

  it('differs when a value differs', () => {
    const base = defaultSettings(inputs);
    expect(settingsKey(inputs, base)).not.toBe(settingsKey(inputs, { ...base, length: 4 }));
  });
});
