// An indicator's settings dialog (M3-02), drawn from the description the
// server sends (GET /indicators), never from the indicator itself: a new
// indicator needs no dialog code. Number boxes carry the declared limits and
// step as a convenience; the server checks every value on Apply and its
// messages appear under each field.

import type { DialogField, IndicatorSettingsDialog, SettingFieldError } from '@aia/client-contract';
import { useState } from 'react';
import type { FormEvent } from 'react';

import type { FormValues } from './settings-form.js';
import { defaultValues, fieldMessages, formValues, settingsBody } from './settings-form.js';

export interface SettingsDialogProps {
  readonly dialog: IndicatorSettingsDialog;
  /** Sends the settings; resolves with the server's refusals, or nothing once accepted. */
  readonly onApply: (settings: Record<string, unknown>) => Promise<readonly SettingFieldError[] | undefined>;
  readonly onClose: () => void;
}

function Control({ field, value, onChange }: { field: DialogField; value: string | boolean | undefined; onChange: (v: string | boolean) => void }) {
  const id = `setting-${field.key}`;
  switch (field.control) {
    case 'number':
      return (
        <input
          id={id}
          data-testid={id}
          type="number"
          min={field.min}
          max={field.max}
          step={field.step}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'switch':
      return <input id={id} data-testid={id} type="checkbox" role="switch" checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
    case 'select':
      return (
        <select id={id} data-testid={id} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
  }
}

function limitsText(field: DialogField): string | undefined {
  if (field.control !== 'number') return undefined;
  return `${field.min} to ${field.max}${field.step === 1 ? '' : `, in steps of ${field.step}`}`;
}

export function SettingsDialog({ dialog, onApply, onClose }: SettingsDialogProps) {
  const [values, setValues] = useState<FormValues>(() => formValues(dialog));
  const [errors, setErrors] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const apply = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      const refused = await onApply(settingsBody(dialog, values));
      if (refused === undefined) return;
      setErrors(fieldMessages(refused));
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'could not reach the server');
    } finally {
      setBusy(false);
    }
  };

  const titleId = `settings-title-${dialog.indicatorId}`;
  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="settings"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="settings-dialog"
        noValidate
        onSubmit={(e) => void apply(e)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2 id={titleId}>{dialog.title}</h2>
        {dialog.fields.map((field) => {
          const messages = errors[field.key] ?? [];
          const limits = limitsText(field);
          return (
            <div key={field.key} className="field" data-invalid={messages.length > 0 || undefined}>
              <label htmlFor={`setting-${field.key}`}>{field.label}</label>
              <Control field={field} value={values[field.key]} onChange={(v) => setValues({ ...values, [field.key]: v })} />
              {(field.help !== undefined || limits !== undefined) && (
                <small>{[field.help, limits].filter((t) => t !== undefined).join(' · ')}</small>
              )}
              {messages.map((m) => (
                <small key={m} className="error" role="alert" data-testid={`setting-${field.key}-error`}>
                  {m}
                </small>
              ))}
            </div>
          );
        })}
        {[...(errors[''] ?? []), ...(failure === undefined ? [] : [failure])].map((m) => (
          <p key={m} className="error" role="alert">
            {m}
          </p>
        ))}
        <div className="actions">
          <button type="button" onClick={() => setValues(defaultValues(dialog))}>
            Reset to defaults
          </button>
          <span />
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" data-testid="settings-apply" disabled={busy}>
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
