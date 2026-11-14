// M3-02 done-check (browser side): an indicator's settings dialog is drawn
// from the description the server sends, and a value outside its limits is
// refused by the server, with the message under the field. Through the real
// browser, the built chart and the platform's e2e server, which registers a
// test-only indicator with one input of each kind (settings-demo-indicator.ts).

import { expect, test } from '@playwright/test';

test('the settings dialog renders from the schema and the server refuses out-of-range values', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('status')).toHaveAttribute('data-series', 'ready');

  await page.getByTestId('indicators').selectOption('settingsDemo');
  const dialog = page.getByTestId('settings-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Settings demo (tests only) settings');

  // One control per declared input, with its limits and default.
  const length = dialog.getByTestId('setting-length');
  await expect(length).toHaveAttribute('type', 'number');
  await expect(length).toHaveAttribute('min', '1');
  await expect(length).toHaveAttribute('max', '500');
  await expect(length).toHaveValue('20');
  await expect(dialog.getByText('Bars in the window · 1 to 500')).toBeVisible();
  const offset = dialog.getByTestId('setting-offset');
  await expect(offset).toHaveAttribute('step', '0.5');
  await expect(offset).toHaveValue('0');
  await expect(dialog.getByTestId('setting-showSignals')).toBeChecked();
  await expect(dialog.getByTestId('setting-style')).toHaveValue('line');
  await expect(dialog.getByTestId('setting-source')).toHaveValue('close');
  await expect(dialog.getByTestId('setting-source').locator('option')).toHaveCount(7);

  // Out of range: the server refuses it and says why, under the field.
  await length.fill('501');
  await dialog.getByTestId('settings-apply').click();
  await expect(dialog.getByTestId('setting-length-error')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('applied-settings')).toHaveText('{}');

  // In range: accepted, the dialog closes, and the checked settings are kept.
  await length.fill('50');
  await dialog.getByTestId('setting-style').selectOption('steps');
  await dialog.getByTestId('settings-apply').click();
  await expect(dialog).toBeHidden();
  const applied = JSON.parse((await page.getByTestId('applied-settings').textContent()) ?? '{}') as Record<string, unknown>;
  expect(applied).toEqual({ settingsDemo: { length: 50, offset: 0, showSignals: true, style: 'steps', source: 'close' } });

  // Reopened, the dialog shows the accepted settings; Reset goes back to the defaults.
  await page.getByTestId('indicators').selectOption('settingsDemo');
  await expect(length).toHaveValue('50');
  await dialog.getByRole('button', { name: 'Reset to defaults' }).click();
  await expect(length).toHaveValue('20');
  await expect(dialog.getByTestId('setting-style')).toHaveValue('line');
});
