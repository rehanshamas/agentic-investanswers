// The platform's HTTP server (M2-03): routes mapped onto the contexts' use
// cases. No business rules here: parameters, the cap and what is served are
// HistoryQuery's (@aia/market-data); who is asking and what they may see are
// the access context's.
//
//   GET /health
//   GET /bars?instrument=BTCUSD&tf=5m&limit=500&before=1762800000
//
// Errors are `{ error: { code, message } }`.

import compress from '@fastify/compress';
import type { Access } from '@aia/access';
import type { HistoryErrorCode, HistoryQuery } from '@aia/market-data';
import type { BarTime } from '@aia/shared-kernel';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

export interface ServerDeps {
  readonly history: Pick<HistoryQuery, 'parse' | 'run'>;
  readonly access: Pick<Access, 'principals' | 'policy'>;
  /** The current time, as a bar time. */
  readonly now: () => BarTime;
  readonly logger?: boolean;
}

const STATUS: Readonly<Record<HistoryErrorCode, number>> = {
  bad_parameter: 400,
  limit_too_large: 400,
  unknown_instrument: 404,
  timeframe_not_served: 409,
};

const error = (code: string, message: string) => ({ error: { code, message } });

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false });
  await app.register(compress, { global: true });

  app.get('/health', () => ({ ok: true }));

  app.get('/bars', async (request, reply) => {
    // Every request carries a principal (CLAUDE.md rule 4), checked first.
    const principal = await deps.access.principals.resolve({ authorization: request.headers.authorization });
    if (principal === undefined) return reply.code(401).send(error('unauthorized', 'sign in to read bars'));

    const parsed = deps.history.parse(request.query as Record<string, unknown>);
    if (!parsed.ok) return reply.code(STATUS[parsed.error.code]).send({ error: parsed.error });

    const { instrument, timeframe } = parsed.request;
    if (!(await deps.access.policy.canReadBars(principal, instrument.symbol, timeframe))) {
      return reply.code(403).send(error('forbidden', `your plan does not include ${instrument.symbol} ${timeframe}`));
    }
    return deps.history.run(parsed.request, deps.now());
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(error('not_found', `no route ${request.method} ${request.url.split('?')[0] ?? ''}`)),
  );
  app.setErrorHandler((failure, request, reply) => {
    request.log.error(failure);
    return reply.code(500).send(error('internal', 'something went wrong; try again'));
  });

  return app;
}
