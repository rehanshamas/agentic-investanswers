// Indicator settings (M3-02). No rules here: the dialog and the check are the
// indicators context's (settingsDialog, checkSettings); the shapes clients get
// are @aia/client-contract's (indicator-settings.ts).
//
//   GET  /indicators                  200 { indicators: [{ id, name, dialog }] }
//   POST /indicators/:id/settings     { settings }  200 SettingsAccepted · 400 invalid_settings · 404
//
// Every request carries a principal (CLAUDE.md rule 4) and counts as one read.
// The placeholder plans (decision record T-02) say nothing about indicators,
// so any signed-in principal, human or agent, may use them (decision record
// T-08). The run route (M3-05) checks settings with acceptSettings too, so
// there is one server-side check.

import type { PrincipalResolverPort } from '@aia/access';
import type { IndicatorSettingsDialog, IndicatorsResponse, InvalidSettingsBody, SettingsAccepted } from '@aia/client-contract';
import type { IndicatorRegistry } from '@aia/indicators';
import { checkSettings, settingsDialog } from '@aia/indicators';
import type { FastifyInstance } from 'fastify';

import type { Limits } from './rate-limit.js';
import { refusedForRate } from './rate-limit.js';

const error = (code: string, message: string) => ({ error: { code, message } });

const bodyLimit = 16_384;

export type IndicatorCatalog = Pick<IndicatorRegistry, 'get' | 'list'>;

export type SettingsOutcome =
  | { readonly ok: true; readonly value: SettingsAccepted }
  | { readonly ok: false; readonly status: 400; readonly body: InvalidSettingsBody }
  | { readonly ok: false; readonly status: 404; readonly body: ReturnType<typeof error> };

/** GET /indicators: each indicator with its dialog at defaults. */
export function listIndicators(catalog: IndicatorCatalog): IndicatorsResponse {
  return {
    indicators: catalog.list().map((definition) => {
      const dialog: IndicatorSettingsDialog = settingsDialog(definition);
      return { id: definition.id, name: definition.name, dialog };
    }),
  };
}

/** Untrusted settings for one indicator, checked against its declared inputs. */
export function acceptSettings(catalog: IndicatorCatalog, indicatorId: string, settings: unknown): SettingsOutcome {
  const definition = catalog.get(indicatorId);
  if (definition === undefined) return { ok: false, status: 404, body: error('not_found', `no indicator "${indicatorId}"`) };
  const checked = checkSettings(definition.inputs, settings);
  if (!checked.ok) {
    const count = checked.errors.length;
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          code: 'invalid_settings',
          message: count === 1 ? 'one setting is not allowed' : `${count} settings are not allowed`,
          fields: checked.errors,
        },
      },
    };
  }
  const dialog: IndicatorSettingsDialog = settingsDialog(definition, checked.settings);
  return { ok: true, value: { indicatorId: definition.id, settings: checked.settings, dialog } };
}

export function mountIndicatorRoutes(app: FastifyInstance, catalog: IndicatorCatalog, principals: PrincipalResolverPort, limits?: Limits): void {
  app.get('/indicators', async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to list indicators'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    return listIndicators(catalog);
  });

  app.post<{ Params: { id: string } }>('/indicators/:id/settings', { bodyLimit }, async (request, reply) => {
    const principal = await principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to change indicator settings'));
    if (limits !== undefined && (await refusedForRate(reply, await limits.checkReads(principal)))) return reply;
    const body = request.body as Record<string, unknown> | null | undefined;
    // A body with no "settings" means all defaults; checkSettings refuses anything that is not an object.
    const settings = body === null || body === undefined ? {} : (body['settings'] ?? {});
    const outcome = acceptSettings(catalog, request.params.id, settings);
    return outcome.ok ? outcome.value : reply.code(outcome.status).send(outcome.body);
  });
}
