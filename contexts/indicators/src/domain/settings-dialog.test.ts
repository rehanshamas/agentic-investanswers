import { describe, expect, it } from 'vitest';
import { fakeChannel } from '../test-support/fake-channel.js';
import type { IndicatorDefinition } from './indicator-definition.js';
import { checkSettings } from './settings.js';
import { settingsDialog } from './settings-dialog.js';

const channel = fakeChannel as IndicatorDefinition<unknown>;

describe('settingsDialog', () => {
  it('has one field per declared input, in declared order, filled with the defaults', () => {
    const dialog = settingsDialog(channel);
    expect(dialog.title).toBe('Fake channel (tests only) settings');
    expect(dialog.fields.map((f) => [f.key, f.control, f.value])).toEqual([
      ['length', 'number', 3],
      ['offset', 'number', 0],
      ['showSignals', 'switch', true],
      ['basis', 'select', 'middle'],
      ['source', 'select', 'close'],
    ]);
  });

  it('carries the range limits so the dialog can stop bad values before sending', () => {
    const [length, offset] = settingsDialog(channel).fields;
    expect(length).toMatchObject({ min: 1, max: 500, step: 1, whole: true });
    expect(offset).toMatchObject({ min: 0, max: 1000, step: 0.5, whole: false });
  });

  it('lists the options of choices and price sources', () => {
    const fields = settingsDialog(channel).fields;
    const basis = fields.find((f) => f.key === 'basis');
    const source = fields.find((f) => f.key === 'source');
    expect(basis?.control === 'select' && basis.options.map((o) => o.value)).toEqual(['middle', 'source']);
    expect(source?.control === 'select' && source.options.map((o) => o.value)).toEqual([
      'open',
      'high',
      'low',
      'close',
      'hl2',
      'hlc3',
      'ohlc4',
    ]);
  });

  it('shows the current settings and keeps the defaults for "reset"', () => {
    const checked = checkSettings(channel.inputs, { length: 20, showSignals: false });
    if (!checked.ok) throw new Error('expected valid settings');
    const fields = settingsDialog(channel, checked.settings).fields;
    expect(fields[0]).toMatchObject({ value: 20, default: 3 });
    expect(fields[2]).toMatchObject({ value: false, default: true });
  });

  it('is plain JSON that round-trips, with nothing about how the indicator computes', () => {
    const dialog = settingsDialog(channel);
    expect(JSON.parse(JSON.stringify(dialog))).toEqual(dialog);
    const text = JSON.stringify(dialog);
    for (const word of ['step(', 'init', 'window', 'previousUpper', 'outputs']) expect(text).not.toContain(word);
  });

  it('a value the dialog allows is accepted by the server check, and one past its limits is not', () => {
    for (const f of settingsDialog(channel).fields) {
      if (f.control !== 'number') continue;
      expect(checkSettings(channel.inputs, { [f.key]: f.max }).ok).toBe(true);
      expect(checkSettings(channel.inputs, { [f.key]: f.max + f.step }).ok).toBe(false);
      expect(checkSettings(channel.inputs, { [f.key]: f.min - f.step }).ok).toBe(false);
    }
  });
});
