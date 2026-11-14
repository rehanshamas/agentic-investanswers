// The settings dialog's form, kept apart from React (M3-02): values as the
// form holds them, the settings body sent to the server, and the server's
// refusals as messages per field. The server checks every value
// (POST /indicators/:id/settings); nothing here decides what is allowed.

import type { IndicatorSettingsDialog, SettingFieldError } from '@aia/client-contract';

/** What the form holds per field: number boxes as typed text, switches as booleans, drop-downs as their value. */
export type FormValues = Readonly<Record<string, string | boolean>>;

function fieldValue(value: number | boolean | string): string | boolean {
  return typeof value === 'number' ? String(value) : value;
}

/** The form filled with the dialog's current values. */
export function formValues(dialog: IndicatorSettingsDialog): FormValues {
  return Object.fromEntries(dialog.fields.map((f) => [f.key, fieldValue(f.value)]));
}

/** The form filled with every field's default. */
export function defaultValues(dialog: IndicatorSettingsDialog): FormValues {
  return Object.fromEntries(dialog.fields.map((f) => [f.key, fieldValue(f.default)]));
}

/**
 * The settings to send. A number box's text goes as a number when it reads as
 * one; otherwise as typed, so the server names the field that is wrong.
 */
export function settingsBody(dialog: IndicatorSettingsDialog, values: FormValues): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of dialog.fields) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (field.control === 'number' && typeof value === 'string') {
      const text = value.trim();
      const number = text === '' ? Number.NaN : Number(text);
      body[field.key] = Number.isFinite(number) ? number : value;
    } else {
      body[field.key] = value;
    }
  }
  return body;
}

/** The server's refusals by field key; key "" holds those about the settings as a whole. */
export function fieldMessages(errors: readonly SettingFieldError[]): Readonly<Record<string, readonly string[]>> {
  const byKey: Record<string, string[]> = {};
  for (const { key, message } of errors) (byKey[key] ??= []).push(message);
  return byKey;
}
