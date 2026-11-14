// M3-02 done-check (server side): the settings dialog comes from the declared
// inputs, and settings outside them are refused with a 400 naming each field,
// through the real Fastify server, access rules and checkSettings.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { accessFromEnv } from '@aia/access';
import type { IndicatorsResponse, InvalidSettingsBody, SettingFieldErrorCode, SettingsAccepted } from '@aia/client-contract';
import { BTCUSD, MemoryDataLayer } from '@aia/data';
import { IndicatorRegistry } from '@aia/indicators';
import { HistoryQuery } from '@aia/serving';
import { barTime } from '@aia/shared-kernel';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from './server.js';
import { settingsDemo } from './settings-demo-indicator.js';

const T0 = 1_762_800_000;
const PASSWORD = 'correct horse battery';

const PLANS = join(mkdtempSync(join(tmpdir(), 'aia-indicators-')), 'plans.json');
writeFileSync(
  PLANS,
  JSON.stringify({
    upgradeUrl: 'https://example.com/upgrade',
    defaultPlan: 'free',
    plans: [{ id: 'free', name: 'Free', instruments: ['BTCUSD'], timeframes: ['1h'] }],
    assignments: {},
  }),
);

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<FastifyInstance> {
  const data = new MemoryDataLayer({ instruments: [BTCUSD], earliest: barTime(T0) });
  app = await buildServer({
    history: new HistoryQuery({ data }),
    access: accessFromEnv({ AIA_PLANS: PLANS }),
    indicators: new IndicatorRegistry([settingsDemo]),
    now: () => barTime(T0),
  });
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function signedIn(a: FastifyInstance): Promise<string> {
  const res = await a.inject({ method: 'POST', url: '/auth/sign-up', payload: { email: 'user@example.com', password: PASSWORD } });
  return (res.json() as { token: string }).token;
}

const DEFAULTS = { length: 20, offset: 0, showSignals: true, style: 'line', source: 'close' };

describe('GET /indicators', () => {
  it('lists each indicator with its dialog, built from the declared inputs at their defaults', async () => {
    const a = await start();
    const res = await a.inject({ method: 'GET', url: '/indicators', headers: auth(await signedIn(a)) });

    expect(res.statusCode).toBe(200);
    const { indicators } = res.json() as IndicatorsResponse;
    expect(indicators.map((i) => [i.id, i.name])).toEqual([['settingsDemo', 'Settings demo (tests only)']]);
    const dialog = indicators[0]?.dialog;
    expect(dialog?.title).toBe('Settings demo (tests only) settings');
    expect(dialog?.fields.map((f) => [f.key, f.control, f.value])).toEqual([
      ['length', 'number', 20],
      ['offset', 'number', 0],
      ['showSignals', 'switch', true],
      ['style', 'select', 'line'],
      ['source', 'select', 'close'],
    ]);
    expect(dialog?.fields[0]).toMatchObject({ min: 1, max: 500, step: 1, whole: true, help: 'Bars in the window' });
    expect(dialog?.fields[1]).toMatchObject({ min: 0, max: 10, step: 0.5, whole: false });
  });

  it('refuses a caller who is not signed in', async () => {
    const a = await start();
    expect((await a.inject({ method: 'GET', url: '/indicators' })).statusCode).toBe(401);
  });

  it('is not mounted when the server has no indicators', async () => {
    const data = new MemoryDataLayer({ instruments: [BTCUSD], earliest: barTime(T0) });
    app = await buildServer({ history: new HistoryQuery({ data }), access: accessFromEnv({ AIA_DEV_AUTH: '1' }), now: () => barTime(T0) });
    expect((await app.inject({ method: 'GET', url: '/indicators' })).statusCode).toBe(404);
  });
});

describe('POST /indicators/:id/settings', () => {
  const post = async (a: FastifyInstance, token: string, payload: unknown, id = 'settingsDemo') =>
    a.inject({ method: 'POST', url: `/indicators/${id}/settings`, headers: auth(token), payload: payload as Record<string, unknown> });

  it('accepts settings inside the limits, fills defaults and refills the dialog', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { settings: { length: 50, offset: 2.5 } });

    expect(res.statusCode).toBe(200);
    const accepted = res.json() as SettingsAccepted;
    expect(accepted.indicatorId).toBe('settingsDemo');
    expect(accepted.settings).toEqual({ ...DEFAULTS, length: 50, offset: 2.5 });
    expect(accepted.dialog.fields.map((f) => f.value)).toEqual([50, 2.5, true, 'line', 'close']);
  });

  it('takes a body without settings as all defaults', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), {});
    expect(res.statusCode).toBe(200);
    expect((res.json() as SettingsAccepted).settings).toEqual(DEFAULTS);
  });

  it.each<[string, Record<string, unknown>, string, SettingFieldErrorCode]>([
    ['above the maximum', { length: 501 }, 'length', 'out_of_range'],
    ['below the minimum', { length: 0 }, 'length', 'out_of_range'],
    ['a fraction for a whole number', { length: 20.5 }, 'length', 'not_whole'],
    ['off the step grid', { offset: 0.3 }, 'offset', 'off_step'],
    ['the wrong type', { showSignals: 'yes' }, 'showSignals', 'wrong_type'],
    ['not one of the options', { style: 'dots' }, 'style', 'not_an_option'],
    ['an unknown price source', { source: 'vwap' }, 'source', 'not_an_option'],
    ['an undeclared setting', { secret: 1 }, 'secret', 'unknown_setting'],
  ])('refuses a value %s with a 400 naming the field', async (_, settings, key, code) => {
    const a = await start();
    const res = await post(a, await signedIn(a), { settings });

    expect(res.statusCode).toBe(400);
    const body = res.json() as InvalidSettingsBody;
    expect(body.error.code).toBe('invalid_settings');
    expect(body.error.fields).toEqual([expect.objectContaining({ key, code, message: expect.any(String) as string })]);
  });

  it('lists every wrong field at once', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { settings: { length: 9999, style: 'dots' } });
    expect(res.statusCode).toBe(400);
    const body = res.json() as InvalidSettingsBody;
    expect(body.error.message).toBe('2 settings are not allowed');
    expect(body.error.fields.map((f) => f.key).sort()).toEqual(['length', 'style']);
  });

  it('refuses settings that are not an object', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { settings: [1, 2] });
    expect(res.statusCode).toBe(400);
    expect((res.json() as InvalidSettingsBody).error.fields).toEqual([expect.objectContaining({ key: '', code: 'not_an_object' })]);
  });

  it('answers 404 for an unknown indicator', async () => {
    const a = await start();
    const res = await post(a, await signedIn(a), { settings: {} }, 'nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'no indicator "nope"' } });
  });

  it('refuses a caller who is not signed in', async () => {
    const a = await start();
    const res = await a.inject({ method: 'POST', url: '/indicators/settingsDemo/settings', payload: { settings: {} } });
    expect(res.statusCode).toBe(401);
  });

  it('gives an agent the same check as a human (CLAUDE.md rule 4)', async () => {
    const a = await start();
    const session = await signedIn(a);
    const created = await a.inject({ method: 'POST', url: '/auth/agent-keys', headers: auth(session), payload: { name: 'research agent' } });
    const { key } = created.json() as { key: string };

    const refused = await post(a, key, { settings: { length: 501 } });
    expect(refused.statusCode).toBe(400);
    expect((refused.json() as InvalidSettingsBody).error.fields[0]?.key).toBe('length');
    const accepted = await post(a, key, { settings: { length: 30 } });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as SettingsAccepted).settings['length']).toBe(30);
  });
});
