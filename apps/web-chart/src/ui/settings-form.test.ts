import type { IndicatorSettingsDialog } from '@aia/client-contract';
import { describe, expect, it } from 'vitest';

import { defaultValues, fieldMessages, formValues, settingsBody } from './settings-form.js';

const dialog: IndicatorSettingsDialog = {
  indicatorId: 'demo',
  title: 'Demo settings',
  fields: [
    { key: 'length', label: 'Length', control: 'number', value: 50, default: 20, min: 1, max: 500, step: 1, whole: true },
    { key: 'offset', label: 'Offset', control: 'number', value: 2.5, default: 0, min: 0, max: 10, step: 0.5, whole: false },
    { key: 'showSignals', label: 'Show signals', control: 'switch', value: false, default: true },
    { key: 'style', label: 'Style', control: 'select', value: 'steps', default: 'line', options: [{ value: 'line', label: 'line' }, { value: 'steps', label: 'steps' }] },
  ],
};

describe('settings form', () => {
  it('fills the form from the dialog, number boxes as text', () => {
    expect(formValues(dialog)).toEqual({ length: '50', offset: '2.5', showSignals: false, style: 'steps' });
    expect(defaultValues(dialog)).toEqual({ length: '20', offset: '0', showSignals: true, style: 'line' });
  });

  it('sends number boxes as numbers and the rest as they are', () => {
    expect(settingsBody(dialog, { length: ' 30 ', offset: '1.5', showSignals: true, style: 'line' })).toEqual({
      length: 30,
      offset: 1.5,
      showSignals: true,
      style: 'line',
    });
  });

  it('sends text that is not a number as typed, for the server to refuse', () => {
    expect(settingsBody(dialog, formValues(dialog))['length']).toBe(50);
    expect(settingsBody(dialog, { ...formValues(dialog), length: 'abc' })['length']).toBe('abc');
    expect(settingsBody(dialog, { ...formValues(dialog), length: '' })['length']).toBe('');
  });

  it('does not check limits itself: out-of-range values still go to the server', () => {
    expect(settingsBody(dialog, { ...formValues(dialog), length: '9999' })['length']).toBe(9999);
  });

  it('groups the server refusals by field', () => {
    expect(
      fieldMessages([
        { key: 'length', code: 'out_of_range', message: 'Length must be between 1 and 500' },
        { key: '', code: 'not_an_object', message: 'Settings must be an object' },
        { key: 'length', code: 'not_whole', message: 'Length must be a whole number' },
      ]),
    ).toEqual({ length: ['Length must be between 1 and 500', 'Length must be a whole number'], '': ['Settings must be an object'] });
  });
});
